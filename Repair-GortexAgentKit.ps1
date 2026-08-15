<#
.SYNOPSIS
    Diagnose and repair a broken Gortex Agent Kit integration.

.DESCRIPTION
    Install-GortexAgentKit.ps1 wires a healthy machine. This script fixes one
    that has drifted, and the two are deliberately not the same job:

      * the installer assumes the daemon, the tracked repo and the store are
        somebody else's problem, so on a machine where the daemon is dead it
        happily reports every agent "already current" while nothing works;
      * drift is mostly *external* to the kit -- `gortex upgrade` restarting the
        daemon, a repo that fell out of the tracked workspace, a store left
        wedged by a hard kill, or `gortex instructions switch` changing the
        rules body that the Copilot instructions file inlines.

    So the checks run in dependency order and stop at the first unrecoverable
    one, because everything downstream of a missing binary or a dead daemon
    reports a misleading failure:

      1. gortex binary           (fatal; nothing else is meaningful without it)
      2. daemon reachable        -> gortex daemon start
      3. store health            -> reported; compaction is never automatic
      4. repository tracked      -> gortex track + gortex daemon reload
      5. index ready             -> gortex daemon reload, then a bounded wait
      6. kit wiring drift        -> re-run Install-GortexAgentKit.ps1
      7. skills mirrored         -> covered by the same installer run

    Steps 6 and 7 detect drift but never repair it directly. The installer is
    the single owner of what "wired" means; duplicating its logic here is how
    the two would silently disagree. This script decides *whether* to call it
    and then re-checks to confirm the call worked.

.PARAMETER RepoPath
    Repository to verify tracking and index state for. Defaults to the current
    directory, or to $env:PASEO_WORKTREE_PATH when invoked as a Paseo script.

.PARAMETER CheckOnly
    Diagnose and report without changing anything. Exit code still reflects the
    findings, which makes this usable as a health probe.

.PARAMETER Force
    Passed through to the installer to re-assert every managed file even when it
    already matches, and to re-seed the Codex hook block.

.PARAMETER IndexTimeoutSec
    Budget for the post-reload index wait. Indexing a large repo from cold is
    minutes, so the default is generous and only trips on a real hang.

.EXAMPLE
    .\Repair-GortexAgentKit.ps1
    Repair the integration for the repository in the current directory.

.EXAMPLE
    .\Repair-GortexAgentKit.ps1 -CheckOnly
    Report what is broken and exit non-zero if anything is, without repairing.

.NOTES
    Exit codes: 0 healthy or fully repaired, 1 problems remain, 2 unrecoverable
    (gortex missing, or the kit itself is incomplete).
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $KitRoot = $PSScriptRoot,

    [string] $RepoPath,

    [ValidateSet('auto', 'claude-code', 'copilot', 'codex', 'opencode', 'vscode')]
    [string[]] $Agents = @('auto'),

    # Mirrors the installer: $HOME is fixed at session start and cannot be
    # redirected with $env:USERPROFILE, so a sandbox needs an explicit root.
    [string] $ConfigRoot = $HOME,

    [switch] $CheckOnly,

    [switch] $SkipIndexWait,

    [ValidateRange(30, 7200)]
    [int] $IndexTimeoutSec = 900,

    [ValidateRange(5, 600)]
    [int] $DaemonTimeoutSec = 60,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Findings = [System.Collections.Generic.List[object]]::new()
$script:Repaired = 0
$script:Failed = 0

function Write-Step {
    param([string] $Message)
    Write-Host "[repair] $Message"
}

function Write-Detail {
    param([string] $Message)
    Write-Host "         $Message" -ForegroundColor DarkGray
}

# States are ordered by severity so the exit code can be derived from the worst
# one rather than tracked separately at every call site.
function Add-Finding {
    param(
        [Parameter(Mandatory)][string] $Check,
        [Parameter(Mandatory)][ValidateSet('Ok', 'Repaired', 'Failed', 'Skipped', 'Warning')][string] $State,
        [string] $Detail = ''
    )

    $script:Findings.Add([pscustomobject]@{
            Check  = $Check
            State  = $State
            Detail = $Detail
        })

    switch ($State) {
        'Repaired' { $script:Repaired++ }
        'Failed' { $script:Failed++ }
    }

    $colour = switch ($State) {
        'Ok' { 'DarkGray' }
        'Repaired' { 'Green' }
        'Failed' { 'Red' }
        'Warning' { 'Yellow' }
        default { 'DarkGray' }
    }
    Write-Host ("         {0,-9} {1}" -f $State, $Check) -ForegroundColor $colour
    if ($Detail) { Write-Detail "  $Detail" }
}

function Stop-WithReport {
    param([int] $Code)

    Write-Host ''
    Write-Host '=== Repair report ==='
    $script:Findings | Format-Table -AutoSize | Out-String -Width 160 | Write-Host

    if ($Code -eq 0) {
        Write-Host 'Gortex integration is healthy.' -ForegroundColor Green
    }
    else {
        Write-Host 'Unresolved problems remain. See the table above.' -ForegroundColor Yellow
    }

    if ($script:Repaired -gt 0) {
        Write-Host ''
        Write-Host 'Restart every agent session: hooks, skills and instructions load at session start.'
    }

    exit $Code
}

# Mirrors the installer's text I/O. Windows PowerShell 5.1 decodes a BOM-less
# file as ANSI, so comparing the instruction body with Get-Content would report
# permanent drift whenever the profile contains a non-ASCII character -- and the
# Gortex profiles contain em dashes.
function Read-TextFile {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Resolve-Executable {
    param([string] $Name)

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Gortex writes its own PATH entry at install time, which an already-running
# shell never sees. Re-reading the persisted environment avoids reporting a
# missing binary on a machine where it was installed moments ago.
function Update-PathFromEnvironment {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Invoke-Gortex {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [switch] $IgnoreExitCode
    )

    $output = & $script:GortexExe @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $IgnoreExitCode) {
        throw "gortex $($Arguments -join ' ') failed with exit code ${code}: $($output -join ' ')"
    }
    return [pscustomobject]@{ ExitCode = $code; Output = @($output) }
}

# --- resolve inputs ----------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $RepoPath = if (-not [string]::IsNullOrWhiteSpace($env:PASEO_WORKTREE_PATH)) {
        $env:PASEO_WORKTREE_PATH
    }
    else {
        (Get-Location).Path
    }
}

if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
    Write-Error "RepoPath does not exist: $RepoPath"
    exit 2
}
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

$installer = Join-Path $KitRoot 'Install-GortexAgentKit.ps1'
$worktreeTool = Join-Path $KitRoot 'transitional\Manage-GortexWorktree.ps1'

Write-Step "Kit root:   $KitRoot"
Write-Step "Repository: $RepoPath"
if ($CheckOnly) { Write-Step 'Mode:       check only (no changes will be made)' }

# --- 1. gortex binary --------------------------------------------------------

Update-PathFromEnvironment
$script:GortexExe = Resolve-Executable 'gortex'

if (-not $script:GortexExe) {
    # The installer puts it here and does not always reach PATH for the current
    # session, so a direct probe is worth one attempt before giving up.
    $fallback = Join-Path $ConfigRoot 'AppData\Local\Programs\gortex\gortex.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        $script:GortexExe = $fallback
        Add-Finding 'gortex binary' 'Warning' "found at $fallback but not on PATH; open a new shell to pick it up"
    }
}

if (-not $script:GortexExe) {
    Add-Finding 'gortex binary' 'Failed' 'not installed. Run: irm https://get.gortex.dev/install.ps1 | iex'
    Stop-WithReport 2
}
elseif ($script:Findings.Count -eq 0) {
    $version = (Invoke-Gortex -Arguments @('version') -IgnoreExitCode).Output -join ' '
    Add-Finding 'gortex binary' 'Ok' $version.Trim()
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    Add-Finding 'kit integrity' 'Failed' "installer not found at $installer"
    Stop-WithReport 2
}

# --- 2. daemon ---------------------------------------------------------------

function Test-Daemon {
    return (Invoke-Gortex -Arguments @('daemon', 'status') -IgnoreExitCode).ExitCode -eq 0
}

if (Test-Daemon) {
    Add-Finding 'daemon' 'Ok' 'reachable'
}
elseif ($CheckOnly) {
    Add-Finding 'daemon' 'Failed' 'not reachable (check only; would run: gortex daemon start)'
}
elseif ($PSCmdlet.ShouldProcess('gortex daemon', 'Start')) {
    Write-Step 'Daemon is not reachable. Starting it.'
    Invoke-Gortex -Arguments @('daemon', 'start') -IgnoreExitCode | Out-Null

    $deadline = (Get-Date).AddSeconds($DaemonTimeoutSec)
    $up = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-Daemon) { $up = $true; break }
    }

    if ($up) {
        Add-Finding 'daemon' 'Repaired' 'started'
    }
    else {
        Add-Finding 'daemon' 'Failed' "did not become reachable within ${DaemonTimeoutSec}s. Check: gortex daemon logs"
        # Every remaining check reads through the daemon, so continuing here
        # would turn one real failure into a screenful of false ones.
        Stop-WithReport 1
    }
}

# --- 3-5. repository state ---------------------------------------------------

function Get-RepoStatus {
    if (-not (Test-Path -LiteralPath $worktreeTool -PathType Leaf)) { return $null }
    try {
        return & $worktreeTool -Action Status -WorktreePath $RepoPath -ErrorAction Stop
    }
    catch {
        Write-Detail "status probe failed: $($_.Exception.Message)"
        return $null
    }
}

$status = Get-RepoStatus

if ($null -eq $status) {
    Add-Finding 'repository status' 'Warning' 'could not read status; tracking and index checks skipped'
}
else {
    # --- store health ---
    $storeHealth = if ($null -ne $status.StoreHealth) { [string] $status.StoreHealth } else { 'Unknown' }
    if ($storeHealth -eq 'Healthy') {
        Add-Finding 'store health' 'Ok' "$storeHealth; $($status.StoreSize) total, $($status.StoreReclaimable) reclaimable"
    }
    else {
        # Compaction takes an exclusive lock and can run for minutes, so it stays
        # an explicit operator decision rather than something a repair triggers.
        Add-Finding 'store health' 'Warning' "$storeHealth. Reclaim with: Manage-GortexWorktree.ps1 -Action Compact"
    }

    # --- tracked ---
    if ($status.Tracked) {
        Add-Finding 'repository tracked' 'Ok' "as '$($status.Repo)'"
    }
    elseif ($CheckOnly) {
        Add-Finding 'repository tracked' 'Failed' "not tracked (check only; would run: gortex track $RepoPath)"
    }
    elseif ($PSCmdlet.ShouldProcess($RepoPath, 'Track with gortex')) {
        # An untracked repo is the failure that looks most like a broken kit: the
        # hooks fire, the gate answers Untracked forever, and every graph tool
        # reports "cwd is not covered by any tracked repo".
        Write-Step 'Repository is not tracked. Tracking it.'
        try {
            Invoke-Gortex -Arguments @('track', $RepoPath) | Out-Null
            Invoke-Gortex -Arguments @('daemon', 'reload') -IgnoreExitCode | Out-Null
            $status = Get-RepoStatus
            if ($null -ne $status -and $status.Tracked) {
                Add-Finding 'repository tracked' 'Repaired' "tracked as '$($status.Repo)'"
            }
            else {
                Add-Finding 'repository tracked' 'Failed' 'gortex track reported success but the repo is still untracked'
            }
        }
        catch {
            Add-Finding 'repository tracked' 'Failed' $_.Exception.Message
        }
    }

    # --- index ---
    $indexState = if ($null -ne $status -and $null -ne $status.IndexState) { [string] $status.IndexState } else { 'Unknown' }

    if ($indexState -eq 'Ready') {
        Add-Finding 'index state' 'Ok' 'Ready'
    }
    elseif ($SkipIndexWait) {
        Add-Finding 'index state' 'Warning' "$indexState (wait skipped)"
    }
    elseif ($CheckOnly) {
        Add-Finding 'index state' 'Failed' "$indexState (check only; would reload and wait)"
    }
    elseif ($PSCmdlet.ShouldProcess($RepoPath, 'Reload the daemon and wait for the index')) {
        Write-Step "Index is '$indexState'. Reloading the daemon and waiting."
        try {
            Invoke-Gortex -Arguments @('daemon', 'reload') -IgnoreExitCode | Out-Null
            & $worktreeTool -Action Wait -WorktreePath $RepoPath -IndexTimeout "$($IndexTimeoutSec)s" | Out-Null

            $status = Get-RepoStatus
            $after = if ($null -ne $status -and $null -ne $status.IndexState) { [string] $status.IndexState } else { 'Unknown' }
            if ($after -eq 'Ready') {
                Add-Finding 'index state' 'Repaired' 'Ready'
            }
            else {
                Add-Finding 'index state' 'Failed' "still $after after ${IndexTimeoutSec}s"
            }
        }
        catch {
            Add-Finding 'index state' 'Failed' $_.Exception.Message
        }
    }
}

# --- 6-7. kit wiring ---------------------------------------------------------

# Drift detection only. The installer owns the definition of "wired"; this list
# exists so the report can name what was wrong and so a healthy machine is not
# put through an installer run it does not need.
function Get-WiringDrift {
    $drift = [System.Collections.Generic.List[string]]::new()

    $hookTarget = Join-Path $ConfigRoot '.gortex\agent-hooks'
    foreach ($file in @('gortex-readiness.ps1', 'copilot-hook.ps1', 'codex-hook.ps1', 'claude-hook.ps1', 'claude-hook.cmd')) {
        $deployed = Join-Path $hookTarget $file
        $source = Join-Path $KitRoot "hooks\$file"
        if (-not (Test-Path -LiteralPath $deployed -PathType Leaf)) {
            $drift.Add("hook missing: $file")
        }
        elseif (Test-Path -LiteralPath $source -PathType Leaf) {
            $a = Read-TextFile $deployed
            $b = Read-TextFile $source
            if ($null -ne $a -and $null -ne $b -and $a.TrimEnd() -ne $b.TrimEnd()) {
                $drift.Add("hook stale: $file")
            }
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ConfigRoot '.copilot\hooks\gortex.json') -PathType Leaf)) {
        $drift.Add('Copilot CLI hooks not registered')
    }

    foreach ($mcp in @(
            @{ Path = Join-Path $ConfigRoot '.copilot\mcp-config.json'; Key = 'mcpServers'; Label = 'Copilot CLI' },
            @{ Path = Join-Path $ConfigRoot 'AppData\Roaming\Code\User\mcp.json'; Key = 'servers'; Label = 'VS Code' }
        )) {
        # A VS Code profile that does not exist is not drift; the installer
        # deliberately refuses to create one for an editor that is not present.
        $parent = Split-Path -Parent $mcp.Path
        if ($mcp.Label -eq 'VS Code' -and -not (Test-Path -LiteralPath $parent -PathType Container)) { continue }

        $registered = $false
        if (Test-Path -LiteralPath $mcp.Path -PathType Leaf) {
            try {
                $raw = Read-TextFile $mcp.Path
                if (-not [string]::IsNullOrWhiteSpace($raw)) {
                    $cfg = $raw | ConvertFrom-Json -AsHashtable
                    $registered = $cfg.Contains($mcp.Key) -and $null -ne $cfg[$mcp.Key] -and $cfg[$mcp.Key].Contains('gortex')
                }
            }
            catch {
                $drift.Add("$($mcp.Label) MCP config is not valid JSON")
                continue
            }
        }
        if (-not $registered) { $drift.Add("$($mcp.Label) MCP server not registered") }
    }

    # The Copilot instructions file inlines the active profile rather than
    # importing it, so switching profiles silently leaves it describing rules
    # that are no longer in force. This is the drift case that has no other
    # detector -- everything still "works", it just tells the model the wrong
    # thing. Comparing bodies is what turns that into a visible failure.
    $active = Join-Path $ConfigRoot '.gortex\instructions\active.md'
    # Not just the canonical path: Copilot loads ~\.copilot\copilot-instructions.md
    # AND ~\.copilot\instructions\*.md in the same session, and the installer
    # deliberately reuses whichever one already owns the block rather than
    # creating a second copy. Checking only the canonical name reports
    # "instructions file missing" on a machine that is in fact correctly wired.
    $copilotInstructions = Join-Path $ConfigRoot '.copilot\copilot-instructions.md'
    if (-not (Test-Path -LiteralPath $copilotInstructions -PathType Leaf)) {
        $owning = @(
            Get-ChildItem -LiteralPath (Join-Path $ConfigRoot '.copilot\instructions') `
                -File -Filter '*.md' -ErrorAction SilentlyContinue |
                Where-Object { (Read-TextFile $_.FullName) -match '<!-- gortex:rules:start -->' } |
                Sort-Object Name
        )
        if ($owning.Count -gt 0) { $copilotInstructions = $owning[0].FullName }
    }
    if (Test-Path -LiteralPath $active -PathType Leaf) {
        if (-not (Test-Path -LiteralPath $copilotInstructions -PathType Leaf)) {
            $drift.Add('Copilot instructions file missing')
        }
        else {
            $body = (Read-TextFile $active).Trim()
            $current = Read-TextFile $copilotInstructions
            if ($null -eq $current -or -not $current.Contains('<!-- gortex:rules:start -->')) {
                $drift.Add('Copilot instructions missing the gortex rules block')
            }
            # Deliberately .Contains and not -like. The instruction body is
            # Markdown, so it is full of * and [ ] that -like would read as
            # wildcard metacharacters -- which reported permanent drift on a
            # file that was in fact byte-for-byte correct.
            elseif (-not $current.Contains($body)) {
                $drift.Add('Copilot instructions are stale (active profile changed)')
            }
        }
    }

    $mirrored = @(Get-ChildItem (Join-Path $ConfigRoot '.agents\skills') -Directory -Filter 'gortex-*' -ErrorAction SilentlyContinue).Count
    if ($mirrored -eq 0) { $drift.Add('no gortex skills mirrored to ~/.agents/skills') }

    # Call sites wrap this in @() so an empty or single finding both arrive as an
    # array. Returning `, $drift` as well would nest it one level deeper and the
    # report would render the inner array as "System.String[]".
    return $drift.ToArray()
}

$drift = @(Get-WiringDrift)

if ($drift.Count -eq 0 -and -not $Force) {
    Add-Finding 'kit wiring' 'Ok' 'hooks, MCP, instructions and skills all current'
}
elseif ($CheckOnly) {
    Add-Finding 'kit wiring' 'Failed' ($drift -join '; ')
}
elseif ($PSCmdlet.ShouldProcess($installer, 'Re-run to repair kit wiring')) {
    if ($drift.Count -gt 0) {
        Write-Step "Wiring drift detected: $($drift.Count) item(s). Re-running the installer."
        foreach ($item in $drift) { Write-Detail "- $item" }
    }
    else {
        Write-Step 'Re-asserting all managed files (-Force).'
    }

    try {
        $arguments = @{
            KitRoot    = $KitRoot
            Agents     = $Agents
            ConfigRoot = $ConfigRoot
        }
        if ($Force) { $arguments['Force'] = $true }

        & $installer @arguments | Out-Null

        $after = @(Get-WiringDrift)
        if ($after.Count -eq 0) {
            Add-Finding 'kit wiring' 'Repaired' 'installer re-applied the managed configuration'
        }
        else {
            Add-Finding 'kit wiring' 'Failed' ("still drifted: " + ($after -join '; '))
        }
    }
    catch {
        Add-Finding 'kit wiring' 'Failed' $_.Exception.Message
    }
}

# --- verdict -----------------------------------------------------------------

Stop-WithReport ([int]($script:Failed -gt 0))
