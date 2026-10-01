import test from "node:test";
import assert from "node:assert/strict";
import { isWarmingUpMessage, warmingUpMessage, warmupRetryDelaysMs } from "../shared/native-retry.ts";
import { WorkspaceLibrary } from "./workspace-library.ts";
import { readHostHealth } from "./host-health.ts";
import type { NativePort } from "./gortex-client.ts";
import type { NativeAssignment } from "../shared/models.ts";

const warmup = "Gortex rejected the request. Gortex said: view_building: automatic checkout discovery is still pending; retry this request: indexer: checkout mutation lane is busy; retry: selected checkout discovery is pending: context deadline exceeded";

test("Gortex's own retry conditions are recognized; ordinary failures are not", () => {
  for (const text of [warmup, "indexer: checkout mutation lane is busy", "daemon is warming up"]) assert.equal(isWarmingUpMessage(text), true, text);
  for (const text of ["corpus huginn has no dedicated graph", "Gortex MCP request failed.", "context deadline exceeded"]) assert.equal(isWarmingUpMessage(text), false, text);
  assert.ok(warmupRetryDelaysMs.length >= 1);
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
  assert.equal(report.state, "unavailable");
  assert.match(report.error!, /starting up and still discovering/);
  const other = await readHostHealth({ assignments: async () => [{ path: process.cwd() }], daemonHealth: async () => { throw new Error("socket closed"); } });
  assert.equal(other.error, "socket closed");
});
