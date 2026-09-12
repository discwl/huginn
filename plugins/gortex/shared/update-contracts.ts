import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const updateInstallationSchema = z.object({
  binary: z.string(), version: z.string(), fingerprint: z.string(),
  method: z.enum(["windows-release", "native", "unsupported"]), reason: z.string().nullable(),
});
export type UpdateInstallation = z.infer<typeof updateInstallationSchema>;
export const updateStatusSchema = z.object({
  installation: updateInstallationSchema,
  state: z.enum(["unchecked", "available", "current", "ahead", "unavailable"]),
  latestVersion: z.string().nullable(), releaseUrl: z.string().nullable(), checkedAt: z.string().nullable(), error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export const updatePreviewSchema = z.object({
  id: z.string().uuid(), expiresAt: z.string(), installation: updateInstallationSchema,
  targetVersion: z.string(), releaseUrl: z.string(), warnings: z.array(z.string()),
});
export type UpdatePreview = z.infer<typeof updatePreviewSchema>;
export const updateJobSchema = z.object({
  id: z.string().uuid(), targetVersion: z.string(),
  stage: z.enum(["checking", "downloading", "installing", "restarting", "verifying", "done"]),
  outcome: z.enum(["running", "updated", "needs-attention", "failed", "uncertain"]),
  installedVersion: z.string().nullable(), backupPath: z.string().nullable(), daemonReachable: z.boolean().nullable(), error: z.string().nullable(),
});
export type UpdateJob = z.infer<typeof updateJobSchema>;
const empty = z.object({});
export const updateStatusRpc = defineRpc({ name: "update.status", input: empty, output: updateStatusSchema });
export const updateCheckRpc = defineRpc({ name: "update.check", input: empty, output: updateStatusSchema });
export const updatePreviewRpc = defineRpc({ name: "update.preview", input: empty, output: updatePreviewSchema });
export const updateApplyRpc = defineRpc({ name: "update.apply", input: z.object({ id: z.string().uuid() }), output: updateJobSchema });
export const updateJobRpc = defineRpc({ name: "update.job", input: z.object({ id: z.string().uuid().optional() }), output: updateJobSchema.nullable() });
