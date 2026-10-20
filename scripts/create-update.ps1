$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageRoot = [IO.Path]::GetFullPath($env:EXOMINA_RELEASE_BUILD)
$packageOutput = [IO.Path]::GetFullPath($env:EXOMINA_RELEASE_ZIP)
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'Exomina.exe'))) { throw 'Missing packaged Exomina.' }
if (Test-Path -LiteralPath $packageOutput) { throw 'The release archive already exists.' }
if ($packageOutput.StartsWith($packageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output must be outside the package.' }
[IO.Compression.ZipFile]::CreateFromDirectory($packageRoot, $packageOutput, [IO.Compression.CompressionLevel]::Optimal, $false)
