import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTabState, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { inspectRpc } from "../shared/contracts.ts";
import { inspectionSearchContext, inspectorScope, inspectorTabSchema, scopedInspectorState, workspaceInspectionSummary } from "../shared/workspace-inspector.ts";
import { Action, Card, Notice, SectionHeading } from "./controls.tsx";
import { SymbolSearch } from "./symbol-search.tsx";

export function WorkspaceInspector({ host, workspaceId, theme, layout, tab, revision }: PluginWorkspacePanelProps) {
  const path = useWorkspace(workspaceId, workspace => workspace.directory) ?? "";
  const scope = inspectorScope(host.id, workspaceId, path);
  const [saved, setSaved] = useTabState(tab, inspectorTabSchema, { scope, section: "context", search: { query: "", selection: null } });
  const state = scopedInspectorState(saved, scope);
  const inspect = useRpc(inspectRpc);
  const query = useQuery({
    queryKey: ["gortex-workspace-inspector", host.id, workspaceId, path, revision],
    queryFn: () => inspect({ path }), enabled: Boolean(path),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const inspection = query.data;
  const summary = inspection ? workspaceInspectionSummary(inspection) : null;
  const searchContext = inspection && !query.isError ? inspectionSearchContext(inspection) : null;
  const text = { color: theme.colors.foreground, fontSize: 13, lineHeight: 20 };
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 16 }}>
    <SectionHeading theme={theme} title="Workspace inspector" subtitle={`Gortex on ${host.label}`} icon="Network" />
    <Text selectable style={text}>{path || "Waiting for this workspace's directory…"}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action theme={theme} title="Context" selected={state.section === "context"} onPress={() => setSaved({ ...state, section: "context" })} />
      <Action theme={theme} title="Symbols" selected={state.section === "search"} onPress={() => setSaved({ ...state, section: "search" })} />
      <Action theme={theme} title="Diagnostic details" selected={state.section === "details"} onPress={() => setSaved({ ...state, section: "details" })} />
      <Action theme={theme} title={query.isFetching ? "Inspecting…" : "Refresh"} icon="RefreshCw" disabled={!path || query.isFetching} onPress={() => { void query.refetch(); }} />
    </View>
    {query.error && <Notice theme={theme} error text={query.error instanceof Error ? query.error.message : "Workspace inspection failed."} />}
    {inspection && summary && <Card theme={theme}>
      <SectionHeading theme={theme} title={summary.label} subtitle={summary.detail} />
      {state.section === "context" ? <>
        <Text selectable style={text}>Workspace directory: {inspection.canonicalPath}</Text>
        <Text selectable style={text}>Git root: {inspection.repositoryRoot ?? "Not established"}</Text>
        <Text selectable style={text}>Gortex repository: {inspection.repository?.name ?? "Not established"}</Text>
        <Text selectable style={text}>Gortex workspace: {inspection.repository?.workspaceId ?? "Not established"}</Text>
        <Text selectable style={text}>Graph: {inspection.repository?.graphName ?? "Not established"}</Text>
        <Notice theme={theme} text={`Observed: ${inspection.observedAt}. Use Refresh for a new observation.`} />
      </> : state.section === "details" ? <>
        {inspection.warnings.map((warning, index) => <Notice key={index} theme={theme} text={warning} />)}
        <Text selectable style={{ ...text, fontFamily: "monospace" }}>{JSON.stringify(inspection, null, 2)}</Text>
      </> : searchContext ? <SymbolSearch key={scope} host={host} theme={theme} context={searchContext} limit={50} initialState={state.search} onPersist={search => setSaved({ ...state, search })} /> : <Notice theme={theme} text="Symbol search is unavailable until this exact directory has a verified repository context. Worktrees and unresolved paths are not redirected to a primary checkout." />}
    </Card>}
    <Notice theme={theme} text="Read-only inspection of this workspace. Indexing and repository administration remain in the Gortex library." />
  </ScrollView>;
}
