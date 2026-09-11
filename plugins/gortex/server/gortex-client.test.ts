import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
