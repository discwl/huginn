import type { ChatHandle, ChatSnapshot, ChatsPaseo } from "./agent-chats.ts";

/** `background`: in a background workspace, or a Paseo 0.16 background agent, listed only when asked for. */
export type FakeChat = Partial<ChatSnapshot> & { id: string; background?: boolean };
export interface FakeChatsOptions {
  /** false: Paseo 0.13, whose agent handles have no reload(). */
  reload?: boolean;
  config?: object | (() => Promise<never>);
  pageSize?: number;
  /** Chats whose reload() fails. */
  failing?: string[];
  /** Chats that start a turn between the list and the reload. */
  startTurn?: string[];
  /** Chats that start background work (Paseo 0.16) between the list and the reload. */
  startBackgroundWork?: string[];
}

/** A Paseo with the given chats, recording which ones were reopened. */
export function fakeChats(chats: FakeChat[], options: FakeChatsOptions = {}) {
  const state = new Map<string, ChatSnapshot & { background?: boolean }>(chats.map(chat => [chat.id, { title: null, status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null, ...chat }]));
  const reloaded: string[] = [], pages: (string | undefined)[] = [];
  const filters: ({ includeArchived?: boolean; includeBackground?: boolean } | undefined)[] = [];
  const paseo: ChatsPaseo = {
    agents: {
      async list(request) {
        const filter = request?.filter as { includeArchived?: boolean; includeBackground?: boolean } | undefined;
        filters.push(filter);
        // Like Paseo: background chats are listed only when the filter asks for them.
        const all = [...state.values()].filter(chat => !chat.background || filter?.includeBackground), size = options.pageSize ?? 200, start = Number(request?.page?.cursor ?? 0);
        pages.push(request?.page?.cursor);
        const next = start + size < all.length ? String(start + size) : null;
        return { entries: all.slice(start, start + size).map(agent => ({ agent: { ...agent } })), pageInfo: { nextCursor: next, hasMore: next !== null } };
      },
      ref(id) {
        let seen: ChatSnapshot | null = null;
        const handle: ChatHandle = {
          get status() { return seen?.status ?? null; },
          get activeTurn() { return seen?.activeTurn ?? null; },
          get pendingPermissions() { return seen?.pendingPermissions ?? null; },
          get archivedAt() { return seen?.archivedAt ?? null; },
          async refresh() {
            const current = state.get(id);
            if (current && options.startTurn?.includes(id)) { current.status = "running"; current.activeTurn = { id: "turn" }; }
            if (current && options.startBackgroundWork?.includes(id)) current.backgroundWork = { count: 1 };
            seen = current ? { ...current } : null;
            return seen ? { agent: seen } : null;
          },
        };
        if (options.reload !== false) handle.reload = async () => {
          if (options.failing?.includes(id)) throw new Error("the provider didn't start");
          reloaded.push(id);
          return null;
        };
        return handle;
      },
    },
    config: { get: async () => typeof options.config === "function" ? options.config() : { config: options.config ?? {} } },
  };
  return { paseo, reloaded, pages, filters };
}
