$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-windows.ps1'))
$start=$source.IndexOf('  $moved = $false')
$end=$source.IndexOf("`n}`n",$start)
if($end -lt 0){$end=$source.IndexOf("`r`n}`r`n",$start)}
if($start -lt 0 -or $end -lt 0){throw 'Activation fragment not found.'}
$body=$source.Substring($start,$end-$start)
if($body -match 'Move-Item'){throw 'Activation still uses a recursive move.'}
$activate=[scriptblock]::Create('param($app,$next,$previous) function Fail($message){throw $message}; $count=0; '+$body)
$parent=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.verification\installer-activation')); $null=New-Item -ItemType Directory -Path $parent -Force
$testRoot=Join-Path $parent ('atomic-probe-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $testRoot
function Make-Case($name){$root=Join-Path $testRoot $name;$null=New-Item -ItemType Directory -Path $root;foreach($part in @('App','Next')){$null=New-Item -ItemType Directory -Path (Join-Path $root $part)};[IO.File]::WriteAllText((Join-Path $root 'App\old.txt'),'old');[IO.File]::WriteAllText((Join-Path $root 'Next\new.txt'),'new');return $root}
function Assert($condition,$message){if(-not $condition){throw $message}}
$results=[ordered]@{}
$root=Make-Case 'success';$null=& $activate (Join-Path $root 'App') (Join-Path $root 'Next') (Join-Path $root 'Previous');Assert (Test-Path -LiteralPath (Join-Path $root 'App\new.txt')) 'New app not activated';Assert (Test-Path -LiteralPath (Join-Path $root 'Previous\old.txt')) 'Old app not preserved';$results.normalActivation=$true
$root=Make-Case 'occupied-rollback';$null=New-Item -ItemType Directory -Path (Join-Path $root 'Previous');[IO.File]::WriteAllText((Join-Path $root 'Previous\unrelated.txt'),'preserve');$failed=$false;try{$null=& $activate (Join-Path $root 'App') (Join-Path $root 'Next') (Join-Path $root 'Previous')}catch{$failed=$true};Assert $failed 'An occupied destination was accepted';Assert (Test-Path -LiteralPath (Join-Path $root 'App\old.txt')) 'Failed rename altered old app';Assert ((Get-ChildItem -LiteralPath (Join-Path $root 'Previous')).Count -eq 1) 'Old app merged into existing backup';Assert (Test-Path -LiteralPath (Join-Path $root 'Next\new.txt')) 'Staging altered';$results.destinationConflictLeavesBothFoldersIntact=$true
$root=Make-Case 'rollback';$failed=$false;try{$null=& $activate (Join-Path $root 'App') (Join-Path $root 'Absent') (Join-Path $root 'Previous')}catch{$failed=$true};Assert $failed 'Missing package did not fail';Assert (Test-Path -LiteralPath (Join-Path $root 'App\old.txt')) 'Rollback did not restore old app';Assert (-not(Test-Path -LiteralPath (Join-Path $root 'Previous'))) 'Rollback was partial';$results.failedActivationRestoresOldApp=$true
$root=Make-Case 'locked-file';$stream=[IO.File]::Open((Join-Path $root 'App\old.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{try{$null=& $activate (Join-Path $root 'App') (Join-Path $root 'Next') (Join-Path $root 'Previous')}catch{};$oldAtApp=Test-Path -LiteralPath (Join-Path $root 'App\old.txt');$oldAtPrevious=Test-Path -LiteralPath (Join-Path $root 'Previous\old.txt');Assert ($oldAtApp -xor $oldAtPrevious) 'Locked-file operation split or lost the old app';Assert ((Test-Path -LiteralPath (Join-Path $root 'Next\new.txt')) -xor (Test-Path -LiteralPath (Join-Path $root 'App\new.txt'))) 'Staging partially moved';$results.lockedFileLeavesWholeDirectories=$true}finally{$stream.Dispose()}
$results.probe=$testRoot
$results|ConvertTo-Json
