import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";
import { exclusionPatternsSchema, exclusionSourcesSchema } from "./exclusions.ts";

// These are plugin RPC contracts, not native Gortex operation names.
const field = z.string().max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value), "Use a single line without control characters");
export const repositoryFieldsSchema = z.object({ name: field, workspace: field, project: field }).strict();
export type RepositoryFields = z.infer<typeof repositoryFieldsSchema>;
export const metadataSchema = z.object({
  path: pathSchema, configPath: pathSchema, revision: z.string(),
  configured: repositoryFieldsSchema, effective: repositoryFieldsSchema,
  daemon: repositoryFieldsSchema.nullable(),
  state: z.enum(["applied", "pending", "unavailable"]),
  assignmentSource: z.string(), observedAt: z.string(), error: z.string().nullable(),
  extra: z.object({ ref: z.string().nullable(), exclude: z.array(z.string()), unknownKeys: z.array(z.string()) }),
  exclusionSources: exclusionSourcesSchema,
  canRebuild: z.boolean(), warnings: z.array(z.string()),
});
export type RepositoryMetadata = z.infer<typeof metadataSchema>;
export const metadataPreviewSchema = z.object({
  id: z.string().uuid(), expiresAt: z.string(), before: metadataSchema,
  configured: repositoryFieldsSchema, effective: repositoryFieldsSchema,
  exclude: z.array(z.string()), updatesExclusions: z.boolean(),
  writesConfig: z.boolean(), rebuildsIndex: z.boolean(), warnings: z.array(z.string()),
});
export type MetadataPreview = z.infer<typeof metadataPreviewSchema>;
export const metadataJobSchema = z.object({
  id: z.string().uuid(), path: pathSchema,
  stage: z.enum(["validating", "saving", "reloading", "indexing", "verifying", "done"]),
  outcome: z.enum(["running", "applied", "pending", "failed", "uncertain"]),
  exclusions: z.enum(["unchanged", "pending", "refreshed"]),
  configSaved: z.boolean(), backupPath: pathSchema.nullable(),
  result: metadataSchema.nullable(), error: z.string().nullable(),
});
export type MetadataJob = z.infer<typeof metadataJobSchema>;
export const metadataReadRpc = defineRpc({ name: "metadata.read", input: z.object({ path: pathSchema }), output: metadataSchema });
export const metadataPreviewRpc = defineRpc({ name: "metadata.preview", input: z.object({ path: pathSchema, revision: z.string(), configured: repositoryFieldsSchema, exclude: exclusionPatternsSchema.optional() }), output: metadataPreviewSchema });
// Read-only proposal; applying it still requires metadata.apply with its preview ID.
export const metadataRepairRpc = defineRpc({ name: "metadata.repair", input: z.object({ path: pathSchema, revision: z.string() }), output: metadataPreviewSchema });
export const metadataApplyRpc = defineRpc({ name: "metadata.apply", input: z.object({ id: z.string().uuid() }), output: metadataJobSchema });
export const metadataJobRpc = defineRpc({ name: "metadata.job", input: z.object({ id: z.string().uuid() }), output: metadataJobSchema });
