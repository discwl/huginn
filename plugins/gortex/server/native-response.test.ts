import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeResult } from "./native-response.ts";

test("accepts structured JSON and retains native provenance", () => {
  const result = decodeNativeResult({ structuredContent: { results: [], truncated: true }, _meta: { freshness: { exact: true } }, content: [] });
  assert.deepEqual(result.value, { results: [], truncated: true });
  assert.deepEqual(result.meta, { freshness: { exact: true } });
});

test("accepts a single JSON text result", () => {
  assert.deepEqual(decodeNativeResult({ content: [{ type: "text", text: '{"workspace":"team"}' }] }).value, { workspace: "team" });
});

test("native errors and malformed results cannot become empty success", () => {
  for (const result of [
    { isError: true, content: [{ type: "text", text: "failed" }] },
    { content: [{ type: "text", text: '{"error_code":"wrong_scope","message":"wrong workspace"}' }] },
    { structuredContent: { error: "no such repository" }, content: [] },
    { content: [{ type: "text", text: "not json" }] },
    { content: [] },
  ]) assert.throws(() => decodeNativeResult(result));
});

test("an inexact route is rejected, including nested response metadata", () => {
  assert.throws(() => decodeNativeResult({ structuredContent: { results: [] }, _meta: { freshness: { exact: false, fallback: "base" } } }), /exact|fallback/i);
  assert.throws(() => decodeNativeResult({ structuredContent: { freshness: { exact: false }, results: [] } }), /exact|fallback/i);
});
