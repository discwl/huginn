import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyRepositoryIndexes, decodeWorktreeFamily, mergeWorktrees, parseGitWorktrees, RepositoryWorktrees } from "./repository-worktrees.ts";
import { runProcess } from "./process-runner.ts";
import { worktreePageSchema } from "../shared/worktree-contracts.ts";

const root = resolve(tmpdir(), "gortex-worktree-fixture"), main = join(root, "main"), feature = join(root, "feature"), common = join(main, ".git");
const commit = "a".repeat(40);
const git = [{ path: main, branch: "refs/heads/main", commit, locked: false, prunable: false }, { path: feature, branch: "refs/heads/feature", commit, locked: false, prunable: false }];
function catalog() { return { families: [{ family_id: "family-1", common_dir: common, primary_graph_id: "graph-1", graphs: [{ graph_id: "graph-1", repo_prefix: "main", state: "ready", served: true, is_primary: true }], checkouts: [
  { checkout_id: "main-id", root_path: main, state: "ready", effective_mode: "dedicated", graph_id: "graph-1", coordinator_live: false },
  { checkout_id: "feature-id", root_path: feature, state: "ready", effective_mode: "automatic", coordinator_live: true, route: { graph_id: "graph-1", state: "active", ready: true } },
] }] }; }

test("Git porcelain parses quoted control characters, UTF-8 octal paths, detached and locked worktrees", () => {
  const path = join(root, "space é\nline").replaceAll("\\", "/");
  const quoted = JSON.stringify(path).replace("é", "\\303\\251");
  const rows = parseGitWorktrees(`worktree ${quoted}\nHEAD ${commit}\ndetached\nlocked user reason\nprunable missing\n\n`);
  assert.equal(rows[0].path, path); assert.equal(rows[0].branch, null); assert.equal(rows[0].locked, true); assert.equal(rows[0].prunable, true);
  assert.throws(() => parseGitWorktrees("worktree relative\nHEAD invalid\n"));
  assert.throws(() => parseGitWorktrees(`worktree ${main}\nHEAD nope\n`));
});

test("ready views use native route/graph evidence, never worker presence alone", () => {
  const source = catalog();
  let rows = mergeWorktrees(git, decodeWorktreeFamily(source, common), true);
  assert.equal(rows[0].status, "ready"); assert.equal(rows[0].primary, true); assert.equal(rows[1].status, "ready");
  source.families[0].checkouts[1].route!.ready = false;
  rows = mergeWorktrees(git, decodeWorktreeFamily(source, common), true);
  assert.equal(rows[1].status, "unknown");
  source.families[0].checkouts[1].route!.state = "building";
  assert.equal(mergeWorktrees(git, decodeWorktreeFamily(source, common), true)[1].status, "building");
  source.families[0].checkouts[1].state = "grace";
  assert.equal(mergeWorktrees(git, decodeWorktreeFamily(source, common), true)[1].status, "unavailable");
});

test("a changed Git HEAD cannot retain a ready badge from an older native observation", () => {
  const source = catalog();
  const native = { ...source.families[0].checkouts[1], head_commit: "b".repeat(40) };
  const family = decodeWorktreeFamily({ families: [{ ...source.families[0], checkouts: [source.families[0].checkouts[0], native] }] }, common);
  const row = mergeWorktrees(git, family, true)[1];
  assert.equal(row.headMismatch, true); assert.equal(row.status, "unknown"); assert.equal(row.commit, commit);
});

test("empty catalog and failed catalog are distinct; stale native-only checkouts remain visible", () => {
  assert.equal(mergeWorktrees(git, null, true)[1].status, "unregistered");
  assert.equal(mergeWorktrees(git, null, false)[1].status, "unknown");
  const source = catalog(); source.families[0].checkouts[1].state = "grace";
  const row = mergeWorktrees(git.slice(0, 1), decodeWorktreeFamily(source, common), true)[1];
  assert.equal(row.gitPresent, false); assert.equal(row.status, "unavailable");
});

test("scope mismatch, malformed, truncated, and duplicate native catalogs fail visibly", () => {
  assert.throws(() => decodeWorktreeFamily(catalog(), join(root, "other", ".git")), /different repository/);
  assert.throws(() => decodeWorktreeFamily({ families: "bad" }, common), /Unsupported/);
  assert.throws(() => decodeWorktreeFamily({ ...catalog(), truncated: true }, common), /incomplete/);
  const duplicate = catalog(); duplicate.families[0].checkouts.push(duplicate.families[0].checkouts[0]);
  assert.throws(() => decodeWorktreeFamily(duplicate, common), /ambiguous/);
  assert.equal(decodeWorktreeFamily({ families: null }, common), null);
});

test("ordinary index evidence remains available when checkout metadata fails and never leaks to sibling worktrees", () => {
  const rows = mergeWorktrees(git, null, false);
  const indexed = applyRepositoryIndexes(rows, [{ path: main, indexed: true, stale: false, indexed_commit: commit, last_indexed: "2026-09-12T00:00:00Z" }]);
  assert.equal(indexed[0].repositoryIndex, "indexed");
  assert.equal(indexed[0].indexedAt, "2026-09-12T00:00:00Z");
  assert.equal(indexed[1].repositoryIndex, null);
  assert.equal(indexed[1].status, "unknown");
  assert.equal(rows[0].repositoryIndex, null);
});

test("stale and missing index evidence is never presented as indexed", () => {
  const rows = mergeWorktrees(git, null, false);
  assert.equal(applyRepositoryIndexes(rows, [{ path: main, indexed: true, stale: true }])[0].repositoryIndex, "stale");
  assert.equal(applyRepositoryIndexes(rows, [{ path: main, indexed: true, stale: false, indexed_commit: "b".repeat(40) }])[0].repositoryIndex, "stale");
  assert.equal(applyRepositoryIndexes(rows, [{ path: main, indexed: false, stale: false }])[0].repositoryIndex, "not-indexed");
  assert.equal(applyRepositoryIndexes(rows, [])[0].repositoryIndex, null);
  assert.throws(() => applyRepositoryIndexes(rows, [{ path: main, indexed: true }]), /Unsupported/);
  assert.throws(() => applyRepositoryIndexes(rows, [{ path: main, indexed: true, stale: false }, { path: main, indexed: true, stale: false }]), /Ambiguous/);
});

test("real Git family is discovered without tracking writes; native errors preserve both rows and host boundaries", async () => {
  const base = await realpath(tmpdir()), temp = await mkdtemp(join(base, "gortex-worktrees-test-"));
  try {
    const repo = join(temp, "repo é"), worktree = join(temp, "feature space");
    await runProcess("git", ["init", "--quiet", repo], temp);
    await runProcess("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture", "--quiet"], repo);
    await runProcess("git", ["worktree", "add", "--quiet", "-b", "feature", worktree], repo);
    let calls = 0;
    const native = { repositoryIndexes: async () => [{ path: repo, indexed: true, stale: false }], assignments: async () => [{ repo: "repo", path: repo, workspace: "different-workspace", project: "repo", source: "global" }], checkoutFamily: async (path: string) => { calls++; assert.equal(path, await realpath(repo)); throw new Error("native checkout discovery pending"); } };
    const service = new RepositoryWorktrees(native);
    const [a, b] = await Promise.all([service.list(repo), service.list(repo)]);
    assert.equal(calls, 1); assert.deepEqual(a, b); worktreePageSchema.parse(a);
    assert.equal(a.total, 2); assert.equal(a.gitError, null); assert.match(a.nativeError!, /discovery pending/);
    assert.ok(a.rows.every(row => row.status === "unknown"));
    assert.ok(a.rows.some(row => row.branch === "refs/heads/feature"));
    const otherHost = new RepositoryWorktrees({ ...native, assignments: async () => [] });
    await assert.rejects(otherHost.list(repo), /no longer tracked/);
    await assert.rejects(service.list(worktree), /no longer tracked/);
  } finally {
    const absolute = resolve(temp);
    assert.equal(dirname(absolute), base); assert.ok(absolute.startsWith(join(base, "gortex-worktrees-test-")));
    await rm(absolute, { recursive: true, force: true });
  }
});
