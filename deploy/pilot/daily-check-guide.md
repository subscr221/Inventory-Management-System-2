# Daily Pilot Check: Reading Guide

Run it each morning before the pilot users start:

```bash
bash deploy/pilot/daily-check.sh
```

It only reads: SELECT queries, `df`, `du` and `ls` on the staging box. Each line starts with
`OK`, `WARN` or `FAIL`; the last line sums it up. Exit code 0 means all OK, 1 means at least one
WARN, 2 means at least one FAIL.

## What each line means

Table G1 explains each line and what to do when it is not OK.

Table G1: Check lines and actions

| Line | OK means | WARN or FAIL means | Do this |
| --- | --- | --- | --- |
| `stack` | All six containers run and none is unhealthy | A container stopped or reports unhealthy | `docker compose ps` and `docker compose logs --tail 50 <service>` in `/opt/ims/deploy/compose`; after recreating the app, restart nginx (it keeps the old address and answers 502) |
| `events` | Events were written in the last 24 hours; the five busiest types follow | WARN: nothing in 24 hours | On a working day, ask the site head whether anyone used the pilot; on a holiday, ignore |
| `refused` | No refused capture is waiting | WARN: open refusals | Tell the department head; they resolve them on the Refused captures screen |
| `backup` | Newest nightly base backup is under 26 hours old | FAIL: the nightly did not run | See "Backup FAIL" below |
| `backuplog` | Shown only on trouble | FAIL: the last lines of `/var/log/ims-basebackup.log` hold an error | Same as `backup` |
| `disk` | Under 80 percent used | WARN at 80, FAIL at 90 | See "Disk" below |
| `sync` | The PowerSync replication slot is active and close to current | FAIL: slot missing or inactive; WARN: behind by 64 MB or more | `docker compose logs --tail 50 powersync`; restart the powersync service; PowerSync recreates a missing slot by itself |
| `tasks` | No putaway, pick, replenishment or cross-dock task has sat open with nobody assigned for more than 4 hours | WARN: lists type, count and age of the oldest | Ask the site head who should take them; the pilot may simply have no floor user for that task type |

The indented lines under `events`, `backup` and `tasks` are for information and never change the
result.

## Backup FAIL

The nightly job runs from root's crontab at 02:30 IST. On 2026-09-22 and 2026-09-23 it failed
with `Permission denied`: shipping with `git archive` wrote the script without its execute bit.
Fixed on 2026-09-23 (execute bit set on the box and in git). The `backuplog` line keeps showing
the old error until the next nightly run writes a good line.

If it fails again:

1. Run it by hand on the box: `/opt/ims/deploy/backup/staging-basebackup.sh manual`.
2. If that says `Permission denied`, run `chmod 755 /opt/ims/deploy/backup/*.sh`.
3. Re-run the daily check.

## Disk

The WAL archive grows by about 4 GB a day: `archive_timeout=5min` writes a 16 MB segment every
five minutes even when nothing happens. The backup script cuts the archive at the oldest base
backup still on disk, and labelled backups are never deleted automatically. So the oldest
labelled backup decides how much archive is kept. To free space, delete old labelled backups you
will not restore to (oldest first) and run a manual backup; it cuts the archive again.

## Thresholds

The thresholds sit at the top of `daily-check.sh`: disk 80 and 90 percent, backup 26 hours, sync
lag 64 MB, unassigned task 4 hours. Change them there once the first week shows what normal looks
like.
