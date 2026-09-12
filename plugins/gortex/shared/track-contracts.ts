import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema, repositorySchema } from "./models.ts";

export const trackPreviewSchema = z.object({
  id: z.string().uuid(), expiresAt: z.string(), path: pathSchema, name: z.string(),
  warnings: z.array(z.string()),
});
export const trackJobSchema = z.object({
  id: z.string().uuid(), path: pathSchema,
  stage: z.enum(["validating", "tracking", "verifying", "done"]),
  outcome: z.enum(["running", "tracked", "indexing", "failed", "uncertain"]),
  registered: z.boolean().nullable(), repository: repositorySchema.nullable(), error: z.string().nullable(),
});
export type TrackPreview = z.infer<typeof trackPreviewSchema>;
export type TrackJob = z.infer<typeof trackJobSchema>;

export const trackReadinessIntervalMs = 3000;
export const trackReadinessBudgetMs = 60_000;
type ReadinessObservation = {
  read: () => Promise<TrackJob>;
  onJob: (job: TrackJob) => void;
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
function waitForReadiness(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
/** Observe only while the owning dialog is open. A rejected read ends this window. */
export async function observeTrackReadiness({ read, onJob, signal, now = Date.now, wait = waitForReadiness }: ReadinessObservation): Promise<"ready" | "pending" | "stopped"> {
  if (signal.aborted) return "stopped";
  const controller = new AbortController(), stop = () => { controller.abort(); };
  signal.addEventListener("abort", stop, { once: true });
  const deadline = now() + trackReadinessBudgetMs;
  const window = waitForReadiness(trackReadinessBudgetMs, controller.signal).then(() => {
    if (controller.signal.aborted) return "stopped" as const;
    controller.abort(); return "pending" as const;
  });
  const observe = async () => {
    for (let attempt = 0; attempt < trackReadinessBudgetMs / trackReadinessIntervalMs; attempt++) {
      if (controller.signal.aborted) return "stopped" as const;
      if (now() + trackReadinessIntervalMs > deadline) return "pending" as const;
      await wait(trackReadinessIntervalMs, controller.signal);
      if (controller.signal.aborted) return "stopped" as const;
      if (now() > deadline) return "pending" as const;
      const job = await read();
      if (controller.signal.aborted) return "stopped" as const;
      onJob(job);
      if (job.stage !== "done" || job.outcome !== "indexing") return job.outcome === "tracked" ? "ready" as const : "stopped" as const;
    }
    return "pending" as const;
  };
  try { return await Promise.race([observe(), window]); }
  finally { controller.abort(); signal.removeEventListener("abort", stop); }
}
export const trackPreviewRpc = defineRpc({ name: "track.preview", input: z.object({ path: pathSchema }), output: trackPreviewSchema });
export const trackApplyRpc = defineRpc({ name: "track.apply", input: z.object({ id: z.string().uuid() }), output: trackJobSchema });
export const trackJobRpc = defineRpc({ name: "track.job", input: z.object({ id: z.string().uuid(), observe: z.boolean().optional() }), output: trackJobSchema });
