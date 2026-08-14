<#
.SYNOPSIS
    Shared Gortex index-readiness gate for every coding agent.

.DESCRIPTION
    Registration and indexing are separate states. Paseo launches an agent as
    soon as its worktree exists, which is minutes before `worktree.setup`
    finishes the first index, so an agent that trusts `tracked` starts work
    against an empty graph and silently falls back to raw file reads.

    This module resolves the real state and, when an index is in flight, waits
    for it. Waiting rather than blocking is deliberate: a blocked first prompt
    is discarded by every agent host tested, and nothing re-sends it, so the
    agent is stranded idle forever. Blocking is reserved for states that waiting
    cannot fix - a dead daemon, or an exhausted budget.

    Consumed two ways:

      1. Dot-sourced, then call Get-GortexReadinessVerdict. Used by the
         PowerShell hook shims (Copilot, Codex).
      2. Executed directly with -Cwd and -Json, which prints one verdict object.
         Used by non-PowerShell hosts (the OpenCode Bun plugin).

    The verdict is host-neutral:

      Decision : allow | block
      State    : Ready | Indexing | Untracked | Unknown
      Reason   : operator-facing text, populated when Decision is block
      Context  : additionalContext text, populated when a wait succeeded

.NOTES
    Every probe is bounded. A wedged daemon must degrade to a decision rather
    than stall the turn, because most hosts kill a hook that overruns and then
    proceed ungated, which is the exact failure this gate exists to prevent.
#>
[CmdletBinding()]
param(
    [string] $Cwd,
    [int]    $WaitSeconds = -1,
    [switch] $Json,
    [switch] $NoWait
)

function Invoke-GortexBounded {
    param(
        [string] $Gortex,
        [string[]] $Arguments,
        [int] $TimeoutMs = 8000,
        [string] $WorkingDirectory
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Gortex
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory) -and (Test-Path -LiteralPath $WorkingDirectory)) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }

    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $Arguments) {
            $startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = (($Arguments | ForEach-Object { '"{0}"' -f ($_ -replace '"', '\"') }) -join ' ')
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit($TimeoutMs)) {
        try { $process.Kill($true) }
        catch { try { $process.Kill() } catch { } }
        return [pscustomobject]@{ Ok = $false; Output = ''; Error = '' }
    }

    # Gortex reports resolution failures on stderr, so callers that need to tell
    # "not tracked" apart from "busy" have to see it.
    return [pscustomobject]@{ Ok = ($process.ExitCode -eq 0); Output = $stdout.Result; Error = $stderr.Result }
}

function Test-GortexAvailable {
    param([string] $Gortex)

    if ([string]::IsNullOrWhiteSpace($Gortex)) {
        return $false
    }

    try {
        return (Invoke-GortexBounded -Gortex $Gortex -Arguments @('daemon', 'status')).Ok
    }
    catch {
        return $false
    }
}

function Test-PathWithin {
    param(
        [string] $Child,
        [string] $Parent
    )

    if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Parent)) {
        return $false
    }

    try {
        $normalizedChild = [IO.Path]::GetFullPath($Child).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $normalizedParent = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    }
    catch {
        return $false
    }

    if ($normalizedChild -ieq $normalizedParent) {
        return $true
    }

    return $normalizedChild.StartsWith($normalizedParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Get-GortexCacheRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:GORTEX_HOME)) {
        return (Join-Path $env:GORTEX_HOME 'cache')
    }
    return (Join-Path $HOME '.gortex\cache')
}

function Get-ReadinessCachePath {
    return Join-Path (Get-GortexCacheRoot) 'agent-readiness.json'
}

function Test-GortexControlSocket {
    # The daemon creates its control socket on start and removes it on a clean
    # stop, so absence is proof it is gone without paying for a subprocess.
    try {
        return (Test-Path -LiteralPath (Join-Path (Get-GortexCacheRoot) 'daemon.sock'))
    }
    catch {
        return $true
    }
}

function Test-GortexResolvable {
    param(
        [string] $Gortex,
        [string] $Cwd
    )

    # `repos --json` reports a freshly tracked worktree as indexed while the
    # daemon's path resolver still rejects the directory until it is reloaded, so
    # an agent released on indexed=true alone hits "repository not tracked" on
    # every graph call. This resolves the cwd through the same surface the graph
    # tools use, which is the only signal that matches what the agent will see.
    if ([string]::IsNullOrWhiteSpace($Cwd)) {
        return $true
    }

    $probe = Invoke-GortexBounded -Gortex $Gortex -Arguments @('call', 'workspace', '--arg', 'operation=info') -TimeoutMs 15000 -WorkingDirectory $Cwd
    if ($probe.Ok) {
        return $true
    }

    # Only an explicit resolution failure counts. A probe that fails because the
    # daemon is busy must not be read as "not tracked", or a loaded daemon would
    # hold the agent for the whole budget.
    return (($probe.Output + $probe.Error) -notmatch 'does not track')
}

function Get-GortexDaemonLiveness {
    # Returns Up, Down, or Unknown.
    #
    # `gortex daemon status` is the obvious liveness probe and the wrong one: it
    # shares the daemon's request budget, so it stalls or fails for as long as the
    # daemon is busy. Indexing and the compaction that follows it hold that state
    # for minutes, which turns a healthy daemon into a false negative exactly when
    # a worktree has just become ready. The socket and the pid file are written by
    # the daemon itself, cost no subprocess, and stay accurate under any load.
    if (-not (Test-GortexControlSocket)) {
        return 'Down'
    }

    $pidFile = Join-Path (Get-GortexCacheRoot) 'daemon.pid'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return 'Unknown'
    }

    $daemonPid = 0
    try {
        $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        if (-not [int]::TryParse($raw, [ref] $daemonPid) -or $daemonPid -le 0) {
            return 'Unknown'
        }
    }
    catch {
        return 'Unknown'
    }

    $process = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        # A socket left behind by a crash outlives the process it belonged to.
        return 'Down'
    }

    # The pid could have been recycled by an unrelated process after a crash, in
    # which case nothing here proves the daemon is up.
    if ($process.Name -ne 'gortex') {
        return 'Unknown'
    }

    return 'Up'
}

function Import-CachedRepos {
    $path = Get-ReadinessCachePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }

    try {
        # Windows PowerShell 5.1 emits a JSON array as a single object instead of
        # enumerating it, so @(pipeline) collapses the repository list into one
        # nested array and every lookup silently misses.
        $cached = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $path -Raw)
        return @($cached.repos)
    }
    catch {
        return $null
    }
}

function Export-CachedRepos {
    param($Repos)

    try {
        $path = Get-ReadinessCachePath
        $directory = Split-Path -Parent $path
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }

        $payload = [pscustomobject]@{ updated = (Get-Date).ToString('o'); repos = $Repos }
        $temporary = "$path.$PID.tmp"
        Set-Content -LiteralPath $temporary -Value ($payload | ConvertTo-Json -Depth 6 -Compress) -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $path -Force
    }
    catch {
        # A cache miss only costs accuracy on the next unresponsive probe.
    }
}

function Get-GortexWorkspaceState {
    param(
        [string] $Gortex,
        [string] $Cwd
    )

    # Registration and indexing are separate states. A freshly created Paseo
    # worktree is tracked within seconds but stays unqueryable for the length of
    # its first index, so `tracked` must never be read as `ready`.
    $result = [pscustomobject]@{ State = 'Unknown'; Repo = ''; Path = ''; AnyIndexing = $false; Source = 'none' }

    # Indexing holds locks in bursts, so this probe swings between 0.9s and 9s on
    # the same repository. It is bounded tightly and backed by the last good
    # answer rather than being given a budget long enough to stall the turn.
    $parsed = $null
    $repos = Invoke-GortexBounded -Gortex $Gortex -Arguments @('repos', '--json') -TimeoutMs 6000
    if ($repos.Ok -and -not [string]::IsNullOrWhiteSpace($repos.Output)) {
        try {
            $converted = ConvertFrom-Json -InputObject $repos.Output
            $parsed = @($converted)
            $result.Source = 'live'
            Export-CachedRepos $parsed
        }
        catch {
            $parsed = $null
        }
    }

    if ($null -eq $parsed) {
        $parsed = Import-CachedRepos
        if ($null -eq $parsed -or $parsed.Count -eq 0) {
            return $result
        }
        $result.Source = 'cache'
    }

    # An index in flight keeps the daemon too busy to answer `daemon status`
    # within any sane hook budget, so that condition is detected here rather than
    # being misreported as an unreachable daemon.
    foreach ($repo in $parsed) {
        if ($null -ne $repo.PSObject.Properties['indexed'] -and $repo.indexed -ne $true) {
            $result.AnyIndexing = $true
            break
        }
    }

    if ([string]::IsNullOrWhiteSpace($Cwd)) {
        $result.State = 'Untracked'
        return $result
    }

    # Longest match wins so a worktree nested inside another checkout resolves to
    # the innermost repository rather than its parent.
    $match = $null
    foreach ($repo in $parsed) {
        if ($null -eq $repo.PSObject.Properties['path']) {
            continue
        }
        if (-not (Test-PathWithin -Child $Cwd -Parent ([string] $repo.path))) {
            continue
        }
        if ($null -eq $match -or ([string] $repo.path).Length -gt ([string] $match.path).Length) {
            $match = $repo
        }
    }

    if ($null -eq $match) {
        # A worktree created after the cached snapshot is unknown, not untracked.
        # Treating it as ready is the exact race this gate exists to prevent.
        $result.State = if ($result.Source -eq 'cache') { 'Unknown' } else { 'Untracked' }
        return $result
    }

    $result.Repo = [string] $match.name
    $result.Path = [string] $match.path
    $result.State = if ($match.indexed -eq $true) { 'Ready' } else { 'Indexing' }

    return $result
}

function Resolve-GortexPath {
    $command = Get-Command gortex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }

    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\gortex\gortex.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        return $fallback
    }

    return $null
}

function Get-GortexWaitBudgetSeconds {
    # Defaults to the 30 minutes a fresh index of a large repository needs, which
    # matches the worktree setup timeout so the gate and setup give up together.
    $budget = 1800
    foreach ($name in @('GORTEX_AGENT_WAIT_SECONDS', 'GORTEX_COPILOT_WAIT_SECONDS')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }
        $parsed = 0
        if ([int]::TryParse($value, [ref] $parsed) -and $parsed -ge 0) {
            return $parsed
        }
    }
    return $budget
}

function Get-GortexReadinessVerdict {
    <#
    .SYNOPSIS
        Resolves index readiness for a working directory, waiting out an index.

    .OUTPUTS
        Decision (allow|block), State, Repo, Path, Reason, Context, WaitedSeconds.
    #>
    param(
        [string] $Cwd,
        [int] $WaitSeconds = -1,
        [switch] $NoWait
    )

    $verdict = [pscustomobject]@{
        Decision     = 'allow'
        State        = 'Unknown'
        Repo         = ''
        Path         = ''
        Reason       = ''
        Context      = ''
        WaitedSeconds = 0
    }

    $gortex = Resolve-GortexPath
    if ($null -eq $gortex) {
        # Nothing to gate on when Gortex is not installed at all; the hook layer
        # is advisory in that case rather than an obstacle.
        return $verdict
    }

    if ($WaitSeconds -lt 0) {
        $WaitSeconds = Get-GortexWaitBudgetSeconds
    }
    if ($NoWait) {
        $WaitSeconds = 0
    }

    $workspace = Get-GortexWorkspaceState -Gortex $gortex -Cwd $Cwd
    $verdict.State = $workspace.State
    $verdict.Repo = $workspace.Repo
    $verdict.Path = $workspace.Path

    # Liveness is resolved before readiness because `repos --json` is served
    # straight from the store and keeps returning exit 0 with a full repository
    # list even when the daemon is stopped. A stopped daemon therefore looks
    # healthy until the first MCP call fails, and advising the agent to wait for
    # an index would strand it, since nothing can progress while the daemon is
    # down.
    $liveness = Get-GortexDaemonLiveness
    if ($liveness -eq 'Down') {
        $verdict.Decision = 'block'
        $verdict.Reason = (@(
            'The Gortex daemon is not running, and this environment requires the graph.',
            '',
            'Its control socket is absent, so no graph query can be served, and no',
            'index can make progress. Readiness data still reads back from the store,',
            'which makes a stopped daemon look healthy until the first MCP call fails.',
            '',
            'Remediation:',
            '  gortex daemon start --detach',
            '  gortex daemon status'
        ) -join [Environment]::NewLine)
        return $verdict
    }

    # A tracked-but-unindexed repository is waited out rather than blocked.
    # Blocking discards the prompt: Paseo launches the agent as soon as the
    # worktree exists, well before worktree.setup finishes indexing, so a blocked
    # first prompt leaves the agent idle forever with nothing to resend it.
    # Waiting converts that into the intended behaviour - the agent simply starts
    # once the index is ready. A cwd Gortex does not cover is left alone, because
    # the agent may legitimately be working outside any tracked checkout.
    if ($workspace.State -eq 'Indexing' -and $WaitSeconds -gt 0) {
        $waited = [Diagnostics.Stopwatch]::StartNew()
        while ($waited.Elapsed.TotalSeconds -lt $WaitSeconds) {
            Start-Sleep -Seconds 5

            # The daemon dying mid-index would otherwise burn the whole budget
            # waiting for an index that can no longer progress.
            if ((Get-GortexDaemonLiveness) -eq 'Down') {
                break
            }

            $workspace = Get-GortexWorkspaceState -Gortex $gortex -Cwd $Cwd
            if ($workspace.State -eq 'Ready') {
                # Indexed is not the same as resolvable. The daemon only picks up
                # a newly tracked path on reload, which setup performs after the
                # index, so releasing on indexed=true alone lands the agent in the
                # window where every graph call returns "not tracked".
                if (Test-GortexResolvable -Gortex $gortex -Cwd $Cwd) {
                    break
                }
                continue
            }

            # A worktree that disappears from the index while being waited on is
            # not going to become ready.
            if ($workspace.State -eq 'Untracked') {
                break
            }
        }
        $waited.Stop()

        $verdict.WaitedSeconds = [int] $waited.Elapsed.TotalSeconds
        $verdict.State = $workspace.State
        $verdict.Repo = $workspace.Repo
        $verdict.Path = $workspace.Path

        if ($workspace.State -eq 'Ready') {
            $verdict.Context = "Gortex finished indexing this worktree after $($verdict.WaitedSeconds)s of waiting; the graph is ready, so use the Gortex tools rather than raw file reads."
            return $verdict
        }
    }

    if ($workspace.State -eq 'Indexing') {
        $verdict.Decision = 'block'
        $verdict.Reason = (@(
            'Gortex has not finished indexing this worktree, and this environment requires the graph.',
            '',
            "  repository : $($workspace.Repo)",
            "  path       : $($workspace.Path)",
            '  state      : tracked, but indexed=false',
            '',
            'Registration and indexing are separate states. The graph cannot answer',
            'search/read/explore/relations queries yet, so code navigation would silently',
            'fall back to raw file reads and miss most of the repository.',
            '',
            'Remediation - wait for the first index to finish (15-20 minutes for a large',
            'fresh worktree):',
            '  paseo run gortex-wait',
            '',
            'Check progress at any time:',
            '  paseo run gortex-status'
        ) -join [Environment]::NewLine)
        return $verdict
    }

    # A different repository is still indexing. The daemon is alive but will not
    # answer a status probe, and this worktree is already queryable, so the turn
    # proceeds rather than being blocked by an unrelated index.
    if ($workspace.State -eq 'Unknown') {
        $verdict.Decision = 'block'
        $verdict.Reason = (@(
            'Gortex is not answering, and this environment requires the graph.',
            '',
            'The daemon is either down or fully occupied by a first index, so this',
            "worktree's readiness cannot be confirmed. Registration and indexing are",
            'separate states, and starting work now would silently fall back to raw',
            'file reads.',
            '',
            'Remediation - confirm the daemon, then wait for this worktree:',
            '  gortex daemon status',
            '  gortex daemon start --detach   # only if it is not running',
            '  paseo run gortex-wait',
            '',
            'If status keeps timing out at 30s while the daemon process is pinning a',
            'core, it is wedged rather than busy. `start` alone reports "already',
            'running", so it has to be bounced:',
            '  gortex daemon stop',
            '  gortex daemon start --detach'
        ) -join [Environment]::NewLine)
        return $verdict
    }

    # Only reached when the socket and pid file disagree or are missing. A
    # confirmed-live daemon never pays for this probe, which is what kept a
    # freshly indexed worktree blocked for ~90s while the daemon finished its
    # post-index work and `daemon status` refused to answer.
    if ($liveness -eq 'Unknown' -and -not $workspace.AnyIndexing -and -not (Test-GortexAvailable $gortex)) {
        $verdict.Decision = 'block'
        $verdict.Reason = (@(
            'Gortex MCP is unavailable, and this environment requires it.',
            '',
            'The Gortex daemon is not reachable, so graph queries (search/read/explore/relations)',
            'cannot be served and any code navigation would silently fall back to raw file reads.',
            '',
            'Remediation:',
            '  gortex daemon start --detach',
            '  gortex daemon status',
            '',
            'If it reports "already running" and status still times out, the daemon is',
            'wedged and has to be bounced:',
            '  gortex daemon stop',
            '  gortex daemon start --detach'
        ) -join [Environment]::NewLine)
        return $verdict
    }

    return $verdict
}

# Dot-sourcing must only define functions. Detecting it via InvocationName rather
# than the bound parameters matters: a dot-sourced script runs in the caller's
# scope and sees the caller's $PSBoundParameters, so a shim invoked with its own
# -Cwd would otherwise trip this block and emit a stray verdict onto the hook's
# stdout, corrupting the JSON the host is trying to parse.
$isDotSourced = $MyInvocation.InvocationName -eq '.'
if (-not $isDotSourced -and ($Json -or -not [string]::IsNullOrWhiteSpace($Cwd))) {
    $standalone = Get-GortexReadinessVerdict -Cwd $Cwd -WaitSeconds $WaitSeconds -NoWait:$NoWait
    if ($Json) {
        [Console]::Out.Write(($standalone | ConvertTo-Json -Depth 6 -Compress))
    }
    else {
        $standalone
    }
}
