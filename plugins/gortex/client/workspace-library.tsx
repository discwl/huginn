import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { catalogRpc, preferences, statusRpc } from "../shared/contracts.ts";
import { decodePaseoProjects, emptyCatalogFilters, type CatalogFilters } from "../shared/catalog-browser.ts";
import { RepositoryTrackDialog } from "./repository-track-dialog.tsx";
import type { Repository } from "../shared/models.ts";
import { SymbolSearch } from "./symbol-search.tsx";
import { HostHealth } from "./host-health.tsx";
import { NativeFolderButton, SelectedNativeFolder } from "./native-folder-picker.tsx";
import { RepositoryNavigator, repositoryPageSize } from "./repository-navigator.tsx";
import { RepositoryOverview } from "./repository-overview.tsx";
import { RepositoryMetadata } from "./repository-metadata.tsx";
import { Action, Badge, Card, Notice, SectionHeading } from "./controls.tsx";

import { RepositoryUntrackDialog } from "./repository-untrack-dialog.tsx";

export function LibrarySurface(props: PluginSurfaceProps) { return <HostLibrary key={props.host.id} {...props} />; }

function HostLibrary({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const listCatalog = useRpc(catalogRpc), indexStatus = useRpc(statusRpc);
  const paseo = usePaseo(), settings = useSettings(preferences);
  const scroll = useRef<ScrollView>(null);
  const libraryScroll = useRef(0), restoreScroll = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [section, setSection] = useState<"repositories" | "health">("repositories");
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<CatalogFilters>(emptyCatalogFilters);
  const [query, setQuery] = useState("");
  const [repository, setRepository] = useState<Repository | null>(null);
  const [untrackRepository, setUntrackRepository] = useState<Repository | null>(null);
  const [indexRepositoryTarget, setIndexRepositoryTarget] = useState<{ name: string; path: string } | null>(null);
  const [repositoryChanged, setRepositoryChanged] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [tab, setTab] = useState<"search" | "settings">("search");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const compact = layout.compact || width < 1040;
  useEffect(() => { const timer = setTimeout(() => setQuery(filters.query.trim()), 250); return () => clearTimeout(timer); }, [filters.query]);
  const queryCurrent = query === filters.query.trim();
  const paseoProjects = useQuery({
    queryKey: [host.id, "gortex", "paseo-projects-v1"],
    queryFn: async () => {
      if (typeof paseo.projects?.list !== "function") throw new Error("Update Paseo on this host to list its projects.");
      return decodePaseoProjects(await paseo.projects.list());
    },
    enabled: section === "repositories" && repository === null,
    retry: false, staleTime: 0, refetchOnWindowFocus: false,
  });
  const projectCandidates = paseoProjects.isError ? [] : paseoProjects.data?.projects ?? [];
  const catalog = useQuery({
    queryKey: [host.id, "gortex", "catalog-browser-v3", query, filters.workspace, filters.project, filters.sort, offset, projectCandidates],
    queryFn: () => listCatalog({ ...filters, query, offset, limit: repositoryPageSize, paseoProjects: projectCandidates }),
    enabled: section === "repositories" && repository === null && queryCurrent && paseoProjects.isFetched,
    placeholderData: keepPreviousData, retry: false, staleTime: 0, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    // Reconcile a clamped page after native cleanup removes the last row on a page.
    if (!catalog.isFetching && !catalog.isPlaceholderData && !catalog.isError && queryCurrent && catalog.data && catalog.data.offset !== offset) setOffset(catalog.data.offset);
  }, [catalog.isFetching, catalog.isPlaceholderData, catalog.isError, catalog.data, queryCurrent, offset]);
  // Host health has its own unfiltered context lookup; library filters must not hide or re-scope this report.
  const healthCatalog = useQuery({
    queryKey: [host.id, "gortex", "host-index-context-v2"],
    queryFn: () => listCatalog({ offset: 0, limit: repositoryPageSize }),
    enabled: section === "health" && !(repository?.state === "resolved" && !repositoryChanged), retry: false, staleTime: 0, refetchOnWindowFocus: false,
  });
  const indexRepository = repository?.state === "resolved" && !repositoryChanged ? repository : healthCatalog.isError ? undefined : healthCatalog.data?.repositories.find(repo => repo.state === "resolved" && repo.workspaceId);
  const indexContext = indexRepository?.workspaceId ? { workspaceId: indexRepository.workspaceId, repositoryPath: indexRepository.path } : null;
  const status = useQuery({
    queryKey: [host.id, "gortex", "host-index", indexContext?.workspaceId, indexContext?.repositoryPath],
    queryFn: () => indexStatus(indexContext!), enabled: section === "health" && indexContext !== null,
    retry: false, refetchOnWindowFocus: false, staleTime: 0,
  });
  const context = !repositoryChanged && repository?.state === "resolved" && repository.workspaceId ? { repositoryPath: repository.path, workspaceId: repository.workspaceId } : null;
  const version = catalog.data?.version ?? healthCatalog.data?.version;
  async function refreshLibrary() {
    const refreshed = await paseoProjects.refetch();
    const nextCandidates = refreshed.isError ? [] : refreshed.data?.projects ?? [];
    // Changed projects already trigger the new catalog key; avoid fetching the old candidates again.
    if (JSON.stringify(nextCandidates) === JSON.stringify(projectCandidates)) await catalog.refetch();
  }
  function indexingChanged() {
    setRepository(null); setSelectedFolder(null); setSection("repositories");
    setFilters(emptyCatalogFilters); setQuery(""); setOffset(0);
    void catalog.refetch();
  }
  async function open(path: string) {
    if (!navigation) throw new Error("Workspace navigation is unavailable in this client.");
    const workspace = await paseo.workspaces.open(path);
    navigation.openWorkspace({ workspaceId: workspace.id });
  }
  function visit(repo: Repository, nextTab: typeof tab) {
    setRepository(repo); setRepositoryChanged(false); setTab(nextTab); setOpenError(null); restoreScroll.current = 0;
    scroll.current?.scrollTo({ y: 0, animated: false });
  }
  function back() {
    setRepository(null); setOpenError(null); restoreScroll.current = libraryScroll.current;
  }
  function changeFilters(next: CatalogFilters) { setFilters(next); setOffset(0); }
  function changeSection(next: typeof section) { setSection(next); restoreScroll.current = next === "repositories" && !repository ? libraryScroll.current : 0; scroll.current?.scrollTo({ y: 0, animated: false }); }
  return <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" onLayout={event => setWidth(event.nativeEvent.layout.width)} onScroll={event => { if (section === "repositories" && !repository && restoreScroll.current === null) libraryScroll.current = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100} onContentSizeChange={() => { if (restoreScroll.current !== null) { scroll.current?.scrollTo({ y: restoreScroll.current, animated: false }); restoreScroll.current = null; } }} style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24 }}>
    <View style={{ width: "100%", maxWidth: 1440, alignSelf: "center", gap: 16, minWidth: 0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center", flexShrink: 1 }}>
          <View style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: theme.colors.surface2 }}><Icon name="Network" size={22} color={theme.colors.accent} /></View>
          <View style={{ gap: 3, flexShrink: 1 }}><View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}><Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 25, lineHeight: 31, fontWeight: "700" }}>Gortex</Text>{version && <Badge theme={theme} label={version.replace(/^gortex\s+/, "")} />}</View><Notice theme={theme} text={`Native code intelligence on ${host.label}`} /></View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {section === "repositories" && !repository && <Action title={catalog.isFetching ? "Refreshing…" : "Refresh"} icon="RefreshCw" theme={theme} disabled={catalog.isFetching || paseoProjects.isFetching || !queryCurrent} onPress={() => { void refreshLibrary(); }} />}
          <NativeFolderButton host={host} theme={theme} initialPath={repository?.path} onSelected={setSelectedFolder} />
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <Action title="Repositories" icon="Library" theme={theme} selected={section === "repositories"} onPress={() => changeSection("repositories")} />
        <Action title="Host health" icon="Activity" theme={theme} selected={section === "health"} onPress={() => changeSection("health")} />
      </View>
      <HostHealth host={host} theme={theme} compact={section !== "health"} onDetails={() => changeSection("health")} />
      {selectedFolder && <View style={{ gap: 8 }}><Action theme={theme} title="Close folder selection" icon="X" onPress={() => setSelectedFolder(null)} /><SelectedNativeFolder key={selectedFolder} host={host} theme={theme} path={selectedFolder} onOpen={navigation ? open : undefined} onIndex={path => setIndexRepositoryTarget({ path, name: path.split(/[\\/]/).filter(Boolean).pop() || path })} /></View>}
      <View style={{ display: section === "repositories" && !repository ? "flex" : "none", minWidth: 0 }}>
        {paseoProjects.error && <Notice theme={theme} error text={`Paseo projects unavailable: ${paseoProjects.error.message} Gortex’s native catalog is shown separately.`} />}
        {paseoProjects.data?.partial && <Notice theme={theme} text="Showing the first 500 Paseo projects from this host. The native Gortex catalog remains complete." />}
        <RepositoryNavigator theme={theme} compact={compact} catalog={catalog.data} filters={filters} loading={paseoProjects.isPending || catalog.isFetching || catalog.isPlaceholderData || !queryCurrent} error={queryCurrent ? catalog.error : null} onFilters={changeFilters} onRepository={repo => visit(repo, "search")} onMetadata={repo => visit(repo, "settings")} onUntrack={setUntrackRepository} onIndex={setIndexRepositoryTarget} onPage={next => { setOffset(next); restoreScroll.current = 0; scroll.current?.scrollTo({ y: 0, animated: false }); }} />
      </View>
      {section === "repositories" && repository && <View style={{ gap: 14, minWidth: 0 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}><Action title="All repositories" icon="ArrowLeft" theme={theme} onPress={back} /><Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} /><Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>{repository.name}</Text></View>
        <Card theme={theme}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <View style={{ gap: 7, flexShrink: 1 }}><SectionHeading theme={theme} title={repository.name} icon="FolderGit2" /><Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{repository.path}</Text></View>
            {navigation && <Action title={opening ? "Opening…" : "Open in Paseo"} icon="ArrowUpRight" theme={theme} disabled={opening} onPress={() => { setOpening(true); setOpenError(null); void open(repository.path).catch(error => setOpenError(error instanceof Error ? error.message : "Workspace open failed.")).finally(() => setOpening(false)); }} />}
          </View>
          {context ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}><Badge theme={theme} label={`Workspace: ${context.workspaceId}`} icon="Layers" /><Badge theme={theme} label={`Project: ${repository.projectId || "not set"}`} icon="FolderKanban" /><Badge theme={theme} label={`Graph: ${repository.graphName}`} icon="Network" /></View> : <Notice theme={theme} error={!repositoryChanged} text={repositoryChanged ? "Repository settings changed. Return to All repositories to reload its active context; the save outcome is shown below." : repository.error ?? "The active graph context is unavailable. Review repository settings."} />}
          {repository.graphName && repository.name !== repository.graphName && <Notice theme={theme} text="The configured name differs from the active graph. Review Repository settings to resolve the mismatch." />}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Action title="Search & inspect" icon="Search" theme={theme} selected={tab === "search"} disabled={!context} onPress={() => setTab("search")} />
            <Action title="Repository settings" icon="Settings2" theme={theme} selected={tab === "settings"} onPress={() => setTab("settings")} />
          </View>
          {openError && <Notice theme={theme} error text={openError} />}
          {context && <View style={{ display: tab === "search" ? "flex" : "none", minWidth: 0 }}>
            {settings.status !== "ready" && <Notice theme={theme} text="Using the default limit of 50 results while search preferences are unavailable." />}
            <SymbolSearch key={`${context.workspaceId}:${context.repositoryPath}`} theme={theme} host={host} context={context} limit={settings.status === "ready" ? settings.values.searchLimit : 50} />
          </View>}
        </Card>
        {tab === "settings" && <RepositoryMetadata key={repository.path} path={repository.path} host={host} theme={theme} onClose={() => context ? setTab("search") : back()} onChanged={() => setRepositoryChanged(true)} />}
      </View>}
      {section === "health" && <Card theme={theme}>
        {healthCatalog.isFetching && !healthCatalog.data && <Notice theme={theme} text="Connecting to the host index…" />}
        {healthCatalog.error && <Notice theme={theme} error text={`Host index connection unavailable: ${healthCatalog.error.message}`} />}
        {indexContext ? <RepositoryOverview theme={theme} report={status.data} loading={status.isFetching} error={status.error} onRefresh={() => { void status.refetch(); }} /> : !healthCatalog.isFetching && !healthCatalog.isError && <View style={{ gap: 12 }}><SectionHeading title="Host index health" icon="Database" theme={theme} /><Notice theme={theme} text="A reachable indexed repository is required to read this report. The catalog page did not provide one; daemon health remains available above." /><Action theme={theme} title="Retry index connection" icon="RefreshCw" onPress={() => { void healthCatalog.refetch(); }} /></View>}
      </Card>}
      {indexRepositoryTarget && <RepositoryTrackDialog key={`${host.id}:${indexRepositoryTarget.path}`} host={host} theme={theme} name={indexRepositoryTarget.name} path={indexRepositoryTarget.path} onClose={() => setIndexRepositoryTarget(null)} onChanged={indexingChanged} />}
      {untrackRepository && <RepositoryUntrackDialog key={`${host.id}:${untrackRepository.path}`} host={host} theme={theme} name={untrackRepository.name} path={untrackRepository.path} onClose={() => setUntrackRepository(null)} onChanged={() => setRepositoryChanged(true)} />}
    </View>
  </ScrollView>;
}
