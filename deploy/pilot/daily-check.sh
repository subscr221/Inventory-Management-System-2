#!/usr/bin/env bash
# Pilot morning check, run from the operator's machine (Git Bash on Windows is fine):
#   bash deploy/pilot/daily-check.sh            # prints the report, exit 0 all OK, 1 any WARN, 2 any FAIL
#   IMS_SSH_KEY=~/.ssh/other bash deploy/pilot/daily-check.sh
# Read-only: it runs SELECTs, df, du and ls on the staging box, nothing else. Reading guide:
# deploy/pilot/daily-check-guide.md.
set -uo pipefail
HOST="${IMS_HOST:-root@103.160.106.127}"
PORT="${IMS_SSH_PORT:-2222}"
KEY="${IMS_SSH_KEY:-$HOME/.ssh/ims_vps_automation}"

# Thresholds. Tune these after the first pilot week shows what normal looks like.
DISK_WARN=80 DISK_FAIL=90             # percent used on /
BACKUP_MAX_AGE_H=26                   # newest nightly base backup older than this = FAIL
SLOT_LAG_WARN_MB=64                   # PowerSync replication slot behind by more than this = WARN
TASK_UNOWNED_AGE_H=4                  # open task with nobody assigned for longer than this = WARN

ssh -p "$PORT" -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  DISK_WARN="$DISK_WARN" DISK_FAIL="$DISK_FAIL" BACKUP_MAX_AGE_H="$BACKUP_MAX_AGE_H" \
  SLOT_LAG_WARN_MB="$SLOT_LAG_WARN_MB" TASK_UNOWNED_AGE_H="$TASK_UNOWNED_AGE_H" 'bash -s' <<'REMOTE'
set -uo pipefail
cd /opt/ims/deploy/compose || { echo "FAIL  stack      /opt/ims/deploy/compose missing"; exit 2; }
worst=0
say() { # level name text
  printf '%-5s %-10s %s\n' "$1" "$2" "$3"
  case "$1" in WARN) [ "$worst" -lt 1 ] && worst=1 ;; FAIL) worst=2 ;; esac
}
q() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtF" " -v ON_ERROR_STOP=1' ; }

echo "IMS staging daily check  $(date '+%Y-%m-%d %H:%M %Z')"
echo

# 1. Containers
bad=$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' | awk '$2!="running" || $3=="unhealthy" {print $1}' | tr '\n' ' ')
n=$(docker compose ps --format '{{.Service}}' | wc -l)
if [ -n "$bad" ]; then say FAIL stack "not running or unhealthy: $bad"; else say OK stack "$n containers running"; fi

# 2. Events
read -r total day refused_open <<<"$(q <<'SQL'
select (select count(*) from domain_events),
       (select count(*) from domain_events where created_at > now() - interval '24 hours'),
       (select count(*) from edge_refused_capture where status = 'open');
SQL
)"
if [ -z "${total:-}" ]; then say FAIL events "database query failed"
else
  if [ "$day" -eq 0 ]; then say WARN events "$total total, 0 in last 24 h (nobody used the pilot?)"
  else say OK events "$total total, $day in last 24 h"; fi
  q <<'SQL' | sed 's/^/            /'
select event_type, count(*) from domain_events where created_at > now() - interval '24 hours'
group by 1 order by 2 desc limit 5;
SQL
  if [ "$refused_open" -gt 0 ]; then say WARN refused "$refused_open open refused captures (department head to resolve)"
  else say OK refused "0 open refused captures"; fi
fi

# 3. Backup
newest=$(ls -1t /root/ims-backups/ims-basebackup-*-nightly.tar.gz 2>/dev/null | head -1)
if [ -z "$newest" ]; then say FAIL backup "no nightly base backup in /root/ims-backups"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  if [ "$age_h" -gt "$BACKUP_MAX_AGE_H" ]; then say FAIL backup "newest nightly is ${age_h} h old: $(basename "$newest")"
  else say OK backup "newest nightly ${age_h} h old, $(du -h "$newest" | cut -f1): $(basename "$newest")"; fi
fi
if tail -3 /var/log/ims-basebackup.log 2>/dev/null | grep -qiE 'denied|error|no start segment'; then
  say FAIL backuplog "$(tail -1 /var/log/ims-basebackup.log)"
fi
labelled=$(ls -1 /root/ims-backups/*.tar.gz 2>/dev/null | grep -vc -- '-nightly\.')
echo "            ${labelled} labelled backups kept (never rotated; they also pin the WAL archive)"

# 4. Disk
pct=$(df --output=pcent / | tail -1 | tr -dc 0-9)
free=$(df -h --output=avail / | tail -1 | tr -d ' ')
wal=$(du -sh /var/lib/docker/volumes/compose_pg_data/_data/wal_archive 2>/dev/null | cut -f1)
msg="${pct}% used, ${free} free, WAL archive ${wal:-?}"
if [ "$pct" -ge "$DISK_FAIL" ]; then say FAIL disk "$msg"
elif [ "$pct" -ge "$DISK_WARN" ]; then say WARN disk "$msg"
else say OK disk "$msg"; fi

# 5. Sync (PowerSync replication slot)
read -r slot active lag_mb <<<"$(q <<'SQL'
select slot_name, active, round(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) / 1048576.0, 1)
from pg_replication_slots where slot_name like 'powersync%' order by active desc limit 1;
SQL
)"
if [ -z "${slot:-}" ]; then say FAIL sync "no powersync replication slot"
elif [ "$active" != "t" ]; then say FAIL sync "slot $slot is not active (PowerSync down?)"
elif [ "${lag_mb%.*}" -ge "$SLOT_LAG_WARN_MB" ]; then say WARN sync "slot $slot behind by ${lag_mb} MB"
else say OK sync "slot $slot active, behind by ${lag_mb} MB"; fi

# 6. Open tasks with no owner
unowned=$(q <<SQL
with t as (
  select 'putaway' k, status, assigned_to, created_at from putaway_task
  union all select 'pick', status, assigned_to, created_at from pick_task
  union all select 'replenishment', status, assigned_to, created_at from replenishment_task
  union all select 'cross-dock', status, assigned_to, created_at from cross_dock_task)
select k, count(*), round(extract(epoch from now() - min(created_at)) / 3600)
from t
where assigned_to is null
  and status not in ('completed', 'cancelled', 'canceled', 'closed', 'done')
  and created_at < now() - interval '${TASK_UNOWNED_AGE_H} hours'
group by k order by k;
SQL
)
if [ -z "$unowned" ]; then say OK tasks "no open task unassigned for more than ${TASK_UNOWNED_AGE_H} h"
else
  say WARN tasks "open tasks with nobody assigned (type, count, oldest in hours):"
  echo "$unowned" | sed 's/^/            /'
fi
qc_open=$(q <<'SQL'
select count(*) from qc_inspection_task where inspected_by is null
  and task_status not in ('completed', 'cancelled', 'closed');
SQL
)
echo "            ${qc_open:-?} QC inspection tasks not yet inspected (QC tasks have no assignee field)"

echo
case $worst in 0) echo "RESULT: all OK" ;; 1) echo "RESULT: WARN, read the guide" ;; *) echo "RESULT: FAIL, act before users start" ;; esac
exit $worst
REMOTE
