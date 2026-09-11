import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../", import.meta.url));
const options = { cwd: directory, stdio: "inherit", shell: false, windowsHide: true };
const installArgs = ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"];

function run(executable, args) {
  const result = spawnSync(executable, args, options);
  if (result.error) {
    console.error(`Cannot run ${executable}: ${result.error.message}. Install Node.js and npm on the Paseo host.`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Paseo runs argv arrays without a shell. Windows npm is a .cmd launcher, so only
// this fixed install command goes through cmd.exe; no paths or input are interpolated.
if (process.platform === "win32") {
  run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm ci --include=dev --ignore-scripts --no-audit --no-fund"]);
} else {
  run("npm", installArgs);
}
run(process.execPath, [join(directory, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]);
