---
baseline_commit: 905a48efae3bbbc3d6b06f2dadec7f3925c0475e
---

# Story 6.4: Lot Genealogy, Closure, and Offline Execution

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a production supervisor,
I want a full as-consumed lot genealogy per output lot, a closure gate that requires zero WIP and QC disposition, and offline execution that replays cleanly,
so that every finished lot is fully traceable and orders close only when truly complete.

This closes Epic 6 (Production Orders and Manufacturing WIP). Baseline: `905a48e` (clean tree, all of 6.1-6.3 committed — see Dev Notes §Baseline for the git-state correction).

## Acceptance Criteria

1. **Given** an output lot produced from consumed materials, **when** its genealogy is queried (FR-MO-11), **then** the full as-consumed lot genealogy is returned, listing every consumed input lot and quantity.
2. **Given** a lot-controlled component (FR-MO-11), **when** consumption is attempted without a recorded lot, **then** the consumption is blocked until a valid lot is recorded.
3. **Given** an order is submitted for closure (FR-MO-12), **when** the closure gate runs, **then** closure succeeds only when WIP is zero, no picks are open, and Epic 8's disposition-status projection shows a recorded QC disposition for every output lot; a non-zero WIP or an undispositioned lot blocks closure.
4. **Given** a Closed production order (FR-MO-12), **when** any issue, completion, return, scrap declaration, or field edit is attempted against it, **then** the attempt is rejected with `error_code: "ORDER_CLOSED"` and written to the edit log — closed orders are immutable.
5. **Given** plant execution occurs offline (FR-MO-13), **when** the device reconnects, **then** replicated order data is replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`, and release, cancel, and close remain central-only operations.
6. **Given** an offline device attempts a release, cancel, or close operation (FR-MO-13), **when** the operation is invoked offline or arrives in a replayed queue, **then** it is blocked client-side while offline and, if replayed, rejected server-side with `error_code: "CENTRAL_ONLY_OPERATION"` and an edit-log entry.
7. **Given** a production order closes (FR-B-08), **when** the closure event is processed, **then** a consumption variance report is generated comparing actual component consumption to the BOM scrap-percent expectation; lines exceeding the tolerance threshold are flagged; the variance data is written to the read model and feeds the scrap-percent recalibration signal for the BOM module.

## Tasks / Subtasks

- [x] **Task 1: As-consumed lot genealogy read model (AC: #1)**
  - [x] Design the genealogy query keyed by output `lot_id` (from `production_completion`). Resolve the completion event that minted the lot (`source_event_id` on `production_completion`), then join `production_wip_ledger` postings (`posting_type IN ('directed_issue','backflush')`) carrying that same `source_event_id`/order to list consumed input lot + quantity.
  - [x] **Binding decision (apply, do not re-litigate):** when one completion event mints multiple output lots (primary + co/by-products), every output lot from that event reports the SAME full consumed-input list. Do not attempt to prorate consumed quantity across output lots — the physical batch of material was consumed jointly and cannot be attributed to one output lot over another. This mirrors the plurality already accepted at the WIP-relief level in Story 6.3 (BD-8 prorates *value*, not *genealogy*).
  - [x] Add `GET /api/v1/production-orders/lots/:lotId/genealogy` (or equivalent path consistent with `src/api/v1/production-orders.ts` route conventions) returning `[{ input_lot_id, input_lot_number, sku, quantity_consumed, uom, component_item_id }]`.
  - [x] Reuse Story 2.3's lot-trace pattern (`getLotByNumberAndSku`, lot UUID bridging) rather than reinventing lot resolution.

- [x] **Task 2: Lot-controlled consumption enforcement (AC: #2)**
  - [x] Verify current state: check whether `src/compliance/production-material.ts` (6.2's material-issue/backflush appliers) already rejects a lot-controlled component's issue/backflush line when no `lot_number`/`lot_id` is supplied. Grep the applier for existing lot-required logic before adding a new guard — Story 2.3's `lot_master`/`item_master` lot-control flag is the authority for "is this component lot-controlled."
  - [x] If missing, add a fail-closed guard in the seam (not just the handler) so a direct `/api/v1/events` post cannot bypass it, per AD-12.

- [x] **Task 3: Closure gate (AC: #3)**
  - [x] Insert the gate in `src/compliance/production-order.ts` at the `completed → closed` edge of `STATE_CHANGE_EDGES` (currently only edge-validity is checked at `applyStateChanged`, `src/compliance/production-order.ts:762-813` — no gate logic exists yet). All checks run under the order row lock, in this order (extends the 6.1-6.3 Locking Contract: order → WIP postings → stock/QC → last):
    1. Zero WIP: `getWipSummary(orderId, client).net_open_quantity` (and value) must be `'0'` — reuse verbatim, do not reimplement (`src/read/projections/production_wip_ledger.ts:267`).
    2. No open picks: zero `production_order_stage` rows with `status = 'allocated'` for the order (this is production's own staging table, NOT Epic 3's `pick_task` — confirmed unrelated per Story 6.2 BD-3; do not query `pick_task`).
    3. Every output lot dispositioned: for every `production_completion` row on the order, `getQcLotDispositionByLotId(lot_id, client)` (`src/read/projections/qc_lot_disposition.ts:164`) must return a non-null row. **Binding decision:** a `disposition = 'split'` row on the parent lot satisfies this check by itself — do not chase down split-child lot dispositions. This matches the literal AC wording (checked at the `production_completion.lot_id` grain) and avoids re-opening Epic 8's own split-child dispositioning question inside this story.
    4. Any failing check blocks closure with the most specific applicable existing error code (do not invent new ones for this step — `INSUFFICIENT_STOCK`-style precedent says use a descriptive existing/registered code family; confirm exact code names against Table 8/permanent-codes registry before finalizing, and register one only if genuinely no equivalent exists).

- [x] **Task 4: Closed-order immutability guard (AC: #4)**
  - [x] Register new permanent error code `ORDER_CLOSED` (does not exist anywhere in the codebase today — confirmed by grep of `schema.ts`/`store.ts`). Add it to backend permanent-codes + i18n resource files + edge permanent-codes (mirror the 7.8/8.x three-surface registration pattern).
  - [x] Add a closed-status branch check **ahead of** the existing generic state-gate checks in every mutating production applier: `src/compliance/production-material.ts` (issue/return), `src/compliance/production-completion.ts` (completion/scrap declaration), and any field-edit path. A closed order must reject with `ORDER_CLOSED`, not fall through to `INVALID_STATE_TRANSITION` (today's 6.2 gate is `released`/`in_process` only, 6.3's is `in_process` only — neither currently distinguishes "closed" from "any other invalid state").
  - [x] **Ambiguity to resolve before implementing:** AC4 says "field edit" but no PATCH/field-edit route exists on `src/api/v1/production-orders.ts` (only `expediting_flag`/`override_reason` set during release). Confirm with the epic/PRD whether "field edit" means an as-yet-undefined edit route (out of scope — skip) or collectively covers the existing mutating routes (issue/return/completion/scrap/transition) — treat it as the latter unless a field-edit route is found elsewhere in the codebase during implementation.
  - [x] Every rejection writes an edit-log entry (existing edit-log helper, same call site pattern as other AD-12 rejections).

- [x] **Task 5: Offline edge capture + central-only guards (AC: #5, #6)**
  - [x] This is the FIRST edge/PowerSync capture module for the `production` stream (none exists after 6.2/6.3, confirmed absent). Model it on `src/sync/upload.ts`'s `assertEdgeQcEventAllowed`/`assertEdgeMaintenanceEventAllowed` and Story 7.8's edge worklist/upload pattern, called from `src/api/v1/edge.ts` before identity/version work (mirror line ~235-238).
  - [x] **Deviation to disclose, not silently copy:** the QC/maintenance precedents gate purely on `event_type` set membership. Production cannot: `release` and `cancel` are distinct event types (`production_order.released`, `production_order.cancelled` — simple set-membership works), but `close` is NOT its own event type — it rides `production_order.state_changed` with `payload.new_status === 'closed'`, the SAME event type that also carries the edge-permittable `in_process → completed` transition (plant-floor completions continue offline per 6.3 BD-12). Write `assertEdgeProductionEventAllowed` to reject `production_order.state_changed` specifically when `payload.new_status === 'closed'`, not the whole event type.
  - [x] `DUPLICATE_EVENT` replay suppression: reuse `persistEvent`'s existing 23505 pkey-mapper path and `findExistingEdgeEvent` sequential check (`src/api/v1/edge.ts:247-253`) — do not reimplement; production events register into the same idempotency machinery as every other stream.
  - [x] Client-side offline blocking (release/cancel/close disabled in the UI/edge client while offline) is out of this backend story's server-testable scope — document the requirement but the story's Testing Requirements only cover the server-side 403 rejection on replay.

- [x] **Task 6: Consumption variance report (AC: #7)**
  - [x] **Fully new — no existing scaffolding.** Grep of `recalibrat|variance` across `src/` returns zero matches; `bom_line.scrap_percent NUMERIC(7,4)` (`read/projections/bom_line.sql:23`) is the only existing input.
  - [x] Design a new append-only read model (e.g. `production_order_variance_line`, one row per `(production_order_id, bom_line_id)`) computed when the closure event (`completed → closed` transition) is processed: `actual_consumed_quantity` from `production_wip_ledger` postings (`directed_issue` + `backflush`, minus `return`) per component, `expected_consumed_quantity` derived from `order_quantity × (1 + bom_line.scrap_percent/100)` off the order's pinned BOM revision (reuse the same revision-pinning the order was released against — do not re-resolve the "current" BOM), `variance_percent`, and a `tolerance_breached` boolean against a new fail-closed config value (e.g. `config.production.consumptionVarianceTolerancePercent`, same pattern as `completionTolerancePercent`).
  - [x] "Feeds the scrap-percent recalibration signal for the BOM module": since no BOM-side consumer exists yet (Epic 5 is complete and has no listener for this), this is a write-only signal table for now — write the variance rows and disclose in Dev Agent Record that no downstream BOM consumer currently reads them (out of scope to build one).
  - [x] Compute inside the same transaction as the closure state-change applier, under the existing lock ordering (order → WIP → variance write, after the Task 3 gate passes, before commit).

- [x] **Task 7: Schema and migrations**
  - [x] Add genealogy support (likely no new table if Task 1 is a pure query over existing `production_wip_ledger`/`production_completion` — confirm before adding a new table).
  - [x] New `production_order_variance_line` table (Task 6), mirrored into `init-db.sql`, pinned in schema-drift tests, migration re-runnable (`db:migrate` twice idempotent, established convention every prior 6.x/7.x/8.x story followed).
  - [x] Any new columns/constraints for closure-gate bookkeeping (e.g. a `closed_at`/`closed_by` pair if not already present on `production_order` — check current columns first; 6.3 already added several).

- [x] **Task 8: REST routes**
  - [x] `GET /api/v1/production-orders/lots/:lotId/genealogy` (Task 1).
  - [x] Extend or confirm the existing `POST /api/v1/production-orders/:orderId/transition` (`src/server.ts:931`) is the single route the `completed → closed` gate hooks into — do not add a parallel closure-specific route unless the transition route's shape cannot carry the gate's failure detail.
  - [x] `GET` route for the variance report per order (Task 6 read surface).
  - [x] Register all new routes in the Story 1.9 spine allowlist (every prior story in this epic needed this; check it before marking done — Story 6.3 had to fix a stale allowlist gap from 8.4).

- [x] **Task 9: Tests (`test/integration/story-6-4.test.ts`)**
  - [x] Bootstrap from `test/integration/story-6-3.test.ts`'s before-hook (migration order, trigger disable/enable, TRUNCATE list extended for `production_order_variance_line`), same `makeRequest`/`authFor`/`provisionUser`/`assertNumericEqual` helpers, `describe('Story 6.4 Lot Genealogy, Closure, and Offline Execution', ...)`.
  - [x] One test per AC (AC1-AC7), then the established trailing block: status-gate tests, replay/idempotency (same-key), AD-12 forged-direct-event bypass (seam enforces even when handler is bypassed), RBAC/plant-scoping, read-surface listing, then concurrency/edge-case wave (two-parallel-writer races on the closure gate, cross-order idempotency-key reuse).
  - [x] Multi-output-lot completion (primary + co-product) genealogy test asserting the "same full input list for every output lot" decision from Task 1.
  - [x] Split-disposition closure test asserting a parent lot's own `disposition='split'` row is sufficient to pass the gate (Task 3 decision).
  - [x] `ORDER_CLOSED` rejection test against issue/completion/return/scrap on a closed order, each producing an edit-log entry.
  - [x] Edge-route test: `production_order.state_changed` with `new_status: 'in_process'`→`'completed'` accepted via edge; the same event type with `new_status: 'closed'` rejected `CENTRAL_ONLY_OPERATION`; `production_order.released`/`.cancelled` rejected outright via edge.

## Dev Notes

### Baseline (correcting stale session memory)

HEAD is `905a48e` ("8-6 COMPLETE"), branch `master`, working tree clean. All of Story 6.3's files (including `production-completion.ts`, `production_completion.sql`, `rework-order.ts`) are committed as of `df7f3c3`. Prior in-session notes claiming 6.3 was "uncommitted" are stale — verify with `git log --oneline -15` and `git status` yourself if in doubt, do not trust chat history over git.

### What already exists (reuse, do not rebuild)

| Object | Location | Use for |
|---|---|---|
| `production_order` (status enum `planned/released/in_process/completed/closed/cancelled`) | `read/projections/production_order.sql:25-64`; TS `src/read/projections/production_order.ts` | Closure gate target row; `getProductionOrderByIdForUpdate` for the lock |
| `production_wip_ledger` (append-only, `posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief')`) | `read/projections/production_wip_ledger.sql:36-66`; TS `src/read/projections/production_wip_ledger.ts` | `getWipSummary(orderId, client)` (line 267) = zero-WIP check; postings also feed genealogy (Task 1) and variance (Task 6) |
| `production_order_stage` (grain `(production_order_id, bom_line_id)`, `status CHECK ('allocated','issued')`) | `read/projections/production_order_stage.sql`; TS `src/read/projections/production_order_stage.ts` | "No open picks" = zero rows with `status='allocated'`. This is NOT Epic 3's `pick_task` (`src/read/projections/pick_task.ts`) — that table is sales-dispatch scoped and irrelevant here (Story 6.2 BD-3) |
| `production_completion` (one row per output lot, `output_class IN ('primary','co_product','by_product')`, `lot_id UUID UNIQUE`) | `read/projections/production_completion.sql:26-52`; TS `src/read/projections/production_completion.ts` | Enumerates the output lots the closure gate must check dispositions for |
| `qc_lot_disposition` (one row per lot, `disposition CHECK IN ('conditional_release','accept','reject','split')`, `UNIQUE(lot_id)`) | `read/projections/qc_lot_disposition.sql:32-56`; TS `getQcLotDispositionByLotId` at `src/read/projections/qc_lot_disposition.ts:164` | The disposition-status read for Task 3 check 3 |
| State-machine edges + applier | `src/compliance/production-order.ts:74-78` (`STATE_CHANGE_EDGES`), `applyStateChanged` at lines 762-813 | Insert the closure gate here at the `completed→closed` edge — no gate logic exists there today |
| Transition route | `POST /api/v1/production-orders/:orderId/transition`, `src/server.ts:931`, handler `transitionProductionOrderHandler` | The route the closure gate fires through |
| `CENTRAL_ONLY_OPERATION` pattern | `assertEdgeQcEventAllowed`/`assertEdgeMaintenanceEventAllowed`, `src/sync/upload.ts:214-239`, called from `src/api/v1/edge.ts:235-238` | Model for Task 5's `assertEdgeProductionEventAllowed` — but see the deviation noted in Task 5 (production's `close` is not a distinct event type) |
| `DUPLICATE_EVENT` replay | `src/api/v1/edge.ts:247-253` (`findExistingEdgeEvent`) + `persistEvent`'s 23505 pkey-mapper path in `src/events/store.ts` | Reuse verbatim for production edge events |
| `bom_line.scrap_percent NUMERIC(7,4)` | `read/projections/bom_line.sql:23`, CHECK at line 39 | Expected-consumption input for Task 6's variance calc |

### Binding decisions made by this story file (apply as written; do not re-derive)

1. **Genealogy grain**: all output lots minted by the same completion event share the identical full consumed-input list; quantity is NOT prorated per output lot (Task 1). Physical material was consumed jointly.
2. **"No open picks"** reads `production_order_stage.status='allocated'` count, never `pick_task` (Task 3).
3. **Split-disposition satisfies closure**: a `disposition='split'` row on the parent output lot itself is sufficient; child-lot dispositions from the split are out of scope for this gate (Task 3).
4. **`ORDER_CLOSED` is new** — register across backend/edge/i18n like every prior story's new codes; do not conflate with `INVALID_STATE_TRANSITION` (Task 4).
5. **Edge central-only guard for production is event-type-plus-payload-inspection**, not pure event-type-set membership like the QC/maintenance precedents, because `close` shares an event type with the edge-permittable `completed` transition (Task 5).
6. **Consumption variance is write-only** for this story; no BOM-side consumer exists to wire up (Task 6).

### Unresolved ambiguity to flag, not silently guess

AC4's "field edit" has no corresponding route today (`src/api/v1/production-orders.ts` has no PATCH/field-edit endpoint). Do not invent a new edit route to satisfy this literally — treat AC4 as covering the existing mutating routes (issue/return/completion/scrap/transition) unless you find an as-yet-undiscovered field-edit route during implementation. Document whichever interpretation is taken in the Dev Agent Record.

### Architecture constraints (ARCHITECTURE-SPINE.md)

- **AD-1**: edge devices write to local SQLite, not the central API; central plane is reconciliation authority only. The "captured, pending sync" degraded-state UI requirement is a client concern, not server-testable here.
- **AD-5**: production WIP and R&D project WIP are separate ledgers/stream types; never post to both from one transaction (not directly triggered by 6.4, but do not violate it while touching `production_wip_ledger`).
- **AD-12**: compliance spine (edit log, DOA, business-stream tagging, event-sourced location, calibration lockout) is the bottom dependency layer — every check in Tasks 3/4/5 must live in the seam (`src/compliance/production-order.ts` / `production-material.ts` / `production-completion.ts`), not only the HTTP handler, so a direct `POST /api/v1/events` or edge upload cannot bypass it.
- **AD-14**: read models are projections built from the event stream; no module reaches into another module's tables directly. Task 1's genealogy query and Task 6's variance calc read `production_wip_ledger`/`qc_lot_disposition` through their existing accessors, not raw cross-module SQL.
- **AD-16**: every multi-device command carries `idempotency_key`; duplicates return 409 with the existing event ID. Applies to the new production edge events exactly as it does everywhere else.
- Locking Contract (story-local convention, not spine text): order row → WIP postings → stock/QC rows, established progressively by 6.1-6.3. Task 3's gate and Task 6's variance write must respect this ordering, acquiring the order lock first.

### Testing standards

Test DB is the Docker container `ims-postgres-test` on port 5442 — must be running before `npm test`; use `--test-concurrency=1`. One integration file per story (`test/integration/story-6-4.test.ts`), bootstrapped from the prior story's before-hook. One `it()` per AC, then trailing groups in the established order: status-gate, replay/idempotency, AD-12 forged-direct-event bypass, RBAC/plant-scoping, read-surface listing, concurrency/edge-case wave. Gates every prior 6.x/7.x/8.x story ran clean before "done": `tsc`/`eslint`/`prettier` clean, `db:migrate` re-run twice idempotent, schema-drift test suite green (add entries for every new table/column), Story 1.9 spine allowlist updated for new routes, full `npm test` suite run with 0 new failures against whatever the pre-existing baseline count is at `905a48e` (confirm the current count yourself — it has moved every story, do not assume it's still 26).

### Project Structure Notes

- No conflicts with the unified structure: new files follow the existing `src/compliance/production-*.ts` (seam), `src/read/projections/production_*.ts` + matching `.sql` (projection), `src/api/v1/production-orders.ts` (routes), `test/integration/story-6-4.test.ts` (tests) layout used by 6.1-6.3.
- This is the first story to add an edge/PowerSync module for the `production` stream — no existing `src/sync/production-*.ts`-equivalent file to extend; model it on the QC/maintenance edge modules in `src/sync/upload.ts` and Story 7.8's edge worklist pattern, but do not literally copy the pure-event-type-set gating (see Task 5 deviation).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 6.4] — acceptance criteria verbatim.
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 6] — epic framing, Epic 8 dependency ordering.
- [Source: _bmad-output/implementation-artifacts/6-2-material-staging-issue-and-wip-ledger.md] — WIP ledger contract, BD-3 (production_order_stage vs pick_task), BD-13 (explicit 6.4 ownership boundary).
- [Source: _bmad-output/implementation-artifacts/6-3-production-completions-and-qc-hand-off.md] — production_completion shape, BD-8 (value proration precedent), BD-11/BD-12/BD-14 (closure-gate and offline-scope reservations for this story).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] — AD-1, AD-5, AD-12, AD-14, AD-16.

### Review Findings

Code review, 2026-09-01. 3 layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor), 3 decisions resolved, 8 patches applied, 6 deferred, 4 dismissed as noise.

- [x] [Review][Patch] `assertLotRecordedForControlledComponent` fail-open on unresolved `component_item_id` [src/compliance/production-material.ts:423] — now rejects LOT_REQUIRED instead of silently permitting a lot-less consumption.
- [x] [Review][Patch] Closure gate's undispositioned-lot check silently ignored completions past row 200 [src/compliance/production-order.ts:423] — now paginates to exhaustion.
- [x] [Review][Patch] Genealogy response omits `uom`, contradicting Task 1's own response-shape contract [src/production/lot-genealogy.ts] — added, sourced from item_master.
- [x] [Review][Patch] Edge central-only guard fails open (falls through to allowlist) on a missing/malformed `new_status` payload field [src/sync/upload.ts:292] — now fails closed.
- [x] [Review][Patch] Scrap-percent division-by-zero unguarded at closure [src/production/consumption-variance.ts:107] — rejects `INVALID_SCRAP_PERCENT` for `scrap_percent <= -100` instead of surfacing a raw SQL error.
- [x] [Review][Patch] Variance-computation degradation at closure was silent [src/production/consumption-variance.ts:151] — logged now (decision: proceed with closure, do not block, per user).
- [x] [Review][Patch] `basis_quantity` (completed qty, not `order_quantity`) undisclosed deviation from AC7's literal text [story Debug Log Reference #11] — documented (decision: keep as-is, per user).
- [x] [Review][Defer] Permanent error-code lists hand-duplicated across `edge/src/sync/connector.ts` and `src/sync/upload.ts` with no shared constant [both files] — deferred, requires a cross-package structural change (edge is a separately built package); pre-existing pattern from prior stories, not introduced fresh by the duplication risk alone.
- [x] [Review][Defer] Genealogy over-reports for orders with multiple sequential completions (order-scoped, not completion-scoped, consumption window) [src/production/lot-genealogy.ts] — deferred per user decision; architecturally deep (ledger doesn't tie postings to individual completions), matches current documented design intent.
- [x] [Review][Defer] `consumption-variance.ts` requirementByLine map silently overwrites on a same-bom_line_id collision across supply methods — contradicts the file's own "disjoint by construction" comment; low probability, no reproduction path found.
- [x] [Review][Defer] `getActualConsumptionByLine` SQL's `bool_or`/`MIN` aggregation misrepresents `supply_method`/item/sku when a single BOM line has both directed-issue and backflush postings on one order — same low-probability collision as above.
- [x] [Review][Defer] Variance line silently dropped (no log) when ledger data can't identify `component_item_id`/`component_sku` [src/production/consumption-variance.ts:~1521] — no audit trail; low priority given the underlying ledger-integrity gap would surface elsewhere first.
- [x] [Review][Defer] `assertClosureAllowed`'s WIP-zero numeric cast has no try/catch around a bad-shape DB error [src/compliance/production-order.ts] — would 500 instead of a clean gate rejection on a WIP-projection data-shape regression; not caused by this story.

Dismissed as noise: return-postings-after-cutoff not netted in genealogy (matches documented design intent, not a bug); `\d{1,3}` scrap-percent regex admitting out-of-range values before the separate numeric bound check (defense-in-depth already catches it); new error code `CLOSURE_GATE_BLOCKED` undisclosed in Debug Log (process-only, harmless); genealogy response wraps `inputs` in an object rather than the literal bare-array shape (functional improvement, harmless).

## Dev Agent Record

### Agent Model Used

Opus 5 (claude-opus-5), 2026-09-01. Baseline `905a48e` (clean tree, verified).

### Debug Log References

**Disclosed deviations and decisions taken during implementation.**

1. **The consumption variance report degrades instead of blocking closure.** `resolveMaterialRequirements` rejects `BOM_REVISION_DRIFT` when the BOM moved since release, which is the right answer for execution but not for closure: an engineering change made after the last confirmation would otherwise trap a finished order in `completed` forever. `computeConsumptionVariance` catches any `AppError` from the resolver, writes no rows, and records `variance.computed = false` with `unavailable_reason` on the closure event. Closure still succeeds. This path has no integration test (constructing a post-release revision move on a finished order needs an ECO flow that is Story 5.3's, not this story's) - the code path is exercised only by inspection.

2. **The zero-scrap basis is derived by division, not by `base_quantity_per`.** `expected_base_quantity = required_quantity / (1 + scrap_percent/100)`. `base_quantity_per` is the line's factor against its immediate BOM parent, so on a multi-level explosion it is not a per-unit-of-finished-good figure and would understate the expectation at every intermediate level. Dividing the already-exploded requirement by its own scrap factor removes exactly the allowance being recalibrated, at any depth.

3. **The edge central-only guard inspects one payload field**, unlike its QC and maintenance predecessors which gate purely on event-type membership. `close` is not its own event type - it is `production_order.state_changed` with `new_status: 'closed'`, an event type that also carries the `in_process -> completed` transition a plant device legitimately records offline. The predicate is checked BEFORE the allowlist so widening `EDGE_PRODUCTION_EVENT_TYPES` alone can never admit a closure. Mutation-verified: forcing the predicate to `false` fails the AC6 test.

4. **AC4 "field edit" resolved as the existing mutating routes.** No PATCH/field-edit endpoint exists on `production-orders.ts` (confirmed by inspection), and none was invented. `ORDER_CLOSED` is raised by the staging, issue, return, confirmation, completion, scrap and short-close paths.

5. **`ORDER_CLOSED` needed handler mirrors, not just the seam.** The first test run proved the seam guard was unreachable through REST: `assertMaterialState` / `assertInProcess` answered the generic `INVALID_STATE_TRANSITION` before the request ever reached `persistEvent`. Both handlers now raise `ORDER_CLOSED` themselves, mirroring the seam (which still owns the direct-event path). This is a defect the test found, not a design choice.

6. **The AC4 and AC6 edit-log rows required new plumbing.** Both acceptance criteria say the *refusal* is written to the edit log, but a rejection that never reaches `persistEvent` has no transaction to ride. `logRejectionAudit` (new, in `audit_log.ts`) wraps the connect/log/release boilerplate the Story 6.1 AC7 override wrote inline; it never throws, so an edit-log failure cannot turn a clean 4xx into a 500. The completions handler instead uses its own existing `AUDITED_REJECTIONS` set, which `ORDER_CLOSED` was added to.

7. **Genealogy is order-scoped up to the completion instant, not event-scoped.** Filtering `production_wip_ledger` by the completion's own `source_event_id` returns an EMPTY input list on every normal order, because material is issued in its own events long before the completion consumes it. The query therefore takes every issue/backflush posting on the order with `occurred_at <= completed_at`, nets returns off it, and drops lines that net to zero.

8. **No genealogy table was added.** The genealogy is already a fact of the ledger; a third projection would be a second copy and a desync surface. Task 7's "confirm before adding a new table" was resolved as "do not add one".

9. **Two guards mutation-verified** (each mutant fails exactly the test that owns it, then reverted): the closure gate's disposition check (`if (disposition === null)` -> `if (false)`) and the edge close predicate (above).

10. **Baseline noise floor is 28, not 26 - and measuring it exposed a repo hazard.** Stashing this story's work and running the full suite at pristine `905a48e` gave 1545 tests / 30 failures; the restored branch gave 1571 tests / 30 failures with a **byte-identical** failing-name set. Two of those 30 were an artefact of the measurement itself: `git stash`/`stash pop` rewrote `deploy/compose/init-db.sql` with CRLF endings under `core.autocrlf`, while the canonical `read/projections/*.sql` files stayed LF, so the mirror assertions for `label_master` and `gate_dwell_metric` stopped matching. Both files were normalised back to LF (the state `init-db.sql` was committed in, and the state this story appended to it in). Final measured state: **1571 tests, 28 failures, 0 new against the baseline set and those 2 CRLF failures fixed.** The true pre-existing floor is therefore 28. Anyone repeating a stash-based baseline comparison on this repo should re-check line endings before trusting the drift results.

11. **Code review 2026-09-01, disclosed post-hoc: `basis_quantity` is the cumulative COMPLETED quantity (`getCompletedPrimaryQuantity`), not `order_quantity`.** AC7's text reads `order_quantity x (1 + scrap_percent/100)`, but a short-closed order (completed quantity less than the planned order quantity) measured against `order_quantity` would report every component as under-consumed by construction, drowning genuine variance signal in a false positive that repeats on every short-close. `basis_quantity` uses what was actually built. This was not called out in the Debug Log at the time; recorded now per code review.

12. **Edge workspace: 45 tests, 44 pass, 1 pre-existing failure** (`registers the three localOnly worklist cache tables and no new synced table` expects no `held_lot` table; `held_lot` was added by Story 8.5 in commit `ce5989c`). This story touched only `edge/src/sync/connector.ts` and `edge/src/messages/en.json`; neither the edge schema nor that test.

**Gates:** `tsc` clean, `eslint` clean, `npm run build` clean, `prettier` clean on every touched file, `db:migrate` run twice idempotently, schema-drift 138/138 (+1), story-6-4 25/25, story-6-1/6-2/6-3 + spine 1-9 + drift 247/247, story-8-1/8-3/8-4 + 7-8 + 1-8 128/128, edge workspace 44/45 (1 pre-existing), full suite 1571 tests / 28 failures - 0 new against the pristine-baseline set, 2 CRLF drift failures fixed.

### Completion Notes List

- **Task 1 (AC1)** - `src/production/lot-genealogy.ts`, a pure read-and-compute service in the `material-staging.ts` mould. Nets returns against their source postings in SQL NUMERIC, bridges the ledger's lot NUMBER to the `lot_master` UUID per (lot_number, sku), and reports `shares_inputs_with_sibling_lots` so a reader can see when a list is jointly owned. Binding decision implemented as written: sibling output lots from one completion event report the identical, un-prorated input list.
- **Task 2 (AC2)** - `assertLotRecordedForControlledComponent` in the 6.2 seam, applied at staging (declared lines) and after the backflush drain (resolved postings). Reuses `ERROR_CODES.LOT_REQUIRED` and the serial-takes-precedence rule from `lot-serial-validation.ts` rather than inventing a parallel one.
- **Task 3 (AC3)** - `assertClosureAllowed` at the `completed -> closed` edge of the existing `applyStateChanged`. All three checks run even when an earlier one fails, so the operator gets every blocker in one 409 `CLOSURE_GATE_BLOCKED` with `blocking_reasons`. Zero-WIP reuses `getWipSummary` verbatim; "no open picks" reads `production_order_stage.status = 'allocated'` and never `pick_task`; a `split` parent disposition satisfies the gate.
- **Task 4 (AC4)** - new permanent code `ORDER_CLOSED`, registered across the backend permanent set, the edge connector twin and `en.json`. Enforced in the seam (`assertOrderNotClosed`, shared by the material and completion seams) and mirrored in both handlers, with the refusal audited.
- **Task 5 (AC5, AC6)** - `assertEdgeProductionEventAllowed` in `src/sync/upload.ts`, called from the edge upload route before any identity or version work; `DUPLICATE_EVENT` replay suppression reuses the existing `findExistingEdgeEvent` and 23505 paths untouched. **Scope note:** this is the server-side contract only. No device-side capture UI or PowerSync bucket for the production stream was built - the task's own final subtask scoped client-side offline blocking out, and the Testing Requirements cover only the server-side rejection.
- **Task 6 (AC7)** - `src/production/consumption-variance.ts` plus the `production_consumption_variance` projection. Every derived figure (variance quantity, variance percent, implied scrap percent, the breach decision) is computed in SQL NUMERIC inside the INSERT, so a forged closure payload cannot claim a line is within tolerance. New fail-closed config `PRODUCTION_CONSUMPTION_VARIANCE_TOLERANCE_PERCENT` (default 10), bounded exactly like `completionTolerancePercent`.
- **Task 7** - one new table, mirrored into `init-db.sql`, appended to the migration list and pinned in schema-drift. No new columns on existing tables were needed.
- **Task 8** - two new read routes, both plant-scoped, both added to the Story 1.9 spine allowlist. The genealogy route authorises on the owning order BEFORE computing anything (the 6.3 rework-route leak lesson).
- **Task 9** - `test/integration/story-6-4.test.ts`, 25 tests: one or more per AC, plus AD-12 forged-derivation and direct-event-gate tests, AD-16 replay, a two-writer concurrency race, RBAC scoping and param validation.

### File List

**New**

- `read/projections/production_consumption_variance.sql`
- `src/read/projections/production_consumption_variance.ts`
- `src/production/lot-genealogy.ts`
- `src/production/consumption-variance.ts`
- `test/integration/story-6-4.test.ts`

**Modified**

- `deploy/compose/init-db.sql` (mirror of the new projection)
- `src/events/migrate.ts` (migration list entry)
- `src/events/schema.ts` (derived `closure_checks` / `variance` fields on the state-changed payload contract)
- `src/compliance/production-order.ts` (closure gate, variance write, derived-field guard)
- `src/compliance/production-material.ts` (`assertOrderNotClosed`, `assertLotRecordedForControlledComponent`, backflush lot check)
- `src/compliance/production-completion.ts` (`ORDER_CLOSED` in both status gates)
- `src/api/v1/production-orders.ts` (genealogy and variance routes)
- `src/api/v1/production-material.ts` (`ORDER_CLOSED` handler mirror + audit)
- `src/api/v1/production-completions.ts` (`ORDER_CLOSED` handler mirror, added to `AUDITED_REJECTIONS`)
- `src/api/v1/edge.ts` (production allowlist call + central-only audit write)
- `src/sync/upload.ts` (`assertEdgeProductionEventAllowed`, production permanent codes)
- `src/read/projections/audit_log.ts` (`logRejectionAudit`)
- `src/config/index.ts` (`consumptionVarianceTolerancePercent`)
- `src/server.ts` (route registration)
- `edge/src/sync/connector.ts` (permanent-code twin block)
- `edge/src/messages/en.json` (16 new error messages)
- `test/integration/story-1-9.test.ts` (spine allowlist)
- `test/unit/schema-drift.test.ts` (new table pin)

## Change Log

| Date | Change |
|------|--------|
| 2026-09-01 | Story 6.4 implemented from baseline `905a48e`. All 9 tasks complete; 25 story tests green; full suite 1571 tests with 28 failures, 0 new against a pristine-baseline run (and 2 CRLF mirror failures fixed). Status moved to review. |
