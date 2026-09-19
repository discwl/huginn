import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Plugin RPC contracts for updating this plugin through Paseo's own Git-managed update flow.
export const pluginUpdateStatusSchema = z.object({
  /** update: newer commit available; current: up to date; local: installed from a folder; installed-newer: ahead of the tracked ref. */
  state: z.enum(["update", "current", "installed-newer", "local", "error", "unavailable"]),
  current: z.string().nullable(), target: z.string().nullable(),
  links: z.array(z.string()).max(10), checkedAt: z.string(), error: z.string().nullable(),
});
export type PluginUpdateStatus = z.infer<typeof pluginUpdateStatusSchema>;
export const pluginUpdateCheckRpc = defineRpc({ name: "plugin-update.check", input: z.object({}), output: pluginUpdateStatusSchema });
// Starts `paseo plugin update gortex --yes` in the background after confirming the target the user reviewed.
// The plugin reloads when it finishes, so the client rechecks instead of waiting on this call.
export const pluginUpdateApplyRpc = defineRpc({ name: "plugin-update.apply", input: z.object({ target: z.string().min(1).max(200) }), output: z.object({ started: z.literal(true) }) });
