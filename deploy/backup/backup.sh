#!/usr/bin/env bash
set -euo pipefail

STANZA="main"
BACKUP_TYPE="${1:-full}"

echo "=== pgBackRest Backup: ${BACKUP_TYPE} ==="
echo "Stanza: ${STANZA}"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

pgbackrest --stanza="${STANZA}" --type="${BACKUP_TYPE}" backup

echo "=== Backup complete ==="
pgbackrest --stanza="${STANZA}" info
