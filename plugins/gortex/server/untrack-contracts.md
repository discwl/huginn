# Repository untracking contracts

Reviewed against installed Gortex `v0.64.3+56a1c29` on September 11, 2026.

## Native behavior

`workspace_admin {operation:"untrack", arguments:{path, confirm}}` uses the existing
shared daemon. The adapter supplies a canonical absolute path selected from native
tracking configuration, with a unique matching active graph. There is no CLI
config-only fallback, daemon restart, direct store access, or source deletion.

`confirm:false` is **not a read-only preview**. Native `evict` and `demote` plans run
immediately. `primary_closure` and `forget` plans instead return `status:"preview"`
with affected/preserved entries and require `confirm:true`. An automatic worktree
normally has no separate `repos[]` entry; a dedicated worktree can be demoted back
to automatic indexing. Untracking does not permanently exclude a working directory.

Sources: [untrack handler](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_multi.go),
[plan and receipt schemas](https://github.com/zzet/gortex/blob/v0.64.3/internal/mcp/tools_checkouts.go),
[lifecycle plans](https://github.com/zzet/gortex/blob/v0.64.3/internal/indexer/checkout_untrack.go).

## Plugin flow

1. `untrack.preview` reads config, native assignments, resolved identity and the
   session's checkout catalog. It issues no untrack request and writes no backup.
2. User approves the named repository and host. `untrack.apply` checks a five-minute
   server-owned token, revalidates its snapshot, and saves a private backup of the
   original config before calling the native operation with `confirm:false`.
3. A native destructive preview creates a **different** approval token and displays
   its entire bounded affected/preserved list. Confirmation is a second user action.
   The original token can only return its existing job, never authorize this removal.
4. Before that confirmation, config, identity and checkout catalog are checked again.
   Blockers, malformed responses and partial plans never authorize broader removal.
5. Successful native receipts are checked against the selected graph and approved
   plan, then reconciled with the native configuration catalog. Demotion is labeled
   separately from removal. Plugin contexts and source-admission tokens are cleared.

Metadata writes and untracking share a host-local administration lock across plugin
clients. Native work continues if the panel closes; reopening settings can recover
its retained job through the host-scoped query cache. Plugin reload invalidates
approval tokens. A timeout or lost response never causes a replay; absent config
without a native success receipt remains **unverified**. Unverified outcomes pause
subsequent plugin administration, including metadata saves, so a timed-out native
write cannot race another save. Check native state and let that operation finish,
then explicitly reload the plugin to resume writes. The backup contains host
configuration and is retained privately on that host, never sent as an RPC payload.

## Limits and validation

The native endpoint accepts no caller-supplied epoch, incarnation or approved-plan
hash. Its internal transaction guards do not bind a later call to a user's earlier
preview. Plugin precondition checks narrow this race but cannot make it atomic
against another native administrator. The preview states this limit; coordinate
other administration while the operation is running.

Untracking requires a reachable daemon, an existing path, an unambiguous top-level
config entry and a matching graph name. Automatic worktrees, missing paths, YAML
aliases/anchors, ambiguous config and newer unverified Gortex versions fail visibly.
The native checkout response is bounded; truncation disables the operation.

Unit coverage includes read-only previews, duplicate clicks, primary approval-token
separation, demotion outcomes, stale config/catalog, partial plans, unknown versions,
lost responses, private backups, reload invalidation and the shared metadata lock.
The separate `untrack-native-fixture.ts` exercises only its own temporary repositories,
config, store, sockets and daemon. It verifies actual removal, retained source files
and another repository's isolation. This Windows installation exposes an empty
checkout-family catalog even after explicit fixture registration; its native demotion
and primary-closure cases are reported as skipped, with unit coverage only. The
fixture runs those cases when a native catalog is available.

## Paseo contributions and recommended next steps

The current client registers the Gortex library/sidebar, settings and **Open Gortex
library** in Command Center. It has no right-side panel or client slash command yet.
Paseo's supported `addWorkspacePanel` API accepts `locations:["explorer"]`, with
workspace context supplied by `useWorkspace(workspaceId, selector)` and host routing
supplied by Paseo. See the [Paseo reference](https://paseo.sh/docs/plugins/v0.8/reference#workspace-panels).

A focused source/relationship inspector alongside an agent and an explicit bounded
context attachment are the strongest next integration. Follow with a change-review
view (impact, guards, relevant tests), repository findings (hotspots, cycles, clones,
coverage gaps where data exists), then exact checkout navigation once host-level
native catalog/view support is established. Keep expensive analysis on demand and
show scope, missing enrichment and partial evidence in every analysis result.
