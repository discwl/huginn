import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pathSchema } from "./models.ts";

// Plugin RPC contract: a read-only view of the Gortex settings that decide whether agents can start.
export const hostSettingsSchema = z.object({
  observedAt: z.string(), cpuCount: z.number().int().positive(),
  dispatchLimit: z.object({
    /** What a daemon started from this plugin's environment would get; the running daemon keeps the value it started with. */
    configured: z.number().int().nullable(), defaultValue: z.number().int(), maximum: z.number().int(),
  }),
  daemon: z.object({
    running: z.boolean(), version: z.string().nullable(), pid: z.number().int().nullable(),
    uptime: z.string().nullable(), state: z.string().nullable(), service: z.string().nullable(),
  }),
  sessions: z.array(z.object({ client: z.string(), version: z.string(), connected: z.string(), cwd: z.string() })).max(100),
  repositories: z.array(z.object({
    name: z.string(), path: pathSchema,
    workers: z.number().int().positive(),
    /** repo: pinned by index.workers in the repository's .gortex.yaml; cpu: Gortex's default, the CPU count. */
    source: z.enum(["repo", "cpu"]),
    belowCpu: z.boolean(),
  })).max(50),
  configPath: pathSchema,
  warnings: z.array(z.string()).max(10),
});
export type HostSettings = z.infer<typeof hostSettingsSchema>;
export const hostSettingsRpc = defineRpc({ name: "host.settings", input: z.object({}), output: hostSettingsSchema });
