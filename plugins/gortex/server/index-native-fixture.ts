// Explicit native integration exercise; never imported by the plugin runtime.
// Every daemon/config/store path and repository belongs to this temporary fixture.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { runProcess } from "./process-runner.ts";
import { GortexClient } from "./gortex-client.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { indexSummarySchema } from "../shared/health-models.ts";
import { NativeError } from "./native-response.ts";

const root = await mkdtemp(join(tmpdir(), "gx-index-"));
for (const key of Object.keys(process.env)) {
  if (/^(GORTEX_|XDG_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|OLLAMA_|AWS_|GEMINI_|GOOGLE_API_)/.test(key)) delete process.env[key];
}
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.GORTEX_DAEMON_SOCKET = join(root, "daemon.sock");
process.env.GORTEX_DAEMON_PIDFILE = join(root, "daemon.pid");
process.env.GORTEX_DAEMON_LOGFILE = join(root, "daemon.log");
process.env.GORTEX_TOOLS = "compact";
assert.ok(Buffer.byteLength(process.env.GORTEX_DAEMON_SOCKET) < 104);
const native = new GortexClient();
const library = new WorkspaceLibrary(native);
let started = false, pid = 0;
const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const repos = [];
  for (const [name, workspace, count] of [["alpha", "shared", 1], ["beta", "shared", 3], ["gamma", "separate", 5]] as const) {
    const path = join(root, name);
    await mkdir(path);
    await runProcess("git", ["init", "-q", path], root);
    for (let i = 0; i < count; i++) await writeFile(join(path, `source-${i}.ts`), `export function ${name}${i}() { return ${i}; }\n`);
    await writeFile(join(path, ".gortex.yaml"), "embedding:\n  enabled: false\nsemantic:\n  enabled: false\n");
    await runProcess("git", ["-C", path, "add", ".gortex.yaml", ...Array.from({ length: count }, (_, i) => `source-${i}.ts`)], root);
    await runProcess("git", ["-C", path, "-c", "user.name=Plugin fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "-q", "--no-gpg-sign", "-m", "Fixture"], root);
    repos.push({ name, workspace, project: name, path });
  }
  const configDir = join(process.env.XDG_CONFIG_HOME, "gortex");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.yaml"), stringify({ repos, embedding: { enabled: false }, mcp: { allow_embedded: false } }));
  started = true;
  await runProcess("gortex", ["daemon", "start", "--detach", "--backend-path", join(root, "fixture.sqlite"), "--tools", "compact", "--no-progress"], root, { timeoutMs: 30000, maxBytes: 16000 });
  pid = Number((await readFile(process.env.GORTEX_DAEMON_PIDFILE, "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  for (const repo of repos) {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const info = await native.info(repo.path);
        if (info.members.some(member => member.name === repo.name)) {
          assert.equal(info.workspace, repo.workspace);
          assert.equal(info.members.length, repo.workspace === "shared" ? 2 : 1);
          ready = true; break;
        }
      } catch { /* A warming isolated daemon may not admit the context yet. */ }
      await delay(500);
    }
    assert.ok(ready, `Fixture repository ${repo.name} did not become available`);
  }
  const counts = [];
  for (const repo of repos) {
    let completed = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      // Index-health admission can lag workspace identity during native startup.
      // Only retry this read in the isolated fixture; runtime failures remain visible.
      let report;
      try { report = await library.status({ workspaceId: repo.workspace, repositoryPath: repo.path }); }
      catch (error) {
        if (!(error instanceof NativeError) || error.code !== "mcp_error") throw error;
        if (attempt === 29) throw error;
        await delay(500); continue;
      }
      assert.equal(report.scope, "host");
      const parsed = indexSummarySchema.safeParse(report.value);
      if (parsed.success && parsed.data.index_complete) {
        const { indexed_file_count, node_count, edge_count } = parsed.data;
        counts.push({ indexed_file_count, node_count, edge_count });
        console.log(JSON.stringify({ selected: repo.name, workspace: repo.workspace, scope: report.scope, indexed_file_count, node_count, edge_count }));
        completed = true; break;
      }
      await delay(500);
    }
    assert.ok(completed, `Index report did not complete for ${repo.name}`);
  }
  // Nine different source files plus three repo config files: every workspace contributes.
  assert.equal(counts[0].indexed_file_count, 12);
  assert.deepEqual(counts[1], counts[0]);
  assert.deepEqual(counts[2], counts[0]);
  console.log("Native index fixture passed: the index report covers all three repos across two workspaces.");
} finally {
  library.close(); await native.close();
  let stopped = !started;
  if (started) {
    try { await runProcess("gortex", ["daemon", "stop"], root, { timeoutMs: 20000, maxBytes: 16000 }); stopped = true; }
    catch (error) { console.error(`Could not stop isolated index fixture: ${String(error)}`); }
    for (let attempt = 0; alive() && attempt < 40; attempt++) await delay(250);
  }
  const target = resolve(root), allowed = resolve(tmpdir()) + sep;
  assert.ok(target.startsWith(allowed) && target.includes("gx-index-"));
  if (stopped && !alive()) await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`Isolated fixture retained at ${root}`);
}
