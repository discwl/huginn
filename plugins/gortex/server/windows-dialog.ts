// Fixed programs only. User paths travel through an environment variable, never executable text.
export const WINDOWS_PICKER_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$status = 'ready'
if ($PSVersionTable.PSVersion.Major -lt 7) {
  $status = 'powershell_version'
} else {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    foreach ($property in @('AutoUpgradeEnabled', 'UseDescriptionForTitle', 'InitialDirectory')) {
      if ($null -eq [System.Windows.Forms.FolderBrowserDialog].GetProperty($property)) { $status = 'windows_forms' }
    }
  } catch { $status = 'windows_forms' }
  if ($status -eq 'ready' -and (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0)) { $status = 'desktop' }
}
@{ status = $status } | ConvertTo-Json -Compress
`;

export const WINDOWS_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'An interactive Windows desktop is required.' }
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
try {
  $dialog.AutoUpgradeEnabled = $true
  $dialog.UseDescriptionForTitle = $true
  $dialog.Description = 'Choose a repository folder for Gortex in Paseo'
  $dialog.ShowNewFolderButton = $false
  if ($env:PASEO_GORTEX_PICKER_START) { $dialog.InitialDirectory = $env:PASEO_GORTEX_PICKER_START }
  $answer = $dialog.ShowDialog()
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ state = 'selected'; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
  } else {
    @{ state = 'cancelled'; path = $null } | ConvertTo-Json -Compress
  }
} finally { $dialog.Dispose() }
`;

export function powershellArguments(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
