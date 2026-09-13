#!/bin/bash
# Staging accounts and pilot site bootstrap (round table 2026-09-13). Runs as root on the box.
#   1. Keycloak: one account per named person (username = email), password generated here and
#      written ONLY to /root/ims-first-passwords.txt (mode 600) for the operator to hand out.
#   2. Bootstrap hats for the migration lead at every site ('*') so they can create the site.
#   3. Token through the rehearsal-only ims-cli client, then POST /api/v1/locations for the site.
#   4. Final roles file with the real site id, provisioned through the SCIM seam; verify:roles
#      (expect DOA_BAND_MISSING until staging-doa-bands.sh has run as the finance controller).
# Idempotent where it matters: existing Keycloak users are kept (passwords untouched), an existing
# site is reused, provisioning REPLACES role sets (never deprovisions).
# Usage: staging-bootstrap-accounts.sh <site-code> <lead-email> <head-email> <finance-email> <cfo-email> <site-head-email>
set -euo pipefail
SITE_CODE="${1:?site code}"; LEAD="${2:?lead}"; HEAD="${3:?head}"; FIN="${4:?finance}"; CFO="${5:?cfo}"; SITEHEAD="${6:?site head}"
COMPOSE_DIR=/opt/ims/deploy/compose
NOTE=/root/ims-keycloak-admin.txt
PW_FILE=/root/ims-first-passwords.txt
API=https://ims-staging.ancorlabs.org
AUTH=https://auth.ancorlabs.org
RESOLVE=(--resolve ims-staging.ancorlabs.org:8443:127.0.0.1 --resolve auth.ancorlabs.org:8443:127.0.0.1)
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
LEAD=$(lower "$LEAD"); HEAD=$(lower "$HEAD"); FIN=$(lower "$FIN"); CFO=$(lower "$CFO"); SITEHEAD=$(lower "$SITEHEAD")
cd "$COMPOSE_DIR"
# Per-run path inside the container: a leftover root-owned file from an earlier attempt must
# not block the container user's write.
IN_CONTAINER=/tmp/ims-roles.$$.json

echo "=== 1. Keycloak accounts"
ADMIN_USER="$(grep -oE 'user [^,]+' "$NOTE" | head -1 | cut -d' ' -f2)"
ADMIN_PW="$(grep -oE 'password [^ ]+' "$NOTE" | head -1 | cut -d' ' -f2)"
umask 077; touch "$PW_FILE"
for email in $(printf '%s\n%s\n%s\n%s\n%s\n' "$LEAD" "$HEAD" "$FIN" "$CFO" "$SITEHEAD" | sort -u); do
  if grep -q "^${email} " "$PW_FILE"; then echo "kept    $email (already provisioned by this script)"; continue; fi
  PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  docker compose exec -T keycloak sh -c "
    set -e; KC=/opt/keycloak/bin/kcadm.sh
    \$KC config credentials --server http://localhost:8080 --realm master --user '${ADMIN_USER}' --password '${ADMIN_PW}' >/dev/null
    if \$KC get users -r ims -q email='${email}' --fields username 2>/dev/null | grep -q username; then
      echo 'exists  ${email}'
    else
      # First and last name are REQUIRED by the default user profile: without them every grant answers
      # 'Account is not fully set up' (seen 2026-09-13). Local part of the mailbox, letters only (the validator refuses punctuation), as a placeholder;
      # people correct it in the account console.
      \$KC create users -r ims -s username='${email}' -s email='${email}' -s enabled=true -s emailVerified=true -s "firstName=$(printf '%s' "${email%%@*}" | tr -c 'A-Za-z\n' ' ' | sed -E 's/\b(.)/\u\1/g')" -s lastName=Ancorlabs >/dev/null
      \$KC set-password -r ims --username '${email}' --new-password '${PW}' 2>/dev/null
      echo 'created ${email}'
    fi
    rm -f /root/.keycloak/kcadm.config 2>/dev/null || true
  " | tail -1
  printf '%s %s\n' "$email" "$PW" >> "$PW_FILE"
done
unset ADMIN_PW
echo "passwords in $PW_FILE (root only). Everyone changes theirs at ${AUTH}/realms/ims/account"

echo "=== 2. bootstrap hats for the migration lead (every site)"
NIL=00000000-0000-0000-0000-000000000000
cat > /root/ims-roles-bootstrap.json <<EOF
{ "site_id": "$NIL", "roles": [
  { "role": "migration_lead", "module": "migration", "function_scope": "write", "location_id": "*", "holder": "$LEAD" },
  { "role": "migration_lead", "module": "migration", "function_scope": "read",  "location_id": "*", "holder": "$LEAD" },
  { "role": "migration_lead", "module": "inventory", "function_scope": "write", "location_id": "*", "holder": "$LEAD" },
  { "role": "migration_lead", "module": "inventory", "function_scope": "read",  "location_id": "*", "holder": "$LEAD" }
] }
EOF
# Streamed in as the container user (a `docker compose cp` lands root-only, unreadable by appuser).
docker compose exec -T app sh -c "cat > $IN_CONTAINER" < /root/ims-roles-bootstrap.json
docker compose exec -T app node dist/src/cli/provision-roles.js "$IN_CONTAINER" --apply | tail -3

echo "=== 3. token for the lead, then the site"
LEAD_PW="$(grep "^${LEAD} " "$PW_FILE" | head -1 | cut -d' ' -f2)"
TOKEN="$(curl -sS -m 20 "${RESOLVE[@]}" -X POST "${AUTH}:8443/realms/ims/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=ims-cli --data-urlencode "username=${LEAD}" --data-urlencode "password=${LEAD_PW}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))')"
unset LEAD_PW
[ -n "$TOKEN" ] || { echo "no token for ${LEAD}"; exit 3; }
echo "token ok ($(printf '%s' "$TOKEN" | wc -c) chars)"
EXISTING="$(docker compose exec -T postgres psql -U admin_user -d inventory_events -tAc "select location_id from location_register where location_code = '${SITE_CODE}' and level = 'site'" | tr -d '[:space:]')"
if [ -n "$EXISTING" ]; then
  SITE_ID="$EXISTING"; echo "site exists: $SITE_ID"
else
  RESP="$(curl -sS -m 20 "${RESOLVE[@]}" -X POST "${API}:8443/api/v1/locations" -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"location_code\":\"${SITE_CODE}\",\"level\":\"site\",\"idempotency_key\":\"bootstrap-site-${SITE_CODE}\"}")"
  SITE_ID="$(printf '%s' "$RESP" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("location_id") or (d.get("location") or {}).get("location_id") or "")' 2>/dev/null || true)"
  [ -n "$SITE_ID" ] || { echo "site creation failed: $(printf '%s' "$RESP" | cut -c1-300)"; exit 4; }
  echo "site created: $SITE_ID"
fi
unset TOKEN

echo "=== 4. final roles for ${SITE_CODE}"
cat > /root/ims-roles.json <<EOF
{ "site_id": "$SITE_ID", "roles": [
  { "role": "migration_lead",     "module": "migration", "function_scope": "write", "location_id": "site", "holder": "$LEAD" },
  { "role": "migration_lead",     "module": "migration", "function_scope": "read",  "location_id": "site", "holder": "$LEAD" },
  { "role": "migration_lead",     "module": "inventory", "function_scope": "write", "location_id": "site", "holder": "$LEAD" },
  { "role": "migration_lead",     "module": "inventory", "function_scope": "read",  "location_id": "site", "holder": "$LEAD" },
  { "role": "cfo",                "module": "jobwork",   "function_scope": "write", "location_id": "*",    "holder": "$CFO" },
  { "role": "department_head",    "module": "migration", "function_scope": "write", "location_id": "site", "holder": "$HEAD" },
  { "role": "department_head",    "module": "engineering","function_scope": "write","location_id": "site", "holder": "$HEAD" },
  { "role": "department_head",    "module": "procurement","function_scope": "write","location_id": "site", "holder": "$HEAD" },
  { "role": "department_head",    "module": "jobwork",   "function_scope": "write", "location_id": "site", "holder": "$HEAD" },
  { "role": "department_head",    "module": "custody",   "function_scope": "write", "location_id": "site", "holder": "$HEAD" },
  { "role": "finance_controller", "module": "migration", "function_scope": "write", "location_id": "*",    "holder": "$FIN" },
  { "role": "finance_controller", "module": "jobwork",   "function_scope": "write", "location_id": "*",    "holder": "$FIN" },
  { "role": "finance_controller", "module": "compliance","function_scope": "write", "location_id": "*",    "holder": "$FIN" },
  { "role": "warehouse_manager",  "module": "warehouse", "function_scope": "write", "location_id": "site", "holder": "$SITEHEAD" },
  { "role": "warehouse_manager",  "module": "inventory", "function_scope": "write", "location_id": "site", "holder": "$SITEHEAD" }
] }
EOF
docker compose exec -T app sh -c "cat > $IN_CONTAINER" < /root/ims-roles.json
docker compose exec -T app node dist/src/cli/provision-roles.js "$IN_CONTAINER" --apply | tail -6
docker compose exec -T app rm -f "$IN_CONTAINER" || true
echo "=== 5. verify:roles"
docker compose exec -T app node dist/src/cli/verify-segregated-roles.js 2>&1 | tail -8
