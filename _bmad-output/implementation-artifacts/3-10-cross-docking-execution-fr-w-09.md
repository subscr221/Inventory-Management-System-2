---
baseline_commit: c46fc21cc9422925a940232e4fbaebbee4e152f7
---

# Story 3.10: Cross-Docking Execution (FR-W-09)

Status: done

## Story

As a warehouse manager,
I want qualifying inbound receipts cross-docked directly to outbound staging without touching racking,
so that cross-dockable receipts clear the dock faster and dock-to-dispatch time shrinks.

## Acceptance Criteria

1. Given inbound stock on a receipt line matches an open sales-order line on the Story 2.9 projection and is flagged `cross_dock: true`, when the receiving event is confirmed, then exactly one ready cross-dock task routes the full received quantity from its receiving location to a selected outbound staging zone at the same site, the task is linked to the exact GRN line, sales-order line, SKU, lot, quantity, and correlation ID, and no reserve-storage putaway task is generated for that receipt line.
2. Given `cross_dock` is omitted or false, when receiving is confirmed, then all existing Story 3.4 validation, response, stock-posting, and ordinary putaway behavior remains unchanged. Given an explicit cross-dock request that is malformed or selects an invalid staging zone, receiving rejects it before stock posts. Given an otherwise valid explicit request whose stock requires QC or quarantine, is not owned, has no resolvable lot, exceeds the pick projection's exact quantity capacity, or has no same-site open sales-order line with enough unfulfilled quantity, receiving succeeds through the existing held or ordinary putaway path, creates no cross-dock task, and returns a stable bounded non-qualification reason.
3. Given multiple same-site open sales-order lines could fulfill the full receipt quantity, when cross-dock matching runs, then it subtracts directed quantity on all non-cancelled pick lines and ready cross-dock reservations using PostgreSQL `NUMERIC`, locks candidates in deterministic order by `required_by ASC NULLS LAST`, `so_number_ext`, `line_no`, and `id`, and chooses the first line with enough remaining demand. Completed cross-dock fulfillment is counted through its synthetic pick line, not again as a cross-dock reservation. Concurrent receipt and pick generation cannot reserve the same demand twice.
4. Given a ready cross-dock task is confirmed at an active staging bin, when the stock is moved, then the task, receipt, order line, lot, source location, destination ancestry, actor site, task quantity, demand state, and hold state are revalidated under row locks; the exact lot and quantity move from receiving to staging; a cross-dock-sourced completed pick task and confirmed pick line materialize the fulfillment; stock transitions through staging allocation into `picked`; and the dispatch order becomes picked only when its full projected quantity is fulfilled.
5. Given cross-dock completion changes stock, pick, dispatch, location, and task projections, when any operation fails, then the complete transaction rolls back, including the domain event and audit entry. An identical replay changes nothing; a conflicting second completion returns a stable 409 error; and no path can leave physical movement, allocation, pick fulfillment, dispatch status, or task status partially applied.
6. Given a supervisor or frontline operator accesses cross-dock work, when the request is processed through a dedicated REST route, `POST /api/v1/events`, or edge upload, then authenticated identity replaces payload identity, assignment is limited to `warehouse_manager` and `inventory_controller`, execution is limited to `store_assistant` and `warehouse_operator`, every authoritative entity resolves to the actor's permitted site, assignees are active and site-authorized, and unauthorized access fails with the existing uniform error envelope.
7. Given a cross-dock task is ready or completed, when the unified warehouse task board and productivity metrics are queried, then `cross_docking` is supported without changing the board response contract; ready tasks appear once with site, staging zone, assignment, priority, age, and SLA state; created tasks enter the productivity denominator; only completed tasks enter the numerator; and duration is computed in PostgreSQL from receipt confirmation time to staging confirmation time without fabricating timestamps.
8. Given a cross-dock completion is captured by an edge client with a known task ID, staging-bin scan, device ID, event ID, and idempotency key, when the device is offline or reconnects, then the generic outbox shows `pending_sync`, uploads the event in order, server-sets the actor, converges duplicate responses to `synced`, sends permanent domain failures to `needs_attention` with localized messages, and does not block unrelated queued work. Full offline task discovery and a new task-list PWA are outside this story because the current edge schema does not replicate warehouse task projections.
9. Given normal receiving, putaway, picking, packing, dispatch, replenishment, and ERP synchronization continue alongside cross-docking, when the full verification suite runs, then non-cross-dock behavior and public contracts remain unchanged, ERP reference rows remain read-only, held or expired stock cannot cross-dock, packing still consumes confirmed pick lines, dispatch still enforces all Story 3.7 holds and documents, and all schema, route, edge, audit, and compliance-spine guards pass.

## Tasks / Subtasks

- [x] Task 1: Define the cross-dock data contract and additive schema (AC: 1, 2, 3, 4, 7, 9)
  - [x] Add `cross_dock BOOLEAN NOT NULL DEFAULT false`, nullable `matched_dispatch_order_line_id UUID`, and nullable `cross_dock_nonqualification_reason TEXT` to `grn_line`. Preserve every existing column, status, discrepancy query, and grant.
  - [x] Create `read/projections/cross_dock_task.sql` with `cross_dock_task_id UUID PRIMARY KEY`, `grn_line_id UUID NOT NULL REFERENCES grn_line(grn_line_id)`, `dispatch_order_line_id UUID NOT NULL REFERENCES erp_sales_order(id)`, `sku TEXT NOT NULL`, `lot_id UUID NOT NULL REFERENCES lot_master(lot_id)`, `quantity NUMERIC(14,3) NOT NULL`, `site_id UUID NOT NULL REFERENCES location_register(location_id)`, `from_location_id UUID NOT NULL REFERENCES location_register(location_id)`, `staging_zone_id UUID NOT NULL REFERENCES location_register(location_id)`, nullable `to_location_id UUID REFERENCES location_register(location_id)`, `status`, `priority`, assignment fields, `created_by`, `created_at`, completion fields, `correlation_id`, `source_event_id`, and nullable `completion_event_id`. Keep the lot UUID distinct from the lot-number `TEXT` stored in `grn_line.lot_id` and `stock_balance.lot_id`; bridge through `lot_master` explicitly.
  - [x] Constrain status to `ready` or `completed`, priority to the existing four values, quantity to positive values, and completed fields to appear together. Add foreign keys for every internal entity ID where the referenced projection is stable, including GRN line, sales-order line, lot, locations, and user IDs where repository precedent permits. Do not add cancellation until release and rerouting semantics exist.
  - [x] Add a unique constraint on `grn_line_id` so one receipt line has at most one cross-dock task, plus indexes for site and status, staging zone and status, assignee and status, dispatch line and status, and correlation ID. Do not describe this constraint as enforcing the physical disposition; the transactional receiving branch and tests enforce mutual exclusion with putaway tasks.
  - [x] Grant `app_user` only INSERT, SELECT, and UPDATE and `readonly_user` only SELECT. Never grant DELETE.
  - [x] Create `src/read/projections/cross_dock_task.ts` with exact string quantity mapping, locked reads, replay-safe insertion, status-predicated assignment, status-predicated completion, detail reads, and board-compatible filtering.
  - [x] Extend `src/read/projections/grn_line.ts` additively and make replay conflict-safe. A reused GRN-line ID with different immutable receipt or cross-dock data must fail instead of overwriting a prior physical receipt.
  - [x] Widen `WarehouseTaskType` and the final `task_sla_config.task_type` constraint to include `cross_docking` through the guarded drop-and-add pattern. Preserve all existing task types and SLA grain behavior.
  - [x] Add a `fulfillment_source` column to `pick_task`, defaulting to `standard` and allowing `standard` or `cross_dock`, plus nullable `cross_dock_task_id UUID REFERENCES cross_dock_task(cross_dock_task_id)` on `pick_line`. Add a partial unique index on non-null `pick_line.cross_dock_task_id` so replay or concurrency cannot materialize more than one synthetic fulfillment line for a cross-dock task. Do not overload the existing pick strategy vocabulary.
  - [x] Append migration entries without reordering existing migrations, mirror every DDL change in `deploy/compose/init-db.sql`, and leave the PowerSync publication unchanged because this story does not replicate the task projection.

- [x] Task 2: Define event payloads and stable failures (AC: 1, 4, 5, 6, 8)
  - [x] Extend `goods.received` with optional `cross_dock`, `staging_zone_id` or `staging_zone_code`, and a server-generated `cross_dock_task_id`. Require `cross_dock` to be a boolean when supplied and require exactly one staging-zone selector when it is `true`.
  - [x] Register `cross_dock_task.assigned` and `cross_dock_task.completed` on the existing `warehouse` stream with `requiresBusinessStream: false`. Completion accepts task ID and exactly one destination bin ID or code; actor fields are server-owned.
  - [x] Carry deterministic cross-dock task, synthetic pick-task, and pick-line IDs in stored event payloads. Never generate projection identifiers during replay.
  - [x] Add pre-transaction shape assertions before idempotency lookup so malformed UUIDs, exact-decimal quantity shapes, mutually exclusive selectors, or task IDs do not consume an idempotency key. If `cross_dock` is omitted or false, reject supplied cross-dock-only fields rather than silently ignoring contradictory input.
  - [x] Add stable codes only for distinct client-actionable outcomes: `CROSS_DOCK_TASK_NOT_FOUND`, `CROSS_DOCK_TASK_NOT_READY`, `CROSS_DOCK_TASK_ALREADY_COMPLETED`, `CROSS_DOCK_STAGING_INVALID`, `CROSS_DOCK_DESTINATION_OUTSIDE_STAGING`, `CROSS_DOCK_SITE_MISMATCH`, `CROSS_DOCK_ORDER_NOT_OPEN`, `CROSS_DOCK_DEMAND_ALREADY_ALLOCATED`, and `CROSS_DOCK_QUANTITY_MISMATCH`. Use a bounded non-qualification reason, not an error code, for QC, quarantine, non-owned stock, missing lot, insufficient demand, and quantity-capacity fallback.
  - [x] Reuse `INVALID_PARAMS`, `LOCATION_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `LOT_ON_HOLD`, `INSUFFICIENT_STOCK`, `DUPLICATE_EVENT`, and `STREAM_CONFLICT` where those existing semantics apply. Do not create synonyms.

- [x] Task 3: Integrate deterministic demand qualification into receiving (AC: 1, 2, 3, 5, 9)
  - [x] Branch inside `applyGoodsReceivedProjection` after accepted-weighment, PO and SKU, tolerance, item, expiry, QC, quarantine, and target-location checks, but before ordinary putaway insertion. Cross-docking must never bypass any Story 3.4 control.
  - [x] Treat only literal `cross_dock: true` as a request. Preserve the observable behavior of the existing putaway path for omitted or false values; do not require byte-identical source code.
  - [x] Treat QC-held, quarantine-required, expired-to-quarantine, non-owned, or lot-less stock as ineligible and route it through the existing held or ordinary putaway behavior. Persist and return an allowlisted non-qualification reason for an explicit request. No cross-dock task may be created for such stock.
  - [x] Resolve the requested staging location as an active `level = 'zone'`, `zone_type = 'staging'` row at the authoritative receiving site. Reject an explicitly invalid or cross-site staging selector before stock, GRN, or task writes.
  - [x] Add a transaction-client matcher in `src/read/projections/erp_sales_order.ts`. It must read only `status = 'open'`, same SKU, same `ship_from_site_id`, lock candidates in the deterministic order from AC3, and calculate remaining demand as ERP quantity minus directed quantity on every non-cancelled pick line and ready cross-dock reservations. This counts pending, in-progress, and completed standard pick demand as reserved or fulfilled. Completed cross-dock fulfillment is already represented by its synthetic pick line and must not be subtracted a second time.
  - [x] Share the demand serialization grain with `src/warehouse/pick-task-generator.ts`, using the same transaction-level advisory lock per sales-order line or an equivalent deterministic row-lock protocol. Update normal pick generation to allocate only the remaining line demand after all non-cancelled pick-line quantity and ready cross-dock reservations; preserve existing live-pick duplicate behavior unless deliberately replaced by an equivalent exact-demand rule.
  - [x] Perform all demand arithmetic in PostgreSQL `NUMERIC` or exact decimal strings. Never use JavaScript `Number` for receipt, demand, reservation, stock, or pick quantity arithmetic.
  - [x] Select one order line only when it can absorb the full received quantity. If no line qualifies, complete ordinary receiving and putaway, persist one allowlisted reason such as `no_open_demand`, `insufficient_single_line_demand`, `qc_blocked`, `quarantine_required`, `non_owned_stock`, `lot_required`, or `quantity_out_of_pick_range`, and return it to the caller. Reject unknown or oversized reason text at the projection boundary. Do not reject otherwise valid stock and do not silently split one receipt line across orders in Phase 1.
  - [x] For a qualifying line, post stock once at the physical receiving location, persist the GRN and cross-dock fields, create exactly one ready cross-dock task, and skip `insertPutawayTask`. Preserve the existing `target_location_id` meaning as the actual receiving location. Return `putaway_task: null`, the created cross-dock task, and a null non-qualification reason.
  - [x] Enforce `NUMERIC(14,3)` capacity before qualification, including maximum precision and scale. Quantities outside that exact range use ordinary putaway with `quantity_out_of_pick_range` rather than failing an otherwise valid receipt.

- [x] Task 4: Implement event-sourced assignment and site enforcement (AC: 6, 7)
  - [x] Create `src/compliance/cross-dock.ts` and put all role, state, site, assignment, staging, quantity, order, and lot checks in this seam so dedicated REST, direct event, and edge paths cannot diverge.
  - [x] Implement cross-dock assignment through `persistEvent`, following Story 3.8's corrected `putaway_task.assigned` pattern and Story 3.9's intended `replenishment_task.assigned` review fix rather than the current direct replenishment assignment route at the baseline.
  - [x] Limit assignment and reprioritization to `warehouse_manager` and `inventory_controller`. Validate inside the compliance seam that the assignee is an active `store_assistant` or `warehouse_operator` with write access to the task site. A concurrent second assignment must not steal the task.
  - [x] Limit completion to `store_assistant` and `warehouse_operator`. Do not grant dispatch rights to these roles and do not let `dispatch_clerk` complete inbound movement by default.
  - [x] Resolve site from the stored task, GRN, order line, source location, staging zone, and destination. Compare it with the authenticated actor's concrete assignment inside the seam. Ignore client-supplied `assigned_by` and `completed_by`.
  - [x] Preserve wildcard access through the repository's explicit no-location sentinel convention; never treat a missing site as wildcard permission.

- [x] Task 5: Complete the physical move and outbound fulfillment atomically (AC: 4, 5, 9)
  - [x] Lock the cross-dock task first and use a consistent lock order for the order line, lot, source stock, destination stock, pick rows, and dispatch-status row to avoid deadlocks.
  - [x] For an already completed task, return no-op success only when destination, quantity, order line, lot, and completion identity match the persisted outcome. Return `CROSS_DOCK_TASK_ALREADY_COMPLETED` for conflicting replay.
  - [x] Revalidate that the order line remains open, the task still represents unfulfilled demand after excluding its own ready reservation, the lot UUID still resolves to the exact GRN lot number and SKU and is not held, the source contains the exact owned available quantity, and the destination is an active `level = 'bin'` row descending from the stored same-site staging zone. Reject the zone row itself and any inactive, restricted, quarantined, or cross-site descendant.
  - [x] Move the exact lot by calling existing stock helpers in one transaction: issue from receiving, receive into staging, allocate at staging, then transition that allocation to `picked`. Pass the lot number, not the lot UUID, to `stock_balance` helpers. Harden `StockReceiptInput`, `StockAllocationInput`, and `StockIssueInput` plus their callers to accept exact decimal strings rather than converting the persisted quantity to `Number`; preserve existing number callers additively.
  - [x] Materialize a deterministic completed pick task and confirmed pick line linked to the cross-dock task, with `fulfillment_source = 'cross_dock'`, the matched order line, received lot UUID, staging bin, exact quantity, authenticated actor, and event timestamps. Satisfy existing non-null pick fields with deterministic values and a documented existing strategy; do not add a new pick strategy. It must never appear as an open ordinary pick task, and its row timestamps must use the receipt and completion event instants rather than database wall-clock defaults.
  - [x] Update `dispatch_order_status.picked_at` only when exact SQL aggregation proves total confirmed non-cancelled pick quantity for the order line meets its ERP-projected quantity, and set `picked_at` to the completion event instant. Preserve normal batch, wave, and zone-pick completion behavior and prevent later standard picks from pushing fulfillment above demand.
  - [x] Emit the existing transactional packing-station notification only when the order becomes fully picked. Cross-docking does not bypass packing, document generation, lot-hold rechecks, or dispatch confirmation.
  - [x] Write expected and asserted location facts for the staged lot with source event, device, and actor provenance. A destination mismatch must be a dispute or rejection, never a silent last-writer-wins overwrite.
  - [x] Complete the cross-dock task with `completed_at = envelope.metadata.occurred_at`, `completed_by` from authenticated metadata, destination, and completion event ID. Reject clock-skewed completion earlier than creation rather than recording a negative duration.

- [x] Task 6: Extend the unified task board and honest metrics (AC: 7)
  - [x] Append one `cross_docking` entry to `TASK_SOURCES` in `src/warehouse/task-metrics.ts`; do not alter the generic union builder, board response shape, bounds, urgency ordering, or existing sources.
  - [x] Surface direct task `site_id`, `staging_zone_id` as `zone_id`, assignment, priority, status, and `created_at`. Ready tasks only appear on the open board.
  - [x] Append cross-docking to `COMPLETION_SOURCES` using its real `created_at` and `completed_at`, with attribution preferring `assigned_to` and falling back to `completed_by`.
  - [x] Keep denominator anchoring on task creation and numerator inclusion on completed status. Compute average and median duration in PostgreSQL and preserve exact site and zone scoping.
  - [x] Treat the measured interval as receipt-confirmation to staging-confirmation. Label it as cross-dock task duration in APIs and UI. Do not claim it is final vehicle-dispatch duration; Story 3.7's later `dispatch.dispatched` timestamp remains the source for a future end-to-end dock-to-dispatch KPI.

- [x] Task 7: Add REST and edge intake without inventing a parallel task service (AC: 1, 2, 6, 8)
  - [x] Extend `POST /api/v1/grn-lines` response additively with `cross_dock_task` and `cross_dock_nonqualification_reason`; preserve existing GRN, rejected-line, and putaway response fields and status codes.
  - [x] Add `POST /api/v1/cross-dock-tasks/:crossDockTaskId/assign` and `POST /api/v1/cross-dock-tasks/:crossDockTaskId/confirm`. Add a detail GET only if the existing task-board row lacks fields required by the execution client; do not add a second list endpoint.
  - [x] Validate path UUIDs and request shapes before querying PostgreSQL. Return the standard `{ error_code, message, details, trace_id }` envelope.
  - [x] Register routes in `src/server.ts` and the Story 1.9 route allowlist. Apply module, function, and location RBAC consistently.
  - [x] Extend `src/api/v1/edge.ts` to accept cross-dock completion, replace client actor fields, and resolve authoritative task site before persistence.
  - [x] Add cross-dock permanent codes to backend and edge upload classification and localized operator messages. Include `INVALID_PARAMS` only if the edge client can emit it and provide a safe localized correction message. Preserve generic duplicate, authentication halt, retry, and unrelated-row continuation behavior.
  - [x] Add a small edge capture builder for a known task ID and scanned destination code plus unit tests, following `edge/src/capture/test-capture.ts` and the generic `edge_outbox` shape. Wire it into the existing shell only if an operator-visible capture surface is required to satisfy AC8. Do not add a replicated task table, task-discovery screen, new service worker, or dependency in this story.

- [x] Task 8: Preserve UX, accessibility, and operator feedback contracts (AC: 6, 8)
  - [x] Any execution surface added in this story must be scan-first, tablet-first, keyboard operable, and usable one-handed with at least 44 by 44 pixel targets and visible focus.
  - [x] If an operator-visible execution surface is added, display task ID, GRN line, SKU, lot, exact quantity, matched sales-order line, expected staging zone, scanned staging bin, and current sync state before confirmation. A capture builder alone must not claim these UI requirements are complete.
  - [x] After operator-visible capture, state what completed, whether it is pending sync or synced, what identifier was recorded, and what the operator should do next. Do not use generic success copy.
  - [x] Keep the sync badge visible in the header and use the existing online, pending, syncing, and error states. Permanent errors require actionable Retry or correction guidance and live-region announcement.
  - [x] Use stable localization keys and solid-fill accessible status badges. Do not copy the low-contrast tinted wireframe badges or hard-code user-facing error strings.
  - [x] Preserve the current edge shell and first-sync state. A device without cached context must show the existing waiting-for-first-sync state rather than an empty task queue.

- [x] Task 9: Add exhaustive regression, concurrency, and atomicity tests (AC: 1 through 9)
  - [x] Create `test/integration/story-3-10.test.ts` using Node's built-in `node:test`, a real ephemeral HTTP server, real PostgreSQL projections, run-scoped IDs, SCIM provisioning, and no global state assumptions.
  - [x] Cover qualifying receipt, false or omitted flag with no cross-dock-only fields, contradictory fields when the flag is absent or false, no demand fallback, insufficient single-line demand fallback, QC, quarantine, non-owned, lot-less, and quantity-range fallback, invalid staging selector rollback, cross-site demand exclusion, deterministic multiple-candidate choice, fractional and maximum quantities, and exact response bodies.
  - [x] Prove a cross-dock receipt posts stock once, creates one task, creates no putaway task, stores the match and lot, and is unchanged by event-ID and idempotency-key replays.
  - [x] Race two receipts for the last demand and race cross-dock qualification against normal pick generation. Exactly one reservation path may win and the other must safely use ordinary putaway or fail with a stable conflict without over-allocation. Add pending and confirmed partial-standard-pick cases and prove all non-cancelled pick-line quantity plus ready cross-dock reservations plus a new reservation never exceeds ERP demand.
  - [x] Cover assignment authorization, active-user and assignee-site checks, assignment stealing, direct-event bypass, server-owned actor fields, cross-site reads, and completion by unauthorized roles.
  - [x] Cover destination by UUID and code, zone-row rejection, non-bin descendant, restricted or quarantined bin, inactive bin, cross-site bin, invalid UUID, unknown code, lot UUID and lot-number mismatch, held lot, closed order, quantity mismatch, source shortage, identical replay, conflicting replay, and two concurrent confirmations.
  - [x] Inject failures after stock issue, staging receipt, allocation, pick creation, dispatch-status update, location facts, and task completion. Assert no partial projection, event, audit, or stock change survives.
  - [x] Prove packing can consume the resulting confirmed pick line and that held-lot, shipping-document, and dispatch gates remain unchanged.
  - [x] Extend task-metric unit tests for an open task lowering confirmation rate, completed duration from receipt event time to completion event time, exact period boundaries, clock skew, site scope, zone rollup, SLA equality, and no fabricated completion.
  - [x] Extend backend and edge upload tests for duplicate convergence, permanent failure to `needs_attention`, localized messages, authentication halt, retryable server errors, and unrelated-event continuation.
  - [x] Extend schema-drift and route-surface tests for every new table, column, constraint, index, foreign key, grant, migration, init-db mirror, task type, and endpoint. Extend warehouse-task validation tests so `cross_docking` is accepted by both the board filter and SLA configuration APIs.
  - [x] Keep all Story 3.4, 3.6, 3.7, 3.8, and 3.9 tests green. Update legacy test reset lists only where the new table introduces persistent test state.

- [x] Task 10: Run the complete verification gate (AC: 9)
  - [x] Run `npm run build`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run spine-acceptance-contract`.
  - [x] Run `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test`, and `npm run edge:build`.
  - [x] Run the schema-drift suite and `npm run db:migrate` twice against the test database to prove idempotent migration.
  - [x] Run `git diff --check` and verify only intended files changed.
  - [x] Do not mark any task complete from code inspection alone. Record each command, exit result, test count, and any proven pre-existing failure in the Dev Agent Record.

## Dev Notes

### Binding Implementation Decisions

- `cross_dock: true` is an explicit receipt-line request, not permission to bypass controls. The central seam decides eligibility after ordinary receiving checks.
- Phase 1 uses one receipt line to one sales-order line and requires one line to absorb the full receipt. It does not silently split a receipt across multiple orders. This is the smallest deterministic interpretation of the story's singular task and matching-order language.
- A valid receipt that lacks qualifying demand or fails a stock-eligibility condition falls back to ordinary or held putaway with an allowlisted reason. Rejecting usable inbound stock because an optimization cannot apply would violate receiving continuity.
- QC, quarantine, expiry, lot hold, ownership, lot resolution, exact quantity capacity, and site controls take precedence over cross-docking.
- The caller selects the outbound staging zone by ID or code. Selecting an arbitrary first staging zone is forbidden because sites may have several staging areas.
- Completion creates cross-dock-sourced pick projections and moves the quantity to `picked`. Merely moving stock or increasing allocation would leave Story 3.7 unable to pack because packing reads confirmed pick lines and picked dispatch state.
- The task metric ends at staging confirmation. The product wording calls this dock-to-dispatch, but actual final dispatch occurs later in Story 3.7. The implementation must expose the honest interval and preserve the timestamps needed for a future final-dispatch KPI.
- Assignment is event-sourced. Do not copy the current Story 3.9 replenishment assignment route, which still mutates the projection directly even though the event schema and compliance functions for the intended fix exist.
- Edge scope is upload parity for a known task, not offline discovery. The current edge schema contains a generic outbox but no replicated warehouse-task projection, so pretending to deliver offline discovery would be a false completion claim.

### Architecture Compliance

- All domain mutations pass through `persistEvent` and join one PostgreSQL transaction. Shape validation runs before idempotency checks; projection work runs before the domain-event insert; audit and event commit together.
- Keep ERP sales-order data read-only. Cross-dock reservations live in warehouse-owned projections and are subtracted when calculating remaining demand.
- Use UUIDs for internal IDs, validated `_ext` strings for external IDs, UTC timestamps, dot-separated past-tense events, and the existing stable error envelope.
- Enforce RBAC, site scope, state, lot, quantity, and destination invariants in the compliance seam, not only in HTTP handlers.
- Use PostgreSQL row locks and a consistent multi-row lock order. `FOR UPDATE` blocks competing writers until transaction end; deterministic lock order is required to avoid deadlocks.
- Preserve exact quantities as PostgreSQL `NUMERIC` and strings at TypeScript boundaries. PostgreSQL 18 documents `numeric` as exact and floating-point types as inexact; do not introduce `Number` arithmetic into this flow. Existing stock receipt, allocation, and issue input types currently require `number`, so widen those interfaces and SQL-bound callers additively before reuse.
- Preserve asserted and expected location facts. A physical discrepancy is explicit and auditable, never last-writer-wins.
- No new package or runtime service is required.

### Existing Components to Reuse

- Extend `src/compliance/receiving.ts` at its existing stock, GRN, and putaway transaction boundary. Do not create an asynchronous post-receipt router.
- Extend `src/read/projections/erp_sales_order.ts` for exact, locked demand matching while preserving adapter-only mutations.
- Reuse stock helpers from `src/read/projections/stock_balance.ts`, but widen receipt, allocation, and issue quantity inputs to exact strings before reuse. `applyStockPick` already accepts a string.
- Reuse lot lookup and hold semantics from the Story 2.3 projections. `lot_master.lot_id` is a UUID while `grn_line.lot_id` and `stock_balance.lot_id` are lot-number text; never pass one namespace as the other.
- Reuse pick task, pick line, and dispatch-status projections so packing and dispatch continue through the established path.
- Extend the data-driven `TASK_SOURCES` and `COMPLETION_SOURCES` in `src/warehouse/task-metrics.ts`; do not build a parallel task board or metric service.
- Follow Story 3.8's event-sourced assignment and active-assignee checks.
- Follow Story 3.9's task projection and atomic internal-movement shape only where review has not identified defects. At this baseline, its assignment route still writes directly despite an intended event-sourced review fix, its destination check does not require a bin, and its stock helper calls convert quantities to `Number`; do not copy those defects. Add foreign keys, require a concrete source and active bin destination, validate assignee role and site access in the seam, preserve exact quantities, and test concurrent reservation.

### Current Update Files and Preservation Rules

- `src/compliance/receiving.ts`: currently validates binding, PO, SKU, tolerance, expiry, QC, stock, GRN, and unconditional putaway. Add the eligibility branch before putaway and preserve every existing rejection and committed discrepancy outcome.
- `src/api/v1/receiving.ts`: currently wraps receipt event, projections, and response in one transaction. Add deterministic IDs and additive response fields; preserve role, token-site precheck, rejection 200, and normal 201 behavior.
- `src/read/projections/erp_sales_order.ts`: currently exposes read-only demand plus adapter-only upserts. Add locked matching and remaining-demand reads; never add a warehouse write to ERP rows. Do not mutate `status` to represent warehouse fulfillment.
- `src/warehouse/pick-task-generator.ts`: currently locks open demand, rejects any existing live pick line for the requested order line, selects FEFO stock, and allocates atomically. Make the shared demand calculation subtract every non-cancelled pick line and ready cross-dock reservation without changing FEFO, route, batch, wave, or zone behavior or accidentally double-subtracting completed cross-dock work.
- `src/compliance/pick.ts`: currently creates picks, confirms exact quantities, moves allocation to picked, and marks dispatch status. Extract or add transaction helpers for deterministic completed cross-dock fulfillment and quantity-based dispatch readiness; preserve normal confirmation, substitution, SOD, and notification behavior.
- `src/compliance/dispatch.ts`: currently requires picked state and confirmed pick quantities before packing and rechecks lot holds. No cross-dock bypass or special dispatch path is allowed.
- `src/events/schema.ts` and `src/events/store.ts`: add types and fixed-order assertion and projection splices without reordering any prior seam.
- `src/warehouse/task-metrics.ts`: append one board and one completion source; preserve bounds, exact SLA comparison, SQL durations, and existing task populations. The `created_at` fed to the completion source must represent receipt confirmation, not row-insert wall-clock time.
- `src/compliance/warehouse-task.ts` and `src/api/v1/warehouse-tasks.ts`: widen the authoritative task-type validation used by SLA writes and board filters; changing only the TypeScript union and SQL constraint leaves the API rejecting `cross_docking`.
- `read/projections/grn_line.sql`, `pick_task.sql`, `pick_line.sql`, and `task_sla_config.sql`: make additive or guarded changes only and preserve all existing values.
- `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `test/unit/schema-drift.test.ts`, and `test/integration/story-1-9.test.ts`: maintain canonical migration, schema, and route parity.
- `src/api/v1/edge.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`: add cross-dock intake and classification while preserving generic queue semantics. Follow `edge/src/capture/test-capture.ts` for outbox creation and `edge/src/components/app-shell.tsx` for first-sync preservation.

### UX and Accessibility Guardrails

- Primary execution target is a rugged 7 to 10 inch tablet; scanning is primary and manual entry is fallback.
- Use one task per screen, a large autofocus scan field, action controls below it, portrait and landscape support, at least 44 by 44 pixel targets, at least 8 pixels between controls, visible focus, semantic labels, keyboard operation, and live-region feedback.
- Keep the sync badge in the header. The canonical design supersedes historical footer references.
- Production status badges use the accessible solid-fill treatment from the design audit, not the low-fidelity tinted wireframes.
- Every result identifies what happened, sync state, next action, and relevant task, receipt, lot, order, and location identifiers.

### Testing Requirements

- Backend tests use Node's built-in `node:test` through `tsx`, not Jest or Vitest.
- Integration tests must execute against PostgreSQL, verify response bodies and durable rows, and use run-scoped data instead of relying on test order.
- Quantity tests must include fractional scale, maximum accepted precision, invalid scale, and values that binary floating point cannot represent exactly.
- Concurrency tests must prove reservation and completion serialization rather than only asserting unique-index errors.
- Atomicity tests must inject failures at each projection boundary and prove event, audit, stock, task, location, pick, and dispatch state all roll back.
- The test database is configured on port 5442 in the current repository. Use the committed `.env.test` value and do not reintroduce the old 5432 workaround from earlier story notes.

### Latest Technical Information

- Keep the repository's installed versions. Backend runtime remains Node 24 LTS; as of 2026-07-31 Node 24 is still an LTS line. Do not upgrade to Node 26 Current inside this story.
- PostgreSQL 18.4 remains the project database and current supported documentation line. Use exact `NUMERIC`, `FOR UPDATE`, transaction-scoped advisory locks where the existing design requires them, and consistent lock ordering.
- The edge workspace currently pins Next.js 16.2.x, React 19.2.x, and PowerSync Web 1.39.x. Do not replace the established generic outbox or add another offline library.
- Current PowerSync Web guidance confirms local SQLite writes and asynchronous upload through the backend connector. Preserve the existing connector and settled-state conventions.
- Current Next.js 16 PWA guidance supports the existing manifest and service-worker approach. No new service worker is needed for cross-dock upload parity.

### Git and Previous Story Intelligence

- Baseline for story creation: `c46fc21cc9422925a940232e4fbaebbee4e152f7`.
- The latest implementation is Story 3.9. Reuse its canonical SQL, accessor, compliance, API, board-source, migration, route, and test layering, but do not copy its unresolved source-location, bin-level destination, missing foreign-key, assignee-site, UUID-validation, precision, assignment-event, or concurrent-reservation weaknesses.
- Story 3.8 is the stronger precedent for assignment, active-user validation, exact metrics, task-board bounds, and direct-event SOD enforcement.
- Story 3.6 review is the key warning for duplicate generation, double allocation, completion races, fail-open stock helpers, site checks living only in handlers, and silently accepted quantity mismatch.
- Story 3.7 remains the packing and dispatch contract. Cross-dock fulfillment must feed it rather than fork it.

### Project Structure Notes

New files expected:

- `read/projections/cross_dock_task.sql`
- `src/read/projections/cross_dock_task.ts`
- `src/compliance/cross-dock.ts`
- `src/api/v1/cross-dock.ts`
- `test/integration/story-3-10.test.ts`
- `test/unit/cross-dock.test.ts`
- `edge/src/capture/cross-dock.ts`
- `edge/test/unit/cross-dock-events.test.ts`

Files expected to be updated:

- `read/projections/grn_line.sql`
- `read/projections/pick_task.sql`
- `read/projections/pick_line.sql`
- `read/projections/task_sla_config.sql`
- `src/read/projections/grn_line.ts`
- `src/read/projections/erp_sales_order.ts`
- `src/read/projections/pick_task.ts`
- `src/read/projections/pick_line.ts`
- `src/compliance/receiving.ts`
- `src/compliance/pick.ts`
- `src/compliance/warehouse-task.ts`
- `src/read/projections/stock_balance.ts`
- `src/warehouse/pick-task-generator.ts`
- `src/warehouse/task-metrics.ts`
- `src/api/v1/receiving.ts`
- `src/api/v1/warehouse-tasks.ts`
- `src/api/v1/edge.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `edge/src/components/app-shell.tsx` only if Task 8 adds an operator-visible capture surface
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/unit/task-metrics.test.ts`
- `test/unit/sync-upload.test.ts`
- `edge/test/unit/connector.test.ts`
- `test/integration/story-1-9.test.ts`

Do not create a new dependency, service, scheduler, standalone task board, ERP mutation path, dispatch path, cancellation workflow, order-splitting engine, or full offline task-discovery UI.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md:1203-1496`] Epic 3 context, adjacent stories, Story 3.10 statement, dependency, and source acceptance criteria.
- [Source: `PLANNING/archive/SCM-Requirements-Document.md:110-120`] FR-W-01 through FR-W-09, including flow-through and distribution cross-docking.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:20-205`] Local-first architecture, compliance, location, idempotency, conventions, and stack.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:278-349`] Event envelope, API contract, and spine acceptance contract.
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md:20-38`] Rugged tablet, scan-first, glove, and one-handed requirements.
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md:149-206`] Explicit feedback and scan-transition-confirm interaction.
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md:314-361`] Canonical online, pending, syncing, and error states.
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/DESIGN.md:354-442`] Accessible badges, tablet cards, focus, semantics, and reduced motion.
- [Source: `_bmad-output/implementation-artifacts/3-9-forward-pick-replenishment-fr-w-08.md:76-191`] Nearest task-projection precedent and architecture guardrails.
- [Source: `_bmad-output/implementation-artifacts/3-9-forward-pick-replenishment-fr-w-08.md:290-299`] Story 3.9 unresolved review findings that must not be copied.
- [Source: `src/compliance/receiving.ts:139-449`] Existing receiving validation, stock posting, GRN persistence, and unconditional putaway boundary.
- [Source: `src/api/v1/receiving.ts:91-166`] Existing transactional receiving API and response contract.
- [Source: `src/read/projections/erp_sales_order.ts:4-178`] Read-only ERP sales-order contract and exact quantity convention.
- [Source: `src/read/projections/stock_balance.ts:16-93`] Lot-number namespace and current quantity input signatures for stock helpers.
- [Source: `src/read/projections/stock_balance.ts:159-358`] Stock receipt, allocation, issue, and allocated-to-picked helper behavior.
- [Source: `src/warehouse/pick-task-generator.ts:310-357`] Sales-order lock and duplicate pick-work guard.
- [Source: `src/compliance/pick.ts:203-260`] Pick creation and allocation.
- [Source: `src/compliance/pick.ts:262-449`] Locked confirmation, exact quantity, replay, and allocated-to-picked transition.
- [Source: `src/compliance/pick.ts:467-500`] Existing dispatch picked-status logic to harden for exact fulfillment.
- [Source: `src/compliance/dispatch.ts:72-126`] Packing depends on picked status and confirmed pick quantities.
- [Source: `src/warehouse/task-metrics.ts:153-367`] Data-driven task-board extension and site-scoped SLA handling.
- [Source: `src/warehouse/task-metrics.ts:424-508`] Honest productivity population and SQL duration rules.
- [Source: `src/compliance/warehouse-task.ts:39-124`] Authoritative warehouse-task type validation used by SLA configuration.
- [Source: `src/events/store.ts:320-546`] Fixed assertion and apply ordering, transaction, event, location, and audit seam.
- [Source: `package.json:6-48`] Backend runtime, scripts, and installed dependencies.
- [Source: `edge/src/capture/test-capture.ts:1-108`] Existing generic outbox capture-builder precedent.
- [Source: `edge/src/components/app-shell.tsx:70-91`] Existing first-sync and sync-error shell states.
- [Source: `edge/package.json:6-35`] Edge framework, scripts, and installed dependency versions.
- [PostgreSQL 18 numeric documentation](https://www.postgresql.org/docs/current/datatype-numeric.html)
- [PostgreSQL 18 explicit locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Next.js 16 PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps)
- [PowerSync JavaScript Web SDK guide](https://docs.powersync.com/client-sdk-references/javascript-web)

### Non-Blocking Product Questions and Binding Defaults

1. Should later releases split one receipt across several orders? Default for this story: no; one receipt line binds to one order line with enough remaining demand.
2. Should a site configure a default outbound staging zone? Default for this story: no; an explicit active same-site staging zone is required when `cross_dock: true`.
3. Should receiver and staging confirmer be different people? Default for this story: no additional separation beyond role, assignment, site, and audit controls; do not invent a receiver-cannot-confirm rule.
4. Should a cross-dock task support cancellation or reversal? Default for this story: no; cancellation requires a complete allocation-release and ordinary-putaway rerouting workflow and remains future work.
5. Should full task discovery work offline? Default for this story: no; edge upload parity for a known task is included, while local task replication and a complete task-list PWA require a separate story.
6. What is the true dock-to-dispatch KPI boundary? Default for this story: record receipt-confirmation to staging-confirmation as cross-dock task duration and preserve Story 3.7 dispatch timestamps for a future end-to-end KPI.
7. Must Story 3.10 ship a dedicated edge screen, or is a reusable known-task capture builder sufficient? Default for this story: AC8 requires a usable operator-visible capture path, but it may be integrated minimally into the existing shell without task discovery, replication, or a new list screen.

## Dev Agent Record

### Agent Model Used

fugu-ultra

### Debug Log References

- 2026-07-31 Task 1 and Task 2 red phase: focused contract suite failed 3 tests before implementation because the cross-dock module, table, and additive schema contracts were absent.
- 2026-07-31 Task 1 and Task 2 green phase: focused tests passed 51/51; backend regression passed 520/520; `npm run build`, `npm run lint`, two `npm run db:migrate` runs, and `git diff --check` passed.
- 2026-07-31 Repository-wide `npm run format:check` remains blocked by 164 pre-existing formatting failures outside the Task 1 and Task 2 change set.
- 2026-07-31 Tasks 3 through 5 red phase: tests demonstrated missing exact-demand exports, absent qualifying task creation, and an inactive assigned operator being allowed to complete.
- 2026-07-31 Tasks 3 through 5 green phase: targeted integration and unit tests passed 19/19; full backend regression passed 533/533; build, lint, two migrations, and `git diff --check` passed.
- 2026-07-31 Tasks 6 through 8 red phase: tests failed for missing `cross_docking` metrics and routes, missing edge capture and generic outbox builders, and the absent duration label.
- 2026-07-31 Tasks 6 through 8 green phase: targeted backend tests passed 14/14, full backend passed 538/538, edge unit tests passed 26/26, edge end-to-end tests passed 6/6, and accessibility tests passed 5/5. Backend build/lint, edge typecheck/lint/build, `git diff --check`, and graph update passed.
- 2026-07-31 Repository-wide `npm run format:check` reports 169 pre-existing formatting failures; changed Story 3.10 files are validated separately before completion.
- 2026-08-01 Task 10 verification gate: targeted Story 3.10 tests 69/69; backend `npm run build` exit 0; backend `npm run lint` exit 0; backend `npm run format:check` exit 0; backend `npm test` 538/538 pass; backend `npm run spine-acceptance-contract` 6/6 pass; edge `npm run edge:typecheck` exit 0; edge `npm run edge:lint` exit 0; edge `npm run edge:test` 26/26 pass; edge `npm run edge:build` exit 0; edge `npm run edge:test:e2e` 6/6 pass; edge `npm run edge:accessibility` 5/5 pass; `node --env-file=.env.test --import tsx src/events/migrate.ts` exit 0 on first and second run (idempotent); `git diff --check` exit 0; `git status --short` showed no unintended files after resetting `package.json`.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Implemented the additive cross-dock schema, dependency-safe deferred pick-line foreign key, exact-string projection accessor, immutable GRN replay protection, task SLA vocabulary, event payload registry, deterministic projection identifiers, pre-idempotency shape validation, and bounded error vocabulary.
- Mirrored schema changes into the Compose initializer and strengthened schema-drift coverage without changing the PowerSync publication.
- Implemented exact, locked demand matching shared with normal pick generation, safe receiving fallback, event-sourced assignment, atomic staging movement, deterministic synthetic pick fulfillment, exact dispatch readiness, location provenance, and location-scoped dispatch stock decrement.
- Added cross-docking to the unified task board and honest productivity metrics, dedicated event-sourced REST and edge intake, permanent failure classification and localization, and a minimal accessible known-task capture flow using the existing generic outbox and shell.
- Completed exhaustive regression, concurrency, authorization, destination, downstream dispatch, atomicity, edge sync, schema/route, and task-metric coverage. All acceptance criteria pass and all verification gates are green.

### Review Findings (code review 2026-08-01)

- [x] [Review][Decision] Identical replay returns 200 instead of 409 DUPLICATE_EVENT — `persistEvent` now returns existing event on duplicate match. Applied to both pre-INSERT short-circuit and post-INSERT unique constraint paths. `src/events/store.ts:490-503`, `src/events/store.ts:761-771`.

- [x] [Review][Patch] Edge generates non-deterministic pick_task_id/pick_line_id — `edge/src/capture/cross-dock.ts:26-27`. Server now overrides in `src/api/v1/edge.ts:252-253` before `persistEvent`.

- [x] [Review][Patch] Edge confirmCrossDock silently returns task ID when DB/auth state unavailable — `edge/src/components/edge-client.tsx:204`. Now throws descriptive error; `cross-dock-capture.tsx:57-61` wraps in try/catch and shows error message.

### File List

- `_bmad-output/implementation-artifacts/3-10-cross-docking-execution-fr-w-09.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `deploy/compose/init-db.sql`
- `edge/app/globals.css`
- `edge/next.config.ts`
- `edge/src/capture/cross-dock.ts`
- `edge/src/capture/outbox-event.ts`
- `edge/src/components/app-shell.tsx`
- `edge/src/components/cross-dock-capture.tsx`
- `edge/src/components/edge-client.tsx`
- `edge/src/components/sync-failure-list.tsx`
- `edge/src/messages/en.json`
- `edge/src/sync/connector.ts`
- `edge/test/accessibility/shell-accessibility.spec.ts`
- `edge/test/e2e/offline-shell.spec.ts`
- `edge/test/unit/cross-dock-events.test.ts`
- `edge/test/unit/i18n-literals.test.ts`
- `read/projections/cross_dock_constraints.sql`
- `read/projections/cross_dock_task.sql`
- `read/projections/grn_line.sql`
- `read/projections/pick_line.sql`
- `read/projections/pick_task.sql`
- `read/projections/task_sla_config.sql`
- `src/api/v1/cross-dock.ts`
- `src/api/v1/edge.ts`
- `src/api/v1/receiving.ts`
- `src/api/v1/warehouse-tasks.ts`
- `src/compliance/cross-dock.ts`
- `src/compliance/dispatch.ts`
- `src/compliance/receiving.ts`
- `src/compliance/stock-balance.ts`
- `src/compliance/warehouse-task.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/read/projections/cross_dock_task.ts`
- `src/read/projections/erp_sales_order.ts`
- `src/read/projections/grn_line.ts`
- `src/read/projections/pick_line.ts`
- `src/read/projections/pick_task.ts`
- `src/read/projections/stock_balance.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `src/warehouse/pick-task-generator.ts`
- `src/warehouse/task-metrics.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-2-9.test.ts`
- `test/integration/story-3-10-dispatch.test.ts`
- `test/integration/story-3-10-edges.test.ts`
- `test/integration/story-3-10.test.ts`
- `test/unit/cross-dock.test.ts`
- `test/unit/schema-drift.test.ts`
- `test/unit/story-3-10-tasks-6-8.test.ts`
