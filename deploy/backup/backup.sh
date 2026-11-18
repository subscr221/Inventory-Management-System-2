#!/usr/bin/env bash
# Take a pgBackRest backup of the pilot and report what the repository now holds.
#
# pgBackRest runs INSIDE the postgres container (deploy/compose/Dockerfile.postgres installs it),
# not on the host: the host has no pgbackrest binary, and the container is the only place with
# access to the data directory. Running it as root is refused by pgBackRest (error 031) because
# root-created repository files are unreadable to the postgres user on later runs, so -u postgres
# is required rather than cosmetic.
#
# Usage: backup.sh [full|diff|inc]
#   Defaults to full. A diff or incr backup requires a prior full as its base.

set -euo pipefail

STANZA="main"
BACKUP_TYPE="${1:-full}"
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../compose" && pwd)"
CONTAINER="$(docker compose -f "${COMPOSE_DIR}/docker-compose.yml" ps -q postgres)"

if [ -z "${CONTAINER}" ]; then
  echo "ERROR: postgres container not found; is the stack running?" >&2
  exit 1
fi

case "${BACKUP_TYPE}" in
  full | diff | incr) ;;
  *)
    echo "ERROR: backup type must be 'full', 'diff' or 'incr', got '${BACKUP_TYPE}'" >&2
    exit 1
    ;;
esac

echo "=== pgBackRest Backup: ${BACKUP_TYPE} ==="
echo "Stanza: ${STANZA}"
echo "Container: ${CONTAINER}"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker exec -u postgres "${CONTAINER}" \
  pgbackrest --stanza="${STANZA}" --type="${BACKUP_TYPE}" backup

echo "=== Backup complete ==="
docker exec -u postgres "${CONTAINER}" pgbackrest --stanza="${STANZA}" info
