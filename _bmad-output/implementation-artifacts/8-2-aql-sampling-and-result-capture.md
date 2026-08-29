---
baseline_commit: 462668d
---

# Story 8.2: AQL Sampling and Result Capture

Status: done

## Story

As a QC inspector,
I want AQL sampling per IS 2500 / ISO 2859-1 with switching rules, 100%
inspection of critical characteristics, and result capture bound to calibrated
instruments,
so that sampling is statistically valid and results are trustworthy.

## Acceptance Criteria

1. **Given** a lot in QC Hold whose frozen, approved inspection-plan version
   carries an AQL value and an inspection level (General Inspection Level II
   when the version carries no level), **when** sampling is determined for the
   task, **then** the sample-size code letter, sample size, acceptance number,
   and rejection number are derived on the server from the IS 2500 (Part 1) /
   ISO 2859-1 single-sampling tables for that AQL, level, lot size, and the
   current inspection severity (normal, tightened, or reduced), the derived
   plan is frozen on the task, and every later determination attempt for the
   same task replays the frozen plan. [FR-Q-03]
2. **Given** a plan version whose characteristics include class `critical`,
   **when** results are recorded and inspection is completed, **then** every
   critical characteristic requires a result for every unit in the lot (100%
   inspection), every `major` or `minor` characteristic requires a result for
   every unit in the AQL sample only, and inspection cannot complete while any
   required result is missing. [FR-Q-03]
3. **Given** consecutive inspected lots under one plan at one site, **when**
   each inspection completes, **then** the switching state advances per the
   standard's switching rules: normal to tightened after 2 of at most 5
   consecutive lots are not accepted; tightened to normal after 5 consecutive
   accepted lots; tightened to discontinued after 5 cumulative not-accepted
   lots; reduced to normal on any not-accepted lot or any reduced-inspection
   count between Ac and Re; normal to reduced only when the switching score has
   reached 30 and QC Head-level authority has authorized reduced inspection.
   [FR-Q-03]
4. **Given** an inspector records a measured result for a characteristic,
   **when** the result is captured, **then** the result is bound to the
   measuring instrument's registered asset ID, the server derives the
   instrument's register key and calibration status, and a result for a
   characteristic that requires an instrument is rejected without one with
   `INSTRUMENT_REQUIRED`. [FR-Q-04]
5. **Given** the chosen instrument is out of calibration or is not a registered
   instrument, **when** the inspector attempts to record a result with it,
   **then** the capture is rejected with `error_code: "CALIBRATION_LOCKOUT"`
   (HTTP 423), no result, event, projection, or task change persists, no role
   can override the rejection, and the rejected attempt is written to the
   statutory audit log with actor, task, lot, instrument, endpoint, trace ID,
   and error code. [FR-Q-04, FR-M-13, FR-Q-13]

## Requirements Added from the Annex

1. The sampling tables are data, not logic. Encode Table I (sample-size code
   letters), Table II-A (single sampling, normal), Table II-B (single
   sampling, tightened), and Table II-C (single sampling, reduced) of
   IS 2500 (Part 1):2000 / ISO 2859-1:1999, including the arrow cells, as a
   versioned TypeScript data module. Do not compute plans by formula.
2. Only the standard's preferred AQL values are valid inputs
   (0.010, 0.015, 0.025, 0.040, 0.065, 0.10, 0.15, 0.25, 0.40, 0.65, 1.0, 1.5,
   2.5, 4.0, 6.5, 10, 15, 25, 40, 65, 100, 150, 250, 400, 650, 1000). Any other
   AQL fails closed at plan creation and at sampling determination.
3. The inspection-level vocabulary is `I`, `II`, `III`, `S-1`, `S-2`, `S-3`,
   and `S-4`. A null level resolves to `II`. Any other value fails closed at
   plan creation and at sampling determination.
4. When the table sample size equals or exceeds the lot size, the whole lot is
   inspected (sample size equals lot size). When the lot size is below the
   first table band, the whole lot is inspected. A plan version with no AQL
   (both `aql` and `inspection_level` null) means every characteristic is
   inspected 100% (`sampling_basis = 'full_inspection'`) and no switching
   state is kept.
5. Lot size is the task's finished quantity and must be a whole positive
   number of units. A fractional quantity fails closed with
   `SAMPLING_LOT_SIZE_INVALID`.
6. Results are append-only and immutable. Exactly one authoritative result per
   (task, characteristic, sample unit); a second result is rejected with
   `QC_RESULT_EXISTS`. Corrections and re-inspection are out of scope.
7. A numeric result conforms when the measured value lies inside the
   characteristic's inclusive limits, compared as decimal strings. An attribute
   result conforms when the inspector records it as conforming against the
   frozen acceptance criteria. Conformance is derived on the server and stored.
8. A sample unit is nonconforming when any recorded result on that unit does
   not conform. The lot's sampling outcome is `not_accepted` when any critical
   nonconformity exists on any unit, or when the count of nonconforming units
   among the AQL sample units reaches the rejection number; otherwise it is
   `accepted`.
9. Switching state is kept per (plan, site). It is read under lock when
   sampling is determined and advanced under lock when inspection completes.
   Every lot counted by the switching rules is an original inspection.
10. The switching score follows clause 9.3.3.2 of ISO 2859-1:1999: it is
    maintained only during normal inspection and reset to zero on every switch
    to normal; after each lot, when Ac is 2 or more, add 3 if the lot would
    have been accepted with the AQL one preferred step tighter at the same
    code letter, otherwise reset to zero; when Ac is 0 or 1, add 2 if the lot
    is accepted, otherwise reset to zero. If the one-step-tighter cell is an
    arrow, treat the lot as not accepted at the tighter AQL (conservative).
11. Reduced inspection is never entered automatically. Reaching a switching
    score of 30 sets `reduced_eligible`; a QC Head-level authorization command
    switches the state to reduced. Resumption after discontinuation is a QC
    Head-level command and resumes on tightened inspection.
12. The existing synthetic result command (`POST /api/v1/qc/results`) and the
    `assertCalibrationLockout` gate in `src/compliance/calibration.ts` are
    preserved byte-for-byte in behavior. Full result persistence rides the same
    `qc.result_recorded` event type so the lockout applies for free.

## Binding Scope Decisions

1. **Event reuse:** Story 8.2 registers `qc.result_recorded` in
   `SUPPORTED_EVENT_TYPES` with a typed payload and keeps the Story 1.7
   synthetic shape (`instrument_id`, `lot_id`, `parameter`, `value`, no
   `task_id`) valid. A payload with `task_id` is a full result and is projected;
   a payload without `task_id` is synthetic, is validated only for the
   nonblank fields the Story 1.7 route already requires, and is not projected.
   Spine Acceptance test 4 must stay green unchanged.
2. **Instrument-less observations use a distinct event:** `qc.observation_recorded`
   carries attribute results for characteristics whose frozen plan line has
   `instrument_type IS NULL` and `result_kind = 'attribute'`. The seam rejects
   an observation for any other characteristic with `INSTRUMENT_REQUIRED`.
   This keeps the calibration gate's `instrument_id` precondition intact
   without editing `src/compliance/calibration.ts`.
3. **Asset ID is the client contract, instrument ID is the gate key:** clients
   send `instrument_asset_id` (UUID). The handler resolves the register row
   with `getInstrumentRecordByAssetId` and writes `instrument_id` into the
   payload before `persistEvent` so the pre-transaction lockout fires. Inside
   the transaction the applier re-derives `instrument_id` from the asset and
   re-reads `getCalibrationStatus`; a mismatch is `QC_DERIVATION_MISMATCH` and
   a non-calibrated status is `CALIBRATION_LOCKOUT`. Direct `/api/v1/events`
   posts therefore cannot pair a calibrated `instrument_id` with an
   out-of-calibration asset.
4. **One event per characteristic per instrument:** a result event carries one
   `characteristic_id`, one instrument, and up to 500 unit readings. Large
   critical 100% inspections are recorded in batches.
5. **Task state axis:** `qc_inspection_task.task_status` gains the vocabulary
   `open`, `sampling_determined`, `inspected`. Results are accepted only in
   `sampling_determined`. The QC-gate axis (`gate_status`) is untouched;
   results may be recorded on a conditionally released lot because inspection
   is still open.
6. **No disposition:** Story 8.2 computes and stores `sampling_outcome` on the
   task and leaves the gate at `qc_hold` (or `conditionally_released`).
   Accept, reject, split, NCR, and `qc.lot_dispositioned` remain Story 8.3.
7. **Switching grain:** `(plan_id, site_id)`. The plan ID already encodes item,
   specification revision, scope, and job-work reference.
8. **Central-only except results:** `qc.sampling_determined`,
   `qc.observation_recorded`, `qc.inspection_completed`, and
   `qc.sampling_state_adjusted` are central-only (`CENTRAL_ONLY_OPERATION` on
   the edge route). `qc.result_recorded` keeps its existing edge allowance.
   Every new permanent code that a `qc.result_recorded` upload can surface is
   added to the server and connector permanent-code twin set and to
   `edge/src/messages/en.json`. No edge UI or PowerSync bucket is added.
9. **Authority for switching-state commands:** `authorize_reduced` and
   `resume_inspection` require module `qc` write access and an actor whose role
   is in `config.quality.qcHeadRoles`. No DOA transaction type is added. Never
   hardcode a role name (the `no-hardcoded-role-in-workflow` rule applies).
10. **Site scope on reads:** every new task-scoped read route is location-scoped
    through `permittedLocationsForModuleScope(roles, 'qc', 'read')` against the
    task's `site_id`. Apply the same scope to `listQcTasksHandler` and
    `getQcTaskHandler` to close the Story 8.1 deferral.
11. **Audit location:** every audit row written by this story stamps
    `location_id` from the task's `site_id`, not from an arbitrary role
    assignment.
12. **SOD substrate:** replace `knownResultRecorders` in
    `src/compliance/quality.ts` with a read of `qc_inspection_result.recorded_by`
    and update the Story 8.1 SOD fixture to record a real result through the new
    route.
13. **No dependency upgrades:** lockfile-resolved stack only. No decimal, date,
    validation, statistics, or workflow library.

## Tasks and Subtasks

- [x] **Task 1: Encode the sampling standard as data** (AC: 1, 3)
  - [x] Add `src/quality/aql-tables.ts` exporting `PREFERRED_AQLS` (26 canonical
        decimal strings), `INSPECTION_LEVELS`, `CODE_LETTERS` (`A` to `R`,
        no `I` or `O`), `SAMPLE_SIZES` per letter for normal/tightened and for
        reduced, `LOT_SIZE_BANDS` (15 bands from 2-8 to 500001 and above),
        Table I code letters for `I`, `II`, `III`, `S-1` to `S-4`, and
        Tables II-A, II-B, II-C as `{ ac, re } | 'down' | 'up'` cells.
  - [x] Export `canonicalAql(value: string): string | null` that normalizes a
        `NUMERIC(7,3)` string (for example `'1.000'`, `'1'`, `'1.0'`) to the
        preferred-value key or returns null; never use `Number`.
  - [x] Export `codeLetterFor(lotSize: number, level)` and
        `singleSamplingPlan(letter, aql, severity)` that resolves arrow cells
        per the standard (follow the arrow to the first non-arrow cell in the
        same column and use that row's sample size) and returns
        `{ code_letter, sample_size, ac, re, resolved_letter }`.
  - [x] Add `test/unit/aql-tables.test.ts`: every level has 15 bands; every
        table has 16 letters by 26 AQLs; arrow chains terminate; in normal and
        tightened tables `re === ac + 1`; Ac is non-decreasing down a column;
        reduced sample sizes are strictly smaller than normal; and the anchor
        cells in the "Sampling anchors" table below match.

- [x] **Task 2: Add and widen QC projections** (AC: 1-5)
  - [x] Add `read/projections/qc_sampling_plan.sql`: `sampling_id UUID PK`,
        `task_id UUID` (unique `uq_qc_sampling_plan_task`), `lot_id`, `lot_number`,
        `plan_version_id`, `plan_id`, `site_id`, `lot_size INTEGER`,
        `aql NUMERIC(7,3) NULL`, `inspection_level TEXT`, `severity TEXT`,
        `code_letter TEXT NULL`, `resolved_code_letter TEXT NULL`,
        `sample_size INTEGER`, `acceptance_number INTEGER NULL`,
        `rejection_number INTEGER NULL`, `sampling_basis TEXT`
        (`aql_table` or `full_inspection`), `standard_ref TEXT`,
        `critical_characteristic_count INTEGER`, `determined_by UUID`,
        `determined_at TIMESTAMPTZ`, `source_event_id`, `created_at`. Named
        checks on vocabulary, positive sizes, `sample_size <= lot_size`,
        and Ac/Re pairing (`re > ac` when both set). Grant `INSERT, SELECT`.
  - [x] Add `read/projections/qc_inspection_result.sql`: `result_id UUID PK`,
        `task_id`, `lot_id`, `characteristic_id`, `characteristic_class`,
        `sample_unit_no INTEGER`, `result_kind`, `measured_value NUMERIC(18,6) NULL`,
        `measured_uom TEXT NULL`, `attribute_conforms BOOLEAN NULL`,
        `conforms BOOLEAN NOT NULL`, `instrument_asset_id UUID NULL`,
        `instrument_id TEXT NULL`, `recorded_by UUID`, `recorded_at TIMESTAMPTZ`,
        `source_event_id`, `created_at`. Unique
        `uq_qc_inspection_result_unit (task_id, characteristic_id, sample_unit_no)`
        mapped to `QC_RESULT_EXISTS`; checks pairing numeric/attribute columns
        and requiring `instrument_asset_id` and `instrument_id` together;
        indexes on `(task_id, characteristic_id)` and `(task_id, recorded_by)`.
        Grant `INSERT, SELECT`.
  - [x] Add `read/projections/qc_sampling_switching_state.sql`: composite PK
        `(plan_id, site_id)`, `severity TEXT`, `switching_score INTEGER`,
        `recent_original_outcomes JSONB` (array of at most 5 booleans, newest
        last), `consecutive_accepted_on_tightened INTEGER`,
        `not_accepted_on_tightened INTEGER`, `reduced_eligible BOOLEAN`,
        `inspection_discontinued BOOLEAN`, `last_task_id UUID NULL`,
        `lots_counted INTEGER`, `source_event_id`, `created_at`, `updated_at`.
        Grant `INSERT, SELECT, UPDATE`.
  - [x] Widen `read/projections/qc_inspection_task.sql` with the guarded
        drop-and-re-add pattern for `chk_qc_inspection_task_status`
        (`open`, `sampling_determined`, `inspected`) and guarded
        `ADD COLUMN IF NOT EXISTS` for `sampling_id UUID NULL`,
        `sampling_outcome TEXT NULL` (check `accepted`/`not_accepted`),
        `nonconforming_sample_units INTEGER NULL`,
        `critical_nonconformities INTEGER NULL`, `inspected_by UUID NULL`,
        `inspected_at TIMESTAMPTZ NULL`.
  - [x] Add guarded `chk_inspection_plan_version_level_vocab` to
        `read/projections/inspection_plan_version.sql` for the level vocabulary.
  - [x] Mirror every DDL change exactly into `deploy/compose/init-db.sql`;
        register the three new files at the tail of `src/events/migrate.ts`
        after `qc_lot_disposition.sql`; extend `test/unit/schema-drift.test.ts`
        with `EXPECTED` entries, the additive-column fragments, the migration
        order pin (tail anchor `qc_lot_disposition.sql`), and grant pins
        (no `DELETE` anywhere; `UPDATE` only on `qc_inspection_task` and
        `qc_sampling_switching_state`).

- [x] **Task 3: Add projection accessors** (AC: 1-5)
  - [x] Add `src/read/projections/qc_sampling_plan.ts`
        (`getQcSamplingPlanByTaskId(taskId, client?, forUpdate?)`,
        `insertQcSamplingPlan`).
  - [x] Add `src/read/projections/qc_inspection_result.ts`
        (`insertQcInspectionResults(rows, client)`,
        `listQcInspectionResults(taskId, filters, client?)`,
        `countResultsByCharacteristic(taskId, client)`,
        `listNonconformingUnits(taskId, client)`,
        `listResultRecorderUserIds(taskId, client)`).
  - [x] Add `src/read/projections/qc_sampling_switching_state.ts`
        (`getSwitchingState(planId, siteId, client, forUpdate)`,
        `upsertSwitchingState`).
  - [x] Extend `src/read/projections/qc_inspection_task.ts`: widen
        `QcTaskStatus`, add the new columns to the row mapper, and add a
        compare-and-set `transitionQcTaskStatus(taskId, from, to, patch, client)`
        modeled on `transitionQcGate`.
  - [x] Extend `src/read/projections/inspection_plan.ts` row types only if a
        new column is added; otherwise reuse `listInspectionPlanCharacteristics`
        and `getInspectionPlanVersionById` unchanged.

- [x] **Task 4: Define Story 8.2 event contracts** (AC: 1-5)
  - [x] In `src/events/schema.ts` add typed payloads and register on
        `streamType: 'qc'` with `requiresBusinessStream: false`:
        `qc.sampling_determined`, `qc.result_recorded`,
        `qc.observation_recorded`, `qc.inspection_completed`,
        `qc.sampling_state_adjusted`. Stream ID is `task_id` for task events
        and `plan_id` for `qc.sampling_state_adjusted`.
  - [x] `QcSamplingDeterminedPayload`: client fields `task_id`, `sampling_id`,
        `determined_at`; every other field in the "Sampling determined derived
        fields" list below is server-derived and declared values are rejected
        with `QC_DERIVATION_MISMATCH` (Story 8.1 `rejectDeclaredDerived`).
  - [x] `QcResultRecordedPayload` (full shape): `task_id`, `lot_id`,
        `characteristic_id`, `instrument_asset_id`, `instrument_id`,
        `readings: Array<{ result_id, sample_unit_no, measured_value?, measured_uom?, attribute_conforms? }>`
        (1 to 500 entries), `recorded_at`; derived write-backs
        `characteristic_class`, `result_kind`, `conforms_by_result_id`.
        Synthetic shape (no `task_id`) is `instrument_id`, `lot_id`,
        `parameter`, `value` and is left as-is.
  - [x] `QcObservationRecordedPayload`: same as the full result shape without
        instrument fields and with `attribute_conforms` required per reading.
  - [x] `QcInspectionCompletedPayload`: client fields `task_id`, `completed_at`;
        derived `sampling_id`, `sampling_outcome`,
        `nonconforming_sample_units`, `critical_nonconformities`,
        `severity_used`, `previous_severity`, `new_severity`,
        `switching_score`, `reduced_eligible`, `inspection_discontinued`,
        `previous_task_status`, `task_status`.
  - [x] `QcSamplingStateAdjustedPayload`: `plan_id`, `site_id`,
        `action: 'authorize_reduced' | 'resume_inspection'`, `reason`,
        `adjusted_at`; derived `previous_severity`, `new_severity`,
        `authorized_by`, `authorizing_role`.
  - [x] Add all five names to `QUALITY_EVENT_TYPES`; define
        `QC_CENTRAL_ONLY_EVENT_TYPES` as an explicit set that excludes
        `qc.result_recorded`; add a unit drift test asserting
        `QUALITY_EVENT_TYPES` equals every registry entry with
        `streamType: 'qc'` (closes the Story 8.1 deferral).
  - [x] Leave `qc.lot_dispositioned` reserved and unregistered.

- [x] **Task 5: Implement sampling determination** (AC: 1)
  - [x] Add `src/quality/sampling.ts#determineSampling(task, planVersion, characteristics, switchingState)`
        as a pure function returning the frozen plan; it validates lot size,
        canonical AQL, level vocabulary, severity, and the full-inspection
        branch, and reports the "Sampling determined derived fields".
  - [x] In `src/compliance/quality.ts` add shape validation and the
        in-transaction applier for `qc.sampling_determined`: lock lot row, then
        task row (`FOR UPDATE`), require `task_status = 'open'` else
        `QC_TASK_NOT_OPEN` (replay of the same idempotency key returns the
        frozen plan without a second event), load the frozen plan version and
        characteristics, read switching state under lock (absent means
        `normal`, `inspection_discontinued` means
        `SAMPLING_INSPECTION_DISCONTINUED`), compute the plan, insert
        `qc_sampling_plan`, transition the task to `sampling_determined` with
        `sampling_id`, write derived fields back to the payload, and map
        `uq_qc_sampling_plan_task` to `QC_SAMPLING_EXISTS`.
  - [x] Reject `AQL_NOT_IN_STANDARD`, `INSPECTION_LEVEL_INVALID`,
        `SAMPLING_LOT_SIZE_INVALID` with details naming the offending value.
  - [x] Add the same AQL and level validation to the existing
        `qc.inspection_plan_created` shape check so new plan versions cannot
        carry values that sampling will reject later.

- [x] **Task 6: Implement result and observation capture** (AC: 2, 4, 5)
  - [x] Shape validation (pre-transaction, non-DB): UUIDs, 1 to 500 readings,
        unique `sample_unit_no` within the event, positive integers, decimal
        strings via the existing regexes, offset-bearing `recorded_at`
        within range, and for the full shape both `instrument_asset_id` and
        `instrument_id` present.
  - [x] Applier (in transaction): lock lot then task; require
        `task_status = 'sampling_determined'` else `QC_SAMPLING_REQUIRED`
        (when `open`) or `QC_TASK_NOT_OPEN_FOR_RESULTS` (when `inspected`);
        load the sampling plan and the frozen characteristic by
        `characteristic_id` under the task's `plan_version_id` else
        `QC_CHARACTERISTIC_NOT_IN_PLAN`; enforce unit range
        (`1..lot_size` for `critical`, `1..sample_size` otherwise, or
        `1..lot_size` under `full_inspection`) else
        `QC_SAMPLE_UNIT_OUT_OF_RANGE`; enforce result-kind pairing
        (`numeric` needs `measured_value` and `measured_uom` equal to
        `limit_uom`; `attribute` needs `attribute_conforms`) else
        `QC_RESULT_KIND_MISMATCH` or `QC_RESULT_UOM_MISMATCH`.
  - [x] Instrument binding for `qc.result_recorded`: re-derive the register row
        by `instrument_asset_id` (`INSTRUMENT_NOT_FOUND` when absent),
        require `row.instrument_id` to equal the payload `instrument_id`
        (`QC_DERIVATION_MISMATCH`), and require
        `getCalibrationStatus(row.instrument_id) === 'calibrated'`
        (`CALIBRATION_LOCKOUT`, 423). Require the characteristic to permit an
        instrument (`result_kind = 'numeric'` or `instrument_type` set);
        otherwise `INSTRUMENT_NOT_PERMITTED`.
  - [x] For `qc.observation_recorded`: require `result_kind = 'attribute'` and
        `instrument_type IS NULL` else `INSTRUMENT_REQUIRED`.
  - [x] Derive `conforms` per reading (numeric: inclusive limits via
        `compareDecimalStrings`; attribute: `attribute_conforms`), insert the
        result rows, write `conforms_by_result_id`, `characteristic_class`, and
        `result_kind` back into the payload, and map
        `uq_qc_inspection_result_unit` to `QC_RESULT_EXISTS`.
  - [x] Recorder identity is `metadata.actor.user_id`; reject a declared
        `recorded_by`.
  - [x] Preserve the synthetic branch: a `qc.result_recorded` payload without
        `task_id` passes only the Story 1.7 nonblank checks and is not applied.

- [x] **Task 7: Implement inspection completion and switching rules** (AC: 2, 3)
  - [x] Add `src/quality/switching.ts` with pure functions
        `evaluateOutcome(plan, results)` and
        `advanceSwitchingState(state, outcome, plan, tighterAqlAcceptable)`
        implementing clause 9.3 and the switching score per the annex.
  - [x] Applier for `qc.inspection_completed`: lock lot, task, then switching
        state row; require `task_status = 'sampling_determined'`; verify
        completeness (every characteristic has its required unit set) else
        `QC_INSPECTION_INCOMPLETE` with details listing each
        `characteristic_id`, `required`, and `recorded`; compute outcome and
        counts; advance the switching state (skip when
        `sampling_basis = 'full_inspection'`); transition the task to
        `inspected` with outcome columns; write derived fields back; emit a
        transactional notification to `config.quality.inspectionTaskNotificationRole`
        recipients when the outcome is `not_accepted` (task remains the
        authoritative queue).
  - [x] Reduced-inspection rule: if the nonconforming count is greater than Ac
        and less than Re, the lot is `accepted` and severity returns to
        `normal`.
  - [x] Applier for `qc.sampling_state_adjusted`: lock the state row;
        `authorize_reduced` requires `severity = 'normal'` and
        `reduced_eligible = true` else `REDUCED_INSPECTION_NOT_ELIGIBLE`;
        `resume_inspection` requires `inspection_discontinued = true` else
        `SAMPLING_INSPECTION_NOT_DISCONTINUED`, and resumes on `tightened`
        with counters reset. The actor's role must be in
        `config.quality.qcHeadRoles` (derive and write back
        `authorizing_role`); otherwise `APPROVAL_REQUIRED` recorded through
        `auditRejectedAttempt`.

- [x] **Task 8: Add QC REST routes, RBAC, audit, and edge classification**
      (AC: 1-5)
  - [x] Add handlers in `src/api/v1/quality.ts` and register in
        `src/server.ts` (static before parameterized; keep
        `/api/v1/qc/results` unchanged):
        `POST /api/v1/qc/tasks/:taskId/sampling`,
        `GET /api/v1/qc/tasks/:taskId/sampling`,
        `POST /api/v1/qc/tasks/:taskId/results`,
        `POST /api/v1/qc/tasks/:taskId/observations`,
        `GET /api/v1/qc/tasks/:taskId/results` (filters
        `characteristic_id`, `sample_unit_no`, `conforms`, `limit`, `offset`),
        `POST /api/v1/qc/tasks/:taskId/inspection-completion`,
        `GET /api/v1/qc/sampling-states` (query `plan_id`, `site_id`),
        `POST /api/v1/qc/sampling-states/:planId/sites/:siteId/actions`.
  - [x] Use `requireRole({ module: 'qc', functionScope })`, `actorContext`,
        `requireBody`, `requireUuidParam`, `idempotencyKeyFrom`,
        `replayIdOrReject`, and `assertWriteSiteAccess(req, task.site_id)`;
        add a read-side site check for every task-scoped GET and for
        `listQcTasksHandler` and `getQcTaskHandler`.
  - [x] Result handler: resolve `instrument_asset_id` with
        `getInstrumentRecordByAssetId` (404 `INSTRUMENT_NOT_FOUND` when
        absent), mint `result_id` per reading, write `instrument_id` into the
        payload, call `persistEvent`. Responses: `201 { event_id, results }`
        (200 on replay); sampling `201 { event_id, sampling, task }`;
        completion `201 { event_id, task, switching_state }`; actions
        `201 { event_id, switching_state }`.
  - [x] Add `CALIBRATION_LOCKOUT` and `APPROVAL_REQUIRED` to the
        `AUDITED_REJECTIONS` handled by `auditRejectedAttempt` for the new
        write routes, stamping `location_id` from the task `site_id` and
        including `instrument_asset_id` and `instrument_id` in details.
  - [x] Edge: extend `assertEdgeQcEventAllowed` so only `qc.result_recorded`
        stays allowed; add every new permanent code reachable from a
        `qc.result_recorded` upload (`QC_TASK_NOT_FOUND`, `QC_SAMPLING_REQUIRED`,
        `QC_TASK_NOT_OPEN_FOR_RESULTS`, `QC_CHARACTERISTIC_NOT_IN_PLAN`,
        `QC_SAMPLE_UNIT_OUT_OF_RANGE`, `QC_RESULT_KIND_MISMATCH`,
        `QC_RESULT_UOM_MISMATCH`, `QC_RESULT_EXISTS`, `INSTRUMENT_NOT_FOUND`,
        `INSTRUMENT_NOT_PERMITTED`, `QC_DERIVATION_MISMATCH`) to
        `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`, the identical set in
        `edge/src/sync/connector.ts`, and `errors.<CODE>` entries in
        `edge/src/messages/en.json`.
  - [x] Add every new route to the Story 1.9 exact allowlist in
        `test/integration/story-1-9.test.ts` without weakening it.

- [x] **Task 9: Repoint SOD and preserve Story 8.1 behavior** (AC: 4)
  - [x] Replace `knownResultRecorders` in `src/compliance/quality.ts` with
        `listResultRecorderUserIds(taskId, client)`; keep deterministic
        ordering for `inspector_user_id` (earliest `recorded_at`, then
        `result_id`).
  - [x] Update the Story 8.1 SOD test to create an instrument fixture (asset,
        register, certificate) and record a result through
        `POST /api/v1/qc/tasks/:taskId/results` after determining sampling,
        instead of inserting `domain_events` directly.
  - [x] Confirm conditional release still works in `sampling_determined` and
        `inspected` task states (gate axis is independent).

- [x] **Task 10: Tests and regression gates** (AC: 1-5)
  - [x] Add `test/integration/story-8-2.test.ts` (real router, real
        PostgreSQL, SCIM provisioning, dev tokens, serial). Copy the
        `heldLot` fixture family from `story-8-1.test.ts` and the instrument
        fixture family (`createAsset`, `registerInstrument`,
        `recordCertificate`, `scan`) from `story-7-5.test.ts`.
  - [x] AC1: lot 500 units, AQL `1.000`, level null, normal: code `H`,
        `n = 50`, `Ac 1 / Re 2`; lot 1000 units, level `II`: `J`, `n = 80`,
        `Ac 2 / Re 3`; lot 5000 units, AQL `2.500`: `L`, `n = 200`,
        `Ac 10 / Re 11`; arrow case lot 100 units, AQL `1.000`: `F` resolves to
        `G`, `n = 32`, `Ac 0 / Re 1`; lot 5 units: whole lot; fractional
        quantity fails `SAMPLING_LOT_SIZE_INVALID`; AQL `1.200` fails
        `AQL_NOT_IN_STANDARD`; level `IV` fails `INSPECTION_LEVEL_INVALID`;
        null-AQL plan yields `full_inspection`; second determination replays;
        direct event declaring `sample_size` fails `QC_DERIVATION_MISMATCH`;
        discontinued state fails `SAMPLING_INSPECTION_DISCONTINUED`.
  - [x] AC2: critical characteristic requires units `1..lot_size`; major
        requires `1..sample_size`; unit `sample_size + 1` on a major
        characteristic fails `QC_SAMPLE_UNIT_OUT_OF_RANGE`; completion with a
        missing critical unit fails `QC_INSPECTION_INCOMPLETE` listing the
        gap; a single critical nonconformity yields `not_accepted` even when
        the sample count is below Ac; batch of 500 accepted, 501 rejected.
  - [x] AC3: drive consecutive lots through one `(plan, site)` and assert
        normal to tightened on the second not-accepted lot of five; tightened
        table used on the next determination; tightened to normal after 5
        accepted; discontinuation after 5 cumulative not-accepted on tightened;
        switching score reaches 30 after 10 consecutive lots with zero
        nonconformities on an Ac >= 2 plan (3 points each) or 15 such lots on
        an Ac 0/1 plan (2 points each), a single not-accepted lot resets the
        score to zero, and `reduced_eligible` flips without changing severity;
        `authorize_reduced` by a `qc_head` role switches to reduced and the next
        determination uses Table II-C sizes; a count between Ac and Re on
        reduced accepts the lot and returns to normal; `authorize_reduced` by
        an inspector fails `APPROVAL_REQUIRED` and is audited;
        `resume_inspection` returns to tightened; a different site under the
        same plan has independent state.
  - [x] AC4: result carries `instrument_asset_id` and derived `instrument_id`;
        unregistered asset fails `INSTRUMENT_NOT_FOUND`; observation on a
        numeric characteristic fails `INSTRUMENT_REQUIRED`; result with an
        instrument on an instrument-less attribute line fails
        `INSTRUMENT_NOT_PERMITTED`; uom mismatch fails; duplicate unit fails
        `QC_RESULT_EXISTS`; declared `recorded_by` fails.
  - [x] AC5: expire the certificate via scan and assert 423
        `CALIBRATION_LOCKOUT`, zero growth in `domain_events` and
        `qc_inspection_result`, task unchanged, and one `audit_log` row with
        actor, task, lot, instrument, endpoint, trace ID, and code; a
        `qc_head` actor gets the same 423; a direct `/api/v1/events` post
        pairing a calibrated `instrument_id` with an out-of-calibration
        `instrument_asset_id` fails `QC_DERIVATION_MISMATCH` (or 423) and
        persists nothing; replay of a lapsed instrument's idempotency key is
        423 (Story 7.6 precedent).
  - [x] Concurrency: two simultaneous determinations produce one plan; two
        simultaneous result batches for the same unit produce one row; two
        simultaneous completions produce one transition; completion racing a
        result insert for the same task cannot lose the result (both lock the
        task row).
  - [x] Read scope: an inspector with `qc` read on site A cannot read site B
        tasks, sampling, or results (`LOCATION_ACCESS_DENIED`); the Story 8.1
        RBAC sweep stays green.
  - [x] Run `npm run build`, `npm run lint`, `npm run format:check`,
        `npm run db:migrate` twice, `test/unit/aql-tables.test.ts`,
        `test/unit/schema-drift.test.ts`, the Story 8.2 suite, the Spine
        Acceptance Contract, and targeted Story 1.7, 1.9, 7.5, 8-1
        regressions; run edge build, typecheck, lint, and tests because
        `edge/src/sync/connector.ts` and `en.json` change. Run the full
        backend suite and report pre-existing failures separately.

### Review Findings

Code review 2026-08-29 (chunked adversarial pass: Blind Hunter + Edge Case
Hunter + Acceptance Auditor, Group A of 5 — schema, migrations, and
projections: `deploy/compose/init-db.sql`,
`read/projections/{inspection_plan_version,qc_inspection_task,
qc_sampling_plan,qc_inspection_result,qc_sampling_switching_state}.sql`,
`src/events/{schema,migrate,store}.ts`,
`test/unit/{schema-drift,quality-event-registry}.test.ts`). Groups B
(sampling/switching domain logic), C (AQL table data module), D (API/read
layer + edge/sync), and E (integration tests) not yet reviewed; status stays
`review`. All 7 patches applied 2026-08-29 to both the canonical
`read/projections/*.sql` files and their `deploy/compose/init-db.sql`
mirror; verified `npm run build` clean, `npm run db:migrate` twice
idempotent, story-8-2 12/12, quality-event-registry drift 2/2, schema-drift
139/140 (the 1 failure is the pre-existing `gate_dwell_metric` CRLF drift,
unrelated to this story).

- [x] [Review][Patch] `chk_qc_sampling_plan_basis_pairing` full_inspection
      branch doesn't null `inspection_level`/`resolved_code_letter`,
      violating Annex requirement 4 and the table's own doc comment ("no
      code letter") [read/projections/qc_sampling_plan.sql,
      deploy/compose/init-db.sql]
- [x] [Review][Patch] Same constraint doesn't enforce `sample_size =
      lot_size` for `full_inspection`, contradicting the documented
      invariant [read/projections/qc_sampling_plan.sql,
      deploy/compose/init-db.sql]
- [x] [Review][Patch] No pairing CHECK ties `qc_inspection_task.task_status`
      to `sampling_id`/`sampling_outcome`/`inspected_by`/`inspected_at` —
      `inspected` with all six columns NULL passes
      [read/projections/qc_inspection_task.sql, deploy/compose/init-db.sql]
- [x] [Review][Patch] No non-negativity CHECK on
      `nonconforming_sample_units`/`critical_nonconformities`
      [read/projections/qc_inspection_task.sql, deploy/compose/init-db.sql]
- [x] [Review][Patch] `chk_inspection_plan_version_level_vocab` retrofitted
      onto the existing free-text `inspection_level` column with no `NOT
      VALID` staging; Story 8.1 only enforced <=16-char free text, so a
      populated Story 8.1 database with an out-of-vocabulary value would
      hard-fail this migration
      [read/projections/inspection_plan_version.sql,
      deploy/compose/init-db.sql]
- [x] [Review][Patch] `chk_qc_sampling_switching_state_window` only checks
      array shape/length, not element type — actual shape is `boolean[]`
      (confirmed in `src/quality/switching.ts`)
      [read/projections/qc_sampling_switching_state.sql,
      deploy/compose/init-db.sql]
- [x] [Review][Patch] `chk_qc_inspection_result_kind_pairing` numeric branch
      doesn't require `measured_uom IS NOT NULL`, asymmetric with the
      attribute branch [read/projections/qc_inspection_result.sql,
      deploy/compose/init-db.sql]
- [x] [Review][Defer] `code_letter`/`resolved_code_letter` have no
      vocabulary/format constraint on `qc_sampling_plan`
      [read/projections/qc_sampling_plan.sql] — deferred, seam-derived
      write-back only (not client-writable), low exposure
- [x] [Review][Defer] Text-hygiene inconsistency: `lot_number`,
      `instrument_id` lack non-empty checks that sibling free-text columns
      in the same files carry [read/projections/qc_sampling_plan.sql,
      read/projections/qc_inspection_result.sql] — deferred, cosmetic data
      hygiene gap consistent with pre-existing pattern elsewhere
- [x] [Review][Defer] No index on `qc_inspection_task.sampling_id` /
      `inspected_by` [read/projections/qc_inspection_task.sql] — deferred,
      performance-only, table is small at pilot scale

Code review 2026-08-29 (chunked adversarial pass: Blind Hunter + Edge Case
Hunter + Acceptance Auditor, Group B of 5 — sampling/switching domain logic:
`src/compliance/quality.ts`, `src/quality/sampling.ts`,
`src/quality/switching.ts`, `test/unit/sampling-switching.test.ts`). Groups
C (AQL table data module), D (API/read layer + edge/sync), and E
(integration tests) not yet reviewed; status stays `review`. Acceptance
Auditor found no AC/Annex/Binding-Decision violations in this chunk
(sampling derivation, lock order, completeness gating, switching-state
transitions, and derived-field lists all verified against the spec).

- [x] [Review][Defer] A pre-8.2 approved `inspection_plan_version` could
      carry an AQL that passed Story 8.1's looser regex-only gate but is
      not one of Story 8.2's 26 preferred AQL values (`PREFERRED_AQLS`);
      `determineSampling` throws `AQL_NOT_IN_STANDARD` permanently for any
      task on that plan version, with no path forward. Story 8.2's new
      semantic gate in `assertInspectionPlanCreatedShape` closes this
      prospectively for newly-approved versions but does nothing for
      already-approved ones. [src/quality/sampling.ts,
      src/compliance/quality.ts assertInspectionPlanCreatedShape] —
      deferred 2026-08-30, low real risk: Stories 8.1 and 8.2 shipped the
      same day, so no real plan version is expected to carry a
      non-preferred AQL yet; revisit with a one-time audit query or a
      snap-to-nearest-preferred-AQL change if it ever surfaces
- [x] [Review][Defer] `resolveQcResultDuplicateConflict` on a
      `uq_qc_inspection_result_unit` violation returns every submitted
      `sample_unit_no`, not the one(s) that actually collided
      [src/compliance/quality.ts] — deferred, diagnostic quality only, the
      409 itself is correct
- [x] [Review][Defer] A numeric characteristic with no declared
      `instrument_type` is still routed through the instrument-bound
      "result" endpoint's full asset/calibration gate (`kind === 'result'`
      always requires `instrument_asset_id`) [src/compliance/quality.ts
      applyResultBatch] — deferred, needs checking against Group D's
      `inspection_plan_characteristic` schema for whether numeric +
      no-instrument-type is even a legal plan-line combination; related to
      the already-deferred instrument-type-matching item below
- [x] [Review][Defer] `determineSampling`'s "AQL null but inspection_level
      non-null" defensive branch looks unreachable (the invariant is
      already enforced at plan-creation time) and is untested
      [src/quality/sampling.ts] — deferred, dead-code hygiene only
- [x] [Review][Defer] `lockTaskForInspection` reads the task unlocked to
      get `lot_id`, locks that lot row, then re-reads the task `FOR UPDATE`
      without re-verifying the two `lot_id` reads match
      [src/compliance/quality.ts] — deferred, latent TOCTOU only; `lot_id`
      is immutable on a task today so there is no current exploit path

Code review 2026-08-30 (chunked adversarial pass: Blind Hunter + Edge Case
Hunter + Acceptance Auditor, Group C of 5 — the AQL table data module:
`src/quality/aql-tables.ts`, `test/unit/aql-tables.test.ts`). Groups D
(API/read layer + edge/sync) and E (integration tests) not yet reviewed;
status stays `review`. Acceptance Auditor found no AC/Annex violations: all
26 preferred AQLs, all 7 inspection levels, Table I's 15 lot-size bands, and
all 11 Dev-Notes-pinned anchor cells match the spec exactly. Per this
story's own tracked deferral, exact-cell-value transcription accuracy
against the paper standard was excluded from this pass (already logged
below and in deferred-work.md from the dev-story session).

- [x] [Review][Patch] The module's transcription-notes comment undercounts
      its own fabricated placeholder cells: it claims one corner cell per
      table (R at AQL 0.010 on II-A/II-C, R at 0.010 and 0.015 on II-B),
      but the actual data duplicates the `{ac:0,re:1}` placeholder at BOTH
      AQL 0.010 and 0.015 on II-A/II-C, and at 0.010, 0.015 AND 0.025 on
      II-B — found independently by Edge Case Hunter and Acceptance
      Auditor [src/quality/aql-tables.ts] — applied 2026-08-30
- [x] [Review][Patch] A test block in the table-shape test computed a
      `column` array by indexing the 16-entry `CODE_LETTERS` with an index
      meant for a 26-column AQL row (out-of-bounds for i >= 16, silently
      `?? null`), then asserted only the trivially-true `column.length > 0`
      — validated nothing, and the variable was unused afterward
      [test/unit/aql-tables.test.ts] — applied 2026-08-30, removed (the
      surrounding assertions already cover table shape correctly)
- [x] [Review][Defer] Several lookup functions trust caller-supplied enum
      types instead of runtime-validating with the module's own
      `isInspectionLevel`/`isCodeLetter` guards: `codeLetterFor`'s `level`
      param and `singleSamplingPlan`'s `letter` param throw a raw
      `TypeError` on an invalid runtime value instead of a documented
      failure; `tighterAql` silently returns `null` (meaning "already
      tightest") for an unrecognized AQL rather than distinguishing
      invalid input from a real boundary [src/quality/aql-tables.ts] —
      deferred, low real risk since every current call site (Group B)
      pre-validates before calling in
- [x] [Review][Defer] Test-coverage gaps in `test/unit/aql-tables.test.ts`:
      the monotonicity test only checks `ac`, never `re`; the long
      arrow-chain test (`singleSamplingPlan('R','1000','normal')`) asserts
      a tautology true by construction regardless of which letter the
      chain resolves to; no test exercises `singleSamplingPlan`'s
      guard-overflow safety net; `codeLetterFor`'s Table I tests never
      probe a lot-size band boundary (e.g. 500 vs 501) or zero/negative
      input — deferred, bundle into a future test-hardening pass alongside
      the existing table-verification deferral below
- [x] [Review][Defer] `codeLetterFor`'s `Number.isSafeInteger` ceiling
      conflates "lot size too large" with "too small" (same null return)
      for lots above 2^53-1; no structural/type-level safeguard ties
      `resolved_letter` to the correct sample-size table
      (`SAMPLE_SIZES` vs `REDUCED_SAMPLE_SIZES`) beyond the single ternary
      in `singleSamplingPlan` [src/quality/aql-tables.ts] — deferred,
      negligible real-world relevance and no current defect (single call
      site)

Code review 2026-08-30 (chunked adversarial pass: Blind Hunter + Edge Case
Hunter + Acceptance Auditor, Group D of 5 — API/read layer + edge/sync:
`src/api/v1/quality.ts`, `src/read/projections/{qc_sampling_plan,
qc_inspection_result,qc_sampling_switching_state,qc_inspection_task}.ts`,
`src/server.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`,
`edge/src/messages/en.json`). Group E (integration tests) not yet reviewed;
status stays `review`. Acceptance Auditor confirmed route
existence/shape/RBAC, read-scope enforcement, the edge
`CENTRAL_ONLY_OPERATION` gate, the permanent-error-code twin sets, and all
five new event payload shapes match the spec — with one real violation
(the patch below).

- [x] [Review][Patch] `readingsFrom()` used the client-supplied
      `result_id` verbatim when it was a syntactically valid UUID instead
      of always minting a fresh one server-side, violating Task 8's "mint
      `result_id` per reading" instruction. This broke the 200-vs-201
      replay contract on `POST /api/v1/qc/tasks/:taskId/results` and
      `.../observations`: a client resending the same `result_id` on a
      legitimate idempotent retry got misreported as `201 Created`
      instead of `200` — found independently by Blind Hunter (flagged the
      replay-detection logic as "correct only by probabilistic accident")
      and Acceptance Auditor (traced the concrete spec violation and
      exploit) [src/api/v1/quality.ts readingsFrom] — applied 2026-08-30:
      `result_id` is now always `randomUUID()`, matching the sibling
      `determineSamplingBase` route's established pattern; this also
      closes a related Edge Case Hunter finding (duplicate `result_id`
      within one batch), which becomes impossible by construction
- [x] [Review][Defer] `adjustSamplingStateBase` always returns `201`,
      never `200`, on an idempotency-key replay — unlike every sibling
      write handler in this file [src/api/v1/quality.ts]. Unlike the
      `result_id` bug above, `QcSamplingStateAdjustedPayload` has no
      natural per-request marker field to detect replay the way sibling
      routes do; a clean fix needs either a payload-field addition
      (reopens the already-reviewed Group A/B schema) or a new
      replay-detection idiom (e.g. comparing `persisted.created_at`
      against the request's own timestamp) not used anywhere else in the
      codebase — deferred, data correctness is unaffected, only the HTTP
      status code misreports on replay
- [x] [Review][Defer] `determineSamplingBase`'s replay short-circuit
      (`frozen && task.task_status !== 'open'`) has a narrow race window:
      if a concurrent determination commits between this request's task
      fetch and its frozen-plan fetch, this request falls through and
      mints a second `sampling_id`, hitting `uq_qc_sampling_plan_task`
      (409 `QC_SAMPLING_EXISTS`) instead of returning a clean 200 replay
      [src/api/v1/quality.ts] — deferred, self-healing (the domain
      layer's lock and constraint always produce the correct data
      outcome), only a wrong status code under a narrow timing window
- [x] [Review][Defer] `sample_unit_no`/`limit`/`offset` query-param
      regexes have no upper bound, so an extremely long digit string
      could produce an imprecise `Number()` value sent to Postgres
      [src/api/v1/quality.ts listResultsBase, listSamplingStatesBase] —
      deferred, this exact unbounded pattern is already used identically
      at two pre-existing Story 8.1 routes in the same file; fixing only
      the two new routes would create inconsistency with the two existing
      ones

Code review 2026-08-30 (chunked adversarial pass: Blind Hunter + Edge Case
Hunter + Acceptance Auditor, Group E of 5 — the final group, integration
tests: `test/integration/story-8-2.test.ts` (new), `test/integration/
story-8-1.test.ts` and `test/integration/story-1-9.test.ts` (both
modified)). **All 5 chunks now reviewed.** Edge Case Hunter and Acceptance
Auditor independently traced the story-8-1.test.ts SOD-fixture rewrite
against the actual production code change (Binding Scope Decision 12) and
both confirmed it is a legitimate, strictly-stronger adaptation, not a
quiet regression: the old fixture inserted a hand-crafted `domain_events`
row bypassing the API (with an attacker-controlled `recorded_by`); the new
`recordRealResult` helper drives the real routes with a genuinely
registered, calibrated instrument, so `recorded_by` can no longer be
spoofed, and the original test's actor semantics (self-release ->
`SOD_VIOLATION`, different-actor -> 201) are preserved exactly.

- [x] [Review][Patch] The edge central-only sweep test's own title claims
      "every Story 8.2 command except qc.result_recorded is
      CENTRAL_ONLY_OPERATION" but its loop only posted three of the four
      named event types (Binding Scope Decision 8) — `qc.
      sampling_state_adjusted` was never sent to the edge route, so the
      test's coverage claim was false even though the underlying
      production enforcement was already verified correct in the Group D
      pass — found independently by Blind Hunter and Acceptance Auditor
      [test/integration/story-8-2.test.ts] — applied 2026-08-30: added a
      standalone assertion (the event is plan-scoped, `stream_id` is
      `plan_id` not `task_id`, so it doesn't fit the existing task-scoped
      loop) confirming 403 `CENTRAL_ONLY_OPERATION`
- [x] [Review][Defer] AC-proof gaps in `test/integration/story-8-2.test.ts`
      identified by Acceptance Auditor: AC1's "null level defaults to II"
      is never actually exercised by a null-level/non-null-AQL plan
      (every tested plan passes an explicit level string); AC3's
      Ac-0/1-plan switching score is only driven to 4, never to the
      claimed threshold of 30; the inspector-forbidden
      `authorize_reduced` 403 is never checked against `audit_log` the
      way its `resume_inspection` sibling test is; the "two simultaneous
      completions" concurrency test fires both completions against an
      already-completed task, proving double-completion-rejection rather
      than a genuine completion-vs-completion race; Story 8.1's SOD
      fixture only proves conditional release works in
      `sampling_determined`, never in `inspected`, per Task 9's explicit
      checklist item — deferred, bundle into a future test-hardening pass
- [x] [Review][Defer] Missing negative-path/boundary integration tests
      identified by Edge Case Hunter: a genuine same-idempotency-key
      replay of results/observations/completion never asserts the 200
      status; malformed `action`/blank `reason` on the switching-state
      route; empty `readings[]` from an authorized caller; malformed
      query params (`sample_unit_no`, `limit`, `offset`) on GET results;
      404 on a missing task for 5 of 6 task-scoped routes; the
      501-reading cap test doesn't assert its own `error_code`; the
      attribute-line mirror of `QC_RESULT_KIND_MISMATCH`; an
      instrument-bound attribute characteristic; an "up" arrow
      code-letter resolution driven end-to-end (only unit-tested
      today); inspection levels other than `II` never determined
      end-to-end; a real (not random-UUID) characteristic_id from a
      different plan for `QC_CHARACTERISTIC_NOT_IN_PLAN`; a "never
      calibrated" (zero-certificate) instrument distinct from a "lapsed"
      one — deferred, bundle into the same future test-hardening pass
- [x] [Review][Defer] Test-helper quality nits from Blind Hunter:
      `inspectLot`'s multi-line branch computes the wrong required-reading
      count (currently dead/unreachable — every call site uses a
      single-minor-line plan, so no live test is wrong today) and its
      string-based quantity parsing would silently produce `NaN` for a
      differently-formatted `quantity`; `recordRealResult`'s `headers`
      parameter silently doesn't affect the sampling-determination
      sub-call (undocumented, likely intentional); near-duplicate
      instrument-provisioning fixture helpers exist in both
      story-8-1.test.ts and story-8-2.test.ts and could drift
      independently [test/integration/story-8-2.test.ts,
      test/integration/story-8-1.test.ts] — deferred, low value relative
      to cost, bundle into the same future test-hardening pass

## Dev Notes

### Architecture Compliance

- AD-8 (`ARCHITECTURE-SPINE.md`): the write handler checks the calibration
  status projection; rejection is `CALIBRATION_LOCKOUT`; no role overrides;
  escalation expedites, never bypasses. This story adds the in-transaction
  recheck but does not touch `src/compliance/calibration.ts`.
- AD-14: read shared projections, never another module's event stream. Read
  `instrument_register`, `instrument_calibration_statuses`, `asset`,
  `inspection_plan_*`, `qc_inspection_task`, and `lot_master` through their
  accessors.
- AD-16: every command carries an `idempotency_key`; duplicates return the
  original result. Shape validation runs before the key is consumed.
- All security-sensitive checks live in the central seam
  (`src/compliance/quality.ts`) so `POST /api/v1/events` and the edge route
  cannot bypass them; handlers only pre-resolve and pre-check.
- Exact values: `NUMERIC` in SQL, decimal strings in TypeScript. Never
  `Number`, `parseFloat`, or `toFixed` for AQL, limits, or measured values.
  Integers (`lot_size`, `sample_size`, Ac, Re, unit numbers) are the only
  numbers handled as JavaScript integers; validate with `Number.isSafeInteger`
  on the parsed decimal string only after proving it has no fractional part.
- Timestamps offset-bearing UTC; `business_date` is not needed by this story.

### Sampling Standard Reference

IS 2500 (Part 1):2000 is the Indian adoption of ISO 2859-1:1999 and is
freely readable at
[law.resource.org IS 2500-1 (2000)](https://law.resource.org/pub/in/bis/S07/is.2500.1.2000.pdf).
Transcribe Table I and Tables II-A, II-B, II-C from that PDF. ISO published a
third edition, ISO 2859-1:2026, in January 2026; its tables and switching
rules are unchanged and it adds skip-lot procedures, which are out of scope.
Pin `standard_ref = 'IS 2500 (Part 1):2000 / ISO 2859-1:1999'` on every
sampling plan.

Table 1 (Sample-size code letters, General Inspection Level II, for the unit
test and for AC1 fixtures) lists the lot-size bands and letters.

| Lot size | Level I | Level II | Level III |
| --- | --- | --- | --- |
| 2 to 8 | A | A | B |
| 9 to 15 | A | B | C |
| 16 to 25 | B | C | D |
| 26 to 50 | C | D | E |
| 51 to 90 | C | E | F |
| 91 to 150 | D | F | G |
| 151 to 280 | E | G | H |
| 281 to 500 | F | H | J |
| 501 to 1200 | G | J | K |
| 1201 to 3200 | H | K | L |
| 3201 to 10000 | J | L | M |
| 10001 to 35000 | K | M | N |
| 35001 to 150000 | L | N | P |
| 150001 to 500000 | M | P | Q |
| 500001 and above | N | Q | R |

Special levels for the same bands, top to bottom: S-1
`A A A A B B B B C C C C D D D`; S-2 `A A A B B B C C C D D D E E E`; S-3
`A A B B C C D D E E F F G G H`; S-4 `A A B C C D E E F G G H J J K`.

Table 2 (Sample sizes per code letter) gives the normal/tightened and reduced
sample sizes.

| Letter | A | B | C | D | E | F | G | H | J | K | L | M | N | P | Q | R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Normal and tightened | 2 | 3 | 5 | 8 | 13 | 20 | 32 | 50 | 80 | 125 | 200 | 315 | 500 | 800 | 1250 | 2000 |
| Reduced | 2 | 2 | 2 | 3 | 5 | 8 | 13 | 20 | 32 | 50 | 80 | 125 | 200 | 315 | 500 | 800 |

Table 3 (Sampling anchors) lists cells the unit test must pin after
transcription. Verify each against the PDF; a transcription that disagrees
with an anchor is wrong until proven otherwise against the standard.

| Table | Letter | AQL | Ac / Re |
| --- | --- | --- | --- |
| II-A normal | L | 1.0 | 5 / 6 |
| II-A normal | L | 2.5 | 10 / 11 |
| II-A normal | L | 4.0 | 14 / 15 |
| II-A normal | L | 6.5 | 21 / 22 |
| II-A normal | K | 1.0 | 3 / 4 |
| II-A normal | J | 1.0 | 2 / 3 |
| II-A normal | J | 2.5 | 5 / 6 |
| II-A normal | H | 1.0 | 1 / 2 |
| II-A normal | G | 1.0 | 0 / 1 |
| II-A normal | F | 1.0 | arrow down to G |
| II-A normal | C | 6.5 | 0 / 1 |
| II-B tightened | L | 1.0 | 3 / 4 |
| II-B tightened | K | 1.0 | 2 / 3 |
| II-B tightened | J | 1.0 | 1 / 2 |
| II-B tightened | H | 1.0 | 0 / 1 |

Rules from the standard the code must implement:

- Arrow cells: use the first sampling plan below (arrow down) or above (arrow
  up) the arrow in the same column, with that row's sample size.
- If the sample size equals or exceeds the lot size, inspect 100%.
- Ac and Re in Tables II-A and II-B always satisfy `Re = Ac + 1`; Table II-C
  has gaps (`Re > Ac + 1`). A reduced-inspection count strictly between Ac and
  Re accepts the lot and reinstates normal inspection.
- Switching (clause 9.3): normal to tightened when 2 of at most 5 consecutive
  original lots are not accepted; tightened to normal after 5 consecutive
  accepted; discontinue when 5 lots are not accepted on tightened (cumulative,
  reset on return to normal); reduced to normal on any not-accepted lot or a
  between-Ac-and-Re count; normal to reduced only with switching score at least
  30 and authority; switching score per the annex item 10.

### Sampling Determined Derived Fields

Server-derived and rejected if declared: `lot_id`, `lot_number`,
`plan_version_id`, `plan_id`, `site_id`, `lot_size`, `aql`,
`inspection_level`, `severity`, `code_letter`, `resolved_code_letter`,
`sample_size`, `acceptance_number`, `rejection_number`, `sampling_basis`,
`standard_ref`, `critical_characteristic_ids`, `determined_by`,
`previous_task_status`, `task_status`.

### Error Code Contract

Table 4 (Error codes) lists every code this story throws or reuses.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `CALIBRATION_LOCKOUT` | 423 | Existing. Instrument not `calibrated` or unknown to the status table. |
| `INSTRUMENT_NOT_FOUND` | 404 | Existing. `instrument_asset_id` has no register row. |
| `INSTRUMENT_REQUIRED` | 400 | Observation used for a characteristic that needs an instrument. |
| `INSTRUMENT_NOT_PERMITTED` | 400 | Instrument-bound result on an instrument-less attribute line. |
| `AQL_NOT_IN_STANDARD` | 400 | AQL is not a preferred value. |
| `INSPECTION_LEVEL_INVALID` | 400 | Level outside the vocabulary. |
| `SAMPLING_LOT_SIZE_INVALID` | 400 | Task quantity is fractional or not positive. |
| `SAMPLING_INSPECTION_DISCONTINUED` | 409 | Switching state is discontinued. |
| `QC_SAMPLING_EXISTS` | 409 | Second sampling plan for a task with a different key. |
| `QC_SAMPLING_REQUIRED` | 409 | Result posted before sampling was determined. |
| `QC_TASK_NOT_OPEN` | 409 | Sampling requested when task is not `open`. |
| `QC_TASK_NOT_OPEN_FOR_RESULTS` | 409 | Result posted after inspection completed. |
| `QC_CHARACTERISTIC_NOT_IN_PLAN` | 400 | Characteristic not in the frozen plan version. |
| `QC_SAMPLE_UNIT_OUT_OF_RANGE` | 400 | Unit number outside the required set. |
| `QC_RESULT_KIND_MISMATCH` | 400 | Numeric/attribute fields do not match the line. |
| `QC_RESULT_UOM_MISMATCH` | 400 | `measured_uom` differs from `limit_uom`. |
| `QC_RESULT_EXISTS` | 409 | Duplicate (task, characteristic, unit). |
| `QC_INSPECTION_INCOMPLETE` | 409 | Required results missing at completion. |
| `REDUCED_INSPECTION_NOT_ELIGIBLE` | 409 | `authorize_reduced` without eligibility. |
| `SAMPLING_INSPECTION_NOT_DISCONTINUED` | 409 | `resume_inspection` when not discontinued. |
| `QC_DERIVATION_MISMATCH` | 409 | Existing. Declared derived field disagrees with server. |
| `APPROVAL_REQUIRED` | 403 | Existing. Actor role not QC Head-level for state actions. |
| `LOCATION_ACCESS_DENIED` | 403 | Existing. Task site outside the actor's scope. |
| `CENTRAL_ONLY_OPERATION` | 403 | Existing. Central-only QC event on the edge route. |
| `DUPLICATE_EVENT` | 409 | Existing. Idempotency key reused with a different payload. |

### Current UPDATE File State and Preservation Rules

- `src/compliance/calibration.ts` (lines 6-7, 21-50): narrows on
  `stream_type 'qc'` and `event_type 'qc.result_recorded'`, requires
  `payload.instrument_id`, throws 423 when `getCalibrationStatus` is not
  `'calibrated'`. Story 7.5 forbids renaming, extending, or changing this
  export. Do not touch it.
- `src/events/store.ts#persistEvent` (455): pre-transaction order is
  `assertQualityForeignStreamRejected` (470), `assertInventoryTagging`,
  `assertCalibrationLockout` (472), then `assertQualityShape` (684) before the
  idempotency key is consumed; in-transaction `applyQualityProjection` (1020);
  23505 mapping at 1517-1597. Add new resolvers to the mapping; do not reorder.
- `src/compliance/quality.ts`: `QUALITY_EVENT_TYPES` (80) and
  `QC_CENTRAL_ONLY_EVENT_TYPES = QUALITY_EVENT_TYPES` (87) must be split;
  `AQL_REGEX` (115) stays as the shape gate and canonical AQL becomes the
  semantic gate; `compareDecimalStrings` (138) is private, export it;
  `knownResultRecorders` (1339) is replaced; `assertQcGateAllows` (1602) is
  untouched.
- `src/events/schema.ts`: registry at 4122-4137; comment at 4115-4117 says
  `qc.result_recorded` is unregistered, update it; `qc.lot_dispositioned`
  stays reserved.
- `src/api/v1/instruments.ts` (194-235, 332): synthetic route and
  `createQcResultHandler` stay unchanged; `src/server.ts:922` mount stays.
- `src/api/v1/quality.ts`: `actorContext` (74), `idempotencyKeyFrom` (108),
  `replayIdOrReject` (118), `auditRejectedAttempt` (144),
  `AUDITED_REJECTIONS` (163), `assertWriteSiteAccess` (690),
  `listQcTasksHandler`/`getQcTaskHandler` (618 area, add site scope).
- `src/sync/upload.ts`: `PERMANENT_ERROR_CODES` (17) and
  `EDGE_QC_EVENT_TYPES` (194-205) with `assertEdgeQcEventAllowed`; the twin
  set lives in `edge/src/sync/connector.ts`; messages in
  `edge/src/messages/en.json` (`errors.<CODE>`).
- `read/projections/qc_inspection_task.sql`: `chk_qc_inspection_task_status`
  admits only `'open'`; widen with drop-then-add inside the guarded `DO $$`
  block; the table is the only QC table with `UPDATE` today.
- `read/projections/inspection_plan_version.sql`: `aql NUMERIC(7,3)`,
  `inspection_level TEXT` (length 16, no vocabulary), pairing check
  `chk_inspection_plan_version_sampling_pairing`.
- `read/projections/inspection_plan_characteristic.sql`: `characteristic_class`
  (`critical`, `major`, `minor`), `result_kind`, `instrument_type TEXT NULL`,
  `lower_limit`, `upper_limit NUMERIC(18,6)`, `limit_uom`,
  `acceptance_criteria`. No per-characteristic AQL exists; do not add one.
- `src/read/projections/instrument_register.ts`:
  `getInstrumentRecordByAssetId(assetId, client?, forUpdate)` (80); register
  has `asset_id UUID UNIQUE`, `instrument_id TEXT`, `location_id`.
- `src/read/projections/instrument_calibration.ts`:
  `getCalibrationStatus(instrumentId, client?)` (83) with `lower()` match;
  status flips only through `POST /api/v1/maintenance/calibration/scan` or the
  admin status route, never by wall clock.
- `test/integration/story-8-1.test.ts` (1829-1846): SOD recorders are seeded
  by direct `INSERT INTO domain_events`; replace with a real result.
- `test/integration/story-1-9.test.ts`: exact sorted route allowlist and
  spine test 4 (`qc_head` cannot override lockout) must stay green.

### Existing Components to Reuse

- `heldLot`, `createPlanVersion` (defaults `aql: '1.000'`,
  `inspection_level: 'II'`), `approveVersion`, `seedDoa`, `provisionUser`,
  `authFor`, `makeRequest` in `story-8-1.test.ts`.
- `createAsset`, `registerInstrument`, `recordCertificate`, `scan`,
  `statusOf` in `story-7-5.test.ts`.
- `rejectDeclaredDerived`, `alreadyPersisted`, `advisoryLock`, `isUuid`,
  `isIsoTimestamp`, `isPositiveQuantity`, the duplicate-conflict resolver
  pattern, and `transitionQcGate` compare-and-set shape.
- `emitNotificationInTransaction` for the not-accepted notification.
- `permittedLocationsForModuleScope(roles, 'qc', scope)` for site checks.
- `config.quality.qcHeadRoles` and `config.quality.inspectionTaskNotificationRole`.

### UX Boundary

- API and central-plane domain work only; no UI, edge screen, or PowerSync
  bucket.
- `EXPERIENCE.md` 5.3 and UJ-QC-01 define the later UI: a per-instrument
  calibration check before measurement, `Measurement n of N` with spec band,
  inline out-of-spec flagging, and lockout copy naming the instrument. Keep
  response payloads rich enough for that screen: every result echoes
  `conforms`, limits, and instrument identity; the sampling response echoes
  `sample_size`, Ac, Re, severity, and the critical characteristic list.
- Error messages are actionable and domain-neutral; the localized text lives
  in `edge/src/messages/en.json` for edge-visible codes.

### Testing Standards

- `node:test`, `node:assert/strict`, `createAppServer(createAppRouter())`,
  real PostgreSQL, `--test-concurrency=1`, run-scoped identifiers, fixed
  anchor dates.
- Exercise dedicated routes for ordinary behavior; use direct `persistEvent`
  or `POST /api/v1/events` only for forgery, derivation, stream-mismatch, and
  replay proofs.
- Assert event count, payload write-backs, projection state, audit rows,
  notification recipient, and absence of partial writes on every rejection.
- The unit test for tables must not reach the database.

### Previous Story Intelligence (Story 8.1)

- The seam pattern that passed review: exact event-type set gated on the `qc`
  stream, foreign-stream rejection before tagging, shape validation before the
  idempotency key, derived fields written back, named constraints mapped to
  stable codes, unique constraints as concurrency backstops.
- Review found and fixed: draft-override fail-open, `source_event_id` storing
  the wrong ID, unverified `uom`, uncaught `RangeError` on out-of-range
  timestamps, AQL regex admitting values above 1000, non-deterministic
  `inspector_user_id`, silent pass on unresolvable lot references, and
  unvalidated `limit`/`offset`. Every one of these classes recurs in this
  story's inputs; guard each explicitly.
- `app_user` has no `UPDATE` on append-only plan tables, so `FOR UPDATE` is
  unavailable there; use `pg_advisory_xact_lock` where a lock on an
  append-only grain is needed (switching state is updatable, so `FOR UPDATE`
  works there).
- `SUM(...)` on `NUMERIC` returns `'0.000000'`, not `'0'`; compare decimal
  strings, never raw text.
- `stock_balance` is keyed by lot number and `lot_master` by UUID; the task
  row carries both. Use `lot_id` for QC rows.
- CRLF: `test/unit/schema-drift.test.ts` has one pre-existing failure
  (`gate_dwell_metric` view) on CRLF checkouts; report it separately.
- Deferred items from the 8.1 review addressed here: SOD via projection
  (L466), `QUALITY_EVENT_TYPES` drift test (L467), explicit
  `requiresBusinessStream` decision (L468), task-read site scope (L478), audit
  `location_id` from the task site (L480). Items to leave alone: `qcGateExclusionSql`
  alias, FEFO lock order, serial-pinned issue, cycle-count gate, `last_issue_at`,
  `gateBusinessDateOf`, edge deny-rule shadowing.

### Git Intelligence

- `462668d 8-1 complete` is the baseline; it added 15 files and modified 23
  (list in the Story 8.1 File List). Working tree was clean at analysis time.
- `9abe8d3` (Story 7.8) is edge-heavy; `b0f2ce8` (Story 6.2) confirms
  `production_order.confirmation_recorded` is material backflush only.
- Stories 7.5 and 7.6 set the precedent that lockout asserts run before the
  idempotency replay short-circuit and that certificate-driven status is the
  only calibration truth.

### Latest Technical Information

- ISO 2859-1:2026 (third edition, January 2026) supersedes ISO 2859-1:1999 at
  ISO; tables and switching rules are unchanged, skip-lot sampling is added.
  BIS has not issued a new IS 2500 (Part 1) edition; IS 2500 (Part 1):2000 with
  Amendment 1 remains the Indian reference. Pin the 1999/2000 tables.
- The lockfile-resolved Node.js, TypeScript, and PostgreSQL versions are
  unchanged since Story 8.1; no dependency change is permitted.

### Dependency Boundary

- No new runtime or dev dependencies. Tables are plain TypeScript data.

## Project Structure Notes

### New Files

- `src/quality/aql-tables.ts`
- `src/quality/sampling.ts`
- `src/quality/switching.ts`
- `read/projections/qc_sampling_plan.sql`
- `read/projections/qc_inspection_result.sql`
- `read/projections/qc_sampling_switching_state.sql`
- `src/read/projections/qc_sampling_plan.ts`
- `src/read/projections/qc_inspection_result.ts`
- `src/read/projections/qc_sampling_switching_state.ts`
- `test/unit/aql-tables.test.ts`
- `test/integration/story-8-2.test.ts`

### Expected Update Files

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/compliance/quality.ts`
- `src/read/projections/qc_inspection_task.ts`
- `src/api/v1/quality.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `read/projections/qc_inspection_task.sql`
- `read/projections/inspection_plan_version.sql`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-8-1.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md` (close and add
  entries in the ledger format)

### Out of Scope

- Accept, reject, partial split, NCR, rework, downgrade, scrap, and
  `qc.lot_dispositioned` (Story 8.3)
- Result corrections, re-inspection, resubmitted lots, double or multiple
  sampling plans, skip-lot procedures, per-characteristic AQLs, and
  nonconformities-per-100-units expression
- Per-parameter calibration ranges and uncertainty budgets (Story 7.5
  deferral); instrument-type matching against the plan line
- Changes to `src/compliance/calibration.ts`, the synthetic result route, or
  calibration status derivation
- CoA/CoC, retention samples, batch release records, holds, recall trace,
  BIS/label masters, witnessed inspections (Stories 8.4 to 8.8)
- Edge UI, PowerSync buckets, offline QC capture, attachments, PDF
- Supplier-scorecard quality-acceptance activation (Story 8.3)

## References

- [Source: `_bmad-output/planning-artifacts/epics.md`, Epic 8, Story 8.2]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md`, FR-Q-03, FR-Q-04, FR-Q-13, FR-M-12, FR-M-13, C-12]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md`, AD-8, AD-14, AD-16, Event Envelope, API Contract]
- [Source: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`, `qc_inspector`, `qc_head`]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md`, sections 5.3 and UJ-QC-01]
- [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md`, Epic 8 AQL carrier decision]
- [Source: `_bmad-output/implementation-artifacts/8-1-inspection-plans-and-qc-gate.md`]
- [Source: `_bmad-output/implementation-artifacts/7-5-calibration-register-and-non-overridable-lockout.md`]
- [Source: `_bmad-output/implementation-artifacts/1-7-calibration-lockout-enforcement.md`]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md`, lines 28, 296-301, 321, 466-480]
- [Source: `src/compliance/calibration.ts#assertCalibrationLockout`]
- [Source: `src/compliance/quality.ts`]
- [Source: `src/events/store.ts#persistEvent`]
- [Source: `src/read/projections/instrument_register.ts`, `instrument_calibration.ts`, `qc_inspection_task.ts`]
- [Source: IS 2500 (Part 1):2000 / ISO 2859-1:1999, Tables I, II-A, II-B, II-C, clause 9.3]
- [Source: [ISO 2859-1:2026](https://www.iso.org/standard/85464.html)]

## Dev Agent Record

### Agent Model Used

Claude Fable 5 `claude-fable-5` (story creation and dev-story implementation,
2026-08-29)

### Implementation Plan

- Task 1 first, as pure data: `src/quality/aql-tables.ts` holds Table I, the
  sample sizes and Tables II-A, II-B, II-C as literal cells (generated once
  from the standard's band structure, checked against every pinned anchor,
  then pasted as data), with `canonicalAql`, `codeLetterFor`,
  `singleSamplingPlan` (arrow resolution) and `tighterAql`.
- Two pure domain modules keep the seam thin: `src/quality/sampling.ts`
  (`determineSampling`, lot-size parsing without `Number` on fractions) and
  `src/quality/switching.ts` (`evaluateOutcome`, `advanceSwitchingState`,
  the two QC Head commands).
- Projections follow the Story 8.1 file conventions (own grants, guarded DO
  blocks, mirrored into `init-db.sql`); the task widening uses the Story 7.8
  drop-and-re-add pattern on `chk_qc_inspection_task_status` plus six
  `ADD COLUMN` guards, and `inspection_plan_version` gains the level
  vocabulary check.
- The seam (`src/compliance/quality.ts`) adds five shape asserts and four
  appliers behind one lock order: task read without lock, lot row
  `FOR UPDATE`, task row `FOR UPDATE`, then the `(plan, site)` advisory lock
  and the switching-state row `FOR UPDATE`. Results and completion both hold
  the task row, so a completion cannot lose a racing result.
- Handlers only pre-resolve (asset to register key), pre-check (site scope,
  QC Head role) and audit; every rejection is re-derived in the transaction.

### Debug Log References

- Workflow customization resolved with no activation prepend or append steps.
- Story key `8-2-aql-sampling-and-result-capture` taken from user argument;
  sprint status confirmed `backlog` and Epic 8 `in-progress`.
- Four parallel research agents covered the Story 8.1 code map, the
  calibration and asset substrate, PRD/architecture/UX extraction, and
  deferred-work and git state. Story 8.1 was found committed at `462668d`.
- Web verification: ISO 2859-1:2026 third edition published January 2026 with
  unchanged tables plus skip-lot; a widely copied online AQL chart was found
  to mislabel its AQL columns, which is why the anchor table above is pinned
  and the PDF is named as the transcription source.
- Dev-story 2026-08-29: the IS 2500 PDF at law.resource.org is a scanned
  image (no extractable text) and every fetched online chart disagreed with
  the pinned anchors (one placed letter A at AQL 2.5 on Ac 0 / Re 1), so the
  tables were transcribed from the standard's band structure and pinned to
  all fifteen anchors in `test/unit/aql-tables.test.ts`. The four corner
  cells the standard resolves via letter S (n = 3150) are recorded as
  Ac 0 / Re 1 at letter R; see the deferred-work ledger.
- `npm run db:migrate` needs `--env-file=.env.test` on this machine (the
  bare script has no env file and fails on `AUTH_MODE=oidc`); run as
  `node --env-file=.env.test --import tsx src/events/migrate.ts` twice, both
  clean.
- The instrument register canonicalizes `instrument_id` to lower case (Story
  7.5); result rows and event payloads carry the register's form, and the
  Story 8.2 suite reads it back from the registration response.
- `format:check` reports four files untouched by this story that already
  fail at baseline `462668d`; left as-is and logged in the ledger.

### Completion Notes List

- Task 1: `src/quality/aql-tables.ts` (26 preferred AQLs, 7 levels, 16
  letters, 15 bands, Table I for all levels, Tables II-A / II-B / II-C as
  `{ ac, re } | 'down' | 'up'` cells, `STANDARD_REF`), unit test 8/8.
- Task 2: `qc_sampling_plan.sql`, `qc_inspection_result.sql`,
  `qc_sampling_switching_state.sql`; `qc_inspection_task.sql` widened
  (status vocabulary, six additive columns, outcome check);
  `inspection_plan_version.sql` level vocabulary; all mirrored into
  `init-db.sql`; registered at the migration tail; schema-drift pins added
  (125 pass, the pre-existing CRLF `gate_dwell_metric` failure reported
  separately).
- Task 3: accessors for the three projections; `qc_inspection_task.ts`
  widened (`QcTaskStatus`, additive columns, `task_status` and `site_ids`
  list filters, `transitionQcTaskStatus` compare-and-set).
- Task 4: five typed payloads and registry entries on `streamType: 'qc'`
  with `requiresBusinessStream: false`; `qc.result_recorded` registered with
  the full shape while the synthetic shape stays valid; `QUALITY_EVENT_TYPES`
  widened, `QC_CENTRAL_ONLY_EVENT_TYPES` explicit; registry drift test
  `test/unit/quality-event-registry.test.ts` 2/2.
- Task 5: `determineSampling` plus `applySamplingDetermined`; canonical AQL
  and level vocabulary also enforced on `qc.inspection_plan_created`
  (`AQL_NOT_IN_STANDARD`, `INSPECTION_LEVEL_INVALID` at plan creation).
- Task 6: `applyResultBatch` shared by results and observations (state,
  plan line, unit range, kind and uom pairing, instrument binding with the
  in-transaction calibration recheck, `INSTRUMENT_REQUIRED` /
  `INSTRUMENT_NOT_PERMITTED`, server-derived `conforms`, duplicate pre-check
  plus the `uq_qc_inspection_result_unit` race mapping); the synthetic branch
  is validated for the Story 1.7 nonblank fields only and never applied.
- Task 7: `evaluateOutcome` and `advanceSwitchingState` (clause 9.3, the
  9.3.3.2 score with the conservative arrow rule), `applyInspectionCompleted`
  (completeness gaps, outcome, state advance, task transition, not-accepted
  notification), `applySamplingStateAdjusted` (QC Head-level roles from
  config, never a hard-coded role); unit test 5/5.
- Task 8: eight routes registered static-before-parameterized; task-scoped
  reads and both list routes are site-scoped; `listQcTasksHandler` and
  `getQcTaskHandler` gain the read-scope check; `CALIBRATION_LOCKOUT` and
  `APPROVAL_REQUIRED` audited with `location_id` from the task site and the
  instrument identity in details; edge permanent codes added to both twin
  sets and `en.json`; Story 1.9 allowlist extended (spine 6/6).
- Task 9: SOD reads `qc_inspection_result.recorded_by`; the Story 8.1 SOD
  test records a real result through the new routes and proves conditional
  release in `sampling_determined` (story-8-1 31/31).
- Task 10: `test/integration/story-8-2.test.ts` 12/12 (AC1 to AC5,
  concurrency, read scope, edge classification, RBAC sweep);
  `test/unit/sampling-switching.test.ts` 5/5. Gates: `npm run build`,
  `npm run lint` clean; `format:check` clean on every touched file; migrate
  twice clean; story-1-7 8/9 with the same single pre-existing failure as
  baseline (`INVALID_EVENT_STREAM` on a direct maintenance write); story-7-5
  36/36; edge typecheck, lint, tests 45/45 and build clean.
- Full backend suite (`npm test`): 1343 tests, 1315 pass, 28 fail, zero new.
  Every failure was re-run in isolation at pristine `462668d` (working tree
  stashed) with the same result: story-2-5 4/19 (INSUFFICIENT_STOCK on the
  transfer fixtures), story-2-8 23/24, story-3-10 2/3, the known
  idempotency / DUPLICATE_EVENT family (1-7, 2-1, 2-2, 2-3, 2-4), and the
  CRLF `gate_dwell_metric` drift check. Table 5 (Full-suite failure map)
  below lists them by suite.

Table 5 (Full-suite failure map) lists the pre-existing failures observed on
2026-08-29 with and without this story's changes.

| Suite | Failing | Baseline `462668d` | Cause |
| --- | --- | --- | --- |
| story-1-7 | 1 | 1 | `INVALID_EVENT_STREAM` on a direct maintenance write |
| story-2-1, 2-2, 2-3, 2-4 | 7 | 7 | Idempotency replay family (`DUPLICATE_EVENT` 409 vs replay) |
| story-2-5 | 15 | 15 | Transfer fixtures fail `INSUFFICIENT_STOCK` (UUID / number lot key) |
| story-2-8 | 1 | 1 | Agreement idempotency replay |
| story-3-10 | 1 | 1 | Cross-dock completion |
| schema-drift | 1 | 1 | CRLF `gate_dwell_metric` view body |
| story-8-1 | 0 | 0 | 31/31 after the SOD repoint |
| story-8-2 | 0 | n/a | 12/12 |

### File List

New files:

- `src/quality/aql-tables.ts`
- `src/quality/sampling.ts`
- `src/quality/switching.ts`
- `read/projections/qc_sampling_plan.sql`
- `read/projections/qc_inspection_result.sql`
- `read/projections/qc_sampling_switching_state.sql`
- `src/read/projections/qc_sampling_plan.ts`
- `src/read/projections/qc_inspection_result.ts`
- `src/read/projections/qc_sampling_switching_state.ts`
- `test/unit/aql-tables.test.ts`
- `test/unit/sampling-switching.test.ts`
- `test/unit/quality-event-registry.test.ts`
- `test/integration/story-8-2.test.ts`

Modified files:

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/compliance/quality.ts`
- `src/read/projections/qc_inspection_task.ts`
- `src/api/v1/quality.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `read/projections/qc_inspection_task.sql`
- `read/projections/inspection_plan_version.sql`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-8-1.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/8-2-aql-sampling-and-result-capture.md`

## Change Log

| Date | Change |
| --- | --- |
| 2026-08-29 | Story created via create-story workflow; status ready-for-dev. |
| 2026-08-29 | Dev-story: all 10 tasks implemented from baseline 462668d; status review. |
| 2026-08-30 | Code review (chunked adversarial pass, 5 groups: Blind Hunter + Edge Case Hunter + Acceptance Auditor over schema/projections, sampling/switching domain logic, the AQL table data module, the API/read layer + edge/sync, and integration tests). 1 decision-needed resolved (deferred), 11 patches applied, 23 deferred, ~50 dismissed. Verified full suite 1332/1360 (28 pre-existing failures, 0 new), story-8-2 12/12, story-8-1 31/31, build/typecheck clean, migrate x2 idempotent; status done. |

The Change Log table above lists every status transition of this story.
