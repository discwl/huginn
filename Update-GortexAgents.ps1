<#
.SYNOPSIS
    Propagates the installed Gortex binary's instructions and skills to every agent.

.DESCRIPTION
    Gortex carries its agent-facing instruction text and its skill set inside the
    binary. Only Claude Code consumes them live: ~/.claude/CLAUDE.md @-includes
    ~/.gortex/instructions/active.md, so switching profiles or upgrading Gortex
    reaches it immediately.

    Codex, Copilot CLI, and OpenCode instead received an inline *copy* of that
    text, frozen at the moment it was written. Nothing re-synchronises them, so
    they drift silently on the next `gortex upgrade` or `gortex instructions
    switch` while Claude looks correct.

    Copilot has no Gortex adapter at all -- `gortex install --agents copilot`
    fails with "unknown agent name" -- so its instruction file is maintained
    entirely outside Gortex.

    This script closes that gap:

      instructions  Rewrites only the span between the gortex:rules markers in
                    each inline file, from ~/.gortex/instructions/active.md.
                    Everything outside the markers -- YAML frontmatter, and any
                    house rules of your own -- is preserved byte for byte.

      skills        Refreshes ~/.claude/skills from the binary, then re-runs the
                    mirror so skills added by an upgrade gain a junction and
                    skills removed by one are pruned. Existing skills need no
                    action: the mirror uses junctions, so their content already
                    follows the source.

    "Latest" means the installed binary, not the network. Pass -Upgrade to fetch
    a newer Gortex first.

.EXAMPLE
    .\Update-GortexAgents.ps1 -WhatIf

.EXAMPLE
    .\Update-GortexAgents.ps1

.EXAMPLE
    # Fetch a newer Gortex, then propagate everything it brought.
    .\Update-GortexAgents.ps1 -Upgrade

.EXAMPLE
    # Switch every agent to the lean profile, not just Claude.
    .\Update-GortexAgents.ps1 -Profile localization
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Run `gortex upgrade --run` first. This is the only step that uses the network.
    [switch] $Upgrade,

    # Switch the active instruction profile before propagating it.
    [ValidateSet('core', 'localization', 'full')]
    [string] $Profile,

    # Config tree to write into. Override only for a sandbox or another profile.
    [string] $ConfigRoot = $HOME,

    [string] $KitRoot = $PSScriptRoot,

    [switch] $SkipInstructions,

    [switch] $SkipSkills,

    # Rewrite instruction blocks even when they already match.
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$startMarker = '<!-- gortex:rules:start -->'
$endMarker = '<!-- gortex:rules:end -->'

function Get-Normalized {
    param([string] $Text)
    if ($null -eq $Text) { return '' }
    return ($Text -replace "`r`n", "`n").Trim()
}

# Windows PowerShell 5.1 decodes a BOM-less file as ANSI, which mangles the em
# dashes in the instruction profile, while -Encoding UTF8 writes a BOM that
# pwsh 7 would not. Either way the content comparison below sees a difference
# and rewrites the file on every run, so text I/O goes through .NET instead.
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)

function Read-TextFile {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Write-TextFile {
    param([string] $Path, [string] $Content)
    [IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function Backup-File {
    param([Parameter(Mandatory)][string] $Path)

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$Path.bak-$stamp"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    return $backup
}

$gortexExe = (Get-Command gortex -ErrorAction SilentlyContinue)
if ($null -eq $gortexExe) {
    throw "gortex not found on PATH. Install it first: irm https://get.gortex.dev/install.ps1 | iex"
}
$gortexExe = $gortexExe.Source

Write-Host "[update] gortex: $gortexExe"
Write-Host ('[update] version: ' + ((& $gortexExe version 2>&1 | Select-Object -First 1) -join ''))

# ---------------------------------------------------------------- upgrade ----

if ($Upgrade) {
    if ($PSCmdlet.ShouldProcess('gortex', 'upgrade --run')) {
        Write-Host '[update] Upgrading Gortex...'
        & $gortexExe upgrade --run
        if ($LASTEXITCODE -ne 0) {
            throw "gortex upgrade failed with exit code $LASTEXITCODE."
        }
        Write-Host ('[update] now: ' + ((& $gortexExe version 2>&1 | Select-Object -First 1) -join ''))
    }
}

# ----------------------------------------------------------- instructions ----

if (-not $SkipInstructions) {
    # regen and switch are machine-global: they always write ~/.gortex/instructions
    # and ignore -ConfigRoot. Running them against a sandbox would silently mutate
    # the live profile set, so they are skipped unless this is the real config tree.
    $isLiveRoot = ($ConfigRoot -eq $HOME)

    if (-not $isLiveRoot) {
        Write-Warning "ConfigRoot is not `$HOME; skipping 'instructions regen'/'switch' because both are machine-global."
    }

    # Regenerate the profile files from whichever binary is now installed. This
    # keeps the active selection, so it is safe to run unconditionally.
    if ($isLiveRoot -and $PSCmdlet.ShouldProcess('instruction profiles', 'gortex instructions regen')) {
        & $gortexExe instructions regen 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "gortex instructions regen exited $LASTEXITCODE; continuing with the files on disk."
        }
    }

    if ($Profile -and $isLiveRoot) {
        if ($PSCmdlet.ShouldProcess($Profile, 'gortex instructions switch')) {
            & $gortexExe instructions switch $Profile 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "gortex instructions switch $Profile failed with exit code $LASTEXITCODE."
            }
            Write-Host "[update] Active profile: $Profile"
        }
    }

    $activePath = Join-Path $ConfigRoot '.gortex\instructions\active.md'
    if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) {
        throw "Instruction source not found: $activePath. Run 'gortex install' first."
    }

    $body = (Read-TextFile $activePath).Trim()
    Write-Host "[update] Source: $activePath ($($body.Length) chars)"

    # Claude is deliberately absent: its CLAUDE.md @-includes active.md, so it
    # already tracks the source and rewriting it would only freeze a copy.
    #
    # Every file that carries the markers is refreshed, including more than one
    # per agent. Copilot genuinely loads both ~\.copilot\copilot-instructions.md
    # and ~\.copilot\instructions\*.md at the same time -- verified by planting a
    # sentinel in one and having a fresh `copilot -p` session echo it back next
    # to a value only the other carries -- so refreshing just one would leave a
    # second, contradictory copy of the rules in the model's context.
    #
    # Creating files is the installer's job, not this script's. Refreshing only
    # what already exists keeps one definition of where each agent's block lives.
    $targets = @()

    $candidates = @(
        [pscustomobject]@{ Agent = 'copilot';  Path = Join-Path $ConfigRoot '.copilot\copilot-instructions.md' }
        [pscustomobject]@{ Agent = 'codex';    Path = Join-Path $ConfigRoot '.codex\AGENTS.md' }
        [pscustomobject]@{ Agent = 'opencode'; Path = Join-Path $ConfigRoot '.config\opencode\AGENTS.md' }
    )

    $copilotInstrDir = Join-Path $ConfigRoot '.copilot\instructions'
    if (Test-Path -LiteralPath $copilotInstrDir -PathType Container) {
        foreach ($f in @(Get-ChildItem -LiteralPath $copilotInstrDir -File -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $candidates += [pscustomobject]@{ Agent = 'copilot'; Path = $f.FullName }
        }
    }

    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c.Path -PathType Leaf) { $targets += $c }
    }

    if ($targets.Count -eq 0) {
        Write-Warning 'No instruction files found. Run Install-GortexAgentKit.ps1 first.'
    }

    foreach ($t in $targets) {
        $text = Read-TextFile $t.Path
        $label = '{0}/{1}' -f $t.Agent, (Split-Path -Leaf $t.Path)

        # Must match Install-GortexAgentKit.ps1's Merge-InstructionBlock byte for
        # byte, including the management comment and its [Environment]::NewLine
        # joins. If the two scripts emitted different block text they would each
        # see the other's output as drift and rewrite it on every run, stranding
        # a backup each time.
        $block = @(
            $startMarker,
            '<!-- Managed by Install-GortexAgentKit.ps1. Edits inside this block are overwritten.',
            '     Re-run the installer after `gortex instructions switch` to refresh it. -->',
            $body.Trim(),
            $endMarker
        ) -join [Environment]::NewLine

        $startIdx = $text.IndexOf($startMarker)
        $endIdx = $text.IndexOf($endMarker)

        if ($startIdx -ge 0 -and $endIdx -lt $startIdx) {
            Write-Warning ("  {0} markers are out of order; leaving the file alone." -f $label)
            continue
        }

        if (($startIdx -lt 0) -ne ($endIdx -lt 0)) {
            Write-Warning ("  {0} only one gortex:rules marker found; leaving the file alone." -f $label)
            continue
        }

        if ($startIdx -lt 0) {
            # A file that never carried the block is left alone. Adding one here
            # would silently give an agent a second copy of the rules whenever
            # another file in the same tree already has it.
            Write-Host ("  {0,-42} no gortex block; skipped" -f $label)
            continue
        }

        $current = $text.Substring($startIdx, ($endIdx + $endMarker.Length) - $startIdx)
        if (-not $Force -and (Get-Normalized $current) -eq (Get-Normalized $block)) {
            Write-Host ("  {0,-42} current" -f $label)
            continue
        }

        $newText = $text.Substring(0, $startIdx) + $block + $text.Substring($endIdx + $endMarker.Length)

        if ($PSCmdlet.ShouldProcess($t.Path, 'Sync gortex rules block')) {
            $backup = Backup-File $t.Path
            Write-TextFile $t.Path $newText
            Write-Host ("  {0,-42} updated  (backup: {1})" -f $label, (Split-Path -Leaf $backup))
        }
        else {
            Write-Host ("  {0,-42} would update" -f $label)
        }
    }

    $claudeMd = Join-Path $ConfigRoot '.claude\CLAUDE.md'
    if (Test-Path -LiteralPath $claudeMd -PathType Leaf) {
        if ((Get-Content -LiteralPath $claudeMd -Raw) -match '@.*instructions[\\/]active\.md') {
            Write-Host '  claude    tracks active.md via @-include; nothing to write'
        }
        else {
            Write-Warning '  claude    CLAUDE.md has no @-include of active.md; run: gortex install --agents claude-code'
        }
    }
}

# ------------------------------------------------------------------ skills ----

if (-not $SkipSkills) {
    $skillSource = Join-Path $ConfigRoot '.claude\skills'
    $before = @()
    if (Test-Path -LiteralPath $skillSource -PathType Container) {
        $before = @(Get-ChildItem -LiteralPath $skillSource -Directory -Filter 'gortex-*' | ForEach-Object { $_.Name })
    }

    # Rewrites ~/.claude/skills from the binary. --no-hooks matters: a plain
    # `gortex install` re-adds its own [[hooks.*]] blocks on every run, which is
    # how duplicate hook entries accumulate in ~/.codex/config.toml.
    if ($PSCmdlet.ShouldProcess('skills', 'gortex install --agents claude-code --no-hooks --no-claude-md')) {
        Write-Host '[update] Refreshing skill source from the binary...'
        & $gortexExe install --agents claude-code --claude-config-dir (Join-Path $ConfigRoot '.claude') `
            --no-hooks --no-claude-md --yes 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "gortex install exited $LASTEXITCODE; mirroring whatever is on disk."
        }
    }

    $after = @()
    if (Test-Path -LiteralPath $skillSource -PathType Container) {
        $after = @(Get-ChildItem -LiteralPath $skillSource -Directory -Filter 'gortex-*' | ForEach-Object { $_.Name })
    }

    $added = @($after | Where-Object { $before -notcontains $_ })
    $removed = @($before | Where-Object { $after -notcontains $_ })

    Write-Host ("[update] Skills in source: {0} (added {1}, removed {2})" -f $after.Count, $added.Count, $removed.Count)
    if ($added.Count) { Write-Host ('  added:   ' + ($added -join ', ')) }
    if ($removed.Count) { Write-Host ('  removed: ' + ($removed -join ', ')) }

    # -Prune is what deletes junctions for skills the upgrade dropped; without it
    # a removed skill lingers in the mirror as a dangling reparse point.
    $sync = Join-Path $KitRoot 'Sync-AgentSkills.ps1'
    if (-not (Test-Path -LiteralPath $sync -PathType Leaf)) {
        throw "Sync-AgentSkills.ps1 not found next to this script: $sync"
    }

    & $sync -SourceRoot $skillSource `
        -TargetRoot @([IO.Path]::Combine($ConfigRoot, '.agents', 'skills')) `
        -Prune `
        -WhatIf:$WhatIfPreference
}

Write-Host '[update] Done. Restart every agent: instructions and skills load at session start.'
