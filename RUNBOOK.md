# Native Gortex maintenance and Paseo migration

This kit targets Gortex 0.64.0+ and PowerShell 7.2+. Use the same steps on each machine; configuration paths belong to that machine's provider account. The repository can live anywhere and is not needed while Paseo runs.

## New machine

1. Install the provider CLIs you use and the official Gortex binary. On Windows, the upstream installer is:

   ```powershell
   irm https://get.gortex.dev/install.ps1 | iex
   ```

2. Open a fresh shell so the new PATH is visible, then configure native integrations:

   ```powershell
   $env:GORTEX_CODEX_HOOK_MODE = 'deny'
   gortex install --yes --hook-mode=deny
   ```

   Add `--agents=codex,claude-code,copilot-cli,opencode` if provider autodetection does not select the intended hosts. Native install preserves unrelated configuration while refreshing its managed integrations; this kit never passes `--force`.

3. Start the first native provider/MCP session so Gortex's MCP startup can make the daemon available. In Codex, use `/hooks` to review and enable new or changed hooks. Then inspect health:

   ```powershell
   gortex daemon status
   gortex doctor
   ```

   The kit's `Update-GortexAgents.ps1` is for subsequent refreshes and upgrades; it expects a working native installation.

4. Register the intended primary checkout once if it is not already registered. Inspect the existing inventory first:

   ```powershell
   gortex repos families
   # Only for a primary repository you intend to register:
   gortex track C:\Repos\my-project
   ```

5. Start a fresh provider session through Paseo. In Codex, use `/hooks` to review and enable new or changed hooks. Confirm the `gortex` MCP tools are present. A missing server is an integration failure to diagnose, not a reason to install a custom readiness gate.

Paseo must launch the provider in the actual workspace checkout and inherit a PATH that contains Gortex. After installing or changing environment variables, restart the relevant Paseo process so new agents inherit them. Application dependency installation and other project setup remain your project's responsibility.

## Migrate an older kit installation

### 1. Remove the old Paseo lifecycle commands

In each project's `paseo.json` or configured workspace scripts, remove GortexKit invocations from setup and teardown. Preserve application setup, application teardown, and `metadataGeneration`.

Retired commands include `Manage-GortexWorktree.ps1` with either `-Action Setup` or `-Action Teardown`, `Install-GortexAgentKit.ps1`, and `Repair-GortexAgentKit.ps1`. Old examples also used copied scripts under `local/Paseo/`, `PASEO_SOURCE_CHECKOUT_PATH`, or `git rev-parse --git-common-dir` to reach the kit.

Remove obsolete custom shortcuts such as `gortex-wait`, `gortex-compact`, `gortex-repair-policy`, `gortex-sync-skills`, `gortex-repair`, and `gortex-check`. An optional `gortex-status` shortcut can simply run `gortex daemon status`.

Paseo creates new workspaces using the committed configuration on the selected base branch. Commit the updated project configuration there; changing only this kit or an uncommitted worktree copy does not update future workspaces. Existing workspaces may still contain their older configuration.

**No Gortex setup or teardown script is required for a new linked worktree.** Opening the session selects an automatic view over its Git family's primary graph. Explicitly tracking every worktree opts into a dedicated logical graph and can bring back the indexing cost this migration removes.

### 2. Preview and apply legacy cleanup

Close provider sessions that might write their settings, then run:

```powershell
.\Remove-LegacyGortexKit.ps1
.\Remove-LegacyGortexKit.ps1 -Apply -WhatIf
.\Remove-LegacyGortexKit.ps1 -Apply
```

Only the last command writes. Cleanup recognizes the old kit's adapter commands in Claude settings, Codex TOML, and Copilot hook JSON, including the encoded Copilot launcher. It preserves other hooks in the same event. Customized Codex TOML groups are kept intact and flagged for manual review. The old OpenCode `gortex-context.js` plugin is archived only when its content matches the known kit version.

Shared `gortex-*` skill mirrors are archived only when they are same-name links to the legacy Claude skill source, or copies with a valid ownership marker whose content still matches that source. Native skills, unrelated skills, modified copies, and unknown links are preserved. Junction removal never recursively deletes its target.

Every changed file is backed up before modification; removed files and recognized skill mirrors are moved into `~/.gortexkit-backups/<timestamp-guid>/`. The backup directory is printed before the first change so recovery information remains visible if a later step fails. The returned summary includes `Mode`, `Planned`, `Applied`, `BackupDirectory`, `Warnings`, and `Changes`. Repeating cleanup is safe.

`-ConfigRoot <directory>` selects a different configuration tree for cleanup. `-GortexHome <directory>` locates the legacy runtime directory when it differs from `GORTEX_HOME` or `<ConfigRoot>/.gortex`. These options are exclusive to cleanup; the updater uses the native provider paths and environment. Reparse points in configuration ancestors are refused rather than followed.

### 3. Review what cleanup deliberately preserves

- **Instruction blocks:** the `gortex:rules` markers are shared with upstream, so they do not prove kit ownership. Native install refreshes its own files. Compare remaining copies in `~/.copilot/instructions/*.md` and `~/.config/opencode/AGENTS.md` with the native output; remove only a confirmed obsolete copy while preserving your own instructions.
- **Runtime files:** the old `~/.gortex/agent-hooks` payloads are left in place. After configuration and copied project scripts no longer reference them, archive that specific legacy directory. Never delete the entire `.gortex` directory or its store.
- **Customized plugins, commands, or skill copies:** review the warnings and compare against the backup/history before deciding what to remove. A filename alone is not ownership proof.
- **Temporary policy:** a `.gortex.yaml` containing `# Managed temporarily by Manage-GortexWorktree.ps1` merits review. Preserve any useful exclusions or custom policy before removing a confirmed temporary file.
- **Project configuration and registrations:** cleanup never edits Paseo files, Gortex YAML, primary designations, or repository registrations. Review them separately as below.

### 4. Refresh native configuration

```powershell
.\Update-GortexAgents.ps1 -Upgrade
```

If the binary is already current, omit `-Upgrade`. Both paths always run `gortex install --yes --json --hook-mode=deny` with Codex's mode set to `deny`, inspect agent results, then run `daemon status` and `doctor`. An installer exit code of zero alone is insufficient: an adapter can report that it was not configured, and the wrapper treats that as a failure.

The existing native instruction profile stays selected unless `-Profile core`, `localization`, or `full` is supplied. **The kit policy is deny for all four providers**, including when existing configuration uses advisory/enrich mode:

| Provider | Native deny configuration |
| --- | --- |
| Claude Code | `install --hook-mode=deny` |
| Codex | `GORTEX_CODEX_HOOK_MODE=deny` during native installation |
| Copilot CLI | The native `--agent=copilot-cli` hook uses Gortex's deny default |
| OpenCode | `install --hook-mode=deny` configures the native plugin |

The updater restores the caller's environment afterward; Codex's installed hook commands keep their explicit `--mode=deny`. It does not inspect or reproduce legacy mode settings. When running native install manually in a fresh shell, include both the Codex environment setting and `--hook-mode=deny`, as shown in the new-machine steps. A plain native install otherwise uses Codex's advisory default, emitted as `enrich`.

New or changed Codex hooks may need trust approval before doctor is healthy. Read the error, open Codex `/hooks`, review the hooks, then rerun the refresh/check. Start fresh sessions in every provider so instructions, skills, and MCP configuration reload.

### 5. Review old dedicated worktree registrations

```powershell
gortex repos families
gortex repos explain-view C:\Repos\my-project
gortex repos explain-view C:\Path\To\a-paseo-worktree
```

Confirm the intended primary is ready. Old kit registrations often have names such as `<repo>@<worktree>`; names alone do not establish which entry is safe to remove. For a confirmed non-primary dedicated worktree, inspect `gortex untrack --help` and use the native command for that entry. Native untracking can demote a dedicated secondary to automatic when another ready primary survives.

Do not bulk-untrack by a name pattern, infer the primary from whether `.git` is a directory, edit YAML directly to remove registrations, or restart/delete/re-track to expose a worktree. Primary closure, family removal, and `set-primary` require a separate deliberate decision after previewing their effects. `gortex repos reconcile` is a native repair tool if inventory is stale; inspect its help and proposed scope before using it.

## Routine upgrades

Configuration refresh is a separate requirement from replacing the executable. In v0.64.0, `gortex upgrade --run` can exit early when the binary is already current; its post-upgrade configuration migration is also best effort. The updater therefore always performs an explicit native install and checks its results.

For the official Windows installation at `%LOCALAPPDATA%/Programs/gortex/gortex.exe`, `-Upgrade` invokes the official PowerShell installer with the selected installation directory. This handles the location missed by v0.64.0's upgrade detector. The official installer may restart the existing daemon as part of upgrading. For other locations, the wrapper uses native `upgrade --run` (`--no-migrate` when supported), followed by its checked install step.

For a package-manager installation, keeping the package manager in charge is also valid: upgrade Gortex through that manager, then run the wrapper without `-Upgrade`. A custom installation that native upgrade cannot recognize needs its original installation method. `-GortexPath <executable>` selects an explicit binary when multiple installations exist. Check doctor for CLI/daemon version mismatches; the wrapper does not force a second installation or restart loop.

Some releases also require project-local configuration refresh or reindexing for improved extractors. Review the release notes and the existing project's `gortex init` setup, then inspect the resulting diff. If a reindex is needed, use the native Gortex MCP `workspace_admin` tool with the absolute path of the intended primary:

```json
{"operation":"index","arguments":{"path":"C:/Repos/my-project"}}
```

This is a per-repository maintenance step, not part of creating every Paseo worktree. Keep existing excludes unless evidence supports changing them. The old `gortex index .` spelling still appears in an upstream upgrade message but is not a supported v0.64.0 command.

## Validate and recover

On each migrated machine:

1. Check the selected binary version, successful native installation results, and `gortex doctor` output.
2. Start each provider you use through Paseo and verify native Gortex tools, instructions, and hooks are active. Approve changed Codex hooks where required.
3. Create one disposable Paseo worktree from the updated base branch. Confirm `explain-view` selects that checkout and reuses the intended family primary. Ask about a file changed only in that worktree to verify branch-correct results. Initial activation can still take time for a large delta; it should not require the old full registration workflow.
4. Remove the disposable workspace through Paseo and confirm the primary remains available. No kit teardown should run.

If cleanup changed the wrong configuration, stop the affected provider and restore the relevant original file from the reported backup. For an archived skill junction, move the junction itself back; do not copy or recursively delete its target. Restore only the affected paths, accounting for any native install changes made afterward. Unknown artifacts remaining in a cleanup report do not justify clearing all hooks or resetting the Gortex store.

## Why the kit became smaller

The [v0.64.0 release](https://github.com/zzet/gortex/releases/tag/v0.64.0) consolidates changes since v0.63.0: native automatic worktree/branch views, lower indexing and search memory, Copilot/OpenCode support, richer Codex integration, Windows fixes, and version diagnostics. Language graph and edit-safety improvements require the updated native binary and configuration, not extra kit hooks.

Implementation details for the maintenance choices are in upstream [upgrade](https://github.com/zzet/gortex/blob/v0.64.0/cmd/gortex/upgrade.go), [post-upgrade migration](https://github.com/zzet/gortex/blob/v0.64.0/cmd/gortex/upgrade_migrate.go), [native install](https://github.com/zzet/gortex/blob/v0.64.0/cmd/gortex/install.go), and the [Windows installer](https://github.com/zzet/gortex/blob/v0.64.0/scripts/install.ps1).
