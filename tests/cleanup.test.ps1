#Requires -Version 7.0
# Standalone regression checks: every fixture is under a unique temporary root.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$cleanup = Join-Path (Split-Path $PSScriptRoot -Parent) 'Remove-LegacyGortexKit.ps1'
if (-not (Test-Path -LiteralPath $cleanup -PathType Leaf)) { throw 'Cleanup entrypoint does not exist yet.' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('gortex-kit-cleanup-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$checks = 0
function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Put-Text([string] $Root, [string] $Relative, [string] $Text) {
    $path = Join-Path $Root $Relative
    [IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
    return $path
}
function Put-Json([string] $Root, [string] $Relative, [object] $Value) {
    return Put-Text $Root $Relative (ConvertTo-Json -InputObject $Value -Depth 40)
}
function Read-Json([string] $Path) {
    return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable
}
function New-Fixture([string] $Name) {
    $path = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($path) | Out-Null
    return $path
}
function Run-Cleanup([string] $Root, [switch] $Apply, [switch] $WhatIfRun) {
    $args = @{ ConfigRoot = $Root; GortexHome = (Join-Path $Root '.gortex'); WarningAction = 'SilentlyContinue' }
    if ($Apply) { $args.Apply = $true }
    if ($WhatIfRun) { $args.WhatIf = $true }
    return & $cleanup @args
}
try {
    $root = New-Fixture 'mixed'
    $hookRoot = (Join-Path $root '.gortex/agent-hooks') -replace '\\', '/'
    $claudeCommand = "if [ -f '$hookRoot/claude-hook.cmd' ]; then '$hookRoot/claude-hook.cmd' -Mode deny; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"
    $native = @{ type = 'command'; command = 'gortex hook --agent=claude-code --mode=deny' }
    $claude = Put-Json $root '.claude/settings.json' @{
        permissions = @{ allow = @('Read') }
        hooks = @{ PreToolUse = @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = $claudeCommand; timeout = 15 }, $native) }) }
    }
    $local = Put-Json $root '.claude/settings.local.json' @{ hooks = @{ UserPromptSubmit = @(@{ hooks = @($native) }) }; keep = 'local' }
    $codexCommand = "pwsh -NoProfile -ExecutionPolicy Bypass -File $hookRoot/codex-hook.ps1 -Mode deny"
    $toml = @"
model = 'example'
[hooks]
enabled = true
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
command = '$codexCommand'
statusMessage = 'Checking Gortex index readiness and surfacing graph context...'
timeout = 1860
type = 'command'
[[hooks.UserPromptSubmit.hooks]]
command = 'echo my hook'
type = 'command'
[[hooks.UserPromptSubmit]]
hooks = [{ type = 'command', command = 'gortex hook --agent=codex' }]
[hooks.state]
trusted_hash = 'preserve'
"@
    $codex = Put-Text $root '.codex/config.toml' $toml
    $copilotHook = Join-Path $root '.gortex/agent-hooks/copilot-hook.ps1'
    $inner = "if (Test-Path -LiteralPath '$copilotHook' -PathType Leaf) { & '$copilotHook' -Mode 'deny'; exit `$LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $copilot = Put-Json $root '.copilot/hooks/gortex.json' @{
        version = 1
        custom = 'preserve'
        hooks = @{ PreToolUse = @(@{ type = 'command'; powershell = "pwsh -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"; timeoutSec = 15 }, @{ type = 'command'; bash = 'gortex hook --agent=copilot' }) }
    }
    $instructions = Put-Text $root '.copilot/copilot-instructions.md' "Personal instructions`n<!-- gortex:rules:start -->`nshared upstream block`n<!-- gortex:rules:end -->"
    $mcp = Put-Json $root '.copilot/mcp-config.json' @{ mcpServers = @{ other = @{ command = 'other' }; gortex = @{ command = 'gortex'; args = @('mcp') } } }
    $before = @{}
    foreach ($path in @($claude, $local, $codex, $copilot, $instructions, $mcp)) { $before[$path] = [IO.File]::ReadAllText($path) }
    $preview = Run-Cleanup $root
    Assert-True ($preview.Planned -eq 3 -and $preview.Applied -eq 0) 'Preview should propose only the three legacy config changes.'
    foreach ($path in $before.Keys) { Assert-True ([IO.File]::ReadAllText($path) -ceq $before[$path]) "Preview changed $path" }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.gortexkit-backups'))) 'Preview created a backup directory.'
    $whatIf = Run-Cleanup $root -Apply -WhatIfRun
    Assert-True ($whatIf.Applied -eq 0) '-Apply -WhatIf performed changes.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root '.gortexkit-backups'))) '-WhatIf created a backup directory.'
    $applyMessages = @()
    $applied = & $cleanup -ConfigRoot $root -GortexHome (Join-Path $root '.gortex') -Apply -WarningAction SilentlyContinue -InformationVariable applyMessages
    Assert-True ($applied.Applied -eq 3) 'Apply should migrate three configurations.'
    $claudeAfter = Read-Json $claude
    Assert-True ($claudeAfter.hooks.PreToolUse[0].hooks.Count -eq 1) 'Mixed Claude hook group lost the wrong entries.'
    Assert-True ($claudeAfter.hooks.PreToolUse[0].hooks[0].command -eq $native.command) 'Native Claude hook was removed.'
    Assert-True ($claudeAfter.permissions.allow[0] -eq 'Read') 'Unrelated Claude settings were lost.'
    $tomlAfter = [IO.File]::ReadAllText($codex)
    Assert-True (-not $tomlAfter.Contains($codexCommand)) 'Legacy Codex hook remained.'
    Assert-True ($tomlAfter.Contains("command = 'echo my hook'") -and $tomlAfter.Contains("hooks = [{ type = 'command', command = 'gortex hook --agent=codex' }]")) 'Unrelated or inline Codex hooks were changed.'
    Assert-True ($tomlAfter.Contains("trusted_hash = 'preserve'")) 'Codex trust state was rewritten.'
    $copilotAfter = Read-Json $copilot
    Assert-True ($copilotAfter.hooks.PreToolUse.Count -eq 1 -and $copilotAfter.hooks.PreToolUse[0].bash -eq 'gortex hook --agent=copilot') 'Mixed encoded Copilot hooks were not preserved correctly.'
    foreach ($path in @($local, $instructions, $mcp)) { Assert-True ([IO.File]::ReadAllText($path) -ceq $before[$path]) "Unowned file changed: $path" }
    foreach ($change in $applied.Changes) {
        Assert-True (Test-Path -LiteralPath $change.Backup -PathType Leaf) 'Changed file has no backup.'
        Assert-True ([IO.File]::ReadAllText($change.Backup) -ceq $before[$change.Path]) 'Backup did not preserve the original file.'
    }
    $backupCount = @(Get-ChildItem -LiteralPath (Join-Path $root '.gortexkit-backups')).Count
    $again = Run-Cleanup $root -Apply
    Assert-True ($again.Planned -eq 0 -and $again.Applied -eq 0) 'Cleanup is not idempotent.'
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $root '.gortexkit-backups')).Count -eq $backupCount) 'Idempotent run created another backup.'

    $invalidRoot = New-Fixture 'invalid'
    $invalid = Put-Text $invalidRoot '.claude/settings.json' '{ "hooks": broken }'
    $duplicate = Put-Text $invalidRoot '.copilot/hooks/gortex.json' '{ "hooks": {}, "hooks": {} }'
    $invalidToml = Put-Text $invalidRoot '.codex/config.toml' '[[hooks.UserPromptSubmit]'
    $customPlugin = Put-Text $invalidRoot '.config/opencode/plugin/gortex-context.js' 'export default function userPlugin() {}'
    $invalidResult = Run-Cleanup $invalidRoot -Apply
    Assert-True ($invalidResult.Applied -eq 0) 'Invalid or custom configuration was modified.'
    Assert-True ($invalidResult.Warnings.Count -ge 3) 'Invalid JSON/TOML or custom plugin was not reported.'
    Assert-True ([IO.File]::ReadAllText($invalid) -ceq '{ "hooks": broken }') 'Invalid JSON was overwritten.'
    Assert-True ([IO.File]::ReadAllText($duplicate) -ceq '{ "hooks": {}, "hooks": {} }') 'Duplicate JSON keys were silently dropped.'
    Assert-True (Test-Path -LiteralPath $customPlugin) 'An unknown plugin was deleted.'

    $customRoot = New-Fixture 'custom-commands'
    $customHookRoot = (Join-Path $customRoot '.gortex/agent-hooks') -replace '\\', '/'
    $customCommand = "pwsh -NoProfile -ExecutionPolicy Bypass -File $customHookRoot/codex-hook.ps1 -Mode deny; Write-Host 'also mine'"
    $customHooks = Put-Json $customRoot '.codex/hooks.json' @{ hooks = @{ UserPromptSubmit = @(@{ hooks = @(@{ type = 'command'; command = $customCommand }) }) } }
    $customBefore = [IO.File]::ReadAllText($customHooks)
    $customResult = Run-Cleanup $customRoot -Apply
    Assert-True ($customResult.Applied -eq 0 -and $customResult.Warnings.Count -gt 0) 'Custom adapter command was not preserved and reported.'
    Assert-True ([IO.File]::ReadAllText($customHooks) -ceq $customBefore) 'Cleanup deleted a custom command action.'
    $standaloneRoot = New-Fixture 'standalone-toml'
    $standaloneHook = (Join-Path $standaloneRoot '.gortex/agent-hooks/codex-hook.ps1') -replace '\\', '/'
    $standaloneToml = Put-Text $standaloneRoot '.codex/config.toml' (@"
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
command = 'pwsh -NoProfile -ExecutionPolicy Bypass -File $standaloneHook -Mode deny'
type = 'command'
[[hooks.UserPromptSubmit]]
hooks = [{ type = 'command', command = 'echo keep' }]
"@)
    $standaloneResult = Run-Cleanup $standaloneRoot -Apply
    Assert-True ($standaloneResult.Applied -eq 1) 'Standalone legacy TOML hook was not removed.'
    $standaloneAfter = [IO.File]::ReadAllText($standaloneToml)
    Assert-True ([regex]::Matches($standaloneAfter, '(?m)^\[\[hooks\.UserPromptSubmit\]\]').Count -eq 1) 'Cleanup left an empty legacy TOML parent or removed a native one.'

    foreach ($variant in @('descendant', 'separated-descendant', 'parent-metadata')) {
        $groupRoot = New-Fixture ('custom-toml-' + $variant)
        $groupHook = (Join-Path $groupRoot '.gortex/agent-hooks/codex-hook.ps1') -replace '\\', '/'
        $parentBody = if ($variant -eq 'parent-metadata') { "matcher = ''" } else { '' }
        $descendant = if ($variant -eq 'parent-metadata') { '' } else { "[hooks.UserPromptSubmit.metadata]`ntag = 'mine'" }
        if ($variant -eq 'separated-descendant') { $descendant = "[other]`nkeep = true`n" + $descendant }
        $groupText = @"
[[hooks.UserPromptSubmit]]
$parentBody
[[hooks.UserPromptSubmit.hooks]]
type = 'command'
command = 'pwsh -NoProfile -ExecutionPolicy Bypass -File $groupHook -Mode deny'
$descendant
[[hooks.UserPromptSubmit]]
hooks = [{ type = 'command', command = 'echo native' }]
"@
        $groupPath = Put-Text $groupRoot '.codex/config.toml' $groupText
        $groupResult = Run-Cleanup $groupRoot -Apply
        Assert-True ($groupResult.Applied -eq 0) "Customized TOML group was partly removed: $variant"
        Assert-True ([IO.File]::ReadAllText($groupPath) -ceq $groupText) "TOML parent or descendant was orphaned: $variant"
        Assert-True ($groupResult.Warnings.Count -gt 0) "Customized TOML group was not reported: $variant"
    }
    Assert-True ($applyMessages[0].ToString() -eq "Cleanup backups: $($applied.BackupDirectory)") 'Apply did not log recovery location before its first change report.'

    $copyRoot = New-Fixture 'copies'
    $sourceSkill = Join-Path $copyRoot '.claude/skills/gortex-debug'
    $sourceText = Put-Text $copyRoot '.claude/skills/gortex-debug/SKILL.md' 'upstream skill'
    $copyText = Put-Text $copyRoot '.agents/skills/gortex-debug/SKILL.md' 'upstream skill'
    $marker = Put-Text $copyRoot '.agents/skills/gortex-debug/.gortex-managed' ($sourceSkill + "`n")
    $editedSource = Put-Text $copyRoot '.claude/skills/gortex-review/SKILL.md' 'upstream review'
    $editedCopy = Put-Text $copyRoot '.agents/skills/gortex-review/SKILL.md' 'my modified review'
    $editedMarker = Put-Text $copyRoot '.agents/skills/gortex-review/.gortex-managed' ((Split-Path $editedSource -Parent) + "`n")
    $foreignCopy = Put-Text $copyRoot '.agents/skills/humanizer/SKILL.md' 'personal skill'
    $foreignMarker = Put-Text $copyRoot '.agents/skills/humanizer/.gortex-managed' ((Join-Path $copyRoot '.claude/skills/humanizer') + "`n")
    $unmarked = Put-Text $copyRoot '.agents/skills/gortex-native/SKILL.md' 'native skill'
    $invalidMarkerCopy = Put-Text $copyRoot '.agents/skills/gortex-invalid/SKILL.md' 'preserve invalid marker'
    $invalidMarker = Put-Text $copyRoot '.agents/skills/gortex-invalid/.gortex-managed' ($copyRoot + [char]0 + '/invalid')
    $copyResult = Run-Cleanup $copyRoot -Apply
    Assert-True (Test-Path -LiteralPath $invalidMarkerCopy) 'A skill with an invalid ownership marker was removed.'
    Assert-True ($copyResult.Applied -eq 1 -and -not (Test-Path -LiteralPath $copyText)) 'Verified copied skill was not archived.'
    Assert-True (Test-Path -LiteralPath $sourceText) 'Skill source was removed.'
    Assert-True (Test-Path -LiteralPath $editedCopy) 'A modified copied skill was removed.'
    Assert-True (Test-Path -LiteralPath $foreignCopy) 'An unrelated managed skill was removed.'
    Assert-True (Test-Path -LiteralPath $unmarked) 'A native/unmarked Gortex skill was removed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $copyResult.Changes[0].Backup 'SKILL.md')) 'Archived copied skill has no backup.'

    if ($IsWindows) {
        $linkRoot = New-Fixture 'links'
        $targetText = Put-Text $linkRoot '.claude/skills/gortex-debug/SKILL.md' 'target survives'
        $linkParent = Join-Path $linkRoot '.agents/skills'
        [IO.Directory]::CreateDirectory($linkParent) | Out-Null
        $knownLink = Join-Path $linkParent 'gortex-debug'
        New-Item -ItemType Junction -Path $knownLink -Target (Split-Path $targetText -Parent) | Out-Null
        $otherTarget = Join-Path $testRoot 'outside-skill'
        [IO.Directory]::CreateDirectory($otherTarget) | Out-Null
        $unknownLink = Join-Path $linkParent 'gortex-other'
        New-Item -ItemType Junction -Path $unknownLink -Target $otherTarget | Out-Null
        $linkResult = Run-Cleanup $linkRoot -Apply
        Assert-True ($linkResult.Applied -eq 1 -and -not (Test-Path -LiteralPath $knownLink)) 'Known legacy junction was not archived.'
        Assert-True (Test-Path -LiteralPath $targetText) 'Archiving a junction deleted its target.'
        Assert-True ((Get-Item -LiteralPath $unknownLink).LinkType -eq 'Junction') 'Unknown junction was removed.'
        Assert-True ((Get-Item -LiteralPath $linkResult.Changes[0].Backup).LinkType -eq 'Junction') 'Junction backup followed or copied its target.'
        $escapeRoot = New-Fixture 'escape'
        $outside = New-Fixture 'outside-config'
        $outsideFile = Put-Json $outside 'settings.json' @{ hooks = @{}; private = 'untouched' }
        New-Item -ItemType Junction -Path (Join-Path $escapeRoot '.claude') -Target $outside | Out-Null
        $refused = $false
        try { Run-Cleanup $escapeRoot -Apply | Out-Null } catch { $refused = $_.Exception.Message -match 'reparse|link|escape' }
        Assert-True $refused 'A configuration path through a junction was not refused.'
        Assert-True ((Read-Json $outsideFile).private -eq 'untouched') 'An escaped configuration was modified.'
    }
    Write-Host "PASS: $checks cleanup checks. Fixtures: $testRoot"
}
finally {
    # Keep fixtures and their backups for inspection; never recursively delete links.
    Write-Host "Cleanup test artifacts retained at $testRoot"
}
