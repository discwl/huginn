import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { diagnosticsLatestRpc, diagnosticsRepairRpc, diagnosticsRunRpc, type DiagnosticCheck, type DiagnosticsReport, type Remedy } from "../shared/diagnostics-contracts.ts";
import { Action, Badge, Button, Card, Disclosure, Notice, SectionHeading } from "./controls.tsx";
import { useHostDateTime } from "./host-time.tsx";

const checkTone = { pass: "success", warn: "warning", fail: "danger", skipped: "neutral" } as const;
const checkLabel = { pass: "OK", warn: "Check", fail: "Problem", skipped: "Skipped" } as const;
const reportTone = { healthy: "success", degraded: "warning", broken: "danger" } as const;
const reportLabel = { healthy: "Ready", degraded: "Degraded", broken: "Not working" } as const;

/** Runs Gortex health checks on the selected host and offers the repairs they justify, one confirmation each. */
export function DiagnosticsPanel({ host, theme }: Pick<PluginSurfaceProps, "host" | "theme">) {
  const runCheck = useRpc(diagnosticsRunRpc), latest = useRpc(diagnosticsLatestRpc), repairRpc = useRpc(diagnosticsRepairRpc);
  const dateTime = useHostDateTime();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [confirming, setConfirming] = useState<Remedy | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const previous = useQuery({ queryKey: [host.id, "gortex", "diagnostics-latest"], queryFn: () => latest({}), retry: false, staleTime: Infinity });
  const current = report ?? previous.data?.report ?? null;
  const run = useMutation({ mutationFn: () => runCheck({}), onSuccess: next => { setReport(next); setConfirming(null); } });
  const repair = useMutation({
    mutationFn: (remedy: Remedy) => repairRpc({ reportId: current!.id, remedyId: remedy.id }),
    onSuccess: job => { setConfirming(null); if (job.report) setReport(job.report); },
  });
  const busy = run.isPending || repair.isPending;
  const Check = ({ check }: { check: DiagnosticCheck }) => <View style={{ gap: 4, paddingVertical: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <Badge theme={theme} label={checkLabel[check.state]} tone={checkTone[check.state]} />
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>{check.title}</Text>
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{check.detail}</Text>
    {check.evidence && <Disclosure theme={theme} title="Details" open={evidence === check.id} onToggle={() => setEvidence(evidence === check.id ? null : check.id)}>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}>{check.evidence}</Text>
    </Disclosure>}
  </View>;
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <SectionHeading theme={theme} title="Diagnostics" icon="Stethoscope" subtitle={`Check Gortex on ${host.label} and fix what it finds`} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        {current && <Badge theme={theme} label={reportLabel[current.state]} tone={reportTone[current.state]} />}
        <Action title={run.isPending ? "Checking…" : current ? "Run again" : "Run diagnostics"} icon="Stethoscope" primary={!current} theme={theme} disabled={busy} onPress={() => run.mutate()} />
      </View>
    </View>
    {!current && !run.isPending && <Notice theme={theme} text="Checks the Gortex executable, the daemon, its MCP responses, repository indexes and per-repository access. Nothing changes until you choose a fix." />}
    {run.isPending && <Notice theme={theme} text="Running checks on this host…" />}
    {run.error && <Notice theme={theme} error text={run.error.message} />}
    {repair.isPending && <Notice theme={theme} text="Applying the fix, then re-running the checks…" />}
    {repair.error && <Notice theme={theme} error text={repair.error.message} />}
    {repair.data && !repair.isPending && <Notice theme={theme} error={repair.data.outcome === "failed"} text={[
      repair.data.outcome === "fixed" ? `Fixed: ${repair.data.title}.` : repair.data.outcome === "unchanged" ? `${repair.data.title} finished, but checks still report problems.` : `${repair.data.title} failed.`,
      ...repair.data.steps, repair.data.error ?? "",
    ].filter(Boolean).join(" ")} />}
    {current && <>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{current.summary}</Text>
      {current.checks.map(check => <Check key={check.id} check={check} />)}
      {current.remedies.length > 0 && <View style={{ gap: 8, paddingTop: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>Suggested fixes</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {current.remedies.map(remedy => <Action key={remedy.id} title={remedy.title} icon={remedy.risk === "host-wide" ? "TriangleAlert" : "Wrench"} theme={theme} disabled={busy} onPress={() => setConfirming(remedy)} />)}
        </View>
      </View>}
      {confirming && <View style={{ borderWidth: 1, borderColor: confirming.risk === "host-wide" ? theme.colors.statusDanger : theme.colors.border, borderRadius: 12, padding: 12, gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{confirming.title} on {host.label}?</Text>
        <Notice theme={theme} text={confirming.detail} />
        {confirming.risk === "host-wide" && <Notice theme={theme} error text="This affects every Gortex client on this host, including agents that are running right now." />}
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Action title={repair.isPending ? "Working…" : "Confirm"} icon="Check" primary theme={theme} disabled={busy} onPress={() => repair.mutate(confirming)} />
          <Button title="Cancel" theme={theme} disabled={busy} onPress={() => setConfirming(null)} />
        </View>
      </View>}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Checked {dateTime(current.observedAt)} · {(current.durationMs / 1000).toFixed(1)}s</Text>
    </>}
  </Card>;
}
