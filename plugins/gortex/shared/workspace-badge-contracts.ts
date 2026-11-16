import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Plugin RPC contract, not a native Gortex operation name. One host-level read behind every workspace row's badge
// (Paseo 0.16 apps); a workspace with nothing to show is absent.
export const workspaceBadgeSchema = z.enum(["not-indexed", "paused"]);
export type WorkspaceBadge = z.infer<typeof workspaceBadgeSchema>;
export const workspaceBadgesRpc = defineRpc({ name: "workspace.badges", input: z.object({}), output: z.object({ badges: z.record(z.string(), workspaceBadgeSchema) }) });
