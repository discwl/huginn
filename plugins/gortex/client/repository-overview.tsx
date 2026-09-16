import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { indexSummarySchema } from "../shared/health-models.ts";
import { Action, Badge, Disclosure, Metric, Notice } from "./controls.tsx";

type Props = {
  theme: PluginSurfaceProps["theme"];
  report?: { value: unknown; observedAt: string; scope: "host" };
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
};

import { useHostDateTime } from "./host-time.tsx";

export function RepositoryOverview({ theme, report, loading, error, onRefresh }: Props) {
  const dateTime = useHostDateTime();
  const [details, setDetails] = useState(false);
  const [raw, setRaw] = useState(false);
  const index = indexSummarySchema.safeParse(report?.value);
  const refreshing = !!report && typeof report.value === "object" && report.value !== null && "status" in report.value && report.value.status === "refreshing";
  const response = report ? JSON.stringify(report.value, null, 2) : "";
  return <View style={{ gap: 18 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>Host index health</Text>
      <Action title={loading ? "Refreshing…" : "Refresh summary"} icon="RefreshCw" theme={theme} disabled={loading} onPress={onRefresh} />
    </View>
    <Notice theme={theme} text="All tracked repositories and Gortex workspaces on this host. Switching repositories does not change these totals." />
    {loading && !report && <Notice theme={theme} text="Reading the host index report…" />}
    {error && <Notice theme={theme} error text={error.message} />}
    {!error && report && <>
      {index.success ? <>
        <View style={{ gap: 10, padding: 15, borderRadius: 12, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <Badge theme={theme} label={`Host index ${index.data.status}`} icon={index.data.index_complete ? "CheckCircle2" : "Clock"} tone={index.data.status === "ready" && index.data.index_complete ? "success" : "warning"} />
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}><Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 24 }}>{index.data.health_score}</Text><Notice theme={theme} text="/ 100 host index score" /></View>
          </View>
          <View accessibilityLabel={`Host index score ${index.data.health_score} of 100`} style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}><View style={{ width: `${index.data.health_score}%`, height: 4, backgroundColor: theme.colors.accent }} /></View>
          {!index.data.index_complete && <Notice theme={theme} text="Indexing is incomplete on this host. Results may be partial." />}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Metric theme={theme} icon="Files" label="Indexed files" value={index.data.indexed_file_count.toLocaleString()} />
          <Metric theme={theme} icon="Network" label="Graph nodes" value={index.data.node_count.toLocaleString()} />
          <Metric theme={theme} icon="GitBranch" label="Relationships" value={index.data.edge_count.toLocaleString()} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Badge theme={theme} icon={index.data.failed_file_count ? "AlertTriangle" : "Check"} label={`${index.data.failed_file_count} parse failures`} tone={index.data.failed_file_count ? "danger" : "neutral"} />
          <Badge theme={theme} icon={index.data.unreadable_file_count ? "AlertTriangle" : "Check"} label={`${index.data.unreadable_file_count} unreadable files`} tone={index.data.unreadable_file_count ? "danger" : "neutral"} />
        </View>
      </> : <Notice theme={theme} text={refreshing ? "Gortex is preparing the host index report. Refresh the summary again shortly." : "This report needs a newer summary adapter. The native response is available in the details below."} />}
      <Notice theme={theme} text={`Host-wide snapshot · Updated ${dateTime(report.observedAt)}. Counts can differ from daemon health when sampled at different times.`} />
      <Disclosure theme={theme} title="Scope and native response" open={details} onToggle={() => setDetails(value => !value)}>
        <Notice theme={theme} text="Gortex's native index-health report is shared across the daemon. These are not per-repository or per-workspace statistics. Source and symbol search still use the selected repository." />
        {index.success && index.data.last_index_time && <Notice theme={theme} text={`Last native index time: ${dateTime(index.data.last_index_time)}`} />}
        <Action theme={theme} title={raw ? "Hide response" : "Show native response"} icon="Braces" onPress={() => setRaw(value => !value)} />
        {raw && <><ScrollView nestedScrollEnabled style={{ maxHeight: 320, borderRadius: 10, backgroundColor: theme.colors.surface0 }}><ScrollView horizontal contentContainerStyle={{ padding: 14 }}><Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{response.slice(0, 8000)}</Text></ScrollView></ScrollView>{response.length > 8000 && <Notice theme={theme} text="Response display is limited to 8,000 characters." />}</>}
      </Disclosure>
    </>}
  </View>;
}
