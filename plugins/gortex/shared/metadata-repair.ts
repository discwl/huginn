import type { RepositoryMetadata } from "./metadata-contracts.ts";

export type MetadataRepairState = "matched" | "unavailable" | "unsupported" | "name-conflict" | "ready";

/** Availability only. The server derives and validates the actual proposal from fresh native state. */
export function metadataRepairState(metadata: RepositoryMetadata): MetadataRepairState {
  if (!metadata.daemon) return "unavailable";
  if ((["name", "workspace", "project"] as const).every(key => metadata.effective[key] === metadata.daemon![key])) return "matched";
  if (!metadata.canRebuild) return "unsupported";
  return metadata.effective.name !== metadata.daemon.name ? "name-conflict" : "ready";
}
