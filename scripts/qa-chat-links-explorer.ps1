param([Parameter(Mandatory=$true)][string]$Folder, [Parameter(Mandatory=$true)][string]$ExpectedFile, [switch]$CloseMatchedWindow)
$ErrorActionPreference = 'Stop'
$targetFolder = [IO.Path]::GetFullPath($Folder)
$targetFile = [IO.Path]::GetFullPath($ExpectedFile)
if ([IO.Path]::GetDirectoryName($targetFile) -ne $targetFolder -or [IO.Path]::GetFileName($targetFolder) -ne 'Explorer proof' -or $targetFolder -notlike '*\Workspace\qa-chat-links-*\project (spaces)\Explorer proof') { throw 'Only the synthetic Explorer proof folder may be inspected or closed.' }
$shellApp = New-Object -ComObject Shell.Application
$found = $false
$selected = $false
$closed = 0
$deadline = [DateTime]::UtcNow.AddSeconds($(if ($CloseMatchedWindow) { 1 } else { 10 }))
do {
  foreach ($explorerWindow in @($shellApp.Windows())) {
    try {
      if ($explorerWindow.Document.Folder.Self.Path -ne $targetFolder) { continue }
      $found = $true
      foreach ($item in @($explorerWindow.Document.SelectedItems())) { if ($item.Path -eq $targetFile) { $selected = $true } }
      if ($CloseMatchedWindow) { $explorerWindow.Quit(); $closed++ }
    } catch { }
  }
  if ($CloseMatchedWindow -or ($found -and $selected)) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
@{ folderFound = $found; expectedFileSelected = $selected; closedWindows = $closed } | ConvertTo-Json -Compress
