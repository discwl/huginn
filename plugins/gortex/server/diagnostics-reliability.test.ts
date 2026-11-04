import test from "node:test";
import assert from "node:assert/strict";
import { GortexDiagnostics, type DiagnosticsCli, type DiagnosticsNative, type DiagnosticsOptions } from "./diagnostics.ts";
import type { NativeAssignment } from "../shared/models.ts";

const rows: NativeAssignment[] = Array.from({ length: 8 }, (_, i) => ({ repo: `app${i}`, path: `C:/repos/app${i}`, workspace: "w", project: "p", source: "global" }));
function fixture(options: { assignmentsError?: Error; statusError?: Error; catalog?: string; log?: string; empty?: boolean; busy?: boolean; git?: DiagnosticsCli["git"] } = {}) {
  const calls: string[] = [];
  const selected = options.empty ? [] : rows;
  const native: DiagnosticsNative = {
    version: async () => "v0.64.11",
    assignments: async () => { if (options.assignmentsError) throw options.assignmentsError; return selected; },
    info: async path => {
      calls.push(path);
      if (options.busy && path === rows[0].path) throw new Error("MCP error -32002: MCP dispatcher is busy");
      return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path }] };
    },
    reloadConfiguration: async () => { throw new Error("unexpected mutation"); },
    rebuildIndex: async () => { throw new Error("unexpected mutation"); },
    refreshContexts: async () => {},
  };
  const cli: DiagnosticsCli = {
    run: async args => {
      if (args[0] === "version") return "gortex v0.64.11";
      if (args[0] === "daemon") {
        if (options.statusError) throw options.statusError;
        return " pid 1\n uptime 2h\n state ready (warmup 3s)\n sessions 1\n";
      }
      return options.catalog ?? JSON.stringify(selected.map(row => ({ name: row.repo, path: row.path, indexed: true, stale: false })));
    },
    git: options.git,
  };
  let logsRead = 0;
  const evidence: NonNullable<DiagnosticsOptions["evidence"]> = {
    daemonLog: async () => { logsRead++; return options.log ?? ""; },
    crashLog: async () => null,
    executableChangedAt: async () => null,
    worktreeChanges: async () => [],
  };
  const diagnostics = new GortexDiagnostics(native, undefined, undefined, cli, { evidence, wait: async () => {}, now: () => Date.UTC(2026, 10, 3) });
  return { diagnostics, calls, logsRead: () => logsRead };
}
const check = (report: Awaited<ReturnType<GortexDiagnostics["run"]>>, id: string) => report.checks.find(row => row.id === id)!;

test("failed MCP retains its error and still collects offline evidence without prescribing restart", async () => {
  const f = fixture({ assignmentsError: new Error("request timed out after 60s") });
  const report = await f.diagnostics.run();
  assert.equal(report.state, "broken");
  assert.match(check(report, "mcp").evidence!, /timed out after 60s/);
  assert.equal(f.logsRead(), 1);
  for (const id of ["startup", "timeouts", "crashes", "reindexes"]) assert.ok(check(report, id), id);
  assert.deepEqual(f.calls, []);
  assert.ok(!report.remedies.some(remedy => remedy.id === "daemon-restart"));
});

test("unknown daemon status never offers to start a possibly running process", async () => {
  const report = await fixture({ statusError: new Error("status deadline expired") }).diagnostics.run();
  assert.equal(check(report, "daemon").state, "fail");
  assert.ok(!report.remedies.some(remedy => remedy.id === "daemon-start"));
  assert.ok(report.remedies.some(remedy => remedy.id === "recheck"));
});

test("one busy response stops subsequent probe batches", async () => {
  const f = fixture({ busy: true });
  const report = await f.diagnostics.run();
  assert.equal(f.calls.length, 3);
  assert.equal(check(report, "capacity").state, "warn");
  assert.match(check(report, "capacity").detail, /probes were stopped/);
  assert.ok(!report.remedies.some(remedy => remedy.id === "daemon-restart"));
});

test("failed Git inventory is reported as unknown rather than no stale worktrees", async () => {
  const report = await fixture({ git: async args => { if (args[0] === "worktree") throw new Error("Git timed out"); return ".git"; } }).diagnostics.run();
  assert.equal(check(report, "worktrees").state, "warn");
  assert.match(check(report, "worktrees").detail, /state is unknown/);
  assert.match(check(report, "worktrees").evidence!, /Git timed out/);
  assert.ok(!report.remedies.some(remedy => remedy.id.startsWith("prune:")));
});

test("worktree counts are visible and Git process fan-out stays bounded", async () => {
  let active = 0, maximum = 0;
  const git: NonNullable<DiagnosticsCli["git"]> = async args => {
    if (args[0] !== "worktree") return ".git";
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return Array.from({ length: 17 }, (_, i) => `worktree C:/checkouts/${i}\nHEAD abc\n`).join("\n");
  };
  const report = await fixture({ git }).diagnostics.run();
  assert.equal(check(report, "worktrees").state, "pass");
  assert.match(check(report, "worktrees").detail, /17 checkouts/);
  assert.match(check(report, "worktrees").detail, /do not.*prove a build backlog/);
  assert.equal(maximum, 3);
});

for (const catalog of ["[]", "[null]", "{}", "not json"]) {
  test(`invalid or inconsistent CLI catalog is never reported current: ${catalog}`, async () => {
    const report = await fixture({ catalog }).diagnostics.run();
    assert.equal(check(report, "index").state, "warn");
    assert.match(check(report, "index").detail, /Could not read/);
  });
}

test("contract and watcher evidence stays distinct from responsive repository probes", async () => {
  const report = await fixture({ log: "contract failed: superseded_read_unsettled\nwatch_degraded path=C:/repos/app0\n" }).diagnostics.run();
  assert.equal(check(report, "repositories").state, "pass");
  assert.equal(check(report, "contracts").state, "warn");
  assert.match(check(report, "contracts").evidence!, /superseded_read_unsettled/);
  assert.match(check(report, "contracts").detail, /does not establish whether it is still failing/);
  assert.equal(check(report, "watcher").state, "warn");
  assert.deepEqual(report.remedies, []);
});

test("a quiet log does not certify contract-tool availability", async () => {
  const report = await fixture().diagnostics.run();
  assert.equal(check(report, "contracts").state, "skipped");
  assert.match(check(report, "contracts").detail, /were not tested/);
});

test("an empty tracked catalog does not claim repository access was checked", async () => {
  const report = await fixture({ empty: true }).diagnostics.run();
  assert.equal(check(report, "repositories").state, "skipped");
  assert.match(check(report, "repositories").detail, /was not tested/);
});

for (const assignmentsError of [undefined, new Error("checkout discovery is pending")]) {
  test(`baseline repair failures are reported without extra probes or automatic repairs (MCP unavailable: ${!!assignmentsError})`, async () => {
    const now = Date.UTC(2026, 10, 3);
    const log = [60, 40, 20].map(seconds => JSON.stringify({
      ts: now / 1000 - seconds, msg: "contract stuck repair", repo: "app0", kind: "pending_header", outcome: "failed",
      error: "contract boundary receipt: missing accepted function span app0/src/slice.js::loadOptions",
    })).join("\n");
    const f = fixture({ log, assignmentsError });
    const report = await f.diagnostics.run();
    assert.equal(check(report, "contract-repairs").state, "warn");
    assert.match(check(report, "contract-repairs").detail, /error occurred 3 times/);
    assert.equal(f.logsRead(), 1);
    assert.equal(f.calls.length, assignmentsError ? 0 : rows.length);
    if (!assignmentsError) assert.equal(check(report, "repositories").state, "pass");
    assert.ok(!report.remedies.some(remedy => remedy.id === "daemon-restart" || remedy.id.startsWith("reindex:")));
  });
}
