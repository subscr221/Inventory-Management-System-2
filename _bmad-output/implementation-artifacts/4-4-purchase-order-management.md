---
baseline_commit: e81ca3d12c769dc65b0ae5d0e1d45d2e7f689964
---

# Story 4.4: Purchase Order Management

Status: done

Completion note: ultimate context engine analysis completed - comprehensive developer guide created (epics/PRD extraction, architecture spine, 4.1/4.3 story intelligence, code survey of HEAD + working tree, deferred-work ledger cross-check).

## Story

As a procurement officer,
I want to create standard, blanket, and contract purchase orders with DOA-gated approval by amount and category and issue them to the supplier through the ERP handoff,
so that spend is authorized by the right level of authority and orders flow to accounting cleanly.

## Acceptance Criteria

1. **Draft from approved requisition.** Given an approved requisition from Story 4.3, when the officer creates a PO of type standard, blanket, or contract against an active supplier (FR-P-05), then a `purchase_order.drafted` event is written with line items, prices, and the inherited business-stream tag. (Epics name this `PurchaseOrderDrafted`; the codebase convention is past-tense dot-separated, so the registered event type is `purchase_order.drafted`. Same mapping applies to all events below.)
2. **DOA-resolved approval.** Given a drafted PO with a total amount and category, when it is submitted for approval, then the approving authority is resolved from the DOA registry (FR-DOA-01) by amount band, and any attempt to issue the PO returns `error_code: "APPROVAL_REQUIRED"` (409) until that authority approves.
3. **Issue through the ERP adapter.** Given a PO approved by the DOA-resolved authority, when the officer issues it, then a `purchase_order.issued` event is written, its payload (line items, prices, taxes, business-stream tag) is recorded on the PO-outbound channel of the ERP integration adapter (`src/adapters/erp/`), the PO moves to `issued` status, and the linked requisition flips to `ordered` via an `indent.ordered` event carrying `purchase_order_id`. The AC is verified against the adapter's recorded outbound payload, not a live ERP.
4. **Supplier confirmation.** Given an issued PO, when the officer records the supplier's order confirmation with the promised delivery date, then a `purchase_order.confirmed` event is written, the promised date is stamped on the PO lines, and the linked requisition shows the expected delivery date (feeds the Story 4.2 responsiveness metric).
5. **Ceiling enforcement.** Given a blanket or contract PO with a defined ceiling, when cumulative releases would exceed the ceiling, then the release is blocked (`PO_CEILING_EXCEEDED`, 409) until the ceiling is revised through a fresh DOA-gated approval.
6. **Enforcement lives in the compliance seam.** All status guards, SOD, DOA verification, and ceiling math are enforced inside the persistEvent seam so a direct `POST /api/v1/events` cannot bypass them. The PO creator can never approve their own PO (`PO_CREATOR_CANNOT_APPROVE`, NFR-SEC-05).

## Tasks / Subtasks

- [x] Task 1: Projections - `purchase_order` and `purchase_order_line` (AC: 1, 4, 5)
  - [x] 1.1 Canonical SQL at repo root `read/projections/purchase_order.sql` following `read/projections/indent.sql` exactly: story-naming header, "Derived state ONLY" paragraph, guarded `DO $$` blocks for every named CHECK, guarded grants (`GRANT INSERT, SELECT, UPDATE ... TO app_user`, `GRANT SELECT ... TO readonly_user`, never DELETE), all idempotent.
  - [x] 1.2 `purchase_order` columns: `po_id UUID PK`, `po_number_ext TEXT` (unique index `uq_po_number_ext`), `po_type TEXT CHECK (standard|blanket|contract)`, `supplier_id UUID`, `indent_id UUID` (source requisition), `site_id UUID`, `business_stream TEXT`, `status TEXT CHECK` with values `draft, pending-approval, approved, rejected, issued, confirmed` (hyphenated `pending-approval`, mirroring indent's `pending-confirmation` style), `total_value NUMERIC(14,2)`, `ceiling_value NUMERIC(14,2) NULL` (required for blanket/contract, see `PO_CEILING_REQUIRED`), `released_value NUMERIC(14,2) NOT NULL DEFAULT 0`, `currency TEXT DEFAULT 'INR'`, `payment_terms TEXT NULL` (defaulted from the supplier record at draft, Story 4.1 contract), `created_by UUID`, `approver_actor_id UUID NULL`, `doa_entry_id UUID NULL`, `decided_at/decided_by/rejection_reason`, `issued_at TIMESTAMPTZ NULL`, `confirmed_at TIMESTAMPTZ NULL`, `promised_delivery_date DATE NULL`, `correlation_id`, `source_event_id`, timestamps.
  - [x] 1.3 `read/projections/purchase_order_line.sql` per the `indent_line.sql` header-plus-line precedent: `po_line_id PK, po_id, line_no, sku, item_category, ordered_qty NUMERIC(14,3), uom, unit_price NUMERIC(14,4), tax_rate_pct NUMERIC(5,2) NULL, line_value NUMERIC(14,2), promised_delivery_date DATE NULL`, `uq_po_line_no (po_id, line_no)`, positive-qty CHECK, `idx_po_line_sku`. No FK to `purchase_order` (same-transaction inserts; matches the indent_line design decision on the deferred ledger).
  - [x] 1.4 `CREATE SEQUENCE IF NOT EXISTS po_number_seq` with USAGE grant to app_user; server-side allocation `PO-YYYY-NNNN` (mirror `allocateIndentNumber` at `src/read/projections/indent.ts:331`; the known no-yearly-reset quirk is accepted, already on the ledger for indents).
  - [x] 1.5 Byte-identical mirrors appended to `deploy/compose/init-db.sql` with the `-- MUST stay identical to ...` comment. Keep LF line endings (CRLF breaks schema-drift byte comparison).
  - [x] 1.6 Append both files to the `MIGRATIONS` tail in `src/events/migrate.ts` (array position is migration order). Run `npm run db:migrate` twice; must be idempotent.
  - [x] 1.7 Add `EXPECTED` entries for both tables in `test/unit/schema-drift.test.ts` (see indent entries at lines 508-521 for shape).
- [x] Task 2: Event registration in `src/events/schema.ts` (AC: 1-5)
  - [x] 2.1 Payload + envelope interface pairs via the `Omit<EventEnvelope, 'payload'>` idiom (indent block near line 858 is the model) for: `purchase_order.drafted`, `purchase_order.approved`, `purchase_order.rejected`, `purchase_order.issued`, `purchase_order.confirmed`, `purchase_order.release_recorded`, `purchase_order.ceiling_revised`.
  - [x] 2.2 Append all seven to the tail of `SUPPORTED_EVENT_TYPES` (before `} as const`, line 1204), all `streamType: 'procurement'`. ONLY `purchase_order.drafted` gets `requiresBusinessStream: true` (the draft is the tagged business transaction; the flag is now enforced for non-inventory streams via the 4.3 extension of `assertInventoryTagging`, so forgetting it silently skips `UNTAGGED_TRANSACTION`). All lifecycle events `false`.
- [x] Task 3: Compliance seam `src/compliance/purchase-order.ts` (AC: 1, 2, 5, 6)
  - [x] 3.1 Exactly three exports mirroring `src/compliance/indent.ts`: `purchaseOrderEventType(envelope)` (null unless `stream_type === 'procurement'` AND event_type in the module Set), `assertPurchaseOrderShape(envelope)` (pre-transaction, non-DB), `applyPurchaseOrderProjection(envelope, client, eventId)`.
  - [x] 3.2 CRITICAL: `alreadyPersisted` must be the plain-SELECT variant from `src/compliance/indent.ts:201`. Do NOT copy `src/compliance/supplier.ts:272-275` - its `SELECT ... FOR UPDATE` on `domain_events` fails 42501 for app_user (INSERT, SELECT only) and is a live unfixed defect. Serialization comes from `SELECT ... FOR UPDATE` on the `purchase_order` row inside each applier.
  - [x] 3.3 `applyPoDrafted`: verify source indent exists and `status = 'approved'` (`PO_INDENT_NOT_APPROVED`), supplier exists and `status = 'active'` (reuse existing `SUPPLIER_NOT_ACTIVE` code), at least one line (`PO_LINE_REQUIRED`), blanket/contract must carry `ceiling_value` (`PO_CEILING_REQUIRED`). Resolve approver (Task 5), persist `approver_actor_id` + `doa_entry_id` on the row, set status `pending-approval` when approval is required, else `approved`. Insert header + lines; `total_value` computed in SQL NUMERIC (never JS floats).
  - [x] 3.4 `assertDecisionAllowed` mirror of indent.ts:492: status guard (`PO_ALREADY_DECIDED`, 409), SOD `created_by !== actor` (`PO_CREATOR_CANNOT_APPROVE`, 403), DOA-resolution match including active delegates (reuse the `NOT_RESOLVED_APPROVER` code, 403), enforce even when `approver_actor_id` is null (4.3 review patch precedent). Seam throws use SPECIFIC HTTP statuses (404/409/403), not blanket 400.
  - [x] 3.5 `applyPoIssued`: require status `approved` else `APPROVAL_REQUIRED` (409, existing stable code, satisfies AC2's error contract); stamp `issued_at`; record the outbound payload through the adapter (Task 4) in the SAME transaction; emit `indent.ordered` for the linked requisition via a nested persistEvent (4.3's nested `indent.duplicate_flagged` at indent.ts:361 is the precedent) with `purchase_order_id` set - the deferred-ledger assumption "ordered implies PO" (`applyIndentClosed`, indent.ts:850-857) depends on this story actually populating `indent.purchase_order_id`. Read `applyIndentOrdered` (indent.ts:661) first for the exact payload contract.
  - [x] 3.6 `applyPoConfirmed`: require status `issued` (`PO_NOT_ISSUED`, 409); stamp `promised_delivery_date` on header and lines (per-line overrides allowed in payload); update the linked indent's `expected_delivery_date` (check whether `indent.ordered` accepts it or whether a direct projection update inside the seam is needed - state mutation must stay event-sourced, so if indent has no suitable event, update via the indent projection accessor inside this transaction and document the decision).
  - [x] 3.7 `applyPoReleaseRecorded` (blanket/contract only): FOR UPDATE on the PO row, `released_value + release_value <= ceiling_value` compared in SQL NUMERIC; breach throws `PO_CEILING_EXCEEDED` (409) before any write.
  - [x] 3.8 `applyPoCeilingRevised`: fresh DOA resolution against the NEW ceiling value; same decision guards; update `ceiling_value`, `approver_actor_id`, `doa_entry_id`.
  - [x] 3.9 Wire into `src/events/store.ts`: `assertPurchaseOrderShape` alongside `assertIndentShape` (store.ts:467, pre-transaction), `applyPurchaseOrderProjection` alongside `applyIndentProjection` (store.ts:697, in-transaction). Nothing reordered.
- [x] Task 4: ERP adapter PO-outbound contract (AC: 3)
  - [x] 4.1 New module `src/adapters/erp/po-outbound.ts` defining the PO-outbound message contract: `{ po_number_ext, po_type, supplier (owner_party_code + gstin from the supplier row), business_stream, currency, lines: [{line_no, sku, ordered_qty, uom, unit_price, tax_rate_pct, line_value}], total_value, issued_at, correlation_id }`. This is distinct from INT-ERP-01 (BOM outbound / cost inbound). The adapter records the payload durably; live transmission is per-deployment configuration and is NOT implemented here.
  - [x] 4.2 Durable record: new table `po_outbound_message` (canonical SQL + init-db mirror + migrate entry + schema-drift EXPECTED, same quadruple as Task 1): `message_id PK, po_id, payload JSONB, recorded_at`. Do NOT use an `erp_` table-name prefix and do NOT touch `erp_purchase_order`/`erp_purchase_order_line` - those are Story 2.9 read-only inbound reference projections guarded by `assertErpReadOnly` (`SOURCE_SYSTEM_READ_ONLY`), and ERP remains master only for ERP-originated POs. Native POs coexist; Story 3.4 receives against the ERP projections until native POs go live.
  - [x] 4.3 Write the record inside the `purchase_order.issued` transaction so issue and outbound payload commit atomically. Integration test asserts the recorded payload shape at the adapter boundary (AC3's verification contract).
- [x] Task 5: DOA resolution (AC: 2, 5)
  - [x] 5.1 REUSE `resolveApprover(transactionType, value)` exported from `src/api/v1/indents.ts:66` - do not write a fourth copy (private near-twins already exist in suppliers.ts and transfer-requests.ts; the indent one is the corrected, exported precedent that returns `doaEntryId` and takes real value).
  - [x] 5.2 Module constant `PO_DOA_TYPE = 'purchase_order_approval'` (pattern: `INDENT_DOA_TYPE` at indents.ts:31). Value = PO `total_value` for approval, NEW ceiling for `ceiling_revised`. DOA band comparison must not use floating point (4.3 review patch precedent); pass the SQL NUMERIC string through.
  - [x] 5.3 Category note: the DOA registry has no category column (role, transaction_type, value bands only). Phase-1 resolution is by transaction_type + amount band, matching how 4.3 resolved FR-P-04's "amount, category, department" - category-specific routing would be additional `transaction_type` values, config data not code. Document in Dev Notes; do not invent a category column.
  - [x] 5.4 Fail closed: unresolvable approver throws `APPROVAL_UNRESOLVED` (409, already a permanent code on all surfaces).
  - [x] 5.5 Seed DOA bands in the integration test for `purchase_order_approval` (three-tier mirror of the indent seeding is fine); assert band selection at exact boundaries, not just that an approver came back (4.3 review patch precedent).
- [x] Task 6: Read accessors `src/read/projections/purchase_order.ts` (AC: all)
  - [x] 6.1 Mirror `src/read/projections/indent.ts`: `Queryable` + `runner(client?)`, `UUID_REGEX` guard, `getPurchaseOrderById(id, client?, forUpdate?)` (every seam read preceding a write passes `forUpdate: true`), `getPurchaseOrderLines`, `listPurchaseOrders` with status/supplier/site filters, ILIKE escaping `replace(/[%_\\]/g, '\\$&')` + `ESCAPE '\'`, `permittedLocationsForModuleScope(roles, 'procurement', 'read')` site scoping, `insertPurchaseOrder`, `insertPurchaseOrderLine`, `updatePurchaseOrderStatus`, `allocatePoNumber(year, client)`.
- [x] Task 7: REST routes `src/api/v1/purchase-orders.ts` (AC: all)
  - [x] 7.1 Copy the boilerplate block from `src/api/v1/indents.ts` / suppliers.ts:26-60 (`ActorContext`, `actorContext(req)`, `auditCtxFor(req, actor, httpStatus)`). Export base handler + `requireRole`-wrapped handler per route; `module: 'procurement'`, reads `functionScope: 'read'`, writes `'write'`. No role-name literals in workflow code (`test/unit/no-hardcoded-role-in-workflow.test.ts` fails the build).
  - [x] 7.2 Routes: `POST /api/v1/purchase-orders` (draft from `indent_id`, lines defaulted from `indent_line` rows with zero re-keying per PROC-REQ-01, officer may override prices/qty in body), `GET /api/v1/purchase-orders`, `GET /api/v1/purchase-orders/:poId`, `POST /api/v1/purchase-orders/:poId/approve`, `POST /api/v1/purchase-orders/:poId/reject` (rejection_reason required), `POST /api/v1/purchase-orders/:poId/issue`, `POST /api/v1/purchase-orders/:poId/confirm` (promised_delivery_date required), `POST /api/v1/purchase-orders/:poId/releases`, `POST /api/v1/purchase-orders/:poId/ceiling`.
  - [x] 7.3 ALL state changes via `persistEvent` - no direct projection INSERT/UPDATE in handlers. Payment terms defaulted from the supplier row at draft (Story 4.1 contract: "terms default onto that supplier's POs").
  - [x] 7.4 Register in `createAppRouter()` (`src/server.ts`, after the Story 4.3 block at line 373) under a `// Story 4.4: Purchase Order Management` comment. Note: `/api/v1/erp/purchase-orders` reject-routes already exist in the router - the native `/api/v1/purchase-orders` prefix is distinct and does not collide.
  - [x] 7.5 Append every new route to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` (sorted; the gate diff-asserts the whole surface).
- [x] Task 8: Notifications (AC: 2, 4)
  - [x] 8.1 Approval-needed notice to the resolved approver at draft when `requiresApproval`: `emitNotificationInTransaction` with `target.user_id` set to the approver (4.3 AC5 precedent - direct targeting, exactly one delivery row; do NOT broadcast to a role, that was the 4.1 gap).
  - [x] 8.2 Approve/reject decision notices to `created_by` via `emitNotificationInTransaction` (AD-17: decisions are part of the business fact). Category strings e.g. `po_approval_request`, `po_decision`.
  - [x] 8.3 Issue already notifies the indent requester if `applyIndentOrdered` emits one - read it first; do not double-notify.
- [x] Task 9: Error codes (AC: 2, 5, 6)
  - [x] 9.1 New permanent codes: `PO_NOT_FOUND` (404), `PO_ALREADY_DECIDED` (409), `PO_CREATOR_CANNOT_APPROVE` (403), `PO_INDENT_NOT_APPROVED` (409), `PO_LINE_REQUIRED` (400), `PO_CEILING_REQUIRED` (400), `PO_CEILING_EXCEEDED` (409), `PO_NOT_ISSUED` (409), `PO_REJECTION_REASON_REQUIRED` (400). Reused existing codes: `APPROVAL_REQUIRED`, `APPROVAL_UNRESOLVED`, `NOT_RESOLVED_APPROVER`, `SUPPLIER_NOT_ACTIVE`, `INDENT_NOT_FOUND`, `UNTAGGED_TRANSACTION`, `DUPLICATE_EVENT`.
  - [x] 9.2 This story has NO edge/offline path (PO creation is a desktop procurement-officer flow per UX; precedent: Stories 3.8/3.9 "no edge path"). Therefore NO changes to `src/sync/upload.ts`, `edge/src/sync/connector.ts`, or `edge/src/messages/en.json` are required. If any 4.4 event later gains an edge surface, the codes must be wired into all three at that point.
- [x] Task 10: Integration test + gates (AC: all)
  - [x] 10.1 `test/integration/story-4-4.test.ts` modeled on `test/integration/story-4-3.test.ts` (harness head: own SQL projection application via `getAdminPool()` - add purchase_order, purchase_order_line, po_outbound_message to the file list - SCIM provisioning with the test bearer, `randomUUID().slice(0, 8)` run suffix, port-0 server, serial).
  - [x] 10.2 Coverage per AC: draft from approved indent with inherited business stream + zero-re-key lines; `UNTAGGED_TRANSACTION` on missing tag; `PO_INDENT_NOT_APPROVED` on raised indent; `SUPPLIER_NOT_ACTIVE`; issue blocked with `APPROVAL_REQUIRED` while pending; SOD `PO_CREATOR_CANNOT_APPROVE`; `NOT_RESOLVED_APPROVER` for wrong approver; approve then issue writes `po_outbound_message` with the full recorded payload (AC3 boundary assertion) AND flips indent to `ordered` with `purchase_order_id` populated; confirm stamps promised date on header + lines and indent `expected_delivery_date`; blanket release within ceiling passes, breach returns `PO_CEILING_EXCEEDED`, ceiling revision through fresh DOA then release passes; DOA tier boundaries exact; replay of a duplicate event leaves one row (accept 201-or-409 per the Story 3-10 idempotent-replay decision; pin row count).
  - [x] 10.3 Test hygiene from 4.3: suffix external IDs with `-${run}`; `crypto.randomUUID()` everywhere (strict RFC-4122 regex rejects nil UUIDs); assert NUMERIC as strings (`'50000.00'`); assert DATE via `::text` cast; `DB_PORT=5442` for the test container; `runDispatchCycle()` for deterministic notification delivery assertions.
  - [x] 10.4 Gates, all must pass with 0 NEW failures: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` (twice), `npm test` (14 pre-existing idempotency 201-vs-409 failures are documented and NOT this story's), `npm run spine-acceptance-contract` (6/6), schema-drift, no-hardcoded-role. Edge gates unchanged (no edge files touched): `npm run edge:test` should rerun 30/30 untouched.

## Dev Notes

### Scope boundaries

- Amendment and cancellation of POs: NO functional requirement exists (PRD/annex grep confirmed - only e-way bill cancellation and ECO amendments elsewhere). The UX slide-to-confirm "cancel PO" pattern is a future surface. Do NOT build amend/cancel events or routes.
- MSME due-date stamping is Story 4.6 (it stamps at PO confirmation - your `purchase_order.confirmed` event is its hook; keep the payload roomy but build nothing MSME here). Three-way match is 4.5. Scorecards are 4.2 (consumes `purchase_order.issued`/`purchase_order.confirmed` - event names and promised-date fields are downstream contracts, name them carefully). Spend analytics reporting is Story 12.3.
- Live ERP transmission: per-deployment configuration, out of scope. The recorded `po_outbound_message` row IS the deliverable.
- No edge/offline surface (see Task 9.2). No UI work; the central app consumes the REST API.
- Blanket/contract releases here are value-ledger entries enforcing the ceiling (AC5). Release-to-receipt wiring is 4.5's territory.
- PO closure: do not add a `closed` status or closure event. The deferred-work ledger holds a 3.4 entry ("under-receipt tolerance needs a PO-closure-triggered discrepancy check as its own follow-up story") - design nothing that blocks a future closure event, but do not build it.

### Critical inherited defects and traps

- `src/compliance/supplier.ts` `alreadyPersisted` still carries the `FOR UPDATE`-on-`domain_events` 42501 defect at HEAD. The indent seam (plain SELECT, indent.ts:195-201) is the correct model. Copying the supplier seam will 500 every PO event on the production pool.
- 14 pre-existing `npm test` failures (idempotency 201-vs-409 class across older stories, plus one spine DOA-resolution flake) are documented. Do not fix, do not inherit blame; write 4.4 tests to accept either surface and pin row-count invariants.
- `requiresBusinessStream` is enforced for non-inventory streams via the registry since 4.3 (`src/compliance/business-stream.ts:60-95`). Only `purchase_order.drafted` carries `true`.
- `test/integration/story-3-7.test.ts` never executes (pre-existing); `.env.test` port mismatch trap: export `DB_PORT=5442`.
- node-postgres parses DATE at local midnight - assert calendar dates via `::text`.
- `git stash` round-trips can flip `deploy/compose/init-db.sql` to CRLF and break schema drift.

### Key architectural constraints

- Stack pinned: Node 24 LTS ESM, TypeScript ^5.8, PostgreSQL 18.4, pg ^8.16.0, jose ^6.2.3, `node:test` only, no new dependencies. No web research required for this story; nothing new enters the dependency tree.
- Event sourcing: every state change through `persistEvent` (`src/events/store.ts:334`); pre-transaction shape asserts never consume an idempotency key; projections apply in the SAME transaction as the `domain_events` insert (AD-14, AD-16).
- The seam, not the handler, enforces business rules (AD-12): direct `POST /api/v1/events` and any future edge path must hit identical guards (SOD-01 precedent at indent.ts:489-527).
- DOA registry is the single approval resolver (AD-3); workflow config consumes it, never overrides. `findMatchingDoaEntry` uses earliest-created wins on overlap; `listActiveDoaEntries` ascending walk is the no-active-holder fallback; vacation delegation via `findActiveDelegation`.
- Notifications: decisions transactional (AD-17, `emitNotificationInTransaction`); informational notices decoupled (`emitNotification`, never throws). `NotificationTarget.user_id` (added 4.3) targets exactly one user.
- Naming: entity `purchase_order` singular; events past-tense dot-separated; external references `_ext` suffixed; internal IDs UUIDv4; NUMERIC money/qty compared in SQL, never JS floats; `business_date` is a separate IST-derived field where needed.

### Requisition linkage contract (the load-bearing seam with 4.3)

The `indent` row already carries `purchase_order_id UUID` and `expected_delivery_date DATE` columns built as this story's hook. `applyIndentOrdered` (`src/compliance/indent.ts:661`) and `applyIndentClosed` (indent.ts:850-857, which deliberately does NOT verify `purchase_order_id` because "no current path creates ordered without PO") both assume THIS story populates `purchase_order_id` when it emits `indent.ordered`. Read `applyIndentOrdered` before writing Task 3.5; match its payload contract exactly. The indent status CHECK already includes `ordered`, so no indent-side schema change is expected.

### Project Structure Notes

- New files: `read/projections/purchase_order.sql`, `read/projections/purchase_order_line.sql`, `read/projections/po_outbound_message.sql`, `src/compliance/purchase-order.ts`, `src/read/projections/purchase_order.ts`, `src/api/v1/purchase-orders.ts`, `src/adapters/erp/po-outbound.ts`, `test/integration/story-4-4.test.ts`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts` (two wiring lines, nothing reordered), `src/events/migrate.ts` (three tail entries), `src/server.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`.
- NOT modified: anything `erp_`-prefixed, `src/adapters/erp/sync.ts` (inbound adapter untouched), `src/sync/upload.ts`, `edge/**` (no edge path), `src/compliance/indent.ts` (its `indent.ordered` applier is consumed, not changed - if its payload contract cannot carry what AC4 needs, extend additively and document).
- Canonical SQL lives at repo root `read/projections/`, NOT `src/read/projections/` (the 4.1 story doc cites a nonexistent src path - known doc defect, do not propagate).

### Previous story intelligence (4.3, reviewed done 2026-08-02)

- 12 review patches landed in 4.3 whose lessons apply directly: seam throws with specific HTTP statuses; DOA band resolution float-free; approver enforcement even when `approver_actor_id` is null; `occurred_at` validation; duplicate-link overwrite guard. Bake these in from the start rather than collecting the same findings.
- 4.1 do-not-copy list: broadcast-to-role notifications; `approve`/`reject` guarded only by `procurement:write` (any writer could approve - closed for indents via `NOT_RESOLVED_APPROVER`, still open for suppliers); missing SOD; `doa_band_id` declared but never populated; no integration test (which is why the supplier 42501 defect shipped).
- Test seeding pattern: `seedUser` SCIM provisioning, roles `floor_supervisor` (requester) and `procurement_head` (officer/approver) already exist in the 4.3 harness; DOA tiers are configuration data seeded per-test, not code constants.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-4.4 (lines 1587-1617); Epic 4 goal lines 377-387, 1489-1491]
- [Source: _bmad-output/planning-artifacts/prds/.../archive/prd.md FR-P-05, FR-P-04, FR-P-09, FR-DOA-01; PLANNING/archive/SCM-Requirements-Document.md lines 79-87 (annex governs FR consequence detail); NFR-SEC-05 (SOD); PROC-REQ-01 (zero re-keying)]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` sections Stack, Event Envelope, Design Paradigm (ERP adapter is the only ERP-touching component), API Contract, Consistency Conventions, AD-3, AD-12, AD-14, AD-16, AD-17]
- [Source: read/projections/erp_purchase_order.sql header (read-only inbound reference, ERP master for ERP-originated POs); src/compliance/erp-readonly.ts (SOURCE_SYSTEM_READ_ONLY)]
- [Source: _bmad-output/implementation-artifacts/4-3-purchase-requisition-and-indent-loop.md Dev Notes + Dev Agent Record; _bmad-output/implementation-artifacts/deferred-work.md 4-3 entries (indent.ordered assumption, indexes, sequence reset), 3-4 entry (PO-closure follow-up), 1-11 entries (notification fan-out, escalation resolution)]
- [Source: _bmad-output/planning-artifacts/ux-designs/.../EXPERIENCE.md lines 62, 120, 253-267, 433-435, 497 (Procurement Officer desktop persona, sidebar, high-stakes approval patterns - future UI, not this story)]

## Dev Agent Record

### Agent Model Used

claude-fable-5 (Claude Fable 5)

### Debug Log References

- Session start found a substantial uncommitted 4.4 implementation already in the working tree (all new files present, schema/store/migrate/server wired) with every task unchecked. The session verified that work against the story spec, fixed the defects below, completed the test suite, and ran all gates.
- Defects found in the pre-existing working-tree implementation and fixed this session:
  - `purchase_order.drafted` payload carried no `business_stream` while the event is registered `requiresBusinessStream: true` - every draft would have failed `UNTAGGED_TRANSACTION`. The draft route now inherits the tag from the source indent (AC1) and the payload interface documents it.
  - `applyPoDrafted` swallowed `APPROVAL_UNRESOLVED` into a silent `pending-approval` with no approver; Task 5.4 requires fail-closed. It now propagates (409) and rolls the draft back.
  - DOA resolution used a JS-float line-total. The seam now inserts header+lines first, recomputes `total_value` in SQL NUMERIC, and resolves the approver from the NUMERIC string (`resolveApprover`/`findMatchingDoaEntry` widened to `number | string`).
  - `applyPoReleaseRecorded` compared ceiling in `parseFloat`. Replaced with a guarded SQL NUMERIC UPDATE (`addPoReleaseValue`); breach returns `PO_CEILING_EXCEEDED` with the locked row's values.
  - `applyPoCeilingRevised` trusted payload approver ids with no guards - a direct `POST /api/v1/events` could raise a ceiling unapproved (AC6 violation). The seam now re-resolves the approver against the NEW ceiling, applies SOD + resolved-approver-or-delegate guards, and fails closed on `APPROVAL_UNRESOLVED`.
  - `applyPoConfirmed` stamped line promised dates only when per-line overrides were supplied; AC4 requires the base date on every line. It also now locks the indent row (`FOR UPDATE`) before stamping `expected_delivery_date`.
  - The integration test was unrunnable as found (shared indent flipped to `ordered` mid-suite, `approved`-status expectation impossible under full-coverage DOA bands, replay via an ignored `_event_id` body field, wrong supplier response shape). Rewritten per Task 10.
- 14 pre-existing `npm test` failures (idempotency 201-vs-409 class) are documented and unchanged; 0 new failures.

### Completion Notes List

- Task 1: `read/projections/purchase_order.sql` + `purchase_order_line.sql` follow the indent precedent exactly (guarded DO blocks, guarded grants, no DELETE grant, no FK from line to header, `po_number_seq` with USAGE grant). Byte-identical mirrors verified in `deploy/compose/init-db.sql`; migrate ran twice idempotently; schema-drift EXPECTED entries added.
- Task 2: seven `purchase_order.*` events registered at the `SUPPORTED_EVENT_TYPES` tail, all `streamType: 'procurement'`; only `purchase_order.drafted` carries `requiresBusinessStream: true`.
- Task 3: `src/compliance/purchase-order.ts` exports exactly `purchaseOrderEventType` / `assertPurchaseOrderShape` / `applyPurchaseOrderProjection`; `alreadyPersisted` is the plain-SELECT indent variant (the supplier `FOR UPDATE` 42501 defect was NOT copied); serialization via `FOR UPDATE` on the `purchase_order` row; issue emits nested `indent.ordered` carrying `purchase_order_id` (the 4.3 ledger assumption is now satisfied); wired into `store.ts` beside the indent seam, nothing reordered.
- Task 4: `src/adapters/erp/po-outbound.ts` defines the PO-outbound contract; `po_outbound_message` row written inside the `purchase_order.issued` transaction; no `erp_`-prefixed table touched; integration test asserts the full recorded payload at the adapter boundary.
- Task 5: reused `resolveApprover` from `src/api/v1/indents.ts` (no fourth copy); `PO_DOA_TYPE = 'purchase_order_approval'`; band comparison float-free end to end; fail-closed on unresolvable approver; three-tier bands seeded in the test with exact boundary assertions (50000 resolves to the tier 1 approver and entry, 200000 to the tier 2 approver and entry).
- Task 5.3 (documented decision): the DOA registry has no category column; Phase-1 resolution is by transaction_type + amount band. Category-specific routing would be additional `transaction_type` values - configuration data, not code.
- Task 3.6 (documented decision): the indent vocabulary has no event for a post-ordered date update (`indent.ordered` requires status `approved`), so `expected_delivery_date` is stamped through the indent projection accessor inside the `purchase_order.confirmed` transaction; the confirmed domain event in the same transaction is the replayable source.
- Task 6: `src/read/projections/purchase_order.ts` mirrors the indent accessor module (Queryable/runner, UUID guard, forUpdate reads, ILIKE escaping, site scoping via `permittedSites`, `allocatePoNumber`), plus `addPoReleaseValue` (SQL NUMERIC ceiling guard) and outbound-message accessors.
- Task 7: nine routes registered under `// Story 4.4: Purchase Order Management` in `createAppRouter` after the 4.3 block; all state changes via `persistEvent`; payment terms default from the supplier row; draft lines default from `indent_line` rows (zero re-keying, PROC-REQ-01); routes appended to `allowedSpineRoutes`; no role-name literals.
- Task 8: approval request targets the resolved approver via `target.user_id` (transactional, exactly one delivery row); approve/reject decisions notify `created_by` transactionally (AD-17); `applyIndentOrdered` emits no notification, so issue does not double-notify.
- Task 9: new permanent codes `PO_NOT_FOUND`, `PO_ALREADY_DECIDED`, `PO_CREATOR_CANNOT_APPROVE`, `PO_INDENT_NOT_APPROVED`, `PO_LINE_REQUIRED`, `PO_CEILING_REQUIRED`, `PO_CEILING_EXCEEDED`, `PO_NOT_ISSUED`, `PO_REJECTION_REASON_REQUIRED`, plus `PO_NOT_PENDING_APPROVAL` and `PO_NOT_RELEASE_TYPE` (status/type guards surfaced during implementation, 409). Reused codes as specified. No edge/offline surface - `src/sync/upload.ts`, `edge/**` untouched.
- Task 10: `test/integration/story-4-4.test.ts` - 17 tests, all passing, covering every AC including SOD, NOT_RESOLVED_APPROVER, UNTAGGED_TRANSACTION via direct `POST /api/v1/events`, DOA boundary math, notification targeting with `runDispatchCycle`, DOA-gated ceiling revision (creator blocked, non-resolved blocked, tier-2 authority succeeds), and idempotent replay pinned by row count.
- Gates: `npm run build` clean; `npm run lint` clean; `npm run format:check` clean; `db:migrate` twice idempotent; `npm test` 562/576 with only the 14 documented pre-existing idempotency failures (0 new); `spine-acceptance-contract` 6/6; `edge:test` 30/30 (no edge files touched); schema-drift and no-hardcoded-role gates pass inside the suite.
- Out-of-scope working-tree changes inherited from the prior session (not this story's, left in place): supplier onboarding submit-before-approve fix in `src/api/v1/suppliers.ts`, the supplier `alreadyPersisted` 42501 fix + `owner_party_code` uppercase normalization in `src/compliance/supplier.ts`, and prettier reformatting of `src/compliance/indent.ts`. All suite-verified green.

### File List

New files:

- read/projections/purchase_order.sql
- read/projections/purchase_order_line.sql
- read/projections/po_outbound_message.sql
- src/compliance/purchase-order.ts
- src/read/projections/purchase_order.ts
- src/api/v1/purchase-orders.ts
- src/adapters/erp/po-outbound.ts
- test/integration/story-4-4.test.ts

Modified files:

- src/events/schema.ts
- src/events/store.ts
- src/events/migrate.ts
- src/server.ts
- deploy/compose/init-db.sql
- test/unit/schema-drift.test.ts
- test/integration/story-1-9.test.ts
- src/api/v1/indents.ts (resolveApprover value widened to number | string; APPROVAL_UNRESOLVED message generalized)
- src/read/projections/doa_registry.ts (findMatchingDoaEntry value widened to number | string)
- src/api/v1/suppliers.ts (inherited prior-session fix, see Completion Notes)
- src/compliance/supplier.ts (inherited prior-session fix, see Completion Notes)
- src/compliance/indent.ts (prettier formatting only)

## Change Log

- 2026-08-03: Story 4.4 implemented - PO projections, seven purchase_order.* events, compliance seam with SOD/DOA/ceiling enforcement, ERP PO-outbound adapter record, DOA reuse, read accessors, nine REST routes, transactional notifications, error codes, 17-test integration suite; all gates green (562/576 with 14 documented pre-existing failures, spine 6/6, edge 30/30). Status set to review.

## Review Findings

Adversarial code review 2026-08-03 (three parallel layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor; baseline e81ca3d, uncommitted working tree). 0 decision-needed, 9 patch fixed, 4 deferred, 3 dismissed. Clean confirmations: no SQL injection (all accessors parameterized, ILIKE escaped); the seam uses the plain-SELECT alreadyPersisted variant, NOT the supplier.ts FOR-UPDATE-on-domain_events 42501 defect; canonical SQL is byte-identical to the init-db.sql mirror; lifecycle appliers lock the PO row FOR UPDATE.

- [x] [Review][Patch] Blanket/contract lifecycle actions require explicit status guards [src/compliance/purchase-order.ts:713, 758] - resolved decision: releases require `issued` or `confirmed`; ceiling revisions are allowed only while the PO is alive and not `rejected`. Patch the seam guards accordingly.
- [x] [Review][Patch] Release recording requires unique release_reference per PO [src/api/v1/purchase-orders.ts:512, src/compliance/purchase-order.ts:742] - resolved decision: require a non-empty release_reference and enforce uniqueness per PO so a retried release cannot add release_value twice.
- [x] [Review][Patch] Ceiling revisable below already-released value [src/compliance/purchase-order.ts:822] - applyPoCeilingRevised never checks new_ceiling_value against po.released_value and no DB constraint ties the two columns, so an approver can lower the ceiling below what was already released, leaving released_value greater than ceiling_value (HIGH)
- [x] [Review][Patch] Seam trusts payload site_id instead of deriving it from the source indent [src/compliance/purchase-order.ts:345] - applyPoDrafted stores p['site_id'] verbatim; a direct POST /api/v1/events can create a PO whose site_id differs from indent.site_id, and site_id drives read-scoping (AC6 says the seam is authoritative) (MEDIUM)
- [x] [Review][Patch] Blanket/contract ceiling_value null coerces to a zero ceiling [src/api/v1/purchase-orders.ts:154-198] - the route rejects only ceiling_value === undefined, then Number(null) and Number('') both yield 0, which passes the seam shape guard, creating a zero-ceiling PO on which every positive release fails PO_CEILING_EXCEEDED (MEDIUM)
- [x] [Review][Patch] NUMERIC(14,2) overflow on computed line_value/total_value surfaces as an unhandled 500 [src/compliance/purchase-order.ts:164-186, src/read/projections/purchase_order.ts:219] - shape validation checks finiteness and positivity but no magnitude bound, so ordered_qty times unit_price can exceed NUMERIC(14,2) and raise Postgres 22003, which is not caught (MEDIUM)
- [x] [Review][Patch] Invalid calendar dates pass isDateString then fail at the PostgreSQL DATE write [src/compliance/purchase-order.ts:50-52] - isDateString uses a YYYY-MM-DD regex plus Date.parse, which accepts rollover dates such as 2026-02-31 and 2026-04-31 (verified), so confirm and per-line promised dates can reach the DATE column and 500; apply strict calendar validation to header and per-line dates and reject malformed per-line overrides instead of silently substituting the header date (MEDIUM)
- [x] [Review][Patch] Sub-paisa release_value accepted then rounded on storage [src/compliance/purchase-order.ts:109-117, src/read/projections/purchase_order.ts:318] - values below 0.01 pass the positive-number check and the full-precision ceiling compare but round to 0.00 when stored in released_value NUMERIC(14,2); reject release_value with scale greater than 2 (MEDIUM)
- [x] [Review][Patch] Draft HTTP handler resolves the DOA band with a JS float [src/api/v1/purchase-orders.ts:167-176] - the handler computes the total in IEEE-754 and calls resolveApprover with a number purely to shape the 201 response; the seam re-resolves float-free from the SQL NUMERIC and is authoritative, but at a band boundary the response error_code can disagree with the persisted PO status; resolve from the NUMERIC string or drop the handler pre-resolution (LOW)
- [x] [Review][Defer] PO write routes are not site-write-scoped [src/api/v1/purchase-orders.ts:349-592] - deferred, pre-existing procurement-module pattern; the sibling indents.ts write routes are identically read-scoped/write-unscoped, and the seam still enforces SOD plus DOA approver identity, so this is a module-wide RBAC decision, not a 4.4-specific gap
- [x] [Review][Defer] Supplier auto-approval emits two events in two separate transactions [src/api/v1/suppliers.ts:237-284] - deferred, belongs to the supplier story scope; a failure after the first commit leaves the supplier submitted-but-not-approved with unrelated correlation ids
- [x] [Review][Defer] Concurrent same-po_id draft persists a phantom domain event [src/compliance/purchase-order.ts:360-365] - deferred, matches the accepted indent precedent; on a 23505 race the loser returns silently while the outer domain_events insert still writes a drafted event with no projection (reachable only via crafted direct events with identical po_id)
- [x] [Review][Defer] Multiple POs draftable from one approved indent, only the first is issuable [src/compliance/purchase-order.ts:262] - deferred, low impact; applyPoDrafted does not guard that the source indent has no existing non-rejected PO, so a second PO becomes permanently un-issuable once the first flips the indent to ordered
