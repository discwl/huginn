import test from "node:test";
import assert from "node:assert/strict";
import { PluginUpdater, type PluginUpdaterIo } from "./plugin-updater.ts";

function fixture(preview: unknown, options: { runError?: Error; startError?: Error } = {}) {
  const runs: string[][] = [], starts: string[][] = [];
  const io: Partial<PluginUpdaterIo> = {
    run: async args => { runs.push(args); if (options.runError) throw options.runError; return typeof preview === "string" ? preview : JSON.stringify(preview); },
    start: async args => { starts.push(args); if (options.startError) throw options.startError; },
    now: () => new Date("2026-09-19T12:00:00Z"),
  };
  return { updater: new PluginUpdater(io), runs, starts };
}
const available = [{ id: "gortex", outcome: "update", current: { currentRevision: "aaaaaaa1111" }, target: { kind: "git", commit: "bbbbbbb2222" }, links: ["https://github.com/discwl/huginn/compare/a...b", "javascript:alert(1)"] }];

test("an available Git update reports both revisions and only https review links", async () => {
  const f = fixture(available);
  const status = await f.updater.check();
  assert.deepEqual(f.runs, [["plugin", "update", "gortex", "--check", "--json"]]);
  assert.equal(status.state, "update"); assert.equal(status.current, "aaaaaaa1111"); assert.equal(status.target, "bbbbbbb2222");
  assert.deepEqual(status.links, ["https://github.com/discwl/huginn/compare/a...b"]);
});

test("folder installs, up-to-date installs and CLI output prefixed with text are read correctly", async () => {
  assert.equal((await fixture([{ id: "gortex", outcome: "local", links: [] }]).updater.check()).state, "local");
  const current = await fixture(`gortex: up to date\n${JSON.stringify([{ id: "gortex", outcome: "current", current: { currentRevision: "ccc" }, links: [] }])}`).updater.check();
  assert.equal(current.state, "current"); assert.equal(current.current, "ccc");
});

test("a missing CLI, unreadable output, a missing entry and unknown outcomes are errors, not up-to-date", async () => {
  assert.equal((await fixture([], { runError: new Error("The Paseo CLI was not found") }).updater.check()).state, "unavailable");
  assert.equal((await fixture("not json").updater.check()).state, "error");
  assert.equal((await fixture([{ id: "other", outcome: "current" }]).updater.check()).state, "error");
  const unknown = await fixture([{ id: "gortex", outcome: "surprise", links: [] }]).updater.check();
  assert.equal(unknown.state, "error"); assert.match(unknown.error!, /Unknown update outcome/);
});

test("apply rechecks, requires the reviewed target, and starts the update once", async () => {
  const f = fixture(available);
  await assert.rejects(f.updater.apply("someothercommit"), /newer update appeared/);
  assert.equal(f.starts.length, 0);
  assert.deepEqual(await f.updater.apply("bbbbbbb2222"), { started: true });
  assert.deepEqual(f.starts, [["plugin", "update", "gortex", "--yes", "--json"]]);
  await assert.rejects(f.updater.apply("bbbbbbb2222"), /already starting/);
});

test("nothing starts when there is no update, and a failed start can be retried", async () => {
  const current = fixture([{ id: "gortex", outcome: "current", current: { currentRevision: "c" }, links: [] }]);
  await assert.rejects(current.updater.apply("c"), /already up to date/);
  const local = fixture([{ id: "gortex", outcome: "local", links: [] }]);
  await assert.rejects(local.updater.apply("x"), /No update is available \(local\)/);
  assert.equal(current.starts.length + local.starts.length, 0);
  const failing = fixture(available, { startError: new Error("spawn failed") });
  await assert.rejects(failing.updater.apply("bbbbbbb2222"), /spawn failed/);
  await assert.rejects(failing.updater.apply("bbbbbbb2222"), /spawn failed/, "a failed start must not block a retry");
});
