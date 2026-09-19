import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { preferences } from "../shared/contracts.ts";
import { autoIndexActivityRpc, type AutoIndexRecord } from "../shared/auto-index-contracts.ts";
import { Badge, Button, Card, Notice, SectionHeading } from "./controls.tsx";
import { HostTimeProvider, useHostDateTime } from "./host-time.tsx";

export function Settings(props: PluginSurfaceProps) {
  return <HostTimeProvider key={props.host.id} hostId={props.host.id}><HostSettings {...props} /></HostTimeProvider>;
}

const outcomeLabel: Record<AutoIndexRecord["outcome"], { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  running: { label: "Indexing", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  indexed: { label: "Indexed", tone: "success" },
  assigned: { label: "Indexed · workspace set", tone: "success" },
  pending: { label: "Workspace pending", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

function HostSettings({ theme, host, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const dateTime = useHostDateTime();
  const readActivity = useRpc(autoIndexActivityRpc);
  const activity = useQuery({ queryKey: [host.id, "gortex", "auto-index-activity"], queryFn: () => readActivity({}), refetchInterval: 5000, refetchIntervalInBackground: false, retry: false });
  const saved = settings.status === "ready" ? settings.values.defaultWorkspace : "";
  const [workspace, setWorkspace] = useState(saved);
  useEffect(() => { setWorkspace(saved); }, [saved]);
  const savedAgent = settings.status === "ready" ? settings.values.suggestionAgent : "";
  const [agent, setAgent] = useState(savedAgent);
  useEffect(() => { setAgent(savedAgent); }, [savedAgent]);
  const save = (patch: Partial<{ searchLimit: number; autoIndex: boolean; defaultWorkspace: string; suggestionAgent: string }>) => {
    if (settings.status === "ready") void settings.save({ ...settings.values, ...patch }, settings.revision);
  };
  const busy = settings.status !== "ready" || settings.saving;
  return <View style={{ padding: layout.compact ? 12 : 24, gap: 16, backgroundColor: theme.colors.surface0, flex: 1 }}>
    <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>Gortex preferences · {host.label}</Text>
      <Notice theme={theme} text="These preferences are shared by every client connected to this host." />
      {settings.status === "loading" && <Notice theme={theme} text="Loading saved preferences…" />}
      {settings.status === "ready" && <>
        <Text style={{ color: theme.colors.foreground }}>Search results per page: {settings.values.searchLimit}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>{[10, 25, 50].map(searchLimit => <Button key={searchLimit} title={String(searchLimit)} theme={theme} disabled={busy} selected={settings.values.searchLimit === searchLimit} onPress={() => save({ searchLimit })} />)}</View>
      </>}
      {(settings.status === "error" || settings.status === "invalid") && <Notice theme={theme} error text={String(settings.error)} />}
      {settings.saveError && <Notice theme={theme} error text={String(settings.saveError)} />}
      <Button title="Reload preferences" theme={theme} onPress={() => { void settings.reload(); }} />
    </Card>
    <Card theme={theme}>
      <SectionHeading theme={theme} title="Auto-index new projects" icon="Sparkles" subtitle="When a new project is added to Paseo on this host, index it with Gortex and assign the default workspace." />
      {settings.status === "ready" && <>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="Off" theme={theme} disabled={busy} selected={!settings.values.autoIndex} onPress={() => save({ autoIndex: false })} />
          <Button title="On" theme={theme} disabled={busy} selected={settings.values.autoIndex} onPress={() => save({ autoIndex: true })} />
        </View>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Default workspace</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <TextInput accessibilityLabel="Default Gortex workspace" value={workspace} editable={!busy} maxLength={160} autoCapitalize="none" autoCorrect={false} onChangeText={setWorkspace} placeholder="Keep each project's native default" placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 44, minWidth: 220, flexGrow: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0, paddingHorizontal: 12, color: theme.colors.foreground, fontSize: 14 }} />
          <Button title="Save workspace" theme={theme} disabled={busy || workspace.trim() === saved} onPress={() => save({ defaultWorkspace: workspace.trim() })} />
        </View>
        <Notice theme={theme} text="Worktrees, folders that overlap a tracked repository, and repositories Gortex already tracks are skipped. Plain folders without Git are indexed too. Setting the workspace saves config.yaml with a backup and refreshes the new repository's index." />
      </>}
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Recent automatic indexing</Text>
      {activity.isError && <Notice theme={theme} error text={activity.error instanceof Error ? activity.error.message : "Activity is unavailable."} />}
      {activity.data && activity.data.records.length === 0 && <Notice theme={theme} text="Nothing yet since the plugin last started. Activity is kept in memory and clears on reload." />}
      {activity.data?.records.map(record => <View key={record.id} style={{ gap: 4, paddingVertical: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge theme={theme} label={outcomeLabel[record.outcome].label} tone={outcomeLabel[record.outcome].tone} />
          <Text style={{ color: theme.colors.foreground, flexShrink: 1 }}>{record.path}</Text>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{dateTime(record.observedAt)}{record.workspace ? ` · workspace ${record.workspace}` : ""}</Text>
        {record.message && <Text style={{ color: record.outcome === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12 }}>{record.message}</Text>}
      </View>)}
    </Card>
    <Card theme={theme}>
      <SectionHeading theme={theme} title="Exclusion suggestions" icon="Sparkles" subtitle="The agent used by Repository settings → Edit exclusions → Suggest rules." />
      {settings.status === "ready" && <>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <TextInput accessibilityLabel="Suggestion agent, as provider/model" value={agent} editable={!busy} maxLength={200} autoCapitalize="none" autoCorrect={false} onChangeText={setAgent} placeholder="claude/claude-sonnet-5" placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 44, minWidth: 220, flexGrow: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0, paddingHorizontal: 12, color: theme.colors.foreground, fontSize: 14, fontFamily: "monospace" }} />
          <Button title="Save agent" theme={theme} disabled={busy || agent.trim() === savedAgent || agent.trim() === ""} onPress={() => save({ suggestionAgent: agent.trim() })} />
        </View>
        <Notice theme={theme} text="Use provider/model, for example claude/claude-sonnet-5. The provider must offer a plan or read-only mode; the agent runs once per request and is archived afterwards." />
      </>}
    </Card>
    <Notice theme={theme} text="Gortex is resolved from the selected host's PATH. This plugin does not start, stop, or restart the Gortex daemon." />
  </View>;
}
