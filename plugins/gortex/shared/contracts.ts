import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { catalogSchema, directoryInputSchema, directoryPageSchema, inspectionSchema, nativeReportSchema, pathSchema, repositoryContextSchema, searchPageSchema } from "./models.ts";
import { inspectorOperationSchema, symbolSnapshotSchema } from "./symbol-inspection.ts";

export const preferences = defineSettings({
  id: "preferences", scope: "host", version: 1,
  schema: z.object({ searchLimit: z.number().int().min(1).max(50).default(50) }),
});
export const catalogRpc = defineRpc({ name: "catalog.list", input: z.object({ offset: z.number().int().min(0).max(100000).default(0) }), output: catalogSchema });
export const directoryRpc = defineRpc({ name: "directory.list", input: directoryInputSchema, output: directoryPageSchema });
export const inspectRpc = defineRpc({ name: "repository.inspect", input: z.object({ path: pathSchema }), output: inspectionSchema });
export const statusRpc = defineRpc({ name: "repository.status", input: repositoryContextSchema, output: nativeReportSchema });
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
