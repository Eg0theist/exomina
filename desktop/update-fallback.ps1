<# Unelevated emergency reopen. Never renames, deletes, changes permissions or
   opens profile stores. Only the exact attempt's program processes can stop. #>
param([Parameter(Mandatory)][string]$InstallHome,[Parameter(Mandatory)][string]$Previous,[Parameter(Mandatory)][string]$BuildId,[Parameter(Mandatory)][string]$CreatedAt)
$ErrorActionPreference='Stop'
function Assert-Plain([string]$location){
  for($cursor=[IO.Path]::GetFullPath($location);$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)){
    if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'A recovery program path is linked.'}
  }
}
$root=[IO.Path]::GetFullPath($InstallHome).TrimEnd('\');$Previous=[IO.Path]::GetFullPath($Previous).TrimEnd('\');$app=Join-Path $root 'App'
if([IO.Path]::GetDirectoryName($Previous) -ne $root -or [IO.Path]::GetFileName($Previous) -notmatch '^App\.previous-[a-f0-9]{32}$' -or $BuildId -notmatch '^[\w-]{8,64}$'){throw 'Invalid previous-program recovery path.'}
Assert-Plain $root;Assert-Plain $Previous;Assert-Plain $app
$oldStamp=[IO.File]::ReadAllText((Join-Path $Previous 'exomina.build.json'))|ConvertFrom-Json
if($oldStamp.id -notmatch '^[\w-]{8,64}$' -or -not (Test-Path -LiteralPath (Join-Path $Previous 'Exomina.exe') -PathType Leaf)){throw 'The previous program is unavailable.'}
$created=[DateTime]::Parse($CreatedAt).ToUniversalTime()
if($created -gt [DateTime]::UtcNow -or [DateTime]::UtcNow-$created -gt [TimeSpan]::FromMinutes(15)){throw 'The recovery attempt expired.'}
$stamp=$null;try{$stamp=[IO.File]::ReadAllText((Join-Path $app 'exomina.build.json'))|ConvertFrom-Json}catch{}
if($stamp.id -and $stamp.id -ne $BuildId){throw 'The active program changed; automatic fallback was stopped.'}
$prefix=$app+'\'
foreach($entry in Get-CimInstance Win32_Process -ErrorAction Stop){
  if(-not $entry.ExecutablePath -or -not $entry.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){continue}
  $process=Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue;if(-not $process){continue}
  try{$image=$process.Path;$start=$process.StartTime.ToUniversalTime()}catch{if(-not (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)){continue};throw}
  if(-not [string]::Equals($image,$entry.ExecutablePath,[StringComparison]::OrdinalIgnoreCase) -or $start -lt $created.AddSeconds(-2)){throw 'A different application instance is using this program.'}
  Stop-Process -InputObject $process -Force -ErrorAction Stop
  if(-not $process.WaitForExit(10000)){throw 'The failed program did not stop.'}
}
if(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)}){throw 'The failed program is still in use.'}
[Console]::WriteLine('previous-program-ready')
