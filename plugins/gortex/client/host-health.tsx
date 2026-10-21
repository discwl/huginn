import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { hostHealthRpc } from "../shared/health-contracts.ts";
import { Action, Badge, Card, Disclosure, Metric, Notice, SectionHeading } from "./controls.tsx";
import { ReportedSavings } from "./reported-savings.tsx";
import { GortexUpdatesPanel } from "./gortex-updates.tsx";
import { PluginUpdatesPanel } from "./plugin-updates.tsx";
import { DiagnosticsPanel } from "./diagnostics.tsx";
import { HostSettingsPanel } from "./host-settings.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme">;
function uptime(seconds: number) { const minutes = Math.floor(seconds / 60); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }

import { useHostDateTime } from "./host-time.tsx";

export function HostHealth({ host, theme, compact = false, onDetails }: Props & { compact?: boolean; onDetails?: () => void }) {
  const dateTime = useHostDateTime();
  const read = useRpc(hostHealthRpc);
  const [details, setDetails] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = [host.id, "gortex", "host-health"];
  const report = useQuery({ queryKey, queryFn: () => read({}), retry: false, refetchInterval: 30000, refetchIntervalInBackground: false, refetchOnWindowFocus: false });
  // The 30-second refresh skips repositories Gortex is refusing; Try now (and Refresh) asks Gortex again right away.
  const retry = useMutation({
    mutationFn: () => read({ retryNow: true }),
    onSuccess: result => {
      queryClient.setQueryData(queryKey, result);
      // Gortex answers again: reload what its paused requests left unavailable (the library, worktrees).
      if (result.state === "available") void queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === host.id && query.queryKey[1] === "gortex" && query.queryKey[2] !== "host-health" });
    },
  });
  const health = report.data?.health;
  const stale = report.isError || !!(health && Date.now() - Date.parse(health.ts) > 90000);
  const waiting = report.data?.state === "busy" || report.data?.state === "paused";
  const busy = !health && waiting;
  const state = health ? stale ? "Stale snapshot" : health.ready ? "Ready" : "Warming up" : report.data?.state === "paused" ? "Paused" : busy ? "Busy" : report.isError || report.data?.error ? "Unavailable" : "Connecting";
  const checking = retry.isPending || report.isFetching;
  if (compact) return <View style={{ gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, flexShrink: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{host.label} daemon</Text>
        <Badge theme={theme} label={state} tone={state === "Ready" ? "success" : state === "Unavailable" || stale ? "danger" : "warning"} icon={state === "Ready" ? "CheckCircle2" : "Clock"} />
        {health && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, flexShrink: 1 }}>{health.tracked_repos} repos · {health.graph_nodes.toLocaleString()} nodes · {(health.alloc_bytes / 1048576).toFixed(1)} MiB · up {uptime(health.uptime_seconds)}</Text>}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {busy && <Action theme={theme} title={checking ? "Checking…" : "Try now"} icon="RefreshCw" disabled={checking} onPress={() => retry.mutate()} />}
        {onDetails && <Action theme={theme} title="View health" icon="ArrowUpRight" onPress={onDetails} />}
      </View>
    </View>
    {(report.error || report.data?.error) && <Notice theme={theme} error={!busy} text={report.error?.message ?? report.data?.error ?? "Health is unavailable."} />}
    {retry.error && <Notice theme={theme} error text={retry.error.message} />}
  </View>;
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <SectionHeading theme={theme} title="Daemon health" icon="Activity" subtitle={`${host.label} · all repositories on this host`} />
        <Badge theme={theme} label={state} tone={state === "Ready" ? "success" : state === "Unavailable" || stale ? "danger" : "warning"} icon={state === "Ready" ? "CheckCircle2" : "Clock"} />
        {health && <Badge theme={theme} label={health.enriched ? "Enriched" : "Enrichment pending"} tone={health.enriched ? "neutral" : "warning"} icon="Sparkles" />}
      </View>
      <Action title={checking ? "Checking…" : busy ? "Try now" : "Refresh health"} icon="RefreshCw" disabled={checking} theme={theme} onPress={() => retry.mutate()} />
    </View>
    {!report.data && report.isFetching && <Notice theme={theme} text="Connecting to Gortex for a health snapshot…" />}
    {report.error && <Notice theme={theme} error text={`Health unavailable: ${report.error.message}`} />}
    {report.data?.error && <Notice theme={theme} error={!busy} text={report.data.error} />}
    {retry.error && <Notice theme={theme} error text={retry.error.message} />}
    {health && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Metric theme={theme} icon="Network" label="Graph nodes" value={health.graph_nodes.toLocaleString()} detail={`${health.tracked_repos} tracked ${health.tracked_repos === 1 ? "repository" : "repositories"}`} />
        <Metric theme={theme} icon="GitBranch" label="Relationships" value={health.graph_edges.toLocaleString()} detail="Across this host's graph" />
        <Metric theme={theme} icon="Cpu" label="Allocated memory" value={`${(health.alloc_bytes / 1048576).toFixed(1)} MiB`} detail={`${(health.db_bytes / 1048576).toFixed(1)} MiB database`} />
        <Metric theme={theme} icon="Clock" label="Uptime" value={uptime(health.uptime_seconds)} detail={`${health.sessions} MCP ${health.sessions === 1 ? "session" : "sessions"}`} />
      </View>
      <Notice theme={theme} text={`Updated ${dateTime(health.ts)} · Refreshes every 30 seconds while this panel is active.`} />
      <Disclosure theme={theme} title="Runtime details" open={details} onToggle={() => setDetails(value => !value)}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 24 }}>{[
          ["Language servers", `${health.lsp_alive} running / ${health.lsp_specs_registered} configured`],
          ["Runtime system memory", `${(health.sys_bytes / 1048576).toFixed(1)} MiB`],
          ["Write-ahead log", `${(health.wal_bytes / 1048576).toFixed(1)} MiB`],
          ["Goroutines", health.num_goroutine.toLocaleString()],
        ].map(([label, value]) => <View key={label} style={{ gap: 5, minWidth: 140 }}><Notice theme={theme} text={label} /><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{value}</Text></View>)}</View>
        <Notice theme={theme} text="Language servers start on demand. Runtime metrics describe the daemon on the selected host." />
      </Disclosure>
    </>}
    <DiagnosticsPanel host={host} theme={theme} />
      <HostSettingsPanel host={host} theme={theme} />
      <GortexUpdatesPanel host={host} theme={theme} />
      <PluginUpdatesPanel host={host} theme={theme} />
    <ReportedSavings host={host} theme={theme} />
  </Card>;
}
