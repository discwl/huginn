import test from "node:test";
import assert from "node:assert/strict";
import { StallGuard } from "./stall-guard.ts";

function guard() {
  let clock = 0;
  const stalls = new StallGuard({ now: () => clock });
  return { stalls, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("occasional refusals never pause: answered, refused, answered keeps asking", () => {
  const f = guard();
  for (let i = 0; i < 10; i++) {
    assert.equal(f.stalls.refused("C:/a"), 0);
    f.stalls.answered("C:/a");
    f.advance(30_000);
  }
  assert.equal(f.stalls.pausedUntil("C:/a"), null);
  assert.deepEqual(f.stalls.tally(), { answered: 10, refused: 10, windowMs: 600_000 });
});

test("a repository that refuses three times in a row pauses, then for doubling waits up to 5 minutes", () => {
  const f = guard();
  assert.equal(f.stalls.refused("C:/a"), 0);
  assert.equal(f.stalls.refused("C:/a"), 0);
  assert.equal(f.stalls.refused("C:/a"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/a"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/b"), null, "one repository's refusals don't pause another");
  f.advance(60_000);
  assert.equal(f.stalls.pausedUntil("C:/a"), null, "the pause ends on time");
  const waits = [f.stalls.refused("C:/a")];
  for (let i = 0; i < 4; i++) waits.push(f.stalls.refused("C:/a"));
  assert.deepEqual(waits, [120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("an answer resets a repository's streak and ends its pause", () => {
  const f = guard();
  f.stalls.refused("C:/a"); f.stalls.refused("C:/a");
  f.stalls.answered("C:/a");
  assert.equal(f.stalls.refused("C:/a"), 0, "the streak starts over");
  f.stalls.refused("C:/a"); assert.equal(f.stalls.refused("C:/a"), 60_000);
  f.stalls.answered("C:/a");
  assert.equal(f.stalls.pausedUntil("C:/a"), null);
});

test("the whole host pauses only when three repositories refuse and nothing answers", () => {
  const f = guard();
  f.stalls.refused("C:/a"); f.advance(10_000);
  f.stalls.refused("C:/b"); f.advance(10_000);
  assert.equal(f.stalls.pausedUntil("C:/c"), null, "two refusing repositories are not enough");
  assert.equal(f.stalls.refused("C:/c"), 60_000);
  assert.equal(f.stalls.pausedUntil("C:/d"), 80_000, "every repository waits");
  f.stalls.answered("C:/b");
  assert.equal(f.stalls.pausedUntil("C:/d"), null, "an answer ends the host's pause");
});

test("one answer within the window keeps the host from pausing, however many repositories refuse", () => {
  const f = guard();
  f.stalls.answered("C:/z");
  for (const key of ["C:/a", "C:/b", "C:/c", "C:/d"]) { f.stalls.refused(key); f.advance(5_000); }
  assert.equal(f.stalls.pausedUntil("C:/e"), null);
  // Once that answer is older than the window, the same pattern does pause the host.
  f.advance(120_000);
  for (const key of ["C:/a", "C:/b", "C:/c"]) f.stalls.refused(key);
  assert.notEqual(f.stalls.pausedUntil("C:/e"), null);
});

test("Try now ends every pause and every streak", () => {
  const f = guard();
  for (let i = 0; i < 3; i++) { f.stalls.refused("C:/a"); f.stalls.refused("C:/b"); f.stalls.refused("C:/c"); }
  f.stalls.resume();
  for (const key of ["C:/a", "C:/b", "C:/c", "C:/d"]) assert.equal(f.stalls.pausedUntil(key), null);
  assert.equal(f.stalls.refused("C:/a"), 0, "streaks start again from zero");
});

test("the tally only covers the recent window", () => {
  const f = guard();
  f.stalls.refused("C:/a"); f.stalls.answered("C:/a");
  f.advance(11 * 60_000);
  f.stalls.answered("C:/a");
  assert.deepEqual(f.stalls.tally(), { answered: 1, refused: 0, windowMs: 600_000 });
});
