#Requires -Version 7.2
<#
.SYNOPSIS
    Refresh native Gortex integrations in deny mode, optionally upgrading first.
.DESCRIPTION
    Requires a working native Gortex installation, version 0.64.0 or newer
    after any requested upgrade. Always runs native install, including when an
    upgrade finds the binary already current. Gortex owns instructions, skills,
    hooks, and MCP configuration. This wrapper checks installation results and
    runs daemon status and doctor.

    All supported native provider hooks use deny mode. Codex requires its own
    environment setting; Claude and OpenCode use --hook-mode=deny, and Copilot
    CLI's native hook defaults to deny. No legacy hook-mode inference is needed.

    Run Remove-LegacyGortexKit.ps1 before migrating an old kit installation.
    This script does not track worktrees, edit repository policy, or reindex.
.EXAMPLE
    .\Update-GortexAgents.ps1 -WhatIf
.EXAMPLE
    .\Update-GortexAgents.ps1 -Upgrade
.EXAMPLE
    .\Update-GortexAgents.ps1 -Agents codex,claude-code,copilot-cli,opencode -Profile core
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch] $Upgrade,
    [ValidateSet('core', 'localization', 'full')]
    [string] $Profile,
    [string[]] $Agents,
    [string] $GortexPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false

foreach ($agent in $Agents) {
    if ($agent -notmatch '^[a-z][a-z0-9-]*$') {
        throw "Invalid native agent name: $agent"
    }
}

# A preview must not invoke a binary or download anything.
if ($WhatIfPreference) {
    if ($Upgrade) { Write-Host '[update] Would upgrade the selected Gortex installation.' }
    if ($Profile) { Write-Host "[update] Would switch the native instruction profile to $Profile." }
    Write-Host '[update] Would set GORTEX_CODEX_HOOK_MODE=deny for native installation, run install --yes --json --hook-mode=deny, daemon status, and doctor.'
    return
}
if (-not $PSCmdlet.ShouldProcess('native Gortex installation and agent configuration', 'Refresh integrations in deny mode (and upgrade if requested)')) {
    return
}

if ($GortexPath) {
    $gortexExe = (Resolve-Path -LiteralPath $GortexPath).ProviderPath
}
else {
    $command = Get-Command gortex -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $gortexExe = $command.Source }
    elseif ($IsWindows -and $env:LOCALAPPDATA -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs/gortex/gortex.exe') -PathType Leaf)) {
        $gortexExe = Join-Path $env:LOCALAPPDATA 'Programs/gortex/gortex.exe'
        Write-Warning 'Using the default Windows installation; open a new shell to refresh PATH.'
    }
    else { throw 'gortex was not found. Install it using the official Gortex installer, then run this script again.' }
}
Write-Host "[update] gortex: $gortexExe"

function Invoke-Gortex {
    param([string[]] $Arguments, [switch] $Capture)
    $lines = @(& $gortexExe @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "gortex $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
    if ($Capture) { return ($lines -join "`n") }
    $lines | ForEach-Object { Write-Host $_ }
}

function Get-GortexVersion {
    $versionText = Invoke-Gortex -Arguments @('version') -Capture
    Write-Host "[update] $versionText"
    if ($versionText -notmatch '(?i)\bv?(\d+\.\d+\.\d+)') { throw "Cannot parse Gortex version: $versionText" }
    return [version]$Matches[1]
}

$previousCodexMode = [Environment]::GetEnvironmentVariable('GORTEX_CODEX_HOOK_MODE', 'Process')
$previousInstallDir = [Environment]::GetEnvironmentVariable('GORTEX_INSTALL_DIR', 'Process')
try {
    # Native install bakes this into Codex's hook commands. Restoring the shell
    # environment afterward does not undo the installed deny posture.
    $env:GORTEX_CODEX_HOOK_MODE = 'deny'
    $version = Get-GortexVersion
    if ($Upgrade) {
        # v0.64.0's upgrade detector misses the official Windows install location.
        # Reuse the official installer for precisely that installation; package
        # manager and other recognized installations use native upgrade --run.
        $defaultWindowsExe = if ($IsWindows -and $env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs/gortex/gortex.exe' } else { '' }
        if ($defaultWindowsExe -and [IO.Path]::GetFullPath($gortexExe).Equals([IO.Path]::GetFullPath($defaultWindowsExe), [StringComparison]::OrdinalIgnoreCase)) {
            $env:GORTEX_INSTALL_DIR = Split-Path -Parent $gortexExe
            Write-Host '[update] Running the official Windows installer.'
            $installer = Invoke-RestMethod -Uri 'https://get.gortex.dev/install.ps1'
            & ([scriptblock]::Create([string]$installer))
        }
        else {
            $upgradeArgs = @('upgrade', '--run')
            if ($version -ge [version]'0.64.0') { $upgradeArgs += '--no-migrate' }
            $upgradeOutput = Invoke-Gortex -Arguments $upgradeArgs -Capture
            Write-Host $upgradeOutput
            if ($upgradeOutput -match '(?i)unrecogni[sz]ed method') {
                throw 'Gortex cannot upgrade this installation automatically. Use its original installer or package manager, then rerun this script without -Upgrade.'
            }
        }
        $version = Get-GortexVersion
    }
    if ($version -lt [version]'0.64.0') {
        throw "Gortex $version is too old; version 0.64.0 or newer is required. Rerun with -Upgrade or update using the original installation method."
    }
    if ($Profile) { Invoke-Gortex -Arguments @('instructions', 'switch', $Profile) }

    $installArgs = @('install', '--yes', '--json', '--hook-mode=deny')
    if ($Agents) { $installArgs += '--agents=' + ($Agents -join ',') }
    $installOutput = Invoke-Gortex -Arguments $installArgs -Capture
    try { $report = ConvertFrom-Json -InputObject $installOutput -AsHashtable }
    catch { throw "gortex install returned invalid JSON: $installOutput" }
    if ($report -isnot [System.Collections.IDictionary] -or -not $report.Contains('agents')) {
        throw 'gortex install did not return agent installation results.'
    }
    $configured = @()
    $failed = @()
    foreach ($result in $report.agents) {
        Write-Host "[update] $($result.name): detected=$($result.detected), configured=$($result.configured)"
        foreach ($warning in $result['warnings']) { Write-Warning "$($result.name): $warning" }
        if ($result.configured) { $configured += $result.name }
        elseif ($result.detected) { $failed += $result.name }
    }
    if ($failed.Count) { throw "Native installation failed for: $($failed -join ', '). See the warnings above." }
    foreach ($agent in $Agents) {
        if ($agent -notin $configured) { throw "Requested agent '$agent' was not configured by native install." }
    }
    if (-not $configured.Count) { throw 'No agents were configured. Install a supported provider or specify -Agents.' }

    Invoke-Gortex -Arguments @('daemon', 'status')
    Invoke-Gortex -Arguments @('doctor')
    Write-Host '[update] Native configuration refreshed in deny mode. Open fresh provider sessions; use /hooks in Codex to review new or changed hooks.'
    if ($Upgrade) {
        Write-Host '[update] Review project-local gortex init configuration and release reindex guidance separately, once per primary repository.'
    }
}
finally {
    [Environment]::SetEnvironmentVariable('GORTEX_CODEX_HOOK_MODE', $previousCodexMode, 'Process')
    [Environment]::SetEnvironmentVariable('GORTEX_INSTALL_DIR', $previousInstallDir, 'Process')
}
