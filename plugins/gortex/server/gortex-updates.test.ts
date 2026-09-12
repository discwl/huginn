import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GortexUpdates, compareVersions, parseInstalledVersion, readLatestRelease, verifiedWindowsArchive, replaceWindowsBinary, type UpdatePort } from "./gortex-updates.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { GortexClient } from "./gortex-client.ts";

function fixture() {
  let version = "v0.64.3+old", fingerprint = "first", latest = "v0.64.4";
  let checks = 0, installs = 0, changes = 0, pauses = 0;
  let beforeInstall: (() => Promise<void>) | undefined;
  let outcome: "ok" | "download-error" | "lost-response" | "restart-failed" = "ok";
  const lock = new RepositoryAdminLock();
  const port: UpdatePort = {
    inspect: async () => ({ binary: "C:\\Tools\\gortex.exe", version, fingerprint, method: "windows-release", reason: null }),
    latest: async () => { checks++; return { version: latest, url: `https://github.com/zzet/gortex/releases/tag/${latest}` }; },
    install: async (_installation, release, stage, activate) => {
      stage("downloading");
      if (beforeInstall) await beforeInstall();
      if (outcome === "download-error") throw new Error("Checksum verification failed");
      return activate(async () => {
        installs++; version = release.version; fingerprint = "new"; stage("restarting");
        if (outcome === "lost-response") throw new Error("Connection lost after installation");
        return { installedVersion: version, backupPath: "C:\\Tools\\gortex.exe.previous", daemonReachable: outcome !== "restart-failed", warning: outcome === "restart-failed" ? "Restart could not be verified" : null };
      });
    },
  };
  const service = new GortexUpdates(port, () => { changes++; }, lock, async work => { pauses++; return work(); });
  return { service, port, lock, counts: () => ({ checks, installs, changes, pauses }), change: (value: string) => { fingerprint = value; }, version: (value: string) => { version = value; }, latest: (value: string) => { latest = value; }, beforeInstall: (value: () => Promise<void>) => { beforeInstall = value; }, outcome: (value: typeof outcome) => { outcome = value; } };
}
async function done(service: GortexUpdates, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = service.job(id)!;
    if (job.stage === "done") return job;
    await delay(2);
  }
  throw new Error("Update job did not finish");
}

test("release comparison ignores build metadata and handles prereleases without downgrading", () => {
  assert.equal(parseInstalledVersion("gortex v0.64.3+56a1c29\nbuilt: today"), "v0.64.3+56a1c29");
  assert.equal(compareVersions("v0.64.3+abc", "v0.64.3"), 0);
  assert.ok(compareVersions("v0.64.4-rc.2", "v0.64.4") < 0);
  assert.ok(compareVersions("v0.65.0", "v0.64.9") > 0);
  assert.throws(() => parseInstalledVersion("not a Gortex version"));
  assert.throws(() => compareVersions("v0.64.3;whoami", "v0.64.3"));
});

test("status is local-only; update checks never install, and current or newer builds are not offered a downgrade", async () => {
  const f = fixture();
  assert.equal((await f.service.status()).state, "unchecked");
  assert.equal(f.counts().checks, 0);
  assert.equal((await f.service.check()).state, "available");
  assert.equal(f.counts().installs, 0);
  f.latest("v0.64.3");
  assert.equal((await f.service.check()).state, "current");
  await assert.rejects(f.service.preview(), /current|newer|update/i);
  f.version("v0.65.0");
  assert.equal((await f.service.check()).state, "ahead");
  assert.equal(f.counts().installs, 0);
  await f.service.close();
});

test("approved update is idempotent, pauses only for installation and refreshes authoritative state", async () => {
  const f = fixture(), preview = await f.service.preview();
  assert.equal(f.counts().installs, 0);
  const first = f.service.apply(preview.id), duplicate = f.service.apply(preview.id);
  assert.equal(first.id, duplicate.id);
  const result = await done(f.service, first.id);
  assert.equal(result.outcome, "updated");
  assert.equal(result.installedVersion, "v0.64.4");
  assert.deepEqual({ installs: f.counts().installs, pauses: f.counts().pauses, changes: f.counts().changes }, { installs: 1, pauses: 1, changes: 1 });
  assert.equal(f.service.job()?.id, result.id);
  assert.equal(f.service.apply(preview.id).id, result.id);
  await f.service.close();
});

test("changed installation and changes during download reject the approval before any live effect", async () => {
  for (const duringDownload of [false, true]) {
    const f = fixture(), preview = await f.service.preview();
    if (duringDownload) f.beforeInstall(async () => { f.change("another install"); });
    else f.change("another install");
    const result = await done(f.service, f.service.apply(preview.id).id);
    assert.equal(result.outcome, "failed");
    assert.match(result.error!, /changed|review/i);
    assert.equal(f.counts().installs, 0);
    await f.service.close();
  }
});

test("download failures stay write-free; lost install responses and restart failures remain explicit", async () => {
  for (const outcome of ["download-error", "lost-response", "restart-failed"] as const) {
    const f = fixture(); f.outcome(outcome);
    const preview = await f.service.preview(), result = await done(f.service, f.service.apply(preview.id).id);
    assert.equal(result.outcome, outcome === "download-error" ? "failed" : outcome === "lost-response" ? "uncertain" : "needs-attention");
    assert.equal(f.counts().installs, outcome === "download-error" ? 0 : 1);
    if (outcome === "lost-response") assert.throws(() => f.lock.acquire(), /verif|update/i);
    await f.service.close();
  }
});

test("host services do not share releases or jobs, and repository administration blocks updates", async () => {
  const a = fixture(), b = fixture(); b.latest("v0.65.0");
  assert.equal((await a.service.check()).latestVersion, "v0.64.4");
  assert.equal((await b.service.check()).latestVersion, "v0.65.0");
  const preview = await a.service.preview(), release = a.lock.acquire();
  assert.throws(() => a.service.apply(preview.id), /progress/i); release();
  const accepted = a.service.apply(preview.id);
  assert.throws(() => b.service.job(accepted.id), /unknown|found/i);
  await done(a.service, accepted.id);
  await Promise.all([a.service.close(), b.service.close()]);
  assert.throws(() => a.service.apply(preview.id), /closed/i);
});

test("latest release reads accept only official stable tag redirects and do not follow arbitrary destinations", async () => {
  let calls = 0;
  const result = await readLatestRelease(async (input, init) => {
    calls++; assert.equal(String(input), "https://github.com/zzet/gortex/releases/latest");
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://github.com/zzet/gortex/releases/tag/v0.64.4" } });
  });
  assert.equal(result.version, "v0.64.4"); assert.equal(calls, 1);
  for (const location of ["https://example.com/releases/tag/v0.64.4", "https://github.com/other/repo/releases/tag/v0.64.4", "https://github.com/zzet/gortex/releases/tag/v0.64.4-rc.1"]) {
    await assert.rejects(readLatestRelease(async () => new Response(null, { status: 302, headers: { location } })));
  }
  await assert.rejects(readLatestRelease(async () => new Response("rate limited", { status: 403 })));
});

test("Windows archive verification fails closed on missing, duplicate or mismatched checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-update-check-"));
  const archive = Buffer.from("verified archive fixture"), hash = createHash("sha256").update(archive).digest("hex");
  try {
    for (const checksum of ["", `${"0".repeat(64)}  gortex_windows_amd64.zip`, `${hash}  gortex_windows_amd64.zip\n${hash}  gortex_windows_amd64.zip`]) {
      const fetcher: typeof fetch = async input => new Response(String(input).endsWith("checksums.txt") ? checksum : archive);
      await assert.rejects(verifiedWindowsArchive(root, "v0.64.4", fetcher), /checksum/i);
    }
    const fetcher: typeof fetch = async input => new Response(String(input).endsWith("checksums.txt") ? `${hash}  gortex_windows_amd64.zip\n` : archive);
    const path = await verifiedWindowsArchive(root, "v0.64.4", fetcher);
    assert.deepEqual(await readFile(path), archive);
    await assert.rejects(verifiedWindowsArchive(root, "v0.64.4", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })), /download|host|HTTPS/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows binary replacement preserves the exact previous executable and cannot overwrite a competing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-update-swap-"));
  const binary = join(root, "gortex.exe"), staged = join(root, "staged.exe");
  try {
    await writeFile(binary, "old binary"); await writeFile(staged, "new binary");
    const backup = await replaceWindowsBinary(binary, staged);
    assert.equal(await readFile(binary, "utf8"), "new binary");
    assert.equal(await readFile(backup, "utf8"), "old binary");
    await assert.rejects(replaceWindowsBinary(binary, join(root, "missing.exe")));
    assert.equal(await readFile(binary, "utf8"), "new binary");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired approvals never install; accepted jobs remain idempotent after expiry", async () => {
  const f = fixture(); let clock = Date.now();
  const service = new GortexUpdates(f.port, undefined, undefined, undefined, () => clock);
  const expired = await service.preview(); clock += 300_001;
  assert.throws(() => service.apply(expired.id), /expired/i);
  assert.equal(f.counts().installs, 0);
  const preview = await service.preview(), accepted = service.apply(preview.id);
  await done(service, accepted.id); clock += 300_001;
  assert.equal(service.apply(preview.id).id, accepted.id);
  assert.equal(f.counts().installs, 1);
  await Promise.all([service.close(), f.service.close()]);
});

test("equivalent update checks are shared and failed checks do not masquerade as current", async () => {
  const f = fixture(); let checks = 0;
  f.port.latest = async () => { checks++; await delay(5); return { version: "v0.64.4", url: "https://github.com/zzet/gortex/releases/tag/v0.64.4" }; };
  const [a, b] = await Promise.all([f.service.check(), f.service.check()]);
  assert.equal(checks, 1); assert.deepEqual(a, b);
  f.port.latest = async () => { throw new Error("offline"); };
  const failed = await f.service.check();
  assert.equal(failed.state, "unavailable"); assert.equal(failed.latestVersion, "v0.64.4"); assert.match(failed.error!, /connection|retry/i);
  await assert.rejects(f.service.preview(), /retry|connection/i);
  assert.equal(f.counts().installs, 0);
  await f.service.close();
});

test("unsupported installation methods still report releases but cannot approve an update", async () => {
  const f = fixture(), inspect = f.port.inspect;
  f.port.inspect = async () => ({ ...await inspect(), method: "unsupported", reason: "Unsupported package layout" });
  assert.equal((await f.service.check()).state, "available");
  await assert.rejects(f.service.preview(), /package layout/);
  assert.equal(f.counts().installs, 0);
  await f.service.close();
});

test("plugin shutdown waits for an accepted update and a refresh failure preserves uncertainty", async () => {
  const f = fixture(); let unblock!: () => void;
  f.beforeInstall(() => new Promise(resolve => { unblock = resolve; }));
  const preview = await f.service.preview(); f.service.apply(preview.id);
  while (!unblock) await delay(1);
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false); unblock(); await closing;
  assert.equal(f.counts().installs, 1);
  const lost = fixture(); lost.outcome("lost-response");
  const service = new GortexUpdates(lost.port, () => { throw new Error("refresh failed"); });
  const approved = await service.preview(), result = await done(service, service.apply(approved.id).id);
  assert.equal(result.outcome, "uncertain"); assert.match(result.error!, /Connection lost.*refresh/);
  await Promise.all([service.close(), lost.service.close()]);
});

test("release downloads enforce redirects, HTTP failures, and declared and streamed byte budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-update-limits-"));
  const hash = "0".repeat(64), checksums = `${hash}  gortex_windows_amd64.zip`;
  try {
    for (const response of [
      () => new Response("unavailable", { status: 503 }),
      () => new Response("too large", { headers: { "content-length": String(256 * 1024 * 1024 + 1) } }),
      () => new Response(null, { status: 302, headers: { location: "https://untrusted.example/asset.zip" } }),
      () => new Response(null, { status: 302, headers: { location: "https://github.com/endless" } }),
    ]) {
      let calls = 0;
      await assert.rejects(verifiedWindowsArchive(root, "v0.64.4", async input => { calls++; return String(input).endsWith("checksums.txt") ? new Response(checksums) : response(); }));
      assert.ok(calls <= 7);
    }
    await assert.rejects(verifiedWindowsArchive(root, "v0.64.4", async () => new Response("x".repeat(1024 * 1024 + 1))), /checksum/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("maintenance blocks new plugin MCP connections and resumes even after an update error", async () => {
  const native = new GortexClient();
  await assert.rejects(native.withMaintenance(async () => {
    await assert.rejects(native.info(tmpdir()), /updat|maintenance/i);
    throw new Error("Fixture update failed");
  }), /Fixture update failed/);
  assert.equal(await native.withMaintenance(async () => "resumed"), "resumed");
  await native.close();
});
