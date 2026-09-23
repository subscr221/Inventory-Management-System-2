# Production Cutover Checklist, CMF-ALIGARH

Status: DRAFT 2026-09-23. Dates are PROPOSED by the program director's assistant and hold only
once the program director confirms them. Target: production go-live Monday 2026-10-12, after the
pilot week ends and its review is done.

This list covers what must be true before the production window in section 8 of the pilot
cutover runbook opens. The window itself (freeze, loads, sign-offs, unblock) stays in the
runbook. Pilot rules do NOT carry over: no shared password, no fictitious people, no mock data,
no `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM=true`.

## People named in this checklist

Owners are named by role; Table P1 maps each role to a person.

Table P1: Owners

| Role | Person | Account |
| --- | --- | --- |
| Program director | [fill in] | none needed |
| Migration lead | Gagan Kumar | `info@ancorlabs.org` |
| Site head (runs the ERP) | [fill in] | `cmf_supervisor@ancorlabs.org` |
| BOM engineer | Devender | `dev1@ancorlabs.org` |
| Finance controller | [fill in] | `accounts@ancorlabs.org` |
| Company IT | [fill in] | owns the server and its root and password logins |
| Operator | [fill in] | runs scripts on the box with a key |

## The checklist

Every row in Table P2 is a hard stop: production does not open until all rows show done with
their evidence. Rows are in dependency order; a row may start before the one above it ends.

Table P2: Production readiness

| No. | Item | Owner | Due (proposed) | Evidence | Done |
| --- | --- | --- | --- | --- | --- |
| P0 | Decide the production host: a separate server, or the shared VPS that runs staging | Program director, company IT | 2026-09-25 | Decision D1 below | done 2026-09-23 |
| P1 | Site data request: confirm `site-data-request-cmf-aligarh.md` was sent, to whom and when; agree the first-draft date | Program director | 2026-09-25 | recipient Anupam (`anupam@ancorlabs.org`), first version asked for by 2026-09-30, files to the migration lead; sent date: [fill in] | |
| P2 | First-draft extract received (five CSV files) | Site head | 2026-09-30 | files received | |
| P3 | Rehearsal on staging with the real first draft: runbook sections 4 to 7, fill Tables 3, 3a and 3b | Migration lead | 2026-10-03 | Tables 3, 3a, 3b filled | |
| P4 | Kit BOMs: the site head lists every open job-work service order; the BOM engineer creates a kit BOM for each and attaches it (without one, a challan receipt is refused `JOBWORK_ORDER_KIT_BOM_REQUIRED` in production) | Site head (list), BOM engineer (BOMs) | 2026-10-05 | query in note 1 returns 0 on the rehearsal database | |
| P5 | Backups (Decision D2): keep the nightly `staging-basebackup.sh` base backup plus the WAL archive; no pgBackRest. Company IT gets the QNAP job working again (it has failed every night since at least 2026-09-20 with "Cannot reach QNAP at 122.160.173.136") and adds the WAL archive folder of the postgres volume to it. `/root/ims-backups` is already inside the job's `/root` copy. Then one restore drill from the QNAP copy into a throwaway container | Company IT (QNAP), operator (drill) | 2026-10-06 | a QNAP log line with a successful run; nightly backup PASS in the daily check; restore drill row counts equal live | |
| P6 | SSH: root and password logins stay on for company IT; the risk is accepted (Decision D1). Project work keeps using the automation key only. Record who in company IT holds the root password | Program director, company IT | 2026-10-06 | Decision D1 below, name of the root-password holder | risk accepted 2026-09-23 |
| P7 | Real accounts: one Keycloak account per real person, real names, no shared or role mailboxes; each person sets their own password at first sign-in; `roles.json` with real holders, dry run shows no `REFUSE`, apply, `verify:roles` clean; DOA bands registered by the real finance controller | Program director (names), operator (provisioning) | 2026-10-07 | `verify:roles` output, account list | |
| P8 | Remove pilot leftovers from production: no pilot accounts (the 21 fictitious staff, `erp1` unless the ERP feed keeps it with a new password), no `ims-cli` client after provisioning, Keycloak admin password rotated | Operator | 2026-10-07 | realm user list, client list | |
| P9 | Environment: `JOBWORK_RECEIPT_ALLOW_NO_KIT_BOM=false` (the default), `EVENT_OCCURRED_AT_MAX_AGE_DAYS` and ERP sync schedule recorded (runbook 2.13) | Operator | 2026-10-07 | `.env` review | |
| P10 | ERP feed pause: agree how the site head stops the ERP sync during sign-offs (runbook section 7 step 2, still open) | Site head | 2026-10-07 | written procedure | |
| P11 | Table 5 of the runbook filled with times and owners from the rehearsal | Migration lead | 2026-10-08 | Table 5 filled | |
| P12 | Final extract on the freeze day, then the runbook window | Site head, migration lead | 2026-10-10 to 2026-10-12 | unblock event id | |

Note 1, the kit-BOM query for P4 (run as the database owner):

```sql
select count(*) from service_order where kit_bom_id is null;
```

The result must be 0, or every remaining row must be a closed order the site confirms will
receive nothing more.

## Decisions

Decision D1, production host (program director, 2026-09-23): production runs on the shared VPS
that runs staging today, under the existing name `ims-staging.ancorlabs.org` (a production name
can be added after go-live). When the pilot ends, the staging stack becomes production: a fresh
application database, a Keycloak realm with real people only (P7, P8), the production `.env`
(P9) and the backups of Decision D2 (P5). Staging is retired at go-live; later changes are tested locally until
a separate staging host exists. Reason: the front door, certificate, Cloudflare rules, backup
cron and deploy script are already proven on that box, and a new server does not fit the
2026-10-12 target.

Risk accepted with D1: company IT keeps root and password SSH logins on the box (ruling
2026-09-20), so P6 is not hardened. Anyone holding the root password controls production. The
program director accepts this risk. Before go-live, free disk space on the box: it stood at
80% on 2026-09-23 with a 15 GB WAL archive held by old labelled backups.

Decision D2, backups (program director, 2026-09-23): no pgBackRest for this single-site go-live.
The nightly base backup (seven kept, restore drill passed 2026-09-20) plus the WAL archive
already allow a restore to any point between backups. What was missing is a copy off the box,
which the company QNAP job provides once company IT restores it (P5). Old labelled pilot
backups are removed so the WAL archive can be trimmed.

## Open questions for the program director

1. The dates: is 2026-10-12 realistic for the site? It holds only if the first extract (P2)
   arrives by 2026-09-30.
