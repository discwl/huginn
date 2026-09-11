// Explicit, read-only adapter check. Never installed as a plugin entry.
import { GortexClient } from "./gortex-client.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { symbolSnapshotSchema } from "../shared/symbol-inspection.ts";

const native = new GortexClient();
const library = new WorkspaceLibrary(native);
try {
  const catalog = await library.catalog();
  console.log(JSON.stringify({ version: catalog.version, repositories: catalog.repositories.map(repo => ({ name: repo.name, state: repo.state, workspace: repo.workspaceId, error: repo.error })), total: catalog.total }));
  const repository = catalog.repositories.find(repo => repo.state === "resolved");
  if (catalog.total > 0 && !repository) throw new Error("No native repository context resolved.");
  if (repository?.workspaceId) {
    const context = { repositoryPath: repository.path, workspaceId: repository.workspaceId };
    const result = await library.search({ ...context, query: process.argv[2] ?? "Gortex", cursor: null, limit: 5 });
    console.log(JSON.stringify({ searchResults: result.results.length, truncated: result.truncated, expanded: result.expanded }));
    if (result.results[0]) {
      for (const operation of ["source", "callers", "dependencies", "usages", "implementations", "impact"] as const) {
        const snapshot = await library.symbol({ ...context, symbolId: result.results[0].id, operation });
        symbolSnapshotSchema.parse(snapshot);
        console.log(JSON.stringify({ operation, snapshotCharacters: snapshot.text.length, truncated: snapshot.truncated, sourceLines: snapshot.inspection.source?.code.split("\n").length, displayedSymbols: snapshot.inspection.rows.length, navigableSymbols: snapshot.inspection.rows.filter(row => row.symbol.navigable).length }));
        const related = operation === "callers" ? snapshot.inspection.rows.find(row => row.symbol.navigable) : undefined;
        if (related) {
          const next = await library.symbol({ ...context, symbolId: related.symbol.id, operation: "source" });
          symbolSnapshotSchema.parse(next);
          console.log(JSON.stringify({ relatedSourceNavigation: next.symbolId === related.symbol.id, sourceReceived: !!next.inspection.source }));
        }
      }
      const status = await library.status(context);
      console.log(JSON.stringify({ indexReportReceived: status.value !== null, observedAt: status.observedAt }));
    }
  }
} finally { library.close(); await native.close(); }
