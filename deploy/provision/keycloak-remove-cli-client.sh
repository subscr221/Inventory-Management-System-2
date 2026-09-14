#!/bin/bash
# Removes the provisioning-window "ims-cli" client (direct access grant) from the running
# Keycloak's "ims" realm through kcadm inside the container (Story 1.12). Run it once the edge UI
# sign-in has been verified on the box and the account/DOA provisioning scripts (runbook 2.9, 2.9a)
# are done: from then on people sign in through the browser (client ims-app, PKCE) and no password
# grant is reachable. A later re-provisioning run needs keycloak-add-cli-client.sh first, then this
# script again. Reads the bootstrap admin password from the root-only note; nothing is printed.
# Idempotent: a client that is already gone is reported, not an error. Any kcadm failure exits
# non-zero, so "removed" and "already absent" are only ever printed when they are true.
# Usage (as root on the box): /opt/ims/deploy/provision/keycloak-remove-cli-client.sh
set -euo pipefail
COMPOSE_DIR=/opt/ims/deploy/compose
NOTE=/root/ims-keycloak-admin.txt
[ -r "$NOTE" ] || { echo "cannot read $NOTE" >&2; exit 1; }
KC_ADMIN_USER="$(grep -oE 'user [^,]+' "$NOTE" | head -1 | cut -d' ' -f2 || true)"
KC_ADMIN_PW="$(grep -oE 'password [^ ]+' "$NOTE" | head -1 | cut -d' ' -f2 || true)"
if [ -z "$KC_ADMIN_USER" ] || [ -z "$KC_ADMIN_PW" ]; then
  echo "cannot parse the admin user and password from $NOTE" >&2
  exit 1
fi
export KC_ADMIN_USER KC_ADMIN_PW
cd "$COMPOSE_DIR"
# The credentials travel as environment variables (`-e NAME` copies the value without putting it
# on the docker command line) and the script body is single-quoted, so no quoting in the password
# can break out of it. kcadm keeps its session under $HOME/.keycloak; it is deleted on every exit.
docker compose exec -T -e KC_ADMIN_USER -e KC_ADMIN_PW keycloak sh -c '
  set -eu
  KC=/opt/keycloak/bin/kcadm.sh
  trap "rm -f \"\$HOME/.keycloak/kcadm.config\"" EXIT
  $KC config credentials --server http://localhost:8080 --realm master \
    --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PW" >/dev/null
  if ! OUT=$($KC get clients -r ims -q clientId=ims-cli --fields id); then
    echo "querying the ims realm clients failed" >&2
    exit 1
  fi
  ID=$(printf "%s" "$OUT" | grep -oE "\"id\" *: *\"[^\"]+\"" | head -1 | sed -E "s/.*\"([^\"]+)\"\$/\\1/" || true)
  if [ -z "$ID" ]; then
    echo "ims-cli client already absent"
  else
    if ! $KC delete "clients/$ID" -r ims; then
      echo "deleting the ims-cli client failed" >&2
      exit 1
    fi
    echo "ims-cli client removed"
  fi
  $KC get clients -r ims -q clientId=ims-app --fields clientId,publicClient,standardFlowEnabled,directAccessGrantsEnabled
'
unset KC_ADMIN_PW
