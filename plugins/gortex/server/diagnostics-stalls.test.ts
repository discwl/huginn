import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GortexDiagnostics, type DiagnosticsCli, type DiagnosticsNative } from "./diagnostics.ts";
import { CheckoutActivity, hostEvidence, type DiagnosticsEvidence } from "./diagnostics-evidence.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import type { NativeAssignment } from "../shared/models.ts";

const NOW = Date.parse("2026-10-20T18:00:00Z");
const LONG_UP = " pid 26804\n socket    C:/Users/test/.gortex/cache/daemon.sock\n uptime    5d23h\n state     ready (warmup 21s)\n sessions  4\n";
const sessions = (rows: string[][]) => `\nMCP sessions:\n│ id │ client │ version │ connected │ cwd │\n${rows.map(row => `│ ${row.join(" │ ")} │`).join("\n")}\n`;
const refusal = "Gortex rejected the request. Gortex said: view_building: automatic checkout discovery is still pending; retry this request: indexer: checkout mutation lane is busy; retry: selected checkout discovery is pending: context deadline exceeded";
const repos = (count: number): NativeAssignment[] => Array.from({ length: count }, (_, i) => ({ repo: `r${i}`, path: `C:/Repos/r${i}`, workspace: "w", project: "p", source: "global" }));
const check = (report: { checks: { id: string; state: string; detail: string; evidence: string | null }[] }, id: string) => report.checks.find(entry => entry.id === id);

function diagnostics(options: { rows?: NativeAssignment[]; status?: string; info?: (path: string) => void; evidence?: Partial<DiagnosticsEvidence> | null } = {}) {
  const rows = options.rows ?? repos(2);
  const cli: DiagnosticsCli = {
    run: async args => {
      const key = args.join(" ");
      if (key === "version") return "gortex v0.64.8+abc";
      if (key === "daemon status") return options.status ?? LONG_UP;
      return JSON.stringify(rows.map(row => ({ name: row.repo, path: row.path, indexed: true, stale: false })));
    },
  };
  const native: DiagnosticsNative = {
    version: async () => "gortex v0.64.8+abc", assignments: async () => rows,
    info: async path => { options.info?.(path); return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "r", path }] }; },
    reloadConfiguration: async () => {}, rebuildIndex: async () => {}, refreshContexts: async () => {},
  };
  const evidence: DiagnosticsEvidence | null = options.evidence === null ? null : { daemonLog: async () => "", crashLog: async () => null, executableChangedAt: async () => null, worktreeChanges: async () => [], ...options.evidence };
  return new GortexDiagnostics(native, new RepositoryAdminLock(), () => {}, cli, { wait: async () => {}, now: () => NOW, evidence });
}

test("once a whole batch of repositories is refused, the rest aren't asked", async () => {
  const asked = new Set<string>();
  const report = await diagnostics({ rows: repos(7), info: path => { asked.add(path); throw new Error(refusal); } }).run();
  assert.deepEqual([...asked].sort(), ["C:/Repos/r0", "C:/Repos/r1", "C:/Repos/r2"]);
  const access = check(report, "repositories")!;
  assert.equal(access.state, "fail");
  assert.match(access.detail, /fails for the first 3 repositories even on quick retries\. It looks stuck rather than busy\. The other 4 repositories weren't asked/);
});

test("a batch where some repositories answer keeps checking the rest", async () => {
  const asked = new Set<string>();
  const report = await diagnostics({ rows: repos(7), info: path => { asked.add(path); if (path === "C:/Repos/r0") throw new Error(refusal); } }).run();
  assert.equal(asked.size, 7);
  assert.match(check(report, "repositories")!.detail, /^1 of 7 did not answer/);
});

test("timeouts in the daemon log are a warning that says who waited", async () => {
  const line = (secondsAgo: number, session: string, outcome = "deadline") => JSON.stringify({ level: "warn", ts: (NOW - secondsAgo * 1000) / 1000, msg: "daemon: mcp request lifetime ended", session_id: session, outcome, deadline: 60, error: "context deadline exceeded" });
  let socket: string | null = null;
  const log = [line(30 * 60, "s1"), "not a JSON line", line(120, "s1"), line(60, "gone"), line(30, "s1", "complete")].join("\n");
  const report = await diagnostics({ status: LONG_UP + sessions([["s1", "claude-code", "", "2h", "C:/Repos/r0"]]), evidence: { daemonLog: async path => { socket = path; return log; } } }).run();
  assert.equal(socket, "C:/Users/test/.gortex/cache/daemon.sock");
  const timeouts = check(report, "timeouts")!;
  assert.equal(timeouts.state, "warn");
  assert.match(timeouts.detail, /^2 requests in the last 15 minutes waited out Gortex's 60-second limit without an answer\./);
  assert.match(timeouts.evidence!, /^1 from claude-code, 1 from a closed session · latest at /);
  assert.equal(report.state, "degraded");
});

test("a quiet log passes, an unreadable one skips the check, and no evidence leaves these checks out", async () => {
  assert.equal(check(await diagnostics().run(), "timeouts")!.state, "pass");
  assert.equal(check(await diagnostics({ evidence: { daemonLog: async () => null } }).run(), "timeouts")!.state, "skipped");
  const without = await diagnostics({ evidence: null }).run();
  assert.equal(without.state, "healthy");
  for (const id of ["timeouts", "worktree-changes", "sessions", "startup", "crashes", "reindexes"]) assert.equal(check(without, id), undefined);
});

test("recent worktree changes are listed, and flagged while Gortex is refusing", async () => {
  const changes = [
    { path: "C:/Worktrees/a", change: "added" as const, at: NOW - 5 * 60_000, source: "paseo" as const },
    { path: "C:/Worktrees/b", change: "removed" as const, at: NOW - 30 * 60_000, source: "git" as const },
  ];
  const calm = check(await diagnostics({ evidence: { worktreeChanges: async () => changes } }).run(), "worktree-changes")!;
  assert.equal(calm.state, "pass");
  assert.equal(calm.detail, "1 worktree was added and 1 removed in the last 2 hours. Gortex discovers each one, and it answered normally afterwards.");
  assert.match(calm.evidence!, /^added \d\d:\d\d C:\/Worktrees\/a \(Paseo\) · removed \d\d:\d\d C:\/Worktrees\/b$/);
  const stuck = check(await diagnostics({ info: () => { throw new Error(refusal); }, evidence: { worktreeChanges: async () => changes } }).run(), "worktree-changes")!;
  assert.equal(stuck.state, "warn");
  assert.match(stuck.detail, /the latest 5 min ago\. Gortex discovers every worktree that's added or removed/);
  assert.equal(check(await diagnostics().run(), "worktree-changes"), undefined, "nothing to list, no check");
});

test("agent chats opened before Gortex was last updated are named; the plugin's own and CLI sessions aren't chats", async () => {
  const status = LONG_UP + sessions([
    ["s1", "claude-code", "", "2h", "C:/Repos/r0"], ["s2", "codex-mcp-client", "0.159.2", "10m", "C:/Repos/r1"],
    ["s3", "paseo-gortex", "0.1.0", "3h", "C:/Repos/r0"], ["s4", "cli", "", "5d1h", ""],
  ]);
  const report = await diagnostics({ status, evidence: { executableChangedAt: async () => NOW - 60 * 60_000 } }).run();
  const chats = check(report, "sessions")!;
  assert.equal(chats.state, "warn");
  assert.match(chats.detail, /^1 agent chat was already open when Gortex was last updated \(.+\)\. They keep the previous Gortex tools until they're restarted/);
  assert.equal(chats.evidence, "claude-code, connected 2h, C:/Repos/r0");
  const fresh = check(await diagnostics({ status, evidence: { executableChangedAt: async () => NOW - 5 * 24 * 3600_000 } }).run(), "sessions")!;
  assert.equal(fresh.state, "pass");
  assert.match(fresh.detail, /^2 agent chats are connected, all opened after Gortex was last updated/);
});

test("Paseo's worktree workspaces are recorded when created and archived; ordinary folders aren't", async () => {
  const root = await mkdtemp(join(tmpdir(), "gortex-activity-"));
  try {
    const worktree = join(root, "wt"), folder = join(root, "plain"), gone = join(root, "gone");
    await mkdir(worktree); await mkdir(folder);
    await writeFile(join(worktree, ".git"), "gitdir: C:/elsewhere/.git/worktrees/wt\n");
    let now = 1000;
    const activity = new CheckoutActivity(() => now);
    await activity.created(worktree); await activity.created(folder);
    now = 2000; await activity.archived(worktree);
    await activity.archived(folder);
    now = 3000; await activity.archived(gone);
    assert.deepEqual(activity.recent(0).map(change => [change.change, change.path, change.at]), [["added", worktree, 1000], ["removed", worktree, 2000], ["removed", gone, 3000]]);
    assert.equal(activity.recent(2500).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git's worktree records name the worktrees added since a time, and the log is read beside the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "gortex-evidence-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    const record = join(repo, ".git", "worktrees", "feature");
    await mkdir(record, { recursive: true });
    await writeFile(join(record, "gitdir"), `${join(root, "feature", ".git")}\n`);
    const evidence = hostEvidence(new CheckoutActivity());
    const changes = await evidence.worktreeChanges([repo], Date.now() - 60_000);
    assert.deepEqual(changes.map(change => [change.change, change.path, change.source]), [["added", join(root, "feature"), "git"]]);
    assert.deepEqual(await evidence.worktreeChanges([repo], Date.now() + 60_000), []);
    // From a linked worktree, whose .git file names its record there; the record's commondir leads to the shared folder.
    const linked = join(root, "feature");
    await mkdir(linked);
    await writeFile(join(linked, ".git"), `gitdir: ${record}\n`);
    await writeFile(join(record, "commondir"), "../..\n");
    assert.deepEqual((await evidence.worktreeChanges([linked], Date.now() - 60_000)).map(change => change.path), [linked]);
    await writeFile(join(root, "daemon.log"), "first\nsecond\n");
    assert.equal(await evidence.daemonLog(join(root, "daemon.sock")), "first\nsecond\n");
    assert.equal(await evidence.daemonLog(join(root, "missing", "daemon.sock")), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
