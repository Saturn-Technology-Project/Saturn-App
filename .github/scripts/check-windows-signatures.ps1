# Fails the build unless the installer, Saturn.exe and Saturn IDE.exe carry an Authenticode signature, and, when the
# repository's certificate was used, unless it is that certificate (by SHA-1 thumbprint).
param([string]$Release = 'desktop/release', [string]$Expected = '')
$ErrorActionPreference = 'Stop'
$paths = @()
$paths += Get-ChildItem -Path $Release -Filter '*.exe' | ForEach-Object { $_.FullName }
$paths += Join-Path $Release 'win-unpacked\Saturn.exe'
$ide = Join-Path $Release 'win-unpacked\resources\Saturn IDE\Saturn IDE.exe'
if (Test-Path $ide) { $paths += $ide }
foreach ($path in $paths) {
  $signature = Get-AuthenticodeSignature -FilePath $path
  if (-not $signature.SignerCertificate) { throw "$path is not signed" }
  $thumbprint = $signature.SignerCertificate.Thumbprint
  # A self-signed certificate is not trusted by Windows, so Status reads UnknownError; what matters is who signed.
  Write-Output ("{0}: {1}  {2}  timestamped={3}" -f (Split-Path $path -Leaf), $signature.SignerCertificate.Subject, $thumbprint, [bool]$signature.TimeStamperCertificate)
  if ($Expected -and $thumbprint -ne $Expected) { throw "$path is signed by $thumbprint, not Saturn's certificate $Expected" }
}
