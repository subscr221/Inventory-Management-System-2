#!/bin/bash
# Adds the rehearsal-only "ims-cli" client to the running Keycloak's "ims" realm through kcadm
# inside the container (round table 2026-09-13). Needed because a realm import runs only when the
# realm does not exist yet (strategy IGNORE_EXISTING), so a client added to realm-ims.json after
# the first boot never reaches a live realm. Reads the bootstrap admin password from the root-only
# note the .env generation left; nothing is printed. Idempotent: a client that exists is left alone.
# Usage (as root on the box): /opt/ims/deploy/provision/keycloak-add-cli-client.sh
set -euo pipefail
COMPOSE_DIR=/opt/ims/deploy/compose
NOTE=/root/ims-keycloak-admin.txt
CLIENT_JSON=/opt/ims/deploy/keycloak/client-ims-cli.json
ADMIN_USER="$(grep -oE 'user [^,]+' "$NOTE" | head -1 | cut -d' ' -f2)"
ADMIN_PW="$(grep -oE 'password [^ ]+' "$NOTE" | head -1 | cut -d' ' -f2)"
cd "$COMPOSE_DIR"
docker compose cp "$CLIENT_JSON" keycloak:/tmp/client-ims-cli.json
docker compose exec -T keycloak sh -c "
  set -e
  KC=/opt/keycloak/bin/kcadm.sh
  \$KC config credentials --server http://localhost:8080 --realm master --user '${ADMIN_USER}' --password '${ADMIN_PW}' >/dev/null
  if \$KC get clients -r ims -q clientId=ims-cli --fields clientId 2>/dev/null | grep -q '\"ims-cli\"'; then
    echo 'ims-cli client already present'
  else
    \$KC create clients -r ims -f /tmp/client-ims-cli.json >/dev/null && echo 'ims-cli client created'
  fi
  \$KC get clients -r ims -q clientId=ims-cli --fields clientId,publicClient,directAccessGrantsEnabled,standardFlowEnabled
  rm -f /tmp/client-ims-cli.json /root/.keycloak/kcadm.config 2>/dev/null || true
"
unset ADMIN_PW
