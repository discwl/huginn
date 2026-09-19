import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitInitializer } from "./git-init.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gx-git-init-")));
  let invalidations = 0;
  const service = new GitInitializer(() => { invalidations++; });
  return { root, service, invalidations: () => invalidations, close: () => rm(root, { recursive: true, force: true }) };
}

test("a plain folder reports plain and initializes an empty repository without committing", async () => {
  const f = await fixture();
  try {
    const folder = join(f.root, "notes café");
    await mkdir(folder);
    const before = await f.service.status(folder);
    assert.equal(before.state, "plain"); assert.equal(before.canInitialize, true);
    const after = await f.service.initialize(folder);
    assert.equal(after.state, "repository");
    assert.ok((await stat(join(folder, ".git"))).isDirectory());
    assert.equal(f.invalidations(), 1);
  } finally { await f.close(); }
});

test("repositories, subfolders and worktrees are never initialized", async () => {
  const f = await fixture();
  try {
    const repo = join(f.root, "repo"), nested = join(repo, "src");
    await mkdir(join(repo, ".git"), { recursive: true }); await mkdir(nested);
    assert.equal((await f.service.status(repo)).state, "repository");
    const inside = await f.service.status(nested);
    assert.equal(inside.state, "inside"); assert.equal(inside.canInitialize, false);
    await assert.rejects(f.service.initialize(nested), /inside the Git repository/);
    await assert.rejects(f.service.initialize(repo), /already uses Git/);
  } finally { await f.close(); }
});

test("home folders, drive roots, relative and missing paths are refused", async () => {
  const f = await fixture();
  try {
    const home = join(f.root, "home");
    await mkdir(home);
    const service = new GitInitializer(() => {}, { home: () => home });
    const status = await service.status(home);
    assert.equal(status.state, "plain"); assert.equal(status.canInitialize, false);
    await assert.rejects(service.initialize(home), /home folder or drive root/);
    await assert.rejects(service.status("relative/path"), /absolute/);
    assert.equal((await service.status(join(f.root, "missing"))).state, "unavailable");
  } finally { await f.close(); }
});

test("a missing Git executable is reported without creating anything", async () => {
  const f = await fixture();
  try {
    const folder = join(f.root, "plain");
    await mkdir(folder);
    const runs: string[][] = [];
    const service = new GitInitializer(() => {}, { run: async args => { runs.push(args); throw new Error("spawn git ENOENT"); } });
    await assert.rejects(service.initialize(folder), /Git is not installed/);
    assert.deepEqual(runs, [["--version"]]);
    assert.equal((await service.status(folder)).state, "plain");
  } finally { await f.close(); }
});
