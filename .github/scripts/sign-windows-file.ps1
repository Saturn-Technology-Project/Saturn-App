# Signs one file with the certificate windows-signing-cert.ps1 made available. The Tauri bundler calls this for each program
# and for the installer (bundle.windows.signCommand), so everything Saturn ships carries the same publisher.
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName | Select-Object -Last 1
& $kits.FullName sign /f $env:WIN_CSC_LINK /p $env:WIN_CSC_KEY_PASSWORD /fd sha256 /tr http://timestamp.digicert.com /td sha256 $File
