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

    Neither Copilot surface gets MCP from Gortex at all. Gortex has no Copilot
    CLI adapter, and its `vscode` adapter writes a repo-local .vscode\mcp.json
    rather than the VS Code user profile. Both surfaces otherwise end up with
    hooks and skills but no graph tools, so this installer registers the MCP
    server for them directly.

    This installer closes all three gaps for every agent found on the machine.

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
    Gortex hook posture, forwarded both to `gortex install` and to the kit's own
    hook adapters. 'deny' (the Gortex default) makes PreToolUse refuse Grep and
    Glob against indexed source, so the agent has to reach for the graph.
    'enrich' never refuses anything and only appends context, which is gentler
    for onboarding but relies entirely on the model choosing to comply.
    'consult-unlock' and 'nudge' sit between the two.

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

    [ValidateSet('auto', 'claude-code', 'copilot', 'codex', 'opencode', 'vscode')]
    [string[]] $Agents = @('auto'),

    [ValidateSet('enrich', 'deny', 'consult-unlock', 'nudge')]
    [string] $HookMode = 'deny',

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

# Text I/O goes through .NET rather than Get-Content/Set-Content because this
# installer has to behave identically under Windows PowerShell 5.1 and pwsh 7,
# and those two disagree about encoding. In 5.1 `Get-Content` decodes a
# BOM-less file as ANSI, so the em dashes in the Gortex instruction profile come
# back as "a€"" and get written straight back out that way; `-Encoding UTF8`
# then emits a BOM that pwsh 7 would not. Reading and writing UTF-8 without a
# BOM explicitly is the only way both shells produce a byte-identical file --
# which idempotency depends on, since the content comparison below is what
# decides whether anything is rewritten at all.
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

# Writing only on change keeps the installer idempotent and avoids churning a
# backup file on every run.
function Set-ManagedContent {
    param(
        [string] $Path,
        [string] $Content,
        [switch] $NoBackup
    )

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Read-TextFile $Path
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
        Write-TextFile -Path $Path -Content ($Content.TrimEnd() + [Environment]::NewLine)
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

# The MCP server stanza. Deliberately minimal, and deliberately the bare command
# rather than a resolved path: this is the exact shape Gortex's own adapters
# write for Codex and Claude Code, so all four agents end up pointing at one
# server definition that survives a Gortex upgrade moving the executable.
function New-GortexMcpEntry {
    return [ordered]@{
        type    = 'stdio'
        command = 'gortex'
        args    = @('mcp')
    }
}

# Registers the Gortex MCP server in a shared JSON config.
#
# These files belong to the agent, not to this kit: they already hold unrelated
# servers, and in VS Code's case an `inputs` array too. So only the gortex entry
# is touched, only the keys above are managed, and any other key found on that
# entry is left exactly as it was.
#
# The write is skipped entirely when every managed key already matches. Blindly
# reserializing would reflow the whole document -- VS Code's file is tab
# indented, ours would not be -- and strand a fresh timestamped backup on every
# single run, which is the same non-idempotency the Codex path had to fix.
function Merge-McpServer {
    param(
        [string] $Path,
        [string] $ContainerKey,
        [System.Collections.IDictionary] $Entry
    )

    $config = $null
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $raw = Read-TextFile $Path
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            try {
                # -AsHashtable is not optional here. Copilot config files can
                # carry keys that differ only by case, which the object-mode
                # parser rejects outright rather than merging.
                $config = $raw | ConvertFrom-Json -AsHashtable
            }
            catch {
                Write-Warning "Could not parse $Path : $($_.Exception.Message)"
                Write-Detail 'Left untouched. Fix the JSON and re-run to register the MCP server.'
                return 'parse failed'
            }
        }
    }

    if ($null -eq $config) { $config = [ordered]@{} }

    if (-not $config.Contains($ContainerKey) -or $null -eq $config[$ContainerKey]) {
        $config[$ContainerKey] = [ordered]@{}
    }
    $servers = $config[$ContainerKey]

    $changed = $false
    if (-not $servers.Contains('gortex') -or $null -eq $servers['gortex']) {
        $servers['gortex'] = $Entry
        $changed = $true
    }
    else {
        $current = $servers['gortex']
        foreach ($key in $Entry.Keys) {
            $want = ConvertTo-Json $Entry[$key] -Depth 20 -Compress
            $have = $null
            if ($current.Contains($key)) {
                $have = ConvertTo-Json $current[$key] -Depth 20 -Compress
            }
            if ($have -ne $want) {
                $current[$key] = $Entry[$key]
                $changed = $true
            }
        }
    }

    if (-not $changed -and -not $Force) { return 'already current' }

    $json = $config | ConvertTo-Json -Depth 100
    if (Set-ManagedContent -Path $Path -Content $json) {
        Write-Detail "registered gortex MCP server in $Path"
        return 'wired'
    }

    return 'already current'
}

# Writes the Gortex rule block into a Markdown instructions file.
#
# Gortex has a `--claude-md` flag that does this for Claude Code and nothing
# equivalent for Copilot, so Copilot gets the MCP server and the skills but is
# never actually told to prefer graph queries over Read/Grep/Glob.
#
# The body is *inlined* rather than @-imported. Claude's block is a one-line
# `@<path>` pointer into ~/.gortex/instructions, but the Copilot CLI has no
# import resolution at all -- it would ship that line to the model as literal
# text and the rules would silently never apply. Inlining means the block is a
# copy, so re-running the installer is what picks up `gortex instructions
# switch`; the body is compared on every run, so that needs no -Force.
#
# Only the delimited block is owned. Anything the user wrote around it survives,
# because this file is a plausible place to keep unrelated personal instructions.
function Merge-InstructionBlock {
    param(
        [string] $Path,
        [string] $Body
    )

    $startMark = '<!-- gortex:rules:start -->'
    $endMark = '<!-- gortex:rules:end -->'

    # Byte-identical to what `gortex install` itself writes: start marker, LF,
    # body, blank line, end marker -- LF throughout, and no management comment.
    #
    # That exactness is the whole point. Gortex owns this same block in
    # ~/.codex/AGENTS.md and ~/.config/opencode/AGENTS.md, so any difference
    # here -- even a comment noting who manages the block -- makes `gortex
    # install` and this installer each treat the other's output as drift and
    # rewrite it forever, stranding a .bak on every alternation. Verified: a
    # two-line comment was enough to make `gortex install --dry-run` report
    # "would-merge" against a file whose rules were already current.
    $block = ($startMark + "`n" + $Body.Trim() + "`n`n" + $endMark)

    $existing = ''
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = Read-TextFile $Path
        if ($null -eq $existing) { $existing = '' }
    }

    if ($existing -match [regex]::Escape($startMark)) {
        $pattern = '(?s)' + [regex]::Escape($startMark) + '.*?' + [regex]::Escape($endMark)
        $updated = [regex]::Replace($existing, $pattern, { $block }, 1)
    }
    elseif ([string]::IsNullOrWhiteSpace($existing)) {
        $updated = $block + [Environment]::NewLine
    }
    else {
        $updated = $existing.TrimEnd() + [Environment]::NewLine * 2 + $block + [Environment]::NewLine
    }

    if (Set-ManagedContent -Path $Path -Content $updated) {
        Write-Detail "wrote rule block to $Path"
        return 'wired'
    }

    return 'already current'
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
    'vscode'      = (Test-Path -LiteralPath (Join-Path $ConfigRoot 'AppData\Roaming\Code\User') -PathType Container) -or [bool](Resolve-Executable 'code')
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
    $content = Read-TextFile (Join-Path $hookSource $file)
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
    $inner = "if (Test-Path -LiteralPath '$copilotHook' -PathType Leaf) { & '$copilotHook' -Mode '$HookMode'; exit `$LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0"
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
    $hookState = if (Set-ManagedContent -Path $path -Content $json) {
        Write-Detail "wrote $path"
        'wired'
    }
    else {
        Write-Detail 'hooks already current'
        'already current'
    }

    # Gortex has no Copilot CLI adapter, so `gortex install` never registers the
    # MCP server here no matter which agents are passed to it. Without this the
    # CLI gets the readiness gate and the mirrored skills but no graph tools,
    # and every skill it just learned about fails the moment it is invoked.
    $mcpState = Merge-McpServer -Path (Join-Path $ConfigRoot '.copilot\mcp-config.json') `
        -ContainerKey 'mcpServers' -Entry (New-GortexMcpEntry)

    # Instructions are the one surface every Copilot runtime genuinely shares.
    # The CLI resolves ~\.copilot\copilot-instructions.md itself, and VS Code's
    # Chat panel independently searches the same path -- its prompt loader calls
    # findFilesInRoots([userHome], ".copilot", [{fileName:"copilot-instructions.md"}])
    # alongside the workspace .github lookup. One file therefore covers the
    # terminal CLI, the VS Code agent host, and the native Chat panel, so it is
    # written once here rather than again in the vscode section.
    $instrState = 'skipped'
    $activeInstructions = Join-Path $ConfigRoot '.gortex\instructions\active.md'
    if (Test-Path -LiteralPath $activeInstructions -PathType Leaf) {
        # Both locations are loaded at once -- verified by planting a sentinel in
        # copilot-instructions.md and having a fresh `copilot -p` session echo it
        # back alongside a value that only ~\.copilot\instructions\ carries. So
        # writing the canonical file blind would hand the model the same rule
        # block twice on any machine that already keeps one under instructions\,
        # and the two copies would then drift apart on the next profile switch.
        # Prefer whichever file already owns the block; fall back to canonical.
        $instrTarget = Join-Path $ConfigRoot '.copilot\copilot-instructions.md'
        if (-not (Test-Path -LiteralPath $instrTarget -PathType Leaf)) {
            $existingBlock = @(
                Get-ChildItem -LiteralPath (Join-Path $ConfigRoot '.copilot\instructions') `
                    -File -Filter '*.md' -ErrorAction SilentlyContinue |
                    Where-Object { (Read-TextFile $_.FullName) -match '<!-- gortex:rules:start -->' } |
                    Sort-Object Name
            )
            if ($existingBlock.Count -gt 0) {
                $instrTarget = $existingBlock[0].FullName
                Write-Detail "reusing existing rule block in $($existingBlock[0].Name)"
                if ($existingBlock.Count -gt 1) {
                    Write-Warning ("Copilot has {0} instruction files carrying the gortex block; only {1} is managed." -f $existingBlock.Count, $existingBlock[0].Name)
                }
            }
        }

        $instrState = Merge-InstructionBlock `
            -Path $instrTarget `
            -Body (Read-TextFile $activeInstructions)
        Write-Detail "instructions: $instrState"
    }
    else {
        Write-Detail 'instructions: skipped (no active Gortex profile yet)'
    }

    if ($hookState -eq 'wired' -or $mcpState -eq 'wired' -or $instrState -eq 'wired') {
        Set-Result 'copilot' 'wired' "gate ${GateTimeoutSec}s; mcp $mcpState; rules $instrState"
    }
    else {
        Set-Result 'copilot' 'already current' "mcp $mcpState; rules $instrState"
    }
}

# --- Copilot in VS Code ------------------------------------------------------

if ($selected -contains 'vscode') {
    Write-Step 'Wiring Copilot in VS Code.'

    # `gortex install --agents vscode` writes a *repo-local* .vscode\mcp.json,
    # which only ever covers whichever folder happened to be open when it ran.
    # The user profile is what makes the graph available in every workspace, so
    # that is what is written here.
    #
    # This is MCP only. The native Copilot Chat panel exposes no hook API, so it
    # cannot be gated on index readiness the way the CLI agents are -- the tools
    # are simply present, and answer nothing until the index is ready.
    #
    # Instructions are not written here either. The agent host execs the same
    # `copilot` binary as the terminal CLI, and the native Chat panel reads
    # ~\.copilot\copilot-instructions.md directly, so the copilot section has
    # already covered both. MCP is the only part of the configuration these
    # surfaces do not share, which is exactly why it is the only part repeated
    # here.
    #
    # The panel honours that file only while
    # `github.copilot.chat.codeGeneration.useInstructionFiles` is true. That is
    # the default, and forcing it in settings.json would mean owning a file the
    # user edits by hand, so it is left alone and called out in the runbook.
    $vscodeRoots = [ordered]@{
        'VS Code'          = Join-Path $ConfigRoot 'AppData\Roaming\Code\User\mcp.json'
        'VS Code Insiders' = Join-Path $ConfigRoot 'AppData\Roaming\Code - Insiders\User\mcp.json'
    }

    $states = @()
    foreach ($name in $vscodeRoots.Keys) {
        $target = $vscodeRoots[$name]

        # Only write into a profile that exists. Creating the Insiders tree on a
        # machine that has never run Insiders would leave a config for an editor
        # that is not installed.
        $userDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $userDir -PathType Container)) { continue }

        $state = Merge-McpServer -Path $target -ContainerKey 'servers' -Entry (New-GortexMcpEntry)
        Write-Detail "$name : $state"
        $states += $state
    }

    if ($states.Count -eq 0) {
        Set-Result 'vscode' 'skipped' 'no VS Code user profile found'
        Write-Detail 'no VS Code user profile found'
    }
    elseif ($states -contains 'wired') {
        Set-Result 'vscode' 'wired' 'user-profile MCP; restart VS Code'
    }
    else {
        Set-Result 'vscode' 'already current' ''
    }
}

# --- Codex -------------------------------------------------------------------

if ($selected -contains 'codex') {
    Write-Step 'Wiring Codex.'

    $codexConfig = Join-Path $ConfigRoot '.codex\config.toml'

    # Gortex owns the shape of the [hooks] table, so it writes the block first
    # and only the gated event is re-pointed afterwards. Hand-authoring the
    # whole table would drift from whatever the current Gortex release expects.
    #
    # It is seeded once rather than on every run. `gortex install` unconditionally
    # re-adds its own [[hooks.UserPromptSubmit]] block, which the gate then strips
    # again, so re-running it would rewrite config.toml — and strand another
    # timestamped backup — on every single install. Use -Force after upgrading
    # Gortex to pick up a changed hook table.
    $codexSeeded = (Test-Path -LiteralPath $codexConfig -PathType Leaf) -and
                   ((Read-TextFile $codexConfig) -match 'hook\s+--agent=codex')

    if ($gortexExe -and -not $SkipGortexInstall -and (-not $codexSeeded -or $Force) -and
        $PSCmdlet.ShouldProcess('codex', "gortex install --hook-mode $HookMode")) {
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
        $toml = Read-TextFile $codexConfig
    }

    # `gortex install` merges its hook table idempotently: on a config that
    # already carries the blocks it leaves the existing `--mode=<posture>`
    # strings alone, so --hook-mode only ever applies to a first install.
    # Re-pointing them here is what actually makes -HookMode take effect on an
    # already-wired machine. These are Gortex's own direct entries -- the ones
    # that carry the PreToolUse deny -- so leaving them stale silently keeps the
    # old posture while every report claims the new one.
    $toml = [regex]::Replace($toml, '(--agent=codex\s+--mode=)[\w-]+', "`${1}$HookMode")

    $gateCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $(ConvertTo-PosixPath $codexHook) -Mode $HookMode"

    $block = @(
        '',
        '[[hooks.UserPromptSubmit]]',
        '[[hooks.UserPromptSubmit.hooks]]',
        "command = '$gateCommand'",
        "statusMessage = 'Checking Gortex index readiness and surfacing graph context...'",
        "timeout = $GateTimeoutSec",
        "type = 'command'"
    ) -join [Environment]::NewLine

    # Every UserPromptSubmit block is stripped, not just the first. `gortex
    # install` unconditionally re-adds its own, so replacing a single block
    # leaves Gortex's copy behind and the two then run in sequence -- the gate
    # plus an ungated enrichment. Removing all of them and inserting the gate
    # once is idempotent no matter how many have accumulated.
    $promptPattern = '(?ms)^\[\[hooks\.UserPromptSubmit\]\].*?(?=^\[(?!\[hooks\.UserPromptSubmit)|\Z)'
    $toml = [regex]::Replace($toml, $promptPattern, '')

    if ($toml -match '(?m)^\[hooks\.state\]') {
        $updated = $toml -replace '(?m)^\[hooks\.state\]', ($block.TrimStart() + [Environment]::NewLine + [Environment]::NewLine + '[hooks.state]')
    }
    else {
        $updated = $toml.TrimEnd() + [Environment]::NewLine + $block + [Environment]::NewLine
    }

    # Collapse the blank runs left behind by the stripped blocks.
    $updated = [regex]::Replace($updated, '(\r?\n){3,}', ([Environment]::NewLine * 2))

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
        $settings = Read-TextFile $settingsPath | ConvertFrom-Json
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
    $command = "if [ -f '$posixCmd' ]; then '$posixCmd' -Mode $HookMode; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi"

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
        $content = Read-TextFile $pluginFile
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

    $claudeSkills = Join-Path $ConfigRoot '.claude\skills'

    # Gortex writes skills for exactly one adapter: Claude Code. Every other
    # agent gets MCP wiring and hooks but no skills, so ~/.claude/skills is the
    # only source this mirror can read. On a machine without Claude Code that
    # directory never appears, auto-detection drops claude-code from the
    # selection, and Copilot and Codex silently end up with no skills at all.
    # Seeding it directly is what keeps those two agents working: `gortex
    # install --agents claude-code` writes the skill set whether or not the
    # Claude CLI exists. Hooks and CLAUDE.md are suppressed because there is no
    # Claude session here to consume them.
    if (-not (Test-Path -LiteralPath $claudeSkills -PathType Container) -and $gortexExe -and -not $SkipGortexInstall) {
        if ($PSCmdlet.ShouldProcess($claudeSkills, 'Seed Gortex skills via claude-code adapter')) {
            Write-Detail 'no skill source yet; seeding it from the claude-code adapter'
            & $gortexExe install --agents claude-code --claude-config-dir (Join-Path $ConfigRoot '.claude') --no-hooks --no-claude-md --yes 2>&1 | Out-Null
        }
    }

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
            & $skillSync -Prune -SourceRoot $claudeSkills -TargetRoot (Join-Path $ConfigRoot '.agents\skills') | Out-Null
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
