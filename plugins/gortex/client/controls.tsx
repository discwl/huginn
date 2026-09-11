import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type PluginTheme = PluginSurfaceProps["theme"];
type Tone = "neutral" | "success" | "warning" | "danger";
function toneColor(theme: PluginTheme, tone: Tone) {
  return tone === "success" ? theme.colors.statusSuccess : tone === "warning" ? theme.colors.statusWarning : tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
}

export function Action({ title, onPress, theme, disabled = false, selected = false, icon, primary = false }: { title: string; onPress: () => void; theme: PluginTheme; disabled?: boolean; selected?: boolean; icon?: string; primary?: boolean }) {
  const [focused, setFocused] = useState(false);
  const color = primary ? theme.colors.accentForeground : selected ? theme.colors.accent : theme.colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 44, maxWidth: "100%", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: focused || selected || primary ? theme.colors.accent : theme.colors.border, backgroundColor: primary ? theme.colors.accent : pressed || selected ? theme.colors.surface2 : theme.colors.surface1, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
    {icon && <Icon name={icon} size={16} color={color} />}
    <Text style={{ color, fontSize: 13, lineHeight: 19, fontWeight: "600", flexShrink: 1 }}>{title}</Text>
  </Pressable>;
}

export function Button({ title, onPress, theme, disabled = false, selected = false }: { title: string; onPress: () => void; theme: PluginTheme; disabled?: boolean; selected?: boolean }) {
  return <Action title={title} onPress={onPress} theme={theme} disabled={disabled} selected={selected} />;
}

export function Card({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <View style={{ gap: 18, padding: 20, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, minWidth: 0 }}>{children}</View>;
}

export function Notice({ theme, text, error = false }: { theme: PluginTheme; text: string; error?: boolean }) {
  return <Text accessibilityRole={error ? "alert" : "text"} style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{text}</Text>;
}

export function Badge({ theme, label, tone = "neutral", icon }: { theme: PluginTheme; label: string; tone?: Tone; icon?: string }) {
  const color = toneColor(theme, tone);
  return <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, backgroundColor: theme.colors.surface2, maxWidth: "100%" }}>
    {icon && <Icon name={icon} size={13} color={color} />}
    <Text style={{ color, fontSize: 11, lineHeight: 16, fontWeight: "600", flexShrink: 1 }}>{label}</Text>
  </View>;
}

export function Metric({ theme, label, value, icon, detail, tone = "neutral" }: { theme: PluginTheme; label: string; value: string | number; icon: string; detail?: string; tone?: Tone }) {
  return <View style={{ flexGrow: 1, flexBasis: 150, minWidth: 130, gap: 9, padding: 15, borderRadius: 12, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name={icon} size={15} color={toneColor(theme, tone)} /><Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, flexShrink: 1 }}>{label}</Text></View>
    <Text style={{ color: tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 25, lineHeight: 32, fontWeight: "600" }}>{value}</Text>
    {detail && <Notice theme={theme} text={detail} />}
  </View>;
}

export function SectionHeading({ theme, title, subtitle, icon }: { theme: PluginTheme; title: string; subtitle?: string; icon?: string }) {
  return <View style={{ gap: 5, flexShrink: 1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>{icon && <Icon name={icon} size={18} color={theme.colors.accent} />}<Text style={{ color: theme.colors.foreground, fontSize: 17, lineHeight: 24, fontWeight: "600", flexShrink: 1 }}>{title}</Text></View>
    {subtitle && <Notice theme={theme} text={subtitle} />}
  </View>;
}

export function Disclosure({ theme, title, open, onToggle, children }: { theme: PluginTheme; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: open ? 12 : 0, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 5 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={onToggle} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44, paddingHorizontal: 2, borderRadius: 6, backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.surface1 })}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>{title}</Text><Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={theme.colors.foregroundMuted} />
    </Pressable>
    {open && children}
  </View>;
}
