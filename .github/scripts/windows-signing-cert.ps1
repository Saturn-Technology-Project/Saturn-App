# Makes the Windows code-signing certificate available to electron-builder (WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD).
#
# With the repository's secrets: Saturn's self-signed certificate (desktop/build/saturn-code-signing.cer is its public
# half), so every build is signed by the same publisher and anyone can check the thumbprint. Without them (forks,
# pull requests): a throwaway certificate, so the signing path is still exercised.
$ErrorActionPreference = 'Stop'
$file = Join-Path $env:RUNNER_TEMP 'saturn-signing.pfx'
if ($env:PFX) {
  [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String($env:PFX))
  $password = $env:PFX_PASSWORD
  Write-Output 'Signing with Saturn''s self-signed certificate'
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Saturn Technology Project (ephemeral, self-signed)' `
    -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(7)
  $password = [Guid]::NewGuid().ToString('N')
  Write-Output "::add-mask::$password"
  Export-PfxCertificate -Cert $cert -FilePath $file -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
  Write-Output 'No signing secret: signing with a throwaway certificate'
}
"WIN_CSC_LINK=$file" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"WIN_CSC_KEY_PASSWORD=$password" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
