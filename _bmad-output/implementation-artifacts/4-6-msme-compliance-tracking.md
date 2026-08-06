---
baseline_commit: 03d2ed26cba1b6179f1ae786a0536f0e0149ef99
---

# Story 4.6: MSME Compliance Tracking

Status: done

## Story

As a finance compliance officer,
I want Udyam registration captured on suppliers with statutory due dates stamped on every PO and an ageing report flagging s.43B(h) and MSMED s.16 exposure,
So that we never miss an MSME payment deadline or lose a tax deduction.

Source: `_bmad-output/planning-artifacts/epics.md` lines 1647-1685 (Epic 4, FR-P-09).

## Acceptance Criteria

1. **Given** a supplier claiming MSME status, **when** their Udyam registration number is captured, passes format validation (pattern `UDYAM-XX-00-0000000`), and is verified by the officer against the uploaded Udyam certificate (FR-P-09), **then** the supplier is flagged as an MSME vendor with a classification tag of `micro`, `small`, or `medium` taken from the certificate, and the Udyam number, classification, and certificate reference are stored on the supplier record.
2. **Given** a PO is issued to an MSME-flagged supplier, **when** the PO is confirmed, **then** a statutory payment due date is stamped as the earlier of the agreed date and 45 days, or 15 days where no agreement exists (the appointed-day rule).
3. **Given** MSME supplier invoices captured through Story 4.7 are outstanding, **when** the ageing report is generated, **then** invoices approaching or past their statutory due date are flagged with their s.43B(h) income-tax and MSMED s.16 interest exposure, each line tagged with the supplier's MSME classification (`micro`, `small`, or `medium`).
3a. **(Story 4.7 AC 5 closure)** **Given** the supplier is MSME-flagged, **when** an invoice is captured or an unmatched invoice is linked to a PO, **then** `msme_classification_at_capture`, `statutory_due_date`, and `statutory_due_rule_version` are stamped on the invoice: the earlier of the agreed date and 45 days from the invoice date, or 15 days from the invoice date where no agreement exists.
4. **Given** the classification-tagged ageing exists, **when** the scheduled ERP feed runs, **then** the ageing, tagged by MSME classification, is fed to ERP through the ERP integration adapter (`adapters/erp`) so the s.43B(h) disallowance computation in ERP consumes it (FR-P-09), and each feed run is recorded with timestamp and row count.
5. **Given** an MSME supplier's Udyam registration is approaching its annual revalidation date, **when** the revalidation window opens, **then** an alert is raised through the notification foundation (Story 1.11) to re-verify the registration before it lapses.
6. **Given** a Udyam number that fails format validation or does not match the recorded certificate, **when** the officer attempts to save the MSME flag, **then** the save is rejected with `error_code: "UDYAM_INVALID"` and the supplier remains untagged as MSME until a valid registration is captured.
7. **Given** an MSME supplier's Udyam revalidation date has passed without re-verification, **when** the daily compliance check runs, **then** the supplier's MSME flag moves to `suspended-pending-reverification` with the change written to the edit log (FR-AC-13); statutory due dates already stamped on open POs and invoices remain in force (conservative treatment) and new POs to the supplier raise a warning to procurement.
8. **Given** an MSME invoice passes its statutory due date unpaid, **when** the breach is detected, **then** the invoice is flagged `statutory_breach`, MSMED s.16 interest exposure accrues in the ageing from the day after the due date, and an escalation is sent to the finance compliance officer through the notification foundation (Story 1.11).

## Tasks / Subtasks

- [x] Task 1: Schema - MSME fields, statutory columns, ageing feed table (AC: 1, 2, 4, 7, 8)
  - [x] 1.1 Add guarded additive `ALTER TABLE supplier ADD COLUMN IF NOT EXISTS` blocks to `read/projections/supplier.sql` (Story 3.10 precedent, `schema-drift.test.ts:615-666` pattern): `udyam_number_ext TEXT`, `msme_classification TEXT`, `msme_certificate_reference TEXT`, `msme_status TEXT`, `udyam_verified_at TIMESTAMPTZ`, `udyam_revalidation_due_date DATE`. Add guarded CHECK constraints: `chk_supplier_msme_classification` (`NULL` or in `('micro','small','medium')`), `chk_supplier_msme_status` (`NULL` or in `('active','suspended-pending-reverification')`). `msme_status` is a separate axis from `supplier.status`; do NOT touch `chk_supplier_status`.
  - [x] 1.2 Add guarded additive columns to `read/projections/purchase_order.sql` (header only; lines do not need them): `statutory_due_date DATE`, `statutory_due_rule_version TEXT`.
  - [x] 1.3 Add guarded additive column to `read/projections/supplier_invoice.sql`: `statutory_breach BOOLEAN NOT NULL DEFAULT false`. Do NOT extend `chk_supplier_invoice_status`; breach is orthogonal to the `unmatched`/`captured` lifecycle.
  - [x] 1.4 New canonical file `read/projections/msme_ageing_feed.sql`: table `msme_ageing_feed` with `feed_id UUID PK`, `payload JSONB NOT NULL`, `row_count INTEGER NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Append-only ledger: grants `INSERT, SELECT` to `app_user` only (mirror `po_outbound_message.sql:22` pattern, header comment template from `purchase_order_line.sql:1-8`).
  - [x] 1.5 Mirror every change byte-identically into `deploy/compose/init-db.sql`; append `'../../read/projections/msme_ageing_feed.sql'` to `MIGRATIONS` in `src/events/migrate.ts` (after supplier_invoice entries; order matters); update `test/unit/schema-drift.test.ts` EXPECTED entries (supplier, purchase_order, supplier_invoice, new msme_ageing_feed).
- [x] Task 2: Events and rule module (AC: 1, 6, 7, 8)
  - [x] 2.1 New module `src/compliance/msme.ts`. Event types on `procurement` stream, all `requiresBusinessStream: false`: `supplier.msme_verified` (payload: `supplier_id`, `udyam_number_ext`, `msme_classification`, `certificate_reference`, `verified_at`, `revalidation_due_date`), `supplier.msme_suspended` (payload: `supplier_id`, `reason: 'revalidation-lapsed'`, `lapsed_on`), `supplier_invoice.statutory_breach_flagged` (payload: `invoice_id`, `supplier_id`, `statutory_due_date`, `detected_on`), `msme_ageing_feed.recorded` (payload: `feed_id`, `row_count`, `generated_at`). Re-verification reuses `supplier.msme_verified` (moves `msme_status` back to `active` and stamps a new `revalidation_due_date`).
  - [x] 2.2 Register payload plus envelope interfaces in `src/events/schema.ts` (Story 4.x blocks) and add the four entries to `SUPPORTED_EVENT_TYPES`.
  - [x] 2.3 In `src/compliance/msme.ts`: `MSME_EVENT_TYPES` Set, `assertMsmeShape` switch, `applyMsmeProjection` switch, module-local `alreadyPersisted` guard (copy `supplier.ts:272-279` exactly; plain SELECT, never `FOR UPDATE` on `domain_events`). Wire the assert into the pre-transaction block of `persistEvent` (`src/events/store.ts:365-487`) and the applier into the in-transaction block (`store.ts:531-719`), appended after the supplier-invoice wiring, nothing reordered.
  - [x] 2.4 Udyam format validation in `assertMsmeShape`: regex `^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$`; reject with `AppError(400, 'UDYAM_INVALID', ...)`. Certificate mismatch (missing or empty `certificate_reference`, or classification absent from payload) also rejects `UDYAM_INVALID`.
  - [x] 2.5 Dated statutory rule: add `config.msme` block in `src/config/index.ts` (pattern: `config.supplierInvoice`, lines 170-186): `ruleVersion` (env `MSME_STATUTORY_RULE_VERSION`, default `msmed-2006.s15-16.v1`), `revalidationLeadDays` (env `MSME_REVALIDATION_LEAD_DAYS`, default 30, `parsePositiveIntEnv`), `interestRatePercentAnnual` (env `MSME_S16_BANK_RATE_X3_PERCENT`, default 27; MSMED s.16 is three times RBI bank rate, compounded monthly, so keep it configuration, never hard-coded). Statutory thresholds are dated configuration per architecture spine.
  - [x] 2.6 Due-date calculator in `src/compliance/msme.ts`, pure and calendar-date based (no elapsed milliseconds; strict `YYYY-MM-DD` handling like `isDateString` in `purchase-order.ts:53`): `computeStatutoryDueDate(anchorDate, creditPeriodDays | null)` returns earlier of (`anchorDate + creditPeriodDays`) and (`anchorDate + 45`) when a credit period exists (the agreement), else `anchorDate + 15` (appointed-day rule). Export `getSupplierMsmeContext(supplierId, client)` accessor returning `{ msme_status, msme_classification, credit_period_days, rule_version }`; this is the single accessor Story 4.7 Task 7 named ("reuse 4.6's accessor and dated rule contract rather than adding a competing MSME registry").
- [x] Task 3: Supplier MSME capture API (AC: 1, 6)
  - [x] 3.1 Projection support: extend `SupplierRow` (`src/read/projections/supplier.ts:4-26`) with the six new fields; add whitelisted mutation seam `updateSupplierMsmeFields` alongside `updateSupplierStatus:141` (do not widen `assertSupplierUpdatedShape`; MSME capture is not a `supplier.updated` concern).
  - [x] 3.2 New handler in `src/api/v1/suppliers.ts`: `POST /api/v1/suppliers/:supplierId/msme` (verify or re-verify). Validates supplier exists (`SUPPLIER_NOT_FOUND` reuse), builds envelope for `supplier.msme_verified`, persists via `persistEvent` with `auditCtxFor` (canonical helper `suppliers.ts:43-57`; edit-log row comes free). RBAC wrapper `requireRole` with `module: 'procurement'`, `functionScope: 'write'`; never role-name literals (eslint rule `no-hardcoded-role-in-workflow`). Register route in `src/server.ts` next to the supplier block (lines 385-392).
  - [x] 3.3 `applyMsmeVerified` sets `udyam_number_ext`, `msme_classification`, `msme_certificate_reference`, `msme_status = 'active'`, `udyam_verified_at`, and `udyam_revalidation_due_date` (payload value; default computed by handler as verified date plus 1 year, IST calendar date). Failed validation leaves supplier untagged (reject happens in assert, before any write).
- [x] Task 4: PO statutory due-date stamping at confirmation (AC: 2)
  - [x] 4.1 In `applyPoConfirmed` (`src/compliance/purchase-order.ts:700-758`): after the existing gate, call `getSupplierMsmeContext` for the PO's supplier. If `msme_status` is `active` or `suspended-pending-reverification` (conservative treatment, AC 7), compute `statutory_due_date` with `computeStatutoryDueDate(confirmationBusinessDate, credit_period_days)` where `confirmationBusinessDate` is the IST calendar date of `envelope.metadata.occurred_at`, and pass `statutory_due_date` plus `statutory_due_rule_version: config.msme.ruleVersion` through the extended extra-fields object of `updatePurchaseOrderStatus` (seam already stamps `confirmed_at` and `promised_delivery_date` at lines 724-729). Non-MSME suppliers leave both columns null.
  - [x] 4.2 Agreement definition (documented assumption, keep consistent with Task 6): supplier `credit_period_days` non-null means an agreement exists; agreed date is anchor plus credit period, capped by the 45-day ceiling; null credit period means 15 days.
- [x] Task 5: PO draft warning for suspended MSME supplier (AC: 7)
  - [x] 5.1 At PO draft (supplier-active gate already runs via `getSupplierById` in `purchase-order.ts`): when supplier `msme_status = 'suspended-pending-reverification'`, do NOT block; return a warning in the 200 envelope using the `ZoneIncompatibleWarning` precedent (`src/events/store.ts:357-360` comment describes the catch-and-wrap pattern) with a new `MsmeSuspendedWarning` (e.g. `warning_code: 'MSME_SUPPLIER_SUSPENDED'`). Drafting proceeds.
- [x] Task 6: Invoice stamping - close Story 4.7 AC 5 (AC: 3a)
  - [x] 6.1 In `src/compliance/supplier-invoice.ts` replace the two null-stub blocks (`insertCapturedOrUnmatchedInvoice` lines 1167-1171 and `applySupplierInvoicePoLinked` lines 1290-1293) with a call to `getSupplierMsmeContext`. When supplier MSME context is active or suspended (conservative), stamp `msme_classification_at_capture`, `statutory_due_date = computeStatutoryDueDate(invoice_date, credit_period_days)`, `statutory_due_rule_version`. Non-MSME suppliers keep all three null. The update seam `updateSupplierInvoicePoLink` (`src/read/projections/supplier_invoice.ts:394-430`) already accepts these fields; the insert path already binds them (`InsertSupplierInvoiceInput:234-236`).
  - [x] 6.2 Update `test/integration/story-4-7.test.ts`: revise header comment (lines 16-20, blocked-dependency note), replace the null-pin assertions (lines 460-461 and 906-908) with assertions that non-MSME suppliers still get nulls; add no new 4.7 scenarios there (MSME-positive stamping is asserted in `story-4-6.test.ts`). Remove or update the two `Story 4.6` TODO comments in `supplier-invoice.ts`.
- [x] Task 7: MSME ageing report (AC: 3, 8)
  - [x] 7.1 Read-model query (new accessor in `src/read/projections/supplier_invoice.ts` or a dedicated `src/read/projections/msme_ageing.ts`): outstanding = every `supplier_invoice` row with non-null `statutory_due_date` (payment executes in ERP; no payment state exists in this system, so all captured invoices are outstanding by definition; document this in code comment and Dev Notes). Columns per line: invoice identifiers, supplier, `msme_classification_at_capture`, `statutory_due_date`, days-to-due or days-overdue (computed in SQL against a supplied as-of IST date, never `now()` in JS), `statutory_breach` flag, s.43B(h) exposure flag (true when overdue as of the FY-relevant test), MSMED s.16 interest exposure amount (principal `total_value`, simple statement: interest accrues from day after due date at `config.msme.interestRatePercentAnnual`, compounded monthly; compute in SQL NUMERIC, never JS floats).
  - [x] 7.2 `GET /api/v1/compliance/msme/ageing?as_of=YYYY-MM-DD` handler (new file `src/api/v1/msme.ts` or extend `supplier-invoices.ts`), RBAC `module: 'procurement'`, `functionScope: 'read'`. Route in `src/server.ts`.
- [x] Task 8: ERP ageing feed (AC: 4)
  - [x] 8.1 Pure builder `src/adapters/erp/msme-ageing-feed.ts` mirroring `po-outbound.ts` (header comment: adapter records payload durably; live transmission is per-deployment configuration, NOT implemented). `buildMsmeAgeingFeedPayload(ageingRows, generatedAt, correlationId)`.
  - [x] 8.2 Feed run endpoint `POST /api/v1/compliance/msme/ageing-feed/run` (synthetic HTTP trigger precedent, `src/server.ts:299-312` planning jobs). Handler generates the ageing as of the run's IST business date, persists one `msme_ageing_feed.recorded` event via `persistEvent` (audit row free) and inserts the `msme_ageing_feed` row (payload, `row_count`, `recorded_at`) inside the same transaction (the `po_outbound_message`-inside-`applyPoIssued` pattern). AC verified against the recorded row, not a live ERP. RBAC `module: 'procurement'`, `functionScope: 'write'`.
- [x] Task 9: Daily compliance check (AC: 5, 7, 8)
  - [x] 9.1 `runMsmeComplianceCheck(scope)` in `src/compliance/msme.ts`, pure-cycle-function pattern of `planning-jobs.ts` (doc lines 17-27; `runObsolescenceScan:692` and `scanOneGrain:719` are the per-grain lock template; scope carries `actor`, `auditCtx`, `business_date` like `PlanningJobScope:38-45`). Exposed as `POST /api/v1/compliance/msme/daily-check` next to the planning triggers. Three sweeps, each idempotent per day:
  - [x] 9.2 Revalidation window: suppliers with `msme_status = 'active'` and `udyam_revalidation_due_date` within `config.msme.revalidationLeadDays` of `business_date`: raise re-verify alert via `emitNotificationInTransaction` (AD-17: statutory communications MUST use the transactional entry point) targeting `{ role: 'procurement_officer' }` (existing supplier-domain target, `supplier.ts:482-496` pattern). Do not re-notify a supplier already alerted for the same due date (dedupe on an existing notification row or a payload check).
  - [x] 9.3 Lapse: suppliers with `msme_status = 'active'` and `udyam_revalidation_due_date < business_date`: persist `supplier.msme_suspended` (edit log free via `persistEvent`); applier sets `msme_status = 'suspended-pending-reverification'`. Stamped statutory dates on open POs and invoices are NOT touched (conservative treatment).
  - [x] 9.4 Breach: invoices with `statutory_due_date < business_date`, `statutory_breach = false`: persist `supplier_invoice.statutory_breach_flagged`; applier sets `statutory_breach = true`; escalation via `emitNotificationInTransaction` targeting the finance compliance role. Check the SCIM role fixtures used in tests for the exact role string; if no finance-compliance role exists yet, provision `finance_compliance_officer` in the test fixtures the same way other roles are provisioned (`provisionUser` pattern, `story-4-7.test.ts:84`). Interest accrues in the ageing computation from day after due date (Task 7), not as a stored balance.
- [x] Task 10: Integration tests, gates, docs (all ACs)
  - [x] 10.1 `test/integration/story-4-6.test.ts` per `story-4-7.test.ts` canon: `before()` applies canonical SQL in `migrate.ts` order (add `msme_ageing_feed.sql`), audit-trigger disable plus TRUNCATE in try/finally, server on port 0, SCIM role fixtures, `run` suffix for external IDs. One `it('ACn: ...')` per AC branch: valid Udyam capture (AC 1), bad format and missing certificate `UDYAM_INVALID` (AC 6), PO confirmation stamping for MSME with and without credit period plus the 45-day cap and non-MSME null (AC 2), invoice stamping at capture and at po_link (AC 3a), ageing report with classification tags and exposures (AC 3), feed run recorded with row count (AC 4), revalidation alert (AC 5), lapse suspension plus edit-log row plus PO-draft warning plus stamped-dates-in-force (AC 7), breach flag plus escalation plus interest-from-day-after (AC 8), trailing idempotent-replay test for `supplier.msme_verified`. Assert DATE columns via `::text` (repo-wide DATE serialization deferral). Direct `POST /api/v1/events` spoof test for the new event types (mandatory per 4.7 conventions).
  - [x] 10.2 Run full suite (`node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts`; `.env.test` needs `DB_PORT=5442`; postgres:18.4 on port 5442), `npm run lint`, spine gate `npm run spine-acceptance-contract`. The 14 pre-existing idempotency 201-vs-409 failures are documented; accept, do not fix.
  - [x] 10.3 `graphify update .` after code changes.

### Review Findings

Code review 2026-08-06 (adversarial pass: Blind Hunter + Edge Case Hunter + Acceptance Auditor; chunked, Group 1 of 3 - schema, event schema, migrations, config, schema-drift test). Acceptance Auditor: fully compliant, no findings. Carried to Group 2 for verification: breach sweep must not flag cancelled/rejected invoices, feed applier idempotency/23505 handling, date-order validation in assertMsmeShape.

- [x] [Review][Patch] MSME_S16_BANK_RATE_X3_PERCENT integer-only parse rejects the real statutory rate [src/config/index.ts:197] - fixed: parsePositiveNumberEnv accepts fractional percents (3 x 6.5 = 19.5); default remains 27
- [x] [Review][Patch] Schema-drift guard does not cover the ten new ALTER ADD COLUMN lines or their init-db mirror parity [test/unit/schema-drift.test.ts:611] - fixed: added Story 4.6 drift block asserting all 10 ADD COLUMN fragments plus msme_ageing_feed migration ordering (test now 56/56 green)
- [x] [Review][Patch] Empty MSME_STATUTORY_RULE_VERSION env propagates a blank statutory_due_rule_version [src/config/index.ts:191] - fixed: IIFE treats empty string the same as undefined; default applies
- [x] [Review][Patch] msme_classification vocabulary asymmetry vs supplier_invoice ('not_msme') is undocumented [read/projections/supplier.sql:106] - fixed: comment in supplier.sql and init-db.sql mirror notes that supplier uses NULL for non-MSME while supplier_invoice uses 'not_msme' as a fourth capture-time value; do not align
- [x] [Review][Defer] CHECK vocabulary widening never propagates to existing DBs because the IF NOT EXISTS guard skips re-adding [read/projections/supplier.sql:117] - deferred, pre-existing guarded-migration pattern repo-wide
- [x] [Review][Defer] Concurrent db:migrate runs can abort on TOCTOU inside guarded DO blocks [src/events/migrate.ts:73] - deferred, pre-existing repo-wide pattern
- [x] [Review][Defer] init-db.sql runs outside any transaction; an interrupted first boot leaves a partial schema [deploy/compose/init-db.sql] - deferred, pre-existing file-wide pattern

Code review 2026-08-06 Group 2 (compliance modules, event store wiring, projections, ageing query). Blind Hunter: no real defects found. Acceptance Auditor: spec contract largely honored; two AC violations, two secondary concerns. Edge Case Hunter: 11 candidates, 7 of which were dupes of the above or dismissed.

- [x] [Review][Patch] Breach idempotency_key does not include statutory_due_date; a po_link re-stamp of the due date silently suppresses the next day's breach event [src/compliance/msme.ts:583] - fixed: key now `msme-breach-${invoiceId}-${dueDate}`
- [x] [Review][Decision] PO confirmation stamps without the msme_classification null check that the invoice stamping path enforces - the two paths diverge on data anomalies where msme_status='active' but msme_classification IS NULL [src/compliance/purchase-order.ts:734 vs src/compliance/supplier-invoice.ts:1147] - fixed: PO path now also requires `msmeCtx.msme_classification !== null`; both paths agree
- [x] [Review][Patch] applyPoConfirmed can overwrite already-stamped statutory_due_date/statutory_due_rule_version on any future re-confirmation, violating AC7's 'stamped dates remain in force' [src/read/projections/purchase_order.ts:314] - fixed: SET clauses wrapped in COALESCE(col, $N) so the first stamp wins
- [x] [Review][Decision] applySupplierInvoicePoLinked re-stamps msme_classification_at_capture and statutory_due_date, contradicting the 'immutable capture-time snapshot' contract at the capture path comment [src/compliance/supplier-invoice.ts:1306 vs :1142] - fixed: snapshot is immutable; po_link path no longer re-stamps, updateSupplierInvoicePoLink seam simplified to drop the three MSME fields, capture-time nulls preserved
- [x] [Review][Patch] assertMsmeVerifiedShape accepts a past revalidation_due_date; a verify event with a yesterday date causes the daily check to suspend the supplier on the next run, bypassing the AC5 lead-time window [src/compliance/msme.ts:210] - fixed: rejects with UDYAM_INVALID when revalidation_due_date < today
- [x] [Review][Patch] msmeEventMetadata sets occurred_at to wall-clock now() instead of scope.business_date, so a manual replay for a past business_date produces events dated 'now' [src/compliance/msme.ts:450] - fixed: occurred_at is now `${business_date}T00:00:00.000Z`
- [x] [Review][Patch] insertMsmeAgeingFeed has no ON CONFLICT/23505 catch on feed_id PK; a replayed or spoofed event aborts the transaction raw [src/compliance/msme.ts:403] - fixed: ON CONFLICT (feed_id) DO NOTHING on the ledger insert
- [x] [Review][Patch] applySupplierInvoicePoLink re-SELECTs invoice_date::text in addition to the in-memory invoice row, adding a round-trip per link [src/compliance/supplier-invoice.ts:1306] - fixed (folded into Decision 2: po_link no longer touches MSME columns, so the redundant SELECT was deleted)

Code review 2026-08-06 Group 3 (HTTP surface: msme.ts routes, supplier MSME capture handler, PO draft warning, server registrations, ERP feed payload builder, story-4-6 integration suite, 4-7 null pins, spine route pin, sprint status). Acceptance Auditor: all 9 carried verification points compliant except the spoof-test count. Edge Case Hunter: 11 candidates, 7 dismissed (repo conventions, documented by-design behavior, per-grain transaction pattern). Blind Hunter: no real defects in the diff; 12 candidates dismissed against canonical helpers and precedents (auditCtxFor is byte-identical to suppliers.ts:44-58; feed ledger is append-only per AC4; hardcoded success status in auditCtx is the repo-wide persistEvent convention).

- [x] [Review][Patch] Spoof tests covered only 3 of 4 new event types; supplier_invoice.statutory_breach_flagged never hit the central write path via POST /api/v1/events, violating the Task 10.1 mandatory spoof convention [test/integration/story-4-6.test.ts:1020] - fixed: added a spoof test posting a malformed breach payload (bad invoice_id, bad statutory_due_date) asserting 400 INVALID_PARAMS
- [x] [Review][Patch] Non-string revalidation_due_date (number, array, null) was silently overwritten with the one-year default and returned 200 instead of a client error [src/api/v1/suppliers.ts:684] - fixed: a present-but-non-string value now rejects with 400 INVALID_PARAMS before persistEvent
- [x] [Review][Patch] Past-date guard on revalidation_due_date compared against UTC today while every other calendar comparison in the module uses IST [src/compliance/msme.ts:214] - fixed: guard now uses istCalendarDate(new Date().toISOString())
- [x] [Review][Patch] Sweep-1 revalidation alert set occurred_at to wall-clock now, breaking the business_date anchor invariant the Group 2 fix established for the other two sweeps (a replayed check for a past date would emit an alert dated now) [src/compliance/msme.ts:530] - fixed: occurred_at anchored on scope.business_date like msmeEventMetadata
- [x] [Review][Decision] PO draft warning is assembled inline and spread into the 201 success envelope rather than thrown as a named MsmeSuspendedWarning class on the ZoneIncompatibleWarning catch-and-wrap precedent [src/api/v1/purchase-orders.ts:217] - accepted: AC7 functional contract held (warning_code MSME_SUPPLIER_SUSPENDED rides the success envelope, drafting persists, both response branches covered); the deviation is documented in the code comment and the check lives at handler level where no throw is needed
- [x] [Review][Defer] MSME ageing report has no pagination or row limit; response size grows with MSME invoice volume [src/read/projections/msme_ageing.ts:39] - deferred, pre-existing repo-wide pattern (all Phase 1 list endpoints are unbounded)

## Dev Notes

### Critical context (read before coding)

- **Story 4.7 pre-built your invoice hook.** Columns `msme_classification_at_capture`, `statutory_due_date`, `statutory_due_rule_version` exist on `supplier_invoice` (SQL lines 39-41, CHECK 68-71) and are pinned to null at two sites in `src/compliance/supplier-invoice.ts` (1167-1171, 1290-1293) with TODO comments naming this story. Story 4.7's Task 7 contract, verbatim requirements: reuse this story's accessor and dated rule contract, immutable capture-time snapshots, calendar-date arithmetic not elapsed milliseconds.
- **Story 4.4 named your PO hook:** "MSME due-date stamping is Story 4.6 (it stamps at PO confirmation - your `purchase_order.confirmed` event is its hook)". The seam is `applyPoConfirmed` at `src/compliance/purchase-order.ts:700-758`.
- **Two stamping anchors, one calculator:** PO stamping anchors on the confirmation IST business date; invoice stamping anchors on `invoice_date` (per epics 4.7 AC 5). Same `computeStatutoryDueDate` for both.
- **No payment state exists anywhere** (no `paid_at`, no settlement event; payment executes in ERP). "Outstanding" and "unpaid" therefore mean: invoice row exists with a statutory due date. State this in a code comment on the ageing query.
- **`msme_status` is not `supplier.status`.** Overloading `chk_supplier_status` breaks `applySupplierUpdated:564` and `updateSupplierBase:486` (`SUPPLIER_NOT_ACTIVE` gates). Separate columns, separate CHECK.
- **Error code `UDYAM_INVALID`** is new; de-facto registration is the throw site plus the integration-test assertion plus this artifact (spine error table is stale; 4.4/4.1 codes are also absent from it - do not try to update the spine).
- **DATE serialization deferral (deferred-work.md):** DATE columns serialize as shifted timestamps on non-UTC servers; no global type parser exists. Assert dates via `::text` in tests; return DATE as calendar strings from accessors (4.7 precedent).
- **Site-write scoping gap** is a known module-wide deferral (indents, POs, supplier-invoices all lack it); do not solve it here, inherit the current `requireRole` module/functionScope pattern.
- **AD-17:** revalidation alerts and breach escalations are statutory communications; use `emitNotificationInTransaction(input, client)` (`src/notify/emit.ts:124`), failures propagate. Existing supplier-domain caller to copy: `supplier.ts:482-496`.
- **ERP boundary (AD-4):** the ageing feed never talks to ERP; the recorded `msme_ageing_feed` row IS the deliverable (identical philosophy to `po_outbound_message`, `po-outbound.ts:1-10`).
- **Scheduler reality:** no cron exists. Daily check is a synthetic HTTP trigger (`planning-jobs.ts` doc 17-27) callable by a real scheduler later. Timers in `server.ts:503-578` start only inside `startServer()`; tests drive cycles explicitly.
- **`persistEvent` is the only domain write path** (`store.ts:343`): validate, project, event insert, audit row, one transaction. Every applier opens with the module-local `alreadyPersisted` guard (plain SELECT; `FOR UPDATE` on `domain_events` causes 42501 for `app_user`).
- **Money and dates in SQL NUMERIC/DATE**, never JS floats or Date arithmetic across DST; accessors return NUMERIC as strings.
- **23505 handling:** catch must check `err.constraint` specifically or the aborted transaction surfaces raw `25P02` 500s.
- Stack pins: Node 24 LTS, TypeScript ^5.8 ESM, `pg` ^8.16.0, `node:test` only, PostgreSQL 18.4. **No new dependencies.**

### Source tree touch list

The touch-list table below maps every file this story changes or creates.

| File | Change |
| --- | --- |
| `read/projections/supplier.sql` | UPDATE: guarded MSME columns plus CHECKs |
| `read/projections/purchase_order.sql` | UPDATE: guarded statutory columns |
| `read/projections/supplier_invoice.sql` | UPDATE: guarded `statutory_breach` column |
| `read/projections/msme_ageing_feed.sql` | NEW: append-only feed ledger |
| `deploy/compose/init-db.sql` | UPDATE: byte-identical mirror of all four |
| `src/events/migrate.ts` | UPDATE: append msme_ageing_feed entry |
| `src/events/schema.ts` | UPDATE: 4 payload/envelope ifaces plus SUPPORTED_EVENT_TYPES |
| `src/events/store.ts` | UPDATE: wire msme assert plus applier |
| `src/compliance/msme.ts` | NEW: events, rule calculator, accessor, daily check |
| `src/compliance/purchase-order.ts` | UPDATE: stamping in `applyPoConfirmed`, draft warning |
| `src/compliance/supplier-invoice.ts` | UPDATE: replace null stubs with stamping |
| `src/read/projections/supplier.ts` | UPDATE: row type plus `updateSupplierMsmeFields` |
| `src/read/projections/supplier_invoice.ts` | UPDATE: ageing accessor (or new `msme_ageing.ts`) |
| `src/read/projections/purchase_order.ts` | UPDATE: extra-fields passthrough if needed |
| `src/adapters/erp/msme-ageing-feed.ts` | NEW: pure payload builder |
| `src/api/v1/suppliers.ts` | UPDATE: MSME capture handler |
| `src/api/v1/msme.ts` | NEW: ageing report, feed run, daily check handlers |
| `src/server.ts` | UPDATE: route registrations |
| `src/config/index.ts` | UPDATE: `config.msme` block |
| `test/integration/story-4-6.test.ts` | NEW: full AC coverage |
| `test/integration/story-4-7.test.ts` | UPDATE: revise null pins plus header |
| `test/unit/schema-drift.test.ts` | UPDATE: EXPECTED entries |

### Project Structure Notes

- Canonical projection SQL lives at repo root `read/projections/`, NOT `src/read/projections/` (known 4.1 doc defect; do not propagate).
- Schema change ripple order: canonical SQL, then init-db mirror, then `migrate.ts`, then schema-drift EXPECTED, then schema.ts ifaces, then compliance module, then store wiring, then accessors, then API, then server routes, then tests.
- `git stash` can flip `deploy/compose/init-db.sql` to CRLF and break schema-drift; check line endings after any stash.
- Event naming: `snake_case_aggregate.past_tense_verb` on the closed `procurement` stream. External identifiers carry `_ext` suffix (`udyam_number_ext`).
- Warning-not-error precedent: `ZoneIncompatibleWarning` thrown from asserts, caught by handlers, wrapped into a 200 warning envelope (`store.ts:357-360`).
- Idempotency: central short-circuit returns existing event as 2xx no-op (`store.ts:516-529`); constraint mapping at `store.ts:790-840`.

### Testing standards summary

- `node:test` plus `node:assert/strict`, real PostgreSQL 18.4 on port 5442, `--test-concurrency=1`, per-run `run` suffix on external IDs.
- One `it` per AC branch, named `ACn: behavior`; negative paths assert exact `body.error_code`.
- Mandatory: direct `POST /api/v1/events` spoof tests for new event types; trailing idempotent-replay test; `::text` casts on DATE assertions.
- Gates: full suite green (except 14 documented pre-existing idempotency failures), `npm run lint` (no role-literal comparisons), `npm run spine-acceptance-contract`.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md#Story-4.6` (lines 1647-1685), Story 4.7 AC 5 at lines 1713-1715.
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (AD-3 DOA, AD-4 ERP boundary, AD-12 compliance spine, AD-14 projections, AD-16 idempotency, AD-17 notifications at line 166, event envelope at 278, error codes at 337).
- Prior artifacts: `_bmad-output/implementation-artifacts/4-7-supplier-invoice-capture.md` (Task 7 contract, gotchas), `4-4-purchase-order-management.md` (confirmation seam, outbound-message pattern).
- Deferred work: `_bmad-output/implementation-artifacts/deferred-work.md` (DATE serialization, site-write scoping, scheduler revisit).
- ADR: `docs/adr/ADR-001-notification-emission-coupling.md`.

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code.

### Implementation Plan

Schema ripple first (canonical SQL, init-db mirror, migrate list, schema-drift EXPECTED), then
the event vocabulary and rule module (`src/compliance/msme.ts` with the dated s.15 calculator and
the single `getSupplierMsmeContext` accessor), then the consumers in dependency order: supplier
capture API, PO confirmation stamping, draft warning, invoice stamping (4.7 stub closure), ageing
read model, ERP feed adapter plus ledger applier, daily compliance check, and finally the
integration suite.

### Debug Log References

- `npx tsc --noEmit` clean after each layer; `npm run lint` clean.
- First test run: unmatched-invoice creation attempted through `POST /api/v1/supplier-invoices`
  without `po_id`; that endpoint requires a PO (file-ingestion review is the only unmatched
  source per Story 4.7 AC2). Rewrote the AC3a link test through the ingestion stage/confirm path.
- Second run surfaced a real behavior worth recording: the unmatched recording ALREADY stamps the
  MSME snapshot (capture and unmatched share `insertCapturedOrUnmatchedInvoice`); the statutory
  obligation runs from the invoice date with or without a PO, so the stamp-at-record behavior was
  kept and the test asserts it explicitly.
- Spine gate initially failed on the story-1-9 route-surface pin (deepStrictEqual over the
  registered route list); the four new MSME routes were appended to `allowedSpineRoutes` under a
  Story 4.6 comment (same precedent as the Story 4.7 block). Gate then 6/6 green.

### Completion Notes List

- All 8 ACs plus AC3a implemented and covered by `test/integration/story-4-6.test.ts`
  (17 tests, one `it` per AC branch, spoof tests and trailing idempotent replay included).
- Documented assumption (Task 4.2, consistent across PO and invoice stamping): supplier
  `credit_period_days > 0` means an agreement exists (agreed date = anchor + credit period,
  capped at 45 days); `0`/null means no agreement (15-day appointed-day rule). The column is
  `NOT NULL DEFAULT 0`, so 0 is the no-agreement encoding.
- "Outstanding" in the ageing = invoice row with a non-null `statutory_due_date`; no payment
  state exists in this system (payment executes in ERP) - stated in a code comment on
  `queryMsmeAgeing`.
- MSMED s.16 interest is computed in SQL NUMERIC as
  `total_value * (power(1 + rate/1200, overdue_days/30) - 1)` (monthly compounding, pro-rata
  fractional months), rate from `config.msme.interestRatePercentAnnual` (default 27 = 3x RBI
  bank rate), never stored as a balance.
- The `msme_ageing_feed.recorded` applier re-derives the ageing and inserts the ledger row
  inside the persistEvent transaction (po_outbound pattern), so a direct event POST cannot
  create an event without its ledger row.
- Revalidation alerts dedupe on the `notification.created` payload
  (`object_type = 'supplier_udyam_revalidation'`, `object_id`, due date in `next_step`), so the
  daily check is idempotent per supplier per due date.
- Breach escalation targets role `finance_compliance_officer` (provisioned in the test fixtures
  via the standard `provisionUser` pattern); emitted through `emitNotificationInTransaction`
  inside the breach applier (AD-17).
- New error code `UDYAM_INVALID` registered de-facto: throw sites in `assertMsmeShape`,
  integration-test assertions, and this artifact (spine error table is stale by precedent).
- The 14 pre-existing idempotency 201-vs-409 failures remain and are documented as accepted;
  no new failures introduced.

### File List

- `read/projections/supplier.sql` (modified)
- `read/projections/purchase_order.sql` (modified)
- `read/projections/supplier_invoice.sql` (modified)
- `read/projections/msme_ageing_feed.sql` (new)
- `deploy/compose/init-db.sql` (modified)
- `src/events/migrate.ts` (modified)
- `src/events/schema.ts` (modified)
- `src/events/store.ts` (modified)
- `src/compliance/msme.ts` (new)
- `src/compliance/purchase-order.ts` (modified)
- `src/compliance/supplier-invoice.ts` (modified)
- `src/read/projections/supplier.ts` (modified)
- `src/read/projections/purchase_order.ts` (modified)
- `src/read/projections/msme_ageing.ts` (new)
- `src/adapters/erp/msme-ageing-feed.ts` (new)
- `src/api/v1/suppliers.ts` (modified)
- `src/api/v1/purchase-orders.ts` (modified)
- `src/api/v1/msme.ts` (new)
- `src/server.ts` (modified)
- `src/config/index.ts` (modified)
- `test/integration/story-4-6.test.ts` (new)
- `test/integration/story-4-7.test.ts` (modified)
- `test/integration/story-1-9.test.ts` (modified - route-surface pin extended with the four new MSME routes)
- `test/unit/schema-drift.test.ts` (modified)

## Change Log

- 2026-08-06: Story 4.6 implemented end to end - MSME schema fields and ageing feed ledger,
  Udyam verification API with UDYAM_INVALID gate, statutory due-date stamping at PO confirmation
  and invoice capture/link (closes Story 4.7 AC 5), classification-tagged ageing report with
  s.43B(h)/s.16 exposure, ERP ageing feed run, daily compliance check (revalidation alert, lapse
  suspension, breach flag and escalation), full integration suite (17 tests).
