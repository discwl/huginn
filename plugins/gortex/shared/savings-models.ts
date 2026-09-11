import { z } from "zod";
const count = z.number().int().nonnegative();
export const savingsBucketSchema = z.object({ label: z.string().min(1).max(100), calls_counted: count, tokens_returned: count, tokens_saved: count, percent_saved: z.number().min(0).max(100) });
export const nativeSavingsSchema = z.object({ buckets: z.array(savingsBucketSchema).min(1).max(10), last_updated: z.string() });
export const hostSavingsSchema = z.object({ scope: z.literal("host"), observedAt: z.string(), lastUpdated: z.string(), buckets: z.array(savingsBucketSchema).min(1).max(10) });
