import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sampleDaemonHealth } from "./health-snapshot.ts";
import { readHostHealth } from "./host-health.ts";

const health = { ts: new Date().toISOString(), ready: true, enriched: false, uptime_seconds: 120, tracked_repos: 2, sessions: 3, graph_nodes: 600, graph_edges: 2100, alloc_bytes: 12582912, sys_bytes: 33554432, lsp_alive: 0, lsp_specs_registered: 1, num_goroutine: 20, num_gc: 4, db_bytes: 4000000, wal_bytes: 1200000 };
function fake(payload: unknown = health, unsubscribeFails = false) {
  let handler: ((event: { params: unknown }) => void) | undefined;
  const calls: string[] = [];
  const port = {
    onclose: undefined as (() => void) | undefined,
    setNotificationHandler(_schema: unknown, next: typeof handler) { handler = next; },
    removeNotificationHandler() { handler = undefined; calls.push("remove"); },
    async callTool(request: { arguments: { operation: string } }) {
      const operation = request.arguments.operation; calls.push(operation);
      if (operation === "subscribe" && payload !== undefined) handler?.({ params: payload });
      if (operation === "unsubscribe" && unsubscribeFails) throw new Error("disconnected");
      return { content: [{ type: "text", text: JSON.stringify({ subscribed: operation === "subscribe" }) }] };
    },
    async close() { calls.push("close"); },
  };
  return { port, client: port as unknown as Client, calls };
}

test("daemon health replay is captured before subscribe resolves and always unsubscribed", async () => {
  const { client, calls } = fake({ ...health, credential: "must not enter output" });
  assert.deepEqual(await sampleDaemonHealth(client), health);
  assert.deepEqual(calls, ["subscribe", "remove", "unsubscribe"]);
});

test("malformed health is an error, never an empty healthy snapshot", async () => {
  const { client, calls } = fake({ ready: true });
  await assert.rejects(sampleDaemonHealth(client), /unsupported shape/);
  assert.equal(calls.at(-1), "unsubscribe");
});

test("missing notification times out and releases the subscription", async () => {
  const { client, calls } = fake(null);
  // Omit delivery instead of emitting an invalid payload.
  client.setNotificationHandler = (() => {}) as Client["setNotificationHandler"];
  await assert.rejects(sampleDaemonHealth(client, 15), /did not provide/);
  assert.equal(calls.at(-1), "unsubscribe");
});

test("lost unsubscribe acknowledgement closes only the sampled client", async () => {
  const { client, calls } = fake(health, true);
  assert.deepEqual(await sampleDaemonHealth(client), health);
  assert.equal(calls.at(-1), "close");
});

test("unavailable native health and an empty catalog are reported explicitly", async () => {
  const offline = await readHostHealth({ assignments: async () => [{ path: "C:\\one" }], daemonHealth: async () => { throw new Error("daemon offline"); } });
  assert.equal(offline.state, "unavailable"); assert.equal(offline.health, null); assert.equal(offline.error, "daemon offline");
  const empty = await readHostHealth({ assignments: async () => [], daemonHealth: async () => { throw new Error("should not connect"); } });
  assert.equal(empty.state, "unavailable"); assert.match(empty.error!, /catalog is empty/);
});
