import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { gitInitRpc, gitStatusRpc } from "../shared/git-contracts.ts";
import { Action, Button, Notice } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & { path: string; onChanged?: () => void };

/** Renders only for a plain folder (no Git): an explanation and a confirmed Initialize Git action. */
export function GitInitControl({ host, theme, path, onChanged }: Props) {
  const readStatus = useRpc(gitStatusRpc), init = useRpc(gitInitRpc);
  const [confirming, setConfirming] = useState(false);
  const status = useQuery({ queryKey: [host.id, "gortex", "git-status", path], queryFn: () => readStatus({ path }), retry: false, staleTime: 10000 });
  const run = useMutation({ mutationFn: () => init({ path }), onSuccess: () => { setConfirming(false); void status.refetch(); onChanged?.(); } });
  if (run.isSuccess) return <Notice theme={theme} text="Git initialized. No files were committed. Refresh the index in Repository settings so Gortex applies the new .gitignore." />;
  if (status.data?.state !== "plain") return null;
  return <View style={{ gap: 8 }}>
    <Notice theme={theme} text="Plain folder (no Git). Gortex can index it, but branch, worktree and change-history features need Git." />
    {!status.data.canInitialize && status.data.reason && <Notice theme={theme} text={status.data.reason} />}
    {status.data.canInitialize && !confirming && <View style={{ flexDirection: "row" }}><Action title="Initialize Git" icon="GitBranch" theme={theme} onPress={() => { run.reset(); setConfirming(true); }} /></View>}
    {confirming && <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 12, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Initialize Git in this folder on {host.label}?</Text>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}>{status.data.path}</Text>
      <Notice theme={theme} text="Runs git init. It creates an empty .git folder only: nothing is staged or committed, and your files are not changed. Add a .gitignore and make the first commit yourself." />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Action title={run.isPending ? "Initializing…" : "Confirm git init"} icon="Check" primary theme={theme} disabled={run.isPending} onPress={() => run.mutate()} />
        <Button title="Cancel" theme={theme} disabled={run.isPending} onPress={() => setConfirming(false)} />
      </View>
    </View>}
    {run.error && <Notice theme={theme} error text={run.error.message} />}
  </View>;
}
