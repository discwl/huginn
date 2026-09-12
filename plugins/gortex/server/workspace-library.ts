import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { symbolSchema, type Catalog, type Inspection, type NativeAssignment, type Repository, type RepositoryContext, type SearchPage } from "../shared/models.ts";
import type { NativePort } from "./gortex-client.ts";
import { NativeError } from "./native-response.ts";
import { runProcess } from "./process-runner.ts";
import { QueryCache } from "./query-cache.ts";
import { ProjectCatalog, repositoryPathKey } from "./project-catalog.ts";
import { fitInspection, normalizeInspection } from "./symbol-inspection.ts";
import type { InspectorOperation, SymbolSnapshot } from "../shared/symbol-inspection.ts";
import { catalogInputSchema, pageAssignments, type CatalogInput } from "../shared/catalog-browser.ts";

const administrationReason = "New standalone Git repositories can be indexed after confirmation on supported Gortex hosts. Existing repository metadata is managed in Repository settings.";
const searchResultSchema = z.object({ results: z.array(symbolSchema).max(50), total: z.number().optional(), next_cursor: z.string().optional().nullable(), truncated: z.boolean().optional(), fetch_escalated: z.boolean().optional() }).passthrough();
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Host operation failed."; }

export class WorkspaceLibrary {
  private native: NativePort;
  private cache = new QueryCache();
  private projects = new ProjectCatalog();
  // Tokens originate in native search or verified relationship results. A client cannot turn symbol RPC into an arbitrary file reader.
  private selectedSymbols = new Map<string, number>();
  constructor(native: NativePort) { this.native = native; }

  private async resolve(row: NativeAssignment): Promise<Repository> {
    const base = { name: row.repo, path: row.path, declaredWorkspace: row.workspace, declaredProject: row.project, assignmentSource: row.source };
    try {
      const path = await realpath(row.path);
      const info = await this.native.info(path);
      const matches = [];
      for (const member of info.members) {
        try { if (samePath(await realpath(member.path), path)) matches.push(member); } catch { /* An inaccessible member cannot authorize this context. */ }
      }
      if (matches.length !== 1 || !matches[0].name) throw new NativeError("wrong_context", "Gortex resolved a different or ambiguous repository context. No substitute view was used.");
      // Configuration names can change while Gortex keeps an existing graph prefix.
      // Route by the native member identity, and display both identities to the user.
      return { ...base, path, workspaceId: info.workspace, projectId: info.project, graphName: matches[0].name, state: "resolved", error: null };
    } catch (error) { return { ...base, workspaceId: null, projectId: null, graphName: null, state: "unavailable", error: message(error) }; }
  }

  async catalog(offset = 0, options: Partial<CatalogInput> = {}): Promise<Catalog> {
    const input = catalogInputSchema.parse({ ...options, offset });
    const [version, rows] = await Promise.all([this.native.version(), this.native.assignments()]);
    const merged = await this.projects.merge(rows, input.paseoProjects);
    const { rows: visibleRows, ...page } = pageAssignments(merged.rows, input);
    const repositories: Repository[] = [];
    for (const row of visibleRows) repositories.push(merged.candidates.get(repositoryPathKey(row.path)) ?? await this.resolve(row));
    return {
      version, repositories, ...page,
      observedAt: new Date().toISOString(),
      warnings: ["Membership is the observed native session context. Index state is queried separately on demand.", "Exact checkout selection is unavailable until the native checkout/view contract is verified."],
      administration: { available: /^gortex v0\.64\.3(?:\+|$)/.test(version), reason: administrationReason },
    };
  }

  private async context(input: RepositoryContext): Promise<Repository> {
    if (!isAbsolute(input.repositoryPath)) throw new NativeError("path", "An absolute host repository path is required.");
    const canonical = await realpath(input.repositoryPath);
    const rows = await this.native.assignments();
    let selected: NativeAssignment | undefined;
    for (const row of rows) {
      try { if (samePath(await realpath(row.path), canonical)) { selected = row; break; } } catch { /* An unavailable row cannot authorize this request. */ }
    }
    if (!selected) throw new NativeError("not_tracked", "Selected path is no longer in the native tracking catalog. Refresh the library.");
    const repository = await this.resolve(selected);
    if (repository.state !== "resolved" || repository.workspaceId !== input.workspaceId) throw new NativeError("scope_changed", "Selected native workspace/repository changed or is unavailable. Refresh before querying.");
    return repository;
  }

  async inspect(path: string): Promise<Inspection> {
    if (!isAbsolute(path)) throw new Error("Enter an absolute path on the selected host.");
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Selected path is not a directory.");
    const warnings: string[] = [];
    let repositoryRoot: string | null = null;
    let gitDirectoryKind: Inspection["gitDirectoryKind"] = "none";
    try {
      const result = await runProcess("git", ["-C", canonical, "rev-parse", "--show-toplevel"], canonical, { maxBytes: 65536 });
      const root = result.replace(/[\r\n]+$/, "");
      if (root.includes("\n") || root.includes("\r") || !isAbsolute(root)) throw new Error("Unsupported Git root path response.");
      repositoryRoot = await realpath(root);
      try { const git = await lstat(join(repositoryRoot, ".git")); gitDirectoryKind = git.isDirectory() ? "directory" : git.isFile() ? "file" : "unknown"; } catch { gitDirectoryKind = "unknown"; }
    } catch { warnings.push("Git root could not be established. This may be a plain folder, denied access, or unavailable Git; plain-folder tracking is not offered."); }
    let repository: Repository | null = null;
    let tracking: Inspection["tracking"] = "unknown";
    try {
      const rows = await this.native.assignments();
      for (const row of rows) {
        try {
          const rowPath = await realpath(row.path);
          if (samePath(rowPath, canonical) || (repositoryRoot !== null && samePath(rowPath, repositoryRoot))) { repository = await this.resolve(row); break; }
        } catch { /* Preserve unknown until all candidates have been checked. */ }
      }
      tracking = repository ? "dedicated" : "not-in-catalog";
    } catch (error) { warnings.push(message(error)); }
    if (gitDirectoryKind === "file") warnings.push("Git uses an indirection file here; this may be an automatic worktree or submodule. Dedicated tracking is not inferred.");
    if (tracking === "not-in-catalog") warnings.push("Not in the dedicated catalog does not rule out an automatic worktree view.");
    warnings.push(administrationReason);
    return { selectedPath: path, canonicalPath: canonical, repositoryRoot, gitDirectoryKind, tracking, repository, warnings, observedAt: new Date().toISOString() };
  }

  async status(input: RepositoryContext): Promise<{ value: unknown; meta: unknown; observedAt: string; scope: "host" }> {
    const repository = await this.context(input);
    // workspace.index reads the whole daemon store, even when the session selects one repo/workspace.
    // Keep that effect explicit across RPC; the selected repository only authorizes the connection.
    const report = await this.native.query(repository.path, "index");
    return { ...report, observedAt: new Date().toISOString(), scope: "host" };
  }

  async search(input: RepositoryContext & { query: string; cursor: string | null; limit: number }): Promise<SearchPage> {
    const repository = await this.context(input);
    const key = JSON.stringify([input.workspaceId, repository.graphName, repository.path, "search", input.query, input.cursor, input.limit]);
    return this.cache.get(key, 0, async () => {
      const report = await this.native.query(repository.path, "search", { workspace: input.workspaceId, repo: repository.graphName, query: input.query, cursor: input.cursor, limit: input.limit });
      const parsed = searchResultSchema.safeParse(report.value);
      if (!parsed.success) throw new NativeError("search_shape", "Unsupported native search response. No results were substituted.");
      const data = parsed.data;
      if (data.results.some(symbol => symbol.workspace_id !== input.workspaceId || symbol.repo_prefix !== repository.graphName)) throw new NativeError("wrong_scope", "Native search returned a different repository or workspace; the result was rejected.");
      for (const symbol of data.results) this.selectedSymbols.set(JSON.stringify([input.workspaceId, repository.path, symbol.id]), Date.now() + 10 * 60 * 1000);
      while (this.selectedSymbols.size > 500) this.selectedSymbols.delete(this.selectedSymbols.keys().next().value!);
      return { results: data.results, total: data.total, nextCursor: data.next_cursor ?? null, truncated: data.truncated ?? false, expanded: data.fetch_escalated ?? false, warnings: ["Current repository context; exact checkout selection is not established.", ...(data.fetch_escalated ? ["Gortex broadened this search; results may not literally match the query."] : [])], context: input, meta: report.meta, observedAt: new Date().toISOString() };
    });
  }

  async symbol(input: RepositoryContext & { symbolId: string; operation: InspectorOperation }): Promise<SymbolSnapshot> {
    const repository = await this.context(input);
    const token = JSON.stringify([input.workspaceId, repository.path, input.symbolId]);
    if ((this.selectedSymbols.get(token) ?? 0) < Date.now()) throw new NativeError("selection_expired", "Search for this symbol again before inspecting it; its native selection expired.");
    const report = await this.native.query(repository.path, input.operation, { symbolId: input.symbolId });
    const observedAt = new Date().toISOString();
    const inspection = normalizeInspection(input.operation, report.value, report.meta, { workspaceId: input.workspaceId, repository: repository.graphName!, symbolId: input.symbolId });
    const header = `Gortex ${input.operation}\nWorkspace: ${input.workspaceId}\nRepository: ${repository.graphName}\nPath: ${repository.path}\nSymbol: ${input.symbolId}\nObserved: ${observedAt}\nView: current repository session; exact checkout selection unavailable\n\n`;
    const text = fitInspection(inspection, header);
    // Grants come only from native evidence displayed in this response, with matching opaque scope IDs.
    for (const item of inspection.rows) if (item.symbol.navigable)
      this.selectedSymbols.set(JSON.stringify([input.workspaceId, repository.path, item.symbol.id]), Date.now() + 10 * 60 * 1000);
    this.selectedSymbols.delete(token); // Keep the actively inspected symbol through bounded-map eviction.
    this.selectedSymbols.set(token, Date.now() + 10 * 60 * 1000);
    while (this.selectedSymbols.size > 500) this.selectedSymbols.delete(this.selectedSymbols.keys().next().value!);
    const nativeJson = JSON.stringify({ result: report.value, nativeMetadata: report.meta }, null, 2);
    const rawTruncated = nativeJson.length > 15000;
    const raw = rawTruncated ? nativeJson.slice(0, 15000) + "\n[Raw response truncated at the display budget]" : nativeJson;
    return { text, truncated: inspection.partial, inspection, raw, rawTruncated, observedAt, context: { repositoryPath: input.repositoryPath, workspaceId: input.workspaceId }, symbolId: input.symbolId };
  }

  close(): void { this.cache.clear(); this.projects.clear(); this.selectedSymbols.clear(); }
}
