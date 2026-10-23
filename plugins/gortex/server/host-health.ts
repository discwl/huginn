import type { DaemonHealth } from "../shared/health-models.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage, pausedMessage, warmingUpMessage } from "../shared/native-retry.ts";
import { isWaiting } from "./native-response.ts";

type HealthPort = {
  assignments(): Promise<readonly { path: string }[]>;
  daemonHealth(path: string, options?: { background?: boolean }): Promise<DaemonHealth>;
  pausedUntil?(path: string): Promise<number | null>;
  resumeRequests?(): void;
};

function isTransient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : "";
  return isWaiting(error) || isBusyMessage(text) || isWarmingUpMessage(text);
}

function healthError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Gortex health is unavailable.";
  if (isWaiting(error)) return text;
  if (isBusyMessage(text)) return busyMessage;
  return isWarmingUpMessage(text) ? warmingUpMessage : text;
}

/**
 * The host-wide health snapshot, carried by up to three repositories' connections. The 30-second refresh is an
 * automatic request, so a repository Gortex is refusing is skipped until its pause ends; retryNow (Try now) ends
 * every pause first. warmup, read only when Gortex isn't ready or refused, describes a startup in progress.
 */
export async function readHostHealth(native: HealthPort, options: { retryNow?: boolean; now?: () => number; warmup?: () => Promise<string | null> } = {}) {
  const now = options.now ?? Date.now;
  const base = { scope: "host" as const, observedAt: new Date(now()).toISOString() };
  const warmup = () => options.warmup ? options.warmup().catch(() => null) : Promise.resolve(null);
  if (options.retryNow) native.resumeRequests?.();
  try {
    const members = await native.assignments();
    if (members.length === 0) throw new Error("The native catalog is empty; a tracked repository is required to connect to Gortex MCP.");
    // The repository supplies an admitted transport context, not the scope of these host-wide metrics. Whatever stops
    // one repository's request (a stall in its checkout, a folder that's gone, a daemon still loading its list of
    // repositories), another repository can still carry the same host-wide request.
    let stalled: unknown = null, failed: unknown = null, paused: number | null = null;
    for (const member of members.slice(0, 3)) {
      const until = await native.pausedUntil?.(member.path) ?? null;
      if (until !== null) { paused = paused === null ? until : Math.min(paused, until); continue; }
      try {
        const health = await native.daemonHealth(member.path, { background: true });
        return { ...base, state: "available" as const, health, error: null, pausedUntil: null, warmup: health.ready ? null : await warmup() };
      } catch (error) {
        if (isTransient(error)) stalled = error; else failed ??= error;
        // A refusal may have paused the remaining repositories too.
      }
    }
    if (stalled === null && paused !== null) return { ...base, state: "paused" as const, health: null, error: pausedMessage(paused - now()), pausedUntil: new Date(paused).toISOString(), warmup: await warmup() };
    if (stalled === null) throw failed;
    return { ...base, state: "busy" as const, health: null, error: healthError(stalled), pausedUntil: paused === null ? null : new Date(paused).toISOString(), warmup: await warmup() };
  } catch (error) {
    return { ...base, state: "unavailable" as const, health: null, error: healthError(error), pausedUntil: null, warmup: null };
  }
}
