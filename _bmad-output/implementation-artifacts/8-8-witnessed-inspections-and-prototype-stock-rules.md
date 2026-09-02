---
baseline_commit: 6c8dc72
---

# Story 8.8: Witnessed Inspections and Prototype Stock Rules

Status: done

## Story

As a QC head,
I want customer-witnessed and third-party inspection hold points with recorded notices and waivers, and prototype stock structurally barred from sellable status at the stock-class level,
so that contractual inspection obligations are met with evidence and no prototype can ever reach saleable stock.

**Requirement sources:** FR-Q-15 (witnessed and third-party inspection), FR-Q-12 (prototypes barred from sellable status), FR-AC-13 (statutory edit log), AD-3 (DOA as the single approval resolver), AD-12 (guards live in the applier, never only in the route), AD-16 (idempotency), AD-17 (a decision emits a notification).

This is the LAST story in Epic 8. Stories 8.1-8.7 are done and committed; the baseline below is a clean, pushed tree.

## Acceptance Criteria

1. **Given** an order requiring customer-witnessed or third-party inspection (FR-Q-15) **When** a hold point is reached **Then** the lot is held at the hold point - dispatch is rejected by the Story 3.7 gate with `error_code: "LOT_ON_HOLD"` - until the witness signs off or a recorded waiver approved through the DOA registry (Story 1.4) is applied.
2. **Given** a scheduled witnessed or third-party inspection (FR-Q-15) **When** notice is given to the customer or third party **Then** the notice is recorded (recipient, date, and method) against the hold point before the inspection is held.
3. **Given** stock in the prototype (non-saleable) stock class (FR-Q-12) **When** any transaction attempts to move it to sellable status or allocate it to a dispatch **Then** the transaction is rejected with `error_code: "PROTOTYPE_NOT_SALEABLE"` - enforced at the stock-class level and testable with Epic 2 lot data alone.

## Binding Scope Decisions

These decisions are binding. Where a decision conflicts with intuition, follow the decision and record the concern in Completion Notes rather than deviating silently.

### BSD-1: Stream `qc`, four new event types, no new stream

The event-type prefix maps one-to-one onto `stream_type` across the whole registry - twenty-two `qc.*` types on `streamType: 'qc'` (src/events/schema.ts:5061-5168), five `compliance.*` on `'compliance'` (:5174-5193), no exceptions. `compliance.*` is reserved for enterprise-wide master-data registers (the Story 8.7 header at src/api/v1/compliance.ts:36-44 records that the register is deliberately not site-tenanted). A witnessed inspection is per-lot operational quality, so it is `qc.*`:

| Event type | Purpose |
|---|---|
| `qc.witness_hold_point_raised` | Opens the hold point on a lot and places the governed hold |
| `qc.witness_notice_recorded` | Records recipient, notice date and method against the hold point |
| `qc.witnessed_inspection_signed_off` | The witness signs off; the hold point closes |
| `qc.witnessed_inspection_waived` | A DOA-approved waiver closes the hold point instead |

All four register with `streamType: 'qc'`, `requiresBusinessStream: false`, alongside the existing block. Each gets a `*Payload` and `*Envelope` interface following the Story 8.7 convention (src/events/schema.ts:4255-4324): client fields typed normally, SERVER-DERIVED fields typed `?: never` under a comment, and the waiver's captured approver quartet marked SERVER-CAPTURED.

### BSD-2: The hold is a `qc_quality_hold` row - do NOT invent a second hold mechanism

`lot_master.quality_hold_status <> 'none'` is the ONLY enforcement predicate in the system (values constrained to `'none' | 'held'`), with `qc_inspection_task.gate_status` as a parallel, independent axis. A witnessed hold point therefore places a normal governed hold: insert a `qc_quality_hold` row AND set the lot flag, in the same transaction as the hold-point record, exactly as `applyHoldPlaced` does (src/compliance/quality.ts:5090-5195).

This is not a convenience - it is what makes AC1 true for free. Because the hold is a `qc_quality_hold` row, the Story 3.7 dispatch gate blocks it with `LOT_ON_HOLD` unchanged (src/compliance/dispatch.ts:262-296, 422-445), AND the Story 2.3 ad hoc clear route already refuses to lift it (src/api/v1/lots.ts:419-431 rejects with `QUALITY_HOLD_GOVERNED` whenever an open `qc_quality_hold` exists for the lot). Any design that stores the hold anywhere else re-opens that bypass.

### BSD-3: Add NO new predicate to `dispatch.ts`

Story 8.5 BSD-1 established that new hold reasons are expressed upstream by setting the existing flag, never by adding a third predicate to the dispatch gate - a new predicate is a new bypass surface. `dispatch.ts` is UNTOUCHED by this story. If the refusal details need to name the reason, extend the existing `{ held_lot_ids, reason }` object at dispatch.ts:281-284 and :440-443; do not add a branch.

### BSD-4: Clearing the flag uses the two-part ownership predicate - the hold-bypass class, found by three reviews

The 8.3, 8.4 and 8.5 reviews EACH found a variant of the same bug: a release path that cleared `lot_master.quality_hold_status` lifted a containment it did not own. The implemented rule is at src/compliance/quality.ts:5256-5260:

```ts
const otherOpen = await otherOpenQcQualityHoldExists(hold.lot_id, holdId, client);
const thisHoldSetTheFlag = lot['quality_hold_reason'] === hold.hold_reason;
if (!otherOpen && thisHoldSetTheFlag) await clearQualityHold(hold.lot_number, hold.sku, client);
```

Both sign-off and waiver MUST apply this identical two-part predicate. A blind `clearQualityHold` on witness sign-off would lift an unrelated `scrap_pending` or governed hold and reintroduce the bug a fourth time. Note the ownership test is string equality on `quality_hold_reason`; it is fragile but it is the house rule - match it, do not improve it in this story.

### BSD-5: Notice is a first-class record, not a notification

`emitNotificationInTransaction` (src/notify/emit.ts:124-127) is a fire-and-forget outbound alert; it stores no recipient/method contract that can be read back as evidence. AC2 requires evidence. So the notice is its own projection row and its own event, with the notification emitted ALONGSIDE it (AD-17), never instead of it. The structural analogue is the Story 8.7 alert ledger (`insertBisLicenceAlert`, read/projections/compliance_bis_licence_alert.sql), which records every stage even when only one notifies.

### BSD-6: Notice-before-inspection is enforced in the applier

AC2 says the notice is recorded "before the inspection is held". A sign-off against a hold point carrying ZERO notice rows is refused `WITNESS_NOTICE_REQUIRED` (409). A WAIVER is deliberately exempt: a waiver exists precisely for the case where notice could not be given or the inspection could not be held, and requiring a notice first would make the waiver unreachable in the situation it is for. Record this asymmetry in the code comment.

### BSD-7: The waiver composes Story 8.1's QC-Head resolver with Story 8.7's compare-on-apply

Two DOA patterns exist in the codebase. Story 8.1 (src/compliance/quality.ts:1833-1872) resolves in the applier and writes the resolved fields BACK onto the payload. Story 8.7 (src/api/v1/compliance.ts:484-513 and src/compliance/master-data.ts:566-608) captures at write time and RE-DERIVES and COMPARES on apply, raising `APPROVAL_AUTHORITY_MISMATCH` (409) on disagreement.

A waiver is exactly the case where a projection rebuild after DOA drift must reproduce the ORIGINAL authority, so use Pattern B - but over `resolveQcAuthority(WITNESS_WAIVER_DOA_TYPE, { requireQcHead: true }, client)` (src/compliance/quality.ts:1487-1552), because a QC approval is QC-Head-governed and `resolveQcAuthority` already accepts a client for in-transaction re-derivation.

**No existing code composes these two.** This is a deliberate synthesis, not an oversight - implement it and note it in Completion Notes. Compare `approver_user_id` AND `doa_entry_id` (matching the 8.7 guard at master-data.ts:582-585). Story 8.7's review flagged that `governing_role` and `delegation_applied` are carried but never compared; do NOT widen that here - keeping the two seams identical is worth more than the marginal check, and widening it is recorded as deferred work instead.

DOA transaction type: `qc.witnessed_inspection_waiver`, exported as a module constant from the new seam file, matching `INSPECTION_PLAN_APPROVAL_DOA_TYPE` at src/compliance/quality.ts:241. There is no central DOA-type registry - the string is free-form on `doa_registry_entries.transaction_type`.

### BSD-8: Segregation of duties on the waiver

The actor who raised the hold point cannot approve its own waiver. Precedent: `LABEL_APPROVAL_SOD_VIOLATION` (src/compliance/master-data.ts:626-635) and the release SoD at quality.ts:5242 (`SOD_VIOLATION`, no config escape hatch). Reuse the existing `SOD_VIOLATION` code rather than minting a new one - the QC surface already owns it.

### BSD-9: `prototype` is an ORIGIN class on the balance row, not a quality state on the lot

A prior binding decision records that "this platform has no separate blocked-stock class" - the scrap-pending block is `gate_status='rejected'` plus `lot_master.quality_hold_status='held'`, not a distinct bucket (deferred-work.md:546). This story does NOT contradict that decision, and the distinction must be stated in the code comment:

- A blocked-stock class would be a QUALITY STATE, which correctly belongs on the lot and the gate.
- `prototype` is an ORIGIN class - it describes where the stock came from and what it may ever become, exactly like `consignment`, `vmi` and `job_work` (Story 2.8), which already live on `stock_balance.stock_class`.

Prototype stock is never "released" into `owned`; it is a permanent property of that balance row.

### BSD-10: The prototype bar lives at the single applier choke point

`stock_class` already exists: `stock_balance.stock_class TEXT NOT NULL DEFAULT 'owned'` (read/projections/stock_balance.sql:18-36), part of the grain `uq_stock_balance_grain UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class)`. There is NO CHECK constraint; the vocabulary is enforced in application code, duplicated in TWO places:

- `src/compliance/stock-balance.ts:52` - `VALID_STOCK_CLASSES = new Set(['owned','consignment','vmi','job_work'])`
- `src/compliance/cycle-count.ts:58` - the same set, duplicated

`'prototype'` must be added to BOTH, or a prototype receipt is refused `INVALID_PARAMS` before the bar can ever be reached and AC3 is untestable.

The guard goes in `applyStockBalanceProjection` (src/compliance/stock-balance.ts:219, class resolved at ~:264), immediately after the class is resolved and before the receipt/allocation/issue branch. That is the single choke point every write path funnels through - the HTTP handler, `POST /api/v1/events`, and the edge upload - which is the same rationale already documented at stock-balance.ts:189 for the Story 2.8 ownership gate. A guard placed in a route instead would be bypassable by two of those three paths (AD-12).

### BSD-11: "Move to sellable status" has no reclassification event - and this story does not mint one

There is no class-change transaction in the system today. Rather than invent one, AC3's two halves are both expressed against existing transactions:

- **Allocation:** an allocation of `stock_class = 'prototype'` stock is refused `PROTOTYPE_NOT_SALEABLE`.
- **Move to sellable:** a stock event that would write an `owned`-class row for a `(sku, location_id, lot_id)` that already holds a `prototype`-class balance is refused with the same code.

That second arm is what makes the bar structural rather than cosmetic: without it, a receipt into `owned` for the same lot silently launders prototype stock into saleable stock. A future reclassification event, if Epic 10 needs one, must route through the same guard.

### BSD-12: `PROTOTYPE_NOT_SALEABLE` is a permanent error, and is NOT added to `AUDITED_REJECTIONS`

`PERMANENT_ERROR_CODES` (src/sync/upload.ts:18) already contains `LOT_EXPIRED`, `LOT_ON_HOLD`, `INSUFFICIENT_STOCK`, `NO_AVAILABLE_LOT`. A structural bar is permanently non-retryable, so `PROTOTYPE_NOT_SALEABLE` MUST be added there or an offline edge upload retries it forever.

It is deliberately NOT added to `AUDITED_REJECTIONS` (src/api/v1/quality.ts:250-288). That set is the Epic 8 convention for refused QUALITY DECISIONS raised by routes in `quality.ts`. This code is raised from the Story 2.2/2.8 stock surface, which falls under the carve-out already documented in that same block for `QUALITY_HOLD_GOVERNED` ("lives on the Story 2.3 lots surface, which carries no audit machinery"). Adding it would require audit machinery on a surface that has none. Record the decision in the code comment so a later review does not read the omission as the 8.3 `NCR_EXISTS` lesson repeating.

### BSD-13: Canonical SQL plus byte-identical init-db mirror, and drift pins

Two new tables, each defined in `read/projections/*.sql` as the CANONICAL file, added to the migration list in `src/events/migrate.ts`, and mirrored VERBATIM into `deploy/compose/init-db.sql`. Both files change together. Every statement idempotent (`IF NOT EXISTS`, guarded `DO` blocks). Add a drift pin block for each in `test/unit/schema-drift.test.ts` covering constraints, indexes and `appUserGrant`.

Grants follow the QC precedent: `app_user` gets `SELECT, INSERT, UPDATE`, never `DELETE` (fixtures use the admin pool). The notice table is APPEND-ONLY - a notice that was given is a posted contractual fact - so it gets `SELECT, INSERT` only, following the Story 8.7 alert-ledger decision.

## Data Model

### `qc_witness_hold_point` (new)

| Column | Type | Notes |
|---|---|---|
| `hold_point_id` | UUID PK | client-minted |
| `lot_id` | UUID NOT NULL | |
| `lot_number`, `sku` | TEXT NOT NULL | denormalised, as `qc_quality_hold` does |
| `site_id` | UUID | |
| `inspection_type` | TEXT NOT NULL | CHECK IN (`customer_witnessed`, `third_party`) |
| `status` | TEXT NOT NULL DEFAULT `'open'` | CHECK IN (`open`, `signed_off`, `waived`) |
| `qc_hold_id` | UUID NOT NULL | the `qc_quality_hold` row this raised |
| `raised_by` | UUID NOT NULL | |
| `raised_at` | TIMESTAMPTZ NOT NULL | |
| `source_event_id` | UUID NOT NULL UNIQUE | replay guard - the 8.7 lesson |
| `closed_by`, `closed_at`, `close_event_id` | nullable | |
| `waiver_doa_entry_id`, `waiver_reason` | nullable | set only when `status = 'waived'` |

Constraints: `uq_qc_witness_hold_point_open ON (lot_id) WHERE status = 'open'` (one open witness hold point per lot; a 23505 resolves to 409 `WITNESS_HOLD_POINT_EXISTS`), and a FULL BICONDITIONAL closure-pairing CHECK - `status <> 'open'` exactly when `closed_by`, `closed_at` and `close_event_id` are all non-null, and `waiver_doa_entry_id` non-null exactly when `status = 'waived'`. The biconditional is not optional: the Story 8.4 one-directional-CHECK lesson is that a half-pairing admits rows nothing can interpret.

### `qc_witness_notice` (new, append-only)

| Column | Type | Notes |
|---|---|---|
| `notice_id` | UUID PK | |
| `hold_point_id` | UUID NOT NULL | |
| `recipient` | TEXT NOT NULL | CHECK non-blank, <= 512 chars |
| `notice_date` | DATE NOT NULL | IST calendar date |
| `method` | TEXT NOT NULL | CHECK IN (`email`, `letter`, `portal`, `in_person`) |
| `recorded_by` | UUID NOT NULL | |
| `recorded_at` | TIMESTAMPTZ NOT NULL | |
| `source_event_id` | UUID NOT NULL UNIQUE | replay guard |

No FK to `qc_witness_hold_point` - cross-projection FKs are forbidden by the house rule; referential integrity is the applier's job (it loads the hold point `FOR UPDATE` before inserting). Index on `(hold_point_id, notice_date)`.

## Error Code Contract

Every code below must be raised by this story, and every applier-raised code must appear in `AUDITED_REJECTIONS` in `src/api/v1/quality.ts` (the 8.3 `NCR_EXISTS` omission lesson) - with the single documented exception of `PROTOTYPE_NOT_SALEABLE` per BSD-12.

| Code | Status | Raised when |
|---|---|---|
| `LOT_ON_HOLD` | 400 | EXISTING, unchanged - dispatch of a lot held by a witness hold point |
| `WITNESS_HOLD_POINT_EXISTS` | 409 | A second open hold point is raised for one lot |
| `WITNESS_HOLD_POINT_NOT_OPEN` | 409 | Sign-off or waiver against an already-closed hold point |
| `WITNESS_HOLD_POINT_NOT_FOUND` | 404 | Notice, sign-off or waiver names an unknown hold point |
| `WITNESS_NOTICE_REQUIRED` | 409 | Sign-off with zero notice rows (BSD-6; waiver exempt) |
| `SOD_VIOLATION` | 409 | EXISTING - the raiser approves their own waiver (BSD-8) |
| `APPROVAL_REQUIRED` | 403 | EXISTING - actor is not the DOA-resolved approver |
| `APPROVAL_UNRESOLVED` | 404/409 | EXISTING - no DOA entry, or no active holder |
| `APPROVAL_AUTHORITY_MISMATCH` | 409 | EXISTING - captured authority disagrees with re-derived (BSD-7) |
| `QC_DERIVATION_MISMATCH` | 409 | EXISTING - a client declared a server-derived field |
| `PROTOTYPE_NOT_SALEABLE` | 400 | Allocation of prototype stock, or an `owned` write over a prototype balance (BSD-10, BSD-11) |
| `LOT_NOT_FOUND` | 404 | EXISTING - hold point raised against an unknown lot |

## Tasks / Subtasks

- [x] Task 1: Schema - two new tables (AC: 1, 2)
  - [x] 1.1 Write `read/projections/qc_witness_hold_point.sql` per the Data Model above: CREATE TABLE with every column and inline CHECK, the partial unique index, the full biconditional closure-pairing CHECK, a guarded `DO` block re-adding each named constraint to a pre-existing table, indexes on `(lot_id)` and `(site_id, raised_at, hold_point_id)`, and guarded grants (`app_user`: SELECT, INSERT, UPDATE; `readonly_user`: SELECT).
  - [x] 1.2 Write `read/projections/qc_witness_notice.sql` the same way, APPEND-ONLY (`app_user`: SELECT, INSERT only - no UPDATE, no DELETE), with the `(hold_point_id, notice_date)` index and the `source_event_id` unique constraint.
  - [x] 1.3 Add both files to the migration list in `src/events/migrate.ts`, after the existing QC entries.
  - [x] 1.4 Mirror both blocks VERBATIM into `deploy/compose/init-db.sql`. Note that file currently carries Story 6.4 and 8.7 content in other regions - edit only your own block, do not reformat neighbours.
  - [x] 1.5 Run `npm run db:migrate` TWICE against a live database and confirm the second run is a clean no-op.

- [x] Task 2: Event registry and payload interfaces (AC: 1, 2)
  - [x] 2.1 Register the four `qc.*` types from BSD-1 in `SUPPORTED_EVENT_TYPES` (src/events/schema.ts), `streamType: 'qc'`, `requiresBusinessStream: false`, with a comment naming the story and FR.
  - [x] 2.2 Add a `*Payload` and `*Envelope` interface for each, following the Story 8.7 convention at src/events/schema.ts:4255-4324. Mark SERVER-DERIVED fields `?: never`. On the waiver payload, mark `approved_by`, `doa_entry_id`, `governing_role`, `delegation_applied` as SERVER-CAPTURED (required, not forbidden) per BSD-7.

- [x] Task 3: The QC witness seam (AC: 1, 2)
  - [x] 3.1 Create `src/compliance/qc-witness.ts` following the Story 8.7 seam layout: event-type constants, a `Set` gate plus a `qcWitnessEventType(envelope)` returning null unless `stream_type === 'qc'` and the type is in the Set, a local `reject()` helper, `isUniqueViolation(err, constraint)`, and `rejectDeclaredDerived` raising `QC_DERIVATION_MISMATCH`.
  - [x] 3.2 Export `WITNESS_WAIVER_DOA_TYPE = 'qc.witnessed_inspection_waiver'` (BSD-7).
  - [x] 3.3 Pure `assert*Shape` functions for all four events, dispatched by one `assertQcWitnessShape`. Validate `inspection_type` and `method` against their vocabularies here, so a bad value is a cheap 400.
  - [x] 3.4 `applyWitnessHoldPointRaised`: lock the lot `FOR UPDATE` FIRST (the fixed lock order is lot, then QC gate row, then stock - dispatch.ts:31-34), reject `LOT_NOT_FOUND` if absent; insert the `qc_quality_hold` row and set the lot flag exactly as `applyHoldPlaced` does (src/compliance/quality.ts:5090-5195), reusing `insertQcQualityHold` and `placeQualityHold` rather than re-deriving them; insert the hold-point row; append a trace entry; emit a notification (AD-17). A 23505 on the partial unique index resolves to `WITNESS_HOLD_POINT_EXISTS`.
  - [x] 3.5 `applyWitnessNoticeRecorded`: load the hold point `FOR UPDATE`, reject `WITNESS_HOLD_POINT_NOT_FOUND` / `WITNESS_HOLD_POINT_NOT_OPEN`, insert the notice row.
  - [x] 3.6 `applyWitnessedInspectionSignedOff`: load hold point `FOR UPDATE`; refuse `WITNESS_NOTICE_REQUIRED` when the hold point has zero notices (BSD-6); close the hold point; release the `qc_quality_hold` row through `releaseQcQualityHold`; clear the lot flag ONLY under the two-part predicate of BSD-4.
  - [x] 3.7 `applyWitnessedInspectionWaived`: same closure path, plus the BSD-7 authority compare (`resolveQcAuthority(WITNESS_WAIVER_DOA_TYPE, { requireQcHead: true }, client)`, then `APPROVAL_AUTHORITY_MISMATCH` on captured-vs-resolved disagreement, then `APPROVAL_REQUIRED` if the actor is not the approver), plus the BSD-8 SoD check. NO notice requirement.
  - [x] 3.8 Wire the seam into `src/events/store.ts` with exactly the two lines the 8.7 seam uses: `assertQcWitnessShape(envelope)` beside the other asserts, and `await applyQcWitnessProjection(envelope, client, eventId)` beside the other appliers.

- [x] Task 4: Projection accessors (AC: 1, 2)
  - [x] 4.1 `src/read/projections/qc_witness_hold_point.ts`: typed row interface, `insertWitnessHoldPoint`, `getWitnessHoldPointById(id, client?, forUpdate?)`, `getOpenWitnessHoldPointByLotId`, `closeWitnessHoldPoint` (guarded UPDATE returning boolean, so a lost race is a domain 409 not a silent no-op), `listWitnessHoldPoints`. A `forUpdate` argument with no client MUST throw - a `FOR UPDATE` on a pool checkout is a lock that does nothing (the 8.7 review lesson).
  - [x] 4.2 `src/read/projections/qc_witness_notice.ts`: `insertWitnessNotice`, `countNoticesForHoldPoint`, `listNoticesForHoldPoint`.

- [x] Task 5: Routes (AC: 1, 2)
  - [x] 5.1 Add routes to `src/api/v1/quality.ts` (the QC surface already owns `AUDITED_REJECTIONS`, `actorContext`, `auditCtxFor`, `auditRejectedAttempt`, `replayIdOrReject` - reuse them, do not re-export a second copy): `POST /api/v1/qc/witness-hold-points`, `GET /api/v1/qc/witness-hold-points`, `GET /api/v1/qc/witness-hold-points/:holdPointId`, `POST /api/v1/qc/witness-hold-points/:holdPointId/notices`, `POST /api/v1/qc/witness-hold-points/:holdPointId/sign-off`, `POST /api/v1/qc/witness-hold-points/:holdPointId/waive`.
  - [x] 5.2 Every write route REQUIRES `idempotency_key` and returns 400 without it; a replay returns 200 with the same `event_id`, never 201 (the 8.7 review lesson - `sendJson(res, replayed ? 200 : 201, ...)`).
  - [x] 5.3 Reject fields the route does not accept rather than silently dropping them (400 naming the field).
  - [x] 5.4 The waive route resolves the authority as a PRE-CHECK for a cheap audited 403 and puts the four captured fields on the payload; the applier remains the authority (BSD-7).
  - [x] 5.5 Add every new applier-raised code from the Error Code Contract to `AUDITED_REJECTIONS`, except `PROTOTYPE_NOT_SALEABLE` per BSD-12.
  - [x] 5.6 Register the routes in `src/server.ts` and add all six to the Story 1.9 spine allowlist in `test/integration/story-1-9.test.ts` - a missing allowlist entry fails the spine gate.

- [x] Task 6: Prototype stock class (AC: 3)
  - [x] 6.1 Add `'prototype'` to `VALID_STOCK_CLASSES` in BOTH `src/compliance/stock-balance.ts:52` AND `src/compliance/cycle-count.ts:58` (BSD-10). Leave a comment in each pointing at the other, since the duplication is the trap.
  - [x] 6.2 Add the guard in `applyStockBalanceProjection` immediately after the class is resolved (~src/compliance/stock-balance.ts:264): refuse `PROTOTYPE_NOT_SALEABLE` for an allocation of prototype-class stock.
  - [x] 6.3 Add the second arm of BSD-11: refuse an `owned`-class write for a `(sku, location_id, lot_id)` that already holds a prototype-class balance row.
  - [x] 6.4 Add `PROTOTYPE_NOT_SALEABLE` to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts:18` (BSD-12).
  - [x] 6.5 Write the BSD-9 comment where the class vocabulary is defined: prototype is an ORIGIN class, not the blocked-stock class the prior decision ruled out.
  - [x] 6.6 Decide and record: `stock_class` has no CHECK constraint today. Do NOT add one in this story - the vocabulary lives in application code by existing design, and adding a CHECK would need a migration against live rows for a value set that Epic 9 and 10 will extend again. Note it in Completion Notes as a considered non-change.

- [x] Task 7: Integration tests (AC: 1, 2, 3)
  - [x] 7.1 Create `test/integration/story-8-8.test.ts` bootstrapped from `story-8-7.test.ts` (same before-hook migration order, TRUNCATE list extended with the two new tables, same `makeRequest`/`authFor`/`provisionUser` helpers). Seed the DOA entry for `qc.witnessed_inspection_waiver` with a `qc_head` role holder, following story-8-7.test.ts:654-676.
  - [x] 7.2 AC1: raise a hold point, then assert a dispatch attempt for that lot is refused `LOT_ON_HOLD` THROUGH THE REAL Story 3.7 dispatch path - not by asserting the flag directly. The end-to-end chain is the acceptance criterion; a flag assertion would pass even if the gate stopped reading it.
  - [x] 7.3 AC1 release paths: sign-off clears the hold and the same dispatch then succeeds; separately, a DOA-approved waiver clears it and dispatch succeeds.
  - [x] 7.4 BSD-4 regression, MANDATORY: place an INDEPENDENT governed hold on the same lot (a second `qc_quality_hold` with a different reason), then sign off the witness hold point, and assert the lot is STILL held and dispatch is STILL refused. This is the hold-bypass class three prior reviews each found; without this test the fourth instance ships.
  - [x] 7.5 AC2: a notice records recipient, date and method and is readable back; sign-off with zero notices is refused `WITNESS_NOTICE_REQUIRED`; a waiver with zero notices SUCCEEDS (BSD-6).
  - [x] 7.6 AC3: receive stock with `stock_class: 'prototype'` via `stock.received` (the Story 2.8 pattern at story-2-8.test.ts:312), then assert `stock.allocated` is refused `PROTOTYPE_NOT_SALEABLE`; and assert the BSD-11 second arm - an `owned` write over that lot is refused too. Epic 2 data only, no QC fixtures.
  - [x] 7.7 Negative arms for EVERY code in the Error Code Contract, including `WITNESS_HOLD_POINT_EXISTS`, `WITNESS_HOLD_POINT_NOT_OPEN`, `SOD_VIOLATION` (raiser waives their own hold point) and `APPROVAL_AUTHORITY_MISMATCH` (delete and re-insert the DOA entry between capture and apply, following story-8-7.test.ts:1437-1460).
  - [x] 7.8 Idempotency: replay of each write route returns 200 with the same `event_id` and writes exactly one row.
  - [x] 7.9 RBAC negatives on every route, and a read-scope caller proving list AND get-by-id both work.

- [x] Task 8: Unit tests and drift pins (AC: 1, 2, 3)
  - [x] 8.1 Add drift pin blocks for both new tables in `test/unit/schema-drift.test.ts`: constraints, indexes, `appUserGrant` (`SELECT, INSERT, UPDATE` for the hold point, `SELECT, INSERT` for the append-only notice).
  - [x] 8.2 Unit-test any pure predicate you extract (the notice-required check, the two-part flag-ownership predicate) WITHOUT a database, table-driven.
  - [x] 8.3 MUTATION-CHECK the two load-bearing guards before declaring the story done: invert the BSD-4 two-part predicate and confirm 7.4 fails; delete the BSD-11 second arm and confirm 7.6 fails. A guard whose test still passes when the guard is removed is not tested. Record both results in Completion Notes.

- [x] Task 9: Gates
  - [x] 9.1 `npx tsc --noEmit`, `npx eslint src/ test/`, `npx prettier --write` on touched files only - do NOT run `prettier --write` across the whole repo, it reformats ~22 unrelated files that are not prettier-clean at baseline.
  - [x] 9.2 `npm run db:migrate` twice; `test/integration/story-1-9.test.ts` (spine) 6/6; `test/unit/schema-drift.test.ts` green.
  - [x] 9.3 Full `npm test`. The pre-existing failure floor at baseline `6c8dc72` is **28** (the idempotency family across stories 1.1/1.6/1.7/2.1-2.5/2.8/3.10, plus the date-dependent story-5-3 where-used flake). Record the count and prove 0 NEW failures. If the count moves, verify the delta in a detached worktree at the baseline before blaming your own change.

- [x] Task 10: Story hygiene
  - [x] 10.1 Append any out-of-scope discovery to `_bmad-output/implementation-artifacts/deferred-work.md`, including the BSD-7 note that `governing_role` and `delegation_applied` are carried but not compared in either seam.
  - [x] 10.2 Do not check off a task you did not do. The Story 8.7 review found Task 3.2 checked off with no interfaces behind it, and Task 9.2 checked off for an audit-log assertion that was never written - a checked box is the most expensive lie a story file can tell.

### Review Findings

Code review 2026-09-02 (Blind Hunter + Edge Case Hunter + Acceptance Auditor; 3 decision-needed, 8 patch, 1 defer, 8 dismissed). All 3 decisions resolved by the user to their recommended patches; all patches applied same day (see Resolution notes per item). One patch (init-db.sql header) was reclassified dismissed on inspection: the "CANONICAL" header wording is copied verbatim in 20+ existing mirrored blocks, so it is the house pattern, not an 8.8 defect.

- [x] [Review][Decision] Sign-off carried no SoD - RESOLVED: raiser-cannot-sign-off SoD added (reuses SOD_VIOLATION), mirroring the BSD-8 waiver arm; new negative test added, story test default signer moved to the qc_head. [src/compliance/qc-witness.ts]
- [x] [Review][Decision] Prototype laundering guard grain - RESOLVED: widened to LOT-level (any prototype balance for the lot anywhere blocks an 'owned' receipt of that lot); lot-less balances stay grain-scoped by (sku, location). New different-location arm added to the AC3 test. [src/compliance/stock-balance.ts]
- [x] [Review][Decision] Owned-arm guard froze coexisting owned stock - RESOLVED: narrowed to inflows (kind === 'receipt'); issues and allocations of a coexisting owned balance are no longer refused. [src/compliance/stock-balance.ts]
- [x] [Review][Patch] HIGH: Story 8.5 release route bypassed the witness hold - `applyHoldReleased` now refuses release with 409 QUALITY_HOLD_GOVERNED when an open witness hold point references the hold id (qc_hold_id = hold_point_id); closure must go through sign-off or waiver. New negative test proves the route refusal and that the lot stays held. [src/compliance/quality.ts:5250]
- [x] [Review][Patch] Prototype guard was check-then-act - both sides of a laundering pair now serialize on pg_advisory_xact_lock keyed (sku, lot_id) (or (sku, location_id) for lot-less balances) before the guard SELECT. [src/compliance/stock-balance.ts]
- [x] [Review][Patch] Taskless-lot raise skipped the write-site check - the route now asserts write scope against the actor's location (the same value the applier stamps as site_id); null still skips. [src/api/v1/quality.ts:2841-2847]
- [x] [Review][Patch] Closure-pairing CHECK omitted waiver_reason - biconditional extended with `(status = 'waived') = (waiver_reason IS NOT NULL)` in both SQL copies; the DO block now drop-and-re-adds the constraint so pre-existing tables pick up the widened pairing. [read/projections/qc_witness_hold_point.sql]
- [x] [Review][Patch] schema-drift pin had no body for idx_qc_witness_hold_point_lot - body pinned (`ON qc_witness_hold_point (lot_id);` - the trailing semicolon keeps it from vacuously matching the partial-unique line). [test/unit/schema-drift.test.ts]
- [x] [Review][Patch] init-db.sql copied header claims to be canonical - DISMISSED on inspection: identical wording in 20+ existing mirrored blocks; house pattern, not an 8.8 defect.
- [x] [Review][Patch] Null-site hold points invisible to scoped list - scoped list filter now `(site_id = ANY(...) OR site_id IS NULL)`; a non-tenanted hold point stays visible to readers who can already GET it. [src/read/projections/qc_witness_hold_point.ts]
- [x] [Review][Patch] APPROVAL_AUTHORITY_MISMATCH details omitted the doa_entry_id pair - captured_doa_entry_id and resolved_doa_entry_id added to the 409 details. [src/compliance/qc-witness.ts]
Round 2 (2026-09-02, same three layers re-run over the patched set): 7 patches applied, 2 deferred, 11 dismissed, 0 decisions.

- [x] [Review][Patch] R2 HIGH: wildcard-scoped raiser on a taskless lot stamped the zero-UUID NO_LOCATION sentinel as site_id (the round-1 NULL-visibility fix never fired) - route and applier now resolve the sentinel to NULL for the witness row (qc_quality_hold keeps the sentinel per its NOT NULL 8.5 convention); pinned by a site_id-null assertion. [src/api/v1/quality.ts, src/compliance/qc-witness.ts]
- [x] [Review][Patch] R2: cycle-count positive adjustment bypassed the stock-class laundering bar - the same lot-level check plus the same seed-8808 advisory-lock key now guard owned/prototype positive deltas in applyStockAdjustment. [src/compliance/cycle-count.ts]
- [x] [Review][Patch] R2: laundering bar was order-dependent - symmetric arm added: a prototype receipt into a lot already carrying a saleable-class balance is refused, so both serialization orders converge on refusal and both halves of the advisory lock buy a guarantee. [src/compliance/stock-balance.ts]
- [x] [Review][Patch] R2: release guard keyed on the qc_hold_id = hold_point_id minting convention - now queries the qc_hold_id COLUMN via new getOpenWitnessHoldPointByQcHoldId, surviving a future minting change. [src/read/projections/qc_witness_hold_point.ts, src/compliance/quality.ts]
- [x] [Review][Patch] R2: QUALITY_HOLD_GOVERNED check moved ABOVE the release SoD - a raiser self-releasing now hears "nobody may release this", not "get someone else to". [src/compliance/quality.ts]
- [x] [Review][Patch] R2: sign-off route silently accepted waiver fields (and waive accepted sign_off_note) - rejectUnacceptedFields lists made symmetric. [src/api/v1/quality.ts]
- [x] [Review][Patch] R2: closure-pairing constraint was dropped and re-validated on EVERY migrate (ACCESS EXCLUSIVE + full scan) - drop is now conditional on the installed definition lacking waiver_reason, then add-if-missing like the siblings. [read/projections/qc_witness_hold_point.sql, deploy/compose/init-db.sql]
- [x] [Review][Defer] R2: WITNESS_HOLD_POINT_NOT_FOUND (404) audited while LOT_NOT_FOUND is not - inconsistent 404 audit policy inside AUDITED_REJECTIONS - deferred, policy question for the QC surface as a whole. [src/api/v1/quality.ts:292-296]
- [x] [Review][Defer] R2: raise-route site assertion is TOCTOU against the applier's re-derivation (a task created between route check and applier lock stores a site the writer was never checked for) - deferred, narrow window, applier still derives correctly. [src/api/v1/quality.ts]
- [x] [Review][Defer] Replay detection on sign-off/waive/notice is a pre-read, not a persisted-event signal - a concurrent retry of the same idempotency key can return 201 for a replay, a waiver retry after DOA rotation gets 403 instead of a 200 replay, and the notice route's replayed 200 body is indistinguishable from a fresh 201 - deferred, disclosed deviation (pre-read-based `replayed` derivation), house pattern shared with prior stories. [src/api/v1/quality.ts]

## Dev Notes

### Files this story touches

**NEW:** `read/projections/qc_witness_hold_point.sql`, `read/projections/qc_witness_notice.sql`, `src/compliance/qc-witness.ts`, `src/read/projections/qc_witness_hold_point.ts`, `src/read/projections/qc_witness_notice.ts`, `test/integration/story-8-8.test.ts`.

**UPDATE:** `src/events/schema.ts` (registry + interfaces), `src/events/migrate.ts` (2 entries), `src/events/store.ts` (2 lines), `deploy/compose/init-db.sql` (2 mirrored blocks), `src/api/v1/quality.ts` (6 routes + AUDITED_REJECTIONS), `src/server.ts` (6 registrations), `src/compliance/stock-balance.ts` (vocabulary + guard), `src/compliance/cycle-count.ts` (vocabulary), `src/sync/upload.ts` (PERMANENT_ERROR_CODES), `test/integration/story-1-9.test.ts` (spine allowlist), `test/unit/schema-drift.test.ts` (2 pin blocks).

**DO NOT TOUCH:** `src/compliance/dispatch.ts` (BSD-3), `src/api/v1/lots.ts` (its existing `QUALITY_HOLD_GOVERNED` guard already covers the new hold for free - BSD-2), and any Story 6.4 or 8.7 region of `init-db.sql`.

### Existing behaviour that must not break

- The dispatch gate's check order and its fixed lock order (lot, then QC gate row, then stock) - src/compliance/dispatch.ts:31-34, 262-296, 422-445.
- `applyHoldPlaced` / `applyHoldReleased` semantics, including the flag-reason preservation rule at quality.ts:5086-5088 and the two-part clear at :5256-5260.
- `assertQcGateAllows` (quality.ts:4579) and its closed `QcGateOperation` union - the comment at :4652-4654 warns that terminal states are handled BEFORE conditional-release logic so a new gate state cannot fall through into the deviation checks and read a non-existent deviation as an authorization. If you touch that function, preserve the ordering discipline.
- The Story 2.8 per-class balance grain: one SKU/location/lot legitimately holds separate rows per class. A prototype row and an owned row for the same lot are NOT a data error in themselves - BSD-11's second arm is what makes creating that pair a refusal.

### Lessons carried from the Story 8.7 review (2026-09-02)

The four-group review of Story 8.7 found defect classes worth not repeating:

1. **Renewal/lifecycle asymmetry** - a status computed at write time in one path and left stale in another. Here: make sure sign-off and waiver close the hold point the SAME way.
2. **Client-assertable derived fields** - `stage_days` was trusted from the payload until an applier cross-check was added. Here: `inspection_type`, `status` and every timestamp are server-derived; re-derive under the transaction rather than trusting the envelope.
3. **Idempotency pre-checks tripping over their own writes** - requiring an idempotency key exposed that a retry of a successful create was answered 409 because the route's pre-check saw the row the first call created. If you add a route pre-check that could trip on your own prior write, stand it down when the key already produced an event (`findEventByIdempotencyKey`, src/events/store.ts).
4. **Tests passing for the wrong reason** - five were found in one story, three written during the review itself. Task 8.3's mutation check exists because of this.

### Testing standards

`node:test` via `npm test` (not vitest, despite what a stray config might suggest). Integration tests are database-backed against the docker `ims-postgres-test` instance on port 5442, run with `node --env-file=.env.test --import tsx --test --test-concurrency=1`. There is no shared fixture module - each story file seeds by POSTING DOMAIN EVENTS with a local envelope builder. Copy the seeding style from `story-8-7.test.ts` (DOA + QC) and `story-2-8.test.ts` (stock classes).

### References

- [epics.md - Story 8.8](../planning-artifacts/epics.md) (Epic 8, FR-Q-15 / FR-Q-12; the AC text and the Story 10.3 sequencing note at :2553)
- [Story 8.7](8-7-compliance-master-data-bis-licence-register-and-label-masters.md) - the freshest seam template and its full review record
- [Story 8.5 / 8.3 hold-bypass history](../implementation-artifacts/deferred-work.md) - and the verbatim comments at src/api/v1/lots.ts:419-423, src/compliance/quality.ts:2945-2953, :5086-5088, :5199-5201
- [deferred-work.md:546](deferred-work.md) - Binding Scope Decision 9, "this platform has no separate blocked-stock class", which BSD-9 above distinguishes rather than contradicts

## Open Questions

1. **Inspection type vocabulary.** BSD-1 assumes `customer_witnessed` and `third_party` are the complete set for the pilot. If a third category exists contractually (a regulator-witnessed inspection, say), say so before Task 1.1 - it is a CHECK constraint and a migration once the table exists.
2. **Waiver notification recipient.** The waiver notification targets the QC-head role by default, mirroring the licence-alert constant. If a customer-facing recipient is contractually required when a witnessed inspection is waived, that is a second notification and a different target.
3. **Notice method vocabulary.** `email | letter | portal | in_person` is inferred, not specified. Confirm before it becomes a CHECK constraint.

## Dev Agent Record

### Agent Model Used

claude-opus-5 (Claude Code, bmad-dev-story workflow)

### Debug Log References

- Story gates: `test/integration/story-8-8.test.ts` 20/20, `test/unit/qc-witness-predicates.test.ts` 3/3, `test/integration/story-1-9.test.ts` (spine) 6/6, both new `schema-drift` pin blocks green.
- Post-review gates (2026-09-02, after the Review Findings patches): `story-8-8.test.ts` 22/22 (the two review-added negatives included), tsc/eslint/prettier green, full suite 1639/1670 with all 31 failures the documented pre-existing idempotency-family/CRLF noise floor (0 new).
- `npm run db:migrate` run twice against docker `ims-postgres-test` on port 5442; the second run is a clean no-op.
- Full suite: 1668 tests, 1636 pass, 32 fail. Baseline `6c8dc72` in a detached worktree: 1643 tests, 30 fail. The delta is explained below - 0 new failures attributable to this story.

### Completion Notes List

**Binding decisions honoured as written.** All thirteen BSDs were implemented as specified. The three Open Questions could not be answered in-session, so the story's stated defaults were taken and are recorded here as assumptions: the `inspection_type` vocabulary is `customer_witnessed | third_party`, the waiver notification targets the QC role constant only (no customer-facing second notification), and the notice `method` vocabulary is `email | letter | portal | in_person`. All three are CHECK constraints now, so a fourth value is a migration.

**BSD-7 is a deliberate synthesis, as the story predicted.** No existing code composed the Story 8.1 QC-Head resolver with the Story 8.7 compare-on-apply. `applyWitnessedInspectionWaived` resolves through `resolveQcAuthority(WITNESS_WAIVER_DOA_TYPE, { requireQcHead: true }, client)` and compares `approver_user_id` and `doa_entry_id` only, matching the 8.7 guard exactly. `governing_role` and `delegation_applied` stay carried-but-uncompared in both seams; widening is recorded in `deferred-work.md` rather than done unilaterally here.

**Mutation-check results (Task 8.3), both guards confirmed load-bearing.**

1. BSD-4 two-part predicate inverted to `return !otherOpenHoldExists` - both BSD-4 regression tests failed (18/20 pass). Restored, 20/20.
2. BSD-11 second arm (the owned-write-over-prototype refusal) deleted - the AC 3 test failed (19/20 pass). Restored, 20/20.

**Task 6.6, considered non-change.** `stock_balance.stock_class` still carries no CHECK constraint. The vocabulary stays in the two application-code sets, now both extended with `prototype` and each carrying a comment pointing at the other. Adding a CHECK would need a migration against live rows for a value set Epics 9 and 10 will extend again.

**Deviations, disclosed.**

1. *Test harness bootstrapped from `story-8-5.test.ts`, not `story-8-7.test.ts` (Task 7.1).* AC 1 requires the REAL Story 3.7 dispatch path, and 8.5 already carries the `erp_sales_order` / `pick_task` / `packing_record` / `dispatch_document` fixture chain plus the applier-in-a-rolled-back-transaction idiom for it. The 8.7 elements the task named - the same `makeRequest`/`authFor`/`provisionUser` helpers and the DOA seeding shape - are present either way.
2. *The BSD-4 regression uses a Story 2.3 ad hoc containment, not a second `qc_quality_hold` row (Task 7.4).* A second independent governed hold on one lot is impossible: `uq_qc_quality_hold_open` is a partial unique index on `(lot_id) WHERE status = 'open'`, so the fixture the task describes cannot exist. The ad hoc flag hold is the real instance of the class the guard defends against - the flag is owned by a reason this hold point did not set - and the mutation check above proves the test fails without the guard. Both the sign-off and the waiver arm are covered.
3. *`WITNESS_HOLD_POINT_EXISTS` shares its arm with `HOLD_EXISTS`.* Because the hold point inserts a `qc_quality_hold` row first, a second hold point on one lot trips `uq_qc_quality_hold_open` before `uq_qc_witness_hold_point_open`. Both codes are raised by the applier and both are in `AUDITED_REJECTIONS`; the test accepts either and asserts exactly one hold-point row survives. The consequence is recorded in `deferred-work.md`: a lot under an unrelated governed hold cannot also carry a witness hold point today.
4. *`qc_hold_id` is minted equal to `hold_point_id`.* One identifier for the pair makes a replay reproduce the same two rows rather than an orphaned second governed hold.
5. *`QUALITY_EVENT_TYPES` in `src/compliance/quality.ts` gained the four `qc.witness*` literals.* Not named in the tasks, but required: the Story 8.2 registry-drift guard asserts that set equals every `qc`-stream registry entry, and membership is also what puts these events in `QC_CENTRAL_ONLY_EVENT_TYPES` (correct - none of them is an edge event). The literals are repeated rather than imported because `qc-witness.ts` imports `resolveQcAuthority` from `quality.ts`; `test/unit/qc-witness-predicates.test.ts` pins the two spellings together so a rename fails loudly.
6. *The sign-off and waive routes derive `replayed` from the PRE-write hold-point status, not from `close_event_id`.* The obvious comparison (`refreshed.close_event_id !== persisted.event_id`) is wrong: a replay returns the ORIGINAL event, whose id IS the stored `close_event_id`, so it answers 201 on every replay. A first closure can only run against an open hold point, so an already-closed pre-read is the sound replay signal. The same latent shape exists in the Story 8.5 release route and was left alone as out of scope.

**Full-suite delta, verified rather than asserted.** Working tree 32 failures against baseline `6c8dc72`'s 30, measured in a detached worktree at that commit. The two name-level differences are both non-attributable:

- `gate_dwell_metric: view body is canonical and mirrored in init-db.sql` - one of three schema-drift failures caused by line endings in THIS working tree (the canonical `*.sql` files are LF, `deploy/compose/init-db.sql` is CRLF). Verified by stashing every Story 8.8 change and re-running: `compliance_bis_licence`, `label_master` and `gate_dwell_metric` all still fail. They pass in a fresh checkout, which is why the baseline worktree shows only two of the three.
- `AC1: two parallel identical edge posts yield exactly one 201 and one 409 ...` (`story-7-8.test.ts`) - a concurrency flake: it PASSED in the first full-suite run of this session and failed in the second, with no code change in between, and it touches nothing this story edits.

The remaining failures are the documented pre-existing idempotency family across stories 1.1/1.6/1.7/2.1-2.5/2.8/3.10 plus the date-dependent story-5-3 flake, unchanged in count and identity.

### File List

**New**

- `read/projections/qc_witness_hold_point.sql`
- `read/projections/qc_witness_notice.sql`
- `src/compliance/qc-witness.ts`
- `src/read/projections/qc_witness_hold_point.ts`
- `src/read/projections/qc_witness_notice.ts`
- `test/integration/story-8-8.test.ts`
- `test/unit/qc-witness-predicates.test.ts`

**Modified**

- `deploy/compose/init-db.sql`
- `src/api/v1/quality.ts`
- `src/compliance/cycle-count.ts`
- `src/compliance/quality.ts`
- `src/compliance/stock-balance.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/8-8-witnessed-inspections-and-prototype-stock-rules.md`

### Change Log

The table below records the single implementation pass this story took.

| Date | Change |
|---|---|
| 2026-09-02 | Story 8.8 implemented: two projections (`qc_witness_hold_point`, `qc_witness_notice`), four `qc.*` event types, the `src/compliance/qc-witness.ts` seam, six routes on the QC surface, and the `prototype` stock class with its structural bar. Status moved from ready-for-dev to review. |
