<# Exercises production installer/cleanup functions in tiny retained synthetic
   fixtures. No real Exomina, administrator launch, GUI or account data. #>
param([string]$Output = (Join-Path $PSScriptRoot '..\..\Workspace\program-cleanup-qa'), [string]$Installer = (Join-Path $PSScriptRoot 'install-windows.ps1'))
$ErrorActionPreference='Stop'
$Output=[IO.Path]::GetFullPath($Output)
$null=New-Item -ItemType Directory -Path $Output -Force
$fixtureRoot=Join-Path $Output ('fixtures-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $fixtureRoot
$reportResult=[ordered]@{passed=$false;fixtureRoot=$fixtureRoot;checks=[ordered]@{};error=$null}
$tokens=$null;$parseErrors=$null
$syntax=[Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($Installer),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors|Out-String)}
foreach($definition in $syntax.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([ScriptBlock]::Create($definition.Extent.Text))}
$reportResult.checks.productionParser=$true
$Report='';$AttemptId='synthetic-attempt';$BuildId='synthetic-build';$UpdateLauncherPid=0
$script:verifiedFiles=0;$script:totalFiles=0;$script:lastProgressWrite=[DateTime]::MinValue
$script:busyPaths=@();$script:healthProcess=$null;$script:missingRenderer=$false;$script:qaProcesses=@()
$script:productionCopyInUse=(Get-Command Test-ProgramCopyInUse).ScriptBlock
function Get-Process {param([string]$Name,[int]$Id) if($Name -eq 'Exomina'){return};if($Id){if($script:missingRenderer -and $Id -eq 124){throw 'Synthetic renderer exited.'};return $script:healthProcess};throw 'Unexpected actual process enumeration in QA.'}
function Get-CimInstance {param([string]$ClassName) if($ClassName -ne 'Win32_Process'){throw 'Unexpected CIM query.'};$script:qaProcesses}
function Test-ProgramCopyInUse([string]$directory) {$script:busyPaths.Count -gt 0}
function Assert-True([bool]$condition,[string]$message){if(-not $condition){throw $message}}
function New-Scenario([string]$name){
  $fixtureHome=Join-Path $fixtureRoot $name;$build=Join-Path $fixtureHome 'build'
  $null=New-Item -ItemType Directory -Path (Join-Path $build 'resources') -Force
  [IO.File]::WriteAllText((Join-Path $build 'Exomina.exe'),'SYNTHETIC EXECUTABLE: NEVER RUN')
  [IO.File]::WriteAllText((Join-Path $build 'resources\app.asar'),'SYNTHETIC PROGRAM')
  $old=$null;$keep=$null
  foreach($number in 1..3){
    $BuildId='synthetic-build-'+$number
    [IO.File]::WriteAllText((Join-Path $build 'exomina.build.json'),(@{id=$BuildId;builtAt=('2026-10-0'+$number+'T00:00:00Z')}|ConvertTo-Json -Compress))
    $program=Install-Program $build $fixtureHome
    if($number -eq 2){$old=$program.previous};if($number -eq 3){$keep=$program.previous}
  }
  foreach($directory in @('Private','Workspace','Source')){$null=New-Item -ItemType Directory -Path (Join-Path $fixtureHome $directory);[IO.File]::WriteAllText((Join-Path $fixtureHome ($directory+'\sentinel.txt')),'PRESERVE')}
  return [pscustomobject]@{home=$fixtureHome;build=$build;old=$old;keep=$keep;current=(Join-Path $fixtureHome 'App');buildId='synthetic-build-3'}
}
function Assert-Preserved($fixture){
  Assert-True (Test-Path -LiteralPath $fixture.current) 'Current app was removed.'
  Assert-True (Test-Path -LiteralPath $fixture.keep) 'Newest rollback was removed.'
  Assert-True (Test-Path -LiteralPath $fixture.build) 'Active build package was removed.'
  foreach($directory in @('Private','Workspace','Source')){Assert-True ([IO.File]::ReadAllText((Join-Path $fixture.home ($directory+'\sentinel.txt'))) -eq 'PRESERVE') ($directory+' data was changed.')}
}
try{
  $success=New-Scenario 'verified-success'
  Assert-True (Test-ProgramInventory $success.old) 'Production installer manifest was not accepted.'
  $outcome=Remove-ObsoleteProgramCopies $success.home $success.keep $success.build $success.buildId {$true}
  Assert-True ($outcome.deleted.Count -eq 1 -and -not (Test-Path -LiteralPath $success.old) -and $outcome.bytes -gt 0) 'Verified obsolete program was not removed.'
  Assert-Preserved $success
  $reportResult.checks.verifiedOlderCopyRemovedAndCurrentRollbackDataPreserved=$true

  $blocked=New-Scenario 'not-healthy';$failed=$false
  try{$null=Remove-ObsoleteProgramCopies $blocked.home $blocked.keep $blocked.build $blocked.buildId {$false}}catch{$failed=$true}
  Assert-True ($failed -and (Test-Path -LiteralPath $blocked.old)) 'Cleanup ran before startup health confirmation.'
  $reportResult.checks.failedStartupKeepsEveryCopy=$true

  foreach($mode in @('unknown-file','changed-file','empty-folder','missing-manifest','newer-build','linked-file','busy-copy','protected-package','missing-rollback','health-lost')){
    $fixture=New-Scenario $mode;$protectedBuild=$fixture.build;$protectedPrevious=$fixture.keep;$script:busyPaths=@();$script:healthCount=0;$health={$true}
    switch($mode){
      'unknown-file'{[IO.File]::WriteAllText((Join-Path $fixture.old 'personal.txt'),'PRESERVE')}
      'changed-file'{[IO.File]::WriteAllText((Join-Path $fixture.old 'resources\app.asar'),'CHANGEDXX PROGRAM')}
      'empty-folder'{$null=New-Item -ItemType Directory -Path (Join-Path $fixture.old 'personal')}
      'missing-manifest'{Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $fixture.old 'exomina.program.json') -Force}
      'newer-build'{[IO.File]::WriteAllText((Join-Path $fixture.old 'exomina.build.json'),'{"id":"synthetic-build-1","builtAt":"2026-10-04T00:00:00Z"}')}
      'linked-file'{$external=Join-Path $fixture.home 'external';$null=New-Item -ItemType Directory -Path $external;[IO.File]::WriteAllText((Join-Path $external 'sentinel.txt'),'PRESERVE');$null=New-Item -ItemType Junction -Path (Join-Path $fixture.old 'linked') -Target $external}
      'busy-copy'{$script:busyPaths=@((Join-Path $fixture.old 'Exomina.exe'))}
      'protected-package'{$protectedBuild=Join-Path $fixture.old 'resources'}
      'missing-rollback'{$protectedPrevious=''}
      'health-lost'{$health={$script:healthCount++;return ($script:healthCount -eq 1)}}
    }
    $null=Remove-ObsoleteProgramCopies $fixture.home $protectedPrevious $protectedBuild $fixture.buildId $health
    Assert-True (Test-Path -LiteralPath $fixture.old) ($mode+' was incorrectly deleted.')
    Assert-Preserved $fixture
    if($mode -eq 'linked-file'){Assert-True ([IO.File]::ReadAllText((Join-Path $external 'sentinel.txt')) -eq 'PRESERVE') 'Linked target was touched.'}
    $reportResult.checks[$mode+'Kept']=$true
  }
  $script:busyPaths=@()

  $busy=New-Scenario 'production-process-and-lock-check'
  $script:qaProcesses=@([pscustomobject]@{Name='node.exe';ExecutablePath='C:\synthetic\node.exe';CommandLine=('node "'+(Join-Path $busy.old 'resources\app.asar')+'"')})
  Assert-True (& $script:productionCopyInUse $busy.old) 'An external interpreter referencing the old copy was missed.'
  $script:qaProcesses=@([pscustomobject]@{Name='node.exe';ExecutablePath=$null;CommandLine=$null});$failed=$false
  try{$null=& $script:productionCopyInUse $busy.old}catch{$failed=$true}
  Assert-True $failed 'Unknown relevant runtime metadata was ignored.'
  $script:qaProcesses=@([pscustomobject]@{Name='node.exe';ExecutablePath='C:\synthetic\node.exe';CommandLine=$null});$failed=$false
  try{$null=& $script:productionCopyInUse $busy.old}catch{$failed=$true}
  Assert-True $failed 'A missing interpreter command line was ignored.'
  $script:qaProcesses=@()
  $locked=[IO.FileStream]::new((Join-Path $busy.old 'resources\app.asar'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{Assert-True (& $script:productionCopyInUse $busy.old) 'A live file handle was missed.'}finally{$locked.Dispose()}
  Assert-True (-not (& $script:productionCopyInUse $busy.old)) 'An idle program copy was incorrectly considered busy.'
  $reportResult.checks.interpreterReferencesUnknownRuntimeAndFileLocksKeepCopy=$true

  $registration=New-Scenario 'explicit-audit-registration';$approved=Read-CleanupJson (Join-Path $registration.old 'exomina.program.json')
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $registration.old 'exomina.program.json') -Force
  Register-AuditedProgramCopy $registration.home $registration.old $approved
  Assert-True (Test-ProgramInventory $registration.old) 'Exact audited legacy copy could not be registered.'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $registration.old 'exomina.program.json') -Force
  [IO.File]::WriteAllText((Join-Path $registration.old 'unknown.txt'),'PRESERVE');$failed=$false
  try{Register-AuditedProgramCopy $registration.home $registration.old $approved}catch{$failed=$true}
  Assert-True ($failed -and -not (Test-Path -LiteralPath (Join-Path $registration.old 'exomina.program.json'))) 'Changed legacy copy was admitted to automatic cleanup.'
  $failed=$false;try{Register-AuditedProgramCopy $registration.home (Join-Path $registration.home 'Source') $approved}catch{$failed=$true}
  Assert-True $failed 'A source directory was admitted as a legacy program copy.'
  $reportResult.checks.explicitLegacyAdmissionRequiresExactCompleteAuditAndAllowedPath=$true
  $exactDigest=New-Scenario 'case-sensitive-digest';$digestManifest=Read-CleanupJson (Join-Path $exactDigest.old 'exomina.program.json')
  $digest=$digestManifest.files[0].sha256;$match=[regex]::Match($digest,'[A-Za-z]');$position=$match.Index;$letter=$digest.Substring($position,1);$changed=$(if($letter -cmatch '[a-z]'){$letter.ToUpperInvariant()}else{$letter.ToLowerInvariant()})
  $digestManifest.files[0].sha256=$digest.Substring(0,$position)+$changed+$digest.Substring($position+1)
  Assert-True (-not (Test-ProgramInventory $exactDigest.old $digestManifest)) 'Base64 digest case changes were accepted.'
  $linkedRead=Join-Path $exactDigest.home 'linked-read';$null=New-Item -ItemType Junction -Path $linkedRead -Target $exactDigest.old
  Assert-True ($null -eq (Read-CleanupJson (Join-Path $linkedRead 'exomina.build.json'))) 'JSON metadata read traversed a linked ancestor.'
  $reportResult.checks.caseSensitiveDigestsAndLinkedAncestorReadsRejected=$true

  $healthFixture=New-Scenario 'health-binding';$state=Join-Path $healthFixture.home 'state';$null=New-Item -ItemType Directory -Path $state
  $created=[DateTime]::UtcNow.AddSeconds(-5);$token='a'*32
  Write-CleanupJson (Join-Path $state 'program-cleanup-pending.json') @{token=$token;buildId=$healthFixture.buildId;createdAt=$created.ToString('o');expiresAt=$created.AddMinutes(2).ToString('o')}
  $healthRecord=@{token=$token;buildId=$healthFixture.buildId;pid=123;rendererPid=124;ready=$true;readyAt=[DateTime]::UtcNow.ToString('o')}
  Write-CleanupJson (Join-Path $state 'program-cleanup-health.json') $healthRecord
  $script:healthProcess=[pscustomobject]@{Path=(Join-Path $healthFixture.current 'Exomina.exe');StartTime=$created.AddSeconds(1)}
  Assert-True (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId) 'Valid startup process was not recognized.'
  $script:missingRenderer=$true
  Assert-True (-not (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId)) 'An exited renderer was trusted.'
  $script:missingRenderer=$false
  $healthRecord.readyAt=[DateTime]::UtcNow.AddSeconds(-4).ToString('o');Write-CleanupJson (Join-Path $state 'program-cleanup-health.json') $healthRecord
  Assert-True (-not (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId)) 'A stale health heartbeat was trusted.'
  $healthRecord.readyAt=[DateTime]::UtcNow.ToString('o');Write-CleanupJson (Join-Path $state 'program-cleanup-health.json') $healthRecord
  $script:healthProcess.StartTime=$created.AddMinutes(-1)
  Assert-True (-not (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId)) 'Reused or old PID was trusted.'
  $script:healthProcess.StartTime=$created.AddSeconds(1);$script:healthProcess.Path=Join-Path $healthFixture.old 'Exomina.exe'
  Assert-True (-not (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId)) 'A different executable path was trusted.'
  $script:healthProcess.Path=Join-Path $healthFixture.current 'Exomina.exe';$healthRecord.token='b'*32
  Write-CleanupJson (Join-Path $state 'program-cleanup-health.json') $healthRecord
  Assert-True (-not (Test-CleanupHealth $healthFixture.home $state $token $healthFixture.buildId)) 'A stale handoff token was trusted.'
  $reportResult.checks.healthBindsBuildTokenExecutableAndProcessStartTime=$true
  foreach($value in @('..\outside','C:\outside','x\..\outside','resources\x:stream','/outside')){Assert-True (-not (Test-CleanupRelativePath $value $healthFixture.old)) ('Unsafe inventory path accepted: '+$value)}
  $reportResult.checks.inventoryTraversalAndAbsolutePathsRejected=$true

  # The actual worker orchestration is exercised with explicit synthetic health;
  # its real inventory/deletion code remains active inside this fixture only.
  function Test-CleanupHealth([string]$installRoot,[string]$state,[string]$token,[string]$expectedBuild){$script:helperHealthy}
  foreach($mode in @('worker-success','worker-no-startup','worker-newer-handoff','worker-partial')){
    $worker=New-Scenario $mode;$InstallHome=$worker.home;$Build=$worker.build;$BuildId=$worker.buildId;$KeepPrevious=$worker.keep
    $CleanupState=Join-Path $worker.home 'state';$null=New-Item -ItemType Directory -Path $CleanupState
    $CleanupToken='c'*32;$CleanupTimeoutSeconds=$(if($mode -eq 'worker-no-startup'){1}else{8})
    $pending=@{schema=1;token=$CleanupToken;buildId=$BuildId;createdAt=[DateTime]::UtcNow.ToString('o');expiresAt=[DateTime]::UtcNow.AddSeconds(30).ToString('o')}
    if($mode -eq 'worker-newer-handoff'){$pending.token='d'*32}
    Write-CleanupJson (Join-Path $CleanupState 'program-cleanup-pending.json') $pending
    $script:helperHealthy=$mode -ne 'worker-no-startup';$script:busyPaths=@()
    if($mode -eq 'worker-partial'){function Test-ProgramCopyInUse([string]$directory){throw 'Synthetic runtime metadata unavailable.'}}else{function Test-ProgramCopyInUse([string]$directory){$false}}
    Invoke-ProgramCleanupAfterLaunch
    $result=Read-CleanupJson (Join-Path $CleanupState 'program-cleanup-result.json')
    if($mode -eq 'worker-success'){Assert-True ($result.status -eq 'complete' -and -not (Test-Path -LiteralPath $worker.old)) 'Successful worker did not delete exactly the older copy.'}
    elseif($mode -eq 'worker-newer-handoff'){Assert-True ($null -eq $result -and (Read-CleanupJson (Join-Path $CleanupState 'program-cleanup-pending.json')).token -eq 'dddddddddddddddddddddddddddddddd') 'Older worker overwrote newer handoff state.'}
    elseif($mode -eq 'worker-partial'){Assert-True ($result.status -eq 'partial' -and $result.cleanup.errors.Count -eq 1 -and (Test-Path -LiteralPath $worker.old)) 'Partial cleanup was misreported as complete.'}
    else{Assert-True ($result.status -eq 'skipped' -and (Test-Path -LiteralPath $worker.old)) 'Worker timeout deleted an unconfirmed app copy.'}
    Assert-Preserved $worker;$reportResult.checks[$mode]=$true
  }

  $start=New-Scenario 'elevated-helper-handoff';$Report=Join-Path $start.home 'state\install-report.json';$null=New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Report))
  $helperFile=Join-Path $start.current 'resources\app.asar.unpacked\scripts\install-windows.ps1';$null=New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($helperFile)) -Force;[IO.File]::WriteAllText($helperFile,'# Synthetic helper: never execute.')
  $script:helperLaunch=$null;$CleanupTimeoutSeconds=180
  function Start-Process {param([string]$FilePath,[string[]]$ArgumentList,[string]$WindowStyle,[switch]$PassThru) $script:helperLaunch=@{file=$FilePath;args=$ArgumentList;windowStyle=$WindowStyle};[pscustomobject]@{Id=12345}}
  $launched=Start-ProgramCleanup $start.home $start.keep $start.build
  Assert-True ($launched.status -eq 'awaiting-startup' -and $script:helperLaunch.windowStyle -eq 'Hidden' -and $script:helperLaunch.args -contains '-CleanupAfterLaunch' -and $script:helperLaunch.args -contains ('"'+$helperFile+'"') -and $script:helperLaunch.args -notcontains 'RunAs') 'Cleanup handoff did not use the installed helper and existing elevation.'
  $reportResult.checks.installedHelperStartsHiddenUnderExistingElevation=$true
  $reportResult.passed=$true
}catch{$reportResult.error=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $Output 'result.json'),($reportResult|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$reportResult|ConvertTo-Json -Depth 5
if(-not $reportResult.passed){exit 1}
