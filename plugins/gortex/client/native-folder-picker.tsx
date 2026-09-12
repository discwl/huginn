import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { nativePickerCapabilitiesRpc, nativePickerStartRpc, nativePickerPollRpc, nativePickerCancelRpc } from "../shared/native-picker-contracts.ts";
import { inspectRpc } from "../shared/contracts.ts";
import { Action, Button, Card, Notice } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme">;
export function NativeFolderButton({ host, theme, initialPath, onSelected }: Props & { initialPath?: string; onSelected: (path: string) => void }) {
  const capabilities = useRpc(nativePickerCapabilitiesRpc);
  const start = useRpc(nativePickerStartRpc);
  const poll = useRpc(nativePickerPollRpc);
  const cancel = useRpc(nativePickerCancelRpc);
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const cancelOnUnmount = useRef(cancel);
  cancelOnUnmount.current = cancel;
  const activeId = useRef<string | null>(null);
  const handledId = useRef<string | null>(null);
  const support = useQuery({ queryKey: [host.id, "gortex", "native-picker-support"], queryFn: () => capabilities({}), retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  const launch = useMutation({ mutationFn: () => start({ initialPath }), onSuccess: ({ id }) => {
    if (!mounted.current) { void cancel({ id }).catch(() => {}); return; }
    activeId.current = id; setJobId(id); setNotice(null);
  } });
  const result = useQuery({ queryKey: [host.id, "gortex", "native-picker", jobId], queryFn: () => poll({ id: jobId! }), enabled: jobId !== null, retry: false, refetchOnWindowFocus: false, refetchInterval: query => query.state.data?.state === "open" ? 400 : false });
  const abort = useMutation({ mutationFn: () => cancel({ id: activeId.current! }), onSuccess: () => { setJobId(null); activeId.current = null; setNotice("Folder selection cancelled."); } });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (activeId.current) void cancelOnUnmount.current({ id: activeId.current }).catch(() => {}); };
  }, []);
  useEffect(() => {
    const value = result.data;
    if (!value || value.state === "open" || handledId.current === value.id) return;
    handledId.current = value.id; activeId.current = null; setJobId(null);
    if (value.state === "selected" && value.path) { setNotice("Folder selected."); onSelected(value.path); }
    else setNotice(value.error ?? "Folder selection cancelled.");
  }, [result.data, onSelected]);
  const busy = launch.isPending || abort.isPending || jobId !== null;
  if (support.isError) return <Notice theme={theme} error text="Windows folder picker availability could not be checked. Reopen Gortex to try again." />;
  if (!support.data?.available) return support.isFetching ? <Notice theme={theme} text="Checking Windows folder picker…" /> : <Notice theme={theme} text={support.data?.reason ?? "Native folder picker unavailable."} />;
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action title={busy ? "Choosing folder…" : "Browse…"} icon="FolderOpen" primary theme={theme} disabled={busy} onPress={() => { setNotice(null); launch.mutate(); }} />
      {jobId && <Button title="Cancel folder picker" theme={theme} disabled={abort.isPending} onPress={() => abort.mutate()} />}
    </View>
    {jobId && <Notice theme={theme} text={`Choose a folder on ${host.label}'s Windows desktop.`} />}
    {launch.error && <Notice theme={theme} error text={launch.error.message} />}
    {result.error && <Notice theme={theme} error text={`Cannot read the picker result: ${result.error.message}`} />}
    {abort.error && <Notice theme={theme} error text={abort.error.message} />}
    {notice && <Notice theme={theme} text={notice} />}
  </View>;
}

export function SelectedNativeFolder({ host, theme, path, onOpen, onIndex }: Props & { path: string; onOpen?: (path: string) => Promise<void>; onIndex?: (path: string) => void }) {
  const inspect = useRpc(inspectRpc);
  const info = useQuery({ queryKey: [host.id, "gortex", "native-selection", path], queryFn: () => inspect({ path }), retry: false, staleTime: 0, refetchOnWindowFocus: false });
  const open = useMutation({ mutationFn: () => onOpen!(info.data!.canonicalPath) });
  return <Card theme={theme}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 18 }}>Selected folder</Text>
    <Text selectable style={{ color: theme.colors.foreground }}>{path}</Text>
    {info.isFetching && <Notice theme={theme} text="Inspecting the selected folder…" />}
    {info.error && <Notice theme={theme} error text={info.error.message} />}
    {!info.isFetching && !info.isError && info.data && <>
      <Notice theme={theme} text={`Repository root: ${info.data.repositoryRoot ?? "No Git repository detected"}`} />
      <Notice theme={theme} text={`Native tracking: ${info.data.tracking}`} />
      {info.data.warnings.map((warning, index) => <Notice key={index} theme={theme} text={warning} />)}
      {onIndex && info.data.tracking === "not-in-catalog" && info.data.gitDirectoryKind === "directory" && info.data.repositoryRoot && <Action title="Index" icon="Database" theme={theme} onPress={() => onIndex(info.data!.repositoryRoot!)} />}
      {onOpen && <Button title="Open / reuse Paseo workspace" theme={theme} disabled={open.isPending} onPress={() => open.mutate()} />}
    </>}
    {open.error && <Notice theme={theme} error text={open.error.message} />}
  </Card>;
}
