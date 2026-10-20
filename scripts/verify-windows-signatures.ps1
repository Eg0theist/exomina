param([string]$Root='',[string]$Installer='',[string]$SingleFile='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$releaseRoot=if($Root){[IO.Path]::GetFullPath($Root)}else{''}
$expectedPublisher=([string]$env:EXOMINA_PUBLISHER_THUMBPRINT).Replace(' ','').ToUpperInvariant()
if($expectedPublisher -notmatch '^[A-F0-9]{40}$'){throw 'Configure EXOMINA_PUBLISHER_THUMBPRINT to the trusted release certificate thumbprint before verification.'}
$files=if($SingleFile){@([IO.Path]::GetFullPath($SingleFile))}else{
 if(-not $releaseRoot){throw 'Choose a release root or an exact file.'}
 @('Exomina.exe','resources\app.asar.unpacked\desktop\windows-interop\Vault.dll','resources\app.asar.unpacked\desktop\windows-interop\Desktop.dll','resources\app.asar.unpacked\desktop\windows-interop\Speech.dll','resources\app.asar.unpacked\desktop\windows-interop\Busy.dll','resources\app.asar.unpacked\desktop\windows-interop\Scan.dll')
}
$results=@()
$publisher=$null
foreach($relative in $files){
 $file=if($SingleFile){$relative}else{Join-Path $releaseRoot $relative}
 $signature=Get-AuthenticodeSignature -LiteralPath $file
 if($signature.Status -ne 'Valid'){throw "Public release has an invalid or missing signature: $relative"}
 if($signature.SignerCertificate.Thumbprint -ne $expectedPublisher){throw "Release publisher does not match the configured identity: $relative"}
 if($null -eq $signature.TimeStamperCertificate){throw "Public release has no signing timestamp: $relative"}
 if($null -eq $publisher){$publisher=$signature.SignerCertificate.Thumbprint}
 if($signature.SignerCertificate.Thumbprint -ne $publisher){throw "First-party signing identity differs: $relative"}
 $results+=@{file=$relative;status='Valid';timestampSigner=$signature.TimeStamperCertificate.Subject;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
}
if($Installer){
 $file=[IO.Path]::GetFullPath($Installer)
 $signature=Get-AuthenticodeSignature -LiteralPath $file
 if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $publisher){throw 'Installer signature is missing, invalid or uses another identity.'}
 if($null -eq $signature.TimeStamperCertificate){throw 'Installer has no signing timestamp.'}
 $results+=@{file=[IO.Path]::GetFileName($file);status='Valid';timestampSigner=$signature.TimeStamperCertificate.Subject;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}
}
@{signatures=$results;publisherThumbprint=$publisher;antivirusClearance='Not established by signature validation. Test the exact artifacts on clean systems and submit false-positive evidence to the vendor.'}|ConvertTo-Json -Depth 4 -Compress
