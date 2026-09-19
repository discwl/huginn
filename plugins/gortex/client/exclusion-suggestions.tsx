import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { suggestJobRpc, suggestLatestRpc, suggestStartRpc, type RuleSuggestion, type SuggestJob } from "../shared/exclusion-suggest-contracts.ts";
import { Action, Badge, Disclosure, Notice } from "./controls.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & { path: string; disabled: boolean; onApply: (lines: string[]) => void };
const stages: Record<SuggestJob["stage"], string> = { gathering: "Surveying folders and .gitignore…", starting: "Starting a read-only agent…", thinking: "The agent is reviewing the survey…", done: "Finished" };
const tone = { high: "success", medium: "warning", low: "neutral" } as const;

/** Asks a read-only Paseo agent for rules and lets the user pick which ones go into the exclusions editor. */
export function ExclusionSuggestions({ host, theme, path, disabled, onApply }: Props) {
  const start = useRpc(suggestStartRpc), poll = useRpc(suggestJobRpc), latest = useRpc(suggestLatestRpc);
  const [jobId, setJobId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false), [applied, setApplied] = useState(0);
  const previous = useQuery({ queryKey: [host.id, "gortex", "suggest-latest", path], queryFn: () => latest({ path }), retry: false, staleTime: Infinity });
  useEffect(() => { if (!jobId && previous.data?.job) setJobId(previous.data.job.id); }, [previous.data, jobId]);
  const job = useQuery({ queryKey: [host.id, "gortex", "suggest-job", jobId], queryFn: () => poll({ id: jobId! }), enabled: jobId !== null, retry: false, refetchInterval: query => query.state.data?.stage === "done" || query.state.error ? false : 2000 });
  const run = useMutation({ mutationFn: () => start({ path }), onSuccess: next => { setApplied(0); setSelected(new Set()); setJobId(next.id); } });
  const data = job.data, suggestion = data?.outcome === "ready" ? data.suggestion : null;
  const lineFor = (kind: "exclude" | "include", rule: RuleSuggestion) => kind === "include" ? `!${rule.pattern}` : rule.pattern;
  // Pre-select confident suggestions once per result.
  useEffect(() => {
    if (!suggestion) return;
    setSelected(new Set([...suggestion.exclude.map(rule => ["exclude", rule] as const), ...suggestion.include.map(rule => ["include", rule] as const)].filter(([, rule]) => rule.confidence !== "low").map(([kind, rule]) => lineFor(kind, rule))));
  }, [data?.id, data?.outcome]);
  const running = run.isPending || (data !== undefined && data.stage !== "done");
  const toggle = (line: string) => setSelected(current => { const next = new Set(current); if (next.has(line)) next.delete(line); else next.add(line); return next; });
  const Rule = ({ kind, rule }: { kind: "exclude" | "include"; rule: RuleSuggestion }) => {
    const line = lineFor(kind, rule), checked = selected.has(line);
    return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => toggle(line)} style={{ flexDirection: "row", gap: 10, paddingVertical: 8, borderTopWidth: 1, borderColor: theme.colors.border, alignItems: "flex-start" }}>
      <Icon name={checked ? "SquareCheck" : "Square"} size={18} color={checked ? theme.colors.accent : theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13 }}>{line}</Text>
          <Badge theme={theme} label={rule.confidence} tone={tone[rule.confidence]} />
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{rule.reason}</Text>
      </View>
    </Pressable>;
  };
  return <View style={{ gap: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 12 }}>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Suggestions from an agent</Text>
      <Action title={running ? "Working…" : data ? "Ask again" : "Suggest rules"} icon="Sparkles" theme={theme} disabled={disabled || running} onPress={() => run.mutate()} />
    </View>
    {!data && !running && <Notice theme={theme} text={`A read-only agent on ${host.label} reviews your .gitignore, folder sizes and current rules, then suggests exclusions and inclusions. Nothing changes until you add them here and confirm the preview.`} />}
    {running && <Notice theme={theme} text={data ? stages[data.stage] : "Starting…"} />}
    {data?.agent && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Agent: {data.agent}</Text>}
    {run.error && <Notice theme={theme} error text={run.error.message} />}
    {job.error && <Notice theme={theme} error text={job.error.message} />}
    {data?.outcome === "failed" && <Notice theme={theme} error text={data.error ?? "The agent could not produce suggestions."} />}
    {suggestion && <>
      {suggestion.exclude.length === 0 && suggestion.include.length === 0 && <Notice theme={theme} text="No changes recommended. The current rules look reasonable to the agent." />}
      {suggestion.exclude.length > 0 && <View><Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>Exclude</Text>{suggestion.exclude.map(rule => <Rule key={`e:${rule.pattern}`} kind="exclude" rule={rule} />)}</View>}
      {suggestion.include.length > 0 && <View><Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13 }}>Keep indexed (added as ! rules)</Text>{suggestion.include.map(rule => <Rule key={`i:${rule.pattern}`} kind="include" rule={rule} />)}</View>}
      {suggestion.notes && <Notice theme={theme} text={suggestion.notes} />}
      {data!.dropped.length > 0 && <Disclosure theme={theme} title={`${data!.dropped.length} suggestion${data!.dropped.length === 1 ? "" : "s"} skipped`} open={open} onToggle={() => setOpen(!open)}>{data!.dropped.map((item, i) => <Notice key={i} theme={theme} text={item} />)}</Disclosure>}
      {(suggestion.exclude.length > 0 || suggestion.include.length > 0) && <View style={{ flexDirection: "row" }}>
        <Action title={`Add ${selected.size} to the editor`} icon="Plus" primary theme={theme} disabled={disabled || selected.size === 0} onPress={() => { onApply([...selected]); setApplied(selected.size); }} />
      </View>}
      {applied > 0 && <Notice theme={theme} text={`Added ${applied} rule${applied === 1 ? "" : "s"} to the editor below. Review them, then use Preview changes to save.`} />}
    </>}
  </View>;
}
