<#
.SYNOPSIS
    Bridges GitHub Copilot CLI lifecycle hooks to the Gortex hook handler.

.DESCRIPTION
    Copilot CLI 1.0.79 sends the Claude Code hook payload shape on stdin
    (hook_event_name / session_id / cwd / tool_name / tool_input) and reports
    Claude's tool names (Read, Grep, Glob, Bash), so the Gortex `claude` wire
    protocol understands its input directly.

    Two things differ, and this shim reconciles both:

      1. Copilot reports a completed tool as `tool_result.text_result_for_llm`,
         while Gortex reads `tool_response`.
      2. Gortex replies with Claude's nested
         `hookSpecificOutput.additionalContext`, but Copilot only honours a
         top-level `additionalContext` key. Verified empirically: the nested
         form is silently discarded.

    A PreToolUse denial is the exception to (2) and is forwarded verbatim.
    Copilot's tool loop acts on `permissionDecision` for preToolUse, and it
    reads the nested `hookSpecificOutput` because entries registered under the
    PascalCase event names are tagged `_vsCodeCompat` when the config loads. So
    Gortex's native reply already blocks the call without translation, and
    re-encoding it as advisory context would demote a hard block to a
    suggestion -- which is what left the graph optional under `deny`.

    The shim never fails a turn. Any error path exits 0 and emits nothing, so a
    missing binary, a stopped daemon, or malformed JSON degrades to "no extra
    context" instead of breaking the session.
#>
[CmdletBinding()]
param(
    [string] $Mode = 'deny',
    [string] $Agent = 'claude'
)

$ErrorActionPreference = 'Stop'

function Write-HookContext {
    param([string] $Context)

    if ([string]::IsNullOrWhiteSpace($Context)) {
        return
    }

    # Copilot reads a top-level additionalContext; the nested Claude shape is ignored.
    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName additionalContext -NotePropertyValue $Context
    [Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
}

function Write-HookBlock {
    param([string] $Reason)

    # Copilot aborts the turn on {"decision":"block"}. Verified empirically:
    # exit code 2 and {"continue":false} are both ignored. The block decision is
    # honoured on PreToolUse too, but the readiness gate is the only caller here
    # because a denied tool call is not the same as an unusable graph.
    $payload = New-Object psobject
    $payload | Add-Member -NotePropertyName decision -NotePropertyValue 'block'
    $payload | Add-Member -NotePropertyName reason -NotePropertyValue $Reason
    [Console]::Out.Write(($payload | ConvertTo-Json -Depth 6 -Compress))
}

function ConvertTo-GortexPayload {
    param(
        [string] $Raw,
        $Event
    )

    $hasResult = $null -ne $Event.PSObject.Properties['tool_result']
    $hasResponse = $null -ne $Event.PSObject.Properties['tool_response']
    if (-not $hasResult -or $hasResponse) {
        return $Raw
    }

    $result = $Event.tool_result
    $text = ''
    if ($result -is [string]) {
        $text = $result
    }
    elseif ($null -ne $result -and $null -ne $result.PSObject.Properties['text_result_for_llm']) {
        $text = [string] $result.text_result_for_llm
    }

    if ([string]::IsNullOrEmpty($text)) {
        return $Raw
    }

    $Event | Add-Member -NotePropertyName tool_response -NotePropertyValue $text -Force
    return ($Event | ConvertTo-Json -Depth 25 -Compress)
}

# The readiness gate is shared by every agent shim. Duplicating it per host was
# how the liveness-ordering and resolvability fixes drifted out of sync, so the
# hard part lives in one file and each shim only translates the verdict into its
# host's wire format.
. (Join-Path $PSScriptRoot 'gortex-readiness.ps1')

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

    # Copilot has no `required = true` equivalent for MCP servers (its schema is
    # only command/args/url/env/headers/timeout/tools), so parity with Codex is
    # enforced here: refuse to start a turn when the graph is unavailable.
    # Set GORTEX_COPILOT_REQUIRED=0 to bypass.
    $enforce = $env:GORTEX_COPILOT_REQUIRED -ne '0'
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
            Write-HookBlock (@(
                $verdict.Reason,
                '',
                'To proceed without the graph for this session, set GORTEX_COPILOT_REQUIRED=0.'
            ) -join [Environment]::NewLine)
            exit 0
        }

        # A wait that ended in a ready graph is worth telling the model about, so
        # it does not carry the "index is cold" assumption into its first tool call.
        if (-not [string]::IsNullOrWhiteSpace($verdict.Context)) {
            Write-HookContext $verdict.Context
            exit 0
        }
    }

    if ($null -eq $gortex) {
        exit 0
    }

    # Canonicalise after the tool_result translation so both rewrites land on
    # one payload. Copilot sends the Claude tool shape, so it reaches the same
    # tracked-repo comparison, and a shell command it emits is no more
    # normalised on the way in than Claude's is.
    $payload = ConvertTo-GortexNormalizedPayload (ConvertTo-GortexPayload -Raw $raw -Event $event)
    $response = ($payload | & $gortex hook "--agent=$Agent" "--mode=$Mode" 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($response)) {
        exit 0
    }

    try {
        $parsed = $response | ConvertFrom-Json
    }
    catch {
        exit 0
    }

    $nested = $null
    if ($null -ne $parsed.PSObject.Properties['hookSpecificOutput']) {
        $nested = $parsed.hookSpecificOutput
    }

    # A denial must reach Copilot in the shape Gortex produced it. Copilot's
    # tool loop acts on permissionDecision for preToolUse -- `if
    # (d?.permissionDecision === "deny")` marks the call denied and the tool
    # never runs -- and it reads the nested hookSpecificOutput because
    # entries registered under the PascalCase event names are tagged
    # _vsCodeCompat during config load. Re-encoding the reason as
    # additionalContext instead, as the enrichment path below does, demotes
    # a hard block to advice the model is free to ignore, which is exactly
    # the "graph is optional" failure the deny posture exists to remove.
    #
    # Both shapes are read here rather than inside the nested branch: Copilot
    # honours a top-level permissionDecision too, and a reply carrying only
    # that would otherwise fall through to the enrichment path and be dropped.
    $decision = ''
    if ($null -ne $nested -and $null -ne $nested.PSObject.Properties['permissionDecision']) {
        $decision = [string] $nested.permissionDecision
    }
    elseif ($null -ne $parsed.PSObject.Properties['permissionDecision']) {
        $decision = [string] $parsed.permissionDecision
    }

    if ($decision -eq 'deny' -or $decision -eq 'ask') {
        [Console]::Out.Write($response)
        exit 0
    }

    # Copilot honours {"decision":"block"} on PreToolUse as well. Gortex does not
    # currently emit it, but flattening it into context would silently downgrade
    # a block, so it is forwarded on the same terms as permissionDecision.
    if ($null -ne $parsed.PSObject.Properties['decision'] -and
        [string] $parsed.decision -eq 'block') {
        [Console]::Out.Write($response)
        exit 0
    }

    $context = $null
    if ($null -ne $nested) {
        if ($null -ne $nested.PSObject.Properties['additionalContext']) {
            $context = [string] $nested.additionalContext
        }
        # A posture that denies without a decision Copilot understands would
        # otherwise drop the redirect entirely, which is strictly worse than
        # 'enrich'. Fall back to the reason so the advice still lands.
        if ([string]::IsNullOrWhiteSpace($context) -and
            $null -ne $nested.PSObject.Properties['permissionDecisionReason']) {
            $context = [string] $nested.permissionDecisionReason
        }
    }
    if ([string]::IsNullOrWhiteSpace($context) -and $null -ne $parsed.PSObject.Properties['additionalContext']) {
        $context = [string] $parsed.additionalContext
    }

    Write-HookContext $context
}
catch {
    # Advisory context is never worth failing a turn over.
}

exit 0
