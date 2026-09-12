# Pilot Cutover Runbook

Status: DRAFT 2026-09-12, for review by the program director, the migration lead, the
department head and the finance controller before the first pilot rehearsal.

Scope: one pilot site, the Phase 1 wave (Epics 1 to 13, the 66 stories tagged PILOT in
`sprint-status.yaml`). The wave's data scope is the five migration domains that Story 13.3's
go-live gate covers: `opening_stock`, `active_boms`, `open_pos`, `jobwork_challans`,
`custody_registers`.

Sources: `deploy/pipeline/deploy.sh`, `deploy/provision/provision.sh`, `deploy/backup/backup.sh`,
`src/events/migrate.ts`, `src/cli/verify-segregated-roles.ts`, the Story 13.1 to 13.3 story
files, and `docs/migration/opening-stock-template-v1.md` and
`docs/migration/document-manifest-templates-v1.md` for the file formats.

## 1. Roles and people

The cutover needs the people in Table 1 provisioned through SCIM before any migration file is
loaded. The system enforces every separation in the table; a violation is refused at request
time and again inside the event transaction, so a missing or doubled-up holder stops the
cutover, it does not merely warn.

Table 1: Cutover roles

| Role | Module and scope | Who must NOT also hold it | Enforced by |
| --- | --- | --- | --- |
| `migration_lead` | `migration`, write, pilot site | `department_head`, `finance_controller` for the site | SOD-07, Story 13.2 and 13.3 sign-off legs |
| `department_head` | `migration`, write, pilot site | `migration_lead`; anyone who loaded, promoted or ran a verification for the site; the `finance_final` signer | Story 13.3 `assertGoLiveSignoffAllowed` |
| `finance_controller` | `migration`, write, pilot site or `*` | `migration_lead`; any loader, promoter or verification runner; the `department_head_final` signer; the `cfo` | Story 13.3 sign-off legs; Story 9.7 ruling |
| `cfo` | per Story 9.7 and 9.9 | `finance_controller` | Story 9.7 ruling (two real people) |
| Variance approver (DOA) | resolved by `doa_registry_entries` for `migration.variance_explanation` | the explainer (`EXPLAINER_CANNOT_APPROVE`) | Story 13.1 approval route |
| Domain sign-off authority | per-domain module, write (Story 13.2) | the run's loader and runner | Story 13.2 `assertDomainSignoffAllowed` |

Minimum head count: four distinct real people (lead, department head, finance controller,
CFO), plus a DOA approver who is not the person explaining variances.

Verification, run against the target database after provisioning:

```bash
npm run verify:roles
```

The command lists every registered segregated pair and the holders on each side; a pair with the
same person on both sides fails the run.

## 2. Environment readiness

Complete Table 2 in order. Each row is a hard stop until green.

Table 2: Environment checklist

| Step | Action | Evidence |
| --- | --- | --- |
| 2.1 | Provision the host with `deploy/provision/provision.sh` (Docker Compose v2 plugin required) | script exit 0 |
| 2.2 | Deploy the immutable images with `deploy/pipeline/deploy.sh staging`, then `production` with the same `IMAGE_TAG` | health check at `HEALTH_URL` returns 200 |
| 2.3 | Run `npm run db:migrate` against the target; confirm it is re-runnable (second run, no error) | migrate log, two clean runs |
| 2.4 | Confirm the backup job (`deploy/backup/backup.sh`, pgBackRest) has produced one full backup and one WAL archive segment | backup listing |
| 2.5 | Run `deploy/pipeline/verify.sh` (read-only) against the repository | exit 0 |
| 2.6 | Confirm `AUTH_MODE`, `AUTH_JWKS_URI`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `SCIM_BEARER_TOKEN` are the production identity provider's values, not the dev-token values | `.env` review, two people |
| 2.7 | Confirm `ERP_SYNC_FRESHNESS_MS` and the ERP sync schedule; record the sync window | schedule document |
| 2.8 | Record the 20,000-row opening-stock promotion timing on staging (deferred-work item 800) | figure written into deferred-work |

Step 2.8 is still owed as of this draft: only a 10,000-row local run exists. Do not proceed to
section 4 on production without it.

## 3. Rehearsal on staging

Run sections 4 to 7 end to end on staging with a full copy of the pilot site's extract at least
once. Record the wall-clock time of each step in Table 3 during the rehearsal; the production
window in section 8 is planned from those figures.

Table 3: Rehearsal timing

| Step | Rehearsal start | Rehearsal end | Notes |
| --- | --- | --- | --- |
| Opening-stock load | | | |
| Variance explanation and approval | | | |
| Promotion | | | |
| Document loads and verification runs (four domains) | | | |
| Domain sign-offs | | | |
| Final ERP extract and sync | | | |
| Final sign-offs and unblock | | | |

## 4. Opening stock (Story 13.1)

1. Freeze physical movements at the site. The counted quantities in the file must describe a
   stock position that does not change until promotion.
2. Load the counted stock file through `POST /api/v1/migration/opening-stock/imports` as the
   `migration_lead`. Format per `docs/migration/opening-stock-template-v1.md`. Rejections are
   returned per row; fix the source and reload (a later load supersedes the earlier rows).
3. Pull the ERP balance snapshot for the site (the Story 2.9 sync). Note the `snapshot_at` it
   carries; it matters in section 7.
4. Read `GET /api/v1/migration/opening-stock/variances`. Every variance must end in status
   `explained`: the lead posts an explanation through
   `POST /api/v1/migration/opening-stock/variances/explanations`, the DOA-resolved approver
   approves it through the `/approve` route. `pending_approval`, `stale` and `open` all block.
5. Promote through `POST /api/v1/migration/opening-stock/promote`. The stage moves to `dry_run`
   and the rows post to the live ledger. Promotion refuses on any unexplained variance.

## 5. Active documents (Story 13.2)

For each of `active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`:

1. Load the manifest through `POST /api/v1/migration/documents/imports` (format per
   `docs/migration/document-manifest-templates-v1.md`).
2. Run verification. Findings of kind `missing_in_platform`, `missing_in_source`,
   `field_mismatch`, `state_mismatch` and `unknown_reference` appear on the run.
3. Resolve every open finding: fix the source and rerun, or waive with a narrative. A
   platform-only orphan that cannot be waived is registered through
   `POST /api/v1/migration/domains/:domain/platform-exclusions`.
4. The domain's sign-off authority signs off the latest run of the latest load through
   `POST /api/v1/migration/domains/:domain/sign-off`. `GET /api/v1/migration/domains` shows
   `verified` only when the signed-off run is the latest run of the latest load; a later load or
   run makes the domain `unverified` again and step 4 repeats.

Order of loads matters for section 7: every document load is a `migration_import` row, and the
final sign-offs must postdate all of them.

## 6. Reconciliation report (Story 13.3 AC 1)

`GET /api/v1/migration/golive/reconciliation?site_id=` is the one page the sign-off authorities
read. Before asking for a signature, confirm on it:

- `domains[opening_stock].unexplained_count` is 0 and `stage` is `dry_run`.
- Every document domain shows `status: verified`.
- `remaining_discrepancies` contains no entry with `blocks_golive: true`. Entries with
  `blocks_golive: false` (`quarantined_documents`, `open_findings` on a superseded run) are
  informational and must be acknowledged in the sign-off minutes.
- `gate.blocking` is `APPROVAL_REQUIRED` naming both sign-offs and nothing else. Any other code
  means a section 4 or 5 step is incomplete.

## 7. Final sign-offs and unblock (Story 13.3 AC 2 to AC 4)

The order below is mandatory because of the stale-attestation rule: a sign-off that predates the
site's latest migration load or the latest ERP `snapshot_at` is refused as `SIGNOFF_STALE` at
unblock time and must be given again.

1. Run the final ERP extract and sync. Confirm on the reconciliation report that
   `data_activity.latest_snapshot_at` shows the new snapshot and `unexplained_count` is still 0.
2. Stop the ERP sync schedule for the site until the unblock is recorded. A nightly sync that
   advances `snapshot_at` after the signatures invalidates them.
3. Confirm no further migration load will be made. If one is needed, make it now and return to
   step 1.
4. The department head records `department_head_final` through
   `POST /api/v1/migration/golive/sign-offs` (`signoff_type: department_head_final`).
5. The finance controller records `finance_final` through the same route. A different person
   from step 4; the same person is refused `SIGNOFF_ACTOR_CONFLICT`.
6. Read the report once more: `gate.satisfied` must be `true`, both `signoffs[*].stale` false.
7. The migration lead records the unblock through `POST /api/v1/migration/golive/unblock`. The
   response carries the `migration.golive.unblocked` event id; the `migration_golive_status`
   row is the durable record for the auditors.
8. Re-enable the ERP sync schedule.

Refusal codes at step 7 and their remedies are in Table 4.

Table 4: Unblock refusals

| Code | Meaning | Remedy |
| --- | --- | --- |
| `APPROVAL_REQUIRED` | One or both final sign-offs missing | Steps 4 and 5 |
| `SIGNOFF_STALE` | A sign-off predates the latest load or snapshot | Steps 1 to 5 again; the stale sign-off is re-attested, the earlier row stays on record |
| `VARIANCE_UNRESOLVED` | An opening-stock variance is not `explained` | Section 4 step 4, then steps 1 to 5 again |
| `PROMOTION_REQUIRED` | Opening stock not promoted | Section 4 step 5 |
| `DOMAIN_UNVERIFIED` | A document domain is not `verified` | Section 5 step 4 for the named domains |
| `INVALID_STATE` (`already_unblocked`) | The site is already live | Nothing; the existing event is returned on the route |

## 8. Production window plan

Fill Table 5 from the rehearsal figures in Table 3. The window opens at the physical stock
freeze and closes at the unblock; transactional use of the site starts only after the unblock.

Table 5: Production window

| Milestone | Planned time | Owner | Done |
| --- | --- | --- | --- |
| Physical movement freeze | | site head | |
| Opening-stock load and variance closure | | migration lead, DOA approver | |
| Promotion | | migration lead | |
| Document loads, verification, domain sign-offs | | migration lead, domain authorities | |
| Final ERP extract; sync paused | | ERP owner | |
| Final sign-offs | | department head, finance controller | |
| Unblock; sync resumed | | migration lead | |
| First live transaction | | site head | |

## 9. Rollback

There is no delete path on any migration record: sign-offs, unblocks and promoted rows are
append-only by design (app_user holds no UPDATE or DELETE). Rollback is therefore a database
restore, not a data correction:

1. Before the physical freeze, take a named pgBackRest backup and record its label.
2. If the cutover is abandoned after promotion, restore the database to that label with
   `deploy/backup/backup.sh` and redeploy the same `IMAGE_TAG`.
3. If the cutover is abandoned before promotion, no restore is needed: staged rows and
   explanations are inert until promotion, and a fresh load supersedes them.
4. After an unblock, rollback is a management decision recorded in the audit log; the
   `migration_golive_status` row is not removed.

## 10. Open items before the first rehearsal

- Deferred-work item 800: the 20,000-row promotion timing on staging (Table 2 step 2.8).
- A pilot-blocking triage of `deferred-work.md` (493 rows as of this draft) by the program
  director; anything ruled blocking is added to Table 2.
- The ERP sync schedule owner and the mechanism to pause it for section 7 step 2.
- Names against every role in Table 1 and every owner in Table 5.
