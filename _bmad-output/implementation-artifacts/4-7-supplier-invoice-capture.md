# Story 4.7: Supplier Invoice Capture

Status: ready-for-dev

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

- [ ] Task 1: Add canonical supplier-invoice projections (AC: 1-7)
  - [ ] Create `read/projections/supplier_invoice.sql` at the repository root using the Story 4.4 projection header, derived-state warning, guarded named constraints, guarded grants, and no DELETE grant.
  - [ ] Define header columns: `invoice_id UUID PRIMARY KEY`, `supplier_id UUID NOT NULL`, `supplier_gstin_ext TEXT NOT NULL`, `invoice_number_ext TEXT NOT NULL`, `invoice_number_normalized TEXT NOT NULL`, `invoice_date DATE NOT NULL`, `financial_year_start INTEGER NOT NULL`, `po_id UUID NULL`, `site_id UUID NULL`, `business_stream TEXT NULL`, `status TEXT NOT NULL CHECK (status IN ('unmatched','captured'))`, `currency TEXT NOT NULL DEFAULT 'INR'`, `recipient_gstin_ext TEXT NULL`, `irn_ext TEXT NULL`, `subtotal NUMERIC(14,2)`, `cgst_total NUMERIC(14,2)`, `sgst_total NUMERIC(14,2)`, `igst_total NUMERIC(14,2)`, `cess_total NUMERIC(14,2)`, `total_value NUMERIC(14,2)`, `msme_classification_at_capture TEXT NULL`, `statutory_due_date DATE NULL`, `statutory_due_rule_version TEXT NULL`, `duplicate_of_invoice_id UUID NULL`, `duplicate_override_reason TEXT NULL`, `capture_method TEXT CHECK (capture_method IN ('manual','file'))`, `ingestion_id UUID NULL`, `captured_by UUID NOT NULL`, `captured_at TIMESTAMPTZ NOT NULL`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, and timestamps.
  - [ ] Add database checks for non-negative GST and monetary totals, valid duplicate override pairing, valid status and PO pairing, and MSME classification vocabulary when non-null. Store monetary columns as exact NUMERIC values, never floating-point values.
  - [ ] Add `uq_supplier_invoice_duplicate_grain` as a unique index on `(supplier_gstin_ext, invoice_number_normalized, financial_year_start)` only where `duplicate_of_invoice_id IS NULL`. Add indexes for unmatched work, supplier/date lists, PO lookup, site/status lists, and downstream GST reconciliation keys.
  - [ ] Create `read/projections/supplier_invoice_line.sql` with `invoice_line_id`, `invoice_id`, `line_no`, `po_line_id NULL`, `sku`, `quantity NUMERIC(14,3)`, `uom`, `unit_price NUMERIC(14,4)`, `taxable_value NUMERIC(14,2)`, `cgst_amount`, `sgst_amount`, `igst_amount`, `cess_amount`, and `line_total NUMERIC(14,2)`. Add `uq_supplier_invoice_line_no`, positive quantity, non-negative amount checks, and useful SKU and PO-line indexes.
  - [ ] Create `read/projections/supplier_invoice_ingestion.sql` with ingestion ID, source format, attachment reference, SHA-256 hash, detected MIME, byte size, immutable extracted draft JSONB, review status `review-required|reviewed`, uploader, upload time, reviewer, review time, correction summary JSONB, resulting invoice ID, correlation ID, source event ID, and timestamps. Add one unique hash/reference guard appropriate to the attachment boundary without treating a reused attachment as a business duplicate.
  - [ ] Append all three migrations after Story 4.4 migrations in `src/events/migrate.ts`, mirror each canonical SQL block byte-for-byte in `deploy/compose/init-db.sql` using LF endings, and add complete `EXPECTED` entries in `test/unit/schema-drift.test.ts`.
  - [ ] Run `npm run db:migrate` twice against the test database and prove idempotency.
- [ ] Task 2: Register event payloads and downstream contracts (AC: 1-6)
  - [ ] Add payload and envelope interface pairs in `src/events/schema.ts` using the existing `Omit<EventEnvelope, 'payload'>` pattern for `invoice_ingestion.staged`, `invoice_ingestion.reviewed`, `supplier_invoice.captured`, `supplier_invoice.unmatched_recorded`, and `supplier_invoice.po_linked`.
  - [ ] Register all five at the tail of `SUPPORTED_EVENT_TYPES` with `streamType: 'procurement'`; only `supplier_invoice.captured` and `supplier_invoice.po_linked` require a business stream. Staging, review, and unmatched recording do not fabricate one.
  - [ ] Declare `business_stream` as required in captured and PO-linked payloads. Because `assertInventoryTagging` runs before the transaction and projection seam, the HTTP handlers must load the source PO and inject its governed business stream into the server-built event payload before `persistEvent`, mirroring Story 4.4. The compliance seam then locks the PO, derives the value again, and rejects missing or disagreeing payload data. Direct generic events missing the tag fail with `UNTAGGED_TRANSACTION`.
  - [ ] Keep all original identifiers, normalized identifiers, exact decimal inputs, GST heads, PO line references, provenance, review corrections, duplicate override evidence, and MSME calculation inputs in the event contract. The projection may derive totals, but the replay source must remain sufficient to reproduce them.
  - [ ] Do not reorder existing interfaces or registry entries.
- [ ] Task 3: Implement `src/compliance/supplier-invoice.ts` and central wiring (AC: 1-6)
  - [ ] Export the established three-symbol seam: `supplierInvoiceEventType`, `assertSupplierInvoiceShape`, and `applySupplierInvoiceProjection`; keep helpers private.
  - [ ] Copy the plain-SELECT `alreadyPersisted` pattern from `src/compliance/purchase-order.ts:264-271`. Never use `SELECT ... FOR UPDATE` on `domain_events`.
  - [ ] Shape validation must strictly validate UUIDs, ISO timestamps, real calendar dates, financial limits and decimal scale, GSTIN and SHA-256 formats, source format, required arrays, unique line numbers, non-empty invoice numbers, extracted-draft shape, and review corrections before an idempotency key can be consumed.
  - [ ] Validate `invoice_date` with the strict Story 4.4 calendar-date implementation. Reject rollover dates such as 31 February. Reject null and empty numeric values before coercion. Bound values to their NUMERIC precision and reject excess scale instead of allowing PostgreSQL rounding or overflow.
  - [ ] For valid PO capture, lock the PO row; accept only `issued` or `confirmed`; derive supplier ID, site ID, and business stream from the PO; load the active supplier; snapshot its governed GSTIN; reject any payload disagreement; and require each invoice line's `po_line_id` and SKU to belong to that PO.
  - [ ] Insert header and lines, calculate line and header arithmetic in PostgreSQL NUMERIC, and compare the submitted total to the SQL result exactly at paise scale. Do not use JavaScript float sums for authoritative decisions.
  - [ ] Derive `financial_year_start` from `invoice_date` and configured start month. Before insert, perform a seam-level duplicate lookup that throws `DUPLICATE_EVENT` with the full existing invoice ID, number, status, supplier, and financial year for both manual and reviewed-file paths. Keep `uq_supplier_invoice_duplicate_grain` as the concurrency race guard; its `src/events/store.ts` fallback must safely query `supplier_invoice` by the attempted grain and return the same detail shape rather than relying on the generic `domain_events` lookup.
  - [ ] The ordinary path rejects duplicates. The override route must set a server-owned `duplicate_of_invoice_id` and reason only after finding the existing row and authorizing the command. The event payload cannot self-authorize an override.
  - [ ] `invoice_ingestion.staged` writes only a review-required draft. `invoice_ingestion.reviewed` locks the ingestion row, rejects repeated or unauthorized review, persists reviewer and correction summary, and calls nested `persistEvent` in the same transaction for captured or unmatched creation. Use the review event ID as causation ID.
  - [ ] `supplier_invoice.unmatched_recorded` stores no PO, site, or business stream and is visible only in the controlled exception queue. `supplier_invoice.po_linked` locks invoice and PO, verifies unmatched status and supplier match, derives site and business stream, validates line mappings, stamps MSME context if available, and moves status to captured.
  - [ ] Wire `assertSupplierInvoiceShape` immediately after `assertPurchaseOrderShape` and `applySupplierInvoiceProjection` immediately after `applyPurchaseOrderProjection` in `src/events/store.ts`. Nothing existing is reordered.
- [ ] Task 4: Add exact read-model accessors (AC: 3, 4, 7)
  - [ ] Create `src/read/projections/supplier_invoice.ts` using the `Queryable`, `runner`, UUID guard, optional transaction client, and `forUpdate` patterns from `src/read/projections/purchase_order.ts`.
  - [ ] Provide locked detail reads, line reads, ingestion reads, duplicate lookup, unmatched lookup, inserts, SQL total recomputation, ingestion review update, PO-link update, and paginated list reads.
  - [ ] Escape `%`, `_`, and backslash for every ILIKE search. Cap list limits at 200. Apply permitted procurement site filtering. When the reader is not wildcard, exclude unmatched rows whose site is null.
  - [ ] Return PostgreSQL NUMERIC values as strings and DATE values as calendar strings. Never parse financial values into JavaScript numbers in the accessor contract.
- [ ] Task 5: Implement REST commands and reads (AC: 1-4, 7)
  - [ ] Create `src/api/v1/supplier-invoices.ts` using the actor context, audit context, error wrapper, and `requireRole` patterns from `src/api/v1/purchase-orders.ts` and `src/api/v1/suppliers.ts`. Identity, uploader, reviewer, and override authorization come from authenticated context, never the body. The handler derives `site_id` and `business_stream` from the locked source or linked PO and writes them into the event payload; the client never supplies them.
  - [ ] Implement `POST /api/v1/supplier-invoices` for ordinary manual capture; `POST /api/v1/supplier-invoices/duplicate-overrides` for privileged evidenced capture; `GET /api/v1/supplier-invoices`; `GET /api/v1/supplier-invoices/:invoiceId`; `POST /api/v1/supplier-invoices/:invoiceId/link-po`; `POST /api/v1/supplier-invoice-ingestions`; `GET /api/v1/supplier-invoice-ingestions/:ingestionId`; and `POST /api/v1/supplier-invoice-ingestions/:ingestionId/confirm`.
  - [ ] Every mutation calls `persistEvent`. No handler directly inserts or updates invoice projections. Return the durable projection, not an optimistic body echo.
  - [ ] Manual capture and confirmed ingestion share the same compliance path and duplicate semantics. Do not implement a second validation path in the handlers.
  - [ ] Register routes under a Story 4.7 block after Story 4.4 in `src/server.ts`. Add the exact route set to the sorted `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
- [ ] Task 6: Define stable failures and authorization behavior (AC: 2-7)
  - [ ] Reuse `DUPLICATE_EVENT`, `SOURCE_DOCUMENT_REQUIRED`, `UNTAGGED_TRANSACTION`, `SUPPLIER_NOT_FOUND`, `SUPPLIER_NOT_ACTIVE`, `PO_NOT_FOUND`, `PO_NOT_ISSUED`, `INVALID_PARAMS`, and the existing RBAC errors.
  - [ ] Add only necessary service errors such as `SUPPLIER_INVOICE_NOT_FOUND`, `INVOICE_LINE_REQUIRED`, `INVOICE_TOTAL_MISMATCH`, `INVOICE_REVIEW_REQUIRED`, `INVOICE_ALREADY_REVIEWED`, `INVOICE_PO_SUPPLIER_MISMATCH`, `INVOICE_PO_LINE_MISMATCH`, `INVOICE_NOT_UNMATCHED`, `INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED`, `INVOICE_SOURCE_FORMAT_UNSUPPORTED`, and `INVOICE_PROVENANCE_INVALID` with precise 400, 403, 404, or 409 statuses.
  - [ ] No edge path means these codes are not added to edge permanent-code or localization files. Central clients consume the standard `{ error_code, message, details, trace_id }` envelope.
  - [ ] Do not write role-name literals in workflow code. Use procurement read/write scope plus the project's assignment data. Duplicate override and PO link are separate command handlers so deployments can assign them independently.
- [ ] Task 7: Integrate the Story 4.6 MSME seam without inventing it (AC: 5)
  - [ ] Read the implemented Story 4.6 supplier/MSME fields before coding this task. Reuse its accessor and dated rule contract rather than adding a competing MSME registry.
  - [ ] Store the verified classification and rule version as immutable capture-time snapshots. Calculate the due date from the invoice date and Story 4.6 inputs using calendar-date arithmetic, not elapsed milliseconds.
  - [ ] Preserve already stamped dates when later revalidation lapses, as Story 4.6 requires. Linking a formerly unmatched invoice computes the snapshot at link time and audits that timing.
  - [ ] If Story 4.6 is absent, leave the nullable projection fields and isolated integration hook but keep this task and AC 5 unchecked. Do not report the story complete.
- [ ] Task 8: Build comprehensive integration and concurrency coverage (AC: 1-7)
  - [ ] Create `test/integration/story-4-7.test.ts` from the real production router and PostgreSQL harness in `test/integration/story-4-4.test.ts`. Apply supplier, indent, PO, invoice, line, and ingestion SQL in dependency order; use SCIM provisioning, port-zero server, run-scoped external IDs, and random UUIDs.
  - [ ] Cover manual capture, exact SQL arithmetic, GST heads, IRN preservation, inherited business stream, derived site and supplier, issued and confirmed PO acceptance, non-issued PO rejection, active supplier requirements, PO-line membership, and edit-log atomicity.
  - [ ] Cover PDF, CSV, and XML staged fixtures; immutable provenance; review correction persistence; no capture before review; one capture after review; repeat review rejection; and nested-event correlation and causation.
  - [ ] Cover same-grain duplicates through manual/manual, file/file, and manual/file combinations; separate financial years at 31 March and 1 April; conservative invoice-number normalization; existing-record details; unauthorized override; blank reason; authorized override; and concurrent ordinary captures with exactly one winner.
  - [ ] Cover unmatched creation, wildcard-only visibility, invalid link, supplier mismatch, line mismatch, successful link, and status transition. Because Story 4.5 is not implemented, verify the 4.7-owned unmatched status/read contract now and keep its downstream three-way-match `SOURCE_DOCUMENT_REQUIRED` consumer test visibly blocked until Story 4.5 lands.
  - [ ] Cover MSME 15-day no-agreement rule, earlier agreed date, 45-day cap, rule version snapshot, and no fabricated MSME context. Because Story 4.6 is not implemented, keep these consumer integration tests visibly blocked until its authoritative contract lands.
  - [ ] Test malformed dates, numeric overflow, excess decimal scale, null and empty numeric inputs, negative GST, mismatched totals, malformed SHA-256, unsupported format, invalid GSTIN, list pagination, escaped ILIKE, site filtering, direct-event bypass attempts, idempotent replay row counts, and rollback after injected failures.
  - [ ] Assert NUMERIC columns as strings and DATE columns with `::text`. Accept the current idempotent replay surface while pinning one durable invoice and one event.
- [ ] Task 9: Run all quality gates and record evidence (AC: all)
  - [ ] Run `npm run build`, `npm run lint`, and `npm run format:check`.
  - [ ] Run `npm run db:migrate` twice.
  - [ ] Run `npm test` and prove zero new failures against the measured baseline.
  - [ ] Run `npm run spine-acceptance-contract`, schema drift, and no-hardcoded-role tests.
  - [ ] Run `npm run edge:test` unchanged to prove the no-edge boundary remains intact.
  - [ ] Run `git diff --check` and inspect only intended files.
  - [ ] Do not mark a task complete from inspection alone. Record command, exit result, test counts, and any proven pre-existing failure in the Dev Agent Record.

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

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
