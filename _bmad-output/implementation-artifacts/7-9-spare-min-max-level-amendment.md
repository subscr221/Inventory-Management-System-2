---
baseline_commit: 062fbe470744b5c0fc44e3b654cd3811f2e2e992
---
# Story 7.9: Spare Min-Max Level Amendment

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a maintenance storekeeper,
I want to amend the min-max levels of a catalogued critical spare without re-cataloguing it,
so that stocking levels that change monthly stay current and the same-day breach alert (Story 7.4) keeps firing against the right thresholds.

## Acceptance Criteria

1. **Given** a spare already catalogued under Story 7.4 (FR-M-09) **when** the storekeeper submits new min and max levels for it **then** an amendment event is recorded against the existing catalogue row, the alert evaluation uses the new levels from the next sweep, and the previous levels remain readable in the row's history.
2. **Given** an amendment whose min is not below its max, or whose spare is not catalogued **when** it is submitted **then** it is refused with an explicit `error_code` and no row changes.
3. **Given** a second POST of the original catalogue shape on an occupied `(sku, location)` key **when** it is submitted **then** it is still refused `SPARE_ALREADY_CATALOGUED`; amendment is the only edit path.

## Tasks / Subtasks

- [x] Task 1: Event contract (AC: 1, 2)
  - [x] 1.1 Add `SpareCatalogueAmendedPayload` and `SpareCatalogueAmendedEnvelope` interfaces to `src/events/schema.ts`, placed immediately after the existing `SpareCataloguedEnvelope` block (around line 2492).
  - [x] 1.2 Register `'maintenance.spare_catalogue_amended'` in the `SUPPORTED_EVENT_TYPES` registry (the Story 7.4 block, around line 6081) with `streamType: 'maintenance'`, `requiresBusinessStream: false`.
- [x] Task 2: Compliance seam (AC: 1, 2)
  - [x] 2.1 Add `'maintenance.spare_catalogue_amended'` to `MAINTENANCE_SPARE_EVENT_TYPES` in `src/compliance/maintenance-spares.ts` (line 64).
  - [x] 2.2 Write `assertSpareCatalogueAmendedShape(p)`: `sku` non-empty, `location_id` a UUID, `min_level`/`max_level` each null or a non-negative NUMERIC string (reuse `isNonNegativeNumericString`), and when BOTH are present as strings, `max_level >= min_level` (`INVALID_MIN_MAX`) — this mirrors `assertSpareCataloguedShape` (lines 189-221) but does NOT check "critical needs min" here, because that check needs the existing row's `is_critical` and this function runs pre-transaction with no database access (see 2.3).
  - [x] 2.3 Write `applySpareCatalogueAmended(envelope, client)`: lock the catalogue row with `getSpareCatalogueByGrain(sku, locationId, client, true)`; if null, `reject('SPARE_NOT_CATALOGUED', ..., 422)` (AC2, reusing the exact code and status Table 6 already defines for "this spare is not catalogued"); if the row's `is_critical === true` and the new `min_level` is null, `reject('INVALID_MIN_MAX', 'a critical spare requires a min_level', ...)` — the SAME message shape as `assertSpareCataloguedShape` line 219, just evaluated against the LOCKED row's `is_critical` instead of a payload field; write `p['catalogue_id'] = catalogue.catalogue_id`, `p['previous_min_level'] = catalogue.min_level`, `p['previous_max_level'] = catalogue.max_level` onto the payload BEFORE the `domain_events` insert (the same write-back idiom `applySpareIssued` uses for `return_due_date` at line 659 — `envelope.payload` is the same object reference the INSERT statement persists, confirmed at `src/events/store.ts:1221` running before the INSERT at `:1366`); then call `updateSpareCatalogueLevels`.
  - [x] 2.4 Wire the new case into the `assertMaintenanceSpareShape` switch (line 161) and the `applyMaintenanceSpareProjection` switch (line 376).
  - [x] 2.5 No new 23505 duplicate resolver needed: this event does not insert a row or touch a unique index, only updates an existing one under a lock already held.
- [x] Task 3: Projection accessor (AC: 1)
  - [x] 3.1 Add `updateSpareCatalogueLevels(catalogueId: string, minLevel: string | null, maxLevel: string | null, client: PoolClient): Promise<number>` to `src/read/projections/maintenance_spare_catalogue.ts`, mirroring `markSpareReservationIssued`'s shape in `maintenance_spare_reservation.ts:116-129` (`UPDATE ... SET min_level = $2::numeric, max_level = $3::numeric, updated_at = now() WHERE catalogue_id = $1`, return `result.rowCount ?? 0`). No `WHERE` status guard is needed (the catalogue row has no lifecycle state), but treat a `0` return as a defensive `SPARE_NOT_CATALOGUED` reject rather than a silent no-op, matching the codebase-wide "never silently no-op" rule.
- [x] Task 4: API route (AC: 1, 2, 3)
  - [x] 4.1 Add `amendSpareBase: RouteHandler` in `src/api/v1/maintenance.ts`, placed after `listSparesBase` (line 2076) and before `scanSparesBase`. Reuse `requireSku`, `requireUuidField`, `numericStringOrNull` exactly as `createSpareBase` does (lines 2004-2035): parse `sku`, `location_id`, optional-nullable `min_level`/`max_level` (same numeric-format checks `createSpareBase` runs; the `max >= min` and critical-needs-min semantic checks stay in the seam per Task 2, do not duplicate them here).
  - [x] 4.2 Handler pre-check (fast-fail before minting an event, mirroring `issueSpareBase`'s unlocked `getSpareReservationById` read at line 2430): call `getSpareCatalogueByGrain(sku, locationId)` unlocked; if null, throw `AppError(422, 'SPARE_NOT_CATALOGUED', ...)` immediately. This is a UX fast-path only — the seam's own locked lookup in Task 2.3 is the authoritative check and is what actually protects the direct-`POST /api/v1/events` path.
  - [x] 4.3 `persistEvent` with `stream_type: 'maintenance'`, `stream_id: existing.catalogue_id` (the row's own id, matching how `issueSpareBase`/`returnSpareBase`/`cancelSpareReservationBase` use the existing `reservation_id` as `stream_id` for a mutate-in-place event — NOT a freshly minted id), `event_type: 'maintenance.spare_catalogue_amended'`, payload `{ sku, location_id: locationId, min_level: minLevel, max_level: maxLevel }` (no `catalogue_id` in the outbound payload — the seam derives and writes it back per Task 2.3, so there is nothing for a caller to get wrong).
  - [x] 4.4 `replayIdOrReject(persisted, 'maintenance.spare_catalogue_amended', 'catalogue_id')`, then read the current row back BY ID with `getSpareCatalogueById(persistedCatalogueId)` for the response (same read-back-by-id rule `createSpareBase` follows at lines 2062-2069). Respond `200 { event_id, spare }` (200, not 201: this amends an existing resource, it does not create one).
  - [x] 4.5 Export `amendSpareHandler = requireRole({ module: 'maintenance', functionScope: 'write' })(amendSpareBase)` — the SAME module/scope as `createSpareHandler` (lines 2585-2588); no new role is introduced.
  - [x] 4.6 Register `router.post('/api/v1/maintenance/spares/amend', amendSpareHandler);` in `src/server.ts`, placed alongside the other static `/spares/...` routes (next to `router.post('/api/v1/maintenance/spares/scan', ...)` / `.../alerts`, line 909-910) and BEFORE `router.get('/api/v1/maintenance/spares/:sku/where-used', ...)` at line 911 — the same static-before-dynamic ordering rule Story 7.4 documented (a literal second path segment can never be shadowed by `:sku/where-used`'s three-segment shape, but keep the convention).
  - [x] 4.7 Add `'POST /api/v1/maintenance/spares/amend'` to the `allowedSpineRoutes` list in `test/integration/story-1-9.test.ts` (next to the other `/spares` entries, lines 466-470) — every registered route must appear there or the Story 1.9 spine gate fails closed.
- [x] Task 5: Tests (AC: 1, 2, 3)
  - [x] 5.1 Create `test/integration/story-7-9.test.ts` bootstrapped exactly like `test/integration/story-7-4.test.ts` (same harness, same `maintenance_storekeeper` fixture user — reuse the Story 7.4 fixture, do not create a second one).
  - [x] 5.2 AC1 happy path: catalogue a critical spare (Story 7.4 route), amend its levels, assert the row reflects the new `min_level`/`max_level`, assert `getSpareCatalogueByGrain` still resolves the SAME `catalogue_id` (row updated in place, not replaced), and assert the previous levels are readable by querying `domain_events` for the `maintenance.spare_catalogue_amended` row and reading `payload.previous_min_level` / `payload.previous_max_level` (this IS "the row's history" per AC1 — there is no separate history table; the event log is the audit trail, consistent with every other story in this codebase).
  - [x] 5.3 AC2 `INVALID_MIN_MAX`: submit `max_level < min_level`; assert 400 and no row change (re-fetch and compare to the pre-amend snapshot).
  - [x] 5.4 AC2 `SPARE_NOT_CATALOGUED`: submit an amendment for a `(sku, location_id)` pair that was never catalogued; assert 422 and that the direct-`persistEvent(... as any)` path (bypassing the handler's pre-check) hits the SAME code from the seam.
  - [x] 5.5 AC2 critical-needs-min: catalogue a critical spare, then amend with `min_level: null`; assert `INVALID_MIN_MAX` and no row change. This is the one check that can ONLY be proven by an in-transaction test (it needs the existing row's `is_critical`), so it is not covered by a pure shape-assert unit test.
  - [x] 5.6 AC3 regression: after amending a spare, POST the original `maintenance.spare_catalogued` shape again on the same `(sku, location_id)`; assert it is STILL refused `409 SPARE_ALREADY_CATALOGUED` (proves amendment did not open a second edit path through the create route).
  - [x] 5.7 Idempotency/replay: replay the same `idempotency_key` for an amendment; assert the SAME `event_id`/`catalogue_id` comes back and the row's levels reflect only ONE amendment (event ledger count for that grain did not grow).
  - [x] 5.8 RBAC 401/403 sweep on the new route (no auth, wrong module, read-only role).
  - [x] 5.9 Regression: the full `test/integration/story-7-4.test.ts` suite passes unchanged (the highest regression risk — this story adds a seam branch and one accessor to a file that suite already exercises heavily, but does not touch reservation/issue/return/cancel/alert code paths).
- [x] Task 6: Close the deferral (AC: 1)
  - [x] 6.1 Update `_bmad-output/implementation-artifacts/deferred-work.md` row 326 to note it is closed by Story 7.9, per the convention other stories follow when they resolve a logged deferral.

### Review Findings

- [x] [Review][Patch] AC1 "alert evaluation uses the new levels from the next sweep" has no test; add a scan-after-amend test [test/integration/story-7-9.test.ts]
- [x] [Review][Patch] The updated_at assertion compares a JSON string with a pg Date and can never fail [test/integration/story-7-9.test.ts:~350]
- [x] [Review][Patch] The direct-event critical-needs-min test does not assert the 400 status [test/integration/story-7-9.test.ts:~470]
- [x] [Review][Patch] Out-of-scope partial amendment and is_critical toggling were not logged to deferred-work.md as the Binding Scope Decisions require [_bmad-output/implementation-artifacts/deferred-work.md]
- [x] [Review][Defer] Seam does not cross-check envelope.stream_id against the locked catalogue_id [src/compliance/maintenance-spares.ts:applySpareCatalogueAmended] - deferred, pre-existing (no spare applier checks stream_id)
- [x] [Review][Defer] Route handler's unlocked pre-check can choose a stale stream_id if a row were ever replaced [src/api/v1/maintenance.ts:amendSpareBase] - deferred, pre-existing (same root as the stream_id item; no delete path exists today)
- [x] [Review][Defer] Amend route has no per-location write check on location_id [src/api/v1/maintenance.ts:amendSpareBase] - deferred, pre-existing (no maintenance route calls a site-write assertion)
- [x] [Review][Defer] Same-key replay with a different body silently returns the original event [src/api/v1/maintenance.ts:amendSpareBase] - deferred, pre-existing platform gap already logged
- [x] [Review][Defer] Replay response returns the current row, not the replayed event's levels [src/api/v1/maintenance.ts:amendSpareBase] - deferred, pre-existing (createSpareBase read-back pattern)
- [x] [Review][Defer] max >= min compared with JS Number, not NUMERIC [src/compliance/maintenance-spares.ts:assertSpareCatalogueAmendedShape] - deferred, pre-existing (mirrors assertSpareCataloguedShape)

## Dev Notes

### Binding Scope Decisions

- **No database migration in this story.** `maintenance_spare_catalogue` already has `min_level`, `max_level`, and `updated_at` columns (Story 7.4). This story adds an event, a seam branch, one `UPDATE` accessor, and one route — nothing in `read/projections/*.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, or `test/unit/schema-drift.test.ts` changes. If a dev pass finds itself editing any of those four, it has drifted from this story's scope.
- **Identification is by `(sku, location_id)` grain, not by `catalogue_id`.** The epic's own deferred-work entry (row 326: "Superseding a catalogue row's min-max levels... a second POST on an occupied `(sku, location_id)` key returns 409 SPARE_ALREADY_CATALOGUED") and AC3's explicit "(sku, location) key" phrasing both confirm this. A storekeeper working from the SKU and location they already know should not need to track an internal `catalogue_id`. The route body shape is therefore the SAME as the Story 7.4 create route minus `is_critical`: `{ sku, location_id, min_level, max_level }`.
- **`is_critical` is NOT amendable in this story.** The epics text says "amend the min-max levels... without re-cataloguing it" — levels only. Toggling criticality is a re-cataloguing decision with no AC here; if it comes up, log it to `deferred-work.md` rather than building it.
- **The critical-needs-min check runs in the applier, not the pure shape assert — deliberately.** `assertMaintenanceSpareShape` (and the new `assertSpareCatalogueAmendedShape`) run pre-transaction with NO database access (Story 7.4's binding rule, `src/compliance/maintenance-spares.ts:156-158`). For `maintenance.spare_catalogued`, `is_critical` is IN the payload, so the check is pure. For an AMENDMENT, `is_critical` is NOT being changed and is NOT in this event's payload — it only exists on the row — so this one check can only run after the row is locked, inside `applySpareCatalogueAmended`. Do not try to thread `is_critical` into the amendment payload just to make the check pure; that would let a caller lie about the row's own criticality.
- **History is the event log, not a new table.** No story in this codebase keeps a separate "history" or "audit" table for a projection row's prior values (checked: no `*_history` table exists anywhere under `src/` or `read/projections/`). `domain_events` is append-only and IS the history. This story satisfies AC1's "previous levels remain readable in the row's history" by having the seam write `previous_min_level`/`previous_max_level` onto the amendment event's own payload before it is persisted (the same write-back idiom Story 7.8 used for `return_due_date`) — a reader can always see what changed by reading the `maintenance.spare_catalogue_amended` event itself. No new GET endpoint is added; none is required by any AC.
- **Response status is 200, not 201.** This route amends an existing resource. Every other write route in this module that CREATES a row (`createSpareBase`, `reserveSpareBase`) returns 201; this one does not create anything and should return 200, matching REST convention for the codebase's update-in-place routes (e.g. the issue/return/cancel reservation actions, which also return 200 — verify against their handlers if unsure).
- Out of scope, log to `deferred-work.md` if not already covered by row 326: partial amendment (only `min_level` OR only `max_level`) — this story treats both as replaced together, matching the create route's paired shape; toggling `is_critical` via amendment (see above).

### Event Contract

One new event, on the existing `maintenance` stream, `requiresBusinessStream: false` (matches every other Story 7.4 spare event):

| **Event type** | **Key payload fields** | **Projection effect** |
| --- | --- | --- |
| `maintenance.spare_catalogue_amended` | `sku`, `location_id`, `min_level` (new), `max_level` (new); seam-written: `catalogue_id`, `previous_min_level`, `previous_max_level` | Updates `min_level`/`max_level`/`updated_at` on the existing `maintenance_spare_catalogue` row identified by the `(sku, location_id)` grain |

`sku` is canonicalized with `canonicalSku()` in the handler AND re-canonicalized before the seam's grain lookup, exactly like every other spare event (the Story 7.2 scanned-versus-typed-key lesson, restated in Story 7.4's Compliance Seam Contract).

`min_level`/`max_level` travel as NUMERIC strings or `null`, never JS numbers, exactly like `maintenance.spare_catalogued` (`SpareCataloguedPayload` at `src/events/schema.ts:2480-2487`).

### Compliance Seam Contract

`src/compliance/maintenance-spares.ts` already structurally mirrors `src/compliance/maintenance-fault.ts` (stream gate, pure shape assert, in-transaction applier, `alreadyPersisted` guard, `reject()` helper) — this story adds ONE more branch to each of the three existing switches/sets in that file, it does not restructure anything:

- `MAINTENANCE_SPARE_EVENT_TYPES` (line 64): add `'maintenance.spare_catalogue_amended'`.
- `assertMaintenanceSpareShape` switch (line 161): add the case, calling `assertSpareCatalogueAmendedShape(p)`.
- `applyMaintenanceSpareProjection` switch (line 376): add the case, calling `applySpareCatalogueAmended(envelope, client)`.

The lock order for this applier is trivial (one row, no cross-entity references): lock `maintenance_spare_catalogue` by grain, done. There is no work order, asset, or stock-balance touch — this event never calls any Epic 2 ledger helper, because amending a threshold is not a stock movement.

`alreadyPersisted(envelope, client)` (line 335) must be the FIRST line of `applySpareCatalogueAmended`, exactly like every other applier in this file — a replay must return without re-locking or re-validating.

### Database Schema Contract

No schema change. `maintenance_spare_catalogue` (Story 7.4, `read/projections/maintenance_spare_catalogue.sql`) already has `min_level NUMERIC(18,6)`, `max_level NUMERIC(18,6)`, and `updated_at TIMESTAMPTZ` with the existing `chk_maintenance_spare_catalogue_levels` (`max_level >= min_level`) and `chk_maintenance_spare_catalogue_critical_needs_min` (`is_critical = false OR min_level IS NOT NULL`) CHECK constraints. Both CHECKs already enforce, at the database level, the same two rules this story's seam validates before reaching them — the seam validation exists so the error is a clean `AppError` with an `error_code` instead of a raw `23514` constraint-violation 500. Do not weaken or duplicate these constraints.

### API Contract

One new route:

| **Method and path** | **Scope** | **Behavior** |
| --- | --- | --- |
| `POST /api/v1/maintenance/spares/amend` | write | Amends the `min_level`/`max_level` of the catalogue row at `(sku, location_id)`; 422 `SPARE_NOT_CATALOGUED` when the grain has no catalogue row; 400 `INVALID_MIN_MAX` when the new levels violate the ordering or critical-needs-min rule |

Carries an `idempotency_key` exactly like every other write route in this module (`idempotencyKeyFrom(body)`, blank/non-string falls back to `randomUUID()`, cross-event-type reuse is 409 `DUPLICATE_EVENT` — reuse `idempotencyKeyFrom` and `replayIdOrReject` from this same file, do not write new helpers).

Route registration order: register `POST /api/v1/maintenance/spares/amend` alongside `/spares/scan` and `/spares/alerts` (both static, both registered before `/spares/:sku/where-used` in `src/server.ts`). This is not strictly load-bearing for THIS route (its literal suffix `amend` can never be confused with a bare `:sku` segment followed by `where-used`), but it keeps the file's route-ordering convention legible for the next person who adds a `/spares/...` route.

### Error Code Contract

Every code below is REUSED from the Story 7.4 Table 6 (`_bmad-output/implementation-artifacts/7-4-spare-parts-cataloguing-reservation-and-critical-spares-alerts.md`), not new:

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `SPARE_NOT_CATALOGUED` | 422 | The `(sku, location_id)` grain has no catalogue row (AC2's "whose spare is not catalogued") |
| `INVALID_MIN_MAX` | 400 | New `max_level < min_level` (AC2's "min is not below its max"), or the row is critical and the new `min_level` is `null` |
| `SPARE_ALREADY_CATALOGUED` | 409 | AC3 regression only — proves the EXISTING create-route behavior is unchanged; no new code path exercises this in this story |
| `DUPLICATE_EVENT` | 409 | Reused: cross-event-type idempotency-key reuse |

No new error code is introduced by this story.

### Architecture Compliance

- AD-14 (read models are shared projections): the mutation goes through `persistEvent`; the projection update runs inside the same transaction as the `domain_events` insert. No raw `UPDATE maintenance_spare_catalogue` from the handler.
- AD-16 (idempotency keys): the write route carries an `idempotency_key`; a replay returns the stored result.
- Module directory: all new code lands in the FOUR files this story touches — `src/events/schema.ts`, `src/compliance/maintenance-spares.ts`, `src/read/projections/maintenance_spare_catalogue.ts`, `src/api/v1/maintenance.ts` — plus the two registration/test files (`src/server.ts`, `test/integration/story-1-9.test.ts`) and the new test file. No new top-level directory, no new dependency.
- RBAC: `requireRole({ module: 'maintenance', functionScope: 'write' })` on the handler, the SAME wrapper `createSpareHandler` uses — never a hardcoded role list (the no-hardcoded-role gate enforces this).

### Previous Story Intelligence

From Story 7.4 (the direct dependency this story extends) and Story 7.8 (the most recent Epic 7 story, done 2026-08-28):

- Canonicalize `sku` with `canonicalSku()` in the handler AND in the seam, so the direct-event path cannot bypass it (live in `maintenance-spares.ts:133-135`, reuse the exported function — do not re-derive it).
- Never let an applier silently no-op on a state/condition it should reject: a phantom event with an unchanged row produces dishonest counters (there are no counters here, but the discipline is the same — always `reject()`, never silently return).
- A declared payload field the applier can derive must be cross-checked against the derivation, never trusted — this story's amendment payload deliberately carries NO derivable field for the caller to declare wrong (`catalogue_id` is entirely seam-written), which sidesteps this class of bug rather than needing to guard it.
- Read back a created/amended resource BY ID for the response body, never by re-querying by grain a second time after the write (`createSpareBase` lines 2062-2069 is the template).
- `findRoleHolder` picks the earliest-assigned holder of a role (deferred-work L322) — not relevant here (no DOA resolution in this story), noted only because it is the kind of platform gotcha that has bitten adjacent maintenance stories.
- UUIDs render lowercase from PostgreSQL; compare lowercased (deferred-work L320) — relevant if any test compares a returned `catalogue_id` to a locally-generated UUID string.
- `git stash` converted `init-db.sql` to CRLF once and broke schema-drift (Story 4.3 lesson) — not applicable to this story since no SQL file is touched, noted only so a dev agent does not go looking for a schema-drift regression that cannot exist here.

Two open platform gaps from `deferred-work.md` still apply and are NOT this story's to fix: a `maintenance.*` event posted with a non-`maintenance` `stream_type` skips the seam gates (`src/events/store.ts`), and same-event-type idempotency-key reuse with different content returns the original event.

### Git Intelligence

Baseline: `062fbe4`, clean working tree. The Story 7.4 spare-catalogue code (`src/compliance/maintenance-spares.ts`, `src/read/projections/maintenance_spare_catalogue.ts`) and the Story 7.8 offline/closure-code work are both committed and stable — this story builds directly on committed code, not an in-flight working tree (unlike some earlier stories in this epic). Recent history in this repo carries the rhythm: seam branch, accessor, route, spine-allowlist entry, and integration test land together in one commit.

### Testing Requirements

- Framework: the existing integration-test harness under `test/integration/`, bootstrapped exactly as `story-7-4.test.ts` does — reuse its fixtures (item master rows, locations, the `maintenance_storekeeper` user) rather than creating parallel ones.
- Red-green-refactor per task: write the failing assertion first.
- Every acceptance criterion needs at least one test that would FAIL if the behavior were removed.
- Every error code in the Error Code Contract table needs a test, including the AD-12 direct-event bypass (`persistEvent(... as any)`) for both `SPARE_NOT_CATALOGUED` and the critical-needs-min `INVALID_MIN_MAX` — both are seam-enforced, not just handler-enforced.
- Idempotency: a replay test asserting the same `event_id`/`catalogue_id` comes back and the row was amended exactly once.
- Regression: `test/integration/story-7-4.test.ts` must pass unchanged — it is the suite with the highest overlap risk (same seam file, same projection file).
- Known baseline going in (per Story 7.8's completion notes, the most recent Epic 7 gate run): `schema-drift` at 113/114 pass (1 pre-existing `gate_dwell_metric` CRLF failure, unrelated). Reproduce this baseline at `062fbe4` before starting; zero NEW failures is the bar for this story. Since this story makes no schema change, the schema-drift count should not move at all.
- Do not weaken, skip, or delete an existing test to make a new one pass.

### Project Structure Notes

Modified files only — no new files except the test:

- `src/events/schema.ts` — new payload/envelope interfaces plus one `SUPPORTED_EVENT_TYPES` entry.
- `src/compliance/maintenance-spares.ts` — one new assert function, one new applier function, two switch cases, one set entry.
- `src/read/projections/maintenance_spare_catalogue.ts` — one new `UPDATE` accessor.
- `src/api/v1/maintenance.ts` — one new handler, one new exported RBAC-wrapped handler.
- `src/server.ts` — one new route registration.
- `test/integration/story-1-9.test.ts` — one new `allowedSpineRoutes` entry.
- `_bmad-output/implementation-artifacts/deferred-work.md` — close row 326.

New file: `test/integration/story-7-9.test.ts`.

Read-only, do not modify: `read/projections/maintenance_spare_catalogue.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `test/unit/schema-drift.test.ts` — none of them need to change for this story, and touching them is a signal of scope drift.

No new dependency is required or permitted.

### References

- Epic 7 story text: `_bmad-output/planning-artifacts/epics.md` Story 7.9 at line 2412, Story 7.4 (the direct dependency) at line 2280, FR-M-09 at line 2296/2420.
- Deferred-work entry this story closes: `_bmad-output/implementation-artifacts/deferred-work.md` row 326.
- Previous story (Story 7.4), its full Event/Locking/Reservation/Return-Clock/Breach-Scan/Database/Compliance-Seam/Notification/API/Error-Code contracts and Previous-Story-Intelligence: `_bmad-output/implementation-artifacts/7-4-spare-parts-cataloguing-reservation-and-critical-spares-alerts.md`.
- Most recent Epic 7 story (Story 7.8), for current baseline test counts and live platform lessons: `_bmad-output/implementation-artifacts/7-8-offline-technician-workflow-and-closure-codes.md`.
- Compliance seam to extend: `src/compliance/maintenance-spares.ts` (full file read for this story; key anchors: `MAINTENANCE_SPARE_EVENT_TYPES` line 64, `assertMaintenanceSpareShape` line 156, `assertSpareCataloguedShape` line 189, `applyMaintenanceSpareProjection` line 368, `applySpareCatalogued` line 404, `canonicalSku` line 133).
- Projection accessor file to extend: `src/read/projections/maintenance_spare_catalogue.ts` (full file read for this story; `getSpareCatalogueByGrain` line 51, `getSpareCatalogueById` line 31).
- `UPDATE`-accessor style template: `src/read/projections/maintenance_spare_reservation.ts:116-129` (`markSpareReservationIssued`).
- Route handler template: `src/api/v1/maintenance.ts` (`createSpareBase` lines 1992-2074, `createSpareHandler` lines 2585-2588, shared helpers `requireSku`/`requireUuidField`/`numericStringOrNull` lines 1922-1948).
- Route registration: `src/server.ts` lines 907-911.
- Spine allowlist: `test/integration/story-1-9.test.ts` lines 466-470.
- Event registry template: `src/events/schema.ts` lines 2480-2492 (payload/envelope shape), line 6081 (registry entry).
- Write-back-onto-payload precedent (proves the pattern persists correctly): `src/compliance/maintenance-spares.ts:659` (`applySpareIssued`'s `p['return_due_date'] = derivedDueDate`) and `src/events/store.ts:1221` (projection applies) running before `:1366` (the `domain_events` INSERT that persists the same mutated `envelope.payload` object).
- Test harness template: `test/integration/story-7-4.test.ts`.

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1)

### Debug Log References

- Baseline at 062fbe4: `test/integration/story-7-4.test.ts` 58/58 pass (test DB container `ims-postgres-test` restarted and migrated cold).
- Red run of the new `story-7-9.test.ts` before any code: 0/16 pass (route absent, event type unregistered).
- First green run after Tasks 1-4: 79/80; the one failure was a test bug (asserted `err.status` where `AppError` exposes `statusCode`). Fixed in the test, rerun 80/80 across story-7-9, story-7-4 and story-1-9.
- `tsc --noEmit` clean; eslint clean on all touched files; prettier applied to `src/api/v1/maintenance.ts` and the new test (additions only).

### Completion Notes List

- Task 1: `SpareCatalogueAmendedPayload` / `SpareCatalogueAmendedEnvelope` added after the `SpareCataloguedEnvelope` block; `maintenance.spare_catalogue_amended` registered in `SUPPORTED_EVENT_TYPES` (maintenance stream, no business stream). Seam-written fields (`catalogue_id`, `previous_min_level`, `previous_max_level`) are optional on the interface and documented as overwritten by the seam.
- Task 2: seam extended with one set entry, `assertSpareCatalogueAmendedShape` (pure: sku, UUID location, numeric-or-null levels, max >= min), and `applySpareCatalogueAmended` (`alreadyPersisted` first, lock by grain FOR UPDATE, 422 `SPARE_NOT_CATALOGUED`, critical-needs-min `INVALID_MIN_MAX` evaluated against the LOCKED row, write-back of catalogue_id and previous levels onto the payload, then the UPDATE; a zero rowcount rejects rather than no-ops). No 23505 resolver, no ledger call.
- Task 3: `updateSpareCatalogueLevels(catalogueId, min, max, client)` UPDATE accessor mirroring `markSpareReservationIssued`; returns rowCount.
- Task 4: `amendSpareBase` handler (same parse helpers as `createSpareBase`, unlocked grain pre-check as a UX fast-fail, `persistEvent` with `stream_id = existing.catalogue_id`, `replayIdOrReject`, read-back BY ID, 200 response), `amendSpareHandler` under `requireRole({ module: 'maintenance', functionScope: 'write' })`, registered as `POST /api/v1/maintenance/spares/amend` between `/spares/scan` and `/spares/alerts`, added to the Story 1.9 spine allowlist.
- Task 5: `test/integration/story-7-9.test.ts`, 16 tests: AC1 happy path with event-log history, chained second amendment, case-insensitive SKU, null-null on a non-critical spare; AC2 inverted levels, malformed level, uncatalogued grain via route (422) and via direct `persistEvent` (same seam code and 422 status), critical-needs-min via route and via direct event, direct-event inverted levels, INVALID_PARAMS; AC3 create route still 409 after an amendment and levels untouched; idempotent replay (same event_id and catalogue_id, ledger count 1, original previous levels preserved) and cross-type key reuse 409 `DUPLICATE_EVENT`; RBAC 401/403/403 with the row unchanged.
- Task 6: deferred-work row 326 marked RESOLVED 2026-09-26 by Story 7.9, following the RESOLVED-by-story convention used by rows 260 and 9.6C-2.
- Scope held: no SQL, migration, or schema-drift file touched; `is_critical` is not amendable; no new error code, dependency, or role.

### File List

- `src/events/schema.ts` (modified)
- `src/compliance/maintenance-spares.ts` (modified)
- `src/read/projections/maintenance_spare_catalogue.ts` (modified)
- `src/api/v1/maintenance.ts` (modified)
- `src/server.ts` (modified)
- `test/integration/story-1-9.test.ts` (modified)
- `test/integration/story-7-9.test.ts` (new)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified, row 326)
- `_bmad-output/implementation-artifacts/7-9-spare-min-max-level-amendment.md` (this file)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status)

## Change Log

- 2026-09-26: Story 7.9 implemented - amendment event, seam branch, UPDATE accessor, amend route, spine allowlist entry, 16-test integration suite; deferred-work row 326 closed.
- 2026-09-26: Code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor): 4 patches applied (scan-after-amend AC1 test, real updated_at assertion, 400 status check on direct critical-needs-min, out-of-scope items logged), 6 deferred, 8 dismissed. Story suite 17/17.
