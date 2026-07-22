---
baseline_commit: 8f5c3eb7a7ce2554263d97fb763d343155e4dad3
---
# Story 2.9: ERP Inbound Reference Projections

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a stock controller or planner,
I want read-only projections of ERP open purchase orders (headers and lines with quantity, price, and receipt-tolerance fields) and open sales orders (dispatch demand) synced into the platform on a defined freshness cadence,
So that receiving, replenishment, job-work, and dispatch flows have a defined Phase-1 source for PO reference data and outbound demand while ERP remains the master (INT-ERP-01) and order management (Epic 15) does not yet exist.

Covers INT-ERP-01 (reference projections; ERP remains master). This story closes Epic 2. Consumed by FR-W-02 receiving against PO (Epic 3), FR-I-03 replenishment context (Story 2.7), the Phase-1 outbound-demand source (Epics 3, 9, 11), and three-way-match inputs (Epic 4). [Source: _bmad-output/planning-artifacts/epics.md:1169-1199]

## Acceptance Criteria

1. **Given** ERP holds open purchase order `PO-2026-0042` with two lines, each carrying ordered quantity, unit price, and over/under-receipt tolerance percentages
   **When** the inbound sync runs
   **Then** `GET /api/v1/erp/purchase-orders/PO-2026-0042` returns a read-only projection with header fields (supplier reference, currency, expected delivery date) and per-line `sku`, `ordered_qty`, `open_qty`, `unit_price`, `over_receipt_tolerance_pct`, `under_receipt_tolerance_pct`, each stamped `source_system: "ERP"` with a `last_synced_at` timestamp

2. **Given** ERP holds open sales orders with required-by dates and ship-from sites
   **When** `GET /api/v1/erp/sales-orders?site=site-A&status=open` is called
   **Then** the response lists dispatch-demand lines (`sku`, `quantity`, `required_by`, `ship_to`) - the Phase-1 outbound-demand source referenced by pick, dispatch, and IRN flows (Epics 3, 9, 11)

3. **Given** the inbound sync has not completed within the configured freshness threshold (default 15 minutes)
   **When** any projection is queried
   **Then** the response carries `stale: true` with the age of `last_synced_at`, and a sync-failure alert is raised to the integration exception queue

4. **Given** a client attempts to create, update, or delete a purchase-order or sales-order projection through the platform API
   **When** the write is processed
   **Then** it is rejected with `error_code: "SOURCE_SYSTEM_READ_ONLY"` - corrections are made in ERP and arrive on the next sync

5. **Given** a sync batch contains a malformed record (e.g. a PO line referencing an unknown SKU)
   **When** the batch is processed
   **Then** the malformed record is routed to the integration exception queue with the standard error envelope (stable `error_code`, source record reference, reason), and the remaining records in the batch sync successfully - no batch-level abort

**Note (reference data, not a procurement module):** These projections are reference data only - ERP remains the master for PO and sales-order lifecycle (INT-ERP-01). Nothing in this platform mutates PO or sales-order state; receipts recorded against a projected PO line (Story 2.2, Epics 3-4) never write back to the projection. Epic 4 builds procurement workflows on top of these projections; Epics 3, 9, and 11 reference this story for PO data and dispatch-order demand. [Source: _bmad-output/planning-artifacts/epics.md:1199]

## Tasks / Subtasks

- [x] Task 1: ERP projection read models and integration exception queue (AC: 1, 2, 5)
  - [x] 1.1 Create `read/projections/erp_purchase_order.sql`: two idempotent tables. `erp_purchase_order` header at grain `po_number_ext` (TEXT PK - the ERP-external PO reference, `_ext`-suffixed per the architecture ID convention) with `supplier_ref_ext TEXT NOT NULL`, `currency TEXT NOT NULL`, `expected_delivery_date DATE`, `status TEXT NOT NULL DEFAULT 'open'`, `source_system TEXT NOT NULL DEFAULT 'ERP'`, `last_synced_at TIMESTAMPTZ NOT NULL`, `source_snapshot JSONB`, timestamps. `erp_purchase_order_line` at grain `(po_number_ext, line_no)` with `sku TEXT NOT NULL`, `ordered_qty NUMERIC(18,3) NOT NULL`, `open_qty NUMERIC(18,3) NOT NULL`, `unit_price NUMERIC(18,4) NOT NULL`, `over_receipt_tolerance_pct NUMERIC(9,3)`, `under_receipt_tolerance_pct NUMERIC(9,3)`, `source_system`, `last_synced_at`, FK-by-convention to the header (no hard FK - the adapter owns referential order, mirror the read-model style). Add CHECK constraints: `chk_erp_po_line_ordered_non_negative`, `chk_erp_po_line_open_within_ordered` (`open_qty >= 0 AND open_qty <= ordered_qty`), `chk_erp_po_line_unit_price_non_negative`, `chk_erp_po_line_tolerance_non_negative` (each pct NULL or `>= 0`; do NOT cap at 100 because valid ERP over-receipt tolerances may exceed 100%), `chk_erp_purchase_order_status` (`status IN ('open','closed')`), `chk_erp_purchase_order_source_system` (`source_system = 'ERP'`). Guarded grants in idempotent `DO $$` blocks matching every other projection file (`INSERT, SELECT, UPDATE` for `app_user`; `SELECT` for `readonly_user`; no DELETE because close/removal is soft).
  - [x] 1.2 Create `read/projections/erp_sales_order.sql`: `erp_sales_order` line-grain projection at `(so_number_ext, line_no)` with `sku TEXT NOT NULL`, `quantity NUMERIC(18,3) NOT NULL`, `required_by DATE`, `ship_to_ext TEXT`, `ship_from_site_id UUID NOT NULL` (the internal `location_register.location_id` used for RBAC), `ship_from_site_code_ext TEXT NOT NULL` (the ERP/human-facing site code used by `?site=site-A`), `status TEXT NOT NULL DEFAULT 'open'`, `source_system TEXT NOT NULL DEFAULT 'ERP'`, `last_synced_at TIMESTAMPTZ NOT NULL`, `source_snapshot JSONB`, timestamps. The adapter resolves `ship_from_site_code_ext` through `getLocationByCode`, requires an active `level = 'site'` row, and persists its UUID as `ship_from_site_id`; an unknown or non-site code is a malformed record routed to the exception queue. CHECK: `chk_erp_so_quantity_non_negative`, `chk_erp_sales_order_status`, `chk_erp_sales_order_source_system`. Index on `(ship_from_site_id, status)` and `(ship_from_site_code_ext, status)` for RBAC and AC2 filtering. Guarded grants as in 1.1.
  - [x] 1.3 Create `read/projections/integration_exception.sql` with two operational integration tables. `erp_sync_state` has one row per `projection_name` (`purchase_orders` or `sales_orders`) with `last_attempted_at`, `last_successful_at`, `status` (`never_synced` | `success` | `failed`), and `last_error`; this heartbeat makes AC3 observable even when a projection has zero rows. `integration_exception` is the append-plus-resolve queue (`exception_id UUID PK DEFAULT gen_random_uuid()`, `source_system TEXT NOT NULL DEFAULT 'ERP'`, `record_type TEXT NOT NULL` (`purchase_order` | `sales_order` | `sync_batch`), `source_record_ref TEXT` (the PO/SO/line reference), `error_code TEXT NOT NULL`, `reason TEXT NOT NULL`, `details JSONB`, `status TEXT NOT NULL DEFAULT 'open'` (`open` | `resolved`), `raised_at TIMESTAMPTZ NOT NULL DEFAULT now()`, timestamps). Partial unique index `uq_integration_exception_open` on `(source_system, record_type, source_record_ref, error_code) WHERE status = 'open'` so a repeated malformed record or repeated stale-sync failure never stacks duplicate open rows (AC3/AC5 dedupe). Grants: `INSERT, SELECT, UPDATE` for `app_user` (sync heartbeat + exception resolution), `SELECT` for `readonly_user`. See the Data Integrity Guardrails section for the ON CONFLICT dedupe contract.
  - [x] 1.4 Register all three SQL files in `src/events/migrate.ts` MIGRATIONS array (append after `ownership_agreement.sql`); mirror each block BYTE-FOR-BYTE into `deploy/compose/init-db.sql` WITHOUT touching the `powersync_publication` block; add all five tables to `test/unit/schema-drift.test.ts` EXPECTED list with their constraints, indexes, and grant expectations.
- [x] Task 2: Read-model TypeScript accessors (AC: 1, 2, 3)
  - [x] 2.1 Create `src/read/projections/erp_purchase_order.ts` mirroring `src/read/projections/ownership_agreement.ts` structure (`runner(client)`, `COLUMNS` const, `mapRow`, `ts()`): `getPurchaseOrderByRef(poNumberExt, client?)` returning header plus lines (single-header, multi-line assembly), and an `upsertPurchaseOrderHeader` / `upsertPurchaseOrderLine` pair used ONLY by the adapter sync (direct SQL upsert - these projections are NOT event-sourced). Numeric columns map through `Number(...)` guarded for null; never compare or round in JS.
  - [x] 2.2 Create `src/read/projections/erp_sales_order.ts`: `listSalesOrders({ ship_from_site_code_ext, status, location_any }, client?)` with the dynamic param-indexed filter builder pattern from `listAgreements` (src/read/projections/ownership_agreement.ts:110-140). `location_any` filters `ship_from_site_id` UUIDs from RBAC while `ship_from_site_code_ext` honors the public `?site=site-A` contract; both predicates must apply when present. Add `upsertSalesOrderLine` for adapter use only.
  - [x] 2.3 Create `src/read/projections/integration_exception.ts`: `markSyncAttempt`, `markSyncSuccess`, and `markSyncFailure` helpers for `erp_sync_state`; `getSyncState(projectionName)` for zero-row-aware freshness; `raiseException(input, client?)` performing the dedupe upsert (ON CONFLICT on the open partial-unique grain, DO NOTHING or refresh `details`/`raised_at`); plus `listExceptions(filters)` and `resolveException(id)`.
- [x] Task 3: ERP inbound sync adapter (AC: 1, 2, 3, 5)
  - [x] 3.1 Create `src/adapters/erp/sync.ts` - the new inbound seam. It accepts a batch of source PO and SO records (in-process function; the live ERP transport is per-deployment configuration and out of scope, mirror the Story 3.x adapter-boundary note). It uses the system-actor convention from `src/adapters/iam/scim.ts:22-64` (`SYSTEM_ACTOR_ID`, role `system`, location `*`) for any audit context.
  - [x] 3.2 Per-record isolation (AC5): each PO (header plus its lines) and each SO line is validated and upserted in its OWN transaction wrapped in a SAVEPOINT so one malformed record's rollback cannot discard a good record and a good record is never left half-applied. Validate `sku` against `item_master` (`getItemBySku`), `site`/`ship_to` shape, numeric bounds, and local `YYYY-MM-DD` dates (reuse the `isLocalDate` pattern from src/compliance/inventory-planning.ts:80-85). A failing record is routed to `integration_exception` with `error_code` (e.g. `ITEM_NOT_FOUND`, `INVALID_PARAMS`), the source record reference, and reason; the batch continues - NO batch-level abort.
  - [x] 3.3 Every upserted row stamps `source_system = 'ERP'` (server-set, never from the source payload) and `last_synced_at = now()`, and records the raw source record in `source_snapshot` so an exception can cite the exact source record and the row is reproducible.
  - [x] 3.4 Close/removal semantics: a PO or SO that is no longer in the open feed is marked `status = 'closed'` on the next sync (soft-flag, NOT hard-delete) so downstream receipts referencing it still resolve; ERP remains PO/SO system of record. Record this decision in the Dev Agent Record.
  - [x] 3.5 Sync heartbeat and failure alert (AC3): mark each projection `last_attempted_at` before processing and `last_successful_at` only after its batch completes; mark `failed` with `last_error` on cycle failure. When a sync cycle fails OR the projection heartbeat exceeds the freshness threshold (including `never_synced` with zero rows), raise ONE `integration_exception` row (`record_type = 'sync_batch'`, `error_code = 'ERP_SYNC_STALE'`) through the dedupe path, and emit a non-blocking planner/ops notification via `emitNotification` (src/notify/emit.ts) - NOT `emitNotificationInTransaction` (a sync-freshness alert is not part of a business write). The alert must not re-raise while an open one exists, and a successful in-threshold sync resolves it. A stale GET intentionally performs this deduped operational write; document that exception to the normal read-only handler expectation.
  - [x] 3.6 Add a Phase-1 synthetic POST trigger endpoint `POST /api/v1/erp/sync` (mirrors the 2.7 planning-jobs synthetic-trigger pattern) that accepts a batch payload and drives `runErpSync`. Wrap with `requireRole({ module: 'inventory', functionScope: 'write' })`, then require an authorizing role of `svc_erp_adapter` or `system_administrator`; a normal inventory writer is denied `FUNCTION_ACCESS_DENIED`. This is the test and manual driver; live scheduled transport is per-deployment.
- [x] Task 4: ERP projection read API and read-only enforcement (AC: 1, 2, 3, 4)
  - [x] 4.1 Create `src/api/v1/erp-projections.ts` mirroring `src/api/v1/stock.ts` / `ownership-agreements.ts`: `getPurchaseOrderHandler` (`GET /api/v1/erp/purchase-orders/:poNumber`) returns header plus lines with all AC1 fields; `listSalesOrdersHandler` (`GET /api/v1/erp/sales-orders`) honors `?site=` and `?status=open` querystring filters. Both wrapped with `requireRole({ module: 'inventory', functionScope: 'read' })`. Validate path/query params with regex (reuse `SKU_REGEX`-style guards); resolve the `site` code through `location_register`, require active `level = 'site'`, then intersect its UUID with `permittedLocationsForModule`. Unknown/invalid site returns 400 `INVALID_PARAMS`; an existing site outside the caller's assignments returns 403 `LOCATION_ACCESS_DENIED`. Unknown PO ref returns 404 `NOT_FOUND`; empty SO list returns `[]` not 404.
  - [x] 4.2 Staleness metadata (AC3): every read response carries `stale` (boolean) and `last_synced_at_age_seconds`, computed in SQL from `erp_sync_state.last_successful_at` as `now() - last_successful_at` compared against the configured threshold (strict `>` is stale), NEVER against the JS wall clock (recurring DATE/clock-source defect class). `never_synced` or missing heartbeat is stale with `last_synced_at_age_seconds: null`, including an empty projection; do not hide a never-synced feed behind a normal empty array. A response served while stale triggers the AC3 alert path (Task 3.5) through the dedupe guard so repeated stale reads raise exactly one open alert.
  - [x] 4.3 Read-only enforcement (AC4): register explicit write-method handlers - `POST`/`PUT`/`PATCH`/`DELETE` on `/api/v1/erp/purchase-orders/:poNumber` and `/api/v1/erp/sales-orders` (and the `:poNumber`-less collection paths) - that throw `AppError(405, 'SOURCE_SYSTEM_READ_ONLY', ...)`. Reason: the router 404s unregistered methods, so an explicit handler is required to return the specified stable code. Cover every write verb, not just POST.
  - [x] 4.4 Central bypass guard (AC4): add a guard in `persistEvent` (src/events/store.ts, alongside the other pre-transaction asserts) that rejects any envelope whose `stream_type` is `erp` or whose `event_type` begins with `erp.` with `SOURCE_SYSTEM_READ_ONLY`, so a direct `POST /api/v1/events` or an edge upload cannot fabricate ERP reference rows. Gate narrowly so every existing stream passes through byte-for-byte and the Story 1.9 spine gate stays green (mirror the `tagging.enforcement_location` central-write-path decision). The adapter sync writes projections by direct SQL upsert (never through `persistEvent`), so it is unaffected.
  - [x] 4.5 Register all new routes in `src/server.ts` and add the exact route strings to the Story 1.9 spine route-surface allowlist in `test/integration/story-1-9.test.ts` (route-drift guard fails otherwise).
- [x] Task 5: Configuration (AC: 3)
  - [x] 5.1 Add an `erp` config block in `src/config/index.ts` using `parsePositiveIntEnv`: `erp.freshnessMs` from `ERP_SYNC_FRESHNESS_MS` defaulting to `900000` (15 minutes per AC3). Document `ERP_SYNC_FRESHNESS_MS` in `.env.example` (append after the PowerSync block) and `.env.test`.
- [x] Task 6: Stable errors, edge sync, i18n (AC: 4, 5)
  - [x] 6.1 New stable codes: `SOURCE_SYSTEM_READ_ONLY` (405) and `ERP_SYNC_STALE` (internal alert code). Add `SOURCE_SYSTEM_READ_ONLY` to backend `PERMANENT_ERROR_CODES` in `src/sync/upload.ts:17-62` AND `edge/src/sync/connector.ts` (settle as `needs_attention`, never halt the outbox) AND `edge/src/messages/en.json`, with tests in `test/unit/sync-upload.test.ts` and `edge/test/unit/connector.test.ts` - all four surfaces in one change (the recurring four-surface discipline).
  - [x] 6.2 Register `SOURCE_SYSTEM_READ_ONLY` in the architecture stable-error list note for the Dev Agent Record (the architecture doc has no ERP row yet).
- [x] Task 7: Story 2.8 owner-party referential tightening (additive - do not break 2.8)
  - [x] 7.1 Story 2.8 explicitly deferred owner-party referential validation to this story [Source: _bmad-output/implementation-artifacts/2-8-consignment-and-vmi-stock-segregation.md:39]. Add validation that an ownership agreement's `owner_party_code` matches a `supplier_ref_ext` appearing on a synced ERP purchase-order projection. Implement as an ADDITIVE warning routed to `integration_exception` (`error_code = 'OWNER_PARTY_NOT_IN_ERP'`), NOT a hard reject: the existing `chk_ownership_agreement_owner_party_code` format check stays, and no 2.8 agreement create/edit path starts failing. If no ERP suppliers are synced yet, do not block (2.8 must keep working with zero 2.9 data).
  - [x] 7.2 Regression: all existing `test/integration/story-2-8.test.ts` agreement create/edit assertions must still pass unchanged; add a focused test proving the new warning is raised without rejecting the agreement.
- [x] Task 8: RBAC and location scoping (all ACs)
  - [x] 8.1 Read routes use `requireRole({ module: 'inventory', functionScope: 'read' })`; SO `?site=` resolves the external site code to the internal site UUID and honors `permittedLocationsForModule`, so a non-wildcard caller sees only permitted sites. Purchase orders are not location-grained in the source contract, so PO GET uses module/function scope only (do not invent a location filter); downstream receiving performs its own location authorization. Unauthenticated returns 401.
  - [x] 8.2 The `POST /api/v1/erp/sync` trigger uses `requireRole({ module: 'inventory', functionScope: 'write' })` plus the allowlist `svc_erp_adapter`, `system_administrator`; a normal inventory writer is denied `FUNCTION_ACCESS_DENIED`. Record the chosen allowlist in the Dev Agent Record for later access-matrix sync (the matrix has no explicit INT-ERP-01 read-projection row).
- [x] Task 9: Regression guards (all ACs)
  - [x] 9.1 `test/integration/story-1-9.test.ts` route-surface allowlist updated with the exact new routes; spine gate stays 6/6.
  - [x] 9.2 `test/unit/schema-drift.test.ts` entries for `erp_purchase_order`, `erp_purchase_order_line`, `erp_sales_order`, `erp_sync_state`, `integration_exception`.
  - [x] 9.3 Prove no ERP stream type breaks the spine seams: an `erp`-stream event through `persistEvent` is rejected `SOURCE_SYSTEM_READ_ONLY` and every 2.2-2.8 seam is untouched.
  - [x] 9.4 Story 2.7 lead-time integration remains OPTIONAL-additive: a `planning/params` call may set `lead_time_source` identifying ERP derivation from a projected PO `expected_delivery_date`, but 2.7 still fails closed with `LEAD_TIME_NOT_CONFIGURED` when no 2.9 data exists. Do not turn 2.9 into a hard dependency for 2.7.
- [x] Task 10: Integration tests `test/integration/story-2-9.test.ts` (all ACs)
  - [x] 10.1 AC1: sync a two-line `PO-2026-0042`; `GET /api/v1/erp/purchase-orders/PO-2026-0042` returns header (supplier ref, currency, expected date) and both lines with `sku`, `ordered_qty`, `open_qty`, `unit_price`, tolerance pcts, each stamped `source_system: "ERP"` and `last_synced_at`; numeric precision preserved (no float drift).
  - [x] 10.2 AC2: `GET /api/v1/erp/sales-orders?site=site-A&status=open` resolves `site-A` to an active site UUID, lists dispatch-demand lines with `sku`, `quantity`, `required_by`, `ship_to`; an assigned caller sees the site, a caller assigned elsewhere gets `LOCATION_ACCESS_DENIED`; `status=open` excludes closed; empty result is `[]`.
  - [x] 10.3 AC3: with `erp_sync_state.last_successful_at` older than the freshness threshold, reads carry `stale: true` and the age; a never-synced zero-row feed carries `stale: true` and null age; one `integration_exception` sync-failure alert is raised; repeated stale reads do not stack duplicates; a fresh sync clears the alert and reads carry `stale: false`. Boundary at exactly the threshold resolves to not-stale (strict `>`).
  - [x] 10.4 AC4: an AUTHENTICATED caller using `POST`/`PUT`/`PATCH`/`DELETE` on the PO and SO projection routes receives `SOURCE_SYSTEM_READ_ONLY`; unauthenticated writes still short-circuit at global auth with 401 and malformed bodies may fail body parsing before the handler. A direct authenticated `POST /api/v1/events` and an edge upload with an `erp` stream_type are both rejected `SOURCE_SYSTEM_READ_ONLY`.
  - [x] 10.5 AC5: a batch with one unknown-SKU PO line routes that record to `integration_exception` (error_code, source record ref, reason) while the remaining records sync; multiple malformed records each queue independently; the count of good records applied is exact; a malformed line inside an otherwise-good PO isolates at the PO grain (whole-PO atomic, other POs unaffected).
  - [x] 10.6 Idempotency/replay: re-syncing an unchanged PO/SO produces no duplicate rows and no spurious churn alert; a superseding sync upserts by grain; concurrent syncs for the same grain yield exactly one row and one alert.
  - [x] 10.7 Task 7 regression: an ownership agreement whose owner-party code is absent from ERP suppliers raises the `OWNER_PARTY_NOT_IN_ERP` warning without rejecting the agreement.
- [x] Task 11: Verification battery
  - [x] 11.1 `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test`, `npm run spine-acceptance-contract`, `git diff --check` - all clean; record counts in the Dev Agent Record.

## Dev Notes

### Epic Context

Story 2.9 closes Epic 2 ("Core Inventory and Multi-Location Stock Visibility"). It is the D1 decision from the 2026-07-11 sprint-change proposal: a read-only ERP inbound projection supplying open-PO reference data (gate binding, receiving tolerances) and sales-order demand (pick, dispatch, fill-rate) as the Phase-1 source for every downstream epic, while ERP stays master and native order management (Epic 15) does not yet exist. [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md:49,1001]

This story owns NO PO or sales-order lifecycle logic and NO procurement workflow (Epic 4). It is reference data only: nothing here mutates ERP-mastered state, and receipts posted against a projected PO line never write back to the projection. [Source: _bmad-output/planning-artifacts/epics.md:1199]

### Architecture Break From Stories 2.1-2.8 (read this first)

This is the single most important structural fact for this story. Every prior Epic 2 read model is an event-sourced projection derived from `domain_events` inside `persistEvent` through a compliance seam. Story 2.9 projections are NOT event-sourced. They are populated by an inbound ERP sync adapter and are read-only to the platform. Therefore:

- Do NOT route ERP rows through `persistEvent`. Doing so would trip `assertInventoryTagging` (business-stream tagging is gated to `stream_type: "inventory"` at src/compliance/business-stream.ts:20,48-49) and every other inventory seam. ERP reference rows carry no `business_stream`. This aligns with the `tagging.scope_isolated_to_inventory` project constraint.
- The sync adapter writes projections by DIRECT SQL upsert, exactly as `src/adapters/iam/scim.ts` writes the directory row directly rather than through a projection seam. [Source: src/adapters/iam/scim.ts:94]
- The ONLY interaction with `persistEvent` is a defensive bypass guard (Task 4.4) that rejects any `erp` stream_type or `erp.*` event_type so no client can fabricate ERP rows through the event API. This mirrors the `tagging.enforcement_location` decision (enforce on the central write path, not only the HTTP handler), covering the direct-event and edge paths by construction.

The ERP adapter is architecturally the only component that talks to the external ERP. [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:66,236-237; epics.md:1615] Live ERP transport (polling, message queue, file drop) is per-deployment configuration and out of scope here; the sync entry point is an in-process function exercised through the `POST /api/v1/erp/sync` synthetic trigger, mirroring the Phase-1 synthetic-job pattern used by Story 2.7 planning jobs and the src/notify dispatch cycles.

### Architecture Compliance

- Stack pinned: Node 24, PostgreSQL 18.4, TypeScript 5.x, PowerSync 1.23.x, Next.js 16 (edge). No new dependencies, no scheduler/cron, no ORM. [Source: ARCHITECTURE-SPINE.md:190-201]
- ID convention: internal keys UUIDv4; external validated identifiers stored in `_ext`-suffixed fields (`po_number_ext`, `supplier_ref_ext`, `so_number_ext`, `ship_to_ext`). [Source: ARCHITECTURE-SPINE.md:180-181]
- Dates: timestamps are UTC-with-tz in storage (`last_synced_at`); statutory/business dates use local `YYYY-MM-DD` components, never `toISOString().slice(0,10)` (the `date.timezone_format_local_ymd` constraint). Compute stale age in SQL (`now() - last_synced_at`), never against the JS clock.
- Error envelope: uniform `{ error_code, message, details, trace_id }` with a stable `error_code`; the edge classifies by that code. [Source: ARCHITECTURE-SPINE.md:183; src/middleware/error.ts:5-31]
- Read models are shared PostgreSQL projections in `read/projections/`; modules read from projections only (AD-14). [Source: ARCHITECTURE-SPINE.md:148-152]
- Dual-file migration self-sufficiency (the `migrations.dual_file_self_sufficient_guarded_grants` constraint): each canonical SQL file carries its OWN guarded grants; `deploy/compose/init-db.sql` is a byte-for-byte mirror. Never split-brain the grants across files. Never touch the `powersync_publication` block in init-db.sql (Story 2.5 broke it once).

### Current Code State and Preservation Requirements

Files this story touches, and what must not break:

- `src/events/migrate.ts:8` - single-line MIGRATIONS array; append the three new SQL paths after `ownership_agreement.sql`. Every integration test also hardcodes its own SQL load list, so the new files must be added to the story-2-9 test loop (and any regression test that reads ERP tables).
- `deploy/compose/init-db.sql` - currently ends with the `ownership_agreement` block; append the new table blocks byte-for-byte from the canonical SQL. The schema-drift test normalizes and compares CREATE TABLE and each named constraint between the canonical file and init-db.sql, so whitespace inside constraint bodies must match.
- `read/projections/location_register.sql` + `src/read/projections/location_register.ts:186` - `location_id` is the internal UUID used by RBAC; `location_code` is the unique human-readable code. Resolve ERP `site-A` through `getLocationByCode`, require active `level = 'site'`, and store both identities. Preserve the existing location schema unchanged.
- `src/events/store.ts:162-256` - `persistEvent` runs pre-transaction shape asserts (lines 174-209) then in-transaction projection applies (lines 229-256). Add the ERP read-only bypass guard among the pre-transaction asserts, narrowly gated on the `erp` stream_type / `erp.` event prefix so no existing stream is affected. `persistEvent` skips `BEGIN` when given an external client - not relevant here because the adapter never calls `persistEvent`.
- `src/sync/upload.ts:17-62` - `PERMANENT_ERROR_CODES`; add `SOURCE_SYSTEM_READ_ONLY`. Mirror into `edge/src/sync/connector.ts` and `edge/src/messages/en.json` in the same change.
- `src/config/index.ts:46-54,127-150` - reuse `parsePositiveIntEnv` for `erp.freshnessMs`.
- `src/api/router.ts:22,143` - `BODY_BEARING_METHODS` and the default 404 for unregistered methods: an explicit write-method handler is REQUIRED to return `SOURCE_SYSTEM_READ_ONLY` instead of a bare 404 (AC4).
- `read/projections/ownership_agreement.sql` and `src/compliance/ownership.ts:28-31` - the owner-party referential-validation hook deferred to this story. Tighten additively (Task 7); do not weaken the existing format CHECK or reject any currently-valid agreement.
- Grant nuance: projection tables the adapter upserts need `INSERT, SELECT, UPDATE` for `app_user`, plus `DELETE` only if you ever prune (this story soft-closes, so `DELETE` is optional - be consistent with the `in_transit` precedent if you include it). The `integration_exception` queue is effectively append-plus-resolve: `INSERT, SELECT, UPDATE`.

### File Structure Requirements

Table 1 (files to update) lists existing files this story modifies. Table 2 (new files) lists files this story creates.

Table 1: Files to update

| File | Change |
|------|--------|
| src/events/migrate.ts | Register three new projection SQL files |
| src/events/store.ts | ERP read-only bypass guard (reject erp stream/event) |
| src/config/index.ts | erp.freshnessMs config block |
| src/server.ts | Register ERP read + write-reject + sync-trigger routes |
| src/sync/upload.ts | SOURCE_SYSTEM_READ_ONLY permanent code |
| edge/src/sync/connector.ts | SOURCE_SYSTEM_READ_ONLY needs_attention classification |
| edge/src/messages/en.json | SOURCE_SYSTEM_READ_ONLY i18n |
| src/compliance/ownership.ts | Additive owner-party ERP referential warning |
| deploy/compose/init-db.sql | DDL mirrors for all new tables |
| .env.example, .env.test | ERP_SYNC_FRESHNESS_MS |
| test/unit/schema-drift.test.ts | Entries for all five new tables |
| test/unit/sync-upload.test.ts, edge/test/unit/connector.test.ts | New code classification |
| test/integration/story-1-9.test.ts | Route-surface allowlist |
| test/integration/story-2-8.test.ts | Owner-party warning regression (additive) |

Table 2: New files

| File | Purpose |
|------|---------|
| read/projections/erp_purchase_order.sql | PO header + line projection tables |
| read/projections/erp_sales_order.sql | SO dispatch-demand line projection |
| read/projections/integration_exception.sql | Integration exception queue |
| src/read/projections/erp_purchase_order.ts | PO accessor + adapter upsert helpers |
| src/read/projections/erp_sales_order.ts | SO accessor + adapter upsert helper |
| src/read/projections/integration_exception.ts | Exception raise/list/resolve (dedupe) |
| src/adapters/erp/sync.ts | Inbound sync seam (per-record isolation) |
| src/api/v1/erp-projections.ts | Read handlers + write-reject handlers |
| test/integration/story-2-9.test.ts | Story integration suite |

Naming: snake_case SQL and read-model pairs; kebab-case api/adapter modules.

### API Contract

Table 3 (routes) defines the route surface delta; every route must be added to the story-1-9 allowlist.

Table 3: Routes

| Method | Path | Purpose | Access |
|--------|------|---------|--------|
| GET | /api/v1/erp/purchase-orders/:poNumber | Read-only PO projection (header + lines) | inventory read |
| GET | /api/v1/erp/sales-orders | Read-only SO dispatch-demand list (site code resolved to site UUID, status filters) | inventory read, site-scoped |
| POST | /api/v1/erp/sync | Phase-1 synthetic inbound-sync trigger | svc_erp_adapter / system_administrator |
| POST/PUT/PATCH/DELETE | /api/v1/erp/purchase-orders(/:poNumber), /api/v1/erp/sales-orders | Rejected SOURCE_SYSTEM_READ_ONLY | any |

Check `src/server.ts` registrations before inventing paths; follow the existing `router.get/post` registration pattern.

### Sync and Data Integrity Guardrails

- Per-record isolation (AC5): wrap each PO (header plus lines) and each SO line in its own SAVEPOINT so a malformed record rolls back to the savepoint without aborting the batch, and a good record is never left half-applied. PostgreSQL 18 `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` is the documented mechanism for this; the surrounding batch continues. [Source: PostgreSQL 18 docs, SAVEPOINT / ROLLBACK TO SAVEPOINT]
- Upsert by grain with `INSERT ... ON CONFLICT (grain) DO UPDATE` (PO header on `po_number_ext`, PO line on `(po_number_ext, line_no)`, SO line on `(so_number_ext, line_no)`). Re-syncing an unchanged record must not create duplicates. [Source: PostgreSQL 18 docs, INSERT ON CONFLICT]
- Exception and stale-alert dedupe: the `integration_exception` partial unique index on the open grain plus `ON CONFLICT ... DO NOTHING` (or refresh `raised_at`/`details`) guarantees repeated malformed records and repeated stale reads never stack duplicate open alerts. This mirrors the Story 2.7/2.8 "one open recommendation per grain" partial-unique pattern. [Source: read/projections/replenishment_recommendation.sql]
- All quantity and price comparisons in SQL NUMERIC, never JS floats (recurring 2.4/2.6/2.7/2.8 defect class). Bound numeric inputs (reject non-finite, negative, or absurdly large values, mirror MAX_QUANTITY guards in src/compliance/inventory-planning.ts).
- `source_system` is server-set to `'ERP'` and never trusted from the source payload; `last_synced_at` is server-set to `now()`.
- Site identity uses both namespaces deliberately: `ship_from_site_code_ext` preserves the ERP/API code (`site-A`), while `ship_from_site_id` resolves to the internal `location_register.location_id` UUID used by RBAC. Never compare a role-assignment UUID directly with the external site code.
- Close/removal is soft (`status = 'closed'`), never hard-delete, so downstream references resolve; ERP stays master.
- Idempotency/concurrency: hold the grain row `FOR UPDATE` across read-decide-persist where a concurrent sync could race the same grain, so concurrent syncs yield exactly one row and one alert (mirror the Story 2.7/2.8 concurrent-check tests).
- Stale GETs intentionally perform a deduped operational write to `integration_exception` and notification emission; this is the AC3 exception to the normal read-handler expectation and requires the app role's INSERT grant.

### Offline Projection Boundary

This story delivers the CENTRAL ERP reference projections and APIs. It does not add these tables to PowerSync publication, sync rules, or edge SQLite. Epic 3's offline gate/receiving stories own the location-scoped edge cache and replication contract when they build the consuming flows. Do not modify the existing `powersync_publication` block or claim offline PO lookup is complete in Story 2.9.

### Downstream Consumers (contract obligations, do not build their logic here)

- Story 2.2 / 2.4 owned-stock receipts reference an open-PO line (`po_line_ref`) for AC coverage; the projection is never written back by a receipt. [Source: epics.md:962,1018,1199]
- Story 2.7 replenishment may derive `lead_time_days` from a projected PO `expected_delivery_date`, recording `lead_time_source`; keep this optional-additive (2.7 fails closed with `LEAD_TIME_NOT_CONFIGURED` without 2.9 data). [Source: epics.md:1129; src/compliance/inventory-planning.ts:110-119]
- Story 2.8 owner-party codes validate against ERP supplier references appearing on these projections (Task 7). [Source: epics.md:1165]
- Epic 3 (gate binding 3.2, weighbridge tolerance 3.3, receiving 3.4), Epic 4 (three-way match), Epics 9/11 (dispatch demand, IRN), Epic 5 (where-used open-PO impact), Epic 13 (migration reconciliation) all consume these projections. Build only the projections and their read API; not the consumer logic.

### Previous Story Intelligence

- Story 2.8 (direct predecessor) established: projection SQL + read-model TS pair, migration triad (migrate.ts + init-db.sql mirror + schema-drift EXPECTED entry), guarded self-sufficient grants, four-surface error-code discipline, write-location RBAC, direct-event/edge RBAC parity, and the concurrent-grain FOR UPDATE pattern. Story 2.8 finished at backend 333/333, edge 14/14, spine 6/6. [Source: _bmad-output/implementation-artifacts/2-8-consignment-and-vmi-stock-segregation.md]
- Story 2.8 deferred owner-party referential validation to this story and validated codes only shape-wise (`chk_ownership_agreement_owner_party_code`). Task 7 closes that defer additively.
- Story 2.5 lesson: every write handler issues its own BEGIN; derive persisted state from data, never hardcode; bind arrays as params; distinct error codes per failure point. The adapter sync's per-record SAVEPOINT discipline is this story's analog.
- Story 2.2 established the `po_line_ref` external reference on receipts and left the per-class stock breakdown to 2.8; nothing in 2.2 is modified here.

### Latest Technical Information

No new libraries. PostgreSQL 18.4 provides the SAVEPOINT/ROLLBACK-TO-SAVEPOINT per-record isolation, `INSERT ... ON CONFLICT` grain upserts, and partial unique indexes used above - all already patterns in this repo. No external API integration is built in this story (live ERP transport is per-deployment configuration; the sync entry point is an in-process function driven by the synthetic trigger). No supplier transmission, no procurement workflow (Epic 4), no order management (Epic 15).

### Testing Requirements

- One integration file per story: `test/integration/story-2-9.test.ts` (node --test, serial `--test-concurrency=1`, `.env.test`, PostgreSQL container required, audit-trigger escape hatch around TRUNCATE per the 2.8 harness at test/integration/story-2-8.test.ts:1-133). Add the three new SQL files to its migration loop plus the full prior chain.
- Regression extensions, not replacements, in story-1-9 (route surface) and story-2-8 (owner-party warning is additive).
- Schema-drift unit coverage for every DDL change (all five new tables).
- Full gate battery in Task 11; report exact counts. Integration tests require the Postgres container running (`test.concurrency_and_audit_truncate`).

## Project Structure Notes

Matches the unified structure: read models paired `read/projections/*.sql` + `src/read/projections/*.ts`, routes in `src/api/v1/` registered in `src/server.ts`, no numbered migrations (canonical SQL + migrate.ts + init-db mirror + drift guard). One intentional NEW structural element: the `src/adapters/erp/` directory (only `src/adapters/iam/` exists today), consistent with the architecture spine's `adapters/erp/` namespace as the sole ERP-facing component. One intentional variance from prior Epic 2 stories: these projections are populated by direct adapter upsert rather than the event-sourced `persistEvent` seam - this is deliberate (reference data, ERP is master) and enforced read-only by the `persistEvent` bypass guard. No conflicts with existing modules detected.

## References

- Story + ACs: [Source: _bmad-output/planning-artifacts/epics.md:1169-1199]
- D1 decision + rationale: [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md:49,1001-1046]
- INT-ERP-01 dual mastership: [Source: ARCHITECTURE-SPINE.md:88-92; _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md:22]
- ERP adapter as sole ERP-facing component: [Source: ARCHITECTURE-SPINE.md:66,236-237; epics.md:1615]
- persistEvent seams + central enforcement location: [Source: src/events/store.ts:162-256]
- Business-stream tagging gated to inventory stream: [Source: src/compliance/business-stream.ts:20,48-49]
- Direct-upsert adapter precedent (SCIM): [Source: src/adapters/iam/scim.ts:22-64,94]
- Read-model + accessor pattern: [Source: read/projections/ownership_agreement.sql; src/read/projections/ownership_agreement.ts:29-140]
- Migration triad + drift guard: [Source: src/events/migrate.ts:8; test/unit/schema-drift.test.ts:35-249]
- Edge error classification: [Source: src/sync/upload.ts:17-62]
- Notification emission (non-blocking): [Source: src/notify/emit.ts]
- RBAC helpers: [Source: src/middleware/rbac.ts:11,40,61]
- Config env helper: [Source: src/config/index.ts:46-54]
- Router default-404 for unregistered methods: [Source: src/api/router.ts:22,143]
- Owner-party defer to 2.9: [Source: _bmad-output/implementation-artifacts/2-8-consignment-and-vmi-stock-segregation.md:39,192]
- Story 2.7 lead-time source hook: [Source: epics.md:1129; src/compliance/inventory-planning.ts:110-119]
- Service accounts (svc_erp_adapter): [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:127]
- Spine route-surface allowlist: [Source: test/integration/story-1-9.test.ts:152-234]
- Integration test harness: [Source: test/integration/story-2-8.test.ts:1-133]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (1M context) via the bmad-dev-story workflow.

### Debug Log References

- `npm run db:migrate` applied all migrations including the three new ERP SQL files cleanly.
- `npx tsc --noEmit`, `npm run lint`, `npm run build`: clean.
- `npm test`: 347/347 (14 new: 9 story-2-9 integration tests + 5 schema-drift table guards).
- `npm run edge:typecheck`, `npm run edge:lint`: clean. `npm run edge:test`: 14/14.
- `npm run spine-acceptance-contract`: 6/6. `git diff --check`: clean.

### Completion Notes List

All 11 tasks and every acceptance criterion (AC1-AC5) are satisfied. Key decisions recorded for later
governance:

- Architecture break confirmed (Task 3, Dev Notes): the ERP projections are NOT event-sourced. The
  sync adapter (`src/adapters/erp/sync.ts`) writes them by direct SQL upsert, exactly like
  `src/adapters/iam/scim.ts`. The only `persistEvent` interaction is the defensive bypass guard
  (`src/compliance/erp-readonly.ts`), which rejects any `erp` stream_type or `erp.*` event_type with
  `SOURCE_SYSTEM_READ_ONLY`, covering the direct-event POST and the edge upload paths by construction.
- Close/removal semantics (Task 3.4): a PO or SO line that is no longer in the open feed is soft-flagged
  `status = 'closed'` on the next sync, never hard-deleted, so downstream receipts referencing it still
  resolve. `closePurchaseOrdersNotIn` / `closeSalesOrdersNotIn` implement this; the integration test
  proves a dropped SO line resolves under `status=closed`.
- Sync-trigger allowlist (Task 8.2): `POST /api/v1/erp/sync` requires `requireRole({ module: 'inventory',
  functionScope: 'write' })` plus an authorizing role of `svc_erp_adapter` or `system_administrator`; a
  normal inventory writer is denied `FUNCTION_ACCESS_DENIED`. Recorded here for the access-matrix sync
  (the matrix has no explicit INT-ERP-01 read-projection row yet).
- Stable-error architecture note (Task 6.2): two new codes were introduced. `SOURCE_SYSTEM_READ_ONLY`
  (HTTP 405) is now in the backend `PERMANENT_ERROR_CODES`, the edge connector permanent set, and the
  edge `en.json` i18n bundle (all four surfaces plus their unit tests). `ERP_SYNC_STALE` is an internal
  alert code raised only into the `integration_exception` queue (not an upload-rejection code), so it is
  intentionally absent from the permanent-code sets. The architecture doc has no ERP stable-error row
  yet; add `SOURCE_SYSTEM_READ_ONLY` when the doc is next touched.
- Staleness (AC3) is computed entirely in SQL (`now() - last_successful_at` against
  `make_interval` from `config.erp.freshnessMs`), never against the JS wall clock; the boundary is strict
  (`>`), so exactly-at-threshold resolves to not-stale. A stale read performs the deduped operational
  alert write and emits a one-time non-blocking ops notification (via `emitNotification`, not
  `emitNotificationInTransaction`); the `xmax = 0` discriminator on the dedupe upsert prevents re-notifying
  while an alert is already open, and a fresh in-threshold sync resolves it.
- Per-record isolation (AC5): each PO (header plus lines) and each SO line is applied inside its own
  `SAVEPOINT`; a malformed line isolates at the whole-PO grain (atomic), the record is routed to the
  exception queue with its source snapshot, and the batch continues with no batch-level abort. The open
  partial-unique index (`NULLS NOT DISTINCT`) dedupes repeated malformed records and repeated stale
  failures to a single open row.
- Story 2.8 owner-party tightening (Task 7) is additive: after the agreement is upserted, an
  `OWNER_PARTY_NOT_IN_ERP` warning is queued only when at least one ERP supplier is synced and the code
  matches none; it never rejects, the existing format CHECK is untouched, and it stays silent when zero
  Story 2.9 data exists. The story-2-8 harness was extended to load and truncate the ERP tables so its
  assertions remain unchanged.
- Story 2.7 lead-time integration stays optional-additive (Task 9.4): 2.7 code was not modified; the
  integration test proves safety-stock compute still fails closed with `LEAD_TIME_NOT_CONFIGURED` when no
  Story 2.9 data exists, so 2.9 is not a hard dependency for 2.7.

This story closes Epic 2.

### File List

New files:

- `read/projections/erp_purchase_order.sql`
- `read/projections/erp_sales_order.sql`
- `read/projections/integration_exception.sql`
- `src/read/projections/erp_purchase_order.ts`
- `src/read/projections/erp_sales_order.ts`
- `src/read/projections/integration_exception.ts`
- `src/adapters/erp/sync.ts`
- `src/compliance/erp-readonly.ts`
- `src/api/v1/erp-projections.ts`
- `test/integration/story-2-9.test.ts`

Modified files:

- `src/events/migrate.ts`
- `src/events/store.ts`
- `src/config/index.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `src/compliance/ownership.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `deploy/compose/init-db.sql`
- `.env.example`
- `.env.test`
- `test/unit/schema-drift.test.ts`
- `test/unit/sync-upload.test.ts`
- `edge/test/unit/connector.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-2-8.test.ts`
- `_bmad-output/implementation-artifacts/2-9-erp-inbound-reference-projections.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

Table 4 (change log) tracks story-file revisions.

Table 4: Change log

| Date | Change |
|------|--------|
| 2026-07-22 | Story created via create-story workflow (ultimate context engine analysis) |
| 2026-07-22 | Implemented all 11 tasks from baseline 8f5c3eb; ERP inbound reference projections (PO header/lines, SO dispatch demand, integration exception queue + sync heartbeat), direct-upsert sync adapter with per-record SAVEPOINT isolation and soft-close, read API with SQL-computed staleness, read-only enforcement via persistEvent bypass guard and explicit write-verb reject handlers, four-surface SOURCE_SYSTEM_READ_ONLY classification, additive Story 2.8 owner-party ERP warning; tsc/lint/build clean, npm test 347/347 (+14), edge 14/14, spine gate 6/6, diff-check clean; moved to review |
| 2026-07-22 | Code review (3-layer adversarial + party-mode decision resolution): 2 decisions resolved, 10 patches applied, 3 deferred, 6 dismissed. Fixes: empty/all-failed batch no-op guard (no mass-close, no fresh-success, no stale-clear when zero records applied); per-record exception drained on clean re-sync; guarded raiseException so an exception-write failure cannot abort the batch; best-effort stale-alert side effect on reads (no 500); batch-position fallback ref for null-ref malformed records; per-projection pg_advisory_xact_lock against concurrent-sync cross-close; guarded post-commit success heartbeat; SO close-key now a composite tuple (no delimiter collision); removed premature owner-party ERP warning (wrong identifier namespace, deferred to Epic 4.1 supplier registry). Deferred: phantom dropped lines (needs schema decision), sync batch-size bound, per-record exceptions on late infra rollback. tsc/lint/build clean, npm test 348/348 (+1); moved to done |

### Review Findings

Adversarial code review 2026-07-22 (3-layer: Blind Hunter, Edge Case Hunter, Acceptance Auditor). All 5 ACs verified implemented and test-covered. Findings below.

- [x] [Review][Patch] Empty-batch must be a no-op (resolved from Decision, party-mode 2026-07-22) - a batch delivering zero records must NOT mass-close the open book, must NOT stamp fresh success, and must NOT clear the stale alert. Guard on empty-delivered specifically (no delta-shape inference); a legitimate full-book close requires an explicit signal, deferred to when the transport contract is written. Full-snapshot assumption stays undocumented and is probably wrong for a real INT-ERP-01 delta feed - surface it, do not bury it in a comment. [src/adapters/erp/sync.ts:271-293,320-323,343-350]
- [x] [Review][Patch] Disable/re-key owner-party ERP warning (resolved from Decision, party-mode 2026-07-22) - `owner_party_code` and `erp_purchase_order.supplier_ref_ext` are different identifier namespaces, so the comparison false-positives essentially every agreement once any PO syncs, poisoning the exception queue. Task-7-bound (not AC-bound); the correct referential anchor is the Epic 4 Story 4.1 governed supplier registry. Remove/disable the warning with a forward-pointer to 4.1 rather than emit false positives now. [src/compliance/ownership.ts:183-203]
- [x] [Review][Patch] All-failed batch reports healthy - a batch where every record fails validation (applied=0, failed=N) still COMMITs, mass-closes the open book via empty presentRefs, marks the sync successful, and resolves the stale alert. Guard so a zero-applied cycle does not soft-close, does not mark success, and does not clear staleness. [src/adapters/erp/sync.ts:292-293,343-350]
- [x] [Review][Patch] Successful re-sync never drains the record's prior exception - a PO/SO that failed last cycle and syncs cleanly this cycle upserts the row but never calls `resolveOpenExceptionsByGrain` for its record grain, so the open exception persists forever. Resolve open exceptions for each successfully applied record. [src/adapters/erp/sync.ts:274-325]
- [x] [Review][Patch] Unguarded raiseException in the record catch can abort the whole batch - the `raiseException` call inside each per-record catch is not itself guarded; if it throws (oversized reason, non-serializable details) it propagates to the outer catch and ROLLBACKs every already-applied good record. Wrap it best-effort. [src/adapters/erp/sync.ts:280-289,308-317]
- [x] [Review][Patch] Stale GET 500s on its own side-effect - `raiseErpSyncStale` is awaited unguarded inside the read handlers after the data is already fetched; if the exception insert or notification throws, a successful read returns 500. Make the stale alert best-effort. [src/api/v1/erp-projections.ts:59-61,127-129,137-139]
- [x] [Review][Patch] Distinct malformed records collapse into one exception - records with a null `source_record_ref` (missing `po_number_ext`) and the same `error_code` dedupe via NULLS NOT DISTINCT into a single open row, so multiple bad records silently overwrite each other (contradicts AC5 "each queues independently"). Supply a batch-position fallback ref when the natural ref is absent. [src/read/projections/integration_exception.ts:155-172; src/adapters/erp/sync.ts:283,307]
- [x] [Review][Patch] Concurrent sync cycles cross-close - two overlapping `runErpSync` runs with disjoint feeds each close the other's present rows; no advisory lock or `FOR UPDATE` grain serialization (the spec's Data Integrity Guardrails require holding the grain across read-decide-persist). Add a per-projection advisory lock around the cycle. [src/adapters/erp/sync.ts:254-353]
- [x] [Review][Defer] Dropped lines on a still-open record persist as phantoms - soft-close is header-only (PO), and PO lines carry no status column so nothing removes a line absent from a re-synced open PO; a cancelled line keeps a stale open_qty and is returned by `getPurchaseOrderByRef`. Deferred: the clean fix needs a schema decision, not an in-place patch - either add a DELETE grant on erp_purchase_order_line (the app role deliberately has none - reference tables withhold DELETE) or add a line `status` column with a migration + init-db + schema-drift guard + read filter. A hard-DELETE patch was attempted and reverted: it fails with "permission denied for table erp_purchase_order_line". [src/read/projections/erp_purchase_order.ts:196-202; src/adapters/erp/sync.ts:195-209]
- [x] [Review][Patch] Success heartbeat runs outside the try/catch - `markSyncSuccess`/`resolveOpenExceptionsByGrain` run after `client.release()` with no guard; a throw there skips `markSyncFailure` and leaves a committed projection falsely reported stale. Fold into the guarded flow. [src/adapters/erp/sync.ts:342-350]
- [x] [Review][Patch] SO close-key delimiter is ambiguous - `so_number_ext || ':' || line_no` collides when a `so_number_ext` contains `:` (e.g. "SO-1:2" line 3 vs "SO-1" line "2:3"). Use a tuple/parameterized key instead of string concatenation. [src/read/projections/erp_sales_order.ts:145]
- [x] [Review][Defer] No batch-size bound on the sync array - `runErpSync` processes the entire posted array in one transaction with one savepoint per record; a very large array holds a long transaction on a pooled connection. Low risk (trigger is RBAC-restricted to svc_erp_adapter/system_administrator). Deferred, pre-existing shape. [src/api/v1/erp-projections.ts:162-178]
- [x] [Review][Defer] Per-record exceptions lost on late infra rollback - exceptions queued inside the batch transaction are discarded if a later COMMIT/statement fails and ROLLBACKs; the malformed-record audit vanishes until the next retry re-raises them. Deferred (self-healing on retry). [src/adapters/erp/sync.ts:280-337]
