import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { MetadataJob, MetadataPreview, RepositoryFields, RepositoryMetadata as Metadata } from "../shared/metadata-contracts.ts";
import type { NativePort } from "./gortex-client.ts";
import { RepositoryConfig, sameRepositoryPath, type ConfigSnapshot } from "./repository-config.ts";
import { metadataRepairState } from "../shared/metadata-repair.ts";

export interface MetadataPort extends Pick<NativePort, "assignments" | "info" | "version"> {
  reloadConfiguration(): Promise<void>;
  rebuildIndex(path: string): Promise<void>;
  refreshContexts(): Promise<void>;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Native metadata operation failed.";
interface PreviewRecord { public: MetadataPreview; snapshot: ConfigSnapshot; text: string; job?: string }

export class RepositoryMetadata {
  private native: MetadataPort;
  private config: RepositoryConfig;
  private invalidate: () => void;
  private previews = new Map<string, PreviewRecord>();
  private jobs = new Map<string, MetadataJob>();
  private running: Promise<void> | null = null;
  private closed = false;
  constructor(native: MetadataPort, config = new RepositoryConfig(), invalidate: () => void = () => {}) {
    this.native = native; this.config = config; this.invalidate = invalidate;
  }

  private async snapshot(path: string): Promise<{ config: ConfigSnapshot; metadata: Metadata }> {
    if (!isAbsolute(path)) throw new Error("Choose an absolute repository path on the selected host.");
    const canonical = await realpath(path);
    const [version, rows] = await Promise.all([this.native.version(), this.native.assignments()]);
    if (!/^gortex v0\.64\.3(?:\+|$)/.test(version)) throw new Error("Repository metadata editing is verified for Gortex 0.64.3. This host requires an adapter compatibility update.");
    const matches = [];
    for (const row of rows) {
      try { if (sameRepositoryPath(await realpath(row.path), canonical)) matches.push(row); } catch { /* No authorization from an unavailable path. */ }
    }
    if (matches.length !== 1) throw new Error("This path is not an unambiguous member of the native tracking catalog. Refresh repositories.");
    const config = await this.config.load(canonical);
    let daemon: RepositoryFields | null = null;
    let error: string | null = null;
    try {
      const info = await this.native.info(canonical);
      const members = [];
      for (const member of info.members) {
        try { if (sameRepositoryPath(await realpath(member.path), canonical)) members.push(member); } catch { /* Do not substitute another member's identity. */ }
      }
      if (members.length !== 1) throw new Error("The daemon did not resolve this repository path uniquely.");
      daemon = { name: members[0].name, workspace: info.workspace, project: info.project };
    } catch (cause) { error = errorMessage(cause); }
    const state = daemon === null ? "unavailable" : equal(daemon, config.effective) ? "applied" : "pending";
    const warnings = [...config.warnings];
    if (daemon && daemon.name !== config.effective.name) warnings.push("The configured name differs from the active graph name. Gortex 0.64.3 preserves an existing graph's name on reload and does not provide a live rename operation.");
    return { config, metadata: {
      path: canonical, configPath: config.configPath, revision: config.revision,
      configured: config.configured, effective: config.effective, daemon, state,
      assignmentSource: matches[0].source, observedAt: new Date().toISOString(), error,
      extra: config.extra, exclusionSources: config.exclusionSources, canRebuild: config.canRebuild, warnings,
    } };
  }

  async read(path: string): Promise<Metadata> { return (await this.snapshot(path)).metadata; }

  /** Read-only repair proposal. It never recreates tracking or renames the active native graph. */
  async previewRepair(path: string, revision: string): Promise<MetadataPreview> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before editing.");
    const { config, metadata } = await this.snapshot(path);
    if (metadata.revision !== revision) throw new Error("Configuration changed since you opened settings. Refresh before resolving it.");
    const state = metadataRepairState(metadata);
    if (state === "unavailable") throw new Error("Daemon metadata is unavailable. Refresh the connection before resolving this mismatch.");
    if (state === "matched") throw new Error("Metadata already matches the daemon. Refresh settings to see the current state.");
    if (state === "unsupported") throw new Error("This adapter cannot refresh the index for this checkout or project mapping. No automatic metadata repair is available here.");
    const fields = { ...metadata.configured, name: metadata.effective.name === metadata.daemon!.name ? metadata.configured.name : metadata.daemon!.name };
    let candidate = this.config.prepare(config, fields);
    // Retain existing inheritance unless adopting the graph name would change its effective default.
    if (candidate.effective.workspace !== metadata.effective.workspace) fields.workspace = metadata.effective.workspace;
    candidate = this.config.prepare(config, fields);
    if (candidate.effective.project !== metadata.effective.project) fields.project = metadata.effective.project;
    // Reapply saved exclusions: restoring the prefix can bind rules previously ignored by the active graph.
    const preview = await this.preview(path, revision, fields, metadata.extra.exclude);
    if (!equal(preview.before.daemon, metadata.daemon) || !preview.rebuildsIndex) {
      this.previews.delete(preview.id);
      throw new Error("The active graph changed while preparing the repair. Refresh and review a new proposal.");
    }
    return preview;
  }

  async preview(path: string, revision: string, input: RepositoryFields, exclude?: string[]): Promise<MetadataPreview> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before editing.");
    const { config, metadata } = await this.snapshot(path);
    if (metadata.revision !== revision) throw new Error("Configuration changed since you opened the editor. Refresh before previewing.");
    const candidate = this.config.prepare(config, input, exclude);
    const updatesExclusions = exclude !== undefined;
    const rebuildsIndex = metadata.canRebuild && metadata.daemon !== null && candidate.effective.name === metadata.daemon.name && (updatesExclusions || !equal(candidate.effective, metadata.daemon));
    const warnings = [
      ...config.warnings,
      "Reload applies pending Gortex configuration for all repositories on this host. It may also apply other configuration edits made outside this plugin.",
    ];
    if (metadata.daemon && candidate.effective.name === metadata.daemon.name && candidate.effective.name !== metadata.effective.name)
      warnings.push(`The configured repository name will change from "${metadata.effective.name}" to "${candidate.effective.name}". The existing graph keeps its identity; workspace and project follow the preview below.`);
    if (rebuildsIndex) warnings.push("This applies a full index refresh to the selected repository. Queries may be temporarily unavailable while Gortex rebuilds it.");
    if (updatesExclusions) {
      warnings.push("Exclusions affect indexing and watching, not files on disk. Removing a rule does not override another layer that still excludes the same path. Repository-local include rules can override these patterns.");
      if (!rebuildsIndex) warnings.push("Exclusions will be saved, but their index refresh cannot be verified for this checkout. The result will remain pending. If the configured name differs, repo-entry rules cannot bind to the active graph until that identity is resolved.");
    }
    if (!metadata.daemon || candidate.effective.name !== metadata.daemon.name) warnings.push("These values can be saved to config.yaml, but the active graph cannot be renamed by this adapter. The result will remain pending if Gortex keeps the old identity.");
    if (!metadata.canRebuild && !equal(candidate.effective, metadata.daemon)) warnings.push("The editor cannot apply an index refresh for this checkout. Configuration can be saved and reloaded, with any remaining difference reported as pending.");
    const preview: MetadataPreview = {
      id: randomUUID(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), before: metadata,
      configured: candidate.configured, effective: candidate.effective, exclude: candidate.exclude, updatesExclusions,
      writesConfig: !equal(candidate.configured, metadata.configured) || !equal(candidate.exclude, metadata.extra.exclude), rebuildsIndex, warnings,
    };
    this.previews.set(preview.id, { public: preview, snapshot: config, text: candidate.text });
    while (this.previews.size > 40) this.previews.delete(this.previews.keys().next().value!);
    return preview;
  }

  apply(id: string): MetadataJob {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before saving.");
    const record = this.previews.get(id);
    if (!record) throw new Error("Preview expired or the plugin reloaded. Refresh the current state and create a new preview.");
    if (record.job) return this.job(record.job);
    if (Date.parse(record.public.expiresAt) < Date.now()) throw new Error("Preview expired. Create a new preview.");
    if (this.running) throw new Error("Another repository configuration change is in progress on this host. Wait for it to finish.");
    const job: MetadataJob = { id: randomUUID(), path: record.snapshot.path, stage: "validating", outcome: "running", exclusions: record.public.updatesExclusions ? "pending" : "unchanged", configSaved: false, backupPath: null, result: null, error: null };
    record.job = job.id;
    this.jobs.set(job.id, job);
    while (this.jobs.size > 40) this.jobs.delete(this.jobs.keys().next().value!);
    this.running = this.execute(record, job).finally(() => { this.running = null; });
    return { ...job };
  }

  job(id: string): MetadataJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("This job is no longer retained. Refresh metadata to reconcile the saved config and daemon; do not replay the save blindly.");
    return { ...job };
  }

  private async execute(record: PreviewRecord, job: MetadataJob): Promise<void> {
    let attemptedWrite = false;
    let nativeAttempted = false;
    let indexedRevision: string | null = null;
    try {
      const current = await this.snapshot(job.path);
      if (current.metadata.revision !== record.public.before.revision || !equal(current.metadata.daemon, record.public.before.daemon)) throw new Error("Configuration or active graph changed after preview. No changes were applied. Review a new preview.");
      if (this.closed) throw new Error("Plugin closed before the save began. No changes were applied.");
      if (record.public.writesConfig) {
        job.stage = "saving"; attemptedWrite = true;
        job.backupPath = await this.config.save(current.config, record.text);
      }
      job.configSaved = true;
      job.stage = "reloading"; nativeAttempted = true;
      await this.native.reloadConfiguration();
      await this.native.refreshContexts();
      this.invalidate();
      if (record.public.rebuildsIndex) {
        // Reload can take time. Refuse to index a config another client changed meanwhile.
        const afterReload = await this.config.load(job.path);
        if (afterReload.text !== (record.public.writesConfig ? record.text : record.snapshot.text) || afterReload.localText !== record.snapshot.localText) throw new Error("Configuration changed while reloading. Index refresh was skipped; reconcile the current state.");
        job.stage = "indexing";
        await this.native.rebuildIndex(job.path);
        indexedRevision = afterReload.revision;
        await this.native.refreshContexts();
        this.invalidate();
      }
    } catch (error) {
      job.error = errorMessage(error);
      job.outcome = attemptedWrite || nativeAttempted ? "uncertain" : "failed";
    }
    job.stage = "verifying";
    try {
      job.result = await this.read(job.path);
      // A lost response can still be reconciled, but a native failure stays visible.
      job.configSaved = equal(job.result.configured, record.public.configured) && equal(job.result.extra.exclude, record.public.exclude);
      if (record.public.updatesExclusions) {
        job.exclusions = indexedRevision !== null && indexedRevision === job.result.revision && job.configSaved ? "refreshed" : "pending";
      }
      if (job.configSaved && equal(job.result.effective, record.public.effective) && job.result.state === "applied" && job.exclusions !== "pending") job.outcome = "applied";
      else if (job.configSaved) job.outcome = "pending";
      else if (job.outcome === "running") job.outcome = "uncertain";
    } catch (error) {
      job.error = [job.error, `Verification unavailable: ${errorMessage(error)}`].filter(Boolean).join(" ");
      if (job.outcome === "running") job.outcome = "uncertain";
    }
    this.invalidate();
    job.stage = "done";
  }

  async close(): Promise<void> { this.closed = true; await this.running; this.previews.clear(); this.jobs.clear(); }
}
