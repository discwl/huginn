# Gortex Agent Kit — Setup Runbook

Portable setup for **Gortex** (code-graph daemon + MCP server) across **Claude Code, GitHub Copilot CLI, Copilot in VS Code, Codex, and OpenCode** on Windows.

Those five names are **four runtimes** — Copilot in VS Code execs the same `copilot` binary as the terminal CLI and shares its configuration, so wiring Copilot CLI covers both. See section 4.

This runbook is written to be executed by an agent. Hand it, plus the `C:\huginn` folder, to a coding agent on the target machine and say:

> Read `C:\huginn\RUNBOOK.md` and set up this machine. Run the verification section at the end and report the results.

It is equally usable by a human — every step is a real command.

---

## 1. What this kit adds

Gortex installs MCP servers and hooks on its own. This kit closes three gaps it leaves open:

| Gap | Consequence | Fixed by |
|---|---|---|
| Nothing checks whether the repo has finished indexing | Agents start against an empty graph and silently fall back to raw file reads | `hooks\gortex-readiness.ps1` + per-agent adapters |
| Skills install for Claude Code only | Copilot CLI and Codex get no Gortex skills | `Sync-AgentSkills.ps1` |
| Exclusions are hand-guessed per repo | Generated code dominates the index and slows it dramatically | `Analyze-RepoExclusions.ps1` |

The readiness gap is the important one. **Registration and indexing are separate states.** A repository is tracked within seconds; its first index can take 15–20 minutes on a large repo. In between, every graph query returns nothing and the agent has no way to tell that apart from "no results".

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

1. Detects Claude Code, Copilot CLI, Codex, and OpenCode.
2. Copies the hook runtime into `~\.gortex\agent-hooks`.
3. Wires each agent's `UserPromptSubmit` to the readiness gate.
4. Installs the OpenCode plugin.
5. Mirrors Gortex skills into `~\.agents\skills`, seeding them first if needed (see below).

Only detected agents are wired, so you do not need to name the ones this machine uses. Nothing is installed for an agent that is absent.

**Copilot in VS Code needs no separate wiring.** VS Code does not embed its own copy of the CLI. Its Copilot agent host ships a bootstrapper that locates `copilot` on PATH and execs it with the arguments unchanged, setting no config-dir, `HOME`, or `XDG_*` override. It therefore reads the same `~\.copilot\hooks\gortex.json` and the same `~\.agents\skills` as the terminal CLI, and is gated identically. Wiring Copilot CLI covers both surfaces.

Two consequences worth knowing:

- The host enforces a **minimum Copilot CLI version of 0.0.394** at launch. Below that it refuses to start, and the gate never runs because the CLI never runs.
- If `copilot` is not on PATH for the VS Code process, the host cannot start at all. A PATH change made after VS Code launched will not be visible to it — restart VS Code, not just the window.

> This covers the Copilot **agent host**. The native Copilot Chat panel is a separate runtime that exposes MCP and instructions but no hook API, so it cannot be gated and is out of scope for this kit.

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
(Get-Content "$HOME\.claude\settings.json" -Raw | ConvertFrom-Json).hooks.UserPromptSubmit |
  ForEach-Object { $_.hooks[0].command } | Select-String 'gortex'

# 5. OpenCode plugin control flow (requires node)
#    Use the deployed copy if OpenCode is wired, otherwise the kit's source.
$plugin = Join-Path $env:TEMP 'gortex-plugin-test.mjs'
$deployed = "$HOME\.config\opencode\plugin\gortex-context.js"
Copy-Item $(if (Test-Path $deployed) { $deployed } else { 'C:\huginn\plugin\gortex-context.js' }) $plugin -Force
node C:\huginn\tests\opencode-plugin.test.mjs ([Uri](Resolve-Path $plugin).Path).AbsoluteUri (Get-Location).Path
# expect: 8 passed, 0 failed
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

Use `--absolute-git-dir`, which is per-worktree. `--git-common-dir` is shared by every worktree, so a marker there would falsely release all of them. Delete it on teardown.

These commands receive `PASEO_WORKTREE_PATH`, `PASEO_BRANCH_NAME`, `PASEO_SOURCE_CHECKOUT_PATH`, `PASEO_WORKSPACE_ID`, and `PASEO_AGENT_CWD`.

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
    "gortex-repair": {
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

The five scripts:

| Script | Action | Purpose |
|---|---|---|
| `gortex-status` | `Status` | Reports `Untracked` / `PendingOrIndexing` / `Stale` / `Ready`, plus branch, HEAD, indexed commit, and expected exclusions |
| `gortex-repair` | `Setup` | Re-asserts durable global policy on an already-tracked worktree |
| `gortex-wait` | `Wait` | Blocks until `indexed=true`, with the same 10-second heartbeat as setup |
| `gortex-compact` | `Compact` | Store maintenance (section 9). Takes no `-WorktreePath` — it is global |
| `gortex-sync-skills` | — | Runs `Sync-AgentSkills.ps1 -Prune` |

`gortex-repair` is the same command as `worktree.setup`, which is the point: `Setup` is idempotent, so when a worktree ends up tracked but with an incomplete global entry — a missing workspace, project, or exclusion — you re-run it to repair the policy in place. Untracking and re-adding would instead trigger a full reindex, which on a large repo costs 15–20 minutes.

To use this layout, copy `transitional\Manage-GortexWorktree.ps1` and `Sync-AgentSkills.ps1` into `local\Paseo\` in the main checkout. Keeping them under a gitignored `local\` means the kit never appears in `git status` or a diff, at the cost of being invisible to `git grep` and absent from fresh clones.

The `metadataGeneration` block is unrelated to Gortex. It is included because it is part of the real file, and because its `humanizer` reference is a reminder that these instructions can assume skills the kit has already mirrored.

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

# 3. Re-assert kit wiring. -Force re-seeds the Codex hook table (section 4).
C:\huginn\Install-GortexAgentKit.ps1 -Force

# 4. Diff the skill set — new skills appear here first
(Get-ChildItem "$HOME\.claude\skills" -Directory -Filter 'gortex-*').Name | Set-Content "$env:TEMP\skills-after.txt"
Compare-Object (Get-Content "$env:TEMP\skills-before.txt") (Get-Content "$env:TEMP\skills-after.txt")

# 5. Check for new hook events or postures
gortex hook --help
gortex install --print-config codex

# 6. Re-verify (section 6), then restart every agent
```

What to watch for:

- **New hook events.** If `gortex install --print-config` shows an event the kit does not wire, decide whether the gate belongs there. The gate belongs on prompt submission, not on tool calls.
- **New skills.** They land in `~\.claude\skills` and the junction mirror picks them up on the next `Sync-AgentSkills.ps1 -Prune`.
- **Native worktree support.** When it ships, drop the transitional tier entirely.
- **Store growth.** A major index-format change can rebuild everything; check `StoreHealth` afterwards.

---

## 12. Troubleshooting

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

---

## 13. File map

```
C:\huginn\
├─ RUNBOOK.md                        this file
├─ README.md                         short overview; points here
├─ .gitignore
├─ Install-GortexAgentKit.ps1        detects agents, wires hooks, mirrors skills
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

---

## 14. Platform notes

- **Windows only.** Every script is PowerShell. The gate would port to bash, but the adapters would need rewriting.
- **Claude Code runs hooks through POSIX `sh` on Windows**, not `cmd`. That is why its hook command is shell script invoking `claude-hook.cmd`, which `sh` can exec directly.
- **Gortex's agent name is `claude-code`**; its hook wire-protocol flag is `--agent=claude`. Two different namespaces.
- **Copilot CLI has no Gortex adapter**, so `~\.copilot\hooks\gortex.json` is entirely kit-owned.
- **Copilot in VS Code shells out to the CLI.** Its bootstrapper lives at `%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.ps1`; it resolves the real `copilot` binary on PATH, version-checks it, and execs it with an unmodified environment. There is no second configuration tree to wire, and no VS Code entry in the installer's detection table by design.
- **Gortex's `vscode` adapter is unrelated to any of this.** `gortex install --agents vscode` writes a repo-local `.vscode\mcp.json` for the native Copilot Chat panel. It installs no hooks and no skills, and has no effect on the agent host.
- `$HOME` is fixed at PowerShell session start and **cannot** be redirected by setting `$env:USERPROFILE` in a child process. Do not attempt to sandbox-test the installer that way; it will write to the real config tree.
