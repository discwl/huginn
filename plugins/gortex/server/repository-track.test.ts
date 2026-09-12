import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RepositoryTrack, type TrackPort } from "./repository-track.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { runProcess } from "./process-runner.ts";
import type { NativeAssignment } from "../shared/models.ts";
import { observeTrackReadiness, trackReadinessBudgetMs, trackReadinessIntervalMs, type TrackJob } from "../shared/track-contracts.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gx-track-unit-")));
  const path = join(root, "new café repo"), configPath = join(root, "config.yaml");
  await mkdir(path); await runProcess("git", ["init", "-q", path], root);
  await writeFile(configPath, "repos: []\n");
  const rows: NativeAssignment[] = [];
  let writes = 0, invalidations = 0;
  const native: TrackPort = {
    version: async () => "gortex v0.64.3+fixture", assignments: async () => rows,
    track: async target => { writes++; rows.push({ repo: "new café repo", path: target, workspace: "personal", project: "automation", source: "global" }); },
    info: async target => ({ workspace: "personal", project: "automation", mode: "workspace", members: [{ name: "new café repo", path: target }] }),
    refreshContexts: async () => {},
  };
  const lock = new RepositoryAdminLock();
  const service = new RepositoryTrack(native, () => { invalidations++; }, lock, configPath);
  return { root, path, configPath, rows, native, lock, service, writes: () => writes, invalidations: () => invalidations, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}
async function finish(service: RepositoryTrack, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.job(id); if (job.stage === "done") return job; await delay(10); }
  throw new Error("Tracking job did not finish");
}

test("tracking preview is read-only; repeated confirmation submits one native write and refreshes authoritative state", async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview(f.path); assert.equal(f.writes(), 0);
    const job = f.service.apply(preview.id);
    assert.equal(f.service.apply(preview.id).id, job.id);
    const result = await finish(f.service, job.id);
    assert.equal(result.outcome, "tracked"); assert.equal(result.registered, true);
    assert.equal(result.repository?.workspaceId, "personal"); assert.equal(f.writes(), 1); assert.equal(f.invalidations(), 1);
    assert.equal(result.repository?.path, f.path);
    await assert.rejects(f.service.preview(f.path), /already tracked/i);
  } finally { await f.close(); }
});

test("an unused approval expires without a native write and can be reviewed again", async t => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    const preview = await f.service.preview(f.path);
    now = Date.parse(preview.expiresAt);
    assert.throws(() => f.service.apply(preview.id), /expired/i);
    assert.equal(f.writes(), 0);
    const next = await f.service.preview(f.path);
    assert.notEqual(next.id, preview.id); assert.ok(Date.parse(next.expiresAt) > now);
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("accepted jobs remain idempotently recoverable after their approval expires", async t => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    const preview = await f.service.preview(f.path), accepted = f.service.apply(preview.id);
    now = Date.parse(preview.expiresAt) + 60_000;
    assert.equal(f.service.apply(preview.id).id, accepted.id);
    const result = await finish(f.service, accepted.id);
    now += 60_000;
    assert.deepEqual(f.service.apply(preview.id), result);
    assert.equal(result.outcome, "tracked"); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("configuration and repository identity changes invalidate tracking previews before any write", async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview(f.path);
    await writeFile(f.configPath, "repos: []\n# another client changed config\n");
    const result = await finish(f.service, f.service.apply(preview.id).id);
    assert.equal(result.outcome, "failed"); assert.equal(f.writes(), 0);
    const next = await f.service.preview(f.path);
    await writeFile(join(f.path, ".gortex.yaml"), "workspace: changed\n");
    assert.equal((await finish(f.service, f.service.apply(next.id).id)).outcome, "failed");
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("a repository registered after preview is never tracked a second time", async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview(f.path);
    f.rows.push({ repo: "external", path: f.path, workspace: "external", project: "external", source: "global" });
    const result = await finish(f.service, f.service.apply(preview.id).id);
    assert.equal(result.outcome, "failed"); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("a lost native response reconciles a saved entry without blind retry or fabricated readiness", async () => {
  const f = await fixture();
  try {
    const track = f.native.track;
    f.native.track = async path => { await track(path); throw new Error("Connection lost after configuration save"); };
    const result = await finish(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
    assert.equal(result.outcome, "uncertain"); assert.equal(result.registered, true); assert.equal(result.repository, null);
    f.native.info = async () => { assert.fail("An uncertain job must not publish readiness."); };
    assert.equal((await f.service.observe(result.id)).outcome, "uncertain");
    assert.equal(f.writes(), 1); assert.throws(() => f.lock.acquire(), /unverified|uncertain/i);
    await assert.rejects(f.service.preview(f.path), /already tracked/i);
  } finally { await f.close(); }
});

test("tracking registration is distinct from graph availability", async () => {
  const f = await fixture();
  try {
    f.native.info = async () => { throw new Error("Index admission pending"); };
    const result = await finish(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
    assert.equal(result.outcome, "indexing"); assert.equal(result.registered, true); assert.equal(result.repository, null);
    assert.match(result.error!, /pending/); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("pending tracking observes its native path until a view resolves, then invalidates without another write or catalog scan", async () => {
  const f = await fixture();
  const info = f.native.info, assignments = f.native.assignments;
  let contextReads = 0, catalogReads = 0, contextRefreshes = 0;
  f.native.info = async path => { contextReads++; return contextReads < 3 ? { workspace: "personal", project: "automation", mode: "workspace", members: [] } : info(path); };
  f.native.assignments = async () => { catalogReads++; return assignments(); };
  f.native.refreshContexts = async () => { contextRefreshes++; };
  try {
    const accepted = f.service.apply((await f.service.preview(f.path)).id);
    assert.equal((await finish(f.service, accepted.id)).outcome, "indexing");
    const initialCatalogReads = catalogReads;
    let now = 0, updates = 0;
    const state = await observeTrackReadiness({
      read: () => f.service.observe(accepted.id), onJob: () => { updates++; }, signal: new AbortController().signal,
      now: () => now, wait: async ms => { now += ms; },
    });
    assert.equal(state, "ready"); assert.equal(now, 6000); assert.equal(updates, 2);
    const result = f.service.job(accepted.id);
    assert.equal(result.outcome, "tracked"); assert.equal(result.repository?.state, "resolved");
    assert.equal(result.repository?.path, f.path); assert.equal(result.repository?.workspaceId, "personal"); assert.equal(result.error, null);
    assert.equal(catalogReads, initialCatalogReads); assert.equal(contextRefreshes, 1); assert.equal(contextReads, 3);
    assert.equal(f.writes(), 1); assert.equal(f.invalidations(), 2);
    await f.service.observe(accepted.id); assert.equal(contextReads, 3);
  } finally { await f.close(); }
});

test("readiness keeps unrelated views pending and a native read error preserves the registration receipt", async () => {
  const f = await fixture();
  f.native.info = async () => ({ workspace: "other", project: "other", mode: "workspace", members: [{ name: "other", path: f.root }] });
  try {
    const accepted = f.service.apply((await f.service.preview(f.path)).id);
    await finish(f.service, accepted.id);
    const pending = await f.service.observe(accepted.id);
    assert.equal(pending.outcome, "indexing"); assert.equal(pending.repository, null);
    f.native.info = async () => { throw new Error("Native connection lost"); };
    await assert.rejects(f.service.observe(accepted.id), /connection lost/);
    const retained = f.service.job(accepted.id);
    assert.equal(retained.outcome, "indexing"); assert.equal(retained.registered, true); assert.equal(retained.repository, null);
    assert.equal(f.invalidations(), 1); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("automatic readiness has a 60-second, 3-second read budget and permits a later explicit read", async () => {
  const f = await fixture(), info = f.native.info;
  let contextReads = 0;
  f.native.info = async () => { contextReads++; return { workspace: "personal", project: "automation", mode: "workspace", members: [] }; };
  try {
    const accepted = f.service.apply((await f.service.preview(f.path)).id);
    await finish(f.service, accepted.id);
    let now = 0, reads = 0;
    const waits: number[] = [];
    const state = await observeTrackReadiness({
      read: () => { reads++; return f.service.observe(accepted.id); }, onJob: job => { assert.equal(job.outcome, "indexing"); },
      signal: new AbortController().signal, now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    });
    assert.equal(state, "pending"); assert.equal(now, trackReadinessBudgetMs);
    assert.equal(reads, 20); assert.equal(contextReads, 21); assert.deepEqual(waits, Array(20).fill(trackReadinessIntervalMs));
    assert.equal(f.invalidations(), 1); assert.equal(f.writes(), 1);
    f.native.info = info;
    assert.equal((await f.service.observe(accepted.id)).outcome, "tracked");
    assert.equal(f.invalidations(), 2); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("readiness stops on cancellation or errors and does not publish a read from an old dialog", async () => {
  const pending: TrackJob = { id: "job", path: "repo", stage: "done", outcome: "indexing", registered: true, repository: null, error: null };
  let reads = 0, updates = 0, now = 0;
  const cancelledWait = new AbortController();
  const stopped = await observeTrackReadiness({
    read: async () => { reads++; return pending; }, onJob: () => { updates++; }, signal: cancelledWait.signal,
    now: () => now, wait: async ms => { now += ms; cancelledWait.abort(); },
  });
  assert.equal(stopped, "stopped"); assert.equal(reads, 0);
  const cancelledRead = new AbortController();
  assert.equal(await observeTrackReadiness({
    read: async () => { reads++; cancelledRead.abort(); return { ...pending, outcome: "tracked" }; }, onJob: () => { updates++; },
    signal: cancelledRead.signal, now: () => now, wait: async ms => { now += ms; },
  }), "stopped");
  assert.equal(reads, 1); assert.equal(updates, 0);
  let waits = 0;
  await assert.rejects(observeTrackReadiness({
    read: async () => { reads++; throw new Error("Disconnected host"); }, onJob: () => { updates++; }, signal: new AbortController().signal,
    now: () => now, wait: async ms => { now += ms; waits++; },
  }), /Disconnected host/);
  assert.equal(waits, 1); assert.equal(reads, 2); assert.equal(updates, 0);
  const cancelledTimer = new AbortController();
  const timed = observeTrackReadiness({ read: async () => { reads++; return pending; }, onJob: () => { updates++; }, signal: cancelledTimer.signal });
  cancelledTimer.abort(); assert.equal(await timed, "stopped"); assert.equal(reads, 2);
});

test("the readiness window ends at 60 seconds even when a native read is still pending", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, updates = 0;
  let finishRead!: (job: TrackJob) => void, startedRead!: () => void;
  const started = new Promise<void>(resolve => { startedRead = resolve; });
  const observation = observeTrackReadiness({
    read: () => { reads++; startedRead(); return new Promise(resolve => { finishRead = resolve; }); },
    onJob: () => { updates++; }, signal: new AbortController().signal,
  });
  t.mock.timers.tick(trackReadinessIntervalMs); await started;
  t.mock.timers.tick(trackReadinessBudgetMs - trackReadinessIntervalMs);
  assert.equal(await observation, "pending"); assert.equal(reads, 1);
  finishRead({ id: "job", path: "repo", stage: "done", outcome: "tracked", registered: true, repository: null, error: null });
  await Promise.resolve(); assert.equal(updates, 0);
});

test("concurrent native observations share one read and close joins it without publishing readiness", async () => {
  const f = await fixture();
  const info = f.native.info;
  f.native.info = async () => ({ workspace: "personal", project: "automation", mode: "workspace", members: [] });
  try {
    const accepted = f.service.apply((await f.service.preview(f.path)).id);
    await finish(f.service, accepted.id);
    let reads = 0, finishRead!: (value: Awaited<ReturnType<TrackPort["info"]>>) => void;
    f.native.info = () => { reads++; return new Promise(resolve => { finishRead = resolve; }); };
    const first = f.service.observe(accepted.id), second = f.service.observe(accepted.id);
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await delay(0); assert.equal(closed, false); assert.equal(reads, 1);
    finishRead(await info(f.path));
    const [a, b] = await Promise.all([first, second, closing]);
    assert.equal(a.outcome, "indexing"); assert.equal(b.outcome, "indexing"); assert.equal(closed, true);
    assert.equal(f.invalidations(), 1); assert.equal(f.writes(), 1);
    await assert.rejects(f.service.observe(accepted.id), /closing/);
  } finally { await f.close(); }
});

test("plain folders, automatic worktrees, prefix collisions and unsupported versions cannot start tracking", async () => {
  const f = await fixture();
  try {
    const plain = join(f.root, "plain"), worktree = join(f.root, "worktree");
    await mkdir(plain); await mkdir(worktree); await writeFile(join(worktree, ".git"), "gitdir: missing\n");
    await assert.rejects(f.service.preview(plain), /Git|folder/i);
    await assert.rejects(f.service.preview(worktree), /worktree|submodule/i);
    f.rows.push({ repo: "new café repo", path: join(f.root, "different"), workspace: "other", project: "other", source: "global" });
    await assert.rejects(f.service.preview(f.path), /name|prefix/i); f.rows.length = 0;
    f.native.version = async () => "gortex v9.0.0";
    await assert.rejects(f.service.preview(f.path), /compatibility|verified/i);
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("tracking shares the host administration lock and closing invalidates approval tokens", async () => {
  const f = await fixture();
  try {
    const preview = await f.service.preview(f.path), release = f.lock.acquire();
    assert.throws(() => f.service.apply(preview.id), /in progress/i); release();
    await f.service.close(); assert.throws(() => f.service.apply(preview.id), /closing|closed/i); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});
