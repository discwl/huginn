import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { runProcess } from "./process-runner.ts";
import { powershellArguments, WINDOWS_PICKER_PROBE, WINDOWS_PICKER_SCRIPT } from "./windows-dialog.ts";

type PickerState = { id: string; state: "open" | "selected" | "cancelled" | "error"; path: string | null; error: string | null };
type Job = { result: PickerState; child: ChildProcess; timer: ReturnType<typeof setTimeout>; finishedAt: number | null };
type Dependencies = { platform?: string; spawn?: typeof spawn; probe?: () => Promise<boolean>; timeoutMs?: number };
const replySchema = z.discriminatedUnion("state", [z.object({ state: z.literal("selected"), path: z.string().min(1).max(32767) }), z.object({ state: z.literal("cancelled"), path: z.null() })]);

export class NativeFolderPicker {
  private jobs = new Map<string, Job>();
  private starting = false;
  private closed = false;
  private capability: Promise<{ available: boolean; reason: string }> | null = null;
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies = {}) { this.dependencies = dependencies; }

  capabilities() {
    if (!this.capability) this.capability = (async () => {
      if ((this.dependencies.platform ?? process.platform) !== "win32") return { available: false, reason: "The folder picker requires a Windows host." };
      try {
        const available = this.dependencies.probe ? await this.dependencies.probe() : z.object({ available: z.boolean() }).parse(JSON.parse(await runProcess("pwsh.exe", powershellArguments(WINDOWS_PICKER_PROBE), homedir()))).available;
        return { available, reason: available ? "The dialog opens on this host's Windows desktop." : "No interactive Windows desktop is available on this host." };
      } catch { return { available: false, reason: "The folder picker requires PowerShell 7 with Windows Forms and an interactive Windows desktop." }; }
    })();
    return this.capability;
  }

  async start(initialPath?: string) {
    this.prune();
    if (this.closed) throw new Error("The plugin is stopping.");
    if (this.starting || [...this.jobs.values()].some(job => job.result.state === "open")) throw new Error("A folder picker is already open on this Windows host. Finish or cancel it first.");
    this.starting = true;
    try {
      const capability = await this.capabilities();
      if (!capability.available) throw new Error(capability.reason);
      const path = initialPath ?? homedir();
      if (!isAbsolute(path) || path.includes("\0")) throw new Error("Choose an absolute folder path.");
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) throw new Error("The selected starting path is not a folder.");
      if (this.closed) throw new Error("The plugin is stopping.");
      const id = randomUUID();
      const child = (this.dependencies.spawn ?? spawn)("pwsh.exe", powershellArguments(WINDOWS_PICKER_SCRIPT), { cwd: homedir(), shell: false, windowsHide: true, env: { ...process.env, PASEO_GORTEX_PICKER_START: canonical }, stdio: ["ignore", "pipe", "pipe"] });
      const job: Job = { result: { id, state: "open", path: null, error: null }, child, timer: setTimeout(() => this.finish(id, "error", null, "The Windows picker timed out. Open it again to choose a folder.", true), this.dependencies.timeoutMs ?? 120000), finishedAt: null };
      job.timer.unref();
      this.jobs.set(id, job);
      let output = "";
      const decoder = new StringDecoder("utf8");
      let bytes = 0;
      const collect = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 131072) this.finish(id, "error", null, "The Windows picker returned too much output.", true);
        else if (stdout) output += decoder.write(chunk);
      };
      child.stdout?.on("data", chunk => collect(Buffer.from(chunk), true));
      child.stderr?.on("data", chunk => collect(Buffer.from(chunk), false));
      child.once("error", () => this.finish(id, "error", null, "Windows could not start the folder picker.", true));
      child.once("close", code => { void this.complete(id, code, output + decoder.end()); });
      return { id };
    } finally { this.starting = false; }
  }

  private async complete(id: string, code: number | null, output: string) {
    if (this.jobs.get(id)?.result.state !== "open") return;
    try {
      if (code !== 0) throw new Error("The Windows picker closed unexpectedly. Use the in-app browser or try again.");
      const reply = replySchema.parse(JSON.parse(output.replace(/^\uFEFF/, "")));
      if (reply.state === "cancelled") { this.finish(id, "cancelled"); return; }
      if (!isAbsolute(reply.path) || reply.path.includes("\0")) throw new Error("Windows returned an invalid folder path.");
      const canonical = await realpath(reply.path);
      if (!(await stat(canonical)).isDirectory()) throw new Error("The selected folder is no longer available.");
      this.finish(id, "selected", canonical);
    } catch (error) { this.finish(id, "error", null, error instanceof z.ZodError || error instanceof SyntaxError ? "Windows returned an invalid picker result." : error instanceof Error ? error.message : "Folder selection failed."); }
  }

  private finish(id: string, state: Exclude<PickerState["state"], "open">, path: string | null = null, error: string | null = null, kill = false) {
    const job = this.jobs.get(id);
    if (!job || job.result.state !== "open") return;
    clearTimeout(job.timer);
    job.result = { id, state, path, error };
    job.finishedAt = Date.now();
    if (kill) job.child.kill(); // Only the helper created for this job; never Explorer or Paseo.
  }
  poll(id: string): PickerState { this.prune(); const job = this.jobs.get(id); if (!job) throw new Error("This folder selection expired. Open the picker again."); return { ...job.result }; }
  cancel(id: string) { const open = this.jobs.get(id)?.result.state === "open"; if (open) this.finish(id, "cancelled", null, null, true); return { cancelled: open }; }
  close() { this.closed = true; for (const id of this.jobs.keys()) this.cancel(id); this.jobs.clear(); }
  private prune() { for (const [id, job] of this.jobs) if (job.finishedAt !== null && (Date.now() - job.finishedAt > 120000 || this.jobs.size > 10)) this.jobs.delete(id); }
}
