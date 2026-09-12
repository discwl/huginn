import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { NativeError } from "./native-response.ts";

function absoluteHostPath(value: string): boolean {
  // Windows also calls \\tools and C:tools absolute/rooted in some APIs; both depend on cwd.
  return isAbsolute(value) && (process.platform !== "win32" || win32.parse(value).root.length > 1);
}

function executableNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  // shell:false supports native executables, not PATHEXT script/shell relays.
  return /\.(?:com|exe)$/i.test(command) ? [command] : [`${command}.com`, `${command}.exe`];
}

/** Resolve before supplying a repository cwd to a process launcher. */
export async function resolveHostExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let candidates: string[] = [];
  if (absoluteHostPath(command)) {
    candidates = executableNames(command);
  } else if (command && !(process.platform === "win32" ? /[\\/:]/ : /\//).test(command)) {
    // Node chooses the first lexicographically sorted case-insensitive key on Windows.
    const pathKey = process.platform === "win32" ? Object.keys(env).sort().find(key => key.toLowerCase() === "path") : "PATH";
    const path = (pathKey === undefined ? undefined : env[pathKey]) ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
    for (let directory of path.split(delimiter)) {
      if (process.platform === "win32" && directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
      // Empty, relative, drive-relative, and root-relative entries can point inside a candidate repository.
      if (!absoluteHostPath(directory)) continue;
      candidates.push(...executableNames(command).map(name => join(directory, name)));
    }
  }
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Continue through the operator's absolute PATH entries. */ }
  }
  throw new NativeError("process_unavailable", "Cannot resolve the configured host executable. Install it in an absolute PATH directory or configure an absolute executable path.");
}
