import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, normalize, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { UpdateInstallation, UpdateJob, UpdatePreview, UpdateStatus } from "../shared/update-contracts.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { resolveHostExecutable } from "./host-executable.ts";
import { runProcess } from "./process-runner.ts";

const releaseRoot = "https://github.com/zzet/gortex/releases";
const stableTag = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const versionPattern = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseInstalledVersion(output: string): string {
  const value = /^gortex\s+(\S+)/m.exec(output)?.[1];
  if (!value || value.length > 100 || !versionPattern.test(value)) throw new Error("The installed Gortex version could not be verified.");
  return value;
}
export function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left), b = versionPattern.exec(right);
  if (!a || !b) throw new Error("Unsupported Gortex version.");
  for (let part = 1; part <= 3; part++) if (Number(a[part]) !== Number(b[part])) return Math.sign(Number(a[part]) - Number(b[part]));
  if (a[4] === b[4]) return 0;
  if (!a[4] || !b[4]) return a[4] ? -1 : 1;
  const ap = a[4].split("."), bp = b[4].split(".");
  for (let part = 0; part < Math.max(ap.length, bp.length); part++) {
    const x = ap[part], y = bp[part];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn) return x.length === y.length ? x < y ? -1 : 1 : x.length < y.length ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export type UpdateRelease = { version: string; url: string };
export type UpdateReceipt = { installedVersion: string; backupPath: string | null; daemonReachable: boolean | null; warning: string | null };
export type UpdateStage = Exclude<UpdateJob["stage"], "done">;
export interface UpdatePort {
  inspect(): Promise<UpdateInstallation>;
  latest(): Promise<UpdateRelease>;
  install(installation: UpdateInstallation, release: UpdateRelease, stage: (value: UpdateStage) => void, activate: (effect: () => Promise<UpdateReceipt>) => Promise<UpdateReceipt>): Promise<UpdateReceipt>;
}

function requestDeadline(milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export async function readLatestRelease(fetcher: typeof fetch = fetch): Promise<UpdateRelease> {
  const deadline = requestDeadline(8000);
  let response: Response | undefined;
  try {
    response = await fetcher(`${releaseRoot}/latest`, { redirect: "manual", signal: deadline.signal, headers: { "User-Agent": "paseo-gortex" } });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error(`GitHub update check failed (HTTP ${response.status}). Retry later.`);
    const url = new URL(location, releaseRoot);
    const version = /^\/zzet\/gortex\/releases\/tag\/([^/]+)$/.exec(url.pathname)?.[1];
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !version || !stableTag.test(version)) throw new Error("GitHub did not return an official stable Gortex release.");
    return { version, url: url.href };
  } finally { deadline.dispose(); await response?.body?.cancel().catch(() => {}); }
}

async function download(url: string, path: string, maxBytes: number, fetcher: typeof fetch): Promise<string> {
  const deadline = requestDeadline(120_000);
  try { return await downloadBeforeDeadline(url, path, maxBytes, fetcher, deadline.signal); }
  finally { deadline.dispose(); }
}

async function downloadBeforeDeadline(url: string, path: string, maxBytes: number, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  let current = new URL(url), response: Response | undefined;
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== "https:" || current.username || current.password || (current.port && current.port !== "443") || !(current.hostname === "github.com" || current.hostname.endsWith(".githubusercontent.com"))) throw new Error("Download redirected outside the approved HTTPS release hosts.");
    response = await fetcher(current.href, { redirect: "manual", signal, headers: { "User-Agent": "paseo-gortex" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location) throw new Error("Release download returned an invalid redirect.");
    current = new URL(location, current); response = undefined;
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error("Release download was unavailable."); }
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) { await response.body.cancel(); throw new Error("Release download exceeds the size limit."); }
  const reader = response.body.getReader(), hash = createHash("sha256");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let count = 0;
  try {
    file = await open(path, "wx", 0o600);
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > maxBytes) throw new Error("Release download exceeds the size limit.");
      hash.update(value); await file.writeFile(value);
    }
    if (!count) throw new Error("Release download was empty.");
    await file.sync(); return hash.digest("hex");
  } finally { await reader.cancel().catch(() => {}); await file?.close(); }
}

export async function verifiedWindowsArchive(directory: string, version: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!stableTag.test(version)) throw new Error("Only an official stable release can be installed.");
  const id = randomUUID(), archive = join(directory, `${id}.zip`), checksums = join(directory, `${id}.checksums`);
  try {
    try { await download(`${releaseRoot}/download/${version}/checksums.txt`, checksums, 1024 * 1024, fetcher); }
    catch { throw new Error("The official release checksum could not be downloaded. Nothing was installed."); }
    const rows = (await readFile(checksums, "utf8")).split(/\r?\n/).map(line => /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line)).filter(row => row?.[2] === "gortex_windows_amd64.zip");
    if (rows.length !== 1) throw new Error("Release checksum is missing or ambiguous. Nothing was installed.");
    const actual = await download(`${releaseRoot}/download/${version}/gortex_windows_amd64.zip`, archive, 256 * 1024 * 1024, fetcher);
    if (actual !== rows[0]![1]!.toLowerCase()) throw new Error("Release checksum verification failed. Nothing was installed.");
    return archive;
  } catch (error) { await rm(archive, { force: true }); throw error; }
  finally { await rm(checksums, { force: true }); }
}

export async function replaceWindowsBinary(binary: string, staged: string): Promise<string> {
  if (!(await lstat(staged)).isFile() || !(await lstat(binary)).isFile()) throw new Error("The executable changed before installation.");
  const backup = `${binary}.${randomUUID()}.previous`;
  await rename(binary, backup);
  try { await copyFile(staged, binary, constants.COPYFILE_EXCL); }
  catch (error) {
    // Restore only into an absent destination. Never overwrite another administrator's executable.
    try { await copyFile(backup, binary, constants.COPYFILE_EXCL); }
    catch { throw new Error(`Installation could not be restored. The previous executable is preserved at ${backup}. Verify the host before retrying.`); }
    throw error;
  }
  return backup;
}

const extractionScript = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:PASEO_GORTEX_ARCHIVE)
try {
  $entries = @($archive.Entries | Where-Object { $_.FullName -ceq 'gortex.exe' })
  if ($entries.Count -ne 1 -or $entries[0].Length -lt 1024 -or $entries[0].Length -gt 536870912) { throw 'Invalid Gortex executable entry' }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $env:PASEO_GORTEX_STAGED_BINARY, $false)
} finally { $archive.Dispose() }`;

export class HostGortexUpdater implements UpdatePort {
  private binary: string;
  private fetcher: typeof fetch;
  constructor(binary = "gortex", fetcher: typeof fetch = fetch) { this.binary = binary; this.fetcher = fetcher; }
  async inspect(): Promise<UpdateInstallation> {
    const binary = await realpath(await resolveHostExecutable(this.binary));
    const version = parseInstalledVersion(await runProcess(binary, ["version"], homedir(), { maxBytes: 4096 }));
    const file = await stat(binary);
    const fingerprint = JSON.stringify([binary, version, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]);
    const ordinaryWindows = process.platform === "win32" && process.arch === "x64" && !!process.env.LOCALAPPDATA && normalize(binary).toLowerCase() === normalize(join(process.env.LOCALAPPDATA, "Programs", "gortex", "gortex.exe")).toLowerCase();
    if (ordinaryWindows) return { binary, version, fingerprint, method: "windows-release", reason: null };
    // Installed 0.64.x has a public preview-only upgrade command. Its printed command is never executed by the plugin.
    if (/^v0\.64\./.test(version)) {
      const plan = await runProcess(binary, ["upgrade", version.split("+")[0]!, "--no-migrate"], homedir(), { maxBytes: 32768 });
      if (/^Run:\s*\r?\n\s*(?:brew upgrade gortex|scoop update gortex|go install github\.com\/zzet\/gortex\/cmd\/gortex@v[\w.+-]+|curl -fsSL https:\/\/get\.gortex\.dev \| sh)\s*$/m.test(plan)) return { binary, version, fingerprint, method: "native", reason: null };
    }
    return { binary, version, fingerprint, method: "unsupported", reason: "This installation method has no verified update adapter. Use the host's package manager or Gortex installation instructions." };
  }
  latest(): Promise<UpdateRelease> { return readLatestRelease(this.fetcher); }
  private async daemonReachable(binary: string): Promise<boolean> {
    // Exit status is the native liveness verdict. No table parsing, exact recount, or private transport.
    try { await runProcess(binary, ["daemon", "status"], homedir(), { timeoutMs: 15000, maxBytes: 512 * 1024 }); return true; }
    catch { return false; }
  }
  async install(installation: UpdateInstallation, release: UpdateRelease, stage: (value: UpdateStage) => void, activate: (effect: () => Promise<UpdateReceipt>) => Promise<UpdateReceipt>): Promise<UpdateReceipt> {
    if (!stableTag.test(release.version) || installation.method === "unsupported") throw new Error("This update is unsupported.");
    if (installation.method === "native") return activate(async () => {
      stage("installing");
      const env: NodeJS.ProcessEnv = { ...process.env, GORTEX_VERSION: release.version };
      delete env.GORTEX_NO_VERIFY; delete env.GORTEX_FORCE; delete env.GORTEX_DOWNLOAD_BASE;
      await runProcess(installation.binary, ["upgrade", release.version, "--run", "--no-migrate"], homedir(), { env, timeoutMs: 600_000, maxBytes: 1024 * 1024 });
      stage("verifying");
      // Package managers can move their versioned install directory; resolve the active command again.
      const installed = await this.inspect();
      const installedVersion = installed.version;
      const daemonReachable = await this.daemonReachable(installed.binary);
      return { installedVersion, backupPath: null, daemonReachable, warning: daemonReachable ? null : "The installed binary was checked, but the daemon is unavailable. Verify its state on this host." };
    });
    if (process.platform !== "win32") throw new Error("The Windows release adapter is unavailable on this host.");
    const temporaryRoot = await realpath(tmpdir());
    const temporary = await mkdtemp(join(temporaryRoot, "paseo-gortex-update-"));
    try {
      stage("downloading");
      const archive = await verifiedWindowsArchive(temporary, release.version, this.fetcher), staged = join(temporary, "gortex.exe");
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      await runProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(extractionScript, "utf16le").toString("base64")], temporary, { timeoutMs: 120_000, maxBytes: 16384, env: { ...process.env, PASEO_GORTEX_ARCHIVE: archive, PASEO_GORTEX_STAGED_BINARY: staged } });
      const stagedVersion = parseInstalledVersion(await runProcess(staged, ["version"], temporary, { maxBytes: 4096 }));
      if (compareVersions(stagedVersion, release.version) !== 0) throw new Error("Downloaded executable does not match the approved release.");
      const restartHelp = await runProcess(staged, ["daemon", "restart", "--help"], temporary, { maxBytes: 16384 });
      if (!restartHelp.includes("gortex daemon restart")) throw new Error("The downloaded version has no verified daemon restart command.");
      return await activate(async () => {
        const wasReachable = await this.daemonReachable(installation.binary);
        const current = await this.inspect();
        if (current.binary !== installation.binary || current.fingerprint !== installation.fingerprint) throw new Error("The installed executable changed before replacement. Review the current state again.");
        stage("installing");
        const backupPath = await replaceWindowsBinary(installation.binary, staged);
        let warning: string | null = null;
        if (wasReachable) {
          stage("restarting");
          try { await runProcess(installation.binary, ["daemon", "restart", "--no-progress"], homedir(), { timeoutMs: 120_000, maxBytes: 65536 }); }
          catch { warning = "The new executable is installed, but daemon restart was not verified. Check Host health before retrying."; }
        } else warning = "The executable is installed. Daemon availability was not verified before the update, so no restart was attempted.";
        stage("verifying");
        const installedVersion = parseInstalledVersion(await runProcess(installation.binary, ["version"], homedir(), { maxBytes: 4096 }));
        const daemonReachable = await this.daemonReachable(installation.binary);
        return { installedVersion, backupPath, daemonReachable, warning };
      });
    } finally {
      if (dirname(resolve(temporary)) !== resolve(temporaryRoot) || (await lstat(temporary)).isSymbolicLink()) throw new Error("The update staging directory changed; automatic cleanup was skipped.");
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

type Pause = (effect: () => Promise<UpdateReceipt>) => Promise<UpdateReceipt>;
export class GortexUpdates {
  private port: UpdatePort;
  private changed: () => void;
  private admin: RepositoryAdminLock;
  private pause: Pause;
  private now: () => number;
  private closed = false;
  private release: UpdateRelease | null = null;
  private checkedAt: string | null = null;
  private checkError: string | null = null;
  private checking: Promise<UpdateStatus> | null = null;
  private previews = new Map<string, UpdatePreview>();
  private jobs = new Map<string, UpdateJob>();
  private latestJob: string | null = null;
  private active: Promise<void> | null = null;
  constructor(port: UpdatePort = new HostGortexUpdater(), changed: () => void = () => {}, admin = new RepositoryAdminLock(), pause: Pause = effect => effect(), now: () => number = Date.now) { this.port = port; this.changed = changed; this.admin = admin; this.pause = pause; this.now = now; }
  private assertOpen() { if (this.closed) throw new Error("Gortex update service is closed."); }
  private snapshot(installation: UpdateInstallation): UpdateStatus {
    const comparison = this.release ? compareVersions(installation.version, this.release.version) : 0;
    return { installation, state: this.checkError ? "unavailable" : !this.release ? "unchecked" : comparison < 0 ? "available" : comparison === 0 ? "current" : "ahead", latestVersion: this.release?.version ?? null, releaseUrl: this.release?.url ?? null, checkedAt: this.checkedAt, error: this.checkError };
  }
  async status(): Promise<UpdateStatus> { this.assertOpen(); return this.snapshot(await this.port.inspect()); }
  check(): Promise<UpdateStatus> {
    this.assertOpen();
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const installation = await this.port.inspect();
      try { this.release = await this.port.latest(); this.checkError = null; }
      catch { this.checkError = "Could not check GitHub for a newer Gortex release. Check this host's connection and retry."; }
      this.checkedAt = new Date(this.now()).toISOString(); return this.snapshot(installation);
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async preview(): Promise<UpdatePreview> {
    const status = await this.check(); this.assertOpen();
    if (status.state !== "available" || !status.latestVersion || !status.releaseUrl) throw new Error(status.error ?? "The installed version is current or newer; no update is available.");
    if (status.installation.method === "unsupported") throw new Error(status.installation.reason ?? "This installation is unsupported.");
    const warnings = ["Updates Gortex for every client using this host. A running daemon may restart, briefly interrupting code queries and applying its saved configuration.", "Repository tracking and agent configuration are not edited by this update. No index rebuild or enrichment is requested."];
    if (status.installation.method === "windows-release") warnings.push("Downloads the official Windows release, requires a matching SHA-256 checksum, and retains the previous executable beside the installed binary.");
    else warnings.push("Uses Gortex's detected native updater. Package managers control their available version and may install a newer release than the one shown. Agent configuration migration is disabled.");
    warnings.push("The plugin validates native responses and operation support. A breaking Gortex API change may require a plugin update; newer stable version numbers alone do not disable repository controls.");
    const preview = { id: randomUUID(), expiresAt: new Date(this.now() + 300_000).toISOString(), installation: status.installation, targetVersion: status.latestVersion, releaseUrl: status.releaseUrl, warnings };
    if (this.previews.size >= 40) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, preview); return preview;
  }
  apply(id: string): UpdateJob {
    this.assertOpen();
    const accepted = this.jobs.get(id); if (accepted) return { ...accepted };
    const preview = this.previews.get(id);
    if (!preview || Date.parse(preview.expiresAt) <= this.now()) throw new Error("Update approval expired. Review the current state again.");
    const release = this.admin.acquire();
    const job: UpdateJob = { id, targetVersion: preview.targetVersion, stage: "checking", outcome: "running", installedVersion: null, backupPath: null, daemonReachable: null, error: null };
    if (this.jobs.size >= 40) this.jobs.delete(this.jobs.keys().next().value!);
    this.jobs.set(id, job); this.latestJob = id; this.previews.delete(id);
    this.active = this.execute(preview, job).finally(() => { release(); this.active = null; });
    return { ...job };
  }
  private async verifyInstallation(preview: UpdatePreview): Promise<void> {
    const current = await this.port.inspect();
    if (current.binary !== preview.installation.binary || current.fingerprint !== preview.installation.fingerprint || current.version !== preview.installation.version || current.method !== preview.installation.method) throw new Error("The Gortex installation changed. Review the current state before updating.");
  }
  private async execute(preview: UpdatePreview, job: UpdateJob): Promise<void> {
    let attempted = false;
    try {
      await this.verifyInstallation(preview);
      const receipt = await this.port.install(preview.installation, { version: preview.targetVersion, url: preview.releaseUrl }, stage => { job.stage = stage; }, async effect => {
        await this.verifyInstallation(preview);
        return this.pause(async () => { await this.verifyInstallation(preview); attempted = true; return effect(); });
      });
      job.installedVersion = receipt.installedVersion; job.backupPath = receipt.backupPath; job.daemonReachable = receipt.daemonReachable;
      const matches = compareVersions(receipt.installedVersion, preview.targetVersion) >= 0;
      job.outcome = matches && receipt.daemonReachable && !receipt.warning ? "updated" : "needs-attention";
      job.error = !matches ? "The installed version does not match the approved update. Check the host before retrying." : receipt.warning;
    } catch (error) {
      job.outcome = attempted ? "uncertain" : "failed";
      job.error = error instanceof Error ? error.message : "Gortex update failed.";
      if (attempted) this.admin.stopWrites("A Gortex update needs verification. Check the installed binary and daemon before reloading this plugin to resume administrative writes.");
    } finally {
      job.stage = "done";
      if (attempted) {
        try { this.changed(); }
        catch { if (job.outcome === "updated") job.outcome = "needs-attention"; job.error = `${job.error ? `${job.error} ` : ""}The plugin could not refresh its repository catalog. Reload this plugin to reconcile the host.`; }
      }
    }
  }
  job(id?: string): UpdateJob | null {
    this.assertOpen();
    const key = id ?? this.latestJob; if (!key) return null;
    const job = this.jobs.get(key); if (!job) throw new Error("Unknown Gortex update job. Check the installed version before retrying.");
    return { ...job };
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([this.active, this.checking]); }
}
