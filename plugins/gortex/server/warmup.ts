import { parseDaemonStatus, uptimeSeconds, type DaemonRepo } from "./daemon-status.ts";

/** One step or phase of a daemon startup, from the "daemon: warmup step/phase" log lines; seconds is null while it runs. */
export interface WarmupStep { step: string; startedAt: number; seconds: number | null }
/**
 * The latest startup in the log, from its "daemon: warmup starting" line. running is the latest step or phase still in
 * progress; queryableSeconds and readySeconds are when Gortex could answer queries and when its warmup ended; the
 * slowest repository is the one that took longest to load.
 */
export interface WarmupTimeline {
  startedAt: number; steps: WarmupStep[]; running: WarmupStep | null;
  queryableSeconds: number | null; readySeconds: number | null; slowestRepo: { path: string; seconds: number } | null;
}

/** "checkout_catalog_seed" reads as "checkout catalog seed". */
export const stepLabel = (step: string) => step.replace(/_/g, " ");

type LogEntry = Record<string, unknown> & { msg?: unknown; ts?: unknown };
function* entries(log: string, marker: string): Generator<LogEntry> {
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(marker)) continue;
    try { yield JSON.parse(line) as LogEntry; } catch { /* Not a JSON log line. */ }
  }
}

const startMarker = '"msg":"daemon: warmup starting"';
const preludeMarker = /"msg":"daemon: warmup step start".*"step":"prelude"/;

export function warmupTimeline(log: string): WarmupTimeline | null {
  const lines = log.split(/\r?\n/);
  // The latest startup begins at "daemon: warmup starting"; logs without that line begin it at the "prelude" step.
  let first = -1;
  for (let index = lines.length - 1; index >= 0 && first < 0; index--) if (lines[index].includes(startMarker)) first = index;
  for (let index = lines.length - 1; index >= 0 && first < 0; index--) if (preludeMarker.test(lines[index])) first = index;
  if (first < 0) return null;
  const steps = new Map<string, WarmupStep>();
  let startedAt: number | null = null, queryableSeconds: number | null = null, readySeconds: number | null = null;
  let slowestRepo: WarmupTimeline["slowestRepo"] = null;
  const seconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  for (const entry of entries(lines.slice(first).join("\n"), '"msg":"daemon: ')) {
    if (typeof entry.ts !== "number") continue;
    const at = entry.ts * 1000;
    startedAt ??= at;
    const name = typeof entry.step === "string" ? entry.step : typeof entry.phase === "string" ? entry.phase : null;
    switch (entry.msg) {
      case "daemon: warmup step start": case "daemon: warmup phase start":
        if (name) steps.set(name, { step: name, startedAt: at, seconds: null });
        break;
      case "daemon: warmup step complete": case "daemon: warmup phase done": {
        if (!name) break;
        const elapsed = seconds(entry.elapsed);
        const step = steps.get(name) ?? { step: name, startedAt: at - (elapsed ?? 0) * 1000, seconds: null };
        step.seconds = elapsed ?? Math.max(0, (at - step.startedAt) / 1000);
        steps.set(name, step);
        break;
      }
      case "daemon: warmup repo elapsed": {
        const elapsed = seconds(entry.elapsed);
        if (typeof entry.path === "string" && elapsed !== null && (!slowestRepo || elapsed > slowestRepo.seconds)) slowestRepo = { path: entry.path, seconds: elapsed };
        break;
      }
      case "daemon: graph queryable": queryableSeconds = seconds(entry.warmup); break;
      case "daemon: enrichment complete": readySeconds = seconds(entry.warmup); break;
    }
  }
  if (startedAt === null) return null;
  const list = [...steps.values()];
  return { startedAt, steps: list, running: readySeconds === null ? list.filter(step => step.seconds === null).at(-1) ?? null : null, queryableSeconds, readySeconds, slowestRepo };
}

/** How long the daemon took to become ready, from `daemon status`'s "ready (warmup 34s)". */
export function readySeconds(state: string | null): number | null {
  const match = /\bwarmup\s+([0-9dhms.]+)\)?/.exec(state ?? "");
  if (!match) return null;
  const whole = match[1].replace(/\.\d+(?=s$)/, "");
  return uptimeSeconds(whole);
}

/** What Gortex logs as a full index's trigger, in the user's words. */
const triggers: Record<string, string> = {
  daemon_warmup: "at startup",
  checkout_coordinator: "after a checkout changed (a branch switch, or a worktree added or removed)",
  checkout_promotion: "when a checkout was promoted to its own index",
  index_all: "because a reindex of everything was requested",
  index_repo: "because a reindex was requested",
  mcp_auto_index: "because an agent's request needed it",
  mcp_auto_track: "because an agent's request tracked a new repository",
  ref_view: "to build a view of another branch or commit",
};
export const triggerLabel = (origin: string) => triggers[origin] ?? "for an unrecorded reason";

/** Full rebuilds of a repository's index since `since`, from Gortex 0.64.9's "indexer: full index started" lines. */
export function fullIndexes(log: string, since: number): { at: number; repo: string; origin: string }[] {
  const found: { at: number; repo: string; origin: string }[] = [];
  for (const entry of entries(log, "indexer: full index started")) {
    if (entry.msg !== "indexer: full index started" || typeof entry.ts !== "number" || entry.ts * 1000 < since) continue;
    found.push({ at: entry.ts * 1000, repo: typeof entry.repo === "string" && entry.repo ? entry.repo : "a repository", origin: typeof entry.origin === "string" ? entry.origin : "unknown" });
  }
  return found;
}

const frame = /^(?:goroutine \d+ \[|\t.+\.go:\d+|created by |panic: |fatal error: |Exception 0x[0-9a-f]+)/;
const header = /^(?:panic: |fatal error: |Exception 0x[0-9a-f]+).*/;
/**
 * The last crash or stack dump in a log: a run of non-JSON lines shaped like a Go stack trace. It is timed by the JSON
 * line before it (the daemon log) or the file's time (the stderr log, which has no JSON lines), and the JSON line after
 * it, if any, shows when the daemon was running again. The summary is Go's own first line when the dump kept it.
 */
export function lastCrash(text: string, fileTime: number | null): { at: number | null; summary: string; restartedAt: number | null } | null {
  let lastTs: number | null = null, crash: { at: number | null; summary: string; restartedAt: number | null } | null = null, inDump = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("{")) {
      const ts = /"ts":([0-9.]+)/.exec(line);
      if (ts) { lastTs = Number(ts[1]) * 1000; if (inDump && crash && crash.restartedAt === null) crash.restartedAt = lastTs; }
      inDump = false;
      continue;
    }
    if (!frame.test(line)) continue;
    if (!inDump) { crash = { at: lastTs ?? fileTime, summary: "a stack dump", restartedAt: null }; inDump = true; }
    const first = header.exec(line);
    if (first && crash!.summary === "a stack dump") crash!.summary = first[0].trim().slice(0, 160);
  }
  return crash;
}

export interface WarmupState {
  ready: boolean; warming: boolean; uptimeSeconds: number | null;
  repositories: DaemonRepo[];
  loading: DaemonRepo[];
  timeline: WarmupTimeline | null;
  readySeconds: number | null;
}

/** The daemon's startup as `daemon status` and its log describe it; the log adds steps on Gortex 0.64.9 and later. */
export function warmupState(statusText: string, log: string | null): WarmupState {
  const status = parseDaemonStatus(statusText);
  return {
    ready: status.ready, warming: status.warming, uptimeSeconds: uptimeSeconds(status.uptime),
    repositories: status.repos, loading: status.repos.filter(repo => repo.state === "loading"),
    timeline: log ? warmupTimeline(log) : null, readySeconds: readySeconds(status.state),
  };
}

/** Host health's startup line, read from `daemon status` and the log, or null when Gortex isn't starting. */
export async function readWarmupSummary(io: { status(): Promise<string>; log(socket: string | null): Promise<string | null> }, now: () => number = Date.now): Promise<string | null> {
  const text = await io.status();
  const log = await io.log(parseDaemonStatus(text).socket).catch(() => null);
  return describeWarmup(warmupState(text, log), now());
}

/** "Starting: 3 of 5 repositories loaded · step: checkout catalog seed (running 42 s)", or null once ready. */
export function describeWarmup(state: WarmupState, now: number): string | null {
  if (state.ready && !state.loading.length) return null;
  const parts = ["Starting"];
  if (state.repositories.length) parts[0] += `: ${state.repositories.length - state.loading.length} of ${state.repositories.length} repositories loaded`;
  const running = state.timeline?.running;
  if (running) parts.push(`step: ${stepLabel(running.step)} (running ${Math.max(0, Math.round((now - running.startedAt) / 1000))} s)`);
  return parts.join(" · ");
}
