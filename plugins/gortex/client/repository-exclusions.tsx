import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ExclusionSources } from "../shared/exclusions.ts";
import { Action, Disclosure, Notice, SectionHeading } from "./controls.tsx";

type Theme = PluginSurfaceProps["theme"];
export function PatternList({ theme, patterns, empty = "None configured" }: { theme: Theme; patterns: string[]; empty?: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? patterns : patterns.slice(0, 20);
  return <View style={{ gap: 8 }}>
    <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13, lineHeight: 21 }}>{shown.length ? shown.join("\n") : empty}</Text>
    {patterns.length > 20 && <Action theme={theme} title={expanded ? "Show fewer patterns" : `Show all ${patterns.length} patterns`} onPress={() => setExpanded(!expanded)} />}
  </View>;
}

export function ExclusionEditor({ theme, text, disabled, onChange }: { theme: Theme; text: string; disabled: boolean; onChange: (text: string) => void }) {
  return <View style={{ gap: 10 }}>
    <Notice theme={theme} text="One .gitignore-style pattern per line, using forward slashes. For example: **/bin/, **/obj/, generated/. Use !pattern to re-include a path. Order matters. Blank lines are ignored." />
    <TextInput accessibilityLabel="Repository exclusion patterns, one per line" multiline scrollEnabled value={text} editable={!disabled} autoCapitalize="none" autoCorrect={false} maxLength={67536} onChangeText={onChange} placeholder={"**/bin/\n**/obj/\ngenerated/"} placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 180, maxHeight: 360, textAlignVertical: "top", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0, padding: 12, color: theme.colors.foreground, fontFamily: "monospace", fontSize: 14, lineHeight: 22 }} />
    <Notice theme={theme} text="This edits only this repository’s exclude list in the host config. Clearing the list removes those rules; inherited rules remain. Saving never deletes source files." />
  </View>;
}

export function ExclusionSettings({ theme, patterns, sources }: { theme: Theme; patterns: string[]; sources: ExclusionSources }) {
  const [open, setOpen] = useState(false);
  const groups = [
    ["Host global exclusions", sources.global],
    ["Repository .gortex.yaml exclusions", sources.local],
    ["Legacy index.exclude", sources.legacyIndex],
    ["Legacy watch.exclude", sources.legacyWatch],
    ["Repository .gortex.yaml include (re-inclusions)", sources.include],
  ] as const;
  return <View style={{ gap: 12, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 18 }}>
    <SectionHeading theme={theme} title="Repository exclusions" icon="ListFilter" subtitle={`${patterns.length} configured ${patterns.length === 1 ? "pattern" : "patterns"} · This repository on this host`} />
    <PatternList theme={theme} patterns={patterns} empty="No repository-specific patterns. Inherited exclusions still apply." />
    <Notice theme={theme} text="These are saved rules. Use Preview index refresh to apply them to files already indexed. A saved list alone does not verify the current graph." />
    <Disclosure theme={theme} title="Inherited rules and precedence" open={open} onToggle={() => setOpen(!open)}>
      <Notice theme={theme} text="Gortex evaluates built-in rules, .gitignore, host global exclusions, this repository’s rules, then repository-local rules. Local include entries take precedence. This is a configuration view, not a complete per-file exclusion report." />
      {groups.map(([label, values]) => <View key={label} style={{ gap: 6 }}><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text><PatternList theme={theme} patterns={values} /></View>)}
      <Notice theme={theme} text={sources.respectGitignore ? "Respect .gitignore: enabled. Gortex evaluates applicable ignore files; their contents and built-in rules are not enumerated here." : "Respect .gitignore: disabled by .gortex.yaml. Built-in and configured rules still apply."} />
    </Disclosure>
  </View>;
}
