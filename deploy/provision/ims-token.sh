#!/bin/bash
# Operator token for the rehearsal (round table 2026-09-13). Exchanges a Keycloak username and
# password for an access token through the rehearsal-only public client "ims-cli" (direct access
# grant), and prints the token to stdout so a script can do:
#   export IMS_TOKEN="$(deploy/provision/ims-token.sh migration.lead@ancorlabs.org)"
#   curl -H "Authorization: Bearer $IMS_TOKEN" https://ims-staging.ancorlabs.org/api/v1/...
# The password is read from the terminal, never from an argument or a file. Tokens last 15 minutes
# (realm accessTokenLifespan); rerun to get a fresh one. Delete the ims-cli client after the pilot.
set -euo pipefail
AUTH_BASE="${IMS_AUTH_BASE:-https://auth.ancorlabs.org}"
REALM="${IMS_REALM:-ims}"
USER_NAME="${1:?usage: ims-token.sh <username-email>}"
read -r -s -p "Keycloak password for ${USER_NAME}: " PASSWORD; echo >&2
RESPONSE="$(curl -sS -m 20 -X POST "${AUTH_BASE}/realms/${REALM}/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=ims-cli \
  --data-urlencode "username=${USER_NAME}" --data-urlencode "password=${PASSWORD}")"
unset PASSWORD
TOKEN="$(printf '%s' "$RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("access_token",""))' 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "no token: $(printf '%s' "$RESPONSE" | cut -c1-200)" >&2
  exit 1
fi
printf '%s' "$TOKEN"
