import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { exclusionSuggestionJsonSchema, ruleSuggestionSchema, type ExclusionSuggestion, type RuleSuggestion, type SuggestJob } from "../shared/exclusion-suggest-contracts.ts";
import type { ExclusionSources } from "../shared/exclusions.ts";
import { gatherExclusionFacts, suggestionPrompt, type ExclusionFacts } from "./exclusion-facts.ts";

/** The subset of the plugin's Paseo SDK this feature uses; the real `paseo` context satisfies it. */
export interface SuggestAgentHandle {
  readonly id: string;
  waitForFinish(timeoutMs?: number): Promise<{ status: "idle" | "error" | "permission" | "timeout"; error: string | null; lastMessage: string | null }>;
  archive(): Promise<unknown>;
}
export interface SuggestPaseo {
  providers: {
    listModes(provider: string): Promise<{ modes?: { id: string; label: string }[]; error?: string | null }>;
    listModels(provider: string): Promise<{ models?: { id: string; thinkingOptions?: { id: string }[] }[]; error?: string | null }>;
  };
  agents: { create(options: { cwd: string; title?: string; config: { provider: string; modeId?: string; thinkingOptionId?: string; systemPrompt?: string }; prompt?: string; outputSchema?: Record<string, unknown>; labels?: Record<string, string> }): Promise<SuggestAgentHandle> };
}
export interface SuggestMetadata { read(path: string): Promise<{ path: string; extra: { exclude: string[] }; exclusionSources: ExclusionSources }> }
export interface SuggesterOptions {
  gather?: (root: string, current: ExclusionFacts["current"]) => Promise<ExclusionFacts>;
  timeoutMs?: number;
}

const message = (error: unknown) => error instanceof Error ? error.message : "The suggestion agent failed.";
const readOnlyMode = /\b(plan|read[- ]?only)\b/i;

/** Pulls the JSON object out of a reply that may be wrapped in a code fence or a sentence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The agent did not return a JSON object.");
  return JSON.parse(body.slice(start, end + 1));
}

/** Validates each rule on its own, so one bad pattern drops that rule instead of the whole answer. */
export function normalizeSuggestion(raw: unknown, existing: string[], gitignored: string[] = []): { suggestion: ExclusionSuggestion; dropped: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The agent's answer was not an object.");
  const record = raw as Record<string, unknown>, dropped: string[] = [];
  const known = new Set(existing.map(pattern => pattern.trim()));
  const ignoredSet = new Set(gitignored.map(pattern => pattern.replace(/\/$/, "")));
  const rules = (value: unknown, kind: "exclude" | "include", limit: number): RuleSuggestion[] => {
    const out: RuleSuggestion[] = [];
    for (const item of Array.isArray(value) ? value : []) {
      const parsed = ruleSuggestionSchema.safeParse(item);
      const label = typeof (item as { pattern?: unknown })?.pattern === "string" ? (item as { pattern: string }).pattern : "(unreadable rule)";
      if (!parsed.success) { dropped.push(`${label}: not a valid single pattern`); continue; }
      const pattern = parsed.data.pattern.trim(), applied = kind === "include" ? `!${pattern}` : pattern;
      if (known.has(applied)) { dropped.push(`${applied}: already configured for this repository`); continue; }
      if (kind === "exclude" && ignoredSet.has(pattern.replace(/\/$/, ""))) { dropped.push(`${applied}: already in .gitignore, which Gortex respects`); continue; }
      if (out.length >= limit) { dropped.push(`${applied}: over the ${limit}-rule limit`); continue; }
      known.add(applied); out.push({ ...parsed.data, pattern });
    }
    return out;
  };
  const suggestion = {
    exclude: rules(record.exclude, "exclude", 40),
    include: rules(record.include, "include", 20),
    notes: typeof record.notes === "string" ? record.notes.slice(0, 1200) : "",
  };
  return { suggestion, dropped: dropped.slice(0, 60) };
}

/**
 * Starts one read-only agent per request to recommend Gortex exclusion rules. The agent gets a metadata survey
 * inline and must return structured JSON; nothing it says is applied until the user confirms it in the editor.
 */
export class ExclusionSuggester {
  private jobs = new Map<string, SuggestJob>();
  private latest = new Map<string, string>();
  private running = new Set<Promise<void>>();
  private closed = false;
  private metadata: SuggestMetadata;
  private agent: () => Promise<string>;
  private gather: NonNullable<SuggesterOptions["gather"]>;
  private timeoutMs: number;
  constructor(metadata: SuggestMetadata, agent: () => Promise<string>, options: SuggesterOptions = {}) {
    this.metadata = metadata; this.agent = agent;
    this.gather = options.gather ?? ((root, current) => gatherExclusionFacts(root, current));
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  private key(path: string) { return process.platform === "win32" ? path.toLowerCase() : path; }

  async start(path: string, paseo: SuggestPaseo): Promise<SuggestJob> {
    if (this.closed) throw new Error("Plugin is closing. Reopen it before asking for suggestions.");
    if (!isAbsolute(path)) throw new Error("Choose an absolute repository path on the selected host.");
    const canonical = await realpath(path);
    const previous = this.latest.get(this.key(canonical));
    if (previous && this.jobs.get(previous)?.outcome === "running") return this.job(previous);
    const job: SuggestJob = { id: randomUUID(), path: canonical, agent: await this.agent(), stage: "gathering", outcome: "running", agentId: null, startedAt: new Date().toISOString(), finishedAt: null, suggestion: null, dropped: [], error: null };
    this.jobs.set(job.id, job); this.latest.set(this.key(canonical), job.id);
    while (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    const run = this.execute(job, paseo).finally(() => { this.running.delete(run); });
    this.running.add(run);
    return this.job(job.id);
  }

  job(id: string): SuggestJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error("This suggestion is no longer retained. Ask for new suggestions.");
    return structuredClone(job);
  }

  async latestFor(path: string): Promise<SuggestJob | null> {
    const canonical = await realpath(path).catch(() => path);
    const id = this.latest.get(this.key(canonical));
    return id && this.jobs.has(id) ? this.job(id) : null;
  }

  private async execute(job: SuggestJob, paseo: SuggestPaseo): Promise<void> {
    let handle: SuggestAgentHandle | null = null;
    try {
      const metadata = await this.metadata.read(job.path);
      const facts = await this.gather(job.path, { repository: metadata.extra.exclude, sources: metadata.exclusionSources });
      job.stage = "starting";
      const [providerId] = job.agent.split("/");
      const modes = await paseo.providers.listModes(providerId);
      const mode = modes.modes?.find(candidate => readOnlyMode.test(candidate.id) || readOnlyMode.test(candidate.label));
      if (!mode) throw new Error(`${providerId} has no plan or read-only mode, so the suggestion agent cannot be kept read-only. Choose another agent in Gortex settings.`);
      const model = job.agent.slice(providerId.length + 1);
      const models = model ? await paseo.providers.listModels(providerId).catch(() => null) : null;
      const low = models?.models?.find(candidate => candidate.id === model)?.thinkingOptions?.some(option => option.id === "low");
      if (this.closed) throw new Error("Plugin closed before the agent started.");
      handle = await paseo.agents.create({
        cwd: job.path, title: `Gortex: suggest index rules`,
        config: { provider: job.agent, modeId: mode.id, ...(low ? { thinkingOptionId: "low" } : {}), systemPrompt: "You advise on search-index configuration. Answer only from the facts provided. Do not use tools." },
        // The structured-output contract applies to the prompt sent with create, not to a later run().
        prompt: suggestionPrompt(facts),
        outputSchema: exclusionSuggestionJsonSchema as unknown as Record<string, unknown>,
        labels: { plugin: "gortex", purpose: "exclusion-suggestions" },
      });
      job.agentId = handle.id; job.stage = "thinking";
      const result = await handle.waitForFinish(this.timeoutMs);
      if (result.status === "permission") throw new Error("The agent asked to use a tool. Suggestions run read-only, so the request was stopped and nothing was changed.");
      if (result.status === "timeout") throw new Error(`The agent did not answer within ${Math.round(this.timeoutMs / 60000)} minutes.`);
      if (result.status !== "idle") throw new Error(result.error ?? "The agent stopped with an error.");
      if (!result.lastMessage) throw new Error("The agent finished without an answer.");
      // Exact .gitignore lines are redundant while Gortex respects .gitignore.
      const ignored = metadata.exclusionSources.respectGitignore ? (facts.gitignore ?? "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")) : [];
      const normalized = normalizeSuggestion(extractJson(result.lastMessage), metadata.extra.exclude, ignored);
      job.suggestion = normalized.suggestion; job.dropped = normalized.dropped;
      if (facts.totals.truncated) job.suggestion.notes = [job.suggestion.notes, "The folder survey hit its size limit, so some folders were not counted."].filter(Boolean).join(" ");
      job.outcome = "ready";
    } catch (error) {
      job.outcome = "failed"; job.error = message(error);
    } finally {
      job.stage = "done"; job.finishedAt = new Date().toISOString();
      // The agent is single-use; archiving keeps it out of the sidebar. Its transcript stays in Paseo's archive.
      if (handle) await handle.archive().catch(() => {});
    }
  }

  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.running]); }
}
