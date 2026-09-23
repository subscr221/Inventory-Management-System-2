#!/usr/bin/env bash
# One simulated pilot day on staging, run from the operator's machine (Git Bash on Windows):
#   bash deploy/pilot/sim-day.sh              # API day + browser day + daily check
#   bash deploy/pilot/sim-day.sh --api-only   # skip the browser part
# Stands in for pilot users the site cannot spare (decided 2026-09-23). Staging only: every pilot
# account uses the sandbox password (OPS_PW, default 1234). Never point this at production.
#
# The password-grant client `ims-cli` exists only while the run needs it: added first, removed on
# exit whatever happens (ruling 2026-09-23). Reports go to _bmad-output/pilot-sim/.
set -uo pipefail
cd "$(dirname "$0")/../.."
HOST="${IMS_HOST:-root@103.160.106.127}"
PORT="${IMS_SSH_PORT:-2222}"
KEY="${IMS_SSH_KEY:-$HOME/.ssh/ims_vps_automation}"
export OPS_PW="${OPS_PW:-1234}" PILOT_PW="${PILOT_PW:-1234}"
OUT=_bmad-output/pilot-sim
TS="$(date +%Y-%m-%d-%H%M)"
LOG="$OUT/$TS-summary.txt"
mkdir -p "$OUT"
box() { ssh -p "$PORT" -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

remove_client() {
  box 'bash /opt/ims/deploy/provision/keycloak-remove-cli-client.sh' 2>&1 | grep -m1 'ims-cli client' | sed 's/^/  /'
}
trap remove_client EXIT

{
  echo "Simulated pilot day  $TS"
  echo
  echo "== password-grant client"
  box 'bash /opt/ims/deploy/provision/keycloak-add-cli-client.sh' 2>&1 | grep -m1 'ims-cli client' | sed 's/^/  /'
} | tee "$LOG"

api=0 web=0 chk=0
echo "== API day (pilot-day.ts)" | tee -a "$LOG"
node --import tsx deploy/pilot/sim/pilot-day.ts \
  --remote deploy/pilot/sim/staging-sim.json --pack docs/migration/pilot-mock-extract \
  --ssh "$HOST" --ssh-port "$PORT" --ssh-key "$KEY" --report-dir "$OUT" \
  > "$OUT/$TS-api.txt" 2>&1 || api=$?
grep -E '^(PASS|FAIL|SKIP) ' "$OUT/$TS-api.txt" | grep -v '^PASS ' | sed 's/^/  /' | tee -a "$LOG"
grep -E '^(PASS|FAIL): ' "$OUT/$TS-api.txt" | sed 's/^/  /' | tee -a "$LOG"

if [ "${1:-}" != "--api-only" ] && [ -f edge/playwright.staging.config.ts ]; then
  echo "== Browser day (Playwright, real sign-in)" | tee -a "$LOG"
  (cd edge && PW_JSON_OUT="$TS-browser.json" npx playwright test -c playwright.staging.config.ts --reporter=line) \
    > "$OUT/$TS-browser.txt" 2>&1 || web=$?
  grep -E '[0-9]+ (passed|failed|flaky|skipped)|✘|^\s+[0-9]+\) ' "$OUT/$TS-browser.txt" | sed 's/^/  /' | tee -a "$LOG"
fi

echo "== Daily check" | tee -a "$LOG"
bash deploy/pilot/daily-check.sh > "$OUT/$TS-check.txt" 2>&1 || chk=$?
grep -E '^(WARN|FAIL|RESULT)' "$OUT/$TS-check.txt" | sed 's/^/  /' | tee -a "$LOG"

echo | tee -a "$LOG"
if [ $api -eq 0 ] && [ $web -eq 0 ] && [ $chk -lt 2 ]; then echo "DAY RESULT: PASS" | tee -a "$LOG"; rc=0
else echo "DAY RESULT: FAIL (api=$api browser=$web check=$chk), details in $OUT/$TS-*.txt" | tee -a "$LOG"; rc=1; fi
echo "== password-grant client removal" | tee -a "$LOG"
exit $rc
