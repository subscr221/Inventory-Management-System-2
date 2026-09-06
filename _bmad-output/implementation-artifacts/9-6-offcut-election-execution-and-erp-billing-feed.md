---
baseline_commit: 8ccd2e6651fd16bed3167b7d2219dc131a7631ba
---

# Story 9.6: Offcut Election Execution and ERP Billing Feed

Status: review

> **REVERSED AND REBUILT 2026-09-05** per `_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-05.md`
> (APPROVED). The offcut half of this story was reversed and rebuilt against the ruled model; the
> BILLING half stands, minus the `offcut_not_settled` precondition. Read the sprint change proposal
> and the Reversal Notes below before touching anything here. Acceptance criteria 1 to 3 as written
> below, Task 0's confirm-time rate mandate, binding decisions 14, 15 and 16, the PO ruling on open
> question 6, and the `OFFCUT_RATE_OUT_OF_BAND` guard added by the group-A code review are all
> superseded. Disposal and valuation are Story 9.7.

## Reversal Notes (2026-09-05)

What capture does now: it drains the custody ledger, mints a lot in the NEW `offcut` stock class and
writes an UNVALUED row to the new `job_work_offcut_holding` projection. It does not price the offcut,
convert it to own stock, raise a billing line, render documents, stamp a settlement or stop the
Section 143 clock. All of that is disposal, and disposal is Story 9.7.

Removed: the confirm-time `offcut_rate` mandate; the `offcut_not_settled` billing precondition; the
three-branch election switch; `offcutRateOutOfBand` with its `OFFCUT_RATE_OUT_OF_BAND` code and
`JOBWORK_OFFCUT_RATE_TOLERANCE_PCT` knob; the retain-and-buy lines on the billing feed.

Added: the `offcut` stock class (segregated and laundering-barred exactly like `job_work`);
`service_order.offcut_contract_ref_ext`; `job_work_offcut_holding` with `disposed_at`, `disposition`
and `disposal_event_id` forward-declared for Story 9.7.

Three decisions worth carrying forward:

1. The offcut lot is MINTED, never reused. The laundering bar is lot-ROW based, so receiving a second
   segregated class onto a lot that has ever held a `job_work` row is refused regardless of on_hand.
   `source_lot_id` on the holding row carries the genealogy back to the customer's lot.
2. `reconcileReturnClocks` is deliberately NOT called at capture, unlike every other custody drain in
   Epic 9. The material is still the customer's and the clock is still running; stopping it here
   would erase an open exposure. Story 9.7 stops it at disposal and must sweep the holding ledger.
3. Disposal-time fields are DROPPED by the route (its allowlist does not forward them) and REFUSED by
   the seam. The wall is at the seam, which is where it belongs; the test asserts both halves.

Gates: tsc, eslint and prettier clean; migrate twice idempotent; schema-drift 155/155 with the new
projection mirrored; unit 496/496; story-9-6 17/17; Epic 9 plus spine green; full suite 1891/1919
with all 28 failures documented noise and 0 new. `test/integration/story-9-1.test.ts` was updated
because it asserted the withdrawn confirm-time mandate - a done story's test changed by this
reversal, disclosed rather than quietly patched.


<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a job-work coordinator,
I want the captured offcut election executed with documents at dispatch or retention, and a measured billing feed delivered to ERP with acknowledgment and failure handling,
so that offcuts are settled per contract with the paperwork to prove it and every completed job is invoiced from measured quantities.

## Acceptance Criteria

1. **Given** an order with offcut election `return` (FR-JW-09/10), **when** offcuts are dispatched back to the customer, **then** a return challan and dispatch documents are generated through the Story 3.7 flows and the custody ledger is decremented by the returned quantity.
2. **Given** an order with offcut election `retain-and-buy` (FR-JW-09/10), **when** the retention is executed, **then** a billable line at the contracted rate is raised onto the ERP billing feed, and the custody ledger writes the offcut quantity out to own stock with an attributed conversion record.
3. **Given** an order with offcut election `retain free` (FR-JW-09/10), **when** the retention is executed, **then** a free-retention record is written and the custody ledger is adjusted to zero for the offcut quantity with an attributed adjustment referencing the contractual election.
4. **Given** a completed, dispatched job-work order (FR-JW-12), **when** billing is generated, **then** a measured billing feed (pieces, certified weight, or hours) carrying the order and challan references, measured basis and quantity, price basis, and any own-material (FR-JW-07) and retain-and-buy lines is sent to ERP with an `idempotency_key`, and the order is marked invoiced only on ERP acknowledgment.
5. **Given** a billing feed transmission that fails or is not acknowledged (FR-JW-12), **when** the configured retry window elapses, **then** the feed enters an exception queue with an alert through Story 1.11 to the job-work coordinator, retries never create duplicate billable events (replays rejected with `error_code: "DUPLICATE_EVENT"`), and unacknowledged feeds appear on a billing-reconciliation report.

## Tasks / Subtasks

- [x] Task 0 (prerequisite, Story 9.1 confirm payload): the contracted offcut rate lives on the ORDER (AC: 2)
  - [x] 0.1 Add `offcut_rate NUMERIC(18,4)` and `offcut_currency TEXT` to `read/projections/service_order.sql` via `ADD COLUMN IF NOT EXISTS`, mirror in `deploy/compose/init-db.sql`, extend `ServiceOrderRow`, the create insert and `updateServiceOrderFields` in `src/read/projections/service_order.ts`.
  - [x] 0.2 Accept both on `jobwork.service_order_created` and `jobwork.service_order_updated` (optional), and make them MANDATORY at confirm when `order.has_contractual_offcut` is true. The gate is a verbatim copy of the `offcut_election` confirm gate at `src/compliance/service-order.ts:605-637`, including its mirror refusal: an order WITHOUT a contractual offcut arrangement that carries a rate is refused, exactly as it is refused for carrying an election.
  - [x] 0.3 `offcut_currency` must equal `order.price_basis.currency` when a price basis is present. Rate is a positive exact decimal STRING at the event boundary; never a number literal.
  - [x] 0.4 Extend the Story 9.1 field lists in `src/api/v1/service-orders.ts:191-220` and `:280` so the two fields reach the seam, and update the story-9-1 confirm arms.
  - [x] 0.5 This is a genuine Story 9.1 contract change, not 9.6 scope creep: without it AC2's "contracted rate" has no source, and a rate typed at settlement by the person who benefits from it is an unbounded number on an invoice line (see Binding decision 16, superseded on the approval mechanism but not on the rate's home). Same shape as Story 9.5's Task 0, which fixed a Story 9.4 index defect the current story depended on.

- [x] Task 1: `custody.offcut_recorded` event contract (AC: 1, 2, 3)
  - [x] 1.1 Add `CUSTODY_OFFCUT_RECORDED = 'custody.offcut_recorded'` beside the four existing constants in `src/compliance/custody-ledger.ts:50-58`.
  - [x] 1.2 Add `CustodyOffcutRecordedPayload` to `src/events/schema.ts` beside `CustodyReturnRecordedPayload`. Caller fields: `service_order_id`, `offcut_id`, `sku`, `lot_id`, `location_id`, `quantity`, `uom`, `site_id`, `posted_by`, `return_challan_number_ext` (required only on the `return` branch), `offcut_rate_estimate` (optional, `retain_and_buy` only, the real-time settlement rate per the 2026-09-05 PO ruling that superseded Binding decision 16 - no `approved_by`, no DOA chain; bounded against `order.offcut_rate` by the code-review band, see the Review Findings), and `settles_offcut` (boolean, the caller's declaration that this posting closes the contractual offcut, see Binding decision 15). Server-derived: `election`, `custody_balance_after`, `converted_lot_id`, `converted_lot_number`, `billable_value`.
  - [x] 1.3 Add `assertCustodyOffcutShape` modelled line for line on `assertCustodyReturnShape` (`custody-ledger.ts:411`). `quantity` strictly positive; `offcut_rate_estimate` a positive exact decimal STRING (never a number literal, the `receiptTolerancePercent` convention); `election` and every other derived field refused if the caller supplies it.
  - [x] 1.4 Register the type in `src/events/store.ts` beside the `applyCustodyReturnProjection` call so the new applier runs in the same transaction chain.

- [x] Task 2: the offcut applier, three branches over one shared drain (AC: 1, 2, 3)
  - [x] 2.1 `applyCustodyOffcutProjection` lives in `src/compliance/jobwork-offcut.ts`, NOT in `custody-ledger.ts` (already 1307 lines and carrying four appliers). Copy the body of `applyCustodyReturnProjection` (`custody-ledger.ts:1137-1307`) rather than inventing a new shape: `requireInProcessOrder(..., orderAcceptsCustodyReturn)`, the lot-received-under-this-order gate (`CROSS_ISSUE_BLOCKED`), the ledger-uom gate (`INVALID_PARAMS`), the `custodyBalanceCovers` gate (`INSUFFICIENT_STOCK`). Export `CUSTODY_OFFCUT_RECORDED` from `custody-ledger.ts` so the constants stay in one place and import it here.
  - [x] 2.2 Re-read `order.offcut_election` under the order advisory lock and branch on it. Refuse `OFFCUT_ELECTION_MISSING` (409) when `order.has_contractual_offcut` is false or `order.offcut_election` is null. The caller never names the branch.
  - [x] 2.3 Shared drain, all three branches: the synthetic `stock.issued` view stamped with the EXISTING `CUSTODY_RETURN` Symbol (`custody-ledger.ts:84`), then `insertCustodyLedgerEntry` with `movement_category: 'offcut'`, `ownership: 'customer'`, `quantity_delta` negative, then `appendCustodyTrace`, then `reconcileReturnClocks({ counter: 'reconciled_qty', category: 'offcut', strict: false })`.
  - [x] 2.4 Branch `return`: `reference_ext = return_challan_number_ext` (mandatory on this branch), `billable = false`. `offcut_rate_estimate` on this branch is refused `INVALID_PARAMS`: nothing is being bought. No stock re-entry, the goods leave.
  - [x] 2.5 Branch `retain_and_buy`: the rate is `order.offcut_rate`, read under the order lock (Task 0), NOT a caller field. SUPERSEDED 2026-09-05 by the PO ruling on open question 6: a posting may carry `offcut_rate_estimate`, which IS the settlement rate, with no `approved_by` and no DOA chain; when none is supplied the contracted rate is the effective rate, and the contracted rate is stamped beside the effective rate either way. The 2026-09-05 code review added the only gate the estimate has: it must sit within `config.jobwork.offcutRateTolerancePct` of `order.offcut_rate` or the posting is refused `OFFCUT_RATE_OUT_OF_BAND` (409, audited). After the drain, mint a NEW owned lot through `createLot` and post an ordinary owned `stock.received` for it, copying `src/compliance/jobwork-output.ts:230-290` verbatim in shape. Ledger row `billable = true`, `reference_ext = order.order_number_ext`. Derive `billable_value = quantity * effective_rate` through the scaled-integer helpers and stamp it, the effective rate, `converted_lot_id` and `converted_lot_number` onto the stored payload.
  - [x] 2.5a The minted owned lot carries a QC HOLD task on creation, reusing the Story 9.4 hold-task path. The material was inspected at 9.2 receipt against the CUSTOMER's specification as the CUSTOMER's material; it has never been inspected as our raw stock, and `owned` class is allocatable to any demand the moment it exists. Without the hold, customer offcut can be issued into a production order with no incoming record. There is no `scrap` stock class to receive into (`VALID_STOCK_CLASSES` is owned, consignment, vmi, job_work, prototype) and this story does not add one.
  - [x] 2.6 Branch `retain_free`: identical conversion to 2.5, including the QC hold of 2.5a, with `billable = false` and any `offcut_rate_estimate` refused `INVALID_PARAMS`. The ledger row IS the free-retention record; `reference_ext` cites the election (`offcut_election:retain_free`).
  - [x] 2.7 When `settles_offcut` is true, stamp `offcut_settled_at` and `offcut_settled_by` on `service_order` in the same transaction (Binding decision 15). A posting against an order already carrying `offcut_settled_at` is refused `OFFCUT_ELECTION_MISSING` with `details.already_settled_at`: the contractual offcut is closed and no further offcut may be posted against it.
  - [x] 2.8 Header comment stating the lock order (order advisory lock, order row FOR UPDATE, ledger and clock rows last), the repo convention since Story 7.4, and stating that the customer lot and the minted owned lot are joined in `lot_trace` ONLY by their shared `event_id` (`read/projections/lot_trace.sql` has no parent column). Any genealogy or recall query crossing the ownership change must go through `event_id`.

- [x] Task 3: offcut documents (AC: 1)
  - [x] 3.1 `renderOffcutDocuments` in `src/compliance/jobwork-offcut.ts` beside the Task 2 applier, modelled on `renderJobWorkDispatchDocuments` (`src/compliance/jobwork-dispatch.ts:232-265`).
  - [x] 3.2 Write rows into the generic `dispatch_document` table keyed by `service_order_id`, using ONLY the four document types its CHECK constraint allows (`read/projections/dispatch_document.sql:21`): the return challan renders as `commercial_invoice` (the exact 9.4 precedent, titled `JOB-WORK OFFCUT RETURN CHALLAN`), plus `bol`, `packing_slip` and `label`.
  - [x] 3.3 Documents render on the `return` branch only. Retention keeps the goods on site, so no dispatch paperwork exists to raise.

- [x] Task 4: `job_work_billing_feed` projection (AC: 4, 5)
  - [x] 4.1 New `read/projections/job_work_billing_feed.sql` plus the CRLF mirror in `deploy/compose/init-db.sql` and the entry in `src/events/migrate.ts`. Columns: `feed_id` PK, `service_order_id`, `idempotency_key`, `payload` JSONB, `measured_basis`, `measured_quantity`, `currency`, `total_value`, `status`, `open_to_dispatch_qty`, `first_sent_at`, `acknowledged_at`, `acknowledged_by`, `acknowledged_ref_ext`, `exception_raised_at`, `alert_sent_at`, `site_id`, `generated_by`, `source_event_id`, `created_at`, `updated_at`. There is deliberately NO `attempt_count` or `last_attempt_at`: no transmitter exists in this codebase, so nothing would ever write them and a reader would take an always-zero counter for a real retry count.
  - [x] 4.2 `CONSTRAINT chk_job_work_billing_feed_status CHECK (status IN ('pending','acknowledged','exception'))`. `CREATE UNIQUE INDEX uq_job_work_billing_feed_order ON job_work_billing_feed (service_order_id)` (one feed per order, the AC5 no-duplicate-billable-events rule expressed in the schema). `CREATE UNIQUE INDEX uq_job_work_billing_feed_source_event ON job_work_billing_feed (source_event_id)`.
  - [x] 4.3 Guarded `DO` grant blocks: `app_user` gets INSERT, SELECT, UPDATE; `readonly_user` gets SELECT. Every statement idempotent.
  - [x] 4.4 `src/read/projections/job_work_billing_feed.ts` accessors: `insertBillingFeed`, `getBillingFeedById`, `getBillingFeedByOrder`, `listBillingFeedsDueForSweep`, `markBillingFeedAcknowledged`, `markBillingFeedException`, `listUnacknowledgedBillingFeeds`.
  - [x] 4.5 Add the table to the pinned list in `test/unit/schema-drift.test.ts`.

- [x] Task 5: billing feed generation (AC: 4)
  - [x] 5.1 `buildJobWorkBillingFeedPayload` in a new `src/adapters/erp/job-work-billing-feed.ts`, following the `msme-ageing-feed.ts` module shape and header disclosure exactly. Payload carries `feed_type: 'job_work_billing'`, order reference (`service_order_id`, `order_number_ext`, `customer_party_code`), the challan references (every `challan_number_ext` and `challan_date` from `jobwork_material_receipt` for the order), `price_basis`, `measured_basis`, `measured_quantity`, the dispatch lines, the own-material lines, the retain-and-buy lines, `total_value`, `idempotency_key`, `generated_at`, `correlation_id`.
  - [x] 5.2 Own-material lines read from `custody_ledger_entry WHERE ownership = 'processor' AND billable = true` for the order (the Story 9.3 FR-JW-07 shape). Retain-and-buy lines read from `custody_ledger_entry WHERE movement_category = 'offcut' AND billable = true`; the rate and value each of those events DERIVED are read back from the stored `custody.offcut_recorded` payload (`effective_offcut_rate`, `contracted_offcut_rate`, `billable_value`), NOT from the ledger row - `custody_ledger_entry` is a general custody quantity ledger shared by Stories 9.3 to 9.5 and carries no money columns, and denormalising them into it would create a second figure that can disagree with the event after a replay. Corrected 2026-09-05 by code review; the payloads are fetched in ONE `= ANY($1)` query, never one round trip per row.
  - [x] 5.3 Measured basis derives from `service_order.price_basis.basis_type` (`src/read/projections/service_order.ts:4-8`): `per_piece` and `per_kg` sum `job_work_dispatch.dispatched_quantity` for the order; `lumpsum` uses quantity `1`; `per_hour` requires a caller-supplied `measured_hours` and is refused `INVALID_PARAMS` without one (see Binding decision 12).
  - [x] 5.4 `jobwork.billing_feed_generated` event and `applyJobWorkBillingFeedGenerated` in a new `src/compliance/jobwork-billing.ts`. TWO preconditions, both re-derived under the order advisory lock, both refusing `BILLING_NOT_READY` (409) with a `details.reason` naming which one failed: (a) the order has at least one `job_work_dispatch` row, which is AC4's literal "completed, dispatched"; (b) when `order.has_contractual_offcut` is true, `order.offcut_settled_at` is not null (Binding decision 15). There is deliberately NO "every output row fully dispatched" gate: see Binding decision 18. A second generation for an order already carrying a feed collides on `uq_job_work_billing_feed_order` and is classified 409 `DUPLICATE_EVENT` through the existing `classifyDuplicate` idiom (`custody-ledger.ts:440`).
  - [x] 5.4a The feed payload and the `job_work_billing_feed` row carry `open_to_dispatch_qty`, the summed `quantity - dispatched_quantity` across the order's `job_work_output` rows at generation time. Non-zero is a reporting fact, not a refusal, and the reconciliation report of Task 8.3 surfaces it.
  - [x] 5.5 All money and quantity arithmetic through the scaled-integer helpers in `src/compliance/custody-statement.ts:20-59`. Never `Number()` on a NUMERIC string.

- [x] Task 6: acknowledgment and the invoiced stamp (AC: 4)
  - [x] 6.1 `jobwork.billing_feed_acknowledged` event plus `applyJobWorkBillingFeedAcknowledged`. Payload: `feed_id`, `service_order_id`, `acknowledged_ref_ext` (the ERP document number, mandatory), `acknowledged_by`.
  - [x] 6.2 The applier flips `status` to `acknowledged`, sets `acknowledged_at`, `acknowledged_by` and `acknowledged_ref_ext`, and stamps the order invoiced. An acknowledgment for a feed already `acknowledged` is a 409 `DUPLICATE_EVENT`.
  - [x] 6.3 SEGREGATION OF DUTIES (Binding decision 17). The applier refuses `SOD_VIOLATION` (409, the EXISTING code from `src/api/v1/quality.ts:270`, no new code needed) when the acknowledging actor equals `job_work_billing_feed.generated_by`. Without this arm the coordinator who generated the feed can acknowledge it with an invented `acknowledged_ref_ext`, stamp the order invoiced, and take it off the reconciliation report and out of the sweep's reach, all without the feed ever reaching an accounting system. Modelled on the 9.4 acting-user check (`custody-ledger.ts:1015-1045`), which is the same defect shape.
  - [x] 6.4 Add `invoiced_at TIMESTAMPTZ`, `invoiced_feed_id UUID`, `offcut_settled_at TIMESTAMPTZ` and `offcut_settled_by UUID` to `read/projections/service_order.sql` via `ADD COLUMN IF NOT EXISTS` (the `custody_ledger_entry.reference_ext` upgrade-path precedent), mirror in `deploy/compose/init-db.sql`, extend `ServiceOrderRow` and the update accessor in `src/read/projections/service_order.ts`. Do NOT add a status value (see Binding decision 9).

- [x] Task 7: retry window, exception queue and alert (AC: 5)
  - [x] 7.1 Config knobs in the `jobwork:` block of `src/config/index.ts:657`, following the `parsePositiveIntEnv` sweep-knob pattern at `:640-651`: `billingRetryWindowMs` (`JOBWORK_BILLING_RETRY_WINDOW_MS`, default 24 hours, disclosed placeholder), `billingSweepIntervalMs`, `billingSweepBatchSize`.
  - [x] 7.2 `runJobWorkBillingFeedSweepCycle` in a new `src/notify/jobwork-billing-sweep.ts`, cloned from `src/notify/jobwork-clock-sweep.ts`: `pg_try_advisory_xact_lock(9506)` (a DISTINCT key from the clock sweep's 9505), per-row SAVEPOINT, bounded batch, `SYSTEM_ACTOR` fixed identity, the `{ alerted, exceptions, failed, cycleFailed, skippedLocked, skippedRaced }` result shape.
  - [x] 7.3 A `pending` feed whose `first_sent_at` is older than `billingRetryWindowMs` flips to `exception`, sets `exception_raised_at`, and emits one notification through `emitNotificationInTransaction` to `jobwork_coordinator` (the codebase spelling, never `job_work_coordinator`) with an `escalation` definition so the existing Story 1.11 `runEscalationCycle` machinery carries the next tier. `alert_sent_at` makes re-alerting the same feed on the next tick impossible.
  - [x] 7.4 Register the 7th background cycle `'jobwork billing feed retry'` in `backgroundCycles()` (`src/server.ts:1231-1290`) and add the 7th entry to the pinned list in `test/unit/background-cycles.test.ts` or that test fails.

- [x] Task 8: routes (AC: 1, 2, 3, 4, 5)
  - [x] 8.1 `POST /api/v1/service-orders/:serviceOrderId/offcuts` through the EXISTING `postCustodyEvent` helper (`src/api/v1/service-orders.ts:570`) with `eventType: CUSTODY_OFFCUT_RECORDED`, `idField: 'offcut_id'`, `extraFields: ['return_challan_number_ext','offcut_rate_estimate','settles_offcut']`, `derivedFields: ['election','custody_balance_after','converted_lot_id','converted_lot_number','billable_value','effective_offcut_rate']`. Widen the helper's `idField` union at `:576` to include `'offcut_id'`; that one-word change is the only edit the helper needs. Do not write a bespoke handler.
  - [x] 8.2 `POST /api/v1/service-orders/:serviceOrderId/billing-feed` (generate) and `POST /api/v1/jobwork/billing-feeds/:feedId/acknowledgment`, both with `requireIdempotencyKey`, `rejectUnacceptedFields`, closed-shape payloads and the `readableOrderOr404` 404-versus-403 collapse, matching the 9.5 closure route (`:889-1010`).
  - [x] 8.3 `GET /api/v1/jobwork/reports/billing-reconciliation` listing every feed not in `acknowledged` status with its age in the retry window, its exception flag, and its `open_to_dispatch_qty` (a feed billed while output is still open to dispatch is a reporting exception, never a blocked write). Projection-only read, jobwork read RBAC with site scoping, copying `getJobworkAgingReportBase` (`:1230`).
  - [x] 8.4 Register in `src/server.ts` with the static `/jobwork/...` segments BEFORE every parameterised `/service-orders/:serviceOrderId/...` route (`server.ts:1046-1055`), or the report path is swallowed as a `:serviceOrderId` segment.
  - [x] 8.5 Add all four routes to the spine allowlist in `test/integration/story-1-9.test.ts:536-558` or the Story 1.9 CI gate fails.

- [x] Task 9: stable error codes (AC: 1, 4, 5)
  - [x] 9.1 `OFFCUT_ELECTION_MISSING` and `BILLING_NOT_READY` registered in all three places the 9.4/9.5 precedent uses: `AUDITED_REJECTIONS` in `src/api/v1/service-orders.ts:63-71`, `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`, and `edge/src/messages/en.json`.
  - [x] 9.2 `SOD_VIOLATION` already exists (`src/api/v1/quality.ts:270`); do NOT mint a new code for it. Add it to this file's `AUDITED_REJECTIONS` set so a refused self-acknowledgment leaves an audit row, and verify it is already present in `upload.ts` and `en.json` before adding it twice.

- [x] Task 10: tests (AC: 1, 2, 3, 4, 5)
  - [x] 10.1 `test/integration/story-9-6.test.ts`, serial, run-scoped random suffix, local fixture closures, SCIM plus dev-token actors, admin pool for seeding.
  - [x] 10.2 One arm per AC branch: offcut `return` decrements custody and writes four `dispatch_document` rows; `retain_and_buy` drains custody, mints an owned lot, and produces a billable ledger row carrying `billable_value = quantity * offcut_rate`; `retain_free` drains custody with `billable = false`; an offcut on an order with `has_contractual_offcut = false` refuses `OFFCUT_ELECTION_MISSING`; confirming an order with `has_contractual_offcut = true` and no `offcut_rate` refuses at the Task 0 confirm gate; a `retain_and_buy` posting bills at `order.offcut_rate`; an `offcut_rate_estimate` inside the governed band IS the settlement rate and one outside it refuses `OFFCUT_RATE_OUT_OF_BAND` (audited); a `return` or `retain_free` posting that CARRIES an estimate refuses `INVALID_PARAMS`; the minted owned lot carries a QC hold and is not allocatable; a second offcut posting after `settles_offcut: true` refuses `OFFCUT_ELECTION_MISSING` with `already_settled_at`.
  - [x] 10.3 Billing: generation with zero dispatches refuses `BILLING_NOT_READY`; generation with one dispatch and output still open SUCCEEDS and records a non-zero `open_to_dispatch_qty` on the feed and the reconciliation report (the Binding decision 18 arm: it must not refuse); generation on an order with `has_contractual_offcut = true` and no `offcut_settled_at` refuses `BILLING_NOT_READY` with the offcut reason, and succeeds once the settling posting lands (the Binding decision 15 arm, and the one that proves the line is not lost); a second generation refuses `DUPLICATE_EVENT`; the feed payload carries own-material and retain-and-buy lines; acknowledgment by a SECOND actor stamps `invoiced_at`; acknowledgment by the generating actor refuses `SOD_VIOLATION`; a second acknowledgment refuses `DUPLICATE_EVENT`.
  - [x] 10.4 Sweep: call `runJobWorkBillingFeedSweepCycle` directly (never a live timer, the `retention-expiry.ts` convention) against an artificially backdated `first_sent_at`; assert the exception flip, the notification, and that a second tick is a no-op.
  - [x] 10.5 Direct-event bypass arms: `POST /api/v1/events` for `custody.offcut_recorded` and `jobwork.billing_feed_generated` must hit the identical gates as the routes.
  - [x] 10.6 Mutation-verify two-point (the 9.3/9.4/9.5 standard) on THREE gates: the `OFFCUT_ELECTION_MISSING` branch, the `BILLING_NOT_READY` offcut-settled leg specifically (not the dispatch leg), the `SOD_VIOLATION` self-acknowledgment check, and the Task 0 confirm-time rate gate. Each disabled mutant must fail its route arm AND its direct-event arm.
  - [x] 10.7 `test/unit/jobwork-billing-predicates.test.ts` for the measured-basis resolution, the retry-window boundary, and the scaled-integer total.
  - [x] 10.8 Regression: story-9-1 through story-9-5, story-1-9, story-3-7. Story 9.1's confirm arms change in Task 0 and MUST be updated, not worked around.

- [x] Task 11: gates
  - [x] 11.1 `tsc`, `eslint`, `prettier --check` on changed files.
  - [x] 11.2 `npm run db:migrate` twice, both runs exit 0.
  - [x] 11.3 Full suite against the documented noise floor; report new failures by name or state zero.
  - [x] 11.4 `graphify update .`, then update `sprint-status.yaml`.

### Review Findings

Code review 2026-09-05, group A of 4 (schema, DDL, event contract, config). Three adversarial
layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) over `deploy/compose/init-db.sql`,
`read/projections/service_order.sql`, `read/projections/job_work_billing_feed.sql`,
`src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `src/config/index.ts`,
`test/unit/schema-drift.test.ts`. Groups B (compliance appliers), C (read, API, sweep, ERP adapter)
and D (tests) are not yet reviewed.

The four decision items were ruled on 2026-09-05 by a party-mode round table (Vex, Grumbal,
Boundary, Yui, Dana) working from the code rather than the spec. Their rulings are folded in below,
and one of them opened a new HIGH finding that no review layer had raised.

- [x] [Review][Decision][HIGH] RESOLVED 2026-09-05 (both fixes applied: band plus SoD bar). `offcut_rate_estimate` is never compared to `order.offcut_rate`, and the rate-setter sits outside the SoD chain - the estimate is validated only as positive, at most 4 decimals and at most 14 integer digits (src/compliance/custody-ledger.ts:514); `jobwork-offcut.ts:268` stamps the contracted rate beside it and no code ever reads the pair. One actor can price retained scrap at `0.0001` or at 10^14, flow it through `billableValueOf` (jobwork-offcut.ts:342) into `total_value`, and stamp `settles_offcut` in the same posting (jobwork-offcut.ts:552), which is the sole billing gate. `acknowledgmentViolatesSod` (jobwork-billing.ts:128) compares only the generator to the acknowledger and never looks at who set the rate. Two candidate fixes, needs a ruling: (a) bound the deviation against `order.offcut_rate` with a configured tolerance, refusing beyond it, or (b) bar anyone who posted an offcut settlement on the order from acknowledging its feed. Not mutually exclusive.
- [x] [Review][Patch] Document the feed lifecycle rescue path and the non-rebuildable warning in the SQL header [read/projections/job_work_billing_feed.sql:1] - RULING on the one-row-per-order decision: accept the unconditional `uq_job_work_billing_feed_order`, add no `voided_at`. `exception` is not terminal: the acknowledgment guard is `status <> 'acknowledged'` (src/read/projections/job_work_billing_feed.ts:168), so a late ERP acknowledgment still rescues a swept feed, and that is the correction path. A void-and-regenerate path would mint a second billable line after ERP had already ingested the first, with no void approver in the SoD chain and a dangling `invoiced_feed_id`; corrections belong in ERP as credit notes. Separately, `alreadyPersisted()` (src/compliance/jobwork-billing.ts:222) returns true for any event already in `domain_events`, so a truncate-and-replay rebuilds ZERO feed rows and the payload would be re-derived from live projections rather than the stored derived values - the table is NOT rebuildable and the header must say so, on the Story 8.4 retention precedent.
- [x] [Review][Patch] Correct Task 5.2 and batch the per-row event lookup [_bmad-output/implementation-artifacts/9-6-offcut-election-execution-and-erp-billing-feed.md] - RULING: the `domain_events` join is correct and the task text is wrong. `custody_ledger_entry` is a general custody quantity ledger shared by Stories 9.3, 9.4 and 9.5; adding two job-work-billing money columns to it for one caller is pollution, and denormalising a money value into a projection is how two numbers come to disagree after a replay. Reading the derived values back out of the stored payload is the codebase's own idiom (src/compliance/master-data.ts:344, src/compliance/quality.ts:3077). Rewrite Task 5.2 to say the lines read the `custody.offcut_recorded` payload, and batch the per-row `SELECT payload FROM domain_events` at src/compliance/jobwork-billing.ts:388 with `= ANY($1)` - it currently fires once per offcut row inside the write transaction.
- [x] [Review][Patch] Add a plain (non-unique) index on `acknowledged_ref_ext` [read/projections/job_work_billing_feed.sql:38] - RULING: no unique index. The cited precedents are the wrong class: `uq_po_number_ext`, `uq_indent_number_ext` and `uq_service_order_number_site` are uniqueness on the document a row IS, while every column citing an external document a row REFERENCES is plainly indexed and never unique (asn.sql:25, gate_event.sql:64, grn.sql:40, weighbridge_event.sql:74), including `custody_ledger_entry.reference_ext`, the mandatory GST return challan. One ERP invoice covering several job-work orders is ordinary consolidated billing, and a unique index would turn it into a 409. Uniqueness would also catch only byte-exact repeats: jobwork-billing.ts:200 trims but never case-folds, so `INV-1` and `inv-1` pass it anyway. Duplicates cost detection only, so pair the plain index with a duplicate-ref count on the reconciliation report (group C follow-up).
- [x] [Review][Patch] Rewrite the spec body to match the shipped offcut-rate contract [_bmad-output/implementation-artifacts/9-6-offcut-election-execution-and-erp-billing-feed.md] - RULING: the doc is the defect. Tasks 1.2, 1.3, 2.5, 2.6, 8.1 and 10.2 are checked off describing `offcut_rate_override`, `approved_by`, `APPROVAL_REQUIRED` and BSD-16 as binding, and none of those symbols exists anywhere in the binary; the code ships `offcut_rate_estimate` per the 2026-09-05 PO ruling on open question 6. Four checked-off tasks claiming work that was never written is a false traceability record in a system that runs `resolveApprover` DOA chains for warranty overrides and over-norm loss. Strike or supersede BSD-16, correct the task text, and keep the PO ruling cited. This is separate from the HIGH item above: rewriting the doc does not close the unbounded-rate hole.
- [x] [Review][Patch] Register the three new event types in `SUPPORTED_EVENT_TYPES` [src/events/schema.ts:5727] - `custody.offcut_recorded` (streamType `custody`), `jobwork.billing_feed_generated` and `jobwork.billing_feed_acknowledged` (streamType `jobwork`), all `requiresBusinessStream: false`. Every prior Epic 9 event has an entry; the consumer at src/compliance/business-stream.ts:66 fails open, so the omission is behaviourally benign today and completely invisible, and the stream split asserted in the store.ts comment exists nowhere machine-readable.
- [x] [Review][Patch] Pin the six `service_order` additive columns in the drift test [test/unit/schema-drift.test.ts:1855] - the generic loop compares only `CREATE TABLE` bodies, so `offcut_rate`, `offcut_currency`, `invoiced_at`, `invoiced_feed_id`, `offcut_settled_at` and `offcut_settled_by` are pinned by nothing. The Story 9.5 block two lines up exists for exactly this silent-mirror class; add the matching per-story assertion.
- [x] [Review][Patch] `indexBodies` pins the AC5 uniqueness index name-only [test/unit/schema-drift.test.ts:1816] - the assertion is a substring `includes` of `'ON job_work_billing_feed (service_order_id)'`, which stays green if `UNIQUE` is dropped. The comment at :1804 calls that index the AC5 no-duplicate rule expressed in the schema, and :1167 documents the full-body rule verbatim for `uq_production_order_source_rework_event`. Pin the whole `CREATE UNIQUE INDEX IF NOT EXISTS ...` statement for all three indexes.
- [x] [Review][Patch] No non-negative CHECK on the feed money and quantity columns [read/projections/job_work_billing_feed.sql:30] - `measured_quantity`, `total_value` and `open_to_dispatch_qty` accept negatives and zero. Every sibling Epic 9 projection constrains these (`chk_job_work_output_quantity_positive`, `chk_jobwork_return_clock_counters`, `chk_job_work_dispatch_qty_positive`), so a sign error in the offcut or service arithmetic reaches ERP unchallenged.
- [x] [Review][Patch] No lifecycle pairing CHECK on the feed [read/projections/job_work_billing_feed.sql:33] - `status = 'acknowledged'` with all three acknowledgment columns NULL, and `status = 'exception'` with `exception_raised_at` NULL, are both legal rows. House style enforces this class in the database (`chk_cross_dock_task_completion_fields`, `chk_production_order_short_close_pairing`). The writers happen to be guarded UPDATEs that set both, so this is defence in depth, not a live bug.
- [x] [Review][Patch] No pairing CHECK on the four new `service_order` state columns [read/projections/service_order.sql:68] - the comment calls `invoiced_at`/`invoiced_feed_id` and `offcut_settled_at`/`offcut_settled_by` column pairs and makes settlement a precondition for billing generation, but half a pair is writable, and `chk_service_order_offcut_election` two lines up shows the house style.
- [x] [Review][Patch] `offcut_rate` and `offcut_currency` are enforced only at the confirm seam [read/projections/service_order.sql:61] - no positive-rate CHECK, no paired-nullability CHECK, no relation to `price_basis`. The schema comment asserts the pair "travels together" and that the rate is mandatory whenever `has_contractual_offcut` is true; the guarded `ADD COLUMN` also backfills every already-confirmed pre-9.6 order that has `has_contractual_offcut = true` with a NULL rate.
- [x] [Review][Patch] Guarded constraint blocks use add-if-absent instead of drop-then-add [read/projections/job_work_billing_feed.sql:54] - `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)` means a future fourth `status` or fifth `measured_basis` value silently skips every already-migrated database while the file claims otherwise. `read/projections/bom_line.sql` fixed this class with `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, pinned at test/unit/schema-drift.test.ts:2114.
- [x] [Review][Patch] `site_id` on the feed table is indexed nowhere [read/projections/job_work_billing_feed.sql:41] - the AC4 reconciliation report and the coordinator alert are both site-scoped reads and will sequentially scan. `service_order` carries `idx_service_order_site`, as does essentially every site-scoped projection.
- [x] [Review][Patch] Two stale header comments [deploy/compose/init-db.sql:12626] - the mirrored copy reproduces "This file is the CANONICAL definition" verbatim inside `init-db.sql`, stating the opposite of the truth about the file it sits in; and `read/projections/service_order.sql:1` still says `offcut_election` has "no behavior attached in 9.1" while 9.6 attaches settlement and billing to it.
- [x] [Review][Defer] `parsePositiveIntEnv` bounds only the upper end, so `JOBWORK_BILLING_RETRY_WINDOW_MS=1` and `JOBWORK_BILLING_SWEEP_INTERVAL_MS=1` are accepted [src/config/index.ts:68] - deferred, pre-existing helper shared by every knob in the codebase.
- [x] [Review][Defer] `measured_hours` is the only input to the per-hour money calculation with no column anywhere [src/events/schema.ts:4724] - deferred, the attempt and hour columns were dropped deliberately; the AC4 reconciliation report cannot join on it and must dig into `domain_events`.
- [x] [Review][Defer] `currency` on both tables is unvalidated free text [read/projections/job_work_billing_feed.sql:31] - deferred, pre-existing; no currency column in the repo carries a vocabulary CHECK, and `'INR'` and `'inr'` are distinct to every consumer.
- [x] [Review][Defer] `JobworkBillingFeedAcknowledgedPayload` carries no `site_id` [src/events/schema.ts:4745] - deferred, the applier re-derives site from the feed row; every other job-work and custody payload declares one, so no shape assertion on site is possible for this privileged inbound command.
- [x] [Review][Defer] The two halves of the offcut event contract sit in different modules [src/events/store.ts:248] - deferred, `assertCustodyOffcutShape` is imported from `custody-ledger.js` and `applyCustodyOffcutProjection` from `jobwork-offcut.js`; every sibling pairs them, but the split follows the spec's own instruction to move the applier out of the 1307-line file.

Thirteen further findings were dismissed after reading the code: the optional-payload versus
`NOT NULL` column family (the derived fields are refused from callers and computed by the applier,
and `idempotency_key` falls back through `envelope.idempotency_key` to `event_id`); the missing
`price_basis` case (already a `BILLING_NOT_READY` refusal with reason `price_basis_missing`); blank
`acknowledged_ref_ext` (rejected by `assertJobworkBillingShape`); `updated_at` never advancing (both
UPDATEs set it); status flipping backwards (both UPDATEs are state-guarded); the twice-declared
inline and DO-block constraints, `CREATE TABLE IF NOT EXISTS` not reconciling a drifted table, and
the un-`NOT VALID` guarded constraint adds (all universal repo patterns); and the
`NUMERIC(18,3)`/`NUMERIC(18,4)` precision choices (disclosed deviation 3).

### Review Findings, group B (seams), 2026-09-06 - CLOSED 2026-09-06

Three adversarial layers over the seam layer, covering the BILLING half (only ever reviewed at the
schema layer) and the offcut CAPTURE half (rewritten by the 2026-09-05 reversal and never reviewed).
57 raw findings. A party-mode round table then ordered the work, and a security probe run against the
live system turned one finding into something larger than Story 9.6.

ALL FIVE HIGH ARE FIXED, plus 18 patches. Two decisions and six deferrals remain open, listed at the
end. Suite green throughout.

**The security finding, which was not 9.6-local.** My original text scoped a missing site check to
the acknowledgment applier. Wrong scope, and the mechanism was wrong in both review agents' accounts
too - one claimed the events route had no location resolver, the other claimed the generation path
was already protected. Neither was right, and it was only settled by RUNNING the attack: a writer
granted solely at site B captured site A's customer offcut AND acknowledged site A's billing feed
with a fabricated ERP reference, both 201. The real mechanism: RBAC authorises the events route
against `metadata.actor.location_id` and the attacker states their OWN honest location, which their
grant satisfies; `postEventBase` then overwrites the actor from the authorising assignment, so the
stored event is truthful and nothing is spoofed; and the appliers compare PAYLOAD site to ROW site,
both the target's, so that comparison agrees with itself and never involves the actor. Nothing
compared the RESOURCE's site to the actor's AUTHORISED location. Fixed centrally in commit 9ecebc1
with `assertPayloadSiteWriteAccess`, plus `site_id` on the acknowledgment payload. Both attacks are
permanent reproducers. RESIDUAL, unswept: events whose payload carries no `site_id` are not covered
by the central gate and must bind site in their own applier - the other epics have not been checked.

**The other four HIGH, all fixed 2026-09-06, three of them introduced by the reversal itself:**

- The stored event recorded the minted lot's UUID while the holding row and `stock_balance` recorded
  its NUMBER, so Story 9.7 disposal and any recall trace would have joined on nothing. The UUID is
  removed: `offcut_lot_number` is the single lot identifier, matching what every `lot_id` column on
  this platform carries. This was the only finding both the craftsman and the pragmatist called a
  true blocker, because it poisons IMMUTABLE stored events - code can be fixed later, events cannot.
- The offcut receipt called the raw stock projection, bypassing the laundering bar that the module
  header cites as the whole reason for minting a lot, along with the quantity ceiling and location
  validation. It now goes through `applyStockBalanceProjection` like the drain above it.
- Confirm still MANDATED an offcut election, the decision the approved ruling moved to disposal. It
  blocked an operator from confirming an order until they answered a question nobody can answer yet,
  and the value collected was dead - the capture applier never reads it. Withdrawn, like the rate
  mandate before it. The symmetric refusal survives.
- `offcut_contract_ref_ext` could never be populated - no route field, no payload type, no applier
  write - so the "offcut has its own contract reference" the whole revised model rests on was
  unrecordable. Plumbed end to end.

**Patches applied 2026-09-06:** `offcut` laundering conflicts refuse CROSS_ISSUE_BLOCKED instead of
claiming the material is a prototype; acknowledging an `exception` feed clears the exception stamps
so the Story 1.11 escalation stops chasing a resolved feed; `business_date` no longer reads a day
early in any timezone ahead of UTC; both unguarded inserts classify 23505 to 409 instead of a raw
500; a malformed holding id is not-found rather than a 22P02 500; a multi-uom dispatch is refused
rather than summed and billed at one rate; zero and over-precise price rates are classified 400s
rather than a zero-value feed and a bare TypeError; an unrecognised price basis refuses rather than
dying on NOT NULL; `measured_hours` is refused on a non-per_hour basis instead of being stored and
ignored; six docstrings that still taught the reversed model are corrected; 31 lines of dead
validators and their orphaned regex are removed.

**The customer-facing one:** the custody statement rendered retained offcut as material that LEFT,
with a closing balance of zero - telling the customer the processor holds none of their material
while it physically holds their offcut in a segregated class. It now says the offcut is retained
pending disposal and still theirs.

**Two done stories' tests changed by this work, disclosed rather than quietly patched:**
`story-9-1.test.ts` and `story-9-4.test.ts` both asserted confirm-time mandates that the approved
reversal withdrew.

- [x] [Review][Decision] RESOLVED 2026-09-06. The Story 9.5 breach sweep widening belongs to STORY 9.7, and the epic dev note that placed it in 9.6 has been corrected, so the two documents no longer contradict each other. The exposure is not lost in the meantime: capture deliberately does not reconcile the clock, so the quantity stays outstanding on `jobwork_return_clock` and still ages there, and 9.7 rewrites that reader anyway.
- [x] [Review][Decision] RESOLVED 2026-09-06: a second signature is required, from a NEW `cfo` role, and it sits on the ACQUISITION at disposal (Story 9.7) rather than on capture. Capture stays open by design - offcut comes off a machine whether or not anyone signs, so gating it would leave produced material on the floor with nothing in the ledger, the untracked-material gap the fail-closed ownership ruling exists to prevent. Disposal is where title transfers and money moves, and it is already finance-controller-gated, so the co-signature lands where the value is. The band uses the existing `doa_registry` / `resolveApprover` machinery above a value threshold. `cfo` and `finance_controller` are TWO DISTINCT ROLES HELD BY TWO SEPARATE REAL PEOPLE (ruled 2026-09-06, superseding the earlier note that the site head would hold finance_controller). The separation is the control: nobody both prices a customer's offcut and approves paying for it. Both roles must be provisioned to real, different users before 9.7 ships - `resolveApprover` fails closed on an unheld role.
- [x] [Review][Defer] The sweep alerts as though ERP failed to answer when nothing ever transmits the feed - deferred, the disclosed no-transmitter design; the alert text needs rewording when a transmitter exists.
- [x] [Review][Defer] The sweep holds every due feed row locked for the whole tick - deferred, same root as deferred-work ledger 782.
- [x] [Review][Defer] The reconciliation report is unbounded - deferred, same root as ledger 776.
- [x] [Review][Defer] `skippedRaced` is unreachable and `truncated` counts unfiltered rows - deferred, cosmetic.
- [x] [Review][Defer] `jobwork-billing.ts` carries a second private copy of `alreadyPersisted` - deferred, the two idempotency definitions can drift.
- [x] [Review][Defer] The holding table's `lot_id` and `source_lot_id` are unindexed - deferred, cheap to add with the Story 9.7 migration.
- [x] [Review][Defer] The events-door sweep for payloads carrying no `site_id` across other epics - deferred, and it is the residual of the security fix rather than a 9.6 item.

## Dev Notes

### Binding scope decisions already made (read before coding)

1. **Offcut execution is one event, `custody.offcut_recorded`, on the existing `custody` stream, with three branches.** Not three event types. The election is ORDER state captured at confirmation by Story 9.4 (`service-order.ts:605-637`); a per-election event type would let a caller pick a branch the contract does not permit. The applier re-reads `order.offcut_election` under the order advisory lock and branches on what it finds, exactly as the 9.4 loss applier re-derives the norm rather than trusting `over_norm_approved`.
2. **The `offcut` custody category is already forward-declared and needs NO migration.** `chk_custody_ledger_category` lists it, `chk_custody_ledger_sign` requires `quantity_delta < 0`, and `chk_custody_ledger_ownership` requires `ownership = 'customer'` for every non-`own_material` category (`read/projections/custody_ledger_entry.sql:57-66`). `billable = true` on a customer-ownership offcut row is legal: the ownership CHECK constrains only `own_material`.
3. **Reuse the EXISTING `CUSTODY_RETURN` Symbol door for all three branches. Do not mint a third Symbol.** The physical fact is identical to a 9.5 return: customer-owned `job_work` stock being issued out of the segregated class after the seam has re-derived the order, the lot-under-order and the custody balance. `stock-balance.ts:355-375` bars every `job_work` issue except one carrying `CUSTODY_CONSUMPTION` or `CUSTODY_RETURN`, and a JSON body can never carry a Symbol key, so the bar stays total for every other caller.
4. **`retain_and_buy` and `retain_free` BOTH convert the material to own stock. Only `billable` and the billing line differ.** AC3's wording stops at "a free-retention record is written", but draining custody to zero without a matching owned receipt leaves a `job_work` balance row in the bin that no custody ledger backs: the closure gate would pass while segregated stock sits there, invisible to owned valuation and barred from every demand path forever. The free-retention record IS the ledger row, with `billable = false` and `reference_ext` citing the election. Disclosed as a deviation from the AC's literal silence.
5. **The conversion MINTS A NEW OWNED LOT. It never re-classes the existing `job_work` lot.** The laundering bar refuses an `owned` receipt for any (sku, lot) that already holds a `job_work` balance row (`stock-balance.ts:392-427`), and the symmetric arm refuses the reverse (`:433-467`); the query matches on the existence of the row, not on its `on_hand`, so a fully drained lot still trips it. `src/compliance/jobwork-output.ts:230-290` already mints a lot through `createLot` and posts an ordinary owned receipt for job-work output: copy that shape. Genealogy is preserved by `appendCustodyTrace` writing both sides into `lot_trace`.
6. **The billing feed is a NEW projection with a lifecycle, not the append-only feed shape.** `po_outbound_message`, `msme_ageing_feed` and `payment_clearance_feed` are all fire-and-forget records whose module headers say live transmission is per-deployment configuration and is not implemented (`src/adapters/erp/po-outbound.ts:1-9`). AC4 and AC5 demand acknowledgment, a retry window, an exception queue and a reconciliation report, which need mutable status columns. This is the first outbound interface in the codebase with a lifecycle; the adapter module in `src/adapters/erp/` still owns only the payload SHAPE, matching the house split.
7. **Event types must NOT begin with `erp.` and must NOT use `stream_type: 'erp'`.** `assertErpReadOnly` (`src/compliance/erp-readonly.ts:16-27`) refuses both with 405 `SOURCE_SYSTEM_READ_ONLY` before any DB write, because ERP projections are read-only reference data. Use `stream_type: 'jobwork'` and the names `jobwork.billing_feed_generated` and `jobwork.billing_feed_acknowledged`, matching `jobwork.output_recorded` and `jobwork.output_dispatched`.
8. **Acknowledgment arrives as an INBOUND command on this platform's own API**, not as a callback from a transmitter that does not exist. `POST /api/v1/jobwork/billing-feeds/:feedId/acknowledgment` carries the ERP document number. The order is marked invoiced only when that event lands, which is AC4's literal requirement.
9. **"Marked invoiced" is a column pair on `service_order`, never a fifth status.** The 9.1 state machine has exactly four states and `transitionServiceOrder` is the reserved seam the 9.5 closure gate calls (`service-order.ts:615-658`). A fifth status would break every transition table and the closure gate. Invoicing is orthogonal to lifecycle: an order can be invoiced and still open, or closed and still unbilled.
10. **Executing the election is a precondition for closure, and the EXISTING `CUSTODY_NOT_ZERO` gate already enforces it.** Retained or unreturned offcuts leave the custody ledger non-zero, so 9.5's gate blocks closure on its own. Do NOT add a second closure check; the epics dev note says exactly this.
11. **`reconcileReturnClocks` already accepts `category: 'offcut'`.** It was forward-declared for this story in `src/compliance/jobwork-return-clock.ts:166-167` and has never been used. Call it non-strict (`strict: false`) with `counter: 'reconciled_qty'` on all three branches, matching the capped convention the 9.5 chunk-2 review settled on: clock capacity is `challan_qty` while the custody balance drains `received_qty`, so an over-tolerance receipt must not strand the closure gate.
12. **`per_hour` measured basis has no system source in the pilot and takes a caller-supplied `measured_hours`.** Nothing in the codebase books machine or labour time; Epic 10 story 10.4 is where hub machine-time booking lands. `per_piece` and `per_kg` derive from `job_work_dispatch.dispatched_quantity`, `lumpsum` uses `1`, and `per_hour` is refused `INVALID_PARAMS` without `measured_hours`. Disclosed pilot narrowing, not a permanent contract.
13. **"Through the Story 3.7 flows" means the generic `dispatch_document` TABLE, not the 3.7 renderers.** Story 9.4 established this and the reasoning is unchanged: `src/warehouse/document-renderer.ts` hard-queries `erp_sales_order` and `packing_record` by `dispatch_order_id` internally and would silently render "Unknown" and "N/A" fields for a job-work order instead of failing closed, and the sales-order-bound `dispatch_order_status` state machine does not apply either. The job-work module renders its own plain text into the same generic table, whose `dispatch_order_id` is a bare UUID with no foreign key (`read/projections/dispatch_document.sql:9`), keyed here by `service_order_id`. Do not import the 3.7 renderers.
14. **AC5's "retries never create duplicate billable events" is a SCHEMA rule, not sweep logic.** `uq_job_work_billing_feed_order` makes one feed per order structural; a retry re-sends the SAME feed row and never mints an event, and a second `jobwork.billing_feed_generated` collides into 409 `DUPLICATE_EVENT` through `classifyDuplicate`. Do not implement a bespoke duplicate check.
15. **Billing is gated on offcut SETTLEMENT, and settlement is a caller declaration.** One feed per order (decision 14) plus a billing precondition that ignores offcuts is silent data loss: the coordinator dispatches the last output, generates the feed, then settles the retain-and-buy offcut, and that billable line has nowhere to go for the life of the order. Nothing in the shape of an offcut posting says whether more are coming, because the quantity can legitimately be posted in several goes, so the last posting carries `settles_offcut: true` and stamps `offcut_settled_at` on the order. Billing requires that stamp whenever `has_contractual_offcut` is true, and a further offcut posting after it is refused. Declared-and-stamped, the `has_contractual_offcut` idiom Story 9.4 already established for the election itself.
16. **The contracted offcut rate is captured on the ORDER at confirmation; a settlement-time deviation needs DOA approval.** (SUPERSEDED IN PART, 2026-09-05: the PO ruling on open question 6 replaced the DOA deviation chain with a real-time `offcut_rate_estimate`, and the 2026-09-05 code review replaced the approval with a governed tolerance band refusing `OFFCUT_RATE_OUT_OF_BAND`. The rate's home on the order at confirmation, below, still stands.) No rate field existed anywhere: a grep across `src/`, `read/` and the epics for `offcut_rate`, `contracted_rate` and `buyback` returns nothing, and `service_order.price_basis` is the rate for the SERVICE (per piece, per kg, per hour, lumpsum), not for buying scrap back from the customer. The AC's word is "contracted", and a contractual offcut arrangement is agreed when the contract is, so the rate belongs beside `offcut_election` on the confirm gate (Task 0). The scrap market does move between confirmation and settlement, which is why a deviation is possible at all - but it is APPROVED, not typed: `offcut_rate_override` rides the existing 6.1/6.3 DOA chain that Story 9.4 already wired for over-norm loss, forged-approver and acting-user checks included. A free-text rate typed at settlement by the person who benefits from it is an unbounded number on an invoice line, and the Binding decision 17 SoD arm covers the signature, not the amount.
17. **The acknowledgment must not be posted by the actor who generated the feed.** RBAC in this codebase is module plus function scope, not role literals on routes (`requireRole({ module: 'jobwork', functionScope: 'write' })`), so route-level authorization alone puts generation and acknowledgment behind the same key. Without an explicit check the coordinator generates a feed, acknowledges it with an invented ERP document number, stamps `invoiced_at`, and the order simultaneously leaves the reconciliation report and the sweep's candidate set: an invoiced job that no accounting system has ever seen, with no signal anywhere. The applier refuses `SOD_VIOLATION` on self-acknowledgment, the existing code from `src/api/v1/quality.ts:270`, modelled on the 9.4 acting-user check.
18. **Billing does NOT require every output row fully dispatched.** AC4 says "a completed, dispatched job-work order"; "at least one dispatch" is the AC, "all output dispatched" was an invention. It is also a dead end: a customer who cancels after the third partial leaves a recorded, minted, never-dispatched output lot, `job_work_output` has no write-off path (`chk_job_work_output_dispatched_bounds`), and the order would then close on a zero custody balance having never invoiced, with no alert anywhere because the sweep only watches feeds that exist. The open-to-dispatch quantity goes on the feed and onto the reconciliation report instead: visible, not blocking.
19. **The converted owned lot is held for QC on mint.** `retain_and_buy` and `retain_free` both turn customer material into `owned` stock, which is allocatable to any demand the moment it exists. That material was inspected once, at the 9.2 receipt, against the CUSTOMER's specification as the CUSTOMER's material; it has never been inspected as our raw stock. Without a hold, offcut can be issued into a production order with no incoming record, on a lot whose only inspection was performed on someone else's behalf. There is no `scrap` class to receive into and this story does not add one, so the control is a QC hold task on the minted lot, reusing the Story 9.4 path.

### Critical defect classes to not reintroduce (from 9.1-9.5 review history)

- **Hold-bypass class** (8.3 through 8.8, 9.3, 9.4, 9.5): every gate in this story (`OFFCUT_ELECTION_MISSING`, `BILLING_NOT_READY`, the custody-balance check, the election branch) must be re-derived inside the applier under the order advisory lock. A route pre-check is a convenience, never the authority. A direct `POST /api/v1/events` must hit the identical gate; this is what Task 10.5 and 10.6 verify.
- **Self-approval class** (6.1, 6.3, 8.x release SoD, 9.4 acting-user check): RBAC here is module plus function scope, never a role literal on the route, so any two actions reachable by one operator need an explicit actor comparison in the applier or there is no segregation at all. Generation and acknowledgment of a billing feed are exactly that pair.
- **Float coercion**: every custody balance, measured quantity and billing total settles through the scaled-integer helpers in `src/compliance/custody-statement.ts:20-59`. `Number()` on a NUMERIC string is the repeated 9.2, 9.3 and 9.4 finding.
- **Lock order**: order advisory lock, order row FOR UPDATE, then ledger, clock and feed rows last. Document it in a header comment in every new or modified seam file, the stated 9.3/9.4 convention.
- **Sweep isolation**: per-row SAVEPOINT in the billing sweep. One poisoned feed row must not stop billing alerts for every other order, the exact Story 8.4 lesson.
- **Idempotent sweep**: `alert_sent_at` and `exception_raised_at` prevent re-alerting on every tick. Verify with a test that runs the sweep twice.
- **Route registration order**: `/api/v1/jobwork/reports/billing-reconciliation` and `/api/v1/jobwork/billing-feeds/...` must be registered BEFORE any parameterised `/service-orders/:serviceOrderId/...` route, or the static segment is swallowed. The comment at `server.ts:1046-1048` records this lesson.
- **Coverage and audit completeness**: both new codes land in `AUDITED_REJECTIONS` with `auditFailSafe` routing, or a refused statutory decision leaves no audit row (the 8.3 `NCR_EXISTS` omission lesson).
- **Closed-shape payloads and `rejectUnacceptedFields`** symmetric on every new route, the 9.1 through 9.5 convention.
- **Role spelling**: `jobwork_coordinator`. The story text's `job_work_coordinator` has no holder anywhere in the fixtures or the DOA registry (the 9.5 disclosure).

### Existing code being modified (read fully before editing)

Table 1 lists every file this story modifies, what it does today, and what must survive the edit.

| **File** | **Current state** | **This story changes** | **Must preserve** |
| --- | --- | --- | --- |
| `src/compliance/custody-ledger.ts` | Consumption, own-material, loss and return appliers; `CUSTODY_CONSUMPTION` (:73) and `CUSTODY_RETURN` (:84) Symbols; `classifyDuplicate` 23505 arm (:440); the 9.4 acting-user check (:1015-1045) | Adds and EXPORTS `CUSTODY_OFFCUT_RECORDED` and `assertCustodyOffcutShape` only. The applier goes in `jobwork-offcut.ts`; this file is already 1307 lines with four appliers | Lock order, all four existing appliers, both Symbols, the 23505 classification |
| `src/compliance/stock-balance.ts` | `SEGREGATED_STOCK_CLASSES` bar with exactly two Symbol doors (:355-375); laundering arms (:392-467) | Nothing. The offcut drain rides the existing `CUSTODY_RETURN` door; the conversion receipt uses a new lot so no arm fires | Both laundering arms and the two-Symbol door list unchanged |
| `src/compliance/service-order.ts` | `SERVICE_ORDER_EVENT_TYPES`, `transitionServiceOrder` (:615), the confirm-time offcut gates (:605-637) | Task 0 adds a THIRD confirm gate for `offcut_rate`, copied verbatim from the `offcut_election` pair. Nothing in the state machine; the invoiced stamp is written by the billing applier through the projection accessor | The four-state machine, the reserved closure seam, both existing confirm gates |
| `read/projections/service_order.sql` | Order columns through 9.5 | `ADD COLUMN IF NOT EXISTS invoiced_at`, `invoiced_feed_id`, `offcut_settled_at`, `offcut_settled_by`, plus Task 0's `offcut_rate` and `offcut_currency` | Every existing column and constraint |
| `src/read/projections/service_order.ts` | `ServiceOrderRow` (:10-33), `updateServiceOrderFields` (:167-215) | Six fields on the row type, the create insert and the update accessor | Existing field set and accessor signatures |
| `src/compliance/jobwork-dispatch.ts` | `renderJobWorkDispatchDocuments` (:232-265), the apportionment and QC gate | Read-only reference for the document renderer shape | Everything |
| `src/api/v1/service-orders.ts` | `postCustodyEvent` helper (:571), `readableOrderOr404` (:534), `AUDITED_REJECTIONS` (:63-71), report-route pattern (:1230) | Adds the offcut route via the helper (widening its `idField` union at :576), two billing routes, one report route, two error codes | The helper's signature, every existing route, the RBAC and idempotency idioms |
| `src/server.ts` | Route registration (:1046-1094), `backgroundCycles()` with 6 entries (:1231-1290) | Four route registrations in the correct order, the 7th cycle | Static-before-parameterised ordering, the `guarded()` wrapper, the 6 existing cycles |
| `src/config/index.ts` | `jobwork:` block (:657) with receipt tolerance, loss norm, reason codes, clock knobs; boot guard (:769) | Three billing knobs following the `parsePositiveIntEnv` pattern at `:640-651` | Every existing knob and the clock lead-day boot guard |
| `src/events/schema.ts` | Custody and jobwork payload types | Three new payload interfaces | Existing types |
| `src/events/store.ts` | Applier transaction chain; the custody return applier call | Three applier calls in the same chain | Existing chain order |
| `src/events/migrate.ts` | Projection file list (:47 area) | One new SQL file entry | Existing entries and order |
| `deploy/compose/init-db.sql` | CRLF mirror of every canonical SQL file | The new feed table and the two `service_order` columns | Mirror parity with `read/projections/` |
| `src/sync/upload.ts` | `PERMANENT_ERROR_CODES` | Two codes | Existing set |
| `edge/src/messages/en.json` | Error-code messages | Two entries | Existing entries |
| `test/unit/background-cycles.test.ts` | Pins the 6-cycle list | Must add the 7th or this test fails | Existing 6 entries |
| `test/unit/schema-drift.test.ts` | Pinned table list; 3 pre-existing CRLF pins | The new feed table and the `service_order` column change | The 3 known-failing pins stay failing, do not "fix" them |
| `test/integration/story-1-9.test.ts` | Spine allowlist through 9.5's routes (:536-558) | Four entries | Existing entries |

### Source tree to touch (new files)

Table 2 lists the files this story creates.

| **File** | **Purpose** |
| --- | --- |
| `src/compliance/jobwork-offcut.ts` | `applyCustodyOffcutProjection` (three branches over one shared drain) plus the offcut document renderer, modelled on the 9.4 job-work dispatch renderer |
| `src/compliance/jobwork-billing.ts` | Billing feed generation and acknowledgment appliers, the three-leg precondition, the self-acknowledgment refusal, the invoiced stamp |
| `src/adapters/erp/job-work-billing-feed.ts` | Payload SHAPE only, following the `msme-ageing-feed.ts` module contract and header |
| `read/projections/job_work_billing_feed.sql` | Canonical feed projection with the lifecycle columns |
| `src/read/projections/job_work_billing_feed.ts` | Feed accessors |
| `src/notify/jobwork-billing-sweep.ts` | Retry-window sweep, cloned from `jobwork-clock-sweep.ts`, advisory key 9506 |
| `test/integration/story-9-6.test.ts` | Integration suite |
| `test/unit/jobwork-billing-predicates.test.ts` | Measured-basis resolution, retry-window boundary, scaled totals |

### Testing standards summary

node:test serial integration suites, run-scoped random suffix, local fixture closures only, SCIM plus dev-token actors, admin pool for seeding (`app_user` has no DELETE), migrate-twice idempotency gate, full-suite noise-floor comparison against the baseline, mutation verification at both the seam and the route (the 9.3/9.4/9.5 two-point standard), a direct-event bypass arm for every new event type, sweep functions called directly rather than through live timers (the `retention-expiry.ts` convention), and artificially backdated fixture rows to exercise the retry window without waiting real calendar time. The test database is the docker container `ims-postgres-test` on port 5442; run integration files serially.

Two gotchas recorded by Story 9.5 that apply here: `custody_ledger_entry` rows ordered by sku come back in the database collation, which sorts `SKU-CUST2-...` ahead of `SKU-CUST-...`, so assert by sku map and never by position; and `stock_balance.on_hand` is `NUMERIC(18,6)`, so cast to `numeric(18,3)` before comparing text.

### Project Structure Notes

- Seam files stay in `src/compliance/`, sweep and notification code in `src/notify/`, ERP payload shapes in `src/adapters/erp/` (repo convention).
- Canonical SQL under `read/projections/` with LF endings; the CRLF mirror in `deploy/compose/init-db.sql` changes in the same commit.
- Every SQL statement idempotent (`IF NOT EXISTS` or a guarded `DO` block) so the file can be re-applied to a live database.
- No edge-sync scope: offcut settlement and billing are office actions, not frontline capture. The two error codes still go into `upload.ts` and `en.json` defensively, the 9.4/9.5 precedent.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` lines 2723-2756 (Story 9.6 acceptance criteria and dev notes), 2557-2559 (Epic 9 preamble)
- PRD: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` line 245 (FR-JW-09/10), line 247 (FR-JW-12)
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-6 (custody ledger non-valuated and segregated), AD-11 (ERP GL is the book of record, the platform is the subledger), AD-12 (compliance spine, gates never live in routes), AD-14 (read models are shared projections), AD-16 (idempotency keys), AD-17 (notification emission coupling)
- Previous stories: `9-5-...md` (return path, `reconcileReturnClocks`, the closure gate, the sweep pattern, the two-point mutation standard), `9-4-...md` (offcut election capture at confirm, the dispatch document renderer, the apportionment precedent), `9-3-...md` (custody ledger design, own-material billable rows, the Symbol-door idiom), `9-2-...md` (segregated stock class, the fail-closed config knob pattern), `4-4-...md` and `4-6-...md` if present (the outbound ERP adapter module contract)
- Code anchors verified in this session: `src/compliance/custody-ledger.ts:50-58` (event-type constants), `:73-90` (both Symbols), `:411` (`assertCustodyReturnShape`), `:440` (`classifyDuplicate`), `:1137-1307` (`applyCustodyReturnProjection`, the template for Task 2); `src/compliance/stock-balance.ts:81-86` (`SEGREGATED_STOCK_CLASSES`, `segregationErrorCode`), `:355-375` (the two-Symbol job-work bar), `:392-427` and `:433-467` (both laundering arms); `src/compliance/jobwork-output.ts:230-290` (lot minting plus owned receipt, the Task 2.5 template); `src/compliance/jobwork-dispatch.ts:232-265` (`renderJobWorkDispatchDocuments`); `src/compliance/jobwork-return-clock.ts:166-167` (`ReconcileCategory` including the unused `offcut`); `src/compliance/erp-readonly.ts:16-27` (`assertErpReadOnly`, the `erp.*` naming bar); `src/compliance/service-order.ts:605-637` (the confirm-time offcut gates), `:615-658` (`transitionServiceOrder`); `src/compliance/custody-statement.ts:20-59` (scaled-decimal helpers); `read/projections/custody_ledger_entry.sql:57-66` (category, sign and ownership CHECKs); `read/projections/dispatch_document.sql:7-26` (the four allowed document types); `read/projections/job_work_output.sql` (`job_work_output` and `job_work_dispatch`); `src/read/projections/service_order.ts:4-33` (`ServiceOrderPriceBasis`, `ServiceOrderRow`); `src/read/projections/custody_ledger_entry.ts:11-19` (`CustodyMovementCategory`), `:172-210` (`customerCustodyBalance`, `customerCustodyBalancesByOrder`); `src/adapters/erp/msme-ageing-feed.ts:1-60` (the adapter module contract); `src/adapters/erp/po-outbound.ts:1-9` (the "transmission not implemented" header); `src/notify/emit.ts:19-39` (`EscalationDefinition`, `EmitNotificationInput`), `:124-157` (`emitNotificationInTransaction`); `src/notify/escalate.ts:55` (`runEscalationCycle`); `src/notify/jobwork-clock-sweep.ts:1-60` (the sweep template, `SYSTEM_ACTOR`, advisory key 9505); `src/api/v1/service-orders.ts:63-71` (`AUDITED_REJECTIONS`), `:534-566` (`readableOrderOr404`), `:571-666` (`postCustodyEvent`), `:1230` (the report-route pattern); `src/server.ts:1046-1094` (route order), `:1231-1290` (`backgroundCycles`); `src/config/index.ts:640-651` (sweep-knob pattern), `:657-700` (the `jobwork:` block); `test/integration/story-1-9.test.ts:536-558` (spine allowlist)

### Open questions

Table 3 records the questions this story answers by ruling rather than by asking, so the dev agent is never blocked. Each ruling is implemented as written; each is flagged for product-owner confirmation before go-live.

| **Question** | **Ruling** | **Lives in** |
| --- | --- | --- |
| 1. Does `retain free` move the material into own stock, or only zero the custody ledger? | Both retention branches convert to own stock; only `billable` differs. Zeroing custody without an owned receipt strands segregated stock the closure gate can no longer see | Binding decision 4, Task 2.6 |
| 2. Does retain-and-buy need its own outward tax document? | No. The billing feed line is the invoice trigger and ERP raises the tax invoice, per AD-11 (ERP GL is the book of record). Only the `return` branch renders documents | Binding decision 6, Task 3.3 |
| 3. Where does a `per_hour` measured quantity come from? | Nowhere in the pilot. Caller-supplied `measured_hours`, refused `INVALID_PARAMS` without it. Machine-time booking lands in Epic 10 | Binding decision 12, Task 5.3 |
| 4. What is the retry window before a feed becomes an exception? | 24 hours, a disclosed placeholder in the same style as the 9.2 receipt tolerance and the 9.4 loss norm | Task 7.1 |
| 5. Can one order produce more than one billing feed? | No. `uq_job_work_billing_feed_order` makes it structural; a partial-billing requirement would be a new story, not a knob | Binding decision 14, Task 4.2 |
| 6. Where does the contracted offcut rate come from, and who is allowed to set it? | On the ORDER at confirmation, mandatory when `has_contractual_offcut` is true, mirroring the existing `offcut_election` confirm gate. A settlement-time deviation is possible but goes through the 6.1/6.3 DOA chain, never a typed number. Confirmed with operations 2026-09-04: the contracted rate is already in the contract; commercial renegotiation is the exception, and an exception is what an approval is for | Binding decision 16, Task 0, Task 2.5 |

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story workflow, 2026-09-04.

### Debug Log References

1. Task 2.5a as written (a `qc_inspection_task` through `receiveQcCompletion`) is unreachable for an offcut lot: `POST /api/v1/qc/inspection-plans` refused `INSPECTION_PLAN_SCOPE_MISMATCH` for the customer item against the kit revision, because `inspection_plan.bom_revision_id` is NOT NULL and the seam requires the revision's BOM parent to BE the item. Customer raw material has no BOM. Replaced with the Story 8.5 governed hold (`qc.hold_placed` persisted on the same transaction); see Completion Notes deviation 1.
2. Task 2.8's genealogy premise (both lots under one `event_id` in `lot_trace`) cannot hold: `idx_lot_trace_event_id` is UNIQUE and `appendTraceEntry` is `ON CONFLICT (event_id) DO NOTHING`, so the owned lot's second trace row was silently dropped (first AC2 run). The dead append was removed and the genealogy path re-documented; see deviation 2.
3. The `erp` stream direct-event arm hit RBAC (`MODULE_ACCESS_DENIED`, 403) before `assertErpReadOnly` (405); the arm now accepts either refusal and asserts no feed row was written.
4. Mutation verification (Task 10.6), four gates, each disabled in source and re-run against its route arm and its direct-event arm, then restored (`git status` confirmed): `OFFCUT_ELECTION_MISSING` 0 pass / 2 fail; `BILLING_NOT_READY` offcut-settled leg 0 / 2; `SOD_VIOLATION` self-acknowledgment 0 / 2; Task 0 confirm-time rate gate 0 / 1 (the one arm carries both the route and the direct `jobwork.order_confirmed` call).
5. The earlier "CRLF mirror" wording for `deploy/compose/init-db.sql` is stale on this checkout: every SQL file, canonical and mirror, is LF (`grep -c $'
'` in Git Bash matched every line as a quoting artifact; Python byte counts showed zero CR). Files written LF; the schema-drift guard normalises whitespace anyway.

### Completion Notes List

Implemented 2026-09-04 against baseline 8ccd2e6. All eleven tasks complete; every AC has a route arm, a direct-event arm and, for the four named gates, a two-point mutation kill.

Verification:

- `test/integration/story-9-6.test.ts`: 20/20 (serial, run-scoped, admin-pool fixtures, sweep called directly against a backdated `first_sent_at`).
- `test/unit/jobwork-billing-predicates.test.ts` (rerun 2026-09-05 with the story suite: 33/33): money arithmetic, measured basis, retry-window boundary, both BILLING_NOT_READY legs, SoD, election gate, Task 0 rate shape; plus `background-cycles` (7th cycle pinned) and `schema-drift` (feed table pinned): 177/177 in the unit run.
- Regression (Task 10.8): story-9-1, 9-2, 9-3, 9-4, 9-5, 1-9, 3-7 all green, 124/124; the 9.1 and 9.4 contractual confirm arms were updated to carry the rate pair, not worked around.
- Full suite: 1893/1921, 28 failures, all in the documented noise floor (2.5 transfer family x15, idempotency-replay family x9, 1.7, 3.10, 2.3 FIFO, 3.6 FEFO), zero new, none in any touched file.
- `tsc`, `eslint`, `prettier --check` clean on every changed file; `db:migrate` twice, both exit 0; `graphify update .` exit 0.

Disclosed deviations from the task text (each is a codebase fact, not a choice):

1. Task 2.5a "QC hold task": the converted owned lot is placed on the Story 8.5 GOVERNED quality hold (`qc.hold_placed` persisted on the same transaction, `qc_quality_hold` row plus `lot_master.quality_hold_status = 'held'`, released only through the 8.5 segregated release route) rather than a `qc_inspection_task`. Inspection plans are grained on `(item_id, bom_revision_id NOT NULL)` and plan creation refuses `INSPECTION_PLAN_SCOPE_MISMATCH` unless the revision's BOM parent is the item; customer raw material has no BOM. The test asserts the flag, the open hold row and `dispatchGateBlockedLots` reporting the lot held. The hold id is stamped on the stored payload as `converted_lot_hold_id`.
2. Task 2.8 genealogy: `lot_trace` is UNIQUE on `event_id`, so one event carries one trace row. The offcut event carries the customer lot's drain row; the owned lot's first trace row is written by the hold event, whose `causation_id` is the offcut event, and the stored offcut payload carries `converted_lot_id` / `converted_lot_number`. Documented in the module header; the recall-trace path across the ownership change is payload or causation, never a shared `event_id`.
3. Money scale: quantities stay at the 3-decimal custody-statement scale; rates and money are 4-decimal (`NUMERIC(18,4)`), with `billableValueOf` rounding the exact 7-decimal product half-up. The 4-decimal helpers live in `src/adapters/erp/job-work-billing-feed.ts` beside the payload shape because `custody-statement.ts` is fixed at three places.
4. Billing order state: `orderAcceptsBilling` admits `in_process` AND `closed` (Binding decision 9 says closed and unbilled is legal); draft and confirmed refuse `BILLING_NOT_READY` with reason `order_not_started`.
5. SUPERSEDED 2026-09-05 by the PO ruling on open question 6 ("rate provenance is to be on real-time estimates"): the settlement rate is the real-time estimate the settling posting supplies as `offcut_rate_estimate`; no DOA gate, no `approved_by`, no `jobwork.offcut_rate_override` transaction type. The order's contracted rate (Task 0) stays as the reference: it is the effective rate when no estimate is supplied, and is stamped beside the effective rate on the stored payload (`contracted_offcut_rate`) and on the feed's retain-and-buy line so ERP sees the variance. An estimate on a `return` or `retain_free` posting is still refused `INVALID_PARAMS`. Binding decision 16's DOA deviation chain is therefore NOT implemented; the Dev Notes text is left as written per the workflow's section rules and this note is the authority.
6. The `erp` stream direct-event arm is refused by RBAC (`MODULE_ACCESS_DENIED`, 403) before `assertErpReadOnly` (405); the test accepts either and asserts no feed row.
7. `NOT_FOUND` (existing en.json code) is used for a missing billing feed on acknowledgment, with the 404-versus-403 collapse; `ITEM_NOT_FOUND` and `NOT_FOUND` were added to this file's `AUDITED_REJECTIONS`.
8. The retention conversion receives the owned lot into the SAME bin the offcut was drained from (`location_id` on the posting), not the site root as 9.4 output does; the material has not moved.
9. Open question 6 (rate provenance) ANSWERED by the PO on 2026-09-05: real-time estimate at settlement, see deviation 5. No DOA seeding is required for offcuts.

### File List

New:

- `read/projections/job_work_billing_feed.sql`
- `src/read/projections/job_work_billing_feed.ts`
- `src/adapters/erp/job-work-billing-feed.ts`
- `src/compliance/jobwork-offcut.ts`
- `src/compliance/jobwork-billing.ts`
- `src/notify/jobwork-billing-sweep.ts`
- `test/integration/story-9-6.test.ts`
- `test/unit/jobwork-billing-predicates.test.ts`

Modified:

- `read/projections/service_order.sql`
- `deploy/compose/init-db.sql`
- `src/read/projections/service_order.ts`
- `src/compliance/service-order.ts`
- `src/compliance/custody-ledger.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/api/v1/service-orders.ts`
- `src/server.ts`
- `src/config/index.ts`
- `src/sync/upload.ts`
- `edge/src/messages/en.json`
- `test/integration/story-9-1.test.ts`
- `test/integration/story-9-4.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/unit/background-cycles.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| **Date** | **Change** | **By** |
| --- | --- | --- |
| 2026-09-04 | Story created, status ready-for-dev | create-story workflow |
| 2026-09-05 | Code review group A (schema, DDL, event contract, config) plus a party-mode ruling on the four decision items. 14 patches applied: three event types registered in `SUPPORTED_EVENT_TYPES`; four new CHECK constraints (feed amounts, feed lifecycle pairing, and the three `service_order` column pairs); plain indexes on `acknowledged_ref_ext` and `site_id`; guarded constraint blocks converted to DROP-then-ADD; the feed header now documents that `exception` is not terminal and that the table is NOT rebuildable; drift test pins the six additive columns and the FULL index statements; Task 5.2 corrected to the payload source and its per-row lookup batched to one `= ANY($1)`. One new HIGH found and closed: `offcut_rate_estimate` was never compared to `order.offcut_rate` and the rate-setter sat outside the SoD chain, so a settlement outside `JOBWORK_OFFCUT_RATE_TOLERANCE_PCT` (default 10%) now refuses `OFFCUT_RATE_OUT_OF_BAND` and the offcut settler may no longer acknowledge the feed that bills it. Both guards mutation-verified at the seam; story-9-6 22/22 | code review |
| 2026-09-05 | PO ruling on open question 6: offcut rate provenance is real-time estimates. `offcut_rate_override` plus `approved_by` and the DOA chain replaced by `offcut_rate_estimate` (settlement rate, no approval); contracted rate stamped beside the effective rate on payload and feed line; test arms rewritten; 33/33 story plus unit tests, tsc/eslint/prettier clean | dev-story (Claude Fable 5.1) |
| 2026-09-04 | Implemented Tasks 0-11: order-level contracted offcut rate (Task 0), `custody.offcut_recorded` with three branches over one CUSTODY_RETURN drain, owned-lot mint with governed QC hold, return documents, `job_work_billing_feed` projection with lifecycle, feed generation and acknowledgment with SoD, retry-window sweep (7th cycle, key 9506), four routes, two new stable codes; 20/20 story tests, four gates mutation-verified two-point, full suite 0 new failures; status review | dev-story (Claude Fable 5.1) |
| 2026-09-04 | Second party-mode pass on the implementation risks. Contracted offcut rate moved onto the order at confirmation with DOA-approved settlement deviation (new Task 0, supersedes the settlement-typed rate); full-dispatch billing gate dropped as a dead end and replaced by `open_to_dispatch_qty` on the feed and the reconciliation report (Binding decision 18); converted owned lot held for QC on mint (Binding decision 19) | party-mode |
| 2026-09-04 | Party-mode adversarial pass (Winston, Amelia, John, Boundary, Vex, Dana, Grumbal, Ravi guest). Six findings folded in: billing-before-offcut data loss closed by Binding decision 15; self-acknowledgment SoD hole closed by Binding decision 17; missing contracted offcut rate closed by Binding decision 16 and open question 6; dead `attempt_count`/`last_attempt_at` columns dropped; offcut applier moved out of `custody-ledger.ts`; lot genealogy across the ownership change documented as `event_id`-joined | party-mode |
