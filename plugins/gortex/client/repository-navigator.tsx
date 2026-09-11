import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Repository } from "../shared/models.ts";
import { Action, Badge, Card, Notice, SectionHeading } from "./controls.tsx";

type Props = {
  theme: PluginSurfaceProps["theme"];
  repositories: Repository[];
  workspaceIds: string[];
  selectedWorkspace: string | null;
  selectedPath?: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  onWorkspace: (id: string) => void;
  onRepository: (path: string) => void;
  onMetadata: (path: string) => void;
  onPage: (offset: number) => void;
};

function RepositoryRow({ theme, repository, selected, onPress }: { theme: Props["theme"]; repository: Repository; selected: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={`Explore repository: ${repository.name}`} accessibilityState={{ selected }} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ padding: 12, gap: 7, borderRadius: 10, borderWidth: 1, borderLeftWidth: 3, borderColor: focused ? theme.colors.accent : theme.colors.border, borderLeftColor: selected || focused ? theme.colors.accent : theme.colors.border, backgroundColor: selected || pressed ? theme.colors.surface2 : theme.colors.surface1, minHeight: 68 })}>
    <View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}><Icon name="FolderGit2" size={17} color={selected ? theme.colors.accent : theme.colors.foregroundMuted} /><Text style={{ flex: 1, color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{repository.name}</Text>{selected && <Icon name="Check" size={15} color={theme.colors.accent} />}</View>
    <Text style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 17 }}>{repository.path}</Text>
  </Pressable>;
}

export function RepositoryNavigator({ theme, repositories, workspaceIds, selectedWorkspace, selectedPath, total, offset, nextOffset, onWorkspace, onRepository, onMetadata, onPage }: Props) {
  const members = repositories.filter(repo => repo.workspaceId === selectedWorkspace && repo.state === "resolved");
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}><SectionHeading theme={theme} title="Library" icon="Library" /><Badge theme={theme} label={`${total} ${total === 1 ? "repository" : "repositories"}`} /></View>
    <View style={{ gap: 9 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 1 }}>GORTEX WORKSPACE</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{workspaceIds.map(id => <Action key={id} title={id} icon="Layers" theme={theme} selected={selectedWorkspace === id} onPress={() => onWorkspace(id)} />)}</View>
      {workspaceIds.length === 0 && <Notice theme={theme} text="No resolved workspaces on this page." />}
    </View>
    {selectedWorkspace ? <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", letterSpacing: 1 }}>REPOSITORIES</Text>
      {members.map(repo => <View key={repo.path} style={{ gap: 6 }}><RepositoryRow theme={theme} repository={repo} selected={selectedPath === repo.path} onPress={() => onRepository(repo.path)} /><Notice theme={theme} text={`Configured workspace: ${repo.declaredWorkspace} · Project: ${repo.declaredProject}`} /><Action title="Repository settings" icon="Settings2" theme={theme} onPress={() => onMetadata(repo.path)} /></View>)}
      {!selectedPath && <Notice theme={theme} text="Select a repository to explore its index and code." />}
    </View> : total > 0 && <Notice theme={theme} text="Choose a workspace to see its repositories." />}
    {repositories.filter(repo => repo.state === "unavailable").map(repo => <View key={repo.path} style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderColor: theme.colors.border }}><Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{repo.name}</Text><Notice theme={theme} text={`Configured workspace: ${repo.declaredWorkspace} · Project: ${repo.declaredProject}`} /><Notice theme={theme} error text={repo.error ?? "Graph context is unavailable."} /><Action title="Repository settings" icon="Settings2" theme={theme} onPress={() => onMetadata(repo.path)} /></View>)}
    {total === 0 && <Notice theme={theme} text="No repositories in the native catalog. Adding repositories is not yet available in this preview." />}
    {(offset > 0 || nextOffset !== null) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {offset > 0 && <Action title="Previous" icon="ChevronLeft" theme={theme} onPress={() => onPage(Math.max(0, offset - 50))} />}
      {nextOffset !== null && <Action title="Next" icon="ChevronRight" theme={theme} onPress={() => onPage(nextOffset)} />}
    </View>}
    {total > 50 && <Notice theme={theme} text="Workspace choices are limited to this page of repositories." />}
  </Card>;
}
