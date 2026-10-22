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
  [int]$UpdateLauncherPid = 0,
  [string]$AttemptId = '',
  [string]$BuildId = '',
  [switch]$CleanupAfterLaunch,
  [string]$CleanupState = '',
  [string]$CleanupToken = '',
  [string]$KeepPrevious = '',
  [int]$CleanupTimeoutSeconds = 180,
  [string]$ExpectedManifest = '',
  [string]$ExpectedManifestHash = ''
)
$ErrorActionPreference = 'Stop'
$summary = [ordered]@{ attemptId = $AttemptId; buildId = $BuildId; installerPid = $PID; installHome = $null; app = $null; migrated = @(); source = $null; shortcut = $null }
$script:progressPhase = 'starting'
$script:verifiedFiles = 0
$script:totalFiles = 0
$script:lastProgressWrite = [DateTime]::MinValue
function Fail([string]$message) { throw [System.InvalidOperationException]::new($message) }
function Write-InstallProgress([string]$phase, [int]$verified = $script:verifiedFiles, [int]$total = $script:totalFiles, [switch]$Force) {
  $script:progressPhase = $phase
  $script:verifiedFiles = $verified
  $script:totalFiles = $total
  if (-not $Report) { return }
  $now = [DateTime]::UtcNow
  if (-not $Force -and ($now - $script:lastProgressWrite).TotalSeconds -lt 1) { return }
  $progress = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Report))) 'install-progress.json'
  $temporary = $progress + ".$PID.tmp"
  $value = [ordered]@{ attemptId = $AttemptId; buildId = $BuildId; installerPid = $PID; phase = $phase; verifiedFiles = $verified; totalFiles = $total; updatedAt = $now.ToString('o') }
  try {
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($progress)) { [IO.File]::Replace($temporary, $progress, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $progress) }
    $script:lastProgressWrite = $now
  } catch {
    # Progress is advisory; an unreadable status file must not change activation.
  }
}
function Assert-ApplicationStopped {
  if (Get-Process -Name Exomina -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $UpdateLauncherPid }) { Fail 'Quit Exomina (including from the tray) before installing.' }
}
function Get-ProgramHash([string]$file, [Security.Cryptography.HashAlgorithm]$hasher) {
  $stream = [IO.FileStream]::new($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 65536, [IO.FileOptions]::SequentialScan)
  try { return [Convert]::ToBase64String($hasher.ComputeHash($stream)) }
  finally { $stream.Dispose() }
}
function Get-ProgramFiles([string]$directory, [switch]$ExcludeRuntimeLog) {
  $runtimeLog = Join-Path ([IO.Path]::GetFullPath($directory).TrimEnd('\')) 'debug.log'
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($directory)
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      # Check the directory entry before descending; never enumerate through a link.
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'The build contains linked files or folders.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      elseif ($ExcludeRuntimeLog -and [string]::Equals($entry.FullName, $runtimeLog, [StringComparison]::OrdinalIgnoreCase)) { continue }
      else { $entry }
    }
  }
}
function Assert-ExpectedBuild([string]$directory) {
  if (-not $BuildId) { return }
  $stampFile = Join-Path $directory 'exomina.build.json'
  if ((Get-Item -LiteralPath $stampFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'The build identity file must not be a link.' }
  try { $stamp = [IO.File]::ReadAllText($stampFile) | ConvertFrom-Json }
  catch { Fail 'The build identity could not be read.' }
  if (-not ($stamp.id -is [string]) -or -not [string]::Equals($stamp.id, $BuildId, [StringComparison]::Ordinal)) { Fail "The build changed during this update attempt; expected $BuildId." }
}
function Copy-Tree([string]$from, [string]$to, [string[]]$extra) {
  $arguments = @($from, $to) + $extra + @('/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
  $details = @(& (Join-Path $env:SystemRoot 'System32\robocopy.exe') @arguments)
  $copyExit = $LASTEXITCODE
  if ($copyExit -ge 8) { Fail ("Copying $from failed (robocopy exit $copyExit). " + (($details | Select-Object -Last 20) -join [Environment]::NewLine)) }
}

function Assert-PlainDirectory([string]$directory) {
  $cursor = [IO.Path]::GetFullPath($directory)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "Linked installation folder is not allowed: $cursor" }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }; $cursor = $parent
  }
}

function Install-Program([string]$from, [string]$installRoot) {
  $installRoot = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
  $from = [IO.Path]::GetFullPath($from).TrimEnd('\')
  $app = Join-Path $installRoot 'App'
  Assert-PlainDirectory $installRoot
  Assert-PlainDirectory $from
  if ($from -eq $app -or $from.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'The build must be outside the installed App folder.' }
  foreach ($required in @('Exomina.exe', 'resources\app.asar', 'exomina.build.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $from $required) -PathType Leaf)) { Fail "The build is incomplete: $required is missing." }
  }
  # Chromium can create and hold this root log open even in the updater's Node
  # process. It is runtime output, never a release asset. Nested logs still count.
  $programFiles = @(Get-ProgramFiles $from -ExcludeRuntimeLog)
  $expectedFiles = $null
  if ($ExpectedManifest) {
    Assert-PlainDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ExpectedManifest)))
    if ((Get-Item -LiteralPath $ExpectedManifest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'Linked package receipt.' }
    # Hash and parse the same bytes from this user-owned receipt.
    $receiptBytes = [IO.File]::ReadAllBytes($ExpectedManifest)
    $receiptHasher = [Security.Cryptography.SHA256]::Create()
    try { $receiptHash = ([BitConverter]::ToString($receiptHasher.ComputeHash($receiptBytes))).Replace('-','').ToLowerInvariant() }
    finally { $receiptHasher.Dispose() }
    if ($ExpectedManifestHash -notmatch '^[a-f0-9]{64}$' -or $receiptHash -cne $ExpectedManifestHash) { Fail 'The approved package receipt changed.' }
    $receipt = [Text.Encoding]::UTF8.GetString($receiptBytes) | ConvertFrom-Json
    if ($receipt.format -ne 1) { Fail 'The approved package inventory changed.' }
    $expectedFiles = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $receipt.files) {
      if ($entry.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $expectedFiles.ContainsKey($entry.path)) { Fail 'Invalid approved package path.' }
      $expectedFiles.Add($entry.path,$entry)
    }
    # Accept old receipts containing this runtime file, while validating every
    # receipt entry and rejecting any other unexpected or duplicate path.
    $null = $expectedFiles.Remove('debug.log')
    if ($expectedFiles.Count -ne $programFiles.Count) { Fail 'The approved package inventory changed.' }
  }
  Assert-ExpectedBuild $from
  $tag = [Guid]::NewGuid().ToString('N')
  $next = Join-Path $installRoot "App.next-$tag"
  $previous = Join-Path $installRoot "App.previous-$tag"
  # These siblings are program-only directories. Private, Source and Workspace
  # are never moved or mirrored. Keep failed staging for diagnosis.
  foreach ($target in @($app, $next, $previous)) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target)) -ne $installRoot) { Fail 'The program destination escaped the installation folder.' }
    Assert-PlainDirectory $target
  }
  $null = New-Item -ItemType Directory -Path $next
  if (Test-Path -LiteralPath $app) { Set-Acl -LiteralPath $next -AclObject (Get-Acl -LiteralPath $app) }
  # Verify every program file before activation, including provider binaries.
  # Reject links rather than following a staged package outside its folder.
  Write-InstallProgress 'copying' 0 $programFiles.Count -Force
  Copy-Tree $from $next @('/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/XF', (Join-Path $from 'debug.log'))
  $count = 0
  $inventory = [Collections.Generic.List[object]]::new()
  Write-InstallProgress 'verifying' 0 $programFiles.Count -Force
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($file in $programFiles) {
      $relative = $file.FullName.Substring($from.Length + 1)
      $copy = Join-Path $next $relative
      if (-not (Test-Path -LiteralPath $copy -PathType Leaf)) { Fail "The staged program is missing $relative." }
      if ((Get-Item -LiteralPath $copy -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "The staged program contains a linked file: $relative." }
      $sourceHash = Get-ProgramHash $file.FullName $hasher
      if ($expectedFiles) {
        $key = $relative.Replace('\','/')
        if (-not $expectedFiles.ContainsKey($key)) { Fail "Unapproved package file: $relative" }
        $expected = $expectedFiles[$key]
        $hex = ([BitConverter]::ToString([Convert]::FromBase64String($sourceHash))).Replace('-','').ToLowerInvariant()
        if ($expected.size -ne $file.Length -or $expected.sha256 -cne $hex) { Fail "The checked package changed before installation: $relative" }
      }
      if ($sourceHash -cne (Get-ProgramHash $copy $hasher)) { Fail "Copy verification failed for $relative." }
      if ($relative -ne 'exomina.program.json' -and $relative -ne 'exomina.paths.json') { $inventory.Add(@{path=$relative;length=$file.Length;sha256=$sourceHash}) }
      $count++
      Write-InstallProgress 'verifying' $count $programFiles.Count
    }
  } finally {
    $hasher.Dispose()
  }
  # Copying must not adopt files added after the source enumeration, or links
  # introduced while robocopy was running. This also inspects the excluded log.
  $stagedFiles = @(Get-ProgramFiles $next)
  $programPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $programFiles) { $null = $programPaths.Add($file.FullName.Substring($from.Length + 1)) }
  if ($stagedFiles.Count -ne $programPaths.Count) { Fail 'The staged program file inventory changed.' }
  foreach ($file in $stagedFiles) {
    if (-not $programPaths.Contains($file.FullName.Substring($next.Length + 1))) { Fail 'The staged program file inventory changed.' }
  }
  Assert-ExpectedBuild $from
  Assert-ExpectedBuild $next
  # Installation identity belongs to this machine, not to the build package.
  $paths = '{"home": ".."}'
  $marker = Join-Path $app 'exomina.paths.json'
  if (Test-Path -LiteralPath $marker) {
    if ((Get-Item -LiteralPath $marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'The profile location file must not be a link.' }
    $paths = [IO.File]::ReadAllText($marker)
    $identity = $paths | ConvertFrom-Json
    if (-not ($identity.home -is [string]) -or [string]::IsNullOrWhiteSpace($identity.home)) { Fail 'The existing profile location is invalid.' }
  }
  [IO.File]::WriteAllText((Join-Path $next 'exomina.paths.json'), $paths, [Text.UTF8Encoding]::new($false))
  # This admin-owned manifest proves which files belong to this program copy.
  # Unrecognized older installations remain available for a separate audit.
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $profileMarker = Get-Item -LiteralPath (Join-Path $next 'exomina.paths.json'); $inventory.Add(@{path='exomina.paths.json';length=$profileMarker.Length;sha256=(Get-ProgramHash $profileMarker.FullName $hasher)}) }
  finally { $hasher.Dispose() }
  $directories = @(Get-ChildItem -LiteralPath $next -Directory -Recurse -Force | ForEach-Object { $_.FullName.Substring($next.Length + 1) })
  $stamp = [IO.File]::ReadAllText((Join-Path $next 'exomina.build.json')) | ConvertFrom-Json
  $manifest = @{schema=1;buildId=$stamp.id;createdAt=[DateTime]::UtcNow.ToString('o');files=@($inventory.ToArray());directories=$directories}
  [IO.File]::WriteAllText((Join-Path $next 'exomina.program.json'), ($manifest | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
  Write-InstallProgress 'activating' $count $programFiles.Count -Force
  # A manually reopened app can acquire locks while a large build is verified.
  # Check again just before moving the working installation.
  Assert-ApplicationStopped
  # Same-volume directory renames must be atomic. Move-Item can move child
  # entries individually, leaving a split installation when a file is locked.
  $moved = $false
  try {
    if (Test-Path -LiteralPath $app) { [IO.Directory]::Move($app, $previous); $moved = $true }
    [IO.Directory]::Move($next, $app)
  } catch {
    $activationError = $_.Exception.Message
    if ($moved -and -not (Test-Path -LiteralPath $app)) {
      try { [IO.Directory]::Move($previous, $app) }
      catch { Fail "Update activation failed ($activationError). Restore the previous program from $previous. Rollback failed: $($_.Exception.Message)" }
    }
    Fail "Update activation failed; the previous program was kept. $activationError"
  }
  return [ordered]@{ app = (Join-Path $app 'Exomina.exe'); previous = $(if ($moved) { $previous } else { $null }); verifiedFiles = $count }
}

function Read-CleanupJson([string]$file) {
  try {
    Assert-PlainDirectory ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file)))
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $null }
    return [IO.File]::ReadAllText($file) | ConvertFrom-Json
  } catch { return $null }
}
function Write-CleanupJson([string]$file, $value) {
  $temporary = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $stream = $null
  try {
    # CreateNew rejects an existing attacker-controlled file/link in user state.
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Depth 6 -Compress))
    $stream.Write($bytes,0,$bytes.Length); $stream.Dispose(); $stream=$null
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($temporary, $file, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $file) }
  } finally { if ($stream) { $stream.Dispose() }; if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Test-CleanupRelativePath([string]$value, [string]$directory) {
  if (-not $value -or [IO.Path]::IsPathRooted($value) -or $value -match '(^|[\\/])\.\.?([\\/]|$)' -or $value.Contains(':')) { return $false }
  $resolved = [IO.Path]::GetFullPath((Join-Path $directory $value))
  return $resolved.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Test-ProgramInventory([string]$directory, $approvedInventory = $null) {
  Assert-PlainDirectory $directory
  $manifest = if ($approvedInventory) { $approvedInventory } else { Read-CleanupJson (Join-Path $directory 'exomina.program.json') }
  $stamp = Read-CleanupJson (Join-Path $directory 'exomina.build.json')
  if ($manifest.schema -ne 1 -or -not $manifest.files -or $manifest.buildId -ne $stamp.id) { return $false }
  foreach ($name in @('Private','Workspace','Source','data','accounts','attachments','saves')) { if (Test-Path -LiteralPath (Join-Path $directory $name)) { return $false } }
  $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in $manifest.files) {
    if (-not (Test-CleanupRelativePath $item.path $directory) -or $item.path -eq 'exomina.program.json' -or $expected.ContainsKey($item.path) -or $item.length -lt 0 -or $item.sha256 -notmatch '^[A-Za-z0-9+/]{43}=$') { return $false }
    $expected.Add($item.path, $item)
  }
  # Older releases recorded the mutable root log in their program inventory.
  $null = $expected.Remove('debug.log')
  foreach ($required in @('Exomina.exe','resources\app.asar','exomina.build.json','exomina.paths.json')) { if (-not $expected.ContainsKey($required)) { return $false } }
  # Enumerate without following any link before reading or hashing descendants.
  $files = @(Get-ProgramFiles $directory -ExcludeRuntimeLog | Where-Object { $_.Name -ne 'exomina.program.json' -or $_.DirectoryName -ne $directory })
  if ($files.Count -ne $expected.Count) { return $false }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($directory.Length + 1)
      if (-not $expected.ContainsKey($relative) -or $file.Length -ne $expected[$relative].length -or (Get-ProgramHash $file.FullName $hasher) -cne $expected[$relative].sha256) { return $false }
    }
  } finally { $hasher.Dispose() }
  $expectedDirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($relative in $manifest.directories) { if (-not (Test-CleanupRelativePath $relative $directory) -or -not $expectedDirs.Add($relative)) { return $false } }
  $actualDirs = @(Get-ChildItem -LiteralPath $directory -Directory -Recurse -Force)
  if ($actualDirs.Count -ne $expectedDirs.Count) { return $false }
  foreach ($entry in $actualDirs) { if (-not $expectedDirs.Contains($entry.FullName.Substring($directory.Length + 1))) { return $false } }
  return $true
}
function Register-AuditedProgramCopy([string]$installRoot, [string]$directory, $approvedInventory) {
  # Explicit one-time bootstrap only. The updater never adopts unknown folders.
  # Its caller supplies and pins an independently audited complete inventory.
  $installRoot=[IO.Path]::GetFullPath($installRoot).TrimEnd('\');$directory=[IO.Path]::GetFullPath($directory).TrimEnd('\')
  Assert-PlainDirectory $installRoot
  $name=[IO.Path]::GetFileName($directory)
  if ([IO.Path]::GetDirectoryName($directory) -ne $installRoot -or ($name -ne 'App' -and $name -notmatch '^App\.previous-[a-f0-9]{32}$')) { throw 'The audited program copy is not an allowed installation sibling.' }
  if (-not $approvedInventory -or -not (Test-ProgramInventory $directory $approvedInventory)) { throw 'The program copy no longer matches its approved complete inventory.' }
  Write-CleanupJson (Join-Path $directory 'exomina.program.json') $approvedInventory
  if (-not (Test-ProgramInventory $directory)) { throw 'The registered program inventory could not be verified.' }
}
function Test-ProgramCopyInUse([string]$directory) {
  $programNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $files = @(Get-ProgramFiles $directory)
  foreach ($file in $files) { if ($file.Extension -eq '.exe') { $null=$programNames.Add($file.Name) } }
  # Interpreter processes may run code from this copy while their executable
  # lives elsewhere. Never persist or print their command lines.
  foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
    if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase)) -or ($process.CommandLine -and $process.CommandLine.IndexOf($directory,[StringComparison]::OrdinalIgnoreCase) -ge 0)) { return $true }
    $relevantHost=$process.Name -match '^(Exomina|electron|node|python(?:w|[0-9.]*)?|pwsh|powershell|cmd|codex|claude|grok|kimi|copilot|gemini)(?:\.exe)?$'
    if (($relevantHost -and -not $process.CommandLine) -or ($programNames.Contains($process.Name) -and -not $process.ExecutablePath)) { throw 'A relevant running program could not be inspected; this copy was kept.' }
  }
  # A loaded module or shared data handle can be absent from command lines.
  # Check that every file can be opened exclusively before deleting any file.
  foreach ($file in $files) {
    try { $stream = [IO.FileStream]::new($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $stream.Dispose() }
    catch { return $true }
  }
  return $false
}
function Test-CleanupHealth([string]$installRoot, [string]$state, [string]$token, [string]$expectedBuild) {
  $challenge = Read-CleanupJson (Join-Path $state 'program-cleanup-pending.json')
  $health = Read-CleanupJson (Join-Path $state 'program-cleanup-health.json')
  $stamp = Read-CleanupJson (Join-Path $installRoot 'App\exomina.build.json')
  if ($challenge.token -ne $token -or $challenge.buildId -ne $expectedBuild -or $health.token -ne $token -or $health.buildId -ne $expectedBuild -or $stamp.id -ne $expectedBuild -or $health.ready -ne $true) { return $false }
  try {
    $now = [DateTime]::UtcNow; $expiry = [DateTime]::Parse($challenge.expiresAt).ToUniversalTime(); $ready = [DateTime]::Parse($health.readyAt).ToUniversalTime(); $created = [DateTime]::Parse($challenge.createdAt).ToUniversalTime()
    if ($now -gt $expiry -or $ready -lt $created -or $ready -gt $now -or $now - $ready -gt [TimeSpan]::FromSeconds(3) -or $now - $created -gt [TimeSpan]::FromMinutes(5)) { return $false }
    foreach ($processId in @($health.pid,$health.rendererPid)) {
      if (-not $processId -or [int]$processId -le 0) { return $false }
      $application = Get-Process -Id ([int]$processId) -ErrorAction Stop
      if (-not [string]::Equals([IO.Path]::GetFullPath($application.Path), (Join-Path $installRoot 'App\Exomina.exe'), [StringComparison]::OrdinalIgnoreCase) -or $application.StartTime.ToUniversalTime() -lt $created.AddSeconds(-2)) { return $false }
    }
    return $true
  } catch { return $false }
}
function Remove-ObsoleteProgramCopies([string]$installRoot, [string]$protectedPrevious, [string]$protectedBuild, [string]$expectedBuild, [scriptblock]$healthCheck) {
  $installRoot = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
  Assert-PlainDirectory $installRoot
  $result = [ordered]@{deleted=@();skipped=@();errors=@();bytes=0}
  if (-not (& $healthCheck)) { throw 'The updated app has not confirmed a successful startup.' }
  Assert-PlainDirectory (Join-Path $installRoot 'App')
  $current = Read-CleanupJson (Join-Path $installRoot 'App\exomina.build.json')
  if ($current.id -ne $expectedBuild) { throw 'The installed build changed before cleanup.' }
  $currentDate = [DateTime]::MinValue
  if (-not [DateTime]::TryParse($current.builtAt, [ref]$currentDate)) { throw 'The installed build has no valid date; older copies were kept.' }
  foreach ($entry in Get-ChildItem -LiteralPath $installRoot -Directory -Force) {
    if ($entry.Name -notmatch '^App\.(previous|next)-[a-f0-9]{32}$') { continue }
    $directory = [IO.Path]::GetFullPath($entry.FullName).TrimEnd('\')
    # Every recursive delete is an exact validated sibling, never a computed child
    # of Source, Workspace, Private, the current App or an update package.
    if ([IO.Path]::GetDirectoryName($directory) -ne $installRoot) { throw 'A cleanup target escaped the installation folder.' }
    if ($directory -eq $protectedPrevious -or (-not $protectedPrevious -and $entry.Name.StartsWith('App.previous-')) -or ($protectedBuild -and ($protectedBuild -eq $directory -or $protectedBuild.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase)))) { $result.skipped += @{path=$directory;reason='rollback or active package'}; continue }
    try {
      Assert-PlainDirectory $directory
      $stamp = Read-CleanupJson (Join-Path $directory 'exomina.build.json'); $candidateDate = [DateTime]::MinValue
      if (-not [DateTime]::TryParse($stamp.builtAt, [ref]$candidateDate) -or $candidateDate.ToUniversalTime() -ge $currentDate.ToUniversalTime() -or -not (Test-ProgramInventory $directory)) { $result.skipped += @{path=$directory;reason='unrecognized, changed or newer program copy'}; continue }
      if (Test-ProgramCopyInUse $directory) { $result.skipped += @{path=$directory;reason='program copy is in use'}; continue }
      if (-not (& $healthCheck) -or (Read-CleanupJson (Join-Path $installRoot 'App\exomina.build.json')).id -ne $expectedBuild) { throw 'Update startup confirmation changed during cleanup.' }
      Assert-PlainDirectory $directory
      $bytes = (@(Get-ProgramFiles $directory) | Measure-Object -Property Length -Sum).Sum
      Remove-Item -LiteralPath $directory -Recurse -Force
      if (Test-Path -LiteralPath $directory) { throw 'The obsolete program copy still exists after cleanup.' }
      $result.deleted += $directory; $result.bytes += $bytes
    } catch { $result.errors += @{path=$directory;message=$_.Exception.Message} }
  }
  return $result
}
function Start-ProgramCleanup([string]$installRoot, [string]$previous, [string]$protectedBuild) {
  if (-not $Report) { return @{status='deferred';reason='No update state directory was supplied.'} }
  $state = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Report)); Assert-PlainDirectory $state
  $stamp = Read-CleanupJson (Join-Path $installRoot 'App\exomina.build.json')
  if ($stamp.id -notmatch '^[\w-]{8,64}$') { throw 'The installed build identity is invalid.' }
  $token = [Guid]::NewGuid().ToString('N'); $created = [DateTime]::UtcNow
  Write-CleanupJson (Join-Path $state 'program-cleanup-pending.json') @{schema=1;token=$token;buildId=$stamp.id;createdAt=$created.ToString('o');expiresAt=$created.AddSeconds($CleanupTimeoutSeconds).ToString('o')}
  $helper = Join-Path $installRoot 'App\resources\app.asar.unpacked\scripts\install-windows.ps1'
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'The installed program cleanup helper is missing.' }
  $arguments = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',('"'+$helper+'"'),'-CleanupAfterLaunch','-InstallHome',('"'+$installRoot+'"'),'-Build',('"'+$protectedBuild+'"'),'-BuildId',$stamp.id,'-CleanupState',('"'+$state+'"'),'-CleanupToken',$token,'-CleanupTimeoutSeconds',$CleanupTimeoutSeconds)
  if ($previous) { $arguments += @('-KeepPrevious',('"'+$previous+'"')) }
  $helperProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
  return @{status='awaiting-startup';pid=$helperProcess.Id;buildId=$stamp.id}
}
function Invoke-ProgramCleanupAfterLaunch {
  $installRoot = [IO.Path]::GetFullPath($InstallHome).TrimEnd('\'); $state = [IO.Path]::GetFullPath($CleanupState).TrimEnd('\')
  Assert-PlainDirectory $installRoot; Assert-PlainDirectory $state
  if ($CleanupToken -notmatch '^[a-f0-9]{32}$' -or $BuildId -notmatch '^[\w-]{8,64}$' -or $CleanupTimeoutSeconds -lt 1 -or $CleanupTimeoutSeconds -gt 180) { throw 'Invalid program cleanup handoff.' }
  if ($KeepPrevious) {
    $KeepPrevious = [IO.Path]::GetFullPath($KeepPrevious).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($KeepPrevious) -ne $installRoot -or [IO.Path]::GetFileName($KeepPrevious) -notmatch '^App\.previous-[a-f0-9]{32}$') { throw 'Invalid protected rollback path.' }
  }
  $protectedBuild = [IO.Path]::GetFullPath($Build).TrimEnd('\')
  $outcome = [ordered]@{buildId=$BuildId;status='skipped';reason='The updated app did not confirm a successful startup.';finishedAt=$null;cleanup=$null}
  $deadline = [DateTime]::UtcNow.AddSeconds($CleanupTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $pending = Read-CleanupJson (Join-Path $state 'program-cleanup-pending.json')
    if ($pending.token -ne $CleanupToken) { $outcome.reason='A newer cleanup handoff replaced this one.'; break }
    if (Test-CleanupHealth $installRoot $state $CleanupToken $BuildId) {
      # A short healthy interval catches an immediate process exit after the page loads.
      Start-Sleep -Seconds 3
      if (Test-CleanupHealth $installRoot $state $CleanupToken $BuildId) {
        $healthCheck = { Test-CleanupHealth $installRoot $state $CleanupToken $BuildId }
        $outcome.cleanup = Remove-ObsoleteProgramCopies $installRoot $KeepPrevious $protectedBuild $BuildId $healthCheck
        $outcome.status=$(if ($outcome.cleanup.errors.Count) { 'partial' } else { 'complete' }); $outcome.reason='Updated app initialized and its main window loaded.'; break
      }
    }
    Start-Sleep -Milliseconds 500
  }
  $outcome.finishedAt=[DateTime]::UtcNow.ToString('o')
  if ((Read-CleanupJson (Join-Path $state 'program-cleanup-pending.json')).token -eq $CleanupToken) {
    Write-CleanupJson (Join-Path $state 'program-cleanup-result.json') $outcome
    Remove-Item -LiteralPath (Join-Path $state 'program-cleanup-pending.json') -Force
  }
}

if ($CleanupAfterLaunch) {
  try { Invoke-ProgramCleanupAfterLaunch; exit 0 }
  catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}

try {
  Write-InstallProgress 'starting' -Force
  Assert-ApplicationStopped
  $InstallHome = [IO.Path]::GetFullPath($InstallHome).TrimEnd('\')
  $Build = [IO.Path]::GetFullPath($Build).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $Build 'Exomina.exe'))) { Fail "No packaged build at $Build. Run npm run package first." }
  if (Test-Path -LiteralPath (Join-Path $Build 'data')) { Fail 'The build folder unexpectedly contains app data.' }
  $ownerSid = [Security.Principal.SecurityIdentifier]::new($Owner)
  $null = New-Item -ItemType Directory -Force -Path $InstallHome
  $summary.installHome = $InstallHome

  # Stage and verify first; never mirror into a working installation.
  $program = Install-Program $Build $InstallHome
  $app = Join-Path $InstallHome 'App'
  $summary.app = $program.app
  $summary.previousApp = $program.previous
  $summary.verifiedFiles = $program.verifiedFiles

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
  Write-InstallProgress 'done' -Force
  # Keep existing runner/UAC behavior: the installer exits, the app reopens without
  # elevation, and this bounded helper only prunes after the app confirms startup.
  try { $summary.programCleanup = Start-ProgramCleanup $InstallHome $program.previous $Build }
  catch { $summary.programCleanup = @{status='deferred';reason=$_.Exception.Message} }
} catch {
  $summary.ok = $false; $summary.error = $_.Exception.Message
  Write-InstallProgress 'failed' -Force
}
$json = $summary | ConvertTo-Json -Depth 4
if ($Report) { [IO.File]::WriteAllText($Report, $json, [Text.UTF8Encoding]::new($false)) }
$json
if (-not $summary.ok) { exit 1 }
