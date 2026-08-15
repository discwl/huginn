# huginn

Workstation setup kit for [Gortex](https://gortex.dev) across **Claude Code, GitHub Copilot CLI, Copilot in VS Code, Codex, and OpenCode** on Windows.

Five names, four hook runtimes — Copilot in VS Code execs the same `copilot` binary as the terminal CLI and shares its hooks and skills, so wiring Copilot CLI covers both. MCP is the exception: the Chat panel is a separate runtime with its own server registry. Instructions go the other way — all three Copilot surfaces read `~\.copilot\copilot-instructions.md`, so one file covers the lot.

Gortex installs MCP servers and hooks on its own — but not for either Copilot surface. This kit closes five gaps it leaves open:

- **Nothing checks whether a repository has finished indexing.** Registration takes seconds; a first index can take 15–20 minutes. In between, every graph query returns nothing and the agent silently falls back to raw file reads. The kit adds a readiness gate that waits.
- **Skills install for Claude Code only.** Copilot CLI and Codex get none. The kit mirrors them.
- **Neither Copilot surface gets the MCP server.** Gortex has no Copilot CLI adapter at all, and its `vscode` adapter writes a *repo-local* `.vscode\mcp.json` instead of the user profile. Both end up with skills that fail the moment they are invoked. The kit registers the server in `~\.copilot\mcp-config.json` and `%APPDATA%\Code\User\mcp.json`.
- **Copilot is never told to prefer the graph.** `gortex install --claude-md` writes the rule block for Claude Code and there is no Copilot equivalent, so Copilot gets the tools and the skills but no instruction to use them. The kit writes `~\.copilot\copilot-instructions.md`.
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
| `Install-GortexAgentKit.ps1` | Detects agents, wires the gate, registers MCP for both Copilot surfaces, writes Copilot's rule block, mirrors skills. Idempotent, supports `-WhatIf` |
| `Repair-GortexAgentKit.ps1` | Diagnoses and repairs the whole integration — daemon, tracking, index, hooks, MCP, instructions, skills. `-CheckOnly` makes it a health probe |
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
