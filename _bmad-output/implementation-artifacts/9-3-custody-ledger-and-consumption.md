---
baseline_commit: 086ce92444b8905e9d839080ab332dc4785ff3b6
---

# Story 9.3: Custody Ledger and Consumption

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a job-work coordinator,
I want a per-customer, per-order custody ledger covering all movement categories that prints as a custody statement, with consumption posted against kit lines and own-material additions billed distinctly,
so that customer ownership is fully accounted for at all times.

## Acceptance Criteria

1. **Custody ledger across all movement categories (FR-JW-05).** Given customer material received against an order, when movements occur, then a per-customer, per-order custody ledger (`custody_ledger_entry`, keyed by `service_order_id` plus the order's `customer_party_code`) records receipts, consumption, returns, loss, and offcuts as signed quantity deltas per sku. In this story the posting paths that exist are `receipt` (fed from the Story 9.2 receipt applier in the same transaction) and `consumption` (new); `return`, `loss`, `offcut`, `dispatch`, and `count_adjustment` are declared in the category vocabulary and CHECK constraint so Stories 9.4, 9.5, and 9.6 post into the same ledger without a migration, but no route or event produces them here.
2. **Custody statement on demand (FR-JW-05).** Given a custody ledger with activity, when `GET /api/v1/service-orders/:serviceOrderId/custody-statement` is called, then the statement returns the order and customer header, every ledger entry in `occurred_at` then `created_at` order with the running customer-owned balance per sku after each entry, the Story 9.2 receipt variance (`variance_qty`, `variance_flagged`, `received_by`) on each receipt line, a distinct own-material section (AC 6), and closing balances per sku and in total. `?format=text` returns the same statement as a fixed-width plain-text printable rendering. Site-scoped read, 404-versus-403 collapsed as in the 9.1 GET-by-id.
3. **Consumption decrements custody (FR-JW-06).** Given an order in `in_process`, when consumption is posted against the order's kit lines (`POST /api/v1/service-orders/:serviceOrderId/consumptions`, event `custody.consumption_posted`), then in one transaction the matching `job_work` stock is drained from `stock_balance` (lot and location named on the posting), a `consumption` ledger row with negative delta is written, a `lot_trace` entry is appended, and the running custody balance for that sku falls by the consumed quantity.
4. **Over-balance consumption refused (FR-JW-05, FR-JW-06).** Given a consumption posting whose quantity exceeds the remaining customer-owned custody balance for that sku on that order (derived in-transaction under the order lock from the ledger, never from the route), when the posting is attempted, then it refuses 409 `INSUFFICIENT_STOCK` with details `{service_order_id, sku, requested_qty, custody_balance_qty}` and no ledger, stock, or trace row is written. A physical shortfall in `stock_balance` (custody balance sufficient but the named lot or location holds less) refuses with the same code from the stock surface, also fully rolled back.
5. **Off-kit consumption refused (FR-JW-06, FR-AC-13).** Given a consumption posting for a sku that is not on the order's kit BOM current revision as a non-placeholder customer-supplied line, when the posting is attempted, then it refuses 409 `KIT_LINE_MISMATCH` (new stable code) with details `{service_order_id, kit_bom_id, kit_bom_revision_id, sku}`. After the kit BOM is amended through the existing attributed paths (`bom_line.amended` or an implemented ECO), the same posting succeeds and the ledger row records the `bom_line_id` and `kit_bom_revision_id` it matched.
6. **Own material tracked distinctly and billable (FR-JW-07).** Given the job requires the processor's own material, when own material is added (`POST /api/v1/service-orders/:serviceOrderId/own-material`, event `custody.own_material_added`), then `owned`-class stock is drained through the normal owned issue path, an `own_material` ledger row is written with `ownership = 'processor'` and `billable = true`, the row is excluded from the customer-owned running balance, and the statement lists it under a separate own-material section so the Story 9.6 billing feed can pick it up.
7. **Every write path is gated and attributed.** Consumption and own-material postings refuse unless the order is `in_process` (409 `SOURCE_DOCUMENT_REQUIRED`), the posting site matches the order site, and, for consumption, the named lot was received under this order (409 `CROSS_ISSUE_BLOCKED`). All of this is re-derived in-transaction under the order advisory lock. Direct `POST /api/v1/events` submissions cannot bypass any gate. Every refusal named above is in the route file's `AUDITED_REJECTIONS` and every posting is attributed to `posted_by` in the ledger and in the Story 1.3 edit log.

## Tasks / Subtasks

- [x] Task 1: Event contract and `custody` stream (AC: 1, 3, 6)
  - [x] 1.1 Register a NEW stream type `custody` (AD-6: the custody ledger is a separate stream type) with `stream_id = service_order_id`. Add it wherever `jobwork` is recognised as a stream type (`src/compliance/service-order.ts:32` `JOBWORK_STREAM_TYPES`; grep `streamType: 'jobwork'` in `src/events/schema.ts:5390-5410` and mirror the block).
  - [x] 1.2 Register `custody.consumption_posted` and `custody.own_material_added` in `SUPPORTED_EVENT_TYPES` (`src/events/schema.ts` tail-append after `jobwork.material_received` at :5408), `{ streamType: 'custody', requiresBusinessStream: false }`, central-only. Typed payloads next to `JobworkMaterialReceivedPayload` (:4478). Consumption payload: `{ service_order_id, consumption_id, sku, lot_id, location_id, quantity, uom, site_id, posted_by, reason_note? }`. Own-material payload: `{ service_order_id, own_material_id, sku, lot_id?, location_id, quantity, uom, site_id, posted_by, bom_line_id? }`. Ids minted client-side (UUIDv4, BSD-10 idiom). Quantities are strictly positive NUMERIC strings (`isPositiveQtyString`, `src/compliance/jobwork-receipt.ts:97`).
  - [x] 1.3 Closed-shape asserts `assertCustodyConsumptionShape` and `assertCustodyOwnMaterialShape` pre-DB (reject unknown keys, refuse non-`custody` stream, mirror `assertJobworkMaterialReceivedShape` :171). Server-derived fields (`bom_line_id` on consumption, `kit_bom_revision_id`, `custody_balance_after`) are refused on input and written back onto the stored payload (9.2 idiom).
  - [x] 1.4 Wire asserts at `src/events/store.ts:728-732` and appliers at `:1087-1094` following the 9.2 shape.
- [x] Task 2: Projection `custody_ledger_entry` (AC: 1, 2)
  - [x] 2.1 Canonical DDL `read/projections/custody_ledger_entry.sql` (LF), byte-identical mirror in `deploy/compose/init-db.sql` (that file's CRLF endings), tail-append in `src/events/migrate.ts` after `jobwork_material_receipt.sql`, idempotent (IF NOT EXISTS plus guarded DO blocks), app_user grants INSERT and SELECT in-file. Columns: `entry_id UUID PK, service_order_id UUID NOT NULL, customer_party_code TEXT NOT NULL, movement_category TEXT NOT NULL CHECK IN ('receipt','consumption','return','loss','offcut','dispatch','count_adjustment','own_material'), ownership TEXT NOT NULL CHECK IN ('customer','processor'), sku TEXT NOT NULL, lot_id UUID, location_id UUID, quantity_delta NUMERIC(18,3) NOT NULL, uom TEXT NOT NULL, billable BOOLEAN NOT NULL DEFAULT false, bom_line_id UUID, kit_bom_revision_id UUID, receipt_id UUID, variance_qty NUMERIC(18,3), variance_flagged BOOLEAN, site_id UUID NOT NULL, posted_by TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, business_date DATE NOT NULL, source_event_id UUID NOT NULL, source_event_type TEXT NOT NULL, correlation_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Constraints: `uq_custody_ledger_source_event (source_event_id)` (one ledger row per event, replay-safe), `chk_custody_ledger_sign` (receipt and own_material strictly positive; consumption, return, loss, offcut, dispatch strictly negative; count_adjustment non-zero), `chk_custody_ledger_ownership` (`own_material` implies `ownership = 'processor'` and `billable = true`; every other category implies `ownership = 'customer'`). Indexes: `idx_custody_ledger_order_time (service_order_id, occurred_at, created_at)`, `idx_custody_ledger_order_sku (service_order_id, ownership, sku)`.
  - [x] 2.2 TS accessor `src/read/projections/custody_ledger_entry.ts`: `insertCustodyLedgerEntry`, `listCustodyLedgerByOrder` (statement order), `customerCustodyBalance(serviceOrderId, sku, client)` returning the SUM of `quantity_delta` where `ownership = 'customer'` as a NUMERIC string (compare with exact scaled-integer BigInt arithmetic as in 9.2, never `Number()`), and `customerCustodyBalancesByOrder`.
  - [x] 2.3 Schema-drift pin in `test/unit/schema-drift.test.ts` after the `jobwork_material_receipt` entry at :1708-1716 (canonical path, table, constraints, indexes, indexBodies).
- [x] Task 3: Feed receipts into the ledger (AC: 1, 2)
  - [x] 3.1 In `applyJobworkMaterialReceivedProjection` (`src/compliance/jobwork-receipt.ts:359`), after the `jobwork_material_receipt` insert and before the `transitionServiceOrder` call, insert a `receipt` ledger row (`ownership = 'customer'`, `quantity_delta = received_qty`, `receipt_id`, `variance_qty`, `variance_flagged`, `posted_by = received_by`, `source_event_id` = the `jobwork.material_received` event id, `business_date` = IST calendar date of `occurred_at`). Same transaction, no new event: the receipt stays on the `jobwork` stream, the ledger is a shared projection fed by two streams (disclosed deviation from a strict reading of AD-6, see Dev Notes decision 2).
  - [x] 3.2 Confirm the story-9-2 suite stays green (18/18) and add one assertion in the 9.3 suite that a 9.2 receipt produces exactly one `receipt` ledger row carrying the variance flag.
- [x] Task 4: Consumption seam `src/compliance/custody-ledger.ts` (AC: 3, 4, 5, 7)
  - [x] 4.1 Applier `applyCustodyConsumptionProjection(envelope, client, eventId)`. Lock order, in this sequence and documented in a header comment (7.4 rule, `src/compliance/production-material.ts:51-53`): order advisory lock via the SAME key as `service-order.ts:329` and `jobwork-receipt.ts:249` (`pg_advisory_xact_lock(hashtextextended(service_order_id, 0))`, so consumption serialises with receipts and transitions), then `getServiceOrderById(id, client, true)` FOR UPDATE, then stock rows last inside `applyStockIssue`.
  - [x] 4.2 Gates under lock, fail-closed, in this order: order exists and `status = 'in_process'` else 409 `SOURCE_DOCUMENT_REQUIRED`; `site_id` equals order site else 409 `SOURCE_DOCUMENT_REQUIRED`; the named `lot_id` appears in `jobwork_material_receipt` for this `service_order_id` with the same sku else 409 `CROSS_ISSUE_BLOCKED` (details `{service_order_id, sku, lot_id, demand_kind: 'custody_consumption'}`); kit-line match (Task 4.3) else 409 `KIT_LINE_MISMATCH`; customer custody balance for the sku (Task 2.2) at least `quantity` else 409 `INSUFFICIENT_STOCK` (details per AC 4).
  - [x] 4.3 Kit-line resolution: `getBomById(order.kit_bom_id)` then `getBomLines(bom.current_revision_id)` (`src/read/projections/bom.ts:108`, `:157`); match `component_sku = sku`, `is_placeholder = false`, and `supply_source` either `'customer'` or NULL (an untagged kit line is not yet reconciled by FR-B-16 tagging; treat as customer-supplied but record `supply_source_untagged: true` in the stored payload; a line tagged `'company'` or `'job_worker'` does NOT match customer consumption). Resolve the CURRENT revision at posting time; the order stores only `kit_bom_id` and no revision pin (decision 5). Persist `bom_line_id` and `kit_bom_revision_id` on the ledger row.
  - [x] 4.4 Stock drain through the gated door: build a synthetic `stock.issued` view `{ sku, location_id, lot_id, quantity, stock_class: 'job_work', occurred_at }` stamped with a NEW module-private `CUSTODY_CONSUMPTION = Symbol('custody.consumption_handoff')` (mirror `RECEIVING_HANDOFF`, `jobwork-receipt.ts:40-43`), and in `src/compliance/stock-balance.ts:343-356` let the total bar pass ONLY when the view carries that Symbol (a JSON body can never carry a Symbol). Keep the bar total for every other caller. Then `applyStockIssue` (`src/read/projections/stock_balance.ts:372`) with `stock_class: 'job_work'` and the explicit lot; its own `INSUFFICIENT_STOCK` propagates. Do NOT widen `NON_SALEABLE_STOCK_CLASSES` or add a classifier.
  - [x] 4.5 After the drain: insert the `consumption` ledger row (`quantity_delta = -quantity`), then `appendTraceEntry` (`src/read/projections/lot_trace.ts:66`) with `event_type = 'custody.consumption_posted'`, negative `quantity_change`, `business_stream = 'job_work'` (the 9.1 stream code), location from the drained row.
  - [x] 4.6 Write back server-derived fields onto the stored payload (`bom_line_id`, `kit_bom_revision_id`, `custody_balance_after`). `23505` on `uq_custody_ledger_source_event` resolves by constraint name to a 409 `DUPLICATE_EVENT` (9.1 review patch 7 idiom).
- [x] Task 5: Own-material seam (AC: 6, 7)
  - [x] 5.1 Applier `applyCustodyOwnMaterialProjection` in the same module, same lock order. Gates: order `in_process` and site match (409 `SOURCE_DOCUMENT_REQUIRED`). No kit-line gate (decision 6): if `bom_line_id` is supplied it must belong to the order's kit BOM current revision with `supply_source IN ('company','job_worker')` else 409 `KIT_LINE_MISMATCH`; absent is accepted (consumables, packing, processor additions off the customer kit).
  - [x] 5.2 Drain `owned` stock through the ORDINARY owned path (`applyStockIssue` with default class, QC gate exclusion as-is; no Symbol needed, owned issue is not barred). Insert an `own_material` ledger row: `ownership = 'processor'`, `billable = true`, `quantity_delta = +quantity`, then `appendTraceEntry` with `event_type = 'custody.own_material_added'` when a lot is named.
  - [x] 5.3 The customer running balance (Task 2.2) must ignore `ownership = 'processor'` rows; assert this in a unit test on the SQL predicate and in the integration statement test.
- [x] Task 6: Routes in `src/api/v1/service-orders.ts` (AC: 2, 3, 4, 5, 6, 7)
  - [x] 6.1 `POST /api/v1/service-orders/:serviceOrderId/consumptions` and `POST .../own-material` (module `jobwork`, write, `assertSiteWriteAccess` :122 against the ORDER's site, `rejectUnacceptedFields` symmetric, idempotency key accepted per AD-16 with `findEventByIdempotencyKey` stand-down, `replayIdOrReject` pattern from `src/api/v1/quality.ts:214`). Path `serviceOrderId` must equal the body's `service_order_id` (400 `INVALID_PARAMS`).
  - [x] 6.2 `GET .../custody-ledger` (raw entries, JSON) and `GET .../custody-statement` (AC 2). Statement builder `src/compliance/custody-statement.ts` (pure function over rows, unit-testable): header `{service_order_id, order_number_ext, customer_party_code, customer_name, site_id, generated_at, business_date}`, `lines[]` with `running_balance` per sku (exact string arithmetic), `own_material[]`, `closing_balances[]`, `total_customer_balance`. `?format=text` renders fixed-width UTF-8 text with `Content-Type: text/plain; charset=utf-8` (the Story 3.7 documents are stored as text `document_content`, there is no PDF renderer in the codebase; do not add one).
  - [x] 6.3 Add `KIT_LINE_MISMATCH` (new stable code) plus `INSUFFICIENT_STOCK`, `CROSS_ISSUE_BLOCKED`, `SOURCE_DOCUMENT_REQUIRED`, `DUPLICATE_EVENT` to `AUDITED_REJECTIONS` (:34-42) and route all catches through `auditFailSafe` (:51-57). Add `KIT_LINE_MISMATCH` to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts:18` next to `INVALID_STATE_TRANSITION` (:193).
  - [x] 6.4 Mount in `src/server.ts` after `:1041`; add ALL four routes to the spine allowlist `test/integration/story-1-9.test.ts:535-542` with a Story 9.3 comment.
- [x] Task 7: Recall trace coverage (AC: 3)
  - [x] 7.1 `src/quality/recall-trace.ts:152-155`: move job-work consumption from `not_yet_covered` into `where_used` as `custody.consumption_posted (Story 9.3)` and make the where-used query actually include `lot_trace` rows with that event type (read :100-160 first; the coverage list must not lie). Add a story test arm: a consumed customer lot appears in the Story 2.3 recall trace where-used within the same query.
- [x] Task 8: Tests (all ACs)
  - [x] 8.1 `test/integration/story-9-3.test.ts` cloned from the story-9-2 fixture shape (helpers at :31-406: `makeRequest`, `provisionUser`, `seedLocation`, `seedItem`, `seedBom`, `seedPo`, `seedToken`, `confirmedOrder`, `receive`, `orderRow`, `balances`, `auditCount`, `postEvent`, `withRolledBackClient`); never import cross-story; admin pool for seeding and cleanup; docker `ims-postgres-test` port 5442. Seed: two sites, a `job_work_kit` BOM with three lines (one tagged `customer`, one tagged `company`, one placeholder), a confirmed order, one or two 9.2 receipts (one over-tolerance) so the order is `in_process`.
  - [x] 8.2 Arms: receipt rows in ledger with variance (AC 1, 3.2); statement JSON running balance and closing totals, text format renders and is site-scoped with 404-versus-403 collapsed (AC 2); consumption happy path drains `stock_balance` job_work row, ledger delta negative, lot_trace row, balance falls (AC 3); over-balance refusal with details and zero rows written, physical-shortfall refusal from the stock surface also fully rolled back (AC 4); off-kit sku refuses `KIT_LINE_MISMATCH`, `company`-tagged line refuses, placeholder refuses, then amend via `bom_line.amended` or ECO and the same posting succeeds with `bom_line_id` recorded (AC 5); own material drains owned stock, billable row, excluded from customer balance, separate statement section (AC 6); `confirmed` (not yet `in_process`) order refuses, wrong-site refuses, another order's lot refuses `CROSS_ISSUE_BLOCKED`, direct `/api/v1/events` cannot bypass any gate, audit rows written for every refusal code (AC 7); replay with the same idempotency key returns 200 with the stored event and no second ledger row; two concurrent consumptions racing the last unit: exactly one succeeds (genuine-concurrency test, 9.2 review patch 3).
  - [x] 8.3 Unit tests: statement builder running balance and sign handling (parameterised, exact strings, no `Number()`), kit-line match predicate (customer, NULL, company, job_worker, placeholder), balance predicate with processor rows present, shape asserts closed-shape rejection.
  - [x] 8.4 Mutation-verify at TWO points (seam and route) for: the custody-balance gate, the kit-line gate, and the Symbol gated door (remove the Symbol check and the bar must fail the consumption test; remove the stamp and the total bar must refuse).
- [x] Task 9: Gates (all ACs)
  - [x] 9.1 Build, tsc, eslint, prettier clean; migrate twice idempotent against the test DB; schema-drift suite green except the 3 pre-existing pins.
  - [x] 9.2 Full suite versus baseline 086ce92 (fresh worktree, same DB, sequential): 0 new failures; document the noise floor (33 at 086ce92 per the 9.2 record: idempotency family, 2.5 x15, 1.7, 2.1, 3.10, 3.6, 5.3, schema-drift x2, gate_dwell CRLF, story-2-8 agreement idempotency).
  - [x] 9.3 `graphify update .`, update `sprint-status.yaml` and this file's Dev Agent Record.

### Review Findings

Group 1 of 4 (chunked review — event contract + schema/projection DDL: `deploy/compose/init-db.sql`, `src/events/schema.ts`, `src/events/migrate.ts`, `src/events/store.ts`, `read/projections/custody_ledger_entry.sql`, `src/read/projections/custody_ledger_entry.ts`). Groups 2-4 (seam logic, statement, tests) pending.

Group 2 of 4 (consumption/own-material seam + routes: `src/compliance/custody-ledger.ts`, `src/compliance/jobwork-receipt.ts`, `src/compliance/stock-balance.ts`, `src/api/v1/service-orders.ts`, `src/server.ts`, `src/sync/upload.ts`). Groups 3-4 (custody-statement, tests) pending.

- [x] [Review][Dismiss] Own-material `bom_line_id` validation missing sku match [src/compliance/custody-ledger.ts:587-601] — flagged by the Acceptance Auditor as a possible mis-attribution gap; initially patched, then reverted after running the story-9-3 suite: Task 5.1's literal spec text only requires the named `bom_line_id` belong to the kit BOM with `supply_source IN ('company','job_worker')`, with no sku-match clause (unlike consumption's `kitLineMatchesConsumption`, which does match sku per Task 4.3). The AC6 test (`story-9-3.test.ts:1028-1041`) exercises exactly this — own material posted against a different-sku company line, expecting 201 — confirming the unmatched-sku case is intentional, not a gap. No code change.
- [x] [Review][Defer] `custody_balance_after` advertised as a derived field for own-material (route `derivedFields` and `OWN_MATERIAL_DERIVED_FIELDS` both list it) but `applyCustodyOwnMaterialProjection` never writes it back [src/compliance/custody-ledger.ts:666] — deferred, own-material is excluded from the customer running balance so the field has no clear meaning here; response conditionally omits it, no crash, dead promise only
- [x] [Review][Defer] Replay path skips `assertSiteWriteAccess` when the order no longer exists but the idempotency key was already used [src/api/v1/service-orders.ts:571,576] — deferred, requires the order row to vanish after a successful posting (orders are never deleted in this domain), theoretical
- [x] [Review][Defer] Two different drain paths for consumption (`applyStockBalanceProjection` + Symbol gate) vs own-material (`applyStockIssue` directly, no gate) [src/compliance/custody-ledger.ts:507,607] — deferred, matches decision 6 (own material is NOT kit-line gated, ordinary owned drain by design); confirmed `applyStockIssue` still enforces QC-hold exclusion
- [x] [Review][Defer] `entry_id` provenance differs between write paths: receipt mints server-side (`randomUUID()`), consumption/own-material reuse the client-minted posting id [src/compliance/jobwork-receipt.ts, src/compliance/custody-ledger.ts:513,621] — deferred, disclosed BSD-10/9.2-reconciliation deviation already in Debug Log Table 3 ("Consumption id minting"), not a new gap
- [x] [Review][Defer] `format` query param on statement route is case-sensitive, no `.toLowerCase()` normalization — deferred, minor usability gap, no spec requirement for case-insensitivity
- [x] [Review][Defer] `postCustodyEvent` re-fetches the full order ledger via `listCustodyLedgerByOrder` and linear-scans for the just-inserted row instead of a targeted lookup [src/api/v1/service-orders.ts:606-607] — deferred, correctness is fine, minor inefficiency at low ledger-row-count scale

Group 3 of 4 (custody statement + recall-trace coverage: `src/compliance/custody-statement.ts`, `src/quality/recall-trace.ts`). Group 4 (tests) pending.

- [x] [Review][Patch] Statement route never passed `generatedAt` explicitly to a function documented as pure [src/api/v1/service-orders.ts:683, src/compliance/custody-statement.ts:108] — fixed: route now calls `buildCustodyStatement(order, entries, new Date().toISOString())` explicitly; the function's default parameter stays for unit-test convenience.
- [x] [Review][Defer] `total_customer_balance` sums closing balances across all SKUs regardless of UOM into one number [src/compliance/custody-statement.ts:135] — deferred, matches spec's literal "closing balances per sku and in total" wording (AC 2); business-meaningfulness question for the PO, not a code defect
- [x] [Review][Defer] `where_used` array not globally chronologically sorted across production and custody sources (production pushed first, custody appended after) [src/quality/recall-trace.ts] — deferred, minor readability gap, no spec requirement for cross-source ordering
- [x] [Review][Defer] `qtyToScaled` silently truncates input beyond 3 decimals rather than rounding/rejecting [src/compliance/custody-statement.ts:28] — deferred, low risk since all real inputs are `NUMERIC(18,3)::text` DB casts
- [x] [Review][Defer] `padLeft` truncates from the wrong end for overflowing numeric columns in the text renderer — deferred, only reachable at ~10^13+ magnitude quantities
- [x] [Review][Defer] `buildCustodyStatement` trusts caller-supplied row order with no runtime verification — deferred, matches documented design; hand-built test fixtures could silently produce wrong running balances if mis-ordered

Group 4 of 4, FINAL (tests: `test/integration/story-9-3.test.ts`, `test/unit/custody-ledger-predicates.test.ts`, `test/unit/custody-statement.test.ts`, `test/integration/story-1-9.test.ts`, `test/integration/story-8-5.test.ts`, `test/unit/schema-drift.test.ts`).

- [x] [Review][Patch] AC7's "direct POST /api/v1/events cannot bypass any gate" test never actually produces `KIT_LINE_MISMATCH` via the direct-event path — the only off-kit sku tried (`SKU_OFF`) was never received under the order, so it trips `CROSS_ISSUE_BLOCKED` first (test's own comment admits this). The Dev Agent Record's Table 4 claims the kit-line mutant was killed by "both a route arm and the direct event arm," but no direct-event arm reaching `KIT_LINE_MISMATCH` existed. Fixed: added a company-tagged-sku receipt under the same order (clears the lot-under-order gate) followed by a direct-event consumption for that sku, asserting `KIT_LINE_MISMATCH` [test/integration/story-9-3.test.ts:1160-1174]; downstream ledger-row-count assertions adjusted for the extra receipt row (2 then 3, was 1 then 2).
- [x] [Review][Patch] Dead ternary always evaluating to the same branch [test/unit/custody-ledger-predicates.test.ts:290] — `field === 'service_order_id' ? 'INVALID_PARAMS' : 'INVALID_PARAMS'` simplified to `'INVALID_PARAMS'`; both fields do share that error code (verified against `assertCommonShape`'s UUID-check loop, which runs before the stream_id equality check), so no behavior change, just removed the misleading dead branch.
- [x] [Review][Defer] Own-material path has no over-balance, replay, or concurrency integration arm (only consumption has all three) [test/integration/story-9-3.test.ts] — deferred, own-material drains ordinary owned stock through the pre-existing `applyStockIssue` path already covered by production/6.x suites; the story's AC 4 (over-balance refusal) is scoped to customer custody balance, not owned stock
- [x] [Review][Defer] Concurrency test only races two consumers each requesting the full balance (10 vs 10 against a balance of 10), not a partial-overlap case (e.g. 6 vs 6 against 10) — deferred, the simpler case already proves serialization under the lock; partial-overlap is the same code path, lower marginal value
- [x] [Review][Defer] No test drives two racing requests on the *same* idempotency key to force the `uq_custody_ledger_source_event` 23505-to-409-`DUPLICATE_EVENT` classification path itself (Task 4.6) — deferred, real gap, needs a same-idempotency-key concurrent-POST arm; flagged for a follow-up test addition, not blocking given `classifyDuplicate`'s constraint-name branch is exercised indirectly by unit coverage of the function's logic
- [x] [Review][Defer] `qtyToScaled`'s more-than-3-decimal-places behavior (truncate vs round vs reject) isn't pinned by a dedicated unit test — deferred, same class as the Group 3 finding; low risk since all real inputs are DB-cast strings
- [x] [Review][Defer] Schema-drift pin's constraint names (`chk_custody_ledger_category`, `chk_custody_ledger_ownership_vocab`) match the actual DDL — confirmed against Group 1's reviewed diff (`read/projections/custody_ledger_entry.sql:55-56`), not invented placeholders; no gap
- [x] [Review][Defer] `expectReject`'s field-hint check is a substring match on the error message, not an exact field-name assertion — deferred, could pass on an accidental substring collision (e.g. `bom_line_id` matching `kit_bom_line_id`), low risk given the current field-name set has no such collisions
- [x] [Review][Defer] Unit UUID-shape validation loop only covers `assertCustodyConsumptionShape`, not `assertCustodyOwnMaterialShape`'s id fields — deferred, both paths share `assertCommonShape`, so the validation logic itself is identical and already exercised once; the gap is coverage-symmetry, not an untested code path
- [x] [Review][Defer] `story-8-5.test.ts` asserts `not_yet_covered` shrank from 2 to 1 but never asserts what the remaining item is — deferred, minor test-robustness gap, not a story-9.3 defect

**Post-review verification** (2026-09-03): `tsc --noEmit` clean; `story-9-3.test.ts` 12/12; `custody-ledger-predicates.test.ts` + `custody-statement.test.ts` + `schema-drift.test.ts` 168/171 (3 fail, all pre-existing noise-floor pins: `compliance_bis_licence`, `label_master`, `gate_dwell_metric` CRLF; `custody_ledger_entry` pin itself passes); `story-1-9.test.ts` + `story-8-5.test.ts` 26/26.

- [x] [Review][Decision] `posted_by`/`correlation_id` typed UUID, spec says TEXT — `read/projections/custody_ledger_entry.sql:48,53` (+ init-db.sql mirror) declare `posted_by UUID NOT NULL` and `correlation_id UUID`; Task 2.1 literal spec says `TEXT`. Matches sibling `jobwork_material_receipt.received_by UUID` convention. Resolved: keep UUID, disclosed in Debug Log Table 3.
- [x] [Review][Patch] Inconsistent malformed-UUID handling across the three read helpers [src/read/projections/custody_ledger_entry.ts:172] — the two list functions' silent-`[]`-on-bad-UUID matches the codebase-wide convention (checked against 30+ sibling projection accessors), so left as-is. `customerCustodyBalance` (write-path, under lock) now throws an explicit `Error` on a malformed `serviceOrderId` instead of relying on the implicit raw PG error — same fail-closed outcome, clearer message.
- [x] [Review][Defer] Unconditional applier calls with no visible event_type guard [src/events/store.ts:259-260] — resolved in Group 2: both appliers early-return on `event_type`/`stream_type` mismatch (`custody-ledger.ts:425-426,572-573`), no gap
- [x] [Review][Defer] `business_date` correctness depends entirely on applier-side IST conversion, no DB constraint ties it to `occurred_at` [read/projections/custody_ledger_entry.sql] — deferred, Group 2 scope
- [x] [Review][Defer] `MIN(uom)` masks a cross-row UOM mismatch per sku in closing balances [src/read/projections/custody_ledger_entry.ts:199] — deferred, theoretical, no current caller produces mixed UOM
- [x] [Review][Defer] Two DDL files synced only by comment, no automated drift check [deploy/compose/init-db.sql, read/projections/custody_ledger_entry.sql] — deferred, pre-existing project-wide pattern since Story 9.2

## Dev Notes

### Binding scope decisions

1. **Ledger is one append-only projection, `custody_ledger_entry`, per (order, customer) with signed deltas per sku.** No per-sku balance table: the running balance is derived (SUM under the order lock for gates, window over rows for the statement). Two balances exist and both gate: the custody balance (ledger, per order and sku) and the physical `stock_balance` row (per sku, location, lot, class). AC 4 names the custody balance; the physical drain keeps its own `INSUFFICIENT_STOCK`.
2. **`custody` is a NEW stream type (AD-6) for consumption and own-material events; receipts stay on the `jobwork` stream and write the ledger row directly from the 9.2 applier.** A strict reading of AD-6 would put receipts on the custody stream too, but 9.2 already committed `jobwork.material_received` and its natural idempotency key; re-emitting a nested custody event per receipt adds a second event for the same fact. Disclose as a deviation. `stream_id = service_order_id` on both streams so `readStream('custody', orderId)` is the order's custody history.
3. **Movement vocabulary is forward-declared** (`return`, `loss`, `offcut`, `dispatch`, `count_adjustment`) with sign rules in the CHECK, no posting paths. 9.4 (loss, dispatch), 9.5 (count adjustment, closure gate reads the same SUM for `CUSTODY_NOT_ZERO`), 9.6 (return, offcut) post into this table. Do not build those paths now.
4. **Gated door is a Symbol stamp, not a classifier** (9.2 decision 4 continued). The stock-surface total bar at `stock-balance.ts:343-356` stays total; it opens only for a synthetic view carrying `CUSTODY_CONSUMPTION`. The comment at :338-342 already reserves this.
5. **Kit-line match resolves the CURRENT kit BOM revision at posting time; no revision pin.** The service order stores `kit_bom_id` only (`read/projections/service_order.sql`), and AC 5 says an attributed BOM amendment unblocks the posting, which a pin would defeat. This differs from production's revision pinning (6.2 `BOM_REVISION_DRIFT`); record `kit_bom_revision_id` on every consumption row so the statement is auditable against the revision in force. Disclose.
6. **Own material is NOT kit-line gated.** FR-JW-06 gates customer-material consumption by kit lines; FR-JW-07 own material is the processor's addition and may legitimately be off the customer's kit. An optional `bom_line_id` is validated when supplied. Own material never enters the customer balance and is the only `billable = true` category; 9.6 reads it for the billing feed.
7. **Error codes.** `INSUFFICIENT_STOCK`, `CROSS_ISSUE_BLOCKED`, `SOURCE_DOCUMENT_REQUIRED`, `DUPLICATE_EVENT` are pre-registered (spine line 337). `KIT_LINE_MISMATCH` is NEW (nowhere in `src/` or `test/`): register in the route `AUDITED_REJECTIONS` and `PERMANENT_ERROR_CODES` (9.1 BSD-5 precedent for `INVALID_STATE_TRANSITION`). Order-not-in-process reuses `SOURCE_DOCUMENT_REQUIRED` (9.2 precedent for order-not-receivable) rather than minting an order-state code. Lot-not-under-this-order reuses `CROSS_ISSUE_BLOCKED` with generic class-crossing semantics.
8. **Statement is a read resource, not a stored document.** No PDF machinery exists; Story 3.7 stores documents as text. JSON is canonical, `format=text` is the printable rendering. Nothing is persisted on request. 9.5 will render count-variance reconciliation onto the same statement from `count_adjustment` rows.
9. **IST business date** on every ledger row from `occurred_at` (IST calendar arithmetic, never JS Date diffs, 9.1 gotcha); 9.5 aging and ITC-04 read `business_date`.

### Critical defect classes to not reintroduce

- **Hold-bypass class** (8.3, 8.4, 8.5, 8.8): every gate re-derived under the order advisory lock plus `FOR UPDATE`; route pre-checks advisory only; the generic `/api/v1/events` route must hit the same seam gates.
- **Check-then-act races**: balance SUM and drain in the same locked transaction; genuine-concurrency test for the last-unit race.
- **Float coercion** (9.2 review patch 1): all quantity arithmetic on NUMERIC strings via scaled-integer BigInt.
- **Green-but-wrong tests** (8.4): no config asserted against itself; balances asserted on stored rows; mutation-verify gates at seam and route.
- **Every refusal code in `AUDITED_REJECTIONS`** with `auditFailSafe` (8.3).
- **Closed-shape payloads and `rejectUnacceptedFields`** symmetric on all mutating routes (9.1 review patches 3 and 10).
- **Coverage lists that lie** (recall-trace `not_yet_covered` must be updated together with the query, Task 7).
- **Lock order** must be documented and identical across `service-order.ts`, `jobwork-receipt.ts`, and the new seam (order lock, order row, stock rows last).

### Existing code being modified (read fully before editing)

Table 1 lists every UPDATE file with its current behaviour and what this story changes.

| File | Current state | This story changes | Must preserve |
| --- | --- | --- | --- |
| `src/compliance/jobwork-receipt.ts` | Receipt applier (:359) locks order, verifies GRN line, computes variance, inserts receipt row, fires first-receipt transition | Adds one `receipt` ledger insert between receipt row and transition | Lock order, Symbol gate, variance semantics, 18/18 story-9-2 tests |
| `src/compliance/stock-balance.ts` | Total bar :343-356 refuses `job_work` allocation and issue; laundering bar; BSD-12 carve-out comment | Symbol-gated pass-through for custody consumption only | Bar stays total for every other caller; `NON_SALEABLE_STOCK_CLASSES` untouched; cycle-count.ts mirror unchanged |
| `src/events/schema.ts`, `src/events/store.ts` | `jobwork` stream and four events registered; asserts :728-732, appliers :1087-1094 | New `custody` stream, two events, two asserts, two appliers | Registry order (tail-append) |
| `src/api/v1/service-orders.ts` | create, update, confirm, get, list, receipts routes; `AUDITED_REJECTIONS` :34-42 | Four new routes, codes added | 404-versus-403 collapse, site scoping helpers |
| `src/quality/recall-trace.ts` | Hard-coded coverage list :152-155, where-used over `production_order.material_issued` | Adds `custody.consumption_posted` to query and coverage | Propagation budget fields, existing arms |
| `src/sync/upload.ts` | `PERMANENT_ERROR_CODES` :18 | Adds `KIT_LINE_MISMATCH` | Nothing else |
| `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `src/server.ts` | Registration, mirror, pins, allowlist, mounts | Additive entries | Byte-identical mirror, LF canonical |

### Source tree to touch

Table 2 lists the expected footprint.

| File | Change |
| --- | --- |
| `src/compliance/custody-ledger.ts` | NEW seam: two asserts, two appliers, `CUSTODY_CONSUMPTION` Symbol |
| `src/compliance/custody-statement.ts` | NEW pure statement builder plus text renderer |
| `read/projections/custody_ledger_entry.sql` | NEW canonical DDL |
| `src/read/projections/custody_ledger_entry.ts` | NEW accessor |
| `test/integration/story-9-3.test.ts`, `test/unit/custody-*.test.ts` | NEW suites |
| Table 1 files | UPDATE |

### Testing standards summary

node:test serial integration suites, run-scoped random suffix, local fixture closures only, SCIM plus dev-token actors, admin pool for seeding (app_user lacks DELETE), migrate-twice idempotency gate, full-suite noise-floor comparison against baseline 086ce92, mutation verification on the three load-bearing gates at seam and route, one genuine-concurrency arm.

### Project Structure Notes

- Seam in `src/compliance/` (repo convention; the spine's `jobwork/` directory naming was deliberately varied by 9.1).
- Canonical SQL under `read/projections/` with LF endings; CRLF drift is a known noise family, do not "fix" unrelated pins.
- No edge-sync scope: consumption and own-material are central-only in this story (no PowerSync bucket changes). Disclose if the dev finds a sync path that must be closed.
- No UX artifact exists for the custody statement; the EXPERIENCE.md Factory persona lists "Job-Work (customer orders, custody ledger, dispatch)" only. JSON plus text rendering is the deliverable.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` lines 2617-2649 (Story 9.3), 2557-2559 (Epic 9 preamble), 1949 (FR-B-16 reconciliation delivered by 9.3), 2454 (Story 2.3 where-used names 9.3 consumption)
- PRD: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` lines 241-243 (FR-JW-05, 06, 07), 248 (FR-JW-13)
- Architecture: `ARCHITECTURE-SPINE.md` AD-6 (line 100-104), AD-14 (148), AD-16 (160), stable error codes (337)
- Previous stories: `9-2-customer-material-receipt-and-segregated-stock.md` (decisions 1-8, Debug Log deviations, review patches), `9-1-job-work-service-order-creation.md` (BSD-1 to BSD-10), `6-2-material-staging-issue-and-wip-ledger.md` (revision pinning contrast), `6-4-lot-genealogy-closure-and-offline-execution.md` (genealogy grain)
- Code anchors: `src/compliance/service-order.ts:32` (stream set), `:329` (lock), `:333-347` (`requireKitBom`), `:572` (`transitionServiceOrder`); `src/compliance/jobwork-receipt.ts:40-43` (Symbol), `:97` (`isPositiveQtyString`), `:249` (lock), `:258` (`requireReceivableOrder`), `:359` (applier); `src/compliance/stock-balance.ts:80` (`SEGREGATED_STOCK_CLASSES`), `:338-356` (total bar and reservation comment); `src/read/projections/stock_balance.ts:372` (`applyStockIssue`); `src/read/projections/bom.ts:108`, `:157` (`getBomById`, `getBomLines`); `read/projections/bom_line.sql:28`, `:60` (`supply_source`); `src/read/projections/lot_trace.ts:66` (`appendTraceEntry`); `src/read/projections/jobwork_material_receipt.ts:117` (`listJobworkMaterialReceiptsByOrder`); `src/compliance/production-material.ts:51-53`, `:909-934` (lock order and owned drain precedent); `src/api/v1/service-orders.ts:34-57`, `:109-122`, `:368-400`; `src/api/v1/quality.ts:214`, `:240`; `src/quality/recall-trace.ts:152-155`; `src/sync/upload.ts:18`, `:193`; `src/events/schema.ts:4478`, `:5390-5410`; `src/events/store.ts:728-732`, `:1087-1094`; `test/unit/schema-drift.test.ts:1708-1716`; `test/integration/story-1-9.test.ts:535-542`; `test/integration/story-9-2.test.ts:31-406` (fixture helpers)

### Open questions

None blocking. Two judgement calls are pre-decided above and must be disclosed, not re-litigated: decision 2 (receipts feed the ledger from the `jobwork` stream) and decision 5 (no kit revision pin). If the PO wants a pinned kit revision, it becomes a 9.4 change riding the confirm transition.

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story workflow, 2026-09-03.

### Debug Log References

Table 3 lists every deviation from the story text as written, each disclosed rather than silently applied.

| Item | What the story said | What was built | Why |
| --- | --- | --- | --- |
| Ledger `lot_id` type | `lot_id UUID` in the Task 2.1 column list | `lot_id TEXT` | Every upstream grain the ledger is fed from (`stock_balance.lot_id`, `jobwork_material_receipt.lot_id`, the consumption posting) carries the `lot_master.lot_number` business key, not the UUID surrogate. A UUID column would have forced a lookup on every receipt and broken the receipt-to-ledger join. `lot_trace` still gets the UUID: the seam resolves it through `getLotByNumberAndSku` and refuses 409 `LOT_NOT_FOUND` when no master row exists (fail-closed; a lot received through the GRN always has one). |
| Statement header field | Not in the Task 6.2 header list | `status` added to the statement header | The printable statement is meaningless without the order state; additive, no field removed. |
| AC 5 amendment path | "`bom_line.amended` or an implemented ECO" | `bom.job_work_kit_tagged` (the Story 5.6 attributed tagging event, route `POST /api/v1/boms/:bomId/job-work-kit-tags`) | `bom_line.amended` carries no `supply_source` field (schema.ts `BomLineAmendedPayload`), so it cannot turn a company line into a customer line. Tagging is the attributed path that exists for exactly this axis; it is accepted only on draft / on_hold BOMs, so the test arm uses a draft kit BOM. The seam resolves the CURRENT revision at posting time (decision 5), which is what makes the amended posting succeed. |
| Consumption id minting | "Ids minted client-side (UUIDv4, BSD-10 idiom)" | Route accepts an optional client `consumption_id` / `own_material_id` (UUID) and mints one when absent; the direct-event path requires it | Reconciles the 9.1 BSD-10 wording (ids minted in the route) with the 9.2 receipt idiom (client-minted `receipt_id`). Replay is keyed by idempotency key either way. |
| Posting site | Not specified whether the route derives it | Route defaults `site_id` to the order's site and accepts an explicit override; the seam re-derives the match under lock | An explicit override lets the wrong-site arm exercise the seam gate from the route; `posted_by` is never accepted from the body (stamped from the actor). |
| Extra audited code | AC 7 lists five codes | `LOT_NOT_FOUND` also added to `AUDITED_REJECTIONS` | The seam can raise it (own material naming a lot with no master row); every seam refusal must leave an audit row (8.3 lesson). |
| Direct-event RBAC | Not stated | The generic events route maps module = `stream_type`, so a direct `custody.*` submission needs a `custody` module write assignment | The test coordinator carries one; no RBAC change was made. Disclosed so the PO knows the new stream implies a new module name in role assignments. |
| Story 8.5 test | "coverage list must change" | `test/integration/story-8-5.test.ts` coverage assertion changed from 2 to 1 `not_yet_covered` entries and now asserts `where_used` names `custody.consumption_posted` | The recall-trace coverage list and query changed together (Task 7); the 8.5 pin asserted the old list. Deliberate fixture change. |
| Where-used shape | Not specified | `WhereUsedEntry` gained `source` (`production_order.material_issued` or `custody.consumption_posted`); for custody rows `production_order_id` carries the `service_order_id` and `output_sku` the kit parent sku | Additive; existing 8.5 consumers keep every field they had. |
| Ledger `posted_by`/`correlation_id` type | `posted_by TEXT NOT NULL`, `correlation_id TEXT` in the Task 2.1 column list | `posted_by UUID NOT NULL`, `correlation_id UUID` | Matches the sibling `jobwork_material_receipt.received_by UUID` convention; caught in Group 1 code review, confirmed by PO 2026-09-03. |

Mutation verification (Task 8.4), run with a scripted apply / test / revert cycle against the story-9-3 suite; Table 4 records the outcome. Every mutant was killed by BOTH a route arm and the direct `POST /api/v1/events` arm, which is the two-point requirement (route and seam are the two write paths that reach the gate).

| Mutant | Result | Killed by |
| --- | --- | --- |
| Custody-balance gate always passes | 10 pass, 2 fail | AC4 over-balance arm; AC7 direct-event arm |
| Kit-line predicate ignores supply_source and placeholder | 10 pass, 2 fail | Both AC5 arms |
| Symbol door: bar ignores the Symbol (bar stays open) | 3 pass, 9 fail | Every consumption arm (bar refuses the seam's own view) |
| Symbol door: seam does not stamp the view | 3 pass, 9 fail | Every consumption arm (the total bar refuses) |
| Lot-under-order gate removed | 10 pass, 2 fail | AC7 route arm; AC7 direct-event arm |
| Order-state gate accepts confirmed | 10 pass, 2 fail | AC7 route arm; AC7 direct-event arm |

Other verification: `tsc` clean; eslint clean on `src/` and the three new test files; prettier clean on every story file (the one prettier warning is `src/sync/upload.ts`, whose working copy is CRLF - the known drift family, edit preserved its endings); `db:migrate` run twice against `ims-postgres-test` (5442) with no error; schema-drift suite green except the three pre-existing pins (`compliance_bis_licence`, `label_master`, `gate_dwell_metric`); story-9-2 18/18, story-8-5 and story-1-9 green when run serially (45/45 across the three); story-9-3 12/12; unit 27/27.

Full-suite noise floor: current tree 1788 tests, 1756 pass, 32 fail; baseline 086ce92 in a fresh worktree against the same DB, sequential: 1748 tests, 1717 pass, 31 fail. Set difference of leaf failures: 0 fixed, 1 apparently new (`gate_dwell_metric` view-body drift pin). That pin fails in THIS working copy with the 9.3 changes stashed as well (line-ending drift of the checkout, the family the 9.2 record lists as gate_dwell CRLF), and the 9.3 diff touches no gate_dwell line; a fresh worktree checkout does not carry the drift, which is why the baseline count is one lower. Net new failures attributable to 9.3: 0. The 31 shared failures are the idempotency family, 2.5 x15, 1.1, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.8 agreement idempotency, 3.6, 3.10, 5.3, and the schema-drift pins `compliance_bis_licence` and `label_master`. 40 tests were added by this story.

### Completion Notes List

- Task 1: NEW `custody` stream type registered in `SUPPORTED_EVENT_TYPES` with `custody.consumption_posted` and `custody.own_material_added` (tail-append, `requiresBusinessStream: false`), typed payloads next to the 9.2 receipt payload, closed-shape asserts and appliers wired in `store.ts` right after the 9.2 pair.
- Task 2: `custody_ledger_entry` canonical DDL (LF) with sign and ownership CHECKs, the full forward-declared category vocabulary, `uq_custody_ledger_source_event`, two indexes, in-file grants; byte-identical CRLF mirror appended to `init-db.sql`; migrate registration tail-appended; drift pin added. Accessor exposes `insertCustodyLedgerEntry`, `listCustodyLedgerByOrder`, `customerCustodyBalance` (SQL SUM, NUMERIC string), `customerCustodyBalancesByOrder`, and the exported `CUSTOMER_OWNED_PREDICATE` the unit test pins.
- Task 3: the 9.2 receipt applier inserts the `receipt` ledger row between the receipt row and the transition, keyed by the receipt event id (decision 2 deviation, disclosed in the story). Story-9-2 stays 18/18; the 9.3 AC1 arm asserts one row per receipt carrying the variance flag and the receiver.
- Task 4: `src/compliance/custody-ledger.ts` - documented lock order (order advisory lock, order row FOR UPDATE, stock rows last), five gates in the story's order, kit-line resolution on the CURRENT revision with `supply_source_untagged` written back for NULL lines, the `CUSTODY_CONSUMPTION` Symbol door through the 9.2 total bar (`stock-balance.ts` opens for a stamped `issue` only), ledger row, `lot_trace` row (`business_stream = 'job_work'`), server-derived fields written back, 23505 classified by constraint name.
- Task 5: own-material applier in the same module: `in_process` and site gates, optional `bom_line_id` validated as a processor-supplied kit line, ordinary owned drain through `applyStockIssue`, `own_material` row (`processor`, `billable = true`, positive delta), trace when a lot is named; excluded from the customer balance by the SQL predicate (unit-pinned and integration-asserted).
- Task 6: four routes in `service-orders.ts` (two writes sharing one handler body, two reads with the 404-versus-403 collapse), `KIT_LINE_MISMATCH` plus the four pre-registered codes and `LOT_NOT_FOUND` in `AUDITED_REJECTIONS`, `KIT_LINE_MISMATCH` in `PERMANENT_ERROR_CODES`, mounts in `server.ts`, four entries in the spine allowlist. Statement builder and text renderer are pure functions in `custody-statement.ts` (100-column fixed width, `text/plain; charset=utf-8`).
- Task 7: `recall-trace.ts` where-used now unions a `lot_trace` join to `custody_ledger_entry` and `service_order` for `custody.consumption_posted`, and the coverage list moved job-work consumption into `where_used` in the same edit. Story-8-5 pin updated; 9.3 arm proves a consumed customer lot appears under a QC hold's trace.
- Task 8: `test/integration/story-9-3.test.ts` (12 arms, every AC, replay, genuine last-unit concurrency, recall trace), `test/unit/custody-ledger-predicates.test.ts` (20) and `test/unit/custody-statement.test.ts` (7). Six mutants killed at both write paths (Table 4).
- Task 9: gates recorded above; `graphify update .` run; sprint-status and this record updated.

### File List

- `read/projections/custody_ledger_entry.sql` (new)
- `src/read/projections/custody_ledger_entry.ts` (new)
- `src/compliance/custody-ledger.ts` (new)
- `src/compliance/custody-statement.ts` (new)
- `test/integration/story-9-3.test.ts` (new)
- `test/unit/custody-ledger-predicates.test.ts` (new)
- `test/unit/custody-statement.test.ts` (new)
- `deploy/compose/init-db.sql` (modified: CRLF mirror appended)
- `src/events/migrate.ts` (modified: registration)
- `src/events/schema.ts` (modified: payload types, registry entries)
- `src/events/store.ts` (modified: asserts and appliers wired)
- `src/compliance/jobwork-receipt.ts` (modified: receipt ledger row)
- `src/compliance/stock-balance.ts` (modified: Symbol-gated door)
- `src/api/v1/service-orders.ts` (modified: four routes, audited codes)
- `src/server.ts` (modified: mounts)
- `src/sync/upload.ts` (modified: `KIT_LINE_MISMATCH` permanent)
- `src/quality/recall-trace.ts` (modified: where-used union and coverage list)
- `test/unit/schema-drift.test.ts` (modified: pin)
- `test/integration/story-1-9.test.ts` (modified: allowlist)
- `test/integration/story-8-5.test.ts` (modified: coverage assertion)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
- `_bmad-output/implementation-artifacts/9-3-custody-ledger-and-consumption.md` (this file)

## Change Log

- 2026-09-03: Story created via create-story workflow at baseline 086ce92 (9.1 and 9.2 done and committed). Ultimate context engine analysis completed - comprehensive developer guide created.
- 2026-09-03: Implemented by dev-story workflow. Custody ledger projection, custody stream with consumption and own-material seams, Symbol-gated door through the 9.2 bar, statement (JSON and text), recall-trace coverage, four routes; 12 integration arms, 27 unit tests, six mutants killed at both write paths. Status set to review.
