import type { ChatReopen } from "../shared/update-contracts.ts";

/**
 * Reopening agent chats so they use a newly installed Gortex. A chat's Gortex tools come from the Gortex process it
 * started with. Paseo 0.14 can reopen a chat's session (`reload()`), which starts its MCP servers again; it interrupts a
 * running turn, so only idle chats are reopened. Paseo 0.13 has no reload, and there these report it rather than act.
 */
export interface ChatSnapshot {
  id: string;
  title: string | null;
  status: string;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[];
  archivedAt?: string | null;
}
/** The subset of an agent handle used here; the real `paseo.agents.ref()` satisfies it. */
export interface ChatHandle {
  readonly status: string | null;
  readonly activeTurn: unknown;
  readonly pendingPermissions: readonly unknown[] | null;
  readonly archivedAt: string | null;
  refresh(): Promise<unknown>;
  /** Paseo 0.14 on: reopens the session with current configuration. */
  reload?(): Promise<unknown>;
}
/** The subset of the plugin's Paseo SDK used here; the real `paseo` context satisfies it. */
export interface ChatsPaseo {
  agents: {
    list(options?: { filter?: { includeArchived?: boolean }; page?: { limit: number; cursor?: string } }): Promise<{ entries: { agent: ChatSnapshot }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } }>;
    ref(id: string): ChatHandle;
  };
  config?: { get(): Promise<{ config: object }> };
}
export interface ChatSurvey {
  /** Whether this Paseo can reopen a chat; null when no chat is open to ask about. */
  reopenable: boolean | null;
  idle: ChatSnapshot[];
  busy: ChatSnapshot[];
  /** Whether Paseo releases chats idle for an hour (Paseo 0.14, on unless turned off); null when unknown. */
  releasesIdle: boolean | null;
}

const PAGE = 200, MAX_PAGES = 10;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const label = (chat: { id: string; title: string | null }) => chat.title?.trim() || `agent ${chat.id.slice(0, 7)}`;
const message = (error: unknown) => error instanceof Error ? error.message : "Paseo didn't answer.";

/** Idle: no running turn, no question waiting on someone, not archived and not released. */
export function isIdle(chat: { status: string | null; activeTurn?: unknown; pendingPermissions?: readonly unknown[] | null; archivedAt?: string | null }): boolean {
  return chat.status === "idle" && !chat.activeTurn && !chat.pendingPermissions?.length && !chat.archivedAt;
}

/** The open chats on this host: those not archived and not closed. A closed chat starts afresh on its next prompt. */
export async function surveyChats(paseo: ChatsPaseo): Promise<ChatSurvey> {
  const open: ChatSnapshot[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await paseo.agents.list({ filter: { includeArchived: false }, page: cursor ? { limit: PAGE, cursor } : { limit: PAGE } });
    for (const { agent } of result.entries) if (agent.status !== "closed" && !agent.archivedAt) open.push(agent);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  const reopenable = open.length ? typeof paseo.agents.ref(open[0].id).reload === "function" : null;
  let releasesIdle: boolean | null = null;
  if (reopenable && paseo.config) {
    // Paseo 0.14 leaves the setting out until someone changes it, and it's on by default.
    try { const { config } = await paseo.config.get(); releasesIdle = (config as { idleRuntimeCleanup?: unknown }).idleRuntimeCleanup !== false; }
    catch { releasesIdle = null; }
  }
  return { reopenable, idle: open.filter(isIdle), busy: open.filter(chat => !isIdle(chat)), releasesIdle };
}

export function reopenSummary(reopened: string[], busy: string[], failed: string[]): string {
  if (!reopened.length && !busy.length && !failed.length) return "No agent chats were open, so none needed reopening.";
  return [
    reopened.length ? `Reopened ${plural(reopened.length, "idle chat")} so ${reopened.length === 1 ? "it uses" : "they use"} the current Gortex tools.` : "No idle chats to reopen.",
    busy.length ? `${plural(busy.length, "busy chat")} keep${busy.length === 1 ? "s" : ""} the previous Gortex tools until ${busy.length === 1 ? "it's" : "they're"} restarted: ${busy.join(", ")}.` : null,
    failed.length ? `${plural(failed.length, "chat")} couldn't be reopened; restart ${failed.length === 1 ? "it" : "them"}: ${failed.join(", ")}.` : null,
  ].filter(Boolean).join(" ");
}

/**
 * Reopens every idle chat, one at a time so Gortex isn't asked to start many sessions at once. Each chat is looked at
 * again just before, so one that started a turn meanwhile is left alone. Null when this Paseo can't reopen chats.
 */
export async function reopenIdleChats(paseo: ChatsPaseo): Promise<ChatReopen | null> {
  const survey = await surveyChats(paseo);
  if (survey.reopenable === false) return null;
  const reopened: string[] = [], busy = survey.busy.map(label), failed: string[] = [];
  for (const chat of survey.idle) {
    const handle = paseo.agents.ref(chat.id);
    try {
      // Gone since the list: nothing to reopen.
      if (await handle.refresh() === null) continue;
      if (!isIdle(handle)) { busy.push(label(chat)); continue; }
      await handle.reload!();
      reopened.push(label(chat));
    } catch (error) {
      failed.push(`${label(chat)} (${message(error)})`);
    }
  }
  return { reopened, busy, failed, summary: reopenSummary(reopened, busy, failed) };
}
