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
| P0 | Decide the production host: a separate server, or the shared VPS that runs staging. A separate server is recommended; the shared box's root and password logins stay on for company IT (ruling 2026-09-20), which conflicts with P6 | Program director, company IT | 2026-09-25 | written decision | |
| P1 | Site data request: confirm `site-data-request-cmf-aligarh.md` was sent, to whom and when; agree the first-draft date | Program director | 2026-09-25 | sent date and recipient recorded here | |
| P2 | First-draft extract received (five CSV files) | Site head | 2026-09-30 | files received | |
| P3 | Rehearsal on staging with the real first draft: runbook sections 4 to 7, fill Tables 3, 3a and 3b | Migration lead | 2026-10-03 | Tables 3, 3a, 3b filled | |
| P4 | Kit BOMs: the site head lists every open job-work service order; the BOM engineer creates a kit BOM for each and attaches it (without one, a challan receipt is refused `JOBWORK_ORDER_KIT_BOM_REQUIRED` in production) | Site head (list), BOM engineer (BOMs) | 2026-10-05 | query in note 1 returns 0 on the rehearsal database | |
| P5 | pgBackRest: install pgBackRest inside the postgres image, switch `archive_command` to `pgbackrest --stanza=main archive-push %p`, generate the cipher passphrase into `/root/ims-pgbackrest-cipher.txt` with a second copy off the box, use the corrected `deploy/backup/pgbackrest.conf` (fixed 2026-09-23), run `stanza-create`, `check`, one full backup, and a restore drill into a throwaway container | Operator | 2026-10-06 | `pgbackrest info` with one full backup; restore drill row counts equal live | |
| P6 | SSH: named operator account with key login, then `PermitRootLogin prohibit-password` and `PasswordAuthentication no`, only after the operator account has signed in once in a second session | Operator, company IT | 2026-10-06 | `sshd -T` output | |
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

## Open questions for the program director

1. P0: which host. Most of P5 and P6 depend on it.
2. P1: was the data request sent, and to whom?
3. The dates: is 2026-10-12 realistic for the site?
