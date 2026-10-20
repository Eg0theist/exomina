<#
  Started by Exomina (without elevation) just before it quits to install an update.
  Waits for Exomina to close, runs the installer shipped in the installed App folder
  through Windows' UAC consent, records the outcome and reopens Exomina unelevated.
#>
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Build,
  [Parameter(Mandatory)][string]$InstallHome,
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$State,
  [Parameter(Mandatory)][string]$BuildId,
  [Parameter(Mandatory)][string]$AttemptId,
  [Parameter(Mandatory)][int]$LauncherPid,
  [int]$BootstrapPid = 0,
  [Parameter(Mandatory)][int]$AppPid,
  [string]$ExpectedManifest = '',
  [string]$ExpectedManifestHash = ''
)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ buildId = $BuildId; attemptId = $AttemptId; status = 'failed'; message = ''; finishedAt = $null }
$report = Join-Path $State 'install-report.json'
$process = $null
function Quote([string]$value) { '"' + $value.Replace('"', '') + '"' }
function Write-State([string]$name, $value) {
  $file = Join-Path $State $name
  [IO.File]::WriteAllText($file + '.runner.tmp', ($value | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($file + '.runner.tmp') -Destination $file -Force
}
function Watch-Installer($installerProcess) {
  # Watch the returned process handle, rather than Start-Process's job wait.
  # An unknown wait result must never reopen the app while installation runs.
  while ($true) {
    Write-State 'update-watcher.json' @{attemptId=$AttemptId;buildId=$BuildId;pid=$LauncherPid;runnerPid=$PID;installerPid=$installerProcess.Id;phase='installing';updatedAt=(Get-Date).ToUniversalTime().ToString('o')}
    try { if ($installerProcess.WaitForExit(1000)) { return } }
    catch {
      if (-not (Get-Process -Id $installerProcess.Id -ErrorAction SilentlyContinue)) { return }
      Start-Sleep -Milliseconds 1000
    }
  }
}

try {
  # The app remains open until it receives this acknowledgement. If PowerShell
  # cannot start, the app keeps its window and records a recoverable failure.
  $readyPid = if ($BootstrapPid -gt 0) { $BootstrapPid } else { $LauncherPid }
  Write-State 'update-ready.json' @{attemptId=$AttemptId;pid=$readyPid;supervisorPid=$LauncherPid;runnerPid=$PID}
  $deadline = (Get-Date).AddSeconds(120)
  while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw 'Exomina did not close within two minutes, so the update was not installed.' }
    Start-Sleep -Milliseconds 300
  }
  if ($BootstrapPid -gt 0 -and $BootstrapPid -ne $LauncherPid) {
    $relayDeadline = (Get-Date).AddSeconds(10)
    while (Get-Process -Id $BootstrapPid -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $relayDeadline) { throw 'The updater launch relay did not close, so the update was not installed.' }
      Start-Sleep -Milliseconds 50
    }
  }
  Remove-Item -LiteralPath $report -Force -ErrorAction SilentlyContinue
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $arguments = '-NoProfile -File {0} -InstallHome {1} -Build {2} -Owner {3} -Report {4} -UpdateLauncherPid {5} -BuildId {6} -AttemptId {7}' -f (Quote $Installer), (Quote $InstallHome), (Quote $Build), $owner, (Quote $report), $LauncherPid, (Quote $BuildId), (Quote $AttemptId)
  if ($ExpectedManifest) { $arguments += ' -ExpectedManifest {0} -ExpectedManifestHash {1}' -f (Quote $ExpectedManifest), (Quote $ExpectedManifestHash) }
  try {
    $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
  } catch {
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    if ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) {
      $result.status = 'declined'
      $result.message = 'Windows administrator approval was declined, so the update was not installed.'
    } else { $result.message = 'The installer could not start: ' + $exception.Message }
  }
  if ($process) {
    Watch-Installer $process
    $installed = $null
    if (Test-Path -LiteralPath $report) { $installed = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json }
    $stamp = Get-Content -LiteralPath (Join-Path $InstallHome 'App\exomina.build.json') -Raw | ConvertFrom-Json
    if ($installed.attemptId -ne $AttemptId -or $installed.buildId -ne $BuildId -or $installed.installerPid -ne $process.Id) { throw 'The installer did not return a report for this update attempt.' }
    if ($process.ExitCode -eq 0 -and $installed.ok -and $stamp.id -eq $BuildId) { $result.status = 'installed' }
    else { $result.message = if ($installed.error) { [string]$installed.error } elseif ($stamp.id -ne $BuildId) { 'The installer finished without activating the requested build.' } else { "The installer exited with code $($process.ExitCode)." } }
  }
} catch {
  $result.message = $_.Exception.Message
  # A diagnostic failure does not cancel an installer that already started.
  if ($process) {
    while (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
  }
}
$result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
try {
  Write-State 'last-update.json' $result
  Write-State 'update-watcher.json' @{attemptId=$AttemptId;buildId=$BuildId;pid=$LauncherPid;runnerPid=$PID;installerPid=0;phase=$result.status;updatedAt=$result.finishedAt}
  $pendingFile = Join-Path $State 'pending-update.json'
  if (Test-Path -LiteralPath $pendingFile) {
    $pending = Get-Content -LiteralPath $pendingFile -Raw | ConvertFrom-Json
    if ($pending.attemptId -eq $AttemptId) { Remove-Item -LiteralPath $pendingFile -Force }
  }
} catch {}
# A successful installation always activates canonical App. In particular, an
# update started from a side-by-side recovery must not reopen that older copy.
# Failed or declined installations reopen the caller's previous working copy.
$reopenExe = if ($result.status -eq 'installed') { Join-Path $InstallHome 'App\Exomina.exe' } else { $Exe }
# Reopen unelevated: this runner never had administrator rights.
function Open-UpdatedProgram([string]$target) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'The executable to reopen is missing.' }
  # Not hidden: Windows applies a hidden start state to the first window the program shows, which would leave it in the tray.
  Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)
}
# The supervisor uses Electron's Node mode; the reopened app must not inherit it.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\EXOMINA_UPDATER_BOOTSTRAP_PID -ErrorAction SilentlyContinue
$reopen = [ordered]@{attemptId=$AttemptId;buildId=$BuildId;requested=$reopenExe;opened=$null;status='failed';error='';fallbackError=''}
try { Open-UpdatedProgram $reopenExe; $reopen.opened=$reopenExe; $reopen.status='launched' }
catch {
  $reopen.error=$_.Exception.Message
  # Only try the previous recovery copy once, and only if it is a different path.
  if ($result.status -eq 'installed' -and -not [string]::Equals([IO.Path]::GetFullPath($reopenExe),[IO.Path]::GetFullPath($Exe),[StringComparison]::OrdinalIgnoreCase)) {
    try { Open-UpdatedProgram $Exe; $reopen.opened=$Exe; $reopen.status='fallback' }
    catch { $reopen.fallbackError=$_.Exception.Message }
  }
  $result.message = if ($reopen.status -eq 'fallback') { 'The new build was installed, but Windows could not reopen it. The previous recovery copy was reopened: ' + $reopen.error } else { ($result.message + ' Exomina could not reopen: ' + $reopen.error).Trim() }
}
try {
  Write-State 'update-reopen.json' $reopen
  if ($reopen.error) { Write-State 'last-update.json' $result }
} catch {}
