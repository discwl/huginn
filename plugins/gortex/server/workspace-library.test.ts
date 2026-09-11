import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { runProcess } from "./process-runner.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment, NativeInfo } from "../shared/models.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gortex-context-"));
  const a = join(root, "a café"); const b = join(root, "b");
  await mkdir(a); await mkdir(b);
  const paths = [await realpath(a), await realpath(b)];
  const rows: NativeAssignment[] = paths.map((path, i) => ({ repo: `repo-${i}`, path, workspace: `(default: repo-${i})`, project: `(default: repo-${i})`, source: "default" }));
  let queryCount = 0;
  let reply: unknown = { results: [] };
  const native: NativePort = {
    assignments: async () => rows,
    version: async () => "gortex v0.64.2+fixture",
    info: async cwd => ({ workspace: cwd === paths[0] ? "workspace-a" : "workspace-b", project: "project", mode: "workspace", members: rows.filter(row => row.path === cwd).map(row => ({ name: row.repo, path: row.path })) }),
    query: async () => { queryCount++; return { value: reply, meta: { fixture: true } }; },
    close: async () => {},
  };
  return { root, paths, rows, native, library: new WorkspaceLibrary(native), queryCount: () => queryCount, setReply: (value: unknown) => { reply = value; } };
}

test("catalog identities come from verified native context, never default display wrappers", async () => {
  const f = await fixture();
  try {
    const catalog = await f.library.catalog();
    assert.deepEqual(catalog.repositories.map(repo => repo.workspaceId), ["workspace-a", "workspace-b"]);
    assert.equal(catalog.repositories[0].declaredWorkspace, "(default: repo-0)");
    assert.equal(catalog.administration.available, false);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("forged workspace selection is rejected before native search", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.library.search({ repositoryPath: f.paths[0], workspaceId: "workspace-b", query: "Match", cursor: null, limit: 50 }), /workspace|changed/i);
    assert.equal(f.queryCount(), 0);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("wrong-scope native hits and arbitrary symbol IDs cannot disclose source", async () => {
  const f = await fixture();
  const context = { repositoryPath: f.paths[0], workspaceId: "workspace-a" };
  try {
    f.setReply({ results: [{ id: "elsewhere::Match", name: "Match", kind: "function", file_path: "elsewhere/file.ts", repo_prefix: "repo-1", workspace_id: "workspace-b" }] });
    await assert.rejects(f.library.search({ ...context, query: "Match", cursor: null, limit: 50 }), /different repository|workspace/i);
    const before = f.queryCount();
    await assert.rejects(f.library.symbol({ ...context, symbolId: "arbitrary-file", operation: "source" }), /Search for this symbol/i);
    assert.equal(f.queryCount(), before);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("native failures remain visible and untracked paths never substitute another repository", async () => {
  const f = await fixture();
  try {
    f.native.assignments = async () => { throw new Error("catalog offline"); };
    await assert.rejects(f.library.catalog(), /offline/);
    f.native.assignments = async () => [];
    await assert.rejects(f.library.status({ repositoryPath: f.paths[0], workspaceId: "workspace-a" }), /no longer in/i);
    assert.equal(f.queryCount(), 0);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a selected source snapshot has provenance and a bounded, visible truncation marker", async () => {
  const f = await fixture(); const context = { repositoryPath: f.paths[0], workspaceId: "workspace-a" };
  try {
    f.setReply({ results: [{ id: "repo-0/file.ts::Match", name: "Match", kind: "function", file_path: "repo-0/file.ts", repo_prefix: "repo-0", workspace_id: "workspace-a" }], truncated: true, next_cursor: "native-cursor", fetch_escalated: true });
    const results = await f.library.search({ ...context, query: "Match", cursor: null, limit: 50 });
    assert.equal(results.nextCursor, "native-cursor"); assert.equal(results.expanded, true);
    f.setReply({ id: "repo-0/file.ts::Match", name: "Match", kind: "function", file_path: "repo-0/file.ts", from_line: 7, source: "x".repeat(30000) });
    const snapshot = await f.library.symbol({ ...context, symbolId: results.results[0].id, operation: "source" });
    assert.ok(snapshot.text.length <= 16000); assert.equal(snapshot.truncated, true);
    assert.match(snapshot.text, /Workspace: workspace-a/); assert.match(snapshot.text, /Snapshot truncated/);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("only displayed native relationships with matching scope grant further source navigation", async () => {
  const f = await fixture(); const context = { repositoryPath: f.paths[0], workspaceId: "workspace-a" };
  const root = { id: "repo-0/file.ts::Root", name: "Root", kind: "function", file_path: "repo-0/file.ts", repo_prefix: "repo-0", workspace_id: "workspace-a" };
  const related = { ...root, id: "repo-0/other.ts::Caller", name: "Caller", file_path: "repo-0/other.ts" };
  const foreign = { ...root, id: "repo-1/other.ts::Other", name: "Other", repo_prefix: "repo-1", workspace_id: "workspace-b" };
  try {
    f.setReply({ results: [root] });
    await f.library.search({ ...context, query: "Root", cursor: null, limit: 50 });
    f.setReply({ nodes: [root, related, foreign], edges: [related, foreign].map(node => ({ from: node.id, to: root.id, kind: "calls" })), total_nodes: 3, total_edges: 2 });
    const callers = await f.library.symbol({ ...context, symbolId: root.id, operation: "callers" });
    assert.equal(callers.inspection.rows.find(row => row.symbol.id === related.id)?.symbol.navigable, true);
    assert.equal(callers.inspection.rows.find(row => row.symbol.id === foreign.id)?.symbol.navigable, false);
    const before = f.queryCount();
    await assert.rejects(f.library.symbol({ ...context, symbolId: foreign.id, operation: "source" }), /selection expired/);
    assert.equal(f.queryCount(), before);
    f.setReply({ ...related, source: "export function Caller() { return Root(); }", from_line: 4 });
    const source = await f.library.symbol({ ...context, symbolId: related.id, operation: "source" });
    assert.equal(source.inspection.source?.fromLine, 4);
    assert.match(source.text, /export function Caller/);
    assert.doesNotMatch(source.text, /nativeMetadata/);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("following relationships at the grant limit keeps the active symbol available for Back", async () => {
  const f = await fixture(); const context = { repositoryPath: f.paths[0], workspaceId: "workspace-a" };
  const node = (i: number) => ({ id: `repo-0/file.ts::Symbol${i}`, name: `Symbol${i}`, kind: "function", file_path: "repo-0/file.ts", repo_prefix: "repo-0", workspace_id: "workspace-a" });
  try {
    for (let page = 0; page < 10; page++) {
      f.setReply({ results: Array.from({ length: 50 }, (_, index) => node(page * 50 + index)) });
      await f.library.search({ ...context, query: `page${page}`, cursor: null, limit: 50 });
    }
    f.setReply({ implementations: [node(500)], total: 1 });
    await f.library.symbol({ ...context, symbolId: node(0).id, operation: "implementations" });
    f.setReply({ ...node(0), from_line: 1, source: "function Symbol0() {}" });
    const snapshot = await f.library.symbol({ ...context, symbolId: node(0).id, operation: "source" });
    assert.equal(snapshot.symbolId, node(0).id);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("index totals remain explicitly host-scoped across repository and workspace selections", async () => {
  const f = await fixture();
  const totals = { status: "ready", indexed_file_count: 2464, node_count: 46870, edge_count: 194905 };
  try {
    f.setReply(totals);
    const a = await f.library.status({ repositoryPath: f.paths[0], workspaceId: "workspace-a" });
    const b = await f.library.status({ repositoryPath: f.paths[1], workspaceId: "workspace-b" });
    for (const report of [a, b]) {
      assert.equal(report.scope, "host", "native aggregate totals must never be described as repository totals");
      assert.deepEqual(report.value, totals);
      assert.deepEqual(report.meta, { fixture: true });
      assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    }
    const calls = f.queryCount();
    await assert.rejects(f.library.status({ repositoryPath: f.paths[0], workspaceId: "workspace-b" }), /workspace|changed/i);
    assert.equal(f.queryCount(), calls, "a shared report must still validate the selected host repository context");
    f.setReply({ status: "refreshing", message: "Report pending" });
    const pending = await f.library.status({ repositoryPath: f.paths[0], workspaceId: "workspace-a" });
    assert.equal(pending.scope, "host");
    assert.deepEqual(pending.value, { status: "refreshing", message: "Report pending" });
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("folder inspection resolves a real nested Git directory without tracking it", async () => {
  const f = await fixture();
  try {
    await runProcess("git", ["init", "--quiet", f.paths[0]], f.root);
    const nested = join(f.paths[0], "nested"); await mkdir(nested);
    const inspection = await f.library.inspect(nested);
    assert.equal(inspection.repositoryRoot, f.paths[0]);
    assert.equal(inspection.gitDirectoryKind, "directory");
    assert.equal(inspection.tracking, "dedicated");
    assert.equal(f.queryCount(), 0);
  } finally { f.library.close(); await rm(f.root, { recursive: true, force: true }); }
});
