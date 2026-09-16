import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Catalog, Repository } from "../shared/models.ts";
import { emptyCatalogFilters, type CatalogFilters } from "../shared/catalog-browser.ts";
import { Action, Badge, Card, Notice, SectionHeading } from "./controls.tsx";
import { PaseoProjectRow } from "./paseo-project-row.tsx";

type Props = {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  catalog?: Catalog;
  filters: CatalogFilters;
  loading: boolean;
  error?: Error | null;
  onFilters: (filters: CatalogFilters) => void;
  onRepository: (repository: Repository) => void;
  onMetadata: (repository: Repository) => void;
  onUntrack: (repository: Repository) => void;
  onIndex: (repository: Repository) => void;
  onPage: (offset: number) => void;
};
const pageSize = 12;
export const repositoryPageSize = pageSize;
const label = (value: string) => value || "Not set";

function RepositoryRow({ theme, repository, compact, onOpen, onSettings, onUntrack }: { theme: Props["theme"]; repository: Repository; compact: boolean; onOpen: () => void; onSettings: () => void; onUntrack: () => void }) {
  const [focused, setFocused] = useState<"row" | "settings" | "untrack" | null>(null);
  const available = repository.state === "resolved";
  return <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderColor: theme.colors.border, minWidth: 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${available ? "Explore" : "View settings for"} ${repository.name}, ${repository.path}, workspace ${label(repository.declaredWorkspace)}`} onPress={available ? onOpen : onSettings} onFocus={() => setFocused("row")} onBlur={() => setFocused(null)} style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, minHeight: compact ? 94 : 76, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: focused === "row" ? theme.colors.accent : "transparent", backgroundColor: pressed || focused === "row" ? theme.colors.surface2 : theme.colors.surface1 })}>
      {!compact && <View style={{ padding: 9, borderRadius: 10, backgroundColor: theme.colors.surface0 }}><Icon name="FolderGit2" size={18} color={theme.colors.accent} /></View>}
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{repository.name}</Text>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 17 }}>{repository.path}</Text>
        {compact && <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>{label(repository.declaredWorkspace)} · {label(repository.declaredProject)}</Text>}
        {compact && !available && <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>Code unavailable · Open settings</Text>}
      </View>
      {!compact && <>
        <Text numberOfLines={2} style={{ width: 150, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{label(repository.declaredWorkspace)}</Text>
        <Text numberOfLines={2} style={{ width: 130, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{label(repository.declaredProject)}</Text>
        <View style={{ width: 115 }}><Badge theme={theme} label={available ? "Available" : "Unavailable"} tone={available ? "success" : "warning"} icon={available ? "CheckCircle2" : "CircleAlert"} /></View>
      </>}
      <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`Repository settings for ${repository.name}, ${repository.path}`} onPress={onSettings} onFocus={() => setFocused("settings")} onBlur={() => setFocused(null)} style={({ pressed }) => ({ width: 44, height: 44, marginRight: 6, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: focused === "settings" ? theme.colors.accent : "transparent", backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1 })}><Icon name="Settings2" size={17} color={theme.colors.foregroundMuted} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`Untrack ${repository.name}, ${repository.path}`} accessibilityHint="Opens a confirmation explaining what Gortex will remove. Source files are kept." onPress={onUntrack} onFocus={() => setFocused("untrack")} onBlur={() => setFocused(null)} style={({ pressed }) => ({ width: 44, height: 44, marginRight: 6, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: focused === "untrack" ? theme.colors.statusDanger : "transparent", backgroundColor: pressed || focused === "untrack" ? theme.colors.surface2 : theme.colors.surface1 })}><Icon name="Trash2" size={17} color={theme.colors.statusDanger} /></Pressable>
  </View>;
}

export function RepositoryNavigator({ theme, compact, catalog, filters, loading, error, onFilters, onRepository, onMetadata, onUntrack, onIndex, onPage }: Props) {
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<"workspace" | "project" | "sort" | null>(null);
  const [optionQuery, setOptionQuery] = useState("");
  const filtered = !!filters.query || filters.workspace !== null || filters.project !== null;
  const menuOptions = menu === "sort" ? [
    { value: "name", count: null, title: "Repository name" },
    { value: "workspace", count: null, title: "Workspace" },
    { value: "project", count: null, title: "Project" },
  ] : menu ? (catalog?.[menu === "workspace" ? "workspaces" : "projects"] ?? []).map(option => ({ ...option, title: label(option.value) })) : [];
  const choices = menuOptions.filter(option => option.title.toLowerCase().includes(optionQuery.toLowerCase()));
  function toggle(next: typeof menu) { setMenu(current => current === next ? null : next); setOptionQuery(""); }
  function choose(value: string | null) {
    if (menu === "sort") onFilters({ ...filters, sort: value as CatalogFilters["sort"] });
    else if (menu) onFilters({ ...filters, [menu]: value });
    setMenu(null); setOptionQuery("");
  }
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <SectionHeading theme={theme} title="Repositories" subtitle="Gortex repositories and Paseo projects on this host." icon="Library" />
      {catalog && <Badge theme={theme} label={`${catalog.total} ${catalog.total === 1 ? "repository" : "repositories"} · ${catalog.workspaces.length} ${catalog.workspaces.length === 1 ? "workspace" : "workspaces"}`} />}
    </View>
    <View style={{ flexDirection: compact ? "column" : "row", gap: 10, alignItems: compact ? "stretch" : "center" }}>
      <View style={{ flex: compact ? undefined : 1, flexDirection: "row", alignItems: "center", minWidth: 0, paddingHorizontal: 12, gap: 9, borderRadius: 10, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface0 }}>
        <Icon name="Search" size={17} color={theme.colors.foregroundMuted} />
        <TextInput accessibilityLabel="Find repositories by name, path, workspace or project" value={filters.query} onChangeText={query => onFilters({ ...filters, query })} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder="Find a repository…" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} maxLength={200} style={{ flex: 1, minWidth: 0, minHeight: 46, color: theme.colors.foreground, fontSize: 14, paddingVertical: 10 }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flexShrink: 1 }}>
        <Action theme={theme} title={filters.workspace === null ? "All workspaces" : label(filters.workspace)} icon="Layers" selected={menu === "workspace" || filters.workspace !== null} onPress={() => toggle("workspace")} />
        <Action theme={theme} title={filters.project === null ? "All projects" : label(filters.project)} icon="FolderKanban" selected={menu === "project" || filters.project !== null} onPress={() => toggle("project")} />
        <Action theme={theme} title={`Sort: ${filters.sort}`} icon="ArrowDownAZ" selected={menu === "sort"} onPress={() => toggle("sort")} />
      </View>
    </View>
    {menu && <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, borderRadius: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}><Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{menu === "sort" ? "Sort repositories" : `Filter by configured ${menu}`}</Text><Action title="Close filter" icon="X" theme={theme} onPress={() => setMenu(null)} /></View>
      {menu !== "sort" && <TextInput accessibilityLabel={`Find ${menu} options`} value={optionQuery} onChangeText={setOptionQuery} placeholder={`Find a ${menu}…`} placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 44, padding: 10, color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 }} />}
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 210 }} contentContainerStyle={{ gap: 5 }}>
        {menu !== "sort" && <Action theme={theme} title={`All ${menu === "workspace" ? "workspaces" : "projects"}`} selected={filters[menu] === null} onPress={() => choose(null)} />}
        {choices.map(option => <Action key={option.value} theme={theme} title={`${option.title}${option.count === null ? "" : ` (${option.count})`}`} selected={filters[menu] === option.value} onPress={() => choose(option.value)} />)}
        {choices.length === 0 && <Notice theme={theme} text="No matching filter options." />}
      </ScrollView>
    </View>}
    {filtered && <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}><Notice theme={theme} text={error ? "Results unavailable" : loading ? "Finding matching repositories…" : `${catalog?.filteredTotal ?? 0} matching repositories`} /><Action theme={theme} title="Clear filters" icon="X" onPress={() => { onFilters({ ...emptyCatalogFilters, sort: filters.sort }); setMenu(null); }} /></View>}
    {error ? <Notice theme={theme} error text={`Repository catalog unavailable: ${error.message}`} /> : loading ? <View style={{ paddingVertical: 32, alignItems: "center", gap: 10 }}><Icon name="Database" size={24} color={theme.colors.foregroundMuted} /><Notice theme={theme} text="Loading repositories from the selected host…" /></View> : catalog && <>
      {catalog.repositories.length > 0 ? <View style={{ minWidth: 0 }}>
        {!compact && <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 12, paddingBottom: 10, paddingRight: 140 }}>
          {[{ title: "REPOSITORY", flex: 1 }, { title: "WORKSPACE", width: 150 }, { title: "PROJECT", width: 130 }, { title: "CODE ACCESS", width: 115 }].map(column => <Text key={column.title} style={{ flex: column.flex, width: column.width, color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", letterSpacing: 1 }}>{column.title}</Text>)}
        </View>}
        {catalog.repositories.map(repository => repository.origin === "paseo" ? <PaseoProjectRow key={repository.path} theme={theme} repository={repository} compact={compact} trackingAvailable={catalog.administration.available} onIndex={() => onIndex(repository)} /> : <RepositoryRow key={repository.path} theme={theme} repository={repository} compact={compact} onOpen={() => onRepository(repository)} onSettings={() => onMetadata(repository)} onUntrack={() => onUntrack(repository)} />)}
      </View> : <View style={{ alignItems: "center", paddingVertical: 36, gap: 12 }}><Icon name="FolderSearch" size={30} color={theme.colors.accent} /><Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>{catalog.total === 0 ? "No repositories or Paseo projects yet" : "No repositories match your filters"}</Text><Notice theme={theme} text={catalog.total === 0 ? "Add or open a project in Paseo on this host, then refresh the library." : "Try a different name or path, or clear the workspace and project filters."} /></View>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 12, borderTopWidth: 1, borderColor: theme.colors.border }}>
        <Notice theme={theme} text={catalog.filteredTotal === 0 ? "0 repositories" : `${catalog.offset + 1}–${catalog.offset + catalog.repositories.length} of ${catalog.filteredTotal} ${filtered ? "matches" : "repositories"}`} />
        {(catalog.offset > 0 || catalog.nextOffset !== null) && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Action title="Previous" icon="ChevronLeft" theme={theme} disabled={catalog.offset === 0} onPress={() => onPage(Math.max(0, catalog.offset - pageSize))} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{Math.floor(catalog.offset / pageSize) + 1} / {Math.ceil(catalog.filteredTotal / pageSize)}</Text>
          <Action title="Next" icon="ChevronRight" theme={theme} disabled={catalog.nextOffset === null} onPress={() => { if (catalog.nextOffset !== null) onPage(catalog.nextOffset); }} />
        </View>}
      </View>
    </>}
  </Card>;
}
