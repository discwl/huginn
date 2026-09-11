import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import { inspectorLabels, type InspectorOperation, type InspectorRow, type InspectorSymbol, type SymbolSnapshot } from "../shared/symbol-inspection.ts";
import type { InspectorLocation } from "../shared/inspector-navigation.ts";
import { Action, Badge, Disclosure, Notice } from "./controls.tsx";

type Theme = PluginSurfaceProps["theme"];
const mono = { fontFamily: "monospace", fontSize: 12, lineHeight: 21 } as const;
const tabIcons: Record<InspectorOperation, string> = { source: "Code2", callers: "ArrowDownLeft", dependencies: "ArrowUpRight", usages: "MapPin", implementations: "Shapes", impact: "GitBranch" };

function CodeBlock({ theme, code, fromLine, filePath }: { theme: Theme; code: string; fromLine: number | null; filePath: string }) {
  // Cosmetic highlighting only; displayed and copied source remains byte-for-byte text.
  const supportsHighlight = /\.(?:[cm]?[jt]sx?|cs|go|rs|java|py|json|ya?ml)$/.test(filePath);
  const tokens = supportsHighlight ? code.split(/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:export|import|from|const|let|var|function|async|await|return|class|interface|type|if|else|try|catch|finally|throw|new|for|of|in|while|public|private|static|void|extends|implements|null|undefined|true|false|def|func|package|struct)\b|\b\d+(?:\.\d+)?\b)/g) : [code];
  return <ScrollView nestedScrollEnabled style={{ maxHeight: 480, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
    <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ paddingVertical: 14, paddingRight: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        {fromLine !== null && <Text accessible={false} importantForAccessibility="no-hide-descendants" style={{ ...mono, color: theme.colors.foregroundMuted, textAlign: "right", paddingHorizontal: 14, marginRight: 14, borderRightWidth: 1, borderRightColor: theme.colors.border }}>{code.split("\n").map((_, index) => fromLine + index).join("\n")}</Text>}
        <Text selectable accessibilityLabel="Source code" style={{ ...mono, color: theme.colors.foreground, paddingLeft: fromLine === null ? 14 : 0 }}>{tokens.map((token, index) => <Text key={index} style={{ color: !supportsHighlight || index % 2 === 0 ? theme.colors.foreground : /^\/[/\*]/.test(token) ? theme.colors.foregroundMuted : /^["'`]/.test(token) ? theme.colors.statusSuccess : /^\d/.test(token) ? theme.colors.statusWarning : theme.colors.accent }}>{token}</Text>)}</Text>
      </View>
    </ScrollView>
  </ScrollView>;
}

function RelationshipCard({ theme, row, onSelect }: { theme: Theme; row: InspectorRow; onSelect: (symbol: InspectorSymbol) => void }) {
  const [focused, setFocused] = useState(false);
  const s = row.symbol;
  return <Pressable disabled={!s.navigable} accessibilityRole={s.navigable ? "button" : "text"} accessibilityLabel={`${s.navigable ? "Inspect" : "Result"} ${s.name}, ${s.kind}, ${s.filePath}`} onPress={() => onSelect(s)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ gap: 8, padding: 13, borderRadius: 11, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.border, backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface0 })}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
      <Icon name={s.kind === "file" ? "FileCode2" : "Braces"} color={s.navigable ? theme.colors.accent : theme.colors.foregroundMuted} size={16} />
      <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{s.name}</Text>
      <Badge theme={theme} label={s.kind} />
      {s.navigable && <Icon name="ChevronRight" color={theme.colors.foregroundMuted} size={16} />}
    </View>
    <Text style={{ ...mono, fontSize: 11, color: theme.colors.foregroundMuted }}>{s.filePath}{s.line ? `:${s.line}` : ""}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Repository: {s.repository ?? "not supplied"} · Workspace: {s.workspace ?? "not supplied"}</Text>
    {s.signature && <Text style={{ ...mono, fontSize: 11, color: theme.colors.foreground }}>{s.signature}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{row.relations.map(kind => <Badge key={kind} theme={theme} label={kind.replaceAll("_", " ")} />)}{row.evidence.map(evidence => <Badge key={evidence} theme={theme} label={evidence} />)}</View>
    {row.sites.length > 0 && <View style={{ gap: 3, borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 9 }}>
      {row.sites.map((site, index) => <Text key={index} style={{ ...mono, fontSize: 11, color: theme.colors.foregroundMuted }}>↳ {site.filePath}{site.line ? `:${site.line}` : ""}</Text>)}
      {row.siteCount > row.sites.length && <Notice theme={theme} text={`+ ${row.siteCount - row.sites.length} additional locations not shown`} />}
    </View>}
    {s.navigationNote && <Notice theme={theme} text={s.navigationNote} />}
  </Pressable>;
}

function groupTitle(operation: InspectorOperation, depth: number | null): string {
  if (depth === null) return "Other native results";
  if (operation === "implementations") return "Implementations";
  if (operation === "impact") return depth === 1 ? "1 step away" : `${depth} steps away`;
  if (depth === 1) return `Direct ${inspectorLabels[operation].toLowerCase()}`;
  return `${depth} steps away`;
}

export function SymbolInspector({ theme, location, snapshot, loading, error, onTab, onSelect, onBack, onForward, canBack, canForward, onRefresh }: {
  theme: Theme; location: InspectorLocation; snapshot?: SymbolSnapshot; loading: boolean; error: Error | null;
  onTab: (operation: InspectorOperation) => void; onSelect: (symbol: InspectorSymbol) => void;
  onBack: () => void; onForward: () => void; canBack: boolean; canForward: boolean; onRefresh: () => void;
}) {
  const [rawOpen, setRawOpen] = useState(false), [contextOpen, setContextOpen] = useState(false);
  const [filter, setFilter] = useState(""), [filterFocused, setFilterFocused] = useState(false), [copyStatus, setCopyStatus] = useState("");
  const data = !error ? snapshot?.inspection : undefined;
  const rows = data?.rows.filter(row => `${row.symbol.name} ${row.symbol.filePath} ${row.relations.join(" ")}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const groups = new Map<string, InspectorRow[]>();
  for (const row of rows) { const label = groupTitle(location.operation, row.depth); groups.set(label, [...(groups.get(label) ?? []), row]); }
  const selected = data?.source?.symbol ?? location.symbol;
  return <View style={{ flex: 1, minWidth: 0, gap: 14 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Action theme={theme} title="Back" icon="ArrowLeft" disabled={!canBack} onPress={onBack} />
      <Action theme={theme} title="Forward" icon="ArrowRight" disabled={!canForward} onPress={onForward} />
      <View style={{ flex: 1 }} />
      <Action theme={theme} title="Refresh evidence" icon="RefreshCw" disabled={loading} onPress={onRefresh} />
    </View>
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}><Text style={{ color: theme.colors.foreground, fontSize: 20, lineHeight: 27, fontWeight: "600", flexShrink: 1 }}>{selected.name}</Text><Badge theme={theme} label={selected.kind} /></View>
      <Text selectable style={{ ...mono, fontSize: 11, color: theme.colors.foregroundMuted }}>{selected.filePath}{selected.line ? `:${selected.line}` : ""}</Text>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{(Object.keys(inspectorLabels) as InspectorOperation[]).map(operation => <Action key={operation} theme={theme} title={inspectorLabels[operation]} icon={tabIcons[operation]} selected={location.operation === operation} onPress={() => onTab(operation)} />)}</View>
    {loading && <Notice theme={theme} text="Reading native evidence…" />}
    {error && <Notice theme={theme} error text={error.message} />}
    {data && snapshot && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
        {data.partial && <Badge theme={theme} label="Partial evidence" icon="TriangleAlert" tone="warning" />}
        {data.risk && <Badge theme={theme} label={`Native risk: ${data.risk}`} tone={/high|critical/i.test(data.risk) ? "danger" : "warning"} />}
        {!data.source && <Badge theme={theme} label={`${data.rows.length} symbols shown`} />}
        {data.facts.map(fact => <Badge key={fact.label} theme={theme} label={`${fact.label}: ${fact.value}`} />)}
      </View>
      {data.summary && <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }}>{data.summary}</Text>}
      {data.source ? <>
        {data.source.symbol.signature && <Text selectable style={{ ...mono, color: theme.colors.foreground, padding: 12, backgroundColor: theme.colors.surface2, borderRadius: 8 }}>{data.source.symbol.signature}</Text>}
        <CodeBlock theme={theme} code={data.source.code} fromLine={data.source.fromLine} filePath={data.source.symbol.filePath} />
      </> : <>
        {data.rows.length > 5 && <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 9, borderWidth: 1, borderColor: filterFocused ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface0 }}><Icon name="ListFilter" color={theme.colors.foregroundMuted} size={16} /><TextInput accessibilityLabel="Filter displayed relationships" value={filter} onChangeText={setFilter} onFocus={() => setFilterFocused(true)} onBlur={() => setFilterFocused(false)} autoCapitalize="none" autoCorrect={false} placeholder="Filter these results…" placeholderTextColor={theme.colors.foregroundMuted} style={{ flex: 1, minWidth: 0, minHeight: 44, color: theme.colors.foreground, fontSize: 13 }} /></View>}
        {rows.length > 0 ? <ScrollView nestedScrollEnabled style={{ maxHeight: 550 }} contentContainerStyle={{ gap: 17, paddingRight: 3 }}>
          {[...groups].map(([label, items]) => <View key={label} style={{ gap: 8 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ color: theme.colors.foregroundMuted, fontWeight: "600", fontSize: 12 }}>{label}</Text><Badge theme={theme} label={String(items.length)} /></View>{items.map(row => <RelationshipCard key={`${row.symbol.id}:${row.depth}`} theme={theme} row={row} onSelect={onSelect} />)}</View>)}
        </ScrollView> : <View style={{ padding: 24, alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 12, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}><Icon name={tabIcons[location.operation]} size={26} color={theme.colors.foregroundMuted} /><Notice theme={theme} text={filter ? "No displayed symbols match this filter." : data.partial ? "No items available in this partial response." : "No items returned by the native index. This does not establish complete coverage."} /></View>}
      </>}
      <View style={{ gap: 5 }}>{data.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}</View>
      <Notice theme={theme} text={`Workspace: ${snapshot.context.workspaceId} · Observed ${new Date(snapshot.observedAt).toLocaleTimeString()}`} />
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}><Action theme={theme} title="Copy displayed context" icon="Copy" onPress={() => { void copyText(snapshot.text).then(() => setCopyStatus("Copied source, visible evidence and provenance.")).catch(() => { setCopyStatus("Clipboard unavailable. Expand Context to copy and select the text."); setContextOpen(true); }); }} />{copyStatus && <Notice theme={theme} text={copyStatus} />}</View>
      <Disclosure theme={theme} title="Context to copy · scope and provenance" open={contextOpen} onToggle={() => setContextOpen(!contextOpen)}><ScrollView nestedScrollEnabled style={{ maxHeight: 260 }}><Text selectable style={{ ...mono, color: theme.colors.foreground }}>{snapshot.text}</Text></ScrollView></Disclosure>
      <Disclosure theme={theme} title="Raw native response · JSON" open={rawOpen} onToggle={() => setRawOpen(!rawOpen)}>{snapshot.rawTruncated && <Notice theme={theme} text="Raw response truncated at its display budget." />}<ScrollView nestedScrollEnabled style={{ maxHeight: 260 }}><ScrollView horizontal><Text selectable style={{ ...mono, color: theme.colors.foreground }}>{snapshot.raw}</Text></ScrollView></ScrollView></Disclosure>
    </>}
  </View>;
}
