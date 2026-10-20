<# Read-only production inspection and synthetic installer verification.
   Program functions are parsed from the installer and exercised only inside
   the named QA fixture directory. Fixtures are retained for diagnosis. #>
param(
  [string]$Output = (Join-Path $PSScriptRoot '..\..\Workspace\installer-repair-20261010'),
  [string]$Installer = (Join-Path $PSScriptRoot 'install-windows.ps1')
)
$ErrorActionPreference = 'Stop'
$Output = [IO.Path]::GetFullPath($Output)
$null = New-Item -ItemType Directory -Path $Output -Force
$fixtureRoot = Join-Path $Output ('installer-fixtures-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureRoot
$reportResult = [ordered]@{ passed = $false; fixtureRoot = $fixtureRoot; checks = [ordered]@{}; benchmark = $null; error = $null }
$tokens = $null; $parseErrors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($Installer), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($definition in $syntax.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  $body = $definition.Extent.Text
  # Activation now uses atomic Directory.Move. Inject only that primitive in
  # the fixture copy so the real rollback branch is still exercised.
  if ($definition.Name -eq 'Install-Program') { $body = [regex]::Replace($body, '\[IO\.Directory\]::Move\(([^,]+),\s*([^)]+)\)', 'Move-TestDirectory -From $1 -To $2') }
  . ([ScriptBlock]::Create($body))
}
$reportResult.checks.parser = $true
$script:realCopyTree = (Get-Command Copy-Tree).ScriptBlock
$script:copyMode = 'normal'
$script:lockedStream = $null
$script:applicationReopened = $false
$script:activationFailure = $false
$UpdateLauncherPid = 0
$AttemptId = 'synthetic-attempt'; $BuildId = 'synthetic-build'
$Report = ''
$script:progressPhase = 'starting'; $script:verifiedFiles = 0; $script:totalFiles = 0; $script:lastProgressWrite = [DateTime]::MinValue

# These mocks cannot start, close, or modify a real application.
function Get-Process { param([string]$Name) if ($Name -ne 'Exomina') { throw 'Unexpected process query in installer QA.' }; if ($script:applicationReopened) { [pscustomobject]@{Id=12345} } }
function Copy-Tree([string]$from, [string]$to, [string[]]$extra) {
  & $script:realCopyTree $from $to $extra
  $asset = Join-Path $to 'resources\app.asar'
  if ($script:copyMode -eq 'corrupt') { [IO.File]::WriteAllText($asset, 'SYNTHETIC-B') }
  if ($script:copyMode -eq 'lock') { $script:lockedStream = [IO.File]::Open($asset, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
  if ($script:copyMode -eq 'changed-identity') {
    foreach ($directory in @($from,$to)) { [IO.File]::WriteAllText((Join-Path $directory 'exomina.build.json'), '{"id":"changed-synthetic-build"}') }
  }
}
function Move-TestDirectory { param([string]$From, [string]$To)
  foreach ($target in @($From,$To)) { $resolved=[IO.Path]::GetFullPath($target); if (-not $resolved.StartsWith($fixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'A directory-move fixture left its approved test folder.' } }
  if ($script:activationFailure -and [IO.Path]::GetFileName($From).StartsWith('App.next-')) { $script:activationFailure = $false; throw 'Synthetic activation failure.' }
  [IO.Directory]::Move($From,$To)
}
function Assert-True([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function New-Fixture([string]$name) {
  $fixtureHome = Join-Path $fixtureRoot $name
  $build = Join-Path $fixtureHome 'build'; $app = Join-Path $fixtureHome 'App'
  $null = New-Item -ItemType Directory -Path (Join-Path $build 'resources') -Force
  $null = New-Item -ItemType Directory -Path $app -Force
  [IO.File]::WriteAllText((Join-Path $build 'Exomina.exe'), 'SYNTHETIC EXECUTABLE: NEVER RUN')
  [IO.File]::WriteAllText((Join-Path $build 'resources\app.asar'), 'SYNTHETIC-A')
  [IO.File]::WriteAllText((Join-Path $build 'exomina.build.json'), '{"id":"synthetic-build"}')
  [IO.File]::WriteAllText((Join-Path $app 'Exomina.exe'), 'OLD SYNTHETIC EXECUTABLE: NEVER RUN')
  [IO.File]::WriteAllText((Join-Path $app 'exomina.build.json'), '{"id":"old-synthetic-build"}')
  [IO.File]::WriteAllText((Join-Path $app 'exomina.paths.json'), '{"home":"../synthetic-home"}')
  return [pscustomobject]@{home=$fixtureHome;build=$build;app=$app}
}
function Assert-OldApp($fixture) {
  Assert-True ([IO.File]::ReadAllText((Join-Path $fixture.app 'exomina.build.json')) -eq '{"id":"old-synthetic-build"}') 'The working app changed on failure.'
  Assert-True ([IO.File]::ReadAllText((Join-Path $fixture.app 'exomina.paths.json')) -eq '{"home":"../synthetic-home"}') 'The profile marker changed on failure.'
}

try {
  $summaryDefinition = $syntax.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -eq 'summary' } | Select-Object -First 1
  Assert-True ([bool]$summaryDefinition) 'The installer report initialization is missing.'
  . ([ScriptBlock]::Create($summaryDefinition.Extent.Text))
  Assert-True ($summary.attemptId -eq $AttemptId -and $summary.buildId -eq $BuildId -and $summary.installerPid -eq $PID) 'The final report does not carry the attempt identity.'
  $reportResult.checks.finalReportIdentity = $true

  $success = New-Fixture 'success'
  $Report = Join-Path $success.home 'install-report.json'
  $program = Install-Program $success.build $success.home
  Write-InstallProgress 'done' -Force
  Assert-True ($program.verifiedFiles -eq 3) 'Success did not verify all three files.'
  Assert-True ([IO.File]::ReadAllText((Join-Path $success.app 'exomina.paths.json')) -eq '{"home":"../synthetic-home"}') 'The existing profile marker was not preserved.'
  Assert-True ([IO.File]::Exists((Join-Path $program.previous 'Exomina.exe'))) 'The rollback app was not retained.'
  $progress = [IO.File]::ReadAllText((Join-Path $success.home 'install-progress.json')) | ConvertFrom-Json
  Assert-True ($progress.attemptId -eq $AttemptId -and $progress.buildId -eq $BuildId -and $progress.installerPid -eq $PID -and $progress.phase -eq 'done' -and $progress.verifiedFiles -eq 3 -and $progress.totalFiles -eq 3 -and $progress.updatedAt) 'The success progress identity or counts are incorrect.'
  $reportResult.checks.successAndProfilePreservation = $true
  $reportResult.checks.attemptScopedAtomicProgress = $true

  foreach ($mode in @('corrupt','lock')) {
    $fixture = New-Fixture $mode
    $Report = Join-Path $fixture.home 'install-report.json'
    $script:copyMode = $mode
    $failure = $null
    try { $null = Install-Program $fixture.build $fixture.home } catch { $failure = $_.Exception.Message; Write-InstallProgress 'failed' -Force }
    finally { if ($script:lockedStream) { $script:lockedStream.Dispose(); $script:lockedStream = $null }; $script:copyMode = 'normal' }
    Assert-True ([bool]$failure) "$mode unexpectedly activated."
    if ($mode -eq 'corrupt') { Assert-True ($failure -match 'Copy verification failed for resources\\app.asar') 'The equal-size corruption was not detected by its hash.' }
    Assert-OldApp $fixture
    Assert-True (-not (Get-ChildItem -LiteralPath $fixture.home -Directory -Filter 'App.previous-*')) "$mode moved the working app before verification."
    Assert-True (([IO.File]::ReadAllText((Join-Path $fixture.home 'install-progress.json')) | ConvertFrom-Json).phase -eq 'failed') "$mode did not publish failed progress."
    $reportResult.checks[$mode + 'PreventsActivation'] = $true
  }

  $rollback = New-Fixture 'rollback'
  $Report = Join-Path $rollback.home 'install-report.json'
  $script:activationFailure = $true
  $failure = $null
  try { $null = Install-Program $rollback.build $rollback.home } catch { $failure = $_.Exception.Message }
  Assert-True ($failure -match 'Update activation failed; the previous program was kept') 'Activation failure did not report the rollback.'
  Assert-OldApp $rollback
  $reportResult.checks.activationFailureRollsBack = $true

  $reopened = New-Fixture 'reopened-app'
  $Report = Join-Path $reopened.home 'install-report.json'
  $script:applicationReopened = $true
  $failure = $null
  try { $null = Install-Program $reopened.build $reopened.home } catch { $failure = $_.Exception.Message }
  finally { $script:applicationReopened = $false }
  Assert-True ($failure -match 'Quit Exomina') 'The preactivation running-app check was missed.'
  Assert-OldApp $reopened
  $reportResult.checks.reopenedAppPreventsActivation = $true

  $wrongBuild = New-Fixture 'wrong-build-id'
  $Report = Join-Path $wrongBuild.home 'install-report.json'
  $BuildId = 'different-build'
  $failure = $null
  try { $null = Install-Program $wrongBuild.build $wrongBuild.home } catch { $failure = $_.Exception.Message }
  finally { $BuildId = 'synthetic-build' }
  Assert-True ($failure -match 'build changed during this update attempt') 'A mismatched waiting build was not rejected.'
  Assert-OldApp $wrongBuild
  Assert-True (-not (Get-ChildItem -LiteralPath $wrongBuild.home -Directory -Filter 'App.next-*')) 'A mismatched build was staged before its identity was checked.'
  $reportResult.checks.wrongBuildIdentityPreventsCopy = $true

  $changedBuild = New-Fixture 'changed-build-id'
  $Report = Join-Path $changedBuild.home 'install-report.json'
  $script:copyMode = 'changed-identity'
  $failure = $null
  try { $null = Install-Program $changedBuild.build $changedBuild.home } catch { $failure = $_.Exception.Message }
  finally { $script:copyMode = 'normal' }
  Assert-True ($failure -match 'build changed during this update attempt') 'A build changed after copying was not rejected.'
  Assert-OldApp $changedBuild
  Assert-True (-not (Get-ChildItem -LiteralPath $changedBuild.home -Directory -Filter 'App.previous-*')) 'A changed build moved the working app before its identity was rechecked.'
  $reportResult.checks.changedBuildIdentityPreventsActivation = $true

  $linked = New-Fixture 'linked-build'
  $external = Join-Path $fixtureRoot 'synthetic-link-target'
  $null = New-Item -ItemType Directory -Path $external
  $null = New-Item -ItemType Junction -Path (Join-Path $linked.build 'linked') -Target $external
  $Report = Join-Path $linked.home 'install-report.json'
  $failure = $null
  try { $null = Install-Program $linked.build $linked.home } catch { $failure = $_.Exception.Message }
  Assert-True ($failure -match 'linked files or folders') 'A linked build directory was not rejected.'
  Assert-OldApp $linked
  $reportResult.checks.linkedBuildRejected = $true

  foreach ($mode in @('approved-package','changed-package','changed-receipt')) {
    $fixture = New-Fixture $mode
    $Report = Join-Path $fixture.home 'install-report.json'
    $entries = @()
    foreach ($file in Get-ProgramFiles $fixture.build) { $entries += @{path=$file.FullName.Substring($fixture.build.Length+1).Replace('\','/');size=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} }
    $ExpectedManifest = Join-Path $fixture.home 'checked-package.json'
    [IO.File]::WriteAllText($ExpectedManifest, (@{format=1;files=$entries} | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
    $ExpectedManifestHash = (Get-FileHash -LiteralPath $ExpectedManifest -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($mode -eq 'changed-package') { [IO.File]::WriteAllText((Join-Path $fixture.build 'resources\app.asar'), 'SYNTHETIC-B') }
    if ($mode -eq 'changed-receipt') { [IO.File]::AppendAllText($ExpectedManifest, ' ') }
    $failure = $null
    try { $null = Install-Program $fixture.build $fixture.home } catch { $failure = $_.Exception.Message }
    finally { $ExpectedManifest=''; $ExpectedManifestHash='' }
    if ($mode -eq 'approved-package') { Assert-True (-not $failure) "Approved package failed: $failure" }
    else { Assert-True ($failure -match 'checked package changed|approved package receipt changed') "Altered approved package was not blocked: $failure"; Assert-OldApp $fixture }
    $reportResult.checks[$mode] = $true
  }

  $benchmarkRoot = Join-Path $fixtureRoot 'hash-benchmark'
  $null = New-Item -ItemType Directory -Path $benchmarkRoot
  $hashFiles = @()
  foreach ($index in 1..1000) {
    $file = Join-Path $benchmarkRoot ("small-{0:D4}.txt" -f $index)
    [IO.File]::WriteAllText($file, ('SYNTHETIC CONTENT ' + $index + ('x' * ($index % 256))))
    $hashFiles += $file
  }
  $baselineHashes = [Collections.Generic.List[string]]::new()
  $watch = [Diagnostics.Stopwatch]::StartNew()
  foreach ($file in $hashFiles) { $baselineHashes.Add((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) }
  $baselineMs = $watch.Elapsed.TotalMilliseconds
  $hasher = [Security.Cryptography.SHA256]::Create()
  $helperHashes = [Collections.Generic.List[string]]::new()
  try {
    $watch.Restart()
    foreach ($file in $hashFiles) { $helperHashes.Add((Get-ProgramHash $file $hasher)) }
    $helperMs = $watch.Elapsed.TotalMilliseconds
  } finally { $hasher.Dispose() }
  for ($index = 0; $index -lt $hashFiles.Count; $index++) {
    $hex = -join ([Convert]::FromBase64String($helperHashes[$index]) | ForEach-Object { $_.ToString('X2') })
    Assert-True ($hex -eq $baselineHashes[$index]) "Streaming SHA256 differs from Get-FileHash at file $index."
  }
  $reportResult.benchmark = [ordered]@{files=1000;getFileHashMs=[Math]::Round($baselineMs,2);streamingMs=[Math]::Round($helperMs,2);speedup=[Math]::Round($baselineMs/$helperMs,2);matchingHashes=1000}
  $reportResult.checks.streamingHashesMatchReference = $true
  $reportResult.passed = $true
} catch { $reportResult.error = $_.Exception.Message }
$reportPath = Join-Path $Output 'installer-qa-result.json'
[IO.File]::WriteAllText($reportPath, ($reportResult | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$reportResult | ConvertTo-Json -Depth 6
if (-not $reportResult.passed) { exit 1 }
