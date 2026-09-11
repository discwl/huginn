// Explicit native administration test. Owns only temporary repositories and a fully isolated daemon.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GortexClient } from "./gortex-client.ts";
import { RepositoryUntrack } from "./repository-untrack.ts";
import { runProcess } from "./process-runner.ts";
import { decodeNativeResult } from "./native-response.ts";

const root = await mkdtemp(join(tmpdir(), "gx-untrack-"));
for (const key of Object.keys(process.env)) if (/^(GORTEX_|XDG_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|OLLAMA_|AWS_|GEMINI_|GOOGLE_API_)/.test(key)) delete process.env[key];
process.env.XDG_CONFIG_HOME = join(root, "config"); process.env.XDG_DATA_HOME = join(root, "data"); process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.GORTEX_DAEMON_SOCKET = join(root, "daemon.sock"); process.env.GORTEX_DAEMON_PIDFILE = join(root, "daemon.pid"); process.env.GORTEX_DAEMON_LOGFILE = join(root, "daemon.log"); process.env.GORTEX_TOOLS = "compact";
assert.ok(Buffer.byteLength(process.env.GORTEX_DAEMON_SOCKET) < 104);
const native = new GortexClient(), service = new RepositoryUntrack(native);
let started = false, pid = 0;
const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function done(id: string) {
  let job = service.job(id); const deadline = Date.now() + 150000;
  while (job.stage !== "done" && Date.now() < deadline) { await delay(200); job = service.job(id); }
  assert.equal(job.stage, "done");
  console.log(JSON.stringify({ outcome: job.outcome, plan: job.preview?.native?.plan ?? job.receipt?.plan, error: job.error }));
  return job;
}
async function register(path: string, name: string, asWorktree = false) {
  assert.ok(resolve(path).startsWith(resolve(root) + sep));
  const client = new Client({ name: "paseo-untrack-fixture", version: "0.1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  try {
    await client.connect(new StdioClientTransport({ command: "gortex", args: ["mcp", "--proxy", "--tools", "compact"], cwd: path, env, stderr: "ignore" }), { timeout: 15000 });
    const registered = await client.callTool({ name: "workspace_admin", arguments: { operation: "track", arguments: { path, name, as_worktree: asWorktree } } }, undefined, { timeout: 30000 });
    try { decodeNativeResult(registered); } catch (error) { console.error(JSON.stringify(registered).slice(0, 4000)); throw error; }
  } finally { await client.close(); }
  await native.refreshContexts();
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const info = await native.info(path); if (info.members.some(member => member.name === name)) return; } catch { /* Wait for this isolated registration only. */ }
    await delay(300);
  }
  throw new Error(`Isolated registration did not settle for ${name}`);
}
try {
  const repos = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const path = join(root, `${name} repo`); await mkdir(path);
    await runProcess("git", ["init", "-q", path], root);
    await writeFile(join(path, "index.ts"), `export function ${name}Value() { return 42; }\n`);
    await writeFile(join(path, ".gortex.yaml"), `workspace: fixture-${name}\nproject: sample\nembedding:\n  enabled: false\nsemantic:\n  enabled: false\n`);
    await runProcess("git", ["-C", path, "add", "index.ts", ".gortex.yaml"], root);
    await runProcess("git", ["-C", path, "-c", "user.name=Plugin fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "-q", "--no-gpg-sign", "-m", "Fixture"], root);
    repos.push({ path, name, workspace: `fixture-${name}`, project: "sample" });
  }
  const configDir = join(process.env.XDG_CONFIG_HOME, "gortex"); await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  await writeFile(configPath, stringify({ repos: repos.slice(1), embedding: { enabled: false }, mcp: { allow_embedded: false } }));
  started = true;
  await runProcess("gortex", ["daemon", "start", "--detach", "--backend-path", join(root, "fixture.sqlite"), "--tools", "compact", "--no-progress"], root, { timeoutMs: 30000, maxBytes: 16000 });
  pid = Number((await readFile(process.env.GORTEX_DAEMON_PIDFILE, "utf8")).trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  for (const repo of repos.slice(1)) {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await service.preview(repo.path); ready = true; break; } catch { await delay(300); }
    }
    assert.ok(ready, `Fixture ${repo.name} did not become ready`);
  }
  const original = await readFile(configPath, "utf8"), otherBefore = await native.info(repos[1].path);
  const ordinary = await service.preview(repos[2].path);
  assert.equal(await readFile(configPath, "utf8"), original);
  let removed = await done(service.apply(ordinary.id).id);
  if (removed.outcome === "review") removed = await done(service.apply(removed.preview!.id).id);
  assert.equal(removed.outcome, "untracked"); assert.equal(removed.configRemoved, true);
  assert.equal(await readFile(join(repos[2].path, "index.ts"), "utf8"), "export function gammaValue() { return 42; }\n");
  console.log("Ordinary untracking preserves source and removes native configuration.");

  await register(repos[0].path, "alpha");
  const checkoutCatalog = (await native.checkouts(repos[0].path)).value as { families: unknown[] };
  if (checkoutCatalog.families.length > 0) {
    const worktree = join(root, "feature worktree");
    await runProcess("git", ["-C", repos[0].path, "worktree", "add", "-q", "-b", "fixture-feature", worktree], root);
    await native.info(worktree);
    assert.ok(!(await native.assignments()).some(row => row.path === worktree), "Automatic worktree must not gain a config entry");
    await register(worktree, "alpha-feature", true);
    const dedicated = await service.preview(worktree);
    const demoted = await done(service.apply(dedicated.id).id);
    assert.equal(demoted.outcome, "demoted"); assert.equal(demoted.configRemoved, true);
    await native.info(worktree);
    assert.ok(!(await native.assignments()).some(row => row.path === worktree));
    console.log("Dedicated worktree untracking demotes into the automatic lane.");
    const primary = await service.preview(repos[0].path), beforePrimary = await readFile(configPath, "utf8");
    const review = await done(service.apply(primary.id).id);
    assert.equal(review.outcome, "review"); assert.equal(review.preview?.native?.plan, "primary_closure");
    assert.equal(await readFile(configPath, "utf8"), beforePrimary, "Native primary preview must not remove tracking");
    assert.ok(review.preview!.native!.closure.length > 0, "Primary preview must expose dependent views");
    const final = await done(service.apply(review.preview!.id).id);
    assert.equal(final.outcome, "untracked"); assert.equal(final.configRemoved, true);
    assert.equal(await readFile(join(worktree, "index.ts"), "utf8"), "export function alphaValue() { return 42; }\n");
    console.log("Native worktree demotion and primary confirmation passed.");
  } else {
    console.log("SKIP native worktree demotion/primary closure: this installed daemon exposes no checkout families, including after explicit fixture registration. Those response paths have unit coverage only on this host.");
    const final = await done(service.apply((await service.preview(repos[0].path)).id).id);
    assert.equal(final.outcome, "untracked");
  }
  const remaining = await native.assignments(); assert.deepEqual(remaining.map(row => row.repo), ["beta"]);
  const otherAfter = await native.info(repos[1].path);
  assert.deepEqual({ workspace: otherAfter.workspace, project: otherAfter.project, members: otherAfter.members }, { workspace: otherBefore.workspace, project: otherBefore.project, members: otherBefore.members });
  console.log("Native repository removal, source preservation and isolation passed.");
} catch (error) {
  const log = await readFile(process.env.GORTEX_DAEMON_LOGFILE!, "utf8").catch(() => "");
  console.error(log.split("\n").filter(line => /error|rejected|admission|worktree|checkout/.test(line)).slice(-12).join("\n"));
  throw error;
} finally {
  await service.close(); await native.close();
  let stopped = !started;
  if (started) {
    try { await runProcess("gortex", ["daemon", "stop"], root, { timeoutMs: 20000, maxBytes: 16000 }); stopped = true; }
    catch (error) { console.error(`Could not stop the isolated fixture daemon: ${String(error)}`); }
    for (let attempt = 0; alive() && attempt < 40; attempt++) await delay(250);
  }
  const target = resolve(root), allowed = resolve(tmpdir()) + sep;
  assert.ok(target.startsWith(allowed) && target.includes("gx-untrack-"));
  if (stopped && !alive()) await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`Isolated fixture files retained at ${root}`);
}
