# GortexKit

Small maintenance tools for moving an existing GortexKit installation to native Gortex and keeping it current across machines. Requires PowerShell 7.2+ and Gortex 0.64.0+.

Gortex now supplies the provider integrations and discovers linked worktrees. Paseo does not need this kit at runtime. A new machine can follow the [native setup steps](RUNBOOK.md#new-machine), including the deny settings for every provider; this repository is useful for migration, repeatable updates, and optional diagnostics.

## What changed

| Previous kit responsibility | Current owner / action |
| --- | --- |
| Claude, Codex, and Copilot PowerShell hooks; readiness waits | Native Gortex hooks; remove the legacy entries once |
| Custom OpenCode context plugin | Native OpenCode integration |
| Instruction copying and Gortex skill mirroring | `gortex install` and native instruction profiles |
| Worktree setup, explicit tracking, reindexing, and teardown | Native automatic worktree views; remove the old Paseo commands |
| Installing and repairing custom adapters | Retired; use the native installer and `gortex doctor` |
| Refreshing an existing installation | `Update-GortexAgents.ps1` |
| Removing old kit artifacts safely | `Remove-LegacyGortexKit.ps1` |

The [v0.64.0 release notes](https://github.com/zzet/gortex/releases/tag/v0.64.0) cover v0.63.0 through v0.64.0, including maintenance releases. The relevant changes are automatic checkout routing, a shared primary graph with branch changes, bounded indexing/search memory, broader provider support, and better upgrade diagnostics. The kit no longer implements substitutes for those features.

## Migrate an existing machine

First remove obsolete Gortex setup/teardown commands from your projects' Paseo configuration, preserving application setup. See the [migration runbook](RUNBOOK.md) for existing dedicated worktree registrations and manual review items.

From this repository in PowerShell 7:

```powershell
# Preview only; no files are changed.
.\Remove-LegacyGortexKit.ps1

# Apply recognized cleanup, with backups.
.\Remove-LegacyGortexKit.ps1 -Apply

# Upgrade the binary and refresh native provider configuration.
.\Update-GortexAgents.ps1 -Upgrade
```

Cleanup preserves unknown or customized artifacts and prints warnings for review. It never removes repository registrations or the graph store. Backups are under `~/.gortexkit-backups/`; review them before deleting them.

## Routine updates

```powershell
# Refresh configuration from the installed binary, even if it is already latest.
.\Update-GortexAgents.ps1

# Upgrade first, then always refresh configuration.
.\Update-GortexAgents.ps1 -Upgrade

# Optional: choose native providers or an instruction profile.
.\Update-GortexAgents.ps1 -Agents codex,claude-code,copilot-cli,opencode -Profile core

# Preview without invoking Gortex or downloading anything.
.\Update-GortexAgents.ps1 -Upgrade -WhatIf
```

The updater delegates installation to Gortex, checks each agent's installation result, and runs `daemon status` and `doctor`. It installs **deny mode for Claude Code, Codex, Copilot CLI, and OpenCode**, including replacing an existing advisory/enrich setting. Open fresh provider sessions after refreshing, and review new or changed Codex hooks through `/hooks`.

For the official default Windows installation, `-Upgrade` uses the official Windows installer because v0.64.0's upgrade detector misses that location. Other installations use `gortex upgrade --run`. Package managers and custom paths are covered in the [runbook](RUNBOOK.md).

## Optional utilities

- `Analyze-RepoExclusions.ps1`: reports exclusion candidates for a large primary repository. Review its suggestions before changing native policy; it writes no configuration.
- `Sync-AgentSkills.ps1`: explicit mirroring for unrelated skills, such as `-Pattern humanizer`. It excludes `gortex-*` skills; native Gortex manages those.

Neither utility belongs in a Paseo setup/teardown hook or the normal Gortex update path.

## Validation

```powershell
pwsh -NoProfile -File tests/update.test.ps1
pwsh -NoProfile -File tests/cleanup.test.ps1
```

Tests use a fake Gortex executable and temporary configuration directories. They do not install software or change the machine's provider configuration. Actual provider activation and a fresh Paseo worktree are the final checks on each machine; follow the [runbook](RUNBOOK.md).
