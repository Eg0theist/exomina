param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath($env:EXOMINA_MERGE_WORKSPACE)
if ([IO.Path]::GetFullPath((Get-Location).Path) -ne $workspace) { throw 'The update workspace does not match the check process.' }
$checks = [Collections.Generic.List[object]]::new()
try {
  & npm.cmd ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  # Only the pinned Electron runtime's installer is needed for electronDist.
  & node.exe 'node_modules/electron/install.js'
  $checks.Add(@{name='dependencies';passed=($LASTEXITCODE -eq 0)})
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & npm.cmd test
  $checks.Add(@{name='tests';passed=($LASTEXITCODE -eq 0)})
  if ($LASTEXITCODE -ne 0) { throw 'Merged update tests failed.' }
  & npm.cmd run package
  $checks.Add(@{name='package';passed=($LASTEXITCODE -eq 0)})
  if ($LASTEXITCODE -ne 0) { throw 'Merged update packaging failed.' }
} finally {
  [IO.File]::WriteAllText($env:EXOMINA_MERGE_RESULT, (@{checks=@($checks.ToArray())} | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
