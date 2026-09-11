import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { RepositoryConfig, sameRepositoryPath } from "./repository-config.ts";
import { RepositoryMetadata, type MetadataPort } from "./repository-metadata.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import type { RepositoryFields } from "../shared/metadata-contracts.ts";
import { parseExclusionLines } from "../shared/exclusions.ts";
import { metadataRepairState } from "../shared/metadata-repair.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "gortex-metadata-"));
  const path = join(root, "répo with spaces");
  await mkdir(join(path, ".git"), { recursive: true });
  const configPath = join(root, "config.yaml");
  const original = "# Keep my comments\n" + stringify({ repos: [{ path, name: "original", workspace: "home", project: "app", exclude: ["build/**"], ref: "review", future_field: { enabled: true } }], llm: { api_key: "fixture-value-only" }, unknown_future: [1, 2, 3] });
  await writeFile(configPath, original);
  const config = new RepositoryConfig(configPath);
  const state = { daemon: { name: "original", workspace: "home", project: "app" } as RepositoryFields, reloads: 0, rebuilds: 0, resets: 0, reloadFails: false, graphFails: false, hold: null as Promise<void> | null };
  const native: MetadataPort = {
    version: async () => "gortex v0.64.3+fixture",
    assignments: async () => { const s = await config.load(path); return [{ path, repo: s.effective.name, workspace: s.effective.workspace, project: s.effective.project, source: "global" }]; },
    info: async () => { if (state.graphFails) throw new Error("Daemon offline"); return { workspace: state.daemon.workspace, project: state.daemon.project, mode: "workspace", members: [{ name: state.daemon.name, path }] }; },
    reloadConfiguration: async () => { state.reloads++; if (state.hold) await state.hold; if (state.reloadFails) throw new Error("Reload response lost"); },
    rebuildIndex: async () => { state.rebuilds++; state.daemon = (await config.load(path)).effective; },
    refreshContexts: async () => { state.resets++; },
  };
  const service = new RepositoryMetadata(native, config);
  t.after(async () => {
    await service.close();
    const target = resolve(root), allowed = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(allowed) && target.includes("gortex-metadata-"));
    await rm(target, { recursive: true, force: true });
  });
  return { root, path, configPath, original, config, state, native, service };
}
async function completed(service: RepositoryMetadata, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = service.job(id);
    if (job.stage === "done") return job;
    await delay(10);
  }
  throw new Error("Fixture job did not finish");
}

test("repair previews the name reset, keeps desired workspace/project, and applies only after confirmation", async t => {
  const f = await fixture(t);
  const changed = f.config.prepare(await f.config.load(f.path), { name: "gortexkit", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, changed.text);
  const before = await f.service.read(f.path);
  assert.equal(metadataRepairState(before), "name-conflict");
  const preview = await f.service.previewRepair(f.path, before.revision);
  assert.deepEqual(preview.before.effective, { name: "gortexkit", workspace: "personal", project: "paseo" });
  assert.deepEqual(preview.effective, { name: "original", workspace: "personal", project: "paseo" });
  assert.equal(preview.rebuildsIndex, true); assert.equal(preview.updatesExclusions, true);
  assert.ok(preview.warnings.some(warning => warning.includes('from "gortexkit" to "original"')));
  assert.equal(await readFile(f.configPath, "utf8"), changed.text, "canceling a proposal leaves configuration intact");
  assert.equal(f.state.reloads, 0); assert.equal(f.state.rebuilds, 0);
  const started = f.service.apply(preview.id);
  assert.equal(f.service.apply(preview.id).id, started.id);
  const result = await completed(f.service, started.id);
  assert.equal(result.outcome, "applied"); assert.equal(result.exclusions, "refreshed");
  assert.equal(metadataRepairState(result.result!), "matched");
  assert.deepEqual(result.result?.daemon, preview.effective);
  assert.equal(await readFile(result.backupPath!, "utf8"), changed.text);
  const saved = parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(saved.repos[0].exclude, ["build/**"]); assert.equal(saved.repos[0].ref, "review");
  assert.deepEqual(saved.llm, parse(changed.text).llm);
});

test("repair of already-saved workspace/project only refreshes the index and creates no replacement backup", async t => {
  const f = await fixture(t);
  const changed = f.config.prepare(await f.config.load(f.path), { name: "original", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, changed.text);
  const before = await f.service.read(f.path);
  assert.equal(metadataRepairState(before), "ready");
  const preview = await f.service.previewRepair(f.path, before.revision);
  assert.equal(preview.writesConfig, false); assert.equal(preview.rebuildsIndex, true);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "applied"); assert.equal(result.backupPath, null);
  assert.equal(await readFile(f.configPath, "utf8"), changed.text);
});

test("repair preserves effective workspace/project and leaves valid local inheritance intact", async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, ".gortex.yaml"), "workspace: personal\nproject: paseo\n");
  let candidate = f.config.prepare(await f.config.load(f.path), { name: "gortexkit", workspace: "", project: "" });
  await writeFile(f.configPath, candidate.text);
  let before = await f.service.read(f.path);
  let preview = await f.service.previewRepair(f.path, before.revision);
  assert.equal(preview.configured.workspace, ""); assert.equal(preview.configured.project, "");
  assert.equal(preview.effective.workspace, "personal"); assert.equal(preview.effective.project, "paseo");
  await writeFile(join(f.path, ".gortex.yaml"), "# use defaults\n");
  before = await f.service.read(f.path);
  preview = await f.service.previewRepair(f.path, before.revision);
  assert.equal(preview.effective.workspace, before.effective.workspace);
  assert.equal(preview.effective.project, before.effective.project);
  assert.equal(await readFile(f.configPath, "utf8"), candidate.text);
});

test("stale repair and a changed native graph are rejected before any write", async t => {
  const f = await fixture(t);
  const changed = f.config.prepare(await f.config.load(f.path), { name: "gortexkit", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, changed.text);
  const before = await f.service.read(f.path);
  await assert.rejects(() => f.service.previewRepair(f.path, "outdated"), /Configuration changed/);
  const preview = await f.service.previewRepair(f.path, before.revision);
  f.state.daemon = { ...f.state.daemon, name: "different-native-graph" };
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "failed"); assert.match(result.error!, /active graph changed/);
  assert.equal(f.state.reloads, 0); assert.equal(f.state.rebuilds, 0);
  assert.equal(await readFile(f.configPath, "utf8"), changed.text);
});

test("repair rejects unavailable, unsupported and already-matching contexts without native effects", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  await assert.rejects(() => f.service.previewRepair(f.path, before.revision), /already matches/);
  f.state.graphFails = true;
  await assert.rejects(() => f.service.previewRepair(f.path, before.revision), /unavailable/);
  f.state.graphFails = false; f.state.daemon.workspace = "old";
  const load = f.config.load.bind(f.config);
  f.config.load = async path => ({ ...await load(path), canRebuild: false });
  await assert.rejects(() => f.service.previewRepair(f.path, before.revision), /cannot refresh/);
  assert.equal(metadataRepairState(await f.service.read(f.path)), "unsupported");
  assert.equal(f.state.reloads, 0); assert.equal(f.state.rebuilds, 0);
});

test("failed repair refresh remains pending and an explicit retry reuses the saved metadata", async t => {
  const f = await fixture(t);
  const changed = f.config.prepare(await f.config.load(f.path), { name: "gortexkit", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, changed.text);
  const before = await f.service.read(f.path);
  const preview = await f.service.previewRepair(f.path, before.revision);
  const rebuild = f.native.rebuildIndex;
  f.native.rebuildIndex = async () => { f.state.rebuilds++; throw new Error("Refresh acknowledgement lost"); };
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "pending"); assert.equal(result.exclusions, "pending");
  assert.equal(result.configSaved, true); assert.match(result.error!, /acknowledgement lost/);
  assert.equal(f.service.apply(preview.id).id, result.id); assert.equal(f.state.rebuilds, 1);
  f.native.rebuildIndex = rebuild;
  const current = await f.service.read(f.path);
  const retry = await f.service.previewRepair(f.path, current.revision);
  assert.equal(retry.writesConfig, false);
  const done = await completed(f.service, f.service.apply(retry.id).id);
  assert.equal(done.outcome, "applied"); assert.equal(done.backupPath, null);
});

test("exclusion edits preserve other layers, metadata, order and escaping, then refresh the index", async t => {
  const f = await fixture(t);
  const original = f.original + "exclude: [global-cache/]\n";
  const local = "exclude: [local-cache/]\ninclude: [generated/keep.ts]\nrespect_gitignore: false\n";
  await writeFile(f.configPath, original);
  await writeFile(join(f.path, ".gortex.yaml"), local);
  const before = await f.service.read(f.path);
  assert.deepEqual(before.exclusionSources, { global: ["global-cache/"], local: ["local-cache/"], include: ["generated/keep.ts"], legacyIndex: [], legacyWatch: [], respectGitignore: false });
  const patterns = ["generated/**", "!generated/keep.ts", "cache with spaces/", "résultats/", "\\#literal", "generated/**"];
  const preview = await f.service.preview(f.path, before.revision, before.configured, patterns);
  assert.equal(preview.updatesExclusions, true); assert.equal(preview.rebuildsIndex, true);
  assert.equal(await readFile(f.configPath, "utf8"), original);
  const started = f.service.apply(preview.id);
  assert.equal(f.service.apply(preview.id).id, started.id);
  const result = await completed(f.service, started.id);
  assert.equal(result.outcome, "applied"); assert.equal(result.exclusions, "refreshed");
  assert.equal(f.state.rebuilds, 1); assert.equal(f.state.reloads, 1);
  assert.deepEqual(result.result?.extra.exclude, patterns);
  assert.deepEqual(result.result?.configured, before.configured);
  const saved = parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(saved.exclude, ["global-cache/"]); assert.equal(saved.repos[0].ref, "review");
  assert.deepEqual(saved.repos[0].future_field, { enabled: true });
  assert.equal(await readFile(join(f.path, ".gortex.yaml"), "utf8"), local);
  assert.equal(await readFile(result.backupPath!, "utf8"), original);
});

test("clearing repo exclusions keeps inherited rules and an explicit retry can reindex without another save", async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, ".gortex.yaml"), "index:\n  exclude: [legacy/]\nwatch:\n  exclude: [watched/]\n");
  let before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, []);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.exclusions, "refreshed");
  assert.equal(parse(await readFile(f.configPath, "utf8")).repos[0].exclude, undefined);
  assert.deepEqual(result.result?.exclusionSources.legacyIndex, ["legacy/"]);
  assert.deepEqual(result.result?.exclusionSources.legacyWatch, ["watched/"]);
  before = await f.service.read(f.path);
  const retry = await f.service.preview(f.path, before.revision, before.configured, []);
  assert.equal(retry.writesConfig, false); assert.equal(retry.rebuildsIndex, true);
  const refreshed = await completed(f.service, f.service.apply(retry.id).id);
  assert.equal(refreshed.exclusions, "refreshed"); assert.equal(refreshed.backupPath, null);
  assert.equal(f.state.rebuilds, 2);
});

test("a failed exclusion index refresh cannot be reported applied just because metadata agrees", async t => {
  const f = await fixture(t);
  f.native.rebuildIndex = async () => { f.state.rebuilds++; throw new Error("Index response lost"); };
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, ["generated/"]);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.configSaved, true); assert.equal(result.result?.state, "applied");
  assert.equal(result.outcome, "pending"); assert.equal(result.exclusions, "pending");
  assert.match(result.error!, /Index response lost/); assert.equal(f.state.rebuilds, 1);
});

test("a lost reload acknowledgement leaves exclusions pending with no automatic index replay", async t => {
  const f = await fixture(t); f.state.reloadFails = true;
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, ["generated/"]);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "pending"); assert.equal(result.exclusions, "pending");
  assert.equal(f.state.rebuilds, 0); assert.equal(f.state.reloads, 1);
  assert.match(result.error!, /Reload response lost/);
});

test("pending graph rename cannot apply repo-entry exclusions to a different native name", async t => {
  const f = await fixture(t);
  const renamed = f.config.prepare(await f.config.load(f.path), { name: "renamed", workspace: "home", project: "app" });
  await writeFile(f.configPath, renamed.text);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, ["generated/"]);
  assert.equal(preview.rebuildsIndex, false);
  assert.ok(preview.warnings.some(warning => warning.includes("cannot bind")));
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "pending"); assert.equal(result.exclusions, "pending");
  assert.equal(f.state.rebuilds, 0); assert.equal(result.result?.daemon?.name, "original");
});

test("stale exclusion preview is rejected if another client changes an inherited layer", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, ["generated/"]);
  await writeFile(join(f.path, ".gortex.yaml"), "include: [generated/]\n");
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "failed"); assert.equal(result.configSaved, false);
  assert.equal(f.state.reloads, 0); assert.equal(f.state.rebuilds, 0);
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("an external config edit during index refresh invalidates exclusion verification", async t => {
  const f = await fixture(t);
  f.native.rebuildIndex = async () => { f.state.rebuilds++; await writeFile(join(f.path, ".gortex.yaml"), "include: [generated/]\n"); };
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, before.configured, ["generated/"]);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.configSaved, true); assert.equal(result.outcome, "pending"); assert.equal(result.exclusions, "pending");
});

test("exclusion input preserves meaningful duplicate order and literal escapes, and bounds malformed requests", async t => {
  const f = await fixture(t);
  const patterns = parseExclusionLines("generated/**\r\n!generated/keep.ts\r\ngenerated/**\r\n\\#literal\r\n\r\n");
  assert.deepEqual(patterns, ["generated/**", "!generated/keep.ts", "generated/**", "\\#literal"]);
  assert.deepEqual(parseExclusionLines("\n\n"), []);
  assert.throws(() => parseExclusionLines("bad\u0000pattern"));
  assert.throws(() => parseExclusionLines("a".repeat(2049)));
  const snapshot = await f.config.load(f.path);
  for (const invalid of [["ok", ""], ["bad\npattern"], Array(2001).fill("x"), Array(40).fill("a".repeat(2048))]) {
    assert.throws(() => f.config.prepare(snapshot, snapshot.configured, invalid));
  }
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("metadata reports native identity separately and never returns unrelated host settings", async t => {
  const f = await fixture(t);
  const value = await f.service.read(f.path);
  assert.equal(value.state, "applied");
  assert.deepEqual(value.configured, f.state.daemon);
  assert.deepEqual(value.extra, { ref: "review", exclude: ["build/**"], unknownKeys: ["future_field"] });
  assert.ok(!JSON.stringify(value).includes("fixture-value-only"));
  const edited = f.config.prepare(await f.config.load(f.path), { name: "renamed", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, edited.text);
  const pending = await f.service.read(f.path);
  assert.equal(pending.state, "pending");
  assert.equal(pending.effective.name, "renamed");
  assert.equal(pending.daemon?.name, "original");
  assert.equal(f.state.reloads, 0, "reads must not reload or index");
});

test("confirmed workspace move preserves unrelated config and comments, backs up and verifies daemon", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, { name: "original", workspace: "personal", project: "paseo" });
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "preview is read-only");
  assert.equal(preview.rebuildsIndex, true);
  const started = f.service.apply(preview.id);
  const duplicate = f.service.apply(preview.id);
  assert.equal(started.id, duplicate.id);
  const result = await completed(f.service, started.id);
  assert.equal(result.outcome, "applied");
  assert.equal(f.state.reloads, 1); assert.equal(f.state.rebuilds, 1);
  assert.equal(await readFile(result.backupPath!, "utf8"), f.original);
  const saved = await readFile(f.configPath, "utf8");
  assert.ok(saved.includes("# Keep my comments"));
  const raw = parse(saved), old = parse(f.original);
  assert.deepEqual(raw.llm, old.llm); assert.deepEqual(raw.unknown_future, old.unknown_future);
  assert.deepEqual(raw.repos[0].future_field, old.repos[0].future_field);
  assert.deepEqual(raw.repos[0].exclude, ["build/**"]); assert.equal(raw.repos[0].ref, "review");
  assert.equal(f.service.apply(preview.id).id, started.id, "finished jobs are not replayed");
  assert.deepEqual(result.result?.daemon, { name: "original", workspace: "personal", project: "paseo" });
});

test("name change saves config but does not fabricate a live rename or reindex the old identity", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, { name: "gortexkit", workspace: "personal", project: "paseo" });
  assert.equal(preview.rebuildsIndex, false);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "pending"); assert.equal(result.configSaved, true);
  assert.equal(f.state.rebuilds, 0); assert.equal(f.state.reloads, 1);
  assert.equal(result.result?.daemon?.name, "original");
  assert.equal(parse(await readFile(f.configPath, "utf8")).repos[0].name, "gortexkit");
});

test("stale preview rejects an external config edit before any write or reload", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, { ...before.configured, workspace: "new" });
  const external = f.original + "# Another client edited this\n";
  await writeFile(f.configPath, external);
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.outcome, "failed"); assert.match(result.error!, /changed after preview/);
  assert.equal(await readFile(f.configPath, "utf8"), external); assert.equal(f.state.reloads, 0);
  assert.equal((await readdir(f.root)).filter(name => name.endsWith(".bak")).length, 0);
});

test("save followed by lost reload acknowledgement is reconciled without blind retry", async t => {
  const f = await fixture(t); f.state.reloadFails = true;
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, { ...before.configured, workspace: "new" });
  const result = await completed(f.service, f.service.apply(preview.id).id);
  assert.equal(result.configSaved, true); assert.equal(result.outcome, "pending");
  assert.match(result.error!, /Reload response lost/); assert.equal(f.state.rebuilds, 0); assert.equal(f.state.reloads, 1);
  assert.equal(f.service.apply(preview.id).id, result.id); assert.equal(f.state.reloads, 1);
});

test("an offline daemon remains unavailable, never an empty successful graph", async t => {
  const f = await fixture(t); f.state.graphFails = true;
  const value = await f.service.read(f.path);
  assert.equal(value.state, "unavailable"); assert.equal(value.daemon, null); assert.match(value.error!, /offline/);
});

test("unrelated large integers and CRLF are preserved when editing metadata", async t => {
  const f = await fixture(t);
  const original = (f.original + "future_counter: 9007199254740993\n").replaceAll("\n", "\r\n");
  await writeFile(f.configPath, original);
  const snapshot = await f.config.load(f.path);
  const candidate = f.config.prepare(snapshot, { ...snapshot.configured, workspace: "changed" });
  assert.ok(candidate.text.includes("future_counter: 9007199254740993\r\n"));
  const backup = await f.config.save(snapshot, candidate.text);
  assert.equal(await readFile(backup, "utf8"), original);
});

test("clearing overrides inherits local workspace/project and preserves strings", async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, ".gortex.yaml"), 'workspace: source\nproject: "001"\n');
  const before = await f.config.load(f.path);
  const candidate = f.config.prepare(before, { name: "original", workspace: "", project: "" });
  assert.deepEqual(candidate.effective, { name: "original", workspace: "source", project: "001" });
  assert.equal(parse(candidate.text).repos[0].workspace, undefined);
  assert.equal(parse(candidate.text).repos[0].project, undefined);
});

test("invalid YAML, aliases and duplicate keys fail closed without a config write", async t => {
  const f = await fixture(t);
  for (const text of ["repos: [", "repos: []\nrepos: []\n", "repos: &r []\ncopy: *r\n"]) {
    await writeFile(f.configPath, text);
    await assert.rejects(() => f.config.load(f.path));
    assert.equal(await readFile(f.configPath, "utf8"), text);
  }
});

test("duplicate names, forged paths and shell-like field text are rejected", async t => {
  const f = await fixture(t);
  const other = join(f.root, "other"); await mkdir(other);
  const raw = parse(f.original); raw.repos.push({ path: other, name: "taken" });
  await writeFile(f.configPath, stringify(raw));
  const before = await f.config.load(f.path);
  assert.throws(() => f.config.prepare(before, { ...before.configured, name: "taken" }), /already uses/);
  assert.throws(() => f.config.prepare(before, { ...before.configured, workspace: "$(invoke-command)" }), /use letters/);
  await assert.rejects(() => f.service.read(f.root), /not an unambiguous member/);
  if (process.platform === "win32") assert.equal(sameRepositoryPath(f.path, f.path.toUpperCase().replaceAll("\\", "/")), true);
});

test("external edits during reload prevent index refresh, and conflicting submissions are coordinated", async t => {
  const f = await fixture(t);
  let resume!: () => void; f.state.hold = new Promise<void>(resolve => { resume = resolve; });
  const before = await f.service.read(f.path);
  const a = await f.service.preview(f.path, before.revision, { ...before.configured, workspace: "new" });
  const b = await f.service.preview(f.path, before.revision, { ...before.configured, project: "other" });
  const job = f.service.apply(a.id);
  assert.throws(() => f.service.apply(b.id), /in progress/);
  while (!f.state.reloads) await delay(10);
  await writeFile(f.configPath, (await readFile(f.configPath, "utf8")) + "# changed during reload\n");
  resume();
  const result = await completed(f.service, job.id);
  assert.equal(f.state.rebuilds, 0); assert.equal(result.outcome, "pending");
  assert.match(result.error!, /changed while reloading/);
});

test("plugin reload loses preview tokens but can reconcile saved state without repeating writes", async t => {
  const f = await fixture(t);
  const before = await f.service.read(f.path);
  const preview = await f.service.preview(f.path, before.revision, { ...before.configured, name: "renamed" });
  await completed(f.service, f.service.apply(preview.id).id);
  const reloaded = new RepositoryMetadata(f.native, f.config);
  t.after(() => reloaded.close());
  assert.throws(() => reloaded.apply(preview.id), /expired or the plugin reloaded/);
  assert.equal((await reloaded.read(f.path)).state, "pending");
  assert.equal(f.state.reloads, 1);
});

test("catalog separates configured name from native routing and refuses a not-yet-applied workspace", async t => {
  const f = await fixture(t);
  const candidate = f.config.prepare(await f.config.load(f.path), { name: "gortexkit", workspace: "personal", project: "paseo" });
  await writeFile(f.configPath, candidate.text);
  const library = new WorkspaceLibrary({ ...f.native, close: async () => {}, query: async (_path, operation, args) => {
    assert.equal(operation, "search");
    assert.equal(args?.repo, "original", "only the native graph identity is a valid filter");
    assert.equal(args?.workspace, "home");
    return { value: { results: [{ id: "original/index.ts::alpha", name: "alpha", kind: "function", file_path: "original/index.ts", repo_prefix: "original", workspace_id: "home" }] }, meta: {} };
  } });
  t.after(() => library.close());
  const repo = (await library.catalog()).repositories[0];
  assert.equal(repo.state, "resolved"); assert.equal(repo.name, "gortexkit"); assert.equal(repo.graphName, "original");
  assert.equal(repo.workspaceId, "home"); assert.equal(repo.declaredWorkspace, "personal");
  const input = { repositoryPath: f.path, workspaceId: "home", query: "alpha", cursor: null, limit: 10 };
  assert.equal((await library.search(input)).results.length, 1);
  await assert.rejects(() => library.search({ ...input, workspaceId: "personal" }), /changed or is unavailable/);
});
