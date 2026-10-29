import test from "node:test";
import assert from "node:assert/strict";
import { isBusyMessage, isLoadingMessage, isNotLoadedMessage, isStallMessage, isWarmingUpMessage, loadingMessage, warmingUpMessage, warmupRetryDelaysMs } from "../shared/native-retry.ts";
import { NativeError } from "./native-response.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { readHostHealth } from "./host-health.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment } from "../shared/models.ts";

const warmup = "Gortex rejected the request. Gortex said: view_building: automatic checkout discovery is still pending; retry this request: indexer: checkout mutation lane is busy; retry: selected checkout discovery is pending: context deadline exceeded";

test("Gortex 0.64.11's repository loading is its own case, with readable progress", () => {
  const text = "repository loading: huginn (resolving references, 37%)";
  assert.equal(isLoadingMessage(text), true); assert.equal(isNotLoadedMessage(text), true);
  assert.equal(isStallMessage(text), false, "loading is progress, not a checkout stall");
  assert.equal(loadingMessage(text), "Gortex is still loading huginn after a restart (resolving references, 37%). It answers once loading finishes; refresh in a moment.");
  assert.match(loadingMessage("repository loading: weird"), /still loading this repository after a restart\. /);
  assert.equal(isLoadingMessage(loadingMessage(text)), true, "the plain-words form is still recognized downstream");
});

test("a repository Gortex reports loading is shown as loading with its progress, even without a detected startup", async () => {
  const rows: NativeAssignment[] = [{ repo: "app", path: process.cwd(), workspace: "w", project: "p", source: "global" }];
  const native: NativePort = {
    assignments: async () => rows, version: async () => "gortex v0.64.11+fixture", close: async () => {},
    info: async () => { throw new Error("repository loading: app (resolving references, 37%)"); },
    query: async () => { throw new Error("No graph query expected"); },
  };
  const library = new WorkspaceLibrary(native);
  try {
    const [row] = (await library.catalog()).repositories;
    assert.equal(row.state, "loading");
    assert.match(row.error!, /still loading app after a restart \(resolving references, 37%\)/);
  } finally { library.close(); }
});

test("Gortex's own retry conditions are recognized; ordinary failures are not", () => {
  for (const text of [warmup, "indexer: checkout mutation lane is busy", "daemon is warming up"]) assert.equal(isWarmingUpMessage(text), true, text);
  for (const text of ["corpus huginn has no dedicated graph", "Gortex MCP request failed.", "context deadline exceeded"]) assert.equal(isWarmingUpMessage(text), false, text);
  assert.ok(warmupRetryDelaysMs.length >= 1);
  // A refusal for checkout discovery and a refusal for request capacity are told apart.
  assert.equal(isStallMessage(warmup), true);
  assert.equal(isStallMessage("MCP error -32002: MCP dispatcher is busy"), false);
  assert.equal(isBusyMessage("MCP error -32002: MCP dispatcher is busy"), true);
});

function library(fail: number) {
  const rows: NativeAssignment[] = [{ repo: "app", path: process.cwd(), workspace: "w", project: "p", source: "global" }];
  let calls = 0;
  const native: NativePort = {
    assignments: async () => rows, version: async () => "gortex v0.64.5+fixture", close: async () => {},
    info: async () => { if (calls++ < fail) throw new Error(warmup); return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path: process.cwd() }] }; },
    query: async () => { throw new Error("No graph query expected"); },
  };
  return { native, library: new WorkspaceLibrary(native), calls: () => calls };
}

test("a repository still warming up explains the wait instead of showing native retry text", async () => {
  const f = library(1);
  try {
    const catalog = await f.library.catalog();
    assert.equal(catalog.repositories[0].state, "unavailable");
    assert.equal(catalog.repositories[0].error, warmingUpMessage);
    assert.doesNotMatch(catalog.repositories[0].error!, /mutation lane|view_building/);
  } finally { f.library.close(); }
});

test("host health describes a warming daemon rather than repeating its internal error", async () => {
  const report = await readHostHealth({ assignments: async () => [{ path: process.cwd() }], daemonHealth: async () => { throw new Error(warmup); } });
  assert.equal(report.state, "busy");
  assert.equal(report.error, warmingUpMessage);
  // A stall belongs to one checkout: the next repository can still carry the host-wide request.
  const tried: string[] = [];
  const fallback = await readHostHealth({
    assignments: async () => [{ path: "C:/stalled" }, { path: "C:/fine" }],
    daemonHealth: async path => { tried.push(path); if (path === "C:/stalled") throw new Error(warmup); return { ready: true } as never; },
  });
  assert.equal(fallback.state, "available"); assert.deepEqual(tried, ["C:/stalled", "C:/fine"]);
  const full = await readHostHealth({ assignments: async () => [{ path: "C:/a" }], daemonHealth: async () => { throw new Error("MCP error -32002: MCP dispatcher is busy"); } });
  assert.equal(full.state, "busy"); assert.match(full.error!, /as many requests as it allows/);
  const other = await readHostHealth({ assignments: async () => [{ path: process.cwd() }], daemonHealth: async () => { throw new Error("socket closed"); } });
  assert.equal(other.error, "socket closed");
  // Any other failure for one repository, such as a daemon still loading its list of repositories, tries the next too.
  const untracked = await readHostHealth({
    assignments: async () => [{ path: "C:/huginn" }, { path: "C:/fine" }],
    daemonHealth: async path => { if (path === "C:/huginn") throw new Error("MCP error -32000: repository not tracked: C:\\huginn"); return { ready: true } as never; },
  });
  assert.equal(untracked.state, "available");
});

test("host health doesn't ask about repositories whose requests are paused, and Try now asks again", async () => {
  const asked: { path: string; background?: boolean }[] = [];
  let resumed = 0;
  const paused = new Map([["C:/a", 2_000_000], ["C:/b", 1_500_000]]);
  const native = {
    assignments: async () => [{ path: "C:/a" }, { path: "C:/b" }],
    daemonHealth: async (path: string, options?: { background?: boolean }) => { asked.push({ path, background: options?.background }); return { ready: true } as never; },
    pausedUntil: async (path: string) => paused.get(path) ?? null,
    resumeRequests: () => { resumed++; paused.clear(); },
  };
  const waiting = await readHostHealth(native, { now: () => 1_000_000 });
  assert.equal(waiting.state, "paused");
  assert.equal(waiting.pausedUntil, new Date(1_500_000).toISOString());
  assert.match(waiting.error!, /paused its automatic Gortex requests for about 8 more min/);
  assert.deepEqual(asked, []);
  const now = await readHostHealth(native, { retryNow: true });
  assert.equal(now.state, "available");
  assert.equal(resumed, 1);
  // The refresh is an automatic request, so a refusal pauses rather than retries.
  assert.deepEqual(asked, [{ path: "C:/a", background: true }]);
});

test("a refusal the plugin is waiting out is shown as the plugin's own explanation", async () => {
  const report = await readHostHealth({ assignments: async () => [{ path: "C:/a" }], daemonHealth: async () => { throw new NativeError("stalled", "Gortex refused this request because it is still discovering checkouts."); } });
  assert.equal(report.state, "busy");
  assert.equal(report.error, "Gortex refused this request because it is still discovering checkouts.");
});

test("a catalog page asks about its rows as automatic requests and keeps a verified identity while Gortex is refusing", async () => {
  const rows: NativeAssignment[] = [{ repo: "app", path: process.cwd(), workspace: "w", project: "p", source: "global" }];
  const asked: (boolean | undefined)[] = [];
  let refusing = false;
  const native: NativePort = {
    assignments: async () => rows, version: async () => "gortex v0.64.8+fixture", close: async () => {},
    info: async (_path, options) => {
      asked.push(options?.background);
      if (refusing) throw new NativeError("paused", "Gortex was refusing requests, so the plugin paused its automatic Gortex requests for about 1 more min.");
      return { workspace: "w", project: "p", mode: "workspace", members: [{ name: "app", path: process.cwd() }] };
    },
    query: async () => { throw new Error("No graph query expected"); },
  };
  const library = new WorkspaceLibrary(native);
  try {
    assert.equal((await library.catalog()).repositories[0].state, "resolved");
    refusing = true;
    const paused = (await library.catalog()).repositories[0];
    assert.equal(paused.state, "resolved", "the identity verified a moment ago stays usable");
    assert.match(paused.error!, /paused its automatic Gortex requests/);
    assert.deepEqual(asked, [true, true]);
  } finally { library.close(); }
});
