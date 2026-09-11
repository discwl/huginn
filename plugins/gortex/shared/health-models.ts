import { z } from "zod";
const count = z.number().int().nonnegative();

// Public notifications/daemon_health payload, verified on Gortex 0.64.2/0.64.3.
// Strip other fields so new native diagnostics cannot silently enter the client.
export const daemonHealthSchema = z.object({
  ts: z.string().datetime({ offset: true }), ready: z.boolean(), enriched: z.boolean(),
  uptime_seconds: count, tracked_repos: count, sessions: count,
  graph_nodes: count, graph_edges: count, alloc_bytes: count, sys_bytes: count,
  lsp_alive: count, lsp_specs_registered: count,
  num_goroutine: count, num_gc: count, db_bytes: count, wal_bytes: count,
});
export type DaemonHealth = z.infer<typeof daemonHealthSchema>;
export const hostHealthSchema = z.object({
  observedAt: z.string(), scope: z.literal("host"),
  state: z.enum(["available", "unavailable"]),
  health: daemonHealthSchema.nullable(), error: z.string().nullable(),
});
export const indexSummarySchema = z.object({
  status: z.string(), health_score: z.number().min(0).max(100),
  index_complete: z.boolean(), indexed_file_count: count,
  node_count: count, edge_count: count, failed_file_count: count,
  unreadable_file_count: count, last_index_time: z.string(),
});
