import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import type { TrackJob, TrackPreview } from "../shared/track-contracts.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment } from "../shared/models.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { globalConfigPath, sameRepositoryPath } from "./repository-config.ts";
import { inspectProjectDirectory } from "./project-catalog.ts";
import { runProcess } from "./process-runner.ts";
import { requireNativeCompatibility } from "../shared/native-compatibility.ts";

export interface TrackPort extends Pick<NativePort, "assignments" | "info" | "version"> {
  /** Read-only probe of the native track interface; throws when it is unsupported. */
  trackSupport(path: string): Promise<void>;
  track(path: string): Promise<void>;
  refreshContexts(): Promise<void>;
}
type PreviewRecord = { preview: TrackPreview; fingerprint: string; job?: string };
const message = (error: unknown) => error instanceof Error ? error.message : "Native tracking failed.";
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
async function configDigest(path: string): Promise<string> {
  const file = await open(path, "r").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!file) return "absent";
  try {
    if (!(await file.stat()).isFile()) throw new Error("Expected a regular Gortex configuration file.");
    const buffer = Buffer.alloc(1024 * 1024 + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error("Gortex configuration exceeds the tracking preview size budget.");
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally { await file.close(); }
}

/** Explicit native tracking only. Listing and previewing a project never call track. */
export class RepositoryTrack {
  private native: TrackPort;
  private invalidate: () => void;
  private admin: RepositoryAdminLock;
  private configPath: string;
  private previews = new Map<string, PreviewRecord>();
  private jobs = new Map<string, TrackJob>();
  private pendingContexts = new Map<string, NativeAssignment>();
  private observations = new Map<string, Promise<TrackJob>>();
  private running: Promise<void> | null = null;
  private closed = false;
  constructor(native: TrackPort, invalidate: () => void = () => {}, admin = new RepositoryAdminLock(), configPath = globalConfigPath()) {
    this.native = native; this.invalidate = invalidate; this.admin = admin; this.configPath = configPath;
  }
  private async registered(path: string, rows?: NativeAssignment[]): Promise<NativeAssignment | null> {
    const matches: NativeAssignment[] = [];
    for (const row of rows ?? await this.native.assignments()) {
      if (sameRepositoryPath(row.path, path)) { matches.push(row); continue; }
      try { if (sameRepositoryPath(await realpath(row.path), path)) matches.push(row); } catch { /* Never substitute an inaccessible path. */ }
    }
    if (matches.length > 1) throw new Error("The native catalog contains ambiguous tracking entries for this directory.");
    return matches[0] ?? null;
  }
  private async snapshot(path: string) {
    const directory = await inspectProjectDirectory(path);
    if (directory.state !== "untracked") throw new Error(directory.error ?? "This folder cannot be indexed.");
    const root = directory.path, git = directory.git !== false;
    if (sameRepositoryPath(root, homedir()) || sameRepositoryPath(root, dirname(root))) throw new Error("Tracking a home directory or filesystem root is not offered.");
    if (git) {
      // Verify the Git repository itself again for administration, rather than trusting the listing cache.
      const gitRoot = (await runProcess("git", ["-C", root, "rev-parse", "--show-toplevel"], root, { timeoutMs: 5000, maxBytes: 65536 })).trimEnd();
      if (/[\r\n]/.test(gitRoot) || !sameRepositoryPath(await realpath(gitRoot), root)) throw new Error("The Git repository root changed. Refresh the project before indexing.");
    }
    const [version, rows, globalDigest, localDigest, identity] = await Promise.all([
      this.native.version(), this.native.assignments(), configDigest(this.configPath), configDigest(join(root, ".gortex.yaml")), stat(git ? join(root, ".git") : root),
    ]);
    requireNativeCompatibility(version);
    if (await this.registered(root, rows)) throw new Error("This repository is already tracked. Refresh the library to use its existing native index.");
    // A plain folder can contain or sit inside tracked repositories; indexing both would duplicate their files.
    for (const row of rows) {
      let tracked: string;
      try { tracked = await realpath(row.path); } catch { continue; }
      if (isInside(tracked, root)) throw new Error(`This folder contains ${row.repo}, which Gortex already tracks. Index the individual repositories instead.`);
      if (isInside(root, tracked)) throw new Error(`This folder is inside ${row.repo}, which Gortex already tracks.`);
    }
    const name = basename(root);
    if (rows.some(row => row.repo.toLowerCase() === name.toLowerCase())) throw new Error("Another repository already uses this native name. Choose a distinct name with native Gortex tracking before continuing.");
    const fingerprint = createHash("sha256").update(JSON.stringify([version, root, globalDigest, localDigest, identity.dev, identity.ino, identity.birthtimeMs, [...rows].sort((a, b) => a.path.localeCompare(b.path))])).digest("hex");
    return { path: root, name, fingerprint, git };
  }
  async preview(path: string): Promise<TrackPreview> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before indexing.");
    const snapshot = await this.snapshot(path);
    if ([...this.jobs.values()].some(job => sameRepositoryPath(job.path, snapshot.path) && job.outcome === "uncertain")) throw new Error("An earlier tracking outcome is unverified. Reconcile the host catalog before retrying.");
    const preview: TrackPreview = { id: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), path: snapshot.path, name: snapshot.name, git: snapshot.git, warnings: [
      snapshot.git ? "Adds this Git repository to Gortex’s native tracking configuration and requests indexing on the selected host."
        : "This folder has no Git repository. Gortex indexes it for search, source and relationships, but branch, worktree and change-history features are unavailable, and there is no .gitignore to skip generated folders. Add exclusions afterwards in Repository settings, or initialize Git first.",
      "Gortex uses the repository’s native workspace, project and exclusion defaults. You can change them in Repository settings after tracking.",
      "Source files and Paseo workspaces stay in place. Indexing continues in the background.",
    ] };
    this.previews.set(preview.id, { preview, fingerprint: snapshot.fingerprint });
    while (this.previews.size > 40) this.previews.delete(this.previews.keys().next().value!);
    return structuredClone(preview);
  }
  apply(id: string): TrackJob {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before indexing.");
    const record = this.previews.get(id);
    if (!record) throw new Error("Preview expired or the plugin reloaded. Review the current project before indexing.");
    // Approval expiry limits new writes, not recovery of an already accepted request.
    if (record.job) return this.job(record.job);
    if (Date.parse(record.preview.expiresAt) <= Date.now()) throw new Error("Preview expired or the plugin reloaded. Review the current project before indexing.");
    const release = this.admin.acquire();
    const job: TrackJob = { id: randomUUID(), path: record.preview.path, stage: "validating", outcome: "running", registered: null, repository: null, error: null };
    record.job = job.id; this.jobs.set(job.id, job);
    while (this.jobs.size > 40) {
      const oldest = this.jobs.keys().next().value!;
      this.jobs.delete(oldest); this.pendingContexts.delete(oldest);
    }
    this.running = this.execute(record, job).finally(() => { this.running = null; release(); });
    return structuredClone(job);
  }
  job(id: string): TrackJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("This tracking job is no longer retained. Refresh the native catalog before taking another action.");
    return structuredClone(job);
  }
  private async repository(path: string, row: NativeAssignment): Promise<TrackJob["repository"]> {
    const info = await this.native.info(path);
    const matches = [];
    for (const member of info.members) {
      try { if (sameRepositoryPath(await realpath(member.path), path)) matches.push(member); } catch { /* No substitute view. */ }
    }
    if (matches.length !== 1) return null;
    return { name: row.repo, path, declaredWorkspace: row.workspace, declaredProject: row.project, assignmentSource: row.source, workspaceId: info.workspace, projectId: info.project, graphName: matches[0].name, origin: "gortex", state: "resolved", error: null };
  }
  /** A read of one retained native context; never retries track or scans the catalog. */
  async observe(id: string): Promise<TrackJob> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before checking readiness.");
    const current = this.job(id), row = this.pendingContexts.get(id);
    if (current.stage !== "done" || current.outcome !== "indexing" || !row) return current;
    const pending = this.observations.get(id);
    if (pending) return structuredClone(await pending);
    const job = this.jobs.get(id)!;
    const observation = this.repository(job.path, row).then(repository => {
      if (!this.closed && this.jobs.get(id) === job) {
        if (repository) {
          job.repository = repository; job.outcome = "tracked"; job.error = null;
          this.pendingContexts.delete(id); this.invalidate();
        } else { job.error = "The native repository context is not available yet."; }
      }
      return structuredClone(job);
    }).catch(error => {
      if (!this.closed && this.jobs.get(id) === job) job.error = message(error);
      throw error;
    }).finally(() => { this.observations.delete(id); });
    this.observations.set(id, observation);
    return structuredClone(await observation);
  }
  private async execute(record: PreviewRecord, job: TrackJob): Promise<void> {
    let attempted = false;
    try {
      const snapshot = await this.snapshot(job.path);
      if (snapshot.fingerprint !== record.fingerprint) throw new Error("Repository identity or configuration changed after preview. No tracking request was sent; review a new preview.");
      if (this.closed) throw new Error("Plugin closed before tracking began. No request was sent.");
      await this.native.trackSupport(job.path);
      job.stage = "tracking"; attempted = true;
      await this.native.track(job.path);
      job.stage = "verifying";
      const row = await this.registered(job.path);
      job.registered = row !== null;
      if (!row) throw new Error("The native tracking request returned, but the repository is absent from the authoritative catalog.");
      await this.native.refreshContexts();
      this.pendingContexts.set(job.id, row);
      try {
        job.repository = await this.repository(job.path, row);
        if (!job.repository) throw new Error("The native repository context is not available yet.");
        job.outcome = "tracked"; this.pendingContexts.delete(job.id);
      } catch (error) { job.outcome = "indexing"; job.error = message(error); }
    } catch (error) {
      job.error = message(error); job.outcome = attempted ? "uncertain" : "failed";
      if (attempted) {
        let row: NativeAssignment | null | undefined;
        try { row = await this.registered(job.path); job.registered = row !== null; } catch { /* Unknown is not proof that a write failed. */ }
        const code = (error as { code?: unknown } | null)?.code;
        if (row) {
          // The authoritative catalog confirms the write; only graph readiness remains to observe.
          job.outcome = "indexing"; this.pendingContexts.set(job.id, row);
        } else if (row === null && (code === "process_failed" || code === "process_unavailable")) {
          // The command did not run or exited with a failure, and the catalog confirms nothing was registered.
          job.outcome = "failed";
        } else {
          this.admin.stopWrites("Repository writes are paused because a tracking outcome is unverified. Reconcile the native host catalog before reloading the plugin to resume writes.");
        }
      }
    } finally {
      if (attempted) this.invalidate();
      job.stage = "done";
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.running;
    await Promise.allSettled(this.observations.values());
    this.previews.clear(); this.jobs.clear(); this.pendingContexts.clear();
  }
}
