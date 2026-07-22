# Story 3.2: Gate Event Capture and Vehicle-to-PO Binding

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a gate officer,
I want to log an inbound vehicle by scanning or keying a PO reference and photographing the challan, even with no network, and have the system create a traceable gate event that auto-reconciles on reconnection,
so that every goods entry is on a traceable record from the first second, a vehicle with no matching PO is captured as "unmatched" rather than turned away, and nothing is lost to a network outage.

Covers UJ-GATE-01 at the inbound edge (realized through FR-W-02 and INT-GATE-01). This is the first story of the inbound execution chain in Epic 3. The gate event creates the vehicle-to-PO binding token (AD-2) that Story 3.3 (weighbridge), Story 3.4 (receiving/GRN), and Story 3.8 (gate-dwell SM-13) consume downstream by `metadata.correlation_id`. [Source: _bmad-output/planning-artifacts/epics.md#Story-3.2, lines 1228-1253]

## Acceptance Criteria

1. **Given** a gate officer opens the edge PWA offline and scans PO `PO-2026-0441`, which exists in the locally synced open-PO projection (Story 2.9)
   **When** the gate event is submitted
   **Then** a gate event is stored locally with status `pending_sync`, the officer sees "Captured, pending sync", and a vehicle-to-PO binding token is created locally carrying the `gate_id`, `officer_id`, and timestamp (AD-2).

2. **Given** the device reconnects
   **When** PowerSync syncs the gate event to the central event store
   **Then** the event auto-reconciles against `PO-2026-0441` in the Story 2.9 open-PO projection, the binding is stamped `matched`, and the binding token is visible to downstream weighbridge and receiving flows within 30 seconds.

3. **Given** a vehicle arrives with a challan referencing an unknown PO
   **When** the gate officer submits the gate event with `po_ref: "UNKNOWN"` (or a reference that resolves to no open PO)
   **Then** the event is captured with `binding_status: "unmatched"` and routed to a named exception owner (unloading supervisor), the vehicle is not turned away, and no event is silently dropped.

4. **Given** the gate officer is offline and photographs the challan
   **When** the photo is attached to the gate event
   **Then** the photo is stored in the local SQLite store with `pending_sync` status and transmitted when the network returns; the challan photo is mandatory for every gate event (marked required in the capture form and enforced server-side).

**Note (gate-in only):** This story captures the inbound gate-entry event only. There is no gate-out timestamp and no e-way-bill-number field in scope here. Outbound gate pass (RGP/NRGP, serially numbered per GSTIN) is FR-GP-01 and is delivered separately. Do not model gate-out or e-way-bill fields in this story. See the open questions.

**Note (reference data, ERP remains master):** PO references resolve against the read-only `erp_purchase_order` projection (Story 2.9). This story never creates, mutates, or writes back to any PO or sales-order projection. Binding is a one-way reference from the gate event to an existing open-PO row. [Source: _bmad-output/planning-artifacts/epics.md, lines 1168-1198]

## Tasks / Subtasks

- [ ] Task 1: Gate event contracts and event registration (AC: 1, 2, 3, 4)
  - [ ] 1.1 In `src/events/schema.ts`, add `GateEnteredPayload` and `GateEnteredEnvelope extends Omit<EventEnvelope, 'payload'>` with literal `event_type: 'gate.entered'`. Payload fields: `gate_event_id` (UUIDv4), `site_code_ext` (ERP/human site code, resolved to a `site` level location), `po_ref_ext` (the scanned PO reference, or the literal `"UNKNOWN"`), `vehicle_reg_ext` (Indian plate format, non-empty, trimmed uppercase), `challan_number_ext`, `challan_photo_ref` (attachment key, mandatory), `driver_name` (optional), `gate_id`, `gate_officer_id`, `entered_at` (ISO timestamp). The binding token is the event `correlation_id` carried in `metadata.correlation_id` (AD-2).
  - [ ] 1.2 Add `GateReversedPayload` and `GateReversedEnvelope` with literal `event_type: 'gate.reversed'`: `gate_event_id`, `reversal_reason` (required, non-empty), `reversed_by`. Reversal is auditor-visible and never deletes the original row (FR-AC-13, AD-16).
  - [ ] 1.3 Register both keys in `SUPPORTED_EVENT_TYPES` as `{ streamType: 'gate', requiresBusinessStream: false }`. Use `streamType: 'gate'` (NOT `inventory`) so business-stream tagging in `src/compliance/business-stream.ts` is not gated on this event (a gate event posts no valuated inventory movement, so it must not raise `UNTAGGED_TRANSACTION`). Keep event names past-tense, dot-separated. See the open questions if the stream-type registry rejects a new value.
  - [ ] 1.4 Add the `gate_event` table to the `EXPECTED` list in `test/unit/schema-drift.test.ts` with its constraints, indexes, and grant expectations.

- [ ] Task 2: Gate event projection DDL (AC: 1, 2, 3)
  - [ ] 2.1 Create `read/projections/gate_event.sql` following the exact idempotent pattern of `read/projections/erp_purchase_order.sql`. Table `gate_event` at grain `gate_event_id UUID PRIMARY KEY`. Columns: `site_id UUID NOT NULL` (internal `location_register.location_id`), `site_code_ext TEXT NOT NULL`, `po_ref_ext TEXT` (NULL or `'UNKNOWN'` when no PO), `binding_status TEXT NOT NULL` (`matched` | `unmatched`), `vehicle_reg_ext TEXT NOT NULL`, `driver_name TEXT`, `challan_number_ext TEXT`, `challan_photo_ref TEXT NOT NULL`, `gate_id TEXT NOT NULL`, `gate_officer_id UUID NOT NULL`, `correlation_id UUID NOT NULL` (the binding token), `entered_at TIMESTAMPTZ NOT NULL`, `business_date DATE NOT NULL` (IST local date, mirror the cycle-count/physical-verification helper), `status TEXT NOT NULL DEFAULT 'open'` (`open` | `reversed`), `reversal_reason TEXT`, `source_event_id UUID NOT NULL`, timestamps.
  - [ ] 2.2 CHECK constraints via guarded `DO $$` blocks checking `pg_constraint`: `chk_gate_event_binding_status` (`binding_status IN ('matched','unmatched')`), `chk_gate_event_status` (`status IN ('open','reversed')`), `chk_gate_event_vehicle_reg_nonempty` (`length(trim(vehicle_reg_ext)) > 0`), `chk_gate_event_challan_photo_nonempty` (`length(trim(challan_photo_ref)) > 0`).
  - [ ] 2.3 Indexes: `(site_id, status)` for the location-scoped worklist, `(po_ref_ext)` for reconcile lookups, `(binding_status, status)` for the unmatched exception worklist, `(correlation_id)` for downstream token joins.
  - [ ] 2.4 Guarded grants in idempotent `DO $$` blocks checking `pg_roles`: `INSERT, SELECT, UPDATE` for `app_user`; `SELECT` for `readonly_user`; no DELETE (reversal is soft).
  - [ ] 2.5 Register `gate_event.sql` in the `MIGRATIONS` array in `src/events/migrate.ts` (append after the last Epic 2 entry). Mirror the DDL BYTE-FOR-BYTE into `deploy/compose/init-db.sql` WITHOUT touching the `powersync_publication` block.

- [ ] Task 3: Gate read-model TypeScript accessor (AC: 2, 3)
  - [ ] 3.1 Create `src/read/projections/gate_event.ts` mirroring `src/read/projections/erp_purchase_order.ts` structure: `runner(client?) = client ?? getPool()`, a `GATE_EVENT_COLUMNS` const, `mapRow`, and `ts()`/`num()`/`numOrNull()` helpers. Bind DATE columns via `to_char(..., 'YYYY-MM-DD')`; never round or compare NUMERIC in JS.
  - [ ] 3.2 Accessors: `getGateEventById(gateEventId, client?)`, `listGateEvents({ siteId?, status?, bindingStatus? }, client?)` (used by the worklist API and downstream consumers), and `upsertGateEvent` / `markGateEventReversed` used ONLY by the compliance seam (not event-sourced elsewhere). Export a `GateEvent` type.

- [ ] Task 4: Gate compliance seam and central write-path wiring (AC: 1, 2, 3)
  - [ ] 4.1 Create `src/compliance/gate.ts` with `assertGateEnteredShape(envelope)`, `assertGateReversedShape(envelope)`, `applyGateProjection(envelope, client, eventId)`. Follow the `src/compliance/ownership.ts` structure.
  - [ ] 4.2 `assertGateEnteredShape` (pre-transaction, before any DB write so a rejected event consumes no idempotency key): require `vehicle_reg_ext` (reject `GATE_VEHICLE_REG_REQUIRED`), require `challan_photo_ref` (reject `GATE_CHALLAN_PHOTO_REQUIRED`), require `po_ref_ext` present as a non-empty string or the literal `"UNKNOWN"` (reject `GATE_PO_REF_REQUIRED`), require `site_code_ext`, `gate_id`, `gate_officer_id`. `assertGateReversedShape`: require `reversal_reason` non-empty (reject `GATE_REVERSAL_REASON_REQUIRED`).
  - [ ] 4.3 `applyGateProjection` for `gate.entered` (in-transaction): resolve `site_code_ext` through `getLocationByCode` requiring an active `level = 'site'` row (reject `GATE_SITE_NOT_FOUND` if unknown or non-site). Resolve `po_ref_ext` through `getPurchaseOrderByRef(po_ref_ext, client)`: if it returns an open PO, set `binding_status = 'matched'`; otherwise (`'UNKNOWN'`, not found, or `status = 'closed'`) set `binding_status = 'unmatched'`. Set `correlation_id = envelope.metadata.correlation_id` (the binding token). Upsert the `gate_event` row keyed on `gate_event_id` (idempotent replay-safe). NEVER write to any `erp_*` projection.
  - [ ] 4.4 `applyGateProjection` for `gate.reversed`: load the gate event, reject `GATE_EVENT_NOT_FOUND` if missing, reject `GATE_ALREADY_REVERSED` if already `reversed`, then set `status = 'reversed'` and `reversal_reason`. Keep the row (soft reversal, auditor-visible).
  - [ ] 4.5 Wire into `src/events/store.ts` `persistEvent`: add `assertGateEnteredShape` / `assertGateReversedShape` alongside the existing pre-transaction asserts (near lines 185-210) and `await applyGateProjection(envelope, client, eventId)` alongside the in-transaction projection calls (near lines 236-262). Preserve the existing `assertLocationInvariant` and `logAuditEntry` post-insert calls.

- [ ] Task 5: Gate REST API with RBAC and site scoping (AC: 1, 2, 3)
  - [ ] 5.1 Create `src/api/v1/gate.ts` following `src/api/v1/erp-projections.ts` and `src/api/v1/ownership-agreements.ts`. Handlers: `POST /api/v1/gate-events` (online capture, emits `gate.entered` via `persistEvent`), `POST /api/v1/gate-events/:gateEventId/reverse` (emits `gate.reversed`), `GET /api/v1/gate-events/:gateEventId` (single, includes resolved PO summary and binding token), `GET /api/v1/gate-events?site=&status=&binding=` (list; `binding=unmatched` is the exception worklist).
  - [ ] 5.2 RBAC via `requireRole` (`src/middleware/rbac.ts`), module `inventory`. Create and reverse: `gate_officer` only. Unmatched worklist (`binding=unmatched`): `unloading_supervisor` and `warehouse_manager` in addition to `gate_officer`. Enforce site scope via `permittedLocationsForModule(roles, 'inventory')`, filtering results to permitted `site_id` and rejecting out-of-scope create/read with `LOCATION_ACCESS_DENIED`. Never trust client-supplied role or identity; take `gate_officer_id` from `authContext`.
  - [ ] 5.3 Register every handler in `src/server.ts` with `router.get`/`router.post` (mirror the existing `erp-projections` and `edge` registration lines). Use the standard error envelope `{ error_code, message, details, trace_id }` from `src/middleware/error.js`.

- [ ] Task 6: Edge (offline) event acceptance and i18n (AC: 1, 2, 4)
  - [ ] 6.1 In `src/sync/upload.ts`, ensure `gate.entered` and `gate.reversed` pass `validateEnvelope` and `validateEdgeEnvelope` on the backend edge intake (`src/api/v1/edge.ts` calls these then `persistEvent`). Add the new validation error codes (`GATE_VEHICLE_REG_REQUIRED`, `GATE_CHALLAN_PHOTO_REQUIRED`, `GATE_PO_REF_REQUIRED`, `GATE_SITE_NOT_FOUND`, `GATE_REVERSAL_REASON_REQUIRED`, `GATE_EVENT_NOT_FOUND`, `GATE_ALREADY_REVERSED`) to the backend permanent-error set in `src/sync/upload.ts`.
  - [ ] 6.2 Add the SAME codes to `PERMANENT_ERROR_CODES` in `edge/src/sync/connector.ts` so the edge client discards them rather than retrying forever, and add `errors.<CODE>` strings for each to `edge/src/messages/en.json`.
  - [ ] 6.3 Confirm the challan-photo attachment path: the photo is captured to local SQLite with `pending_sync` and transmitted on reconnect. Reuse the existing edge attachment mechanism if one exists; if not, store `challan_photo_ref` as the attachment key and record the gap in the open questions. Do NOT invent a new blob pipeline without confirming.

- [ ] Task 7: Tests (AC: 1, 2, 3, 4)
  - [ ] 7.1 Create `test/integration/story-3-2.test.ts` (Node built-in runner `node:test`, mirror `test/integration/` style). Cover: matched capture against an open PO sets `binding_status = 'matched'` and stamps `correlation_id`; unknown/`UNKNOWN` PO sets `binding_status = 'unmatched'`; reversal marks `status = 'reversed'` and preserves the row; `gate_officer` RBAC (non-gate roles rejected); site scoping (out-of-scope site rejected `LOCATION_ACCESS_DENIED`); idempotent replay of the same `gate_event_id`; missing photo rejected `GATE_CHALLAN_PHOTO_REQUIRED`; the seam never writes any `erp_*` table.
  - [ ] 7.2 Add edge unit coverage in `edge/test/unit/` for `gate.entered` envelope validation and the new `PERMANENT_ERROR_CODES` entries.
  - [ ] 7.3 Run `npm test`, `npm run edge:test`, and keep the spine gate green (`npm run spine-acceptance-contract`, story-1-9). Add the `gate_event` expectations so `test/unit/schema-drift.test.ts` passes.

## Dev Notes

### Architecture and conventions the dev MUST follow

- Event-sourced write path has a single seam: `persistEvent(envelope, auditCtx?, externalClient?)` in [src/events/store.ts:163](src/events/store.ts#L163). Shape asserts run pre-transaction (rejects consume no idempotency key); projection apply runs in-transaction. Mirror the existing pattern exactly.
- Projection trio is mandatory and lands together: canonical idempotent `read/projections/gate_event.sql`, registration in the `MIGRATIONS` array of [src/events/migrate.ts](src/events/migrate.ts), and a byte-for-byte mirror in [deploy/compose/init-db.sql](deploy/compose/init-db.sql) that never touches the `powersync_publication` block. Register the table in the `EXPECTED` array of [test/unit/schema-drift.test.ts](test/unit/schema-drift.test.ts).
- TypeScript accessor pattern: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, `ts()`/`num()`/`numOrNull()`; DATE via `to_char(..., 'YYYY-MM-DD')`; NUMERIC bound as strings. Reference [src/read/projections/erp_purchase_order.ts](src/read/projections/erp_purchase_order.ts).
- Runtime is plain Node HTTP with a custom router. Handlers live in `src/api/v1/*.ts` and are registered in [src/server.ts](src/server.ts) via `router.get`/`router.post`. [src/api/router.ts](src/api/router.ts) is the matcher, not the registration site. This is NOT Next.js; there are no `route.ts` files.
- Tests use the Node built-in runner (`node:test`), NOT vitest. Integration tests are one file per story: `test/integration/story-3-2.test.ts`.

### Reuse (do not reinvent)

- `getPurchaseOrderByRef(poNumberExt, client?)` at [src/read/projections/erp_purchase_order.ts:95](src/read/projections/erp_purchase_order.ts#L95) returns the header plus `lines[]` for an open PO, grain `po_number_ext`. Use it for reconciliation. It is reference-only; the ERP projection is read-only (`assertErpReadOnly` in `src/compliance/erp-readonly.ts` rejects `erp.*` writes with `SOURCE_SYSTEM_READ_ONLY`).
- `getLocationByCode(locationCode, client?)` at [src/read/projections/location_register.ts:185](src/read/projections/location_register.ts#L185) resolves a site code to the internal `location_id`. Require an active `level = 'site'` row. This comes from the `location_register` read model (Story 2.1), which already exists.
- RBAC helpers `requireRole` and `permittedLocationsForModule` in [src/middleware/rbac.ts](src/middleware/rbac.ts); error envelope helpers `AppError`, `sendJson`, `sendRequestError` in [src/middleware/error.ts](src/middleware/error.ts). Do not hand-roll auth or error shaping.

### Dependency reality check

- Story 3.1 (warehouse topology) is an unimplemented draft: its task checkboxes are unchecked and it has no File List. Do NOT assume a topology projection from 3.1. The real, existing dependency is the `location_register` read model from Story 2.1, reached via `getLocationByCode`.
- Story 2.9 open-PO projection (`erp_purchase_order`) and its accessor already exist and are the correct binding source.
- Epic 1 edge PWA shell (PWA plus local SQLite plus PowerSync) is assumed operational; the offline capture UI itself (rugged-tablet, scan-first, WCAG 2.1 AA, React and Tailwind, glove-friendly 44x44px targets) is the frontline surface, but this story's committed backend scope is the event contracts, projection, seam, API, and edge intake. Coordinate the PWA form with the edge team; the mandatory-photo and scan-first behaviors are UX requirements from UJ-GATE-01.

### AD-2 binding token

The gate event is the head of the inbound chain. The vehicle-to-PO binding token is the event `correlation_id` (in `metadata.correlation_id`). Downstream Story 3.3 (weighbridge tare/gross/tolerance) and Story 3.4 (receiving/GRN) reference this `correlation_id`, not a timestamp. Story 3.8 computes gate-dwell SM-13 from this gate-entry timestamp. Persist `correlation_id` on the `gate_event` row and index it.

### Compliance and NFR

- Immutable edit log, no hard deletes (FR-AC-13, AD-16): reversal is a `gate.reversed` event that flips `status` to `reversed` and keeps the row. Reversal requires a reason code and is auditor-visible.
- Vehicle registration number is a statutory join key (e-way-bill context, Rs 50,000 threshold). Store it verbatim as `vehicle_reg_ext`; do not normalize away characters.
- Downstream token visibility target is 30 seconds after reconnect (AC2); the edge/PowerSync path already governs this cadence.
- Reconciliation happens at central apply time: when the offline event syncs, `applyGateProjection` resolves the PO reference then. There is no separate reconcile event. `pending_sync` is an edge-local status only and is never a central `binding_status` value.

### Error codes (new, UPPER_SNAKE_CASE)

The gate error codes table below lists every new stable error code, its trigger, and whether it is a permanent edge error. All permanent codes must appear in both the backend permanent set (`src/sync/upload.ts`) and edge `PERMANENT_ERROR_CODES` (`edge/src/sync/connector.ts`) plus i18n `en.json`.

| Error code | Trigger | Permanent (edge) |
| --- | --- | --- |
| `GATE_VEHICLE_REG_REQUIRED` | `vehicle_reg_ext` missing or blank | Yes |
| `GATE_CHALLAN_PHOTO_REQUIRED` | `challan_photo_ref` missing or blank | Yes |
| `GATE_PO_REF_REQUIRED` | `po_ref_ext` missing (empty; use `"UNKNOWN"` when no PO) | Yes |
| `GATE_SITE_NOT_FOUND` | `site_code_ext` unknown or not a `site` level location | Yes |
| `GATE_REVERSAL_REASON_REQUIRED` | `gate.reversed` without a reason | Yes |
| `GATE_EVENT_NOT_FOUND` | reverse targets a non-existent gate event | Yes |
| `GATE_ALREADY_REVERSED` | reverse targets an already-reversed gate event | Yes |

### Project Structure Notes

- New files: `read/projections/gate_event.sql`, `src/read/projections/gate_event.ts`, `src/compliance/gate.ts`, `src/api/v1/gate.ts`, `test/integration/story-3-2.test.ts`, edge unit test under `edge/test/unit/`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `src/server.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`.
- No conflicts with the unified structure; all paths mirror existing Epic 2 projection and API conventions.

### Open questions (resolve during dev or flag in review)

1. Unmatched-vehicle routing owner: the PRD journey text says mismatches route to a "store assistant", but the finalized access matrix routes unmatched-vehicle exceptions to `unloading_supervisor` (with `warehouse_manager` as escalation approver). This story follows the finalized access matrix (`unloading_supervisor`). Confirm before dev if the matrix is authoritative.
2. Challan-photo attachment pipeline: confirm whether an edge attachment mechanism (PowerSync attachments or a blob store) already exists. If not, `challan_photo_ref` holds the attachment key and the transport pipeline is a gap to raise, not to invent in this story.
3. New `streamType: 'gate'` value: confirm the event registry and any stream-type allowlist accept a new stream type, or whether gate events must reuse an existing stream type without triggering business-stream tagging.
4. Gate-out and e-way-bill fields are intentionally out of scope (gate-in only; gate-out is FR-GP-01). Confirm no downstream story in Epic 3 expects a gate-out timestamp on the `gate_event` row.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.2] lines 1228-1253 (story, acceptance criteria, downstream chain).
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1168-1198 (Story 2.9 open-PO projection contract), line 42 (FR-W-02 definition).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] AD-2 binding token, event envelope and consistency conventions, projection and edge-sync invariants.
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md] gate and weighbridge roles (`gate_officer`, `unloading_supervisor`, `warehouse_manager`), SOD-01, SOD-11.
- [Source: src/events/store.ts:163] persistEvent seam; [Source: src/read/projections/erp_purchase_order.ts:95] getPurchaseOrderByRef; [Source: src/read/projections/location_register.ts:185] getLocationByCode.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
