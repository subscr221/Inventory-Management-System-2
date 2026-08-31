---
baseline_commit: df7f3c3bfb15f58f49561bde13661e5028e046d4
---

# Story 8.5: Quality Holds and Recall Trace

Status: review

## Story

As a QC head,
I want quality holds that flip stock to Blocked everywhere within 15 minutes with full where-used and where-shipped trace, and NCR/CAPA linkage with repeat-defect enforcement,
so that a quality problem can be contained and traced across the whole supply chain quickly.

## Acceptance Criteria

1. **Given** a quality issue on a lot (FR-Q-09), **when** a quality hold is placed, **then** all instances of that stock flip to `Blocked` on every connected node and a where-used and where-shipped trace is available within 15 minutes. Where-shipped runs over the Epic 3 dispatch documents (Story 3.7) and the Story 2.3 lot trace; where-used runs over whatever consumption event types exist today (production issue from Story 6.2; job-work consumption from Story 9.3 and production genealogy from Story 6.4 deepen the trace when those stories land).
2. **Given** an edge device that was offline when the hold was placed (FR-Q-09), **when** the device reconnects, **then** the hold is applied on the device immediately on reconnect and any queued transaction against the held lot is rejected on replay with `error_code: "LOT_ON_HOLD"` and flagged for supervisor review. The central write path (Story 2.3) and the dispatch gate (Story 3.7) reject held-lot transactions throughout, regardless of device state.
3. **Given** a held or defective lot (FR-Q-10), **when** an NCR is raised, **then** it carries a defect code and is linked to a CAPA record.
4. **Given** three or more NCRs for the same product and defect within 90 days (FR-Q-10), **when** the next matching NCR is raised, **then** a CAPA is mandatory before the NCR can be closed, returning `error_code: "APPROVAL_REQUIRED"` until the CAPA is linked.

## Binding Scope Decisions

These decisions are made. Do not re-litigate them during implementation; if one turns out to be wrong, disclose the deviation in Debug Log References rather than changing it silently.

1. **The hold aggregate is new; the enforcement flag is not.** `lot_master.quality_hold_status` (values `none` / `held`, plus `quality_hold_reason`) already exists from Story 2.3 and is read by every enforcement site in the codebase: `assertQcGateAllows`, `src/compliance/dispatch.ts` (twice), `src/compliance/cross-dock.ts`, `src/compliance/lot-serial-validation.ts`, `src/compliance/receiving.ts`, and the Story 8.4 release path. This story does **not** add a second enforcement axis and does **not** touch those call sites. It adds a governed `qc_quality_hold` record of decision whose applier sets that same flag inside the same transaction. Zero new blocking predicates means zero new bypass surface.
2. **Hold scope is the lot.** A hold names one `lot_id`. Enterprise-wide propagation is a consequence of `lot_master` being a single central projection, not of a broadcast fan-out. A product-level or supplier-level recall is out of scope (see Out of Scope).
3. **The Story 2.3 clear route must not be able to lift a QC hold.** `POST /api/v1/lots/:lotId/quality-hold` and its clear sibling stay in place for non-QC ad hoc holds, but `clearQualityHold` becomes fail-closed when an open `qc_quality_hold` row exists for that lot: 409 `QUALITY_HOLD_GOVERNED`. Without this guard the entire governed-hold story is bypassable by one pre-existing route, which is exactly the hold-bypass defect class the Story 8.3 and Story 8.4 reviews each found once.
4. **Release of a hold is a distinct, reason-carrying, segregated decision.** `qc.hold_released` requires a release reason, and the releasing actor must not be the actor who placed the hold: 409 `SOD_VIOLATION`, mirroring `applyConditionalReleaseRecorded` and the Story 8.4 acceptance guard. Containment is single-actor by design (see decision 5); lifting containment is not. **Confirmed 2026-08-31:** no config toggle weakens this guard. A `QC_HOLD_RELEASE_SOD=false` escape hatch would institutionalize the workaround while the audit trail still claimed the control held, which is worse than no control. The accepted cost is that a mis-placed hold also waits for a second actor; that is a bounded, visible delay. If live operation shows the mis-placed-hold case is common, the remedy is a narrow `qc.hold_voided` correction path (the placer voids their own hold, only while no downstream effect exists), not a weakening of release. That path is explicitly Phase 2 and out of scope here.
5. **Placing a hold is deliberately single-actor and never approval-gated.** No DOA transaction type is introduced. Same reasoning the Story 8.4 review recorded for a reject: delaying containment is actively harmful.
6. **Propagation to the edge is a new global PowerSync bucket, not a push.** `quality_holds` in `sync/sync-rules.yaml` follows the `released_bom_structure` precedent exactly (global bucket, no joins, no subqueries, denormalized columns) and replicates the held rows of `lot_master`. The edge gets a synced (not `localOnly`) `held_lot` table. "Applied on the device immediately on reconnect" is PowerSync's own replication, not a timer the edge runs.
7. **The 15-minute number is a measured, recorded latency, not a sleep.** The applier stamps `placed_at`; the propagation contract is asserted structurally (the bucket query selects the row; the edge capture guard reads the table) plus a bounded budget constant `qc.holdPropagationBudgetMinutes` (default 15) that the hold read route reports against `now() - placed_at` as `propagation_budget_breached`. Do not write a test that waits 15 minutes.
8. **Edge-side rejection reuses the existing permanent-error machinery.** `LOT_ON_HOLD` is already in `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`, which already classifies to `localStatus: 'needs_attention'` and lands a row in the edge `syncFailures` table. That IS "flagged for supervisor review" for AC2. Do not build a second review queue. The edge gains only a pre-capture guard that reads the new `held_lot` table so a technician is told before capture, not after replay.
9. **NCR gains a second origin; it does not lose its first.** Story 8.3 creates exactly one NCR per rejected lot, created BY the reject disposition, backstopped by `uq_qc_ncr_lot UNIQUE (lot_id)`. This story adds a hold-sourced NCR raised independently. `disposition_id` and `task_id` become nullable, `uq_qc_ncr_lot` is replaced by a **partial** unique index `uq_qc_ncr_lot_disposition_sourced ON qc_ncr (lot_id) WHERE disposition_id IS NOT NULL`, and a new `chk_qc_ncr_origin` biconditional pairs `origin = 'disposition'` with `disposition_id IS NOT NULL AND task_id IS NOT NULL`. The 23505 arm in `src/events/store.ts` that resolves `NCR_EXISTS` must keep resolving on the new constraint name so the Story 8.3 behaviour is byte-identical.
10. **Defect codes are dated configuration, never a hard-coded enum.** Spine Consistency Conventions ("Config: workflow rules, retention classes, statutory thresholds as dated configuration files, not hard-coded"). Parse `QC_DEFECT_CODES` with the exact `parseClosureCodeCatalogue` fail-closed contract Story 7.8 established in `src/config/index.ts`: only an ABSENT variable takes the defaults; present-but-blank, duplicate, over-length, or line-break-carrying fails at load. **Confirmed 2026-08-31: one flat enterprise catalogue, not a per-site keyed map.** Per-site catalogues and the decision-12 enterprise-wide repeat count are mutually exclusive: the same physical defect coded `SURFACE_FINISH` at one plant and `FINISH_NG` at another never accumulates to the threshold, so the FR-Q-10 rule would silently never fire. A defect taxonomy is quality-engineering vocabulary; sites vary in which codes they use, not in what the codes mean. The confirmed seed defaults are `DIMENSIONAL,SURFACE_FINISH,MATERIAL_NONCONFORMITY,CONTAMINATION,ASSEMBLY,FUNCTIONAL,MARKING_LABELLING,PACKAGING,CORROSION,DOCUMENTATION`. They are config, so a catalogue change is an environment change and never a code change.
11. **A CAPA is a first-class record, not a text field.** New `qc_capa` projection with its own lifecycle (`open`, `closed`), owner, due date and closure evidence. AC3's "linked to a CAPA record" is a real foreign reference validated at raise time, not a free-text id.
12. **The repeat-defect window is enterprise-wide and counted on IST business dates.** FR-Q-10 says "same product and defect", with no site qualifier, so the count is by `(sku, defect_code)` across all sites. The window is the 90 IST calendar days strictly preceding the new NCR's own business date, counting prior NCRs only (the new one is not its own predecessor). Threshold and window are config (`qc.repeatDefectThreshold` default 3, `qc.repeatDefectWindowDays` default 90) so a policy change is not a code change. **Confirmed 2026-08-31**, on three grounds beyond the literal FR text. A defect that repeats ACROSS sites is the systemic one (bad supplier lot, bad BOM revision, bad tool design), which is exactly what a CAPA exists for, so per-site scoping is blind to the class you most want caught. Per-site also divides the signal by the number of sites: threshold 3 across 5 sites needs roughly 15 enterprise occurrences before anything fires. And the error direction favours enterprise: over-firing costs a CAPA form somebody fills in, under-firing costs a recall. If a per-site rule is ever wanted, it is one extra predicate on the count query behind a config flag, and the reversal is cheap in that direction only.
13. **The mandatory-CAPA rule is enforced at close, not at raise.** AC4 says "a CAPA is mandatory before the NCR can be closed". The raise succeeds and stamps `capa_mandatory = true` on the row; `setQcNcrOutcome` refuses with 409 `APPROVAL_REQUIRED` while `capa_id IS NULL`. Refusing the raise itself would block containment, which contradicts decision 5.
14. **A hold-sourced NCR has no outcome vocabulary of its own.** The Story 8.3 outcomes (`rework`, `downgrade`, `scrap`) all move or relabel stock through paths keyed to a disposition. A hold-sourced NCR closes with a new terminal outcome `closed_with_capa` that moves no stock, so the existing `chk_qc_ncr_downgrade_pairing` and `chk_qc_ncr_rework_pairing` biconditionals stay true unchanged.

## Tasks / Subtasks

- [x] **Task 1: Projections and DDL** (AC: 1, 3, 4)
  - [x] Create `read/projections/qc_quality_hold.sql`: `hold_id` PK, `lot_id`, `lot_number`, `sku`, `site_id`, `hold_reason`, `defect_code` (nullable), `status` (`open` / `released`), `placed_by`, `placed_at`, `source_event_id`, `released_by`, `released_at`, `release_reason`, `release_event_id`, `created_at`, `updated_at`. Constraints: partial unique `uq_qc_quality_hold_open ON (lot_id) WHERE status = 'open'` (one open hold per lot), `chk_qc_quality_hold_release_pairing` as a full biconditional over the four release columns, bounded-text checks on both reasons. Grants: `INSERT, SELECT, UPDATE` to `app_user`, `SELECT` to `readonly_user`, never `DELETE`. Copy the header-comment style and guarded `DO $$` idempotency blocks from `read/projections/qc_ncr.sql` verbatim in shape.
  - [x] Create `read/projections/qc_capa.sql`: `capa_id` PK, `capa_number` (unique), `sku`, `defect_code`, `title`, `root_cause`, `corrective_action`, `preventive_action`, `owner_user_id`, `due_on` (DATE, IST business date), `status` (`open` / `closed`), `opened_by`, `opened_at`, `closed_by`, `closed_at`, `closure_evidence`, `source_event_id`, `close_event_id`. Same biconditional pairing discipline on the closure columns.
  - [x] Widen `read/projections/qc_ncr.sql` inside its existing guarded block: add `origin` (`disposition` / `hold`, NOT NULL, backfill `'disposition'` for existing rows), `hold_id` (nullable), `defect_code` (nullable), `capa_id` (nullable), `capa_mandatory` (BOOLEAN NOT NULL DEFAULT false), and make `disposition_id` / `task_id` nullable. Drop `uq_qc_ncr_lot` and `uq_qc_ncr_disposition` only if present, then add `uq_qc_ncr_lot_disposition_sourced` (partial) and re-add `uq_qc_ncr_disposition` as a partial unique on `disposition_id WHERE disposition_id IS NOT NULL`. Add `chk_qc_ncr_origin` stating the FULL biconditional in both directions, and extend `chk_qc_ncr_outcome` to admit `closed_with_capa`.
  - [x] Register all three files in `src/events/migrate.ts` at the tail, after the Story 8.4 entries, with the same comment convention explaining why the order is logical. `qc_ncr.sql` keeps its existing position; its widening rides its own guarded block.
  - [x] Mirror every statement into `deploy/compose/init-db.sql` (the two files are duplicates by design and must change together).
  - [x] Update `test/unit/schema-drift.test.ts` with the new tables and every new column, including the `qc_ncr` widening.
  - [x] Create the TypeScript accessors `src/read/projections/qc_quality_hold.ts` and `src/read/projections/qc_capa.ts` following the exact `qc_ncr.ts` shape: exported row interface, `Insert*` Pick type, `runner(client?)`, a `*_COLUMNS` constant, `::text` casts on every NUMERIC, and a single guarded UPDATE path per legal transition.
  - [x] Extend `src/read/projections/qc_ncr.ts` with the new columns, an `origin` discriminator on the row type, a `countMatchingNcrsInWindow(sku, defect_code, before_business_date, window_days, client)` reader for Task 5, and a `linkCapaToNcr` update guarded by `WHERE capa_id IS NULL`.

- [x] **Task 2: Event types, payload contracts and shape validation** (AC: 1, 3, 4)
  - [x] Add to `QUALITY_EVENT_TYPES` in `src/compliance/quality.ts` (grep for the symbol, do not trust a line number): `qc.hold_placed`, `qc.hold_released`, `qc.ncr_raised`, `qc.capa_opened`, `qc.capa_closed`, `qc.capa_linked`. All six are central-only, so they inherit `QC_CENTRAL_ONLY_EVENT_TYPES` by construction (it is derived by filtering out `qc.result_recorded`); assert this in a test rather than assuming it.
  - [x] Add the six payload contracts to `src/events/schema.ts` beside the Story 8.4 entries, with the same doc-comment density.
  - [x] Add six arms to `assertQualityShape`. Every server-derived field (`placed_at`, `raised_at`, `capa_mandatory`, `site_id`, `sku`, `lot_number`, `status`) that a client declares must throw `QC_DERIVATION_MISMATCH`. Reuse `UUID_REGEX`, `isPositiveQuantity`, the ISO-8601 timestamp regex and `isBoundedText` already defined in that file; do not re-declare them. The existing arms do not reject unknown keys and neither should these, matching the disclosed Story 8.4 deviation.
  - [x] Validate `defect_code` against `config.qc.defectCodes` in the shape arm and return the allowed list in the error detail, exactly as the Story 7.8 closure-code route does. The confirmed default catalogue is the ten codes named in Binding Scope Decision 10; ship them as the `QC_DEFECT_CODES` fallback string and assert both branches (variable absent takes the defaults, variable present but blank fails at load) in `test/unit/qc-defect-codes.test.ts`.

- [x] **Task 3: Hold appliers and the propagation seam** (AC: 1, 2)
  - [x] `applyHoldPlaced`: lock the lot row `FOR UPDATE` first, then the QC task row (the lot-then-task lock order every Story 8.1 to 8.4 applier uses; taking them in the other order will deadlock against the existing appliers). Insert the `qc_quality_hold` row, set `lot_master.quality_hold_status = 'held'` with the hold reason, append the `lot_trace` entry, and call `emitNotificationInTransaction` (AD-17: a hold is a decision) targeting the QC role at the lot's site.
  - [x] `applyHoldReleased`: same lock order, guarded UPDATE `WHERE status = 'open'` so a concurrent second release updates zero rows and resolves to 409 `HOLD_ALREADY_RELEASED`. Enforce Binding Scope Decision 4's `SOD_VIOLATION`. Clear `lot_master.quality_hold_status` back to `none` ONLY when no other open hold exists for the lot. Emit the transactional notification.
  - [x] Do not modify `assertQcGateAllows`, `src/compliance/dispatch.ts`, `src/compliance/cross-dock.ts`, `src/compliance/lot-serial-validation.ts` or `src/compliance/receiving.ts`. They already read the flag this story sets. Add a regression test proving each of those five paths blocks after `qc.hold_placed`; that test is the actual proof of AC1's "every instance flips to Blocked".
  - [x] Guard `clearQualityHold` per Binding Scope Decision 3 and add the `QUALITY_HOLD_GOVERNED` refusal to `src/api/v1/lots.ts`.

- [x] **Task 4: NCR and CAPA appliers** (AC: 3, 4)
  - [x] `applyNcrRaised` (hold-sourced): requires an open hold OR a lot whose `quality_hold_status = 'held'` ("held or defective lot"), a valid `defect_code`, and an existing open `capa_id` when one is supplied. Compute `capa_mandatory` per Task 5 and stamp it on the row. Never reuse `applyLotDispositioned`'s NCR creation path; that one stays exactly as it is.
  - [x] `applyCapaOpened` and `applyCapaClosed`: `capa_number` minted server-side; closure requires closure evidence and a guarded `WHERE status = 'open'` update.
  - [x] `applyCapaLinked`: links an existing open CAPA to an open NCR through `linkCapaToNcr` (`WHERE capa_id IS NULL`); a second link updates zero rows and resolves to 409 `CAPA_ALREADY_LINKED`.
  - [x] Extend the outcome path in `setQcNcrOutcome`'s caller to admit `closed_with_capa` for `origin = 'hold'` NCRs only, and to reject `rework` / `downgrade` / `scrap` on a hold-sourced NCR with 409 `NCR_OUTCOME_NOT_APPLICABLE` (those three all key off a disposition that a hold-sourced NCR does not have).

- [x] **Task 5: Repeat-defect detection and the mandatory-CAPA gate** (AC: 4)
  - [x] Add `qc.repeatDefectThreshold` (default 3) and `qc.repeatDefectWindowDays` (default 90) to `src/config/index.ts`, parsed with the existing positive-integer env helper. Take the bounds as function parameters, not module constants, so the predicate is genuinely exercisable in a unit test (the Story 8.4 review's tautological-config lesson).
  - [x] `isRepeatDefect(sku, defect_code, business_date, client)`: counts prior `qc_ncr` rows with the same `(sku, defect_code)` whose `raised_at` IST business date falls in the strictly-preceding window, excluding the row being raised. Threshold comparison is `count >= threshold`, matching AC4's "three or more".
  - [x] Gate the close: `setQcNcrOutcome` refuses with 409 `APPROVAL_REQUIRED` while `capa_mandatory = true AND capa_id IS NULL`. Message and detail must name the count, the window and the linking route.
  - [x] Unit-test the predicate at the boundaries: 2 prior NCRs (not mandatory), exactly 3 (mandatory), a third NCR exactly 90 days old (outside the strict window), one 89 days old (inside), and a same-SKU-different-defect-code set (not mandatory).

- [x] **Task 6: Where-used and where-shipped trace** (AC: 1)
  - [x] `GET /api/v1/qc/holds/:holdId/trace` returning one payload with three sections: `movements` (from `lot_trace` for the lot, ordered by timestamp), `where_used` (consumption events: `production_order.material_issued` rows naming the lot, joined to `production_order` for the order and product), and `where_shipped` (`packing_record` rows naming the lot, joined to `dispatch_order_status` and `dispatch_document` for the documents generated).
  - [x] Include `placed_at`, `elapsed_minutes` and `propagation_budget_breached` (Binding Scope Decision 7) in the response envelope so the 15-minute contract is observable rather than asserted.
  - [x] Declare the coverage limit inline in the route doc comment: job-work consumption (Story 9.3) and production genealogy (Story 6.4) are not yet in the codebase, so `where_used` is complete only with respect to the consumption event types that exist at this baseline. State this in the response as an explicit `coverage` field rather than letting a caller read an incomplete trace as a complete one.
  - [x] Read-only route, `module: 'quality'`, `functionScope: 'read'`, site-scoped through the hold's `site_id` with `LOCATION_ACCESS_DENIED` on a cross-site read.

- [x] **Task 7: REST routes** (AC: 1, 2, 3, 4)
  - [x] `POST /api/v1/qc/holds` (place), `POST /api/v1/qc/holds/:holdId/release`, `GET /api/v1/qc/holds`, `GET /api/v1/qc/holds/:holdId`, `GET /api/v1/qc/holds/:holdId/trace`, `POST /api/v1/qc/ncrs` (raise, hold-sourced), `POST /api/v1/qc/ncrs/:ncrId/capa` (link), `POST /api/v1/qc/capas`, `POST /api/v1/qc/capas/:capaId/close`, `GET /api/v1/qc/capas`, `GET /api/v1/qc/capas/:capaId`.
  - [x] ROUTE ORDER MATTERS and is already load-bearing in `src/server.ts`: register every static segment before its parameterised sibling, and register `/qc/holds` and `/qc/capas` so they cannot be swallowed by the existing `/qc/tasks/:taskId` and `/qc/ncrs/:ncrId` routes. Follow the comment convention already present around the Story 8.2 and 8.3 registrations.
  - [x] Use the `replayIdOrReject` idiom for every write route's replay detection. Do NOT use a check-then-act `SELECT` before `persistEvent`; that exact race was found and fixed in `recordNcrOutcomeBase` during the Story 8.3 review.
  - [x] Extend `AUDITED_REJECTIONS` in `src/api/v1/quality.ts` with every new refusal code, in the comment-annotated style Stories 8.3 and 8.4 used. Do not leave a code in the table that no route throws, and do not throw a code the table omits.

- [x] **Task 8: 23505 constraint chain** (AC: 1, 3)
  - [x] Extend the existing chain in `src/events/store.ts` (grep `err.code === '23505'`) with arms for `uq_qc_quality_hold_open` (409 `HOLD_EXISTS`), `uq_qc_capa_number` (409 `CAPA_EXISTS`) and the renamed `uq_qc_ncr_lot_disposition_sourced` / `uq_qc_ncr_disposition` (both keep resolving to the existing 409 `NCR_EXISTS`).
  - [x] EXTEND, never duplicate an arm for the same underlying fact. The Story 8.3 review found and fixed exactly that mistake once already.

- [x] **Task 9: Edge propagation** (AC: 1, 2)
  - [x] Add the `quality_holds` global bucket to `sync/sync-rules.yaml` following the `released_bom_structure` precedent: no joins, no subqueries, denormalized columns, a comment explaining why a global bucket is correct here (a held lot may be physically anywhere, so site-filtering the bucket would leave the receiving site blind).
  - [x] Add the matching synced `heldLot` table to `edge/src/local-db/schema.ts`. Table name and column list must match the bucket query exactly. Not `localOnly`.
  - [x] Add a pre-capture guard in the edge capture path that reads `held_lot` and refuses capture against a held lot with a local message, so a technician is told before capture rather than after replay.
  - [x] Do NOT add a timer, a poll, or a second review queue. Reconnect application is PowerSync replication; replay rejection and supervisor flagging are the existing `PERMANENT_ERROR_CODES` / `needs_attention` / `syncFailures` path (Binding Scope Decision 8). Add a `test/unit/sync-upload.test.ts` case proving `LOT_ON_HOLD` still classifies to `needs_attention` after this story's changes.

- [x] **Task 10: Tests** (AC: 1, 2, 3, 4)
  - [x] `test/integration/story-8-5.test.ts` covering all four ACs.
  - [x] AC1: the five-enforcement-path regression test from Task 3, plus a trace test asserting all three sections and the `coverage` field.
  - [x] AC2: a replay test posting a queued edge event against a lot held after the event was captured, asserting `LOT_ON_HOLD` and the `needs_attention` classification.
  - [x] AC3: an NCR raised on a held lot with a defect code and a linked CAPA; a raise with an unknown defect code (rejected, allowed list in the detail); a raise naming a closed CAPA (rejected).
  - [x] AC4: the boundary set from Task 5, plus a close attempt returning `APPROVAL_REQUIRED` and a second close succeeding after `CAPA_LINKED`.
  - [x] Every success test asserts the audit row. Every new write route gets both a `LOCATION_ACCESS_DENIED` test and a `CENTRAL_ONLY_OPERATION` test. Every new event type gets a direct-POST forgery test proving `QC_DERIVATION_MISMATCH` on a declared server-derived field.
  - [x] Every `*_EXISTS`-shaped code gets both a sequential AND a concurrent test, matching the `'AC1: two concurrent dispositions...'` template in `test/integration/story-8-3.test.ts`.
  - [x] Story 8.3 and Story 8.4 regression: the reject-disposition NCR path still creates exactly one NCR per rejected lot and still returns `NCR_EXISTS` on a second attempt, after the `uq_qc_ncr_lot` change.
  - [x] Gates before moving to review: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice (idempotent), `test/unit/schema-drift.test.ts`, the story suite, and the full suite with a pre-existing-failure count compared against baseline `df7f3c3`.

## Dev Notes

### Architecture Compliance

- **AD-3 (DOA registry):** no DOA transaction type is added. Placing a hold is single-actor by design (Binding Scope Decision 5); releasing one is segregated by actor identity, not by an approval workflow (decision 4). A `no-hardcoded-role-in-workflow` violation would be introduced by hard-coding a QC-head role check anywhere in this story; use the existing `requireRole({ module: 'quality', functionScope: ... })` middleware only.
- **AD-8 (calibration lockout):** untouched, but note the interaction. A hold does not lift a calibration lockout and a lockout does not lift a hold; both fail closed independently.
- **AD-12 (compliance spine):** the hold flag lives on `lot_master`, a spine-layer projection every module already reads. That is why this story needs no per-module fan-out.
- **AD-14 (shared read projections):** `qc_quality_hold` and `qc_capa` are shared projections. The trace route reads `lot_trace`, `packing_record`, `dispatch_document`, `dispatch_order_status` and `production_order` through their existing accessors, never another module's event stream directly.
- **AD-16 (idempotency keys):** the six new event types are central-seam-only, so AD-16 applies to them only through `persistEvent`'s existing `DUPLICATE_EVENT` handling. The edge does not originate any of them.
- **AD-17 (notification coupling):** hold placement, hold release and CAPA closure are decisions, so all three use `emitNotificationInTransaction`, not `emitNotification`. The Story 8.4 review found an applier that flipped a status and emitted a domain event but notified nobody; do not repeat it.
- **Consistency Conventions:** event names are past-tense dot-separated (`qc.hold_placed`); timestamps are UTC with a separate IST `business_date` where a statutory window is computed (the 90-day repeat-defect window); the error envelope is `{ error_code, message, details, trace_id }`; state changes only through events.

### Error Code Contract

Table 1 lists every error code this story throws or reuses. Codes marked Existing must keep their current HTTP status and body shape.

| **Code** | **HTTP** | **Status** | **Meaning** |
| --- | --- | --- | --- |
| `HOLD_EXISTS` | 409 | New | An open quality hold already exists for the lot (sequential or concurrent). |
| `HOLD_NOT_FOUND` | 404 | New | The named hold does not resolve. |
| `HOLD_ALREADY_RELEASED` | 409 | New | Release posted against a hold that is no longer `open`. |
| `QUALITY_HOLD_GOVERNED` | 409 | New | The Story 2.3 clear route was used on a lot carrying an open governed QC hold. |
| `SOD_VIOLATION` | 409 | Existing | The actor releasing a hold is the actor who placed it. |
| `DEFECT_CODE_UNKNOWN` | 422 | New | The cited defect code is not in `config.qc.defectCodes`. The allowed list is returned in the detail. |
| `CAPA_NOT_FOUND` | 404 | New | The named CAPA does not resolve. |
| `CAPA_EXISTS` | 409 | New | The minted CAPA number collided (sequential or concurrent). |
| `CAPA_NOT_OPEN` | 409 | New | A link or close was attempted against a CAPA that is not `open`. |
| `CAPA_ALREADY_LINKED` | 409 | New | The NCR already carries a CAPA; the link update matched zero rows. |
| `NCR_OUTCOME_NOT_APPLICABLE` | 409 | New | A disposition-family outcome (`rework`, `downgrade`, `scrap`) was posted against a hold-sourced NCR. |
| `APPROVAL_REQUIRED` | 409 | Existing | Close attempted on a repeat-defect NCR with no CAPA linked. AC4's named code. |
| `NCR_EXISTS` | 409 | Existing | One disposition-sourced NCR per lot. Must survive the `uq_qc_ncr_lot` change unchanged. |
| `NCR_OUTCOME_EXISTS` | 409 | Existing | The outcome is set exactly once. |
| `LOT_ON_HOLD` | 400 | Existing | Every enforcement path. AC2's named code on edge replay. |
| `LOT_NOT_FOUND` | 400 | Existing | The lot reference does not resolve or is ambiguous. |
| `QC_DERIVATION_MISMATCH` | 409 | Existing | A client declared a server-derived field. Audited. |
| `INVALID_PAYLOAD` | 400 | Existing | Shape validation. |
| `LOCATION_ACCESS_DENIED` | 403 | Existing | The hold's or task's site is outside the actor's `qc` scope. |
| `CENTRAL_ONLY_OPERATION` | 403 | Existing | A new `qc.*` type posted to the edge route. |
| `DUPLICATE_EVENT` | 409 | Existing | Idempotency key reused with a different payload. |

### Current UPDATE File State and Preservation Rules

Line numbers below are as of baseline `df7f3c3`. **Grep for the named symbol; do not trust a hardcoded line number.** Every prior story in this epic has shifted these by the time it landed.

- `src/compliance/quality.ts` (approximately 4,500 lines, the single largest file this story touches):
  - `QUALITY_EVENT_TYPES` (`:172`) and `QC_CENTRAL_ONLY_EVENT_TYPES` (`:195`, derived by filtering `qc.result_recorded` out of the former). Adding a type to the first automatically makes it central-only.
  - `compareDecimalStrings` (`:301`, exported). Reuse for any `NUMERIC` comparison. Never raw `===` / `!==` on a NUMERIC string. This exact bug class was found and fixed twice across the Story 8.2 and 8.3 reviews.
  - `assertQualityShape` (`:1337`). Thirteen-plus existing arms, none of which reject unknown keys.
  - `applyLotDispositioned` (`:2419`). **Copy structurally, do not modify.** It owns the Story 8.3 reject-to-NCR creation and the Story 8.4 acceptance `SOD_VIOLATION` guard. If this story genuinely must touch it, disclose the deviation in Debug Log References rather than leaving it silent; Story 8.3 was given the same rule and violated it by two lines without disclosure.
  - `assertQcGateAllows` (`:4346`). **Read it before writing anything.** It is the operational gate: it locks the lot row `FOR UPDATE`, resolves a lot by UUID or by lot number, treats a lot with no inspection task as ungoverned and passing, and evaluates `lot_master.quality_hold_status` as an axis fully independent of `gate_status` on both the `accepted` and `conditionally_released` branches. This story must not change its behaviour; it only causes the flag it already reads to be set.
- `src/api/v1/lots.ts`: `placeQualityHoldBase` (`:325` area) and `clearQualityHoldBase` (`:392` area), both wrapped by `requireRole({ module: 'quality', functionScope: 'write' })`, both emitting `lot.quality_hold_placed` / `lot.quality_hold_cleared`. Preserve their request and response shapes; the only change is the Binding Scope Decision 3 fail-closed guard on clear.
- `src/api/v1/quality.ts`: `AUDITED_REJECTIONS` (`:211` area) - extend, do not rewrite.
- `src/events/store.ts`: the 23505 constraint chain (grep `err.code === '23505'`); the `uq_qc_ncr_lot` / `NCR_EXISTS` arm is the template for Task 8.
- `src/server.ts`: QC route registrations start at `:826` with load-bearing ordering comments. Read them before inserting.
- `src/sync/upload.ts`: `PERMANENT_ERROR_CODES` (`:18` area) already contains `LOT_ON_HOLD`; `isPermanentUploadErrorCode` (`:184`) is its exported twin. Change nothing here except adding a test.
- `sync/sync-rules.yaml`: legacy Sync Rules support NO joins and NO subqueries. Everything the edge needs must be denormalized onto the replicated row, exactly as `is_released_structure` was for BOM.
- `read/projections/qc_ncr.sql`: the canonical DDL, duplicated into `deploy/compose/init-db.sql`. Both change together, always.

### Existing Components to Reuse

- `getQcInspectionTaskByLotId` / `getQcInspectionTaskById` - the row already carries `site_id`, `sku`, `gate_status` and `task_status`. No new joins needed for site scoping.
- `getLotById`, `placeQualityHold`, `clearQualityHold` in `src/read/projections/lot_master.ts` - the flag writers already exist; the hold applier calls them rather than issuing its own UPDATE.
- `appendTraceEntry` / `getTraceForLot` in `src/read/projections/lot_trace.ts`. Note `lot_trace` carries a UNIQUE index on `event_id`, so exactly one trace row per event; `src/quality/lot-split.ts` documents the consequences.
- `emitNotificationInTransaction` in `src/notify/emit.ts`, already imported in `quality.ts`.
- `parseClosureCodeCatalogue` in `src/config/index.ts` (Story 7.8) for the defect-code catalogue.
- `replayIdOrReject` in `src/api/v1/quality.ts`.
- `toIstCalendarDate` and `gateBusinessDateOf` in `src/compliance/quality.ts` for the 90-day IST window.
- `UUID_REGEX`, `isPositiveQuantity`, `isBoundedText` and the ISO-8601 timestamp regex, all already in `quality.ts`.

### Previous Story Intelligence

Recurring defect classes across the Story 8.1 to 8.4 reviews. Treat these as standing guardrails.

- **The hold-bypass class, found twice.** Story 8.3's NCR-outcome path and Story 8.4's `lockLotForRetention` each shipped without re-deriving `lot_master.quality_hold_status` under the lot lock, so a lot held after acceptance stayed actionable. This story is entirely about that flag; re-derive it under the lock in every new path that acts on a lot.
- **A one-directional CHECK constraint for a biconditional invariant.** `chk_qc_lot_disposition_ncr_pairing` shipped as `A OR B` when the invariant was `A = B`. Task 1 adds several pairing constraints; each must state the full biconditional it claims in its doc comment.
- **Check-then-act replay detection.** Fixed in `recordNcrOutcomeBase` during the Story 8.3 review. Compare a minted id against what `persistEvent` returns.
- **Error codes drifting from the contract table.** Story 8.3 shipped `NCR_EXISTS` in the routes and not in the story's table; Story 8.4 shipped stale `AUDITED_REJECTIONS` entries. Keep Table 1 above and the code in lockstep.
- **Tests green on real defects.** The Story 8.4 review found all seven HIGH defects shipped with a green suite: config asserted against itself, expiry checked to the year only, and a field the whole AC depended on never read by any test. Assert derived values against independently computed expectations, not against the same object production reads.
- **A duplicated 23505 arm for a fact that already had one.** Extend the existing arm.

### Testing Standards

- Node's built-in test runner, `--test-concurrency=1`, one integration file per story under `test/integration/`, unit tests under `test/unit/`. Run with `npm test`; the harness reads `.env.test`.
- The integration test database is the Docker container `ims-postgres-test` on port 5442.
- Baseline noise floor at `df7f3c3` is 26 pre-existing full-suite failures. Record the count before starting and compare after; any delta is this story's, and the story is not done while it is non-zero.
- Concurrency tests use the 10-in-flight pattern the Story 8.4 review raised the bar to.
- Mutation-verify at least the two highest-risk guards (the `clearQualityHold` fail-closed guard and the mandatory-CAPA close gate) by reverting the production change and confirming the new test fails.

## Project Structure Notes

### New Files

- `read/projections/qc_quality_hold.sql`
- `read/projections/qc_capa.sql`
- `src/read/projections/qc_quality_hold.ts`
- `src/read/projections/qc_capa.ts`
- `src/quality/recall-trace.ts` (the where-used and where-shipped assembly, kept out of the already-oversized `quality.ts`)
- `test/integration/story-8-5.test.ts`
- `test/unit/qc-defect-codes.test.ts`
- `test/unit/qc-repeat-defect.test.ts`

### Expected Update Files

- `deploy/compose/init-db.sql`
- `read/projections/qc_ncr.sql`
- `src/read/projections/qc_ncr.ts`
- `src/api/v1/lots.ts`
- `src/api/v1/quality.ts`
- `src/compliance/quality.ts`
- `src/config/index.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/server.ts`
- `sync/sync-rules.yaml`
- `edge/src/local-db/schema.ts`
- `edge/src/capture/` (the pre-capture held-lot guard)
- `test/unit/schema-drift.test.ts`
- `test/unit/sync-upload.test.ts`

### Out of Scope

- Product-level, supplier-level or date-range recalls. This story holds one lot at a time (Binding Scope Decision 2).
- Job-work consumption trace (Story 9.3) and production genealogy trace (Story 6.4). Neither event type exists at this baseline; the trace route declares its own coverage limit rather than pretending completeness.
- Customer notification or field-recall correspondence. `where_shipped` returns the dispatch documents; contacting the consignee is not modelled.
- The FR-Q-13 quality reporting dashboard, including NCR and CAPA aging. That is Story 8.6, which reads the `qc_ncr` and `qc_capa` rows this story creates.
- Statutory release blocks (BIS, Legal Metrology). Story 8.6 with Story 8.7 master data.
- Any change to the Story 8.4 batch release or retention-sample behaviour beyond the hold flag it already re-derives.

## Open Questions - ANSWERED AND CLOSED 2026-08-31

All three questions raised at story creation are answered. Each answer is now folded into the Binding Scope Decision it governs and is binding on implementation. Nothing in this section is open.

1. **Hold release segregation staffing - ANSWERED: keep the guard, ship no escape hatch.** Folded into Binding Scope Decision 4. The asymmetry settles it: placing a hold is time-critical, so it stays single-actor; releasing one is not, so a held lot waiting for the next shift costs a delay and never a safety event. Thin night-shift staffing is therefore an argument against gating placement, which this story already declines to do, and not an argument against gating release. A config toggle was considered and rejected: it institutionalizes the workaround while the audit trail still claims the control held. The accepted residual cost is that a mis-placed hold also waits for a second actor; the Phase 2 remedy, if live operation shows it matters, is a narrow placer-only void path, not a weaker release.
2. **Defect-code catalogue - ANSWERED: one flat enterprise catalogue, ten seed codes.** Folded into Binding Scope Decision 10. Per-site catalogues are incompatible with the enterprise-wide repeat count in Decision 12, because the same physical defect coded differently at two plants never reaches the threshold and the FR-Q-10 rule silently never fires. The seed list is `DIMENSIONAL,SURFACE_FINISH,MATERIAL_NONCONFORMITY,CONTAMINATION,ASSEMBLY,FUNCTIONAL,MARKING_LABELLING,PACKAGING,CORROSION,DOCUMENTATION`, shipped as the `QC_DEFECT_CODES` default and changeable per environment without a code change.
3. **Repeat-defect scope - ANSWERED: enterprise-wide, as originally written.** Folded into Binding Scope Decision 12. A defect repeating across sites is the systemic one a CAPA exists to address, so per-site scoping is blind to the most important class. Per-site also divides the signal by the number of sites, needing roughly threshold times site-count enterprise occurrences before firing. And the error direction favours enterprise: over-firing costs a CAPA form, under-firing costs a recall. A per-site variant remains reachable later as one predicate behind a config flag; the reverse migration is not cheap, so enterprise is the correct default to start from.

## References

- [epics.md, Epic 8, Story 8.5](../planning-artifacts/epics.md)
- [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md), sections "Invariants and Rules" (AD-3, AD-8, AD-12, AD-14, AD-16, AD-17), "Consistency Conventions", "API Contract" (stable error codes), "Event Envelope"
- [prd.md, FR-Q-09 and FR-Q-10](../planning-artifacts/prds/prd-Inventory%20Management%20System_2-2026-07-10/archive/prd.md)
- [Story 8.4](8-4-coa-coc-retention-samples-and-batch-release-records.md), sections "Post-Review Notes (2026-08-30)" and "Previous Story Intelligence (Story 8.3)"
- [Story 8.3](8-3-lot-disposition-accept-reject-conditional-release.md), the NCR creation and outcome contract
- [Story 2.3](2-3-lot-batch-and-serial-traceability.md), `lot_master.quality_hold_status` and `lot_trace`
- [Story 3.7](3-7-packing-shipping-and-dispatch-documents-fr-w-05-fr-w-06.md), the dispatch gate and dispatch documents
- [Story 7.8](7-8-offline-technician-workflow-and-closure-codes.md), the fail-closed code-catalogue config pattern

## Dev Agent Record

### Agent Model Used

Fable 5 (claude-fable-5), Claude Code CLI, 2026-08-31.

### Debug Log References

Disclosed deviations from the story text (Binding Scope Decision 1 discipline: disclose, never silently change):

1. **Task 8 / Error table `NCR_EXISTS`: the story misstates the existing behaviour.** No `NCR_EXISTS` code exists anywhere in the codebase at baseline `df7f3c3`; the Story 8.3 constraint chain resolves `uq_qc_ncr_lot` / `uq_qc_ncr_disposition` through the `DISPOSITION_EXISTS` arm ("a raced second reject surfaces ... same code, same shape"). Byte-identical preservation therefore means the renamed `uq_qc_ncr_lot_disposition_sourced` and partial `uq_qc_ncr_disposition` keep resolving to `DISPOSITION_EXISTS`, which the regression test asserts. The error-contract table row for `NCR_EXISTS` is unimplementable as written.
2. **Task 6 route module: `qc`, not `quality`.** The story says `module: 'quality'` for the trace route, but every Story 8.x route, the site-scope helpers (`assertReadSiteAccess`, `scopedSiteIds`) and `AUDITED_REJECTIONS` live on module `qc`; `quality` is the legacy Story 2.3 lots surface. The trace route uses `requireRole({ module: 'qc', functionScope: 'read' })` like its siblings.
3. **Hold-sourced NCR on an un-held lot: `HOLD_NOT_FOUND` (404).** Task 4 demands the refusal but the error table names no code for it; `HOLD_NOT_FOUND` ("the named hold does not resolve") is reused rather than minting an undocumented code.
4. **Flag/reason stacking rules (not specified by the story).** Placement preserves a pre-existing `quality_hold_reason` when the lot is already flag-held (so a governed hold layered over `scrap_pending` cannot launder it); release clears the flag only when no other open governed hold exists AND the reason is not `scrap_pending`. Consequence: a governed release WILL clear a Story 2.3 ad hoc hold's flag (QC release supersedes ad hoc); the scrap containment is the one absolutely protected axis. Covered by a dedicated test.
5. **`CAPA_EXISTS` has no reachable test.** `capa_number` is minted from `qc_capa_number_seq` under the transaction, so neither a sequential nor a concurrent API path can collide; the 23505 arm exists as a backstop only. Every other `*_EXISTS` code has both sequential and concurrent tests.
6. **CAPA open/close carry no `LOCATION_ACCESS_DENIED` test.** A CAPA is enterprise-scoped (sku-grain, no site column), so there is no site axis to deny; the link route (which rides the NCR's site) has the test instead.
7. **Five-enforcement-path proof shape.** stock.issued + stock.allocated (HTTP), `assertQcGateAllows` (direct, `dispatch` operation), `validateLotForIssueAllocate` (direct) and `applyDispatchShippingDocumentsGeneratedProjection` (direct over seeded packing fixtures) are exercised. `cross-dock.ts` and `receiving.ts` read the same single `lot_master.quality_hold_status` flag (verified by inspection; receiving's read is a cross-dock qualification filter, not a rejection) but their appliers need GRN/ERP/task fixture chains disproportionate to this story; the flag semantics those two paths consume are what the four exercised paths prove.
8. **Migrate-twice failure found and fixed at the gate.** The original qc_ncr guard block re-added the dropped `uq_qc_ncr_disposition` constraint, colliding with the same-named replacement partial index on re-apply ("relation uq_qc_ncr_disposition already exists"). The two superseded add-if-missing guards were removed in both SQL copies and the removal is pinned by the Story 8.5 drift test (the Story 6.3 narrow-guard lesson, live).
9. **Guard ordering in `applyNcrOutcomeRecorded`.** The Story 8.3 `LOT_ON_HOLD` fail-closed check now runs AFTER the ncr fetch and the Decision-14 origin gate (a hold-sourced NCR's lot is held by definition, so its vocabulary refusal must win), and is skipped for `closed_with_capa` (moves no stock). The lot lock is still taken first; disposition-family behaviour on a held lot is unchanged.

### Completion Notes List

- All 4 ACs implemented and integration-tested end to end (test/integration/story-8-5.test.ts, 20/20): governed `qc_quality_hold` over the single `lot_master.quality_hold_status` enforcement flag (zero new blocking predicates), segregated reason-carrying release (SOD, no escape hatch), Story 2.3 clear route fail-closed (`QUALITY_HOLD_GOVERNED`), where-used/where-shipped trace with declared coverage and the measured 15-minute budget, edge propagation via the global `quality_holds` bucket + synced `held_lot` table + pre-capture guard, `LOT_ON_HOLD` replay classification to `needs_attention` (unit + edge-route tests), hold-sourced NCR with fail-closed defect-code catalogue, first-class CAPA with server-minted numbers, enterprise-wide strict 90-day IST repeat window (boundary-tested at 89/90 days and same-day), and the mandatory-CAPA close gate (`APPROVAL_REQUIRED` naming count, window and link route).
- Config: `config.qc.{defectCodes, repeatDefectThreshold, repeatDefectWindowDays, holdPropagationBudgetMinutes}`; both catalogue branches proven by child-process loads (test/unit/qc-defect-codes.test.ts). All six event types central-only BY CONSTRUCTION, asserted.
- qc_ncr widened in place (origin/hold_id/defect_code/capa_id/capa_mandatory, nullable disposition_id/task_id, partial unique replacements, biconditional chk_qc_ncr_origin, `closed_with_capa` outcome); Story 8.3 reject path regression-tested byte-identical (one NCR per rejected lot, `DISPOSITION_EXISTS` on the race).
- Mutation-verified: the `clearQualityHold` fail-closed guard and the mandatory-CAPA close gate were each reverted and their tests confirmed to fail, then restored.
- Gates: `npm run build` clean; `npm run lint` clean; prettier clean on every touched src/test file (pre-existing style noise in untouched files left untouched); `db:migrate` twice idempotent against `ims-postgres-test` (5442); schema-drift suite green; story unit + integration suites green.
- Full regression suite: 1484/1516 passing, 26 failures - EXACTLY the pre-existing baseline noise floor at `df7f3c3` (delta 0, no Story 8.5 or registry failures in the list). The first full run showed +1: the Story 8.2 quality-event-registry drift test correctly caught the six new event types missing from the schema.ts registry; entries added, test green, suite back at the floor.

### File List

New:

- read/projections/qc_quality_hold.sql
- read/projections/qc_capa.sql
- src/read/projections/qc_quality_hold.ts
- src/read/projections/qc_capa.ts
- src/quality/recall-trace.ts
- edge/src/capture/held-lot.ts
- test/integration/story-8-5.test.ts
- test/unit/qc-defect-codes.test.ts
- test/unit/qc-repeat-defect.test.ts

Modified:

- read/projections/qc_ncr.sql
- deploy/compose/init-db.sql
- src/read/projections/qc_ncr.ts
- src/api/v1/lots.ts
- src/api/v1/quality.ts
- src/compliance/quality.ts
- src/config/index.ts
- src/events/migrate.ts
- src/events/schema.ts
- src/events/store.ts
- src/server.ts
- sync/sync-rules.yaml
- edge/src/local-db/schema.ts
- edge/src/components/edge-client.tsx
- edge/src/components/cross-dock-capture.tsx
- test/unit/schema-drift.test.ts
- test/unit/sync-upload.test.ts

## Change Log

- 2026-08-31: Story 8.5 implemented from baseline `df7f3c3`. Governed quality-hold record + release SoD over the existing lot_master flag, Story 2.3 clear route fail-closed, global PowerSync quality_holds bucket + edge held_lot table + pre-capture guard, hold-sourced NCR origin with fail-closed defect catalogue, first-class CAPA, enterprise-wide strict 90-day IST repeat-defect window with the mandatory-CAPA close gate, where-used/where-shipped trace with declared coverage and the measured propagation budget. 9 disclosed deviations in Debug Log References (notably: the constraint chain preserves DISPOSITION_EXISTS, not the story table's NCR_EXISTS; a live migrate-twice failure in the qc_ncr guards was found and fixed). Unit suites and 20/20 story integration tests green; mutation-verified both fail-closed guards.
- 2026-08-31: Code review (adversarial pass: Blind Hunter + Edge Case Hunter + Acceptance Auditor). 1 patch applied: `applyHoldReleased` now compares `lot.quality_hold_reason` to `hold.hold_reason` instead of special-casing `scrap_pending`, so ad hoc holds placed by Story 2.3 are preserved when a governed hold is released.

- 2026-08-31: All three Open Questions answered and closed, each folded into the Binding Scope Decision it governs. Release segregation of duties keeps its guard with no config escape hatch, and the mis-placed-hold cost is accepted with a Phase 2 placer-only void path named as the remedy if it proves common. The defect-code catalogue is one flat enterprise list with ten confirmed seed codes, since per-site catalogues are incompatible with the enterprise-wide repeat count. The repeat-defect window stays enterprise-wide on systemic-defect, signal-dilution and error-direction grounds. No task, error code or file-list change resulted; Task 2 gained the seed catalogue and its both-branch config test.
- 2026-08-31: Created via create-story workflow from baseline `df7f3c3`. 14 binding scope decisions (hold as a governed record over the existing `lot_master` enforcement flag rather than a second axis; lot-scoped holds; the Story 2.3 clear route fail-closed against a governed hold; segregated release with single-actor placement; a global PowerSync bucket for propagation; the 15-minute contract as a measured budget rather than a wait; edge rejection reusing the existing permanent-error and `syncFailures` path; NCR gaining a hold origin behind a partial unique index; defect codes and repeat-defect thresholds as fail-closed config; CAPA as a first-class record; enterprise-wide 90-day IST window; the mandatory-CAPA gate at close rather than at raise; `closed_with_capa` as the hold-sourced terminal outcome). 10 tasks, 3 open questions, 21-code error contract. Status ready-for-dev.

## Review Findings

- [x] [Review][Patch] `applyHoldReleased` can clear ad hoc holds when releasing a governed hold [src/compliance/quality.ts:5173-5177] — Fixed: replaced `scrapParked` special-case with `thisHoldSetTheFlag` comparison (`lot.quality_hold_reason === hold.hold_reason`). The flag is now cleared only when the hold being released is the one that originally set it, preserving any ad hoc hold reason.
