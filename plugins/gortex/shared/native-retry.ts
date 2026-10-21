/**
 * How Gortex refuses requests it can't serve yet:
 * - Stalls: Gortex is still building or discovering a checkout's view ("discovery is pending", "mutation lane is
 *   busy"). Right after the daemon starts this takes seconds to minutes. On some Windows hosts it stays stuck for
 *   hours on a daemon that has been up much longer, refusing every repository in under a second.
 * - Capacity: Gortex serves at most 8 MCP requests daemon-wide and refuses the rest with -32002.
 */
const stallPatterns = [
  /\bretry this request\b/i,
  /\bdiscovery is (?:still )?pending\b/i,
  /\bmutation lane is busy\b/i,
  /\bview_building\b/i,
  /\bwarming up\b/i,
];
const busyPatterns = [/\bdispatcher is busy\b/i, /-32002\b/];

export function isBusyMessage(message: string): boolean {
  return busyPatterns.some(pattern => pattern.test(message));
}

/** Gortex is still discovering a checkout (not out of request slots). */
export function isStallMessage(message: string): boolean {
  return !isBusyMessage(message) && stallPatterns.some(pattern => pattern.test(message));
}

/** Either kind: Gortex is running, but didn't serve this request. */
export function isWarmingUpMessage(message: string): boolean {
  return isBusyMessage(message) || stallPatterns.some(pattern => pattern.test(message));
}

export const busyMessage = "Gortex is handling as many requests as it allows at once (8 by default), so this one was refused. It usually clears in a moment; close idle agent sessions, or raise GORTEX_MCP_MAX_CONCURRENT_DISPATCHES on this host.";

/** For a daemon that started minutes ago, when its own retries ran out. */
export const warmingUpMessage = "Gortex started a few minutes ago and is still discovering checkouts, so it couldn't answer for this repository yet. That usually takes seconds to a few minutes; refresh in a moment.";

/** A daemon this young is still discovering checkouts after its start, so its refusals are waited out. */
export const warmupWindowSeconds = 300;

/** Delays before each retry of a refused request while the daemon warms up, or while it is out of request slots. */
export const warmupRetryDelaysMs = [300, 700, 1500, 3000, 6000];

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Gortex refused, or didn't answer, and the plugin paused its automatic requests for `pauseMs`. */
export function stalledMessage(pauseMs: number, timeoutMs: number | null = null): string {
  const what = timeoutMs === null ? "Gortex refused this request because it is still discovering checkouts" : `Gortex didn't answer within ${Math.round(timeoutMs / 1000)} seconds`;
  return `${what}. On some hosts that stays stuck for a long time, and retrying only adds to Gortex's work, so the plugin paused its automatic Gortex requests for about ${minutes(pauseMs)} min. Use Try now in Host health to check sooner, or run Diagnostics.`;
}

/** An automatic request that wasn't sent because of an earlier refusal. */
export function pausedMessage(remainingMs: number): string {
  return `Gortex was refusing requests, so the plugin paused its automatic Gortex requests for about ${minutes(remainingMs)} more min. Use Try now in Host health to check sooner.`;
}
