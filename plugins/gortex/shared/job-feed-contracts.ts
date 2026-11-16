import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { autoIndexActivityRpc } from "./auto-index-contracts.ts";
import { diagnosticsLatestRpc, diagnosticsRepairJobRpc } from "./diagnostics-contracts.ts";
import { suggestJobRpc } from "./exclusion-suggest-contracts.ts";
import { metadataJobRpc } from "./metadata-contracts.ts";
import { nativePickerPollRpc } from "./native-picker-contracts.ts";
import { trackJobRpc } from "./track-contracts.ts";
import { untrackJobRpc } from "./untrack-contracts.ts";
import { updateJobRpc } from "./update-contracts.ts";

// Plugin subscription contract (Paseo 0.16 on). Each kind pushes what its polling RPC answers, whenever that changes;
// the polling RPCs stay as they are for older apps and as the fallback.
export const jobFeedKinds = ["diagnostics", "diagnostics.repair", "update", "track", "untrack", "metadata", "suggest", "picker", "auto-index"] as const;
export const jobFeedInputSchema = z.object({ kind: z.enum(jobFeedKinds), id: z.string().uuid().optional() });
export type JobFeedInput = z.input<typeof jobFeedInputSchema>;
const feed = <Kind extends (typeof jobFeedKinds)[number], State extends z.ZodType>(kind: Kind, state: State) => z.object({ kind: z.literal(kind), state });
export const jobFeedEventSchema = z.discriminatedUnion("kind", [
  feed("diagnostics", diagnosticsLatestRpc.output),
  feed("diagnostics.repair", diagnosticsRepairJobRpc.output),
  feed("update", updateJobRpc.output),
  feed("track", trackJobRpc.output),
  feed("untrack", untrackJobRpc.output),
  feed("metadata", metadataJobRpc.output),
  feed("suggest", suggestJobRpc.output),
  feed("picker", nativePickerPollRpc.output),
  feed("auto-index", autoIndexActivityRpc.output),
]);
export type JobFeedEvent = z.input<typeof jobFeedEventSchema>;

/** Null where `defineSubscription` is missing: a Paseo host or app older than 0.16 has no subscriptions, so panels poll. */
export function jobFeedContract(define: typeof defineSubscription | undefined) {
  return typeof define === "function" ? define({ name: "jobs.follow", input: jobFeedInputSchema, event: jobFeedEventSchema }) : null;
}
export const jobFeedSubscription = jobFeedContract(defineSubscription);
