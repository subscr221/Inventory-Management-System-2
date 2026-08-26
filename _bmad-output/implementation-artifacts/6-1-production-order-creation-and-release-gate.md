---
baseline_commit: e93014f224de6e8b3e717fb599dba7f9d0761d15
---

# Story 6.1: Production Order Creation and Release Gate

Status: done

<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-26. Comprehensive developer guide created from epics.md (Epic 6 at line 1953, Story 6.1 at line 1957, FR-MO-01/02/03 at lines 111-113, the Epic 8 hard-prerequisite note at line 413, the Story 5.5 explosion-service handoff at line 1904), ARCHITECTURE-SPINE.md (AD-3, AD-5, AD-12, AD-14, AD-16, AD-17, the Capability map row for Production Orders), the sprint-change-proposal-2026-07-11 Epic 6 edits (D3 Epic 8 dependency, FR-B-08 reassignment, the RD_EXECUTION_BARRED rewording at line 2402, the explosion-service contract at line 2539), the Epic 5 BOM tree (src/engineering/bom-explosion.ts, src/compliance/bom.ts, read/projections/bom*.sql), the Epic 2 stock ledger (src/read/projections/stock_balance.ts, read/projections/stock_balance.sql), the Story 1.4 DOA resolver, the Story 1.5 tagging seam, and a baseline code audit at e93014f. This is the FIRST story of Epic 6 and the first code in the production module: it introduces the production stream, the production_order projection, the immutable order number, the lifecycle state machine, and the release gate. The release gate does NOT re-implement the BOM walk - it calls the exported Story 5.5 service explodeBomForExecution, which already owns released-BOM, released-revision, R&D-bar and date-effectivity enforcement. -->

## Story

As a production planner,
I want to create production orders with immutable numbers and a release gate that verifies an effective Released BOM and material availability,
so that orders only start when they can actually be built.

## Acceptance Criteria

1. **Given** a demand for a finished good, **When** a production order is created with output item, quantity, plant, BOM version, business-stream tag, and source reference (FR-MO-01), **Then** an immutable order number is assigned and the order enters `Planned` state; an untagged order is rejected with `error_code: "UNTAGGED_TRANSACTION"`.
2. **Given** a production order in any lifecycle state, **When** a state transition is requested (FR-MO-02), **Then** only valid transitions are accepted - `Planned` to `Released`, `Released` to `In Process`, `In Process` to `Completed`, `Completed` to `Closed`, and `Planned` or `Released` to `Cancelled`; any other transition is rejected with `error_code: "INVALID_STATE_TRANSITION"`, and each accepted transition is attributed in the edit log (FR-AC-13).
3. **Given** an order in `In Process`, `Completed`, or `Closed` state, **When** cancellation is attempted (FR-MO-02), **Then** it is rejected with `error_code: "INVALID_STATE_TRANSITION"` - `Cancelled` is reachable only from `Planned` or `Released`.
4. **Given** a `Released` order with unreversed material transactions, **When** cancellation is attempted (FR-MO-02), **Then** it is rejected with `error_code: "UNREVERSED_TRANSACTIONS"` until every issue against the order is returned or reversed.
5. **Given** a Planned order is submitted for release, **When** the release gate runs (FR-MO-03), **Then** release succeeds only when an effective Released BOM exists and material availability - unallocated on-hand stock at the order's plant - covers every component line; insufficient availability returns `error_code: "INSUFFICIENT_STOCK"`.
6. **Given** a named authority overrides the release gate despite an availability shortfall, **When** the override is applied, **Then** the order is released and flagged as expediting, with the override recorded to the edit log.
7. **Given** a user who is not a named authority in the DOA registry (FR-DOA-01), **When** they attempt a release-gate override, **Then** the override is rejected with `error_code: "APPROVAL_REQUIRED"` and the attempt is written to the edit log.

**Note:** Material staging, issue, backflush and the WIP ledger are Story 6.2; completions and QC hand-off are Story 6.3; lot genealogy, the closure gate and offline execution are Story 6.4. The Epic 8 QC-disposition hard prerequisite binds the Story 6.4 closure gate only, not this story. This story creates no stock movement and no allocation: the release gate VERIFIES availability, it does not reserve it.

## Tasks / Subtasks

- [x] Task 1: Database schema for the production order projection (AC: 1, 2, 3, 4, 5, 6)
  - [x] 1.1 Create `read/projections/production_order.sql` following the exact shape of `read/projections/indent.sql`: canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks, `CREATE INDEX IF NOT EXISTS`, `CREATE SEQUENCE IF NOT EXISTS`, guarded `pg_roles` grants block that also grants `USAGE` on the sequence.
  - [x] 1.2 Columns: `production_order_id UUID PRIMARY KEY`, `order_number_ext TEXT NOT NULL`, `output_item_id UUID NOT NULL`, `output_sku TEXT NOT NULL`, `order_quantity NUMERIC(18,6) NOT NULL`, `order_uom TEXT NOT NULL`, `plant_location_id UUID NOT NULL`, `bom_id UUID NOT NULL`, `released_revision_id UUID`, `business_stream TEXT NOT NULL`, `source_reference_type TEXT NOT NULL`, `source_reference_id TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'planned'`, `expediting_flag BOOLEAN NOT NULL DEFAULT false`, `override_by UUID`, `override_reason TEXT`, `released_at TIMESTAMPTZ`, `released_by UUID`, `cancelled_at TIMESTAMPTZ`, `cancelled_by UUID`, `unreversed_transaction_count INTEGER NOT NULL DEFAULT 0`, `created_by UUID NOT NULL`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - [x] 1.3 Constraints: `chk_production_order_status CHECK (status IN ('planned','released','in_process','completed','closed','cancelled'))`, `chk_production_order_quantity_positive CHECK (order_quantity > 0)`, `chk_production_order_source_reference_type CHECK (source_reference_type IN ('erp_sales_order','indent','rd_project','manual'))`, `chk_production_order_unreversed_non_negative CHECK (unreversed_transaction_count >= 0)`, `chk_production_order_expediting_pairing CHECK ((expediting_flag = true AND override_by IS NOT NULL AND override_reason IS NOT NULL AND btrim(override_reason) <> '') OR (expediting_flag = false AND override_by IS NULL AND override_reason IS NULL))`.
  - [x] 1.4 Indexes: `uq_production_order_number_ext UNIQUE (order_number_ext)`, `idx_production_order_status (status)`, `idx_production_order_plant (plant_location_id)`, `idx_production_order_output_item (output_item_id)`, `idx_production_order_bom (bom_id)`, `idx_production_order_business_stream (business_stream)`.
  - [x] 1.5 Create `CREATE SEQUENCE IF NOT EXISTS production_order_number_seq;` in the same file, mirroring `indent_number_seq` in `read/projections/indent.sql` including the `GRANT USAGE ON SEQUENCE ... TO app_user` guarded block.
  - [x] 1.6 Mirror the new file verbatim into `deploy/compose/init-db.sql`, appended at the tail after the Story 7.6 block. `deploy/compose/init-db.sql` is a CRLF file; normalize the appended block to CRLF so the file does not carry mixed line endings.
  - [x] 1.7 Register `read/projections/production_order.sql` in the `MIGRATIONS` tail of `src/events/migrate.ts`, appended after the Story 7.6 block.
  - [x] 1.8 Add the table plus every named constraint, index, sequence and grant to `EXPECTED` in `test/unit/schema-drift.test.ts`.
  - [x] 1.9 Verify `npm run db:migrate` twice is idempotent.
- [x] Task 2: Event contracts (AC: 1, 2, 3, 4, 5, 6)
  - [x] 2.1 Add four payload interfaces and their envelope types to `src/events/schema.ts` in a Story 6.1 block appended after the Story 7.6 block: `ProductionOrderCreatedPayload`, `ProductionOrderReleasedPayload`, `ProductionOrderStateChangedPayload`, `ProductionOrderCancelledPayload`. Field lists are in the Event Contract, Table 1.
  - [x] 2.2 Register all four in `SUPPORTED_EVENT_TYPES` with `streamType: 'production'`. `production_order.created` is the ONLY one with `requiresBusinessStream: true` (this is what makes AC1's `UNTAGGED_TRANSACTION` fire in `persistEvent` with no handler-side check); the other three are `false`.
  - [x] 2.3 Confirm every id field is a UUID, every NUMERIC field is a decimal STRING (never a JS number), every TIMESTAMPTZ field carries an explicit UTC offset, and every server-derivable field is declared in the payload so the applier can cross-check it.
  - [x] 2.4 Do NOT add `production` to `INVENTORY_MOVEMENT_STREAM_TYPES` in `src/compliance/business-stream.ts`. The registry flag is the whole mechanism; widening the stream set would force a business_stream onto every lifecycle transition and break the AC2 transition events.
- [x] Task 3: Read projections and accessors (AC: 1, 2, 3, 4, 5, 6)
  - [x] 3.1 Create `src/read/projections/production_order.ts` with `ProductionOrderRow`, `insertProductionOrder(input, client)`, `getProductionOrderById(orderId, client?)`, `getProductionOrderByIdForUpdate(orderId, client)` (`SELECT ... FOR UPDATE`), `getProductionOrderByNumber(orderNumberExt, client?)`, `listProductionOrders(params)` filterable by `status`, `plant_location_id`, `output_item_id`, `business_stream`, paginated with a clamped `limit` and `offset`, and `updateProductionOrderState(orderId, patch, client)`. Every NUMERIC and DATE column is read as a string out of pg and never coerced to a JS number.
  - [x] 3.2 Add `allocateProductionOrderNumber(year, client)` to the same file, structurally identical to `allocateIndentNumber` in `src/read/projections/indent.ts` line 331: `SELECT nextval('production_order_number_seq')`, zero-padded to at least 4 digits, format `MO-YYYY-NNNN`. Server-side only, never client-supplied, never `MAX(...)+1`. The `MO-` prefix is deliberate: `PO-` already belongs to purchase orders (`po_number_seq`).
  - [x] 3.3 Add `getAvailableBalanceUnderSite(sku, siteLocationId, client?)` to `src/read/projections/stock_balance.ts`, structurally identical to the existing `getForwardPickBalance` recursive descendant walk (same depth cap of 10, same `stock_class = 'owned'` scoping) but summing `available`, not `on_hand`, and returning a NUMERIC string. Do not modify `getForwardPickBalance`; do not generalize the two into one helper.
  - [x] 3.4 Do NOT add a new accessor to `src/read/projections/bom.ts`. `getBomById` already returns everything the gate needs.
- [x] Task 4: Release gate service (AC: 5, 6, 7)
  - [x] 4.1 Create `src/production/release-gate.ts` exporting `evaluateReleaseGate(input, client?)`, following the shape of `src/engineering/bom-explosion.ts`: pure read-and-compute, no persistence, no event emission, no HTTP work, accepts an optional `PoolClient` so a caller can run it inside its own transaction.
  - [x] 4.2 The gate calls `explodeBomForExecution({ bom_id, quantity, occurred_at }, client)` from `src/engineering/bom-explosion.js`. It MUST NOT re-implement the walk, re-check released-BOM status, re-check released-revision status, re-apply date effectivity, or re-derive the R&D bar - the service owns all of those and already throws `BOM_NOT_FOUND` 404, `RD_EXECUTION_BARRED` 409, `BOM_NOT_RELEASED` 409, `EXPLOSION_QUANTITY_INVALID` 400 and `BOM_EXPLOSION_CYCLE_DETECTED` 409. The gate surfaces those codes unchanged.
  - [x] 4.3 Before exploding, the gate asserts the order's declared `bom_id` resolves via `getBomById` and its `parent_item_id` equals the order's `output_item_id`; a mismatch rejects `BOM_ITEM_MISMATCH` 409.
  - [x] 4.4 For every requirement row returned by the explosion (BOTH `directed_issue` and `backflush` supply methods count, because AC5 says every component line), resolve availability with `getAvailableBalanceUnderSite(requirement.component_sku, order.plant_location_id, client)` and compare in SQL NUMERIC, never in JS. A requirement whose `component_sku` is null rejects `COMPONENT_SKU_UNRESOLVED` 409 (fail closed; placeholders are already barred from production BOMs by `src/compliance/bom.ts`).
  - [x] 4.5 Return `{ revision_id, business_date, depth_truncated, satisfied, lines }` where each line carries `component_item_id`, `component_sku`, `required_quantity`, `available_quantity`, `shortfall_quantity`, `satisfied`. The service NEVER throws `INSUFFICIENT_STOCK`; it reports `satisfied: false` plus per-line shortfalls and the caller decides. This is what lets the dry-run read route and the override path reuse one code path.
  - [x] 4.6 The gate takes NO `FOR UPDATE` lock on any `stock_balance` row and performs no allocation. Availability is advisory at release; hard enforcement under lock is Story 6.2's staging and issue path. Say so in the module header comment so a later reviewer does not read the absence of a lock as a defect.
  - [x] 4.7 An explosion that returns zero requirement lines returns `satisfied: false` with a distinct `empty_requirement_set: true` detail, never a trivially satisfied verdict (the Story 5.6 empty-rollup decision applied here).
- [x] Task 5: Compliance seam (AC: 1, 2, 3, 4, 5, 6)
  - [x] 5.1 Create `src/compliance/production-order.ts` structurally identical to `src/compliance/calibration-register.ts`: stream gate (`stream_type === 'production'`), pure `assertProductionOrderShape(envelope)`, `applyProductionOrderProjection(envelope, client, eventId)` switch, `alreadyPersisted` guard, `reject()` helper.
  - [x] 5.2 `assertProductionOrderShape` is non-DB and validates: UUID shapes, `order_quantity` against `^\d{1,12}(\.\d{1,6})?$` and strictly positive, `source_reference_type` against the enum, `source_reference_id` non-empty (`SOURCE_REFERENCE_REQUIRED` 400), `status` and `new_status` against the state vocabulary, `override_reason` non-empty whenever `expediting_flag` is true (`OVERRIDE_REASON_REQUIRED` 400).
  - [x] 5.3 `applyProductionOrderProjection` handles all four event types. Every applier re-derives what it can from locked rows and rejects a payload that disagrees with `PRODUCTION_ORDER_DERIVATION_MISMATCH` 409, per the Story 7.2 Group 2 decision and the Story 7.3 and 7.6 precedent. The fields that MUST be re-derived and checked are named in the Event Contract.
  - [x] 5.4 The `production_order.created` applier resolves `output_item_id` via `getItemById` (404 `ITEM_NOT_FOUND`, 409 `OUTPUT_ITEM_NOT_ACTIVE` when `isReleasedItemMaster` is false), resolves `plant_location_id` via `getLocationById` (404 `PLANT_NOT_FOUND`, 400 `INVALID_PLANT` when the row is not `level = 'site'` or not `status = 'active'`), and inserts the row with `status = 'planned'`.
  - [x] 5.5 The `production_order.created` applier NEVER trusts a client-supplied `order_number_ext`. It allocates the number itself via `allocateProductionOrderNumber` and writes the allocated value back onto the persisted payload. A payload that declares a different `order_number_ext` rejects `ORDER_NUMBER_IMMUTABLE` 409; the same code guards every later applier against a payload that tries to change the number of an existing order.
  - [x] 5.6 The `production_order.released`, `production_order.state_changed` and `production_order.cancelled` appliers all validate the transition against the state machine in Table 2 under `FOR UPDATE`, rejecting `INVALID_STATE_TRANSITION` 400. No applier silently no-ops on a state it should reject.
  - [x] 5.7 The `production_order.cancelled` applier reads `unreversed_transaction_count` under the same lock and rejects `UNREVERSED_TRANSACTIONS` 409 when it is greater than zero, before the transition passes into a write.
  - [x] 5.8 The `production_order.released` applier re-runs `evaluateReleaseGate` on the transaction client. If `satisfied` is false and `expediting_flag` is not true, it rejects `INSUFFICIENT_STOCK` 409. If `expediting_flag` is true it re-resolves the DOA approver and rejects `APPROVAL_REQUIRED` 403 unless the declared `override_by` equals the resolved approver. This is what closes the direct `POST /api/v1/events` bypass: the handler check alone is not enough (AD-12).
  - [x] 5.9 Wire `assertProductionOrderShape` into the pre-transaction assert block and `applyProductionOrderProjection` into the in-transaction applier block of `src/events/store.ts`, appended after the Story 7.6 seams, and add a duplicate resolver to the 23505 mapper for `uq_production_order_number_ext` yielding `DUPLICATE_PRODUCTION_ORDER_NUMBER` 409.
- [x] Task 6: REST surface (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 6.1 Create `src/api/v1/production-orders.ts` with the seven handlers in the API Contract, Table 4. Reuse `requireRole({ module: 'production', functionScope: ... })`, `getParsedBody`, `sendJson`, `sendAppError`, and copy the local `actorContext`, `auditCtxFor`, `idempotencyKeyFrom`, `replayIdOrReject` and `requireUuidParam` helper shapes from `src/api/v1/maintenance.ts` rather than importing them across modules.
  - [x] 6.2 The release handler resolves the override authority via `resolveApprover('production_order.release_override', 0)` imported from `src/api/v1/indents.js` (the single DOA resolver, AD-3), exactly as `src/api/v1/maintenance.ts` does for `maintenance.return_to_service`. No hard-coded role list anywhere.
  - [x] 6.3 AC7: when an override is attempted by a user who is not the resolved approver, the handler writes an explicit edit-log row before throwing, using `logAuditEntry` on a dedicated pool client with `http_status: 403`, `error_code: 'APPROVAL_REQUIRED'`, `event_id: null`, and `details` naming the order id and the resolved approver. Follow the `src/api/v1/gate.ts` line 233 precedent for acquiring and releasing that client. A rejected attempt never reaches `persistEvent`, so `persistEvent`'s own audit write cannot cover it.
  - [x] 6.4 Every 201 and 200 body is read back BY ID from the persisted payload's own `production_order_id`, never by re-querying the newest row and never by grain (the Story 7.4 review Medium finding).
  - [x] 6.5 Every write route carries an `idempotency_key`; a blank or non-string key falls back to `randomUUID()`; a cross-event-type reuse returns 409 `DUPLICATE_EVENT`.
  - [x] 6.6 Register all seven routes in `createAppRouter` in `src/server.ts`, static segments before parameter segments, and confirm no collision with the existing `/api/v1/purchase-orders` block.
  - [x] 6.7 Add all seven routes to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
  - [x] 6.8 Do NOT add anything to `edge/src/messages/en.json` or `edge/src/sync/connector.ts`. Production-order routes are central-only in this story; no production event has an edge upload path until Story 6.4.
- [x] Task 7: DOA seeding and role provisioning (AC: 6, 7)
  - [x] 7.1 The integration harness provisions a `production_planner` role assignment for module `production` with `write` scope, and a second user holding the role the DOA registry names as the approver for `production_order.release_override`. `production_planner` already exists as a notification target role (Story 7.6); reuse the exact string.
  - [x] 7.2 Seed the DOA registry entry for transaction type `production_order.release_override` through the existing `POST /api/v1/doa/entries` route in the harness setup, never by direct SQL insert, so the seeding path is the one production uses.
- [x] Task 8: Tests (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 8.1 Create `test/integration/story-6-1.test.ts` bootstrapped exactly as `test/integration/story-5-6.test.ts`.
  - [x] 8.2 One failing-first test per acceptance criterion, plus one test per error code in the Error Code Contract, Table 5.
  - [x] 8.3 AC1: creation assigns an `MO-YYYY-NNNN` number and lands in `planned`; a second creation gets the NEXT number; a client-supplied `order_number_ext` is ignored on the handler path and rejected `ORDER_NUMBER_IMMUTABLE` on the direct `POST /api/v1/events` path; an untagged create is rejected `UNTAGGED_TRANSACTION` on BOTH the handler path and the direct-event path.
  - [x] 8.4 AC2: a full walk of the legal path `planned`, `released`, `in_process`, `completed`, `closed`, asserting an `audit_log` row exists for every accepted transition; then an exhaustive rejection table asserting every illegal pair returns 400 `INVALID_STATE_TRANSITION`.
  - [x] 8.5 AC3: cancel from `in_process`, `completed` and `closed` each return 400 `INVALID_STATE_TRANSITION`; cancel from `planned` and from `released` succeed.
  - [x] 8.6 AC4: seed `unreversed_transaction_count` to 1 with a direct `UPDATE` through `getPool()` in the test (Story 6.2 owns the writer, and the test says so in a comment), then assert cancel returns 409 `UNREVERSED_TRANSACTIONS` and the order is still `released`; set it back to 0 and assert cancel then succeeds.
  - [x] 8.7 AC5: build a released BOM with two component lines through the existing Story 5.1 and 5.2 routes, receive stock for one line only at a bin under the plant site, and assert release returns 409 `INSUFFICIENT_STOCK` with per-line shortfall detail; receive the missing line and assert release succeeds and `released_revision_id` is populated from the explosion result. Include one nested-BOM case so the reuse of `explodeBomForExecution` is actually exercised, and one case where stock sits in a bin two levels below the plant site so the descendant walk is exercised.
  - [x] 8.8 AC5 delegation negatives: an R&D draft BOM returns 409 `RD_EXECUTION_BARRED`, a draft BOM returns 409 `BOM_NOT_RELEASED`, and a BOM whose `parent_item_id` differs from the order's output item returns 409 `BOM_ITEM_MISMATCH`. These prove the gate delegates rather than re-deriving.
  - [x] 8.9 AC6: an override by the resolved DOA approver despite a shortfall releases the order, sets `expediting_flag` true, records `override_by` and `override_reason`, and writes an `audit_log` row.
  - [x] 8.10 AC7: an override by a non-approver returns 403 `APPROVAL_REQUIRED`, the order stays `planned`, NO `production_order.released` event is written, and an `audit_log` row exists with `error_code = 'APPROVAL_REQUIRED'` and `http_status = 403`.
  - [x] 8.11 Bypass tests: a forged `production_order.released` posted directly to `POST /api/v1/events` with `expediting_flag: true` and a fabricated `override_by` is rejected 403 `APPROVAL_REQUIRED`; a forged one with a shortfall and no override is rejected 409 `INSUFFICIENT_STOCK`; a forged `production_order.state_changed` carrying an illegal transition is rejected 400 `INVALID_STATE_TRANSITION`. Each case also asserts no projection row changed.
  - [x] 8.12 A replay test per write route asserting the same resource returns and the `domain_events` count does not grow.
  - [x] 8.13 A concurrency test on `uq_production_order_number_ext` asserting two parallel creations both succeed with distinct numbers (the sequence, not a `MAX(...)+1`, is what makes this pass), and a concurrency test on two parallel releases of the same order resolving to one success and one stable 400 `INVALID_STATE_TRANSITION`.
  - [x] 8.14 Regression: Stories 5.1 to 5.6 and 7.1 to 7.6 suites pass unchanged; the Story 1.9 spine suite passes with the seven new routes allowlisted; `test/unit/schema-drift.test.ts` passes with the new table registered. Do not weaken, skip or delete an existing test to make a new one pass.
- [x] Task 9: Ledger entries (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 9.1 Log the out-of-scope items named in Binding Scope Decisions item 10 to `_bmad-output/implementation-artifacts/deferred-work.md` under a Story 6.1 heading.

## Dev Notes

### Binding Scope Decisions

1. **The release gate calls the Story 5.5 explosion service; it never re-implements the walk.** `src/engineering/bom-explosion.ts` line 15 declares itself the exported integration surface for exactly this caller, and `src/compliance/bom.ts` line 127 says the same about `assertNotRdDraft`. `explodeBomForExecution` already enforces BOM existence, the R&D execution bar, released-BOM status, released-revision status, date effectivity against an IST business date, the depth cap, cycle detection and the NUMERIC quantity contract. The gate adds exactly two things: the output-item-to-BOM identity check, and the per-line availability comparison. Any re-derivation of a check the service already owns is a defect, not a safety net.
2. **The production stream is new; `production_order.created` is the only tagged event.** All four events ride `stream_type: 'production'`. Only `production_order.created` carries `requiresBusinessStream: true`, which is what makes AC1's `UNTAGGED_TRANSACTION` fire inside `persistEvent` with zero handler-side code, exactly the `indent.raised` precedent at `src/events/schema.ts` line 2964. The lifecycle transitions do not re-carry a business stream: the order row already holds it, and re-tagging every transition would make the tag a mutable field, which AD-14 forbids.
3. **The order number is server-allocated from a PostgreSQL sequence and immutable thereafter.** `allocateProductionOrderNumber` mirrors `allocateIndentNumber` (`src/read/projections/indent.ts` line 331). The format is `MO-YYYY-NNNN`; the `MO-` prefix avoids the `PO-` namespace already owned by purchase orders. The applier allocates the number and writes it back onto the persisted payload; a client-declared number that disagrees rejects `ORDER_NUMBER_IMMUTABLE` 409. Never `MAX(...)+1`: that is the race the sequence exists to prevent.
4. **Availability means unallocated owned stock at or below the order's plant, summed in SQL NUMERIC.** `available` is the `stock_balance` generated column `on_hand - allocated - picked`, so unallocated is already the right column and must not be recomputed. The plant is a `location_register` row at `level = 'site'`; component stock lives in bins beneath it, so the sum walks descendants exactly as `getForwardPickBalance` does. Scope is `stock_class = 'owned'`: consignment and VMI stock is not the platform's to consume (Story 2.8).
5. **The release gate takes no stock lock and reserves nothing.** The epic wording is deliberate: the release gate verifies availability, staging allocates it (Story 6.2, FR-MO-04). A caller that reads `satisfied: true` and releases has a true statement about the moment of release, not a reservation. Do not add a `FOR UPDATE` over `stock_balance` and do not emit `stock.allocated` from this story. Record the window in the module header so a reviewer reads it as designed, not missed.
6. **The override is DOA-resolved, and the seam re-checks it.** `resolveApprover('production_order.release_override', 0)` is the single authority resolver (AD-3). The value argument is `0` because a release carries no monetary band, matching the `maintenance.return_to_service` precedent in `src/api/v1/maintenance.ts`. The handler check alone would leave `POST /api/v1/events` open, so `applyProductionOrderProjection` re-resolves the approver under the transaction and rejects a payload whose `override_by` is not the resolved approver. AD-12 makes this mandatory, not optional.
7. **`unreversed_transaction_count` is this story's contract surface for AC4.** Story 6.2 owns incrementing it on issue and decrementing it on return or reversal. Story 6.1 owns the column, the constraint, and the cancel guard that reads it under the same `FOR UPDATE` lock as the transition check. The AC4 test seeds the counter with a direct `UPDATE` through `getPool()` because no writer exists yet, and the test says so in a comment. Do NOT invent a material-transaction table, a WIP ledger, or an issue event in this story: those are Story 6.2, and building them here would fork the design before 6.2 chooses it.
8. **State is a projection column, transitions are events.** `production_order.status` is derived state written only by the appliers inside the event transaction (AD-14). There is no mutable-status update path outside `applyProductionOrderProjection`. Every accepted transition produces an event and therefore an edit-log row through `persistEvent` (FR-AC-13, AC2).
9. **No notification, no PowerSync bucket, no ERP outbound in this story.** No acceptance criterion asks for any of them. Story 6.4 owns offline replication of order data (FR-MO-13). Adding a notification because status changes usually notify is scope creep of exactly the kind the Story 7.6 rescope removed.
10. **Out of scope, log each to `deferred-work.md`:** material staging, issue, backflush and the production WIP ledger (Story 6.2, FR-MO-04 to FR-MO-06); completions, co-products, by-products, scrap declarations and completion tolerances (Story 6.3, FR-MO-07 to FR-MO-10); lot genealogy, the closure gate, closed-order immutability, offline execution and the central-only enforcement of release, cancel and close (Story 6.4, FR-MO-11 to FR-MO-13); the consumption variance report (Story 6.4, FR-B-08); existence resolution of `source_reference_id` against the Story 2.9 `erp_sales_order` and Story 4.3 `indent` projections (Phase 1 records the reference, it does not resolve it); rework orders raised from QC dispositions (Story 6.3, FR-MO-10, blocked on Epic 8); and kit-assembly order naming (sprint-change-proposal FR-I-09 scope note, Stories 6.1 to 6.3 collectively).

### Event Contract

Table 1 lists the four new events. All four are on the `production` stream. Only the first carries `requiresBusinessStream: true`.

| **Event type** | **stream_id** | **Key payload fields** | **Server-derived fields the applier re-checks** | **Projection effect** |
| --- | --- | --- | --- | --- |
| `production_order.created` | `production_order_id` | `production_order_id`, `order_number_ext`, `output_item_id`, `output_sku`, `order_quantity`, `order_uom`, `plant_location_id`, `bom_id`, `business_stream`, `source_reference_type`, `source_reference_id`, `created_by`, `created_at` | `order_number_ext` (allocated from the sequence), `output_sku` and `order_uom` (from `item_master`) | Inserts one `production_order` row with `status = 'planned'` |
| `production_order.released` | `production_order_id` | `production_order_id`, `released_revision_id`, `business_date`, `expediting_flag`, `override_by`, `override_reason`, `released_by`, `released_at` | `released_revision_id` (from the explosion result), the gate `satisfied` verdict, `override_by` (from `resolveApprover`) | Sets `status = 'released'`, `released_revision_id`, `released_at`, `released_by`, and the expediting triple when overridden |
| `production_order.state_changed` | `production_order_id` | `production_order_id`, `previous_status`, `new_status`, `changed_by`, `changed_at` | `previous_status` (from the locked row) | Sets `status = new_status` |
| `production_order.cancelled` | `production_order_id` | `production_order_id`, `previous_status`, `cancelled_by`, `cancelled_at`, `reason_code` | `previous_status` and `unreversed_transaction_count` (from the locked row) | Sets `status = 'cancelled'`, `cancelled_at`, `cancelled_by` |

Every payload field an applier can derive from a locked row is DECLARED in the payload and CHECKED against the derivation, never trusted. Divergence rejects `PRODUCTION_ORDER_DERIVATION_MISMATCH` 409, except for the order number, which has its own `ORDER_NUMBER_IMMUTABLE` 409. This is the Story 7.2 Group 2 decision and the Story 7.3 and 7.6 pattern applied unchanged: a declared-but-unchecked field is a silent corruption channel on the direct `POST /api/v1/events` path.

`production_order.released` is the highest-risk applier in this story. A forged release with `expediting_flag: true` and a fabricated `override_by` would defeat AC6 and AC7 in one move; a forged release with no override on a short order would defeat AC5. Both paths must be re-derived inside the transaction, not merely checked in the handler.

### Lifecycle Contract

Table 2 defines the complete production order state machine. Any pair not listed is rejected `INVALID_STATE_TRANSITION` 400. No applier silently no-ops on a state it should reject.

| **From state** | **Command** | **To state** | **Extra precondition** |
| --- | --- | --- | --- |
| (none) | create | `planned` | Output item active, plant is an active site, business stream tagged |
| `planned` | release | `released` | Release gate satisfied, or DOA-resolved override |
| `released` | start | `in_process` | None |
| `in_process` | complete | `completed` | None |
| `completed` | close | `closed` | None |
| `planned` | cancel | `cancelled` | None |
| `released` | cancel | `cancelled` | `unreversed_transaction_count = 0` |
| `in_process`, `completed`, `closed` | cancel | rejected | `INVALID_STATE_TRANSITION` 400 (AC3) |
| `cancelled`, `closed` | any | rejected | Terminal states |

The `planned` to `released` edge is the only one carrying a gate. The `released` to `cancelled` edge is the only one carrying the unreversed-transaction guard. Every other edge is a pure transition plus its edit-log attribution.

### Release Gate Contract

Table 3 defines the ordered guard sequence for `evaluateReleaseGate`. The order is fail-closed and significant: identity before status, status before quantity, quantity before availability, so an invalid input never reaches the recursive walk.

| **Step** | **Check** | **Owner** | **Rejection** |
| --- | --- | --- | --- |
| 1 | Order exists and is `planned` | seam and handler | `PRODUCTION_ORDER_NOT_FOUND` 404, `INVALID_STATE_TRANSITION` 400 |
| 2 | BOM exists | `explodeBomForExecution` | `BOM_NOT_FOUND` 404 |
| 3 | BOM `parent_item_id` equals order `output_item_id` | this gate | `BOM_ITEM_MISMATCH` 409 |
| 4 | BOM is not an R&D draft | `assertNotRdDraft` | `RD_EXECUTION_BARRED` 409 |
| 5 | BOM and current revision are released | `explodeBomForExecution` | `BOM_NOT_RELEASED` 409 |
| 6 | Order quantity is a valid positive decimal string | `explodeBomForExecution` | `EXPLOSION_QUANTITY_INVALID` 400 |
| 7 | Walk resolves without a cycle | `explodeBomForExecution` | `BOM_EXPLOSION_CYCLE_DETECTED` 409 |
| 8 | Every requirement line has a resolvable SKU | this gate | `COMPONENT_SKU_UNRESOLVED` 409 |
| 9 | Availability covers every requirement line | this gate | `satisfied: false` returned; caller raises `INSUFFICIENT_STOCK` 409 |

Steps 2, 4, 5, 6 and 7 are delegated. The gate must not duplicate them. Step 9 never throws from inside the service; the release path throws `INSUFFICIENT_STOCK` and the dry-run read route returns the same verdict as a 200 body.

Availability per line is `SUM(available)` over every `stock_balance` row whose `location_id` is the plant site or any descendant of it, with `stock_class = 'owned'`, matched on `component_sku`. The comparison is `available >= required_quantity` evaluated in PostgreSQL NUMERIC. No value in this path is ever converted to a JS float, including the shortfall arithmetic in the response body.

`depth_truncated` from the explosion result is carried into the gate response. A truncated walk means the requirement set is incomplete, so a truncated explosion returns `satisfied: false` regardless of the per-line verdicts, and the release path raises `INSUFFICIENT_STOCK` with `depth_truncated: true` in `details` rather than releasing against a partial requirement set.

### Locking Contract

Every applier that mutates more than one row takes `SELECT ... FOR UPDATE` in this FIXED order, so two concurrent commands on the same order can never deadlock: production order row, then item master row (if applicable), then location register row (if applicable), then the BOM rows the explosion service reads. The applier must not touch any row outside this order. No `stock_balance` row is ever locked by this story (Binding Scope Decision 5).

### Database Schema Contract

The `production_order` table is the only new table. It follows the `read/projections/indent.sql` shape exactly, including the sequence and its grant. Two paired constraints carry real semantics rather than type hygiene:

- `chk_production_order_expediting_pairing` makes an expediting flag without a recorded overrider and reason structurally impossible, which is AC6 enforced by the database rather than by a code path a later story can forget.
- `chk_production_order_unreversed_non_negative` makes a decrement below zero fail loudly in Story 6.2 rather than silently unlocking a cancel that AC4 forbids.

`released_revision_id` is deliberately nullable and deliberately NOT set at creation. FR-MO-01 records the BOM version on the order as `bom_id`; the revision is pinned at release from the explosion result, so a BOM released after the order was created cannot retroactively change what a released order was gated against.

### Compliance Seam Contract

`src/compliance/production-order.ts` follows `src/compliance/calibration-register.ts` structurally: a stream gate that returns immediately for any other stream, a pure shape assert called from the pre-transaction block of `persistEvent`, an applier called from the in-transaction block, an `alreadyPersisted` guard so a replay is a projection no-op, and a local `reject()` helper. Canonicalized values (the allocated order number, a trimmed `source_reference_id`, a trimmed `override_reason`) are written back onto the payload so the direct-event path and the handler path persist byte-identical payloads.

The seam is the enforcement point, not the handler. Every rule in the Lifecycle Contract and the Release Gate Contract is enforced inside `applyProductionOrderProjection`. The handler may check the same rules first to return a cleaner error earlier, but removing a handler check must never change what is possible through `POST /api/v1/events`.

### API Contract

Table 4 lists the seven new routes. All are registered in `createAppRouter` and all seven must be added to `allowedSpineRoutes`.

| **Method and path** | **Scope** | **Behavior** |
| --- | --- | --- |
| `POST /api/v1/production-orders` | write | Creates a Planned order; 400 `UNTAGGED_TRANSACTION`, 400 `INVALID_BUSINESS_STREAM`, 404 `ITEM_NOT_FOUND`, 409 `OUTPUT_ITEM_NOT_ACTIVE`, 404 `PLANT_NOT_FOUND`, 400 `INVALID_PLANT`, 400 `INVALID_ORDER_QUANTITY`, 400 `SOURCE_REFERENCE_REQUIRED` |
| `GET /api/v1/production-orders` | read | Filterable by `status`, `plant_location_id`, `output_item_id`, `business_stream`; paginated |
| `GET /api/v1/production-orders/:orderId` | read | Order row; 404 `PRODUCTION_ORDER_NOT_FOUND` |
| `GET /api/v1/production-orders/:orderId/release-gate` | read | Dry-run gate evaluation returning the per-line verdict without releasing; same delegated error codes as the release route, but a shortfall is a 200 body with `satisfied: false`, not a 409 |
| `POST /api/v1/production-orders/:orderId/release` | write | Runs the gate and releases; 409 `INSUFFICIENT_STOCK`, 409 `BOM_ITEM_MISMATCH`, 409 `RD_EXECUTION_BARRED`, 409 `BOM_NOT_RELEASED`, 403 `APPROVAL_REQUIRED`, 404 `APPROVAL_UNRESOLVED`, 400 `OVERRIDE_REASON_REQUIRED`, 400 `INVALID_STATE_TRANSITION` |
| `POST /api/v1/production-orders/:orderId/transition` | write | Body `{ new_status }` for the `in_process`, `completed` and `closed` edges; 400 `INVALID_STATE_TRANSITION` |
| `POST /api/v1/production-orders/:orderId/cancel` | write | Cancels from `planned` or `released`; 400 `INVALID_STATE_TRANSITION`, 409 `UNREVERSED_TRANSACTIONS` |

Route ordering matters and is the most likely silent defect in Task 6.6. Register `/api/v1/production-orders` (both verbs) before any `/api/v1/production-orders/:orderId` route, and register the three sub-resource routes after the bare `/:orderId` route. Confirm no path in this block shadows the existing `/api/v1/purchase-orders` routes; the two prefixes are distinct, but a careless parameter route placed before the list route would swallow it.

The release route body is `{ override?: { reason: string } }`. Presence of `override` is what sets `expediting_flag`; its absence means a shortfall is a hard 409. An `override` with a blank or missing `reason` is 400 `OVERRIDE_REASON_REQUIRED` before any DOA resolution runs, so a non-approver cannot probe the registry with an empty body.

### Error Code Contract

Table 5 is the complete set of error codes this story introduces or reuses. Every code must appear in at least one test.

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `UNTAGGED_TRANSACTION` | 400 | Reused (Story 1.5): `production_order.created` with no `business_stream` |
| `INVALID_BUSINESS_STREAM` | 400 | Reused (Story 1.5): the tag is not an active stream |
| `ITEM_NOT_FOUND` | 404 | Reused (Story 2.1): `output_item_id` does not resolve |
| `OUTPUT_ITEM_NOT_ACTIVE` | 409 | The output item resolves but is not `active` |
| `PLANT_NOT_FOUND` | 404 | `plant_location_id` does not resolve in `location_register` |
| `INVALID_PLANT` | 400 | The location resolves but is not an active `site`-level row |
| `INVALID_ORDER_QUANTITY` | 400 | `order_quantity` is not a positive decimal string within NUMERIC(18,6) |
| `SOURCE_REFERENCE_REQUIRED` | 400 | `source_reference_type` or `source_reference_id` is missing, blank, or off-enum |
| `PRODUCTION_ORDER_NOT_FOUND` | 404 | The order id does not resolve |
| `ORDER_NUMBER_IMMUTABLE` | 409 | A payload declares an `order_number_ext` that disagrees with the allocated or stored value |
| `DUPLICATE_PRODUCTION_ORDER_NUMBER` | 409 | 23505 resolution on `uq_production_order_number_ext` |
| `INVALID_STATE_TRANSITION` | 400 | A transition not listed in Table 2 (AC2, AC3) |
| `UNREVERSED_TRANSACTIONS` | 409 | Cancel from `released` with `unreversed_transaction_count > 0` (AC4) |
| `BOM_ITEM_MISMATCH` | 409 | The BOM's `parent_item_id` is not the order's `output_item_id` |
| `BOM_NOT_FOUND` | 404 | Reused (Story 5.5): delegated from `explodeBomForExecution` |
| `BOM_NOT_RELEASED` | 409 | Reused (Story 5.5): delegated |
| `RD_EXECUTION_BARRED` | 409 | Reused (Story 5.4): delegated through `assertNotRdDraft` |
| `EXPLOSION_QUANTITY_INVALID` | 400 | Reused (Story 5.5): delegated |
| `BOM_EXPLOSION_CYCLE_DETECTED` | 409 | Reused (Story 5.5): delegated |
| `COMPONENT_SKU_UNRESOLVED` | 409 | A requirement line carries a null `component_sku` |
| `INSUFFICIENT_STOCK` | 409 | Availability does not cover every requirement line and no override was applied (AC5) |
| `OVERRIDE_REASON_REQUIRED` | 400 | An override is requested with a blank or missing reason |
| `APPROVAL_REQUIRED` | 403 | Reused: an override attempted by a user who is not the resolved DOA approver (AC7) |
| `APPROVAL_UNRESOLVED` | 404 | Reused: no DOA entry governs `production_order.release_override` |
| `PRODUCTION_ORDER_DERIVATION_MISMATCH` | 409 | A declared payload field disagrees with the value derived from locked rows |
| `DUPLICATE_EVENT` | 409 | Reused: cross-event-type idempotency-key reuse |

`INSUFFICIENT_STOCK` is a spine-stable code already listed in ARCHITECTURE-SPINE.md and already in the `edge/src/sync/connector.ts` permanent-error set. Reuse it exactly; do not mint a production-specific variant.

### Architecture Compliance

- AD-3 (DOA registry as single approval resolver): the release-gate override resolves through `resolveApprover('production_order.release_override', 0)`. No hard-coded role list, no override flag that skips the registry, no reason-coded bypass anywhere in this story.
- AD-5 (production WIP distinct from R&D project WIP): this story creates no WIP ledger, but it fixes the boundary that makes the separation possible. `assertNotRdDraft` bars an R&D draft BOM from ever reaching a production order's release gate, which is the structural half of AD-5 at the BOM level (sprint-change-proposal line 2402).
- AD-12 (compliance spine as platform layer): every rule is enforced in the seam inside `persistEvent`, not in the HTTP handler. The handler-only check is the exact defect pattern the Story 7.6 Group A review caught and patched.
- AD-14 (read models are shared projections): `production_order.status` is derived state, written only inside the event transaction. The gate reads `stock_balance` and the BOM tables through their own projection modules, never with ad-hoc SQL against another module's tables.
- AD-16 (idempotency keys on all edge-originated commands): every write route carries an idempotency key even though no edge path exists yet, so Story 6.4's offline replay lands on an already-correct dedup contract.
- AD-17 (notification emission coupling): not exercised. This story emits no notification.

### Previous Story Intelligence

Epic 6 has no previous story, so the actionable intelligence comes from the Epic 5 BOM stories this one consumes and from the most recent Epic 7 reviews.

- Story 5.5 built `explodeBomForExecution` specifically so this story would not re-walk the BOM. Its review applied 18 patches, several of which (the DATE timezone-shift family, the `released_bom_structure` scoping, the NUMERIC path ordering) live inside the service. Re-implementing the walk here would reintroduce every one of them.
- Story 5.4 established `assertNotRdDraft` as the single definition of the R&D execution bar, with a comment naming Epic 6's release gate as a caller. Calling it is the contract; re-deriving `bom_type === 'rnd'` is a defect.
- Story 5.6 review resolved that the empty-rollup gate requires `line_count > 0`. The same instinct applies here: a BOM that explodes to zero requirement lines must not silently pass the availability gate. Task 4.7 pre-applies the fix.
- Story 7.6 review, Group A, found that a rule enforced only in the HTTP handler is bypassable through `POST /api/v1/events`, and that a payload field the applier can derive but does not check is a corruption channel. Both findings are pre-applied in Binding Scope Decision 6 and the Event Contract.
- Story 7.4 review found a 201 body read back by grain rather than by id. Task 6.4 pre-applies the fix.
- Story 7.2 Group 2 decided that an applier must never silently no-op on a state it should reject. The Lifecycle Contract is written as an exhaustive table for exactly that reason.
- Stories 4.5 and 7.6 both established that server-computed results are written back onto the persisted payload rather than left implicit. The allocated order number and the resolved `override_by` follow that precedent.

### Git Intelligence

Baseline is `e93014f` (`7-5`). The working tree at story-creation time carries the completed but uncommitted Story 7.6 change set (four new projections, two new seams, the statutory jobs module, and edits to `src/events/store.ts`, `src/events/schema.ts`, `src/events/migrate.ts`, `src/api/v1/maintenance.ts`, `src/server.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`). Every append point this story uses - the `MIGRATIONS` tail, the `SUPPORTED_EVENT_TYPES` tail, the `persistEvent` assert and applier blocks, the `createAppRouter` tail, the `EXPECTED` map, `allowedSpineRoutes` - already has a Story 7.6 block at the end. Append after it; do not reorder or reflow any existing entry.

The recent commit pattern across Stories 7.1 to 7.6 is one story per commit with the story key as the subject. Nothing in the last five commits touches the BOM or stock modules this story reads, so the Epic 5 surfaces are exactly as their story files describe them.

### Testing Requirements

- Framework and harness: the existing integration-test harness under `test/integration/`, bootstrapped exactly as `story-5-6.test.ts` does (node:test, direct `http.request` against `createAppServer`, `getPool` and `getAdminPool` for setup, a `run` suffix from `randomUUID().slice(0, 8)` on every generated code so parallel runs do not collide). Unit-level schema assertions go in `test/unit/schema-drift.test.ts`.
- Red-green-refactor per task: write the failing assertion first, confirm it fails for the right reason, then implement.
- Every acceptance criterion needs at least one test that would FAIL if the behavior were removed. A test that only asserts a 200 is not coverage.
- Every error code in Table 5 needs a test, including every delegated code, because delegation is the thing most likely to be silently replaced by a local re-implementation.
- Idempotency: every write route gets a replay test asserting the same resource comes back and the event ledger count did not grow.
- The four gate-integrity tests are mandatory and are the heart of AC5, AC6 and AC7:
  1. Shortfall blocks release. Build a released two-line BOM, receive stock covering one line only, call the release route with no override, assert 409 `INSUFFICIENT_STOCK`, assert the per-line shortfall detail names the short component, assert the order is still `planned`, and assert NO `production_order.released` event was written.
  2. Sufficient stock releases. Receive the missing line, release, assert 200, assert `released_revision_id` equals the current released revision of the BOM, assert `expediting_flag` is false.
  3. Override by the resolved approver releases despite the shortfall. Assert `expediting_flag` is true, `override_by` and `override_reason` are recorded, and an `audit_log` row exists for the release.
  4. Override by a non-approver is rejected. Assert 403 `APPROVAL_REQUIRED`, the order is still `planned`, NO release event exists, and an `audit_log` row exists with `error_code = 'APPROVAL_REQUIRED'` and `http_status = 403`.
- Delegation tests: the R&D-draft, draft-BOM and item-mismatch cases in Task 8.8 exist to prove the gate calls the service rather than re-deriving. If any of them passes while `src/production/release-gate.ts` contains its own `bom_type` or `status` predicate, the test is passing for the wrong reason.
- Depth and nesting: at least one release test uses a two-level BOM (a component whose own released BOM contributes requirement lines) and at least one uses stock held in a bin two levels below the plant site, so both the explosion walk and the location descendant walk are genuinely exercised.
- Bypass tests: the three forged direct-event cases in Task 8.11 are the AD-12 evidence. Each must assert the rejection AND that no projection row changed.
- Concurrency: two parallel creations get distinct numbers; two parallel releases of one order resolve to one success and one stable 400.
- Edit log: AC2 requires attribution for every accepted transition. Assert an `audit_log` row per transition, not merely that the projection status changed.
- Regression: Stories 5.1 to 5.6 and 7.1 to 7.6 suites must pass unchanged. If a Story 5.5 assertion has to change, the explosion service has been modified, which this story forbids: re-read Binding Scope Decision 1 before touching that file.
- Known baseline: sixteen pre-existing failures at `e93014f` with the Story 7.6 tree applied (fifteen Epic 1 to 3 idempotency failures plus one `gate_dwell_metric` line-ending artifact), all recorded in `deferred-work.md`. Zero NEW failures is the bar; do not attempt to fix the baseline in this story.
- Do not weaken, skip or delete an existing test to make a new one pass.

### Project Structure Notes

New files: `read/projections/production_order.sql`, `src/read/projections/production_order.ts`, `src/compliance/production-order.ts`, `src/production/release-gate.ts`, `src/api/v1/production-orders.ts`, `test/integration/story-6-1.test.ts`.

Modified files: `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/read/projections/stock_balance.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `_bmad-output/implementation-artifacts/deferred-work.md`.

Read-only, do not modify: everything under `src/engineering/` (the explosion and cost-rollup services), `src/compliance/bom.ts`, `src/compliance/bom-execution.ts`, `read/projections/bom*.sql`, and every Epic 5 test file. The ARCHITECTURE-SPINE structural seed names a top-level `production/` directory; this codebase places module code under `src/`, so the module directory is `src/production/`, matching the existing `src/maintenance/` and `src/engineering/` precedent. That is a deliberate alignment with the built structure, not a deviation from the spine's intent.

No new dependency is required or permitted. Everything this story needs (pg, node:crypto, the existing middleware, the DOA resolver, the explosion service, the stock projections) is already installed.

### References

- Epic 6, Story 6.1 and the FR-MO lines: `_bmad-output/planning-artifacts/epics.md` (Epic 6 at line 1953, Story 6.1 at line 1957, FR-MO-01 to FR-MO-03 at lines 111-113, the Epic 8 hard-prerequisite note at line 413, the Story 5.5 explosion-service handoff at line 1904).
- FR-MO functional requirement text: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` (section 4.7, lines 217-229).
- The Epic 6 resequencing and the R&D execution-bar rewording: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md` (D3 at line 29, the Epic 6 edits at line 2590, the `RD_EXECUTION_BARRED` acceptance criterion at line 2402, the explosion-service contract at line 2539).
- AD-3, AD-5, AD-12, AD-14, AD-16 and AD-17 plus the capability map: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (AD-3 at line 82, AD-5 at line 94, AD-12 at line 136, AD-14 at line 148, AD-16 at line 160).
- The explosion service this gate calls: `src/engineering/bom-explosion.ts` (`explodeBomForExecution` at line 253, the Epic 6 handoff comment at line 15).
- The R&D execution bar: `src/compliance/bom.ts` (`assertNotRdDraft` at line 130, the Epic 6 caller comment at line 127).
- The stock ledger and the descendant-walk pattern to mirror: `src/read/projections/stock_balance.ts` (`getForwardPickBalance` at line 172), `read/projections/stock_balance.sql` (the generated `available` column).
- The tagging seam that delivers AC1: `src/compliance/business-stream.ts` (`assertInventoryTagging`), and the registry flag precedent at `src/events/schema.ts` line 2964 (`indent.raised`).
- The DOA resolver: `src/api/v1/indents.ts` line 66 (`resolveApprover`), used for return-to-service in `src/api/v1/maintenance.ts` and for ad-hoc substitution approval in `src/api/v1/bom-execution.ts` line 301.
- The document-number sequence pattern: `src/read/projections/indent.ts` line 331 (`allocateIndentNumber`), `read/projections/indent.sql` line 81 (`indent_number_seq`).
- The explicit edit-log-on-rejection precedent: `src/api/v1/gate.ts` line 233 (`logAuditEntry` on a dedicated pool client), `src/read/projections/audit_log.ts` (`AuditEntryPayload`, with a nullable `event_id`).
- The seam structure to copy: `src/compliance/calibration-register.ts`, wired in `src/events/store.ts` (pre-transaction asserts at lines 429 to 441, in-transaction appliers from line 665).
- The most recent story file, its review outcome and its binding decisions: `_bmad-output/implementation-artifacts/7-6-statutory-examinations-cost-accumulation-and-machine-status-broadcast.md`.
- The BOM stories this one consumes: `_bmad-output/implementation-artifacts/5-4-randd-draft-bom-regime.md`, `_bmad-output/implementation-artifacts/5-5-approved-alternates-and-bom-explosion.md`, `_bmad-output/implementation-artifacts/5-6-cost-rollups-job-work-kit-tagging-and-erp-outbound-sync.md`.

## Dev Agent Record

### Agent Model Used

kilo-auto/efficient

### Debug Log References

- Story 7.6 working tree was present at baseline `e93014f` exactly as the Git Intelligence section predicted; every append point already had a Story 7.6 tail block.
- `src/api/v1/boms.js` already exports a `getReleaseGateHandler` (Story 5.2), so the production dry-run handler was named `getProductionReleaseGateHandler` to avoid the import collision in `src/server.ts`.
- The handler state pre-checks (planned-only release, cancel reachability) initially rejected same-key replays before `persistEvent`'s idempotency short-circuit could return the stored result. Added `findReplayForOrder` + `sendReplayOrNull`, run BEFORE the pre-checks, so a legitimate replay returns the current order row while a cross-stream or cross-type key reuse still surfaces 409 `DUPLICATE_EVENT` through `replayIdOrReject` (test 8.12 proved the ordering matters).
- A blank `business_stream` must NOT be rejected in the create handler: AC1's `UNTAGGED_TRANSACTION` fires in `persistEvent`'s `assertInventoryTagging` and must be reachable identically from the handler and direct-event paths (test 8.3).
- Direct-event forgery tests initially used mismatched `stream_id`/`production_order_id` (rejected by the seam's stream cross-check) and fabricated `output_sku`/`order_uom` (rejected by the applier's item-master re-derivation). Tests now carry the item's real sku/uom so the specific rule under test fires.

### Completion Notes List

- Implemented all 9 tasks (67 checkboxes) from baseline `e93014f` (Story 7.6 working tree applied).
- New `production_order` projection (1 table + `production_order_number_seq`, mirror in init-db.sql CRLF, migrate registration, schema-drift EXPECTED). New 'production' stream with 4 events in `src/events/schema.ts`, only `production_order.created` tagged (`requiresBusinessStream: true` so AC1's `UNTAGGED_TRANSACTION` fires in persistEvent). `INVENTORY_MOVEMENT_STREAM_TYPES` untouched per Task 2.4.
- `src/read/projections/production_order.ts` (row type + insert/get/getForUpdate/getByNumber/list/update accessors), `allocateProductionOrderNumber` (MO-YYYY-NNNN from the sequence, `allocateIndentNumber` pattern), and `getAvailableBalanceUnderSite` in `stock_balance.ts` (depth-capped descendant walk over `available`, `stock_class 'owned'`).
- `src/production/release-gate.ts`: pure read-and-compute, delegates the walk to `explodeBomForExecution` (BOM_NOT_FOUND / RD_EXECUTION_BARRED / BOM_NOT_RELEASED / EXPLOSION_QUANTITY_INVALID / BOM_EXPLOSION_CYCLE_DETECTED surfaced unchanged), adds the BOM_ITEM_MISMATCH identity check and the per-line SQL-NUMERIC availability comparison; never throws INSUFFICIENT_STOCK, reports `satisfied: false` + per-line shortfalls; `depth_truncated` and `empty_requirement_set` force `satisfied: false`; no stock lock and no allocation (documented in the module header).
- `src/compliance/production-order.ts` seam (stream gate, pure shape assert, in-transaction applier, `alreadyPersisted`, `reject`): created applier locks item then location rows, re-derives output_sku/order_uom under lock, allocates the order number and rejects a declared divergence `ORDER_NUMBER_IMMUTABLE`; released applier re-runs the gate under the order's FOR UPDATE lock, re-checks `released_revision_id` and re-resolves the DOA override (`APPROVAL_REQUIRED` on a forged `override_by`, `INSUFFICIENT_STOCK` on an un-overridden shortfall); state_changed/cancelled appliers enforce the Table 2 state machine with the AC4 `UNREVERSED_TRANSACTIONS` guard. Wired into `src/events/store.ts` (pre-transaction assert, in-transaction applier, 23505 mapper for `uq_production_order_number_ext` and `production_order_pkey`).
- 7 REST routes in `src/api/v1/production-orders.ts` (create/list/get/release-gate dry-run/release/transition/cancel) with module-production RBAC, DOA-resolved override (Task 6.2/6.3, AC7 explicit audit-log row via the gate.ts precedent), replay-first idempotency, and read-back by id; registered in `src/server.ts` with static-before-parameter ordering and allowlisted in the Story 1.9 spine suite.
- Story 6.1 integration suite `test/integration/story-6-1.test.ts`: 26 tests covering every AC, every Table 5 error code (including the delegated codes and the defensive `DUPLICATE_PRODUCTION_ORDER_NUMBER` mapping), the four gate-integrity tests, delegation negatives, the three AD-12 forged-direct-event bypass cases, per-route replay tests, both concurrency tests, and the read surface. Out-of-scope items logged to `deferred-work.md` (Task 9).
- Gates: build/lint clean, prettier clean on all story files (8 pre-existing non-story files in the Story 7.6 tree / HEAD baseline remain flagged), db:migrate idempotent x2, schema-drift 103/104 (1 pre-existing gate_dwell CRLF), spine 6/6, story-6-1 26/26, full suite 1156 tests 1140 pass, 16 fail = the documented pre-existing baseline (15 Epic 1-3 idempotency + 1 gate_dwell CRLF), 0 new.

### File List

New files:
- `read/projections/production_order.sql`
- `src/read/projections/production_order.ts`
- `src/production/release-gate.ts`
- `src/compliance/production-order.ts`
- `src/api/v1/production-orders.ts`
- `test/integration/story-6-1.test.ts`

Modified files:
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/read/projections/stock_balance.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`

### Change Log

Table 6 records the change history of this story file.

| **Date** | **Change** |
| --- | --- |
| 2026-08-26 | Story created via create-story workflow; status set to ready-for-dev |
| 2026-08-26 | Dev story implemented (all 9 tasks / 67 subtasks) from baseline e93014f; status set to review |
| 2026-08-27 | Code review Group A (schema, events, seam, projections) completed: 1 decision-needed, 9 patches, 1 defer, 7 dismissed |
| 2026-08-27 | All 9 Group A patches applied: actor-is-approver check for release override (AC7), hard-fail on truncated/empty explosion even under override, released_at/cancelled_at read as ISO strings, release gate evaluated on server time, canonicalized trim write-back for source_reference_id/business_stream, timestamp offset bounded to 15:59, length bounds on override_reason/source_reference_id, blank reason_code rejected, cancelled payload declares and re-derives unreversed_transaction_count; 3 new regression tests; story-6-1 29/29, spine 6/6, schema-drift 107/108 (1 pre-existing gate_dwell CRLF), story-7-7 39/39, build/lint/prettier clean |
| 2026-08-27 | Code review Group B (release gate, REST API, wiring) completed: 1 decision-needed, 6 patches, 1 defer, 2 dismissed |
| 2026-08-27 | All 6 Group B patches applied: replayIdOrReject stream_id check closing cross-order idempotency-key reuse (new regression test), list filter/pagination validation (400 on non-UUID and malformed limit/offset), release-gate UUID identity check case-normalized, blank reason_code rejected in handler, order_quantity positivity enforced in handler, idempotencyKey computed once and reused for persistEvent; story-6-1 suite re-run |
| 2026-08-27 | Group B decision resolved and applied: production routes scoped by plant location (the Story 4.3 indents precedent) - assertPlantLocationAccess on all 7 routes, permittedPlantLocations filter on the list projection, RBAC regression test; story-6-1 31/31, spine 6/6, story-7-7 39/39, build/lint/prettier clean |
| 2026-08-27 | Code review Group C (integration tests) completed: 11 patches, 5 defers, 3 dismissed |
| 2026-08-27 | All 11 Group C patches applied: OVERRIDE_REASON_REQUIRED, BOM_NOT_FOUND and DUPLICATE_PRODUCTION_ORDER_NUMBER tests, AC2 rejection table asserts the error code on every pair, seam AC4 guard test via direct event, forged wrong-revision/wrong-sku/wrong-previous_status re-derivation tests, numeric/text/timestamp boundary tests, list filter+pagination+validation tests, dry-run per-line assertions, ORDER_NUMBER_IMMUTABLE year fix, AC7 audit approver assertion, schema-drift comment corrected; story-6-1 41/41, schema-drift 107/108 (1 pre-existing gate_dwell CRLF), build/lint/prettier clean; status set to done |

### Review Findings (Group A: schema, events, seam, projections)

- [x] [Review][Patch] The release gate in the seam is evaluated with the envelope's client-controlled `occurred_at` instead of a server-derived business date, so a backdated direct event can weaken AC5 coverage [src/compliance/production-order.ts:517-526] - decision resolved: evaluate the gate with server time (matching the handler's `now()`), keep occurred_at for the year prefix per Binding Scope Decision 3
- [x] [Review][Patch] AC7 bypass: the released seam checks the declared `override_by` equals the DOA approver but never verifies the event actor is that approver, so a non-approver with production stream write can forge an expedited release on the direct-event path [src/compliance/production-order.ts:542-568]
- [x] [Review][Patch] Expedited release overrides a depth-truncated or empty explosion, releasing against a partial requirement set in violation of the Release Gate Contract [src/compliance/production-order.ts:542, 569]
- [x] [Review][Patch] `released_at` and `cancelled_at` are read back as Date objects, not strings, violating the module's read-as-string contract and the `string | null` type [src/read/projections/production_order.ts:76, 78]
- [x] [Review][Patch] Created applier trims `business_stream` and `source_reference_id` for the insert but does not write the trimmed values back onto the persisted payload, breaking the byte-identical-payload contract [src/compliance/production-order.ts:449-450, 462-464]
- [x] [Review][Patch] Timestamp offset is not range-bounded, so `+99:99` passes shape validation and then fails in PostgreSQL as an unmapped 500 [src/compliance/production-order.ts:76, 94-107]
- [x] [Review][Patch] `override_reason` and `source_reference_id` have no length bound while `reason_code` is capped at 512, allowing unbounded text on the direct-event path [src/compliance/production-order.ts:188, 227]
- [x] [Review][Patch] Blank `reason_code` passes shape validation despite the error message claiming a non-blank string is required [src/compliance/production-order.ts:283-289]
- [x] [Review][Patch] Cancelled payload omits `unreversed_transaction_count` from the declared-and-checked surface the Event Contract Table 1 requires [src/events/schema.ts:2856-2863]
- [x] [Review][Defer] No stream_type/event_type registry cross-check: a forged `production_order.*` event under a foreign stream_type bypasses all shape validation and the projection [src/events/store.ts:256-410] - deferred, pre-existing platform-wide gap already logged under Stories 7.1, 7.2, 7.4 and 7.5; resolve as one platform registry check

### Review Findings (Group B: release gate, REST API, wiring)

- [x] [Review][Patch] No plant-location scoping on any of the seven production routes: the RBAC layer resolves `production:read`/`write` roles but the routes never consulted `permittedLocationsForModuleScope`, so a plant-scoped role could read, release, transition and cancel orders at ANY plant. Decision resolved: scope the routes by plant (matching the Story 4.3 indents precedent). Implemented: `assertPlantLocationAccess` (read scope on get/list/release-gate dry-run, write scope on create/release/transition/cancel), `permittedPlantLocations` filter on the list projection, and an RBAC regression test [src/api/v1/production-orders.ts, src/read/projections/production_order.ts]
- [x] [Review][Patch] Cross-order same-event-type idempotency-key reuse silently returns the first order's resource instead of 409 DUPLICATE_EVENT: `persistEvent`'s idempotency short-circuit is key-global while the handler's replay pre-check is order-scoped, and `replayIdOrReject` checked only event_type and UUID-ness, never stream_id, so a key reused on a different order returned a phantom 200/201 for the first order and dropped the intended write [src/api/v1/production-orders.ts:114-132]
- [x] [Review][Patch] List route does not validate `plant_location_id`/`output_item_id` (non-UUID silently returns an empty list) or `limit`/`offset` (malformed values silently default), unlike the indents and maintenance list precedents which reject 400 [src/api/v1/production-orders.ts:382-410]
- [x] [Review][Patch] Release-gate BOM_ITEM_MISMATCH identity check compares case-sensitively while `UUID_REGEX` is case-insensitive and PostgreSQL renders `uuid` columns lowercase, so an uppercase-but-valid input to the exported `evaluateReleaseGate` would produce a false mismatch [src/production/release-gate.ts:135-146]
- [x] [Review][Patch] Blank `reason_code` passes the cancel handler and is only rejected by the seam, splitting validation across two layers and two codes [src/api/v1/production-orders.ts:736-744]
- [x] [Review][Patch] `order_quantity` handler regex accepts zero (`"0"`) despite the error message claiming positive; only the seam rescues it [src/api/v1/production-orders.ts:281-287]
- [x] [Review][Patch] `idempotencyKeyFrom(body)` is computed twice on release/transition/cancel - once for the replay pre-check and again for `persistEvent` - so a request omitting the key dedupes with two different random UUIDs and the pre-check lookup can never match [src/api/v1/production-orders.ts:492, 620]
- [x] [Review][Defer] `APPROVAL_UNRESOLVED` surfaces as both 404 (no DOA entry, raised by the handler) and 409 (entry exists but no active holder, raised by shared `resolveApprover`) on the release route [src/api/v1/production-orders.ts:507-513, src/api/v1/indents.ts:96-104] - deferred, pre-existing platform issue already logged under the 7-6 review (reconciling the two is a DOA-layer decision)

### Review Findings (Group C: integration tests)

- [x] [Review][Patch] Six Table 5 error codes had no test; the three reachable ones are now covered: OVERRIDE_REASON_REQUIRED (blank/missing override reason rejected 400 before any DOA resolution), BOM_NOT_FOUND (delegated 404 on a release against a random bom_id), DUPLICATE_PRODUCTION_ORDER_NUMBER (23505 resolver via a sequence rewind). The three structurally unreachable codes (COMPONENT_SKU_UNRESOLVED, EXPLOSION_QUANTITY_INVALID, BOM_EXPLOSION_CYCLE_DETECTED - all barred upstream at item/BOM creation) are deferred [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] AC2 rejection table asserted only the HTTP status on every illegal pair; it now asserts the stable INVALID_STATE_TRANSITION code on every rejection via assertInvalidTransition [test/integration/story-6-1.test.ts AC2]
- [x] [Review][Patch] The seam's AC4 UNREVERSED_TRANSACTIONS guard was never exercised (only the handler pre-check was tested); a forged production_order.cancelled direct event on a released order with a matching counter now proves the seam guard fires [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] Direct-event re-derivation gaps: forged released with a wrong released_revision_id, forged created with a wrong output_sku, and forged state_changed with a wrong previous_status are now all asserted as 409 PRODUCTION_ORDER_DERIVATION_MISMATCH [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] Numeric and text boundaries: order_quantity 13-digit and 7-decimal rejections, over-length source_reference_id (513) and override_reason (513) rejected 400, blank reason_code rejected 400 INVALID_PARAMS by the handler [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] Timestamp offset boundary: a direct created event with a +99:99 UTC offset is now asserted as 400 INVALID_PAYLOAD instead of an unmapped 500 [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] List-route coverage: plant_location_id and business_stream filters, output_item_id negative filter, pagination (limit/offset), and 400s for malformed filters and pagination are now asserted [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] Dry-run gate test now asserts per-line shortfall content (component_sku, satisfied, shortfall_quantity), not just Array.isArray(lines) [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] The ORDER_NUMBER_IMMUTABLE test hardcoded `MO-2026-0001`, which collides with the allocation when the sequence returns 1 in 2026; it now derives a year 100 years ahead that can never equal the allocation [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] The AC7 audit assertion now also verifies details->>'resolved_approver_user_id' (Task 6.3 requires the order id and the resolved approver in the audit details) [test/integration/story-6-1.test.ts]
- [x] [Review][Patch] The schema-drift production_order entry's comment overclaimed that the sequence and its USAGE grant are pinned; corrected to state that the harness asserts only tables, constraints, indexes and table grants, never sequences [test/unit/schema-drift.test.ts]
- [x] [Review][Defer] depth_truncated gate path has no test anywhere in the repo (story-5-5/5-6 only assert depth_truncated: false); triggering it needs a BOM chain 21 levels deep at the default maxDepth 20, a harness/config decision [src/production/release-gate.ts, test/integration/story-6-1.test.ts]
- [x] [Review][Defer] empty_requirement_set gate path has no test and is not constructible through the API (BOM creation requires at least one line, BOM_LINE_REQUIRED); the gate's zero-requirement branch is defensive fail-closed [src/production/release-gate.ts]
- [x] [Review][Defer] COMPONENT_SKU_UNRESOLVED, EXPLOSION_QUANTITY_INVALID and BOM_EXPLOSION_CYCLE_DETECTED (Table 5 delegated codes) are not reachable through the API: SKUs are mandatory on items, order quantity is validated at create, and cyclic BOMs are barred at draft [test/integration/story-6-1.test.ts]
