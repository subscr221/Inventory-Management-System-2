---
baseline_commit: 1952b48
---

# Story 8.3: Lot Disposition - Accept, Reject, Conditional Release

Status: done

## Story

As a QC inspector,
I want exactly one recorded disposition per lot with partial-split support and
NCR outcomes that route to rework, downgrade, or scrap,
so that every lot has a single authoritative quality outcome.

## Acceptance Criteria

1. **Given** a lot whose inspection task has reached `task_status = 'inspected'`,
   **when** a disposition is recorded, **then** exactly one disposition row per
   `lot_id` is stored (`accept`, `reject`, `conditional_release`, or `split`),
   the task's `gate_status` moves to the matching terminal state, and a second
   disposition attempt for the same lot is rejected with
   `error_code: "DISPOSITION_EXISTS"` (HTTP 409) carrying the existing
   `disposition_id`, both sequentially and under concurrency. [FR-Q-05]
2. **Given** a lot where only part of the quantity conforms, **when** the
   inspector splits the lot, **then** two or more child lots are created with
   independent inspection tasks that inherit the parent's frozen
   `plan_version_id`, sampling identity, and inspection attribution, the sum of
   the child quantities equals the parent lot quantity
   (`QC_SPLIT_QUANTITY_MISMATCH` otherwise), a split whose total exceeds the
   parent lot's unallocated owned on-hand stock is rejected with
   `error_code: "INSUFFICIENT_STOCK"` (HTTP 409) with no partial write, the
   parent's stock is relabelled onto the child lots inside the same
   transaction, and each child is dispositioned independently. [FR-Q-05]
3. **Given** a lot dispositioned `reject`, **when** the disposition is
   recorded, **then** exactly one open NCR row is created for that lot, and a
   later outcome command sets the outcome exactly once
   (`NCR_OUTCOME_EXISTS` on a second attempt) to `rework`, `downgrade`, or
   `scrap`; a `scrap` outcome records the scrap disposition, holds the lot
   (`lot_master.quality_hold_status = 'held'`, reason `scrap_pending`) so no
   consumption path can draw it, and retains the event for Phase 2 FR-SC
   processing. [FR-Q-06]
4. **Given** an NCR outcome of `downgrade`, **when** the outcome is recorded,
   **then** the command names an existing `item_master` SKU distinct from the
   lot's own SKU (`DOWNGRADE_SKU_REQUIRED` / `DOWNGRADE_SKU_INVALID`
   otherwise), a downgrade child lot is created at that SKU, the rejected
   lot's stock is relabelled onto it in the same transaction, and the child
   lot carries no QC task and is therefore ungoverned sellable seconds stock.
   [FR-Q-06]
5. **Given** an NCR outcome of `rework`, **when** the outcome is recorded,
   **then** the lot is flagged for rework on the NCR row and a
   `qc.rework_requested` event is persisted in the same transaction as the
   outcome event; a synthetic subscriber test proves the contract shape before
   Story 6.3 lands. [FR-Q-06]
6. **Given** any disposition or NCR command, **when** it is issued by an actor
   without `qc` write access to the task's site, on a lot under an independent
   manual or recall hold, on a task that is not `inspected`, or through
   `POST /api/v1/edge/events`, **then** it is rejected fail-closed with
   `LOCATION_ACCESS_DENIED`, `LOT_ON_HOLD`, `QC_INSPECTION_REQUIRED`, or
   `CENTRAL_ONLY_OPERATION` respectively, nothing persists, and the rejected
   attempt is written to the statutory audit log with actor, task, lot,
   endpoint, trace ID, and error code. [FR-Q-05, FR-Q-13]
7. **Given** an accepted lot, **when** any consumption path evaluates the QC
   gate, **then** `gate_status = 'accepted'` is the only gate state that leaves
   `QC_GATE_BLOCKED_STATUSES`; `rejected` and `split` block exactly as
   `qc_hold` does, an accepted lot under a manual hold still blocks with
   `LOT_ON_HOLD`, and every Story 8.1 and 8.2 gate behaviour is otherwise
   unchanged. [FR-Q-02, FR-Q-05]
8. **Given** a recorded disposition, **when** a supplier scorecard
   quality-acceptance metric names that disposition, **then** the Story 4.2
   applier no longer no-ops: it re-derives the metric from the
   `qc_lot_disposition` projection inside the transaction and rejects a
   submitted value that disagrees with `SCORECARD_DERIVATION_MISMATCH`.
   [FR-SU-05, FR-Q-05]

## Requirements Added from the Annex

1. A disposition is non-reversible. There is no amend, cancel, or delete route.
   A correction is an Epic 1 exception flow and is out of scope here
   (`EXPERIENCE.md` section 5.3).
2. Disposition is admissible only from `task_status = 'inspected'`. A lot that
   was never inspected, or whose inspection is still open, is
   `QC_INSPECTION_REQUIRED` (409). Conditional release keeps its Story 8.1
   contract and stays admissible from `task_status` `open` or
   `sampling_determined` as well; do not narrow it.
3. Quantities are decimal strings compared with `compareDecimalStrings`. Never
   `Number`, `parseFloat`, or `toFixed` on a quantity. `NUMERIC(18,6)` in SQL.
4. A split produces at least two children and at most 20. Every child quantity
   is strictly positive. Child lot numbers are server-derived as
   `<parent_lot_number>-<NN>` with `NN` zero-padded from `01`; a collision with
   an existing `lot_master.lot_number` is `DUPLICATE_LOT` (409) and fails the
   whole command.
5. A split is only admissible while the parent lot's owned stock is
   unallocated (`allocated = 0` on every parent `stock_balance` row). A
   partially allocated parent is `INSUFFICIENT_STOCK` - a QC-gated lot should
   never be allocated, so this is a fail-closed invariant, not a workflow.
6. Stock relabelling moves quantity grain by grain: for each parent
   `stock_balance` row of `stock_class = 'owned'` ordered by `balance_id`,
   decrement the parent row and receive the same quantity onto the child lot
   number at the same `location_id` and `location_code`. Both sides append a
   `lot_trace` entry (negative on the parent, positive on the child) with the
   disposition event ID.
7. The child inspection task is inserted through the same
   `insertQcInspectionTask` path the completion hand-off uses, with
   `source_completion_type` and `source_completion_id` inherited from the
   parent so `uq_qc_inspection_task_source` would collide. Mint a fresh
   `source_completion_id` per child (a new UUID) and record the parent linkage
   in `qc_lot_split` instead; never weaken the unique constraint.
8. Exactly one NCR per rejected lot (`uq_qc_ncr_lot`). The NCR is created by
   the reject disposition itself, not by a separate raise command, so a
   rejected lot can never exist without its NCR record.
9. The NCR outcome is set exactly once. `outcome IS NULL` means open;
   `NCR_OUTCOME_EXISTS` (409) on a second attempt. There is no reopen.
10. A `scrap` outcome does not move, consume, or destroy stock. It sets the
    manual hold with reason `scrap_pending` and retains
    `qc.ncr_outcome_recorded` as the source document AD-10 requires for the
    Phase 2 (Epic 16) FR-SC intake. Physical disposal is out of scope.
11. A `rework` outcome does not create an order. `qc.rework_requested` is the
    integration contract only; Story 6.3 owns rework-order creation and the
    new lot that re-enters the gate.
12. Every event this story adds is central-only. No edge route, no edge UI, no
    PowerSync bucket, no new permanent error code in the sync twin sets. Prove
    the central-only property with a test rather than assuming the derived
    `QC_CENTRAL_ONLY_EVENT_TYPES` set keeps holding.

## Binding Scope Decisions

1. **Event set.** Four new registered `qc.*` event types:
   `qc.lot_dispositioned` (accept and reject), `qc.lot_split_recorded`,
   `qc.ncr_outcome_recorded`, `qc.rework_requested`. Story 8.1's
   `qc.conditional_release_recorded` is the conditional-release disposition and
   is preserved byte-for-byte in behavior; this story does not re-plumb it.
   `qc.lot_dispositioned` is the name Story 4.2 reserved
   (`src/events/schema.ts:6`, `:1521`, `:4309`) - register it and update those
   three comments.
2. **Shared disposition grain.** `qc_lot_disposition` stays one row per
   `lot_id` under `uq_qc_lot_disposition_lot`. Widen
   `chk_qc_lot_disposition_disposition` to
   `('conditional_release','accept','reject','split')` with a guarded
   drop-then-add block keyed on `pg_get_constraintdef(oid) NOT LIKE '%accept%'`,
   the pattern Story 8.2 used on `chk_qc_inspection_task_status`. `split` is
   the parent lot's authoritative terminal outcome: it is what makes a second
   disposition attempt on a split parent `DISPOSITION_EXISTS`.
3. **Gate vocabulary.** `chk_qc_inspection_task_gate_status` widens to
   `('qc_hold','conditionally_released','accepted','rejected','split')`, same
   guarded drop-then-add. `QC_GATE_BLOCKED_STATUSES` becomes
   `['qc_hold','conditionally_released','rejected','split']`. Only `accepted`
   leaves the blocked set. `QcGateStatus` widens in
   `src/read/projections/qc_inspection_task.ts:20`.
4. **`assertQcGateAllows` is extended, not restructured.** After the existing
   `qc_hold` throw, add explicit arms: `rejected` and `split` throw
   `LOT_ON_HOLD` with `reason: 'rejected'` / `'split'`; `accepted` throws
   `LOT_ON_HOLD` with `reason: 'manual_hold'` when
   `lot_master.quality_hold_status <> 'none'` and otherwise returns. The
   `conditionally_released` branch and every deviation check below it stay
   exactly as they are. Never let the function fall through to the
   conditional-release logic for a new gate state.
5. **Authority.** Accept, reject, split, and NCR outcome require module `qc`
   write access plus write-site scope on the task's `site_id`. No DOA
   transaction type is added: acceptance is the normal path and the DOA gate
   belongs to the exception path (conditional release), which already has it.
   Segregation of duties is NOT applied to accept or reject - UJ-QC-01 has the
   same inspector record results and decide. `knownResultRecorders` is still
   read, but only to derive `inspector_user_id` deterministically
   (`recorders[0] ?? null`), exactly as the conditional-release applier does.
6. **No role name is ever hardcoded.** The `no-hardcoded-role-in-workflow`
   lint rule applies. Any role-shaped configuration reads
   `config.quality.*`.
7. **Split is disposition-then-inspect.** The parent is dispositioned `split`
   and its gate becomes `split` (terminal, blocked, no stock left). Each child
   lot gets a fresh task at `gate_status = 'qc_hold'` and
   `task_status = 'inspected'`, inheriting the parent's `sampling_id`,
   `sampling_outcome`, `nonconforming_sample_units`,
   `critical_nonconformities`, `inspected_by`, and `inspected_at`, so each
   child is immediately dispositionable without re-sampling. Re-inspection of
   a child is out of scope.
8. **Downgrade child lots are ungoverned.** A downgrade child lot is created
   at the named seconds SKU with no `qc_inspection_task` row, so
   `assertQcGateAllows` treats it as ungoverned stock and it is sellable. The
   NCR row records `downgrade_sku` and `downgrade_lot_id` for trace.
9. **Scrap uses the existing hold axis.** There is no separate `Blocked` stock
   bucket in this platform. `Blocked` (scrap-pending) is
   `qc_inspection_task.gate_status = 'rejected'` (already blocked) plus
   `lot_master.quality_hold_status = 'held'` with
   `quality_hold_reason = 'scrap_pending'`, written through the existing
   `placeQualityHold` accessor. Do not widen
   `chk_lot_master_quality_hold_status`.
10. **Supplier scorecard activation is derivation-only.** Replace the
    `quality_acceptance` no-op in `src/compliance/supplier-scorecard.ts:191`
    with a real `deriveMetric` arm for the `disposition` reference-entity kind
    (`src/compliance/supplier-scorecard.ts:51`): read the `qc_lot_disposition`
    row `FOR UPDATE`-free by ID, derive `value_num` as `'1'` for `accept` and
    `'0'` for `reject` (a `conditional_release` or `split` reference is
    `SCORECARD_REFERENCE_INVALID`), `business_date` from
    `toIstCalendarDate(decided_at)`, and `reference_event_id` from
    `source_event_id`. The caller still supplies `supplier_id`; this story
    does not invent a supplier link on a QC task, and the existing
    derivation-mismatch guards do the rest.
11. **All new events are central-only** and ride the derived
    `QC_CENTRAL_ONLY_EVENT_TYPES` set (`src/compliance/quality.ts:142`). No
    change to `EDGE_QC_EVENT_TYPES`, `PERMANENT_ERROR_CODES`,
    `edge/src/sync/connector.ts`, or `edge/src/messages/en.json`.
12. **Notifications are transactional.** A disposition is a decision, so
    emission uses `emitNotificationInTransaction` (AD-17), matching
    `src/compliance/quality.ts:1657`, `:1835`, `:2430`.
13. **No dependency changes.** Lockfile-resolved stack only.

## Tasks and Subtasks

- [x] **Task 1: Schema and projections** (AC: 1, 2, 3, 4)
  - [x] Widen `read/projections/qc_lot_disposition.sql`:
        drop-then-add `chk_qc_lot_disposition_disposition` to
        `('conditional_release','accept','reject','split')`, guarded on
        `pg_get_constraintdef(oid) NOT LIKE '%accept%'`. Keep
        `chk_qc_lot_disposition_deviation_pairing` unchanged (it already reads
        `disposition <> 'conditional_release' OR deviation_id IS NOT NULL`).
        Add `ADD COLUMN IF NOT EXISTS` blocks for `sampling_outcome TEXT` and
        `ncr_id UUID` write-backs. Closes the deferred-work entry at
        `deferred-work.md:469`.
  - [x] Widen `read/projections/qc_inspection_task.sql`: drop-then-add
        `chk_qc_inspection_task_gate_status` to the five-state vocabulary,
        guarded on `NOT LIKE '%accepted%'`.
  - [x] New `read/projections/qc_lot_split.sql`: `split_id UUID PK`,
        `parent_lot_id`, `parent_task_id`, `child_lot_id`, `child_lot_number`,
        `child_task_id`, `sequence INTEGER`, `quantity NUMERIC(18,6)`,
        `source_event_id`, `created_at`; `uq_qc_lot_split_child UNIQUE
        (child_lot_id)`, `uq_qc_lot_split_sequence UNIQUE (parent_lot_id,
        sequence)`, `chk_qc_lot_split_quantity CHECK (quantity > 0)`; index on
        `parent_lot_id`. Append-only: `GRANT INSERT, SELECT` to `app_user`.
  - [x] New `read/projections/qc_ncr.sql`: `ncr_id UUID PK`, `lot_id`,
        `task_id`, `disposition_id`, `raised_by`, `raised_at`,
        `outcome TEXT NULL`, `outcome_reason TEXT NULL`, `outcome_by UUID NULL`,
        `outcome_at TIMESTAMPTZ NULL`, `downgrade_sku TEXT NULL`,
        `downgrade_lot_id UUID NULL`, `rework_requested_event_id UUID NULL`,
        `source_event_id`, `outcome_event_id UUID NULL`, `created_at`,
        `updated_at`; `uq_qc_ncr_lot UNIQUE (lot_id)`;
        `chk_qc_ncr_outcome CHECK (outcome IS NULL OR outcome IN
        ('rework','downgrade','scrap'))`; `chk_qc_ncr_outcome_pairing` making
        every outcome column null together and non-null together, and
        requiring `downgrade_sku`/`downgrade_lot_id` exactly when
        `outcome = 'downgrade'` and `rework_requested_event_id` exactly when
        `outcome = 'rework'`. `GRANT INSERT, SELECT, UPDATE` (the outcome is
        the one update).
  - [x] Mirror every new and changed statement into
        `deploy/compose/init-db.sql` verbatim, and register the two new files
        in `src/events/migrate.ts` in dependency order.
  - [x] Write `src/read/projections/qc_lot_split.ts` and
        `src/read/projections/qc_ncr.ts` accessors following
        `src/read/projections/qc_lot_disposition.ts` (a `*_COLUMNS` constant,
        typed row interface, insert and get-by-key functions taking an
        optional `PoolClient`).
  - [x] Widen `QcDisposition` in `src/read/projections/qc_lot_disposition.ts:15`
        and `QcGateStatus` plus `QC_GATE_BLOCKED_STATUSES` in
        `src/read/projections/qc_inspection_task.ts:20,26`. Update the doc
        comment at `:10-12` that currently promises "Story 8.3 introduces the
        accepted state that leaves this set".
  - [x] Extend `test/unit/schema-drift.test.ts` with the two new tables and
        the two widened constraints.

- [x] **Task 2: Event registration and payload contracts** (AC: 1, 2, 3, 4, 5)
  - [x] Register `qc.lot_dispositioned`, `qc.lot_split_recorded`,
        `qc.ncr_outcome_recorded`, and `qc.rework_requested` in
        `SUPPORTED_EVENT_TYPES` (`src/events/schema.ts:4122-4137` area) and
        declare their payload interfaces beside
        `QcConditionalReleaseRecordedPayload` (`src/events/schema.ts:3379`).
  - [x] Update the three reserved-name comments that say
        `qc.lot_dispositioned` is unregistered: `src/events/schema.ts:6`,
        `:1521`, `:4309`.
  - [x] Add the four constants and set members in `src/compliance/quality.ts`
        beside `QC_SAMPLING_STATE_ADJUSTED` (`:125`) and inside
        `QUALITY_EVENT_TYPES` (`:126`). Verify
        `QC_CENTRAL_ONLY_EVENT_TYPES` (`:142`) picks all four up by derivation.
  - [x] Document every server-derived field in each payload doc comment. For
        `qc.lot_dispositioned`: `lot_id`, `lot_number`, `sku`, `site_id`,
        `plan_version_id`, `quantity`, `requested_by`, `approved_by`,
        `doa_entry_id`, `inspector_user_id`, `previous_gate_status`,
        `gate_status`, `ncr_id`, `sampling_outcome`. For
        `qc.lot_split_recorded`: every child `lot_id`, `lot_number`,
        `task_id`, `source_completion_id`, plus `parent_*` and
        `previous_gate_status`. A client that declares any of them is
        `QC_DERIVATION_MISMATCH` (409).

- [x] **Task 3: Shape validation in the central seam** (AC: 1, 2, 3, 4, 6)
  - [x] Extend `assertQualityShape` (`src/compliance/quality.ts:900`) with one
        arm per new type, following the existing arms exactly: reject unknown
        keys, reject declared derived fields, validate UUIDs with
        `UUID_REGEX`, timestamps with the ISO 8601 offset regex, decimal
        quantities with the existing decimal regex, and trim-and-length-check
        every free-text field (`justification`, `outcome_reason`: non-blank,
        at most 2000 characters).
  - [x] `qc.lot_dispositioned`: `disposition` in `{'accept','reject'}`,
        `task_id`, `lot_id`, `disposition_id` minted by the handler,
        `decided_at`, `justification`. On `reject`, `ncr_id` is also minted.
  - [x] `qc.lot_split_recorded`: `task_id`, `lot_id`, `disposition_id`,
        `splits` array of 2 to 20 entries each carrying `sequence` (1-based,
        contiguous, no duplicates) and `quantity`; every other child field is
        derived.
  - [x] `qc.ncr_outcome_recorded`: `ncr_id`, `lot_id`, `outcome` in
        `{'rework','downgrade','scrap'}`, `outcome_reason`, `decided_at`;
        `downgrade_sku` required exactly when `outcome = 'downgrade'`
        (`DOWNGRADE_SKU_REQUIRED` when missing).
  - [x] `qc.rework_requested`: `ncr_id`, `lot_id`, `lot_number`, `sku`,
        `site_id`, `quantity`, `plan_version_id`, `requested_by`,
        `requested_at`. All derived; a direct post declaring them is
        `QC_DERIVATION_MISMATCH`.
  - [x] Confirm shape validation still runs before the idempotency key is
        consumed (`src/events/store.ts:684` order) and that no new assert is
        inserted ahead of `assertCalibrationLockout` (`:472`).

- [x] **Task 4: Disposition appliers** (AC: 1, 3, 6, 7)
  - [x] Add `applyLotDispositioned` to the `applyQualityProjection` switch
        (`src/compliance/quality.ts:2521`). Lock order is the platform's fixed
        order and must not change: `lot_master` row `FOR UPDATE`, then the QC
        task via `getQcInspectionTaskByLotId(lotId, client, true)`, then stock
        rows if any.
  - [x] Fail closed in this order: task exists; `task_id` matches the task
        found by `lot_id`; `task_status = 'inspected'`
        (`QC_INSPECTION_REQUIRED`, 409); `gate_status = 'qc_hold'` or
        `'conditionally_released'` (anything else is `DISPOSITION_EXISTS`);
        `lot_master.quality_hold_status = 'none'` (`LOT_ON_HOLD`, 400); no
        existing `qc_lot_disposition` row for the lot
        (`DISPOSITION_EXISTS`, 409, with `existing_disposition_id`).
  - [x] Write one `qc_lot_disposition` row with `deviation_id = NULL`,
        `quantity` from the task, `inspector_user_id` from
        `knownResultRecorders(taskId, client)[0] ?? null`,
        `approved_by = requested_by = actor`, `sampling_outcome` copied from
        the task. `doa_entry_id` is `NOT NULL` in the existing table - make it
        nullable with a guarded `ALTER COLUMN ... DROP NOT NULL` in Task 1 and
        pair it with the disposition kind in
        `chk_qc_lot_disposition_deviation_pairing`, so an accept or reject
        carries no fabricated DOA reference.
  - [x] Transition the gate through `transitionQcGate`
        (`src/read/projections/qc_inspection_task.ts:254`) to `accepted` or
        `rejected`, writing `gate_changed_at` from the event instant.
  - [x] On `reject`, insert the open `qc_ncr` row in the same transaction and
        write `ncr_id` back onto the disposition row and the payload.
  - [x] Emit the decision notification with `emitNotificationInTransaction`
        (AD-17) to the configured QC role, scoped to the task's `site_id`.
  - [x] Add `resolveQcNcrDuplicateConflict` and extend
        `resolveQcDispositionDuplicateConflict`
        (`src/compliance/quality.ts:2814`) so a concurrent second disposition
        and a concurrent second NCR both resolve to the same 409 body as the
        sequential path. Register the new constraint names in the 23505 chain
        at `src/events/store.ts:1517-1597` without reordering existing entries.

- [x] **Task 5: Split and stock relabelling** (AC: 2)
  - [x] New `src/quality/lot-split.ts` exporting `relabelLotQuantity({
        parent_lot_id, parent_lot_number, sku, target_lot_number, target_sku,
        quantity, event_id, business_stream }, client)`. It locks the parent's
        `stock_balance` rows for `stock_class = 'owned'` `FOR UPDATE` ordered
        by `balance_id`, asserts `allocated = 0` on every row
        (`INSUFFICIENT_STOCK`), sums `on_hand` in SQL as text, compares with
        `compareDecimalStrings`, then drains grain by grain and calls
        `applyStockReceipt` (`src/read/projections/stock_balance.ts:254`) for
        the target lot at the same `location_id` and `location_code`. Append a
        negative and a positive `lot_trace` entry per grain through
        `appendTraceEntry`.
  - [x] `applyLotSplitRecorded`: validate the split set (2 to 20 children,
        contiguous 1-based `sequence`, each `quantity > 0`, sum equals the
        parent task `quantity` by decimal-string comparison, else
        `QC_SPLIT_QUANTITY_MISMATCH`), then for each child in `sequence`
        order: mint `lot_id`, derive `lot_number` as
        `<parent>-<NN>`, `createLot`
        (`src/read/projections/lot_master.ts:70`) - a unique violation is
        `DUPLICATE_LOT` - `relabelLotQuantity`, `insertQcInspectionTask` with
        a fresh `source_completion_id` and the inherited frozen plan and
        inspection columns, and one `qc_lot_split` row.
  - [x] Disposition the parent `split` and transition its gate to `split`.
        Assert the parent's remaining owned `on_hand` is `'0'` by decimal
        comparison after the last child; a non-zero remainder is a bug, not a
        rounding tolerance - throw.
  - [x] Every rejection must leave no partial write. Prove it with a test that
        asserts zero rows in `qc_lot_split`, `lot_master`,
        `qc_inspection_task`, and an unchanged parent `stock_balance` after
        each failure mode.

- [x] **Task 6: NCR outcomes** (AC: 3, 4, 5)
  - [x] `applyNcrOutcomeRecorded`: lock the lot, load the NCR by `ncr_id`
        (`NCR_NOT_FOUND`, 404), reject when `outcome IS NOT NULL`
        (`NCR_OUTCOME_EXISTS`, 409), reject when the NCR's lot does not match
        the payload lot, then update the outcome columns in one statement
        guarded by `WHERE outcome IS NULL` so a concurrent second command
        updates zero rows and raises `NCR_OUTCOME_EXISTS`.
  - [x] `scrap`: call `placeQualityHold`
        (`src/read/projections/lot_master.ts:134`) with reason
        `scrap_pending`. Do not touch stock. The retained event is the AD-10
        source document for Epic 16.
  - [x] `downgrade`: assert `downgrade_sku` exists in `item_master` and is not
        the lot's own SKU (`DOWNGRADE_SKU_INVALID`, 400), mint a downgrade lot
        `<parent>-DG`, `createLot` at the downgrade SKU, `relabelLotQuantity`
        the full quantity onto it, and write `downgrade_lot_id` back. Create
        no QC task for it.
  - [x] `rework`: persist `qc.rework_requested` through `persistEvent` on the
        same client after the outcome event, and write its `event_id` into
        `qc_ncr.rework_requested_event_id`. No order, no lot, no stock move.
  - [x] Emit the outcome notification with `emitNotificationInTransaction`.

- [x] **Task 7: Gate integration and regression guard** (AC: 7)
  - [x] Extend `assertQcGateAllows` (`src/compliance/quality.ts:2609`) per
        Binding Scope Decision 4. Do not reorder or reword any existing throw.
  - [x] Confirm `qcGateExclusionSql`
        (`src/read/projections/qc_inspection_task.ts:322`) needs no edit once
        `QC_GATE_BLOCKED_STATUSES` widens, and that the Epic 2 drain windows,
        `src/compliance/dispatch.ts:41`, `src/compliance/pick.ts:352`, and
        `src/compliance/maintenance-spares.ts:569` all pick the new vocabulary
        up through the shared constant rather than a local literal. Grep for
        literal `'qc_hold'` and `'conditionally_released'` outside the QC
        module and fix any local copy.
  - [x] Re-run the Story 8.1 and 8.2 suites plus the targeted Epic 2, 3, 4, 6,
        and 7 suites named in the Testing section; every one must stay green.

- [x] **Task 8: API routes** (AC: 1, 2, 3, 4, 5, 6)
  - [x] Add to `src/api/v1/quality.ts`, following `recordConditionalReleaseBase`
        and `adjustSamplingStateBase` exactly (`actorContext`,
        `idempotencyKeyFrom`, `assertWriteSiteAccess`, `auditCtxFor`,
        `auditRejectedAttempt` on `AUDITED_REJECTIONS`, the
        `persisted.event_type`/payload identity re-check before responding,
        201 on create and 200 on replay):
    - [x] `POST /api/v1/qc/tasks/:taskId/disposition` (accept or reject)
    - [x] `POST /api/v1/qc/tasks/:taskId/split`
    - [x] `POST /api/v1/qc/ncrs/:ncrId/outcome`
    - [x] `GET /api/v1/qc/ncrs` (site-scoped list, `limit`/`offset` bounded)
    - [x] `GET /api/v1/qc/ncrs/:ncrId`
    - [x] `GET /api/v1/qc/tasks/:taskId/disposition`
  - [x] Add every new code to `AUDITED_REJECTIONS`
        (`src/api/v1/quality.ts:163`) that represents a refused authority or a
        refused state change: `QC_INSPECTION_REQUIRED`, `DISPOSITION_EXISTS`,
        `NCR_OUTCOME_EXISTS`, `INSUFFICIENT_STOCK`, `LOT_ON_HOLD`.
  - [x] Scope every new read through `assertReadSiteAccess` / `scopedSiteIds`
        (`src/api/v1/quality.ts:672-700`) and every write through
        `assertWriteSiteAccess`.
  - [x] Validate `limit` and `offset` as bounded non-negative integers before
        use - the Story 8.1 review found this class of gap twice.
  - [x] Mount in `src/server.ts` after the existing Story 8.2 QC block
        (`src/server.ts:836-841`). ROUTE ORDER MATTERS: register
        `/api/v1/qc/ncrs` before `/api/v1/qc/ncrs/:ncrId`, and keep every new
        `/qc/tasks/:taskId/*` route after the bare `/qc/tasks/:taskId` route,
        exactly as the surrounding blocks document.
  - [x] Update the exact sorted route allowlist in
        `test/integration/story-1-9.test.ts`.

- [x] **Task 9: Supplier scorecard quality-acceptance activation** (AC: 8)
  - [x] Replace the no-op at `src/compliance/supplier-scorecard.ts:191` with a
        real `deriveMetric` arm for the `disposition` reference-entity kind,
        per Binding Scope Decision 10. Keep every existing guard
        (`SUPPLIER_NOT_FOUND`, `SUPPLIER_NOT_ACTIVE`, the supersedes chain,
        the three `SCORECARD_DERIVATION_MISMATCH` checks) untouched and in
        order.
  - [x] Confirm `POST /api/v1/supplier-scorecards/.../metrics` and the trend
        read at `src/api/v1/supplier-scorecards.ts:220` now return real data
        instead of `{ state: 'no_data' }` once a metric exists.
  - [x] Close the `deferred-work.md:194` entry in the ledger format.

- [x] **Task 10: Tests** (AC: 1 through 8)
  - [x] New `test/integration/story-8-3.test.ts` covering, at minimum: one
        accept and one reject end to end with projection, event, audit, and
        notification assertions; `DISPOSITION_EXISTS` sequentially and under
        two concurrent requests; `QC_INSPECTION_REQUIRED` from `open` and from
        `sampling_determined`; a 3-way split with quantity and stock
        assertions on parent and children; `QC_SPLIT_QUANTITY_MISMATCH`;
        `INSUFFICIENT_STOCK` on an over-allocating split and on an allocated
        parent, each with a no-partial-write assertion; independent
        disposition of two children; the three NCR outcomes with their
        distinct side effects; `NCR_OUTCOME_EXISTS`; `DOWNGRADE_SKU_INVALID`;
        the `qc.rework_requested` payload shape read back from
        `domain_events`; gate behaviour proving an accepted lot issues and a
        rejected, split, or manually held lot does not;
        `CENTRAL_ONLY_OPERATION` for all four new types on
        `POST /api/v1/edge/events`; `LOCATION_ACCESS_DENIED` on a foreign
        site; and one supplier-scorecard quality-acceptance metric derived
        from a real disposition.
  - [x] Reuse the Story 8.1 and 8.2 fixtures rather than writing new ones:
        `heldLot`, `seedLotWithStock`, `createPlanVersion`, `approveVersion`,
        `seedDoa`, `provisionUser`, `authFor`, `makeRequest` from
        `test/integration/story-8-1.test.ts`, and the calibrated-instrument
        and inspection-completion helpers from
        `test/integration/story-8-2.test.ts`.
  - [x] Run `npm run build`, `npm run lint`, the typecheck, and
        `npm run db:migrate` twice against a live database to prove
        idempotence, before declaring the story done.

### Review Findings

Code review 2026-08-30, Group A (schema/projections layer only — deploy/compose/init-db.sql,
src/events/schema.ts, src/events/migrate.ts, src/events/store.ts, qc_lot_disposition,
qc_inspection_task, qc_lot_split, qc_ncr sql + read-model .ts). Groups B (domain logic), C
(API/server), D (tests) not yet reviewed.

- [x] [Review][Patch] `NCR_EXISTS` duplicates instead of extending the `DISPOSITION_EXISTS` 23505 arm [src/events/store.ts:1607-1620] — Dev Notes (`:552-555`) explicitly say the 23505 mapping "already contains a DISPOSITION_EXISTS arm... extend it, do not duplicate it," and the Error Code Contract (Table 1, spec lines 516-533) does not list `NCR_EXISTS` at all. A concurrent second reject now throws an undocumented code that `AUDITED_REJECTIONS` won't recognize, risking a statutory audit-log gap on the exact race the contract promises `DISPOSITION_EXISTS` for. Fixed: merged the NCR unique-constraint names into the existing `DISPOSITION_EXISTS` branch and removed the now-unused `resolveQcNcrDuplicateConflict` import.
- [x] [Review][Patch] `chk_qc_lot_disposition_ncr_pairing` is one-directional [read/projections/qc_lot_disposition.sql:55, deploy/compose/init-db.sql] — `CHECK (ncr_id IS NULL OR disposition = 'reject')` permits a `reject` row with `ncr_id IS NULL`, contradicting Annex requirement 8 ("a rejected lot can never exist without its NCR record"). Sibling `chk_qc_lot_disposition_doa_pairing` added in the same diff correctly uses a biconditional; this one should match: `CHECK ((disposition = 'reject') = (ncr_id IS NOT NULL))`. Fixed in both files, plus a guarded drop-then-add upgrade block for any DB where the one-directional definition already applied.
- [x] [Review][Patch] `chk_qc_ncr_downgrade_pairing` has no `downgrade_lot_id <> lot_id` guard [read/projections/qc_ncr.sql:64-68] — checks `downgrade_sku <> sku` but not the analogous lot self-reference, unlike the sibling `chk_qc_lot_split_distinct CHECK (child_lot_id <> parent_lot_id)` added in the same diff for splits. Fixed in both files (new table, direct edit).
- [x] [Review][Patch] `listQcNcrs` accepts both `site_id` and `site_ids` with no mutual-exclusion guard [src/read/projections/qc_ncr.ts:175-182] — if both are supplied they silently AND together; a mismatch yields an empty result with no error instead of surfacing the caller bug. Fixed: throws on both being set.
- [x] [Review][Patch] `listQcNcrs` limit/offset have no finite/integer guard [src/read/projections/qc_ncr.ts:190-191] — `Math.max(params.limit ?? 50, 1)` propagates a `NaN` or fractional caller value straight into the `LIMIT`/`OFFSET` placeholders instead of a clean validation error. Fixed: falls back to the default unless the value is `Number.isInteger`.
- [x] [Review][Patch] Whitespace drift between the two files required to stay byte-identical [deploy/compose/init-db.sql, read/projections/qc_lot_disposition.sql] — an extra blank line after the ncr_pairing guard block in one file but not the other; cosmetic but both files' own header comments insist they must be changed together. Fixed; the two files' `qc_lot_disposition` sections now diff clean.
- [x] [Review][Defer] `getQcNcrById`'s `forUpdate` has no client-required guard [src/read/projections/qc_ncr.ts:135-146] — deferred, pre-existing: matches the unguarded convention already used by its direct sibling `qc_inspection_task.ts` and ~30 other projection files codebase-wide (a smaller subset — cycle_count.ts, transfer_request.ts, inventory_planning.ts, etc. — does guard). A codebase-wide consistency pass is out of scope for this story.

Code review 2026-08-30, Group B (domain logic layer — src/compliance/quality.ts, src/compliance/supplier-scorecard.ts, src/quality/lot-split.ts). Groups C (API/server), D (tests) not yet reviewed.

- [x] [Review][Patch] `applyNcrOutcomeRecorded` never re-derives `lot_master.quality_hold_status`, contradicting AC6's fail-closed guard [src/compliance/quality.ts applyNcrOutcomeRecorded] — AC6: "any disposition **or NCR command**... on a lot under an independent manual or recall hold... rejected fail-closed with `LOT_ON_HOLD`." Its lock query didn't even select `quality_hold_status`, unlike the sibling `lockLotForDisposition`, so a lot placed under an independent hold after its reject disposition could still have rework/downgrade/scrap recorded against it. Fixed: added the same `quality_hold_status` select and `LOT_ON_HOLD` check under the same lock, mirroring `lockLotForDisposition`.
- [x] [Review][Patch] `applyReworkRequested` compares `quantity` and `requested_at` with strict `!==` instead of value-aware comparison, contradicting the project's own documented convention [src/compliance/quality.ts applyReworkRequested] — spec's Previous Story Intelligence explicitly warns "compare with `compareDecimalStrings`, never with `===` on raw text," and `compareDecimalStrings` already exists in this same file. A legitimate client whose `quantity`/`requested_at` string doesn't byte-match the server's canonical `NUMERIC(18,6)::text`/ISO formatting gets a false `QC_DERIVATION_MISMATCH`, permanently blocking the AC5 rework contract for that request. Fixed: `quantity` now compares via `compareDecimalStrings`, `requested_at` via epoch-millis equality; the other derived fields (UUIDs/strings) keep strict equality.
- [x] [Review][Patch] `resolveQcNcrDuplicateConflict` left as dead exported code [src/compliance/quality.ts] — a direct consequence of this story's own Group A review patch (which merged the NCR-race handling into the `DISPOSITION_EXISTS` branch in `store.ts` and removed that file's import, but left the now-unused function and its `getQcNcrByLotId` import behind in this file). Fixed: removed both.
- [x] [Review][Defer] `LOT_ON_HOLD`'s `reason` is hardcoded to `'manual_hold'` regardless of the actual hold cause [src/compliance/quality.ts lockLotForDisposition, applyNcrOutcomeRecorded] — deferred, pre-existing within this same diff (not a new regression); `quality_hold_reason` isn't currently selected in either query, and Table 1 doesn't require the body to distinguish manual from recall holds. Revisit only if a caller needs to distinguish hold causes from the response body.
- [x] [Review][Defer] `applyConditionalReleaseRecorded` was modified despite the story's own "copy structurally and NOT to modify" instruction [src/compliance/quality.ts applyConditionalReleaseRecorded] — deferred, behaviorally harmless: the two added lines (`sampling_outcome: task.sampling_outcome`, `ncr_id: null`) are forced by `insertQcLotDisposition`'s widened parameter shape (Task 1), not a change to conditional-release's own logic. Should have been disclosed as a 4th Debug Log deviation; documentation nit only.
- [x] [Review][Defer] `QC_SPLIT_INVALID` is thrown at three different HTTP statuses (400 shape-validation, 409 business-conflict, 500 defensive-invariant) [src/compliance/quality.ts, src/quality/lot-split.ts] — deferred: the 500 call sites are explicitly commented as asserted-unreachable coding-error guards, and the 400/409 split (malformed input vs. reachable state conflict) is a defensible existing pattern; a one-code-one-status normalization is a design-level call beyond this review round.
- [x] [Review][Defer] Split/downgrade relabel trace attributes the whole moved quantity to a single `location_id` when more than one stock location contributed, and silently skips the trace entirely for a second-generation relabel (splitting/downgrading a lot that is itself a split child or downgrade lot) [src/compliance/quality.ts, src/quality/lot-split.ts] — deferred, same root cause as the already-logged deferred-work entry on `lot_trace` being one row per event; bundle together.
- [x] [Review][Defer] No UOM-compatibility check before a downgrade relabels quantity onto a different SKU, and the downgrade SKU is validated for existence only (not active/sellable status) [src/compliance/quality.ts applyNcrOutcomeRecorded] — deferred, matches the existence-only validation style used throughout this diff group; no UOM concept appears anywhere else in scope either.

Code review 2026-08-30, Group C (API/server layer — src/api/v1/quality.ts, src/api/v1/supplier-scorecards.ts, src/server.ts). Group D (tests) not yet reviewed.

- [x] [Review][Patch] `recordNcrOutcomeBase`'s replay detection is a check-then-act race that can break the rework companion event under concurrent retries [src/api/v1/quality.ts recordNcrOutcomeBase] — a pre-write `SELECT 1 FROM domain_events WHERE idempotency_key = $1` computed `replayed` outside any lock; two concurrent requests with the same idempotency key both observe zero rows, both mint their own `rework_event_id`, and whichever `qc.ncr_outcome_recorded` insert loses the DB race still tries to persist its own stale `qc.rework_requested` companion event, which `applyReworkRequested` then correctly rejects with `QC_REWORK_NOT_DERIVED` — turning what should be a clean replayed 200 into a 409 failure. All three review layers converged on this independently. Fixed: the outcome event now mints its own `event_id` up front (the same idiom `reworkEventId`/`replayIdOrReject` already use elsewhere in this file) and `replayed` is derived from comparing it to what `persistEvent` actually persisted — race-free, since `persistEvent`'s own idempotency-key/event_id pre-check plus 23505 conflict handling is the single source of truth.
- [x] [Review][Patch] Stale `NCR_EXISTS` entry left in `AUDITED_REJECTIONS` [src/api/v1/quality.ts] — a direct leftover from this story's own Group A review patch (which merged the NCR-race handling into `DISPOSITION_EXISTS` and eliminated the `NCR_EXISTS` code entirely; confirmed zero remaining throw sites). Fixed: removed the dead entry.
- [x] [Review][Patch] `recordQualityAcceptanceMetricBase`'s response echoes the request body's `supplier_id`/computed `value_num` instead of what was actually persisted [src/api/v1/supplier-scorecards.ts recordQualityAcceptanceMetricBase] — the idempotency key is derived from `disposition_id` alone, so a retried call with a corrected `supplier_id` silently discards the correction (the original event wins) but the 201 response still echoed the request's own `supplier_id`, misrepresenting what was actually recorded. Fixed: the response now reads `supplier_id`/`value_num` from `persisted.payload`.
- [x] [Review][Defer] `recordQualityAcceptanceMetricBase` has no try/catch, so a thrown `AppError` (e.g. the seam's own documented `SCORECARD_DERIVATION_MISMATCH`, or `DUPLICATE_EVENT`) surfaces as a generic 500 via the server's top-level catch-all instead of its correct status/code, and is never audited via `AUDITED_REJECTIONS` [src/api/v1/supplier-scorecards.ts] — deferred, pre-existing file-wide pattern: none of this file's four metric-write routes uses `try`/`sendAppError`; all rely on `sendRequestError` for validation-shaped rejections only. Not a regression introduced by this story; fixing it properly means touching all four routes.
- [x] [Review][Defer] `recordQualityAcceptanceMetricBase` performs no site-scoping check before writing a scorecard metric against an arbitrary disposition [src/api/v1/supplier-scorecards.ts] — deferred, pre-existing file-wide pattern: none of this file's routes (on-time-delivery, price-variance, responsiveness, quality-acceptance) site-scope. Revisit only if supplier scorecards are given a site dimension.
- [x] [Review][Defer] `recordQualityAcceptanceMetricBase` always responds `201`, never `200`, on an idempotency-key replay [src/api/v1/supplier-scorecards.ts] — deferred, matches the already-accepted precedent logged for Story 8.2's `adjustSamplingStateBase` (same class of gap, same deferred-work ledger).

Code review 2026-08-30, Group D (tests — test/integration/story-8-3.test.ts, test/integration/story-1-9.test.ts, test/integration/story-4-2.test.ts, test/unit/quality-event-registry.test.ts). All four groups now reviewed.

- [x] [Review][Patch] No test exercised AC6's independent-hold guard on the NCR-outcome route — exactly the path the Group B review found a real bug in (`applyNcrOutcomeRecorded` didn't re-derive `quality_hold_status`) [test/integration/story-8-3.test.ts] — the suite would not have caught that regression and had no guard against it recurring. Fixed: added `'AC6: a lot under an independent manual hold cannot have its NCR outcome recorded'`.
- [x] [Review][Patch] No concurrency/replay test existed for the NCR-outcome route — exactly the path the Group C review found and fixed a check-then-act replay race in (`recordNcrOutcomeBase`) [test/integration/story-8-3.test.ts] — Task 10 requires a concurrency test for `DISPOSITION_EXISTS` but the equivalent for the NCR-outcome route was missing entirely. Fixed: added `'AC3: two concurrent identical-key rework outcomes on one NCR never produce a stale-replay QC_REWORK_NOT_DERIVED'`, tolerant of either legitimate outcome ordering (true replay or sequential NCR_OUTCOME_EXISTS) but asserting the old bug's specific symptom never recurs.
- [x] [Review][Defer] Broad test-coverage gaps surfaced by all three review layers, none tied to a confirmed application bug [test/integration/story-8-3.test.ts] — deferred as a bundle, itemized for a future test-hardening pass:
  - No test exercises a `conditional_release` disposition through the new `disposition()`/`split()` helpers even though the AC8 test title names it (`disposition()` is typed `'accept'|'reject'` only).
  - `LOCATION_ACCESS_DENIED` and the manual-hold guard are proven for `disposition()` only, never repeated for `split()`/`ncrOutcome()`.
  - No forgery test (direct POST to `/api/v1/events`) for `qc.lot_dispositioned`, `qc.lot_split_recorded`, or `qc.ncr_outcome_recorded` themselves — only `qc.rework_requested` and `supplier_scorecard.metric_recorded` get one.
  - No idempotency-key test for `disposition()`/`split()` (only `ncrOutcome()`, after this pass's fix).
  - No malformed-input test for the three new routes (invalid `disposition` enum, missing `justification`, invalid `outcome`).
  - `QC_SPLIT_INVALID`/`QC_SPLIT_QUANTITY_MISMATCH`/allocated-`INSUFFICIENT_STOCK` tests don't assert all four no-partial-write tables Task 5 specifies (`qc_lot_split`, `lot_master`, `qc_inspection_task`, `stock_balance`); the over-allocating (as opposed to allocated-parent) `INSUFFICIENT_STOCK` scenario is untested.
  - No success-path test asserts an `audit_log` row (accept/reject/split/NCR-outcome) or a `notification.created` event (reject/split/NCR-outcome) — only the accept path and one failure path check these.
  - `DUPLICATE_LOT` and `NCR_NOT_FOUND` have zero test coverage.
  - Split-child inheritance asserts only `plan_version_id`/`quantity`/`inspected_by`; `sampling_id`, `sampling_outcome`, `nonconforming_sample_units`, `critical_nonconformities`, `inspected_at` are never checked.
  - Task 10's named fixture-reuse list (`heldLot`, `seedLotWithStock`, etc. from story-8-1/8-2) doesn't exist as exports in either source file, so genuine reuse was structurally impossible; the new file reimplements local equivalents instead — an undisclosed 4th deviation, not logged in the Debug Log.
  - Minor test-quality nits: `countRows`' `table`/`where` arguments are string-interpolated rather than parameterized (currently only literals reach it); `authFor()` casts `res.body['token']` without checking it exists; a stray `assert.ok(config.quality.qcHeadRoles.length > 0)` at the end of the site-scoping/pagination read test is unrelated to that test's stated purpose; the child-lot-number assertion hardcodes single-digit zero-padding (`-0${index+1}`), untested at 10+ children; `quality-event-registry.test.ts`'s drift guard checks combined presence, not that each of the four new types has both a shape assert and an applier separately.

## Dev Notes


### Architecture Compliance

- AD-3: the DOA registry is the only approval resolver. This story adds no DOA
  transaction type and does not fabricate a `doa_entry_id` for accept, reject,
  or split; the column becomes nullable and is paired to the disposition kind.
- AD-10: source-linked scrap intake only. A `scrap` NCR outcome is the source
  document; the retained `qc.ncr_outcome_recorded` event carries
  `ncr_id`, `lot_id`, quantity, and actor so Epic 16 can intake against it.
- AD-12: every security-sensitive check lives in the central seam
  (`src/compliance/quality.ts`) so `POST /api/v1/events` cannot bypass it.
  Handlers pre-resolve and pre-check only; the seam re-derives under lock.
- AD-14: read shared projections, never another module's event stream. Read
  `lot_master`, `stock_balance`, `item_master`, `qc_inspection_task`,
  `qc_inspection_result`, `qc_lot_disposition` through their accessors.
- AD-16: every command carries an `idempotency_key`; a replay returns the
  original result. Shape validation runs before the key is consumed.
- AD-17: disposition and NCR-outcome notifications use
  `emitNotificationInTransaction` because the notification is part of the
  decision.
- Exact values: `NUMERIC` in SQL, decimal strings in TypeScript, compared with
  the exported `compareDecimalStrings` (`src/compliance/quality.ts:201`).
  Integers (`sequence`) are the only JavaScript numbers.
- Timestamps are offset-bearing UTC; the IST business date comes from
  `toIstCalendarDate`, and `gateBusinessDateOf`
  (`src/compliance/quality.ts:2732`) is the gate-side helper.

### Error Code Contract

Table 1 (Error codes for Story 8.3) lists every code this story throws or
reuses. Codes marked Existing must keep their current HTTP status and body
shape.

| **Code** | **HTTP** | **Status** | **Meaning** |
| --- | --- | --- | --- |
| `DISPOSITION_EXISTS` | 409 | Existing | A disposition row already exists for the lot, or the gate has already left `qc_hold` / `conditionally_released`. |
| `QC_INSPECTION_REQUIRED` | 409 | New | Disposition attempted while `task_status` is not `inspected`. |
| `QC_SPLIT_QUANTITY_MISMATCH` | 400 | New | Sum of child quantities does not equal the parent lot quantity. |
| `QC_SPLIT_INVALID` | 400 | New | Fewer than 2 or more than 20 children, non-positive quantity, or a non-contiguous sequence. |
| `INSUFFICIENT_STOCK` | 409 | Existing | Split total exceeds the parent's unallocated owned on-hand, or a parent row is allocated. |
| `DUPLICATE_LOT` | 409 | Existing | A derived child or downgrade lot number already exists. |
| `NCR_NOT_FOUND` | 404 | New | `ncr_id` does not resolve, or resolves to a different lot. |
| `NCR_OUTCOME_EXISTS` | 409 | New | The NCR outcome is already set. |
| `DOWNGRADE_SKU_REQUIRED` | 400 | New | Outcome `downgrade` with no `downgrade_sku`. |
| `DOWNGRADE_SKU_INVALID` | 400 | New | `downgrade_sku` is unknown to `item_master` or equals the lot's own SKU. |
| `LOT_ON_HOLD` | 400 | Existing | Independent manual or recall hold is active, or the gate is `rejected` / `split`. |
| `QC_DERIVATION_MISMATCH` | 409 | Existing | A client declared a server-derived field. |
| `LOCATION_ACCESS_DENIED` | 403 | Existing | The task's site is outside the actor's `qc` scope. |
| `CENTRAL_ONLY_OPERATION` | 403 | Existing | A new `qc.*` type posted to the edge route. |
| `DUPLICATE_EVENT` | 409 | Existing | Idempotency key reused with a different payload. |
| `SCORECARD_REFERENCE_INVALID` | 409 | New | Quality-acceptance metric references a `conditional_release` or `split` disposition. |

### Current UPDATE File State and Preservation Rules

- `src/compliance/quality.ts` (2856 lines). `QUALITY_EVENT_TYPES` (`:126`) and
  the derived `QC_CENTRAL_ONLY_EVENT_TYPES` (`:142`); `compareDecimalStrings`
  (`:201`) is already exported; `assertQualityForeignStreamRejected` (`:267`)
  and `assertQualityShape` (`:900`) are the two pre-transaction gates;
  `resolveQcAuthority` (`:957`) is conditional-release-only and must not be
  called for accept or reject; `knownResultRecorders` (`:1681`) is private and
  read-only here; `applyConditionalReleaseRecorded` (`:1685`) is the applier to
  copy structurally and NOT to modify; `applyQualityProjection` (`:2521`) is
  the switch to extend; `assertQcGateAllows` (`:2609`) is extended per Binding
  Scope Decision 4; the 23505 resolvers start at `:2743`.
- `src/compliance/calibration.ts`: untouched. Story 7.5 forbids renaming,
  extending, or changing `assertCalibrationLockout`.
- `src/events/store.ts`: pre-transaction order is
  `assertQualityForeignStreamRejected` (`:470`), `assertInventoryTagging`,
  `assertCalibrationLockout` (`:472`), then `assertQualityShape` (`:684`)
  before the idempotency key is consumed; in-transaction
  `applyQualityProjection` (`:1020`); 23505 mapping `:1517-1597` already
  contains a `DISPOSITION_EXISTS` arm at `:1594-1597` - extend it, do not
  duplicate it.
- `src/read/projections/qc_inspection_task.ts`: `QcGateStatus` (`:20`),
  `QC_GATE_BLOCKED_STATUSES` (`:26`), `insertQcInspectionTask` (`:214`),
  `transitionQcGate` (`:254`), `transitionQcTaskStatus` (`:284`),
  `qcGateExclusionSql` (`:322`).
- `src/read/projections/qc_lot_disposition.ts`: `QcDisposition` (`:15`),
  `insertQcDeviation` (`:123`), `getQcLotDispositionByLotId` (`:152`),
  `insertQcLotDisposition` (`:176`), `getConditionalReleaseForLot` (`:209`).
- `src/read/projections/lot_master.ts`: `createLot` (`:70`), `updateLot`
  (`:108`), `placeQualityHold` (`:134`), `getLotById` (`:177`).
  `chk_lot_master_quality_hold_status` admits only `none` and `held` - do not
  widen it; `quality_hold_reason` carries `scrap_pending`.
- `src/read/projections/stock_balance.ts`: `applyStockReceipt` (`:254`) is an
  upsert on `(sku, location_id, lot_id, stock_class)`; `available` is a
  generated column and is never written; `stock_balance.lot_id` is the lot
  NUMBER (text), while `qc_inspection_task.lot_id` and `lot_master.lot_id` are
  UUIDs - the task row carries both, use the right one on each side.
- `src/read/projections/qc_inspection_result.ts`: `listResultRecorderUserIds`
  (`:193`) is the SOD and attribution substrate.
- `src/api/v1/quality.ts` (1412 lines): `actorContext` (`:74`),
  `idempotencyKeyFrom` (`:108`), `replayIdOrReject` (`:118`),
  `auditRejectedAttempt` (`:144`), `AUDITED_REJECTIONS` (`:163`),
  `readSiteScope`/`assertReadSiteAccess`/`scopedSiteIds` (`:672-700`),
  `assertWriteSiteAccess` (`:690` area), and the export block at `:1348-1412`
  where every handler is wrapped in `requireRole({ module: 'qc', ... })`.
- `src/compliance/supplier-scorecard.ts`: `METRIC_KINDS` (`:43`), the
  reference-entity map (`:51`), the no-op to replace (`:191`), and the
  derivation-mismatch guards (`:229` onward) that must keep running in order.
- `src/sync/upload.ts`: `PERMANENT_ERROR_CODES` (`:17`) and
  `EDGE_QC_EVENT_TYPES` (`:212`) are unchanged by this story; assert that in a
  test rather than by inspection.
- `read/projections/qc_lot_disposition.sql` and
  `read/projections/qc_inspection_task.sql` both carry header comments that
  already name Story 8.3's widening. Update those comments as part of the
  change so the file stops describing a future state.
- `deploy/compose/init-db.sql` duplicates every projection DDL for first-boot
  container init. Change both files together or `schema-drift` fails.

### Existing Components to Reuse

- Appliers: copy the structure of `applyConditionalReleaseRecorded`
  (`src/compliance/quality.ts:1685`) - lock lot, lock task, re-derive, insert,
  transition, notify.
- Routes: copy `adjustSamplingStateBase` (`src/api/v1/quality.ts:1270`) for
  the persist-then-verify-then-respond shape and the `auditRejectedAttempt`
  catch block.
- Stock: `applyStockReceipt` for the credit side; the locked-drain SQL in
  `applyStockIssue` (`src/read/projections/stock_balance.ts:372`) is the model
  for the debit side, minus the QC-gate exclusion (a split is a QC-owned move,
  so it must see its own gated stock - do not splice `qcGateExclusionSql` into
  the split drain).
- Trace: `appendTraceEntry` (`src/read/projections/lot_trace.ts:66`).
- Notifications: `emitNotificationInTransaction` from `src/notify/emit.js`.
- Test fixtures: `heldLot` (`test/integration/story-8-1.test.ts:394`),
  `seedLotWithStock`, `completionBody`, `submitCompletion`,
  `calibratedInstrumentAsset` (`:436`), and the Story 8.2 sampling and
  inspection-completion helpers.

### Previous Story Intelligence

- Story 8.1 and 8.2 reviews found the same defect classes repeatedly. Guard
  each one explicitly here: fail-open on an override branch, `source_event_id`
  storing the wrong ID, unverified `uom`, an uncaught `RangeError` from
  `new Date()` on an out-of-range timestamp, non-deterministic actor
  attribution, silent pass on an unresolvable lot reference, and unvalidated
  `limit`/`offset`.
- `app_user` has no `UPDATE` on append-only tables, so `FOR UPDATE` is
  unavailable there. `qc_inspection_task`, `lot_master`, `stock_balance`, and
  the new `qc_ncr` are updatable, so `FOR UPDATE` works on all four. Use
  `pg_advisory_xact_lock` only if a lock on an append-only grain is ever
  needed.
- `SUM(...)` over `NUMERIC` returns `'0.000000'`, not `'0'`. Compare with
  `compareDecimalStrings`, never with `===` on raw text.
- Concurrency proofs need a real unique constraint as the backstop; the
  pre-check and the 23505 path must return the same body.
- `test/unit/schema-drift.test.ts` has one pre-existing failure on the
  `gate_dwell_metric` view under CRLF checkouts. Report it separately; it is
  not caused by this story.
- The full suite at baseline `1952b48` carries 28 known pre-existing failures
  (story-2-5 x15, the idempotency and `DUPLICATE_EVENT` family, story-1-7,
  story-2-8, story-3-10, and the CRLF `gate_dwell_metric` drift). Verify any
  failure against a pristine checkout of `1952b48` before calling it new.

### Git Intelligence

- `1952b48 cR 8-2 complete` is the baseline and the working tree was clean at
  analysis time. It closed the Story 8.2 review with 11 patches and 23
  deferrals.
- `462668d` (Story 8.1) established the QC seam, the gate, and the
  conditional-release disposition. `9abe8d3` (Story 7.8) is edge-heavy and
  irrelevant here. `b0f2ce8` (Story 6.2) confirms production confirmation is
  material backflush only, so no production path posts a disposition.
- Recent QC work sets two precedents this story must follow: widen a CHECK
  constraint with a guarded drop-then-add keyed on `pg_get_constraintdef`, and
  put the authoritative rule in the seam so both event entry points inherit it.

### Latest Technical Information

- No dependency, runtime, or database version changes. The lockfile-resolved
  Node.js, TypeScript, and PostgreSQL versions are unchanged since Story 8.2.
- No external standard governs disposition; ISO 2859-1 applies only to the
  Story 8.2 sampling outcome that this story consumes as an input.

### UX Boundary

- API and central-plane domain work only. No UI, no edge screen, no PowerSync
  bucket.
- `EXPERIENCE.md` section 5.3 and UJ-QC-01 define the later screen: a single
  disposition form with Accept, Reject, and Conditional as mutually exclusive
  choices, a non-reversible confirmation, and an immediate "Cleared for
  Dispatch" reflection on the shipping dashboard. Keep response payloads rich
  enough for it: the disposition response echoes the full disposition row, the
  new `gate_status`, and the `ncr_id` when one was created; the split response
  echoes every child `lot_number`, `task_id`, and quantity.
- Error messages stay actionable and domain-neutral. No edge-visible codes are
  added, so `edge/src/messages/en.json` is unchanged.

### Testing Standards

- `node:test` with `node:assert/strict`, `createAppServer(createAppRouter())`,
  a real PostgreSQL instance, `--test-concurrency=1`, run-scoped identifiers,
  and fixed anchor dates.
- Exercise the dedicated routes for ordinary behaviour. Use direct
  `persistEvent` or `POST /api/v1/events` only for forgery, derivation,
  stream-mismatch, and replay proofs.
- Every rejection test asserts the absence of a partial write: event count
  unchanged, projection rows unchanged, stock balances unchanged.
- Every success test asserts the event row, the payload write-backs, the
  projection state, the audit row, and the notification recipient.
- Regression suites that must stay green: `story-8-1`, `story-8-2`,
  `story-1-7`, `story-1-9`, `story-2-2`, `story-2-3`, `story-3-4`, `story-3-7`,
  `story-4-2`, `story-4-5`, `story-6-1`, `story-6-2`, `story-7-5`, and the
  edge suite.

## Project Structure Notes

### New Files

- `read/projections/qc_lot_split.sql`
- `read/projections/qc_ncr.sql`
- `src/read/projections/qc_lot_split.ts`
- `src/read/projections/qc_ncr.ts`
- `src/quality/lot-split.ts`
- `test/integration/story-8-3.test.ts`

### Expected Update Files

- `read/projections/qc_lot_disposition.sql`
- `read/projections/qc_inspection_task.sql`
- `deploy/compose/init-db.sql`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/compliance/quality.ts`
- `src/compliance/supplier-scorecard.ts`
- `src/read/projections/qc_inspection_task.ts`
- `src/read/projections/qc_lot_disposition.ts`
- `src/api/v1/quality.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`

### Out of Scope

- CoA/CoC, batch release records, retention samples, and the retention floor
  (Story 8.4). An accepted lot is consumable and sellable at this story's
  boundary; the batch release record that Story 8.4 adds is a later gate on
  top, not a change to this one.
- Quality holds, recall trace, CAPA, and repeat-defect enforcement (Story 8.5).
- Statutory release blocks and quality reporting (Story 8.6), BIS licence
  register and label masters (Story 8.7), witnessed inspections and prototype
  stock rules (Story 8.8).
- Rework-order creation and the new lot that re-enters the gate (Story 6.3).
- Physical scrap disposal and the FR-SC intake workflow (Phase 2, Epic 16).
- Re-inspection, result corrections, resubmitted lots, and any reversal of a
  recorded disposition.
- Re-sampling a split child, per-child AQL, and any change to the Story 8.2
  switching state (a split does not count as a new original inspection).
- Any change to `src/compliance/calibration.ts`, the Story 1.7 synthetic
  result route, edge sync, or PowerSync buckets.

## Open Questions for the Product Owner

These do not block implementation; the story proceeds on the stated default.

1. Should a `reject` disposition require a second approver (a DOA transaction
   type) given its financial consequence? Default taken: no, matching UJ-QC-01
   where the inspector both records and decides. Conditional release keeps its
   DOA gate.
2. Should a downgrade child lot re-enter the QC gate at the seconds SKU?
   Default taken: no. It is created ungoverned and sellable, because the
   quality decision has already been made on the parent.
3. Is `<parent_lot_number>-01` an acceptable child lot-number convention, or
   does a site numbering standard apply? Default taken: the derived suffix,
   with `DUPLICATE_LOT` as the collision guard.

## References

- [Source: `_bmad-output/planning-artifacts/epics.md`, Epic 8, Story 8.3]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md`, AD-3, AD-10, AD-12, AD-14, AD-16, AD-17]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md`, section 5.3, section 8.5 UJ-QC-01]
- [Source: `_bmad-output/implementation-artifacts/8-1-inspection-plans-and-qc-gate.md`]
- [Source: `_bmad-output/implementation-artifacts/8-2-aql-sampling-and-result-capture.md`]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md`, lines 194, 469, 489]

### Post-Review Amendment (2026-08-30): segregation of duties on acceptance

Reopened after the Story 8.4 code review, on a product-owner decision recorded in that story's Open
Question 3.

`applyLotDispositioned` accepted a lot signed by whoever recorded its results - the same person could
inspect the lot and approve it. `applyConditionalReleaseRecorded` had always refused that with
`SOD_VIOLATION`, so the exception path was stricter than the normal one, and NFR-SEC-05 ("enforced
segregation of duties") is the only requirement in the project that speaks to it: no Epic 8
acceptance criterion names an approver for either acceptance or release.

`lockLotForDisposition` now returns the full `result_recorders` list, and `applyLotDispositioned`
rejects `SOD_VIOLATION` (409) when the actor appears in it **and** the disposition is `accept`.
Rejects and splits are deliberately left unguarded, with the reasoning stated at the guard.

Two regression tests were added to `test/integration/story-8-3.test.ts` - one proving a recorder
cannot self-approve and that a second party then can, one proving a recorder may still reject their
own lot - plus a dedicated non-recording approver identity threaded through both this file's and
Story 8.4's fixtures. The guard was mutation-verified.

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m] (Claude Opus 5, 1M context) via the bmad-dev-story workflow.

### Implementation Plan

Executed in the story's task order: schema and projections first (so the
appliers had constraints to fail against), then event registration and shape
asserts, then the appliers, then the stock relabel primitive, then the routes,
then the scorecard activation, then the tests. Typecheck ran after every task
and `npm run db:migrate` ran twice after Task 1 to prove idempotence before any
applier was written.

### Debug Log References

Three deliberate deviations from the task text, each forced by an existing
constraint discovered during implementation:

1. **One `lot_trace` row per relabelling event, not a signed pair per grain**
   (Task 5). `idx_lot_trace_event_id` is a UNIQUE index and `appendTraceEntry`
   is `ON CONFLICT (event_id) DO NOTHING`, so a single event can hold exactly
   one trace row. The relabel writes the parent-side negative entry only, and
   the child-side provenance lives in `qc_lot_split` and
   `qc_ncr.downgrade_lot_id`. Logged in the deferred-work ledger.
2. **`lot_trace.business_stream` is resolved from the parent lot's own trace
   history, and the trace is skipped when the lot has none.** The column is NOT
   NULL and the Story 8.3 events carry no business stream of their own;
   fabricating one would be worse than omitting the row.
3. **A rework outcome carries a client-minted `rework_event_id`.** The task
   text assumed a generic scorecard metrics route and an applier that could
   persist its own companion event. An applier cannot call `persistEvent`
   re-entrantly, so the handler mints the companion event id, the outcome
   applier stores it on the NCR, and `applyReworkRequested` refuses any event
   the NCR does not already name (`QC_REWORK_NOT_DERIVED`) while re-deriving
   all ten payload fields.

Two task assumptions were corrected against the codebase:

- Task 9 assumed a generic `POST /api/v1/supplier-scorecards/.../metrics`
  route. Story 4.2 actually ships three kind-specific thin routes and
  deliberately shipped none for quality acceptance, so this story adds the
  fourth: `POST /api/v1/qc/dispositions/:dispositionId/scorecard/quality-acceptance`.
- `DUPLICATE_LOT` is mapped to HTTP 400 by the store's existing
  `uq_lot_master_lot_number` arm, not 409 as the story's error table stated.
  The pre-checks were aligned to 400 so the sequential and race paths agree.

Two existing tests asserted behaviour this story deliberately changes and were
updated rather than worked around:

- `test/unit/quality-event-registry.test.ts` asserted
  `qc.lot_dispositioned` "stays reserved"; it now asserts all four Story 8.3
  types are registered. The set-equality guard itself passed unchanged.
- `test/integration/story-4-2.test.ts` AC6 asserted the quality-acceptance
  applier was a silent no-op; it now asserts that a quality-acceptance event
  with no real disposition behind it is REJECTED with `DISPOSITION_NOT_FOUND`.
  The guarantee it protects (nothing can fabricate quality data) is unchanged
  and strictly stronger.

### Completion Notes List

- All 10 tasks and 65 subtasks implemented and verified.
- New integration suite `test/integration/story-8-3.test.ts`: 22/22 passing,
  covering every AC including the two-concurrent-disposition race, the
  three-way split with stock and child-task assertions, three no-partial-write
  rejection proofs, all three NCR outcomes, the forged `qc.rework_requested`
  rejection, the central-only sweep over all four new event types, the
  accepted-versus-blocked gate matrix, and the scorecard derivation.
- Full suite: 1382 tests, 1355 pass, 27 fail. Every failure is pre-existing at
  baseline `1952b48` and belongs to the documented noise floor: story-2-5 (15),
  the idempotency and `DUPLICATE_EVENT` family (story-1-1, story-1-6,
  story-2-1, story-2-2, story-2-3, story-2-4 x3, story-2-8, story-3-10),
  story-1-7 (direct maintenance-stream writes), and story-5-3. Zero new
  failures.
- The pre-existing `gate_dwell_metric` CRLF failure in
  `test/unit/schema-drift.test.ts` is GONE: mirroring the new DDL required
  rewriting `deploy/compose/init-db.sql`, which normalized its line endings.
  `schema-drift` is now 126/126. The repository is `core.autocrlf=true`, so the
  git diff is content-only.
- `npm run build`, `npm run lint`, `npx tsc --noEmit` all clean.
  `npm run db:migrate` run twice consecutively against a live database with no
  error and no second-run effect.
- No new runtime or dev dependencies. No edge, PowerSync, or
  `edge/src/messages/en.json` change was needed: the new types ride the derived
  `QC_CENTRAL_ONLY_EVENT_TYPES` set and surface no new permanent error code to
  a device, which the integration suite proves rather than assumes.
- Eight items added to the deferred-work ledger; two ledger entries closed
  (`deferred-work.md` lines 194 and 469).

### File List

New:

- `read/projections/qc_lot_split.sql`
- `read/projections/qc_ncr.sql`
- `src/read/projections/qc_lot_split.ts`
- `src/read/projections/qc_ncr.ts`
- `src/quality/lot-split.ts`
- `test/integration/story-8-3.test.ts`

Modified:

- `read/projections/qc_lot_disposition.sql`
- `read/projections/qc_inspection_task.sql`
- `deploy/compose/init-db.sql`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/compliance/quality.ts`
- `src/compliance/supplier-scorecard.ts`
- `src/read/projections/qc_inspection_task.ts`
- `src/read/projections/qc_lot_disposition.ts`
- `src/api/v1/quality.ts`
- `src/api/v1/supplier-scorecards.ts`
- `src/server.ts`
- `test/unit/quality-event-registry.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-4-2.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| **Date** | **Change** | **Author** |
| --- | --- | --- |
| 2026-08-30 | Story created from Epic 8 at baseline `1952b48` | create-story workflow |
| 2026-08-30 | All 10 tasks implemented; 22/22 story tests, 27 pre-existing full-suite failures, 0 new; status moved to review | dev-story workflow |
