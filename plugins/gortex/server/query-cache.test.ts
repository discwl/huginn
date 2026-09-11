import test from "node:test";
import assert from "node:assert/strict";
import { QueryCache } from "./query-cache.ts";

test("shares pending work even when completed results have zero retention", async () => {
  const cache = new QueryCache();
  let release!: (value: number) => void; let calls = 0;
  const fetch = () => { calls++; return new Promise<number>(resolve => { release = resolve; }); };
  const one = cache.get("host/workspace/repo/search/a", 0, fetch);
  await Promise.resolve();
  const two = cache.get("host/workspace/repo/search/a", 0, fetch);
  assert.equal(one, two); assert.equal(calls, 1);
  release(42); assert.equal(await two, 42);
  assert.equal(await cache.get("host/workspace/repo/search/a", 0, async () => 43), 43);
});

test("failed requests are not cached as success and distinct contexts do not share values", async () => {
  const cache = new QueryCache();
  await assert.rejects(cache.get("workspace-a/repo", 10000, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.get("workspace-a/repo", 10000, async () => "A"), "A");
  assert.equal(await cache.get("workspace-b/repo", 10000, async () => "B"), "B");
  cache.clear();
  assert.equal(await cache.get("workspace-a/repo", 10000, async () => "new"), "new");
});
