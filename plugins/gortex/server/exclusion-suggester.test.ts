import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExclusionSuggester, extractJson, normalizeSuggestion, type SuggestPaseo } from "./exclusion-suggester.ts";
import { gatherExclusionFacts, suggestionPrompt } from "./exclusion-facts.ts";
import type { ExclusionSources } from "../shared/exclusions.ts";

const sources: ExclusionSources = { global: ["**/.cache/"], local: [], include: [], legacyIndex: [], legacyWatch: [], respectGitignore: true };

async function repo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gx-suggest-")));
  await mkdir(join(root, "src")); await mkdir(join(root, "node_modules", "left-pad"), { recursive: true }); await mkdir(join(root, ".git"));
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n");
  for (let i = 0; i < 5; i++) await writeFile(join(root, "node_modules", "left-pad", `f${i}.js`), "");
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test("the folder survey counts files by folder, skips .git, and reads only .gitignore", async () => {
  const r = await repo();
  try {
    const facts = await gatherExclusionFacts(r.root, { repository: [], sources });
    assert.equal(facts.totals.files, 7); assert.equal(facts.totals.truncated, false);
    assert.deepEqual(facts.folders[0], { path: "node_modules/left-pad/", files: 5 });
    assert.ok(!facts.folders.some(folder => folder.path.startsWith(".git/")));
    assert.equal(facts.gitignore, "node_modules/\n");
    const prompt = suggestionPrompt(facts);
    assert.match(prompt, /node_modules\/left-pad\/ — 5 files/); assert.match(prompt, /Global: \*\*\/\.cache\//); assert.match(prompt, /Do not run tools/);
    const capped = await gatherExclusionFacts(r.root, { repository: [], sources }, { maxEntries: 3 });
    assert.equal(capped.totals.truncated, true);
  } finally { await r.close(); }
});

test("JSON is extracted from fenced or wrapped replies; prose without JSON is an error", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"exclude":[],"include":[],"notes":""}'), { exclude: [], include: [], notes: "" });
  assert.throws(() => extractJson("I recommend excluding bin."), /did not return a JSON object/);
});

test("invalid, negated, duplicate and already-configured rules are dropped individually", () => {
  const { suggestion, dropped } = normalizeSuggestion({
    exclude: [
      { pattern: "**/bin/", reason: "Build output", confidence: "high" },
      { pattern: "**/bin/", reason: "Duplicate", confidence: "high" },
      { pattern: "dist/", reason: "Already set", confidence: "high" },
      { pattern: "!keep", reason: "Negated", confidence: "low" },
      { pattern: "a\nb", reason: "Two lines", confidence: "low" },
      { reason: "No pattern" },
    ],
    include: [{ pattern: "generated/api/", reason: "Called by app code", confidence: "medium" }],
    notes: "ok",
  }, ["dist/"]);
  assert.deepEqual(suggestion.exclude.map(rule => rule.pattern), ["**/bin/"]);
  assert.deepEqual(suggestion.include.map(rule => rule.pattern), ["generated/api/"]);
  assert.equal(dropped.length, 5);
  assert.throws(() => normalizeSuggestion([], []), /not an object/);
});

test("exclusions that repeat a .gitignore line are dropped while Gortex respects .gitignore", () => {
  const { suggestion, dropped } = normalizeSuggestion({ exclude: [
    { pattern: ".venv/", reason: "Virtualenv", confidence: "high" },
    { pattern: "**/.venv/", reason: "Virtualenv anywhere", confidence: "medium" },
  ], include: [], notes: "" }, [], [".venv", "logs"]);
  assert.deepEqual(suggestion.exclude.map(rule => rule.pattern), ["**/.venv/"]);
  assert.match(dropped[0], /already in \.gitignore/);
});

function fakePaseo(options: { modes?: { id: string; label: string }[]; status?: "idle" | "permission" | "timeout" | "error"; reply?: string } = {}) {
  const calls: { create?: Parameters<SuggestPaseo["agents"]["create"]>[0]; prompt?: string; archived: number } = { archived: 0 };
  const paseo: SuggestPaseo = {
    providers: {
      listModes: async () => ({ modes: options.modes ?? [{ id: "default", label: "Always Ask" }, { id: "plan", label: "Plan Mode" }] }),
      listModels: async () => ({ models: [{ id: "claude-sonnet-5", thinkingOptions: [{ id: "low" }, { id: "high" }] }] }),
    },
    agents: {
      create: async config => {
        calls.create = config; calls.prompt = config.prompt;
        return {
          id: "agent-1",
          waitForFinish: async () => { return { status: options.status ?? "idle", error: options.status === "error" ? "provider crashed" : null, lastMessage: options.reply ?? JSON.stringify({ exclude: [{ pattern: "**/bin/", reason: "Build output", confidence: "high" }], include: [], notes: "" }) }; },
          archive: async () => { calls.archived++; return {}; },
        };
      },
    },
  };
  return { paseo, calls };
}
async function finished(service: ExclusionSuggester, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.job(id); if (job.stage === "done") return job; await delay(10); }
  throw new Error("Suggestion job did not finish");
}
const metadata = (root: string) => ({ read: async () => ({ path: root, extra: { exclude: ["dist/"] }, exclusionSources: sources }) });

test("a suggestion runs one read-only agent with structured output, then archives it", async () => {
  const r = await repo();
  try {
    const service = new ExclusionSuggester(metadata(r.root), async () => "claude/claude-sonnet-5");
    const { paseo, calls } = fakePaseo();
    const job = await finished(service, (await service.start(r.root, paseo)).id);
    assert.equal(job.outcome, "ready", job.error ?? undefined);
    assert.deepEqual(job.suggestion!.exclude.map(rule => rule.pattern), ["**/bin/"]);
    assert.equal(calls.create!.config.modeId, "plan"); assert.equal(calls.create!.config.thinkingOptionId, "low");
    assert.equal(calls.create!.config.provider, "claude/claude-sonnet-5"); assert.equal(calls.create!.cwd, r.root);
    assert.ok(calls.create!.outputSchema); assert.match(calls.prompt!, /This repository \(editable here\): dist\//); assert.match(calls.prompt!, /Reply with only one JSON object/);
    assert.equal(calls.archived, 1);
    assert.equal((await service.latestFor(r.root))!.id, job.id);
    await service.close();
  } finally { await r.close(); }
});

test("no read-only mode, a permission request, a timeout, or an unreadable reply all fail without suggestions", async () => {
  const r = await repo();
  try {
    const cases = [
      { options: { modes: [{ id: "full", label: "Full Access" }] }, error: /no plan or read-only mode/, archived: 0 },
      { options: { status: "permission" as const }, error: /asked to use a tool/, archived: 1 },
      { options: { status: "timeout" as const }, error: /did not answer/, archived: 1 },
      { options: { status: "error" as const }, error: /provider crashed/, archived: 1 },
      { options: { reply: "Exclude the bin folder." }, error: /did not return a JSON object/, archived: 1 },
    ];
    for (const { options, error, archived } of cases) {
      const service = new ExclusionSuggester(metadata(r.root), async () => "claude/claude-sonnet-5");
      const { paseo, calls } = fakePaseo(options);
      const job = await finished(service, (await service.start(r.root, paseo)).id);
      assert.equal(job.outcome, "failed"); assert.match(job.error!, error); assert.equal(job.suggestion, null);
      assert.equal(calls.archived, archived);
      await service.close();
    }
  } finally { await r.close(); }
});

test("asking again while a suggestion is running returns the same job", async () => {
  const r = await repo();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new ExclusionSuggester(metadata(r.root), async () => "claude/claude-sonnet-5", { gather: async (root, current) => { await gate; return gatherExclusionFacts(root, current); } });
    const { paseo } = fakePaseo();
    const first = await service.start(r.root, paseo), second = await service.start(r.root, paseo);
    assert.equal(first.id, second.id);
    release(); await finished(service, first.id); await service.close();
  } finally { await r.close(); }
});
