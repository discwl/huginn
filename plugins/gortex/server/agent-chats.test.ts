import test from "node:test";
import assert from "node:assert/strict";
import { reopenIdleChats, surveyChats } from "./agent-chats.ts";
import { fakeChats } from "./chats-fixture.ts";

const host = [
  { id: "aaaaaaaa-1", title: "Fix login" },
  { id: "bbbbbbbb-2", title: "Release notes", status: "running", activeTurn: { id: "t" } },
  { id: "cccccccc-3", title: "Migration", pendingPermissions: [{ id: "p" }] },
  { id: "dddddddd-4", title: "Starting", status: "initializing" },
  { id: "eeeeeeee-5", title: "Released", status: "closed" },
  { id: "ffffffff-6", title: "Archived", archivedAt: "2026-10-28T10:00:00Z" },
  { id: "99999999-7", title: "  " },
];

test("on Paseo 0.13, which can't reopen a chat, nothing is reopened", async () => {
  const f = fakeChats(host, { reload: false });
  assert.equal(await reopenIdleChats(f.paseo), null);
  assert.equal((await surveyChats(f.paseo)).reopenable, false);
  assert.deepEqual(f.reloaded, []);
});

test("only idle chats are reopened; busy and waiting chats are listed, released and archived ones left out", async () => {
  const f = fakeChats(host);
  const result = (await reopenIdleChats(f.paseo))!;
  assert.deepEqual(f.reloaded, ["aaaaaaaa-1", "99999999-7"]);
  assert.deepEqual(result.reopened, ["Fix login", "agent 9999999"]);
  assert.deepEqual(result.busy, ["Release notes", "Migration", "Starting"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.summary, "Reopened 2 idle chats so they use the current Gortex tools. 3 busy chats keep the previous Gortex tools until they're restarted: Release notes, Migration, Starting.");
});

test("a chat that starts a turn after the list isn't interrupted, and one that fails to reopen is reported", async () => {
  const f = fakeChats([{ id: "a1", title: "Busy now" }, { id: "b2", title: "Broken" }, { id: "c3", title: "Fine" }], { startTurn: ["a1"], failing: ["b2"] });
  const result = (await reopenIdleChats(f.paseo))!;
  assert.deepEqual(f.reloaded, ["c3"]);
  assert.deepEqual(result.busy, ["Busy now"]);
  assert.deepEqual(result.failed, ["Broken (the provider didn't start)"]);
  assert.match(result.summary, /^Reopened 1 idle chat so it uses the current Gortex tools\. 1 busy chat keeps the previous Gortex tools until it's restarted: Busy now\. 1 chat couldn't be reopened; restart it: Broken/);
});

test("with no open chat there's nothing to reopen, whatever the Paseo version", async () => {
  for (const reload of [true, false]) {
    const f = fakeChats([{ id: "x", status: "closed" }], { reload });
    assert.equal((await surveyChats(f.paseo)).reopenable, null);
    assert.equal((await reopenIdleChats(f.paseo))!.summary, "No agent chats were open, so none needed reopening.");
  }
});

test("every page of chats is read", async () => {
  const f = fakeChats(Array.from({ length: 5 }, (_, i) => ({ id: `chat-${i}` })), { pageSize: 2 });
  await reopenIdleChats(f.paseo);
  assert.deepEqual(f.pages, [undefined, "2", "4"]);
  assert.equal(f.reloaded.length, 5);
});

test("whether Paseo releases idle chats follows its setting, which is on unless turned off", async () => {
  assert.equal((await surveyChats(fakeChats(host).paseo)).releasesIdle, true);
  assert.equal((await surveyChats(fakeChats(host, { config: { idleRuntimeCleanup: false } }).paseo)).releasesIdle, false);
  assert.equal((await surveyChats(fakeChats(host, { config: () => Promise.reject(new Error("no config")) }).paseo)).releasesIdle, null);
  assert.equal((await surveyChats(fakeChats(host, { reload: false }).paseo)).releasesIdle, null, "not asked where chats can't be reopened");
});

test("chats in background workspaces aren't reopened: Paseo's idle release retires them safely", async () => {
  const f = fakeChats([{ id: "a1", title: "Visible" }, { id: "b2", title: "Background worker", background: true }]);
  assert.deepEqual((await reopenIdleChats(f.paseo))!.reopened, ["Visible"]);
  assert.deepEqual(f.reloaded, ["a1"]);
  assert.ok(f.filters.every(filter => !filter?.includeBackground), "background chats are never asked for");
});

test("a chat with background work isn't reopened, whether it was listed with it or started it after the list", async () => {
  const f = fakeChats([{ id: "a1", title: "Shell running", backgroundWork: { count: 2 } }, { id: "b2", title: "Started a shell" }, { id: "c3", title: "Quiet" }], { startBackgroundWork: ["b2"] });
  const result = (await reopenIdleChats(f.paseo))!;
  assert.deepEqual(f.reloaded, ["c3"]);
  assert.deepEqual(result.busy, ["Shell running", "Started a shell"]);
});
