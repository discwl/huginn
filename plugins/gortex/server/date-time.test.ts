import test from "node:test";
import assert from "node:assert/strict";
import { createDateTimeFormatter } from "../shared/date-time.ts";

const pacific = createDateTimeFormatter({ locale: "en-US", timeZone: "America/Los_Angeles" });
test("friendly timestamps use the selected host zone and preserve the represented instant", () => {
  const timestamp = "2026-09-11T20:44:25-07:00";
  assert.match(pacific(timestamp), /Sep 11, 2026.*8:44.*PM.*PDT/);
  assert.equal(pacific(timestamp), pacific("2026-09-12T03:44:25Z"));
  const tokyo = createDateTimeFormatter({ locale: "en-US", timeZone: "Asia/Tokyo" });
  assert.match(tokyo(timestamp), /Sep 12, 2026.*12:44.*PM/);
  assert.match(pacific(timestamp), /Sep 11, 2026.*8:44.*PM/);
});
test("the zone offset follows daylight saving at the timestamp, not today's offset", () => {
  assert.match(pacific("2026-03-08T09:30:00Z"), /1:30.*AM.*PST/);
  assert.match(pacific("2026-03-08T10:30:00Z"), /3:30.*AM.*PDT/);
  assert.match(pacific("2026-11-01T08:30:00Z"), /1:30.*AM.*PDT/);
  assert.match(pacific("2026-11-01T09:30:00Z"), /1:30.*AM.*PST/);
});
test("missing and invalid timestamps never produce a misleading date", () => {
  assert.equal(pacific(null), "Not reported");
  assert.equal(pacific(""), "Not reported");
  assert.equal(pacific("0001-01-01T00:00:00Z"), "Not reported");
  assert.equal(pacific("invalid"), "Invalid timestamp");
  assert.equal(pacific("2026-09-11T20:44:25"), "Invalid timestamp");
});
test("unavailable or unsupported host time zones use explicitly labeled UTC", () => {
  for (const config of [null, { locale: "en-US", timeZone: "Not/AZone" }]) {
    assert.match(createDateTimeFormatter(config)("2026-09-12T03:44:25Z"), /Sep 12, 2026.*3:44.*AM.*UTC.*host time zone unavailable/);
  }
});
