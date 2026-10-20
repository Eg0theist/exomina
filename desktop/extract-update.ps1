# Extract only a verified public program archive into a fresh updater directory.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = [IO.Path]::GetFullPath($env:EXOMINA_UPDATE_ARCHIVE)
$targetPath = [IO.Path]::GetFullPath($env:EXOMINA_UPDATE_TARGET).TrimEnd('\')
if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { throw 'Missing update destination.' }
if (Get-ChildItem -LiteralPath $targetPath -Force | Select-Object -First 1) { throw 'Update destination must be empty.' }
if ((Get-Item -LiteralPath $targetPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked update destination.' }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $total = [long]0
  if ($zip.Entries.Count -gt 100000) { throw 'Update contains too many files.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    $parts = $name.TrimEnd('\').Split('\')
    if (-not $name -or $name.StartsWith('\') -or $name.Contains(':') -or $parts -contains '..' -or $parts -contains '.' -or $parts -contains '') { throw 'Unsafe update archive path.' }
    if ($parts[0] -in @('Private', 'data', 'Workspace', 'Source')) { throw 'An update must contain program files only.' }
    foreach ($part in $parts) { if ($part -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.]|$)') { throw 'Invalid Windows update filename.' } }
    $destination = [IO.Path]::GetFullPath([IO.Path]::Combine($targetPath, $name))
    if (-not $destination.StartsWith($targetPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path leaves its destination.' }
    if (-not $seen.Add($name.TrimEnd('\'))) { throw 'Duplicate update archive path.' }
    $attributes = [uint32]([int64]$entry.ExternalAttributes -band 0xffffffffL)
    if ((($attributes -shr 16) -band 0xf000) -eq 0xa000 -or ($attributes -band 0x400)) { throw 'Linked update archive entry.' }
    $total += $entry.Length
    if ($total -gt 16GB) { throw 'Unpacked update is too large.' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $targetPath)
