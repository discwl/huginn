import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GortexClient, gortexRefusal } from "./gortex-client.ts";

const info = { workspace: "fixture", project: "fixture", mode: "workspace", members: [] };

test("pool admission stays bounded during concurrent eviction and cleanup closes owned clients", async context => {
  const root = await mkdtemp(join(tmpdir(), "gortex-pool-"));
  const live = new Set<Client>(); let peak = 0;
  context.mock.method(Client.prototype, "connect", async function(this: Client) { live.add(this); peak = Math.max(peak, live.size); });
  context.mock.method(Client.prototype, "listTools", async () => ({ tools: ["workspace", "search", "read", "relations", "change"].map(name => ({ name })) }));
  context.mock.method(Client.prototype, "callTool", async () => ({ structuredContent: info, content: [] }));
  context.mock.method(Client.prototype, "close", async function(this: Client) { await new Promise(resolve => setTimeout(resolve, 5)); live.delete(this); });
  const native = new GortexClient();
  try {
    const paths = Array.from({ length: 8 }, (_, i) => join(root, String(i)));
    await Promise.all(paths.map(path => mkdir(path)));
    for (const path of paths.slice(0, 4)) await native.info(path);
    await Promise.all(paths.slice(4).map(path => native.info(path)));
    assert.ok(peak <= 4, `observed ${peak} concurrent connections`);
    await native.close();
    assert.equal(live.size, 0);
    await assert.rejects(native.info(paths[0]), /closed/);
  } finally { await native.close(); await rm(root, { recursive: true, force: true }); }
});

test("a native rejection preserves the healthy connection for another read", async context => {
  let connections = 0; let closes = 0; let reject = false;
  context.mock.method(Client.prototype, "connect", async () => { connections++; });
  context.mock.method(Client.prototype, "listTools", async () => ({ tools: ["workspace", "search", "read", "relations", "change"].map(name => ({ name })) }));
  context.mock.method(Client.prototype, "callTool", async () => reject ? { isError: true, content: [] } : { structuredContent: info, content: [] });
  context.mock.method(Client.prototype, "close", async () => { closes++; });
  const native = new GortexClient();
  try {
    await native.info(tmpdir());
    reject = true;
    await assert.rejects(native.query(tmpdir(), "index"), /rejected/);
    assert.equal(closes, 0);
    reject = false;
    await native.info(tmpdir());
    assert.equal(connections, 1);
  } finally { await native.close(); }
  assert.equal(closes, 1);
});

const refusalText = "view_building: automatic checkout discovery is still pending; retry this request: indexer: checkout mutation lane is busy; retry: selected checkout discovery is pending: context deadline exceeded";
const refused = { isError: true, content: [{ type: "text", text: refusalText }] };

/** A client whose Gortex answers with `reply(callNumber)`; the clock only moves when a reply moves it. */
function stalling(context: TestContext, reply: (call: number, clock: { advance(ms: number): void }) => unknown, warmingUp = false) {
  let time = 1_000_000, calls = 0;
  const waits: number[] = [];
  const clock = { advance: (ms: number) => { time += ms; } };
  context.mock.method(Client.prototype, "connect", async () => {});
  context.mock.method(Client.prototype, "listTools", async () => ({ tools: ["workspace", "search", "read", "relations", "change"].map(name => ({ name })) }));
  context.mock.method(Client.prototype, "callTool", async () => reply(++calls, clock));
  context.mock.method(Client.prototype, "close", async () => {});
  const native = new GortexClient("gortex", { now: () => time, wait: async ms => { waits.push(ms); }, warmingUp: async () => warmingUp });
  return { native, waits, calls: () => calls, advance: clock.advance };
}

test("a quick refusal gets one immediate retry, and the answer is used", async context => {
  const f = stalling(context, call => call === 1 ? refused : { structuredContent: info, content: [] });
  try {
    assert.deepEqual(await f.native.info(tmpdir()), info);
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.waits, [400]);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("a repository that keeps refusing pauses its automatic requests; occasional refusals don't", async context => {
  const f = stalling(context, () => refused);
  try {
    // Each request is tried, then retried quickly twice inside Gortex's 5-second window.
    await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string; message: string }) => error.code === "stalled" && /next refresh usually answers/.test(error.message));
    assert.equal(f.calls(), 3); assert.deepEqual(f.waits, [400, 800]);
    assert.equal(await f.native.pausedUntil(tmpdir()), null, "one refused request is not a reason to pause");
    await assert.rejects(f.native.info(tmpdir(), { background: true }), /next refresh usually answers/);
    // The third refused request in a row pauses this repository.
    await assert.rejects(f.native.info(tmpdir(), { background: true }), /kept refusing, so the plugin paused its automatic Gortex requests for about 1 min/);
    assert.equal(f.calls(), 9);
    // While paused, an automatic request isn't sent at all.
    await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string }) => error.code === "paused");
    assert.equal(f.calls(), 9);
    // A request the user asked for still tries, and a further refusal doubles the pause.
    await assert.rejects(f.native.query(tmpdir(), "search", { query: "x" }), /about 2 min/);
    assert.equal(f.calls(), 12);
    // Try now: automatic requests are sent again, and the count starts over.
    f.native.resumeRequests();
    await assert.rejects(f.native.info(tmpdir(), { background: true }), /next refresh usually answers/);
    assert.equal(f.calls(), 15);
    assert.deepEqual(f.native.requestTally(), { answered: 0, refused: 5, windowMs: 600_000 });
  } finally { await f.native.close(); }
});

test("an answer between refusals keeps a flaky repository from ever pausing", async context => {
  // Every request is refused on its first try and answered on the quick retry, the pattern seen on slow-Git hosts;
  // and every other request is refused outright.
  const f = stalling(context, call => call % 2 === 1 ? refused : call % 4 === 0 ? refused : { structuredContent: info, content: [] });
  try {
    for (let i = 0; i < 8; i++) await f.native.info(tmpdir(), { background: true }).catch(() => null);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("a slow refusal pauses without a retry, since Gortex was busy with something else", async context => {
  const f = stalling(context, (_call, clock) => { clock.advance(3000); return refused; });
  try {
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string }) => error.code === "stalled");
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.waits, []);
  } finally { await f.native.close(); }
});

test("while the daemon warms up after a start, refusals are waited out and never pause", async context => {
  const f = stalling(context, call => call <= 3 ? refused : { structuredContent: info, content: [] }, true);
  try {
    assert.deepEqual(await f.native.info(tmpdir(), { background: true }), info);
    assert.deepEqual(f.waits, [300, 700, 1500]);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

const loading = () => { throw new McpError(-32000, "repository loading: huginn (resolving references, 37%)", { retryable: true }); };

test("repository loading (Gortex 0.64.11) is waited out on the startup schedule and never pauses, even on an old daemon", async context => {
  const f = stalling(context, call => call <= 3 ? loading() : { structuredContent: info, content: [] });
  try {
    assert.deepEqual(await f.native.info(tmpdir(), { background: true }), info);
    assert.deepEqual(f.waits, [300, 700, 1500]);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("loading that outlasts the schedule ends with Gortex's progress, not a pause or an unreachable daemon", async context => {
  const f = stalling(context, () => loading());
  try {
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string; message: string }) =>
      error.code === "repo_loading" && /still loading huginn after a restart \(resolving references, 37%\)/.test(error.message) && !/reachable/.test(error.message));
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("Gortex's own JSON-RPC refusal keeps its text and the healthy connection", async context => {
  const f = stalling(context, () => { throw new McpError(-32000, "repository unavailable: huginn (root moved)", { retryable: false }); });
  const closes = context.mock.method(Client.prototype, "close", async () => {});
  try {
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string; message: string }) => error.code === "refused" && error.message === "repository unavailable: huginn (root moved)");
    assert.equal(closes.mock.callCount(), 0, "the daemon answered, so the connection stays");
  } finally { await f.native.close(); }
});

test("a busy dispatcher sent as a JSON-RPC error is retried, and transport failures still read as unreachable", async context => {
  const busy = stalling(context, call => { if (call <= 2) throw new McpError(-32002, "MCP dispatcher is busy", { retryable: true }); return { structuredContent: info, content: [] }; });
  try { assert.deepEqual(await busy.native.info(tmpdir()), info); assert.deepEqual(busy.waits, [300, 700]); }
  finally { await busy.native.close(); }
  assert.equal(gortexRefusal(new McpError(ErrorCode.ConnectionClosed, "Connection closed")), null);
  assert.equal(gortexRefusal(new McpError(-32603, "request dispatch failed")), null);
  assert.equal(gortexRefusal(new Error("repository loading: x (a, 1%)")), null, "only protocol errors carry a code");
  assert.equal(gortexRefusal(new McpError(-32000, "repository loading: x (scan, 5%)")), "repository loading: x (scan, 5%)");
});

test("a request Gortex doesn't answer in time is reported as such, and pauses once that keeps happening", async context => {
  const f = stalling(context, () => { throw new McpError(ErrorCode.RequestTimeout, "Request timed out"); });
  try {
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string; message: string }) => error.code === "timeout" && /didn't answer within 20 seconds/.test(error.message) && !/reachable/.test(error.message));
    assert.equal(f.calls(), 1, "a timeout already waited; it isn't retried");
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string }) => error.code === "timeout");
    await assert.rejects(f.native.info(tmpdir()), /didn't answer within 20 seconds, and kept refusing/);
    assert.notEqual(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("readiness checks try once, are never paused, and never pause other requests", async context => {
  const f = stalling(context, () => refused);
  try {
    await assert.rejects(f.native.info(tmpdir(), { single: true }), /Gortex rejected the request/);
    assert.equal(f.calls(), 1);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
    for (let i = 0; i < 3; i++) await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string }) => error.code === "stalled");
    assert.notEqual(await f.native.pausedUntil(tmpdir()), null, "three refused requests in a row paused the repository");
    await assert.rejects(f.native.info(tmpdir(), { single: true }), /Gortex rejected the request/);
    assert.equal(f.calls(), 11, "a readiness check is sent even while automatic requests are paused");
  } finally { await f.native.close(); }
});

test("a request refused because the daemon just restarted is sent again, and never pauses anything", async context => {
  const restarted = () => { throw new McpError(-32097, "Gortex daemon restarted and daemon-owned MCP session state was reset. The request was not executed; re-orient and retry."); };
  const f = stalling(context, call => call === 1 ? restarted() : { structuredContent: info, content: [] });
  try {
    assert.deepEqual(await f.native.info(tmpdir(), { background: true }), info);
    assert.equal(f.calls(), 2);
    assert.deepEqual(f.waits, [300]);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
  // A single-try request still gets that one extra try, since the first was never run.
  const once = stalling(context, call => call <= 1 ? restarted() : { structuredContent: info, content: [] });
  try { assert.deepEqual(await once.native.info(tmpdir(), { single: true }), info); } finally { await once.native.close(); }
});
