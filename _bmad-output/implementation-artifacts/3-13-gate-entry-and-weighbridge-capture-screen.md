---
baseline_commit: 4f37d32
---
# Story 3.13: Gate Entry and Weighbridge Capture Screen

Status: ready-for-dev

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
  - [ ] 1.2 Adopt the write-satisfies-read rule in `assertRoleAllowed` in `src/api/v1/gate.ts` and `src/api/v1/weighbridge.ts` (Dev Notes, Role gate precedent). Keep the write requirement exact for every write route.
  - [ ] 1.3 Add `gate_officer` and `weighbridge_operator` to the ASN read path only. Do not widen `ASN_WRITE_ROLES`. Decide between a `gate` module admission and a `receiving` read at the GET handler and record the choice in Completion Notes (Dev Notes, ASN read gate).
  - [ ] 1.4 Extend `edgeBootstrapHandler` (`src/api/v1/edge.ts:452-460`) with `site_code_ext` and `gate_id`. `gate_id` comes from edge config with default `GATE-01`; `site_code_ext` comes from `location_register` for the operating site.
  - [ ] 1.5 Extend `assertGateEnteredShape` (`src/compliance/gate.ts:55-91`) with optional `supplier_ref_ext` and `supplier_name_unlisted`; project both onto `gate_event` in the applier.
  - [ ] 1.6 Add `GET /api/v1/weighbridge-events/stamp-status` before the `:weighbridgeEventId` route (`src/server.ts:792`). Read the device keys and stamp state from the statutory examination register (`src/compliance/weighbridge.ts:73-102`). Gate it on `WEIGHBRIDGE_READ_ROLES`.
  - [ ] 1.7 Add `WEIGHBRIDGE_OUT_OF_STAMP` (HTTP 423) to the server error mapping and to both `PERMANENT_ERROR_CODES` twins; keep `test/unit/edge-permanent-error-parity.test.ts` green.
  - [ ] 1.8 Add the nav row `{ name: 'Gate entry', modules: 'gate', functionScope: 'write' }`, widen the `modules` union with `'gate'` through a `hasGateScope` helper (no new sentinel string), and add an integration assertion on the `navigation` list for both callers.
- [ ] Task 2: Shared ScanField (AC: 5, 6, 8)
  - [ ] 2.1 Build `edge/src/components/scan-field.tsx`. Hardware trigger and keyboard wedge write into the focused input. Camera decode uses the platform `BarcodeDetector` when present on coarse pointer, otherwise the control renders only `Type challan number` and `Scan again` as text entry. No new npm dependency (Dev Notes, Scanner).
  - [ ] 2.2 Announce each scan result in an aria-live region. Expose `Scan again` and `Type` side by side at 360x640.
  - [ ] 2.3 Unit tests for the wedge path, the typed path and the aria announcement.
- [ ] Task 3: Gate entry stepper (AC: 1, 5, 6, 10)
  - [ ] 3.1 New page `edge/app/gate/page.tsx` and component `edge/src/components/gate-entry/` with the four steps (Challan, Photo, Vehicle, Supplier) and a Submit step. Use the existing `AppShell` view registration pattern from Story 1.15.
  - [ ] 3.2 Challan step resolves ASN then PO online; shows the match card with `Accept` and `Not this`; typed challan records `UNKNOWN` PO ref. `Next` stays disabled until accepted, rejected or typed.
  - [ ] 3.3 Photo step: mandatory, camera capture on coarse pointer, file input on desktop. Store the blob with `pendingPhotoStore` (Task 4).
  - [ ] 3.4 Vehicle step: required vehicle number (upper-cased on the device and by the server), optional driver name.
  - [ ] 3.5 Supplier step: pre-filled from the matched PO vendor, or `Unlisted supplier` with the name typed and the chip copy from AC 6.
  - [ ] 3.6 Submit writes one `gate.entered` envelope through `createOutboxEvent` and `insertCaptureEvent`; `correlation_id` is the binding token; locks the entry once `sync.captured` arrives.
  - [ ] 3.7 Unit tests for the payload shape and the Next gating; i18n keys in `edge/src/messages/en.json`; literals registered in `ALLOWED_LITERAL_PATTERNS` only if the i18n guard requires it.
- [ ] Task 4: Offline capture and photo outbox (AC: 6, 8)
  - [ ] 4.1 Reuse the photo outbox pattern from Story 3.3 and 8.9 (`edge/src/local-db/pending-photos.ts:72`) and the refused-capture landing. Add the new codes to both `PERMANENT_ERROR_CODES` twins.
  - [ ] 4.2 Unit test that a gate entry queued offline holds the photo until upload and clears the pending row on success.
- [ ] Task 5: Trucks on site and weigh-in and weigh-out (AC: 7, 8, 9)
  - [ ] 5.1 New page `edge/app/gate/weighbridge/page.tsx` or tab within `/gate`, with a Trucks on site list. Derive the list from the synced bucket plus unsynced outbox rows (Dev Notes, Derived list).
  - [ ] 5.2 Gross then tare capture with kg, up to 3 decimals, source pill `AUTO`/`MANUAL`. The indicator button renders disabled with `No indicator link on this device`.
  - [ ] 5.3 Tare greater than gross refused with `errors.WEIGHBRIDGE_NET_NEGATIVE`. Out-of-band net shows the provisional breach banner naming the unloading supervisor, submits, and yields to the server verdict.
  - [ ] 5.4 Out-of-stamp state from the stamp-status read disables the weigh action with a reason; a 423 on sync lands in Refused captures.
  - [ ] 5.5 Unit tests for the held gross, the one-envelope tare submit and the breach banner.
- [ ] Task 6: Tests, accessibility and i18n (AC: 1, 10)
  - [ ] 6.1 Update `edge/test/e2e/offline-shell.spec.ts:13-19` fixtures (gate entry nav row, bootstrap `site_code_ext` and `gate_id`).
  - [ ] 6.2 Add `edge/test/e2e/gate-entry.spec.ts` covering one gate entry and one weighment at 360x640 and at desktop width.
  - [ ] 6.3 Add an axe spec for both tabs (zero serious or critical violations).
  - [ ] 6.4 Keyboard-only pass recorded in the e2e spec.
  - [ ] 6.5 Run `npm run typecheck`, lint, `edge:test`, the i18n literal guard and the full server test suite.
- [ ] Task 7: Records (AC: 5, 6, 7)
  - [ ] 7.1 Annotate `_bmad-output/implementation-artifacts/3-2-*.md` Dev Notes near :102 and `3-3-*.md` Task 6.3 (:67) and open question 2 (:134, :196-200): the form is 3.13; open question 2 closes as an extension of the Gate entry surface (EXPERIENCE.md:36).
  - [ ] 7.2 Fix `mockups/key-gate-entry.html` breach owner copy at L375, L466, L473, L761 to `unloading_supervisor` and record the change. Correct the audit citation at :463.
  - [ ] 7.3 Fix EXPERIENCE.md:236 (breach routing) and add the Resolved Questions rows for the pilot deviations: desktop photo is upload only, OCR plate pre-fill deferred, online challan match with typed fallback pending the sync bucket ruling.
  - [ ] 7.4 Access matrix (`access-matrix-frontline-draft-2026-07-11.md:195-196`): record the gate read for `gate_officer` and `weighbridge_operator` introduced by Task 1. The receiving arrivals read row belongs to Story 3.14.
  - [ ] 7.5 Log deferred items in `_bmad-output/implementation-artifacts/deferred-work.md`: OCR plate pre-fill, webcam capture on desktop, indicator link protocol, offline PO and ASN bucket (Q1 if the owner keeps it deferred).

## Dev Notes

### Binding scope decisions (from sprint-change-proposal-2026-10-21, defaults in force)

- Q1 (offline PO and ASN match): resolve online with a typed fallback for pilot. The GLOBAL PowerSync bucket `erp_open_purchase_orders` is a follow-up story. Record the deviation from EXPERIENCE.md:81, :123 and :256.
- Q2 (challan QR content): ASN number first, then PO number. A typed challan stays `UNKNOWN`.
- Q3 (desktop photo): file upload for pilot; webcam post-pilot.
- Q4 (`site_code_ext` and `gate_id`): bootstrap returns `site_code_ext` from `location_register` and `gate_id` from edge config (default `GATE-01`). One gate per site at pilot.
- Q5 (indicator AUTO link): post-pilot. Every pilot reading is `MANUAL`; the button is disabled with the reason.
- The story is XL. If it must be split, cut along the server contract seam (3.13a: Tasks 1 and the server half of 2) and the screen (3.13b: Tasks 2 to 6). Do not cut gate versus weighbridge.

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

Not yet run (story created 2026-10-21 by create-story)

### Debug Log References

### Completion Notes List

### File List
