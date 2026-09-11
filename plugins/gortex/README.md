# Gortex for Paseo

A trusted local Paseo plugin for browsing the connected host's native Gortex
workspaces, checking daemon and repository health, inspecting code, and editing
repository metadata and exclusions.

## Current features

- Host-scoped workspace and repository catalog using Gortex's native identities.
- Daemon health, uptime, graph counts, memory, MCP sessions, and language-server
  state. Health refreshes every 30 seconds while the panel is active.
- On-demand reported token savings and repository index health.
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
- A Windows **Browse...** button that opens a native folder dialog on the selected
  host's desktop and inspects the chosen directory. It does not track a new repo.

Repository membership and graph state belong to Gortex. Plugin preferences hold
presentation and query settings, not a separate repository registry. Connections
use a small persistent pool of `gortex mcp --proxy --tools compact` processes with
explicit repository working directories.

## Current limits

- Creating/tracking/untracking repositories and changing primary checkouts are not
  exposed. Use native Gortex tooling on the host for those actions.
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
are gated to the verified 0.64.3 contract and are unavailable for unverified versions.

Gortex must be available on the Paseo daemon account's `PATH`, with its existing
configuration and shared daemon accessible to that account. The Windows folder
picker requires PowerShell 7 (`pwsh`) and an interactive Windows desktop. Other
panels use the host connection and do not require desktop access.

## Install on another host

Install the plugin on each machine whose Gortex data you want to see. Installing it
on Personal does not install it on CNS. Use the same operating-system account that
runs that host's Paseo daemon and owns its Gortex configuration.

Plugin backend code is unsandboxed and can access that host's files, processes,
credentials, and network; client code runs inside Paseo. Review the source before
trusting it. Do not put credentials in plugin settings.

On the target Windows host, with Git, Node/npm, Paseo, and Gortex already installed:

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

From Personal, connect to CNS in Paseo, open **Gortex**, and select CNS in the host
selector. The catalog, health, source queries, and metadata actions then use CNS's
Gortex installation. Keep CNS's existing Gortex configuration and repositories;
there is no need to copy Personal's tracking configuration or database.

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

## Development and validation

```powershell
npm run typecheck
npm test
```

The Node test runner covers adapters, response validation, host/selection isolation,
directory and picker handling, request sharing, symbol inspection, and metadata jobs.
The current suite has 71 passing tests. Separate isolated native integration
exercises verified metadata repair, exclusion removal/reinclusion, and isolation of
a second repository. Live read-only checks verified the six inspector operations.
These checks do not replace desktop/mobile UI testing.

See [server/metadata-contracts.md](server/metadata-contracts.md) for the current
metadata and exclusion contract evidence. [CONTRACTS.md](CONTRACTS.md) preserves the
initial contract review and its historical limitations.
