import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir } from "node:os";
import { requireNativeCompatibility, requireTrackCliSupport } from "../shared/native-compatibility.ts";
import { isBusyMessage, isLoadingMessage, isRestartMessage, isStallMessage, loadingMessage, pausedMessage, stalledMessage, warmupRetryDelaysMs, warmupWindowSeconds } from "../shared/native-retry.ts";
import { setTimeout as delay } from "node:timers/promises";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { nativeAssignmentSchema, nativeInfoSchema, type NativeAssignment, type NativeInfo } from "../shared/models.ts";
import { decodeNativeResult, NativeError } from "./native-response.ts";
import { runProcess } from "./process-runner.ts";
import { resolveHostExecutable } from "./host-executable.ts";
import { parseDaemonStatus, uptimeSeconds, type DaemonStatus } from "./daemon-status.ts";
import { StallGuard } from "./stall-guard.ts";

interface Connection { client: Client; ready: Promise<void>; active: number; touched: number }
/**
 * background: an automatic request (a refresh, a catalog page), not sent while Gortex is refusing that repository.
 * single: one try that never pauses anything, for readiness checks that expect "not ready yet" for a while.
 */
export interface RequestOptions { background?: boolean; single?: boolean }
export interface NativePort {
  assignments(): Promise<NativeAssignment[]>;
  /** Whether Gortex is starting, and the repositories it is still loading (reported from 0.64.9 on). */
  startup?(): Promise<{ starting: boolean; loading: string[] }>;
  info(cwd: string, options?: RequestOptions): Promise<NativeInfo>;
  version(): Promise<string>;
  query(cwd: string, operation: "index" | "search" | "source" | "callers" | "dependencies" | "usages" | "implementations" | "impact", args?: Record<string, unknown>, options?: RequestOptions): Promise<{ value: unknown; meta: unknown }>;
  close(): Promise<void>;
}
export interface GortexClientOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  /** Whether the daemon started recently enough that its refusals are still start-up discovery. */
  warmingUp?: () => Promise<boolean>;
  /** Tests: stands in for `gortex daemon status`. */
  daemonStatus?: () => Promise<DaemonStatus | null>;
  stalls?: StallGuard;
}

/** Still starting: warming up, within minutes of the start, or (Gortex 0.64.9 and later) still loading repositories. */
export function isStarting(status: DaemonStatus): boolean {
  const uptime = uptimeSeconds(status.uptime);
  return status.warming || (uptime !== null && uptime < warmupWindowSeconds) || status.repos.some(repo => repo.state === "loading");
}

import { sampleDaemonHealth } from "./health-snapshot.ts";
import type { DaemonHealth } from "../shared/health-models.ts";

// Gortex keeps its finished Git check for 5 seconds, so a quick refusal caused by a slow Git start answers on an
// immediate retry. A slower refusal means Gortex was working on something else, and a retry won't help.
const QUICK_REFUSAL_MS = 2000, QUICK_RETRY_MS = 400;

const isMcpTimeout = (error: unknown) => (error as { code?: unknown } | null)?.code === -32001 || /\brequest timed out\b/i.test(error instanceof Error ? error.message : "");
// Gortex 0.64.9's proxy answers the first request after a daemon restart with -32097: it wasn't run and can be retried.
const isSessionReset = (error: unknown) => (error as { code?: unknown } | null)?.code === -32097 || isRestartMessage(error instanceof Error ? error.message : "");
const sessionResetMessage = "Gortex's daemon restarted, so this request wasn't run.";

/**
 * Gortex's own refusal, sent as a JSON-RPC error rather than a tool result (repository loading, dispatcher busy, a
 * checkout stall, an unavailable repository). The daemon answered, so the connection is healthy and the text is the
 * diagnosis: it is kept instead of being reported as an unreachable daemon. Null for transport failures.
 */
export function gortexRefusal(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "number" || !(error instanceof Error)) return null;
  const text = error.message.replace(/^MCP error -?\d+:\s*/i, "").trim();
  if (!text || /\bconnection closed\b/i.test(text)) return null;
  return isLoadingMessage(text) || isBusyMessage(error.message) || isStallMessage(text) || /\brepository unavailable\b/i.test(text) ? text : null;
}

/** Which kind of refusal an error is, or null for an ordinary failure. */
function refusal(error: unknown): "busy" | "reset" | "loading" | "stall" | "timeout" | null {
  const text = error instanceof Error ? error.message : "";
  const code = (error as { code?: unknown } | null)?.code;
  if (isBusyMessage(text)) return "busy";
  if (isLoadingMessage(text)) return "loading";
  if (code === "session_reset" || isRestartMessage(text)) return "reset";
  if (code === "timeout" || code === "health_timeout") return "timeout";
  return isStallMessage(text) ? "stall" : null;
}

export class GortexClient implements NativePort {
  private binary: string;
  private connections = new Map<string, Connection>();
  private closed = false;
  private updating = false;
  private admission: Promise<void> = Promise.resolve();
  private options: GortexClientOptions;
  private now: () => number;
  private wait: (ms: number) => Promise<unknown>;
  private stalls: StallGuard;
  private statusCheck: { at: number; value: Promise<DaemonStatus | null> } | null = null;
  constructor(binary = "gortex", options: GortexClientOptions = {}) {
    this.binary = binary; this.options = options;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (ms => delay(ms));
    this.stalls = options.stalls ?? new StallGuard({ now: this.now });
  }

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

  /** When this repository's automatic requests may resume (ms since the epoch), or null when they aren't paused. */
  async pausedUntil(cwd: string): Promise<number | null> {
    return this.stalls.pausedUntil(await realpath(cwd).catch(() => cwd));
  }

  /** Try now: automatic requests are sent again right away. */
  resumeRequests(): void { this.stalls.resume(); }

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

  /** `gortex daemon status`, read at most every 10 seconds; null when it can't be read. */
  private daemonStatus(): Promise<DaemonStatus | null> {
    const now = this.now();
    if (this.statusCheck && now - this.statusCheck.at < 10_000) return this.statusCheck.value;
    const value = runProcess(this.binary, ["daemon", "status"], homedir(), { timeoutMs: 10_000, maxBytes: 256 * 1024 }).then(parseDaemonStatus, () => null);
    this.statusCheck = { at: now, value };
    return value;
  }

  /** Whether the daemon is still starting: warming up, within minutes of its start, or loading repositories (0.64.9). */
  private async warmingUp(): Promise<boolean> {
    if (this.options.warmingUp) return this.options.warmingUp().catch(() => false);
    const status = await this.daemonStatus();
    return status !== null && isStarting(status);
  }

  /** Whether Gortex is starting, and the repositories it reports as still loading (Gortex 0.64.9 and later). */
  async startup(): Promise<{ starting: boolean; loading: string[] }> {
    const status = this.options.daemonStatus ? await this.options.daemonStatus().catch(() => null) : await this.daemonStatus();
    return { starting: status !== null && isStarting(status), loading: (status?.repos ?? []).filter(repo => repo.state === "loading").map(repo => repo.path) };
  }

  /**
   * Sends one request and retries only Gortex's refusals. Out of request slots, or within minutes of a daemon start,
   * refusals are retried on the warm-up schedule. Otherwise a quick refusal gets one immediate retry, and then the
   * repository's automatic requests pause (see StallGuard) instead of adding to a stuck host's work.
   */
  private async serve<T>(key: string, send: () => Promise<T>, options: RequestOptions, timeoutMs: number): Promise<T> {
    if (options.background && !options.single) {
      const until = this.stalls.pausedUntil(key);
      if (until !== null) throw new NativeError("paused", pausedMessage(until - this.now()));
    }
    let quickRetried = false;
    for (let attempt = 0; ; attempt++) {
      const started = this.now();
      try {
        const value = await send();
        this.stalls.answered(key);
        return value;
      } catch (error) {
        const kind = refusal(error);
        if (!kind || this.closed) throw error;
        const scheduled = attempt < warmupRetryDelaysMs.length;
        // A restart left the request unrun: send it again, even a single-try request, once.
        if (kind === "reset") {
          if (attempt >= (options.single ? 1 : warmupRetryDelaysMs.length)) throw error;
          await this.wait(warmupRetryDelaysMs[attempt]);
          continue;
        }
        if (kind === "busy") {
          if (!scheduled) throw error;
          await this.wait(warmupRetryDelaysMs[attempt]);
          continue;
        }
        // Loading after a restart is progress, not a stall: wait it out on the startup schedule, and never pause for it.
        if (kind === "loading") {
          if (options.single || !scheduled) throw new NativeError("repo_loading", loadingMessage(error instanceof Error ? error.message : ""));
          await this.wait(warmupRetryDelaysMs[attempt]);
          continue;
        }
        if (options.single) throw error;
        if (kind === "stall" && await this.warmingUp()) {
          if (!scheduled) throw error;
          await this.wait(warmupRetryDelaysMs[attempt]);
          continue;
        }
        if (kind === "stall" && !quickRetried && this.now() - started < QUICK_REFUSAL_MS) {
          quickRetried = true;
          await this.wait(QUICK_RETRY_MS);
          continue;
        }
        const pauseMs = this.stalls.refused(key);
        throw new NativeError(kind === "timeout" ? "timeout" : "stalled", stalledMessage(pauseMs, kind === "timeout" ? timeoutMs : null));
      }
    }
  }

  private async call(cwd: string, name: string, args: Record<string, unknown>, timeout = 20000, options: RequestOptions = {}): Promise<{ value: unknown; meta: unknown }> {
    const key = await realpath(cwd);
    return this.serve(key, () => this.attempt(key, name, args, timeout), options, timeout);
  }

  private async attempt(cwd: string, name: string, args: Record<string, unknown>, timeout: number): Promise<{ value: unknown; meta: unknown }> {
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
      const refused = error instanceof NativeError || isSessionReset(error) || isMcpTimeout(error) ? null : gortexRefusal(error);
      if (refused !== null) throw new NativeError(isLoadingMessage(refused) ? "repo_loading" : "refused", refused);
      if (this.connections.get(key) === connection) this.connections.delete(key);
      await connection.client.close().catch(() => {});
      if (error instanceof NativeError) throw error;
      if (isSessionReset(error)) throw new NativeError("session_reset", sessionResetMessage);
      if (isMcpTimeout(error)) throw new NativeError("timeout", `Gortex didn't answer within ${Math.round(timeout / 1000)} seconds.`);
      throw new NativeError("mcp_unavailable", "Gortex MCP request failed. Verify the existing daemon is reachable, then refresh. The plugin does not start or restart it.");
    } finally { connection.active--; }
    // Semantic/native response errors do not tear down a healthy shared connection.
    const envelope = result as { isError?: boolean; content?: { type: string; text?: string }[] };
    if (name === "workspace" && args.operation === "checkouts" && envelope.isError && envelope.content?.some(block => block.type === "text" && /^indexer: no tracked repository matches: corpus .+ has no dedicated graph$/.test(block.text ?? ""))) {
      throw new NativeError("checkout_catalog_missing", "Gortex has no checkout-family graph record for this repository.");
    }
    return decodeNativeResult(result);
  }

  /** One attempt, no warm-up retries: for health checks that need the present state, not an eventual answer. */
  async infoOnce(cwd: string): Promise<NativeInfo> {
    const key = await realpath(cwd);
    const result = await this.attempt(key, "workspace", { operation: "info", arguments: { format: "json" } }, 20000);
    this.stalls.answered(key);
    const parsed = nativeInfoSchema.safeParse(result.value);
    if (!parsed.success) throw new NativeError("identity_shape", "Unsupported native context identity response.");
    return parsed.data;
  }

  async info(cwd: string, options: RequestOptions = {}): Promise<NativeInfo> {
    const result = await this.call(cwd, "workspace", { operation: "info", arguments: { format: "json" } }, 20000, options);
    const parsed = nativeInfoSchema.safeParse(result.value);
    if (!parsed.success) throw new NativeError("identity_shape", "Unsupported native context identity response.");
    return parsed.data;
  }

  private healthRequests = new Map<string, Promise<DaemonHealth>>();

  async daemonHealth(cwd: string, options: RequestOptions = {}): Promise<DaemonHealth> {
    const key = await realpath(cwd);
    const pending = this.healthRequests.get(key);
    if (pending) return pending;
    const request = this.serve(key, async () => {
      const connection = await this.acquire(key);
      try {
        await connection.ready;
        return await sampleDaemonHealth(connection.client);
      } catch (error) {
        if (isSessionReset(error)) throw new NativeError("session_reset", sessionResetMessage);
        if (isMcpTimeout(error)) throw new NativeError("timeout", "Gortex didn't send a health snapshot in time.");
        throw error;
      } finally {
        connection.active--;
        if (!connection.client.transport && this.connections.get(key) === connection) this.connections.delete(key);
      }
    }, options, 5000).finally(() => { if (this.healthRequests.get(key) === request) this.healthRequests.delete(key); });
    this.healthRequests.set(key, request);
    return request;
  }

  query(cwd: string, operation: Parameters<NativePort["query"]>[1], args: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<{ value: unknown; meta: unknown }> {
    if (operation === "index") return this.call(cwd, "workspace", { operation: "index", arguments: { format: "json", max_bytes: 12000 } }, 20000, options);
    if (operation === "search") return this.call(cwd, "search", { operation: "symbols", query: args.query, options: { workspace: args.workspace, repo: args.repo, limit: args.limit, paginate: true, cursor: args.cursor ?? undefined, expand: "off" }, output: { format: "json" } }, 20000, options);
    if (operation === "source") return this.call(cwd, "read", { operation: "source", target: { symbol: args.symbolId }, output: { format: "json", max_bytes: 12000 } }, 20000, options);
    if (operation === "impact") return this.call(cwd, "change", { operation: "impact", target: { symbol: args.symbolId }, output: { format: "json", limit: 50, max_bytes: 12000 } }, 20000, options);
    return this.call(cwd, "relations", { operation, target: { symbol: args.symbolId }, output: { format: "json", limit: 50, max_bytes: 12000 } }, 20000, options);
  }

  async repositoryIndexes(): Promise<unknown> {
    const raw = await runProcess(this.binary, ["repos", "--json"], homedir(), { maxBytes: 256000 });
    try { return JSON.parse(raw); }
    catch { throw new NativeError("repository_index_shape", "Gortex returned an invalid repository index catalog."); }
  }

  checkoutFamily(cwd: string, options: RequestOptions = {}): Promise<{ value: unknown; meta: unknown }> {
    return this.call(cwd, "workspace", { operation: "checkouts", arguments: { family: cwd, format: "json", max_bytes: 256000 } }, 20000, options);
  }

  checkouts(cwd: string, options: RequestOptions = {}): Promise<{ value: unknown; meta: unknown }> {
    return this.call(cwd, "workspace", { operation: "checkouts", arguments: { format: "json", max_bytes: 256000 } }, 20000, options);
  }

  async trackSupport(path: string): Promise<void> {
    const help = await runProcess(this.binary, ["track", "--help"], path, { timeoutMs: 10000, maxBytes: 16384 });
    requireTrackCliSupport(help);
  }

  async track(path: string): Promise<void> {
    // Explicit CLI adapter for a new root: a repository-bound MCP session cannot admit it yet.
    // The caller reconciles the native catalog; stdout is not treated as an index receipt.
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
