import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { catalogSchema, directoryInputSchema, directoryPageSchema, inspectionSchema, nativeReportSchema, pathSchema, repositoryContextSchema, searchPageSchema } from "./models.ts";
import { inspectorOperationSchema, symbolSnapshotSchema } from "./symbol-inspection.ts";
import { catalogInputSchema } from "./catalog-browser.ts";

export const preferences = defineSettings({
  id: "preferences", scope: "host", version: 1,
  schema: z.object({
    searchLimit: z.number().int().min(1).max(50).default(50),
    // Opt-in: index new Paseo projects on this host and assign them to defaultWorkspace (empty keeps the native default).
    autoIndex: z.boolean().default(false),
    defaultWorkspace: z.string().max(160).regex(/^[^\x00-\x1f\x7f]*$/, "Use a single line without control characters").default(""),
    // Agent for exclusion suggestions, as provider/model. It must offer a plan or read-only mode.
    suggestionAgent: z.string().max(200).regex(/^[a-z0-9._-]+(\/[^\s\x00-\x1f\x7f]+)?$/i, "Use provider/model, e.g. claude/claude-sonnet-5").default("claude/claude-sonnet-5"),
  }),
});
export const catalogRpc = defineRpc({ name: "catalog.list", input: catalogInputSchema, output: catalogSchema });
export const directoryRpc = defineRpc({ name: "directory.list", input: directoryInputSchema, output: directoryPageSchema });
export const inspectRpc = defineRpc({ name: "repository.inspect", input: z.object({ path: pathSchema }), output: inspectionSchema });
export const statusRpc = defineRpc({ name: "repository.status", input: repositoryContextSchema, output: nativeReportSchema.extend({ scope: z.literal("host") }) });
export const searchRpc = defineRpc({
  name: "symbols.search",
  input: repositoryContextSchema.extend({ query: z.string().trim().min(1).max(300), cursor: z.string().max(2000).nullable().default(null), limit: z.number().int().min(1).max(50).default(50) }),
  output: searchPageSchema,
});
export const symbolRpc = defineRpc({
  name: "symbol.inspect",
  input: repositoryContextSchema.extend({ symbolId: z.string().min(1).max(4000), operation: inspectorOperationSchema }),
  output: symbolSnapshotSchema,
});
