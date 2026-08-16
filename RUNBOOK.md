# Gortex Agent Kit — Setup Runbook

Portable setup for **Gortex** (code-graph daemon + MCP server) across **Claude Code, GitHub Copilot CLI, Copilot in VS Code, Codex, and OpenCode** on Windows.

Those five names are **four hook runtimes** — Copilot in VS Code execs the same `copilot` binary as the terminal CLI and shares its hooks, skills, and instructions, so wiring Copilot CLI covers both. MCP is the one exception: the two surfaces read **different** MCP config files, and both are wired separately. See section 4.

This runbook is written to be executed by an agent. Hand it, plus the `C:\huginn` folder, to a coding agent on the target machine and say:

> Read `C:\huginn\RUNBOOK.md` and set up this machine. Run the verification section at the end and report the results.

It is equally usable by a human — every step is a real command.

---

## 1. What this kit adds

Gortex installs MCP servers and hooks on its own — but not for either Copilot surface. This kit closes four gaps it leaves open:

| Gap | Consequence | Fixed by |
|---|---|---|
| Nothing checks whether the repo has finished indexing | Agents start against an empty graph and silently fall back to raw file reads | `hooks\gortex-readiness.ps1` + per-agent adapters |
| Skills install for Claude Code only | Copilot CLI and Codex get no Gortex skills | `Sync-AgentSkills.ps1` |
| Neither Copilot surface gets the MCP server or the rule block | Copilot has Gortex skills but no Gortex tools, and is never told to prefer the graph | `Install-GortexAgentKit.ps1` (`copilot` + `vscode`) |
| Exclusions are hand-guessed per repo | Generated code dominates the index and slows it dramatically | `Analyze-RepoExclusions.ps1` |

The readiness gap is the important one. **Registration and indexing are separate states.** A repository is tracked within seconds; its first index can take 15–20 minutes on a large repo. In between, every graph query returns nothing and the agent has no way to tell that apart from "no results".

The MCP gap is the quietest one. `gortex install --agents auto` looks like it covers everything, but its adapter list has **no `copilot` entry at all** (`claude-code, cursor, aider, antigravity, cline, codex, continue, gemini, hermes, kimi, kilocode, kiro, oh-my-pi, opencode, openclaw, pi, vscode, windsurf, zed`), and its `vscode` entry writes a **repo-local** `.vscode\mcp.json` rather than the user profile. Copilot therefore ends up fully gated, fully skilled, and unable to answer a single graph query.

---

## 2. Two tiers — read this before installing

**Durable tier (install everywhere).** The readiness gate, agent hooks, skill mirror, and exclusion analyzer. These are independent of any worktree manager.

**Transitional tier (`transitional\`, install only if needed).** `Manage-GortexWorktree.ps1` registers Paseo-created worktrees with Gortex and waits for their first index.

> The Gortex author has confirmed that native worktree support — automatic tracking, parallel per-worktree indexing, painless branch switching — is expected within about a week of this writing. **On a new machine, skip the transitional tier unless you need worktree indexing today.** When native support ships, delete `transitional\` and the `worktree` block from `paseo.json`.

The two tiers share no code, so dropping the transitional tier changes nothing about the gate.

---

## 3. Prerequisites

```powershell
# Required
winget install --id Microsoft.PowerShell        # pwsh 7+
git --version

# Gortex itself — signed release, SHA-256 verified, adds itself to the user PATH
irm https://get.gortex.dev/install.ps1 | iex

# Optional: needed only for store compaction (section 9)
winget install --id SQLite.SQLite
```

Open a new shell so the PATH change applies, then confirm:

```powershell
gortex version                                  # 0.63.3 or newer
```

Confirm the daemon runs:

```powershell
gortex daemon status
gortex daemon start --detach   # only if it is not running
```

> On a fresh machine the installer's closing version banner emits `Error: daemon not reachable ... is it running?`. That is the installer probing a daemon that does not exist yet, not a failed install. Start it as above.

Clone the kit to the **same absolute path on every machine** so `paseo.json` and hook commands stay portable:

```powershell
git clone https://github.com/discwl/huginn.git C:\huginn
```

Keep that exact path. Every wired hook command and `paseo.json` entry resolves against it, so a machine that clones elsewhere will not match the documented commands.

---

## 4. Install

```powershell
cd C:\huginn
.\Install-GortexAgentKit.ps1 -WhatIf    # review first
.\Install-GortexAgentKit.ps1
```

The installer:

1. Detects Claude Code, Copilot CLI, Copilot in VS Code, Codex, and OpenCode.
2. Copies the hook runtime into `~\.gortex\agent-hooks`.
3. Wires each agent's `UserPromptSubmit` to the readiness gate.
4. Registers the Gortex MCP server for both Copilot surfaces, and writes the Gortex rule block.
5. Installs the OpenCode plugin.
6. Mirrors Gortex skills into `~\.agents\skills`, seeding them first if needed (see below).

Only detected agents are wired, so you do not need to name the ones this machine uses. Nothing is installed for an agent that is absent.

**Copilot in VS Code shares everything except MCP.** VS Code does not embed its own copy of the CLI. Its Copilot agent host ships a bootstrapper that locates `copilot` on PATH and execs it with the arguments unchanged, setting no config-dir, `HOME`, or `XDG_*` override. It therefore reads the same `~\.copilot\hooks\gortex.json`, the same `~\.agents\skills`, and the same `~\.copilot\copilot-instructions.md` as the terminal CLI, and is gated identically.

**MCP is the exception, and it is the one thing you must wire twice.** The two surfaces read *different* server registries:

| Surface | MCP config | Written by |
|---|---|---|
| Copilot CLI + VS Code agent host | `~\.copilot\mcp-config.json` | this kit |
| Native Copilot Chat panel | `%APPDATA%\Code\User\mcp.json` | this kit |

Gortex writes neither. It has **no `copilot` adapter at all**, and `gortex install --agents vscode` writes a repo-local `.vscode\mcp.json` that only covers whichever folder was open when it ran. The installer writes the user profile instead, so the graph is available in every workspace.

The rule block is written **once**, to `~\.copilot\copilot-instructions.md`, because that file is shared. It is delimited by `<!-- gortex:rules:start -->` / `<!-- gortex:rules:end -->` and anything you write around it is preserved. The profile body is **inlined rather than `@`-imported**: Claude's block is a one-line `@<path>` pointer, but the Copilot CLI has no import resolution and would pass that line to the model as literal text. Re-run the installer after `gortex instructions switch` to refresh it — the body is compared every run, so no `-Force` is needed.

Two consequences worth knowing:

- The host enforces a **minimum Copilot CLI version of 0.0.394** at launch. Below that it refuses to start, and the gate never runs because the CLI never runs.
- If `copilot` is not on PATH for the VS Code process, the host cannot start at all. A PATH change made after VS Code launched will not be visible to it — restart VS Code, not just the window.

> The native Copilot Chat panel is a separate runtime. It exposes MCP and instructions but **no hook API**, so it cannot be gated: its Gortex tools are simply present, and return nothing until the index is ready.

**You do not need Claude Code to get skills.** Gortex writes its skill set for exactly one adapter — Claude Code, under `~\.claude\skills` — and that is the only source the mirror can read. On a machine without Claude, the installer therefore runs the `claude-code` adapter itself purely to produce that directory:

```powershell
gortex install --agents claude-code --no-hooks --no-claude-md --yes
```

This writes all 21 `gortex-*` skills whether or not the Claude CLI exists. Hooks and `CLAUDE.md` are suppressed because no Claude session will consume them. The step is skipped when `~\.claude\skills` already exists, so it costs nothing on repeat runs, and it is bypassed entirely by `-SkipSkills` or `-SkipGortexInstall`.

Expect `21 skill(s) mirrored` on a fresh machine. `0` means seeding was skipped — check that `gortex` is on PATH.

This is a workaround for Gortex distributing skills to one adapter only. When upstream ships skills for the other agents, drop the mirror and read section 11.

It is **idempotent** — a second run reports `already current` for every agent and writes nothing. It backs up every file it modifies as `<name>.bak-<timestamp>`.

Idempotency costs one deliberate compromise on Codex. `gortex install --agents codex` unconditionally re-adds its own `[[hooks.UserPromptSubmit]]` block, which the gate then has to strip again, so re-running it every time would rewrite `config.toml` and strand another backup on every install. The installer therefore seeds the Codex hook table only once — when `config.toml` has no `hook --agent=codex` command yet. **Pass `-Force` after upgrading Gortex** to re-seed it and pick up a changed hook table (section 11).

Useful switches:

| Switch | Use |
|---|---|
| `-Agents claude-code,codex` | Wire only specific agents |
| `-ConfigRoot <path>` | Write into another profile or a test sandbox instead of `$HOME` |
| `-SkipGortexInstall` | Do not re-run `gortex install` |
| `-SkipSkills` | Do not touch the skill mirror |
| `-GateTimeoutSec 3600` | Raise the wait ceiling for a very large repo |
| `-Force` | Rewrite files even when unchanged |

**Then restart every agent.** Hooks and skills are read at session start.

**Codex asks to re-approve its hook once.** It stores a `trusted_hash` per hook, and the command changed. This is expected.

---

## 5. Track each repository, then configure its exclusions

Gortex indexes only repositories it has been told about, and a fresh install tracks none. **Register the repo first** — the exclusion block below, and the gate itself, both key off the entry this creates:

```powershell
cd C:\Path\To\YourRepo
gortex track .
gortex repos          # confirm it appears, and watch FRESHNESS reach 'fresh'
```

Tracking returns in seconds; the first index runs in the background. Until the repo is tracked the gate reports `State: Untracked` and allows every prompt through, because an untracked cwd is indistinguishable from ordinary work outside a checkout.

Exclusions differ per repo, so derive them rather than guessing.

```powershell
C:\huginn\Analyze-RepoExclusions.ps1 -RepositoryPath .
```

It reports two things `.gitignore` alone gets wrong:

- **Tracked but generated** — committed code no agent should read (EF migration designers, minified JS, source maps, vendored `dist/`, binary assets).
- **Ignored but valuable** — `local/` dev scripts, docs, Obsidian vaults that agents *should* see.

It ends with a paste-ready block. Put it in the repo's entry in `~\.gortex\config.yaml`:

```yaml
      exclude:
        - '!local/'
        - '!local/**'
        - 'local/**/bin/'
        - 'local/**/obj/'
        - '**/Migrations/*.Designer.cs'
```

Then:

```powershell
gortex daemon reload
```

**Order matters.** Re-includes (`!`) are emitted first so a later exclude cannot shadow them. Re-including a directory also re-admits its build output, so each `!dir/` is paired with `dir/**/bin/`, `dir/**/obj/`, and `dir/**/node_modules/`.

Tuning:

| Parameter | Default | Effect |
|---|---|---|
| `-MinimumFileCount` | 5 | Lower it to surface small generated sets |
| `-MinimumPatternKb` | 256 | Size at which a few files still qualify (catches lockfiles) |
| `-MinimumSignalFiles` | 3 | Evidence required to recommend a re-include |
| `-LargeFileKb` | 512 | Large-file report cutoff |

> Validated against two repositories. On a 7,689-file .NET repo it independently reproduced all six hand-derived rules, including 702 EF designer files at 81.8 MB, and reported 85% of tracked bytes as excludable. On a 2,504-file Angular repo it found a 994 KB `package-lock.json` plus committed coverage output, and correctly proposed no re-includes. Always skim the output rather than pasting blind.

---

## 6. Verify

Run all of these against a **tracked** repository (section 5) — against an untracked one, check 1 correctly returns `Untracked` rather than `Ready`. Every check should pass.

```powershell
# 1. Gate resolves a tracked repo
cd C:\Path\To\YourRepo
pwsh -File "$HOME\.gortex\agent-hooks\gortex-readiness.ps1" -Cwd . -Json
# expect: {"Decision":"allow","State":"Ready",...}

# 2. Hooks execute and exit 0
$p = '{"hook_event_name":"UserPromptSubmit","cwd":"C:/Path/To/YourRepo","prompt":"hi"}'
foreach ($h in 'claude-hook.ps1','codex-hook.ps1','copilot-hook.ps1') {
  $p | pwsh -NoProfile -File "$HOME\.gortex\agent-hooks\$h" | Out-Null
  "$h exit=$LASTEXITCODE"     # expect 0
}

# 3. Skills mirrored
(Get-ChildItem "$HOME\.agents\skills" -Directory -Filter 'gortex-*').Count   # expect > 0

# 4. Wiring present
Select-String "$HOME\.codex\config.toml" -Pattern 'codex-hook.ps1'
(Get-Content "$HOME\.copilot\hooks\gortex.json" -Raw | ConvertFrom-Json).hooks.UserPromptSubmit[0].timeoutSec   # expect 1860

# 4a. Copilot hook events are ARRAYS — a bare object parses fine and never runs
$h = (Get-Content "$HOME\.copilot\hooks\gortex.json" -Raw | ConvertFrom-Json).hooks
$h.PSObject.Properties | ForEach-Object { "{0,-16} isArray={1}" -f $_.Name, ($_.Value -is [array]) }
# expect: isArray=True on every row. Note `.UserPromptSubmit[0]` above passes either way,
# because indexing a PSCustomObject returns the object itself — so check this too.
(Get-Content "$HOME\.claude\settings.json" -Raw | ConvertFrom-Json).hooks.UserPromptSubmit |
  ForEach-Object { $_.hooks[0].command } | Select-String 'gortex'

# 4a-ii. Claude needs PreToolUse too, or the deny posture is inert
(Get-Content "$HOME\.claude\settings.json" -Raw | ConvertFrom-Json).hooks.PreToolUse |
  ForEach-Object { $_.hooks[0].command } | Select-String 'claude-hook.cmd -Mode deny'
# expect a match. UserPromptSubmit alone gates availability, not usage.

# 4a-iii. Prove the block end to end (both hosts refuse the call, not just advise)
$probe = @{ hook_event_name='PreToolUse'; cwd=(Get-Location).Path; tool_name='Grep'
            tool_input=@{ pattern='<an-indexed-symbol>' } } | ConvertTo-Json -Compress
$probe | & "$HOME\.gortex\agent-hooks\claude-hook.cmd"  -Mode deny   # expect permissionDecision=deny
$probe | & "$HOME\.gortex\agent-hooks\copilot-hook.ps1" -Mode deny   # expect the same JSON, verbatim
# A pattern matching nothing indexed returns NO output at all — that is not a failure.

# 4b. MCP registered on BOTH Copilot surfaces — they read different files
copilot mcp get gortex          # expect: Status: Enabled, Command: gortex mcp
(Get-Content "$env:APPDATA\Code\User\mcp.json" -Raw | ConvertFrom-Json -AsHashtable).servers.gortex.command   # expect: gortex

# 4c. Rule block present (shared by both surfaces, so only one file)
Select-String "$HOME\.copilot\copilot-instructions.md" -Pattern 'gortex:rules:start'

# 5. OpenCode plugin control flow (requires node)
#    Use the deployed copy if OpenCode is wired, otherwise the kit's source.
$plugin = Join-Path $env:TEMP 'gortex-plugin-test.mjs'
$deployed = "$HOME\.config\opencode\plugin\gortex-context.js"
Copy-Item $(if (Test-Path $deployed) { $deployed } else { 'C:\huginn\plugin\gortex-context.js' }) $plugin -Force
node C:\huginn\tests\opencode-plugin.test.mjs ([Uri](Resolve-Path $plugin).Path).AbsoluteUri (Get-Location).Path
# expect: 8 passed, 0 failed

# 6. All of the above, as one probe
pwsh -File C:\huginn\Repair-GortexAgentKit.ps1 -RepoPath . -CheckOnly
# expect: every row Ok, "Gortex integration is healthy.", exit code 0
```

The OpenCode test shims `Bun.spawn` onto Node so the plugin calls the **real** gate script — only the runtime is substituted. It proves a ready repo injects no directive, a blocked one injects a STOP directive carrying the gate's reason, orientation text is suppressed while blocked, sessions are cached after the first probe, and tool enrichment never destroys the original tool output.

> The gate is invoked by Copilot, Codex, and OpenCode through **`powershell.exe`** (Windows PowerShell 5.1), not `pwsh`. It is verified to run correctly under both.

Then, **in each agent**, confirm the graph is live by asking it to find a symbol. It should use Gortex MCP tools rather than grep.

---

## 7. How the gate behaves

`gortex-readiness.ps1` is the single source of truth. Every adapter dot-sources it or calls it with `-Cwd <path> -Json`. **Never reimplement it per agent.**

| State | Decision | Why |
|---|---|---|
| `Ready` | allow | Graph is queryable |
| `PendingOrIndexing` | **wait**, then allow | See below |
| `Untracked` | allow | Not an indexed repo; nothing to gate |
| daemon down | **block** with remediation | No query can be served and no index can progress |
| daemon unreachable / occupied | **block** with remediation | Readiness cannot be confirmed |

**The gate waits rather than blocks while indexing.** Every host tested discards a blocked first prompt and nothing re-sends it, so blocking would lose the user's instruction and strand the agent. This is why `UserPromptSubmit` has a 1860-second timeout while every other event stays at 15.

Per-session bypass:

```powershell
$env:GORTEX_CLAUDE_REQUIRED  = '0'
$env:GORTEX_COPILOT_REQUIRED = '0'
$env:GORTEX_CODEX_REQUIRED   = '0'
```

### What "required" does and does not mean

`GORTEX_*_REQUIRED` gates **availability, not usage**. It refuses to start a turn when the graph cannot answer — daemon down, unreachable, or still indexing. Once the state is `Ready` the gate allows silently. Usage is enforced separately, by the hook posture.

Under the default `deny` posture the `PreToolUse` hook is **a real block, not advice** — on both Claude Code and Copilot CLI. Gortex replies with `hookSpecificOutput.permissionDecision = "deny"`, and Copilot's tool loop acts on it; the call never runs and the transcript shows `Denied by preToolUse hook`. It reads the *nested* field because entries registered under the PascalCase event names are tagged `_vsCodeCompat` when the config loads, so Gortex's native Claude-shaped reply needs no translation. `hooks/copilot-hook.ps1` therefore forwards a denial verbatim instead of flattening it into `additionalContext` — flattening demotes a hard block to a suggestion, which is what previously left the graph optional under `deny`.

> Verified on Copilot CLI 1.0.80. An earlier note here claimed `PreToolUse` was advisory on Copilot and that only `UserPromptSubmit` honoured a block. That was wrong. `{"decision":"block"}`, a top-level `permissionDecision`, and the nested `hookSpecificOutput` form all block a `PreToolUse` call. Exit code 2 and `{"continue":false}` are still ignored.

**Gortex registers Claude hooks, but they never run.** `gortex install --agents claude-code` **does** write eight events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`) — into `~\.claude\settings.local.json`, not `settings.json`, which is why they are easy to miss. It writes `--mode=<posture>` only when the posture is **not** the default, so a bare `gortex.exe hook` is a `deny` entry:

```powershell
# what the mode string means
Get-Content "$HOME\.claude\settings.local.json" -Raw | ConvertFrom-Json |
  ForEach-Object { $_.hooks.PreToolUse[0].hooks[0].command }
# 'gortex.exe hook'               -> deny  (default; no flag written)
# 'gortex.exe hook --mode=enrich' -> enrich (explicitly chosen at install time)
```

The posture is right and the JSON is well formed, but **Claude does not load a user-scope `~\.claude\settings.local.json`**, so all eight are inert. `gortex install` still reports `all hooks already present`, so nothing surfaces the gap. That is why the kit registers its own `UserPromptSubmit` (readiness gate, long timeout) and `PreToolUse` (deny posture, quick timeout) in `~\.claude\settings.json`. The `PreToolUse` entry is **not** a duplicate — it is Claude's only working enforcement point. `Repair-GortexAgentKit.ps1` flags a missing one as `Claude Code PreToolUse hook not registered`.

> Verified on Claude Code 2.1.233, three ways. (1) With the kit's `settings.json` `PreToolUse` removed, a `Grep` for an indexed symbol **ran**. (2) It still ran after correcting Gortex's entry from `matcher: "*"` to `""`, ruling out the matcher. (3) Replacing Gortex's `PreToolUse` *and* `SessionStart` commands with a sentinel that appends to a file produced **no file at all** across a full session — the hooks are never invoked. Restoring the kit's entry blocks the same `Grep`. Note this also means Gortex's `SessionStart` orientation and `PostToolUse` localization hooks are not running on Claude either.

The block is **selective, not total**, so it is a strong default rather than an absolute guarantee:

- Gortex only denies when the tool argument matches an indexed symbol. On a tracked repo, `Grep` is hard-denied; `Read` and `Glob` return advisory `additionalContext` only.
- A prompt matching nothing indexed returns no hook output at all.
- The rule block in `~\.copilot\copilot-instructions.md` (section 13) remains a soft channel the model may ignore.

To make the graph the *only* option, remove the built-in file tools so the model never sees them:

```powershell
copilot --excluded-tools view,grep,glob
copilot --available-tools gortex     # stricter: only Gortex tools survive

claude --disallowedTools Read,Grep,Glob
```

Claude's MCP tools are named `mcp__<server>__<tool>` — this machine's `permissions.allow` lists them individually (`mcp__gortex__search`, `mcp__gortex__read`, …), which is the form to reuse for `--allowedTools`.

`--available-tools` and `--excluded-tools` filter what the model can see; `--allow-tool` / `--deny-tool` only control approval prompts and cannot re-expose a filtered tool. Neither filter has a persisted `config.json` equivalent, so it must be passed per invocation — wrap it in a shell alias if you want it always on. Verify with `copilot help permissions`. Claude's `--allowedTools` / `--disallowedTools` (also spelled `--allowed-tools` / `--disallowed-tools`) are per-invocation too, but unlike Copilot they *do* have a persisted equivalent: the `permissions.allow` / `permissions.deny` arrays in `~\.claude\settings.json`, which this machine already uses to auto-approve the read-only Gortex MCP tools.

---

## 8. Skills

Gortex installs skills for Claude Code only. `Sync-AgentSkills.ps1` mirrors them:

```powershell
C:\huginn\Sync-AgentSkills.ps1 -Prune
```

| Agent | Skill root |
|---|---|
| Claude Code | `~\.claude\skills` (Gortex writes here) |
| Copilot CLI | `~\.agents\skills` |
| Copilot in VS Code | `~\.agents\skills` — same binary as Copilot CLI, nothing extra to do |
| Codex | `~\.codex\skills` **and** `~\.agents\skills` |

`~\.agents\skills` serves **both** Copilot CLI and Codex, so mirroring there once avoids registering every skill twice.

If `~\.claude\skills` does not exist, this script throws — it has no source to mirror. The installer seeds it automatically (section 4); to do it by hand on a machine without Claude Code:

```powershell
gortex install --agents claude-code --no-hooks --no-claude-md --yes
C:\huginn\Sync-AgentSkills.ps1 -Prune
```

The mirror uses **directory junctions, not copies**, so skills stay current when Gortex rewrites them on upgrade. Junctions need no elevation.

> **Never** `Remove-Item -Recurse` a junction — it walks into the target and deletes the real skills. The script uses `[IO.Directory]::Delete($path, $false)` on reparse points. Keep that behaviour if you edit it.

Restart agents after syncing.

---

## 9. Store maintenance

Gortex stores everything in one SQLite database. SQLite never shrinks on delete, and Gortex exposes no vacuum command, so untracking repositories leaves free pages behind indefinitely.

Check health:

```powershell
C:\huginn\transitional\Manage-GortexWorktree.ps1 -Action Status -WorktreePath .
```

Look at `StoreSize`, `StoreLive`, `StoreReclaimable`, and `StoreHealth`. Compact when `StoreHealth` is `CompactionRecommended`:

```powershell
C:\huginn\transitional\Manage-GortexWorktree.ps1 -Action Compact
```

Compaction stops the daemon, waits for an exclusive lock, runs `VACUUM`, verifies integrity, and restarts the daemon in a `finally` block. It **refuses to run while any repository is indexing**.

- Reclaims space with **zero re-indexing** — a rebuild takes 15–20 minutes and lands at the same size.
- Needs free disk of roughly 2.2× the live bytes, since `VACUUM` builds a full replacement.
- Run it when agents are idle. An active `gortex mcp` client can auto-start the daemon and cause `SQLITE_BUSY`.
- `-BackupStore` is deliberately not the default: backups are timestamped and never pruned, so every run would strand another full-size copy.

---

## 10. Paseo integration (optional)

If the machine uses Paseo, add this to each repo's `paseo.json`. It points at the fixed kit path, so it is identical for every repo:

```json
{
  "scripts": {
    "gortex-status": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Status -WorktreePath ."
    },
    "gortex-wait": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Wait -WorktreePath ."
    },
    "gortex-compact": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Compact"
    },
    "gortex-sync-skills": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\Sync-AgentSkills.ps1\" -Prune"
    }
  }
}
```

Add the `worktree` block **only if** you need worktree indexing before native Gortex support ships:

```json
{
  "worktree": {
    "setup": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Setup -WorktreePath . -SourceCheckoutPath \"$env:PASEO_SOURCE_CHECKOUT_PATH\"",
    "teardown": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Teardown"
  }
}
```

Setup emits a heartbeat every 10 seconds with state, elapsed time, timeout, branch, and HEAD.

### Adding your own setup steps

`setup` and `teardown` accept either a single string or an **array of strings** (`z.union([z.string(), z.array(z.string())])`). Use the array form to add per-repo bootstrapping such as dependency installs:

```json
{
  "worktree": {
    "setup": [
      "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Setup -WorktreePath . -SourceCheckoutPath \"$env:PASEO_SOURCE_CHECKOUT_PATH\"",
      "npm ci --no-audit --no-fund"
    ],
    "teardown": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\huginn\\transitional\\Manage-GortexWorktree.ps1\" -Action Teardown"
  }
}
```

Entries run **sequentially and fail-fast** — a non-zero exit throws and skips the rest. The worktree is preserved on failure (`cleanupOnFailure: false`), so you can inspect it. Each entry runs in its own shell with `cwd` set to the worktree, and the UI reports per-step progress (`2/2`).

On Windows each entry is run as `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "<entry>"` — Windows PowerShell 5.1, not `pwsh`. Two consequences:

- `$env:PASEO_*` **does** expand, which is why the `-SourceCheckoutPath` argument above works.
- The entry is PowerShell, not a shell line, so `;` really does swallow a failure. That is the mechanism behind the warning below.

Note the asymmetry with the `scripts` block: only `worktree.setup`/`teardown` accept an array. A `scripts.<name>.command` **must be a single string** — Paseo's `getScriptConfigs` silently skips any entry whose `command` is not a string, so an array there yields a script that never appears rather than an error.

Do not chain steps with `;` or `&&` inside one string. Each array entry is invoked directly rather than concatenated into a shell line, and in PowerShell `;` swallows the failure — a broken install would silently continue to the next step.

**Put the Gortex step first.** Paseo starts the agent as soon as the worktree exists and runs setup in the background, so ordering decides what the gate can protect:

| Order | Gate state at agent start | Result |
|---|---|---|
| Gortex first | tracked, indexing (within ~5s) | agent waits for the index |
| Gortex last | untracked | **allowed immediately** — the gate cannot help |

The gate allows an untracked cwd on purpose, since the agent may legitimately be working outside any tracked checkout. Registering first is what converts that into a wait.

Steps after the Gortex one run once the gate has already released the agent, so it may work briefly while they finish — usually acceptable for dependency installs. If a step must complete before the agent touches anything, have the last entry write a marker file and wait on it:

```powershell
# final setup entry
New-Item -Force -ItemType File (Join-Path (git rev-parse --absolute-git-dir) 'setup-complete')
```

Use `--absolute-git-dir`, which is per-worktree. `--git-common-dir` is shared by every worktree, so a marker there would falsely release all of them.

Delete the marker on teardown, and **guard the delete with `Test-Path`**:

```powershell
# teardown entry — idempotent, exits 0 whether or not the marker exists
if (Test-Path (Join-Path (git rev-parse --absolute-git-dir) 'setup-complete')) { Remove-Item (Join-Path (git rev-parse --absolute-git-dir) 'setup-complete') -Force }
```

`Remove-Item -ErrorAction SilentlyContinue` is **not** sufficient here. Suppressing a non-terminating error still leaves `$?` false, so `powershell -Command` exits 1 and Paseo reports the teardown as failed whenever the marker is already gone — which is exactly the case when setup failed before reaching the marker step. `-ErrorAction Ignore` has the same problem. Only avoiding the error entirely gives a clean exit.

These commands receive `PASEO_SOURCE_CHECKOUT_PATH` (the shared original repo root, for copying gitignored local files such as `.env` into the worktree), `PASEO_ROOT_PATH` (a backward-compatible alias for the same value), `PASEO_WORKTREE_PATH`, `PASEO_BRANCH_NAME`, and `PASEO_WORKTREE_PORT`.

### Complete example — repo-vendored scripts

The blocks above point at the fixed `C:\huginn` install. The alternative is to keep the scripts **inside the repo** under `local\Paseo\`, which is the configuration in production use on a large .NET repo:

```json
{
  "worktree": {
    "setup": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Manage-GortexWorktree.ps1') -Action Setup -WorktreePath . -SourceCheckoutPath (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim()))\"",
    "teardown": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"$env:PASEO_SOURCE_CHECKOUT_PATH\\local\\Paseo\\Manage-GortexWorktree.ps1\" -Action Teardown"
  },
  "scripts": {
    "gortex-status": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Manage-GortexWorktree.ps1') -Action Status -WorktreePath .\""
    },
    "gortex-repair-policy": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Manage-GortexWorktree.ps1') -Action Setup -WorktreePath . -SourceCheckoutPath (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim()))\""
    },
    "gortex-wait": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Manage-GortexWorktree.ps1') -Action Wait -WorktreePath .\""
    },
    "gortex-compact": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Manage-GortexWorktree.ps1') -Action Compact\""
    },
    "gortex-sync-skills": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Sync-AgentSkills.ps1') -Prune\""
    },
    "gortex-repair": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Repair-GortexAgentKit.ps1') -RepoPath .\""
    },
    "gortex-check": {
      "command": "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"& (Join-Path (Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())) 'local/Paseo/Repair-GortexAgentKit.ps1') -RepoPath . -CheckOnly\""
    }
  },
  "metadataGeneration": {
    "branchName": {
      "instructions": "Use feature/<ticket-key>[-<ticket-key>...]-<description> for features, stories, or tasks; bugfix/... for normal bugs; hotfix/[<version>/]... for urgent production fixes; and release/<version> for releases. Include every supplied ticket key. Never invent keys or versions. Lowercase kebab-case only."
    },
    "commitMessage": {
      "instructions": "Use the installed humanizer skill. Format: <ticket-key>[, <ticket-key>...] - <imperative summary>. Include every ticket key visible in the context; never invent one. No conventional prefix or trailing period."
    },
    "pullRequest": {
      "instructions": "Use the installed humanizer skill. Title: <ticket-key>[, <ticket-key>...] - <summary>. Include every ticket key visible in the context; never invent one. Body: what changed, why, actual validation, and material risks or configuration. Omit filler and empty sections."
    }
  }
}
```

**Why the path is computed instead of hardcoded.** `local\` is gitignored, and **git does not populate ignored files into a new worktree**. The scripts therefore exist only in the main checkout, never in the worktree Paseo just created. Every command resolves back to that main checkout:

```powershell
Split-Path -Parent ((& git rev-parse --path-format=absolute --git-common-dir | Out-String).Trim())
```

`--git-common-dir` returns the shared `.git` directory even when invoked from inside a linked worktree, so its parent is always the main checkout root. Three details matter:

- `--path-format=absolute` is load-bearing, and it fails in a place you would not expect. From a **linked worktree** git returns an absolute path either way, so the flag looks redundant. From the **main checkout** it returns the literal string `.git`, and `Split-Path -Parent '.git'` is the empty string, so `Join-Path` collapses and the command dies. The `scripts` entries are routinely run from the main checkout, so dropping the flag breaks them there while every worktree keeps working — a failure that is easy to misread as worktree-specific.
- `Out-String` then `.Trim()` strips git's trailing newline, which would otherwise be baked into the path.
- `-Command` is required rather than `-File`, because the script path is computed at runtime. `-File` takes a literal path only.

**Teardown deliberately uses a different form.** It runs `-File` against `$env:PASEO_SOURCE_CHECKOUT_PATH` because by teardown the worktree may already be gone, so `git rev-parse` in the current directory cannot be trusted. Paseo supplies the source checkout directly, so no computation is needed.

The seven scripts:

| Script | Runs | Purpose |
|---|---|---|
| `gortex-status` | `Manage-GortexWorktree.ps1 -Action Status` | Reports `Untracked` / `PendingOrIndexing` / `Stale` / `Ready`, plus branch, HEAD, indexed commit, and expected exclusions |
| `gortex-wait` | `Manage-GortexWorktree.ps1 -Action Wait` | Blocks until `indexed=true`, with the same 10-second heartbeat as setup |
| `gortex-compact` | `Manage-GortexWorktree.ps1 -Action Compact` | Store maintenance (section 9). Takes no `-WorktreePath` — it is global |
| `gortex-repair-policy` | `Manage-GortexWorktree.ps1 -Action Setup` | Re-asserts durable global policy on an already-tracked worktree |
| `gortex-sync-skills` | `Sync-AgentSkills.ps1 -Prune` | Re-mirrors the skill set |
| `gortex-repair` | `Repair-GortexAgentKit.ps1` | Repairs the whole integration: daemon, tracking, index, hooks, MCP, instructions, skills |
| `gortex-check` | `Repair-GortexAgentKit.ps1 -CheckOnly` | The same diagnosis with no changes; exits non-zero when anything is wrong |

**There are three overlapping repairs, and picking the wrong one wastes time.**

`gortex-repair-policy` is the same command as `worktree.setup`, which is the point: `Setup` is idempotent, so when a worktree ends up tracked but with an incomplete global entry — a missing workspace, project, or exclusion — you re-run it to repair the policy in place. Untracking and re-adding would instead trigger a full reindex, which on a large repo costs 15–20 minutes. Its scope is **one worktree's entry in the global config**.

`gortex-repair` is the machine-wide one (section 12). It assumes nothing about the daemon being up or the repo being tracked, and it is the only one that notices the failures the installer cannot see — a dead daemon, an untracked repo, or an instructions file left describing a profile you have since switched away from. Reach for `gortex-check` first: it names the problem without changing anything.

`gortex-update-agents` is the narrow one: it only propagates the binary's instructions and skills to the agents that hold an inlined copy (section 11). Use it directly after a `gortex upgrade` or an `instructions switch`. You rarely need to — `gortex-repair` detects stale blocks and calls this script itself — but it is the right tool when nothing else is suspect and you want to skip a full diagnosis.

To use this layout, copy `transitional\Manage-GortexWorktree.ps1`, `Sync-AgentSkills.ps1`, `Install-GortexAgentKit.ps1`, `Update-GortexAgents.ps1`, and `Repair-GortexAgentKit.ps1` into `local\Paseo\` in the main checkout. `Repair-GortexAgentKit.ps1` shells out to both of the others, so they must travel together or the repair reports `installer not found` and stops. Keeping them under a gitignored `local\` means the kit never appears in `git status` or a diff, at the cost of being invisible to `git grep` and absent from fresh clones.

The `metadataGeneration` block is unrelated to Gortex. It is included because it is part of the real file, and because its `humanizer` reference is a reminder that these instructions can assume skills the kit has already mirrored — the mirror in section 8 is what puts `humanizer` within reach of Copilot CLI and Codex, not just Claude Code.

---

## 11. Upgrading Gortex

Gortex moves fast and `gortex install` can overwrite hook wiring. Run this drill after every upgrade.

```powershell
# 1. Record the current state
gortex version
(Get-ChildItem "$HOME\.claude\skills" -Directory -Filter 'gortex-*').Name | Set-Content "$env:TEMP\skills-before.txt"

# 2. Upgrade — gortex updates itself using the method it was installed with
gortex upgrade
gortex version

# 3. Propagate what the new binary brought: instruction text and skills
C:\huginn\Update-GortexAgents.ps1

# 4. Re-assert kit wiring. -Force re-seeds the Codex hook table (section 4).
C:\huginn\Install-GortexAgentKit.ps1 -Force

# 5. Diff the skill set — new skills appear here first
(Get-ChildItem "$HOME\.claude\skills" -Directory -Filter 'gortex-*').Name | Set-Content "$env:TEMP\skills-after.txt"
Compare-Object (Get-Content "$env:TEMP\skills-before.txt") (Get-Content "$env:TEMP\skills-after.txt")

# 6. Check for new hook events or postures
gortex hook --help
gortex install --print-config codex

# 7. Confirm the whole integration survived the upgrade
pwsh -File C:\huginn\Repair-GortexAgentKit.ps1 -RepoPath . -CheckOnly

# 8. Re-verify (section 6), then restart every agent
```

### Why step 3 exists

Gortex carries its instruction text and its skills **inside the binary**. Only Claude Code consumes them live — `~\.claude\CLAUDE.md` is a 386-byte stub that `@`-includes `~\.gortex\instructions\active.md`, so a profile switch or an upgrade reaches it immediately.

Every other agent holds an inlined **copy**, frozen when it was written. Nothing re-synchronises them, so after an upgrade Claude looks correct while Codex, Copilot, and OpenCode quietly serve the old text. `Update-GortexAgents.ps1` closes that gap:

```
gortex upgrade --run          the only step that uses the network
   ↓
gortex instructions regen     rewrites core/localization/full.md from the binary
   ↓
instructions switch <p>       copies the chosen profile to active.md
   ↓
Claude       @-includes active.md          follows automatically
Codex/Copilot/OpenCode                     inlined copies — this script
```

"Latest" therefore means *the installed binary*, not the network. Pass `-Upgrade` to fetch a newer Gortex first, and `-Profile <name>` to switch profiles machine-wide instead of only for Claude:

```powershell
C:\huginn\Update-GortexAgents.ps1 -WhatIf              # show what would change
C:\huginn\Update-GortexAgents.ps1 -Upgrade             # fetch, then propagate
C:\huginn\Update-GortexAgents.ps1 -Profile localization
```

It rewrites only the span between the `gortex:rules` markers, so YAML frontmatter and your own house rules are preserved byte for byte, and it backs up any file it changes. A file with no block is **skipped, never appended to** — adding one would hand an agent a second copy of the rules when another file in the same tree already carries it.

For skills, the mirror uses junctions, so edits to an existing skill already propagate. What does not is a skill *added* or *removed* by an upgrade: a new one has no junction and a removed one leaves a dangling link. Step 3 re-runs the source install and then re-mirrors with `-Prune`, reporting the delta:

```
[update] Skills in source: 22 (added 1, removed 0)
  added:   gortex-new-skill
```

It uses `--no-hooks --no-claude-md`, because a plain `gortex install` re-adds its own `[[hooks.*]]` blocks on every run — that is how duplicate `PreToolUse` entries accumulate in `~\.codex\config.toml`.

What to watch for:

- **New hook events.** If `gortex install --print-config` shows an event the kit does not wire, decide whether the gate belongs there. The gate belongs on prompt submission, not on tool calls.
- **New skills.** They land in `~\.claude\skills` and the junction mirror picks them up on the next `Sync-AgentSkills.ps1 -Prune`.
- **A restarted daemon.** `gortex upgrade` bounces it, and an upgrade that changes the store format can leave the index rebuilding. Step 6 catches both; without it the first symptom is an agent that silently answers nothing.
- **A rewritten instruction profile.** An upgrade can ship new profile text, which makes every inlined copy stale exactly as a manual `instructions switch` does (section 12). Step 3 fixes it, and step 7 confirms it.
- **Native worktree support.** When it ships, drop the transitional tier entirely.
- **Store growth.** A major index-format change can rebuild everything; check `StoreHealth` afterwards.

---

## 12. Troubleshooting

**Start here.** `Repair-GortexAgentKit.ps1` diagnoses and fixes most of what follows, in dependency order — binary, daemon, store, tracking, index, then kit wiring — and stops at the first thing it cannot recover so one real failure does not produce a screenful of misleading ones:

```powershell
pwsh -File C:\huginn\Repair-GortexAgentKit.ps1 -RepoPath . -CheckOnly   # diagnose only
pwsh -File C:\huginn\Repair-GortexAgentKit.ps1 -RepoPath .              # diagnose and fix
```

It exits 0 when healthy or fully repaired and 1 when anything is unresolved, so `-CheckOnly` works as a health probe in a script or a scheduled task. It never compacts the store: compaction takes an exclusive lock for minutes, so it is reported and left to you (section 9).

The repair delegates all wiring changes rather than reimplementing them, routing each finding to the script that owns it: `Install-GortexAgentKit.ps1` for anything it creates or wires, and `Update-GortexAgents.ps1` for a stale rule block. That split is not cosmetic — the installer writes only Copilot's instructions file, so a stale block in `~\.codex\AGENTS.md` is beyond its reach and running it alone would report the same drift forever. Two copies of "what wired means" would also drift apart, and both scripts are already idempotent. Add `-Force` to re-assert every managed file even when it already matches.

The entries below are what to do when the repair reports something it cannot fix itself.

**Agent ignores the graph and greps instead.**
Skills or hooks were not loaded. Restart the agent — both load at session start. Then check `(Get-ChildItem "$HOME\.agents\skills" -Directory -Filter 'gortex-*').Count`.

**The gate blocks with "daemon is not running".**
`gortex daemon start --detach`. If `daemon status` times out at 30 s while the process pins a CPU core, it is wedged, not busy — `start` alone reports "already running", so bounce it:
```powershell
gortex daemon stop
gortex daemon start --detach
```

**Codex says a hook is untrusted.**
Expected after any hook edit. Approve it once.

**`0 skill(s) mirrored`, or Copilot and Codex see no `gortex-*` skills.**
The mirror reads `~\.claude\skills`, which only Gortex's `claude-code` adapter writes. Seed it, then mirror — Claude Code itself is not required:
```powershell
gortex install --agents claude-code --no-hooks --no-claude-md --yes
C:\huginn\Sync-AgentSkills.ps1 -Prune
```
Then restart the agents. If seeding writes nothing, `gortex` is not on PATH — open a new shell after installing it.

**Setup looks frozen with no output.**
`gortex daemon reload` scales with store size and has been observed taking 32 s to 4.5 minutes. The helper heartbeats through it. **Trust `~\.gortex\logs\worktree-*.log`, never the terminal pane** — panes go stale independently.

**The gate always reports `State: Untracked` and never waits.**
The repository was never registered. `gortex track .` in the repo root, then confirm with `gortex repos` (section 5). A fresh Gortex install tracks nothing, and the gate deliberately allows an untracked cwd rather than blocking work outside a checkout.

**Status shows `IndexState=PendingOrIndexing` forever.**
Check that the repo has exclusions. Without them, generated code can dominate the index. Run the analyzer and reload.

**Status shows a blank `Repo`.**
The config entry has no `name:` key, which happens when a path was tracked directly. Harmless — the daemon derives the name from the directory.

**Everything is slow and `StoreSize` far exceeds `StoreLive`.**
Compact the store (section 9).

**Hook edits appear to do nothing.**
Confirm you edited `~\.gortex\agent-hooks\*`, not the kit folder. The installer copies files; the kit is the source, the deployed copy is what runs. Re-run the installer after editing the kit.

**Copilot still follows the old rules after `gortex instructions switch`.**
Expected, and nothing warns you about it. Only **Claude** tracks a switch for free: `~\.claude\CLAUDE.md` is a ~400-byte stub that `@`-imports `~\.gortex\instructions\active.md`, so it re-reads the profile every session.

Every other agent gets an **inlined copy** of the body, frozen when it was written — `~\.codex\AGENTS.md` and `~\.config\opencode\AGENTS.md` from Gortex itself, and the Copilot instructions file from the kit. An inlined copy follows nothing. Run:

```powershell
C:\huginn\Update-GortexAgents.ps1        # or -Profile <name> to switch and propagate in one step
```

or re-run the installer, or:

```powershell
pwsh -File C:\huginn\Repair-GortexAgentKit.ps1 -RepoPath .
# expect: kit wiring  Repaired  managed configuration re-applied
```

`-CheckOnly` reports this as `instructions stale: <file>`, naming each file whose block no longer matches. It compares every marker-carrying file against the **exact** expected block — not merely whether the profile body appears somewhere in it — so it also catches a block whose body is current but whose surrounding form is obsolete. An earlier build tested only for the body, which let a file carrying the old comment-prefixed block report healthy while `gortex install` still saw it as drift. This is the only detector for a failure where everything appears to work and the model is simply told the wrong thing. Restart the agent afterwards — instructions load at session start.

**Gortex and the kit keep rewriting the same rule block.**
Three writers own that block — `gortex install`, `Install-GortexAgentKit.ps1`, and `Update-GortexAgents.ps1` — and Gortex writes the Codex and OpenCode files itself. So the block text must be **byte-identical** across all three or each sees the others' output as drift and rewrites it forever, stranding a `.bak` on every run.

The canonical form is exactly what Gortex emits: start marker, newline, profile body, blank line, end marker. Nothing else — an earlier kit build added a two-line `<!-- Managed by … -->` comment, which was enough to make `gortex install --dry-run` report `would-merge` against a file whose rules were already current. Confirm agreement from both sides:

```powershell
gortex install --agents codex --no-hooks --dry-run --json   # expect: AGENTS.md  skip  unchanged
C:\huginn\Update-GortexAgents.ps1 -SkipSkills               # expect: codex/AGENTS.md  current
```

**`copilot-instructions.md` is full of `â€"` and the repair keeps reporting it stale.**
An older build wrote it with `Set-Content`. Under Windows PowerShell 5.1 `Get-Content` decodes a BOM-less file as ANSI, so the em dashes in the Gortex profile were read as mojibake and written straight back out, and the comparison against the real profile then never matched. Both scripts now read and write UTF-8 without a BOM through .NET, which is also what makes them byte-identical under 5.1 and pwsh 7. Delete the file and re-run the installer to regenerate it.

---

## 13. File map

```
C:\huginn\
├─ RUNBOOK.md                        this file
├─ README.md                         short overview; points here
├─ .gitignore
├─ Install-GortexAgentKit.ps1        detects agents, wires hooks, mirrors skills
├─ Update-GortexAgents.ps1           propagates the binary's instructions + skills after an upgrade
├─ Repair-GortexAgentKit.ps1        diagnoses + fixes daemon, tracking, index, wiring
├─ Analyze-RepoExclusions.ps1        derives per-repo exclusions
├─ Sync-AgentSkills.ps1              mirrors Gortex skills to Copilot CLI + Codex
├─ hooks\
│  ├─ gortex-readiness.ps1           THE GATE — single source of truth
│  ├─ claude-hook.ps1 / .cmd         Claude adapter (.cmd shim: Claude runs hooks via sh)
│  ├─ codex-hook.ps1                 Codex adapter
│  └─ copilot-hook.ps1               Copilot CLI adapter
├─ plugin\
│  └─ gortex-context.js              OpenCode plugin
├─ tests\
│  └─ opencode-plugin.test.mjs       exercises the plugin's gate + enrichment flow
└─ transitional\
   └─ Manage-GortexWorktree.ps1      worktree lifecycle + store compaction
```

Deployed to `~\.gortex\agent-hooks\` at install time. Per-agent wiring lives in `~\.claude\settings.json`, `~\.copilot\hooks\gortex.json`, `~\.codex\config.toml`, and `~\.config\opencode\plugin\`.

MCP and instructions are separate from the hook wiring:

| File | Contents | Read by |
|---|---|---|
| `~\.copilot\mcp-config.json` | `mcpServers.gortex` | Copilot CLI **and** the VS Code agent host |
| `%APPDATA%\Code\User\mcp.json` | `servers.gortex` | the native Copilot Chat panel |
| `~\.copilot\copilot-instructions.md`<br>or `~\.copilot\instructions\*.md` | delimited `gortex:rules` block | all three Copilot surfaces — **both paths load, see section 14** |

Only the `gortex` entry and the delimited block are kit-owned; every other server, the VS Code `inputs` array, and any instructions you write around the block are preserved untouched.

**One instructions file genuinely covers all three surfaces**, which is worth stating precisely because it looks too convenient to be true:

- The **CLI** resolves `<configDir>\copilot-instructions.md`, where `configDir` is `$env:COPILOT_HOME` or `~\.copilot`. It surfaces as `Home copilot-instructions.md`.
- The **VS Code agent host** execs that same binary with an unmodified environment, so it inherits the same path.
- The **native Chat panel** is a separate runtime that never runs the CLI, but it searches the same location independently: its prompt loader calls `findFilesInRoots([userHome], ".copilot", [{ fileName: "copilot-instructions.md" }])` alongside the workspace `.github` lookup. Verified in VS Code 1.133.

The panel honours the file only while `github.copilot.chat.codeGeneration.useInstructionFiles` is `true`. That is the default and the kit does not touch it — `settings.json` is a file users edit by hand, and owning it to force a default would cause more problems than it solves. If the panel ignores the rules, check that setting first.

Gortex writes the Claude and Codex equivalents itself, but not in the same form. `~\.claude\CLAUDE.md` is a stub that `@`-imports `~\.gortex\instructions\active.md`; `~\.codex\AGENTS.md` and `~\.config\opencode\AGENTS.md` get the profile body **inlined**, because neither runtime resolves `@`-imports. Copilot has no import syntax either, so the kit inlines the body there too. Claude is therefore the only agent that follows a profile switch on its own — everything else needs `Update-GortexAgents.ps1` or a re-run of the installer. See section 12.

---

## 14. Platform notes

- **Windows only.** Every script is PowerShell. The gate would port to bash, but the adapters would need rewriting.
- **Claude Code runs hooks through POSIX `sh` on Windows**, not `cmd`. That is why its hook command is shell script invoking `claude-hook.cmd`, which `sh` can exec directly.
- **Copilot loads two instruction files at once.** `~\.copilot\copilot-instructions.md` **and** `~\.copilot\instructions\*.md` are both read in the same session — verified by planting a sentinel token in one and having a fresh `copilot -p` session echo it back alongside a value only the other file carries. Writing the canonical file blind would therefore hand the model the same rule block twice on any machine that already keeps one under `instructions\`, and the two copies would drift apart at the next profile switch. The installer reuses whichever file already owns the block; `Update-GortexAgents.ps1` refreshes every file that carries it.
- **Gortex's agent name is `claude-code`**; its hook wire-protocol flag is `--agent=claude`. Two different namespaces.
- **Copilot CLI has no Gortex adapter in any released build**, so `~\.copilot\hooks\gortex.json` is entirely kit-owned, and its MCP server and rule block are kit-written too. On v0.63.3 `gortex install` has no `copilot` target — passing one, in any spelling (`copilot`, `copilot-cli`, `copilotcli`), is an error. **This is changing.** `internal/agents/copilotcli/` (adapter, hooks, skills, subagents) landed upstream on 2026-08-15, three days after the v0.63.3 release, and `gortex hook` on `main` now accepts `--agent=copilot-cli`. None of it is in a tagged release yet. When it ships, the kit's Copilot wiring becomes a duplicate rather than the only implementation, and this section needs re-testing before upgrading — check `gortex install --print-config copilot-cli` first.
- **An unknown `--agent` value fails silently.** `gortex hook --agent=<anything-unrecognised>` exits **0** and writes **nothing** — byte-identical to a posture that decided not to act. Verified by control: on v0.63.3, `--agent=bogus-agent-xyz`, `--agent=opencode`, and `--agent=copilot-cli` all return 0 bytes, while `--agent=claude` returns a 731-byte deny. So pointing an adapter at a protocol newer than the installed binary disables enforcement invisibly — no error, no log line, exactly like a model choosing to ignore advice. Confirm a protocol responds before trusting it, and never assume a name is supported because the flag was accepted.
- **The kit's OpenCode plugin is about to collide with a native one.** On v0.63.3 `gortex install --agents opencode` writes **only** MCP config (`opencode.json`, key `mcp`) and no plugin, so `~\.config\opencode\plugin\gortex-context.js` is unambiguously kit-owned. Upstream added `internal/agents/opencode/plugin.go` on 2026-08-15, which installs its own `gortex.js` into **the same directory** — and OpenCode loads every plugin in that folder, so once it ships both will run and each will probe the daemon per event. Its posture default matches the kit's: `normalizeHookMode` maps `enrich`, `consult-unlock` and `nudge` literally and everything else — including an empty value — to **`deny`**. Before upgrading past v0.63.3, check `gortex install --print-config opencode` for a `plugin` path and drop the kit's copy if one appears.
- **Codex is the only agent that does not default to deny.** `ParseCodexMode` maps `deny`/`hard-deny`, `rewrite`/`input-rewrite`, and `suppress`/`replace-output`/`output-suppression`, and falls through to `CodexModeEnrich` for everything else, including empty. Claude, OpenCode, and the kit's Copilot shim all default to `deny`. That asymmetry is why the installer writes `--mode=deny` explicitly for Codex instead of relying on the default — an omitted flag means `deny` everywhere else and `enrich` here.
- **Copilot only runs a hook whose event value is a JSON array.** `"UserPromptSubmit": [ { ... } ]` runs; `"UserPromptSubmit": { ... }` is parsed without complaint and then never executed — no error, no log line, and `copilot mcp`/`--log-level all` show nothing. The failure looks exactly like an agent that ignores its instructions. PowerShell makes this easy to write by accident: a function that does `return @($one)` unrolls the single-element array back to a scalar, and `ConvertTo-Json` then emits the dead bare-object form. `New-CopilotHook` returns `, @(...)` for precisely this reason. Verify shape, not just presence — see the check in section 6.
- **Copilot honours a `PreToolUse` denial.** `hookSpecificOutput.permissionDecision = "deny"` stops the call and the transcript reads `Denied by preToolUse hook`. It reads the *nested* Claude-shaped field because entries registered under the PascalCase event names are tagged `_vsCodeCompat` at config load, so a Gortex reply needs no translation — see section 7. Do not flatten a denial into `additionalContext`; that turns a block into a suggestion.
- **Copilot in VS Code shells out to the CLI.** Its bootstrapper lives at `%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.ps1`; it resolves the real `copilot` binary on PATH, version-checks it, and execs it with an unmodified environment. Hooks, skills, and instructions therefore need no second wiring — **only MCP does**, because the Chat panel reads `%APPDATA%\Code\User\mcp.json` instead.
- **Gortex's `vscode` adapter writes the wrong scope for this purpose.** `gortex install --agents vscode` writes a **repo-local** `.vscode\mcp.json`, which covers only the folder that was open when it ran. The kit writes the user profile so every workspace is covered. It still installs no hooks and no skills, and has no effect on the agent host.
- **`deferTools` is not a Copilot CLI setting.** It appears in neither the JS bundle nor the native binary, so it is accepted into the JSON and silently ignored. The kit does not write it, and preserves it if you already have it.
- **The Copilot CLI does not resolve `@`-file imports in instructions.** A Claude-style `@C:\...\active.md` pointer is passed through as literal text, which is why the kit inlines the profile body instead.
- `$HOME` is fixed at PowerShell session start and **cannot** be redirected by setting `$env:USERPROFILE` in a child process. Do not attempt to sandbox-test the installer that way; it will write to the real config tree.
