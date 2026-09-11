# Initial contract review (historical)

This document records the first implementation baseline from September 9, 2026.
Its feature list, validation counts, and installation state are historical. For the
current features and installation instructions, see [README.md](README.md). For
metadata editing, exclusions, daemon refresh, and mismatch repair contracts, see
[server/metadata-contracts.md](server/metadata-contracts.md).

Reviewed on September 9, 2026 (host Pacific time), against the installed public APIs. The original plan remains the product direction. This checkout implements an initial read-only preview, not completed Phases 0–2.

## Verified baseline

| Component | Observed |
| --- | --- |
| Gortex binary and running daemon | v0.64.2+ebfb6b7 |
| Paseo CLI, daemon, installed SDK/app package | 0.8.0-beta.1 |
| Plugin SDK | @getpaseo/plugin 0.8.0-beta.1, pinned |
| MCP SDK | @modelcontextprotocol/sdk 1.30.0, pinned |
| Node used for local tests | 22.14.0 |
| Paseo runtime activation | Not installed or enabled by this work |

Gortex was upgraded from v0.64.0 after explicit user authorization. The official Windows archive matched SHA-256 `b2364fd7098f03e3d240380ae52c11131e610ff2b5bcee0741675da4b7a1157b`. The daemon restarted successfully with existing `huginn` membership preserved. The previous executable is retained at `C:/Users/n_var/AppData/Local/Programs/gortex/gortex.exe.v0.64.0-aa0da6b.20260909213440.previous`.

## Corrections that affect implementation

1. Paseo owns the selected-host picker. `PluginSurfaceProps.host` supplies `{id,label}` and `usePaseo()` / `useRpc()` use that host. The plugin does not create a second host connection or choose a substitute when offline.
2. Workspace assignment is one effective workspace slug plus a project subgroup per repository. The CLI's default labels, such as `(default: huginn)`, are presentation strings. Resolve real IDs through a context-bound `workspace.info` response and confirm the selected repository is a member.
3. The ordinary `core`, `full`, and `readonly` MCP presets expose legacy tool names. The compact facade requires `--tools compact` (or the documented `facade-v1` alias). The adapter explicitly selects compact and exposes only a fixed set of read operations through its RPCs. It does not relay arbitrary tool calls.
4. There is no exported directory picker in the pinned Paseo SDK. The plugin therefore implements bounded host-side directory RPCs, with no source reads during browsing.
5. The pinned plugin server API has `registerSettings(...): void`, but no public settings reader or watcher. Query/display preferences can be read by the client and passed through validated RPC input. Binary overrides and server-enforced browse-root policy are not implemented by inventing a private settings API.
6. Current online Paseo documentation includes a newer composer-button contract than beta.1. Follow the pinned declarations. This preview does not implement composer pills or attachments.
7. Paseo's beta.1 `useRpc` and handler context do not propagate an AbortSignal. Query keys and host-keyed components suppress obsolete display results. Native subprocess/MCP requests have independent timeouts; client cancellation is not claimed.
8. Gortex's checkout catalog returned no families for this host, and an explicit worktree path view was rejected. There is no invented primary-checkout row. Exact/fresh controls described in Gortex docs are missing from the inspected operation schemas. Checkout-sensitive UI remains unavailable; any returned `exact:false` metadata is rejected.

## Native operation matrix

| Need | Request used or inspected | Response / effect |
| --- | --- | --- |
| Native host catalog | `gortex workspace list --json`, explicit host cwd, argv array, no shell | Array of `{repo,path,workspace,project,source}`. Catalog errors remain errors. |
| Resolved identity | `workspace {operation:"info",arguments:{format:"json"}}`, proxy cwd set to the catalog repository | `{workspace,project,mode,members:[{name,path}],isolation_bounds}`. Selected path and member name must match. |
| Index observation | `workspace {operation:"index",arguments:{format:"json",max_bytes:12000}}` | Native JSON preserved. `refreshing` is pending, not healthy. Runs only on demand. |
| Symbol search | `search {operation:"symbols",query,options:{workspace,repo,limit,paginate:true,cursor,expand:"off"},output:{format:"json"}}` | Native symbol IDs, workspace/repo provenance, cursor, total, truncated and expansion flags. Wrong-scope hits cause rejection. The compact facade disables LLM assistance. |
| Source | `read {operation:"source",target:{symbol},output:{format:"json",max_bytes:12000}}` | Native source evidence, gated by a recent native search selection in the same workspace/repository. |
| Relationships | `relations` callers/dependencies/usages/implementations with native symbol target and bounded JSON output | Native evidence snapshot. No inference of full static/runtime coverage. |
| Impact | `change {operation:"impact",target:{symbol},output:{format:"json",limit:50,max_bytes:12000}}` | Native bounded impact evidence. No mutation or enrichment requested. |
| Assign tracked repository (not implemented) | `gortex workspace set <repo> <workspace> [project] [--global]` | Writes repo `.gortex.yaml` or user config. Omitted project changes it to the workspace slug. No JSON/dry-run flags advertised. |
| Track/untrack (not implemented) | `workspace_admin` track/untrack | Control writes. Unconfirmed untrack may immediately demote an eligible checkout; it is not universally a harmless preview. |

Raw JSON objects and MCP `_meta` are preserved in inspector snapshots. A semantic native rejection does not close a healthy shared client. Transport/session failures discard the failed connection; no request is automatically replayed. The plugin closes only its own stdio clients.

## Remaining contract gates

Before implementing tracking/assignment jobs, use isolated fixture repositories to verify native slug normalization and collisions, non-default assignment sources, project preservation, configuration write receipts, graph/session refresh, cancellation/timeouts, and track-success/assignment-failure recovery. Do not describe configuration assignment as graph readiness. No existing repository should be untracked to roll back a failed assignment.

Empty native workspaces and generic remove-workspace semantics remain unsupported. Plain-folder tracking, automatic-worktree identities, exact checkout routing, multi-repository search filters, and cross-workspace edge behavior need fixtures before their respective UI actions are enabled. The current search RPC admits exactly one native repository.

## Verification and scope

- 19 Node built-in tests cover directory pagination/filtering, Unicode/spaces, missing paths, junctions, bounded scans, malformed/error/inexact native envelopes, workspace isolation, symbol admission, real Git-folder inspection, bounded text snapshots, process limits/literal argv, in-flight sharing, MCP pool concurrency, and cleanup.
- `npm run typecheck` passes against the pinned Paseo SDK.
- `npm run smoke` successfully exercised the upgraded daemon: catalog, scoped search, source, callers, dependencies, usages, implementations, impact, and index observation. It logs counts/operation names, not source payloads.
- Read-only review found shared-client error isolation, stale folder-inspection actions, and truncation-warning defects; these were corrected. Gortex batch rename hit a Windows sharing violation; individual guarded Gortex edits succeeded without raw source-edit fallback.
- Gortex change detection reviewed the new files. No native guard rules are configured; the graph finds no covering tests for the client/entrypoint symbols and retains a behavioral-change risk warning. Backend tests and TypeScript checks do not establish UI coverage.
- No representative large multi-repository benchmark, installed plugin bundle/runtime check, desktop/mobile visual QA, or real remote-host test has run. The source is a local preview, not a release-readiness claim.

## References

- [Gortex v0.64.2 release](https://github.com/zzet/gortex/releases/tag/v0.64.2)
- [Compact MCP specification at ebfb6b7](https://github.com/zzet/gortex/blob/ebfb6b7/docs/mcp-facade-v1.md)
- [Native workspace model at ebfb6b7](https://github.com/zzet/gortex/blob/ebfb6b7/docs/multi-repo.md)
- [Gortex CLI reference at ebfb6b7](https://github.com/zzet/gortex/blob/ebfb6b7/docs/cli.md)
- [Paseo plugin reference](https://paseo.sh/docs/plugins/v0.8/reference.md)
- [Exact Paseo plugin package](https://registry.npmjs.org/@getpaseo%2fplugin/0.8.0-beta.1)
- [Paseo SDK reference](https://paseo.sh/docs/sdk/reference.md)
