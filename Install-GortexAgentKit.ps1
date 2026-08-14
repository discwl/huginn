<#
.SYNOPSIS
    Installs the Gortex agent kit: the shared index-readiness gate, per-agent
    hook adapters, the OpenCode plugin, and the skill mirror.

.DESCRIPTION
    Gortex wires MCP and its own hooks into supported agents, but nothing in
    that wiring knows whether the current repository has finished indexing. A
    repository registers with the daemon in seconds while its first index takes
    far longer, so an agent starts against a graph that answers every query with
    nothing and quietly falls back to raw file reads. Gortex also installs
    skills for Claude Code only, leaving Copilot CLI and Codex without them.

    This installer closes both gaps for every agent found on the machine.

    Hook runtime files are copied into ~/.gortex/agent-hooks rather than being
    referenced in place, so a moved or deleted kit folder cannot break a working
    agent, and every wired command points at one stable location.

    The gate waits rather than blocks while an index is in flight. A blocked
    first prompt is discarded by every agent host here and nothing re-sends it,
    so blocking would lose the user's actual instruction. Waiting is why the
    UserPromptSubmit timeout is measured in minutes while every other event
    stays short.

.PARAMETER Agents
    Which agents to wire. 'auto' wires every agent detected on the machine.

.PARAMETER HookMode
    Gortex hook posture forwarded to enrichment. 'enrich' never denies a tool
    call; it appends graph context after the tool runs.

.PARAMETER GateTimeoutSec
    Timeout for the gated UserPromptSubmit hook. This must exceed the longest
    expected first index, because the gate spends that time waiting.

.EXAMPLE
    .\Install-GortexAgentKit.ps1 -WhatIf
    Shows every change without writing anything.

.EXAMPLE
    .\Install-GortexAgentKit.ps1 -Agents claude-code,codex
    Wires only the named agents.

.NOTES
    Codex stores a trusted_hash per hook. Changing its command is a deliberate
    edit, so Codex asks to re-approve the hook once on next launch.

    Agents load hooks and skills at session start, so restart them afterwards.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $KitRoot = $PSScriptRoot,

    [ValidateSet('auto', 'claude-code', 'copilot', 'codex', 'opencode')]
    [string[]] $Agents = @('auto'),

    [ValidateSet('enrich', 'deny', 'consult-unlock', 'nudge')]
    [string] $HookMode = 'enrich',

    [ValidateRange(60, 21600)]
    [int] $GateTimeoutSec = 1860,

    [int] $QuickTimeoutSec = 15,

    [switch] $SkipSkills,

    # Config tree to write into. $HOME is fixed at PowerShell session start and
    # cannot be redirected with $env:USERPROFILE, so an explicit root is the
    # only way to target another profile or a test sandbox.
    [string] $ConfigRoot = $HOME,

    # Re-running `gortex install` is not always wanted, and skipping it allows
    # the wiring logic to be exercised against a sandboxed config tree.
    [switch] $SkipGortexInstall,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Results = [ordered]@{}

function Write-Step {
    param([string] $Message)
    Write-Host "[kit] $Message"
}

function Write-Detail {
    param([string] $Message)
    Write-Host "      $Message" -ForegroundColor DarkGray
}

function Set-Result {
    param([string] $Agent, [string] $State, [string] $Detail = '')
    $script:Results[$Agent] = [pscustomobject]@{
        Agent  = $Agent
        Status = $State
        Detail = $Detail
    }
}

function Backup-File {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }

    $backup = "$Path.bak-$stamp"
    if ($PSCmdlet.ShouldProcess($backup, 'Create backup')) {
        Copy-Item -LiteralPath $Path -Destination $backup -Force
        Write-Detail "backed up -> $(Split-Path -Leaf $backup)"
    }
}

# Writing only on change keeps the installer idempotent and avoids churning a
# backup file on every run.
function Set-ManagedContent {
    param(
        [string] $Path,
        [string] $Content,
        [switch] $NoBackup
    )

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
        if ($null -ne $existing -and $existing.TrimEnd() -eq $Content.TrimEnd() -and -not $Force) {
            return $false
        }
        if (-not $NoBackup) { Backup-File $Path }
    }

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        if ($PSCmdlet.ShouldProcess($parent, 'Create directory')) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
    }

    if ($PSCmdlet.ShouldProcess($Path, 'Write file')) {
        Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 -NoNewline:$false
    }

    return $true
}

function ConvertTo-PosixPath {
    param([string] $Path)
    return ($Path -replace '\\', '/')
}

function Resolve-Executable {
    param([string] $Name)

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# --- locate the pieces -------------------------------------------------------

$hookSource = Join-Path $KitRoot 'hooks'
$pluginSource = Join-Path $KitRoot 'plugin'
$skillSync = Join-Path $KitRoot 'Sync-AgentSkills.ps1'

$requiredHooks = @(
    'gortex-readiness.ps1',
    'copilot-hook.ps1',
    'codex-hook.ps1',
    'claude-hook.ps1',
    'claude-hook.cmd'
)

foreach ($file in $requiredHooks) {
    $candidate = Join-Path $hookSource $file
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Kit is incomplete: missing $candidate"
    }
}

$hookTarget = Join-Path $ConfigRoot '.gortex\agent-hooks'
$gortexExe = Resolve-Executable 'gortex'

Write-Step "Kit root: $KitRoot"
Write-Step "Hook runtime: $hookTarget"
if ($gortexExe) {
    Write-Detail "gortex: $gortexExe"
}
else {
    Write-Warning 'gortex was not found on PATH. Hooks will install, but the daemon must exist before they do anything useful.'
}

# --- detect agents -----------------------------------------------------------

$detected = [ordered]@{
    'claude-code' = (Test-Path -LiteralPath (Join-Path $ConfigRoot '.claude') -PathType Container) -or [bool](Resolve-Executable 'claude')
    'copilot'     = (Test-Path -LiteralPath (Join-Path $ConfigRoot '.copilot') -PathType Container) -or [bool](Resolve-Executable 'copilot')
    'codex'       = (Test-Path -LiteralPath (Join-Path $ConfigRoot '.codex') -PathType Container) -or [bool](Resolve-Executable 'codex')
    'opencode'    = (Test-Path -LiteralPath (Join-Path $ConfigRoot '.config\opencode') -PathType Container) -or [bool](Resolve-Executable 'opencode')
}

if ($Agents -contains 'auto') {
    $selected = @($detected.Keys | Where-Object { $detected[$_] })
}
else {
    $selected = @($Agents | Where-Object { $_ -ne 'auto' })
}

Write-Step ("Detected: " + (($detected.Keys | Where-Object { $detected[$_] }) -join ', '))
Write-Step ("Wiring:   " + ($selected -join ', '))

foreach ($agent in $selected) {
    if (-not $detected[$agent]) {
        Write-Warning "$agent was requested but not detected; wiring it anyway."
    }
}

# --- deploy the shared hook runtime -----------------------------------------

Write-Step 'Deploying hook runtime.'
$deployed = 0
foreach ($file in $requiredHooks) {
    $content = Get-Content -LiteralPath (Join-Path $hookSource $file) -Raw
    if (Set-ManagedContent -Path (Join-Path $hookTarget $file) -Content $content) {
        $deployed++
        Write-Detail "updated $file"
    }
}
Write-Detail "$deployed of $($requiredHooks.Count) file(s) changed"

$readinessPath = Join-Path $hookTarget 'gortex-readiness.ps1'
$copilotHook = Join-Path $hookTarget 'copilot-hook.ps1'
$codexHook = Join-Path $hookTarget 'codex-hook.ps1'
$claudeCmd = Join-Path $hookTarget 'claude-hook.cmd'

# --- Copilot CLI -------------------------------------------------------------

if ($selected -contains 'copilot') {
    Write-Step 'Wiring Copilot CLI.'

    # Copilot has no Gortex adapter of its own, so the whole hook file is ours.
    # Windows PowerShell is used because it is guaranteed present; the hook it
    # launches is version-agnostic.
    $winPs = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $inner = "if (Test-Path -LiteralPath '$copilotHook' -PathType Leaf) { & '$copilotHook'; exit `$LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $command = "$(ConvertTo-PosixPath $winPs) -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"

    function New-CopilotHook {
        param([int] $TimeoutSec)
        return @([ordered]@{
                timeoutSec = $TimeoutSec
                powershell = $command
                type       = 'command'
            })
    }

    $payload = [ordered]@{
        version = 1
        hooks   = [ordered]@{
            SessionStart     = New-CopilotHook $QuickTimeoutSec
            UserPromptSubmit = New-CopilotHook $GateTimeoutSec
            PreToolUse       = New-CopilotHook $QuickTimeoutSec
            PostToolUse      = New-CopilotHook $QuickTimeoutSec
        }
    }

    $json = $payload | ConvertTo-Json -Depth 10
    $path = Join-Path $ConfigRoot '.copilot\hooks\gortex.json'
    if (Set-ManagedContent -Path $path -Content $json) {
        Set-Result 'copilot' 'wired' "gate timeout ${GateTimeoutSec}s"
        Write-Detail "wrote $path"
    }
    else {
        Set-Result 'copilot' 'already current' ''
        Write-Detail 'already current'
    }
}

# --- Codex -------------------------------------------------------------------

if ($selected -contains 'codex') {
    Write-Step 'Wiring Codex.'

    $codexConfig = Join-Path $ConfigRoot '.codex\config.toml'

    # Gortex owns the shape of the [hooks] table, so it writes the block first
    # and only the gated event is re-pointed afterwards. Hand-authoring the
    # whole table would drift from whatever the current Gortex release expects.
    if ($gortexExe -and -not $SkipGortexInstall -and $PSCmdlet.ShouldProcess('codex', "gortex install --hook-mode $HookMode")) {
        & $gortexExe install --agents codex --hook-mode $HookMode --yes 2>&1 | Out-Null
    }

    if (-not (Test-Path -LiteralPath $codexConfig -PathType Leaf)) {
        # A Codex install that has never been run has no config.toml. A file
        # containing only a [hooks] table is valid, and Codex merges its own
        # defaults around it, so the gate is wired rather than skipped.
        Write-Detail 'config.toml not found; creating one with only the hooks table'
        $toml = ''
    }
    else {
        $toml = Get-Content -LiteralPath $codexConfig -Raw
    }

    $gateCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(ConvertTo-PosixPath $codexHook)"

    $block = @(
        '',
        '[[hooks.UserPromptSubmit]]',
        '[[hooks.UserPromptSubmit.hooks]]',
        "command = '$gateCommand'",
        "statusMessage = 'Checking Gortex index readiness and surfacing graph context...'",
        "timeout = $GateTimeoutSec",
        "type = 'command'"
    ) -join [Environment]::NewLine

    if ($toml -match '(?m)^\[\[hooks\.UserPromptSubmit\]\]') {
        # Replace only the existing gated block, leaving every other hook,
        # the trust state table, and unrelated settings untouched.
        $pattern = '(?ms)^\[\[hooks\.UserPromptSubmit\]\].*?(?=^\[(?!\[hooks\.UserPromptSubmit)|\Z)'
        $updated = [regex]::Replace($toml, $pattern, ($block.TrimStart() + [Environment]::NewLine + [Environment]::NewLine), 1)
    }
    elseif ($toml -match '(?m)^\[hooks\.state\]') {
        $updated = $toml -replace '(?m)^\[hooks\.state\]', ($block.TrimStart() + [Environment]::NewLine + [Environment]::NewLine + '[hooks.state]')
    }
    else {
        $updated = $toml.TrimEnd() + [Environment]::NewLine + $block + [Environment]::NewLine
    }

    if (Set-ManagedContent -Path $codexConfig -Content $updated) {
        Set-Result 'codex' 'wired' 're-approve the hook on next launch'
        Write-Detail 'UserPromptSubmit now runs the readiness gate'
        Write-Detail 'Codex will ask to re-approve this hook once (its trusted_hash changed).'
    }
    else {
        Set-Result 'codex' 'already current' ''
        Write-Detail 'already current'
    }
}

# --- Claude Code -------------------------------------------------------------

if ($selected -contains 'claude-code') {
    Write-Step 'Wiring Claude Code.'

    if ($gortexExe -and -not $SkipGortexInstall -and $PSCmdlet.ShouldProcess('claude-code', "gortex install --hook-mode $HookMode")) {
        & $gortexExe install --agents claude-code --hook-mode $HookMode --yes 2>&1 | Out-Null
    }

    $settingsPath = Join-Path $ConfigRoot '.claude\settings.json'
    $settings = $null
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    }
    if ($null -eq $settings) {
        $settings = [pscustomobject]@{}
    }

    if ($null -eq $settings.PSObject.Properties['hooks']) {
        $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
    }

    # Claude Code runs hook commands through POSIX sh on Windows, so the command
    # is shell script, not a Windows command line. The else-branch drains stdin
    # so a missing hook file cannot hang the turn.
    $posixCmd = ConvertTo-PosixPath $claudeCmd
    $command = "if [ -f '$posixCmd' ]; then '$posixCmd'; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"

    $entry = [pscustomobject]@{
        matcher = ''
        hooks   = @([pscustomobject]@{
                type    = 'command'
                command = $command
                timeout = $GateTimeoutSec
            })
    }

    $existing = @()
    if ($null -ne $settings.hooks.PSObject.Properties['UserPromptSubmit']) {
        $existing = @($settings.hooks.UserPromptSubmit)
    }

    # Other tools register their own UserPromptSubmit hooks here, and Orca's is
    # also named claude-hook.cmd, so the full path is matched rather than the
    # file name. Matching loosely would silently delete another tool's hook.
    $kept = @($existing | Where-Object {
            $text = ($_ | ConvertTo-Json -Depth 10 -Compress)
            $text -notlike "*$posixCmd*"
        })

    $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue (@($entry) + $kept) -Force

    $json = $settings | ConvertTo-Json -Depth 100
    if (Set-ManagedContent -Path $settingsPath -Content $json) {
        Set-Result 'claude-code' 'wired' "gate timeout ${GateTimeoutSec}s"
        Write-Detail "wrote $settingsPath"
    }
    else {
        Set-Result 'claude-code' 'already current' ''
        Write-Detail 'already current'
    }
}

# --- OpenCode ----------------------------------------------------------------

if ($selected -contains 'opencode') {
    Write-Step 'Wiring OpenCode.'

    $pluginFile = Join-Path $pluginSource 'gortex-context.js'
    if (-not (Test-Path -LiteralPath $pluginFile -PathType Leaf)) {
        Set-Result 'opencode' 'skipped' 'plugin missing from kit'
        Write-Warning "Plugin not found: $pluginFile"
    }
    else {
        $target = Join-Path $ConfigRoot '.config\opencode\plugin\gortex-context.js'
        $content = Get-Content -LiteralPath $pluginFile -Raw
        if (Set-ManagedContent -Path $target -Content $content) {
            Set-Result 'opencode' 'wired' ''
            Write-Detail "wrote $target"
        }
        else {
            Set-Result 'opencode' 'already current' ''
            Write-Detail 'already current'
        }
    }
}

# --- skills ------------------------------------------------------------------

if (-not $SkipSkills) {
    Write-Step 'Mirroring Gortex skills to Copilot CLI and Codex.'

    if (-not (Test-Path -LiteralPath $skillSync -PathType Leaf)) {
        Write-Warning "Sync-AgentSkills.ps1 not found at $skillSync"
    }
    elseif ($PSCmdlet.ShouldProcess((Join-Path $ConfigRoot '.agents\skills'), 'Mirror gortex skills')) {
        # Skills are an enhancement, not a prerequisite. On a machine where
        # Gortex has not yet written them, this must warn rather than abort an
        # install whose hook wiring already succeeded.
        try {
            # ~/.agents/skills is read by both Copilot CLI and Codex, so one
            # mirror serves both without registering every skill twice.
            & $skillSync -Prune -SourceRoot (Join-Path $ConfigRoot '.claude\skills') -TargetRoot (Join-Path $ConfigRoot '.agents\skills') | Out-Null
            $count = @(Get-ChildItem (Join-Path $ConfigRoot '.agents\skills') -Directory -Filter 'gortex-*' -ErrorAction SilentlyContinue).Count
            Write-Detail "$count skill(s) mirrored"
        }
        catch {
            Write-Warning "Skill mirror skipped: $($_.Exception.Message)"
            Write-Detail 'Run gortex install, then re-run this installer to pick up skills.'
        }
    }
}

# --- report ------------------------------------------------------------------

Write-Host ''
Write-Host '=== Result ==='
$script:Results.Values | Format-Table -AutoSize | Out-String -Width 160 | Write-Host

Write-Host 'Next steps:'
Write-Host '  1. Restart every agent: hooks and skills are read at session start.'
Write-Host '  2. Codex asks to re-approve its readiness hook once.'
Write-Host '  3. Verify the gate:'
Write-Host "       pwsh -File `"$readinessPath`" -Cwd . -Json"
