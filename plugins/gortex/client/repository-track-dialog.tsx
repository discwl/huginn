import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { trackPreviewRpc, trackApplyRpc, trackJobRpc, observeTrackReadiness, type TrackPreview } from "../shared/track-contracts.ts";
import { Action, Badge, Notice } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & { name: string; path: string; onClose: () => void; onChanged: () => void };
const stages = { validating: "Checking the repository…", tracking: "Starting Gortex indexing…", verifying: "Refreshing native tracking state…", done: "Finished" };

export function RepositoryTrackDialog(props: Props) {
  return <TrackDialog key={`${props.host.id}:${props.path}`} {...props} />;
}
function TrackDialog({ host, theme, name, path, onClose, onChanged }: Props) {
  const prepare = useRpc(trackPreviewRpc), apply = useRpc(trackApplyRpc), poll = useRpc(trackJobRpc);
  const queries = useQueryClient(), activeKey = [host.id, "gortex", "track-active", path];
  const [preview, setPreview] = useState<TrackPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(() => queries.getQueryData<string>(activeKey) ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<"idle" | "checking" | "pending">("idle");
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const started = useRef(false), inFlight = useRef(false), processed = useRef<string | null>(null), pollRef = useRef(poll);
  pollRef.current = poll;
  const job = useQuery({ queryKey: [host.id, "gortex", "track-job", jobId], queryFn: () => poll({ id: jobId! }), enabled: jobId !== null, retry: false, refetchOnWindowFocus: false, refetchInterval: query => query.state.error || query.state.data?.stage === "done" ? false : 1000 });
  const running = jobId !== null && (!job.data || job.data.stage !== "done");
  const locked = busy || (running && !job.error);
  async function request(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Indexing request failed."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function preparePreview() { void request(async () => { const next = await prepare({ path }); setJobId(null); setPreview(next); }); }
  useEffect(() => {
    if (started.current || jobId !== null) return;
    started.current = true; preparePreview();
  }, [path, jobId]);
  useEffect(() => {
    const result = job.data;
    if (!result || result.stage !== "done") return;
    const revision = `${result.id}:${result.outcome}`;
    if (processed.current === revision) return;
    processed.current = revision; setPreview(null);
    if (result.outcome !== "uncertain" && result.outcome !== "indexing") queries.removeQueries({ queryKey: activeKey, exact: true });
    if (result.outcome !== "failed") {
      void queries.invalidateQueries({ queryKey: [host.id, "gortex"], predicate: query => query.queryKey[2] !== "track-job" && query.queryKey[2] !== "track-active" });
      onChanged();
    }
  }, [job.data, host.id, path, queries, onChanged]);
  useEffect(() => {
    const result = job.data;
    if (!result || result.stage !== "done" || result.outcome !== "indexing" || job.error) return;
    const controller = new AbortController();
    setReadiness("checking"); setReadinessError(null);
    void observeTrackReadiness({
      read: () => pollRef.current({ id: result.id, observe: true }),
      onJob: next => { queries.setQueryData([host.id, "gortex", "track-job", result.id], next); },
      signal: controller.signal,
    }).then(() => { if (!controller.signal.aborted) setReadiness("pending"); }).catch(cause => {
      if (controller.signal.aborted) return;
      setReadiness("pending"); setReadinessError(cause instanceof Error ? cause.message : "Readiness check failed.");
    });
    return () => { controller.abort(); };
  }, [host.id, path, jobId, job.data?.id, job.data?.stage, job.data?.outcome, job.error, queries]);
  function dismiss() { if (!locked) onClose(); }
  const result = job.data?.stage === "done" ? job.data : null;
  return <Modal title={`Index ${name} with Gortex?`} icon={<Icon name="Database" size={18} color={theme.colors.accent} />} open onOpenChange={open => { if (!open) dismiss(); }}>
    <Modal.Content>
      <View style={{ gap: 14 }}>
        <Badge theme={theme} label={host.label} icon="Monitor" />
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{preview?.path ?? path}</Text>
        {busy && !preview && !running && <Notice theme={theme} text="Checking the folder and native tracking configuration…" />}
        {preview && !running && !result && <>
          <Notice theme={theme} text={`Native repository name: ${preview.name}`} />
          {preview.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}
          <Action theme={theme} title="Confirm and index" icon="Database" disabled={busy} onPress={() => { void request(async () => {
            const accepted = await apply({ id: preview.id });
            queries.setQueryData(activeKey, accepted.id); setJobId(accepted.id);
          }); }} />
        </>}
        {running && <Notice theme={theme} text={job.data ? stages[job.data.stage] : "Reading indexing progress…"} />}
        {error && <Notice theme={theme} error text={error} />}
        {job.error && <>
          <Notice theme={theme} error text={`${job.error.message} Tracking may have completed. Check progress or refresh the native catalog before submitting another request.`} />
          <Action theme={theme} title="Check progress" icon="RefreshCw" onPress={() => { void job.refetch(); }} />
        </>}
        {result && <>
          <Badge theme={theme} tone={result.outcome === "tracked" ? "success" : "warning"} label={result.outcome === "tracked" ? "Tracking enabled" : result.outcome === "indexing" ? "Tracked · view pending" : result.outcome === "failed" ? "No tracking request sent" : "Outcome needs verification"} />
          {result.registered !== null && <Notice theme={theme} text={result.registered ? "Gortex’s native catalog included this repository when tracking was verified." : "The repository did not appear in Gortex’s native catalog when tracking was verified."} />}
          {result.repository && <Notice theme={theme} text={`Workspace: ${result.repository.workspaceId} · Project: ${result.repository.projectId || "not set"}`} />}
          {result.outcome === "tracked" && <Notice theme={theme} text="The native view is available for code access. Gortex may still be indexing in the background." />}
          {result.outcome === "indexing" && <>
            <Notice theme={theme} text={readiness === "checking" ? "Checking native view availability for up to one minute. The repository list refreshes when code access becomes available." : "The native view is still pending. Check readiness to refresh code access; indexing may continue in the background."} />
            {readinessError && <Notice theme={theme} error text={readinessError} />}
            {readiness !== "checking" && <Action theme={theme} title="Check readiness" icon="RefreshCw" disabled={busy} onPress={() => { void request(async () => {
              setReadinessError(null);
              const next = await poll({ id: result.id, observe: true });
              queries.setQueryData([host.id, "gortex", "track-job", result.id], next);
            }); }} />}
          </>}
          {result.error && <Notice theme={theme} error={result.outcome !== "indexing"} text={result.error} />}
        </>}
        {!running && ((!result && error) || result?.outcome === "failed") && <Action theme={theme} title="Review current state" icon="RefreshCw" disabled={busy} onPress={preparePreview} />}
        <Action theme={theme} title={result ? "Done" : "Cancel"} disabled={locked} onPress={dismiss} />
      </View>
    </Modal.Content>
  </Modal>;
}
