---
baseline_commit: 5250c250641f3eb6ee1ed6fa937f933e4ea6db25
---

# Story 9.2: Customer Material Receipt and Segregated Stock

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a receiving clerk,
I want customer material received only against confirmed orders through the gate and receiving flows, with the challan captured and stock held in a segregated, non-valuated class,
so that customer-owned material is never mixed with or consumed by other demand.

## Acceptance Criteria

1. **Receipt blocked without confirmed order (FR-JW-03).** Given customer material arriving, when receipt is attempted without a confirmed service order (order missing, not found, or in `draft`, `in_process` is acceptable for subsequent receipts, `closed` refuses), then the receipt is blocked with `error_code: "SOURCE_DOCUMENT_REQUIRED"` (409) until a confirmed order and challan are present. A job-work receipt missing the inbound challan reference or challan date refuses with the same code.
2. **Challan captured and receipt recorded against the order (FR-JW-03).** Given a confirmed service order and an inbound challan, when the material is received through the gate and receiving flows, then the challan number and challan date are persisted, a receipt event is recorded against the order, and the FIRST customer-material receipt for the order transitions the order `confirmed` to `in_process` in the same transaction via the exported `transitionServiceOrder` seam. Subsequent receipts against an `in_process` order do not attempt the transition again.
3. **Receipt tolerance variance flagged (FR-JW-03, FR-JW-05).** Given a receipt where received quantity deviates from the inbound challan quantity, when the deviation exceeds the configured receipt tolerance, then the variance is recorded as an exception row attributed to the receiving user, persisted so the Story 9.3 first custody statement can render it. A within-tolerance deviation is stored but not flagged.
4. **Non-valuated segregated stock class (FR-JW-04).** Given received customer material, when it is stocked, then the `stock_balance` row is written with `stock_class = 'job_work'`, the lot is keyed to the (customer, order) custody pair, and the stock is excluded from valuation, planning availability, forward pick, and cross-dock, exactly as non-owned classes already are.
5. **Cross-issue blocked (FR-JW-04).** Given customer-owned stock in the `job_work` class, when ANY allocation, reservation, issue, or pick names it (in Story 9.2 no legitimate demand path for `job_work` stock exists at all; consumption arrives only with the Story 9.3 custody seam), then the attempt is rejected with `error_code: "CROSS_ISSUE_BLOCKED"` (400, stock-surface idiom) carrying `{sku, stock_class, lot_id, location_id, demand_kind}` in details; the attempting user and demand source are captured by the Story 1.3 statutory request middleware (disclosed AC-letter deviation: the stock seam cannot write audit rows for a refusal because the transaction aborts, the documented BSD-12 carve-out at `stock-balance.ts:298-305` extends to this code).
6. **Lot-level segregation holds.** A lot received as `job_work` can never later gain an `owned` (or other-class) balance, and vice versa, via the existing lot-level laundering bar extended to the `job_work` class; cycle-count adjustment paths honour the same bar.
7. **Ownership binding fail-closed.** Every `job_work`-class receipt is verified in-transaction against the linked service order's `customer_party_code`; a mismatch or missing binding refuses fail-closed (no unattributed customer stock can enter the system by any write path, including the generic `/api/v1/events` route).

## Tasks / Subtasks

- [x] Task 1: Event contract and registry (AC: 1, 2)
  - [x] 1.1 Register `jobwork.material_received` in `src/events/schema.ts` on the existing `jobwork` stream (stream_id = `service_order_id`), central-only, `requiresBusinessStream: false` (the order row already carries `business_stream = 'job_work'`). Payload: `{ service_order_id, receipt_id, grn_line_id, challan_number_ext, challan_date, sku, lot_id, received_qty, challan_qty, uom, variance_qty, variance_flagged, site_id, received_by }`. `receipt_id` minted client-side (UUIDv4, BSD-10 idiom from 9.1).
  - [x] 1.2 Add payload shape assert `assertJobworkMaterialReceivedShape` in the seam (pre-DB, closed-shape: reject unknown keys, mirror the 9.1 review patch 10).
  - [x] 1.3 Wire shape assert and applier into `src/events/store.ts` following the 9.1 wiring shape.
- [x] Task 2: Projection `jobwork_material_receipt` (AC: 2, 3)
  - [x] 2.1 Canonical DDL `read/projections/jobwork_material_receipt.sql` (LF), byte-identical mirror in `deploy/compose/init-db.sql`, tail-append registration in `src/events/migrate.ts`, idempotent, app_user grants in-file. Columns: `receipt_id PK, service_order_id FK-shaped, grn_line_id, challan_number_ext, challan_date DATE, sku, lot_id, received_qty NUMERIC(18,3), challan_qty NUMERIC(18,3), uom, variance_qty NUMERIC(18,3), variance_flagged BOOLEAN, received_by, site_id, correlation_id, source_event_id, created_at`. Unique `uq_jobwork_receipt_grn_line (grn_line_id)` so one GRN line yields one custody receipt row.
  - [x] 2.2 Add schema-drift pin entry in `test/unit/schema-drift.test.ts` (canonical path, table, constraints, indexes, indexBodies), following the `service_order` entry at ~L1691.
- [x] Task 3: Receipt seam logic (AC: 1, 2, 3, 7)
  - [x] 3.1 New module `src/compliance/jobwork-receipt.ts` (or extend `service-order.ts` if cohesion is better; keep the seam split idiom: assert pre-DB, apply in-txn). Applier, under `pg_advisory_xact_lock` keyed by `service_order_id` then row `FOR UPDATE`:
    - Re-derive order status in-transaction; refuse `SOURCE_DOCUMENT_REQUIRED` unless `confirmed` or `in_process` (fail-closed, hold-bypass lesson: never trust route pre-checks).
    - Verify `site_id` matches the order's `site_id`; mismatch refuses `SOURCE_DOCUMENT_REQUIRED`.
    - Ownership binding (AC7): the receipt is bound to the order's `customer_party_code`; mirror `assertConsignmentReceiptOwnership` (`src/compliance/ownership.ts:241`) invoked from the projection applier so every write path is covered.
    - Compute `variance_qty = received_qty - challan_qty`; flag when `abs(variance_qty) > challan_qty * tolerance`; attribute to `received_by`.
    - Insert the `jobwork_material_receipt` row; `23505` on `uq_jobwork_receipt_grn_line` resolves to a distinguishable refusal (check WHICH constraint fired, 9.1 review patch 7).
    - If order status is `confirmed`, call `transitionServiceOrder(serviceOrderId, 'in_process', {...}, client)` (exported at `src/compliance/service-order.ts:572`, built for exactly this); if already `in_process`, skip.
  - [x] 3.2 Receipt tolerance config: fail-closed boot-validated knob `JOBWORK_RECEIPT_TOLERANCE_PCT` (default `0.5`, weighbridge class-III instrument accuracy; valid range `0` to `10` inclusive, non-numeric, negative, or above-cap refuses to boot), following the 8.4 `resolveRetentionYears` boot-guard pattern. Flag when `abs(variance_qty) > challan_qty * (tolerance / 100)`; exactly-at-tolerance does NOT flag. `challan_qty` must be strictly positive (shape assert refuses `INVALID_PARAMS` pre-DB, no division-by-zero path). Unit-test both branches plus the at-boundary case with a parameterized predicate (no tautological config assertions, 8.4 lesson). Document the knob name in the story Completion Notes so site admins can find it.
- [x] Task 4: Stock integration through the existing receiving flow (AC: 4, 7)
  - [x] 4.1 Extend `src/compliance/receiving.ts` `applyGoodsReceivedProjection`: when the receipt payload carries `stock_class: 'job_work'`, REQUIRE `service_order_id`, `challan_number_ext`, `challan_date`; absent means 409 `SOURCE_DOCUMENT_REQUIRED`. The existing synthetic `stock.received` hand-off (receiving.ts ~L540) carries `stock_class: 'job_work'` so `applyStockReceipt` writes the segregated grain row. Emit or apply the `jobwork.material_received` record in the SAME transaction as the GRN line.
  - [x] 4.2 Do NOT invent a parallel receipt route: the gate and receiving flows (GRN via `POST /api/v1/grn-lines`) are the entry point per FR-JW-03; `grn_line.stock_class` already exists with default `'owned'`.
  - [x] 4.3 QC-hold interplay (DECIDED): customer material keeps the existing qc_hold and quarantine routing of `applyGoodsReceivedProjection` unchanged - BIS-licensed or quarantine-required items land in `ZONE-QC-HOLD` (receiving.ts:479-492) exactly like owned stock; NO exemption. QC hold and custody COMPOSE: the `jobwork_material_receipt` custody row is written at receipt time, not at putaway release, so a quarantined customer lot is still in custody from the moment it enters the building. Add a test arm: quarantine-required item received as `job_work` lands in the quarantine location AND the custody row exists.
- [x] Task 5: Cross-issue guard (AC: 5, 6)
  - [x] 5.1 In `src/compliance/stock-balance.ts`: TOTAL bar, not a demand classifier. ANY `kind === 'allocation'` or issue naming `stock_class: 'job_work'` throws 400 `CROSS_ISSUE_BLOCKED` (code pre-registered in the spine stable list; reuse, do not mint), details `{sku, stock_class, lot_id, location_id, demand_kind}`. In 9.2 there is no legitimate `job_work` demand path; Story 9.3's custody-consumption seam opens its own gated door. Do NOT build "is this demand job-work?" classification logic - a total bar has one mutation-testable arm, a classifier lies green. Model on the `PROTOTYPE_NOT_SALEABLE` arm at stock-balance.ts:306-313, as a separate check (do not add `job_work` to `NON_SALEABLE_STOCK_CLASSES`; that set's semantics are prototype-specific). Classless defaults already drain `'owned'` only; verify no query widens.
  - [x] 5.2 Extend the lot-level laundering bar (stock-balance.ts:319-345, advisory-lock key `stock_class_guard:{sku}:lot:{lotId}` constant 8808): introduce a named `SEGREGATED_STOCK_CLASSES` set (`prototype`, `job_work`) so the guard trigger at L319-321 (currently fires only on `owned` or non-saleable receipts) also fires on `job_work` receipts, and class-conflict detection covers `job_work` both directions.
  - [x] 5.3 Mirror the vocabulary and guard change verbatim in `src/compliance/cycle-count.ts` (VALID_STOCK_CLASSES duplicated at L63; guard trigger at L1006 and conflict-class list at L1024 must gain `job_work` in lockstep; the stock-balance.ts comment mandates both files move together) and confirm the cycle-count class-conflict path covers `job_work`.
  - [x] 5.4 Amend the BSD-12 carve-out comment block (stock-balance.ts:298-305) to cover `CROSS_ISSUE_BLOCKED`: the stock surface carries no audit machinery and a seam refusal aborts the transaction, so the attempt is captured by the Story 1.3 statutory request middleware instead; do NOT add the code to any `AUDITED_REJECTIONS` set unless a quality-surface route in `src/api/v1/quality.ts` gains a path that emits it. Disclose as an AC5-letter deviation in Debug Log References.
  - [x] 5.5 Confirm downstream consumers stay blind: planning availability, forward pick, site availability (hard-filtered `stock_class = 'owned'`), cross-dock (`src/compliance/cross-dock.ts:328-333`), valuation (`src/api/v1/valuation.ts` non-owned handling: job_work stock must carry no value).
- [x] Task 6: Read routes (AC: 2, 3)
  - [x] 6.1 `GET /api/v1/service-orders/:id/receipts` (module `jobwork`, read) listing receipt rows with variance fields; site-scoped via `permittedLocationsForModuleScope`; 404-vs-403 ordering per the 9.1 info-leak fix.
  - [x] 6.2 Add all new routes to the spine allowlist in `test/integration/story-1-9.test.ts` (~L536, with a story comment), and mount in `src/server.ts`.
- [x] Task 7: Tests (all ACs)
  - [x] 7.1 `test/integration/story-9-2.test.ts` cloned from the story-9-1 fixture shape (local harness re-implementation, never import cross-story; SCIM plus dev-token actors; admin pool for fixture writes and cleanup; docker `ims-postgres-test` port 5442). Seed: two sites, `job_work_kit` BOM, confirmed service order via the 9.1 routes, item and location rows for GRN flow.
  - [x] 7.2 Arms: refusal without order, with draft order, with wrong-site order, missing challan (AC1); happy path receipt with challan persisted and order flipped `in_process`, second receipt does not re-transition (AC2); over-tolerance variance flagged and attributed, within-tolerance not flagged (AC3); stock_balance row `job_work` class, invisible to availability (AC4); `CROSS_ISSUE_BLOCKED` on allocation, pick, transfer, and classless drain attempts, error details `{demand_kind, actor-visible context}` asserted (no audit row: BSD-12 carve-out, AC5); laundering bar both directions plus cycle-count arm (AC6); customer mismatch refusal via generic `/api/v1/events` route (AC7).
  - [x] 7.3 Unit tests: tolerance predicate both branches, transition predicate arms, shape-assert closed-shape rejection. Mutation-verify the two load-bearing guards at TWO points (seam AND route; route pre-checks mask seam-only mutants, 8.6 lesson): the confirmed-order gate and the cross-issue guard.
  - [x] 7.4 Idempotency: replay of `jobwork.material_received` with the same idempotency key returns the stored event (200), no duplicate receipt row, no double transition; use `findEventByIdempotencyKey` to avoid tripping on own writes (8.7 lesson).
- [x] Task 8: Gates (all ACs)
  - [x] 8.1 Build, tsc, eslint, prettier clean; migrate twice idempotent against the test DB; schema-drift suite green.
  - [x] 8.2 Full suite vs baseline: 0 new failures; document the noise floor (31 at 3e5ba49: CRLF drift, idempotency family, story-7-8 flake). Story 9.1 work is UNCOMMITTED in the working tree; establish the baseline with 9.1 present.

### Review Findings

- [x] [Review][Patch] `Number()` coercion in the GRN-line/event cross-check can lose precision on 16+ digit quantities, weakening the anti-forgery match [src/compliance/jobwork-receipt.ts]
- [x] [Review][Patch] Ownership gate skips the site check (safe only because a later same-transaction insert catches it); document the invariant [src/compliance/jobwork-receipt.ts]
- [x] [Review][Patch] No test exercises two concurrent receipts against the same order (only sequential and replay are covered) [test/integration/story-9-2.test.ts]
- [x] [Review][Patch] AC5 prose promises `CROSS_ISSUE_BLOCKED` for pick/reservation, but those paths never reach it (blind by construction per Dev Notes decision 4); restate this in the Debug Log deviations list [_bmad-output/implementation-artifacts/9-2-customer-material-receipt-and-segregated-stock.md]

## Dev Notes

### Binding scope decisions

1. **Reuse `stock_class = 'job_work'`.** The class already exists in `VALID_STOCK_CLASSES` (`src/compliance/stock-balance.ts:66`) but has no receipt path, ownership gate, or demand bar. This story activates it; do NOT mint a `customer` class.
2. **Receipt rides the existing receiving flow** (`goods.received`, GRN, synthetic `stock.received` through the Story 2.x stock-balance seam), with `jobwork.material_received` as the order-linked custody record on the `jobwork` stream in the same transaction. AD-6's separate custody-ledger stream type is Story 9.3 scope; 9.2 persists the receipt rows 9.3 will consume for the first custody statement.
3. **`in_process` transition belongs to this story.** `transitionServiceOrder` (`src/compliance/service-order.ts:572`) was forward-built by 9.1 BSD-2 for exactly this call; comment at L565-570 states it. First receipt only; inside the receipt transaction; refusals surface `INVALID_STATE_TRANSITION`.
4. **Custody keyed by (customer, order)** per 9.1 BSD-4: no customer master; the order's `customer_party_code` is the binding, verified in-transaction on every receipt (consignment ownership-gate precedent, `src/compliance/ownership.ts:241`).
5. **Challan date is load-bearing for 9.5**: Rule 45 return clocks count from the challan date. `challan_date` is a DATE, an IST business date; use IST calendar arithmetic, never JS Date diffs (9.1 gotcha).
6. **Receipt tolerance is epic-invented** (no PRD backing, no default anywhere): one global boot-validated config knob `JOBWORK_RECEIPT_TOLERANCE_PCT`, default `0.5` percent (weighbridge class-III instrument accuracy - a `0` default would flag every routine weighbridge wobble and train clerks to ignore the flag, which fails ignored, not closed). Nothing is hidden either way: `variance_qty` is stored on every receipt and appears on the custody statement; the flag only controls exception attribution.
7. **Error codes are pre-registered**: `SOURCE_DOCUMENT_REQUIRED` and `CROSS_ISSUE_BLOCKED` are in the spine stable list (ARCHITECTURE-SPINE.md line 337). `CROSS_ISSUE_BLOCKED` is shared with Epic 10 R&D; keep semantics generic (attempted class-crossing demand), not job-work-specific text.
8. **Non-valuated means invisible, not zero-priced**: exclusion from valuation and availability already falls out of the class-scoped queries; verify rather than build.

### Critical defect classes to not reintroduce

- **Hold-bypass class** (recurred 8.3, 8.4, 8.5, 8.8): every applier re-derives order status and stock state under `pg_advisory_xact_lock` plus `FOR UPDATE` inside the transaction; route pre-checks are advisory only.
- **Check-then-act races**: laundering bar and first-receipt transition both need the advisory-lock serialization already idiomatic in stock-balance.ts and service-order.ts.
- **Green-but-wrong tests** (8.4): no config asserted against itself; variance arithmetic asserted on stored values; mutation-verify guards at seam and route.
- **Every refusal code in `AUDITED_REJECTIONS`** of the emitting route file (8.3 lesson); `auditFailSafe` wrapper so audit failure never displaces the AppError.
- **Closed-shape payloads and `rejectUnacceptedFields`** symmetric on all mutating routes (9.1 review patches 3 and 10; the generic `/api/v1/events` route bypasses REST field-stripping, so the seam must validate everything).

### Source tree to touch

Table 1 (files) lists the expected footprint; it mirrors the 9.1 single-commit shape.

| File | Change |
| --- | --- |
| `src/events/schema.ts` | register `jobwork.material_received` |
| `src/compliance/jobwork-receipt.ts` | NEW seam (assert plus applier) |
| `src/compliance/receiving.ts` | job_work arm in `applyGoodsReceivedProjection` |
| `src/compliance/stock-balance.ts` | cross-issue guard, laundering bar widening |
| `src/compliance/cycle-count.ts` | duplicated vocabulary and conflict path |
| `read/projections/jobwork_material_receipt.sql` | NEW canonical DDL |
| `deploy/compose/init-db.sql` | byte-identical mirror |
| `src/events/migrate.ts`, `src/events/store.ts` | registration and wiring |
| `src/api/v1/service-orders.ts` or NEW route file | receipts read route |
| `src/server.ts` | mounts |
| `test/integration/story-9-2.test.ts`, `test/unit/*` | new suites |
| `test/integration/story-1-9.test.ts`, `test/unit/schema-drift.test.ts` | allowlist and pins |

### Testing standards summary

node:test serial integration suites, run-scoped random suffix, local fixture closures only, SCIM plus dev-token actors, admin pool for seeding (app_user lacks DELETE), migrate-twice idempotency gate, full-suite noise-floor comparison against the pre-story baseline with 9.1 uncommitted work present, mutation verification on load-bearing guards.

### Project Structure Notes

- Seam in `src/compliance/` (repo convention; 9.1 deliberately varied from the spine's `jobwork/` directory naming).
- Canonical SQL under `read/projections/` with LF endings; CRLF drift is a known noise-floor family, do not "fix" unrelated pins.
- No edge-sync scope: no PowerSync bucket or edge table changes for receipts in this story (custody visibility is 9.3+; gate flows already sync GRN artifacts).
- No UX scope: receipt rides existing gate and receiving flow surfaces; no design artifact exists for 9.2.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` lines 2587-2615 (Story 9.2), 2557-2585 (Epic 9 preamble)
- PRD: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` section 4.8 (FR-JW-03, FR-JW-04, FR-JW-05), line 351 (FR-AC-11 Rule 45)
- Architecture: `ARCHITECTURE-SPINE.md` AD-6 (line 100), AD-14 (line 148), stable error codes (line 337)
- Previous story: `_bmad-output/implementation-artifacts/9-1-job-work-service-order-creation.md` (BSD-2, BSD-4, BSD-10, review patches 1-10)
- Code anchors: `src/compliance/service-order.ts:572` (`transitionServiceOrder`), `src/compliance/stock-balance.ts:66` (vocabulary), `:319-345` (laundering bar), `src/compliance/ownership.ts:241` (ownership gate precedent), `src/compliance/receiving.ts:360` (stock_class default), `~L540` (synthetic `stock.received`), `test/unit/schema-drift.test.ts:1691` (pin pattern)

### Resolved decisions (2026-09-02 round-table, code-grounded)

All three former open questions are CLOSED; implement as written, no PO gate remains.

1. **Tolerance default 0.5 percent**, knob `JOBWORK_RECEIPT_TOLERANCE_PCT`, boot-validated range 0 to 10. Rationale: weighbridge class-III accuracy is 0.2 to 0.5 percent; a zero default flags every routine receipt and produces alert fatigue on the custody statement, while `variance_qty` is stored regardless so nothing is hidden. `challan_qty` strictly positive (shape assert), flag on `abs(variance_qty)` strictly exceeding the tolerance band, at-boundary does not flag.
2. **No QC exemption for customer material.** Existing BIS and quarantine routing applies unchanged; QC hold and custody compose (custody row at receipt, not putaway release).
3. **Shortfall equals overage**: one variance category, signed `variance_qty`, flag on absolute value. Story 9.3 renders the sign; a distinct shortfall category is speculative structure for a consumer that does not exist yet.
4. **Cross-issue guard is a TOTAL bar** in 9.2 (no `job_work` demand path exists until 9.3's custody seam); 400 from the stock surface matching the `PROTOTYPE_NOT_SALEABLE` idiom; kept OUT of `NON_SALEABLE_STOCK_CLASSES` (separate check, prototype semantics stay prototype-specific); new `SEGREGATED_STOCK_CLASSES` set widens the laundering bar; AC5 "logged" satisfied by the Story 1.3 statutory request middleware because a seam refusal aborts its transaction (BSD-12 carve-out extended, disclosed deviation).

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story workflow, 2026-09-03.

### Debug Log References

- Baseline commit 5250c25 (Story 9.1 committed, tree clean). Story 9.1 was NOT uncommitted
  as the story text assumed; the baseline is HEAD.
- Disclosed AC5-letter deviation: `CROSS_ISSUE_BLOCKED` is raised from the stock surface
  (`applyStockBalanceProjection`), which carries no audit machinery; a seam refusal aborts its
  transaction, so no audit row is written. The attempt is captured by the Story 1.3 statutory
  request middleware. The BSD-12 carve-out comment block in `src/compliance/stock-balance.ts`
  now covers this code; it is in no `AUDITED_REJECTIONS` set. The story-9-2 suite asserts
  the audit_log count for the code does not move.
- Code review 2026-09-03: AC5's literal prose ("when ANY allocation, reservation, issue, or
  pick names it ... rejected with `error_code: CROSS_ISSUE_BLOCKED`") is satisfied for
  `allocation` and `issue` by the stock-surface total bar, but `pick` and `reservation` never
  reach that bar at all: per Dev Notes decision 4 and Task 5.5, pick generation and transfer
  creation hard-filter to `stock_class = 'owned'` and so can never name `job_work` stock in
  the first place (they fail their own pre-existing errors - `INSUFFICIENT_STOCK_FOR_PICK`,
  no matching source row - never `CROSS_ISSUE_BLOCKED`). This was already the intended design
  at story creation (BSD-4, Task 5.1's "do NOT build a classifier"), not an implementation
  deviation; restated here because the AC's literal wording over-promises the exact code for
  those two demand kinds. Confirmed by the AC4 test (pick and transfer assertions) and the
  AC5 test (which asserts `CROSS_ISSUE_BLOCKED` only for allocation and issue).
- Disclosed deviation (FR-JW-03 tightening): a `stock.received` carrying
  `stock_class = 'job_work'` is accepted ONLY from the receiving hand-off. The receiving seam
  stamps its synthetic stock view with a module-private Symbol (`RECEIVING_HANDOFF`); a JSON
  body through `POST /api/v1/events` or the edge upload cannot carry a Symbol key, so a direct
  job_work `stock.received` refuses 409 `SOURCE_DOCUMENT_REQUIRED` even with a correct order
  binding. Mutation-verified (mutant 3).
- Deliberate fixture change: the Story 2.8 test "job_work receipts stay outside the
  ownership gate (Epic 9 flow untouched)" asserted that a direct job_work `stock.received`
  succeeds. Story 9.2 activates the class and AC7 reverses that outcome, so the test now
  asserts 409 `SOURCE_DOCUMENT_REQUIRED` and no balance row, while still proving the
  consignment agreement gate does not apply to job_work.
- Disclosed deviation (inverse gate): the custody applier verifies in-transaction that the
  `grn_line_id` it names exists, is `job_work` class, not rejected, and matches sku, lot,
  quantity and site. A direct `jobwork.material_received` through `/api/v1/events` with an
  invented or borrowed (owned) GRN line refuses 409 `SOURCE_DOCUMENT_REQUIRED` and cannot
  flip the order.
- Disclosed deviation (laundering-bar code): a lot-level class conflict that involves
  `job_work` on either side refuses `CROSS_ISSUE_BLOCKED` (details carry
  `existing_stock_class` and `demand_kind`); prototype-versus-owned conflicts keep
  `PROTOTYPE_NOT_SALEABLE`. The story named no code for this arm.
- Disclosed deviation (ownership mismatch code): a supplied `owner_party_code` that differs
  from the order's `customer_party_code` refuses 409 `OWNER_PARTY_MISMATCH` (the Story 2.8
  consignment code, reused rather than minted). When the clerk supplies none, the receiving
  seam derives it from the order and the gate re-verifies under lock.
- Disclosed deviation (receipt_id): the GRN route mints no ids for the nested event, so
  `receipt_id` is minted server-side in the receiving hand-off (a client-supplied UUID
  `receipt_id` on the GRN body is honoured). The nested event's idempotency key is the natural
  key `jobwork.material_received:{grn_line_id}`.
- Disclosed harness fact: `POST /api/v1/grn-lines` has never supported idempotent replay
  (the route forwards no idempotency key; a second identical post is a pre-existing
  `STREAM_CONFLICT`). Task 7.4 is therefore proven on the `jobwork.material_received` event
  through `/api/v1/events` with the stored key: 200 with the stored event id, one custody row,
  no second transition.
- Job-work receipts ride the unchanged Story 3.4 GRN flow, so each still needs a PO line for
  the sku and an accepted weighbridge token (the fixture seeds both per receipt).
- Mutation verification (story-9-2 suite, 18 tests, run per mutant, all restored): mutant 1
  order gate always open, killed by 2 tests (route and seam point); mutant 2 cross-issue bar
  removed, killed by 2 tests (route and seam point); mutant 3 receiving-handoff gate removed,
  killed by 1 test; mutant 4 `SEGREGATED_STOCK_CLASSES` without `job_work`, killed by 1 test.
- Schema-drift suite: 140/143 with 3 pre-existing failures (compliance_bis_licence and
  label_master index-body pins, gate_dwell_metric CRLF drift), identical at baseline.
- Migrate-twice against docker `ims-postgres-test` (port 5442): both runs complete.
- `graphify update .` run after the code changes and again after the code-review patches.
- Code review 2026-09-03 (Sonnet 5, three parallel layers - Blind Hunter, Edge Case Hunter,
  Acceptance Auditor - plus AC-level auditing against the spec): 4 patches applied (exact
  BigInt comparison replacing `Number()` coercion in the GRN-line cross-check, a documenting
  comment on the ownership gate's transactional site-check invariant, a genuine-concurrency
  test for the two-receipts race, the AC5 pick/reservation clarification above). 16 findings
  dismissed after reading the real code (validateEnvelope already guards payload shape;
  the CRLF mirror is byte-identical after normalization; downstream blindness is asserted by
  the AC4 test; remaining findings were pre-existing patterns or out of scope). Post-patch:
  story-9-2 suite 19/19, unit 25/25, schema-drift 140/143 (same 3 pre-existing), migrate
  twice clean.
- Full suite vs baseline 5250c25 (fresh worktree, same test DB, sequential): baseline
  1703 tests, 31 failures; current tree 1747 tests (44 new, all green), 33 failures. Of the
  2 failures not at baseline, one was the Story 2.8 job_work test deliberately flipped by
  this story (re-run: story-2-8 suite 23/24, the remaining failure is the pre-existing
  "agreement idempotency" case), and the other is `gate_dwell_metric` CRLF drift on an
  untouched working-tree file that a fresh checkout normalizes (known noise family). Net new
  failures: 0. Pre-existing floor: idempotency family (1.1, 1.6, 2.2, 2.3, 2.4, 2.8),
  2.5 x15, 1.7, 2.1, 3.10, 3.6, 5.3, schema-drift x2.

### Completion Notes List

- Site-admin knob: `JOBWORK_RECEIPT_TOLERANCE_PCT` (percent of challan quantity), default
  `0.5`, valid `0` to `10` inclusive with at most four decimals; absent takes the default,
  present-but-blank, non-numeric, negative or above 10 refuses boot. Flag when
  `abs(received_qty - challan_qty)` STRICTLY exceeds `challan_qty * pct / 100`; exactly at
  the band does not flag. Exact scaled-integer arithmetic (BigInt), no JS float.
- Event `jobwork.material_received` registered on the `jobwork` stream
  (`stream_id = service_order_id`, `requiresBusinessStream: false`), closed shape, strict
  UUIDs, calendar `challan_date`, strictly positive NUMERIC-string quantities;
  `variance_qty` and `variance_flagged` are server-derived, refused on input and written back
  onto the stored payload.
- Projection `jobwork_material_receipt` (canonical `read/projections/`, byte-identical
  mirror in `deploy/compose/init-db.sql` with that file's CRLF endings, tail-append in
  `migrate.ts`, in-file app_user grants INSERT, SELECT), unique `uq_jobwork_receipt_grn_line`,
  positive-quantity CHECKs, schema-drift pin added.
- Receiving: `applyGoodsReceivedProjection` job_work arm requires `service_order_id`,
  `challan_number_ext`, `challan_date`, `challan_qty` (409 `SOURCE_DOCUMENT_REQUIRED`),
  stamps the stock view for the hand-off gate, and nests the custody event via
  `persistEvent(envelope, undefined, client)` inside the same transaction after the GRN line
  insert (the bis-licence-expiry precedent). QC hold and custody compose: a
  quarantine-required item lands in ZONE-QC-HOLD with a held putaway AND the custody row.
- Custody applier: order advisory lock plus FOR UPDATE, refuses unless `confirmed` or
  `in_process` at the receipt site, verifies the GRN line, computes variance, inserts the row
  (23505 classified by constraint name into a 409 `DUPLICATE_EVENT` with the constraint in
  details), then fires `transitionServiceOrder(..., 'in_process')` on the first receipt only.
- Stock surface: total bar on `job_work` allocation and issue (400 `CROSS_ISSUE_BLOCKED`,
  details `{sku, stock_class, lot_id, location_id, demand_kind}`); new
  `SEGREGATED_STOCK_CLASSES` (`prototype`, `job_work`) widens the lot-level laundering bar in
  both directions; `NON_SALEABLE_STOCK_CLASSES` untouched. `cycle-count.ts` mirrored in
  lockstep (the count-adjustment inflow path refuses the same conflicts).
- Downstream consumers verified blind, not rebuilt: pick generation, transfer source query,
  cross-dock (`non_owned_stock` non-qualification asserted), planning and site availability
  all hard-filter `stock_class = 'owned'`; valuation reports job_work under
  `non_owned_quantities` with no carrying value; no `inventory_valuation` row is written.
- Read route `GET /api/v1/service-orders/:serviceOrderId/receipts` (module jobwork, read),
  404-versus-403 collapsed as in the 9.1 GET-by-id; mounted and added to the spine
  allowlist.
- Tests: `test/unit/jobwork-receipt-predicates.test.ts` (17),
  `test/unit/jobwork-receipt-config.test.ts` (8, child-process boot guard),
  `test/integration/story-9-2.test.ts` (18, all ACs, seam and route points, replay,
  cycle-count arm, quarantine arm).

### File List

- `src/compliance/jobwork-receipt.ts` (new)
- `src/read/projections/jobwork_material_receipt.ts` (new)
- `read/projections/jobwork_material_receipt.sql` (new)
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/config/index.ts`
- `src/compliance/receiving.ts`
- `src/compliance/stock-balance.ts`
- `src/compliance/cycle-count.ts`
- `src/api/v1/service-orders.ts`
- `src/server.ts`
- `test/integration/story-9-2.test.ts` (new)
- `test/unit/jobwork-receipt-predicates.test.ts` (new)
- `test/unit/jobwork-receipt-config.test.ts` (new)
- `test/integration/story-2-8.test.ts` (deliberate fixture change, see Debug Log)
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/9-2-customer-material-receipt-and-segregated-stock.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `graphify-out/` (regenerated by `graphify update .`)

## Change Log

- 2026-09-03: Story 9.2 implemented (Tasks 1 to 8), all tasks checked, status set to review.
  Full-suite result recorded in the Debug Log References noise-floor entry.
