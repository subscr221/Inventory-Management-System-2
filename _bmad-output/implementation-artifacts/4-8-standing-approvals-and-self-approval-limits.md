---
baseline_commit: 46579379d781942e06fadf03c7b058849e7bc4cd
---
# Story 4.8: Standing Approvals and Self-Approval Limits

Status: review

Baseline commit: `73d7ea2`

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created from epics.md Story 4.8, `sprint-change-proposal-2026-09-26.md` Sections 4.3 and 4.4, the PRD addendum, the access matrix SOD-01 amendment, the UX run EXPERIENCE.md and memlog rulings (2026-09-25, Q6, Q7), the user rulings of 2026-09-29 on this story's open questions, Stories 1.4, 1.11, 1.15, 4.3, 4.7 and 8.9, and the current code. Re-scoped 2026-09-29 to grants only.

## Story

As a site head or head of department,
I want to grant a named person a standing approval for an item or item group, and a per-person self-approval limit, each effective after a one-time finance sign-off,
so that routine repeat issues stop queuing behind approvers while every grant stays visible, capped, revocable, and audited.

PILOT. Extends Story 4.3's approval rules (FR-P-04). SOD-01 is amended as recorded in the access matrix and the PRD addendum (sprint-change-proposal-2026-09-26 Section 4.4).

## Dependencies

This story is grants only. The four prerequisite stories below were split out by user ruling 2026-09-29 and must be done first; Table 1 lists what each supplies.

Table 1: Prerequisite stories for Story 4.8.

| Story | Key | Supplies to 4.8 |
| --- | --- | --- |
| 1.16 Site Head Role | `1-16-site-head-role` | A real `site_head` role in RBAC, the role pack and DOA resolution |
| 2.10 Item Groups Master | `2-10-item-groups-master` | `item_group` entity and item assignment; grant scope target |
| 4.10 Requisition Line-Level Approval and Mixed Routing | `4-10-requisition-line-level-approval-and-mixed-routing` | Per-line approval route and state; mixed routing inside one requisition; pilot DOA value bands seeded |
| 4.11 Stores Counter Issue Against a Requisition | `4-11-stores-counter-issue-against-a-requisition` | Line-level counter issue, partial issue, stock decrement, slip |

Story 4.9 (no-band fallback) is independent; 4.8 must not change what happens when no DOA band matches.

## Acceptance Criteria

1. **Assign a standing approval.** Given a site head or head of department, when they assign a standing approval, then a grant with id `SA-YYYY-NNN` links one user to one item (SKU) or one item group (Story 2.10), with an optional monthly quantity cap (counted against quantity issued) and an optional end date; the grant is inactive until the finance department head approves it once.
2. **Ride the grant, per line.** Given an active standing approval, when a requisition line falls under it and within its cap, then that line is routed `standing_approval` and goes straight to stores issue (Story 4.11) without a per-transaction approver, and the issue screen and the printed slip both state the grant id it rode on.
3. **Fallback, never reject.** Given an issue that would take the month's issued quantity over the grant's cap, or a requisition line outside the grant's scope, when it is submitted, then that line falls back to the normal DOA approval path (Story 4.10) - never rejected for exceeding the grant, never silently self-approved. Other lines of the same requisition keep their own route.
4. **Self-approval within a limit, per line.** Given a per-person self-approval limit assigned by the site head or head of department and approved once by the finance department head, when the person approves their own requisition line whose value is within that limit, then the self-approval is permitted (SOD-01 as amended) and the line is flagged as self-approved in the audit trail.
5. **Revoke and auto-revoke.** Given an active grant, when the assigner revokes it, then revocation is effective instantly and needs no second approver; and when the grantee's account is disabled, every grant they hold auto-revokes the same day.
6. **Pruning cycle.** Given the pruning cycle (default every 30 days), when it runs, then each assigner receives an in-app and web push list of their live grants, with any grant unused for 90 days flagged for review. Email delivery is deferred by user ruling 2026-09-29 and recorded as a pilot gap in `deferred-work.md`.

## Binding Scope Decisions

Table 2 maps each decision to its source.

- **D1 One grant table, two kinds.** A single `standing_grant` read model with `grant_kind IN ('standing_approval','self_approval_limit')`, sharing the `SA-YYYY-NNN` sequence, the assign, finance-approve, revoke and prune lifecycle, and one `standing_grant` event stream (memlog: limits use "the same assign / finance-head approve / review cycle as item grants").
- **D2 Lifecycle.** Statuses `pending-finance`, `active`, `rejected`, `revoked`, `expired`. Events `standing_grant.assigned`, `standing_grant.finance_approved`, `standing_grant.finance_rejected`, `standing_grant.revoked` (`revoke_reason` in `assigner`, `account_disabled`), `standing_grant.expired`. Only `active` grants take effect. No edit: a change is revoke plus a new grant.
- **D3 Authority through the DOA registry.** New `transaction_type` values `standing_grant_assign` (seeded for `site_head` from Story 1.16 and `department_head`) and `standing_grant_finance` (seeded for `finance_controller`). Assignment checks `isActiveRoleHolderForEntry` at the grant site; finance approval uses `findRoleHolder` plus `findActiveDelegation` (Story 4.3 pattern). No value bands on these types.
- **D4 SoD on grants.** Assigner is not the grantee; finance approver is neither assigner nor grantee. A limit is never self-assigned or self-approved.
- **D5 Scope is SKU or item group.** Exactly one of `scope_sku` or `scope_item_group_id` (FK to Story 2.10's item group). A group grant covers a line when the line's item belongs to that group at raise time. `item_category` is NOT used.
- **D6 Grant check per line at raise.** Story 4.10 gives each line a route. At raise, for each line, if the requester holds an active standing approval at the raise site whose scope covers the line and month-to-date issued plus the line quantity is within the cap, the line route is `standing_approval` with `standing_grant_id`, approved by a system-authored line approval in the same transaction. Uncovered lines take Story 4.10's DOA route. Coverage is decided on the server when the event applies, never from a client-sent grant id (edge offline raise included).
- **D7 Cap counts quantity issued per IST calendar month** (`toIstCalendarDate`, `src/lib/business-days.ts`), summed from Story 4.11 issue records carrying the grant id.
- **D8 Binding check at issue.** In Story 4.11's issue path, for a line routed `standing_approval`: lock the grant row (`FOR UPDATE`), re-check active, end date and cap. On failure refuse the issue with `STANDING_APPROVAL_LAPSED` (409) and, in a separate committed transaction, re-route that line to DOA (Story 4.10 reroute), notifying the resolved approver. Partial issue within the cap is allowed; the remainder falls back.
- **D9 Slip and screen text.** Exactly `Standing approval SA-2026-014 for <display name> (<SKU or item group name>). Storekeeper please issue.` "No approval required" and grade words such as "junior" never appear.
- **D10 Self-approval per line, explicit act.** In the Story 4.10 line-decision seam, the requester may approve (never reject) their own line when they hold an active `self_approval_limit` at the site and the line value is at or below `limit_amount`. The line stores `self_approved = true` and `self_approval_grant_id`; the audit entry carries both. Over the limit, the requester is refused with `INDENT_RAISER_CANNOT_APPROVE` and the DOA approver decides.
- **D11 Online only.** Assign, finance decide and revoke are server routes, not added to the edge outbox or `src/sync/upload.ts` allow list (Q7).
- **D12 Auto-revoke on disable.** `deprovisionUser` (`src/adapters/iam/scim.ts`) revokes every live grant the user holds, system actor, same call. Grants the user assigned stay live and move to the finance approver's pruning list.
- **D13 Pruning sweep.** `src/notify/standing-grant-sweep.ts`, registered in `src/server.ts` beside `runJobworkClockSweepCycle`, own advisory lock key (9506 is taken by `jobwork-billing-sweep.ts`; pick the next unused key after grepping `LOCK_KEY` in `src`), daily tick; per assigner, interval from `standing_grant_prune_setting` (default 30); channels `in_app` and `web_push`; expires past-end-date grants.
- **D14 Out of scope.** Line-level approval model, mixed routing, value-band seeding (4.10); counter issue mechanics (4.11); role provisioning (1.16); item group master (2.10); no-band fallback (4.9); edge UI screens; email channel.

Table 2: Source of each binding scope decision.

| Decision | Source |
| --- | --- |
| D1, D2 | memlog 2026-09-25; EXPERIENCE.md Requisitions and Standing Approvals |
| D3, D4 | access matrix SOD-01 row and amendment; user ruling 2026-09-29 (site head); `src/api/v1/indents.ts` `resolveApprover` |
| D5 | user ruling 2026-09-29 (item groups, not item_category) |
| D6, D7, D8 | epics.md Story 4.8 AC 2, AC 3; user rulings 2026-09-29 (line level, mixed routing, partial issue) |
| D9 | memlog slip-text ruling; EXPERIENCE.md voice table lines 59-60 |
| D10 | sprint-change-proposal Section 4.4; user ruling 2026-09-29 (line level) |
| D11 | memlog Q7; EXPERIENCE.md line 100 |
| D12 | `src/adapters/iam/scim.ts` line 185 |
| D13 | memlog pruning ruling; user ruling 2026-09-29 (email deferred) |
| D14 | user scope ruling 2026-09-29 |

## Tasks / Subtasks

- [x] **Task 1: Schema and read models (AC 1, 4, 5, 6)**
  - [x] 1.1 New `read/projections/standing_grant.sql`: `standing_grant` (`grant_id`, `grant_ref` unique `SA-YYYY-NNN`, `grant_kind`, `grantee_user_id`, `assigner_user_id`, `site_id`, `scope_sku`, `scope_item_group_id`, `monthly_qty_cap NUMERIC(18,3)`, `limit_amount NUMERIC(18,4)`, `end_date DATE`, `status`, `finance_approver_user_id`, `finance_decided_at`, `revoked_at`, `revoke_reason`, timestamps). CHECKs: kind and status vocabularies; a standing approval has exactly one scope and no limit; a limit has `limit_amount > 0` and no scope or cap; cap `> 0` when set; grantee differs from assigner. Partial index `(grantee_user_id, grant_kind, site_id) WHERE status = 'active'`. Sequence `standing_grant_ref_seq` (the `indent_number_seq` idiom). Guarded DO blocks, idempotent grants to `app_user`.
  - [x] 1.2 `standing_grant_prune_setting` (`assigner_user_id` PK, `prune_interval_days INT DEFAULT 30 CHECK (>= 1)`, `last_prune_sent_at`).
  - [x] 1.3 Add nullable `standing_grant_id`, `self_approved BOOLEAN DEFAULT false`, `self_approval_grant_id` to the Story 4.10 line table, and `standing_grant_id` to the Story 4.11 issue table, with guarded `ADD COLUMN IF NOT EXISTS` (skip any column a prerequisite already added).
  - [x] 1.4 Mirror all DDL in `deploy/compose/init-db.sql`, register files in `src/events/migrate.ts`, update `test/unit/schema-drift.test.ts`.
  - [x] 1.5 New `src/read/projections/standing_grant.ts`: `insertGrant`, `getGrantForUpdate`, `setGrantStatus`, `findCoveringStandingApproval(userId, siteId, sku, itemGroupId, onDate)`, `findActiveSelfApprovalLimit(userId, siteId, onDate)`, `monthToDateIssued(grantId, istMonth)`, `listLiveGrantsByAssigner`, `lastIssueAt`, `listLiveGrantsHeldBy`.

- [x] **Task 2: Events and lifecycle seam (AC 1, 5)**
  - [x] 2.1 `src/events/schema.ts`: five `standing_grant.*` types on a new `standing_grant` stream; optional grant fields on the Story 4.10 line-approval payload.
  - [x] 2.2 New `src/compliance/standing-grant.ts`: shape checks and appliers inside `persistEvent`; guards D3 and D4; grantee active; end date not past; scope SKU exists or item group active (Story 2.10); only `pending-finance` is finance-decided; only the assigner or the system actor revokes; revoke of a non-live grant is 409 `GRANT_NOT_LIVE`. Transactional notifications via `emitNotificationInTransaction`.
  - [x] 2.3 Stable error codes: `GRANT_ASSIGNER_NOT_AUTHORIZED`, `GRANT_SELF_ASSIGNMENT`, `GRANT_FINANCE_NOT_RESOLVED`, `GRANT_NOT_PENDING`, `GRANT_NOT_LIVE`, `GRANT_SCOPE_INVALID`, `STANDING_APPROVAL_LAPSED`.
  - [x] 2.4 Seed `standing_grant_assign` (`site_head`, `department_head`) and `standing_grant_finance` (`finance_controller`) in `docs/migration/pilot-mock-extract/world.json` and `deploy/provision/staging-doa-bands.sh`.

- [x] **Task 3: Grant API (AC 1, 5)**
  - [x] 3.1 New `src/api/v1/standing-grants.ts`, registered in `src/server.ts`: `POST /api/v1/standing-grants`, `POST /:id/finance-approve`, `POST /:id/finance-reject` (reason required), `POST /:id/revoke`, `GET /api/v1/standing-grants?assigned_by=me|held_by=me|pending_finance=me`, `GET /:id` (with month-to-date usage and cap), `PUT /api/v1/standing-grants/prune-setting`. `held_by=me` is readable from the `employee` base role.
  - [x] 3.2 No response contains "No approval required" or "junior" (test asserts it).

- [x] **Task 4: Per-line grant routing at raise (AC 2, 3)**
  - [x] 4.1 Hook D6 into Story 4.10's per-line route resolution, before DOA resolution for each line; server-side only.
  - [x] 4.2 Line reads expose `approval_route`, `standing_grant_ref`, `cap`, `month_to_date_issued` (chip copy such as "4 of 6 cans used this month").

- [x] **Task 5: Issue-time cap check and slip (AC 2, 3)**
  - [x] 5.1 Hook D8 into Story 4.11's issue applier; write `standing_grant_id` on the issue record.
  - [x] 5.2 Slip and issue response carry `standing_approval_text` per D9 when the line rode a grant.

- [x] **Task 6: Self-approval per line (AC 4)**
  - [x] 6.1 D10 branch in the Story 4.10 line-decision seam; every other requester case keeps `INDENT_RAISER_CANNOT_APPROVE`; `NOT_RESOLVED_APPROVER` paths untouched.
  - [x] 6.2 Line and audit entry record `self_approved` and `self_approval_grant_id`.
  - [x] 6.3 `GET /api/v1/indents?mine=true` shows line value only to a caller holding a live limit (EXPERIENCE.md); Story 1.15's no-number rule holds for everyone else.

- [x] **Task 7: Auto-revoke and pruning (AC 5, 6)**
  - [x] 7.1 `deprovisionUser`: after `user.deprovisioned`, revoke each live held grant (`account_disabled`, system actor); the already-inactive branch sweeps idempotently.
  - [x] 7.2 `src/notify/standing-grant-sweep.ts` per D13; payload per grant: `grant_ref`, grantee, scope label, cap, last-period issued qty, `last_used_at`, `consider_revoking`.

- [x] **Task 8: Docs and rehearsal (all ACs)**
  - [x] 8.1 Access matrix: section 8 rows for the two DOA types; `standing_grant` capability row. Do not re-edit the SOD-01 amendment.
  - [x] 8.2 `docs/migration/pilot-cutover-runbook.md`: staging row (seed, assign, finance approve, mixed requisition raise, issue, slip text, revoke, disable account).
  - [x] 8.3 `deploy/rehearsal/mock/operations-smoke.ts`: flow `standingApproval`.

- [x] **Task 9: Tests (all ACs)**
  - [x] 9.1 New `test/integration/story-4-8.test.ts`, one `describe` per AC (Testing Requirements).
  - [x] 9.2 Rerun `story-4-3`, `story-1-4`, `story-1-15`, `story-8-9`, the 1.16, 2.10, 4.10, 4.11 suites, and `schema-drift`.
  - [x] 9.3 Run `graphify update .`.

## Dev Notes

### Existing Components to Reuse

- DOA: `resolveApprover` in `src/api/v1/indents.ts`; `findRoleHolder` (picks the oldest holder), `isActiveRoleHolderForEntry`, `findActiveDelegation` in `src/read/projections/doa_registry.ts`.
- Events and audit: `persistEvent` in `src/events/store.ts`.
- Notifications: `emitNotificationInTransaction` in `src/notify/emit.ts`; channel check allows `in_app`, `web_push` only.
- Sweep: `src/notify/jobwork-clock-sweep.ts` (SYSTEM_ACTOR, advisory lock) and its registration near `src/server.ts` line 1516.
- IST: `toIstCalendarDate` in `src/lib/business-days.ts`.

### Current Update Files and Preservation Rules

Table 3 lists existing files this story changes. Seams created by Stories 4.10 and 4.11 are extended, not replaced; re-read them after those stories land.

Table 3: Files updated by Story 4.8.

| File | Change | Preserve |
| --- | --- | --- |
| `src/compliance/indent.ts` (and the 4.10 line-decision seam) | D6 routing hook, D10 self-approval branch | `INDENT_RAISER_CANNOT_APPROVE`, `NOT_RESOLVED_APPROVER` paths; Story 4.9 fallback |
| Story 4.11 issue applier | D8 cap check, slip text | Partial-issue and ledger rules of 4.11 |
| `src/events/schema.ts` | New stream and types; optional fields | Existing payloads stay valid |
| `src/adapters/iam/scim.ts` | Revoke held grants | Idempotent no-op branch still edit-logs |
| `src/server.ts` | Routes and sweep | Registration order |
| `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts` | Mirror DDL, expectations | Parity |

### Prior-Story Intelligence

- Story 4.3: approval guards live in the seam so `/api/v1/events` and edge upload cannot bypass them.
- Story 1.15: `requireRole` any-of grouping fix at `src/middleware/rbac.ts:206-212`; `mine=true` drops the site filter; quantities hidden from the base role.
- Story 8.9: replacement requisitions are ordinary requisitions and ride grants through D6 (closes `deferred-work.md` line 1202).
- Conventions (4.7, 8.9): canonical DDL in `read/projections/*.sql` mirrored in `init-db.sql`, one integration file per story, upper-snake error codes, IST pinning.
- Local tests: `ims-postgres-test` (postgres:18.4, port 5442) from `init-db.sql`; `--test-concurrency=1` for multi-file runs; autocrlf can make prettier and drift look red.

### Architecture and Security Compliance

- Event-sourced state through `persistEvent`; rebuildable read models (AD-17).
- SOD-01 amended only for requisition-line self-approval within a finance-approved limit; grant decisions keep the blanket rule.
- Grants are site-scoped.

### Testing Requirements

- AC 1: non-authority assign 403 `GRANT_ASSIGNER_NOT_AUTHORIZED`; `site_head` and `department_head` may assign; self-assign refused; ref matches `^SA-\d{4}-\d{3}$`; pending grant has no effect; finance approver equal to assigner refused; inactive item group refused.
- AC 2: covered line routed `standing_approval` with no approver; exact slip text at issue; usage updates.
- AC 3: mixed requisition: covered line to stores, uncovered line to DOA, no split; over-cap issue 409 `STANDING_APPROVAL_LAPSED`, line re-routed, never rejected; cap exactly reached allowed; partial issue within cap then fallback; expired or revoked grant falls back.
- AC 4: own line within limit approved with `self_approved` in line and audit; one rupee over refused; pending limit gives no right; self-reject refused; edge upload follows the same rule.
- AC 5: instant assigner revoke; non-assigner revoke refused; SCIM `active: false` revokes held grants in the same request.
- AC 6: fake-clock sweep: one notification per due assigner on `in_app` and `web_push`, custom interval honoured, 90-day flag, no resend inside interval, end-date expiry.

### Project Structure Notes

- New: `read/projections/standing_grant.sql`, `src/read/projections/standing_grant.ts`, `src/compliance/standing-grant.ts`, `src/api/v1/standing-grants.ts`, `src/notify/standing-grant-sweep.ts`, `test/integration/story-4-8.test.ts`. No new npm dependency.

### Rulings on Former Open Questions

All seven open questions were ruled by the user on 2026-09-29; Table 4 records them.

Table 4: User rulings 2026-09-29.

| No. | Question | Ruling |
| --- | --- | --- |
| 1 | No stores issue flow | Build it as Story 4.11 (line-level, partial issue) |
| 2 | No email channel | Deferred; in_app and web_push only; pilot gap in `deferred-work.md` |
| 3 | No site head role | Real `site_head` role, Story 1.16 |
| 4 | No item group master | Item Groups master, Story 2.10; grant scope is SKU or item group |
| 5 | Line versus requisition approval | Line-level approval, Story 4.10 |
| 6 | Mixed requisitions | Route each line inside one requisition; no document split; partial issue allowed (4.10, 4.11) |
| 7 | Pilot value bands unseeded | Confirm and seed in Story 4.10 (explicit AC); coordinate with 4.9 |

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 4.8, #Story 4.9, #Story 4.10, #Story 4.11, #Story 1.16, #Story 2.10]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-09-26.md#4.4 SOD-01 amendment (proposed wording)]
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md lines 53-55]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md lines 287, 299]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md lines 59-60, 100, 105, 155-165]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/.memlog.md standing-approval rulings, Q6, Q7]
- [Source: src/compliance/indent.ts lines 567-652; src/api/v1/indents.ts lines 70-109; src/adapters/iam/scim.ts line 185]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md, section "Deferred from: user rulings on Story 4.8 open questions (2026-09-29)"]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5.5 (claude-sonnet-5-5), bmad-dev-story, 2026-10-21. Baseline `4657937`.

### Debug Log References

- The first run of `story-4-10` after the seam change failed one test: the Story 4.10 "pre-routed line" test posted a `standing_approval` route with no grant. That is the intended new refusal (the seam only accepts a line that names an active grant of the requester covering it), so the fixture now inserts a real grant and passes `standing_grant_id`.
- The first `story-4-8` run failed four assertions that were wrong, not the code: a procurement reader of the site may read a grant (the stranger test now uses a reader of another site), the door RBAC answers `MODULE_ACCESS_DENIED` before the stream guard for a non-wildcard caller (both doors are asserted as "refused, nothing persisted"), `SUM()` of nothing printed `0` not `0.000` (the SQL now casts to `numeric(18,3)`), and the pruning fake clock started before the first issue.
- `schema.ts`, `store.ts`, `scim.ts` and `config/index.ts` are CRLF in the working tree while most other files are LF; the patch helper keeps each file's own ending.

### Completion Notes List

- Task 1: `read/projections/standing_grant.sql` (`standing_grant` with the D1 shape and CHECKs inline, `fk_standing_grant_item_group` as a guarded block, the partial index of 1.1, `standing_grant_ref_seq`, `standing_grant_prune_setting`); `indent_line` gained `standing_grant_id`, `self_approved`, `self_approval_grant_id`; `indent_issue_line.standing_grant_id` already existed from 4.11 (an index on it was added for the month-to-date sum); DDL mirrored in `init-db.sql`, registered in `migrate.ts`, `schema-drift` extended. Projection `src/read/projections/standing_grant.ts`. Deviation: `findCoveringStandingApprovals` returns a list (most specific first) so the caller can fall through when the first grant has no cap room.
- Task 2: five `standing_grant.*` events on a new `standing_grant` stream; the seam `src/compliance/standing-grant.ts` holds every guard (D3 authority through the DOA registry as membership of the governing role at the site, so the oldest-holder ordering of `findRoleHolder` cannot lock out a newer holder; finance also accepts the active delegate of the role holder; D4 separation). Error codes of 2.3 plus `GRANT_NOT_FOUND`, `GRANT_GRANTEE_INVALID`, `GRANT_END_DATE_PASSED`. An assignment is refused 409 `GRANT_FINANCE_NOT_RESOLVED` when no finance entry exists, so no grant waits for nobody. Seeded in `world.json`, `generate.mjs` and `staging-doa-bands.sh`.
- Task 3: `src/api/v1/standing-grants.ts` with the seven routes of 3.1 (a grant may also name its group by `scope_item_group_code`). Gate is the base `employee` hat or `procurement`; authority is the seam's. Routes are online only: the events door and the edge door refuse the stream.
- Task 4: `routeIndentLines` takes a grant context and routes a covered line within its cap `standing_approval` (cap = month-to-date issued plus quantity already routed in the same requisition plus the line, exact thousandths, IST month). The HTTP raise and the edge door set the route and grant id on the server; the events door strips client-sent route and grant fields; the seam additionally refuses a `standing_approval` line that does not name an active covering grant of the requester (409 `STANDING_APPROVAL_LAPSED`). A grant-approved line writes an `indent.line_standing_approved` audit entry and tells the stores role once (closes the Story 4.10 deferral). Line reads carry `standing_grant_ref`, `cap`, `month_to_date_issued`, `standing_approval_text`.
- Task 5: `applyIndentIssued` locks each grant row in id order and re-checks active, end date and cap before any write; a lapse refuses the whole issue 409 `STANDING_APPROVAL_LAPSED` naming each lapsed line, and the issue route re-routes those lines to DOA in a separate committed transaction (`src/compliance/standing-reroute.ts`: audit entry `indent.line_rerouted`, notification to the resolved approver, header re-derived). A line part-issued under the grant keeps what left the store. The slip basis and `standing_approval_texts` carry the D9 sentence; the stores issue page shows it under a covered line.
- Task 6: the D10 branch is in the line-decision seam (approve only, within the limit, equal allowed, one rupee over refused); the line stores `self_approved`, `self_approval_grant_id` and route `self_approval`, and the audit entry carries both. `GET /api/v1/indents?mine=true` withholds `estimated_value` unless the caller holds a live limit.
- Task 7: `deprovisionUser` revokes every live grant the person holds as the system, in the same call, and again from the already-inactive branch; grants they assigned stay live and their pruning list goes to the finance approver. `src/notify/standing-grant-sweep.ts` (lock key 9507, daily `standing grant pruning` cycle, `STANDING_GRANT_SWEEP_INTERVAL_MS`, `STANDING_GRANT_SWEEP_BATCH_SIZE`, `STANDING_GRANT_UNUSED_FLAG_DAYS`) expires grants past their end date and sends one `standing_grant_review` notification per due recipient with grant, grantee, scope, cap, last-period issued quantity, last use and "consider revoking" after 90 unused days. Web push follows the platform opt-in rule; email stays a recorded pilot gap.
- Task 8: access matrix section 3.12 and the two section 8 rows (SOD-01 amendment not re-edited), runbook row 2.10l and the 2.9a band count, and the smoke flow `standingApproval` (typechecks; not run against a stack in this session).
- Task 9: `test/integration/story-4-8.test.ts` (33 tests, one `describe` per AC plus the voice scan), `test/unit/story-4-8-helpers.test.ts` (4), drift entries; `story-4-10` fixture updated. Full server suite 2666 of 2666 (the first full run had two stale registry pins, the route surface in story-1-9 and the cycle list in background-cycles, both updated and rerun green); `eslint src test` clean; edge unit 140 of 140.
- Decisions taken where the story left room: a pending grant is revocable by its assigner (live = pending or active); expiry and revocation are system or assigner only; the finance approver of a grant at a site is any holder of the finance role at the site or at every location, or the active delegate of the role's resolved holder; a standing approval and a limit may coexist for the same person.
- Not done, by scope: edge screens for the grant lifecycle (D14) and header terminal handling (Story 4.11 deferral, not in these tasks). Recorded in `deferred-work.md` under "Deferred from: dev of story-4-8".

### File List

New:
- `read/projections/standing_grant.sql`
- `src/read/projections/standing_grant.ts`
- `src/compliance/standing-grant.ts`
- `src/compliance/standing-reroute.ts`
- `src/api/v1/standing-grants.ts`
- `src/notify/standing-grant-sweep.ts`
- `src/lib/milli.ts`
- `test/integration/story-4-8.test.ts`
- `test/unit/story-4-8-helpers.test.ts`

Changed:
- `read/projections/indent_line.sql`, `read/projections/indent_issue.sql`, `deploy/compose/init-db.sql`
- `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`
- `src/compliance/indent.ts`, `src/compliance/indent-routing.ts`, `src/compliance/indent-issue.ts`
- `src/read/projections/indent.ts`
- `src/api/v1/indents.ts`, `src/api/v1/events.ts`, `src/api/v1/edge.ts`
- `src/adapters/iam/scim.ts`, `src/config/index.ts`, `src/server.ts`
- `edge/src/components/stores-issue.tsx`, `edge/src/components/stores-issue-model.ts`
- `test/unit/schema-drift.test.ts`, `test/integration/story-4-10.test.ts`
- `deploy/provision/staging-doa-bands.sh`, `deploy/rehearsal/mock/generate.mjs`, `deploy/rehearsal/mock/operations-smoke.ts`
- `docs/migration/pilot-mock-extract/world.json`, `docs/migration/pilot-cutover-runbook.md`
- `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`, `sprint-status.yaml`, this story file

### Change Log

- 2026-10-21: Implemented Story 4.8 (grants, per-line routing and issue-time cap check, self-approval within a limit, revoke and auto-revoke, pruning sweep, docs, smoke flow, tests). Status review.
