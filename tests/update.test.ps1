#Requires -Version 7.2
# Run with: pwsh -NoProfile -File tests/update.test.ps1
# Only the fake Gortex below is executed; no installed tools or profiles are changed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$update = Join-Path (Split-Path $PSScriptRoot -Parent) 'Update-GortexAgents.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gortex-update-test-' + [guid]::NewGuid().ToString('N'))
$fake = Join-Path $fixture 'gortex.ps1'
$log = Join-Path $fixture 'calls.jsonl'
$names = @('GORTEX_TEST_LOG', 'GORTEX_TEST_VERSION', 'GORTEX_TEST_FAIL', 'GORTEX_TEST_BAD_ADAPTER', 'GORTEX_CODEX_HOOK_MODE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$script:passed = 0

function Assert-True {
    param([bool] $Value, [string] $Message)
    if (-not $Value) { throw $Message }
}
function Get-Calls {
    if (Test-Path -LiteralPath $log) {
        foreach ($line in [IO.File]::ReadAllLines($log)) { $line | ConvertFrom-Json }
    }
}
function Reset-Fake {
    if (Test-Path -LiteralPath $log) { [IO.File]::Delete($log) }
    $env:GORTEX_TEST_VERSION = '0.64.0'
    $env:GORTEX_TEST_FAIL = ''
    $env:GORTEX_TEST_BAD_ADAPTER = ''
    $env:GORTEX_CODEX_HOOK_MODE = ''
    $codexConfig = Join-Path $env:CODEX_HOME 'config.toml'
    if (Test-Path -LiteralPath $codexConfig) { [IO.File]::Delete($codexConfig) }
}
function Check {
    param([string] $Name, [scriptblock] $Body)
    Reset-Fake
    & $Body
    $script:passed++
    Write-Host "PASS $Name"
}
function Expect-Failure {
    param([scriptblock] $Body, [string] $Pattern)
    $caught = $null
    try { & $Body } catch { $caught = $_.Exception.Message }
    Assert-True ($null -ne $caught -and $caught -match $Pattern) "Expected failure matching '$Pattern', got '$caught'."
}

try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $env:GORTEX_TEST_LOG = $log
    $env:CODEX_HOME = Join-Path $fixture 'codex'
    $env:CLAUDE_CONFIG_DIR = Join-Path $fixture 'claude'
    [IO.Directory]::CreateDirectory($env:CODEX_HOME) | Out-Null
    [IO.Directory]::CreateDirectory($env:CLAUDE_CONFIG_DIR) | Out-Null
    [IO.File]::WriteAllText($fake, @'
$call = [ordered]@{ args = @($args); codexMode = $env:GORTEX_CODEX_HOOK_MODE }
[IO.File]::AppendAllText($env:GORTEX_TEST_LOG, (($call | ConvertTo-Json -Compress) + [Environment]::NewLine))
$global:LASTEXITCODE = 0
if ($args[0] -eq $env:GORTEX_TEST_FAIL) { $global:LASTEXITCODE = 7; return }
switch ($args[0]) {
    'version' { "gortex v$env:GORTEX_TEST_VERSION" }
    'upgrade' { $env:GORTEX_TEST_VERSION = '0.64.0'; 'already latest' }
    'install' {
        if ($env:GORTEX_TEST_BAD_ADAPTER -eq '1') {
            '{"agents":[{"name":"codex","detected":true,"configured":false,"warnings":["setup failed"]}]}'
        } else {
            '{"agents":[{"name":"codex","detected":true,"configured":true}]}'
        }
    }
    default { 'ok' }
}
'@)

    Check 'refresh without upgrade or custom config writing' {
        & $update -GortexPath $fake -Agents codex
        $calls = @(Get-Calls)
        Assert-True (@($calls | Where-Object { $_.args[0] -eq 'upgrade' }).Count -eq 0) 'Default refresh upgraded the binary.'
        $installs = @($calls | Where-Object { $_.args[0] -eq 'install' })
        Assert-True ($installs.Count -eq 1) 'Expected exactly one native install.'
        Assert-True ($installs[0].args -contains '--yes' -and $installs[0].args -contains '--json') 'Install must be noninteractive and report adapter results.'
        Assert-True ($installs[0].args -contains '--agents=codex') 'Agent selection was lost.'
        Assert-True ($installs[0].args -contains '--hook-mode=deny' -and $installs[0].codexMode -eq 'deny') 'All native providers must be installed in deny mode.'
        Assert-True (@($calls | Where-Object { $_.args[0] -eq 'doctor' }).Count -eq 1) 'Native doctor did not run.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml'))) 'Wrapper wrote provider config itself.'
    }
    Check 'already-current upgrade still refreshes configuration' {
        & $update -GortexPath $fake -Upgrade
        $commands = @((Get-Calls) | ForEach-Object { $_.args[0] })
        Assert-True ($commands -contains 'upgrade' -and $commands -contains 'install') 'Upgrade skipped explicit configuration refresh.'
        Assert-True ([Array]::IndexOf($commands, 'upgrade') -lt [Array]::IndexOf($commands, 'install')) 'Configuration refreshed before binary upgrade.'
    }
    Check 'preview never invokes the binary or network' {
        & $update -GortexPath $fake -Upgrade -Profile full -WhatIf
        Assert-True (@(Get-Calls).Count -eq 0) 'WhatIf executed a subprocess.'
    }
    Check 'old binary requires upgrade but can be upgraded' {
        $env:GORTEX_TEST_VERSION = '0.63.3'
        Expect-Failure { & $update -GortexPath $fake } '0\.64'
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'install' }).Count -eq 0) 'Old binary rewrote configuration.'
        & $update -GortexPath $fake -Upgrade
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'install' }).Count -eq 1) 'Upgrade from an older release could not finish.'
    }
    Check 'failed adapter cannot report success despite exit zero' {
        $env:GORTEX_TEST_BAD_ADAPTER = '1'
        Expect-Failure { & $update -GortexPath $fake } 'codex'
    }
    Check 'another configured provider cannot hide an omitted requested provider' {
        Expect-Failure { & $update -GortexPath $fake -Agents opencode } "Requested agent 'opencode' was not configured"
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'doctor' }).Count -eq 0) 'Health checks ran after incomplete provider installation.'
    }
    Check 'native failures stop follow-up writes' {
        $env:GORTEX_TEST_FAIL = 'upgrade'
        Expect-Failure { & $update -GortexPath $fake -Upgrade } '7'
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'install' }).Count -eq 0) 'Install ran after failed binary update.'
    }
    Check 'doctor failure is propagated' {
        $env:GORTEX_TEST_FAIL = 'doctor'
        Expect-Failure { & $update -GortexPath $fake } 'doctor'
    }
    Check 'profile switch and installation use deny regardless of caller environment' {
        $env:GORTEX_CODEX_HOOK_MODE = 'enrich'
        & $update -GortexPath $fake -Profile localization
        $calls = @(Get-Calls)
        $switch = @($calls | Where-Object { $_.args[0] -eq 'instructions' })
        Assert-True ($switch.Count -eq 1 -and $switch[0].args[1] -eq 'switch' -and $switch[0].args[2] -eq 'localization') 'Profile selection did not use native switch.'
        $install = @($calls | Where-Object { $_.args[0] -eq 'install' })[0]
        Assert-True ($install.args -contains '--hook-mode=deny' -and $install.codexMode -eq 'deny' -and $switch[0].codexMode -eq 'deny') 'Caller environment overrode the kit deny policy.'
        Assert-True ($env:GORTEX_CODEX_HOOK_MODE -eq 'enrich') 'Updater changed the caller environment.'
    }
    Check 'temporary Codex setting is restored after failed installation' {
        $env:GORTEX_CODEX_HOOK_MODE = 'suppress'
        $env:GORTEX_TEST_FAIL = 'install'
        Expect-Failure { & $update -GortexPath $fake } 'install'
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'install' })[0].codexMode -eq 'deny') 'Failure path did not request deny mode.'
        Assert-True ($env:GORTEX_CODEX_HOOK_MODE -eq 'suppress') 'Failure leaked the temporary hook mode.'
    }
    Check 'existing mixed modes are reconciled by native install in deny mode' {
        [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'config.toml'), "command = 'gortex hook --agent=codex --mode=deny'`ncommand = 'gortex hook --agent=codex --mode=enrich'")
        & $update -GortexPath $fake
        Assert-True (@((Get-Calls) | Where-Object { $_.args[0] -eq 'install' })[0].codexMode -eq 'deny') 'Existing configuration overrode the kit deny policy.'
    }
    Check 'native default enrich posture is updated to deny on every refresh' {
        [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'config.toml'), 'command = "gortex hook --agent=codex --mode=enrich"')
        & $update -GortexPath $fake
        & $update -GortexPath $fake
        $installs = @((Get-Calls) | Where-Object { $_.args[0] -eq 'install' })
        Assert-True ($installs.Count -eq 2 -and @($installs | Where-Object { $_.codexMode -ne 'deny' }).Count -eq 0) 'Refresh did not consistently request deny mode.'
        Assert-True ([string]::IsNullOrEmpty($env:GORTEX_CODEX_HOOK_MODE)) 'Installed posture leaked into caller environment.'
    }
    Write-Host "$script:passed updater tests passed."
}
finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedFixture).StartsWith('gortex-update-test-')) {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force -ErrorAction SilentlyContinue
    }
}
