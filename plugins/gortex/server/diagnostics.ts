import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { DiagnosticCheck, DiagnosticsReport, Remedy, RepairJob } from "../shared/diagnostics-contracts.ts";
import type { NativeAssignment, NativeInfo } from "../shared/models.ts";
import { nativeCompatibility } from "../shared/native-compatibility.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage, warmingUpMessage } from "../shared/native-retry.ts";
import { parseDaemonStatus, summarizeSessions, uptimeSeconds, type DaemonSession } from "./daemon-status.ts";
import { RepositoryAdminLock } from "./repository-admin-lock.ts";
import { runProcess } from "./process-runner.ts";

export interface DiagnosticsNative {
  version(): Promise<string>;
  assignments(): Promise<NativeAssignment[]>;
  info(path: string): Promise<NativeInfo>;
  /** Optional single-attempt probe; diagnostics report the present state rather than waiting out a stall. */
  infoOnce?(path: string): Promise<NativeInfo>;
  reloadConfiguration(): Promise<void>;
  rebuildIndex(path: string): Promise<void>;
  refreshContexts(): Promise<void>;
}
export interface DiagnosticsCli {
  run(args: string[], timeoutMs?: number): Promise<string>;
  /** Optional: hosts without Git skip the worktree check. */
  git?(args: string[], cwd: string): Promise<string>;
}
export interface DiagnosticsOptions { maxRepositories?: number; now?: () => number; clock?: () => number; wait?: (ms: number) => Promise<unknown> }

const REINDEX = "reindex:", PRUNE = "prune:";
// Warm-up after a start is normally seconds; past this, a discovery failure on every repository is a wedge.
const STUCK_AFTER_SECONDS = 300;
// Gortex allows 250 ms for two Git commands; a single start slower than this leaves no headroom.
const SLOW_GIT_MS = 100;
// A refused first request is retried inside the 5 seconds Gortex keeps its finished Git check.
const PROBE_ATTEMPTS = 5, PROBE_RETRY_MS = 400;
const message = (error: unknown) => error instanceof Error ? error.message : "The check failed.";
const hostCli: DiagnosticsCli = {
  run: (args, timeoutMs = 30_000) => runProcess("gortex", args, homedir(), { timeoutMs, maxBytes: 512 * 1024 }),
  git: (args, cwd) => runProcess("git", ["-C", cwd, ...args], cwd, { timeoutMs: 15_000, maxBytes: 256 * 1024 }),
};
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
  private clock: () => number;
  private wait: (ms: number) => Promise<unknown>;
  private reports = new Map<string, DiagnosticsReport>();
  private jobs = new Map<string, RepairJob>();
  private latestId: string | null = null;
  private running: Promise<unknown> | null = null;

  constructor(native: DiagnosticsNative, admin = new RepositoryAdminLock(), invalidate: () => void = () => {}, cli: DiagnosticsCli = hostCli, options: DiagnosticsOptions = {}) {
    this.native = native; this.cli = cli; this.admin = admin; this.invalidate = invalidate;
    this.maxRepositories = options.maxRepositories ?? 12;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.wait = options.wait ?? (ms => delay(ms));
  }

  /** One repository, the way an agent meets it: a refused first request is repeated right away. */
  private async probe(row: NativeAssignment): Promise<{ ok: true; row: NativeAssignment; attempts: number } | { ok: false; row: NativeAssignment; text: string }> {
    let text = "";
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      try { await (this.native.infoOnce?.(row.path) ?? this.native.info(row.path)); return { ok: true, row, attempts: attempt }; }
      catch (error) {
        text = message(error);
        if (!isWarmingUpMessage(text) || isBusyMessage(text) || attempt === PROBE_ATTEMPTS) break;
        await this.wait(PROBE_RETRY_MS);
      }
    }
    return { ok: false, row, text };
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

    // Slow on a struggling daemon, so it runs alongside the checks below and is awaited where it is reported.
    const catalog = this.cli.run(["repos", "--json"], 30_000).then(output => ({ output, error: null as unknown }), error => ({ output: "", error }));

    // 2. The daemon process and its readiness.
    let status = "";
    let daemonRunning = false, daemonReady = false;
    let sessions: DaemonSession[] = [];
    let uptime: number | null = null;
    try {
      status = await this.cli.run(["daemon", "status"], 30_000);
      const parsed = parseDaemonStatus(status);
      daemonRunning = parsed.running; daemonReady = parsed.ready; sessions = parsed.sessions; uptime = uptimeSeconds(parsed.uptime);
      const warming = parsed.warming;
      const state = daemonReady ? "pass" : daemonRunning ? "warn" : "fail";
      checks.push({
        id: "daemon", title: "Daemon", state,
        detail: daemonReady ? `Ready. ${trim(/ sessions\s+(\d+)/.exec(status)?.[0] ?? "", 60)}`.trim() : warming ? "Running but still warming up; queries can be refused until it finishes." : daemonRunning ? "Running, but not reporting a ready state." : "Not running on this host.",
        evidence: trim(status.split(/\r?\n/).filter(line => /^\s*(pid|uptime|state|sessions)\s+\S/.test(line)).map(line => line.trim()).join(" · "), 300),
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
      const { output, error: catalogError } = await catalog;
      if (catalogError) throw catalogError;
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
    // Gortex runs Git before it answers a request and allows that 250 ms; slow process starts on the host
    // (CPU load, antivirus) make first requests fail with "checkout discovery is pending".
    let gitMs: number | null = null;
    if (this.cli.git && probes.length) {
      const git = this.cli.git, samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const began = this.clock();
        try { await git(["rev-parse", "--git-dir"], probes[0].path); samples.push(this.clock() - began); } catch { break; }
      }
      if (samples.length === 3) {
        gitMs = Math.round(samples.sort((a, b) => a - b)[1]);
        const slow = gitMs > SLOW_GIT_MS;
        checks.push({
          id: "git", title: "Git speed", state: slow ? "warn" : "pass",
          detail: slow ? `Git takes about ${gitMs} ms to start on this host. Gortex runs two Git commands before answering and allows 250 ms in total, so first requests fail with "checkout discovery is pending". The usual causes are other processes using the CPU, or antivirus scanning each process start. Restarting Gortex does not help.`
            : `Git starts in about ${gitMs} ms.`,
          evidence: `samples: ${samples.map(value => `${Math.round(value)} ms`).join(", ")}`,
        });
      }
    }
    const gitSlow = gitMs !== null && gitMs > SLOW_GIT_MS;

    const failures: string[] = [], retried: string[] = [];
    let busy = false, warming = false, discoveryFailures = 0;
    for (let start = 0; start < probes.length; start += 6) {
      const results = await Promise.all(probes.slice(start, start + 6).map(row => this.probe(row)));
      for (const result of results) {
        if (result.ok) { if (result.attempts > 1) retried.push(result.row.repo); continue; }
        const { row, text } = result;
        if (isBusyMessage(text)) { busy = true; failures.push(`${row.repo}: refused, dispatcher busy`); }
        else if (isWarmingUpMessage(text)) { warming = true; discoveryFailures++; failures.push(`${row.repo}: checkout discovery pending`); }
        else failures.push(`${row.repo}: ${trim(text, 120)}`);
      }
    }
    // Stuck means: ready for minutes, Git is fast, and every repository still refuses after quick retries.
    // A slow Git explains the same refusals without anything being wedged, and a restart would not help.
    const stuck = !gitSlow && daemonReady && uptime !== null && uptime >= STUCK_AFTER_SECONDS && probes.length > 0 && discoveryFailures === probes.length;
    if (stuck) warming = false;
    checks.push({
      id: "repositories", title: "Repository access",
      state: failures.length === 0 ? retried.length ? "warn" : "pass" : stuck ? "fail" : busy || warming ? "warn" : "fail",
      detail: failures.length === 0
        ? retried.length ? `All ${probes.length} answer, but ${retried.length} only on a retry. Agents can see "checkout discovery is pending" on a first request; repeating the request right away works.`
          : `All ${probes.length} checked ${probes.length === 1 ? "repository answers" : "repositories answer"}.`
        : stuck ? `Gortex reports ready${gitMs === null ? "" : " and Git is fast"}, but checkout discovery fails for all ${probes.length} ${probes.length === 1 ? "repository" : "repositories"} even on quick retries. It looks stuck rather than busy.`
        : `${failures.length} of ${probes.length} did not answer, even on quick retries.`,
      evidence: failures.length ? trim(failures.join(" · "), 400) : retried.length ? `needed a retry: ${retried.join(", ")}` : null,
    });
    if (stuck) add({ id: "daemon-restart", title: "Restart the Gortex daemon", detail: "Runs gortex daemon restart. Every client on this host reconnects, and running agents lose their Gortex session briefly.", risk: "host-wide", target: null });
    if (!stuck && (retried.length || (warming && gitSlow))) add({ id: "recheck", title: "Wait and re-check", detail: "Runs the same checks again. If Git is slow, free up the CPU or check antivirus first.", risk: "safe", target: null });
    if (busy) {
      checks.push({
        id: "capacity", title: "Request capacity", state: "warn",
        detail: `${busyMessage} Restarting Paseo on this host has cleared this before, because it ends the agent sessions holding the slots; it also ends running agents.`,
        evidence: sessions.length ? `${sessions.length} connected: ${summarizeSessions(sessions)}` : null,
      });
      add({ id: "recheck", title: "Wait and re-check", detail: "Runs the same checks again once the current requests finish.", risk: "safe", target: null });
    }
    // 6. Worktrees whose folders are gone still cost Gortex discovery work on its single build lane.
    if (this.cli.git) {
      const stale: { repo: string; path: string; count: number }[] = [];
      const git = this.cli.git;
      const counts = await Promise.all(probes.map(row => git(["worktree", "list", "--porcelain"], row.path)
        .then(output => output.split(/\r?\n/).filter(line => line.startsWith("prunable")).length, () => 0 /* Not a Git repository, or Git is unavailable: nothing to prune. */)));
      probes.forEach((row, index) => { if (counts[index] > 0) stale.push({ repo: row.repo, path: row.path, count: counts[index] }); });
      checks.push({
        id: "worktrees", title: "Stale worktrees", state: stale.length ? "warn" : "pass",
        detail: stale.length ? `${stale.reduce((sum, item) => sum + item.count, 0)} worktree record${stale.length === 1 && stale[0].count === 1 ? "" : "s"} point at folders that no longer exist.` : "No leftover worktree records.",
        evidence: stale.length ? stale.map(item => `${item.repo}: ${item.count}`).join(" · ") : null,
      });
      for (const item of stale) add({ id: `${PRUNE}${item.path}`, title: `Prune stale worktrees in ${item.repo}`, detail: "Runs git worktree prune, which removes Git's records of worktrees whose folders are already gone. No files or branches are deleted.", risk: "safe", target: item.path });
    }
    if (warming) add({ id: "recheck", title: "Wait and re-check", detail: warmingUpMessage, risk: "safe", target: null });
    if (failures.length && !busy && !warming && !stuck) {
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
        case remedy.id.startsWith(PRUNE): {
          const path = remedy.target ?? remedy.id.slice(PRUNE.length);
          if (!this.cli.git) throw new Error("Git is unavailable on this host.");
          await this.cli.git(["worktree", "prune"], path);
          job.steps.push(`Pruned stale worktree records in ${path}.`);
          break;
        }
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
