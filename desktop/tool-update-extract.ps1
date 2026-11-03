param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=[IO.Path]::GetFullPath($Destination).TrimEnd('\')
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
$total=0L
$names=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
try {
  foreach($entry in $zip.Entries){
    $name=$entry.FullName.Replace('/','\')
    $total+=$entry.Length
    if($total -gt 1073741824 -or $zip.Entries.Count -gt 10000){throw 'Tool archive is too large.'}
    if($name.Contains(':') -or [IO.Path]::IsPathRooted($name) -or $name.Split('\').Contains('..') -or $name.Contains([char]0)){throw 'Invalid archive path.'}
    foreach($segment in $name.Split('\')){if($segment -and ($segment -eq '.' -or $segment -match '(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)' -or $segment -match '[. ]$|[<>|"*?]')){throw 'Invalid Windows archive name.'}}
    if((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Tool archive contains a symbolic link.'}
    $target=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$name))
    if(-not $target.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $names.Add($target)){throw 'Tool archive contains an unsafe or duplicate path.'}
    if($entry.Name){
      $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
    }
  }
} finally {$zip.Dispose()}
