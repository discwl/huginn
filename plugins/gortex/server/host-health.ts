import type { DaemonHealth } from "../shared/health-models.ts";
import { busyMessage, isBusyMessage, isWarmingUpMessage } from "../shared/native-retry.ts";

type HealthPort = {
  assignments(): Promise<readonly { path: string }[]>;
  daemonHealth(path: string): Promise<DaemonHealth>;
};

function healthError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Gortex health is unavailable.";
  if (isBusyMessage(text)) return busyMessage;
  return isWarmingUpMessage(text) ? "Gortex is starting up and still discovering checkouts. Health returns once it is ready." : text;
}

export async function readHostHealth(native: HealthPort) {
  try {
    const members = await native.assignments();
    if (members.length === 0) throw new Error("The native catalog is empty; a tracked repository is required to connect to Gortex MCP.");
    // The repository supplies an admitted transport context, not the scope of these host-wide metrics.
    const health = await native.daemonHealth(members[0].path);
    return { scope: "host" as const, state: "available" as const, health, error: null, observedAt: new Date().toISOString() };
  } catch (error) {
    return { scope: "host" as const, state: "unavailable" as const, health: null, error: healthError(error), observedAt: new Date().toISOString() };
  }
}
