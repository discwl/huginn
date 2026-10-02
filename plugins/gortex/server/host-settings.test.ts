import test from "node:test";
import assert from "node:assert/strict";
import { pinnedWorkers, readHostSettings, type HostSettingsIo } from "./host-settings.ts";
import { parseDaemonStatus, summarizeSessions, uptimeSeconds } from "./daemon-status.ts";
import type { NativeAssignment } from "../shared/models.ts";

const STATUS = ` daemon    v0.64.5+3310720
 pid       26804
 uptime    14m24s
 state     ready (warmup 21s)
 sessions  2

MCP sessions:
┌────┬──────────────┬─────────┬───────────┬──────────────────────────┐
│ id │ client       │ version │ connected │ cwd                      │
├────┼──────────────┼─────────┼───────────┼──────────────────────────┤
│ b0 │ claude-code  │ 2.1.283 │    13m33s │ C:\\Code\\development-flow │
│ c5 │ paseo-gortex │ 0.1.0   │    13m51s │ C:\\huginn                │
└────┴──────────────┴─────────┴───────────┴──────────────────────────┘
`;
const rows: NativeAssignment[] = [
  { repo: "app", path: "C:/Repos/app", workspace: "w", project: "p", source: "global" },
  { repo: "api", path: "C:/Repos/api", workspace: "w", project: "p", source: "global" },
];
function io(overrides: Partial<HostSettingsIo> = {}): HostSettingsIo {
  return {
    cli: async args => args.join(" ") === "daemon status" ? STATUS : "windows task: not installed (GortexDaemon)\n",
    assignments: async () => rows,
    readRepoConfig: async root => root.endsWith("api") ? "index:\n  workers: 4\n" : null,
    cpuCount: () => 16, env: () => undefined, ...overrides,
  };
}

test("daemon status text is parsed into fields and sessions; unknown layouts stay unknown", () => {
  const status = parseDaemonStatus(STATUS);
  assert.equal(status.running, true); assert.equal(status.ready, true); assert.equal(status.pid, 26804);
  assert.equal(status.version, "v0.64.5+3310720"); assert.equal(status.uptime, "14m24s");
  assert.deepEqual(status.sessions.map(session => session.client), ["claude-code", "paseo-gortex"]);
  assert.equal(status.sessions[0].cwd, "C:\\Code\\development-flow");
  assert.equal(summarizeSessions(status.sessions), "1 claude-code, 1 paseo-gortex");
  const empty = parseDaemonStatus("something else entirely");
  assert.equal(empty.running, false); assert.equal(empty.ready, false); assert.deepEqual(empty.sessions, []);
  assert.equal(parseDaemonStatus(" pid 1\n state warming up (socket reachable)\n").warming, true);
});

test("uptime text converts to seconds; unrecognized text stays unknown", () => {
  assert.equal(uptimeSeconds("9s"), 9); assert.equal(uptimeSeconds("14m24s"), 864); assert.equal(uptimeSeconds("5d23h"), 514800);
  for (const text of [null, "", "soon", "5 days"]) assert.equal(uptimeSeconds(text), null);
});

test("index.workers is read only from a repository's .gortex.yaml", () => {
  assert.equal(pinnedWorkers("index:\n  workers: 8\n"), 8);
  for (const text of [null, "", "workspace: a\n", "index:\n  workers: 0\n", "index:\n  workers: many\n", ": not yaml: ["]) assert.equal(pinnedWorkers(text), null);
});

test("settings report defaults, per-repo workers below the CPU count, sessions and daemon facts", async () => {
  const settings = await readHostSettings(io());
  assert.deepEqual(settings.dispatchLimit, { configured: null, defaultValue: 8, maximum: 64 });
  assert.equal(settings.cpuCount, 16);
  assert.deepEqual(settings.repositories.map(repo => [repo.name, repo.workers, repo.source, repo.belowCpu]), [["app", 16, "cpu", false], ["api", 4, "repo", true]]);
  assert.equal(settings.sessions.length, 2);
  assert.equal(settings.daemon.running, true); assert.equal(settings.daemon.service, "windows task: not installed (GortexDaemon)");
  assert.deepEqual(settings.warnings, []);
});

test("a configured dispatch limit is clamped like Gortex does, and junk values are called out", async () => {
  assert.equal((await readHostSettings(io({ env: () => "24" }))).dispatchLimit.configured, 24);
  assert.equal((await readHostSettings(io({ env: () => "500" }))).dispatchLimit.configured, 64);
  const junk = await readHostSettings(io({ env: () => "lots" }));
  assert.equal(junk.dispatchLimit.configured, null);
  assert.match(junk.warnings[0], /Gortex ignores/);
});

test("an unreachable daemon or catalog yields warnings, not invented values", async () => {
  const settings = await readHostSettings(io({ cli: async () => { throw new Error("Cannot resolve the configured host executable."); }, assignments: async () => { throw new Error("Gortex MCP request failed."); } }));
  assert.equal(settings.daemon.running, false); assert.equal(settings.daemon.state, null);
  assert.deepEqual(settings.sessions, []); assert.deepEqual(settings.repositories, []);
  assert.equal(settings.warnings.length, 2);
});
