import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { GitStatus } from "../shared/git-contracts.ts";
import { findEnclosingGit } from "./project-catalog.ts";
import { runProcess } from "./process-runner.ts";
import { sameRepositoryPath } from "./repository-config.ts";

export interface GitInitIo {
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  findEnclosingGit: typeof findEnclosingGit;
  run(args: string[], cwd: string): Promise<string>;
  home(): string;
}
const hostIo: GitInitIo = {
  realpath,
  isDirectory: async path => (await stat(path)).isDirectory(),
  findEnclosingGit: path => findEnclosingGit(path),
  run: (args, cwd) => runProcess("git", args, cwd, { timeoutMs: 15000, maxBytes: 65536 }),
  home: homedir,
};
const message = (error: unknown) => error instanceof Error ? error.message : "The folder could not be checked.";

/** Reports whether a folder has Git, and initializes a plain folder on request. Never stages or commits files. */
export class GitInitializer {
  private io: GitInitIo;
  private invalidate: () => void;
  private active = new Set<string>();
  constructor(invalidate: () => void = () => {}, io: Partial<GitInitIo> = {}) {
    this.invalidate = invalidate;
    this.io = { ...hostIo, ...io };
  }

  async status(path: string): Promise<GitStatus> {
    if (!isAbsolute(path)) throw new Error("Choose an absolute folder path on the selected host.");
    let canonical = path;
    try {
      canonical = await this.io.realpath(path);
      if (!(await this.io.isDirectory(canonical))) throw new Error("The selected path is not a folder.");
      const found = await this.io.findEnclosingGit(canonical);
      if (!found) {
        const blocked = sameRepositoryPath(canonical, this.io.home()) || sameRepositoryPath(canonical, dirname(canonical));
        return { path: canonical, state: "plain", root: null, canInitialize: !blocked, reason: blocked ? "Git is not initialized in a home folder or drive root from this plugin." : null };
      }
      const own = sameRepositoryPath(found.root, canonical);
      if (!found.control.isDirectory()) return { path: canonical, state: "worktree", root: found.root, canInitialize: false, reason: "This folder is a Git worktree or submodule." };
      return own
        ? { path: canonical, state: "repository", root: found.root, canInitialize: false, reason: null }
        : { path: canonical, state: "inside", root: found.root, canInitialize: false, reason: `This folder is inside the Git repository at ${found.root}.` };
    } catch (error) {
      return { path: canonical, state: "unavailable", root: null, canInitialize: false, reason: message(error) };
    }
  }

  async initialize(path: string): Promise<GitStatus> {
    const before = await this.status(path);
    if (!before.canInitialize) throw new Error(before.reason ?? "This folder already uses Git.");
    const key = process.platform === "win32" ? before.path.toLowerCase() : before.path;
    if (this.active.has(key)) throw new Error("Git is already being initialized in this folder.");
    this.active.add(key);
    try {
      try { await this.io.run(["--version"], before.path); }
      catch { throw new Error("Git is not installed or cannot be started on this host. Install Git, then try again."); }
      await this.io.run(["init", "--quiet"], before.path);
    } finally { this.active.delete(key); this.invalidate(); }
    const after = await this.status(before.path);
    if (after.state !== "repository") throw new Error(`git init finished, but ${join(before.path, ".git")} was not found. Refresh and check the folder.`);
    return after;
  }
}
