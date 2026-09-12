import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { updateStatusRpc, updateCheckRpc, updatePreviewRpc, updateApplyRpc, updateJobRpc, type UpdatePreview } from "../shared/update-contracts.ts";
import { Action, Badge, Disclosure, Notice, SectionHeading } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme">;
const stages = { checking: "Checking the installed binary…", downloading: "Downloading and verifying the release…", installing: "Installing Gortex…", restarting: "Restarting the Gortex daemon…", verifying: "Verifying the installed version and daemon…", done: "Finished" };
const states = { unchecked: "Not checked", available: "Update available", current: "Up to date", ahead: "Newer than latest release", unavailable: "Check unavailable" };

export function GortexUpdatesPanel(props: Props) { return <HostUpdates key={props.host.id} {...props} />; }
function HostUpdates({ host, theme }: Props) {
  const read = useRpc(updateStatusRpc), check = useRpc(updateCheckRpc), prepare = useRpc(updatePreviewRpc), apply = useRpc(updateApplyRpc), poll = useRpc(updateJobRpc);
  const queries = useQueryClient(), statusKey = [host.id, "gortex", "update-status"], jobKey = [host.id, "gortex", "update-job"];
  const [preview, setPreview] = useState<UpdatePreview | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [details, setDetails] = useState(false);
  const inFlight = useRef(false), processed = useRef<string | null>(null);
  const status = useQuery({ queryKey: statusKey, queryFn: () => read({}), retry: false, refetchOnWindowFocus: false });
  const job = useQuery({ queryKey: jobKey, queryFn: () => poll({}), retry: false, refetchOnWindowFocus: false, refetchInterval: query => !query.state.error && query.state.data?.outcome === "running" ? 1000 : false });
  const running = job.data?.outcome === "running", locked = busy || running;
  const result = job.data?.stage === "done" ? job.data : null;
  const data = status.data;
  async function request(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Gortex update request failed."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!result || processed.current === result.id) return;
    processed.current = result.id;
    void queries.invalidateQueries({ queryKey: [host.id, "gortex"], predicate: query => query.queryKey[2] !== "update-job" });
  }, [result, host.id, queries]);
  function checkUpdates() {
    void request(async () => {
      const progress = job.refetch();
      try { queries.setQueryData(statusKey, await check({})); }
      finally { await progress; }
    });
  }
  function confirmUpdate() {
    if (!preview) return;
    const approved = preview;
    void request(async () => {
      try { queries.setQueryData(jobKey, await apply({ id: approved.id })); }
      finally {
        // A lost reply does not prove that the host rejected the update. Reconcile instead of replaying it.
        setPreview(null); await job.refetch();
      }
    });
  }
  return <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 18, gap: 14 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <SectionHeading theme={theme} title="Gortex updates" icon="Download" subtitle={`Installed on ${host.label}`} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Action theme={theme} title={busy && !preview ? "Checking…" : "Check for updates"} icon="RefreshCw" disabled={locked} onPress={checkUpdates} />
        {data?.state === "available" && data.installation.method !== "unsupported" && <Action theme={theme} title="Update" icon="Download" primary disabled={locked || job.isError || job.isFetching} onPress={() => { void request(async () => setPreview(await prepare({}))); }} />}
      </View>
    </View>
    {!data && status.isFetching && <Notice theme={theme} text="Reading the installed version…" />}
    {data && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Text selectable style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{data.installation.version}</Text>
        <Badge theme={theme} label={status.isError ? "Previous observation" : states[data.state]} tone={status.isError || data.state === "unavailable" || data.state === "available" ? "warning" : data.state === "current" ? "success" : "neutral"} />
        {data.latestVersion && <Notice theme={theme} text={`${data.state === "unavailable" ? "Last known release" : "Latest release"}: ${data.latestVersion}`} />}
      </View>
      {data.error && <Notice theme={theme} error text={data.error} />}
      {data.installation.reason && <Notice theme={theme} text={data.installation.reason} />}
      {data.checkedAt && <Notice theme={theme} text={`Checked ${new Date(data.checkedAt).toLocaleString()} on ${host.label}.`} />}
    </>}
    {status.error && <Notice theme={theme} error text={status.error.message} />}
    {error && <Notice theme={theme} error text={error} />}
    {running && <>
      <Badge theme={theme} label={`Updating to ${job.data!.targetVersion}`} tone="warning" icon="Clock" />
      <Notice theme={theme} text={`${stages[job.data!.stage]} You can close this panel; the host continues the update.`} />
    </>}
    {job.error && <Notice theme={theme} error text={`${job.error.message} Update progress is unavailable. Check progress before submitting another update.`} />}
    {(job.error || error) && <Action theme={theme} title="Check progress" icon="RefreshCw" disabled={busy || job.isFetching} onPress={() => { void job.refetch(); }} />}
    {result && <>
      <Badge theme={theme} label={result.outcome === "updated" ? "Update verified" : result.outcome === "failed" ? "Update did not start" : "Update needs attention"} tone={result.outcome === "updated" ? "success" : "warning"} />
      {result.installedVersion && <Notice theme={theme} text={`Installed binary: ${result.installedVersion} · ${result.daemonReachable ? "Daemon reachable" : "Daemon availability not verified"}`} />}
      {result.error && <Notice theme={theme} error text={result.error} />}
      {result.backupPath && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Previous executable: {result.backupPath}</Text>}
      {result.outcome !== "updated" && <Action theme={theme} title="Review current state" icon="RefreshCw" disabled={locked} onPress={checkUpdates} />}
    </>}
    {data && <Disclosure theme={theme} title="Installation details" open={details} onToggle={() => setDetails(value => !value)}>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{data.installation.binary}</Text>
      <Notice theme={theme} text="Checks the official stable release only when requested. Updates apply to Gortex on this host; plugin updates are managed separately by Paseo." />
      {data.releaseUrl && <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{data.releaseUrl}</Text>}
    </Disclosure>}
    {preview && <Modal title={`Update Gortex on ${host.label}?`} icon={<Icon name="Download" size={18} color={theme.colors.accent} />} open onOpenChange={open => { if (!open && !busy) setPreview(null); }}>
      <Modal.Content><View style={{ gap: 14 }}>
        <Badge theme={theme} label={host.label} icon="Monitor" />
        <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>{preview.installation.version} → {preview.targetVersion}</Text>
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{preview.installation.binary}</Text>
        {preview.warnings.map(warning => <Notice key={warning} theme={theme} text={warning} />)}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Action theme={theme} title={busy ? "Starting…" : "Confirm update"} icon="Download" primary disabled={locked} onPress={confirmUpdate} />
          <Action theme={theme} title="Cancel" disabled={busy} onPress={() => setPreview(null)} />
        </View>
      </View></Modal.Content>
    </Modal>}
  </View>;
}
