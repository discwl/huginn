import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { workspaceBadgesRpc, type WorkspaceBadge } from "../shared/workspace-badge-contracts.ts";

const shown: Record<WorkspaceBadge, { label: string; icon: string }> = {
  "not-indexed": { label: "Not indexed", icon: "Database" },
  paused: { label: "Gortex paused", icon: "Clock" },
};
type Badges = { badges: Record<string, WorkspaceBadge> };
// Every row on a host shares one read, asked for at most once a minute however many rows refresh their query.
const reads = new Map<string, { at: number; value: Promise<Badges> }>();
function readShared(hostId: string, read: () => Promise<Badges>): Promise<Badges> {
  const cached = reads.get(hostId), now = Date.now();
  if (cached && now - cached.at < 60_000) return cached.value;
  const value = read();
  reads.set(hostId, { at: now, value });
  return value;
}

/** A workspace row's Gortex status (Paseo 0.16 apps): nothing unless its repository isn't indexed or Gortex is paused. */
export function GortexRowBadge({ host, workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const read = useRpc(workspaceBadgesRpc);
  const all = useQuery({ queryKey: [host.id, "gortex", "workspace-badges"], queryFn: () => readShared(host.id, () => read({})), staleTime: 60_000, refetchInterval: 60_000, refetchOnWindowFocus: false, retry: false });
  const badge = all.data?.badges[workspaceId];
  return badge ? <WorkspaceRowBadge icon={shown[badge].icon} label={shown[badge].label} tone="warning" /> : null;
}
