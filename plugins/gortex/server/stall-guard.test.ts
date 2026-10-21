import test from "node:test";
import assert from "node:assert/strict";
import { StallGuard } from "./stall-guard.ts";

function guard() {
  let clock = 0;
  const stalls = new StallGuard({ now: () => clock });
  return { stalls, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("a refused repository pauses for a minute, then for doubling waits up to 10 minutes", () => {
  const f = guard();
  assert.equal(f.stalls.pausedUntil("C:/a"), null);
  assert.equal(f.stalls.refused("C:/a"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/a"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/b"), null, "one repository's refusal doesn't pause another");
  f.advance(60_000);
  assert.equal(f.stalls.pausedUntil("C:/a"), null, "the pause ends on time");
  const waits = [f.stalls.refused("C:/a")];
  for (let i = 0; i < 5; i++) waits.push(f.stalls.refused("C:/a"));
  assert.deepEqual(waits, [120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
});

test("two repositories refused within a minute pause the whole host", () => {
  const f = guard();
  f.stalls.refused("C:/a");
  f.advance(30_000);
  assert.equal(f.stalls.refused("C:/b"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/c"), 90_000, "a third repository waits too");
  // An answer ends that repository's pause and the host's, but not another refused repository's.
  f.stalls.answered("C:/b");
  assert.equal(f.stalls.pausedUntil("C:/c"), null);
  assert.equal(f.stalls.pausedUntil("C:/b"), null);
  assert.equal(f.stalls.pausedUntil("C:/a"), 60_000);
});

test("refusals more than a minute apart pause only their own repositories", () => {
  const f = guard();
  f.stalls.refused("C:/a");
  f.advance(61_000);
  f.stalls.refused("C:/b");
  assert.equal(f.stalls.pausedUntil("C:/c"), null);
});

test("Try now ends every pause", () => {
  const f = guard();
  f.stalls.refused("C:/a"); f.stalls.refused("C:/b");
  f.stalls.resume();
  for (const key of ["C:/a", "C:/b", "C:/c"]) assert.equal(f.stalls.pausedUntil(key), null);
  assert.equal(f.stalls.refused("C:/a"), 60_000, "and the waits start again from a minute");
});
