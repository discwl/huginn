import { createHash, randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { nativeUntrackPlanSchema, nativeUntrackReceiptSchema, type UntrackJob, type UntrackPreview } from "../shared/untrack-contracts.ts";
import type { NativePort } from "./gortex-client.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { RepositoryConfig, sameRepositoryPath, type ConfigSnapshot } from "./repository-config.ts";

export interface UntrackPort extends Pick<NativePort, "assignments" | "info" | "version"> {
  checkouts(path: string): Promise<{ value: unknown; meta: unknown }>;
  untrack(path: string, confirm: boolean): Promise<{ value: unknown; meta: unknown }>;
  refreshContexts(): Promise<void>;
}
interface Snapshot { config: ConfigSnapshot; fingerprint: string; name: string; workspace: string; project: string }
interface Record { preview: UntrackPreview; snapshot: Snapshot; job?: string; backupPath: string | null }
const message = (error: unknown) => error instanceof Error ? error.message : "Native untracking failed.";
// Administration must never interpret a budget-limited plan as a complete list of effects.
export function requireComplete(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((/truncat|partial|lower_bound/i.test(key) && child === true) || (key === "complete" && child === false)) throw new Error("Gortex returned an incomplete administration response. No broader removal will be confirmed.");
    requireComplete(child);
  }
}
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class RepositoryUntrack {
  private native: UntrackPort;
  private config: RepositoryConfig;
  private admin: RepositoryAdminLock;
  private invalidate: () => void;
  private previews = new Map<string, Record>();
  private jobs = new Map<string, UntrackJob>();
  private running: Promise<void> | null = null;
  private closed = false;
  constructor(native: UntrackPort, config = new RepositoryConfig(), invalidate: () => void = () => {}, admin = new RepositoryAdminLock()) {
    this.native = native; this.config = config; this.invalidate = invalidate; this.admin = admin;
  }

  private async snapshot(path: string): Promise<Snapshot> {
    if (!isAbsolute(path)) throw new Error("Choose an absolute repository path on the selected host.");
    const canonical = await realpath(path);
    const [version, rows, config] = await Promise.all([this.native.version(), this.native.assignments(), this.config.load(canonical)]);
    if (!/^gortex v0\.64\.3(?:\+|$)/.test(version)) throw new Error("Untracking is verified for Gortex 0.64.3. This host needs an adapter compatibility update.");
    const matches = [];
    for (const row of rows) {
      try { if (sameRepositoryPath(await realpath(row.path), canonical)) matches.push(row); } catch { /* An unavailable path cannot authorize another target. */ }
    }
    if (matches.length !== 1) throw new Error("Choose one explicitly tracked repository. Automatic worktrees have no separate tracking entry to remove.");
    const info = await this.native.info(canonical);
    const members = [];
    for (const member of info.members) {
      try { if (sameRepositoryPath(await realpath(member.path), canonical)) members.push(member); } catch { /* Never substitute a different graph. */ }
    }
    if (members.length !== 1) throw new Error("The daemon did not resolve this repository uniquely. Refresh before untracking.");
    const name = members[0].name;
    if (name !== config.effective.name) throw new Error("Resolve the configured name and active graph mismatch before untracking this repository.");
    const catalog = await this.native.checkouts(canonical);
    requireComplete(catalog);
    z.object({ families: z.array(z.record(z.string(), z.unknown())).max(1000) }).parse(catalog.value);
    const identity = { name, workspace: info.workspace, project: info.project };
    const fingerprint = createHash("sha256").update(canonicalJSON([version, canonical, config.revision, matches, identity, catalog.value])).digest("hex");
    return { config, fingerprint, ...identity };
  }

  private remember(snapshot: Snapshot, native: UntrackPreview["native"] = null, backupPath: string | null = null): UntrackPreview {
    const preview: UntrackPreview = {
      id: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      path: snapshot.config.path, name: snapshot.name, workspace: snapshot.workspace, project: snapshot.project,
      configPath: snapshot.config.configPath, native,
      warnings: native ? [
        "This is Gortex’s native removal plan. Confirming removes the listed graph data and views. Source directories remain on disk.",
        "The plugin rechecks configuration and the checkout catalog before confirmation. Gortex does not accept a client-supplied plan version; coordinate any other administration on this host until this finishes.",
      ] : [
        "This removes the repository’s explicit tracking entry and asks the running Gortex daemon to release its dedicated index. A backup is saved before the native request.",
        "A dedicated worktree may return to automatic indexing through its family’s primary graph. Untracking is not a permanent exclusion of that worktree.",
        "If Gortex requires removal of a primary graph or checkout and dependent views, it will return an exact plan for a separate confirmation.",
        "Source files, Git worktrees and Paseo workspaces remain on disk. No daemon restart is needed.",
      ],
    };
    this.previews.set(preview.id, { preview, snapshot, backupPath });
    while (this.previews.size > 40) this.previews.delete(this.previews.keys().next().value!);
    return structuredClone(preview);
  }

  async preview(path: string): Promise<UntrackPreview> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before untracking.");
    const snapshot = await this.snapshot(path);
    if ([...this.jobs.values()].some(job => sameRepositoryPath(job.path, snapshot.config.path) && job.outcome === "uncertain")) throw new Error("An earlier untrack request has an unverified outcome. Check the native host state before retrying; this plugin will not replay it automatically.");
    return this.remember(snapshot);
  }

  apply(id: string): UntrackJob {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before untracking.");
    const record = this.previews.get(id);
    if (!record) throw new Error("Preview expired or the plugin reloaded. Refresh tracking state and review a new preview.");
    if (record.job) return this.job(record.job);
    if (Date.parse(record.preview.expiresAt) < Date.now()) throw new Error("Preview expired. Review a new preview.");
    if (record.preview.native?.blockers.length) throw new Error("Gortex reports blockers. Resolve them before untracking.");
    const release = this.admin.acquire();
    const job: UntrackJob = { id: randomUUID(), path: record.preview.path, stage: "validating", outcome: "running", preview: null, receipt: null, configRemoved: null, backupPath: record.backupPath, error: null };
    record.job = job.id; this.jobs.set(job.id, job);
    while (this.jobs.size > 40) this.jobs.delete(this.jobs.keys().next().value!);
    this.running = this.execute(record, job).finally(() => { this.running = null; release(); });
    return structuredClone(job);
  }

  job(id: string): UntrackJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("This untrack job is no longer retained. Refresh native tracking state before taking another action.");
    return structuredClone(job);
  }

  private async execute(record: Record, job: UntrackJob): Promise<void> {
    let attempted = false;
    try {
      const current = await this.snapshot(job.path);
      if (current.fingerprint !== record.snapshot.fingerprint) throw new Error("Configuration, repository identity or checkout state changed after preview. No untrack request was sent. Review a new preview.");
      if (this.closed) throw new Error("Plugin closed before untracking began. No request was sent.");
      if (!job.backupPath) {
        job.backupPath = join(dirname(current.config.configPath), `config.yaml.paseo-untrack-${randomUUID()}.bak`);
        const backup = await open(job.backupPath, "wx", 0o600);
        try { await backup.writeFile(current.config.text, "utf8"); await backup.sync(); } finally { await backup.close(); }
      }
      if ((await this.config.load(job.path)).revision !== current.config.revision) throw new Error("Configuration changed while preparing the backup. No untrack request was sent.");
      job.stage = "untracking"; attempted = true;
      // confirm:false is intentionally sent ONLY after the user approves untracking: it can evict or demote immediately.
      const response = await this.native.untrack(job.path, record.preview.native !== null);
      requireComplete(response);
      if ((response.value as { status?: unknown } | null)?.status === "preview") {
        const plan = nativeUntrackPlanSchema.parse(response.value);
        if (record.preview.native || plan.prefix !== current.name) throw new Error("Gortex returned an unexpected removal plan. Refresh tracking state before continuing.");
        const after = await this.snapshot(job.path);
        if (after.fingerprint !== current.fingerprint) throw new Error("Checkout state changed while Gortex prepared its plan. Refresh and review again.");
        job.preview = this.remember(after, plan, job.backupPath);
        job.outcome = "review"; job.configRemoved = false;
        return;
      }
      const receipt = nativeUntrackReceiptSchema.parse(response.value);
      const expected = record.preview.native?.plan;
      if (receipt.prefix !== current.name || (expected ? receipt.plan !== expected : !["evict", "demote"].includes(receipt.plan)) || (receipt.status === "demoted") !== (receipt.plan === "demote")) throw new Error("Gortex returned an unexpected untrack receipt. Verify the host state before continuing.");
      job.receipt = receipt;
      job.stage = "verifying";
      const rows = await this.native.assignments();
      job.configRemoved = !rows.some(row => sameRepositoryPath(row.path, job.path) || row.repo === current.name);
      if (!job.configRemoved) throw new Error("Gortex returned an untrack receipt, but the repository still appears in its configuration catalog. Reconcile native state before retrying.");
      job.outcome = receipt.status;
    } catch (error) {
      job.error = message(error); job.outcome = attempted ? "uncertain" : "failed";
      if (attempted) {
        const pause = "Repository writes are paused because an untrack outcome is unverified. Check the host’s native tracking state and wait for administration to finish before reloading this plugin to resume writes.";
        this.admin.stopWrites(pause);
        job.error += ` ${pause}`;
        try { job.configRemoved = !(await this.native.assignments()).some(row => sameRepositoryPath(row.path, job.path) || row.repo === record.snapshot.name); } catch { /* An unavailable catalog is not proof of removal. */ }
      }
    } finally {
      if (attempted && job.outcome !== "review") {
        await this.native.refreshContexts().catch(() => {});
        this.invalidate();
      }
      job.stage = "done";
    }
  }

  async close(): Promise<void> { this.closed = true; await this.running; this.previews.clear(); this.jobs.clear(); }
}
