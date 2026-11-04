import test from "node:test";
import assert from "node:assert/strict";
import { contractRepairEvidence } from "./contract-repair-evidence.ts";

const now = Date.UTC(2026, 10, 3, 14, 30);
const error = "contract boundary receipt: missing accepted function span app/src/slice.js::loadOptions";
const event = (secondsAgo: number, overrides: Record<string, unknown> = {}) => JSON.stringify({
  ts: (now - secondsAgo * 1000) / 1000, msg: "contract stuck repair", repo: "app", kind: "pending_header", outcome: "failed", error, ...overrides,
});

test("recurring baseline failures retain cadence and do not claim queued jobs or CPU causation", () => {
  const check = contractRepairEvidence([event(20), event(60), event(40)].join("\n"), now)!;
  assert.equal(check.id, "contract-repairs");
  assert.equal(check.state, "warn");
  assert.match(check.detail, /3 failed contract repair attempts/);
  assert.match(check.detail, /repository contract baseline error occurred 3 times/);
  assert.match(check.detail, /Median interval: 20 seconds/);
  assert.match(check.detail, /not queued build counts/);
  assert.match(check.detail, /causation are separate checks/);
  assert.match(check.evidence!, /loadOptions/);
});

test("old, future, malformed and unrelated logs cannot establish a current repair failure", () => {
  const log = ["not JSON", "null", "[]", event(901), event(-1), event(10, { ts: null }), event(10, { ts: "invalid" }), event(10, { msg: "other event" }), event(10, { repo: "" }), event(10, { kind: null }), event(10, { outcome: "busy" })].join("\n");
  assert.equal(contractRepairEvidence(log, now), null);
  assert.equal(contractRepairEvidence(null, now), null);
  assert.equal(contractRepairEvidence("", now), null);
  assert.equal(contractRepairEvidence(event(10), NaN), null);
});

test("duplicate events are counted once across numeric and ISO timestamps", () => {
  const numeric = event(10);
  const iso = event(10, { ts: new Date(now - 10_000).toISOString(), msg: "daemon: contract stuck repair" });
  const check = contractRepairEvidence([numeric, numeric, iso].join("\n"), now)!;
  assert.match(check.detail, /1 failed contract repair attempt/);
  assert.doesNotMatch(check.detail, /Median interval/);
});

test("a healed file or another scope's success cannot clear a failed baseline", () => {
  const check = contractRepairEvidence([
    event(60), event(40),
    event(20, { outcome: "healed", kind: undefined, paths: ["app/src/slice.js"] }),
    event(15, { outcome: "repaired", kind: "stuck_receipt" }),
    event(10, { outcome: "repaired", repo: "other-app" }),
  ].join("\n"), now)!;
  assert.match(check.detail, /No later successful repair/);
});

test("a later repair is reported without certifying current contract availability", () => {
  const check = contractRepairEvidence([event(40), event(20, { outcome: "repaired" })].join("\n"), now)!;
  assert.equal(check.state, "warn");
  assert.match(check.detail, /A later successful repair was logged/);
  assert.match(check.detail, /availability still needs verification/);
});

test("a new failure after success stays unresolved regardless of log order", () => {
  const check = contractRepairEvidence([event(10), event(40), event(20, { outcome: "repaired" })].join("\n"), now)!;
  assert.match(check.detail, /No later successful repair/);
});

test("an unresolved repository remains visible when another one recovered", () => {
  const check = contractRepairEvidence([
    event(80), event(60), event(40), event(20, { outcome: "repaired" }),
    event(15, { repo: "still-failing", error: "different error" }),
  ].join("\n"), now)!;
  assert.match(check.detail, /4 failed contract repair attempts/);
  assert.match(check.detail, /still-failing/);
  assert.match(check.detail, /No later successful repair/);
});

test("evidence is bounded and rendered on one line", () => {
  const check = contractRepairEvidence(event(1, { error: "bad\n".repeat(1000) }), now)!;
  assert.ok(check.evidence!.length <= 400);
  assert.doesNotMatch(check.evidence!, /[\r\n]/);
});
