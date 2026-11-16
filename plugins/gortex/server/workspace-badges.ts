import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { WorkspaceBadge } from "../shared/workspace-badge-contracts.ts";
import { findEnclosingGit, repositoryPathKey } from "./project-catalog.ts";

/** A Paseo workspace and its folder on this host. */
export interface BadgeWorkspace { id: string; directory: string }
/** The part of the server's Paseo API this reads: the host's workspaces. */
export interface BadgePaseo {
  workspaces: { list(options?: { page?: { limit: number; cursor?: string } }): Promise<{ entries: { id: string; projectRootPath: string; workspaceDirectory?: string }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } }> };
}
export interface WorkspaceBadgeOptions {
  /** The repositories Gortex tracks. `gortex workspace list` reads their declarations, not the daemon. */
  tracked(): Promise<string[]>;
  /** What the stall guard pauses right now; held in memory. */
  paused(): { host: boolean; repositories: string[] };
  now?: () => number;
  maxAgeMs?: number;
}
type Cover = { badge: "not-indexed" } | { badge: "covered"; keys: string[] };
type Coverage = Cover & { id: string };

const canonical = (path: string) => realpath(path).then(repositoryPathKey, () => repositoryPathKey(path));
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * The main repository a folder belongs to, read from Git's own files without running Git: the enclosing repository,
 * or for a linked worktree (a .git file) the repository its commondir names. A Paseo task worktree is never tracked
 * itself; Gortex serves it as an overlay of that main repository. null for a plain folder, undefined when unknown
 * (a submodule, a bare repository, an unreadable control file).
 */
export async function mainRepository(folder: string): Promise<string | null | undefined> {
  const git = await findEnclosingGit(folder).catch(() => undefined);
  if (git === undefined || git === null) return git;
  if (git.control.isDirectory()) return git.root;
  if (!git.control.isFile()) return undefined;
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec((await readFile(join(git.root, ".git"), "utf8")).slice(0, 4096))?.[1];
    if (!gitdir) return undefined;
    const linked = resolve(git.root, gitdir);
    const common = resolve(linked, (await readFile(join(linked, "commondir"), "utf8")).slice(0, 4096).trim());
    return basename(common).toLowerCase() === ".git" ? dirname(common) : undefined;
  } catch { return undefined; }
}

/** The host's Paseo workspaces, a page at a time, up to 1,000. */
export async function listWorkspaces(paseo: BadgePaseo): Promise<BadgeWorkspace[]> {
  const workspaces: BadgeWorkspace[] = [];
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.workspaces.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
    for (const entry of entries) workspaces.push({ id: entry.id, directory: entry.workspaceDirectory || entry.projectRootPath });
    cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
  } while (cursor && workspaces.length < 1000);
  return workspaces;
}

/**
 * What workspace rows show: "not-indexed" for a folder inside a Git repository that no tracked repository covers,
 * "paused" for a covered one while the stall guard pauses its repository or the host, and nothing otherwise (plain
 * folders, Gortex missing, anything uncertain). The survey of workspaces and tracked repositories is shared by every
 * caller and taken at most once per maxAgeMs; it asks Gortex nothing. Pauses are read fresh, from memory.
 */
export class WorkspaceBadges {
  private cached: { at: number; value: Promise<Coverage[]> } | null = null;
  private options: WorkspaceBadgeOptions;
  private now: () => number;
  private maxAgeMs: number;
  constructor(options: WorkspaceBadgeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 60_000;
  }

  async read(workspaces: () => Promise<BadgeWorkspace[]>): Promise<{ badges: Record<string, WorkspaceBadge> }> {
    const now = this.now();
    if (!this.cached || now - this.cached.at >= this.maxAgeMs) this.cached = { at: now, value: this.survey(workspaces).catch(() => []) };
    const coverage = await this.cached.value;
    const paused = this.options.paused(), pausedKeys = new Set(paused.repositories.map(repositoryPathKey));
    const badges: Record<string, WorkspaceBadge> = {};
    for (const item of coverage) {
      if (item.badge === "not-indexed") badges[item.id] = "not-indexed";
      else if (paused.host || item.keys.some(key => pausedKeys.has(key))) badges[item.id] = "paused";
    }
    return { badges };
  }

  private async survey(list: () => Promise<BadgeWorkspace[]>): Promise<Coverage[]> {
    const [workspaces, tracked] = await Promise.all([list(), this.options.tracked()]);
    const roots = await Promise.all(tracked.map(canonical));
    const folders = new Map<string, Promise<Cover | null>>();
    const coverage: Coverage[] = [];
    for (let start = 0; start < workspaces.length; start += 8) {
      const batch = workspaces.slice(start, start + 8);
      const results = await Promise.all(batch.map(workspace => {
        const key = normalize(workspace.directory);
        if (!folders.has(key)) folders.set(key, this.cover(workspace.directory, roots));
        return folders.get(key)!;
      }));
      results.forEach((result, i) => { if (result) coverage.push({ id: batch[i].id, ...result }); });
    }
    return coverage;
  }

  private async cover(directory: string, roots: string[]): Promise<Cover | null> {
    if (!isAbsolute(directory)) return null;
    const real = await realpath(directory).catch(() => normalize(directory)), folder = repositoryPathKey(real);
    const main = await mainRepository(real);
    const repository = typeof main === "string" ? await canonical(main) : null;
    const covering = roots.filter(root => within(folder, root) || (repository !== null && within(repository, root)));
    if (covering.length) return { badge: "covered", keys: [...covering, folder, ...(repository ? [repository] : [])] };
    // A plain folder, an unknown repository, or one that holds a tracked folder: nothing to say.
    if (repository === null || roots.some(root => within(root, repository) || within(root, folder))) return null;
    return { badge: "not-indexed" };
  }
}
