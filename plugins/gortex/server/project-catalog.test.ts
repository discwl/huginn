import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { decodePaseoProjects } from "../shared/catalog-browser.ts";
import { runProcess } from "./process-runner.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment } from "../shared/models.ts";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectCatalog, type ProjectCatalogOptions } from "./project-catalog.ts";

test("Paseo project decoding preserves host paths, bounds the list and rejects API failures", () => {
  const projects = Array.from({ length: 501 }, (_, i) => ({ projectId: `p-${i}`, projectDisplayName: `Project ${i}`, projectRootPath: `C:\\Code\\Project ${i}` }));
  const result = decodePaseoProjects({ projects });
  assert.equal(result.projects.length, 500); assert.equal(result.partial, true);
  assert.deepEqual(result.projects[0], { id: "p-0", name: "Project 0", path: "C:\\Code\\Project 0" });
  assert.throws(() => decodePaseoProjects({ projects: [], error: "Host offline" }), /unsupported project catalog/);
  assert.throws(() => decodePaseoProjects({ projects: [{ projectId: "broken" }] }), /unsupported project catalog/);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gx-projects-")));
  const indexed = join(root, "indexed"), fresh = join(root, "new café project");
  for (const path of [indexed, fresh]) { await mkdir(path); await runProcess("git", ["init", "-q", path], root); }
  const rows: NativeAssignment[] = [{ path: indexed, repo: "native-name", workspace: "personal", project: "tools", source: "global" }];
  const calls: string[] = [];
  const native: NativePort = {
    assignments: async () => rows, version: async () => "gortex v0.64.3+fixture",
    info: async path => { calls.push(path); return { workspace: "personal", project: "tools", mode: "workspace", members: rows.filter(row => row.path === path).map(row => ({ path: row.path, name: row.repo })) }; },
    query: async () => { throw new Error("Listing projects must not query source or graphs"); }, close: async () => {},
  };
  const library = new WorkspaceLibrary(native);
  const projects = [{ id: "existing", name: "Paseo custom name", path: indexed }, { id: "fresh", name: "LinkedIn automation", path: fresh }];
  return { root, indexed, fresh, rows, calls, native, library, projects, close: async () => { library.close(); await rm(root, { recursive: true, force: true }); } };
}

test("the repository library includes unindexed Paseo projects without inventing native membership", async () => {
  const f = await fixture();
  try {
    const catalog = await f.library.catalog(0, { paseoProjects: f.projects });
    assert.equal(catalog.total, 2);
    const fresh = catalog.repositories.find(row => row.path === f.fresh)!;
    assert.equal(fresh.name, "LinkedIn automation");
    assert.equal(fresh.state, "untracked");
    assert.equal(fresh.origin, "paseo");
    assert.equal(fresh.workspaceId, null);
    assert.equal(fresh.declaredWorkspace, "");
    assert.equal(catalog.repositories.filter(row => row.path === f.indexed).length, 1);
    assert.equal(catalog.repositories.find(row => row.path === f.indexed)!.name, "native-name");
    assert.deepEqual(catalog.workspaces, [{ value: "personal", count: 1 }]);
    assert.deepEqual(f.calls, [f.indexed]);
  } finally { await f.close(); }
});

test("Paseo paths are canonicalized and nested project directories reuse the native Git root", async () => {
  const f = await fixture();
  try {
    const nested = join(f.indexed, "src"); await mkdir(nested);
    const projects = [...f.projects, { id: "nested", name: "Source", path: nested }, { id: "alias", name: "Alias", path: join(f.fresh, ".") }];
    if (process.platform === "win32") projects.push({ id: "case", name: "Case alias", path: f.indexed.toUpperCase() });
    const catalog = await f.library.catalog(0, { paseoProjects: projects });
    assert.equal(catalog.total, 2);
    assert.deepEqual(new Set(catalog.repositories.map(row => row.path)), new Set([f.indexed, f.fresh]));
  } finally { await f.close(); }
});

test("native workspace filters exclude unassigned Paseo projects; query and paging include them", async () => {
  const f = await fixture();
  try {
    const nativeOnly = await f.library.catalog(0, { paseoProjects: f.projects, workspace: "personal" });
    assert.deepEqual(nativeOnly.repositories.map(row => row.path), [f.indexed]);
    f.calls.length = 0;
    const searched = await f.library.catalog(0, { paseoProjects: f.projects, query: "LinkedIn" });
    assert.deepEqual(searched.repositories.map(row => row.path), [f.fresh]);
    assert.deepEqual(f.calls, [], "Only visible tracked rows may open Gortex contexts");
    const page = await f.library.catalog(0, { paseoProjects: f.projects, limit: 1 });
    assert.equal(page.total, 2); assert.equal(page.repositories.length, 1); assert.equal(page.nextOffset, 1);
  } finally { await f.close(); }
});

test("unknown native catalog state is an error, never an unindexed badge", async () => {
  const f = await fixture();
  try {
    f.native.assignments = async () => { throw new Error("Selected host catalog is offline"); };
    await assert.rejects(f.library.catalog(0, { paseoProjects: f.projects }), /offline/);
  } finally { await f.close(); }
});

test("worktrees, plain folders and missing paths cannot offer ordinary dedicated tracking", async () => {
  const f = await fixture();
  try {
    const plain = join(f.root, "plain"), linked = join(f.root, "worktree");
    await mkdir(plain); await mkdir(linked); await writeFile(join(linked, ".git"), "gitdir: missing-fixture-control\n");
    const projects = [plain, linked, join(f.root, "gone")].map((path, i) => ({ id: String(i), name: String(i), path }));
    const catalog = await f.library.catalog(0, { paseoProjects: projects });
    for (const path of projects.map(project => project.path)) assert.notEqual(catalog.repositories.find(row => row.path === path)!.state, "untracked");
    assert.equal(catalog.repositories.find(row => row.path === linked)!.state, "worktree");
    assert.equal(catalog.repositories.find(row => row.path === plain)!.state, "unsupported");
    assert.equal(catalog.repositories.find(row => row.path.endsWith("gone"))!.state, "unavailable");
  } finally { await f.close(); }
});

test("after native tracking, refreshing replaces the Paseo candidate with the authoritative repository", async () => {
  const f = await fixture();
  try {
    await f.library.catalog(0, { paseoProjects: f.projects });
    f.rows.push({ repo: "new-native-name", path: f.fresh, workspace: "new-workspace", project: "new-project", source: "global" });
    const catalog = await f.library.catalog(0, { paseoProjects: f.projects });
    assert.equal(catalog.total, 2);
    assert.equal(catalog.repositories.find(row => row.path === f.fresh)!.name, "new-native-name");
    assert.equal(catalog.repositories.find(row => row.path === f.fresh)!.state, "resolved");
  } finally { await f.close(); }
});

const directoryStat = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
const budgetProjects = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `budget-${i}`, name: `Project ${i}`, path: join(tmpdir(), `gortex-budget-project-${i}`) }));
function pendingValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("an empty Paseo project list preserves native rows without starting filesystem work", async () => {
  let reads = 0;
  const rows: NativeAssignment[] = [{ path: join(tmpdir(), "native-alias"), repo: "native", workspace: "personal", project: "tools", source: "global" }];
  const catalog = new ProjectCatalog({ io: { realpath: async () => { reads++; throw new Error("No discovery expected"); } } });
  const result = await catalog.merge(rows, []);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.candidates.size, 0);
  assert.equal(reads, 0);
});

test("500 slow Git probes share one deadline and cache, retain native rows, and never continue scanning in the background", async () => {
  const projects = budgetProjects(500);
  const rows: NativeAssignment[] = [{ path: join(tmpdir(), "native-budget-row"), repo: "native", workspace: "personal", project: "tools", source: "global" }];
  const releases: Array<() => void> = [];
  let launched = 0, active = 0, maximum = 0, metadataReads = 0;
  const catalog = new ProjectCatalog({ discoveryBudgetMs: 60, io: {
    realpath: async path => { metadataReads++; return path; },
    stat: async () => { metadataReads++; return directoryStat; },
    lstat: async () => { metadataReads++; throw Object.assign(new Error("No root control path"), { code: "ENOENT" }); },
    runProcess: async (_command, _args, cwd, options) => {
      assert.ok(options?.timeoutMs && options.timeoutMs <= 60, "The Git timeout must fit the remaining discovery budget");
      launched++; active++; maximum = Math.max(maximum, active);
      const pending = pendingValue<string>();
      releases.push(() => pending.resolve(cwd + "\n"));
      try { return await pending.promise; } finally { active--; }
    },
  } });
  try {
    const start = performance.now();
    const [result, shared] = await Promise.all([catalog.merge(rows, projects), catalog.merge(rows, projects)]);
    assert.ok(performance.now() - start < 1500, "Discovery must stop at its overall budget, not after 125 probe batches");
    assert.equal(launched, 4, "Concurrent catalog requests must share the pending project probes");
    assert.equal(maximum, 4);
    assert.equal(result.rows[0], rows[0]);
    assert.deepEqual(result.rows.map(row => row.path), [rows[0].path, ...projects.map(project => project.path)]);
    assert.equal(result.candidates.size, 500);
    assert.equal(shared.candidates.size, 500);
    for (const candidate of [...result.candidates.values(), ...shared.candidates.values()]) {
      assert.equal(candidate.state, "unavailable");
      assert.match(candidate.error!, /time budget/);
    }
    // In-flight OS work retains its slots even after the response times out.
    const queued = await catalog.merge([], [{ id: "queued", name: "Queued", path: join(tmpdir(), "gortex-budget-queued") }]);
    assert.equal([...queued.candidates.values()][0].state, "unavailable");
    assert.equal(launched, 4);
    const readsAtDeadline = metadataReads;
    releases.forEach(release => release());
    await delay(20);
    assert.equal(active, 0);
    assert.equal(launched, 4);
    assert.equal(metadataReads, readsAtDeadline, "Late Git results and expired queued work must not start another filesystem step");
  } finally { releases.forEach(release => release()); }
});

test("a cached probe from a newer request cannot extend an older request's deadline", async () => {
  const nativePath = join(tmpdir(), "native-delayed-canonicalization");
  const rows: NativeAssignment[] = [{ path: nativePath, repo: "Native", workspace: "personal", project: "tools", source: "global" }];
  const projects = budgetProjects(1);
  const nativeRead = pendingValue<string>();
  const controlRead = pendingValue<typeof directoryStat>();
  const controlStarted = pendingValue<void>();
  let inspections = 0;
  const catalog = new ProjectCatalog({ discoveryBudgetMs: 180, io: {
    realpath: async path => path === nativePath ? nativeRead.promise : path,
    stat: async () => directoryStat,
    lstat: async () => { inspections++; controlStarted.resolve(); return controlRead.promise; },
  } });
  try {
    const older = catalog.merge(rows, projects);
    await delay(60);
    const newer = catalog.merge([], projects);
    await controlStarted.promise;
    nativeRead.resolve(nativePath);
    const oldResult = await older;
    assert.equal([...oldResult.candidates.values()][0].state, "unavailable");
    controlRead.resolve(directoryStat);
    const newResult = await newer;
    assert.equal([...newResult.candidates.values()][0].state, "untracked", "The newer caller can still finish its shared probe inside its own budget");
    assert.equal(inspections, 1, "Each caller keeps a deadline without duplicating the cached probe");
  } finally { nativeRead.resolve(nativePath); controlRead.resolve(directoryStat); }
});

test("slow native canonicalization is bounded and uncertain aliases stay unavailable", async () => {
  const rows: NativeAssignment[] = Array.from({ length: 6 }, (_, i) => ({ path: join(tmpdir(), `native-alias-${i}`), repo: `Native ${i}`, workspace: "personal", project: "tools", source: "global" }));
  const alias = join(tmpdir(), "canonical-native-alias");
  const pending = pendingValue<string>();
  let canonicalReads = 0, projectReads = 0;
  const catalog = new ProjectCatalog({ discoveryBudgetMs: 40, io: {
    realpath: async () => { canonicalReads++; return pending.promise; },
    stat: async () => { projectReads++; return directoryStat; },
    runProcess: async () => { projectReads++; throw new Error("No project scan may start"); },
  } });
  try {
    const start = performance.now();
    const result = await catalog.merge(rows, [{ id: "known", name: "Known", path: rows[0].path }, { id: "alias", name: "Alias", path: alias }]);
    assert.ok(performance.now() - start < 1500);
    assert.deepEqual(result.rows.slice(0, rows.length), rows);
    assert.equal(result.candidates.size, 1, "Known native paths remain deduplicated even when canonicalization stalls");
    assert.equal([...result.candidates.values()][0].state, "unavailable");
    assert.equal(canonicalReads, 4);
    assert.equal(projectReads, 0);
    pending.resolve(alias);
    await delay(20);
    assert.equal(canonicalReads, 4, "Remaining native paths must not be read after the deadline");
    assert.equal(projectReads, 0);
  } finally { pending.resolve(alias); }
});

for (const stalledRead of ["realpath", "stat", "lstat"] as const) {
  test(`a slow project ${stalledRead} read cannot escape the discovery budget or trigger later work`, async () => {
    const projects = budgetProjects(500);
    const pending = pendingValue<void>();
    let started = 0, completedSteps = 0, gitCalls = 0;
    const io: NonNullable<ProjectCatalogOptions["io"]> = {
      realpath: async path => { if (stalledRead === "realpath") { started++; await pending.promise; } else completedSteps++; return path; },
      stat: async () => { if (stalledRead === "stat") { started++; await pending.promise; } else completedSteps++; return directoryStat; },
      lstat: async () => { if (stalledRead === "lstat") { started++; await pending.promise; } else completedSteps++; return directoryStat; },
      runProcess: async () => { gitCalls++; throw new Error("Unexpected Git scan"); },
    };
    const catalog = new ProjectCatalog({ discoveryBudgetMs: 40, io });
    try {
      const start = performance.now();
      const result = await catalog.merge([], projects);
      assert.ok(performance.now() - start < 1500);
      assert.equal(result.candidates.size, 500);
      assert.ok([...result.candidates.values()].every(candidate => candidate.state === "unavailable"));
      assert.equal(started, 4);
      const stepsAtDeadline = completedSteps;
      pending.resolve();
      await delay(20);
      assert.equal(started, 4);
      assert.equal(completedSteps, stepsAtDeadline, "A late metadata result must not continue the inspection");
      assert.equal(gitCalls, 0);
    } finally { pending.resolve(); }
  });
}
