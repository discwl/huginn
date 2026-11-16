import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useSubscription } from "@getpaseo/plugin/client";
import { jobFeedSubscription, type JobFeedInput } from "../shared/job-feed-contracts.ts";

// Paseo 0.16 pushes job progress over a subscription. A Paseo app older than 0.16 has no useSubscription, and the
// shared contract is null there; on either, panels poll exactly as before.
const subscription = typeof useSubscription === "function" ? jobFeedSubscription : null;

/**
 * Follows a job the panel otherwise polls. Render follow(input) while the job runs (null when it doesn't): with a live
 * subscription the host pushes each new state into the query at queryKey and `live` is true, so the panel stops polling.
 * Until the subscription is live, or once it fails or closes (an older host has none), `live` is false and polling
 * carries on.
 */
export function useJobFeed(queryKey: QueryKey): { live: boolean; follow(input: JobFeedInput | null): ReactNode } {
  const [live, setLive] = useState(false);
  return { live, follow: input => subscription && input ? <Feed key={`${input.kind}:${input.id ?? ""}`} input={input} queryKey={queryKey} onLive={setLive} /> : null };
}

function Feed({ input, queryKey, onLive }: { input: JobFeedInput; queryKey: QueryKey; onLive: (live: boolean) => void }) {
  const queries = useQueryClient();
  const state = useSubscription(subscription!, input, event => { queries.setQueryData(queryKey, event.state); });
  const live = state.status === "live";
  useEffect(() => { onLive(live); }, [live, onLive]);
  useEffect(() => () => onLive(false), [onLive]);
  return null;
}
