# Fails the build unless the installer, and every program it installs, carry an Authenticode signature, and, when the
# repository's certificate was used, unless it is that certificate (by SHA-1 thumbprint). The installer is run silently
# into a folder of its own and every .exe it leaves is checked, the uninstaller among them, since that is what users get;
# then it is uninstalled. Each installed program is also refused if it loads the Visual C++ runtime, which Windows does
# not come with: the runner has it, so a program that needs it would start here and not on a user's new computer.
param([string]$Release = 'desktop/release', [string]$Expected = '')
$ErrorActionPreference = 'Stop'

function Check-Signature([string]$Path) {
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if (-not $signature.SignerCertificate) { throw "$Path is not signed" }
  $thumbprint = $signature.SignerCertificate.Thumbprint
  # A self-signed certificate is not trusted by Windows, so Status reads UnknownError; what matters is who signed.
  Write-Output ("{0}: {1}  {2}  timestamped={3}" -f (Split-Path $Path -Leaf), $signature.SignerCertificate.Subject, $thumbprint, [bool]$signature.TimeStamperCertificate)
  if ($Expected -and $thumbprint -ne $Expected) { throw "$Path is signed by $thumbprint, not Saturn's certificate $Expected" }
}

function Check-Runtime([string]$Path) {
  $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($Path))
  foreach ($library in 'VCRUNTIME140', 'MSVCP140') {
    if ($text.IndexOf($library, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "$Path loads $library.dll, which Windows does not have unless something installed it" }
  }
}

$installers = @(Get-ChildItem -Path $Release -Filter '*-setup.exe' | ForEach-Object { $_.FullName })
if ($installers.Count -eq 0) { throw "No installer in $Release" }
foreach ($installer in $installers) {
  Check-Signature $installer
  $folder = Join-Path $env:RUNNER_TEMP ('saturn-install-' + [System.IO.Path]::GetRandomFileName())
  # NSIS takes the folder as the last argument, unquoted.
  $install = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$folder" -PassThru
  if (-not $install.WaitForExit(300000)) { $install.Kill(); throw "$(Split-Path $installer -Leaf) did not finish installing in five minutes" }
  if ($install.ExitCode -ne 0) { throw "$(Split-Path $installer -Leaf) exited with $($install.ExitCode)" }
  $programs = @(Get-ChildItem -Path $folder -Recurse -Filter '*.exe' | ForEach-Object { $_.FullName })
  Write-Output "Installed: $(($programs | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')"
  if (-not ($programs | Where-Object { (Split-Path $_ -Leaf) -like 'uninstall*.exe' })) { throw 'The installer left no uninstaller' }
  if ($programs.Count -lt 4) { throw "Only $($programs.Count) programs were installed; the app, the runtime, the saturn command and the uninstaller were expected" }
  foreach ($program in $programs) { Check-Signature $program; Check-Runtime $program }
  $uninstaller = $programs | Where-Object { (Split-Path $_ -Leaf) -like 'uninstall*.exe' } | Select-Object -First 1
  $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
  if (-not $remove.WaitForExit(120000)) { $remove.Kill() }
}
