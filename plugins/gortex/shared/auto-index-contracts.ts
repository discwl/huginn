import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

// Plugin RPC contract, not a native Gortex operation name.
export const autoIndexRecordSchema = z.object({
  id: z.string().uuid(), path: pathSchema, observedAt: z.string(),
  outcome: z.enum(["running", "skipped", "indexed", "assigned", "pending", "failed"]),
  workspace: z.string().nullable(), message: z.string().nullable(),
});
export type AutoIndexRecord = z.infer<typeof autoIndexRecordSchema>;
export const autoIndexActivityRpc = defineRpc({ name: "auto-index.activity", input: z.object({}), output: z.object({ records: z.array(autoIndexRecordSchema).max(20) }) });
