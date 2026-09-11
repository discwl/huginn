import { useEffect, useReducer, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { searchRpc, symbolRpc } from "../shared/contracts.ts";
import type { RepositoryContext } from "../shared/models.ts";
import { emptyNavigation, navigateInspector } from "../shared/inspector-navigation.ts";
import { Action, Badge, Notice } from "./controls.tsx";
import { SymbolInspector } from "./symbol-inspector.tsx";

export function SymbolSearch({ theme, host, context, limit }: Pick<PluginSurfaceProps, "theme" | "host"> & { context: RepositoryContext; limit: number }) {
  const search = useRpc(searchRpc), inspect = useRpc(symbolRpc);
  const [draft, setDraft] = useState(""), [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null), [previousPages, setPreviousPages] = useState<(string | null)[]>([]);
  const [navigation, navigate] = useReducer(navigateInspector, emptyNavigation);
  const [focused, setFocused] = useState(false), [focusedResult, setFocusedResult] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const wide = width >= 820;
  const location = navigation.current, symbolId = location?.symbol.id ?? null, operation = location?.operation ?? "source";
  useEffect(() => { const timer = setTimeout(() => { setQuery(draft.trim()); setCursor(null); setPreviousPages([]); navigate({ type: "reset" }); }, 300); return () => clearTimeout(timer); }, [draft]);
  const results = useQuery({ queryKey: [host.id, "gortex", context.workspaceId, context.repositoryPath, "symbols", query, cursor, limit], queryFn: () => search({ ...context, query, cursor, limit }), enabled: query.length > 0, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const snapshot = useQuery({ queryKey: [host.id, "gortex", context.workspaceId, context.repositoryPath, "visual-inspector-v2", symbolId, operation], queryFn: () => inspect({ ...context, symbolId: symbolId!, operation }), enabled: symbolId !== null && draft.trim() === query, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const currentResults = draft.trim() === query && query && !results.isError ? results.data : undefined;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: 16, minWidth: 0 }}>
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, borderWidth: 1, borderRadius: 12, borderColor: focused ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface0 }}>
        <Icon name="Search" size={18} color={theme.colors.foregroundMuted} />
        <TextInput accessibilityLabel="Search indexed symbols" value={draft} onChangeText={setDraft} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder="Find a function, class, type or code concept…" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minWidth: 0, minHeight: 48, paddingVertical: 12, color: theme.colors.foreground, fontSize: 14 }} />
      </View>
      <Notice theme={theme} text={`Search this repository in ${context.workspaceId}. Follow related symbols, then use Back to return.`} />
    </View>
    {!draft.trim() && <View style={{ paddingVertical: 32, alignItems: "center", gap: 10 }}><Icon name="Braces" size={30} color={theme.colors.accent} /><Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>Explore the code behind a symbol</Text><Notice theme={theme} text="Read source, follow callers and dependencies, or inspect its impact." /></View>}
    {results.isFetching && <Notice theme={theme} text="Searching the native index…" />}
    {results.error && <Notice theme={theme} error text={results.error.message} />}
    <View style={{ flexDirection: wide ? "row" : "column", alignItems: "stretch", gap: 20, minWidth: 0 }}>
      {currentResults && <View style={{ width: wide ? 270 : undefined, flexShrink: 0, gap: 10, minWidth: 0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}><Badge theme={theme} label={`${currentResults.results.length} results`} icon="ListFilter" />{currentResults.truncated && <Badge theme={theme} label="Partial results" tone="warning" />}</View>
        {currentResults.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}
        {currentResults.results.length === 0 && <Notice theme={theme} text="No indexed symbols found for this search and scope." />}
        {currentResults.results.length > 0 && <ScrollView nestedScrollEnabled style={{ maxHeight: wide ? 650 : 260, borderWidth: 1, borderRadius: 12, borderColor: theme.colors.border }}>
          {currentResults.results.map(symbol => <Pressable key={symbol.id} accessibilityRole="button" accessibilityLabel={`Inspect ${symbol.name}, ${symbol.kind}`} accessibilityState={{ selected: symbolId === symbol.id }} onPress={() => navigate({ type: "select", root: true, symbol: { id: symbol.id, name: symbol.name, kind: symbol.kind, filePath: symbol.file_path, line: symbol.start_line && symbol.start_line > 0 ? symbol.start_line : null } })} onFocus={() => setFocusedResult(symbol.id)} onBlur={() => setFocusedResult(null)} style={({ pressed }) => ({ padding: 12, gap: 7, minHeight: 76, backgroundColor: symbolId === symbol.id || pressed ? theme.colors.surface2 : theme.colors.surface0, borderBottomWidth: 1, borderBottomColor: theme.colors.border, borderLeftWidth: 3, borderLeftColor: focusedResult === symbol.id || symbolId === symbol.id ? theme.colors.accent : theme.colors.surface0 })}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name={symbol.kind === "file" ? "FileCode2" : "Braces"} size={15} color={symbolId === symbol.id ? theme.colors.accent : theme.colors.foregroundMuted} /><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{symbol.name}</Text></View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Badge theme={theme} label={symbol.kind} />{symbol.start_line ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Line {symbol.start_line}</Text> : null}</View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>{symbol.file_path}</Text>
          </Pressable>)}
        </ScrollView>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {previousPages.length > 0 && <Action theme={theme} title="Previous page" icon="ChevronLeft" onPress={() => { setCursor(previousPages.at(-1)!); setPreviousPages(previousPages.slice(0, -1)); }} />}
          {currentResults.nextCursor && <Action theme={theme} title="Next page" icon="ChevronRight" onPress={() => { setPreviousPages([...previousPages, cursor]); setCursor(currentResults.nextCursor); }} />}
        </View>
      </View>}
      {location && draft.trim() === query ? <View style={{ flex: 1, minWidth: 0, borderLeftWidth: wide ? 1 : 0, borderTopWidth: wide ? 0 : 1, paddingLeft: wide ? 18 : 0, paddingTop: wide ? 0 : 18, borderColor: theme.colors.border }}>
        <SymbolInspector key={`${symbolId}:${operation}`} theme={theme} location={location} snapshot={snapshot.data} loading={snapshot.isFetching} error={snapshot.error} onTab={operation => navigate({ type: "tab", operation })} onSelect={symbol => navigate({ type: "select", symbol })} onBack={() => navigate({ type: "back" })} onForward={() => navigate({ type: "forward" })} canBack={navigation.back.length > 0} canForward={navigation.forward.length > 0} onRefresh={() => { void snapshot.refetch(); }} />
      </View> : currentResults && wide ? <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 10, padding: 24, minHeight: 260, borderWidth: 1, borderRadius: 12, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}><Icon name="MousePointer2" color={theme.colors.accent} size={26} /><Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>Choose a symbol to inspect</Text><Notice theme={theme} text="Source and relationships will appear here. Your search stays in view." /></View> : null}
    </View>
  </View>;
}
