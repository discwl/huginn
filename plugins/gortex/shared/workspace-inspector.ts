import { z } from "zod";
import type { Inspection, RepositoryContext } from "./models.ts";
import { inspectorOperationSchema } from "./symbol-inspection.ts";

export const persistedSearchSchema = z.object({
  query: z.string().max(300).default(""),
  selection: z.object({
    symbol: z.object({ id: z.string().max(4000), name: z.string(), kind: z.string(), filePath: z.string(), line: z.number().nullable() }),
    operation: inspectorOperationSchema,
  }).nullable().default(null),
});
export type PersistedSymbolSearch = z.infer<typeof persistedSearchSchema>;
const emptySearch: PersistedSymbolSearch = { query: "", selection: null };

export const inspectorTabSchema = z.object({
  scope: z.string(),
  section: z.enum(["context", "search", "details"]),
  search: persistedSearchSchema.default(emptySearch),
});
export type InspectorTabState = z.infer<typeof inspectorTabSchema>;

export function inspectorScope(hostId: string, workspaceId: string, path: string): string {
  return JSON.stringify([hostId, workspaceId, path]);
}

export function scopedInspectorState(value: unknown, scope: string): InspectorTabState {
  const parsed = inspectorTabSchema.safeParse(value);
  return parsed.success && parsed.data.scope === scope ? parsed.data : { scope, section: "context", search: emptySearch };
}

/** Only expose the existing repository search when inspection resolves this very directory. */
export function inspectionSearchContext(inspection: Inspection): RepositoryContext | null {
  const repository = inspection.repository;
  if (inspection.gitDirectoryKind === "file" || repository?.state !== "resolved" || repository.error || !repository.workspaceId || repository.path !== inspection.canonicalPath) return null;
  return { repositoryPath: repository.path, workspaceId: repository.workspaceId };
}

/** Repository membership is evidence, not proof that Gortex served the exact checkout. */
export function workspaceInspectionSummary(inspection: Inspection): { label: string; detail: string } {
  if (inspection.gitDirectoryKind === "file") return {
    label: "Checkout needs verification",
    detail: "Git uses an indirection file here. This may be an automatic worktree or submodule. Dedicated tracking and exact checkout selection are not inferred.",
  };
  if (inspection.repository?.error) return { label: "Gortex context unavailable", detail: inspection.repository.error };
  if (inspection.repository?.state === "resolved") return {
    label: "Repository membership verified",
    detail: "The repository is in Gortex's current context. Exact checkout selection and index freshness have not been verified by this inspection.",
  };
  if (inspection.tracking === "not-in-catalog") return {
    label: "Outside the dedicated catalog",
    detail: "This does not rule out an automatic worktree view. Open the Gortex library to inspect tracking; this panel will not track or substitute a repository.",
  };
  return { label: "Context unavailable", detail: "Gortex could not establish repository membership. Review the diagnostic details and refresh when the host is ready." };
}
