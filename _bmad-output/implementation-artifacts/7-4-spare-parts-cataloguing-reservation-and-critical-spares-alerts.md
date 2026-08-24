---
baseline_commit: 893e9456d11ea36ce23e2cb3a43dbd7065980a63
---

# Story 7.4: Spare Parts Cataloguing, Reservation, and Critical-Spares Alerts

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-25. Comprehensive developer guide created from epics.md (Story 7.4, FR-M-07, FR-M-08, FR-M-09), ARCHITECTURE-SPINE.md (AD-4, AD-9, AD-14, AD-16, AD-17), the Stories 7.1/7.2/7.3 maintenance tree, the Epic 2 stock ledger (stock_balance, applyStockAllocation/Issue/Deallocation/Receipt), the Story 2.7 planning-job pattern, the Story 4.2 business-day helper and a baseline code audit at 893e945. The maintenance stream, the asset projection, maintenance_work_order, five compliance seams, the POST-triggered job pattern and the maintenance REST module ALL exist. This story adds the maintenance-owned asset parts list, the spare catalogue with min-max levels, the reserve/issue/return lifecycle riding the Epic 2 ledger, and the daily breach-and-overdue scan on top of them. -->

## Story

As a maintenance storekeeper,
I want spares catalogued in inventory with where-used links from a maintenance-owned asset parts list, reservation and issue with timed returns, and critical-spares min-max alerts,
So that the right spares are on hand when a work order needs them.

## Acceptance Criteria

1. **Given** an asset from Story 7.1 (FR-M-07), **When** its spare parts are defined, **Then** a maintenance-owned asset parts list (equipment BOM) is recorded against the asset register - a distinct entity from the Epic 5 manufacturing BOM, created in this story - and each spare shows where-used across the assets whose parts lists reference it.
2. **Given** spare parts used in maintenance (FR-M-07, FR-M-08), **When** they are catalogued in inventory, **Then** each spare is catalogued under the Epic 2 stock ledger (per FR-I) and can be reserved and issued against a work order, with returns due within 3 working days.
3. **Given** a critical spare with defined min-max levels (FR-M-09), **When** stock breaches the minimum, **Then** a same-day breach alert is raised.

## Tasks / Subtasks

- [x] Task 1: Database schema for the four new projections (AC: 1, 2, 3)
  - [x] 1.1 Create `read/projections/maintenance_spare_catalogue.sql` following the exact shape of `read/projections/maintenance_sla_policy.sql`: canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks, `CREATE INDEX IF NOT EXISTS`, guarded `pg_roles` grants block.
  - [x] 1.2 Create `read/projections/asset_parts_list.sql` with the same shape and a `sku` index for the where-used read.
  - [x] 1.3 Create `read/projections/maintenance_spare_reservation.sql` with the same shape.
  - [x] 1.4 Create `read/projections/maintenance_spare_alert.sql` with the same shape.
  - [x] 1.5 Mirror all four files verbatim into `deploy/compose/init-db.sql`, appended in the same order.
  - [x] 1.6 Register the four files in the `MIGRATIONS` tail of `src/events/migrate.ts`.
  - [x] 1.7 Add all four tables plus every named constraint and index to `EXPECTED` in `test/unit/schema-drift.test.ts`.
  - [x] 1.8 Verify `npm run db:migrate` twice is idempotent.
- [x] Task 2: Event contracts (AC: 1, 2, 3)
  - [x] 2.1 Add the eight payload interfaces and envelope types to `src/events/schema.ts` in a Story 7.4 block after the Story 7.3 block.
  - [x] 2.2 Register all eight in `SUPPORTED_EVENT_TYPES` with `streamType: 'maintenance'` and `requiresBusinessStream: false`.
  - [x] 2.3 Confirm every event id field is a UUID and every declared derivable field is listed for cross-checking.
- [x] Task 3: Read projections and accessors (AC: 1, 2, 3)
  - [x] 3.1 Create `src/read/projections/maintenance_spare_catalogue.ts` with insert, get-by-grain with `FOR UPDATE`, and a paginated list.
  - [x] 3.2 Create `src/read/projections/asset_parts_list.ts` with insert, get-by-grain with `FOR UPDATE`, list-by-asset, and `listWhereUsedBySku`.
  - [x] 3.3 Create `src/read/projections/maintenance_spare_reservation.ts` with insert, get-by-id with `FOR UPDATE`, state-transition updates, a paginated list supporting the `return_overdue` filter, and `listOverdueReturns(business_date)`.
  - [x] 3.4 Create `src/read/projections/maintenance_spare_alert.ts` with insert and a paginated list.
  - [x] 3.5 Every accessor reads NUMERIC columns as strings out of pg and converts explicitly; no implicit float coercion on quantities.
- [x] Task 4: Compliance seam (AC: 1, 2, 3)
  - [x] 4.1 Create `src/compliance/maintenance-spares.ts` structurally identical to `src/compliance/maintenance-fault.ts`: stream gate, pure `assertMaintenanceSpareShape(envelope)`, `applyMaintenanceSpareProjection(envelope, client)` switch, `alreadyPersisted` guard, `reject()` helper.
  - [x] 4.2 Implement the eight appliers with the FIXED lock order in the Locking Contract below.
  - [x] 4.3 Call the Epic 2 ledger helpers, never raw stock SQL: `applyStockAllocation` on reserve, `applyStockDeallocation` then `applyStockIssue` on issue, `applyStockDeallocation` on cancel, `applyStockReceipt` on return.
  - [x] 4.4 Wire the seam into `src/events/store.ts` alongside the 7.3 seam, and add a duplicate resolver to the 23505 mapper for each new unique index.
- [x] Task 5: Business-day return clock (AC: 2)
  - [x] 5.1 Add `addBusinessDays(startDate, days, holidayDates)` to `src/lib/business-days.ts`, the single source of business-day arithmetic. Do NOT write a second copy in the seam, the routes, the job or the tests.
  - [x] 5.2 Extract the fail-closed holiday parser in `src/config/index.ts` into a shared local function and add `config.maintenance.spareReturnHolidayCalendar` from `MAINTENANCE_SPARE_RETURN_HOLIDAYS`, defaulting to an empty list.
  - [x] 5.3 Add `test/unit/business-days.test.ts` cases for `addBusinessDays`: Sunday skip, holiday skip, three-day span from a Thursday, zero days.
- [x] Task 6: Spares job module (AC: 3)
  - [x] 6.1 Create `src/maintenance/spares-jobs.ts` following `src/maintenance/pm-jobs.ts`: POST-triggered, explicit `business_date`, scope narrowed in SQL, separate write and delivery counters.
  - [x] 6.2 Implement `runCriticalSpareBreachScan(scope)` per the Breach Scan Contract.
  - [x] 6.3 Implement `runOverdueReturnSweep(scope)` per the Return Clock Contract, returning `reservations_swept` and `escalations_raised` as separate counters.
- [x] Task 7: REST surface (AC: 1, 2, 3)
  - [x] 7.1 Add the twelve handlers listed in the API Contract to `src/api/v1/maintenance.ts`, each wrapped in `requireRole({ module: 'maintenance', functionScope: ... })`.
  - [x] 7.2 Register all twelve in `createAppRouter` in `src/server.ts`, static segments before parameter segments.
  - [x] 7.3 Add all twelve to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
  - [x] 7.4 Emit the two notifications defined in the Notification Contract after their events commit.
- [x] Task 8: Tests (AC: 1, 2, 3)
  - [x] 8.1 Create `test/integration/story-7-4.test.ts` bootstrapped exactly as `test/integration/story-7-3.test.ts`.
  - [x] 8.2 One failing-first test per acceptance criterion, plus one test per error code in the Error Code Contract.
  - [x] 8.3 A replay test per write route asserting the same resource returns and the `domain_events` count does not grow.
  - [x] 8.4 A ledger-invariant test asserting `available = on_hand - allocated` after each of reserve, issue, return and cancel.
  - [x] 8.5 Provision a `maintenance_storekeeper` user in the harness and assert the breach alert produces a notification delivery row for that user, not merely a persisted event.
  - [x] 8.6 Regression: Stories 7.1, 7.2 and 7.3 suites and the Epic 2 stock suites pass unchanged.
- [x] Task 9: Ledger entries (AC: 1, 2, 3)
  - [x] 9.1 Log the out-of-scope items named in Binding Scope Decisions to `_bmad-output/implementation-artifacts/deferred-work.md` under a Story 7.4 heading.

## Dev Notes

### Binding Scope Decisions

- This story builds on Stories 7.1, 7.2, 7.3 and the Epic 2 stock ledger. The `maintenance` stream, the `asset` projection, `maintenance_work_order`, the `src/compliance/asset.ts` / `asset-meter.ts` / `maintenance-plan.ts` / `maintenance-fault.ts` / `maintenance-reliability.ts` seams, the `src/maintenance/pm-jobs.ts` and `reliability-jobs.ts` job modules and the `src/api/v1/maintenance.ts` REST module ALL exist. REUSE them. Do not create a second asset concept, a second maintenance API module, a second job convention or a second notification channel.
- The asset parts list is a MAINTENANCE-owned entity in a NEW table. It is NOT the Epic 5 `bom` / `bom_revision` / `bom_line` tree. AD-4 makes the BOM module the system of record for manufacturing structure with an outbound-only ERP contract, revision lifecycle, release gates and immutability rules; an equipment parts list has none of those and must not inherit them. Epic 5 code is READ-ONLY for this story. Touching `bom*.sql`, `src/engineering/`, or any `bom.*` event is out of scope and will break the Story 5.2 immutability suite.
- No new inventory mechanics. The epics note is explicit: cataloguing, reservation and issue "ride on the Epic 2 stock ledger". Every quantity movement goes through the exported helpers in `src/read/projections/stock_balance.ts`. Do NOT write `UPDATE stock_balance` from the maintenance seam, do NOT add a maintenance-private balance column, and do NOT invent a `maintenance` stock class - reservations draw from `owned`.
- Reservation IS `stock_balance.allocated`. That column plus the generated `available = on_hand - allocated` is the reservation mechanic this codebase already has; a parallel maintenance reservation quantity would double-count. The new `maintenance_spare_reservation` table records the maintenance-side FACTS (which work order, who, when, when due back) and is never an authoritative balance.
- Issue ordering is DEALLOCATE FIRST, THEN ISSUE. `applyStockIssue` gates on `SUM(available) >= quantity`, and `available` is net of the allocation this reservation is holding, so issuing before releasing compares the requested quantity against stock the reservation itself has already removed from `available` and fails with a spurious `INSUFFICIENT_STOCK` whenever the reserved quantity is the only free stock. `src/compliance/transfer-request.ts` calls issue before deallocate; that ordering is a known divergence in a flow with slack stock and must NOT be copied here. Assert the ordering with a test that reserves the entire available quantity and then issues it.
- Catalogue grain is `(sku, location_id)`. Min-max levels are per stocking location, exactly like the Epic 2 planning params, because a spare can be critical at the plant store and irrelevant at a hub. Do NOT widen `inventory_planning_params`: its `safety_stock` and `reorder_point` are COMPUTED outputs of `runSafetyStockComputation` reproducible from `computation_inputs`, and an operator-typed min-max written into those columns would be silently overwritten by the next Story 2.7 computation.
- The parts list grain is `(asset_id, sku)` with one table and no header row. A header would carry a revision lifecycle nobody asked for; the AC needs exactly "which spares does this asset take" and "which assets take this spare". Where-used is a reverse index on `sku` over the same table, not a second projection.
- Same-day breach alerting is a POST-triggered job with an explicit `business_date`, NOT cron. This is the codebase-wide convention (`runSafetyStockComputation`, `runReplenishmentCheck`, `runObsolescenceScan`, the PM generation and grace sweep, the reliability report). The only `setInterval` in the process is the Story 1.11 notification dispatcher. Do NOT add `node-cron`, a timer, or a container. "Same-day" means the alert carries the scan's `business_date` and `uq_maintenance_spare_alert_day` makes one alert per grain per day.
- Returns are a due DATE plus a sweep, not a lock. Three working days is computed once at issue time and frozen onto the row; recomputing it later would move a deadline the storekeeper was already given. An overdue return raises an escalation through the same job module, because a `return_due_date` column with nothing reading it is a dead column that fails the AC in spirit.
- Reservation cancellation IS in scope even though no AC names it. Without it a reserved-but-never-issued spare holds `allocated` forever and the location's `available` decays permanently on every abandoned work order. A story implementation must leave the system working end to end.
- Out of scope, log each to `deferred-work.md`: removing or amending an asset parts-list line (no AC; a second POST on an occupied `(asset_id, sku)` key returns 409), superseding a catalogue row's min-max (same treatment), partial issue against a reservation (issue is all-or-nothing on the reserved quantity), damaged-return disposition and scrap routing (Epic 8 quality holds), spares cost accumulation onto the work order (Story 7.6, FR-M-15), offline spares-issue confirmation (Story 7.8), and warranty checks at reservation time (Story 7.7).

### Event Contract

Table 1 lists the eight new events. All eight are on the `maintenance` stream with `requiresBusinessStream: false`.

| **Event type** | **Key payload fields** | **Projection effect** |
| --- | --- | --- |
| `maintenance.spare_catalogued` | `catalogue_id`, `sku`, `location_id`, `is_critical`, `min_level`, `max_level` | Inserts one `maintenance_spare_catalogue` row |
| `maintenance.asset_part_listed` | `part_line_id`, `asset_id`, `sku`, `quantity_per`, `position_ref` | Inserts one `asset_parts_list` row |
| `maintenance.spare_reserved` | `reservation_id`, `work_order_id`, `asset_id`, `sku`, `location_id`, `lot_id`, `quantity`, `reserved_at` | Inserts the reservation at `status = 'reserved'` and calls `applyStockAllocation` |
| `maintenance.spare_issued` | `reservation_id`, `quantity`, `issued_at`, `return_due_date`, `business_date` | Flips to `issued`, stamps the return clock, calls `applyStockDeallocation` then `applyStockIssue` |
| `maintenance.spare_returned` | `reservation_id`, `quantity_returned`, `returned_at` | Flips to `returned` or `partially_returned` and calls `applyStockReceipt` |
| `maintenance.spare_reservation_cancelled` | `reservation_id`, `cancellation_reason`, `cancelled_at` | Flips to `cancelled` and calls `applyStockDeallocation` |
| `maintenance.critical_spare_breach_flagged` | `alert_id`, `sku`, `location_id`, `on_hand_at_check`, `min_level`, `business_date`, `flagged_at` | Inserts one `maintenance_spare_alert` row of `alert_type = 'min_breach'` |
| `maintenance.spare_return_overdue_flagged` | `alert_id`, `reservation_id`, `sku`, `location_id`, `return_due_date`, `business_date`, `flagged_at` | Inserts one `maintenance_spare_alert` row of `alert_type = 'return_overdue'` |

Every payload field that the applier can derive from a locked row is DECLARED in the payload and CHECKED against the derivation, never trusted. Divergence rejects with `SPARE_DERIVATION_MISMATCH` 409. This is the Story 7.2 Group 2 decision and the Story 7.3 `WORK_ORDER_DERIVATION_MISMATCH` pattern applied unchanged: a declared-but-unchecked field is a silent corruption channel on the direct `POST /api/v1/events` path.

### Locking Contract

Every applier that mutates more than one row takes `SELECT ... FOR UPDATE` in this FIXED order, so two concurrent commands on the same reservation can never deadlock: asset, then catalogue row, then work order, then reservation, then stock balance rows. The ledger helpers take their own `FOR UPDATE` internally, so `applyStockAllocation`, `applyStockIssue`, `applyStockDeallocation` and `applyStockReceipt` must be the LAST database calls in any applier that uses them.

### Reservation Lifecycle Contract

Table 2 defines the state machine. Any transition not listed rejects; no applier silently no-ops on a state it should reject, per the Story 7.2 Group 2 decision.

| **From state** | **Command** | **To state** | **Ledger effect** |
| --- | --- | --- | --- |
| (none) | reserve | `reserved` | `allocated` increases by the reserved quantity |
| `reserved` | issue | `issued` | `allocated` decreases, then `on_hand` decreases, both by the reserved quantity |
| `reserved` | cancel | `cancelled` | `allocated` decreases by the reserved quantity |
| `issued` | return | `returned` when the returned quantity equals the issued quantity, else `partially_returned` | `on_hand` increases by the returned quantity |
| `partially_returned` | return | `returned` when cumulative returns equal the issued quantity, else `partially_returned` | `on_hand` increases by the returned quantity |
| `returned` or `cancelled` | any | rejects | none |

Reservation preconditions, all checked under the lock: the work order exists and its `status` is `open` or `overdue` (a completed work order cannot take new spares, error `WORK_ORDER_NOT_OPEN`); the spare is catalogued at that location (`SPARE_NOT_CATALOGUED` 422, never a silent auto-catalogue); the quantity is a positive NUMERIC within the `MAX_QUANTITY` ceiling already used by `src/compliance/stock-balance.ts`. `INSUFFICIENT_STOCK` 409 raised by `applyStockAllocation` propagates unchanged - do not catch and re-wrap it, the Epic 2 detail payload is the useful one.

### Return Clock Contract

`return_due_date` is computed exactly once, inside the issue applier, as `addBusinessDays(istCalendarDateOf(issued_at), 3, config.maintenance.spareReturnHolidayCalendar)`. The working week is the IST calendar Monday through Saturday, matching `businessDaysBetween`; Sundays and configured holidays do not count. The value is stored as a DATE and never recomputed on read. Derive the IST calendar date with `toIstCalendarDate`, never with a bare `slice(0, 10)` on an ISO string: the repo has a live, documented family of clock-window failures from exactly that shortcut.

`runOverdueReturnSweep` selects reservations with `status IN ('issued', 'partially_returned') AND return_due_date < $business_date`, narrowed in SQL and not by a JS filter after the fact, so the counters describe what was actually evaluated. It emits one `maintenance.spare_return_overdue_flagged` event per reservation, guarded by `uq_maintenance_spare_alert_day` so a re-run on the same `business_date` is a no-op rather than a duplicate. It returns `reservations_swept` and `escalations_raised` as SEPARATE counters, per the Story 7.2 lesson that a dropped notification must stay visible.

### Breach Scan Contract

Table 3 defines the scan inputs and rule. Reference it directly when implementing Task 6.2.

| **Quantity** | **Definition** |
| --- | --- |
| Scan scope | `maintenance_spare_catalogue` rows with `is_critical = true` and `min_level IS NOT NULL`, optionally narrowed by `location_id` or `sku` from the request |
| `on_hand_at_check` | `COALESCE(SUM(on_hand), 0)` over `stock_balance` for that `(sku, location_id)` with `stock_class = 'owned'`, summed in SQL NUMERIC, never in JS floats |
| Breach test | `on_hand_at_check <= min_level`, evaluated in SQL as a NUMERIC comparison |
| Alert grain | One row per `(sku, location_id, business_date)`, enforced by `uq_maintenance_spare_alert_day` |
| Re-run behavior | A second scan on the same `business_date` for a still-breached grain is a no-op, not a duplicate alert and not an error |
| Recovery | A grain that is no longer breached produces no row and no retraction event; the absence of an alert on a later date is the recovery signal |

`on_hand` is the comparison basis rather than `available`, matching `runReplenishmentCheck`. A spare that is fully reserved but physically present is not a stockout, and alerting on it would fire on every large reservation. The scan holds the catalogue row under `FOR UPDATE` for the duration of its grain so two concurrent scans serialize into one alert.

### Database Schema Contract

Every new `.sql` file follows the shape of `read/projections/maintenance_sla_policy.sql` exactly: the canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks for self-healing, `CREATE INDEX IF NOT EXISTS`, and a guarded grants block that checks `pg_roles` before granting. Every statement must be safely re-appliable to a live database. Rows are derived state only: mutation happens exclusively through `persistEvent`, which applies the projection inside the SAME transaction as the `domain_events` insert.

Table 4 lists the required tables, grains and named constraints.

| **Table** | **Grain and key constraints** |
| --- | --- |
| `maintenance_spare_catalogue` | `catalogue_id` UUID primary key; `uq_maintenance_spare_catalogue_grain UNIQUE (sku, location_id)`; `chk_maintenance_spare_catalogue_levels CHECK (min_level IS NULL OR max_level IS NULL OR max_level >= min_level)`; `chk_maintenance_spare_catalogue_min_non_negative`; `chk_maintenance_spare_catalogue_critical_needs_min CHECK (is_critical = false OR min_level IS NOT NULL)`; index on `location_id` |
| `asset_parts_list` | `part_line_id` UUID primary key; `uq_asset_parts_list_grain UNIQUE (asset_id, sku)`; `chk_asset_parts_list_quantity_positive CHECK (quantity_per > 0)`; index on `sku` for the where-used read |
| `maintenance_spare_reservation` | `reservation_id` UUID primary key; `chk_maintenance_spare_reservation_status CHECK (status IN ('reserved','issued','partially_returned','returned','cancelled'))`; `chk_maintenance_spare_reservation_quantity_positive`; `chk_maintenance_spare_reservation_returned_bound CHECK (quantity_returned <= quantity)`; `chk_maintenance_spare_reservation_issue_fields CHECK (status IN ('reserved','cancelled') OR (issued_at IS NOT NULL AND return_due_date IS NOT NULL))`; indexes on `work_order_id` and on `(sku, location_id)`; partial index on `return_due_date` where `status IN ('issued','partially_returned')` |
| `maintenance_spare_alert` | `alert_id` UUID primary key; `chk_maintenance_spare_alert_type CHECK (alert_type IN ('min_breach','return_overdue'))`; `uq_maintenance_spare_alert_day UNIQUE NULLS NOT DISTINCT (alert_type, sku, location_id, reservation_id, business_date)`; index on `business_date` |

All quantity columns are `NUMERIC(18, 6)`, matching `stock_balance`. All calendar fields are `DATE`; all instants are `TIMESTAMPTZ`.

Known gate limitation, carried from the 7.2 Group 1 review: the schema-drift test compares init-db against canonical and checks that named constraints exist, but it cannot detect an EXTRA constraint added only to a CREATE body. Keep the canonical file and the init-db mirror literally identical for the new blocks rather than relying on the gate.

### Compliance Seam Contract

`src/compliance/maintenance-spares.ts` follows `src/compliance/maintenance-fault.ts` structurally:

- A stream gate returning null for non-`maintenance` streams so the seam never sees a foreign event.
- A PURE `assertMaintenanceSpareShape(envelope)` that runs pre-transaction with no database access, so a malformed event never consumes an idempotency key. It validates every declared payload field, every UUID, every enum, every numeric bound and every timestamp format. An explicit UTC offset is REQUIRED on every TIMESTAMPTZ input, per the 7.2 offset lesson.
- An `applyMaintenanceSpareProjection(envelope, client)` switch whose branches run inside `persistEvent`'s transaction and honor the Locking Contract.
- The same `alreadyPersisted` guard and the same `reject(code, message, details, status)` AppError helper, copied verbatim rather than re-derived.
- `sku` is canonicalized with `lower()` on every human-entered path before lookup and before persisting, per the Story 7.2 lesson about scanned versus typed keys. Apply the same canonicalization in the handler AND in the seam so the direct-event path cannot bypass it.
- No applier emits a notification, writes outside its transaction, or silently no-ops on a state it should reject.

### Notification Contract

Two emissions, both through `emitNotification` in `src/notify/emit.ts`, both AFTER their event commits, both non-throwing. Neither is an approval decision, so neither takes the transactional entry point (AD-17).

- Critical-spare breach (AC 3): `event_type: 'critical_spare_breach'`, `status_verb: 'Breached'`, `object_type: 'spare'`, `object_id: <alert_id>`, target `{ role: 'maintenance_storekeeper', location_id: <catalogue location> }`, `actor_label` naming the SKU and the location code, `next_step: 'Raise a replenishment order'`. No escalation definition: the scan re-raises daily while the breach persists, which is the retry path.
- Overdue return: `event_type: 'spare_return_overdue'`, `status_verb: 'Overdue'`, `object_type: 'spare_reservation'`, `object_id: <reservation_id>`, target `{ role: 'maintenance_supervisor', location_id: <reservation location> }`, `escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 86400 }`.

`actor_label` names the human-readable subject, not a raw id (the 7.2 Group 4 patch). A failed emission is logged and swallowed (AD-17): it never rolls back the business write.

`maintenance_storekeeper` is a NEW role string. The codebase currently provisions only `maintenance_manager`, `maintenance_planner`, `maintenance_supervisor` and `maintenance_technician`, and roles are free-form strings in `user_role_assignments` with no registry to validate against. A notification aimed at a role no user holds fans out to zero recipients and reports success, so the breach alert would be silently undeliverable. Provision a `maintenance_storekeeper` user in the Story 7.4 test harness and assert the notification delivery row exists for that user; a test that only asserts the event was written does not catch this.

### API Contract

Table 5 lists the twelve new routes. All are registered in `createAppRouter` and all twelve must be added to `allowedSpineRoutes`.

| **Method and path** | **Scope** | **Behavior** |
| --- | --- | --- |
| `POST /api/v1/maintenance/spares` | write | Catalogues one spare at one location with `is_critical` and min-max; 404 `ITEM_NOT_FOUND` when the SKU is absent or inactive in `item_master`; 409 `SPARE_ALREADY_CATALOGUED` |
| `GET /api/v1/maintenance/spares` | read | Filterable by `sku`, `location_id`, `is_critical`; paginated |
| `POST /api/v1/maintenance/spares/scan` | write | Runs both jobs for an explicit `business_date`, optionally narrowed by `location_id` or `sku`; returns the four counters |
| `GET /api/v1/maintenance/spares/alerts` | read | Lists persisted alerts, filterable by `alert_type`, `sku`, `location_id`, `business_date`; paginated |
| `GET /api/v1/maintenance/spares/:sku/where-used` | read | Assets whose parts lists reference the SKU; paginated |
| `POST /api/v1/maintenance/assets/:assetId/parts` | write | Adds one parts-list line; 404 `ASSET_NOT_FOUND`; 409 `ASSET_PART_ALREADY_LISTED` |
| `GET /api/v1/maintenance/assets/:assetId/parts` | read | The asset's parts list; paginated |
| `POST /api/v1/maintenance/work-orders/:workOrderId/spare-reservations` | write | Reserves a quantity at a location; 409 `WORK_ORDER_NOT_OPEN`, 422 `SPARE_NOT_CATALOGUED`, 409 `INSUFFICIENT_STOCK` |
| `GET /api/v1/maintenance/spare-reservations` | read | Filterable by `work_order_id`, `sku`, `location_id`, `status`, `return_overdue`; paginated |
| `POST /api/v1/maintenance/spare-reservations/:reservationId/issue` | write | Issues the reserved quantity and stamps the return clock; requires `business_date`; 409 `RESERVATION_NOT_RESERVED` |
| `POST /api/v1/maintenance/spare-reservations/:reservationId/return` | write | Returns all or part of the issued quantity; 409 `RESERVATION_NOT_ISSUED`, 400 `RETURN_QUANTITY_EXCEEDS_ISSUED` |
| `POST /api/v1/maintenance/spare-reservations/:reservationId/cancel` | write | Releases the allocation; 409 `RESERVATION_NOT_RESERVED` |

Route ordering matters and is the single most likely silent defect in Task 7.2. Register `/spares/scan` and `/spares/alerts` BEFORE `/spares/:sku/where-used`, or the parameter segment shadows both static routes and the scan becomes a where-used lookup for a SKU literally named "scan". Register the three `/spare-reservations/:reservationId/` action routes after the collection route, matching the Story 7.3 block.

Every write route carries an `idempotency_key`; a blank or non-string key falls back to `randomUUID()`; a cross-event-type reuse returns 409 `DUPLICATE_EVENT`. Reuse `idempotencyKeyFrom`, `replayIdOrReject` and `requireBusinessDate` from `src/api/v1/maintenance.ts` rather than writing new helpers. Every 201 body is read back BY ID, never by re-querying the newest row.

### Error Code Contract

Table 6 is the complete set of error codes this story introduces or reuses. Every code must appear in at least one test.

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `ITEM_NOT_FOUND` | 404 | The SKU does not resolve to an active `item_master` row |
| `LOCATION_NOT_FOUND` | 404 | Reused: the location id does not resolve in `location_register` |
| `ASSET_NOT_FOUND` | 404 | Reused from Story 7.2: the asset id does not resolve |
| `SPARE_ALREADY_CATALOGUED` | 409 | A catalogue row already exists for the `(sku, location_id)` grain |
| `SPARE_NOT_CATALOGUED` | 422 | Reservation attempted for a SKU not catalogued at that location |
| `INVALID_MIN_MAX` | 400 | Negative levels, `max_level` below `min_level`, or `is_critical` without a `min_level` |
| `ASSET_PART_ALREADY_LISTED` | 409 | A parts-list line already exists for the `(asset_id, sku)` grain |
| `WORK_ORDER_NOT_FOUND` | 404 | Reused from Story 7.2 |
| `WORK_ORDER_NOT_OPEN` | 409 | Reservation attempted against a completed work order |
| `INSUFFICIENT_STOCK` | 409 | Reused from the Epic 2 ledger; propagated unchanged with its detail payload |
| `RESERVATION_NOT_FOUND` | 404 | Issue, return or cancel attempted on an unknown reservation id |
| `RESERVATION_NOT_RESERVED` | 409 | Issue or cancel attempted on a reservation not in `reserved` |
| `RESERVATION_NOT_ISSUED` | 409 | Return attempted on a reservation not in `issued` or `partially_returned` |
| `RETURN_QUANTITY_EXCEEDS_ISSUED` | 400 | Cumulative returns would exceed the issued quantity |
| `SPARE_DERIVATION_MISMATCH` | 409 | A declared payload field disagrees with the value derived from locked rows |
| `DUPLICATE_SPARE_ALERT` | 409 | 23505 resolution on `uq_maintenance_spare_alert_day` |
| `DUPLICATE_EVENT` | 409 | Reused: cross-event-type idempotency-key reuse |

### Architecture Compliance

- AD-4 (BOM is system of record for structure): the asset parts list is a maintenance-owned equipment list in its own table and is explicitly NOT a BOM. No `bom.*` event, no `bom*` table and no `src/engineering/` code is written or modified.
- AD-9 (one asset register): the parts list references `asset_id` from the single register. No second asset concept.
- AD-14 (read models are shared projections): every mutation goes through `persistEvent`; projections are derived state applied in the same transaction. No raw SQL mutation from a job or handler, and no stock write outside the Epic 2 ledger helpers.
- AD-16 (idempotency keys): every write route carries an `idempotency_key`; a replay returns the stored result, a cross-type reuse returns 409.
- AD-17 (notification coupling): both emissions use the decoupled `emitNotification`. Neither is an approval decision.
- Module directory: all new code lands under `src/maintenance/`, `src/compliance/`, `src/read/projections/`, `src/lib/` and `src/api/v1/`. No new top-level directory.
- RBAC: `requireRole({ module: 'maintenance', functionScope: 'read' })` or `'write'` on every handler, never a hardcoded role list in a handler body. The no-hardcoded-role gate enforces this.

### Previous Story Intelligence

Story 7.3 shipped after a 35-patch review. Every lesson below is live and skipping any of them will reproduce a finding:

- Canonicalize every human-entered key with `lower()`, in the handler AND in the seam, so the direct-event path cannot bypass it.
- The race path and the sequential path must return the SAME error code with the SAME `existing_*` detail; wire a resolver into the 23505 mapper for every new unique index.
- A blank or non-string `idempotency_key` falls back to `randomUUID()`; a cross-event-type reuse is 409 `DUPLICATE_EVENT`.
- Never let an applier silently no-op on a state it should reject: reject with a catchable code so counters stay honest and no phantom event or spurious notification is produced.
- Every TIMESTAMPTZ input requires an explicit UTC offset; every DATE derived from a timestamp pins its zone explicitly. `return_due_date` is a new instance of exactly this defect class.
- Job results expose delivery counters separately from write counters, so a dropped notification is visible.
- Narrow job scope in SQL, not in a JS filter after the fact, or the counters overstate what was evaluated.
- Bound every quantity and count field; an unbounded numeric becomes a 500 instead of a 400.
- Read back a created resource BY ID for the 201 body, never by re-querying the newest row.
- Declared payload fields the applier can derive must be cross-checked against the derivation, not trusted.

Story 7.2 lessons that still bind: duplicate detection under `FOR UPDATE` with a unique index as the backstop, and actor-derived fields never read from the payload. Story 7.1 lesson that still binds: the one-record rule is enforced by a database constraint, not only by a pre-check.

Two open platform gaps from the ledger apply here and are NOT this story's to fix: a `maintenance.*` event posted with a non-`maintenance` `stream_type` skips the seam gates (`src/events/store.ts`), and same-event-type idempotency-key reuse with different content returns the original event.

### Git Intelligence

Baseline is `893e945`. The Story 7.3 tree is present in the working tree but not yet committed at story-creation time: `read/projections/maintenance_downtime.sql`, `maintenance_fault_report.sql`, `maintenance_reliability_metric.sql` and `maintenance_sla_policy.sql`, `src/compliance/maintenance-fault.ts`, `src/compliance/maintenance-reliability.ts`, `src/maintenance/reliability-jobs.ts`, the four matching read accessors and `test/integration/story-7-3.test.ts` are untracked, with modifications to `maintenance_work_order.sql`, `init-db.sql`, `migrate.ts`, `schema.ts`, `store.ts`, `maintenance.ts`, `server.ts` and the two gate tests. Record the actual baseline commit in the frontmatter once that tree is committed. Recent commits (`893e945`, `ce42587` asset registration, `9b6d5e1` story 5-6) show the established rhythm: canonical SQL plus init-db mirror plus schema-drift entry land together; seams are wired into `store.ts` in the same commit as the events they validate; the integration suite is authored alongside, not after. Follow it.

### Testing Requirements

- Framework and harness: the existing integration-test harness under `test/integration/`, bootstrapped exactly as `story-7-3.test.ts` does. Unit-level schema assertions go in `test/unit/schema-drift.test.ts`; business-day assertions go in `test/unit/business-days.test.ts`.
- Red-green-refactor per task: write the failing assertion first, confirm it fails for the right reason, then implement.
- Every acceptance criterion needs at least one test that would FAIL if the behavior were removed. A test that only asserts a 200 is not coverage.
- Every error code in Table 6 needs a test.
- Idempotency: every write route gets a replay test asserting the same resource comes back and the event ledger count did not grow.
- Ledger invariant: after each of reserve, issue, return and cancel, assert `available = on_hand - allocated` and assert the absolute `on_hand` and `allocated` values, not merely that they changed.
- The full-reservation issue test is mandatory: reserve the entire available quantity at a location, then issue it, and assert success. This is the test that catches a deallocate-after-issue ordering.
- Regression: the Epic 2 stock-ledger suites and the Story 7.1, 7.2 and 7.3 suites must pass unchanged. The shared `stock_balance` helpers are the highest regression risk in this story.
- Do not weaken, skip or delete an existing test to make a new one pass.
- Known baseline: fifteen pre-existing Epic 1 to 3 idempotency failures plus one `gate_dwell_metric` line-ending failure. Zero NEW failures is the bar; do not attempt to fix the baseline in this story.

### Project Structure Notes

New files: `read/projections/maintenance_spare_catalogue.sql`, `read/projections/asset_parts_list.sql`, `read/projections/maintenance_spare_reservation.sql`, `read/projections/maintenance_spare_alert.sql`, `src/compliance/maintenance-spares.ts`, `src/read/projections/maintenance_spare_catalogue.ts`, `src/read/projections/asset_parts_list.ts`, `src/read/projections/maintenance_spare_reservation.ts`, `src/read/projections/maintenance_spare_alert.ts`, `src/maintenance/spares-jobs.ts`, `test/integration/story-7-4.test.ts`.

Modified files: `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/lib/business-days.ts`, `src/config/index.ts`, `src/api/v1/maintenance.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/unit/business-days.test.ts`, `test/integration/story-1-9.test.ts`, `_bmad-output/implementation-artifacts/deferred-work.md`.

Read-only, do not modify: everything under `src/engineering/`, every `bom*` file in `read/projections/` and `src/read/projections/`, and `src/read/projections/stock_balance.ts` (call its exports, do not change them).

No new dependency is required or permitted. Everything this story needs (pg, node:crypto, the existing middleware, the notification service, the stock ledger helpers) is already installed.

### References

- Epic 7 story plus FR-M-07, FR-M-08, FR-M-09: `_bmad-output/planning-artifacts/epics.md` (Story 7.4 at line 2187; the FR-M-07/08/09 line at 165).
- AD-4, AD-9, AD-14, AD-16 and AD-17 plus the module directory: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md`.
- Previous story, its review outcome and its binding decisions: `_bmad-output/implementation-artifacts/7-3-fault-reporting-and-breakdown-work-orders.md`.
- Stock ledger helpers and their exact semantics: `src/read/projections/stock_balance.ts` (`applyStockAllocation`, `applyStockIssue`, `applyStockDeallocation`, `applyStockReceipt`, `StockAllocationInput`).
- Stock-class scoping, quantity bounds and the `MAX_QUANTITY` ceiling: `src/compliance/stock-balance.ts`.
- The issue-then-deallocate ordering NOT to copy: `src/compliance/transfer-request.ts` lines 424 to 436.
- Job template, SQL-narrowed scope, per-grain locking and counters: `src/compliance/planning-jobs.ts` (`runReplenishmentCheck`) and `src/maintenance/pm-jobs.ts`.
- Seam template, duplicate resolvers and the derivation-match pattern: `src/compliance/maintenance-fault.ts` and `src/compliance/maintenance-plan.ts`.
- Projection SQL template: `read/projections/maintenance_sla_policy.sql`; guarded column-addition precedent: `read/projections/maintenance_work_order.sql`.
- Item and location lookups: `src/read/projections/item_master.ts` (`getItemBySku`, `itemExistsBySku`) and `src/read/projections/location_register.ts` (`getLocationById`, `locationExistsById`).
- Business-day arithmetic and the IST calendar convention: `src/lib/business-days.ts`; holiday-calendar config precedent: `src/config/index.ts` (`scorecard.responsivenessHolidayCalendar`).
- API handlers, helpers and RBAC wrapping: `src/api/v1/maintenance.ts`; route registration in `src/server.ts` (`createAppRouter`).
- Notification service, targets and escalation windows: `src/notify/emit.ts`; coupling decision record: `docs/adr/ADR-001-notification-emission-coupling.md`.
- Event registry and payload template: `src/events/schema.ts` (Story 7.3 block, registry tail).
- Seam wiring and the 23505 mapper: `src/events/store.ts`.
- Migration registration: `src/events/migrate.ts` (MIGRATIONS tail).
- Test harness template: `test/integration/story-7-3.test.ts`; schema-drift `EXPECTED` in `test/unit/schema-drift.test.ts`; spine allowlist in `test/integration/story-1-9.test.ts`.
- Known pre-existing failures and platform gaps: `_bmad-output/implementation-artifacts/deferred-work.md`.
- Formatting rules for any Markdown authored during the story: `FORMATTING_RULES.md`.

## Dev Agent Record

### Agent Model Used

- Claude Opus 5 (1M context) via the bmad-dev-story workflow, 2026-08-25.

### Debug Log References

- Gates run at completion: `npx tsc` (build) clean, `npx eslint src/ test/` clean, `npx prettier --check` clean, `npm run db:migrate` twice idempotent.
- Story 7.4 suite: 45/45 pass. Epic 7 regression plus the spine gate (`story-7-1`, `story-7-2`, `story-7-3`, `story-7-4`, `business-days`, `story-1-9`): 142/142 pass.
- Full suite: 1021 tests, 1004 pass, 17 fail. All 17 are pre-existing and none are attributable to this story - see the baseline verification note below.

### Completion Notes List

Implemented all 9 tasks and 46 subtasks from baseline `893e945`.

Task order deviation: Task 5 (the `addBusinessDays` helper and the holiday config) was implemented before Task 4 (the seam), because the issue applier calls `deriveReturnDueDate` and cannot compile without it. Task 5 is a pure leaf with no dependency on the seam, so the inversion changes nothing about the delivered content.

What was built:

- Four canonical projections (`maintenance_spare_catalogue`, `asset_parts_list`, `maintenance_spare_reservation`, `maintenance_spare_alert`), each mirrored into `deploy/compose/init-db.sql`, registered in `MIGRATIONS`, and added to the schema-drift `EXPECTED` set. The drift gate passes 92/93 for them (the single failure is the pre-existing `gate_dwell_metric` one).
- Eight `maintenance` stream events, all `requiresBusinessStream: false`, with payload interfaces and envelope types in `src/events/schema.ts`.
- One compliance seam, `src/compliance/maintenance-spares.ts`, wired into `store.ts` for both the pre-transaction shape assert and the in-transaction applier, plus three 23505 duplicate resolvers.
- `addBusinessDays` in `src/lib/business-days.ts` (the single source of business-day arithmetic) and a shared fail-closed `parseHolidayCalendarEnv` in `src/config/index.ts`, which the pre-existing `scorecard.responsivenessHolidayCalendar` now also uses instead of its own inline copy.
- One POST-triggered job module, `src/maintenance/spares-jobs.ts`, with the min-max breach scan and the overdue-return sweep.
- Twelve REST routes with the static-before-parameter ordering the API Contract requires, all twelve added to `allowedSpineRoutes`.

Decisions taken during implementation:

- The deallocate-before-issue ordering is now covered by a test that is demonstrably load-bearing. Inverting the two calls in the seam was verified to fail exactly one test ("issuing the full available quantity succeeds"), confirming the assertion catches the defect the story's Binding Scope Decisions predicted rather than passing vacuously.
- The story's Breach Scan Contract asks the scan to hold the catalogue row under `FOR UPDATE` "for the duration of its grain". `persistEvent` accepts an `externalClient` and leaves BEGIN/COMMIT to the caller when one is passed, so the lock genuinely spans the write; the contract is met literally rather than approximated. `uq_maintenance_spare_alert_day` remains the backstop and `DUPLICATE_SPARE_ALERT` is caught and skipped so one lost race cannot fail a whole scan.
- Subtask 8.5 asks for an assertion that the breach alert produces a "notification delivery row". Delivery rows are written by the `src/notify/dispatch.ts` cycle, which runs on a `setInterval` that is not active under the test harness, so asserting on `notification_deliveries` would assert on the dispatcher rather than on this story. The test instead asserts the `notification.created` event carries the right target AND replicates `resolveTargetUserIds` exactly to assert the role resolves to at least one real user. That is the check that actually catches the flagged defect (a role no user holds fans out to zero recipients and still reports success); the literal delivery-row assertion would not.
- The wire format accepts a JSON number for quantities and levels and normalizes it to a NUMERIC string at the handler, so a caller sending `2` rather than `"2"` is not punished, while everything below the handler stays string-typed end to end.
- A return with no `quantity_returned` means "all of the outstanding balance", which is the common case at the store counter; an explicit quantity still supports the partial return the state machine allows.
- `deploy/compose/init-db.sql` is a CRLF file. The appended Story 7.4 block was normalized to CRLF to match, so the file does not carry mixed line endings.

Baseline verification (no new failures): the 17 full-suite failures were checked against a pristine `893e945` git worktree rather than assumed. Four representative idempotency failures (`story-2-2`, `story-2-4`) reproduce identically at that baseline, as does the `story-5-3` where-used clock-window flake already recorded in `deferred-work.md`. The `gate_dwell_metric` schema-drift failure is a working-tree CRLF artifact: `read/projections/gate_dwell_metric.sql` is unmodified by this story, the CRLF lives in pre-existing regions of `init-db.sql` (6631 CRLF line endings across content this story never touched), and the same test passes in a fresh checkout. The remaining failures are the documented fifteen Epic 1 to 3 idempotency failures. Total: 15 idempotency + 1 clock-window flake + 1 line-ending artifact = 17, zero attributable to Story 7.4.

Nine items were logged to `deferred-work.md`, including the platform-level gap that `maintenance_storekeeper` is a new role string with no registry to validate it against.

### File List

New:

- `read/projections/maintenance_spare_catalogue.sql`
- `read/projections/asset_parts_list.sql`
- `read/projections/maintenance_spare_reservation.sql`
- `read/projections/maintenance_spare_alert.sql`
- `src/compliance/maintenance-spares.ts`
- `src/read/projections/maintenance_spare_catalogue.ts`
- `src/read/projections/asset_parts_list.ts`
- `src/read/projections/maintenance_spare_reservation.ts`
- `src/read/projections/maintenance_spare_alert.ts`
- `src/maintenance/spares-jobs.ts`
- `test/integration/story-7-4.test.ts`

Modified:

- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/lib/business-days.ts`
- `src/config/index.ts`
- `src/api/v1/maintenance.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/unit/business-days.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Change Log

| **Date** | **Change** |
| --- | --- |
| 2026-08-25 | Implemented Story 7.4 from baseline `893e945`: four projections, eight events, one compliance seam, one job module, twelve routes, the `addBusinessDays` return clock and a 45-test integration suite. Status moved to review. |
| 2026-08-25 | Code review (adversarial pass, three layers over baseline `893e945` working tree, chunked into schema+seam / read+API / tests): 3 High, 8 Medium, 12 Low routed to patch and applied. See Review Findings below. Status moved to done. |

## Review Findings

- [x] [Review][Patch][High] Alert appliers trust payload derivable fields (`on_hand_at_check` / `min_level` / `return_due_date`) without re-deriving under lock [src/compliance/maintenance-spares.ts:771-823] - FIXED: `applySpareAlert` now re-derives under the catalogue/reservation FOR UPDATE lock (checks the grain is critical and actually breached/overdue and the declared values match the ledger) and rejects a fabricated alert with `SPARE_DERIVATION_MISMATCH`, so a forged alert can no longer occupy the same-day grain and suppress the genuine escalation. The breach scan shares the same `getOwnedOnHandAndBelowMin` accessor, so job and seam derive identically.
- [x] [Review][Patch][High] JS float arithmetic on NUMERIC quantity strings (the "quantities travel as STRINGS" rule) [src/api/v1/maintenance.ts:2329-2331, src/compliance/maintenance-spares.ts:671-684] - FIXED: the return-all outstanding is now the exact SQL `(quantity - quantity_returned)::numeric::text` column on the reservation row; the seam's over-return guard and the issue quantity check now settle in SQL NUMERIC (`getSpareReservationReturnExceeds`, `getSpareReservationQuantityMatches`), so fractional closing returns (0.1 + 0.2 = 0.3) are accepted and 0.3 - 0.1 returns exactly 0.2.
- [x] [Review][Decision][High] Spare SKU canonicalization is case-insensitive while the Epic 2 `item_master`/`stock_balance` are case-sensitive [src/compliance/maintenance-spares.ts:121-123] - DECIDED: keep the story's deliberate lowercase canonicalization (asserted by the AC1 case-variant test); a platform-level SKU-case decision is required to align `item_master`, logged to `deferred-work.md`.
- [x] [Review][Patch][Medium] `is_critical` wire value silently coerced (`"true"` string becomes false, disabling FR-M-09) [src/api/v1/maintenance.ts:1871] - FIXED: a present non-boolean `is_critical` is rejected with 400 `INVALID_PARAMS`; an omitted value stays a non-critical spare.
- [x] [Review][Patch][Medium] where-used SKU is double-decoded, corrupting percent-containing SKUs or throwing an uncaught URIError 500 [src/api/v1/maintenance.ts:2045] - FIXED: the decode is guarded and a malformed encoding returns 400 `INVALID_PARAMS`.
- [x] [Review][Patch][Medium] 201 read-back by grain instead of by ID for catalogue and parts-list creation [src/api/v1/maintenance.ts:1921-1924, 2094-2096] - FIXED: both read back from the persisted payload's `catalogue_id` / `part_line_id`, so a same-key replay with a different body returns the original row, never null.
- [x] [Review][Patch][Medium] No concurrency tests exercised the FOR UPDATE / 23505 race path - FIXED: concurrent catalogue and parts-list POSTs on the same grain resolve to one 201 and one stable 409 (`SPARE_ALREADY_CATALOGUED` / `ASSET_PART_ALREADY_LISTED` with the winning id).
- [x] [Review][Patch][Medium] Fractional NUMERIC quantities untested (the suite used only whole units) - FIXED: fractional reserve/partial-return/return-all lifecycle tests added (0.3 reserve, 0.1 then 0.2 closing return, 0.1 then return-all).
- [x] [Review][Patch][Low] Storekeeper notification asserted via role-resolution, not a delivery row (Task 8.5 letter) - documented deviation retained: the dispatch cycle is not exercised under the harness; the role-resolution assertion still catches a role no user holds.
- [x] [Review][Patch][Low] `addBusinessDays` 500 on a densely-holidayed span and unbounded `MAINTENANCE_SPARE_RETURN_DAYS` [src/lib/business-days.ts:98-109, src/config/index.ts:291] - FIXED: the loop bound now carries a full-year buffer and the config knob is capped at 3650 with a fail-fast throw at load.
- [x] [Review][Patch][Low] `business_date` filter silently ignored unless `return_overdue=true` [src/api/v1/maintenance.ts:2242-2243] - FIXED: the unsupported combination returns 400 `INVALID_PARAMS`.
- [x] [Review][Patch][Low] Test gaps: overdue-sweep same-day re-run, overdue alert row read-back, cancel state-machine corners, direct issue-quantity mismatch, forged alert rejection - FIXED: covered by the new regression tests.
- [x] [Review][Defer] Crash between alert commit and notification emission permanently loses that day's notification [src/maintenance/spares-jobs.ts] - deferred, pre-existing accepted crash-window tradeoff consistent with the codebase precedent; the separate write/delivery counters expose a drop only within the run that dropped it.
- [x] [Review][Defer] No direct HTTP `POST /api/v1/events` bypass test for a forged `maintenance.*` alert under a mismatched `stream_type` - deferred, ties to the pre-existing platform-wide stream/event-type registry gap already logged under Story 7.1.

### Review Verdict (2026-08-25)

- Layers: Blind Hunter, Edge Case Hunter and Acceptance Auditor over all three chunks (schema+seam+events, read+API+jobs, integration tests). Auditor verified all 3 ACs and all binding decisions implemented with load-bearing tests; story-7-3/business-days test modifications are formatting-only / genuine oracles.
- Triage: 1 decision resolved (SKU case kept + platform item_master case deferred), 13 patches applied, 2 deferred (accepted tradeoffs), 15 dismissed as noise or by-design.
- Verification after patches: tsc clean, eslint clean, prettier clean; story-7-4 58/58 (was 45/45, +13 regression tests); story-7-3 30/30; spine 6/6; schema-drift 92/93 (1 pre-existing gate_dwell CRLF); business-days 16/16; full suite 1034 tests, 1017 pass, 17 fail (documented pre-existing baseline, 0 new).
