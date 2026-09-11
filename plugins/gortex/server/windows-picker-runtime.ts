import { homedir } from "node:os";
import { win32 } from "node:path";
import { z } from "zod";
import { runProcess } from "./process-runner.ts";
import { powershellArguments, WINDOWS_PICKER_PROBE } from "./windows-dialog.ts";

export type PickerRuntime =
  | { available: true; executable: string; reason: string }
  | { available: false; executable: null; reason: string };

const probeSchema = z.object({ status: z.enum(["ready", "powershell_version", "windows_forms", "desktop"]) });
const reasons = {
  powershell_version: "PowerShell 7 is required on this host. Install Microsoft.PowerShell, then try Browse again.",
  windows_forms: "PowerShell started, but the modern Windows Forms folder dialog is unavailable. Install or repair PowerShell 7 on this host, then try Browse again.",
  desktop: "No interactive Windows desktop is available to Paseo on this host. Run Paseo in a signed-in Windows desktop session; the folder dialog opens there, including through Remote Desktop.",
};

/** Probe a bounded set of installations without relying on Paseo's inherited PATH. */
export async function findWindowsPickerRuntime(dependencies: {
  run?: typeof runProcess; environment?: NodeJS.ProcessEnv; home?: string;
} = {}): Promise<PickerRuntime> {
  const environment = dependencies.environment ?? process.env;
  const home = dependencies.home ?? homedir();
  const candidates = ["pwsh.exe"];
  for (const root of [environment.ProgramW6432, environment.ProgramFiles, environment["ProgramFiles(x86)"]]) {
    if (root && win32.isAbsolute(root)) candidates.push(win32.join(root, "PowerShell", "7", "pwsh.exe"));
  }
  if (environment.LOCALAPPDATA && win32.isAbsolute(environment.LOCALAPPDATA)) {
    candidates.push(win32.join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  }
  if (win32.isAbsolute(home)) candidates.push(win32.join(home, ".dotnet", "tools", "pwsh.exe"));
  const unique = candidates.filter((candidate, index) => candidates.findIndex(other => other.toLowerCase() === candidate.toLowerCase()) === index);
  const deadline = Date.now() + 10000;
  let reason = "PowerShell 7 could not be started on this host. Install Microsoft.PowerShell on this host, or check its executable permissions, then try Browse again.";
  for (const executable of unique) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const output = await (dependencies.run ?? runProcess)(executable, powershellArguments(WINDOWS_PICKER_PROBE), home, { timeoutMs: Math.min(4000, remaining), maxBytes: 8192 });
      const { status } = probeSchema.parse(JSON.parse(output));
      if (status === "ready") return { available: true, executable, reason: "The dialog opens on this host's Windows desktop." };
      reason = reasons[status];
      if (status === "desktop") return { available: false, executable: null, reason };
    } catch (error) {
      // Do not expose subprocess output, environment values, or credentials in diagnostics.
      if (!(error instanceof Error && "code" in error && error.code === "process_unavailable")) {
        reason = "PowerShell's folder-picker check failed or returned an invalid response. Install or repair PowerShell 7 on this host, then try Browse again.";
      }
    }
  }
  return { available: false, executable: null, reason };
}
