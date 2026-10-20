$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
function Deny([string]$message) { throw [InvalidOperationException]::new($message) }
function No-Links([string]$value) {
  $current = [IO.Path]::GetFullPath($value)
  while ($current) {
    if (([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) -and (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Deny 'Private app storage cannot pass through a symbolic link, junction or cloud placeholder.' }
    $parent = [IO.Directory]::GetParent($current); if ($null -eq $parent) { break }; $current = $parent.FullName
  }
}
function Private-Access($entry) {
  $acl = Get-Acl -LiteralPath $entry.FullName
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $script:sid.Value) { return $false }
  $ownerAccess = $false
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($script:sid.Value,'S-1-5-18')) { return $false }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and $rule.IdentityReference.Value -in @($script:sid.Value,'S-1-5-18')) { return $false }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -eq $script:sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownerAccess = $true }
  }
  return $ownerAccess
}
function Restrict-Access($entry) {
  $acl = if ($entry.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($script:sid)
  $inherit = if ($entry.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($identity in @($script:sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $entry.FullName -AclObject $acl
}
try {
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
  $raw = [Console]::In.ReadToEnd(); if ($raw.Length -gt 12000) { Deny 'The profile request exceeds its limit.' }; $request = $raw | ConvertFrom-Json; $raw = $null
  if ($request.action -notin @('inspect','prepare','verify')) { Deny 'Unknown profile operation.' }
  $root = [IO.Path]::GetFullPath([string]$request.path).TrimEnd('\')
  if ($root -notmatch '^[A-Za-z]:\\[^\\]+\\[^\\]+' -or $root -match '[*?\x00-\x1f]' -or $root.Substring(2).Contains(':')) { Deny 'Use a dedicated local Exomina data directory.' }
  foreach ($reserved in @($env:USERPROFILE,$env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)},$env:APPDATA,$env:LOCALAPPDATA,[Environment]::GetFolderPath('MyDocuments'),[Environment]::GetFolderPath('Desktop'))) {
    if ($reserved -and $root.Equals([IO.Path]::GetFullPath($reserved).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) { Deny 'Use an Exomina directory, not a profile, system or documents root.' }
  }
  No-Links $root
  if (-not [IO.Directory]::Exists($root)) { Deny 'The private app data directory is missing.' }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS','ReFS')) { Deny 'Private Windows profiles require a local drive with Windows access permissions.' }
  $script:sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProfileLinks {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint attrs,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string path,uint access,uint sharing,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,out Info info);
  public static uint Count(string path) { using(var handle=CreateFileW(path.StartsWith(@"\\?\")?path:@"\\?\"+path,0,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) { if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());Info info;if(!GetFileInformationByHandle(handle,out info))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if((info.attrs&0x400)!=0)throw new InvalidOperationException("Private storage contains a reparse point.");return info.links; } }
}
'@
  $entries = [Collections.Generic.List[IO.FileSystemInfo]]::new(); $entries.Add((Get-Item -LiteralPath $root -Force)); $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
  while ($pending.Count) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Deny 'Private storage contains a symbolic link, junction or cloud placeholder.' }
      if ($entries.Count -ge 200000 -or $entry.FullName.Length -gt 32000) { Deny 'The private profile exceeds its verification limit.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) } elseif ([ProfileLinks]::Count($entry.FullName) -ne 1) { Deny 'Private storage contains a hard-linked file. Preserve the profile and use an independent copy.' }
      $entries.Add($entry)
    }
  }
  $anyEncrypted = $false; $rootEncrypted = ($entries[0].Attributes -band [IO.FileAttributes]::Encrypted) -ne 0
  foreach ($entry in $entries) {
    if (($entry.Attributes -band [IO.FileAttributes]::Encrypted) -ne 0) { $anyEncrypted = $true }
    if ((Get-Acl -LiteralPath $entry.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $script:sid.Value) { Deny 'A private profile entry belongs to another owner. Existing data was not changed.' }
  }
  if ($request.action -eq 'prepare') {
    if ($anyEncrypted) { Deny 'Existing encrypted profile files must use the EFS recovery workflow. They were not decrypted or changed.' }
    # Validate the entire owned tree before changing any access permissions.
    foreach ($entry in $entries) { if (-not (Private-Access $entry)) { Restrict-Access $entry } }
  }
  $restricted = $true; foreach ($entry in $entries) { if (-not (Private-Access $entry)) { $restricted = $false } }
  if ($request.action -eq 'verify' -and -not $restricted) { Deny 'Private app file permissions could not be confirmed.' }
  $edition = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID -ErrorAction SilentlyContinue).EditionID
  $disabled = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name NtfsDisableEncryption -ErrorAction SilentlyContinue).NtfsDisableEncryption
  $policy = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\CurrentVersion\EFS' -Name EfsConfiguration -ErrorAction SilentlyContinue).EfsConfiguration
  $available = $drive.DriveFormat -eq 'NTFS' -and $edition -match '^(Professional|Enterprise|Education|Server)' -and $disabled -ne 1 -and $policy -ne 1
  @{ok=$true;restrictedAccess=$restricted;rootEncrypted=$rootEncrypted;anyEncrypted=$anyEncrypted;efsAvailable=[bool]$available;entries=$entries.Count} | ConvertTo-Json -Compress
} catch {
  $message = if ($_.Exception -is [InvalidOperationException]) { $_.Exception.Message } else { 'Windows could not verify private profile access. Keep existing data unchanged and check your app folder permissions.' }
  @{ok=$false;error=$message} | ConvertTo-Json -Compress; exit 1
}
