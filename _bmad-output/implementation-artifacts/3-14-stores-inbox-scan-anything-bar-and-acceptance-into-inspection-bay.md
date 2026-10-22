---
baseline_commit: a07e22f
---
# Story 3.14: Stores Inbox, Scan Anything Bar and Acceptance into Inspection Bay

Status: review

## Story
As a storekeeper (`store_assistant`),
I want a task inbox with a Scan anything bar and an acceptance screen that counts every PO line, reports short, damaged or rejected with evidence, and completes the GRN into the inspection bay,
so that UJ-PUT-01 steps 1 to 3 and the acceptance half of step 4 run on the PWA with the Story 3.11 reason codes.

## Acceptance Criteria
1. **Given** a caller with a receiving write assignment at the operating site, **when** the bootstrap runs, **then** navigation carries `Stores` from a new row `{ name: 'Stores', modules: ['receiving'], functionScope: 'write' }` inserted before `Stores issue`; `NAV_ENTRIES` gains `/stores`; `app-shell.tsx` adds `stores`, `stores-accept` and `stores-issue` to the view union, `BaseView`, `BASE_VIEW_ENTRY` and `VIEW_NAV_ENTRY`; new `edge/app/stores/page.tsx` and `edge/app/stores/accept/page.tsx` render `<EdgeClient view=... />`; `edge/app/stores/issue/page.tsx` renders `<EdgeClient view="stores-issue" />` inside AppShell gated by its own existing `Stores issue` entry; a deep link without the entry renders the no-access card with no list fetch.
2. **Given** Task 0 server work, **when** it lands, **then** `GET /api/v1/receiving/arrivals?site=<site_code_ext>` exists under receiving read and the receiving site scope, returning the site's open gate events (`gate_event_id`, `challan_number_ext`, `vehicle_reg_ext`, `driver_name`, `challan_photo_ref`, `entered_at`, `binding_status`, `po_summary`, `supplier_ref_ext`, `binding_token`) joined with `has_accepted_weighment` and `grn_id`, oldest first; one active non-quarantine inspection bay zone (code `IB-01`) is registered per pilot site and exposed to the edge by the bootstrap.
3. **Given** the device is online, **when** the inbox loads, **then** it shows four groups in order: Arrived - awaiting acceptance, Cleared by QC - put away, Issues pending, Returns to shelve; matched arrivals carry `Start acceptance`, unmatched carry `Match supplier`, a matched arrival without an accepted weighment carries `Waiting for weighbridge`; each card has a text status pill and one primary action; every empty group reads `Nothing waiting`; a conditional Done today section lists GRNs captured on this device (Captured - pending sync / Synced) and today's posted GRNs.
4. **Given** the Scan anything bar, **when** a code is scanned or typed, **then** a challan matching an open matched arrival opens acceptance; an already-accepted challan opens its Done today card; a lot QR opens a one-action sheet offering Report damage with the lot prefilled; any other code announces `Not recognised: <code>. Scan or type a challan or lot code.`
5. **Given** an Arrived card with an accepted weighment, **when** acceptance renders, **then** the header carries challan, supplier, PO, vehicle, arrival time and gate photo without retyping; a banner names the inspection bay; PO lines come from `GET /api/v1/erp/purchase-orders/:poNumber`; every open line shows ordered, a counted stepper with `= ordered`, and a Matches PO / Short n / Excess n chip; the client caps posted GOOD quantity to `ordered x (1 + over_receipt_tolerance_pct / 100)` minus cumulative received (GOOD and DAMAGED count, REJECTED does not) and shows the remainder as `Excess - returned with vehicle`; a short line requires one of the three fixed SHORT tiles or `Other` (photo and note); each line carries Good / Damaged / Rejected quantities summing to the counted quantity, with the Story 3.11 detail tiles; one material photo is required; the Inspect on opening toggle offers Damage suspected or Damage observed with an optional photo and the helper copy; Complete acceptance stays disabled stating what is left.
6. **Given** a complete acceptance online, **when** Complete acceptance is tapped, **then** each PO line posts one `goods.received` per non-zero condition quantity to `POST /api/v1/grn-lines` on a shared `grn_id`, `grn_line_id` per row, `correlation_id` equal to the binding token, `target_location_code` equal to the inspection bay for GOOD rows (DAMAGED/REJECTED route to `ZONE-QC-HOLD`), DAMAGED/REJECTED before GOOD, with the Story 3.11 fields; no Split control; the posted quantity never exceeds the band; permanent codes render `errors.*` copy and the line stays editable; the completion screen shows the GRN number and summary pills and Done today gains the GRN.
7. **Given** an acceptance opened online while the device then goes offline, **when** it is completed, **then** every line envelope and its photos go to the outbox and `pendingPhotoStore`, the screen reads `Captured - pending sync`, upload goes through `POST /api/v1/edge/events` with `received_by` server-set, a refusal lands in Refused captures, and the inbox lists show the needs-connection card rather than a stale list.
8. **Given** Task 1 server work, **when** `goods.received` carries the optional fields `inspect_on_opening` (suspected or observed), `inspect_note`, `inspect_photo_ref` and `material_photo_ref`, **then** they persist on `grn_line` through a new ALTER-only file `read/projections/grn_line_inspect.sql` appended in `src/events/migrate.ts` after `grn_line_condition.sql`; typed in `src/events/schema.ts`; asserted in `assertReceiptReasonShape` (`inspect_note` and `inspect_photo_ref` allowed only with `inspect_on_opening`); mirrored verbatim at the tail of `deploy/compose/init-db.sql`; pinned by name in `test/unit/schema-drift.test.ts`; `GET /api/v1/grns/:grnId` returns them per line; `listDiscrepancyLines` is unchanged.
9. **Given** the inbox, acceptance and completion screens, **when** axe, the i18n literal guard and a keyboard-only pass run, **then** zero WCAG 2.1 AA violations, all strings under `stores.*`, 56/48/34 px targets, primary pinned in the bottom third on Handheld, aria-live for scan and sync results.

## Tasks / Subtasks
- [x] Task 0: Server seams, nav row and inspection bay (AC: 1, 2)
- [x] 0.1 Red tests first: `test/integration/story-3-14.test.ts` for the arrivals read (scope, ordering, weighment and GRN joins), the bootstrap `inspection_bay_code`, and the `Stores` nav row.
- [x] 0.2 Add `GET /api/v1/receiving/arrivals` in `src/api/v1/receiving.ts` and register it before `/grns/:grnId` in `src/server.ts`.
- [x] 0.3 Expose `inspection_bay_code` on the edge bootstrap (`src/api/v1/edge.ts`).
- [x] 0.4 Add the `Stores` NAVIGATION_CAPABILITIES row and `NAV_ENTRIES` entry.
- [x] 0.5 Provision the `IB-01` inspection bay zone per pilot site in `deploy/rehearsal/mock/setup-operations.ts`.
- [x] Task 1: Additive GRN inspect-on-opening fields (AC: 8)
- [x] 1.1 Red tests first: shape assertions and the per-line read.
- [x] 1.2 Add `read/projections/grn_line_inspect.sql`, append it in `src/events/migrate.ts`, and mirror it at the tail of `deploy/compose/init-db.sql`.
- [x] 1.3 Type the fields in `src/events/schema.ts` and assert them in `assertReceiptReasonShape`.
- [x] 1.4 Extend `GrnLine`, the insert input, select, map and both insert call sites; pin the file in `test/unit/schema-drift.test.ts`.
- [x] Task 2: Edge shell, stores inbox and Scan anything bar (AC: 1, 3, 4)
- [x] 2.1 Add the three views to `app-shell.tsx`, `edge-client.tsx`, the pages, and the nav entry.
- [x] 2.2 Build `edge/src/components/stores-inbox.tsx` with the four groups, Done today, scan bar and lot sheet.
- [x] 2.3 Unit tests for the pure inbox grouping, cap and scan-resolution rules.
- [x] Task 3: Acceptance and offline capture (AC: 5, 6, 7)
- [x] 3.1 Build `edge/src/capture/receiving.ts` (band cap, condition split, payload builder) with unit tests.
- [x] 3.2 Build `edge/src/components/stores-accept.tsx` with the PO line counting, condition tiles, photos and completion summary.
- [x] 3.3 Wire `submitReceipt` in `edge-client.tsx`: online posts each envelope, offline writes to the outbox and `pendingPhotoStore`.
- [x] Task 4: Gates (AC: 9)
- [x] 4.1 Add `stores.*` strings to `edge/src/messages/en.json` and keep the i18n literal guard green.
- [x] 4.2 Author the Playwright e2e and axe specs.
- [x] 4.3 Run server integration/unit suites, edge typecheck/lint/unit, and the full backend suite.

## Dev Notes
### Server contract
- `RECEIVING_READ_ROLES` is `['store_assistant','unloading_supervisor','warehouse_manager','inventory_controller']` (`src/api/v1/receiving.ts:39-44`); `assertRoleAllowed` admits modules `receiving`, `inventory` and `*`, and its read check accepts a write assignment. `receivingScope` unions receiving and inventory locations, so the arrivals route needs no new role.
- `gate_event` carries `gate_event_id`, `challan_number_ext`, `vehicle_reg_ext`, `driver_name`, `challan_photo_ref`, `entered_at`, `binding_status`, `supplier_ref_ext`, `supplier_name_unlisted`, `supplier_unlisted`, `po_ref_ext`, `correlation_id`, `status` (`read/projections/gate_event.sql`). `weighbridge_event` joins by `correlation_id` and `status = 'accepted'`. `grn.correlation_id` is the binding token.
- `store_assistant` holds no gate or weighbridge module, so this dedicated receiving read is the only correct seam.
- The inspection bay is a `level = 'zone'`, `zone_type = 'staging'`, non-quarantine active location. `receiving.ts` already resolves a GOOD line's `target_location_code` through `getLocationByCode`; DAMAGED/REJECTED rows are forced to `ZONE-QC-HOLD` (`src/compliance/receiving.ts:1110-1131`).
- `reject` band: `ordered_qty * (1 + over_receipt_tolerance_pct / 100)` minus cumulative GOOD+DAMAGED receipts (`src/compliance/receiving.ts:753-773`). REJECTED is excluded.

### Edge shell
- Base views: `BaseView`, `BASE_VIEW_ENTRY` and `VIEW_NAV_ENTRY` in `edge/src/components/app-shell.tsx:133-170`; the render chain starts at `:356`. `EdgeClient` carries a duplicate view union at `edge/src/components/edge-client.tsx:231-245`.
- `EdgeClient` already receives `siteCodeExt`, `siteId`, `online` and the outbox database. `submitGate`/`submitWeighment` (`edge-client.tsx:900-958`) show the capture pattern: build a pure payload, `insertCaptureEvent`, refresh local state.
- `pendingPhotoStore` stores original blobs; `uploadPendingPhotos` drains them generically, so receipt photos reuse it.
- `ScanField` (`edge/src/components/scan-field.tsx`) is the shared control; `ScanAnythingBar` wraps it and resolves the code.
- `stores-issue.tsx` renders its own page chrome today; the re-home wraps it in `AppShell` by adding a `stores-issue` view.
- No dynamic route segments: select records by query string.

### Data rules (acceptance)
- Every open PO line shows ordered and cumulative received. The client cap is computed in integer minor units (or scaled decimal strings); never float arithmetic on money or quantity.
- A line's counted quantity = Good + Damaged + Rejected. A short line needs one of `SUPPLIER_SHORT_SHIPPED`, `PART_DELIVERY_BALANCE_TO_FOLLOW`, `COUNT_MISMATCH_WITH_CHALLAN` or `OTHER`; `OTHER` needs a photo and a one-line note (`src/compliance/receiving-reasons.ts`).
- `inspect_on_opening` is a note for the inspector, never a QC verdict.

### Testing requirements
- Server: `test/integration/story-3-14.test.ts`; keep schema-drift, spine allowlist and permanent-error parity green.
- Edge: unit tests for the pure models and payload builder; Playwright e2e and axe authoring follows the Story 3.13 precedent (the local Playwright environment is known-blocked; CI runs them).
- Story 1.9 spine allowlist gains the arrivals route.

### Project Structure Notes
- Server: `src/api/v1/receiving.ts`, `src/api/v1/edge.ts`, `src/server.ts`, `src/compliance/receiving.ts`, `src/events/schema.ts`, `src/events/migrate.ts`, `src/read/projections/grn_line.ts`, `read/projections/grn_line_inspect.sql`, `deploy/compose/init-db.sql`.
- Edge: `edge/app/stores/{page.tsx,accept/page.tsx,issue/page.tsx}`, `edge/src/components/stores-inbox.tsx`, `stores-accept.tsx`, `edge/src/capture/receiving.ts`, `app-shell.tsx`, `edge-client.tsx`, `navigation/nav-model.ts`, `messages/en.json`.
- Tests: `test/integration/story-3-14.test.ts`, `test/unit/schema-drift.test.ts`, `edge/test/unit/stores-inbox.test.ts`, `edge/test/unit/stores-accept.test.ts`, `edge/test/e2e/stores-inbox.spec.ts`, `edge/test/accessibility/stores-accessibility.spec.ts`.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.14]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md#4.1, #4.4, #6]
- [Source: src/compliance/receiving.ts, src/api/v1/receiving.ts, read/projections/grn_line_condition.sql]

## Dev Agent Record
### Agent Model Used
Kilo (kilo/kilo-auto/efficient)

### Debug Log References
- Story created from `epics.md` because no 3-14 story file existed; sprint-status showed `backlog`. Baseline `a07e22f`.

### Completion Notes List
- Server: added the receiving-scoped `GET /api/v1/receiving/arrivals` read (site scoped, oldest first, joining the accepted weighment and any GRN on the binding token); added `inspection_bay_code` to the edge bootstrap; added the `Stores` navigation row before `Stores issue` and provisioned `IB-01` in the rehearsal operations setup.
- Schema: added `read/projections/grn_line_inspect.sql` (forward-only, ALTER-only, named CHECKs), appended after `grn_line_condition.sql`, mirrored verbatim in `deploy/compose/init-db.sql`, typed in `src/events/schema.ts`, asserted in `assertReceiptReasonShape`, and carried through the `grn_line` projection insert and replay comparison so retries remain idempotent.
- Edge: new `/stores` inbox with four groups, Scan anything bar, lot sheet, and Done today (server GRNs plus this device's pending outbox receipts); new `/stores/accept` with per-line counting, condition split, band cap and excess, fixed short tiles with Other evidence, one material photo, inspect-on-opening notes, and online or offline completion; `/stores/issue` re-homed inside AppShell.
- Capture: `edge/src/capture/receiving.ts` keeps quantities as scaled integers, builds one `goods.received` row per non-zero condition with DAMAGED/REJECTED before GOOD, and is unit tested for cap, excess, condition order and evidence.
- Tests: 7 server integration tests plus schema-drift and spine-allowlist updates pass; 182 edge unit tests pass; 12 new model/builder tests.
- Deliberate simplifications (recorded, not hidden): the ERP PO read exposes no per-line uom, so the acceptance screen reads the item master per SKU and falls back to `EA`; cumulative received is derived as `ordered - open_qty` because the PO read exposes no platform cumulative, and the server remains the authority on the band; the completion screen shows the GRN id because the projection has no separate human number; the Cleared-by-QC and Returns groups are read-only placeholders until Story 3.15 and the returns screen land.
- Environment note: the full backend suite has pre-existing `ECONNRESET` races in unrelated concurrency suites; the same suites fail identically at baseline `a07e22f` (verified in a clean worktree), so they are not regressions from this story. The Playwright e2e and axe specs are authored but the local Playwright environment remains blocked, as recorded for Story 3.13.

### File List
- `read/projections/grn_line_inspect.sql` (new)
- `deploy/compose/init-db.sql`
- `deploy/rehearsal/mock/setup-operations.ts`
- `src/api/v1/edge.ts`
- `src/api/v1/receiving.ts`
- `src/compliance/receiving.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/read/projections/grn_line.ts`
- `src/server.ts`
- `edge/app/stores/page.tsx` (new)
- `edge/app/stores/accept/page.tsx` (new)
- `edge/app/stores/issue/page.tsx`
- `edge/app/globals.css`
- `edge/src/capture/receiving.ts` (new)
- `edge/src/components/app-shell.tsx`
- `edge/src/components/edge-client.tsx`
- `edge/src/components/navigation/nav-model.ts`
- `edge/src/components/report-damage.tsx`
- `edge/src/components/stores-accept.tsx` (new)
- `edge/src/components/stores-inbox.tsx` (new)
- `edge/src/components/stores-inbox-model.ts` (new)
- `edge/src/local-db/outbox.ts`
- `edge/src/messages/en.json`
- `edge/test/accessibility/stores-accessibility.spec.ts` (new)
- `edge/test/e2e/stores-inbox.spec.ts` (new)
- `edge/test/fixtures/stores-stub.ts` (new)
- `edge/test/unit/stores-accept.test.ts` (new)
- `edge/test/unit/stores-inbox.test.ts` (new)
- `test/integration/story-3-14.test.ts` (new)
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`

### Change Log
- 2026-10-22: Story created and development started from baseline `a07e22f`.
- 2026-10-22: Implemented the arrivals read, bootstrap inspection bay, Stores navigation, inspect-on-opening schema and acceptance/inbox screens; added server, schema-drift, edge unit, e2e and axe coverage. Story moved to review.
