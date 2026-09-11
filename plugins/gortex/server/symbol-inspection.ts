import { z } from "zod";
import { NativeError } from "./native-response.ts";
import { inspectionText, symbolInspectionSchema, type InspectorOperation, type InspectorRow, type InspectorSymbol, type SymbolInspection } from "../shared/symbol-inspection.ts";

const nativeNodeSchema = z.object({
  id: z.string().min(1).max(4000), name: z.string().max(4000), kind: z.string().max(100), file_path: z.string().max(4000),
  start_line: z.number().int().nonnegative().optional(), repo_prefix: z.string().max(1000).optional(), workspace_id: z.string().max(1000).optional(),
  signature: z.string().max(4000).optional(), meta: z.object({ search_signature: z.string().max(4000).optional(), signature: z.string().max(4000).optional() }).passthrough().optional(),
}).passthrough();
const nativeEdgeSchema = z.object({
  from: z.string(), to: z.string(), kind: z.string(), file_path: z.string().optional(), line: z.number().int().nonnegative().optional(),
  confidence_label: z.string().optional(), tier: z.string().optional(),
}).passthrough();
const graphSchema = z.object({
  nodes: z.array(nativeNodeSchema).max(2000).nullable(), edges: z.array(nativeEdgeSchema).max(4000).nullable(),
  total_nodes: z.number().nonnegative().optional(), total_edges: z.number().nonnegative().optional(),
}).passthrough();
const implementationSchema = z.object({ implementations: z.array(nativeNodeSchema).max(2000).nullable(), total: z.number().nonnegative() }).passthrough();
const impactSchema = z.object({
  by_depth: z.record(z.string(), z.array(nativeNodeSchema).max(2000)).nullable(), total_affected: z.number().nonnegative(),
  summary: z.string().max(3000).optional(), risk: z.string().max(100).optional(), test_files: z.array(z.string()).nullable().optional(),
}).passthrough();
const sourceSchema = nativeNodeSchema.extend({ source: z.string(), from_line: z.number().int().positive().optional() });
type NativeNode = z.infer<typeof nativeNodeSchema>;
type Scope = { workspaceId: string; repository: string; symbolId: string };

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new NativeError("inspector_shape", "Gortex returned an unsupported inspector response. Refresh or check native compatibility; no empty result was substituted.");
  return result.data;
}
function note(data: SymbolInspection, message: string, partial = false): void {
  if (!data.warnings.includes(message) && data.warnings.length < 18) data.warnings.push(message);
  if (partial) data.partial = true;
}
function metadataWarnings(data: SymbolInspection, value: unknown, depth = 0): void {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.truncated === true || record._truncated_by_budget === true || record.partial === true || record.lower_bound === true || record.complete === false)
    note(data, "Native results are partial or bounded; counts may be lower bounds.", true);
  if (record.stale === true) note(data, "Gortex marked this evidence as stale.", true);
  for (const key of ["suppression_caveat", "cross_community_warning", "warning", "caveat"]) {
    if (typeof record[key] === "string" && record[key]) note(data, (record[key] as string).slice(0, 700), true);
  }
  for (const key of ["warnings", "caveats"]) {
    if (Array.isArray(record[key])) for (const warning of (record[key] as unknown[]).slice(0, 5)) {
      if (typeof warning === "string") note(data, warning.slice(0, 700), true);
    }
  }
  for (const key of ["metadata", "_meta", "freshness", "completeness", "view", "route"]) metadataWarnings(data, record[key], depth + 1);
}
function symbol(node: NativeNode, scope: Scope): InspectorSymbol {
  const navigable = node.repo_prefix === scope.repository && node.workspace_id === scope.workspaceId;
  return {
    id: node.id, name: node.name, kind: node.kind, filePath: node.file_path, line: node.start_line && node.start_line > 0 ? node.start_line : null,
    repository: node.repo_prefix ?? null, workspace: node.workspace_id ?? null,
    signature: node.meta?.search_signature ?? node.signature ?? node.meta?.signature ?? null,
    navigable,
    navigationNote: navigable ? null : !node.repo_prefix || !node.workspace_id
      ? "Gortex did not supply full scope identity here. Find this symbol in search to inspect it."
      : "This result belongs to another repository or workspace. Select that repository to inspect it.",
  };
}
function row(node: NativeNode, scope: Scope, depth: number | null): InspectorRow {
  return { symbol: symbol(node, scope), depth, relations: [], evidence: [], sites: [], siteCount: 0 };
}

/** Native responses remain authoritative. Only verified same-scope nodes can become navigation grants. */
export function normalizeInspection(operation: InspectorOperation, value: unknown, meta: unknown, scope: Scope): SymbolInspection {
  const data: SymbolInspection = { operation, source: null, rows: [], facts: [], summary: null, risk: null, warnings: [], partial: false };
  metadataWarnings(data, value); metadataWarnings(data, meta);
  if (operation === "source") {
    const source = parsed(sourceSchema, value);
    if (source.id !== scope.symbolId || (source.repo_prefix && source.repo_prefix !== scope.repository) || (source.workspace_id && source.workspace_id !== scope.workspaceId))
      throw new NativeError("wrong_symbol", "Gortex returned source for a different symbol or scope; it was rejected.");
    const code = source.source.split("\n").slice(0, 220).join("\n").slice(0, 9000);
    data.source = { symbol: symbol(source, scope), code, fromLine: source.from_line ?? null };
    if (code !== source.source) note(data, "Snapshot truncated to the displayed source budget (220 lines / 9,000 characters).", true);
    if (!source.from_line) note(data, "Native source line numbering was not supplied.");
  } else if (operation === "implementations") {
    const native = parsed(implementationSchema, value);
    if (native.implementations === null && native.total > 0 && !data.partial) throw new NativeError("inspector_shape", "Native implementations were missing despite a nonzero count.");
    data.rows = (native.implementations ?? []).map(node => row(node, scope, 1));
    data.facts.push({ label: "Native implementation count", value: String(native.total) });
    if (native.total > data.rows.length) note(data, "The native count includes implementations absent from this response.", true);
  } else if (operation === "impact") {
    const native = parsed(impactSchema, value);
    if (native.by_depth === null && native.total_affected > 0 && !data.partial) throw new NativeError("inspector_shape", "Native impact details were missing despite a nonzero count.");
    for (const [depth, nodes] of Object.entries(native.by_depth ?? {})) {
      if (!/^\d+$/.test(depth) || !Number.isSafeInteger(Number(depth))) throw new NativeError("inspector_shape", "Gortex returned an unsupported impact depth.");
      data.rows.push(...nodes.map(node => {
        const item = row(node, scope, Number(depth));
        if (typeof node.confidence_label === "string") item.evidence.push(node.confidence_label);
        return item;
      }));
    }
    data.summary = native.summary ?? null; data.risk = native.risk ?? null;
    data.facts.push({ label: "Native affected count", value: String(native.total_affected) });
    if (native.test_files) data.facts.push({ label: "Related test files", value: String(native.test_files.length) });
    if (native.total_affected > data.rows.length) note(data, "The native affected count includes items absent from this response.", true);
    note(data, "Impact is inferred from the indexed graph; its risk rating is not a safety guarantee.");
  } else {
    const native = parsed(graphSchema, value);
    if ((!native.nodes && native.total_nodes !== 0) || (!native.edges && native.total_edges !== 0)) {
      if (!data.partial) throw new NativeError("inspector_shape", "Native relationship details are missing. They cannot be shown as an empty successful result.");
    }
    const nodes = native.nodes ?? [], edges = native.edges ?? [];
    const identities = new Map<string, NativeNode>();
    for (const node of nodes) {
      const previous = identities.get(node.id);
      if (previous && (previous.repo_prefix !== node.repo_prefix || previous.workspace_id !== node.workspace_id || previous.file_path !== node.file_path))
        throw new NativeError("inspector_shape", "A native symbol has conflicting scope identities.");
      identities.set(node.id, node);
    }
    const outgoing = operation === "dependencies";
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const from = outgoing ? edge.from : edge.to, to = outgoing ? edge.to : edge.from;
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    }
    const depths = new Map<string, number>([[scope.symbolId, 0]]), queue = [scope.symbolId];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]) ?? []) if (!depths.has(next)) {
        depths.set(next, depths.get(queue[i])! + 1); queue.push(next);
      }
    }
    data.rows = [...identities.values()].filter(node => node.id !== scope.symbolId).map(node => {
      const item = row(node, scope, depths.get(node.id) ?? null);
      const related = edges.filter(edge => (outgoing ? edge.to : edge.from) === node.id);
      item.relations = [...new Set(related.map(edge => edge.kind))].slice(0, 12);
      item.evidence = [...new Set(related.map(edge => edge.confidence_label ?? edge.tier).filter((value): value is string => !!value))].slice(0, 12);
      const sites = new Map<string, { filePath: string; line: number | null }>();
      for (const edge of related) if (edge.file_path) sites.set(JSON.stringify([edge.file_path, edge.line]), { filePath: edge.file_path, line: edge.line && edge.line > 0 ? edge.line : null });
      item.sites = [...sites.values()].slice(0, 4); item.siteCount = sites.size;
      if (item.siteCount > item.sites.length) note(data, "Some symbols have additional locations beyond the displayed four-site limit.", true);
      return item;
    });
    if (data.rows.some(item => item.depth === null)) note(data, "Some returned symbols could not be connected to the selection using the returned edges; they are listed separately.", true);
    if (edges.some(edge => !identities.has(edge.from) || !identities.has(edge.to))) note(data, "Some native edges reference symbols whose details were not returned.", true);
    if (native.total_edges !== undefined) data.facts.push({ label: "Native relationship count", value: String(native.total_edges) });
    if ((native.total_nodes ?? nodes.length) > nodes.length || (native.total_edges ?? edges.length) > edges.length)
      note(data, "Native totals include evidence absent from this response.", true);
  }
  data.rows.sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity) || a.symbol.name.localeCompare(b.symbol.name));
  if (data.rows.length > 40) { data.rows = data.rows.slice(0, 40); note(data, "Snapshot truncated to 40 displayed symbols.", true); }
  note(data, "Current repository session; exact checkout selection is not established.");
  note(data, "Missing relationships or findings can reflect incomplete graph coverage.");
  return parsed(symbolInspectionSchema, data);
}

/** Trim the displayed model first so copied context never contains invisible extra evidence. */
export function fitInspection(data: SymbolInspection, header: string): string {
  let text = header + inspectionText(data);
  if (text.length > 15000) note(data, "Snapshot truncated to the displayed context budget.", true);
  while ((text = header + inspectionText(data)).length > 15000) {
    if (data.rows.length) data.rows.pop();
    else if (data.source?.code) data.source.code = data.source.code.slice(0, Math.max(0, data.source.code.length - (text.length - 15000)));
    else throw new NativeError("inspector_budget", "Symbol metadata exceeds the display budget. Choose a narrower result.");
  }
  return text;
}
