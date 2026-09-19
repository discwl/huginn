import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

// Plugin RPC contracts, not native Gortex operation names.
const patternSchema = z.string().min(1).max(512).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith("!"), "A single gitignore-style pattern without a leading !");
export const ruleSuggestionSchema = z.object({
  pattern: patternSchema,
  reason: z.string().min(1).max(400),
  confidence: z.enum(["high", "medium", "low"]),
});
export type RuleSuggestion = z.infer<typeof ruleSuggestionSchema>;
export const exclusionSuggestionSchema = z.object({
  exclude: z.array(ruleSuggestionSchema).max(40),
  /** Patterns to keep indexed despite .gitignore or a broader exclusion; applied as `!pattern`. */
  include: z.array(ruleSuggestionSchema).max(20),
  notes: z.string().max(1200),
});
export type ExclusionSuggestion = z.infer<typeof exclusionSuggestionSchema>;

/** JSON Schema handed to the agent as its structured output contract; mirrors exclusionSuggestionSchema. */
export const exclusionSuggestionJsonSchema = {
  type: "object", additionalProperties: false, required: ["exclude", "include", "notes"],
  properties: {
    exclude: { type: "array", maxItems: 40, items: { $ref: "#/$defs/rule" } },
    include: { type: "array", maxItems: 20, items: { $ref: "#/$defs/rule" } },
    notes: { type: "string", maxLength: 1200 },
  },
  $defs: {
    rule: {
      type: "object", additionalProperties: false, required: ["pattern", "reason", "confidence"],
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 512, description: "gitignore-style pattern relative to the repository root, without a leading !" },
        reason: { type: "string", minLength: 1, maxLength: 400 },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
    },
  },
} as const;

export const suggestJobSchema = z.object({
  id: z.string().uuid(), path: pathSchema, agent: z.string(),
  stage: z.enum(["gathering", "starting", "thinking", "done"]),
  outcome: z.enum(["running", "ready", "failed"]),
  agentId: z.string().nullable(), startedAt: z.string(), finishedAt: z.string().nullable(),
  suggestion: exclusionSuggestionSchema.nullable(),
  /** Suggestions dropped because they were invalid or already configured. */
  dropped: z.array(z.string()).max(60),
  error: z.string().nullable(),
});
export type SuggestJob = z.infer<typeof suggestJobSchema>;
export const suggestStartRpc = defineRpc({ name: "exclusions.suggest.start", input: z.object({ path: pathSchema }), output: suggestJobSchema });
export const suggestJobRpc = defineRpc({ name: "exclusions.suggest.job", input: z.object({ id: z.string().uuid() }), output: suggestJobSchema });
export const suggestLatestRpc = defineRpc({ name: "exclusions.suggest.latest", input: z.object({ path: pathSchema }), output: z.object({ job: suggestJobSchema.nullable() }) });
