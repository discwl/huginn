<#
.SYNOPSIS
    Mirrors Gortex's Claude-only skills into the shared agent skill root.

.DESCRIPTION
    `gortex install` writes skills for exactly one adapter: Claude Code, under
    ~/.claude/skills. Every other agent it configures gets MCP wiring and hooks
    but no skills, so Copilot CLI and Codex never see the gortex-* skills.

    Both of those agents read ~/.agents/skills:
      * Copilot CLI discovers it directly.
      * Codex discovers it in addition to ~/.codex/skills, which is why entries
        under ~/.agents/skills already appear in its [[skills.config]] toggles.

    Mirroring into that single root therefore reaches both without registering
    the same skill twice.

    Junctions are the default because Gortex rewrites its skills on every
    upgrade. A junction picks the new content up automatically, whereas copies
    silently rot until someone remembers to re-run this script.

.EXAMPLE
    .\Sync-AgentSkills.ps1 -WhatIf

.EXAMPLE
    .\Sync-AgentSkills.ps1 -Prune
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $SourceRoot = [IO.Path]::Combine($HOME, '.claude', 'skills'),

    [string[]] $Pattern = @('gortex-*'),

    # Reaches Copilot CLI and Codex at once. Add ~/.codex/skills only if Codex
    # ever stops reading the shared root; holding both registers duplicates.
    [string[]] $TargetRoot = @([IO.Path]::Combine($HOME, '.agents', 'skills')),

    [ValidateSet('Junction', 'Copy')]
    [string] $Mode = 'Junction',

    [switch] $Prune,

    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$markerName = '.gortex-managed'

function Test-ManagedLink {
    param([Parameter(Mandatory)][string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return $false
    }

    # A junction this script created is self-identifying through its target; a
    # copied tree needs the marker file. Anything else is user-owned and is left
    # alone unless -Force is passed.
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
        return $true
    }

    return (Test-Path -LiteralPath (Join-Path $Path $markerName) -PathType Leaf)
}

function Get-LinkTarget {
    param([Parameter(Mandatory)][string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or [string]::IsNullOrWhiteSpace($item.LinkType)) {
        return $null
    }

    # Target is a string[] on PowerShell 7 and a string on 5.1.
    $target = $item.Target
    if ($target -is [array]) {
        $target = $target | Select-Object -First 1
    }

    return $target
}

function Remove-ManagedItem {
    param([Parameter(Mandatory)][string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return
    }

    # Deleting a junction with -Recurse would walk into the target and take the
    # real skills with it, so the reparse point is removed on its own.
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
        [IO.Directory]::Delete($Path, $false)
    }
    else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "Skill source not found: $SourceRoot. Run 'gortex install' first."
}

$sourceSkills = @(
    Get-ChildItem -LiteralPath $SourceRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            $name = $_.Name
            @($Pattern | Where-Object { $name -like $_ }).Count -gt 0
        } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf }
)

Write-Host "[skills] Source: $SourceRoot"
Write-Host "[skills] Matched $($sourceSkills.Count) skill(s) for pattern: $($Pattern -join ', ')"

if ($sourceSkills.Count -eq 0) {
    Write-Warning 'No matching skills found; nothing to sync.'
    return
}

$results = @()

foreach ($root in $TargetRoot) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        if ($PSCmdlet.ShouldProcess($root, 'Create skill root')) {
            New-Item -ItemType Directory -Path $root -Force | Out-Null
        }
    }

    Write-Host "[skills] Target: $root ($Mode)"

    foreach ($skill in $sourceSkills) {
        $destination = Join-Path $root $skill.Name
        $action = 'created'

        if (Test-Path -LiteralPath $destination) {
            if (-not (Test-ManagedLink $destination) -and -not $Force) {
                $results += [pscustomobject]@{ Root = $root; Skill = $skill.Name; Action = 'skipped (user-owned)' }
                continue
            }

            if ($Mode -eq 'Junction' -and (Get-LinkTarget $destination) -eq $skill.FullName) {
                $results += [pscustomobject]@{ Root = $root; Skill = $skill.Name; Action = 'current' }
                continue
            }

            if (-not $PSCmdlet.ShouldProcess($destination, "Replace with $Mode")) {
                continue
            }

            Remove-ManagedItem $destination
            $action = 'replaced'
        }
        elseif (-not $PSCmdlet.ShouldProcess($destination, "Link $Mode")) {
            continue
        }

        if ($Mode -eq 'Junction') {
            # Junctions need no elevation, unlike symbolic links.
            New-Item -ItemType Junction -Path $destination -Target $skill.FullName | Out-Null
        }
        else {
            Copy-Item -LiteralPath $skill.FullName -Destination $destination -Recurse -Force
            Set-Content -LiteralPath (Join-Path $destination $markerName) -Value $skill.FullName -Encoding UTF8
        }

        $results += [pscustomobject]@{ Root = $root; Skill = $skill.Name; Action = $action }
    }

    if ($Prune) {
        $sourceNames = @($sourceSkills | ForEach-Object { $_.Name })
        $stale = @(
            Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object {
                    $name = $_.Name
                    @($Pattern | Where-Object { $name -like $_ }).Count -gt 0 -and
                    $sourceNames -notcontains $name -and
                    (Test-ManagedLink $_.FullName)
                }
        )

        foreach ($item in $stale) {
            if ($PSCmdlet.ShouldProcess($item.FullName, 'Prune managed skill')) {
                Remove-ManagedItem $item.FullName
                $results += [pscustomobject]@{ Root = $root; Skill = $item.Name; Action = 'pruned' }
            }
        }
    }
}

$results | Group-Object Action | Sort-Object Name | ForEach-Object {
    Write-Host ("[skills] {0,-22} {1}" -f $_.Name, $_.Count)
}

$skipped = @($results | Where-Object { $_.Action -like 'skipped*' })
if ($skipped.Count -gt 0) {
    Write-Warning "Left $($skipped.Count) user-owned director(ies) untouched. Pass -Force to overwrite: $(($skipped | ForEach-Object { $_.Skill }) -join ', ')"
}

Write-Host '[skills] Agents load skills at session start; restart Copilot CLI and Codex to pick these up.'

$results
