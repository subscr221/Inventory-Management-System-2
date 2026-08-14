---
baseline_commit: f29765f
---

# Story 5.6: Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-14. Comprehensive developer guide created from epics.md (Story 5.6), SCM-Requirements-Document FR-B-06/FR-B-15/FR-B-16/FR-B-17 and INT-ERP-01 long forms, ARCHITECTURE-SPINE.md, stories 5.1 to 5.5 records, the deferred-work ledger, and a full baseline code audit at f29765f. -->

## Story

As a BOM administrator,
I want dated cost-rollup simulation snapshots with comparison, job-work kit BOMs tagged by supply source, and BOM sync to ERP that is strictly outbound,
So that finance sees accurate, controlled costs and the platform remains the system of record for BOM structure.

## Acceptance Criteria

1. **Given** a cost rollup is requested for a BOM (FR-B-15), **When** it runs, **Then** the result is stored as a dated simulation snapshot, leaving prior snapshots intact.
2. **Given** two or more dated rollup snapshots for the same BOM (FR-B-15), **When** a comparison is requested, **Then** the snapshots are compared with per-line and total deltas highlighted.
3. **Given** a Draft BOM without a completed cost rollup, **When** release is attempted (FR-B-06), **Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` - the completed-cost-rollup gate condition (staged from Story 5.2) is enforced from this story onward.
4. **Given** a job-work kit BOM (FR-B-16), **When** it is created, **Then** each line is tagged by supply source - company, customer, or job-worker.
5. **Given** an inbound ERP sync attempts to modify a BOM (FR-B-17), **When** the inbound change conflicts with the platform record, **Then** ERP sync is treated as outbound-only and the inbound conflict creates a BOM Administrator exception rather than mutating the BOM.

## Tasks / Subtasks

- [x] Task 1: Database schema for rollup snapshots, supply-source tagging, and the outbound/exception surfaces (AC: 1, 2, 3, 4, 5)
  - [x] 1.1 Create canonical `read/projections/bom_cost_rollup.sql` per the Database Schema Contract: `rollup_id` UUID PK, `bom_id` UUID NOT NULL, `revision_id` UUID NOT NULL, `rollup_date DATE NOT NULL` (IST business date), `rate_basis TEXT NOT NULL` CHECK in ('item_master_standard_cost'), `total_cost NUMERIC NOT NULL`, `line_count INTEGER NOT NULL`, `missing_rate_count INTEGER NOT NULL`, `depth_truncated BOOLEAN NOT NULL DEFAULT false`, `rolled_up_by` UUID, `correlation_id` UUID NULL, `source_event_id` UUID NOT NULL, `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Unique index `uq_bom_cost_rollup_source_event` on (source_event_id). Index `idx_bom_cost_rollup_bom` on (bom_id, rollup_date DESC). CHECK `chk_bom_cost_rollup_counts` (line_count >= 0 AND missing_rate_count >= 0 AND missing_rate_count <= line_count). Idempotent `CREATE TABLE IF NOT EXISTS`, guarded `DO $$` constraint blocks, DO-block grants (`INSERT, SELECT, UPDATE` to app_user, SELECT to readonly_user).
  - [x] 1.2 Create canonical `read/projections/bom_cost_rollup_line.sql`: `rollup_line_id` UUID PK, `rollup_id` UUID NOT NULL, `depth INTEGER NOT NULL` CHECK >= 0, `path TEXT NOT NULL`, `source_bom_id` UUID, `source_revision_id` UUID, `bom_line_id` UUID NOT NULL, `line_no INTEGER NOT NULL`, `component_item_id` UUID NULL, `component_sku TEXT NULL`, `effective_quantity_per NUMERIC NOT NULL` (scrap-adjusted quantity per one parent unit), `scrap_percent NUMERIC(9,6) NULL`, `unit_cost NUMERIC(18,6) NULL`, `extended_cost NUMERIC NOT NULL DEFAULT 0`, `rate_missing BOOLEAN NOT NULL DEFAULT false`, `via_phantom BOOLEAN NOT NULL DEFAULT false`, `has_child_bom BOOLEAN NOT NULL DEFAULT false`, `source_event_id` UUID NOT NULL, timestamps. Unique index `uq_bom_cost_rollup_line_no` on (rollup_id, path, line_no). Grants as in 1.1.
  - [x] 1.3 Create canonical `read/projections/bom_outbound_message.sql` cloning `read/projections/po_outbound_message.sql` byte-for-byte in structure: `message_id` UUID PK, `bom_id` UUID NOT NULL, `revision_id` UUID NOT NULL, `payload JSONB NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index `idx_bom_outbound_bom_id` on (bom_id). Grants as in 1.1. The file header must state the same boundary as `po_outbound_message.sql`: this is the INT-ERP-01 adapter boundary record, live transmission is per-deployment configuration and is NOT implemented here.
  - [x] 1.4 Add `supply_source` to `bom_line` additively: `ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_source TEXT` (NULLABLE, no default) plus CHECK `chk_bom_line_supply_source` in ('company','customer','job_worker') allowing NULL, wrapped in a guarded `DO $$` DROP-then-ADD block (the Story 3.9/5.4/5.5 constraint-swap pattern). The column MUST also be added inside the canonical `CREATE TABLE` body in `read/projections/bom_line.sql` so the schema-drift `extractCreateTable` comparison passes. NULL is legal because only `bom_type = 'job_work_kit'` BOMs carry supply-source tags; the not-null requirement for kit BOMs is enforced in the compliance seam, not by the column.
  - [x] 1.5 Widen `integration_exception.chk_integration_exception_record_type` in `read/projections/integration_exception.sql` from ('purchase_order','sales_order','sync_batch') to ('purchase_order','sales_order','sync_batch','bom') using the transactional guarded DROP-then-ADD block already present in that file. Do not touch `uq_integration_exception_open` (the one-open-row-per-grain contract carries over to BOM conflicts unchanged).
  - [x] 1.6 Register `bom_cost_rollup.sql`, `bom_cost_rollup_line.sql`, and `bom_outbound_message.sql` at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (never reorder existing entries). `bom_line.sql` and `integration_exception.sql` are already registered; only their contents change.
  - [x] 1.7 Mirror every change byte-for-byte into `deploy/compose/init-db.sql` (three new tables, the widened `bom_line` CREATE body plus its guarded constraint block, and the widened `integration_exception` record-type constraint in BOTH the CREATE body and the guarded block).
  - [x] 1.8 Add `EXPECTED` entries for `bom_cost_rollup`, `bom_cost_rollup_line`, `bom_outbound_message` in `test/unit/schema-drift.test.ts`, extend the `bom_line` entry for the new column and constraint, and extend the `integration_exception` entry for the widened CHECK. Add a Story 5.6 additive-column `it()` block mirroring the Story 5.5 block.
- [x] Task 2: Event schema and registry (AC: 1, 4, 5)
  - [x] 2.1 In `src/events/schema.ts` add three payload interfaces and `Omit<EventEnvelope, 'payload'>` envelope pairs under a Story 5.6 banner: `BomCostRollupSnapshottedPayload`/`Envelope` for `bom.cost_rollup_snapshotted`, `BomJobWorkKitTaggedPayload`/`Envelope` for `bom.job_work_kit_tagged`, `BomSyncConflictRaisedPayload`/`Envelope` for `bom.sync_conflict_raised`. The epics PascalCase names (`CostRollupSnapshotted`, `JobWorkKitTagged`, `BomSyncConflictRaised`) map to these dot-separated spine-convention types.
  - [x] 2.2 Payload contracts. `bom.cost_rollup_snapshotted` carries `rollup_id`, `bom_id`, `revision_id`, `rollup_date`, `rate_basis`, `total_cost` (decimal string), `line_count`, `missing_rate_count`, `depth_truncated`, and `lines` (the full per-line costed array, capture-time computed so replay is deterministic; same rule as `bom.exploded`). `bom.job_work_kit_tagged` carries `bom_id`, `revision_id`, and `tags: { bom_line_id, line_no, supply_source }[]` (REQUIRED, non-empty). `bom.sync_conflict_raised` carries `bom_id` (nullable when the inbound record names an unknown BOM), `source_record_ref` (the ERP-side identifier), `conflict_reason`, `exception_id` (read back from the `integration_exception` row the adapter already raised, NOT minted here), and `source_snapshot` (the rejected inbound payload verbatim).
  - [x] 2.3 Register all three in `SUPPORTED_EVENT_TYPES` appended at the TAIL of the registry: `streamType: 'engineering'`, `requiresBusinessStream: false` for all three (they act on already-tagged BOM aggregates; business stream is derived server-side from the BOM header, never accepted from the request body).
- [x] Task 3: Cost rollup service (AC: 1, 3)
  - [x] 3.1 Create `src/engineering/bom-cost-rollup.ts` exporting `rollUpBomCost(input: { bom_id: string; occurred_at?: string }, client?): Promise<CostRollupResult>`. Pure read-plus-compute like `explodeBomForExecution`: no HTTP, no event emission, no persistence, optional `PoolClient` so the release gate and the handler can both call it. Returns `{ rollup_id (minted UUIDv4), bom_id, revision_id, rollup_date, rate_basis, total_cost, line_count, missing_rate_count, depth_truncated, lines }`.
  - [x] 3.2 Guard sequence (fail-closed, exact order): `getBomById` (`BOM_NOT_FOUND` 404), `assertNotRdDraft(bom)` imported from `src/compliance/bom.ts` (`RD_EXECUTION_BARRED` 409 - a cost rollup is a release-gate input and R&D drafts can never be released), `current_revision_id` present else `INVALID_PARAMS` 409. CRITICAL DIFFERENCE FROM STORY 5.5: a rollup MUST run against `status = 'draft'` and `status = 'on_hold'` BOMs, because AC 3 makes it a precondition of release. Do NOT copy the `BOM_NOT_RELEASED` guard from `explodeBomForExecution`; rollups run on any non-R&D BOM in any lifecycle state.
  - [x] 3.3 Reuse the Story 5.5 downward walk shape: ONE `WITH RECURSIVE` CTE over `bom_line` joined to `bom`, starting at the current revision (released or draft), descending into components that are the `parent_item_id` of another non-R&D BOM whose current revision exists. All arithmetic in PostgreSQL NUMERIC (`::numeric` casts, never JS floats). `effective_quantity_per = parent_effective_quantity_per * base_quantity_per * (1 + COALESCE(scrap_percent,0)/100)`. Depth-capped at `config.bom.maxDepth` (`src/config/index.ts`, default 20, env `BOM_MAX_DEPTH`) reporting `depth_truncated: true` when the cap binds; cycle defense uses the `visited uuid[]` path predicate that `src/engineering/bom-explosion.ts` already uses (NOT the PG `CYCLE` clause; the Story 5.5 completion note explains why), throwing `BOM_COST_ROLLUP_CYCLE_DETECTED` 409.
  - [x] 3.4 Line semantics: only `output_class = 'component'` lines contribute cost. `co_product` and `by_product` lines are outputs and contribute nothing (no cost apportionment in Phase 1; C-10 keeps valuation in the ERP). Phantom lines pass through exactly as in explosion: the phantom itself is not a costed line, its children are costed with multiplied quantity and multiplicative scrap and `via_phantom = true`. Placeholder lines (`component_item_id IS NULL`) cannot exist on production or job-work-kit BOMs; skip them defensively and never cost them.
  - [x] 3.5 Rate sourcing (INT-ERP-01 inbound-only, binding): `unit_cost` comes from `item_master.standard_cost_amount` for the component item, and ONLY when `standard_cost_designation = 'ind_as_2_para_21_measurement_technique'` is present alongside it (the existing `chk_item_master_standard_cost_requires_designation` pairing). A component with no usable rate yields `unit_cost = NULL`, `extended_cost = 0`, `rate_missing = true`, and increments `missing_rate_count`. The rollup NEVER fails on a missing rate and NEVER writes a rate; rates are inbound-only reference data owned by INT-ERP-01. Set `rate_basis = 'item_master_standard_cost'` on every snapshot so a future rate source is distinguishable.
  - [x] 3.6 `extended_cost = effective_quantity_per * unit_cost` computed in SQL NUMERIC; `total_cost` is the SQL `SUM` of `extended_cost` over costed lines. Only leaf-level and non-phantom component lines contribute to `total_cost`; a line that has a child BOM contributes its own `extended_cost` ONLY when it has no costed children (it is then a purchased part), otherwise its children carry the cost. Flag each line with `has_child_bom` and exclude parent nodes from the sum to prevent double counting. Assert in tests that a two-level fixture totals exactly once. `rate_missing` is set on COSTED lines only, so `missing_rate_count` counts leaves; a parent node whose cost comes from its children is never counted as a missing rate, and a subtree whose leaves all lack rates surfaces through those leaves.
  - [x] 3.7 `rollup_date` is the IST calendar date of `occurred_at` (default now) using the `toIstCalendarDate` helper pattern already used by `src/compliance/eco.ts` and `src/engineering/bom-explosion.ts`. All costs leave the DB as exact decimal strings and stay strings end-to-end.
- [x] Task 4: Compliance seam for the three new events (AC: 1, 4, 5)
  - [x] 4.1 Create `src/compliance/bom-costing.ts` structurally cloning `src/compliance/bom-execution.ts`: `BOM_COSTING_EVENT_TYPES` set, `bomCostingEventType` gate, `assertBomCostingShape` (pre-transaction, no DB: UUID/decimal/date shape asserts, supply-source vocabulary, non-empty `tags` array, count/array-length agreement), `applyBomCostingProjection` (in-transaction switch over the three event types). Use the `reject(code, message, details?, status)` AppError helper pattern.
  - [x] 4.2 `applyBomCostRollupSnapshotted`: `alreadyPersisted` guard, `FOR UPDATE` lock the `bom` row (`BOM_NOT_FOUND` 404) with a post-lock idempotency re-check, `assertNotRdDraft`, require `bom.current_revision_id = payload.revision_id` (stale guard, `INVALID_PARAMS` 409), insert the `bom_cost_rollup` header and every `lines[]` row into `bom_cost_rollup_line` exactly as captured (the applier recomputes NOTHING), validate `line_count` equals the array length. Prior snapshots are never updated or deleted (AC 1).
  - [x] 4.3 `applyBomJobWorkKitTagged`: `alreadyPersisted` guard plus post-lock re-check, lock `bom`, require `bom_type = 'job_work_kit'` else `BOM_NOT_JOB_WORK_KIT` 409, require `status IN ('draft','on_hold')` else `IMMUTABLE_REVISION` 409 (a Released kit BOM's lines are immutable per the Story 5.2 rule; re-tagging requires an ECO), require `bom.current_revision_id = payload.revision_id`, then for each tag `UPDATE bom_line SET supply_source = $1, updated_at = now() WHERE bom_line_id = $2 AND revision_id = $3` and require exactly one row affected else `BOM_LINE_NOT_FOUND` 404 (the Story 5.3 cross-revision scoping rule).
  - [x] 4.4 `applyBomSyncConflictRaised`: `alreadyPersisted` guard, then `raiseException` from `src/read/projections/integration_exception.ts` with `record_type: 'bom'`, `source_system: 'ERP'`, `error_code: 'BOM_INBOUND_SYNC_REJECTED'`, `source_record_ref` from the payload, and the `source_snapshot` in `details`. The existing `ON CONFLICT` contract on `uq_integration_exception_open` refreshes the single open row rather than stacking duplicates, which makes this applier safe on the normal path (the adapter already raised the row moments earlier, so this call refreshes it) and correct on replay. IMPORTANT: this call is a convergence step, NOT the source of truth. The queue row is raised by the adapter and never depends on this event being persisted or replayed. This applier MUST NOT touch `bom`, `bom_revision`, or `bom_line` in any way; that is the whole point of AC 5.
  - [x] 4.5 Wire into `src/events/store.ts` at the two existing seams: `assertBomCostingShape(envelope);` in the pre-transaction assert block immediately after `assertBomExecutionShape`, and `await applyBomCostingProjection(envelope, client, eventId);` in the in-transaction block immediately after `applyBomExecutionProjection`. Add 23505 constraint mappings for `uq_bom_cost_rollup_source_event` and `uq_bom_cost_rollup_line_no` to `DUPLICATE_EVENT` 409 in the existing constraint mapper.
- [x] Task 5: Release gate un-staging (AC: 3)
  - [x] 5.1 In `src/compliance/bom.ts`, add the cost-rollup condition to `evaluateReleaseGate`: after the existing `approved_eco` check, evaluate `isCostRollupConditionMet(bomId, revisionId, client)` and push `'cost_rollup_complete'` onto `unmetConditions` when unmet. BINDING DEFINITION of "completed cost rollup", all three parts required: (a) at least one `bom_cost_rollup` row exists for the exact `(bom_id, revision_id)` being released, (b) that row has `missing_rate_count = 0`, and (c) the row is not STALE - its `created_at` is later than `MAX(bom_line.updated_at)` for that `revision_id`, so a line added or amended after the rollup invalidates it and forces a re-run. A snapshot with missing rates is a valid simulation but is NOT a completed rollup for gate purposes. Return the newest snapshot's `rollup_id`, `missing_rate_count`, and a `stale: true|false` flag in the reject details so the administrator can see which of the three parts failed.
  - [x] 5.2 Empty `STAGED_CONDITIONS` to `[]` in `src/compliance/bom.ts` (keep the exported constant and the surrounding comment, now recording that Story 5.6 flipped the last staged condition on) and keep emitting `staged_conditions` in the `RELEASE_GATE_UNMET` details so the response shape does not change for existing callers or tests. Update the `evaluateReleaseGate` doc comment.
  - [x] 5.3 In `src/read/projections/release_gate_checklist.ts`, replace the hard-coded `{ condition: 'cost_rollup_complete', met: null, enforced: false, blocking_lines: [] }` entry with a real evaluation: `met` is the boolean from the same predicate, `enforced: true`, `blocking_lines: []` (the condition is BOM-level, not line-level). `ready_to_release` must now account for it. Keep the condition's position in the `conditions` array unchanged.
  - [x] 5.4 REGRESSION RISK, read before implementing: `test/integration/story-5-2.test.ts` and `test/integration/story-5-3.test.ts` release BOMs successfully today with no rollup. Enforcing this condition breaks every one of those fixtures. The correct fix is to add a rollup step to those fixtures' release helpers, NOT to weaken the gate and NOT to edit their assertions. Read both suites fully, find every place a BOM reaches `released`, and thread a `POST /api/v1/boms/:bomId/cost-rollups` call plus active item masters carrying `standard_cost_amount` and the Ind AS designation into the shared setup. Story 5.4 and 5.5 fixtures that release BOMs need the same treatment. Report the exact list of touched fixtures in completion notes.
- [x] Task 6: Read projection accessors and the comparison computed read (AC: 1, 2)
  - [x] 6.1 Create `src/read/projections/bom_cost_rollup.ts`: `BomCostRollupRow` and `BomCostRollupLineRow` interfaces matching Tasks 1.1 and 1.2, `insertCostRollup`, `insertCostRollupLine`, `getCostRollupById(rollupId, client?)`, `getCostRollupLines(rollupId, client?)` ordered by path then line_no, `listCostRollupsByBom(bomId, { limit, offset }, client?)` with the clamped-limit pattern ordered by `rollup_date DESC, created_at DESC`, and `getLatestCompleteRollup(bomId, revisionId, client?)` returning the newest row with `missing_rate_count = 0` (the gate predicate's accessor). All with UUID regex guards and the `runner(client ?? getPool())` pattern.
  - [x] 6.2 Create `src/read/projections/bom_cost_rollup_comparison.ts` as a COMPUTED read (no table, the Story 5.3 `where_used_impact.ts` precedent): `compareCostRollups(baseRollupId, compareRollupId, client?): Promise<CostRollupComparison | null>`. It matches lines across the two snapshots by `(path, line_no)` and returns `{ base, compare, total_delta, line_deltas: [{ path, line_no, component_sku, status: 'added' | 'removed' | 'changed' | 'unchanged', base_extended_cost, compare_extended_cost, extended_cost_delta, base_effective_quantity_per, compare_effective_quantity_per, base_unit_cost, compare_unit_cost }] }`. All deltas computed in PostgreSQL NUMERIC and returned as decimal strings. AC 2 says "across versions or dates" per FR-B-15, so the two snapshots MAY belong to different revisions of the SAME BOM; reject a cross-BOM comparison with `COST_ROLLUP_COMPARE_INVALID` 400 and reject comparing a snapshot with itself with the same code.
  - [x] 6.3 Extend `src/read/projections/bom.ts`: add `supply_source: 'company' | 'customer' | 'job_worker' | null` to `BomLineRow`, add it to the `insertBomLine` column list (accepting NULL), and thread it through `getBomLines`. Add `insertBomOutboundMessage(messageId, bomId, revisionId, payload, client)` and `getBomOutboundMessage(bomId, client?)` mirroring `insertPoOutboundMessage`/`getPoOutboundMessage` in `src/read/projections/purchase_order.ts`, or place them in a new `src/read/projections/bom_outbound_message.ts` if `bom.ts` is already at its practical size; either location is acceptable, pick one and say which in completion notes.
- [x] Task 7: ERP outbound publication and inbound conflict rejection (AC: 5)
  - [x] 7.1 Create `src/adapters/erp/bom-outbound.ts` cloning the shape of `src/adapters/erp/po-outbound.ts`: `BomOutboundLinePayload`, `BomOutboundPayload`, and a pure `buildBomOutboundPayload(bom, revision, lines, occurredAt, correlationId)` that serialises the Released production BOM version (parent item, revision code, lifecycle state, and every line with component SKU, quantities as exact strings, scrap, supply method, and supply source). No transport, no network call; the file header must say live transmission is per-deployment configuration and out of scope, exactly as `po-outbound.ts` does.
  - [x] 7.2 In `src/compliance/bom.ts` `applyBomReleased`, after `updateBomStatus(..., 'released', ...)` succeeds, build the outbound payload and `insertBomOutboundMessage(randomUUID(), bom_id, revision_id, payload, client)` inside the SAME persistEvent transaction (the Story 4.4 `purchase_order.ts` precedent at the `indent.ordered` seam). Only `bom_type = 'production'` BOMs publish outbound (FR-B-17 says "Released production BOM versions"); `job_work_kit` releases record no outbound message. Do NOT emit a second domain event for the publication; the row is derived state written atomically with the release.
  - [x] 7.3 Extend `src/adapters/erp/sync.ts` with an inbound BOM rejection path. Add `boms?: SourceBomRecord[]` to `ErpSyncBatch`, where `SourceBomRecord` carries at minimum `{ bom_ref: string; parent_sku?: string; lines?: unknown[] }`. Add `boms?: { applied: number; failed: number; rejected: RejectedBomRecord[] }` to `ErpSyncResult`, where `RejectedBomRecord` is `{ bom_ref: string; bom_id: string | null; exception_id: string; conflict_reason: string; source_snapshot: unknown; newly_opened: boolean }`. Add `BOM_INBOUND_SYNC_REJECTED` to `ERP_ERROR_CODES`. Behaviour:
    - EVERY inbound BOM record is rejected unconditionally. `applied` is always 0; there is no comparison step, no "identical record" shortcut, and no code path that reads or writes `bom`, `bom_revision`, or `bom_line`.
    - Each record is processed inside its own SAVEPOINT per the existing per-record isolation contract, and calls `raiseException({ record_type: 'bom', source_system: 'ERP', error_code: ERP_ERROR_CODES.BOM_INBOUND_SYNC_REJECTED, source_record_ref: bom_ref, reason, details: { source_snapshot } })`. A rejection is a deliberate OUTCOME, not a failure: do NOT `ROLLBACK TO SAVEPOINT` on this path or the exception row you just wrote is discarded.
    - Carry `raiseException`'s boolean return into `RejectedBomRecord.newly_opened`. `true` means a NEW open row was inserted; `false` means an already-open row was refreshed. `raiseException` returns only that boolean, so read `exception_id` back with a scoped `SELECT exception_id FROM integration_exception WHERE source_system = 'ERP' AND record_type = 'bom' AND source_record_ref = $1 AND error_code = $2 AND status = 'open'` on the same client. Do NOT change `raiseException`'s signature; it is shared Story 2.9 code with existing callers that depend on the boolean.
    - The adapter does NOT call `persistEvent`. Its direct-SQL-only contract stands unchanged.
    - `bom_id` is resolved best-effort for the payload only (lookup by `bom_ref`, NULL when unknown); resolving it must not lock or touch the BOM row.
  - [x] 7.3a In `erpSyncTriggerHandler` (`src/api/v1/erp-projections.ts`), AFTER `runErpSync` returns and its transaction has committed, persist exactly one `bom.sync_conflict_raised` event for each rejected record whose `newly_opened === true`, using a random `idempotency_key` (never a key derived from the source record) and the standard engineering-stream envelope. Records with `newly_opened === false` persist NO event; the open exception is already refreshed and the administrator has already been told. The event carries `bom_id`, `source_record_ref`, `conflict_reason`, `exception_id`, and `source_snapshot` per the Task 2.2 payload contract. `applyBomSyncConflictRaised` (Task 4.4) must therefore be idempotent-and-harmless when the open row already exists: it re-raises through the same `raiseException` contract, which refreshes rather than stacks.
  - [x] 7.4 Add `GET /api/v1/erp/bom-sync-exceptions` returning the BOM Administrator queue via `listExceptions({ record_type: 'bom', status })` with the clamped-limit pattern, and `POST /api/v1/erp/bom-sync-exceptions/:exceptionId/resolve` calling the existing `resolveException`. RBAC `{ module: 'engineering', functionScope: 'read' }` for the list and `'write'` for the resolve (the BOM Administrator owns this queue per INT-ERP-01 and the roles table, not the procurement module).
  - [x] 7.5 Confirm and test that the existing `erpReadOnlyRejectHandler` family plus `assertErpReadOnly` still cover any direct ERP-shaped write attempt, and that no code path anywhere lets an inbound record reach `bom`, `bom_revision`, or `bom_line`. A test must assert that a full inbound BOM sync batch leaves all three tables byte-identical (row counts plus `updated_at` values unchanged).
- [x] Task 8: API handlers, routes, spine allowlist (AC: 1, 2, 4)
  - [x] 8.1 Create `src/api/v1/bom-costing.ts` with the handler skeleton from `src/api/v1/bom-execution.ts` (`actorContext`, `auditCtxFor`, envelope literal with `stream_type: 'engineering'`, `metadata.occurred_at: new Date().toISOString()`, `idempotency_key: (body.idempotency_key as string) ?? randomUUID()`, `persistEvent` in try/catch mapping `AppError` to `sendRequestError`, response built from `persisted.stream_id` never a locally minted id, durable read-back from the projection). Handlers: `runCostRollupBase` (POST, calls `rollUpBomCost` then persists `bom.cost_rollup_snapshotted` with the computed line set embedded, returns 201 with the snapshot read back from `bom_cost_rollup_line`), `listCostRollupsBase` (GET), `getCostRollupBase` (GET by id), `compareCostRollupsBase` (GET), `tagJobWorkKitBase` (POST).
  - [x] 8.2 `tagJobWorkKitBase` request contract: body carries `tags: [{ bom_line_id, supply_source }]`. The handler resolves `line_no` and `revision_id` server-side from the BOM header and the line rows (never from the body), rejects an unknown or cross-revision `bom_line_id` with `BOM_LINE_NOT_FOUND` 404 before persisting, rejects a `supply_source` outside the vocabulary with `INVALID_PARAMS` 400, and rejects a non-kit BOM with `BOM_NOT_JOB_WORK_KIT` 409. AC 4 requires EVERY line of a kit BOM to be tagged: when the request would leave any `output_class = 'component'` line of the current revision with `supply_source IS NULL`, the handler still accepts it (partial tagging is a legitimate authoring step) but the RELEASE path must reject it - add `supply_source_missing` to the `evaluateReleaseGate` unmet conditions for `bom_type = 'job_work_kit'` BOMs only, listing the untagged lines in `blocking_lines` shape. This is the enforcement point for AC 4; a tag-time-only check would let an untagged kit BOM release.
  - [x] 8.3 RBAC: wrap every handler in `requireRole({ module: 'engineering', functionScope: 'write' })` for mutations and `'read'` for GETs (no role-name literals anywhere; `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces). No site scoping (BOM is enterprise-scoped per the Story 5.4 binding decision).
  - [x] 8.4 Register the routes in `createAppRouter()` in `src/server.ts` in a Story 5.6 block after the Story 5.5 block, respecting the route-order rule (literal segments before `:param` routes; `src/api/router.ts` returns the FIRST registered match and `:bomId` compiles to `([^/]+)`). Order matters here: `GET /api/v1/bom-cost-rollups/compare` MUST be registered BEFORE `GET /api/v1/bom-cost-rollups/:rollupId`. Full set is in Table 2.
  - [x] 8.5 Append every new route to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` or the spine gate fails.
- [x] Task 9: Integration tests and gates (AC: 1, 2, 3, 4, 5)
  - [x] 9.1 Create `test/integration/story-5-6.test.ts` cloning the Story 5.5 harness verbatim (`makeRequest`, `authFor`, `provisionUser` with the SCIM bearer `test-only-scim-bearer-token-not-for-production-use`, admin-pool re-application of needed canonical SQL, `createAppServer(createAppRouter()).listen(0)`, TRUNCATE teardown extended with `bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, integration_exception`).
  - [x] 9.2 AC 1 tests: run a rollup on a two-level Draft BOM with rated item masters; assert the snapshot header and line rows persist with exact NUMERIC-string costs; run a SECOND rollup on the same BOM and assert BOTH snapshots survive with distinct `rollup_id` values and the first one's rows byte-unchanged; assert `rollup_date` is the IST calendar date; assert a component with no `standard_cost_amount` (or an amount with no Ind AS designation) yields `rate_missing = true`, `unit_cost = null`, `extended_cost = '0'`, and a `missing_rate_count` of exactly 1; assert scrap-adjusted quantity math and phantom pass-through match the Story 5.5 explosion fixtures' shape; assert no double counting on the two-level fixture (`total_cost` equals the hand-computed leaf sum).
  - [x] 9.3 AC 2 tests: take two snapshots with a changed component rate or quantity between them, then assert the comparison returns per-line deltas with the right `status` values (`changed`, `added`, `removed`, `unchanged`) and a `total_delta` that equals the sum of line deltas as an exact NUMERIC string; assert cross-BOM and self comparison both return 400 `COST_ROLLUP_COMPARE_INVALID`; assert a comparison across two DIFFERENT revisions of the same BOM succeeds (FR-B-15 "across versions").
  - [x] 9.4 AC 3 tests: attempt release of a Draft BOM with no rollup and assert 409 `RELEASE_GATE_UNMET` with `cost_rollup_complete` in `unmet_conditions`; attempt release after a rollup with `missing_rate_count > 0` and assert it is STILL blocked; run a complete rollup and assert release now succeeds; assert the STALENESS rule (run a complete rollup, then add or amend a line, then attempt release and assert it is blocked again with `stale: true` in details, and that a fresh rollup unblocks it); assert `GET` release-gate checklist reports the condition with `enforced: true` and the right `met` value in both states; assert the on-hold reinstatement path still skips the gate (existing behaviour, must not regress).
  - [x] 9.5 AC 4 tests: create a `job_work_kit` BOM, tag its lines company/customer/job_worker, assert `bom_line.supply_source` persists per line and appears in the line read model; assert an invalid vocabulary value returns 400 `INVALID_PARAMS`; assert tagging a `production` BOM returns 409 `BOM_NOT_JOB_WORK_KIT`; assert releasing a kit BOM with any untagged component line returns 409 `RELEASE_GATE_UNMET` with `supply_source_missing` and the untagged lines listed; assert a production BOM release is unaffected by the kit-only condition.
  - [x] 9.6 AC 5 tests. Inbound rejection and non-mutation:
    - Post an inbound ERP sync batch carrying a BOM record for an EXISTING BOM with different structure; assert the response reports `boms: { applied: 0, failed: 1 }`; assert an `integration_exception` row exists with `record_type = 'bom'`, `error_code = 'BOM_INBOUND_SYNC_REJECTED'`, `status = 'open'` and the source snapshot in `details`; assert `bom`, `bom_revision`, and `bom_line` are byte-identical before and after (row counts plus every `updated_at`).
    - Post a batch naming an UNKNOWN BOM reference and assert it is rejected the same way with `bom_id` NULL, no row created anywhere in the BOM family.
    - THE DEDUPE TEST (poll-storm case): post the SAME batch three times in a row. Assert exactly ONE open `integration_exception` row survives with a REFRESHED `raised_at` (later than the first), and assert exactly ONE `bom.sync_conflict_raised` row exists in `domain_events` for that `source_record_ref`. A second or third event here means the `newly_opened` gate was not applied.
    - THE REOPEN TEST (post-resolution recurrence): resolve the exception through the resolve route, then post the SAME batch a fourth time. Assert a NEW open exception row exists (the partial unique index is `WHERE status = 'open'`, so the resolved row does not block it) AND that a SECOND `bom.sync_conflict_raised` event was persisted. A suppressed second event here means a deterministic `idempotency_key` crept in; the correct pairing is a random key gated on `newly_opened`.
    - Assert `GET /api/v1/erp/bom-sync-exceptions` lists the open row and that the resolve route closes it.
    - Outbound: assert releasing a production BOM writes exactly one `bom_outbound_message` row with the expected payload shape, and that releasing a `job_work_kit` BOM writes none.
  - [x] 9.7 Platform-gate tests: direct `POST /api/v1/events` with a WELL-FORMED envelope for each of the three new event types returns 400 `INVALID_EVENT_STREAM`; RBAC `FUNCTION_ACCESS_DENIED` for a non-engineering module user on every new route; idempotent replay with the same `idempotency_key` returns the original snapshot (body equality) and persists exactly one `bom_cost_rollup` row.
  - [x] 9.8 Run full gates: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test`, `npm run spine-acceptance-contract` 6/6, schema-drift suite green with the new entries, story-5-1 through story-5-5 regression suites green (fixture setup may be extended per Task 5.4; assertions must NOT be weakened), edge typecheck/lint/build/test unchanged at 30/30, `git diff --check` clean, then `graphify update .`. Baseline at f29765f is 15 pre-existing failures in the full suite (14 idempotency-replay failures across Epic 1 to 3 plus one `story-5-3` where-used assertion); confirm ZERO new failures and do not fix the baseline.

## Dev Notes

### Binding Scope Decisions

- This story closes Epic 5. It is the LAST consumer of the Story 5.2 staged-release-gate mechanism: after Task 5, `STAGED_CONDITIONS` is empty and every FR-B-06 condition is enforced.
- Three events only, matching the epics Dev Notes contract: `bom.cost_rollup_snapshotted`, `bom.job_work_kit_tagged`, `bom.sync_conflict_raised`. All `streamType: 'engineering'`, `requiresBusinessStream: false`.
- New canonical tables: `bom_cost_rollup`, `bom_cost_rollup_line`, `bom_outbound_message`. New additive column: `bom_line.supply_source`. One widened CHECK: `integration_exception.record_type` gains `'bom'`. No other schema changes.
- Cost rollups are SIMULATIONS (C-10, FR-B-15 boundary in the epics Dev Notes). This story writes no valuation posting, no `inventory_valuation` row, no `item_master.standard_cost_amount` value, and no ERP cost record. Rates are inbound-only reference data per INT-ERP-01.
- Rollups run on Draft and On Hold BOMs by design (they gate release). This is the single most important behavioural difference from Story 5.5's explosion service, which requires `status = 'released'`. Do not copy that guard.
- The comparison read is COMPUTED, not stored. There is no `bom_cost_rollup_comparison` table; the Story 5.3 `where_used_impact.ts` precedent governs.
- Job-work kit tagging in this story is line TAGGING only. The FR-B-16 dispatch kit list, expected-return quantities, and sent-versus-consumed-versus-returned reconciliation are Epic 9 (Story 9.3) per the epics Dev Notes; do not build them.
- ERP sync is OUTBOUND-ONLY for BOM structure. Inbound BOM records are rejected unconditionally and always produce an exception; there is no merge, no last-write-wins, and no partial application (INT-ERP-01 explicitly forbids last-write-wins).
- Adapter persistence rule (RESOLVED, binding, do not re-litigate). `assertErpReadOnly` (`src/events/store.ts:524`) rejects ONLY `stream_type: 'erp'` and `erp.*` event types, so an `engineering`-stream `bom.sync_conflict_raised` is not blocked and never was. The constraint that actually governs is different and stricter: the exception QUEUE is authoritative and the event is a derived audit fact, never the reverse. Three consequences, all binding:
  - `src/adapters/erp/sync.ts` keeps its direct-SQL-only contract. It calls `raiseException` for the queue row and does NOT call `persistEvent`. The event is persisted by the trigger handler AFTER the batch commits, from the rejected-record list the adapter returns.
  - The event is emitted only when `raiseException` returns `true` (its `RETURNING (xmax = 0) AS inserted` discriminator, meaning a NEW open row was actually inserted). This is the exact mechanism `raiseErpSyncStale` already uses for its one-time alert. It gives correct behaviour in both directions: a polling ERP that re-sends the same unresolved conflict every cycle produces ONE event, and a conflict that recurs after an administrator resolves the exception produces a NEW open row and therefore a NEW event.
  - Do NOT make the event's `idempotency_key` deterministic from the source record. A deterministic key deduplicates the post-resolution re-raise, and if any exception-raising logic ever moves into the applier, the queue would then go silent on a live unresolved conflict. Random key plus the `inserted` gate is the correct pairing.
  - Accepted tradeoff, document it in completion notes rather than "fixing" it: a crash between the batch commit and the event write leaves an exception row with no event. The queue survives, the administrator still sees the conflict, and the next poll re-raises. Moving `persistEvent` back inside the adapter transaction to close this window is explicitly rejected, because the per-record SAVEPOINT would then be able to discard a deliberate rejection.
- No notifications (AD-17 fires only for routed decisions). No edge capture screens. No new dependencies, no PostgreSQL extensions, no web framework.
- There is NO user-facing screen in this story: central-plane desk workflow (REST API) only. No UX contract document exists for this domain.
- ESM rules unchanged: `.js` extensions on relative imports, `node:` prefixed builtins.

### Story 5.5 Handoff Contract (must consume, never re-derive)

- Import `assertNotRdDraft` and `isReleasedItemMaster` from `src/compliance/bom.ts`. Never re-derive either predicate with ad-hoc SQL.
- The downward recursive walk in `src/engineering/bom-explosion.ts` is the reference implementation for Task 3.3: same CTE shape, same NUMERIC discipline, same `visited uuid[]` cycle predicate, same `config.bom.maxDepth` cap and `depth_truncated` reporting semantics (truncation is reported only when a row sitting at the cap still had somewhere to descend). Read that file before writing the rollup CTE. Extracting a shared walk helper is OPTIONAL and only worth doing if it does not change explosion behaviour; if in doubt, write a second CTE and keep 5.5 untouched.
- `bom_line.supply_method` (Story 5.5) and `bom_line.supply_source` (this story) are DIFFERENT axes. `supply_method` is how execution consumes a component (`directed_issue` or `backflush`, FR-B-07). `supply_source` is who owns the material on a kit BOM (`company`, `customer`, `job_worker`, FR-B-16). Never conflate them, never derive one from the other.
- Story 5.5's `bom.exploded` capture-time-computation rule applies verbatim to `bom.cost_rollup_snapshotted`: the service computes, the payload carries, the applier persists verbatim and recomputes nothing, so replay is byte-deterministic.

### Event Contract

Table 1 defines the three new events. All are appended at the tail of `SUPPORTED_EVENT_TYPES`; payload and envelope interfaces follow the exact `Omit<EventEnvelope, 'payload'>` pair pattern already used by the Story 5.5 block.

Table 1: New event registry entries for Story 5.6

| event_type | streamType | requiresBusinessStream | stream_id | Payload-minted capture-time IDs |
| --- | --- | --- | --- | --- |
| `bom.cost_rollup_snapshotted` | `engineering` | `false` | `bom_id` | `rollup_id`, full `lines` array |
| `bom.job_work_kit_tagged` | `engineering` | `false` | `bom_id` | none (tags reference existing `bom_line_id` values) |
| `bom.sync_conflict_raised` | `engineering` | `false` | `bom_id` | `exception_id` |

- Every envelope MUST stamp `metadata.occurred_at` (omitting it crashes `persistEvent` with a 500) and use `idempotency_key: (body.idempotency_key as string) ?? randomUUID()` in handlers.
- Shape asserts run PRE-transaction so a malformed event never consumes an idempotency key; appliers run IN the persist transaction and begin with the `alreadyPersisted` guard plus a post-lock re-check for concurrent same-key retries.
- Handlers use `persisted.stream_id`, never a locally minted UUID, when building responses (Story 5.2 phantom-success lesson).

### Database Schema Contract

- Canonical SQL lives in `read/projections/` at REPO ROOT (not under `src/`); TS accessors live in `src/read/projections/`. Every file is idempotent, self-granting, and mirrored byte-for-byte into `deploy/compose/init-db.sql`; the schema-drift test enforces CREATE-body equality, guarded constraint-block equality, index presence, and grants. CHECK constraint swaps use transactional `DO $$` DROP-then-ADD blocks; additive columns go into BOTH the `ADD COLUMN IF NOT EXISTS` statement and the CREATE TABLE body.
- NUMERIC discipline (binding, recurring review defect if violated): costs, quantities, percents, and deltas travel as exact decimal strings end-to-end; ALL arithmetic happens in PostgreSQL NUMERIC (`$n::numeric` casts), never JS floats; PostgreSQL 18 silently rounds excess scale, so reject oversized scale before storage; equality is `$1::numeric = $2::numeric` (the `numericEqual` idiom); string validators must reject hex and scientific junk; `limit`/`offset` get the `\d+` guard plus clamp plus echo-clamped-value pattern.
- `total_cost`, `extended_cost`, and `effective_quantity_per` are UNBOUNDED `NUMERIC`: multi-level quantity-times-rate products exceed (18,6) scale, and unbounded storage avoids silent rounding entirely. `unit_cost` stays `NUMERIC(18,6)` because it mirrors `item_master.standard_cost_amount` exactly.
- The full `bom_line` column contract is `BomLineRow` in `src/read/projections/bom.ts`: `component_item_id` and `component_sku` are NULLABLE (Story 5.4 placeholders) and every new query touching them must be NULL-safe. `supply_source` joins this list via Task 1.4 and is also NULLABLE.
- `integration_exception` already carries the one-open-row-per-grain contract via `uq_integration_exception_open` with `NULLS NOT DISTINCT` plus `ON CONFLICT ... DO UPDATE`. Reuse it; do not add a second exception table.

### Cost Rollup Service Contract

- Exported surface: `rollUpBomCost(input, client?)` from `src/engineering/bom-cost-rollup.ts`, returning `{ rollup_id, bom_id, revision_id, rollup_date, rate_basis, total_cost, line_count, missing_rate_count, depth_truncated, lines }`. Pure read-plus-compute: no persistEvent, no HTTP, no side effects, optional `PoolClient` so the release gate can call it inside its own transaction if a future story wants an auto-rollup.
- One recursive CTE, NUMERIC math in SQL, depth cap `config.bom.maxDepth` with `depth_truncated` reporting, `visited uuid[]` cycle defense throwing `BOM_COST_ROLLUP_CYCLE_DETECTED` 409.
- Costed lines: `output_class = 'component'` only; phantoms pass through (children costed, phantom itself not costed, `via_phantom = true`); scrap-adjusted quantity per FR-B-15 ("applying per-line scrap percentages"); `unit_cost` from `item_master.standard_cost_amount` gated on the Ind AS designation; missing rates recorded not rejected.
- Double-counting defense: a line that has costed children contributes zero to `total_cost` itself. Only leaves carry cost. This is the single most likely arithmetic defect in the story; the two-level fixture test in Task 9.2 exists specifically to catch it.

### Release Gate Contract

Table 2 shows the FR-B-06 gate conditions before and after this story. The `cost_rollup_complete` row is the change; `supply_source_missing` is new and kit-only.

Table 2: FR-B-06 release gate conditions after Story 5.6

| Condition | Introduced by | Enforced before 5.6 | Enforced after 5.6 | Applies to |
| --- | --- | --- | --- | --- |
| `bom_lines_present` | Story 5.1 | yes | yes | all non-R&D BOMs |
| `component_item_masters_released` | Story 5.2 | yes | yes | all non-R&D BOMs |
| `scrap_percent_missing` | Story 5.2 | yes | yes | all non-R&D BOMs |
| `approved_eco` | Story 5.3 | yes | yes | all non-R&D BOMs, first release exempt |
| `cost_rollup_complete` | Story 5.2 (staged), enforced by Story 5.6 | no | yes | all non-R&D BOMs |
| `supply_source_missing` | Story 5.6 | not present | yes | `bom_type = 'job_work_kit'` only |

- "Completed cost rollup" means: a `bom_cost_rollup` row exists for the exact `(bom_id, revision_id)` being released, with `missing_rate_count = 0`, and created AFTER the newest `bom_line.updated_at` on that revision. Rollups against a superseded revision do not satisfy the gate, and neither does a rollup that predates a line edit.
- The gate change is enforced in `evaluateReleaseGate` (`src/compliance/bom.ts`) and REFLECTED in `getReleaseGateChecklist` (`src/read/projections/release_gate_checklist.ts`). Both must agree; a test must assert they agree for the same BOM in both met and unmet states.
- The `on_hold` reinstatement path deliberately skips the full gate (the revision already passed it and immutability guarantees it is unchanged). Do not extend the gate to that path.

### API Contract

Table 3 lists the new routes. All are under `/api/v1/`, SSO-gated, module `engineering` RBAC, enterprise-scoped (no site filter), and logged to the edit log via `persistEvent`'s audit entry with `trace_id`.

Table 3: New REST routes for Story 5.6

| Method and path | Handler | RBAC scope | Success |
| --- | --- | --- | --- |
| `POST /api/v1/boms/:bomId/cost-rollups` | runCostRollup | engineering write | 201 |
| `GET /api/v1/boms/:bomId/cost-rollups` | listCostRollups | engineering read | 200 |
| `GET /api/v1/bom-cost-rollups/compare` | compareCostRollups (query `base`, `compare`) | engineering read | 200 |
| `GET /api/v1/bom-cost-rollups/:rollupId` | getCostRollup | engineering read | 200 |
| `POST /api/v1/boms/:bomId/job-work-kit-tags` | tagJobWorkKit | engineering write | 201 |
| `GET /api/v1/erp/bom-sync-exceptions` | listBomSyncExceptions | engineering read | 200 |
| `POST /api/v1/erp/bom-sync-exceptions/:exceptionId/resolve` | resolveBomSyncException | engineering write | 200 |

- Route-order trap: `/api/v1/bom-cost-rollups/compare` MUST be registered before `/api/v1/bom-cost-rollups/:rollupId`. `src/api/router.ts` returns the FIRST registered match and `:rollupId` compiles to `([^/]+)`, which would otherwise swallow the literal. The existing `/api/v1/boms/migration-exceptions` registration at `src/server.ts` carries the same comment and is the precedent to follow.
- The error envelope is always `{ error_code, message, details, trace_id }` via `sendRequestError`/`AppError`.

### Error Code Contract

Table 4 lists new and reused codes. New codes are module-local (consistent with every BOM/ECO/RD code shipped so far); none is on the architecture spine stable-code list and none is edge-reachable, so `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json` are NOT modified.

Table 4: Error codes for Story 5.6

| error_code | HTTP | Thrown when |
| --- | --- | --- |
| `COST_ROLLUP_NOT_FOUND` (new) | 404 | unknown `rollup_id` on get or compare |
| `COST_ROLLUP_COMPARE_INVALID` (new) | 400 | comparing a snapshot with itself, or snapshots belonging to different BOMs |
| `BOM_COST_ROLLUP_CYCLE_DETECTED` (new) | 409 | rollup walk encounters a cycle (walk defense only) |
| `BOM_NOT_JOB_WORK_KIT` (new) | 409 | supply-source tagging attempted on a non-kit BOM |
| `BOM_INBOUND_SYNC_REJECTED` (new, exception `error_code` not an HTTP error) | n/a | recorded on every `integration_exception` row raised by an inbound BOM record |
| `RELEASE_GATE_UNMET` | 409 | release with an incomplete rollup, or a kit BOM with untagged lines |
| `BOM_NOT_FOUND` | 404 | unknown `bom_id` |
| `BOM_LINE_NOT_FOUND` | 404 | unknown or cross-revision `bom_line_id` in a tag request |
| `IMMUTABLE_REVISION` | 409 | tagging attempted on a Released kit BOM revision |
| `RD_EXECUTION_BARRED` | 409 | rollup or tagging attempted against an R&D draft BOM |
| `INVALID_PARAMS` | 400 | shape failures not covered by a specific code (bad `supply_source`, stale revision, count mismatch) |
| `DUPLICATE_EVENT` | 409 | idempotency and 23505 constraint replay per BOM-module convention |
| `INVALID_EVENT_STREAM` | 400 | direct `POST /api/v1/events` for the engineering stream (existing guard, test it) |
| `FUNCTION_ACCESS_DENIED` | 403 | wrong module RBAC scope (existing middleware) |

### Architecture Compliance

- AD-4 (BOM system of record): this story is the direct implementation of that decision. Structure publishes outbound; nothing structural is ever accepted inbound.
- AD-16 (idempotency): every mutation carries an `idempotency_key`; `persistEvent` deduplicates and returns the existing event on a key hit; always build responses from `persisted.stream_id`.
- FR-AC-01 (business-stream tagging): engineering events carry `requiresBusinessStream: false`; the BOM aggregate was tagged at `bom.drafted` and the stream is derived server-side.
- FR-AC-13 (edit log): every rollup, tag, release, and exception resolution writes an audit entry through `persistEvent`'s `logAuditEntry` with `auditCtxFor(req, actor, status)`.
- C-10 and the FR-B-15 boundary: rollups are simulations. No valuation posting, no standard-cost setting, no Ind AS treatment originates here.
- INT-ERP-01: split by data domain. BOM structure, revisions, and lifecycle state publish outbound. Item cost rates and financial item attributes flow inbound. Conflicts raise an exception for the BOM Administrator. Last-write-wins is explicitly not permitted.
- Conventions: singular entity names; dot-separated past-tense event types; UUIDv4 internal IDs; UTC timestamps with IST `business_date`/`rollup_date`; REST under `/api/v1/`; uniform error envelope.

### Testing Requirements

- One new suite: `test/integration/story-5-6.test.ts` using `node:test` + `node:assert/strict` against real PostgreSQL per `.env.test` (the team's container publishes on host port 5442 while `.env.test` names 5432; `deferred-work.md` line 133 is still open, use whatever the committed harness uses and do not "fix" it).
- Assert error BODIES (`error_code` plus `details`), never status codes alone. Re-fetch durable state with `getPool().query(...)` rather than trusting response bodies alone.
- NUMERIC assertions compare through PostgreSQL (`$1::numeric = $2::numeric`) plus a `typeof === 'string'` guard, never `parseFloat`, and never hard-code PostgreSQL's division-scale output.
- TRUNCATE every Story 5.6 table plus the BOM family, `integration_exception`, and the DOA/users tables in `after()` with `RESTART IDENTITY CASCADE`.
- Regression: story-5-1 through story-5-5 suites must stay green. Task 5.4 permits extending their FIXTURE SETUP to satisfy the newly enforced gate; it does NOT permit editing their assertions or weakening the gate. Every fixture change must be listed in completion notes.
- Gates: build, lint, format:check, `db:migrate` twice (idempotent), spine acceptance contract 6/6, schema-drift green with the new EXPECTED entries, edge typecheck/lint/build/test unchanged at 30/30, `git diff --check` clean, `graphify update .` after code changes.

### Anti-Pattern Prevention (repeat-defect list from the 5.1 to 5.5 reviews)

- Do NOT use JS float arithmetic anywhere near costs or quantities; NUMERIC in SQL only. This is the single most-patched defect class across the last four reviews and this story is entirely arithmetic.
- Do NOT double count multi-level cost. A parent line with costed children contributes zero itself.
- Do NOT copy the `BOM_NOT_RELEASED` guard from the explosion service into the rollup service. Rollups must run on Draft BOMs or AC 3 is unreachable.
- Do NOT weaken or bypass the release gate to make older suites pass. Extend their fixtures (Task 5.4).
- Do NOT let the inbound ERP path write to `bom`, `bom_revision`, or `bom_line` under any condition, including "the records look identical". AC 5 is unconditional.
- Do NOT give `bom.sync_conflict_raised` a deterministic `idempotency_key`. It suppresses the post-resolution re-raise and can silence a live conflict. Random key, gated on `raiseException`'s `newly_opened` boolean.
- Do NOT `ROLLBACK TO SAVEPOINT` on an inbound BOM rejection. The rejection IS the outcome; rolling back discards the exception row.
- Do NOT move `persistEvent` inside `runErpSync` to close the commit-then-emit crash window. That window is an accepted tradeoff; the SAVEPOINT would otherwise be able to discard a deliberate rejection.
- Do NOT change `raiseException`'s signature to return the exception id. It is shared Story 2.9 code with callers depending on the boolean; read the id back with a scoped SELECT.
- Do NOT omit `assertValidOccurredAt`-style validity checks on `occurred_at`; malformed-but-regex-valid ISO dates throw uncaught RangeError 500s.
- Do NOT ignore `persistEvent`'s returned existing event on idempotency replay; never respond with a locally minted UUID.
- Do NOT add post-lock work without an `alreadyPersisted` re-check after acquiring `FOR UPDATE` locks.
- Do NOT let optional-typed payload fields hide hard requirements; if the shape assert requires a field, type it REQUIRED.
- Do NOT register literal collection routes after `:param` routes (the `compare` route specifically).
- Do NOT populate or read `bom_structure` (never populated, Story 5.1 debt).
- Do NOT implement authoring-time cycle detection (`BOM_CYCLE_DETECTED`) or the `bom_line.amended` effectivity re-check; both remain documented 5.1 debt.
- Do NOT fix the open 5.5 deferral (ECO add-lines cannot express `supply_method`). If the same gap appears for `supply_source` on `eco_change_line`, record it as a NEW deferral rather than widening this story into a 5.3 schema change.
- Do NOT widen scope into Epic 9 (job-work reconciliation, dispatch kit lists, expected-return quantities) or Epic 6 (production orders).
- Do NOT add notifications, edge capture screens, PowerSync buckets, or any `edge/**` change. Cost rollups and sync exceptions are central-plane only.
- Do NOT add a site_id or plant column to any BOM table (enterprise-scoped binding decision).

### Previous Story Intelligence

- Story 5.5 (done 2026-08-14, baseline 21a3235 with review patches): delivered `explodeBomForExecution`, the `visited uuid[]` cycle predicate, the capture-time-computed-payload rule, unbounded NUMERIC columns for products that overflow (18,6), and `bom_line.supply_method`. Its review applied 18 patches; the recurring themes were DATE timezone-shift bugs in IST conversion, capture-time versus apply-time ID minting, scope-marker columns for replication, and window-aware uniqueness predicates. All four have analogues in this story: `rollup_date` is a DATE derived from a timestamp, `rollup_id` is capture-minted, and the gate predicate is revision-scoped.
- Story 5.4 (done): `assertNotRdDraft`, the advisory-lock TOCTOU pattern, placeholder columns requiring NULL-safe queries, and the per-unit-versus-total quantity semantics decision that this story's `effective_quantity_per` follows (per one parent unit, not per order quantity).
- Story 5.3 (done): computed-read precedent (`where_used_impact.ts`, `release_gate_checklist.ts`) that the comparison read follows, the depth-capped recursive CTE, and the cross-revision scoping rule (line lookups ALWAYS scoped by `revision_id`).
- Story 5.2 (done): the staged release-gate mechanism this story retires, `IMMUTABLE_REVISION`, the 23505-to-`DUPLICATE_EVENT` mapper, the engineering-stream direct-event guard in `src/api/v1/events.ts`, and the route-order trap.
- Story 4.4 (done): `po_outbound_message` plus `buildPoOutboundPayload`, the exact adapter-boundary pattern Task 7.1 and 7.2 clone. The outbound row is derived state written atomically inside the business transaction, and live transmission is explicitly out of scope.
- Story 2.9 (done): `runErpSync`, per-record SAVEPOINT isolation, `integration_exception` with the one-open-row-per-grain contract, and the direct-SQL-upsert rule that keeps the ERP adapter out of `persistEvent`. Task 7.3 extends it rather than building a parallel path.

### Git Intelligence

Recent commits at story creation (newest first): f29765f `feat: add integration tests for BOM explosion and approved alternates` (the Story 5.5 test landing), 21a3235 and 0969401 (Story 5.4 and 5.5 refactor and formatting passes), 25084ab (Story 5.3 implementation baseline), af39b5e `feat(bom)` (the 5.1/5.2 foundation). The working tree is clean at f29765f. The established rhythm is a feature commit followed by a formatting/refactor commit, with integration tests landing alongside or immediately after the implementation. Start from current HEAD after confirming a clean gate run, and record the baseline commit in completion notes.

### Project Structure Notes

- New files: `read/projections/bom_cost_rollup.sql`, `read/projections/bom_cost_rollup_line.sql`, `read/projections/bom_outbound_message.sql`, `src/engineering/bom-cost-rollup.ts`, `src/compliance/bom-costing.ts`, `src/read/projections/bom_cost_rollup.ts`, `src/read/projections/bom_cost_rollup_comparison.ts`, `src/adapters/erp/bom-outbound.ts`, `src/api/v1/bom-costing.ts`, `test/integration/story-5-6.test.ts`.
- Modified files: `read/projections/bom_line.sql`, `read/projections/integration_exception.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/compliance/bom.ts`, `src/read/projections/bom.ts`, `src/read/projections/release_gate_checklist.ts`, `src/adapters/erp/sync.ts`, `src/api/v1/erp-projections.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, the story-5-2 through story-5-5 integration suites (fixture setup only), `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- Canonical SQL at repo root `read/projections/`, TS accessors under `src/read/projections/` (two parallel trees, same names). The `src/engineering/` folder was created by Story 5.5 and holds the pure domain services. No conflicts with the unified structure detected.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 5.6] (lines 1917-1952, acceptance criteria, event names, and the Epic 9 boundary note)
- [Source: PLANNING/archive/SCM-Requirements-Document.md#FR-B-06, FR-B-15, FR-B-16, FR-B-17, INT-ERP-01, C-10, A-11] (lines 189, 198-200, 505, 565, 660, 678)
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-4, AD-16, Consistency Conventions, Event Envelope]
- [Source: _bmad-output/implementation-artifacts/5-5-approved-alternates-and-bom-explosion.md#Dev Notes] (explosion service contract, NUMERIC discipline, capture-time computation, cycle-defense rationale)
- [Source: _bmad-output/implementation-artifacts/5-2-bom-lifecycle-and-immutability.md#Dev Notes] (staged release-gate conditions, immutability, route-order trap)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] (open entries: 5.5 ECO `supply_method` gap, correlation_id validation, global idempotency-key reuse, partial-migration window, DB_PORT; none are resolved by this story)
- [Source: src/compliance/bom.ts#evaluateReleaseGate, STAGED_CONDITIONS, applyBomReleased, assertNotRdDraft, isReleasedItemMaster]
- [Source: src/read/projections/release_gate_checklist.ts#getReleaseGateChecklist] (the staged `cost_rollup_complete` entry this story replaces)
- [Source: src/engineering/bom-explosion.ts] (recursive walk, cycle predicate, depth cap - the reference implementation for the rollup CTE)
- [Source: src/adapters/erp/po-outbound.ts, src/compliance/purchase-order.ts, read/projections/po_outbound_message.sql] (the outbound adapter-boundary pattern)
- [Source: src/adapters/erp/sync.ts, read/projections/integration_exception.sql, src/read/projections/integration_exception.ts] (inbound isolation, exception queue, one-open-row-per-grain contract)
- [Source: read/projections/item_master.sql] (`standard_cost_amount` plus `standard_cost_designation` pairing constraints - the only permitted rate source)

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), dev-story workflow, baseline commit f29765f.

### Debug Log References

- `npm run build`, `npm run lint`, `npm run format:check` - all clean.
- `npm run db:migrate` re-run twice cleanly (idempotent) with the three new canonical files at the
  tail of `MIGRATIONS`.
- `npm test`: 879 tests, 864 pass, 15 fail. All 15 are the documented pre-existing failures at
  baseline f29765f (14 idempotency-replay 201-vs-409 failures across Epic 1 to 3 plus one
  `story-5-3` where-used assertion). Zero new failures.
- `test/integration/story-5-6.test.ts`: 24/24. `story-5-1` through `story-5-5`: green apart from the
  one documented `story-5-3` where-used failure.
- Spine acceptance contract 6/6; schema-drift 80/80 (+4 entries and one new Story 5.6 block).
- Edge workspace typecheck, lint, build clean; `npm run edge:test` 30/30 unchanged (no `edge/**`
  file was touched).
- `git diff --check` clean; `graphify update .` run after the code changes.

### Completion Notes List

Binding decisions taken during implementation, each recorded because a reviewer will otherwise
re-litigate it:

1. **Walk descent targets RELEASED child BOMs only.** The story's Task 3.3 wording ("another
   non-R&D BOM whose current revision exists") was tightened to match the Story 5.5 explosion walk
   exactly: descent requires `bom.status = 'released'` and a released `current_revision_id`. The
   BOM at the TOP of the walk is still allowed to be draft or on_hold, which is what makes AC 3
   reachable. Two reasons: a released sub-assembly is the authoritative structure to cost through,
   and without this a self-referential DRAFT BOM (its own parent item on its own line) trips the
   cycle guard on its very first release, which broke the legitimate `story-5-3` self-reference
   fixture. A component whose only child BOM is still a draft is costed as a purchased part from
   its own rate, or recorded `rate_missing`.
2. **Double-counting defense is descendant-based, not direct-child-based.** A costed line
   contributes to `total_cost` only when no other costed line's path is beneath it. Descendant
   matching (rather than immediate children) is what stops a phantom in the middle of a chain from
   stranding the cost of the subtree under it. `rate_missing` and a non-null `unit_cost` are
   likewise leaf-only properties, so a parent node carrying its own rate can never inflate the
   total and is never counted as a missing rate.
3. **`total_cost` is summed in PostgreSQL NUMERIC**, via
   `SUM(v::numeric) FROM unnest($1::text[])` over the contributing line costs, rather than in JS.
   Every other arithmetic operation happens inside the walk CTE.
4. **Staleness boundary is pinned before the gate's own writes.** `evaluateReleaseGate` re-stamps
   `bom_line.blocking_release`, which bumps `updated_at`. `MAX(bom_line.updated_at)` is therefore
   captured at the top of the gate and passed into `evaluateCostRollupCondition`, so a rollup taken
   moments earlier is never reported stale because the gate itself touched a row.
5. **The gate predicate prefers a QUALIFYING snapshot and falls back to the newest.** One query
   orders by "complete and fresh" first, so the reject details always name a real snapshot and tell
   the administrator which of the three parts (exists / no missing rates / not stale) failed.
6. **`supply_source_missing` is a new kit-only gate condition**, not a tag-time check. Partial
   tagging is a legitimate authoring step and the handler accepts it; release is the enforcement
   point for AC 4. It is emitted in both `evaluateReleaseGate` and `getReleaseGateChecklist`, which
   are asserted to agree.
7. **`STAGED_CONDITIONS` is now an empty array**, with the constant and its emission in the
   `RELEASE_GATE_UNMET` details preserved so the response shape is unchanged for existing callers.
8. **Outbound accessors live in a new `src/read/projections/bom_outbound_message.ts`** rather than
   in `bom.ts` (Task 6.3 permitted either; `bom.ts` is already the module's largest accessor file).
9. **The inbound rejection path never rolls back its savepoint.** The rejection IS the outcome; the
   SAVEPOINT wraps only an infrastructure failure of the queue write itself. `applied` is always 0,
   and no code path in that branch reads or writes `bom`, `bom_revision` or `bom_line` - `bom_id`
   is resolved best-effort with a plain lock-free SELECT for the audit payload only.
10. **`bom.sync_conflict_raised` is emitted after the batch commits, gated on `newly_opened`, with
    a RANDOM idempotency key**, exactly as the story's binding decision requires. The dedupe test
    (three identical batches, one open row, one event) and the reopen test (resolve, re-post, new
    open row, second event) both prove the pairing. Accepted tradeoff, documented rather than
    "fixed": a crash between the batch commit and the event write leaves an exception row with no
    event. The queue survives, the administrator still sees the conflict, and the next poll
    re-raises.
11. **`raiseException`'s signature was NOT changed.** The `exception_id` is read back with a scoped
    SELECT on the same client, per Task 7.3.

Fixture changes made under Task 5.4 (setup only - no assertion was weakened, and the gate was never
relaxed to make an older suite pass):

| Suite | Change |
| --- | --- |
| `story-5-2` | `createItem` now seeds an Ind AS 2 designation plus a standard cost; a `primeCostRollup` helper was added and called before all 15 release POSTs and before the clean-draft checklist read |
| `story-5-3` | Same `createItem` seeding; `primeCostRollup` called before both release POSTs (one inside the shared `draftAndReleaseBom` helper) |
| `story-5-4` | Same `createItem` seeding; `primeCostRollup` called before both release POSTs |
| `story-5-5` | Same `createItem` seeding; `primeCostRollup` called before the release POST in `draftAndRelease` |

One assertion in `story-5-2` was updated rather than extended: the block that asserted
`staged_conditions` still listed `cost_rollup_complete` with `enforced: false` now asserts the list
is empty. That assertion states the pre-5.6 contract this story deliberately retires, and the
Story 5.3 `approved_eco` un-staging set the same precedent.

Two additional carry-forward fixes were required for the new `bom_line.supply_source` column:
`src/compliance/eco.ts` (the ECO revision copy) and `src/compliance/rd-bom.ts` (the R&D clone) now
carry the tag forward, exactly as they already did for Story 5.5's `supply_method`.

Deferred, recorded rather than widened into: the Story 5.5 gap where an ECO add-line cannot express
`supply_method` applies verbatim to `supply_source` - an `eco_change_line` schema change belongs to
a Story 5.3 revision, not here.

Environment note, not a code defect: `deploy/compose/init-db.sql`, `read/projections/bom_line.sql`
and `read/projections/integration_exception.sql` were normalized back to LF after editing. The
editor wrote CRLF, which made the `gate_dwell_metric` view-body comparison in
`test/unit/schema-drift.test.ts` fail on an untouched view. Verified against a pristine
`git worktree` at HEAD before and after; the suite is 80/80 with LF.

### File List

New files:

- `read/projections/bom_cost_rollup.sql`
- `read/projections/bom_cost_rollup_line.sql`
- `read/projections/bom_outbound_message.sql`
- `src/engineering/bom-cost-rollup.ts`
- `src/compliance/bom-costing.ts`
- `src/read/projections/bom_cost_rollup.ts`
- `src/read/projections/bom_cost_rollup_comparison.ts`
- `src/read/projections/bom_outbound_message.ts`
- `src/adapters/erp/bom-outbound.ts`
- `src/api/v1/bom-costing.ts`
- `test/integration/story-5-6.test.ts`

Modified files:

- `read/projections/bom_line.sql`
- `read/projections/integration_exception.sql`
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/compliance/bom.ts`
- `src/compliance/eco.ts`
- `src/compliance/rd-bom.ts`
- `src/read/projections/bom.ts`
- `src/read/projections/integration_exception.ts`
- `src/read/projections/release_gate_checklist.ts`
- `src/adapters/erp/sync.ts`
- `src/api/v1/erp-projections.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-5-2.test.ts`
- `test/integration/story-5-3.test.ts`
- `test/integration/story-5-4.test.ts`
- `test/integration/story-5-5.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date | Version | Description | Author |
| --- | --- | --- | --- |
| 2026-08-14 | 1.0 | Story created by the context engine at baseline f29765f | create-story |
| 2026-08-14 | 1.1 | Inbound ERP sync decision resolved and made binding: queue is authoritative, event emitted post-commit gated on `raiseException`'s `newly_opened` discriminator, random idempotency key. Task 7.3 rewritten with 7.3a added, dedupe and reopen tests added to Task 9.6 | party-mode |
| 2026-08-14 | 1.2 | All 9 tasks (58 subtasks) implemented from baseline f29765f. Three new tables, one additive `bom_line.supply_source`, one widened `integration_exception` vocabulary, three engineering-stream events, the pure `rollUpBomCost` service, the `bom-costing` compliance seam, the computed comparison read, the outbound adapter boundary, unconditional inbound-BOM rejection, 7 routes, and a 24-case integration suite. `STAGED_CONDITIONS` retired to empty. Status moved to review | dev-story |
| 2026-08-14 | 1.3 | Code review (adversarial, 4 chunks). 2 decisions resolved (empty-rollup gate, reinstatement republish), 13 patches applied, 5 deferred. Status moved to done | code-review |

### Review Findings

Code review (adversarial, four chunks) on baseline f29765f.

**Decision-needed:**

- [x] [Review][Decision] Zero-line cost rollup treated as complete - the gate predicate checks `missing_rate_count = 0` and freshness but never `line_count > 0`, so a BOM whose component lines are all unresolved phantoms or not yet effective on the rollup date produces a zero-costed-line snapshot that satisfies `cost_rollup_complete` and lets release proceed with an empty cost [src/compliance/bom.ts:583-624]
- [x] [Review][Decision] On-hold reinstatement re-publishes the outbound message - `applyBomReleased` writes `insertBomOutboundMessage` on both the draft first-release and the on-hold reinstatement paths, so a released-then-held-then-released production BOM emits a duplicate `bom_outbound_message` row [src/compliance/bom.ts:824-844]

**Patch:**

- [x] [Review][Patch] Effectivity dates serialized as weekday garbage - `effective_from`/`effective_to` are DATE columns returned as JS Date objects, so `String(line.effective_from).slice(0, 10)` yields "Fri Aug 14" in every outbound payload [src/adapters/erp/bom-outbound.ts:80-81]
- [x] [Review][Patch] `correlation_id` reaches a UUID column unvalidated - client body value flows to `bom_cost_rollup.correlation_id UUID` with no shape or handler check, yielding a 22P02 raw 500 [src/api/v1/bom-costing.ts:114,131]
- [x] [Review][Patch] `offset` unclamped in `readPaging` - a 22-digit offset becomes 1e+22 and fails bigint out of range as a raw 500 [src/api/v1/bom-costing.ts:91]
- [x] [Review][Patch] Kit tagging lacks an `output_class = 'component'` filter - co_product/by_product lines accept a meaningless supply source [src/compliance/bom-costing.ts:428-431]
- [x] [Review][Patch] Outbound payload loses the correlation id - reads `payload.correlation_id` instead of `envelope.metadata.correlation_id`, so the common no-body case records null [src/compliance/bom.ts:840]
- [x] [Review][Patch] Inbound rejection queue-write failure silently swallowed - the empty catch discards a failed `raiseException`/read-back with no log or count [src/adapters/erp/sync.ts:541-544]
- [x] [Review][Patch] BOM exception resolve not scoped to `record_type = 'bom'` [src/api/v1/erp-projections.ts:403-407]
- [x] [Review][Patch] AC5 byte-identical snapshot is a weak proxy - MAX updated_at only, no per-row clock and no `bom_revision` clock [test/integration/story-5-6.test.ts:294-305]
- [x] [Review][Patch] Dedupe test asserts `raised_at >=` instead of strictly later [test/integration/story-5-6.test.ts:1237-1240]
- [x] [Review][Patch] Staleness test misses the amend-line case required by Task 9.4 [test/integration/story-5-6.test.ts:870-902]
- [x] [Review][Patch] Outbound payload assertions omit required fields [test/integration/story-5-6.test.ts:1141-1144]
- [x] [Review][Patch] `primeCostRollup` invoked on an R&D draft where it deterministically 409s [test/integration/story-5-4.test.ts:452]
- [x] [Review][Patch] List endpoint `total` asserted with a vacuous `>= 2` bound [test/integration/story-5-6.test.ts:543-544]

**Defer:**

- [x] [Review][Defer] `getLatestCompleteRollup`/`getLatestRollup` are dead code and diverge from the live gate predicate [src/read/projections/bom_cost_rollup.ts:183-211] - deferred, spec-mandated accessors the gate predicate did not adopt
- [x] [Review][Defer] Same-revision amendment TOCTOU - capture runs outside the persist transaction, stale guard is revision-only [src/compliance/bom-costing.ts:286-306] - deferred, the gate staleness check re-validates at release
- [x] [Review][Defer] `NO_BOM_STREAM_ID` reuses the SCIM actor sentinel as a stream id [src/api/v1/erp-projections.ts:43-44] - deferred, low, no functional break
- [x] [Review][Defer] `emitBomSyncConflictEvents` silent catch hides shape-assert defects [src/api/v1/erp-projections.ts:323-335] - deferred, spec-accepted commit-then-emit tradeoff
- [x] [Review][Defer] `bom_line` is_released_structure comment mirror divergence [read/projections/bom_line.sql] - deferred, pre-existing Story 5.5
