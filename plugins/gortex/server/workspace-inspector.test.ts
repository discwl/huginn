import assert from "node:assert/strict";
import test from "node:test";
import { inspectionSearchContext, inspectorScope, scopedInspectorState, workspaceInspectionSummary } from "../shared/workspace-inspector.ts";
import type { Inspection } from "../shared/models.ts";

const inspection: Inspection = {
  selectedPath: "C:/work/feature", canonicalPath: "C:/work/feature", repositoryRoot: "C:/work/feature",
  gitDirectoryKind: "file", tracking: "not-in-catalog", repository: null, warnings: [], observedAt: "2026-10-26T18:00:00Z",
};

test("panel selection persists only for the same host, workspace, and directory", () => {
  const scope = inspectorScope("personal", "workspace", "C:/work/feature");
  const saved = { scope, section: "details", search: { query: "Worker", selection: { symbol: { id: "repo/file::Worker", name: "Worker", kind: "function", filePath: "repo/file", line: 5 }, operation: "callers" } } };
  assert.deepEqual(scopedInspectorState(saved, scope), saved);
  for (const changed of [
    inspectorScope("remote", "workspace", "C:/work/feature"),
    inspectorScope("personal", "other", "C:/work/feature"),
    inspectorScope("personal", "workspace", "C:/work/main"),
  ]) assert.deepEqual(scopedInspectorState(saved, changed), { scope: changed, section: "context", search: { query: "", selection: null } });
  assert.deepEqual(scopedInspectorState({ scope, section: "obsolete" }, scope), { scope, section: "context", search: { query: "", selection: null } });
  assert.deepEqual(scopedInspectorState(undefined, scope), { scope, section: "context", search: { query: "", selection: null } });
});

test("worktree evidence never implies dedicated tracking or exact checkout readiness", () => {
  assert.equal(workspaceInspectionSummary(inspection).label, "Checkout needs verification");
  const repository = {
    name: "main", path: "C:/work/main", declaredWorkspace: "personal", declaredProject: "test", assignmentSource: "config",
    workspaceId: "personal", projectId: "test", graphName: "main", state: "resolved" as const, error: null,
  };
  assert.equal(workspaceInspectionSummary({ ...inspection, tracking: "dedicated", repository }).label, "Checkout needs verification");
  assert.match(workspaceInspectionSummary({ ...inspection, gitDirectoryKind: "directory", repository }).detail, /Exact checkout selection and index freshness have not been verified/);
  assert.equal(workspaceInspectionSummary({ ...inspection, gitDirectoryKind: "directory", repository: { ...repository, error: "Gortex is busy" } }).label, "Gortex context unavailable");
  assert.equal(inspectionSearchContext({ ...inspection, repository }), null);
  assert.equal(inspectionSearchContext({ ...inspection, gitDirectoryKind: "directory", repository }), null, "another primary directory cannot authorize search");
  const matching = { ...repository, path: inspection.canonicalPath };
  assert.deepEqual(inspectionSearchContext({ ...inspection, gitDirectoryKind: "directory", repository: matching }), { repositoryPath: matching.path, workspaceId: matching.workspaceId });
  assert.equal(inspectionSearchContext({ ...inspection, gitDirectoryKind: "directory", repository: { ...matching, error: "busy" } }), null);
  assert.equal(inspectionSearchContext({ ...inspection, repository: matching }), null, "worktrees cannot use the primary-only search contract");
});

test("missing catalog membership is not reported as an untracked automatic worktree", () => {
  const result = workspaceInspectionSummary({ ...inspection, gitDirectoryKind: "directory" });
  assert.equal(result.label, "Outside the dedicated catalog");
  assert.match(result.detail, /does not rule out an automatic worktree/);
  assert.equal(workspaceInspectionSummary({ ...inspection, gitDirectoryKind: "unknown", tracking: "unknown" }).label, "Context unavailable");
});
