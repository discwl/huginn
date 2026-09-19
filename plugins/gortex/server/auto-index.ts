import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AutoIndexRecord } from "../shared/auto-index-contracts.ts";
import type { MetadataJob, MetadataPreview, RepositoryFields } from "../shared/metadata-contracts.ts";
import type { TrackJob, TrackPreview } from "../shared/track-contracts.ts";

export interface AutoIndexSettings { autoIndex: boolean; defaultWorkspace: string }
export interface AutoIndexTrack {
  preview(path: string): Promise<TrackPreview>;
  apply(id: string): TrackJob;
  job(id: string): TrackJob;
  observe(id: string): Promise<TrackJob>;
}
export interface AutoIndexMetadata {
  read(path: string): Promise<{ revision: string; configured: RepositoryFields; extra: { exclude: string[] } }>;
  preview(path: string, revision: string, input: RepositoryFields, exclude?: string[]): Promise<MetadataPreview>;
  apply(id: string): MetadataJob;
  job(id: string): MetadataJob;
}
export interface AutoIndexOptions { wait?: (ms: number) => Promise<unknown>; trackBudgetMs?: number; readyBudgetMs?: number; assignBudgetMs?: number; intervalMs?: number }

const message = (error: unknown) => error instanceof Error ? error.message : "Automatic indexing failed.";
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

/**
 * Indexes a newly created Paseo project with the same previewed, lock-guarded flow as the Index button,
 * then applies the host's default Gortex workspace. Opt-in; runs in the background of a workspace.created event.
 * Plain folders are indexed too. Worktrees, folders overlapping a tracked repository, and already-tracked
 * repositories are rejected by the tracking preview and recorded as skipped (already-tracked silently).
 */
export class AutoIndexer {
  private records: AutoIndexRecord[] = [];
  private active = new Set<string>();
  private running = new Set<Promise<void>>();
  private closed = false;
  private wait: (ms: number) => Promise<unknown>;
  private budgets: Required<Omit<AutoIndexOptions, "wait">>;
  private track: AutoIndexTrack;
  private metadata: AutoIndexMetadata;
  private settings: () => Promise<AutoIndexSettings | null>;
  constructor(track: AutoIndexTrack, metadata: AutoIndexMetadata, settings: () => Promise<AutoIndexSettings | null>, options: AutoIndexOptions = {}) {
    this.track = track; this.metadata = metadata; this.settings = settings;
    this.wait = options.wait ?? (ms => delay(ms));
    this.budgets = { trackBudgetMs: options.trackBudgetMs ?? 180_000, readyBudgetMs: options.readyBudgetMs ?? 180_000, assignBudgetMs: options.assignBudgetMs ?? 600_000, intervalMs: options.intervalMs ?? 3000 };
  }

  activity(): AutoIndexRecord[] { return this.records.map(record => ({ ...record })); }

  /** Returns immediately; lifecycle hooks have a 30-second budget and indexing can take longer. */
  handle(workspace: { cwd: string; archivedAt: string | null }): Promise<void> {
    if (this.closed || workspace.archivedAt || !workspace.cwd) return Promise.resolve();
    const key = pathKey(workspace.cwd);
    if (this.active.has(key)) return Promise.resolve();
    this.active.add(key);
    const run = this.run(workspace.cwd).catch(() => { /* Recorded in run. */ }).finally(() => { this.active.delete(key); this.running.delete(run); });
    this.running.add(run);
    return run;
  }

  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.running]); }

  private record(path: string): AutoIndexRecord {
    const record: AutoIndexRecord = { id: randomUUID(), path, observedAt: new Date().toISOString(), outcome: "running", workspace: null, message: null };
    this.records.unshift(record);
    this.records.length = Math.min(this.records.length, 20);
    return record;
  }

  private async run(path: string): Promise<void> {
    const settings = await this.settings().catch(() => null);
    if (!settings?.autoIndex) return;
    const workspace = settings.defaultWorkspace.trim();
    let preview: TrackPreview;
    try { preview = await this.track.preview(path); }
    catch (error) {
      // Already-tracked projects are the common case for new workspaces of existing repositories; not worth a row.
      if (/already tracked/i.test(message(error))) return;
      const record = this.record(path);
      record.outcome = "skipped"; record.message = message(error);
      return;
    }
    const record = this.record(path);
    record.workspace = workspace || null;
    try {
      const tracked = await this.finishTracking(preview);
      if (tracked.outcome === "failed" || tracked.outcome === "uncertain") throw new Error(tracked.error ?? `Indexing ${tracked.outcome}.`);
      record.outcome = "indexed";
      if (!workspace) return;
      const ready = await this.awaitReady(tracked);
      if (ready.outcome !== "tracked") {
        record.message = `Indexed, but its graph was not ready within ${Math.round(this.budgets.readyBudgetMs / 1000)} seconds. Set the workspace in Repository settings.`;
        return;
      }
      await this.assign(path, workspace, record);
    } catch (error) {
      record.outcome = "failed"; record.message = message(error);
    }
  }

  private async finishTracking(preview: TrackPreview): Promise<TrackJob> {
    let job = this.track.apply(preview.id);
    for (let elapsed = 0; job.stage !== "done"; elapsed += this.budgets.intervalMs) {
      if (this.closed || elapsed >= this.budgets.trackBudgetMs) throw new Error("Stopped waiting for the tracking result. Check the repository list before retrying.");
      await this.wait(this.budgets.intervalMs);
      job = this.track.job(job.id);
    }
    return job;
  }

  private async awaitReady(job: TrackJob): Promise<TrackJob> {
    for (let elapsed = 0; job.outcome === "indexing"; elapsed += this.budgets.intervalMs) {
      if (this.closed || elapsed >= this.budgets.readyBudgetMs) return job;
      await this.wait(this.budgets.intervalMs);
      job = await this.track.observe(job.id).catch(() => job);
    }
    return job;
  }

  private async assign(path: string, workspace: string, record: AutoIndexRecord): Promise<void> {
    const current = await this.metadata.read(path);
    if (current.configured.workspace === workspace) { record.outcome = "assigned"; return; }
    const preview = await this.metadata.preview(path, current.revision, { ...current.configured, workspace });
    let job = this.metadata.apply(preview.id);
    for (let elapsed = 0; job.stage !== "done"; elapsed += this.budgets.intervalMs) {
      if (this.closed || elapsed >= this.budgets.assignBudgetMs) { record.outcome = "pending"; record.message = "Workspace saved; stopped waiting for Gortex to apply it. Check Repository settings."; return; }
      await this.wait(this.budgets.intervalMs);
      job = this.metadata.job(job.id);
    }
    if (job.outcome === "applied") { record.outcome = "assigned"; return; }
    record.outcome = job.configSaved ? "pending" : "failed";
    record.message = job.error ?? (job.configSaved ? "Workspace saved; Gortex has not applied it yet." : "The workspace was not saved.");
  }
}
