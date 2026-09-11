import test from "node:test";
import assert from "node:assert/strict";
import { catalogInputSchema, pageAssignments } from "../shared/catalog-browser.ts";
import type { NativeAssignment } from "../shared/models.ts";

const rows: NativeAssignment[] = Array.from({ length: 137 }, (_, index) => ({
  repo: `repo-${index}`, path: `C:/Code/repo-${index}`,
  workspace: index < 65 ? "personal" : "xendee", project: index % 2 ? "operate" : "web", source: "global",
}));
const input = (options = {}) => catalogInputSchema.parse(options);

test("repository search finds matches beyond the old 50-row catalog page", () => {
  const page = pageAssignments(rows, input({ query: "REPO-136", limit: 12 }));
  assert.equal(page.total, 137);
  assert.equal(page.filteredTotal, 1);
  assert.deepEqual(page.rows.map(row => row.repo), ["repo-136"]);
  assert.equal(page.nextOffset, null);
  assert.deepEqual(page.workspaces, [{ value: "personal", count: 65 }, { value: "xendee", count: 72 }]);
});

test("filtering precedes pagination and every matching repository is reachable exactly once", () => {
  const expected = rows.filter(row => row.workspace === "xendee" && row.project === "operate");
  const actual: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageAssignments(rows, input({ workspace: "xendee", project: "operate", limit: 12, offset }));
    assert.equal(page.filteredTotal, expected.length);
    assert.ok(page.rows.length <= 12);
    actual.push(...page.rows.map(row => row.path));
    offset = page.nextOffset;
  }
  assert.deepEqual(actual, expected.map(row => row.path));
  assert.equal(new Set(actual).size, actual.length);
});

test("configured labels remain exact values, including defaults and explicitly unset fields", () => {
  const catalog = [
    { ...rows[0], workspace: "(default: repo-0)", project: "" },
    { ...rows[1], workspace: "repo-0", project: "" },
    { ...rows[2], workspace: "Repo-0", project: "web" },
  ];
  assert.deepEqual(pageAssignments(catalog, input({ workspace: "repo-0" })).rows, [catalog[1]]);
  assert.deepEqual(pageAssignments(catalog, input({ workspace: "(default: repo-0)" })).rows, [catalog[0]]);
  assert.equal(pageAssignments(catalog, input({ project: "" })).filteredTotal, 2);
  assert.equal(pageAssignments(catalog, input({ workspace: null })).filteredTotal, 3);
});

test("search handles Unicode and paths without changing the native path or scope", () => {
  const row = { ...rows[0], repo: "Café service", path: "C:/My Code/日本語", workspace: "personal", project: "billing" };
  const page = pageAssignments([row], input({ query: "CAFE\u0301 日本語 billing" }));
  assert.deepEqual(page.rows, [row]);
  assert.equal(pageAssignments([row], input({ query: "café missing" })).filteredTotal, 0);
});

test("sorting is stable across duplicate names and never mutates the authoritative catalog", () => {
  const original = [{ ...rows[2], repo: "same", path: "C:/b" }, { ...rows[0], repo: "same", path: "C:/a" }];
  const before = structuredClone(original);
  const sorted = pageAssignments(original, input());
  assert.deepEqual(sorted.rows.map(row => row.path), ["C:/a", "C:/b"]);
  assert.deepEqual(original, before);
  assert.deepEqual(pageAssignments(rows, input({ offset: 8, limit: 4 })).rows.map(row => row.repo), ["repo-8", "repo-9", "repo-10", "repo-11"]);
});

test("metadata moves and removals reconcile a now-empty final page", () => {
  const page = pageAssignments(rows.slice(0, 13), input({ offset: 132, limit: 12 }));
  assert.equal(page.offset, 12);
  assert.equal(page.rows[0].repo, "repo-12");
  assert.equal(page.nextOffset, null);
  const empty = pageAssignments([], input({ offset: 132, limit: 12 }));
  assert.equal(empty.offset, 0);
  assert.equal(empty.filteredTotal, 0);
  assert.deepEqual(empty.rows, []);
});

test("catalog inputs enforce budgets and reject unknown sort modes", () => {
  for (const invalid of [{ query: "x".repeat(201) }, { limit: 51 }, { offset: -1 }, { workspace: "x".repeat(501) }, { sort: "status" }])
    assert.equal(catalogInputSchema.safeParse(invalid).success, false);
});
