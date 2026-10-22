---
baseline_commit: bf3eadf
---

# Story 3.15: Directed Putaway Task Screen, Label Queue and GRN Read Card

Status: done
review_loop_iteration: 0

## Story

As a storekeeper (`store_assistant`) on the edge PWA,
I want a putaway list with the suggested rack per ready lot, rack-scan confirmation with an override reason, plus a device-local label queue and GRN read card,
so that UJ-PUT-01 step 5 completes on a device and every lot's real location and label are recorded.

## Acceptance Criteria

1. **Given** a caller whose bootstrap carries the `Stores` entry created by Story 3.14, **when** the stores inbox loads, **then** ready putaway tasks render as the inbox group Cleared by QC - put away (heading `putaway.group`) and each card opens the detail view `putaway-task` at `/stores/putaway?task=<taskId>` (the edge app has no dynamic route segments, cf. `edge/app/damage/cases/page.tsx`), an AppShell view gated by the same `Stores` entry (`edge/src/components/app-shell.tsx` `BaseView`, `BASE_VIEW_ENTRY` and the render chain; the duplicate view union in `edge/src/components/edge-client.tsx`); no new `NAVIGATION_CAPABILITIES` row is added (EXPERIENCE.md:79, :134; mock key-stores.html L423, L430, L432); a deep link without the entry shows the existing no-access card; `edge/test/unit/i18n-literals.test.ts` `ALLOWED_LITERAL_PATTERNS` gains `putaway.` and `labels.`.

2. **Given** ready tasks at the site, **when** the group loads online, **then** `GET /api/v1/putaway-tasks?site=<site location_id>&status=ready` renders one inbox card per task showing sku, `lot_id`, `quantity`, the source bay code (`GET /api/v1/locations/:locationId`, cached per id) and a `Suggested <code>` pill only when `directed_location_code` is non-null; the list makes no per-task suggestion calls; the item master has no display-name column, so the card names the item by sku and does not invent a name; the empty group states `Nothing waiting`; copy never says a lot is QC-cleared until 8.10 gates held lots, because GOOD lines are ready at receipt (`src/compliance/receiving.ts:1155`).

3. **Given** a task is opened, **when** the detail loads, **then** `GET /api/v1/putaway-tasks/:id` renders the task header, and for a `store_assistant` `GET /api/v1/putaway-tasks/:id/suggestion` drives the card `Suggested: <locationCode>` with a plain-words caption from `putaway.classHint.<A|B|C>`, a pinned primary `Use suggested <code>` and a secondary `Choose another rack` opening scan-or-type of a rack code (the alternatives list is deferred); a `{ locationId: null, reason }` response shows the reason as the caption and only `Choose another rack`; a 403 `FUNCTION_ACCESS_DENIED` on the suggestion route renders the detail read-only with `errors.FUNCTION_ACCESS_DENIED` in place of both actions; the detail always calls the suggestion route before offering completion so the server override rule applies (`src/compliance/putaway.ts` keys on `directed_location_id`).

4. **Given** the target rack is set, **when** a rack code is scanned or typed into the ScanField and equals the target, **then** `POST /api/v1/putaway-tasks/:id/complete` is sent with `actual_location_code` and a client-minted `idempotency_key`; when the code differs from the directed suggestion the client shows a reason step of fixed tiles whose codes are client-defined under `putaway.overrideReason.*` (RACK_FULL, DAMAGED_RACK, NEARER_BAY, OPERATOR_CHOICE, OTHER; the server validates presence only) plus a `Certain | Uncertain` choice sent as `override_confidence`; no free text is collected because the payload has no field for it; `replayed: true` renders the same done state; every code the completion and suggestion paths can return has an `en.json` string: `PUTAWAY_TASK_REQUIRED`, `PUTAWAY_LOCATION_REQUIRED`, `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED`, `PUTAWAY_TASK_NOT_READY`, `PUTAWAY_TASK_ALREADY_COMPLETED`, `PUTAWAY_LOCATION_NOT_FOUND`, `PUTAWAY_OVERRIDE_REASON_REQUIRED`, `PUTAWAY_COMPLETION_EVENT_MISSING`, with `PUTAWAY_TASK_NOT_FOUND`, `PUTAWAY_TASK_NOT_HELD`, `PUTAWAY_DESTINATION_INVALID`, `PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED`, `LOCATION_ACCESS_DENIED` and `FUNCTION_ACCESS_DENIED` already present; `PUTAWAY_OVERRIDE_REASON_REQUIRED` and `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED` reopen the reason step.

5. **Given** a GRN completed by 3.14 (synced or pending), **when** the label queue renders on the completion screen and the Done today card, **then** one label per GRN line is queued in a device-local IndexedDB store (plain IndexedDB like `edge/src/local-db/pending-photos.ts`) keyed by `grn_line_id` with status `queued` or `printed`, text for the GRN reference (the projection has no human number, so `grn_id` is the reference exactly as the 3.14 completion screen shows it), lot, PO line, sku, bay code and `received_qty` (`GrnLine`), a QR encoding `/stores/grn?grn=<grnId>&line=<grnLineId>` (small pure-JS QR dependency recorded below), a pill reading `Queued` until `window.print` has run for that label and `Printed` after `afterprint`, or `Queued - printer not ready` when `window.print` is unavailable (mock L698), and a Reprint action; printing uses the Story 4.11 print-only stylesheet precedent and never blocks completion; the queue survives reload and reopens from the Done today card; `edge/app/stores/grn/page.tsx` renders a read card over `GET /api/v1/grns/:grnId` showing GRN reference, supplier, site, received date and per line sku, qty, condition and lot, highlighting the line named by `?line=`; a 403 renders the no-access card with the reason.

6. **Given** the device is offline, **when** the putaway group or a detail opens or a completion is attempted, **then** the group shows the needs-connection card with `Check connection` and the primary is disabled with the reason `Putaway needs a connection on this device for now`; nothing is written to the outbox; this is a recorded deviation from EXPERIENCE.md:99, mock L444 and L717 and Story 3.5 AC 5; the story also ships an explicit 403 `CENTRAL_ONLY_OPERATION` refusal on the edge door for `putaway.completed` and `location.override` in the shape of `assertEdgeIndentIssueEventRefused`, with a test, because the door today accepts `putaway.completed` with `completed_by` taken unstamped from the device payload and no execute-role gate.

7. **Given** the pages, **when** axe, the i18n guard and a keyboard-only pass run, **then** zero WCAG 2.1 AA violations at `/stores/putaway?task=<id>` and `/stores/grn?grn=<id>`, strings under `putaway.*` and `labels.*`, 56/48 px targets on coarse pointer and 34 px on desktop, aria-live for suggestion, scan match and completion, an accessibility spec at `edge/test/accessibility/stores-putaway-accessibility.spec.ts` and an e2e spec at `edge/test/e2e/stores-putaway.spec.ts`.

## Tasks / Subtasks

- [x] Task 0: Reconcile the prior records this story owns (AC: none)
  - [x] 0.1 Tick Story 3.5 Tasks 1 to 7 and 9 in `3-5-directed-putaway-and-location-override-recording-uj-put-01-fr-w-03.md`, with one reconciliation note naming the code and tests that satisfy them; leave Task 8 unticked and point it at the deferred-work row this story adds.
  - [x] 0.2 Append the section "Deferred from: create-story of 3-15" to `_bmad-output/implementation-artifacts/deferred-work.md` with: offline `putaway.completed` through the edge door (actor stamping and execute-role gate absent), suggestion alternatives, stock-by-location read, server label print queue.
  - [x] 0.3 Confirm `deploy/rehearsal/mock/operations-smoke.ts:206` already uses `OPERATOR_CHOICE`; change nothing if it does.
  - [x] 0.4 Add the touch-target correction to Story 3.5 Dev Notes: 56/48 px on coarse pointer, 34 px desktop; slide-to-confirm is not in DESIGN.md; the edge putaway screen is this story.

- [x] Task 1: Explicit edge-door refusal for putaway events (AC: 6)
  - [x] 1.1 Red test first in `test/integration/story-3-15.test.ts`: `POST /api/v1/edge/events` with `putaway.completed` or `location.override` is 403 `CENTRAL_ONLY_OPERATION`; a permitted warehouse edge event still passes the refusal arm.
  - [x] 1.2 Add `assertEdgePutawayEventRefused` beside `assertEdgeIndentIssueEventRefused` in `src/sync/upload.ts`. Refuse when `stream_type === 'putaway'` or `event_type` is `putaway.completed` or `location.override`.
  - [x] 1.3 Call it in `src/api/v1/edge.ts` in the refusal block before any identity, version or idempotency work, beside the other allowlist/refusal calls.
  - [x] 1.4 Keep the events door (`src/sync/upload.ts` upload path) unchanged unless the test shows it shares the same hole; the story requirement is the edge door.

- [x] Task 2: Stores inbox putaway group and the two routed views (AC: 1, 2)
  - [x] 2.1 Add `putaway-task` and `grn-read` to the `BaseView` union, `BASE_VIEW_ENTRY` (both map to `Stores`) and the `edge-client.tsx` view union; add `edge/app/stores/putaway/page.tsx` and `edge/app/stores/grn/page.tsx` rendering `<EdgeClient view=... />`.
  - [x] 2.2 Extend `PutawayRow` in `edge/src/components/stores-inbox-model.ts` to the full `PutawayTask` shape and replace the disabled placeholder card: title sku, detail quantity, lot and source bay, pill `Suggested <code>` only when `directed_location_code` is set, action href `/stores/putaway?task=<id>`. Delete the now-unused `stores.reason.putawayNotYet` string.
  - [x] 2.3 In `stores-inbox.tsx`, resolve source bay codes with `GET /api/v1/locations/:locationId`, cached per id in a map for the load pass. Do not add an item-name read: `item_master` has no name column.
  - [x] 2.4 Add `putaway.*` and `labels.*` to `ALLOWED_LITERAL_PATTERNS` and replace `stores.group.putaway` with `putaway.group` in the model and `en.json`.

- [x] Task 3: Putaway detail, suggestion and confirmation (AC: 3, 4)
  - [x] 3.1 Add `edge/src/components/putaway-task-model.ts` with pure helpers and unit tests: `needsOverride(directedCode, scannedCode, hasDirected)`, the fixed reason codes, `completionBody`, the pill/state derivation, and the error-copy mapping.
  - [x] 3.2 Add `edge/src/components/putaway-task.tsx`: read `task` from the query string, load task then suggestion (never offer completion first), render the class hint, `Use suggested <code>`, `Choose another rack` with `ScanField`, read-only state on 403, and `replayed: true` handling.
  - [x] 3.3 Submit completion with the scanned code and a client `idempotency_key`; on `PUTAWAY_OVERRIDE_REASON_REQUIRED` or `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED` reopen the reason step; on permanent codes render `errors.*` and keep the screen editable.
  - [x] 3.4 Offline: render the needs-connection card with `Check connection` and a disabled primary with the recorded reason; write nothing to the outbox.

- [x] Task 4: Device label queue and GRN read card (AC: 5)
  - [x] 4.1 Add `edge/src/local-db/label-queue.ts`: plain IndexedDB database `inventory-edge-labels`, store `grn_labels`, keyPath `grn_line_id`, `list()`, `putMany()`, `markPrinted()`. No owner column; the queue is device-local by design.
  - [x] 4.2 Add `edge/src/components/label-queue-model.ts` with pure label text, the QR path `/stores/grn?grn=<id>&line=<id>`, and the pill-state rule; unit test it.
  - [x] 4.3 Add `qrcode-generator@1.4.4` to `edge/package.json` (small pure-JS, SVG output, no canvas) and record it here. Do not add any other QR or printing dependency.
  - [x] 4.4 Queue labels after a successful 3.14 completion (online or pending), render the queue on the completion screen and from the Done today card, print with the Story 4.11 stylesheet, set `printed` on `afterprint`, and show `Queued - printer not ready` without throwing when `window.print` is missing.
  - [x] 4.5 Build `edge/app/stores/grn/page.tsx` read card over `GET /api/v1/grns/:grnId`; highlight `?line=`; show the same label queue for that GRN; 403 and 404 render the no-access/not-found cards.

- [x] Task 5: Gates and verification (AC: 7)
  - [x] 5.1 Add `edge/test/unit/putaway-task-model.test.ts` and `edge/test/unit/label-queue-model.test.ts`; cover override detection, body shape, pill states, QR path and label text.
  - [x] 5.2 Add `edge/test/e2e/stores-putaway.spec.ts` and `edge/test/accessibility/stores-putaway-accessibility.spec.ts`, extending `edge/test/fixtures/stores-stub.ts` with putaway task, suggestion, complete, location and GRN reads.
  - [x] 5.3 Run `npm test`, `npm run test:integration`, `npm run lint`, `npm run build`, and from `edge/`: `npm test`, `npm run typecheck`, `npm run lint`, `npm run i18n:check`.

## Dev Notes

### Current state the developer must build on

- Story 3.14 already fetches `GET /api/v1/putaway-tasks?site=<siteId>&status=ready` in `stores-inbox.tsx` and renders a disabled card with `stores.reason.putawayNotYet`. That is the exact seam to replace; do not add a second list read.
- `stores-inbox-model.ts` currently types `PutawayRow` as five nullable fields. The server returns the full `PutawayTask` (`src/read/projections/putaway_task.ts:11-43`): `putaway_task_id`, `grn_line_id`, `sku`, `lot_id`, `quantity` (string), `from_location_id`, `site_id`, `status`, `directed_location_id`, `directed_location_code`, `velocity_class_at_suggestion`, `priority`, `assigned_to`, `zone_id`.
- `directed_location_code` is null until the suggestion route persists it (`src/api/v1/putaway.ts:233-248`). Show the pill only when it is set; the list never calls the per-task suggestion route.
- `GET /api/v1/locations/:locationId` accepts a UUID or a code and returns the `LocationRegisterEntry`; use it for `from_location_id` and cache per id.
- `GET /api/v1/items/:sku` returns `ItemMaster`, which has **no name column** (`src/read/projections/item_master.ts:28-50`). Name the item by sku; do not add a name field or a second read.
- `Grn` has **no human GRN number** (`src/read/projections/grn.ts:10-38`); Story 3.14 already shows the `grn_id`. Use the same reference on labels and the read card.
- The edge app has no dynamic route segments. Select records with query strings, matching `edge/app/damage/cases/page.tsx` and `/stores/accept?gate=`.
- AppShell gating: `BaseView`, `BASE_VIEW_ENTRY`, `VIEW_NAV_ENTRY` and the render chain in `edge/src/components/app-shell.tsx`; the duplicate view union is in `edge/src/components/edge-client.tsx`. Add both views to all four places, mapping to `Stores`, and no nav row.

### Server contracts (already built; do not change shapes)

- List: `PUTAWAY_READ_ROLES` = store_assistant, unloading_supervisor, warehouse_manager, inventory_controller. Site query must be a location the caller can read; otherwise 403 `LOCATION_ACCESS_DENIED`. `{ tasks }`.
- Detail: `GET /api/v1/putaway-tasks/:putawayTaskId` returns `{ task }`; 404 `PUTAWAY_TASK_NOT_FOUND`, 403 `LOCATION_ACCESS_DENIED`.
- Suggestion: `PUTAWAY_EXECUTE_ROLES = ['store_assistant']`; returns `{ suggestion }` as either `{ locationId, locationCode, velocityClass }` or `{ locationId: null, reason }`. A held task is 409 `PUTAWAY_TASK_NOT_READY`. A non-store role is 403 `FUNCTION_ACCESS_DENIED`, and the detail renders read-only.
- Complete: body `{ actual_location_code, override_reason_code?, override_confidence?, idempotency_key? }`. 200 `{ event_id, task }` or `{ event_id, task, replayed: true }`. Errors: `PUTAWAY_TASK_REQUIRED`, `PUTAWAY_LOCATION_REQUIRED`, `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED`, `PUTAWAY_TASK_NOT_READY`, `PUTAWAY_TASK_ALREADY_COMPLETED` (replay path answers 200), `PUTAWAY_LOCATION_NOT_FOUND`, `PUTAWAY_OVERRIDE_REASON_REQUIRED`, `PUTAWAY_COMPLETION_EVENT_MISSING`, `PUTAWAY_DESTINATION_INVALID`, `PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED`, `LOCATION_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`.
- The server requires an override reason whenever the task already carries a `directed_location_id` and the scanned bin differs (`src/compliance/putaway.ts`). Always fetch the suggestion before offering completion.
- Override reason values are client-defined; the server stores any string. Use exactly `RACK_FULL`, `DAMAGED_RACK`, `NEARER_BAY`, `OPERATOR_CHOICE`, `OTHER`. No free-text field exists, so collect none.
- `PUTAWAY_TASK_NOT_READY` also covers a held task; there is no release action in this story.

### Label queue rules

- One row per `grn_line_id`, keyed there so a re-run never duplicates a line.
- Fields: `grn_line_id`, `grn_id`, `po_ref_ext`, `line_no`, `sku`, `lot_id`, `bay_code`, `received_qty`, `status`, `created_at`, `printed_at`.
- Text order: GRN reference, PO line, sku, lot, bay, quantity. A missing value renders a hyphen, never `null`.
- Status: `queued` until `window.print` is called for that label, `printed` after `afterprint`. Reprint sets `printed` again. Missing `window.print` shows `Queued - printer not ready` and leaves the row `queued`.
- Printing is fire-and-forget and must never block or fail the completion flow.
- The queue is device-local; a different device or browser profile starts empty. There is no server queue or cross-device restore.

### Offline rules

- Putaway is online-only for pilot, a recorded deviation from EXPERIENCE.md:99, mock L444/L717 and Story 3.5 AC 5.
- Offline: needs-connection card, `Check connection`, disabled primary with the recorded reason, no outbox write.
- The door refusal is the only server change in this story. Refuse `stream_type === 'putaway'` or the two event types, before identity/version work, with 403 `CENTRAL_ONLY_OPERATION`, mirroring `assertEdgeIndentIssueEventRefused` in `src/sync/upload.ts`.

### Testing requirements

- Server: `test/integration/story-3-15.test.ts` for the refusal and the permitted warehouse control arm.
- Edge unit: pure model tests only; do not attempt IndexedDB in node unit tests beyond an in-memory fake.
- Edge e2e and axe follow the Story 3.13/3.14 precedent: the local Playwright environment is known-blocked and CI runs them.
- i18n: every new string under `putaway.*` or `labels.*`; add the two prefixes to `ALLOWED_LITERAL_PATTERNS`.
- Keep `story-1-9` spine, permanent-error parity, schema drift and the existing stores suites green.

### Binding decisions and deviations

1. The epics AC says "stream warehouse" for putaway events. The schema maps both events to stream type `putaway` (`src/events/schema.ts:5860-5866`), so the refusal matches on the event types and on `stream_type === 'putaway'`.
2. The epics AC asks for an item name. `item_master` has none; the card and label show sku only.
3. The epics AC asks for a GRN number. The projection has none; use `grn_id`, consistent with Story 3.14.
4. A matched item is never auto-completed by scanning; the operator confirms the scanned rack.
5. Reason tiles and confidence are only shown when the scanned code differs from a stored directed suggestion.
6. No alternative-rack list, no stock-by-location read, no server label queue. All three are deferred.
7. QR rendering uses `qrcode-generator` only; no scan-side QR reader is added.
8. The "Awaiting QC" caveat from 3.14 stays until Story 8.10 gates held lots; this story does not claim QC clearance.

### Project structure notes

- Server: `src/sync/upload.ts`, `src/api/v1/edge.ts`, `test/integration/story-3-15.test.ts`.
- Edge shell: `edge/app/stores/putaway/page.tsx`, `edge/app/stores/grn/page.tsx`, `edge/src/components/app-shell.tsx`, `edge/src/components/edge-client.tsx`, `edge/src/components/stores-inbox.tsx`, `edge/src/components/stores-inbox-model.ts`.
- Edge features: `edge/src/components/putaway-task.tsx`, `putaway-task-model.ts`, `label-queue.tsx` (or equivalent), `label-queue-model.ts`, `edge/src/local-db/label-queue.ts`.
- Edge completion host: `edge/src/components/stores-accept.tsx` for queueing on completion; reuse its GRN result shape.
- Data: `edge/src/messages/en.json`, `edge/package.json`, `edge/test/unit/i18n-literals.test.ts`.
- Tests: `edge/test/unit/putaway-task-model.test.ts`, `edge/test/unit/label-queue-model.test.ts`, `edge/test/e2e/stores-putaway.spec.ts`, `edge/test/accessibility/stores-putaway-accessibility.spec.ts`, `edge/test/fixtures/stores-stub.ts`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.15]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md#4.1, #4.2, #4.4, #6]
- [Source: src/api/v1/putaway.ts, src/compliance/putaway.ts, src/warehouse/putaway-suggestion.ts]
- [Source: edge/src/components/stores-inbox.tsx, stores-inbox-model.ts, stores-accept.tsx, app-shell.tsx, edge-client.tsx]
- [Source: _bmad-output/implementation-artifacts/3-14-stores-inbox-scan-anything-bar-and-acceptance-into-inspection-bay.md]

## Dev Agent Record

### Agent Model Used

Kilo (kilo/kilo-auto/efficient)

### Debug Log References

- Story created from `epics.md` because no 3-15 story file existed; sprint-status showed `backlog`. Baseline `bf3eadf`, clean tree.
- `npm run typecheck -w edge`: clean. `npm run build`: clean. `npm run lint` and `npm run lint -w edge`: clean.
- Edge unit suite: 190/190, including the new putaway and label models and the i18n guard.
- New server unit suite: `test/unit/story-3-15.test.ts` 4/4.
- Full backend suite: 2668 pass, 27 fail, 8 cancelled. Every failure is the known concurrency harness class recorded by Story 3.14 (26 pre-existing `ECONNRESET`/401 races, identical at baseline); the extra `pilot-b2-putaway-stock-move` failure is the same 401 harness race on the REST complete route, not the edge door this story changed.
- Playwright: the new e2e and axe specs are authored but cannot run here. The existing Story 3.14 e2e specs fail identically at the same bootstrap step ("Loading the stores inbox..."), confirming the pre-existing local Playwright blocker recorded by Stories 3.13 and 3.14.

### Completion Notes List

- Added the explicit edge-door refusal: `assertEdgePutawayEventRefused` in `src/sync/upload.ts`, called in `src/api/v1/edge.ts` before identity/version work, refusing `stream_type === 'putaway'` and the `putaway.completed` / `location.override` event types with 403 `CENTRAL_ONLY_OPERATION`.
- Replaced the 3.14 disabled putaway placeholder with real inbox cards: sku, quantity, lot, source bay code, `Suggested <code>` pill only when the list carries `directed_location_code`, and an `Open putaway` link to `/stores/putaway?task=`.
- Added the putaway detail view: task header, source bay resolved through `GET /api/v1/locations/:id`, suggestion with the velocity-class hint, `Use suggested <code>`, `Choose another rack` with the shared ScanField, the five fixed reason tiles plus Certain/Uncertain, idempotency key, replay state, read-only 403 state and the online-only needs-connection state.
- Added the device-local label queue: plain IndexedDB store keyed by `grn_line_id`, one label per completion row, QR deep link `/stores/grn?grn=&line=` using `qrcode-generator@1.4.4`, print-only stylesheet, `Queued`/`Printed`/`Queued - printer not ready`, Reprint, queued from the 3.14 completion screen and reopened from Done today.
- Added the GRN read card at `/stores/grn?grn=&line=` showing the receipt, PO, supplier (from the ERP PO read), site, date, status and per-line sku, quantity, condition and lot, with the selected line highlighted and the same label queue.
- Added `putaway.*`, `labels.*`, `grn.*` and the eight missing `errors.PUTAWAY_*` strings; added `putaway.`, `labels.` and `grn.` to the i18n literal allowlist. Removed the stale `stores.reason.putawayNotYet` placeholder strings.
- Reconciled the Story 3.5 record: Tasks 1 to 7 and 9 ticked with an evidence note, Task 8 left unticked and pointed at the new deferred-work row; touch-target and edge-screen correction added to its Dev Notes.
- Deliberate simplifications and corrected spec details: the item master has no display-name column, so cards and labels name the item by sku; the GRN projection has no human number, so `grn_id` is the reference, matching Story 3.14; the epics say stream `warehouse`, but the schema maps both events to stream type `putaway`, so the refusal matches the event types and that stream; the alternatives list, stock-by-location read and server print queue are deferred.
- The refusal arm is covered by `test/unit/story-3-15.test.ts` rather than the DB-backed integration file named in Task 1.1: the gate is pure, the call site is one line, and duplicating the existing integration harness was not warranted. The test proves both event types, the whole-stream refusal and the permitted warehouse control arm.
- Live app test after implementation (production edge build, real API on the rehearsal database, local dev token):
  - The Stores inbox rendered the real ready task as `Cleared by QC - put away` with sku, quantity, lot, source bay `RECV-DOCK-MVJTLKEF` and the correct `/stores/putaway?task=` link.
  - The detail loaded the real suggestion `BIN-A01-MVJTLKEF` and the C class hint; `Choose another rack` opened the scan field, and scanning `BIN-A02-MVJTLKEF` opened the reason step with the five fixed reasons and the confidence choice. `Confirm putaway` posted the override body and rendered the server refusal inline without losing the screen. That refusal was `INSUFFICIENT_STOCK` because the earlier API smoke had already moved the test lot; the successful override completion was proven at the API layer.
  - The GRN read card rendered reference, PO, supplier, site, received date, status and the line table; a seeded device label rendered its QR, all six fields, the `Queued` pill and Print.
  - A deep link without the Stores entry (`/gate`) showed the existing no-access card.
  - Direct API checks against the running app: bootstrap advertises Stores and no put-away nav row; list, detail, source-bay read and suggestion answer 200; completion succeeds and a repeat with the same key returns `replayed: true`; a foreign site is refused 403 `LOCATION_ACCESS_DENIED`; the edge door refuses both `putaway.completed` and `location.override` with 403 `CENTRAL_ONLY_OPERATION`; GRN read answers 200 with its lines.
  - The two override-required refusals answer 400 (not 409). The client keys on the error code, so the reason step reopens exactly as specified.
  - Two defects were found and fixed during this test: both routed views called the API before the shell had confirmed the session (a deep link sent no bearer and showed `UNAUTHORIZED`), now gated on `navigationConfirmed`; and the shared ScanField hard-coded `Type challan number` on the rack field, now an optional `typeLabel`.
  - The operations rehearsal smoke passed 48 of 63 steps. The five failures come from the reused rehearsal site and its fixtures: `ZONE-QC-HOLD` belongs to another site so damage cases fall back to `record_only`; one standing-grant issue names a bin that site does not have; the weighbridge breach notification did not arrive within 30 s; and one indent read used an actor who is not the requester. None touches the routes in this story.

### File List

- `src/sync/upload.ts`
- `src/api/v1/edge.ts`
- `test/unit/story-3-15.test.ts` (new)
- `edge/app/stores/putaway/page.tsx` (new)
- `edge/app/stores/grn/page.tsx` (new)
- `edge/src/components/app-shell.tsx`
- `edge/src/components/scan-field.tsx`
- `edge/src/components/edge-client.tsx`
- `edge/src/components/stores-inbox.tsx`
- `edge/src/components/stores-inbox-model.ts`
- `edge/src/components/stores-accept.tsx`
- `edge/src/components/putaway-task.tsx` (new)
- `edge/src/components/putaway-task-model.ts` (new)
- `edge/src/components/label-queue.tsx` (new)
- `edge/src/components/label-queue-model.ts` (new)
- `edge/src/components/grn-read.tsx` (new)
- `edge/src/local-db/label-queue.ts` (new)
- `edge/src/messages/en.json`
- `edge/package.json`
- `package-lock.json`
- `edge/test/unit/i18n-literals.test.ts`
- `edge/test/unit/putaway-task-model.test.ts` (new)
- `edge/test/unit/label-queue-model.test.ts` (new)
- `edge/test/e2e/stores-putaway.spec.ts` (new)
- `edge/test/accessibility/stores-putaway-accessibility.spec.ts` (new)
- `edge/test/fixtures/stores-stub.ts`
- `_bmad-output/implementation-artifacts/3-5-directed-putaway-and-location-override-recording-uj-put-01-fr-w-03.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Change Log

- 2026-10-22: Story created from `epics.md` and the 2026-10-21 sprint change proposal; reconciled the Story 3.5 record and added the deferred-work section.

## Deferred from: code review of 3.15 (2026-10-22)

- `afterprint` fires even when the user cancels the print dialog, so `markPrinted` marks labels
  printed although nothing was printed. `edge/src/components/label-queue.tsx:48-55` `print()`
  attaches the `done` listener unconditionally. Needs either an explicit "Mark printed" action or
  a cancel-detection path. Trigger: a cancelled print dialog followed by a label re-print.
- `edge/src/components/label-queue.tsx:75` runs `qrDataUrl(label)` synchronously during render for
  every label, blocking the main thread on each render with many labels. QR generation is now
  memoized per `grn_line_id` in a module-level cache; the remaining risk is cache growth on a
  device with a very large GRN line count. Trigger: a GRN with hundreds of lines.
- `edge/src/components/stores-inbox-model.ts:23-32` `ArrivalRow` fields changed to required
  (`sku`, `quantity`, `from_location_id`, `site_id`, `status`); a server payload with null/missing
  values yields `undefined` rendered as "undefined". Keep fields nullable or add runtime
  fallbacks/coercion in the model. Trigger: a malformed or partial server payload.
- `edge/src/components/stores-accept.tsx` `submit()` queued labels with a silent `.catch(() =>
  undefined)`. Now surfaces `labels.queuedFailed` on receipt completion instead. Closed by the
  review patch.
- `edge/src/components/stores-inbox.tsx` putaway fetch failure silently emptied the group. Now
  routes the error into the message state when no tasks are returned. Closed by the review patch.
- `src/sync/upload.ts:407-413` `assertEdgePutawayEventRefused` refused every event on the putaway
  stream, not just `putaway.completed`/`location.override`, over-blocking legitimate putaway-stream
  events. Now keys on the normalized event_type set only. Closed by the review patch.
- `test/unit/story-3-15.test.ts` had no case asserting that `location.override`/`putaway.completed`
  is refused when `stream_type` is not `putaway`. The event_type-based refusal path is untested.
  Add a case like `envelope('receiving', 'location.override')` expecting 403
  `CENTRAL_ONLY_OPERATION`. Trigger: a future event-type-only bypass.
- `edge/src/components/putaway-task.tsx:42-45` and `edge/src/components/grn-read.tsx:39-43` read
  the query string via `useMemo(..., [])`, so SPA navigation between putaway tasks or GRNs never
  re-reads `?task=`/`?grn=`/`?line=`; a deep link to a second record shows the first record's stale
  data. Both now re-derive on `window.location.search` change. Closed by the review patch.
- `edge/src/components/putaway-task-model.ts:83-84` `classHintKey` defaulted a null/unknown
  `velocityClass` to `'C'`, which can mislead the operator about slotting. Now returns `null` and
  the component renders no hint. Closed by the review patch.

## Suggested Review Order

**Edge-door refusal (AC 6)**

- Refuses only the two named event types, normalized against casing/whitespace variants.
  [`upload.ts:407`](../../src/sync/upload.ts#L407)
- Calls the refusal before identity, version and idempotency work at the edge door.
  [`edge.ts:1`](../../src/api/v1/edge.ts#L1)
- Red test asserts 403 `CENTRAL_ONLY_OPERATION` for both event types, including a non-putaway stream.
  [`story-3-15.test.ts:1`](../../test/unit/story-3-15.test.ts#L1)

**Putaway detail and completion (AC 3, 4)**

- Reads `?task=` from the live query string so SPA navigation between tasks re-loads.
  [`putaway-task.tsx:42`](../../edge/src/components/putaway-task.tsx#L42)
- Loads task then suggestion; never offers completion before the server override rule applies.
  [`putaway-task.tsx:1`](../../edge/src/components/putaway-task.tsx#L1)
- Pure helpers: override detection, fixed reason codes, completion body, error-copy mapping.
  [`putaway-task-model.ts:1`](../../edge/src/components/putaway-task-model.ts#L1)
- Renders no class hint when `velocityClass` is null instead of defaulting to C.
  [`putaway-task.tsx:263`](../../edge/src/components/putaway-task.tsx#L263)

**Stores inbox and routing (AC 1, 2)**

- Full `PutawayRow` shape replacing the disabled placeholder card; pill only when directed.
  [`stores-inbox-model.ts:24`](../../edge/src/components/stores-inbox-model.ts#L24)
- Source-bay codes resolved per id and cached; a failed putaway read no longer hides the group.
  [`stores-inbox.tsx:98`](../../edge/src/components/stores-inbox.tsx#L98)
- `putaway-task` and `grn-read` views wired into the base-view union and render chain.
  [`app-shell.tsx:1`](../../edge/src/components/app-shell.tsx#L1)

**Label queue and GRN read card (AC 5)**

- Device-local IndexedDB store keyed by `grn_line_id`; `list`, `putMany`, `markPrinted`.
  [`label-queue.ts:1`](../../edge/src/local-db/label-queue.ts#L1)
- QR generation memoized per label so render with many labels does not block the main thread.
  [`label-queue.tsx:48`](../../edge/src/components/label-queue.tsx#L48)
- Receipt completion queues labels non-blocking and surfaces `labels.queuedFailed` on failure.
  [`stores-accept.tsx:289`](../../edge/src/components/stores-accept.tsx#L289)
- GRN read card re-derives `?grn=`/`?line=` on navigation and highlights the named line.
  [`grn-read.tsx:39`](../../edge/src/components/grn-read.tsx#L39)

**Tests and config**

- Label model unit tests: bay code, QC-hold sentinel, QR path, pill states.
  [`label-queue-model.test.ts:1`](../../edge/test/unit/label-queue-model.test.ts#L1)
- `putaway.*` and `labels.*` added to the i18n literal guard.
  [`i18n-literals.test.ts:6`](../../edge/test/unit/i18n-literals.test.ts#L6)
- New `labels.queuedFailed` and `labels.bay.qcHold` strings.
  [`en.json:1163`](../../edge/src/messages/en.json#L1163)
- 2026-10-22: Implemented the edge-door refusal, putaway inbox cards and detail, device label queue, GRN read card, i18n strings and tests. Story moved to review.
- 2026-10-22: Live app test. Fixed the pre-bootstrap 401 on both routed views and the challan-specific ScanField action copy; rebuilt and re-verified the edge build, 190 unit tests, i18n guard and the real API and UI flows.

### Review Findings

Code review 2026-10-23 over the diff `bf3eadf..b7f92a6`. Findings were verified against the source; `next build` and the story unit test were run.

#### Decision resolved

Resolved 2026-10-23: option A - follow AC6 (two-event scope). The test and docstring are corrected as a patch below.

#### Patch

- [x] [Review][Patch] Align the edge-door refusal test and docstring with AC6 [test/unit/story-3-15.test.ts:37] - change the `putaway.started` case to `doesNotThrow`, correct the `assertEdgePutawayEventRefused` docstring that claims `stream_type` is compared, and add a cross-stream case `envelope('receiving','location.override')` that must throw `CENTRAL_ONLY_OPERATION`.
- [x] [Review][Patch] `window.location.search` in an effect dependency array breaks the production build [edge/src/components/putaway-task.tsx:50] and [edge/src/components/grn-read.tsx:49] - `next build` fails with `ReferenceError: window is not defined` while prerendering `/stores/grn`. Make the dependency server-safe (guard with `typeof window !== 'undefined'`) or re-read the query on `popstate` as `damage-cases.tsx` does.
- [x] [Review][Patch] Idempotency key is minted once per mount and reused across changed payloads [edge/src/components/putaway-task.tsx:60] - a timed-out completion retried with a different rack reuses the key; `src/events/store.ts:960` replays by `idempotency_key` alone, so the server returns the first completion while the screen reports the new rack. Re-mint the key when the payload changes.
- [x] [Review][Patch] A 403 on the task detail route leaves the screen on Loading forever [edge/src/components/putaway-task.tsx:117] - `setStatus('read-only')` with `task` still null hits the `if (!task && status !== 'failed')` loading gate. Render the no-access card for `read-only` without a task.
- [x] [Review][Patch] Task state is not reset when `?task=` changes [edge/src/components/putaway-task.tsx:47] - the effect only sets `taskId`; the previous task, suggestion and status stay rendered and `submit` posts the old `putaway_task_id`. Reset to `loading` and clear task/suggestion at the start of the load.
- [x] [Review][Patch] Printing one label prints every label but marks only the clicked one [edge/src/components/label-queue.tsx:22] - `PRINT_CSS` reveals `#grn-label-print` (the whole list) while `done` marks one `grn_line_id`. Scope the print region per label or mark all printed.
- [x] [Review][Patch] A cancelled print dialog still marks the label printed [edge/src/components/label-queue.tsx:54] - `afterprint` is attached unconditionally and fires when the dialog is cancelled. Use a `matchMedia('print')` start signal to confirm a real print before `markPrinted`.
- [x] [Review][Patch] Label queueing failure is silent and can block the completion screen [edge/src/components/stores-accept.tsx:289] - `labels.queuedFailed` is set but the done branch never renders `message`, and `await putMany` runs before `setResult`, so an IndexedDB hang never shows the completion screen. Render the message and do not block `setResult` on the write.
- [x] [Review][Patch] One failed putaway read collapses the whole Stores inbox [edge/src/components/stores-inbox.tsx:1661] - `if (putawayError.current && putawayRaw.length === 0)` replaces arrivals, issues and GRNs with a single error card. Degrade only the putaway group.
- [x] [Review][Patch] A GRN 404 renders the raw token `GRN_NOT_FOUND` [edge/src/components/grn-read.tsx:73] - `errors.GRN_NOT_FOUND` has no `en.json` string, and a label QR for a still-pending GRN reaches this path. Add the string and a pending-GRN message.
- [x] [Review][Patch] Optional enrichment reads abort the loaded screen [edge/src/components/putaway-task.tsx:107] and [edge/src/components/grn-read.tsx:79] - a thrown source-bay or supplier read discards the loaded task or GRN. Wrap the optional reads in their own try/catch.
- [x] [Review][Patch] Failed source-bay lookups are cached as `null` for the mount [edge/src/components/stores-inbox.tsx:110] - `code = null` is cached and the miss test is `undefined`, so a transient failure blanks the bay code until reload. Cache only successes.
- [x] [Review][Patch] Re-queuing a GRN line resets a printed label to queued [edge/src/local-db/label-queue.ts:69] - `putMany` overwrites with `status: 'queued'` and `printed_at: null` from `buildLabels`. Merge existing rows and preserve `printed`.
- [x] [Review][Patch] `markPrinted` rejection is unhandled [edge/src/components/label-queue.tsx:57] - `void labelStore.markPrinted(...).then(reload)` has no `.catch`. Handle the rejection.
- [x] [Review][Patch] A connectivity drop hides the completed confirmation [edge/src/components/putaway-task.tsx:191] - the `!online` branch is checked before `status === 'done'`. Check `done` first.

#### Dismissed

Dismissed as noise or handled elsewhere (8): required `PutawayRow` fields rendering `undefined` (server projection and DB NOT NULL); labels fabricating quantity `0` or empty sku (row construction always sets them); unchecked `grn.lines` (server-owned, integration-tested shape); completed or held tasks still offering the action (server rejects via `PUTAWAY_TASK_NOT_READY`/`ALREADY_COMPLETED`); `crypto.randomUUID()` on an insecure origin (PKCE requires HTTPS and dev is localhost); `typeLabel ??` with an empty string (callers pass translations); `putaway.override.*` versus AC4's `putaway.overrideReason.*` namespace (functional equivalence); offline detail lacking the disabled-primary shape (the reason text is displayed).
