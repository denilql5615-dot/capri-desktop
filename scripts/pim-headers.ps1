param(
  [string]$ConfigPath = (Join-Path $env:APPDATA 'capri-desktop\config.json'),
  [switch]$Protect,
  [switch]$TokenOnly
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Security
  if ($Protect) {
    $token = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 4096) {
      throw 'Invalid PIM capability'
    }
    $plaintext = [Text.Encoding]::UTF8.GetBytes($token)
    $ciphertext = [Security.Cryptography.ProtectedData]::Protect(
      $plaintext,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    "dpapi:$([Convert]::ToBase64String($ciphertext))"
    exit 0
  }

  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $encrypted = [string]$config.pimMcpToken
  if (-not $encrypted.StartsWith('dpapi:', [StringComparison]::Ordinal)) {
    throw 'Missing encrypted PIM capability'
  }

  $ciphertext = [Convert]::FromBase64String($encrypted.Substring(6))
  $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
    $ciphertext,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $token = [Text.Encoding]::UTF8.GetString($plaintext)
  if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 4096) {
    throw 'Invalid PIM capability'
  }

  if ($TokenOnly) {
    $token
  } else {
    @{ Authorization = "Bearer $token" } | ConvertTo-Json -Compress
  }
} catch {
  [Console]::Error.WriteLine('Unable to load the Capri PIM capability.')
  exit 1
}
