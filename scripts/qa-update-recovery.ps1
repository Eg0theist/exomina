<# Production recovery functions, disposable synthetic programs only. No real
   app processes, accounts, storage settings, shortcuts or UAC are touched. #>
param([Parameter(Mandatory)][string]$Output, [Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$NodeExe)
$ErrorActionPreference='Stop'
$Output=[IO.Path]::GetFullPath($Output)
$null=New-Item -ItemType Directory -Path $Output -Force
$fixtureRoot=Join-Path $Output ('recovery-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $fixtureRoot
$tokens=$null;$errors=$null
$syntax=[Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($Installer),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
foreach($definition in $syntax.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([ScriptBlock]::Create($definition.Extent.Text))}
$reportResult=@{passed=$false;checks=@{};fixtureRoot=$fixtureRoot;scope='Production rollback/helper logic and real directory renames in disposable synthetic fixtures; no personal data or real application process access.'}
$Report='';$UpdateLauncherPid=0;$ExpectedManifest='';$ExpectedManifestHash='';$AttemptId='12345678-1234-4234-8234-123456789012'
$script:verifiedFiles=0;$script:totalFiles=0;$script:lastProgressWrite=[DateTime]::MinValue
$script:qaProcesses=@();$script:healthy=$false;$script:stops=@();$script:failSecond=$false
$script:move=(Get-Command Move-ProgramDirectory).ScriptBlock
function Get-Process {param([string]$Name,[int]$Id) if($Name -eq 'Exomina'){return}; if($Id){return $script:qaProcess};throw 'Unexpected process query.'}
function Get-CimInstance {param([string]$ClassName) if($ClassName -ne 'Win32_Process'){throw 'Unexpected process enumeration.'};return $script:qaProcesses}
function Stop-Process {param($InputObject,[switch]$Force) if($InputObject.Path -notlike ($fixtureRoot+'\*\App\Exomina.exe')){throw 'A stop left the synthetic fixture.'};$script:stops+=,$InputObject}
function Move-ProgramDirectory([string]$from,[string]$to,[int]$TimeoutMilliseconds=15000){
  foreach($target in @($from,$to)){if(-not [IO.Path]::GetFullPath($target).StartsWith($fixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'A move left the synthetic fixture.'}}
  if($script:failSecond -and [IO.Path]::GetFileName($from) -like 'App.previous-*'){$script:failSecond=$false;throw 'Injected restore rename failure.'}
  & $script:move $from $to $TimeoutMilliseconds
}
function Assert-True([bool]$value,[string]$message){if(-not $value){throw $message}}
function New-Scenario([string]$name){
  $fixtureHome=Join-Path $fixtureRoot $name;$build=Join-Path $fixtureHome 'build'
  $null=New-Item -ItemType Directory -Path (Join-Path $build 'resources') -Force
  [IO.File]::WriteAllText((Join-Path $build 'Exomina.exe'),'SYNTHETIC EXECUTABLE - NEVER RUN')
  [IO.File]::WriteAllText((Join-Path $build 'resources\app.asar'),'SYNTHETIC PROGRAM')
  foreach($number in 1..2){
    $BuildId='synthetic-build-'+$number
    [IO.File]::WriteAllText((Join-Path $build 'exomina.build.json'),(@{id=$BuildId;builtAt=('2026-11-0'+$number+'T00:00:00Z')}|ConvertTo-Json -Compress))
    $program=Install-Program $build $fixtureHome
  }
  foreach($directory in @('Private','Workspace','Source')){$null=New-Item -ItemType Directory -Path (Join-Path $fixtureHome $directory);[IO.File]::WriteAllText((Join-Path $fixtureHome ($directory+'\sentinel.txt')),'UNCHANGED SYNTHETIC DATA')}
  return @{home=$fixtureHome;build=$build;previous=$program.previous;app=(Join-Path $fixtureHome 'App');buildId='synthetic-build-2'}
}
function Assert-Data($fixture){foreach($directory in @('Private','Workspace','Source')){Assert-True ([IO.File]::ReadAllText((Join-Path $fixture.home ($directory+'\sentinel.txt'))) -ceq 'UNCHANGED SYNTHETIC DATA') 'A data sentinel changed.'}}
function Current-Id($fixture){return (Read-CleanupJson (Join-Path $fixture.app 'exomina.build.json')).id}
try{
  $f=New-Scenario 'actual-restore'
  $result=Restore-PreviousProgram $f.home $f.previous $f.buildId ([DateTime]::UtcNow)
  Assert-True ($result.status -eq 'rolled-back' -and (Current-Id $f) -eq 'synthetic-build-1' -and (Test-Path -LiteralPath $result.failedProgram)) 'Actual rollback did not restore the previous program at the normal path.'
  Assert-Data $f;$reportResult.checks.atomicRestoreAndDataPreservation=$true
  foreach($mode in @('tampered-previous','changed-build','changed-binding','unsafe-path','linked-previous','second-rename-failure','foreign-process')){
    $f=New-Scenario $mode;$previous=$f.previous;$script:qaProcesses=@();$script:stops=@()
    switch($mode){
      'tampered-previous'{[IO.File]::WriteAllText((Join-Path $previous 'unknown.txt'),'PRESERVE')}
      'changed-build'{[IO.File]::WriteAllText((Join-Path $f.app 'exomina.build.json'),'{"id":"another-new-build"}')}
      'changed-binding'{[IO.File]::WriteAllText((Join-Path $f.app 'exomina.paths.json'),'{"home":"elsewhere"}')}
      'unsafe-path'{$previous=Join-Path $f.home 'Private'}
      'linked-previous'{$link=Join-Path $f.home ('App.previous-'+('b'*32));$null=New-Item -ItemType Junction -Path $link -Target $previous;$previous=$link}
      'second-rename-failure'{$script:failSecond=$true}
      'foreign-process'{$script:qaProcesses=@([pscustomobject]@{ExecutablePath=(Join-Path $f.app 'Exomina.exe');ProcessId=123});$script:qaProcess=[pscustomobject]@{Path=(Join-Path $f.app 'Exomina.exe');StartTime=[DateTime]::UtcNow.AddHours(-1)}}
    }
    $failed=$false;try{$null=Restore-PreviousProgram $f.home $previous $f.buildId ([DateTime]::UtcNow)}catch{$failed=$true}
    Assert-True $failed ($mode+' was not rejected.')
    Assert-True ((Test-Path -LiteralPath $f.app) -and (Test-Path -LiteralPath $f.previous)) ($mode+' lost a program copy.')
    Assert-True ($script:stops.Count -eq 0) ($mode+' stopped an unrelated process.')
    Assert-Data $f;$reportResult.checks[$mode]=$true
  }
  $script:qaProcesses=@()
  # Exercise the actual helper timeout, stable-health and replacement branches.
  function Test-CleanupHealth([string]$installRoot,[string]$state,[string]$token,[string]$expectedBuild){if($script:healthError){throw 'Injected polling error.'};return $script:healthy}
  foreach($mode in @('blocked-startup','poll-error','healthy-startup','stale-attempt')){
    $f=New-Scenario $mode;$InstallHome=$f.home;$Build=$f.build;$BuildId=$f.buildId;$KeepPrevious=$f.previous
    $CleanupState=Join-Path $f.home 'state';$null=New-Item -ItemType Directory -Path $CleanupState
    $CleanupToken='a'*32;$CleanupTimeoutSeconds=$(if($mode -in @('blocked-startup','poll-error')){1}else{8});$RollbackOnStartupFailure=$true
    $pending=@{schema=1;token=$CleanupToken;attemptId=$AttemptId;buildId=$BuildId;createdAt=[DateTime]::UtcNow.ToString('o');expiresAt=[DateTime]::UtcNow.AddSeconds(30).ToString('o')}
    if($mode -eq 'stale-attempt'){$pending.attemptId='87654321-1234-4234-8234-123456789012'}
    Write-CleanupJson (Join-Path $CleanupState 'program-cleanup-pending.json') $pending
    $script:healthy=$mode -eq 'healthy-startup'
    $script:healthError=$mode -eq 'poll-error'
    Invoke-ProgramCleanupAfterLaunch
    $result=Read-CleanupJson (Join-Path $CleanupState 'update-activation.json')
    if($mode -in @('blocked-startup','poll-error')){Assert-True ($result.status -eq 'rolled-back' -and (Current-Id $f) -eq 'synthetic-build-1') 'Blocked startup did not automatically recover.'}
    elseif($mode -eq 'healthy-startup'){Assert-True ($result.status -eq 'healthy' -and (Current-Id $f) -eq $BuildId -and (Test-Path -LiteralPath $KeepPrevious)) 'Healthy startup was not retained with its rollback copy.'}
    else{Assert-True ($null -eq $result -and (Current-Id $f) -eq $BuildId) 'A stale attempt changed the active program.'}
    Assert-Data $f;$reportResult.checks[$mode]=$true
  }
  $f=New-Scenario 'recovery-shortcut';$shortcut=New-ProgramRecoveryShortcut $f.home $f.previous $f.home
  $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($shortcut)
  Assert-True ($link.TargetPath -eq (Join-Path $f.previous 'Exomina.exe') -and $link.WorkingDirectory -eq $f.home -and (Test-Path -LiteralPath $link.TargetPath)) 'The recovery shortcut does not reach the retained program.'
  Assert-Data $f;$reportResult.checks.nativeRecoveryShortcutTargetsRetainedProgram=$true
  # Real native processes, both under this disposable App, verify that stopping
  # the main program and a bundled runtime releases the actual rename locks.
  $f=New-Scenario 'native-processes';$appPrefix=$f.app+'\'
  Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $f.app 'Exomina.exe') -Force
  $null=New-Item -ItemType Directory -Path (Join-Path $f.app 'runtime')
  Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $f.app 'runtime\worker.exe')
  $children=@();$created=[DateTime]::UtcNow
  function Get-CimInstance {param([string]$ClassName) CimCmdlets\Get-CimInstance -ClassName $ClassName -ErrorAction Stop}
  function Get-Process {param([int]$Id) Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction SilentlyContinue}
  function Stop-Process {param($InputObject,[switch]$Force) if(-not $InputObject.Path.StartsWith($appPrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Native process stop escaped its disposable App.'};Microsoft.PowerShell.Management\Stop-Process -InputObject $InputObject -Force -ErrorAction Stop}
  try{
    foreach($exe in @((Join-Path $f.app 'Exomina.exe'),(Join-Path $f.app 'runtime\worker.exe'))){$children+=Start-Process -FilePath $exe -ArgumentList '-e "setInterval(()=>{},1000)"' -WorkingDirectory $f.home -WindowStyle Hidden -PassThru}
    Start-Sleep -Milliseconds 400
    $recovered=Restore-PreviousProgram $f.home $f.previous $f.buildId $created
    Assert-True ($recovered.status -eq 'rolled-back' -and (Current-Id $f) -eq 'synthetic-build-1') 'Native program recovery failed.'
    foreach($child in $children){Assert-True $child.HasExited 'An owned native program was not stopped.'}
    Assert-Data $f;$reportResult.checks.realNativeMainAndBundledRuntimeStopped=$true
  }finally{foreach($child in $children){if(-not $child.HasExited){$child.Kill();$null=$child.WaitForExit(10000)}}}
  $reportResult.passed=$true
}catch{$reportResult.error=$_.Exception.Message}
[IO.File]::WriteAllText((Join-Path $Output 'recovery-result.json'),($reportResult|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$reportResult|ConvertTo-Json -Depth 6
if(-not $reportResult.passed){exit 1}
