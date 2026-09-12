import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import type { PaseoProject } from "../shared/catalog-browser.ts";
import type { NativeAssignment, Repository } from "../shared/models.ts";
import { runProcess } from "./process-runner.ts";
import { QueryCache } from "./query-cache.ts";

export function repositoryPathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export type ProjectDirectory = { path: string; state: "untracked" | "worktree" | "unsupported" | "unavailable"; error: string | null };

type ProjectDirectoryIo = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  runProcess: typeof runProcess;
};
const hostIo: ProjectDirectoryIo = { realpath, stat, lstat, runProcess };
const discoveryTimeoutMessage = "Project discovery exceeded its time budget. Refresh to retry; this folder is unavailable for indexing until it can be verified.";
class DiscoveryTimeout extends Error { constructor() { super(discoveryTimeoutMessage); } }
const unavailableProject = (path: string): ProjectDirectory => ({ path, state: "unavailable", error: discoveryTimeoutMessage });

/** A shared cached probe may belong to a newer request with a later deadline. */
function waitForProject(path: string, deadline: number, result: Promise<ProjectDirectory>): Promise<ProjectDirectory> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(unavailableProject(path)), Math.max(1, Math.ceil(deadline - performance.now())));
    result.then(directory => {
      clearTimeout(timer);
      resolve(performance.now() >= deadline ? unavailableProject(path) : directory);
    }, error => { clearTimeout(timer); reject(error); });
  });
}

/** A timed-out OS read keeps its slot until it settles; queued reads never outlive their deadline. */
class DiscoveryReads {
  private active = 0;
  private waiting = new Set<() => void>();
  run<T>(deadline: number, work: () => Promise<T>): Promise<T> {
    if (performance.now() >= deadline) return Promise.reject(new DiscoveryTimeout());
    return new Promise((resolve, reject) => {
      let settled = false;
      const expire = () => {
        if (settled) return;
        settled = true;
        this.waiting.delete(start);
        clearTimeout(timer);
        reject(new DiscoveryTimeout());
      };
      const complete = (deliver: () => void) => {
        this.active--;
        if (!settled) {
          if (performance.now() >= deadline) expire();
          else { settled = true; clearTimeout(timer); deliver(); }
        }
        this.drain();
      };
      const start = () => {
        if (settled) return;
        if (performance.now() >= deadline) { expire(); return; }
        this.active++;
        try { work().then(value => complete(() => resolve(value)), error => complete(() => reject(error))); }
        catch (error) { complete(() => reject(error)); }
      };
      const timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - performance.now())));
      if (this.active < 4) start();
      else this.waiting.add(start);
    });
  }
  private drain(): void {
    while (this.active < 4 && this.waiting.size) {
      const next = this.waiting.values().next().value!;
      this.waiting.delete(next);
      next();
    }
  }
}

async function inspectDirectory(path: string, deadline: number, io: ProjectDirectoryIo, reads: DiscoveryReads): Promise<ProjectDirectory> {
  let canonical = path;
  try {
    if (!isAbsolute(path)) throw new Error("The project needs an absolute path on the selected host.");
    canonical = await reads.run(deadline, () => io.realpath(path));
    if (!(await reads.run(deadline, () => io.stat(canonical))).isDirectory()) throw new Error("The project directory is unavailable.");
    let control = await reads.run(deadline, () => io.lstat(join(canonical, ".git"))).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!control) {
      try {
        const root = (await reads.run(deadline, () => io.runProcess("git", ["-C", canonical, "rev-parse", "--show-toplevel"], canonical, { timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now())), maxBytes: 65536 }))).trimEnd();
        if (!isAbsolute(root) || /[\r\n]/.test(root)) throw new Error("Invalid Git root response.");
        canonical = await reads.run(deadline, () => io.realpath(root));
        control = await reads.run(deadline, () => io.lstat(join(canonical, ".git")));
      } catch (error) {
        if (error instanceof DiscoveryTimeout) throw error;
        return { path: canonical, state: "unsupported", error: "A Git repository root could not be verified. Check Git installation and folder access; plain-folder tracking is not offered." };
      }
    }
    if (control.isFile() || control.isSymbolicLink()) return { path: canonical, state: "worktree", error: "This folder uses a Git worktree or submodule control path. It may already have an automatic Gortex view; ordinary dedicated tracking is not offered here." };
    if (!control.isDirectory()) throw new Error("Unsupported Git control path.");
    return { path: canonical, state: "untracked", error: null };
  } catch (error) {
    return { path: canonical, state: "unavailable", error: error instanceof Error ? error.message : "The project directory could not be checked on this host." };
  }
}

/** A bounded directory/Git metadata read. No source, graph discovery, or tracking writes. */
export async function inspectProjectDirectory(path: string): Promise<ProjectDirectory> {
  return inspectDirectory(path, performance.now() + 5000, hostIo, new DiscoveryReads());
}

export type ProjectCatalogOptions = { discoveryBudgetMs?: number; io?: Partial<ProjectDirectoryIo> };

/** Ephemeral presentation candidates; native rows remain the sole membership authority. */
export class ProjectCatalog {
  private cache = new QueryCache(1000);
  private reads = new DiscoveryReads();
  private io: ProjectDirectoryIo;
  private discoveryBudgetMs: number;
  constructor(options: ProjectCatalogOptions = {}) {
    this.io = { ...hostIo, ...options.io };
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? 20_000;
  }
  async merge(rows: NativeAssignment[], projects: PaseoProject[]) {
    const candidates = new Map<string, Repository>();
    const merged = [...rows];
    if (projects.length === 0) return { rows: merged, candidates };
    const deadline = performance.now() + this.discoveryBudgetMs;
    const seen = new Set(rows.map(row => repositoryPathKey(row.path)));
    let nativeComparisonComplete = true;
    for (let start = 0; start < rows.length; start += 4) {
      if (performance.now() >= deadline) { nativeComparisonComplete = false; break; }
      await Promise.all(rows.slice(start, start + 4).map(async row => {
        try { seen.add(repositoryPathKey(await this.reads.run(deadline, () => this.io.realpath(row.path)))); }
        catch (error) {
          // A missing tracked directory still belongs to the native catalog; a timed-out alias comparison is uncertain.
          if (error instanceof DiscoveryTimeout) nativeComparisonComplete = false;
        }
      }));
      if (!nativeComparisonComplete) break;
    }
    const append = (project: PaseoProject, directory: ProjectDirectory) => {
      const key = repositoryPathKey(directory.path);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ repo: project.name, path: directory.path, workspace: "", project: "", source: "paseo-project" });
      candidates.set(key, { name: project.name, path: directory.path, declaredWorkspace: "", declaredProject: "", assignmentSource: "paseo-project", workspaceId: null, projectId: null, graphName: null, origin: "paseo", state: directory.state, error: directory.error });
    };
    // Only the current batch can be pending. Once time expires, fill presentation rows without launching more IO.
    for (let start = 0; start < projects.length; start += 4) {
      if (!nativeComparisonComplete || performance.now() >= deadline) {
        for (const project of projects.slice(start)) append(project, unavailableProject(project.path));
        break;
      }
      const batch = await Promise.all(projects.slice(start, start + 4).map(async project => {
        if (seen.has(repositoryPathKey(project.path))) return null;
        const directory = await waitForProject(project.path, deadline, this.cache.get(repositoryPathKey(project.path), 15_000, () => inspectDirectory(project.path, deadline, this.io, this.reads)));
        return { project, directory };
      }));
      for (const item of batch) if (item) append(item.project, item.directory);
    }
    return { rows: merged, candidates };
  }
  clear(): void { this.cache.clear(); }
}
