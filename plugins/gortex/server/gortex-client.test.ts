import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GortexClient } from "./gortex-client.ts";

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

test("refusals on a daemon that has been up a while pause automatic requests instead of retrying them", async context => {
  const f = stalling(context, () => refused);
  try {
    await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string; message: string }) => error.code === "stalled" && /paused its automatic Gortex requests for about 1 min/.test(error.message));
    assert.equal(f.calls(), 2, "one try and one quick retry");
    // While paused, an automatic request isn't sent at all.
    await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string }) => error.code === "paused");
    assert.equal(f.calls(), 2);
    // A request the user asked for still tries, and a further refusal doubles the pause.
    await assert.rejects(f.native.query(tmpdir(), "search", { query: "x" }), /about 2 min/);
    assert.equal(f.calls(), 4);
    // Try now: automatic requests are sent again.
    f.native.resumeRequests();
    await assert.rejects(f.native.info(tmpdir(), { background: true }), /about 1 min/);
    assert.equal(f.calls(), 6);
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

test("a request Gortex doesn't answer in time is reported as such and pauses, instead of blaming the daemon's reachability", async context => {
  const f = stalling(context, () => { throw new McpError(ErrorCode.RequestTimeout, "Request timed out"); });
  try {
    await assert.rejects(f.native.info(tmpdir()), (error: { code?: string; message: string }) => error.code === "timeout" && /didn't answer within 20 seconds/.test(error.message) && !/reachable/.test(error.message));
    assert.equal(f.calls(), 1);
    assert.notEqual(await f.native.pausedUntil(tmpdir()), null);
  } finally { await f.native.close(); }
});

test("readiness checks try once, are never paused, and never pause other requests", async context => {
  const f = stalling(context, () => refused);
  try {
    await assert.rejects(f.native.info(tmpdir(), { single: true }), /Gortex rejected the request/);
    assert.equal(f.calls(), 1);
    assert.equal(await f.native.pausedUntil(tmpdir()), null);
    await assert.rejects(f.native.info(tmpdir(), { background: true }), (error: { code?: string }) => error.code === "stalled");
    await assert.rejects(f.native.info(tmpdir(), { single: true }), /Gortex rejected the request/);
    assert.equal(f.calls(), 4, "a readiness check is sent even while automatic requests are paused");
  } finally { await f.native.close(); }
});
