import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { RepositoryUntrack, requireComplete, type UntrackPort } from "./repository-untrack.ts";
import { RepositoryConfig } from "./repository-config.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { RepositoryMetadata } from "./repository-metadata.ts";
import { untrackJobSchema, untrackPreviewSchema } from "../shared/untrack-contracts.ts";

const plan = { status: "preview", action: "untrack", plan: "primary_closure", prefix: "alpha", accessible: true, is_primary: true, confirm_required: true, detail: "Nothing was written", primary_epoch: 1, sole_primary: true, closure: [{ kind: "checkout", id: "auto", detail: "Automatic view depends on alpha" }], preserved: [{ kind: "graph", id: "beta", detail: "Separate repository" }] };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "gx-untrack-test-"));
  const path = join(root, "répo with spaces"), other = join(root, "beta");
  await mkdir(join(path, ".git"), { recursive: true }); await mkdir(other);
  await writeFile(join(path, "index.ts"), "export const alpha = 1;\n");
  const configPath = join(root, "config.yaml");
  const original = stringify({ repos: [{ path, name: "alpha", workspace: "home", project: "app" }, { path: other, name: "beta", workspace: "work", project: "other" }], llm: { api_key: "fixture-secret-do-not-return" } });
  await writeFile(configPath, original);
  const config = new RepositoryConfig(configPath), admin = new RepositoryAdminLock();
  const state = { needsPlan: false, demote: false, loseResponse: false, preserveConfig: false, offline: false, version: "gortex v0.64.3+fixture", epoch: 1, calls: [] as boolean[], resets: 0, invalidations: 0, hold: null as Promise<void> | null, returned: null as unknown };
  const native: UntrackPort = {
    version: async () => state.version,
    assignments: async () => (parse(await readFile(configPath, "utf8")).repos ?? []).map((row: { path: string; name: string; workspace: string; project: string }) => ({ ...row, repo: row.name, source: "global" })),
    info: async () => { if (state.offline) throw new Error("Daemon offline"); return { mode: "workspace", workspace: "home", project: "app", members: [{ name: "alpha", path }] }; },
    checkouts: async () => ({ value: { families: [{ family_id: "alpha-family", primary_epoch: state.epoch }] }, meta: {} }),
    untrack: async (_path, confirm) => {
      assert.equal(_path, path); state.calls.push(confirm);
      if (state.hold) await state.hold;
      if (state.returned) return { value: state.returned, meta: {} };
      if (state.needsPlan && !confirm) return { value: plan, meta: {} };
      if (!state.preserveConfig) { const raw = parse(await readFile(configPath, "utf8")); raw.repos = raw.repos.filter((row: { path: string }) => row.path !== path); await writeFile(configPath, stringify(raw)); }
      if (state.loseResponse) throw new Error("Native response lost");
      return { value: { status: state.demote ? "demoted" : "untracked", plan: state.demote ? "demote" : state.needsPlan ? "primary_closure" : "evict", prefix: "alpha", nodes_removed: 12, edges_removed: 30, demoted: state.demote }, meta: {} };
    },
    refreshContexts: async () => { state.resets++; },
  };
  const service = new RepositoryUntrack(native, config, () => { state.invalidations++; }, admin);
  t.after(async () => {
    await service.close();
    const target = resolve(root); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes("gx-untrack-test-"));
    await rm(target, { recursive: true, force: true });
  });
  return { root, path, other, configPath, original, config, admin, native, state, service };
}
async function completed(service: RepositoryUntrack, id: string) {
  const deadline = Date.now() + 3000;
  let job = service.job(id);
  while (job.stage !== "done" && Date.now() < deadline) { await delay(5); job = service.job(id); }
  assert.equal(job.stage, "done"); untrackJobSchema.parse(job); return job;
}

test("preview is read-only, bounded to an explicit repository and does not expose host secrets", async t => {
  const f = await fixture(t);
  const preview = await f.service.preview(f.path);
  untrackPreviewSchema.parse(preview); assert.equal(preview.native, null);
  assert.deepEqual(f.state.calls, []); assert.equal(await readFile(f.configPath, "utf8"), f.original);
  assert.equal((await readdir(f.root)).some(name => name.endsWith(".bak")), false);
  assert.ok(!JSON.stringify(preview).includes("fixture-secret"));
  await assert.rejects(() => f.service.preview(f.root));
  await assert.rejects(() => f.service.preview("relative/path"), /absolute/);
  const automatic = join(f.root, "automatic"); await mkdir(automatic);
  await assert.rejects(() => f.service.preview(automatic), /exactly one native repos entry/);
});

test("confirmed ordinary untracking backs up, preserves source and other repo, and deduplicates clicks", async t => {
  const f = await fixture(t), preview = await f.service.preview(f.path);
  const started = f.service.apply(preview.id); assert.equal(f.service.apply(preview.id).id, started.id);
  const job = await completed(f.service, started.id);
  assert.equal(job.outcome, "untracked"); assert.equal(job.configRemoved, true); assert.deepEqual(f.state.calls, [false]);
  assert.equal(await readFile(job.backupPath!, "utf8"), f.original);
  assert.equal(await readFile(join(f.path, "index.ts"), "utf8"), "export const alpha = 1;\n");
  const saved = parse(await readFile(f.configPath, "utf8")), before = parse(f.original);
  assert.deepEqual(saved.repos, [before.repos[1]]); assert.deepEqual(saved.llm, before.llm);
  assert.equal(f.state.resets, 1); assert.equal(f.state.invalidations, 1);
  assert.equal(f.service.apply(preview.id).id, job.id); assert.equal(f.state.calls.length, 1);
});

test("native primary closure requires a separate preview token and confirmation", async t => {
  const f = await fixture(t); f.state.needsPlan = true;
  const preview = await f.service.preview(f.path);
  const review = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(review.outcome, "review"); assert.equal(review.preview?.native?.plan, "primary_closure");
  assert.deepEqual(review.preview?.native?.closure, plan.closure); assert.deepEqual(review.preview?.native?.preserved, plan.preserved);
  assert.deepEqual(f.state.calls, [false]); assert.equal(await readFile(f.configPath, "utf8"), f.original);
  assert.notEqual(review.preview?.id, preview.id);
  assert.equal(f.service.apply(preview.id).id, review.id, "first confirmation never becomes authority for removal");
  const done = await completed(f.service, f.service.apply(review.preview!.id).id);
  assert.equal(done.outcome, "untracked"); assert.deepEqual(f.state.calls, [false, true]);
  assert.equal(done.backupPath, review.backupPath);
});

test("dedicated worktree demotion is reported as automatic indexing retained", async t => {
  const f = await fixture(t); f.state.demote = true;
  const job = await completed(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
  assert.equal(job.outcome, "demoted"); assert.equal(job.receipt?.plan, "demote"); assert.deepEqual(f.state.calls, [false]);
});

test("external config edits and checkout epoch changes invalidate previews before mutation", async t => {
  const f = await fixture(t), a = await f.service.preview(f.path);
  await writeFile(f.configPath, f.original + "# external edit\n");
  const first = await completed(f.service, f.service.apply(a.id).id);
  assert.equal(first.outcome, "failed"); assert.match(first.error!, /changed after preview/);
  const b = await f.service.preview(f.path); f.state.epoch++;
  const second = await completed(f.service, f.service.apply(b.id).id);
  assert.equal(second.outcome, "failed"); assert.deepEqual(f.state.calls, []);
});

test("primary confirmation rejects a stale native plan", async t => {
  const f = await fixture(t); f.state.needsPlan = true;
  const review = await completed(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
  f.state.epoch++;
  const failed = await completed(f.service, f.service.apply(review.preview!.id).id);
  assert.equal(failed.outcome, "failed"); assert.deepEqual(f.state.calls, [false]);
});

test("a lost response reconciles config absence but does not invent daemon success or replay", async t => {
  const f = await fixture(t); f.state.loseResponse = true;
  const preview = await f.service.preview(f.path);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "uncertain"); assert.equal(result.configRemoved, true); assert.equal(result.receipt, null);
  assert.match(result.error!, /response lost/); assert.equal(f.service.apply(preview.id).id, result.id); assert.deepEqual(f.state.calls, [false]);
});

test("unverified writes with retained config cannot be resubmitted as a new preview", async t => {
  const f = await fixture(t); f.state.loseResponse = true; f.state.preserveConfig = true;
  const result = await completed(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
  assert.equal(result.outcome, "uncertain"); assert.equal(result.configRemoved, false);
  await assert.rejects(() => f.service.preview(f.path), /unverified outcome/); assert.deepEqual(f.state.calls, [false]);
  const metadata = new RepositoryMetadata({ ...f.native, reloadConfiguration: async () => {}, rebuildIndex: async () => {} }, f.config, () => {}, f.admin);
  t.after(() => metadata.close());
  const current = await metadata.read(f.path);
  const edit = await metadata.preview(f.path, current.revision, { ...current.configured, project: "other" });
  assert.throws(() => metadata.apply(edit.id), /writes are paused/, "a timed-out untrack must not race a metadata save");
});

test("malformed, truncated and unexpected native plans never authorize confirm:true", async t => {
  const f = await fixture(t); f.state.returned = { ...plan, _truncated_by_budget: true };
  const job = await completed(f.service, f.service.apply((await f.service.preview(f.path)).id).id);
  assert.equal(job.outcome, "uncertain"); assert.equal(job.preview, null); assert.deepEqual(f.state.calls, [false]);
  for (const value of [{ partial: true }, { families: [{ _truncated: true }] }, { complete: false }]) assert.throws(() => requireComplete(value), /incomplete/);
});

test("unknown versions, offline daemon, graph mismatch and incomplete catalogs cannot preview", async t => {
  const f = await fixture(t); f.state.version = "gortex v0.65.0";
  await assert.rejects(() => f.service.preview(f.path), /compatibility/);
  f.state.version = "gortex v0.64.3"; f.state.offline = true;
  await assert.rejects(() => f.service.preview(f.path), /offline/); f.state.offline = false;
  f.native.checkouts = async () => ({ value: { families: [], _truncated: true }, meta: {} });
  await assert.rejects(() => f.service.preview(f.path), /incomplete/);
  const raw = parse(f.original); raw.repos[0].name = "different"; await writeFile(f.configPath, stringify(raw));
  await assert.rejects(() => f.service.preview(f.path), /name and active graph mismatch/);
  assert.deepEqual(f.state.calls, []);
});

test("plugin reload invalidates approval tokens instead of replaying untracking", async t => {
  const f = await fixture(t), preview = await f.service.preview(f.path);
  const second = new RepositoryUntrack(f.native, f.config);
  t.after(() => second.close());
  assert.throws(() => second.apply(preview.id), /expired or the plugin reloaded/);
  assert.deepEqual(f.state.calls, []);
});

test("metadata saves and untracking share the host administration lock", async t => {
  const f = await fixture(t);
  const metadata = new RepositoryMetadata({ ...f.native, reloadConfiguration: async () => {}, rebuildIndex: async () => {} }, f.config, () => {}, f.admin);
  t.after(() => metadata.close());
  const before = await metadata.read(f.path), edit = await metadata.preview(f.path, before.revision, { ...before.configured, project: "next" });
  let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const untrack = f.service.apply((await f.service.preview(f.path)).id);
  try { assert.throws(() => metadata.apply(edit.id), /administration change is in progress/); }
  finally { release(); }
  assert.equal((await completed(f.service, untrack.id)).outcome, "untracked");
});
