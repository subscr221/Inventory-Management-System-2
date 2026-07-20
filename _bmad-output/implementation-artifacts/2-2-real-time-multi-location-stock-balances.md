---
baseline_commit: c3547462f9ff58317a48df268d46b32b060ac27f
---

# Story 2.2: Real-Time Multi-Location Stock Balances

Status: review

## Story

As a stock controller,
I want to query on-hand, allocated, available, and in-transit stock balances per SKU per location and a consolidated view across all locations in under 1 second,
so that I can answer "what do we hold and where" without a phone call, at any moment.

## Acceptance Criteria

1. **Given** stock movement events have been posted for `sku: "RM-0042"` across three locations, **when** `GET /api/v1/stock/RM-0042` is called, **then** the response returns per-location balances (`on_hand`, `allocated`, `available`, `in_transit`) and a consolidated total, in under 1 second.
2. **Given** a stock allocation event reduces available balance, **when** the balance is queried immediately after, **then** available reflects the allocation, on-hand remains unchanged, and double allocation is blocked.
3. **Given** two concurrent writes attempt to allocate the last unit of a lot to two different orders, **when** both events are processed, **then** exactly one allocation succeeds and the second returns `error_code: "INSUFFICIENT_STOCK"`.
4. **Given** goods-receipt workflows do not yet exist, **when** an owned-stock receipt event referencing an open-PO line from the ERP inbound projection is posted directly via the stock-event API with `quantity`, `unit_cost`, `lot_id`, and location, **then** on-hand at the target location increases by the received quantity, the PO line reference is recorded on the event, and balances are reproducible from directly posted receipt events.

## Tasks / Subtasks

- [x] Task 1: Add the stock balance projection and helper module (AC: 1, 2, 3, 4)
  - [x] 1.1 Add `read/projections/stock_balance.sql` as the canonical projection DDL with `CREATE TABLE IF NOT EXISTS`, idempotent guarded constraints, indexes, and guarded grants for `app_user` and `readonly_user`.
  - [x] 1.2 Add a byte-for-byte-equivalent compose mirror in `deploy/compose/init-db.sql` and add the canonical file to `src/events/migrate.ts`.
  - [x] 1.3 Model the projection at SKU plus location grain with `on_hand`, `allocated`, `in_transit`, and an available quantity derived as `on_hand - allocated`.
  - [x] 1.4 Include fields that preserve downstream extensibility: `sku`, `location_id`, optional `location_code`, optional `lot_id`, optional `stock_class` defaulting to `owned`, and `updated_at`.
  - [x] 1.5 Create `src/read/projections/stock_balance.ts` with helper functions that accept an optional `PoolClient`, follow the existing `runner(client)` pattern, convert dates to ISO strings, and expose read and apply functions for receipt and allocation events.
  - [x] 1.6 Use row-level locking with `SELECT ... FOR UPDATE` or an equivalent transaction-local lock while applying an allocation so concurrent last-unit allocation has one winner.
  - [x] 1.7 Do not store domain state as mutable source-of-truth columns outside projections. Balances must be rebuildable from `stock.*` events.

- [x] Task 2: Add central stock-balance enforcement on the write path (AC: 2, 3, 4)
  - [x] 2.1 Add a narrow compliance seam such as `src/compliance/stock-balance.ts` and invoke it from `persistEvent()` in `src/events/store.ts` before the `domain_events` insert.
  - [x] 2.2 Gate enforcement to `stream_type: "inventory"` and stock balance event types only, such as `stock.received`, `stock.allocated`, and a future `stock.allocation_released` event. Non-stock streams must remain unaffected.
  - [x] 2.3 For allocation, validate the requested quantity is positive, the location and SKU references resolve through Story 2.1 masters, and available stock is sufficient before any event row or audit row is written.
  - [x] 2.4 Reject insufficient or duplicate allocation with `AppError(409, "INSUFFICIENT_STOCK", ...)` and include `sku`, `location_id`, `lot_id` when supplied, `requested_quantity`, and `available_quantity` in `details`.
  - [x] 2.5 Preserve existing `persistEvent()` behavior for `DUPLICATE_EVENT`, `STREAM_CONFLICT`, business-stream tagging, calibration lockout, inventory master checks, location invariant checks, and audit logging.
  - [x] 2.6 Apply the stock balance projection inside the same database transaction as the successful `stock.*` event insert so an event and its projection update commit or roll back together.
  - [x] 2.7 Ensure rejected allocations do not consume an idempotency key and do not write `domain_events`.
  - [x] 2.8 Ensure idempotent retry of a successful receipt or allocation returns `DUPLICATE_EVENT` and does not double-apply the balance change.

- [x] Task 3: Add stock query and direct stock-event API contracts (AC: 1, 4)
  - [x] 3.1 Add `src/api/v1/stock.ts` and register `GET /api/v1/stock/:sku` in `src/server.ts`.
  - [x] 3.2 Protect the query with `requireRole({ module: 'inventory', functionScope: 'read' })` and apply location scoping with `permittedLocationsForModule` so non-wildcard users see only authorized locations.
  - [x] 3.3 Return a response containing the requested `sku`, a `locations` array with each authorized location balance, and a `consolidated` object summing `on_hand`, `allocated`, `available`, and `in_transit`.
  - [x] 3.4 Sort per-location results deterministically by `location_code` when available, otherwise by `location_id`.
  - [x] 3.5 Keep the direct write path through existing `POST /api/v1/events` and `POST /api/v1/edge/events`; do not create a second private event ingestion path for stock events.
  - [x] 3.6 Define a minimal `stock.received` payload for AC4: `sku`, `target_location_id` or `target_location_code`, `quantity`, `unit_cost`, `lot_id`, `po_line_ref`, `stock_class: "owned"`, `business_stream`, and optional `cost_centre` or `project_code` when tagging rules require them.
  - [x] 3.7 Define a minimal `stock.allocated` payload for AC2 and AC3: `sku`, `target_location_id` or `target_location_code`, `quantity`, optional `lot_id`, `allocation_ref`, `business_stream`, and optional `cost_centre` or `project_code` when tagging rules require them.
  - [x] 3.8 Keep `available` computed from projection quantities, not accepted from client payloads.

- [x] Task 4: Wire schema, route, sync, and migration guardrails (AC: 1, 2, 3, 4)
  - [x] 4.1 Extend `test/unit/schema-drift.test.ts` to guard `stock_balance` canonical SQL, compose mirror SQL, constraints, indexes, and grants.
  - [x] 4.2 Update `test/integration/story-1-9.test.ts` route-surface allowlist with `GET /api/v1/stock/:sku` only if that route is added.
  - [x] 4.3 Review integration test harness setup and truncation lists for `stock_balance`, using `CASCADE` where foreign-key relationships require it.
  - [x] 4.4 If `INSUFFICIENT_STOCK` should be displayed as a named edge sync failure, add it to `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`. The current 4xx classification already moves it to `needs_attention`, but the explicit code improves user-facing copy.
  - [x] 4.5 Do not change PowerSync download rules unless the implementation intentionally exposes stock balances on the edge client. The central projection remains server-side for this story.

- [x] Task 5: Add complete test coverage and preserve previous behavior (AC: 1, 2, 3, 4)
  - [x] 5.1 Add `test/integration/story-2-2.test.ts` against the real `createAppRouter()` with real auth, RBAC, SCIM provisioning, and PostgreSQL.
  - [x] 5.2 Cover receipt events across three locations and assert `GET /api/v1/stock/RM-0042` returns per-location and consolidated balances in under 1 second.
  - [x] 5.3 Cover allocation reducing `available` while leaving `on_hand` unchanged.
  - [x] 5.4 Cover double allocation and prove the rejected write returns `INSUFFICIENT_STOCK` before any domain event is inserted.
  - [x] 5.5 Cover two overlapping transactions or an equivalent deterministic concurrency harness for last-unit allocation. Do not rely on the test runner to execute tests in parallel because `npm test` uses `--test-concurrency=1`.
  - [x] 5.6 Cover idempotent retry for receipt and allocation: the duplicate returns `DUPLICATE_EVENT` and the projection changes only once.
  - [x] 5.7 Cover location-scoped read access and wildcard read access.
  - [x] 5.8 Cover owned receipt with `unit_cost`, `lot_id`, and `po_line_ref` recorded on the event even though GRN workflows are not yet present.
  - [x] 5.9 Run `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run spine-acceptance-contract`, and `git diff --check` before moving this story beyond implementation.

## Dev Notes

### Epic Context

Epic 2 makes the inventory ledger the transactional foundation for answering what stock is held, where it is held, and what it is worth across all locations. Story 2.2 is the first stock ledger story after Story 2.1's item and location masters. It provides the balance projection consumed by later Epic 2 stories for lot traceability, valuation, transfers, cycle counting, safety stock, consignment segregation, and ERP inbound projections. [Source: `_bmad-output/planning-artifacts/epics.md` lines 909-963]

Story 2.2 implements FR-I-01 only. The binding performance number is the story's under-1-second single-SKU stock query budget. PRD open question 5 about "real-time" remains broader feed terminology and must not weaken this story's query target. [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` lines 100-115 and 455-527]

### Architecture Compliance

- The stock balance must be a shared PostgreSQL read model under `read/projections/`, not a private module table and not a direct query over another module's event stream. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 24-33 and 148-152]
- Use event-sourced, append-only inventory events with the existing event envelope. Event names are dot-separated and past tense, for example `stock.received` and `stock.allocated`. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 172-188 and 278-297]
- Every event that can originate from edge devices needs an `idempotency_key`; duplicate submission returns HTTP 409 with the existing event ID and stock balance updates exactly once. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 160-164]
- Use the uniform API error envelope `{ error_code, message, details, trace_id }`; `INSUFFICIENT_STOCK` is already a stable architecture error code. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 328-337]
- The stock balance projection is derived state only. Current state is a projection; source-of-truth mutation happens only through events. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 182-184]
- The implementation must be compatible with Node.js 24, PostgreSQL 18.4, TypeScript 5.x, and existing `pg` usage. Do not add a dependency for this story. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 190-205; `package.json` lines 6-42]

### Current Code State and Required Update Files

The following file list identifies the existing files the dev agent must read before editing, with current behavior and preservation requirements.

- `src/events/store.ts`: `persistEvent()` validates envelope invariants upstream, runs business-stream tagging, calibration lockout, and Story 2.1 inventory-master validation before opening or joining the event transaction, then inserts into `domain_events`, applies the Story 1.6 location invariant, writes audit, and maps `DUPLICATE_EVENT` and `STREAM_CONFLICT`. Add stock-balance enforcement and projection application without changing these behaviors for non-stock writes. [Source: `src/events/store.ts` lines 148-277]
- `src/compliance/inventory-master.ts`: central inventory master validation is already gated to `stream_type: "inventory"` and payloads with `sku`, `target_location_id`, or `target_location_code`. Reuse these field names in stock event payloads so SKU, location, active status, actor-location, and zone checks are inherited. [Source: `src/compliance/inventory-master.ts` lines 115-199]
- `src/api/v1/events.ts`: public event writes stamp actor identity and authorized location from auth before calling `persistEvent()`, then translate `ZoneIncompatibleWarning` to a warning envelope. Keep stock writes on this path. [Source: `src/api/v1/events.ts` lines 42-113]
- `src/api/v1/edge.ts`: edge uploads stamp actor identity from the authorized edge assignment, auto-confirm zone-incompatible placements, and call `persistEvent()`. Stock enforcement must happen in `persistEvent()` so edge uploads cannot bypass it. [Source: `src/api/v1/edge.ts` lines 125-163]
- `src/server.ts`: route registration is centralized in `createAppRouter()`. Add `GET /api/v1/stock/:sku` there and update route-surface tests. [Source: `src/server.ts` lines 50-99]
- `src/events/migrate.ts`: migrations use a fixed ordered list. Append `../../read/projections/stock_balance.sql` after existing inventory projections. [Source: `src/events/migrate.ts` lines 8-17]
- `deploy/compose/init-db.sql`: compose first boot mirrors canonical projection SQL. Add the stock balance table, constraints, indexes, and guarded grants here when adding canonical SQL. [Source: `test/unit/schema-drift.test.ts` lines 55-77]
- `test/unit/schema-drift.test.ts`: currently guards Story 2.1 projection schema drift. Add stock balance to `EXPECTED`. [Source: `test/unit/schema-drift.test.ts` lines 35-79]
- `test/integration/story-1-9.test.ts`: exact production route surface is asserted. Add `GET /api/v1/stock/:sku` when the route lands; do not add stock balance to the five spine invariants. [Source: `test/integration/story-1-9.test.ts` lines 151-193]
- `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`: 4xx errors already classify as `needs_attention`; explicitly adding `INSUFFICIENT_STOCK` gives the edge shell a clearer localized message. [Source: `src/sync/upload.ts` lines 17-77; `edge/src/sync/connector.ts` lines 22-87; `edge/src/messages/en.json` lines 30-36]

### Reuse Patterns from Story 2.1

- Projection helpers must mirror `src/read/projections/item_master.ts` and `src/read/projections/location_register.ts`: use an optional `PoolClient`, a local `runner(client)`, stable row mapping, and typed input and output interfaces. [Source: `src/read/projections/item_master.ts` lines 58-151; `src/read/projections/location_register.ts` lines 61-213]
- Canonical SQL must mirror Story 2.1 style: each file is self-sufficient, idempotent, and carries guarded grants. Do not repeat the old split-brain migration anti-pattern where compose init has grants but canonical migrations do not. [Source: `read/projections/item_master.sql` lines 1-61; `read/projections/location_register.sql` lines 1-83]
- API write handlers that create owned rows and domain events use a caller-owned transaction with projection row write, `persistEvent()`, audit, and commit or rollback together. [Source: `src/api/v1/items.ts` lines 149-180]
- Use authenticated context for actor identity. Never trust request-body actor fields for audited user, role, or location on HTTP routes. [Source: `src/api/v1/events.ts` lines 46-62]
- Use distinct fixture role strings in tests. Business roles and module-access roles share the role assignment projection, and careless reuse caused earlier false authorization behavior. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 81-86]

### Stock Balance Semantics

- `stock.received` increases `on_hand` at the target location and records receipt details on the event payload.
- `stock.allocated` increases `allocated` and reduces `available`; it must not change `on_hand`.
- `available` is calculated as `on_hand - allocated`; clients must never post an `available` value.
- `in_transit` stays unchanged by allocation. Story 2.5 will move stock into in-transit only when a ship event posts. [Source: `_bmad-output/planning-artifacts/epics.md` lines 1053-1063]
- `lot_id` is accepted and preserved for Story 2.2 isolation, but Story 2.3 owns full lot, batch, and serial validation. Do not implement full lot master or trace endpoints here. [Source: `_bmad-output/planning-artifacts/epics.md` lines 967-1003]
- `unit_cost` is accepted and preserved on receipt events for Story 2.4 valuation, but Story 2.4 owns weighted-average, FIFO, specific-identification costing, NRV, and valuation query endpoints. Do not implement valuation math here. [Source: `_bmad-output/planning-artifacts/epics.md` lines 1007-1039]
- `po_line_ref` is accepted as an external reference for AC4. Story 2.9 owns the read-only ERP inbound reference projection; do not build native PO creation or GRN workflows in this story. [Source: `_bmad-output/planning-artifacts/epics.md` lines 961-963]

### UX and Edge Requirements

Story 2.2 is primarily backend and API work. If any stock visibility UI is added, it must live under the Inventory navigation group as Stock Visibility, use the internal React and TailwindCSS design system, and avoid external design-system dependencies. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 28-31 and 115-124]

If no stock results match the user's query or filters, use the established no-search-results pattern: keep filters visible, show "No matches for '[search term]'.", suggest shorter search, removing filters, or scanning the barcode, and provide clear actions. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 1211-1224]

Any edge-facing stock failure must surface as actionable text through i18n keys. `INSUFFICIENT_STOCK` should not be a raw code shown to users when an edge message catalog entry can be added. [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 149-158; `edge/src/messages/en.json` lines 30-36]

### Previous Story Intelligence

Story 2.1 finished with 187 backend tests, spine gate 6 of 6, TypeScript, ESLint, build, and diff-check clean. It established item and location master APIs, central master validation, route-surface updates, schema drift guards, and regression repairs. Story 2.2 must preserve those exact paths and behavior. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` lines 51-63]

Important Story 2.1 learnings:

- Central validators can break older integration harnesses that post inventory events. Before the full test run, review earlier suites that post `stock.*` or `inventory` events and seed item/location fixtures where the new stock balance seam requires them. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 180-183]
- Route additions require route-surface allowlist updates, but stock balance must not become a new spine invariant. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 196-197]
- Edge uploads auto-confirm zone-incompatible placements because outbox rows cannot sync a warning that did not persist. Preserve that decision while adding stock checks. A rejected insufficient allocation should settle as `needs_attention`, not as a silently successful sync. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 231-235]
- Inactive items, inactive locations, inactive actor locations, and inactive topology parents are rejected. Stock events must not bypass those checks. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 233-239]
- Redundant secondary indexes duplicating unique constraints were removed during review. Do not add redundant indexes on `sku` or `location_code`; add only indexes required by stock query and concurrency behavior. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 236-240]

Recent git history confirms Story 2.1 was finalized in commits `7bdce10`, `00ea6f2`, and `c354746`, with final validation and error handling for item and location management. Reuse those patterns instead of inventing a parallel stock architecture. [Source: `git log --oneline -5`]

### Testing Requirements

- Integration tests require the PostgreSQL container and run serially using `--test-concurrency=1`. [Source: `package.json` lines 13-15]
- Use `createAppRouter()` and real auth, RBAC, SCIM user provisioning, and database migrations. Do not mock the router or authorization layer for acceptance coverage.
- Include `stock_balance` in test setup and truncation lists. Disable and re-enable audit triggers around truncation when following existing integration harness patterns.
- The performance assertion for the single-SKU stock query should measure the request or query path and assert it completes below 1 second with test data at three locations.
- Concurrency coverage must coordinate overlapping allocation attempts deliberately because the test runner is serial. Use two database clients, a barrier, or controlled promises to make the last-unit race deterministic.
- The full verification battery before completion is `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run spine-acceptance-contract`, and `git diff --check`. [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 180-183]

### Anti-Patterns to Avoid

- Do not build stock balances by replaying the event stream on every GET request. The story requires a projection query under 1 second.
- Do not validate allocation only in `src/api/v1/stock.ts` or `src/api/v1/events.ts`. Enforcement belongs in the central write path so edge uploads and future adapters are covered.
- Do not let an insufficient allocation write an event and repair it later. It must fail before event insert.
- Do not implement GRN receiving, native PO management, inter-location transfer shipping, lot trace endpoints, or valuation endpoints in this story.
- Do not add new npm dependencies.
- Do not mutate Story 1.6's `location_current`, `location_asserted_facts`, or `location_expected_facts` projections for stock balance purposes.
- Do not create a second business-stream vocabulary or hard-code business-stream values.
- Do not claim completion unless every AC has passing integration coverage and the full verification battery is green.

### Open Clarifications Saved for Dev Judgment

- Story 2.9's open-PO projection does not exist yet, but AC4 names it as a reference. For Story 2.2, treat `po_line_ref` as an opaque external reference recorded on `stock.received`; do not block on a missing Story 2.9 table unless implementation discovers an existing projection.
- The stock event API is not separately specified. Use existing `POST /api/v1/events` and `POST /api/v1/edge/events` for writes unless a minimal helper route is strictly necessary.
- If a `stock_balance` projection is keyed by lot from the start, still return the Story 2.2 response aggregated per SKU and location for AC1.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` lines 909-963]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` lines 100-115 and 455-527]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 24-33, 148-164, 172-188, 190-205, 278-297, and 328-337]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` lines 28-31, 115-124, 149-158, and 1211-1224]
- [Source: `_bmad-output/implementation-artifacts/2-1-item-master-and-location-register.md` lines 72-240]
- [Source: `src/events/store.ts` lines 148-277]
- [Source: `src/compliance/inventory-master.ts` lines 115-199]
- [Source: `src/api/v1/events.ts` lines 42-155]
- [Source: `src/api/v1/edge.ts` lines 125-172]
- [Source: `src/server.ts` lines 50-99]
- [Source: `src/events/migrate.ts` lines 8-17]
- [Source: `test/unit/schema-drift.test.ts` lines 35-79]
- [Source: `test/integration/story-1-9.test.ts` lines 151-193]
- [Source: `package.json` lines 6-42]

## Dev Agent Record

### Agent Model Used

- Story creation: fugu-ultra-20260615
- Implementation (dev-story): claude-fable-5

### Debug Log References

- `npx tsc --noEmit`: clean (backend and test sources).
- `npm run lint`: clean.
- `npm run build`: clean.
- `npm test`: 209/209 pass (187 pre-story plus 22 new: 11 story-2-2 integration, 10 stock-balance seam unit, 1 extended schema-drift guard).
- `npm run spine-acceptance-contract`: 6/6 pass with `GET /api/v1/stock/:sku` added to the route-surface allowlist.
- `git diff --check`: clean.
- Edge workspace after `INSUFFICIENT_STOCK` classification change: `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test` (14/14) all clean.
- `node --env-file=.env.test --import tsx src/events/migrate.ts`: full ordered migration list applies cleanly including `read/projections/stock_balance.sql` (UNIQUE NULLS NOT DISTINCT and the generated `available` column verified on PostgreSQL 18.4).

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Activation workflow resolved successfully. No activation prepend or append steps were configured.
- Persistent facts glob `**/project-context.md` matched no files in this workspace.
- Artifact discovery loaded sprint status, epics, PRD archive, architecture spine, UX design and experience specs, previous Story 2.1, current code update seams, package scripts, and recent git history.
- Web research was not required: the story uses the repository's pinned Node.js, TypeScript, PostgreSQL, `pg`, and existing edge sync stack with no new library.
- Implementation plan executed as designed. Projection grain is `(sku, location_id, lot_id)` with `UNIQUE NULLS NOT DISTINCT` so un-lotted stock holds one row per sku and location while lots stay isolated (AC3 names "the last unit of a lot"); the stock query aggregates rows per location for the AC1 response. `available` is a database-generated column (`on_hand - allocated`), so it is structurally impossible to post or drift.
- Seam gating decision: enforcement fires only for `inventory` stream `stock.received`/`stock.allocated` events whose payload carries BOTH `sku` and a target location. This mirrors the Story 2.1 master seam and is what preserves the Story 1.1 fixtures (sku without location, expects 201) and the Story 1.9 spine events (no refs at all) byte-for-byte. A dedicated regression test plus a seam unit test pin this behavior.
- `assertStockBalanceShape` runs pre-transaction beside the other compliance asserts (malformed stock events consume nothing); `applyStockBalanceProjection` runs inside the event transaction BEFORE the `domain_events` insert, locking balance rows with `SELECT ... FOR UPDATE` and re-checking availability under the lock. A shortfall throws `AppError(409, "INSUFFICIENT_STOCK")` with `sku`, `location_id`, `lot_id` when supplied, `requested_quantity`, and `available_quantity`; rollback means no event row, no audit row, and no consumed idempotency key. A `DUPLICATE_EVENT` retry rolls the re-applied balance back, so the projection changes exactly once per event.
- Concurrency proof is deterministic (Task 5.5): two explicit transactions on two pool clients; the test asserts the second allocation is still pending while the first holds the row lock, then asserts it rejects with `INSUFFICIENT_STOCK` and `available_quantity: 0` after the first commits. Exactly one `stock.allocated` event persists for the contested lot.
- `stock.allocation_released` is documented in the seam as reserved and intentionally not accepted yet; nothing in the ACs requires it and accepting an unapplied event type would corrupt balances.
- Edge path enforcement is inherited by construction (persistEvent), proven by an edge-upload test; `INSUFFICIENT_STOCK` was also added to both PERMANENT_ERROR_CODES sets and the edge message catalog so the failure lands as an actionable `needs_attention` message instead of a raw code.
- No new dependencies. No PowerSync download-rule changes (the projection stays server-side). Story 1.6 location projections untouched.

### File List

- `read/projections/stock_balance.sql` (new - canonical stock balance projection DDL with guarded constraints and grants)
- `src/read/projections/stock_balance.ts` (new - projection helpers: read, receipt upsert, locked allocation apply)
- `src/compliance/stock-balance.ts` (new - central seam: shape assert plus in-transaction projection apply)
- `src/api/v1/stock.ts` (new - `GET /api/v1/stock/:sku` with RBAC and location scoping)
- `test/unit/stock-balance.test.ts` (new - seam gating and shape validation unit tests)
- `test/integration/story-2-2.test.ts` (new - 11-test acceptance suite against the production router)
- `deploy/compose/init-db.sql` (modified - byte-identical stock_balance mirror appended)
- `src/events/migrate.ts` (modified - stock_balance.sql appended to the ordered migration list)
- `src/events/store.ts` (modified - stock shape assert pre-transaction; projection applied inside the event transaction before insert)
- `src/server.ts` (modified - stock route registered in `createAppRouter()`)
- `src/sync/upload.ts` (modified - INSUFFICIENT_STOCK added to permanent error codes)
- `edge/src/sync/connector.ts` (modified - INSUFFICIENT_STOCK added to permanent error codes)
- `edge/src/messages/en.json` (modified - localized INSUFFICIENT_STOCK message)
- `test/unit/schema-drift.test.ts` (modified - stock_balance added to the drift guard EXPECTED list)
- `test/integration/story-1-9.test.ts` (modified - route-surface allowlist gains `GET /api/v1/stock/:sku`)
- `_bmad-output/implementation-artifacts/2-2-real-time-multi-location-stock-balances.md` (modified - tasks, record, status)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified - tracking status)

## Change Log

- 2026-07-21: Created Story 2.2 as ready-for-dev with stock-balance projection, central allocation enforcement, stock query API, direct receipt event, concurrency, edge sync, schema drift, and regression guardrails.
- 2026-07-21: Implemented all 5 tasks from baseline `c354746`: stock_balance projection (canonical SQL, compose mirror, migration entry, helpers), central enforcement in `persistEvent()` (in-transaction apply with row locks, 409 INSUFFICIENT_STOCK before event insert), `GET /api/v1/stock/:sku` with location scoping, edge sync classification and i18n, schema-drift and route-surface guardrails, and a deterministic last-unit concurrency proof. Verification: tsc, ESLint, build, 209/209 tests, spine gate 6/6, edge checks 14/14, migrations, and `git diff --check` all clean. Status moved to review.
