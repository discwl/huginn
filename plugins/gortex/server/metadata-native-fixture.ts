// Explicit integration exercise, never imported by the plugin runtime.
// Owns temporary repos and a daemon isolated by all config/data/cache/socket paths.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { z } from "zod";
import { GortexClient } from "./gortex-client.ts";
import { RepositoryMetadata } from "./repository-metadata.ts";
import { runProcess } from "./process-runner.ts";

const root = await mkdtemp(join(tmpdir(), "gx-meta-"));
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
const metadata = new RepositoryMetadata(native);
let started = false;
let pid = 0;
const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const repos: Array<{ path: string; name: string; workspace: string; project: string }> = [];
  for (const name of ["alpha", "beta"]) {
    const path = join(root, `${name} repo`);
    await mkdir(path);
    await runProcess("git", ["init", "-q", path], root);
    await writeFile(join(path, "index.ts"), `export function ${name}Value() { return 42; }\n`);
    await mkdir(join(path, "exclusion-fixture"));
    await writeFile(join(path, "exclusion-fixture", "omit.ts"), `export function ${name}Hidden() { return 7; }\n`);
    await writeFile(join(path, "exclusion-fixture", "keep.ts"), `export function ${name}Kept() { return 8; }\n`);
    await writeFile(join(path, ".gortex.yaml"), "embedding:\n  enabled: false\nsemantic:\n  enabled: false\n");
    await runProcess("git", ["-C", path, "add", "index.ts", ".gortex.yaml", "exclusion-fixture"], root);
    await runProcess("git", ["-C", path, "-c", "user.name=Plugin fixture", "-c", "user.email=fixture@example.invalid", "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "-q", "--no-gpg-sign", "-m", "Fixture"], root);
    repos.push({ path, name, workspace: `fixture-${name}`, project: "sample" });
  }
  const configDir = join(process.env.XDG_CONFIG_HOME, "gortex");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.yaml"), stringify({ repos, embedding: { enabled: false }, mcp: { allow_embedded: false } }));
  started = true;
  await runProcess("gortex", ["daemon", "start", "--detach", "--backend-path", join(root, "fixture.sqlite"), "--tools", "compact", "--no-progress"], root, { timeoutMs: 30000, maxBytes: 16000 });
  pid = Number((await readFile(process.env.GORTEX_DAEMON_PIDFILE, "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let before;
  let lastReadError = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    await delay(500);
    try { const value = await metadata.read(repos[0].path); if (value.daemon) { before = value; break; } lastReadError = value.error ?? "No daemon identity"; } catch (error) { lastReadError = String(error); }
  }
  assert.ok(before?.daemon, `Fixture daemon did not become ready: ${lastReadError}`);
  assert.equal(before.state, "applied");
  let otherBefore = await metadata.read(repos[1].path);
  for (let attempt = 0; !otherBefore.daemon && attempt < 12; attempt++) { await delay(500); otherBefore = await metadata.read(repos[1].path); }
  assert.ok(otherBefore.daemon, `Second fixture repository did not become ready: ${otherBefore.error}`);
  // Reproduce a manual config edit while the native graph retains its original identity.
  const pendingText = stringify({ repos: [{ ...repos[0], name: "alpha-renamed", workspace: "fixture-moved", project: "paseo" }, repos[1]], embedding: { enabled: false }, mcp: { allow_embedded: false } });
  await writeFile(join(configDir, "config.yaml"), pendingText);
  const pending = await metadata.read(repos[0].path);
  assert.equal(pending.state, "pending"); assert.equal(pending.daemon?.name, "alpha");
  const preview = await metadata.previewRepair(repos[0].path, pending.revision);
  assert.equal(await readFile(join(configDir, "config.yaml"), "utf8"), pendingText, "repair preview must not save or reload");
  assert.deepEqual(preview.effective, { name: "alpha", workspace: "fixture-moved", project: "paseo" });
  assert.equal(preview.rebuildsIndex, true);
  const job = metadata.apply(preview.id);
  const deadline = Date.now() + 180000;
  let result = metadata.job(job.id);
  while (result.stage !== "done" && Date.now() < deadline) { await delay(500); result = metadata.job(job.id); }
  console.log(JSON.stringify({ outcome: result.outcome, error: result.error, configured: result.result?.effective, daemon: result.result?.daemon }));
  assert.equal(result.stage, "done");
  assert.equal(result.outcome, "applied", "Installed native operation must apply the new workspace/project before the adapter claims support");
  const otherAfter = await metadata.read(repos[1].path);
  assert.deepEqual(otherAfter.configured, otherBefore.configured);
  assert.deepEqual(otherAfter.daemon, otherBefore.daemon, "another workspace must remain isolated");
  async function hasSymbol(repo: { path: string; name: string }, workspace: string, name: string) {
    const report = await native.query(repo.path, "search", { query: name, workspace, repo: repo.name, limit: 20 });
    const value = z.object({ results: z.array(z.object({ name: z.string(), repo_prefix: z.string(), workspace_id: z.string() })), truncated: z.boolean().optional() }).parse(report.value);
    assert.notEqual(value.truncated, true);
    assert.ok(value.results.every(hit => hit.repo_prefix === repo.name && hit.workspace_id === workspace));
    return value.results.some(hit => hit.name === name);
  }
  async function applyExclusions(patterns: string[]) {
    const current = await metadata.read(repos[0].path);
    const preview = await metadata.preview(repos[0].path, current.revision, current.configured, patterns);
    assert.equal(preview.rebuildsIndex, true);
    let result = metadata.apply(preview.id);
    const deadline = Date.now() + 180000;
    while (result.stage !== "done" && Date.now() < deadline) { await delay(500); result = metadata.job(result.id); }
    console.log(JSON.stringify({ exclusions: result.exclusions, outcome: result.outcome, error: result.error }));
    assert.equal(result.outcome, "applied"); assert.equal(result.exclusions, "refreshed");
  }
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaHidden"), true);
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaKept"), true);
  assert.equal(await hasSymbol(repos[1], "fixture-beta", "betaHidden"), true);
  await applyExclusions(["exclusion-fixture/*.ts", "!exclusion-fixture/keep.ts"]);
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaHidden"), false, "excluded symbol must disappear from the live index");
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaKept"), true, "negation must preserve the selected file");
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaValue"), true);
  assert.equal(await hasSymbol(repos[1], "fixture-beta", "betaHidden"), true, "another repository must not inherit this exclusion");
  assert.equal(await readFile(join(repos[0].path, "exclusion-fixture", "omit.ts"), "utf8"), "export function alphaHidden() { return 7; }\n", "source must remain on disk");
  await applyExclusions([]);
  assert.equal(await hasSymbol(repos[0], "fixture-moved", "alphaHidden"), true, "removing a rule must restore the symbol after refresh");
  assert.deepEqual((await metadata.read(repos[1].path)).extra.exclude, otherBefore.extra.exclude);
  console.log("Native metadata and exclusions fixture passed: removal, re-inclusion, restore and repository isolation verified.");
} finally {
  await metadata.close(); await native.close();
  let stopped = !started;
  if (started) {
    try { await runProcess("gortex", ["daemon", "stop"], root, { timeoutMs: 20000, maxBytes: 16000 }); stopped = true; }
    catch (error) { console.error(`Could not stop the isolated fixture daemon: ${String(error)}`); }
    for (let attempt = 0; alive() && attempt < 40; attempt++) await delay(250);
  }
  const target = resolve(root), allowed = resolve(tmpdir()) + sep;
  assert.ok(target.startsWith(allowed) && target.includes("gx-meta-"));
  if (stopped && !alive()) await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  else console.error(`Isolated fixture files retained at ${root}`);
}
