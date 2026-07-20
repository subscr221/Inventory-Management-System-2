param(
  [string]$ComposeFile = "deploy/compose/docker-compose.yml",
  [string]$HealthUrl = "http://localhost/api/v1/health",
  [string]$EdgeUrl = "http://localhost/",
  [string]$PowerSyncUrl = "http://localhost/powersync/"
)

$ErrorActionPreference = "Stop"

docker compose -f $ComposeFile config | Out-Null

docker compose -f $ComposeFile up -d --build

$deadline = (Get-Date).AddMinutes(3)
$ok = $false
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5 | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $EdgeUrl -TimeoutSec 5 | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $PowerSyncUrl -TimeoutSec 5 | Out-Null
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 5
  }
}

if (-not $ok) {
  docker compose -f $ComposeFile ps
  throw "Story 1.8 smoke check failed before all services responded."
}

"Story 1.8 smoke check passed."
