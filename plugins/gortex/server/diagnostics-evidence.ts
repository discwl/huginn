import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveHostExecutable } from "./host-executable.ts";
import { runProcess } from "./process-runner.ts";

/** A worktree that appeared or went away: from Paseo's workspace events, or Git's own worktree records. */
export interface WorktreeChange { path: string; change: "added" | "removed"; at: number; source: "paseo" | "git" }

/**
 * What diagnostics read besides Gortex's own answers: none of it sends Gortex a request, so it still works, and
 * adds nothing, while Gortex is stuck.
 */
export interface DiagnosticsEvidence {
  /** The end of Gortex's daemon log (next to its socket), or null when it can't be read. */
  daemonLog(socket: string | null): Promise<string | null>;
  /** Gortex 0.64.9's crash log (daemon.stderr.log beside the daemon log) and when it was last written, or null. */
  crashLog(socket: string | null): Promise<{ text: string; writtenAt: number } | null>;
  /** When the Gortex executable on this host was last replaced (ms since the epoch), or null. */
  executableChangedAt(): Promise<number | null>;
  /** Worktrees of these repositories added or removed since `since`. */
  worktreeChanges(repositories: string[], since: number): Promise<WorktreeChange[]>;
}

const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

/** Worktrees Paseo creates and archives while this plugin runs, from its workspace lifecycle events. */
export class CheckoutActivity {
  private changes: WorktreeChange[] = [];
  private worktrees = new Set<string>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** A new workspace whose folder is a linked Git worktree (its .git is a file, not a folder). */
  async created(cwd: string): Promise<void> {
    const git = await lstat(join(cwd, ".git")).catch(() => null);
    if (!git?.isFile()) return;
    this.worktrees.add(key(cwd));
    this.record({ path: cwd, change: "added", at: this.now(), source: "paseo" });
  }

  /** An archived workspace that was a worktree: one Paseo created here, or one whose folder is already gone. */
  async archived(cwd: string): Promise<void> {
    const known = this.worktrees.delete(key(cwd));
    if (!known && await lstat(cwd).then(() => true, () => false)) return;
    this.record({ path: cwd, change: "removed", at: this.now(), source: "paseo" });
  }

  recent(since: number): WorktreeChange[] { return this.changes.filter(change => change.at >= since); }

  private record(change: WorktreeChange): void {
    this.changes.push(change);
    if (this.changes.length > 50) this.changes.splice(0, this.changes.length - 50);
  }
}

/** The last `bytes` of a file, starting at a whole line. */
async function tail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await handle.close(); }
}

/**
 * The Git folder a repository's worktrees share, read from its .git where possible: on some hosts each Git start takes
 * a second, and diagnostics asks this for every repository.
 */
async function commonGitDir(repository: string): Promise<string> {
  const dotGit = join(repository, ".git");
  const info = await stat(dotGit).catch(() => null);
  if (info?.isDirectory()) return dotGit;
  // A linked worktree: its .git file names its own folder, whose commondir file points at the shared one.
  const own = info?.isFile() ? /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"))?.[1] : undefined;
  if (own) {
    const folder = resolve(repository, own);
    const common = (await readFile(join(folder, "commondir"), "utf8").catch(() => "")).trim();
    return common ? resolve(folder, common) : folder;
  }
  // A folder inside a repository, or a Git folder kept elsewhere: Git knows.
  return resolve(repository, (await runProcess("git", ["rev-parse", "--git-common-dir"], repository, { timeoutMs: 10_000, maxBytes: 16_000 })).trim());
}

/** Worktrees Git created since `since`, from the entries in the repository's shared worktrees folder. */
async function gitWorktreesAdded(repository: string, since: number): Promise<WorktreeChange[]> {
  const folder = join(await commonGitDir(repository), "worktrees");
  const changes: WorktreeChange[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const record = join(folder, entry.name);
    const info = await stat(record).catch(() => null);
    const at = info ? info.birthtimeMs || info.ctimeMs : 0;
    if (at < since) continue;
    // gitdir holds the path of the worktree's own .git file.
    const gitdir = (await readFile(join(record, "gitdir"), "utf8").catch(() => "")).trim();
    changes.push({ path: gitdir ? dirname(gitdir) : record, change: "added", at, source: "git" });
  }
  return changes;
}

const logFolder = (socket: string | null) => socket ? dirname(socket) : join(homedir(), ".gortex", "cache");

/**
 * When an executable was installed: the time the file was created here. Its modified time can't be used, because an
 * installer can keep the release archive's time (on 2026-10-23 that was hours in the future); ctime stands in where
 * the file system records no creation time.
 */
export function installTime(info: { birthtimeMs: number; ctimeMs: number }, now: number): number {
  return Math.min(info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs, now);
}

export function hostEvidence(activity: CheckoutActivity): DiagnosticsEvidence {
  return {
    async daemonLog(socket) {
      return tail(join(logFolder(socket), "daemon.log"), 1024 * 1024).catch(() => null);
    },
    async crashLog(socket) {
      const file = join(logFolder(socket), "daemon.stderr.log");
      try {
        const info = await stat(file);
        return { text: await tail(file, 256 * 1024), writtenAt: info.mtimeMs };
      } catch { return null; }
    },
    async executableChangedAt() {
      try { return installTime(await stat(await resolveHostExecutable("gortex")), Date.now()); }
      catch { return null; }
    },
    async worktreeChanges(repositories, since) {
      const added = await Promise.all(repositories.map(repository => gitWorktreesAdded(repository, since).catch((): WorktreeChange[] => [])));
      const found = [...activity.recent(since), ...added.flat()];
      const unique = new Map<string, WorktreeChange>();
      for (const change of found) {
        const id = `${change.change}:${key(change.path.replace(/[\\/]+$/, ""))}`;
        if (!unique.has(id) || change.source === "paseo") unique.set(id, change);
      }
      return [...unique.values()].sort((a, b) => b.at - a.at);
    },
  };
}

/** Requests the daemon log says waited out Gortex's per-request limit since `since`. */
export function requestTimeouts(log: string, since: number): { count: number; deadlineSeconds: number | null; sessions: Map<string, number>; latest: number[] } {
  const sessions = new Map<string, number>(), times: number[] = [];
  let deadlineSeconds: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes("mcp request lifetime ended")) continue;
    let entry: { msg?: unknown; ts?: unknown; outcome?: unknown; session_id?: unknown; deadline?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.msg !== "daemon: mcp request lifetime ended" || entry.outcome !== "deadline" || typeof entry.ts !== "number") continue;
    const at = entry.ts * 1000;
    if (at < since) continue;
    times.push(at);
    if (typeof entry.deadline === "number") deadlineSeconds = entry.deadline;
    const session = typeof entry.session_id === "string" ? entry.session_id : "unknown";
    sessions.set(session, (sessions.get(session) ?? 0) + 1);
  }
  return { count: times.length, deadlineSeconds, sessions, latest: times.slice(-5) };
}
