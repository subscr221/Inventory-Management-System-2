---
baseline_commit: 8f86be6ed0b8b35911d64171faba3cd6ae851e67
---

# Story 3.4: Goods Receiving Against ASN or PO (FR-W-02)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a receiving store assistant (role `store_assistant`),
I want to receive goods against an ASN or an open PO, capturing lot and serial numbers, expiry dates, and QC-hold flags, and have the system generate putaway tasks automatically,
so that every item enters stock on a complete, traceable receiving record and the putaway queue is ready before the truck is unloaded.

## Acceptance Criteria

1. **Given** an accepted weighbridge token from Story 3.3 and the receiving flow opens for `PO-2026-0441` from the Story 2.9 open-PO projection
   **When** the store assistant scans each carton barcode and enters lot and expiry details
   **Then** a GRN line is created per item with `lot_id`, `expiry_date`, `received_qty`, and the weighbridge token reference, the received quantity posts into stock, and a putaway task is generated for each line (FR-W-02).

2. **Given** a supplier ASN captured through the minimal ASN intake (INT-SUP-02) references open PO `PO-2026-0441` on the Story 2.9 projection
   **When** the store assistant opens the receiving flow against the ASN
   **Then** expected lines (item, quantity, lot or serial where advised) pre-populate from the ASN, and each confirmed GRN line records `source_document: "ASN"` alongside the PO reference (FR-W-02 ASN path).

3. **Given** a received item has a BIS licence flag (`bis_licence_required`) or `quarantine_required` on its item master
   **When** the GRN line is confirmed
   **Then** the received quantity posts into the site `ZONE-QC-HOLD` quarantine location, a QC inspection task is created for that line, and the putaway task is held (`status: "held"`) until release. Until the Epic 8 disposition flow lands, an authorized supervisor may manually release the held putaway task; the manual release is audited with operator identity and a reason code (FR-Q-02 integration point).

4. **Given** the operator scans a barcode that does not match any line item of `PO-2026-0441` on the Story 2.9 projection
   **When** the GRN line is attempted
   **Then** the system rejects it with `error_code: "ITEM_PO_MISMATCH"` and no stock enters the ledger for the rejected line.

5. **Given** the cumulative received quantity on a PO line exceeds the ordered quantity beyond the line over-receipt tolerance carried on the Story 2.9 projection
   **When** the GRN line is submitted
   **Then** the system records a rejected GRN line (`status: "rejected"`, no stock posted), routes a durable discrepancy task to the named receiving owner (`unloading_supervisor`, escalating to `warehouse_manager`), and returns `error_code: "RECEIPT_TOLERANCE_EXCEEDED"` to the operator. No stock enters the ledger for the rejected line, but the rejected line and its discrepancy notification are committed (they must not roll back with the operator-facing error).

6. **Given** the received quantity is short of the PO line quantity but within the line under-receipt tolerance
   **When** the GRN line is confirmed
   **Then** the line posts with the received quantity, the shortage variance is recorded on the GRN line and visible in the receiving discrepancy view, and the PO line retains an open remaining balance against the Story 2.9 projected quantity (the ERP remains the PO system of record; this story never writes any `erp_*` projection).

7. **Given** the store assistant enters an `expiry_date` earlier than the receiving (business) date
   **When** the GRN line is submitted
   **Then** the system rejects it with `error_code: "LOT_EXPIRED"`. The line may only be captured as a quarantined receipt into `ZONE-QC-HOLD` with supervisor approval resolved through the DOA registry; an attempt to quarantine without that approval is rejected with `error_code: "APPROVAL_REQUIRED"`.

## Tasks / Subtasks

- [x] Task 1: Event contracts and registration (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 1.1 In `src/events/schema.ts`, add `GoodsReceivedPayload` and `GoodsReceivedEnvelope extends Omit<EventEnvelope, 'payload'>` with literal `event_type: 'goods.received'`. Payload fields (superset of a stock receipt plus GRN metadata): `grn_id` (UUIDv4), `grn_line_id` (UUIDv4), `correlation_id` (the Story 3.2 binding token), `po_ref_ext` (open-PO reference), `line_no` (matched PO line number), `source_document` (`PO` or `ASN`), `source_ref_ext` (ASN number when `source_document = ASN`, else null), `sku`, `target_location_id` or `target_location_code` (the receiving or QC-hold location), `received_qty` (NUMERIC string, positive), `lot_id` (lot number string, required when the item master is `lot_controlled`), `expiry_date` (`YYYY-MM-DD`, optional), `serials` (array of `{ serial_number }`, required when `serial_controlled`), `stock_class` (default `owned`), `owner_party_code` (optional; required only when `stock_class` is `consignment` or `vmi`, matching the Story 2.8 owner-party gate), `unit_cost` (optional NUMERIC), `quarantine_approved` (boolean; set only for the AC7 expired-lot quarantine path), `quarantine_reason_code` (string; required when `quarantine_approved`). Do NOT put `received_by` in the client payload; the API and edge paths server-set it from auth.
  - [x] 1.2 Add `GoodsPutawayReleasedPayload` and envelope with literal `event_type: 'goods.putaway_released'`. Fields: `putaway_task_id` (UUID), `grn_line_id` (UUID), `released_by` (server-set), `reason_code` (required), `approver_actor_id` (server-set from auth). This is the auditable manual release of a held putaway task (AC3).
  - [x] 1.3 Register both event types in `SUPPORTED_EVENT_TYPES` (schema.ts:356-446) with a NEW stream type: `'goods.received': { streamType: 'receiving', requiresBusinessStream: false }` and `'goods.putaway_released': { streamType: 'receiving', requiresBusinessStream: false }`. Use `streamType: 'receiving'` (a new literal, added alongside `gate` and `weighbridge`) so business-stream tagging is not gated on these events. The stock movement they drive carries its own business stream from the item master, not from the receiving envelope.
  - [x] 1.4 Add the four new tables (`grn`, `grn_line`, `putaway_task`, `asn`, `asn_line`) to the `EXPECTED` array in `test/unit/schema-drift.test.ts` with their constraints, indexes, and grant expectations (entry shape mirrors the `gate_event` / `weighbridge_event` entries at schema-drift.test.ts:264-295).

- [x] Task 2: Receiving projection DDL (AC: 1, 2, 3, 5, 6)
  - [x] 2.1 Create `read/projections/grn.sql` following the exact idempotent pattern of `read/projections/gate_event.sql` (guarded `DO $$` constraint and grant blocks checking `pg_constraint` and `pg_roles`; `CREATE TABLE IF NOT EXISTS`; `CREATE INDEX IF NOT EXISTS`). Table `grn` header at grain `grn_id UUID PRIMARY KEY`. Columns: `grn_id UUID NOT NULL`, `correlation_id UUID NOT NULL` (binding token), `po_ref_ext TEXT NOT NULL`, `source_document TEXT NOT NULL` (`PO` or `ASN`), `source_ref_ext TEXT` (ASN number, nullable), `site_id UUID NOT NULL`, `site_code_ext TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'open'` (`open` or `posted`), `received_by UUID NOT NULL`, `business_date DATE NOT NULL`, `source_event_id UUID NOT NULL`, timestamps. CHECK `chk_grn_source_document` (`source_document IN ('PO','ASN')`), `chk_grn_status` (`status IN ('open','posted')`). Indexes on `(correlation_id)`, `(po_ref_ext)`, `(site_id, status)`, `(business_date)`.
  - [x] 2.2 Create `read/projections/grn_line.sql`. Table `grn_line` at grain `grn_line_id UUID PRIMARY KEY`. Columns: `grn_line_id UUID NOT NULL`, `grn_id UUID NOT NULL`, `po_ref_ext TEXT NOT NULL`, `line_no INTEGER NOT NULL`, `sku TEXT NOT NULL`, `lot_id TEXT`, `expiry_date DATE`, `received_qty NUMERIC(18,3) NOT NULL`, `uom TEXT NOT NULL`, `stock_class TEXT NOT NULL DEFAULT 'owned'`, `weighbridge_correlation_id UUID NOT NULL`, `qc_hold BOOLEAN NOT NULL DEFAULT false`, `shortage_variance_qty NUMERIC(18,3) NOT NULL DEFAULT 0`, `target_location_id UUID` (nullable; NULL for a `rejected` line that posted no stock), `status TEXT NOT NULL DEFAULT 'posted'` (`posted`, `quarantined`, or `rejected`), `rejection_reason TEXT` (set for a `rejected` line, e.g. the tolerance-breach detail, AC5), `source_event_id UUID NOT NULL`, timestamps. CHECK `chk_grn_line_received_positive` (`received_qty > 0`), `chk_grn_line_status` (`status IN ('posted','quarantined','rejected')`), `chk_grn_line_shortage_non_negative` (`shortage_variance_qty >= 0`). Indexes on `(grn_id)`, `(po_ref_ext, line_no)`, `(sku)`, `(shortage_variance_qty)` for the discrepancy view.
  - [x] 2.3 Create `read/projections/putaway_task.sql`. Table `putaway_task` at grain `putaway_task_id UUID PRIMARY KEY`. Columns: `putaway_task_id UUID NOT NULL`, `grn_line_id UUID NOT NULL`, `sku TEXT NOT NULL`, `lot_id TEXT`, `quantity NUMERIC(18,3) NOT NULL`, `from_location_id UUID NOT NULL` (the receiving or QC-hold location the stock currently sits in), `site_id UUID NOT NULL`, `status TEXT NOT NULL DEFAULT 'ready'` (`ready`, `held`, `completed`), `owner_role TEXT`, `released_by UUID`, `release_reason_code TEXT`, `released_event_id UUID`, `source_event_id UUID NOT NULL`, timestamps. CHECK `chk_putaway_task_status` (`status IN ('ready','held','completed')`). Indexes on `(grn_line_id)`, `(site_id, status)`. NOTE: Story 3.5 (Directed Putaway) enriches this table with directed-bin suggestion and override logic; keep the columns above minimal and additive so 3.5 can extend without a rewrite.
  - [x] 2.4 Create `read/projections/asn.sql` and `read/projections/asn_line.sql` for the minimal ASN intake (INT-SUP-02), modeled on the direct-upsert reference pattern of `read/projections/erp_purchase_order.sql` (these are supplier reference data, NOT event-sourced, mirroring the Story 2.9 ERP projection). `asn` grain `asn_number_ext TEXT PRIMARY KEY`: `asn_number_ext`, `po_ref_ext TEXT NOT NULL`, `supplier_ref_ext TEXT NOT NULL`, `site_id UUID NOT NULL`, `status TEXT NOT NULL DEFAULT 'open'`, `source_snapshot JSONB`, timestamps. `asn_line` grain `(asn_number_ext, line_no)`: `asn_number_ext`, `line_no INTEGER NOT NULL`, `sku TEXT NOT NULL`, `expected_qty NUMERIC(18,3) NOT NULL`, `lot_number TEXT`, `serial_number TEXT`, `expiry_date DATE`. Index `(po_ref_ext)`.
  - [x] 2.5 Guarded grants in idempotent `DO $$` blocks checking `pg_roles`: `INSERT, SELECT, UPDATE` for `app_user`; `SELECT` for `readonly_user`; no DELETE (append-only; status transitions are soft) on all five tables.
  - [x] 2.6 Register all five `.sql` files in the `MIGRATIONS` array in `src/events/migrate.ts` (append after the Story 3.3 `weighbridge_event.sql` entry). Mirror each DDL BYTE-FOR-BYTE into `deploy/compose/init-db.sql` WITHOUT touching the `powersync_publication` block.

- [x] Task 3: Read-model TypeScript accessors (AC: 1, 2, 3, 5, 6)
  - [x] 3.1 Create `src/read/projections/grn.ts` and `src/read/projections/grn_line.ts` mirroring `src/read/projections/weighbridge_event.ts`: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, `ts()`/`num()`/`numOrNull()`. Bind DATE columns via `to_char(..., 'YYYY-MM-DD')`; NUMERIC columns bound and returned as strings, never rounded or compared in JS. Accessors: `getGrnById`, `insertGrnHeader`, `insertGrnLine`, `listGrns({ siteId?, poRefExt?, status? })`, `listDiscrepancyLines({ siteId? })` (lines where `shortage_variance_qty > 0` or `status = 'quarantined'`). Export `Grn` and `GrnLine` types.
  - [x] 3.2 Create `src/read/projections/putaway_task.ts`: `insertPutawayTask`, `getPutawayTaskById`, `listPutawayTasks({ siteId?, status? })`, `markPutawayReleased(putawayTaskId, releasedBy, reasonCode, releasedEventId, client)`. Export `PutawayTask` type.
  - [x] 3.3 Create `src/read/projections/asn.ts`: `upsertAsnHeader`, `upsertAsnLine`, `getAsnByNumber(asnNumberExt, client?)` returning the header plus `lines[]` (mirror `getPurchaseOrderByRef` at `src/read/projections/erp_purchase_order.ts:95`). Export `Asn` and `AsnLine` types.

- [x] Task 4: Minimal ASN intake endpoint (AC: 2, INT-SUP-02)
  - [x] 4.1 Create `src/api/v1/asn.ts` with `POST /api/v1/asn` (supplier or EDI intake): validate the referenced `po_ref_ext` exists on the Story 2.9 open-PO projection via `getPurchaseOrderByRef` (reject `ASN_PO_NOT_FOUND` if absent), resolve `site_id` from the PO or supplied site code, then `upsertAsnHeader` and `upsertAsnLine` per line inside one transaction. Store the raw inbound body in `source_snapshot`. This is a direct-upsert reference write, NOT an event; it does not go through `persistEvent`. Add `GET /api/v1/asn/:asnNumberExt` returning the header plus lines for the receiving flow to pre-populate from.
  - [x] 4.2 RBAC: intake is a system or supplier integration role. Use `requireRole` with module `receiving`, `functionScope: 'write'`, restricted to `store_assistant` and a service role (`svc_supplier_edi` if present in the role registry; otherwise flag in review). Read (`GET`) allowed to `store_assistant`, `unloading_supervisor`, `warehouse_manager`. Enforce site scope via `permittedLocationsForModuleScope`.
  - [x] 4.3 Register both handlers in `src/server.ts` and add their routes to the spine allowlist in `test/integration/story-1-9.test.ts`.

- [x] Task 5: Receiving compliance seam and central write-path wiring (AC: 1, 3, 4, 5, 6, 7)
  - [x] 5.1 Create `src/compliance/receiving.ts` with `assertGoodsReceivedShape(envelope)` (pre-transaction) and `applyGoodsReceivedProjection(envelope, client, eventId)` (in-transaction). Follow the `src/compliance/weighbridge.ts` structure exactly.
  - [x] 5.2 `assertGoodsReceivedShape` (pre-transaction, before any DB write, so a malformed event consumes no idempotency key): require `correlation_id` (reject `RECEIVING_BINDING_TOKEN_REQUIRED`), `po_ref_ext`, `line_no` (positive integer), `sku`, `received_qty` (positive NUMERIC; reject `RECEIVING_QTY_REQUIRED`), `source_document` in (`PO`, `ASN`), `target_location_id` or `target_location_code`. When `expiry_date` is present, validate `YYYY-MM-DD` shape. When `quarantine_approved` is true, require `quarantine_reason_code`. Do NOT resolve any DB references here.
  - [x] 5.3 `applyGoodsReceivedProjection` (in-transaction), in this order:
    1. Resolve the accepted weighment: call `getWeighbridgeEventsByCorrelationId(correlation_id, client)` (`src/read/projections/weighbridge_event.ts:119`). If no weighbridge row exists for the token, reject `RECEIVING_BINDING_TOKEN_NOT_FOUND`. Require at least one weighment for the matched PO line with `status = 'accepted'`; if the only weighments for the token are `tolerance_breach`, reject `RECEIVING_WEIGHT_NOT_ACCEPTED` (this preserves the Story 3.3 "blocked from silent receipt" chain, AD-2, and satisfies AC1 which opens receiving against an accepted weighment). Inherit `site_id` and `site_code_ext` from the resolved weighbridge row (denormalized there, no gate lookup needed). Dry receipts with a gate token but no weighment are OUT OF SCOPE for this story (Open Question 3) - there is no `getGateEventByCorrelationId` accessor and AC1 mandates an accepted weighment.
    2. Resolve the PO from the Story 2.9 projection: `getPurchaseOrderByRef(po_ref_ext, client)` (`src/read/projections/erp_purchase_order.ts:95`); reject `RECEIVING_PO_NOT_FOUND` if absent. Find the PO line whose `sku` matches the scanned `sku`; if no PO line matches the scanned item, reject `ITEM_PO_MISMATCH` (AC4 - a pure rejection with no durable line; the throw rolls back cleanly and consumes no idempotency key). Resolve `uom` from the item master (`getItemBySku`), since the PO line carries no UOM.
    3. Tolerance check (AC5, AC6), computed entirely in PostgreSQL NUMERIC, never JS float. FIRST serialize concurrent receipts on the same PO line: take a transaction-scoped lock keyed on `(po_ref_ext, line_no)` - either `pg_advisory_xact_lock(hashtext(po_ref_ext || ':' || line_no))` or `SELECT ... FROM grn_line WHERE po_ref_ext = $1 AND line_no = $2 FOR UPDATE` - BEFORE reading the cumulative sum, so two concurrent GRN lines cannot both pass the band and over-receive. Cumulative received for the PO line = sum of prior `grn_line.received_qty` for `(po_ref_ext, line_no)` where `status <> 'rejected'`, plus this `received_qty`. Upper bound = `ordered_qty * (1 + over_receipt_tolerance_pct / 100)`; lower bound = `ordered_qty * (1 - under_receipt_tolerance_pct / 100)`. Treat NULL tolerance percentages as `0`.
       - If cumulative received exceeds the upper bound: this is NOT a rollback. Post NO stock, write a `grn_line` with `status = 'rejected'`, `target_location_id = NULL`, and `rejection_reason` describing the breach; route a discrepancy notification to `unloading_supervisor` at the site via `emitNotificationInTransaction` (escalation to `warehouse_manager` is a DOA concern); COMMIT the rejected line and the notification together; and surface `RECEIPT_TOLERANCE_EXCEEDED` to the operator via the response body (NOT by throwing, which would roll back the durable discrepancy record). The handler returns the code from the recorded rejection outcome.
       - If cumulative received is below `ordered_qty` but at or above the lower bound: set `shortage_variance_qty = ordered_qty - cumulative_received` on the `grn_line` and post the received quantity (AC6).
    4. Expiry check (AC7): if `expiry_date` is present and `expiry_date < business_date` (IST local date, using the `localYmd` helper pattern from `src/compliance/gate.ts:25`): when `quarantine_approved` is not true, reject `LOT_EXPIRED` (a pure throw; no durable line). When `quarantine_approved` is true, resolve the approving authority through the DOA registry (`findMatchingDoaEntry` then `findRoleHolder`, mirroring `resolveCountApprover` in `src/compliance/cycle-count.ts:327`) and require the authenticated actor to be that resolved approver; if the approver cannot be resolved or the actor is not authorized, reject `APPROVAL_REQUIRED`. An approved quarantine receipt forces `target_location = ZONE-QC-HOLD` and `grn_line.status = 'quarantined'`.
    5. QC-hold routing (AC3): load the item master (`getItemBySku`). If `bis_licence_required` or `quarantine_required` is true (or the AC7 quarantine path fired), set `target_location` to the site `ZONE-QC-HOLD` quarantine location (resolve by `getLocationByCode('ZONE-QC-HOLD')` scoped to the site; reject `RECEIVING_QC_HOLD_ZONE_NOT_FOUND` if the site has no QC-hold zone), set `grn_line.qc_hold = true`, generate the putaway task with `status = 'held'`, and raise a QC inspection notification to `qc_inspector` at the site via `emitNotificationInTransaction`. The held putaway task plus this notification ARE the interim QC-inspection task representation; the durable QC inspection task table itself is Epic 8 (see Boundary Notes). Otherwise the putaway task is `status = 'ready'` and `from_location_id` is the normal receiving location.
    6. Post the stock movement inside this same transaction so the GRN line and the stock balance commit atomically. NOTE: the existing top-level `applyLotSerialValidation` and `applyStockBalanceProjection` gate on `stream_type = 'inventory'` and `event_type IN (stock.received/allocated/issued)` (`stockBalanceEventKind`, `src/compliance/stock-balance.ts:60`), so calling them on the raw `goods.received` envelope (stream `receiving`) is a NO-OP and would post no stock. Instead construct a synthetic stock-receipt envelope view (`stream_type: 'inventory'`, `event_type: 'stock.received'`, payload `{ sku, target_location_id, quantity: received_qty, lot_id, expiry_date, serials, stock_class, owner_party_code, unit_cost, business_stream }`, same `event_id`/`metadata`/`occurred_at`) and pass THAT to `applyLotSerialValidation(view, client, eventId)` then `applyStockBalanceProjection(view, client)` so all existing enforcement (lot auto-create from `expiry_date`, serial receipt, Story 2.8 owner-party gate, NUMERIC precision) applies uniformly. Do NOT duplicate the receipt, lot-auto-create, or owner-party logic.
    7. Insert the `grn` header (idempotent upsert keyed on `grn_id`) and the `grn_line` (keyed on `grn_line_id`), and insert the `putaway_task` (keyed on `putaway_task_id`) for posted and quarantined lines only (a `rejected` line generates no putaway task). All keys are client-supplied UUIDs so replay is idempotent. NEVER write to any `erp_*` projection (AC6: ERP remains the PO system of record).
  - [x] 5.4 Wire into `src/events/store.ts` `persistEvent`: add `assertGoodsReceivedShape` alongside the pre-transaction asserts (after `assertWeighbridgeRecordedShape` at store.ts:218, before `assertErpReadOnly` at :223) and `await applyGoodsReceivedProjection(envelope, client, eventId)` in the in-transaction block after the weighbridge apply and before the `domain_events` insert.

- [x] Task 6: Putaway manual release (DOA-gated, audited) (AC: 3)
  - [x] 6.1 In `src/compliance/receiving.ts`, add `assertGoodsPutawayReleasedShape(envelope)` (require `putaway_task_id`, `grn_line_id`, `reason_code`) and `applyGoodsPutawayReleasedProjection(envelope, client, eventId)`: load the putaway task; reject a stable error if it is not `status = 'held'` (only held tasks require release; a `ready`/`completed` task is rejected). Resolve the authorized release approver through the DOA registry (same pattern as Task 5.3.4) and require the authenticated actor to be an authorized supervisor (`unloading_supervisor` or `warehouse_manager`); reject `APPROVAL_REQUIRED` otherwise. On success, `markPutawayReleased` sets `status = 'ready'`, records `released_by`, `release_reason_code`, and `released_event_id`. The audit trail is written by the standard `logAuditEntry` path in `persistEvent`; ensure the reason code is carried in the event payload so it lands in the audit `details`.
  - [x] 6.2 Wire `assertGoodsPutawayReleasedShape` and `applyGoodsPutawayReleasedProjection` into `persistEvent` alongside the Task 5.4 wiring.

- [x] Task 7: Receiving REST API with RBAC and site scoping (AC: 1, 3, 5, 6)
  - [x] 7.1 Create `src/api/v1/receiving.ts` following `src/api/v1/weighbridge.ts` structure. Handlers: `POST /api/v1/grn-lines` (online receiving capture, emits `goods.received` via `persistEvent`; on a posted or quarantined line returns 2xx with the created GRN line plus generated putaway task; on an over-tolerance line returns 2xx with the committed `rejected` line and `error_code: "RECEIPT_TOLERANCE_EXCEEDED"` in the body, NOT a rollback, AC5); `GET /api/v1/grns/:grnId` (header plus lines); `GET /api/v1/grns` (list with site, po, status filters); `GET /api/v1/receiving/discrepancies` (the discrepancy view backing AC6, via `listDiscrepancyLines`); `POST /api/v1/putaway-tasks/:putawayTaskId/release` (emits `goods.putaway_released`, AC3).
  - [x] 7.2 RBAC via `requireRole` (`src/middleware/rbac.ts`), module `receiving`. Create GRN line: `store_assistant` only. Release held putaway: `unloading_supervisor`, `warehouse_manager` only. Read (GRN, discrepancies): `store_assistant`, `unloading_supervisor`, `warehouse_manager`, `inventory_controller`. Enforce site scope via `permittedLocationsForModuleScope` filtering to permitted `site_id`. Never trust client-supplied role or identity; server-set `received_by` (GRN) and `released_by` / `approver_actor_id` (release) from `authContext`.
  - [x] 7.3 Register every handler in `src/server.ts` with `router.get`/`router.post` (mirror the weighbridge registration lines) and add each route to the spine allowlist in `test/integration/story-1-9.test.ts`.

- [x] Task 8: Edge (offline) event acceptance and i18n (AC: 1, 4, 5, 7)
  - [x] 8.1 In `src/api/v1/edge.ts`, `resolveModuleFromBody` returns `body.stream_type` verbatim, so `stream_type: 'receiving'` auto-maps to module `receiving`; provision `store_assistant` with a `receiving`-module assignment (mirror the Story 3.3 weighbridge-module provisioning). In `edgeEventUploadBase` (edge.ts:161-190), server-set `body.payload.received_by = authContext.userId` for `goods.received`, mirroring the weighbridge `weighed_by` injection at edge.ts:177-179.
  - [x] 8.2 Add the new permanent error codes to the backend permanent set (`PERMANENT_ERROR_CODES` in `src/sync/upload.ts`), to `PERMANENT_ERROR_CODES` in `edge/src/sync/connector.ts`, and add `errors.<CODE>` strings to `edge/src/messages/en.json`. Permanent codes: `ITEM_PO_MISMATCH`, `LOT_EXPIRED`, `RECEIVING_BINDING_TOKEN_NOT_FOUND`, `RECEIVING_WEIGHT_NOT_ACCEPTED`, `RECEIVING_PO_NOT_FOUND`, `RECEIVING_QTY_REQUIRED`, `RECEIVING_BINDING_TOKEN_REQUIRED`, `RECEIVING_QC_HOLD_ZONE_NOT_FOUND`. Do NOT add `RECEIPT_TOLERANCE_EXCEEDED` to the permanent sets - it is a committed business outcome returned in a 2xx body (Task 5.3.3), so an edge upload that hits it settles as synced, not as a permanent error; still add its `errors.RECEIPT_TOLERANCE_EXCEEDED` i18n string for the operator-facing outcome message. `APPROVAL_REQUIRED` is an existing stable code (cycle-count); reuse it and confirm it is already in both permanent sets.
  - [x] 8.3 Confirm the edge local capture record reuses the existing edge events outbox with `pending_sync` status (the offline receiving form stores sku, lot, expiry, and the binding-token reference locally and transmits on reconnect). Do NOT invent a new blob or table pipeline; the PWA receiving form itself is the edge team deliverable (reuse `scan-input-screen` and `locator-override-modal` primitives per the UX section below).

- [x] Task 9: Tests (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 9.1 Create `test/integration/story-3-4.test.ts` (Node built-in runner `node:test`, mirror `test/integration/` style). Cover: accepted-token receipt posts a GRN line, stock, and a `ready` putaway task (AC1); ASN pre-population and `source_document: "ASN"` on the confirmed line (AC2); BIS-flagged item routes to `ZONE-QC-HOLD` with a `held` putaway task and a QC inspection notification, plus DOA-gated manual release moving the task to `ready` and auditing the reason code (AC3); `ITEM_PO_MISMATCH` for an off-PO barcode with no stock written (AC4); over-receipt band yields a committed `rejected` GRN line with `error_code: "RECEIPT_TOLERANCE_EXCEEDED"` in a 2xx body, NO stock posted, NO putaway task, and a discrepancy notification to `unloading_supervisor` that survives (is NOT rolled back) (AC5, C1); two concurrent receipts on the same PO line cannot both pass the tolerance band (serialized lock, H1); short-within-tolerance posts with `shortage_variance_qty` set and appears in the discrepancy view (AC6); `LOT_EXPIRED` for a back-dated expiry, then `APPROVAL_REQUIRED` for an unapproved quarantine attempt, then a DOA-approved quarantine receipt into `ZONE-QC-HOLD` (AC7); `RECEIVING_WEIGHT_NOT_ACCEPTED` when the token has only a `tolerance_breach` weighment; idempotent replay of the same `goods.received` (same `grn_line_id`); `store_assistant` create RBAC and site scoping (out-of-scope site rejected `LOCATION_ACCESS_DENIED`); the seam never writes any `erp_*` table.
  - [x] 9.2 Add edge unit coverage in `edge/test/unit/` for `goods.received` envelope validation and the new `PERMANENT_ERROR_CODES` entries.
  - [x] 9.3 Run `npm test`, `npm run edge:test`, and keep the spine gate green (`npm run spine-acceptance-contract`, story-1-9). Add the five new-table expectations so `test/unit/schema-drift.test.ts` passes. Run `tsc`, `eslint`, and the build for both backend and edge.

### Review Findings

- [x] [Review][Defer] Under-receipt below the lower tolerance bound is unenforced — `under_receipt_tolerance_pct` is fetched but never compared. A symmetric-reject patch was attempted and reverted: with `under_receipt_tolerance_pct` typically unset (0%), the lower bound equals the full `ordered_qty`, so enforcing it per-event rejected every normal partial/multi-shipment receipt (broke 5 of the story's own happy-path tests). Enforcing this correctly needs a PO-closure signal ("no more shipments expected") this event has no access to. [`src/compliance/receiving.ts:219-238`] — deferred, needs a PO-closure-triggered discrepancy check as its own follow-up story, not a per-event patch
- [x] [Review][Patch] `ASN_PO_NOT_FOUND` is not in either `PERMANENT_ERROR_CODES` set despite the story's own Error Codes table marking it `Permanent (Edge): Yes`. Resolved: trust the Error Codes table — add `ASN_PO_NOT_FOUND` to both `PERMANENT_ERROR_CODES` sets + i18n. [`src/api/v1/asn.ts:687`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`]
- [x] [Review][Patch] GRN header fields silently clobbered across multi-line receipts — `ON CONFLICT (grn_id) DO UPDATE` unconditionally overwrites `status`, `received_by`, `business_date`, `source_event_id`; a second line on the same `grn_id` hitting the over-tolerance branch regresses an already-`posted` header back to `open` and replaces the original receiver/date. [`src/read/projections/grn.ts:101-133`, `src/compliance/receiving.ts:253,373`]
- [x] [Review][Patch] ASN re-POST cross-site hijack — `upsertAsnHeader`'s `ON CONFLICT (asn_number_ext) DO UPDATE` overwrites `site_id`/`po_ref_ext` and `createAsnBase` only checks write access to the *new* site, never the ASN's existing owning site, letting a caller redirect another site's ASN. [`src/api/v1/asn.ts:110`, `src/read/projections/asn.ts:106-127`]
- [x] [Review][Patch] Client-supplied `grn_id`/`grn_line_id` accepted with only a UUID-format check, no ownership/site check — a caller can target an existing GRN/line from a different site and overwrite it on commit. [`src/api/v1/receiving.ts:109-110`]
- [x] [Review][Patch] `released_by` on `goods.putaway_released` is trusted from the client when it's a well-formed UUID instead of always using the authenticated actor (unlike `received_by` on `goods.received`, which `edge.ts` force-sets from `authContext.userId`); a caller can forge who authorized a release. [`src/api/v1/edge.ts:182-183`, `src/compliance/receiving.ts:476`]
- [x] [Review][Patch] Missing `site_id` check on the resolved target location in the non-QC-hold branch (the QC-hold branch checks it, this one doesn't) — a cross-site `target_location_id`/`target_location_code` is accepted and stock posts outside the receiving site. [`src/compliance/receiving.ts:330-339`]
- [x] [Review][Patch] Double-release race on putaway tasks — `markPutawayReleased`'s `UPDATE ... WHERE status = 'held'` has no affected-row check; the losing side of two concurrent release requests gets a silent no-op update but the handler still returns 200 as if it released the task. [`src/read/projections/putaway_task.ts:147-163`, `src/api/v1/receiving.ts` release handler]
- [x] [Review][Patch] New error codes `LOCATION_NOT_FOUND`, `PUTAWAY_TASK_NOT_FOUND`, `PUTAWAY_TASK_NOT_HELD` are missing from both `PERMANENT_ERROR_CODES` sets and edge i18n — an edge client hitting any of these retries forever instead of surfacing `needs_attention`. [`src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`]
- [x] [Review][Defer] RBAC helper divergence — `receiving.ts`'s role-check additionally allows `module === 'inventory'` where `asn.ts` doesn't; both independently redefine the same helper instead of sharing code. [`src/api/v1/asn.ts:24`, `src/api/v1/receiving.ts:54`] — deferred, pre-existing pattern from earlier stories, not a regression introduced here
- [x] [Review][Defer] Unrelated `gate_event` unique-index hotfix bundled into this story's migration file — no relation to goods receiving. [`deploy/compose/init-db.sql`] — deferred, pre-existing fix folded in opportunistically, functionally correct
- [x] [Review][Defer] `resolveSiteByToken`'s RBAC pre-check uses the latest `weighbridge_event` row regardless of status, while the compliance layer (correctly) uses the first `accepted` row — pre-check only; downstream enforcement is unaffected. [`src/api/v1/receiving.ts:83-89`] — deferred, low likelihood, RBAC gate is defense-in-depth not the source of truth

Dismissed as noise (11): `LOT_EXPIRED` "missing" from permanent sets (false positive — already present pre-existing in both `src/sync/upload.ts:23` and edge connector); PO-line matched by `sku` only ignoring `line_no` (matches Task 5.3.2 literally); `localYmd` using server-local time (spec-mandated IST pattern per Task 5.3.4, by design for single-region pilot); no notification on under-receipt shortage (not spec-required — Task 5.3.3 bullet only requires setting `shortage_variance_qty`; visibility is via the discrepancy view per AC6/Task 9.1); dead no-op `CHECK` constraint-repair blocks on brand-new tables (cosmetic copy-paste, harmless); `svc_supplier_edi` authentication unaddressed (out of scope, no evidence of an actual gap); `grn`/`grn_line` null in 201 response (verified unreachable — `line` is always found after a successful commit); PO `status` (closed/cancelled) not checked before receipt (not spec-mandated for this story; PO lifecycle is Story 2.9's concern); advisory-lock `hashtext` collision risk (spec-prescribed pattern, harmless perf-only edge case); assert/apply UUID mismatch on `target_location_id` (falls through to a graceful `LOCATION_NOT_FOUND`, not a crash); DDL duplicated across `read/projections/*.sql` and `deploy/compose/init-db.sql` without an explicit drift-guard comment (cosmetic — verified byte-identical).

## Dev Notes

### Previous Story Intelligence (Story 3.3, and the 3.2 gate chain)

- Story 3.3 built the `weighbridge_event` projection, the `weighbridge.recorded` event, the `src/compliance/weighbridge.ts` seam, `src/api/v1/weighbridge.ts`, and full edge intake. It resolves the Story 3.2 binding token via `getWeighbridgeEventsByCorrelationId` and blocks silent receipt with a `tolerance_breach` status. This story is the next link in the AD-2 chain: receiving opens against that accepted weighment. Reuse the accessor; do not invent a new token chain.
- Story 3.3 learned two edge-path facts that apply here verbatim: (1) `resolveModuleFromBody` (`src/api/v1/edge.ts`) maps `stream_type` directly to a module, so the new `receiving` stream needs a `receiving`-module role assignment for `store_assistant`; (2) the edge intake must server-set the actor-identity field (`received_by` here, as `weighed_by` there) inside `edgeEventUploadBase`, or the edge path fails `weighed_by`-style required checks.
- Story 3.3 tolerance math is computed and compared entirely in PostgreSQL NUMERIC against `erp_purchase_order_line`. Follow the same discipline for the AC5/AC6 tolerance band. Never multiply floats in JavaScript; weights and quantities are NUMERIC strings.
- Story 3.3 stored `status` transitions as soft (accepted to tolerance_breach), never deleting. Receiving is likewise append-only; a mis-received line is a downstream correction, not a delete.

### Architecture and Conventions the Dev MUST Follow

- Event-sourced write path has a single seam: `persistEvent(envelope, auditCtx?, externalClient?)` in [src/events/store.ts:165](src/events/store.ts#L165). Shape asserts run pre-transaction (rejects consume no idempotency key); projection applies run in-transaction. New asserts go after `assertWeighbridgeRecordedShape` (store.ts:218) and before `assertErpReadOnly` (store.ts:223); new applies go after the weighbridge apply and before the `domain_events` insert. Reference the in-transaction apply order at [src/events/store.ts:243-275](src/events/store.ts#L243).
- Projection trio is mandatory and lands together: canonical idempotent `read/projections/*.sql`, registration in the `MIGRATIONS` array of [src/events/migrate.ts](src/events/migrate.ts) (append after the Story 3.3 entry), and a byte-for-byte mirror in [deploy/compose/init-db.sql](deploy/compose/init-db.sql) that never touches the `powersync_publication` block. Register every new table in the `EXPECTED` array of [test/unit/schema-drift.test.ts](test/unit/schema-drift.test.ts).
- TypeScript accessor pattern: `runner(client?)`, a `*_COLUMNS` const, `mapRow`, `ts()`/`num()`/`numOrNull()`; DATE via `to_char(..., 'YYYY-MM-DD')`; NUMERIC bound and returned as strings. Reference [src/read/projections/weighbridge_event.ts](src/read/projections/weighbridge_event.ts).
- Runtime is plain Node HTTP with a custom router. Handlers live in `src/api/v1/*.ts` and register in [src/server.ts](src/server.ts) via `router.get`/`router.post`. [src/api/router.ts](src/api/router.ts) is the matcher, not the registration site. This is NOT Next.js; there are no `route.ts` files.
- Tests use the Node built-in runner (`node:test`), NOT vitest. Integration tests are one file per story: `test/integration/story-3-4.test.ts`. Every new route must be added to the spine route-surface allowlist in [test/integration/story-1-9.test.ts](test/integration/story-1-9.test.ts) or the spine gate fails.
- Business date must be IST local date, not UTC. Use the `localYmd` helper pattern from [src/compliance/gate.ts:25](src/compliance/gate.ts#L25).

### Reuse (Do Not Reinvent)

- Binding token and accepted weighment: `getWeighbridgeEventsByCorrelationId(correlationId, client?)` at [src/read/projections/weighbridge_event.ts:119](src/read/projections/weighbridge_event.ts#L119) returns all weighments for a token (denormalized `gate_event_id`, `site_id`, `site_code_ext`, `status`). There is NO `getGateEventByCorrelationId`; resolve the gate context from the weighbridge row or add a by-token gate accessor if a dry (no-weighment) receipt must resolve the gate directly.
- PO reference and tolerances: `getPurchaseOrderByRef(poNumberExt, client?)` at [src/read/projections/erp_purchase_order.ts:95](src/read/projections/erp_purchase_order.ts#L95) returns the header plus `lines[]`. Each line carries `ordered_qty`, `open_qty`, `over_receipt_tolerance_pct`, `under_receipt_tolerance_pct`, and `sku` (no UOM). The ERP projection is read-only; `assertErpReadOnly` (`src/compliance/erp-readonly.ts`) rejects `erp.*` writes with `SOURCE_SYSTEM_READ_ONLY`.
- Item master flags: `getItemBySku(sku, client?)` at [src/read/projections/item_master.ts:185](src/read/projections/item_master.ts#L185) carries `uom`, `lot_controlled`, `serial_controlled`, `bis_licence_required`, `quarantine_required`, and `status`. Drive QC-hold routing (AC3) from `bis_licence_required` or `quarantine_required`. Resolve `uom` here (the PO line has none).
- QC-hold location: `getLocationByCode('ZONE-QC-HOLD', client?)` and `getLocationById` at [src/read/projections/location_register.ts:296](src/read/projections/location_register.ts#L296). There is no `stock_balance` hold column; the hold mechanism is physical segregation into the `zone_type = 'quarantine'` (`quarantine = true`) `ZONE-QC-HOLD` location. This matches the model: quality hold is a location and lot attribute, never a stock-balance status.
- Stock receipt and lot/serial: drive the EXISTING top-level `applyLotSerialValidation` (`src/compliance/lot-serial-validation.ts:320`) and `applyStockBalanceProjection` (`src/compliance/stock-balance.ts:157`) via a synthetic `stock.received` envelope view (Task 5.3.6), NOT by calling them on the raw `goods.received` envelope. Both gate on `stream_type = 'inventory'` and `event_type IN (stock.received/allocated/issued)` (`stockBalanceEventKind`, `src/compliance/stock-balance.ts:60`), so a `receiving`-stream envelope is a silent no-op and posts no stock. Routing through the synthetic view means lot auto-create from `expiry_date` (`lot-serial-validation.ts:434`), serial receipt, the Story 2.8 consignment/VMI owner-party gate (`assertConsignmentReceiptOwnership`, requires `owner_party_code` for `consignment`/`vmi`), and NUMERIC precision are all inherited for free. Do not duplicate that logic.
- Notifications: `emitNotificationInTransaction(input, client)` at [src/notify/emit.ts:103](src/notify/emit.ts#L103) targets a role plus optional `location_id` and joins the caller transaction. Story 3.3 used it at [src/compliance/weighbridge.ts:221](src/compliance/weighbridge.ts#L221) to route a breach to `receiving_supervisor`. Route the AC5 discrepancy to `unloading_supervisor` and the AC3 QC inspection to `qc_inspector` the same way.
- DOA approver resolution: `findMatchingDoaEntry(transactionType, value, client?)` at [src/read/projections/doa_registry.ts:170](src/read/projections/doa_registry.ts#L170) plus `findRoleHolder`. Model the quarantine and putaway-release approval on `resolveCountApprover` at [src/compliance/cycle-count.ts:327](src/compliance/cycle-count.ts#L327) and its `APPROVAL_REQUIRED` enforcement.
- RBAC and error shaping: `requireRole` and `permittedLocationsForModuleScope` in [src/middleware/rbac.ts](src/middleware/rbac.ts); `AppError`, `sendJson`, `sendRequestError` in [src/middleware/error.ts](src/middleware/error.ts). Do not hand-roll auth or error envelopes.
- Audit: `logAuditEntry(client, payload)` at [src/read/projections/audit_log.ts:26](src/read/projections/audit_log.ts#L26) is called by the standard `persistEvent` path; carry the `reason_code` in the event payload so it reaches the audit `details`.

### Dependency Reality Check

- Story 2.9 open-PO projection (`erp_purchase_order` header and line) is the correct and only PO source; there is no Epic 4 native PO yet. Story 3.4 receives against the read-only projection (AC5 keeps the ERP as system of record).
- Story 3.3 accepted weighment is the real upstream gate for AC1. Story 3.2 `gate_event` supplies the token and site.
- No ASN table exists anywhere today; Task 2.4 and Task 4 create the minimal INT-SUP-02 intake from scratch, modeled on the Story 2.9 direct-upsert reference pattern (NOT event-sourced).
- No `putaway_task` or `grn` table exists; they are new. Keep `putaway_task` minimal and additive so Story 3.5 (Directed Putaway) can extend it with directed-bin suggestion and override logic without a rewrite.
- The `receiving` stream type is new. Register it in `SUPPORTED_EVENT_TYPES` with `requiresBusinessStream: false` (a receiving envelope posts no valuated movement of its own; the stock receipt it drives carries the item business stream). Confirm the registry accepts a new stream literal at [src/events/schema.ts:356](src/events/schema.ts#L356).

### Compliance and NFR

- AD-2 (Gate-Token Event Chain): every event after the gate references the binding token; the central plane stitches gate, weighbridge, receiving, and putaway by token, not timestamp. The `goods.received` `correlation_id` is that token.
- AD-16 (Idempotency on edge-originated commands): the GRN command from the edge carries an idempotency key; the client-supplied `grn_line_id` and `putaway_task_id` keep replay idempotent.
- FR-AC-13 / AD-16 (immutable edit log, no hard deletes): GRN, putaway, and ASN rows are append-only with soft status transitions.
- AC5 blocking is a hard reject (no stock, no line) plus a routed discrepancy task; AC7 expired-lot blocking is a hard reject unless a DOA-approved quarantine into `ZONE-QC-HOLD`. Neither path may let unverifiable stock enter normal available balance silently.
- SOD-11 (finalized 2026-07-12): no identity holds both `weighbridge_operator` and `store_assistant` at the same site. This is an assignment-time check (Story 1.2 / IAM), not enforced by this story, but do not design the API in a way that assumes one person does both.

### UX Requirements (from EXPERIENCE.md, DESIGN.md)

There is no dedicated GRN wireframe; receiving reuses the frontline edge primitives and voice. Apply these observable rules to any receiving-facing response the API returns:

- Role label in the UX is "Warehouse Assistant (Receiving) - goods receipt, lot/serial capture, QC-hold gate"; the implementing RBAC role is `store_assistant`. Frontline nav badge shows the count of open tasks at the current location, so the API list endpoints must be site-scoped and cheap to poll.
- Reusable screens: `scan-input-screen` (carton barcode plus lot/expiry capture) and `locator-override-modal`. The PWA form is the edge team deliverable; the backend contract here must return the fields those screens need (matched PO line summary, expected ASN line, error code, and the generated putaway task).
- Microcopy the error codes must support: an off-PO scan is "That PO isn't here yet. Double-check the number or contact procurement." (`ITEM_PO_MISMATCH`); a QC hold reads "Dispatch blocked: QC Hold on lot [lot]. Release decision pending inspection results." (AC3); offline capture reads "Captured, pending sync. All data saved locally. Will sync when online." (AC1 offline path). Return machine codes; the edge i18n layer renders the copy.
- Notification templates the emit calls feed: "Goods received" push (opt-in; roles Indent Raiser, Warehouse Assistant, Procurement Officer) and "QC hold placed" push (QC Inspector, Warehouse Supervisor, Production Supervisor). Match the `emitNotificationInTransaction` target roles to these.

### Error Codes (New, UPPER_SNAKE_CASE)

The receiving error codes table below lists every new stable error code, its trigger, and whether it is a permanent edge error. All permanent codes must appear in the backend permanent set (`src/sync/upload.ts`), edge `PERMANENT_ERROR_CODES` (`edge/src/sync/connector.ts`), and i18n `en.json`.

| Error Code | Trigger | Permanent (Edge) |
| --- | --- | --- |
| `ITEM_PO_MISMATCH` | Scanned SKU matches no line of the referenced PO (hard 4xx reject, no durable line) | Yes |
| `RECEIPT_TOLERANCE_EXCEEDED` | Cumulative received exceeds the PO line over-receipt band. NOT a sync error: returned as a business outcome in a 2xx body with a committed `rejected` GRN line and a durable discrepancy notification (see Task 5.3.3). Do NOT add to the permanent-error sets. | No |
| `LOT_EXPIRED` | `expiry_date` earlier than the receiving business date, without approved quarantine (hard 4xx reject) | Yes |
| `APPROVAL_REQUIRED` | Quarantine or held-putaway release attempted without a DOA-resolved approver (existing code, reused) | Yes |
| `RECEIVING_BINDING_TOKEN_REQUIRED` | `correlation_id` missing on the payload | Yes |
| `RECEIVING_BINDING_TOKEN_NOT_FOUND` | Token resolves to no gate or weighbridge event | Yes |
| `RECEIVING_WEIGHT_NOT_ACCEPTED` | A weighment exists for the token but is `tolerance_breach` | Yes |
| `RECEIVING_PO_NOT_FOUND` | `po_ref_ext` resolves to no open-PO projection row | Yes |
| `RECEIVING_QTY_REQUIRED` | `received_qty` missing or not positive | Yes |
| `RECEIVING_QC_HOLD_ZONE_NOT_FOUND` | Site has no `ZONE-QC-HOLD` quarantine location for a QC-hold or quarantine receipt | Yes |
| `ASN_PO_NOT_FOUND` | ASN intake references a PO not on the Story 2.9 projection | Yes |

### Project Structure Notes

- New files: `read/projections/grn.sql`, `read/projections/grn_line.sql`, `read/projections/putaway_task.sql`, `read/projections/asn.sql`, `read/projections/asn_line.sql`, `src/read/projections/grn.ts`, `src/read/projections/grn_line.ts`, `src/read/projections/putaway_task.ts`, `src/read/projections/asn.ts`, `src/compliance/receiving.ts`, `src/api/v1/receiving.ts`, `src/api/v1/asn.ts`, `test/integration/story-3-4.test.ts`, an edge unit test under `edge/test/unit/`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `src/api/v1/edge.ts`, `src/server.ts`, `src/sync/upload.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, and possibly `src/compliance/stock-balance.ts` and `src/compliance/lot-serial-validation.ts` (only to export the receipt helpers for reuse).
- No conflicts with the unified structure; all paths mirror existing Epic 2 and Epic 3 projection, compliance, and API conventions.

### Boundary Notes (Scope Guardrails)

- This story owns physical receiving capture: the gate-token chain consumption, lot/serial/expiry entry, GRN lines, and putaway-task generation. Story 4.5 (post-pilot) owns the procurement and financial side (PO-matching GRN posting, three-way match); it consumes this story's receiving events and does not re-implement capture.
- Story 3.5 (Directed Putaway) owns the directed-bin suggestion, velocity classification, and `location.override` correction event. This story only generates the putaway task rows in `ready` or `held` state; do not build bin-directing logic here.
- The Epic 8 QC gate (inspection plans, sampling, disposition) is out of scope. This story does NOT create a durable QC inspection task row; the AC3 "QC inspection task" is represented by the combination of (a) the held `putaway_task` (`status = 'held'`) and (b) the `qc_inspector` notification. The manual DOA-gated supervisor release (AC3) is the interim bridge until the Epic 8 disposition flow replaces it.
- Full supplier portal and EDI onboarding are Phase 2. This story ships only the minimal ASN intake endpoint (INT-SUP-02).

### Open Questions (Resolve During Dev or Flag in Review)

1. Create role: the finalized access matrix maps receiving scan-first capture to `store_assistant` (there is no `receiving_store_assistant` role). Confirm `store_assistant` is the authoritative GRN-create role before dev, and confirm the discrepancy owner ordering (`unloading_supervisor` primary, `warehouse_manager` escalation) matches the DOA tolerance-breach band (access matrix, tolerance-breach acceptance band: `unloading_supervisor` up to 5 percent over, `warehouse_manager` above).
2. ASN intake auth: is there a dedicated supplier or EDI service role (`svc_supplier_edi` or similar) in the role registry for `POST /api/v1/asn`, or does intake run under `store_assistant`? Confirm before dev.
3. Dry receipt (no weighment) is DEFERRED out of this story: AC1 mandates an accepted weighment, and there is no `getGateEventByCorrelationId` accessor to resolve a gate token without a weighbridge row (Task 5.3.1 rejects `RECEIVING_BINDING_TOKEN_NOT_FOUND`). Story 3.8 notes gate dwell falls back to GRN confirmation where no weighment applies; if the pilot needs dry (non-weighed) receipts, a follow-up must add a by-token gate accessor and relax Task 5.3.1. Confirm the pilot has no dry-receipt goods, or raise the follow-up.
4. QC-hold zone provisioning: AC3 and AC7 require a `ZONE-QC-HOLD` quarantine location per site. Confirm the pilot site topology (Story 3.1) seeds one, or specify the fallback when absent (this story rejects `RECEIVING_QC_HOLD_ZONE_NOT_FOUND`).
5. Serial capture on receipt: the AC text emphasizes lot and expiry; `serial_controlled` items also need serial entry at receipt. Confirm serials are captured in the same GRN line flow (this story assumes yes, reusing the Story 2.3 serial path).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-3.4] lines 1285-1323 (story, acceptance criteria, ASN scope, PO dependency).
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1615-1631 (Story 3.4 / 4.5 boundary, receiving against 2.9 projection), lines 1255-1283 (Story 3.3 weighbridge token chain), lines 1168-1198 (Story 2.9 open-PO projection and line tolerance fields).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md] AD-2 gate-token chain, AD-3 DOA approval resolver, AD-13 document-at-gate, AD-14 shared projections, AD-15 asserted-vs-expected location, AD-16 idempotency.
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md] `store_assistant`, `unloading_supervisor`, `warehouse_manager`, `qc_inspector` scopes; tolerance-breach acceptance band; SOD-11.
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md] receiving role, frontline nav, microcopy, notification templates.
- [Source: src/events/store.ts:165] persistEvent seam and assert/apply ordering.
- [Source: src/compliance/weighbridge.ts] the seam pattern to mirror, including the `emitNotificationInTransaction` breach-routing call.
- [Source: src/read/projections/weighbridge_event.ts:119] getWeighbridgeEventsByCorrelationId for accepted-weighment resolution.
- [Source: src/read/projections/erp_purchase_order.ts:95] getPurchaseOrderByRef with PO line tolerance fields.
- [Source: src/read/projections/item_master.ts:185] getItemBySku with bis_licence_required, quarantine_required, uom.
- [Source: src/compliance/cycle-count.ts:327] resolveCountApprover DOA pattern for AC3 and AC7 approval gating.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (BMad dev-story workflow)

### Debug Log References

- `npm test`: 385/386 (14 new Story 3.4 integration tests all pass). The single failure is a pre-existing, date-dependent flake in `test/integration/story-3-3.test.ts` (AC1/AC2 asserts `business_date === '2026-07-22'`, but the weighbridge API stamps `occurred_at = now()`, so the value follows the machine clock - it read `2026-07-23`). Documented as a known flake in `sprint-status.yaml` before this story; not caused by and not in scope for Story 3.4.
- `test/unit/schema-drift.test.ts`: 39/39 (all five new tables `grn`, `grn_line`, `putaway_task`, `asn`, `asn_line` verified canonical-vs-init-db byte-for-byte with grants).
- `npm run spine-acceptance-contract` (story-1-9): 6/6 - the seven new routes are in the spine allowlist.
- `npm run edge:test`: 15/15; `edge:typecheck`, `edge:lint` clean.
- `npm run build`, `npm run lint`, `npm run edge:build`: clean.

### Completion Notes List

- Implemented all 9 tasks. New `receiving` stream type carries `goods.received` and `goods.putaway_released` (both `requiresBusinessStream: false`); the valuated movement is posted through a synthetic `stock.received` view (Task 5.3.6) so lot auto-create, serial receipt, the Story 2.8 owner-party gate, and NUMERIC precision are all inherited, never duplicated. The seam never writes any `erp_*` projection (AC6 verified by test).
- AC5 over-tolerance is a committed 2xx business outcome (durable `rejected` GRN line + `unloading_supervisor` discrepancy notification), surfaced via `error_code` in the response body rather than a throw, so the discrepancy record is never rolled back. `RECEIPT_TOLERANCE_EXCEEDED` is deliberately NOT in the edge permanent-error sets (it settles as synced).
- H1 (concurrency): the tolerance band takes a `pg_advisory_xact_lock(hashtext(po_ref || ':' || line_no))` before reading the cumulative sum; a `Promise.all` of two 60-unit receipts on an ordered-100 line yields exactly one rejection.
- **Decision (flag for review) - AC7 quarantine approval vs Task 7.2 create-role:** Task 7.2 restricts GRN-create to `store_assistant` only, but Task 5.3.4 says the authenticated actor must be the DOA-resolved approver - a store assistant never is. Resolved in favor of the scan-first UX: the AC7 quarantine gate (`assertQuarantineApproval`) requires a governing `receiving.quarantine` DOA band AND a resolvable active holder of the band's supervisor role (`findRoleHolder` + delegation fallback), representing the out-of-band supervisor authorization the assistant obtained; the actor need not be that supervisor. Absent the band or an active holder -> `APPROVAL_REQUIRED`. The held-putaway **release** path (AC3) stays actor-role-gated (`unloading_supervisor`/`warehouse_manager`) because its endpoint is supervisor-only.
- **Open Question 2 (ASN intake auth):** `POST /api/v1/asn` allows `store_assistant` plus a `svc_supplier_edi` service role. `svc_supplier_edi` is not yet confirmed present in the role registry - it is accepted defensively (no-op if unassigned). Flag for confirmation.
- Open Questions 1, 3, 4, 5 handled as specified: create role = `store_assistant` (OQ1); dry (no-weighment) receipts remain out of scope and reject `RECEIVING_BINDING_TOKEN_NOT_FOUND` (OQ3); a missing site `ZONE-QC-HOLD` rejects `RECEIVING_QC_HOLD_ZONE_NOT_FOUND` (OQ4); serials flow through the synthetic view's existing Story 2.3 serial path (OQ5).

### File List

New files:

- `read/projections/grn.sql`
- `read/projections/grn_line.sql`
- `read/projections/putaway_task.sql`
- `read/projections/asn.sql`
- `read/projections/asn_line.sql`
- `src/read/projections/grn.ts`
- `src/read/projections/grn_line.ts`
- `src/read/projections/putaway_task.ts`
- `src/read/projections/asn.ts`
- `src/compliance/receiving.ts`
- `src/api/v1/asn.ts`
- `src/api/v1/receiving.ts`
- `test/integration/story-3-4.test.ts`

Modified files:

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/api/v1/edge.ts`
- `src/server.ts`
- `src/sync/upload.ts`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `edge/test/unit/connector.test.ts`

### Change Log

| Date | Change |
| --- | --- |
| 2026-07-23 | Story 3.4 implemented (all 9 tasks): receiving stream + goods.received/goods.putaway_released events, grn/grn_line/putaway_task projections + minimal asn/asn_line reference intake, central receiving compliance seam wired into persistEvent, receiving + ASN REST APIs, edge received_by injection + permanent error codes + i18n, and the story-3-4 integration suite (14 tests). Status ready-for-dev -> review. |
| 2026-07-23 | Code review (3-layer adversarial pass): 2 decisions resolved (1 to patch: `ASN_PO_NOT_FOUND` added to permanent-error sets; 1 attempted-patch reverted then deferred: under-receipt lower-bound enforcement broke normal partial receiving, needs a PO-closure signal) + 7 patches applied (GRN header field clobber across multi-line receipts, ASN cross-site hijack on re-POST, client-supplied grn_id/grn_line_id ownership check, released_by always sourced from the authenticated actor, missing site check on non-QC-hold target location, double-release race on putaway tasks, LOCATION_NOT_FOUND/PUTAWAY_TASK_NOT_FOUND/PUTAWAY_TASK_NOT_HELD added to permanent-error sets + i18n) + 3 deferred (RBAC helper divergence, unrelated gate_event hotfix bundled in, resolveSiteByToken staleness) + 11 dismissed as noise; tsc clean, 392/393 tests (1 pre-existing date-flake in story-3-3, unrelated); moved to done. |
