import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaces, mainRepository, WorkspaceBadges, type BadgePaseo, type BadgeWorkspace } from "./workspace-badges.ts";

/** A main repository, a linked worktree of it elsewhere (as Paseo makes for tasks), and their neighbours. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gortex-badges-")));
  const at = (...parts: string[]) => join(root, ...parts);
  const repository = async (path: string) => mkdir(join(path, ".git"), { recursive: true });
  const worktree = async (path: string, main: string, name: string) => {
    await mkdir(path, { recursive: true });
    await mkdir(join(main, ".git", "worktrees", name), { recursive: true });
    await writeFile(join(path, ".git"), `gitdir: ${join(main, ".git", "worktrees", name).replace(/\\/g, "/")}\n`);
    await writeFile(join(main, ".git", "worktrees", name, "commondir"), "../..\n");
  };
  await repository(at("main")); await mkdir(at("main", "src"), { recursive: true });
  await worktree(at("paseo", "worktrees", "main", "task-1"), at("main"), "task-1");
  await repository(at("other"));
  await worktree(at("paseo", "worktrees", "other", "task-2"), at("other"), "task-2");
  await mkdir(at("plain"), { recursive: true });
  // A submodule's .git file names a gitdir with no commondir: its repository is unknown here.
  await mkdir(at("main", ".git", "modules", "lib"), { recursive: true });
  await mkdir(at("module"), { recursive: true });
  await writeFile(at("module", ".git"), `gitdir: ${at("main", ".git", "modules", "lib").replace(/\\/g, "/")}\n`);
  // A repository that only has a tracked folder inside it.
  await repository(at("mono")); await mkdir(at("mono", "packages", "x"), { recursive: true });
  const workspaces: BadgeWorkspace[] = [
    { id: "main", directory: at("main") }, { id: "main-src", directory: at("main", "src") },
    { id: "task-1", directory: at("paseo", "worktrees", "main", "task-1") },
    { id: "other", directory: at("other") }, { id: "task-2", directory: at("paseo", "worktrees", "other", "task-2") },
    { id: "plain", directory: at("plain") }, { id: "module", directory: at("module") }, { id: "mono", directory: at("mono") },
  ];
  return { root, at, workspaces, tracked: [at("main"), at("mono", "packages", "x")], cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Not indexed goes by the main repository: a task worktree of a tracked repository shows nothing", async () => {
  const f = await fixture();
  try {
    assert.equal(await mainRepository(f.at("paseo", "worktrees", "main", "task-1")), f.at("main"));
    assert.equal(await mainRepository(f.at("plain")), null);
    assert.equal(await mainRepository(f.at("module")), undefined);
    const badges = new WorkspaceBadges({ tracked: async () => f.tracked, paused: () => ({ host: false, repositories: [] }) });
    assert.deepEqual((await badges.read(async () => f.workspaces)).badges, { other: "not-indexed", "task-2": "not-indexed" });
  } finally { await f.cleanup(); }
});

test("Gortex paused shows on covered workspaces while their repository or the host is paused", async () => {
  const f = await fixture();
  try {
    let paused = { host: false, repositories: [f.at("main")] };
    const badges = new WorkspaceBadges({ tracked: async () => f.tracked, paused: () => paused });
    assert.deepEqual((await badges.read(async () => f.workspaces)).badges, { main: "paused", "main-src": "paused", "task-1": "paused", other: "not-indexed", "task-2": "not-indexed" });
    paused = { host: true, repositories: [] };
    assert.deepEqual((await badges.read(async () => f.workspaces)).badges, { main: "paused", "main-src": "paused", "task-1": "paused", other: "not-indexed", "task-2": "not-indexed" });
    paused = { host: false, repositories: [] };
    assert.deepEqual((await badges.read(async () => f.workspaces)).badges, { other: "not-indexed", "task-2": "not-indexed" }, "pauses are read fresh");
  } finally { await f.cleanup(); }
});

test("nothing is shown when Gortex is missing or the workspaces can't be listed", async () => {
  const f = await fixture();
  try {
    const missing = new WorkspaceBadges({ tracked: async () => { throw new Error("spawn gortex ENOENT"); }, paused: () => ({ host: true, repositories: [] }) });
    assert.deepEqual(await missing.read(async () => f.workspaces), { badges: {} });
    const unlisted = new WorkspaceBadges({ tracked: async () => f.tracked, paused: () => ({ host: false, repositories: [] }) });
    assert.deepEqual(await unlisted.read(async () => { throw new Error("Paseo unavailable"); }), { badges: {} });
  } finally { await f.cleanup(); }
});

test("every row shares one survey, taken at most once a minute", async () => {
  const f = await fixture();
  try {
    let clock = 0, surveys = 0, lists = 0;
    const badges = new WorkspaceBadges({ now: () => clock, tracked: async () => { surveys++; return f.tracked; }, paused: () => ({ host: false, repositories: [] }) });
    const list = async () => { lists++; return f.workspaces; };
    await Promise.all([badges.read(list), badges.read(list), badges.read(list)]);
    clock += 59_000;
    await badges.read(list);
    assert.deepEqual([surveys, lists], [1, 1]);
    clock += 1_000;
    await badges.read(list);
    assert.deepEqual([surveys, lists], [2, 2]);
  } finally { await f.cleanup(); }
});

test("the host's workspaces are listed a page at a time", async () => {
  const pages = [
    { entries: [{ id: "a", projectRootPath: "C:/repo", workspaceDirectory: "C:/repo-wt" }], pageInfo: { nextCursor: "next", hasMore: true } },
    { entries: [{ id: "b", projectRootPath: "C:/plain" }], pageInfo: { nextCursor: null, hasMore: false } },
  ];
  const cursors: (string | undefined)[] = [];
  const paseo: BadgePaseo = { workspaces: { list: async options => { cursors.push(options?.page?.cursor); return pages[cursors.length - 1]; } } };
  assert.deepEqual(await listWorkspaces(paseo), [{ id: "a", directory: "C:/repo-wt" }, { id: "b", directory: "C:/plain" }]);
  assert.deepEqual(cursors, [undefined, "next"]);
});
