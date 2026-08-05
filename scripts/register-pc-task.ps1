# Register a Windows Task Scheduler job that starts Nexian 24/7 at logon.
# Run once in PowerShell (as your user; Admin not required for current-user tasks):
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#   .\scripts\register-pc-task.ps1
#
# Unregister:
#   .\scripts\register-pc-task.ps1 -Unregister

param(
  [switch]$Unregister,
  [string]$TaskName = "NexianDani-24-7"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Cmd = Join-Path $Root "start-24-7.cmd"

if (-not (Test-Path $Cmd)) {
  throw "Missing $Cmd"
}

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $TaskName"
  exit 0
}

$action = New-ScheduledTaskAction -Execute $Cmd -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName' to run at logon:"
Write-Host "  $Cmd"
Write-Host "Start now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Dashboard:  http://127.0.0.1:3847"
