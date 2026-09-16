#!/bin/bash
# DOA approval bands for the pilot (round table 2026-09-13). verify:roles refuses go-live while the
# three sign-off transaction types have no active band (Story 1.13 adds a fourth: refusal resolution), because "no band" means postings of any
# value proceed unsigned. The finance controller (who holds `compliance` write, see the roles file)
# registers one unbounded band per type: every posting of that type needs the named role's
# signature. A band that already exists answers 409 and is kept. Runs as root on the box.
# Usage: staging-doa-bands.sh <finance-controller-email>
set -euo pipefail
FIN="$(printf '%s' "${1:?finance controller email}" | tr 'A-Z' 'a-z')"
COMPOSE_DIR=/opt/ims/deploy/compose
PW_FILE=/root/ims-first-passwords.txt
API=https://ims-staging.ancorlabs.org
AUTH=https://auth.ancorlabs.org
RESOLVE=(--resolve ims-staging.ancorlabs.org:8443:127.0.0.1 --resolve auth.ancorlabs.org:8443:127.0.0.1)
cd "$COMPOSE_DIR"
# Password: FIN_PW from the environment, else the first-passwords file (gone once people set their own).
FIN_PW="${FIN_PW:-}"
[ -n "$FIN_PW" ] || FIN_PW="$( { grep "^${FIN} " "$PW_FILE" 2>/dev/null || true; } | head -1 | cut -d' ' -f2)"
[ -n "$FIN_PW" ] || { echo "no password for ${FIN}: set FIN_PW or add a line to ${PW_FILE}"; exit 2; }
TOKEN="$(curl -sS -m 20 "${RESOLVE[@]}" -X POST "${AUTH}:8443/realms/ims/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=ims-cli --data-urlencode "username=${FIN}" --data-urlencode "password=${FIN_PW}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))')"
unset FIN_PW
[ -n "$TOKEN" ] || { echo "no token for ${FIN}"; exit 3; }

band() { # role transaction_type idempotency-suffix
  local code
  # An active band for this type+role already in the projection is "present" whatever key made it
  # (the 2026-09-13 bands were created with other keys, so the 409 path alone duplicated them).
  if [ "$(docker compose exec -T postgres psql -U admin_user -d inventory_events -At         -c "select count(*) from doa_registry_entries where transaction_type='$2' and role='$1' and active")" != "0" ]; then
    echo "band $2 -> $1: already present"; return 0
  fi
  code="$(curl -sS -m 20 "${RESOLVE[@]}" -o /tmp/doa-band.out -w '%{http_code}' -X POST "${API}:8443/api/v1/doa/entries" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"role\":\"$1\",\"transaction_type\":\"$2\",\"idempotency_key\":\"pilot-band-$3\"}")"
  case "$code" in
    200|201) echo "band $2 -> $1: created";;
    409)     echo "band $2 -> $1: already present";;
    *)       echo "band $2 -> $1: HTTP $code $(cut -c1-200 /tmp/doa-band.out)"; rm -f /tmp/doa-band.out; exit 4;;
  esac
  rm -f /tmp/doa-band.out
}
band department_head    migration.domain_signoff        domain-signoff
band finance_controller migration.variance_explanation  variance-explanation
band cfo                jobwork.offcut_acquisition      offcut-acquisition
# Story 1.13: the applier resolves this type under the row lock; with no band every resolve is
# 409 APPROVAL_UNRESOLVED. The department head holds write on every edge module at the site.
band department_head    edge.refused_capture_resolution refused-capture-resolution
unset TOKEN
echo "=== verify:roles"
docker compose exec -T app node dist/src/cli/verify-segregated-roles.js 2>&1 | tail -8
