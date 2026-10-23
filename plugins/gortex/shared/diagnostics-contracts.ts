import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

// Plugin RPC contracts, not native Gortex operation names.
export const diagnosticCheckSchema = z.object({
  id: z.string(), title: z.string(),
  state: z.enum(["pass", "warn", "fail", "skipped"]),
  detail: z.string(),
  /** Native output or timing behind the verdict, kept short and shown on demand. */
  evidence: z.string().nullable(),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;

export const remedySchema = z.object({
  id: z.string(), title: z.string(), detail: z.string(),
  /** host-wide actions interrupt every Gortex client on this host, including running agents. */
  risk: z.enum(["safe", "host-wide"]),
  target: pathSchema.nullable(),
});
export type Remedy = z.infer<typeof remedySchema>;

export const diagnosticsReportSchema = z.object({
  id: z.string().uuid(), observedAt: z.string(), durationMs: z.number().int().nonnegative(),
  state: z.enum(["healthy", "degraded", "broken"]),
  summary: z.string(),
  checks: z.array(diagnosticCheckSchema).max(40),
  remedies: z.array(remedySchema).max(12),
});
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;

export const repairJobSchema = z.object({
  id: z.string().uuid(), remedyId: z.string(), title: z.string(),
  stage: z.enum(["running", "verifying", "done"]),
  outcome: z.enum(["running", "fixed", "unchanged", "failed"]),
  steps: z.array(z.string()).max(20), error: z.string().nullable(),
  report: diagnosticsReportSchema.nullable(),
});
export type RepairJob = z.infer<typeof repairJobSchema>;

// Paseo gives a plugin call 30 seconds, and on a slow host the checks take longer. run answers with the report when the
// checks finish within about 20 seconds; otherwise running is true and they finish in the background, where latest
// reports them (the panel polls it).
const runStateSchema = z.object({ report: diagnosticsReportSchema.nullable(), running: z.boolean() });
export const diagnosticsRunRpc = defineRpc({ name: "diagnostics.run", input: z.object({}), output: runStateSchema });
export const diagnosticsLatestRpc = defineRpc({ name: "diagnostics.latest", input: z.object({}), output: runStateSchema });
// Applies one remedy the report offered, then re-runs the checks to report the result. Like run, it answers within
// about 20 seconds; a job still running is followed with diagnostics.repair-job.
export const diagnosticsRepairRpc = defineRpc({ name: "diagnostics.repair", input: z.object({ reportId: z.string().uuid(), remedyId: z.string().max(400) }), output: repairJobSchema });
export const diagnosticsRepairJobRpc = defineRpc({ name: "diagnostics.repair-job", input: z.object({ id: z.string().uuid() }), output: repairJobSchema });
