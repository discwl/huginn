/**
 * Gortex reports several warm-up conditions as request errors and asks the caller to retry: checkout discovery
 * runs after a daemon start or upgrade, and its mutation lane serializes that work. These are not failures of
 * the repository, so the plugin retries briefly and describes the wait instead of showing the raw native text.
 */
const retryable = [
  /\bretry this request\b/i,
  /\bdiscovery is (?:still )?pending\b/i,
  /\bmutation lane is busy\b/i,
  /\bview_building\b/i,
  /\bwarming up\b/i,
  // Gortex serves at most 8 MCP requests daemon-wide and rejects the rest with -32002 (retryable).
  /\bdispatcher is busy\b/i,
  /-32002\b/,
];

export function isBusyMessage(message: string): boolean {
  return /\bdispatcher is busy\b/i.test(message) || /-32002\b/.test(message);
}

export const busyMessage = "Gortex is handling as many requests as it allows at once (8 by default), so this one was refused. It usually clears in a moment; close idle agent sessions, or raise GORTEX_MCP_MAX_CONCURRENT_DISPATCHES on this host.";

export function isWarmingUpMessage(message: string): boolean {
  return retryable.some(pattern => pattern.test(message));
}

export const warmingUpMessage = "Gortex is busy building or discovering a checkout and didn't answer for this repository in time. This usually clears on its own; refresh in a moment.";

/** Delays before each retry of a warming-up native request. */
export const warmupRetryDelaysMs = [300, 700, 1500, 3000, 6000];
