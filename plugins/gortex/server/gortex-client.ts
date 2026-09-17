import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir } from "node:os";
import { requireNativeCompatibility, requireTrackCliSupport } from "../shared/native-compatibility.ts";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { nativeAssignmentSchema, nativeInfoSchema, type NativeAssignment, type NativeInfo } from "../shared/models.ts";
import { decodeNativeResult, NativeError } from "./native-response.ts";
import { runProcess } from "./process-runner.ts";
import { resolveHostExecutable } from "./host-executable.ts";

interface Connection { client: Client; ready: Promise<void>; active: number; touched: number }
export interface NativePort {
  assignments(): Promise<NativeAssignment[]>;
  info(cwd: string): Promise<NativeInfo>;
  version(): Promise<string>;
  query(cwd: string, operation: "index" | "search" | "source" | "callers" | "dependencies" | "usages" | "implementations" | "impact", args?: Record<string, unknown>): Promise<{ value: unknown; meta: unknown }>;
  close(): Promise<void>;
}

import { sampleDaemonHealth } from "./health-snapshot.ts";
import type { DaemonHealth } from "../shared/health-models.ts";

export class GortexClient implements NativePort {
  private binary: string;
  private connections = new Map<string, Connection>();
  private closed = false;
  private updating = false;
  private admission: Promise<void> = Promise.resolve();
  constructor(binary = "gortex") { this.binary = binary; }

  async assignments(): Promise<NativeAssignment[]> {
    const raw = await runProcess(this.binary, ["workspace", "list", "--json"], homedir());
    try { return z.array(nativeAssignmentSchema).parse(JSON.parse(raw)); }
    catch { throw new NativeError("catalog_shape", "Unsupported native workspace catalog response; update the adapter fixtures before continuing."); }
  }

  async version(): Promise<string> {
    const output = await runProcess(this.binary, ["version"], homedir(), { maxBytes: 4096 });
    const match = /^gortex\s+(\S+)[ \t]*$/m.exec(output);
    if (!match) throw new NativeError("unsupported_version", "Gortex did not report a recognizable version.");
    requireNativeCompatibility(match[1], false);
    return `gortex ${match[1]}`;
  }

  private async acquire(key: string): Promise<Connection> {
    let unlock!: () => void;
    const prior = this.admission;
    this.admission = new Promise(resolve => { unlock = resolve; });
    await prior;
    try {
      if (this.closed) throw new NativeError("closed", "Gortex plugin connection is closed.");
      if (this.updating) throw new NativeError("updating", "Gortex is updating on this host. Refresh after the update completes.");
      let connection = this.connections.get(key);
      if (!connection) {
        if (this.connections.size >= 4) {
          const idle = [...this.connections].filter(([, value]) => value.active === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) throw new NativeError("busy", "Gortex connection budget is busy. Retry after the current query completes.");
          this.connections.delete(idle[0]);
          await idle[1].client.close();
        }
        const executable = await resolveHostExecutable(this.binary);
        if (this.closed) throw new NativeError("closed", "Gortex plugin connection is closed.");
      if (this.updating) throw new NativeError("updating", "Gortex is updating on this host. Refresh after the update completes.");
        const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        // Other documented presets select legacy names. Compact supplies the effect-split facade.
        env.GORTEX_TOOLS = "compact";
        const transport = new StdioClientTransport({ command: executable, args: ["mcp", "--proxy", "--tools", "compact"], cwd: key, env, stderr: "ignore" });
        const client = new Client({ name: "paseo-gortex", version: "0.1.0" });
        connection = { client, ready: Promise.resolve(), active: 0, touched: Date.now() };
        this.connections.set(key, connection);
        connection.ready = client.connect(transport, { timeout: 15000 }).then(async () => {
          const result = await client.listTools({}, { timeout: 15000 });
          const names = new Set(result.tools.map(tool => tool.name));
          for (const required of ["workspace", "search", "read", "relations", "change"]) {
            if (!names.has(required)) throw new NativeError("missing_tool", `Gortex MCP integration is missing ${required}. Check the public tool preset.`);
          }
        });
      }
      connection.active++;
      connection.touched = Date.now();
      return connection;
    } finally { unlock(); }
  }

  private async call(cwd: string, name: string, args: Record<string, unknown>, timeout = 20000): Promise<{ value: unknown; meta: unknown }> {
    const key = await realpath(cwd);
    const connection = await this.acquire(key);
    let result: unknown;
    try {
      await connection.ready;
      if (name === "workspace_admin") {
        const advertised = await connection.client.listTools({}, { timeout: 15000 });
        const tool = advertised.tools.find(tool => tool.name === name);
        const operation = tool?.inputSchema.properties?.operation as { enum?: unknown[] } | undefined;
        if (!tool || (Array.isArray(operation?.enum) && !operation.enum.includes(args.operation))) {
          throw new NativeError("unsupported_operation", `This Gortex host does not advertise workspace_admin.${String(args.operation)}. Update the plugin or enable the native operation before retrying. No request was sent.`);
        }
      }
      result = await connection.client.callTool({ name, arguments: args }, undefined, { timeout });
    } catch (error) {
      if (this.connections.get(key) === connection) this.connections.delete(key);
      await connection.client.close().catch(() => {});
      if (error instanceof NativeError) throw error;
      throw new NativeError("mcp_unavailable", "Gortex MCP request failed. Verify the existing daemon is reachable, then refresh. The plugin does not start or restart it.");
    } finally { connection.active--; }
    // Semantic/native response errors do not tear down a healthy shared connection.
    const envelope = result as { isError?: boolean; content?: { type: string; text?: string }[] };
    if (name === "workspace" && args.operation === "checkouts" && envelope.isError && envelope.content?.some(block => block.type === "text" && /^indexer: no tracked repository matches: corpus .+ has no dedicated graph$/.test(block.text ?? ""))) {
      throw new NativeError("checkout_catalog_missing", "Gortex has no checkout-family graph record for this repository.");
    }
    return decodeNativeResult(result);
  }

  async info(cwd: string): Promise<NativeInfo> {
    const result = await this.call(cwd, "workspace", { operation: "info", arguments: { format: "json" } });
    const parsed = nativeInfoSchema.safeParse(result.value);
    if (!parsed.success) throw new NativeError("identity_shape", "Unsupported native context identity response.");
    return parsed.data;
  }

  private healthRequests = new Map<string, Promise<DaemonHealth>>();

  async daemonHealth(cwd: string): Promise<DaemonHealth> {
    const key = await realpath(cwd);
    const pending = this.healthRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
      const connection = await this.acquire(key);
      try {
        await connection.ready;
        return await sampleDaemonHealth(connection.client);
      } finally {
        connection.active--;
        if (!connection.client.transport && this.connections.get(key) === connection) this.connections.delete(key);
      }
    })().finally(() => { if (this.healthRequests.get(key) === request) this.healthRequests.delete(key); });
    this.healthRequests.set(key, request);
    return request;
  }

  query(cwd: string, operation: Parameters<NativePort["query"]>[1], args: Record<string, unknown> = {}): Promise<{ value: unknown; meta: unknown }> {
    if (operation === "index") return this.call(cwd, "workspace", { operation: "index", arguments: { format: "json", max_bytes: 12000 } });
    if (operation === "search") return this.call(cwd, "search", { operation: "symbols", query: args.query, options: { workspace: args.workspace, repo: args.repo, limit: args.limit, paginate: true, cursor: args.cursor ?? undefined, expand: "off" }, output: { format: "json" } });
    if (operation === "source") return this.call(cwd, "read", { operation: "source", target: { symbol: args.symbolId }, output: { format: "json", max_bytes: 12000 } });
    if (operation === "impact") return this.call(cwd, "change", { operation: "impact", target: { symbol: args.symbolId }, output: { format: "json", limit: 50, max_bytes: 12000 } });
    return this.call(cwd, "relations", { operation, target: { symbol: args.symbolId }, output: { format: "json", limit: 50, max_bytes: 12000 } });
  }

  async repositoryIndexes(): Promise<unknown> {
    const raw = await runProcess(this.binary, ["repos", "--json"], homedir(), { maxBytes: 256000 });
    try { return JSON.parse(raw); }
    catch { throw new NativeError("repository_index_shape", "Gortex returned an invalid repository index catalog."); }
  }

  checkoutFamily(cwd: string): Promise<{ value: unknown; meta: unknown }> {
    return this.call(cwd, "workspace", { operation: "checkouts", arguments: { family: cwd, format: "json", max_bytes: 256000 } });
  }

  checkouts(cwd: string): Promise<{ value: unknown; meta: unknown }> {
    return this.call(cwd, "workspace", { operation: "checkouts", arguments: { format: "json", max_bytes: 256000 } });
  }

  async track(path: string): Promise<void> {
    // Explicit CLI adapter for a new root: a repository-bound MCP session cannot admit it yet.
    // The caller reconciles the native catalog; stdout is not treated as an index receipt.
    const help = await runProcess(this.binary, ["track", "--help"], path, { timeoutMs: 10000, maxBytes: 16384 });
    requireTrackCliSupport(help);
    await runProcess(this.binary, ["track", path, "--no-progress"], path, { timeoutMs: 60000, maxBytes: 65536 });
  }

  untrack(path: string, confirm: boolean): Promise<{ value: unknown; meta: unknown }> {
    // MCP-only administration: no CLI config-only fallback if the daemon disconnects.
    return this.call(path, "workspace_admin", { operation: "untrack", arguments: { path, confirm } }, 120000);
  }

  async reloadConfiguration(): Promise<void> {
    await runProcess(this.binary, ["daemon", "reload"], homedir(), { timeoutMs: 60000, maxBytes: 16384 });
  }

  async rebuildIndex(cwd: string): Promise<void> {
    const path = await realpath(cwd);
    const result = await this.call(path, "workspace_admin", { operation: "index", arguments: { path } }, 120000);
    const receipt = z.object({ node_count: z.number().int().nonnegative(), edge_count: z.number().int().nonnegative(), file_count: z.number().int().nonnegative() }).safeParse(result.value);
    if (!receipt.success) throw new NativeError("index_shape", "Gortex did not return a supported index receipt. Reconcile the daemon before retrying.");
  }

  async withMaintenance<T>(effect: () => Promise<T>): Promise<T> {
    if (this.closed) throw new NativeError("closed", "Gortex plugin connection is closed.");
    if (this.updating) throw new NativeError("updating", "Gortex is already updating on this host.");
    this.updating = true;
    try {
      await this.refreshContexts();
      return await effect();
    } finally { this.updating = false; }
  }

  async refreshContexts(): Promise<void> {
    let unlock!: () => void;
    const prior = this.admission;
    this.admission = new Promise(resolve => { unlock = resolve; });
    await prior;
    try {
      const previous = [...this.connections.values()];
      this.connections.clear();
      this.healthRequests.clear();
      await Promise.allSettled(previous.map(connection => connection.client.close()));
    } finally { unlock(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.admission;
    const clients = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(clients.map(connection => connection.client.close()));
  }
}
