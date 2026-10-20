<#
  Installs (or updates) Exomina into one self-contained folder, by default
  C:\Program Files\Exomina:
    App\        program files (admin-only writes)
    Private\    encrypted chats, memory and account sign-ins (EFS; owner + SYSTEM only)
    Workspace\  default project folder
    Source\     optional copy of the project source (owner may modify)

  Run elevated. Private data is copied in EFS raw mode with its owner and ACLs,
  never decrypted, and existing private data at the destination is never
  overwritten. The source of a migration is left untouched.

  Update the program only:
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  First install, moving data from Documents\Exomina and the source tree:
    ... -MigrateFrom "$env:USERPROFILE\Documents\Exomina" -SourceFrom "<project folder>"
#>
#Requires -RunAsAdministrator
param(
  [string]$InstallHome = (Join-Path $env:ProgramFiles 'Exomina'),
  [string]$Build = (Join-Path $PSScriptRoot '..\release\win-unpacked'),
  [string]$MigrateFrom = '',
  [string]$SourceFrom = '',
  [string]$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string]$Report = '',
  [int]$UpdateLauncherPid = 0
)
$ErrorActionPreference = 'Stop'
$summary = [ordered]@{ installHome = $null; app = $null; migrated = @(); source = $null; shortcut = $null }
function Fail([string]$message) { throw [System.InvalidOperationException]::new($message) }
function Copy-Tree([string]$from, [string]$to, [string[]]$extra) {
  $arguments = @($from, $to) + $extra + @('/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
  & (Join-Path $env:SystemRoot 'System32\robocopy.exe') @arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Copying $from failed (robocopy exit $LASTEXITCODE)." }
}

try {
  if (Get-Process -Name Exomina -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $UpdateLauncherPid }) { Fail 'Quit Exomina (including from the tray) before installing.' }
  $InstallHome = [IO.Path]::GetFullPath($InstallHome).TrimEnd('\')
  $Build = [IO.Path]::GetFullPath($Build).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $Build 'Exomina.exe'))) { Fail "No packaged build at $Build. Run npm run package first." }
  if (Test-Path -LiteralPath (Join-Path $Build 'data')) { Fail 'The build folder unexpectedly contains app data.' }
  $ownerSid = [Security.Principal.SecurityIdentifier]::new($Owner)
  $null = New-Item -ItemType Directory -Force -Path $InstallHome
  $summary.installHome = $InstallHome

  # Program files: mirror the build, then point the app at its home folder.
  $app = Join-Path $InstallHome 'App'
  Copy-Tree $Build $app @('/MIR')
  [IO.File]::WriteAllText((Join-Path $app 'exomina.paths.json'), '{"home": ".."}', [Text.UTF8Encoding]::new($false))
  $summary.app = Join-Path $app 'Exomina.exe'

  if ($MigrateFrom) {
    $MigrateFrom = [IO.Path]::GetFullPath($MigrateFrom).TrimEnd('\')
    foreach ($name in @('Private', 'Workspace')) {
      $from = Join-Path $MigrateFrom $name; $to = Join-Path $InstallHome $name
      if (-not (Test-Path -LiteralPath $from)) { continue }
      if ((Test-Path -LiteralPath $to) -and (Get-ChildItem -LiteralPath $to -Force | Select-Object -First 1)) { Fail "$to already contains data. Nothing was overwritten." }
      # Raw EFS copy with owner and ACLs: files stay encrypted for the same certificate.
      Copy-Tree $from $to @('/E', '/COPY:DATSO', '/DCOPY:DAT', '/EFSRAW')
      $acl = Get-Acl -LiteralPath $from
      Set-Acl -LiteralPath $to -AclObject $acl
      $before = (Get-ChildItem -LiteralPath $from -Recurse -Force -File | Measure-Object Length -Sum)
      $after = (Get-ChildItem -LiteralPath $to -Recurse -Force -File | Measure-Object Length -Sum)
      if ($before.Count -ne $after.Count -or $before.Sum -ne $after.Sum) { Fail "Copy verification failed for $name ($($before.Count) vs $($after.Count) files)." }
      $summary.migrated += [ordered]@{ name = $name; files = $after.Count; bytes = $after.Sum }
    }
  }

  if ($SourceFrom) {
    $SourceFrom = [IO.Path]::GetFullPath($SourceFrom).TrimEnd('\')
    $source = Join-Path $InstallHome 'Source'
    Copy-Tree $SourceFrom $source @('/E', '/XD', (Join-Path $SourceFrom 'release'), (Join-Path $SourceFrom 'output'), (Join-Path $SourceFrom 'data'), (Join-Path $SourceFrom 'dist'))
    # The owner can edit and rebuild the source without elevation (and git
    # accepts the repository as theirs).
    & (Join-Path $env:SystemRoot 'System32\icacls.exe') $source /setowner "*$Owner" /T /C /Q | Out-Null
    $acl = Get-Acl -LiteralPath $source
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($ownerSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $source -AclObject $acl
    # Copied children carry explicit ACLs; make them inherit the grant above.
    & (Join-Path $env:SystemRoot 'System32\icacls.exe') (Join-Path $source '*') /reset /T /C /Q | Out-Null
    $summary.source = $source
  }

  # Start menu shortcut for the installing account.
  $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Exomina.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($programs)
  $link.TargetPath = $summary.app; $link.WorkingDirectory = $app; $link.IconLocation = "$($summary.app),0"; $link.Description = 'Exomina'
  $link.Save()
  $summary.shortcut = $programs
  $summary.ok = $true
} catch {
  $summary.ok = $false; $summary.error = $_.Exception.Message
}
$json = $summary | ConvertTo-Json -Depth 4
if ($Report) { [IO.File]::WriteAllText($Report, $json, [Text.UTF8Encoding]::new($false)) }
$json
if (-not $summary.ok) { exit 1 }
