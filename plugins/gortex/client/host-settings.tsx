import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { hostSettingsRpc } from "../shared/host-settings-contracts.ts";
import { Action, Badge, Card, Notice, SectionHeading } from "./controls.tsx";
import { useHostDateTime } from "./host-time.tsx";

/** Read-only view of the Gortex settings that decide whether agents can start on this host. */
export function HostSettingsPanel({ host, theme }: Pick<PluginSurfaceProps, "host" | "theme">) {
  const read = useRpc(hostSettingsRpc);
  const dateTime = useHostDateTime();
  const settings = useQuery({ queryKey: [host.id, "gortex", "host-settings"], queryFn: () => read({}), retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  const data = settings.data;
  const Row = ({ label, value, children }: { label: string; value: string; children?: ReactNode }) => <View style={{ gap: 3, paddingVertical: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>{label}</Text>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>{value}</Text>
    </View>
    {children}
  </View>;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 } as const;
  const clients = new Map<string, number>();
  for (const session of data?.sessions ?? []) clients.set(session.client || "unknown", (clients.get(session.client || "unknown") ?? 0) + 1);
  const pinned = data?.repositories.filter(repository => repository.belowCpu) ?? [];
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <SectionHeading theme={theme} title="Gortex settings" icon="SlidersHorizontal" subtitle={`What limits Gortex on ${host.label}. Read-only.`} />
      <Action title={settings.isFetching ? "Reading…" : "Refresh"} icon="RefreshCw" theme={theme} disabled={settings.isFetching} onPress={() => { void settings.refetch(); }} />
    </View>
    {settings.error && <Notice theme={theme} error text={settings.error.message} />}
    {data && <>
      <Row label="Requests at once" value={data.dispatchLimit.configured === null ? `${data.dispatchLimit.defaultValue} (default)` : `${data.dispatchLimit.configured} (set on this host)`}>
        <Text style={muted}>How many requests Gortex handles at the same time, shared by every agent and this plugin. When full, new requests fail with "MCP dispatcher is busy". Raise it with the GORTEX_MCP_MAX_CONCURRENT_DISPATCHES environment variable (up to {data.dispatchLimit.maximum}), then restart Gortex and Paseo. The running daemon keeps the value it started with, which this plugin can't read.</Text>
      </Row>
      <Row label="Connected sessions" value={String(data.sessions.length)}>
        <Text style={muted}>{data.sessions.length ? [...clients].map(([client, count]) => `${count} ${client}`).join(" · ") : "No clients are connected."}</Text>
      </Row>
      <Row label="Index workers" value={pinned.length ? `${pinned.length} repo${pinned.length === 1 ? "" : "s"} below ${data.cpuCount}` : `${data.cpuCount} (CPU count)`}>
        <Text style={muted}>Files parsed in parallel while indexing. Gortex uses the CPU count unless a repository's .gortex.yaml sets index.workers. A lower value makes that repository index more slowly.</Text>
        {pinned.map(repository => <View key={repository.path} style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge theme={theme} label={`${repository.workers} of ${data.cpuCount}`} tone="warning" />
          <Text style={muted}>{repository.name} pins index.workers in its .gortex.yaml</Text>
        </View>)}
      </Row>
      <Row label="Daemon" value={data.daemon.running ? data.daemon.state ?? "running" : "not running"}>
        <Text style={muted}>{[data.daemon.version, data.daemon.pid ? `PID ${data.daemon.pid}` : null, data.daemon.uptime ? `up ${data.daemon.uptime}` : null, data.daemon.service].filter(Boolean).join(" · ") || "No daemon details available."}</Text>
      </Row>
      <Row label="Host configuration" value="">
        <Text selectable style={{ ...muted, fontFamily: "monospace" }}>{data.configPath}</Text>
      </Row>
      {data.warnings.map((warning, index) => <Notice key={index} theme={theme} text={warning} />)}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Read {dateTime(data.observedAt)}</Text>
    </>}
  </Card>;
}
