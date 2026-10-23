import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { DiagnosticCheck, DiagnosticsReport, Remedy, RepairJob } from "../shared/diagnostics-contracts.ts";
import type { NativeAssignment, NativeInfo } from "../shared/models.ts";
import { nativeCompatibility } from "../shared/native-compatibility.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage, warmupWindowSeconds } from "../shared/native-retry.ts";
import { parseDaemonStatus, summarizeSessions, uptimeSeconds, type DaemonSession, type DaemonStatus } from "./daemon-status.ts";
import { requestTimeouts, type DiagnosticsEvidence, type WorktreeChange } from "./diagnostics-evidence.ts";
import { fullIndexes, lastCrash, readySeconds, stepLabel, triggerLabel, warmupTimeline } from "./warmup.ts";
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
/**
 * evidence: what the checks read without asking Gortex (its log, worktree records); those checks are left out without it.
 * answerWithinMs: how long start() and repair() wait before answering with work still running.
 */
export interface DiagnosticsOptions { maxRepositories?: number; now?: () => number; clock?: () => number; wait?: (ms: number) => Promise<unknown>; evidence?: DiagnosticsEvidence | null; answerWithinMs?: number }
/** The checks as diagnostics.run and diagnostics.latest report them: the latest report, and whether a run is going. */
export interface DiagnosticsRunState { report: DiagnosticsReport | null; running: boolean }

const REINDEX = "reindex:", PRUNE = "prune:";
// Warm-up after a start is normally seconds; past this, a discovery failure on every repository is a wedge.
const STUCK_AFTER_SECONDS = warmupWindowSeconds;
// Gortex allows 250 ms for two Git commands; a single start slower than this leaves no headroom.
const SLOW_GIT_MS = 100;
// A refused first request is retried inside the 5 seconds Gortex keeps its finished Git check.
const PROBE_ATTEMPTS = 5, PROBE_RETRY_MS = 400;
// Repositories are probed a few at a time. When all of a batch are refused, one stuck lane refuses them all, and
// probing the rest would only add to Gortex's work.
const PROBE_BATCH = 3;
const TIMEOUT_WINDOW_MS = 15 * 60_000, WORKTREE_WINDOW_MS = 2 * 60 * 60_000;
// Gortex's own CLI calls and this plugin's connections are not agent chats.
const NOT_AGENTS = new Set(["", "cli", "paseo-gortex"]);
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const REINDEX_WINDOW_MS = 60 * 60_000, CRASH_WINDOW_MS = 24 * 60 * 60_000;
// Gortex answering queries this long after a start delays every agent's first Gortex requests noticeably.
const SLOW_STARTUP_SECONDS = 300;
// Paseo waits 30 seconds for a plugin call. On a host where Git starts slowly the checks take longer, and a repair that
// restarts Gortex takes minutes, so both answer after this and carry on in the background.
const ANSWER_WITHIN_MS = 20_000;
/** `promise`'s value if it settles within `ms`, else `late`. */
function within<T, U>(promise: Promise<T>, ms: number, late: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<U>(resolve => { timer = setTimeout(() => resolve(late), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
/** What the evidence checks read. They start alongside the probes: none of it asks Gortex anything. */
type EvidenceReads = {
  log: Promise<string | null>;
  crash: Promise<{ text: string; writtenAt: number } | null>;
  changedAt: Promise<number | null>;
  changes: Promise<WorktreeChange[]>;
};
/** "45 s", "3 min", "2 h", "2 h 5 min". */
function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}
/** Whether "gortex v0.64.9+abc" is at least 0.64.9. */
function atLeast(version: string, minimum: [number, number, number]): boolean {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  return true;
}
/** Host-local "2026-10-20 10:21", the same clock the host's Gortex logs use. */
function stamp(ms: number): string {
  const date = new Date(ms), pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
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
  private evidence: DiagnosticsEvidence | null;
  private reports = new Map<string, DiagnosticsReport>();
  private jobs = new Map<string, RepairJob>();
  private latestId: string | null = null;
  private running: Promise<unknown> | null = null;
  private checking: Promise<DiagnosticsReport> | null = null;
  private answerWithinMs: number;

  constructor(native: DiagnosticsNative, admin = new RepositoryAdminLock(), invalidate: () => void = () => {}, cli: DiagnosticsCli = hostCli, options: DiagnosticsOptions = {}) {
    this.native = native; this.cli = cli; this.admin = admin; this.invalidate = invalidate;
    this.maxRepositories = options.maxRepositories ?? 12;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.wait = options.wait ?? (ms => delay(ms));
    this.evidence = options.evidence ?? null;
    this.answerWithinMs = options.answerWithinMs ?? ANSWER_WITHIN_MS;
  }

  /**
   * Runs the checks, or joins the run already going. Answers with the report when the checks finish in time;
   * otherwise running is true, and state() reports them once they finish.
   */
  async start(): Promise<DiagnosticsRunState> {
    const run = this.checking ??= this.checkSafely().finally(() => { this.checking = null; });
    const report = await within(run, this.answerWithinMs, null);
    return report ? { report, running: false } : this.state();
  }

  state(): DiagnosticsRunState { return { report: this.latest(), running: this.checking !== null }; }

  /** run(), with an unexpected error reported as a failed check rather than lost in the background. */
  private async checkSafely(): Promise<DiagnosticsReport> {
    const started = this.now();
    try { return await this.run(); }
    catch (error) { return this.finish(started, [{ id: "checks", title: "Checks", state: "fail", detail: "The checks stopped before they finished. Run them again.", evidence: trim(message(error)) }], []); }
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
    let socket: string | null = null;
    let daemonStatus: DaemonStatus | null = null;
    try {
      status = await this.cli.run(["daemon", "status"], 30_000);
      const parsed = parseDaemonStatus(status);
      daemonStatus = parsed;
      daemonRunning = parsed.running; daemonReady = parsed.ready; sessions = parsed.sessions; uptime = uptimeSeconds(parsed.uptime); socket = parsed.socket;
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
    const probes = rows.slice(0, this.maxRepositories);
    const reads = this.evidence ? this.startReads(this.evidence, socket, probes.map(row => row.path)) : null;

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
    // Gortex runs Git before it answers a request and allows that 250 ms; slow process starts on the host
    // (CPU load, antivirus) make first requests fail with "checkout discovery is pending".
    let gitMs: number | null = null;
    if (this.cli.git && probes.length) {
      const git = this.cli.git, samples: number[] = [];
      // Three starts, or two slow ones: the middle of three would be slow too, and each slow start can take a second.
      const settled = () => samples.length === 3 || (samples.length === 2 && samples.every(sample => sample > SLOW_GIT_MS));
      while (!settled()) {
        const began = this.clock();
        try { await git(["rev-parse", "--git-dir"], probes[0].path); samples.push(this.clock() - began); } catch { break; }
      }
      if (settled()) {
        // The second slowest: the middle of three, or the faster of two slow starts.
        gitMs = Math.round(samples.sort((a, b) => a - b)[samples.length - 2]);
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
    let busy = false, warming = false, discoveryFailures = 0, probed = 0;
    for (let start = 0; start < probes.length; start += PROBE_BATCH) {
      const batch = probes.slice(start, start + PROBE_BATCH);
      const results = await Promise.all(batch.map(row => this.probe(row)));
      probed += batch.length;
      let refused = 0;
      for (const result of results) {
        if (result.ok) { if (result.attempts > 1) retried.push(result.row.repo); continue; }
        const { row, text } = result;
        if (isBusyMessage(text)) { busy = true; failures.push(`${row.repo}: refused, dispatcher busy`); }
        else if (isWarmingUpMessage(text)) { warming = true; discoveryFailures++; refused++; failures.push(`${row.repo}: checkout discovery pending`); }
        else failures.push(`${row.repo}: ${trim(text, 120)}`);
      }
      if (refused === batch.length) break;
    }
    const unprobed = probes.length - probed;
    // Stuck means: ready for minutes, Git is fast, nothing is still loading after a start, and every repository asked
    // still refuses after quick retries. A slow Git, or a startup still loading repositories (Gortex 0.64.9 reports
    // that), explains the same refusals without anything being wedged, and a restart would not help.
    const loading = daemonStatus?.repos.filter(repo => repo.state === "loading") ?? [];
    const stuck = !gitSlow && daemonReady && !loading.length && uptime !== null && uptime >= STUCK_AFTER_SECONDS && probed > 0 && discoveryFailures === probed;
    if (stuck) warming = false;
    const notAsked = unprobed ? ` The other ${plural(unprobed, "repository", "repositories")} weren't asked, since asking only adds to Gortex's work while it refuses everything.` : "";
    checks.push({
      id: "repositories", title: "Repository access",
      state: failures.length === 0 ? retried.length ? "warn" : "pass" : stuck ? "fail" : busy || warming ? "warn" : "fail",
      detail: failures.length === 0
        ? retried.length ? `All ${probes.length} answer, but ${retried.length} only on a retry. Agents can see "checkout discovery is pending" on a first request; repeating the request right away works.`
          : `All ${probes.length} checked ${probes.length === 1 ? "repository answers" : "repositories answer"}.`
        : stuck ? `Gortex reports ready${gitMs === null ? "" : " and Git is fast"}, but checkout discovery fails for ${unprobed ? `the first ${probed}` : `all ${probed}`} ${probed === 1 ? "repository" : "repositories"} even on quick retries. It looks stuck rather than busy.${notAsked}`
        : `${failures.length} of ${probed} did not answer, even on quick retries.${notAsked}`,
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
    if (reads) await this.evidenceChecks(reads, checks, { sessions, trouble: stuck || discoveryFailures > 0, status: daemonStatus, version, uptime });
    if (warming) add({ id: "recheck", title: "Wait and re-check", detail: "Runs the same checks again. Gortex refuses requests while it discovers checkouts, which normally clears within minutes of a daemon start or a new worktree.", risk: "safe", target: null });
    if (failures.length && !busy && !warming && !stuck) {
      add({ id: "daemon-reload", title: "Reload Gortex configuration", detail: "Runs gortex daemon reload, which re-reads config.yaml and picks up added or removed repositories without a restart.", risk: "safe", target: null });
      add({ id: "daemon-restart", title: "Restart the Gortex daemon", detail: "Runs gortex daemon restart. Every client on this host reconnects, and running agents lose their Gortex session briefly.", risk: "host-wide", target: null });
    }
    return this.finish(started, checks, [...remedies.values()]);
  }

  private startReads(evidence: DiagnosticsEvidence, socket: string | null, repositories: string[]): EvidenceReads {
    return {
      log: evidence.daemonLog(socket).catch(() => null),
      crash: evidence.crashLog(socket).catch(() => null),
      changedAt: evidence.executableChangedAt().catch(() => null),
      changes: evidence.worktreeChanges(repositories, this.now() - WORKTREE_WINDOW_MS).catch((): WorktreeChange[] => []),
    };
  }

  /** Checks read without asking Gortex: timeouts in its log, recent worktree changes, and chats older than its last update. */
  private async evidenceChecks(reads: EvidenceReads, checks: DiagnosticCheck[], context: { sessions: DaemonSession[]; trouble: boolean; status: DaemonStatus | null; version: string; uptime: number | null }): Promise<void> {
    const now = this.now();
    const log = await reads.log;
    this.startupCheck(checks, context.status, context.uptime, log, now);
    let timedOut = 0;
    if (log === null) checks.push({ id: "timeouts", title: "Requests that ran out of time", state: "skipped", detail: "Gortex's daemon log can't be read on this host, so request timeouts weren't checked.", evidence: null });
    else {
      const timeouts = requestTimeouts(log, now - TIMEOUT_WINDOW_MS);
      timedOut = timeouts.count;
      const clients = new Map<string, number>();
      for (const [id, count] of timeouts.sessions) {
        const client = context.sessions.find(session => session.id === id)?.client || "a closed session";
        clients.set(client, (clients.get(client) ?? 0) + count);
      }
      checks.push({
        id: "timeouts", title: "Requests that ran out of time", state: timedOut ? "warn" : "pass",
        detail: timedOut
          ? `${plural(timedOut, "request")} in the last 15 minutes waited out Gortex's ${timeouts.deadlineSeconds ?? 60}-second limit without an answer. While one waits, it takes one of the 8 requests Gortex serves at a time, so other agents can be refused as busy.`
          : "No request waited out Gortex's time limit in the last 15 minutes.",
        evidence: timedOut ? trim(`${[...clients].map(([client, count]) => `${count} from ${client}`).join(", ")} · latest at ${timeouts.latest.map(at => stamp(at).slice(11)).join(", ")}`, 300) : null,
      });
    }
    // Gortex discovers every worktree that's added or removed.
    const changes = await reads.changes;
    if (changes.length) {
      const added = changes.filter(change => change.change === "added").length, removed = changes.length - added;
      const what = added && removed ? `${plural(added, "worktree was", "worktrees were")} added and ${removed} removed`
        : added ? `${plural(added, "worktree was", "worktrees were")} added` : `${plural(removed, "worktree was", "worktrees were")} removed`;
      const trouble = context.trouble || timedOut > 0;
      checks.push({
        id: "worktree-changes", title: "Recent worktree changes", state: trouble ? "warn" : "pass",
        detail: trouble
          ? `${what} in the last 2 hours, the latest ${Math.max(1, Math.round((now - changes[0].at) / 60_000))} min ago. Gortex discovers every worktree that's added or removed, and on some Windows hosts that discovery doesn't finish, which leaves every repository waiting.`
          : `${what} in the last 2 hours. Gortex discovers each one, and it answered normally afterwards.`,
        evidence: trim(changes.slice(0, 8).map(change => `${change.change} ${stamp(change.at).slice(11)} ${change.path}${change.source === "paseo" ? " (Paseo)" : ""}`).join(" · "), 400),
      });
    }
    this.crashCheck(checks, await reads.crash, log, now);
    this.reindexCheck(checks, context.version, log, now);
    // A chat's Gortex tools come from the Gortex that was installed when it connected.
    const changedAt = await reads.changedAt;
    const agents = context.sessions.filter(session => !NOT_AGENTS.has(session.client));
    if (changedAt !== null && agents.length) {
      const older = agents.filter(session => { const seconds = uptimeSeconds(session.connected); return seconds !== null && now - seconds * 1000 < changedAt; });
      checks.push({
        id: "sessions", title: "Agent chats", state: older.length ? "warn" : "pass",
        detail: older.length
          ? `${plural(older.length, "agent chat was", "agent chats were")} already open when Gortex was last updated (${stamp(changedAt)}). They keep the previous Gortex tools until they're restarted, so their agents can report Gortex tools as missing.`
          : `${plural(agents.length, "agent chat is", "agent chats are")} connected, all opened after Gortex was last updated (${stamp(changedAt)}). A chat that has run for a long time can still keep older Gortex tools; restart it if its agent reports them missing.`,
        evidence: older.length ? trim(older.map(session => `${session.client}, connected ${session.connected}, ${session.cwd}`).join(" · "), 400) : null,
      });
    }
  }

  /**
   * How the daemon's startup went: still loading (Gortex 0.64.9 marks repositories "loading" until warmup ends), or how
   * long the last one took and its slowest steps, from `daemon status` and the startup steps in the log.
   */
  private startupCheck(checks: DiagnosticCheck[], status: DaemonStatus | null, uptime: number | null, log: string | null, now: number): void {
    if (!status?.running) return;
    const timeline = log ? warmupTimeline(log) : null;
    const loading = status.repos.filter(repo => repo.state === "loading");
    const steps = timeline?.steps.map(step => `${stepLabel(step.step)} ${step.seconds === null ? "running" : `${step.seconds.toFixed(1)} s`}`).join(" · ") ?? null;
    if (!status.ready || loading.length) {
      const names = loading.slice(0, 5).map(repo => repo.name).join(", ") + (loading.length > 5 ? ` and ${loading.length - 5} more` : "");
      const running = timeline?.running;
      checks.push({
        id: "startup", title: "Startup", state: "warn",
        detail: `Gortex started ${uptime === null ? "recently" : `${duration(uptime)} ago`} and is still ${loading.length ? `loading ${loading.length} of ${status.repos.length} repositories (${names})` : "warming up"}.${running ? ` Current step: ${stepLabel(running.step)}, running for ${duration(Math.max(0, (now - running.startedAt) / 1000))}.` : ""} Requests for repositories still loading are refused until then; this usually takes seconds to a few minutes.`,
        evidence: steps ? trim(steps, 400) : null,
      });
      return;
    }
    // "ready — queryable (warmup 4s); enriching 2/5 repos": answering queries, but the startup isn't finished.
    const enriching = timeline?.readySeconds == null && /^ready\b.*\bqueryable\b/.test(status.state ?? "") ? /;\s*(.+)$/.exec(status.state ?? "")?.[1]?.trim() ?? null : null;
    if (enriching) {
      const answered = timeline?.queryableSeconds ?? readySeconds(status.state);
      checks.push({
        id: "startup", title: "Startup", state: "pass",
        detail: `Gortex has answered queries since ${answered === null ? "shortly" : `${duration(answered)}`} after starting, and is still finishing its startup (${enriching}).`,
        evidence: steps ? trim(steps, 400) : null,
      });
      return;
    }
    const seconds = timeline?.readySeconds ?? readySeconds(status.state);
    const queryable = timeline?.queryableSeconds ?? null;
    const longest = (timeline?.steps ?? []).filter(step => (step.seconds ?? 0) >= 1).sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)).slice(0, 3);
    const repo = timeline?.slowestRepo && timeline.slowestRepo.seconds >= 1 ? timeline.slowestRepo : null;
    if (seconds === null && !longest.length) return;
    // What agents wait for is Gortex answering queries; the rest of a startup runs alongside them. Gortex before 0.64.9
    // doesn't log when that was, so its startup time alone isn't a verdict.
    const slow = queryable !== null && queryable > SLOW_STARTUP_SECONDS;
    const detail = [
      seconds === null ? null : `The last startup took ${duration(seconds)}${queryable !== null && seconds - queryable >= 1 ? `, and Gortex answered queries after ${duration(queryable)}` : ""}.`,
      longest.length ? `The longest parts were ${longest.map(step => `${stepLabel(step.step)} (${duration(step.seconds!)})`).join(", ")}${repo ? `; ${repo.path.split(/[\\/]/).filter(Boolean).pop()} took longest to load (${duration(repo.seconds)})` : ""}.` : null,
      slow ? "Until Gortex answers queries it refuses agents' requests, so a startup this slow holds them up after every restart; other programs using the CPU or scanning each file usually explain it." : null,
    ].filter(Boolean).join(" ");
    checks.push({ id: "startup", title: "Startup", state: slow ? "warn" : "pass", detail, evidence: steps ? trim(steps, 400) : null });
  }

  /** A crash in the last day, from Gortex 0.64.9's crash log or stack dumps that older versions wrote into the daemon log. */
  private crashCheck(checks: DiagnosticCheck[], stderr: { text: string; writtenAt: number } | null, log: string | null, now: number): void {
    if (log === null && stderr === null) {
      checks.push({ id: "crashes", title: "Crashes", state: "skipped", detail: "Gortex's logs can't be read on this host, so crashes weren't checked.", evidence: null });
      return;
    }
    const found = [stderr ? lastCrash(stderr.text, stderr.writtenAt) : null, log ? lastCrash(log, null) : null]
      .filter((crash): crash is NonNullable<typeof crash> => crash !== null && crash.at !== null && now - crash.at <= CRASH_WINDOW_MS)
      .sort((a, b) => b.at! - a.at!);
    const crash = found[0];
    if (!crash) { checks.push({ id: "crashes", title: "Crashes", state: "pass", detail: "No crash in the last day.", evidence: null }); return; }
    const back = crash.restartedAt !== null ? ` Gortex was logging again ${duration(Math.max(0, (crash.restartedAt - crash.at!) / 1000))} later.` : "";
    checks.push({
      id: "crashes", title: "Crashes", state: "warn",
      detail: `Gortex crashed or wrote a stack dump ${duration((now - crash.at!) / 1000)} ago (${crash.summary}).${back} Agents lose Gortex until it's running again. If this repeats, the dump in its log is what to report to Gortex.`,
      evidence: `${stamp(crash.at!)}: ${crash.summary}`,
    });
  }

  /** Full rebuilds of a repository's index in the last hour and what triggered them (logged from Gortex 0.64.9 on). */
  private reindexCheck(checks: DiagnosticCheck[], version: string, log: string | null, now: number): void {
    if (log === null) return;
    if (!atLeast(version, [0, 64, 9])) {
      checks.push({ id: "reindexes", title: "Full reindexes", state: "skipped", detail: "Gortex logs why it rebuilds a repository's whole index from 0.64.9 on.", evidence: null });
      return;
    }
    const all = fullIndexes(log, now - REINDEX_WINDOW_MS);
    const atStartup = all.filter(entry => entry.origin === "daemon_warmup").length;
    const others = all.filter(entry => entry.origin !== "daemon_warmup");
    const byRepo = new Map<string, Map<string, number>>();
    for (const entry of others) {
      const triggers = byRepo.get(entry.repo) ?? new Map<string, number>();
      triggers.set(entry.origin, (triggers.get(entry.origin) ?? 0) + 1);
      byRepo.set(entry.repo, triggers);
    }
    const times = (count: number) => count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
    const repeated = [...byRepo.values()].some(triggers => [...triggers.values()].reduce((sum, count) => sum + count, 0) >= 2);
    const busy = others.length >= 3 || repeated;
    const startupNote = atStartup ? ` (plus ${plural(atStartup, "rebuild")} at startup)` : "";
    const detail = !all.length ? "No repository's whole index was rebuilt in the last hour."
      : !others.length ? `${plural(atStartup, "repository index was", "repository indexes were")} rebuilt at startup in the last hour, and none since.`
      : `Gortex rebuilt a repository's whole index ${times(others.length)} in the last hour${startupNote}: ${[...byRepo].map(([repo, triggers]) => `${repo} ${[...triggers].map(([origin, count]) => `${times(count)} ${triggerLabel(origin)}`).join(" and ")}`).join("; ")}.${busy ? " Each rebuild uses CPU for a while, and requests can wait or be refused meanwhile." : ""}`;
    checks.push({
      id: "reindexes", title: "Full reindexes", state: busy ? "warn" : "pass", detail,
      evidence: others.length ? trim(others.slice(-8).map(entry => `${stamp(entry.at).slice(11)} ${entry.repo} (${entry.origin})`).join(" · "), 400) : null,
    });
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
    // A job that outlasts this is followed with job().
    await within(this.running, this.answerWithinMs, null);
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
