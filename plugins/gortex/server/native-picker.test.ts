import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { spawn } from "node:child_process";
import { NativeFolderPicker } from "./native-picker.ts";
import { WINDOWS_PICKER_SCRIPT } from "./windows-dialog.ts";

class Helper extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); killed = 0;
  kill() { this.killed++; queueMicrotask(() => this.emit("close", null)); return true; }
  reply(value: unknown) { this.stdout.write(JSON.stringify(value)); this.emit("close", 0); }
}
function harness(timeoutMs = 1000) {
  const children: Helper[] = [];
  const launches: unknown[][] = [];
  const launch = ((...args: unknown[]) => { const child = new Helper(); children.push(child); launches.push(args); return child; }) as unknown as typeof spawn;
  const picker = new NativeFolderPicker({ platform: "win32", probe: async () => true, spawn: launch, timeoutMs });
  return { picker, children, launches };
}
async function settled(picker: NativeFolderPicker, id: string) {
  for (let attempts = 0; attempts < 100; attempts++) { const result = picker.poll(id); if (result.state !== "open") return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Picker result did not settle");
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gortex-picker-"));
  try { await run(root); } finally { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }
}

test("native folder paths are literal data and UTF-8 survives split output chunks", async () => fixture(async root => {
  const chosen = join(root, "Résumé Δ & $(literal)"); await mkdir(chosen);
  const { picker, children, launches } = harness();
  try {
    const { id } = await picker.start(chosen);
    const [binary, args, options] = launches[0] as [string, string[], { shell: boolean; windowsHide: boolean; env: Record<string, string> }];
    assert.equal(binary, "pwsh.exe"); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.env.PASEO_GORTEX_PICKER_START, await realpath(chosen));
    assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), WINDOWS_PICKER_SCRIPT);
    assert.equal(args.includes(chosen), false);
    const reply = Buffer.from(JSON.stringify({ state: "selected", path: chosen }), "utf8");
    const cut = reply.indexOf(Buffer.from("é")) + 1;
    children[0].stdout.write(reply.subarray(0, cut)); children[0].stdout.write(reply.subarray(cut)); children[0].emit("close", 0);
    assert.deepEqual(await settled(picker, id), { id, state: "selected", path: await realpath(chosen), error: null });
  } finally { picker.close(); }
}));

test("repeated clicks create one dialog and cancellation kills only its helper", async () => fixture(async root => {
  const { picker, children } = harness();
  try {
    const starts = await Promise.allSettled([picker.start(root), picker.start(root)]);
    assert.equal(starts[0].status, "fulfilled"); assert.equal(starts[1].status, "rejected"); assert.equal(children.length, 1);
    if (starts[0].status !== "fulfilled") throw new Error("Expected first start to succeed");
    const { id } = starts[0].value;
    assert.equal(picker.cancel(id).cancelled, true); assert.equal(children[0].killed, 1);
    assert.equal(picker.poll(id).state, "cancelled"); assert.equal(picker.cancel(id).cancelled, false);
    assert.equal(picker.cancel("unrelated-id").cancelled, false);
  } finally { picker.close(); }
}));

test("native cancellation, invalid results and missing folders are not successful selections", async () => fixture(async root => {
  const { picker, children } = harness();
  try {
    const cancelled = await picker.start(root); children[0].reply({ state: "cancelled", path: null });
    assert.equal((await settled(picker, cancelled.id)).state, "cancelled");
    const malformed = await picker.start(root); children[1].reply({ state: "selected", path: 42 });
    assert.equal((await settled(picker, malformed.id)).state, "error");
    const missing = await picker.start(root); children[2].reply({ state: "selected", path: join(root, "missing") });
    assert.equal((await settled(picker, missing.id)).state, "error");
  } finally { picker.close(); }
}));

test("timeout and plugin shutdown release outstanding dialogs", async () => fixture(async root => {
  const { picker, children } = harness(15);
  try {
    const { id } = await picker.start(root);
    assert.equal((await settled(picker, id)).state, "error"); assert.equal(children[0].killed, 1);
    await picker.start(root); picker.close(); assert.equal(children[1].killed, 1);
    await assert.rejects(picker.start(root), /stopping/);
  } finally { picker.close(); }
}));

test("headless and non-Windows hosts report picker unavailability without starting a dialog", async () => {
  const unsupported = new NativeFolderPicker({ platform: "linux", probe: async () => { throw new Error("must not probe"); } });
  assert.equal((await unsupported.capabilities()).available, false);
  await assert.rejects(unsupported.start(), /Windows host/); unsupported.close();
  const headless = new NativeFolderPicker({ platform: "win32", probe: async () => false });
  assert.equal((await headless.capabilities()).available, false);
  await assert.rejects(headless.start(), /interactive Windows desktop/); headless.close();
});

test("shutdown during capability discovery cannot launch a late dialog", async () => {
  let release!: (available: boolean) => void;
  let launches = 0;
  const picker = new NativeFolderPicker({ platform: "win32", probe: () => new Promise(resolve => { release = resolve; }), spawn: (() => { launches++; throw new Error("unexpected launch"); }) as unknown as typeof spawn });
  const pending = picker.start(tmpdir()); picker.close(); release(true);
  await assert.rejects(pending, /stopping/); assert.equal(launches, 0);
});
