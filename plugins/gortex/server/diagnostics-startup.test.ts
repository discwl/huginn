import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GortexDiagnostics, type DiagnosticsCli, type DiagnosticsNative } from "./diagnostics.ts";
import type { DiagnosticsEvidence } from "./diagnostics-evidence.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { readHostHealth } from "./host-health.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment } from "../shared/models.ts";

const NOW = Date.parse("2026-10-23T18:00:00Z");
const at = (secondsAgo: number) => (NOW - secondsAgo * 1000) / 1000;
const line = (fields: Record<string, unknown>) => JSON.stringify({ level: "info", ...fields });
const refusal = "Gortex rejected the request. Gortex said: view_building: automatic checkout discovery is still pending; retry this request: indexer: checkout mutation lane is busy";
const rows: NativeAssignment[] = [{ repo: "app", path: "C:/Repos/app", workspace: "w", project: "p", source: "global" }, { repo: "api", path: "C:/Repos/api", workspace: "w", project: "p", source: "global" }];
const repoTable = (states: string[]) => `\ntracked repos:\n│ repo │ workspace │ state │ total │ path │\n${rows.map((row, index) => `│ ${row.repo} │ w │ ${states[index]} │ 1 MiB │ ${row.path} │`).join("\n")}\n`;
const READY = " pid 1\n socket    C:/Users/test/.gortex/cache/daemon.sock\n uptime    3h\n state     ready (warmup 34s)\n sessions  1\n";
const check = (report: { checks: { id: string; state: string; detail: string; evidence: string | null }[] }, id: string) => report.checks.find(entry => entry.id === id);

function diagnostics(options: { version?: string; status?: string; log?: string | null; crash?: { text: string; writtenAt: number } | null; info?: () => void } = {}) {
  const cli: DiagnosticsCli = {
    run: async args => {
      const key = args.join(" ");
      if (key === "version") return options.version ?? "gortex v0.64.9+abc";
      if (key === "daemon status") return options.status ?? READY;
      return JSON.stringify(rows.map(row => ({ name: row.repo, path: row.path, indexed: true, stale: false })));
    },
  };
  const native: DiagnosticsNative = {
    version: async () => "gortex v0.64.9+abc", assignments: async () => rows,
    info: async path => { options.info?.(); return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "r", path }] }; },
    reloadConfiguration: async () => {}, rebuildIndex: async () => {}, refreshContexts: async () => {},
  };
  const evidence: DiagnosticsEvidence = {
    daemonLog: async () => options.log === undefined ? "" : options.log,
    crashLog: async () => options.crash ?? null,
    executableChangedAt: async () => null, worktreeChanges: async () => [],
  };
  return new GortexDiagnostics(native, new RepositoryAdminLock(), () => {}, cli, { wait: async () => {}, now: () => NOW, evidence });
}

test("a startup still loading repositories is described, with its current step, and is never called stuck", async () => {
  const status = " pid 1\n socket    C:/Users/test/.gortex/cache/daemon.sock\n uptime    8m\n state     warming up (socket reachable, resolving references)\n sessions  1\n" + repoTable(["loading", "ok"]);
  const log = [
    line({ ts: at(480), msg: "daemon: warmup step start", step: "prelude" }),
    line({ ts: at(474), msg: "daemon: warmup step complete", step: "prelude", elapsed: 6 }),
    line({ ts: at(42), msg: "daemon: warmup step start", step: "checkout_catalog_seed" }),
  ].join("\n");
  const report = await diagnostics({ status, log, info: () => { throw new Error(refusal); } }).run();
  const startup = check(report, "startup")!;
  assert.equal(startup.state, "warn");
  assert.match(startup.detail, /^Gortex started 8 min ago and is still loading 1 of 2 repositories \(app\)\. Current step: checkout catalog seed, running for 42 s\./);
  assert.match(startup.evidence!, /prelude 6\.0 s · checkout catalog seed running/);
  // Eight minutes in and every repository refused, but it's still loading: a wait, not a restart.
  assert.notEqual(check(report, "repositories")!.state, "fail");
  assert.ok(!report.remedies.some(remedy => remedy.id === "daemon-restart"));
});

test("after startup, how long it took and its slowest steps; a long one is a warning", async () => {
  const log = [
    line({ ts: at(3600), msg: "daemon: warmup step start", step: "prelude" }),
    line({ ts: at(3594), msg: "daemon: warmup step complete", step: "prelude", elapsed: 6 }),
    line({ ts: at(3593), msg: "daemon: warmup step start", step: "resolve_compute" }),
    line({ ts: at(3573), msg: "daemon: warmup step complete", step: "resolve_compute", elapsed: 20 }),
    line({ ts: at(3573), msg: "daemon: warmup step start", step: "watcher_start" }),
    line({ ts: at(3572.8), msg: "daemon: warmup step complete", step: "watcher_start", elapsed: 0.2 }),
  ].join("\n");
  const quick = check(await diagnostics({ log }).run(), "startup")!;
  assert.equal(quick.state, "pass");
  assert.equal(quick.detail, "The last startup took 34 s. The longest parts were resolve compute (20 s), prelude (6 s).");
  const slow = check(await diagnostics({ status: READY.replace("warmup 34s", "warmup 7m12s"), log }).run(), "startup")!;
  assert.equal(slow.state, "warn");
  assert.match(slow.detail, /^The last startup took 7 min\. The longest parts were .* A startup this long delays every agent's first Gortex requests/);
});

test("a startup as Gortex 0.64.9 logs it: phases, the slowest repository, and when it answered queries", async () => {
  // From a real 0.64.9 startup: checkout_catalog_seed runs before prelude, and most of the time is in phases.
  const log = [
    line({ ts: at(600), msg: "daemon: warmup starting" }),
    line({ ts: at(600), msg: "daemon: warmup step start", step: "checkout_catalog_seed" }),
    line({ ts: at(599.2), msg: "daemon: warmup step complete", step: "checkout_catalog_seed", elapsed: 0.75 }),
    line({ ts: at(598.4), msg: "daemon: warmup phase start", phase: "parallel_parse", repos: 5 }),
    line({ ts: at(589.8), msg: "daemon: warmup repo elapsed", path: "C:\\Code\\development-flow", elapsed: 8.57 }),
    line({ ts: at(589.8), msg: "daemon: warmup repo elapsed", path: "C:\\Code\\small", elapsed: 0.4 }),
    line({ ts: at(589.8), msg: "daemon: warmup phase done", phase: "parallel_parse", elapsed: 8.58 }),
    line({ ts: at(589.1), msg: "daemon: graph queryable", warmup: 10.9 }),
    line({ ts: at(589.1), msg: "daemon: warmup phase start", phase: "deferred_passes_all", pending_repos: 3 }),
    line({ ts: at(583.7), msg: "daemon: warmup phase done", phase: "deferred_passes_all", elapsed: 5.4 }),
    line({ ts: at(582.6), msg: "daemon: enrichment complete", warmup: 17.36 }),
  ].join("\n");
  const startup = check(await diagnostics({ status: READY.replace("warmup 34s", "warmup 17s"), log }).run(), "startup")!;
  assert.equal(startup.state, "pass");
  assert.equal(startup.detail, "The last startup took 17 s, and Gortex answered queries after 11 s. The longest parts were parallel parse (9 s), deferred passes all (5 s); development-flow took longest to load (9 s).");
  assert.match(startup.evidence!, /^checkout catalog seed 0\.8 s · parallel parse 8\.6 s · deferred passes all 5\.4 s$/);
});

test("a crash in the last day is a warning; older ones and clean logs pass; unreadable logs skip the check", async () => {
  const dump = "fatal error: concurrent map writes\n\ngoroutine 12 [running]:\n\tC:/go/src/runtime/panic.go:1101 +0x4b\n";
  const recent = check(await diagnostics({ crash: { text: dump, writtenAt: NOW - 2 * 3600_000 } }).run(), "crashes")!;
  assert.equal(recent.state, "warn");
  assert.match(recent.detail, /^Gortex crashed or wrote a stack dump 2 h ago \(fatal error: concurrent map writes\)\./);
  assert.equal(check(await diagnostics({ crash: { text: dump, writtenAt: NOW - 3 * 24 * 3600_000 } }).run(), "crashes")!.state, "pass");
  // Gortex 0.64.8 and earlier wrote dumps into the daemon log itself.
  const inLog = [line({ ts: at(600), msg: "daemon: swept dead session" }), "\tC:/go/src/runtime/proc.go:474 +0xca", line({ ts: at(420), msg: "daemon: file-descriptor cap" })].join("\n");
  const old = check(await diagnostics({ log: inLog }).run(), "crashes")!;
  assert.equal(old.state, "warn");
  assert.match(old.detail, /\(a stack dump\)\. Gortex was logging again 3 min later\./);
  assert.equal(check(await diagnostics({ log: null }).run(), "crashes")!.state, "skipped");
});

test("full reindexes in the last hour are named with their trigger; repeats are a warning", async () => {
  const reindex = (secondsAgo: number, repo: string, origin: string) => line({ ts: at(secondsAgo), msg: "indexer: full index started", repo, origin });
  const busy = check(await diagnostics({ log: [reindex(3000, "app", "daemon_warmup"), reindex(1200, "app", "checkout_coordinator"), reindex(600, "app", "checkout_coordinator"), reindex(300, "api", "index_repo"), reindex(7200, "api", "index_repo")].join("\n") }).run(), "reindexes")!;
  assert.equal(busy.state, "warn");
  assert.equal(busy.detail, "Gortex rebuilt a repository's whole index 3 times in the last hour (plus 1 rebuild at startup): app twice after a checkout changed (a branch switch, or a worktree added or removed); api once because a reindex was requested. Each rebuild uses CPU for a while, and requests can wait or be refused meanwhile.");
  const startupOnly = check(await diagnostics({ log: [reindex(3000, "app", "daemon_warmup"), reindex(2990, "api", "daemon_warmup")].join("\n") }).run(), "reindexes")!;
  assert.equal(startupOnly.state, "pass");
  assert.equal(startupOnly.detail, "2 repository indexes were rebuilt at startup in the last hour, and none since.");
  assert.equal(check(await diagnostics().run(), "reindexes")!.detail, "No repository's whole index was rebuilt in the last hour.");
  assert.equal(check(await diagnostics({ version: "gortex v0.64.8+abc" }).run(), "reindexes")!.state, "skipped", "older Gortex doesn't log this");
});

test("while Gortex starts, the library shows loading and refused repositories as Loading, asking each at most once", async () => {
  const asked: { path: string; single?: boolean }[] = [];
  const refused = tmpdir();
  const native: NativePort = {
    assignments: async () => [
      { repo: "loading", path: "C:/Repos/loading", workspace: "w", project: "p", source: "global" },
      { repo: "here", path: process.cwd(), workspace: "w", project: "p", source: "global" },
      { repo: "refused", path: refused, workspace: "w", project: "p", source: "global" },
    ],
    startup: async () => ({ starting: true, loading: ["C:/Repos/loading"] }),
    version: async () => "gortex v0.64.9+fixture", close: async () => {},
    info: async (path, options) => {
      asked.push({ path, single: options?.single });
      if (path === await realpath(refused)) throw new Error(refusal);
      return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "here", path: process.cwd() }] };
    },
    query: async () => { throw new Error("No graph query expected"); },
  };
  const library = new WorkspaceLibrary(native);
  try {
    const catalog = await library.catalog();
    const state = (name: string) => catalog.repositories.find(repo => repo.name === name)!;
    assert.equal(state("loading").state, "loading");
    assert.match(state("loading").error!, /still loading this repository after starting/);
    assert.equal(state("here").state, "resolved");
    assert.equal(state("refused").state, "loading", "refused while starting reads as loading, not unavailable");
    assert.equal(asked.length, 2, "the loading repository wasn't asked about");
    assert.ok(asked.every(entry => entry.single === true), "one try each while starting");
  } finally { library.close(); }
});

test("a startup that answers queries but is still enriching says so instead of a finished time", async () => {
  const status = READY.replace("ready (warmup 34s)", "ready — queryable (warmup 4s); enriching 2/5 repos");
  const startup = check(await diagnostics({ status }).run(), "startup")!;
  assert.equal(startup.state, "pass");
  assert.equal(startup.detail, "Gortex has answered queries since 4 s after starting, and is still finishing its startup (enriching 2/5 repos).");
});

test("Host health adds the startup line only while Gortex isn't ready", async () => {
  let reads = 0;
  const warmup = async () => { reads++; return "Starting: 1 of 2 repositories loaded"; };
  const health = (ready: boolean) => ({ assignments: async () => [{ path: "C:/a" }], daemonHealth: async () => ({ ready } as never) });
  assert.equal((await readHostHealth(health(false), { warmup })).warmup, "Starting: 1 of 2 repositories loaded");
  assert.equal((await readHostHealth(health(true), { warmup })).warmup, null);
  assert.equal(reads, 1, "a ready host doesn't read daemon status for it");
});
