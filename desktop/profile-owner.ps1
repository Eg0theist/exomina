# Read only. Never change a token, take ownership or alter file permissions.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $owner = if ($identity.Owner.Value -eq $identity.User.Value) { 'current-user' } elseif ($identity.Owner.Value -eq 'S-1-5-32-544') { 'administrators' } else { 'other' }
    $elevated = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    @{owner=$owner;elevated=$elevated} | ConvertTo-Json -Compress
  } finally { $identity.Dispose() }
} catch { [Console]::Error.WriteLine('Windows could not inspect the default file owner.'); exit 1 }
