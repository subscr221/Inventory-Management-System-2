---
baseline_commit: f23c59f
---

# Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an inventory planner,
I want safety stock levels and reorder points computed per SKU per location from lead-time and demand variability, with automated replenishment recommendations and aging/obsolescence flags,
so that stockouts are reduced by 40% within 12 months (SM-02) and no slow-moving stock ages silently into write-off exposure.

## Acceptance Criteria

1. **Given** an item with 90 days of demand history showing a daily-demand standard deviation of 4 units, `lead_time_days: 9` on the SKU-location record, and a configured service level of 95%
   **When** the safety stock computation runs
   **Then** the stored safety stock equals `z(0.95) x sigma_daily x sqrt(lead_time_days)` = 1.645 x 4 x 3 = 19.74, rounded up to 20 units, stored against the SKU-location combination with the computation date and the input parameters used (FR-I-07), and the reorder point is stored as `(avg_daily_demand x lead_time_days) + safety_stock`.
2. **Given** on-hand stock for `RM-0042` at `site-A` falls to or below its reorder point
   **When** the replenishment check runs
   **Then** an automated replenishment recommendation is created with the standard order quantity, and the planner receives an exception alert through the Story 1.11 notification foundation.
3. **Given** an item has had zero issues for longer than the configured obsolescence threshold (for example 180 days)
   **When** the obsolescence flag job runs
   **Then** the item is marked `aging` in the read model, appears in the obsolescence exception report carrying `disposition_status: "pending_disposition"`, and NRV testing (FR-AC-06) is triggered.

**Note (lead-time source):** Until Epic 4 delivers measured PO-to-receipt lead times, `lead_time_days` is maintained per SKU-location - seeded manually or derived from expected dates on open-PO projections (Story 2.9) - and each computation records which source was used in `lead_time_source`.

**Note (FR-I-08 disposition feed):** Deferred to Phase 2 (Epic 16): routing of flagged aging/obsolete stock into the scrap/disposition workflow (FR-SC-01). Phase-1 interim behavior: flagged items carry `disposition_status: "pending_disposition"`, remain visible in the obsolescence exception report, and NRV testing (FR-AC-06) still applies - no stock leaves the ledger until Epic 16 delivers disposition.

**Note (replenishment scope):** Phase-1 produces a recommendation only, not a committed purchase requisition or PO. Automated auto-requisition and supplier transmission (the second half of FR-I-03) arrive with the supplier registry and PO management (Epic 4). Do not create purchase-order or requisition records this story does not own.

## Tasks / Subtasks

- [x] Task 1: Add inventory-planning event contracts and schemas (AC: 1, 2, 3)
  - [x] Add event interfaces to `src/events/schema.ts` and `SUPPORTED_EVENT_TYPES` for `inventory_planning.params_set`, `inventory_planning.safety_stock_computed`, `replenishment.recommended`, `obsolescence.flagged`, and `obsolescence.cleared`.
  - [x] Use `stream_type: "inventory"` for all new events. Use UUIDv4 IDs for `planning_params_id`, `computation_id`, `recommendation_id`, and `obsolescence_flag_id`.
  - [x] Require `business_stream` (and `cost_centre`/`project_code` where applicable) so Story 1.5 tagging applies at the central write path.
  - [x] Keep event names past-tense and dot-separated. Keep command names imperative PascalCase if command helpers are introduced.
  - [x] Add schema drift expectations for the new projections in `test/unit/schema-drift.test.ts`.

- [x] Task 2: Add canonical planning projection DDL (AC: 1, 2, 3)
  - [x] Create `read/projections/inventory_planning.sql` with an `inventory_planning_params` table at grain `(sku, location_id)` storing `lead_time_days`, `lead_time_source`, `service_level`, `avg_daily_demand`, `demand_std_dev`, `demand_window_days`, `obsolescence_threshold_days`, `standard_order_qty`, computed `safety_stock`, computed `reorder_point`, `last_computed_at`, and a `computation_inputs` JSONB snapshot; use `UNIQUE NULLS NOT DISTINCT` on `(sku, location_id)`.
  - [x] Create `read/projections/replenishment_recommendation.sql` for open recommendations: `recommendation_id`, `sku`, `location_id`, `on_hand_at_check`, `reorder_point`, `recommended_order_qty`, `status` (`open`/`superseded`/`fulfilled`), `triggered_at`, `source_event_id`.
  - [x] Create `read/projections/obsolescence_flag.sql` at grain `(sku, location_id)`: `status` (`active`/`aging`), `last_issue_at`, `days_since_issue`, `threshold_days`, `disposition_status`, `nrv_testing_triggered`, `flagged_at`, `cleared_at`, `source_event_id`.
  - [x] Include guarded grants in each SQL file. Mirror all DDL in `deploy/compose/init-db.sql` without deleting the `powersync_publication` block.
  - [x] Register all three SQL files in `src/events/migrate.ts`.

- [x] Task 3: Track last-issue activity for obsolescence detection (AC: 3)
  - [x] Obsolescence keys off "zero issues for N days". Add a durable `last_issue_at` per `(sku, location_id)` that the obsolescence scan reads from a projection, in line with AD-14 (read models, not raw event replay in handlers).
  - [x] Prefer extending `read/projections/stock_balance.sql` and `src/read/projections/stock_balance.ts` to stamp `last_issue_at` when a `stock.issued` event applies, aggregating `MAX(last_issue_at)` across lots when reading at `(sku, location_id)`. If extending `stock_balance` risks the Story 2.2 generated-column and grain invariants, add a dedicated `stock_movement_activity` projection instead - but do not replay `domain_events` inside the scan.
  - [x] Only `stock.issued` resets the obsolescence clock. Do NOT treat `stock.received`, `stock.allocated`, transfers, or `stock.adjusted` as issue activity - obsolescence is about outbound consumption, not receipts or corrections.
  - [x] Do not corrupt Story 2.2 `on_hand`, `allocated`, `available`, or `in_transit` when adding activity tracking.

- [x] Task 4: Add central inventory-planning seam in `persistEvent()` (AC: 1, 2, 3)
  - [x] Create `src/compliance/inventory-planning.ts` with `assertInventoryPlanningShape()` and `applyInventoryPlanningProjection()`.
  - [x] Wire `assertInventoryPlanningShape()` in `src/events/store.ts` after `assertCycleCountShape()` and before any transaction begins (near `src/events/store.ts:198`).
  - [x] Wire `applyInventoryPlanningProjection()` in `src/events/store.ts` inside the transaction after `applyCycleCountProjection()` and before the `domain_events` insert (near `src/events/store.ts:235`).
  - [x] Gate narrowly to `stream_type: "inventory"` and the new event types only, so DOA, SCIM, audit, stock, valuation, transfer, and cycle-count events are byte-for-byte unaffected. Mirror the narrow gating style of `src/compliance/inventory-master.ts` and `src/compliance/stock-balance.ts`.
  - [x] Add idempotency guards before projection mutation because projections run before the final `domain_events` insert can raise `DUPLICATE_EVENT`.
  - [x] Lock the `inventory_planning_params` row and any recommendation/flag rows being transitioned with `FOR UPDATE` so a concurrent compute-and-check cannot produce duplicate open recommendations or double flags.

- [x] Task 5: Implement safety-stock and reorder-point computation (AC: 1)
  - [x] Add `runSafetyStockComputation(scope)` in `src/compliance/inventory-planning.ts` (or a sibling `src/compliance/planning-jobs.ts`) that, for each in-scope `(sku, location_id)` with configured `lead_time_days` and `service_level`, derives `avg_daily_demand` and `sigma_daily` from `stock.issued` movements over the trailing `demand_window_days` (default 90) and emits `inventory_planning.safety_stock_computed` through `persistEvent()`.
  - [x] Compute `safety_stock = ceil(z(service_level) x sigma_daily x sqrt(lead_time_days))`. Provide `z` from a small static service-level lookup table (0.90, 0.95, 0.975, 0.99); reject unlisted service levels with `INVALID_SERVICE_LEVEL` rather than inventing a normal-inverse implementation. Confirm the worked example resolves to exactly 20 (1.645 x 4 x sqrt(9) = 19.74, ceil to 20).
  - [x] Compute `reorder_point = ceil((avg_daily_demand x lead_time_days) + safety_stock)`.
  - [x] Store `safety_stock`, `reorder_point`, `last_computed_at`, and the full `computation_inputs` (sigma_daily, avg_daily_demand, z, service_level, lead_time_days, lead_time_source, demand_window_days, sample_day_count) on the params projection. The stored computation must be reproducible from its recorded inputs.
  - [x] If demand history covers fewer than a configured minimum of sample days, fail closed with `INSUFFICIENT_DEMAND_HISTORY` and do not overwrite a prior valid computation.
  - [x] If `lead_time_days` is not configured for a scoped SKU-location, fail closed with `LEAD_TIME_NOT_CONFIGURED`. Record `lead_time_source` on every computation.

- [x] Task 6: Implement replenishment check and recommendation (AC: 2)
  - [x] Add `runReplenishmentCheck(scope)` that reads `stock_balance.on_hand` at `(sku, location_id)` and compares it against the stored `reorder_point`. When `on_hand <= reorder_point`, emit `replenishment.recommended` through `persistEvent()` with `recommended_order_qty = standard_order_qty` and the on-hand/reorder-point snapshot.
  - [x] Be idempotent per crossing: if an `open` recommendation already exists for the grain, do not create a duplicate. Supersede or refresh only when the reorder point or standard order quantity changed.
  - [x] Raise a planner exception alert transactionally via `emitNotificationInTransaction()` inside the same projection transaction so the alert is part of the business fact (mirror the Story 2.6 approval-task pattern). Use a replenishment notification category and target the planner role; scope by `location_id`.
  - [x] Compare quantities with SQL-side NUMERIC arithmetic, not JavaScript floating-point, consistent with the repeated Story 2.4 and Story 2.6 review findings on monetary/quantity precision.
  - [x] Do not create purchase-order or requisition records. This story emits a recommendation only (see the replenishment-scope note).

- [x] Task 7: Implement obsolescence flag scan and NRV trigger (AC: 3)
  - [x] Add `runObsolescenceScan(scope)` that, for each in-scope `(sku, location_id)` with a configured `obsolescence_threshold_days`, computes `days_since_issue` from `last_issue_at` (Task 3) and, when it exceeds the threshold, emits `obsolescence.flagged` through `persistEvent()`.
  - [x] The flag must set the read-model `status` to `aging`, set `disposition_status: "pending_disposition"`, set `nrv_testing_triggered: true`, and record `last_issue_at`, `days_since_issue`, and `threshold_days`.
  - [x] "Trigger NRV testing" means flag the item for NRV review and alert, NOT auto-post a write-down. The actual write-down stays DOA-gated through the existing Story 2.4 NRV seam (`stock.nrv_write_down_recorded`, `inventory.nrv_write_down`). Do not bypass `src/compliance/inventory-valuation.ts` or hand-post a write-down from planning code.
  - [x] Emit `obsolescence.cleared` (un-flagging `status` back to `active`, `disposition_status` back to null) when a previously flagged grain records fresh `stock.issued` activity inside the threshold, so resumed movement clears the flag idempotently.
  - [x] Do not remove any stock from the ledger; disposition is Epic 16.

- [x] Task 8: Add REST APIs with RBAC and location scoping (AC: 1, 2, 3)
  - [x] Create `src/api/v1/inventory-planning.ts` with `POST /api/v1/planning/params` (set SKU-location planning config), `GET /api/v1/planning/params/:sku` (optional `location_id` filter), `POST /api/v1/planning/safety-stock/compute` (run computation over a location/SKU scope), `POST /api/v1/planning/replenishment/check`, `GET /api/v1/planning/replenishment/recommendations`, `POST /api/v1/planning/obsolescence/scan`, and `GET /api/v1/planning/obsolescence/report`.
  - [x] The three `POST .../compute`, `.../check`, `.../scan` endpoints are the Phase-1 synthetic job triggers (no scheduler is in scope), mirroring the `runDispatchCycle`/`runEscalationCycle`/`runExpiryCycle` cycle pattern in `src/notify/`. Keep the batch cycle functions separate from the HTTP handlers so a future scheduler can call them directly.
  - [x] Register routes in `src/server.ts` and update the route-surface guard in `test/integration/story-1-9.test.ts`.
  - [x] Use existing `requireRole`, `permittedLocationsForModule`, `sendJson`, `sendRequestError`, `getAuthContext`, and audit-context patterns. Do not add a new routing framework.
  - [x] Suggested params-set and job-trigger roles: `inventory_planner`, `demand_planner`, `inventory_controller`. Read report/recommendation roles: the same plus `warehouse_manager` where DOA/config allows.
  - [x] Enforce location access for every scoped location and every report filter. Wildcard actors may see all locations; non-wildcard actors only see assigned locations.

- [x] Task 9: Add stable errors, sync classification, and i18n (AC: 1, 2, 3)
  - [x] Add stable errors: `LEAD_TIME_NOT_CONFIGURED`, `INSUFFICIENT_DEMAND_HISTORY`, `INVALID_SERVICE_LEVEL`, `PLANNING_PARAMS_NOT_FOUND`, and `OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED`.
  - [x] Add the permanent-business-rejection subset to `src/sync/upload.ts` and `edge/src/sync/connector.ts` so they settle as `needs_attention` rather than halting the outbox.
  - [x] Add i18n entries in `edge/src/messages/en.json`.
  - [x] Add backend and edge unit tests covering new error classification.

- [x] Task 10: Add comprehensive tests and regression guards (AC: 1, 2, 3)
  - [x] Create `test/integration/story-2-7.test.ts` covering all three acceptance criteria end to end, including the AC1 worked example resolving to exactly 20 units and the reorder-point formula.
  - [x] Cover: computation input reproducibility, `INSUFFICIENT_DEMAND_HISTORY`, `LEAD_TIME_NOT_CONFIGURED`, `INVALID_SERVICE_LEVEL`; reorder crossing creates exactly one open recommendation and one planner alert; obsolescence flag sets `aging` + `pending_disposition` + `nrv_testing_triggered`; resumed issue activity clears the flag; NRV write-down still routes through the DOA-gated valuation seam (planning does not post it).
  - [x] Cover idempotency: re-running each job over an unchanged state produces no duplicate events, recommendations, flags, or alerts.
  - [x] Cover concurrency: two concurrent replenishment checks or two obsolescence scans for the same grain must not create duplicate open recommendations or double flags.
  - [x] Extend `test/integration/story-2-2.test.ts` (or the stock-balance activity test) to prove `last_issue_at` stamps on `stock.issued` and that `on_hand`/`allocated`/`available`/`in_transit` invariants are unchanged.
  - [x] Extend `test/integration/story-1-9.test.ts` for the new routes and `test/unit/schema-drift.test.ts` for the new projections.
  - [x] Run the full verification battery listed in this story before marking done.

## Dev Notes

### Epic Context

Story 2.7 is part of Epic 2, Core Inventory and Multi-Location Stock Visibility. It delivers FR-I-03 (reorder points and replenishment recommendations), FR-I-07 (safety-stock computation), and the flagging half of FR-I-08 (aging/obsolescence flagging feeding NRV testing). Its measurable target is SM-02: reduce stockouts by 40% within 12 months. [Source: `_bmad-output/planning-artifacts/epics.md:1107`; Source: `_bmad-output/planning-artifacts/epics.md:32`; Source: `_bmad-output/planning-artifacts/epics.md:37`]

Stories 2.1 through 2.6 are complete prerequisites. Story 2.1 supplies item and location masters (and the `item_master` grain that this story does NOT extend for planning params - see below). Story 2.2 supplies `stock_balance` (the on-hand baseline for reorder checks). Story 2.4 supplies the valuation and DOA-gated NRV write-down seam that obsolescence NRV testing hands off to. Story 2.6 supplies the `stock.adjusted` contract and the transactional approval-task/notification pattern reused here. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml:198`]

This story feeds Phase-1 dashboards: the inventory controller's below-reorder-point exceptions and aging/obsolescence flags, and the demand planner's below-safety-stock and replenishment-recommendation queue. Design the recommendation and obsolescence projections as queryable read models those dashboards can consume, not private report-only tables. [Source: `_bmad-output/planning-artifacts/epics.md:3161`; Source: `_bmad-output/planning-artifacts/epics.md:3163`; Source: `_bmad-output/planning-artifacts/epics.md:3195`]

### Architecture Compliance

- Central enforcement lives in `persistEvent()`. Planning events must converge there so direct `POST /api/v1/events` and edge uploads cannot bypass shape validation or projection application. [Source: `src/events/store.ts:160`; Source: `src/events/store.ts:198`]
- DOA registry is the single approval resolver. This story does not gate the recommendation itself (a recommendation is not an approval-bearing mutation), but the NRV write-down it triggers stays DOA-gated in the Story 2.4 valuation seam. Do not hard-code approver roles anywhere. [Source: `src/compliance/inventory-valuation.ts:288`; Source: `src/compliance/inventory-valuation.ts:339`]
- Read models are shared projections. Job computations may read `stock.issued` history to derive statistical inputs, but the stored outputs (safety stock, reorder point, recommendations, flags) live in projections, and reports read projections, not raw event streams. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:148`]
- All mutating APIs are REST under `/api/v1/`, SSO-gated, and edit-logged with `trace_id`. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:328`]
- Stack is pinned: Node.js 24 LTS, PostgreSQL 18.4, PowerSync 1.23.x, Next.js 16, TypeScript 5.x. Do not add a scheduler, cron library, statistics library, ORM, or queue for this story. Use built-in `Math.sqrt`/`Math.ceil` for the formula and SQL NUMERIC for quantity comparisons. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:190`]

### Current Code State and Preservation Requirements

- `src/events/store.ts` runs pre-transaction asserts (stock, transfer, cycle-count) before any DB work, then projection appliers inside one transaction before the `domain_events` insert. Add the planning seam after the cycle-count seam in both phases without reordering existing semantics. [Source: `src/events/store.ts:182`; Source: `src/events/store.ts:198`; Source: `src/events/store.ts:219`; Source: `src/events/store.ts:235`]
- `src/read/projections/item_master.ts` is SKU-grain and carries `variance_tolerance_percent` and `count_variance_tolerance_percent` but NO lead-time, safety-stock, service-level, or reorder fields, and it is not location-aware. Planning parameters are per SKU-location, so they belong in a NEW `inventory_planning_params` projection, not on `item_master`. Do not widen `item_master` to a SKU-location grain. [Source: `src/read/projections/item_master.ts:24`; Source: `src/read/projections/item_master.ts:40`]
- `src/compliance/stock-balance.ts` accepts only `stock.received`, `stock.allocated`, and `stock.issued`, gated narrowly to inventory-stream events referencing both a SKU and a target location. If Task 3 stamps `last_issue_at`, do it inside the existing `stock.issued` projection application (`src/read/projections/stock_balance.ts`) without disturbing the generated `available` column or the `(sku, location_id, lot_id, stock_class)` grain. [Source: `src/compliance/stock-balance.ts:34`; Source: `read/projections/stock_balance.sql:18`]
- `src/compliance/inventory-valuation.ts` owns NRV write-down/recovery. It is the ONLY place write-down math, the recovery cap, and DOA authorisation run. Obsolescence "NRV testing triggered" is a flag plus alert here - it must not compute or post a write-down. [Source: `src/compliance/inventory-valuation.ts:34`; Source: `src/compliance/inventory-valuation.ts:288`]
- `src/notify/emit.ts` exposes `emitNotification()` (non-transactional) and `emitNotificationInTransaction(input, client)` (part of a business transaction). Use the transactional entry point for replenishment and obsolescence alerts so the alert commits with the event. The input carries `target: { role, location_id }`, `category`, `actor`, and optional `correlation_id`. [Source: `src/notify/emit.ts:65`; Source: `src/notify/emit.ts:103`]
- `src/notify/dispatch.ts`, `escalate.ts`, and `expire.ts` are the established "cycle function invoked without a scheduler" pattern (`runDispatchCycle`, `runEscalationCycle`, `runExpiryCycle`). Model the three planning jobs on them: pure functions callable from an HTTP trigger now and a scheduler later. [Source: `src/notify/dispatch.ts:1`; Source: `src/server.ts:107`]
- `src/server.ts` registers routes explicitly and the Story 1.9 route-surface test asserts exact route equality. Register every new route and update the guard. [Source: `src/server.ts:90`; Source: `src/server.ts:107`]

### File Structure Requirements

Likely UPDATE files, per the table titled "Planning story touch points":

| File | Reason |
| --- | --- |
| `src/events/store.ts` | Wire planning assert and projection seams |
| `src/events/schema.ts` | Add planning event interfaces and `SUPPORTED_EVENT_TYPES` entries |
| `src/events/migrate.ts` | Register new projection SQL |
| `src/read/projections/stock_balance.ts` | Stamp `last_issue_at` on `stock.issued` (Task 3) |
| `read/projections/stock_balance.sql` | Add `last_issue_at` column if extending stock_balance |
| `src/server.ts` | Register planning routes |
| `src/sync/upload.ts` | Classify new permanent business errors |
| `edge/src/sync/connector.ts` | Mirror new permanent business errors |
| `edge/src/messages/en.json` | Add localized messages |
| `deploy/compose/init-db.sql` | Mirror new DDL safely |
| `test/integration/story-1-9.test.ts` | Update route surface |
| `test/integration/story-2-2.test.ts` | `last_issue_at` and invariant regression |
| `test/unit/schema-drift.test.ts` | New projection drift expectations |
| `test/unit/sync-upload.test.ts` and `edge/test/unit/connector.test.ts` | New error classification |

Likely NEW files: `src/compliance/inventory-planning.ts`, `src/api/v1/inventory-planning.ts`, `src/read/projections/inventory_planning.ts`, `src/read/projections/replenishment_recommendation.ts`, `src/read/projections/obsolescence_flag.ts`, `read/projections/inventory_planning.sql`, `read/projections/replenishment_recommendation.sql`, `read/projections/obsolescence_flag.sql`, and `test/integration/story-2-7.test.ts`.

### API Contract

The endpoints are summarized in the table titled "Story 2.7 REST surface".

| Method and path | Body or filters | Behavior |
| --- | --- | --- |
| `POST /api/v1/planning/params` | `{ sku, location_id, lead_time_days, lead_time_source, service_level, obsolescence_threshold_days, standard_order_qty, demand_window_days?, business_stream }` | Sets or updates SKU-location planning config |
| `GET /api/v1/planning/params/:sku` | `location_id?` | Returns planning params and last computation |
| `POST /api/v1/planning/safety-stock/compute` | `{ location_id?, sku?, business_date }` | Runs the safety-stock/reorder computation over scope |
| `POST /api/v1/planning/replenishment/check` | `{ location_id?, sku?, business_date }` | Runs the reorder-point check over scope |
| `GET /api/v1/planning/replenishment/recommendations` | `location_id?`, `sku?`, `status?` | Lists open replenishment recommendations |
| `POST /api/v1/planning/obsolescence/scan` | `{ location_id?, sku?, business_date }` | Runs the obsolescence scan over scope |
| `GET /api/v1/planning/obsolescence/report` | `location_id?`, `from_date?`, `to_date?`, `status?` | Aging exception report with disposition and NRV-testing status |

### Event Contract Guidance

Suggested event contracts (all `stream_type: "inventory"`):

- `inventory_planning.params_set`: `planning_params_id`, `sku`, `location_id`, `lead_time_days`, `lead_time_source`, `service_level`, `obsolescence_threshold_days`, `standard_order_qty`, `demand_window_days`, `business_stream`, `set_by_actor_id`.
- `inventory_planning.safety_stock_computed`: `computation_id`, `sku`, `location_id`, `safety_stock`, `reorder_point`, `computation_inputs` (sigma_daily, avg_daily_demand, z, service_level, lead_time_days, lead_time_source, demand_window_days, sample_day_count), `computed_at`, `business_date`.
- `replenishment.recommended`: `recommendation_id`, `sku`, `location_id`, `on_hand_at_check`, `reorder_point`, `recommended_order_qty`, `triggered_at`, `business_date`.
- `obsolescence.flagged`: `obsolescence_flag_id`, `sku`, `location_id`, `last_issue_at`, `days_since_issue`, `threshold_days`, `disposition_status`, `nrv_testing_triggered`, `flagged_at`, `business_date`.
- `obsolescence.cleared`: `obsolescence_flag_id`, `sku`, `location_id`, `cleared_at`, `reason`, `business_date`.

### Data Integrity Guardrails

- Never post an NRV write-down from planning code. Obsolescence triggers NRV testing (a flag plus alert); the write-down stays DOA-gated in `src/compliance/inventory-valuation.ts`.
- Do not create purchase-order or requisition records; Phase-1 emits recommendations only (Epic 4 owns POs).
- Do not widen `item_master` to a SKU-location grain; planning params are a new location-aware projection.
- Only `stock.issued` resets the obsolescence clock. Receipts, allocations, transfers, and adjustments do not count as issue activity.
- Reproduce every computation from its recorded `computation_inputs`; store the inputs, never just the outputs.
- Use SQL NUMERIC for quantity comparisons; JavaScript floating-point on quantities and monetary values has been a recurring review defect in Stories 2.4 and 2.6.
- Do not use `toISOString().slice(0, 10)` for local statutory business dates; use local date components as Story 2.6 established.
- Jobs must be idempotent and concurrency-safe: re-running over unchanged state creates no duplicate events, recommendations, flags, or alerts, and concurrent runs for the same grain do not double-emit.

### Previous Story Intelligence

Story 2.6 code review (two adversarial passes, 30 patches) surfaced patterns that apply directly here:

- Direct-event paths trust forgeable payload actors; approval/authority must resolve from the authenticated actor and DOA, not the payload.
- Central-seam gating on a discriminating field (Story 2.6 gated `stock.adjusted` on `adjustment_id`) keeps legacy spine fixtures passing. Gate the planning seam narrowly on the new event types so the Story 1.9 spine gate stays green.
- Monetary and quantity math must round-trip through NUMERIC, not JavaScript numbers.
- New stable errors must be added to backend sync, edge sync, and edge i18n together, with tests.
- New route surfaces must be added to the Story 1.9 route guard.
- Notifications that are part of a business fact use the transactional emit entry point.

Recent commits confirm the mature pattern: Story 2.6 (`f23c59f`) built on Story 2.5 transfers (`a5b033f`, `3be7fc2`) and Story 2.4 valuation (`a76aa46`, `eda5b5c`). Treat these as the house style, not optional examples.

### Latest Technical Information

No dependency upgrade is required. The stack is pinned (Node.js 24 LTS, PostgreSQL 18.4, PowerSync 1.23.x, Next.js 16, TypeScript 5.x). The safety-stock formula needs only `Math.sqrt` and `Math.ceil` plus a static `z`-score lookup for the four supported service levels; do not add a statistics or normal-distribution library. Reorder detection and quantity comparisons use built-in PostgreSQL NUMERIC, transactions, `FOR UPDATE`, generated columns, and `UNIQUE NULLS NOT DISTINCT`. No scheduler is introduced; the three job endpoints are the Phase-1 trigger surface.

### Testing Requirements

Run before marking done:

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run edge:typecheck`
- `npm run edge:lint`
- `npm run edge:test`
- `npm run spine-acceptance-contract`
- `git diff --check`

Integration tests require the PostgreSQL container running. The harness runs serially with `--test-concurrency=1` and uses the audit-trigger escape hatch around `TRUNCATE`, matching the Story 2.5 and 2.6 test pattern.

## Project Structure Notes

- The story aligns with the existing custom greenfield, event-sourced architecture. No starter template or framework migration is involved.
- Planning logic belongs in `src/compliance/`, `src/api/v1/`, `src/read/projections/`, `read/projections/`, and tests. Do not create a separate top-level module.
- Projection SQL files must be canonical and self-sufficient; first-boot compose SQL mirrors them.
- The three jobs are batch cycle functions decoupled from HTTP handlers so a future scheduler (out of scope) can invoke them directly, matching the `src/notify/` cycle pattern.

## References

- Story definition and ACs: `_bmad-output/planning-artifacts/epics.md:1107`
- FR-I-03, FR-I-07, FR-I-08 lines: `_bmad-output/planning-artifacts/epics.md:32`; `_bmad-output/planning-artifacts/epics.md:37`
- Dashboard consumers: `_bmad-output/planning-artifacts/epics.md:3161`; `_bmad-output/planning-artifacts/epics.md:3163`; `_bmad-output/planning-artifacts/epics.md:3195`
- Central write path and seam wiring: `src/events/store.ts:160`; `src/events/store.ts:198`; `src/events/store.ts:235`
- Item master (SKU-grain, no planning fields): `src/read/projections/item_master.ts:24`
- Stock balance grain and invariants: `read/projections/stock_balance.sql:18`; `src/compliance/stock-balance.ts:34`
- NRV/valuation DOA-gated seam: `src/compliance/inventory-valuation.ts:34`; `src/compliance/inventory-valuation.ts:288`
- Notification transactional emit: `src/notify/emit.ts:103`
- Job cycle pattern: `src/notify/dispatch.ts:1`
- Cycle-count seam template: `src/compliance/cycle-count.ts`; `_bmad-output/implementation-artifacts/2-6-cycle-counting-and-physical-inventory.md`
- Sync error classification: `src/sync/upload.ts:17`; `edge/src/sync/connector.ts:22`

## Dev Agent Record

### Agent Model Used

Opus 4.8 (1M context) - claude-opus-4-8[1m]

### Debug Log References

- Verification battery run 2026-07-22: `npx tsc --noEmit` clean, `npm run lint` clean, `npm run build` clean, `npm test` 301/301, `npm run edge:typecheck` clean, `npm run edge:lint` clean, `npm run edge:test` 14/14, `npm run spine-acceptance-contract` 6/6, `git diff --check` clean.
- Backend test count moved 280 to 301 (12 new Story 2.7 integration tests, 1 new Story 2.2 last_issue_at regression test, 3 new schema-drift table checks, 5 new sync-upload error-code checks).

### Completion Notes List

- Delivered FR-I-07 (safety-stock computation), FR-I-03 reorder points and replenishment recommendations, and the flagging half of FR-I-08 (aging/obsolescence flags feeding NRV testing). Recommendation-only (no PO, Epic 4); disposition deferred (Epic 16); NRV write-down stays DOA-gated in the Story 2.4 valuation seam (planning only flags and alerts).
- Three new location-aware projections at SKU-location grain: `inventory_planning_params`, `replenishment_recommendation` (one open per grain via a partial unique index), `obsolescence_flag`. All canonical SQL is registered in `src/events/migrate.ts` and mirrored byte-for-byte in `deploy/compose/init-db.sql`; the `powersync_publication` block was left untouched.
- Central `applyInventoryPlanningProjection` seam wired into `persistEvent()` after the cycle-count seam (pre-transaction shape assert plus in-transaction projection), gated narrowly to the five new `inventory` event types so DOA, SCIM, audit, stock, valuation, transfer, and cycle-count events are byte-for-byte unaffected and the Story 1.9 spine gate stays green.
- Safety stock computes as `ceil(z(service_level) x sigma_daily x sqrt(lead_time_days))` in SQL NUMERIC; the AC1 worked example resolves to exactly 20 and reorder point to 146. `z` comes from a static four-value lookup; unlisted service levels fail with `INVALID_SERVICE_LEVEL`, missing lead time with `LEAD_TIME_NOT_CONFIGURED`, and too little history with `INSUFFICIENT_DEMAND_HISTORY` (without overwriting a prior valid computation). Every computation stores a reproducible `computation_inputs` snapshot.
- The reorder-crossing and obsolescence-transition decisions run in the batch jobs (`src/compliance/planning-jobs.ts`) under a `FOR UPDATE` lock on the params row, so concurrent runs cannot create duplicate open recommendations or double flags, and re-running over unchanged state emits no duplicate events, recommendations, flags, or alerts. Planner alerts are raised transactionally via `emitNotificationInTransaction()`.
- Obsolescence keys off `stock.issued` only: a new `last_issue_at` column on `stock_balance` is stamped on issue (monotonic via `GREATEST`) and never on receipts/allocations/transfers/adjustments; the Story 2.2 `on_hand`/`allocated`/`available`/`in_transit` invariants are unchanged (proven by a new Story 2.2 regression test).
- The three synthetic job endpoints (`.../compute`, `.../check`, `.../scan`) mirror the `src/notify` cycle pattern; the cycle functions are decoupled from the HTTP handlers so a future scheduler can call them directly. Five new stable errors were added to backend sync, edge sync, and edge i18n together with tests; the seven new routes were added to the Story 1.9 route-surface guard.

### File List

New files:

- `read/projections/inventory_planning.sql`
- `read/projections/replenishment_recommendation.sql`
- `read/projections/obsolescence_flag.sql`
- `src/read/projections/inventory_planning.ts`
- `src/read/projections/replenishment_recommendation.ts`
- `src/read/projections/obsolescence_flag.ts`
- `src/compliance/inventory-planning.ts`
- `src/compliance/planning-jobs.ts`
- `src/api/v1/inventory-planning.ts`
- `test/integration/story-2-7.test.ts`

Modified files:

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/read/projections/stock_balance.ts`
- `read/projections/stock_balance.sql`
- `src/compliance/stock-balance.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `deploy/compose/init-db.sql`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-2-2.test.ts`
- `test/unit/schema-drift.test.ts`
- `test/unit/sync-upload.test.ts`
- `edge/test/unit/connector.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date | Change |
| --- | --- |
| 2026-07-22 | Implemented Story 2.7 (Safety Stock, Reorder Points, and Obsolescence Flagging): three SKU-location planning projections, central inventory-planning seam in `persistEvent()`, safety-stock/reorder-point computation, replenishment check with transactional planner alert, obsolescence scan with NRV-testing trigger and clear, seven RBAC/location-scoped REST endpoints, `last_issue_at` activity tracking on `stock.issued`, five new stable errors across backend/edge sync and i18n, and full test coverage. Verification battery green (301/301 backend, 14/14 edge, 6/6 spine). Status moved to review. |
| 2026-07-22 | Code review (3-layer adversarial: Blind Hunter, Edge Case Hunter, Acceptance Auditor) over the uncommitted working tree. 2 decision-needed resolved to patch, 11 patch applied, 3 defer, 8 dismissed. Verification battery green (308/308 backend, 14/14 edge, 6/6 spine; tsc/lint/build/diff-check clean). Status moved to done. |

## Review Findings

Adversarial code review of 2026-07-22 (Blind Hunter, Edge Case Hunter, Acceptance Auditor over the uncommitted Story 2.7 working tree). Acceptance criteria happy paths, the 7-endpoint REST surface, the 5-event contract, the 5 stable errors across all three surfaces, and the AC1 worked example (safety stock 20, reorder point 146) are all satisfied in code and tests. The patch items below are resolved; deferred items remain tracked separately.

- [x] [Review][Patch] Never-issued stock is never obsolescence-flagged (AC3 gap) - `scanOneGrain` returns early when `MAX(last_issue_at) IS NULL` [src/compliance/planning-jobs.ts:417], so never-issued dead stock is permanently exempt. Resolved (decision 1 to option 1): start the obsolescence clock from a fallback (params `created_at`, else earliest `stock.received` for the grain) so a never-issued item past the threshold is flagged. [src/compliance/planning-jobs.ts:404]
- [x] [Review][Patch] Direct `POST /api/v1/events` and edge upload do not location-RBAC-check the planning payload `location_id` - a location-A planner can post `inventory_planning.params_set` / `safety_stock_computed` / `obsolescence.flagged` with `payload.location_id` = location B and mutate location B state. Resolved (decision 2 to option 1): enforce `payload.location_id` against the actor's permitted write locations on the events and edge paths for the planning event types. [src/api/v1/events.ts:56; src/compliance/inventory-planning.ts]
- [x] [Review][Patch] Safety-stock compute path takes no FOR UPDATE lock and runs in its own transaction, so two concurrent computes for one grain both emit `safety_stock_computed` (contradicts Task 4 and guardrail on concurrency-safety) [src/compliance/planning-jobs.ts:108]
- [x] [Review][Patch] Cross-location write allowed with only read access at the target location: `assertLocationAccess` uses read-or-write locations, so write@locA + read@locB can set params/compute/scan at locB [src/api/v1/inventory-planning.ts:72]
- [x] [Review][Patch] Demand statistics ignore `stock.issued` events keyed by `target_location_code`, understating demand or forcing a false `INSUFFICIENT_DEMAND_HISTORY` [src/compliance/planning-jobs.ts:145]
- [x] [Review][Patch] Reorder and obsolescence queries sum across all `stock_class` values, so future consignment/vmi/job_work balances would count toward owned-stock reorder and the obsolescence clock [src/compliance/planning-jobs.ts:283]
- [x] [Review][Patch] Partial `params_set` silently wipes unset config fields (`demand_window_days` back to 90, `lead_time_days`/`obsolescence_threshold_days`/`standard_order_qty` to null), contradicting the helper's own preserve-caller-unset contract [src/read/projections/inventory_planning.ts:160]
- [x] [Review][Patch] Obsolescence scan response hardcodes `days_since_issue: 0` for every flag even though the persisted flag has the real value [src/compliance/planning-jobs.ts:384]
- [x] [Review][Patch] `lead_time_days` shape bound (1e12) exceeds the `NUMERIC(9,3)` column, so a large valid-shape value overflows on insert as an uncaught 500 instead of a clean 400 [src/compliance/inventory-planning.ts:112]
- [x] [Review][Patch] `replenishment.recommended` shape accepts `recommended_order_qty = 0` on the direct events path, allowing a useless zero-quantity open recommendation to occupy the one-open-per-grain slot [src/compliance/inventory-planning.ts:157]
- [x] [Review][Patch] `getObsolescenceFlag` does not enforce the `forUpdate`-requires-client contract (unlike `getPlanningParams`), so a `FOR UPDATE` on a pool connection would silently no-op [src/read/projections/obsolescence_flag.ts:66]
- [x] [Review][Defer] `reorder_point` could overflow `NUMERIC(18,6)` at extreme demand/lead inputs [src/compliance/planning-jobs.ts:169] - deferred, shared quantity-bound hardening pass
- [x] [Review][Defer] Minimum sample-day guard is hardcoded (`DEFAULT_MIN_SAMPLE_DAYS = 2`) rather than configured per Task 5 [src/compliance/planning-jobs.ts:45] - deferred, needs a DDL/config field decision
- [x] [Review][Defer] Aging and demand-window clock use `now()` instead of `scope.business_date`, so a backdated or replayed job uses wall-clock time [src/compliance/planning-jobs.ts:146] - deferred, revisit when a scheduler replaces the synthetic Phase-1 trigger
