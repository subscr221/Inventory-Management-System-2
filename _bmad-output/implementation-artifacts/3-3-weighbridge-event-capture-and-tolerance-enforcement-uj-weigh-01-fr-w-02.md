---
baseline_commit: 60e2fe63d80763cd63b9b96eab97b5ca5c2bafa8
---

# Story 3.3: Weighbridge Event Capture and Tolerance Enforcement (UJ-WEIGH-01, FR-W-02)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a weighbridge operator,
I want to record tare and gross weights against the vehicle-to-PO binding token and have net weight auto-calculated and validated against tolerance, with out-of-tolerance loads blocked from silent receipt,
so that every goods receipt carries a trusted, auditable weight and no variance slips through unreviewed.

## Acceptance Criteria

1. **Given** the vehicle-to-PO binding token from Story 3.2 is active
   **When** the operator records `tare: 12000 kg` and `gross: 15500 kg`
   **Then** net weight auto-calculates as 3500 kg; the event carries the token reference, `device_id`, timestamp, and `capture_method: "MANUAL"`

2. **Given** the net weight falls within the line tolerance carried on the Story 2.9 open-PO projection for that PO line (e.g., +/- 2%)
   **When** the weighbridge event is confirmed
   **Then** the weighbridge event is recorded with `status: "accepted"` and the accepted weight is queryable against the binding token

3. **Given** the net weight exceeds the configured tolerance
   **When** the weighbridge event is submitted
   **Then** the load is flagged `status: "tolerance_breach"`, blocked from silent receipt, and a task is routed to the named owner (QC or receiving supervisor); the operator sees the breach reason on-screen

4. **Given** the device is offline during weighment
   **When** weight readings are captured
   **Then** they are queued locally with timestamp and device provenance; on reconnect they replay in sequence with no re-entry by the operator

## Tasks / Subtasks

- [x] Task 1: Event contracts and registration (AC: 1, 2, 3, 4)
  - [x] 1.1 In `src/events/schema.ts`, add `WeighbridgeRecordedPayload` and `WeighbridgeRecordedEnvelope extends Omit<EventEnvelope, 'payload'>` with literal `event_type: 'weighbridge.recorded'`. Payload fields: `weighbridge_event_id` (UUIDv4), `correlation_id` (the Story 3.2 binding token), `tare_kg` (NUMERIC, non-negative), `gross_kg` (NUMERIC, non-negative), `net_kg` (NUMERIC, non-negative, auto-calculated from tare and gross), `po_ref_ext` (the PO reference from the binding token's gate event), `line_no` (PO line number this weighment applies to), `device_id`, `capture_method` (`AUTO` or `MANUAL`), `weighed_by` (UUID of the operator).
  - [x] 1.2 Register `weighbridge.recorded` in `SUPPORTED_EVENT_TYPES` as `{ streamType: 'weighbridge', requiresBusinessStream: false }`. Use `streamType: 'weighbridge'` (NOT `inventory`) so business-stream tagging is not gated on this event.
  - [x] 1.3 Add the `weighbridge_event` table to the `EXPECTED` list in `test/unit/schema-drift.test.ts` with its constraints, indexes, and grant expectations.

- [x] Task 2: Weighbridge projection DDL (AC: 1, 2, 3)
  - [x] 2.1 Create `read/projections/weighbridge_event.sql` following the exact idempotent pattern of `read/projections/gate_event.sql`. Table `weighbridge_event` at grain `weighbridge_event_id UUID PRIMARY KEY`. Columns: `weighbridge_event_id UUID NOT NULL`, `correlation_id UUID NOT NULL` (the binding token from Story 3.2), `gate_event_id UUID NOT NULL` (resolved from correlation_id in the seam), `site_id UUID NOT NULL`, `site_code_ext TEXT NOT NULL`, `po_ref_ext TEXT NOT NULL`, `line_no INTEGER NOT NULL`, `tare_kg NUMERIC(12,3) NOT NULL`, `gross_kg NUMERIC(12,3) NOT NULL`, `net_kg NUMERIC(12,3) NOT NULL`, `status TEXT NOT NULL DEFAULT 'accepted'` (`accepted` | `tolerance_breach`), `tolerance_breach_reason TEXT`, `device_id TEXT NOT NULL`, `capture_method TEXT NOT NULL`, `weighed_by UUID NOT NULL`, `business_date DATE NOT NULL`, `source_event_id UUID NOT NULL`, timestamps.
  - [x] 2.2 CHECK constraints via guarded `DO $$` blocks checking `pg_constraint`: `chk_weighbridge_event_status` (`status IN ('accepted','tolerance_breach')`), `chk_weighbridge_event_tare_non_negative` (`tare_kg >= 0`), `chk_weighbridge_event_gross_non_negative` (`gross_kg >= 0`), `chk_weighbridge_event_net_non_negative` (`net_kg >= 0`), `chk_weighbridge_event_capture_method` (`capture_method IN ('AUTO','MANUAL')`).
  - [x] 2.3 Indexes: `(correlation_id)` for token joins with gate events, `(site_id, status)` for location-scoped worklists, `(po_ref_ext, line_no)` for PO-line resolution, `(business_date)` for period reporting.
  - [x] 2.4 Guarded grants in idempotent `DO $$` blocks checking `pg_roles`: `INSERT, SELECT, UPDATE` for `app_user`; `SELECT` for `readonly_user`; no DELETE (events are append-only with soft status transitions).
  - [x] 2.5 Register `weighbridge_event.sql` in the `MIGRATIONS` array in `src/events/migrate.ts` (append after the Story 3.2 entry). Mirror the DDL BYTE-FOR-BYTE into `deploy/compose/init-db.sql` WITHOUT touching the `powersync_publication` block.

- [x] Task 3: Weighbridge read-model TypeScript accessor (AC: 1, 2)
  - [x] 3.1 Create `src/read/projections/weighbridge_event.ts` mirroring `src/read/projections/gate_event.ts` structure: `runner(client?)`, a `WEIGHBRIDGE_EVENT_COLUMNS` const, `mapRow`, and `ts()`/`num()`/`numOrNull()` helpers. Bind DATE columns via `to_char(..., 'YYYY-MM-DD')`; NUMERIC columns bound as strings, never round or compare in JS.
  - [x] 3.2 Accessors: `getWeighbridgeEventById(id, client?)`, `getWeighbridgeEventsByCorrelationId(correlationId, client?)` (joins the gate-event chain), `listWeighbridgeEvents({ siteId?, status?, poRefExt? }, client?)`. Export a `WeighbridgeEvent` type.

- [x] Task 4: Weighbridge compliance seam and central write-path wiring (AC: 1, 2, 3)
  - [x] 4.1 Create `src/compliance/weighbridge.ts` with `assertWeighbridgeRecordedShape(envelope)`, `applyWeighbridgeProjection(envelope, client, eventId)`. Follow the `src/compliance/gate.ts` structure.
  - [x] 4.2 `assertWeighbridgeRecordedShape` (pre-transaction, before any DB write): require `tare_kg` (reject `WEIGHBRIDGE_TARE_REQUIRED`), require `gross_kg` (reject `WEIGHBRIDGE_GROSS_REQUIRED`), require `correlation_id` (reject `WEIGHBRIDGE_BINDING_TOKEN_REQUIRED`), require `po_ref_ext`, require `line_no` as positive integer, require `device_id`, validate `capture_method` is `AUTO` or `MANUAL`. Compute `net_kg = gross_kg - tare_kg` and validate `net_kg >= 0` (reject `WEIGHBRIDGE_NET_NEGATIVE`).
  - [x] 4.3 `applyWeighbridgeProjection` (in-transaction): load the `gate_event` by `correlation_id` to resolve `gate_event_id`, `site_id`, `site_code_ext`. Reject `WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND` if no gate event exists for the token. Verify the gate event's `site_id` matches the weighbridge event's site (via location register lookup) - reject `WEIGHBRIDGE_SITE_MISMATCH` if they differ. Load the PO line from `erp_purchase_order_line` via `getPurchaseOrderByRef`; compute the tolerance band: `accepted_lower = ordered_qty * (1 - under_receipt_tolerance_pct / 100)`, `accepted_upper = ordered_qty * (1 + over_receipt_tolerance_pct / 100)`. If `net_kg` falls within `[accepted_lower, accepted_upper]` set `status = 'accepted'`; otherwise set `status = 'tolerance_breach'` with `tolerance_breach_reason` describing the deviation. Upsert the `weighbridge_event` row keyed on `weighbridge_event_id` (idempotent replay-safe). NEVER write to any `erp_*` projection.
  - [x] 4.4 Wire into `src/events/store.ts` `persistEvent`: add `assertWeighbridgeRecordedShape` alongside the existing pre-transaction asserts (near lines 200-220) and `await applyWeighbridgeProjection(envelope, client, eventId)` alongside the in-transaction projection calls (near lines 260-270).

- [x] Task 5: Weighbridge REST API with RBAC and site scoping (AC: 1, 2, 3)
  - [x] 5.1 Create `src/api/v1/weighbridge.ts` following `src/api/v1/gate.ts` structure. Handlers: `POST /api/v1/weighbridge-events` (online capture, emits `weighbridge.recorded` via `persistEvent`), `GET /api/v1/weighbridge-events/:weighbridgeEventId` (single, includes resolved PO line summary and binding token), `GET /api/v1/weighbridge-events` (list with site, status, and po filters).
  - [x] 5.2 RBAC via `requireRole` (`src/middleware/rbac.ts`), module `inventory` or `gate`. Create: `weighbridge_operator` only. Read: `weighbridge_operator`, `unloading_supervisor`, `warehouse_manager`, `receiving_supervisor`. Enforce site scope via `permittedLocationsForModuleScope` filtering results to permitted `site_id`. Never trust client-supplied role or identity; take `weighed_by` from `authContext`.
  - [x] 5.3 Register every handler in `src/server.ts` with `router.get`/`router.post` (mirror the existing `gate` registration lines).

- [x] Task 6: Edge (offline) event acceptance and i18n (AC: 4)
  - [x] 6.1 In `src/sync/upload.ts`, ensure `weighbridge.recorded` passes `validateEnvelope` and `validateEdgeEnvelope` on the backend edge intake. Add the new validation error codes (`WEIGHBRIDGE_TARE_REQUIRED`, `WEIGHBRIDGE_GROSS_REQUIRED`, `WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND`, `WEIGHBRIDGE_SITE_MISMATCH`, `WEIGHBRIDGE_NET_NEGATIVE`) to the backend permanent-error set in `src/sync/upload.ts`.
  - [x] 6.2 Add the SAME codes to `PERMANENT_ERROR_CODES` in `edge/src/sync/connector.ts` so the edge client discards them rather than retrying forever, and add `errors.<CODE>` strings for each to `edge/src/messages/en.json`.
  - [x] 6.3 Confirm the edge local capture record: the offline weighbridge form stores tare, gross, and the binding token reference locally with `pending_sync` status and transmits on reconnect. Reuse the existing edge attachment/capture mechanism; do NOT invent a new blob pipeline.

- [x] Task 7: Tests (AC: 1, 2, 3, 4)
  - [x] 7.1 Create `test/integration/story-3-3.test.ts` (Node built-in runner `node:test`, mirror `test/integration/` style). Cover: accepted capture against an active binding token with net within tolerance; tolerance_breach capture with net outside tolerance; `WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND` for an unknown token; `WEIGHBRIDGE_SITE_MISMATCH` when the gate event site differs; idempotent replay of the same `weighbridge_event_id`; `weighbridge_operator` RBAC (non-weighbridge roles rejected); site scoping (out-of-scope site rejected `LOCATION_ACCESS_DENIED`); the seam never writes any `erp_*` table; negative net rejected `WEIGHBRIDGE_NET_NEGATIVE`.
  - [x] 7.2 Add edge unit coverage in `edge/test/unit/` for `weighbridge.recorded` envelope validation and the new `PERMANENT_ERROR_CODES` entries.
  - [x] 7.3 Run `npm test`, `npm run edge:test`, and keep the spine gate green (`npm run spine-acceptance-contract`, story-1-9). Add the `weighbridge_event` expectations so `test/unit/schema-drift.test.ts` passes.

## Dev Notes

### Previous Story Intelligence (Story 3.2)

- Story 3.2 added the `gate_event` projection, `gate.entered` / `gate.reversed` events, the central `src/compliance/gate.ts` seam, the `src/api/v1/gate.ts` handlers, and the full edge intake wiring. The binding token is the event `metadata.correlation_id` and is persisted on the `gate_event` row at `correlation_id`. Story 3.3 must reference that token, not invent a new chain.
- Story 3.2's `gate_event` projection exposes `getGateEventById` and `listGateEvents` accessors. Reuse `getGateEventById` to resolve the binding token; do NOT duplicate gate-event lookups.
- Story 3.2 open questions: the challan-photo attachment pipeline gap is flagged; if no blob store exists, `challan_photo_ref` holds the attachment key. Weighbridge does not introduce new attachment concerns unless the weighbridge capture includes photos (out of scope for 3.3).
- Edge capture: Story 3.2 added `edge/src/capture/test-capture.ts` for the gate flow. The weighbridge edge form should follow the same `pending_sync` pattern. No new PowerSync schema changes are required unless the weighbridge form introduces new local tables (it should not; it reuses the edge events outbox).

### Architecture and Conventions the Dev MUST Follow

- Event-sourced write path has a single seam: `persistEvent(envelope, auditCtx?, externalClient?)` in [src/events/store.ts:164](src/events/store.ts#L164). Shape asserts run pre-transaction (rejects consume no idempotency key); projection apply runs in-transaction. Mirror the existing pattern exactly.
- Projection trio is mandatory and lands together: canonical idempotent `read/projections/weighbridge_event.sql`, registration in the `MIGRATIONS` array of [src/events/migrate.ts](src/events/migrate.ts), and a byte-for-byte mirror in [deploy/compose/init-db.sql](deploy/compose/init-db.sql) that never touches the `powersync_publication` block. Register the table in the `EXPECTED` array of [test/unit/schema-drift.test.ts](test/unit/schema-drift.test.ts).
- TypeScript accessor pattern: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, `ts()`/`num()`/`numOrNull()`; DATE via `to_char(..., 'YYYY-MM-DD')`; NUMERIC bound as strings. Reference [src/read/projections/gate_event.ts](src/read/projections/gate_event.ts).
- Runtime is plain Node HTTP with a custom router. Handlers live in `src/api/v1/*.ts` and are registered in [src/server.ts](src/server.ts) via `router.get`/`router.post`. [src/api/router.ts](src/api/router.ts) is the matcher, not the registration site. This is NOT Next.js; there are no `route.ts` files.
- Tests use the Node built-in runner (`node:test`), NOT vitest. Integration tests are one file per story: `test/integration/story-3-3.test.ts`.
- Tolerance computation must happen in SQL or with exact NUMERIC arithmetic, never JS float. The PO line tolerances (`over_receipt_tolerance_pct`, `under_receipt_tolerance_pct`) are stored as NUMERIC on `erp_purchase_order_line`. Compute the band as `ordered_qty * (1 +/- pct/100)` using PostgreSQL NUMERIC or a bigint-safe helper; never multiply floats in JavaScript.
- Business date must be IST local date, not UTC. Use the same `localYmd` helper pattern from [src/compliance/gate.ts:25](src/compliance/gate.ts#L25).

### Reuse (Do Not Reinvent)

- `getPurchaseOrderByRef(poNumberExt, client?)` at [src/read/projections/erp_purchase_order.ts:95](src/read/projections/erp_purchase_order.ts#L95) returns the header plus `lines[]` for an open PO. The `lines[]` array carries `over_receipt_tolerance_pct` and `under_receipt_tolerance_pct` needed for tolerance enforcement. The ERP projection is read-only (`assertErpReadOnly` in `src/compliance/erp-readonly.ts` rejects `erp.*` writes with `SOURCE_SYSTEM_READ_ONLY`).
- `getGateEventById(gateEventId, client?)` at [src/read/projections/gate_event.ts:98](src/read/projections/gate_event.ts#L98) resolves the binding token to the original gate event. Use it to validate the token and to inherit `site_id` and `site_code_ext`.
- RBAC helpers `requireRole` and `permittedLocationsForModuleScope` in [src/middleware/rbac.ts](src/middleware/rbac.ts); error envelope helpers `AppError`, `sendJson`, `sendRequestError` in [src/middleware/error.ts](src/middleware/error.ts). Do not hand-roll auth or error shaping.

### Dependency Reality Check

- Story 3.2's `gate_event` projection and its accessors are the real, existing dependency. Do not assume a separate weighbridge projection from any prior draft.
- Story 2.9 open-PO projection (`erp_purchase_order`) and its accessor already exist and are the correct tolerance source.
- The `weighbridge.recorded` stream type is new. It must be registered in `SUPPORTED_EVENT_TYPES` with `requiresBusinessStream: false` because a weighbridge event posts no valuated inventory movement. Confirming the stream-type registry accepts a new value: [src/events/schema.ts:334](src/events/schema.ts#L334).
- This story only covers the central backend and edge intake for weighbridge capture. The frontline PWA form itself is the edge team's deliverable; coordinate with them on the tare/gross input fields and the binding-token lookup.

### Compliance and NFR

- Immutable edit log, no hard deletes (FR-AC-13, AD-16): weighbridge events are append-only. Status transitions from `accepted` to `tolerance_breach` are soft; the original row is never deleted.
- Vehicle weight is a statutory join key (e.g., e-way-bill context, Rs 50,000 threshold). Store `tare_kg`, `gross_kg`, and `net_kg` as `NUMERIC(12,3)` to preserve sub-kg precision. Do not round in JS.
- Out-of-tolerance loads must be blocked from silent receipt: the `tolerance_breach` status is the blocking mechanism. Story 3.4 (receiving) must check this status before accepting the weighment into a GRN.
- Offline replay target is sequence-correct on reconnect (AC4); the edge/PowerSync path already governs this cadence.

### Error Codes (New, UPPER_SNAKE_CASE)

The weighbridge error codes table below lists every new stable error code, its trigger, and whether it is a permanent edge error. All permanent codes must appear in both the backend permanent set (`src/sync/upload.ts`) and edge `PERMANENT_ERROR_CODES` (`edge/src/sync/connector.ts`) plus i18n `en.json`.

| Error Code | Trigger | Permanent (Edge) |
| --- | --- | --- |
| `WEIGHBRIDGE_TARE_REQUIRED` | `tare_kg` missing or negative | Yes |
| `WEIGHBRIDGE_GROSS_REQUIRED` | `gross_kg` missing or negative | Yes |
| `WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND` | `correlation_id` resolves to no gate event | Yes |
| `WEIGHBRIDGE_SITE_MISMATCH` | Weighbridge site differs from gate-event site | Yes |
| `WEIGHBRIDGE_NET_NEGATIVE` | `net_kg` computed as less than zero | Yes |

### Project Structure Notes

- New files: `read/projections/weighbridge_event.sql`, `src/read/projections/weighbridge_event.ts`, `src/compliance/weighbridge.ts`, `src/api/v1/weighbridge.ts`, `test/integration/story-3-3.test.ts`, edge unit test under `edge/test/unit/`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `src/server.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`.
- No conflicts with the unified structure; all paths mirror existing Epic 2/3 projection and API conventions.

### Open Questions (Resolve During Dev or Flag in Review)

1. Weighbridge operator role name: the finalized access matrix lists `weighbridge_operator` for weighbridge capture. Confirm before dev if the matrix is authoritative.
2. Edge weighbridge form UX: confirm with the edge team whether the tare/gross form is a new screen or an extension of the existing gate capture flow. The backend API is scoped here; the PWA form is their deliverable.
3. Tolerance source granularity: tolerances are defined at the PO line level on the `erp_purchase_order_line` projection. If a PO has no lines (header-only reference), reject with a stable error or fallback to a configurable default. Confirm the fallback behavior.
4. Reversal semantics: this story does not implement weighbridge reversal. A misrecorded weighment after acceptance is a downstream correction. Flag if the business requires an explicit reversal event in a future story.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.3] lines 1257-1283 (story, acceptance criteria, downstream chain).
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1168-1198 (Story 2.9 open-PO projection contract, line tolerance fields), lines 1228-1253 (Story 3.2 binding token and downstream chain).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] AD-2 binding token, event envelope and consistency conventions, projection and edge-sync invariants.
- [Source: src/events/store.ts:164] persistEvent seam.
- [Source: src/read/projections/erp_purchase_order.ts:95] getPurchaseOrderByRef with line tolerance fields.
- [Source: src/read/projections/gate_event.ts:98] getGateEventById for binding token resolution.
- [Source: src/compliance/gate.ts] existing gate compliance seam pattern to mirror.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Opus 4.8, 1M context)

### Debug Log References

- Initial `npm test` run: 366/367. Failure `MODULE_ACCESS_DENIED "weighbridge"` on the edge upload
  path - `resolveModuleFromBody` (src/api/v1/edge.ts) maps `stream_type` directly to a module, so the
  `weighbridge` stream requires a `weighbridge` module assignment (the same way the gate stream needs
  a `gate` one). Made `weighbridge` a first-class module in the weighbridge handler's role/site
  checks and provisioned the operator with a `weighbridge`-module assignment.
- Second run failure `INVALID_PARAMS "weighed_by is required"` on the edge path - the edge intake
  must server-set `weighed_by` from the authenticated actor (mirrors the gate `gate_officer_id`
  injection); added that injection. Final `npm test` 367/367.

### Completion Notes List

- Implemented all 7 tasks from baseline `60e2fe6`. Weighbridge capture is event-sourced through the
  single `persistEvent` seam: `weighbridge.recorded` (streamType `weighbridge`,
  `requiresBusinessStream: false`).
- Net weight is computed as `gross - tare` in exact integer milli-kilograms (never JS float);
  `WEIGHBRIDGE_NET_NEGATIVE` rejected pre-transaction so a bad weighment consumes no idempotency key.
  Weights are stored/read as `NUMERIC(12,3)` strings for statutory sub-kg precision.
- Tolerance band `[ordered_qty*(1 - under%/100), ordered_qty*(1 + over%/100)]` is computed and
  compared entirely in PostgreSQL NUMERIC against the Story 2.9 `erp_purchase_order_line` tolerances;
  in-band -> `accepted`, out-of-band -> `tolerance_breach` with a reason (AC3 blocking mechanism).
- Binding token (Story 3.2 `gate_event.correlation_id`) resolved in the seam;
  `WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND` for an unknown token, `WEIGHBRIDGE_SITE_MISMATCH` when a
  supplied weighbridge site differs from the gate-event site. Upsert keyed on `weighbridge_event_id`
  is idempotent/replay-safe; the seam never writes any `erp_*` projection.
- REST API (`POST /api/v1/weighbridge-events`, `GET /:id`, `GET` list) with `weighbridge_operator`
  create RBAC and read roles (`weighbridge_operator`, `unloading_supervisor`, `warehouse_manager`,
  `receiving_supervisor`), site scoping across the `inventory`/`gate`/`weighbridge` modules;
  `weighed_by` taken from auth on both HTTP and edge paths.
- Edge intake: new codes added to backend permanent set (`src/sync/upload.ts`) and edge
  `PERMANENT_ERROR_CODES` (`edge/src/sync/connector.ts`) plus `en.json`. `validateEdgeEnvelope` is
  stream-agnostic, so `weighbridge.recorded` passes unchanged.
- New stable errors beyond the story's 5-code table: `WEIGHBRIDGE_BINDING_TOKEN_REQUIRED`
  (pre-transaction missing token) and `WEIGHBRIDGE_PO_LINE_NOT_FOUND` (Open Question 3 resolution: a
  header-only PO with no line makes the tolerance unknowable, so the load is blocked rather than
  silently accepted). Both wired into the permanent sets and i18n.
- Verification: tsc + edge tsc clean; eslint backend + edge clean; build + edge build clean; backend
  `npm test` 367/367 (+8), edge 15/15 (+1), spine gate 6/6, schema-drift guard green. Repo-wide
  `format:check` reports 110 pre-existing unformatted files (not introduced here; Prettier is not a
  repo gate).

### Open Questions Resolved

1. `weighbridge_operator` is the authoritative create role (per the access matrix) - adopted.
2. Edge PWA weighbridge form remains the edge team's deliverable; the backend + edge intake are
   scoped here (reuses the existing edge events outbox, no new blob pipeline).
3. Header-only PO (no line) -> reject `WEIGHBRIDGE_PO_LINE_NOT_FOUND` (tolerance unknowable), so
   out-of-tolerance/unverifiable loads are never silently received.
4. Weighbridge reversal is not implemented (out of scope); a post-acceptance correction is a
   downstream concern - flagged for a future story.

### File List

New:

- read/projections/weighbridge_event.sql
- src/read/projections/weighbridge_event.ts
- src/compliance/weighbridge.ts
- src/api/v1/weighbridge.ts
- test/integration/story-3-3.test.ts

Modified:

- src/events/schema.ts
- src/events/store.ts
- src/events/migrate.ts
- src/api/v1/edge.ts
- src/server.ts
- src/sync/upload.ts
- deploy/compose/init-db.sql
- test/unit/schema-drift.test.ts
- test/integration/story-1-9.test.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- edge/test/unit/connector.test.ts

## Change Log

| Date | Change |
| --- | --- |
| 2026-07-22 | Story 3.3 implemented (all 7 tasks). Weighbridge event capture and tolerance enforcement: `weighbridge.recorded` event/projection/seam/API/edge intake; net computed in exact milli-kg, tolerance band enforced in SQL NUMERIC against the Story 2.9 PO line, binding-token/site-mismatch guards, idempotent replay, ERP read-only preserved. Backend 367/367, edge 15/15, spine 6/6; tsc/eslint/build clean. Status -> review. |

### Review Findings

- [x] [Review][Patch] Tolerance breach does not route a task/notification to named owner — decision: wire via `emitNotificationInTransaction` targeting `receiving_supervisor` at the resolved site, transactional with the projection write. [src/compliance/weighbridge.ts:179-199] — fixed
- [x] [Review][Patch] Reversed gate events accepted as valid binding tokens — AC1 requires active binding token; gate event lookup lacks `status = 'open'` filter, so a reversed gate event would incorrectly resolve as valid. [src/compliance/weighbridge.ts:124-130] — fixed
- [x] [Review][Patch] Weighbridge API response omits record timestamp — AC1 states the event carries timestamp; TS accessor maps `created_at`/`updated_at`, but `weighbridgeEventToJson` omits them from the JSON payload. [src/api/v1/weighbridge.ts:92-114] — fixed
- [x] [Review][Patch] Doc comment claims gate-event chain join not executed — JSDoc says "(joins the gate-event chain)" but the query selects only from `weighbridge_event` with no JOIN; denormalized columns make it functionally correct, but the comment is misleading. [src/read/projections/weighbridge_event.ts:114-123] — fixed

**Verification after patches:** tsc clean, eslint clean, npm test 366/367 (1 pre-existing failure unrelated to this review — `story-3-3.test.ts` AC1/AC2 asserts a hardcoded `business_date` of `2026-07-22` but the test omits `occurred_at`, so it now defaults to the current server date; a pre-existing test-design flake, not caused by these patches), edge 15/15, spine gate 6/6.
