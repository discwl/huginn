import { z } from "zod";

// Preserve order, negations and escaping: these are native gitignore patterns, not shell arguments.
export const exclusionPatternsSchema = z.array(z.string().min(1).max(2048).refine(
  value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value),
  "Use one non-empty pattern per line without control characters",
)).max(2000).refine(patterns => patterns.reduce((size, pattern) => size + pattern.length, 0) <= 65536, "Exclusions exceed the 64 KiB editor budget");

export function parseExclusionLines(text: string): string[] {
  return exclusionPatternsSchema.parse(text.split(/\r?\n/).filter(line => line.trim().length > 0));
}

export const exclusionSourcesSchema = z.object({
  global: z.array(z.string()), local: z.array(z.string()), include: z.array(z.string()),
  legacyIndex: z.array(z.string()), legacyWatch: z.array(z.string()), respectGitignore: z.boolean(),
});
export type ExclusionSources = z.infer<typeof exclusionSourcesSchema>;
