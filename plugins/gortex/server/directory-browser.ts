import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { directoryInputSchema, type DirectoryInput, type DirectoryPage } from "../shared/models.ts";

interface Snapshot { path: string; filter: string; entries: DirectoryPage["entries"]; partial: boolean; observedAt: string; expires: number }

export class DirectoryBrowser {
  private snapshots = new Map<string, Snapshot>();
  private scanLimit: number;
  constructor(options: { scanLimit?: number } = {}) { this.scanLimit = options.scanLimit ?? 5000; }

  async list(raw: DirectoryInput): Promise<DirectoryPage> {
    const input = directoryInputSchema.parse(raw);
    const requested = input.path ?? homedir();
    if (!isAbsolute(requested)) throw new Error("Enter an absolute path on the selected host.");
    const path = await realpath(requested);
    const filter = input.filter.toLocaleLowerCase();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires < Date.now()) this.snapshots.delete(id);
    let snapshot: Snapshot;
    let id: string;
    let offset = 0;
    if (input.cursor) {
      const match = /^([0-9a-f-]{36}):(\d+)$/.exec(input.cursor);
      const prior = match ? this.snapshots.get(match[1]) : undefined;
      if (!prior || prior.path !== path || prior.filter !== filter) throw new Error("Directory cursor expired or does not match this folder/filter. Refresh the folder.");
      id = match![1];
      offset = Number(match![2]);
      if (!Number.isSafeInteger(offset) || offset > prior.entries.length) throw new Error("Invalid directory cursor.");
      snapshot = prior;
    } else {
      if (!(await stat(path)).isDirectory()) throw new Error("Selected host path is not a directory.");
      const entries: DirectoryPage["entries"] = [];
      let visited = 0;
      let partial = false;
      // opendir keeps memory bounded even for very large folders. No source files are opened.
      for await (const entry of await opendir(path)) {
        if (visited++ >= this.scanLimit) { partial = true; break; }
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLocaleLowerCase().includes(filter)) continue;
        // Links are displayed without resolving/following them until explicitly opened.
        entries.push({ name: entry.name, path: join(path, entry.name), isLink: entry.isSymbolicLink() });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      snapshot = { path, filter, entries, partial, observedAt: new Date().toISOString(), expires: Date.now() + 30000 };
      id = randomUUID();
      while (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(id, snapshot);
    }
    const end = Math.min(offset + input.limit, snapshot.entries.length);
    return {
      path, parent: dirname(path) === path ? null : dirname(path),
      roots: [...new Set([parse(path).root, homedir()])],
      entries: snapshot.entries.slice(offset, end),
      nextCursor: end < snapshot.entries.length ? `${id}:${end}` : null,
      partial: snapshot.partial,
      warnings: snapshot.partial ? [`Only the first ${this.scanLimit} directory entries were scanned. Enter a more specific path to browse beyond this bound.`] : [],
      observedAt: snapshot.observedAt,
    };
  }
  close(): void { this.snapshots.clear(); }
}
