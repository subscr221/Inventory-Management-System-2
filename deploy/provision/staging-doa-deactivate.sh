#!/bin/bash
# Deactivates DOA registry entries by id through the API (event-sourced; never UPDATE the table).
# Usage: FIN_PW=<password> staging-doa-deactivate.sh <compliance-writer-email> <entry_id>...
set -euo pipefail
FIN="$(printf '%s' "${1:?compliance writer email}" | tr 'A-Z' 'a-z')"; shift
[ $# -gt 0 ] || { echo "no entry ids"; exit 2; }
: "${FIN_PW:?set FIN_PW}"
API=https://ims-staging.ancorlabs.org
AUTH=https://auth.ancorlabs.org
RESOLVE=(--resolve ims-staging.ancorlabs.org:8443:127.0.0.1 --resolve auth.ancorlabs.org:8443:127.0.0.1)
TOKEN="$(curl -sS -m 20 "${RESOLVE[@]}" -X POST "${AUTH}:8443/realms/ims/protocol/openid-connect/token"   -d grant_type=password -d client_id=ims-cli --data-urlencode "username=${FIN}" --data-urlencode "password=${FIN_PW}"   | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))')"
unset FIN_PW
[ -n "$TOKEN" ] || { echo "no token for ${FIN}"; exit 3; }
for id in "$@"; do
  code="$(curl -sS -m 20 "${RESOLVE[@]}" -o /tmp/doa-deact.out -w '%{http_code}' -X PATCH "${API}:8443/api/v1/doa/entries/${id}"     -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json'     -d "{\"active\":false,\"idempotency_key\":\"deactivate-${id}\"}")"
  echo "deactivate ${id}: HTTP ${code} $(cut -c1-160 /tmp/doa-deact.out)"
  rm -f /tmp/doa-deact.out
done
unset TOKEN
