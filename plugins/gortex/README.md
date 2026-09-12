# Gortex for Paseo

A trusted local Paseo plugin for browsing the connected host's native Gortex
workspaces, checking daemon and host index health, inspecting code, and editing
repository metadata and exclusions, and explicitly tracking or untracking repositories.

## Current features

- A full-width, host-scoped repository library with name/path search, configured
  workspace/project filters, sorting, and 12 rows per page. Filters cover the entire
  native assignment catalog, including repositories beyond the first 50 entries.
- Paseo projects on the selected host appear alongside Gortex repositories. Standalone
  Git roots without native tracking show **Not indexed** and an **Index** button.
  The confirmation previews the canonical path and native defaults before tracking;
  completion refreshes Gortex's authoritative catalog. If its native view is pending,
  the open dialog checks readiness every three seconds for up to one minute, then
  offers **Check readiness**. These checks never replay tracking. Directory aliases
  and nested project paths are deduplicated. Worktrees, ordinary folders and inaccessible paths
  show separate states and do not offer ordinary tracking.
- Focused repository search/settings views with an **All repositories** return
  action that preserves library filters and page. Compact screens stack row metadata.
- A compact daemon status strip and a separate **Host health** tab for detailed
  daemon and index metrics, so shared totals are not repeated inside each repo.
- Daemon health, uptime, graph counts, memory, MCP sessions, and language-server
  state. Health refreshes every 30 seconds while the panel is active.
- On-demand reported token savings and **host index health**. The native
  `workspace.index` report covers every repository and workspace on that daemon;
  its file/node/relationship totals and score are not per-repository statistics.
- Repository-scoped symbol search with bounded results, readable source with line
  numbers, and navigable callers, dependencies, usages, implementations, and impact.
  Native reports remain available for inspection; displayed context can be copied.
- Open or reuse the selected repository directory in Paseo.
- Repository name, workspace, and project settings, with configured and active
  daemon values shown separately.
- Repository exclusion editing, inherited-rule information, and an explicit index
  refresh preview to apply saved rules to the graph.
- A **Resolve mismatch** action that previews supported metadata repairs before
  applying them. Writes use stale-preview checks, a configuration backup, native
  reload/index operations, and verification of the resulting daemon state.
- **Repository settings → Repository tracking → Review untracking** removes explicit
  tracking through the selected host's Gortex daemon after confirmation. It saves a
  configuration backup, rechecks the preview, and displays the native outcome.
  Primary graph/checkout removal requires a second confirmation of Gortex's exact
  affected-view list. Source files and Paseo workspaces remain unchanged.
- A Windows **Browse...** button opens a native folder dialog on the selected host's
  desktop and inspects the chosen directory. An eligible new Git root offers the
  same separate **Index** confirmation.

Repository membership and graph state belong to Gortex. Plugin preferences hold
presentation and query settings, not a separate repository registry. Connections
use a small persistent pool of `gortex mcp --proxy --tools compact` processes with
explicit repository working directories.

## Current limits

- Creating source repositories, deliberately forgetting worktrees, and changing
  primary checkouts are not exposed. Use native Gortex tooling for those actions.
- The library includes at most 500 Paseo projects and labels a truncated project
  list. Directory discovery has a 20-second budget and at most four active reads;
  folders that cannot be checked in time remain unavailable until a later refresh.
  They remain unassigned display entries until native Gortex tracking exists;
  selecting a native workspace/project filter hides those unassigned candidates.
  A Paseo or Gortex catalog failure is shown explicitly, never interpreted as proof
  that all projects are unindexed.
- Ordinary automatic worktrees have no separate config entry to untrack. Untracking
  a dedicated worktree can return it to automatic indexing while a primary survives;
  it is not a permanent worktree exclusion. Missing paths and ambiguous or mismatched
  graph names must be resolved on the host before using the untrack action.
- Native untracking has no client-supplied plan-version guard. The plugin rechecks
  config and catalog state, but other native administrators can still race that
  check. Coordinate administration until the confirmed operation finishes. A lost
  native response stays unverified and is never automatically replayed.
- Searches use the selected repository's current native session context. Exact
  checkout selection and workspace-wide cross-repository search are not established.
- Gortex 0.64.3 does not provide a supported in-place graph rename. A mismatch repair
  can explicitly restore the configured name to the active graph name while
  applying the requested workspace and project. The preview shows this change.
- A configuration reload can apply other pending host configuration changes. Index
  refreshes are explicit, and an incomplete operation is reported as pending or failed.
- Coverage, deep analysis panels, and direct agent context attachments are not yet
  implemented. Missing native evidence is not proof that code has no relationships.

## Compatibility

The installed integration was validated with Paseo `0.8.0-beta.1`, Gortex
`0.64.3+56a1c29`, and Node `22.14.0`. The manifest accepts Paseo
`>=0.8.0-beta.1 <0.9.0`. Read adapters require Gortex 0.64.2 or newer; metadata writes
and tracking/untracking are gated to the verified 0.64.3 contract and are unavailable for
unverified versions.

Gortex and Git must be available on the Paseo daemon account's `PATH`, with Gortex's
existing configuration and shared daemon accessible to that account. Native commands
are resolved to absolute host executable paths before using a repository working
directory; empty or relative `PATH` entries are ignored. Configure an absolute
Gortex executable path if it is not on `PATH`. The Windows folder
picker requires PowerShell 7 with Windows Forms and an interactive Windows desktop.
It checks `PATH` and standard MSI, WindowsApps, and .NET tool installation paths.
Failed checks are retried, so installing PowerShell does not require restarting the
shared Paseo daemon. Other panels use the host connection without desktop access.

## Install on another host

Install the plugin on each machine whose Gortex data you want to see. Installing it
on Personal does not install it on CNS. Use the same operating-system account that
runs that host's Paseo daemon and owns its Gortex configuration.

Plugin backend code is unsandboxed and can access that host's files, processes,
credentials, and network; client code runs inside Paseo. Review the source before
trusting it. Do not put credentials in plugin settings.

### Install directly from GitHub

On the target host, with Git, Node.js/npm, Paseo 0.8, and Gortex already installed:

```powershell
paseo plugin add discwl/huginn:plugins/gortex --ref main
paseo plugin ls gortex
```

Paseo downloads and manages the checkout on that host. The manifest's preparation
step installs the locked dependencies and typechecks the plugin before activation.
You do not need to clone the repository or run npm commands yourself.

To manage another daemon from your current machine, provide its actual connection
address. For example, replace the SSH username and address below with your own:

```powershell
paseo --host "ssh://YOUR_USER@XENDEE_ADDRESS" plugin add discwl/huginn:plugins/gortex --ref main
```

The target daemon performs the Git fetch and installation. Its operating-system
account must have access to the repository and dependency registry. A Paseo display
label such as `Xendee` is not itself an SSH address. Use the target machine's terminal
if your connection is available only through the Paseo app.

For later updates to a Git-managed installation, run this on the same host, or use
the same explicit `--host` connection:

```powershell
paseo plugin update gortex
```

See the [Paseo plugin reference](https://paseo.sh/docs/plugins/v0.8/reference#cli-reference)
for Git sources, tracked branches, pinned revisions, and installation effects.

### Switch an existing directory installation to Git

Paseo rejects `plugin add` when the same runtime ID is already configured. Record
any custom plugin preferences, then run this once on that host:

```powershell
paseo plugin remove gortex
paseo plugin add discwl/huginn:plugins/gortex --ref main
```

Removing a directory installation keeps its source directory, but clears Paseo's
saved settings for that plugin ID. Gortex's native configuration, repositories,
and indexes remain intact. Reapply any custom plugin preferences after installing.
For subsequent Git-managed updates, use `paseo plugin update gortex`.

### Install a development checkout

Use a directory installation when you want Paseo to run files you edit locally.
On the target Windows host:

```powershell
git clone --branch main https://github.com/discwl/huginn.git C:\GortexKit
Set-Location C:\GortexKit\plugins\gortex
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
paseo plugin install C:\GortexKit\plugins\gortex --id gortex --host 127.0.0.1:6767 --json
paseo plugin ls --host 127.0.0.1:6767 --json
```

Choose another clone location if `C:\GortexKit` already exists, or use an existing
checkout after updating it. Use your normal Git authentication if the repository
requires it. Replace the daemon address if that host uses a different port.

If plugins are globally disabled, review the existing plugin entries before enabling
plugins in that host's Paseo settings: enabling the global switch can start other
configured plugins too. Confirm the Gortex plugin reports a running state. Use
Paseo's supported configuration reload when needed; do not restart the shared Paseo
daemon just to load this plugin.

From Personal, connect to CNS in Paseo, open **Gortex**, and select CNS in the
**plugin host selector in the Gortex screen header**. Both installations should use
ID `gortex` and be running. Paseo groups the matching sidebar contributions and
supplies the selected host's bundle, RPC connection, and query cache. The subtitle
`Native code intelligence on ...` should change to CNS, along with its catalog.
Switching the general app host while leaving a host-specific plugin screen open is
not a substitute for selecting that screen's host.

If the subtitle changes to CNS but Personal's repositories remain, check the CNS
connection target and both plugin/client versions; that is not expected host
isolation. Repository metadata actions should always use the selected host's
installation. Keep CNS's existing Gortex configuration and repositories; there is
no need to copy Personal's tracking configuration or database.

**Browse... opens on CNS's Windows desktop**, not Personal's. Use Remote Desktop
when you need to interact with that dialog. Health, search, and settings remain
usable through Paseo without opening a Windows dialog.

## Update an installed copy

Run on the machine where the plugin is installed, adjusting paths and port as needed:

```powershell
Set-Location C:\GortexKit
git pull --ff-only origin main
Set-Location plugins\gortex
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
paseo plugin reload gortex --host 127.0.0.1:6767 --json
```

## Windows folder picker troubleshooting

If Browse reports that PowerShell cannot start, install PowerShell 7 **on the selected
host**, using the account that runs Paseo. Microsoft's documented MSI install command
is:

```powershell
winget install --id Microsoft.PowerShell --source winget --installer-type wix
```

See [Microsoft's installation guide](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows)
for hosts without WinGet. Update this plugin and reload `gortex` on that host, then
reopen the Gortex screen so its capability check runs again. Standard installations
are detected even if the running Paseo process has an older `PATH`.

If the check instead reports no interactive desktop, run Paseo in a signed-in Windows
desktop session on that host and use Remote Desktop to operate the folder dialog.
Installing PowerShell does not give a service or a headless host desktop access.
An unavailable Windows Forms message indicates that the installed runtime needs to
be repaired or replaced with a compatible PowerShell 7 installation.

## Development and validation

```powershell
npm run typecheck
npm test
```

The Node test runner covers adapters, response validation, host/selection isolation,
directory and picker handling, request sharing, symbol inspection, and metadata jobs.
Separate isolated native integration exercises verified metadata repair, exclusion removal/reinclusion, and isolation of
a second repository. The index scope fixture uses three repositories across two
workspaces and verifies that the shared native index report includes all three.
Run it explicitly with `node --experimental-strip-types server/index-native-fixture.ts`.
It uses its own temporary config, store, socket, and daemon, then cleans them up.
Live read-only checks verified the six inspector operations.
`node --experimental-strip-types server/untrack-native-fixture.ts` separately verifies
native untracking, source preservation and repository isolation. On this Windows
installation the native checkout-family catalog is empty, so the fixture explicitly
skips native demotion/primary-closure cases; those response paths have unit coverage.
See [server/untrack-contracts.md](server/untrack-contracts.md) for confirmation behavior,
precondition limits and proposed panel/command additions.
`node --experimental-strip-types server/track-native-fixture.ts` starts an isolated
empty daemon and verifies first-repository tracking, native workspace/project defaults,
a searchable index, Unicode paths, duplicate prevention and source preservation.
The adapter uses the public `gortex track <path> --no-progress` command, then reconciles
`workspace list --json` and native repository context. No daemon restart is needed.
Preview tokens expire after five minutes and compare fresh config, catalog and Git
root identity before writing. A lost response is marked uncertain, pauses further
plugin administration and requires reconciliation instead of blindly replaying track.
Other native clients are outside the plugin's write lock; coordinate administration.

These checks do not replace desktop/mobile UI testing.

See [server/metadata-contracts.md](server/metadata-contracts.md) for the current
metadata and exclusion contract evidence. [CONTRACTS.md](CONTRACTS.md) preserves the
initial contract review and its historical limitations.
