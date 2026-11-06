# Fails the build unless the installer and the programs it installs carry an Authenticode signature, and, when the
# repository's certificate was used, unless it is that certificate (by SHA-1 thumbprint). The programs are read out of
# the installer itself (7-Zip opens NSIS installers), since that is what users get: the bundler puts the files it built
# back as they were once the installer is made.
param([string]$Release = 'desktop/release', [string]$Expected = '')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$installers = @(Get-ChildItem -Path $Release -Filter '*-setup.exe' | ForEach-Object { $_.FullName })
if ($installers.Count -eq 0) { throw "No installer in $Release" }
$paths = @() + $installers
foreach ($installer in $installers) {
  $unpacked = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
  & 7z x -y -bso0 -bsp0 "-o$unpacked" $installer | Out-Null
  foreach ($program in @('saturn-desktop.exe', 'saturn-server.exe', 'saturn.exe')) {
    $found = Get-ChildItem -Path $unpacked -Recurse -Filter $program | Select-Object -First 1
    if (-not $found) { throw "$program is not in $(Split-Path $installer -Leaf)" }
    $paths += $found.FullName
  }
}
foreach ($path in $paths) {
  $signature = Get-AuthenticodeSignature -FilePath $path
  if (-not $signature.SignerCertificate) { throw "$path is not signed" }
  $thumbprint = $signature.SignerCertificate.Thumbprint
  # A self-signed certificate is not trusted by Windows, so Status reads UnknownError; what matters is who signed.
  Write-Output ("{0}: {1}  {2}  timestamped={3}" -f (Split-Path $path -Leaf), $signature.SignerCertificate.Subject, $thumbprint, [bool]$signature.TimeStamperCertificate)
  if ($Expected -and $thumbprint -ne $Expected) { throw "$path is signed by $thumbprint, not Saturn's certificate $Expected" }
}
