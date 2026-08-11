---
baseline_commit: 25084ab30c52f4b668d85cce366c4df1e7010d23
---

# Story 5.3: ECO Workflow and Where-Used Impact

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created (create-story 2026-08-09). -->

## Story

As a change control engineer,
I want an Engineering Change Order workflow with where-used and impact analysis shown at approval, and only Implemented ECOs able to alter a Released BOM,
so that every change is assessed for downstream impact and applied in a controlled way.

## Acceptance Criteria

1. **Given** a proposed change to a Released BOM, **When** an ECO is raised (FR-B-04), **Then** it enters the ECO lifecycle at `Draft`, progressing through `Under Review`, `Approved`, `Implemented`, or `Cancelled`.
2. **Given** an ECO reaches the approval step, **When** the approver reviews it, **Then** a where-used and impact analysis (FR-B-05) is displayed across affected BOMs and current stock (Epic 2), with open-PO impact read from the ERP inbound reference projections (Story 2.9); the open-production-order dimension displays as empty and registers as an impact source when Epic 6 lands.
3. **Given** an ECO has been Approved but not yet Implemented, **When** the target Released BOM is inspected, **Then** the BOM is unchanged - only an `Implemented` ECO alters a Released BOM.
4. **Given** an ECO is Implemented, **When** the implementation event is recorded, **Then** a new Released BOM revision is created, the prior revision is retained immutably, and the change is attributed in the edit log (FR-AC-13).
5. **Given** an Approved ECO with on-hand stock of the superseded revision (FR-B-04), **When** implementation is recorded, **Then** a stock-disposition decision - use-up, scrap, or rework - is required per affected lot before the ECO can reach `Implemented`: use-up permits consuming the superseded revision until exhausted, scrap routes affected lots to the scrap disposition flow, rework routes them to a rework reference, and each decision is written to the edit log (FR-AC-13).
6. **Given** an ECO that is not in `Approved` state (FR-B-04), **When** implementation is attempted, **Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` - only Approved ECOs may be Implemented.
7. **Given** an ECO reaches the approval step, **When** the approver is resolved, **Then** the approver is resolved from the DOA registry (FR-DOA-01), and an approval attempt by a user outside the resolved chain is rejected with `error_code: "APPROVAL_REQUIRED"`.
8. **Given** a Cancelled ECO, **When** any user attempts to reopen or implement it, **Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` - Cancelled is terminal and a new ECO must be raised.
9. **Given** a BOM with at least one prior Released revision, **When** release of a subsequent revision is attempted without an approved ECO covering the change (FR-B-06), **Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` - the approved-ECO gate condition (staged from Story 5.2) applies to every revision after the first; the first release of a brand-new BOM is exempt so that initial release is achievable.

## Tasks / Subtasks

[x] Task 1: ECO schema (AC: 1, 5, 7)
[x] New `read/projections/eco.sql`. Columns: `eco_id UUID PRIMARY KEY`, `eco_number TEXT NOT NULL`, `bom_id UUID NOT NULL`, `target_revision_id UUID NOT NULL`, `business_stream TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'draft'`, `reason TEXT NOT NULL`, `raised_by UUID NOT NULL`, `approver_actor_id UUID`, `doa_entry_id UUID`, `review_started_at TIMESTAMPTZ`, `approved_at TIMESTAMPTZ`, `approved_by UUID`, `implemented_at TIMESTAMPTZ`, `implemented_by UUID`, `new_revision_id UUID`, `cancelled_at TIMESTAMPTZ`, `cancelled_by UUID`, `cancel_reason TEXT`, `status_changed_at TIMESTAMPTZ`, `status_changed_by UUID`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, `created_at`, `updated_at`. Constraints: `chk_eco_status CHECK (status IN ('draft','under_review','approved','implemented','cancelled'))`; `uq_eco_number UNIQUE INDEX` on `eco_number`; indexes `idx_eco_bom_id (bom_id)`, `idx_eco_status (status)`, `idx_eco_approver (approver_actor_id) WHERE status = 'under_review'`
[x] New `read/projections/eco_change_line.sql`. Columns: `eco_change_id UUID PRIMARY KEY`, `eco_id UUID NOT NULL`, `change_no INTEGER NOT NULL`, `change_type TEXT NOT NULL`, `target_bom_line_id UUID`, `component_item_id UUID`, `component_sku TEXT`, `output_class TEXT NOT NULL DEFAULT 'component'`, `quantity_per NUMERIC(18,6)`, `line_uom TEXT`, `uom_conversion_factor NUMERIC(18,8)`, `base_quantity_per NUMERIC(18,6)`, `scrap_percent NUMERIC(7,4)`, `expected_yield_percent NUMERIC(7,4)`, `is_phantom BOOLEAN NOT NULL DEFAULT false`, `phantom_source_bom_id UUID`, `effective_from DATE`, `effective_to DATE`, `source_event_id UUID NOT NULL`, `created_at`. Constraints: `chk_eco_change_type CHECK (change_type IN ('add','amend','retire'))`; `chk_eco_change_target CHECK ((change_type = 'add' AND target_bom_line_id IS NULL AND component_item_id IS NOT NULL) OR (change_type IN ('amend','retire') AND target_bom_line_id IS NOT NULL))`; `uq_eco_change_no UNIQUE INDEX (eco_id, change_no)`; index `idx_eco_change_eco_id (eco_id)`
[x] New `read/projections/eco_stock_disposition.sql`. Columns: `disposition_id UUID PRIMARY KEY`, `eco_id UUID NOT NULL`, `lot_id TEXT NOT NULL`, `sku TEXT NOT NULL`, `location_id UUID NOT NULL`, `on_hand_qty NUMERIC(18,6) NOT NULL`, `disposition TEXT NOT NULL`, `rework_reference TEXT`, `notes TEXT`, `decided_at TIMESTAMPTZ NOT NULL`, `decided_by UUID NOT NULL`, `source_event_id UUID NOT NULL`. Constraints: `chk_eco_disposition CHECK (disposition IN ('use_up','scrap','rework'))`; `chk_eco_disposition_rework_ref CHECK ((disposition = 'rework' AND rework_reference IS NOT NULL AND btrim(rework_reference) <> '') OR (disposition <> 'rework' AND rework_reference IS NULL))`; `uq_eco_disposition_lot UNIQUE INDEX (eco_id, lot_id, location_id)`; index `idx_eco_disposition_eco_id (eco_id)`
[x] Add `source_eco_id UUID` to `read/projections/bom_revision.sql` via `ADD COLUMN IF NOT EXISTS` plus index `idx_bom_revision_source_eco (source_eco_id)`. This column is the machine-checkable evidence the AC 9 gate reads; do not re-derive "was this revision ECO-driven" any other way
[x] Every file carries its own guarded grant block (`INSERT, SELECT, UPDATE` to `app_user`, `SELECT` to `readonly_user`, no `DELETE`), the `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` re-add guard per named constraint, and is fully idempotent. Copy `read/projections/bom.sql` header comment and guard style verbatim
[x] Register the three new files at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (currently ends at `supplier_scorecard_metric.sql`) in dependency order `eco.sql`, `eco_change_line.sql`, `eco_stock_disposition.sql`. Never reorder existing entries
[x] Mirror every DDL statement byte-for-byte into `deploy/compose/init-db.sql` (LF endings), including the `bom_revision` column addition
[x] Add EXPECTED entries for the three new tables to `test/unit/schema-drift.test.ts` (the bom entries at lines 660-714 are the shape to copy) and add `source_eco_id` to the `bom_revision` expectation
[x] Prove idempotency: `npm run db:migrate` twice
[x] Task 2: Register ECO events (AC: 1, 4, 5, 8)
[x] In `src/events/schema.ts`, after the Story 5.2 BOM block, add payload plus envelope interface pairs (`Omit<EventEnvelope, 'payload'>` pattern) for six event types: `eco.raised`, `eco.review_started`, `eco.approved`, `eco.implemented`, `eco.cancelled`, `eco.stock_disposition_recorded`
[x] `eco.review_started` is a deliberate sixth event beyond the five named in the epics dev note: AC 1 requires `Under Review` to be a reachable state and every state change in this codebase is an event. Record this in the Dev Agent Record
[x] Append registry entries at the tail of `SUPPORTED_EVENT_TYPES` before `} as const`, all `streamType: 'engineering'`. `requiresBusinessStream: true` for `eco.raised` only (it creates the header, following `bom.drafted`); `false` for the other five (transitions act on an already-tagged document, following `bom_line.*` and the 5.2 lifecycle events)
[x] Payload shapes (all carry optional `correlation_id`): `EcoRaisedPayload { eco_id, eco_number, bom_id, target_revision_id, business_stream: string, reason, changes: EcoChangeInput[], approver_actor_id: string | null, doa_entry_id: string | null }`; `EcoReviewStartedPayload { eco_id }`; `EcoApprovedPayload { eco_id, decision_note? }`; `EcoImplementedPayload { eco_id, new_revision_id, new_revision_code }`; `EcoCancelledPayload { eco_id, cancel_reason }`; `EcoStockDispositionRecordedPayload { eco_id, dispositions: { lot_id, sku, location_id, on_hand_qty: string, disposition, rework_reference?, notes? }[] }`
[x] `business_stream` is REQUIRED (not optional) on `EcoRaisedPayload` - the Story 5.2 Group 3 review corrected exactly this typing-truth gap on `BomDraftedPayload`; do not reintroduce it
[x] `approver_actor_id`, `doa_entry_id`, `new_revision_id`, and `new_revision_code` are computed at CAPTURE time in the handler and stored in the payload so replay is deterministic. DOA registry entries, role holders, and revision counts all drift over time. This is the same rule Story 5.2 applied to the migration `outcome` field
[x] Task 3: ECO compliance module (AC: 1, 3, 4, 5, 6, 7, 8)
[x] New `src/compliance/eco.ts` mirroring `src/compliance/bom.ts` structure exactly: `ENGINEERING_STREAM_TYPES` set, `ECO_EVENT_TYPES` set, local `reject()` helper, `isUuid` / `isNonEmptyString` / `isDateString` / `assertDecimalString` / `assertScrapPercent` guards, exported `ecoEventType(envelope)`, exported `assertEcoShape(envelope)`, exported `applyEcoProjection(envelope, client, eventId)`, plain-SELECT `alreadyPersisted` replay guard (NEVER `FOR UPDATE` on `domain_events`), and `assertValidOccurredAt` on EVERY applier
[x] Wire into `src/events/store.ts` at the two existing seams only: `assertEcoShape(envelope)` alongside `assertBomShape` in the pre-transaction assert block (near line 492) and `await applyEcoProjection(envelope, client, eventId)` alongside `applyBomProjection` in the in-transaction block (near line 740). Add no other store.ts call sites
[x] Transition matrix (everything else rejects `ECO_STATE_INVALID`, 409): `draft` to `under_review` or `cancelled`; `under_review` to `approved` or `cancelled`; `approved` to `implemented` or `cancelled`; `implemented` and `cancelled` are TERMINAL. Every applier locks the `eco` row `SELECT ... FOR UPDATE` before branching
[x] `eco.raised` applier: verify the target BOM exists and `bom.status = 'released'` (an ECO only changes a Released BOM per AC 1 and FR-B-03) else reject `BOM_NOT_RELEASED` (409); verify `target_revision_id` belongs to that `bom_id` AND has `revision_status = 'released'` else reject `INVALID_PARAMS` (400) - the Story 5.2 Group 1 deferral flagged that BOM appliers never cross-check `revision_id` against `bom_id`; close it here for ECO rather than inheriting it; insert the `eco` row at `status = 'draft'` plus one `eco_change_line` row per change with sequential `change_no` from array order
[x] `eco.approved` applier: require current status `under_review`; set `status = 'approved'`, `approved_at`, `approved_by`. Then emit the decision notification with `emitNotificationInTransaction` (AD-17 makes approval decisions transactional, never `emitNotification`) targeting `eco.raised_by`, copying the `src/compliance/indent.ts` lines 628-647 call shape: `event_type: 'eco_decision'`, `status_verb: 'approved'`, `object_type: 'eco'`, `object_id: eco_id`
[x] `eco.cancelled` applier: allowed from `draft`, `under_review`, `approved`; set `status = 'cancelled'`, `cancelled_at`, `cancelled_by`, `cancel_reason`. Terminal
[x] `eco.stock_disposition_recorded` applier: require current status `approved`; upsert one `eco_stock_disposition` row per entry keyed on `uq_eco_disposition_lot` (`ON CONFLICT (eco_id, lot_id, location_id) DO UPDATE`) so a corrected decision replaces rather than duplicates; store `on_hand_qty` as the exact NUMERIC string supplied
[x] `eco.implemented` applier (AC 4, 5, 6): reject `ECO_STATE_INVALID` (409) unless current status is exactly `approved`; recompute the affected-lot set (see Dev Notes) INSIDE the transaction and reject `DISPOSITION_REQUIRED` (409) with `details.pending_lots[]` when any affected lot has no `eco_stock_disposition` row; then create `bom_revision` (`revision_id = payload.new_revision_id`, `revision_code = payload.new_revision_code`, `revision_status = 'released'`, `released_at`, `released_by`, `source_eco_id = eco_id`), COPY every `bom_line` row of the superseded revision into the new `revision_id` with fresh `bom_line_id`s, then apply each `eco_change_line`: `add` inserts a new line, `amend` updates the copied line whose ancestry is `target_bom_line_id`, `retire` closes the copied line's effectivity by setting `effective_to` to the day before `occurred_at`'s IST business date (NEVER delete - no deletion path exists in this module and none may be added); finally set `bom.current_revision_id = new_revision_id`, `bom.status_changed_at/by`, `eco.status = 'implemented'`, `eco.implemented_at/by`, `eco.new_revision_id`
[x] The superseded revision's `bom_revision` and `bom_line` rows are NOT touched by implementation (AC 4 "the prior revision is retained immutably"). Assert this in tests by re-reading the old rows after implementation
[x] All quantity arithmetic (`base_quantity_per = quantity_per * uom_conversion_factor`) is computed in PostgreSQL NUMERIC inside the INSERT VALUES list (`$n::numeric * $m::numeric`), never in JavaScript. The Story 5.2 Group 1 review patched exactly this defect in the migration applier
[x] Task 4: Where-used and impact analysis read (AC: 2)
[x] New `src/read/projections/where_used_impact.ts` exporting `getEcoImpact(ecoId, client?)`, computed live from `bom_line`, `bom`, `stock_balance`, `erp_purchase_order_line`, `erp_purchase_order`. Follow the `src/read/projections/release_gate_checklist.ts` precedent exactly: computed read, no stored table, no new migration entry, runner-with-optional-`PoolClient`, `UUID_REGEX` guard, NUMERIC returned as strings
[x] Where-used walk reads `bom_line`, NOT `bom_structure`. `bom_structure` is never populated (Story 5.1 debt, confirmed still open at baseline) - reading it returns an empty graph and would silently report "no impact". Use the existing `idx_bom_line_component_item` index
[x] Affected components = the distinct `component_item_id` set touched by the ECO's `eco_change_line` rows plus the BOM's own `parent_item_id`. For each, walk UPWARD through `bom_line` to parent BOMs recursively, depth-capped at `config.bom.maxDepth` (already defined in `src/config/index.ts` line 279, default 20, currently unused). Cap the walk and mark `depth_truncated: true` rather than recursing unbounded; a cyclic structure must not hang the request (Story 5.1 left `BOM_CYCLE_DETECTED` unimplemented, so cycles are reachable data)
[x] Response shape: `{ eco_id, affected_boms: [{ bom_id, parent_sku, status, depth, via_component_sku }], stock_impact: [{ sku, location_id, lot_id, stock_class, on_hand, allocated, available }], open_po_impact: [{ po_number_ext, line_no, sku, open_qty, expected_delivery_date, supplier_ref_ext }], open_production_order_impact: [], production_order_source: { available: false, registers_with: 'Epic 6' }, depth_truncated }`
[x] Stock impact reuses `getStockBalancesBySku` from `src/read/projections/stock_balance.ts` (line 125). Do not write a parallel stock query
[x] Open-PO impact reads `erp_purchase_order_line` joined to `erp_purchase_order` where `status = 'open' AND open_qty > 0`, filtered by the affected SKUs (Story 2.9 projections; keys are `po_number_ext` plus `sku`, there is no item UUID on that table). If a suitable accessor does not exist in `src/read/projections/erp_purchase_order.ts`, add one there rather than embedding SQL in the impact module
[x] `open_production_order_impact` is an EMPTY array with the explicit `production_order_source` marker, never omitted. AC 2 requires the dimension to display as empty and register when Epic 6 lands
[x] Task 5: Approved-ECO release gate condition (AC: 9)
[x] In `src/compliance/bom.ts`, `evaluateReleaseGate` (line 456): add the `approved_eco` condition. Predicate: count `bom_revision` rows for this `bom_id` with `revision_status = 'released'` excluding the revision under release. If that count is 0 the condition is EXEMPT (first release of a brand-new BOM, AC 9) and reported met. Otherwise the condition is met only when the revision under release has `source_eco_id IS NOT NULL` and that ECO is in status `approved` or `implemented`
[x] Push `approved_eco` into `unmetConditions` on failure so the existing `RELEASE_GATE_UNMET` (409) response carries it - do not invent a new error code, AC 9 mandates `RELEASE_GATE_UNMET` verbatim
[x] Remove `approved_eco` from the `STAGED_CONDITIONS` array (`src/compliance/bom.ts`, just above `applyBomReleased`); `cost_rollup_complete` stays staged with `enforced: false` for Story 5.6
[x] Mirror the flip in `src/read/projections/release_gate_checklist.ts`: `approved_eco` moves from the staged block (lines 123-124) into the computed conditions with a real `met` boolean and `enforced: true`, using the SAME predicate. The Story 5.2 binding rule is that the checklist and the gate can never disagree
[x] Reinstatement (`on_hold` to `released`) still skips the gate entirely per the Story 5.2 transition design. Do not add a gate call to that branch
[x] The `eco.implemented` applier writes the new revision as already `released` and therefore does NOT route through `applyBomReleased`. Extract the shared "release a revision" write (via the existing `releaseBomRevision` and `updateBomStatus` helpers in `src/read/projections/bom.ts`) rather than duplicating the SQL
[x] Task 6: API routes, DOA resolution, RBAC, spine registration (AC: 1, 2, 5, 6, 7, 8)
[x] New `src/api/v1/ecos.ts` copying the `src/api/v1/boms.ts` skeleton: local `actorContext(req)`, `auditCtxFor(req, actor, httpStatus)`, envelope builders that ALWAYS stamp `metadata.occurred_at` (the Story 5.2 debugging record shows omitting it crashes `persistEvent` with a 500), `idempotency_key: (body.idempotency_key as string) ?? randomUUID()`, `persistEvent(event, auditCtxFor(...))`, responses returning the durable projection state
[x] Handlers and routes: `POST /api/v1/ecos` (raise), `GET /api/v1/ecos` (list, filterable by `bom_id` and `status`, this is the approval queue), `GET /api/v1/ecos/:ecoId`, `GET /api/v1/ecos/:ecoId/impact` (AC 2), `POST /api/v1/ecos/:ecoId/review` (start review), `POST /api/v1/ecos/:ecoId/approve`, `POST /api/v1/ecos/:ecoId/dispositions` (AC 5), `POST /api/v1/ecos/:ecoId/implement`, `POST /api/v1/ecos/:ecoId/cancel`
[x] Route-order requirement: `src/api/router.ts` lines 125-141 return the FIRST registered match and `:ecoId` compiles to `([^/]+)`. All ECO routes here are either literal-only or `:ecoId`-prefixed with a distinct second segment, so no literal-versus-parameter collision exists today. If a literal collection-level route is ever added under `/api/v1/ecos/<literal>`, it MUST be registered above `GET /api/v1/ecos/:ecoId` (this is the trap Story 5.2 hit with `migration-exceptions`)
[x] Mount in `src/server.ts` under a `// Story 5.3: ECO Workflow` comment placed AFTER the Story 5.2 block (currently lines 465-470). Do not reorder the existing BOM routes
[x] RBAC: mutations `requireRole({ module: 'engineering', functionScope: 'write' })`, reads `functionScope: 'read'`. NEVER role-name literals - `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces this
[x] DOA resolution (AC 7): define `export const ECO_DOA_TYPE = 'eco_approval'` in `src/api/v1/ecos.ts` and reuse `resolveApprover` exported from `src/api/v1/indents.ts` line 66 with value `0` (ECOs carry no monetary band; `src/api/v1/suppliers.ts` line 232 is the existing zero-value precedent). Resolve at RAISE time and store `approver_actor_id` / `doa_entry_id` in the `eco.raised` payload. Do not write a new DOA lookup
[x] Approval authority check in the approve handler, before building the envelope: `if (eco.approver_actor_id !== actor.userId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Caller is not the resolved approver for this ECO', { approver_actor_id, caller_user_id })`. Copy `src/api/v1/transfer-requests.ts` lines 613-622 verbatim in shape and status code
[x] `POST /api/v1/ecos/:ecoId/dispositions` body: `{ dispositions: [{ lot_id, sku, location_id, disposition, rework_reference?, notes? }], idempotency_key? }`. The handler resolves `on_hand_qty` server-side from `stock_balance` and never accepts it from the body. Reject unknown lots with `INVALID_PARAMS` (400)
[x] Add all nine routes verbatim to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` under a `// Story 5.3` comment (the list is grouped by story comment, BOM block at lines 352-364, NOT alphabetically sorted)
[x] `src/api/v1/events.ts` already rejects `stream_type === 'engineering'` on direct posts (Story 5.2 Group 4 patch). ECO events inherit that guard because they use the same stream type - do not add a second guard, but DO assert the rejection in tests with a WELL-FORMED envelope
[x] Task 7: Read accessors (AC: 1, 2, 3, 5)
[x] New `src/read/projections/eco.ts` following `src/read/projections/bom.ts` style: `EcoRow` / `EcoChangeLineRow` / `EcoDispositionRow` interfaces, `getEcoById`, `listEcos(params)` with `bom_id` / `status` / `approver_actor_id` filters and clamped `limit`/`offset`, `getEcoChangeLines`, `getEcoDispositions`, plus insert/update helpers actually CALLED by the appliers
[x] Every write helper you export must have a caller. The Story 5.2 Group 3 review found `updateBomStatus` / `releaseBomRevision` exported dead with drifting INSERT column lists; do not repeat that pattern
[x] `limit`/`offset` parsed with a `\d+` guard, clamped, and echoed at the CLAMPED value (Story 5.2 Group 2 patch: `Number('abc')` reaching `LIMIT NaN` is a raw 500, and echoing an unclamped limit makes pagination metadata lie)
[x] Task 8: Integration and unit tests (AC: all)
[x] New `test/integration/story-5-3.test.ts` following the `test/integration/story-5-2.test.ts` harness exactly: `node:test` plus `node:assert/strict`, real router via `createAppRouter` from `../../src/server.js`, real PostgreSQL via `getPool`/`getAdminPool`, canonical `.sql` files applied via `readFileSync` in dependency order, port-zero server, run-scoped identifiers from `randomUUID().slice(0, 8)`, all writes through the HTTP API
[x] `after()` hook MUST truncate the new tables plus the BOM tables: `TRUNCATE TABLE eco_stock_disposition, eco_change_line, eco, bom_line, bom_revision, bom_structure, bom RESTART IDENTITY CASCADE`. Story 5.2 Group 4 found BOM rows accumulating across runs in the shared test database
[x] Minimum cases: (1) raise against a Released BOM lands `draft` with change lines and a resolved `approver_actor_id`; (2) raise against a Draft BOM rejected `BOM_NOT_RELEASED`; (3) raise with a `target_revision_id` belonging to another BOM rejected; (4) full happy chain draft to under_review to approved to dispositions to implemented; (5) approve by a non-resolved user returns 403 `APPROVAL_REQUIRED`; (6) implement from `under_review` rejected `ECO_STATE_INVALID`; (7) implement from `approved` with on-hand stock and NO dispositions rejected `DISPOSITION_REQUIRED` listing pending lots; (8) each of `use_up`, `scrap`, `rework` accepted, `rework` without `rework_reference` rejected; (9) approved-not-implemented leaves the target BOM byte-identical (re-read `bom.current_revision_id` and every `bom_line` row); (10) implemented creates a new released revision with `source_eco_id` set, `bom.current_revision_id` repointed, and the SUPERSEDED revision's rows unchanged; (11) `add` / `amend` / `retire` change types each land correctly on the new revision, `retire` by effectivity closure and never by deletion; (12) cancel from each of draft, under_review, approved succeeds, then implement and review on the cancelled ECO both reject `ECO_STATE_INVALID`; (13) AC 9 gate: second revision released without an ECO returns `RELEASE_GATE_UNMET` naming `approved_eco`, and the FIRST release of a brand-new BOM still succeeds (exemption); (14) `GET /:ecoId/impact` returns affected BOMs from a two-level structure, stock rows, and open-PO rows, with `open_production_order_impact: []` and the Epic 6 marker; (15) impact walk on a self-referential structure terminates with `depth_truncated: true`; (16) well-formed direct `eco.*` post to `POST /api/v1/events` rejected `INVALID_EVENT_STREAM`; (17) every mutation without engineering write role returns 403 and every read without engineering read role returns 403; (18) idempotent replay of each mutation with the same `idempotency_key` does not double-apply; (19) audit entries exist for raise, approve, disposition, implement, and cancel (FR-AC-13); (20) approval writes a `notification.created` event targeting the raiser
[x] Assert response BODIES, not just status codes: error tests assert `error_code`, and mutation tests re-fetch the projection to confirm the change actually landed. Story 5.2 Group 4 found several tests passing for the wrong reason
[x] Task 9: QA gates (AC: all)
[x] Run and record results for: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test`, `npm run spine-acceptance-contract`, `npm run edge:test`, `git diff --check`
[x] Run `graphify update .` after code changes
[x] Update `_bmad-output/implementation-artifacts/sprint-status.yaml` for `5-3-eco-workflow-and-where-used-impact` when done, and fill every Dev Agent Record section of this file
[x] The 14 known pre-existing idempotency-replay failures (409 versus 201) in the Epic 1-3 suites are the accepted baseline. Report the count and confirm zero NEW failures; do not attempt to fix them in this story

## Dev Notes

### ECO lifecycle design (binding)

- States: `draft`, `under_review`, `approved`, `implemented`, `cancelled`. `implemented` and `cancelled` are terminal. Rejections use `ECO_STATE_INVALID` (409), mandated verbatim by AC 6 and AC 8.
- An ECO always targets a Released BOM and a specific released `target_revision_id`. Draft BOMs are edited directly (Story 5.1 and 5.2 semantics) and need no ECO.
- One ECO produces at most one new revision. Do not build ECO-to-ECO chaining or multi-BOM ECOs; both are out of scope and neither AC asks for them.
- Table 1 states the transition matrix. Every transition locks the `eco` row `FOR UPDATE` before branching, mirroring the Story 5.2 lifecycle appliers.

Table 1: ECO transition matrix

| **From** | **To** | **Event** | **Guard** |
| --- | --- | --- | --- |
| draft | under_review | `eco.review_started` | none |
| draft | cancelled | `eco.cancelled` | `cancel_reason` required |
| under_review | approved | `eco.approved` | caller is `approver_actor_id` |
| under_review | cancelled | `eco.cancelled` | `cancel_reason` required |
| approved | implemented | `eco.implemented` | every affected lot has a disposition |
| approved | cancelled | `eco.cancelled` | `cancel_reason` required |
| implemented | any | rejected | terminal, `ECO_STATE_INVALID` |
| cancelled | any | rejected | terminal, `ECO_STATE_INVALID` |

### Affected-lot set for stock disposition (binding)

- `stock_balance` has NO revision dimension (columns are `sku`, `location_id`, `lot_id`, `stock_class`, `on_hand`, `allocated`, `in_transit`). There is therefore no way to ask the database which lots were built to the superseded revision.
- Binding definition: the affected lots for an ECO are the `stock_balance` rows for the target BOM's `parent_sku` with `on_hand > 0`, at the moment implementation is attempted. Every such row (keyed `lot_id`, `location_id`) needs an `eco_stock_disposition` decision before `eco.implemented` may proceed.
- Rows with `lot_id IS NULL` are excluded: `uq_eco_disposition_lot` cannot key them and a non-lot-tracked item has no lot to dispose. Record the exclusion in the implement response so the decision is visible rather than silent.
- The affected-lot set is recomputed INSIDE the implement transaction, not trusted from the earlier disposition call. Stock moves between approval and implementation. This is the same "re-derive truth transactionally" rule the Story 5.2 release gate follows.

### Disposition downstream integrations (binding, do not over-build)

- `scrap` routes to "the scrap disposition flow" and `rework` to "a rework reference". VERIFIED at baseline: no scrap module and no rework module exist (`src/compliance/` has no scrap or rework file; the only `scrap` matches in `src/` are BOM `scrap_percent`). The scrap and disposal module (FR-SC) is Epic 16, Phase 2.
- Therefore this story RECORDS the decision and its reference, and integrates with nothing. `disposition = 'scrap'` stores the decision and audit entry; `disposition = 'rework'` additionally requires a free-text `rework_reference` enforced by `chk_eco_disposition_rework_ref`. `use_up` records permission to consume the superseded revision until exhausted and enforces no consumption rule (no production-order consumption path exists until Epic 6).
- Do not create a scrap module, a rework order table, or stock movements from this story. AC 5 requires the decision to be required and edit-logged, nothing more.

### Release gate: flipping the staged approved-ECO condition (AC 9)

- Story 5.2 deliberately shipped `approved_eco` as a staged condition with `enforced: false` so this story flips a switch instead of reshaping the `RELEASE_GATE_UNMET` payload. Two places carry it: `STAGED_CONDITIONS` in `src/compliance/bom.ts` (just above `applyBomReleased`) and the staged block in `src/read/projections/release_gate_checklist.ts` lines 123-124.
- Exemption predicate: count released revisions for the BOM EXCLUDING the one under release. Zero means first release, condition met. This is checkable without any ECO existing, which is what makes initial release achievable.
- `cost_rollup_complete` stays staged with `enforced: false`. Do not touch it; Story 5.6 owns it.
- The gate is evaluated only on the `draft` to `released` branch of `applyBomReleased`. The `on_hold` to `released` reinstatement branch skips the gate by Story 5.2 design (the revision already passed it and is immutable). Adding a gate call there would break reinstatement.

### Where-used analysis (binding)

- Read `bom_line`, NOT `bom_structure`. `bom_structure` was created in Story 5.1 and no applier has ever written to it - `GET /api/v1/boms/:bomId/structure` reads an empty table. Its own file comment claims Story 5.3 will read from it; that comment is wrong at baseline and the graph would come back empty. If you populate `bom_structure`, that is a scope expansion: stop and surface it instead.
- Cycle safety: Story 5.1 left `BOM_CYCLE_DETECTED` unimplemented (`config.bom.maxDepth` is defined and unused), so cyclic BOM data is reachable. The upward walk MUST be depth-capped at `config.bom.maxDepth` and report `depth_truncated: true` rather than recursing until the request dies.
- The walk pattern to copy for a depth-capped recursive CTE is the `ZONE_ANCESTOR_CTE` in `src/read/projections/putaway_task.ts` (a downward mirror lives in `src/read/projections/stock_balance.ts` at `getForwardPickBalance`). Both are depth-capped for the identical cyclic-parent reason.
- The impact read is COMPUTED, not stored. This follows `src/read/projections/release_gate_checklist.ts` and the same reasoning: a stored impact graph goes stale the instant stock moves or a PO closes, and the approver must see truth at approval time. The epics dev note wording "where-used impact graph" describes the output, not a table.

### Architecture compliance (mandatory)

- Event-sourced writes only: state changes append to `domain_events`; projections mutate only inside `applyEcoProjection` within the persist transaction. Shape asserts run PRE-transaction so a malformed event never consumes an idempotency key.
- AD-4 (BOM system of record): the platform owns BOM structure. ERP sync is outbound-only for structure and inbound conflicts become BOM Administrator exceptions. Nothing in this story accepts inbound structure.
- AD-3 and FR-DOA-01: approvers resolve from the one enterprise DOA registry through `resolveApprover`; workflow config consumes the registry and never overrides it. No role-name literal may appear in ECO code.
- AD-17: approval and rejection decisions are part of the business fact and MUST use `emitNotificationInTransaction` from `src/notify/emit.js`, never `emitNotification`.
- AD-16: every mutation carries an `idempotency_key`; `persistEvent` deduplicates and returns the EXISTING event on a key hit. Story 5.2 Group 2 found a phantom-success bug from ignoring that return value - always use `persisted.stream_id` rather than a locally minted UUID when building the response.
- BOM and ECO are enterprise-scoped: no `site_id`, no location filters on the ECO itself. `business_stream` derives server-side from the target BOM and is never accepted from a request body.
- FR-AC-13 edit log: raise, review, approve, disposition, implement, and cancel each write an audit entry via `auditCtxFor(req, actor, status)` plus `persistEvent`.
- NUMERIC discipline: quantities, percents, and balances are exact decimal strings end-to-end; arithmetic happens in PostgreSQL NUMERIC, never JS floats. PostgreSQL 18 silently rounds excess scale, so reject before storage.
- ESM: `.js` extensions on relative imports, `node:` prefixed builtins, no new dependencies, no PostgreSQL extensions, hand-rolled router (no web framework).
- Edge and offline surface is untouchable: `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/**`, `sync/sync-rules.yaml`. ECO approval is a central-plane desk workflow with no edge path.
- Markdown outputs follow `FORMATTING_RULES.md` (one H1, hyphens not em dashes, no arrows in prose).

### Error codes

New (all 409 unless noted): `ECO_STATE_INVALID` (mandated verbatim by AC 6 and AC 8), `DISPOSITION_REQUIRED`, `BOM_NOT_RELEASED`. Reuse: `APPROVAL_REQUIRED` (403, per the `transfer-requests.ts` and `cycle-counts.ts` precedent), `RELEASE_GATE_UNMET` (409, mandated by AC 9 - extend the existing payload, do not add a code), `ECO_NOT_FOUND` (404), `BOM_NOT_FOUND` (404), `INVALID_PARAMS` (400), `DUPLICATE_EVENT` (409), `INVALID_EVENT_STREAM` (400). Error envelope `{ error_code, message, details, trace_id }` via `AppError(statusCode, errorCode, message, details)` from `src/middleware/error.ts`. There is no central registry file; codes live in the throwing module.

### Previous story intelligence (5.2, and 5.1 debt)

- Story 5.2 (baseline `af39b5e`, reviewed and hardened through commit `25084ab`) delivered the four-state BOM lifecycle, the staged release gate, released-revision immutability, and legacy kit migration, with a 27-test integration suite. Its four adversarial review groups produced findings this story must not re-earn.
- Patterns to copy without deviation: envelope-interface pairs appended before `SUPPORTED_EVENT_TYPES`; registry entries appended at the tail before `} as const`; migrations appended at the tail of `MIGRATIONS` and never reordered; named `chk_` / `uq_` / `idx_` constraints; grants `INSERT, SELECT, UPDATE` to `app_user` and `SELECT` to `readonly_user` with no `DELETE`; plain-SELECT `alreadyPersisted` (never `FOR UPDATE` on `domain_events`); `assertValidOccurredAt` on every applier; DROP-plus-ADD constraint pairs wrapped in a transactional `DO $$` block.
- Repeat-defect list from the 5.2 review, each already covered by a task above: JS-float NUMERIC arithmetic; appliers missing the `occurred_at` guard; unvalidated `limit`/`offset` reaching `LIMIT NaN`; ignoring `persistEvent`'s returned existing event on idempotency replay; exporting dead write helpers whose INSERT column lists drift; tests asserting status codes without error codes or re-reads; suites with no `TRUNCATE` leaving rows across runs; optional-typed fields the tagging gate hard-requires.
- Open 5.2 deferral this story CLOSES: cross-revision immutability bypass. `applyBomLineAmended` updates by `bom_line_id` with no `revision_id` filter, and both handler and applier check only the CURRENT revision's status. It was unreachable while every BOM had exactly one revision. This story creates second revisions, so it becomes reachable: after implementation the current revision is draft-free but an OLDER released revision's lines could be amended through `PATCH /api/v1/boms/:bomId/lines/:bomLineId`. Add a `revision_id = bom.current_revision_id` filter to both the handler pre-check and `applyBomLineAmended`, and cover it with a test. This is listed at `_bmad-output/implementation-artifacts/deferred-work.md` line 210 - mark it resolved there.
- Story 5.1 debt that is explicitly NOT in scope: `bom_structure` is never populated (work around it, see the where-used note); cycle and depth detection is unimplemented (defend against cycles with the depth cap, do not implement detection); `bom_line.amended` does not re-run the effectivity-overlap predicate. If any of these blocks an AC, stop and surface it rather than expanding scope.
- BOM streams follow Story 5.1's local `DUPLICATE_EVENT` 409 convention on replay rather than Story 3.10's return-existing-record precedent. Keep ECO consistent with the BOM module.

### Git intelligence

- `25084ab` (HEAD) and `af39b5e` are the Story 5.1 and 5.2 BOM commits; `a982e4a` added the business-days library and supplier scorecard shape tests. The BOM module's entire surface therefore lives in six files: `src/compliance/bom.ts`, `src/api/v1/boms.ts`, `src/read/projections/bom.ts`, `src/read/projections/release_gate_checklist.ts`, `src/server.ts`, and the four `read/projections/bom*.sql` files. Read all of them before writing ECO code; the ECO module is a structural clone of that layout.
- Recent commits confirm the repo convention of one integration suite per story named `test/integration/story-<epic>-<story>.test.ts` and canonical SQL living in `read/projections/` at the repo root (NOT under `src/`), with TypeScript accessors under `src/read/projections/`. Getting these two directories confused is the most common path error in this codebase.

### Technical stack (verified at baseline)

Node.js 24 with built-in `node:test` (serial, `--test-concurrency=1`), TypeScript 5.x with strict ESM, PostgreSQL 18.4, hand-rolled router in `src/api/router.ts`, no web framework, no ORM, no test framework beyond `node:test`, no mocking of the database. Do NOT add jest, vitest, express, prisma, knex, or any new runtime dependency. No PostgreSQL extensions (`btree_gist` in particular is excluded), which is why effectivity overlap is enforced in application code rather than by an exclusion constraint.

### Testing requirements

- Framework: built-in `node:test` runner, serial, real PostgreSQL from `.env.test`. If integration tests fail on authentication, `DB_PORT` may need `5442` rather than the committed `5432` (a known environment deferral, `deferred-work.md` line 133).
- Gates that will trip this story: `test/unit/schema-drift.test.ts` (canonical `.sql` versus `deploy/compose/init-db.sql` sync - add the three new tables and the `bom_revision` column), `test/unit/no-hardcoded-role-in-workflow.test.ts` (RBAC through `requireRole` only), `npm run spine-acceptance-contract` (route allowlist in `test/integration/story-1-9.test.ts`).
- Regression suites that MUST stay green because this story changes shared code: `test/integration/story-5-2.test.ts` (27 tests - the release gate and checklist both change shape when `approved_eco` becomes enforced; its happy-path release tests are FIRST releases and stay exempt, but verify each one) and `test/integration/story-5-1.test.ts` (12 tests).

### Project Structure Notes

The file touch map in Table 2 is the authoritative scope boundary; anything outside it needs a recorded reason in the Dev Agent Record. Table 2 lists each file this story creates or updates.

Table 2: File touch map

| **Action** | **Path** | **Change** |
| --- | --- | --- |
| NEW | `read/projections/eco.sql` | ECO header table |
| NEW | `read/projections/eco_change_line.sql` | proposed change lines |
| NEW | `read/projections/eco_stock_disposition.sql` | per-lot disposition decisions |
| NEW | `src/compliance/eco.ts` | shape asserts and lifecycle appliers |
| NEW | `src/read/projections/eco.ts` | ECO read accessors and write helpers |
| NEW | `src/read/projections/where_used_impact.ts` | computed impact analysis |
| NEW | `src/api/v1/ecos.ts` | nine handlers plus DOA resolution |
| NEW | `test/integration/story-5-3.test.ts` | integration suite |
| UPDATE | `read/projections/bom_revision.sql` | `source_eco_id` column and index |
| UPDATE | `deploy/compose/init-db.sql` | byte-for-byte mirror of all four SQL changes |
| UPDATE | `src/events/schema.ts` | six payload and envelope pairs plus registry entries |
| UPDATE | `src/events/migrate.ts` | three new migration entries at the tail |
| UPDATE | `src/events/store.ts` | `assertEcoShape` and `applyEcoProjection` at the two existing seams |
| UPDATE | `src/compliance/bom.ts` | enforce `approved_eco`, un-stage it, cross-revision amend filter |
| UPDATE | `src/read/projections/release_gate_checklist.ts` | `approved_eco` becomes a computed enforced condition |
| UPDATE | `src/read/projections/bom.ts` | `source_eco_id` on `BomRevisionRow` and its helpers |
| UPDATE | `src/read/projections/erp_purchase_order.ts` | open-PO-by-SKU accessor for the impact read |
| UPDATE | `src/api/v1/boms.ts` | cross-revision amend guard in the line handlers |
| UPDATE | `src/server.ts` | Story 5.3 route block |
| UPDATE | `test/integration/story-1-9.test.ts` | `allowedSpineRoutes` additions |
| UPDATE | `test/unit/schema-drift.test.ts` | EXPECTED entries for three new tables and `bom_revision` |
| UPDATE | `_bmad-output/implementation-artifacts/deferred-work.md` | mark the line-210 cross-revision deferral resolved |

`src/notify/emit.ts` is consumed, never modified. `src/api/v1/events.ts` needs no change - the engineering-stream guard added in Story 5.2 already covers `eco.*`.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` - Story 5.3 at lines 1800-1849; Epic 5 at lines 1719-1952; the staged-gate cross-reference at line 1842; FR-B texts at lines 90-108; FR-DOA-01 at line 223.
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` - AD-3 (DOA registry) at lines 84-86, AD-4 (BOM system of record) at lines 88-92, AD-16 (idempotency keys) at lines 160-164, AD-17 (notification coupling) at lines 172-176, module map row "BOM and ECO" at line 260, event envelope at lines 279 onward.
- Previous stories: `_bmad-output/implementation-artifacts/5-2-bom-lifecycle-and-immutability.md` (binding lifecycle and gate design at lines 79-127, four review groups at lines 254-323) and `5-1-multi-level-bom-creation.md`.
- Deferred ledger: `_bmad-output/implementation-artifacts/deferred-work.md` line 210 (cross-revision immutability, closed by this story) and line 133 (test database port).
- Downstream consumers: Story 5.4 (R&D productization gate reuses the DOA approval shape), Story 5.5 (BOM explosion reads the revision this story creates), Story 5.6 (flips `cost_rollup_complete` in the same two places), Epic 6 (registers the open-production-order impact source), Epic 16 (scrap disposition flow the `scrap` decision will eventually route into).

## Dev Agent Record

### Agent Model Used

kilo-auto/frontier (dev-story workflow, 2026-08-11)

### Debug Log References

- `npx tsc --noEmit` clean throughout implementation.
- `npx eslint src/ test/` clean.
- `npx prettier --check` clean after one `--write` pass.
- `node --env-file=.env.test --import tsx src/events/migrate.ts` run twice consecutively - idempotent, no errors, no schema drift.
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts`: 792 tests, 778 pass, 14 fail - all 14 are the documented pre-existing idempotency-replay class (409 vs 201) in stories 1.1, 1.6, 1.8, 2.1-2.4, 2.8, 3.2-3.4, 3.10; 0 new failures.
- `test/integration/story-5-3.test.ts`: 14/14 new tests pass.
- `test/integration/story-5-2.test.ts`: 27/27 pass (one assertion updated for the `approved_eco` un-staging this story performs).
- `test/integration/story-5-1.test.ts`: 12/12 pass, unchanged.
- `test/unit/schema-drift.test.ts`: 64/64 pass (+3 new ECO table entries).
- `npm run spine-acceptance-contract` (lint + `test/integration/story-1-9.test.ts`): 6/6 pass, allowlist extended with the 9 new ECO routes.
- `npm run edge:test`: 30/30 pass, unchanged (no edge/offline path touched).
- `git diff --check`: clean (only benign CRLF-normalization warnings, no conflict markers or trailing whitespace).

### Completion Notes List

- Implemented all 9 tasks. Three new canonical projections (`read/projections/eco.sql`, `eco_change_line.sql`, `eco_stock_disposition.sql`) plus `source_eco_id` on `bom_revision`, mirrored byte-for-byte into `deploy/compose/init-db.sql`, registered at the tail of `src/events/migrate.ts`, and added to `test/unit/schema-drift.test.ts`'s `EXPECTED` table (the generic drift-guard loop covered all three automatically).
- Six new `engineering`-stream events (`eco.raised`, `.review_started`, `.approved`, `.implemented`, `.cancelled`, `.stock_disposition_recorded`) registered in `SUPPORTED_EVENT_TYPES`; only `eco.raised` carries `requiresBusinessStream: true`, mirroring the `bom.drafted` precedent. Wired into `src/events/store.ts` at the two existing seams only (`assertEcoShape` alongside `assertBomShape`; `applyEcoProjection` alongside `applyBomProjection`).
- `src/compliance/eco.ts` is a structural clone of `src/compliance/bom.ts`: local shape guards, a `FOR UPDATE`-locked transition matrix, and one applier per event. `eco.implemented` is the load-bearing applier: it re-derives the affected-lot set (`stock_balance` rows for the target BOM's `parent_sku`, `on_hand > 0`, `lot_id IS NOT NULL`) **inside** the transaction (never trusting the earlier disposition call), rejects `DISPOSITION_REQUIRED` with `details.pending_lots[]` when any lot is undecided, then creates the new `bom_revision` (`source_eco_id` set), copies every `bom_line` of the superseded revision onto it with fresh `bom_line_id`s, and applies each `eco_change_line` (`add` inserts, `amend` updates the copied line, `retire` closes effectivity to the day before `occurred_at`'s IST business date - never deletes). The superseded revision's own rows are never touched, proven by a dedicated re-read assertion in the test suite.
- `src/read/projections/where_used_impact.ts` is a COMPUTED read (the `release_gate_checklist.ts` precedent - no stored table, no migration entry): a depth-capped recursive walk over `bom_line` (never `bom_structure`, which no applier has ever populated) from the ECO's affected components upward to parent assemblies, reporting `depth_truncated: true` when the cap is hit rather than recursing into a possible cycle (Story 5.1 left `BOM_CYCLE_DETECTED` unimplemented). Reuses `getStockBalancesBySku` verbatim; added one new accessor, `getOpenPurchaseOrderLinesBySkus`, to `erp_purchase_order.ts` for the open-PO dimension. `open_production_order_impact` is always `[]` with the `{ available: false, registers_with: 'Epic 6' }` marker.
- AC 9: flipped `approved_eco` out of `STAGED_CONDITIONS` in `src/compliance/bom.ts` into an enforced, computed condition (`isApprovedEcoConditionMet`, exported and reused verbatim by `release_gate_checklist.ts` so the two can never disagree). Exemption predicate: zero prior released revisions for the BOM (excluding the one under release) means first release, met unconditionally - this is what keeps initial release of a brand-new BOM achievable with no ECO in existence yet.
- Closed the Story 5.2 Group 2 deferral (`deferred-work.md` line 210, now marked resolved): `applyBomLineAmended` and the `amendBomLineHandler` pre-check now scope the `bom_line` lookup to `bom_line_id AND revision_id`, not `bom_line_id` alone, so a stale/foreign line from an older, superseded revision 404s instead of being amended in place. Verified with a manufactured second-draft-revision scenario in the test suite, since this story's own ECO path never leaves a new revision in `draft` (it lands `released` directly).
- Nine REST routes in `src/api/v1/ecos.ts` under `engineering`-module RBAC (mutations `write`, reads `read`, never a hard-coded role literal). DOA resolution reuses `resolveApprover` (exported from `indents.ts`) at value `0` (`ECO_DOA_TYPE = 'eco_approval'`, the `suppliers.ts` zero-value precedent), resolved once at raise time and stored on the payload for deterministic replay. The approve handler checks `eco.approver_actor_id !== actor.userId` before building the envelope, copying the `transfer-requests.ts` 403 `APPROVAL_REQUIRED` shape verbatim. `POST /:ecoId/dispositions` resolves `on_hand_qty` server-side from `stock_balance` and rejects an unknown lot with `INVALID_PARAMS`; the client never supplies a quantity. Raise and implement follow AD-16 (`persisted.stream_id` / re-read the projection, never the locally minted id, for the response).
- `src/api/v1/events.ts` needed no change - the Story 5.2 engineering-stream guard already covers `eco.*`; added a dedicated test asserting the rejection with a well-formed envelope.
- Deviation flagged for the Dev Agent Record per the task instructions: `eco.review_started` is a sixth event beyond the five named in the epics dev note, because AC 1 requires `Under Review` to be a reachable state and every state change in this codebase is an event.
- Open Question 1's default (`ECO-<YYYY>-<6-char suffix>`, server-generated) and Open Question 2's default (affected lots = all on-hand lots of the parent SKU) were both applied as stated; no scope expansion beyond them.

### File List

**New:**
- `read/projections/eco.sql`
- `read/projections/eco_change_line.sql`
- `read/projections/eco_stock_disposition.sql`
- `src/compliance/eco.ts`
- `src/read/projections/eco.ts`
- `src/read/projections/where_used_impact.ts`
- `src/api/v1/ecos.ts`
- `test/integration/story-5-3.test.ts`

**Updated:**
- `read/projections/bom_revision.sql` - `source_eco_id` column and index
- `deploy/compose/init-db.sql` - byte-for-byte mirror of all four SQL changes
- `src/events/schema.ts` - six payload/envelope pairs plus registry entries
- `src/events/migrate.ts` - three new migration entries at the tail
- `src/events/store.ts` - `assertEcoShape` and `applyEcoProjection` at the two existing seams
- `src/compliance/bom.ts` - `isApprovedEcoConditionMet`, enforced `approved_eco`, un-staged, cross-revision amend filter
- `src/read/projections/release_gate_checklist.ts` - `approved_eco` becomes a computed enforced condition
- `src/read/projections/erp_purchase_order.ts` - `getOpenPurchaseOrderLinesBySkus` accessor for the impact read
- `src/api/v1/boms.ts` - cross-revision amend guard in the amend-line handler
- `src/server.ts` - Story 5.3 route block
- `test/integration/story-1-9.test.ts` - `allowedSpineRoutes` additions
- `test/unit/schema-drift.test.ts` - EXPECTED entries for the three new tables and `bom_revision`
- `test/integration/story-5-2.test.ts` - one assertion updated for the `approved_eco` un-staging
- `_bmad-output/implementation-artifacts/deferred-work.md` - marked the line-210 cross-revision deferral resolved
- `_bmad-output/implementation-artifacts/sprint-status.yaml` - status updated to `review`

## Change Log

- 2026-08-09: Story created by the create-story workflow.
- 2026-08-11: dev-story workflow implemented all 9 tasks (68 subtasks) from baseline `25084ab`. See Completion Notes for the full summary; status moved from ready-for-dev to review.
- 2026-08-11: adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel, baseline `25084ab`). 23 patch findings applied, 2 dismissed. Key fixes: stale-ECO guard at implement (ECO_STALE), release-gate re-check on the ECO-created revision (A-11 + scrap), revision-code conflict guard, `eco_id`/`eco_number` shape validation and server-side generation, current-revision/effectivity filtering plus cycle guard in the where-used walk, amend/add validation (incl. no-op amend rejection), APPROVAL_UNRESOLVED at raise when no DOA approver resolves, `source_eco_id` moved into `insertBomRevision`, disposition SKU/scale validation, retired-line effective_to honored, and 9 new regression tests. Gates: build, lint, format:check, db:migrate x2, spine 6/6, schema-drift 64/64, edge 30/30, npm test 787/801 (14 pre-existing idempotency failures, 0 new); status moved to done.

## Open Questions

These do not block implementation; each has a stated default already applied above.

1. `eco_number` generation is unspecified by the ACs. Default applied: the raise handler generates `ECO-<YYYY>-<6-char suffix>` server-side and stores it in the `eco.raised` payload for replay determinism. If the business expects an ERP-supplied or strictly sequential number, that is a schema-compatible change to the generator only.
2. AC 5 says a disposition is required "per affected lot" but the system has no revision dimension on stock. The affected-lot definition applied above (all on-hand lots of the parent SKU) is the only computable reading at baseline. Confirm with the change control owner before pilot.
3. `use_up` currently records permission only; nothing consumes it because no production-order consumption path exists until Epic 6. Confirm Epic 6 Story 6.1 is expected to read `eco_stock_disposition` when it lands.

## Review Findings

Review run 2026-08-11 (adversarial pass: Blind Hunter + Edge Case Hunter + Acceptance Auditor, all three in parallel against baseline `25084ab`; no layer failed). 2 findings dismissed, 23 routed to patch and ALL applied same-day, 0 deferred. All QA gates green after the patches (see Change Log).

- [x] [Review][Patch] [HIGH] Stale or concurrent ECO can overwrite a newer implemented revision [src/compliance/eco.ts:646-849, src/compliance/eco.ts:372-405] - `applyEcoRaised` only requires the target revision to be released, never that it equals `bom.current_revision_id`, and `applyEcoImplemented` copies from the stored `target_revision_id` and calls `updateBomCurrentRevision` without re-verifying. Two approved ECOs against the same revision both implement; the second clobbers the first's revision as current and silently drops its changes from the live BOM. Fix: under the bom `FOR UPDATE` lock at implement, require `eco.target_revision_id = bom.current_revision_id` and reject otherwise.
- [x] [Review][Patch] [HIGH] ECO-implemented revisions bypass the release gate (A-11 and scrap checks) [src/compliance/eco.ts:687-704, src/compliance/bom.ts:489-545] - `applyEcoImplemented` inserts the new revision as already `released` without running `evaluateReleaseGate`; copied and added lines are forced `blocking_release: false`, so a deactivated or missing item master can land on a released revision, and `bom.blocking_line_count` is never refreshed (eco.ts:735, 756). Fix: run the item-master-active and scrap-percent checks on the new revision inside the implement transaction before committing, and refresh the blocking count.
- [x] [Review][Patch] [MEDIUM] Revision-code collision mints duplicate codes under concurrency [src/api/v1/ecos.ts:465-467, src/api/v1/ecos.ts:73-78] - `nextRevisionCode(existingRevisions.length)` is computed at capture outside any lock; two concurrent implementations of approved ECOs on the same BOM mint the same code and the second hits `uq_bom_revision_code` as a raw 500. Fix: derive the code under the lock after the stale-ECO guard above.
- [x] [Review][Patch] [MEDIUM] `eco.raised` shape assert omits `eco_id` and `eco_number` validation [src/compliance/eco.ts:261-279, src/api/v1/ecos.ts:119-120] - `assertEcoRaisedShape` validates bom/revision/stream/reason/approver/changes but never `eco_id` or `eco_number`; the raise handler also accepts client-supplied values despite the server-generated contract. A malformed or duplicate value passes the pre-transaction assert and fails inside the DB as a raw 500, violating the malformed-event-never-consumes-idempotency-key rule. Fix: validate both fields in the shape assert and stop accepting client-supplied identifiers (or pre-check uniqueness server-side).
- [x] [Review][Patch] [MEDIUM] Where-used impact walk ignores revision, effectivity, and BOM status [src/read/projections/where_used_impact.ts:90-111] - the ancestry CTE reads `bom_line` across ALL revisions; after an ECO creates a second revision, superseded-revision lines and retired lines (`effective_to` closed) still report BOMs as affected, and on-hold BOMs are walked. Fix: walk only the current released revision of each BOM and respect line effectivity.
- [x] [Review][Patch] [MEDIUM] Recursive impact CTE has no cycle guard; exponential blowup on dense graphs [src/read/projections/where_used_impact.ts:90-111] - only the depth cap terminates the walk; a diamond or cyclic graph re-expands subtrees per level and `BOM_CYCLE_DETECTED` is unimplemented, so a small cyclic structure can produce O(branch^depth) intermediate rows (a denial-of-service vector on the impact endpoint). Fix: add per-path or visited-set dedup (a `CYCLE` clause or equivalent).
- [x] [Review][Patch] [MEDIUM] Amend and add change validation gaps; no-op amend accepted [src/compliance/eco.ts:179-259, src/compliance/eco.ts:777-827] - the amend branch never validates `effective_from`/`effective_to` dates, the add branch never validates `is_phantom` as a boolean or `phantom_source_bom_id` as a UUID, so malformed values surface as raw PG errors (500) at raise; an amend with only `target_bom_line_id` stamps `amended_at` and changes nothing. Fix: validate all field types and require at least one actual field change on amend.
- [x] [Review][Patch] [MEDIUM] ECO raised while no DOA entry exists is permanently unapprovable [src/api/v1/ecos.ts:124, src/api/v1/ecos.ts:270-280] - `resolveApprover` returns a null approver when no `eco_approval` entry exists; the handler stores `approver_actor_id: null` and the approve check (`null !== actor.userId`) then 403s forever, with no re-resolution or repair path. Fix: reject raise with `APPROVAL_UNRESOLVED` when no approver resolves, matching the indent precedent.
- [x] [Review][Patch] [MEDIUM] `source_eco_id` never added to the bom.ts accessor; applier compensates with raw SQL [src/read/projections/bom.ts:274-293, src/compliance/eco.ts:701-704] - `BomRevisionRow` and `insertBomRevision` omit `source_eco_id` (a spec Task 1 touch-map entry), and `applyEcoImplemented` compensates with a raw `UPDATE bom_revision`, the SQL duplication Task 5 forbade. Fix: extend `insertBomRevision` to carry `source_eco_id` and drop the raw UPDATE.
- [x] [Review][Patch] [LOW] Retire silently discards the caller-supplied `effective_to` [src/compliance/eco.ts:827-844, src/compliance/eco.ts:814-821] - amend honors `effective_to` but retire always derives it (the day before the IST date), so a planner-specified retirement date is ignored with no warning. Fix: honor the change's `effective_to` when provided, else derive.
- [x] [Review][Patch] [LOW] Approval notification pairs the approver's role with the raiser's user_id [src/compliance/eco.ts:550-567] - the target uses `metadata.actor.role` (the approver) with `user_id = raised_by` (the raiser); dispatch delivers to the user_id correctly, but the recorded `target_role` is the approver's role, which is misleading audit metadata. Fix: record the raiser's role or omit the role claim.
- [x] [Review][Patch] [LOW] Disposition endpoint accepts lots and SKUs unrelated to the ECO [src/api/v1/ecos.ts:382-405] - the handler only checks that the lot/sku/location exists in `stock_balance`, never that the sku is the ECO's parent sku or that the lot is an affected on-hand lot; unrelated decisions persist misleading rows. Fix: verify the disposition targets the ECO's parent sku and an affected lot.
- [x] [Review][Patch] [LOW] Affected-lot query ignores `stock_class` [src/compliance/eco.ts:635-643, src/api/v1/ecos.ts:383-384] - `stock_balance` carries one row per (sku, lot, location, stock_class); `getAffectedLots` returns duplicate rows per class and the decided set keys on lot_id and location_id alone, so one class's decision satisfies all classes and `on_hand_qty` is arbitrary. Fix: scope to `stock_class` 'owned' and key the decided set accordingly.
- [x] [Review][Patch] [LOW] Disposition `on_hand_qty` loses NUMERIC precision and scale is unvalidated [src/api/v1/ecos.ts:400, src/read/projections/stock_balance.ts:115, src/compliance/eco.ts:313-314] - `getStockBalancesBySku` coerces NUMERIC to a JS number and `String(match.on_hand)` stores "5" not "5.000000"; the shape assert checks only numeric-ness, not scale <= 6, letting PostgreSQL silently round excess scale, against the exact-decimal-strings binding rule. Fix: read the balance as text and add a scale check.
- [x] [Review][Patch] [LOW] Cancelled ECO keeps recorded dispositions visible [src/compliance/eco.ts:570-585, src/read/projections/eco.ts:150-161] - cancellation never touches `eco_stock_disposition`, and `GET /:ecoId` still returns live-looking decisions on a cancelled document. Fix: hide or flag dispositions for non-active ECOs.
- [x] [Review][Patch] [LOW] `MAX_NUMERIC_18_8` is smaller than the `NUMERIC(18,8)` column [src/compliance/eco.ts:49, read/projections/eco_change_line.sql] - the constant allows 8 integer digits but the column allows 10, so valid conversion factors between 10^8 and 10^10 are rejected. Fix: correct the constant to 9999999999.99999999.
- [x] [Review][Patch] [LOW] Decimal-string validator accepts literals PostgreSQL rejects [src/compliance/eco.ts:81-96] - `Number('0x10')` passes the numeric and scale checks, then fails NUMERIC input syntax at insert as a raw 500. Fix: validate with a strict decimal regex.
- [x] [Review][Patch] [LOW] Unbounded offset parameter overflows OFFSET [src/api/v1/ecos.ts:197, src/read/projections/eco.ts:123] - a huge offset string passes the `\d+` guard, `Number()` yields Infinity, and `OFFSET Infinity` throws a PG error (500). Fix: clamp the offset upper bound.
- [x] [Review][Patch] [LOW] Approve rejection leaks the resolved approver's UUID [src/api/v1/ecos.ts:270-278] - the 403 `APPROVAL_REQUIRED` response carries `approver_actor_id` to callers outside the approval chain. Fix: drop the identifier from the response details.
- [x] [Review][Patch] [LOW] `lot_id IS NULL` exclusion is silent in the implement response [src/compliance/eco.ts:635-643, src/api/v1/ecos.ts:497-498] - Dev Notes require recording the exclusion so the decision is visible, but the implement response is the bare ECO projection. Fix: include an excluded-lots note in the response or audit detail.
- [x] [Review][Patch] [LOW] `limit=0` is echoed unclamped while the query runs with 1 [src/api/v1/ecos.ts:196-210, src/read/projections/eco.ts:122] - the handler clamps only the upper bound and echoes it, while `listEcos` floors to 1, so the pagination metadata lies for `limit=0`, the exact Story 5.2 Group 2 defect. Fix: clamp in one place and echo that value.
- [x] [Review][Patch] [LOW] Approve on a cancelled ECO returns 403 `APPROVAL_REQUIRED` instead of 409 `ECO_STATE_INVALID` [src/api/v1/ecos.ts:270-280, src/compliance/eco.ts:540-541] - the authority check runs before the applier's state guard on the approve route, so a cancelled-ECO reject attempt by a non-approver does not surface `ECO_STATE_INVALID` as AC 8 states. Fix: check state before authority on approve, or accept the divergence explicitly.
- [x] [Review][Patch] [LOW] Test coverage misses the riskiest paths [test/integration/story-5-3.test.ts] - no cases for the disposition upsert-correction path, approval-queue list filter, partial dispositions, stale or dual ECOs, multi-revision where-used, `eco_id`/`eco_number` collisions, or amend date and boolean validation. Fix: add regression tests alongside the patches.
