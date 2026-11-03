<#
  Register the weekly price refresh task (Sunday 05:00) that runs scripts/fc/weekly.mjs

  Usage (from Git Bash):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fc/install-weekly-task.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fc/install-weekly-task.ps1 -Remove

  Runs as the current user; no admin rights needed.
  Split of work: the server (47.95.238.28) runs 5i5j itself via crontab; this local
  task handles anjuke (its CDN risk-control blocks the server IP) and ke/beike
  (needs the lianjia.cookie login state plus the corporate proxy, which the server
  does not have) - it crawls locally, then pushes the JSON to the authoritative DB
  through scripts/deploy.mjs.
  NOTE: keep this file ASCII-only - PowerShell 5.1 parses BOM-less UTF-8 as GBK.
#>
param(
  [string]$TaskName = "luohu-price-weekly",
  [string]$Time = "05:00",
  [string]$Day = "Sunday",
  [string]$ScriptArgs = "--only anjuke,ke --push",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $TaskName"
  exit 0
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/fc -> repo root
$node = (Get-Command node).Source
$script = Join-Path $root "scripts\fc\weekly.mjs"

if (-not (Test-Path $script)) { throw "not found: $script" }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" $ScriptArgs" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -MultipleInstances IgnoreNew

# Try S4U first: runs whether or not the user is logged on, no password stored.
# Registering S4U needs an elevated shell; without it (0x80070005) fall back to
# the interactive logon type, which still runs while the user is logged on/locked.
$logonMode = "Interactive"
try {
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "luohu: weekly crawl of anjuke + beike prices, push to the authoritative DB" -Force -ErrorAction Stop | Out-Null
  $logonMode = "S4U (runs while logged off)"
} catch {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "luohu: weekly crawl of anjuke + beike prices, push to the authoritative DB" -Force | Out-Null
}
Write-Host "LogonType: $logonMode"
Write-Host "Tip: run this script from an elevated PowerShell to enable S4U (runs while logged off)."

$t = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Registered: $($t.TaskName)  State=$($t.State)  NextRun=$($info.NextRunTime)"
Write-Host "Command: $node `"$script`" $ScriptArgs"
Write-Host "Run now: schtasks /Run /TN $TaskName"
