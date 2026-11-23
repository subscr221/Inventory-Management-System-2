# Story 10.3: Project WIP Ledger and Prototype Build Records

Status: done

## Story

As an R&D project manager,
I want a per-project WIP ledger in quantity and cost, prototype build records including failed builds, non-saleable serialized completed builds, four approved dispositions, and material returns,
So that every prototype's material history and cost is fully captured.

## Acceptance Criteria

1. **Given** project material issued (FR-RD-07)
   **When** the project WIP ledger is viewed
   **Then** it shows accumulated quantity and cost per project in real time

2. **Given** a prototype build (FR-RD-08)
   **When** the build is recorded, including failed or abandoned builds
   **Then** a build record captures the full material history

3. **Given** a completed prototype build (FR-RD-09)
   **When** it is registered
   **Then** it is registered as a non-saleable serialized class

4. **Given** a serialized prototype in the non-saleable class (FR-RD-09)
   **When** a dispatch document or issue-to-dispatch is attempted against it
   **Then** the transaction is blocked with `error_code: "NON_SALEABLE_CLASS"`; the same class check blocks sales-order allocation when the Phase-2 orders module (Epic 15) lands

5. **Given** a completed prototype (FR-RD-10, FR-RD-11)
   **When** a disposition is chosen among retain-as-asset, transfer-to-production, teardown, or scrap
   **Then** the disposition requires R&D-head approval (`error_code: "APPROVAL_REQUIRED"`), teardown recovers components with condition codes, retain-as-asset creates an Epic 7 asset-register entry, and transfer-to-production records a production-reference designation

6. **Given** teardown or scrap lines from an approved disposition (FR-RD-11)
   **When** the disposition is executed in Phase 1
   **Then** the lines are placed in a scrap-pending holding state carrying quantity, condition code, and source-prototype reference, visible in the project's material history

7. **Given** unused project material (FR-RD-12)
   **When** it is returned
   **Then** the return reverses project WIP by the returned cost

**Note:** Deferred to Phase 2 (Epic 16): routing of teardown and scrap lines into the FR-SC scrap module. Phase 1 holds them in the scrap-pending state above with full source references; Epic 16 consumes that state without rework of this story.

**Source:** [epics.md](../planning-artifacts/epics.md) Story 10.3, lines 3864-3900, verbatim. Do not reword the ACs.

## Tasks / Subtasks

- [x] **Task 1: Projections `rd_project_wip_ledger`, `rd_prototype`, `rd_disposition`, `rd_disposition_line`, `rd_scrap_pending` (AC: 1, 3, 5, 6, 7)**
  - [x] `read/projections/rd_project_wip_ledger.sql` (new) - per-project WIP postings modeled on `production_wip_ledger`: `posting_type` (issue / return), `source_posting_id` for return pairing, quantity, unit_cost, posting_value
  - [x] `read/projections/rd_prototype.sql` (new) - completed build registered as a serialized non-saleable class (serial_number, prototype ref, build_id, disposition status)
  - [x] `read/projections/rd_disposition.sql` + `rd_disposition_line.sql` (new) - four dispositions, R&D-head approval, line-level teardown recovery
  - [x] `read/projections/rd_scrap_pending.sql` (new) - scrap-pending holding (quantity, condition code, source-prototype reference)
  - [x] Append all to `MIGRATIONS` tail in `src/events/migrate.ts`, mirror into `deploy/compose/init-db.sql`, add to `EXPECTED` in `test/unit/schema-drift.test.ts`

- [x] **Task 2: Event types and payload interfaces (AC: 1, 3, 5, 6, 7)**
  - [x] `src/events/schema.ts` - payload/envelope pairs for `rd_build.completed`, `rd_disposition.requested`, `rd_disposition.approved`, `rd_disposition.executed`, `rd_material.returned`
  - [x] Append to `SUPPORTED_EVENT_TYPES` on the `research` stream (`requiresBusinessStream` false for all)

- [x] **Task 3: Compliance seam `src/compliance/rd-wip.ts` (AC: 1, 7)**
  - [x] WIP issue posting (driven from the story 10.2 issue seam for `project_material`) and return posting (reverses WIP by returned cost, `source_posting_id` pairing)

- [x] **Task 4: Compliance seam `src/compliance/rd-prototype.ts` (AC: 3, 4)**
  - [x] Completed build registration as serialized non-saleable class; NON_SALEABLE_CLASS guard at dispatch/issue-to-dispatch

- [x] **Task 5: Compliance seam `src/compliance/rd-disposition.ts` (AC: 5, 6)**
  - [x] Disposition request/approve (R&D head via `resolveApprover`)/execute; teardown recovery, retain-as-asset, transfer-to-production, scrap-pending write

- [x] **Task 6: REST routes `src/api/v1/rd-wip.ts`, `rd-prototypes.ts`, `rd-dispositions.ts`, `rd-returns.ts` (AC: 1-7)**
  - [x] WIP ledger read, prototype register, disposition request/approve/execute, material return; register in `src/server.ts` and the Story 1.9 spine allowlist

- [x] **Task 7: Error codes registered in three places (AC: 4, 5)**
  - [x] `NON_SALEABLE_CLASS` and the `RD_DISPOSITION_*` / `RD_RETURN_*` family in `PERMANENT_ERROR_CODES` (`src/sync/upload.ts`), `edge/src/sync/connector.ts`, `edge/src/messages/en.json`

- [x] **Task 8: Integration test `test/integration/story-10-3.test.ts` (AC: 1-7)**

- [x] **Task 9: Verification gates**
  - [x] `npx tsc --noEmit`, `npm run lint`, `npm run db:migrate` idempotent, `npm test`, `npm run spine-acceptance-contract`, `npm run edge:typecheck`, schema-drift and no-hardcoded-role-in-workflow green

## Dev Notes

### Scope boundaries - read before writing code

This story owns the R&D project WIP ledger, the completed-prototype non-saleable class, the NON_SALEABLE dispatch block, the four dispositions, the scrap-pending holding state, and material returns. It does NOT own:

- **Phase-2 scrap routing.** Routing teardown/scrap lines into the FR-SC scrap module is Epic 16. Phase 1 only holds them in the scrap-pending state with full source references.
- **Phase-2 sales-order allocation block.** The NON_SALEABLE_CLASS check blocks dispatch and issue-to-dispatch now; the sales-order allocation block lands with Epic 15. Write the class check as a reusable guard so Epic 15 can call it.
- **Asset-register internals.** Retain-as-asset only CREATES an Epic 7 asset-register entry (via the existing `asset` write path). Do not rebuild the asset register.
- **Form 3CL / IAUD reporting.** That is Story 10.5.
- **Hub member/machine-time.** Story 10.4.

### Existing infrastructure this story reuses, not reinvents

Table 1 lists the precedents that already exist. Reinventing any row is a review-blocking defect.

| Component | Path | How Story 10.3 uses it |
| --- | --- | --- |
| Production WIP ledger | `read/projections/production_wip_ledger.sql` | the exact model for `rd_project_wip_ledger` (posting_type, source_posting_id pairing, reason_code, open_quantity) |
| R&D build record | `read/projections/rd_build_record.sql` | already has `outcome` (success/failed/abandoned) and status; AC 2 is a continuation |
| R&D as-built lines | `read/projections/rd_as_built_line.sql` | the full material history per build (component_sku, quantity_used, deviation flags) |
| R&D costing record | `read/projections/rd_issue_cost.sql` | the cost source for WIP (cost_amount, unit_cost per issue) |
| R&D requisition line | `read/projections/rd_requisition_line.sql` | `issued_quantity` is the quantity source for WIP |
| Non-saleable class | `src/compliance/stock-balance.ts` `SEGREGATED_STOCK_CLASSES` (`prototype`, `job_work`, `offcut`) | the `prototype` class already carries non-saleable semantics and the laundering bar (FR-Q-12) |
| Dispatch gate | `src/compliance/dispatch.ts` `dispatchGateBlockedLots` | the seam to extend (or add a sibling check) for NON_SALEABLE_CLASS |
| Asset register | `read/projections/asset.sql` + `src/compliance/asset.ts` | retain-as-asset creates the Epic 7 entry |
| DOA resolution | `src/read/projections/doa_registry.ts` + `resolveApprover` | R&D-head approval for dispositions; never hard-code a role |
| R&D guards | `src/compliance/rd-guards.ts` | cross-issue + project-code guards reused on any new R&D issue path |

### Architecture invariants that bind this story

- **AD-5 (production WIP distinct from R&D project WIP):** R&D WIP posts to `rd_project_wip_ledger`, never to `production_wip_ledger`. A single transaction cannot post to both.
- **AD-7 (R&D stock blocked from cross-issue):** reuse `assertRdIssueGuards` on any R&D material movement.
- **AD-9 (one asset register):** retain-as-asset references the asset register.
- **AD-3 (DOA as single approval resolver):** disposition approval resolves the R&D head from the DOA registry.
- **AD-14 (read models are shared projections):** read through the accessors, write through `persistEvent` only.
- **AD-16 (idempotency):** every command carries an idempotency key; source_event_id unique per header, `alreadyPersisted` plain-SELECT guard.

### WIP ledger design (AC 1, 7)

Model `rd_project_wip_ledger` on `production_wip_ledger`:
- `posting_type IN ('issue', 'return')`.
- `issue` posting: +quantity, +posting_value (from `rd_issue_cost` unit_cost/cost_amount) when a `project_material` line is issued.
- `return` posting: -quantity, -posting_value, with `source_posting_id` referencing the original issue posting and a `reason_code`, exactly like the production `return`/`scrap_relief` pairing CHECK.
- Accumulated WIP = `SUM(quantity)` and `SUM(posting_value)` per project_code; expose as a read accessor.

The return (AC 7) reverses WIP by the returned cost: it must reference the original issue posting and cannot return more than the open (unreturned) quantity.

### Prototype completion and non-saleable class (AC 3, 4)

- Registering a completed build creates a serialized prototype in the `prototype` stock_class (already non-saleable via `SEGREGATED_STOCK_CLASSES`). The serialized row keys on (sku, location, lot, serial, stock_class='prototype').
- The NON_SALEABLE_CLASS guard: extend `dispatchGateBlockedLots` (or add a sibling) so a dispatch document or issue-to-dispatch against a `prototype`-class lot/serial is refused with `NON_SALEABLE_CLASS`. Write it as a reusable guard so Epic 15's sales-order allocation can call the same check.
- `NON_SALEABLE_CLASS` already exists in the stock-balance laundering bar vocabulary; reuse the code, do not mint a variant.

### Dispositions (AC 5, 6)

Four disposition kinds: retain-as-asset, transfer-to-production, teardown, scrap.
- Disposition requires R&D-head approval via `resolveApprover('rd_disposition', 0)` (or a value if the registry is banded) plus `emitNotificationInTransaction` routing; return `APPROVAL_REQUIRED` until approved.
- Execute branches:
  - retain-as-asset: create an asset-register entry via the `asset` write path.
  - transfer-to-production: record a production-reference designation (a reference field, not a full production order).
  - teardown: recover components with condition codes (component lines with condition_codes).
  - scrap: place lines in scrap-pending.
- Scrap-pending holding state (`rd_scrap_pending`): quantity, condition_code, source-prototype reference; visible in the project's material history.

### Error codes

Reuse `APPROVAL_REQUIRED`, `NON_SALEABLE_CLASS`. New codes (register in server registry + both permanent-code sets + en.json): `RD_PROTOTYPE_NOT_FOUND`, `RD_DISPOSITION_NOT_FOUND`, `RD_DISPOSITION_ALREADY_DECIDED`, `RD_DISPOSITION_NOT_APPROVED`, `RD_DISPOSITION_LINE_REQUIRED`, `RD_RETURN_EXCEEDS_OPEN`, `RD_BUILD_NOT_COMPLETED`.

### Inherited defects and corrections - do not copy

- `alreadyPersisted` uses a plain SELECT, never `FOR UPDATE` on `domain_events` (the `supplier.ts` variant is a known runtime defect).
- Guarded DROP/ADD pairs must escape `_` in `indexdef NOT LIKE` patterns or match on the constraint name.
- The story 10.2 issue seam sorts lines by SKU and drains all stock before relieving valuation (the `applyValuationOutflow` docstring rule); any new R&D material movement must do the same.

### Verification commands

- `npm run test:integration -- test/integration/story-10-3.test.ts`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run db:migrate` (twice, idempotent)
- `npm run spine-acceptance-contract`
- `npm run edge:typecheck`
- `test/unit/schema-drift.test.ts`, `test/unit/no-hardcoded-role-in-workflow.test.ts`

## References

- [epics.md](../planning-artifacts/epics.md) lines 3864-3900 - Story 10.3 ACs, verbatim source
- [epic-10-context.md](epic-10-context.md) - Epic 10 requirements, constraints, dependencies
- [10-2-randd-requisition-budget-check-and-issue-types.md](10-2-randd-requisition-budget-check-and-issue-types.md) - story 10.2 output (issue seam, costing record, issued_quantity)
- [spec-10-1-randd-and-maker-hub-location-types-and-project-master.md](spec-10-1-randd-and-maker-hub-location-types-and-project-master.md) - story 10.1 output (build records, guards)
- [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) - AD-3, AD-5, AD-7, AD-9, AD-14, AD-16
- `read/projections/production_wip_ledger.sql` - the WIP ledger model
- `read/projections/rd_build_record.sql`, `rd_as_built_line.sql` - existing build records
- `src/compliance/stock-balance.ts` - `SEGREGATED_STOCK_CLASSES` and the non-saleable laundering bar
- `src/compliance/dispatch.ts` - `dispatchGateBlockedLots` to extend for NON_SALEABLE_CLASS

## Dev Agent Record

### Agent Model Used

deepseek/deepseek-v4.1-flash-1017 (Kilo)

### Debug Log References

- Story 10.3 integration test: 5 of 5 pass (`node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-10-3.test.ts`).
- Full suite: 2887 of 2887 pass (`npm test`, 239 suites).
- `npx tsc --noEmit`, `npm run lint`, `npm run spine-acceptance-contract` (6 of 6), `npm run edge:typecheck`, `schema-drift` + `no-hardcoded-role-in-workflow` (224 of 224), and two consecutive `src/events/migrate.ts` runs (idempotent) all pass.

### Completion Notes List

- Implemented the project WIP ledger, prototype registration, the reusable NON_SALEABLE_CLASS dispatch guard, the four-way disposition state machine, scrap-pending holding, and material returns.
- Retry of the aborted prior attempt: the projection DDL is now idempotent on a database migrated from an earlier index-only unique definition (the guarded ALTER drops the conflicting same-named index before adding the constraint), and the duplicated Story 10.3 block in `deploy/compose/init-db.sql` was removed.
- Fixed latent defects found by the expanded tests: `rd_prototype.lot_id` stores the lot UUID so the dispatch guard matches packing-record lot ids; the return payload reads frozen valuation from `rd_requisition.issued.issued_lines`; the return event uses the issue posting id as its UUID stream id; and the execute route forwards retain-as-asset / transfer-to-production fields.
- Removed dead duplicate `rd_build.completed` handling from `src/compliance/rd-bom.ts`; the seam lives only in `src/compliance/rd-prototype.ts` and `rd_bom` now only carries the optional `project_code` build field.

### File List

- `read/projections/rd_project_wip_ledger.sql`, `rd_prototype.sql`, `rd_disposition.sql`, `rd_disposition_line.sql`, `rd_scrap_pending.sql`, `rd_build_record_project_code.sql`, `rd_build_record.sql`
- `src/compliance/rd-wip.ts`, `rd-prototype.ts`, `rd-disposition.ts`, `rd-issue.ts`, `rd-bom.ts`, `dispatch.ts`
- `src/read/projections/rd_project_wip_ledger.ts`, `rd_prototype.ts`, `rd_disposition.ts`, `rd_scrap_pending.ts`, `rd_build.ts`
- `src/api/v1/rd-wip.ts`, `rd-prototypes.ts`, `rd-dispositions.ts`, `rd-returns.ts`, `rd-boms.ts`
- `src/events/schema.ts`, `store.ts`, `migrate.ts`; `src/server.ts`; `src/sync/upload.ts`
- `edge/src/sync/connector.ts`, `edge/src/messages/en.json`
- `deploy/compose/init-db.sql`; `test/unit/schema-drift.test.ts`; `test/integration/story-1-9.test.ts`; `test/integration/story-10-3.test.ts`
