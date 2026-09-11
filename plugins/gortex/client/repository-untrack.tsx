import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { untrackPreviewRpc, untrackApplyRpc, untrackJobRpc, type UntrackPreview } from "../shared/untrack-contracts.ts";
import { Action, Badge, Notice, SectionHeading } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & {
  path: string; disabled: boolean; onBusy: (busy: boolean, working: boolean) => void; onChanged: () => void;
  autoReview?: boolean; onDismiss?: () => void;
};
const stages = { validating: "Checking tracking state…", untracking: "Waiting for Gortex…", verifying: "Verifying the native catalog…", done: "Finished" };

export function RepositoryUntrack({ host, theme, path, disabled, onBusy, onChanged, autoReview = false, onDismiss }: Props) {
  const prepare = useRpc(untrackPreviewRpc), apply = useRpc(untrackApplyRpc), poll = useRpc(untrackJobRpc);
  const queries = useQueryClient();
  const activeKey = [host.id, "gortex", "untrack-active", path];
  const [preview, setPreview] = useState<UntrackPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(() => queries.getQueryData<string>(activeKey) ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), processed = useRef<string | null>(null), reviewStarted = useRef(false);
  const job = useQuery({ queryKey: [host.id, "gortex", "untrack-job", jobId], queryFn: () => poll({ id: jobId! }), enabled: jobId !== null, retry: false, refetchOnWindowFocus: false, refetchInterval: query => query.state.error || query.state.data?.stage === "done" ? false : 1000 });
  const running = jobId !== null && (!job.data || job.data.stage !== "done");
  useEffect(() => {
    onBusy(busy || running || preview !== null, busy || (running && !job.error));
    return () => onBusy(false, false);
  }, [busy, running, preview, job.error, onBusy]);
  useEffect(() => {
    if (!autoReview || reviewStarted.current || jobId !== null) return;
    reviewStarted.current = true;
    // Opening the dialog only prepares a read-only preview. Applying it requires a button press.
    void request(async () => { setPreview(await prepare({ path })); });
  }, [autoReview, jobId, path, prepare]);
  function rememberJob(id: string | null) {
    setJobId(id);
    if (id) queries.setQueryData(activeKey, id);
    else queries.removeQueries({ queryKey: activeKey, exact: true });
  }
  useEffect(() => {
    const result = job.data;
    if (!result || result.stage !== "done" || processed.current === result.id) return;
    processed.current = result.id;
    if (result.outcome === "review") {
      setPreview(result.preview);
      return;
    }
    setPreview(null);
    if (result.outcome !== "failed") {
      void queries.invalidateQueries({ queryKey: [host.id, "gortex"] });
      onChanged();
    }
  }, [job.data, host.id, queries, onChanged]);
  async function request(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Untrack request failed."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const finished = job.data?.stage === "done" && job.data.outcome !== "review" ? job.data : null;
  const removed = finished?.outcome === "untracked" || finished?.outcome === "demoted";
  const plan = preview?.native;
  const PlanList = autoReview ? View : ScrollView;
  return <View style={{ borderTopWidth: autoReview ? 0 : 1, borderColor: theme.colors.border, paddingTop: autoReview ? 0 : 18, gap: 12 }}>
    {!autoReview && <SectionHeading theme={theme} title="Repository tracking" icon="CircleMinus" subtitle="Manage this repository’s dedicated Gortex index" />}
    <Notice theme={theme} text="Untracking releases the dedicated index. A worktree may still be indexed automatically through its family’s primary graph." />
    {busy && !preview && !running && <Notice theme={theme} text="Preparing the untracking confirmation…" />}
    {!preview && !running && !removed && !finished && (!autoReview || error) && <Action title={autoReview ? "Retry preview" : "Review untracking"} icon="CircleMinus" theme={theme} disabled={disabled || busy} onPress={() => { void request(async () => { setPreview(await prepare({ path })); }); }} />}
    {preview && <View style={{ borderWidth: 1, borderColor: theme.colors.statusDanger, borderRadius: 12, padding: 16, gap: 12 }}>
      <Badge theme={theme} tone="danger" label={plan ? "Confirm native graph removal" : "Review untracking"} />
      <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>{preview.name} · {host.label}</Text>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}>{preview.path}</Text>
      <Notice theme={theme} text={`Gortex workspace: ${preview.workspace} · Project: ${preview.project}`} />
      {preview.warnings.map((warning, i) => <Notice key={i} theme={theme} text={warning} />)}
      {plan && <>
        <Notice theme={theme} text={plan.is_primary ? "This is the family’s primary graph. Its dependent views are included below." : "Gortex must remove this checkout and the dependent data below."} />
        <Notice theme={theme} text={`${plan.closure.length} affected entries · ${plan.preserved.length} preserved entries`} />
        <PlanList style={autoReview ? undefined : { maxHeight: 280 }}><View style={{ gap: 10 }}>
          {plan.closure.map((item, i) => <View key={`remove-${i}`} style={{ gap: 4 }}><Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>Remove {item.kind}: {item.id}</Text><Notice theme={theme} text={item.detail} /></View>)}
          {plan.preserved.map((item, i) => <View key={`keep-${i}`} style={{ gap: 4 }}><Text selectable style={{ color: theme.colors.statusSuccess, fontSize: 12, fontWeight: "600" }}>Keep {item.kind}: {item.id}</Text><Notice theme={theme} text={item.detail} /></View>)}
        </View></PlanList>
        {plan.blockers.map((blocker, i) => <Notice key={i} theme={theme} error text={blocker} />)}
      </>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action title={plan ? "Confirm graph removal" : `Untrack ${preview.name}`} icon="CircleMinus" theme={theme} disabled={disabled || busy || running || !!plan?.blockers.length} onPress={() => { void request(async () => { const result = await apply({ id: preview.id }); rememberJob(result.id); }); }} />
        <Action title="Cancel" theme={theme} disabled={busy || running} onPress={() => { setPreview(null); rememberJob(null); setError(null); onDismiss?.(); }} />
      </View>
    </View>}
    {running && <Notice theme={theme} text={job.data ? stages[job.data.stage] : "Reading untrack progress…"} />}
    {error && <Notice theme={theme} error text={error} />}
    {job.error && <><Notice theme={theme} error text={`${job.error.message} The native operation may have completed. Refresh repositories to inspect its state; do not repeat the request blindly.`} /><Action title="Check untrack progress" theme={theme} onPress={() => { void job.refetch(); }} /></>}
    {finished && <>
      <Badge theme={theme} tone={removed ? "success" : "warning"} label={finished.outcome === "untracked" ? "Repository untracked" : finished.outcome === "demoted" ? "Dedicated index released · automatic worktree retained" : finished.outcome === "failed" ? "No untrack request sent" : "Outcome needs verification"} />
      {finished.configRemoved !== null && <Notice theme={theme} text={finished.configRemoved ? "The native configuration catalog no longer lists this explicit tracking entry." : "The native configuration catalog still lists this repository."} />}
      {removed && <Notice theme={theme} text={autoReview ? "Source files and Paseo workspaces remain unchanged." : "Source files and Paseo workspaces remain unchanged. Return to All repositories to see the refreshed library."} />}
      {finished.receipt && <Notice theme={theme} text={`Gortex reported ${finished.receipt.nodes_removed.toLocaleString()} graph nodes and ${finished.receipt.edges_removed.toLocaleString()} relationships removed.`} />}
      {finished.backupPath && <Notice theme={theme} text={`Configuration backup on ${host.label}: ${finished.backupPath}`} />}
      {finished.error && <Notice theme={theme} error text={finished.error} />}
      {finished.outcome === "failed" && <Action title="Review current tracking state" theme={theme} disabled={disabled || busy} onPress={() => { void request(async () => { const next = await prepare({ path }); rememberJob(null); setPreview(next); }); }} />}
    </>}
    {onDismiss && !preview && <Action title={finished ? "Done" : "Close"} theme={theme} disabled={busy || (running && !job.error)} onPress={onDismiss} />}
  </View>;
}
