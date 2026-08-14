<#
.SYNOPSIS
    Registers a Paseo-created git worktree with Gortex and waits for its index.

.DESCRIPTION
    Gortex resolves a repository's ignore list from layered sources. The repo
    entry in ~/.gortex/config.yaml is one of those layers, and it is read when
    the indexer starts walking. `gortex track` writes the global config BEFORE
    it notifies the daemon, and it leaves an already-present entry untouched.
    Writing the complete entry first therefore guarantees the very first index
    honours the workspace, project, and exclusions without leaving a
    .gortex.yaml artifact inside the worktree.

    Exclusions default to whatever the canonical checkout already declares, so
    the script works unchanged for repositories that need no exclusions.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Setup', 'Teardown', 'Rebuild', 'Status', 'Wait', 'Compact')]
    [string] $Action = 'Status',

    [string] $WorktreePath = $env:PASEO_WORKTREE_PATH,

    [string] $Workspace,

    [string] $Project,

    [string] $SourceCheckoutPath = $env:PASEO_SOURCE_CHECKOUT_PATH,

    [string] $GortexConfigPath = [IO.Path]::Combine($HOME, '.gortex', 'config.yaml'),

    [string] $BaseRepoName,

    [string[]] $ExcludePattern,

    [switch] $NoExclude,

    [string] $IndexTimeout = '30m',

    # Purging a large worktree's nodes and edges keeps the daemon busy for minutes,
    # and killing the client mid-purge is what strands the entry. The budget is
    # generous enough for a normal purge under load and only trips on a real hang.
    [string] $UntrackTimeout = '180s',

    [int] $HeartbeatSeconds = 10,

    # Compaction only.
    [string] $StorePath,

    [double] $MinimumReclaimGb = 1.0,

    [switch] $BackupStore,

    [switch] $CompactStore,

    [switch] $Force,

    [int] $PollSeconds = 2,

    [string] $LogDirectory = [IO.Path]::Combine($HOME, '.gortex', 'logs'),

    [switch] $NoLog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:startedAt = [DateTimeOffset]::UtcNow
$script:transcriptStarted = $false

# Paseo runs lifecycle commands without surfacing or persisting their output, so
# a failed setup or teardown is otherwise invisible after the fact. Every run
# leaves a transcript behind instead.
if (-not $NoLog) {
    try {
        if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
        }
        $logFile = Join-Path $LogDirectory ("worktree-{0}-{1}.log" -f $Action.ToLowerInvariant(), (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Start-Transcript -LiteralPath $logFile -Force | Out-Null
        $script:transcriptStarted = $true
        Write-Host "[gortex] Logging to $logFile"
    }
    catch {
        Write-Warning "Could not start a transcript: $($_.Exception.Message)"
    }
}

function Complete-Run {
    param([string] $Summary)

    $elapsed = [DateTimeOffset]::UtcNow - $script:startedAt
    Write-Host ("[gortex] {0} finished in {1}." -f $Summary, $elapsed.ToString('hh\:mm\:ss'))

    if ($script:transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}

# Retained so worktrees created by earlier revisions, which staged a temporary
# .gortex.yaml inside the worktree, are still cleaned up on teardown.
$temporaryConfigMarker = '# Managed temporarily by Manage-GortexWorktree.ps1'

function Resolve-GortexPath {
    $command = Get-Command gortex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }

    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\gortex\gortex.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        return $fallback
    }

    throw 'Gortex is not installed or is not available on PATH.'
}

function Resolve-TargetPath {
    param(
        [string] $Path,
        [switch] $AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = (Get-Location).Path
    }

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "Worktree path does not exist: $resolved"
    }

    return $resolved
}

function Test-LinkedWorktree {
    param([string] $Path)

    return Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Leaf
}

function Test-CanonicalCheckout {
    param([string] $Path)

    # A canonical checkout keeps .git as a directory; a linked worktree keeps it
    # as a file. Teardown guards on this rather than on Test-LinkedWorktree
    # because a worktree Git has already removed has no .git at all, and that
    # leftover still needs its Gortex tracking cleaned up.
    return Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container
}

function Test-SamePath {
    param(
        [string] $Left,
        [string] $Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }

    try {
        $normalizedLeft = [IO.Path]::GetFullPath($Left).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $normalizedRight = [IO.Path]::GetFullPath($Right).TrimEnd([IO.Path]::DirectorySeparatorChar)
        return $normalizedLeft -ieq $normalizedRight
    }
    catch {
        return $false
    }
}

function Get-EntryPropertyValue {
    param(
        $Entry,
        [Parameter(Mandatory)][string] $Name
    )

    if ($null -eq $Entry) {
        return $null
    }

    $property = $Entry.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-GitRepositoryName {
    param([string] $Path)

    $gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $gitCommand) {
        throw 'Git is not installed or is not available on PATH.'
    }

    $remoteUrl = (& $gitCommand.Source -C $Path remote get-url origin 2>$null | Out-String).Trim()
    $repoName = if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($remoteUrl)) {
        $normalizedUrl = $remoteUrl.TrimEnd([char[]]@('/', '\'))
        (($normalizedUrl -split '[/\\]+')[-1] -replace '\.git$', '')
    }
    else {
        $commonDirectory = (& $gitCommand.Source -C $Path rev-parse --git-common-dir 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commonDirectory)) {
            throw "Cannot derive the Git repository name from: $Path"
        }

        if (-not [IO.Path]::IsPathRooted($commonDirectory)) {
            $commonDirectory = Join-Path $Path $commonDirectory
        }
        $commonDirectory = [IO.Path]::GetFullPath($commonDirectory)
        $repoRoot = if ((Split-Path -Leaf $commonDirectory) -eq '.git') {
            Split-Path -Parent $commonDirectory
        }
        else {
            $commonDirectory
        }
        Split-Path -Leaf $repoRoot
    }

    $repoName = ($repoName -replace '[^A-Za-z0-9._-]', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($repoName)) {
        throw "Cannot derive the Git repository name from: $Path"
    }

    return $repoName
}

function Resolve-SourceCheckoutPath {
    param([string] $Path)

    if (-not [string]::IsNullOrWhiteSpace($SourceCheckoutPath)) {
        return [IO.Path]::GetFullPath($SourceCheckoutPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
    }

    $gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $gitCommand) {
        return ''
    }

    $commonDirectory = (& $gitCommand.Source -C $Path rev-parse --path-format=absolute --git-common-dir 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commonDirectory)) {
        return ''
    }

    $commonDirectory = [IO.Path]::GetFullPath($commonDirectory)
    if ((Split-Path -Leaf $commonDirectory) -eq '.git') {
        return (Split-Path -Parent $commonDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    }

    return $commonDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Get-GeneratedRepoName {
    param([string] $Path)

    $slug = Split-Path -Leaf $Path
    $slug = ($slug -replace '[^A-Za-z0-9._-]', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($slug)) {
        throw "Cannot derive a Gortex repository name from: $Path"
    }

    return "$BaseRepoName@$slug"
}

function Invoke-Gortex {
    param([Parameter(Mandatory)][string[]] $Arguments)

    & $script:gortexPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gortex $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Start-GortexProcess {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [string] $FilePath
    )

    if ([string]::IsNullOrWhiteSpace($FilePath)) {
        $FilePath = $script:gortexPath
    }

    # Output is redirected rather than inherited so the CLI's progress rendering
    # never reaches Paseo's pane, where its escape sequences suppress every line
    # the helper prints afterwards.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $Arguments) {
            $startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = (($Arguments | ForEach-Object { '"{0}"' -f ($_ -replace '"', '\"') }) -join ' ')
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)

    return [pscustomobject]@{
        Process = $process
        Stdout  = $process.StandardOutput.ReadToEndAsync()
        Stderr  = $process.StandardError.ReadToEndAsync()
        Command = "$([IO.Path]::GetFileNameWithoutExtension($FilePath)) $($Arguments -join ' ')"
    }
}

function Get-GortexProcessOutput {
    param($Handle)

    $text = ''
    foreach ($task in @($Handle.Stdout, $Handle.Stderr)) {
        try {
            if ($task.Wait(5000)) {
                $text += $task.Result
            }
        }
        catch {
        }
    }

    return ($text -replace "`r", '').Trim()
}

function Wait-GortexProcess {
    param(
        $Handle,
        [string] $State,
        [timespan] $Timeout
    )

    # A `daemon reload` scales with store size: 30s on a small store, but three
    # to five minutes once several worktrees are indexed. Blocking on it silently
    # makes a healthy setup look wedged - the pane's last line stays a stale index
    # heartbeat for minutes - so progress is reported on the same cadence and in
    # the same shape as the index wait.
    $started = [DateTimeOffset]::UtcNow
    $nextHeartbeat = $started.AddSeconds([Math]::Max(1, $HeartbeatSeconds))
    $deadline = $started.Add($Timeout)

    while (-not $Handle.Process.HasExited) {
        $now = [DateTimeOffset]::UtcNow

        if ($now -ge $nextHeartbeat) {
            Write-Host ("[gortex] state={0}; elapsed={1}; timeout={2}" -f $State, ($now - $started).ToString('hh\:mm\:ss'), $IndexTimeout)
            $nextHeartbeat = $now.AddSeconds([Math]::Max(1, $HeartbeatSeconds))
        }

        if ($now -ge $deadline) {
            # The process is deliberately left running. Killing a reload mid-flight
            # risks leaving the daemon holding a half-installed path set, and it
            # will complete on its own; the caller only needs to stop waiting.
            throw "$($Handle.Command) did not finish within $IndexTimeout. The daemon is still reloading; check 'gortex daemon status' before starting graph work."
        }

        Start-Sleep -Milliseconds 250
    }

    if ($Handle.Process.ExitCode -ne 0) {
        $output = Get-GortexProcessOutput $Handle
        throw "$($Handle.Command) failed with exit code $($Handle.Process.ExitCode).$(if ($output) { [Environment]::NewLine + $output })"
    }
}

function Invoke-GortexBounded {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][int] $TimeoutSeconds
    )

    # Teardown must never block forever. A daemon wedged on one repository stops
    # answering control requests, and an unbounded `gortex untrack` then holds
    # the worktree open until Paseo's own directory removal fails with EBUSY.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:gortexPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $Arguments) {
            $startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = (($Arguments | ForEach-Object { '"{0}"' -f ($_ -replace '"', '\"') }) -join ' ')
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)

    # Drain both pipes before waiting so a chatty command cannot deadlock on a
    # full buffer while we are counting down.
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) }
        catch { try { $process.Kill() } catch { } }

        return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = '' }
    }

    return [pscustomobject]@{
        TimedOut = $false
        ExitCode = $process.ExitCode
        Output   = (@($stdout.Result, $stderr.Result) -join [Environment]::NewLine).Trim()
    }
}

function Get-GortexWorkspaceEntries {
    $json = (& $script:gortexPath workspace list --json | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "gortex workspace list --json failed with exit code $LASTEXITCODE"
    }
    if ([string]::IsNullOrWhiteSpace($json)) {
        return @()
    }

    try {
        # Windows PowerShell 5.1 emits a JSON array as one object rather than
        # enumerating it, so @(pipeline) would yield a single nested array.
        # Assigning first and wrapping after behaves identically on 5.1 and 7+.
        $converted = ConvertFrom-Json -InputObject $json
        return @($converted)
    }
    catch {
        throw "Gortex did not return valid workspace JSON: $json"
    }
}

function Get-TrackedEntry {
    param([string] $Path)

    return Get-GortexWorkspaceEntries | Where-Object {
        Test-SamePath (Get-EntryPropertyValue $_ 'path') $Path
    } | Select-Object -First 1
}

function Test-GortexDaemon {
    & $script:gortexPath daemon status 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
}

function Sync-GortexDaemon {
    param(
        [bool] $ConfigChanged,
        [switch] $Async
    )

    if (-not (Test-GortexDaemon)) {
        Write-Host '[gortex] Daemon did not answer a status probe; making sure it is running.'

        $start = Start-GortexProcess @('daemon', 'start', '--detach')
        $null = $start.Process.WaitForExit(120000)
        $startOutput = Get-GortexProcessOutput $start
        $startExit = if ($start.Process.HasExited) { $start.Process.ExitCode } else { -1 }
        $start.Process.Dispose()

        # `gortex daemon status` has a 30 second budget that a daemon busy draining
        # a large index routinely exceeds, so a failed probe does not prove the
        # daemon is down. Refusing to start because one is already running is the
        # authoritative answer, and it means there is nothing left to do here.
        if ($startExit -ne 0) {
            if ($startOutput -notmatch 'already running') {
                throw "gortex daemon start --detach failed with exit code $startExit.$([Environment]::NewLine + $startOutput)"
            }

            Write-Host '[gortex] Daemon is already running but too busy to answer; continuing.'
        }
        else {
            $deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
            while (-not (Test-GortexDaemon)) {
                if ([DateTimeOffset]::UtcNow -ge $deadline) {
                    throw 'Started the Gortex daemon but it did not become reachable within 120 seconds.'
                }
                Start-Sleep -Seconds 2
            }
            Write-Host '[gortex] Daemon is ready.'
        }

        if (-not $ConfigChanged) {
            return
        }
    }

    if (-not $ConfigChanged) {
        return
    }

    Write-Host '[gortex] Reloading daemon so the index honours the durable policy.'

    # Reload is what picks up the new config entry and starts the first index, and
    # it does not return until that index finishes. Running it in the foreground
    # would swallow the entire 15-20 minute walk with no output, so the caller
    # polls readiness instead and reports progress while this runs.
    if ($Async) {
        return Start-GortexProcess @('daemon', 'reload')
    }

    Invoke-Gortex @('daemon', 'reload')
    return
}

function Test-GortexRepositoryResolvable {
    param([string] $Path)

    # `repos --json` reads the store and reports a freshly tracked worktree as
    # indexed while the daemon's path resolver still rejects the directory, so
    # readiness has to be confirmed the way an agent actually experiences it: by
    # resolving the cwd through the same MCP surface the graph tools use.
    $previous = Get-Location
    try {
        Set-Location -LiteralPath $Path -ErrorAction Stop
        $output = & $script:gortexPath call workspace --arg operation=info 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        return ($output -notmatch 'does not track')
    }
    catch {
        return $false
    }
    finally {
        Set-Location $previous
    }
}

function Get-GortexRepositories {
    $json = (& $script:gortexPath repos --json | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "gortex repos --json failed with exit code $LASTEXITCODE"
    }
    if ([string]::IsNullOrWhiteSpace($json)) {
        return @()
    }

    try {
        $converted = ConvertFrom-Json -InputObject $json
        return @($converted)
    }
    catch {
        throw "Gortex did not return valid repository JSON: $json"
    }
}

function Get-GortexRepository {
    param([string] $Path)

    return Get-GortexRepositories | Where-Object {
        Test-SamePath (Get-EntryPropertyValue $_ 'path') $Path
    } | Select-Object -First 1
}

function Get-GortexIndexState {
    param($Repository)

    if ($null -eq $Repository) {
        return 'Untracked'
    }
    if ((Get-EntryPropertyValue $Repository 'indexed') -ne $true) {
        return 'PendingOrIndexing'
    }
    if ((Get-EntryPropertyValue $Repository 'stale') -eq $true) {
        return 'Stale'
    }

    return 'Ready'
}

function ConvertFrom-YamlScalar {
    param([string] $Value)

    if ($null -eq $Value) {
        return ''
    }

    $trimmed = $Value.Trim()
    if ($trimmed.Length -ge 2 -and $trimmed.StartsWith("'") -and $trimmed.EndsWith("'")) {
        return $trimmed.Substring(1, $trimmed.Length - 2).Replace("''", "'")
    }
    if ($trimmed.Length -ge 2 -and $trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) {
        return $trimmed.Substring(1, $trimmed.Length - 2)
    }

    return $trimmed
}

function ConvertTo-YamlScalar {
    param([string] $Value)

    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-GlobalRepoEntries {
    param([string] $ConfigPath)

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return @()
    }

    $lines = @(Get-Content -LiteralPath $ConfigPath)
    $entries = New-Object System.Collections.Generic.List[object]
    $inRepos = $false
    $current = $null
    $excludeKey = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        if ($line -match '^\S') {
            if ($null -ne $current) {
                $entries.Add($current)
                $current = $null
            }
            $inRepos = ($line -match '^repos:\s*$')
            $excludeKey = $false
            continue
        }
        if (-not $inRepos -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        if ($line -match '^\s*-\s+path:\s*(.+?)\s*$') {
            if ($null -ne $current) {
                $entries.Add($current)
            }
            $current = [pscustomobject]@{
                Path      = ConvertFrom-YamlScalar $Matches[1]
                Name      = ''
                Workspace = ''
                Project   = ''
                Exclude   = New-Object System.Collections.Generic.List[string]
            }
            $excludeKey = $false
            continue
        }
        if ($null -eq $current) {
            continue
        }

        if ($excludeKey -and $line -match '^\s*-\s+(.+?)\s*$') {
            $current.Exclude.Add((ConvertFrom-YamlScalar $Matches[1]))
            continue
        }

        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$') {
            $key = $Matches[1]
            $value = $Matches[2]
            $excludeKey = ($key -eq 'exclude' -and [string]::IsNullOrWhiteSpace($value))
            switch ($key) {
                'name' { $current.Name = ConvertFrom-YamlScalar $value }
                'workspace' { $current.Workspace = ConvertFrom-YamlScalar $value }
                'project' { $current.Project = ConvertFrom-YamlScalar $value }
            }
        }
    }

    if ($null -ne $current) {
        $entries.Add($current)
    }

    foreach ($entry in $entries) {
        $entry.Exclude = [string[]] $entry.Exclude.ToArray()
    }

    return $entries.ToArray()
}

function Get-GlobalRepoEntry {
    param(
        [string] $ConfigPath,
        [string] $Path
    )

    return Get-GlobalRepoEntries $ConfigPath | Where-Object { Test-SamePath $_.Path $Path } | Select-Object -First 1
}

function Resolve-ExcludePattern {
    param(
        [string] $ConfigPath,
        [string] $SourcePath
    )

    if ($NoExclude) {
        return @()
    }
    if ($PSBoundParameters.ContainsKey('ExcludePattern') -or $null -ne $ExcludePattern) {
        return @($ExcludePattern | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    $sourceEntry = Get-GlobalRepoEntry -ConfigPath $ConfigPath -Path $SourcePath
    if ($null -ne $sourceEntry) {
        return @($sourceEntry.Exclude)
    }

    return @()
}

function Resolve-GortexWorkspace {
    param(
        [string] $ConfigPath,
        [string] $SourcePath
    )

    if (-not [string]::IsNullOrWhiteSpace($Workspace)) {
        return $Workspace.Trim()
    }

    $sourceEntry = Get-GlobalRepoEntry -ConfigPath $ConfigPath -Path $SourcePath
    if ($null -ne $sourceEntry -and -not [string]::IsNullOrWhiteSpace($sourceEntry.Workspace)) {
        return $sourceEntry.Workspace
    }

    $configured = @(
        Get-GlobalRepoEntries $ConfigPath |
            ForEach-Object { $_.Workspace } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique
    )
    if ($configured.Count -eq 1) {
        return $configured[0]
    }
    if ($configured.Count -eq 0) {
        throw 'No Gortex workspace is configured. Assign one to the source checkout or pass -Workspace.'
    }

    throw "The source checkout has no workspace assignment. Pass -Workspace. Available: $($configured -join ', ')"
}

function Get-ConfigIndent {
    param([string] $ConfigPath)

    $indent = [pscustomobject]@{ Item = '    '; Key = '      '; List = '        ' }
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $indent
    }

    foreach ($line in Get-Content -LiteralPath $ConfigPath) {
        if ($line -match '^(\s*)-\s+path:') {
            $itemIndent = $Matches[1]
            $indent.Item = $itemIndent
            $indent.Key = $itemIndent + '  '
            $indent.List = $itemIndent + '    '
            break
        }
    }

    return $indent
}

function New-GlobalRepoEntryText {
    param(
        [string] $ConfigPath,
        [string] $Path,
        [string] $RepoName,
        [string] $WorkspaceName,
        [string] $ProjectName,
        [string[]] $Exclude
    )

    $indent = Get-ConfigIndent $ConfigPath
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("$($indent.Item)- path: $(ConvertTo-YamlScalar $Path)")
    $lines.Add("$($indent.Key)name: $(ConvertTo-YamlScalar $RepoName)")
    if (@($Exclude).Count -gt 0) {
        $lines.Add("$($indent.Key)exclude:")
        foreach ($pattern in $Exclude) {
            $lines.Add("$($indent.List)- $(ConvertTo-YamlScalar $pattern)")
        }
    }
    $lines.Add("$($indent.Key)workspace: $(ConvertTo-YamlScalar $WorkspaceName)")
    $lines.Add("$($indent.Key)project: $(ConvertTo-YamlScalar $ProjectName)")

    return $lines.ToArray()
}

function Add-GlobalRepoEntry {
    param(
        [string] $ConfigPath,
        [string] $Path,
        [string] $RepoName,
        [string] $WorkspaceName,
        [string] $ProjectName,
        [string[]] $Exclude
    )

    $block = New-GlobalRepoEntryText -ConfigPath $ConfigPath -Path $Path -RepoName $RepoName `
        -WorkspaceName $WorkspaceName -ProjectName $ProjectName -Exclude $Exclude

    $directory = Split-Path -Parent $ConfigPath
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $existing = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { @(Get-Content -LiteralPath $ConfigPath) } else { @() }
    $output = New-Object System.Collections.Generic.List[string]
    $inserted = $false

    foreach ($line in $existing) {
        $output.Add($line)
        if (-not $inserted -and $line -match '^repos:\s*$') {
            foreach ($blockLine in $block) {
                $output.Add($blockLine)
            }
            $inserted = $true
        }
    }

    if (-not $inserted) {
        if ($output.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($output[$output.Count - 1])) {
            $output.Add('')
        }
        $output.Add('repos:')
        foreach ($blockLine in $block) {
            $output.Add($blockLine)
        }
    }

    $backup = "$ConfigPath.bak-worktree-$(Get-Date -Format yyyyMMddHHmmss)"
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    }

    $content = ($output -join [Environment]::NewLine) + [Environment]::NewLine
    [IO.File]::WriteAllText($ConfigPath, $content, [Text.UTF8Encoding]::new($false))
}

function Remove-GlobalRepoEntry {
    param(
        [string] $ConfigPath,
        [string] $Path
    )

    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        return $false
    }

    $output = New-Object System.Collections.Generic.List[string]
    $inRepos = $false
    $skipping = $false
    $removed = $false

    foreach ($line in @(Get-Content -LiteralPath $ConfigPath)) {
        if ($line -match '^\S') {
            $inRepos = ($line -match '^repos:\s*$')
            $skipping = $false
            $output.Add($line)
            continue
        }

        if ($inRepos -and $line -match '^\s*-\s+path:\s*(.+?)\s*$') {
            $skipping = Test-SamePath (ConvertFrom-YamlScalar $Matches[1]) $Path
            if ($skipping) {
                $removed = $true
                continue
            }
        }

        if (-not $skipping) {
            $output.Add($line)
        }
    }

    if (-not $removed) {
        return $false
    }

    Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-worktree-$(Get-Date -Format yyyyMMddHHmmss)" -Force
    $content = ($output -join [Environment]::NewLine) + [Environment]::NewLine
    [IO.File]::WriteAllText($ConfigPath, $content, [Text.UTF8Encoding]::new($false))

    return $true
}

function Repair-GlobalRepoEntry {
    param(
        $Entry,
        [string] $RepoName,
        [string] $WorkspaceName,
        [string] $ProjectName,
        [string[]] $Exclude
    )

    $repaired = $false

    if ($Entry.Workspace -ne $WorkspaceName -or $Entry.Project -ne $ProjectName) {
        Invoke-Gortex @('workspace', 'set', $RepoName, $WorkspaceName, $ProjectName, '--global')
        $repaired = $true
    }

    $missing = @($Exclude | Where-Object { $Entry.Exclude -notcontains $_ })
    foreach ($pattern in $missing) {
        Invoke-Gortex @('config', 'exclude', 'add', $pattern, '--repo', $RepoName)
        $repaired = $true
    }

    return $repaired
}

function Set-GortexRepoEntry {
    param(
        [string] $ConfigPath,
        [string] $Path,
        [string] $RepoName,
        [string] $WorkspaceName,
        [string] $ProjectName,
        [string[]] $Exclude
    )

    $entry = Get-GlobalRepoEntry -ConfigPath $ConfigPath -Path $Path
    if ($null -eq $entry) {
        Write-Host "[gortex] Writing durable policy before registration: $RepoName"
        Add-GlobalRepoEntry -ConfigPath $ConfigPath -Path $Path -RepoName $RepoName `
            -WorkspaceName $WorkspaceName -ProjectName $ProjectName -Exclude $Exclude
        return $true
    }

    if ([string]::IsNullOrWhiteSpace($entry.Name)) {
        throw "The existing Gortex entry for $Path has no name; cannot repair it safely. Remove it or pass -BaseRepoName."
    }

    Write-Host "[gortex] Verifying durable policy: $($entry.Name)"
    return Repair-GlobalRepoEntry -Entry $entry -RepoName $entry.Name `
        -WorkspaceName $WorkspaceName -ProjectName $ProjectName -Exclude $Exclude
}

function Test-GortexRepoEntry {
    param(
        [string] $ConfigPath,
        [string] $Path,
        [string] $WorkspaceName,
        [string] $ProjectName,
        [string[]] $Exclude
    )

    $entry = Get-GlobalRepoEntry -ConfigPath $ConfigPath -Path $Path
    if ($null -eq $entry) {
        throw "Gortex global config has no entry for: $Path"
    }

    $problems = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($entry.Name)) { $problems.Add('name is missing') }
    if ($entry.Workspace -ne $WorkspaceName) { $problems.Add("workspace is '$($entry.Workspace)' but expected '$WorkspaceName'") }
    if ($entry.Project -ne $ProjectName) { $problems.Add("project is '$($entry.Project)' but expected '$ProjectName'") }
    $missing = @($Exclude | Where-Object { $entry.Exclude -notcontains $_ })
    if ($missing.Count -gt 0) { $problems.Add("missing exclusions: $($missing -join ', ')") }

    if ($problems.Count -gt 0) {
        throw "Durable Gortex policy is incomplete for $Path -- $($problems -join '; ')"
    }
}

function ConvertTo-IndexTimeout {
    param([string] $Value)

    $segments = [regex]::Matches($Value, '(?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)')
    if ($segments.Count -eq 0 -or (($segments | ForEach-Object Value) -join '') -ne $Value) {
        throw "Invalid index timeout: $Value. Use a duration such as 30m, 90s, or 1h30m."
    }

    $milliseconds = 0.0
    foreach ($segment in $segments) {
        $amount = [double]::Parse($segment.Groups['amount'].Value, [Globalization.CultureInfo]::InvariantCulture)
        $multiplier = switch ($segment.Groups['unit'].Value) {
            'ms' { 1 }
            's' { 1000 }
            'm' { 60000 }
            'h' { 3600000 }
        }
        $milliseconds += $amount * $multiplier
    }

    if ($milliseconds -le 0) {
        throw 'Index timeout must be greater than zero.'
    }

    return [TimeSpan]::FromMilliseconds($milliseconds)
}

function Wait-GortexRepositoryIndexed {
    param(
        [string] $Path,
        [string] $RepoName,
        $Jobs = @()
    )

    $pending = @($Jobs | Where-Object { $null -ne $_ })
    $started = [DateTimeOffset]::UtcNow
    $deadline = $started.Add((ConvertTo-IndexTimeout $IndexTimeout))
    $nextHeartbeat = $started

    while ($true) {
        $repository = Get-GortexRepository $Path
        $now = [DateTimeOffset]::UtcNow
        $elapsed = $now - $started

        if ((Get-GortexIndexState $repository) -eq 'Ready') {
            Write-Host "[gortex] Index ready after $($elapsed.ToString('hh\:mm\:ss')): $RepoName"
            return
        }

        # A registration or reload that dies leaves the repository permanently
        # unindexed, so its failure is surfaced immediately rather than after the
        # full timeout has elapsed.
        foreach ($job in $pending) {
            if ($job.Process.HasExited -and $job.Process.ExitCode -ne 0) {
                $output = Get-GortexProcessOutput $job
                throw "$($job.Command) failed with exit code $($job.Process.ExitCode).$(if ($output) { [Environment]::NewLine + $output })"
            }
        }

        if ($now -ge $nextHeartbeat) {
            $branch = [string] (Get-EntryPropertyValue $repository 'branch')
            $headCommit = [string] (Get-EntryPropertyValue $repository 'head_commit')
            if ($headCommit.Length -gt 12) {
                $headCommit = $headCommit.Substring(0, 12)
            }
            Write-Host ("[gortex] state={0}; elapsed={1}; timeout={2}; branch={3}; head={4}" -f `
                (Get-GortexIndexState $repository), $elapsed.ToString('hh\:mm\:ss'), $IndexTimeout, $branch, $headCommit)
            $nextHeartbeat = $now.AddSeconds([Math]::Max(1, $HeartbeatSeconds))
        }

        $remaining = $deadline - $now
        if ($remaining -le [TimeSpan]::Zero) {
            throw "Timed out after $IndexTimeout waiting for Gortex to index $RepoName ($Path)."
        }

        $sleep = [Math]::Min([Math]::Max(1, $PollSeconds) * 1000, [Math]::Max(1, [Math]::Ceiling($remaining.TotalMilliseconds)))
        Start-Sleep -Milliseconds $sleep
    }
}

function Enter-GortexIndexLock {
    param([string] $Name)

    $mutexName = 'Local\GortexIndex-' + ($Name -replace '[^A-Za-z0-9._-]', '-')
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    $started = [DateTimeOffset]::UtcNow
    $waitSlice = [TimeSpan]::FromSeconds([Math]::Max(1, $HeartbeatSeconds))

    while ($true) {
        $acquired = $false
        try {
            $acquired = $mutex.WaitOne($waitSlice)
        }
        catch [System.Threading.AbandonedMutexException] {
            # The previous holder died; the lock is ours.
            $acquired = $true
        }

        if ($acquired) {
            return $mutex
        }

        Write-Host ("[gortex] Another worktree of {0} is indexing; queued for {1}." -f `
            $Name, ([DateTimeOffset]::UtcNow - $started).ToString('hh\:mm\:ss'))
    }
}

function Exit-GortexIndexLock {
    param($Mutex)

    if ($null -eq $Mutex) {
        return
    }

    try { $Mutex.ReleaseMutex() } catch { }
    $Mutex.Dispose()
}

function Remove-TemporaryConfig {
    param([string] $Path)

    $configPath = Join-Path $Path '.gortex.yaml'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return
    }

    $firstLine = Get-Content -LiteralPath $configPath -TotalCount 1
    if ($firstLine -eq $temporaryConfigMarker) {
        Write-Host '[gortex] Removing helper-owned .gortex.yaml.'
        Remove-Item -LiteralPath $configPath -Force
    }
}

function Initialize-GortexWorktree {
    param([string] $Path)

    if (-not (Test-LinkedWorktree $Path)) {
        throw "Setup requires a linked Git worktree: $Path"
    }

    $entry = Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path
    $repoName = if ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace($entry.Name)) {
        $entry.Name
    }
    else {
        Get-GeneratedRepoName $Path
    }
    $projectName = if ([string]::IsNullOrWhiteSpace($Project)) { $repoName } else { $Project.Trim() }

    Write-Host "[gortex] Worktree: $Path"
    Write-Host "[gortex] Repository: $repoName; workspace: $script:resolvedWorkspace; exclusions: $(@($script:resolvedExclude).Count)"

    # Policy first: `gortex track` writes the global config before it contacts
    # the daemon and never rewrites an entry that already exists, so the first
    # index walk sees these exclusions.
    $changed = Set-GortexRepoEntry -ConfigPath $GortexConfigPath -Path $Path -RepoName $repoName `
        -WorkspaceName $script:resolvedWorkspace -ProjectName $projectName -Exclude $script:resolvedExclude
    Test-GortexRepoEntry -ConfigPath $GortexConfigPath -Path $Path `
        -WorkspaceName $script:resolvedWorkspace -ProjectName $projectName -Exclude $script:resolvedExclude
    Write-Host '[gortex] Durable workspace, project, and exclusion policy verified.'

    $reload = Sync-GortexDaemon -ConfigChanged $changed -Async

    # Only one full index of a given base repository at a time. A large repo
    # takes 15-20 minutes and parallel walks starve each other.
    $indexLock = Enter-GortexIndexLock $BaseRepoName
    try {
        # Idempotent: track leaves an existing entry untouched and still tells
        # the daemon to treat this path as a worktree of the parent checkout.
        # It is started in the background for the same reason as the reload.
        Write-Host "[gortex] Registering worktree: $repoName"
        $track = Start-GortexProcess @('track', $Path, '--as-worktree', '--name', $repoName)

        $jobs = @($reload, $track) | Where-Object { $null -ne $_ }

        Write-Host "[gortex] Waiting up to $IndexTimeout for this repository only."
        try {
            Wait-GortexRepositoryIndexed -Path $Path -RepoName $repoName -Jobs $jobs

            # A short shared grace period catches a call that failed outright. These
            # clients are only waiting on daemon-side work that has already produced
            # a queryable index, so a straggler is left to exit on its own instead of
            # being killed part-way through the daemon's final drain.
            $graceDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
            foreach ($job in $jobs) {
                while (-not $job.Process.HasExited -and [DateTimeOffset]::UtcNow -lt $graceDeadline) {
                    Start-Sleep -Milliseconds 250
                }
                if ($job.Process.HasExited -and $job.Process.ExitCode -ne 0) {
                    $jobOutput = Get-GortexProcessOutput $job
                    Write-Warning "$($job.Command) exited with code $($job.Process.ExitCode) after the index completed.$(if ($jobOutput) { [Environment]::NewLine + $jobOutput })"
                }
            }
        }
        finally {
            foreach ($job in $jobs) {
                $job.Process.Dispose()
            }
        }

        # Legacy artifact from earlier revisions; the durable entry supersedes it.
        # Removed only after the walk, because deleting it mid-index would change
        # the policy source the daemon is actively reading.
        Remove-TemporaryConfig $Path

        # A freshly tracked worktree is indexed but not yet resolvable: the daemon
        # answers `repos --json` for it from the store while its path resolver
        # still rejects the directory, so every graph call returns "repository not
        # tracked" until it is reloaded. This runs before setup reports success so
        # an agent starting the moment setup finishes finds a usable graph.
        Write-Host '[gortex] Reloading daemon so it can resolve the new worktree; this can take several minutes on a large store.'
        Wait-GortexProcess -Handle (Start-GortexProcess @('daemon', 'reload')) -State 'Reloading' -Timeout (ConvertTo-IndexTimeout $IndexTimeout)

        if (-not (Test-GortexRepositoryResolvable $Path)) {
            Write-Warning "Gortex indexed $repoName but still cannot resolve $Path. Graph calls from that directory will fail until the daemon is reloaded again."
        }
    }
    finally {
        Exit-GortexIndexLock $indexLock
    }

    Write-Output "Gortex worktree ready: $repoName ($Path)"
}

function Remove-GortexWorktree {
    param([string] $Path)

    if (Test-CanonicalCheckout $Path) {
        throw "Refusing to remove Gortex tracking for the canonical checkout: $Path"
    }

    Remove-TemporaryConfig $Path

    $entry = Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path
    if ($null -eq $entry) {
        Write-Output "Gortex worktree is not tracked: $Path"
        return
    }

    $repoName = if ([string]::IsNullOrWhiteSpace($entry.Name)) { $Path } else { $entry.Name }
    $timeoutSeconds = [int] (ConvertTo-IndexTimeout $UntrackTimeout).TotalSeconds
    Write-Host "[gortex] Untracking worktree: $repoName (timeout ${timeoutSeconds}s)"

    $untrack = Invoke-GortexBounded -Arguments @('untrack', $Path) -TimeoutSeconds $timeoutSeconds

    if ($untrack.TimedOut) {
        Write-Warning "gortex untrack exceeded ${timeoutSeconds}s; the daemon is not answering. Removing the durable entry directly."
        if (Remove-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path) {
            Write-Host '[gortex] Removed the worktree entry from the global config.'
        }
    }
    elseif ($untrack.ExitCode -ne 0) {
        throw "gortex untrack failed with exit code $($untrack.ExitCode). $($untrack.Output)"
    }
    elseif ($null -ne (Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path)) {
        # Belt and braces: untrack reported success but left the entry behind.
        if (Remove-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path) {
            Write-Host '[gortex] Removed the worktree entry left behind by untrack.'
        }
    }

    # Reload so the daemon drops its file watcher before Paseo deletes the
    # directory. Without this the removal races the watcher and fails with
    # EBUSY, stranding an empty worktree on disk.
    Write-Host '[gortex] Reloading daemon so it releases the worktree directory.'
    $reload = Invoke-GortexBounded -Arguments @('daemon', 'reload') -TimeoutSeconds $timeoutSeconds
    if ($reload.TimedOut) {
        Write-Warning 'gortex daemon reload did not finish; the daemon may still hold the worktree directory.'
    }

    Write-Output "Gortex worktree removed: $repoName ($Path)"

    Invoke-GortexStoreMaintenance
}

function Wait-GortexWorktreeReady {
    param([string] $Path)

    $entry = Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $Path
    $repoName = if ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace($entry.Name)) { $entry.Name } else { Split-Path -Leaf $Path }
    if ($null -eq (Get-GortexRepository $Path)) {
        throw "Gortex is not tracking $Path. Run the Setup action first."
    }
    Sync-GortexDaemon -ConfigChanged $false
    Write-Host "[gortex] Waiting up to $IndexTimeout for $repoName to become queryable."
    Wait-GortexRepositoryIndexed $Path $repoName
    Write-Output "Gortex index ready: $repoName ($Path)"
}

function Read-BigEndianValue {
    param(
        [Parameter(Mandatory)][byte[]] $Bytes,
        [Parameter(Mandatory)][int] $Offset,
        [Parameter(Mandatory)][int] $Length
    )

    $value = 0L
    for ($i = 0; $i -lt $Length; $i++) {
        $value = ($value -shl 8) -bor $Bytes[$Offset + $i]
    }

    return $value
}

function Get-GortexStorePath {
    if (-not [string]::IsNullOrWhiteSpace($StorePath)) {
        return (Resolve-Path -LiteralPath $StorePath).Path
    }

    return [IO.Path]::Combine($HOME, '.gortex', 'store', 'store.sqlite')
}

function Get-GortexStoreReport {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Gortex store not found: $Path"
    }

    # The free-page count lives in the SQLite header, so the reclaimable total can
    # be measured without a SQLite library and without opening the database the
    # daemon is actively writing to.
    $header = New-Object byte[] 100
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $read = $stream.Read($header, 0, 100)
    }
    finally {
        $stream.Dispose()
    }

    if ($read -lt 100 -or [Text.Encoding]::ASCII.GetString($header, 0, 15) -ne 'SQLite format 3') {
        throw "Not a SQLite database: $Path"
    }

    $pageSize = Read-BigEndianValue -Bytes $header -Offset 16 -Length 2
    if ($pageSize -eq 1) {
        $pageSize = 65536
    }

    $freePages = Read-BigEndianValue -Bytes $header -Offset 36 -Length 4
    $totalBytes = (Get-Item -LiteralPath $Path).Length
    $totalPages = [math]::Floor($totalBytes / $pageSize)

    return [pscustomobject]@{
        Path        = $Path
        TotalBytes  = $totalBytes
        FreeBytes   = ($freePages * $pageSize)
        LiveBytes   = (($totalPages - $freePages) * $pageSize)
        FreePercent = if ($totalPages -gt 0) { [math]::Round((100 * $freePages / $totalPages), 1) } else { 0 }
    }
}

function Format-Gb {
    param([double] $Bytes)

    return ('{0:N2} GB' -f ($Bytes / 1GB))
}

function Resolve-Sqlite3Path {
    $command = Get-Command 'sqlite3' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }

    # winget publishes sqlite3 either as a Links shim or, as of the current
    # package, only inside its Packages directory. A freshly installed shell has
    # not picked up the PATH change either, so both layouts are probed directly.
    $roots = @(
        [IO.Path]::Combine($env:LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
        [IO.Path]::Combine($env:LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    )

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }

        $found = Get-ChildItem -LiteralPath $root -Filter 'sqlite3.exe' -Recurse -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $found) {
            return $found.FullName
        }
    }

    return $null
}

function Wait-GortexStoreReleased {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][timespan] $Timeout
    )

    $started = [DateTimeOffset]::UtcNow
    $deadline = $started.Add($Timeout)
    $nextHeartbeat = $started.AddSeconds([Math]::Max(1, $HeartbeatSeconds))

    while ($true) {
        # An exclusive open is the only reliable signal that the daemon has let go;
        # the process list lies because `gortex mcp` clients linger without holding
        # the store, and a stale -wal file can outlive the writer.
        try {
            $probe = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $probe.Dispose()
            return
        }
        catch [IO.IOException] {
        }

        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $deadline) {
            throw "The Gortex store is still locked after $($Timeout.ToString('hh\:mm\:ss')). Stop every gortex process before compacting."
        }

        if ($now -ge $nextHeartbeat) {
            Write-Host ("[gortex] state=WaitingForStoreLock; elapsed={0}" -f ($now - $started).ToString('hh\:mm\:ss'))
            $nextHeartbeat = $now.AddSeconds([Math]::Max(1, $HeartbeatSeconds))
        }

        Start-Sleep -Milliseconds 500
    }
}

function Get-GortexStoreReportSafe {
    try {
        return Get-GortexStoreReport -Path (Get-GortexStorePath)
    }
    catch {
        return $null
    }
}

function Get-GortexStoreHealth {
    param($Report)

    # One predicate backs both the Status verdict and the teardown advisory so the
    # two can never disagree about whether compaction is worth doing.
    if ($null -eq $Report) {
        return 'Unknown'
    }
    if (($Report.FreeBytes / 1GB) -ge $MinimumReclaimGb) {
        return 'CompactionRecommended'
    }

    return 'Healthy'
}

function Invoke-GortexStoreMaintenance {
    # Untracking is what creates the free pages, so teardown is the one moment
    # when compaction is both worthwhile and safe: the worktree's agent has
    # finished and nothing is waiting on the daemon to hand over a fresh index.
    # Setup is the opposite - it exists to give a launching agent a live daemon,
    # and its own index would trip the compaction guard anyway.
    $report = Get-GortexStoreReportSafe
    if ((Get-GortexStoreHealth $report) -ne 'CompactionRecommended') {
        return
    }

    if (-not $CompactStore) {
        Write-Host ("[gortex] Store is {0} with {1} reclaimable ({2}%). Run -Action Compact, or pass -CompactStore on teardown, to reclaim it." -f `
            (Format-Gb $report.TotalBytes), (Format-Gb $report.FreeBytes), $report.FreePercent)
        return
    }

    try {
        Invoke-GortexStoreCompaction
    }
    catch {
        # The worktree is already gone; maintenance must never turn a successful
        # teardown into a failure Paseo reports as a broken lifecycle hook.
        Write-Warning "Store compaction skipped: $($_.Exception.Message)"
    }
}

function Invoke-GortexStoreCompaction {
    $script:gortexPath = Resolve-GortexPath
    $store = Get-GortexStorePath
    $before = Get-GortexStoreReport -Path $store

    Write-Host "[gortex] Store: $store"
    Write-Host ("[gortex] Before: total={0}; live={1}; reclaimable={2} ({3}%)" -f `
        (Format-Gb $before.TotalBytes), (Format-Gb $before.LiveBytes), (Format-Gb $before.FreeBytes), $before.FreePercent)

    if (($before.FreeBytes / 1GB) -lt $MinimumReclaimGb -and -not $Force) {
        Write-Host ("[gortex] Reclaimable space is under the {0:N2} GB threshold; nothing to do." -f $MinimumReclaimGb)
        return
    }

    # Vacuuming aborts whatever the daemon is doing, and a half-written index is
    # far more expensive than the reclaimed space.
    $busy = @(Get-GortexRepositories | Where-Object { (Get-GortexIndexState $_) -eq 'PendingOrIndexing' })
    if ($busy.Count -gt 0 -and -not $Force) {
        $names = ($busy | ForEach-Object { Get-EntryPropertyValue $_ 'name' }) -join ', '
        throw "Refusing to compact while Gortex is indexing: $names. Wait for the index to finish, or pass -Force."
    }

    $sqlite = Resolve-Sqlite3Path
    if ($null -eq $sqlite) {
        throw "sqlite3 was not found on PATH. Install it with: winget install --id SQLite.SQLite --exact"
    }

    # VACUUM builds a complete replacement alongside the original, so the live
    # bytes are needed twice over before the old file is released.
    $required = ($before.LiveBytes * 2.2) + $(if ($BackupStore) { $before.TotalBytes } else { 0 })
    $free = (Get-PSDrive ([IO.Path]::GetPathRoot($store).TrimEnd('\', ':'))).Free
    if ($free -lt $required) {
        throw "Compaction needs about $(Format-Gb $required) free on $([IO.Path]::GetPathRoot($store)) but only $(Format-Gb $free) is available."
    }

    $lockTimeout = ConvertTo-IndexTimeout $UntrackTimeout

    Write-Host '[gortex] Stopping the daemon so the store closes cleanly.'
    $stop = Invoke-GortexBounded -Arguments @('daemon', 'stop') -TimeoutSeconds ([int]$lockTimeout.TotalSeconds)
    if ($stop.TimedOut) {
        throw 'gortex daemon stop did not return. Compaction aborted; the store was not modified.'
    }
    if ($stop.ExitCode -ne 0) {
        Write-Host "[gortex] daemon stop exited with $($stop.ExitCode); continuing only if the store lock clears."
    }

    Write-Host '[gortex] Waiting for the store lock to clear.'
    Wait-GortexStoreReleased -Path $store -Timeout $lockTimeout

    if ($BackupStore) {
        $backup = "$store.bak-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
        Write-Host "[gortex] Backing up to $backup"
        Copy-Item -LiteralPath $store -Destination $backup -Force
    }

    try {
        Write-Host '[gortex] Vacuuming; this rewrites the store and can take several minutes.'
        Wait-GortexProcess -Handle (Start-GortexProcess -FilePath $sqlite -Arguments @($store, 'VACUUM;')) `
            -State 'Vacuuming' -Timeout (ConvertTo-IndexTimeout $IndexTimeout)

        Write-Host '[gortex] Verifying store integrity.'
        $check = (& $sqlite $store 'PRAGMA integrity_check;' | Out-String).Trim()
        if ($check -ne 'ok') {
            throw "SQLite integrity_check failed after compaction: $check"
        }
    }
    finally {
        # The daemon must come back even if the vacuum failed, otherwise every
        # agent on this machine is left without a graph.
        #
        # --detach is required: without it the daemon runs in the foreground as
        # a child of this script, so this call never returns and closing the
        # terminal takes the daemon down with it.
        Write-Host '[gortex] Starting the daemon.'
        Invoke-Gortex @('daemon', 'start', '--detach')
    }

    $after = Get-GortexStoreReport -Path $store
    Write-Host ("[gortex] After: total={0}; live={1}; reclaimable={2} ({3}%)" -f `
        (Format-Gb $after.TotalBytes), (Format-Gb $after.LiveBytes), (Format-Gb $after.FreeBytes), $after.FreePercent)
    Write-Host ("[gortex] Reclaimed {0}." -f (Format-Gb ($before.TotalBytes - $after.TotalBytes)))

    $repositories = @(Get-GortexRepositories)
    Write-Output "Gortex store compacted: $(Format-Gb $before.TotalBytes) -> $(Format-Gb $after.TotalBytes) across $($repositories.Count) tracked repositories."
}

if ($Action -eq 'Compact') {
    if ($PSCmdlet.ShouldProcess((Get-GortexStorePath), 'Compact the Gortex store')) {
        Invoke-GortexStoreCompaction
        Complete-Run 'Compact'
    }
    else {
        Complete-Run 'Compact (skipped)'
    }
    return
}

$targetPath = Resolve-TargetPath $WorktreePath -AllowMissing:($Action -eq 'Teardown')
if ([string]::IsNullOrWhiteSpace($BaseRepoName) -and $Action -ne 'Teardown') {
    $BaseRepoName = Get-GitRepositoryName $targetPath
}
$gortexPath = Resolve-GortexPath

if ($Action -in @('Setup', 'Rebuild')) {
    $sourcePath = Resolve-SourceCheckoutPath $targetPath
    $script:resolvedWorkspace = Resolve-GortexWorkspace -ConfigPath $GortexConfigPath -SourcePath $sourcePath
    $script:resolvedExclude = @(Resolve-ExcludePattern -ConfigPath $GortexConfigPath -SourcePath $sourcePath)
}

if ($Action -eq 'Status') {
    $repository = Get-GortexRepository $targetPath
    $globalEntry = Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $targetPath
    $trackedEntry = Get-TrackedEntry $targetPath
    $storeReport = Get-GortexStoreReportSafe

    # `gortex repos` is served from the store and keeps answering while the daemon
    # is saturated, whereas `daemon status` has a 30 second budget that heavy index
    # or purge work routinely blows. Reporting only the status probe would call a
    # working daemon dead, so the two are distinguished.
    $daemonAnswers = Test-GortexDaemon
    $daemonHealth = if ($daemonAnswers) {
        'Responsive'
    }
    elseif ($null -ne $repository) {
        'BusyOrWedged'
    }
    else {
        'Unreachable'
    }

    [pscustomobject]@{
        Path              = $targetPath
        IsLinkedWorktree  = Test-LinkedWorktree $targetPath
        DaemonRunning     = $daemonAnswers
        DaemonHealth      = $daemonHealth
        Tracked           = $null -ne $globalEntry
        # A repo tracked without an explicit `name:` is still named - Gortex derives
        # it from the directory - so the daemon's value is used rather than showing
        # a healthy canonical checkout as nameless.
        Repo              = if ($null -ne $globalEntry -and -not [string]::IsNullOrWhiteSpace($globalEntry.Name)) {
            $globalEntry.Name
        }
        else {
            Get-EntryPropertyValue $repository 'name'
        }
        Workspace         = if ($null -ne $globalEntry) { $globalEntry.Workspace } else { $null }
        Project           = if ($null -ne $globalEntry) { $globalEntry.Project } else { $null }
        PolicySource      = Get-EntryPropertyValue $trackedEntry 'source'
        IndexState        = Get-GortexIndexState $repository
        Indexed           = (Get-EntryPropertyValue $repository 'indexed') -eq $true
        Stale             = Get-EntryPropertyValue $repository 'stale'
        Branch            = Get-EntryPropertyValue $repository 'branch'
        HeadCommit        = Get-EntryPropertyValue $repository 'head_commit'
        IndexedCommit     = Get-EntryPropertyValue $repository 'indexed_commit'
        LastIndexed       = Get-EntryPropertyValue $repository 'last_indexed'
        WorktreeConfig    = Test-Path -LiteralPath (Join-Path $targetPath '.gortex.yaml') -PathType Leaf
        StoreSize         = if ($null -ne $storeReport) { Format-Gb $storeReport.TotalBytes } else { $null }
        StoreLive         = if ($null -ne $storeReport) { Format-Gb $storeReport.LiveBytes } else { $null }
        StoreReclaimable  = if ($null -ne $storeReport) { '{0} ({1}%)' -f (Format-Gb $storeReport.FreeBytes), $storeReport.FreePercent } else { $null }
        StoreHealth       = Get-GortexStoreHealth $storeReport
        Exclusions        = if ($null -ne $globalEntry) { @($globalEntry.Exclude).Count } else { 0 }
        ExclusionPatterns = if ($null -ne $globalEntry) { ($globalEntry.Exclude -join ', ') } else { '' }
    }
    Complete-Run 'Status'
    return
}

if ($Action -eq 'Wait') {
    Wait-GortexWorktreeReady $targetPath
    Complete-Run 'Wait'
    return
}

$plannedEntry = Get-GlobalRepoEntry -ConfigPath $GortexConfigPath -Path $targetPath
$plannedRepoName = if ($null -ne $plannedEntry -and -not [string]::IsNullOrWhiteSpace($plannedEntry.Name)) {
    $plannedEntry.Name
}
else {
    Get-GeneratedRepoName $targetPath
}

if (-not $PSCmdlet.ShouldProcess($targetPath, "$Action Gortex worktree $plannedRepoName")) {
    Complete-Run "$Action (skipped)"
    return
}

switch ($Action) {
    'Setup' {
        Initialize-GortexWorktree $targetPath
    }
    'Teardown' {
        Remove-GortexWorktree $targetPath
    }
    'Rebuild' {
        Remove-GortexWorktree $targetPath
        Initialize-GortexWorktree $targetPath
    }
}

Complete-Run $Action