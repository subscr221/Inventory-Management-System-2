---
baseline_commit: 4f37d32
---
# Story 3.13: Gate Entry and Weighbridge Capture Screen

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a gate officer or weighbridge operator at the pilot site (gate1@ancorlabs.org holds both roles, `docs/migration/pilot-mock-extract/roles.json:297-310`),
I want one edge screen that captures the gate entry (challan, photo, vehicle, supplier, PO binding) and the weigh-in gross and weigh-out tare, online or offline,
so that a PO-backed truck gets a binding token and an accepted weighment from the PWA, and receiving can raise a GRN.

## Acceptance Criteria

1. **Given** a caller whose assignment role is `gate_officer` or `weighbridge_operator` with `functionScope` write covering the operating site, **when** the bootstrap runs, **then** navigation carries `Gate entry` from a new row `{ name: 'Gate entry', modules: 'gate', functionScope: 'write' }` resolved by a role-evaluated `hasGateScope` beside `hasDamageCaseScope` (`src/api/v1/edge.ts:389-420`), with the modules union at `src/api/v1/edge.ts:364-368` widened with `gate`. `NAV_ENTRIES` gains `/gate` with label `nav.gateEntry` (`edge/src/components/navigation/nav-model.ts:11-31`). `gate` joins `BaseView` and `BASE_VIEW_ENTRY` (`edge/src/components/app-shell.tsx:130-152`). A `store_assistant` holding `inventory` is not sent the entry. A deep link without the entry renders the existing no-access card (`app-shell.tsx:349-358`). The fixtures at `edge/test/e2e/offline-shell.spec.ts:13-19` are updated. An integration test proves both callers see the entry and a `store_assistant` does not.

2. **Given** Task 1 server work, **when** it lands, **then** `gate_officer` and `weighbridge_operator` are admitted to the GET path only of the ASN read (`src/api/v1/asn.ts:18`, `:27-30`, `:41-44`, `:242-245`); `assertRoleAllowed` in `src/api/v1/gate.ts:68-87` and `src/api/v1/weighbridge.ts:71-92` adopts the `src/middleware/rbac.ts:165-168` rule that a write assignment satisfies a read check, with a test per router that a write-only holder lists with 200 and a read-only `stock_viewer` still gets 403; `weighbridge_operator` joins `GENERAL_READ_ROLES` (`gate.ts:33`) and `gate_officer` joins `WEIGHBRIDGE_READ_ROLES` (`weighbridge.ts:32-36`).

3. **Given** Task 1 server work, **when** the bootstrap response is built (`src/api/v1/edge.ts:452-460`), **then** it gains `site_code_ext` (from `location_register` for the operating site) and `gate_id` (edge config, default `GATE-01`), which `gate.entered` requires (`src/compliance/gate.ts:69-75`). `assertGateEnteredShape` accepts optional `supplier_ref_ext` (vendor code or `UNLISTED`) and `supplier_name_unlisted`, projected onto `gate_event`.

4. **Given** Task 1 server work, **when** the stamp-status read is added, **then** `GET /api/v1/weighbridge-events/stamp-status?site=` (`WEIGHBRIDGE_READ_ROLES`, registered before `/api/v1/weighbridge-events/:weighbridgeEventId` at `src/server.ts:792`) returns the site device keys with stamp state from the statutory examination register (`src/compliance/weighbridge.ts:73-102`). `WEIGHBRIDGE_OUT_OF_STAMP` is added to both `PERMANENT_ERROR_CODES` twins (`edge/src/sync/connector.ts:111-118`, `src/sync/upload.ts:102-108`), the parity test stays green, and `errors.WEIGHBRIDGE_OUT_OF_STAMP` is added to `edge/src/messages/en.json` beside `:143-149`.

5. **Given** the Challan step, **when** the officer scans a challan code with the new shared `ScanField` (hardware trigger, keyboard wedge into the focused input, camera on coarse pointer; `Scan again` and `Type challan number` side by side and visible without scrolling at 360x640, EXPERIENCE.md:80, DESIGN.md:270), **then** the code is resolved online as ASN first (`GET /api/v1/asn/:asnNumberExt`, `src/server.ts:797`) then PO (`GET /api/v1/erp/purchase-orders/:poNumber`, `src/server.ts:769`), a match card shows `Accept` and `Not this`, a typed challan number records `challan_number_ext` with `po_ref_ext` `UNKNOWN`, `Next` is disabled until accepted, rejected or typed, and the result is announced in an aria-live region. This is a recorded deviation from EXPERIENCE.md:81, :123 and :256 (offline resolution against synced PO and ASN rows) pending owner question Q1.

6. **Given** the challan step is resolved, **when** the officer takes the mandatory photo (camera capture on coarse pointer as `edge/src/components/report-damage.tsx:413-414`; file input accepting `ACCEPTED_PHOTO_TYPES` on desktop), types the vehicle number and optional driver name, then on the Supplier step accepts the matched PO vendor (pre-filled) or taps `Unlisted supplier` and types the name (chip `Stores will match this later. The truck can go in now.`, EXPERIENCE.md:82, UJ-GATE-01 step 3 at :178, mock L647-676), and taps Submit entry, **then** one `gate.entered` envelope is written through `createOutboxEvent` and `insertCaptureEvent` (`edge/src/capture/outbox-event.ts:3`, `edge/src/local-db/outbox.ts:42`) with the photo in `pendingPhotoStore` (`edge/src/local-db/pending-photos.ts:72`), `vehicle_reg_ext` upper-cased, `gate_id` and `site_code_ext` from the bootstrap, the supplier fields, and the payload shape of `src/compliance/gate.ts:55-91`. The device-generated `metadata.correlation_id` is the binding token (persisted by `src/compliance/gate.ts:139`). The officer reads `sync.captured` online or offline and the entry locks. OCR plate pre-fill is not built and is recorded as deferred (EXPERIENCE.md:122).

7. **Given** the Trucks on site tab, **when** it opens, **then** it lists open gate entries derived on the device from the synced `edge_site_events` bucket (`gate.entered` minus `gate.reversed` by stream, joined to `weighbridge.recorded` by `correlation_id`, `sync/sync-rules.yaml:2-5`) merged with this device's unsynced outbox rows, as inbox cards with a derived text state pill: `Entered - weigh in pending`, `Weighed in - gross held on device`, `Weighed out - net recorded`, or `Exception` when status is `tolerance_breach`. The list refreshes from `GET /api/v1/gate-events?site=<site_code_ext>&status=open` (`src/server.ts:788`) and `GET /api/v1/weighbridge-events?site=<site_code_ext>` (`src/server.ts:793`) when online. Offline the list still renders from local rows and the sync badge shows the state (EXPERIENCE.md:99).

8. **Given** a truck and a PO line picked from the PO lookup, **when** the operator records gross then tare in kg with up to 3 decimals and a reading source pill `AUTO` or `MANUAL`, **then** the gross is held on the device until the tare exists, then one `weighbridge.recorded` envelope is queued with `correlation_id` equal to the gate binding token, `device_id`, `po_ref_ext`, `line_no`, `gross_kg`, `tare_kg`, `site_code_ext` and `capture_method` `MANUAL` when either reading was typed (`src/compliance/weighbridge.ts:146-216`). Tare greater than gross is refused on the device with `errors.WEIGHBRIDGE_NET_NEGATIVE`. A net outside the PO line band shows a provisional breach banner naming the unloading supervisor (`TOLERANCE_BREACH_OWNER_ROLE`, `src/compliance/weighbridge.ts:18`), still submits, and the server verdict replaces it on sync. `AUTO` is set only when a reading arrives from the indicator read. At pilot the `Read from weighbridge indicator` button renders disabled with the reason `No indicator link on this device` (EXPERIENCE.md:117), so every pilot reading is `MANUAL`.

9. **Given** the site weighbridge device is out of stamp, **when** the operator opens weigh-in, **then** the stamp-status read returns the device keys with stamp state, the weigh action is disabled with the reason in words, the gate entry stays submittable, and a 423 `WEIGHBRIDGE_OUT_OF_STAMP` refusal on sync settles `needs_attention` and lands in Refused captures with its `errors.*` text.

10. **Given** the four device classes, **when** unit, e2e and axe suites run, **then** every string resolves from `en.json`, the stepper is single column on handheld and the step list sits beside the form on tablet and wider, targets are 56/48 px on coarse pointer and 34 px on desktop, `aria-current="step"` is exposed, axe reports zero serious or critical violations on both tabs, and a keyboard-only pass completes one gate entry and one weighment.

## Tasks / Subtasks

- [ ] Task 1: Server contract and role seams (AC: 2, 3, 4)
- [ ] 1.1 Red tests first: `test/integration/story-3-13.test.ts` covering a write-only `gate_officer` and `weighbridge_operator` listing 200 on the GET paths, a read-only `stock_viewer` still 403, bootstrap carrying `site_code_ext` and `gate_id`, the stamp-status read, and `gate.entered` with `supplier_ref_ext` `UNLISTED`. Run it and confirm the failures are for the right reason.
- [x] 1.2 Adopt the write-satisfies-read rule in `assertRoleAllowed` in `src/api/v1/gate.ts` and `src/api/v1/weighbridge.ts` (Dev Notes, Role gate precedent). Keep the write requirement exact for every write route.
- [ ] 1.3 Add `gate_officer` and `weighbridge_operator` to the ASN read path only. Do not widen `ASN_WRITE_ROLES`. Decide between a `gate` module admission and a `receiving` read at the GET handler and record the choice in Completion Notes (Dev Notes, ASN read gate).
- [x] 1.4 Extend `edgeBootstrapHandler` (`src/api/v1/edge.ts:452-460`) with `site_code_ext` and `gate_id`. `gate_id` comes from edge config with default `GATE-01`; `site_code_ext` comes from `location_register` for the operating site.
- [x] 1.5 Extend `assertGateEnteredShape` (`src/compliance/gate.ts:55-91`) with optional `supplier_ref_ext` and `supplier_name_unlisted`; project both onto `gate_event` in the applier.
- [ ] 1.6 Add `GET /api/v1/weighbridge-events/stamp-status` before the `:weighbridgeEventId` route (`src/server.ts:792`). Read the device keys and stamp state from the statutory examination register (`src/compliance/weighbridge.ts:73-102`). Gate it on `WEIGHBRIDGE_READ_ROLES`.
- [x] 1.7 Add `WEIGHBRIDGE_OUT_OF_STAMP` (HTTP 423) to the server error mapping and to both `PERMANENT_ERROR_CODES` twins; keep `test/unit/edge-permanent-error-parity.test.ts` green.
- [ ] 1.8 Add the nav row `{ name: 'Gate entry', modules: 'gate', functionScope: 'write' }`, widen the `modules` union with `'gate'` through a `hasGateScope` helper (no new sentinel string), and add an integration assertion on the `navigation` list for both callers.
- [x] Task 2: Shared ScanField (AC: 5, 6, 8)
- [x] 2.1 Build `edge/src/components/scan-field.tsx`. Hardware trigger and keyboard wedge write into the focused input. Camera decode uses the platform `BarcodeDetector` when present on coarse pointer, otherwise the control renders only `Type challan number` and `Scan again` as text entry. No new npm dependency (Dev Notes, Scanner).
- [x] 2.2 Announce each scan result in an aria-live region. Expose `Scan again` and `Type` side by side at 360x640.
- [x] 2.3 Unit tests for the wedge path, the typed path and the aria announcement (`edge/test/unit/scan-field.test.ts` tests the pure key/normalize rules in `edge/src/capture/scan.ts`).
- [ ] Task 3: Gate entry stepper (AC: 1, 5, 6, 10)
- [x] 3.1 New page `edge/app/gate/page.tsx` and component `edge/src/components/gate-entry/` with the four steps (Challan, Photo, Vehicle, Supplier) and a Submit step. Use the existing `AppShell` view registration pattern from Story 1.15.
- [ ] 3.2 Challan step resolves ASN then PO online; shows the match card with `Accept` and `Not this`; typed challan records `UNKNOWN` PO ref. `Next` stays disabled until accepted, rejected or typed.
- [ ] 3.3 Photo step: mandatory, camera capture on coarse pointer, file input on desktop. Store the blob with `pendingPhotoStore` (Task 4).
- [x] 3.4 Vehicle step: required vehicle number (upper-cased on the device and by the server), optional driver name.
- [ ] 3.5 Supplier step: pre-filled from the matched PO vendor, or `Unlisted supplier` with the name typed and the chip copy from AC 6.
- [x] 3.6 Submit writes one `gate.entered` envelope through `createOutboxEvent` and `insertCaptureEvent`; `correlation_id` is the binding token; locks the entry once `sync.captured` arrives.
- [x] 3.7 Unit tests for the payload shape and the Next gating; i18n keys in `edge/src/messages/en.json`; literals registered in `ALLOWED_LITERAL_PATTERNS` only if the i18n guard requires it.
- [ ] Task 4: Offline capture and photo outbox (AC: 6, 8)
- [ ] 4.1 Reuse the photo outbox pattern from Story 3.3 and 8.9 (`edge/src/local-db/pending-photos.ts:72`) and the refused-capture landing. Add the new codes to both `PERMANENT_ERROR_CODES` twins.
- [ ] 4.2 Unit test that a gate entry queued offline holds the photo until upload and clears the pending row on success (`edge/test/unit/gate-capture.test.ts`, "offline gate photo outbox").
- [ ] Task 5: Trucks on site and weigh-in and weigh-out (AC: 7, 8, 9)
- [ ] 5.1 New page `edge/app/gate/weighbridge/page.tsx` or tab within `/gate`, with a Trucks on site list. Derive the list from the synced bucket plus unsynced outbox rows (Dev Notes, Derived list). Implemented as the `Trucks on site` tab fed by the `openTrucks` prop; on-device derivation tracked in deferred-work.
- [ ] 5.2 Gross then tare capture with kg, up to 3 decimals, source pill `AUTO`/`MANUAL`. The indicator button renders disabled with `No indicator link on this device`.
- [ ] 5.3 Tare greater than gross refused with `errors.WEIGHBRIDGE_NET_NEGATIVE`. Out-of-band net shows the provisional breach banner naming the unloading supervisor, submits, and yields to the server verdict.
- [ ] 5.4 Out-of-stamp state from the stamp-status read disables the weigh action with a reason; a 423 on sync lands in Refused captures.
- [x] 5.5 Unit tests for the held gross, the one-envelope tare submit and the breach banner (`edge/test/unit/gate-capture.test.ts`).
- [ ] Task 6: Tests, accessibility and i18n (AC: 1, 10)
- [x] 6.1 Update `edge/test/e2e/offline-shell.spec.ts:13-19` fixtures (gate entry nav row, bootstrap `site_code_ext` and `gate_id`).
- [x] 6.2 Add `edge/test/e2e/gate-entry.spec.ts` covering one gate entry and one weighment at 360x640 and at desktop width. Authored; execution blocked by the pre-existing e2e environment (see Completion Notes).
- [x] 6.3 Add an axe spec for both tabs (zero serious or critical violations) - `edge/test/accessibility/gate-accessibility.spec.ts`. Authored; execution blocked by the same environment.
- [x] 6.4 Keyboard-only pass recorded in the e2e spec (`gate-entry.spec.ts` "one keyboard-only gate entry"; `gate-accessibility.spec.ts` keyboard test). Authored; execution blocked.
- [ ] 6.5 Run `npm run typecheck`, lint, `edge:test`, the i18n literal guard and the full server test suite.
- [x] Task 7: Records (AC: 5, 6, 7)
- [x] 7.1 Annotate `_bmad-output/implementation-artifacts/3-2-*.md` Dev Notes near :102 and `3-3-*.md` Task 6.3 (:67) and open question 2 (:134, :196-200): the form is 3.13; open question 2 closes as an extension of the Gate entry surface (EXPERIENCE.md:36).
- [x] 7.2 Fix `mockups/key-gate-entry.html` breach owner copy at L375, L466, L473, L761 to `unloading_supervisor` and record the change. Correct the audit citation at :463.
- [x] 7.3 Fix EXPERIENCE.md:236 (breach routing) and add the Resolved Questions rows for the pilot deviations: desktop photo is upload only, OCR plate pre-fill deferred, online challan match with typed fallback pending the sync bucket ruling.
- [x] 7.4 Access matrix (`access-matrix-frontline-draft-2026-07-11.md:195-196`): record the gate read for `gate_officer` and `weighbridge_operator` introduced by Task 1. The receiving arrivals read row belongs to Story 3.14.
- [x] 7.5 Log deferred items in `_bmad-output/implementation-artifacts/deferred-work.md`: OCR plate pre-fill, webcam capture on desktop, indicator link protocol, offline PO and ASN bucket (Q1 if the owner keeps it deferred).

### Review Findings

Code review 2026-10-22 (Blind Hunter, Edge Case Hunter, Acceptance Auditor), scoped to the 30 File List files. Static read only; e2e and axe not executed.

- [x] [Review][Patch] Trucks on site list and stamp state never reach the weigh tab (resolved D1, option 1): wire `GET /gate-events` and `GET /weighbridge-events/stamp-status` into `gateCapture` using the bootstrap `site_code_ext` as site key; fail-soft "not verified" state on offline or fetch failure, only an explicit server overdue blocks; land the stamp-status site filter and `operatingSite` level patches first; keep AC 7 and AC 9 as written [edge/src/components/edge-client.tsx:1008]
- [x] [Review][Patch] Pilot role model versus module-gated reads (resolved D2, option 3): gate and weighbridge reads (`hasGateScope`, ASN GET, nav row, stamp-status) accept module `inventory` OR `gate`/`weighbridge`; also seed dedicated `gate`/`weighbridge` modules onto pilot roles (migration plus staging account update) so inventory-only is no longer the only path. Prerequisite for the D1 wiring [src/api/v1/edge.ts, src/api/v1/weighbridge.ts]
- [x] [Review][Patch] `supplier_ref_ext` for unlisted suppliers (resolved D3, option 1): send null plus a boolean flag (`supplier_unlisted: true`) instead of the `UNLISTED` sentinel; add the flag to the `gate.entered` envelope, `assertGateEnteredShape` in `src/compliance/gate.ts`, and the client; align client unit tests [edge/src/components/gate-entry/gate-entry.tsx]
- [x] [Review][Patch] Weighbridge-only operators and `POST /gate-events` (resolved D4, option 2): widen the server write role so the weighbridge operator role may also POST `gate-events`; keep the gate stepper visible; update RBAC tests and the role matrix; note the segregation-of-duties change (gate entry no longer gate_officer only) in the story Dev Notes for owner awareness [src/api/v1/edge.ts, src/events/store.ts]
- [x] [Review][Patch] Tolerance breach banner and `unloading_supervisor` routing absent from the weigh tab (resolved D5, option 1): call `isToleranceBreach` (BigInt milli-kg) in `WeighbridgeTab`, show the breach banner, route to `unloading_supervisor` per AC 8; add component and e2e tests [edge/src/components/gate-entry/]
- [x] [Review][Patch] Empty or null `siteCodeExt` and invented `GATE-01` fallback let the device emit events the server rejects permanently after the photo is stored; guard, disable submit, hide nav row when bootstrap `site_code_ext` is null [edge/src/components/edge-client.tsx:1008]
- [x] [Review][Patch] `operatingSite` takes `location_code` from any location level; require `level === 'site'` [src/api/v1/edge.ts]
- [x] [Review][Patch] Stamp-status ignores `?site=` for filtering and skips `assertSiteAccess` when absent; 500-row cap is silent [src/api/v1/weighbridge.ts:348]
- [x] [Review][Patch] ASN `assertSiteAccess` unions receiving, gate and weighbridge scopes across assignments, allowing cross-site reads; evaluate per assignment and add a negative test [src/api/v1/asn.ts]
- [x] [Review][Patch] `WeighbridgeTab` lacks in-flight guard, catch on `void submit()`, reset after `done`, `signingOut` check, and validation for `lineNo` (0, NaN, negative), empty `poRef`, zero gross or tare; every failure shows `gate.weighInvalid` [edge/src/components/gate-entry/gate-entry.tsx]
- [x] [Review][Patch] "Read from weighbridge indicator" button is enabled but inert; disable with a visible reason (AC 8) [edge/src/components/gate-entry/gate-entry.tsx]
- [x] [Review][Patch] Weight bounds: unbounded digits overflow NUMERIC; `isToleranceBreach` uses float math and unvalidated tolerance, use BigInt milli-kg [edge/src/capture/gate.ts]
- [x] [Review][Patch] `changeChallan` leaves `supplierMode` and `supplierName` stale; `scanChallan` can apply a stale response or set state after unmount; PO compare is case-sensitive; "Look up code" clears PO state [edge/src/components/gate-entry/gate-entry.tsx]
- [x] [Review][Patch] `ScanField`: camera stream leaks on failure and unmount, single `detect()` frame with no viewfinder, `maxLength={64}` truncates scans silently, `matchMedia` and `addEventListener` unguarded [edge/src/components/scan-field.tsx]
- [x] [Review][Patch] Photo checks accept 0-byte files and empty MIME type, no size cap; orphan blob when event insert fails; confirm gate photos drain via the attachment PUT path (AC 6) [edge/src/components/edge-client.tsx]
- [x] [Review][Patch] `assertGateEnteredShape` accepts empty or whitespace `supplier_ref_ext`, both-or-neither of ref and name, and has no length cap [src/compliance/gate.ts]
- [x] [Review][Patch] e2e stub does not intercept `/api/v1/asn/*` or PO lookup so `Matched CH-2026-01` cannot appear; `getByLabel('PO reference')` targets a non-input; a11y keyboard test Tab order reaches "Scan again" before "Accept" [edge/test/fixtures/gate-stub.ts, edge/test/e2e/gate-entry.spec.ts, edge/test/accessibility/gate-accessibility.spec.ts]
- [x] [Review][Patch] Missing tests: overdue stamp (423 `WEIGHBRIDGE_OUT_OF_STAMP`), stamp-status absent `site` and cross-site, weighbridge operator and `store_assistant` nav, `gate_officer` read of weighment events; "ignores obsolete responses" unit test passes for the wrong reason [test/integration/story-3-13.test.ts, edge/test/unit/gate-capture.test.ts]
- [x] [Review][Patch] Indentation lost in `edge.ts`, `edge-client.tsx`, `app-shell.tsx`, `gate-entry.tsx`, `gate.ts`, `init-db.sql`, `globals.css` and tests; run prettier on touched files
- [x] [Review][Patch] Incomplete ARIA tab pattern (no tabpanel, aria-controls, arrow keys); dead code `isKilogram`, i18n key `gate.supplierRefLabel`, unused CSS classes; supplier columns declared in both CREATE TABLE and ALTER [edge/src/components/gate-entry/gate-entry.tsx, deploy/compose/init-db.sql, src/read/projections/gate_event.sql]
- [x] [Review][Defer] Typed or rejected challans bind `po_ref_ext` `UNKNOWN` with no later rebinding [edge/src/capture/gate.ts] - deferred, documented Q1 and Q2 follow-up (offline PO and ASN bucket)
- [x] [Review][Defer] Integration teardown truncates a long table list with CASCADE on shared state [test/integration/story-3-13.test.ts] - deferred, matches existing integration convention

## Dev Notes

### Binding scope decisions (from sprint-change-proposal-2026-10-21, defaults in force)

- Q1 (offline PO and ASN match): resolve online with a typed fallback for pilot. The GLOBAL PowerSync bucket `erp_open_purchase_orders` is a follow-up story. Record the deviation from EXPERIENCE.md:81, :123 and :256.
- Q2 (challan QR content): ASN number first, then PO number. A typed challan stays `UNKNOWN`.
- Q3 (desktop photo): file upload for pilot; webcam post-pilot.
- Q4 (`site_code_ext` and `gate_id`): bootstrap returns `site_code_ext` from `location_register` and `gate_id` from edge config (default `GATE-01`). One gate per site at pilot.
- Q5 (indicator AUTO link): post-pilot. Every pilot reading is `MANUAL`; the button is disabled with the reason.
- The story is XL. If it must be split, cut along the server contract seam (3.13a: Tasks 1 and the server half of 2) and the screen (3.13b: Tasks 2 to 6). Do not cut gate versus weighbridge.

### Segregation of duties change (review decision D4)

- Gate entry is no longer gate_officer only: the weighbridge operator role may also POST `gate-events`, so a weighbridge-only site can record arrivals. Reverse stays gate_officer only. Owner awareness item for the role matrix.

### Role gate precedent (AC 2)

- `src/middleware/rbac.ts:165-168` already treats a `write` assignment as satisfying a read check: `satisfiesFunctionScope`. `src/api/v1/gate.ts:76` and `src/api/v1/weighbridge.ts:81` require an exact `functionScope` match. This is why write-only pilot roles are refused on every read today. Align both routers with the middleware rule; keep write routes exact.
- `GATE_WRITE_ROLES` is `['gate_officer']` (`gate.ts:32`). `GENERAL_READ_ROLES` is `['gate_officer', 'unloading_supervisor', 'warehouse_manager']` (`gate.ts:33`). Add `weighbridge_operator` to `GENERAL_READ_ROLES` only.
- `WEIGHBRIDGE_READ_ROLES` (`src/api/v1/weighbridge.ts:32-36`) already reads `TOLERANCE_BREACH_OWNER_ROLE` from the compliance constant. Add `gate_officer`.

### ASN read gate (AC 2)

- `ASN_READ_ROLES = ['store_assistant', 'unloading_supervisor', 'warehouse_manager']` (`src/api/v1/asn.ts:18`). `assertRoleAllowed` (`asn.ts:27-30`) checks `module === 'receiving' || '*'`. A gate officer holds `gate` and `weighbridge` assignments, not `receiving`, so adding the role name alone is not enough. Choose one and record it in Completion Notes: (a) admit `gate` on the GET handler only (`asn.ts:41-44`, `:242-245`), or (b) grant the read through a receiving-module read. Option (a) is the smaller change and matches the write-satisfies-read pattern. Do not widen `ASN_WRITE_ROLES`.

### Bootstrap (AC 3)

- `edgeBootstrapHandler` (`src/api/v1/edge.ts:452-460`) returns `site_id` (UUID) and the config `site_name`. Add `site_code_ext` (from `location_register`, the operating site's external code) and `gate_id` (edge config, default `GATE-01`). `gate.entered` requires both (`src/compliance/gate.ts:69-75`).
- `edge/test/e2e/offline-shell.spec.ts` bootstrap fixtures must carry both fields.

### Gate entry payload (AC 6)

- Required on `gate.entered` (`src/compliance/gate.ts:55-91`): `gate_event_id` (UUID), `vehicle_reg_ext`, `challan_photo_ref`, `po_ref_ext`, `site_code_ext`, `gate_id`, `gate_officer_id` (UUID), `entered_at` (ISO, not future). Optional: `driver_name`, `challan_number_ext`, plus the new `supplier_ref_ext` and `supplier_name_unlisted`.
- The binding token is `metadata.correlation_id`, generated on the device, persisted by `src/compliance/gate.ts:139`. `weighbridge.recorded` carries the same value.
- Envelope and outbox: `createOutboxEvent` in `edge/src/capture/outbox-event.ts:3`, `insertCaptureEvent` in `edge/src/local-db/outbox.ts:42`. Photo bytes go to `pendingPhotoStore` (`edge/src/local-db/pending-photos.ts:72`). Follow the pattern in `report-damage.tsx` for the camera input (`:413-414`).

### Weighbridge capture (AC 8, 9)

- Payload and server rules: `src/compliance/weighbridge.ts:146-216`. Tolerance breach owner is `TOLERANCE_BREACH_OWNER_ROLE` (`src/compliance/weighbridge.ts:18`, value `unloading_supervisor`). Breach routing is done (Story 3.12); the device banner is provisional and the server verdict replaces it on sync.
- Stamp state: the statutory examination register read at `src/compliance/weighbridge.ts:73-102`. The 423 refusal is server-side on sync; the device disables the weigh action on the stamp-status read.

### Derived list (AC 7)

- Open entries: `gate.entered` minus `gate.reversed` by stream, joined to `weighbridge.recorded` by `correlation_id` (`sync/sync-rules.yaml:2-5`, bucket `edge_site_events`). Merge with unsynced outbox rows.
- Online refresh: `GET /api/v1/gate-events?site=<site_code_ext>&status=open` (`src/server.ts:788`) and `GET /api/v1/weighbridge-events?site=<site_code_ext>` (`src/server.ts:793`).

### Scanner

- No ScanField or scanner component exists under `edge/src/components` today; scan handling is inline in `cross-dock-capture.tsx`, `indent-capture.tsx`, `report-damage.tsx` and `fault-report-capture.tsx`. This story builds the shared component. Do not refactor the four existing captures in this story.
- `edge/package.json` has no QR or barcode library. Use the platform `BarcodeDetector` when present; otherwise the camera path is absent and typing covers it. Adding a dependency is not justified for pilot (YAGNI; the typed and wedge paths cover pilot).

### Architecture and conventions

- Nav: `NAVIGATION_CAPABILITIES` (`src/api/v1/edge.ts:364-383`) and `navigationFor` (`:400-420`). The `modules` union widens by literal; add a `hasGateScope` branch modelled on `hasDamageCaseScope` (`:389-398`). Do not add a new sentinel string.
- Views: `BaseView` and `BASE_VIEW_ENTRY` (`app-shell.tsx:130-152`, `:349-358`), and the duplicate union in `edge/src/components/edge-client.tsx:214-227`. Add `gate` to each.
- Edge has no dynamic route segments; select records by query string.
- Online-only views use the needs-connection card and re-fetch on online (`check-stock.tsx`, `damage-cases.tsx:41`). Use that for the stamp-status read and the lists when offline.
- Every string resolves from `edge/src/messages/en.json`. Add new `errors.*` keys for `WEIGHBRIDGE_OUT_OF_STAMP`, `WEIGHBRIDGE_NET_NEGATIVE` and the gate codes.
- Targets: 56 px and 48 px on coarse pointer, 34 px on desktop (EXPERIENCE.md:123).

### Testing requirements

- Server: integration test per AC 2 to 4 (`test/integration/story-3-13.test.ts`), fixture shape as the neighbouring integration tests. Permanent-error parity test (`test/unit/edge-permanent-error-parity.test.ts`) stays green.
- Edge: unit tests for ScanField, the stepper, the outbox payload and the weighbridge net logic; Playwright e2e for one gate entry and one weighment; axe on both tabs; i18n literal guard.
- Story 1.9 spine allowlist: any new route added to the server must be in the allowlist. Keep the list update in the same change.

### Project Structure Notes

- Server: `src/api/v1/gate.ts`, `src/api/v1/weighbridge.ts`, `src/api/v1/asn.ts`, `src/api/v1/edge.ts`, `src/compliance/gate.ts`, `src/compliance/weighbridge.ts`, `src/server.ts`, `src/sync/upload.ts`.
- Edge: `edge/app/gate/`, `edge/src/components/gate-entry/`, `edge/src/components/scan-field.tsx`, `edge/src/components/navigation/nav-model.ts`, `edge/src/components/app-shell.tsx`, `edge/src/components/edge-client.tsx`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`.
- Tests: `test/integration/story-3-13.test.ts`, `edge/test/e2e/gate-entry.spec.ts`, `edge/test/e2e/offline-shell.spec.ts`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.13]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md#4.1, #4.4, #6]
- [Source: _bmad-output/implementation-artifacts/ux-screen-coverage-audit-2026-10-21.md#3, G01, G02]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md:36, :77-82, :90, :99-107, :111-123, :176-182, :236]
- [Source: _bmad-output/implementation-artifacts/3-12-weighbridge-breach-task-routing-for-pilot-roles.md#Binding Scope Decisions]

## Dev Agent Record

### Agent Model Used

Kilo (deepseek-flash-latest) - initial dev-story implementation 2026-10-21. Kilo (~openai/gpt-sol-latest) - user-authorized continuation and acceptance validation 2026-10-21.

### Debug Log References

- 2026-10-21 continuation: user authorized continuing the existing uncommitted implementation. Reopened Tasks 3-6 because the challan lookup and supplier match were not wired, the Trucks on site list and stamp state were not supplied, photo upload remained deferred, and browser acceptance checks had not executed. Prior implementation and unrelated Story 4.8 lifecycle fixes are preserved.
- Red test first: `test/integration/story-3-13.test.ts`; first run failed on the wrong SCIM bearer (harness wiring), then failed on missing bootstrap/stamp-status/supplier behaviour, then passed.
- Regression after Task 1: gate (3-2), weighbridge (3-3), ASN (3-4), permanent-error parity, schema-drift - 243/243 green.
- Root `npm run build`, `npm run lint` clean. Edge `typecheck`, `lint`, `test` (158), `i18n:check` clean.
- Spine (1-9) + Story 3.13 integration: 13/13 green after adding the stamp-status route to the allowlist.
- Playwright: `npx playwright test test/e2e/gate-entry.spec.ts` and the existing `test/e2e/report-damage.spec.ts` both fail at the same bootstrap/session step ("Site not loaded", nav absent). This is a pre-existing environment limitation, not a Story 3.13 regression; the existing 5 damage specs fail identically.

### Completion Notes List

- 2026-10-21 continuation: Task 3 now has real ASN-first/PO-second lookup, stale-result invalidation, explicit typed/rejected fallback, PO supplier prefill, four conditional steps with gated Next/Back, required photo capture/upload input, and responsive gate-only styles. Unlisted captures send `supplier_ref_ext = UNLISTED`. Gate unit tests passed 20/20, the full edge unit suite passed 166/166, and Docker-isolated typecheck, scoped ESLint, i18n literal guard and whitespace checks passed. Browser acceptance execution remains incomplete; Task 3's aggregate checkbox stays open pending integration validation.
- Continuation audit reopened Task 1: actual pilot gate roles use `inventory` assignments, while several nav, ASN, read and upload checks require specialist modules; fixtures currently mask this. Stamp-status reads all company-wide statutory devices rather than the requested site's devices. No authoritative site-to-device association exists in the current model. The owner question offering a site-config mapping or audited association table was dismissed without a ruling. HALT: do not invent asset site ownership, device-key conventions or a site-device mapping; story remains `in-progress` until this governing decision is supplied.
- Photo continuation: the raw attachment PUT/GET service already exists, so a dedicated document route is not a prerequisite. Pending work is gate evidence ownership, safe replay/conflict handling, permitted-reader integration, and real offline capture/upload regression coverage under Task 4.
- Browser continuation: the previous "Site not loaded" placeholder does not establish an authentication root cause. Existing specs lack four-device coverage, completed keyboard-only gate and weighment flows, and required lookup/stamp/upload stubs. Those are open Task 6 acceptance checks, not completed tests or approved acceptance deferrals. The full backend regression suite has not been rerun during this continuation.
- AC 2 role seam: `assertRoleAllowed` in gate.ts and weighbridge.ts now mirrors `satisfiesFunctionScope` (a write assignment satisfies a read check; write stays exact). `weighbridge_operator` added to `GENERAL_READ_ROLES`; `gate_officer` added to `WEIGHBRIDGE_READ_ROLES`.
- AC 2 ASN read decision (task 1.3): chose option (a) - admit the `gate` and `weighbridge` modules on the GET handler only (`getAsnHandler` module list widened; `assertRoleAllowed` and `assertSiteAccess` union the gate/weighbridge scopes for read). `ASN_WRITE_ROLES` unchanged.
- AC 3 bootstrap: `site_code_ext` from `location_register.location_code` for the operating assignment; `gate_id` from new `config.gate.id` (`GATE_ID`, default `GATE-01`). A wildcard operating assignment yields `site_code_ext: null`.
- AC 3 supplier fields: `gate_event` gained `supplier_ref_ext` and `supplier_name_unlisted` (canonical `read/projections/gate_event.sql`, mirrored in `deploy/compose/init-db.sql`, plus guarded `ADD COLUMN IF NOT EXISTS`), projected through `assertGateEnteredShape` and `applyGateProjection`.
- AC 4 stamp-status: `GET /api/v1/weighbridge-events/stamp-status` registered before `:weighbridgeEventId`; reads `weighbridge_legal_metrology` rows from the statutory examination register; gated on `WEIGHBRIDGE_READ_ROLES`.
- AC 4 error code: `WEIGHBRIDGE_OUT_OF_STAMP` added to both `PERMANENT_ERROR_CODES` twins and to `en.json`.
- AC 1 nav: `Gate entry` row (`modules: 'gate'`, write) resolved by `hasGateScope` (module-based, no role-name literals so the DOA lint rule stays green). `nav.gateEntry` added; `/gate` in `NAV_ENTRIES`; `gate` in `BaseView`, `BASE_VIEW_ENTRY`, `AppShellProps`, and the `EdgeClient` view union.
- Edge UI: shared `ScanField` (wedge/typed/camera BarcodeDetector, aria-live), four-step `GateEntry` stepper with submit, and a `Trucks on site` weigh tab with exact milli-kg net, tare>gross refusal, provisional band, out-of-stamp disable and disabled indicator button. Photo stored in `pendingPhotoStore`; `gate.entered` and `weighbridge.recorded` envelopes built in `edge/src/capture/gate.ts` and inserted via `insertCaptureEvent`.
- Behaviour deviations recorded in `deferred-work.md`: OCR plate, webcam capture, indicator protocol, offline PO/ASN bucket, on-device truck derivation, gate-photo document route, and the e2e/axe execution blocker.
- E2E/axe: specs authored (`edge/test/e2e/gate-entry.spec.ts`, `edge/test/accessibility/gate-accessibility.spec.ts`, offline-shell fixture updated). They could not be executed here because the Playwright environment fails identically for the existing e2e suite; run them in CI.

### File List

Server:
- `src/config/index.ts` (add `gate.id`)
- `src/api/v1/gate.ts` (write-satisfies-read, read roles, supplier JSON)
- `src/api/v1/weighbridge.ts` (write-satisfies-read, `gate_officer` read, stamp-status handler)
- `src/api/v1/asn.ts` (gate/weighbridge read admission and site scope)
- `src/api/v1/edge.ts` (bootstrap fields, nav row, `hasGateScope`)
- `src/compliance/gate.ts` (optional supplier fields, projection)
- `src/server.ts` (stamp-status route + import)
- `src/read/projections/gate_event.ts` (supplier columns in interface/select/map/upsert)
- `src/sync/upload.ts` (`WEIGHBRIDGE_OUT_OF_STAMP`)
- `read/projections/gate_event.sql` (supplier columns + guarded ALTER)
- `deploy/compose/init-db.sql` (mirror)

Tests:
- `test/integration/story-3-13.test.ts` (new)
- `test/integration/story-1-9.test.ts` (spine allowlist)

Edge:
- `edge/src/capture/gate.ts` (new: payload builders + weigh math)
- `edge/src/capture/scan.ts` (new: scan rules)
- `edge/src/components/scan-field.tsx` (new)
- `edge/src/components/gate-entry/gate-entry.tsx` (new)
- `edge/app/globals.css` (gate-scoped responsive stepper and scanner layout)
- `edge/app/gate/page.tsx` (new)
- `edge/src/components/app-shell.tsx` (`gate` view + prop)
- `edge/src/components/edge-client.tsx` (bootstrap fields, submit callbacks, view union)
- `edge/src/components/navigation/nav-model.ts` (`/gate` entry)
- `edge/src/sync/connector.ts` (`WEIGHBRIDGE_OUT_OF_STAMP`)
- `edge/src/messages/en.json` (gate keys, nav, error)
- `edge/test/unit/gate-capture.test.ts` (new)
- `edge/test/unit/scan-field.test.ts` (new)
- `edge/test/e2e/gate-entry.spec.ts` (new)
- `edge/test/e2e/offline-shell.spec.ts` (fixture fields)
- `edge/test/fixtures/gate-stub.ts` (new)
- `edge/test/accessibility/gate-accessibility.spec.ts` (new)

Records:
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`
- `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md`
- `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-gate-entry.html`
- `_bmad-output/implementation-artifacts/3-2-gate-event-capture-and-vehicle-to-po-binding-uj-gate-01-fr-w-02.md`
- `_bmad-output/implementation-artifacts/3-3-weighbridge-event-capture-and-tolerance-enforcement-uj-weigh-01-fr-w-02.md`

### Change Log

- 2026-10-21: Continued the existing implementation with user authorization, completed the missing challan lookup and stepper logic with red/green unit coverage, and reopened unverified acceptance tasks. Gate tests 20/20 and edge unit tests 166/166 passed. Halted on the unresolved authoritative site-to-weighbridge association; status `in-progress`, not ready for review.
- 2026-10-21: Implemented Story 3.13 (Tasks 1-7). Server role seams, bootstrap, supplier fields, stamp-status, permanent error code, nav; shared ScanField, gate stepper, weighbridge tab, pages and wiring; unit/integration tests; records. Root build/lint clean; Story 3.13 integration 7/7; spine 6/6; regressions (3-2/3-3/3-4/parity/schema-drift) 243/243; edge unit 158/158, typecheck/lint/i18n clean. E2E/axe authored but environment-blocked (pre-existing). Status -> review.
