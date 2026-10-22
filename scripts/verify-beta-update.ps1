param([Parameter(Mandatory)][string]$App)
$ErrorActionPreference = 'Stop'
function Get-BetaFileSha256([string]$File) {
  # Use the OS cryptography API even when a PowerShell 7 parent supplied a
  # module path that hides Windows PowerShell's Get-FileHash command.
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($File)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
try {
  $root = [IO.Path]::GetFullPath($App).TrimEnd('\')
  if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked beta installation.' }
  $manifestPath = Join-Path $root 'exomina.release-integrity.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'This older beta has no verified baseline. Install the new beta in a different empty folder, preserving this copy for review.' }
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  $stamp = [IO.File]::ReadAllText((Join-Path $root 'exomina.build.json')) | ConvertFrom-Json
  if ($manifest.format -ne 1 -or $manifest.buildId -ne $stamp.id) { throw 'Invalid beta baseline.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    $file = [IO.Path]::GetFullPath((Join-Path $root $entry.path))
    if (-not $file.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($file)) { throw 'Invalid beta baseline path.' }
    $cursor = [IO.Path]::GetDirectoryName($file)
    while ($cursor -eq $root -or $cursor.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked beta program directory.' }; if ($cursor -eq $root) { break }; $cursor=[IO.Path]::GetDirectoryName($cursor) }
    $info = Get-Item -LiteralPath $file -Force
    if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -ne $entry.size -or (Get-BetaFileSha256 $file) -cne $entry.sha256) { throw "Customized beta file: $($entry.path). Preserve this installation and port these changes into source before updating." }
  }
  $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
  while ($pending.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked beta program files require manual review.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      elseif (-not $seen.Contains($entry.FullName) -and $entry.Name -ne 'exomina.release-integrity.json' -and $entry.Name -ne 'Uninstall Exomina Beta.exe') { throw 'Added beta program files require manual review.' }
    }
  }
  exit 0
} catch { Write-Output $_.Exception.Message; exit 12 }
