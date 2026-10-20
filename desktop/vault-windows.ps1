$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
$phase = 'validation'
$temporaryPfx = $null
$securePassword = $null

function Deny([string]$message) { throw [System.InvalidOperationException]::new($message) }
function Assert-NoReparse([string]$value) {
  $current = [System.IO.Path]::GetFullPath($value)
  while ($current) {
    if ([System.IO.File]::Exists($current) -or [System.IO.Directory]::Exists($current)) {
      if (([System.IO.File]::GetAttributes($current) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Deny 'The vault cannot contain or pass through a symbolic link, junction, or cloud placeholder.' }
    }
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }; $current = $parent.FullName
  }
}
function Get-Entries([string]$root) {
  Assert-NoReparse $root
  $result = [System.Collections.Generic.List[System.IO.FileSystemInfo]]::new()
  $pending = [System.Collections.Generic.Stack[string]]::new(); $pending.Push($root)
  while ($pending.Count -gt 0) {
    $folder = $pending.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $folder -Force)) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Deny 'The vault contains a symbolic link, junction, or cloud placeholder. Choose a dedicated local folder.' }
      if ($entry.FullName.Length -gt 32000) { Deny 'A vault file path exceeds the supported Windows extended-path limit.' }
      if ($result.Count -ge 200000) { Deny 'The vault exceeds its file verification limit.' }
      $result.Add($entry)
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      elseif ([ExominaVaultNative]::Links($entry.FullName) -ne 1) { Deny 'The vault contains a hard-linked file. Use an independent app data copy.' }
    }
  }
  return ,$result
}
function Restrict-Access($entry) {
  Assert-NoReparse $entry.FullName
  $acl = if ($entry.PSIsContainer) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($script:userSid)
  $inherit = if ($entry.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in @($script:userSid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $entry.FullName -AclObject $acl
}
function Verify-Entries([string]$root, [string]$thumbprint = '') {
  # Inspect every entry in one native traversal. Windows recipient queries are
  # bounded to eight workers; completion is awaited before any success response.
  # No audit result is cached or reused across launches.
  $result = [ExominaFastAudit]::Inspect($root, $script:userSid.Value, $thumbprint, 8)
  return @{files=$result.Files;directories=$result.Directories;encrypted=($result.Unencrypted -eq 0);unencryptedEntries=$result.Unencrypted;emptyUnencryptedFiles=$result.EmptyUnencrypted;restrictedAccess=($result.UnsafeAccess -eq 0)}
}
function Current-Certificate {
  $display = (& $script:cipher /y 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { Deny 'Windows has no usable EFS certificate. Prepare the empty recovery probe first.' }
  $matches = [regex]::Matches($display, '(?im)^[ \t]*((?:[A-F0-9][ \t]*){40})\r?$')
  if ($matches.Count -ne 1) { Deny 'The current Windows EFS certificate could not be identified safely.' }
  return ($matches[0].Groups[1].Value -replace '\s','').ToUpperInvariant()
}

try {
  # A parent PowerShell 7 process may pass a module path incompatible with 5.1.
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 12000) { Deny 'The vault request exceeds its limit.' }
  $request = $raw | ConvertFrom-Json; $raw = $null
  if ($request.action -notin @('preflight','verify','startup','workspaceStartup','workspaceVerify','fingerprint','probe','protect','recovery','verifyRecovery')) { Deny 'Unknown vault operation.' }
  $root = [System.IO.Path]::GetFullPath([string]$request.path).TrimEnd('\')
  if ($root -notmatch '^[A-Za-z]:\\[^\\]+\\[^\\]+' -or $root -match '[*?\x00-\x1f]' -or $root.Substring(2).Contains(':')) { Deny 'Use a dedicated local app data folder.' }
  foreach ($reserved in @($env:USERPROFILE, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:APPDATA, $env:LOCALAPPDATA, [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('Desktop'))) {
    if ($reserved -and $root.Equals([System.IO.Path]::GetFullPath($reserved).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { Deny 'Protect a dedicated Exomina directory, never a profile, system, or documents root.' }
  }
  Assert-NoReparse $root
  if (-not [System.IO.Directory]::Exists($root)) { Deny 'Create the dedicated app data directory before vault verification.' }
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($root))
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { Deny 'EFS requires a local fixed NTFS drive. No unencrypted fallback is enabled.' }
  $script:userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $script:cipher = Join-Path $env:SystemRoot 'System32\cipher.exe'
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-interop/Vault.dll')
  if ($request.action -in @('workspaceStartup','workspaceVerify')) {
    $capabilityFile = [string]$request.capabilityFile
    if ($capabilityFile -notmatch '^[A-Za-z]:\\' -or $capabilityFile -match '[*?\x00-\x1f]' -or $capabilityFile.Substring(2).Contains(':')) { Deny 'Invalid private sandbox capability metadata path.' }
    Assert-NoReparse $capabilityFile
    if ([IO.File]::Exists($capabilityFile)) {
      # Inspect before reading; malformed, exposed or unencrypted metadata must
      # never be used to whitelist an access rule. Private vault checks remain strict.
      $trusted = [ExominaFastAudit]::InspectCapabilityFile($capabilityFile, $script:userSid.Value, [string]$request.recoveryThumbprint)
      if ($trusted.Unencrypted -ne 0 -or $trusted.UnsafeAccess -ne 0 -or (Get-Item -LiteralPath $capabilityFile).Length -gt 65536) { Deny 'Private sandbox capability metadata could not be verified.' }
      $caps = [IO.File]::ReadAllText($capabilityFile) | ConvertFrom-Json
      $sids = [System.Collections.Generic.List[string]]::new()
      foreach ($mapName in @('workspace_by_cwd','writable_root_by_path')) {
        foreach ($entry in $caps.$mapName.PSObject.Properties) {
          $candidate = [IO.Path]::GetFullPath($entry.Name.Replace('/','\')).TrimEnd('\')
          if (-not $candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { continue }
          $sid = [string]$entry.Value
          if ($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { Deny 'Invalid workspace sandbox capability identifier.' }
          $null = [Security.Principal.SecurityIdentifier]::new($sid)
          $sids.Add($sid)
        }
      }
      [ExominaFastAudit]::WorkspaceSids = $sids.ToArray()
    }
  }
  if ($request.action -eq 'fingerprint') {
    $fingerprint = [ExominaFastAudit]::Fingerprint($root, [string[]]@($request.excludeNames))
    @{ok=$true;sha256=$fingerprint.sha256;bytes=$fingerprint.bytes;files=$fingerprint.files;directories=$fingerprint.directories;streams=$fingerprint.streams;namedStreams=@($fingerprint.namedStreams.ToArray())} | ConvertTo-Json -Compress -Depth 5
    exit 0
  }
  # Probe and protection need the mutation list. Read-only operations use the
  # complete native verifier and do not repeat the PowerShell tree walk.
  $entries = if ($request.action -in @('probe','protect')) { Get-Entries $root } else { $null }
  if ($request.action -in @('startup','workspaceStartup')) {
    # Root-only startup check. Initial protection and manual recovery checks
    # retain the complete recursive audit; this result never claims to do so.
    $thumbprint = [string]$request.recoveryThumbprint
    if ($thumbprint -notmatch '^[A-F0-9]{40}$' -or $thumbprint -ne (Current-Certificate)) { Deny 'The current Windows EFS certificate does not match the saved recovery backup. Verify the matching recovery key before opening Exomina.' }
    $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $thumbprint)
    $usages = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
    if (-not $certificate.HasPrivateKey -or -not ($usages -contains '1.3.6.1.4.1.311.10.3.4')) { Deny 'The current Windows EFS private key is unavailable. Restore the verified recovery backup before opening Exomina.' }
    $checked = [ExominaFastAudit]::InspectRoot($root, $script:userSid.Value)
    $verified = @{files=$checked.Files;directories=$checked.Directories;encrypted=($checked.Unencrypted -eq 0);unencryptedEntries=$checked.Unencrypted;emptyUnencryptedFiles=$checked.EmptyUnencrypted;restrictedAccess=($checked.UnsafeAccess -eq 0);scope='root';currentCertificateVerified=$true;privateKeyPresent=$true;recoveryRecipientsVerified=$false}
    if (-not $verified.encrypted -or -not $verified.restrictedAccess) {
      if ($request.action -eq 'workspaceStartup') { Deny 'Workspace protection failed: encryption or access rules could not be verified. Your account vault is separate; no sign-in was removed.' }
      Deny 'The app data root is not protected by EFS and private access rules. Complete vault setup before opening it.'
    }
    $verified.ok=$true;$verified.supported=$true;$verified|ConvertTo-Json -Compress;exit 0
  }
  if ($request.action -eq 'probe') {
    if ($entries.Count -ne 0) { Deny 'The recovery probe must be an empty dedicated folder. Personal files were not changed.' }
    $phase = 'encryption'
    Restrict-Access (Get-Item -LiteralPath $root -Force)
    $null = & $script:cipher /e /h /b $root 2>&1
    if ($LASTEXITCODE -ne 0) { Deny 'Windows EFS could not encrypt the probe. Your Windows edition, policy, or drive may not support it. No personal data was changed.' }
    [System.IO.File]::WriteAllText((Join-Path $root 'exomina-recovery-probe.txt'), 'Exomina synthetic encryption recovery probe.', [System.Text.UTF8Encoding]::new($false))
    $thumbprint = Current-Certificate
    $verified = Verify-Entries $root $thumbprint
    if (-not $verified.encrypted -or -not $verified.restrictedAccess) { Deny 'The recovery probe failed encryption verification. No personal data was changed.' }
    $verified.ok = $true; $verified.supported = $true; $verified.thumbprint = $thumbprint
    $verified | ConvertTo-Json -Compress; exit 0
  }
  if ($request.action -in @('recovery','verifyRecovery')) {
    $phase = 'recovery'
    Import-Module (Join-Path $PSHOME 'Modules\PKI') -ErrorAction Stop
    $verified = Verify-Entries $root
    if (-not $verified.encrypted -or -not $verified.restrictedAccess) { Deny 'The recovery setup folder failed encryption or private-access verification. The recovery backup has not been read.' }
    $password = [string]$request.password
    $minimum = if ($request.action -eq 'recovery') { 16 } else { 1 }
    if ($password.Length -lt $minimum -or $password.Length -gt 1024 -or $password -match '[\x00-\x1f]') { Deny 'Enter the recovery backup password.' }
    $thumbprint = Current-Certificate
    $null = Verify-Entries $root $thumbprint
    $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $thumbprint)
    $usages = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
    if (-not $certificate.HasPrivateKey -or -not ($usages -contains '1.3.6.1.4.1.311.10.3.4')) { Deny 'The current EFS private key cannot be exported for recovery.' }
    if ($request.action -eq 'verifyRecovery') {
      $pfxPath = [string]$request.pfxPath
      if ($pfxPath -notmatch '^[A-Za-z]:\\' -or $pfxPath -notmatch '(?i)\.(pfx|p12)$' -or $pfxPath -match '[*?\x00-\x1f]' -or $pfxPath.Substring(2).Contains(':')) { Deny 'Choose a local PFX recovery backup.' }
      Assert-NoReparse $pfxPath
      $backup = Get-Item -LiteralPath $pfxPath -Force
      if ($backup.PSIsContainer -or $backup.Length -lt 100 -or $backup.Length -gt 1048576) { Deny 'This recovery backup has an invalid size.' }
      $imported = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
      try {
        $imported.Import([System.IO.File]::ReadAllBytes($pfxPath), $password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        $match = @($imported | Where-Object { $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey -and $_.GetPublicKeyString() -eq $certificate.GetPublicKeyString() })
        if ($match.Count -ne 1) { Deny 'This recovery backup does not contain the current EFS private key. Choose the matching Windows backup.' }
        @{ok=$true;verified=$true;thumbprint=$thumbprint} | ConvertTo-Json -Compress; exit 0
      } catch { Deny 'The recovery backup could not be verified. Check its password and choose the matching Windows EFS backup.' }
      finally { foreach ($item in $imported) { $item.Dispose() }; $password = $null; $request.password = $null }
    }
    $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force; $request.password = $null; $password = $null
    $temporaryPfx = Join-Path $root ('recovery-' + [Guid]::NewGuid().ToString() + '.pfx')
    $null = Export-PfxCertificate -Cert $certificate -FilePath $temporaryPfx -Password $securePassword -CryptoAlgorithmOption AES256_SHA256 -ChainOption EndEntityCertOnly -NoProperties -NoClobber
    $pfx = [System.IO.File]::ReadAllBytes($temporaryPfx)
    if ($pfx.Length -lt 100 -or $pfx.Length -gt 1048576) { Deny 'The encrypted recovery certificate has an invalid size.' }
    Remove-Item -LiteralPath $temporaryPfx -Force; $temporaryPfx = $null
    @{ok=$true;thumbprint=$thumbprint;algorithm='AES256_SHA256';pfx=[Convert]::ToBase64String($pfx)} | ConvertTo-Json -Compress; exit 0
  }
  if ($request.action -eq 'protect') {
    $thumbprint = [string]$request.recoveryThumbprint
    if ($thumbprint -notmatch '^[A-F0-9]{40}$' -or $thumbprint -ne (Current-Certificate)) { Deny 'Back up the current EFS recovery certificate before protecting personal data.' }
    # Existing encrypted files must already be recoverable with the backed-up key.
    foreach ($entry in $entries) {
      if (-not $entry.PSIsContainer -and ($entry.Attributes -band [System.IO.FileAttributes]::Encrypted) -ne 0 -and -not ([ExominaVaultNative]::Recipients($entry.FullName) -contains $thumbprint)) { Deny 'Existing encrypted data uses another certificate. Back up that certificate before continuing.' }
    }
    $phase = 'permissions'
    Restrict-Access (Get-Item -LiteralPath $root -Force)
    foreach ($entry in $entries) { Restrict-Access $entry }
    $phase = 'encryption'
    $longPaths = $root.Length -gt 240 -or @($entries | Where-Object { $_.FullName.Length -gt 240 }).Count -gt 0
    $hasReadOnly = @($entries | Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0 }).Count -gt 0
    if ($longPaths -or $hasReadOnly) {
      # cipher.exe failed on a synthetic 305-character path, including with a
      # \\?\ prefix. Framework long-path mode calls the Unicode EncryptFile API
      # successfully; verify each recipient/attribute afterward, never assume.
      $all = @((Get-Item -LiteralPath $root -Force)) + $entries.ToArray()
      $restoreReadOnly = [System.Collections.Generic.List[string]]::new()
      try {
        foreach ($entry in $all) {
          Assert-NoReparse $entry.FullName
          $attributes = [System.IO.File]::GetAttributes($entry.FullName)
          if (($attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            [System.IO.File]::SetAttributes($entry.FullName, ($attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)))
            $restoreReadOnly.Add($entry.FullName)
          }
        }
        foreach ($entry in $all) {
          Assert-NoReparse $entry.FullName
          [System.IO.File]::Encrypt($entry.FullName)
        }
      } finally {
        foreach ($file in $restoreReadOnly) { [System.IO.File]::SetAttributes($file, ([System.IO.File]::GetAttributes($file) -bor [System.IO.FileAttributes]::ReadOnly)) }
      }
    } else {
      $null = & $script:cipher /e /h /b $root 2>&1
      if ($LASTEXITCODE -ne 0) { Deny 'Windows could not protect the app directory. Keep Exomina closed.' }
      $null = & $script:cipher /e (('/s:' + $root)) /h /b 2>&1
      if ($LASTEXITCODE -ne 0) { Deny 'Windows could not encrypt every app file. Keep Exomina closed until all files are protected; no unencrypted fallback is enabled.' }
    }
    $verified = Verify-Entries $root $thumbprint
    if (-not $verified.encrypted -or -not $verified.restrictedAccess) { Deny 'Some app files failed encryption or access verification. Exomina must remain closed.' }
  } else { $verified = Verify-Entries $root ([string]$request.recoveryThumbprint) }
  if ($request.action -in @('verify','workspaceVerify') -and (-not $verified.encrypted -or -not $verified.restrictedAccess)) { Deny 'The app data directory is not fully protected by EFS and private access rules. Complete vault setup before opening it.' }
  $verified.ok = $true; $verified.supported = $true
  $verified | ConvertTo-Json -Compress
} catch {
  # PowerShell wraps exceptions from compiled methods. Preserve the actual
  # category so only vanished entries trigger a complete bounded retry in Node.
  $failure = $_.Exception
  while ($failure.InnerException -and ($failure -is [System.Management.Automation.MethodInvocationException] -or $failure -is [System.Reflection.TargetInvocationException])) { $failure = $failure.InnerException }
  $message = if ($failure -is [System.InvalidOperationException]) { $failure.Message } else {
    switch ($phase) {
      'recovery' { 'Windows could not export the encrypted EFS recovery certificate. The key may be non-exportable. Keep personal data unchanged and use Windows certificate recovery tools.' }
      'permissions' { 'Private access rules could not be applied. Close Exomina and resolve Windows file access before continuing.' }
      'encryption' { 'Windows EFS encryption could not be verified. Check your Windows edition and drive support. No unencrypted fallback is enabled.' }
      default { 'The dedicated vault directory could not be verified. Check local NTFS support, access permissions, and that it contains no links.' }
    }
  }
  @{ok=$false;error=$message;diagnostic=@{phase=$phase;category=$failure.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;code=$failure.HResult;verification=$verified}} | ConvertTo-Json -Compress -Depth 4; exit 1
} finally {
  if ($temporaryPfx -and [System.IO.File]::Exists($temporaryPfx)) { Remove-Item -LiteralPath $temporaryPfx -Force -ErrorAction SilentlyContinue }
  if ($securePassword) { $securePassword.Dispose() }
}
