import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

const dependent = z.object({ kind: z.string(), id: z.string(), detail: z.string() });
export const nativeUntrackPlanSchema = z.object({
  status: z.literal("preview"), action: z.literal("untrack"),
  plan: z.enum(["primary_closure", "forget"]), prefix: z.string().min(1),
  accessible: z.boolean(), is_primary: z.boolean(), confirm_required: z.literal(true), detail: z.string(),
  checkout_id: z.string().optional(), family_id: z.string().optional(), graph_id: z.string().optional(),
  primary_epoch: z.number().int().nonnegative().optional(), sole_primary: z.boolean().optional(),
  closure: z.array(dependent).max(1000).default([]), preserved: z.array(dependent).max(1000).default([]),
  blockers: z.array(z.string()).max(100).default([]),
});
export const nativeUntrackReceiptSchema = z.object({
  status: z.enum(["untracked", "demoted"]), plan: z.enum(["evict", "demote", "forget", "primary_closure"]),
  prefix: z.string().min(1), nodes_removed: z.number().int().nonnegative(), edges_removed: z.number().int().nonnegative(),
  demoted: z.boolean().optional(), dependents: z.array(z.string()).max(1000).default([]),
});
export const untrackPreviewSchema = z.object({
  id: z.string().uuid(), expiresAt: z.string(), path: pathSchema, name: z.string(),
  workspace: z.string(), project: z.string(), configPath: pathSchema,
  native: nativeUntrackPlanSchema.nullable(), warnings: z.array(z.string()),
});
export const untrackJobSchema = z.object({
  id: z.string().uuid(), path: pathSchema,
  stage: z.enum(["validating", "untracking", "verifying", "done"]),
  outcome: z.enum(["running", "review", "untracked", "demoted", "failed", "uncertain"]),
  preview: untrackPreviewSchema.nullable(), receipt: nativeUntrackReceiptSchema.nullable(),
  configRemoved: z.boolean().nullable(), backupPath: pathSchema.nullable(), error: z.string().nullable(),
});
export type UntrackPreview = z.infer<typeof untrackPreviewSchema>;
export type UntrackJob = z.infer<typeof untrackJobSchema>;
// Only apply is a write. A native destructive plan produces a fresh preview token, never an automatic confirmation.
export const untrackPreviewRpc = defineRpc({ name: "untrack.preview", input: z.object({ path: pathSchema }), output: untrackPreviewSchema });
export const untrackApplyRpc = defineRpc({ name: "untrack.apply", input: z.object({ id: z.string().uuid() }), output: untrackJobSchema });
export const untrackJobRpc = defineRpc({ name: "untrack.job", input: z.object({ id: z.string().uuid() }), output: untrackJobSchema });
