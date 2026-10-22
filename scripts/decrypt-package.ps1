<#
  Removes Windows EFS encryption from a packaged program folder. Program files
  are public release content; EFS on them only adds a failure mode in which a
  file keeps the Encrypted flag over plaintext and every normal read returns
  garbage. Content is unchanged; callers verify hashes afterwards.
  Prints {"decrypted":n,"remaining":0} and exits 1 if anything stays encrypted.
#>
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
$encrypted = [IO.FileAttributes]::Encrypted
function Get-Entries {
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
  Get-Item -LiteralPath $root -Force
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The package contains linked files or folders.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      $entry
    }
  }
}
try {
  $count = 0
  foreach ($entry in @(Get-Entries)) {
    if (-not ($entry.Attributes -band $encrypted)) { continue }
    $readOnly = -not $entry.PSIsContainer -and ($entry.Attributes -band [IO.FileAttributes]::ReadOnly)
    if ($readOnly) { $entry.Attributes = $entry.Attributes -band -bnot [IO.FileAttributes]::ReadOnly }
    try { [IO.File]::Decrypt($entry.FullName) }
    finally { if ($readOnly) { [IO.File]::SetAttributes($entry.FullName, [IO.File]::GetAttributes($entry.FullName) -bor [IO.FileAttributes]::ReadOnly) } }
    $count++
  }
  $remaining = @(Get-Entries | Where-Object { $_.Attributes -band $encrypted }).Count
  @{decrypted=$count;remaining=$remaining} | ConvertTo-Json -Compress
  if ($remaining) { exit 1 }
} catch {
  @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1
}
