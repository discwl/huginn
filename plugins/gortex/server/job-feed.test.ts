import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { defineSubscription } from "@getpaseo/plugin";
import { followJobs, jobId, type JobFeedSources } from "./job-feed.ts";
import { jobFeedContract, jobFeedEventSchema, jobFeedKinds, jobFeedSubscription, type JobFeedEvent } from "../shared/job-feed-contracts.ts";

type Fake = { read(id: string | undefined): unknown; final(state: unknown): boolean };
const unused: Fake = { read: () => { throw new Error("not followed in this test"); }, final: () => true };
const sources = (overrides: Partial<Record<(typeof jobFeedKinds)[number], Fake>>) =>
  ({ ...Object.fromEntries(jobFeedKinds.map(kind => [kind, unused])), ...overrides }) as unknown as JobFeedSources;
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5);
  assert.ok(condition(), "timed out waiting for the feed");
}

test("a feed pushes the job's state at once, each change once, then the final state, and ends", async () => {
  const job = { id: "job", stage: "running" };
  const events: JobFeedEvent[] = [];
  const feed = followJobs(sources({ track: { read: id => ({ ...job, id }), final: state => (state as typeof job).stage === "done" } }), 5);
  const finished = feed({ kind: "track", id: "job" }, { push: async event => { events.push(event); }, signal: new AbortController().signal });
  await until(() => events.length === 1);
  await delay(30);
  assert.equal(events.length, 1, "an unchanged state is not pushed again");
  job.stage = "verifying";
  await until(() => events.length === 2);
  job.stage = "done";
  await finished;
  assert.deepEqual(events.map(event => [event.kind, (event.state as typeof job).stage]), [["track", "running"], ["track", "verifying"], ["track", "done"]]);
});

test("a feed with no final state, like auto-index activity, ends when the subscriber leaves", async () => {
  const records: string[] = [];
  const controller = new AbortController();
  const events: JobFeedEvent[] = [];
  const finished = followJobs(sources({ "auto-index": { read: () => ({ records: [...records] }), final: () => false } }), 5)({ kind: "auto-index" }, { push: async event => { events.push(event); }, signal: controller.signal });
  await until(() => events.length === 1);
  records.push("C:/a");
  await until(() => events.length === 2);
  controller.abort();
  await finished;
  assert.equal(events.length, 2);
});

test("an expired job or a missing id closes the feed with the error, so the panel falls back to polling", async () => {
  const push = async () => {};
  const signal = new AbortController().signal;
  const expired = followJobs(sources({ metadata: { read: () => { throw new Error("This job is no longer retained."); }, final: () => true } }), 5);
  await assert.rejects(expired({ kind: "metadata", id: "gone" }, { push, signal }), /no longer retained/);
  const needsId = followJobs(sources({ untrack: { read: id => jobId(id), final: () => true } }), 5);
  await assert.rejects(needsId({ kind: "untrack" }, { push, signal }), /needs its id/);
  // A push the host refuses (an event that fails validation) closes the feed the same way.
  const refused = followJobs(sources({ picker: { read: () => ({ id: "x" }), final: () => false } }), 5);
  await assert.rejects(refused({ kind: "picker", id: "x" }, { push: async () => { throw new Error("invalid event"); }, signal }), /invalid event/);
});

test("on a Paseo older than 0.16 there is no subscription contract, and panels keep polling", () => {
  assert.equal(jobFeedContract(undefined), null);
  assert.ok(jobFeedSubscription, "the 0.16 SDK defines it");
  assert.equal(jobFeedContract(defineSubscription)?.name, "jobs.follow");
});

test("each kind's event carries exactly what its polling RPC answers", () => {
  assert.deepEqual(jobFeedEventSchema.options.map(option => option.shape.kind.value), [...jobFeedKinds]);
  assert.ok(jobFeedEventSchema.safeParse({ kind: "auto-index", state: { records: [] } }).success);
  assert.ok(jobFeedEventSchema.safeParse({ kind: "update", state: null }).success, "no update job yet");
  assert.ok(jobFeedEventSchema.safeParse({ kind: "picker", state: { id: "4c4a6c1e-4f43-4cf5-9a4e-5b8f0f6d5c11", state: "open", path: null, error: null } }).success);
  assert.ok(!jobFeedEventSchema.safeParse({ kind: "picker", state: { records: [] } }).success, "a state for another kind is refused");
});
