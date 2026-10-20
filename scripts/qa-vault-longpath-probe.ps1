$ErrorActionPreference='Stop'
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security')
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$rows=@()
foreach($prefix in @('','\\?\')) {
  $file=$prefix+$request.file
  foreach($operation in @('item','acl','nativeAttrs','enumerate','cipher','managedEncrypt')) {
    try {
      switch($operation){
        'item' { $value=Get-Item -LiteralPath $file; $result=$value.Length }
        'acl' { $value=Get-Acl -LiteralPath $file; $result=$value.Access.Count }
        'nativeAttrs' {$result=[IO.File]::GetAttributes($file).ToString()}
        'enumerate' {$result=@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($file)) -Force).Count}
        'cipher' {$null=& (Join-Path $env:SystemRoot 'System32\cipher.exe') /e /h /b $file 2>&1; $result=$LASTEXITCODE}
        'managedEncrypt' { [IO.File]::Encrypt($file); $result=[IO.File]::GetAttributes($file).HasFlag([IO.FileAttributes]::Encrypted) }
      }
      $rows+=@{prefix=($prefix.Length-gt0);operation=$operation;success=$true;result=$result}
    }catch{$rows+=@{prefix=($prefix.Length-gt0);operation=$operation;success=$false;category=$_.Exception.GetType().Name;code=$_.Exception.HResult}}
  }
}
$rows|ConvertTo-Json -Compress
[IO.File]::Decrypt([string]$request.file)
[IO.File]::SetAttributes([string]$request.file, ([IO.File]::GetAttributes([string]$request.file) -bor [IO.FileAttributes]::ReadOnly))
