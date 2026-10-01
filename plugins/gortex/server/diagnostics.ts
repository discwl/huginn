import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { DiagnosticCheck, DiagnosticsReport, Remedy, RepairJob } from "../shared/diagnostics-contracts.ts";
import type { NativeAssignment, NativeInfo } from "../shared/models.ts";
import { nativeCompatibility } from "../shared/native-compatibility.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage, warmingUpMessage } from "../shared/native-retry.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { runProcess } from "./process-runner.ts";

export interface DiagnosticsNative {
  version(): Promise<string>;
  assignments(): Promise<NativeAssignment[]>;
  info(path: string): Promise<NativeInfo>;
  reloadConfiguration(): Promise<void>;
  rebuildIndex(path: string): Promise<void>;
  refreshContexts(): Promise<void>;
}
export interface DiagnosticsCli { run(args: string[], timeoutMs?: number): Promise<string> }
export interface DiagnosticsOptions { maxRepositories?: number; now?: () => number }

const REINDEX = "reindex:";
const message = (error: unknown) => error instanceof Error ? error.message : "The check failed.";
const hostCli: DiagnosticsCli = { run: (args, timeoutMs = 30_000) => runProcess("gortex", args, homedir(), { timeoutMs, maxBytes: 512 * 1024 }) };
const trim = (text: string, limit = 400) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > limit ? `${value.slice(0, limit)}…` : value; };

type RepoRow = { name?: unknown; path?: unknown; indexed?: unknown; stale?: unknown; last_indexed?: unknown };

/**
 * Read-only health checks for one host's Gortex, plus the repairs they justify.
 * Checks never change anything; each remedy is applied only when the client asks for it by ID.
 */
export class GortexDiagnostics {
  private native: DiagnosticsNative;
  private cli: DiagnosticsCli;
  private admin: RepositoryAdminLock;
  private invalidate: () => void;
  private maxRepositories: number;
  private now: () => number;
  private reports = new Map<string, DiagnosticsReport>();
  private jobs = new Map<string, RepairJob>();
  private latestId: string | null = null;
  private running: Promise<unknown> | null = null;

  constructor(native: DiagnosticsNative, admin = new RepositoryAdminLock(), invalidate: () => void = () => {}, cli: DiagnosticsCli = hostCli, options: DiagnosticsOptions = {}) {
    this.native = native; this.cli = cli; this.admin = admin; this.invalidate = invalidate;
    this.maxRepositories = options.maxRepositories ?? 12;
    this.now = options.now ?? Date.now;
  }

  latest(): DiagnosticsReport | null { return this.latestId ? this.reports.get(this.latestId) ?? null : null; }
  job(id: string): RepairJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("This repair is no longer retained. Run diagnostics again.");
    return structuredClone(job);
  }

  async run(): Promise<DiagnosticsReport> {
    const started = this.now();
    const checks: DiagnosticCheck[] = [];
    const remedies = new Map<string, Remedy>();
    const add = (remedy: Remedy) => { if (!remedies.has(remedy.id)) remedies.set(remedy.id, remedy); };

    // 1. The executable and its compatibility with this plugin.
    let version = "";
    try {
      version = (await this.cli.run(["version"], 15_000)).split(/\r?\n/)[0].trim();
      const compatibility = nativeCompatibility(version.replace(/^gortex\s+/, ""), false);
      checks.push({ id: "cli", title: "Gortex executable", state: compatibility.available ? "pass" : "warn", detail: compatibility.available ? version : `${version}: ${compatibility.reason}`, evidence: null });
    } catch (error) {
      checks.push({ id: "cli", title: "Gortex executable", state: "fail", detail: "Gortex could not be run from this host's PATH. Install Gortex, or fix its PATH entry.", evidence: trim(message(error)) });
      return this.finish(started, checks, [...remedies.values()]);
    }

    // 2. The daemon process and its readiness.
    let status = "";
    let daemonRunning = false, daemonReady = false;
    try {
      status = await this.cli.run(["daemon", "status"], 30_000);
      daemonRunning = /\bpid\s+\d+/.test(status);
      daemonReady = /\bstate\s+ready\b/.test(status);
      const warming = /warming up/.test(status);
      const state = daemonReady ? "pass" : daemonRunning ? "warn" : "fail";
      checks.push({
        id: "daemon", title: "Daemon", state,
        detail: daemonReady ? `Ready. ${trim(/ sessions\s+(\d+)/.exec(status)?.[0] ?? "", 60)}`.trim() : warming ? "Running but still warming up; queries can be refused until it finishes." : daemonRunning ? "Running, but not reporting a ready state." : "Not running on this host.",
        evidence: trim(status.split(/\r?\n/).filter(line => /\b(pid|uptime|state|sessions)\b/.test(line)).join(" · "), 300),
      });
      if (!daemonRunning) add({ id: "daemon-start", title: "Start the Gortex daemon", detail: "Runs gortex daemon start on this host.", risk: "safe", target: null });
      else if (!daemonReady) add({ id: "recheck", title: "Wait and re-check", detail: "Runs the same checks again; warm-up usually clears on its own.", risk: "safe", target: null });
    } catch (error) {
      checks.push({ id: "daemon", title: "Daemon", state: "fail", detail: "Could not read daemon status.", evidence: trim(message(error)) });
      add({ id: "daemon-start", title: "Start the Gortex daemon", detail: "Runs gortex daemon start on this host.", risk: "safe", target: null });
    }

    // 3. MCP responsiveness: the lane agents and this plugin actually use.
    const rows = await this.native.assignments().catch(() => null);
    if (!rows) {
      checks.push({ id: "mcp", title: "MCP responses", state: "fail", detail: "Gortex accepted no MCP request from the plugin.", evidence: null });
      add({ id: "daemon-restart", title: "Restart the Gortex daemon", detail: "Runs gortex daemon restart. Every client on this host reconnects, and running agents lose their Gortex session briefly.", risk: "host-wide", target: null });
      return this.finish(started, checks, [...remedies.values()]);
    }
    checks.push({ id: "mcp", title: "MCP responses", state: "pass", detail: `Gortex answered the plugin and reports ${rows.length} tracked ${rows.length === 1 ? "repository" : "repositories"}.`, evidence: null });

    // 4. Index state per repository, from Gortex's own catalog.
    let repoRows: RepoRow[] = [];
    try {
      const output = await this.cli.run(["repos", "--json"], 30_000);
      const parsed: unknown = JSON.parse(output.slice(output.indexOf("[")));
      repoRows = Array.isArray(parsed) ? parsed as RepoRow[] : [];
      const unindexed = repoRows.filter(row => row.indexed === false);
      const stale = repoRows.filter(row => row.indexed !== false && row.stale === true);
      checks.push({
        id: "index", title: "Repository indexes",
        state: unindexed.length ? "fail" : stale.length ? "warn" : "pass",
        detail: unindexed.length ? `${unindexed.length} of ${repoRows.length} not indexed: ${unindexed.map(row => String(row.name)).join(", ")}.`
          : stale.length ? `${stale.length} behind the working tree: ${stale.map(row => String(row.name)).join(", ")}.`
          : `${repoRows.length} indexed and current.`,
        evidence: null,
      });
      for (const row of [...unindexed, ...stale]) {
        if (typeof row.path === "string" && typeof row.name === "string") {
          add({ id: `${REINDEX}${row.path}`, title: `Re-index ${row.name}`, detail: "Asks Gortex to rebuild this repository's index. Source files are not changed.", risk: "safe", target: row.path });
        }
      }
    } catch (error) {
      checks.push({ id: "index", title: "Repository indexes", state: "warn", detail: "Could not read Gortex's repository catalog.", evidence: trim(message(error)) });
    }

    // 5. Per-repository identity: what fails first when an agent starts in a repo.
    const probes = rows.slice(0, this.maxRepositories);
    const failures: string[] = [];
    let busy = false, warming = false;
    for (const row of probes) {
      try { await this.native.info(row.path); }
      catch (error) {
        const text = message(error);
        if (isBusyMessage(text)) { busy = true; failures.push(`${row.repo}: refused, dispatcher busy`); }
        else if (isWarmingUpMessage(text)) { warming = true; failures.push(`${row.repo}: still discovering checkouts`); }
        else failures.push(`${row.repo}: ${trim(text, 120)}`);
      }
    }
    checks.push({
      id: "repositories", title: "Repository access",
      state: failures.length === 0 ? "pass" : busy || warming ? "warn" : "fail",
      detail: failures.length === 0 ? `All ${probes.length} checked ${probes.length === 1 ? "repository answers" : "repositories answer"}.` : `${failures.length} of ${probes.length} did not answer.`,
      evidence: failures.length ? trim(failures.join(" · "), 400) : null,
    });
    if (busy) {
      checks.push({ id: "capacity", title: "Request capacity", state: "warn", detail: busyMessage, evidence: null });
      add({ id: "recheck", title: "Wait and re-check", detail: "Runs the same checks again once the current requests finish.", risk: "safe", target: null });
    }
    if (warming) add({ id: "recheck", title: "Wait and re-check", detail: warmingUpMessage, risk: "safe", target: null });
    if (failures.length && !busy && !warming) {
      add({ id: "daemon-reload", title: "Reload Gortex configuration", detail: "Runs gortex daemon reload, which re-reads config.yaml and picks up added or removed repositories without a restart.", risk: "safe", target: null });
      add({ id: "daemon-restart", title: "Restart the Gortex daemon", detail: "Runs gortex daemon restart. Every client on this host reconnects, and running agents lose their Gortex session briefly.", risk: "host-wide", target: null });
    }
    return this.finish(started, checks, [...remedies.values()]);
  }

  private finish(started: number, checks: DiagnosticCheck[], remedies: Remedy[]): DiagnosticsReport {
    const failed = checks.filter(check => check.state === "fail"), warned = checks.filter(check => check.state === "warn");
    const report: DiagnosticsReport = {
      id: randomUUID(), observedAt: new Date(this.now()).toISOString(), durationMs: Math.max(0, this.now() - started),
      state: failed.length ? "broken" : warned.length ? "degraded" : "healthy",
      summary: failed.length ? `${failed.length} problem${failed.length === 1 ? "" : "s"}: ${failed.map(check => check.title).join(", ")}.`
        : warned.length ? `Working, with ${warned.length} thing${warned.length === 1 ? "" : "s"} to watch: ${warned.map(check => check.title).join(", ")}.`
        : "Gortex is ready on this host.",
      checks, remedies,
    };
    this.reports.set(report.id, report); this.latestId = report.id;
    while (this.reports.size > 10) this.reports.delete(this.reports.keys().next().value!);
    return report;
  }

  /** Applies one remedy from a report, then re-runs the checks so the result is observed, not assumed. */
  async repair(reportId: string, remedyId: string): Promise<RepairJob> {
    const report = this.reports.get(reportId);
    if (!report) throw new Error("This report expired. Run diagnostics again before repairing.");
    const remedy = report.remedies.find(candidate => candidate.id === remedyId);
    if (!remedy) throw new Error("That repair is not offered by this report. Run diagnostics again.");
    if (this.running) throw new Error("Another repair is already running on this host. Wait for it to finish.");
    const job: RepairJob = { id: randomUUID(), remedyId, title: remedy.title, stage: "running", outcome: "running", steps: [], error: null, report: null };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    const release = this.admin.acquire();
    this.running = this.execute(remedy, job).finally(() => { this.running = null; release(); });
    await this.running;
    return structuredClone(job);
  }

  private async execute(remedy: Remedy, job: RepairJob): Promise<void> {
    try {
      switch (true) {
        case remedy.id === "recheck": job.steps.push("Re-ran the checks without changing anything."); break;
        case remedy.id === "daemon-start": job.steps.push(trim(await this.cli.run(["daemon", "start"], 180_000)) || "Started the daemon."); break;
        case remedy.id === "daemon-reload": await this.native.reloadConfiguration(); job.steps.push("Reloaded Gortex configuration."); break;
        case remedy.id === "daemon-restart": job.steps.push(trim(await this.cli.run(["daemon", "restart"], 180_000)) || "Restarted the daemon."); break;
        case remedy.id.startsWith(REINDEX): {
          const path = remedy.target ?? remedy.id.slice(REINDEX.length);
          await this.native.rebuildIndex(path);
          job.steps.push(`Rebuilt the index for ${path}.`);
          break;
        }
        default: throw new Error("This repair is not supported by this plugin version.");
      }
      await this.native.refreshContexts().catch(() => { /* A refresh failure is visible in the re-run below. */ });
      this.invalidate();
    } catch (error) {
      job.error = message(error); job.outcome = "failed";
    }
    job.stage = "verifying";
    try {
      const report = await this.run();
      job.report = report;
      if (job.outcome !== "failed") job.outcome = report.state === "healthy" ? "fixed" : "unchanged";
    } catch (error) {
      job.outcome = "failed";
      job.error = job.error ?? message(error);
    }
    job.stage = "done";
  }
}
