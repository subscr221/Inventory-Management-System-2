---
baseline_commit: e93014f224de6e8b3e717fb599dba7f9d0761d15
---

# Story 7.6: Statutory Examinations, Cost Accumulation, and Machine Status Broadcast

Status: done

<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-25. Comprehensive developer guide created from epics.md (Story 7.6 at line 2233; FR-M-14/15/16 at lines 169-171; the Epic 1 vs Epic 7 ownership split at line 782; the pilot build order at line 289), ARCHITECTURE-SPINE.md (AD-3, AD-8, AD-9, AD-12, AD-14, AD-16, AD-17), the sprint-change-proposal rescoping note at line 3031, the Story 7.5 calibration register tree and its Binding Scope Decisions, the Stories 7.1-7.5 maintenance module, the Epic 3 weighbridge flow (src/compliance/weighbridge.ts, src/api/v1/weighbridge.ts, test/integration/story-3-3.test.ts), and a baseline code audit at e93014f. The story adds three orthogonal surfaces to the existing maintenance module: (1) a statutory examination register keyed by (asset_id, examination_type) with a weighbridge device_key for the Epic 3 trade-weighment lockout, (2) additive cost columns on maintenance_work_order plus a per-asset cost rollup, and (3) an asset operational status projection with a DOA-gated return-to-service sign-off and a notification broadcast to production planning and hub booking. The weighbridge lockout is a pre-transaction, DB-backed assert in persistEvent mirroring assertCalibrationLockout; the cost extension rides on the existing work_order_completed event additively; the status broadcast is the Story 1.11 notification foundation. -->

## Story

As a maintenance supervisor,
I want statutory examination tracking that locks overdue assets, weighbridge re-stamping enforcement, cost accumulation per asset with a repair-vs-capitalize flag, and a fast machine-status broadcast gated by supervisor sign-off on return to service,
so that legal examinations, trade weighment integrity, lifecycle costing, and reliable status are all guaranteed.

## Acceptance Criteria

1. **Given** an asset subject to statutory examination (FR-M-14), **When** its examination becomes overdue (e.g. OSH Code or 12-month weighbridge stamping), **Then** the asset is locked from use until re-examined.
2. **Given** a weighbridge that has undergone repair (FR-M-14), **When** trade weighment is attempted before re-stamping, **Then** the weighment is blocked until the weighbridge is re-stamped.
3. **Given** maintenance activities incurring cost (FR-M-15), **When** work orders are closed, **Then** maintenance cost accumulates per asset for lifecycle costing, and any work order whose cost exceeds the configured capitalization threshold is flagged repair-vs-capitalize at closure.
4. **Given** a machine changes operational status (FR-M-16), **When** the change is recorded, **Then** the status broadcast reaches production planning and hub booking subscribers within 2 minutes.
5. **Given** a machine in breakdown or maintenance status (FR-M-16), **When** return-to-service is attempted without a recorded supervisor sign-off, **Then** the status change is rejected with `error_code: "APPROVAL_REQUIRED"` and the asset remains out of service until a supervisor signs off.

**Note:** The trade-weighment block executes inside the Epic 3 FR-W weighbridge flow (declared dependency). Deferred to Phase 2 (Epic 17): routing of above-threshold repair-vs-capitalize flagged work orders into the FR-FA capitalization queue - Phase 1 captures the flag and threshold check at closure only. Offline technician workflows and closure codes moved to Story 7.8.

## Tasks / Subtasks

- [x] Task 1: Database schema for the five new projections plus the work-order cost extension (AC: 1, 2, 3, 4, 5)
  - [x] 1.1 Create `read/projections/statutory_examination.sql` following the exact shape of `read/projections/instrument_register.sql`: canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks, `CREATE INDEX IF NOT EXISTS`, guarded `pg_roles` grants block. Columns: `examination_id UUID PRIMARY KEY`, `asset_id UUID NOT NULL`, `examination_type TEXT NOT NULL`, `interval_months INTEGER NOT NULL`, `next_due_date DATE NOT NULL`, `status TEXT NOT NULL DEFAULT 'compliant'`, `device_key TEXT` (nullable, for weighbridge device_id mapping), `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`. Constraints: `chk_statutory_examination_type CHECK (examination_type IN ('osh_code','weighbridge_legal_metrology'))`, `chk_statutory_examination_status CHECK (status IN ('compliant','overdue'))`, `chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120)`. Unique: `uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type)`. Index: `uq_statutory_examination_device_key UNIQUE INDEX (lower(device_key)) WHERE device_key IS NOT NULL`, `idx_statutory_examination_status_due (status, next_due_date)`.
  - [x] 1.2 Create `read/projections/statutory_examination_record.sql` with the same shape. Columns: `record_id UUID PRIMARY KEY`, `examination_id UUID NOT NULL`, `examined_on DATE NOT NULL`, `next_due_date DATE NOT NULL`, `certificate_number_ext TEXT`, `examined_by UUID`, `examined_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `created_at TIMESTAMPTZ`. Constraints: `chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on)`. Index: `uq_statutory_examination_record_number UNIQUE INDEX (examination_id, lower(certificate_number_ext)) WHERE certificate_number_ext IS NOT NULL`, `idx_statutory_examination_record_examination (examination_id)`.
  - [x] 1.3 Create `read/projections/asset_operational_status.sql` with the same shape. Columns: `asset_id UUID PRIMARY KEY`, `status TEXT NOT NULL DEFAULT 'idle'`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_by UUID`, `sign_off_by UUID`, `sign_off_at TIMESTAMPTZ`. Constraints: `chk_asset_operational_status CHECK (status IN ('running','idle','breakdown','maintenance'))`.
  - [x] 1.4 Create `read/projections/maintenance_asset_cost.sql` with the same shape. Columns: `asset_id UUID PRIMARY KEY`, `total_labor_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `total_parts_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `total_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `last_work_order_id UUID`, `last_closed_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Constraints: `chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0)`, `chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0)`, `chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0)`.
  - [x] 1.5 Extend `read/projections/maintenance_work_order.sql` additively with four new columns via guarded `DO $$` blocks: `labor_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `parts_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `total_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `capitalization_flagged BOOLEAN NOT NULL DEFAULT false`. Add constraints: `chk_maintenance_work_order_labor_non_negative CHECK (labor_cost >= 0)`, `chk_maintenance_work_order_parts_non_negative CHECK (parts_cost >= 0)`, `chk_maintenance_work_order_total_non_negative CHECK (total_cost >= 0)`. Do NOT change any existing column, constraint, or index.
  - [x] 1.6 Mirror all five new files plus the `maintenance_work_order.sql` change verbatim into `deploy/compose/init-db.sql`, appended in the same order. `deploy/compose/init-db.sql` is a CRLF file; normalize the appended block to CRLF so the file does not carry mixed line endings.
  - [x] 1.7 Register the five new files in the `MIGRATIONS` tail of `src/events/migrate.ts`, appended after the Story 7.5 block.
  - [x] 1.8 Add all five tables plus every named constraint and index to `EXPECTED` in `test/unit/schema-drift.test.ts`, and add the four new `maintenance_work_order` constraints there too.
  - [x] 1.9 Verify `npm run db:migrate` twice is idempotent.
- [x] Task 2: Event contracts (AC: 1, 2, 3, 4, 5)
  - [x] 2.1 Add the three new payload interfaces and envelope types to `src/events/schema.ts` in a Story 7.6 block after the Story 7.5 block: `StatutoryExaminationRecordedPayload`, `StatutoryExaminationOverduePayload`, `AssetStatusChangedPayload`.
  - [x] 2.2 Register all three in `SUPPORTED_EVENT_TYPES` with `streamType: 'maintenance'` and `requiresBusinessStream: false`.
  - [x] 2.3 Confirm every event id field is a UUID, every DATE field matches `DATE_REGEX`, every TIMESTAMPTZ field carries an explicit UTC offset, and every declared derivable field is listed for cross-checking.
  - [x] 2.4 Document the additive extension to `maintenance.work_order_completed`: the existing payload interface gains optional `labor_cost`, `parts_cost` fields (NUMERIC strings). The applier derives `total_cost` and `capitalization_flagged` server-side and writes them back onto the persisted payload. Existing 7.2 test payloads with no cost fields still pass (costs default to 0).
- [x] Task 3: Read projections and accessors (AC: 1, 2, 3, 4, 5)
  - [x] 3.1 Create `src/read/projections/statutory_examination.ts` with insert, `getExaminationById` with `FOR UPDATE`, `getExaminationByAssetAndType(asset_id, examination_type)` with `FOR UPDATE`, `getExaminationByDeviceKey(device_key)` (matching on `lower(device_key)`, for the weighbridge lockout), `listExaminations` filterable by `asset_id`, `status`, `examination_type`; paginated. Every accessor reads DATE and NUMERIC columns as strings out of pg and converts explicitly.
  - [x] 3.2 Create `src/read/projections/statutory_examination_record.ts` with insert, `listRecordsByExamination(examination_id)` newest first, `getRecordById`.
  - [x] 3.3 Create `src/read/projections/asset_operational_status.ts` with `upsertAssetOperationalStatus(input, client)` (INSERT ON CONFLICT DO UPDATE), `getAssetOperationalStatus(asset_id)` with `FOR UPDATE`, `listAssetOperationalStatuses` filterable by `status`; paginated.
  - [x] 3.4 Create `src/read/projections/maintenance_asset_cost.ts` with `upsertMaintenanceAssetCost(input, client)` (INSERT ON CONFLICT DO UPDATE that ADDS the new costs to the existing totals), `getMaintenanceAssetCost(asset_id)`, `listMaintenanceAssetCosts` paginated.
  - [x] 3.5 Extend `src/read/projections/maintenance_work_order.ts` with `setWorkOrderCosts(work_order_id, labor_cost, parts_cost, total_cost, capitalization_flagged, client)` that updates the four new columns under `FOR UPDATE`. Do not change any existing exported signatures used by `src/api/v1/maintenance.ts`.
- [x] Task 4: Compliance seams (AC: 1, 2, 3, 4, 5)
  - [x] 4.1 Create `src/compliance/maintenance-statutory.ts` structurally identical to `src/compliance/calibration-register.ts`: stream gate, pure `assertStatutoryExaminationShape(envelope)`, `applyStatutoryExaminationProjection(envelope, client)` switch, `alreadyPersisted` guard, `reject()` helper. Handle `maintenance.statutory_examination_recorded` and `maintenance.statutory_examination_overdue`.
  - [x] 4.2 Create `src/compliance/asset-operational-status.ts` with the same structure. Handle `maintenance.asset_status_changed`. The applier validates the state machine transition (Table 3), resolves the DOA approver for return-to-service under lock, writes sign-off fields back onto the persisted payload, and upserts `asset_operational_status`.
  - [x] 4.3 Extend `src/compliance/maintenance-plan.ts` to handle the additive cost fields on `maintenance.work_order_completed`. The existing `applyMaintenancePlanProjection` switch gains a branch for `maintenance.work_order_completed` that calls `setWorkOrderCosts` and `upsertMaintenanceAssetCost` when cost fields are present. Existing 7.2 payloads with no cost fields skip the cost path (costs default to 0). The applier also checks if the asset has a `weighbridge_legal_metrology` statutory examination and, if so, flips its status to `overdue` (the "repair invalidates stamp" rule per Binding Decision 7).
  - [x] 4.4 Add `assertWeighbridgeStampLockout(envelope, deps)` to `src/compliance/weighbridge.ts`, mirroring `assertCalibrationLockout` in `src/compliance/calibration.ts`. The function is an async, DB-backed pre-transaction gate called from `persistEvent` in `src/events/store.ts` for `stream_type === 'weighbridge' && event_type === 'weighbridge.recorded'`. It resolves the weighbridge identity from `payload.device_id` via `getExaminationByDeviceKey` and throws `423 WEIGHBRIDGE_OUT_OF_STAMP` if the statutory examination status is `overdue`. Fail-open for device keys not in the register (no statutory examination row for that device - the device is not governed).
  - [x] 4.5 Wire both new seams into `src/events/store.ts` alongside the 7.5 seam, and add a duplicate resolver to the 23505 mapper for each new unique index.
  - [x] 4.6 Wire `assertWeighbridgeStampLockout` into `src/events/store.ts` in the pre-transaction assert block, next to `assertCalibrationLockout`.
  - [x] 4.7 Assert the fail-closed registration rule: a newly recorded statutory examination with `next_due_date < business_date` is rejected `422 EXAMINATION_ALREADY_OVERDUE`, not silently accepted.
- [x] Task 5: Return-to-service authority (AC: 5)
  - [x] 5.1 In `src/api/v1/maintenance.ts`, the `POST /api/v1/maintenance/assets/:assetId/status` handler resolves the DOA approver via `resolveApprover('maintenance.return_to_service', 0)` and checks the acting user is the resolved approver. If not, reject `403 APPROVAL_REQUIRED` per AC5.
  - [x] 5.2 The handler also checks the asset's statutory examination status via `getExaminationByAssetAndType(asset_id, 'weighbridge_legal_metrology')` (if applicable) and any other statutory examination rows for the asset. If any is `overdue`, reject `423 STATUTORY_EXAMINATION_OVERDUE` (AC1 enforcement).
  - [x] 5.3 The handler validates the state machine transition (Table 3) and rejects invalid transitions with `400 INVALID_STATUS_TRANSITION`.
  - [x] 5.4 The handler emits the `maintenance.asset_status_changed` event with the resolved sign-off fields written back onto the payload (the applier re-derives and checks).
- [x] Task 6: Statutory scan job module (AC: 1, 2)
  - [x] 6.1 Create `src/maintenance/statutory-jobs.ts` following `src/maintenance/calibration-jobs.ts`: POST-triggered, explicit `business_date`, scope narrowed in SQL, separate write and delivery counters.
  - [x] 6.2 Implement `runStatutoryExaminationScan(scope)` per the Overdue Flip Contract, returning `examinations_evaluated`, `examinations_overdue`, `notifications_delivered`, `notifications_dropped` as separate counters.
  - [x] 6.3 Emit the overdue notification defined in the Notification Contract after the event commits.
- [x] Task 7: REST surface (AC: 1, 2, 3, 4, 5)
  - [x] 7.1 Add the nine new handlers listed in the API Contract to `src/api/v1/maintenance.ts`, each wrapped in `requireRole({ module: 'maintenance', functionScope: ... })`.
  - [x] 7.2 Extend the existing `completeWorkOrderBase` handler to accept optional `labor_cost` and `parts_cost` fields (NUMERIC strings). Validate with `NUMERIC_REGEX`. Pass through to `persistEvent`; the applier derives `total_cost` and `capitalization_flagged`.
  - [x] 7.3 Register all nine new routes in `createAppRouter` in `src/server.ts`, static segments before parameter segments, and confirm no collision with existing routes.
  - [x] 7.4 Add all nine new routes to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
- [x] Task 8: Tests (AC: 1, 2, 3, 4, 5)
  - [x] 8.1 Create `test/integration/story-7-6.test.ts` bootstrapped exactly as `test/integration/story-7-5.test.ts`.
  - [x] 8.2 One failing-first test per acceptance criterion, plus one test per error code in the Error Code Contract.
  - [x] 8.3 A replay test per write route asserting the same resource returns and the `domain_events` count does not grow.
  - [x] 8.4 The three lockout-integrity tests named in the Testing Requirements: (1) overdue statutory blocks return-to-service end to end; (2) weighbridge out of stamp blocks weighment; (3) re-stamp unblocks.
  - [x] 8.5 A cost accumulation test: closure with labor + parts accumulates per asset, capitalization flag at threshold (exact boundary: equal - not flagged; strictly greater - flagged), NUMERIC exactness (no float), story-7-2 regression (existing completions without cost still pass).
  - [x] 8.6 A status broadcast test: status change emits notification, fan-out resolves to at least one real recipient for both `production_planner` and `hub_booking_coordinator` roles (provisioned in harness).
  - [x] 8.7 A concurrency test per new unique index asserting the race path returns the SAME error code and the same `existing_*` detail as the sequential path.
  - [x] 8.8 Regression: Stories 1.7, 1.9, 7.1-7.5 suites pass unchanged. Weighbridge stories 3.2-3.4 pass unchanged (the new assert is fail-open for unknown device keys).
- [x] Task 9: Ledger entries (AC: 1, 2, 3, 4, 5)
  - [x] 9.1 Log the out-of-scope items named in Binding Scope Decisions to `_bmad-output/implementation-artifacts/deferred-work.md` under a Story 7.6 heading.

### Review Findings

Code review of 2026-08-25, Group A slice (schema, seams, events) over baseline `e93014f` working tree. Adversarial pass with Blind Hunter, Edge Case Hunter and Acceptance Auditor; all three layers returned findings and none failed. Groups B (read, API, jobs) and C (integration tests) are reviewed separately.

- [x] [Review][Patch] AC1 statutory use-lock placement contradicts AD-12 (decision resolved: close the bypass in the seam) - Task 5.2 puts the overdue-examination lock in `setAssetStatusBase`, but AD-12 (line 298) requires the statutory lockout in `persistEvent` pre-transaction. `applyAssetOperationalStatusProjection` reads no statutory row, so `POST /api/v1/events` with `maintenance.asset_status_changed` moves a statutorily locked asset to `running` [src/compliance/asset-operational-status.ts:142-283, src/api/v1/maintenance.ts:3528]
- [x] [Review][Patch] Re-stamp identity (decision resolved: the evidence record follows the register row's examination_id, handler read-back resolves by grain on the re-stamp path): the register row keeps its original `examination_id` but the evidence record is inserted under the payload's freshly minted id, so the record is orphaned, `listRecordsByExamination` never shows the re-stamp, `uq_statutory_examination_record_number` cannot fire across re-stamps, and the 201 body returns `examination: null` [src/compliance/maintenance-statutory.ts:332-372, src/api/v1/maintenance.ts:3327]
- [x] [Review][Patch] Weighbridge lockout looks up the register with the raw, untrimmed `device_id`; the register stores a trimmed and lowercased `device_key` and the lookup does not trim, so a leading space fails the lookup open [src/compliance/weighbridge.ts:73-80]
- [x] [Review][Patch] `applyStatutoryExaminationRecorded` calls `getAssetById`, which takes no `FOR UPDATE`, so the Locking Contract step-1 asset lock its own comment claims is never taken and a concurrent `work_order_completed` stamp flip does not serialize against a first registration [src/compliance/maintenance-statutory.ts:265-267]
- [x] [Review][Patch] A re-stamp that omits `device_key` writes NULL over the register's device mapping, permanently failing the AC2 weighbridge lockout open for that device [src/compliance/maintenance-statutory.ts:332-341]
- [x] [Review][Patch] `total_cost` and `capitalization_flagged` are persisted unchecked when neither `labor_cost` nor `parts_cost` is present, because the whole derivation block is gated on `hasCostFields` [src/compliance/maintenance-plan.ts:664-735]
- [x] [Review][Patch] The seam never writes the canonicalized `device_key` and `certificate_number_ext` back onto the payload, so the direct-event path persists mixed-case values while the projection holds the lowered form, against the Compliance Seam Contract [src/compliance/maintenance-statutory.ts:256-261]
- [x] [Review][Patch] Declared `total_cost` is compared to the derived value as a JS string, so a numerically identical value at a different scale rejects 409 `COST_DERIVATION_MISMATCH` [src/compliance/maintenance-plan.ts:676-690]
- [x] [Review][Patch] `hasCostFields` is true for an explicit `null`, producing a phantom zero-cost `maintenance_asset_cost` row and moving the last-closure pointer [src/compliance/maintenance-plan.ts:664]
- [x] [Review][Patch] A missing sign-off on the seam path rejects 409 `COST_DERIVATION_MISMATCH` instead of AC5's 403 `APPROVAL_REQUIRED`; only a forged sign-off is specified as 409 [src/compliance/asset-operational-status.ts:226-237]
- [x] [Review][Patch] PostgreSQL `22003` numeric overflow is unmapped, so a cost sum wider than `NUMERIC(14,3)` (two 11-digit inputs, or an accumulating asset rollup) surfaces as a 500 [src/compliance/maintenance-plan.ts:49, src/events/store.ts]
- [x] [Review][Patch] `getExaminationByDeviceKey` does not filter on `examination_type`, so an `osh_code` examination can occupy a weighbridge device key and lock trade weighment on a validly stamped weighbridge [src/read/projections/statutory_examination.ts:155-169]
- [x] [Review][Patch] The four `maintenance_work_order` ADD COLUMN guards match on `table_name` alone with no `table_schema`, so a same-named table in another schema makes the guard skip the real ALTER [deploy/compose/init-db.sql, read/projections/maintenance_work_order.sql]
- [x] [Review][Patch] The schema-drift guard compares CREATE TABLE bodies, named constraints, indexes and grants only, so drift in the four additive cost columns ships green [test/unit/schema-drift.test.ts:898]
- [x] [Review][Patch] `upsertMaintenanceAssetCost` overwrites `last_closed_at` and `last_work_order_id` unconditionally, so an out-of-order completion moves the most-recent-closure pointer backwards [src/read/projections/maintenance_asset_cost.ts:56-62]
- [x] [Review][Patch] The statutory projection header claims the register is rebuildable by replaying the two statutory event types, but the Binding Decision 6 stamp flip writes the status with no event [read/projections/statutory_examination.sql, src/compliance/maintenance-plan.ts:737]
- [x] [Review][Defer] `resolveApprover` acquires a second pool connection inside the applier's open transaction and reads DOA state outside the transaction snapshot [src/compliance/asset-operational-status.ts:217] - deferred, pre-existing
- [x] [Review][Defer] An uppercase-but-canonical UUID in a payload fails every re-derivation comparison, because PostgreSQL renders `uuid` columns lowercase while the shape validators accept either case [src/compliance/asset-operational-status.ts:182, src/compliance/maintenance-statutory.ts:404] - deferred, pre-existing
- [x] [Review][Defer] The 423 lockout runs ahead of the idempotency replay short-circuit, so a retry of an already-persisted weighment rejects instead of returning the stored event [src/events/store.ts:436] - deferred, pre-existing
- [x] [Review][Defer] `findRoleHolder` returns only the earliest-assigned holder, so a second equally authorized supervisor cannot sign off a return to service [src/read/projections/doa_registry.ts:302] - deferred, pre-existing

### Review Findings, Group B

Code review of 2026-08-26, Group B slice (read projections, REST API, jobs) over the post-Group-A working tree. Adversarial pass with Blind Hunter, Edge Case Hunter and Acceptance Auditor; all three layers returned findings and none failed. Group C (integration tests) is reviewed separately.

- [x] [Review][Patch] Overdue scan notification target (decision resolved: target every maintenance_supervisor with location_id null) - the scan emits to `{ role: 'maintenance_supervisor', location_id: scope.actor.location_id }`, so a scan run from one location silently reaches no supervisor at any other location while still counting as delivered; `location_id: null` targets every holder of the role, which is what the Notification Contract's `<asset location>` intends given AD-9 leaves assets with no location column [src/maintenance/statutory-jobs.ts:167]
- [x] [Review][Patch] AC1 lock scope (decision resolved: block only transitions into running) - the 423 `STATUTORY_EXAMINATION_OVERDUE` fires ahead of the transition table for EVERY `new_status`, so a locked asset cannot be recorded as `maintenance` or `breakdown` while the re-examination is performed, and the AC4 broadcast that would tell planning to stop scheduling it never fires [src/api/v1/maintenance.ts:3537, src/compliance/asset-operational-status.ts]
- [x] [Review][Patch] AC5 sign-off gate is two hops wide (decision resolved: require sign-off for any transition into running) - Table 5 requires sign-off only on `breakdown|running` and `maintenance|running`, and permits `breakdown -> idle` and `idle -> running`, so two ordinary writes return a broken machine to service with `sign_off_by` null and no DOA approver resolved [src/api/v1/maintenance.ts:2611-2618, src/compliance/asset-operational-status.ts:48-58]
- [x] [Review][Patch] The four Story 7.6 cost columns have no read surface: `MaintenanceWorkOrderRow` and `WORK_ORDER_COLUMNS` were never extended, so the completion response and both work-order GETs omit `total_cost` and the server-derived `capitalization_flagged` entirely [src/read/projections/maintenance_work_order.ts:5-43]
- [x] [Review][Patch] The AC4 broadcast discards both `emitNotification` results and gates the pair on one correlation-id marker, so a first-succeeds/second-fails emission is permanently unrecoverable and the 200 response cannot distinguish it from success [src/api/v1/maintenance.ts:3634-3656]
- [x] [Review][Patch] The re-stamp read-back fallback keys off the REQUEST BODY's `asset_id` and `examination_type` rather than the persisted payload's, so an idempotency-key replay carrying a different asset returns a 201 built from a foreign register row [src/api/v1/maintenance.ts:3409]
- [x] [Review][Patch] `certificate_number_ext` is canonicalized in the seam only; the Compliance Seam Contract requires `lower()` in the handler AND the seam, and the sibling `device_key` already is [src/api/v1/maintenance.ts:3357]
- [x] [Review][Patch] `listOverdueExaminationsDue` has no UUID guard on `asset_id` and no calendar guard on `business_date`, unlike every sibling accessor in the same file, so a bad value from any non-route caller is an unmapped 22P02/22007 500 [src/read/projections/statutory_examination.ts:219-232]
- [x] [Review][Patch] The scan's post-commit work sits outside the try: a throw from `getAssetById` or a non-duplicate AppError aborts the whole run after flips have already committed, returning a bodyless 500 and losing `overdue_examination_ids` and both counters [src/maintenance/statutory-jobs.ts:159-165]
- [x] [Review][Patch] `offset` is floored at 0 but never capped, so `?offset=99999999999999999999` reaches PostgreSQL as a value outside `bigint` and the read endpoint 500s [src/read/projections/statutory_examination.ts:206, src/read/projections/asset_operational_status.ts:92, src/read/projections/maintenance_asset_cost.ts:105]
- [x] [Review][Patch] The status vocabulary, the DOA transaction type and both transition tables are duplicated byte-for-byte between the handler and the seam, so widening one and not the other makes the pre-check and the enforcement disagree [src/api/v1/maintenance.ts:2602-2618, src/compliance/asset-operational-status.ts:43-58]
- [x] [Review][Defer] The scan's `business_date` is validated for calendar form only, so a typo such as `2999-01-01` flips every compliant examination in the register to overdue in one call [src/api/v1/maintenance.ts:3486] - deferred, pre-existing
- [x] [Review][Defer] The scan loop is unbounded: `listOverdueExaminationsDue` takes no LIMIT and the loop opens one connection and transaction per row inside a single HTTP request [src/maintenance/statutory-jobs.ts:108-114] - deferred, pre-existing
- [x] [Review][Defer] `APPROVAL_UNRESOLVED` carries 404 from the handler and 409 from `resolveApprover`, so a client cannot branch on status for one error code [src/api/v1/maintenance.ts:3578, src/api/v1/indents.ts:96] - deferred, pre-existing
- [x] [Review][Defer] The broadcast dedup evaluates `metadata->>'correlation_id'` over every `notification.created` row with no supporting index, on every asset status change [src/api/v1/maintenance.ts:3634] - deferred, pre-existing
- [x] [Review][Defer] The per-asset cost rollup accumulates into `NUMERIC(14,3)` with no ceiling, so once an asset's running total overflows, every later completion on that asset fails permanently [src/read/projections/maintenance_asset_cost.ts] - deferred, pre-existing

### Review Findings, Group C

Code review of 2026-08-26, Group C slice (integration tests) over the post-Group-B working tree. Adversarial pass with Blind Hunter, Edge Case Hunter and Acceptance Auditor; all three layers returned findings and none failed. The subject under review is the test code itself. Note that 13 tests and 2 amendments in this suite came from the Group A and Group B passes, so this is not a clean-room audit of the original author's coverage; they were reviewed to the same standard.

- [x] [Review][Patch] The status-replay test's setup call is unasserted and now fails silently: `await setStatus(assetId, 'running')` runs before any DOA entry exists, so under the Group B sign-off widening it returns 404 and the intermediate transition the test depends on never happens [test/integration/story-7-6.test.ts:1082]
- [x] [Review][Patch] Mandatory lockout test 2 never asserts the weighment was not persisted and test 3 never asserts it was: `weighbridge_event` is not read anywhere in the suite outside the TRUNCATE, though the Testing Requirements name that assertion separately from the event-count one [test/integration/story-7-6.test.ts:792, :834]
- [x] [Review][Patch] AC5's "the asset remains out of service" clause is never asserted on any 403 path: all three sign-off rejection tests assert the rejection and stop, without reading the status back or asserting no `maintenance.asset_status_changed` was written [test/integration/story-7-6.test.ts:1102, :1650, :1595]
- [x] [Review][Patch] Three unrelated negative tests assert the catch-all `COST_DERIVATION_MISMATCH` with no `details`, and the seam raises that code from six distinct branches, so each test passes if the event is refused for a reason other than the one it names [test/integration/story-7-6.test.ts:1162, :1197, :1338]
- [x] [Review][Patch] One `scan()` call omits `asset_id` and sweeps the whole register mid-file, flipping every still-compliant examination other tests left behind and emitting their notifications [test/integration/story-7-6.test.ts:800]
- [x] [Review][Patch] The DOA-ordering dependency between the 404 and 403 return-to-service tests is load-bearing and only documented in a comment, so a reorder or a name filter turns a passing test into a different failure [test/integration/story-7-6.test.ts:1098, :1112]
- [x] [Review][Patch] `notificationFor` returns `rows[0]` with no count, so every "the notification exists" assertion admits an unbounded number of duplicates; a regression that fans out twice ships green [test/integration/story-7-6.test.ts:320]
- [x] [Review][Patch] The capitalization boundary test hardcodes 50000 while the threshold is env-configurable, so it stops proving the strict-greater-than boundary the moment `MAINTENANCE_CAPITALIZATION_THRESHOLD` changes [test/integration/story-7-6.test.ts:926]
- [x] [Review][Patch] Task 8.3 is only nominally met: neither replay test asserts the returned resource or that the `domain_events` count did not grow, and the scan write route has no replay test at all [test/integration/story-7-6.test.ts:1077, :982]
- [x] [Review][Patch] Task 8.7 is unmet for `uq_statutory_examination_record_number` (no duplicate test of any kind) and `DUPLICATE_STATUTORY_EXAMINATION_OVERDUE` from Table 9 is never provoked, so the scan's skip-on-lost-race is untested [test/integration/story-7-6.test.ts]
- [x] [Review][Patch] The Notification Contract's fixed `next_step` and `actor_label` are selected by the helper and never asserted, so emitting a raw id as the subject or the wrong next step ships green [test/integration/story-7-6.test.ts:353, :1043, :649]
- [x] [Review][Patch] Follow-on found by the new certificate-number test: `resolveStatutoryRecordDuplicateConflict` resolved the record grain with the PAYLOAD's examination_id, so on a re-stamp collision it looked up a grain no record was ever written under and reported no existing record [src/compliance/maintenance-statutory.ts resolveStatutoryRecordDuplicateConflict]
- [x] [Review][Defer] No RBAC negative path on any of the nine new routes: every write uses supervisor headers and the only 403s asserted are the DOA business rule [test/integration/story-7-6.test.ts] - deferred, pre-existing
- [x] [Review][Defer] The concurrency tests cannot reach the 23505 race path they name, because the Locking Contract's step-1 asset lock serializes both attempts into the sequential pre-check [test/integration/story-7-6.test.ts:1257, :1305] - deferred, pre-existing
- [x] [Review][Defer] Work orders are hand-inserted into the projection table with a phantom `plan_id`, so every cost test completes a work order the generation seam never produced [test/integration/story-7-6.test.ts:251] - deferred, pre-existing
- [x] [Review][Defer] Ten `persistEvent(... as any)` casts disable the compile-time envelope contract in exactly the forgery tests that exist to defend it [test/integration/story-7-6.test.ts] - deferred, pre-existing
- [x] [Review][Defer] `OVERDUE_SCAN_DATE` is a hardcoded future date and the weighbridge fixtures pin 2026 dates against `now()`, so fixture rows are internally inconsistent and the gap widens over time [test/integration/story-7-6.test.ts:139, :375] - deferred, pre-existing
- [x] [Review][Defer] The Spine allowlist widening asserts membership only: `src/server.ts` documents a load-bearing route order that a `.sort()`ed `deepStrictEqual` cannot catch [test/integration/story-1-9.test.ts:451] - deferred, pre-existing

## Dev Notes

### Binding Scope Decisions

1. **The weighbridge lockout is a pre-transaction, DB-backed assert in `persistEvent`.** `src/compliance/weighbridge.ts` gains `assertWeighbridgeStampLockout(envelope, deps)` mirroring `assertCalibrationLockout` in `src/compliance/calibration.ts`. It is called from `src/events/store.ts` in the pre-transaction assert block for `stream_type === 'weighbridge' && event_type === 'weighbridge.recorded'`. It resolves the weighbridge identity from `payload.device_id` via `getExaminationByDeviceKey` and throws `423 WEIGHBRIDGE_OUT_OF_STAMP` if the statutory examination status is `overdue`. Fail-open for device keys not in the register (no statutory examination row for that device - the device is not governed). This is the exact pattern of `CALIBRATION_LOCKOUT` (423) in `src/compliance/calibration.ts`.
2. **The cost extension rides on the existing `maintenance.work_order_completed` event additively.** The existing payload interface gains optional `labor_cost`, `parts_cost` fields (NUMERIC strings). The applier derives `total_cost` and `capitalization_flagged` server-side and writes them back onto the persisted payload. Existing 7.2 test payloads with no cost fields still pass (costs default to 0). This is the 4.5 three-way-match precedent: server-computed results are written back onto the payload.
3. **The status broadcast is the Story 1.11 notification foundation.** The `maintenance.asset_status_changed` event triggers a notification to `production_planner` and `hub_booking_coordinator` roles. The notification service's async dispatcher (config.notify.dispatchIntervalMs default 5000ms) delivers within 2 minutes. The story asserts the notification event was persisted and fan-out resolves to recipients; the "within 2 minutes" is satisfied by the notification foundation's cadence.
4. **Return-to-service authority is DOA-resolved.** The handler resolves the approver via `resolveApprover('maintenance.return_to_service', 0)` and checks the acting user is the resolved approver. If not, reject `403 APPROVAL_REQUIRED` per AC5. The access matrix assigns the capability to `maintenance_supervisor` role; the DOA entry role for `maintenance.return_to_service` is seeded as `maintenance_supervisor`.
5. **The statutory examination register is keyed by (asset_id, examination_type).** Every statutory subject is an asset per AD-9. The weighbridge device_id (free text on `weighbridge_event`) is mapped via `device_key` on the statutory examination row (case-insensitive `lower()` canonicalization). The lockout assert resolves the weighbridge identity from `payload.device_id` and looks up the statutory examination by `lower(device_key)`.
6. **A completed work order on a weighbridge asset invalidates the stamp.** The `maintenance.work_order_completed` applier checks if the asset has a `weighbridge_legal_metrology` statutory examination and, if so, flips its status to `overdue` (re-stamp required). This is the "repaired weighbridges block trade weighment" rule (AC2). Conservative Phase-1: any completed work order on a weighbridge asset invalidates the stamp (fail-closed for trade weighment integrity).
7. **The capitalization threshold is a NUMERIC string, not a JS float.** `config.maintenance.capitalizationThreshold` is parsed from env `MAINTENANCE_CAPITALIZATION_THRESHOLD` as a NUMERIC string with regex validation (`^\d{1,12}(\.\d{1,6})?$`), defaulting to `'50000'`. Store as string; compare in SQL with `::numeric`. This avoids JS float round-trip errors. The comparison is strictly greater than: `total_cost::numeric > $threshold::numeric` - equal to threshold is NOT flagged.
8. **The statutory scan is a POST-triggered job with an explicit `business_date`, NOT cron.** This is the codebase-wide convention (`runSafetyStockComputation`, `runReplenishmentCheck`, `runObsolescenceScan`, `runPmGeneration`, `runGraceWindowSweep`, `runCriticalSpareBreachScan`, `runCalibrationExpiryScan`). The only `setInterval` in the process is the Story 1.11 notification dispatcher. Do NOT add `node-cron`, a timer or a container.
9. **No staged pre-due alerts in 7.6.** The story was rescoped to remove grab-bag items (sprint-change-proposal line 3033). The ACs require lockout when overdue (AC1) and weighbridge block (AC2), not staged alerts. The overdue flip emits an escalating notification (escalation window 5 minutes per Story 1.11 convention). Adding 30/14/7 day alerts would be scope creep.
10. **Out of scope, log each to `deferred-work.md`:** routing of above-threshold repair-vs-capitalize flagged work orders into the FR-FA capitalization queue (Phase 2 Epic 17), offline technician workflows and closure codes (Story 7.8), staged pre-due statutory examination alerts, statutory examination work orders on `maintenance_work_order` (no AC ties statutory examinations to the Story 7.2 work-order tree), extending the lockout to measurement write paths beyond `weighbridge.recorded` and return-to-service (every Epic 8 QC path lands on the existing Story 7.5 calibration gate for free), and statutory examination document or PDF attachment storage (no attachment service exists in Phase 1).

### Event Contract

Table 1 lists the three new events. All three are on the `maintenance` stream with `requiresBusinessStream: false`.

| **Event type** | **Key payload fields** | **Projection effect** |
| --- | --- | --- |
| `maintenance.statutory_examination_recorded` | `examination_id`, `asset_id`, `examination_type`, `interval_months`, `examined_on`, `next_due_date`, `certificate_number_ext?`, `device_key?`, `business_date`, `recorded_at` | Inserts or updates one `statutory_examination` row (status `compliant`, `next_due_date` re-derived), inserts one `statutory_examination_record` row |
| `maintenance.statutory_examination_overdue` | `examination_id`, `asset_id`, `examination_type`, `next_due_date`, `business_date`, `flagged_at` | Flips `statutory_examination.status` to `overdue` |
| `maintenance.asset_status_changed` | `asset_id`, `previous_status`, `new_status`, `changed_by`, `changed_at`, `sign_off_by?`, `sign_off_at?` | Upserts `asset_operational_status` |

The existing `maintenance.work_order_completed` event is extended additively: the payload gains optional `labor_cost`, `parts_cost` fields (NUMERIC strings). The applier derives `total_cost` and `capitalization_flagged` server-side and writes them back onto the persisted payload.

Every payload field that the applier can derive from a locked row is DECLARED in the payload and CHECKED against the derivation, never trusted. Divergence rejects with `STATUTORY_DERIVATION_MISMATCH` 409 or `COST_DERIVATION_MISMATCH` 409. This is the Story 7.2 Group 2 decision, the Story 7.3 `WORK_ORDER_DERIVATION_MISMATCH` pattern and the Story 7.4 review High finding on forged alerts, applied unchanged: a declared-but-unchecked field is a silent corruption channel on the direct `POST /api/v1/events` path.

`maintenance.statutory_examination_recorded` and `maintenance.asset_status_changed` are the highest-risk appliers in this story. Both must re-derive `next_due_date` and the state machine transition from locked rows and reject a payload that disagrees. A forged `statutory_examination_recorded` that occupies the `(asset_id, examination_type)` grain would suppress the genuine lockout; a forged `asset_status_changed` with a fabricated `sign_off_by` would bypass the return-to-service gate.

### Locking Contract

Every applier that mutates more than one row takes `SELECT ... FOR UPDATE` in this FIXED order, so two concurrent commands on the same asset can never deadlock: asset, then statutory examination row (if applicable), then statutory examination record row (if applicable), then asset operational status row, then maintenance asset cost row, then maintenance work order row (if applicable). The applier must not touch any row outside this order.

### Statutory Examination Contract

Table 2 defines the statutory examination state machine. Any transition not listed rejects; no applier silently no-ops on a state it should reject, per the Story 7.2 Group 2 decision.

| **From state** | **Command** | **To state** | **Lockout effect** |
| --- | --- | --- | --- |
| (none) | record examination | `compliant` | NONE (asset unlocked) |
| `compliant` | overdue scan | `overdue` | Asset locked (AC1) |
| `overdue` | record examination (re-stamp) | `compliant` | Asset unlocked |
| `compliant` | work order completed (weighbridge) | `overdue` | Asset locked (AC2) |
| `overdue` | any | rejects `EXAMINATION_ALREADY_OVERDUE` | NONE |

Preconditions, all checked under the lock: the asset exists (`ASSET_NOT_FOUND` 404); the examination type is valid (`INVALID_EXAMINATION_TYPE` 400); the interval is valid (`INVALID_INTERVAL` 400); the `examined_on` date is valid (`DATE_REGEX`); the `next_due_date` is re-derived as `examined_on + interval_months` in SQL and checked against the declared value (`STATUTORY_DERIVATION_MISMATCH` 409). Recording an ALREADY-OVERDUE examination is rejected `422 EXAMINATION_ALREADY_OVERDUE`, not silently accepted. A certificate whose `examined_on` is after `business_date` is rejected `422 EXAMINATION_FUTURE_DATE`.

The scan holds the examination row under `FOR UPDATE` for the duration of its grain so two concurrent scans serialize into one overdue flip, and `DUPLICATE_STATUTORY_EXAMINATION_OVERDUE` from the unique index is caught and skipped so one lost race cannot fail a whole scan. This is the Story 7.5 breach-scan pattern applied unchanged.

`business_date` is the ONLY notion of "today" inside the job, per the `src/maintenance/pm-jobs.ts` header. Wall-clock time is used solely for `flagged_at`, which is a TIMESTAMPTZ instant with explicit offset. Derive any calendar date from an instant with `toIstCalendarDate`, never with a bare `slice(0, 10)` on an ISO string: the repo has a live, documented family of clock-window failures from exactly that shortcut.

### Weighbridge Lockout Contract

Table 3 defines the weighbridge lockout. The lockout is enforced on `weighbridge.recorded` events via `assertWeighbridgeStampLockout` in `src/compliance/weighbridge.ts`.

| **Weighbridge status** | **Weighment attempt** | **Result** |
| --- | --- | --- |
| No statutory examination row for `device_key` | Any | Allowed (fail-open, device not governed) |
| `compliant` | Any | Allowed |
| `overdue` | Any | Rejected `423 WEIGHBRIDGE_OUT_OF_STAMP` |

The lockout is fail-open for device keys not in the register. This is the Story 7.5 lesson: unregistered instrument ids keep Story 1.7 behavior exactly. The lockout assert must not break existing weighbridge tests (story-3-2, story-3-3, story-3-4) that do not register weighbridge stamps.

The lockout is enforced pre-transaction in `persistEvent`, not in the HTTP handler. This closes the direct-event and edge upload bypass paths. The edge upload path (`src/api/v1/edge.ts`) converges on `persistEvent`, so the lockout applies uniformly.

### Cost Accumulation Contract

Table 4 defines the cost accumulation. Costs are captured at work order closure via the additive extension to `maintenance.work_order_completed`.

| **Input** | **Derivation** | **Storage** |
| --- | --- | --- |
| `labor_cost` (NUMERIC string, optional) | Operator-entered | `maintenance_work_order.labor_cost` |
| `parts_cost` (NUMERIC string, optional) | Operator-entered | `maintenance_work_order.parts_cost` |
| `total_cost` | `labor_cost + parts_cost` in SQL NUMERIC | `maintenance_work_order.total_cost` |
| `capitalization_flagged` | `total_cost::numeric > config.maintenance.capitalizationThreshold::numeric` | `maintenance_work_order.capitalization_flagged` |
| Per-asset rollup | `SUM(labor_cost)`, `SUM(parts_cost)`, `SUM(total_cost)` across all completed work orders for the asset | `maintenance_asset_cost` |

All arithmetic runs in PostgreSQL NUMERIC; costs enter and leave as exact decimal strings; never converted to JS float. This is the Story 5.6 BOM cost rollup pattern. The applier derives `total_cost` and `capitalization_flagged` server-side and writes them back onto the persisted payload. The per-asset rollup is updated via `upsertMaintenanceAssetCost` which ADDs the new costs to the existing totals.

Existing 7.2 test payloads with no cost fields still pass (costs default to 0). The applier checks if the cost fields are present; if not, it skips the cost path. This is the additive extension pattern: existing behavior unchanged, new behavior opt-in.

The capitalization threshold comparison is strictly greater than: `total_cost::numeric > $threshold::numeric`. Equal to threshold is NOT flagged. This is the "exceeds the configured capitalization threshold" wording in AC3.

### Machine Status Contract

Table 5 defines the machine status state machine. Any transition not listed rejects; no applier silently no-ops on a state it should reject, per the Story 7.2 Group 2 decision.

| **From state** | **Command** | **To state** | **Sign-off required** |
| --- | --- | --- | --- |
| (none) | set status | `idle` | NONE |
| `idle` | set status | `running` | YES (AC5) |
| `idle` | set status | `breakdown` | NONE |
| `idle` | set status | `maintenance` | NONE |
| `running` | set status | `idle` | NONE |
| `running` | set status | `breakdown` | NONE |
| `running` | set status | `maintenance` | NONE |
| `breakdown` | set status | `idle` | NONE |
| `breakdown` | set status | `maintenance` | NONE |
| `breakdown` | set status | `running` | YES (AC5) |
| `maintenance` | set status | `idle` | NONE |
| `maintenance` | set status | `breakdown` | NONE |
| `maintenance` | set status | `running` | YES (AC5) |

Sign-off is required on ANY transition into `running`, not only from `breakdown` and `maintenance`. Requiring it on the two named rows alone left `breakdown -> idle -> running` as two ordinary writes that returned a broken machine to service with `sign_off_by` null and no DOA approver resolved (code review of 2026-08-26, Group B).

The AC1 statutory use-lock is likewise scoped to transitions into `running`. An asset whose examination has lapsed is locked from USE, not frozen: it must still be recordable as `maintenance` or `breakdown` while the re-examination is performed, and the AC4 broadcast that tells production planning and hub booking to stop scheduling it must still fire.

Return-to-service (transition to `running` from `breakdown` or `maintenance`) requires a supervisor sign-off. The handler resolves the DOA approver via `resolveApprover('maintenance.return_to_service', 0)` and checks the acting user is the resolved approver. If not, reject `403 APPROVAL_REQUIRED` per AC5. The applier re-derives the sign-off fields under lock and writes them back onto the persisted payload.

The status change also checks the asset's statutory examination status. If any statutory examination row for the asset is `overdue`, reject `423 STATUTORY_EXAMINATION_OVERDUE` (AC1 enforcement). This is the "asset is locked from use until re-examined" rule.

### Return-to-Service Contract

Table 6 defines the return-to-service authority. The handler resolves the DOA approver via `resolveApprover('maintenance.return_to_service', 0)` (exported from `src/api/v1/indents.ts:66`, returns `{ requiresApproval, approverActorId, doaEntryId }`) and checks the acting user's `user_id` against the resolved `approverActorId`.

| **Acting user** | **DOA resolution** | **Result** |
| --- | --- | --- |
| Resolved approver | `approval.approverActorId === actor.userId` | Allowed |
| Not resolved approver | `approval.approverActorId` is a different user | Rejected `403 APPROVAL_REQUIRED` |
| No DOA entry | `approval.approverActorId` is null | Rejected `404 APPROVAL_UNRESOLVED` |

The DOA entry role for `maintenance.return_to_service` is seeded as `maintenance_supervisor` (access matrix). The handler checks the acting user's `user_id` against the resolved approver's `user_id`. The applier re-derives the sign-off fields under lock and writes them back onto the persisted payload. A forged `sign_off_by` in the payload is rejected `409 COST_DERIVATION_MISMATCH` (or `STATUTORY_DERIVATION_MISMATCH` for statutory fields).

### Database Schema Contract

Every new `.sql` file follows the shape of `read/projections/instrument_register.sql` exactly: the canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks for self-healing, `CREATE INDEX IF NOT EXISTS`, and a guarded grants block that checks `pg_roles` before granting. Every statement must be safely re-appliable to a live database. Rows are derived state only: mutation happens exclusively through `persistEvent`, which applies the projection inside the SAME transaction as the `domain_events` insert.

Table 7 lists the required tables, grains and named constraints.

| **Table** | **Grain and key constraints** |
| --- | --- |
| `statutory_examination` | `examination_id UUID PRIMARY KEY`; `uq_statutory_examination_asset_type UNIQUE (asset_id, examination_type)`; `uq_statutory_examination_device_key UNIQUE INDEX (lower(device_key)) WHERE device_key IS NOT NULL`; `chk_statutory_examination_type CHECK (examination_type IN ('osh_code','weighbridge_legal_metrology'))`; `chk_statutory_examination_status CHECK (status IN ('compliant','overdue'))`; `chk_statutory_examination_interval CHECK (interval_months > 0 AND interval_months <= 120)`; `idx_statutory_examination_status_due (status, next_due_date)` |
| `statutory_examination_record` | `record_id UUID PRIMARY KEY`; `chk_statutory_examination_record_dates CHECK (next_due_date >= examined_on)`; `uq_statutory_examination_record_number UNIQUE INDEX (examination_id, lower(certificate_number_ext)) WHERE certificate_number_ext IS NOT NULL`; `idx_statutory_examination_record_examination (examination_id)` |
| `asset_operational_status` | `asset_id UUID PRIMARY KEY`; `chk_asset_operational_status CHECK (status IN ('running','idle','breakdown','maintenance'))` |
| `maintenance_asset_cost` | `asset_id UUID PRIMARY KEY`; `chk_maintenance_asset_cost_labor_non_negative CHECK (total_labor_cost >= 0)`; `chk_maintenance_asset_cost_parts_non_negative CHECK (total_parts_cost >= 0)`; `chk_maintenance_asset_cost_total_non_negative CHECK (total_cost >= 0)` |
| `maintenance_work_order` (extension) | Additive columns: `labor_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `parts_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `total_cost NUMERIC(14,3) NOT NULL DEFAULT 0`, `capitalization_flagged BOOLEAN NOT NULL DEFAULT false`; constraints: `chk_maintenance_work_order_labor_non_negative`, `chk_maintenance_work_order_parts_non_negative`, `chk_maintenance_work_order_total_non_negative` |

All calendar fields (`examined_on`, `next_due_date`, `business_date`) are `DATE`; all instants (`recorded_at`, `examined_at`, `flagged_at`, `changed_at`, `sign_off_at`) are `TIMESTAMPTZ`. Cost fields are `NUMERIC(14,3)`. There are no other NUMERIC quantities in this story.

Known gate limitation, carried from the 7.2 Group 1 review and re-confirmed by the 7.3 review: the schema-drift test compares init-db against canonical and checks that named constraints and indexes EXIST by name, but it cannot detect an extra constraint added only to a CREATE body and it ignores statement ordering. Keep the canonical file and the init-db mirror literally identical for the new blocks rather than relying on the gate.

### Compliance Seam Contract

`src/compliance/maintenance-statutory.ts` follows `src/compliance/calibration-register.ts` structurally:

- A stream gate returning null for non-`maintenance` streams so the seam never sees a foreign event.
- A PURE `assertStatutoryExaminationShape(envelope)` that runs pre-transaction with no database access, so a malformed event never consumes an idempotency key. It validates every declared payload field, every UUID, every enum, every DATE against `DATE_REGEX`, every integer bound and every timestamp format. An explicit UTC offset is REQUIRED on every TIMESTAMPTZ input, per the 7.2 offset lesson.
- An `applyStatutoryExaminationProjection(envelope, client)` switch whose branches run inside `persistEvent`'s transaction and honor the Locking Contract.
- The same `alreadyPersisted` guard and the same `reject(code, message, details, status)` AppError helper, copied verbatim rather than re-derived.
- `device_key` and `certificate_number_ext` are canonicalized with `lower()` on every human-entered path before lookup and before persisting, in the handler AND in the seam so the direct-event path cannot bypass it.
- No applier emits a notification, writes outside its transaction, or silently no-ops on a state it should reject.

`src/compliance/asset-operational-status.ts` follows the same structure. The applier validates the state machine transition (Table 5), resolves the DOA approver for return-to-service under lock, writes sign-off fields back onto the persisted payload, and upserts `asset_operational_status`.

`src/compliance/weighbridge.ts` gains `assertWeighbridgeStampLockout(envelope, deps)` mirroring `assertCalibrationLockout` in `src/compliance/calibration.ts`. The function is an async, DB-backed pre-transaction gate called from `persistEvent` in `src/events/store.ts` for `stream_type === 'weighbridge' && event_type === 'weighbridge.recorded'`. It resolves the weighbridge identity from `payload.device_id` via `getExaminationByDeviceKey` and throws `423 WEIGHBRIDGE_OUT_OF_STAMP` if the statutory examination status is `overdue`. Fail-open for device keys not in the register.

`src/compliance/maintenance-plan.ts` is extended to handle the additive cost fields on `maintenance.work_order_completed`. The existing `applyMaintenancePlanProjection` switch gains a branch for `maintenance.work_order_completed` that calls `setWorkOrderCosts` and `upsertMaintenanceAssetCost` when cost fields are present. The applier also checks if the asset has a `weighbridge_legal_metrology` statutory examination and, if so, flips its status to `overdue` (the "repair invalidates stamp" rule per Binding Decision 6).

### Notification Contract

Two emissions, both through `emitNotification` in `src/notify/emit.ts`, both AFTER their event commits, all non-throwing. None is an approval decision, so none takes the transactional entry point (AD-17).

- Overdue flip (AC1): `event_type: 'statutory_examination_overdue'`, `status_verb: 'Overdue'`, `object_type: 'statutory_examination'`, `object_id: <examination_id>`, target `{ role: 'maintenance_supervisor', location_id: <asset location> }`, `actor_label` naming the asset tag and the examination type, `next_step: 'Schedule re-examination; the asset is locked until re-examined'`, `escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 300 }`.
- Status change (AC4): `event_type: 'asset_status_changed'`, `status_verb: <new_status>`, `object_type: 'asset'`, `object_id: <asset_id>`, target `{ role: 'production_planner' }` AND a second emission with target `{ role: 'hub_booking_coordinator' }`, `actor_label` naming the asset tag and the status transition, `next_step: 'Update planning and booking accordingly'`.

`actor_label` names the human-readable subject, not a raw id (the 7.2 Group 4 patch). A failed emission is logged and swallowed (AD-17): it never rolls back the business write. `production_planner` and `hub_booking_coordinator` are NEW role strings; the harness must provision them and assert the fan-out resolves to at least one real recipient (the Story 7.4 lesson applied in advance).

### API Contract

Table 8 lists the nine new routes plus the one extended route. All are registered in `createAppRouter` and all nine new routes must be added to `allowedSpineRoutes`.

| **Method and path** | **Scope** | **Behavior** |
| --- | --- | --- |
| `POST /api/v1/maintenance/statutory-examinations` | write | Records a statutory examination; 404 `ASSET_NOT_FOUND`, 400 `INVALID_EXAMINATION_TYPE`, 400 `INVALID_INTERVAL`, 409 `DUPLICATE_STATUTORY_EXAMINATION`, 422 `EXAMINATION_ALREADY_OVERDUE`, 422 `EXAMINATION_FUTURE_DATE` |
| `GET /api/v1/maintenance/statutory-examinations` | read | Filterable by `asset_id`, `status`, `examination_type`; paginated |
| `GET /api/v1/maintenance/statutory-examinations/:examinationId` | read | Examination row plus record history; 404 `EXAMINATION_NOT_FOUND` |
| `POST /api/v1/maintenance/statutory-examinations/scan` | write | Runs the overdue scan for an explicit `business_date`; returns the four counters |
| `POST /api/v1/maintenance/assets/:assetId/status` | write | Sets machine status; 400 `INVALID_STATUS_TRANSITION`, 403 `APPROVAL_REQUIRED`, 404 `APPROVAL_UNRESOLVED`, 423 `STATUTORY_EXAMINATION_OVERDUE` |
| `GET /api/v1/maintenance/assets/:assetId/status` | read | Current operational status; 404 `ASSET_NOT_FOUND` |
| `GET /api/v1/maintenance/asset-status` | read | Filterable by `status`; paginated |
| `GET /api/v1/maintenance/assets/:assetId/costs` | read | Per-asset cost accumulation; 404 `ASSET_NOT_FOUND` |
| `GET /api/v1/maintenance/asset-costs` | read | Paginated |
| `POST /api/v1/maintenance/work-orders/:workOrderId/complete` (extended) | write | Accepts optional `labor_cost`, `parts_cost`; derives `total_cost`, `capitalization_flagged`; 400 `INVALID_COST` |

Route ordering matters and is the single most likely silent defect in Task 7.3. Register `/statutory-examinations/scan` (static under `/statutory-examinations/`) before any `/statutory-examinations/:examinationId` route. Register `/assets/:assetId/status` and `/assets/:assetId/costs` after `/assets/:assetId` but before any `/assets/:assetId/...` sub-resources. Confirm no path in this block shadows the existing `/api/v1/maintenance/assets/:assetId/parts` routes.

Every write route carries an `idempotency_key`; a blank or non-string key falls back to `randomUUID()`; a cross-event-type reuse returns 409 `DUPLICATE_EVENT`. Reuse `idempotencyKeyFrom`, `replayIdOrReject` and `requireBusinessDate` from `src/api/v1/maintenance.ts` rather than writing new helpers. Every 201 body is read back BY ID from the persisted payload's own id, never by re-querying the newest row and never by grain (the Story 7.4 review Medium finding).

### Error Code Contract

Table 9 is the complete set of error codes this story introduces or reuses. Every code must appear in at least one test.

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `ASSET_NOT_FOUND` | 404 | Reused from Story 7.2: the asset id does not resolve in `asset` |
| `EXAMINATION_NOT_FOUND` | 404 | The examination id does not resolve |
| `INVALID_EXAMINATION_TYPE` | 400 | `examination_type` is not `osh_code` or `weighbridge_legal_metrology` |
| `INVALID_INTERVAL` | 400 | `interval_months` is not in `(0, 120]` |
| `DUPLICATE_STATUTORY_EXAMINATION` | 409 | A statutory examination already exists for that `(asset_id, examination_type)` |
| `EXAMINATION_ALREADY_OVERDUE` | 422 | Recording an examination whose `next_due_date < business_date` |
| `EXAMINATION_FUTURE_DATE` | 422 | `examined_on` is after `business_date` |
| `STATUTORY_DERIVATION_MISMATCH` | 409 | A declared payload field disagrees with the value derived from locked rows |
| `WEIGHBRIDGE_OUT_OF_STAMP` | 423 | Weighment attempted on a weighbridge with overdue statutory examination |
| `INVALID_STATUS_TRANSITION` | 400 | State machine transition not allowed (Table 5) |
| `APPROVAL_REQUIRED` | 403 | Reused: return-to-service without supervisor sign-off (AC5) |
| `APPROVAL_UNRESOLVED` | 404 | Reused: no DOA entry governs `maintenance.return_to_service` |
| `INVALID_COST` | 400 | `labor_cost` or `parts_cost` fails `NUMERIC_REGEX` |
| `COST_DERIVATION_MISMATCH` | 409 | A declared cost field disagrees with the value derived from locked rows |
| `DUPLICATE_STATUTORY_EXAMINATION_OVERDUE` | 409 | 23505 resolution on `uq_statutory_examination_asset_type` (overdue flip race) |
| `DUPLICATE_EVENT` | 409 | Reused: cross-event-type idempotency-key reuse |

### Architecture Compliance

- AD-3 (DOA registry as single approval resolver): return-to-service authority resolves through `resolveApprover('maintenance.return_to_service', 0)`. No hard-coded role list, no override flag, no reason-coded bypass anywhere in this story.
- AD-8 (calibration lockout non-overridable): the lockout stays in `src/compliance/calibration.ts` on the QC write path; this story does not touch it. The statutory lockout is a separate gate on the weighbridge write path and return-to-service write path.
- AD-9 (one asset register): `statutory_examination.asset_id` references the single Story 7.1 register. No second asset concept and no new column on `asset`.
- AD-12 (compliance spine as platform layer): the statutory lockout is enforced in `persistEvent` pre-transaction, not in the HTTP handler. This closes the direct-event and edge upload bypass paths.
- AD-14 (read models are shared projections): every mutation goes through `persistEvent`; projections are derived state applied in the same transaction. No raw SQL mutation from a job or handler.
- AD-16 (idempotency keys): every write route carries an `idempotency_key`; a replay returns the stored result, a cross-type reuse returns 409.
- AD-17 (notification coupling): all emissions use the decoupled `emitNotification`. None is an approval decision.
- Module directory: all new code lands under `src/maintenance/`, `src/compliance/`, `src/read/projections/` and `src/api/v1/`. No new top-level directory.
- RBAC: `requireRole({ module: 'maintenance', functionScope: 'read' })` or `'write'` on every new handler, never a hardcoded role list in a handler body. The no-hardcoded-role gate enforces this. The 403 in Task 5.1 is a business rule, not an RBAC decision, and must be raised AFTER the RBAC wrapper, not inside it.

### Previous Story Intelligence

Story 7.5 shipped after a 2-High, 5-Medium, 8-Low review. Every lesson below is live and skipping any of them will reproduce a finding:

- Alert appliers that trust payload derivable fields were the top High finding. Re-derive under the lock and reject a fabricated alert; a forged alert occupying the same-day grain suppresses the genuine escalation. Here the same class of forgery unlocks an asset or bypasses return-to-service, so it is strictly worse.
- Read back a created resource BY ID from the persisted payload, never by grain and never by newest row, or a same-key replay with a different body returns the wrong row or null.
- A wire boolean must be validated, not coerced: `"true"` as a string silently becoming `false` disabled a whole FR in 7.4. This story has `capitalization_flagged` as a derived boolean; it is server-computed, not client-entered, so the coercion risk is absent. But `labor_cost` and `parts_cost` are NUMERIC strings and must be validated with `NUMERIC_REGEX`, not coerced.
- Guard every `decodeURIComponent` on a path segment and return 400 `INVALID_PARAMS` on a malformed encoding rather than throwing an uncaught URIError 500.
- A filter that is silently ignored in an unsupported combination must return 400 `INVALID_PARAMS` instead.
- Concurrency tests on the FOR UPDATE and 23505 race path are mandatory, not optional: the race path and the sequential path must return the SAME error code with the SAME `existing_*` detail.
- Bound every integer and count field at load and at the handler; an unbounded value becomes a 500 instead of a 400.
- Job results expose delivery counters separately from write counters, so a dropped notification is visible.
- Narrow job scope in SQL, not in a JS filter after the fact, or the counters overstate what was evaluated.
- Never let an applier silently no-op on a state it should reject.
- Every TIMESTAMPTZ input requires an explicit UTC offset; every DATE derived from a timestamp pins its zone explicitly through `toIstCalendarDate`.
- Canonicalize every human-entered key with `lower()`, in the handler AND in the seam.
- A notification aimed at a role no user holds fans out to zero recipients and reports success. Provision the target role in the harness and assert the fan-out resolves to a real user.

Story 7.2 lessons that still bind: duplicate detection under `FOR UPDATE` with a unique index as the backstop, and actor-derived fields never read from the payload. Story 7.1 lesson that still binds: the one-record rule is enforced by a database constraint, not only by a pre-check.

Two open platform gaps from the ledger apply here and are NOT this story's to fix: a `maintenance.*` event posted with a non-`maintenance` `stream_type` skips the seam gates (`src/events/store.ts`), and same-event-type idempotency-key reuse with different content returns the original event. The first one is more dangerous in this story than in any previous one, because the events it would smuggle past the seam write lockout status. Note it in `deferred-work.md` again with that framing.

### Git Intelligence

Baseline is `e93014f` ("7-5"), the commit that landed the complete Story 7.5 tree. Recent commits (`e93014f`, `eca5aca`, `1df3013`, `893e945` and `ce42587` asset registration) show the established rhythm: canonical SQL plus init-db mirror plus schema-drift entry land together; seams are wired into `store.ts` in the same commit as the events they validate; the integration suite is authored alongside, not after. Follow it. The working tree is clean at story-creation time, so record the actual `git rev-parse HEAD` value in the frontmatter at the start of dev-story.

### Testing Requirements

- Framework and harness: the existing integration-test harness under `test/integration/`, bootstrapped exactly as `story-7-5.test.ts` does. Unit-level schema assertions go in `test/unit/schema-drift.test.ts`.
- Red-green-refactor per task: write the failing assertion first, confirm it fails for the right reason, then implement.
- Every acceptance criterion needs at least one test that would FAIL if the behavior were removed. A test that only asserts a 200 is not coverage.
- Every error code in Table 9 needs a test.
- Idempotency: every write route gets a replay test asserting the same resource comes back and the event ledger count did not grow.
- The three lockout-integrity tests are mandatory and are the heart of AC1, AC2 and AC5:
  1. Overdue statutory blocks return-to-service end to end. Record a statutory examination with `next_due_date` in the past, run the scan on a `business_date` after `next_due_date`, then `POST /api/v1/maintenance/assets/:assetId/status` with `status: 'running'` and assert 423 `STATUTORY_EXAMINATION_OVERDUE`, assert the status is still `idle` (or whatever it was), and assert NO `maintenance.asset_status_changed` event was written.
  2. Weighbridge out of stamp blocks weighment. Record a statutory examination for a weighbridge with `examination_type: 'weighbridge_legal_metrology'` and `device_key: 'WB-DEVICE-1'`, run the scan to flip it overdue, then `POST /api/v1/weighbridge-events` with `device_id: 'WB-DEVICE-1'` and assert 423 `WEIGHBRIDGE_OUT_OF_STAMP`, assert the weighment is not persisted, and assert NO `weighbridge.recorded` event was written.
  3. Re-stamp unblocks. Record a statutory examination for a weighbridge, flip it overdue, then record a re-stamp (new `maintenance.statutory_examination_recorded` event), then `POST /api/v1/weighbridge-events` and assert 201, assert the weighment is persisted.
- Cost accumulation tests: closure with labor + parts accumulates per asset, capitalization flag at threshold (exact boundary: equal - not flagged; strictly greater - flagged), NUMERIC exactness (no float), story-7-2 regression (existing completions without cost still pass).
- Status broadcast tests: status change emits notification, fan-out resolves to at least one real recipient for both `production_planner` and `hub_booking_coordinator` roles (provisioned in harness).
- Concurrency: parallel statutory record on same `(asset_id, examination_type)`, parallel status changes on same asset, each resolve to one success and one stable 409.
- Derivation mismatch: a direct `POST /api/v1/events` carrying a forged `maintenance.statutory_examination_recorded` with a `next_due_date` that disagrees with the derivation is rejected 409 `STATUTORY_DERIVATION_MISMATCH`, and a forged `maintenance.asset_status_changed` with a fabricated `sign_off_by` cannot bypass the return-to-service gate.
- Regression: the Story 1.7 suite and the Spine 4 test in the Story 1.9 suite must pass UNCHANGED. If a Story 1.7 assertion has to change, the lockout has been misread: re-read the Binding Scope Decisions before touching that file.
- Stories 7.1-7.5 suites must pass unchanged.
- Weighbridge stories 3.2-3.4 suites must pass unchanged (the new assert is fail-open for unknown device keys).
- Do not weaken, skip or delete an existing test to make a new one pass.
- Known baseline: seventeen pre-existing failures at `e93014f` (fifteen Epic 1 to 3 idempotency failures, one `story-5-3` where-used clock-window flake, one `gate_dwell_metric` line-ending artifact), all recorded in `deferred-work.md`. Zero NEW failures is the bar; do not attempt to fix the baseline in this story.

### Project Structure Notes

New files: `read/projections/statutory_examination.sql`, `read/projections/statutory_examination_record.sql`, `read/projections/asset_operational_status.sql`, `read/projections/maintenance_asset_cost.sql`, `src/compliance/maintenance-statutory.ts`, `src/compliance/asset-operational-status.ts`, `src/read/projections/statutory_examination.ts`, `src/read/projections/statutory_examination_record.ts`, `src/read/projections/asset_operational_status.ts`, `src/read/projections/maintenance_asset_cost.ts`, `src/maintenance/statutory-jobs.ts`, `test/integration/story-7-6.test.ts`.

Modified files: `read/projections/maintenance_work_order.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/compliance/weighbridge.ts`, `src/compliance/maintenance-plan.ts`, `src/read/projections/maintenance_work_order.ts`, `src/api/v1/maintenance.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `src/config/index.ts`, `_bmad-output/implementation-artifacts/deferred-work.md`.

Read-only, do not modify: `src/compliance/calibration.ts` (the Story 1.7 lockout gate), `test/integration/story-1-7.test.ts`, and everything under `src/engineering/`.

No new dependency is required or permitted. Everything this story needs (pg, node:crypto, the existing middleware, the notification service, the DOA resolvers) is already installed.

### References

- Epic 7 story plus FR-M-14/15/16: `_bmad-output/planning-artifacts/epics.md` (Story 7.6 at line 2233; the FR-M-14/15/16 lines at 169-171; the Epic 1 versus Epic 7 ownership split at line 782; the pilot build order at line 289).
- Sprint-change-proposal rescoping note: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md` (line 3031).
- AD-3, AD-8, AD-9, AD-12, AD-14, AD-16 and AD-17 plus the module directory: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (AD-3 at line 82, AD-8 at line 112, AD-9 at line 118).
- Previous story, its review outcome and its binding decisions: `_bmad-output/implementation-artifacts/7-5-calibration-register-and-non-overridable-lockout.md`.
- The existing lockout gate and its exact rejection shape: `src/compliance/calibration.ts` (`assertCalibrationLockout`), called from `src/events/store.ts` line 418.
- The Epic 3 weighbridge flow: `src/compliance/weighbridge.ts`, `src/api/v1/weighbridge.ts`, `test/integration/story-3-3.test.ts`.
- The Story 1.11 notification foundation: `src/notify/emit.ts`, `src/notify/dispatch.ts`.
- The DOA resolver: `src/api/v1/indents.ts` line 66 (`resolveApprover`), used for ad-hoc substitution approval in `src/api/v1/bom-execution.ts:301` and ECO approval in `src/api/v1/ecos.ts:122`.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

- Baseline: `e93014f` (Story 7.5 tree), preserved in YAML frontmatter.
- `npm run db:migrate` run twice, idempotent; new tables/constraints/indexes verified live via pg_constraint/pg_indexes.
- Full gate run on 2026-08-25: build clean, lint clean, format clean on all touched files, schema-drift 101 pass / 1 fail (the documented pre-existing `gate_dwell_metric` CRLF artifact), spine gate 6/6, story-7-6 33/33, story-7-1/7-2/7-3/7-4/7-5 all green, story-1-7/3-2/3-3/3-4 unchanged (only the documented pre-existing idempotency failures), edge 30/30, full suite 1096 pass / 16 fail (the 15 documented Epic 1-3 idempotency failures plus the gate_dwell CRLF artifact; 0 new; the intermittent story-5-3 clock-window flake did not fire this run).
- Verified pre-existing at pristine baseline via git stash: story-3-3 "edge upload replays idempotently", story-3-4 "Idempotent replay of the same goods.received", story-1-7 "regression guard" all fail identically without this story's changes.

### Completion Notes List

- Implemented all 9 tasks (44 subtasks) from baseline e93014f.
- Five new projections: statutory_examination (grain (asset_id, examination_type) plus lower(device_key) unique index), statutory_examination_record, asset_operational_status, maintenance_asset_cost, and the additive work-order cost columns (labor_cost/parts_cost/total_cost NUMERIC(14,3), capitalization_flagged) - canonical SQL mirrored verbatim into deploy/compose/init-db.sql (CRLF preserved), registered in the MIGRATIONS tail, pinned in schema-drift EXPECTED.
- Three new maintenance-stream events (statutory_examination_recorded, statutory_examination_overdue, asset_status_changed; all requiresBusinessStream false) plus the additive labor_cost/parts_cost extension on maintenance.work_order_completed, in schema.ts.
- Two new compliance seams mirroring calibration-register.ts: src/compliance/maintenance-statutory.ts (next_due_date re-derived in SQL DATE arithmetic under the asset lock, fail-closed EXAMINATION_ALREADY_OVERDUE on already-overdue records, EXAMINATION_FUTURE_DATE, DUPLICATE_STATUTORY_EXAMINATION on a compliant grain, re-stamp on an overdue grain) and src/compliance/asset-operational-status.ts (Table 5 state machine, DOA-resolved return-to-service with sign-off re-derived under lock, fabricated sign_off_by rejected COST_DERIVATION_MISMATCH).
- assertWeighbridgeStampLockout in src/compliance/weighbridge.ts, a pre-transaction DB-backed gate mirroring assertCalibrationLockout, wired into persistEvent next to it; fail-open for device keys not in the register (story-3-2/3-3/3-4 unchanged).
- applyWorkOrderCompleted extended additively: cost path runs only when cost fields are present (total_cost = labor_cost + parts_cost in SQL NUMERIC, capitalization_flagged strictly greater than config.maintenance.capitalizationThreshold), and a completed work order on a weighbridge asset flips its stamp to overdue (Binding Decision 6). Forged declared write-backs reject COST_DERIVATION_MISMATCH.
- src/maintenance/statutory-jobs.ts: POST-triggered scan with explicit business_date, per-grain FOR UPDATE serialize, DUPLICATE_STATUTORY_EXAMINATION_OVERDUE skip, separate write/delivery counters, escalating notification to maintenance_supervisor with 300s window.
- Nine new REST routes plus the extended complete work-order route, all with maintenance-module RBAC, idempotency-key/replay handling, BY-ID read-backs; spine allowlist extended.
- 33 integration tests covering every acceptance criterion, every error code in Table 9, the three mandatory lockout-integrity tests, cost accumulation with exact NUMERIC boundaries, status broadcast fan-out to both real recipient roles, per-unique-index concurrency, and replays.
- config.maintenance.capitalizationThreshold added (NUMERIC string, default '50000', regex-validated, compared in SQL with ::numeric).
- Out-of-scope items logged to deferred-work.md under a Story 7.6 heading (Task 9).

### File List

New files:
- read/projections/statutory_examination.sql
- read/projections/statutory_examination_record.sql
- read/projections/asset_operational_status.sql
- read/projections/maintenance_asset_cost.sql
- src/compliance/maintenance-statutory.ts
- src/compliance/asset-operational-status.ts
- src/read/projections/statutory_examination.ts
- src/read/projections/statutory_examination_record.ts
- src/read/projections/asset_operational_status.ts
- src/read/projections/maintenance_asset_cost.ts
- src/maintenance/statutory-jobs.ts
- test/integration/story-7-6.test.ts

Modified files:
- read/projections/maintenance_work_order.sql
- deploy/compose/init-db.sql
- src/events/migrate.ts
- src/events/schema.ts
- src/events/store.ts
- src/compliance/weighbridge.ts
- src/compliance/maintenance-plan.ts
- src/read/projections/asset.ts
- src/read/projections/maintenance_work_order.ts
- src/api/v1/maintenance.ts
- src/server.ts
- src/config/index.ts
- test/unit/schema-drift.test.ts
- test/integration/story-1-9.test.ts
- _bmad-output/implementation-artifacts/deferred-work.md

### Change Log

- Implemented Story 7.6 (Statutory Examinations, Cost Accumulation, and Machine Status Broadcast) - all 9 tasks, 44 subtasks, 33 integration tests; gates green with zero new failures (Date: 2026-08-25)
