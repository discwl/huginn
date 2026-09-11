import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { catalogRpc, preferences, statusRpc } from "../shared/contracts.ts";
import { chooseWorkspace, chooseRepository, selectedRepository, type LibrarySelection } from "../shared/selection.ts";
import { SymbolSearch } from "./symbol-search.tsx";
import { HostHealth } from "./host-health.tsx";
import { NativeFolderButton, SelectedNativeFolder } from "./native-folder-picker.tsx";
import { RepositoryNavigator } from "./repository-navigator.tsx";
import { RepositoryOverview } from "./repository-overview.tsx";
import { RepositoryMetadata } from "./repository-metadata.tsx";
import { Action, Badge, Card, Notice, SectionHeading } from "./controls.tsx";

export function LibrarySurface(props: PluginSurfaceProps) { return <HostLibrary key={props.host.id} {...props} />; }

function HostLibrary({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const listCatalog = useRpc(catalogRpc);
  const indexStatus = useRpc(statusRpc);
  const paseo = usePaseo();
  const settings = useSettings(preferences);
  const scroll = useRef<ScrollView>(null);
  const focusTools = useRef(false);
  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<LibrarySelection>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [metadataPath, setMetadataPath] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "search">("overview");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const stacked = layout.compact || width < 980;
  const catalog = useQuery({ queryKey: [host.id, "gortex", "catalog", offset], queryFn: () => listCatalog({ offset }), retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const allRepositories = catalog.isError ? [] : catalog.data?.repositories ?? [];
  const workspaceIds = [...new Set(allRepositories.flatMap(repo => repo.workspaceId ? [repo.workspaceId] : []))];
  const selectedWorkspace = selection && workspaceIds.includes(selection.workspaceId) ? selection.workspaceId : null;
  const repository = selectedRepository(allRepositories, selection);
  const context = repository?.workspaceId ? { repositoryPath: repository.path, workspaceId: repository.workspaceId } : null;
  const status = useQuery({ queryKey: [host.id, "gortex", "index", context?.workspaceId, context?.repositoryPath], queryFn: () => indexStatus(context!), enabled: context !== null && tab === "overview", retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  async function open(path: string) {
    if (!navigation) throw new Error("Workspace navigation is unavailable in this client.");
    const workspace = await paseo.workspaces.open(path);
    navigation.openWorkspace({ workspaceId: workspace.id });
  }
  function select(next: LibrarySelection) {
    focusTools.current = stacked && !!next?.repositoryPath;
    if (stacked && next?.repositoryPath && next.repositoryPath === selection?.repositoryPath) {
      scroll.current?.scrollToEnd({ animated: true });
      focusTools.current = false;
    }
    setSelection(next); setTab("overview"); setOpenError(null); setMetadataPath(null);
  }
  return <ScrollView ref={scroll} onLayout={event => setWidth(event.nativeEvent.layout.width)} onContentSizeChange={() => { if (focusTools.current && context) { scroll.current?.scrollToEnd({ animated: true }); focusTools.current = false; } }} style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 28 }}>
    <View style={{ width: "100%", maxWidth: 1320, alignSelf: "center", gap: 20, minWidth: 0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, paddingVertical: 4 }}>
        <View style={{ flexDirection: "row", gap: 13, alignItems: "center", flexShrink: 1 }}>
          <View style={{ width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border }}><Icon name="Network" size={25} color={theme.colors.accent} /></View>
          <View style={{ gap: 4, flexShrink: 1 }}><View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}><Text style={{ color: theme.colors.foreground, fontSize: 28, lineHeight: 34, fontWeight: "700" }}>Gortex</Text>{catalog.data && !catalog.isError && <Badge theme={theme} label={catalog.data.version.replace(/^gortex\s+/, "")} />}</View><Notice theme={theme} text={`Native code intelligence on ${host.label}`} /></View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
          <Action title={catalog.isFetching ? "Refreshing…" : "Refresh repositories"} icon="RefreshCw" theme={theme} disabled={catalog.isFetching} onPress={() => { void catalog.refetch(); }} />
          <NativeFolderButton host={host} theme={theme} initialPath={context?.repositoryPath} onSelected={setSelectedFolder} />
        </View>
      </View>
      <HostHealth host={host} theme={theme} />
      {selectedFolder && <SelectedNativeFolder key={selectedFolder} host={host} theme={theme} path={selectedFolder} onOpen={navigation ? open : undefined} />}
      {catalog.isFetching && !catalog.data && <Notice theme={theme} text="Loading native workspaces and repositories…" />}
      {catalog.error && <Notice theme={theme} error text={catalog.error.message} />}
      <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "flex-start", gap: 18 }}>
        <View style={stacked ? { width: "100%", minWidth: 0 } : { width: 290, flexShrink: 0 }}>
          {catalog.data && !catalog.isError && <RepositoryNavigator theme={theme} repositories={allRepositories} workspaceIds={workspaceIds} selectedWorkspace={selectedWorkspace} selectedPath={repository?.path} total={catalog.data.total} offset={offset} nextOffset={catalog.data.nextOffset} onWorkspace={id => select(chooseWorkspace(allRepositories, id))} onRepository={path => select(chooseRepository(allRepositories, path))} onMetadata={setMetadataPath} onPage={next => { setOffset(next); select(null); }} />}
        </View>
        <View style={stacked ? { width: "100%", minWidth: 0 } : { flex: 1, minWidth: 0 }}>
          {metadataPath ? <RepositoryMetadata key={metadataPath} path={metadataPath} host={host} theme={theme} onClose={() => setMetadataPath(null)} onChanged={() => { setSelection(null); void catalog.refetch(); }} /> : context ? <Card theme={theme}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
              <View style={{ gap: 8, flexShrink: 1 }}><SectionHeading theme={theme} title={repository!.name} icon="FolderGit2" /><Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{context.repositoryPath}</Text></View>
              {navigation && <Action title={opening ? "Opening…" : "Open in Paseo"} icon="ArrowUpRight" theme={theme} disabled={opening} onPress={() => { setOpening(true); setOpenError(null); void open(context.repositoryPath).catch(error => setOpenError(error instanceof Error ? error.message : "Workspace open failed.")).finally(() => setOpening(false)); }} />}
            </View>
            <Notice theme={theme} text={`Active graph: ${repository!.graphName} · Workspace: ${context.workspaceId} · Project: ${repository!.projectId || "not set"}`} />
            {repository!.name !== repository!.graphName && <Notice theme={theme} text="The configured name differs from the active graph. Repository settings shows both values; queries use the active identity above." />}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignSelf: "flex-start", gap: 5, padding: 4, borderRadius: 12, backgroundColor: theme.colors.surface0 }}>
              <Action title="Host index" icon="LayoutDashboard" theme={theme} selected={tab === "overview"} onPress={() => setTab("overview")} />
              <Action title="Search & inspect" icon="Search" theme={theme} selected={tab === "search"} onPress={() => setTab("search")} />
            </View>
            {openError && <Notice theme={theme} error text={openError} />}
            {tab === "overview" ? <RepositoryOverview key={`${context.workspaceId}:${context.repositoryPath}`} theme={theme} report={status.data} loading={status.isFetching} error={status.error} onRefresh={() => { void status.refetch(); }} /> : <>
              {settings.status !== "ready" && <Notice theme={theme} text="Using the default limit of 50 results while search preferences are unavailable." />}
              <SymbolSearch key={`${context.workspaceId}:${context.repositoryPath}`} theme={theme} host={host} context={context} limit={settings.status === "ready" ? settings.values.searchLimit : 50} />
            </>}
          </Card> : <Card theme={theme}>
            <View style={{ alignItems: "center", justifyContent: "center", gap: 14, paddingVertical: 48, paddingHorizontal: 16 }}>
              <View style={{ padding: 16, borderRadius: 18, backgroundColor: theme.colors.surface2 }}><Icon name="FolderSearch" size={30} color={theme.colors.accent} /></View>
              <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "600", textAlign: "center" }}>Explore your codebase</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 21, maxWidth: 360, textAlign: "center" }}>Choose a workspace and repository to search symbols and follow code relationships. Host index health is shared across all repositories.</Text>
            </View>
          </Card>}
        </View>
      </View>
      <Notice theme={theme} text="Preview · Repository settings show configured and active daemon values. Tracking new repositories and exact checkout selection are still in development." />
    </View>
  </ScrollView>;
}
