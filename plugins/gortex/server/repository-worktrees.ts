import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { z } from "zod";
import type { GortexClient } from "./gortex-client.ts";
import { runProcess } from "./process-runner.ts";
import type { Worktree, WorktreePage } from "../shared/worktree-contracts.ts";

const text = z.string().max(8000);
const clock = z.object({ running: z.boolean(), deadline: z.number().optional() });
const checkout = z.object({
  checkout_id: text, root_path: text, state: text, effective_mode: text, coordinator_live: z.boolean(),
  head_ref: text.optional(), head_commit: text.optional(), graph_id: text.optional(),
  locked: z.boolean().optional(), prunable: z.boolean().optional(), last_seen: z.number().optional(), last_error: text.optional(),
  transition: text.optional(), intents: z.array(text).optional(), availability: clock.optional(), removal: clock.optional(),
  route: z.object({ graph_id: text, state: text, ready: z.boolean() }).nullable().optional(),
});
const familySchema = z.object({
  family_id: text, common_dir: text, primary_graph_id: text.optional(),
  graphs: z.array(z.object({ graph_id: text, repo_prefix: text, state: text, served: z.boolean(), is_primary: z.boolean() })).nullish(),
  checkouts: z.array(checkout).nullish(),
});
const catalogSchema = z.object({ families: z.array(familySchema).nullable() });
type Family = z.infer<typeof familySchema>;
export type GitWorktree = { path: string; branch: string | null; commit: string | null; locked: boolean; prunable: boolean };
const key = (path: string) => process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
const message = (error: unknown) => error instanceof Error ? error.message : "Worktree information is unavailable.";

// Porcelain without -z supports the older Git versions shipped on some hosts.
// Git quotes control characters and UTF-8 bytes using C escapes, not JSON.
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Malformed Git worktree path.");
  const bytes: number[] = [], escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] !== "\\") { const char = String.fromCodePoint(body.codePointAt(i)!); bytes.push(...Buffer.from(char)); i += char.length; continue; }
    const octal = /^[0-7]{1,3}/.exec(body.slice(++i));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; }
    else { const byte = escapes[body[i++]]; if (byte === undefined) throw new Error("Unsupported Git path escape."); bytes.push(byte); }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}
export function parseGitWorktrees(output: string): GitWorktree[] {
  const records = output.replace(/\r\n/g, "\n").trimEnd().split("\n\n").filter(Boolean);
  if (records.length > 1000) throw new Error("More than 1,000 worktrees; narrow this repository before browsing.");
  const rows = records.map(record => {
    const lines = record.split("\n"), first = lines.shift()!;
    if (!first.startsWith("worktree ")) throw new Error("Unsupported Git worktree listing.");
    const path = unquote(first.slice(9));
    if (!isAbsolute(path)) throw new Error("Git returned a non-absolute worktree path.");
    const fields = new Map(lines.map(line => { const pos = line.indexOf(" "); return pos < 0 ? [line, ""] : [line.slice(0, pos), line.slice(pos + 1)]; }));
    if (fields.has("bare")) throw new Error("Bare repositories are not supported by this worktree browser.");
    const commit = fields.get("HEAD") ?? null;
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git returned an invalid worktree commit.");
    return { path, branch: fields.get("branch") ?? null, commit, locked: fields.has("locked"), prunable: fields.has("prunable") };
  });
  if (new Set(rows.map(row => key(row.path))).size !== rows.length) throw new Error("Git returned duplicate worktree paths.");
  return rows;
}
export function decodeWorktreeFamily(value: unknown, commonDir: string): Family | null {
  const envelope = value as Record<string, unknown> | null;
  if (envelope?.truncated || envelope?.partial || envelope?.error) throw new Error("Gortex returned an incomplete checkout catalog. Refresh before relying on its status.");
  const result = catalogSchema.safeParse(value);
  if (!result.success) throw new Error("Unsupported Gortex checkout response. Update the plugin's native adapter.");
  const families = result.data.families ?? [];
  if (families.length === 0) return null;
  if (families.length !== 1 || key(families[0].common_dir) !== key(commonDir)) throw new Error("Gortex returned a different repository family. No checkout status was substituted.");
  const rows = families[0].checkouts ?? [];
  if (new Set(rows.map(row => row.checkout_id)).size !== rows.length || new Set(rows.map(row => key(row.root_path))).size !== rows.length || rows.some(row => !isAbsolute(row.root_path))) throw new Error("Gortex returned ambiguous checkout identities.");
  return families[0];
}
export function mergeWorktrees(git: GitWorktree[], family: Family | null, nativeAvailable: boolean): Worktree[] {
  const paths = new Map(git.map(row => [key(row.path), row.path]));
  for (const row of family?.checkouts ?? []) paths.set(key(row.root_path), row.root_path);
  return [...paths.values()].map(path => {
    const disk = git.find(row => key(row.path) === key(path));
    const native = family?.checkouts?.find(row => key(row.root_path) === key(path));
    const graph = family?.graphs?.find(row => row.graph_id === native?.graph_id);
    let status: Worktree["status"] = nativeAvailable ? "unregistered" : "unknown";
    if (native) {
      // A live coordinator is a persistent worker, not evidence of active indexing.
      status = "unknown";
      if (["unavailable", "missing", "grace", "removed", "dormant", "failed"].includes(native.state)) status = "unavailable";
      else if (native.state === "building" || native.route?.state === "building" || graph?.state === "building") status = "building";
      else if (native.state === "ready" && (native.effective_mode === "automatic" ? native.route?.ready === true : graph?.served === true && graph.state === "ready")) status = "ready";
    }
    const headMismatch = !!(disk?.commit && native?.head_commit && disk.commit !== native.head_commit);
    if (headMismatch && status === "ready") status = "unknown";
    return {
      headMismatch, nativeCommit: native?.head_commit ?? null, repositoryIndex: null, indexedAt: null,
      path, branch: disk?.branch ?? native?.head_ref ?? null, commit: disk?.commit ?? native?.head_commit ?? null,
      gitPresent: !!disk, locked: disk?.locked ?? native?.locked ?? false, prunable: disk?.prunable ?? native?.prunable ?? false,
      checkoutId: native?.checkout_id ?? null, primary: !!graph?.is_primary, status,
      state: native?.state ?? null, mode: native?.effective_mode ?? null, coordinatorLive: native?.coordinator_live ?? null,
      routeState: native?.route?.state ?? null, graph: graph?.repo_prefix ?? native?.route?.graph_id ?? native?.graph_id ?? null,
      lastSeen: native?.last_seen ?? null, lastError: native?.last_error ?? null, transition: native?.transition ?? null,
      intents: native?.intents ?? [], availabilityDeadline: native?.availability?.running ? native.availability.deadline ?? null : null,
      removalDeadline: native?.removal?.running ? native.removal.deadline ?? null : null,
    };
  });
}

// This is the ordinary repository catalog, independent of the checkout-view registry.
// Match exact roots only: a primary index never proves a sibling worktree is indexed.
export function applyRepositoryIndexes(rows: Worktree[], value: unknown): Worktree[] {
  const parsed = z.array(z.object({ path: text, indexed: z.boolean(), stale: z.boolean(), indexed_commit: text.optional(), last_indexed: text.optional() })).safeParse(value);
  if (!parsed.success) throw new Error("Unsupported Gortex repository index catalog.");
  const indexes = parsed.data;
  if (indexes.some(row => !isAbsolute(row.path)) || new Set(indexes.map(row => key(row.path))).size !== indexes.length) throw new Error("Ambiguous repository index paths.");
  return rows.map(row => {
    const index = indexes.find(item => key(item.path) === key(row.path));
    if (!index) return row;
    const commitMismatch = !!(index.indexed_commit && row.commit && index.indexed_commit !== row.commit);
    return { ...row, repositoryIndex: !index.indexed ? "not-indexed" : index.stale || commitMismatch ? "stale" : "indexed", indexedAt: index.last_indexed ?? null };
  });
}

export class RepositoryWorktrees {
  private pending = new Map<string, Promise<Omit<WorktreePage, "offset" | "nextOffset">>>();
  private closed = false;
  private native: Pick<GortexClient, "assignments" | "checkoutFamily" | "repositoryIndexes">;
  constructor(native: Pick<GortexClient, "assignments" | "checkoutFamily" | "repositoryIndexes">) { this.native = native; }
  private async snapshot(path: string): Promise<Omit<WorktreePage, "offset" | "nextOffset">> {
    const assignments = await this.native.assignments();
    const matches = await Promise.all(assignments.map(async row => { try { return key(await realpath(row.path)) === key(path); } catch { return false; } }));
    if (!matches.some(Boolean)) throw new Error("The selected repository is no longer tracked. Refresh the repository library.");
    let git: GitWorktree[] = [], gitError: string | null = null, nativeError: string | null = null, family: Family | null = null;
    let commonDir: string | null = null;
    try {
      const common = (await runProcess("git", ["rev-parse", "--git-common-dir"], path, { maxBytes: 16000 })).trim();
      commonDir = await realpath(resolve(path, common));
      git = parseGitWorktrees(await runProcess("git", ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"], path, { maxBytes: 256000 }));
    } catch (error) { gitError = message(error); }
    try {
      if (!commonDir) throw new Error("Cannot verify the Git family identity for this repository.");
      const result = await this.native.checkoutFamily(path);
      const meta = result.meta as Record<string, unknown> | null;
      if (meta?.truncated || meta?.partial || (meta?.freshness as { exact?: boolean } | undefined)?.exact === false) throw new Error("Gortex returned partial or substituted checkout evidence.");
      family = decodeWorktreeFamily(result.value, commonDir);
    } catch (error) { nativeError = message(error); }
    let rows = mergeWorktrees(git, family, nativeError === null), indexError: string | null = null;
    try { rows = applyRepositoryIndexes(rows, await this.native.repositoryIndexes()); }
    catch (error) { indexError = message(error); }
    return { repositoryPath: path, observedAt: new Date().toISOString(), rows, total: rows.length, familyId: family?.family_id ?? null, primaryGraph: family?.primary_graph_id ?? null, nativeError, gitError, indexError };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
  }
  async list(path: string, offset = 0): Promise<WorktreePage> {
    if (!isAbsolute(path)) throw new Error("An absolute repository path is required.");
    const canonical = await realpath(path), id = key(canonical);
    if (this.closed) throw new Error("The worktree browser is closed.");
    let pending = this.pending.get(id);
    if (!pending) {
      pending = this.snapshot(canonical).finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id); });
      this.pending.set(id, pending);
    }
    const result = await pending, start = Math.min(offset, Math.max(0, Math.floor((result.total - 1) / 50) * 50));
    return { ...result, rows: result.rows.slice(start, start + 50), offset: start, nextOffset: start + 50 < result.total ? start + 50 : null };
  }
}
