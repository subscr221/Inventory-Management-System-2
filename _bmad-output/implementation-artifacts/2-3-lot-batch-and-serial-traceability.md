---
baseline_commit: 12a931f97bbf9fa299856a2dbcc2aa88f13be78e
---

# Story 2.3: Lot, Batch, and Serial Traceability

Status: review

## Story

As a quality manager,
I want every lot, batch, and serialized item tracked end-to-end through all stock movements with FEFO/FIFO enforced on issue and expiry dates visible,
So that a recall can be traced to all affected locations within 15 minutes and expired stock is never issued without an explicit override.

## Acceptance Criteria

1. **Given** lot `LOT-2026-001` with `expiry_date: 2026-09-30` and lot `LOT-2026-002` with `expiry_date: 2026-12-31` are both in stock, **when** an issue transaction for `RM-0042` using FEFO is raised, **then** the system selects `LOT-2026-001` before `LOT-2026-002`, and the `lot_id` is carried in the issue event.
2. **Given** a lot with `expiry_date` in the past is in stock, **when** an issue transaction for that lot is submitted without an override flag, **then** the write is rejected with `error_code: "LOT_EXPIRED"` and the expiry date is returned to the caller.
3. **Given** a quality hold is placed on `LOT-2026-001`, **when** an issue or allocation referencing that lot is attempted, **then** the write is rejected with `error_code: "LOT_ON_HOLD"` and the hold reason is returned.
4. **Given** a recall event is triggered for `LOT-2026-001`, **when** `GET /api/v1/lots/LOT-2026-001/trace` is called, **then** the response lists every location the lot has been in, every transaction it appeared in, and its current balance per location, returned within the API p95 threshold of 500ms.
5. **Given** item `EQ-0500` is serial-controlled per its item master flag, **when** an issue transaction for `EQ-0500` is submitted without serial numbers, **then** the write is rejected with `error_code: "SERIAL_REQUIRED"`.
6. **Given** serial `SN-1001` of `EQ-0500` is already in stock, **when** a receipt event carrying the same serial `SN-1001` is posted, **then** the write is rejected with `error_code: "DUPLICATE_SERIAL"` and the location currently holding that serial is returned.

## Tasks / Subtasks

- [x] Task 1: Add lot and serial master schemas and projections (AC: 1, 2, 3, 4, 5, 6)
  - [x] 1.1 Add `read/projections/lot_master.sql` as the canonical projection with `lot_id` (surrogate PK), `sku`, `expiry_date` (date), `quality_hold_status` (none | held), `quality_hold_reason` (optional), and `created_at`, `updated_at`. Include idempotent constraints, indexes for SKU + expiry and lot_id lookups, and guarded grants.
  - [x] 1.2 Add `read/projections/serial_master.sql` with `serial_id` (surrogate PK), `sku`, `serial_number` (unique across SKU), `current_location_id`, `current_quantity` (for this serial), and timestamps. Include guarded grants and an index on `sku` + `serial_number`.
  - [x] 1.3 Add `read/projections/lot_trace.sql` as an auxiliary table for fast recall traces, capturing every transaction touching a lot. Columns: `lot_id`, `event_id`, `event_type`, `sku`, `location_id`, `quantity_change` (signed), `business_stream`, `timestamp`. Index on `lot_id` + `timestamp` for recall reporting.
  - [x] 1.4 Compose mirrors for all three projections in `deploy/compose/init-db.sql`.
  - [x] 1.5 Register all three projections in `src/events/migrate.ts`.
  - [x] 1.6 Create `src/read/projections/lot_master.ts` with helper functions following the Story 2.1 pattern: optional `PoolClient`, local `runner()`, apply and read functions. Expose `lotExists()`, `getLotByIdOrSkuExpiry()`, and `applyLotEvent()` for receipt events that create lots.
  - [x] 1.7 Create `src/read/projections/serial_master.ts` with similar pattern. Expose `getSerialBySku()`, `getSerialByNumber()`, `applySerialReceipt()`, and `applySerialIssue()`.
  - [x] 1.8 Create `src/read/projections/lot_trace.ts` with `getTraceForLot()` and `appendTraceEntry()` for each transaction touching the lot.

- [x] Task 2: Add lot and serial enforcement in the write path (AC: 1, 2, 3, 5, 6)
  - [x] 2.1 Create `src/compliance/lot-serial-validation.ts` with a narrow seam similar to `src/compliance/stock-balance.ts`.
  - [x] 2.2 Gate enforcement to `stream_type: "inventory"` and event types `stock.received`, `stock.allocated`, `stock.issued`.
  - [x] 2.3 For `stock.received` with `lot_id`: validate lot does not already exist (no duplicate lot creation on the same SKU + expiry combo). Apply the lot to the projection so subsequent issue transactions find it.
  - [x] 2.4 For `stock.received` with serial numbers: validate each `serial_number` is not already in the system for the same SKU (AC6: DUPLICATE_SERIAL); apply each serial to the projection with current location and quantity.
  - [x] 2.5 For `stock.allocated` or `stock.issued` with `lot_id`: validate the lot exists, is not on quality hold (AC3: LOT_ON_HOLD with reason returned), and if the lot has expired, reject with LOT_EXPIRED unless a caller-provided override flag is present (AC2).
  - [x] 2.6 For `stock.issued` with serial numbers: validate each serial exists, is available (not already allocated), and the item is marked serial-controlled in the item master (AC5: SERIAL_REQUIRED).
  - [x] 2.7 Apply lot and serial state changes within the same transaction as the event insert so they commit or rollback together. Do not create a separate lot or serial table mutation path outside this seam.
  - [x] 2.8 Ensure rejected lot/serial validations do not consume an idempotency key and do not write `domain_events`.
  - [x] 2.9 Preserve Story 2.2's stock-balance enforcement and all Story 2.1 inventory-master checks. Lot/serial validation is an additional layer on top.

- [x] Task 3: Add lot trace and FEFO/FIFO selection API contracts (AC: 1, 4)
  - [x] 3.1 Add `GET /api/v1/lots/:lot_id/trace` that returns a trace listing all transactions for the lot, locations it has been in, current balances per location, and the `expiry_date`. Protect with `requireRole({ module: 'inventory', functionScope: 'read' })` and location scoping.
  - [x] 3.2 Ensure the trace query completes within the 500ms API p95 target (AC4), using the `lot_trace` auxiliary table and a single batch join to current stock balances.
  - [x] 3.3 Add a helper endpoint or code path `POST /api/v1/stock/:sku/select-lot` (or incorporate into the direct event write path) that returns the next lot to issue when FEFO/FIFO is requested. Accept parameters: `sku`, `location_id`, `quantity`, `fifo_mode` (fefo | fifo). Return the lot ID and confirm availability.
  - [x] 3.4 FEFO logic: sort candidate lots by `expiry_date` ascending (earliest expiry first), then by `lot_id` ascending for determinism.
  - [x] 3.5 FIFO logic: sort candidate lots by `created_at` ascending (oldest receipt first).
  - [x] 3.6 Ensure the selection does not write any event and is idempotent -- multiple calls with the same parameters return the same lot ID.
  - [x] 3.7 If no lot is available (all held, all expired), return `error_code: "NO_AVAILABLE_LOT"` with a breakdown of held vs. expired vs. insufficient-quantity lots.

- [x] Task 4: Wire event payloads and API integration (AC: 1, 2, 3, 5, 6)
  - [x] 4.1 Extend `stock.received` payload to include optional `lot_id` and optional array `serials: [{ serial_number, initial_quantity }]`. Keep `sku`, `target_location_id`, `quantity`, `unit_cost`, `po_line_ref`, `business_stream` as before.
  - [x] 4.2 Extend `stock.allocated` and `stock.issued` payloads to include optional `lot_id` and optional array `serials`. For `stock.issued`, allow an optional `fefo_mode: "fefo" | "fifo"` flag to indicate lot selection mode; if not provided, the caller supplies the `lot_id` explicitly.
  - [x] 4.3 Preserve backward compatibility: events without `lot_id` or serials remain valid and post to the `NULL` lot and `NULL` serial rows (allowing pre-Story-2-3 test data to continue working, but new writes to lots/serials are validated).
  - [x] 4.4 Add `LOT_EXPIRED`, `LOT_ON_HOLD`, `DUPLICATE_SERIAL`, `SERIAL_REQUIRED`, `NO_AVAILABLE_LOT` to the stable error-code list in the architecture. Map them to i18n keys in `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`.
  - [x] 4.5 Ensure edge uploads cannot bypass lot/serial validation. Validation happens in the central write path, same as stock-balance validation.

- [x] Task 5: Add quality-hold management API (AC: 3)
  - [x] 5.1 Add `PUT /api/v1/lots/:lot_id/quality-hold` to place a hold with a reason and actor identity. Payload: `hold_reason` (string). Response: updated lot status.
  - [x] 5.2 Add `DELETE /api/v1/lots/:lot_id/quality-hold` to clear a hold. Audit-log both operations.
  - [x] 5.3 Protect both endpoints with `requireRole({ module: 'quality', functionScope: 'write' })`.
  - [x] 5.4 Hold/clear operations are audit-logged and create events in the domain_events stream so recalls and compliance audits have a complete chain of custody.

- [x] Task 6: Extend schema drift and route-surface guards (AC: 1, 2, 3, 4, 5, 6)
  - [x] 6.1 Extend `test/unit/schema-drift.test.ts` to guard `lot_master`, `serial_master`, and `lot_trace` projection schemas, constraints, indexes, and grants.
  - [x] 6.2 Update `test/integration/story-1-9.test.ts` route-surface allowlist with `GET /api/v1/lots/:lot_id/trace`, `POST /api/v1/stock/:sku/select-lot`, `PUT /api/v1/lots/:lot_id/quality-hold`, `DELETE /api/v1/lots/:lot_id/quality-hold`.
  - [x] 6.3 Do not add these to the five spine invariants; the spine tests remain unchanged.
  - [x] 6.4 Update integration test harness setup and truncation lists to include `lot_master`, `serial_master`, and `lot_trace`.

- [x] Task 7: Add complete test coverage and preserve previous behavior (AC: 1, 2, 3, 4, 5, 6)
  - [x] 7.1 Add `test/integration/story-2-3.test.ts` covering all six ACs using `createAppRouter()`, real auth, RBAC, and PostgreSQL.
  - [x] 7.2 AC1: Create two lots with different expiry dates in the same stock, assert FEFO selection picks the earlier-expiry lot, and verify the `lot_id` is carried in the issue event.
  - [x] 7.3 AC2: Create an expired lot, attempt issue without override, assert `LOT_EXPIRED` rejection with expiry date returned. Retry with override flag, assert success.
  - [x] 7.4 AC3: Place a quality hold on a lot with a reason, attempt issue on that lot, assert `LOT_ON_HOLD` rejection with reason returned. Clear the hold, retry, assert success.
  - [x] 7.5 AC4: Record multiple transactions against a lot (receipt, allocation, issue), call `/api/v1/lots/{lot_id}/trace`, assert returned trace includes all transactions, locations, and current balance, completed within 500ms.
  - [x] 7.6 AC5: Create a serial-controlled item, attempt issue without serials, assert `SERIAL_REQUIRED` rejection.
  - [x] 7.7 AC6: Receipt a serial number, attempt duplicate receipt of the same serial for the same SKU, assert `DUPLICATE_SERIAL` rejection with current location returned.
  - [x] 7.8 Cover FIFO lot selection (oldest received first) and confirm it produces a different result than FEFO when expiry dates differ.
  - [x] 7.9 Cover batch operations: multiple serials in one receipt, verify all are applied to the projection.
  - [x] 7.10 Cover edge upload with lots and serials, verify validation happens and edge cannot bypass it.
  - [x] 7.11 Cover idempotent retry of a lot receipt: the duplicate returns `DUPLICATE_EVENT` and projections are unchanged.
  - [x] 7.12 Run `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run spine-acceptance-contract`, and `git diff --check` before completion.

## Dev Notes

### Epic Context

Epic 2 makes the inventory ledger the transactional foundation for real-time multi-location stock visibility. Story 2.1 established item and location masters. Story 2.2 added the stock-balance projection and central enforcement. Story 2.3 layers in lot, batch, and serial tracking so every movement is traceable and recall operations find affected inventory within 15 minutes.

Lot traceability is foundational for:
- FEFO/FIFO picking rules (Story 3.6 and later)
- Expiry management and aged-stock identification (Story 2.8)
- Recall readiness (FR-I-04)
- Valuation by lot when using specific-identification costing (Story 2.4)
- Job-work custody ledgers identifying customer-supplied lots (Story 9.3)
- Quality control disposition per lot (Story 8.3)

[Source: `_bmad-output/planning-artifacts/epics.md` lines 909-963, FR-I-04]

Story 2.3 implements FR-I-04 only. The binding performance numbers are the lot-trace query (500ms API p95 per AC4) and the lot-selection query (immediate response).

### Architecture Compliance

- Lot, serial, and lot-trace are shared read-model projections under `read/projections/`, not private module tables. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 24-33, 148-152]
- Event payloads carry `lot_id` and `serials` as optional fields. New event types `stock.received`, `stock.allocated`, `stock.issued` already exist from Story 2.2 and are extended, not created. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 172-188]
- Lot-hold operations (placing and clearing a hold) are themselves audit-logged events. Quality holds are not stored as mutable state columns in the lot_master table; the hold status is derived from the most-recent hold/clear event. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 182-184]
- Quality-hold rejection and lot-expired rejection use the uniform `{ error_code, message, details, trace_id }` envelope. `LOT_EXPIRED`, `LOT_ON_HOLD`, `DUPLICATE_SERIAL`, `SERIAL_REQUIRED` are stable error codes added to the architecture list. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 328-337]
- The implementation is compatible with Node.js 24, PostgreSQL 18.4, TypeScript 5.x, and existing `pg` usage. Do not add dependencies.

### Current Code State and Required Update Files

- `src/events/store.ts`: Keep all existing validation. Add lot/serial validation via `src/compliance/lot-serial-validation.ts` before `persistEvent()` returns, alongside stock-balance enforcement.
- `src/compliance/inventory-master.ts`: Reuse field names (`sku`, `target_location_id`, `target_location_code`) so lot/serial payloads inherit existing master validation.
- `src/compliance/stock-balance.ts`: Lot/serial validation is independent; both seams run in `persistEvent()` without coupling.
- `src/api/v1/events.ts`: Keep the event write path unchanged. Lot/serial write happens via domain events as before.
- `src/server.ts`: Add routes `GET /api/v1/lots/:lot_id/trace`, `POST /api/v1/stock/:sku/select-lot`, `PUT /api/v1/lots/:lot_id/quality-hold`, `DELETE /api/v1/lots/:lot_id/quality-hold`.
- `src/events/migrate.ts`: Append `../../read/projections/lot_master.sql`, `../../read/projections/serial_master.sql`, `../../read/projections/lot_trace.sql`.
- `deploy/compose/init-db.sql`: Mirror all three projection schemas.
- `test/unit/schema-drift.test.ts`: Add `lot_master`, `serial_master`, `lot_trace` to `EXPECTED`.
- `test/integration/story-1-9.test.ts`: Add four new routes to route-surface allowlist.
- `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`: Add five new error codes and their i18n mappings.

### Reuse Patterns from Story 2.1 and 2.2

- Projection helpers follow the Story 2.1 pattern: optional `PoolClient`, local `runner()`, stable row mapping, typed inputs and outputs. [Source: `src/read/projections/item_master.ts`, `src/read/projections/location_register.ts`]
- Canonical SQL is self-sufficient, idempotent, and carries guarded grants. Use the Story 2.1 style, not the old split-brain pattern. [Source: `read/projections/item_master.sql`, `read/projections/location_register.sql`]
- Compliance seams are narrow and gate to specific stream and event types. Validation failure must not write a domain event or consume an idempotency key. [Source: `src/compliance/stock-balance.ts` lines 1-80]
- Use authenticated context for actor identity and location scoping on all routes. [Source: `src/api/v1/events.ts` lines 46-62]
- Test setup uses `createAppRouter()`, real PostgreSQL, and distinct role strings to avoid false authorization passes. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 81-86]

### Lot and Serial Semantics

- **Lot**: A group of units received together with the same SKU, expiry date, and other tracking attributes. The lot is the unit of traceability for recall. Lots are immutable after receipt (no lot merge or split transactions).
- **Serial**: A unique identifier for individual serialized items (e.g., equipment with a model number and serial number). Every serial receipt, move, and issue is tracked.
- **Quality Hold**: A transient state applied to a lot after receipt, preventing issue or allocation until the hold is cleared. Holds are audit-logged as events.
- **FEFO (First Expiry First Out)**: Lot selection rule that issues the lot with the earliest `expiry_date` first. Used for perishables and commodities with regulatory age requirements.
- **FIFO (First In First Out)**: Lot selection rule that issues the lot received earliest (`created_at` ascending). Used when expiry is not a concern but historical cost matters.
- **Lot Trace**: A complete record of every transaction touching a lot, including all locations it has been in and current balance per location. Used for recall operations.

### Performance Requirements

- Lot-trace query (`GET /api/v1/lots/:lot_id/trace`) must return within 500ms API p95 (AC4, NFR-P-05). Achieved by pre-computing the lot-trace auxiliary table on every event insert and indexing on `lot_id` + `timestamp`.
- Lot-selection query (`POST /api/v1/stock/:sku/select-lot`) has no explicit SLA but must be immediate (sub-100ms). Achieved by sorting in-memory from the lot_master projection.

### UX and Edge Requirements

- All new error codes must have i18n mappings so edge users see localized messages, not raw error codes.
- The quality-hold UI (placing and clearing holds) is a quality module function, not part of this story. This story delivers the API and audit trail; Story 8 (Quality Control) uses these endpoints.
- Serial batch receipt (multiple serials in one event) must be supported for box receipts.

### Previous Story Intelligence

Story 2.2 finished with 209/209 tests, spine gate 6/6, and clean TypeScript, ESLint, build, and diff-check. It established the stock-balance projection, central enforcement seam pattern, and the `/api/v1/stock/:sku` query pattern. Story 2.3 builds directly on these patterns without changing them.

Important learnings from 2.1 and 2.2:
- Central validators can break older test harnesses that post inventory events. Seed fixtures (items, locations, lots) before test runs that post stock events.
- Projection application must happen inside the same database transaction as the event insert.
- Edge uploads must not bypass validation — enforcement is in `persistEvent()`, not in route handlers.
- Test concurrency uses `--test-concurrency=1` (serial). Use coordinated promises or barriers for concurrency coverage, not parallel test runners.
- Idempotent retry must return `DUPLICATE_EVENT` and not apply projection changes twice.
- Schema drift tests must guard every constraint, index, and grant.

### Testing Requirements

- Integration tests require PostgreSQL container and run serially. Use `createAppRouter()` and real auth/RBAC/SCIM.
- Lot trace performance assertion: measure query path with test data at multiple locations, assert sub-500ms.
- Lot selection: test both FEFO and FIFO with multiple lots, confirm correct deterministic sort order.
- Quality hold: test place, clear, and retry issue after clear.
- Serial batch: test receipt and issue of multiple serials in one event.
- Concurrency: use coordinated database clients or controlled promises to test duplicate-serial race.
- Full verification battery: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run spine-acceptance-contract`, `git diff --check`.

### Anti-Patterns to Avoid

- Do not build lot traces by replaying the event stream on every trace query. Use the pre-computed `lot_trace` table.
- Do not store lot holds as mutable columns in `lot_master`. Holds are derived from hold/clear events.
- Do not validate lot/serial only at the route level. Validation must be in `src/compliance/lot-serial-validation.ts` so edge uploads are covered.
- Do not let a duplicate serial create a row and repair it later. Reject before event insert.
- Do not implement lot merge, split, or reclassification transactions in this story. Lots are immutable.
- Do not build lot-selection logic into the API handler. Selection is a stateless query against the projection.
- Do not add new npm dependencies.
- Do not create hard-coded business logic for FEFO vs. FIFO; make it a caller-provided parameter.
- Do not claim completion unless every AC has passing integration coverage and the full verification battery is green.

### Open Clarifications Saved for Dev Judgment

- Lot lifecycle: this story assumes lots are immutable after receipt. If future stories require lot merge or split, those are new stories with new event types and will not break the Story 2.3 lot_master schema.
- Quality-hold events: should they be sourced in `domain_events` with `stream_type: "lot_holds"` or as special events in the inventory stream? Recommend inventory stream with `event_type: "lot.quality_hold_placed"` and `"lot.quality_hold_cleared"` for audit simplicity.
- Batch serial receipt: payloads can use `serials: [{ serial_number, quantity }]` without a separate serial-receipt event per unit. Quantity defaults to 1 if omitted.
- Pre-existing data: lots and serials without `lot_id` (e.g., generic bulk stock in Story 2.2 tests) remain valid and are tracked as `NULL` lot_id and `NULL` serials. New writes must supply `lot_id` or risk validation errors downstream (e.g., when a future story requires lot on issue).

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` lines 909-963, 967-1003]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 24-33, 148-164, 172-188, 182-184, 328-337]
- [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 72-240]
- [Source: `_bmad-output/implementation-artifacts/2-2-real-time-multi-location-stock-balances.md` lines 72-143]
- [Source: `src/events/store.ts` lines 148-277]
- [Source: `src/compliance/stock-balance.ts` lines 1-80]
- [Source: `src/read/projections/item_master.ts`, `src/read/projections/location_register.ts`]
- [Source: `read/projections/item_master.sql`, `read/projections/location_register.sql`]
- [Source: `src/server.ts` lines 50-99]
- [Source: `src/events/migrate.ts` lines 8-17]
- [Source: `test/unit/schema-drift.test.ts` lines 35-79]
- [Source: `test/integration/story-1-9.test.ts` lines 151-193]
- [Source: `package.json` lines 6-42]

## Dev Agent Record

### Agent Model Used

- Story creation: claude-haiku-4-5-20251001
- Implementation: claude-haiku-4-5-20251001

### Status Tracking

- Story file creation: 2026-07-21
- Ready for dev-story workflow: 2026-07-21
- Implementation started: 2026-07-21
- Implementation completed: 2026-07-21
- Dependencies: Story 2.1 (item/location masters), Story 2.2 (stock-balance projection)

### Implementation Plan

Story 2.3 was implemented in a single continuous session following the red-green-refactor cycle. All 7 tasks were completed sequentially with tests passing at each stage.

### Completion Notes

**Task 1: Schema and Projections**
- Created `lot_master.sql`, `serial_master.sql`, and `lot_trace.sql` with proper constraints, indexes, and guarded grants
- Updated `deploy/compose/init-db.sql` with compose mirrors
- Updated `src/events/migrate.ts` to register all three projections
- Created TypeScript helper modules following Story 2.1 patterns

**Task 2: Write Path Enforcement**
- Created `src/compliance/lot-serial-validation.ts` with narrow seam pattern
- Integrated validation into `src/events/store.ts` persistEvent flow
- Added pre-transaction shape validation and in-transaction projection application
- Ensured validation failures don't consume idempotency keys or write domain events

**Task 3: API Contracts**
- Created `src/api/v1/lots.ts` with four new endpoints:
  - `GET /api/v1/lots/:lot_id/trace` - complete recall trace
  - `POST /api/v1/stock/:sku/select-lot` - FEFO/FIFO lot selection
  - `PUT /api/v1/lots/:lot_id/quality-hold` - place quality hold
  - `DELETE /api/v1/lots/:lot_id/quality-hold` - clear quality hold
- Registered all routes in `src/server.ts`

**Task 4: Event Payloads and Integration**
- Extended event payload handling to support optional `lot_id` and `serials` arrays
- Added new error codes to architecture: LOT_EXPIRED, LOT_ON_HOLD, DUPLICATE_SERIAL, SERIAL_REQUIRED, NO_AVAILABLE_LOT
- Updated `src/sync/upload.ts` and `edge/src/sync/connector.ts` with permanent error code classifications
- Added i18n mappings in `edge/src/messages/en.json`

**Task 5: Quality-Hold Management API**
- Implemented quality hold/clear endpoints with audit logging
- Protected with `requireRole({ module: 'quality', functionScope: 'write' })`
- Both operations create domain events for complete chain of custody

**Task 6: Schema Drift and Route Guards**
- Extended `test/unit/schema-drift.test.ts` with three new projection guards
- Updated `test/integration/story-1-9.test.ts` route allowlist with four new routes
- Updated integration test harness truncation lists in story-2-1 and story-2-2 tests

**Task 7: Test Coverage**
- Created comprehensive `test/integration/story-2-3.test.ts` covering all 6 ACs
- Tests include: FEFO/FIFO selection, expired lot rejection, quality hold enforcement, lot trace, serial validation, duplicate serial rejection, batch operations, edge upload validation, and idempotent retry

### Technical Decisions

1. **Lot master uses lot_number as unique identifier** - The API-facing identifier is `lot_number` (not lot_id UUID), matching the story's acceptance criteria which reference `LOT-2026-001` style identifiers.

2. **Quality holds are derived state** - Following the architecture decision, quality holds are not stored as mutable columns but are derived from hold/clear events.

3. **Lot/serial validation is additive** - The validation runs alongside (not replacing) Story 2.2's stock-balance enforcement and Story 2.1's inventory-master checks.

4. **Idempotency guard placement** - The validation runs inside the transaction with an idempotency guard to ensure rejected operations don't consume idempotency keys.

5. **Projection application pattern** - Following Story 2.2's pattern, lot/serial projections are applied inside the same transaction as the domain event insert.

## Project Context Reference

This inventory management system is built on a **compliance-spine-first architecture**. Every transaction is compliant by construction. The core event store carries immutable domain events with full audit trails. Offline-first edge PWA shell syncs through PowerSync to the central PostgreSQL store.

**Pilot Go-Live Slice:** Epics 1 (Platform), 2 (Core Inventory), 3 (Warehouse Operations), 5 (BOM), 7 (Maintenance), 8 (Quality), 9 (Job-Work), plus Story 11.2 (IRN enforcement). Story 2.3 is part of the core inventory pilot.

**Tech Stack:** Node.js 24, PostgreSQL 18.4 (self-managed), TypeScript 5.x, Next.js 16, PowerSync 1.23.x (self-hosted), Docker, native server or cloud VPS.

**Key Architecture Decisions:**
- Platform is the system of record for lot and serial traceability.
- ERP receives read-only lot/serial data via outbound sync (deferred to Phase 2).
- Every lot-hold operation is audit-logged.
- Quality holds can escalate to escalation targets via DOA registry (Story 8 integration).

---

## Ultimate Context Engine Completion

This story document represents an exhaustive analysis of all relevant context to prevent developer mistakes and omissions:

✓ Epic and story foundation from planning artifacts
✓ Architectural compliance requirements and constraints
✓ Current code state and all files requiring updates
✓ Reusable patterns from prior stories (2.1, 2.2)
✓ Performance targets and testing requirements
✓ Previous story learnings and anti-patterns
✓ Open clarifications for developer judgment
✓ Complete task breakdown with acceptance criteria mapping
✓ Project context and pilot-slice positioning

**Status:** review

**Next Step:** Code review via `code-review` workflow.

---

## File List

- read/projections/lot_master.sql
- read/projections/serial_master.sql
- read/projections/lot_trace.sql
- deploy/compose/init-db.sql
- src/events/migrate.ts
- src/read/projections/lot_master.ts
- src/read/projections/serial_master.ts
- src/read/projections/lot_trace.ts
- src/compliance/lot-serial-validation.ts
- src/api/v1/lots.ts
- test/integration/story-2-3.test.ts
- src/sync/upload.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- test/integration/story-1-9.test.ts
- test/unit/schema-drift.test.ts
