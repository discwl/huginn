import { z } from "zod";
import type { NativeAssignment } from "./models.ts";

export const catalogInputSchema = z.object({
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(50).default(50),
  query: z.string().trim().max(200).default(""),
  workspace: z.string().max(500).nullable().default(null),
  project: z.string().max(500).nullable().default(null),
  sort: z.enum(["name", "workspace", "project"]).default("name"),
});
export type CatalogInput = z.infer<typeof catalogInputSchema>;
export type CatalogFilters = Pick<CatalogInput, "query" | "workspace" | "project" | "sort">;
export const emptyCatalogFilters: CatalogFilters = { query: "", workspace: null, project: null, sort: "name" };
export const catalogFacetSchema = z.object({ value: z.string(), count: z.number().int().nonnegative() });
export type CatalogFacet = z.infer<typeof catalogFacetSchema>;

function compare(a: string, b: string) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || a.localeCompare(b); }
function searchable(value: string) { return value.normalize("NFKC").toLowerCase(); }
function facets(rows: NativeAssignment[], field: "workspace" | "project"): CatalogFacet[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => compare(a, b)).map(([value, count]) => ({ value, count }));
}

/** Presentation filters over the complete native assignment catalog, never graph scope selectors. */
export function pageAssignments(rows: NativeAssignment[], input: CatalogInput) {
  const terms = searchable(input.query).split(/\s+/).filter(Boolean);
  const matched = rows.filter(row =>
    (input.workspace === null || row.workspace === input.workspace) &&
    (input.project === null || row.project === input.project) &&
    terms.every(term => searchable([row.repo, row.path, row.workspace, row.project].join(" ")).includes(term)));
  const field = input.sort === "name" ? "repo" : input.sort;
  matched.sort((a, b) => compare(a[field], b[field]) || compare(a.repo, b.repo) || compare(a.path, b.path));
  // Reconcile removals or concurrent metadata changes without stranding the user on an empty last page.
  const lastOffset = Math.max(0, Math.floor((matched.length - 1) / input.limit) * input.limit);
  const offset = Math.min(input.offset, lastOffset);
  return {
    rows: matched.slice(offset, offset + input.limit), offset,
    total: rows.length, filteredTotal: matched.length,
    nextOffset: offset + input.limit < matched.length ? offset + input.limit : null,
    workspaces: facets(rows, "workspace"), projects: facets(rows, "project"),
  };
}
