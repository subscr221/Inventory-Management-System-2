# Story 10.2: R&D Requisition, Budget Check, and Issue Types

Status: ready-for-dev

## Story

As an R&D project owner,
I want requisitions checked against committed-plus-actual budget with breach routing, three distinct issue semantics, and Ind AS 38 phase-based capitalization,
so that spend stays within budget and is classified correctly for tax and accounting from the outset.

## Acceptance Criteria

1. **Given** an R&D requisition against a project (FR-RD-04)
   **When** it is submitted
   **Then** a committed-plus-actual budget check runs and a breach routes to the project owner and R&D head with `error_code: "APPROVAL_REQUIRED"`

2. **Given** an approved requisition (FR-RD-05)
   **When** material is issued
   **Then** the issue is recorded under one of three semantics: consumable (expensed), project material (accumulates WIP), or equipment custody (loan)

3. **Given** an issue on a project whose phase tag is research (FR-AC-02)
   **When** the issue is posted
   **Then** the cost is expensed in the period of issue

4. **Given** an issue on a project whose phase tag is development (FR-AC-03)
   **When** the issue is posted
   **Then** the cost is capitalized only when the project carries a six-criteria Ind AS 38 checklist with all six criteria recorded as met, and the checklist reference is stored on the costing record

5. **Given** a development-phase project whose Ind AS 38 checklist is incomplete or has a failing criterion (FR-AC-03)
   **When** an issue is posted
   **Then** the cost is expensed and capitalization is blocked with `error_code: "CAPITALIZATION_CRITERIA_NOT_MET"`

6. **Given** costs already expensed under the research phase or a failed checklist (FR-AC-02, FR-AC-03)
   **When** the project later passes the six-criteria checklist
   **Then** only costs incurred from the date the criteria are met are capitalized; any attempt to retroactively reinstate a previously expensed cost as capitalized is rejected with `error_code: "RETROACTIVE_REINSTATEMENT_BLOCKED"`

7. **Given** an equipment-custody issue (FR-RD-06)
   **When** it is recorded
   **Then** an equipment custody register entry is created with named custodian, expected return date, and condition codes, with overdue ageing tracked

**Source:** [epics.md](../planning-artifacts/epics.md) Story 10.2, lines 3826-3861, verbatim. Do not reword the ACs.

## Tasks / Subtasks

- [ ] **Task 1: Projections `rd_requisition`, `rd_requisition_line`, `rd_project_checklist`, `rd_equipment_custody`, `rd_issue_cost` (AC: 1, 2, 3, 4, 5, 6, 7)**
  - [ ] `read/projections/rd_requisition.sql` (new) - header with `project_code`, `requester_user_id`, `business_stream`, `estimated_value`, `status`, `budget_breach` flag, `approver_actor_id`, `owner_approval`, `decided_at`, `decided_by`, `rejection_reason`, `source_event_id`, timestamps
  - [ ] `read/projections/rd_requisition_line.sql` (new) - `sku`, `requested_qty`, `uom`, `unit_cost_estimate`, `line_value`, `issue_type` (consumable / project_material / equipment_custody), line issue state
  - [ ] `read/projections/rd_project_checklist.sql` (new) - six fixed criterion rows per project, each with `met BOOLEAN` and `met_at`; forward-only `ALTER TABLE rd_project ADD COLUMN IF NOT EXISTS capitalization_effective_date TIMESTAMPTZ` (null until all six met)
  - [ ] `read/projections/rd_equipment_custody.sql` (new) - custody register: `custodian_user_id`, `expected_return_date`, `condition_codes`, `asset_id` (AD-9), `status` (on_loan / returned), `source_event_id`
  - [ ] `read/projections/rd_issue_cost.sql` (new) - the costing record: `issue_type`, `phase`, `capitalization` (expensed / capitalized), `checklist_reference`, `cost_amount`, `business_date`, `source_event_id`
  - [ ] Append all five (plus the checklist ALTER file) to the `MIGRATIONS` tail in `src/events/migrate.ts` with a Story 10.2 comment
  - [ ] Mirror each byte-for-byte into `deploy/compose/init-db.sql` and add every table/constraint/index to `EXPECTED` in `test/unit/schema-drift.test.ts`

- [ ] **Task 2: Event types and payload interfaces (AC: 1, 2)**
  - [ ] `src/events/schema.ts` - payload plus envelope pairs (`Omit<EventEnvelope, 'payload'>`) for `rd_requisition.raised`, `rd_requisition.approved`, `rd_requisition.rejected`, `rd_requisition.issued`
  - [ ] Append each to `SUPPORTED_EVENT_TYPES` on a new `research` stream; `rd_requisition.raised` carries `requiresBusinessStream: true`, the rest `false`

- [ ] **Task 3: Compliance seam `src/compliance/rd-requisition.ts` (AC: 1)**
  - [ ] Assert/apply split, `alreadyPersisted` (plain SELECT, never `FOR UPDATE` on `domain_events`), budget check plus DOA/owner routing on raise, approve/reject with SOD-01 and resolved-approver enforcement

- [ ] **Task 4: Compliance seam `src/compliance/rd-issue.ts` (AC: 2, 3, 4, 5, 6, 7)**
  - [ ] Issue classification, nested `stock.issued` via `applyStockBalanceProjection`, Ind AS 38 phase classification, checklist gate, custody register write, immutable costing record

- [ ] **Task 5: REST routes `src/api/v1/rd-requisitions.ts` and `src/api/v1/rd-issues.ts` (AC: 1, 2)**
  - [ ] Raise, list, get, approve, reject for requisitions; issue route; checklist set route; register all in `src/server.ts` and the Story 1.9 spine allowlist

- [ ] **Task 6: Error codes registered in three places (AC: 1, 5, 6)**
  - [ ] `CAPITALIZATION_CRITERIA_NOT_MET`, `RETROACTIVE_REINSTATEMENT_BLOCKED`, and the `RD_REQUISITION_*` family in `PERMANENT_ERROR_CODES` (`src/sync/upload.ts`), `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`

- [ ] **Task 7: Integration test `test/integration/story-10-2.test.ts` (AC: 1-7)**
  - [ ] Cover each AC plus the negative paths and replay idempotency

- [ ] **Task 8: Verification gates**
  - [ ] `npx tsc --noEmit`, `npm run lint`, `npm run format:check`, `npm run db:migrate` idempotent, `npm test` no new failures, `npm run spine-acceptance-contract`, `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:build`, schema-drift and no-hardcoded-role-in-workflow green

## Dev Notes

### Scope boundaries - read before writing code

This story owns the R&D project requisition document, its committed-plus-actual budget check against the project budget, the three issue semantics, Ind AS 38 phase-based cost classification, and the equipment custody register. It does NOT own:

- **ERP-synced budget heads.** FR-BC-01/02 (ERP budget heads, warn-or-block, commitments reducing availability) is Story 11.3 in Epic 11, not this story. This story's budget check is against the local project budget `rd_project.budget_amount` (created in Story 10.1), which is a project master, not an ERP budget head. Do not build any ERP budget projection or `BUDGET_EXCEEDED` code here.
- **The R&D project WIP ledger.** FR-RD-07 (accumulated quantity and cost per project, "the project WIP ledger") is Story 10.3. This story only records the `project_material` issue type and its cost classification (expensed vs capitalized) on the costing record; Story 10.3 builds the quantity-plus-cost WIP ledger on top of those records. Do not create a per-project WIP balance table here.
- **Equipment custody return flow.** FR-RD-06 here is the register entry at issue time (custodian, expected return date, condition codes) plus overdue ageing. The return, custodian confirmation, and unconfirmed-flagging are FR-RD-18 in Story 10.5. Do not build the return or custodian-confirmation path here.
- **Hub point-of-use sales.** Story 10.6. The maker-hub store was set up in Story 10.1, but hub sales, payment, and end-of-day reconciliation are not this story. This story's requisitions are R&D project requisitions on the `research` business stream.
- **Prototype build records.** Story 10.3. A `project_material` issue here does not create a build record.

### Architecture invariants that bind this story

- **AD-3 (DOA as single approval resolver):** the R&D head on a budget breach resolves from the DOA registry, never a hard-coded role name. Reuse `resolveApprover` from `src/api/v1/indents.ts:104`. A role-name literal anywhere in the workflow path fails `test/unit/no-hardcoded-role-in-workflow.test.ts` (Story 1.9 spine contract).
- **AD-5 (production WIP distinct from R&D project WIP):** R&D project material and its cost must not post to `production_wip_ledger`. R&D issue cost lives in its own `rd_issue_cost` projection. A single transaction cannot post to both.
- **AD-7 (R&D stock blocked from cross-issue):** the Story 10.1 guards (`assertRdIssueGuards` in `src/compliance/rd-guards.ts`) already run in the indent issue seam. Your R&D issue seam must run them too; do not re-implement the cross-issue or project-code logic.
- **AD-9 (one asset register):** equipment-custody issues reference the asset register (`read/projections/asset.sql`, the `asset` table). An equipment loan must be tied to an `asset_id`, not a free-text equipment name.
- **AD-14 (read models are shared projections):** the R&D issue applier reads project, checklist, location, lot, and stock through the projection accessors, and writes only through `persistEvent` (or the nested `stock.issued` seam). No direct `INSERT`/`UPDATE` on another module's tables.
- **AD-16 (idempotency keys):** every command carries an `idempotency_key`; the seam's `alreadyPersisted` plus a source-event unique index absorb replays. A duplicate submission returns the existing event, not a second row.
- **AD-17 (notification coupling):** budget-breach routing and approve/reject decisions are business facts. Use `emitNotificationInTransaction`, never the plain `emitNotification`, for the routing and decision notifications.

### Existing code this story must reuse, not reinvent

Table 1 lists every component that already exists and the exact way this story consumes it. Reinventing any row is a review-blocking defect.

| Component | Path | How Story 10.2 uses it |
| --- | --- | --- |
| R&D guards | `src/compliance/rd-guards.ts` | `assertRdIssueGuards` (cross-issue + project-code), `isRdSource`, `RD_DEMAND_STREAMS` |
| DOA resolution | `src/read/projections/doa_registry.ts` | `findMatchingDoaEntry`, `findRoleHolder`, `findActiveDelegation`, `listActiveDoaEntries` |
| Approver resolver | `src/api/v1/indents.ts:104` | `resolveApprover(transactionType, value)` returns `{ requiresApproval, approverActorId, doaEntryId }` |
| Event persistence | `src/events/store.ts` | `persistEvent` is the only write path; wire `assert*Shape` pre-transaction and `apply*Projection` inside the transaction |
| Stock ledger movement | `src/compliance/stock-balance.ts` | `applyStockBalanceProjection` for the nested `stock.issued`; do not call `applyStockIssue` directly |
| Valuation relief | `src/compliance/inventory-valuation.ts` | `applyValuationOutflow` returns the relieved owned cost as NUMERIC string |
| RBAC guard | `src/middleware/rbac.ts` | `requireRole({ module: 'engineering', functionScope })` - the module Story 10.1 uses for R&D routes |
| Error type | `src/middleware/error.ts` | `AppError(status, code, message, details)` |
| Audit log | `src/read/projections/audit_log.js` / `logAuditEntry` | every mutating request logged with `trace_id` (FR-AC-13) |
| IST business date | `src/lib/business-days.ts` | `toIstCalendarDate` for `business_date` and the expense period |
| Idempotency | `src/compliance/indent.ts` | `alreadyPersisted` plain-SELECT pattern (see the inherited-defect warning below) |
| Duplicate classification | `src/compliance/custody-ledger.ts` | `classifyDuplicate` pattern for 23505 constraint-name mapping |

### The issue seam pattern to follow

Model `src/compliance/rd-issue.ts` on `src/compliance/indent-issue.ts` (Story 4.11). The indent issue seam already shows the full shape:

1. `normaliseIssueLines` validates every line before any write.
2. `applyIndentIssued` runs every guard for every line before any write (all-or-nothing), under lock order header then lines then stock rows.
3. The ledger movement is a NESTED `stock.issued` event persisted through `persistEvent` with the same client, so lot/serial validation, lot trace, valuation outflow, and the QC gate all run through their own seams.
4. `assertRdIssueGuards` is called per line with the business stream and raw project code.

Your R&D issue seam differs in exactly these ways:

- The document is an `rd_requisition`, not an `indent`. Use `rd_requisition` accessors, not `indent` accessors.
- Each line carries an `issue_type` (`consumable` / `project_material` / `equipment_custody`). Validate it against a fixed set and refuse unknown values with `INVALID_PARAMS`.
- After the ledger movement, classify the cost per Ind AS 38 (Task 4 detail below) and write the `rd_issue_cost` costing record.
- For `equipment_custody`, write the `rd_equipment_custody` register entry instead of (or in addition to) a costing expense. An equipment loan is not expensed and does not accumulate WIP; it is a custody record.

### Budget check (AC 1)

The committed-plus-actual budget check runs at `rd_requisition.raised` time, inside the transaction, under a project lock so two concurrent raises cannot both pass:

- **committed** = the sum of `estimated_value` (or line `line_value`) of approved-not-yet-issued `rd_requisition` headers for the project.
- **actual** = the sum of `cost_amount` in `rd_issue_cost` for the project.
- **probe** = committed + actual + the new requisition's value, compared against `rd_project.budget_amount`.

On breach, do not hard-block and do not mint a budget-exceeded code. Instead:

- Set the requisition `status` to the approval-required state and `budget_breach = true`.
- Resolve the R&D head via `resolveApprover` with a DOA transaction type you define (for example `rd_budget_breach`), and store the resolved `approver_actor_id` plus `doa_entry_id`.
- Route to BOTH the project owner (`rd_project.owner_user_id`) and the R&D head. Use `emitNotificationInTransaction` (AD-17) for the routing notifications.
- Return `APPROVAL_REQUIRED` until the required approval is recorded.

The project owner is a direct user id, not a role, so the owner leg is a `user_id` target; the R&D head leg is the DOA-resolved role holder. The exact dual-signature mechanics are yours to finalize, but both parties must be routed and `APPROVAL_REQUIRED` must stand until the required party (or parties) acts. `APPROVAL_REQUIRED` already exists in the spine registry; reuse it.

### Ind AS 38 six criteria (AC 4, 5, 6)

The six criteria are the fixed Ind AS 38 (IAS 38.57) development-capitalization tests. Use these, in this order, as the checklist vocabulary:

1. `technical_feasibility` - technical feasibility of completing the intangible asset so it is available for use or sale
2. `intention_to_complete` - intention to complete the intangible asset and use or sell it
3. `ability_to_use_or_sell` - ability to use or sell the intangible asset
4. `future_economic_benefits` - how the asset will generate probable future economic benefits
5. `resources_available` - availability of adequate technical, financial and other resources to complete and use or sell the asset
6. `expenditure_measurable` - ability to measure reliably the expenditure attributable to the asset during its development

Classification rule at issue time:

- Phase `research` - always expensed (AC 3).
- Phase `development` - capitalized only when all six criteria are `met`; otherwise expensed with `CAPITALIZATION_CRITERIA_NOT_MET` (AC 4, AC 5).

The `capitalization_effective_date` on `rd_project` is the single source of truth for the "date criteria met". Set it server-side the first time all six criteria become `met`, and never move it backwards. The issue applier capitalizes only issues whose `business_date` is on or after that date; an issue dated before it is expensed even if the checklist is now complete.

### Retroactive reinstatement is prevented, not just rejected (AC 6)

The `rd_issue_cost` costing record is append-only. No route or event can flip an existing `capitalization = 'expensed'` row to `capitalized`. The only way a cost becomes capitalized is a new issue whose business date is on or after `capitalization_effective_date`. Enforce `RETROACTIVE_REINSTATEMENT_BLOCKED` at the only mutation point that could otherwise express such a flip (the checklist set route must refuse to back-date `capitalization_effective_date`, and the issue applier must refuse a `capitalization = 'capitalized'` claim for a date before it). This makes retroactive reinstatement structurally impossible, which is the stronger reading of AC 6.

### Equipment custody register (AC 7)

Fields per AC 7: named custodian (`custodian_user_id`), expected return date, condition codes, overdue ageing. Bind AD-9: the loaned equipment must reference `asset` via `asset_id` where the item is a registered asset. Overdue ageing is derived, not stored: a row is overdue when `status = 'on_loan'` and `expected_return_date` is before the current IST date. Expose it as a read accessor or query; do not mint an ageing event in this story.

### Error codes and their exact contract

Reuse, do not mint variants: `APPROVAL_REQUIRED`, `PROJECT_CODE_REQUIRED`, `CROSS_ISSUE_BLOCKED` already exist.

New codes (declare in the server registry, mirror in `edge/src/sync/connector.ts` `PERMANENT_ERROR_CODES`, and add an `errors.<CODE>` entry in `edge/src/messages/en.json`):

- `CAPITALIZATION_CRITERIA_NOT_MET`
- `RETROACTIVE_REINSTATEMENT_BLOCKED`
- `RD_REQUISITION_NOT_FOUND`
- `RD_REQUISITION_ALREADY_DECIDED`
- `RD_REQUISITION_LINE_REQUIRED`
- `RD_REQUISITION_LINE_NOT_FOUND`
- `RD_REQUISITION_NOT_APPROVED`
- `RD_ISSUE_TYPE_REQUIRED`

A code missing from both permanent-code Sets makes an offline-captured requisition retry forever instead of settling as `needs_attention` (Story 4.3 Task 7 lesson).

### Inherited defects and corrections - do not copy

- `src/compliance/supplier.ts` `alreadyPersisted` uses `SELECT ... FOR UPDATE` on `domain_events`, which `app_user` cannot execute (only INSERT, SELECT granted); every supplier event apply 500s at runtime. Story 4.3's indent seam fixed this with a plain SELECT. Copy the indent seam's plain SELECT, never the supplier seam's `FOR UPDATE`.
- Story 10.1's `rd-projects.ts` writes straight to the `rd_project` projection with no domain event and no audit log entry, noted in its own docstring as a shortcut. Your checklist set route must at least `logAuditEntry` (FR-AC-13) and must refuse to back-date `capitalization_effective_date`; it may stay a direct write consistent with 10.1, but note the same shortcut limitation.
- Story 10.1's `rd_project` has no six-criteria checklist and no `capitalization_effective_date`. You add both; do not assume they exist.
- `APPROVAL_UNRESOLVED` (409) is thrown by `resolveApprover` and is already in the permanent-code Sets (Story 4.3 added it). Reuse it; do not mint another unresolved-approver code.

### Project structure notes

- SQL DDL lives at repo root `read/projections/*.sql`; TypeScript accessors at `src/read/projections/*.ts`. There is no `src/read/projections/*.sql`.
- Migration filenames carry no numeric prefix; ordering is the array position in `src/events/migrate.ts`. Tail-append new files with a Story 10.2 comment. A forward-only `ALTER` on an existing table goes in a new file appended at the tail, never by editing the original file.
- `deploy/compose/init-db.sql` is a byte-for-byte mirror of every projection file; change both together or the schema-drift test fails.
- Node 24 LTS, ESM (`"type": "module"`), TypeScript 5.x, PostgreSQL 18.4, `node:test` only (no Jest/Vitest), `pg ^8.16.0`. Test database on port 5442 via `.env.test`.
- `assertRdIssueGuards` reads `location_register.location_type` and `lot_master.rd_designated`, so those columns exist from Story 10.1.

### Previous story intelligence (Story 10.1)

- Story 10.1 is committed (`926f776`, docs `d1b4202`) and created: `location_register.location_type` (standard / rd_store / maker_hub_store), `lot_master.rd_designated`, `rd_project` (project_code, owner_user_id, phase, budget_amount, status), `rd_reclassification`, `src/compliance/rd-guards.ts`, `src/api/v1/rd-projects.ts`, and error codes `CROSS_ISSUE_BLOCKED` plus `PROJECT_CODE_REQUIRED`.
- Story 10.1 owner rulings still bind: `rd_designated` and `location_type` setters ride the existing master-data write seams; reclassification is request/approve with server-enforced `approved_by != requested_by` and single-use consumption; the cross-issue guard is enforced at the material-issue seam only (transfer, pick, adjustment, and production-issue seams are deferred work).
- This story extends `rd_project` with the checklist and capitalization date, and adds the R&D issue seam that runs alongside the indent issue seam.

### Git intelligence

Story 10.1 is the immediate predecessor and the direct integration point: its `rd-guards.ts` and the `indent-issue.ts` call site are the seams this story extends. The `indent-issue.ts` seam (Story 4.11) and `custody-ledger.ts` (Stories 9.3-9.7) are the two closest end-to-end precedents for the R&D issue seam and the custody register write respectively.

### Verification commands

- `npm run test:integration -- test/integration/story-10-2.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run format:check`
- `npm run db:migrate` (re-run twice to prove idempotency)
- `npm test` (no new failures versus the documented pre-existing idempotency class)
- `npm run spine-acceptance-contract`
- `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:build`
- `test/unit/schema-drift.test.ts`, `test/unit/no-hardcoded-role-in-workflow.test.ts`

## References

- [epics.md](../planning-artifacts/epics.md) lines 3826-3861 - Story 10.2 ACs, verbatim source
- [epics.md](../planning-artifacts/epics.md) lines 3796-3824 - Story 10.1 and Epic 10 goal
- [epics.md](../planning-artifacts/epics.md) lines 4142-4173 - Story 11.3 (ERP budget control), the boundary this story does not cross
- [epic-10-context.md](epic-10-context.md) - Epic 10 requirements, constraints, technical decisions, dependencies
- [spec-10-1-randd-and-maker-hub-location-types-and-project-master.md](spec-10-1-randd-and-maker-hub-location-types-and-project-master.md) - Story 10.1 output and owner rulings
- [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) - AD-3, AD-5, AD-7, AD-9, AD-14, AD-16, AD-17, event envelope, error registry
- [4-3-purchase-requisition-and-indent-loop.md](4-3-purchase-requisition-and-indent-loop.md) - the requisition/DOA/SOD/notification precedent and its reuse table
- `src/compliance/indent-issue.ts` - the material-issue seam to model the R&D issue seam on
- `src/compliance/rd-guards.ts` - the Story 10.1 guards this story reuses
- `src/read/projections/doa_registry.ts` and `src/api/v1/indents.ts:104` - the DOA resolver

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
