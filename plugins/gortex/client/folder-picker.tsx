import { useState, useEffect } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { directoryRpc, inspectRpc } from "../shared/contracts.ts";
import { Button, Card, Notice } from "./controls.tsx";

export function FolderPicker({ theme, host, onOpen }: Pick<PluginSurfaceProps, "theme" | "host"> & { onOpen: (path: string) => Promise<void> }) {
  const list = useRpc(directoryRpc);
  const inspect = useRpc(inspectRpc);
  const [path, setPath] = useState<string>();
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [inspectedPath, setInspectedPath] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => { const timer = setTimeout(() => { setDebouncedFilter(filter); setCursor(null); }, 250); return () => clearTimeout(timer); }, [filter]);
  const page = useQuery({ queryKey: [host.id, "gortex", "directories", path, debouncedFilter, cursor], queryFn: () => list({ path, filter: debouncedFilter, limit: 100, cursor }), retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const inspection = useQuery({ queryKey: [host.id, "gortex", "inspection", inspectedPath], queryFn: () => inspect({ path: inspectedPath! }), enabled: inspectedPath !== null, retry: false, staleTime: 0, refetchOnWindowFocus: false });
  function navigate(next: string) {
    setPath(next); setDraft(next); setCursor(null); setInspectedPath(null); setFilter(""); setDebouncedFilter(""); setOpenError(null);
    setRecent(previous => [next, ...previous.filter(item => item !== next)].slice(0, 6));
  }
  const inputStyle = { color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44 };
  return <Card theme={theme}>
    <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>Browse folders on {host.label}</Text>
    <Notice theme={theme} text="This is the host filesystem. Browsing does not read source files or establish indexing state." />
    <TextInput accessibilityLabel="Absolute host folder path" value={draft} onChangeText={setDraft} placeholder="Enter an absolute host path" placeholderTextColor={theme.colors.foregroundMuted} style={inputStyle} onSubmitEditing={() => { if (draft.trim()) navigate(draft.trim()); }} autoCapitalize="none" autoCorrect={false} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button title="Go to path" theme={theme} disabled={!draft.trim()} onPress={() => navigate(draft.trim())} />
      <Button title="Parent folder" theme={theme} disabled={!page.data?.parent} onPress={() => { if (page.data?.parent) navigate(page.data.parent); }} />
      <Button title="Refresh folders" theme={theme} onPress={() => { if (cursor) setCursor(null); else void page.refetch(); }} />
      {page.data?.roots.map(root => <Button key={root} title={root} theme={theme} onPress={() => navigate(root)} />)}
    </View>
    {recent.length > 1 && <View style={{ gap: 4 }}><Notice theme={theme} text="Recent folders on this host" />{recent.slice(1, 4).map(item => <Button key={item} title={item} theme={theme} onPress={() => navigate(item)} />)}</View>}
    <Text selectable style={{ color: theme.colors.foreground }}>{page.data?.path ?? path ?? "Host home directory"}</Text>
    <TextInput accessibilityLabel="Filter directory names" value={filter} onChangeText={setFilter} placeholder="Filter folder names" placeholderTextColor={theme.colors.foregroundMuted} style={inputStyle} autoCapitalize="none" autoCorrect={false} />
    {page.isFetching && <Notice theme={theme} text="Reading host directory…" />}
    {page.error && <Notice theme={theme} error text={page.error.message} />}
    {!page.isFetching && page.data?.entries.length === 0 && <Notice theme={theme} text="No directory entries match within the scanned range." />}
    {page.data?.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}
    {page.data?.entries.map(entry => <Button key={entry.path} title={`${entry.name}${entry.isLink ? " · link" : ""}`} theme={theme} onPress={() => navigate(entry.path)} />)}
    {page.data?.nextCursor && <Button title="Next folder page" theme={theme} onPress={() => setCursor(page.data!.nextCursor)} />}
    <Button title="Inspect this folder" theme={theme} disabled={!page.data || page.isFetching} onPress={() => { if (inspectedPath === page.data!.path) void inspection.refetch(); else setInspectedPath(page.data!.path); }} />
    {inspection.isFetching && inspectedPath && <Notice theme={theme} text="Inspecting repository identity…" />}
    {inspection.error && inspectedPath && <Notice theme={theme} error text={inspection.error.message} />}
    {inspection.data && !inspection.isFetching && !inspection.isError && !page.isFetching && !page.isError && inspectedPath === page.data?.path && <View style={{ gap: 8 }}>
      <Text selectable style={{ color: theme.colors.foreground }}>Canonical path: {inspection.data.canonicalPath}</Text>
      <Text selectable style={{ color: theme.colors.foreground }}>Git root: {inspection.data.repositoryRoot ?? "Not established"}</Text>
      <Text style={{ color: theme.colors.foreground }}>Native tracking: {inspection.data.tracking}</Text>
      {inspection.data.repository && <Text style={{ color: theme.colors.foreground }}>Workspace: {inspection.data.repository.workspaceId ?? inspection.data.repository.declaredWorkspace}</Text>}
      {inspection.data.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}
      <Button title={opening ? "Opening workspace…" : "Open / reuse Paseo workspace"} theme={theme} disabled={opening} onPress={() => { setOpening(true); setOpenError(null); void onOpen(inspection.data.canonicalPath).catch(error => setOpenError(error instanceof Error ? error.message : "Could not open workspace.")).finally(() => setOpening(false)); }} />
      {openError && <Notice theme={theme} error text={openError} />}
    </View>}
  </Card>;
}
