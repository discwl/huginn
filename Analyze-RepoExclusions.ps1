<#
.SYNOPSIS
    Recommends Gortex exclude patterns for a repository.

.DESCRIPTION
    Gortex already honours .gitignore, so the useful work is finding the two
    cases .gitignore gets wrong for a code graph:

      1. Tracked but generated. Migrations, lockfiles, minified bundles and
         designer files are committed on purpose, so git keeps them, but they
         bloat the index and teach the graph nothing. These need explicit
         exclude patterns.

      2. Ignored but valuable. Local dev scripts, documentation and Obsidian
         vaults are ignored on purpose, yet they are exactly what an agent
         should be able to read. These need re-include patterns ('!path/').

    Sizes come from `git ls-tree -l`, which reads blob metadata rather than
    walking the working tree, so this stays fast on very large repositories.

    The script only reports. Nothing is written to Gortex config; copy the
    emitted block into the repo's entry in ~/.gortex/config.yaml, or pass it to
    Manage-GortexWorktree.ps1 via -ExcludePattern.

.EXAMPLE
    .\Analyze-RepoExclusions.ps1 -RepositoryPath C:\Repos\my-repo
#>
[CmdletBinding()]
param(
    [string] $RepositoryPath = (Get-Location).Path,

    # Tracked files at or above this size are reported individually.
    [int] $LargeFileKb = 512,

    # Generated-code patterns are only suggested once they carry real weight.
    [int] $MinimumFileCount = 5,

    # Evidence required before recommending an ignored directory be re-indexed.
    [int] $MinimumSignalFiles = 3,

    # A pattern matching few files still qualifies once it carries this many
    # bytes. A single 994 KB lockfile is worth excluding; five 1 KB files are
    # not, so size and count are separate tests rather than one combined score.
    [int] $MinimumPatternKb = 256,

    [switch] $IncludeAllCandidates
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Git {
    param([Parameter(Mandatory)][string[]] $Arguments)

    Push-Location $RepositoryPath
    try {
        $output = & git @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return @()
        }
        return @($output)
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $RepositoryPath -PathType Container)) {
    throw "Repository not found: $RepositoryPath"
}

$insideRepo = Invoke-Git @('rev-parse', '--is-inside-work-tree')
if ($insideRepo -ne 'true') {
    throw "Not a git repository: $RepositoryPath"
}

Write-Host "[analyze] Repository: $RepositoryPath"

# --- tracked blobs, with sizes, without touching the working tree ------------
$tracked = @()
foreach ($line in Invoke-Git @('ls-tree', '-r', '-l', 'HEAD')) {
    # <mode> blob <sha> <size>\t<path>
    $parts = $line -split "`t", 2
    if ($parts.Count -ne 2) { continue }

    $meta = $parts[0] -split '\s+' | Where-Object { $_ }
    if ($meta.Count -lt 4) { continue }

    $size = 0L
    if (-not [long]::TryParse($meta[3], [ref]$size)) { continue }

    $tracked += [pscustomobject]@{
        Path = $parts[1]
        Size = $size
        Name = [IO.Path]::GetFileName($parts[1])
    }
}

if ($tracked.Count -eq 0) {
    throw 'No tracked files found. Does HEAD exist?'
}

$totalBytes = ($tracked | Measure-Object -Property Size -Sum).Sum
Write-Host ("[analyze] Tracked: {0:N0} files, {1:N1} MB" -f $tracked.Count, ($totalBytes / 1MB))

# Ordered so the most specific rule wins when two would match the same file.
$generatedRules = [ordered]@{
    '**/Migrations/*.Designer.cs'   = 'EF Core migration designer files'
    '**/Migrations/*ModelSnapshot.cs' = 'EF Core model snapshots'
    '**/*.g.cs'                     = 'Generated C#'
    '**/*.generated.cs'             = 'Generated C#'
    '**/*.feature.cs'               = 'SpecFlow generated bindings'
    '**/*.designer.vb'              = 'Generated VB designer files'
    '**/*_pb2.py'                   = 'Generated protobuf (Python)'
    '**/*.pb.go'                    = 'Generated protobuf (Go)'
    '**/*_generated.go'             = 'Generated Go'
    '**/*.min.js'                   = 'Minified JavaScript'
    '**/*.min.css'                  = 'Minified CSS'
    '**/*.bundle.js'                = 'Bundled JavaScript'
    '**/*.map'                      = 'Source maps'
    '**/*.snap'                     = 'Jest snapshots'
    '**/package-lock.json'          = 'npm lockfile'
    '**/yarn.lock'                  = 'Yarn lockfile'
    '**/pnpm-lock.yaml'             = 'pnpm lockfile'
    '**/Cargo.lock'                 = 'Cargo lockfile'
    '**/poetry.lock'                = 'Poetry lockfile'
    '**/composer.lock'              = 'Composer lockfile'
    '**/packages.lock.json'         = 'NuGet lockfile'
}

$binaryExtensions = @(
    '.dll', '.exe', '.pdb', '.so', '.dylib', '.jar', '.nupkg', '.zip', '.7z', '.gz', '.tar',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.mp4', '.mov', '.avi', '.mp3', '.wav',
    '.pdf', '.docx', '.xlsx', '.pptx',
    '.woff', '.woff2', '.ttf', '.eot',
    '.bin', '.dat', '.mdf', '.ldf', '.bak'
)

$vendorSegments = @('node_modules', 'vendor', 'third_party', 'thirdparty', 'packages', 'dist', 'build', 'out', 'bin', 'obj', 'wwwroot/lib', 'coverage', '.venv', 'venv', '__pycache__')

function Test-GlobMatch {
    param([string] $Path, [string] $Pattern)

    # Gortex patterns are gitignore-flavoured; only the shapes emitted here need
    # to be understood, so a translation to regex is enough for the report.
    $regex = [regex]::Escape($Pattern)
    $regex = $regex -replace '\\\*\\\*/', '(?:.*/)?'
    $regex = $regex -replace '\\\*\\\*', '.*'
    $regex = $regex -replace '\\\*', '[^/]*'
    $regex = $regex -replace '\\\?', '[^/]'
    return $Path -match ('^' + $regex + '$')
}

$excludeCandidates = @()

foreach ($pattern in $generatedRules.Keys) {
    $matched = @($tracked | Where-Object { Test-GlobMatch $_.Path $pattern })
    if ($matched.Count -eq 0) { continue }
    $matchedBytes = ($matched | Measure-Object -Property Size -Sum).Sum
    if ($matched.Count -lt $MinimumFileCount -and $matchedBytes -lt ($MinimumPatternKb * 1KB) -and -not $IncludeAllCandidates) { continue }

    $excludeCandidates += [pscustomobject]@{
        Pattern = $pattern
        Files   = $matched.Count
        Bytes   = ($matched | Measure-Object -Property Size -Sum).Sum
        Reason  = $generatedRules[$pattern]
    }
}

# Vendored or build output that was committed rather than ignored.
foreach ($segment in $vendorSegments) {
    $matched = @($tracked | Where-Object { $_.Path -like "*/$segment/*" -or $_.Path -like "$segment/*" })
    if ($matched.Count -lt $MinimumFileCount) { continue }

    $excludeCandidates += [pscustomobject]@{
        Pattern = "**/$segment/"
        Files   = $matched.Count
        Bytes   = ($matched | Measure-Object -Property Size -Sum).Sum
        Reason  = 'Committed dependency or build output'
    }
}

# Binary assets carry no symbols and are pure index weight.
$binaryMatched = @($tracked | Where-Object { $binaryExtensions -contains [IO.Path]::GetExtension($_.Name).ToLowerInvariant() })
if ($binaryMatched.Count -gt 0) {
    $byExtension = $binaryMatched | Group-Object { [IO.Path]::GetExtension($_.Name).ToLowerInvariant() } |
        Sort-Object { ($_.Group | Measure-Object -Property Size -Sum).Sum } -Descending
    foreach ($group in $byExtension) {
        if ($group.Count -lt $MinimumFileCount -and -not $IncludeAllCandidates) { continue }
        $excludeCandidates += [pscustomobject]@{
            Pattern = "**/*$($group.Name)"
            Files   = $group.Count
            Bytes   = ($group.Group | Measure-Object -Property Size -Sum).Sum
            Reason  = 'Binary asset'
        }
    }
}

$excludeCandidates = @($excludeCandidates | Sort-Object Bytes -Descending)

# --- ignored content that an agent probably still wants ----------------------
$ignoredEntries = @(Invoke-Git @('ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'))

function Test-ArtifactPath {
    param([Parameter(Mandatory)][string] $RelativePath)

    # A fully-ignored .NET project directory contains nothing but obj\ output,
    # whose project.assets.json and *.nuget.g.props otherwise register as
    # "local dev config" and recommend re-including build artifacts.
    foreach ($segment in ($RelativePath -split '[\\/]')) {
        if ($vendorSegments -contains $segment) { return $true }
        if ($segment -in @('.vs', '.idea', 'TestResults', 'Debug', 'Release')) { return $true }
    }

    return $false
}

function Get-SignalFiles {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string[]] $Include
    )

    return @(
        Get-ChildItem -LiteralPath $Root -Recurse -File -Include $Include -ErrorAction SilentlyContinue |
            Where-Object { -not (Test-ArtifactPath $_.FullName.Substring($Root.Length).TrimStart('\', '/')) } |
            Select-Object -First 200
    )
}

$includeCandidates = @()
foreach ($entry in $ignoredEntries) {
    $relative = $entry.TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }

    $full = Join-Path $RepositoryPath ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }

    # Skip the obvious dependency and build caches - re-including those is what
    # made the index slow in the first place.
    $leaf = Split-Path -Leaf $relative
    if ($vendorSegments -contains $leaf) { continue }
    if ($leaf -in @('.git', '.vs', '.idea', 'TestResults', 'logs')) { continue }

    $docs = @(Get-SignalFiles -Root $full -Include @('*.md', '*.mdx', '*.canvas', '*.txt', '*.adoc'))
    $isVault = Test-Path -LiteralPath (Join-Path $full '.obsidian') -PathType Container
    $scripts = @(Get-SignalFiles -Root $full -Include @('*.ps1', '*.sh', '*.py', '*.sql', '*.json', '*.yaml', '*.yml'))

    # Weak signals are almost always leftover build output, so real evidence is
    # required before recommending that an ignored directory be re-indexed.
    if (-not $isVault -and ($docs.Count + $scripts.Count) -lt $MinimumSignalFiles) { continue }

    $reason = if ($isVault) { 'Obsidian vault' }
        elseif ($docs.Count -ge $scripts.Count) { 'Documentation' }
        else { 'Local dev scripts or config' }

    $includeCandidates += [pscustomobject]@{
        Path    = $relative
        Docs    = $docs.Count
        Scripts = $scripts.Count
        Reason  = $reason
    }
}

$includeCandidates = @($includeCandidates | Sort-Object { $_.Docs + $_.Scripts } -Descending)

# --- report ------------------------------------------------------------------
$largeFiles = @($tracked | Where-Object { $_.Size -ge ($LargeFileKb * 1KB) } | Sort-Object Size -Descending | Select-Object -First 15)

Write-Host ''
Write-Host '=== Exclude candidates (tracked, but generated or binary) ==='
if ($excludeCandidates.Count -gt 0) {
    $excludeCandidates | Select-Object `
        @{n = 'Pattern'; e = { $_.Pattern } },
        @{n = 'Files'; e = { $_.Files } },
        @{n = 'MB'; e = { [math]::Round($_.Bytes / 1MB, 2) } },
        @{n = 'Reason'; e = { $_.Reason } } |
        Format-Table -AutoSize | Out-String -Width 160 | Write-Host
}
else {
    Write-Host '  none found'
}

Write-Host '=== Re-include candidates (ignored, but useful to an agent) ==='
if ($includeCandidates.Count -gt 0) {
    $includeCandidates | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
}
else {
    Write-Host '  none found'
}

Write-Host "=== Largest tracked files (>= $LargeFileKb KB) ==="
if ($largeFiles.Count -gt 0) {
    $largeFiles | Select-Object `
        @{n = 'KB'; e = { [math]::Round($_.Size / 1KB) } },
        @{n = 'Path'; e = { $_.Path } } |
        Format-Table -AutoSize | Out-String -Width 160 | Write-Host
}
else {
    Write-Host '  none found'
}

# Measure-Object returns nothing at all for an empty pipeline, and Set-StrictMode
# turns the resulting $null.Sum into a terminating error — so a repository with no
# exclude candidates would crash here instead of printing its re-include block.
$excludedBytes = 0
if ($excludeCandidates.Count -gt 0) {
    $excludedBytes = ($excludeCandidates | Measure-Object -Property Bytes -Sum).Sum
}

Write-Host ('[analyze] Applying every suggestion removes {0:N1} MB of {1:N1} MB ({2:N0}%).' -f `
    ($excludedBytes / 1MB), ($totalBytes / 1MB), (100 * $excludedBytes / [Math]::Max(1, $totalBytes)))

# --- emit a ready-to-paste block --------------------------------------------
Write-Host ''
Write-Host '=== Paste into the repo entry in ~/.gortex/config.yaml ==='
Write-Host '      exclude:'

# Re-includes are emitted first: a later exclude must not shadow them.
foreach ($candidate in $includeCandidates) {
    Write-Host ("        - '!{0}/'" -f $candidate.Path)
    Write-Host ("        - '!{0}/**'" -f $candidate.Path)
}

# Re-including a directory also re-admits its build output, so each re-include
# is paired with the excludes that keep that output out of the index.
foreach ($candidate in $includeCandidates) {
    foreach ($artifact in @('bin', 'obj', 'node_modules')) {
        Write-Host ("        - '{0}/**/{1}/'" -f $candidate.Path, $artifact)
    }
}

foreach ($candidate in $excludeCandidates) {
    Write-Host ("        - '{0}'" -f $candidate.Pattern)
}

Write-Host ''
Write-Host '[analyze] Review before applying. Re-include pairs already carry their bin/obj/node_modules'
Write-Host '[analyze] excludes; drop any that do not apply to this repository.'

[pscustomobject]@{
    Repository        = $RepositoryPath
    TrackedFiles      = $tracked.Count
    TrackedMB         = [math]::Round($totalBytes / 1MB, 2)
    ExcludeCandidates = $excludeCandidates
    IncludeCandidates = $includeCandidates
    ReclaimableMB     = [math]::Round($excludedBytes / 1MB, 2)
}
