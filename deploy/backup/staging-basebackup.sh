#!/usr/bin/env bash
# Staging-only backup (ruling 2026-09-20): a nightly pg_basebackup plus WAL-archive pruning, for
# the pilot on the shared VPS. Production uses pgBackRest (backup.sh); this script is the shortcut
# that keeps staging restorable and its disk bounded until then. Runs as root on the box.
#
# Usage: staging-basebackup.sh [label]        (cron: 30 2 * * * /opt/ims/deploy/backup/staging-basebackup.sh nightly)
# Env:   BACKUP_DIR (default /root/ims-backups), KEEP (default 7)
#
# Restore: stop the stack, empty the postgres data volume, untar the chosen backup into it, start
# postgres. Each backup carries the WAL it needs (-X fetch), so it restores on its own; the
# archive segments kept after it allow replay beyond it.
set -euo pipefail
LABEL="${1:-manual}"
BACKUP_DIR="${BACKUP_DIR:-/root/ims-backups}"
KEEP="${KEEP:-7}"
COMPOSE_DIR=/opt/ims/deploy/compose
ARCHIVE=/var/lib/postgresql/wal_archive

umask 077
mkdir -p "$BACKUP_DIR"
cd "$COMPOSE_DIR"
TS="$(date +%Y%m%d%H%M)"
OUT="${BACKUP_DIR}/ims-basebackup-${TS}-${LABEL}.tar.gz"

docker compose exec -T postgres pg_basebackup -U admin_user -D - -Ft -X fetch -l "${LABEL}-${TS}" | gzip > "${OUT}.partial"
gzip -t "${OUT}.partial"
tar xzOf "${OUT}.partial" backup_label | grep -q 'START WAL LOCATION'
mv "${OUT}.partial" "$OUT"
echo "backup   ${OUT} ($(du -h "$OUT" | cut -f1))"

# Retention: the newest $KEEP backups stay, and the archive is cut at the oldest one kept.
ls -1t "$BACKUP_DIR"/ims-basebackup-*.tar.gz | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"; echo "expired  ${old}"
done
OLDEST="$(ls -1t "$BACKUP_DIR"/ims-basebackup-*.tar.gz | tail -1)"
START_SEGMENT="$(tar xzOf "$OLDEST" backup_label | sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]\{24\}\)).*/\1/p')"
[ -n "$START_SEGMENT" ] || { echo "no start segment in ${OLDEST}; archive left alone" >&2; exit 1; }
BEFORE="$(docker compose exec -T postgres sh -c "ls $ARCHIVE | wc -l")"
docker compose exec -T -u postgres postgres pg_archivecleanup "$ARCHIVE" "$START_SEGMENT"
AFTER="$(docker compose exec -T postgres sh -c "ls $ARCHIVE | wc -l")"
echo "archive  cut at ${START_SEGMENT}: ${BEFORE} -> ${AFTER} files"
