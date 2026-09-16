import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
type PluginTheme = PluginSurfaceProps["theme"];
import { worktreesRpc, type Worktree } from "../shared/worktree-contracts.ts";
import { Action, Badge, Notice, SectionHeading } from "./controls.tsx";

const labels: Record<Worktree["status"], string> = { ready: "View ready", building: "Building", unavailable: "Unavailable", unknown: "View status unavailable", unregistered: "No checkout-view record" };
import { useHostDateTime } from "./host-time.tsx";

function WorktreeRow({ row, theme, onOpen }: { row: Worktree; theme: PluginTheme; onOpen?: (path: string) => Promise<void> }) {
  const dateTime = useHostDateTime();
  const [details, setDetails] = useState(false);
  const opening = useMutation({ mutationFn: () => onOpen!(row.path) });
  return <View style={{ padding: 16, gap: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface0, minWidth: 0 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <View style={{ gap: 7, flexShrink: 1 }}>
        <SectionHeading theme={theme} title={row.branch?.replace(/^refs\/heads\//, "") || (row.commit ? `Detached · ${row.commit.slice(0, 8)}` : "Branch unavailable")} icon="GitBranch" />
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{row.path}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {row.repositoryIndex && <Badge theme={theme} label={row.repositoryIndex === "indexed" ? "Repository indexed" : row.repositoryIndex === "stale" ? "Repository index stale" : "Repository not indexed"} tone={row.repositoryIndex === "indexed" ? "success" : "warning"} />}
        {(row.checkoutId || !row.repositoryIndex) && <Badge theme={theme} label={labels[row.status]} tone={row.status === "ready" ? "success" : row.status === "unavailable" ? "danger" : "warning"} />}
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
      {row.primary && <Badge theme={theme} label="Primary checkout" />}
      {row.mode && <Badge theme={theme} label={`${row.mode === "automatic" ? "Automatic" : row.mode} tracking`} />}
      {row.commit && <Badge theme={theme} label={row.commit.slice(0, 12)} icon="GitCommitHorizontal" />}
      {row.locked && <Badge theme={theme} label="Git locked" icon="Lock" />}
      {row.prunable && <Badge theme={theme} label="Git marks this worktree prunable" tone="warning" />}
      {row.removalDeadline !== null && <Badge theme={theme} label="Native removal check pending" tone="warning" />}
    </View>
    {row.indexedAt && <Notice theme={theme} text={`Repository last indexed: ${dateTime(row.indexedAt)}`} />}
    {row.headMismatch && <Notice theme={theme} text={`Git HEAD differs from the commit Gortex last observed (${row.nativeCommit?.slice(0, 12)}). Current worktree readiness is unverified.`} />}
    {row.lastError && <Notice theme={theme} error text={row.lastError} />}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {onOpen && row.gitPresent && !row.prunable && <Action theme={theme} title={opening.isPending ? "Opening…" : "Open in Paseo"} icon="ArrowUpRight" disabled={opening.isPending} onPress={() => opening.mutate()} />}
      {row.checkoutId && <Action theme={theme} title={details ? "Hide details" : "Readiness details"} icon={details ? "ChevronUp" : "ChevronDown"} onPress={() => setDetails(!details)} />}
    </View>
    {opening.error && <Notice theme={theme} error text={opening.error.message} />}
    {details && <View style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
      <Notice theme={theme} text={`Checkout: ${row.state ?? "unknown"} · Query route: ${row.routeState ?? "not reported"}`} />
      <Notice theme={theme} text={`Graph: ${row.graph ?? "not reported"}`} />
      <Notice theme={theme} text={`Worktree worker: ${row.coordinatorLive ? "running" : "not running"}. A running worker does not mean indexing is in progress.`} />
      {row.transition && <Notice theme={theme} text={`Tracking transition: ${row.transition}`} />}
      {row.intents.length > 0 && <Notice theme={theme} text={`Tracking sources: ${row.intents.join(", ")}`} />}
      {row.availabilityDeadline !== null && <Notice theme={theme} text="Gortex is waiting for this checkout to become accessible." />}
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{row.checkoutId}</Text>
    </View>}
  </View>;
}
export function RepositoryWorktrees({ path, host, theme, onOpen }: Pick<PluginSurfaceProps, "host" | "theme"> & { path: string; onOpen?: (path: string) => Promise<void> }) {
  const dateTime = useHostDateTime();
  const list = useRpc(worktreesRpc), [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: [host.id, "gortex", "worktrees-v1", path, offset], queryFn: () => list({ path, offset }), retry: false, staleTime: 0, refetchOnWindowFocus: false, refetchInterval: 10000, refetchIntervalInBackground: false });
  const data = query.isError ? undefined : query.data;
  return <View style={{ gap: 14, minWidth: 0 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <SectionHeading theme={theme} title="Worktrees" icon="GitBranch" subtitle={data ? `${data.total} checkouts on ${host.label}` : `Checkouts on ${host.label}`} />
      <Action theme={theme} title={query.isFetching ? "Refreshing…" : "Refresh"} icon="RefreshCw" disabled={query.isFetching} onPress={() => { void query.refetch(); }} />
    </View>
    {query.isPending && <Notice theme={theme} text="Reading Git worktrees and Gortex checkout state…" />}
    {query.error && <Notice theme={theme} error text={query.error.message} />}
    {data && <>
      {data.nativeError && <Notice theme={theme} text={`Checkout-view details unavailable: ${data.nativeError} Repository index status is checked separately.`} />}
      {data.indexError && <Notice theme={theme} error text={`Repository index status unavailable: ${data.indexError}`} />}
      {data.gitError && <Notice theme={theme} error text={`Git worktree discovery unavailable: ${data.gitError}`} />}
      {!data.nativeError && !data.familyId && <Notice theme={theme} text="Gortex has no checkout family registered for this repository. An existing repository index does not establish worktree readiness." />}
      {data.rows.map(row => <WorktreeRow key={row.checkoutId ?? row.path} row={row} theme={theme} onOpen={onOpen} />)}
      {data.rows.length === 0 && !data.gitError && !data.nativeError && <Notice theme={theme} text="No worktrees were reported for this repository." />}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {data.offset > 0 && <Action theme={theme} title="Previous" icon="ChevronLeft" onPress={() => setOffset(Math.max(0, data.offset - 50))} />}
        {data.nextOffset !== null && <Action theme={theme} title="Next" icon="ChevronRight" onPress={() => setOffset(data.nextOffset!)} />}
      </View>
      <Notice theme={theme} text={`Observed ${dateTime(data.observedAt)}. Refreshes every 10 seconds while this tab is active. View readiness does not guarantee every analysis capability is complete.`} />
    </>}
  </View>;
}
