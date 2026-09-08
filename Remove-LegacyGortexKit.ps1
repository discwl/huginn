#Requires -Version 7.0
<#
.SYNOPSIS
    Preview or archive recognizable legacy GortexKit configuration.
.DESCRIPTION
    Default is a read-only preview. Use -Apply after reviewing it; -WhatIf is
    also honored. Changed files and removed artifacts are backed up under a
    unique .gortexkit-backups directory in ConfigRoot. Native Gortex hooks,
    MCP servers, shared instruction markers, and unrelated skills stay intact.

    Only the old kit's known command forms are removed. Custom commands,
    ambiguous TOML, modified skill copies, and unknown plugin versions are
    preserved with a review notice. This script does not invoke Gortex, edit
    repository/Paseo configuration, untrack repositories, or touch its store.
.PARAMETER ConfigRoot
    User configuration root; defaults to the current user's home. An explicit
    root supports inspecting another profile or an isolated test fixture.
.PARAMETER GortexHome
    Defaults to GORTEX_HOME, then ConfigRoot/.gortex. Used only to recognize
    legacy command paths and report remaining runtime files, never to edit
    Gortex configuration or its database.
.EXAMPLE
    ./Remove-LegacyGortexKit.ps1
.EXAMPLE
    ./Remove-LegacyGortexKit.ps1 -Apply
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch] $Apply,
    [string] $ConfigRoot = $HOME,
    [string] $GortexHome = $(if ($env:GORTEX_HOME) { $env:GORTEX_HOME } else { Join-Path $ConfigRoot '.gortex' })
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
$ConfigRoot = [IO.Path]::GetFullPath($ConfigRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$GortexHome = [IO.Path]::GetFullPath($GortexHome).TrimEnd([IO.Path]::DirectorySeparatorChar)
$plans = [Collections.Generic.List[object]]::new()
$notices = [Collections.Generic.List[string]]::new()

function Add-Notice([string] $Message) {
    $notices.Add($Message)
    Write-Warning $Message
}

function Assert-SafePath([string] $Path, [string] $Root, [switch] $AllowLeafLink) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.Equals($Root, $comparison) -and -not $full.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "Refusing path escaping the explicit root: $full"
    }
    # Inspect every ancestor, including ancestors of the supplied root. A path
    # that is lexically inside a profile can still lead outside it via a link.
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            if (-not ($AllowLeafLink -and $cursor.Equals($full, $comparison))) {
                throw "Refusing reparse/link path: $cursor"
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Add-Plan([string] $Path, [string] $Kind, [string] $Reason, [string] $Content = '', [string] $Snapshot = '') {
    $hash = if ($Kind -in @('Rewrite', 'File')) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } else { '' }
    $plans.Add([pscustomobject]@{ Path = $Path; Kind = $Kind; Reason = $Reason; Content = $Content; Hash = $hash; Snapshot = $Snapshot })
}

Assert-SafePath $ConfigRoot $ConfigRoot
Assert-SafePath $GortexHome $GortexHome
if (-not (Test-Path -LiteralPath $ConfigRoot -PathType Container)) { throw "ConfigRoot does not exist: $ConfigRoot" }
$legacyHomes = @((Join-Path $ConfigRoot '.gortex'), $GortexHome) | Select-Object -Unique
$modeNames = @('deny', 'enrich', 'consult-unlock', 'nudge')
# These are the executable forms emitted by the old installer, not arbitrary
# commands that merely mention an adapter filename.
$hostPattern = '(?:(?:pwsh|powershell)(?:\.exe)?|(?:[A-Za-z]:/|/)[A-Za-z0-9 _./()\-]+/(?:pwsh|powershell)\.exe)'
$hostPattern = '(?:' + $hostPattern + '|"' + $hostPattern + '"|\x27' + $hostPattern + '\x27)'

function Get-DecodedCommand([string] $Command) {
    $match = [regex]::Match($Command, '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)')
    if (-not $match.Success) { return '' }
    try { return [Text.UnicodeEncoding]::new($false, $false, $true).GetString([Convert]::FromBase64String($match.Groups[1].Value)) }
    catch { return '' }
}

function Test-LegacyCommand([string] $Command, [string] $Agent) {
    $text = ($Command -replace '\\', '/').Trim()
    foreach ($legacyHome in $legacyHomes) {
        $base = ((Join-Path $legacyHome 'agent-hooks') -replace '\\', '/')
        foreach ($mode in $modeNames) {
            switch ($Agent) {
                'claude' {
                    $path = "$base/claude-hook.cmd"
                    $expected = "if [ -f '$path' ]; then '$path' -Mode $mode; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"
                    if ($text.Equals($expected, $comparison)) { return $true }
                }
                'codex' {
                    $path = [regex]::Escape("$base/codex-hook.ps1")
                    $pathPattern = '(?:' + $path + '|"' + $path + '"|\x27' + $path + '\x27)'
                    if ($text -match ('(?i)^' + $hostPattern + ' -NoProfile -ExecutionPolicy Bypass -File ' + $pathPattern + ' -Mode ' + $mode + '$')) { return $true }
                }
                'copilot' {
                    if ($text -notmatch ('(?i)^' + $hostPattern + ' -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$')) { continue }
                    $decoded = (Get-DecodedCommand $Command) -replace '\\', '/'
                    $path = "$base/copilot-hook.ps1"
                    $expected = "if (Test-Path -LiteralPath '$path' -PathType Leaf) { & '$path' -Mode '$mode'; exit `$LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0"
                    if ($decoded.Equals($expected, $comparison)) { return $true }
                }
            }
        }
    }
    return $false
}

function Test-LegacyReference([string] $Command) {
    $text = ($Command + ' ' + (Get-DecodedCommand $Command)) -replace '\\', '/'
    return $text -match '(?i)/agent-hooks/(?:claude-hook\.(?:cmd|ps1)|codex-hook\.ps1|copilot-hook\.ps1|gortex-readiness\.ps1)'
}

function Test-LegacyEntry([object] $Entry, [string] $Agent, [string] $Path) {
    if ($Entry -isnot [Collections.IDictionary]) { return $false }
    $commands = @($Entry.Keys | Where-Object { $_ -in @('command', 'powershell', 'bash') })
    $references = @($commands | Where-Object { $Entry[$_] -is [string] -and (Test-LegacyReference $Entry[$_]) })
    if ($references.Count -eq 0) { return $false }
    $allowedKeys = @('type', 'command', 'powershell', 'timeout', 'timeoutSec', 'statusMessage')
    if ($commands.Count -eq 1 -and $Entry.Contains('type') -and $Entry.type -eq 'command' -and
        @($Entry.Keys | Where-Object { $_ -notin $allowedKeys }).Count -eq 0 -and
        (Test-LegacyCommand $Entry[$commands[0]] $Agent)) { return $true }
    Add-Notice "Review custom legacy hook in $Path; its command or fields differ from the kit's known form, so it was preserved."
    return $false
}

function Assert-UniqueJsonKeys([System.Text.Json.JsonElement] $Element) {
    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $names.Add($property.Name)) { throw "Duplicate JSON key: $($property.Name)" }
            Assert-UniqueJsonKeys $property.Value
        }
    }
    elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        foreach ($child in $Element.EnumerateArray()) { Assert-UniqueJsonKeys $child }
    }
}

function Inspect-JsonHooks([string] $RelativePath, [string] $Agent) {
    $path = Join-Path $ConfigRoot $RelativePath
    Assert-SafePath $path $ConfigRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $raw = [IO.File]::ReadAllText($path, $utf8)
    $document = $null
    try {
        $document = [System.Text.Json.JsonDocument]::Parse($raw)
        Assert-UniqueJsonKeys $document.RootElement
        $config = ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 100
        if ($config -isnot [Collections.IDictionary]) { throw 'Expected a JSON object.' }
    }
    catch { Add-Notice "Preserved $path; invalid or unsupported JSON: $($_.Exception.Message)"; return }
    finally { if ($document) { $document.Dispose() } }
    if (-not $config.Contains('hooks')) { return }
    if ($config.hooks -isnot [Collections.IDictionary]) { Add-Notice "Preserved unsupported hooks structure in $path; review it manually."; return }
    $changed = $false
    foreach ($eventName in @($config.hooks.Keys)) {
        $entries = $config.hooks[$eventName]
        if ($entries -isnot [array]) { Add-Notice "Preserved non-array hook event $eventName in $path; review it manually."; continue }
        $kept = [Collections.Generic.List[object]]::new()
        foreach ($entry in $entries) {
            if ($Agent -eq 'copilot') {
                if (Test-LegacyEntry $entry $Agent $path) { $changed = $true } else { $kept.Add($entry) }
                continue
            }
            if ($entry -isnot [Collections.IDictionary] -or -not $entry.Contains('hooks') -or $entry.hooks -isnot [array]) {
                $kept.Add($entry)
                continue
            }
            $remaining = [Collections.Generic.List[object]]::new()
            $removed = $false
            foreach ($hook in $entry.hooks) {
                if (Test-LegacyEntry $hook $Agent $path) { $changed = $true; $removed = $true } else { $remaining.Add($hook) }
            }
            if ($removed) {
                $entry.hooks = $remaining.ToArray()
                # Discard an empty standard matcher wrapper, but retain unknown
                # metadata if the user extended this group.
                if ($remaining.Count -eq 0 -and @($entry.Keys | Where-Object { $_ -notin @('hooks', 'matcher') }).Count -eq 0) { continue }
            }
            $kept.Add($entry)
        }
        if ($kept.Count -eq 0 -and $entries.Count -gt 0) { [void]$config.hooks.Remove($eventName) }
        else { $config.hooks[$eventName] = $kept.ToArray() }
    }
    if ($changed) { Add-Plan $path 'Rewrite' 'Remove recognized legacy hooks; preserve native and unrelated entries' ((ConvertTo-Json -InputObject $config -Depth 100) + [Environment]::NewLine) }
}

function Inspect-CodexToml {
    $path = Join-Path $ConfigRoot '.codex/config.toml'
    Assert-SafePath $path $ConfigRoot
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $raw = [IO.File]::ReadAllText($path, $utf8)
    # A deliberately bounded section editor, not a TOML parser. Multiline
    # strings can contain apparent headers; leave the whole file for review.
    if ($raw.Contains("'''") -or $raw.Contains('"""')) {
        if (Test-LegacyReference $raw) { Add-Notice "Preserved $path; multiline TOML strings require manual legacy-hook cleanup." }
        return
    }
    foreach ($line in ($raw -split '\r?\n')) {
        if ($line.TrimStart().StartsWith('[') -and $line -notmatch '^\s*(?:\[\[[^\[\]\r\n]+\]\]|\[[^\[\]\r\n]+\])\s*(?:#.*)?$') {
            Add-Notice "Preserved $path; malformed or unsupported TOML header requires review."
            return
        }
    }
    $headers = [regex]::Matches($raw, '(?m)^[ \t]*(?:\[\[[^\[\]\r\n]+\]\]|\[[^\[\]\r\n]+\])[ \t]*(?:#[^\r\n]*)?(?:\r?\n|\z)')
    $sections = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $headers.Count; $i++) {
        $end = if ($i + 1 -lt $headers.Count) { $headers[$i + 1].Index } else { $raw.Length }
        $header = ($headers[$i].Value -replace '\s*#.*$', '').Trim()
        $sections.Add([pscustomobject]@{ Start = $headers[$i].Index; Length = $end - $headers[$i].Index; Header = $header; Body = $raw.Substring($headers[$i].Index + $headers[$i].Length, $end - $headers[$i].Index - $headers[$i].Length); Remove = $false })
    }
    $parent = -1
    for ($i = 0; $i -lt $sections.Count; $i++) {
        $section = $sections[$i]
        if ($section.Header -eq '[[hooks.UserPromptSubmit]]') { $parent = $i; continue }
        if ($section.Header -ne '[[hooks.UserPromptSubmit.hooks]]') { $parent = -1; continue }
        if ($parent -lt 0 -or -not (Test-LegacyReference $section.Body)) { continue }
        $fields = @{}
        $valid = $true
        foreach ($line in ($section.Body -split '\r?\n')) {
            if ($line -match '^\s*(?:#.*)?$') { continue }
            if ($line -match '^\s*(command|statusMessage|type)\s*=\s*\x27([^\x27\r\n]*)\x27\s*(?:#.*)?$') {
                $key = $Matches[1]; $value = $Matches[2]
            }
            elseif ($line -match '^\s*(command|statusMessage|type)\s*=\s*"([^"\\\r\n]*)"\s*(?:#.*)?$') {
                $key = $Matches[1]; $value = $Matches[2]
            }
            elseif ($line -match '^\s*(timeout)\s*=\s*([0-9]+)\s*(?:#.*)?$') {
                $key = $Matches[1]; $value = $Matches[2]
            }
            else { $valid = $false; break }
            if ($fields.ContainsKey($key)) { $valid = $false; break }
            $fields[$key] = $value
        }
        if ($i + 1 -lt $sections.Count -and $sections[$i + 1].Header -match '^\[\[?hooks\.UserPromptSubmit\.hooks\.') { $valid = $false }
        if ($valid -and $fields.ContainsKey('command') -and $fields.ContainsKey('type') -and $fields.type -eq 'command' -and (Test-LegacyCommand $fields.command 'codex')) {
            $section.Remove = $true
        }
        else { Add-Notice "Preserved custom legacy TOML hook in $path; review the UserPromptSubmit hook referencing agent-hooks." }
    }
    for ($i = 0; $i -lt $sections.Count; $i++) {
        if ($sections[$i].Header -ne '[[hooks.UserPromptSubmit]]') { continue }
        $children = @()
        for ($j = $i + 1; $j -lt $sections.Count -and $sections[$j].Header -eq '[[hooks.UserPromptSubmit.hooks]]'; $j++) { $children += $sections[$j] }
        if ($children.Count -eq 0 -or @($children | Where-Object { -not $_.Remove }).Count -gt 0) { continue }
        $customized = -not [string]::IsNullOrWhiteSpace($sections[$i].Body)
        # Descendants can reopen after an unrelated table. Removing their array
        # parent can rebind them or make the next array entry invalid TOML.
        for ($next = $j; $next -lt $sections.Count -and $sections[$next].Header -ne '[[hooks.UserPromptSubmit]]'; $next++) {
            if ($sections[$next].Header -match 'UserPromptSubmit') { $customized = $true; break }
        }
        if ($customized) {
            foreach ($child in $children) { $child.Remove = $false }
            Add-Notice "Preserved customized TOML hook group in $path; review its legacy hook and metadata together."
        }
        else { $sections[$i].Remove = $true }
    }
    $updated = $raw
    for ($i = $sections.Count - 1; $i -ge 0; $i--) { if ($sections[$i].Remove) { $updated = $updated.Remove($sections[$i].Start, $sections[$i].Length) } }
    if ($updated -cne $raw) { Add-Plan $path 'Rewrite' 'Remove recognized legacy Codex hook sections; preserve other TOML byte for byte' $updated }
}

function Get-SkillSnapshot([string] $Root, [switch] $SkipMarker) {
    Assert-SafePath $Root $ConfigRoot
    $map = [ordered]@{}
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Root)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in (Get-ChildItem -LiteralPath $directory -Force | Sort-Object Name)) {
            Assert-SafePath $item.FullName $ConfigRoot
            $relative = [IO.Path]::GetRelativePath($Root, $item.FullName)
            if ($SkipMarker -and $relative -eq '.gortex-managed') { continue }
            if ($item.PSIsContainer) { $map[$relative] = 'directory'; $queue.Enqueue($item.FullName) }
            else { $map[$relative] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
        }
    }
    return ConvertTo-Json -InputObject $map -Compress -Depth 5
}

function Inspect-Skills {
    $root = Join-Path $ConfigRoot '.agents/skills'
    Assert-SafePath $root $ConfigRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    foreach ($item in (Get-ChildItem -LiteralPath $root -Force -Filter 'gortex-*')) {
        $expected = [IO.Path]::GetFullPath((Join-Path $ConfigRoot ('.claude/skills/' + $item.Name)))
        Assert-SafePath $item.FullName $ConfigRoot -AllowLeafLink
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $targets = @($item.Target)
            if ($item.LinkType -ne 'Junction' -or $targets.Count -ne 1 -or -not [IO.Path]::IsPathFullyQualified($targets[0]) -or
                -not ([IO.Path]::GetFullPath($targets[0])).Equals($expected, $comparison)) {
                Add-Notice "Preserved unknown skill link $($item.FullName); only a junction to the same-name .claude/skills directory is owned."
                continue
            }
            Assert-SafePath $expected $ConfigRoot
            Add-Plan $item.FullName 'Link' 'Archive the legacy junction itself; leave its target intact' '' $expected
            continue
        }
        if (-not $item.PSIsContainer) { continue }
        $marker = Join-Path $item.FullName '.gortex-managed'
        Assert-SafePath $marker $ConfigRoot
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { continue }
        try {
            $source = [IO.File]::ReadAllText($marker, $utf8).Trim()
            if (-not [IO.Path]::IsPathFullyQualified($source) -or -not ([IO.Path]::GetFullPath($source)).Equals($expected, $comparison)) {
                throw 'Its ownership marker does not identify the expected legacy source.'
            }
            Assert-SafePath $expected $ConfigRoot
            if (-not (Test-Path -LiteralPath $expected -PathType Container)) { throw 'The original skill source is missing.' }
            $copySnapshot = Get-SkillSnapshot $item.FullName -SkipMarker
            if ($copySnapshot -cne (Get-SkillSnapshot $expected)) { throw 'The copy differs from its current source; it may contain user changes.' }
            Add-Plan $item.FullName 'Directory' 'Archive a marker-owned skill copy identical to its original source' '' (Get-SkillSnapshot $item.FullName)
        }
        catch { Add-Notice "Preserved skill $($item.FullName); $($_.Exception.Message) Review it manually." }
    }
}

Inspect-JsonHooks '.claude/settings.json' 'claude'
Inspect-JsonHooks '.claude/settings.local.json' 'claude'
Inspect-JsonHooks '.codex/hooks.json' 'codex'
Inspect-JsonHooks '.copilot/hooks/gortex.json' 'copilot'
Inspect-CodexToml
Inspect-Skills
$plugin = Join-Path $ConfigRoot '.config/opencode/plugin/gortex-context.js'
Assert-SafePath $plugin $ConfigRoot
if (Test-Path -LiteralPath $plugin -PathType Leaf) {
    # SHA256 of the retired, unmodified kit plugin. Filename alone is not proof.
    if ((Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash -eq '05A9398BD5A2DA74603D4F782141E392C7E293F36576A7B46A6FA07BF00AB896') {
        Add-Plan $plugin 'File' 'Archive the verified legacy OpenCode plugin'
    }
    else { Add-Notice "Preserved unknown or modified plugin $plugin; compare it with your legacy kit before removing it manually." }
}
foreach ($legacyHome in $legacyHomes) {
    $runtime = Join-Path $legacyHome 'agent-hooks'
    Assert-SafePath $runtime $legacyHome
    if (Test-Path -LiteralPath $runtime) { Add-Notice "Legacy runtime remains at $runtime. This script leaves these files intact; remove them manually after verifying no custom or repository hooks reference them." }
}

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')
$backupDirectory = Join-Path $ConfigRoot ('.gortexkit-backups/' + $runId)
$results = [Collections.Generic.List[object]]::new()
$applied = 0
foreach ($plan in $plans) {
    $backup = $null
    $didApply = $false
    if ($Apply -and $PSCmdlet.ShouldProcess($plan.Path, $plan.Reason)) {
        Assert-SafePath $plan.Path $ConfigRoot -AllowLeafLink:($plan.Kind -eq 'Link')
        if ($plan.Kind -in @('Rewrite', 'File') -and (Get-FileHash -LiteralPath $plan.Path -Algorithm SHA256).Hash -ne $plan.Hash) { throw "File changed after inspection; rerun cleanup: $($plan.Path)" }
        if ($plan.Kind -eq 'Directory' -and (Get-SkillSnapshot $plan.Path) -cne $plan.Snapshot) { throw "Skill changed after inspection; rerun cleanup: $($plan.Path)" }
        if ($plan.Kind -eq 'Link') {
            $link = Get-Item -LiteralPath $plan.Path -Force
            if ($link.LinkType -ne 'Junction' -or -not ([IO.Path]::GetFullPath($link.Target)).Equals($plan.Snapshot, $comparison)) { throw "Junction changed after inspection; rerun cleanup: $($plan.Path)" }
        }
        $backup = Join-Path $backupDirectory ([IO.Path]::GetRelativePath($ConfigRoot, $plan.Path))
        Assert-SafePath $backup $ConfigRoot
        [IO.Directory]::CreateDirectory((Split-Path $backup -Parent)) | Out-Null
        if ($applied -eq 0) { Write-Host "Cleanup backups: $backupDirectory" }
        if ($plan.Kind -eq 'Rewrite') {
            [IO.File]::Copy($plan.Path, $backup, $false)
            [IO.File]::WriteAllText($plan.Path, $plan.Content, $utf8)
        }
        elseif ($plan.Kind -eq 'File') { [IO.File]::Move($plan.Path, $backup) }
        else {
            # Renaming a directory junction moves the link, without traversing
            # it. No recursive removal is used anywhere in this script.
            [IO.Directory]::Move($plan.Path, $backup)
        }
        $applied++
        $didApply = $true
        Write-Host "Archived legacy configuration: $($plan.Path)"
    }
    else { Write-Host "Would change: $($plan.Path) -- $($plan.Reason)" }
    $results.Add([pscustomobject]@{ Path = $plan.Path; Action = $plan.Kind; Reason = $plan.Reason; Applied = $didApply; Backup = $backup })
}
$mode = if ($Apply -and -not $WhatIfPreference) { 'Apply' } else { 'Preview' }
Write-Host "$mode complete: $($plans.Count) planned, $applied applied. Run native Gortex installation after cleanup, then start fresh agent sessions."
[pscustomobject]@{
    Mode = $mode
    Planned = $plans.Count
    Applied = $applied
    BackupDirectory = $(if ($applied -gt 0) { $backupDirectory } else { $null })
    Warnings = $notices.ToArray()
    Changes = $results.ToArray()
}
