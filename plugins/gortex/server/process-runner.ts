import { spawn } from "node:child_process";
import { NativeError } from "./native-response.ts";
import { resolveHostExecutable } from "./host-executable.ts";

export async function runProcess(command: string, args: readonly string[], cwd: string, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const executable = await resolveHostExecutable(command);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => finish(new NativeError("timeout", "Host command timed out; no automatic replay was attempted.")), options.timeoutMs ?? 15000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) finish(new NativeError("output_limit", "Native output exceeded the configured size bound."));
      else chunks.push(data);
    });
    // Drain stderr without logging possibly sensitive native data.
    child.stderr.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) finish(new NativeError("output_limit", "Native output exceeded the configured size bound."));
    });
    child.once("error", () => finish(new NativeError("process_unavailable", "Cannot start the configured host executable. Check its path and permissions.")));
    child.once("close", code => finish(code === 0 ? undefined : new NativeError("process_failed", `Host command failed (exit ${code ?? "unknown"}). Check the selected path and installed native tools.`)));
  });
}
