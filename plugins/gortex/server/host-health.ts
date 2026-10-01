import type { DaemonHealth } from "../shared/health-models.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage } from "../shared/native-retry.ts";

type HealthPort = {
  assignments(): Promise<readonly { path: string }[]>;
  daemonHealth(path: string): Promise<DaemonHealth>;
};

function isTransient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : "";
  return isBusyMessage(text) || isWarmingUpMessage(text);
}

function healthError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Gortex health is unavailable.";
  if (isBusyMessage(text)) return busyMessage;
  return isWarmingUpMessage(text) ? "Gortex is busy building or discovering a checkout, so it didn't answer the health request in time. This usually clears on its own; it happens when several agents or worktrees are active." : text;
}

export async function readHostHealth(native: HealthPort) {
  try {
    const members = await native.assignments();
    if (members.length === 0) throw new Error("The native catalog is empty; a tracked repository is required to connect to Gortex MCP.");
    // The repository supplies an admitted transport context, not the scope of these host-wide metrics.
    // A stall belongs to one checkout, so another repository can still carry the same host-wide request.
    let stalled: unknown = null;
    for (const member of members.slice(0, 3)) {
      try {
        const health = await native.daemonHealth(member.path);
        return { scope: "host" as const, state: "available" as const, health, error: null, observedAt: new Date().toISOString() };
      } catch (error) {
        if (!isTransient(error)) throw error;
        stalled = error;
      }
    }
    return { scope: "host" as const, state: "busy" as const, health: null, error: healthError(stalled), observedAt: new Date().toISOString() };
  } catch (error) {
    return { scope: "host" as const, state: "unavailable" as const, health: null, error: healthError(error), observedAt: new Date().toISOString() };
  }
}
