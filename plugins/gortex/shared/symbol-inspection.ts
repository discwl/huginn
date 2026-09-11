import { z } from "zod";
import { repositoryContextSchema } from "./models.ts";

export const inspectorOperationSchema = z.enum(["source", "callers", "dependencies", "usages", "implementations", "impact"]);
export type InspectorOperation = z.infer<typeof inspectorOperationSchema>;
export const inspectorLabels: Record<InspectorOperation, string> = {
  source: "Source", callers: "Callers", dependencies: "Dependencies", usages: "Usages", implementations: "Implementations", impact: "Impact",
};
export const inspectorSymbolSchema = z.object({
  id: z.string().max(4000), name: z.string().max(4000), kind: z.string().max(100),
  filePath: z.string().max(4000), line: z.number().int().positive().nullable(),
  repository: z.string().max(1000).nullable(), workspace: z.string().max(1000).nullable(),
  signature: z.string().max(4000).nullable(), navigable: z.boolean(), navigationNote: z.string().nullable(),
});
export type InspectorSymbol = z.infer<typeof inspectorSymbolSchema>;
export const inspectorRowSchema = z.object({
  symbol: inspectorSymbolSchema, depth: z.number().int().nonnegative().nullable(),
  relations: z.array(z.string()).max(12), evidence: z.array(z.string()).max(12),
  sites: z.array(z.object({ filePath: z.string(), line: z.number().int().positive().nullable() })).max(4),
  siteCount: z.number().int().nonnegative(),
});
export type InspectorRow = z.infer<typeof inspectorRowSchema>;
export const symbolInspectionSchema = z.object({
  operation: inspectorOperationSchema,
  source: z.object({ symbol: inspectorSymbolSchema, code: z.string().max(9000), fromLine: z.number().int().positive().nullable() }).nullable(),
  rows: z.array(inspectorRowSchema).max(40),
  facts: z.array(z.object({ label: z.string(), value: z.string() })).max(8),
  summary: z.string().nullable(), risk: z.string().nullable(), warnings: z.array(z.string()).max(20), partial: z.boolean(),
});
export type SymbolInspection = z.infer<typeof symbolInspectionSchema>;
export const symbolSnapshotSchema = z.object({
  text: z.string().max(16000), truncated: z.boolean(), observedAt: z.string(),
  context: repositoryContextSchema, symbolId: z.string(), inspection: symbolInspectionSchema,
  raw: z.string().max(16000), rawTruncated: z.boolean(),
});
export type SymbolSnapshot = z.infer<typeof symbolSnapshotSchema>;

/** These are exactly the readable fields displayed by the inspector, in copyable form. */
export function inspectionText(data: SymbolInspection): string {
  const lines: string[] = [];
  if (data.summary) lines.push(data.summary);
  if (data.risk) lines.push(`Native risk: ${data.risk}`);
  for (const fact of data.facts) lines.push(`${fact.label}: ${fact.value}`);
  if (data.source) {
    const { symbol, code, fromLine } = data.source;
    lines.push(`${symbol.name} (${symbol.kind})`, `${symbol.filePath}${fromLine ? `:${fromLine}` : ""}`);
    if (symbol.signature) lines.push(symbol.signature);
    lines.push("", code);
  } else {
    for (const row of data.rows) {
      const s = row.symbol;
      lines.push("", `${s.name} (${s.kind})${row.depth !== null ? ` · depth ${row.depth}` : ""}`, `${s.filePath}${s.line ? `:${s.line}` : ""}`);
      lines.push(`Repository: ${s.repository ?? "not supplied"} · workspace: ${s.workspace ?? "not supplied"}`);
      if (s.signature) lines.push(s.signature);
      if (row.relations.length) lines.push(`Relationships: ${row.relations.join(", ")}`);
      if (row.evidence.length) lines.push(`Evidence: ${row.evidence.join(", ")}`);
      for (const site of row.sites) lines.push(`Site: ${site.filePath}${site.line ? `:${site.line}` : ""}`);
      if (row.siteCount > row.sites.length) lines.push(`${row.siteCount - row.sites.length} additional sites not shown`);
      if (s.navigationNote) lines.push(s.navigationNote);
    }
    if (!data.rows.length) lines.push(data.partial ? "No items available in this partial response." : "No items returned by the native index. This does not establish complete coverage.");
  }
  lines.push("", ...data.warnings.map(warning => `Note: ${warning}`));
  return lines.join("\n");
}
