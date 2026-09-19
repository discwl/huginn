import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { PluginUpdateStatus } from "../shared/plugin-update-contracts.ts";
import { resolveHostExecutable } from "./host-executable.ts";
import { runProcess } from "./process-runner.ts";

const PLUGIN_ID = "gortex";
// Fixed argument lists only: nothing user-supplied reaches the command line.
const CHECK = ["plugin", "update", PLUGIN_ID, "--check", "--json"];
const APPLY = ["plugin", "update", PLUGIN_ID, "--yes", "--json"];

export interface PluginUpdaterIo {
  run(args: string[]): Promise<string>;
  /** Starts the update so it survives this plugin process, which Paseo stops and replaces during the update. */
  start(args: string[]): Promise<void>;
  now(): Date;
}

/** The Paseo CLI: a native binary elsewhere, a .cmd launcher on Windows that only cmd.exe can run. */
async function paseoCommand(args: string[]): Promise<{ file: string; args: string[] }> {
  if (process.platform !== "win32") return { file: await resolveHostExecutable("paseo"), args };
  const pathKey = Object.keys(process.env).sort().find(key => key.toLowerCase() === "path");
  for (let directory of (pathKey ? process.env[pathKey] ?? "" : "").split(delimiter)) {
    if (directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
    if (!isAbsolute(directory)) continue;
    const launcher = join(directory, "paseo.cmd");
    try { await access(launcher, constants.F_OK); } catch { continue; }
    if (/["%^&|<>]/.test(launcher)) throw new Error("The Paseo CLI path contains characters that cannot be passed to cmd.exe safely.");
    const comspec = process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : "C:\\Windows\\System32\\cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", `""${launcher}" ${args.join(" ")}"`] };
  }
  throw new Error("The Paseo CLI was not found on this host's PATH.");
}

const hostIo: PluginUpdaterIo = {
  run: async args => { const command = await paseoCommand(args); return runProcess(command.file, command.args, process.cwd(), { timeoutMs: 90_000, maxBytes: 1024 * 1024, windowsVerbatimArguments: process.platform === "win32" }); },
  start: async args => {
    const command = await paseoCommand(args);
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  },
  now: () => new Date(),
};

type Preview = { id?: unknown; outcome?: unknown; current?: { currentRevision?: unknown } | null; target?: { kind?: unknown; commit?: unknown; version?: unknown } | null; links?: unknown; error?: unknown };
const short = (value: unknown) => typeof value === "string" && value ? value : null;

/** Checks and applies updates for this plugin using Paseo's own `plugin update` flow (Git-managed installs only). */
export class PluginUpdater {
  private io: PluginUpdaterIo;
  private started = false;
  constructor(io: Partial<PluginUpdaterIo> = {}) { this.io = { ...hostIo, ...io }; }

  async check(): Promise<PluginUpdateStatus> {
    const checkedAt = this.io.now().toISOString();
    let output: string;
    try { output = await this.io.run(CHECK); }
    catch (error) { return { state: "unavailable", current: null, target: null, links: [], checkedAt, error: error instanceof Error ? error.message : "The Paseo CLI could not be run." }; }
    let items: unknown;
    try { items = JSON.parse(output.slice(output.indexOf("["))); }
    catch { return { state: "error", current: null, target: null, links: [], checkedAt, error: "Paseo returned an unreadable update check." }; }
    const item = (Array.isArray(items) ? items : []).find((entry: Preview) => entry?.id === PLUGIN_ID) as Preview | undefined;
    if (!item) return { state: "error", current: null, target: null, links: [], checkedAt, error: "Paseo did not report this plugin in its update check." };
    const known = ["update", "current", "installed-newer", "local", "error"] as const;
    const state = known.find(value => value === item.outcome) ?? "error";
    return {
      state, checkedAt,
      current: short(item.current?.currentRevision),
      target: short(item.target?.kind === "git" ? item.target.commit : item.target?.version),
      links: Array.isArray(item.links) ? item.links.filter((link): link is string => typeof link === "string" && /^https:\/\//.test(link)).slice(0, 10) : [],
      error: state === "error" ? short(item.error) ?? (known.includes(item.outcome as never) ? "The update check failed." : `Unknown update outcome: ${String(item.outcome)}`) : null,
    };
  }

  /** Confirms the reviewed target is still the latest, then starts the update in the background. */
  async apply(target: string): Promise<{ started: true }> {
    if (this.started) throw new Error("An update is already starting. Wait for Gortex to reload.");
    const status = await this.check();
    if (status.state !== "update") throw new Error(status.state === "current" ? "The plugin is already up to date." : status.error ?? `No update is available (${status.state}).`);
    if (status.target !== target) throw new Error("A newer update appeared since you checked. Review it before updating.");
    this.started = true;
    try { await this.io.start(APPLY); }
    catch (error) { this.started = false; throw error; }
    return { started: true };
  }
}
