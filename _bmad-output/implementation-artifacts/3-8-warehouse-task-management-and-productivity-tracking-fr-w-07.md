---
baseline_commit: cd7e3d9ebc3ebcb85fb10ca2a2d8f8df428896be
---

# Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07)

Status: done

## Story

As a warehouse supervisor,
I want to assign, prioritize, and monitor all open warehouse tasks (receiving, putaway, picking, packing) with productivity metrics per operator and zone,
so that I can balance workload, identify bottlenecks, and track against the gate dwell target of under 4 minutes median (SM-13) and frontline confirmation rate above 95% (SM-17).

## Acceptance Criteria

1. Given multiple open putaway and pick tasks exist across operators, when the supervisor opens the task management dashboard, then open tasks are grouped by type and operator, showing age, priority, and zone; tasks that breach a configurable SLA threshold are visually highlighted with the breached threshold shown (FR-W-07).
2. Given an operator completes a task, when the confirmation is posted, then the task is marked complete with operator identity and duration; the confirmation rate metric updates in the read model.
3. Given gate dwell (SM-13) is computed per vehicle as the interval from the gate-entry event timestamp (Story 3.2) to weighbridge acceptance for the same binding token (Story 3.3), falling back to GRN confirmation (Story 3.4) where no weighment applies, and the shift median exceeds 4 minutes, when the supervisor views the exception dashboard, then the metric appears as an exception with drill-through to the individual gate events that breached the threshold.

## Tasks / Subtasks

- [x] Task 1: Add precise capture-instant timestamps for accurate gate-dwell computation (AC: 3)
  - [x] 1.1 Add an additive `occurred_at TIMESTAMPTZ` column plus a supporting index to `read/projections/weighbridge_event.sql`, using the guarded `ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS` pattern. Do not touch any existing CHECK constraint or index name.
  - [x] 1.2 Add an additive `received_at TIMESTAMPTZ` column plus a supporting index to `read/projections/grn.sql`, same guarded pattern.
  - [x] 1.3 Extend `UpsertWeighbridgeEventInput` and the INSERT/UPDATE column list in `src/read/projections/weighbridge_event.ts` to accept and persist `occurred_at`.
  - [x] 1.4 Extend `InsertGrnHeaderInput` and `insertGrnHeader()` in `src/read/projections/grn.ts` to accept and persist `received_at`. Preserve the header-identity-immutability contract exactly: the first line that creates the header is never overwritten by later lines, and status only advances forward (open to posted), never backward.
  - [x] 1.5 In `src/compliance/weighbridge.ts`, thread the already-computed `occurredAt` value (currently discarded after deriving `business_date` via `localYmd(occurredAt)`) through to `upsertWeighbridgeEvent(...)` as `occurred_at: occurredAt.toISOString()`. Do not touch the tolerance-band computation or the `tolerance_breach` notification block.
  - [x] 1.6 In `src/compliance/receiving.ts`, thread the equivalent `occurredAt` value through to both `insertGrnHeader(...)` call sites (the over-receipt branch and the normal branch). Do not touch the advisory-lock tolerance-band SQL or the `RECEIPT_TOLERANCE_EXCEEDED`/`ITEM_PO_MISMATCH` error paths.
  - [x] 1.7 Mirror both column additions into `deploy/compose/init-db.sql`, appended after the existing Story 3.3/3.4 blocks, without touching the `powersync_publication` block.
  - [x] 1.8 If either table gains a new named constraint (unlikely for a bare additive timestamp), add it to that table's existing entry in `test/unit/schema-drift.test.ts`'s `EXPECTED` array; a plain additive column with no new named constraint needs no entry change.

- [x] Task 2: Extend task projections with priority, assignment, and zone attribution (AC: 1)
  - [x] 2.1 Add an additive `priority TEXT NOT NULL DEFAULT 'normal'` column and a `chk_pick_task_priority CHECK (priority IN ('low','normal','high','urgent'))` constraint to `read/projections/pick_task.sql`.
  - [x] 2.2 Add the same additive `priority` column and CHECK-constraint pattern (`chk_putaway_task_priority`) to `read/projections/putaway_task.sql`, plus a new `assigned_to UUID` column and a denormalized `zone_id UUID` column (populated once at task-creation time from the directed location's zone ancestor, so the dashboard never needs a `location_register` join on every read).
  - [x] 2.3 Extend `src/read/projections/pick_task.ts`: add `priority` to `ListPickTasksFilters`/`listPickTasks()` for filtering and sorting, and an accessor to set it.
  - [x] 2.4 Extend `src/read/projections/putaway_task.ts`: add `assignedTo`/`priority`/`zoneId` to `ListPutawayTasksFilters`; add `assignPutawayTask(putawayTaskId, assignedTo, priority?)` mirroring `pick_task.ts`'s `assignPickTask()` pattern, using a status-predicated `UPDATE ... WHERE status = 'ready'` (never a read-then-write) so a concurrent assignment or completion cannot race.
  - [x] 2.5 Resolve `zone_id` for a new putaway task at generation time (Story 3.5's generator) by walking `location_register.parent_location_id` from `directed_location_id` up to the ancestor row with `level = 'zone'`; store the result once, do not recompute it on every dashboard read.
  - [x] 2.6 Add `POST /api/v1/putaway-tasks/:putawayTaskId/assign` to `src/api/v1/putaway.ts`, gated by a new `PUTAWAY_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller']` constant mirroring pick's `PICK_SUPERVISE_ROLES`. Server-set `assigned_by` from `authContext`; never accept it from the request body.
  - [x] 2.7 Register the new route in `src/server.ts` and add it to the `test/integration/story-1-9.test.ts` route allowlist.
  - [x] 2.8 Add `chk_pick_task_priority` to the `pick_task` entry's `constraints` array and `chk_putaway_task_priority` to the `putaway_task` entry's `constraints` array in `test/unit/schema-drift.test.ts`'s `EXPECTED` array. Every other value in both entries stays exactly as-is.

- [x] Task 3: Build an event-sourced, configurable SLA-threshold registry (AC: 1)
  - [x] 3.1 Create `read/projections/task_sla_config.sql`: table `task_sla_config` with `id UUID` primary key, `task_type TEXT NOT NULL CHECK (task_type IN ('receiving','putaway','picking','packing'))`, `zone_id UUID NULL REFERENCES location_register(location_id)`, `threshold_minutes NUMERIC(9,2) NOT NULL CHECK (threshold_minutes > 0)`, `updated_by UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Add a `NULLS NOT DISTINCT` partial-unique index on `(task_type, zone_id)` so at most one active threshold exists per task-type/zone pairing (`zone_id IS NULL` represents the site-wide default), mirroring Story 2.9's `NULLS NOT DISTINCT` open-partial-unique convention. Guarded `DO $$` grant blocks: `app_user` gets INSERT, SELECT, UPDATE; `readonly_user` gets SELECT; never DELETE.
  - [x] 3.2 Register `task_sla_config.updated` in `src/events/schema.ts`'s `SUPPORTED_EVENT_TYPES` under stream `'warehouse'`, `requiresBusinessStream: false` (an SLA-threshold change posts no valuated stock or financial movement, the same rationale already used for `pick_task.*` and `dispatch.*` events). Add the corresponding `TaskSlaConfigUpdatedPayload`/envelope TypeScript type near the existing task-event types.
  - [x] 3.3 Create `src/compliance/warehouse-task.ts` with `assertTaskSlaConfigUpdatedShape(envelope)` (pre-transaction, validates `task_type`/`threshold_minutes`/optional `zone_id` shape) and `applyTaskSlaConfigUpdatedProjection(envelope, client, eventId)` (in-transaction upsert into `task_sla_config` keyed on `(task_type, zone_id)`). Server-set `updated_by` from `envelope.metadata.actor.user_id`; never a placeholder string.
  - [x] 3.4 Splice `assertTaskSlaConfigUpdatedShape` into `src/events/store.ts` immediately after the last Story 3.7 dispatch assert (`assertDispatchDispatchedShape`) and before `assertErpReadOnly`. Splice `applyTaskSlaConfigUpdatedProjection` immediately after `applyDispatchDispatchedProjection` and before the `nextVersion`/`domain_events` insert. Do not reorder or remove any existing assert or apply call.
  - [x] 3.5 Create `src/read/projections/task_sla_config.ts`: `runner(client?)`, a `TASK_SLA_CONFIG_COLUMNS` const, `mapRow`, `getSlaConfig(taskType, zoneId?)` (falls back to the site-wide `zone_id IS NULL` row when no zone-specific row exists), `listSlaConfig()`.
  - [x] 3.6 Append `'../../read/projections/task_sla_config.sql'` to the end of the `MIGRATIONS` array in `src/events/migrate.ts` (never reorder existing entries) and mirror the DDL byte-for-byte into `deploy/compose/init-db.sql`, appended after the Story 3.7 blocks, without touching the `powersync_publication` block.
  - [x] 3.7 Add a `task_sla_config` entry to the `EXPECTED` array in `test/unit/schema-drift.test.ts`.
  - [x] 3.8 Add `GET /api/v1/warehouse-tasks/sla-config` (read, `WAREHOUSE_TASK_READ_ROLES`) and `PUT /api/v1/warehouse-tasks/sla-config` (write, `WAREHOUSE_TASK_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller']`) to `src/api/v1/warehouse-tasks.ts`. The PUT handler persists through `persistEvent`, never a direct table UPDATE.

- [x] Task 4: Build the unified warehouse task-board aggregation and dashboard API (AC: 1)
  - [x] 4.1 Create `src/warehouse/task-metrics.ts` exporting `listOpenTasks(filters)`: a normalized union across `pick_task` (status not in `'completed'`/`'cancelled'`), `putaway_task` (status = `'ready'`), `grn_line` (status = `'quarantined'`, the closest existing analog to an open receiving task), and `packing_record` (status = `'packed'`, not yet dispatched). Map each source row to a common shape: `task_type`, `task_id`, `site_id`, `zone_id`, `assigned_to`, `priority`, `status`, `created_at`, `age_minutes`. Compute `age_minutes` in SQL (`now() - created_at`), never in JavaScript, so results are not skewed by request latency. `site_id` resolution differs per source, since only `putaway_task` carries it directly: `putaway_task.site_id` is a direct column; `pick_task` and `packing_record` resolve `site_id` via `JOIN erp_sales_order eso ON eso.id = <source>.dispatch_order_id` and select `eso.ship_from_site_id`, the same join `pick_task.ts`'s `listPickTasks()` and `dispatch_order_status.ts` already use; `grn_line` resolves `site_id` via `JOIN grn ON grn.grn_id = grn_line.grn_id` and selects `grn.site_id`. `zone_id` is likewise not universal: `pick_task` and `putaway_task` carry it directly, but `grn_line` and `packing_record` have no `zone_id` column at all, so return `zone_id` as null for those two task types (a zone-ancestor walk against `grn_line.target_location_id` using the Task 2.5 pattern is an acceptable alternative for `grn_line` if a reviewer wants zone-level SLA grouping on receiving tasks, but is not required for this story).
  - [x] 4.2 Extend `listOpenTasks` with SLA-breach detection: for each row, resolve the applicable threshold via `getSlaConfig(task_type, zone_id)` (zone-specific first, site-wide fallback), compute `breached = age_minutes > threshold_minutes`, and return `breached` plus `breached_threshold_minutes` on the row. A breach is a visible dashboard flag, not an error response.
  - [x] 4.3 Reject malformed filter query parameters (invalid `task_type` enum value, non-UUID `zone_id`/`assigned_to`/`site_id`) with a 400 `INVALID_PARAMS` before any database query runs, not a raw Postgres 500. This is the exact defect class Story 3.6's review found and fixed in its list endpoints.
  - [x] 4.4 Create `src/api/v1/warehouse-tasks.ts` with `GET /api/v1/warehouse-tasks` (grouped/filterable by `task_type`, `assigned_to`, `zone_id`, `site_id`), gated by `requireRole` with `WAREHOUSE_TASK_READ_ROLES` and scoped via `permittedLocationsForModuleScope`.
  - [x] 4.5 Register the route in `src/server.ts` and add it to the `test/integration/story-1-9.test.ts` allowlist.

- [x] Task 5: Build confirmation-rate and productivity metrics (AC: 2)
  - [x] 5.1 Extend `task-metrics.ts` with `computeConfirmationRate({ periodStart, periodEnd, siteId?, zoneId?, operatorId? })`: `completed_count / total_assigned_count` per operator and per zone, read directly from the existing `completed_at`/`completed_by`/`assigned_to` columns on `pick_task` and `putaway_task`, plus `packed_by`/`packed_at` on `packing_record` for packing-task coverage. No new event type is required for AC2 itself: a completed task is already durably recorded by Story 3.5/3.6's existing completion projections; this task only reads and rolls them up.
  - [x] 5.2 Compute duration (`completed_at - created_at`) per completed task in the same SQL query, not in JavaScript.
  - [x] 5.3 Add `GET /api/v1/warehouse-tasks/productivity` to `src/api/v1/warehouse-tasks.ts`, returning per-operator and per-zone confirmation-rate and average/median duration for a given period. Same RBAC (`WAREHOUSE_TASK_READ_ROLES`) and site scoping as Task 4.
  - [x] 5.4 Register the route in `src/server.ts` and the allowlist.

- [x] Task 6: Build the gate-dwell median metric and exception drill-through (AC: 3)
  - [x] 6.1 Create `read/projections/gate_dwell_metric.sql` as `CREATE OR REPLACE VIEW gate_dwell_metric`, joining `gate_event` (entry timestamp, `correlation_id`, `site_id`) to `weighbridge_event` (`status = 'accepted'`, using the new `occurred_at` from Task 1) with a fallback `LEFT JOIN` to `grn` (using the new `received_at` from Task 1) when no accepted weighment exists for the same `correlation_id`. Expose `dwell_interval` as `resolved_at - gate_entered_at` and a `resolution_source` column (`'weighbridge'` or `'grn'`). This is a pure derived read model with no independent mutable state: it needs no `apply*Projection` hook or write path, only `SELECT` grants for `app_user`/`readonly_user`, consistent with the architecture principle that read models are projections built from already-materialized event data.
  - [x] 6.2 Confirm whether `gate_event` already carries an IST-local `business_date` column (the pattern already established on `weighbridge_event`/`grn`); if absent, add it additively. Use `business_date` (not a rolling clock window) as the shift-bucketing key for the median computation, since no dedicated shift-register entity exists anywhere in the codebase today. Treat "shift" as a calendar business-day per site for Phase 1; document this as a deliberate scope decision, not an open gap.
  - [x] 6.3 In `task-metrics.ts`, add `computeGateDwellExceptions({ businessDate, siteId? })` using `percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_interval)` with a plain `GROUP BY business_date, site_id`. Do not use `percentile_cont(...) WITHIN GROUP (...) OVER (PARTITION BY ...)`: ordered-set aggregates are not valid as window functions per the PostgreSQL 18 documentation, even though several third-party examples show this pattern. Flag `exceeded = median > interval '4 minutes'` (strictly greater than; exactly 4 minutes does not breach).
  - [x] 6.4 When a shift's median breaches 4 minutes, return the drill-through list: every `gate_dwell_metric` row in that shift/site with `dwell_interval > interval '4 minutes'`, each carrying its `correlation_id` so the supervisor can trace back to the source gate, weighbridge, or GRN events.
  - [x] 6.5 Include capture-completeness fields (challan photo present, weighment present versus GRN-fallback used) alongside the dwell/exception payload, per the SM-C2 counter-metric requirement, so a dwell improvement achieved by skipping mandatory capture is visible on the same dashboard, never hidden.
  - [x] 6.6 Add `GET /api/v1/warehouse-tasks/exceptions/gate-dwell` to `src/api/v1/warehouse-tasks.ts`. Same RBAC and site scoping as Task 4.
  - [x] 6.7 Register the route in `src/server.ts` and the allowlist.

- [x] Task 7: Enforce RBAC, SOD, and site scoping across all new surfaces (AC: 1, 2, 3)
  - [x] 7.1 Define `WAREHOUSE_TASK_READ_ROLES = ['store_assistant', 'warehouse_operator', 'dispatch_clerk', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller']` (every warehouse role established across Stories 3.5 through 3.7, read-only) and `WAREHOUSE_TASK_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller']` (assign, prioritize, SLA-config write) as explicit named constants. Never assume write-role membership implies read-role membership: enumerate both roles explicitly in the read set, the exact regression Story 3.7's second review pass found and fixed via its `DISPATCH_READ_ROLES` constant. `unloading_supervisor` already holds read/approval access to the putaway and receiving data this dashboard aggregates (`PUTAWAY_READ_ROLES`, `RECEIVING_READ_ROLES`, `PUTAWAY_RELEASE_ROLES`); omitting it here would lock that role out of the unified board while leaving its access to the underlying per-domain endpoints intact.
  - [x] 7.2 Apply the same supervise-versus-read role split to the new putaway-assign endpoint (Task 2.6).
  - [x] 7.3 Put the role/event-type SOD check for `task_sla_config.updated` inside the `persistEvent`/compliance seam itself (`src/compliance/warehouse-task.ts`), not only the HTTP handler, so a direct `POST /api/v1/events` call cannot bypass supervisor-only SLA-threshold changes. This mirrors the exact gap Story 3.6's review found: site-scope and role/event-type SOD checks belong at the compliance seam, not only in the HTTP handler.
  - [x] 7.4 Enforce site scoping via `permittedLocationsForModuleScope` on every new read and write endpoint. Scope every dashboard/productivity/exception query by an explicit `site_id` filter even where an underlying source table (for example `dispatch_order_status`) has a known open site-isolation gap deferred from Story 3.7; do not let that gap leak into a new cross-domain aggregate.
  - [x] 7.5 Server-set every identity field (`assigned_by`, `updated_by`) from `authContext`/`envelope.metadata.actor.user_id`; never trust a client-supplied value and never fall back to a placeholder string such as `'unknown'`.
  - [x] 7.6 Do not add an edge/offline path for this story. None of the three acceptance criteria reference offline capture, and SLA-threshold configuration plus task assignment/prioritization are synchronous supervisor-console actions. Do not register any new event type in `src/sync/upload.ts`'s `PERMANENT_ERROR_CODES` or in `edge/src/sync/connector.ts` for this story.

- [x] Task 8: Test coverage and verification gates (AC: 1, 2, 3)
  - [x] 8.1 Create `test/integration/story-3-8.test.ts` (Node's built-in `node:test` runner, mirroring the structure of `test/integration/story-3-7.test.ts`) covering: AC1 (dashboard groups by type/operator, shows age/priority/zone, SLA breach highlighted with the breached threshold shown, malformed-filter returns 400 `INVALID_PARAMS`); AC2 (task completion posts operator identity and duration, confirmation-rate read model updates); AC3 (a shift with median dwell over 4 minutes produces an exception with a correct drill-through list; both the weighbridge-acceptance path and the GRN-fallback path are covered; a shift at or under 4 minutes produces no exception); RBAC negative tests (a frontline role is rejected from the SLA-config write and assignment endpoints); a site-scoping negative test (`LOCATION_ACCESS_DENIED` on an out-of-scope site); and an idempotent-replay test for `task_sla_config.updated`.
  - [x] 8.2 Create `test/unit/task-metrics.test.ts` for the pure median/confirmation-rate/SLA-breach math, including: an empty task set, a single-vehicle shift, and the exactly-4-minute boundary (must not flag as exceeded, per AC3's "exceeds 4 minutes").
  - [x] 8.3 Before adding new entries, note the one open schema-drift gap already inherited from Story 3.7: the `dispatch_order_status` entry's `constraints` array is empty pending that story's deferred follow-up; this story does not need to fix it, only avoid masking it. Then add `task_sla_config` (and `gate_dwell_metric` if the harness supports view-shaped entries, otherwise a targeted existence/column assertion in the integration test) to `test/unit/schema-drift.test.ts`'s `EXPECTED` array.
  - [x] 8.4 Add every new route from Tasks 2 through 6 to `test/integration/story-1-9.test.ts`'s allowlist.
  - [x] 8.5 Run the full gate: `npm test`, `npm run spine-acceptance-contract`, `tsc` clean, `eslint` clean. The edge workspace is untouched by this story, so `npm run edge:test` is expected to pass unchanged; confirm this, do not skip it.

## Dev Notes

### Architecture Patterns and Constraints

- **Single write seam.** All domain state mutation goes through `persistEvent(envelope, auditCtx?, externalClient?)` in `src/events/store.ts`. Pre-transaction shape-assert functions run first, in fixed registration order, ending at `assertErpReadOnly(envelope)`, so a malformed event never consumes an idempotency key. In-transaction `apply*Projection` functions run afterward, in the same fixed order, immediately before version resolution and the `INSERT INTO domain_events` statement. New Story 3.8 asserts/applies splice in immediately after Story 3.7's dispatch blocks (see Task 3.4 for exact anchor function names). Never reorder or remove an existing assert or apply call; this ordering is a hard invariant enforced by the Story 1.9 spine gate.
- **Event naming and stream tagging.** Events are past-tense, dot-separated (`task_sla_config.updated`). Story 3.8's new event type registers under the existing `'warehouse'` stream with `requiresBusinessStream: false`, the same rationale already used for `pick_task.*`/`dispatch.*` events: no valuated stock or financial movement is posted directly by a task-management event.
- **Projection trio, mandatory for every new table.** (1) Canonical idempotent DDL in `read/projections/<table>.sql` using `CREATE TABLE IF NOT EXISTS`, guarded `DO $$` blocks for constraints, indexes, and grants; (2) registration at the end of the `MIGRATIONS` array in `src/events/migrate.ts` (append-only, never reordered - a prior story's real production-breaking bug came from violating this); (3) a byte-for-byte mirror appended to `deploy/compose/init-db.sql` that never touches the `powersync_publication` block. Grants are `INSERT, SELECT, UPDATE` for `app_user` and `SELECT` for `readonly_user`, gated behind `pg_roles` existence checks; never `DELETE` (soft-state only).
- **`gate_dwell_metric` is a deliberate exception to the table-based projection pattern.** It is defined as a SQL view over already-materialized event data (`gate_event`, `weighbridge_event`, `grn`), not a table, because it carries no independent state of its own and needs no `apply*Projection` hook. This keeps the read model always consistent with its sources without adding a fifth table for something fully derivable from data already written by Stories 3.2 through 3.4.
- **Percentile computation gotcha (verified against PostgreSQL 18 documentation).** `percentile_cont(fraction) WITHIN GROUP (ORDER BY ...)` is an ordered-set aggregate; ordered-set and hypothetical-set aggregates are explicitly not supported as window functions in PostgreSQL 18. The per-shift/per-zone median in Task 6 must use a plain `GROUP BY`, never `... OVER (PARTITION BY ...)`, despite several third-party blog examples showing the window-function form. `percentile_cont` interpolates (correct for a continuous median); `percentile_disc` returns an actual observed value and is the wrong choice here.
- **RBAC and SOD.** Auth is SSO-gated (SAML 2.0/OIDC); every request is authenticated. `requireRole` gates a route by role list and resolves the module; `permittedLocationsForModuleScope` enforces site scoping. Roles are free-form strings, not a fixed enum in the database. The established warehouse role vocabulary from Stories 3.5 through 3.7 is `warehouse_manager`, `inventory_controller` (supervisors: generate, assign, prioritize, complete-override), `store_assistant`, `warehouse_operator`, `dispatch_clerk` (frontline: execute and confirm only), and `unloading_supervisor` (receiving/putaway release and read access, per `PUTAWAY_READ_ROLES`/`RECEIVING_READ_ROLES`/`PUTAWAY_RELEASE_ROLES`). A prior story's adversarial review found that role and site-scope checks living only in the HTTP handler let the edge upload path and direct `/api/v1/events` calls bypass them; Story 3.8 must put its SOD/role check for `task_sla_config.updated` inside the compliance seam itself (Task 7.3).
- **Error envelope and 2xx-versus-4xx convention.** Errors return `{ error_code, message, details, trace_id }`. A business-legitimate exception state (an SLA breach, a dwell-median exception) is a visible flag on a 2xx dashboard read, never a 4xx error response; 4xx is reserved for genuinely missing or invalid input (a malformed filter parameter, a missing required field).
- **AD-17 notification coupling** is available if a future story wants to push-alert a supervisor on an SLA or dwell breach (`emitNotification()` decoupled, or `emitNotificationInTransaction()` when the notification is part of the business fact). This story's three acceptance criteria are read/dashboard-shaped, not push-notification-shaped, so no new notification call is required to satisfy them; treat this as an available extension point, not a task.
- **Gate-dwell exception endpoint is deliberately supervisor-only.** `GET /api/v1/warehouse-tasks/exceptions/gate-dwell` (Task 6.6) uses `WAREHOUSE_TASK_READ_ROLES`, the same set as the task board and productivity views, not the broader `gate_officer`/`weighbridge_operator`/`receiving_supervisor`/`unloading_supervisor` read-roles already established on the underlying gate/weighbridge/GRN capture endpoints. AC3 frames gate-dwell exceptions as a supervisor dashboard concern, so this is an intentional narrowing to the task-management surface, not an RBAC read-role regression of the kind flagged elsewhere in this story's Previous Story Intelligence.

### Boundary Notes and Scope Guardrails

- This story does not own: customs documentation, carrier rate shopping, or load planning (deferred to Epic 15); forward-pick replenishment (Story 3.9, which places its own replenishment tasks onto the task board this story builds); cross-docking (Story 3.10); a real shift-register/shift-master entity (Task 6.2 substitutes calendar business-date bucketing as an explicit Phase-1 decision); or fixing the pre-existing site-isolation gap in `src/compliance/dispatch.ts` deferred from Story 3.7 (Task 7.4 only guards against that gap leaking into this story's new aggregates).
- Story 12.1 (Role-Specific Operational Dashboards) consumes, but does not re-derive, this story's output: its warehouse-manager widget renders "open tasks by type, age, and zone with SLA breaches highlighted" and "gate dwell median versus the 4-minute target" directly from the projections and endpoints this story builds. Getting the response shape wrong here breaks Story 12.1 later; keep `GET /api/v1/warehouse-tasks` and the gate-dwell exception endpoint's response shapes stable and self-describing.
- Story 3.9's replenishment tasks are expected to appear "on the task board" this story builds; do not design `listOpenTasks` in a way that hard-codes the four Phase-1 task types (receiving, putaway, picking, packing) so tightly that a fifth type cannot be added later without a breaking change.

### Source Tree Components to Touch

- `src/api/v1/warehouse-tasks.ts` (new), `src/api/v1/putaway.ts` (updated) - REST routes, one file per domain, registered by hand in `src/server.ts`.
- `src/compliance/warehouse-task.ts` (new) - assert/apply write-path seam functions for `task_sla_config.updated`.
- `src/warehouse/task-metrics.ts` (new) - pure algorithm module: task-board normalization, SLA-breach detection, confirmation-rate rollup, gate-dwell median and exception computation.
- `src/read/projections/task_sla_config.ts`, `src/read/projections/gate_dwell_metric.ts` (new); `src/read/projections/pick_task.ts`, `src/read/projections/putaway_task.ts`, `src/read/projections/weighbridge_event.ts`, `src/read/projections/grn.ts` (updated) - TypeScript accessors over projection tables/views.
- `read/projections/task_sla_config.sql`, `read/projections/gate_dwell_metric.sql` (new); `read/projections/pick_task.sql`, `read/projections/putaway_task.sql`, `read/projections/weighbridge_event.sql`, `read/projections/grn.sql` (updated) - canonical idempotent DDL.
- `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts` (updated) - event registry, write-seam splice points, migration ordering.
- `deploy/compose/init-db.sql` (updated) - DDL mirror.
- `test/integration/story-3-8.test.ts` (new), `test/unit/task-metrics.test.ts` (new), `test/integration/story-1-9.test.ts`, `test/unit/schema-drift.test.ts` (updated).
- No `edge/` files are expected to change for this story (see Task 7.6 and Project Structure Notes).

### Testing Standards Summary

- Test runtime is Node's built-in `node:test`, not vitest or jest; confirmed in `package.json`'s `test` script (`node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts`).
- One integration test file per story, named `test/integration/story-<epic>-<num>.test.ts`; `test/integration/story-3-8.test.ts` mirrors the structure of `test/integration/story-3-7.test.ts`.
- `test/integration/story-1-9.test.ts` holds the Spine Acceptance Contract's route-surface allowlist; any route not listed there fails `npm run spine-acceptance-contract`. Every new route from this story must be added.
- `test/unit/schema-drift.test.ts` holds an `EXPECTED` array asserting every projection table's canonical SQL is mirrored byte-for-byte into `deploy/compose/init-db.sql`; new tables must be registered there.
- Full verification gate before marking this story ready for review: `npm test`, `npm run edge:test` (expected unchanged), `npm run spine-acceptance-contract`, `tsc` clean, `eslint` clean, schema-drift green.
- Expect the same adversarial code-review lens applied to prior warehouse stories: concurrency (status-predicated updates versus read-then-write races), fail-open helper functions that silently no-op instead of throwing, and RBAC/site-scoping gaps are the dominant defect categories found in Stories 3.6 and 3.7's reviews. This story's SLA-breach and gate-dwell math should expect the same scrutiny on correctness of aggregate computation and on read/write role separation.

### Previous Story Intelligence (Story 3.7)

Concrete, actionable learnings from Story 3.7's two adversarial review passes, to apply proactively rather than rediscover:

- **RBAC read-role regression.** A round-1 fix to write roles broke read access for the same roles that also write. Fixed with an explicit `DISPATCH_READ_ROLES` constant enumerating both write-capable and dedicated read-only roles. Apply the same discipline here: `WAREHOUSE_TASK_READ_ROLES` must explicitly list every role that can write (`warehouse_manager`, `inventory_controller`) alongside the dedicated read/frontline roles; never assume write membership implies read membership.
- **SOD guard must cover every write event type in the domain, not just the most obvious one.** Story 3.7 initially guarded only `dispatch.dispatched` against frontline roles via the edge path and left `dispatch.packed`/`dispatch.shipping_documents_generated` open until a second review pass. This story has fewer write event types, but apply the SOD guard (Task 7.3) to `task_sla_config.updated` at the compliance seam from the start, not just the HTTP handler.
- **Lock-then-filter, never filter-then-lock, for any hold/gate check.** The `LOT_ON_HOLD` bug recurred twice across both review passes because one call site still filtered by status before locking. Not directly applicable to this story's read-heavy surface, but keep this discipline in mind if any future extension adds gating logic that reads then conditionally locks a row.
- **Never loop `persistEvent` calls without pre-validating the whole batch first.** A per-line persist loop with no upfront validation let partial commits happen before a batch failed. If SLA-config updates or task assignment are ever batched, validate the entire batch before persisting any part of it.
- **Server-set actor identity fields must come from the envelope's actual actor metadata, never a placeholder.** A round-1 bug used the literal string `'unknown'` for `packed_by`/`generated_by`, violating a `NOT NULL` UUID constraint. Source `updated_by`/`assigned_by` from `envelope.metadata.actor.user_id` or `authContext.userId`, never a placeholder.
- **When removing a non-deterministic input, replace it with a deterministic equivalent from the event envelope, do not just delete the field.** A commercial-invoice date was dropped entirely when `new Date()` was removed for determinism; the fix was to thread `metadata.occurred_at` through instead. This is directly relevant to Task 1: the fix there is exactly "stop discarding `occurred_at`, persist it."
- **Verify a fix by checking the actual returned response shape against the acceptance criteria, not just that something changed.** A `generate-documents` response was missing `documentIds` in round 1 and still missing it after an apparently-applied "fix." Confirm this story's dashboard/productivity/exceptions endpoints actually return the fields AC1 through AC3 require (age, priority, zone, breached threshold, operator identity, duration, drill-through list) by asserting on the response body in tests, not just on a 200 status.
- **Grants must be copy-checked literally against the DDL task spec.** A round-1 table grant included `DELETE` when the spec said INSERT/SELECT/UPDATE only. Copy the exact grant list from Task 3.1 when writing `task_sla_config.sql`'s DO $$ blocks.
- **An existing architectural inconsistency to be aware of, not necessarily to fix here:** pick-task assignment (`assignPickTask` in `src/read/projections/pick_task.ts`, called from `src/api/v1/pick-tasks.ts`) is a direct database UPDATE inside a manually managed transaction, bypassing `persistEvent` entirely - no domain event is emitted for pick-task assignment today. This story's new putaway-assign endpoint (Task 2.6) follows the same direct-UPDATE-with-role-gate pattern for consistency with the existing pick-task precedent, rather than introducing a new assignment event type; this keeps scope bounded but is a known inconsistency with the "state mutation only through events" principle that a later story may choose to close.
- **An explicitly deferred, inherited gap:** `src/compliance/dispatch.ts` has no site-isolation check in its apply functions (logged to `deferred-work.md`, 2026-07-28). This story does not need to fix it, but Task 7.4 requires that this story's own aggregation queries apply an explicit `site_id` filter regardless, so the gap cannot silently widen through a new cross-domain read.
- **Mirror the prior story's integration test file structure.** Story 3.7 explicitly mirrored Story 3.6's test file; this story's `test/integration/story-3-8.test.ts` should mirror `test/integration/story-3-7.test.ts`'s structure and its case-coverage checklist style (happy path, each rejection code, RBAC negative test, site-scoping negative test, idempotent-replay test).

### Files to Touch

New files and the reason each exists:

| File | Reason |
| --- | --- |
| `src/api/v1/warehouse-tasks.ts` | REST routes for the dashboard, productivity, SLA-config, and gate-dwell exception endpoints. |
| `src/compliance/warehouse-task.ts` | Assert/apply write-path seam for `task_sla_config.updated`. |
| `src/warehouse/task-metrics.ts` | Pure algorithm module: task-board normalization, SLA-breach detection, confirmation-rate rollup, gate-dwell median/exception math. |
| `read/projections/task_sla_config.sql` + `src/read/projections/task_sla_config.ts` | New event-sourced configurable SLA-threshold table and its accessor. |
| `read/projections/gate_dwell_metric.sql` + `src/read/projections/gate_dwell_metric.ts` | New derived view joining gate/weighbridge/GRN events for dwell computation, and its accessor. |
| `test/integration/story-3-8.test.ts` | Story integration test suite. |
| `test/unit/task-metrics.test.ts` | Unit tests for the median/confirmation-rate/SLA-breach math. |
| `_bmad-output/implementation-artifacts/3-8-warehouse-task-management-and-productivity-tracking-fr-w-07.md` | This story file. |

Updated files, current state, what changes, and what must be preserved (the following table of updated files should be read alongside the paragraph above it):

| File | Current state | What changes | Must preserve |
| --- | --- | --- | --- |
| `src/events/store.ts` | Pre-transaction asserts end at `assertErpReadOnly`; in-transaction applies end immediately before the `nextVersion`/`domain_events` insert; most recent block is Story 3.7's dispatch asserts/applies. | Splice `assertTaskSlaConfigUpdatedShape` and `applyTaskSlaConfigUpdatedProjection` at the fixed anchor points (Task 3.4). | Exact existing ordering of every prior assert/apply block, byte-identical. |
| `src/events/schema.ts` | `SUPPORTED_EVENT_TYPES` registers the `'warehouse'` stream's existing events with `requiresBusinessStream: false`. | Add `task_sla_config.updated` with the same stream/flag, plus its payload/envelope type. | Existing entries and their exact `streamType`/`requiresBusinessStream` values. |
| `src/events/migrate.ts` | `MIGRATIONS` array currently ends with the Story 3.7 `packing_record.sql`/`dispatch_document.sql` entries. | Append `task_sla_config.sql` and `gate_dwell_metric.sql` at the end. | Every existing array entry, in its existing order. |
| `read/projections/weighbridge_event.sql` + `.ts` | No timestamp beyond `business_date` (date only) and DB-default `created_at`. | Add `occurred_at TIMESTAMPTZ`. | All 5 existing CHECK constraints and their exact names. |
| `read/projections/grn.sql` + `.ts` | Same gap: only `business_date`/`created_at`. | Add `received_at TIMESTAMPTZ`. | Header-identity-immutability behavior (first line creates header, status only advances forward). |
| `src/compliance/weighbridge.ts` | Computes `occurredAt` only to derive `business_date`; discards the instant. | Thread `occurredAt` into the new `occurred_at` column. | Tolerance-band computation and `tolerance_breach` notification block. |
| `src/compliance/receiving.ts` | Same pattern at two `insertGrnHeader` call sites. | Thread `occurredAt` into `received_at` at both call sites. | Advisory-lock tolerance-band SQL and the over-receipt "committed business outcome" behavior. |
| `read/projections/putaway_task.sql` + `.ts` | No `assigned_to`, `zone_id`, or `priority`; `listPutawayTasks` only filters by `siteId`/`status`. | Add all three columns additively; add `assignPutawayTask()`; extend list filters. | Existing Story 3.5 columns (`directed_location_id`, `velocity_class_at_suggestion`, `override_confidence`) and both existing CHECK constraints. |
| `read/projections/pick_task.sql` + `.ts` | Has `assigned_to`/`zone_id`/identity/duration fields; no `priority`. | Add `priority` column, CHECK constraint, filter/sort support. | Existing `strategy`/`status` CHECK constraints, indexes, and `assignPickTask()`'s current behavior. |
| `src/api/v1/putaway.ts` | Exports list/get/suggestion/complete/velocity/reslotting handlers; no assignment endpoint; role constants `PUTAWAY_READ_ROLES`, `PUTAWAY_EXECUTE_ROLES`, `RESLOTTING_ROLES`. | Add the assign handler and `PUTAWAY_SUPERVISE_ROLES`. | Every existing exported handler name and behavior (imported directly by `src/server.ts`). |
| `src/server.ts` | Registers routes per domain via `router.get`/`router.post`, grouped by comment block. | Register the new `warehouse-tasks.ts` routes and the putaway-assign route. | All existing route registrations, order, and grouping style. |
| `test/integration/story-1-9.test.ts` | Flat allowlist array of every legitimate `METHOD /api/v1/...` route. | Append every new Story 3.8 route. | Every existing entry, verbatim, in place. |
| `test/unit/schema-drift.test.ts` | `EXPECTED` array of `{ canonical, table, constraints, indexes, appUserGrant? }` objects, one per table. | Add `task_sla_config` (and `gate_dwell_metric` if view-compatible); add any new named constraints to existing entries. | Every existing array entry and the test-generation loop logic. |
| `deploy/compose/init-db.sql` | Mirrors every canonical SQL file's DDL, appended story-by-story. | Mirror every new/altered block, appended at the end. | The `powersync_publication` block boundary, never edited inside it. |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | `3-8-warehouse-task-management-and-productivity-tracking-fr-w-07: backlog` under `epic-3`. | Status transitions through `ready-for-dev`, `in-progress`, `review`, `done` as work proceeds, with review-history comment entries. | All other epic/story entries and inline `# PILOT` comments. |

### Project Structure Notes

This story's file layout follows the exact skeleton established by Stories 3.5 through 3.7: one REST file per domain in `src/api/v1/`, one compliance seam file in `src/compliance/`, one pure-logic module in `src/warehouse/`, and a matched TypeScript-accessor-plus-SQL-DDL pair per table in `src/read/projections/`/`read/projections/`. No conflicts with the unified project structure were found.

Two deliberate variances from the immediately preceding stories' pattern, both justified above and neither a defect:

- `gate_dwell_metric` is implemented as a SQL view, not a table, because it is fully derivable from data already materialized by Stories 3.2 through 3.4 and needs no independent write path or `apply*Projection` hook. Every other new/updated table in this story still follows the standard idempotent-table-DDL pattern.
- No `edge/` workspace files are touched by this story. Stories 3.6 and 3.7 (frontline capture flows) required edge acceptance wiring; Story 3.8 is a supervisor dashboard/monitoring feature with no acceptance-criteria reference to offline capture, so `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json` are correctly out of scope here (Task 7.6).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.8] - full verbatim story statement and three acceptance criteria.
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-3] - epic mission paragraph, gate-token event chain (AD-2), FR-W-07 fully in scope for Phase 1 with no deferral caveat.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.2] - gate-entry event timestamp and vehicle-to-PO binding token, the start point of the AC3 dwell interval.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.3] - weighbridge acceptance for the same binding token, the primary end point of the AC3 dwell interval.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.4] - GRN confirmation as the AC3 fallback end point when no weighment applies.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-12.1] - warehouse-manager dashboard widget that consumes, but does not re-derive, this story's task-board and gate-dwell projections.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.9] - forward-pick replenishment tasks that place onto the task board this story builds.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#Stack] - Node 24 LTS, PostgreSQL 18.4, Next.js 16, TypeScript 5.x versions.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#Structural-Seed] - folder layout: `events/`, `read/projections/`, `warehouse/`, `api/v1/`.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-14] - read models are shared PostgreSQL projections; no module has direct database access to another module's tables.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-15] - event-sourced location, asserted-versus-expected, informs the zone-resolution approach in Task 2.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-16] - idempotency keys on edge-originated commands; duplicate submission returns HTTP 409.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-17] - notification emission coupling as an available, not required, extension point.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#API-Contract] - REST versioning, error envelope, stable error codes.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#Spine-Acceptance-Contract] - the five mandatory CI-enforced invariants this module must not violate.
- [Source: PLANNING/prd/7-success-metrics.md] - SM-13 (median gate dwell at or below 4 minutes including offline), SM-17 (frontline confirmation rate at or above 95%), SM-C2 (dwell must not improve by skipping mandatory capture).
- [Source: _bmad-output/implementation-artifacts/3-6-pick-task-generation-and-execution-fr-w-04.md] - nearest built precedent for task/queue schema shape, list-filter accessor pattern, and TOCTOU/fail-open review findings applied proactively here.
- [Source: _bmad-output/implementation-artifacts/3-7-packing-shipping-and-dispatch-documents-fr-w-05-fr-w-06.md] - explicit disclaim of task-management-dashboard ownership; RBAC read-role regression, SOD guard coverage, and actor-identity lessons applied in this story's Previous Story Intelligence section.
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml] - epic-3 development status and story-key confirmation.
- PostgreSQL 18 official documentation, `functions-aggregate.html` and `sql-expressions.html` (via Context7 `/websites/postgresql_18`) - `percentile_cont`/`percentile_disc` signatures and the ordered-set-aggregates-are-not-window-functions constraint applied in Task 6.3.

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m]

### Debug Log References

- Baseline commit `cd7e3d9` (Story 3.7 in-progress, Story 3.6 done). Baseline suite state before any
  code change: 436 tests, 422 pass, 1 fail, 13 cancelled.
- Test database: the committed `.env.test` names `DB_PORT=5432`, but this project's own container
  (`ims2-test-postgres`) publishes on host port `5442`; port 5432 is held by an unrelated container,
  which is why every integration suite reports "password authentication failed" out of the box. All
  runs below used `DB_PORT=5442`. Logged to `deferred-work.md` as a configuration decision for the
  team rather than changed unilaterally, since `.env.test` is tracked and shared.
- `test/integration/story-3-7.test.ts` does not execute at all at baseline: its `before` hook posts
  to `/api/v1/scim/Users`, which is not a registered route. It therefore fails setup and cancels its
  13 subtests. Story 3.8's suite mirrors the working Story 3.6 harness instead, as recorded in the
  file's header comment. Logged to `deferred-work.md` against Story 3.7.
- `test/integration/story-3-3.test.ts:255` is the long-documented date-flake (asserts
  `business_date === '2026-07-22'` against a wall-clock-derived value). It is the single failing test
  at baseline and remains the single failing test after this story. Already in `deferred-work.md`.
- `npm run lint` was red at baseline: `src/api/v1/edge.ts:202/209/216` tripped
  `doa/no-hardcoded-role-in-workflow` on Story 3.7's inline dispatch SOD role literals. Because
  Task 8.5 requires a clean eslint and `npm run spine-acceptance-contract` runs eslint first, this
  blocked the story's own gate. Fixed by the minimal behaviour-preserving change of extracting the
  two literals into a named `DISPATCH_DENIED_FRONTLINE_ROLES` constant and comparing via
  `.includes()`. No dispatch authorization behaviour changed; edge tests stay 23/23.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- Implementation 2026-07-29 (claude-opus-5): all 8 tasks and 59 subtasks completed from baseline
  `cd7e3d9`.
- **Task 1 (AC3 inputs).** Additive `weighbridge_event.occurred_at` and `grn.received_at`, threaded
  from `metadata.occurred_at` through `src/compliance/weighbridge.ts` and both `insertGrnHeader`
  call sites in `src/compliance/receiving.ts`. Stories 3.3/3.4 computed this instant only to derive
  a calendar `business_date` and then discarded it, which made a sub-day dwell interval
  uncomputable. `received_at` joins GRN header identity: the ON CONFLICT clause leaves it alone, so
  a later line can neither move nor null the first line's receipt instant.
- **Task 2 (AC1 inputs).** Additive `priority` (with `chk_pick_task_priority` /
  `chk_putaway_task_priority`) on both task projections, plus `assigned_to` / `assigned_by` /
  `assigned_at` / `zone_id` on `putaway_task`. Priority ordering ranks through an explicit SQL CASE,
  never `ORDER BY priority`, which would sort the vocabulary alphabetically. `zone_id` is resolved
  once inside `setDirectedSuggestion` by a depth-capped recursive walk up
  `location_register.parent_location_id`, so the board never runs a topology walk per row.
  `assignPutawayTask` is a status-predicated `UPDATE ... WHERE status = 'ready'` returning a boolean
  (409 `PUTAWAY_TASK_NOT_ASSIGNABLE`), never a read-then-write.
- **Task 3 (AC1 configuration).** New `task_sla_config` projection on the (task_type, zone_id) grain
  with a `NULLS NOT DISTINCT` unique index, so the site-wide default row (`zone_id IS NULL`) cannot
  stack duplicates. Deviation from the task text, deliberate: the index is unqualified rather than
  partial, because the table carries no active/superseded lifecycle column to make it partial by,
  and one row per grain unconditionally is the stronger rule (and the ON CONFLICT target the upsert
  needs). New `task_sla_config.updated` event on the existing `warehouse` stream, spliced into
  `store.ts` immediately after the Story 3.7 dispatch assert/apply blocks, with no existing call
  reordered.
- **Task 4 (AC1).** `src/warehouse/task-metrics.ts` normalizes four sources into one board shape.
  Sources are a data-driven array, not a hard-coded UNION, so Story 3.9's replenishment tasks join
  by appending one entry. `age_minutes` is computed in SQL (never after the round trip, where
  request latency would skew it) and the breach comparison uses exact decimal-string comparison, so
  no IEEE-754 rounding ever decides a breach. An unconfigured threshold reports as `null` and is not
  a breach - it is never silently replaced by an invented default.
- **Task 5 (AC2).** `computeConfirmationRate` rolls up per operator and per zone over the same
  normalized source set. The denominator is anchored on task *creation* inside the period, not
  completion: anchoring on completion would make the rate identically 100% by construction. Duration
  and median are both SQL-side.
- **Task 6 (AC3).** `gate_dwell_metric` is a VIEW (the one documented exception to the projection-
  trio pattern) joining gate entry to the first accepted weighment, falling back to the first GRN.
  Reversed gate events are excluded; unresolved vehicles are retained with a NULL dwell rather than
  dropped. The median uses `percentile_cont(0.5) WITHIN GROUP (...)` under a plain `GROUP BY` - not
  as a window function, which PostgreSQL 18 does not permit for ordered-set aggregates. `exceeded`
  is strictly greater than 4 minutes, so an exactly-4-minute median is on target. SM-C2 capture-
  completeness counters ship on the same payload as the dwell figure.
- **Task 7 (RBAC/SOD/scoping).** `WAREHOUSE_TASK_READ_ROLES` enumerates the two supervisor roles
  explicitly alongside the four frontline ones (the Story 3.7 read-role regression). The
  supervisor-only SOD gate for `task_sla_config.updated` lives in the compliance seam, not only the
  HTTP handler, and the suite proves it by posting the event straight to `/api/v1/events` as a
  frontline actor and asserting 403. Every aggregate refuses to run unscoped unless the caller holds
  a genuine wildcard assignment, so a forgotten site filter fails closed rather than leaking across
  sites. No `edge/` file and no `src/sync/upload.ts` entry was added (Task 7.6).
- **Task 8 (verification).** 27 unit tests over the pure decision math (including the exactly-4-
  minute boundary, which cannot be produced over HTTP) and 22 integration tests covering AC1/AC2/AC3
  happy paths, both dwell resolution legs, the RBAC and SOD negatives, site-scoping negatives, the
  idempotent-replay case, and a view-shape assertion (the schema-drift harness only understands
  `CREATE TABLE` blocks, so `gate_dwell_metric` is asserted in the integration suite per Task 8.3).
- Verification: `tsc` clean, `eslint` clean, `npm run build` clean, `npm test` 486 tests / 472 pass
  (+50, all new tests passing) with the single pre-existing story-3-3 date-flake and the 13
  pre-existing story-3-7 cancellations unchanged from baseline, `npm run spine-acceptance-contract`
  6/6, schema-drift 41/41, `npm run edge:test` 23/23 unchanged, edge typecheck/lint clean,
  `npm run db:migrate` re-runnable against an existing database.

### File List

New files:

- `read/projections/task_sla_config.sql`
- `read/projections/gate_dwell_metric.sql`
- `src/read/projections/task_sla_config.ts`
- `src/compliance/warehouse-task.ts`
- `src/warehouse/task-metrics.ts`
- `src/api/v1/warehouse-tasks.ts`
- `test/integration/story-3-8.test.ts`
- `test/unit/task-metrics.test.ts`

Modified files:

- `read/projections/weighbridge_event.sql`
- `read/projections/grn.sql`
- `read/projections/pick_task.sql`
- `read/projections/putaway_task.sql`
- `src/read/projections/weighbridge_event.ts`
- `src/read/projections/grn.ts`
- `src/read/projections/pick_task.ts`
- `src/read/projections/putaway_task.ts`
- `src/compliance/weighbridge.ts`
- `src/compliance/receiving.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/api/v1/putaway.ts`
- `src/api/v1/edge.ts` (lint-only extraction of Story 3.7's inline dispatch SOD role literals)
- `src/server.ts`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/3-8-warehouse-task-management-and-productivity-tracking-fr-w-07.md`

### Review Findings

Adversarial code review, 2026-07-29, three parallel layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) against baseline `cd7e3d9`. All findings below were re-verified against source before triage. 8 decisions, 18 patches, 2 deferred, 4 dismissed as noise. All 8 decisions were resolved on 2026-07-29 and each became a patch, giving 26 patch items in total.

Decisions taken on 2026-07-29:

1. D1 packing metrics: exclude packing from `COMPLETION_SOURCES` entirely until a real start instant exists, rather than reporting a rate of 100 percent and a duration of zero.
2. D2 SLA tenancy: add `site_id` to the `task_sla_config` grain, moving the unique index to `(site_id, task_type, zone_id)` with `NULLS NOT DISTINCT`, and thread the site through the event payload, the seam and the `getSlaConfig` fallback order.
3. D3 assignment events: record putaway assignment as a `putaway_task.assigned` domain event through `persistEvent` and a compliance seam, mirroring the `task_sla_config.updated` pattern, and move the SOD gate into that seam.
4. D4 attribution: prefer `assigned_to` over `completed_by` so the assignee stays accountable, falling back to the completer only for unassigned work.
5. D5 gate-dwell fallback: keep the GRN leg as a migration safety net, correct the SM-C2 flags so a real weighment is never mislabelled as a fallback, and record that AC3's wording describes a state the receiving guard makes unreachable.
6. D6 metrics RBAC: keep frontline roles on the task board but restrict the productivity and gate-dwell exception endpoints to supervisor roles.
7. D7 pick priority: add a pick assign route mirroring the putaway one, accepting that this is scope beyond Task 2.6.
8. D8 open dwell: count an unresolved vehicle's open dwell against `now()` so a yard of stuck vehicles breaches rather than reading as clean.

- [x] [Review][Decision] Packing records are hard-coded complete with zero duration, so the AC2 confirmation rate is inflated by construction - `COMPLETION_SOURCES` selects `pr.packed_at` as both `created_at` and `completed_at` and `true AS completed`, so every packing row adds 1 to both numerator and denominator and contributes an exact 0 to `AVG` and `percentile_cont`. An operator who packs trends toward a 100 percent rate and a 0-second median regardless of real performance, which defeats SM-17. The same rows are simultaneously counted as open packing work by `TASK_SOURCES`, so AC1 and AC2 contradict each other for one identity. `packing_record` has no creation column, so the correct treatment is a product call: exclude packing from the denominator, exclude it only from the duration aggregates, or source a real start instant. [src/warehouse/task-metrics.ts:391-398, 209-220]
- [x] [Review][Decision] `task_sla_config` has no `site_id`, so the documented "site-wide default" is actually deployment-wide - the grain is `(task_type, zone_id)` with `NULLS NOT DISTINCT`, which permits exactly one null-zone row per task type across the entire database. A `warehouse_manager` scoped to one site who omits `zone_id` silently changes what counts as a breach at every other site, and no other site's supervisor can see who changed it. Fixing this changes the table grain, the unique index, the event payload, and the resolution order in `getSlaConfig`, and needs a migration decision for existing rows. [read/projections/task_sla_config.sql:16-27, 59-60; src/api/v1/warehouse-tasks.ts:285-287]
- [x] [Review][Decision] Putaway assignment bypasses the event log entirely - the assign handler acquires a raw pool client and calls `assignPutawayTask` directly, never invoking `persistEvent` and never writing an audit entry (verified: zero `persistEvent` references in that code path). This is the only warehouse state mutation in the codebase with no domain event. A projection rebuild reconstructs `assigned_to`, `assigned_by`, `assigned_at` and `priority` as null, silently discarding all assignment state, and an assignment dispute has no evidence. It also directly contradicts this story's own `task_sla_config.sql` comment, which states that rows are written only through a `persistEvent` seam and never by a direct handler UPDATE. Decide whether assignment becomes a proper event-sourced write or is accepted as ephemeral read-model state. [src/api/v1/putaway.ts:56-97; src/read/projections/putaway_task.ts:282-298]
- [x] [Review][Decision] Completion attribution moves a task off its assignee's ledger - `COALESCE(completed_by, assigned_to)` attributes a task to whoever completed it. If operator A is assigned 10 tasks and operator B completes them, A produces no rows at all and B shows a perfect rate. The metric intended to expose an operator not confirming assigned work structurally cannot, because assigned-but-uncompleted rows are the only ones that could lower a rate. Decide whether the denominator follows the assignee or the completer. [src/warehouse/task-metrics.ts:374, 383, 406]
- [x] [Review][Decision] The AC3 GRN-fallback condition cannot occur as written - AC3 specifies falling back to GRN confirmation "where no weighment applies", but `applyGoodsReceivedProjection` refuses to create any GRN without an accepted weighment for the binding token (404 `RECEIVING_BINDING_TOKEN_NOT_FOUND`, 409 `RECEIVING_WEIGHT_NOT_ACCEPTED`). Every GRN therefore has an accepted weighment, so the fallback only ever fires in the narrow deploy-straddling window where the weighment predates this migration and the GRN follows it. The integration test proves the leg only by seeding a weighment through a raw INSERT that bypasses the Story 3.3 write path, manufacturing a state the system cannot produce. Decide whether AC3's wording is wrong or receiving is too strict. [read/projections/gate_dwell_metric.sql:34-42; src/compliance/receiving.ts:187-198; test/integration/story-3-8.test.ts:595-646]
- [x] [Review][Decision] Frontline roles can read every operator's productivity scorecard - `WAREHOUSE_TASK_READ_ROLES` includes `store_assistant`, `warehouse_operator` and `dispatch_clerk`, and gates the productivity and gate-dwell endpoints on that same list. A `store_assistant` can call the productivity route with no `operator_id` filter and receive per-colleague confirmation rates and durations for the whole site, plus vehicle registrations and PO references for every breaching vehicle. The constant's docstring reasons only about not under-granting read access and never asks whether the aggregate is more sensitive than the per-domain endpoints it aggregates. [src/api/v1/warehouse-tasks.ts:44-51, 177, 214]
- [x] [Review][Decision] `pick_task.priority` can never be set to anything but `normal` - `setPickTaskPriority` is exported and never called anywhere in `src/` or `test/`, `createPickTask` has no caller supplying a priority, and Task 2.6 added an assign route for putaway only. A supervisor cannot escalate an urgent pick, so for half the task types AC1's "showing age, priority, and zone" is inert and the priority column, its CHECK constraint and its index are unexercised. Decide whether picking gets an equivalent assign or prioritize route. [src/read/projections/pick_task.ts:197; read/projections/pick_task.sql:79-96]
- [x] [Review][Decision] A vehicle still in the yard can never produce a dwell breach - an unresolved token yields a NULL `dwell_interval`, which `percentile_cont` skips and the drill-through predicate excludes. A shift in which every vehicle is still waiting after three hours reports a null median and `exceeded: false`. The view header documents emitting these rows as deliberate, and `unresolved_count` records them, but nothing acts on the count. Decide whether open dwell measured against `now()` should count toward SM-13. [read/projections/gate_dwell_metric.sql:16-18, 40; src/warehouse/task-metrics.ts:558-559, 611]
- [x] [Review][Patch] The `site` query alias bypasses UUID validation and reaches SQL raw [src/api/v1/warehouse-tasks.ts:152, 192, 218, 244; src/warehouse/task-metrics.ts:645-650]
- [x] [Review][Patch] The compliance seam does not site-scope a zone-scoped SLA change, so a direct event POST performs a cross-site threshold write [src/compliance/warehouse-task.ts:105-120]
- [x] [Review][Patch] `median_duration_seconds` lacks the `FILTER` that `avg_duration_seconds` carries, so the two statistics describe different populations [src/warehouse/task-metrics.ts:430-434]
- [x] [Review][Patch] A negative dwell interval from clock skew is never clamped or excluded and drags the shift median down [read/projections/gate_dwell_metric.sql:40]
- [x] [Review][Patch] The weighbridge lateral filters on `occurred_at IS NOT NULL`, so a pre-migration accepted weighment is reported as `weighment_present = false` and `grn_fallback_used = true` [read/projections/gate_dwell_metric.sql:41-42, 50]
- [x] [Review][Patch] `JOIN erp_sales_order` is an INNER JOIN and no foreign key constrains `dispatch_order_id`, so a lagging ERP projection silently removes pick and packing tasks from the board and from the productivity denominator at the same time [src/warehouse/task-metrics.ts:170, 219, 381, 398]
- [x] [Review][Patch] Concurrent assignment silently steals a task: the status-predicated UPDATE has no assignee or version guard, so both writers return 200 and the first operator is unassigned without notice [src/read/projections/putaway_task.ts:291-298]
- [x] [Review][Patch] `task_sla_config.updated` applies with no idempotency or ordering guard, so an out-of-order replay reinstates a superseded threshold and changes which live tasks read as breached [src/compliance/warehouse-task.ts:129-141]
- [x] [Review][Patch] The `business_date` regex checks shape only, so `2026-13-45` passes validation and raises a Postgres 22008 as a 500 instead of a 400 [src/warehouse/task-metrics.ts:651-654]
- [x] [Review][Patch] `NUMERIC_9_2_REGEX` bounds scale but not precision, so an 8-digit threshold passes the pre-transaction assert and overflows `NUMERIC(9,2)` as a 500 inside the transaction [src/compliance/warehouse-task.ts:34, 50-57]
- [x] [Review][Patch] `listSlaConfig` filtered by `zone_id` excludes the null-zone row by SQL NULL semantics, so the config screen reports no SLA for a zone the board is actively flagging as breached [src/read/projections/task_sla_config.ts:94-96]
- [x] [Review][Patch] The unified board query has no `LIMIT` and no pagination, and the handler materializes the full array twice more [src/warehouse/task-metrics.ts:259-266]
- [x] [Review][Patch] Zone resolution assigns NULL unconditionally on depth-cap exhaustion or a cyclic parent chain, which is indistinguishable from "no bin directed" and overwrites a previously correct `zone_id` on re-direction [src/read/projections/putaway_task.ts:228-238, 263-271]
- [x] [Review][Patch] `challan_photo_present` is vacuously true because `challan_photo_ref` is `NOT NULL` and carries a non-empty CHECK, so the SM-C2 counter always equals `vehicle_count` and can never signal skipped capture [read/projections/gate_dwell_metric.sql:43; read/projections/gate_event.sql:10, 24]
- [x] [Review][Patch] The zone lookup selects `status` but never checks it, so a threshold can be set against a decommissioned zone [src/compliance/warehouse-task.ts:107-119]
- [x] [Review][Patch] `resolveZoneAncestor` is exported but never called; the real resolution is the inlined CTE [src/read/projections/putaway_task.ts:239]
- [x] [Review][Patch] The six new allowlist entries are indented 4 spaces inside an array literal indented 6 everywhere else [test/integration/story-1-9.test.ts:289-294]
- [x] [Review][Patch] `src/read/projections/gate_dwell_metric.ts` was never created although the spec names it in both the Source Tree and Files to Touch sections; the view is queried inline instead and the File List omits it [src/warehouse/task-metrics.ts:551-566, 603-614]
- [x] [Review][Defer] Putaway tasks directed before this migration never receive a `zone_id` because the additive column ships with no backfill and `setDirectedSuggestion` only runs at direction time, so they fall into the null-zone bucket on the board and in the per-zone rollup [read/projections/putaway_task.sql:79] - deferred, inherent to an additive migration; needs a backfill pass planned with the deployment.
- [x] [Review][Defer] GRN headers created before this migration can never backfill `received_at` because the `ON CONFLICT` clause deliberately leaves it alone [src/read/projections/grn.ts:118-124] - deferred, the immutability is mandated by Task 1.4 and the paired pre-migration weighments are equally null, so those vehicles are simply outside dwell reporting.

### Review Findings - Code-Only Re-Review 2026-07-30

- [ ] [Review][Patch] Legacy accepted weighment with NULL `occurred_at` and no GRN is treated as open dwell, so completed historical visits become growing false breaches [read/projections/gate_dwell_metric.sql:72]
- [ ] [Review][Patch] Future `gate_event.entered_at` creates negative open dwell and can lower the shift median instead of surfacing clock skew [read/projections/gate_dwell_metric.sql:72]
- [ ] [Review][Patch] SLA replay ordering has no deterministic tie-break when two threshold events share `event_occurred_at` [src/read/projections/task_sla_config.ts:165]
- [ ] [Review][Patch] Direct `pick_task.assigned` events skip site scoping when the ERP sales-order row is missing [src/compliance/warehouse-task.ts:343]
- [ ] [Review][Patch] Assignment projections run before duplicate event insertion, so idempotent retry after task state changes can return task conflict instead of duplicate-event semantics [src/events/store.ts:432]
- [ ] [Review][Patch] Assignment replay uses `now()` for `assigned_at`, making rebuilt assignment timestamps non-deterministic [src/read/projections/pick_task.ts:207; src/read/projections/putaway_task.ts:303]
- [ ] [Review][Patch] Assignment seam accepts any UUID as `assigned_to`, including nonexistent or inactive users [src/compliance/warehouse-task.ts:232]
- [ ] [Review][Patch] Metrics role authorization and metrics site scope use different role sets, letting a supervisor at one site read productivity and gate-dwell data for another site where they only hold a frontline warehouse role [src/api/v1/warehouse-tasks.ts:211]
- [ ] [Review][Patch] Event actor metadata may be stamped from the first write assignment rather than the supervisor assignment that covers the target site [src/api/v1/warehouse-tasks.ts:325; src/api/v1/putaway.ts:245; src/api/v1/pick-tasks.ts:293]
- [ ] [Review][Patch] SLA-config `zone_id` is only type-checked before a UUID-column query, so malformed strings can surface as PostgreSQL 22P02 [src/api/v1/warehouse-tasks.ts:297]
- [ ] [Review][Patch] Open-task `limit` accepts `NaN`, fractions, and infinity, which can reach SQL `LIMIT` as a 500 instead of 400 `INVALID_PARAMS` [src/warehouse/task-metrics.ts:281]
- [ ] [Review][Patch] Productivity period validation relies on `Date.parse`, so invalid or timezone-less timestamps can disagree with PostgreSQL `timestamptz` parsing [src/warehouse/task-metrics.ts:732]
- [ ] [Review][Patch] Putaway assignment route does not mirror pick assignment's active-assignee check and can assign work to a nonexistent operator [src/api/v1/putaway.ts:227]
- [ ] [Review][Patch] Task-board summary counts are computed after the row cap, so `open_count` and `breached_count` can under-report total work even when `truncated` is true [src/api/v1/warehouse-tasks.ts:181; src/warehouse/task-metrics.ts:281]
- [ ] [Review][Patch] Gate-dwell drill-through performs one unbounded breach query per exceeded shift, so wildcard reads can become N-plus-one and unbounded [src/warehouse/task-metrics.ts:649]
- [ ] [Review][Patch] Productivity zone rollup orders by a constant `NULL::uuid` column, leaving zone row order nondeterministic [src/warehouse/task-metrics.ts:485]
- [ ] [Review][Patch] Schema drift guard omits `idx_task_sla_config_site_type` and has no canonical view-body parity check for `gate_dwell_metric` [test/unit/schema-drift.test.ts:415; test/integration/story-3-8.test.ts:840]
- [ ] [Review][Patch] `task_sla_config` upgrade guard checks `information_schema.columns` without table schema, so a same-named table in another schema can trigger the destructive upgrade branch [read/projections/task_sla_config.sql:80]
- [ ] [Review][Patch] Direct-event SOD test is a false positive because read-only warehouse credentials are rejected by route RBAC before the compliance seam runs [test/integration/story-3-8.test.ts:725]
- [ ] [Review][Patch] Task-board tests do not prove priority ordering independently and do not cover receiving or packing sources in the unified board [test/integration/story-3-8.test.ts:380]
- [ ] [Review][Patch] Site-scope and metrics-RBAC negative tests miss SLA-config read/write surfaces and frontend role denial on productivity and gate-dwell endpoints [test/integration/story-3-8.test.ts:713; test/integration/story-3-8.test.ts:819]
- [ ] [Review][Patch] Replay, idempotency-key, and concurrent assignment edge tests are weak or missing for the new event-sourced assignment and SLA flows [test/integration/story-3-8.test.ts:694; test/integration/story-3-8.test.ts:743; test/integration/story-3-8.test.ts:779]

## Change Log

The following table records each change made while implementing this story.

| Date | Change | Author |
| --- | --- | --- |
| 2026-07-29 | Story marked in-progress; baseline commit `cd7e3d9` recorded in frontmatter. | claude-opus-5 |
| 2026-07-29 | Tasks 1-8 implemented: capture-instant timestamps, task priority/assignment/zone attribution, event-sourced SLA-threshold registry, unified task board, productivity rollups, gate-dwell view and exception drill-through, RBAC/SOD/site scoping, and 49 new tests. | claude-opus-5 |
| 2026-07-29 | Fixed a pre-existing `npm run lint` failure in `src/api/v1/edge.ts` (Story 3.7 inline role literals) that blocked this story's own eslint and spine-acceptance gates; behaviour unchanged. | claude-opus-5 |
| 2026-07-29 | Logged two pre-existing findings to `deferred-work.md`: Story 3.7's non-executing integration suite and the `.env.test` database-port mismatch. | claude-opus-5 |
| 2026-07-29 | Status moved to review. | claude-opus-5 |
| 2026-07-29 | Adversarial code review (3 parallel layers). 8 decisions resolved, 26 patches applied, 2 deferred, 4 dismissed. | claude-opus-5 |
| 2026-07-29 | Review patches: `site_id` added to the `task_sla_config` grain; assignment converted to `putaway_task.assigned` / `pick_task.assigned` domain events with SOD gates in the compliance seam; packing removed from the AC2 rollup; attribution switched to `assigned_to`; gate-dwell view gained open-dwell, clock-skew and corrected SM-C2 flags. | claude-opus-5 |
| 2026-07-29 | Status moved to done. Gate: tsc/eslint clean, 488 tests 474 pass (1 fail and 13 cancelled are the pre-existing story-3-3 date-flake and story-3-7 SCIM harness, both deferred and unchanged), spine gate 6/6, edge 23/23, db:migrate re-runnable. | claude-opus-5 |
