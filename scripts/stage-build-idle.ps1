param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
$busy = $false
foreach ($entry in Get-CimInstance Win32_Process) {
  if (($entry.ExecutablePath -and $entry.ExecutablePath.StartsWith($target,[StringComparison]::OrdinalIgnoreCase)) -or
      ($entry.CommandLine -and $entry.CommandLine.IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0)) { $busy = $true; break }
  if ($entry.Name -match '^(Exomina|electron|node|python(?:w|[0-9.]*)?|pwsh|powershell|cmd)(?:\.exe)?$' -and -not $entry.CommandLine) { $busy = $true; break }
}
if ($busy) { 'busy' } else { 'idle' }
