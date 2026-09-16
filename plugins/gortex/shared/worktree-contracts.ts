import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

export const worktreeSchema = z.object({
  path: z.string(), branch: z.string().nullable(), commit: z.string().nullable(),
  gitPresent: z.boolean(), locked: z.boolean(), prunable: z.boolean(),
  headMismatch: z.boolean(), nativeCommit: z.string().nullable(),
  repositoryIndex: z.enum(["indexed", "stale", "not-indexed"]).nullable(), indexedAt: z.string().nullable(),
  checkoutId: z.string().nullable(), primary: z.boolean(),
  status: z.enum(["ready", "building", "unavailable", "unknown", "unregistered"]),
  state: z.string().nullable(), mode: z.string().nullable(), coordinatorLive: z.boolean().nullable(),
  routeState: z.string().nullable(), graph: z.string().nullable(),
  lastSeen: z.number().nullable(), lastError: z.string().nullable(),
  transition: z.string().nullable(), intents: z.array(z.string()),
  availabilityDeadline: z.number().nullable(), removalDeadline: z.number().nullable(),
});
export const worktreePageSchema = z.object({
  repositoryPath: z.string(), observedAt: z.string(), nativeError: z.string().nullable(), gitError: z.string().nullable(),
  familyId: z.string().nullable(), primaryGraph: z.string().nullable(), indexError: z.string().nullable(),
  rows: z.array(worktreeSchema), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), nextOffset: z.number().nullable(),
});
export const worktreesRpc = defineRpc({ name: "repository.worktrees", input: z.object({ path: pathSchema, offset: z.number().int().min(0).max(10000).default(0) }), output: worktreePageSchema });
export type Worktree = z.infer<typeof worktreeSchema>;
export type WorktreePage = z.infer<typeof worktreePageSchema>;
