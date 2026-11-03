param([string]$Output = (Join-Path $PSScriptRoot '..\.verification\installer-locks'))
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-windows.ps1'))
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$names=@('Fail','Assert-PlainDirectory','Assert-ExpectedBuild','Get-ProgramFiles','Get-ProgramHash','Copy-Tree','Move-ProgramDirectory','Install-Program')
foreach($name in $names){$node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(-not $node){throw ('Missing '+$name)};. ([scriptblock]::Create($node.Extent.Text))}
function Write-InstallProgress {}
function Assert-ApplicationStopped {}
function Assert($ok,$message){if(-not $ok){throw $message}}
$Report='';$BuildId='';$ExpectedManifest='';$script:verifiedFiles=0;$script:totalFiles=0
$Output=[IO.Path]::GetFullPath($Output)
$null=New-Item -ItemType Directory -Path $Output -Force
$root=Join-Path $Output ('activation-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$originalLocation=(Get-Location).Path;$originalDirectory=[Environment]::CurrentDirectory
$results=[ordered]@{scope='Actual installer functions in synthetic folders only; no installed program or personal data accessed.'}
try{
 $fixtureHome=Join-Path $root 'self-cwd';$app=Join-Path $fixtureHome 'App';$build=Join-Path $root 'Build'
 foreach($dir in @($app,(Join-Path $build 'resources'),(Join-Path $fixtureHome 'Private'),(Join-Path $fixtureHome 'Workspace'),(Join-Path $fixtureHome 'Source'))){$null=New-Item -ItemType Directory -Path $dir -Force}
 foreach($part in @('Private','Workspace','Source')){[IO.File]::WriteAllText((Join-Path $fixtureHome ($part+'\sentinel.txt')),'preserve')}
 [IO.File]::WriteAllText((Join-Path $app 'old.txt'),'old')
 [IO.File]::WriteAllText((Join-Path $app 'exomina.paths.json'),'{"home":".."}')
 [IO.File]::WriteAllText((Join-Path $build 'Exomina.exe'),'synthetic only')
 [IO.File]::WriteAllText((Join-Path $build 'resources\app.asar'),'synthetic only')
 [IO.File]::WriteAllText((Join-Path $build 'exomina.build.json'),'{"id":"test-activation-build"}')
 Set-Location -LiteralPath $app;[Environment]::CurrentDirectory=$app
 $program=Install-Program $build $fixtureHome
 Assert ([IO.File]::Exists((Join-Path $app 'Exomina.exe'))) 'New program missing'
 Assert ([IO.File]::ReadAllText((Join-Path $program.previous 'old.txt')) -eq 'old') 'Previous program changed'
 Assert ([Environment]::CurrentDirectory -eq $fixtureHome) 'Native cwd was not released'
 Assert ((Get-Location).Path -eq $fixtureHome) 'PowerShell location was not released'
 foreach($part in @('Private','Workspace','Source')){Assert ([IO.File]::ReadAllText((Join-Path $fixtureHome ($part+'\sentinel.txt'))) -eq 'preserve') ('Data changed: '+$part)}
 $results.inheritedAppWorkingDirectoryReleased=$true;$results.actualInstallVerified=$true;$results.previousProgramPreserved=$true;$results.dataFoldersUntouched=$true
 $hold=Join-Path $root 'hold.ps1';[IO.File]::WriteAllText($hold,'param($ready,$milliseconds) [IO.File]::WriteAllText($ready,"ready"); Start-Sleep -Milliseconds $milliseconds',[Text.UTF8Encoding]::new($false))
 foreach($case in @(@{name='transient';duration=1200;bound=5000},@{name='lasting';duration=10000;bound=750})){
  $from=Join-Path $root $case.name;$to=$from+'.moved';$ready=$from+'.ready';$null=New-Item -ItemType Directory -Path $from
  [IO.File]::WriteAllText((Join-Path $from 'sentinel.txt'),'intact')
  $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-File',('"'+$hold+'"'),('"'+$ready+'"'),$case.duration) -WorkingDirectory $from -WindowStyle Hidden -PassThru
  try{
   $deadline=[DateTime]::UtcNow.AddSeconds(5);while(-not [IO.File]::Exists($ready)){if([DateTime]::UtcNow -gt $deadline){throw 'Lock child not ready'};Start-Sleep -Milliseconds 25}
   $elapsed=[Diagnostics.Stopwatch]::StartNew();$failed=$false
   try{Move-ProgramDirectory $from $to $case.bound}catch{$failed=$true;$failure=$_.Exception.Message}
   if($case.name -eq 'transient'){Assert (-not $failed) 'Temporary lock not retried';Assert ([IO.File]::ReadAllText((Join-Path $to 'sentinel.txt')) -eq 'intact') 'Temporary-lock move altered contents';$results.transientLockRecovered=$true}
   else{Assert $failed 'Lasting lock unexpectedly succeeded';Assert ($elapsed.ElapsedMilliseconds -lt 4000) 'Retry bound exceeded';Assert ([IO.File]::ReadAllText((Join-Path $from 'sentinel.txt')) -eq 'intact') 'Lasting lock lost the program';Assert ($failure.Contains($from) -and $failure.Contains('Close programs')) 'Failure missing exact path';$results.lastingLockBoundedAndPreserved=$true}
  }finally{if(-not $child.HasExited){$child.Kill()};$child.WaitForExit()}
 }
 $moveNode=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Move-ProgramDirectory'},$true)
 . ([scriptblock]::Create($moveNode.Extent.Text.Replace('function Move-ProgramDirectory(', 'function Move-OriginalProgramDirectory(')))
 function Move-ProgramDirectory($from,$to,$TimeoutMilliseconds=15000){Move-OriginalProgramDirectory $from $to ([Math]::Min($TimeoutMilliseconds,750))}
 $activationStart=$source.IndexOf('  $moved = $false')
 $activationEnd=$source.IndexOf("`n}",$activationStart)
 $activation=[scriptblock]::Create('param($app,$next,$previous) $count=0; '+$source.Substring($activationStart,$activationEnd-$activationStart))
 $caseRoot=Join-Path $root 'second-move';$null=New-Item -ItemType Directory -Path $caseRoot
 $oldApp=Join-Path $caseRoot 'App';$nextApp=Join-Path $caseRoot 'Next';$oldPrevious=Join-Path $caseRoot 'Previous'
 foreach($dir in @($oldApp,$nextApp)){$null=New-Item -ItemType Directory -Path $dir}
 [IO.File]::WriteAllText((Join-Path $oldApp 'old.txt'),'old');[IO.File]::WriteAllText((Join-Path $nextApp 'new.txt'),'new')
 $ready=Join-Path $root 'second-move.ready'
 $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-File',('"'+$hold+'"'),('"'+$ready+'"'),10000) -WorkingDirectory $nextApp -WindowStyle Hidden -PassThru
 try{
  $deadline=[DateTime]::UtcNow.AddSeconds(5);while(-not [IO.File]::Exists($ready)){if([DateTime]::UtcNow -gt $deadline){throw 'Next-folder lock child not ready'};Start-Sleep -Milliseconds 25}
  $failed=$false;try{$null=& $activation $oldApp $nextApp $oldPrevious}catch{$failed=$true}
  Assert $failed 'Second move ignored its lock'
  Assert ([IO.File]::ReadAllText((Join-Path $oldApp 'old.txt')) -eq 'old') 'Second-move failure did not restore the previous program'
  Assert ([IO.File]::ReadAllText((Join-Path $nextApp 'new.txt')) -eq 'new') 'Second-move failure altered staged program'
  Assert (-not [IO.Directory]::Exists($oldPrevious)) 'Rollback left the previous program at an unusable path'
  $results.secondMoveLockRollsBack=$true
 }finally{if(-not $child.HasExited){$child.Kill()};$child.WaitForExit()}
 $occupied=Join-Path $root 'occupied';$null=New-Item -ItemType Directory -Path $occupied;$null=New-Item -ItemType Directory -Path ($occupied+'.target');$failed=$false
 try{Move-ProgramDirectory $occupied ($occupied+'.target') 750}catch{$failed=$true};Assert $failed 'Existing destination accepted';$results.occupiedDestinationRejected=$true
}catch{$results.failure=$_.Exception.ToString();$global:LASTEXITCODE=1;throw}finally{Set-Location -LiteralPath $originalLocation;[Environment]::CurrentDirectory=$originalDirectory;[IO.File]::WriteAllText((Join-Path $Output 'installer-locks.json'),($results|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false));$results|ConvertTo-Json -Depth 6}
