import test from "node:test";
import assert from "node:assert/strict";
import { GortexDiagnostics, type DiagnosticsCli, type DiagnosticsNative } from "./diagnostics.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import type { NativeAssignment } from "../shared/models.ts";

const READY = " pid 1234\n uptime 5m\n state     ready (warmup 2s)\n sessions  2\n";
const WARMING = " pid 1234\n uptime 3s\n state     warming up (socket reachable, resolving references)\n";
const rows: NativeAssignment[] = [
  { repo: "app", path: "C:/Repos/app", workspace: "w", project: "p", source: "global" },
  { repo: "api", path: "C:/Repos/api", workspace: "w", project: "p", source: "global" },
];
const reposJson = (overrides: Record<string, { indexed?: boolean; stale?: boolean }> = {}) => JSON.stringify(rows.map(row => ({ name: row.repo, path: row.path, indexed: overrides[row.repo]?.indexed ?? true, stale: overrides[row.repo]?.stale ?? false })));

function fixture(options: {
  version?: string | Error; status?: string | Error; repos?: string | Error;
  assignments?: NativeAssignment[] | Error; info?: (path: string) => void;
} = {}) {
  const calls: string[] = [];
  const cli: DiagnosticsCli = {
    run: async args => {
      calls.push(args.join(" "));
      const key = args.join(" ");
      const value = key === "version" ? options.version ?? "gortex v0.64.5+abc\ncommit: abc"
        : key === "daemon status" ? options.status ?? READY
        : key === "repos --json" ? options.repos ?? reposJson()
        : "done";
      if (value instanceof Error) throw value;
      return value;
    },
  };
  const native: DiagnosticsNative = {
    version: async () => "gortex v0.64.5+abc",
    assignments: async () => { if (options.assignments instanceof Error) throw options.assignments; return options.assignments ?? rows; },
    info: async path => { options.info?.(path); return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path }] }; },
    reloadConfiguration: async () => { calls.push("native reload"); },
    rebuildIndex: async path => { calls.push(`native index ${path}`); },
    refreshContexts: async () => {},
  };
  let invalidations = 0;
  return { diagnostics: new GortexDiagnostics(native, new RepositoryAdminLock(), () => { invalidations++; }, cli), calls, invalidations: () => invalidations };
}
const check = (report: { checks: { id: string; state: string; detail: string; evidence: string | null }[] }, id: string) => report.checks.find(entry => entry.id === id)!;

test("a healthy host reports ready with no repairs offered", async () => {
  const f = fixture();
  const report = await f.diagnostics.run();
  assert.equal(report.state, "healthy");
  assert.deepEqual(report.remedies, []);
  assert.equal(check(report, "daemon").state, "pass");
  assert.equal(check(report, "repositories").state, "pass");
  assert.deepEqual(f.calls, ["version", "daemon status", "repos --json"]);
});

test("a missing executable fails immediately without probing further", async () => {
  const f = fixture({ version: new Error("Cannot resolve the configured host executable.") });
  const report = await f.diagnostics.run();
  assert.equal(report.state, "broken");
  assert.equal(check(report, "cli").state, "fail");
  assert.equal(report.checks.length, 1);
  assert.deepEqual(f.calls, ["version"]);
});

test("a stopped daemon offers to start it; a warming daemon only offers a re-check", async () => {
  const stopped = fixture({ status: " state  not running\n" });
  const stoppedReport = await stopped.diagnostics.run();
  assert.equal(check(stoppedReport, "daemon").state, "fail");
  assert.ok(stoppedReport.remedies.some(remedy => remedy.id === "daemon-start"));
  const warming = fixture({ status: WARMING });
  const warmingReport = await warming.diagnostics.run();
  assert.equal(check(warmingReport, "daemon").state, "warn");
  assert.deepEqual(warmingReport.remedies.map(remedy => remedy.id), ["recheck"]);
  assert.ok(warmingReport.remedies.every(remedy => remedy.risk === "safe"));
});

test("an unindexed repository is a problem with a re-index offer; a stale one is a warning", async () => {
  const unindexed = fixture({ repos: reposJson({ api: { indexed: false } }) });
  const report = await unindexed.diagnostics.run();
  assert.equal(check(report, "index").state, "fail");
  assert.match(check(report, "index").detail, /not indexed: api/);
  assert.ok(report.remedies.some(remedy => remedy.id === "reindex:C:/Repos/api" && remedy.risk === "safe"));
  const stale = fixture({ repos: reposJson({ app: { stale: true } }) });
  assert.equal(check(await stale.diagnostics.run(), "index").state, "warn");
});

test("a busy dispatcher is a capacity warning, not a broken host", async () => {
  const f = fixture({ info: () => { throw new Error("MCP error -32002: MCP dispatcher is busy"); } });
  const report = await f.diagnostics.run();
  assert.equal(report.state, "degraded");
  assert.equal(check(report, "repositories").state, "warn");
  assert.match(check(report, "capacity").detail, /as many requests as it allows/);
  assert.deepEqual(report.remedies.map(remedy => remedy.id), ["recheck"]);
});

test("a busy dispatcher names who is connected and the Paseo restart that has cleared it", async () => {
  const status = `${READY}\nMCP sessions:\n│ id │ client │ version │ connected │ cwd │\n│ a1 │ claude-code │ 2.1 │ 3m │ C:\\Repos\\app │\n│ a2 │ claude-code │ 2.1 │ 9m │ C:\\Repos\\api │\n│ a3 │ paseo-gortex │ 0.1.0 │ 1h │ C:\\Repos\\app │\n`;
  const f = fixture({ status, info: () => { throw new Error("MCP error -32002: MCP dispatcher is busy"); } });
  const capacity = check(await f.diagnostics.run(), "capacity");
  assert.match(capacity.detail, /Restarting Paseo/);
  assert.equal(capacity.evidence, "3 connected: 2 claude-code, 1 paseo-gortex");
});

test("stale worktree records are a warning with a prune offer that runs git worktree prune", async () => {
  const gitCalls: string[] = [];
  let pruned = false;
  const diagnostics = new GortexDiagnostics(
    { version: async () => "v", assignments: async () => rows, info: async path => ({ workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path }] }), reloadConfiguration: async () => {}, rebuildIndex: async () => {}, refreshContexts: async () => {} },
    new RepositoryAdminLock(), () => {},
    {
      run: async args => args.join(" ") === "version" ? "gortex v0.64.5" : args.join(" ") === "daemon status" ? READY : reposJson(),
      git: async (args, cwd) => {
        gitCalls.push(`${cwd}: ${args.join(" ")}`);
        if (args[1] === "prune") { pruned = true; return ""; }
        return cwd === "C:/Repos/app" && !pruned ? "worktree C:/Repos/app\n\nworktree C:/gone\nprunable gitdir file points to non-existent location\n" : `worktree ${cwd}\n`;
      },
    },
  );
  const report = await diagnostics.run();
  assert.equal(report.state, "degraded");
  assert.equal(check(report, "worktrees").evidence, "app: 1");
  const remedy = report.remedies.find(entry => entry.id === "prune:C:/Repos/app")!;
  assert.equal(remedy.risk, "safe");
  const job = await diagnostics.repair(report.id, remedy.id);
  assert.equal(job.outcome, "fixed");
  assert.ok(gitCalls.includes("C:/Repos/app: worktree prune"));
  assert.equal(check(job.report!, "worktrees").state, "pass");
});

test("repositories that fail for another reason offer reload and a host-wide restart", async () => {
  const f = fixture({ info: () => { throw new Error("corpus app has no dedicated graph"); } });
  const report = await f.diagnostics.run();
  assert.equal(report.state, "broken");
  assert.match(check(report, "repositories").evidence!, /no dedicated graph/);
  const ids = report.remedies.map(remedy => remedy.id);
  assert.deepEqual(ids, ["daemon-reload", "daemon-restart"]);
  assert.equal(report.remedies.find(remedy => remedy.id === "daemon-restart")!.risk, "host-wide");
});

test("no MCP answer stops the run and offers a restart", async () => {
  const f = fixture({ assignments: new Error("Gortex MCP request failed.") });
  const report = await f.diagnostics.run();
  assert.equal(check(report, "mcp").state, "fail");
  assert.deepEqual(report.remedies.map(remedy => remedy.id), ["daemon-restart"]);
  assert.ok(!report.checks.some(entry => entry.id === "repositories"));
});

test("a repair runs its action, re-checks, and reports the verified outcome", async () => {
  let indexed = false;
  const f = fixture({ repos: "", info: () => {} });
  // First run sees an unindexed repository; the re-check after the repair sees it indexed.
  const stateful = new GortexDiagnostics(
    { version: async () => "v", assignments: async () => rows, info: async () => ({ workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path: "C:/Repos/app" }] }), reloadConfiguration: async () => {}, rebuildIndex: async () => { indexed = true; }, refreshContexts: async () => {} },
    new RepositoryAdminLock(), () => {},
    { run: async args => args.join(" ") === "version" ? "gortex v0.64.5" : args.join(" ") === "daemon status" ? READY : reposJson(indexed ? {} : { api: { indexed: false } }) },
  );
  const report = await stateful.run();
  const remedy = report.remedies.find(entry => entry.id.startsWith("reindex:"))!;
  const job = await stateful.repair(report.id, remedy.id);
  assert.equal(job.outcome, "fixed"); assert.equal(job.stage, "done");
  assert.equal(indexed, true);
  assert.equal(job.report!.state, "healthy");
  await assert.rejects(stateful.repair(report.id, "daemon-restart"), /not offered by this report/);
  await assert.rejects(stateful.repair(crypto.randomUUID(), remedy.id), /report expired/);
  assert.ok(f.calls.length >= 0);
});

test("a failed repair is reported as failed with the native error", async () => {
  const diagnostics = new GortexDiagnostics(
    { version: async () => "v", assignments: async () => rows, info: async () => { throw new Error("corpus app has no dedicated graph"); }, reloadConfiguration: async () => { throw new Error("reload refused"); }, rebuildIndex: async () => {}, refreshContexts: async () => {} },
    new RepositoryAdminLock(), () => {},
    { run: async args => args.join(" ") === "version" ? "gortex v0.64.5" : args.join(" ") === "daemon status" ? READY : reposJson() },
  );
  const report = await diagnostics.run();
  const job = await diagnostics.repair(report.id, "daemon-reload");
  assert.equal(job.outcome, "failed");
  assert.match(job.error!, /reload refused/);
  assert.equal(job.report!.state, "broken");
});
