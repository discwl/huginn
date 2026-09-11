import test from "node:test";
import assert from "node:assert/strict";
import { fitInspection, normalizeInspection } from "./symbol-inspection.ts";
import { inspectionText, symbolInspectionSchema } from "../shared/symbol-inspection.ts";
import { emptyNavigation, navigateInspector } from "../shared/inspector-navigation.ts";

// Shapes captured from the installed v0.64.3 source, relations and impact operations.
const scope = { workspaceId: "workspace", repository: "repo", symbolId: "repo/source.ts::Selected" };
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.split("::").at(-1)!, kind: "function", file_path: "repo/source.ts", repo_prefix: "repo", workspace_id: "workspace", start_line: 9, ...extra });
const root = node(scope.symbolId), caller = node("repo/caller.ts::Caller"), dependency = node("repo/dependency.ts::Dependency");
const call = (from: string, to: string, line = 12) => ({ from, to, kind: "calls", file_path: "repo/caller.ts", line, confidence_label: "EXTRACTED", tier: "ast" });

test("source uses native from_line, preserves text and rejects a substituted identity", () => {
  const source = "// context above symbol\nexport function Selected() {\n  return 'café';\n}";
  const data = normalizeInspection("source", { ...root, from_line: 6, source, signature: "function Selected()" }, {}, scope);
  assert.equal(data.source?.code, source); assert.equal(data.source?.fromLine, 6);
  assert.equal(data.source?.symbol.line, 9);
  assert.equal(data.partial, false);
  assert.match(inspectionText(data), /return 'café'/);
  assert.throws(() => normalizeInspection("source", { ...root, id: caller.id, source }, {}, scope), /different symbol/);
  assert.throws(() => normalizeInspection("source", { ...root, workspace_id: "another", source }, {}, scope), /different symbol/);
  assert.throws(() => normalizeInspection("source", { source }, {}, scope), /unsupported inspector response/);
});

test("callers group repeated sites, exclude the selected node, and preserve suppression caveats", () => {
  const data = normalizeInspection("callers", { nodes: [root, caller], edges: [call(caller.id, root.id), call(caller.id, root.id, 28)], total_nodes: 3, total_edges: 3, truncated: false, suppression_caveat: "1 candidate hidden pending re-verification" }, {}, scope);
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].symbol.id, caller.id);
  assert.equal(data.rows[0].depth, 1); assert.equal(data.rows[0].siteCount, 2);
  assert.deepEqual(data.rows[0].sites.map(site => site.line), [12, 28]);
  assert.deepEqual(data.rows[0].evidence, ["EXTRACTED"]);
  assert.equal(data.rows[0].symbol.navigable, true); assert.equal(data.partial, true);
  assert.ok(data.warnings.some(warning => warning.includes("candidate hidden")));
});

test("dependencies use outgoing edges with bounded traversal through cycles; disconnected evidence is explicit", () => {
  const other = node("repo/other.ts::Other"), detached = node("repo/detached.ts::Detached");
  const data = normalizeInspection("dependencies", { nodes: [root, dependency, other, detached], edges: [call(root.id, dependency.id), call(dependency.id, other.id), call(other.id, dependency.id)], total_nodes: 4, total_edges: 3 }, {}, scope);
  assert.deepEqual(data.rows.map(row => [row.symbol.id, row.depth]), [[dependency.id, 1], [other.id, 2], [detached.id, null]]);
  assert.equal(data.partial, true);
  assert.ok(data.warnings.some(warning => warning.includes("listed separately")));
});

test("usages retain relationship types and do not make other scopes navigable", () => {
  const foreign = node("foreign::Caller", { repo_prefix: "other", workspace_id: "elsewhere" });
  const unscoped = node("unscoped::Caller", { workspace_id: undefined });
  const data = normalizeInspection("usages", { nodes: [root, foreign, unscoped], edges: [{ ...call(foreign.id, root.id), kind: "imports" }, call(unscoped.id, root.id)], total_nodes: 3, total_edges: 2 }, {}, scope);
  assert.ok(data.rows.every(row => !row.symbol.navigable && row.symbol.navigationNote));
  assert.ok(data.rows.some(row => row.relations.includes("imports")));
});

test("empty, missing, malformed and budget-truncated native responses remain distinct", () => {
  const empty = normalizeInspection("callers", { nodes: null, edges: null, total_nodes: 0, total_edges: 0 }, {}, scope);
  assert.equal(empty.rows.length, 0); assert.equal(empty.partial, false);
  assert.throws(() => normalizeInspection("callers", { nodes: null, edges: null }, {}, scope), /details are missing/);
  assert.throws(() => normalizeInspection("callers", { nodes: [{ id: "broken" }], edges: [] }, {}, scope), /unsupported inspector response/);
  const partial = normalizeInspection("dependencies", { nodes: [], edges: [], truncated: false, _truncated_by_budget: true }, {}, scope);
  assert.equal(partial.partial, true); assert.match(inspectionText(partial), /partial response/);
  const stale = normalizeInspection("implementations", { implementations: null, total: 0 }, { freshness: { stale: true } }, scope);
  assert.equal(stale.partial, true); assert.ok(stale.warnings.some(warning => warning.includes("stale")));
});

test("implementations accept the native null-zero result and validate nonempty entries", () => {
  assert.equal(normalizeInspection("implementations", { implementations: null, total: 0 }, {}, scope).rows.length, 0);
  assert.throws(() => normalizeInspection("implementations", { implementations: null, total: 2 }, {}, scope), /missing/);
  const data = normalizeInspection("implementations", { implementations: [caller], total: 1 }, {}, scope);
  assert.equal(data.rows[0].symbol.navigable, true);
});

test("impact preserves native depth and risk without inventing missing workspace identity", () => {
  const data = normalizeInspection("impact", { by_depth: { "1": [node(caller.id, { workspace_id: undefined })], "2": [node(dependency.id, { workspace_id: undefined })] }, total_affected: 2, summary: "2 transitively affected", risk: "MEDIUM", complete: true, test_files: ["repo/tests.ts"] }, {}, scope);
  assert.deepEqual(data.rows.map(row => row.depth), [1, 2]);
  assert.equal(data.risk, "MEDIUM"); assert.equal(data.rows[0].symbol.navigable, false);
  assert.throws(() => normalizeInspection("impact", { by_depth: { invalid: [] }, total_affected: 0 }, {}, scope), /unsupported impact depth/);
});

test("the display model and copied context share the same source and row budgets", () => {
  const data = normalizeInspection("source", { ...root, from_line: 1, source: "a\n".repeat(1000) }, {}, scope);
  assert.equal(data.source?.code.split("\n").length, 220); assert.equal(data.partial, true);
  const long = normalizeInspection("source", { ...root, source: "x".repeat(15000), from_line: 1 }, {}, scope);
  const header = "Provenance: " + "p".repeat(9000) + "\n";
  const text = fitInspection(long, header);
  assert.ok(text.length <= 15000); assert.equal(text, header + inspectionText(long));
  assert.ok(long.source!.code.length < 9000); assert.equal(long.partial, true);
  symbolInspectionSchema.parse(long);
  const nodes = Array.from({ length: 75 }, (_, i) => node(`repo::Related${i}`, { signature: `function Related${i}(${"parameter: string, ".repeat(25)})` }));
  const many = normalizeInspection("implementations", { implementations: nodes, total: 75 }, {}, scope);
  assert.equal(many.rows.length, 40); assert.equal(many.partial, true);
  const bounded = fitInspection(many, header);
  assert.ok(bounded.length <= 15000); assert.ok(many.rows.length < 40);
  assert.equal(bounded, header + inspectionText(many));
});

test("Back restores the originating relationship tab, Forward restores the destination, and history stays bounded", () => {
  const selected = { id: root.id, name: "Selected", kind: "function", filePath: "repo/source.ts", line: 9 };
  let state = navigateInspector(emptyNavigation, { type: "select", root: true, symbol: selected });
  state = navigateInspector(state, { type: "tab", operation: "callers" });
  state = navigateInspector(state, { type: "select", symbol: { ...selected, id: caller.id, name: "Caller" } });
  assert.equal(state.current?.operation, "source");
  state = navigateInspector(state, { type: "back" });
  assert.equal(state.current?.symbol.id, root.id); assert.equal(state.current?.operation, "callers");
  state = navigateInspector(state, { type: "forward" }); assert.equal(state.current?.symbol.id, caller.id);
  state = navigateInspector(state, { type: "back" });
  state = navigateInspector(state, { type: "select", symbol: { ...selected, id: dependency.id } });
  assert.equal(state.forward.length, 0);
  for (let i = 0; i < 40; i++) state = navigateInspector(state, { type: "select", symbol: { ...selected, id: `repo::${i}` } });
  assert.equal(state.back.length, 24);
  state = navigateInspector(state, { type: "select", root: true, symbol: selected }); assert.equal(state.back.length, 0);
  assert.deepEqual(navigateInspector(state, { type: "reset" }), emptyNavigation);
});
