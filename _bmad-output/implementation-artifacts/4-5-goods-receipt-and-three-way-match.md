---
baseline_commit: b32fe255491a35f9ac8156183401ec0f185d5413
---

# Story 4.5: Goods Receipt and Three-Way Match

Status: done

Baseline commit: `03d2ed2` plus the uncommitted working tree carrying the completed Story 4.6 (MSME) and Story 4.7 (invoice capture, 25 review patches) changes. Do not revert or stash that tree - it is the real baseline.

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created.

## Story

As a procurement officer,
I want to record goods receipts against POs with a QC trigger and run a three-way match across PO, receipt, and invoice with tolerance checks,
so that we only pay for what was ordered and received, and discrepancies are caught before payment.

Source: `_bmad-output/planning-artifacts/epics.md` lines 1618-1650 (Epic 4, Story 4.5).

## Acceptance Criteria

1. **GRN posting consumes Story 3.4, QC trigger fires (FR-P-06).** Given an issued PO from Story 4.4 and physical receiving captured through Story 3.4, when the procurement GRN is posted against the PO, then the GRN consumes Story 3.4's receiving events (gate-token chain, lot and expiry capture) without re-entry, received quantities post into QC Hold status where the item requires inspection and a QC inspection task is raised (FR-Q-02 integration point; the QC gate itself is Epic 8 - Story 8.1), and a `GoodsReceived` event is written with lot and quantity detail.
2. **Three-way match with tolerances (FR-P-07).** Given a GRN, its source PO, and a supplier invoice captured through Story 4.7, when the three-way match is run, then quantity and price are compared across all three documents and a match passes only when differences fall within configured tolerance.
3. **Out-of-tolerance blocks payment clearance.** Given a three-way match falls outside tolerance, when the match completes, then the match record is set to `blocked` with `error_code: "MATCH_OUT_OF_TOLERANCE"`, the invoice is excluded from the payment-clearance feed to ERP (payment executes in ERP; the block is effected by withholding clearance through the `adapters/erp` channel), and the block is lifted only by a credit note or debit note, each recorded to the edit log (FR-AC-13).
4. **No GRN without a source PO.** Given a GRN is created without a valid source PO reference, when the receipt is attempted, then it is blocked with `error_code: "SOURCE_DOCUMENT_REQUIRED"`.

Boundary note (authoritative, from epics.md): Story 3.4 owns physical receiving capture - the gate-token chain (AD-2), lot/serial/expiry entry, and putaway tasks. Story 4.5 owns the procurement and financial side: PO-matching GRN posting, QC Hold stock status, and the three-way match. This story never re-implements physical capture; it consumes Story 3.4's receiving events. Until Story 4.4's native POs went live, Story 3.4 received against the read-only open-PO reference projections from Story 2.9 (ERP inbound) - that path stays working.

## Binding Scope Decisions

The dev agent must not silently choose alternatives to these decisions.

1. **AC1 is mostly already built - consume, do not re-implement.** Story 3.4 shipped the GRN (`grn`/`grn_line` tables, `goods.received` and `goods.putaway_released` events), QC-hold routing (`ZONE-QC-HOLD`, `qc_hold=true`, line status `quarantined`, held putaway task plus `qc_hold_placed` notification to `qc_inspector` as the interim QC-inspection task - see the comment at `src/compliance/receiving.ts:687-698`), and receipt tolerance checks in PostgreSQL NUMERIC. There is no durable `qc_inspection_task` table and none is built here (Epic 8). Story 4.5's AC1 delta is exactly one thing: binding a GRN to a **native Story 4.4 PO** (`purchase_order.po_id`), because 3.4 only knows the Story 2.9 ERP reference (`grn.po_ref_ext` TEXT matching `erp_purchase_order.po_number_ext`). Do not create a parallel receipt entity, do not add new receiving capture routes, do not touch the gate-token chain.
2. **Native-PO binding is a new event, additive column, and one route.** Add nullable `grn.po_id UUID` (guarded additive ALTER), a `grn.po_linked` event, and `POST /api/v1/grns/:grnId/link-po`. `po_ref_ext` keeps working for ERP-originated POs; a GRN may carry both. Seam guard: linking requires the PO to exist and be in status `issued` or `confirmed`, else `SOURCE_DOCUMENT_REQUIRED` (409). AC4's "GRN created without a valid source PO reference" is already enforced at physical capture by 3.4 (`RECEIVING_PO_NOT_FOUND` against the ERP projection); 4.5 enforces the procurement-side variant: a three-way match run or a link-po attempt without a valid PO fails with `SOURCE_DOCUMENT_REQUIRED`.
3. **Story 4.7 contract to honor verbatim:** "Story 4.5 must reject any three-way-match attempt while status is `unmatched` with `SOURCE_DOCUMENT_REQUIRED`." `test/integration/story-4-7.test.ts:21` records this as a visibly blocked consumer check - implement it and un-document the gap.
4. **No payment state exists anywhere** (no `paid_at`, no settlement event; `src/read/projections/msme_ageing.ts:7-8` states this). "Excluded from payment clearance" therefore means: the invoice row is omitted from the generated clearance feed payload while its match status is `blocked`. Build a new `payment_clearance_feed` append-only ledger and adapter mirroring `msme_ageing_feed` exactly (payload builder plus JSONB ledger row written inside the same `persistEvent` transaction; live transmission is per-deployment config and out of scope, AD-4). The MSME ageing feed is NOT a clearance feed - do not overload it.
5. **`supplier_invoice.status` CHECK stays `('unmatched','captured')`.** Match state is an orthogonal additive column `match_status TEXT NULL CHECK (match_status IN ('passed','blocked','lifted'))` (guarded ALTER plus guarded DO block), following the Story 4.6 `statutory_breach` precedent. NULL means never matched. Never widen `chk_supplier_invoice_status`.
6. **Credit and debit notes are owned by this story** (4.7 explicitly deferred them). They are additive events only (`supplier_invoice.credit_note_recorded`, `supplier_invoice.debit_note_recorded`) - no invoice row is ever deleted or its captured financial snapshot mutated. Recording a note against a blocked match sets the match record and the invoice `match_status` to `lifted`. The FR-AC-13 "edit log" is the existing statutory `audit_log` (Story 1.3) - every mutating route already writes it via `logAuditEntry`/`auditCtxFor`; no new edit-log mechanism.
7. **Tolerances live in config, not code:** new `config.threeWayMatch` block (`src/config/index.ts`), env-backed via the existing parsers. Per-PO-line receipt tolerances (`erp_purchase_order_line.over_receipt_tolerance_pct`) are Story 3.4's receiving concern - a different check with a different error code (`RECEIPT_TOLERANCE_EXCEEDED`). Do not conflate them with match tolerances.
8. **Match comparison runs in PostgreSQL NUMERIC, never JS floats** (Story 4.4 DOA lesson). All NUMERIC values cross the wire as strings.
9. **PO closure does not exist and is not built here** (4.4 deliberately excluded it). The match neither closes POs nor requires closure. Design nothing that blocks a future closure event.
10. **No edge/offline path.** Procurement match routes are online-only; do not touch `src/sync/upload.ts`, `edge/`, or `PERMANENT_ERROR_CODES`.

## Tasks / Subtasks

- [x] Task 1: Canonical schema - new tables and additive columns (AC: 1, 2, 3)
  - [x] 1.1 Create `read/projections/three_way_match.sql`: table `three_way_match` at grain `match_id UUID PRIMARY KEY`. Columns: `match_id UUID`, `invoice_id UUID NOT NULL`, `po_id UUID NOT NULL`, `site_id UUID`, `business_stream TEXT`, `status TEXT NOT NULL` CHECK `('passed','blocked','lifted')` (named `chk_three_way_match_status`, guarded DO block), `error_code TEXT`, `variance_detail JSONB NOT NULL` (per-line quantity/price variances plus the tolerance snapshot used), `tolerance_rule_version TEXT NOT NULL`, `lifted_note_id UUID`, `lifted_note_type TEXT` CHECK `('credit_note','debit_note')` guarded, `run_by UUID NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL`, `lifted_at TIMESTAMPTZ`, `source_event_id UUID NOT NULL`, `created_at`/`updated_at` defaults. Indexes: `idx_three_way_match_invoice (invoice_id)`, `idx_three_way_match_po (po_id)`, partial `idx_three_way_match_blocked (status) WHERE status = 'blocked'`. Grants: `INSERT, SELECT, UPDATE` to `app_user`, `SELECT` to `readonly_user`, guarded DO blocks. Copy the idempotent header comment style of `read/projections/supplier_invoice.sql`.
  - [x] 1.2 Create `read/projections/payment_clearance_feed.sql`: append-only ledger `payment_clearance_feed (feed_id UUID PRIMARY KEY, payload JSONB NOT NULL, row_count INTEGER NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now())`, grants `INSERT, SELECT` to `app_user` only, `SELECT` to `readonly_user` - byte-level mirror of the `msme_ageing_feed` ledger pattern (`read/projections/msme_ageing_feed.sql`).
  - [x] 1.3 Additive ALTERs with story-tagged comments (Story 4.6 precedent, `supplier_invoice.sql:194-197`): in `read/projections/grn.sql` append `ALTER TABLE IF EXISTS grn ADD COLUMN IF NOT EXISTS po_id UUID` plus `CREATE INDEX IF NOT EXISTS idx_grn_po_id ON grn (po_id)`; in `read/projections/supplier_invoice.sql` append `ALTER TABLE IF EXISTS supplier_invoice ADD COLUMN IF NOT EXISTS match_status TEXT` plus a guarded DO block adding `chk_supplier_invoice_match_status CHECK (match_status IS NULL OR match_status IN ('passed','blocked','lifted'))` plus partial index `idx_supplier_invoice_match_blocked ON supplier_invoice (match_status) WHERE match_status = 'blocked'`.
  - [x] 1.4 Mirror every statement byte-identically into `deploy/compose/init-db.sql` under `-- MUST stay identical to read/projections/<file>.sql (canonical source).` headers. Keep LF endings.
  - [x] 1.5 Append `three_way_match.sql` and `payment_clearance_feed.sql` to `MIGRATIONS` in `src/events/migrate.ts` (tail; order matters).
  - [x] 1.6 Add `EXPECTED` entries in `test/unit/schema-drift.test.ts` for both new tables (constraints, indexes, grants) and extend the existing `grn` and `supplier_invoice` entries' additive-fragment assertions (Story 4.6 added drift blocks asserting ADD COLUMN fragments - follow that mechanism). Run `npm run db:migrate` twice against the dev DB to prove idempotence.
- [x] Task 2: Event contracts in `src/events/schema.ts` (AC: 1, 2, 3)
  - [x] 2.1 Add payload plus envelope interfaces (the `Omit<EventEnvelope,'payload'>` idiom): `GrnPoLinkedPayload` (`grn_id`, `po_id`, `po_number_ext`, `linked_by?` server-set), `ThreeWayMatchRecordedPayload` (`match_id`, `invoice_id`, `po_id`, `grn_ids: string[]`, `result: 'passed'|'blocked'`, `error_code?`, `variance_detail` with per-line `{ line_no, sku, po_qty, received_qty, invoice_qty, qty_variance_pct, po_unit_price, invoice_unit_price, price_variance_pct }` all NUMERIC-as-string, `tolerance_snapshot { quantity_pct, price_pct, invoice_value_abs, rule_version }`, `run_by?` server-set), `SupplierInvoiceCreditNoteRecordedPayload` and `SupplierInvoiceDebitNoteRecordedPayload` (`note_id`, `invoice_id`, `match_id`, `note_number_ext`, `amount` NUMERIC-as-string, `reason`, `recorded_by?` server-set), `PaymentClearanceFeedRecordedPayload` (`feed_id`, `generated_at`, `row_count`, `correlation_id`) mirroring `MsmeAgeingFeedRecordedPayload`.
  - [x] 2.2 Tail-append to `SUPPORTED_EVENT_TYPES` (never reorder): `grn.po_linked`, `three_way_match.recorded`, `supplier_invoice.credit_note_recorded`, `supplier_invoice.debit_note_recorded`, `payment_clearance_feed.recorded` - all `streamType: 'procurement'`, all `requiresBusinessStream: false` (site and stream are stamped into projections from the PO/invoice rows, matching the Story 4.6 pattern).
- [x] Task 3: Config block (AC: 2)
  - [x] 3.1 In `src/config/index.ts` add `threeWayMatch: { quantityTolerancePercent, priceTolerancePercent, invoiceValueToleranceAbsolute, ruleVersion }` using `parsePositiveNumberEnv('MATCH_QTY_TOLERANCE_PCT', 2)`, `parsePositiveNumberEnv('MATCH_PRICE_TOLERANCE_PCT', 2)`, `parsePositiveNumberEnv('MATCH_INVOICE_VALUE_TOLERANCE_ABS', 100)`, and a dated `ruleVersion` string from env `MATCH_TOLERANCE_RULE_VERSION` defaulting to `'2026-08-fy27'` (mirror the `config.msme.ruleVersion` IIFE validation at `src/config/index.ts:202-219`). Treat empty-string env as undefined (4.6 review patch).
- [x] Task 4: Compliance module `src/compliance/three-way-match.ts` (AC: 1, 2, 3, 4)
  - [x] 4.1 Export the canonical three symbols for the five new event types: `threeWayMatchEventType(envelope)`, `assertThreeWayMatchShape(envelope)` (pre-transaction, consumes no idempotency key), `applyThreeWayMatchProjection(envelope, client, eventId)`, plus module-local `alreadyPersisted` as a plain `SELECT` (never `FOR UPDATE` on `domain_events` - live 42501 defect in `supplier.ts`; serialize via `FOR UPDATE` on the entity row).
  - [x] 4.2 `grn.po_linked` applier: `SELECT ... FOR UPDATE` the `grn` row (via a new `getGrnByIdForUpdate` or extend `src/read/projections/grn.ts`), require the PO to exist in `purchase_order` with status `issued` or `confirmed` (`getPurchaseOrderById(poId, client, true)` from `src/read/projections/purchase_order.ts`), else reject `SOURCE_DOCUMENT_REQUIRED`. First-stamp-wins on `grn.po_id` via `COALESCE(po_id, $n)` (4.6 precedent) - a GRN re-link to a different PO rejects with `SOURCE_DOCUMENT_REQUIRED` and detail `already_linked`.
  - [x] 4.3 `three_way_match.recorded` applier - the match computation, entirely in SQL NUMERIC inside the persist transaction: (a) load and `FOR UPDATE` the invoice (`status` must be `captured` with non-null `po_id`, else reject `SOURCE_DOCUMENT_REQUIRED` - this is the 4.7 AC4 contract); (b) collect GRNs bound to the same `po_id` (`grn.po_id = invoice.po_id`), require at least one with status `posted`, else `SOURCE_DOCUMENT_REQUIRED` with detail `no_grn`; (c) per PO line (`purchase_order_line`), compare `ordered_qty` vs cumulative `grn_line.received_qty` (statuses `posted` and `quarantined` count as received; `rejected` never counts) vs `supplier_invoice_line.quantity` (join on `po_line_id`, fall back to `line_no`), and `purchase_order_line.unit_price` vs `supplier_invoice_line.unit_price`; (d) a line passes when both quantity variance percent and price variance percent are within `config.threeWayMatch` tolerances and the header check `ABS(invoice.total_value - SUM(matched line values))` is within `invoiceValueToleranceAbsolute`; (e) all lines pass: insert `three_way_match` row `status='passed'`, set invoice `match_status='passed'`; any failure: `status='blocked'`, `error_code='MATCH_OUT_OF_TOLERANCE'`, invoice `match_status='blocked'`; (f) idempotent on `match_id` (`ON CONFLICT (match_id) DO NOTHING` plus the `alreadyPersisted` guard); a re-run after a lift is a NEW `match_id`.
  - [x] 4.4 Credit/debit note appliers: require an existing `three_way_match` row for `match_id` with `status='blocked'` (`FOR UPDATE`), else reject `MATCH_NOT_BLOCKED` (409); require non-empty trimmed `reason` and positive NUMERIC `amount` with scale 2; set match `status='lifted'`, `lifted_note_id`, `lifted_note_type`, `lifted_at` from `metadata.occurred_at`, and invoice `match_status='lifted'`. Notes are immutable once recorded (idempotent on `note_id`).
  - [x] 4.5 `payment_clearance_feed.recorded` applier: insert the ledger row (`ON CONFLICT DO NOTHING`) exactly as `src/compliance/msme.ts:402-420` does for the ageing feed.
  - [x] 4.6 Wire the module into the `persistEvent` dispatch in `src/events/store.ts` exactly where `src/compliance/msme.ts` is wired (assert in the pre-transaction block, apply in the same transaction as the `domain_events` insert - AD-14/AD-16).
- [x] Task 5: Read model `src/read/projections/three_way_match.ts` (AC: 2, 3)
  - [x] 5.1 Mirror `src/read/projections/msme_ageing.ts`/`supplier_invoice.ts` conventions: `Queryable` plus `runner(client?)`, `THREE_WAY_MATCH_COLUMNS`, `UUID_REGEX` guard, `getMatchById`, `getLatestMatchByInvoiceId`, `listMatches` filters (`invoice_id`, `po_id`, `status`, limit cap 200), NUMERIC as strings, DATE/TIMESTAMPTZ per house style, `permittedLocationsForModuleScope(roles, 'procurement', 'read')` where site scoping applies.
  - [x] 5.2 Add `listClearanceEligibleInvoices(client)`: invoices with `status='captured'` and `match_status IN ('passed','lifted')`, returning the fields the feed payload needs (invoice id/number, supplier, po_number_ext, total_value, statutory_due_date, msme_classification_at_capture). Blocked and never-matched invoices are excluded - clearance requires a passed or lifted match.
- [x] Task 6: ERP adapter `src/adapters/erp/payment-clearance-feed.ts` (AC: 3)
  - [x] 6.1 `PaymentClearanceFeedPayload { feed_type: 'payment_clearance', generated_at, row_count, lines[], correlation_id }` plus `buildPaymentClearanceFeedPayload(rows, generatedAt, correlationId)` plus `insertPaymentClearanceFeed` - structural clone of `src/adapters/erp/msme-ageing-feed.ts:35`. Pure payload builder; the ledger row inside the same `persistEvent` transaction IS the deliverable (AD-4). Never touch `src/adapters/erp/sync.ts` or any `erp_`-prefixed table (`SOURCE_SYSTEM_READ_ONLY`).
- [x] Task 7: API routes plus registration (AC: 1, 2, 3, 4)
  - [x] 7.1 Create `src/api/v1/three-way-match.ts` copying the `ActorContext`/`actorContext(req)`/`auditCtxFor(req, actor, httpStatus)` boilerplate from `src/api/v1/purchase-orders.ts`. Handlers: `POST /api/v1/grns/:grnId/link-po` (body `{ po_id }`; emits `grn.po_linked`; 404 `GRN_NOT_FOUND` when the GRN id is unknown, 409 `SOURCE_DOCUMENT_REQUIRED` per Task 4.2), `POST /api/v1/three-way-match/run` (body `{ invoice_id }`; server generates `match_id`; emits `three_way_match.recorded`; the HTTP response carries the match result including `status` and `variance_detail`; a blocked outcome is still HTTP 201 - the match RECORD succeeded; 409 `SOURCE_DOCUMENT_REQUIRED` only when the run is rejected outright per Task 4.3a/b), `GET /api/v1/three-way-match` (list, filters), `GET /api/v1/three-way-match/:matchId`, `POST /api/v1/supplier-invoices/:invoiceId/credit-note` and `POST /api/v1/supplier-invoices/:invoiceId/debit-note` (body `{ match_id, note_number_ext, amount, reason }`; 409 `MATCH_NOT_BLOCKED`), `POST /api/v1/compliance/payment-clearance-feed/run` (mirrors `src/api/v1/msme.ts:99-110`: build payload from Task 5.2 rows, emit `payment_clearance_feed.recorded`).
  - [x] 7.2 RBAC descriptors: all `module: 'procurement'`; reads `functionScope: 'read'`, writes `functionScope: 'write'`; the clearance-feed run and note routes follow the `src/api/v1/msme.ts:167-179` descriptor shape. No role-name literals anywhere (`test/unit/no-hardcoded-role-in-workflow.test.ts` plus eslint rule enforce this).
  - [x] 7.3 Register routes in `createAppRouter()` (`src/server.ts`) under a `// Story 4.5: goods receipt and three-way match` comment after the MSME block (`server.ts:437-439`), and append every new route to the sorted `allowedSpineRoutes` array in `test/integration/story-1-9.test.ts` (deepStrictEqual pin - 4.6 failed the spine gate here first; expect `npm run spine-acceptance-contract` 6/6).
- [x] Task 8: Integration tests `test/integration/story-4-5.test.ts` (AC: 1, 2, 3, 4)
  - [x] 8.1 Model on `test/integration/story-4-6.test.ts` harness: real PostgreSQL on `DB_PORT=5442`, `node:test` plus `node:assert/strict`, `--test-concurrency=1`, canonical SQL applied in `migrate.ts` order via `getAdminPool()`, audit-trigger disable plus `TRUNCATE ... CASCADE` in try/finally, SCIM `provisionUser` fixtures, `run = randomUUID().slice(0,8)` suffixes, port-0 server, events seeded through real API routes (indent, PO draft/approve/issue via 4.4 routes; invoice staged/captured via 4.7 routes; GRN via 3.4 receiving route or direct `goods.received` persist where the receiving preconditions are too heavy - prefer the API).
  - [x] 8.2 Cover, one `it('ACn: ...')` per branch: AC1 - GRN linked to a native issued PO carries `po_id`, existing 3.4 QC-hold behavior asserted as consumed (a `qc_hold=true` line exists, no new capture route added); AC2 - in-tolerance match passes (`status='passed'`, invoice `match_status='passed'`, NUMERIC asserted as strings); AC2 - quantity within tolerance boundary exactly at the configured percent passes (boundary test); AC3 - price out of tolerance blocks (`status='blocked'`, `error_code='MATCH_OUT_OF_TOLERANCE'`), blocked invoice absent from a subsequently generated clearance-feed payload, passed invoice present; AC3 - credit note lifts the block (`match_status='lifted'`, row re-enters the next feed payload), audit rows exist for note routes; AC3 - debit note path; AC3 - note against a non-blocked match rejects `MATCH_NOT_BLOCKED`; AC4 - match run against an `unmatched` invoice rejects 409 `SOURCE_DOCUMENT_REQUIRED` (the 4.7 contract test - also remove the "visibly blocked" comment at `test/integration/story-4-7.test.ts:21` and assert the real behavior there or here); AC4 - link-po to a nonexistent or draft PO rejects `SOURCE_DOCUMENT_REQUIRED`; idempotent replay of each new event type (accept the pre-existing 201-vs-409 surface split, pin row counts); mandatory direct `POST /api/v1/events` spoof test per new event type (payload actor fields must reconcile with envelope actor - the 4.7 audit-fork lesson).
  - [x] 8.3 Negative-path unit coverage where cheap (tolerance arithmetic edge: zero ordered_qty guard, NUMERIC scale rejects, trailing-junk query params - use the `Number.parseInt` lessons from 4.7).
- [x] Task 9: Verification gates (all ACs)
  - [x] 9.1 `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice (idempotence), `npm test` (0 new failures; 14 pre-existing idempotency failures are known), `npm run spine-acceptance-contract` (6/6), schema-drift green, no-hardcoded-role green, `git diff --check`, then `graphify update .`.
  - [x] 9.2 Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `4-5-goods-receipt-and-three-way-match: review`. Note any deferred work in `_bmad-output/implementation-artifacts/deferred-work.md`.

### Review Findings

From the 2026-08-06 adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor, full diff against baseline `b32fe25` working tree):

- [x] [Review][Patch] GRN-to-PO link validates only PO existence and status, never content correspondence — a GRN received against ERP PO X can be linked to any live native PO Y (different supplier or SKUs), and its receipts then count toward Y's match [src/compliance/three-way-match.ts:193-228]. RESOLVED 2026-08-06 as a deferral: a strict `po_ref_ext` supplier-correspondence check needs an ERP-side identifier in the governed supplier's namespace, but `erp_purchase_order` carries only `supplier_ref_ext` (the ERP's own code) and the governed supplier carries `gstin_ext` + `owner_party_code` - three namespaces with no direct mapping in the current schema (same shape as the Story 2.9 owner-party referential lesson at `src/compliance/ownership.ts:221-226`). The defensible correspondence check needs a dedicated mapping table, which is a separate work item. Until that mapping exists, the applier relies on the spec-mandated PO existence + status check only.
- [x] [Review][Patch] Note lift can target a superseded blocked match: `applyNoteRecorded` checks only that the nominated match is blocked, then unconditionally sets the invoice mirror to `lifted` even when a NEWER run is still blocked, so the invoice re-enters the clearance feed; the note path also never locks the invoice row, so a concurrent match run races the mirror update (match run locks the invoice at line 242, note path locks only the match row) [src/compliance/three-way-match.ts:375-413]. APPLIED 2026-08-06: `applyNoteRecorded` now locks the invoice `FOR UPDATE` FIRST, verifies the nominated match is the LATEST run for the invoice (a superseded blocked match rejects 409 with `latest_match_id`), and only then lifts; the mirror update happens inside the same transaction under the invoice lock.
- [x] [Review][Patch] Duplicate `match_id` replay desynchronizes the mirror: `insertThreeWayMatch` is `ON CONFLICT DO NOTHING` (old row kept) but `updateSupplierInvoiceMatchStatus` still runs with the newly computed status, so `three_way_match.status` and `supplier_invoice.match_status` can disagree and clearance follows the mirror [src/compliance/three-way-match.ts:332-349, src/read/projections/three_way_match.ts:355-382]. APPLIED 2026-08-06: `insertThreeWayMatch` returns the rowCount and the applier skips the mirror update (returns early) when the insert conflicted.
- [x] [Review][Patch] Tolerance pass/fail is decided in JS via `Number()` on 6-decimal ROUNDED variances, violating Binding Decision 8 (no JS floats in the match computation) and this module's own doc comment; a true variance fractionally above tolerance rounds down and passes [src/read/projections/three_way_match.ts:218-225 and 296-316, src/compliance/three-way-match.ts:296-297]. APPLIED 2026-08-06: the SQL now computes `qty_within_tolerance`, `price_within_tolerance`, and `invoice_value_within_tolerance` as exact NUMERIC booleans against the unrounded expressions; TypeScript maps the booleans to `failure_reason` and never compares a NUMERIC-as-string to a tolerance. The rounded pct strings remain as display/audit values only.
- [x] [Review][Patch] `GET /api/v1/compliance/payment-clearance-feed/eligible` is not site-scoped (no `permittedLocationsForModuleScope`, no row limit), unlike `listMatches`/`getMatch`; any procurement reader sees every site's clearance-eligible invoices. The route is also an eighth route beyond the seven in Task 7.1 [src/api/v1/three-way-match.ts:444-452, src/read/projections/three_way_match.ts:429-458]. APPLIED 2026-08-06: `listClearanceEligibleInvoices` now takes an optional `permittedSites` and filters `si.site_id = ANY(...)`; the read route passes it, the feed builder omits it (the ERP clearance feed is a global deliverable, matching the msme_ageing_feed precedent).
- [x] [Review][Patch] PO liveness reads skip the spec-specified `FOR UPDATE` lock: Task 4.2 requires `getPurchaseOrderById(poId, client, true)` but both appliers call it unlocked [src/compliance/three-way-match.ts:205 and 258]. APPLIED 2026-08-06: both call sites now pass `true`.
- [x] [Review][Patch] The `line_no` fallback joins invoice lines to PO lines without SKU agreement in all three places (matched-line CTE, orphan check, header total), so an invoice line billing a different SKU on the same line number counts as matched [src/read/projections/three_way_match.ts:202-203, 259-260, 279-280]. APPLIED 2026-08-06: every fallback condition is now `AND sil.sku = pol.sku`.
- [x] [Review][Patch] Idempotent-replay coverage is missing for 3 of the 5 new event types (Task 8.2: "idempotent replay of each new event type"): the suite replays only `grn.po_linked` and `supplier_invoice.debit_note_recorded`; the match "replay" test asserts a new `match_id` (a new run, not a replay), and no replay test exists for `three_way_match.recorded` (same `match_id`), `supplier_invoice.credit_note_recorded`, or `payment_clearance_feed.recorded` [test/integration/story-4-5.test.ts:1265-1324]. APPLIED 2026-08-06: replay tests now exist for all 5 event types (see `review P2`, `review P8`, `review feed-replay` below).
- [x] [Review][Patch] Note replay with the same `note_id` but different `match_id`/amount/type is silently accepted as a no-op 201 - the existing-note guard returns before any consistency check [src/compliance/three-way-match.ts:366-373]. APPLIED 2026-08-06: on a `note_id` hit, the stored payload fields (`match_id`, `invoice_id`, `note_number_ext`, `amount`, `note_type`) are compared to the incoming payload; a mismatch rejects 409 `DUPLICATE_EVENT`.
- [x] [Review][Patch] `note_number_ext` has no duplicate detection: two notes with distinct server-generated `note_id`s but the same external note number (a real ERP duplicate) both record, and the second can lift a DIFFERENT blocked match, so one physical credit note can clear two invoices [src/compliance/three-way-match.ts:352-415]. APPLIED 2026-08-06: a uniqueness probe on `(invoice_id, btrim(note_number_ext))` against `domain_events` rejects duplicates 409 `DUPLICATE_EVENT` before the match/state checks.
- [x] [Review][Patch] A note against a nonexistent match returns 409 `MATCH_NOT_BLOCKED` with message "Three-way match not found" - a missing resource mapped to a state-conflict code, inconsistent with the 404 `MATCH_NOT_FOUND` used by the get route [src/compliance/three-way-match.ts:376-378]. APPLIED 2026-08-06: the null-match branch now returns 404 `MATCH_NOT_FOUND`.
- [x] [Review][Patch] Event contract interfaces drift from the stored payload: `ThreeWayMatchLineVariance` documents `failure_reason` as `'quantity' | 'price' | 'unmatched_line'` but the implementation emits `'ambiguous_sku'`; `unmatched_invoice_lines` and `invoice_value_within_tolerance` are stored but not declared in `ThreeWayMatchVarianceDetail` [src/events/schema.ts:1255-1285 vs src/compliance/three-way-match.ts:307-315]. APPLIED 2026-08-06: the interfaces now declare `'ambiguous_sku'`, `unmatched_invoice_lines`, `invoice_value_within_tolerance`, and `note_type` on the note payload.
- [x] [Review][Defer] Three-way-match write routes perform no site-write authorization [src/api/v1/three-way-match.ts:459-497] — deferred, pre-existing procurement-module-wide pattern already logged in deferred-work.md (dev-story 4-5 entry; "Known inherited gaps" in Dev Notes).
- [x] [Review][Defer] Receipts aggregate at SKU grain, so a PO repeating one SKU across lines fails closed with `ambiguous_sku` [src/read/projections/three_way_match.ts:171-176] — deferred, by design, already logged in deferred-work.md (dev-story 4-5 entry).
- [x] [Review][Defer] Client-controlled `occurred_at` reaches statutory timestamps (`recorded_at`, `lifted_at`) via direct POST /api/v1/events [src/compliance/three-way-match.ts:344 and 400] — deferred, pre-existing platform-wide event-sourcing convention: `events.ts` re-stamps the actor from auth but never `occurred_at`, for every event type.

## Dev Notes

### Critical context (read before coding)

- **Write path law:** `persistEvent` (`src/events/store.ts:334`) is the ONLY domain write. Shape asserts run pre-transaction and never consume an idempotency key (`store.ts:365-487`); appliers run in the SAME transaction as the `domain_events` insert (AD-14/AD-16). Idempotency short-circuit at `store.ts:516-529`; constraint-to-error mapping at `store.ts:790-840` - map the new unique/check constraints there or violations surface as raw 500s (a 4.7 review finding). The 23505 catch must check `err.constraint` specifically; a blind swallow leaves an aborted transaction that then throws `25P02` (4.7 lesson).
- **Compliance module contract:** exactly three exports plus module-local `alreadyPersisted` plain SELECT. Study `src/compliance/msme.ts` (closest analog: multiple event types, feed ledger, first-stamp-wins `COALESCE`) and `src/compliance/purchase-order.ts` (`applyPoIssued`/`applyPoConfirmed` around lines 700-758).
- **Match data topology:** `purchase_order_line (po_line_id, po_id, line_no, sku, ordered_qty NUMERIC(14,3), unit_price NUMERIC(14,4), line_value)`; `supplier_invoice_line (invoice_line_id, invoice_id, line_no, po_line_id NULL, sku, quantity NUMERIC(14,3), unit_price NUMERIC(14,4), line_total)`; `grn_line (grn_line_id, grn_id, po_ref_ext, line_no, sku, received_qty NUMERIC(18,3), status IN ('posted','quarantined','rejected'), qc_hold BOOLEAN)`. GRN lines join to native PO lines through `grn.po_id` (new) plus `line_no`/`sku` - `grn_line` itself keeps `po_ref_ext` untouched. Invoice lines join through `po_line_id` when present (manual capture guarantees it; file-review lines may carry NULL - fall back to `line_no`, and treat an unjoinable invoice line as a match failure with detail `unmatched_line`, not a crash).
- **Received quantity for match purposes** = SUM of `grn_line.received_qty` where status IN `('posted','quarantined')` across all GRNs bound to the PO. Quarantined stock was physically received; QC disposition is Epic 8's problem. `rejected` lines never count.
- **`SOURCE_DOCUMENT_REQUIRED` does not exist in src/ yet** - grep confirms the only occurrence is the 4.7 test comment. You introduce it (HTTP 409). `MATCH_OUT_OF_TOLERANCE` is not an HTTP error - it is a value in the match record and event; the run route returns 201 with the blocked record.
- **Error codes are registered de-facto** (throw site plus integration-test assertion) - there is no registry file, and the spine error table is stale; do not update it. New codes this story: `SOURCE_DOCUMENT_REQUIRED` (409), `MATCH_NOT_BLOCKED` (409), `GRN_NOT_FOUND` (404). Reused: `PO_NOT_FOUND`, `SUPPLIER_INVOICE_NOT_FOUND`, `INVALID_PARAMS`, `FUNCTION_ACCESS_DENIED`.
- **Feeds pattern:** the ledger row written inside the persist transaction IS the ERP deliverable (AD-4). See `src/adapters/erp/msme-ageing-feed.ts` end-to-end: builder, `insertMsmeAgeingFeed`, driven by `src/api/v1/msme.ts:99-110`, applied at `src/compliance/msme.ts:402-420`, route registered at `src/server.ts:437`.
- **Timestamps:** statutory/derived dates use `${business_date}T00:00:00.000Z` semantics, never wall clock, and reject past-dated statutory inputs where applicable (4.6 lessons). `occurred_at` comes from the envelope metadata. Assert DATE columns via `::text` in tests (non-UTC server drift, standing deferral).
- **Known inherited gaps - inherit, do not fix here:** site-write scoping is absent on procurement write routes (TOCTOU cross-site, standing deferral); 14 pre-existing idempotency 201-vs-409 test failures; DATE serialization on non-UTC servers.

### Source tree touch list

The following table lists every file this story touches and the nature of the change.

| File | Change |
| --- | --- |
| `read/projections/three_way_match.sql` | NEW canonical table |
| `read/projections/payment_clearance_feed.sql` | NEW canonical ledger |
| `read/projections/grn.sql` | UPDATE additive `po_id` column plus index |
| `read/projections/supplier_invoice.sql` | UPDATE additive `match_status` column, guarded CHECK, partial index |
| `deploy/compose/init-db.sql` | UPDATE byte-identical mirrors of all four above |
| `src/events/migrate.ts` | UPDATE append two filenames |
| `src/events/schema.ts` | UPDATE five payload/envelope interfaces, five tail entries in `SUPPORTED_EVENT_TYPES` |
| `src/events/store.ts` | UPDATE wire compliance module; constraint mapping entries |
| `src/config/index.ts` | UPDATE add `threeWayMatch` block |
| `src/compliance/three-way-match.ts` | NEW compliance module |
| `src/read/projections/three_way_match.ts` | NEW read accessors plus clearance-eligible query |
| `src/read/projections/grn.ts` | UPDATE `po_id` in interfaces/columns, `forUpdate` getter |
| `src/read/projections/supplier_invoice.ts` | UPDATE `match_status` in interfaces/columns |
| `src/adapters/erp/payment-clearance-feed.ts` | NEW feed builder plus ledger insert |
| `src/api/v1/three-way-match.ts` | NEW routes |
| `src/server.ts` | UPDATE route registration block |
| `test/unit/schema-drift.test.ts` | UPDATE EXPECTED entries |
| `test/integration/story-1-9.test.ts` | UPDATE `allowedSpineRoutes` |
| `test/integration/story-4-7.test.ts` | UPDATE un-document the blocked SOURCE_DOCUMENT_REQUIRED gap |
| `test/integration/story-4-5.test.ts` | NEW test suite |

Files that must NOT change: `src/compliance/receiving.ts` and `src/api/v1/receiving.ts` (Story 3.4 physical capture - consume only), `src/adapters/erp/sync.ts`, any `erp_*` table, `src/sync/upload.ts`, `edge/**`, `chk_supplier_invoice_status`, gate/weighbridge chain.

### Project Structure Notes

- Canonical SQL lives at repo root `read/projections/*.sql`, NOT `src/read/projections/` (that path in the 4.1 doc is a known doc defect). TS accessors live at `src/read/projections/*.ts`.
- Implementation order is the schema ripple order: canonical SQL, init-db mirror, `migrate.ts`, schema-drift EXPECTED, `schema.ts` interfaces, compliance module, store wiring, read accessors, adapter, API, server routes, spine pin, tests.
- LF endings throughout; `git stash` flips to CRLF - avoid stashing; run `git diff --check` before finishing.
- No new npm dependencies. Stack is pinned: Node built-in `node:test` runner, `pg`, PostgreSQL 18.4 on port 5442 for tests. No web research required - no external APIs or new libraries are introduced by this story.

### Previous story intelligence

- 4.4: JS float math on money was a review defect - all comparison arithmetic in SQL NUMERIC; accessor signatures accept `number | string`. Fail closed when a guard cannot resolve. Specific HTTP statuses from the seam (404/409/403), never blanket 400.
- 4.7 (28 review findings - treat as pre-flight checklist): authorization enforced only at HTTP layer is bypassable via direct `POST /api/v1/events` - every guard must live in the compliance assert/applier, not the route; payload actor fields must reconcile with envelope actor; unmapped constraints surface raw 500s; `Number.parseInt` accepts trailing junk - validate query params strictly; NUMERIC `SUM` can overflow scale (22003) - bound inputs; 404-vs-403 ordering must not leak existence.
- 4.6: idempotency keys must include the varying dimension; first-stamp-wins via `COALESCE`; capture-time snapshots immutable; empty-string env treated as undefined; the spine-route pin and schema-drift EXPECTED are the two gates most likely to fail first.
- Git state: recent work is on `master`, uncommitted tree includes all 4.6/4.7 deliverables. Recent commits show the story-per-commit convention (`feat: ...` plus story doc updates).

### Testing standards summary

Real-DB integration tests only (no mocks of the DB or event store), `node:test` plus `node:assert/strict`, `--test-concurrency=1`, harness copied from `test/integration/story-4-6.test.ts` (`before()` applies canonical SQL, trigger-disable plus TRUNCATE teardown, SCIM `provisionUser`, port-0 server, `makeRequest` real HTTP). One `it` per AC branch, NUMERIC asserted as strings, mandatory event-spoof test per new event type, trailing idempotent-replay test. Full gate list in Task 9.

### References

- Story spec: `_bmad-output/planning-artifacts/epics.md` (Epic 4 preamble; Story 4.5 section)
- Physical receiving seam: `_bmad-output/implementation-artifacts/3-4-goods-receiving-against-asn-or-po-fr-w-02.md`; `src/compliance/receiving.ts` (QC hold `:476-518`, interim QC task `:687-698`, ERP PO lookup `:321`, tolerance `:366-382`)
- PO seam: `_bmad-output/implementation-artifacts/4-4-purchase-order-management.md`; `src/compliance/purchase-order.ts`; `read/projections/purchase_order.sql` (status CHECK `:45`)
- Invoice seam: `_bmad-output/implementation-artifacts/4-7-supplier-invoice-capture.md`; `src/compliance/supplier-invoice.ts`; `read/projections/supplier_invoice.sql`; `read/projections/supplier_invoice_line.sql`
- Feed pattern: `_bmad-output/implementation-artifacts/4-6-msme-compliance-tracking.md`; `src/adapters/erp/msme-ageing-feed.ts`; `src/compliance/msme.ts:402-420`; `src/api/v1/msme.ts:99-110`
- Event store law: `src/events/store.ts:334-529, 790-840`; `src/events/schema.ts:1245-1580`
- Statutory edit log: `read/projections/audit_log.sql` (Story 1.3); `auditCtxFor` pattern at `src/api/v1/receiving.ts:60-74`

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m] (Claude Opus 5, 1M context), dev-story workflow, 2026-08-06.

### Debug Log References

Three fixture defects surfaced while bringing `test/integration/story-4-5.test.ts` green; all three
were test-side, none required a source change:

1. The Story 3.4 receipt response keys the created line as `grn_line`, not `line`.
2. `POST /api/v1/supplier-invoices` requires `po_id`, so an unmatched invoice cannot be produced
   there. File review (`supplier-invoice-ingestions` stage plus confirm) is the only unmatched
   source, exactly as Story 4.7 AC4 defines it; the AC4 test now uses that path.
3. A direct `POST /api/v1/events` envelope requires `metadata`. The suite now routes every
   direct-event probe through one `directEvent()` helper that stamps the real authenticated
   officer as the envelope actor, which is what makes the actor-attribution guard meaningful.

### Completion Notes List

Implemented all 9 tasks (35 subtasks) from baseline `b32fe25`.

- **Schema.** New `three_way_match` (one row per match RUN) and append-only
  `payment_clearance_feed` ledger; additive `grn.po_id` and `supplier_invoice.match_status` with a
  guarded CHECK. `chk_supplier_invoice_status` was NOT widened (binding decision 5), and the drift
  test now pins that too. `three_way_match` carries an extra `chk_three_way_match_lift_pairing`
  beyond the spec so a `lifted` row can never exist without its note, and a non-lifted row can
  never carry stale lift columns.
- **The match result is server-computed, never client-asserted.** The applier recomputes the
  comparison inside the persistEvent transaction and writes its findings back onto
  `envelope.payload` before the `domain_events` insert. A direct event claiming
  `result: 'passed'` is therefore stored as `blocked` with the real variance detail - asserted in
  `enforcement: a direct three_way_match.recorded event cannot assert a passing result`. This is
  the strongest available answer to the Story 4.7 lesson that route-layer guards are bypassable.
- **Quantity agreement is one percent per line:** the largest pairwise difference among ordered,
  received and invoiced quantity, relative to ordered quantity. One number keeps the rule
  expressible as one configured percent while still failing when any leg of the triangle
  disagrees. Tolerance comparison is inclusive at the boundary (a variance exactly equal to the
  configured percent passes), which the boundary test pins at exactly `2.000000`.
- **Fail-closed decisions taken where the spec left room.** A PO with no lines cannot pass a
  vacuous match. A SKU appearing on more than one PO line makes the SKU-grain receipt aggregate
  unattributable, so those lines fail with `ambiguous_sku` rather than double-counting the
  receipt. An invoice line that resolves to no PO line is a match failure
  (`unmatched_invoice_lines`), never a crash.
- **Receipts count at SKU grain** across every GRN bound to the PO, statuses `posted` and
  `quarantined` only. Quarantined stock was physically received and its QC disposition is Epic 8's
  problem; `rejected` never counts. All arithmetic is PostgreSQL NUMERIC crossing the wire as
  strings - no JS float participates in a payment-blocking decision.
- **Clearance is withheld, not blocked.** `listClearanceEligibleInvoices` returns only captured
  invoices whose `match_status` is `passed` or `lifted`. Blocked AND never-matched invoices are
  both omitted, and the omission IS the payment block (payment executes in ERP).
- **A `23514` branch was added to the store's constraint mapping** for the four new match CHECKs,
  so an unmapped path surfaces as a stable 409 `MATCH_STATE_INVALID` rather than a raw 500.
- **Story 4.7's consumer gap is closed and un-documented.** The "visibly blocked" note at the top
  of `story-4-7.test.ts` now points at the real assertion in `story-4-5.test.ts`.
- **Out of scope and untouched, as instructed:** `src/compliance/receiving.ts`,
  `src/api/v1/receiving.ts`, `src/adapters/erp/sync.ts`, every `erp_*` table, `src/sync/upload.ts`,
  `edge/**`, and the gate/weighbridge chain.

Verification (Task 9.1): `npm run build` clean, `npm run lint` clean, `npm run format:check`
clean, `npm run db:migrate` run twice cleanly against the test database (idempotent),
`npm run spine-acceptance-contract` 6/6, schema-drift 59/59, no-hardcoded-role 1/1,
`git diff --check` clean, `graphify update .` rebuilt (55684 nodes, 59828 edges).
`npm test`: 671 tests, 657 pass, 14 fail - the same 14 pre-existing idempotency 201-vs-409
failures documented in Dev Notes, zero new failures. `story-4-5.test.ts` 24/24;
`story-4-6.test.ts` re-run 18/18 unchanged.

Two files outside the story's touch list carry whitespace-only Prettier reformats:
`src/compliance/msme.ts` and `src/compliance/supplier-invoice.ts`. Both were already failing
`npm run format:check` at the baseline commit; formatting them was the only way to bring that
required gate green. Neither diff changes a single token of behaviour.

### File List

New:

- `read/projections/three_way_match.sql`
- `read/projections/payment_clearance_feed.sql`
- `src/compliance/three-way-match.ts`
- `src/read/projections/three_way_match.ts`
- `src/adapters/erp/payment-clearance-feed.ts`
- `src/api/v1/three-way-match.ts`
- `test/integration/story-4-5.test.ts`

Modified:

- `read/projections/grn.sql`
- `read/projections/supplier_invoice.sql`
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/config/index.ts`
- `src/read/projections/grn.ts`
- `src/read/projections/supplier_invoice.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-4-7.test.ts`
- `src/compliance/msme.ts` (Prettier whitespace only, pre-existing gate failure)
- `src/compliance/supplier-invoice.ts` (Prettier whitespace only, pre-existing gate failure)
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-08-06: Story created (ready-for-dev) by create-story workflow; context from epics.md, stories 3.4/4.4/4.6/4.7, and code-seam analysis.
- 2026-08-06: All 9 tasks implemented and verified; status moved to review. Five new procurement-stream events, two new projections, one new compliance module, eight new routes, 24 new integration tests.
- 2026-08-06: Adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor) over baseline `b32fe25` working tree. 12 patch findings applied, 1 reclassified to defer (P12 `po_ref_ext` correspondence check - no cross-namespace mapping in schema; logged to deferred-work.md). All story-4-5 tests 35/35, sibling 4-6/4-7 suites green, tsc/eslint/format clean, schema-drift 60/60, spine 6/6, db:migrate re-runnable. Status moved review -> done.
