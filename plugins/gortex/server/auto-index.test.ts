import test from "node:test";
import assert from "node:assert/strict";
import { AutoIndexer, type AutoIndexMetadata, type AutoIndexSettings, type AutoIndexTrack } from "./auto-index.ts";
import type { TrackJob } from "../shared/track-contracts.ts";
import type { MetadataJob, RepositoryFields } from "../shared/metadata-contracts.ts";

const PATH = "C:/Code/new-project";
function fixture(options: { settings?: AutoIndexSettings | null; previewError?: string; trackOutcome?: TrackJob["outcome"]; readyAfter?: number; metadataOutcome?: MetadataJob["outcome"]; configuredWorkspace?: string } = {}) {
  const calls: string[] = [];
  let observes = 0;
  const done = (outcome: TrackJob["outcome"]): TrackJob => ({ id: "t1", path: PATH, stage: "done", outcome, registered: outcome !== "failed", repository: null, error: outcome === "failed" ? "Host command failed" : null });
  const track: AutoIndexTrack = {
    preview: async path => { calls.push(`track.preview ${path}`); if (options.previewError) throw new Error(options.previewError); return { id: "p1" } as never; },
    apply: () => { calls.push("track.apply"); return { ...done(options.trackOutcome ?? "indexing"), stage: "tracking", outcome: "running" } as never; },
    job: () => done(options.trackOutcome ?? "indexing"),
    observe: async () => { observes++; return done(observes >= (options.readyAfter ?? 1) ? "tracked" : "indexing"); },
  };
  let saved: RepositoryFields | null = null;
  const metadata: AutoIndexMetadata = {
    read: async () => ({ revision: "r1", configured: { name: "", workspace: options.configuredWorkspace ?? "", project: "" }, extra: { exclude: [] } }),
    preview: async (_path, _revision, input) => { calls.push(`metadata.preview ${input.workspace}`); saved = input; return { id: "m1" } as never; },
    apply: () => { calls.push("metadata.apply"); return { id: "j1", stage: "saving", outcome: "running", configSaved: false, error: null } as never; },
    job: () => ({ id: "j1", stage: "done", outcome: options.metadataOutcome ?? "applied", configSaved: options.metadataOutcome !== "failed", error: options.metadataOutcome === "applied" || !options.metadataOutcome ? null : "Gortex rejected the request." }) as never,
  };
  const settings = "settings" in options ? options.settings! : { autoIndex: true, defaultWorkspace: "jci" };
  const indexer = new AutoIndexer(track, metadata, async () => settings, { wait: async () => {}, intervalMs: 1000, trackBudgetMs: 5000, readyBudgetMs: 5000, assignBudgetMs: 5000 });
  return { indexer, calls, saved: () => saved };
}
const created = { cwd: PATH, archivedAt: null };

test("disabled or unreadable settings never preview or track", async () => {
  for (const settings of [{ autoIndex: false, defaultWorkspace: "jci" }, null]) {
    const f = fixture({ settings });
    await f.indexer.handle(created);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.indexer.activity(), []);
  }
});

test("a new project is indexed and joins the host's default workspace", async () => {
  const f = fixture();
  await f.indexer.handle(created);
  assert.deepEqual(f.calls, [`track.preview ${PATH}`, "track.apply", "metadata.preview jci", "metadata.apply"]);
  assert.equal(f.saved()?.workspace, "jci");
  const [record] = f.indexer.activity();
  assert.equal(record.outcome, "assigned"); assert.equal(record.workspace, "jci");
});

test("without a default workspace the project is indexed and its native default kept", async () => {
  const f = fixture({ settings: { autoIndex: true, defaultWorkspace: "  " } });
  await f.indexer.handle(created);
  assert.deepEqual(f.calls, [`track.preview ${PATH}`, "track.apply"]);
  assert.equal(f.indexer.activity()[0].outcome, "indexed");
});

test("already-tracked projects are silent; worktrees and plain folders are recorded as skipped", async () => {
  const tracked = fixture({ previewError: "This repository is already tracked. Refresh the library." });
  await tracked.indexer.handle(created);
  assert.deepEqual(tracked.indexer.activity(), []);
  const worktree = fixture({ previewError: "Linked worktree or submodule; Gortex indexes it through its primary." });
  await worktree.indexer.handle(created);
  assert.equal(worktree.indexer.activity()[0].outcome, "skipped");
  assert.ok(!worktree.calls.includes("track.apply"));
});

test("a failed tracking job is reported and no workspace is written", async () => {
  const f = fixture({ trackOutcome: "failed" });
  await f.indexer.handle(created);
  assert.ok(!f.calls.some(call => call.startsWith("metadata")));
  const [record] = f.indexer.activity();
  assert.equal(record.outcome, "failed"); assert.match(record.message!, /Host command failed/);
});

test("a graph that never becomes ready leaves the workspace for manual assignment", async () => {
  const f = fixture({ readyAfter: 99 });
  await f.indexer.handle(created);
  assert.ok(!f.calls.some(call => call.startsWith("metadata")));
  const [record] = f.indexer.activity();
  assert.equal(record.outcome, "indexed"); assert.match(record.message!, /Repository settings/);
});

test("a saved but unapplied workspace is pending, with Gortex's reason", async () => {
  const f = fixture({ metadataOutcome: "pending" });
  await f.indexer.handle(created);
  const [record] = f.indexer.activity();
  assert.equal(record.outcome, "pending"); assert.match(record.message!, /rejected/);
});

test("a workspace that is already configured is not rewritten", async () => {
  const f = fixture({ configuredWorkspace: "jci" });
  await f.indexer.handle(created);
  assert.ok(!f.calls.some(call => call.startsWith("metadata.preview")));
  assert.equal(f.indexer.activity()[0].outcome, "assigned");
});

test("duplicate events and archived workspaces do not start a second run", async () => {
  const f = fixture();
  await Promise.all([f.indexer.handle(created), f.indexer.handle({ cwd: PATH.toUpperCase(), archivedAt: null }), f.indexer.handle({ cwd: PATH, archivedAt: "2026-09-18T00:00:00Z" })]);
  assert.equal(f.calls.filter(call => call === "track.apply").length, process.platform === "win32" ? 1 : 2);
});
