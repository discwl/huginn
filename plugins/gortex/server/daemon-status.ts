export interface DaemonSession { id: string; client: string; version: string; connected: string; cwd: string }
export interface DaemonStatus {
  running: boolean; ready: boolean; warming: boolean;
  version: string | null; pid: number | null; uptime: string | null; state: string | null;
  sessions: DaemonSession[];
}

/** One-line `key   value` fields at the top of `gortex daemon status`. */
function field(text: string, name: string): string | null {
  const match = new RegExp(`^\\s*${name}\\s+(.+?)\\s*$`, "m").exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Parses `gortex daemon status`, which has no JSON form. Unknown layouts degrade to empty fields
 * rather than guesses: callers treat a missing value as unknown, never as healthy.
 */
export function parseDaemonStatus(text: string): DaemonStatus {
  const state = field(text, "state"), pid = field(text, "pid");
  const sessions: DaemonSession[] = [];
  const start = text.indexOf("MCP sessions:");
  if (start >= 0) {
    for (const line of text.slice(start).split(/\r?\n/)) {
      if (!line.includes("│")) continue;
      const cells = line.split("│").slice(1, -1).map(cell => cell.trim());
      if (cells.length < 5 || cells[0] === "id") continue;
      sessions.push({ id: cells[0], client: cells[1], version: cells[2], connected: cells[3], cwd: cells[4] });
      if (sessions.length >= 100) break;
    }
  }
  return {
    running: pid !== null && /^\d+$/.test(pid),
    ready: state !== null && /^ready\b/.test(state),
    warming: state !== null && /warming up/.test(state),
    version: field(text, "daemon"), pid: pid !== null && /^\d+$/.test(pid) ? Number(pid) : null,
    uptime: field(text, "uptime"), state, sessions,
  };
}

/** Seconds from Gortex's uptime text ("9s", "14m24s", "5d23h"); null when it is absent or unrecognized. */
export function uptimeSeconds(uptime: string | null): number | null {
  if (!uptime) return null;
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, matched = "";
  for (const [part, value, unit] of uptime.matchAll(/(\d+)([dhms])/g)) { total += Number(value) * units[unit]; matched += part; }
  return matched && matched === uptime.trim() ? total : null;
}

/** "3 claude-code, 2 paseo-gortex" — who is holding Gortex's request slots. */
export function summarizeSessions(sessions: DaemonSession[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.client || "unknown", (counts.get(session.client || "unknown") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([client, count]) => `${count} ${client}`).join(", ");
}
