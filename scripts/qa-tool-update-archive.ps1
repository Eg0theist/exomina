param([Parameter(Mandatory=$true)][string]$CaseRoot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$extractor=Join-Path $PSScriptRoot '../desktop/tool-update-extract.ps1'
$cases=@(
  @{id='valid';names=@('cua-driver.exe');allow=$true},
  @{id='traversal';names=@('../escape.txt');allow=$false},
  @{id='absolute';names=@([IO.Path]::Combine($CaseRoot,'escape.txt'));allow=$false},
  @{id='stream';names=@('file.txt:hidden');allow=$false},
  @{id='device';names=@('CON.txt');allow=$false},
  @{id='ambiguous';names=@('file.txt.');allow=$false},
  @{id='duplicate';names=@('a.txt','A.txt');allow=$false},
  @{id='symlink';names=@('link.txt');allow=$false}
)
$results=@()
foreach($case in $cases){
  $archive=[IO.Path]::Combine($CaseRoot,$case.id+'.zip')
  $zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
  try{foreach($name in $case.names){$entry=$zip.CreateEntry($name);if($case.id -eq 'symlink'){$entry.ExternalAttributes=-1610612736};$writer=New-Object IO.StreamWriter($entry.Open(),(New-Object Text.UTF8Encoding($false)));try{$writer.Write('synthetic fixture')}finally{$writer.Dispose()}}}finally{$zip.Dispose()}
  $destination=[IO.Path]::Combine($CaseRoot,$case.id)
  $null=[IO.Directory]::CreateDirectory($destination)
  $accepted=$false
  try{& $extractor -Archive $archive -Destination $destination;$accepted=$true}catch{$reason=$_.Exception.Message}
  if($accepted -ne $case.allow){throw ('Unexpected archive outcome: '+$case.id+' accepted='+$accepted)}
  $results+=@{id=$case.id;accepted=$accepted}
}
$results|ConvertTo-Json -Compress
