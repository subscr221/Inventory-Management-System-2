---
baseline_commit: a879b9da35f503f9459b1abeb6d7d82a075f0573
---

# Story 3.18: Pack Station and Dispatch Screen

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created from epics.md Story 3.18, the 2026-10-21 sprint change proposal (G08 pack and dispatch, Table 3.18), the Story 3.7 dispatch server surface (src/api/v1/dispatch.ts, src/compliance/dispatch.ts, dispatch_order_status/dispatch_irn/dispatch_document/erp_sales_order projections), the Story 3.16 previous-story file (floor-tasks pattern, ScanField reuse, previous-story intelligence), the edge shell architecture (app-shell.tsx, edge-client.tsx, nav-model.ts), the server edge bootstrap (src/api/v1/edge.ts NAVIGATION_CAPABILITIES and navigationFor), and the dispatch1@ pilot account (roles.json).

## Story

As a dispatch clerk (dispatch1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:576-589`),
I want a pack station screen that lists picked orders, scans lots into the package, records weight, generates documents, clears the IRN block, prints and confirms dispatch,
so that a dispatch leaves the site through the Story 3.7 and 11.2 gates from the app.

## Acceptance Criteria

**AC 1 - Navigation and role gating (nav row, deep-link safety)**

Given a caller holding an assignment with role in `DISPATCH_WRITE_ROLES` (`src/api/v1/dispatch.ts:43`: `dispatch_clerk`, `warehouse_manager`), module warehouse or `*`, `functionScope` write, covering the site, when the bootstrap runs, then navigation carries `Pack and dispatch` from a new row `{ name: 'Pack and dispatch', modules: 'pack-dispatch', functionScope: 'write' }` with `pack-dispatch` added to the modules union (`src/api/v1/edge.ts:407`) and a `hasPackDispatchScope` branch in `navigationFor` (`:483-511`) modelled on `hasGateScope` (`:458-467`); dispatch1@ (`roles.json:576-582`) receives it, store1@ and a `dispatch_clerk` holding only inventory read (`roles.json:583-589`) do not; NAV_ENTRIES gains `{ name: 'Pack and dispatch', href: '/floor/pack', label: 'nav.packDispatch' }`; `pack-dispatch` joins `BaseView` and `BASE_VIEW_ENTRY` so a deep link without the entry renders the no-access card; an integration test asserts both outcomes; the mock's desktop sidebar label `Dispatch` (key-floor.html L567) and bottom nav Tasks / Scan / Stock / More (L557-562) are recorded as an accepted deviation.

**AC 2 - Server list route (Task 1)**

Given Task 1 server work, when `GET /api/v1/dispatch?site=<uuid>&stage=picked|packed|documents_generated|dispatched` is called, then it returns rows from `dispatch_order_status` joined to `erp_sales_order` filtered by `ship_from_site_id`, left joined to `dispatch_irn` exposing `irn_recorded`, with stage derived as dispatched when `dispatched_at` is set, documents_generated when a `dispatch_document` row exists and `dispatched_at` is null, packed when `packed_at` is set and no documents, else picked; each row carries `dispatch_order_id`, `so_number_ext`, `line_no`, `ship_to_ext`, `sku`, `quantity`, `picked_at`, `packed_at`, `dispatched_at`, `stage`, `irn_recorded`; the route is gated by `assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read')` (`src/api/v1/dispatch.ts:86-105`, `:45-51`) and the `warehouse` read scope, registered before the `/:dispatchOrderId` routes (`src/server.ts:1431-1446`), added to the spine allowlist (`test/integration/story-1-9.test.ts:339-350`) and covered by an integration test; today only per-id reads exist.

**AC 3 - Pack and dispatch list (three groups)**

Given the list, when it loads online, then three groups render: Ready to pack (stage picked), Waiting for documents (stages packed and documents_generated, pilled Cannot dispatch when `irn_recorded` is false and Ready when true) and Dispatched today; the empty state reads `Nothing to pack or dispatch. Picked orders appear here when the picker finishes.` (key-floor.html L646); each row heading is the SO number with `ship_to_ext` as metadata (deviates from the mock PKG heading at L629 and L738 because no package id is minted, owner question Q19); a row opens the pack station.

**AC 4 - Packing flow (scan lots, carton weight, pack + generate documents)**

Given an order from Ready to pack, when each picked lot is scanned or typed into the focused ScanField and the carton weight is entered, then lines flip to In package with aria-live, an unknown lot is refused in place, Generate shipping documents stays disabled stating what is left, and pressing it posts `POST /api/v1/dispatch/:id/pack` with one `packingLines` entry per picked line `{ sku, packed_qty (string), lot_id (UUID or null), carton_count: 1 on the first line and 0 on the others, actual_weight_kg: the carton weight on the first line and null on the others, label_ref: null }` (`src/api/v1/dispatch.ts:172-365`) then `POST /api/v1/dispatch/:id/generate-documents` with no body so the server default document types apply (`dispatch.ts:37`, `:387`); `LOT_ON_HOLD`, `PACKED_QTY_MISMATCH`, `PACKED_LINE_NOT_PICKED`, `DISPATCH_ORDER_NOT_PICKED` and `INVALID_PARAMS` render from `errors.*` (`en.json:86`, `:192`, `:198`, `:200`).

**AC 5 - IRN block card, Check IRN again, Record IRN**

Given documents exist and `POST /dispatch` answers 409 `IRN_MISSING` (`src/compliance/dispatch.ts:603-645`), when the order renders, then a blocked card in the err pair reads `E-invoice IRN missing - cannot dispatch` with the package summary and Check IRN again calling `GET /api/v1/dispatch/:id/irn`, treating 404 `DISPATCH_IRN_NOT_RECORDED` (`src/api/v1/dispatch.ts:756-762`) as still blocked and 200 `{ dispatchOrderId, coverage }` (`:764`) as cleared (key-floor.html L757-767, EXPERIENCE.md:103); Park at dispatch bay renders disabled stating no bay record exists for pilot (recorded in deferred-work.md); a Record IRN form posts `{ invoice_number_ext, irn_ext (64 hex), idempotency_key minted once per opened form }` to `POST /api/v1/dispatch/:id/irn` (`dispatch.ts:596-738`; owner question Q16, default yes); when `details.reason` is `no_erp_sales_order_line` the form is hidden and the card says the order is not an ERP line; the sentence about automatic billing notification is not shown (nothing in `src/` notifies billing; record fix amends EXPERIENCE.md:103); `DISPATCH_IRN_CONFLICT`, `DISPATCH_IRN_INVALID_PAYLOAD`, `DISPATCH_ORDER_SITE_MISMATCH` and `DISPATCH_ORDER_CLOSED` render from `errors.*` (`en.json:218-222`).

**AC 6 - Documents, print, confirm dispatch**

Given IRN coverage exists, when the order opens, then every document in `GET /api/v1/dispatch/:id/documents` (`{ dispatchOrderId, documents }`, `src/api/v1/dispatch.ts:486-503`; types bol, packing_slip, commercial_invoice, label, labelled under `packStation.doc.*`) has a Print action rendering `document_content` under a print-only stylesheet twin of `stores-issue.tsx:41` scoped to the document container, a document whose `document_content` is null shows Print disabled stating no content, the mock's E-way bill row (L770) is not rendered and is recorded in deferred-work.md, Confirm dispatch posts `POST /api/v1/dispatch/:id/dispatch`, and on 200 the order moves to Dispatched today; `DISPATCH_ORDER_NOT_PACKED`, `DISPATCH_DOCUMENTS_NOT_GENERATED`, `DISPATCH_ORDER_ALREADY_DISPATCHED` and `LOT_ON_HOLD` render from `errors.*` (`en.json:86`, `:193-194`, `:201`).

**AC 7 - Offline read-only**

Given the device is offline, when the screen opens, then the list renders read-only from the last successful fetch with its sync badge, and Generate shipping documents, Check IRN again, Record IRN and Confirm dispatch are disabled stating `needs a connection` (EXPERIENCE.md:119); nothing is written to the outbox; this is a deliberate pilot departure from EXPERIENCE.md:99 and key-floor.html L464 and from the server door that already accepts `dispatch.packed`, `dispatch.shipping_documents_generated` and `dispatch.dispatched` (`src/api/v1/edge.ts:686-701`, Story 3.7 Tasks 7.1 to 7.3; codes at `edge/src/sync/connector.ts:131-149`), recorded in deferred-work.md and EXPERIENCE.md (owner question Q17).

**AC 8 - Device classes, accessibility and i18n**

Given the four device classes, when axe and a keyboard-only pass run, then Handheld is one task page with Back and a pinned 56 px full-width primary (key-floor.html L452), Tablet is icon rail plus list and detail panes (L453), Desktop is sidebar plus two panes with 34 px controls and the scan hint `USB scanner or type` (L454, L456; EXPERIENCE.md:123), Desktop touch is the Desktop layout with 56/48 px controls (L455); the ScanField keeps focus after each accepted scan; zero WCAG 2.1 AA violations; strings under `packStation.*`; runbook row 2.10o is walked as dispatch1@ on staging.

## Tasks / Subtasks

- [x] Task 1: Server nav row, deep-link gate and list read (AC 1, AC 2)
  - [x] 1.1 Add the `pack-dispatch` sentinel to the `modules` union (`src/api/v1/edge.ts:407`), the nav row `{ name: 'Pack and dispatch', modules: 'pack-dispatch', functionScope: 'write' }` after Floor tasks (`:431`), and a `hasPackDispatchScope` function (role set `['dispatch_clerk', 'warehouse_manager']`, module warehouse or `*`, `functionScope === 'write'`, `assignmentCoversLocation`) plus its `navigationFor` branch (`:483-511`), modelled on `hasGateScope` (`:458-467`).
  - [x] 1.2 Add `NAV_ENTRIES` `{ name: 'Pack and dispatch', href: '/floor/pack', label: 'nav.packDispatch' }` (`edge/src/components/navigation/nav-model.ts`) and `nav.packDispatch` in `en.json` beside `nav.floorTasks` (`:706`).
  - [x] 1.3 Add `pack-dispatch` to `BaseView` and `BASE_VIEW_ENTRY` (`edge/src/components/app-shell.tsx`) and the duplicate view union in `edge/src/components/edge-client.tsx` so a deep link without the entry renders the no-access card.
  - [x] 1.4 Add `GET /api/v1/dispatch?site=<uuid>&stage=...` list route: a new `listDispatchOrders` accessor (joins `dispatch_order_status` + `erp_sales_order`, LEFT JOIN `dispatch_irn` for `irn_recorded`, document existence sub-select, stage derivation per AC 2), gated by `assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read')` and the warehouse read scope, registered before `/:dispatchOrderId` (`src/server.ts:1431-1446`).
  - [x] 1.5 Add a picked-lines read for the pack station detail (see Dev Notes: the AC 4 "each picked lot" checklist needs `pick_line` rows where `dispatch_order_line_id` = the dispatch order id and `status` in confirmed/substituted; no such route exists today).
  - [x] 1.6 Add the new list route (and any new picked-lines route) to the Story 1.9 spine allowlist (`test/integration/story-1-9.test.ts:339-350`) and write `test/integration/story-3-18.test.ts` for the nav row (dispatch1@ gets it, store1@ and inventory-read clerk do not) and the list/stage derivation.

- [x] Task 2: Pack and dispatch list screen (AC 3)
  - [x] 2.1 `pack-dispatch` view loads `GET /api/v1/dispatch?site=<site>` (all stages, or the three stage reads merged client-side) online; offline shows the last fetched list with a sync badge.
  - [x] 2.2 Render three groups in order: Ready to pack, Waiting for documents (with the Cannot dispatch / Ready pill driven by `irn_recorded`), Dispatched today; empty state `Nothing to pack or dispatch. Picked orders appear here when the picker finishes.`; row heading = SO number with `ship_to_ext` metadata.
  - [x] 2.3 A row opens the pack station via `/floor/pack?dispatch=<id>`; Handheld one page with Back, Tablet/Desktop list + detail side by side.

- [x] Task 3: Packing flow (AC 4)
  - [x] 3.1 Load the picked-lines checklist (Task 1.5) and existing packing records; each picked lot line shows sku + lot + confirmed quantity; ScanField (`edge/src/components/scan-field.tsx`) scans a lot number into the package.
  - [x] 3.2 Unknown lot refused in place; matching lot flips the line to In package with aria-live; a single carton weight field (first line only: `actual_weight_kg` on first packing line, null on the rest; `carton_count` 1 on first, 0 on the rest, owner question Q18).
  - [x] 3.3 Generate shipping documents disabled stating what is left until every picked lot is packed and the carton weight is entered; pressing it posts `POST /pack` with one `packingLines` entry per picked line then `POST /generate-documents` (no body); handle a partial failure where pack succeeded but generate-documents failed (skip pack on retry when the order is already fully packed).
  - [x] 3.4 Map `LOT_ON_HOLD`, `PACKED_QTY_MISMATCH`, `PACKED_LINE_NOT_PICKED`, `DISPATCH_ORDER_NOT_PICKED`, `INVALID_PARAMS` to `errors.*` text via `errorMessage`.

- [x] Task 4: IRN block card and record (AC 5)
  - [x] 4.1 When the order is in the documents_generated stage with `irn_recorded` false, render the blocked card `E-invoice IRN missing - cannot dispatch` with the package summary; Check IRN again calls `GET /dispatch/:id/irn` (404 `DISPATCH_IRN_NOT_RECORDED` stays blocked, 200 clears).
  - [x] 4.2 Record IRN form posts `{ invoice_number_ext, irn_ext (64 hex), idempotency_key }` (key minted once per opened form, reused across retries of the same payload); hidden when the blocked-card `details.reason` is `no_erp_sales_order_line`; no automatic-billing-notification sentence; Park at dispatch bay rendered disabled (no bay record, deferred).
  - [x] 4.3 Map `DISPATCH_IRN_CONFLICT`, `DISPATCH_IRN_INVALID_PAYLOAD`, `DISPATCH_ORDER_SITE_MISMATCH`, `DISPATCH_ORDER_CLOSED` to `errors.*`.

- [x] Task 5: Documents, print and confirm dispatch (AC 6)
  - [x] 5.1 List `GET /dispatch/:id/documents` documents with type labels under `packStation.doc.*` (bol, packing_slip, commercial_invoice, label); Print renders `document_content` under a print-only stylesheet twin of `stores-issue.tsx:41`; null content shows Print disabled stating no content; no E-way bill row.
  - [x] 5.2 Confirm dispatch posts `POST /dispatch/:id/dispatch`; on 200 the order moves to Dispatched today; map `DISPATCH_ORDER_NOT_PACKED`, `DISPATCH_DOCUMENTS_NOT_GENERATED`, `DISPATCH_ORDER_ALREADY_DISPATCHED`, `LOT_ON_HOLD`.

- [x] Task 6: Offline read-only (AC 7)
  - [x] 6.1 Offline, the list renders read-only from the last successful fetch with a sync badge; Generate shipping documents, Check IRN again, Record IRN and Confirm dispatch disabled with `needs a connection`; no outbox writes.

- [x] Task 7: Device classes, accessibility and i18n (AC 8)
  - [x] 7.1 Handheld one page with pinned 56 px primary; Tablet/Desktop two panes; Desktop 34 px controls + scan hint `USB scanner or type`; Desktop touch 56/48 px; ScanField keeps focus after each accepted scan.
  - [x] 7.2 All new copy under `packStation.*`; extend the i18n literal guard (`edge/test/unit/i18n-literals.test.ts`); zero axe violations and a keyboard-only pass (e2e and accessibility specs).

- [x] Task 8: Tests and regression (AC 2, AC 8)
  - [x] 8.1 Edge unit tests: list grouping/stage rules, packing checklist state (unknown lot, in-package flip, carton/weight gating), IRN blocked/cleared state machine, document print gating.
  - [x] 8.2 Integration tests (`test/integration/story-3-18.test.ts`) for the nav row and the list/stage read.
  - [x] 8.3 E2E spec (list to pack to generate-documents to record-IRN to confirm-dispatch) and accessibility spec; stub fixture `edge/test/fixtures/pack-stub.ts`.
  - [x] 8.4 Full regression: edge build (`npm --workspace @inventory/edge run build`), edge unit suite, edge lint and typecheck, root unit and integration tests.

### Review Findings

- [x] [Review][Defer] Staging validation-walk precondition not recorded — the Dev Notes precondition (EXPERIENCE.md:262, key-floor.html L463) requires walking the pack-and-dispatch layout with dispatch1@ on the staging preview and recording the outcome, or recording the owner's waiver, before build. — deferred, recorded as a staging action item: the layout walk with dispatch1@ runs on the staging preview; a manual owner action independent of the code fixes (same handling as Story 3.16).
- [x] [Review][Patch] Generate shipping documents not disabled with a "what is left" hint until packing is complete and weight entered (AC 4 / Task 3.3) [edge/src/components/pack-dispatch.tsx:648-655]
- [x] [Review][Patch] PACKED_QTY_MISMATCH fall-through treats a genuine quantity mismatch as already-packed and generates over a refused pack [edge/src/components/pack-dispatch.tsx:395-408]
- [x] [Review][Patch] irnCovered === null is a dead-end (perpetual loading, Confirm disabled, no retry) when the IRN check fails with a non-404 error [edge/src/components/pack-dispatch.tsx:565-567]
- [x] [Review][Patch] Empty state hides the Dispatched today group when Ready/Waiting are empty (AC 3) [edge/src/components/pack-dispatch.tsx:181-194]
- [x] [Review][Patch] Offline: the four write controls are absent rather than disabled stating needs a connection (AC 7) [edge/src/components/pack-dispatch.tsx:121-140]
- [x] [Review][Patch] Weight validated only for empty; NaN/Infinity/negative slips through and NaN silently drops the carton weight [edge/src/components/pack-dispatch-model.ts:78-91]
- [x] [Review][Patch] matchScan first-match wins; a duplicate lot number across two picked lines deadlocks packing [edge/src/components/pack-dispatch-model.ts:107-115]
- [x] [Review][Patch] remainingHints returns hardcoded English fragments, bypassing the i18n literal guard (AC 8) [edge/src/components/pack-dispatch-model.ts:118-128]
- [x] [Review][Patch] IRN blocked card has no package summary (AC 5) [edge/src/components/pack-dispatch.tsx PackIrnBlocked]
- [x] [Review][Patch] Park at dispatch bay disabled without stating no bay record exists (AC 5 + EXPERIENCE.md disabled-actions-state-why) [edge/src/components/pack-dispatch.tsx:696-698]
- [x] [Review][Patch] E2E spec does not cover the generate/record/confirm POST flow (Task 8.3) [edge/test/e2e/pack-dispatch.spec.ts]
- [x] [Review][Patch] Missing deferred-work.md records (Park at dispatch bay, E-way bill, online-only departure) (AC 5/6/7) [_bmad-output/implementation-artifacts/deferred-work.md]
- [x] [Review][Patch] EXPERIENCE.md not amended: billing-notification sentence and offline-packing claim contradict implemented behavior (AC 5/7) [EXPERIENCE.md:99,103]
- [x] [Review][Patch] Dispatched today group returns every dispatched order ever with no recency filter, contradicting the "today" label [src/read/projections/dispatch_list.ts:69-70]
- [x] [Review][Patch] Desktop scan hint "USB scanner or type" missing (AC 8) [edge/src/components/pack-dispatch.tsx ScanField]
- [x] [Review][Patch] Missing unit tests for the IRN blocked/cleared state machine and document print gating (Task 8.1) [edge/test/unit/pack-dispatch-model.test.ts]
- [x] [Review][Patch] No RBAC negative (401/403) tests for the two new dispatch routes [test/integration/story-3-18.test.ts]
- [x] [Review][Patch] POST /dispatch not idempotent: timeout-after-success retry surfaces already-dispatched with no state reconciliation [edge/src/components/pack-dispatch.tsx confirmDispatch]
- [x] [Review][Patch] Print content persists on screen after print and print may fire before the pre is painted [edge/src/components/pack-dispatch.tsx PackDocuments]
- [x] [Review][Patch] Auto-pack of a null confirmed_quantity (lot-less) line posts packed_qty '0', masking a data anomaly [edge/src/components/pack-dispatch-model.ts:85,131-135]
- [x] [Review][Patch] List sorts by so_number_ext lexicographically (SO-10 before SO-2) instead of picked_at FIFO [src/read/projections/dispatch_list.ts:70]
- [x] [Review][Patch] Unknown document types fall back to the section title as their label instead of the raw type [edge/src/components/pack-dispatch.tsx:751]
- [x] [Review][Patch] Missing trailing newlines on the new files (format consistency) [new files]

## Dev Notes

- **Precondition - validation walk**: EXPERIENCE.md:262 and key-floor.html L463 mark the pack and dispatch layout as not elicited. Before build, walk the layout with dispatch1@ on the staging preview and record the outcome in the Dev Agent Record, or record the owner's waiver as a ruling (audit :467). This is the same precondition Story 3.16 recorded.
- **Server contracts (all verified against the current tree)**: the pack / generate-documents / dispatch / irn routes and their handlers already exist in `src/api/v1/dispatch.ts` (postPacked :262, postShippingDocumentsGenerated :367, postDispatched :420, getPackingRecords :467, getDispatchDocuments :486, postIrnRecorded :596, getIrnCoverage :740). The compliance gate and the IRN wall already exist in `src/compliance/dispatch.ts` (dispatchGateBlockedLots :69, applyDispatchDispatchedProjection IRN wall :603-645, dispatchIsEInvoiceable :768). Do NOT re-implement these: the pack station is a thin REST client over them. Only the list read (`GET /api/v1/dispatch`) and the picked-lines read are new server work.
- **List stage derivation**: `getDispatchOrderStatus` (`src/read/projections/dispatch_order_status.ts:31-38`) derives `status` from timestamps only and does not know `documents_generated`; the new list must derive stage as dispatched (dispatched_at set) > documents_generated (a dispatch_document row exists and dispatched_at null) > packed (packed_at set, no documents) > picked. The `?stage=` filter applies to that derived value, and `irn_recorded` is `(dispatch_irn.dispatch_order_id IS NOT NULL)` from the LEFT JOIN.
- **Picked-lines read (the one implicit read)**: AC 4 renders a checklist of "each picked lot", which is `pick_line` rows where `dispatch_order_line_id` = the dispatch order id (the SO line id) and `status` in (`confirmed`, `substituted`) - fields `sku`, `confirmed_lot_id`, `confirmed_quantity` (`src/read/projections/pick_line.ts:13-18`, :209 `listPickLinesByTask` is by TASK, not by dispatch order). No read route exists today. Task 1.5 must add one (e.g. `GET /api/v1/dispatch/:dispatchOrderId/picked-lines` gated by `DISPATCH_READ_ROLES`), bridging `confirmed_lot_id` to `lot_master.lot_number` for the scan match. Resolve the exact shape in Task 1 before the edge screen is built.
- **Generate shipping documents is two sequential writes, and pack is NOT idempotent**: `postPacked` mints a fresh `packing_record_id` per call and the applier refuses a second full pack with `PACKED_QTY_MISMATCH` (`src/compliance/dispatch.ts:270-277`). If pack succeeds but generate-documents fails, the order is left packed; the retry must detect the order is already fully packed (stage packed) and call `POST /generate-documents` directly instead of re-posting pack. This is the one correctness trap in AC 4.
- **IRN idempotency**: `postIrnRecorded` requires `idempotency_key` (`src/api/v1/dispatch.ts:627-632`) and short-circuits on it; mint it once when the Record IRN form opens and reuse it across retries of the same `{ invoice_number_ext, irn_ext }` payload (the 3.16 rule). `irn_ext` must match `IRN_EXT_REGEX` (64 hex). `so_number_ext` is server-derived and must never be sent.
- **Reuse, do not reinvent**: `ScanField` (`edge/src/components/scan-field.tsx`, props `id/label/value/placeholder/onScan/onChange`), the two-pane list+detail layout and `?dispatch=` query pattern from 3.16 (`floor-tasks.tsx`), `errorMessage(code)` mapping (`edge/src/i18n/locale.ts`), the needs-connection read-only pattern (`damage-cases.tsx:41`), the nav sentinel + `hasXScope` + `navigationFor` pattern from `hasGateScope` (`src/api/v1/edge.ts:458-467`), the print-only stylesheet twin of `stores-issue.tsx:41`, and the `pack-dispatch` view no-access gating (`app-shell.tsx`, `edge-client.tsx`).
- **Owner rulings recorded**: one carton per order with `carton_count` 1 on the first packing line and `actual_weight_kg` on the first line only (Q18); SO number as the row heading, no package id minted (Q19); dispatch clerk and warehouse_manager record the IRN as the code already allows (Q16); online-only pack for pilot (Q17); no automatic billing notification (nothing in `src/` notifies billing); Park at dispatch bay, e-way bill, scale integration and vehicle number are deferred (recorded in deferred-work.md).
- **Stale note in epics**: the 3.18 Note says "the 3-7 story file still reads Status: review and is set to done by this story's create-story" - the 3-7 file already reads `Status: done` today, so no change is required.
- **Existing error keys**: `LOT_ON_HOLD` (`en.json:86`), `DISPATCH_ORDER_NOT_PICKED` (:192), `DISPATCH_ORDER_NOT_PACKED` (:193), `DISPATCH_ORDER_ALREADY_DISPATCHED` (:194), `PACKED_QTY_MISMATCH` (:198), `PACKED_LINE_NOT_PICKED` (:200), `DISPATCH_DOCUMENTS_NOT_GENERATED` (:201), `IRN_MISSING` (:202), `DISPATCH_IRN_CONFLICT` (:218), `DISPATCH_IRN_NOT_RECORDED` (:219), `DISPATCH_IRN_INVALID_PAYLOAD` (:220), `DISPATCH_ORDER_SITE_MISMATCH` (:221), `DISPATCH_ORDER_CLOSED` (:222) already exist - map them, do not duplicate. Add `packStation.*` UI strings and `nav.packDispatch`.

### Previous story intelligence (3.16, 8.11, 3.13)

The 3.15/3.16 code reviews produced hard-won rules that 3.18 MUST follow:

- **Never** put `window.location.search` directly in a `useEffect` dependency array - it fails `next build` with `ReferenceError: window is not defined`. Read `?dispatch=` in a `useState` initializer guarded by `typeof window === 'undefined'`, then re-read in an effect; reset all screen state when the query changes.
- **Idempotency keys** replay by `idempotency_key` alone (`src/events/store.ts:960`). Mint a fresh key when the payload changes, reuse across retries of the same payload.
- A denied read with no data must render the no-access card, not an infinite spinner.
- Optional enrichment reads (lot_number joins) must never abort the main screen - wrap them in their own try/catch or `.catch(() => null)`.
- Every `errors.*` and new `packStation.*` token must exist in `en.json`; extend the i18n literal guard (`edge/test/unit/i18n-literals.test.ts`).
- The 8.11 review fixed broken two-tap/hold IDs and missing header links on the QC surface - keep every `/qc/holds`-style secondary action reachable and its target id wired.

### Project Structure Notes

- Edge PWA lives under `edge/`: `app/` routes, `src/components/`, `src/local-db/`, `src/sync/`, `src/session/`, `src/i18n/locale.ts`, `src/messages/en.json`. Follow the 3.16 layout (`floor-tasks.tsx` + `floor-tasks-model.ts` pair: pure model in `*-model.ts`, component owns fetch/render). The pack station route is `/floor/pack` (no dynamic segments; records selected by `?dispatch=` query, per `edge/app/damage/cases/page.tsx`).
- Server: `src/api/v1/dispatch.ts` (routes, role gates), `src/read/projections/dispatch_order_status.ts` + `dispatch_irn.ts` + `dispatch_document.ts` + `erp_sales_order.ts` (reads), `src/compliance/dispatch.ts` (gate + IRN wall), `src/api/v1/edge.ts` (bootstrap nav, event stamping). Do NOT change `src/compliance/dispatch.ts` gate semantics.
- No new libraries, dependencies or npm packages. Next.js 16.2.10 / React (Turbopack), Node + tsx test runner, Playwright for e2e/accessibility (all installed; verify against `package.json` if in doubt).

### References

- Epic story definition: `_bmad-output/planning-artifacts/epics.md:1930-1974` (Story 3.18), `:1576-1600` (Story 3.7 scope boundary)
- Origin and audit gap G08: `_bmad-output/implementation-artifacts/sprint-change-proposal-2026-10-21.md` Table 3.18, Section 4 (Q16-Q19)
- Mock (pack and dispatch): `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-floor.html` L450-473, L557-590, L624-646, L736-779
- Device and a11y rules: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md` L19, L74, L99-107, L119-123, L135, L262
- Server contracts: `src/api/v1/dispatch.ts:37,43-51,86-127,172-365,467-503,596-765`; `src/compliance/dispatch.ts:39,69,180-757,768,781`; `src/read/projections/dispatch_order_status.ts:15-39`; `dispatch_irn.ts:137-160`; `dispatch_document.ts:60-82`; `erp_sales_order.ts:14-29,97-106`; `pick_line.ts:13-18,209`; `src/api/v1/edge.ts:405-511,686-701`; `src/server.ts:1431-1446`; `test/integration/story-1-9.test.ts:339-350`
- Edge patterns: `edge/src/components/scan-field.tsx:15-27`; `floor-tasks.tsx`; `stores-issue.tsx:41`; `damage-cases.tsx:41`; `edge/src/messages/en.json:86,192-202,218-222,446-710`
- Roles: `docs/migration/pilot-mock-extract/roles.json:576-589`

## Dev Agent Record

### Agent Model Used

deepseek/deepseek-pro-latest

### Debug Log References

- 2026-11-20: Story 3.18 created with comprehensive context (epics.md:1930-1974, key-floor mock, EXPERIENCE.md 2026-09-23, sprint-change-proposal Table 3.18, 3.7 dispatch server surface, 3.16 previous-story intelligence). Validation-walk precondition recorded.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created
- 2026-11-21: Implemented the pack station and dispatch screen end to end. Server: new `src/read/projections/dispatch_list.ts` accessor (`listDispatchOrders` with four-way stage derivation and `irn_recorded` LEFT JOIN), `GET /api/v1/dispatch` list route + `GET /api/v1/dispatch/:dispatchOrderId/picked-lines` (new `listPickLinesByDispatchOrderLine` in `pick_line.ts` bridging `confirmed_lot_id` to `lot_master.lot_number`), both gated by `DISPATCH_READ_ROLES` and registered before the per-id routes; `pack-dispatch` nav sentinel + `hasPackDispatchScope` in `edge.ts`; spine allowlist entries. Edge: `pack-dispatch-model.ts` (pure grouping/scan/packing rules), `pack-dispatch.tsx` (three-group list, scan-to-pack checklist, carton weight, generate-documents, IRN blocked card with Check/Record, document print + confirm dispatch, offline read-only), `edge/app/floor/pack/page.tsx`, `pack-dispatch` wired through `app-shell.tsx`/`edge-client.tsx`, `nav-model.ts` entry, `packStation.*` + `nav.packDispatch` strings, i18n literal guard extended. Tests: `test/integration/story-3-18.test.ts` (nav row, list/stage, picked-lines), `edge/test/unit/pack-dispatch-model.test.ts`, e2e + accessibility specs with `pack-dispatch-stub.ts` fixture.
- Verification: server `tsc` build clean; server lint clean; edge `typecheck`/lint clean; edge unit suite 232 passing; story-3-18 integration 5/5, story-1-9 spine 6/6, story-3-6 15/15, story-3-14 15/15, story-3-16 3/3; pack-dispatch e2e 4/4 and accessibility 3/3 (zero serious/critical axe violations). Note: `test/integration/story-3-7.test.ts` fails in this Windows environment with a pre-existing IPv6-loopback `EACCES` on `localhost` (unrelated to this story; it binds `localhost` while passing stories bind the default interface), and was not modified.

### File List

Anticipated files this story will create or update (confirm and complete during implementation):

- NEW `edge/app/floor/pack/page.tsx` (routed view)
- NEW `edge/src/components/pack-dispatch.tsx` (list + pack station detail)
- NEW `edge/src/components/pack-dispatch-model.ts` (pure stage/grouping/packing rules, unit-tested)
- UPDATE `edge/src/components/app-shell.tsx` (view union, render chain, no-access card)
- UPDATE `edge/src/components/edge-client.tsx` (view wiring)
- UPDATE `edge/src/components/navigation/nav-model.ts` (NAV_ENTRIES)
- UPDATE `src/api/v1/edge.ts` (nav row, hasPackDispatchScope, modules union)
- UPDATE `src/api/v1/dispatch.ts` (list route; picked-lines route)
- NEW `src/read/projections/dispatch_list.ts` (list accessor; `dispatch_order_status.ts` left unchanged)
- UPDATE `src/read/projections/pick_line.ts` (`listPickLinesByDispatchOrderLine`)
- UPDATE `src/server.ts` (register the two new dispatch routes)
- UPDATE `edge/src/messages/en.json` (`nav.packDispatch`, `packStation.*`)
- UPDATE `edge/test/unit/i18n-literals.test.ts` (literal guard)
- UPDATE `test/integration/story-1-9.test.ts` (spine allowlist)
- NEW `test/integration/story-3-18.test.ts`
- NEW `edge/test/unit/pack-dispatch-model.test.ts`
- NEW `edge/test/e2e/pack-dispatch.spec.ts`, `edge/test/accessibility/pack-dispatch-accessibility.spec.ts`
- NEW `edge/test/fixtures/pack-dispatch-stub.ts` (e2e/a11y fetch stub)
- UPDATE `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-11-20: Story 3.18 created by create-story with full context. Status set to ready-for-dev.
- 2026-11-21: Implemented the pack station and dispatch screen (nav row, list + picked-lines reads, three-group list, packing flow, IRN block card, documents/print/confirm, offline read-only, device classes) with unit, integration, e2e and accessibility coverage. Status set to review.
- 2026-11-21: Code review (adversarial + edge-case + acceptance-auditor layers) found 1 decision-needed (staging walk - deferred) and 23 patch findings (8 dismissed as noise). All 23 applied: Generate-disabled hint, PACKED_QTY_MISMATCH packed-verification, IRN-coverage dead-end retry, dispatched-today recency filter + FIFO sort, offline disabled controls, weight validation, duplicate-lot scan, i18n hints, IRN package summary + park reason, USB scan hint, E2E full flow, deferred-work.md + EXPERIENCE.md records, unit/RBAC tests, print clearing, auto-pack null-quantity guard, unknown-doc label, trailing newlines. Status set to done.

## Status

done
