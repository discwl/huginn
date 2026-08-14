# huginn

Workstation setup kit for [Gortex](https://gortex.dev) across **Claude Code, GitHub Copilot CLI, Copilot in VS Code, Codex, and OpenCode** on Windows.

Five names, four runtimes — Copilot in VS Code execs the same `copilot` binary as the terminal CLI and shares its hooks and skills, so wiring Copilot CLI covers both.

Gortex installs MCP servers and hooks on its own. This kit closes three gaps it leaves open:

- **Nothing checks whether a repository has finished indexing.** Registration takes seconds; a first index can take 15–20 minutes. In between, every graph query returns nothing and the agent silently falls back to raw file reads. The kit adds a readiness gate that waits.
- **Skills install for Claude Code only.** Copilot CLI and Codex get none. The kit mirrors them.
- **Exclusions are hand-guessed per repository.** The kit derives them from the repo itself.

## Install

```powershell
git clone https://github.com/discwl/huginn.git C:\huginn
cd C:\huginn
.\Install-GortexAgentKit.ps1 -WhatIf    # review
.\Install-GortexAgentKit.ps1
```

Then restart every agent — hooks and skills load at session start.

Full instructions, per-repo configuration, verification, and troubleshooting are in **[RUNBOOK.md](RUNBOOK.md)**, which is written to be handed to a coding agent:

> Read `C:\huginn\RUNBOOK.md` and set up this machine. Run the verification section at the end and report the results.

## Contents

| Path | Purpose |
|---|---|
| `Install-GortexAgentKit.ps1` | Detects agents, wires the gate, mirrors skills. Idempotent, supports `-WhatIf` |
| `Analyze-RepoExclusions.ps1` | Derives per-repo exclusions from tracked content |
| `Sync-AgentSkills.ps1` | Mirrors Gortex skills to Copilot CLI and Codex |
| `hooks/gortex-readiness.ps1` | The readiness gate — single source of truth |
| `hooks/*-hook.ps1` | Per-agent adapters |
| `plugin/gortex-context.js` | OpenCode plugin |
| `tests/opencode-plugin.test.mjs` | Exercises the plugin's gate and enrichment flow |
| `transitional/` | Worktree lifecycle helper — see below |

## Transitional tier

`transitional/Manage-GortexWorktree.ps1` registers Paseo-created worktrees with Gortex and waits for their first index. Native Gortex worktree support — automatic tracking and parallel per-worktree indexing — is expected shortly, at which point this becomes unnecessary.

**Skip it on a new machine unless you need worktree indexing today.** It shares no code with the gate, so dropping it changes nothing else. Its `-Action Compact` and `-Action Status` remain useful regardless: the store is SQLite and never shrinks on delete, so compaction reclaims space with no re-indexing.

## Requirements

Windows, PowerShell 7+, Gortex 0.63.3+, Git. `sqlite3` only for store compaction; `node` only to run the OpenCode plugin tests.
