import type { DaemonHealth } from "../shared/health-models.ts";

type HealthPort = {
  assignments(): Promise<readonly { path: string }[]>;
  daemonHealth(path: string): Promise<DaemonHealth>;
};

export async function readHostHealth(native: HealthPort) {
  try {
    const members = await native.assignments();
    if (members.length === 0) throw new Error("The native catalog is empty; a tracked repository is required to connect to Gortex MCP.");
    // The repository supplies an admitted transport context, not the scope of these host-wide metrics.
    const health = await native.daemonHealth(members[0].path);
    return { scope: "host" as const, state: "available" as const, health, error: null, observedAt: new Date().toISOString() };
  } catch (error) {
    return { scope: "host" as const, state: "unavailable" as const, health: null, error: error instanceof Error ? error.message : "Gortex health is unavailable.", observedAt: new Date().toISOString() };
  }
}
