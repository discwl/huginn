import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { metadataReadRpc, metadataPreviewRpc, metadataRepairRpc, metadataApplyRpc, metadataJobRpc, type MetadataPreview, type RepositoryFields } from "../shared/metadata-contracts.ts";
import { metadataRepairState } from "../shared/metadata-repair.ts";
import { MetadataChangePreview } from "./metadata-preview.tsx";
import { RepositoryUntrack } from "./repository-untrack.tsx";
import { parseExclusionLines } from "../shared/exclusions.ts";
import { ExclusionEditor, ExclusionSettings } from "./repository-exclusions.tsx";
import { Action, Badge, Card, Disclosure, Notice, SectionHeading } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & { path: string; onClose: () => void; onChanged: () => void };
const labels = { name: "Repository name", workspace: "Workspace", project: "Project" } as const;
const keys = ["name", "workspace", "project"] as const;
const stages = { validating: "Checking preview…", saving: "Saving configuration…", reloading: "Reloading Gortex configuration…", indexing: "Refreshing this repository’s index…", verifying: "Verifying daemon state…", done: "Finished" };

import { useHostDateTime } from "./host-time.tsx";

export function RepositoryMetadata({ host, theme, path, onClose, onChanged }: Props) {
  const dateTime = useHostDateTime();
  const read = useRpc(metadataReadRpc), previewChange = useRpc(metadataPreviewRpc), repair = useRpc(metadataRepairRpc), apply = useRpc(metadataApplyRpc), poll = useRpc(metadataJobRpc);
  const queries = useQueryClient();
  const data = useQuery({ queryKey: [host.id, "gortex", "metadata", path], queryFn: () => read({ path }), retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  const current = data.isError ? undefined : data.data;
  const [editing, setEditing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const repairState = current ? metadataRepairState(current) : "unavailable";
  const [draft, setDraft] = useState<RepositoryFields | null>(null);
  const [exclusionDraft, setExclusionDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<MetadataPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [untracking, setUntracking] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const requestInProgress = useRef(false);
  const processed = useRef<string | null>(null);
  const job = useQuery({ queryKey: [host.id, "gortex", "metadata-job", jobId], queryFn: () => poll({ id: jobId! }), enabled: jobId !== null, retry: false, refetchOnWindowFocus: false, refetchInterval: query => query.state.error ? false : query.state.data?.stage === "done" ? false : 1000 });
  const running = jobId !== null && (!job.data || job.data.stage !== "done");
  const locked = busy || running || untracking;
  function stopEditing() { setEditing(false); setRepairing(false); setDraft(null); setExclusionDraft(null); setPreview(null); }
  useEffect(() => {
    if (!job.data || job.data.stage !== "done" || processed.current === job.data.id) return;
    processed.current = job.data.id;
    setEditing(false); setRepairing(false); setDraft(null); setExclusionDraft(null); setPreview(null);
    void queries.invalidateQueries({ queryKey: [host.id, "gortex"] });
    onChanged();
  }, [job.data, host.id, path, queries, onChanged]);
  async function request(work: () => Promise<void>) {
    if (requestInProgress.current) return;
    requestInProgress.current = true; setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Metadata request failed."); }
    finally { requestInProgress.current = false; setBusy(false); }
  }
  function startEditing(exclusions: boolean) {
    if (!current) return;
    setRepairing(false); setEditing(true); setDraft(current.configured); setExclusionDraft(exclusions ? current.extra.exclude.join("\n") : null);
    setPreview(null); setJobId(null); setError(null);
  }
  const fields = draft ?? current?.configured;
  const previewCard = preview && <MetadataChangePreview theme={theme} preview={preview} repair={repairing} locked={locked} onConfirm={() => { void request(async () => { const result = await apply({ id: preview.id }); setJobId(result.id); }); }} onCancel={() => { setPreview(null); setRepairing(false); }} />;
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <SectionHeading theme={theme} title="Repository settings" icon="Settings2" subtitle={`Native Gortex configuration on ${host.label}`} />
      <Action title="Back to repository" icon="ArrowLeft" theme={theme} onPress={onClose} disabled={locked} />
    </View>
    <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}>{path}</Text>
    {data.isFetching && !current && <Notice theme={theme} text="Reading repository configuration and daemon state…" />}
    {data.error && <Notice theme={theme} error text={data.error.message} />}
    {current && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Badge theme={theme} tone={current.state === "applied" ? "success" : "warning"} label={current.state === "applied" ? "Metadata matches daemon" : current.state === "pending" ? "Daemon metadata differs from configuration" : "Daemon state unavailable"} />
        <Badge theme={theme} label={`Source: ${current.assignmentSource}`} />
      </View>
      {!editing && !preview && repairState !== "matched" && <View style={{ gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
        <SectionHeading theme={theme} title="Resolve metadata mismatch" icon="RefreshCw" />
        <Notice theme={theme} text={repairState === "name-conflict"
          ? `Gortex cannot rename the existing graph in place. Preview a repair that replaces the configured name "${current.effective.name}" with "${current.daemon!.name}" and keeps workspace "${current.effective.workspace}" and project "${current.effective.project}". To keep the requested name, leave this pending.`
          : repairState === "ready" ? "Apply the saved workspace and project to the daemon, then verify the result. This requires an index refresh for this repository."
          : repairState === "unsupported" ? "An index refresh is not supported by this adapter for this checkout or project mapping. Automatic repair is unavailable here."
          : "Connect to the daemon and refresh metadata before resolving the mismatch."} />
        {(repairState === "name-conflict" || repairState === "ready") && <Action title={busy ? "Preparing repair…" : "Resolve mismatch"} icon="Wrench" theme={theme} disabled={locked || data.isFetching} onPress={() => { void request(async () => { setJobId(null); setPreview(null); setRepairing(true); setPreview(await repair({ path, revision: current.revision })); }); }} />}
      </View>}
      {repairing && previewCard}
      {repairing && running && <Notice theme={theme} text={job.data ? stages[job.data.stage] : "Reading repair progress…"} />}
      <View style={{ gap: 12 }}>
        {keys.map(key => <View key={key} style={{ backgroundColor: theme.colors.surface0, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{labels[key]}</Text>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>{current.effective[key] || "Not set"}</Text>
          <Notice theme={theme} text={`${current.configured[key] ? "Set in host config" : "Inherited / default"} · Active daemon: ${current.daemon?.[key] || "unavailable"}`} />
        </View>)}
      </View>
      {current.error && <Notice theme={theme} error text={current.error} />}
      {current.warnings.map((warning, i) => <Notice key={i} theme={theme} text={warning} />)}
      {!editing && !preview && <Action title="Edit metadata" icon="Pencil" theme={theme} disabled={locked} onPress={() => startEditing(false)} />}
      <ExclusionSettings theme={theme} patterns={current.extra.exclude} sources={current.exclusionSources} />
      {!editing && !preview && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action title="Edit exclusions" icon="Pencil" theme={theme} disabled={locked} onPress={() => startEditing(true)} />
        <Action title="Preview index refresh" icon="RefreshCw" theme={theme} disabled={locked} onPress={() => { void request(async () => { setRepairing(false); setJobId(null); setPreview(await previewChange({ path, revision: current.revision, configured: current.configured, exclude: current.extra.exclude })); }); }} />
      </View>}
      {editing && fields && <View style={{ gap: 14, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 18 }}>
        <SectionHeading theme={theme} title={exclusionDraft === null ? "Edit host overrides" : "Edit repository exclusions"} />
        {exclusionDraft === null ? <>
          <Notice theme={theme} text="Leave a field empty to inherit the repository’s .gortex.yaml setting or native default. A repository name is also a graph identity, not just a display label." />
          {keys.map(key => <View key={key} style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{labels[key]}</Text>
            <TextInput accessibilityLabel={labels[key]} value={fields[key]} editable={!locked} maxLength={160} autoCapitalize="none" autoCorrect={false} onChangeText={value => { setDraft({ ...fields, [key]: value }); setPreview(null); }} placeholder="Inherit native default" placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 44, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0, paddingHorizontal: 12, color: theme.colors.foreground, fontSize: 14 }} />
          </View>)}
        </> : <ExclusionEditor theme={theme} text={exclusionDraft} disabled={locked} onChange={text => { setExclusionDraft(text); setPreview(null); }} />}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Action title={busy ? "Checking…" : "Preview changes"} icon="Eye" theme={theme} disabled={locked} onPress={() => { void request(async () => { setPreview(await previewChange({ path, revision: current.revision, configured: fields, exclude: exclusionDraft === null ? undefined : parseExclusionLines(exclusionDraft) })); }); }} />
          <Action title="Cancel editing" theme={theme} disabled={locked} onPress={stopEditing} />
        </View>
      </View>}
      {!repairing && previewCard}
      <Disclosure theme={theme} title="Other repository settings" open={extraOpen} onToggle={() => setExtraOpen(!extraOpen)}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>ref</Text>
        <Notice theme={theme} text={current.extra.ref ?? "Not configured"} />
        <Notice theme={theme} text="An optional query-filter label. For example, ref: release lets compatible native queries select entries labeled release. It does not switch or pin a Git branch. Leave it unset unless you use those filters." />
        {!!current.extra.unknownKeys.length && <Notice theme={theme} text={`Unrecognized per-repo keys: ${current.extra.unknownKeys.join(", ")}`} />}
        <Notice theme={theme} text="More options belong in the repo’s .gortex.yaml: include/exclude rules, project path mappings, language-server settings, and architecture rules. They are separate from repos entries in the host config." />
      </Disclosure>
      <Notice theme={theme} text={`Observed ${dateTime(current.observedAt)} · ${current.configPath}`} />
    </>}
    {error && <Notice theme={theme} error text={error} />}
    {jobId && <View style={{ gap: 10 }}>
      {running && <Notice theme={theme} text={job.data ? stages[job.data.stage] : "Reading save progress…"} />}
      {job.error && <><Notice theme={theme} error text={`${job.error.message} The host operation may still have completed. Check its state before submitting another change.`} /><Action title="Check save progress" theme={theme} onPress={() => { void job.refetch(); }} /><Action title="Reconcile saved state" theme={theme} disabled={busy} onPress={() => { void request(async () => { const fresh = await data.refetch(); if (fresh.error) throw fresh.error; setJobId(null); stopEditing(); }); }} /></>}
      {job.data?.stage === "done" && <>
        <Badge theme={theme} tone={job.data.outcome === "applied" ? "success" : "warning"} label={job.data.outcome === "applied" ? "Change applied" : job.data.outcome === "pending" ? "Saved · daemon update pending" : job.data.outcome === "failed" ? "Change failed" : "Outcome needs verification"} />
        {job.data.exclusions !== "unchanged" && <Notice theme={theme} text={job.data.exclusions === "refreshed" ? "The repository index refresh completed using the saved exclusion configuration." : "The exclusion index refresh is not verified. Reconcile the current configuration, then use Preview index refresh to retry explicitly."} />}
        {job.data.error && <Notice theme={theme} error text={job.data.error} />}
        {job.data.backupPath && <Notice theme={theme} text={`Backup on ${host.label}: ${job.data.backupPath}`} />}
      </>}
    </View>}
    <Action title="Refresh metadata" icon="RefreshCw" theme={theme} disabled={locked || editing || data.isFetching} onPress={() => { setRepairing(false); setPreview(null); void data.refetch(); }} />
    <RepositoryUntrack host={host} theme={theme} path={path} disabled={busy || running || editing || preview !== null} onBusy={setUntracking} onChanged={onChanged} />
  </Card>;
}
