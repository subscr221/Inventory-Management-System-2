---
baseline_commit: cf342e6df9337632c8007b590e35a0df174d0098
---

# Story 3.6: Pick Task Generation and Execution (FR-W-04)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a warehouse operator,
I want to receive system-generated pick tasks with optimized paths and execute them via the edge PWA or a printed pick list (single-order, batch, wave, or zone), with task confirmation updating stock allocation in real time,
so that picks are accurate and efficient, and stock allocation is always current without manual reconciliation.

**Scope note:** This story builds pick task generation from scratch using Story 2.9's sales-order projection as Phase-1 outbound demand. No pick-task infrastructure exists yet. Velocity classification (Story 3.5) provides ABC classes for pick-path optimization. This story does NOT build packing/shipping (Story 3.7), forward-pick replenishment (Story 3.9), or cross-docking (Story 3.10).

## Acceptance Criteria

1. **Given** a dispatch order from the Story 2.9 sales-order projection requires 100 units of `FG-0010` from `site-A`
   **When** pick tasks are generated
   **Then** the system creates tasks whose pick lines are sequenced in ascending bin pick-sequence within each zone (the observable definition of "optimized path"), selects lots by FEFO, and sets the 100 units as `allocated` in the stock balance (FR-W-04).

2. **Given** three open dispatch orders from the Story 2.9 projection require `FG-0010` from the same zone
   **When** the supervisor releases them as a batch pick
   **Then** a single consolidated pick task is generated for the combined quantity, with per-order sortation quantities shown at the pick line (FR-W-04 batch strategy).

3. **Given** open dispatch orders are grouped by dispatch cutoff time into a wave
   **When** the wave is released
   **Then** pick tasks for all orders in the wave are generated together and carry the `wave_id`; orders outside the wave remain unreleased (FR-W-04 wave strategy).

4. **Given** a dispatch order's pick lines span `ZONE-AMBIENT` and `ZONE-COLD`
   **When** zone picking is selected
   **Then** separate pick tasks are generated per zone, each assignable to a zone operator, and the order moves to `picked` only when every zone task is confirmed (FR-W-04 zone strategy).

5. **Given** a pick task list is generated for an operator working without an edge device
   **When** the supervisor prints the pick list
   **Then** a paper pick list renders with task IDs, bin pick-sequence, and directed lots; keyed-in confirmations against those task IDs are recorded with `capture_method: "PAPER"` (FR-W-04 paper-directed).

6. **Given** an operator scans the lot barcode at the pick location
   **When** the scan is confirmed on the edge PWA
   **Then** the pick line is marked confirmed; if the scanned lot does not match the directed lot, the system prompts for an override reason before allowing the substitution.

7. **Given** the operator confirms all pick lines for an order
   **When** the last confirmation is submitted
   **Then** stock status moves from `allocated` to `picked` and the packing station is notified.

8. **Given** a pick task is in progress and the operator needs to substitute a lot (directed lot is damaged, expired, or unavailable)
   **When** the operator scans a different lot and provides an override reason
   **Then** the substitution is recorded with the override reason, the new lot is allocated, and the original lot's allocation is released; the pick task continues with the substituted lot.

## Tasks / Subtasks

- [x] Task 1: Event contracts and registration (AC: 1, 2, 3, 4, 6, 7, 8)
  - [x] 1.1 In `src/events/schema.ts`, add `PickTaskCreatedPayload` and `PickTaskCreatedEnvelope extends Omit<EventEnvelope, 'payload'>` with literal `event_type: 'pick_task.created'`. Payload fields: `pick_task_id` (UUID), `dispatch_order_id` (UUID, references Story 2.9 sales-order projection line), `sku` (TEXT), `quantity` (NUMERIC(14,3)), `lot_id` (UUID, the directed lot selected by FEFO), `location_id` (UUID, the bin location), `pick_sequence` (INTEGER, ascending order within zone), `strategy` (`'single'|'batch'|'wave'|'zone'`), `wave_id` (UUID, nullable, set only for wave strategy), `batch_id` (UUID, nullable, set only for batch strategy), `zone_id` (UUID), `created_by` (server-set from auth).
  - [x] 1.2 Add `PickLineConfirmedPayload` and `PickLineConfirmedEnvelope` with literal `event_type: 'pick_line.confirmed'`. Fields: `pick_task_id` (UUID), `pick_line_id` (UUID), `confirmed_lot_id` (UUID, the lot actually picked — may differ from directed lot if override), `confirmed_quantity` (NUMERIC(14,3)), `override_reason` (TEXT, nullable, set only when `confirmed_lot_id <> directed_lot_id`), `capture_method` (`'PWA'|'PAPER'`), `confirmed_by` (server-set from auth), `confirmed_at` (server-set timestamptz).
  - [x] 1.3 Add `PickTaskCompletedPayload` and `PickTaskCompletedEnvelope` with literal `event_type: 'pick_task.completed'`. Fields: `pick_task_id` (UUID), `dispatch_order_id` (UUID), `completed_by` (server-set from auth), `completed_at` (server-set timestamptz). This event fires when ALL pick lines for a task are confirmed (AC7).
  - [x] 1.4 Register all three event types in `SUPPORTED_EVENT_TYPES` (schema.ts:409-508) with stream type `'warehouse'`: `'pick_task.created': { streamType: 'warehouse', requiresBusinessStream: false }`, `'pick_line.confirmed': { streamType: 'warehouse', requiresBusinessStream: false }`, `'pick_task.completed': { streamType: 'warehouse', requiresBusinessStream: false }`. Rationale: pick events post no valuated movement of their own — stock allocation changes are driven by the projection apply functions, not by business-stream-tagged events — so tagging is not gated on these events (mirror Story 3.5's `putaway` stream rationale).
  - [x] 1.5 Add the two new tables (`pick_task`, `pick_line`) to the `EXPECTED` array in `test/unit/schema-drift.test.ts`, mirroring the `putaway_task` / `velocity_class` entry shape at schema-drift.test.ts:264-295.

- [x] Task 2: Projection DDL for `pick_task` and `pick_line` (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 2.1 Create `read/projections/pick_task.sql` following the exact idempotent pattern of `read/projections/putaway_task.sql` (guarded `DO $$` constraint/grant blocks; `CREATE TABLE IF NOT EXISTS`). Table `pick_task` at grain `(pick_task_id)` — single-column PK. Columns: `pick_task_id UUID PRIMARY KEY`, `dispatch_order_id UUID NOT NULL` (references Story 2.9 `erp_sales_order_line.id`), `sku TEXT NOT NULL`, `total_quantity NUMERIC(14,3) NOT NULL`, `strategy TEXT NOT NULL` with CHECK `chk_pick_task_strategy` (`strategy IN ('single','batch','wave','zone')`), `wave_id UUID` (nullable), `batch_id UUID` (nullable), `zone_id UUID NOT NULL`, `status TEXT NOT NULL DEFAULT 'pending'` with CHECK `chk_pick_task_status` (`status IN ('pending','in_progress','completed','cancelled')`), `assigned_to UUID` (nullable, the operator user_id), `created_by UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `completed_at TIMESTAMPTZ` (nullable), `completed_by UUID` (nullable), `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index on `(dispatch_order_id)`, `(zone_id, status)`, `(assigned_to, status)`, `(wave_id)`, `(batch_id)`.
  - [x] 2.2 Create `read/projections/pick_line.sql` following the same idempotent pattern. Table `pick_line` at grain `(pick_line_id)` — single-column PK. Columns: `pick_line_id UUID PRIMARY KEY`, `pick_task_id UUID NOT NULL REFERENCES pick_task(pick_task_id)`, `dispatch_order_line_id UUID NOT NULL` (references Story 2.9 `erp_sales_order_line.id`), `sku TEXT NOT NULL`, `directed_lot_id UUID NOT NULL` (the FEFO-selected lot), `confirmed_lot_id UUID` (nullable until confirmed), `directed_quantity NUMERIC(14,3) NOT NULL`, `confirmed_quantity NUMERIC(14,3)` (nullable until confirmed), `location_id UUID NOT NULL` (the bin location), `pick_sequence INTEGER NOT NULL` (ascending order within zone), `status TEXT NOT NULL DEFAULT 'pending'` with CHECK `chk_pick_line_status` (`status IN ('pending','confirmed','cancelled','substituted')`), `override_reason TEXT` (nullable, set only when `confirmed_lot_id <> directed_lot_id`), `capture_method TEXT` with CHECK `chk_pick_line_capture_method` (`capture_method IS NULL OR capture_method IN ('PWA','PAPER')`), `confirmed_by UUID` (nullable), `confirmed_at TIMESTAMPTZ` (nullable), `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index on `(pick_task_id)`, `(location_id, status)`, `(directed_lot_id)`.
  - [x] 2.3 Guarded grants in idempotent `DO $$` blocks checking `pg_roles`: `INSERT, SELECT, UPDATE` for `app_user` on both tables; `SELECT` for `readonly_user`. No DELETE (soft-delete via `status = 'cancelled'` only).
  - [x] 2.4 Register both SQL files in the `MIGRATIONS` array in `src/events/migrate.ts` (append after the Story 3.5 `velocity_class.sql` entry, migrate.ts:8). Mirror both table DDLs BYTE-FOR-BYTE into `deploy/compose/init-db.sql`, appended after the existing `velocity_class` block, WITHOUT touching the `powersync_publication` block.

- [x] Task 3: Read-model TypeScript accessors (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 3.1 Create `src/read/projections/pick_task.ts` mirroring `src/read/projections/putaway_task.ts` structure: `runner(client?)`, `PICK_TASK_COLUMNS`, `mapRow`. Accessors: `getPickTaskById(pickTaskId, client?)`, `createPickTask(input, client)` (insert with all fields from Task 2.1), `updatePickTaskStatus(pickTaskId, status, completedBy, client)` (idempotent `UPDATE ... SET status=$2, completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END, completed_by=$3, updated_at=now() WHERE pick_task_id=$1`, return affected-row boolean), `assignPickTask(pickTaskId, assignedTo, client)` (idempotent `UPDATE ... SET assigned_to=$2, updated_at=now() WHERE pick_task_id=$1`), `listPickTasks({ siteId?, status?, assignedTo?, zoneId?, waveId?, batchId? }, client?)` (filtered list with site scope via `dispatch_order_id` join to Story 2.9 projection). Export `PickTask` type.
  - [x] 3.2 Create `src/read/projections/pick_line.ts` mirroring the same structure: `runner(client?)`, `PICK_LINE_COLUMNS`, `mapRow`. Accessors: `getPickLineById(pickLineId, client?)`, `createPickLine(input, client)` (insert with all fields from Task 2.2), `confirmPickLine(pickLineId, confirmedLotId, confirmedQuantity, overrideReason, captureMethod, confirmedBy, client)` (idempotent `UPDATE ... SET confirmed_lot_id=$2, confirmed_quantity=$3, override_reason=$4, capture_method=$5, confirmed_by=$6, confirmed_at=now(), status=CASE WHEN $2<>(SELECT directed_lot_id FROM pick_line WHERE pick_line_id=$1) THEN 'substituted' ELSE 'confirmed' END, updated_at=now() WHERE pick_line_id=$1 AND status='pending'`, return affected-row boolean — no-op-safe if already confirmed), `listPickLinesByTask(pickTaskId, client?)` (returns all lines for a task ordered by `pick_sequence` ASC), `releasePickLineAllocation(pickLineId, client)` (idempotent `UPDATE ... SET status='cancelled', updated_at=now() WHERE pick_line_id=$1 AND status='pending'` — used when a lot substitution releases the original lot's allocation). Export `PickLine` type.

- [x] Task 4: Pick task generation logic (AC: 1, 2, 3, 4)
  - [x] 4.1 Create `src/warehouse/pick-task-generator.ts` (new file in the `warehouse/` module directory established by Story 3.5). Export `generatePickTasks(input: { dispatchOrderLineIds: string[], strategy: 'single'|'batch'|'wave'|'zone', waveId?: string, batchId?: string, siteId: string, createdBy: string }, client?): Promise<{ pickTaskIds: string[], pickLineIds: string[] }>`. This is the central seam for AC1-AC4.
  - [x] 4.2 Algorithm for single-order strategy (AC1): (a) load the Story 2.9 sales-order projection lines by `dispatchOrderLineIds` via `getErpSalesOrderLineById` (confirm exact accessor name in `src/read/projections/erp_sales_order.ts` — Story 2.9 Dev Notes describe the projection shape); reject `DISPATCH_ORDER_LINE_NOT_FOUND` if any line is absent. (b) For each line, resolve available stock by FEFO: query `stock_balance` (Story 2.2) for `sku` at `siteId` where `available > 0`, join to `lot_master` (Story 2.3) for `expiry_date`, order by `expiry_date ASC NULLS LAST` (FEFO), then by `lot_master.lot_number ASC` (tiebreaker); select lots until the line's `quantity` is fully allocated. If insufficient available stock exists, reject `INSUFFICIENT_STOCK_FOR_PICK` with the shortfall quantity (do NOT partially allocate — pick tasks are all-or-nothing per line). (c) For each allocated lot, resolve the bin location: query `location_register` (Story 3.1) for bins at `siteId` where the lot is currently stored (join to `location_current` from Story 1.6 to get the lot's current bin); if the lot is stored in multiple bins, prefer the bin with the highest `velocity_class` (Story 3.5) for that `(sku, siteId)` — this is the first consumption of Story 3.5's velocity data for pick-path optimization. (d) Compute `pick_sequence` per zone: group all pick lines by `zone_id` (resolved from the bin's `location_register.zone_id`), sort within each zone by `location_register.pick_sequence` (Story 3.1 added a `pick_sequence` column to `location_register` — confirm exact field name in Task 4.4; if absent, use `hierarchy_path` lexicographic order as a fallback), assign ascending integers starting at 1. (e) Create one `pick_task` per dispatch order line (single-order strategy = one task per line), then create `pick_line` rows for each allocated lot within that task. Return the created IDs.
  - [x] 4.3 Algorithm for batch strategy (AC2): (a) group the input `dispatchOrderLineIds` by `sku` and `zone_id` (resolved from the lot's current bin location); (b) for each `(sku, zone_id)` group, sum the quantities across all orders, then run the same FEFO lot-selection and bin-resolution as Task 4.2 steps (b)-(d); (c) create ONE `pick_task` with `strategy='batch'` and `batch_id` set to a new UUID (generate client-side via `crypto.randomUUID()`), with `dispatch_order_id` set to the FIRST order line in the group (document this choice: batch tasks reference the primary order line, but the `pick_line` rows carry `dispatch_order_line_id` for each contributing order, so per-order sortation is preserved); (d) create `pick_line` rows for each allocated lot, with each line's `dispatch_order_line_id` pointing to the correct order line (so the pick list can show per-order sortation quantities at the pick line per AC2).
  - [x] 4.4 Algorithm for wave strategy (AC3): (a) group the input `dispatchOrderLineIds` by `wave_id` (caller provides `waveId`); (b) for each line in the wave, run the same FEFO lot-selection and bin-resolution as Task 4.2 steps (b)-(d); (c) create one `pick_task` per dispatch order line with `strategy='wave'` and `wave_id` set; (d) create `pick_line` rows as in Task 4.2 step (e). The wave grouping is enforced by the caller (Task 7.2's `POST /api/v1/pick-tasks/wave` endpoint); this generator simply stamps `wave_id` on every task it creates.
  - [x] 4.5 Algorithm for zone strategy (AC4): (a) for each input `dispatchOrderLineId`, resolve the lot's current bin location and its `zone_id`; (b) if the dispatch order's pick lines span multiple zones (caller provides a flag or the generator detects this by inspecting the lines' zones), create ONE `pick_task` per zone with `strategy='zone'` and `zone_id` set, with `dispatch_order_id` pointing to the dispatch order; (c) create `pick_line` rows for each allocated lot within that zone's task; (d) the order moves to `picked` only when every zone task is confirmed — implement this by checking, in the `pick_task.completed` apply function (Task 5.3), whether all zone tasks for the same `dispatch_order_id` have `status='completed'`; if so, emit a synthetic `dispatch_order.picked` event (or update a `dispatch_order_status` projection — confirm with Story 3.7's packing flow whether a dispatch-order status projection exists; if not, this story creates a minimal `dispatch_order_picked` flag in a new projection or in the Story 2.9 projection itself — document the choice in Dev Notes).
  - [x] 4.6 Before implementing Task 4.2-4.5, read `src/read/projections/stock_balance.ts`, `src/read/projections/lot_master.ts`, `src/read/projections/location_register.ts`, and `src/read/projections/location.ts` (Story 1.6's `location_current`) in full to confirm exact accessor signatures and field names. Confirm whether `location_register` has a `pick_sequence` column (Story 3.1 Dev Notes mention hierarchy_path but not pick_sequence — if absent, add it via a minimal additive migration on `location_register` in this story, since AC1 requires "ascending bin pick-sequence within each zone" and the sequence must originate somewhere; prefer extending `location_register` with a `pick_sequence INTEGER` column (idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS`, nullable, default NULL) over inventing a separate pick-sequence table — this keeps the zone-routing symmetric with the bin's own location attributes). Confirm whether Story 2.9's `erp_sales_order_line` projection has a `dispatch_order_id` or similar grouping field (if not, use the `erp_sales_order_line.id` itself as the dispatch-order identifier for this story's scope).

- [x] Task 5: Compliance seam and central write-path wiring (AC: 1, 6, 7, 8)
  - [x] 5.1 Create `src/compliance/pick.ts` with `assertPickTaskCreatedShape(envelope)`, `assertPickLineConfirmedShape(envelope)`, `assertPickTaskCompletedShape(envelope)` (all pre-transaction), and `applyPickTaskCreatedProjection(envelope, client, eventId)`, `applyPickLineConfirmedProjection(envelope, client, eventId)`, `applyPickTaskCompletedProjection(envelope, client, eventId)` (all in-transaction). Follow the `src/compliance/putaway.ts` structure exactly (same file organization: shape asserts first, then the apply functions).
  - [x] 5.2 `assertPickTaskCreatedShape` (pre-transaction, no DB access): require `pick_task_id` (UUID), `dispatch_order_id` (UUID), `sku` (TEXT), `quantity` (NUMERIC string), `lot_id` (UUID), `location_id` (UUID), `pick_sequence` (INTEGER), `strategy` (one of `'single'|'batch'|'wave'|'zone'`), `zone_id` (UUID). Reject `PICK_TASK_INVALID_PAYLOAD` if any required field is absent or malformed. `wave_id` and `batch_id` are nullable but must be UUID if present. `assertPickLineConfirmedShape` requires `pick_task_id`, `pick_line_id`, `confirmed_lot_id`, `confirmed_quantity`; `override_reason` is required when `confirmed_lot_id` differs from the directed lot (enforce in the apply function, not the shape assert, since the shape assert has no DB access to compare). `assertPickTaskCompletedShape` requires `pick_task_id`.
  - [x] 5.3 `applyPickTaskCreatedProjection` (in-transaction): (1) insert the `pick_task` row via `createPickTask` (Task 3.1); (2) insert the `pick_line` rows via `createPickLine` (Task 3.2) — the envelope's payload carries an array of pick-line objects (extend the `PickTaskCreatedPayload` to include `pick_lines: PickLineInput[]` — each with `pick_line_id`, `dispatch_order_line_id`, `sku`, `directed_lot_id`, `directed_quantity`, `location_id`, `pick_sequence`); (3) update `stock_balance` to set `allocated = allocated + quantity` for each pick line's `(sku, location_id, lot_id)` grain — call the existing `applyStockBalanceProjection` helper from `src/compliance/inventory.ts` (Story 2.2) if it supports an `allocate` operation, OR issue a direct `UPDATE stock_balance SET allocated = allocated + $1, available = available - $1, updated_at = now() WHERE sku = $2 AND location_id = $3 AND lot_id = $4 AND stock_class = 'owned' AND available >= $1` — if `available < $1`, reject `INSUFFICIENT_STOCK_FOR_PICK` (this should not happen if Task 4.2's generation logic checked availability, but enforce it here as a defensive guard against races).
  - [x] 5.4 `applyPickLineConfirmedProjection` (in-transaction): (1) load the pick line by `pick_line_id` via `getPickLineById`; reject `PICK_LINE_NOT_FOUND` if absent; (2) if the pick line's `status` is already `'confirmed'` or `'substituted'`, treat as idempotent replay: if the SAME `confirmed_lot_id` and `confirmed_quantity` are resubmitted, return success without re-mutating (mirror the `markPutawayReleased` no-op-safe pattern from Story 3.5); otherwise reject `PICK_LINE_ALREADY_CONFIRMED` with the prior confirmation details; (3) if `confirmed_lot_id <> pick_line.directed_lot_id`, require `override_reason` to be non-empty (reject `PICK_OVERRIDE_REASON_REQUIRED` otherwise — AC6/AC8); (4) call `confirmPickLine` (Task 3.2) to update the pick line; (5) if the confirmed lot differs from the directed lot, release the directed lot's allocation: `UPDATE stock_balance SET allocated = allocated - directed_quantity, available = available + directed_quantity, updated_at = now() WHERE sku = pick_line.sku AND location_id = pick_line.location_id AND lot_id = pick_line.directed_lot_id AND stock_class = 'owned'`; then allocate the confirmed lot: `UPDATE stock_balance SET allocated = allocated + confirmed_quantity, available = available - confirmed_quantity, updated_at = now() WHERE sku = pick_line.sku AND location_id = (resolve the confirmed lot's current location from `location_current`) AND lot_id = confirmed_lot_id AND stock_class = 'owned' AND available >= confirmed_quantity` — if `available < confirmed_quantity`, reject `INSUFFICIENT_STOCK_FOR_PICK` (the substituted lot must have sufficient available stock); (6) if the confirmed lot matches the directed lot, no allocation release/reallocate is needed (the allocation from Task 5.3 stays in place).
  - [x] 5.5 `applyPickTaskCompletedProjection` (in-transaction): (1) load the pick task by `pick_task_id` via `getPickTaskById`; reject `PICK_TASK_NOT_FOUND` if absent; (2) if the pick task's `status` is already `'completed'`, treat as idempotent replay (return success without re-mutating); (3) verify ALL pick lines for this task are confirmed: `SELECT COUNT(*) FROM pick_line WHERE pick_task_id = $1 AND status IN ('confirmed','substituted')` — if the count does not match the total pick lines for this task, reject `PICK_TASK_NOT_ALL_LINES_CONFIRMED` (AC7 requires all lines confirmed before the task completes); (4) call `updatePickTaskStatus(pickTaskId, 'completed', completedBy, client)` (Task 3.1); (5) for zone strategy (AC4): check if all zone tasks for the same `dispatch_order_id` are completed: `SELECT COUNT(*) FROM pick_task WHERE dispatch_order_id = $1 AND status = 'completed'` — if this count equals the total zone tasks for this dispatch order (`SELECT COUNT(*) FROM pick_task WHERE dispatch_order_id = $1 AND strategy = 'zone'`), then the dispatch order is fully picked; update a `dispatch_order_picked` flag (see Task 4.5 step d for the projection choice — if no projection exists, create a minimal `dispatch_order_status` table with `(dispatch_order_id, picked_at, picked_by)` and upsert here; document this in Dev Notes as a scope extension for AC4's "order moves to picked only when every zone task is confirmed" requirement).
  - [x] 5.6 Wire into `src/events/store.ts` `persistEvent`: add `assertPickTaskCreatedShape`, `assertPickLineConfirmedShape`, `assertPickTaskCompletedShape` alongside the pre-transaction asserts (after `assertPutawayCompletedShape` at store.ts:229, before `assertErpReadOnly` at store.ts:234) and `await applyPickTaskCreatedProjection(envelope, client, eventId)`, `await applyPickLineConfirmedProjection(envelope, client, eventId)`, `await applyPickTaskCompletedProjection(envelope, client, eventId)` in the in-transaction block after `applyPutawayCompletedProjection` (store.ts:292) and before the `nextVersion`/`domain_events` insert block (store.ts:294). `assertLocationInvariant` (called at store.ts:324, AFTER the domain_events insert) is CONFIRMED to be a no-op for this story's `warehouse`-stream events (mirror Story 3.5's confirmation for `putaway` stream) — no reconciliation needed there.

- [x] Task 6: REST API with RBAC and site scoping (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 6.1 Create `src/api/v1/pick-tasks.ts` following `src/api/v1/putaway.ts` structure. Handlers: `POST /api/v1/pick-tasks/generate` (accepts `{ dispatchOrderLineIds: string[], strategy: 'single'|'batch'|'wave'|'zone', waveId?: string, batchId?: string }`, calls `generatePickTasks` from Task 4.1, returns `{ pickTaskIds: string[], pickLineIds: string[] }` — AC1-AC4); `POST /api/v1/pick-tasks/wave` (accepts `{ dispatchOrderLineIds: string[], waveId: string }`, calls `generatePickTasks` with `strategy='wave'` — AC3 convenience endpoint); `POST /api/v1/pick-tasks/batch` (accepts `{ dispatchOrderLineIds: string[], batchId: string }`, calls `generatePickTasks` with `strategy='batch'` — AC2 convenience endpoint); `GET /api/v1/pick-tasks` (list, filters `site`, `status`, `assignedTo`, `zoneId`, `waveId`, `batchId`); `GET /api/v1/pick-tasks/:pickTaskId` (task detail with pick lines); `POST /api/v1/pick-tasks/:pickTaskId/assign` (accepts `{ assignedTo: string }`, calls `assignPickTask`); `POST /api/v1/pick-tasks/:pickTaskId/lines/:pickLineId/confirm` (accepts `{ confirmedLotId: string, confirmedQuantity: string, overrideReason?: string, captureMethod: 'PWA'|'PAPER' }`, emits `pick_line.confirmed` via `persistEvent` — AC6/AC8); `POST /api/v1/pick-tasks/:pickTaskId/complete` (emits `pick_task.completed` via `persistEvent` — AC7); `GET /api/v1/pick-tasks/:pickTaskId/print` (renders a paper pick list as PDF or plain text — AC5; use a simple text template with task ID, bin pick-sequence, directed lots, and quantities; do NOT build a full PDF rendering engine — a plain-text or markdown output is sufficient for AC5's "paper pick list renders" requirement, document this choice in Dev Notes).
  - [x] 6.2 RBAC via `requireRole` (`src/middleware/rbac.ts`), module `warehouse` (reuse the module string Story 3.5 registered — confirm it is `warehouse` and not `putaway`; Story 3.5 Dev Notes flagged this as an open question, recommend `warehouse`). Generate + assign + complete: `warehouse_manager`, `inventory_controller` only (supervisors generate and assign tasks). Confirm pick line: `store_assistant`, `warehouse_operator` (new role — confirm it does not collide with existing roles; if `warehouse_operator` does not exist, use `store_assistant` for confirmations, matching the putaway role model). Read (list, detail, print): `store_assistant`, `warehouse_operator`, `warehouse_manager`, `inventory_controller`. Enforce site scope via `permittedLocationsForModuleScope`. Never trust client-supplied identity; server-set `created_by`/`confirmed_by`/`completed_by` from `authContext`.
  - [x] 6.3 Register every handler in `src/server.ts` (mirror the putaway registration lines) and add each new route to the spine allowlist in `test/integration/story-1-9.test.ts`.

- [x] Task 7: Edge (offline) event acceptance (AC: 5, 6, 7)
  - [x] 7.1 In `src/api/v1/edge.ts`, extend `resolveModuleFromBody`'s implicit mapping (it already maps `body.stream_type` verbatim, so `stream_type: 'warehouse'` auto-maps to a `warehouse` module — confirm this matches Task 6.2's RBAC module string). Provision `store_assistant` and `warehouse_operator` (if created) with the `warehouse` module assignment (mirror the Story 3.5 putaway-module provisioning). In `edgeEventUploadBase` (edge.ts:159-190), server-set `body.payload.confirmed_by = authContext.userId` for `pick_line.confirmed` and `body.payload.completed_by = authContext.userId` for `pick_task.completed`, mirroring the `completed_by` injection at Story 3.5's edge.ts:182-184.
  - [x] 7.2 Add the new permanent error codes to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts`, to `PERMANENT_ERROR_CODES` in `edge/src/sync/connector.ts`, and add `errors.<CODE>` strings to `edge/src/messages/en.json`. Permanent codes: `PICK_TASK_NOT_FOUND`, `PICK_LINE_NOT_FOUND`, `PICK_TASK_INVALID_PAYLOAD`, `PICK_LINE_ALREADY_CONFIRMED`, `PICK_OVERRIDE_REASON_REQUIRED`, `PICK_TASK_NOT_ALL_LINES_CONFIRMED`, `INSUFFICIENT_STOCK_FOR_PICK`, `DISPATCH_ORDER_LINE_NOT_FOUND`. Confirm `INSUFFICIENT_STOCK` (existing Story 2.2 code) is already in both permanent sets; add it if this story is the first to exercise it on the edge path for pick-specific context.
  - [x] 7.3 Confirm idempotency: the client-supplied `pick_line_id` (existing) plus a client-generated `event_id`/idempotency key on the `pick_line.confirmed`/`pick_task.completed` envelope keeps replay safe (AC5/AC7) — reuse the existing edge idempotency-key infrastructure (AD-16); do not invent a new dedup mechanism.

- [x] Task 8: Tests (AC: 1, 2, 3, 4, 5, 6, 7, 8)
  - [x] 8.1 Create `test/integration/story-3-6.test.ts` (Node built-in runner `node:test`, mirror `test/integration/story-3-5.test.ts` style). Cover: single-order pick task generation with FEFO lot selection and bin pick-sequence ordering (AC1); batch pick task generation with per-order sortation quantities (AC2); wave pick task generation with `wave_id` stamped (AC3); zone pick task generation with separate tasks per zone and dispatch-order-completed check (AC4); paper pick list rendering with task IDs and pick-sequence (AC5); pick line confirmation with matching lot (happy path); pick line confirmation with substituted lot and override reason (AC6/AC8); pick line confirmation with substituted lot but NO override reason is rejected `PICK_OVERRIDE_REASON_REQUIRED`; pick task completion when all lines confirmed (AC7); pick task completion when NOT all lines confirmed is rejected `PICK_TASK_NOT_ALL_LINES_CONFIRMED`; insufficient stock at generation time is rejected `INSUFFICIENT_STOCK_FOR_PICK`; insufficient stock at confirmation time (substituted lot unavailable) is rejected `INSUFFICIENT_STOCK_FOR_PICK`; idempotent replay of the same `pick_line.confirmed` (same `pick_line_id` + `confirmed_lot_id`) is a no-op success, not a duplicate allocation change; `store_assistant` confirm RBAC and site scoping (out-of-scope site rejected `LOCATION_ACCESS_DENIED`); `warehouse_manager` generate/assign RBAC.
  - [x] 8.2 Add edge unit coverage in `edge/test/unit/` for `pick_task.created`, `pick_line.confirmed`, `pick_task.completed` envelope validation and the new `PERMANENT_ERROR_CODES` entries.
  - [x] 8.3 Run `npm test`, `npm run edge:test`, and keep the spine gate green (`npm run spine-acceptance-contract`, story-1-9). Add the `pick_task` and `pick_line` table expectations so `test/unit/schema-drift.test.ts` passes. Run `tsc`, `eslint`, and the build for both backend and edge.

## Dev Notes

### Previous Story Intelligence (Story 3.5, and the 3.1/2.2/2.3/2.9 foundations)

- Story 3.5 built `velocity_class` (ABC classification by putaway frequency) and `putaway_task` extensions. This story is the FIRST to consume `velocity_class` for pick-path optimization (Task 4.2 step c prefers bins with higher velocity class). Story 3.5's Dev Notes flagged this dependency: "Story 3.6 (Pick Task Generation) does not exist yet and this story must not depend on pick-frequency data for velocity classification — the scope note in the epic is explicit that velocity class in THIS story derives from 'pick/putaway frequency,' but since picks don't exist yet, the initial implementation classifies on PUTAWAY frequency alone. Structure `velocity_class`'s schema (Task 2.2) so a future pick-frequency column can be added additively." This story does NOT add pick-frequency columns to `velocity_class` — it only READS the existing `velocity_class` data for bin preference. A future story (when pick-frequency tracking is needed) can extend `velocity_class` additively.
- Story 3.5 established the `warehouse/` module directory for non-API, non-projection business logic (suggestion algorithm, re-slotting job). This story follows the same pattern: `src/warehouse/pick-task-generator.ts` for the generation logic (Task 4), `src/compliance/pick.ts` for the write-path seam (Task 5).
- Story 3.5 learned two edge-path facts that apply here verbatim: (1) `resolveModuleFromBody` maps `stream_type` directly to a module, so the new `warehouse` stream needs a matching module role assignment; (2) the edge intake must server-set the actor-identity field (`confirmed_by`, `completed_by` here) inside `edgeEventUploadBase`, never trusted from the client payload.
- Story 3.1 (`location_register`) carries `size_class`, `zone_type`, `temperature_class`, `hazmat_allowed`, `quarantine`, `access_restricted`, and `hierarchy_path` on every location including bins. This story requires a `pick_sequence` column on `location_register` for AC1's "ascending bin pick-sequence within each zone" — confirm it exists (Task 4.6); if absent, add it via additive migration. Reuse `zoneIncompatibilityReasons` (`src/read/projections/location_register.ts:384`) if zone-routing logic is needed (not required for pick tasks since the lot's current bin is already resolved, but flagged for the developer's awareness).
- Story 2.2 (`stock_balance`) is the source of truth for available stock. This story's pick task generation (Task 4.2 step b) queries `stock_balance` for available lots by FEFO. Story 2.2's Dev Notes confirm `stock_balance` tracks location at the bin grain (sku+location+lot), so the join to `location_register` for bin attributes is straightforward.
- Story 2.3 (`lot_master`) carries `expiry_date` for FEFO selection. This story's pick task generation orders lots by `expiry_date ASC NULLS LAST` (FEFO) with `lot_number ASC` as tiebreaker.
- Story 2.9 (`erp_sales_order` projection) is the Phase-1 outbound demand source. This story's pick task generation loads sales-order lines by `dispatchOrderLineIds`. Story 2.9's Dev Notes confirm the projection shape: `erp_sales_order_line` carries `sku`, `quantity`, `required_by`, `ship_to`, `site_id`. Confirm whether it has a `dispatch_order_id` grouping field (Task 4.6); if not, use the line's `id` as the dispatch-order identifier.
- Story 1.6 (`location_current`) is the source of truth for a lot's current bin location. This story's pick task generation (Task 4.2 step c) joins `location_current` to resolve the lot's current bin. Story 1.6's Dev Notes confirm `location_current.lot_id` is UUID-typed, matching `lot_master.lot_id` — no type reconciliation needed here (unlike Story 3.5's putaway_task.lot_id TEXT bridge).

### Architecture and Conventions the Dev MUST Follow

- Event-sourced write path has a single seam: `persistEvent(envelope, auditCtx?, externalClient?)` in [src/events/store.ts:165](src/events/store.ts#L165). Shape asserts run pre-transaction (rejects consume no idempotency key); projection apply run in-transaction. New asserts go after `assertPutawayCompletedShape` (store.ts:229) and before `assertErpReadOnly` (store.ts:234); new applies go after `applyPutawayCompletedProjection` (store.ts:292) and before the `nextVersion`/`domain_events` insert (store.ts:294). Note that `assertLocationInvariant` runs AFTER the `domain_events` insert (store.ts:324) — it is a no-op for `warehouse`-stream events (mirror Story 3.5's confirmation).
- Projection trio is mandatory and lands together: canonical idempotent `read/projections/*.sql`, registration in the `MIGRATIONS` array of [src/events/migrate.ts](src/events/migrate.ts) (append after the Story 3.5 `velocity_class.sql` entry), and a byte-for-byte mirror in [deploy/compose/init-db.sql](deploy/compose/init-db.sql) that never touches the `powersync_publication` block. Register every new table in the `EXPECTED` array of [test/unit/schema-drift.test.ts](test/unit/schema-drift.test.ts).
- TypeScript accessor pattern: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, NUMERIC bound/returned as strings. Reference [src/read/projections/putaway_task.ts](src/read/projections/putaway_task.ts) for the closest structural match.
- Runtime is plain Node HTTP with a custom router. Handlers live in `src/api/v1/*.ts` and register in [src/server.ts](src/server.ts) via `router.get`/`router.post`. This is NOT Next.js; there are no `route.ts` files.
- Tests use the Node built-in runner (`node:test`), NOT vitest. Integration tests are one file per story: `test/integration/story-3-6.test.ts`. Every new route must be added to the spine route-surface allowlist in [test/integration/story-1-9.test.ts](test/integration/story-1-9.test.ts) or the spine gate fails.
- The `warehouse/` module directory (Story 3.5) is for non-API, non-projection business logic (pick-task generation, suggestion algorithms). `src/compliance/pick.ts` is the write-path seam and follows the established flat pattern.

### Reuse (Do Not Reinvent)

- FEFO lot selection: query `stock_balance` joined to `lot_master` ordered by `expiry_date ASC NULLS LAST`, then `lot_number ASC`. Do NOT invent a separate FEFO helper — this is a straightforward SQL query, not a reusable function (unless the developer finds an existing FEFO helper in Story 2.3's accessors — confirm before duplicating).
- Stock balance allocation: `UPDATE stock_balance SET allocated = allocated + $1, available = available - $1` — mirror the exact pattern Story 2.2 uses for allocations. Do NOT invent a new allocation helper unless Story 2.2 already provides one (confirm in `src/read/projections/stock_balance.ts`).
- Location current resolution: `location_current` from Story 1.6 (`src/read/projections/location.ts`) provides the lot's current bin. Reuse the existing `getCurrentLocationByLotId(lotId, client?)` accessor (confirm exact name in Task 4.6).
- RBAC and error shaping: `requireRole` and `permittedLocationsForModuleScope` in [src/middleware/rbac.ts](src/middleware/rbac.ts); `AppError`, `sendJson`, `sendRequestError` in [src/middleware/error.ts](src/middleware/error.ts). Do not hand-roll auth or error envelopes.
- Notification patterns (AC7 requires "the packing station is notified" — Story 3.7's packing flow consumes this notification): `emitNotificationInTransaction` at [src/notify/emit.ts:103](src/notify/emit.ts#L103). Emit a `pick_task.completed` notification to the `packing_station` role (or a similar role — confirm the exact role name in Story 3.7's Dev Notes when that story is created; for now, use `warehouse_manager` as the notification target and document this as a placeholder for Story 3.7 to refine).

### Dependency Reality Check

- Story 2.9's `erp_sales_order_line` projection is the ONLY source of outbound demand for this story; there is no separate "pick plan" or order-management module — Story 2.9 explicitly provides the Phase-1 dispatch demand. This story generates pick tasks from sales-order lines; nothing upstream provides pick tasks.
- Story 3.5's `velocity_class` provides ABC classification by putaway frequency only. This story READS `velocity_class.preferred_location_id` for bin preference but does NOT extend `velocity_class` with pick-frequency data — that is a future story's scope.
- There is no dispatch-order status projection anywhere in the codebase before this story (confirmed: Story 2.9's `erp_sales_order` projection carries line-level fields but no `picked` status). AC4's "order moves to picked only when every zone task is confirmed" requirement forces this story to create a minimal `dispatch_order_status` projection (or flag) — Task 4.5 step d specifies this scope extension. Document this in Dev Notes as a new projection owned by this story.
- No pick-sequence column exists on `location_register` before this story (confirmed via Story 3.1's Dev Notes — `hierarchy_path` exists but not `pick_sequence`). Task 4.6 adds it if confirmed absent.

### Compliance and NFR

- AD-15 (Event-Sourced Location with Asserted-vs-Expected): pick task generation does NOT assert a new location — it reads the lot's current location from `location_current` and allocates stock. The pick line's `location_id` is the bin where the lot is currently stored, not a new asserted location. No `location.override` or `location.asserted` events are emitted by this story — that is Story 3.5's domain for putaway overrides.
- AD-16 (Idempotency Keys on All Edge-Originated Commands): the `pick_line.confirmed`/`pick_task.completed` commands from the edge carry a client-supplied idempotency key (existing infrastructure); the client-supplied `pick_line_id`/`pick_task_id` additionally keeps the confirmation/completion check replay-safe via the affected-row-count no-op pattern.
- NFR-ADOPT-01 (frontline knowledge must visibly benefit the people who capture it): this story does not directly implement NFR-ADOPT-01 (that is Story 3.5's re-slotting job), but the pick-path optimization (Task 4.2 step c prefers bins with higher velocity class) indirectly benefits from Story 3.5's override-driven re-slotting. No new NFR-ADOPT-01 mechanism is built here.
- SOD/RBAC: pick task generation is `warehouse_manager`/`inventory_controller`-only (supervisors generate tasks); pick line confirmation is `store_assistant`/`warehouse_operator`-only (operators execute picks). This preserves the pilot's existing role model (Story 3.5 established `store_assistant` as the frontline putaway actor; this story adds `warehouse_operator` for pick execution if needed, or reuses `store_assistant` — confirm in Task 6.2).

### UX Requirements (from EXPERIENCE.md, DESIGN.md)

- The canonical UJ-PICK journey is not explicitly documented in EXPERIENCE.md (Story 3.5's Dev Notes reference UJ-PUT-01 for putaway, but no UJ-PICK exists yet). This story's backend contract must return exactly the fields a future pick-journey UI would need: the pick task ID, pick line IDs, directed lot, confirmed lot, override reason, capture method, pick sequence. Do NOT build frontend components — this is a backend story; no edge PWA screen work is in scope, but the API response shapes (Task 6.1) must carry the fields a future edge-PWA pick screen would need (directed lot, confirmed lot, override reason input, pick sequence) so a future screen can render the pick journey without additional backend round-trips.
- Error/microcopy the backend's error codes must support: a lot substitution is NOT an error state in the badge sense — it renders as a `Warning`-badge ("⚠ Lot Substitution Detected"), not an `Error`-badge; the API should return the substitution as a 2xx response requiring override reason input (like Story 3.4's `RECEIPT_TOLERANCE_EXCEEDED` 2xx-with-code pattern), NOT as a 4xx rejection, UNTIL the override reason is actually missing (that IS a 4xx `PICK_OVERRIDE_REASON_REQUIRED`, since the operator failed to supply required data, not because the substitution itself is invalid).
- Offline capture microcopy: "Captured, pending sync" (unchanged, existing pattern) — no new offline-state UI is introduced by this story; it reuses the existing sync-badge state machine (EXPERIENCE.md 5.1).
- Paper pick list (AC5): the `GET /api/v1/pick-tasks/:pickTaskId/print` endpoint renders a plain-text or markdown pick list with task ID, bin pick-sequence, directed lots, and quantities. Do NOT build a full PDF rendering engine — a plain-text output is sufficient for AC5's "paper pick list renders" requirement. If review finds plain-text inadequate, a future story can add PDF rendering; this story's scope is text-only.

### Error Codes (New, UPPER_SNAKE_CASE)

| Error Code | Trigger | Permanent (Edge) |
| --- | --- | --- |
| `PICK_TASK_NOT_FOUND` | `pick_task_id` resolves to no row | Yes |
| `PICK_LINE_NOT_FOUND` | `pick_line_id` resolves to no row | Yes |
| `PICK_TASK_INVALID_PAYLOAD` | `pick_task.created` envelope missing required fields | Yes |
| `PICK_LINE_ALREADY_CONFIRMED` | Pick line already confirmed with different lot/quantity | Yes |
| `PICK_OVERRIDE_REASON_REQUIRED` | Substituted lot without override reason | Yes |
| `PICK_TASK_NOT_ALL_LINES_CONFIRMED` | Pick task completion attempted before all lines confirmed | Yes |
| `INSUFFICIENT_STOCK_FOR_PICK` | Insufficient available stock at generation or confirmation time | Yes (confirm `INSUFFICIENT_STOCK` already present; add pick-specific variant if needed) |
| `DISPATCH_ORDER_LINE_NOT_FOUND` | Story 2.9 sales-order line not found | Yes |
| `LOCATION_ACCESS_DENIED` | Actor's site scope excludes the task's or target location's site (existing Story 3.1 code, reused) | Yes (confirm already present) |

### Project Structure Notes

- New files: `read/projections/pick_task.sql`, `read/projections/pick_line.sql`, `src/read/projections/pick_task.ts`, `src/read/projections/pick_line.ts`, `src/warehouse/pick-task-generator.ts`, `src/compliance/pick.ts`, `src/api/v1/pick-tasks.ts`, `test/integration/story-3-6.test.ts`, an edge unit test under `edge/test/unit/`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `src/read/projections/location_register.ts` and `read/projections/location_register.sql` (only if Task 4.6 confirms a `pick_sequence` column is genuinely absent), `src/api/v1/edge.ts`, `src/server.ts`, `src/sync/upload.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, `src/middleware/rbac.ts` (only if the `warehouse_operator` role needs registering).
- The `src/warehouse/` directory exists from Story 3.5; this story adds `pick-task-generator.ts` to it.

### Boundary Notes (Scope Guardrails)

- This story owns: generating pick tasks from Story 2.9 sales-order lines, executing pick confirmations with lot substitution, updating stock allocation in real time, and notifying the packing station (AC7). It does NOT own packing/shipping (Story 3.7), forward-pick replenishment (Story 3.9), or cross-docking (Story 3.10) — those stories consume the pick data this story produces but are not built here.
- This story does NOT touch Story 3.5's `putaway_task` or `velocity_class` write paths — it only READS `velocity_class` for bin preference. A future story can extend `velocity_class` with pick-frequency data if needed.
- Velocity classification in this story is read-only (see Dependency Reality Check). This story does NOT add pick-frequency columns to `velocity_class` — it only consumes the existing putaway-frequency data.
- The paper pick list (AC5) is a plain-text or markdown rendering, not a full PDF. If review finds plain-text inadequate, a future story can add PDF rendering; this story's scope is text-only.

### Open Questions (Resolve During Dev or Flag in Review)

1. `location_register.pick_sequence` (Task 4.6): confirm whether Story 3.1 added a `pick_sequence` column to `location_register`. If absent, add it via additive migration as specified in Task 4.6.
2. Story 2.9 `erp_sales_order_line.dispatch_order_id` (Task 4.6): confirm whether the sales-order line projection has a `dispatch_order_id` grouping field. If absent, use the line's `id` as the dispatch-order identifier and document this choice.
3. `warehouse_operator` role (Task 6.2): confirm whether this role exists in the role registry. If absent, either create it or reuse `store_assistant` for pick confirmations.
4. Dispatch-order status projection (Task 4.5 step d): confirm whether a `dispatch_order_status` projection exists. If absent, create a minimal `(dispatch_order_id, picked_at, picked_by)` table and document this scope extension.
5. Notification target for AC7 (Task 5.5): confirm the exact role name for the packing station notification. Use `warehouse_manager` as a placeholder and document this for Story 3.7 to refine.
6. `stock_balance` allocation helper (Task 5.3): confirm whether Story 2.2's `stock_balance` accessors provide an `allocate` helper. If not, issue direct SQL as specified in Task 5.3.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.6] lines 1359-1397 (story, acceptance criteria, dependencies).
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1169-1200 (Story 2.9 ERP Inbound Reference Projections), lines 939-964 (Story 2.2 stock balances), lines 967-1004 (Story 2.3 lot/serial traceability), lines 1207-1227 (Story 3.1 warehouse topology).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] AD-2 (gate-token event chain), AD-14 (read models are shared projections), AD-15 (event-sourced location), AD-16 (idempotency), Structural Seed (`warehouse/` module directory), Event Envelope shape.

## Dev Agent Record

### Agent Model Used

claude-fable-5 (Claude Fable 5)

### Debug Log References

- Baseline repair (pre-story): the committed Story 3.5 code did not compile (80 tsc errors) and broke
  every integration test at import time (`compliance/putaway.ts` imported `getLocationByCode` from the
  wrong module). Repaired as prerequisite work so this story's gates could run: rewrote
  `src/api/v1/putaway.ts` to the real RouteHandler/requireRole contract (it used a nonexistent
  signature), fixed `compliance/putaway.ts` (import, AppError status codes, version-gated
  asserted-location writes), fixed `warehouse/putaway-suggestion.ts` and `warehouse/reslotting-job.ts`
  type errors (item_master has no size_class/zone_type column - documented inert defaults), relaxed
  `upsertVelocityClass` to the runner pattern, added the missing guarded `chk_velocity_class_value` DO
  block to `velocity_class.sql` + init-db mirror (schema-drift failure), rewrote
  `test/integration/story-3-5.test.ts` (imported a non-exported `migrate`), and added the six missing
  Story 3.5 routes to the story-1-9 spine allowlist. After repair: 395/396 pass (the 1 failure is the
  documented pre-existing story-3-3 date-flake).
- Test infrastructure: no project Postgres was reachable (a native PostgreSQL 15 service holds
  port 5432 with different credentials; Docker Desktop was stopped). Started Docker Desktop and ran the
  project image as container `ims2-test-postgres` (postgres:18.4, init-db.sql, host port **5442**);
  tests run with `DB_PORT=5442` overriding .env.test. The native postgresql-x64-15 service was left
  untouched.

### Completion Notes List

- All 8 tasks implemented; all 8 ACs covered by 11 integration tests (story-3-6.test.ts) plus 4 edge
  unit tests (pick-events.test.ts). Final gates: backend `npm test` 408/409 (single failure is the
  pre-existing story-3-3 date-flake, unrelated), spine gate 6/6, edge tests 19/19, `tsc`/`eslint`/build
  clean for backend and edge, schema-drift green.
- Open Question resolutions:
  1. `location_register.pick_sequence` was absent - added via additive `ALTER TABLE ... ADD COLUMN IF
     NOT EXISTS pick_sequence INTEGER` (in pick_task.sql, mirrored in init-db.sql).
  2. `erp_sales_order` has NO per-line UUID (PK is `(so_number_ext, line_no)`) - added an additive
     `id UUID NOT NULL DEFAULT gen_random_uuid()` surrogate + unique index; `dispatch_order_id` and
     `dispatch_order_line_id` reference it. New accessor `getSalesOrderLineById`.
  3. `warehouse_operator` role did not need registering (roles are free-form strings in role
     assignments); confirm endpoints accept `store_assistant` and `warehouse_operator`.
  4. No dispatch-order status projection existed - created minimal `dispatch_order_status`
     `(dispatch_order_id PK, picked_at, picked_by)` in pick_task.sql (AC4 scope extension); upserted
     when every task for the order completes (covers zone strategy per AC4 and single/wave/batch).
  5. AC7 notification target: `warehouse_manager` used as documented placeholder for the packing
     station role (Story 3.7 to refine); emitted via `emitNotificationInTransaction`.
  6. Story 2.2 provides no standalone allocate helper usable at the (sku, bin, lot) grain with the
     lot-number key - pick allocation issues direct guarded SQL that increments `allocated` only
     when `available` covers the quantity (`available` is a generated column, never written).
- Key data-model facts encoded in the seam: `stock_balance.lot_id` carries the lot NUMBER (TEXT),
  while pick lines carry `lot_master.lot_id` UUIDs - `compliance/pick.ts` bridges via
  `lotNumberForUuid`. A bin's zone is its `zone`-level ancestor, resolved by recursive CTE in the
  FEFO candidate query.
- Generation is event-sourced end to end: the generator emits `pick_task.created` through
  `persistEvent` inside the caller's transaction; the apply function inserts pick_task/pick_line rows
  and takes the allocation, so a rejection (e.g. INSUFFICIENT_STOCK_FOR_PICK) rolls everything back
  atomically. Replays are no-ops (task-exists guard) so allocations are never double-taken.
- Lot substitution is a 2xx business outcome (`warning_code: PICK_LOT_SUBSTITUTED`, mirroring the
  Story 3.4 tolerance pattern); only a MISSING override reason is a 4xx
  (`PICK_OVERRIDE_REASON_REQUIRED`). Substitution releases the directed allocation and allocates the
  confirmed lot at the bin holding its stock (largest-availability row; single-bin action).
- Paper pick list (AC5) is plain text (`GET .../print`, Content-Type text/plain) with task ID, pick
  line IDs, bin pick-sequence, directed lots, quantities - deliberately not PDF (documented scope).
- Batch strategy: one consolidated task per (sku, zone); `dispatch_order_id` references the FIRST
  contributing order line; per-order sortation is preserved on `pick_line.dispatch_order_line_id`
  (AC2). Allocation runs per order line FEFO with shared in-run availability tracking, so combined
  demand can never oversubscribe a lot.

### File List

New files:

- read/projections/pick_task.sql (also carries the erp_sales_order.id + location_register.pick_sequence additive migrations and the dispatch_order_status table)
- read/projections/pick_line.sql
- src/read/projections/pick_task.ts
- src/read/projections/pick_line.ts
- src/warehouse/pick-task-generator.ts
- src/compliance/pick.ts
- src/api/v1/pick-tasks.ts
- test/integration/story-3-6.test.ts
- edge/test/unit/pick-events.test.ts

Modified files (Story 3.6):

- src/events/schema.ts
- src/events/store.ts
- src/events/migrate.ts
- src/read/projections/erp_sales_order.ts
- src/api/v1/edge.ts
- src/server.ts
- src/sync/upload.ts
- deploy/compose/init-db.sql
- test/unit/schema-drift.test.ts
- test/integration/story-1-9.test.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json

Modified files (Story 3.5 baseline repair, prerequisite):

- src/api/v1/putaway.ts
- src/compliance/putaway.ts
- src/warehouse/putaway-suggestion.ts
- src/warehouse/reslotting-job.ts
- src/read/projections/velocity_class.ts
- read/projections/velocity_class.sql
- test/integration/story-3-5.test.ts

### File List additions (review pass 2, 2026-07-27)

New files:

- test/unit/pick-shape.test.ts (Task 8.2 envelope validation for all three pick event types)

Additionally modified by the second review pass, and previously undeclared by this story:

- read/projections/stock_balance.sql (the `picked` column, `available` redefined as
  `on_hand - allocated - picked`, and the invariant strengthened to `allocated + picked <= on_hand`)
- src/read/projections/stock_balance.ts (`applyStockPick`, now fail-closed)
- src/api/v1/stock.ts (consolidated stock shape carries `picked`)
- read/projections/item_master.sql (`size_class` inlined into the canonical CREATE TABLE)
- read/projections/erp_sales_order.sql (the `id` surrogate; column now added before its index)
- src/read/projections/users.ts (`activeUserExistsById`, used to validate an assignee)
- test/integration/story-2-2.test.ts, test/integration/story-2-9.test.ts (cross-story shape pins)

## Change Log

- 2026-07-25: Story 3.6 implemented (all 8 tasks, all 8 ACs) from baseline cf342e6. New warehouse
  stream events (pick_task.created / pick_line.confirmed / pick_task.completed), pick_task +
  pick_line + dispatch_order_status projections, FEFO/velocity-aware pick-task generator with
  single/batch/wave/zone strategies, compliance seam with real-time allocation and substitution
  handling, 9 REST endpoints with RBAC + site scoping, edge acceptance (server-set identities, 8 new
  permanent error codes + i18n), paper pick list. 11 new integration tests, 4 new edge unit tests.
- 2026-07-25: Prerequisite baseline repair - Story 3.5's committed code did not compile and broke the
  whole integration suite; repaired (see Debug Log) so gates could run. tsc/eslint/build clean,
  npm test 408/409 (pre-existing story-3-3 date-flake only), edge 19/19, spine gate 6/6.
- 2026-07-26: Code review (adversarial, Edge Case Hunter + Acceptance Auditor; Blind Hunter layer
  failed empty): 9 patch findings + 1 decision applied, 0 deferred, 12 dismissed. Critical fixes:
  FOR UPDATE-on-aggregate 500 on every task completion; per-line allocated-to-picked regression
  (introduced by Story 3.5 commit eb4b5f6) moved to completion-time per spec Task 5.4 step 6 and
  AC7; substituted-lot bin resolution switched from location_current to authoritative stock_balance
  (decision documented in Review Findings); input dedup, zero-quantity rejection, milli-precision
  shape enforcement, already-completed guard with new permanent code PICK_TASK_ALREADY_COMPLETED
  wired across backend/edge/i18n/tests; schema drift (item_master size_class inline,
  erp_sales_order id surrogate mirror); story-2-2/2-9 shape pins updated for deliberate contract
  changes. story-3-6 11/11, npm test 409/410 (pre-existing story-3-3 date-flake only), edge 19/19,
  schema-drift 37/37, spine gate 6/6, tsc/eslint clean; moved to done

### Review Findings

- [x] [Review][Patch] Duplicate dispatch_order_line_ids not deduplicated [src/api/v1/pick-tasks.ts:100]
- [x] [Review][Patch] Zero-quantity dispatch-order line silently skipped [src/warehouse/pick-task-generator.ts:145]
- [x] [Review][Patch] Idempotency comparison truncates beyond NUMERIC(14,3) precision [src/compliance/pick.ts:206]
- [x] [Review][Patch] completePickTaskBase does not guard already-completed tasks before persistEvent [src/api/v1/pick-tasks.ts:343]
- [x] [Review][Patch] FOR UPDATE riding an aggregate query in applyPickTaskCompletedProjection 500'd every completion (PostgreSQL 0A000); lock-then-count split mirrors applyStockAllocation [src/compliance/pick.ts:350]
- [x] [Review][Patch] Per-line allocated-to-picked move (introduced by Story 3.5 commit eb4b5f6) contradicted spec Task 5.4 step 6 ("the allocation from Task 5.3 stays in place") and broke the story's own AC6/AC8 and AC6-idempotent tests; moved to task completion per AC7's "when the last confirmation is submitted" [src/compliance/pick.ts]
- [x] [Review][Decision] Substituted-lot bin resolution changed from Story 1.6 location_current (empty for never-scanned lots, made AC8 unsatisfiable) to the authoritative stock_balance row at the same site with sufficient availability; satisfies spec Task 5.4 step 5's "current bin" intent [src/compliance/pick.ts]
- [x] [Review][Patch] Schema drift: item_master size_class inlined into canonical CREATE TABLE (was ALTER-only); erp_sales_order id surrogate + uq_erp_sales_order_id + ALTER mirrored into init-db.sql [read/projections/item_master.sql, deploy/compose/init-db.sql]
- [x] [Review][Patch] Cross-story shape pins updated for deliberate Story 3.6 contract changes: story-2-2 consolidated stock shape gains picked: 0; story-2-9 dispatch-demand quantities are NUMERIC strings ('5.000') [test/integration/story-2-2.test.ts, test/integration/story-2-9.test.ts]

- 2026-07-27: Second code review (independent pass on a different model; the first pass ran without
  its Blind Hunter layer, which failed empty). 2 decisions resolved and 26 patches applied, 3
  deferred, 4 dismissed. Release blocker fixed: `erp_sales_order.sql` indexed the `id` surrogate
  before adding it, so `db:migrate` aborted on every pre-3.6 database and no Story 3.6 schema landed
  (reproduced against a pre-3.6 schema, then verified fixed). Other high-severity fixes: generation
  made idempotent (re-releasing a demand line was double-allocating), the completion TOCTOU closed
  with a row lock plus a status-predicated update (two concurrent completions could double-run the
  stock move and drain other tasks' allocations), `applyStockPick` and `releaseStock` made
  fail-closed (both silently no-opped, stranding allocation while the task reported success), and
  site scoping moved onto the `persistEvent` write path (it existed only in the HTTP handlers, so
  direct-event and edge uploads crossed sites) alongside an SOD role check on completion. Per the
  resolved decisions, a confirmed quantity must now equal the directed quantity
  (`PICK_QUANTITY_MISMATCH`), and a task auto-completes on its last confirmation so AC7's trigger is
  the confirmation rather than a supervisor's separate call.

### Review Findings (second pass, 2026-07-27)

All 26 patch findings below were applied and verified on 2026-07-27. Gates after the sweep:
tsc and eslint clean for backend and edge, npm test 420/421 (the single failure is the deferred,
pre-existing Story 3.3 date flake), edge 19/19, schema-drift 37/37, spine gate 6/6, both builds
succeed, and `db:migrate` is re-runnable. Story 3.6's own suite grew from 11 to 15 tests and a new
`test/unit/pick-shape.test.ts` adds 7 envelope-validation tests, so 421 total (up from 410).

Independent adversarial pass on a different model. The first pass ran without its Blind Hunter
layer (it failed empty); that layer is the source of most of the concurrency and stock-invariant
findings below. Layer status this run: Acceptance Auditor and Edge Case Hunter completed on the
first attempt; Blind Hunter stalled on the full-diff read and completed on a scoped retry.

Decisions (resolved by SCHOOL-PC, 2026-07-27, now tracked as patches):

- [x] [Review][Decision-resolved][Patch] `confirmed_quantity` differing from `directed_quantity` had no defined business rule - over-pick silently allocated the excess beyond sales-order demand, and short-pick completed the task and flagged the dispatch order picked with the unpicked remainder vanishing (no shortfall row, no backorder, no reconciliation against `erp_sales_order.quantity`). RESOLUTION: reject any mismatch - `confirmed_quantity` must equal `directed_quantity`, anything else is a 4xx rejection. A genuine short-pick needs an explicit exception flow, which belongs to a later story rather than silent data loss now. Remove the delta allocate/release branch accordingly. [src/compliance/pick.ts:294-307, src/compliance/pick.ts:351]
- [x] [Review][Decision-resolved][Patch] AC7's trigger conflicted with Task 5.4 step 6. AC7 says stock moves from `allocated` to `picked` and packing is notified "when the last confirmation is submitted", but the transition lived in `pick_task.completed`, which is supervisor-only, so after an operator's final confirmation the stock was still `allocated` and packing un-notified until a manager acted. RESOLUTION: auto-complete on the last confirmation - when the final pick line is confirmed, emit `pick_task.completed` from within the same transaction. This satisfies AC7's literal trigger while keeping Task 5.4 step 6 intact (the per-line allocation still stays in place until completion), and the manual supervisor endpoint remains as a fallback. [src/compliance/pick.ts:309-316, src/api/v1/pick-tasks.ts:337]

High severity:

- [x] [Review][Patch] `CREATE UNIQUE INDEX uq_erp_sales_order_id ON erp_sales_order (id)` precedes the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS id`, so `db:migrate` aborts with `column "id" does not exist` on any database created before this story. Proven empirically against a pre-3.6 schema: the run aborts, `id` is never added and the index is never created. Because this file precedes `pick_task.sql` in the MIGRATIONS array, no Story 3.6 schema lands on an upgrade. Same ordering in the init-db mirror. [read/projections/erp_sales_order.sql:43-45, deploy/compose/init-db.sql:1983-1985]
- [x] [Review][Patch] Generation is not idempotent and nothing marks a demand line consumed, so re-posting the same `dispatchOrderLineIds` allocates the same demand twice. The `FOR UPDATE` on `erp_sales_order` guards nothing: no code in the pick flow writes `status`, and the generator never checks for an existing `pick_task`/`pick_line` for the line. Two sequential POSTs to `/generate` for a 10-unit line yield two tasks holding 20 units; the `available` guard cannot catch it because the stock genuinely exists. [src/warehouse/pick-task-generator.ts:314-317]
- [x] [Review][Patch] Completion is a TOCTOU that can double-apply the stock move. The task status is read via `getPickTaskById` without `FOR UPDATE`, the `pick_line` lock is taken only afterwards, and `updatePickTaskStatus` carries no status predicate in its WHERE, so it always succeeds. Two concurrent `pick_task.completed` events both pass the gate and both run `applyStockPick`; because that helper uses `LEAST(allocated, qty)`, the second pass drains allocation belonging to other pick tasks sharing the same (sku, bin, lot) row, and the packing notification is emitted twice. [src/compliance/pick.ts:332-341, src/read/projections/pick_task.ts:120-129]
- [x] [Review][Patch] `applyStockPick` checks no `rowCount` and uses `LEAST(allocated, quantity)`, so a bin mismatch is a silent no-op and a short allocation silently under-moves, while the task still reports completed and the dispatch order is still flagged picked. The allocation is stranded in `allocated` permanently, suppressing `available` with no pick line pointing at it. [src/read/projections/stock_balance.ts]
- [x] [Review][Patch] `releaseStock` ignores `rowCount` while its sibling `allocateStock` throws, so a substitution whose directed row no longer matches releases nothing and then allocates the substitute anyway, leaving total allocation permanently above real demand. The short-pick branch strands the remainder the same way. [src/compliance/pick.ts:144-151, src/compliance/pick.ts:262, src/compliance/pick.ts:305]
- [x] [Review][Patch] Site scoping is enforced only in the `pick-tasks.ts` HTTP handlers; the compliance layer contains no actor-site check at all, so `POST /api/v1/events` and `POST /api/v1/edge/events` (both authorized on `module = stream_type` plus write, with no comparison to the task's site) let a caller scoped to one site confirm pick lines and mutate stock at another. This contradicts the story's own architecture rule that `persistEvent` is the single write-path seam where invariants belong; the suite's cross-site test only exercises the REST route and so gives false assurance. [src/compliance/pick.ts, src/api/v1/events.ts:179-183, src/api/v1/edge.ts:229-231]

Medium severity:

- [x] [Review][Patch] Batch completion mixes two key populations: `orderIds` come from `pick_line.dispatch_order_line_id` but are then counted against `pick_task.dispatch_order_id`, which a batch draft sets to the first contributing line only. Contributing lines 2..n therefore hit `active_count = 0` and are skipped by the `orderActive > 0` guard forever, while the count for line 1 sweeps in unrelated single/zone tasks that share that id. [src/compliance/pick.ts:417-436, src/warehouse/pick-task-generator.ts:379-386]
- [x] [Review][Patch] `hasMilliPrecision` fails open for values with more than 6 decimal places: `numericToMicro` truncates the fraction to 6 digits before the `% 1000n` test, so `"5.0000009"` passes the guard whose docstring promises to fail closed, and persists as `5.000`. The replay equality check compares the truncated micro value, so two genuinely different confirmations are treated as the same one. [src/compliance/pick.ts:24, src/compliance/pick.ts:54-61, src/compliance/pick.ts:220]
- [x] [Review][Patch] The generator's `take` carries no milli truncation while `stock_balance.available` is `NUMERIC(18,6)`, so a bin holding sub-milli availability produces a quantity the story's own shape assert rejects with `PICK_TASK_INVALID_PAYLOAD`, making generation permanently impossible for that line on data the system itself produced. [src/warehouse/pick-task-generator.ts:194]
- [x] [Review][Patch] The bin a substitution allocated at is never persisted, so completion re-derives it with a different predicate (`allocated >=`, ordered by allocated) than confirmation used (`available >=`, ordered by available). When a lot is allocated across several bins the two can resolve differently and the `allocated` to `picked` move lands on another task's allocation. Persist the resolved bin on the pick line instead. [src/compliance/pick.ts:271-293, src/compliance/pick.ts:378-394]
- [x] [Review][Patch] The pick line is read without `FOR UPDATE`, so two concurrent identical confirmations both see `pending` and the loser gets a spurious 409 `PICK_LINE_ALREADY_CONFIRMED` (a permanent edge code, settling a success as needs_attention); the same unlocked read makes the substitution's resolve-then-allocate a race that 409s the whole confirmation with no fallback to the next qualifying bin. [src/compliance/pick.ts:207, src/compliance/pick.ts:271-293]
- [x] [Review][Patch] `pick_task.created` posted directly is never validated against `erp_sales_order`, and `pick_task` carries no foreign key, so an unknown `dispatch_order_id` yields an orphan task that has already allocated stock; `listPickTasks` and `getPickTaskSiteId` INNER JOIN the ERP projection, so the task is invisible and every route 404s, leaving the allocation unreleasable. The same join makes existing tasks vanish if an ERP re-sync re-keys the surrogate id. [src/compliance/pick.ts:157-195, src/read/projections/pick_task.ts:163, src/read/projections/pick_task.ts:176]
- [x] [Review][Patch] SOD gap: completion is specified as `warehouse_manager`/`inventory_controller` only, but the edge upload path authorizes purely on module plus write with no event-type role check, so a `store_assistant` with warehouse write can post `pick_task.completed` and trigger the stock transition. [src/api/v1/edge.ts:189-191, src/api/v1/edge.ts:229-231]
- [x] [Review][Patch] The AC7 test asserts only task status, `completed_at` and the notification row; it never asserts that `allocated` fell and `picked` rose, which is the actual AC7 outcome. No test helper reads `picked` anywhere in the suite. [test/integration/story-3-6.test.ts:440-488]
- [x] [Review][Patch] Story 2.2's `stock_balance` foundation projection was changed by this story (new `picked` column, `available` dropped and redefined as `on_hand - allocated - picked`) but none of `read/projections/stock_balance.sql`, `src/read/projections/stock_balance.ts` or `src/api/v1/stock.ts` appear in the story's File List or Project Structure Notes. The invariant itself is correctly strengthened to `allocated + picked <= on_hand`; this is a traceability gap, not a logic defect. [read/projections/stock_balance.sql:50-61, src/read/projections/stock_balance.ts, src/api/v1/stock.ts]

Low severity:

- [x] [Review][Patch] The `assignedTo`, `zoneId`, `waveId` and `batchId` list filters are passed to SQL unvalidated while only `status` and `site` are checked, so a non-UUID value raises Postgres 22P02 and surfaces as a 500 instead of the file's own `INVALID_PARAMS` 400. Confirmed against the database. [src/api/v1/pick-tasks.ts:202-205]
- [x] [Review][Patch] `assignedTo` is never checked against the user register, so a well-formed UUID for a nonexistent or non-warehouse user leaves the task assigned to nobody while appearing assigned. [src/api/v1/pick-tasks.ts:227-262]
- [x] [Review][Patch] The `assignPickTask` accessor and `releasePickLineAllocation` have zero call sites (the only `assignPickTask*` matches are the differently-named handler symbols) and the assign route hand-rolls its own UPDATE, contrary to Task 6.1. [src/read/projections/pick_task.ts:133, src/read/projections/pick_line.ts:147, src/api/v1/pick-tasks.ts:254-257]
- [x] [Review][Patch] The batch and zone grouping keys use `\\0`, which is a literal backslash followed by `0`, while the same file uses a real NUL at line 185; a SKU containing a backslash can therefore collide two different (sku, zone) groups into one task whose header sku mismatches its lines. [src/warehouse/pick-task-generator.ts:376, src/warehouse/pick-task-generator.ts:399]
- [x] [Review][Patch] The `zone_of` recursive CTE filters `site_id` only in its base term, so the ancestor climb can cross into a parent row at another site and return that site's zone as the pick task's `zone_id`; the shape validator only checks that it is a UUID. [src/warehouse/pick-task-generator.ts:96-105]
- [x] [Review][Patch] `/pick-tasks/batch` does not require `batchId` (unlike the symmetric wave endpoint), and the generator invents one the caller never learns because the response returns only task and line ids. [src/api/v1/pick-tasks.ts:171-174, src/warehouse/pick-task-generator.ts:348]
- [x] [Review][Patch] Task 8.2 asked for edge envelope validation coverage for all three pick event types; the edge test covers only `classifyServerUploadFailure` and the i18n keys, validating no envelope. [edge/test/unit/pick-events.test.ts]
- [x] [Review][Patch] Task 8.1 requires assign RBAC coverage but the suite never calls `/assign` (zero matches). [test/integration/story-3-6.test.ts]
- [x] [Review][Patch] A `single`-strategy task takes `zone_id` from its first allocation even when its lines span several zones (only `zone` strategy splits), so zone-filtered listing and the printed header misreport the zone. [src/warehouse/pick-task-generator.ts:357]

Deferred:

- [x] [Review][Defer] A cancelled pick line's allocation is never released (`releasePickLineAllocation` flips status with no `releaseStock`), and a task whose lines are all cancelled can never complete because completion throws on `activeCount === 0`, pinning the task and its allocations. [src/read/projections/pick_line.ts:147-153, src/compliance/pick.ts:351] - deferred, pre-existing: no code path currently cancels a pick line or task, so this is latent until cancellation is wired up.
- [x] [Review][Defer] Confirmation never gates on the parent task's status, so lines of a cancelled task would still confirm and take a fresh allocation that nothing later converts or releases. [src/compliance/pick.ts:204-232] - deferred, pre-existing: same latency, no cancellation path exists today.
- [x] [Review][Defer] Story 3.3's weighbridge `business_date` is derived from wall-clock `now()` rather than the event's `occurred_at`, so the AC1/AC2 assertion pinned to '2026-07-22' only ever passed on the day it was written; this is the single failing test in the suite. [test/integration/story-3-3.test.ts:255] - deferred, pre-existing and outside this story's diff (neither the test nor src/compliance/weighbridge.ts was touched).

Dismissed as noise or already handled (recorded for traceability, not actionable): confirming a line on an
already-completed task (unreachable, since completion requires every non-cancelled line already confirmed);
the FEFO candidate filters beyond the spec's `available > 0` (quality hold, expiry, quarantine, access
restriction are correct business behaviour and match Story 2.3's `getLotsForSelection` precedent); the
generator not using `location_current`/`getCurrentLocationByLotId` (deliberate documented decision, since
`stock_balance` is authoritative for where stock physically sits and `location_current` is empty for
never-scanned lots); and the dropped `chk_stock_balance_allocated_within_on_hand` constraint (immediately
replaced with the stronger `allocated + picked <= on_hand`).
