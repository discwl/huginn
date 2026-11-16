import { setTimeout as delay } from "node:timers/promises";
import type { JobFeedEvent, JobFeedInput } from "../shared/job-feed-contracts.ts";

type Kind = JobFeedEvent["kind"];
type StateOf<K extends Kind> = Extract<JobFeedEvent, { kind: K }>["state"];
/** Where each kind's state lives: the in-memory read its polling RPC answers with, and whether a state is its last. */
export type JobFeedSources = { [K in Kind]: { read(id: string | undefined): StateOf<K>; final(state: StateOf<K>): boolean } };
type Source = { read(id: string | undefined): unknown; final(state: unknown): boolean };

/** The job a feed follows; a feed for one job without its id is refused. */
export function jobId(id: string | undefined): string {
  if (!id) throw new Error("Following a job needs its id.");
  return id;
}

/**
 * Serves the job subscription. Jobs keep their state in memory and change it in place, so the feed reads that state
 * every intervalMs and pushes it whenever it differs from the last push, then ends after the final state. It never asks
 * Gortex anything and isn't bound by Paseo's 30-second RPC limit. A read that throws (an expired job) closes the
 * subscription with that error, and the panel goes back to polling, which reports it.
 */
export function followJobs(sources: JobFeedSources, intervalMs = 250) {
  return async ({ kind, id }: JobFeedInput, { push, signal }: { push(event: JobFeedEvent): Promise<void>; signal: AbortSignal }): Promise<void> => {
    const source = sources[kind] as Source;
    let last: string | null = null;
    while (!signal.aborted) {
      const state = source.read(id);
      const text = JSON.stringify(state);
      if (text !== last) { last = text; await push({ kind, state } as JobFeedEvent); }
      if (source.final(state)) return;
      await delay(intervalMs, undefined, { signal }).catch(() => {});
    }
  };
}
