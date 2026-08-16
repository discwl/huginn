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
$updater = Join-Path $KitRoot 'Update-GortexAgents.ps1'
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

# Drift detection only. Repair is delegated: the installer owns hooks, MCP and
# the Copilot instructions file, and Update-GortexAgents.ps1 owns refreshing an
# instruction block wherever it already lives. Each finding therefore carries the
# script that can actually fix it, so the repair runs the right one instead of
# re-running the installer against drift it has no way to resolve.
function Get-WiringDrift {
    $drift = [System.Collections.Generic.List[object]]::new()

    $startMark = '<!-- gortex:rules:start -->'
    $endMark = '<!-- gortex:rules:end -->'

    function Add-Drift {
        param([string] $Message, [string] $Fixer = 'installer')
        $drift.Add([pscustomobject]@{ Message = $Message; Fixer = $Fixer })
    }

    $hookTarget = Join-Path $ConfigRoot '.gortex\agent-hooks'
    foreach ($file in @('gortex-readiness.ps1', 'copilot-hook.ps1', 'codex-hook.ps1', 'claude-hook.ps1', 'claude-hook.cmd')) {
        $deployed = Join-Path $hookTarget $file
        $source = Join-Path $KitRoot "hooks\$file"
        if (-not (Test-Path -LiteralPath $deployed -PathType Leaf)) {
            Add-Drift "hook missing: $file"
        }
        elseif (Test-Path -LiteralPath $source -PathType Leaf) {
            $a = Read-TextFile $deployed
            $b = Read-TextFile $source
            if ($null -ne $a -and $null -ne $b -and $a.TrimEnd() -ne $b.TrimEnd()) {
                Add-Drift "hook stale: $file"
            }
        }
    }

    $copilotHooks = Join-Path $ConfigRoot '.copilot\hooks\gortex.json'
    if (-not (Test-Path -LiteralPath $copilotHooks -PathType Leaf)) {
        Add-Drift 'Copilot CLI hooks not registered'
    }
    else {
        # Presence is not enough. Copilot skips an event whose value is a bare
        # object instead of an array, silently and without logging anything, so
        # a file that looks correct can be wired to nothing at all.
        $parsed = try { Read-TextFile $copilotHooks | ConvertFrom-Json } catch { $null }
        if ($null -eq $parsed -or $null -eq $parsed.PSObject.Properties['hooks']) {
            Add-Drift 'Copilot CLI hooks unreadable'
        }
        else {
            $scalar = @($parsed.hooks.PSObject.Properties | Where-Object { $_.Value -isnot [array] })
            if ($scalar.Count -gt 0) {
                Add-Drift "Copilot CLI hooks never run (not arrays): $(($scalar.Name) -join ', ')"
            }
        }
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
                Add-Drift "$($mcp.Label) MCP config is not valid JSON"
                continue
            }
        }
        if (-not $registered) { Add-Drift "$($mcp.Label) MCP server not registered" }
    }

    # Instruction blocks are inlined copies of the active profile, so they go
    # stale on `gortex instructions switch`, on `gortex upgrade`, and on any
    # change to the block format itself. Nothing else detects this: every file
    # is present and well-formed, the agent simply gets told the wrong thing.
    #
    # The comparison is against the *whole block*, not just the body. An earlier
    # version checked `.Contains($body)` and passed a file whose block still
    # carried the old two-line management comment -- the body was present, so it
    # looked current, while `gortex install` and the kit each saw the other's
    # output as drift and rewrote it forever, stranding a .bak per alternation.
    $active = Join-Path $ConfigRoot '.gortex\instructions\active.md'
    if (Test-Path -LiteralPath $active -PathType Leaf) {
        $body = (Read-TextFile $active).Trim()

        # Byte-identical to what `gortex install`, Install-GortexAgentKit.ps1 and
        # Update-GortexAgents.ps1 all emit: start marker, LF, body, blank line,
        # end marker. Three writers agree on this exact form; a detector that
        # accepted anything looser would not notice when one of them drifted.
        $expected = $startMark + "`n" + $body + "`n`n" + $endMark

        # Copilot genuinely loads copilot-instructions.md *and* instructions\*.md
        # in the same session, and Gortex owns the Codex and OpenCode copies, so
        # every marker-carrying file is checked rather than just the canonical
        # Copilot one. A stale block in any of them reaches a model.
        $instructionFiles = [System.Collections.Generic.List[string]]::new()
        $instructionFiles.Add((Join-Path $ConfigRoot '.copilot\copilot-instructions.md'))
        $instructionFiles.Add((Join-Path $ConfigRoot '.codex\AGENTS.md'))
        $instructionFiles.Add((Join-Path $ConfigRoot '.config\opencode\AGENTS.md'))
        foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $ConfigRoot '.copilot\instructions') `
                    -File -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $instructionFiles.Add($f.FullName)
        }

        $copilotOwned = 0
        foreach ($path in $instructionFiles) {
            $current = Read-TextFile $path
            if ($null -eq $current) { continue }

            # Line endings are not drift. Comparing raw text would flag a file
            # some other tool rewrote with CRLF even though its rules are right.
            $normalised = $current -replace "`r`n", "`n"
            if (-not $normalised.Contains($startMark)) { continue }

            if ($path -like "*\.copilot\*") { $copilotOwned++ }

            if (-not $normalised.Contains($expected)) {
                Add-Drift "instructions stale: $(Split-Path -Leaf $path)" 'update'
            }
        }

        # Only the Copilot file is the kit's to create -- Gortex writes the Codex
        # and OpenCode ones itself, and Update-GortexAgents.ps1 deliberately
        # refuses to create any file, so a missing Copilot block is the
        # installer's job and nobody else's.
        if ($copilotOwned -eq 0) {
            Add-Drift 'Copilot instructions file missing or has no gortex rules block'
        }
    }

    $mirrored = @(Get-ChildItem (Join-Path $ConfigRoot '.agents\skills') -Directory -Filter 'gortex-*' -ErrorAction SilentlyContinue).Count
    if ($mirrored -eq 0) { Add-Drift 'no gortex skills mirrored to ~/.agents/skills' }

    # Call sites wrap this in @() so an empty or single finding both arrive as an
    # array. Returning `, $drift` as well would nest it one level deeper and the
    # report would render the inner array as "System.String[]".
    return $drift.ToArray()
}

$drift = @(Get-WiringDrift)

function Format-Drift {
    param([object[]] $Items)
    return (($Items | ForEach-Object { $_.Message }) -join '; ')
}

if ($drift.Count -eq 0 -and -not $Force) {
    Add-Finding 'kit wiring' 'Ok' 'hooks, MCP, instructions and skills all current'
}
elseif ($CheckOnly) {
    Add-Finding 'kit wiring' 'Failed' (Format-Drift $drift)
}
elseif ($PSCmdlet.ShouldProcess($installer, 'Re-run to repair kit wiring')) {
    if ($drift.Count -gt 0) {
        Write-Step "Wiring drift detected: $($drift.Count) item(s)."
        foreach ($item in $drift) { Write-Detail "- $($item.Message)" }
    }
    else {
        Write-Step 'Re-asserting all managed files (-Force).'
    }

    try {
        # The installer creates and wires; it only ever writes the Copilot
        # instructions file. A stale block in ~/.codex/AGENTS.md or the OpenCode
        # copy is outside its reach, so running it alone would report the same
        # drift forever. Both are run when both apply.
        $needsInstaller = $Force -or @($drift | Where-Object { $_.Fixer -eq 'installer' }).Count -gt 0
        $needsUpdate = @($drift | Where-Object { $_.Fixer -eq 'update' }).Count -gt 0

        $arguments = @{
            KitRoot    = $KitRoot
            Agents     = $Agents
            ConfigRoot = $ConfigRoot
        }
        if ($Force) { $arguments['Force'] = $true }

        if ($needsInstaller) {
            Write-Step 'Running Install-GortexAgentKit.ps1.'
            & $installer @arguments | Out-Null
        }

        if ($needsUpdate) {
            if (Test-Path -LiteralPath $updater -PathType Leaf) {
                Write-Step 'Running Update-GortexAgents.ps1 to refresh instruction blocks.'
                # -SkipSkills because the installer's mirror already covers them,
                # and running both would re-seed the same junctions twice.
                & $updater -ConfigRoot $ConfigRoot -KitRoot $KitRoot -SkipSkills | Out-Null
            }
            else {
                Write-Detail "Update-GortexAgents.ps1 not found at $updater"
            }
        }

        $after = @(Get-WiringDrift)
        if ($after.Count -eq 0) {
            Add-Finding 'kit wiring' 'Repaired' 'managed configuration re-applied'
        }
        else {
            Add-Finding 'kit wiring' 'Failed' ("still drifted: " + (Format-Drift $after))
        }
    }
    catch {
        Add-Finding 'kit wiring' 'Failed' $_.Exception.Message
    }
}

# --- verdict -----------------------------------------------------------------

Stop-WithReport ([int]($script:Failed -gt 0))
