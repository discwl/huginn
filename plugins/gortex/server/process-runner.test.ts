import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runProcess } from "./process-runner.ts";

test("argv containing shell metacharacters stays literal", async () => {
  const literal = "spaces café & $(echo secret) ; `hello`";
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "--", literal], tmpdir());
  assert.equal(result, literal);
});

test("output limits and timeouts reject instead of returning partial success", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], tmpdir(), { maxBytes: 100 }), /size bound/);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], tmpdir(), { timeoutMs: 100 }), /timed out/);
});
