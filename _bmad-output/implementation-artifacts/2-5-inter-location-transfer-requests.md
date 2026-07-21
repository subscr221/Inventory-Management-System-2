---
baseline_commit: a76aa46
---

# Story 2.5: Inter-Location Transfer Requests

Status: ready-for-dev

## Story

As a warehouse manager,
I want to raise inter-location transfer requests with DOA-approval routing, then execute pick, ship, and receive transactions that maintain lot and serial traceability throughout,
So that stock moves between sites on an auditable chain of events with no quantity or lot leakage.

## Acceptance Criteria

1. **Given** a transfer request from `site-A` to `site-B` for 50 units of `RM-0042`, lot `LOT-2026-001`
   **When** the request is submitted
   **Then** the 50 units show as `allocated` at `site-A`; the available balance at `site-A` decreases immediately while on-hand and in-transit are unchanged; the request is routed for approval via the DOA registry — stock enters `in_transit` only when the ship event posts

2. **Given** the transfer is approved and the pick and ship events are confirmed at `site-A`
   **When** the ship event is posted
   **Then** `site-A` on-hand decreases by 50; an in-transit record of 50 units appears carrying `lot_id: "LOT-2026-001"`

3. **Given** the receive event is posted at `site-B`
   **When** the transaction is processed
   **Then** `site-B` on-hand increases by 50 with `lot_id: "LOT-2026-001"` preserved; the in-transit balance clears; both ship and receive events carry the same `correlation_id`

4. **Given** a transfer request that has not been approved via the DOA registry
   **When** a ship event for that transfer is posted
   **Then** the write is rejected with `error_code: "APPROVAL_REQUIRED"` and no stock moves to `in_transit`

5. **Given** a transfer approved for 50 units
   **When** a ship event for 60 units is posted
   **Then** the write is rejected with `error_code: "QUANTITY_EXCEEDS_APPROVED"` and the approved quantity is returned to the caller

6. **Given** the ship event carried `lot_id: "LOT-2026-001"`
   **When** a receive event at `site-B` references `lot_id: "LOT-2026-002"`
   **Then** the write is rejected with `error_code: "LOT_MISMATCH"` and the in-transit record stays open until a matching receive or an approved discrepancy resolution posts

## Tasks / Subtasks

- [ ] Task 1: Add transfer request domain event and schema (AC: 1, 4, 5)
  - [ ] Add `TransferRequestCreated` event with fields: `transfer_request_id`, `sku_id`, `quantity`, `from_location_id`, `to_location_id`, `lot_id` (optional for serial-controlled items), `serial_ids` (array, if present), `business_stream`, and optional `notes`
  - [ ] Extend `src/events/schema.ts` with the transfer request event type and payload shape; add to `SUPPORTED_EVENT_TYPES`
  - [ ] Mirror the event schema in `deploy/compose/init-db.sql`; add `domain_events` table view coverage in schema drift
  - [ ] Ensure the event envelopes use the standard `event_id`, `stream_type: "inventory"`, `stream_id: {transfer_request_id}`, `event_version`, JSONB payload, actor metadata, UTC `occurred_at`, and `schema_version`

- [ ] Task 2: Add transfer request allocation enforcement in persistEvent (AC: 1, 4)
  - [ ] Create `src/compliance/transfer-request.ts` with shape validation before transaction and projection enforcement during transaction
  - [ ] Pre-transaction: validate `sku_id`, `from_location_id`, and `to_location_id` are distinct; from/to locations exist and are active; `quantity > 0`; lot exists if `lot_id` is provided; serials exist and belong to the lot if `serial_ids` are provided
  - [ ] Inside transaction: before inserting `domain_events`, allocate the requested quantity in `stock_balance` (AC1: decrements `available`, not `on_hand` or `in_transit`)
  - [ ] Reject with `error_code: "INSUFFICIENT_STOCK"` if the from-location available balance (after allocation) would fall below zero
  - [ ] Record the `TransferRequestCreated` event and write an audit row with the requesting actor; include the allocation as a projection mutation (do not insert a separate stock-adjustment event)
  - [ ] Wire the transfer-request compliance seam through `src/events/store.ts` after stock-balance but before domain-events insert, gated to `stream_type: "inventory"` and `TransferRequestCreated` event type only
  - [ ] Add idempotency: if the same `transfer_request_id` is resubmitted, return success without re-allocating or re-auditing

- [ ] Task 3: Add transfer request approval routing via DOA registry (AC: 1, 4)
  - [ ] Create `src/api/v1/transfer-requests.ts` with `POST /api/v1/transfer-requests` endpoint to submit the request and `GET /api/v1/transfer-requests/{transfer_request_id}` to query status
  - [ ] At submission, resolve the approving authority from the DOA registry based on quantity-banded rules (e.g., < 100 units: supervisor, 100-1000: manager, > 1000: director; rules TBD with the project during implementation)
  - [ ] If approval is required, respond with `error_code: "APPROVAL_REQUIRED"` and include the resolving authority in the response; do not insert a separate approval-task entity (Story 1.7 DOA escalation pattern: the event itself triggers a notification)
  - [ ] If approval is not required (e.g., transfer within the same site or a whitelisted pair), insert the event and return the transfer request ID and status `pending_shipment`
  - [ ] Store the DOA-resolved authority on the `TransferRequestCreated` event payload as `approver_actor_id` so the authority is immutable on the event; the actor field is the requester
  - [ ] Enforce inventory write RBAC: only `warehouse_manager`, `logistics_manager`, or `store_assistant` can create transfer requests

- [ ] Task 4: Add DOA-gated approval flow (AC: 1, 4)
  - [ ] Create `PATCH /api/v1/transfer-requests/{transfer_request_id}/approve` and `/reject` endpoints
  - [ ] On approval: validate the caller is the DOA-resolved approver authority and update the transfer request event's approval status to `approved` (do not create a second event; amend the status field if idempotent, or create an `ApprovalDecided` event if separation is preferred — **decide during implementation**)
  - [ ] On rejection: record the rejection with a mandatory reason code, revert the allocation in `stock_balance` (add back the quantity to `available`), and move the request to `rejected` status
  - [ ] Both approval and rejection must write to the edit log with actor identity and decision timestamp

- [ ] Task 5: Add ship event and in-transit enforcement (AC: 2, 4, 5)
  - [ ] Add `TransferShipCreated` event with fields: `transfer_request_id`, `shipped_quantity`, `lot_id` (must match the request), `serial_ids` (must be a subset of the request), and optional `notes`
  - [ ] Extend `src/compliance/transfer-request.ts` to validate and enforce ship events:
    - Pre-transaction: transfer request exists and is approved; shipped quantity ≤ approved quantity (AC5 check); lot and serials match (AC6 check for ship side)
    - Inside transaction: decrement `on_hand` at the from-location; increment `in_transit` for the same `sku_id`, `lot_id` with the transfer request ID as traceability; carry `correlation_id` to link to the receive event; write the `TransferShipCreated` event and audit row
  - [ ] Reject with `error_code: "APPROVAL_REQUIRED"` if the request is not approved (AC4)
  - [ ] Reject with `error_code: "QUANTITY_EXCEEDS_APPROVED"` if the ship quantity exceeds the approved total (AC5); include the approved quantity in the error response detail
  - [ ] Create `POST /api/v1/transfer-requests/{transfer_request_id}/ship` endpoint; enforce `warehouse_manager` or `store_assistant` RBAC

- [ ] Task 6: Add receive event and in-transit clearance (AC: 3, 6)
  - [ ] Add `TransferReceiveCreated` event with fields: `transfer_request_id`, `received_quantity`, `lot_id` (subject to AC6 validation), `serial_ids`, `received_at_location_id`, and optional `received_date`
  - [ ] Extend `src/compliance/transfer-request.ts` to validate and enforce receive events:
    - Pre-transaction: transfer request exists and is shipped; received location exists and is active; received quantity > 0
    - Inside transaction: decrement `in_transit` at the from-location for the matching `lot_id`; increment `on_hand` at the to-location with the same `lot_id` (AC3); write the `TransferReceiveCreated` event and audit row; attach `correlation_id` from the ship event
  - [ ] Reject with `error_code: "LOT_MISMATCH"` if the received `lot_id` does not match the shipped `lot_id` (AC6); leave in-transit open (do not auto-correct)
  - [ ] Create `POST /api/v1/transfer-requests/{transfer_request_id}/receive` endpoint; enforce `warehouse_manager` or `store_assistant` RBAC
  - [ ] Location scoping: receiving at a different location than the approved to-location should raise a validation error or warning — **decide during implementation**

- [ ] Task 7: Add transfer request read model and query surfaces (AC: 1-6)
  - [ ] Create `read/projections/transfer_request.sql` with fields: `transfer_request_id`, `sku_id`, `allocated_quantity`, `shipped_quantity`, `received_quantity`, `from_location_id`, `to_location_id`, `lot_id`, `status` (`pending_shipment`, `shipped`, `received`, `rejected`), `approved_by_actor_id`, `created_at`, `shipped_at`, `received_at`, `correlation_id`
  - [ ] Create `read/projections/in_transit.sql` as a view or separate table tracking: `sku_id`, `location_from`, `location_to`, `lot_id`, `quantity`, `transfer_request_id`, `correlation_id`, `ship_event_id`, `created_at`
  - [ ] Register both in `src/events/migrate.ts`; add guarded grants in the DDL
  - [ ] Implement `src/read/projections/transfer_request.ts` and `src/read/projections/in_transit.ts` handlers to apply events atomically
  - [ ] Add `GET /api/v1/transfer-requests` with optional filters: `from_location_id`, `to_location_id`, `status`, and `sku_id`; enforce inventory read RBAC and location scoping
  - [ ] Add `GET /api/v1/stock/{sku_id}/in-transit` to show active in-transit balances by location and lot for a given SKU; enforce inventory read RBAC
  - [ ] Register new routes in `src/server.ts` and update the Story 1.9 route-surface guard

- [ ] Task 8: Add stable errors, edge sync, and i18n (AC: 4, 5, 6)
  - [ ] Add stable error codes: `APPROVAL_REQUIRED`, `QUANTITY_EXCEEDS_APPROVED`, `LOT_MISMATCH` to the architecture stable error list
  - [ ] Add to `src/sync/upload.ts`: classify `APPROVAL_REQUIRED`, `QUANTITY_EXCEEDS_APPROVED`, `LOT_MISMATCH` as business rejections so they settle edge events as `needs_attention` without halting the outbox
  - [ ] Add to `edge/src/sync/connector.ts`: classify the same error codes
  - [ ] Add i18n entries to `edge/src/messages/en.json` for all three errors
  - [ ] Update `test/unit/sync-upload.test.ts` and `edge/test/unit/connector.test.ts` to cover the new errors

- [ ] Task 9: Add integration, unit, and regression tests (AC: 1-6)
  - [ ] Create `test/integration/story-2-5.test.ts` covering all six acceptance criteria:
    - AC1: Transfer request creation, allocation at source, DOA routing, approval requirement
    - AC2: Ship event moves quantity from on-hand to in-transit, preserves lot
    - AC3: Receive event at destination clears in-transit, increments on-hand, preserves lot and correlation_id
    - AC4: Unapproved ship is rejected with `APPROVAL_REQUIRED`
    - AC5: Over-quantity ship is rejected with `QUANTITY_EXCEEDS_APPROVED`; approved quantity is returned
    - AC6: Mismatched lot on receive is rejected with `LOT_MISMATCH`; in-transit remains open
  - [ ] Include idempotent retry coverage: resubmitting the same request, ship, or receive event must be a no-op
  - [ ] Include concurrency coverage: two concurrent ship attempts for the same request should be serialized; the second should fail or increment the shipped count (decide during implementation)
  - [ ] Include location-scoping coverage: verify transfers only affect the involved locations
  - [ ] Extend `test/integration/story-2-2.test.ts` to verify stock-balance `allocated` is preserved through a transfer cycle and in-transit does not leak into available or on-hand
  - [ ] Extend `test/integration/story-1-9.test.ts` to include the new transfer-request routes in route-surface coverage
  - [ ] Add schema-drift coverage for the new events and projections in `test/unit/schema-drift.test.ts`
  - [ ] Run before marking done:
    - `npx tsc --noEmit`
    - `npm run lint`
    - `npm run build`
    - `npm test`
    - `npm run edge:typecheck && npm run edge:lint && npm run edge:test`
    - `npm run spine-acceptance-contract`
    - `git diff --check`

## Dev Notes

### Epic Context

Story 2.5 is the inter-location transfer mechanism built on the inventory ledger from Stories 2.1 (item and location masters) and 2.2 (stock-balance projection with allocated/on-hand/in-transit states). It provides the first multi-location movement with DOA-gated approval and traceability via event correlation. It does not implement replenishment workflows (Story 2.7), consignment or VMI logic (Story 2.8), or ERP integration (Story 2.9). [Source: `_bmad-output/planning-artifacts/epics.md:1043`]

Story 2.5 depends on the DOA registry (Story 1.4) for quantity-banded approver resolution and the notification foundation (Story 1.11) for alerting. Transfers are only between active locations; location deactivation is out of scope. [Source: `_bmad-output/planning-artifacts/epics.md:1045-1077`]

### Architecture Compliance

- Transfer requests and events follow the same event-sourcing pattern as Stories 2.1-2.4: domain events in `domain_events`, read models in projection tables, and state mutations only through events. State transitions (pending → shipped → received) are implicit in the event stream, not stored as separate state columns (though the projection denormalizes them for query efficiency). [Source: `src/events/store.ts:150`]
- The DOA registry is the single source of approval authority. Quantity bands and approver resolution are not hard-coded; the resolution is fetched at request time and stamped immutably on the event. [Source: `src/read/projections/doa-registry.sql`; see Story 1.4 Dev Notes]
- `allocation` is a stock-balance state distinct from `on_hand` (received or manufactured) and `in_transit` (shipped, not yet received). An allocated-but-not-shipped transfer request holds the quantity in `allocated` and does not affect `on_hand` or `in_transit`. Story 2.2 enforcement ensures the sum of on_hand + allocated + in_transit + consignment + vmi ≥ received_qty for consistency.
- Correlation IDs link the ship and receive events so the same transfer can be traced end-to-end across locations. Use the same `correlation_id` on both events or generate it once on the ship and pass it to the receive. [Source: `_bmad-output/planning-artifacts/architecture/ARCHITECTURE-SPINE.md:278`]
- APIs are REST under `/api/v1/`, SSO-gated, and use the uniform `{ error_code, message, details, trace_id }` envelope. All transfer-request writes are audit logged. [Source: `src/api/v1/stock.ts:21`]
- The stack is Node.js 24 LTS, PostgreSQL 18.4, TypeScript 5.x, Next.js 16, and PowerSync 1.23.x. Do not add a new ORM or workflow engine.

### Current Code State

- `persistEvent()` is the central write path. Transfer-request compliance must be added as a seam in the same place as stock-balance and lot/serial validation (Task 2). [Source: `src/events/store.ts:150`]
- `stock_balance` has `location_id`, `sku_id`, `lot_id`, `stock_class`, and `available` (= on_hand - allocated - in_transit but stored directly), `on_hand`, `in_transit`, `consignment`, `vmi`, `job_work` columns. Task 5 will add or reuse the `in_transit` column. [Source: `read/projections/stock_balance.sql:18`; Source: `src/compliance/stock-balance.ts:78`]
- `location_master` projection from Story 2.1 has `location_id`, `parent_location_id`, `zone_type`, `temperature_class`, `access_restricted`, and `is_active`. Task 1 must validate `is_active: true` on both from and to locations. [Source: `read/projections/location_master.sql`]
- DOA registry resolution is via `src/read/projections/doa-registry.sql` and the `queryDOAAuthority()` function in `src/doa/resolver.ts`. [Source: Story 1.4 codebase; used in Stories 1.5, 1.7]
- `ActorLocationAssignments` from Story 1.2 RBAC gates location-scoped reads. Transfer endpoints must honor location scoping per the actor's assigned locations.
- The `in_transit` column exists in `stock_balance` but is currently unused after story 2.2. Story 2.5 will populate it. Verify existing tests do not assume `in_transit` is always zero.

### File Structure Requirements

Likely update files:

- `src/events/schema.ts` — add `TransferRequestCreated`, `TransferShipCreated`, `TransferReceiveCreated` event types
- `src/events/store.ts` — wire transfer-request compliance seam
- `src/compliance/transfer-request.ts` — new compliance module
- `src/api/v1/transfer-requests.ts` — new API routes
- `src/read/projections/transfer_request.ts` — new projection handler
- `src/read/projections/in_transit.ts` — new projection handler
- `src/server.ts` — register new routes
- `src/events/migrate.ts` — register new projection files
- `src/sync/upload.ts` — classify new errors
- `edge/src/sync/connector.ts` — classify new errors
- `edge/src/messages/en.json` — add i18n entries
- `deploy/compose/init-db.sql` — add event schema and projection DDL
- `test/integration/story-1-9.test.ts` — add new routes to surface guard
- `test/integration/story-2-2.test.ts` — extend stock-balance state coverage
- `test/unit/schema-drift.test.ts` — add drift coverage for new events/projections
- `test/unit/sync-upload.test.ts`, `edge/test/unit/connector.test.ts` — cover new error codes

Likely new files:

- `read/projections/transfer_request.sql`
- `read/projections/in_transit.sql`
- `test/integration/story-2-5.test.ts`

### Transfer Request Design Guardrails

- Allocation is immediate on request creation (AC1 before approval), so the allocation must roll back if approval is rejected (Task 4). Use the same `persistEvent()` pattern: no rollback until a rejection event is written.
- In-transit is a stock state, not a separate entity. Do not create a separate `in_transit_shipments` table; use the `in_transit` column in `stock_balance` and add a denormalized projection if needed for query efficiency.
- Lot matching on receive (AC6) is strict: ship `lot_id` must equal receive `lot_id`. Mismatches do not auto-correct or split the in-transit balance. A discrepancy-resolution flow is out of scope; this story blocks the receive.
- Serial control: if the item is serial-controlled, both the ship and receive events must carry matching `serial_ids`. Un-lotted serial-controlled items must carry serials.
- Correlation IDs must be unique per transfer to support tracing. Generate once on the ship event and carry it to the receive event.
- Transfers within the same site should not require approval or should use a whitelisted approval rule (e.g., no approval needed within site-A). This decision is TBD; code should make the rule configurable or explicit in the DOA resolution.
- Partial receipts: if shipped quantity is 50 but received quantity is 30, the in-transit balance is decreased by 30 and the on-hand at the destination is increased by 30. The in-transit balance for the transfer decreases but does not clear until the remaining 20 is received. (Decide if this is in-scope for AC3 or deferred to a later adjustment story.)

### Previous Story Intelligence

Story 2.4 established these patterns to reuse:

- Use `persistEvent()` as the single write path so both HTTP and edge sync paths are covered by construction. [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:91`]
- Compliance logic (shape validation, business rules) runs before the transaction; projection mutation (state changes) runs inside. [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:92`]
- Keep projection DDL self-sufficient with guarded grants and mirror it in compose init. [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:128`]
- Add stable errors to the architecture list, server sync classifier, edge classifier, and edge i18n together (not in separate PRs). [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:168`]
- Idempotency keys prevent duplicate writes. Resubmitted requests with the same request ID must be no-ops. [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:92`]
- Full test coverage includes happy path, edge cases (mismatches, over-quantities), concurrency, and idempotency. A green suite is not enough if invariants are not explicitly tested. [Source: `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md:151`]

Story 2.3 introduced:

- Central `persistEvent()` integration so HTTP and edge sync inherit compliance automatically. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:231`]
- Projection consistency: all state changes happen inside the event transaction, not in separate writes. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:233`]
- `LOT_REQUIRED` enforcement for lot-controlled, non-serial receives; serial control takes precedence. Story 2.5 should inherit this: if an item is lot-controlled, `lot_id` is mandatory on transfer requests. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml:51`]

Deferred items relevant to Story 2.5:

- Partial receipts and discrepancy workflows (receive quantity < shipped quantity): the current acceptance criteria do not cover this; decide if partial receives should update in-transit or require a separate adjustment flow.
- Transfer cancellation before shipment (reverting allocation): out of scope; the story handles rejection via DOA. Cancellation after shipment is not addressed.
- Expedite or reroute after shipment: not in scope.

### DOA Approval Decision Points

**Implement during Task 3:**

1. **Quantity bands for approval:** The story says "DOA-approval routing" but does not specify the bands. Options:
   - No approval needed for any transfer (fast path, risky).
   - Approve only transfers above a threshold (e.g., > 100 units).
   - Approve all transfers (safe, slower).
   - Approve based on value (quantity × unit cost), requiring the valuation projection.
   - **Recommend:** Start with "all transfers require approval" (safe, testable) and adjust bands in configuration later.

2. **Authority resolution:** Use the same DOA resolver as Stories 1.4, 1.7 — query the rule set and resolve the approver actor. If no rule matches, reject the request with a clear error or escalate to the highest authority (e.g., director). **Recommend:** Treat as a "Transfer Request" type in the DOA rule set and require explicit configuration.

3. **Location-based exceptions:** Transfers within the same location (e.g., bin to bin within the same warehouse) might not need approval. **Recommend:** Add a rule in DOA or make the request-creation API detect same-location and skip approval for those.

### API and Error Contract

- `POST /api/v1/transfer-requests` → creates the request, allocates stock, routes for approval
  - Request body: `{ sku_id, quantity, from_location_id, to_location_id, lot_id?, serial_ids?, business_stream, notes? }`
  - Response: `{ transfer_request_id, status, approver_actor_id?, error_code? }`
  - Errors: `INSUFFICIENT_STOCK`, `APPROVAL_REQUIRED`, `ITEM_NOT_FOUND`, `LOCATION_NOT_FOUND`, `LOT_NOT_FOUND`, `INVALID_LOCATION` (same location), `INVENTORY_WRITE_PERMISSION_DENIED`

- `PATCH /api/v1/transfer-requests/{id}/approve` → approves by authority
  - Request body: `{ notes?: string }`
  - Errors: `APPROVAL_REQUIRED` (caller is not the authority), `INVALID_STATE` (not pending approval)

- `PATCH /api/v1/transfer-requests/{id}/reject` → rejects and reverts allocation
  - Request body: `{ reason_code: string, notes?: string }`
  - Errors: same as approve

- `POST /api/v1/transfer-requests/{id}/ship` → moves stock to in-transit
  - Request body: `{ lot_id, serial_ids?, shipped_quantity?, notes?: string }`
  - Errors: `APPROVAL_REQUIRED`, `QUANTITY_EXCEEDS_APPROVED`, `INSUFFICIENT_STOCK`

- `POST /api/v1/transfer-requests/{id}/receive` → clears in-transit, increments on-hand
  - Request body: `{ lot_id, serial_ids?, received_quantity?, received_date?: string, notes?: string }`
  - Errors: `LOT_MISMATCH`, `INSUFFICIENT_IN_TRANSIT`, `INVALID_STATE`

- `GET /api/v1/transfer-requests?from_location_id=...&status=...` — list requests
- `GET /api/v1/transfer-requests/{id}` — get single request
- `GET /api/v1/stock/{sku_id}/in-transit` — see active in-transit balances

Stable error codes (new):

- `APPROVAL_REQUIRED` — transfer not yet approved or approver rejects
- `QUANTITY_EXCEEDS_APPROVED` — ship or receive exceeds the allocation/approval
- `LOT_MISMATCH` — receive lot does not match ship lot

### Testing Requirements

Run or add tests so these commands pass before marking done:

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm test` (includes integration tests)
- `npm run edge:typecheck`
- `npm run edge:lint`
- `npm run edge:test`
- `npm run spine-acceptance-contract`
- `git diff --check`

Integration tests must cover:

- AC1: Request creation with allocation, DOA routing, approval required response
- AC2: Ship event moves on-hand to in-transit, preserves lot
- AC3: Receive event clears in-transit, increments on-hand, carries correlation_id
- AC4: Unapproved ship rejected with `APPROVAL_REQUIRED`
- AC5: Over-quantity ship rejected with `QUANTITY_EXCEEDS_APPROVED`; response includes approved quantity
- AC6: Mismatched lot rejected with `LOT_MISMATCH`; in-transit remains open
- Idempotency: same request/ship/receive resubmitted is a no-op
- Concurrency: concurrent requests to the same stock settle consistently
- Location scoping: verify transfers only affect the involved locations
- Allocation reversal: rejected transfer reverts the allocation
- Stock-balance state: allocated + on-hand + in-transit consistency maintained

---

## Story Completion Status

**Status:** ready-for-dev

This story provides a comprehensive, developer-ready specification for inter-location stock transfers with DOA approval, lot/serial traceability, and full event-sourced tracking. The dev agent has all critical context from Stories 2.1-2.4 patterns, architecture compliance requirements, DOA integration, and acceptance-criteria-driven test coverage expectations.

**Key decisions deferred to implementation (mark in code comments):**

1. Quantity bands for DOA approval (Task 3)
2. Approval event structure vs. status amendment (Task 4)
3. Location-scoped receive validation (Task 6)
4. Partial receipt handling (partial in-transit clearance) — deferred to Task 9 scope decision
5. Transfer cancellation / reversal after shipment — out of scope for this story
