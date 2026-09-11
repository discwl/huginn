import { z } from "zod";

export const pathSchema = z.string().min(1).max(32767).refine(value => !value.includes("\0"), "Paths cannot contain NUL");
export const directoryInputSchema = z.object({
  path: pathSchema.optional(),
  filter: z.string().max(200).default(""),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().max(300).nullable().default(null),
});
export const directoryEntrySchema = z.object({ name: z.string(), path: pathSchema, isLink: z.boolean() });
export const directoryPageSchema = z.object({
  path: pathSchema, parent: pathSchema.nullable(), roots: z.array(pathSchema),
  entries: z.array(directoryEntrySchema).max(100), nextCursor: z.string().nullable(),
  partial: z.boolean(), warnings: z.array(z.string()), observedAt: z.string(),
});
export const nativeAssignmentSchema = z.object({
  repo: z.string().min(1), path: pathSchema, workspace: z.string(), project: z.string(), source: z.string(),
});
export const nativeInfoSchema = z.object({
  workspace: z.string().min(1), project: z.string(), mode: z.string(),
  isolation_bounds: z.unknown().optional(),
  members: z.array(z.object({ name: z.string(), path: pathSchema })),
}).passthrough();
export const repositorySchema = z.object({
  name: z.string(), path: pathSchema, declaredWorkspace: z.string(), declaredProject: z.string(), assignmentSource: z.string(),
  workspaceId: z.string().nullable(), projectId: z.string().nullable(), graphName: z.string().nullable(),
  state: z.enum(["resolved", "unavailable"]), error: z.string().nullable(),
});
export const catalogSchema = z.object({
  version: z.string(), observedAt: z.string(),
  repositories: z.array(repositorySchema).max(50),
  total: z.number().int(), nextOffset: z.number().int().nullable(),
  warnings: z.array(z.string()),
  administration: z.object({ available: z.literal(false), reason: z.string() }),
});
export const repositoryContextSchema = z.object({ repositoryPath: pathSchema, workspaceId: z.string().min(1).max(500) });
export const inspectionSchema = z.object({
  selectedPath: pathSchema, canonicalPath: pathSchema,
  repositoryRoot: pathSchema.nullable(), gitDirectoryKind: z.enum(["directory", "file", "unknown", "none"]),
  tracking: z.enum(["dedicated", "not-in-catalog", "unknown"]),
  repository: repositorySchema.nullable(),
  warnings: z.array(z.string()), observedAt: z.string(),
});
export const nativeReportSchema = z.object({
  value: z.unknown(), meta: z.unknown(), observedAt: z.string(),
});
export const symbolSchema = z.object({
  id: z.string(), name: z.string(), kind: z.string(), file_path: z.string(),
  absolute_file_path: z.string().optional(), start_line: z.number().optional(),
  repo_prefix: z.string(), workspace_id: z.string(), project_id: z.string().optional(),
  signature: z.string().optional(),
}).passthrough();
export const searchPageSchema = z.object({
  results: z.array(symbolSchema).max(50), total: z.number().optional(), nextCursor: z.string().nullable(),
  truncated: z.boolean(), expanded: z.boolean(), warnings: z.array(z.string()),
  context: repositoryContextSchema, meta: z.unknown(), observedAt: z.string(),
});
export type NativeAssignment = z.infer<typeof nativeAssignmentSchema>;
export type NativeInfo = z.infer<typeof nativeInfoSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type RepositoryContext = z.infer<typeof repositoryContextSchema>;
export type DirectoryInput = z.infer<typeof directoryInputSchema>;
export type DirectoryPage = z.infer<typeof directoryPageSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type SearchPage = z.infer<typeof searchPageSchema>;
