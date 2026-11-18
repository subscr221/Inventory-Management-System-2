---
baseline_commit: a07e22f
---
# Story 3.14: Stores Inbox, Scan Anything Bar and Acceptance into Inspection Bay

Status: done
review_loop_iteration: 0

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

### Review Findings

Code review of 2026-11-19, diff `a07e22f` to HEAD `e8d0f3c` over the File List, three layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor).

Patches applied 2026-11-19: edge unit 212 of 212, story-3-14 integration 15 of 15, schema-drift 202 of 202, stores Playwright and axe 11 of 11; full edge Playwright 105 of 106, the one failure being an ambiguous locator in `floor-tasks.spec.ts` line 47 (Story 3.16, untouched here).

Decisions ruled by the owner on 2026-11-19 after a party-mode round (1b, 2b, 3b, 4b, 5a, 6b with three riders):

- [x] [Review][Patch] Do not ask for a short reason on a line that posts no GOOD row - ruled 1b; the server requires `SHORT` or `OTHER` only on a GOOD line and refuses a reason code that does not match the row condition (`src/compliance/receiving.ts` lines 508 and 1136) [edge/src/components/stores-accept.tsx:219]
- [x] [Review][Patch] Plain-language refusal when a lot-controlled item is received without a lot - rider on 2b [edge/src/components/stores-accept.tsx]
- [x] [Review][Patch] Inspection bay as a hard gate in the cutover runbook - ruled 4b with rider; one pilot site, no per-site bay codes [docs/migration/pilot-cutover-runbook.md]
- [x] [Review][Patch] Restore `fk_item_group_right_granted_by` and `fk_item_group_recipient_added_by` and their schema-drift pins - ruled 5a; Story 2.10 scope, separate commit [deploy/compose/init-db.sql:832]
- [x] [Review][Patch] Damaged and Rejected reason selects start empty and block Complete acceptance until chosen - rider on 6b [edge/src/components/stores-accept.tsx]
- [x] [Review][Defer] Lot and expiry inputs on the acceptance screen [edge/src/components/stores-accept.tsx] - deferred, ruled 2b; follow-up story, pilot receipts taken as not lot-controlled (owner did not confirm)
- [x] [Review][Defer] Server-side enforcement of `material_photo_ref` [src/compliance/receiving.ts] - deferred, ruled 3b; a server rule affects ERP inbound and every other `goods.received` caller
- [x] [Review][Defer] Counted stepper, reason tiles and a Match supplier action on the unmatched card - deferred, ruled 6b; UX pass
- [x] [Review][Defer] Per-site inspection bay codes and a bay for assignments below site level [src/api/v1/edge.ts:524] - deferred, ruled 4b; single pilot site
- [x] [Review][Patch] Edits after a refused submit are never sent; `submissionRef` is built once and never cleared [edge/src/components/stores-accept.tsx:261]
- [x] [Review][Patch] Online rows use `stores-receipt-` and outbox rows use `edge-receipt-` as idempotency key; a thrown fetch returns `STORES_OFFLINE` without queueing although the message says the lines were kept [edge/src/components/edge-client.tsx:997]
- [x] [Review][Patch] A count of zero on every line passes as counted, builds no rows and shows a completed GRN that does not exist; invalid quantity text becomes zero silently [edge/src/components/stores-accept.tsx:225]
- [x] [Review][Patch] Acceptance loads an arrival that already has a GRN, is unmatched or has no accepted weighment; a scan or deep link bypasses the disabled card [edge/src/components/stores-accept.tsx:142]
- [x] [Review][Patch] The load effect depends on `online`, so a connection flap reloads and resets every count and photo [edge/src/components/stores-accept.tsx:122]
- [x] [Review][Patch] No in-flight guard on Complete acceptance; `report-damage.tsx` has one [edge/src/components/stores-accept.tsx:261]
- [x] [Review][Patch] Cumulative received is computed by float subtraction, against the no-float data rule [edge/src/components/stores-accept.tsx:207]
- [x] [Review][Patch] This receipt's DAMAGED quantity is not subtracted from the over-receipt band the file header describes [edge/src/capture/receiving.ts:90]
- [x] [Review][Patch] The `= ordered` button fills from `ordered_qty`, not `open_qty`, and can go negative [edge/src/components/stores-accept.tsx:449]
- [x] [Review][Patch] `pickPhoto` has no rejection handler; a failed photo store gives no message [edge/src/components/stores-accept.tsx:249]
- [x] [Review][Patch] A missing inspection bay disables Complete acceptance with no entry in the missing list [edge/src/components/stores-accept.tsx:241]
- [x] [Review][Patch] Gate photo is a plain anchor to an authenticated route; other screens use `authorizedFetch` [edge/src/components/stores-accept.tsx:364]
- [x] [Review][Patch] Done today: server GRNs show `Captured - pending sync`, no date filter, duplicates between arrivals and the GRN list, `pending` flag ignored, UTC day boundary (AC 3) [edge/src/components/stores-inbox-model.ts:79]
- [x] [Review][Patch] An offline-queued receipt leaves its arrival startable in Arrived [edge/src/components/stores-inbox-model.ts:75]
- [x] [Review][Patch] `mounted` ref is never set back to true; the lot lookup sends the untrimmed scan [edge/src/components/stores-inbox.tsx:64]
- [x] [Review][Patch] Test gaps closed in runnable suites: schema-drift mirror asserts its marker; AC 8 write round trip and seven inspect validator refusals in `test/integration/story-3-14.test.ts`; `acceptanceMissing`, scan trimming, damaged against the band, zero and short-only `buildReceiptRows` in the edge unit tests; the lot e2e test retitled to what it does [edge/test/e2e/stores-inbox.spec.ts:28]
- [x] [Review][Patch] Playwright coverage added once `npm install` in `edge/` restored the missing `qrcode-generator` package: complete acceptance, refusal then corrected resubmit under the same ids, zero count refused, unweighed arrival refused, lot sheet, and an axe scan with the short, damage reason and inspect controls open [edge/test/e2e/stores-inbox.spec.ts]
- [x] [Review][Patch] Suggested Review Order cites `test/unit/story-3-14.test.ts` and `edge.ts:1` for `edge-client`; both paths are wrong [this file]
- [x] [Review][Defer] Arrivals read has no limit or pagination [src/api/v1/receiving.ts] - deferred, pilot volume is small
- [x] [Review][Defer] Arrivals read picks the oldest GRN per correlation with no status filter [src/api/v1/receiving.ts] - deferred, no void GRN status in the pilot flow
- [x] [Review][Defer] PO summary sums `open_qty` across units of measure and joins on PO number only [src/api/v1/receiving.ts] - deferred, display value only
- [x] [Review][Defer] Photo references are length-checked only, not checked for existence or site [src/compliance/receiving.ts] - deferred, pre-existing pattern for `reason_photo_ref`
- [x] [Review][Defer] Rehearsal setup reports `exists` for any `IB-01` without checking type or site [deploy/rehearsal/mock/setup-operations.ts] - deferred, follows the bay provisioning decision
- [x] [Review][Defer] Inbox treats a 403 or 500 on indents, GRNs or putaway as an empty group [edge/src/components/stores-inbox.tsx] - deferred, shared inbox pattern

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

## Suggested Review Order

**Server seam (AC 1, 2)**

- Receives arrivals with weighment and GRN joins; scope allows receiving/inventory modules and write assignments.  
  [`receiving.ts:1`](../../src/api/v1/receiving.ts#L1)
- Registers the route before `/grns/:grnId`; site filtering via `receivingScope`.  
  [`server.ts:1`](../../src/server.ts#L1)
- Adds `inspection_bay_code` to edge bootstrap via the receiving module.  
  [`edge.ts:1`](../../src/api/v1/edge.ts#L1)
- Boots IB-01 inspection bay zones per pilot site; active, non-quarantine, staging type.  
  [`setup-operations.ts:1`](../../deploy/rehearsal/mock/setup-operations.ts#L1)
- Adds `stores` nav entry and `Stores` NAVIGATION_CAPABILITIES row before `Stores issue`.  
  [`edge.ts:1`](../../src/api/v1/edge.ts#L1)

**GRN inspect-on-opening fields (AC 8)**

- Adds `grn_line_inspect.sql` ALTER-only, appended after `grn_line_condition.sql`.  
  [`migrate.ts:1`](../../src/events/migrate.ts#L1)
- Types `inspect_on_opening`, `inspect_note`, `inspect_photo_ref`, `material_photo_ref` in schema.  
  [`schema.ts:1`](../../src/events/schema.ts#L1)
- Assertions allow note/photo only when inspect toggle is active.  
  [`receiving.ts:1`](../../src/compliance/receiving.ts#L1)
- Mirrors verbatim at tail of `init-db.sql`; pinned by name in `schema-drift.test.ts`.  
  [`init-db.sql:1`](../../deploy/compose/init-db.sql#L1)

**Edge shell, inbox, scan bar (AC 1, 3, 4)**

- Three views wired into `app-shell.tsx`, `edge-client.tsx`, `app/stores/{,accept,issue}/page.tsx`.  
  [`app-shell.tsx:1`](../../edge/src/components/app-shell.tsx#L1)
- Four groups: Arrived awaiting acceptance, Cleared by QC - put away, Issues pending, Returns to shelf.  
  [`stores-inbox.tsx:1`](../../edge/src/components/stores-inbox.tsx#L1)
- Scan bar routes: unmatched→arrival, accepted→done card, lot→damage sheet, else unknown.  
  [`stores-inbox.tsx:146`](../../edge/src/components/stores-inbox.tsx#L146)
- Empty groups read `Nothing waiting`; done section lists captured and synced GRNs.  
  [`stores-inbox.tsx:160`](../../edge/src/components/stores-inbox.tsx#L160)

**Acceptance band cap and condition split (AC 5, 6, 7)**

- Band cap: `ordered × (1 + tolerance%) - cumulative(GOOD+DAMAGED)` with floor at zero.  
  [`receiving.ts:142`](../../edge/src/capture/receiving.ts#L142)
- GOOD/DAMAGED/REJECTED ordering: DAMAGED/REJECTED before GOOD.  
  [`receiving.ts:250`](../../edge/src/capture/receiving.ts#L250)
- Offline: envelopes + photos to outbox, `received_by` server-set, refusal → Refused captures.  
  [`edge-client.tsx:3`](../../edge/src/components/edge-client.tsx#L3)

**Integration and tests (AC 9)**

- 7 integration tests cover weighment join, GRN join, ordering, bootstrap `inspection_bay_code`.  
  [`story-3-14.test.ts:1`](../../test/integration/story-3-14.test.ts#L1)
- `stores.*` i18n literals added; `i18n-literals.test.ts` guard green.  
  [`i18n-literals.test.ts:6`](../../edge/test/unit/i18n-literals.test.ts#L6)
- Playwright e2e and axe specs for zero WCAG AA violations and 56/48/34 px targets.  
  [`stores-inbox.spec.ts:1`](../../edge/test/e2e/stores-inbox.spec.ts#L1)

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
- 2026-11-19: Code review (three layers) found 6 decisions, 17 patches, 6 defers; owner ruled the decisions; 23 patches applied, including Playwright coverage of the submit path. Status done.
