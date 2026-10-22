<# First-install and program-only removal for the public protected layout.
   Normal updates use the existing transactional install-windows.ps1 helper. #>
#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory=$true)][ValidateSet('Preflight','ValidateRemoval','Initialize','Remove')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$AppDir,
  [string]$UninstallerName = ''
)
$ErrorActionPreference = 'Stop'
function Assert-Plain([string]$location) {
  $cursor = [IO.Path]::GetFullPath($location)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation paths are refused.' }
      if ($entry.Attributes -band [IO.FileAttributes]::Encrypted) { throw 'Public program files must not be EFS encrypted.' }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Get-PlainFiles([string]$directory) {
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($directory)
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($entry.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Encrypted)) { throw 'Linked or encrypted program entries are refused.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) } else { $entry }
    }
  }
}
function Assert-AdminProtected([string]$directory) {
  if (-not (Test-Path -LiteralPath $directory)) { return }
  $acl = Get-Acl -LiteralPath $directory
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $privileged = { param([string]$sid) $sid -in @('S-1-5-18','S-1-5-32-544') -or $sid.StartsWith('S-1-5-80-') }
  if (-not (& $privileged $owner)) { throw 'Program folders must be owned by Windows or Administrators.' }
  $writes = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not ($rule.FileSystemRights -band $writes)) { continue }
    $sid = $rule.IdentityReference.Value
    # Creator-owner inheritance is safe here only because parent creation rights
    # and the current owner are already restricted to privileged principals.
    if ($sid -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if (-not (& $privileged $sid)) { throw 'Program folders must not grant ordinary accounts write or ownership rights.' }
  }
}
function Assert-InteractiveOwner {
  # Alternate-credential elevation must never choose another person's profile.
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $explorers = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })
  if (-not $explorers.Count) { throw 'Setup requires an interactive Windows desktop.' }
  foreach ($explorer in $explorers) { $interactive = Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid; if ($interactive.ReturnValue -ne 0 -or $interactive.Sid -cne $owner.Value) { throw 'Use same-account administrator elevation for public setup. Alternate administrator credentials require a reviewed profile migration.' } }
  return $owner
}
function Set-OwnerFolder([string]$directory,[Security.Principal.SecurityIdentifier]$owner,[switch]$Private) {
  $null = New-Item -ItemType Directory -Path $directory
  $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($owner)
  foreach ($sid in @($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  if (-not $Private) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
  Set-Acl -LiteralPath $directory -AclObject $acl
}
try {
  $AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
  if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) { throw 'Public setup requires native 64-bit Windows PowerShell.' }
  $installHome = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Exomina'
  if (-not [string]::Equals($AppDir,(Join-Path $installHome 'App'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Public setup requires Program Files\Exomina\App.' }
  Assert-Plain $AppDir
  foreach ($directory in @([Environment]::GetFolderPath('ProgramFiles'),$installHome,$AppDir)) { Assert-AdminProtected $directory }
  if (Get-Process -Name Exomina -ErrorAction SilentlyContinue) { throw 'Close Exomina before changing program files.' }
  if ($Mode -eq 'Preflight') {
    $null = Assert-InteractiveOwner
    # electron-builder's early SetOutPath may already have created this empty
    # protected home. It must contain no App, profile, hidden file or other data.
    if (Test-Path -LiteralPath $installHome) { if (@(Get-ChildItem -LiteralPath $installHome -Force).Count) { throw 'An existing installation or profile needs an explicit migration.' } }
    Write-Output 'Public installation destination is empty and protected.'
    exit 0
  }
  if ($Mode -eq 'ValidateRemoval') { Write-Output 'Public program removal destination is protected.'; exit 0 }
  $marker = [IO.File]::ReadAllText((Join-Path $AppDir 'exomina.distribution.json')) | ConvertFrom-Json
  if ($marker.profile -cne 'public' -or $marker.manualUpdates -ne $false) { throw 'The program is not a public distribution.' }
  $stamp = [IO.File]::ReadAllText((Join-Path $AppDir 'exomina.build.json')) | ConvertFrom-Json
  $inventoryPath = Join-Path $AppDir 'exomina.release-integrity.json'
  $inventory = [IO.File]::ReadAllText($inventoryPath) | ConvertFrom-Json
  if ($inventory.format -ne 1 -or $inventory.buildId -cne $stamp.id) { throw 'Invalid public program inventory.' }
  $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $inventory.files) {
    if ($entry.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $expected.ContainsKey($entry.path)) { throw 'Invalid inventory path.' }
    $expected.Add($entry.path,$entry)
  }
  $files = @(Get-PlainFiles $AppDir)
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($AppDir.Length + 1).Replace('\','/')
    if ($relative -in @('debug.log','exomina.release-integrity.json','exomina.program.json')) { continue }
    if ($Mode -eq 'Initialize' -and $relative -in @($UninstallerName,'uninstallerIcon.ico')) { continue }
    if (-not $expected.ContainsKey($relative)) { throw "Unexpected program file: $relative" }
    $entry = $expected[$relative]
    if ($entry.size -ne $file.Length -or $entry.sha256 -cne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) { throw "Program file changed: $relative" }
    $null = $expected.Remove($relative)
  }
  if ($expected.Count) { throw 'Program files are missing.' }
  if ($Mode -eq 'Initialize') {
    foreach ($name in @('Private','Workspace','Source','Setup')) { if (Test-Path -LiteralPath (Join-Path $installHome $name)) { throw 'An existing profile needs an explicit migration.' } }
    $owner = Assert-InteractiveOwner
    if ($UninstallerName -notmatch '^Uninstall[^\\/:]*\.exe$') { throw 'Invalid setup uninstaller name.' }
    $uninstaller = Join-Path $AppDir $UninstallerName
    if ((Get-AuthenticodeSignature -LiteralPath $uninstaller).Status -ne 'Valid') { throw 'The setup uninstaller signature is invalid.' }
    Set-OwnerFolder (Join-Path $installHome 'Private') $owner -Private
    Set-OwnerFolder (Join-Path $installHome 'Workspace') $owner
    Set-OwnerFolder (Join-Path $installHome 'Source') $owner
    foreach ($name in @('data','accounts')) { $null = New-Item -ItemType Directory -Path (Join-Path $installHome ('Private\'+$name)) }
    $source = Join-Path $AppDir 'exomina-source\files'
    foreach ($file in @(Get-PlainFiles $source)) {
      $destination = Join-Path (Join-Path $installHome 'Source') $file.FullName.Substring($source.Length+1)
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
      [IO.File]::WriteAllBytes($destination,[IO.File]::ReadAllBytes($file.FullName))
    }
    $null = New-Item -ItemType Directory -Path (Join-Path $installHome 'Setup')
    [IO.File]::Move($uninstaller,(Join-Path $installHome 'Setup\Uninstall.exe'))
    if (Test-Path -LiteralPath (Join-Path $AppDir 'uninstallerIcon.ico')) { Remove-Item -LiteralPath (Join-Path $AppDir 'uninstallerIcon.ico') }
    Write-Output 'Public installation initialized. Private data is protected on first launch.'
  } else {
    # Every program entry was verified before the first deletion; sibling data stays.
    foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
    $directories = @(Get-ChildItem -LiteralPath $AppDir -Directory -Recurse -Force | Sort-Object FullName -Descending)
    foreach ($directory in $directories) { Remove-Item -LiteralPath $directory.FullName }
    Remove-Item -LiteralPath $AppDir
    Write-Output 'Program removed. Private, Workspace and Source were kept.'
  }
  exit 0
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
