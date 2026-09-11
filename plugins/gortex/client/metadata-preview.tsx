import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { MetadataPreview } from "../shared/metadata-contracts.ts";
import { Action, Notice, SectionHeading } from "./controls.tsx";
import { PatternList } from "./repository-exclusions.tsx";

const labels = { name: "Repository name", workspace: "Workspace", project: "Project" } as const;

export function MetadataChangePreview({ theme, preview, repair, locked, onConfirm, onCancel }: {
  theme: PluginSurfaceProps["theme"]; preview: MetadataPreview; repair: boolean; locked: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const patternsChanged = JSON.stringify(preview.before.extra.exclude) !== JSON.stringify(preview.exclude);
  return <View style={{ gap: 14, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface0 }}>
    <SectionHeading theme={theme} title={repair ? "Review mismatch repair" : preview.writesConfig ? "Review configuration change" : "Review daemon update"} icon="ClipboardCheck" />
    {repair && <Notice theme={theme} text="Review all three columns before confirming. The proposed result keeps the existing graph name and your chosen workspace and project." />}
    {(["name", "workspace", "project"] as const).map(key => <View key={key} style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{labels[key]}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {[
          { label: "Saved configuration", value: preview.before.effective[key] },
          { label: "Daemon now", value: preview.before.daemon?.[key] ?? "Unavailable" },
          { label: "After confirmation", value: preview.effective[key] },
        ].map((column, index) => <View key={column.label} style={{ flex: 1, minWidth: 120, gap: 5 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{column.label}</Text>
          <Text selectable style={{ color: index === 2 ? theme.colors.accent : theme.colors.foreground, fontSize: 14, fontWeight: index === 2 ? "600" : "400" }}>{column.value || "Not set"}</Text>
        </View>)}
      </View>
    </View>)}
    {preview.updatesExclusions && (patternsChanged ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
      <View style={{ flex: 1, minWidth: 180, gap: 8 }}><Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Current patterns · {preview.before.extra.exclude.length}</Text><PatternList theme={theme} patterns={preview.before.extra.exclude} /></View>
      <View style={{ flex: 1, minWidth: 180, gap: 8 }}><Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>After save · {preview.exclude.length}</Text><PatternList theme={theme} patterns={preview.exclude} empty="No repository rules; inherited rules remain" /></View>
    </View> : <Notice theme={theme} text={preview.rebuildsIndex ? `Keep and reapply the ${preview.exclude.length} saved repository exclusion patterns during the index refresh. Inherited rules also apply.` : "The saved exclusion patterns are unchanged. This proposal does not include an index refresh; see the pending-update details below."} />)}
    <Notice theme={theme} text={preview.writesConfig ? `Save to ${preview.before.configPath}. A backup is created before replacement.` : "The configured values are already saved."} />
    {preview.warnings.map((warning, index) => <Notice key={index} theme={theme} text={warning} />)}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action title={repair ? "Confirm repair & refresh index" : preview.rebuildsIndex ? preview.writesConfig ? "Confirm save & refresh index" : "Confirm index refresh" : preview.writesConfig ? "Confirm save & reload config" : "Confirm reload & verify"} icon="Check" primary theme={theme} disabled={locked} onPress={onConfirm} />
      <Action title={repair ? "Keep current configuration" : "Discard preview"} theme={theme} disabled={locked} onPress={onCancel} />
    </View>
  </View>;
}
