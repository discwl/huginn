import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

// Plugin RPC contracts, not native Gortex operation names.
export const gitStatusSchema = z.object({
  path: pathSchema,
  /** repository: has its own .git; inside: a subfolder of another repository; worktree: .git file; plain: no Git anywhere above. */
  state: z.enum(["repository", "inside", "worktree", "plain", "unavailable"]),
  root: pathSchema.nullable(),
  canInitialize: z.boolean(),
  reason: z.string().nullable(),
});
export type GitStatus = z.infer<typeof gitStatusSchema>;
export const gitStatusRpc = defineRpc({ name: "git.status", input: z.object({ path: pathSchema }), output: gitStatusSchema });
// Runs `git init` in a plain folder after the client's explicit confirmation. No files are staged or committed.
export const gitInitRpc = defineRpc({ name: "git.init", input: z.object({ path: pathSchema }), output: gitStatusSchema });
