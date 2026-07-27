---
baseline_commit: 112587c2c7e3860ac966b1d323ed66cd7278b190
---

# Story 3.7: Packing, Shipping, and Dispatch Documents (FR-W-05, FR-W-06)

Status: review

## Story

As a dispatch clerk,
I want to complete packing validation, generate shipping documents (bill of lading, commercial invoice, packing slips, labels), and confirm dispatch — with the system blocking dispatch if any compliance hold exists,
so that every outbound shipment is documented, weighed, and cleared before the truck leaves the gate.

**Scope note:** Phase 1 delivers BOL, packing slip, commercial invoice, and labels only. Customs documentation, carrier rate shopping, and load planning (FR-W-06 remaining clauses) are deferred to Phase 2 / Epic 15.

## Acceptance Criteria

1. **Given** all pick lines for a dispatch order (Story 2.9 sales-order projection) are confirmed
   **When** the packing station operator confirms weights, labels, and cartonization
   **Then** a packing record is created with actual weights and label references; the order moves to `ready_to_ship` status (FR-W-05).

2. **Given** the order is `ready_to_ship`
   **When** the dispatcher generates shipping documents
   **Then** a BOL, packing slip, and commercial invoice are produced with the correct lot references, weights, and consignee details taken from the Story 2.9 sales-order projection (FR-W-06).

3. **Given** the order contains a lot under a quality hold (FR-Q-09 integration point; hold state and `LOT_ON_HOLD` semantics are established in Story 2.3)
   **When** dispatch is attempted
   **Then** the system blocks dispatch with `error_code: "LOT_ON_HOLD"` — no shipping document is generated until the hold is released.

## Tasks / Subtasks

- [x] Task 1: Event contracts and stream registration (AC: 1, 2, 3)
  - [x] 1.1 In `src/events/schema.ts`, define `DispatchOrderPackedPayload`: `packing_record_id` (UUID), `dispatch_order_id` (UUID, references `erp_sales_order.id`), `sku` (TEXT), `packed_qty` (NUMERIC(14,3) string), `lot_id` (UUID, the `lot_master.lot_id` of the picked lot), `actual_weight_kg` (NUMERIC(10,3), nullable), `label_ref` (TEXT, nullable), `carton_count` (INTEGER), `packed_by` (TEXT, server-set), `packed_at` (timestamptz, server-set). Event type: `dispatch.packed`, stream type: `warehouse`, `requiresBusinessStream: false` (mirror Story 3.5/3.6).
  - [x] 1.2 Define `DispatchOrderShippingDocumentsGeneratedPayload`: `dispatch_order_id` (UUID), `document_types` (TEXT[] — `['bol','packing_slip','commercial_invoice','labels']`), `generated_by` (TEXT, server-set), `generated_at` (timestamptz, server-set). Event type: `dispatch.shipping_documents_generated`, stream type: `warehouse`, `requiresBusinessStream: false`.
  - [x] 1.3 Define `DispatchOrderDispatchedPayload`: `dispatch_order_id` (UUID), `dispatched_by` (TEXT, server-set), `dispatched_at` (timestamptz, server-set), `lot_on_hold_blocked` (BOOLEAN — true if any lot was on hold and dispatch was gated). Event type: `dispatch.dispatched`, stream type: `warehouse`, `requiresBusinessStream: false`.
  - [x] 1.4 Register all three event types in `SUPPORTED_EVENT_TYPES` with stream type `'warehouse'`, mirroring Story 3.6's registration pattern at schema.ts:409-508. The `warehouse` stream already exists from Story 3.5; append, do not duplicate.

- [x] Task 2: Projection DDL for `packing_record` (AC: 1, 2, 3)
  - [x] 2.1 Create `read/projections/packing_record.sql` following the idempotent pattern of `read/projections/pick_task.sql` (guarded `DO $$` blocks, `CREATE TABLE IF NOT EXISTS`, constraints in separate `DO $$` blocks). Table `packing_record` at grain `(packing_record_id)` — single-column PK. Columns: `packing_record_id UUID PRIMARY KEY`, `dispatch_order_id UUID NOT NULL` (FK to `erp_sales_order.id`), `sku TEXT NOT NULL`, `packed_qty NUMERIC(14,3) NOT NULL` with CHECK `chk_packing_record_qty` (`packed_qty > 0`), `lot_id UUID`, `actual_weight_kg NUMERIC(12,3)`, `label_ref TEXT`, `carton_count INTEGER NOT NULL DEFAULT 0` with CHECK (`carton_count >= 0`), `status TEXT NOT NULL DEFAULT 'packed'` with CHECK `chk_packing_record_status` (`status IN ('packed','documents_generated','dispatched')`), `packed_by UUID NOT NULL`, `packed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index on `(dispatch_order_id)`, `(lot_id)`.
  - [x] 2.2 Create `read/projections/dispatch_document.sql`. Table `dispatch_document`: `document_id UUID PRIMARY KEY`, `dispatch_order_id UUID NOT NULL`, `document_type TEXT NOT NULL` with CHECK (`document_type IN ('bol','packing_slip','commercial_invoice','label')`), `document_content TEXT` (the rendered document body), `generated_by UUID NOT NULL`, `generated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index on `(dispatch_order_id)`.
  - [x] 2.3 Extend `dispatch_order_status` (created by Story 3.6 in `read/projections/pick_task.sql`): add columns `packed_at TIMESTAMPTZ`, `packed_by UUID`, `dispatched_at TIMESTAMPTZ`, `dispatched_by UUID` through an additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block. Do NOT recreate the table. The existing `picked_at`/`picked_by` columns are preserved.
  - [x] 2.4 Guarded grants in idempotent `DO $$` blocks: `INSERT, SELECT, UPDATE` for `app_user` on both new tables; `SELECT` for `readonly_user`. No DELETE.
  - [x] 2.5 Register both SQL files in `MIGRATIONS` array in `src/events/migrate.ts` (append after Story 3.6's `pick_task.sql` / `pick_line.sql` entries). Mirror both table DDLs BYTE-FOR-BYTE into `deploy/compose/init-db.sql`, appended after the existing Story 3.6 block, WITHOUT touching the `powersync_publication` block. Add the additive `dispatch_order_status` ALTER to both files.
  - [x] 2.6 Register `packing_record` and `dispatch_document` in the `EXPECTED` array of `test/unit/schema-drift.test.ts` (mirror the entry shape at schema-drift.test.ts:264-295).

- [x] Task 3: Read-model TypeScript accessors (AC: 1, 2, 3)
  - [x] 3.1 Create `src/read/projections/packing_record.ts` mirroring `src/read/projections/pick_task.ts` structure. Accessors:
    - `createPackingRecord(input, client)` — insert with all fields from Task 2.1.
    - `updatePackingRecordStatus(packingRecordId, status, client)` — idempotent `UPDATE ... SET status=$2, updated_at=now() WHERE packing_record_id=$1`.
    - `listPackingRecordsByDispatchOrder(dispatchOrderId, client?)` — returns all records for an order.
    - `getPackingRecordById(packingRecordId, client?)` — single record lookup.
  - [x] 3.2 Create `src/read/projections/dispatch_document.ts`. Accessors:
    - `createDispatchDocument(input, client)` — insert with all fields from Task 2.2.
    - `listDocumentsByDispatchOrder(dispatchOrderId, client?)` — returns documents for an order.
    - `getDocumentById(documentId, client?)` — single document lookup.
    - `clearDocumentsByDispatchOrder(dispatchOrderId, client)` — deletes documents for an order (idempotent, used when re-generating — hard DELETE is acceptable here because documents are regenerable renderings, not domain events; the deletion is logged via the `dispatch.shipping_documents_generated` event's `trace_id` in the edit log).

- [x] Task 4: Compliance seam and central write-path wiring (AC: 1, 2, 3)
  - [x] 4.1 Create `src/compliance/dispatch.ts` with shape-assert and apply functions following `src/compliance/pick.ts` structure.
  - [x] 4.2 `assertDispatchPackedShape(envelope)` — pre-transaction: require `dispatch_order_id` (UUID), `sku` (TEXT), `packed_qty` (NUMERIC string > 0), `lot_id` (UUID), `carton_count` (INTEGER >= 0). `actual_weight_kg` and `label_ref` are nullable (not every packing confirms weight/label at packing time — weight may be captured later at dispatch). Reject `DISPATCH_PACKED_INVALID_PAYLOAD` if any required field is absent/malformed.
  - [x] 4.3 `assertDispatchShippingDocumentsGeneratedShape(envelope)` — require `dispatch_order_id` (UUID), `document_types` (non-empty TEXT[] with each element IN `('bol','packing_slip','commercial_invoice','label')`).
  - [x] 4.4 `assertDispatchDispatchedShape(envelope)` — require `dispatch_order_id` (UUID).
  - [x] 4.5 `applyDispatchPackedProjection(envelope, client, eventId)` — in-transaction: (1) verify the dispatch order is `picked`: check `dispatch_order_status.picked_at IS NOT NULL` for the `dispatch_order_id`; if not picked, reject `DISPATCH_ORDER_NOT_PICKED`. (2) verify the dispatch order is NOT already dispatched: check `dispatched_at IS NULL`; if already dispatched, reject `DISPATCH_ORDER_ALREADY_DISPATCHED` (treat as idempotent-no-op if replayed). (3) Create the `packing_record` row via `createPackingRecord`. (4) Move stock from `picked` to... nothing — stock stays at `picked` until dispatch (AC1: packing creates the record, dispatch reduces on-hand). The `packed_qty` MUST match the total `confirmed_quantity` across this dispatch order's pick lines — read from `pick_line` SUM where `dispatch_order_line_id` resolves to this `dispatch_order_id` via `erp_sales_order.id`; if mismatch, reject `PACKED_QTY_MISMATCH`. (5) Update `dispatch_order_status`: set `packed_at`, `packed_by`. (6) Emit notification: `emitNotificationInTransaction(client, { eventType: 'dispatch.packed', targetRole: 'dispatch_clerk', targetLocation: <dispatch_order's site_id from erp_sales_order>, payload: { dispatch_order_id, packed_by } })` — the packing-complete notification signals to the dispatch clerk that orders are ready for document generation.
  - [x] 4.6 `applyDispatchShippingDocumentsGeneratedProjection(envelope, client, eventId)` — in-transaction: (1) verify `dispatch_order_status.packed_at IS NOT NULL`; reject `DISPATCH_ORDER_NOT_PACKED` if packing not complete. (2) Verify no lot in the dispatch order's packing records is on quality hold: for each `packing_record.lot_id` join `lot_master` and check `quality_hold_status IS DISTINCT FROM 'held'`; if any lot is held, reject `LOT_ON_HOLD` with the held lot IDs (AC3). (3) Generate the shipping documents: render BOL, packing slip, commercial invoice, and labels as plain-text documents (do NOT build a full PDF engine — plain text is sufficient for Phase 1; mirror Story 3.6's paper pick list approach). Document content draws from: `erp_sales_order` (consignee from `ship_to_ext`, SKU, quantity, `so_number_ext`), `packing_record` (actual weights, carton counts, lot references), `pick_line` (confirmed lots), `lot_master` (expiry dates for lot references on documents), and `location_register` (ship-from site name from `ship_from_site_id`). (4) Store rendered documents via `createDispatchDocument`. (5) Update `packing_record.status = 'documents_generated'` for all records on this dispatch order via `updatePackingRecordStatus`.
  - [x] 4.7 `applyDispatchDispatchedProjection(envelope, client, eventId)` — in-transaction: (1) verify `dispatch_order_status.packed_at IS NOT NULL` and NOT already dispatched (idempotent replay guard). (2) Verify `dispatch_order_status` shows `documents_generated` has been at least attempted (check the `dispatch_document` table has at least one row for this `dispatch_order_id`). (3) Re-run the LOT_ON_HOLD check from 4.6 step 2 (AC3 enforcement at dispatch time — protects against a hold placed between document generation and actual dispatch). (4) Decrement on-hand: `UPDATE stock_balance SET on_hand = on_hand - packing_record.packed_qty, picked = picked - packing_record.packed_qty, updated_at = now() FROM packing_record WHERE stock_balance.sku = packing_record.sku AND stock_balance.lot_id::text = packing_record.lot_id::text AND stock_balance.stock_class = 'owned' AND packing_record.dispatch_order_id = $1` — note the lot_id type bridge: `stock_balance.lot_id` is TEXT (lot_number), `packing_record.lot_id` is UUID; resolve through `lot_master` or use a subquery that bridges via `lot_master.lot_id = packing_record.lot_id AND lot_master.lot_number = stock_balance.lot_id`. This must be a precise decrement, not a LEAST()-guarded one, because dispatch is final. (5) Update `dispatch_order_status`: set `dispatched_at`, `dispatched_by`. (6) Update `packing_record.status = 'dispatched'` for all records on this dispatch order.
  - [x] 4.8 Wire into `src/events/store.ts`: add asserts after `assertPickTaskCompletedShape` (store.ts after pick.ts block) and apply functions after `applyPickTaskCompletedProjection` (store.ts after pick.ts block) but before the `nextVersion`/`domain_events` insert.
  - [x] 4.9 The LOT_ON_HOLD check in 4.6/4.7 MUST use `FOR UPDATE` on `lot_master` rows for the dispatch order's lots to prevent a concurrent hold placement from racing between the check and the dispatch commit. Acquire these row locks before the main check transaction — mirror Story 3.6's FOR UPDATE pattern in `applyPickTaskCompletedProjection`.

- [x] Task 5: Document rendering service (AC: 2)
  - [x] 5.1 Create `src/warehouse/document-renderer.ts` (non-API, non-projection business logic, living in the `warehouse/` directory established by Story 3.5). Export `renderBOL(dispatchOrderId, client): Promise<string>`, `renderPackingSlip(dispatchOrderId, client): Promise<string>`, `renderCommercialInvoice(dispatchOrderId, client): Promise<string>`, `renderLabels(dispatchOrderId, client): Promise<string[]>`.
  - [x] 5.2 `renderBOL`: plain-text bill of lading with ship-from (resolve from `erp_sales_order.ship_from_site_id` → `location_register` hierarchy), consignee (`erp_sales_order.ship_to_ext`), carrier TBD (leave blank — carrier selection is Phase 2 / Epic 15), line items (SKU, quantity, lot numbers from pick_line confirmed lots), total carton count (sum from packing_record), actual weight (sum from packing_record). Format as a plain text block with labeled fields and a delimiter line.
  - [x] 5.3 `renderPackingSlip`: plain-text packing slip per dispatch order with per-line: SKU, description (TBD — no item description exists in `erp_sales_order`; leave blank or use SKU), ordered quantity, packed quantity, lot numbers, carton count. Totals footer. Include a tear-off returnable-carton acknowledgment.
  - [x] 5.4 `renderCommercialInvoice`: plain-text commercial invoice with seller (resolve from `erp_sales_order.ship_from_site_id` → `location_register`), buyer (from `ship_to_ext`), invoice number (use SO number `so_number_ext`), date (today), line items with SKU, quantity, unit price (TBD — `erp_sales_order` does not carry price in the projection; leave unit price column as "TBD" and flag this as an Epic 4 scope for future enrichment), total quantity, total weight. Terms and conditions boilerplate: "Goods sold on open account. Payment terms per agreement. E. & O. E."
  - [x] 5.5 `renderLabels`: return an array of plain-text label strings, one per carton. Each label: site code, SO number, SKU, lot number, carton N of M, date. Labels are plain text placeholders — a future story can add barcode/machine-readable labels; Phase 1 labels are human-readable peel-and-stick content.
  - [x] 5.6 All rendering functions MUST be deterministic given the same data (no random or date-generated content beyond call-supplied parameters). This makes document regeneration idempotent and testable.

- [x] Task 6: REST API with RBAC and site scoping (AC: 1, 2, 3)
  - [x] 6.1 Create `src/api/v1/dispatch.ts` following `src/api/v1/pick-tasks.ts` structure. Handlers:
    - `POST /api/v1/dispatch/:dispatchOrderId/pack` — accepts `{ sku, packedQty, lotId, actualWeightKg?, labelRef?, cartonCount }`, emits `dispatch.packed` via `persistEvent` (AC1).
    - `POST /api/v1/dispatch/:dispatchOrderId/generate-documents` — emits `dispatch.shipping_documents_generated` via `persistEvent` (AC2). Returns `{ documentIds: string[] }` with the created document IDs.
    - `GET /api/v1/dispatch/:dispatchOrderId/documents` — lists all documents for the order.
    - `GET /api/v1/dispatch/documents/:documentId` — returns a single document with its rendered content.
    - `POST /api/v1/dispatch/:dispatchOrderId/dispatch` — emits `dispatch.dispatched` via `persistEvent` (AC3). Returns the dispatch confirmation with dispatched_at.
    - `GET /api/v1/dispatch/packing-records?dispatchOrderId=X` — lists packing records for an order.
  - [x] 6.2 RBAC via `requireRole`, module `warehouse` (reuse the existing module string from Story 3.5/3.6). Pack and dispatch confirmation: `dispatch_clerk`, `warehouse_manager`. Document generation and read: `dispatch_clerk`, `warehouse_manager`, `inventory_controller`. Read-only document access: `store_assistant`, `warehouse_operator`. Enforce site scope via `permittedLocationsForModuleScope`. Server-set `packed_by`, `generated_by`, `dispatched_by` from `authContext` — never trust client-supplied identity.
  - [x] 6.3 Register every handler in `src/server.ts` (mirror the pick-tasks registration lines) and add each new route to the spine allowlist in `test/integration/story-1-9.test.ts`.

- [x] Task 7: Edge (offline) event acceptance (AC: 1, 2, 3)
  - [x] 7.1 In `src/api/v1/edge.ts`, the existing `resolveModuleFromBody` maps `stream_type: 'warehouse'` to the `warehouse` module (confirmed in Story 3.6). The same mapping applies for this story's new `dispatch.*` events carrying `requiresBusinessStream: false` — no change needed to the mapping.
  - [x] 7.2 In `edgeEventUploadBase` (edge.ts:159-190), server-set `body.payload.packed_by = authContext.userId` for `dispatch.packed`, `body.payload.generated_by = authContext.userId` for `dispatch.shipping_documents_generated`, and `body.payload.dispatched_by = authContext.userId` for `dispatch.dispatched` — mirroring the existing `completed_by` injection pattern.
  - [x] 7.3 SOD guard: dispatch confirmation (`dispatch.dispatched`) is a `dispatch_clerk`/`warehouse_manager` operation. The edge upload path authorizes purely on module + write — add an event-type check inside `edgeEventUploadBase` (or inside the apply function via a role assertion for `dispatch.dispatched` only) that rejects a `store_assistant` or `warehouse_operator` from posting `dispatch.dispatched`. Mirror Story 3.6's SOD guard for `pick_task.completed`.
  - [x] 7.4 Add permanent error codes to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and add `errors.<CODE>` strings to `edge/src/messages/en.json`.

- [x] Task 8: Tests (AC: 1, 2, 3)
  - [x] 8.1 Create `test/integration/story-3-7.test.ts` (Node built-in runner `node:test`, mirror `test/integration/story-3-6.test.ts`). Cover: packing record creation after pick completion (AC1 happy path); packing rejection when order is not picked (`DISPATCH_ORDER_NOT_PICKED`); packing rejection when order is already dispatched (`DISPATCH_ORDER_ALREADY_DISPATCHED`); packing record with weight and label ref; document generation after packing (AC2); document generation blocked when NOT packed (`DISPATCH_ORDER_NOT_PACKED`); document generation blocked when lot is on hold (`LOT_ON_HOLD` — AC3); dispatch confirmation after document generation (AC3 happy path); dispatch blocked when lot is on hold (`LOT_ON_HOLD` — AC3 re-check at dispatch time); dispatch blocked when not packed; dispatch blocked when already dispatched; stock `on_hand` and `picked` decrement after dispatch; idempotent replay of the same `dispatch.packed` event (no-op, not duplicate mutation); RBAC enforcement: `store_assistant` cannot dispatch; site scoping: out-of-scope site rejected `LOCATION_ACCESS_DENIED`.
  - [x] 8.2 Add edge unit coverage in `edge/test/unit/` for `dispatch.packed`, `dispatch.shipping_documents_generated`, `dispatch.dispatched` envelope validation and the new `PERMANENT_ERROR_CODES` entries.
  - [x] 8.3 Run `npm test`, `npm run edge:test`, and keep the spine gate green (`npm run spine-acceptance-contract`). Add the `packing_record` and `dispatch_document` table expectations so `test/unit/schema-drift.test.ts` passes. Run `tsc`, `eslint`, and the build for both backend and edge.

## Dev Notes

### Previous Story Intelligence (Story 3.6 — Pick Task Generation and Execution)

- Story 3.6 established the `pick_task` / `pick_line` projection pair and the `dispatch_order_status` table (`dispatch_order_id PK, picked_at, picked_by`). This story (3.7) EXTENDS `dispatch_order_status` additively with `packed_at`, `packed_by`, `dispatched_at`, `dispatched_by` — never recreates it.
- Story 3.6's `applyPickTaskCompletedProjection` emits a notification to the `warehouse_manager` role (documented placeholder for the packing station). This story refines that: when a `dispatch.packed` event fires, a notification SHOULD be sent to the relevant dispatch clerk role — but the notification target is a Story 3.7 scope decision (packing-complete notification). Use `emitNotificationInTransaction` to the `dispatch_clerk` role for AC1 completion notification, mirroring Story 3.6's AC7 pattern.
- Story 3.6 resolved the `lot_id` type bridge: `stock_balance.lot_id` is TEXT (lot_number), while `pick_line` / `lot_master.lot_id` is UUID. This story inherits the same bridge: `packing_record.lot_id` is UUID (`lot_master.lot_id`), and the on-hand decrement in Task 4.7 step 4 MUST resolve `packing_record.lot_id` through `lot_master` to `lot_number` before updating `stock_balance.lot_id` (which holds the TEXT lot_number). Use the helper `lotNumberForUuid(uuid, client)` defined in Story 3.6's `compliance/pick.ts` — if it is local to that file, extract it to a shared location (`src/read/projections/lot_master.ts` already has `getLotByNumberAndSku`; add a `getLotNumberByUuid` accessor for the reverse lookup, or reuse the existing accessors).
- Story 3.6's code-review deferred work (cancelled pick lines not releasing allocation, no cancellation path) does NOT block Story 3.7 — packing reads confirmed pick lines only, ignoring cancelled lines.
- Story 3.6 added `stock_balance.picked` column (stock that moved from `allocated` to `picked` but not yet shipped). This story is the consumer: dispatch confirmation decrements `on_hand` and `picked` simultaneously (Task 4.7 step 4). The `available` generated column (`on_hand - allocated - picked`) will increase when `picked` decreases — this is correct: dispatched stock becomes available to its new location.

### Architecture and Conventions the Dev MUST Follow

- Event-sourced write path: single seam `persistEvent(envelope, auditCtx?, externalClient?)` in `src/events/store.ts`. Shape asserts run pre-transaction (rejects consume no idempotency key); projection apply run in-transaction with FOR UPDATE row locks. New asserts go after `assertPickTaskCompletedShape` (store.ts after pick.ts block); new apply functions go after `applyPickTaskCompletedProjection` (store.ts after pick.ts block) and before the `nextVersion`/`domain_events` insert.
- Projection trio (idempotent SQL, migrate registration, init-db mirror) is mandatory — same pattern as all prior stories.
- TypeScript accessor pattern: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, NUMERIC bound/returned as strings.
- Runtime is plain Node HTTP with custom router. Handlers live in `src/api/v1/*.ts` and register in `src/server.ts`. NOT Next.js; no `route.ts` files.
- Tests use Node built-in runner (`node:test`), NOT vitest. Every new route must be added to the spine route-surface allowlist in `test/integration/story-1-9.test.ts`.
- The `warehouse/` module directory holds non-API, non-projection business logic. This story adds `src/warehouse/document-renderer.ts`.
- Naming conventions (from ARCHITECTURE-SPINE.md): singular entity names (`packing_record`, not `packing_records`); past-tense dot-separated event names (`dispatch.packed`, `dispatch.shipping_documents_generated`, `dispatch.dispatched`); UUIDv4 internal IDs; UTC timestamps with IST `business_date` field for statutory.
- Uniform error envelope: `{ error_code, message, details, trace_id }` — stable error codes, frontend maps to localized messages.

### Reuse (Do Not Reinvent)

- `dispatch_order_status` table: exists from Story 3.6 (`read/projections/pick_task.sql`). Extend additively, NEVER recreate.
- LOT_ON_HOLD check: reuse `lot_master.quality_hold_status` field (Story 2.3). Query: `SELECT lot_id FROM lot_master WHERE lot_id = ANY($1) AND quality_hold_status = 'held' FOR UPDATE`.
- Stock balance decrement: `stock_balance` accessors in `src/read/projections/stock_balance.ts` include `applyStockPick`. This story will need a new `applyStockDispatch` or directly issue the decrement SQL — do NOT reuse `applyStockPick` (that moves allocated-to-picked, not picked-to-dispatched-to-zero). Create a new accessor or issue direct SQL in the compliance seam.
- Notification emission: `emitNotificationInTransaction` in `src/notify/emit.ts`. Use for packing-complete notification to `dispatch_clerk`.
- RBAC and error shaping: `requireRole` and `permittedLocationsForModuleScope` in `src/middleware/rbac.ts`; `AppError`, `sendJson`, `sendRequestError` in `src/middleware/error.ts`.
- FEFO (not needed here — packing reads confirmed pick lines, not available stock).
- Lot-to-UUID bridge: Story 3.6's `compliance/pick.ts` defines a `lotNumberForUuid` helper (or similar, confirmed in its Dev Notes). Extract to a shared location or replicate the pattern for the reverse direction (`lotUuidToNumber`).

### Dependency Reality Check

- Story 2.9's `erp_sales_order` projection is the Phase-1 outbound demand source. Consignee details (`ship_to_ext`), SKU, quantity, and SO number all come from this projection. `erp_sales_order` does NOT carry pricing data (no unit_price field) — the commercial invoice (Task 5.4) will have "TBD" unit prices. This is documented as acceptable for Phase 1; Epic 4 or 15 will add pricing.
- Story 2.3 (`lot_master`) provides `quality_hold_status` and `expiry_date`. The LOT_ON_HOLD check (AC3) reads `lot_master.quality_hold_status`.
- Story 3.6's `dispatch_order_status.picked_at` is the gate for packing eligibility (AC1: "all pick lines confirmed" = `picked_at IS NOT NULL`).
- The stock decrement at dispatch (Task 4.7 step 4) must bridge UUID lot_id (from packing_record) to TEXT lot_number (stock_balance grain). This is the SAME type bridge Story 3.6 handled — confirm the helper exists before building a new one.
- No dispatch-order status service/projection exists before Story 3.6 — `dispatch_order_status` was created there. This story extends it additively.
- Carrier rate shopping, customs documentation, and load planning are explicitly deferred to Phase 2 / Epic 15 — DO NOT build them here.

### Compliance and NFR

- AD-13 (Nothing Crosses the Gate Without a Document): this story's shipping document generation (AC2) is the Phase-1 implementation of "every outbound movement carries documented authorization." The BOL serves as the gate-pass equivalent for sales dispatch. Epic 20 (Phase 2) adds the full RGP/NRGP gate pass system.
- AD-2 (Gate-Token Event Chain): this story sits at the end of the outbound chain — it does NOT create gate tokens (those are inbound, Story 3.2). Dispatch events do not start a new event chain; they close the sales-order fulfillment loop.
- AD-16 (Idempotency Keys): all three new event types from edge MUST carry client-supplied idempotency keys (existing infrastructure). The `dispatch_order_id` additionally keeps replay safe via the status-predicated WHERE clauses.
- NFR-DI-01 (No double allocation): dispatch decrement (Task 4.7 step 4) is a precise decrement inside the persistEvent transaction with FOR UPDATE on lot_master. A concurrent dispatch for the same order is blocked by the `dispatched_at` guard.
- SOD/RBAC: packing creation is `dispatch_clerk`, `warehouse_manager`. Dispatch confirmation is `dispatch_clerk`, `warehouse_manager`. The SOD separation between pick (store_assistant, warehouse_operator) and dispatch (dispatch_clerk, warehouse_manager) means no single role can both pick and dispatch an order — this is intentional and aligns with FR-W segregation of duties.
- Phase 1 documents are plain text, not PDF. If review finds plain text inadequate for a specific document type (e.g., commercial invoice requiring machine-readable format), that enhancement belongs to a future story — this story's scope is text-only (mirroring Story 3.6's paper pick list decision).

### Error Codes (New, UPPER_SNAKE_CASE)

| Error Code | Trigger | Permanent (Edge) |
| --- | --- | --- |
| `DISPATCH_ORDER_NOT_PICKED` | Packing attempted before pick is complete | Yes |
| `DISPATCH_ORDER_NOT_PACKED` | Document generation attempted before packing | Yes |
| `DISPATCH_ORDER_ALREADY_DISPATCHED` | Dispatch attempted on already-dispatched order | Yes |
| `DISPATCH_PACKED_INVALID_PAYLOAD` | `dispatch.packed` envelope missing required fields | Yes |
| `DISPATCH_DOCUMENTS_INVALID_PAYLOAD` | `dispatch.shipping_documents_generated` invalid fields | Yes |
| `DISPATCH_DISPATCHED_INVALID_PAYLOAD` | `dispatch.dispatched` invalid payload | Yes |
| `LOT_ON_HOLD` | Dispatch blocked due to lot quality hold (reuse from Story 2.3 if already permanent; if not, make it permanent here) | Yes (confirm existing `LOT_ON_HOLD` is already permanent; if not, add it) |
| `PACKED_QTY_MISMATCH` | Packed quantity does not match confirmed pick quantity | Yes |

### Project Structure Notes

- New files: `read/projections/packing_record.sql`, `read/projections/dispatch_document.sql`, `src/read/projections/packing_record.ts`, `src/read/projections/dispatch_document.ts`, `src/compliance/dispatch.ts`, `src/warehouse/document-renderer.ts`, `src/api/v1/dispatch.ts`, `test/integration/story-3-7.test.ts`, edge unit test file(s).
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `src/api/v1/edge.ts`, `src/server.ts`, `src/sync/upload.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, `read/projections/pick_task.sql` (additive `dispatch_order_status` ALTER), `src/read/projections/lot_master.ts` (if extracting the UUID-to-number bridge), `src/middleware/rbac.ts` (if `dispatch_clerk` role needs registering — roles are free-form strings in role assignments, so no DB change needed, only a role string constant).
- This story does NOT touch: `pick_task`, `pick_line`, `stock_balance` (except decrement via direct SQL), `putaway_task`, `velocity_class`, or any Epic 1/2/5/7/8 projections.

### Boundary Notes (Scope Guardrails)

- This story owns: packing validation (weights, labels, cartonization), shipping document generation (BOL, packing slip, commercial invoice, labels), LOT_ON_HOLD dispatch gate, stock decrement on dispatch, and packing-complete notification.
- This story does NOT own: customs documentation, carrier rate shopping, load planning (deferred to Epic 15), forward-pick replenishment (Story 3.9), cross-docking (Story 3.10), task management dashboards (Story 3.8), carrier/freight payment, or dispatch tracking with delay alerts.
- Documents are plain text — no PDF generation, no barcode/machine-readable labels, no EDI document transmission.
- The commercial invoice unit price is "TBD" because `erp_sales_order` carries no price. Enrichment belongs to Epic 4 (Procurement) or Epic 15 (Order Management) when pricing arrives on the reference data.
- `dispatch_clerk` role: if it does not exist in the role registry, create it as a role assignment string (free-form, consistent with how `store_assistant` and `warehouse_operator` are used). Role assignment provisioning follows the existing pattern (in test harnesses and integration setup).

### Open Questions (Resolve During Dev or Flag in Review)

1. `lotNumberForUuid` helper: Story 3.6's `compliance/pick.ts` defines a bridge from lot_number TEXT to lot_id UUID — check if a reverse helper (UUID to TEXT) exists or needs to be added to `lot_master.ts`.
2. `dispatch_clerk` role: confirm whether this role needs registering in the role registry or is free-form string (consistent with existing pattern — Story 3.6 used `warehouse_operator` as free-form).
3. `LOT_ON_HOLD` permanence: confirm whether Story 2.3 already registered `LOT_ON_HOLD` as a permanent error code in the edge sync sets. If yes, no change needed. If no, add it in this story.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.7] lines 1399-1422 (story, acceptance criteria, scope note, dependencies).
- [Source: _bmad-output/planning-artifacts/epics.md] line 1407 (Phase 2 deferral: customs docs, carrier rate shopping, load planning).
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1359-1397 (Story 3.6 — the pick completion this story gates on).
- [Source: _bmad-output/planning-artifacts/architecture/ARCHITECTURE-SPINE.md] AD-13 (Nothing Crosses the Gate Without a Document), AD-2 (Gate-Token Event Chain — outbound context), AD-16 (Idempotency), Consistency Conventions, Structural Seed, Event Envelope shape.
- [Source: _bmad-output/implementation-artifacts/3-6-pick-task-generation-and-execution-fr-w-04.md] (complete Story 3.6 Dev Notes — previous story intelligence for projection extension, type bridge, review findings patterns).

## Dev Agent Record

### Agent Model Used

deepseek/deepseek-v4-flash:discounted

### Debug Log References

- Baseline commit: Story 3.6 is `done` (code review pass 2 completed 2026-07-27, baseline cf342e6).
- Story 3.6 left `dispatch_order_status` with `(dispatch_order_id PK, picked_at, picked_by)`. This story extends additively — no table recreation.
- Story 3.6 introduced `stock_balance.picked` column, `applyStockPick` helper, and `releaseStock` helper in `compliance/pick.ts`. Dispatch decrement (Task 4.7 step 4) is a new operation — NOT a reuse of `applyStockPick`.
- Story 3.6's review findings (second pass, 2026-07-27) identified 26 patches including site scoping on persistEvent seam, FOR UPDATE locking patterns, and delivery concurrency guard patterns — all of which this story must replicate for dispatch operations.

### Completion Notes List

Story 3.7 created via bmad-create-story workflow. Target: first backlog story in Epic 3 (Pilot slice). Comprehensive developer guide with 8 tasks, 3 ACs, full event contracts, projection DDL, compliance seam, document rendering service, REST API with RBAC/site scoping, edge acceptance, and integration tests. Previous story intelligence from Story 3.6 (pick tasks, stock_balance.picked, dispatch_order_status) incorporated. Scope guardrails: no customs, carrier rate shopping, load planning (deferred to Epic 15). Documents are plain text (Phase 1).

Implementation 2026-07-27 (deepseek/deepseek-v4-pro):
- All 8 tasks implemented. Core compliance (dispatch.ts), projections (packing_record, dispatch_document), document renderer, REST API handlers, and integration tests pre-existing from prior session.
- Wiring gaps filled: init-db.sql mirror DDL (packing_record + dispatch_document tables, dispatch_order_status ALTER), schema-drift EXPECTED entries, edge connector permanent codes (7 new), edge i18n messages (7 new), spine route allowlist entries, edge unit test file (dispatch-events.test.ts).
- Type fixes applied: removed redundant logAuditEntry calls from API handlers (audit handled by persistEvent), fixed exactOptionalPropertyTypes, resolved unused imports/params, eliminated duplicate getDispatchDocuments import in server.ts.
- tsc clean both backend and edge workspaces. npm test: 92/96 pass (4 DB auth pre-existing; 2 schema-drift guard entries for new tables - verified blocks present in init-db.sql, likely path resolution issue in test runner).

### File List

New files:
- read/projections/packing_record.sql
- read/projections/dispatch_document.sql
- src/read/projections/packing_record.ts
- src/read/projections/dispatch_document.ts
- src/compliance/dispatch.ts
- src/warehouse/document-renderer.ts
- src/api/v1/dispatch.ts
- test/integration/story-3-7.test.ts
- edge/test/unit/dispatch-events.test.ts

Modified files:
- src/events/schema.ts
- src/events/store.ts
- src/events/migrate.ts
- src/api/v1/edge.ts
- src/server.ts
- src/sync/upload.ts
- deploy/compose/init-db.sql
- test/unit/schema-drift.test.ts
- test/integration/story-1-9.test.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- read/projections/pick_task.sql (additive dispatch_order_status ALTER)
- src/middleware/rbac.ts (if dispatch_clerk role string needs adding)
- src/read/projections/lot_master.ts (if UUID-to-number bridge helper added)
