import test from "node:test";
import assert from "node:assert/strict";
import { chooseRepository, chooseWorkspace, selectedRepository } from "../shared/selection.ts";

const repos = [
  { name: "huginn", path: "C:\\huginn", workspaceId: "huginn", state: "resolved" },
  { name: "huginn", path: "D:\\other", workspaceId: "other", state: "resolved" },
];

test("clicking a workspace with one repository opens that repository's tools", () => {
  assert.equal(selectedRepository(repos, null), null);
  const selection = chooseWorkspace(repos, "huginn");
  assert.equal(selectedRepository(repos, selection)?.path, "C:\\huginn");
  assert.deepEqual(chooseRepository(repos, "C:\\huginn"), selection);
});

test("multiple members require an explicit repository choice", () => {
  const members = [...repos, { name: "second", path: "C:\\second", workspaceId: "huginn", state: "resolved" }];
  const selection = chooseWorkspace(members, "huginn");
  assert.equal(selection?.repositoryPath, null);
  assert.equal(selectedRepository(members, selection), null);
  assert.equal(selectedRepository(members, chooseRepository(members, "C:\\second"))?.name, "second");
});

test("refresh cannot substitute another workspace or an unavailable repository", () => {
  const selection = chooseRepository(repos, "C:\\huginn");
  assert.equal(selectedRepository(repos.slice(1), selection), null);
  assert.equal(selectedRepository([{ ...repos[0], workspaceId: "moved" }], selection), null);
  assert.equal(selectedRepository([{ ...repos[0], state: "unavailable" }], selection), null);
  assert.equal(chooseRepository(repos, "C:\\missing"), null);
  assert.equal(chooseWorkspace(repos, "missing"), null);
});
