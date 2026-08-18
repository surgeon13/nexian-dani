# Nexian web dashboard — dev launcher (PowerShell)
param(
  [string]$EnvFile = ".env",
  [switch]$Headless
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$argsList = @(
  "login.js",
  "--dashboard",
  "--keep-open",
  "--nexian-env-file=$EnvFile"
)

if (-not $Headless) {
  $argsList += "--headed"
}

Write-Host ""
Write-Host "Nexian dashboard (dev)"
Write-Host "  Env file:  $EnvFile"
Write-Host "  Browser:   $(if ($Headless) { 'headless' } else { 'headed' })"
Write-Host "  Dashboard: http://127.0.0.1:3847"
Write-Host ""

& node @argsList @args
exit $LASTEXITCODE
