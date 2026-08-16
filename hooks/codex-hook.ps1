<#
.SYNOPSIS
    Bridges Codex CLI lifecycle hooks to the Gortex hook handler, gating the
    turn on index readiness first.

.DESCRIPTION
    Codex already refuses to start when the Gortex MCP server fails, because its
    server entry carries `required = true`. That covers "the server is missing"
    and nothing else: a Paseo worktree is registered with Gortex within seconds
    of being created, so the MCP server starts perfectly happily against a
    repository whose first index has not begun. The agent then works from an
    empty graph and silently falls back to raw file reads.

    This shim closes that gap by resolving real readiness before the turn, using
    the shared gate every agent host shares. When an index is in flight it waits
    for it rather than blocking, because a blocked first prompt is discarded and
    nothing re-sends it.

    Enrichment is unchanged: the payload is forwarded to the same
    `gortex hook --agent=codex` call the hook previously invoked directly, and
    its response is passed through untouched.

.NOTES
    Codex hashes each hook's configuration for its trust store, so editing the
    command or timeout in config.toml requires re-approving the hook once.
#>
[CmdletBinding()]
param(
    [string] $Mode = 'deny',
    [string] $Agent = 'codex'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'gortex-readiness.ps1')

function Write-CodexBlock {
    param([string] $Reason)

    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName decision -NotePropertyValue 'block'
    $payload | Add-Member -NotePropertyName reason -NotePropertyValue $Reason
    [Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
}

function Write-CodexContext {
    param([string] $Context)

    if ([string]::IsNullOrWhiteSpace($Context)) {
        return
    }

    # Codex mirrors Claude's nested hook output, and a top-level key is emitted
    # alongside it so the shim keeps working if that ever flattens.
    $nested = New-Object psobject
    $nested | Add-Member -NotePropertyName hookEventName -NotePropertyValue 'UserPromptSubmit'
    $nested | Add-Member -NotePropertyName additionalContext -NotePropertyValue $Context

    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName hookSpecificOutput -NotePropertyValue $nested
    $payload | Add-Member -NotePropertyName additionalContext -NotePropertyValue $Context
    [Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        exit 0
    }

    try {
        $event = $raw | ConvertFrom-Json
    }
    catch {
        exit 0
    }

    $gortex = Resolve-GortexPath

    # Set GORTEX_CODEX_REQUIRED=0 to bypass the gate for a session.
    $enforce = $env:GORTEX_CODEX_REQUIRED -ne '0'
    $eventName = ''
    if ($null -ne $event.PSObject.Properties['hook_event_name']) {
        $eventName = [string] $event.hook_event_name
    }

    if ($enforce -and $eventName -eq 'UserPromptSubmit') {
        $cwd = ''
        if ($null -ne $event.PSObject.Properties['cwd']) {
            $cwd = [string] $event.cwd
        }

        $verdict = Get-GortexReadinessVerdict -Cwd $cwd

        if ($verdict.Decision -eq 'block') {
            Write-CodexBlock (@(
                $verdict.Reason,
                '',
                'To proceed without the graph for this session, set GORTEX_CODEX_REQUIRED=0.'
            ) -join [Environment]::NewLine)
            exit 0
        }

        if (-not [string]::IsNullOrWhiteSpace($verdict.Context)) {
            Write-CodexContext $verdict.Context
            exit 0
        }
    }

    if ($null -eq $gortex) {
        exit 0
    }

    # Enrichment is forwarded verbatim: Gortex already speaks Codex's wire
    # format, so its reply needs no translation. The outbound payload is
    # canonicalised first so a POSIX-spelled path in a shell command still
    # resolves to its tracked repo.
    $payload = ConvertTo-GortexNormalizedPayload $raw
    $response = ($payload | & $gortex hook "--agent=$Agent" "--mode=$Mode" 2>$null | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($response)) {
        [Console]::Out.Write($response)
    }
}
catch {
    # Advisory context is never worth failing a turn over.
}

exit 0
