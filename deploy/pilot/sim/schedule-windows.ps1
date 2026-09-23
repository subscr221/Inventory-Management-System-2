# Registers (or removes) the daily simulated pilot day in Windows Task Scheduler for the current
# user. The PC must be on and logged in at that time; a missed run starts when the PC wakes.
#   powershell -ExecutionPolicy Bypass -File deploy\pilot\sim\schedule-windows.ps1            # 08:30 local
#   powershell -ExecutionPolicy Bypass -File deploy\pilot\sim\schedule-windows.ps1 -At 07:00
#   powershell -ExecutionPolicy Bypass -File deploy\pilot\sim\schedule-windows.ps1 -Remove
# 08:30 on a UTC+8 clock is 06:00 IST, before the site's working day.
param([string]$At = '08:30', [switch]$Remove)

$name = 'IMS pilot simulated day'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Output "removed: $name"
  return
}
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash" }
$unixRepo = '/' + $repo.Substring(0, 1).ToLower() + $repo.Substring(2).Replace('\', '/')
$action = New-ScheduledTaskAction -Execute $bash -Argument "-lc `"cd '$unixRepo' && bash deploy/pilot/sim-day.sh`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "registered: $name, daily at $At, reports in $repo\_bmad-output\pilot-sim"
