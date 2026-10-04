# Story 4.8: Standing Approvals and Self-Approval Limits

Status: ready-for-dev

Blocked: do not start until Stories 1.16, 2.10, 4.10 and 4.11 are done (see Dependencies).

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

- [ ] **Task 1: Schema and read models (AC 1, 4, 5, 6)**
  - [ ] 1.1 New `read/projections/standing_grant.sql`: `standing_grant` (`grant_id`, `grant_ref` unique `SA-YYYY-NNN`, `grant_kind`, `grantee_user_id`, `assigner_user_id`, `site_id`, `scope_sku`, `scope_item_group_id`, `monthly_qty_cap NUMERIC(18,3)`, `limit_amount NUMERIC(18,4)`, `end_date DATE`, `status`, `finance_approver_user_id`, `finance_decided_at`, `revoked_at`, `revoke_reason`, timestamps). CHECKs: kind and status vocabularies; a standing approval has exactly one scope and no limit; a limit has `limit_amount > 0` and no scope or cap; cap `> 0` when set; grantee differs from assigner. Partial index `(grantee_user_id, grant_kind, site_id) WHERE status = 'active'`. Sequence `standing_grant_ref_seq` (the `indent_number_seq` idiom). Guarded DO blocks, idempotent grants to `app_user`.
  - [ ] 1.2 `standing_grant_prune_setting` (`assigner_user_id` PK, `prune_interval_days INT DEFAULT 30 CHECK (>= 1)`, `last_prune_sent_at`).
  - [ ] 1.3 Add nullable `standing_grant_id`, `self_approved BOOLEAN DEFAULT false`, `self_approval_grant_id` to the Story 4.10 line table, and `standing_grant_id` to the Story 4.11 issue table, with guarded `ADD COLUMN IF NOT EXISTS` (skip any column a prerequisite already added).
  - [ ] 1.4 Mirror all DDL in `deploy/compose/init-db.sql`, register files in `src/events/migrate.ts`, update `test/unit/schema-drift.test.ts`.
  - [ ] 1.5 New `src/read/projections/standing_grant.ts`: `insertGrant`, `getGrantForUpdate`, `setGrantStatus`, `findCoveringStandingApproval(userId, siteId, sku, itemGroupId, onDate)`, `findActiveSelfApprovalLimit(userId, siteId, onDate)`, `monthToDateIssued(grantId, istMonth)`, `listLiveGrantsByAssigner`, `lastIssueAt`, `listLiveGrantsHeldBy`.

- [ ] **Task 2: Events and lifecycle seam (AC 1, 5)**
  - [ ] 2.1 `src/events/schema.ts`: five `standing_grant.*` types on a new `standing_grant` stream; optional grant fields on the Story 4.10 line-approval payload.
  - [ ] 2.2 New `src/compliance/standing-grant.ts`: shape checks and appliers inside `persistEvent`; guards D3 and D4; grantee active; end date not past; scope SKU exists or item group active (Story 2.10); only `pending-finance` is finance-decided; only the assigner or the system actor revokes; revoke of a non-live grant is 409 `GRANT_NOT_LIVE`. Transactional notifications via `emitNotificationInTransaction`.
  - [ ] 2.3 Stable error codes: `GRANT_ASSIGNER_NOT_AUTHORIZED`, `GRANT_SELF_ASSIGNMENT`, `GRANT_FINANCE_NOT_RESOLVED`, `GRANT_NOT_PENDING`, `GRANT_NOT_LIVE`, `GRANT_SCOPE_INVALID`, `STANDING_APPROVAL_LAPSED`.
  - [ ] 2.4 Seed `standing_grant_assign` (`site_head`, `department_head`) and `standing_grant_finance` (`finance_controller`) in `docs/migration/pilot-mock-extract/world.json` and `deploy/provision/staging-doa-bands.sh`.

- [ ] **Task 3: Grant API (AC 1, 5)**
  - [ ] 3.1 New `src/api/v1/standing-grants.ts`, registered in `src/server.ts`: `POST /api/v1/standing-grants`, `POST /:id/finance-approve`, `POST /:id/finance-reject` (reason required), `POST /:id/revoke`, `GET /api/v1/standing-grants?assigned_by=me|held_by=me|pending_finance=me`, `GET /:id` (with month-to-date usage and cap), `PUT /api/v1/standing-grants/prune-setting`. `held_by=me` is readable from the `employee` base role.
  - [ ] 3.2 No response contains "No approval required" or "junior" (test asserts it).

- [ ] **Task 4: Per-line grant routing at raise (AC 2, 3)**
  - [ ] 4.1 Hook D6 into Story 4.10's per-line route resolution, before DOA resolution for each line; server-side only.
  - [ ] 4.2 Line reads expose `approval_route`, `standing_grant_ref`, `cap`, `month_to_date_issued` (chip copy such as "4 of 6 cans used this month").

- [ ] **Task 5: Issue-time cap check and slip (AC 2, 3)**
  - [ ] 5.1 Hook D8 into Story 4.11's issue applier; write `standing_grant_id` on the issue record.
  - [ ] 5.2 Slip and issue response carry `standing_approval_text` per D9 when the line rode a grant.

- [ ] **Task 6: Self-approval per line (AC 4)**
  - [ ] 6.1 D10 branch in the Story 4.10 line-decision seam; every other requester case keeps `INDENT_RAISER_CANNOT_APPROVE`; `NOT_RESOLVED_APPROVER` paths untouched.
  - [ ] 6.2 Line and audit entry record `self_approved` and `self_approval_grant_id`.
  - [ ] 6.3 `GET /api/v1/indents?mine=true` shows line value only to a caller holding a live limit (EXPERIENCE.md); Story 1.15's no-number rule holds for everyone else.

- [ ] **Task 7: Auto-revoke and pruning (AC 5, 6)**
  - [ ] 7.1 `deprovisionUser`: after `user.deprovisioned`, revoke each live held grant (`account_disabled`, system actor); the already-inactive branch sweeps idempotently.
  - [ ] 7.2 `src/notify/standing-grant-sweep.ts` per D13; payload per grant: `grant_ref`, grantee, scope label, cap, last-period issued qty, `last_used_at`, `consider_revoking`.

- [ ] **Task 8: Docs and rehearsal (all ACs)**
  - [ ] 8.1 Access matrix: section 8 rows for the two DOA types; `standing_grant` capability row. Do not re-edit the SOD-01 amendment.
  - [ ] 8.2 `docs/migration/pilot-cutover-runbook.md`: staging row (seed, assign, finance approve, mixed requisition raise, issue, slip text, revoke, disable account).
  - [ ] 8.3 `deploy/rehearsal/mock/operations-smoke.ts`: flow `standingApproval`.

- [ ] **Task 9: Tests (all ACs)**
  - [ ] 9.1 New `test/integration/story-4-8.test.ts`, one `describe` per AC (Testing Requirements).
  - [ ] 9.2 Rerun `story-4-3`, `story-1-4`, `story-1-15`, `story-8-9`, the 1.16, 2.10, 4.10, 4.11 suites, and `schema-drift`.
  - [ ] 9.3 Run `graphify update .`.

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

### Debug Log References

### Completion Notes List

### File List
