import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { preferences } from "../shared/contracts.ts";
import { Button, Card, Notice } from "./controls.tsx";

export function Settings({ theme, host, layout }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  return <View style={{ padding: layout.compact ? 12 : 24, gap: 16, backgroundColor: theme.colors.surface0, flex: 1 }}>
    <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>Gortex preferences · {host.label}</Text>
      <Notice theme={theme} text="These display preferences are shared by authorized clients of this host. The selected Gortex workspace stays in this client." />
      {settings.status === "loading" && <Notice theme={theme} text="Loading saved preferences…" />}
      {settings.status === "ready" && <>
        <Text style={{ color: theme.colors.foreground }}>Search results per page: {settings.values.searchLimit}</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>{[10, 25, 50].map(searchLimit => <Button key={searchLimit} title={String(searchLimit)} theme={theme} disabled={settings.saving} selected={settings.values.searchLimit === searchLimit} onPress={() => { void settings.save({ searchLimit }, settings.revision); }} />)}</View>
      </>}
      {(settings.status === "error" || settings.status === "invalid") && <Notice theme={theme} error text={String(settings.error)} />}
      {settings.saveError && <Notice theme={theme} error text={String(settings.saveError)} />}
      <Button title="Reload preferences" theme={theme} onPress={() => { void settings.reload(); }} />
    </Card>
    <Notice theme={theme} text="Gortex is resolved from the selected host's PATH. This Paseo beta does not expose a public server settings reader, so executable overrides and browse-root policy are not offered here." />
    <Notice theme={theme} text="Repository tracking, assignment, and exact checkout selection remain unavailable until their native contracts are verified. This plugin does not manage daemon lifecycle." />
  </View>;
}
