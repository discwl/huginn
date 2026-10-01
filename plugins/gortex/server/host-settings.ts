import { readFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { HostSettings } from "../shared/host-settings-contracts.ts";
import type { NativeAssignment } from "../shared/models.ts";
import { parseDaemonStatus } from "./daemon-status.ts";
import { runProcess } from "./process-runner.ts";
import { globalConfigPath } from "./repository-config.ts";

export interface HostSettingsIo {
  cli(args: string[]): Promise<string>;
  assignments(): Promise<NativeAssignment[]>;
  readRepoConfig(root: string): Promise<string | null>;
  cpuCount(): number;
  env(name: string): string | undefined;
}
const DISPATCH_ENV = "GORTEX_MCP_MAX_CONCURRENT_DISPATCHES";
const message = (error: unknown) => error instanceof Error ? error.message : "unavailable";

export function hostSettingsIo(assignments: () => Promise<NativeAssignment[]>): HostSettingsIo {
  return {
    cli: args => runProcess("gortex", args, homedir(), { timeoutMs: 30_000, maxBytes: 512 * 1024 }),
    assignments,
    readRepoConfig: root => readFile(join(root, ".gortex.yaml"), "utf8").catch(() => null),
    cpuCount: availableParallelism,
    env: name => process.env[name],
  };
}

/** index.workers from a repository's .gortex.yaml, the only place Gortex's daemon reads it from. */
export function pinnedWorkers(text: string | null): number | null {
  if (!text) return null;
  try {
    const value = (parse(text) as { index?: { workers?: unknown } } | null)?.index?.workers;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** Read-only. Nothing here changes Gortex, its configuration, or the environment. */
export async function readHostSettings(io: HostSettingsIo): Promise<HostSettings> {
  const warnings: string[] = [];
  const cpuCount = Math.max(1, io.cpuCount());
  const raw = io.env(DISPATCH_ENV)?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  if (raw && parsed === null) warnings.push(`${DISPATCH_ENV} is set to "${raw}", which Gortex ignores; it uses 8.`);

  let status = parseDaemonStatus("");
  try { status = parseDaemonStatus(await io.cli(["daemon", "status"])); }
  catch (error) { warnings.push(`Daemon status is unavailable: ${message(error)}`); }
  let service: string | null = null;
  try { service = (await io.cli(["daemon", "service-status"])).split(/\r?\n/).find(line => line.trim())?.trim() ?? null; }
  catch { /* Optional; older builds or unsupported platforms. */ }

  const repositories: HostSettings["repositories"] = [];
  try {
    for (const row of (await io.assignments()).slice(0, 50)) {
      const pinned = pinnedWorkers(await io.readRepoConfig(row.path));
      const workers = pinned ?? cpuCount;
      repositories.push({ name: row.repo, path: row.path, workers, source: pinned === null ? "cpu" : "repo", belowCpu: workers < cpuCount });
    }
  } catch (error) { warnings.push(`Tracked repositories are unavailable: ${message(error)}`); }

  return {
    observedAt: new Date().toISOString(), cpuCount,
    dispatchLimit: { configured: parsed === null ? null : Math.min(64, Math.max(1, parsed)), defaultValue: 8, maximum: 64 },
    daemon: { running: status.running, version: status.version, pid: status.pid, uptime: status.uptime, state: status.state, service },
    sessions: status.sessions.map(({ client, version, connected, cwd }) => ({ client, version, connected, cwd })),
    repositories, configPath: globalConfigPath(), warnings,
  };
}
