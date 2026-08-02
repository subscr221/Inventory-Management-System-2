---
baseline_commit: f1f4b26
---

# Story 4.3: Purchase Requisition and Indent Loop

Status: done

## Story

As a floor supervisor,
I want to raise a purchase requisition from my phone in under 90 seconds and see its live status with a notification on every decision,
so that I know exactly when material I need will arrive without chasing anyone (realizes UJ-IND-01).

## Acceptance Criteria

1. **Given** a floor supervisor on the offline-capable PWA, with or without network
   **When** they raise a requisition with item, quantity, need-by date, and a mandatory business-stream tag (FR-AC-01, FR-P-04)
   **Then** the requisition is committed locally and shows "captured, pending sync" (Story 1.8 pattern) even with no network, and capture completes in under 90 seconds measured from opening the new-requisition form to the local commit (see measurement note); an untagged requisition is rejected at capture with `error_code: "UNTAGGED_TRANSACTION"`

2. **Given** a similar open requisition for the same item by the same requester exists within the configured open window
   **When** a new requisition is submitted while the device is online
   **Then** the system flags the potential duplicate with `error_code: "DUPLICATE_EVENT"` and requires explicit confirmation before proceeding

3. **Given** the same duplicate condition and the requisition was captured offline
   **When** the queued requisition syncs
   **Then** the duplicate check runs server-side at sync time; the requisition is held in `pending-confirmation` - not routed to approval - and the requester is notified to confirm or withdraw, with the confirmed path applying the same `DUPLICATE_EVENT` flow; the capture is never silently dropped

4. **Given** a requisition has been submitted
   **When** the requester views its status
   **Then** live status is shown as one of `raised`, `approved`, `rejected`, `ordered`, `cancelled`, or `closed`, with the expected delivery date shown as an attribute of the `ordered` status once a PO is placed

5. **Given** an approver approves or rejects the requisition
   **When** the decision is recorded
   **Then** a push notification is sent to the requester through the notification foundation (Story 1.11) with the decision and, for rejections, the mandatory reason

6. **Given** requisition approval rules are configured by amount band, item category, and requesting department (FR-P-04)
   **When** a requisition is submitted
   **Then** the approving authority is resolved from the DOA registry (FR-DOA-01) against those rules - never hard-coded - the requisition returns `error_code: "APPROVAL_REQUIRED"` until that authority acts, and rule changes are written to the edit log (FR-AC-13) and apply only to requisitions submitted after the change

**Measurement note (from epics.md, binding):** the 90-second target (UJ-IND-01) is measured by client instrumentation from the `form_opened` timestamp to the `local_commit` timestamp on a mid-range Android device, network present or absent; a tap-count budget for the capture flow serves as the CI regression proxy for the timing target.

**Source:** [epics.md#Story-4.3](../planning-artifacts/epics.md) lines 1551-1583, verbatim. Do not reword the ACs.

## Tasks / Subtasks

- [x] **Task 1: SQL projections `indent` and `indent_line` (AC: 1, 2, 3, 4, 6)**
  - [x] Create `read/projections/indent.sql` at the REPO ROOT (not under `src/`). Copy the structure of `read/projections/supplier.sql` exactly: story-naming header comment, the "Derived state ONLY / mutation happens exclusively through persistEvent" paragraph, the init-db mirroring obligation note.
  - [x] Columns: `indent_id UUID PRIMARY KEY`, `indent_number_ext TEXT NOT NULL` (human ID, format `IND-YYYY-NNNN`), `requester_user_id UUID NOT NULL`, `department_code TEXT NOT NULL`, `site_id UUID NOT NULL`, `business_stream TEXT NOT NULL`, `need_by_date DATE NOT NULL`, `urgent BOOLEAN NOT NULL DEFAULT false`, `reason TEXT`, `estimated_value NUMERIC(18,4) NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'raised'`, `approver_actor_id UUID`, `doa_entry_id UUID`, `decided_at TIMESTAMPTZ`, `decided_by UUID`, `rejection_reason TEXT`, `duplicate_of_indent_id UUID`, `cancelled_reason TEXT`, `expected_delivery_date DATE`, `purchase_order_id UUID`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, `created_at`/`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - [x] `CONSTRAINT chk_indent_status CHECK (status IN ('raised','pending-confirmation','approved','rejected','ordered','cancelled','closed'))`. The six AC-4 values plus `pending-confirmation` from AC 3. Use the hyphenated literal `pending-confirmation` exactly as the AC spells it.
  - [x] `CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''))` - enforces AC 5's mandatory reason at the database level.
  - [x] `CONSTRAINT chk_indent_estimated_value_non_negative CHECK (estimated_value >= 0)`.
  - [x] Create `read/projections/indent_line.sql`: `indent_line_id UUID PRIMARY KEY`, `indent_id UUID NOT NULL`, `line_no INTEGER NOT NULL`, `sku TEXT NOT NULL`, `item_category TEXT NOT NULL`, `requested_qty NUMERIC(18,3) NOT NULL`, `uom TEXT NOT NULL`, `unit_price_estimate NUMERIC(18,4)`, `line_value NUMERIC(18,4) NOT NULL DEFAULT 0`, plus `UNIQUE (indent_id, line_no)` and `CHECK (requested_qty > 0)`. Follow the `grn.sql` / `grn_line.sql` header-plus-line precedent.
  - [x] Add the duplicate-detection index for AC 2 and AC 3: `CREATE INDEX IF NOT EXISTS idx_indent_dup_window ON indent (requester_user_id, created_at DESC) WHERE status IN ('raised','pending-confirmation','approved')`, and on lines `CREATE INDEX IF NOT EXISTS idx_indent_line_sku ON indent_line (sku)`.
  - [x] `CREATE UNIQUE INDEX IF NOT EXISTS uq_indent_number_ext ON indent (indent_number_ext)`.
  - [x] After the table, add the guarded `DO $$ ... END $$;` block that re-adds EVERY named CHECK constraint if missing. `CREATE TABLE IF NOT EXISTS` does not add constraints to a pre-existing table - omitting this block breaks upgrade paths and the schema-drift test.
  - [x] Add the guarded grants block: `GRANT INSERT, SELECT, UPDATE ON indent TO app_user` and `GRANT SELECT ON indent TO readonly_user`, each wrapped in `IF EXISTS (SELECT FROM pg_roles WHERE rolname = ...)`. Never `GRANT DELETE`.
  - [x] Append both files to the `MIGRATIONS` array tail in `src/events/migrate.ts`: `'../../read/projections/indent.sql'` then `'../../read/projections/indent_line.sql'`. Order matters - the array position IS the migration order; filenames carry no numeric prefix.
  - [x] Mirror both files byte-for-byte into `deploy/compose/init-db.sql` (append at tail) with the comment `-- MUST stay identical to read/projections/indent.sql (canonical source).`
  - [x] Add both tables to the `EXPECTED` array in `test/unit/schema-drift.test.ts` including every constraint and index name.

- [x] **Task 2: Event types and payload interfaces (AC: 1, 2, 3, 4, 5, 6)**
  - [x] In `src/events/schema.ts`, append payload plus envelope interface pairs near the existing supplier block (around line 819), using the `Omit<EventEnvelope, 'payload'>` idiom.
  - [x] Event types (all on `streamType: 'procurement'`, `stream_id` = `indent_id`): `indent.raised`, `indent.duplicate_flagged`, `indent.confirmed`, `indent.withdrawn`, `indent.approved`, `indent.rejected`, `indent.ordered`, `indent.cancelled`, `indent.closed`.
  - [x] Append each to `SUPPORTED_EVENT_TYPES` (declared around line 823). **Set `requiresBusinessStream: true` for `indent.raised`** - this is what makes AC 1's `UNTAGGED_TRANSACTION` rejection work through the existing spine, with no new validation code. All other indent event types are lifecycle transitions on an already-tagged document, so they take `requiresBusinessStream: false`.
  - [x] Do not reorder existing entries.

- [x] **Task 3: Compliance seam `src/compliance/indent.ts` (AC: 1, 2, 3, 4, 5, 6)**
  - [x] Model on `src/compliance/supplier.ts`. Export exactly three symbols: `indentEventType(envelope)`, `assertIndentShape(envelope)`, `applyIndentProjection(envelope, client)`. Everything else module-private.
  - [x] `indentEventType` returns `null` unless `stream_type === 'procurement'` AND `event_type` is in the module's `INDENT_EVENT_TYPES` Set. Returning `null` early is what keeps this seam off every other event's hot path.
  - [x] Add the private `reject(code, message, details): never` helper throwing `AppError(400, ...)`. Always surface the conflicting record's id and status in `details`.
  - [x] Every apply handler starts with `if (await alreadyPersisted(envelope, client)) return;` then `SELECT ... FOR UPDATE` on the `indent` row. This ordering is not optional - it is how the codebase prevents the TOCTOU races found in the Story 3.6 and 3.7 reviews.
  - [x] `applyIndentApproved` / `applyIndentRejected` must guard the current status (`raised` only), reject `INDENT_ALREADY_DECIDED` otherwise, and call `emitNotificationInTransaction(..., client)` for AC 5. Use the transactional entry point, not `emitNotification`: an approval decision is a business fact under AD-17, and the notification must commit atomically with the status change.
  - [x] `applyIndentRejected` must reject with `INDENT_REJECTION_REASON_REQUIRED` when the reason is absent or blank, before touching the projection.
  - [x] `applyIndentRaised` implements the duplicate check for AC 2 and AC 3: within the configured open window, look for an existing indent by the same `requester_user_id` for the same `sku` in status `raised`, `pending-confirmation`, or `approved`. On a hit, set `status = 'pending-confirmation'` and `duplicate_of_indent_id`, then emit the requester notification. Never drop the capture and never throw on the offline sync path - AC 3 is explicit that the capture survives.
  - [x] Wire into `src/events/store.ts`: `assertIndentShape(envelope)` immediately after the `assertSupplierShape` call (around line 466, pre-transaction, before the idempotency lookup), and `await applyIndentProjection(envelope, client)` immediately after `applySupplierProjection` (around line 692, inside the transaction).

- [x] **Task 4: DOA-resolved approval routing (AC: 6)**
  - [x] Use `transaction_type = 'indent_approval'`. Define it as a module constant `INDENT_DOA_TYPE` in the route file, mirroring `SUPPLIER_DOA_TYPE` at `src/api/v1/suppliers.ts:27`.
  - [x] Copy `resolveApprover` from `src/api/v1/suppliers.ts:62-98` verbatim, including the escalation ladder over `listActiveDoaEntries` and the fail-closed `APPROVAL_UNRESOLVED` (409). Change only the transaction type and the message text. Do not write a new resolver.
  - [x] Pass the real indent `estimated_value` as the `value` argument. Story 4.1 hardcodes `0` because supplier onboarding has no amount; an indent does, and AC 6 requires band resolution. This is the one place you must NOT copy 4.1.
  - [x] Persist the resolved `approver_actor_id` and the matched `doa_entry_id` onto the indent row at raise time so the approval card can render the authority and the audit answers "who was it routed to".
  - [x] **Enforce SOD-01 (requester is not approver).** On approve and reject, reject with `INDENT_RAISER_CANNOT_APPROVE` when the authenticated actor equals `requester_user_id`. Story 4.1 omitted the equivalent check; do not repeat that omission.
  - [x] **Verify the acting approver matches the DOA resolution.** Reject with `NOT_RESOLVED_APPROVER` when the authenticated actor is neither `approver_actor_id` nor an active delegate of that holder per `findActiveDelegation`. Story 4.1's approve and reject routes guard only `requireRole({ module: 'procurement', functionScope: 'write' })`, which lets any procurement writer approve anything - a known hole, listed in the inherited-context table below.
  - [x] Never write a role-name literal into the approval path. `test/unit/no-hardcoded-role-in-workflow.test.ts` fails the build on role-name literals in workflow code, and it runs inside the Story 1.9 spine contract.

- [x] **Task 5: REST routes `src/api/v1/indents.ts` (AC: 1, 2, 3, 4, 5, 6)**
  - [x] Copy the three boilerplate helpers from `src/api/v1/suppliers.ts:26-60` unchanged: `NO_LOCATION_UUID`, `ActorContext` plus `actorContext(req)`, and `auditCtxFor(req, actor, httpStatus)`. Identity comes from the auth context, never from the request body.
  - [x] Routes: `POST /api/v1/indents` (raise), `GET /api/v1/indents/:indentId` (status, AC 4), `GET /api/v1/indents` (list with filters), `POST /api/v1/indents/:indentId/confirm` (AC 2, AC 3 duplicate confirmation), `POST /api/v1/indents/:indentId/withdraw`, `POST /api/v1/indents/:indentId/approve` (AC 5, AC 6), `POST /api/v1/indents/:indentId/reject` (AC 5), `POST /api/v1/indents/:indentId/cancel`.
  - [x] Export both the base handler and the `requireRole`-wrapped handler for each route, matching the 4.1 export convention. Reads use `functionScope: 'read'`, everything else `'write'`, all on `module: 'procurement'`.
  - [x] All state changes go through `persistEvent({ stream_type: 'procurement', stream_id: indentId, event_type: 'indent.*', ... }, auditCtxFor(...))`. No route handler may INSERT or UPDATE the `indent` table directly - the projection is derived state, rebuildable by replay.
  - [x] `indent_number_ext` generation: allocate server-side inside the raise handler in the `IND-YYYY-NNNN` format shown in the UX. Use a Postgres sequence or a `SELECT ... FOR UPDATE` counter row - never a client-supplied value, and never `MAX(...) + 1` without a lock.
  - [x] Register all eight routes in `src/server.ts` (import block near lines 145-154, registration in `createAppRouter()` near lines 353-360).
  - [x] Add all eight paths to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` (supplier entries at lines 324-331 show the format). Omitting this fails `npm run spine-acceptance-contract`.

- [x] **Task 6: Read-model accessors `src/read/projections/indent.ts` (AC: 4)**
  - [x] Model on `src/read/projections/supplier.ts`. Include the `Queryable` plus `runner(client?)` pattern and the `UUID_REGEX` guard.
  - [x] Export `IndentRow`, `IndentLineRow`, `getIndentById(id, client?, forUpdate?)`, `listIndents(params, client?)`, `getIndentLines(indentId, client?)`, `findOpenDuplicate(requesterUserId, sku, windowDays, client?)`, `insertIndent`, `insertIndentLine`, `updateIndentStatus`.
  - [x] `getIndentById` takes the optional `forUpdate: boolean` third parameter that appends `FOR UPDATE`, exactly as `getSupplierByOwnerPartyCode` does. Every compliance-seam read that precedes a write must pass `true`.
  - [x] Any text search must use the ILIKE escaping from `src/read/projections/supplier.ts:88-96` (`replace(/[%_\\]/g, '\\$&')` plus `ESCAPE '\\'`).
  - [x] `listIndents` must filter by the caller's permitted locations. Use `permittedLocationsForModuleScope` from `src/middleware/rbac.ts` - do not return cross-site indents to a site-scoped supervisor.

- [x] **Task 7: Error codes registered in three places (AC: 1, 2, 3, 5, 6)**
  - [x] New codes: `INDENT_NOT_FOUND`, `INDENT_ALREADY_DECIDED`, `INDENT_NOT_IN_RAISED`, `INDENT_RAISER_CANNOT_APPROVE`, `NOT_RESOLVED_APPROVER`, `INDENT_REJECTION_REASON_REQUIRED`, `INDENT_PENDING_CONFIRMATION`, `INDENT_LINE_REQUIRED`.
  - [x] Add every code to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts` (block at lines 17-137) AND the twin Set in `edge/src/sync/connector.ts` (lines 22-140), each under a new `// Story 4.3: indent permanent business rejections` comment. **A code missing from these Sets makes an offline-captured indent retry forever instead of settling as `needs_attention`.**
  - [x] Add an `"errors.<CODE>": "<sentence>"` entry per code to `edge/src/messages/en.json`. A missing entry shows a raw error code to a frontline supervisor.
  - [x] `APPROVAL_REQUIRED`, `DUPLICATE_EVENT`, and `UNTAGGED_TRANSACTION` already exist in the spine registry - reuse them, do not mint variants. `APPROVAL_UNRESOLVED` (409) is thrown by `resolveApprover` but is NOT currently in the permanent-code Sets; add it while you are there.

- [x] **Task 8: Edge PWA offline capture (AC: 1)**
  - [x] Create `edge/src/capture/indent.ts` exporting `createIndentRaisedEvent(input)`, modelled line-for-line on `edge/src/capture/cross-dock.ts`. Use `streamType: 'procurement'`, `eventType: 'indent.raised'`, `streamId: indentId`, `idempotencyKey: \`edge-indent-${eventId}\``. Keep `eventId`, `idempotencyKey`, and `occurredAt` optional-with-defaults so tests can pin them.
  - [x] Build the envelope through `createOutboxEvent` from `edge/src/capture/outbox-event.ts`. Do not hand-roll the metadata block.
  - [x] **No new local SQLite table is needed.** `edge_outbox` is event-shaped and entity-agnostic; an offline indent is one more row. Write it with `insertCaptureEvent(db, event)` from `edge/src/local-db/outbox.ts:41`. Do not add tables to `EdgeSchema` for the capture path.
  - [x] **No PowerSync sync-rules change is needed.** `uploadData` in `edge/src/sync/connector.ts:277` is generic over `edge_outbox` and POSTs to `/api/v1/edge/events`. A new capture flow requires zero connector changes.
  - [x] Create `edge/src/components/indent-capture.tsx` modelled on `edge/src/components/cross-dock-capture.tsx`: fully injection-based (`onSearch` / `onSubmit` props, no direct DB access), `useRef` plus `useEffect` autofocus on the SKU field for the scan gun, all strings through `t()`, `aria-labelledby` on the section.
  - [x] Wire `onSubmit` to `insertCaptureEvent` in `edge/src/components/edge-client.tsx`, matching how cross-dock is wired.
  - [x] Add `indent.*` UI strings to `edge/src/messages/en.json`. Reuse the existing `sync.captured` string ("Captured - pending sync") for the AC 1 degraded-state label - do not write a new one.
  - [x] Instrument `form_opened` and `local_commit` timestamps per the measurement note, and add the tap-count budget assertion as the CI regression proxy.

- [x] **Task 9: Integration test `test/integration/story-4-3.test.ts` (AC: 1-6)**
  - [x] Model the harness on `test/integration/story-2-5.test.ts` (transfer request: create, DOA approve/reject, status transitions) - the closest existing approval-document test. Do NOT look for `test/integration/story-4-1.test.ts`; it does not exist.
  - [x] Standard harness: `node:test` plus `node:assert/strict`, `const run = randomUUID().slice(0, 8)`, real Postgres via `getPool()`, `closePool()` in `after()`. No mocking framework - the repo uses `node:test` only.
  - [x] `seedUser` must insert into `users` and `user_role_assignments` with `module = 'procurement'`.
  - [x] Seed a `doa_registry` entry for `transaction_type = 'indent_approval'` covering the access-matrix bands (Tier 1 up to INR 50,000; Tier 2 INR 50,001 to 2,00,000; Tier 3 above INR 2,00,000). Assert band selection, not just that some approver came back.
  - [x] Cover each AC explicitly, plus these negative paths: untagged raise returns `UNTAGGED_TRANSACTION`; requester approving own indent returns `INDENT_RAISER_CANNOT_APPROVE`; a non-resolved approver returns `NOT_RESOLVED_APPROVER`; rejection without a reason returns `INDENT_REJECTION_REASON_REQUIRED`; double-approve returns `INDENT_ALREADY_DECIDED`; replaying the same `indent.raised` envelope leaves exactly one row.
  - [x] Suffix every external-ID literal with `-${run}` for isolation. This was a concrete source of cross-test collisions in Story 3.7.
  - [x] Use `crypto.randomUUID()` for all UUIDs in edge-path tests. `UUID_REGEX` in `src/sync/upload.ts:4` is strict RFC-4122 and rejects hand-rolled placeholders such as `'00000000-...'`.
  - [x] Assert `NUMERIC` columns against STRING literals (`'50000.0000'`), not numbers. `pg` returns NUMERIC as string; this exact mismatch cost a debugging cycle in Story 3.7.

- [x] **Task 10: Verification gates**
  - [x] `npm run build` (tsc) clean, `npm run lint` (eslint) clean, `npm run format:check` clean.
  - [x] `npm run db:migrate` re-runnable against a live database (idempotent DDL).
  - [x] `npm test` - no NEW failures. There are 22 pre-existing failures (idempotency returning 201 instead of 409) across stories 1-1, 1-4, 1-6, 1-8, 2-1 to 2-4, 2-8, 3-2 to 3-4, 3-10, plus one pre-existing spine DOA-resolution failure. Do not attribute these to this story and do not "fix" them here.
  - [x] `npm run spine-acceptance-contract`, `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:build` all clean.
  - [x] `test/unit/schema-drift.test.ts` passes with the two new table entries.
  - [x] `test/unit/no-hardcoded-role-in-workflow.test.ts` passes - no role-name literal anywhere in the indent approval path.

## Dev Notes

### Scope boundaries - read before writing code

This story owns the requisition document and its approval loop. It does NOT own:

- **Purchase orders.** Story 4.4 creates POs from approved indents. This story exposes `indent.approved` and accepts an `indent.ordered` transition; it never creates a PO.
- **Budget checks.** UJ-IND-01 step 4 shows a "Budget Availability" panel, but no acceptance criterion in this story requires one. Budget-checked requisitions are Story 10.2 (R&D, FR-RD-04) and Story 11.3 (ERP budget control). Treat the panel as illustrative UX and leave the check out.
- **Replenishment recommendations.** `src/compliance/planning-jobs.ts` deliberately stops at a recommendation and its `next_step` string says "raise a purchase requisition". Closing that loop automatically is not in these ACs. Leave the comment and the boundary intact.
- **Approval on the edge PWA.** See the offline-scope note below.

### Offline scope - capture offline, approve online

The PowerSync download path (`sync/sync-rules.yaml`) is a single bucket over `domain_events` filtered by the JWT `site_id`. Consequences:

- Offline **capture** works with zero sync-rules and zero connector changes. `edge_outbox` plus `insertCaptureEvent` is the whole path.
- Offline **read** of status would need a new syncable table, a new bucket, and Postgres publication membership. That is a meaningful scope addition and is NOT required by any AC.
- The approver is typically not at the raiser's site, so an approval decision would not reach the raiser's device through a site-scoped bucket anyway. Push notification (AC 5) is the correct channel, and the approval UI belongs on the central web app, not the edge PWA.

Build the capture flow on the edge. Build the approval and status screens on the central app. AC 4's "live status" is served by the REST read endpoint with the 10-second auto-refresh described in the UX, not by PowerSync.

### Existing code this story must reuse, not reinvent

Table 1 lists every component that already exists and the exact way this story consumes it. Reinventing any row is a review-blocking defect.

| **Component** | **Path** | **How Story 4.3 uses it** |
|---|---|---|
| DOA resolution | `src/read/projections/doa_registry.ts` | `findMatchingDoaEntry`, `listActiveDoaEntries`, `findActiveDelegation`, `findRoleHolder` |
| Approver resolver | `src/api/v1/suppliers.ts:62-98` | Copy `resolveApprover` verbatim; change transaction type and pass a real value |
| Notifications | `src/notify/emit.ts` | `emitNotificationInTransaction` for approve and reject; `emitNotification` for the duplicate-hold notice |
| Event persistence | `src/events/store.ts` | `persistEvent` is the only write path to the projection |
| RBAC guard | `src/middleware/rbac.ts` | `requireRole({ module: 'procurement', functionScope })`; `permittedLocationsForModuleScope` for list filtering |
| Error type | `src/middleware/error.ts` | `AppError(status, code, message, details)` |
| Edge envelope | `edge/src/capture/outbox-event.ts` | `createOutboxEvent`; never hand-roll metadata |
| Edge local write | `edge/src/local-db/outbox.ts:41` | `insertCaptureEvent`; no new local table |
| Edge upload | `edge/src/sync/connector.ts:277` | Generic `uploadData`; no connector change needed |
| Envelope validation | `src/sync/upload.ts:205-229` | `validateEdgeEnvelope` already runs on `/api/v1/edge/events` |

### Structural precedent

Story 4.1 (supplier onboarding) is the closest end-to-end precedent: same `procurement` stream, a document rather than a warehouse task, a real DOA-resolved approve and reject pair, and an in-transaction notification on the decision. Copy its seam split, its idempotency guard, its SQL header format, and its route boilerplate.

Use Story 2.5 (transfer request) as the secondary reference for the approval-document projection shape. Its `read/projections/transfer_request.sql:20-27` carries `status` plus `approver_actor_id` plus `correlation_id` on the document row, which is exactly what an indent needs.

### Inherited defects from Story 4.1 - context only, do not fix here

Table 2 records known gaps in the Story 4.1 code. They are listed so this story does not copy the bad patterns. Fixing them is explicitly out of scope; the two marked "close in this story" are closed only for the indent path, because the ACs and SOD-01 require it.

| **Gap in Story 4.1** | **Evidence** | **Action for Story 4.3** |
|---|---|---|
| No integration test exists despite Task 8 being marked complete | No `test/integration/story-4-1.test.ts` on disk | Write `test/integration/story-4-3.test.ts`; do not look for a 4.1 test to extend |
| Approve and reject never verify the caller is the DOA-resolved approver | `src/api/v1/suppliers.ts` guards only `procurement:write` | Close in this story for indents via `NOT_RESOLVED_APPROVER` |
| No requester-is-not-approver check | Violates SOD-01 | Close in this story via `INDENT_RAISER_CANNOT_APPROVE` |
| Notifications broadcast to all `procurement_officer` holders | `src/compliance/supplier.ts:404`, `:450`; `NotificationTarget` has no `user_id` | See the notification-targeting note below |
| `doa_band_id` declared but never populated | Optional in the payload, set by no route | Populate `doa_entry_id` on the indent row from the outset |
| Dev Notes cite `src/read/projections/supplier.sql` | That path does not exist | SQL lives at repo root `read/projections/`; trust the disk |
| `DECACTIVATION_REASONS` misspelling | `src/compliance/supplier.ts:24` | Do not propagate the typo into new code |

### Notification targeting - a real constraint on AC 5

AC 5 requires the notification to reach **the requester**. `NotificationTarget` currently supports role-plus-location targeting only; it has no `user_id` field. Story 4.1 hit this and shipped a broadcast to all `procurement_officer` holders, leaving its own AC 3 and AC 4 unmet.

Do not repeat that. Extend `NotificationTarget` in `src/notify/emit.ts` with an optional `user_id` and honour it in the delivery path, then target the requester directly. This is a small, contained addition to the Story 1.11 foundation and is the only way AC 5 is honestly satisfiable. If the extension proves larger than expected, stop and raise it rather than shipping a broadcast and marking the AC done.

Use `emitNotificationInTransaction` for approve and reject (AD-17: the decision notification is part of the business fact). Use plain `emitNotification` for the duplicate-hold notice in AC 3, which is informational.

### Contradictions in the source documents - resolutions are binding

Table 3 lists conflicts found across epics, PRD, UX, and the access matrix, with the resolution to implement. Do not re-litigate these during development.

| **Conflict** | **Sources** | **Resolution** |
|---|---|---|
| Approver role: `department_head` versus "Warehouse Manager" | Access matrix line 52 and PRD versus UX section 8.4 and both wireframes | Neither is hard-coded. The DOA registry is authoritative (access matrix line 20). UX names are illustrative |
| Status vocabulary | epics lists `raised, approved, rejected, ordered, cancelled, closed`; UX section 5.2 lists `RAISED, APPROVED, REJECTED, ORDERED, RECEIVED` | epics.md wins. There is no `received` status. Add `pending-confirmation` for AC 3 |
| Wireframe shows one approver on an INR 1,23,000 indent | That amount is Tier 2 and escalates to Finance Controller | Render the resolved authority set, not a single hard-coded name |
| Pending badge colour | Wireframe uses `#8b5cf6`; DESIGN.md section 7.3 requires `#5b21b6` | Use `#5b21b6` (`pending_strong`), the only value that passes AA with white text |
| 90-second target has no hard baseline | PRD line 530 defers SM-16; UX line 927 states "< 90 seconds" | Implement the epics measurement note: `form_opened` to `local_commit`, tap-count budget as the CI proxy |
| Phone form factor | UJ-IND-01 is a phone flow; DESIGN.md marks 640px "not primary" | Build responsive down to 640px. The 90-second budget is measured on a mid-range Android phone |
| No `pending-confirmation` badge variant defined | DESIGN.md section 7.3 | Use the Warning variant (`#f59e0b` fill, black text), label "Awaiting Confirmation" |

### UX specifics that bind the implementation

- **Duplicate-warning microcopy** is already written in EXPERIENCE.md line 1175 and was explicitly deferred to this story: `"You raised IND-2026-0456 on 02-Jul 10:30. Are you raising a new indent or retrying?"` Use it.
- **Approval card** layout is fully specified in EXPERIENCE.md section 4.2 and rendered in `wireframes/approval-card-queue.svg`: header label, pending badge, indent number, raised-by, department, amount, reason, line-item block, approval-required-by, approver, delegation status, then a primary `Approve` and a secondary `Request More Info`.
- **Rejection requires a reason field** before the action is enabled (EXPERIENCE.md section 4.2 rejection flow). This mirrors the database CHECK constraint in Task 1.
- **Status screen** auto-refreshes every 10 seconds with a small "Updating..." pill; no manual refresh (EXPERIENCE.md section 4.3).
- **Notification content template** (EXPERIENCE.md line 1353): `"Approved: Indent IND-2026-0456. By Rajesh Patel (Warehouse Manager). Expected delivery 04-Jul."`
- **Push is opt-in, default off** (EXPERIENCE.md line 1174, DPDP compliance). In-app notification always fires; web push only for opted-in users.
- **Empty state** for the approval queue: headline "All caught up.", body "No tasks waiting right now. New tasks will appear here as soon as they're assigned.", CTA `[Start New Task]` primary plus `[Refresh]` secondary.
- **Accessibility** (NFR-U-02, WCAG 2.1 AA, binding since Story 1.8): 44x44px touch targets, 2px primary-colour focus outline, colour is never the only signal, badges announce intent ("Success: Approved"), all strings through the locale catalog with no hard-coded literals, `prefers-reduced-motion` respected, animations at most 200ms.

### DOA value bands to seed

The access matrix section 8 records these as finalized and cleared for Story 1.4 seeding. Table 4 gives the bands the integration test must assert for `transaction_type = 'indent_approval'`.

| **Tier** | **Amount band (INR)** | **Authority** |
|---|---|---|
| Tier 1 | Up to 50,000 | `department_head` approves alone |
| Tier 2 | 50,001 to 2,00,000 | Escalate to Finance Controller |
| Tier 3 | Above 2,00,000 | Finance Controller plus Super Admin sign-off |

These are configuration data seeded into the DOA registry, not constants in code. The approval path reads them at runtime.

### Project Structure Notes

- SQL DDL lives at **repo root** `read/projections/*.sql`. There is no `src/read/projections/*.sql`. TypeScript accessors live at `src/read/projections/*.ts`. Story 4.1's Dev Notes state this incorrectly; the disk is authoritative.
- Migration filenames carry **no numeric or timestamp prefix**. Ordering is the array position in `src/events/migrate.ts`. Re-listing a file later in the array is the established way to apply an additive `ALTER TABLE` once a dependency exists.
- `deploy/compose/init-db.sql` is a byte-for-byte mirror of every projection SQL file, used for first-boot container init. Change both together or the schema-drift test fails.
- Node 24 LTS, ESM (`"type": "module"`), TypeScript 5.8, PostgreSQL 18.4, `node:test` as the only test runner (no Jest, no Vitest), `pg ^8.16.0`, `jose ^6.2.3`. Test database on port 5442 via the committed `.env.test`.
- The `notify` module is at `src/notify/` in the real repo, not top-level `notify/` as the architecture spine's structural seed diagram shows. Trust the repo.

### References

- [epics.md](../planning-artifacts/epics.md) lines 1551-1583 - Story 4.3 acceptance criteria, verbatim source
- [epics.md](../planning-artifacts/epics.md) lines 1587-1615 - Story 4.4, the downstream PO handoff contract
- [epics.md](../planning-artifacts/epics.md) lines 881-905 - Story 1.11 notification foundation, names FR-P-04 as a consumer
- [epics.md](../planning-artifacts/epics.md) lines 675-699 - Story 1.4 DOA registry, `POST /api/v1/doa/resolve` contract and `DOA_OVERRIDE_BLOCKED`
- [epics.md](../planning-artifacts/epics.md) lines 788-824 - Story 1.8 offline PWA, the "captured, pending sync" pattern and WCAG/i18n mandate
- [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) - event envelope, AD-3 DOA registry, AD-14 shared projections, AD-16 idempotency keys, AD-17 notification coupling, error envelope and code registry
- [EXPERIENCE.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-07-12/EXPERIENCE.md) lines 845-929 - UJ-IND-01 journey with per-step timing budget
- [EXPERIENCE.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-07-12/EXPERIENCE.md) lines 208-275 - approval card and status polling patterns
- [EXPERIENCE.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-07-12/EXPERIENCE.md) line 1175 - duplicate-warning microcopy, deferred to this story
- [DESIGN.md](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-07-12/DESIGN.md) sections 7.1, 7.3, 7.4, 9.2 - button hierarchy, badge tokens, card layout, focus states
- [approval-card-queue.svg](../planning-artifacts/ux-designs/ux-Inventory%20Management%20System_2-2026-07-12/wireframes/approval-card-queue.svg) - the approval queue this story renders
- [access-matrix-frontline-draft-2026-07-11.md](../planning-artifacts/access-matrix-frontline-draft-2026-07-11.md) lines 51-52, 228, 278 - `indent_raiser` and `department_head` roles, SOD-01, and the finalized DOA value bands
- [prd.md](../planning-artifacts/prds/prd-Inventory%20Management%20System_2-2026-07-10/archive/prd.md) lines 68, 78, 142 - UJ-IND-01 source journey, indent glossary entry, FR-P-04

## Dev Agent Record

### Agent Model Used

claude-fable-5 (Claude Fable 5)

### Debug Log References

- Initial raise 500s: `alreadyPersisted` was copied from the Story 4.1 supplier seam verbatim,
  including its `SELECT ... FOR UPDATE` on `domain_events`. `app_user` holds only INSERT, SELECT
  on that append-only table, so every indent event failed 42501 `permission denied for table
  domain_events`. Fixed in the indent seam only (plain SELECT; the serializing lock is the
  indent-row FOR UPDATE taken immediately after). The 4.1 supplier seam carries the same defect
  and was left untouched per the scope boundary; recorded below for the reviewer.
- Replay test initially expected 409 `DUPLICATE_EVENT`; the Story 3-10 review decision made
  `persistEvent` return the EXISTING event (201, same event_id) on idempotent replay. Test now
  accepts either surface and pins the real invariant: exactly one indent row and one line row.
- `expected_delivery_date` (DATE) is parsed by node-postgres at local midnight, so the JSON value
  shifts with server timezone; the test asserts the stored calendar date via `::text` cast.
- A `git stash` round-trip during a format:check baseline converted `deploy/compose/init-db.sql`
  to CRLF and broke the byte-for-byte schema-drift comparison; normalized back to LF.

### Completion Notes List

- Task 1: `read/projections/indent.sql` + `indent_line.sql` (canonical), appended to the
  `MIGRATIONS` tail, mirrored byte-for-byte into `deploy/compose/init-db.sql`, both tables added
  to the schema-drift `EXPECTED` array. `indent.sql` also creates `indent_number_seq` (grant:
  USAGE to app_user) for the `IND-YYYY-NNNN` allocator. `db:migrate` re-run twice cleanly.
- Task 2: 9 `indent.*` event types + payload/envelope interface pairs in `src/events/schema.ts`.
  Only `indent.raised` carries `requiresBusinessStream: true`.
- DEVIATION (required for AC 1): the story asserts the `requiresBusinessStream` registry flag
  makes `UNTAGGED_TRANSACTION` work "with no new validation code", but on disk that flag was
  purely documentary - enforcement was gated on `stream_type === 'inventory'` only
  (`INVENTORY_MOVEMENT_STREAM_TYPES`). `assertInventoryTagging` now consults
  `SUPPORTED_EVENT_TYPES` for non-inventory streams and enforces tagging only for event types
  explicitly marked `requiresBusinessStream: true`. Every existing stream passes through
  unchanged (business-stream unit suite and spine gate 6/6 both green).
- Task 3: `src/compliance/indent.ts` seam (exactly three exports), wired into `persistEvent`
  after the supplier seam calls. Raise inserts header+lines, computes `line_value` and
  `estimated_value` in PostgreSQL NUMERIC, allocates the indent number server-side, and runs the
  AC 2/AC 3 duplicate check (window from `config.indent.duplicateWindowDays`, env
  `INDENT_DUPLICATE_WINDOW_DAYS`, default 7). A duplicate hold sets `pending-confirmation` +
  `duplicate_of_indent_id`, persists a nested `indent.duplicate_flagged` audit event in the same
  transaction, and notifies the requester via plain `emitNotification` (never throws - the
  synced capture can never be lost). Approve/reject guard status, SOD-01, and DOA resolution in
  the seam itself, so direct `/api/v1/events` posts and edge uploads hit the same guards.
- Task 4: `resolveApprover` copied from `suppliers.ts:62-98` (transaction type
  `indent_approval`, real `estimated_value` passed, return extended with `doaEntryId`).
  `approver_actor_id` + `doa_entry_id` persisted on the row at raise time. Edge-synced raises
  resolve the approver at sync time in `edge.ts` (APPROVAL_UNRESOLVED settles as
  needs_attention). No role-name literals anywhere in the approval path.
- Task 5: 8 routes in `src/api/v1/indents.ts` (base + requireRole-wrapped exports), registered
  in `server.ts` and the Story 1.9 spine allowlist. All writes go through `persistEvent`; the
  online duplicate pre-check returns 409 `DUPLICATE_EVENT` with the EXPERIENCE.md microcopy
  shape and proceeds only with `confirm_duplicate: true`.
- Task 6: `src/read/projections/indent.ts` accessors (Queryable/runner, UUID_REGEX, forUpdate
  param, ILIKE escaping, `permittedLocationsForModuleScope` site scoping in `listIndents`).
- Task 7: 8 new codes + `APPROVAL_UNRESOLVED` added to both permanent-code Sets
  (`src/sync/upload.ts`, `edge/src/sync/connector.ts`) and `edge/src/messages/en.json`.
- AC 5 (notification targeting): `NotificationTarget` extended with optional `user_id`; both
  emit entry points persist it and the dispatcher delivers to exactly that user when present,
  skipping the role/location fan-out. Decision notifications reach the requester directly -
  verified end-to-end in the integration test via `runDispatchCycle` (exactly one delivery row,
  targeted at the requester).
- Task 8: `edge/src/capture/indent.ts` (createOutboxEvent envelope, `edge-indent-${eventId}`
  idempotency key), `edge/src/components/indent-capture.tsx` (injection-based, autofocus SKU
  for scan gun, all strings through t(), aria-labelledby, reuses `sync.captured`), wired through
  `app-shell.tsx`/`edge-client.tsx` to `insertCaptureEvent`. No new SQLite table, no sync-rules
  or connector change. `form_opened`/`local_commit` stamped in the component and carried as
  `capture_metrics` on the payload; `INDENT_CAPTURE_TAP_BUDGET` (12) pinned by the edge unit
  test as the CI proxy. `requester_user_id` is server-set from the auth context on the edge
  upload path.
- Task 9: `test/integration/story-4-3.test.ts` - 14 tests, all passing: AC 1 (untagged reject,
  tagged raise, INDENT_LINE_REQUIRED), AC 2 (online DUPLICATE_EVENT + confirmation, different
  requester not flagged), AC 3 (offline hold + notify + confirm, withdraw, replay leaves one
  row), AC 4 (status endpoint, ordered + expected delivery date, list filter), AC 5 (approve +
  reject notifications to the requester with mandatory reason), AC 6 (Tier 1/2/3 band
  selection asserted against seeded access-matrix bands, SOD-01, NOT_RESOLVED_APPROVER,
  INDENT_ALREADY_DECIDED).
- Task 10 gates: tsc clean, eslint clean, prettier clean (pre-existing failures in 19 files
  incl. untouched 4.1 files were normalized - whitespace only), `db:migrate` idempotent,
  `npm test` 555 tests / 541 pass - the 14 failures are all the documented pre-existing
  idempotency class (201 instead of 409) in stories 1-1 through 3-10, 0 new failures;
  spine-acceptance-contract 6/6; schema-drift green with both new tables;
  no-hardcoded-role-in-workflow green; edge typecheck/lint/build clean, edge unit 30/30
  (4 new indent tests).
- Inherited 4.1 defect surfaced (NOT fixed here, out of scope): `src/compliance/supplier.ts`
  `alreadyPersisted` uses `SELECT ... FOR UPDATE` on `domain_events`, which `app_user` cannot
  execute (only INSERT, SELECT granted) - every supplier.* event apply 500s at runtime on the
  production pool. It was never caught because no story-4-1 integration test exists. The indent
  seam does not copy the defect.

### File List

- read/projections/indent.sql (new)
- read/projections/indent_line.sql (new)
- src/compliance/indent.ts (new)
- src/api/v1/indents.ts (new)
- src/read/projections/indent.ts (new)
- edge/src/capture/indent.ts (new)
- edge/src/components/indent-capture.tsx (new)
- edge/test/unit/indent-events.test.ts (new)
- test/integration/story-4-3.test.ts (new)
- src/events/schema.ts (modified - indent event types + payload interfaces)
- src/events/store.ts (modified - assertIndentShape + applyIndentProjection wiring)
- src/events/migrate.ts (modified - two migration entries)
- src/compliance/business-stream.ts (modified - registry-driven tagging for non-inventory streams)
- src/config/index.ts (modified - config.indent.duplicateWindowDays)
- src/notify/emit.ts (modified - NotificationTarget.user_id)
- src/notify/dispatch.ts (modified - user_id-targeted delivery)
- src/api/v1/edge.ts (modified - indent.raised server-set requester + sync-time DOA resolution)
- src/sync/upload.ts (modified - permanent codes)
- src/server.ts (modified - route registration)
- edge/src/sync/connector.ts (modified - permanent codes)
- edge/src/messages/en.json (modified - error + indent UI strings)
- edge/src/components/app-shell.tsx (modified - IndentCapture wiring)
- edge/src/components/edge-client.tsx (modified - submitIndent wiring)
- deploy/compose/init-db.sql (modified - byte-for-byte mirrors appended)
- test/unit/schema-drift.test.ts (modified - two EXPECTED entries)
- test/integration/story-1-9.test.ts (modified - eight spine allowlist routes)
- src/api/v1/suppliers.ts, src/compliance/supplier.ts, src/read/projections/supplier.ts (modified - prettier normalization only, no code change; these were failing the pre-existing format:check gate)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified - status tracking)

## Change Log

- 2026-08-02: Story 4.3 implemented end-to-end (all 10 tasks): indent/indent_line projections,
  9 indent.* events, compliance seam with duplicate hold + DOA/SOD guards, 8 REST routes,
  offline edge capture, requester-targeted notifications (NotificationTarget.user_id extension),
  registry-driven UNTAGGED_TRANSACTION enforcement for indent.raised, 8+1 permanent error codes
  across all sync surfaces, 14-test integration suite. All verification gates green; 0 new test
  failures. Status: review.

### Review Findings

- [x] [Review][Decision] HTTP status inconsistency between compliance seam and API layer — **resolved: seam uses specific statuses (404 for NOT_FOUND, 409 for ALREADY_DECIDED/DUPLICATE_EVENT, 403 for NOT_RESOLVED_APPROVER/RAISER_CANNOT_APPROVE)**
- [x] [Review][Patch] Seam uses specific HTTP statuses (404/409/403) instead of blanket 400 [src/compliance/indent.ts:220-222]
- [x] [Review][Patch] Floating-point DOA band resolution [src/api/v1/indents.ts:1045-1050]
- [x] [Review][Patch] No approver enforcement when approver_actor_id is null [src/compliance/indent.ts:668]
- [x] [Review][Patch] TOCTOU race on alreadyPersisted [src/compliance/indent.ts:365-372]
- [x] [Review][Patch] occurred_at not validated [src/compliance/indent.ts:459]
- [x] [Review][Patch] applyIndentDuplicateFlagged overwrites existing link [src/compliance/indent.ts:560-572]
- [x] [Review][Patch] Edge capture crashes on undefined required fields [edge/src/capture/indent.ts:1844-1846]
- [x] [Review][Patch] Submit button no debounce [edge/src/components/indent-capture.tsx:2003]
- [x] [Review][Patch] Test doesn't pin exact DOA boundaries [test/integration/story-4-3.test.ts:2385-2387]
- [x] [Review][Patch] business_stream not validated in assertIndentRaisedShape [src/compliance/indent.ts:296-351]
- [x] [Review][Patch] business_stream not trimmed in applyIndentRaised [src/compliance/indent.ts:469]
- [x] [Review][Defer] Online duplicate pre-check TOCTOU [src/api/v1/indents.ts:1016-1042] — deferred, seam handles it
- [x] [Review][Defer] No FK from indent_line to indent [read/projections/indent_line.sql:117] — deferred, schema design decision
- [x] [Review][Defer] Missing index on indent.status for non-open statuses [src/read/projections/indent.ts:1595-1598] — deferred, performance issue
- [x] [Review][Defer] Missing index on indent.requester_user_id for cross-status queries [src/read/projections/indent.ts:1196] — deferred, performance issue
- [x] [Review][Defer] indent_number_seq doesn't reset per year [read/projections/indent.sql:88] — deferred, cosmetic
- [x] [Review][Defer] cancelIndentBase doesn't validate state before persisting [src/api/v1/indents.ts:1387-1414] — deferred, seam validates
- [x] [Review][Defer] applyIndentClosed doesn't verify purchase_order_id [src/compliance/indent.ts:850-857] — deferred, ordered implies PO
- [x] [Review][Defer] Search pattern escaping non-standard PG setting [src/read/projections/indent.ts:1576] — deferred, non-default setting
- [x] [Review][Defer] Edge capture minimal client-side validation [edge/src/components/indent-capture.tsx:1942-1951] — deferred, HTML required handles it
