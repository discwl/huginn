import { useState } from "react";
import { View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { hostSavingsRpc } from "../shared/savings-contracts.ts";
import { Action, Disclosure, Metric, Notice } from "./controls.tsx";

export function ReportedSavings({ host, theme }: Pick<PluginSurfaceProps, "host" | "theme">) {
  const read = useRpc(hostSavingsRpc);
  const [visible, setVisible] = useState(false);
  const report = useQuery({ queryKey: [host.id, "gortex", "reported-savings"], queryFn: () => read({}), enabled: visible, retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  return <Disclosure theme={theme} title="Reported token savings" open={visible} onToggle={() => setVisible(value => !value)}>
    <Notice theme={theme} text="Gortex estimates across recorded tool calls on this host." />
    {report.isFetching && !report.data && <Notice theme={theme} text="Reading the native savings report…" />}
    {report.error && <Notice theme={theme} error text={report.error.message} />}
    {!report.isError && report.data && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>{report.data.buckets.map(bucket => <Metric key={bucket.label} theme={theme} icon="Coins" label={bucket.label} value={bucket.tokens_saved.toLocaleString()} detail={`tokens saved · ${bucket.percent_saved.toFixed(1)}%\n${bucket.calls_counted.toLocaleString()} recorded calls`} />)}</View>
      <Notice theme={theme} text={`Ledger updated ${report.data.lastUpdated || "at an unreported time"} · Observed ${new Date(report.data.observedAt).toLocaleTimeString()}`} />
    </>}
    <Action title={report.isFetching ? "Refreshing…" : "Refresh savings"} icon="RefreshCw" theme={theme} disabled={report.isFetching} onPress={() => { void report.refetch(); }} />
  </Disclosure>;
}
