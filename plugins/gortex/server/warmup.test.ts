import test from "node:test";
import assert from "node:assert/strict";
import { parseDaemonStatus } from "./daemon-status.ts";
import { describeWarmup, fullIndexes, lastCrash, readWarmupSummary, readySeconds, triggerLabel, warmupState, warmupTimeline } from "./warmup.ts";
import { isStarting } from "./gortex-client.ts";
import { installTime } from "./diagnostics-evidence.ts";

const T0 = Date.parse("2026-10-23T18:00:00Z");
const at = (secondsAfter: number) => (T0 + secondsAfter * 1000) / 1000;
const line = (fields: Record<string, unknown>) => JSON.stringify({ level: "info", ...fields });

/** `gortex daemon status` as 0.64.9 prints it while warming up: the state column appears because a repository is loading. */
const warmingStatus = [
  " daemon    v0.64.9+abc",
  " pid       27228",
  " socket    C:/Users/test/.gortex/cache/daemon.sock",
  " uptime    1m5s",
  " state     warming up (socket reachable, resolving references)",
  " sessions  2",
  "",
  "tracked repos:",
  "┌──────────┬───────────┬─────────┬──────────┬──────────────┐",
  "│ repo     │ workspace │ state   │ total    │ path         │",
  "├──────────┼───────────┼─────────┼──────────┼──────────────┤",
  "│ app      │ app       │ loading │ 1.0 MiB  │ C:/Repos/app │",
  "│ api      │ api       │ ok      │ 2.0 MiB  │ C:/Repos/api │",
  "├──────────┼───────────┼─────────┼──────────┼──────────────┤",
  "│ other    │           │         │ 15.9 MiB │ embedder + runtime + caches (not attributed) │",
  "└──────────┴───────────┴─────────┴──────────┴──────────────┘",
  "",
  "MCP sessions:",
  "│ id │ client │ version │ connected │ cwd │",
  "│ s1 │ claude-code │  │ 2h │ C:/Repos/app │",
].join("\n");

test("the tracked repos table is read by its headers, with or without Gortex's state column", () => {
  const status = parseDaemonStatus(warmingStatus);
  assert.deepEqual(status.repos, [{ name: "app", path: "C:/Repos/app", state: "loading" }, { name: "api", path: "C:/Repos/api", state: "ok" }]);
  assert.equal(status.sessions.length, 1, "the sessions table is still read on its own");
  const healthy = warmingStatus.replace(/│ state   /g, "").replace(/│ loading /, "").replace(/│ ok      /, "").replace(/warming up \(socket reachable, resolving references\)/, "ready (warmup 34s)");
  assert.deepEqual(parseDaemonStatus(healthy).repos.map(repo => [repo.name, repo.state]), [["app", null], ["api", null]]);
  assert.deepEqual(parseDaemonStatus(" pid 1\n state ready\n").repos, []);
});

test("a daemon is starting while warming up, within five minutes of its start, or while a repository is loading", () => {
  assert.equal(isStarting(parseDaemonStatus(warmingStatus)), true);
  const ready = (uptime: string, loading = false) => parseDaemonStatus(` pid 1\n uptime ${uptime}\n state ready (warmup 3s)\ntracked repos:\n│ repo │ state │ path │\n│ app │ ${loading ? "loading" : "ok"} │ C:/Repos/app │\n`);
  assert.equal(isStarting(ready("2m")), true);
  assert.equal(isStarting(ready("2h")), false);
  assert.equal(isStarting(ready("2h", true)), true, "a slow startup that is still loading is still a startup");
});

test("the latest startup's steps come from the log, with the step still running", () => {
  const log = [
    line({ ts: at(-3600), msg: "daemon: warmup step start", step: "prelude" }),
    line({ ts: at(-3590), msg: "daemon: warmup step complete", step: "prelude", elapsed: 10 }),
    line({ ts: at(0), msg: "daemon: warmup step start", step: "prelude" }),
    "not JSON",
    line({ ts: at(6.2), msg: "daemon: warmup step complete", step: "prelude", elapsed: 6.2 }),
    line({ ts: at(6.3), msg: "daemon: warmup step start", step: "checkout_catalog_seed", repos: 5 }),
  ].join("\n");
  const timeline = warmupTimeline(log)!;
  assert.equal(timeline.startedAt, T0);
  assert.deepEqual(timeline.steps.map(step => [step.step, step.seconds]), [["prelude", 6.2], ["checkout_catalog_seed", null]]);
  assert.equal(timeline.running?.step, "checkout_catalog_seed");
  assert.equal(warmupTimeline(line({ ts: at(0), msg: "daemon: warmup step start", step: "watcher_start" })), null, "no prelude, no startup to describe");
  const state = warmupState(warmingStatus, log);
  assert.equal(describeWarmup(state, T0 + 48_300), "Starting: 1 of 2 repositories loaded · step: checkout catalog seed (running 42 s)");
  assert.equal(describeWarmup(warmupState(warmingStatus.replace("warming up (socket reachable, resolving references)", "ready (warmup 34s)").replace("│ loading │", "│ ok      │"), log), T0), null);
});

test("Host health's startup line reads daemon status first, then the log beside its socket", async () => {
  const sockets: (string | null)[] = [];
  const summary = await readWarmupSummary({ status: async () => warmingStatus, log: async socket => { sockets.push(socket); return null; } }, () => T0);
  assert.equal(summary, "Starting: 1 of 2 repositories loaded");
  assert.deepEqual(sockets, ["C:/Users/test/.gortex/cache/daemon.sock"]);
});

test("a daemon that answers queries is ready, even while enrichment runs or indexing is degraded", () => {
  for (const state of ["ready (warmup 34s)", "ready — queryable (warmup 34s); enrichment 40%", "degraded — 2 failed files (0 unreadable); queryable"]) {
    assert.equal(parseDaemonStatus(` pid 1\n state     ${state}\n`).ready, true, state);
  }
  assert.equal(parseDaemonStatus(" pid 1\n state     warming up (socket reachable, resolving references)\n").ready, false);
});

test("an executable's install time is when it was created here, never its archive time from the future", () => {
  const now = Date.parse("2026-10-23T16:02:05Z");
  // Seen on 2026-10-23: created at 08:17, but modified "12:20", the release archive's time.
  assert.equal(installTime({ birthtimeMs: Date.parse("2026-10-23T15:17:12Z"), ctimeMs: Date.parse("2026-10-23T15:17:11Z") }, now), Date.parse("2026-10-23T15:17:12Z"));
  assert.equal(installTime({ birthtimeMs: 0, ctimeMs: Date.parse("2026-10-23T15:17:11Z") }, now), Date.parse("2026-10-23T15:17:11Z"));
  assert.equal(installTime({ birthtimeMs: now + 3600_000, ctimeMs: 0 }, now), now);
});

test("ready time comes from the state line", () => {
  assert.equal(readySeconds("ready (warmup 34s)"), 34);
  assert.equal(readySeconds("ready — queryable (warmup 2m5s); enrichment 40%"), 125);
  assert.equal(readySeconds("ready (warmup 1m12.5s)"), 72);
  assert.equal(readySeconds("ready"), null);
  assert.equal(readySeconds(null), null);
});

test("full reindexes since a time are read with their repository and trigger", () => {
  const log = [
    line({ ts: at(-7200), msg: "indexer: full index started", repo: "old", origin: "index_repo" }),
    line({ ts: at(-60), msg: "indexer: full index started", repo: "development-flow", first_index: false, origin: "checkout_coordinator" }),
    line({ ts: at(-30), msg: "indexer: full index started", origin: "mystery" }),
  ].join("\n");
  assert.deepEqual(fullIndexes(log, T0 - 3600_000).map(entry => [entry.repo, entry.origin]), [["development-flow", "checkout_coordinator"], ["a repository", "mystery"]]);
  assert.match(triggerLabel("checkout_coordinator"), /after a checkout changed/);
  assert.equal(triggerLabel("mystery"), "for an unrecorded reason");
});

test("a crash is found by its stack dump, timed by the log line before it, with when logging resumed", () => {
  const log = [
    line({ ts: at(-120), msg: "daemon: swept dead session" }),
    "fatal error: concurrent map writes",
    "",
    "goroutine 12 [running]:",
    "runtime.throw(...)",
    "\tC:/hostedtoolcache/go/src/runtime/panic.go:1101 +0x4b",
    line({ ts: at(60), msg: "daemon: file-descriptor cap" }),
  ].join("\n");
  assert.deepEqual(lastCrash(log, null), { at: T0 - 120_000, summary: "fatal error: concurrent map writes", restartedAt: T0 + 60_000 });
  // A dump whose first line was cut off, as on 10-03, still counts; the stderr log has no JSON, so it uses the file's time.
  assert.deepEqual(lastCrash("?)\n\tC:/go/src/runtime/proc.go:474 +0xca\ncreated by runtime.gcBgMarkStartWorkers in goroutine 1\n", T0), { at: T0, summary: "a stack dump", restartedAt: null });
  assert.equal(lastCrash([line({ ts: at(0), msg: "ok" }), "plain output", "[gortex daemon] detached (pid 1)"].join("\n"), T0), null);
});
