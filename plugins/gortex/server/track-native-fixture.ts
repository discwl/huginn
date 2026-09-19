// Runs native tracking only against a temporary configuration, database and daemon.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GortexClient } from "./gortex-client.ts";
import { RepositoryTrack } from "./repository-track.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { runProcess } from "./process-runner.ts";

const plain = process.argv.includes("plain");
const root = await realpath(await mkdtemp(join(tmpdir(), "gx-track-")));
for (const key of Object.keys(process.env)) if (/^(GORTEX_|XDG_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|OLLAMA_|AWS_|GEMINI_|GOOGLE_API_)/.test(key)) delete process.env[key];
process.env.XDG_CONFIG_HOME = join(root, "config"); process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.GORTEX_DAEMON_SOCKET = join(root, "daemon.sock"); process.env.GORTEX_DAEMON_PIDFILE = join(root, "daemon.pid"); process.env.GORTEX_DAEMON_LOGFILE = join(root, "daemon.log"); process.env.GORTEX_TOOLS = "compact";
assert.ok(Buffer.byteLength(process.env.GORTEX_DAEMON_SOCKET) < 104);
const native = new GortexClient(), library = new WorkspaceLibrary(native), service = new RepositoryTrack(native, () => library.close());
let started = false, pid = 0;
const alive = () => { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } };
try {
  const configDir = join(process.env.XDG_CONFIG_HOME, "gortex"); await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, "repos: []\nembedding:\n  enabled: false\nmcp:\n  allow_embedded: false\n");
  const path = join(root, "new café repo"); await mkdir(path);
  // `plain` runs the same flow on a folder with no Git repository.
  if (!plain) await runProcess("git", ["init", "-q", path], root);
  const source = "export function fixtureAnswer() { return 42; }\n";
  await writeFile(join(path, "answer.ts"), source);
  await writeFile(join(path, ".gortex.yaml"), "workspace: fixture-workspace\nproject: automation\nembedding:\n  enabled: false\nsemantic:\n  enabled: false\n");
  started = true;
  await runProcess("gortex", ["daemon", "start", "--detach", "--backend-path", join(root, "fixture.sqlite"), "--tools", "compact", "--no-progress"], root, { timeoutMs: 30000, maxBytes: 16000 });
  pid = Number((await readFile(process.env.GORTEX_DAEMON_PIDFILE, "utf8")).trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const before = await readFile(configPath, "utf8");
  const projects = [{ id: "paseo-fixture", name: "Automation", path }];
  const initial = await library.catalog(0, { paseoProjects: projects });
  assert.equal(initial.repositories[0].state, "untracked");
  const preview = await service.preview(path); assert.equal(await readFile(configPath, "utf8"), before);
  const first = service.apply(preview.id); assert.equal(service.apply(preview.id).id, first.id);
  let job = first;
  for (let attempt = 0; attempt < 400 && job.stage !== "done"; attempt++) { await delay(250); job = service.job(first.id); }
  assert.ok(["tracked", "indexing"].includes(job.outcome), `Tracking failed: ${job.error}`);
  assert.equal(job.registered, true);
  const rows = await native.assignments(); assert.equal(rows.length, 1); assert.equal(await realpath(rows[0].path), path);
  let queried = false, lastError = "";
  for (let attempt = 0; attempt < 40 && !queried; attempt++) {
    try {
      const info = await native.info(path);
      assert.equal(info.workspace, "fixture-workspace"); assert.equal(info.project, "automation");
      const result = await native.query(path, "search", { query: "fixtureAnswer", workspace: info.workspace, repo: info.members[0].name, limit: 10 });
      const matches = (result.value as { results?: { name: string }[] }).results ?? [];
      queried = matches.some(match => match.name === "fixtureAnswer");
    } catch (error) { lastError = String(error); }
    if (!queried) await delay(250);
  }
  assert.ok(queried, `The newly tracked repository never returned its indexed symbol: ${lastError}`);
  library.close();
  const refreshed = await library.catalog(0, { paseoProjects: projects });
  assert.equal(refreshed.total, 1); assert.equal(refreshed.repositories[0].state, "resolved");
  assert.equal(await readFile(join(path, "answer.ts"), "utf8"), source);
  await assert.rejects(service.preview(path), /already tracked/i);
  console.log((plain ? "[plain folder] " : "") + "Native first-repository tracking, workspace/project defaults, searchable index, Unicode paths, duplicate prevention and source preservation passed.");
} finally {
  await service.close(); library.close(); await native.close();
  let stopped = !started;
  if (started) {
    try { await runProcess("gortex", ["daemon", "stop"], root, { timeoutMs: 20000, maxBytes: 16000 }); stopped = true; }
    catch (error) { console.error(`Could not stop isolated fixture daemon: ${String(error)}`); }
    for (let attempt = 0; alive() && attempt < 40; attempt++) await delay(250);
  }
  const target = resolve(root), allowed = resolve(tmpdir()) + sep;
  assert.ok(target.startsWith(allowed) && target.includes("gx-track-"));
  if (stopped && !alive()) await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`Isolated fixture retained at ${root}`);
}
