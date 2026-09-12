import { Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Repository } from "../shared/models.ts";
import { Action, Badge, Notice } from "./controls.tsx";

type Props = { theme: PluginSurfaceProps["theme"]; repository: Repository; compact: boolean; trackingAvailable: boolean; onIndex: () => void };
export function PaseoProjectRow({ theme, repository, compact, trackingAvailable, onIndex }: Props) {
  const canIndex = repository.state === "untracked";
  const status = canIndex ? "Not indexed" : repository.state === "worktree" ? "Worktree · check view" : repository.state === "unsupported" ? "Git not verified" : "Folder unavailable";
  return <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, padding: 12, gap: 10 }}>
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 14, minWidth: 0 }}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minWidth: 0 }}>
        {!compact && <View style={{ padding: 9, borderRadius: 10, backgroundColor: theme.colors.surface0 }}><Icon name="Folder" size={18} color={theme.colors.foregroundMuted} /></View>}
        <View style={{ flex: 1, gap: 5, minWidth: 0 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{repository.name}</Text>
          <Text selectable numberOfLines={2} ellipsizeMode="middle" style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 17 }}>{repository.path}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>Paseo project · No dedicated Gortex tracking entry</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <View><Badge theme={theme} label={status} tone="warning" icon={canIndex ? "CircleDashed" : "CircleAlert"} /></View>
        {canIndex && <View><Action theme={theme} title="Index" icon="Database" disabled={!trackingAvailable} onPress={onIndex} /></View>}
      </View>
    </View>
    {repository.error && <Notice theme={theme} text={repository.error} error={repository.state === "unavailable"} />}
    {canIndex && !trackingAvailable && <Notice theme={theme} text="Indexing from Paseo is verified for Gortex 0.64.3. This host needs a compatible adapter." />}
  </View>;
}
