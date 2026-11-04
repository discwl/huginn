import type { DiagnosticCheck } from "../shared/diagnostics-contracts.ts";

const WINDOW_MS = 15 * 60_000;
type Repair = { repo: string; kind: string; error: string; times: number[] };
const compact = (value: string, limit: number) => value.replace(/\s+/g, " ").slice(0, limit);

/** Reads the existing log tail only. No graph request, checkout activation or repair is performed. */
export function contractRepairEvidence(log: string | null, now: number): DiagnosticCheck | null {
  if (log === null || !Number.isFinite(now)) return null;
  const failures = new Map<string, Repair>();
  const repaired = new Map<string, number>();
  const seen = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch { continue; }
    if (typeof entry.msg !== "string" || !/(?:^|: )contract stuck repair$/.test(entry.msg)) continue;
    const at = typeof entry.ts === "number" ? entry.ts * 1000 : typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
    if (!Number.isFinite(at) || at < now - WINDOW_MS || at > now) continue;
    if (typeof entry.repo !== "string" || !entry.repo || typeof entry.kind !== "string" || !entry.kind) continue;
    const scope = JSON.stringify([entry.repo, entry.kind]);
    if (entry.outcome === "repaired") {
      repaired.set(scope, Math.max(repaired.get(scope) ?? -Infinity, at));
      continue;
    }
    if (entry.outcome !== "failed" || typeof entry.error !== "string" || !entry.error) continue;
    const key = JSON.stringify([entry.repo, entry.kind, entry.error]);
    const event = JSON.stringify([key, at]);
    if (seen.has(event)) continue;
    seen.add(event);
    const row = failures.get(key) ?? { repo: entry.repo, kind: entry.kind, error: entry.error, times: [] };
    row.times.push(at);
    failures.set(key, row);
  }
  if (!failures.size) return null;
  const groups = [...failures.values()];
  for (const group of groups) group.times.sort((a, b) => a - b);
  const hasLaterRepair = (row: Repair) => (repaired.get(JSON.stringify([row.repo, row.kind])) ?? -Infinity) > row.times.at(-1)!;
  groups.sort((a, b) => Number(hasLaterRepair(a)) - Number(hasLaterRepair(b)) || b.times.length - a.times.length || b.times.at(-1)! - a.times.at(-1)!);
  const row = groups[0];
  const count = groups.reduce((total, item) => total + item.times.length, 0);
  const later = hasLaterRepair(row);
  const intervals = row.times.slice(1).map((at, i) => at - row.times[i]).sort((a, b) => a - b);
  const cadence = intervals.length ? ` Median interval: ${Math.round(intervals[Math.floor(intervals.length / 2)] / 1000)} seconds.` : "";
  const kind = row.kind === "pending_header" ? "repository contract baseline" : `contract repair (${compact(row.kind, 60)})`;
  return {
    id: "contract-repairs", title: "Contract repair retries", state: "warn",
    detail: `The retained log contains ${count} failed contract repair ${count === 1 ? "attempt" : "attempts"} in the last 15 minutes. ${compact(row.repo, 100)}: the same ${kind} error occurred ${row.times.length} ${row.times.length === 1 ? "time" : "times"}.${cadence} ${later ? "A later successful repair was logged for this repository and repair kind; current contract availability still needs verification." : "No later successful repair for this repository and repair kind appears in this log tail."} These are repair attempts, not queued build counts. Source/search availability and CPU or memory causation are separate checks.`,
    evidence: compact(`${row.repo} · ${row.kind} · ${row.error} · last failure ${new Date(row.times.at(-1)!).toISOString()}`, 400),
  };
}
