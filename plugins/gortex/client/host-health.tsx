import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { hostHealthRpc } from "../shared/health-contracts.ts";
import { Action, Badge, Card, Disclosure, Metric, Notice, SectionHeading } from "./controls.tsx";
import { ReportedSavings } from "./reported-savings.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme">;
function uptime(seconds: number) { const minutes = Math.floor(seconds / 60); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }

export function HostHealth({ host, theme, compact = false, onDetails }: Props & { compact?: boolean; onDetails?: () => void }) {
  const read = useRpc(hostHealthRpc);
  const [details, setDetails] = useState(false);
  const report = useQuery({ queryKey: [host.id, "gortex", "host-health"], queryFn: () => read({}), retry: false, refetchInterval: 30000, refetchIntervalInBackground: false, refetchOnWindowFocus: false });
  const health = report.data?.health;
  const stale = report.isError || !!(health && Date.now() - Date.parse(health.ts) > 90000);
  const state = health ? stale ? "Stale snapshot" : health.ready ? "Ready" : "Warming up" : report.isError || report.data?.error ? "Unavailable" : "Connecting";
  if (compact) return <View style={{ gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12, flexShrink: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{host.label} daemon</Text>
        <Badge theme={theme} label={state} tone={state === "Ready" ? "success" : state === "Unavailable" || stale ? "danger" : "warning"} icon={state === "Ready" ? "CheckCircle2" : "Clock"} />
        {health && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, flexShrink: 1 }}>{health.tracked_repos} repos · {health.graph_nodes.toLocaleString()} nodes · {(health.alloc_bytes / 1048576).toFixed(1)} MiB · up {uptime(health.uptime_seconds)}</Text>}
      </View>
      {onDetails && <Action theme={theme} title="View health" icon="ArrowUpRight" onPress={onDetails} />}
    </View>
    {(report.error || report.data?.error) && <Notice theme={theme} error text={report.error?.message ?? report.data?.error ?? "Health is unavailable."} />}
  </View>;
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <SectionHeading theme={theme} title="Daemon health" icon="Activity" subtitle={`${host.label} · all repositories on this host`} />
        <Badge theme={theme} label={state} tone={state === "Ready" ? "success" : state === "Unavailable" || stale ? "danger" : "warning"} icon={state === "Ready" ? "CheckCircle2" : "Clock"} />
        {health && <Badge theme={theme} label={health.enriched ? "Enriched" : "Enrichment pending"} tone={health.enriched ? "neutral" : "warning"} icon="Sparkles" />}
      </View>
      <Action title={report.isFetching ? "Checking…" : "Refresh health"} icon="RefreshCw" disabled={report.isFetching} theme={theme} onPress={() => { void report.refetch(); }} />
    </View>
    {!report.data && report.isFetching && <Notice theme={theme} text="Connecting to Gortex for a health snapshot…" />}
    {report.error && <Notice theme={theme} error text={`Health unavailable: ${report.error.message}`} />}
    {report.data?.error && <Notice theme={theme} error text={report.data.error} />}
    {health && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Metric theme={theme} icon="Network" label="Graph nodes" value={health.graph_nodes.toLocaleString()} detail={`${health.tracked_repos} tracked ${health.tracked_repos === 1 ? "repository" : "repositories"}`} />
        <Metric theme={theme} icon="GitBranch" label="Relationships" value={health.graph_edges.toLocaleString()} detail="Across this host's graph" />
        <Metric theme={theme} icon="Cpu" label="Allocated memory" value={`${(health.alloc_bytes / 1048576).toFixed(1)} MiB`} detail={`${(health.db_bytes / 1048576).toFixed(1)} MiB database`} />
        <Metric theme={theme} icon="Clock" label="Uptime" value={uptime(health.uptime_seconds)} detail={`${health.sessions} MCP ${health.sessions === 1 ? "session" : "sessions"}`} />
      </View>
      <Notice theme={theme} text={`Updated ${new Date(health.ts).toLocaleTimeString()} · Refreshes every 30 seconds while this panel is active.`} />
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
    <ReportedSavings host={host} theme={theme} />
  </Card>;
}
