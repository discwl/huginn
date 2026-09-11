import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryBrowser } from "./directory-browser.ts";

test("host browser pages folders with spaces and Unicode without reading source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gortex-browser-"));
  try {
    await mkdir(join(root, "a folder"));
    await mkdir(join(root, "b café"));
    await mkdir(join(root, "c folder"));
    await writeFile(join(root, "source.ts"), "should never be read");
    const browser = new DirectoryBrowser();
    const first = await browser.list({ path: root, limit: 2, filter: "", cursor: null });
    assert.deepEqual(first.entries.map(item => item.name), ["a folder", "b café"]);
    assert.ok(first.nextCursor);
    const second = await browser.list({ path: root, limit: 2, filter: "", cursor: first.nextCursor });
    assert.deepEqual(second.entries.map(item => item.name), ["c folder"]);
    const filtered = await browser.list({ path: root, limit: 100, filter: "CAFÉ", cursor: null });
    assert.deepEqual(filtered.entries.map(item => item.name), ["b café"]);
    await assert.rejects(browser.list({ path: root, limit: 2, filter: "other", cursor: first.nextCursor }), /expired|match|cursor/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing paths fail visibly and listing budgets report partial results", async () => {
  const root = await mkdtemp(join(tmpdir(), "gortex-browser-"));
  try {
    for (const name of ["one", "two", "three"]) await mkdir(join(root, name));
    const browser = new DirectoryBrowser({ scanLimit: 2 });
    assert.equal((await browser.list({ path: root, filter: "", limit: 100, cursor: null })).partial, true);
    await assert.rejects(browser.list({ path: join(root, "missing"), filter: "", limit: 100, cursor: null }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a junction is identified without recursively following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gortex-browser-"));
  try {
    await symlink(root, join(root, "loop"), process.platform === "win32" ? "junction" : "dir");
    const page = await new DirectoryBrowser().list({ path: root, limit: 100, filter: "", cursor: null });
    assert.equal(page.entries.find(item => item.name === "loop")?.isLink, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
