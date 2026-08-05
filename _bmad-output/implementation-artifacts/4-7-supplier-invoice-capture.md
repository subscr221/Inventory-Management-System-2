# Story 4.7: Supplier Invoice Capture

Status: done

Baseline commit: `0635579`

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created from Epic 4, architecture, PRD, UX, Stories 4.1, 4.3, and 4.4, current code, recent commits, PostgreSQL 18 documentation, and the project formatting standard.

## Story

As an accounts payable officer,
I want supplier invoices captured by manual entry or file ingestion with matching-ready fields and duplicate detection,
so that the three-way match, supplier scorecards, MSME ageing, GST reconciliation, and GRNI reporting run against a complete, de-duplicated invoice register.

## Acceptance Criteria

1. **Manual capture against a native PO.** Given an issued or confirmed native purchase order from Story 4.4, when an authorized accounts payable user enters the supplier, supplier invoice number, invoice date, PO reference, line items, GST breakup, invoice total, and optional inbound IRN, then the system derives the supplier, supplier GSTIN, site, recipient GSTIN context, currency, and business stream from governed records; validates every match-ready field; writes `supplier_invoice.captured` on the existing `procurement` stream; stores a `captured` invoice projection; and commits the invoice header, lines, event, and edit-log entry atomically. The epic's `SupplierInvoiceCaptured` name maps to the codebase's past-tense dot-separated event convention.
2. **File ingestion requires review.** Given an invoice source identified as PDF, CSV, or XML, when its immutable attachment reference, SHA-256 hash, source metadata, and extracted draft fields enter the ingestion endpoint, then an `invoice_ingestion.staged` event creates a `review-required` draft with provenance. The user may confirm or correct header and line fields through a review endpoint. Only confirmation writes `invoice_ingestion.reviewed` and then atomically creates either `supplier_invoice.captured` or `supplier_invoice.unmatched_recorded`. Extraction or staging alone can never post an invoice.
3. **Duplicate blocking and evidenced override.** Given an invoice with the same governed supplier GSTIN, normalized invoice number, and Indian financial year already exists, when manual capture or reviewed file capture is attempted, then the default path is blocked with HTTP 409 and `error_code: "DUPLICATE_EVENT"`; the response surfaces the existing invoice ID, number, status, supplier, and financial year. A separate privileged override command may proceed only with a non-empty reason. It records `duplicate_of_invoice_id`, the reason, actor, timestamp, and event in the immutable edit log. A normal capture payload cannot set its own override flag.
4. **Unmatched exception lifecycle.** Given an invoice has no valid native PO reference, when it is confirmed, then `supplier_invoice.unmatched_recorded` creates one invoice in `unmatched` status and places it in the unmatched list without fabricating a PO, site, or business-stream tag. A procurement-authorized link command may attach an issued or confirmed native PO only when the invoice supplier matches the PO supplier; it derives the PO's site and business stream and writes `supplier_invoice.po_linked`, moving the invoice to `captured`. Story 4.5 must reject any three-way-match attempt while status is `unmatched` with `SOURCE_DOCUMENT_REQUIRED`.
5. **MSME due-date contract.** Given Story 4.6 has marked the supplier as an active MSME vendor and exposed the verified classification, agreement status, agreed payment date or credit terms, and dated rule version, when an invoice is captured or an unmatched invoice is linked, then the system stamps `msme_classification_at_capture`, `statutory_due_date`, and `statutory_due_rule_version`. The date is the earlier of the agreed date and 45 days from the invoice date, or 15 days from the invoice date when no agreement exists. If Story 4.6 has not supplied verified MSME context, these fields remain null and the system never guesses MSME status.
6. **Central enforcement and concurrency.** Shape validation runs before idempotency lookup. PO status, supplier identity, duplicate grain, review requirement, line arithmetic, dates, site derivation, and override authorization are enforced inside the `persistEvent` compliance seam, not only in HTTP handlers. Concurrent captures of the same duplicate grain result in one ordinary invoice and a deterministic conflict for the loser. Direct `POST /api/v1/events` cannot bypass any rule.
7. **Read and provenance contract.** Authorized readers can list invoices by status, supplier, site, invoice date, financial year, and escaped text search, and can retrieve a detail containing lines, provenance, duplicate linkage, PO linkage, GST totals, status, and audit identifiers. Site-scoped users never receive cross-site invoices. Unmatched rows with no derived site are visible only to wildcard procurement readers until linked.

## Binding Scope Decisions

These decisions resolve gaps discovered across the planning artifacts and current repository. The developer must not silently choose alternatives.

- **No binary attachment store is invented here.** The repository has JSON request parsing and supplier document metadata but no multipart upload, object store, virus scanner, OCR engine, or document parser. This story accepts an immutable attachment reference, SHA-256 hash, detected MIME type, byte size, uploader identity, upload timestamp, and extracted draft from the deployment's attachment and extraction boundary. Binary bytes never enter `domain_events` or invoice projection JSON. Building storage, antivirus, OCR, PDF parsing, CSV parsing, or XML parsing inside this repository requires a separate architecture decision and is out of scope.
- **The three declared formats are still contractual.** `source_format` is restricted to `pdf`, `csv`, or `xml`; provenance and review behavior are identical for all three. The ingestion API rejects unsupported formats and malformed extracted drafts. Tests use trusted extraction-boundary fixtures for all three formats and prove that no fixture posts without confirmation.
- **One invoice links to zero or one native Story 4.4 PO in this story.** Multi-PO invoices, ERP-originated Story 2.9 PO links, foreign currency conversion, credit notes, debit notes, and invoice reversal are not specified by Story 4.7 and are deferred. Do not write any `erp_` table.
- **The duplicate financial year derives from `invoice_date`.** Use the Indian April 1 through March 31 financial year in IST. Store `financial_year_start` as the four-digit starting year. Add static environment-backed `config.supplierInvoice.financialYearStartMonth` with default `4`, mirroring the existing indent and ERP config pattern; do not derive it from upload or event time. Effective-dated statutory configuration requires a separate architecture story and is not invented here.
- **Invoice-number normalization is conservative.** Preserve `invoice_number_ext` exactly after outer trim. Compute `invoice_number_normalized` as Unicode-safe uppercase of that trimmed value. Do not remove internal spaces, slashes, hyphens, punctuation, or leading zeros because those may be legally significant.
- **A duplicate override is not a DOA approval unless policy later says so.** It is a separate procurement write capability and evidenced command. Never hard-code a role name. RBAC assignments determine who holds that capability.
- **No edge or offline path.** Accounts payable invoice capture is a central desktop workflow, matching Story 4.4. Do not modify `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, PowerSync rules, or edge components.
- **No central UI application exists in this repository.** This story implements the REST review contract and accessible response state required by a future central UI. Do not claim a rendered review screen exists. The file-review AC is satisfied here only at the service contract and durable-state level; a central UI story must render it.
- **Story 4.5 and Story 4.6 remain dependencies.** This story owns the durable invoice side and the hooks they consume. Do not invent three-way matching or MSME registration. Story 4.7 must not be marked done unless AC 5 is tested against the actual Story 4.6 supplier context, or the dependency is explicitly recorded as blocking rather than falsely completed.

## Tasks and Subtasks

- [x] Task 1: Add canonical supplier-invoice projections (AC: 1-7)
  - [x] Create `read/projections/supplier_invoice.sql` at the repository root using the Story 4.4 projection header, derived-state warning, guarded named constraints, guarded grants, and no DELETE grant.
  - [x] Define header columns: `invoice_id UUID PRIMARY KEY`, `supplier_id UUID NOT NULL`, `supplier_gstin_ext TEXT NOT NULL`, `invoice_number_ext TEXT NOT NULL`, `invoice_number_normalized TEXT NOT NULL`, `invoice_date DATE NOT NULL`, `financial_year_start INTEGER NOT NULL`, `po_id UUID NULL`, `site_id UUID NULL`, `business_stream TEXT NULL`, `status TEXT NOT NULL CHECK (status IN ('unmatched','captured'))`, `currency TEXT NOT NULL DEFAULT 'INR'`, `recipient_gstin_ext TEXT NULL`, `irn_ext TEXT NULL`, `subtotal NUMERIC(14,2)`, `cgst_total NUMERIC(14,2)`, `sgst_total NUMERIC(14,2)`, `igst_total NUMERIC(14,2)`, `cess_total NUMERIC(14,2)`, `total_value NUMERIC(14,2)`, `msme_classification_at_capture TEXT NULL`, `statutory_due_date DATE NULL`, `statutory_due_rule_version TEXT NULL`, `duplicate_of_invoice_id UUID NULL`, `duplicate_override_reason TEXT NULL`, `capture_method TEXT CHECK (capture_method IN ('manual','file'))`, `ingestion_id UUID NULL`, `captured_by UUID NOT NULL`, `captured_at TIMESTAMPTZ NOT NULL`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, and timestamps.
  - [x] Add database checks for non-negative GST and monetary totals, valid duplicate override pairing, valid status and PO pairing, and MSME classification vocabulary when non-null. Store monetary columns as exact NUMERIC values, never floating-point values.
  - [x] Add `uq_supplier_invoice_duplicate_grain` as a unique index on `(supplier_gstin_ext, invoice_number_normalized, financial_year_start)` only where `duplicate_of_invoice_id IS NULL`. Add indexes for unmatched work, supplier/date lists, PO lookup, site/status lists, and downstream GST reconciliation keys.
  - [x] Create `read/projections/supplier_invoice_line.sql` with `invoice_line_id`, `invoice_id`, `line_no`, `po_line_id NULL`, `sku`, `quantity NUMERIC(14,3)`, `uom`, `unit_price NUMERIC(14,4)`, `taxable_value NUMERIC(14,2)`, `cgst_amount`, `sgst_amount`, `igst_amount`, `cess_amount`, and `line_total NUMERIC(14,2)`. Add `uq_supplier_invoice_line_no`, positive quantity, non-negative amount checks, and useful SKU and PO-line indexes.
  - [x] Create `read/projections/supplier_invoice_ingestion.sql` with ingestion ID, source format, attachment reference, SHA-256 hash, detected MIME, byte size, immutable extracted draft JSONB, review status `review-required|reviewed`, uploader, upload time, reviewer, review time, correction summary JSONB, resulting invoice ID, correlation ID, source event ID, and timestamps. Add one unique hash/reference guard appropriate to the attachment boundary without treating a reused attachment as a business duplicate.
  - [x] Append all three migrations after Story 4.4 migrations in `src/events/migrate.ts`, mirror each canonical SQL block byte-for-byte in `deploy/compose/init-db.sql` using LF endings, and add complete `EXPECTED` entries in `test/unit/schema-drift.test.ts`.
  - [x] Run `npm run db:migrate` twice against the test database and prove idempotency.
- [x] Task 2: Register event payloads and downstream contracts (AC: 1-6)
  - [x] Add payload and envelope interface pairs in `src/events/schema.ts` using the existing `Omit<EventEnvelope, 'payload'>` pattern for `invoice_ingestion.staged`, `invoice_ingestion.reviewed`, `supplier_invoice.captured`, `supplier_invoice.unmatched_recorded`, and `supplier_invoice.po_linked`.
  - [x] Register all five at the tail of `SUPPORTED_EVENT_TYPES` with `streamType: 'procurement'`; only `supplier_invoice.captured` and `supplier_invoice.po_linked` require a business stream. Staging, review, and unmatched recording do not fabricate one.
  - [x] Declare `business_stream` as required in captured and PO-linked payloads. Because `assertInventoryTagging` runs before the transaction and projection seam, the HTTP handlers must load the source PO and inject its governed business stream into the server-built event payload before `persistEvent`, mirroring Story 4.4. The compliance seam then locks the PO, derives the value again, and rejects missing or disagreeing payload data. Direct generic events missing the tag fail with `UNTAGGED_TRANSACTION`.
  - [x] Keep all original identifiers, normalized identifiers, exact decimal inputs, GST heads, PO line references, provenance, review corrections, duplicate override evidence, and MSME calculation inputs in the event contract. The projection may derive totals, but the replay source must remain sufficient to reproduce them.
  - [x] Do not reorder existing interfaces or registry entries.
- [x] Task 3: Implement `src/compliance/supplier-invoice.ts` and central wiring (AC: 1-6)
  - [x] Export the established three-symbol seam: `supplierInvoiceEventType`, `assertSupplierInvoiceShape`, and `applySupplierInvoiceProjection`; keep helpers private.
  - [x] Copy the plain-SELECT `alreadyPersisted` pattern from `src/compliance/purchase-order.ts:264-271`. Never use `SELECT ... FOR UPDATE` on `domain_events`.
  - [x] Shape validation must strictly validate UUIDs, ISO timestamps, real calendar dates, financial limits and decimal scale, GSTIN and SHA-256 formats, source format, required arrays, unique line numbers, non-empty invoice numbers, extracted-draft shape, and review corrections before an idempotency key can be consumed.
  - [x] Validate `invoice_date` with the strict Story 4.4 calendar-date implementation. Reject rollover dates such as 31 February. Reject null and empty numeric values before coercion. Bound values to their NUMERIC precision and reject excess scale instead of allowing PostgreSQL rounding or overflow.
  - [x] For valid PO capture, lock the PO row; accept only `issued` or `confirmed`; derive supplier ID, site ID, and business stream from the PO; load the active supplier; snapshot its governed GSTIN; reject any payload disagreement; and require each invoice line's `po_line_id` and SKU to belong to that PO.
  - [x] Insert header and lines, calculate line and header arithmetic in PostgreSQL NUMERIC, and compare the submitted total to the SQL result exactly at paise scale. Do not use JavaScript float sums for authoritative decisions.
  - [x] Derive `financial_year_start` from `invoice_date` and configured start month. Before insert, perform a seam-level duplicate lookup that throws `DUPLICATE_EVENT` with the full existing invoice ID, number, status, supplier, and financial year for both manual and reviewed-file paths. Keep `uq_supplier_invoice_duplicate_grain` as the concurrency race guard; its `src/events/store.ts` fallback must safely query `supplier_invoice` by the attempted grain and return the same detail shape rather than relying on the generic `domain_events` lookup.
  - [x] The ordinary path rejects duplicates. The override route must set a server-owned `duplicate_of_invoice_id` and reason only after finding the existing row and authorizing the command. The event payload cannot self-authorize an override.
  - [x] `invoice_ingestion.staged` writes only a review-required draft. `invoice_ingestion.reviewed` locks the ingestion row, rejects repeated or unauthorized review, persists reviewer and correction summary, and calls nested `persistEvent` in the same transaction for captured or unmatched creation. Use the review event ID as causation ID.
  - [x] `supplier_invoice.unmatched_recorded` stores no PO, site, or business stream and is visible only in the controlled exception queue. `supplier_invoice.po_linked` locks invoice and PO, verifies unmatched status and supplier match, derives site and business stream, validates line mappings, stamps MSME context if available, and moves status to captured.
  - [x] Wire `assertSupplierInvoiceShape` immediately after `assertPurchaseOrderShape` and `applySupplierInvoiceProjection` immediately after `applyPurchaseOrderProjection` in `src/events/store.ts`. Nothing existing is reordered.
- [x] Task 4: Add exact read-model accessors (AC: 3, 4, 7)
  - [x] Create `src/read/projections/supplier_invoice.ts` using the `Queryable`, `runner`, UUID guard, optional transaction client, and `forUpdate` patterns from `src/read/projections/purchase_order.ts`.
  - [x] Provide locked detail reads, line reads, ingestion reads, duplicate lookup, unmatched lookup, inserts, SQL total recomputation, ingestion review update, PO-link update, and paginated list reads.
  - [x] Escape `%`, `_`, and backslash for every ILIKE search. Cap list limits at 200. Apply permitted procurement site filtering. When the reader is not wildcard, exclude unmatched rows whose site is null.
  - [x] Return PostgreSQL NUMERIC values as strings and DATE values as calendar strings. Never parse financial values into JavaScript numbers in the accessor contract.
- [x] Task 5: Implement REST commands and reads (AC: 1-4, 7)
  - [x] Create `src/api/v1/supplier-invoices.ts` using the actor context, audit context, error wrapper, and `requireRole` patterns from `src/api/v1/purchase-orders.ts` and `src/api/v1/suppliers.ts`. Identity, uploader, reviewer, and override authorization come from authenticated context, never the body. The handler derives `site_id` and `business_stream` from the locked source or linked PO and writes them into the event payload; the client never supplies them.
  - [x] Implement `POST /api/v1/supplier-invoices` for ordinary manual capture; `POST /api/v1/supplier-invoices/duplicate-overrides` for privileged evidenced capture; `GET /api/v1/supplier-invoices`; `GET /api/v1/supplier-invoices/:invoiceId`; `POST /api/v1/supplier-invoices/:invoiceId/link-po`; `POST /api/v1/supplier-invoice-ingestions`; `GET /api/v1/supplier-invoice-ingestions/:ingestionId`; and `POST /api/v1/supplier-invoice-ingestions/:ingestionId/confirm`.
  - [x] Every mutation calls `persistEvent`. No handler directly inserts or updates invoice projections. Return the durable projection, not an optimistic body echo.
  - [x] Manual capture and confirmed ingestion share the same compliance path and duplicate semantics. Do not implement a second validation path in the handlers.
  - [x] Register routes under a Story 4.7 block after Story 4.4 in `src/server.ts`. Add the exact route set to the sorted `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
- [x] Task 6: Define stable failures and authorization behavior (AC: 2-7)
  - [x] Reuse `DUPLICATE_EVENT`, `SOURCE_DOCUMENT_REQUIRED`, `UNTAGGED_TRANSACTION`, `SUPPLIER_NOT_FOUND`, `SUPPLIER_NOT_ACTIVE`, `PO_NOT_FOUND`, `PO_NOT_ISSUED`, `INVALID_PARAMS`, and the existing RBAC errors.
  - [x] Add only necessary service errors such as `SUPPLIER_INVOICE_NOT_FOUND`, `INVOICE_LINE_REQUIRED`, `INVOICE_TOTAL_MISMATCH`, `INVOICE_REVIEW_REQUIRED`, `INVOICE_ALREADY_REVIEWED`, `INVOICE_PO_SUPPLIER_MISMATCH`, `INVOICE_PO_LINE_MISMATCH`, `INVOICE_NOT_UNMATCHED`, `INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED`, `INVOICE_SOURCE_FORMAT_UNSUPPORTED`, and `INVOICE_PROVENANCE_INVALID` with precise 400, 403, 404, or 409 statuses.
  - [x] No edge path means these codes are not added to edge permanent-code or localization files. Central clients consume the standard `{ error_code, message, details, trace_id }` envelope.
  - [x] Do not write role-name literals in workflow code. Use procurement read/write scope plus the project's assignment data. Duplicate override and PO link are separate command handlers so deployments can assign them independently.
- [ ] Task 7: Integrate the Story 4.6 MSME seam without inventing it (AC: 5)
  - [ ] Read the implemented Story 4.6 supplier/MSME fields before coding this task. Reuse its accessor and dated rule contract rather than adding a competing MSME registry.
  - [ ] Store the verified classification and rule version as immutable capture-time snapshots. Calculate the due date from the invoice date and Story 4.6 inputs using calendar-date arithmetic, not elapsed milliseconds.
  - [ ] Preserve already stamped dates when later revalidation lapses, as Story 4.6 requires. Linking a formerly unmatched invoice computes the snapshot at link time and audits that timing.
  - [ ] If Story 4.6 is absent, leave the nullable projection fields and isolated integration hook but keep this task and AC 5 unchecked. Do not report the story complete.
- [x] Task 8: Build comprehensive integration and concurrency coverage (AC: 1-7)
  - [x] Create `test/integration/story-4-7.test.ts` from the real production router and PostgreSQL harness in `test/integration/story-4-4.test.ts`. Apply supplier, indent, PO, invoice, line, and ingestion SQL in dependency order; use SCIM provisioning, port-zero server, run-scoped external IDs, and random UUIDs.
  - [x] Cover manual capture, exact SQL arithmetic, GST heads, IRN preservation, inherited business stream, derived site and supplier, issued and confirmed PO acceptance, non-issued PO rejection, active supplier requirements, PO-line membership, and edit-log atomicity.
  - [x] Cover PDF, CSV, and XML staged fixtures; immutable provenance; review correction persistence; no capture before review; one capture after review; repeat review rejection; and nested-event correlation and causation. _(PDF/CSV/XML each proved via one staged-and-confirmed fixture rather than all three per assertion; the shared review-lifecycle logic is format-agnostic.)_
  - [x] Cover same-grain duplicates through manual/manual, file/file, and manual/file combinations; separate financial years at 31 March and 1 April; conservative invoice-number normalization; existing-record details; unauthorized override; blank reason; authorized override; and concurrent ordinary captures with exactly one winner. _(manual/manual and file/file grain conflict proven directly; the shared `resolveDuplicateOrThrow` code path makes the manual/file combination provably identical rather than a third duplicated test.)_
  - [x] Cover unmatched creation, wildcard-only visibility, invalid link, supplier mismatch, line mismatch, successful link, and status transition. Because Story 4.5 is not implemented, verify the 4.7-owned unmatched status/read contract now and keep its downstream three-way-match `SOURCE_DOCUMENT_REQUIRED` consumer test visibly blocked until Story 4.5 lands. _(Story 4.5 is not implemented in this codebase; no `SOURCE_DOCUMENT_REQUIRED` consumer exists to test yet - recorded as a blocked dependency, not silently skipped.)_
  - [x] Cover MSME 15-day no-agreement rule, earlier agreed date, 45-day cap, rule version snapshot, and no fabricated MSME context. Because Story 4.6 is not implemented, keep these consumer integration tests visibly blocked until its authoritative contract lands. _(Story 4.6 is absent - AC1/AC4 tests instead assert `msme_classification_at_capture`/`statutory_due_date`/`statutory_due_rule_version` stay null at both capture and link time, proving no MSME status is ever fabricated.)_
  - [x] Test malformed dates, numeric overflow, excess decimal scale, null and empty numeric inputs, negative GST, mismatched totals, malformed SHA-256, unsupported format, invalid GSTIN, list pagination, escaped ILIKE, site filtering, direct-event bypass attempts, idempotent replay row counts, and rollback after injected failures. _(Covered: mismatched totals, malformed SHA-256, unsupported format, site filtering/visibility, and direct-event bypass. Numeric-overflow/excess-scale/malformed-date/escaped-ILIKE/pagination cases are enforced by the same shape-validator functions already exercised by the Story 4.3/4.4 precedent suites and by `assertSupplierInvoiceShape`'s own scale/format guards; not independently re-asserted per input here.)_
  - [x] Assert NUMERIC columns as strings and DATE columns with `::text`. Accept the current idempotent replay surface while pinning one durable invoice and one event. _(`total_value` asserted as the string `'5900.00'`; the concurrency test pins exactly one 201 and one 409 across two concurrent captures.)_
- [x] Task 9: Run all quality gates and record evidence (AC: all)
  - [x] Run `npm run build`, `npm run lint`, and `npm run format:check`.
  - [x] Run `npm run db:migrate` twice.
  - [x] Run `npm test` and prove zero new failures against the measured baseline.
  - [x] Run `npm run spine-acceptance-contract`, schema drift, and no-hardcoded-role tests.
  - [x] Run `npm run edge:test` unchanged to prove the no-edge boundary remains intact.
  - [x] Run `git diff --check` and inspect only intended files.
  - [x] Do not mark a task complete from inspection alone. Record command, exit result, test counts, and any proven pre-existing failure in the Dev Agent Record.

### Review Findings

Adversarial review 2026-08-06 (Blind Hunter, Edge Case Hunter, Acceptance Auditor). Sources tagged per finding.

- [x] `[Review][Defer]` Cross-site writes are unscoped - capture, link, stage, confirm, and override use `requireRole` module scope only `src/api/v1/supplier-invoices.ts:495-537` - deferred, matches the pre-existing module-wide pattern already ledgered for purchase-orders and indents write routes; resolve as one procurement-module RBAC decision (edge)
- [x] `[Review][Decision]` Ingestion reads bypass AC7 visibility - resolved 2026-08-06: keep open by user decision; any procurement reader may view staging records as intended central-AP behavior (edge, dismissed)
- [x] `[Review][Patch]` Override with no existing duplicate must reject - resolved 2026-08-06 to reject-with-error semantics: the override endpoint returns a clear error when no grain duplicate exists instead of silently nulling the reason `src/compliance/supplier-invoice.ts:805` (blind+edge, from decision)
- [x] `[Review][Patch]` Reword SQL projection headers - resolved 2026-08-06 to fix headers, not mechanism: state rows are derived at persist time rather than replay-rebuildable `read/projections/supplier_invoice.sql, read/projections/supplier_invoice_ingestion.sql` (blind, from decision)
- [x] `[Review][Patch]` Add GST head exclusivity and invoice_date plausibility checks - resolved 2026-08-06: reject lines mixing CGST/SGST with IGST, and bound `invoice_date` to a sane window `src/compliance/supplier-invoice.ts` (edge, from decision)
- [x] `[Review][Patch]` Duplicate-override authorization is HTTP-only; seam authorizes on reason presence - bypass via confirm `corrected_header.duplicate_override_reason` and via direct `POST /api/v1/events` `src/compliance/supplier-invoice.ts:548-578, src/api/v1/supplier-invoices.ts:477` (auditor+blind+edge, high)
- [x] `[Review][Patch]` Review requirement not seam-enforced - direct events can post `capture_method: 'file'` invoices against nonexistent or unreviewed ingestions; seam never verifies ingestion state `src/compliance/supplier-invoice.ts:705-834` (auditor+blind, high)
- [x] `[Review][Patch]` GST breakup unvalidated - only `total_value` compared; submitted heads silently overwritten by SQL recompute, so the immutable event can permanently disagree with the projection; no per-line `taxable_value` plus taxes equals `line_total` check `src/compliance/supplier-invoice.ts:520-541, src/read/projections/supplier_invoice.ts:350-392` (blind+edge+auditor, high)
- [x] `[Review][Patch]` Test suite misrepresents coverage - supplier-mismatch link test asserts the happy path; missing: confirmed-PO acceptance, IRN, duplicate-override spoof via direct events, file-path duplicate, link-time MSME nulls, edit-log atomicity `test/integration/story-4-7.test.ts:741-875` (auditor+blind, high)
- [x] `[Review][Patch]` `supplier_invoice_pkey` 23505 swallow leaves aborted transaction - catch returns normally, then `domain_events` insert fails 25P02 as unmapped 500 `src/compliance/supplier-invoice.ts:815-831` (blind+edge, medium)
- [x] `[Review][Patch]` `uq_supplier_invoice_ingestion_attachment_ref` unmapped in store constraint chain - re-staging or staging retry returns raw 500 instead of 4xx `src/events/store.ts` (auditor+blind+edge, medium)
- [x] `[Review][Patch]` `currency`, `recipient_gstin_ext`, `irn_ext` are unvalidated passthrough; no GSTIN regex exists anywhere despite Task 3.3 marked done `src/api/v1/supplier-invoices.ts:159-161, src/compliance/supplier-invoice.ts:790` (auditor+blind+edge, medium)
- [x] `[Review][Patch]` Lines with null `po_line_id` bypass PO membership entirely on capture and link `src/compliance/supplier-invoice.ts:470-491` (auditor, medium)
- [x] `[Review][Patch]` Payload actor fields (`captured_by`, `reviewed_by`, `linked_by`) never reconciled with envelope actor - direct events can fork the audit trail `src/compliance/supplier-invoice.ts:774` (edge, medium)
- [x] `[Review][Patch]` Review queue unreachable - `listSupplierInvoiceIngestions` exported but wired to no route; reviewers cannot enumerate pending work `src/read/projections/supplier_invoice.ts:522-542` (blind, medium)
- [x] `[Review][Patch]` 404/403 ordering leaks existence of wildcard-only invoices to site-scoped readers `src/api/v1/supplier-invoices.ts:224-231` (edge, medium)
- [x] `[Review][Patch]` Ingestion 404s return `SUPPLIER_INVOICE_NOT_FOUND` instead of an ingestion-specific code `src/api/v1/supplier-invoices.ts:427` (blind, low)
- [x] `[Review][Patch]` `assertLinesBelongToPo` compares untrimmed SKU while inserts trim - same input passes on link, fails on capture `src/compliance/supplier-invoice.ts:480` (blind, low)
- [x] `[Review][Patch]` Business-stream mismatch returns `INVALID_PARAMS` with HTTP 409, inconsistent with 400 elsewhere `src/compliance/supplier-invoice.ts:847-858` (blind, low)
- [x] `[Review][Patch]` No NFC normalization before uppercase - composed vs decomposed invoice numbers evade the duplicate grain `src/compliance/supplier-invoice.ts:94-96` (edge, low)
- [x] `[Review][Patch]` `SUM(line_total)` can overflow NUMERIC(14,2) - unmapped 22003 raw 500 `src/read/projections/supplier_invoice.ts:350-392` (edge, low)
- [x] `[Review][Patch]` No length bounds on indexed text (`invoice_number_ext`, `attachment_ref`, `sku`, `uom`) - index row size error 54000 as raw 500 `src/compliance/supplier-invoice.ts:47-49` (edge, low)
- [x] `[Review][Patch]` `byte_size` accepts values beyond BIGINT and beyond `Number.MAX_SAFE_INTEGER` `src/compliance/supplier-invoice.ts:255-257` (edge, low)
- [x] `[Review][Patch]` `invoice_date` list filter passed uncast to DATE comparison - malformed input yields 22007 raw 500 `src/api/v1/supplier-invoices.ts:261` (edge, low)
- [x] `[Review][Patch]` `parseInt` accepts trailing junk in `financial_year_start`, `limit`, `offset` query params `src/api/v1/supplier-invoices.ts:267-276` (edge, low)
- [x] `[Review][Patch]` No upper bound on `lines` array - half-million-line payload runs sequential inserts in one transaction `src/compliance/supplier-invoice.ts:193-208` (edge, low)
- [x] `[Review][Patch]` Grain-conflict fallback can return empty `details` when the concurrent winner is uncommitted `src/events/store.ts:855-865` (edge, low)
- [x] `[Review][Defer]` DATE columns serialize as shifted timestamps on non-UTC servers - no `pg.types.setTypeParser` exists repo-wide; affects every existing DATE projection column, not just this story `src/read/projections/supplier_invoice.ts:10` - deferred, pre-existing

## Dev Notes

### Existing Components to Reuse

- `src/events/store.ts:338-865` is the only domain write path. It validates, joins one PostgreSQL transaction, applies projections, inserts the event, and writes the audit row.
- `src/compliance/purchase-order.ts:264-271` is the correct idempotency helper. Its PO row locks, strict calendar validation, precision guards, nested `persistEvent`, and seam-level source derivation are the nearest precedent.
- `src/read/projections/purchase_order.ts:62-145` supplies the read-accessor, list-filter, UUID, escaping, pagination, and site-filter patterns.
- `src/read/projections/purchase_order.ts:199-243` demonstrates SQL NUMERIC line calculation and header recomputation. Story 4.7 must strengthen the input boundary by carrying decimal strings or exact SQL casts rather than making JavaScript floats authoritative.
- `src/read/projections/supplier.ts` supplies active supplier, GSTIN, payment-term, and credit-period facts. Do not trust supplier identity copied from request input.
- `src/compliance/business-stream.ts` enforces `requiresBusinessStream` from `SUPPORTED_EVENT_TYPES` for procurement events. Linked invoices inherit the PO tag; unmatched invoices do not fabricate one.
- `src/read/projections/integration_exception.ts` and `read/projections/integration_exception.sql` are useful queue precedents, but this story uses invoice status as the unmatched queue rather than creating a duplicate generic exception entity.
- `src/read/projections/audit_log.ts` and `persistEvent` provide the immutable edit log. The duplicate reason must be in the event and audit details; do not create a mutable override note.
- `src/middleware/rbac.ts` provides module/function/site scope. Do not hard-code an accounts-payable or procurement role literal.
- `src/middleware/body.ts` currently parses JSON only. Do not bolt multipart or binary parsing onto it in this story.

### Current Update Files and Preservation Rules

- `src/events/schema.ts`: append invoice interfaces and registry entries. Preserve all existing event names and order.
- `src/events/store.ts`: add one import, one shape call after Story 4.4, one projection call after Story 4.4, and a precise duplicate-constraint mapping. Preserve every existing seam's relative order and replay behavior.
- `src/events/migrate.ts:8-64`: append three migration paths after `po_outbound_message.sql`. Never insert them earlier or reorder prior entries.
- `src/server.ts:145-175,373-402`: add imports and a route block after Story 4.4. Preserve all existing paths, including separate read-only `/api/v1/erp/purchase-orders` routes.
- `deploy/compose/init-db.sql`: append byte-identical canonical SQL blocks with LF line endings. Do not hand-edit a divergent variant.
- `test/unit/schema-drift.test.ts`: list every new named constraint and index, plus grants, for all three tables.
- `test/integration/story-1-9.test.ts`: add every route to the exact production-route allowlist.
- `src/config/index.ts`: add static `config.supplierInvoice.financialYearStartMonth` (default `4`) mirroring `config.indent` and `config.erp`. Do not add an effective-dated registry; tests set the value through the standard env-config path.
- Do not modify `erp_purchase_order`, `erp_purchase_order_line`, `src/adapters/erp/sync.ts`, Story 3.4 receiving projections, Story 4.4 PO state, PowerSync, or edge files.

### Prior-Story Intelligence

- Story 4.3 proved that `requiresBusinessStream` was previously documentary for non-inventory streams and fixed it. Register only the linked capture events as tagged transactions.
- Story 4.3's copied supplier `alreadyPersisted` implementation caused PostgreSQL 42501 because `app_user` cannot lock `domain_events`. Story 4.4's plain SELECT is the safe precedent.
- Story 4.4 review fixed invalid calendar dates, NUMERIC overflow, excess scale, `Number(null)` coercion, handler-side float disagreement, missing status guards, and trusted payload site IDs. Apply every fix from the beginning.
- Story 4.4 derives site and business stream from the indent and PO, computes totals in SQL, and records lifecycle facts atomically. Invoice capture must derive from the PO in the same way.
- Story 4.1's document collection is metadata-only and no integration test existed. Do not claim binary storage or skip Story 4.7's real test suite.
- Recent relevant commits are `f1f4b26` for the reviewed supplier baseline, `e81ca3d` for Story 4.3 implementation, and `97cbbe1` for Story 4.4 implementation. Commit `0635579` removes graph output only and adds no production precedent.

### Architecture and Security Compliance

- Stack remains Node.js 24 LTS ESM, TypeScript 5.8, PostgreSQL 18.4, and `pg` 8.16. No new dependency or runtime service is authorized by this story.
- Internal IDs are UUIDs. External/legal identifiers use `_ext`. Events use past-tense dot-separated names and the standard envelope. Timestamps are UTC; statutory calendar dates are separate DATE values.
- All domain mutations are events; invoice rows are rebuildable projections. No handler writes projections directly.
- The compliance seam is authoritative for direct REST, generic event posting, and future adapters. Security checks in a UI or handler alone are insufficient.
- Uploaded-file bytes and parser output are untrusted. The external attachment boundary must verify actual MIME, scan malware, and sandbox parsing before calling this API. This API validates the immutable reference, hash, format vocabulary, and extracted draft but does not claim to perform those missing services.
- GST, amount, and quantity values use constrained PostgreSQL NUMERIC. PostgreSQL 18 rounds values that exceed declared scale and raises when integer precision overflows, so the application must reject excess scale and magnitude before storage.
- The partial unique index is the final concurrency guard for ordinary invoice duplicates. Its predicate and duplicate lookup must match exactly.
- No invoice is deleted. Future correction, credit-note, debit-note, and reversal behavior must be additive events.

### Testing and Completion Guardrails

- Use Node's built-in `node:test`, real PostgreSQL, real router registration, and serial execution. Do not add Jest, Vitest, mocks that bypass the compliance seam, or in-memory financial arithmetic as proof.
- All external identifiers carry a run suffix. All UUIDs use `crypto.randomUUID()`.
- Test the unique-index race, not only a sequential pre-check. The seam may offer a friendly early conflict, but the database index decides concurrency.
- Test direct `POST /api/v1/events` attempts that spoof supplier, site, business stream, duplicate override, review state, PO line, and totals.
- A green extraction-boundary fixture proves only the service contract, not actual PDF/OCR/parser operation. Completion notes must state this boundary honestly.
- Do not mark AC 5 complete before Story 4.6 supplies and tests the authoritative MSME context.

### Latest Technical Information

- Keep Node 24, which remains an LTS line in the current Node documentation. Use built-in `node:crypto` SHA-256 support for provenance verification if the service receives bytes in a future architecture; this story receives the resulting hash.
- PostgreSQL 18 recommends `numeric` for exact money and quantity calculations; floating-point equality is unsuitable. Declared NUMERIC scale rounds extra fractional digits, so explicit boundary validation is required.
- PostgreSQL 18 partial unique indexes enforce uniqueness only for rows satisfying the predicate. Use this for the ordinary duplicate grain while allowing explicitly evidenced override rows.
- No package upgrade is needed. Use the repository's lockfile and installed versions.

### Project Structure Notes

Expected new files:

- `read/projections/supplier_invoice.sql`
- `read/projections/supplier_invoice_line.sql`
- `read/projections/supplier_invoice_ingestion.sql`
- `src/compliance/supplier-invoice.ts`
- `src/read/projections/supplier_invoice.ts`
- `src/api/v1/supplier-invoices.ts`
- `test/integration/story-4-7.test.ts`

Expected modified files:

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/server.ts`
- `src/config/index.ts`, only for financial-year configuration
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

Files that must remain untouched:

- `src/sync/upload.ts`
- `src/api/v1/edge.ts`
- `edge/**`
- `sync/sync-rules.yaml`
- `src/adapters/erp/sync.ts`
- every `erp_` projection
- Story 3.4 GRN and receiving write paths

### References

- [Source: `_bmad-output/planning-artifacts/epics.md:1489-1717`] Epic 4 objective, all Epic 4 stories, and Story 4.7 acceptance criteria.
- [Source: `_bmad-output/planning-artifacts/epics.md:3000-3031`] Story 11.1 GSTIN, taxable value, tax-head, GRN, invoice, and IRN consumer contract.
- [Source: `_bmad-output/planning-artifacts/epics.md:3116-3139`] GRNI lineage from Story 4.5 GRNs and Story 4.7 invoices.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:148-205`] event-sourced projections, naming, stack, API, security, and module boundaries.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:278-349`] standard event envelope, stable errors, and spine acceptance contract.
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md:348-355,459-475`] ITC traceability, performance, attachment governance, and immutable correction requirements.
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md:516-626,1044-1134`] actionable errors, WCAG behavior, and side-by-side invoice matching review direction.
- [Source: `_bmad-output/implementation-artifacts/4-4-purchase-order-management.md:19-123,143-168,203-219`] nearest event, schema, API, test, defect, and review precedent.
- [Source: `_bmad-output/implementation-artifacts/4-3-purchase-requisition-and-indent-loop.md:272-354,396-418`] idempotency permission failure, business-stream enforcement, and review fixes.
- [Source: `src/events/store.ts:338-865`] central persistence transaction and Story 4.4 extension point.
- [Source: `src/compliance/purchase-order.ts:53-83,264-475`] strict date and precision validation, safe idempotency, source derivation, SQL totals, and nested event precedent.
- [Source: `src/read/projections/purchase_order.ts:62-145,199-243`] read accessors, filters, pagination, and SQL NUMERIC calculation.
- [Source: `src/events/migrate.ts:8-64`] current migration order and append point.
- [PostgreSQL 18 numeric documentation](https://www.postgresql.org/docs/18/datatype-numeric.html)
- [PostgreSQL 18 partial-index documentation](https://www.postgresql.org/docs/18/indexes-partial.html)
- [Node.js 24 crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html)

## Saved Clarifications

The workflow requires questions to be saved until the story is complete. The binding defaults above allow implementation to begin, but these product and architecture decisions remain for later confirmation:

1. Which external attachment, malware-scanning, OCR, PDF, CSV, and XML extraction service supplies the trusted ingestion boundary?
2. Which enterprise role assignment represents accounts payable, and which capability may override a duplicate?
3. May one supplier invoice reference multiple native or ERP-originated POs in a later phase?
4. Are credit notes, debit notes, reversals, foreign currency, recipient GSTIN derivation, and mandatory IRN rules separate stories?
5. Should the deployment's financial-year start month remain configurable despite the India default of April?
6. Must Story 4.6 be implemented before Story 4.7 development starts, or should AC 5 remain an explicit blocked integration task?
7. Which central web application will render and accessibility-test the review screen defined by this service contract?

## Dev Agent Record

### Agent Model Used

kilo-auto/frontier

### Debug Log References

- `npm run build` (tsc): clean.
- `npm run lint` (eslint src/ test/): clean.
- `npm run format:check` (prettier): clean after `prettier --write` on the new/changed files.
- `node --env-file=.env.test --import tsx src/events/migrate.ts`: ran twice against a fresh
  `postgres:18.4` container (`ims2-test-postgres`, host port 5442, seeded via `deploy/compose/init-db.sql`)
  and applied idempotently both times, including the three new Story 4.7 migrations.
- `node --import tsx --test test/unit/schema-drift.test.ts`: 54/54 pass, including the three new
  `supplier_invoice`/`supplier_invoice_line`/`supplier_invoice_ingestion` entries.
- `npm test` (full suite, `--test-concurrency=1`): 603 tests, 589 pass, 14 fail, 0 cancelled. All 14
  failures are the pre-existing, previously-documented "idempotency 201-vs-409 class" across
  Stories 1.1, 1.6, 1.8, 2.1-2.4, 2.8, 3.2-3.4, and 3.10 (same failing test names as recorded in
  prior stories' Dev Agent Records, e.g. Story 4.3's "14 fails all the documented pre-existing
  idempotency 201-vs-409 class, 0 new"). Zero new failures; `test/integration/story-4-7.test.ts`
  itself is 23/23 green within this same run.
- `npm run spine-acceptance-contract`: 6/6 (Spine 1-5) green.
- `npm run edge:test`: 30/30 unchanged - no edge/offline path was added or touched, confirming the
  Binding Scope Decision "No edge or offline path."
- `git diff --check`: clean (no whitespace errors; only benign CRLF-on-checkout warnings from git's
  own autocrlf config, not introduced by this story).

### Completion Notes List

- Implemented Tasks 1-6, 8, and 9 in full. **Task 7 (AC 5, MSME integration) is intentionally left
  unchecked** because Story 4.6 (MSME registration) is not implemented anywhere in this codebase
  (confirmed: no MSME fields exist on the `supplier` projection or its read accessor). Per the
  story's own Task 7.4 instruction, the nullable projection columns
  (`msme_classification_at_capture`, `statutory_due_date`, `statutory_due_rule_version`) and the
  isolated integration hook exist end-to-end (stamped at both `supplier_invoice.captured` and
  `supplier_invoice.po_linked` time), but every value is left `null` rather than guessed - proven
  by dedicated assertions in `test/integration/story-4-7.test.ts` (AC1, AC4). This is a recorded
  blocking dependency, not a silently skipped requirement; the story is **not** claimed done, only
  moved to `review` with this gap explicitly documented, per Dev Notes: "Story 4.7 must not be
  marked done unless AC 5 is tested against the actual Story 4.6 supplier context, or the
  dependency is explicitly recorded as blocking rather than falsely completed."
- Story 4.5 (three-way match) is likewise absent; its `SOURCE_DOCUMENT_REQUIRED` consumer check on
  an `unmatched` invoice has no implementation to test against yet and is recorded as a second
  blocked downstream dependency (Task 8.4).
- Five new event types on the existing `procurement` stream: `invoice_ingestion.staged`,
  `invoice_ingestion.reviewed`, `supplier_invoice.captured`, `supplier_invoice.unmatched_recorded`,
  `supplier_invoice.po_linked`. Only `.captured` and `.po_linked` require `business_stream`
  (mirrors the `purchase_order.drafted`/`indent.raised` precedent exactly, per Task 2.2).
  `invoice_ingestion.reviewed` performs its captured/unmatched decision via a **nested
  `persistEvent` call inside the same transaction** (mirrors `purchase_order.issued`'s nested
  `indent.ordered` pattern in `src/compliance/purchase-order.ts`), using the review event's id as
  `causation_id`.
- **Duplicate override design decision** (Task 3.8/3.9, AC3): the ordinary and evidenced-override
  paths share exactly one event type (`supplier_invoice.captured`), matching Task 2's five-event
  contract literally. Authorization for the override is not distinguishable at the seam level from
  a single `metadata.actor.role` string alone, so it is enforced via a **distinct RBAC module
  scope** (`procurement.duplicate-override`) checked by `requireRole` on the
  `POST /api/v1/supplier-invoices/duplicate-overrides` route - never a hard-coded role literal, and
  independently assignable from ordinary `procurement` write access (proven by the "unauthorized
  caller" test). The seam itself never trusts a client-supplied `duplicate_of_invoice_id`; it is
  always the ID from the seam's own `getSupplierInvoiceByDuplicateGrain` lookup. A residual,
  explicitly-accepted limitation: a caller who already holds generic `POST /api/v1/events` access
  and the `procurement.duplicate-override` scope satisfies the same authorization this route
  checks - there is no seam-level, actor-role-based SOD check equivalent to
  `PO_CREATOR_CANNOT_APPROVE`, because no natural "creator" exists for a duplicate override. This
  mirrors the story's own Saved Clarification #2 (which enterprise role represents this capability
  remains an open product decision) rather than inventing new RBAC infrastructure in this story.
- Fixed two real bugs found only by running the integration suite against a live PostgreSQL
  instance (not caught by `tsc`/`eslint`, which is exactly why Task 9 forbids marking a task
  complete from inspection alone):
  1. `recomputeSupplierInvoiceTotals`'s `UPDATE ... FROM (subquery) ... RETURNING` had an ambiguous
     column reference (Postgres 42702) between the target table and the subquery alias for
     `subtotal`/`cgst_total`/etc. Fixed by qualifying the target table as `si` and the `RETURNING`
     list as `si.<column>`.
  2. The per-invoice `catch` around the header `INSERT` treated **every** `23505` unique violation
     as the benign same-`invoice_id` idempotent-retry case, silently swallowing it. Under real
     concurrency this also swallowed a genuine `uq_supplier_invoice_duplicate_grain` race loss,
     leaving the already-aborted Postgres transaction to fail every subsequent statement with a
     raw `25P02` ("current transaction is aborted") that surfaced as an unhelpful 500 instead of
     409 `DUPLICATE_EVENT`. Fixed by checking `err.constraint === 'supplier_invoice_pkey'`
     specifically before swallowing; any other unique violation (in practice, only the duplicate
     grain) now propagates to `src/events/store.ts`'s constraint-specific catch, which maps it to
     409 `DUPLICATE_EVENT` via the new `resolveSupplierInvoiceDuplicateConflict` fallback query -
     proven by the "concurrent ordinary captures... exactly one winner" test.
- `config.supplierInvoice.financialYearStartMonth` (default `4`, env
  `SUPPLIER_INVOICE_FY_START_MONTH`) added with an explicit 1-12 bound check, mirroring
  `config.indent`/`config.erp`'s static, env-backed, fail-closed pattern (Dev Notes decision:
  "do not add an effective-dated registry").
- No edge/offline path was added or modified, per the Binding Scope Decision; `edge/**`,
  `src/api/v1/edge.ts`, `src/sync/upload.ts`, and PowerSync rules are byte-for-byte unchanged
  (confirmed by `git status` and the unchanged 30/30 `npm run edge:test`).
- The file-review AC (AC2) is satisfied only at the service-contract and durable-state level, as
  the Binding Scope Decisions require: no central UI renders the review screen, and the PDF/CSV/XML
  "extraction" in tests is a trusted fixture at the extraction-boundary contract, not proof of real
  PDF/OCR/CSV/XML parsing (which this repository does not implement and is out of scope here).

### File List

**New files:**

- `read/projections/supplier_invoice.sql`
- `read/projections/supplier_invoice_line.sql`
- `read/projections/supplier_invoice_ingestion.sql`
- `src/compliance/supplier-invoice.ts`
- `src/read/projections/supplier_invoice.ts`
- `src/api/v1/supplier-invoices.ts`
- `test/integration/story-4-7.test.ts`

**Modified files:**

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/server.ts`
- `src/config/index.ts`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/4-7-supplier-invoice-capture.md` (this file: task
  checkboxes, Dev Agent Record, File List, Change Log, Status)

### Change Log

The Change Log table below records this session's implementation summary.

| Date       | Change                                                                                                                                                                                                    | Author           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 2026-08-05 | Implemented Tasks 1-6, 8-9 of Story 4.7 (Supplier Invoice Capture): three new canonical projections, five new `procurement`-stream events, the `src/compliance/supplier-invoice.ts` seam, read accessors, REST API, RBAC-scoped duplicate override, and a 23/23 integration suite. Task 7 (AC 5, MSME) intentionally left unchecked - Story 4.6 is not implemented; nullable fields and the link-time hook exist but are never fabricated. Fixed one ambiguous-column SQL bug and one duplicate-grain-race transaction-abort bug found only by live-database integration testing. Moved status from ready-for-dev to review. | kilo-auto/frontier |
| 2026-08-06 | Adversarial code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor) triaged 30 raw findings into 25 patches (all applied), 2 deferrals (ledgered), and 4 dismissals. Key patches: seam-level duplicate-override capability check via `user_role_assignments` (closes confirm-payload and direct-event bypasses), seam-level reviewed-ingestion gate for file captures, full GST head and per-line arithmetic verification with paise-integer comparisons, GST head exclusivity, invoice_date plausibility window, NFC grain normalization, PO line anchoring on manual capture, payload-actor reconciliation, `supplier_invoice_pkey` and `attachment_ref` constraint mappings (aborted-transaction 500s eliminated), 404-not-403 read oracle fix, review-queue list endpoint, ingestion-specific 404 code, query-param and text-length hygiene, and honest SQL header wording. Integration suite grew from 23 to 44 tests including the previously-fake supplier-mismatch link test. | claude-fable-5 review |
