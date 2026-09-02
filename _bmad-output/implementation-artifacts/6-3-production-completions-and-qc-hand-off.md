---
baseline_commit: e03772f0f1bf835751cb27d5d561c08da4f444aa
---

# Story 6.3: Production Completions and QC Hand-off

Status: done

## Change Log

- 2026-08-30: Implemented all 9 tasks from baseline `e03772f`. Two new append-only projections (`production_completion` at one row per output lot, `production_scrap_declaration`), a seven-column guarded upgrade of `production_order`, a definition-guarded widening of the `production_wip_ledger` posting-type and pairing CHECKs for the two relief postings, three new production-stream events plus two nullable rework-linkage fields on the existing creation contract, the completion-output and rework-order resolvers, the `production-completion` compliance seam with its three appliers and fixed lock order, five REST routes, and the symmetric completion tolerance plus two reason-code catalogues in config. 22 integration tests and 13 config unit tests, all passing; schema-drift 130 of 130, spine 6 of 6, tsc, eslint and prettier clean, migrations idempotent twice, full suite 1435 of 1461 with all 26 failures pre-existing and zero new. Three deviations and one out-of-scope spine-allowlist repair are disclosed in Debug Log References. Status moved to review.
- 2026-08-30: Created via create-story workflow from baseline `e03772f` (working tree clean). Epic 8 Stories 8.1 to 8.4 are done and committed, so the QC hand-off contract this story consumes (`receiveQcCompletion`, `qc.completion_received`, `assertQcGateAllows`, `qc.rework_requested`) is live rather than synthetic. 14 binding decisions, 3 new production-stream events, 2 new projections, 1 guarded column upgrade on `production_order`, 1 guarded CHECK upgrade on `production_wip_ledger`, 5 REST routes, 9 tasks. Closes deferred-work entries for FR-MO-07 through FR-MO-10.

## Story

As a production supervisor,
I want completions to post finished quantity into QC Hold as new lots, co-products and by-products handled separately, scrap declarations to relieve WIP, and completion tolerances enforced,
So that only inspected output reaches sellable stock and over-completion is controlled.

## Acceptance Criteria

1. **Given** an In Process order
   **When** a completion is confirmed (FR-MO-07)
   **Then** the completed quantity posts into QC Hold as a new finished-goods lot, never directly to sellable stock

2. **Given** a completion attempts to post output directly to sellable stock (FR-MO-07)
   **When** the posting is validated
   **Then** it is rejected with `error_code: "QC_HOLD_REQUIRED"`; sellable status is reachable only through a QC disposition recorded in Epic 8 (FR-Q-02, FR-Q-05)

3. **Given** an order that yields co-products and by-products (FR-MO-07)
   **When** completion is posted
   **Then** each co-product and by-product is posted as its own lot separately from the primary output

4. **Given** process scrap occurs during the run (FR-MO-08)
   **When** a scrap declaration is recorded
   **Then** WIP is relieved by the declared scrap and the declaration is logged, feeding the expected-versus-actual reconciliation in Story 6.4

5. **Given** a completion would exceed the ordered quantity plus tolerance (FR-MO-09)
   **When** the over-completion is attempted
   **Then** it is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves the over-completion

6. **Given** an order confirmed complete below the ordered quantity minus tolerance (FR-MO-09)
   **When** the supervisor resolves the short completion
   **Then** an explicit close-short decision with a reason code is recorded, residual WIP is dispositioned (returned to stock or declared as process scrap), and the order becomes eligible for the FR-MO-12 closure gate at the reduced quantity; an order with an unresolved short completion cannot pass closure

7. **Given** a QC disposition recorded in Epic 8 requires rework (FR-MO-10)
   **When** a rework order is raised
   **Then** a linked rework order is created referencing the source lot, and the rework order's output posts back into QC Hold as linked lots, re-entering the QC gate and never bypassing it

## Tasks / Subtasks

- [x] Task 1: Database schema (AC: 1, 3, 4, 6, 7)
  - [x] 1.1 Create canonical `read/projections/production_completion.sql`: one row per OUTPUT LOT per completion event, columns per Table 3; `UNIQUE (lot_id)`; `UNIQUE (production_order_id, source_event_id, output_class, bom_line_id)` with `NULLS NOT DISTINCT` so the primary output (null `bom_line_id`) is still covered; `output_class` CHECK `('primary','co_product','by_product')`; `quantity > 0` CHECK; app_user INSERT/SELECT ONLY (append-only, the `production_wip_ledger` precedent) plus readonly_user SELECT
  - [x] 1.2 Create canonical `read/projections/production_scrap_declaration.sql`: one row per scrap declaration, columns per Table 4; `scrap_quantity > 0` CHECK; `relieved_value >= 0` CHECK; non-blank `reason_code` CHECK; app_user INSERT/SELECT ONLY plus readonly_user SELECT
  - [x] 1.3 Upgrade `read/projections/production_order.sql` IN PLACE with guarded `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the seven new columns in Table 5, each with an explicit NOT NULL DEFAULT where declared. Add the guarded `chk_production_order_short_close_pairing` CHECK (all three short-close columns set together or all null) and the partial `uq_production_order_source_rework_event` UNIQUE INDEX `WHERE source_rework_event_id IS NOT NULL`. The 8.4 review lesson applies: an `ADD COLUMN` without an `IF NOT EXISTS` guard and a CHECK added without an existence guard both break re-application against a live database
  - [x] 1.4 Upgrade `read/projections/production_wip_ledger.sql` posting-type and pairing CHECKs to admit `completion_relief` and `scrap_relief` (Table 6). Both constraints ALREADY EXIST with the old definition, so the existing add-if-missing guard will NOT upgrade them: write an explicit DO block that DROPs each constraint when `pg_get_constraintdef` does not contain `completion_relief`, then re-adds the widened definition. Re-applying the file to an already-upgraded database must be a no-op
  - [x] 1.5 Mirror all four files VERBATIM into `deploy/compose/init-db.sql` (CRLF line endings; change both together)
  - [x] 1.6 Register the two NEW files at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (never reorder). The two upgraded files are already registered; their re-application carries the upgrade. Run `npm run db:migrate` twice to prove idempotency
  - [x] 1.7 Add two `EXPECTED` entries to `test/unit/schema-drift.test.ts` for the new projections and EXTEND the existing `production_order` and `production_wip_ledger` entries with the new columns, constraints and index
- [x] Task 2: Event contracts (AC: 1, 3, 4, 5, 6, 7)
  - [x] 2.1 Add three payload/envelope interface pairs to `src/events/schema.ts` in a Story 6.3 block after the Story 6.2 block, shaped per Table 1: `ProductionOrderCompletionPostedPayload`, `ProductionOrderScrapDeclaredPayload`, `ProductionOrderShortCloseRecordedPayload`
  - [x] 2.2 Register all three in `SUPPORTED_EVENT_TYPES` at the tail of the production block (after `production_order.material_returned`), all `streamType: 'production'`, all `requiresBusinessStream: false` (the order row already holds the tag; AD-14 forbids re-tagging). Do NOT add `production` to `INVENTORY_MOVEMENT_STREAM_TYPES`
  - [x] 2.3 Extend the EXISTING `ProductionOrderCreatedPayload` with two optional linkage fields, `source_rework_event_id` and `source_lot_id`, both nullable UUIDs defaulting to null (BD-9: a rework order is an ordinary production order, not a new event type). No registry change, no new event type
  - [x] 2.4 Every instant field requires an explicit UTC offset bounded to plus or minus 15:59; every quantity is an exact decimal STRING matching `^\d{1,12}(\.\d{1,6})?$`; `business_date` is a valid IST `YYYY-MM-DD`. Copy the 6.1 and 6.2 validators verbatim rather than writing new ones
- [x] Task 3: Read projections and accessors (AC: 1, 3, 4, 6)
  - [x] 3.1 `src/read/projections/production_completion.ts`: row type, `insertProductionCompletion`, `getCompletionByLotId`, `listCompletionsByOrder` (pagination, `ORDER BY created_at ASC, completion_id ASC`), and `getCompletedQuantity(orderId, client)` summing the PRIMARY output quantity in SQL NUMERIC (co-products and by-products are separate outputs and never count toward the ordered quantity). NUMERIC read as strings, never `Number()`
  - [x] 3.2 `src/read/projections/production_scrap_declaration.ts`: row type, `insertScrapDeclaration`, `listScrapDeclarationsByOrder`, `getScrappedQuantity(orderId, client)`
  - [x] 3.3 Extend `src/read/projections/production_order.ts`: add the Table 5 columns to `ProductionOrderRow`, `InsertProductionOrderInput` (the two rework linkage fields) and `UpdateProductionOrderStatePatch` (`completed_quantity`, `scrapped_quantity`, the three short-close fields); add `getProductionOrderByReworkEventId(eventId, client)`
  - [x] 3.4 Extend `src/read/projections/production_wip_ledger.ts` with `relieveOpenPostings(orderId, targetValue | 'all', reliefType, reasonCode, sourceEventId, occurredAt, client)`: locks the order's open non-return postings `FOR UPDATE` ordered `created_at ASC, posting_id ASC`, drains `open_quantity` oldest-first in SQL NUMERIC until the target relief VALUE is met, writes one relief posting per drained source posting at the SOURCE posting's `unit_cost`, and returns the drained detail plus the total relieved value. It never drives `open_quantity` negative and never touches `stock_balance`
- [x] Task 4: Output resolver `src/production/completion-outputs.ts` (AC: 1, 3, 5)
  - [x] 4.1 `resolveCompletionOutputs(input: { order, primary_quantity, occurred_at? }, client): Promise<CompletionOutputSet>` - PURE read-and-compute, the `release-gate.ts` and `material-staging.ts` twin. Reads the `bom_line` rows of the order's pinned `released_revision_id` where `output_class IN ('co_product','by_product')` and returns `{ revision_id, primary: {...}, secondary: [{ bom_line_id, output_class, component_item_id, component_sku, expected_quantity, uom }] }`, each secondary quantity computed as `primary_quantity * expected_yield_percent / 100` in SQL NUMERIC
  - [x] 4.2 Revision pinning: reject 409 `BOM_REVISION_DRIFT` when the resolved revision is not `order.released_revision_id` (the 6.2 BD-2 rule, unchanged)
  - [x] 4.3 `resolveCompletionTolerance(order, priorCompleted, newQuantity)`: returns `{ over: boolean, short: boolean, ceiling, floor }` from `config.production.completionTolerancePercent`, all arithmetic as decimal strings settled in SQL NUMERIC, never JS floats
  - [x] 4.4 Do NOT build a costing allocation for the output lots. Finished-goods valuation is explicitly out of scope (BD-8) and logged to deferred work
- [x] Task 5: Compliance seam `src/compliance/production-completion.ts` (AC: 1, 2, 3, 4, 5, 6)
  - [x] 5.1 Structure mirrors `src/compliance/production-material.ts` verbatim: private stream/event-type sets, exported `productionCompletionEventType(envelope)` gate, PURE `assertProductionCompletionShape(envelope)` with no DB access, `applyProductionCompletionProjection(envelope, client, eventId)` switch, module-private `alreadyPersisted`, local `reject()` AppError helper copied verbatim
  - [x] 5.2 `applyCompletionPosted` per the Applier Contracts section: order lock, status gate, tolerance check, output resolution, one lot and one stock receipt and one `receiveQcCompletion` hand-off PER OUTPUT LOT, WIP relief, counter recompute, order aggregate write-back
  - [x] 5.3 `applyScrapDeclared`: order lock, status gate, reason-code validation, `relieveOpenPostings` by the declared scrap value, scrap row insert, `scrapped_quantity` and counter recompute
  - [x] 5.4 `applyShortCloseRecorded`: order lock, status gate, short-completion eligibility, reason-code validation, relief of ALL remaining open WIP, short-close stamps, counter recompute to zero
  - [x] 5.5 All three appliers enforce the plant-location scoping re-check (`assertActorPlantAccess` from the 6.2 seam, exported for reuse) BEFORE any work, so the direct-event path is not a bypass (AD-12, the 6.2 review lesson)
  - [x] 5.6 Declared-and-checked fields reject 409 `PRODUCTION_COMPLETION_DERIVATION_MISMATCH`; server-derived fields are written back onto `envelope.payload` before the `domain_events` insert so the direct-event and handler paths persist byte-identical payloads
  - [x] 5.7 Wire the seam into BOTH `src/events/store.ts` switches: `assertProductionCompletionShape(envelope)` after `assertProductionMaterialShape(envelope)`, and `await applyProductionCompletionProjection(envelope, client, eventId)` after `applyProductionMaterialProjection(...)`, each with a Story 6.3 comment block in the existing style
  - [x] 5.8 Add the 23505 mappings in `src/events/store.ts`: `production_completion_pkey`, `uq_production_completion_lot`, `uq_production_completion_grain`, `production_scrap_declaration_pkey`, `uq_production_order_source_rework_event` into the existing pkey chain (409 `DUPLICATE_EVENT` with the offending id). Confirm whether `uq_lot_master_lot_number` is already mapped; if it is not, map it to 409 `DUPLICATE_LOT`
- [x] Task 6: Rework order creation `src/production/rework-order.ts` (AC: 7)
  - [x] 6.1 `resolveReworkRequest(reworkEventId, client)`: loads the `domain_events` row, rejects 404 `REWORK_EVENT_NOT_FOUND` when it is missing or its `event_type` is not `qc.rework_requested`, and returns the payload fields (`ncr_id`, `lot_id`, `lot_number`, `sku`, `site_id`, `quantity`, `task_id`)
  - [x] 6.2 Reject 409 `REWORK_ORDER_EXISTS` when `getProductionOrderByReworkEventId` already returns an order; the partial unique index makes the race path return the same code through the 23505 mapping
  - [x] 6.3 Derive the new order's fields: `output_item_id` and `output_sku` from the source lot's SKU through `item_master`, `order_quantity` from the rework payload quantity, `plant_location_id` from the rework payload `site_id`, `bom_id` from the item's current BOM, `business_stream` from the source order when the source lot came from one and from `item_master` otherwise, `source_reference_type: 'manual'` and `source_reference_id` set to the `ncr_id`. Persist through the EXISTING `production_order.created` event with `source_rework_event_id` and `source_lot_id` set (BD-9)
  - [x] 6.4 The rework order's own completion re-enters the QC gate with zero special-casing: `applyCompletionPosted` runs the same hand-off, so the rework output is a new lot with its own inspection task (AC7's "linked lots" is the `source_lot_id` linkage on the order, carried onto every `production_completion` row through the order)
  - [x] 6.5 Do NOT consume the source lot here. The rejected source lot is blocked by `assertQcGateAllows` (`LOT_ON_HOLD`, reason `rejected`), and unblocking it for rework consumption is a QC-gate policy change, not a completion change. Log it to deferred work (BD-13)
- [x] Task 7: REST surface, RBAC, wiring (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 7.1 New `src/api/v1/production-completions.ts` with the five routes in Table 7, all `requireRole({ module: 'production', functionScope })` wrapped (reads `read`, writes `write`), plant-location scoping via the exported `assertPlantLocationAccess`, actor stamping, audit context and idempotency-key handling cloned from the 6.2 handlers (blank-key normalization, compute the key ONCE, a `replayIdOrReject`-style pre-check that ALSO verifies `stream_id`)
  - [x] 7.2 Handlers pre-run the same resolutions the seam re-runs (status, tolerance, revision, reason codes) so the caller gets a clean early error; the seam re-enforces everything inside its transaction (AD-12: removing a handler check must never change what is possible through `POST /api/v1/events`)
  - [x] 7.3 Register the routes in the production block of `createAppRouter()` in `src/server.ts`. `POST /api/v1/production-orders/rework` is a STATIC path that would be shadowed by `/api/v1/production-orders/:orderId`, so it MUST be registered before the parameterised siblings; the four `/:orderId/...` routes go after the 6.2 block. Append all five to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` under a Story 6.3 comment
  - [x] 7.4 Every accepted write persists through `persistEvent` WITH the audit context so each completion, scrap declaration, short close and rework-order creation lands in the statutory edit log (FR-AC-13). Add the new permanent rejection codes to `AUDITED_REJECTIONS` so a blocked over-completion is auditable (AC5 requires the attempt to be visible)
- [x] Task 8: Config (AC: 4, 5, 6)
  - [x] 8.1 Extend the `production` block in `src/config/index.ts`: `completionTolerancePercent` parsed from `PRODUCTION_COMPLETION_TOLERANCE_PERCENT` (absent takes the default `5`; present-but-blank fails closed at load; must parse as a decimal string in `[0, 100]`, rejected at boot otherwise). One symmetric value governs both the over ceiling and the short floor (BD-6)
  - [x] 8.2 Add `scrapReasonCodes` from `PRODUCTION_SCRAP_REASON_CODES` (defaults `PROCESS_LOSS,SETUP_REJECT,MACHINE_FAULT,OPERATOR_ERROR,MATERIAL_DEFECT`) and `shortCloseReasonCodes` from `PRODUCTION_SHORT_CLOSE_REASON_CODES` (defaults `YIELD_SHORTFALL,MATERIAL_EXHAUSTED,ORDER_CURTAILED,QUALITY_LOSS`), both parsed EXACTLY like the existing `materialReturnReasonCodes`
  - [x] 8.3 The seam validates a blank or missing reason code as 400 `REASON_CODE_REQUIRED` and a non-blank code outside the list as 422 `SCRAP_REASON_CODE_INVALID` or `SHORT_CLOSE_REASON_CODE_INVALID`, each with the `allowed` list in details (the 7.7 pattern)
  - [x] 8.4 Unit-test the loader in `test/unit/production-completion-config.test.ts`: defaults, blank-fails-closed, out-of-range tolerance, duplicate and over-long reason codes. Assert against LITERAL expected values, never against the config object compared with itself (the 8.4 review lesson: a config test that asserts `config.x === config.x` proves nothing)
- [x] Task 9: Integration tests, regression, ledger (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 9.1 Create `test/integration/story-6-3.test.ts` bootstrapped from `story-6-2.test.ts` (same before-hook migration order, trigger disable/enable, TRUNCATE list extended with `production_completion` and `production_scrap_declaration` and the Epic 8 QC tables, same `makeRequest`/`authFor`/`provisionUser`/`assertNumericEqual` helpers)
  - [x] 9.2 Seed discipline: priced stock receipts (Story 2.4 running-average cost) so WIP relief has a cost basis; a Released BOM carrying at least one `directed_issue` component line, one `backflush` component line and one `co_product` line plus one `by_product` line, both with `expected_yield_percent`; an APPROVED inspection plan effective on the business date for the output item AND for each co-product and by-product item (BD-3: no approved plan means no completion); a DOA entry governing `production_order.over_completion`; a distinct non-recording approver identity for the DOA path
  - [x] 9.3 One failing-first test per AC plus one per error code in Table 8, asserting BOTH the code and the load-bearing detail fields. AC1 asserts the new lot exists, the stock row exists at the plant, the QC inspection task exists with `gate_status = 'qc_hold'`, and the ledger invariant `available = on_hand - allocated - picked` holds. AC2 asserts the output lot cannot be allocated, picked or dispatched while the gate is `qc_hold` (expect `LOT_ON_HOLD`) and that a completion whose hand-off cannot resolve a plan rolls the lot and stock back with it (no orphan lot, no orphan stock row). AC3 asserts one lot and one task per output with distinct lot numbers. AC5 asserts the blocked over-completion, the audit row for the blocked attempt, and the approved path. AC6 asserts short close is rejected inside tolerance, accepted below the floor, records the reason, drives open WIP to zero and sets `short_closed_at`. AC7 asserts the rework order links to the source lot and rework event, that a second raise for the same rework event is `REWORK_ORDER_EXISTS`, and that the rework order's completion produces a lot with its own `qc_hold` task
  - [x] 9.4 Replay test per write route; concurrency tests (two parallel completions racing the tolerance ceiling: one wins, one blocks with `APPROVAL_REQUIRED`; two parallel scrap declarations racing the last open WIP: one wins, one stable rejection); forged-direct-event bypass tests for all three new event types plus the extended `production_order.created` (a forged `source_rework_event_id` naming a non-rework event must be rejected); RBAC and plant-scoping negatives on every route
  - [x] 9.5 Regression: story-6-1 and story-6-2 suites green, story-8-1 through story-8-4 suites green (the hand-off contract is now exercised by a real producer for the first time), spine gate 6/6, schema-drift full count, `tsc`/`eslint`/`prettier` clean, `npm run db:migrate` idempotent twice, full `npm test` at zero NEW failures against the baseline recorded in Dev Notes
  - [x] 9.6 Append the out-of-scope entries listed in the Out of Scope section to `_bmad-output/implementation-artifacts/deferred-work.md`, and mark the four FR-MO-07 to FR-MO-10 deferrals recorded by Story 6.2 as closed

### Review Findings

Code review of story 6-3, 2026-08-31. Group A of 4 (schema, SQL mirror, migrations, drift guard); Groups B, C and D not yet reviewed.

Group A outcome: 11 patches applied, 8 deferred, 7 dismissed as noise, 0 decisions needed. Two regression tests added (zero-WIP scrap refused, scrap event grain refused on re-application) and the new drift assertions were mutation-verified: deleting a column or narrowing a relief arm in init-db.sql fails the suite. Gates after the patches: tsc, eslint and prettier clean on every touched file, migrate idempotent twice, schema-drift 131/131, story-6-3 24/24. Full suite 1437/1464; the failure count moved from 26 to 27 because the documented date-dependent story-5-3 where-used flake activated when the date rolled to 2026-08-31 - it fails in isolation, is recorded in the Story 6.2 baseline, and touches nothing in this diff.

**patch**

- [x] [Review][Patch] The drift guard never reads the Story 6.3 widening block, so Task 1.4's work is unprotected: `extractDoBlock` returns the FIRST `DO $$` block naming a constraint, and the stale Story 6.2 block naming `chk_production_wip_posting_type` sits at line 71 while the widening sits at line 120 - deleting the entire widening from `init-db.sql` leaves all 130 drift tests green [read/projections/production_wip_ledger.sql:66-110, test/unit/schema-drift.test.ts:28-31] - APPLIED: the stale Story 6.2 narrow copies were replaced with the widened definitions in all three places (inline CREATE TABLE, add-if-missing guard, upgrade block), so the first-match block extractDoBlock reads is now the correct text, and a dedicated Story 6.3 drift test asserts both relief pairing arms and the widened vocabulary in BOTH files
- [x] [Review][Patch] The stale Story 6.2 add-if-missing block still adds the NARROW posting-type and pairing definitions and executes BEFORE the widening block; against a database where the constraint is absent while relief rows already exist, that `ADD CONSTRAINT` validates, fails `check_violation` and aborts the file before the widening can run [read/projections/production_wip_ledger.sql:66-110] - APPLIED: that block now adds the widened definitions, so it can no longer re-add a narrow constraint that fails validation and aborts the file; the upgrade block remains because it is the only thing that repairs a database still carrying the Story 6.2 constraint
- [x] [Review][Patch] The seven `ALTER TABLE production_order ADD COLUMN` statements are pinned nowhere - the EXPECTED loop compares only `CREATE TABLE` bodies, named DO blocks, index names and grants - and the comment added to the drift test claims the opposite ("a drift here means the upgrade block was lost from one of the two files"), which is false as written [test/unit/schema-drift.test.ts:1147-1156] - APPLIED: a dedicated Story 6.3 test asserts every ADD COLUMN IF NOT EXISTS fragment against both the canonical file and init-db.sql (the MSME/statutory-due idiom), and the false comment was corrected to say what the generic loop actually covers
- [x] [Review][Patch] `production_scrap_declaration` has no replay or rebuild guard: `scrap_id` is server-minted per call and nothing constrains `source_event_id`, while the sibling `production_completion` defends itself with `uq_production_completion_grain`; the banner's "rebuildable by replaying" claim is false for this table [read/projections/production_scrap_declaration.sql] - APPLIED: uq_production_scrap_declaration_event UNIQUE (source_event_id) added to the table, the guarded block, the init-db mirror, the drift entry and the store.ts 23505 chain, with a regression test proving the duplicate is refused
- [x] [Review][Patch] `scrapped_quantity` is written additively (`scrapped_quantity + $2`) while the completion path writes `completed_quantity` absolutely, so the two aggregates behave differently under any re-application [src/compliance/production-completion.ts:733 vs :628] - APPLIED: rewritten as an absolute SUM over production_scrap_declaration, matching how completed_quantity is written
- [x] [Review][Patch] The inline `chk_production_wip_posting_pairing` in `CREATE TABLE` was left at the Story 6.2 three-branch definition while the inline `chk_production_wip_posting_type` three lines above it was widened; `init-db.sql` runs under `psql -f` per-statement autocommit, so a fresh container boot has a real window where `completion_relief` passes the type check and fails every pairing branch [read/projections/production_wip_ledger.sql:54 vs :57-61] - APPLIED: the inline pairing CHECK now carries all four branches, so a fresh psql -f boot has no window where a relief posting is structurally impossible
- [x] [Review][Patch] `relief_quantity` is filtered `> 0` UNROUNDED and then inserted into `quantity NUMERIC(18,6)`; a residual budget against a high `unit_cost` yields e.g. `0.0000004`, which passes the filter, rounds to `0.000000` on insert and aborts the entire completion transaction on `chk_production_wip_quantity_positive` [src/read/projections/production_wip_ledger.ts:339-356] - APPLIED: ROUND(..., 6) is applied before the positivity filter, so a sub-precision residual is dropped instead of rounding to 0.000000 and aborting the completion; it also keeps the open_quantity decrement and the posting quantity in exact agreement
- [x] [Review][Patch] A scrap declaration against an order with zero open WIP is accepted and relieves nothing: `scrap_value` computes to `0`, the `exceeds` guard is `0 > 0` = false, and a declaration row is written claiming scrap with `relieved_value = 0` - while a smaller scrap against nonzero WIP is correctly rejected, so the guard is inconsistent with itself [src/compliance/production-completion.ts:678-697] - APPLIED: the zero-balance case now rejects SCRAP_EXCEEDS_WIP with the open balance in details, with a regression test; one existing test was reordered to declare scrap during the run, which is the realistic sequence
- [x] [Review][Patch] The partial unique index is pinned by NAME only; the harness has an `indexBodies` facility for exactly this and it was not used, so dropping `WHERE source_rework_event_id IS NOT NULL` or the `UNIQUE` keyword keeps the test green [test/unit/schema-drift.test.ts:1156] - APPLIED: indexBodies now pins the full CREATE UNIQUE INDEX ... WHERE source_rework_event_id IS NOT NULL statement in both files
- [x] [Review][Patch] The widening DROP guard keys on `NOT LIKE '%completion_relief%'` alone, so a constraint definition carrying `completion_relief` but missing `scrap_relief` is treated as already-upgraded and never repaired, permanently rejecting every scrap relief [read/projections/production_wip_ledger.sql:115-158] - APPLIED: the guard keys on both markers, so a half-upgraded constraint is repaired instead of being mistaken for an upgraded one
- [x] [Review][Patch] Four constraints were added that no Table in the Dev Notes names and no Debug Log deviation discloses: `chk_production_order_rework_pairing`, `chk_production_order_completed_non_negative`, `chk_production_completion_line_pairing`, and the `btrim(...) <> ''` strengthening inside `chk_production_order_short_close_pairing`. All four are correct and consistent with the appliers, but they are now hard drift-pinned contracts introduced without disclosure [read/projections/production_order.sql, read/projections/production_completion.sql] - APPLIED: all four are now disclosed in Debug Log References with the reason each one exists

**defer**

- [x] [Review][Defer] `btrim(x) <> ''` strips ASCII space only, so a tab or newline reason passes as "present" [read/projections/production_order.sql:118, read/projections/production_scrap_declaration.sql] - deferred, repo-wide idiom (the Story 6.1 expediting pairing uses the same form) and the API path trims in JS first
- [x] [Review][Defer] Every guarded `ADD CONSTRAINT` block is check-then-ALTER in a read-committed DO block, so two concurrent migration runs can collide with `42710` or, on the new DROP guard, `42704` [read/projections/*.sql] - deferred, pre-existing pattern in every projection file in the repo
- [x] [Review][Defer] `idx_production_completion_task`, `idx_production_completion_item` and `idx_production_scrap_declaration_business_date` are not used by any current query, while no index exists on `production_completion.business_date` [read/projections/production_completion.sql, read/projections/production_scrap_declaration.sql] - deferred, the index set was declared from the Dev Notes tables rather than from the access pattern; revisit when Story 6.4 reconciliation defines the real reads
- [x] [Review][Defer] No upper bound on `quantity` or the accumulating `completed_quantity`, so a pathological magnitude raises an unmapped `22003 numeric_field_overflow` [read/projections/production_completion.sql, read/projections/production_order.sql] - deferred, pre-existing platform-wide (the Story 6.2 posting_value entry records the same gap)
- [x] [Review][Defer] Each relief's `posting_value` rounds to `NUMERIC(14,3)` independently, so N partial value-mode reliefs of one source posting do not sum to that posting's `posting_value` [read/projections/production_wip_ledger.sql:48] - deferred, the zero-WIP path Story 6.4 depends on is unaffected because completion-at-100-percent and close-short both drain via the `'all'` mode, which sets `relief_quantity = open_quantity` exactly
- [x] [Review][Defer] `business_date` on both new tables is a free `DATE NOT NULL` with no database relationship to the adjacent `completed_at` / `declared_at` timestamp [read/projections/production_completion.sql, read/projections/production_scrap_declaration.sql] - deferred, the seam derives it with `toIstCalendarDate` and rejects a divergent declaration, so the gap is direct-SQL only
- [x] [Review][Defer] `production_completion.qc_task_id` carries no uniqueness and no FK, so the one-task-per-output-lot invariant is asserted in a comment and enforced only in `qc_inspection_task` [read/projections/production_completion.sql] - deferred, `uq_qc_inspection_task_lot` makes the duplicate unreachable through the applier
- [x] [Review][Defer] `uq_production_completion_grain` includes `output_class`, so `(order, event, 'co_product', L)` and `(order, event, 'by_product', L)` are distinct tuples for one BOM line [read/projections/production_completion.sql] - deferred, unreachable: `chk_bom_line_output_class` gives a BOM line exactly one class and the resolver reads it from the row

### Review Findings - Groups B, C and D

Code review of story 6-3, 2026-08-31. Groups B (resolvers/accessors), C (events/seam/config) and D (routes/tests), nine adversarial layers. About 140 raw findings deduplicated to 2 decisions, 51 patches, 14 deferred, roughly 55 dismissed.

Outcome: both decisions resolved by the product owner and implemented, all 51 patches applied. 15 new tests and 1 rewritten fixture; the suite went from 24 to 39 tests in this story file and from 13 to 16 in the config unit file. Two fixes were mutation-verified: reverting the replay-before-authorisation ordering fails the new foreign-plant test, and the Group A drift assertions fail when a column or a relief arm is removed from the init-db mirror. Gates after the patches: tsc, eslint and prettier clean on every touched file, migrate idempotent twice, schema-drift 131/131, story-6-3 39/39, config unit 16/16, full suite 1455/1482 with all 27 failures pre-existing (the same set as after Group A, including the date-dependent story-5-3 flake) and 0 new. Group A findings and their resolutions are in the section above.

**decision-needed**

- [x] [Review][Decision] RESOLVED (product owner, 2026-08-31): option (a), a DOA gate on the close-short decision only. `production_order.short_close` is now a DOA transaction type and the ACTING user must be the resolved approver; scrap keeps single-actor control because it is bounded by the cumulative-quantity guard added in the same pass. Close-short and scrap declarations wrote off WIP with NO approval gate, while over-completion carries the full DOA chain. AC6 says "the supervisor resolves the short completion", but no task specified a DOA transaction type for it. Any actor with production write at the plant can post short_close_recorded and clear the entire open WIP balance, or post repeated scrap declarations. Options: (a) DOA gate on close-short only, (b) on both, (c) accept single-actor as the documented control and record the risk [src/compliance/production-completion.ts]
- [x] [Review][Decision] RESOLVED (product owner, 2026-08-31): option (a), the prorated share is measured against the value ISSUED to the order rather than the current open value, so relief tracks output linearly; the share is capped at the currently open value and a completion reaching the ordered quantity still sweeps everything. Partial-completion WIP relief decayed geometrically: the target is a fraction of the CURRENT open value, so three 30-unit completions on a 100-unit order relieve 30, then 21, then 14.7 percent - 65.7 percent of WIP for 90 percent of the order. An order abandoned at 90 percent carries a large phantom WIP balance and every interim period is mis-valued. Options: (a) base the fraction on the ORIGINAL issued value, (b) keep the decay and document it as the costing convention [src/compliance/production-completion.ts]

**patch**

- [x] [Review][Patch] Cross-plant disclosure: the replay short-circuit returns the stored payload BEFORE the order load and the plant-scope check in all three order-scoped POST handlers, so a foreign-plant caller with a known idempotency key reads another plant's completion, lots and cost postings, with no audit row [src/api/v1/production-completions.ts:288,449,519]
- [x] [Review][Patch] The rework route runs resolveReworkRequest, assertNoReworkOrderYet and deriveReworkOrder before assertPlantLocationAccess, making it an enumeration oracle for foreign-plant NCR linkage, SKUs, item ids and order numbers [src/api/v1/production-completions.ts:612-615]
- [x] [Review][Patch] REGRESSION FROM THE GROUP A PATCH: the zero-WIP scrap guard keys on net_open_value, which is SUM(open_quantity * unit_cost). An order whose open postings all carry unit_cost 0 has real open WIP but zero value, so every scrap declaration is rejected with "the order has no open WIP to relieve", which is false. Guard on net_open_quantity [src/compliance/production-completion.ts]
- [x] [Review][Patch] The unit_cost = 0 branch of the drain tests remaining budget with a strict greater-than-zero, so a zero-cost posting following one that exactly consumes the budget is never drained and unreversed_transaction_count stays non-zero - the stranded residue the function comment says cannot happen [src/read/projections/production_wip_ledger.ts:335-346]
- [x] [Review][Patch] A completion can be posted AFTER the order is short-closed: the short-close applier never advances status and no other applier reads short_closed_at, so the order ends up short-closed and still producing with completed_quantity overwritten [src/compliance/production-completion.ts]
- [x] [Review][Patch] BOM_REVISION_DRIFT in the completion resolver is a self-comparison: it loads the PINNED revision and checks it belongs to the order's BOM, so it can never fire on drift. The 6.2 rule it claims to inherit resolves the BOM's CURRENT revision and compares [src/production/completion-outputs.ts:88-106]
- [x] [Review][Patch] Task 6.3's business_stream rule is unimplemented: deriveReworkOrder reads item_master unconditionally and never consults the source order, so a rework of a lot produced under a different stream is permanently mistagged (AD-14 forbids re-tagging) [src/production/rework-order.ts]
- [x] [Review][Patch] Client-controlled completed_at selects the BOM co-product effectivity window; the 6.2 seam explicitly refuses this and uses server time. A backdated completion silently drops a by-product line - no lot, no stock, no QC task [src/compliance/production-completion.ts, src/production/completion-outputs.ts]
- [x] [Review][Patch] auditRejectedAttempt calls getPool().connect() OUTSIDE its try, so a pool-exhaustion rejection escapes and turns a clean 4xx into a 500 - the exact outcome the comment two lines below claims is prevented [src/api/v1/production-completions.ts:118]
- [x] [Review][Patch] An uppercase UUID in the path passes requireUuidParam but fails the strict comparison against Postgres's lowercase stream_id, so the completion COMMITS and then returns 409 [src/api/v1/production-completions.ts]
- [x] [Review][Patch] Short-close reads the WIP summary AFTER persistEvent commits, so a read failure returns 500 on an already-durable decision; the rework route has the same shape and papers a null order over, reporting a null status for an order that was created [src/api/v1/production-completions.ts:572,730]
- [x] [Review][Patch] assertActorPlantAccess returns early on a non-string actor location - an unenumerated fourth bypass beyond the three documented ones - so a direct event omitting metadata.actor.location_id completes any order at any plant [src/compliance/production-completion.ts]
- [x] [Review][Patch] assertActorPlantAccess was re-created in this seam instead of exported from the 6.2 seam, violating Task 5.5, Table 9's file plan and Table 10's reuse rule; two copies that can now drift [src/compliance/production-completion.ts, src/compliance/production-material.ts:403]
- [x] [Review][Patch] The status gate runs before the plant-scope check in all three appliers, so an unauthorised actor gets INVALID_STATE_TRANSITION (400) and learns the order's state instead of LOCATION_ACCESS_DENIED (403) [src/compliance/production-completion.ts]
- [x] [Review][Patch] The documented Locking Contract is inverted in practice: WIP is relieved AFTER the whole output loop, so stock rows and QC-gate rows are locked before WIP - the ordering the contract's own warning names [src/compliance/production-completion.ts]
- [x] [Review][Patch] ROUND to 6 places on the value-bounded branch rounds half-UP, so the drain can exceed the budget; the comment justifies the rounding only as downward protection. Use a floor at NUMERIC scale [src/read/projections/production_wip_ledger.ts]
- [x] [Review][Patch] A relief target that rounds to zero against a non-zero balance (small scrap quantity, large order) writes a scrap declaration that relieves nothing - the Group A guard covers only an exactly-zero balance [src/compliance/production-completion.ts]
- [x] [Review][Patch] getPostingById returning null silently drops a written relief posting from the event payload, so the persisted audit trail under-reports a real WIP movement while relieved_value still counts it; it should throw [src/read/projections/production_wip_ledger.ts:400]
- [x] [Review][Patch] completionTolerancePercent of exactly 100 is accepted and makes AC6 unreachable: the floor is exactly 0 and cumulative-below-zero is never true, so every close-short returns SHORT_CLOSE_NOT_APPLICABLE forever. The validator rejects above-100 for precisely this reason and is off by one [src/config/index.ts]
- [x] [Review][Patch] resolveCompletionTolerance returns ceiling and floor cast to numeric(18,6) but compares the UNROUNDED expressions, so a completion at exactly the ceiling the previous 403 reported is rejected again [src/production/completion-outputs.ts]
- [x] [Review][Patch] Both BOM lookups use ORDER BY created_at DESC LIMIT 1 with no tiebreaker, so with two released BOMs sharing a timestamp the specification revision a co-product is inspected against differs between identical runs, and the rework derivation rejects nondeterministically [src/production/completion-outputs.ts, src/production/rework-order.ts]
- [x] [Review][Patch] A negative expected_yield_percent passes the zero-skip string test and aborts the completion on the quantity CHECK as a 500, after the primary lot and stock already posted. Test for non-positive in SQL [src/production/completion-outputs.ts:163]
- [x] [Review][Patch] resolveReworkRequest casts every payload field without validating it: a malformed qc.rework_requested yields the literal string 'undefined' as order_quantity, reaching a numeric cast as a 500 instead of a domain rejection [src/production/rework-order.ts:78-88]
- [x] [Review][Patch] resolveCompletionOutputs documents a default for business_date but implements none; passing undefined makes the effectivity predicate match nothing and silently returns zero co-products [src/production/completion-outputs.ts]
- [x] [Review][Patch] A co-product line naming the order's OWN output item creates a second lot of that item classed co_product, and the primary-quantity sum excludes it, so the quantity never counts toward the tolerance ceiling or floor [src/production/completion-outputs.ts]
- [x] [Review][Patch] Two co-product lines naming the same item are neither aggregated nor rejected - the exact shape of the 6.2 backflush finding recorded in Previous Story Intelligence [src/production/completion-outputs.ts]
- [x] [Review][Patch] A within-tolerance completion that volunteers over_completion_approved true still runs the DOA branch and is permanently recorded as an approved over-completion with the approver named [src/compliance/production-completion.ts]
- [x] [Review][Patch] The QC hand-off is invoked without an audit context, so every qc.completion_received event minted by a production completion lands in domain_events with no audit row (FR-AC-13) [src/compliance/production-completion.ts]
- [x] [Review][Patch] QC_HOLD_REQUIRED is raised locally for an internal task-id mismatch - a 500-class invariant, not a quality hold - so a client retrying on that code retries forever; Table 8 marks the code delegated [src/compliance/production-completion.ts]
- [x] [Review][Patch] SHORT_CLOSE_NOT_APPLICABLE is overloaded onto a second undeclared trigger (residual WIP after the relief pass), so a caller cannot distinguish "you did not need a short close" from "the server failed to drain WIP" [src/compliance/production-completion.ts]
- [x] [Review][Patch] alreadyPersisted is absent, so this seam replays differently from every sibling seam (Task 5.1 requires it) [src/compliance/production-completion.ts]
- [x] [Review][Patch] revision_id null is admitted by the shape assert but then falls into the drift comparison and returns BOM_REVISION_DRIFT, while business_date null is correctly rejected at shape time - the two optional fields disagree about what null means [src/compliance/production-completion.ts]
- [x] [Review][Patch] scrap_declarations in the GET response is unpaginated and silently truncated at the projection default of 50, while the aggregate quantities in the same response reflect all of them [src/api/v1/production-completions.ts:416]
- [x] [Review][Patch] limit=0 silently returns 50 rows and limit 201-999 silently clamps to 200, while limit=1000 is a 400 whose message says "must be a non-negative integer" [src/api/v1/production-completions.ts:405-414]
- [x] [Review][Patch] The 23505 mapping tells an operator "This completion has already been posted" for a scrap declaration, and returns the raw database constraint name to the caller [src/events/store.ts]
- [x] [Review][Patch] The route-registration comment claims a parameterised sibling would shadow the static rework path, but no such POST route exists - the ordering is right and the stated reason is false [src/server.ts:886-889]
- [x] [Review][Patch] Error codes and payload fields missing from the story's own tables: PRODUCTION_ORDER_NOT_FOUND, PRODUCTION_ORDER_DERIVATION_MISMATCH, BOM_NOT_FOUND and OUTPUT_SPECIFICATION_UNRESOLVED are absent from Table 8; relieved_value and five wip_relief fields are absent from Table 1 [this story file]

**patch (tests)**

- [x] [Review][Patch] assertBalanceInvariant asserts available = on_hand - allocated - picked, but the column is GENERATED ALWAYS AS that expression STORED - the storage engine enforces it and the assertion cannot fail. Six call sites [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] The zone-location test asserts a variable the test's own before-hook assigned; deleting the entire routes file leaves it green [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] RBAC and plant-scoping negatives exist on 1 of 5 routes. Stripping requireRole from the scrap, short-close and rework handlers leaves the suite green [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] The test named "on every write route" calls one route; deleting requireUuidParam from the scrap and short-close handlers leaves it green [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] The replay test asserts only status and a row count, never the body; returning an empty object from the replay path leaves it green. Short-close and rework replay are untested entirely [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] replayIdOrReject's cross-stream and cross-type guard - the 6.1 Group B lesson - has no test; deleting the clause would let cross-order key reuse return a foreign order's payload as a 200 [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] Neither Task 9.4 concurrency test exists (parallel completions racing the ceiling, parallel scraps racing the last WIP), so the order-lock serialization BD-6 depends on is proven only sequentially [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] No forged production_order.created test carrying a bad source_rework_event_id, which Task 9.4 names explicitly; deleting the applier-side linkage validation ships green. No forged short_close_recorded direct-event test either [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] QC_HOLD_REQUIRED (AC2's own code), APPROVAL_UNRESOLVED, DUPLICATE_EVENT and WIP_COST_UNRESOLVED are asserted nowhere; the two inspection-plan codes are collapsed into one OR-assertion that pins neither status nor code [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] The AC5 audit assertion counts audit rows by error code across the whole database and asserts only that the count rose; writing the row with a null user, a 200 status and empty details leaves it green [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] AC1 asserts the relief list is non-empty under a message promising one entry per drained posting; returning only the first entry leaves it green [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] The fixture seeds no directed_issue component line (Task 9.2 requires one), so every drain runs against a SINGLE open posting and the oldest-first multi-posting ordering, partial drain and source-cost rule of BD-8 are structurally untested [test/integration/story-6-3.test.ts]
- [x] [Review][Patch] Over-broad config regexes: the zero-tolerance assertion matches 0.5, 05 and 0abc, and the 2.5 assertion matches 2.55. The short-close catalogue also lacks the duplicate and over-long cases its scrap twin has [test/unit/production-completion-config.test.ts]
- [x] [Review][Patch] No coverage for limit/offset validation, GET-route 404/400/RBAC paths, empty or non-object request bodies, or quantity-field validation on any route [test/integration/story-6-3.test.ts]

**defer**

- [x] [Review][Defer] resolveApprover takes no client, so the DOA read runs on a second pool connection while the order lock is held - a pool self-deadlock under concurrency, and the decision is read outside the transaction snapshot despite the comment claiming otherwise [src/api/v1/indents.ts:66] - deferred, pre-existing since Story 6.1 which calls it identically; wants a client-accepting overload platform-wide
- [x] [Review][Defer] resolveApprover is called with value 0 while the registry filters strictly greater-than value_min, so an entry configured with value_min 0 never matches and every over-completion is unapprovable [src/read/projections/doa_registry.ts:189] - deferred, pre-existing; Story 6.1's release override has the same shape
- [x] [Review][Defer] relieved_value sums per-posting values each rounded to 3 decimals while open_quantity decrements at 6, so the reported figure drifts from the value actually removed - deferred, recorded in the Group A defer list; unaffected on the paths Story 6.4 depends on
- [x] [Review][Defer] relieved_value is scoped by order and source event rather than to the postings the call just wrote, so a second relief pass under one event id would double-count - deferred, each applier calls it exactly once per event today
- [x] [Review][Defer] The ordered FOR UPDATE preamble is a separate statement from the drain, so a posting committed between them is drained without having been locked; the real serialization is the order lock every caller holds - deferred, correct today, wants the precondition documented on the function
- [x] [Review][Defer] LIMIT/OFFSET pagination over a random-UUID tiebreaker can duplicate or skip rows across pages - deferred, pre-existing repo-wide (the Story 6.2 WIP ledger entry records the same gap)
- [x] [Review][Defer] completed_at, declared_at and decided_at are unbounded in either direction, so a completion can be booked to 2019 or 2099 - deferred, no period-close model exists anywhere in the codebase; the BOM-effectivity half of this is patched above
- [x] [Review][Defer] Timestamp offsets between 15:00 and 15:59 are accepted although the real maximum is 14:00 - deferred, the bound is copied verbatim from the 6.1/6.2 validators
- [x] [Review][Defer] Years below 1000 pass validation but the IST formatter emits them unpadded, so a declared business_date mismatches on zero-padding alone - deferred, unreachable through any real client
- [x] [Review][Defer] Quantities near the 12-integer-digit regex limit overflow the numeric casts as an unmapped 22003 500 - deferred, pre-existing platform-wide, recorded in the Group A defer list
- [x] [Review][Defer] No cap on the number of secondary outputs, so a revision with 200 output lines holds the order lock across hundreds of statements and embeds a 200-element array in the event payload - deferred, no BOM in the pilot has more than a handful of output lines
- [x] [Review][Defer] createLot is called with a null expiry date for every manufactured lot regardless of shelf life, so FEFO consumers treat manufactured stock as never expiring - deferred, no shelf-life field is modelled on item_master; wants its own story
- [x] [Review][Defer] A pre-existing lot number matching the server-minted pattern makes an order permanently un-completable, surfacing as DUPLICATE_LOT with a null lot id - deferred, requires a hand-typed lot colliding with the reserved MO- namespace
- [x] [Review][Defer] Order existence is disclosed before authorization on all five routes (404 versus 403) - deferred, matches the Story 6.2 precedent; wants a platform-wide decision rather than a per-story divergence

## Dev Notes

Baseline: commit `e03772f` (working tree clean at story creation, 2026-08-30). Record the full-suite pass/fail counts at this baseline BEFORE the first code change; the bar is zero new failures. The last recorded noise floor was 26 pre-existing failures at `94056d9`; re-measure rather than trusting that number.

This story packs four FRs (FR-MO-07 completions and co/by-products, FR-MO-08 scrap, FR-MO-09 tolerances, FR-MO-10 rework orders) with seven acceptance criteria and no dev notes in `epics.md`. These Dev Notes ARE the technical context. It sits on the Story 6.1 order lifecycle, the Story 6.2 WIP ledger, the Story 5.5 explosion and BOM output-class model, and - for the first time in a real producer - the Story 8.1 QC hand-off contract.

### Binding Decisions

These decisions are binding precedent. Do not re-litigate them in implementation; a deviation needs an explicit recorded reason.

1. **The QC hand-off is delegated, never re-implemented.** Every output lot enters the gate through `receiveQcCompletion` in `src/quality/completion.ts` on the SAME transaction client, with `source_completion_type: 'production_order'` and `source_completion_id` set to the `production_completion.completion_id`. Story 8.1 owns plan resolution and freezing, the durable inspection task, the `qc_hold` gate row, the event, the audit entry and the notification. This story creates the lot and posts the finished stock BEFORE the call, because the 8.1 applier reads both and rejects `QC_HOLD_REQUIRED` when either is missing. Re-deriving any 8.1 check here is a defect, not a safety net.

2. **QC Hold is a gate state, not a bin.** Finished stock posts as ordinary `stock_class = 'owned'` at the order's `plant_location_id` through `applyStockReceipt`. What holds it back is the Story 8.1 gate: `assertQcGateAllows` raises `LOT_ON_HOLD` for a `qc_hold` task on allocation, picking and dispatch. Do NOT invent a QC-hold location, a QC-hold stock class or a second hold axis; the 8.1 applier itself rejects a lot that is already allocated or picked, so the hand-off must run before anything can consume the output.

3. **A completion requires an approved inspection plan and fails closed without one.** `resolveInspectionPlanForLot` rejects `INSPECTION_PLAN_NOT_FOUND` (404) or `INSPECTION_PLAN_NOT_APPROVED` (409) when no approved plan version is effective on the completion's IST business date for the output item. That rejection rolls back the whole completion including the lot and the stock receipt. This is the correct fail-closed behaviour for AC2 and it applies to co-products and by-products too, each of which is its own governed output. It is also the single most likely source of a confusing test failure: seed a plan per output item.

4. **One transaction, all outputs.** A completion event creates the primary lot and every co-product and by-product lot, posts every stock effect, runs every hand-off and relieves WIP inside the single `persistEvent` transaction. A partial completion is impossible by construction. There is no per-output event and no per-output route.

5. **Output lot numbers are server-minted and immutable.** The applier mints `{order_number_ext}-L{n}` where `n` is a per-order sequence over `production_completion` rows already written for the order, allocated under the order lock. A declared `lot_number` that disagrees rejects `PRODUCTION_COMPLETION_DERIVATION_MISMATCH`; this is the Story 6.1 `ORDER_NUMBER_IMMUTABLE` posture applied to lots. Collisions surface as the `uq_lot_master_lot_number` 23505 mapping.

6. **One symmetric tolerance value.** `config.production.completionTolerancePercent` governs the over ceiling (`order_quantity * (1 + t/100)`) and the short floor (`order_quantity * (1 - t/100)`) alike. A per-item or per-BOM tolerance registry is speculation and is explicitly NOT deferred: it is withdrawn. Both bounds are settled in SQL NUMERIC against the CUMULATIVE primary completed quantity, never against a single event's quantity, so five small over-completions cannot slip past the ceiling one at a time.

7. **Over-completion approval is the DOA registry, not a role.** The approval path clones `production_order.release_override` verbatim against the transaction type `production_order.over_completion`: `resolveApprover` must resolve (`APPROVAL_UNRESOLVED` 404 otherwise), the declared `approved_by` must equal the resolved approver (`APPROVAL_REQUIRED` 403 otherwise), and the ACTING user must BE the resolved approver (`APPROVAL_REQUIRED` 403 otherwise). The third check is the one that closes the direct-event forgery, and it is the check Story 6.1's review had to add.

8. **WIP relief is by value, oldest posting first, and never allocates cost to output.** AMENDED 2026-08-31 on a product-owner decision: the prorated share is measured against the value ISSUED to the order, not against whatever is still open. Prorating against the current open value made relief decay geometrically, so three 30-unit completions on a 100-unit order relieved only 65.7 percent of WIP for 90 percent of the order and every interim period was mis-valued. The share is still capped at the currently open value, and a completion that reaches the ordered quantity still sweeps everything. A completion relieves the share of open WIP that corresponds to the completed fraction of the order (`this_completion_primary_quantity / order_quantity` of the open WIP value at that moment), draining `open_quantity` on the order's open non-return postings oldest-first and writing one `completion_relief` posting per drained source posting at the SOURCE posting's `unit_cost`. When the cumulative primary quantity reaches or exceeds the order quantity, or on a short close, ALL remaining open WIP is relieved so rounding drift cannot strand a residue that Story 6.4's zero-WIP closure gate would then block on forever. Finished-goods valuation (what the output lot is worth) is deliberately NOT modelled here: the Story 2.4 valuation seam is gated to the inventory stream and cross-stream valuation coherence is an existing logged platform gap, not this story's job.

9. **A rework order is an ordinary production order.** It is created through the EXISTING `production_order.created` event with two new nullable linkage fields, not through a new event type and not through a second order-creation applier. Everything Story 6.1 enforces (immutable number, state machine, release gate) applies to it unchanged, which is exactly what AC7 wants: the rework output re-enters the gate because it goes through the same completion path.

10. **Scrap relieves WIP and moves no stock.** A scrap declaration is a WIP relief plus an append-only declaration row. It creates no lot, posts no stock and writes no negative balance. The physical scrap intake (FR-SC) is Phase 2 (Epic 16), exactly as Story 8.3 parked its scrap disposition; this declaration is the AD-10 source document for it.

11. **Short close is a decision, not a state transition, and it is DOA-gated.** AMENDED 2026-08-31 on a product-owner decision: a close-short writes off the entire remaining open WIP balance, a larger exposure than the over-completion that already carried an approval chain, and AC6 says "the supervisor resolves the short completion". The acting user must BE the approver resolved from the DOA registry for `production_order.short_close`; there is no separate declared-approver field because the person recording the decision is the person making it. An order carrying a close-short decision also accepts no further completions or scrap declarations. `applyShortCloseRecorded` stamps `short_close_reason`, `short_closed_at` and `short_closed_by` on the order and relieves the residual WIP; it does NOT move the order to `completed` or `closed`. The `in_process` to `completed` transition stays on the Story 6.1 `production_order.state_changed` route, and the closure gate is Story 6.4. AC6's "eligible for the FR-MO-12 closure gate" means the short-close stamp exists and WIP is zero; the gate that reads it is 6.4's to build.

12. **Status gate.** All three new events require order status `in_process` (AC1 says "an In Process order"). `released` is not enough: material may be staged and issued in `released`, but nothing is produced until the order is in process. `completed`, `closed` and `cancelled` reject 400 `INVALID_STATE_TRANSITION`. This is deliberately narrower than the 6.2 gate and must not be widened silently.

13. **The rejected source lot is not consumed here.** A lot dispositioned as rework is blocked by `assertQcGateAllows` with `LOT_ON_HOLD` reason `rejected`. Making that lot consumable by its own rework order is a QC-gate policy change with a real bypass risk, and no AC asks for it: AC7 requires the linked order to exist and its OUTPUT to re-enter the gate. Log the consumption path to deferred work.

14. **No edge, no PowerSync, no ERP outbound.** Story 6.4 owns offline execution (FR-MO-13). The production stream has no edge capture module and this story adds none. No `emitNotification` call is added either: the QC hand-off already emits the transactional inspection notification, and duplicating it here would double-notify.

### Event Contract

Three new events on the EXISTING `production` stream; `stream_id` is `production_order_id` for all three. All are `requiresBusinessStream: false` (the 6.1 BD-2 precedent). Table 1 lists the payload contracts. Every field marked "derived" is DECLARED in the payload and CHECKED against the server derivation (409 `PRODUCTION_COMPLETION_DERIVATION_MISMATCH` on divergence); every field marked "write-back" is stamped by the applier onto `envelope.payload` before the `domain_events` insert.

Table 1: Story 6.3 event payload contracts

| **Event type** | **Payload fields (declaration rules)** |
| --- | --- |
| `production_order.completion_posted` | `production_order_id` (UUID), `primary_quantity` (decimal string, strictly positive), `completed_at` (explicit-offset instant), `revision_id` (derived: must equal `released_revision_id`), `business_date` (write-back: IST date of `completed_at`), `over_completion_approved` (boolean, default false), `approved_by` (UUID or null; required exactly when `over_completion_approved` is true), `outputs[]` (write-back: one per output lot, each with `completion_id`, `output_class`, `bom_line_id` (null on the primary), `output_item_id`, `output_sku`, `lot_id`, `lot_number`, `quantity`, `uom`, `qc_task_id`), `wip_relief[]` (write-back: one per drained source posting, each with `posting_id`, `source_posting_id`, `quantity`, `unit_cost`, `posting_value`), `completed_by` (write-back: actor) |
| `production_order.scrap_declared` | `production_order_id`, `scrap_id` (write-back: server-minted UUIDv4), `scrap_quantity` (decimal string, strictly positive), `uom` (derived from the order), `reason_code` (non-empty; membership-checked against config), `declared_at`, `business_date` (write-back), `relieved_value` (write-back), `wip_relief[]` (write-back, shaped as above), `declared_by` (write-back) |
| `production_order.short_close_recorded` | `production_order_id`, `reason_code` (non-empty; membership-checked against config), `decided_at`, `business_date` (write-back), `completed_quantity` (write-back: cumulative primary quantity at decision time), `residual_disposition` (`'returned'` or `'scrapped'`; declares how the residual material was handled, and is a recorded fact, not an action this event performs), `relieved_value` (write-back), `wip_relief[]` (write-back), `short_closed_by` (write-back) |

The EXISTING `production_order.created` payload gains `source_rework_event_id` and `source_lot_id`, both optional and nullable UUIDs. A declared `source_rework_event_id` that does not name a persisted `qc.rework_requested` event rejects 404 `REWORK_EVENT_NOT_FOUND` inside the applier, so the direct-event path cannot forge a rework linkage.

`production_order.completion_posted` also carries `relieved_value` (write-back), and every `wip_relief[]` entry carries `bom_line_id`, `component_item_id`, `component_sku`, `lot_number` and `source_location_id` in addition to the five fields listed above. Both widenings were found undeclared by the 2026-08-31 code review and are recorded here because a persisted event payload is a permanent contract.

Envelope metadata follows the spine envelope contract: `metadata.actor` from auth, `metadata.correlation_id` set to the order id by the handlers, `metadata.device_id` null (central-plane events), `metadata.capture_method` MANUAL.

### Table Definitions

Table 2 lists the new and upgraded database objects; Tables 3, 4, 5 and 6 give their column and constraint detail.

Table 2: Schema objects touched by Story 6.3

| **Object** | **Kind** | **File** |
| --- | --- | --- |
| `production_completion` | New table | `read/projections/production_completion.sql` |
| `production_scrap_declaration` | New table | `read/projections/production_scrap_declaration.sql` |
| `production_order` | Guarded column upgrade | `read/projections/production_order.sql` |
| `production_wip_ledger` | Guarded CHECK upgrade | `read/projections/production_wip_ledger.sql` |

Table 3: `production_completion` columns

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| `completion_id` | UUID PK | Server-minted; also the `source_completion_id` handed to Story 8.1 |
| `production_order_id` | UUID NOT NULL | Indexed |
| `output_class` | TEXT NOT NULL | CHECK `('primary','co_product','by_product')` |
| `bom_line_id` | UUID | Null on the primary output; the co/by-product line otherwise |
| `output_item_id` | UUID NOT NULL | |
| `output_sku` | TEXT NOT NULL | |
| `lot_id` | UUID NOT NULL | UNIQUE; one completion row per lot |
| `lot_number` | TEXT NOT NULL | Server-minted `{order_number_ext}-L{n}` |
| `quantity` | NUMERIC(18,6) NOT NULL | CHECK greater than zero |
| `uom` | TEXT NOT NULL | |
| `qc_task_id` | UUID NOT NULL | The Story 8.1 inspection task created by the hand-off |
| `plant_location_id` | UUID NOT NULL | The location the finished stock was posted at |
| `business_date` | DATE NOT NULL | IST calendar date of `completed_at` |
| `over_completion_approved` | BOOLEAN NOT NULL DEFAULT false | |
| `approved_by` | UUID | Set exactly when `over_completion_approved` is true (pairing CHECK) |
| `completed_by` | UUID NOT NULL | |
| `completed_at` | TIMESTAMPTZ NOT NULL | |
| `source_event_id` | UUID NOT NULL | |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Table 4: `production_scrap_declaration` columns

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| `scrap_id` | UUID PK | Server-minted |
| `production_order_id` | UUID NOT NULL | Indexed |
| `scrap_quantity` | NUMERIC(18,6) NOT NULL | CHECK greater than zero |
| `uom` | TEXT NOT NULL | Derived from the order |
| `reason_code` | TEXT NOT NULL | CHECK non-blank; membership enforced in the seam |
| `relieved_value` | NUMERIC(14,3) NOT NULL | CHECK at least zero |
| `business_date` | DATE NOT NULL | |
| `declared_by` | UUID NOT NULL | |
| `declared_at` | TIMESTAMPTZ NOT NULL | |
| `source_event_id` | UUID NOT NULL | |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Table 5: `production_order` new columns

| **Column** | **Type** | **Notes** |
| --- | --- | --- |
| `completed_quantity` | NUMERIC(18,6) NOT NULL DEFAULT 0 | Cumulative PRIMARY output only |
| `scrapped_quantity` | NUMERIC(18,6) NOT NULL DEFAULT 0 | Cumulative declared scrap |
| `short_close_reason` | TEXT | Part of the short-close pairing CHECK |
| `short_closed_at` | TIMESTAMPTZ | Part of the short-close pairing CHECK |
| `short_closed_by` | UUID | Part of the short-close pairing CHECK |
| `source_rework_event_id` | UUID | Partial UNIQUE index where not null |
| `source_lot_id` | UUID | The rejected lot this rework order reworks |

Table 6: `production_wip_ledger` widened constraints

| **Constraint** | **Widened definition** |
| --- | --- |
| `chk_production_wip_posting_type` | `posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief')` |
| `chk_production_wip_posting_pairing` | Relief rows (`completion_relief`, `scrap_relief`) require `source_posting_id NOT NULL` and `open_quantity IS NULL`; `scrap_relief` additionally requires `reason_code NOT NULL`, `completion_relief` requires `reason_code IS NULL`; the existing `return` and issue arms are unchanged |

### Reuse Inventory

Every helper in Table 10 already exists and is the ONLY sanctioned way to do that job. Writing a second one is the reinvention defect this section exists to prevent.

Table 10: Existing helpers this story must call rather than re-create

| **Need** | **Call** | **Module** |
| --- | --- | --- |
| Create an output lot | `createLot({ lot_number, sku })` | `src/read/projections/lot_master.ts` |
| Post finished stock | `applyStockReceipt({ sku, location_id, lot_id, quantity })` | `src/read/projections/stock_balance.ts` |
| Enter the QC gate | `receiveQcCompletion(handoff, client, auditCtx)` | `src/quality/completion.ts` |
| Read an item's uom, business stream and BIS flag | `getItemById` / `getItemBySku` | `src/read/projections/item_master.ts` |
| Read open WIP value for the relief target | `getWipSummary(orderId, client)` | `src/read/projections/production_wip_ledger.ts` |
| Recompute the unreversed counter | `getOpenPostingCount(orderId, client)` | `src/read/projections/production_wip_ledger.ts` |
| Explode the pinned revision | `explodeBomForExecution` | `src/compliance/bom-execution.ts` |
| Resolve the DOA approver | `resolveApprover(transactionType, amount)` | `src/api/v1/indents.ts` |
| Re-check plant access inside the seam | `assertActorPlantAccess` | `src/compliance/production-material.ts` (export it) |
| Assert the QC gate on any lot this story reads | `assertQcGateAllows` | `src/compliance/quality.ts` |
| IST business date from an offset-bearing instant | `toIstCalendarDate` | the existing shared helper used by `quality.ts` |

### Applier Contracts

`applyCompletionPosted`, in order:

1. Lock the order row `FOR UPDATE`; 404 when missing.
2. `assertActorPlantAccess` against `plant_location_id`; 403 `LOCATION_ACCESS_DENIED` otherwise. This runs BEFORE the status gate (corrected 2026-08-31): folding the status test into the lock helper meant an unauthorised caller received `INVALID_STATE_TRANSITION` and learned the order's lifecycle state.
3. Status gate: `in_process` only, AND no close-short decision already recorded (BD-12, widened 2026-08-31).
4. Resolve the cumulative primary quantity from `production_completion` under the lock, add this event's `primary_quantity`, and apply the tolerance rule. Above the ceiling without approval, reject 403 `APPROVAL_REQUIRED`; with approval, run the full DOA check chain (BD-7).
5. Resolve the output set from the pinned revision (`resolveCompletionOutputs`), rejecting `BOM_REVISION_DRIFT` on divergence.
6. For EACH output, in the order primary, co-products by `line_no`, by-products by `line_no`: mint the lot number, call `createLot`, `applyStockReceipt` at `plant_location_id`, insert `production_completion`, then call `receiveQcCompletion` with `source_completion_type: 'production_order'`, `source_completion_id: completion_id`, `task_id` minted here so a replay reuses the identity, and the order's `business_stream`. Write the returned `task.task_id` back into the `production_completion` row and onto the payload.
7. Relieve WIP per BD-8 and write the relief postings.
8. Recompute `unreversed_transaction_count` from the ledger under the order lock (the 6.2 Counter Contract, unchanged) and write `completed_quantity`.
9. Write every server-derived field back onto `envelope.payload`.

`applyScrapDeclared`: steps 1, 2, 3, then reason-code validation, then relief by the declared scrap value (bounded by open WIP; a scrap that would exceed open WIP rejects 409 `SCRAP_EXCEEDS_WIP` with the open value in details), then the declaration insert, then `scrapped_quantity` and the counter recompute, then write-back.

`applyShortCloseRecorded`: steps 1, 2, 3, then reject 409 `SHORT_CLOSE_NOT_APPLICABLE` when the cumulative primary quantity is at or above the short floor, and 409 `SHORT_CLOSE_EXISTS` when `short_closed_at` is already set, then reason-code validation, then relief of ALL remaining open WIP, then the short-close stamps and the counter recompute to zero, then write-back.

### Locking Contract

Every applier takes locks in exactly this order, and no applier takes a lock it does not need:

1. `production_order` row `FOR UPDATE` (the order-scoped serialization point, as in 6.2).
2. `production_wip_ledger` open postings `FOR UPDATE` in `created_at ASC, posting_id ASC` order.
3. `lot_master` row for each new output lot (taken by the insert itself, then re-taken `FOR UPDATE` by the Story 8.1 applier).
4. `stock_balance` rows, taken by `applyStockReceipt`.
5. The Story 8.1 gate rows, taken inside `receiveQcCompletion`.

Corrected by the 2026-08-31 code review. The WIP relief was originally written AFTER the output loop, which took stock and gate locks before WIP - the inversion this contract's own warning names. The relief now runs before any lot, stock or gate row is touched, and the order above is what the code does.

Taking the WIP lock before the order lock, or locking stock before WIP, reintroduces the deadlock the 6.2 fixed lock order exists to prevent.

### Routes and RBAC

Table 7 lists the REST surface. All routes are `module: 'production'`; write routes take `functionScope: 'write'`, read routes `'read'`. Every route resolves and enforces plant-location access before doing any work.

Table 7: Story 6.3 REST routes

| **Method and path** | **Purpose** | **AC** |
| --- | --- | --- |
| `POST /api/v1/production-orders/rework` | Raise a linked rework order from a `qc.rework_requested` event | 7 |
| `POST /api/v1/production-orders/:orderId/completions` | Post a completion with its co-products and by-products | 1, 2, 3, 5 |
| `GET /api/v1/production-orders/:orderId/completions` | List the order's output lots and their QC task ids | 1, 3 |
| `POST /api/v1/production-orders/:orderId/scrap-declarations` | Declare process scrap and relieve WIP | 4 |
| `POST /api/v1/production-orders/:orderId/short-close` | Record the close-short decision and clear residual WIP | 6 |

The rework route is static and MUST be registered before `/api/v1/production-orders/:orderId`, which would otherwise shadow it.

### Error Codes

Table 8 is the complete inventory for this story. Codes marked "delegated" are raised by an existing module and must propagate UNCHANGED; wrapping them loses the detail payload the caller needs (the 7.4 rule).

Table 8: Story 6.3 error codes

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `QC_HOLD_REQUIRED` | 409 | Delegated from Story 8.1: the lot or the finished stock is missing, mismatched, or already in sellable use at hand-off time |
| `APPROVAL_REQUIRED` | 403 | Over-completion without approval, or with an approver that is not the resolved DOA approver, or where the acting user is not that approver |
| `APPROVAL_UNRESOLVED` | 404 | No DOA entry governs `production_order.over_completion` |
| `INVALID_STATE_TRANSITION` | 400 | The order is not `in_process` |
| `REASON_CODE_REQUIRED` | 400 | Blank or missing scrap or short-close reason code |
| `SCRAP_REASON_CODE_INVALID` | 422 | Scrap reason code outside the configured list |
| `SHORT_CLOSE_REASON_CODE_INVALID` | 422 | Short-close reason code outside the configured list |
| `SCRAP_EXCEEDS_WIP` | 409 | Declared scrap value exceeds the order's open WIP value |
| `SHORT_CLOSE_NOT_APPLICABLE` | 409 | Cumulative primary quantity is at or above the short floor |
| `SHORT_CLOSE_EXISTS` | 409 | The order already carries a short-close decision |
| `PRODUCTION_COMPLETION_DERIVATION_MISMATCH` | 409 | A declared server-derived field disagrees with the re-derivation |
| `BOM_REVISION_DRIFT` | 409 | The resolved revision is not the order's `released_revision_id` |
| `REWORK_EVENT_NOT_FOUND` | 404 | The named event is missing or is not a `qc.rework_requested` |
| `REWORK_ORDER_EXISTS` | 409 | A rework order already exists for that rework event |
| `WIP_COST_UNRESOLVED` | 409 | Delegated from Story 6.2: a relief target has no resolvable unit cost |
| `INSPECTION_PLAN_NOT_FOUND` | 404 | Delegated from Story 8.1: no plan for an output item |
| `INSPECTION_PLAN_NOT_APPROVED` | 409 | Delegated from Story 8.1: no approved version effective on the business date |
| `LOT_ON_HOLD` | 400 | Delegated from Story 8.1: the QC gate blocks the operation |
| `LOCATION_ACCESS_DENIED` | 403 | The actor holds no assignment covering the order's plant |
| `DUPLICATE_EVENT` | 409 | Idempotency-key or unique-grain replay |
| `PRODUCTION_ORDER_NOT_FOUND` | 404 | The order does not resolve (raised by every applier and every route) |
| `PRODUCTION_ORDER_DERIVATION_MISMATCH` | 409 | A declared rework linkage disagrees with the server derivation from its rework request |
| `OUTPUT_SPECIFICATION_UNRESOLVED` | 409 | A co-product or by-product has no released BOM revision to be inspected against |
| `BOM_NOT_FOUND` | 404 | The reworked item has no released BOM to raise a rework order against |
| `SCRAP_BELOW_RELIEF_PRECISION` | 422 | The declared scrap is too small to relieve any WIP value at the ledger precision |
| `SHORT_CLOSE_RESIDUAL_WIP` | 409 | Residual WIP remains open after the close-short relief pass (a server invariant, distinct from `SHORT_CLOSE_NOT_APPLICABLE`) |
| `QC_TASK_MISSING` | 500 | The QC gate returned a different inspection task than the completion minted |
| `WIP_RELIEF_UNREADABLE` | 500 | A relief posting was written but could not be read back |

Added by the 2026-08-31 code review: the first four were reachable but undeclared, and the last five are new. `QC_HOLD_REQUIRED` is now delegated in fact as well as in the table - the seam no longer raises it locally.

### Files

Table 9 lists every file this story creates or changes.

Table 9: File plan

| **Path** | **Action** |
| --- | --- |
| `read/projections/production_completion.sql` | New |
| `read/projections/production_scrap_declaration.sql` | New |
| `read/projections/production_order.sql` | Guarded column and constraint upgrade |
| `read/projections/production_wip_ledger.sql` | Guarded CHECK upgrade |
| `deploy/compose/init-db.sql` | Mirror all four, CRLF |
| `src/events/migrate.ts` | Register the two new files at the tail |
| `src/events/schema.ts` | Three payload pairs, three registry entries, two optional fields on the created payload |
| `src/events/store.ts` | Shape assert, applier call, five 23505 mappings |
| `src/read/projections/production_completion.ts` | New |
| `src/read/projections/production_scrap_declaration.ts` | New |
| `src/read/projections/production_order.ts` | Row, insert, patch and rework lookup |
| `src/read/projections/production_wip_ledger.ts` | `relieveOpenPostings` |
| `src/production/completion-outputs.ts` | New resolver |
| `src/production/rework-order.ts` | New |
| `src/compliance/production-completion.ts` | New seam |
| `src/compliance/production-material.ts` | Export `assertActorPlantAccess` |
| `src/api/v1/production-completions.ts` | New, five routes |
| `src/api/v1/production-orders.ts` | Rework linkage on the create path |
| `src/server.ts` | Route registration, static before parameterised |
| `src/config/index.ts` | Tolerance and two reason-code lists |
| `test/unit/schema-drift.test.ts` | Two new entries, two extended |
| `test/unit/production-completion-config.test.ts` | New |
| `test/integration/story-6-3.test.ts` | New |
| `test/integration/story-1-9.test.ts` | Five spine allowlist entries |
| `_bmad-output/implementation-artifacts/deferred-work.md` | Close four entries, add the new ones |

### Testing Requirements

Vitest against a real PostgreSQL. The test database is the Docker container `ims-postgres-test` on port 5442; bring it up before running the integration suite. Integration tests bootstrap from `story-6-2.test.ts`: the same before-hook migration order, trigger disable and enable, TRUNCATE list and helper set. Assert absolute ledger values (`on_hand`, `allocated`, `available`), never deltas alone. Every rejection test asserts the error code AND the load-bearing detail fields. Assertions must be independently derivable: an assertion that compares a config value with itself, or checks an expiry only to the year, is the failure mode that let seven HIGH defects ship green in Story 8.4.

### Previous Story Intelligence

From Story 6.2, which this story extends directly:

- Plant-location scoping enforced only in the handler is a bypass; the seam must re-enforce it in every applier. This was a review finding, not a design choice.
- The backflush pre-check had to aggregate per component SKU because two lines can share one SKU. The same class of bug applies here to two co-product lines naming the same output item: aggregate, or reject the duplicate line explicitly.
- `Number()` on a NUMERIC string is a defect. Every quantity and value comparison settles in SQL NUMERIC.
- Empty-string `lot_number` must normalize to null rather than persist.
- Returns reverse at the SOURCE posting's cost, never at today's average. Relief postings follow the same rule.

From Story 8.4, reviewed the same week:

- A missing hold check is the repeat defect of this codebase. Story 8.3 and Story 8.4 each shipped a quality-hold bypass. Any path here that reads a lot must respect `lot_master.quality_hold_status` and the gate, not just the gate.
- A fail-open lookup silently downgrades a control. `resolveCompletionOutputs` and the item lookups must fail closed when the item or revision does not resolve.
- Schema files without column-upgrade guards break re-application. Task 1.3 and Task 1.4 exist because of that finding.

### Architecture Compliance

- AD-12: removing a handler check must never change what is possible through `POST /api/v1/events`. Every handler pre-check has a seam twin.
- AD-14: the business-stream tag is set once at order creation and never re-declared on a downstream event.
- AD-16: same-key replay returns the persisted event, not a second write. The `stream_id` check on the replay pre-check is mandatory (the 6.1 Group B lesson).
- AD-17: notifications are emitted transactionally or not at all. This story emits none directly; the hand-off emits its own.
- FR-AC-13: every accepted write and every permanent rejection in `AUDITED_REJECTIONS` lands in the statutory edit log with the actor.
- NFR-SEC-05 segregation of duties is NOT extended here. Story 8.4's Open Question 3 placed SoD on QC acceptance, not on production completion, and a production supervisor completing their own order is the intended operational flow.

### Out of Scope

Append these to `deferred-work.md` under a Story 6.3 heading:

- Finished-goods valuation of output lots. WIP is relieved but no cost is written onto the output lot or the Story 2.4 valuation row; cross-stream valuation coherence remains the existing logged platform gap.
- Cost allocation between primary output, co-products and by-products (the standard by-product-at-zero-cost convention is not implemented because no output is costed at all).
- Consumption of the rejected source lot by its rework order (BD-13): the QC gate blocks it and unblocking it is a gate-policy change.
- Expected-versus-actual consumption reconciliation and the consumption variance report (Story 6.4, FR-B-08). This story only writes the scrap declarations that feed it.
- The closure gate itself (Story 6.4, FR-MO-12), including the zero-WIP and every-lot-dispositioned checks that read this story's short-close stamp.
- Offline completion capture and the central-only guard for these three event types (Story 6.4, FR-MO-13).
- Physical scrap intake into a scrap stock class (Phase 2, Epic 16, FR-SC).
- Per-item or per-BOM completion tolerance. Withdrawn, not deferred (BD-6).
- Kit-assembly order naming in `source_reference_type` (the FR-I-09 scope note, unchanged from 6.1 and 6.2).

Mark these Story 6.2 deferrals CLOSED: completions and co/by-product posting and QC Hold hand-off (FR-MO-07), process scrap declarations (FR-MO-08), completion tolerances and over/short completion (FR-MO-09), and rework orders from QC dispositions (FR-MO-10), including the unbounded-cumulative-confirmation entry that the tolerance ceiling now bounds.

### Technology Versions

Unchanged from Story 6.2: Node with TypeScript ESM, `pg` for PostgreSQL, Vitest, no new runtime dependency. Adding a dependency for this story is a scope violation.

### Project Structure Notes

The new seam, resolver and route files follow the established one-module-per-concern layout: `src/compliance/*` owns transactional appliers, `src/production/*` owns pure read-and-compute resolvers, `src/api/v1/*` owns handlers, `src/read/projections/*` owns row types and SQL accessors, and canonical DDL lives in `read/projections/*.sql` mirrored into `deploy/compose/init-db.sql`. No variance from that structure is required or permitted here.

### References

- [Epics: Story 6.3](../planning-artifacts/epics.md) - acceptance criteria source, Epic 6 section
- [PRD FR-MO-07 to FR-MO-10](../planning-artifacts/prds/prd-Inventory%20Management%20System_2-2026-07-10/archive/prd.md) - functional requirement text
- [Story 6.1](6-1-production-order-creation-and-release-gate.md) - order lifecycle, DOA override pattern, counter contract
- [Story 6.2](6-2-material-staging-issue-and-wip-ledger.md) - WIP ledger, locking contract, seam structure, reason-code config pattern
- [Story 8.1](8-1-inspection-plans-and-qc-gate.md) - the QC hand-off contract and the gate
- [Story 8.3](8-3-lot-disposition-accept-reject-conditional-release.md) - the `qc.rework_requested` integration contract
- [Story 8.4](8-4-coa-coc-retention-samples-and-batch-release-records.md) - the review lessons cited in Previous Story Intelligence
- `src/quality/completion.ts` - `receiveQcCompletion`, the producer-neutral hand-off
- `src/compliance/quality.ts` - `applyCompletionReceived`, `assertQcGateAllows`, `applyReworkRequested`

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), dev-story workflow, 2026-08-30.

### Debug Log References

Three deviations from the story as written, each forced by something the codebase actually enforces:

1. **Co-products are inspected against their OWN specification revision, not the order's.** The story's Applier Contract handed every output to the QC gate with `bom_revision_id` set to the order's `released_revision_id`. Story 8.1 refuses that: `INSPECTION_PLAN_SCOPE_MISMATCH` rejects an inspection plan whose `bom_revision_id` does not belong to the plan's item, so a co-product could never have had a plan on the parent's revision and every co-product completion would have failed closed forever. `resolveCompletionOutputs` now resolves each secondary output's own current released production BOM revision and the seam hands that to `receiveQcCompletion`. A secondary output with no released BOM has no specification to be inspected against and rejects 409 `OUTPUT_SPECIFICATION_UNRESOLVED` BEFORE any lot or stock is created; that code is additional to the story's Table 8.
2. **`stock_balance.lot_id` carries the lot NUMBER, not the lot UUID.** The column is TEXT and the Story 8.1 gate probe matches on the lot number, so the completion posts its finished stock with `lot_id` set to the lot number. The lot UUID lives on `lot_master` and on `production_completion.lot_id`.
3. **Scrap value is prorated, not measured.** AC4 says WIP is relieved "by the declared scrap", but a scrap quantity is a quantity of OUTPUT while WIP is a value of INPUT. The applier values a declaration as `open_wip_value * scrap_quantity / order_quantity` in SQL NUMERIC and rejects 409 `SCRAP_EXCEEDS_WIP` rather than clamping. Logged to deferred work as a convention.

Four constraints were added that no Table in the Dev Notes names (raised by the Acceptance Auditor, 2026-08-31). All four are correct and consistent with the appliers, but they are now drift-pinned contracts, so they are recorded here rather than left silent:

- `chk_production_order_rework_pairing` forces `source_rework_event_id` and `source_lot_id` to be set together or both null. Table 5 declares them as two independent nullable columns; the applier already rejects the unpaired case, and this makes the pair structural.
- `chk_production_order_completed_non_negative` bundles `completed_quantity >= 0 AND scrapped_quantity >= 0` into one constraint, matching the `NUMERIC ... NOT NULL DEFAULT 0` intent of Table 5.
- `chk_production_completion_line_pairing` binds `bom_line_id IS NULL` to `output_class = 'primary'`. This encodes Table 3's note on `bom_line_id` as a database fact instead of a convention.
- `chk_production_order_short_close_pairing` additionally requires `btrim(short_close_reason) <> ''`. Task 1.3 asked only for all-three-or-none; the non-blank clause follows the Story 6.2 empty-string-normalization lesson.

One out-of-scope repair, disclosed: the Story 1.9 spine route allowlist was missing the four Story 8.4 QC routes (POST and GET on `:taskId/retention-sample` and `:taskId/release`), so that gate had been failing since 8.4 landed. The four entries were added alongside this story's five, because both sets fail the same single assertion and the gate is meaningless while it is red.

No pre-existing behaviour was narrowed: the Story 6.2 material gate stays at `released` or `in_process`; only the three new event types use the narrower `in_process` gate.

### Completion Notes List

- All 9 tasks and every subtask implemented from baseline `e03772f` (working tree clean at start).
- **Task 1 (schema):** `production_completion` and `production_scrap_declaration` created, both append-only (app_user holds INSERT and SELECT only); `production_order` upgraded in place with seven guarded `ADD COLUMN IF NOT EXISTS` columns, three guarded CHECKs and the partial `uq_production_order_source_rework_event` index; `production_wip_ledger` posting-type and pairing CHECKs widened for `completion_relief` and `scrap_relief` through an explicit definition-guarded DROP-then-ADD, because the existing add-if-missing guard could not have upgraded a constraint that already exists. All four mirrored into `deploy/compose/init-db.sql`; `npm run db:migrate` idempotent twice and the widened constraint verified live in the test database.
- **Task 2 (events):** three payload and envelope pairs and three registry entries, all on the `production` stream with `requiresBusinessStream: false`; `ProductionOrderCreatedPayload` extended with the two nullable rework-linkage fields, so there is no fourth event type (Binding Decision 9).
- **Task 3 (accessors):** two new projection modules; `production_order.ts` carries the new columns through the row type, the insert, the patch and a `getProductionOrderByReworkEventId` lookup; `relieveOpenPostings` added to the WIP ledger with an ordered `FOR UPDATE` lock, an oldest-first windowed drain settled entirely in SQL NUMERIC, and a zero-cost-posting arm so a free component can still be closed out.
- **Task 4 (resolver):** `src/production/completion-outputs.ts` with `resolveCompletionOutputs` and `resolveCompletionTolerance`; no output costing was built (Binding Decision 8).
- **Task 5 (seam):** `src/compliance/production-completion.ts` with the three appliers, the fixed lock order, the plant-scope re-check, the derivation write-back, and five new 23505 mappings in `store.ts`.
- **Task 6 (rework):** `src/production/rework-order.ts` resolves the `qc.rework_requested` contract, refuses a second raise, and derives every field of the new order; the `production_order.created` applier validates the linkage so the direct-event path cannot forge one.
- **Task 7 (routes):** five routes, with `POST /api/v1/production-orders/rework` registered before the parameterised siblings that would otherwise shadow it; blocked over-completions are written to the edit log (AC5).
- **Task 8 (config):** `completionTolerancePercent` (symmetric, kept as a string, bounded to 0 through 100, fails closed on a blank value) plus the two reason-code catalogues through a shared parser extracted from the 6.2 loader.
- **Task 9 (tests):** `test/integration/story-6-3.test.ts` 22 of 22 and `test/unit/production-completion-config.test.ts` 13 of 13.
- **Gates:** `tsc` clean, `eslint` clean, `prettier --check` clean, `db:migrate` idempotent twice, schema-drift 130 of 130 (two entries added, two extended), spine 6 of 6 (repaired, see Debug Log References), story-6-3 22 of 22, config unit 13 of 13. Full `npm test`: 1461 tests, 1435 pass, 26 fail, all pre-existing and none in the production, QC or BOM suites (story-2-5 x15, story-2-4 x3, and one each in 1-1, 1-6, 1-7, 2-1, 2-2, 2-3, 2-8 and 3-10 - the documented Epic 1 to 3 idempotency-replay and in-transit family). Zero new failures.
- AC7 is proven end to end through the REAL chain: a production completion enters the QC gate, is sampled, fails a unit, is rejected, the NCR records a rework outcome, the resulting `qc.rework_requested` raises the linked rework order, and that order's own completion produces a NEW lot with its own `qc_hold` task.

### File List

New:

- `read/projections/production_completion.sql`
- `read/projections/production_scrap_declaration.sql`
- `src/read/projections/production_completion.ts`
- `src/read/projections/production_scrap_declaration.ts`
- `src/production/completion-outputs.ts`
- `src/production/rework-order.ts`
- `src/compliance/production-completion.ts`
- `src/api/v1/production-completions.ts`
- `test/integration/story-6-3.test.ts`
- `test/unit/production-completion-config.test.ts`

Modified:

- `read/projections/production_order.sql`
- `read/projections/production_wip_ledger.sql`
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/read/projections/production_order.ts`
- `src/read/projections/production_wip_ledger.ts`
- `src/compliance/production-order.ts`
- `src/config/index.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
