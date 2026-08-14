<#
.SYNOPSIS
    Bridges Claude Code lifecycle hooks to the Gortex hook handler, gating the
    turn on index readiness first.

.DESCRIPTION
    Gortex wires Claude Code with MCP plus its own lifecycle hooks, but nothing
    in that wiring knows whether the current repository has finished indexing.
    A freshly created worktree registers with the daemon in seconds while its
    first index takes far longer, so Claude starts against a graph that answers
    every query with nothing and quietly falls back to raw file reads.

    This shim resolves real readiness before the turn using the shared gate that
    every agent host in this kit shares. When an index is in flight it waits for
    it rather than blocking: Claude discards a blocked first prompt and nothing
    re-sends it, so blocking would lose the user's actual instruction.

    Enrichment is unchanged. The payload is forwarded to `gortex hook`, whose
    default wire protocol is already Claude Code, and its response is passed
    through untouched.

.NOTES
    On Windows, Claude Code executes hook commands through POSIX `sh`, not cmd.
    This file is therefore invoked via claude-hook.cmd, which `sh` can exec
    directly, rather than being named in settings.json itself.
#>
[CmdletBinding()]
param(
    [string] $Mode = 'enrich'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'gortex-readiness.ps1')

function Write-ClaudeBlock {
    param([string] $Reason)

    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName decision -NotePropertyValue 'block'
    $payload | Add-Member -NotePropertyName reason -NotePropertyValue $Reason
    [Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
}

function Write-ClaudeContext {
    param([string] $Context)

    if ([string]::IsNullOrWhiteSpace($Context)) {
        return
    }

    $nested = New-Object psobject
    $nested | Add-Member -NotePropertyName hookEventName -NotePropertyValue 'UserPromptSubmit'
    $nested | Add-Member -NotePropertyName additionalContext -NotePropertyValue $Context

    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName hookSpecificOutput -NotePropertyValue $nested
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

    # Set GORTEX_CLAUDE_REQUIRED=0 to bypass the gate for a session.
    $enforce = $env:GORTEX_CLAUDE_REQUIRED -ne '0'
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
            Write-ClaudeBlock (@(
                $verdict.Reason,
                '',
                'To proceed without the graph for this session, set GORTEX_CLAUDE_REQUIRED=0.'
            ) -join [Environment]::NewLine)
            exit 0
        }

        if (-not [string]::IsNullOrWhiteSpace($verdict.Context)) {
            Write-ClaudeContext $verdict.Context
            exit 0
        }
    }

    if ($null -eq $gortex) {
        exit 0
    }

    # `gortex hook` already speaks Claude Code by default, so its reply needs no
    # translation and is forwarded verbatim.
    $response = ($raw | & $gortex hook "--mode=$Mode" 2>$null | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($response)) {
        [Console]::Out.Write($response)
    }
}
catch {
    # Advisory context is never worth failing a turn over.
}

exit 0
