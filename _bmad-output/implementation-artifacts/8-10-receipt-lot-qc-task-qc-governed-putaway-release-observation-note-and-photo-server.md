---
baseline_commit: df0bb02a8ca46a1d200e63c24bab0cea3b0d7f61
---

# Story 8.10: Receipt-Lot QC Task, QC-Governed Putaway Release, Observation Note and Photo (server)

Status: done

Baseline commit: `df0bb02` (clean tree, story 4.8 second code review closed)

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created from epics.md Story 8.10 and 8.11, the 2026-10-21 sprint change proposal (Table 1, Table 3, Q33 to Q36), the architecture spine, EXPERIENCE.md QC sections, Stories 8.1, 8.2, 8.3, 8.4, 8.5, 8.9 and 3.11, the current code at `df0bb02`, and `deferred-work.md` rows 583 and the 8.9 damage-release line.

## Story

As the QC head,
I want receipt lots held in ZONE-QC-HOLD to open a real QC inspection task, an accept disposition to release the held putaway, observations to carry text and a photo, and disposition to be QC-head gated,
so that the 8.11 screen can inspect, disposition and release a BIS or quarantine lot.

## Acceptance Criteria

1. **Receipt task creation.** Given a `goods.received` line with `needsQcHold` true (`receiving.ts:1174-1179`: `bis_licence_required`, `quarantine_required`, quarantined lot, or a non-GOOD `line_condition`) and a resolvable lot UUID, when an approved standard inspection plan resolves for the item at the receipt business date, then the receiving transaction inserts a `qc_inspection_task` with `source_completion_type = 'goods_receipt'` and `source_completion_id` equal to the `grn_line_id`, `gate_status = 'qc_hold'`, `task_status = 'open'`, and the frozen plan. A receipt with no resolvable plan or no lot opens no task and never fails the receipt: the held putaway stays held and records the reason on the new `putaway_task.hold_reason` column, and the `qc_hold_placed` notification names it in human wording. A duplicate lot is refused earlier by the stock surface (`createLot`, 400 `DUPLICATE_LOT`), so the `duplicate_lot` hold reason is a defensive backstop that does not fire on the GRN route. Replay is idempotent through the source tuple.

2. **QC-governed putaway release.** Given a `goods_receipt` task, when `qc.lot_dispositioned` accept (or the accepted child of a `qc.lot_split_recorded`) applies, then the held putaway for that GRN line is retargeted to the accepted lot and accepted quantity and released in the same transaction through a nested `goods.putaway_released` event carrying `disposition_id`, which replaces the `receiving.putaway_release` DOA check while `assertDamageCaseAllowsRelease` still runs. A reject leaves the putaway held. Accept on a line with no held putaway (cross-dock) succeeds without a release. Never is a not-usable unit released.

3. **Observation note and photo.** Given a task, when `POST /api/v1/qc/tasks/:taskId/notes` receives `{ note, attachment_id? }` with `note` of at most 1000 characters, then the note and the caller-owned attachment persist on a new append-only `qc_observation_note` row, the results read returns them, and the existing per-characteristic `POST .../observations` batch keeps its current contract. The route is central-only.

4. **QC head gate.** Given `POST /api/v1/qc/tasks/:taskId/disposition` and `/split`, when the authenticated role is not in `config.quality.qcHeadRoles` (default `qc_head`), then the handler pre-check and the seam both return 403 `APPROVAL_REQUIRED` with `{ task_id, qc_head_roles }`, and no role literal appears in the seam. This supersedes `deferred-work.md` row 583 for reject.

5. **Task view and list.** Given `GET /api/v1/qc/tasks/:taskId`, when the task is a `goods_receipt` task, then the view carries the GRN line evidence (`grn_number`, supplier name, received quantity, `line_condition`, `reason_code`, `reason_note`, `reason_photo_ref`, `inspect_on_opening`, `inspect_note`, `inspect_photo_ref`, `material_photo_ref`), the `putaway_task` row (status, `hold_reason`, `from_location_id`, quantity) and the lot's held locations with quantities. List rows gain `disposition`, `disposition_at` and `released_at`, and `gate_status` accepts `accepted`, `rejected` and `split`.

6. **Tests and rehearsal.** Given `test/integration/story-8-10.test.ts` (new) and `deploy/rehearsal/mock/operations-smoke.ts`, when they run, then one approved plan per receipt test item is created, the chain from `goods.received` with `needsQcHold` to task to accept to putaway `ready` passes, and the no-plan fallback, no-lot fallback, reject arm, damage-case-still-blocks arm, non-QC-head 403 arm, split retarget arm and central-only arm are asserted. (Code review 2026-11-20: the integration test seeds plans with direct SQL, not `POST /api/v1/qc/inspection-plans` plus approve, as accepted for a stable fixture; the plan routes remain covered by the Story 8.3 suite.)

## Binding Scope Decisions

Table 1 records the decisions this story makes where the epic text left a gap or cited stale code. Every decision below is binding on the implementation.

Table 1: Binding scope decisions.

| Id | Decision | Rationale |
| --- | --- | --- |
| D1 | `goods_receipt` joins `SOURCE_COMPLETION_TYPES` and the task CHECK; `source_completion_id` is the `grn_line_id` | The source tuple is the replay key and the only stable identity a GRN line has |
| D2 | A new non-throwing `resolveReceiptInspectionPlan` resolves the item's current released BOM revision (`bom.current_revision_id`, `bom_revision.revision_status = 'released'`) and then wraps `resolveInspectionPlanForLot`; `INSPECTION_PLAN_NOT_FOUND`, `_NOT_APPROVED` and `_AMBIGUOUS` become typed no-plan reasons instead of throws | `inspection_plan` has no item-only grain (`inspection_plan.sql:28-46`); a purchase receipt has no BOM of its own, so the item's released specification revision is the only grain that can match |
| D3 | `qc_inspection_task.bom_revision_id` stays NOT NULL and is filled from the resolved plan header | The task must record the revision it is inspected against; nullable is unnecessary once a plan resolves. Owner question Q35 is closed as not needed |
| D4 | A `goods_receipt` completion reuses `qc.completion_received` through `receiveQcCompletion`, with an applier branch that validates item, lot, UOM and business stream but skips BOM derivation and the finished-stock exact-quantity check | One event, one applier, replay-safe; the finished-stock check is a production invariant (`quality.ts:2096-2148`) that receipt stock cannot satisfy by construction |
| D5 | The QC receipt business date is `toIstCalendarDate(occurred_at)`, derived in the applier exactly as today (`quality.ts:2015`), and the seam pre-check uses the same value | `business_date` is a rejected declared-derived field (`quality.ts:722-734`); QC already standardises on IST |
| D6 | No task is opened when the lot already has a QC task (`uq_qc_inspection_task_lot`); the putaway stays held with `hold_reason = 'duplicate_lot'` | The stock surface (`createLot`) refuses a duplicate lot with 400 `DUPLICATE_LOT` before the QC seam runs, so `duplicate_lot` is a defensive backstop, not a reachable branch on the GRN route; the unique violation is never the refusal path (code review 2026-11-20) |
| D7 | `hold_reason` is a closed vocabulary `no_inspection_plan`, `no_lot`, `duplicate_lot`; the human wording lives in the notification and the edge i18n | A free-text column cannot be translated or asserted; the AC wording "no inspection plan" becomes the notification text |
| D8 | The release event gains an optional `disposition_id`; when present `reason_code` must be `qc_accept`, the disposition must be an accepted disposition for the task's lot, the DOA check is skipped, and the damage-case gate still runs | This is the AC's "in place of the DOA check" with an unforgeable, server-loaded proof rather than a caller claim |
| D9 | On an accepted split child the putaway is retargeted (`lot_id` to the accepted child lot number, `quantity` to the accepted child quantity) inside the release applier before the CAS release | A single held putaway covers the whole received quantity; releasing it unchanged would move not-usable units to a shelf |
| D10 | Only the first accepted child of a split can release the putaway; a second accept gets 409 `PUTAWAY_TASK_NOT_HELD` and is recorded in `deferred-work.md` | Partial release across several accepted children is not modelled by `putaway_task`; failing closed is safer than a silent stock move |
| D11 | Free-text notes are a new `qc.observation_note_recorded` event and `qc_observation_note` projection, posted to a sibling `POST .../notes` route | `qc.observation_recorded` is a per-characteristic readings batch with NOT NULL `characteristic_id` and `sample_unit_no` (`qc_inspection_result.sql:23-52`); overloading it would corrupt the result grain |
| D12 | The QC head gate is added to the disposition and split routes and seams only; notes, results and inspection completion remain inspector-level | The AC names disposition and split; widening the gate silently would block inspectors recording evidence |

## Tasks / Subtasks

- [x] Task 1: Add the receipt plan resolver (AC 1)
  - [x] 1.1 In `src/compliance/quality.ts`, add `ReceiptInspectionPlanResolution` (`{ kind: 'plan', resolved: ResolvedInspectionPlan } | { kind: 'no_plan', reason: 'no_released_bom' | 'revision_not_released' | 'inspection_plan_not_found' | 'inspection_plan_not_approved' | 'inspection_plan_ambiguous' }`) and `resolveReceiptInspectionPlan(input: { item_id: string; business_date: string }, client?: PoolClient)`.
  - [x] 1.2 Resolve via existing helpers `getBomByParentItemId` and `getBomRevisionById` (`src/read/projections/bom.ts:120-142`); treat a missing BOM, a null `current_revision_id` or a non-released revision as `no_released_bom` or `revision_not_released`.
  - [x] 1.3 Call `resolveInspectionPlanForLot` with `source_order_type: null` and `source_order_ref: null`; catch `AppError` only for the three plan codes and map them to typed reasons; rethrow every other error.
  - [x] 1.4 Cover each of the five outcomes in the integration suite (Task 8.3); do not add a DB-mocking unit test, since the resolver's behaviour is defined by the plan and BOM projections.

- [x] Task 2: Widen the completion contract for receipts (AC 1)
  - [x] 2.1 Add `'goods_receipt'` to `SOURCE_COMPLETION_TYPES` (`src/compliance/quality.ts:264-268`) and to the `chk_qc_inspection_task_source_type` message.
  - [x] 2.2 Widen `chk_qc_inspection_task_source_type` in `read/projections/qc_inspection_task.sql` (base CHECK at `:73` and the guarded add at `:122-129`) with a guarded `pg_get_constraintdef NOT LIKE '%goods_receipt%'` block, and mirror it verbatim at the tail of `deploy/compose/init-db.sql`.
  - [x] 2.3 Widen `QcCompletionReceivedPayload.source_completion_type` (`src/events/schema.ts:3799-3821`) and `assertCompletionReceivedShape` (`src/compliance/quality.ts:666-735`); keep `bom_revision_id` required and `source_order_type` null for receipts.
  - [x] 2.4 Branch `applyCompletionReceived` (`src/compliance/quality.ts:1995-2215`): when `sourceType === 'goods_receipt'`, load the item by `item_id`, validate lot number and SKU, `business_stream` and `uom` against the item, re-verify that the payload `bom_revision_id` is a released revision (the seam checked it; the applier must not trust it), skip `deriveItemAndSpecification` and the stock query at `:2096-2148`, and resolve the plan with `resolveInspectionPlanForLot` using the payload `bom_revision_id` and the D5 business date.
  - [x] 2.5 Assert the resolved plan's `plan.plan_id` is stable across replay and keep the existing duplicate checks at `:2072-2094`.
  - [x] 2.6 Leave every edge allowlist untouched: `qc.completion_received` stays in `QC_CENTRAL_ONLY_EVENT_TYPES` (`quality.ts:243-245`) and absent from `EDGE_QC_EVENT_TYPES` (`src/sync/upload.ts:345`).

- [x] Task 3: Open the task from the receiving seam with a visible fallback (AC 1)
  - [x] 3.1 Add `read/projections/putaway_task_qc_release.sql` (forward-only, idempotent, header per `grn_line_inspect.sql:1-9`) adding `hold_reason TEXT` with a guarded CHECK on the three D7 values and `released_at TIMESTAMPTZ`.
  - [x] 3.2 Register the file at the tail of `src/events/migrate.ts` (after the Story 8.9 tail at `:336-341`), mirror it verbatim at the tail of `deploy/compose/init-db.sql`, and add a bespoke pin in `test/unit/schema-drift.test.ts` asserting both copies.
  - [x] 3.3 Extend `PutawayTaskRow`, `insertPutawayTask`, `markPutawayReleased` (`src/read/projections/putaway_task.ts:228-246`, set `released_at = now()`) and the list/get projections with `hold_reason` and `released_at`.
  - [x] 3.4 In `applyGoodsReceivedProjection`, after `insertPutawayTask` (`src/compliance/receiving.ts:1501-1515`) and inside the `if (needsQcHold)` block at `:1520`, resolve the lot UUID with `getLotByNumberAndSku(resolvedLotId, sku, client)` and the plan with `resolveReceiptInspectionPlan` at `business_date = toIstCalendarDate(occurredAt)`.
  - [x] 3.5 On `no_lot`, `no_plan` or an existing task for the lot, write `hold_reason`, keep the notification and put the reason in `next_step`; return without a QC event.
  - [x] 3.6 On a resolved plan, call `receiveQcCompletion` (`src/quality/completion.ts:58`) with `client`, a freshly minted `task_id` and `event_id`, and `idempotency_key: 'goods_receipt:<grn_line_id>'`. Replay is safe because `persistEvent` resolves the same key or event id before any applier runs, so a replayed receipt never reaches this line with stale ids; the source tuple is the second backstop. Pass `source_completion_type: 'goods_receipt'`, `source_completion_id: grn_line_id`, the lot UUID and number, `item_id`, `quantity: receivedQty`, `uom: item.uom`, `site_id`, `bom_revision_id: resolved.plan.bom_revision_id`, `completed_at: occurredAt`, `business_stream: item.business_stream`, `correlation_id` and `causation_id`.
  - [x] 3.7 Do not create a task for a cross-dock line (it returns earlier at `receiving.ts:1481-1499`), and do not create one when the lot could not be resolved.

- [x] Task 4: Release the putaway on accept (AC 2)
  - [x] 4.1 Extend `GoodsPutawayReleasedPayload` (`src/events/schema.ts:485-491`) with optional `disposition_id`; extend `assertGoodsPutawayReleasedShape` (`src/compliance/receiving.ts:1555-1565`) with a UUID check and the rule that `disposition_id` requires `reason_code = 'qc_accept'`.
  - [x] 4.2 In `applyGoodsPutawayReleasedProjection` (`src/compliance/receiving.ts:1567-1620`), when `disposition_id` is present load the disposition with `getQcLotDispositionById`, require `disposition = 'accept'`, require its lot to be the task's lot or a child of the task's lot, retarget the held putaway row to that lot number and quantity, skip `assertReleaseApproval`, and always keep `assertDamageCaseAllowsRelease`.
  - [x] 4.3 Add `getPutawayTaskByGrnLineForUpdate` and `getHeldPutawayTaskByLot(lotNumber, siteId, client)` to `src/read/projections/putaway_task.ts`; the release path locks the row after the lot and task locks.
  - [x] 4.4 In `applyLotDispositioned` (`src/compliance/quality.ts:2508-2636`), after the gate transition at `:2591-2600` and before the notification, when `disposition === 'accept'` and the task's source type is `goods_receipt`, resolve the putaway: direct tasks use `source_completion_id`; split children resolve through `getQcLotSplitByChild(lot_id)` (`src/read/projections/qc_lot_split.ts:101`) to the parent task and its source id.
  - [x] 4.5 Emit a nested `goods.putaway_released` on the same client with `stream_type: 'receiving'`, `stream_id: putaway_task_id`, `putaway_task_id`, `grn_line_id`, `reason_code: 'qc_accept'`, `disposition_id`, and the disposition actor as `metadata.actor`; pass the returned event id to `markPutawayReleased` through the applier.
  - [x] 4.6 When no held putaway exists, skip the release and record it in the disposition notification `next_step`; never throw, so a cross-dock or no-lot accept still completes.
  - [x] 4.7 Reject path: no release, no retarget, putaway remains held.
  - [x] 4.8 Record D10 in `deferred-work.md` under a new "Deferred from: dev of 8-10" section.

- [x] Task 5: Observation note and photo (AC 3)
  - [x] 5.1 Add `read/projections/qc_observation_note.sql`: `note_id UUID PRIMARY KEY`, `task_id`, `lot_id`, `note TEXT NOT NULL`, `attachment_id UUID NULL`, `recorded_by UUID NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL`, `source_event_id UUID NOT NULL UNIQUE`, `created_at`; CHECK `char_length(note) BETWEEN 1 AND 1000`; indexes on `(task_id, recorded_at)`; `app_user` INSERT plus SELECT, `readonly_user` SELECT. Append to `src/events/migrate.ts`, mirror in `init-db.sql`, pin in `schema-drift.test.ts` with an `EXPECTED` entry.
  - [x] 5.2 Add `QcObservationNoteRecordedPayload` and the `qc.observation_note_recorded` registry entry (`streamType: 'qc'`, `requiresBusinessStream: false`) in `src/events/schema.ts` beside `qc.observation_recorded` (`:4408-4427`, `:6576-6579`).
  - [x] 5.3 Add the shape assert and `applyObservationNoteRecorded` in `src/compliance/quality.ts`, wired into `applyQualityProjection` (`:4464-4494`) and into the store's assert/apply dispatch beside `QC_OBSERVATION_RECORDED`.
  - [x] 5.4 Add `POST /api/v1/qc/tasks/:taskId/notes` in `src/server.ts` beside the observation route (`:1151`); handler in `src/api/v1/quality.ts` gated `requireRole({ module: 'qc', functionScope: 'write' })`, with site access, `auditCtxFor`, the task lock, the attachment ownership check copied from `src/compliance/damage.ts:1127-1140` (a claimed attachment must belong to the caller; an unclaimed id is allowed). New stable code `QC_NOTE_ATTACHMENT_NOT_OWNED` (403); add `QC_TASK_NOT_FOUND`, `INVALID_PARAMS` and the new code to that file's audited-rejection set.
  - [x] 5.5 Extend `GET /api/v1/qc/tasks/:taskId/results` (`src/api/v1/quality.ts:1296-1333`) with an additive `notes` array read from the new projection; leave the `results` key unchanged.
  - [x] 5.6 Add the exact route to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.

- [x] Task 6: QC head gate (AC 4)
  - [x] 6.1 Add a pre-check to the disposition and split handlers (`src/api/v1/quality.ts:1522-1541`, `:1591-1655`) that mirrors `adjustSamplingStateBase` (`:1428-1438`) and refuses 403 `APPROVAL_REQUIRED` with `{ task_id, qc_head_roles: config.quality.qcHeadRoles }`.
  - [x] 6.2 Add the same check in `applyLotDispositioned` and `applyLotSplitRecorded` after `lockLotForDisposition`, reading the resolved role set from config and emitting no role literal.
  - [x] 6.3 Update `deferred-work.md` row 583 to record that this story overrides the "reject needs no second signature" ruling for receipt and production tasks alike.

- [x] Task 7: Task view and list enrichment (AC 5)
  - [x] 7.1 Extend the task detail handler (`src/api/v1/quality.ts:916-937`) for `goods_receipt` tasks with a `receipt` object built from `getGrnLineById` (`src/read/projections/grn_line.ts:161`) and the GRN header, carrying the fields named in AC 5, plus `putaway` from `getPutawayTaskByGrnLine`.
  - [x] 7.2 Add the held-location read (lot, location code, quantity) with a new `listStockByLot` helper in `src/read/projections/stock_balance.ts`; return it as `hold_locations`.
  - [x] 7.3 Extend `listQcInspectionTasks` (`src/read/projections/qc_inspection_task.ts:184-210`) with a LEFT JOIN to `qc_lot_disposition` (by `lot_id`) for `disposition` and `disposition_at`, and to `putaway_task` for `released_at` on `goods_receipt` tasks; keep the row shape additive.
  - [x] 7.4 Fix the `gate_status` 400 message in `src/api/v1/quality.ts:859-895` to name all five accepted values, and add a regression arm.

- [x] Task 8: Tests (AC 6)
  - [x] 8.1 Create `test/integration/story-8-10.test.ts` using the harness in `test/integration/story-8-9.test.ts:325-400`; include every projection file it seeds, disable audit triggers around `TRUNCATE`, and use run-scoped SKUs and lot numbers.
  - [x] 8.2 Assert the happy chain: receive with `needsQcHold`, task row exists with `source_completion_type = 'goods_receipt'`, sampling, results, inspection completion, QC-head accept, putaway `status = 'ready'` with `released_at` set, and the frozen plan ids.
  - [x] 8.3 Assert the fallbacks: no plan (hold reason `no_inspection_plan`), no lot (`no_lot`), duplicate lot (`duplicate_lot`), each with the receipt still posted.
  - [x] 8.4 Assert reject leaves the putaway `held`; assert an open damage case blocks the accept-release with `DAMAGE_CASE_BLOCKS_RELEASE`; assert non-QC-head disposition and split return 403 `APPROVAL_REQUIRED`.
  - [x] 8.5 Assert split: 80 good plus 20 not usable, accept the good child, putaway `quantity = 80` and `lot_id` equals the child lot, and 20 units remain in ZONE-QC-HOLD.
  - [x] 8.6 Assert central-only: `POST /api/v1/edge/events` with `qc.completion_received` and `source_completion_type = 'goods_receipt'` returns 403 `CENTRAL_ONLY_OPERATION`, and the note route is absent from the edge upload allowlist.
  - [x] 8.7 Add the new event type pin and the three new schema pins (source CHECK, `hold_reason`, `released_at`, `qc_observation_note`) to `test/unit/schema-drift.test.ts`; add the note route to the spine allowlist test.

- [x] Task 9: Rehearsal and records (AC 6)
  - [x] 9.1 Extend `deploy/rehearsal/mock/setup-operations.ts` (inspection-plan seeding at `:314-373`) with one approved plan per receipt test item, and add a `qcReceiptLot` flow to `deploy/rehearsal/mock/operations-smoke.ts` registered in `main()` beside `damageReport`; the flow must `skip(...)` cleanly when an actor or fixture is missing.
  - [x] 9.2 Add the "Deferred from: dev of 8-10" section: D10 second-child accept, the stores-inbox rendering of `hold_reason` (3.14/3.15 are done and server-only here), and the retention-sample question for receipt lots if it surfaces.
  - [x] 9.3 Record the owner questions from the epic note: Q33 (no plan), Q34 (QC head gate), Q35 (bom nullable, closed by D3), Q36 (no lot), each with its ruling above.

## Dev Notes

### Current state of the files being modified

Read these before editing. The epic line numbers are mostly stale; the values below were verified at `df0bb02`.

- `src/compliance/quality.ts`
  - `SOURCE_COMPLETION_TYPES` at `:264-268`; `chk` validation at `:675-683`.
  - `resolveInspectionPlanForLot` at `:1898-1993`: requires a non-null `bom_revision_id`, throws the three plan codes.
  - `applyCompletionReceived` at `:1995-2215`: locks the lot at `:2019`, derives item and BOM at `:2033`, rejects duplicate lot and source at `:2072-2094`, checks finished stock at `:2096-2148`, resolves the plan at `:2150-2160`, inserts the task at `:2163-2187`, notifies at `:2199-2214`.
  - `lockLotForDisposition` at `:2425-2505`; `applyLotDispositioned` at `:2508-2636`; `applyLotSplitRecorded` at `:2639-2894`.
  - `QC_CENTRAL_ONLY_EVENT_TYPES` at `:243-245`; `applyQualityProjection` at `:4464-4494`.
- `src/compliance/receiving.ts`
  - `needsQcHold` at `:1174-1179`; target zone at `:1181-1195`; GRN insert at `:1363-1406`; damage case at `:1408-1434`; putaway insert at `:1501-1515`; `qc_hold_placed` at `:1520-1535`.
  - `assertReleaseApproval` at `:193-206`; `assertGoodsPutawayReleasedShape` at `:1555-1565`; `applyGoodsPutawayReleasedProjection` at `:1567-1620`.
- `src/read/projections/qc_inspection_task.ts`: task columns `:85-89`, by-lot read `:145-157`, by-source read `:159-171`, list `:184-210`, insert `:226-260`.
- `src/read/projections/putaway_task.ts`: `getPutawayTaskByIdForUpdate` `:136-145`, `getPutawayTaskByGrnLine` `:147-156`, `markPutawayReleased` `:228-246`.
- `src/compliance/damage.ts`: `assertDamageCaseAllowsRelease` `:1952-1975`; attachment ownership precedent `:1127-1140`.
- `src/api/v1/quality.ts`: list filters `:851-914`, detail `:916-937`, observations `:1198-1289`, results read `:1296-1333`, QC head pre-check pattern `:1428-1438`, disposition and split `:1522-1541` and `:1591-1655`, holds `:2300-2483`.
- `src/server.ts`: putaway routes `:808-821`; QC routes `:1118-1191`; `GET /qc/tasks` at `:1143` (not `:1137`).

### What must be preserved

- The QC lock order is fixed and documented at `quality.ts:155-166` and `:2417-2424`: `lot_master` first, then the task row, then stock. The putaway row is locked after the task and before any stock write. Never invert this.
- Every projection write happens inside `persistEvent` on the caller's client; no direct insert outside an event. The receiving seam is the producer and rides its own transaction, so the GRN, stock, putaway and QC task commit or roll back together.
- `qc.result_recorded` remains the only QC type admitted from the edge door. `qc.completion_received` and the new `qc.observation_note_recorded` are central-only by construction; do not add them to `EDGE_QC_EVENT_TYPES`.
- `assertDamageCaseAllowsRelease` runs on every release path, including the QC accept path.
- The accept SoD check (`quality.ts:2532-2539`) stays; the new QC head gate is additive.

### Gotchas and failure modes

1. **Not-usable stock must never move.** A receipt putaway covers the whole received quantity. Releasing it unchanged after an 80/20 split would move 20 not-usable units to a shelf. D9's retarget is mandatory, and the test in Task 8.5 is the guard.
2. **Child tasks do not carry the GRN line.** `applyLotSplitRecorded` mints a random `source_completion_id` for each child (`:2735`), so a child accept must resolve through `qc_lot_split` to the parent task. A direct `source_completion_id` lookup will fail.
3. **Duplicate lot receipt.** `uq_qc_inspection_task_lot` makes a second task for a lot impossible. In practice the stock surface (`createLot`) refuses a duplicate lot with 400 `DUPLICATE_LOT` before the QC seam runs, so `duplicate_lot` is a defensive backstop that never fires on the GRN route; the seam pre-check remains as the guard against the unique violation for any future caller. Two simultaneous receipts of the same lot collide and roll back, which is the correct refusal for a duplicate lot (code review 2026-11-20).
4. **Plan resolution is not BOM-free.** `inspection_plan` is keyed by `(item_id, bom_revision_id, scope, ...)` and `bom_revision_id` is NOT NULL. D2's "current released BOM revision" is the only path that works without a schema change to Story 8.1's master data.
5. **Derived fields are rejected.** `business_date`, `sku`, `plan_id`, `plan_version_id`, `plan_scope` and `gate_status` cannot appear in a `qc.completion_received` payload (`quality.ts:722-734`). Do not try to pass them from the seam.
6. **Receipt `business_date` differs from receiving's server-local date.** The applier derives IST from `completed_at`; the seam must match it or the plan can resolve in the seam and fail in the applier at midnight.
7. **Split retarget changes row identity semantics.** `putaway_task.lot_id` is the lot NUMBER (text), not the UUID (`putaway_task.sql:5`); the retarget writes the child lot number and the child quantity.
8. **A second accepted child fails.** After the first release the task is `ready`, so a second accept raises `PUTAWAY_TASK_NOT_HELD`. This is deliberate (D10) and must be in `deferred-work.md`.
9. **Cross-dock and no-lot lines have no held putaway.** Accept must still succeed; skip the release and say so in the notification.
10. **Error codes are server-only.** Do not add `PERMANENT_ERROR_CODES`, the edge twin or `edge/src/messages/en.json` keys unless a code becomes reachable from an edge upload. None of this story's codes are.
11. **Schema drift is a hard gate.** Every new table, column, CHECK and index must appear in both the canonical file and `deploy/compose/init-db.sql`, and be pinned in `test/unit/schema-drift.test.ts`, or CI fails.
12. **Route ordering.** `/qc/tasks/:taskId/notes` is a static leaf under the task family; register it with the other leaves and re-run the spine acceptance contract so the router list matches the allowlist.

### Testing standards

- Integration suites use `node:test` with a real Postgres, the schema-apply harness, `makeRequest`, `expectError`, `lastEvent` and notification helpers (`test/integration/story-8-9.test.ts:32-400`, `story-8-3.test.ts:464-565`).
- Focused run: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-8-10.test.ts`.
- Full gates before review: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run db:migrate` twice for idempotency, and `npm run spine-acceptance-contract`.
- No edge build is required (server only), but `npm run test:unit` must stay green for the schema-drift and event-registry pins.

### Previous story intelligence

- Story 8.9 established the attachment ownership precedent (`damage.ts:1127-1140`) and the "a gate is not a release" separation: the damage case only allows a release; it never performs one. Story 8.10 adds the first disposition-driven release, so it must go through the same applier contract (`goods.putaway_released`) rather than writing `putaway_task` directly.
- Story 8.9's review found that a new action had zero e2e coverage and that pre-flight checks missed the DOA band. Lesson: the new rehearsal flow must assert the failure arms, not only the happy path.
- Story 8.3's UX boundary note (`8-3-...md:713-720`) requires responses rich enough for the later screen: the disposition response echoes the row, the new `gate_status` and `ncr_id`; the split response echoes every child. Do not narrow them.
- Story 3.11 and 3.14 established the additive-column pattern used by Task 3.1: a new ALTER-only file, tail-appended after the previous story's file, mirrored verbatim, pinned by name.

### Project Structure Notes

- Canonical schema lives in `read/projections/` (no `src/` prefix), while read helpers live in `src/read/projections/`. This asymmetry is real; do not "fix" it.
- New route handlers go in `src/api/v1/quality.ts`; route registration in `src/server.ts`; the spine allowlist in `test/integration/story-1-9.test.ts`.
- Rehearsal flows live in `deploy/rehearsal/mock/operations-smoke.ts` with seed data in `setup-operations.ts`.
- No `.md` deliverable is required from the dev agent; `deferred-work.md` and this story file are the record.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` Story 8.10 and 8.11, lines 3436-3512]
- [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md` Table 1 (G07), Table 3 order 3, Table 4 shared prerequisites, Table 7 Q33 to Q36]
- [Source: `_bmad-output/planning-artifacts/epics.md` Epic 8, lines 3166-3168 (no bypass to sellable stock)]
- [Source: `_bmad-output/implementation-artifacts/8-9-report-damage-universal-capture-qc-task-and-commercial-outcome.md` Review Findings and Dev Notes]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md` QC workbench, hold scope and disposition rules]
- [Source: `read/projections/qc_inspection_task.sql`, `read/projections/putaway_task.sql`, `read/projections/inspection_plan.sql`, `read/projections/bom.sql`, `read/projections/grn_line_inspect.sql`, `read/projections/attachment.sql`]
- [Source: `src/compliance/quality.ts`, `src/compliance/receiving.ts`, `src/compliance/damage.ts`, `src/quality/completion.ts`]
- [Source: `src/read/projections/qc_inspection_task.ts`, `putaway_task.ts`, `qc_lot_split.ts`, `qc_lot_disposition.ts`, `bom.ts`, `grn_line.ts`, `stock_balance.ts`]
- [Source: `src/api/v1/quality.ts`, `src/server.ts`, `src/sync/upload.ts`, `src/config/index.ts` (`qcHeadRoles`)]
- [Source: `test/integration/story-8-9.test.ts`, `test/integration/story-8-3.test.ts`, `test/unit/schema-drift.test.ts`, `test/unit/edge-permanent-error-parity.test.ts`, `test/integration/story-1-9.test.ts`]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` row 583 and the 8.9 damage-release line]

## Dev Agent Record

### Agent Model Used

kilo/deepseek/deepseek-v4.1-flash-1017

### Debug Log References

- The integration harness cannot truncate `grn_jobwork_challan` or `grn_line_condition`: both files are ALTER-only migrations over `grn` and `grn_line`. The seed list includes them for their columns but the TRUNCATE list names only real tables.
- The QC-head gate (AC 4) is additive to the Story 8.3 segregation-of-duties check, so three existing fixtures changed only in which role acts: Story 8.3's self-approval and self-reject proofs now drive a QC head as the result recorder (the SoD and reject rulings are unchanged), and the Story 8.4 and Story 6.4 split fixtures now act as a QC head.
- `putaway_task.quantity` is NUMERIC(18,3) while `qc_inspection_task.quantity` is NUMERIC(18,6); the split-retarget proof compares the putaway value to `80.000` and the remaining stock with `Number(...)`.

### Completion Notes List

- AC 1: `resolveReceiptInspectionPlan` resolves the item's current released BOM revision against the approved plan and returns five typed outcomes. The receiving seam (`applyGoodsReceivedProjection`) opens the real task through `receiveQcCompletion` with `source_completion_type = 'goods_receipt'` and the `goods_receipt:<grn_line_id>` idempotency key. A plan gap never fails the receipt: the held putaway records `no_inspection_plan` or `no_lot` and the `qc_hold_placed` notification names the reason. Verified in practice: the stock surface (`createLot`) refuses a duplicate lot with 400 `DUPLICATE_LOT` before the seam runs, so the seam's `duplicate_lot` hold reason never fires on the GRN route; it remains a defensive backstop for any future caller, and the integration test asserts the stock-surface refusal instead.
- AC 2: `goods.putaway_released` now carries an optional `disposition_id`; a `qc_accept` disposition proves itself to the release applier, which loads the disposition, requires an accept for the task's lot or a split child, retargets the held putaway to the accepted lot and quantity, skips the DOA release check and still runs the damage-case gate. `released_at` is stamped. Reject and a second accepted child never move stock.
- AC 3: `qc.observation_note_recorded` and the `qc_observation_note` projection are append-only (`INSERT`/`SELECT` for `app_user`, `SELECT` for `readonly_user`). The route accepts an optional caller-owned photo and refuses another user's claimed photo with `QC_NOTE_ATTACHMENT_NOT_OWNED`; the note returns in the note response and in the additive `notes` array of the results read.
- AC 4: `config.quality.qcHeadRoles` (default `qc_head`) gates every accept, reject and split in both the handlers and the seams, refusing 403 `APPROVAL_REQUIRED` with the task id and role set. No role literal appears in the seam.
- AC 5: a `goods_receipt` task view carries `receipt`, `putaway` and `hold_locations`; the list row additively carries `disposition`, `disposition_at` and `released_at`; the `gate_status` filter message names all five values.
- AC 6: `test/integration/story-8-10.test.ts` proves the happy chain, all three fallbacks, split retarget, reject, the damage-case block, the authority gate, central-only, and the detail view. Schema drift pins cover the widened source CHECK, `hold_reason`, `released_at` and `qc_observation_note`; the note route is in the spine allowlist. Both migrations run twice cleanly.
- Rehearsal: `qcReceiptLot` is registered beside `damageReport` and skips cleanly when no held receipt task or actor exists; receipt test items are seeded through the same `receipt_qc_items` plan loop.
- Code review 2026-11-20 fixes: the accept path no longer rolls back when a supervisor already released the putaway (the nested release now fires only for a held row, or a `qc_accept`-released row to preserve D10); `hold_locations` is scoped to the task's site and to quarantine locations; the receipt applier re-verifies the BOM revision belongs to the item; the `qc_hold_placed` notification uses human wording; the task list uses a lateral `LIMIT 1` join so one GRN line cannot duplicate a row; the rehearsal accept step checks its own putaway. Decision 1(a) amended D6 and AC 1 to record that the stock surface refuses a duplicate lot, and decision 2 records the direct-SQL fixture deviation in AC 6.

### File List

- `src/compliance/quality.ts`
- `src/compliance/receiving.ts`
- `src/api/v1/quality.ts`
- `src/server.ts`
- `src/events/schema.ts`
- `src/events/migrate.ts`
- `src/quality/completion.ts`
- `src/read/projections/putaway_task.ts`
- `src/read/projections/qc_inspection_task.ts`
- `src/read/projections/qc_observation_note.ts` (new)
- `src/read/projections/stock_balance.ts`
- `read/projections/qc_inspection_task.sql`
- `read/projections/putaway_task_qc_release.sql` (new)
- `read/projections/qc_observation_note.sql` (new)
- `deploy/compose/init-db.sql`
- `deploy/rehearsal/mock/setup-operations.ts`
- `deploy/rehearsal/mock/operations-smoke.ts`
- `test/integration/story-8-10.test.ts` (new)
- `test/integration/story-8-3.test.ts`
- `test/integration/story-8-4.test.ts`
- `test/integration/story-6-4.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-11-20: Implemented Story 8.10 (receipt-lot QC task, QC-governed putaway release, observation note and photo). Added the receipt plan resolver, widened the completion contract and source CHECK, opened tasks from the receiving seam with a visible hold-reason fallback, released and retargeted the held putaway on accept, added the append-only observation note with an optional photo, added the configuration-driven QC-head gate, and enriched the task view and list. Added the Story 8.10 integration suite and schema-drift pins; updated the three fixtures whose actor role is now the QC head.
- 2026-11-20 (code review): applied the review findings - accept no longer rolls back over a manually released putaway, `hold_locations` scoped to site and quarantine, BOM-revision ownership check, human hold-reason wording, lateral `LIMIT 1` list join, rehearsal accept scoped to its own putaway, and tests for three more resolver outcomes, the note-event central-only arm and the `gate_status` filter. Amended D6 and AC 1 (duplicate lot refused at the stock surface) and recorded the direct-SQL fixture deviation in AC 6.
