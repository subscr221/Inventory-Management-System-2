---
baseline_commit: aa76e4410afb48f39f115aec8b3269a6487c0218
---

# Story 6.2: Material Staging, Issue, and WIP Ledger

Status: done

## Change Log

- 2026-08-28: Implemented all 9 tasks (64 subtasks) from baseline `aa76e44`. Two new projections (production_order_stage with the (order, bom_line) UNIQUE grain, append-only production_wip_ledger with the posting-pairing CHECK), four new production-stream events (material_staged, material_issued, confirmation_recorded, material_returned), the exported requirement-set service (delegated explosion, revision pinning, truncation rejection), the compliance seam (four appliers, fixed lock order, counter recompute, status gate, write-back of server-derived fields), six REST routes with plant-location scoping and stream_id-checked replay, config material-return reason codes, and a 22-test integration suite covering every AC, the reachable Table 8 error codes, AD-12 forged direct events, replay, concurrency, RBAC/scoping, and ledger invariants. Gates: tsc/eslint clean, prettier clean (story files), db:migrate idempotent x2, schema-drift 110/111 (+2, only the pre-existing gate_dwell CRLF), spine 6/6, story-6-1 41/41, stories 5-1..5-6 127/128 (only the pre-existing story-5-3 where-used date-flake), story-6-2 22/22, full npm test at zero NEW failures (baseline 1230 tests / 17 pre-existing fails: 15 Epic 1-3 idempotency + 1 gate_dwell CRLF + 1 story-5-3 where-used date-flake).
- 2026-08-28: Adversarial code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor): 1 decision-needed, 9 patch, 5 defer, 6 dismissed. Decision resolved (2026-08-28): cancel deallocates staged stock and clears stage rows inside the cancel transaction. All 10 patches applied: seam re-enforces plant-location scoping (assertActorPlantAccess) in all four material appliers; backflush pre-check aggregates per component SKU in SQL NUMERIC (seam + handler); multi-line staging conflict resolver reports the colliding line; confirmation resolves WIP_COST_UNRESOLVED before the drain; Number() float coercion replaced with string comparison; empty lot_number normalized to null; 7.7 comment restored in schema-drift.test.ts; STAGE_NOT_FOUND added to Table 8; change log baseline confirmed at 17 pre-existing fails (Dev Notes "16" was stale: the full suite shows 15 Epic 1-3 idempotency + 1 gate_dwell CRLF + 1 story-5-3 where-used date-flake); DELETE grant added to production_order_stage (recorded deviation, mirrored in init-db.sql). 1 new regression test (cancel deallocates staged stock, clears stage rows, restores available). story-6-2 23/23, story-6-1 41/41, spine 6/6, schema-drift 110/111 (only the pre-existing gate_dwell CRLF), full npm test 1255/1238 (17 fail = the exact pre-existing baseline set, 0 new), tsc/eslint/prettier clean. Status set to done.

## Story

As a production operator,
I want pick tasks for directed lines, backflush on confirmation, a real-time WIP ledger per order, and returns that reverse WIP at issued cost,
So that material consumption is accurate and traceable through the order.

## Acceptance Criteria

1. **Given** a Released order with directed-issue lines (FR-MO-04)
   **When** staging begins
   **Then** pick tasks are generated and staged material is held in `allocated` status until issued to the order

2. **Given** an order with backflush lines
   **When** a production confirmation is posted (FR-MO-04)
   **Then** backflush components are relieved from stock automatically in proportion to the confirmed quantity

3. **Given** an order with backflush lines and insufficient component stock to cover the confirmed quantity
   **When** a production confirmation is posted (FR-MO-04)
   **Then** the confirmation is rejected with `error_code: "INSUFFICIENT_STOCK"` - backflush never drives stock negative - and the shortfall lines are reported to the operator

4. **Given** material has been issued to an order (FR-MO-05)
   **When** the WIP ledger is viewed
   **Then** the production WIP ledger for that order shows accumulated quantity and value in real time, distinct from R&D project WIP

5. **Given** issued material is returned from the order to stock (FR-MO-06)
   **When** the return is posted with a mandatory reason code
   **Then** WIP is reversed at the issued cost and the original lot identity is restored; a return without a reason code is rejected with `error_code: "REASON_CODE_REQUIRED"`

6. **Given** a return that would exceed the quantity issued to the order (FR-MO-06)
   **When** the return is posted
   **Then** it is rejected with `error_code: "RETURN_EXCEEDS_ISSUE"` and the WIP ledger is left unchanged

## Tasks / Subtasks

- [x] Task 1: Database schema (AC: 1, 2, 4, 5, 6)
  - [x] 1.1 Create canonical `read/projections/production_order_stage.sql`: one row per (order, BOM line) for directed-issue staging; columns per Table 3 below; grain UNIQUE `(production_order_id, bom_line_id)`; status CHECK `('allocated','issued')`; `issued_quantity <= required_quantity` CHECK; app_user INSERT/SELECT/UPDATE + readonly_user SELECT guarded grants
  - [x] 1.2 Create canonical `read/projections/production_wip_ledger.sql`: append-only postings per Table 4; posting_type CHECK `('directed_issue','backflush','return')`; quantity > 0 CHECK; open_quantity >= 0 CHECK (NULL on return rows); return rows REQUIRE source_posting_id and reason_code (pairing CHECK); issue/backflush rows FORBID both (pairing CHECK); app_user INSERT/SELECT ONLY (append-only, the Story 7.7 maintenance_warranty_override precedent); readonly_user SELECT
  - [x] 1.3 Mirror both files VERBATIM into `deploy/compose/init-db.sql` (CRLF line endings; change both together)
  - [x] 1.4 Register both at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (never reorder); re-run `npm run db:migrate` twice to prove idempotency
  - [x] 1.5 Add two `EXPECTED` entries to `test/unit/schema-drift.test.ts` (constraints, indexes, appUserGrant per existing entry shape; the generic loop never asserts sequences)
- [x] Task 2: Event contracts (AC: 1, 2, 3, 5, 6)
  - [x] 2.1 Add four payload/envelope interface pairs to `src/events/schema.ts` in a Story 6.2 block after the Story 6.1 block (payload shapes per the Event Contract section below): `ProductionOrderMaterialStagedPayload`, `ProductionOrderMaterialIssuedPayload`, `ProductionOrderConfirmationRecordedPayload`, `ProductionOrderMaterialReturnedPayload`
  - [x] 2.2 Register all four in `SUPPORTED_EVENT_TYPES` at the tail (after `production_order.cancelled`), all `streamType: 'production'`, all `requiresBusinessStream: false` (the order row already holds the tag; AD-14 forbids re-tagging; do NOT add `production` to `INVENTORY_MOVEMENT_STREAM_TYPES`)
  - [x] 2.3 Every instant field requires an explicit UTC offset bounded to +/-15:59; every quantity is an exact decimal STRING matching `^\d{1,12}(\.\d{1,6})?$` (NUMERIC(18,6) ceiling); business_date is a valid IST `YYYY-MM-DD` (copy the 6.1 validators verbatim)
- [x] Task 3: Stock ledger extensions in `src/read/projections/stock_balance.ts` (AC: 1, 2, 3)
  - [x] 3.1 Extend `applyStockIssue` to RETURN the drained-row detail: `Promise<StockDrainRow[]>` where `StockDrainRow = { balance_id, location_id, lot_id, quantity }` (the windowed UPDATE gains a `RETURNING` of the per-row drained delta, filtered to rows actually drained). Existing callers (`transfer-request.ts`, `cross-dock.ts`, `replenishment.ts`, `maintenance-spares.ts`) `await` the void result and are unaffected; document the return-type change in the function header
  - [x] 3.2 Add NEW `applyStockIssueUnderSite(input: { sku, site_location_id, lot_id?, stock_class?, quantity, occurred_at? }, client): Promise<StockDrainRow[]>`: same depth-capped descendant CTE as `getAvailableBalanceUnderSite` (depth < 10), locks ALL matching rows `FOR UPDATE`, checks `SUM(available) >= quantity` in SQL NUMERIC (409 `INSUFFICIENT_STOCK` with sku/site/requested/available details), drains via the same windowed cumulative-SUM pattern ordered `(location_id, lot_id NULLS FIRST, balance_id)` so the drain is deterministic, stamps `last_issue_at` exactly like `applyStockIssue`, returns drained detail. Never touches the existing helpers' behavior
  - [x] 3.3 Do NOT add any further read helper: the backflush pre-check uses one `getAvailableBalanceUnderSite` probe per line (BD-6), and the staging source-bin check uses the descendant CTE shape directly. Building a speculative extra helper is scope creep
- [x] Task 4: Read projections and accessors (AC: 1, 4)
  - [x] 4.1 `src/read/projections/production_order_stage.ts`: row type, insert, `getStageById` (plain + ForUpdate), `listStagesByOrder`, `getStageByOrderAndBomLine`, `markStageIssued`-style patch helper; NUMERIC read as strings, never `Number()` on quantities
  - [x] 4.2 `src/read/projections/production_wip_ledger.ts`: insert posting (issue/backflush/return variants), `getPostingById` (plain + ForUpdate), `listPostingsByOrder` (pagination, `ORDER BY created_at ASC, posting_id ASC`), `getReturnExceeds(postingId, quantity, client)` SQL probe (`quantity > open_quantity - prior returns` settled in NUMERIC), `getOpenPostingCount(orderId, client)` for the counter recompute, and `getWipSummary(orderId, client)` returning net open quantity + net open value in SQL (issue/backflush open_quantity SUM minus nothing - returns reduce open_quantity on the SOURCE posting, so net = SUM of open_quantity over non-return postings)
  - [x] 4.3 `GET /wip` read surface consumes 4.2; the ledger is the real-time source of truth (AC4) - NO separate rollup table (no desync surface to maintain)
- [x] Task 5: Requirement-set service `src/production/material-staging.ts` (AC: 1, 2)
  - [x] 5.1 `resolveMaterialRequirements(input: { order: ProductionOrderRow, quantity: string, supplyMethodFilter: 'directed_issue' | 'backflush', occurred_at?: string }, client?): Promise<MaterialRequirementSet>` - PURE read-and-compute (the `src/production/release-gate.ts` twin): delegates the walk to `explodeBomForExecution` (BD-1), filters requirements by `supply_method`, returns `{ revision_id, business_date, depth_truncated, lines }` where each line carries `bom_line_id, line_no, component_item_id, component_sku, supply_method, required_quantity, scrap_percent, base_quantity_per, alternates`
  - [x] 5.2 Revision pinning: reject 409 `BOM_REVISION_DRIFT` when `explosion.revision_id !== order.released_revision_id` (an ECO superseded the released revision mid-execution; the order must be consciously re-released or cancelled - see Story 5.3 where-used impact source)
  - [x] 5.3 `depth_truncated: true` rejects 409 `MATERIAL_REQUIREMENT_SET_TRUNCATED` (never execute against an incomplete requirement set - the 6.1 release-gate precedent)
  - [x] 5.4 A requirement line with null/blank `component_sku` rejects 409 `COMPONENT_SKU_UNRESOLVED` (unchanged from 6.1)
- [x] Task 6: Compliance seam `src/compliance/production-material.ts` (AC: 1, 2, 3, 5, 6)
  - [x] 6.1 Structure mirrors `src/compliance/production-order.ts` verbatim: private stream/event-type sets, exported `productionMaterialEventType(envelope)` gate, PURE `assertProductionMaterialShape(envelope)` (no DB), `applyProductionMaterialProjection(envelope, client, eventId)` switch, module-private `alreadyPersisted` (plain SELECT on domain_events, never FOR UPDATE), local `reject()` AppError helper copied verbatim
  - [x] 6.2 Four appliers per the Applier Contracts section; fixed locking contract per Table 6; declared-and-checked fields reject 409 `PRODUCTION_MATERIAL_DERIVATION_MISMATCH`; server-derived fields (stage_id, posting_id, unit_cost, posting_value, drain detail, business_date, actor stamps) written back onto `envelope.payload` so direct-event and handler paths persist byte-identical payloads
  - [x] 6.3 All four appliers recompute and write `production_order.unreversed_transaction_count` from the ledger under the order lock (the Counter Contract below)
  - [x] 6.4 All four appliers enforce the order status gate: status must be `released` or `in_process`, else 400 `INVALID_STATE_TRANSITION` (BD-12)
- [x] Task 7: REST surface, RBAC, wiring (AC: 1, 2, 3, 4, 5, 6)
  - [x] 7.1 New `src/api/v1/production-material.ts` with the six routes in Table 7, all `requireRole({ module: 'production', functionScope })` wrapped (reads `read`, writes `write`); plant-location scoping via `assertPlantLocationAccess` (export it from `src/api/v1/production-orders.ts` - it is currently module-private) applied to the order's `plant_location_id` before any work; actor stamping, audit context and idempotency-key handling clone the 6.1 handler conventions (blank-key normalization, compute the key ONCE, `replayIdOrReject`-style replay pre-check that ALSO verifies `stream_id`, not just event_type and UUID-ness - the 6.1 Group B lesson). Every accepted write persists through `persistEvent` WITH the audit context so each material event lands in the statutory edit log (FR-AC-13)
  - [x] 7.2 Stage/issue/confirmation/return handlers pre-run the same resolutions the seam re-runs (status, revision match, availability for backflush) so the caller gets a clean error early; the seam re-enforces everything inside its transaction (AD-12 - removing a handler check must never change what is possible through `POST /api/v1/events`)
  - [x] 7.3 Register the six routes in the production block of `createAppRouter()` in `src/server.ts` (after the existing `/:orderId` routes; keep static-before-parameter ordering) and append all six to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` under the Story 6.2 comment
  - [x] 7.4 Add the 23505 mappings in `src/events/store.ts`: `production_order_stage_pkey`, `uq_production_order_stage_line`, `production_wip_ledger_pkey` into the existing pkey chain (409 `DUPLICATE_EVENT` with the offending id)
  - [x] 7.5 Wire the seam into BOTH store.ts switches: `assertProductionMaterialShape(envelope)` after `assertProductionOrderShape(envelope)` (~line 644) and `await applyProductionMaterialProjection(envelope, client, eventId)` after `applyProductionOrderProjection(...)` (~line 953), each with a Story 6.2 comment block in the existing style
- [x] Task 8: Config (AC: 5)
  - [x] 8.1 Add a `production` block to `src/config/index.ts` after the `bom` block: `materialReturnReasonCodes` parsed from env `PRODUCTION_MATERIAL_RETURN_REASON_CODES` EXACTLY like `maintenance.warrantyOverrideReasonCodes` (absent variable takes the defaults `SURPLUS_TO_ORDER,DAMAGED_IN_PROCESS,INCORRECT_MATERIAL,QUALITY_REJECTED`; present-but-blank fails closed at load; comma-split, trimmed, duplicate-free, per-code ceiling 200 chars, no line breaks)
  - [x] 8.2 The seam validates a return's reason_code against `config.production.materialReturnReasonCodes`: blank/missing rejects 400 `REASON_CODE_REQUIRED` (AC5); a non-blank code outside the list rejects 422 `RETURN_REASON_CODE_INVALID` with the `allowed` list in details (the 7.7 pattern)
- [x] Task 9: Integration tests, regression, ledger (AC: 1, 2, 3, 4, 5, 6)
  - [x] 9.1 Create `test/integration/story-6-2.test.ts` bootstrapped from `story-6-1.test.ts` (same before-hook migration order, trigger disable/enable, TRUNCATE list extended with `production_order_stage` and `production_wip_ledger`, same makeRequest/authFor/provisionUser/assertNumericEqual helpers)
  - [x] 9.2 Seed discipline: stock receipts MUST be priced (`stock.received` with `unit_cost`) so Story 2.4 valuation carries a `running_average_cost` - an unpriced seed trips `WIP_COST_UNRESOLVED` and hides the real behavior under test. The seeded Released BOM must carry BOTH supply methods: at least one `directed_issue` line (the default) and at least one line added with `supply_method: 'backflush'` (Story 5.5 added the field to the add-line payload; without a backflush line AC2/AC3 are untestable)
  - [x] 9.3 One failing-first test per AC plus one per error code in Table 8 (assert BOTH the code and the load-bearing detail fields - the 7.6 Group C lesson); replay test per write route; concurrency tests (two parallel stagings of the same line: one wins, one 409; two parallel backflush confirmations racing the last unit: one succeeds, one stable `INSUFFICIENT_STOCK`); forged-direct-event bypass tests for all four event types (AD-12); RBAC and plant-scoping negatives; ledger-invariant assertions after EVERY stock-touching op (`available = on_hand - allocated - picked` plus absolute on_hand/allocated values, never just deltas - the 7.4 rule)
  - [x] 9.4 AC4 cancel-guard integration (the 6.1 BD-7 contract): issue material, then attempt cancel expecting 409 `UNREVERSED_TRANSACTIONS`; return the full quantity, then cancel succeeds (counter recomputed to zero)
  - [x] 9.5 Regression: story-6-1 suite green, story-5-1 through 5-6 green (explosion contract unchanged), spine gate 6/6, schema-drift full count (+2), edge suite unchanged (no edge file is touched), `tsc`/`eslint`/`prettier` clean, `npm run db:migrate` idempotent x2, full `npm test` at zero NEW failures against the baseline recorded in Dev Notes (16 pre-existing failures: 15 Epic 1-3 idempotency + 1 gate_dwell CRLF)
  - [x] 9.6 Append the out-of-scope ledger entries listed in the Out of Scope section to `_bmad-output/implementation-artifacts/deferred-work.md`

### Review Findings

Code review of story 6-2, 2026-08-28.

**decision-needed**

- [x] [Review][Decision] Cancel after staging strands allocated stock permanently - RESOLVED (2026-08-28): deallocate staged stock and clear the stage rows inside the cancel transaction [src/compliance/production-order.ts]

**patch**

- [x] [Review][Patch] Cancel deallocates staged stock and clears stage rows (from resolved decision): deallocate remaining staged quantity at each allocated stage row and delete the rows inside the cancel transaction - APPLIED [src/compliance/production-order.ts, read/projections/production_order_stage.sql]
- [x] [Review][Patch] Plant-location scoping is handler-only; a scoped production role can act on another plant's order through direct POST /api/v1/events, contradicting the story's AD-12 claim - APPLIED: seam re-enforces it via assertActorPlantAccess (descendant-of-plant walk) in all four appliers [src/compliance/production-material.ts]
- [x] [Review][Patch] Backflush pre-check is per-line, not per-SKU-aggregate: two backflush lines sharing one component SKU pass the probe then fail mid-drain with a single-line detail, violating the AC3 plural `shortfall_lines` contract - APPLIED: pre-check aggregates per component SKU in SQL NUMERIC, both seam and handler [src/compliance/production-material.ts, src/api/v1/production-material.ts]
- [x] [Review][Patch] Multi-line staging duplicate-conflict resolver reports the first declared line, not the colliding line, and can omit `existing_stage_id` - APPLIED: resolver checks every declared line's grain and reports the first collision [src/read/projections/production_order_stage.ts:194-220]
- [x] [Review][Patch] Confirmation applier resolves `WIP_COST_UNRESOLVED` after draining stock instead of before, unlike the issue applier - APPLIED: valuation resolved before the drain; handler pre-checks per SKU [src/compliance/production-material.ts, src/api/v1/production-material.ts]
- [x] [Review][Patch] `Number()` float coercion on the drained-row filter violates the NUMERIC-strings rule; the filter is redundant for returned rows - APPLIED: string comparison `!== '0'` [src/read/projections/stock_balance.ts:436-451,581-588]
- [x] [Review][Patch] Empty-string `lot_number` is accepted and persisted instead of normalized to null, causing a confusing `INSUFFICIENT_STOCK` at allocation - APPLIED: normalized to null in handler and applier, write-back normalized [src/compliance/production-material.ts, src/api/v1/production-material.ts]
- [x] [Review][Patch] Unrelated comment line dropped from the Story 7.7 entry in schema-drift.test.ts - APPLIED: comment restored [test/unit/schema-drift.test.ts]
- [x] [Review][Patch] `STAGE_NOT_FOUND` (404) introduced but absent from the Table 8 error-code inventory - APPLIED: Table 8 updated [6-2-material-staging-issue-and-wip-ledger.md]
- [x] [Review][Patch] Change log baseline inconsistency: "17 pre-existing fails" vs Dev Notes "16" - APPLIED: confirmed the full-suite baseline is 17 (15 Epic 1-3 idempotency + 1 gate_dwell CRLF + 1 story-5-3 where-used date-flake); Dev Notes "16" was stale, change log and sprint-status now agree on 17 [6-2-material-staging-issue-and-wip-ledger.md]

**defer**

- [x] [Review][Defer] `business_date` and stage `created_at` derive from client-controlled `staged_at` while the requirement set pins server time [src/compliance/production-material.ts:632-633] - deferred, per-spec behavior
- [x] [Review][Defer] `posting_value` NUMERIC(14,3) and derived `required_quantity` NUMERIC(18,6) can overflow to an unmapped 500 on pathological magnitudes [src/read/projections/production_wip_ledger.ts:112] - deferred, pre-existing
- [x] [Review][Defer] LIMIT/OFFSET pagination on the append-only WIP ledger can skip or duplicate rows across pages [src/read/projections/production_wip_ledger.ts:196-211] - deferred, pre-existing
- [x] [Review][Defer] Unbounded `lines[]` array in one staging event allows request amplification [src/compliance/production-material.ts:516-629] - deferred, pre-existing
- [x] [Review][Defer] Cumulative confirmations are not bounded by order_quantity, so over-confirmation inflates WIP [src/compliance/production-material.ts:818] - deferred, explicitly out of scope (Story 6.3 FR-MO-09) and already logged

## Dev Notes

Baseline: commit `aa76e44` (working tree clean at story creation, 2026-08-28). Record the full-suite pass/fail counts at this baseline BEFORE the first code change; the bar is zero new failures.

This story packs three FRs (FR-MO-04 staging/backflush, FR-MO-05 WIP ledger, FR-MO-06 returns) with six acceptance criteria and no dev notes in epics.md - these Dev Notes ARE the technical context. It builds directly on the Story 6.1 surface (production order, release gate, the `unreversed_transaction_count` contract) and consumes the Story 5.5 explosion service as its requirement-set source.

### Binding Decisions

These decisions are binding precedent. Do not re-litigate them in implementation; a deviation needs an explicit recorded reason.

1. **Delegation, never re-implementation (the 6.1 BD-1 rule).** Staging and backflush requirement sets come from the exported Story 5.5 service `explodeBomForExecution` via the new `src/production/material-staging.ts` resolver. The service already owns BOM existence (`BOM_NOT_FOUND`), the R&D execution bar (`RD_EXECUTION_BARRED`), released-BOM/revision status (`BOM_NOT_RELEASED`), the NUMERIC quantity contract (`EXPLOSION_QUANTITY_INVALID`), cycle detection, the depth cap and phantom pass-through. Any re-derivation of those checks in this story is a defect, not a safety net. Staging explodes at the ORDER quantity; backflush explodes at the CONFIRMED quantity (proportionality by construction - AC2); both filter the result by `supply_method`.
2. **Revision pinning.** Both resolutions enforce `explosion.revision_id === order.released_revision_id` and reject 409 `BOM_REVISION_DRIFT` on mismatch. A Released order executes against the revision it was gated against; if an ECO moved the BOM (Story 5.3), execution blocks until a conscious re-release or cancel.
3. **Staging rows are THIS story's pick tasks.** AC1's "pick tasks" are `production_order_stage` rows, one per directed-issue requirement line, bound to an operator-named source bin under the plant. They are NOT Epic 3 `pick_task` rows: that projection is dispatch-demand-scoped (ERP sales-order lines, `allocated -> picked` flow toward shipping, `erp_sales_order` joins). Production staging holds stock in `allocated` until ISSUE drains it - the `picked` bucket is never used here.
4. **Staging allocates; the 6.1 release gate did not (6.1 BD-5).** Each staging line calls `applyStockAllocation({ sku, location_id, lot_id?, quantity })` at the named source bin. A 409 `INSUFFICIENT_STOCK` from the helper propagates UNCHANGED - never catch and re-wrap it; the Epic 2 detail payload is the useful one (the 7.4 rule).
5. **Issue ordering is DEALLOCATE FIRST, THEN ISSUE (7.4 binding).** `applyStockIssue` gates on `SUM(available)`, and `available` is net of the staging allocation, so issuing before deallocating fails with a spurious `INSUFFICIENT_STOCK` whenever the staged quantity is the only free stock. `src/compliance/transfer-request.ts` calls issue before deallocate - that ordering is a known divergence and must NOT be copied.
6. **Backflush drains plant-wide via ONE new helper.** `applyStockIssueUnderSite` locks every matching owned-class row beneath the plant site, checks the total in SQL NUMERIC and drains deterministically. The confirmation applier runs an ALL-LINES pre-check pass first (one `getAvailableBalanceUnderSite` probe per backflush line) and reports EVERY shortfall line in the rejection details (AC3 "shortfall lines" is plural); the drain pass runs only when every line is covered. All-or-nothing holds by construction because the applier runs inside the persistEvent transaction.
7. **WIP postings are per drained balance row, not per requirement line.** One backflush line can drain several bins/lots; AC5 requires returns to restore the ORIGINAL lot identity, which is only exact when each posting carries one (location, lot) grain. The issue helpers return their drained-row detail (Task 3) and the seam writes one `production_wip_ledger` posting per drained row.
8. **WIP value posts at issued cost from Story 2.4 valuation.** `unit_cost` is server-derived inside the applier from `getInventoryValuation(sku).running_average_cost` (an unlocked read inside the transaction - the valuation row is never locked by this story; it is a hot row and this story only reads it). `running_average_cost` is maintained for ALL valuation methods on every priced receipt (the 2.4 `applyValuationReceipt` precedent), so it is the correct issued cost for fifo, weighted_average and specific_identification items alike. Missing valuation row or NULL `running_average_cost` rejects 409 `WIP_COST_UNRESOLVED` - fail closed, never post value-less WIP. `posting_value = quantity * unit_cost` is computed in SQL NUMERIC, never in JS. Returns reverse at the SOURCE posting's unit_cost (the issued cost - AC5), never at today's average.
9. **Valuation is deliberately NOT coupled.** The Story 2.4 valuation seam is gated to `stream_type: 'inventory'` + `stock.received`/`stock.issued` (verified in `src/compliance/inventory-valuation.ts` lines 53-60). Production-stream movements call the stock helpers directly, exactly like Story 3.9 replenishment and Story 7.4 spare issue; do NOT call `applyValuationIssue` from this seam. Cross-stream valuation coherence is a platform gap logged to deferred-work (Task 9.6), not fixed here.
10. **The counter is recomputed, never incremented.** After every material applier, `unreversed_transaction_count` is set from the ledger under the already-held order lock: the count of non-return postings whose open quantity is still positive (the Counter Contract below). This satisfies the 6.1 BD-7 contract ("Story 6.2 owns incrementing it on issue and decrementing it on return") with zero drift surface, and 6.1's cancel guard (`UNREVERSED_TRANSACTIONS`) works unchanged.
11. **Status gate.** All four material events require order status `released` or `in_process`; any other status rejects 400 `INVALID_STATE_TRANSITION`. Staging typically starts from `released` (AC1); issue, confirmation and return run in either active state. `completed`, `closed` and `cancelled` are terminal to material flow (closure discipline belongs to Stories 6.3/6.4).
12. **Returns reference postings, not lines.** A return names `source_posting_id` (one issued/backflush posting); the over-return probe and the issued-cost reversal both read that posting. This makes AC5 and AC6 exact by construction.
13. **No edge, no PowerSync, no notification, no ERP.** Story 6.4 owns offline execution (FR-MO-13); there is no edge capture module for the production stream (verified - only indent/cross-dock/test capture exist). AC3's operator reporting is the synchronous error response. No `emitNotification` call is part of this story (no decision-like emission exists here; AD-17 would require the transactional entry point if one were added later).
14. **Kit-assembly orders ride this machinery unchanged.** Epic 2's FR-I-09 scope note declares kit assembly executes as production orders against Released BOMs; staging/issue/backflush/WIP apply with zero special-casing.

### Event Contract

Four new events on the EXISTING `production` stream; `stream_id` is `production_order_id` for all four. All four are `requiresBusinessStream: false` (the order row holds the tag; the 6.1 BD-2 precedent). Table 1 lists the payload contracts; every field marked "derived" is DECLARED in the payload and CHECKED against the server derivation (409 `PRODUCTION_MATERIAL_DERIVATION_MISMATCH` on divergence), and every field marked "write-back" is stamped by the applier onto `envelope.payload` before the domain_events insert.

Table 1: Story 6.2 event payload contracts

| Event type | Payload fields (declaration rules) |
| --- | --- |
| `production_order.material_staged` | `production_order_id` (UUID), `revision_id` (derived: must equal `released_revision_id`), `business_date` (write-back: IST date of `staged_at`), `lines[]` each with `stage_id` (write-back: server-minted UUIDv4), `bom_line_id` (UUID), `component_item_id` (derived), `component_sku` (derived), `required_quantity` (derived from explosion, exact decimal string), `source_location_id` (operator-named, plant-descendant-validated), `lot_number` (string or null), `staged_by` (write-back: actor), `staged_at` (explicit-offset instant) |
| `production_order.material_issued` | `production_order_id`, `stage_id` (UUID), `quantity` (decimal string; bounded by remaining staged), `issued_by` (write-back), `issued_at`, `postings[]` (write-back: one per drained balance row, each with `posting_id`, `bom_line_id`, `component_item_id`, `component_sku`, `lot_number`, `source_location_id`, `quantity`, `unit_cost`, `posting_value`) |
| `production_order.confirmation_recorded` | `production_order_id`, `confirmed_quantity` (decimal string, strictly positive), `revision_id` (derived), `business_date` (write-back), `confirmed_by` (write-back), `confirmed_at`, `backflush_lines[]` (write-back: per backflush requirement line `bom_line_id`, `component_sku`, `required_quantity`, plus the drained `postings[]` shaped exactly as the issue event) |
| `production_order.material_returned` | `production_order_id`, `source_posting_id` (UUID), `quantity` (decimal string; bounded by the posting's open quantity), `reason_code` (non-empty; membership-checked against config), `returned_by` (write-back), `returned_at`, `posting_id` (write-back: server-minted UUIDv4) |

Envelope metadata follows the spine envelope contract: `metadata.actor` from auth, `metadata.correlation_id` set to the order id by the handlers for traceability, `metadata.device_id` null (central-plane events), `metadata.capture_method` MANUAL.

### Table Definitions

Table 2 summarizes the two new projections. Both canonical SQL files carry their own guarded `DO $$` grant blocks and idempotent `IF NOT EXISTS` statements (the `read/projections/production_order.sql` banner pattern), and both are mirrored verbatim into `deploy/compose/init-db.sql`.

Table 2: New projections

| Table | Grain and key columns | Notes |
| --- | --- | --- |
| `production_order_stage` | PK `stage_id UUID`; UNIQUE `(production_order_id, bom_line_id)` | `production_order_id UUID`, `bom_line_id UUID`, `component_item_id UUID`, `component_sku TEXT`, `supply_method TEXT` (CHECK `directed_issue` only), `required_quantity NUMERIC(18,6)`, `issued_quantity NUMERIC(18,6) DEFAULT 0`, `status TEXT` (CHECK `allocated`, `issued`), `source_location_id UUID`, `lot_number TEXT` (nullable), `source_event_id UUID NOT NULL`, `created_at`/`updated_at TIMESTAMPTZ`. CHECKs: `required_quantity > 0`, `issued_quantity >= 0`, `issued_quantity <= required_quantity`. Indexes: plant-free lookups by order; the UNIQUE grain is the replay/duplicate guard |
| `production_wip_ledger` | PK `posting_id UUID`; append-only | `production_order_id UUID`, `posting_type TEXT` (CHECK `directed_issue`, `backflush`, `return`), `bom_line_id UUID`, `component_item_id UUID`, `component_sku TEXT`, `lot_number TEXT` (nullable), `source_location_id UUID`, `quantity NUMERIC(18,6)` (CHECK > 0), `open_quantity NUMERIC(18,6)` (nullable; CHECK >= 0; NULL on return rows), `unit_cost NUMERIC(14,3)`, `posting_value NUMERIC(14,3)`, `reason_code TEXT` (nullable), `source_posting_id UUID` (nullable), `source_event_id UUID NOT NULL`, `occurred_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT now()`. Pairing CHECKs: return rows have `source_posting_id` + `reason_code` and NULL `open_quantity`; issue/backflush rows have neither. Indexes on `production_order_id` and `source_posting_id`. Grants: app_user INSERT, SELECT only (append-only - the 7.7 precedent); no UPDATE, no DELETE |

`open_quantity` starts equal to `quantity` on issue/backflush postings and is decremented by returns in the same transaction as the return posting insert. The WIP read (AC4) is computed: net open quantity = `SUM(open_quantity)` over non-return postings; net open value = `SUM(open_quantity * unit_cost)` in SQL NUMERIC. A Closed-order zero-WIP check (Story 6.4's closure gate) will read the same accessor.

### Applier Contracts

Every applier begins: stream-gate match, `alreadyPersisted` no-op guard, order row `SELECT ... FOR UPDATE` via `getProductionOrderByIdForUpdate` (404 `PRODUCTION_ORDER_NOT_FOUND` when absent), status gate (BD-11), then its own steps. Lock order is fixed per Table 6 and stock-ledger helper locks are ALWAYS last (the 7.4 rule).

- **applyMaterialStaged**: resolve the directed-issue requirement set at the order quantity (Task 5) inside the transaction; for each payload line, match the explosion line by `bom_line_id` (409 `STAGING_LINE_NOT_DIRECTED_ISSUE` when the BOM line is backflush or unknown to the set; 400 `INVALID_PARAMS` for duplicate lines within one event), re-derive `component_item_id`/`component_sku`/`required_quantity` and check declarations, validate `source_location_id` is a descendant of `plant_location_id` (depth-capped recursive walk, the `getForwardPickBalance` CTE shape; 409 `STAGING_LOCATION_OUTSIDE_PLANT` otherwise), insert the stage row (the UNIQUE grain makes a second staging of the same line a 23505 mapped to 409 `DUPLICATE_EVENT`), then `applyStockAllocation` per line (INSUFFICIENT_STOCK propagates). Write back `stage_id`, `business_date`, actor stamps.
- **applyMaterialIssued**: lock the stage row `FOR UPDATE`; status must be `allocated` (an `issued` stage rejects 409 `STAGE_ALREADY_ISSUED` - full issues only transition; partial issues stay `allocated`); remaining = `required_quantity - issued_quantity` settled in SQL NUMERIC; requested `quantity` above remaining rejects 409 `ISSUE_EXCEEDS_STAGED`. Resolve unit_cost (BD-8; `WIP_COST_UNRESOLVED` fail-closed). Then `applyStockDeallocation` followed by `applyStockIssue` (BD-5) at the staged grain `{ sku, location_id: source_location_id, lot_id: lot_number, quantity }` passing `occurred_at`; the returned drain detail becomes one WIP posting per row (`posting_value` in SQL NUMERIC); insert postings; increment stage `issued_quantity` (flip status to `issued` when fully issued); recompute the counter. Write back `postings[]` and actor stamp.
- **applyConfirmationRecorded**: resolve the backflush requirement set at `confirmed_quantity` (Task 5); empty set rejects 409 `NO_BACKFLUSH_LINES` (an order with no backflush lines has nothing to confirm through this event). Pre-check pass: one `getAvailableBalanceUnderSite(component_sku, plant_location_id)` probe per line, shortfall = `GREATEST(required - available, 0)` in SQL; ANY shortfall rejects 409 `INSUFFICIENT_STOCK` with `details.shortfall_lines[]` carrying `{ component_sku, required_quantity, available_quantity, shortfall_quantity }` for EVERY deficient line (AC3). Drain pass: `applyStockIssueUnderSite` per line (owned class default); drain detail becomes WIP postings exactly like the issue applier; recompute the counter. Write back `backflush_lines[]` (with postings), `business_date`, actor stamp.
- **applyMaterialReturned**: lock the source posting `FOR UPDATE` (404 `POSTING_NOT_FOUND` when absent); it must be an issue/backflush posting of THIS order (409 `RETURN_SOURCE_MISMATCH` otherwise); reason_code blank rejects 400 `REASON_CODE_REQUIRED` (AC5); reason_code outside `config.production.materialReturnReasonCodes` rejects 422 `RETURN_REASON_CODE_INVALID` with the allowed list; the over-return probe settles `quantity > open_quantity` in SQL NUMERIC and rejects 409 `RETURN_EXCEEDS_ISSUE` (AC6) - rejected, NEVER clamped (a silently truncated return over-states the ledger; the 7.4 rationale); unit_cost = the source posting's `unit_cost` (issued cost - AC5). Apply `applyStockReceipt({ sku, location_id: source_posting.source_location_id, lot_id: source_posting.lot_number, quantity })` - the original location AND lot grain is restored, which is what "original lot identity restored" means mechanically (AC5). Insert the return posting (open_quantity NULL, reason_code and source_posting_id set), decrement the source posting's `open_quantity`, recompute the counter. Write back `posting_id` and actor stamp.

### The Counter Contract

Under the held order lock, after the applier's ledger writes:

```sql
UPDATE production_order
   SET unreversed_transaction_count = (
         SELECT COUNT(*) FROM production_wip_ledger
          WHERE production_order_id = $1
            AND posting_type IN ('directed_issue','backflush')
            AND open_quantity > 0
       ),
       updated_at = now()
 WHERE production_order_id = $1;
```

The `chk_production_order_unreversed_non_negative` constraint backstops the arithmetic (it cannot fire here, but a future bug fails loudly instead of silently unlocking a cancel). Story 6.1's cancel guard reads the same column under the same lock, so AC-level behavior (issue blocks cancel; full returns unblock it) holds with no change to the 6.1 seam.

### Locking Contract

Table 6: Fixed lock order for every Story 6.2 applier

| Step | Lock | Notes |
| --- | --- | --- |
| 1 | `production_order` row | `FOR UPDATE` via `getProductionOrderByIdForUpdate`; always first |
| 2 | `production_order_stage` row(s) | staging inserts (no lock), issue locks the one stage row |
| 3 | `production_wip_ledger` posting | returns lock the source posting row |
| 4 | `stock_balance` rows | taken INSIDE the Epic 2 helpers (`applyStockAllocation`/`applyStockIssue`/`applyStockIssueUnderSite`/`applyStockReceipt`); always LAST |

`inventory_valuation` is read WITHOUT a lock (advisory cost basis; locking it would make every issue serialize on a hot row). Deadlock safety follows the 7.5 precedent: every applier acquires in this order, helpers own their own locks, and no applier locks stock before a ledger row.

### Routes and RBAC

Table 7: Story 6.2 REST surface (all under `/api/v1`, module `production`)

| Method and path | Scope | Purpose |
| --- | --- | --- |
| `POST /production-orders/:orderId/material-staging` | write | Stage directed-issue lines (AC1) |
| `GET /production-orders/:orderId/material-staging` | read | The staging worklist: rows already staged PLUS the remaining directed-issue requirement lines resolved by a read-only explosion (the release-gate dry-run precedent), so the operator sees the pick list before posting staging events |
| `POST /production-orders/:orderId/material-issues` | write | Issue staged material to the order (AC4 feed) |
| `POST /production-orders/:orderId/confirmations` | write | Post a production confirmation; backflush drains (AC2/AC3) |
| `POST /production-orders/:orderId/material-returns` | write | Return issued material to stock (AC5/AC6) |
| `GET /production-orders/:orderId/wip` | read | Real-time WIP ledger: net open quantity, net open value, postings page (AC4) |

All six enforce plant-location scoping via `assertPlantLocationAccess` (export it from `src/api/v1/production-orders.ts`; it currently is module-private there). Write routes accept `idempotency_key` (blank normalizes to "not supplied"); replays return the original event (the `replayIdOrReject` pattern WITH the stream_id check). All six are appended to the `allowedSpineRoutes` list in story-1-9.

### Error Codes

Table 8: Error code inventory for Story 6.2

| Code | Status | Raised when |
| --- | --- | --- |
| `INSUFFICIENT_STOCK` | 409 | staging allocation shortfall (helper detail propagated unchanged); backflush pre-check shortfall (details carry every `shortfall_lines[]` entry) - AC3 |
| `REASON_CODE_REQUIRED` | 400 | return with blank/missing reason_code - AC5 |
| `RETURN_EXCEEDS_ISSUE` | 409 | cumulative return would exceed the source posting's open quantity - AC6 |
| `INVALID_STATE_TRANSITION` | 400 | material event against an order not in `released`/`in_process` |
| `PRODUCTION_ORDER_NOT_FOUND` | 404 | order id does not resolve |
| `BOM_REVISION_DRIFT` | 409 | explosion revision no longer equals `released_revision_id` |
| `MATERIAL_REQUIREMENT_SET_TRUNCATED` | 409 | explosion hit the depth cap |
| `COMPONENT_SKU_UNRESOLVED` | 409 | requirement line with no resolvable SKU (6.1 code, reused) |
| `STAGING_LINE_NOT_DIRECTED_ISSUE` | 409 | staging payload names a backflush or unknown BOM line |
| `STAGING_LOCATION_OUTSIDE_PLANT` | 409 | source bin is not a descendant of the order's plant |
| `STAGE_ALREADY_ISSUED` | 409 | issue against a fully-issued stage row |
| `STAGE_NOT_FOUND` | 404 | `stage_id` does not resolve on the issue route or seam |
| `ISSUE_EXCEEDS_STAGED` | 409 | requested issue quantity exceeds remaining staged |
| `NO_BACKFLUSH_LINES` | 409 | confirmation against an order with no backflush requirements |
| `WIP_COST_UNRESOLVED` | 409 | no valuation row or NULL `running_average_cost` at issue time |
| `RETURN_SOURCE_MISMATCH` | 409 | return references a posting that is not an issue/backflush posting of this order |
| `POSTING_NOT_FOUND` | 404 | source_posting_id does not resolve |
| `RETURN_REASON_CODE_INVALID` | 422 | reason code outside `config.production.materialReturnReasonCodes` (details carry `allowed`) |
| `PRODUCTION_MATERIAL_DERIVATION_MISMATCH` | 409 | any declared field disagrees with the server derivation |
| `DUPLICATE_EVENT` | 409 | replay conflicts (23505 pkey/grain chain) |
| `INVALID_PARAMS` | 400 | shape violations caught by the pre-transaction assert |

No edge sync surface exists for the production stream, so no `upload.ts`/`connector.ts`/`en.json` changes are needed (the 6.1 precedent). `INSUFFICIENT_STOCK` already exists in the edge permanent sets for other modules and stays untouched.

### Files

NEW files:

- `read/projections/production_order_stage.sql`
- `read/projections/production_wip_ledger.sql`
- `src/read/projections/production_order_stage.ts`
- `src/read/projections/production_wip_ledger.ts`
- `src/production/material-staging.ts`
- `src/compliance/production-material.ts`
- `src/api/v1/production-material.ts`
- `test/integration/story-6-2.test.ts`

MODIFIED files (current state, what changes, what must be preserved):

- `src/events/schema.ts` - the 3648-line schema module; the Story 6.1 production block sits at lines 2748-2870 and `SUPPORTED_EVENT_TYPES` ends at line 3647 with `production_order.cancelled`. ADD the four payload/envelope pairs after the 6.1 block and the four registry entries at the tail. PRESERVE every existing interface and entry; do not reorder.
- `src/events/store.ts` - the persistEvent seam. Pre-transaction assert switch ends with `assertProductionOrderShape(envelope)` at line 644; in-transaction projection switch calls `applyProductionOrderProjection(envelope, client, eventId)` at line 953; the 23505 mapper's pkey chain includes `production_order_pkey` at line 1450. ADD the two seam calls after those lines and the three new constraint mappings. PRESERVE the idempotency short-circuit (lines 679-692) ordering: asserts run before it, projections after BEGIN.
- `src/read/projections/stock_balance.ts` - Story 2.2/2.8/3.6/3.9/6.1/7.4 stock helpers. CHANGE `applyStockIssue`'s return type from `Promise<void>` to `Promise<StockDrainRow[]>` (RETURNING the drained delta; all five existing callers ignore the return value and keep compiling). ADD `applyStockIssueUnderSite` (+ optional `getBalancesBySkuUnderSite`). PRESERVE every existing helper's SQL verbatim - the allocation/issue drain windows, the class scoping, the `last_issue_at` stamping, the `$3::text IS NULL OR lot_id = $3` lot-wildcard contract.
- `src/api/v1/production-orders.ts` - the 6.1 route module. EXPORT `assertPlantLocationAccess` (currently module-private at lines 67-82) so the new module imports it; no behavior change.
- `src/server.ts` - route registrations; the production block is lines 761-772 with imports at 294-301. ADD six routes after the existing production routes and the corresponding imports.
- `src/events/migrate.ts` - `MIGRATIONS` array; `production_order.sql` is entry 140. APPEND the two new files at the tail; never reorder.
- `deploy/compose/init-db.sql` - first-boot mirror; append both new table definitions verbatim (CRLF).
- `src/config/index.ts` - config ends with the `bom` block at line 349. ADD the `production` block after it.
- `test/unit/schema-drift.test.ts` - `EXPECTED` array; the production_order entry is lines 1138-1157. ADD two entries in the established shape.
- `test/integration/story-1-9.test.ts` - `allowedSpineRoutes`; the Story 6.1 block is lines 470-477. APPEND the six new routes under a Story 6.2 comment.
- `_bmad-output/implementation-artifacts/deferred-work.md` - append the out-of-scope entries (Task 9.6).

### Testing Requirements

Mandatory assertions (the 7.6 Group C lesson: an AC is not tested until its error code AND its load-bearing details are asserted):

1. AC1: staging a Released order creates one stage row per directed-issue line (backflush lines absent from the result), `stock_balance.allocated` increases by exactly the staged quantities at the named bins (assert absolute values), status `allocated`; issue moves the exact quantity into WIP and drains on_hand; a second staging of the same line 409s (`DUPLICATE_EVENT` via the grain).
2. AC2: a confirmation of quantity Q backflushes every backflush line at `required_quantity * (Q / order_quantity)` settled in SQL NUMERIC (assert exact decimal strings with `assertNumericEqual`, including fractional quantities like 0.1 + 0.2 boundaries); directed-issue lines untouched.
3. AC3: shortfall on ANY backflush line rejects 409 `INSUFFICIENT_STOCK` with EVERY deficient line present in `details.shortfall_lines`; no stock row changed (assert balances identical before/after); a partially-covered multi-line set reports all shortfalls, not just the first.
4. AC4: after issues/backflushes, `GET .../wip` returns net open quantity and value matching hand-computed SQL (quantity times `running_average_cost` at issue time); after a full return, both read zero; postings list is append-complete in insertion order.
5. AC5: a return restores stock at the ORIGINAL location and lot (assert the exact `stock_balance` grain row regains on_hand), reverses WIP at the SOURCE posting's unit_cost (not today's average), and rejects 400 `REASON_CODE_REQUIRED` when reason_code is blank; a code outside the configured list rejects 422 with the `allowed` detail.
6. AC6: returning `open_quantity + epsilon` rejects 409 `RETURN_EXCEEDS_ISSUE` with the ledger unchanged (posting open_quantity identical before/after); returning exactly `open_quantity` succeeds and closes the posting.
7. Replay: every write route resubmitted with the same idempotency key returns the original event, no second projection effect (balances and ledger row counts unchanged).
8. AD-12 forged direct events: `POST /api/v1/events` with forged payloads for all four event types (wrong revision, inflated quantities, fabricated postings, fabricated unit_cost) is rejected by the seam with the derivation/limit codes - never by handler-only checks.
9. Cancel-guard integration: issue, then cancel attempt 409 `UNREVERSED_TRANSACTIONS`; full return, then cancel succeeds. The counter column value is asserted at each step.
10. Concurrency: two parallel stagings of the same line (exactly one wins); two parallel confirmations racing the last unit of a component (one succeeds, one stable 409 with shortfall detail).
11. RBAC/scoping: a role without production write gets 403; a plant-scoped role touching another plant's order gets 403 `LOCATION_ACCESS_DENIED`.
12. Ledger invariants after every stock-touching op: `available = on_hand - allocated - picked` on every touched row plus absolute on_hand/allocated values; WIP `SUM(open_quantity)` never negative.

Regression gates (all mandatory): story-6-1 suite green; stories 5-1 through 5-6 green (the explosion contract is consumed, not modified); spine gate 6/6; schema-drift at full count (+2 entries); `npm run build`, `npm run lint`, `npm run format:check` clean; `npm run db:migrate` idempotent twice; edge suite re-run unchanged (no edge file touched); full `npm test` at zero NEW failures against the recorded baseline.

### Previous Story Intelligence

Carry these forward; every one prevented a defect in its own story:

- **6.1**: the seam/handler split (decisions live in the seam, handlers pre-check for clean errors); `replayIdOrReject` must check `stream_id` (cross-order idempotency-key reuse otherwise returns a phantom success); UUID case-normalize identity comparisons; timestamps bounded to offset 15:59; free-text capped at 512; blank reason/identifier strings rejected; declared-and-re-derived fields everywhere; do NOT hardcode order numbers in tests (sequence-driven); assert audit `details` where a resolution is recorded.
- **5.5**: `explodeBomForExecution` is pure, transaction-joinable (pass the PoolClient), quantities are exact decimal strings end-to-end; `explosion_line_id` is capture-time-minted per RUN (not stable across runs - which is why the stage grain keys on `bom_line_id`, not `explosion_line_id`); alternates arrive ordered by priority; phantom lines pass through with multiplied quantities; only `output_class = 'component'` lines generate requirements.
- **7.4**: deallocate-before-issue ordering (BD-5 above); ledger helpers take their own FOR UPDATE and must be LAST; INSUFFICIENT_STOCK propagates unwrapped; over-return probes settle in SQL NUMERIC (0.1 + 0.2 must not exceed 0.3); append-only ledgers get INSERT,SELECT grants only; reservation/ledgers record FACTS while `stock_balance` stays the authoritative balance.
- **7.7**: reason-code config pattern (absent env takes defaults; present-but-blank fails closed; 200-char per-code ceiling; 422 with `allowed` detail); append-only override/ledger tables paired with CHECK pairing constraints.
- **2.2/2.8**: `stock_balance.lot_id` is the lot_master.lot_number TEXT business key, NOT the lot_master.lot_id UUID - the WIP ledger's `lot_number` column carries the same TEXT value; passing a UUID there silently corrupts the grain. Stock classes are per-command: production draws `owned` only (consignment/VMI invisible by class scoping - AD-7's Phase-1 enforcement).
- **2.4**: `running_average_cost` is the weighted-average unit cost string (nullable); receipts post priced; an unpriced seed leaves it NULL and trips `WIP_COST_UNRESOLVED` (test seeds must price receipts).
- **Known platform gaps to carry, not fix**: `persistEvent` has no stream_type/event_type registry cross-check (deferred-work line 363); `APPROVAL_UNRESOLVED` dual 404/409 status (line 367); ECO-added BOM lines default to `directed_issue` because `eco_change_line` lacks `supply_method` (line 223) - an ECO-added backflush line will stage as directed until that platform fix lands.

### Architecture Compliance

- **AD-4**: requirement structure comes from the BOM module via the explosion service; ERP is never read for structure.
- **AD-5**: the production WIP ledger is a separate ledger on the `production` stream; nothing in this story posts to any R&D surface (Story 10.3, Phase 2). A single transaction cannot post to both by construction.
- **AD-7/AD-6**: drains are `stock_class = 'owned'` scoped; customer-owned (future `job_work` class) and consignment/VMI stock are invisible to staging/backflush. The Epic 9 CROSS_ISSUE_BLOCKED hook attaches to the same class-scoping seam later.
- **AD-10**: scrap intake is NOT in this story (Story 6.3 owns FR-MO-08); when it lands it must carry the source-document linkage.
- **AD-12**: every rule enforced in the seam; direct `POST /api/v1/events` cannot bypass any guard (proved by test item 8).
- **AD-14**: status and WIP state are projections written only inside the event transaction; reads go through the shared projections.
- **AD-15**: material movements ride locations that already exist in `location_register`; staging validates plant-descendant topology (no asserted/expected divergence surface is introduced here - staging names real bins).
- **AD-16**: all four write routes deduplicate on `idempotency_key`; duplicates return the existing event.
- **AD-17**: no notifications emitted; if any future material-flow notification is added it is part of the business fact and must use `emitNotificationInTransaction`.
- **FR-AC-01**: business-stream tagging stays on the order row (created with the tag in 6.1); material events do not re-tag (AD-14).

### Out of Scope

Log each to `deferred-work.md` (Task 9.6):

- Lot-controlled consumption enforcement and FEFO-directed staging (Story 6.4, FR-MO-11): staging/issue in 6.2 accept lot-less drains exactly as the Epic 2 helpers do.
- Completion quantity tolerances and over/short completion (Story 6.3, FR-MO-09): confirmations in 6.2 are not capped against the order quantity.
- Completions, co/by-product posting, QC Hold hand-off (Story 6.3, FR-MO-07).
- Process scrap declarations (Story 6.3, FR-MO-08) and consumption variance reporting (Story 6.4, FR-B-08).
- Closure gate, lot genealogy, offline execution and replay (Story 6.4, FR-MO-11/12/13): no edge capture, no PowerSync bucket here.
- Cross-stream valuation coherence: production-stream issues do not update `inventory_valuation` (the 3.9/7.4 precedent); logged as a platform decision.
- Quarantine/quality-hold screening of staging source bins: stock-class scoping is the Phase-1 guard; lot QC-hold enforcement arrives with 6.4's consumption gate.
- Rework orders from QC dispositions (Story 6.3, blocked on Epic 8).

### Technology Versions

No new dependencies are introduced and no web research applies: the stack is pinned and CI-guarded by Story 1.10 (Node 24.18.0 runtime verified at story creation, PostgreSQL 18.4, `pg ^8.16.0`, TypeScript `^5.8.0`, `tsx ^4.19.0`, `prettier ^3.5.0`, `eslint ^9`). All arithmetic uses PostgreSQL NUMERIC through the existing `pg` driver; no decimal library may be added (the platform rule is NUMERIC strings end-to-end, never JS floats).

### Project Structure Notes

- `src/production/` is the established module directory (6.1 created it with `release-gate.ts`); `material-staging.ts` joins it as the second pure read-and-compute service.
- The compliance seam lives at `src/compliance/production-material.ts` beside `production-order.ts` (one seam file per story surface is the established pattern: `maintenance-spares.ts`, `maintenance-coverage.ts`, `calibration-register.ts`).
- Canonical projection SQL lives at repo root `read/projections/*.sql` with TS accessors in `src/read/projections/*.ts`; the init-db mirror and migrate registration are mandatory companions.
- Integration tests are one file per story: `test/integration/story-6-2.test.ts`; the test DB runs on port 5442 (`.env.test`) and tests run with `--test-concurrency=1`.
- No conflicts with the unified structure were detected; every path above follows an existing precedent in this codebase.

### References

- Story 6.2 requirements and ACs: [Source: _bmad-output/planning-artifacts/epics.md#Story 6.2: Material Staging, Issue, and WIP Ledger]
- Epic 6 goal, dependencies, Epic 8 prerequisite: [Source: _bmad-output/planning-artifacts/epics.md#Epic 6: Production Orders and Manufacturing WIP]
- FR-MO-04/05/06 requirement text: [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md#4.7 Production Orders and Production WIP]
- Sprint-change-proposal E6-07 (the AC corrections this story implements): [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md#E6-07]
- AD-4/5/6/7/10/12/14/15/16/17 invariants: [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md]
- Story 6.1 binding decisions, locking contract, review lessons: [Source: _bmad-output/implementation-artifacts/6-1-production-order-creation-and-release-gate.md]
- Explosion service contract (FR-B-07 surface): [Source: _bmad-output/implementation-artifacts/5-5-approved-alternates-and-bom-explosion.md] and `src/engineering/bom-explosion.ts:253`
- Stock ledger helpers and class scoping: `src/read/projections/stock_balance.ts:272-416` (allocation/issue/deallocation), `src/read/projections/stock_balance.ts:205` (`getAvailableBalanceUnderSite`)
- Deallocate-before-issue precedent: `src/compliance/maintenance-spares.ts:642-652`
- Over-return SQL-NUMERIC probe precedent: `src/compliance/maintenance-spares.ts:681-689`
- Valuation gate (inventory stream only): `src/compliance/inventory-valuation.ts:53-60`; `running_average_cost` accessor: `src/read/projections/inventory_valuation.ts:76`
- Release gate (availability semantics, no-lock decision): `src/production/release-gate.ts:18-21`
- IST business-date derivation for write-back fields: `src/lib/business-days.ts:22` (`toIstCalendarDate`)
- Production seam structure and re-derivation contract: `src/compliance/production-order.ts:15-45`, `src/compliance/production-order.ts:782-808`
- `unreversed_transaction_count` schema and cancel guard: `read/projections/production_order.sql:46-55`, `src/compliance/production-order.ts:798-808`
- Reason-code config precedent: `src/config/index.ts:321-347`
- Deferred platform gaps carried: [Source: _bmad-output/implementation-artifacts/deferred-work.md lines 223, 343-349, 363, 367]

## Dev Agent Record

### Agent Model Used

kilo-auto/efficient (Kilo CLI) on 2026-08-28.

### Debug Log References

- Baseline full suite at commit `aa76e44` BEFORE code changes: 1230 tests, 1213 pass, 17 fail - the 15 documented Epic 1-3 idempotency failures, 1 gate_dwell CRLF schema-drift failure, and 1 story-5-3 where-used date-flake (same class recorded in deferred-work); zero NEW failures introduced by this story.
- Integration debugging surfaced three implementation defects before the suite went green: (1) `required_quantity` from the explosion textifies with full NUMERIC scale (32+ decimals) and was rejected by the 6-decimal shape regex - added `isDerivedPositiveDecimal`; (2) unused extra SQL parameters in the `applyStockIssueUnderSite` CTE statements fail PostgreSQL type inference ("could not determine data type of parameter") - aligned placeholders; (3) `posting_value` was written as the raw quantity instead of `quantity * unit_cost` - now computed in SQL NUMERIC inside `insertWipPosting`.
- Recorded deviation (Table 2 grant line vs Applier Contract): `production_wip_ledger` grants app_user INSERT, SELECT, UPDATE - the return applier must decrement `open_quantity` on the source posting (AC6, the Counter Contract) and lock it FOR UPDATE, both of which PostgreSQL refuses without UPDATE privilege. Posting rows stay append-only (never deleted/rewritten). Logged in deferred-work.md and in the canonical SQL banner.

### Completion Notes List

- All 9 tasks (64 subtasks) complete. Story status set to "review".
- Two new projections (`production_order_stage`, `production_wip_ledger`), four new `production`-stream events, the requirement-set service, the compliance seam, six REST routes, config block, and a 22-test integration suite all implemented and green.
- Gates at completion: tsc/eslint clean; prettier clean for every file this story touched (4 pre-existing unformatted files from the 7.7 refactor are untouched and noted); `npm run db:migrate` idempotent x2; schema-drift 111 tests (110 pass, +2 entries, only the pre-existing gate_dwell CRLF fails); spine gate 6/6; story-6-1 41/41; stories 5-1..5-6 128 tests (127 pass, only the pre-existing story-5-3 where-used date-flake); story-6-2 22/22; full `npm test` at zero NEW failures against the recorded baseline.
- No new dependencies. No edge/PowerSync/notification surface (Story 6.4 owns offline execution). No `upload.ts`/`connector.ts`/`en.json` changes.

### File List

NEW:

- `read/projections/production_order_stage.sql`
- `read/projections/production_wip_ledger.sql`
- `src/read/projections/production_order_stage.ts`
- `src/read/projections/production_wip_ledger.ts`
- `src/production/material-staging.ts`
- `src/compliance/production-material.ts`
- `src/api/v1/production-material.ts`
- `test/integration/story-6-2.test.ts`

MODIFIED:

- `src/events/schema.ts` - four payload/envelope pairs in a Story 6.2 block after the 6.1 block; four registry entries at the tail of SUPPORTED_EVENT_TYPES
- `src/events/store.ts` - pre-transaction `assertProductionMaterialShape`, in-transaction `applyProductionMaterialProjection`, `uq_production_order_stage_line` 23505 branch, `production_order_stage_pkey` + `production_wip_ledger_pkey` in the pkey chain, resolver import
- `src/read/projections/stock_balance.ts` - `applyStockIssue` now returns `StockDrainRow[]` (additive); new `applyStockIssueUnderSite`; `StockDrainRow` interface
- `src/api/v1/production-orders.ts` - exported `assertPlantLocationAccess`
- `src/server.ts` - six new production-material routes + imports
- `src/events/migrate.ts` - both new SQL files at the tail of MIGRATIONS
- `deploy/compose/init-db.sql` - both mirrors appended (CRLF)
- `src/config/index.ts` - `production.materialReturnReasonCodes` block
- `test/unit/schema-drift.test.ts` - two EXPECTED entries
- `test/integration/story-1-9.test.ts` - six routes appended to allowedSpineRoutes
- `_bmad-output/implementation-artifacts/deferred-work.md` - Story 6.2 out-of-scope entries
- `_bmad-output/implementation-artifacts/sprint-status.yaml` - story status updated
- `_bmad-output/implementation-artifacts/6-2-material-staging-issue-and-wip-ledger.md` - this story file (frontmatter baseline_commit, task checkboxes, Dev Agent Record, File List, Status)
