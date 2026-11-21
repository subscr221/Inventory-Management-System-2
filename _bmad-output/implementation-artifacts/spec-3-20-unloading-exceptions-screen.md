---
status: done
followup_review_recommended: false
final_revision: b7707c6
baseline_revision: 3bf6cc00830f103de30fa9f38428dc9b10ae64d0
story: 3-20-unloading-exceptions-screen
context:
  - _bmad-output/implementation-artifacts/epic-3-context.md
  - _bmad-output/implementation-artifacts/spec-3-19-unloading-exception-commands-server.md
  - _bmad-output/project-context.md
review_loop_iteration: 0
warnings:
  - oversized
---

# Story 3.20: Unloading Exceptions Screen

<intent-contract>

## Intent

**Problem:** Story 3.19 shipped the server commands that resolve unloading exceptions, but no edge screen calls them, so an unloading supervisor still cannot clear a stuck truck or an over-tolerance line.

**Approach:** Add an online-only edge view at `/unloading/exceptions` (pattern: `pack-dispatch.tsx`) with one merged inbox of open unmatched gate events and open over-tolerance exceptions, a `Resolved today` group, a scan field that opens the matching case, and a detail pane that resolves each case with one 3.19 command.

## Boundaries & Constraints

**Always:** Both list calls pass `site=<siteCodeExt>` (a site code, not a UUID). Open unmatched rows come only from `GET /api/v1/gate-events?site=&binding=unmatched&status=open` (3.19 never writes an open `unmatched_vehicle` exception row); open over-tolerance rows come from `GET /api/v1/receiving/exceptions?site=&status=open`; the merged list is sorted oldest first on the client (`entered_at` for gate rows, `created_at` for exception rows). `Resolved today` is the exceptions list with status `resolved` or `sent_to_procurement` whose `resolved_at` falls on today's IST date (`istCalendarDate` in `edge/src/capture/business-date.ts`). Every string lives in `edge/src/messages/en.json` under `unloading.*` (plus `nav.unloadingExceptions` and `errors.*` for the new codes). Pills carry text. Density is CSS by pointer, layout by `useDeviceClass`. The tolerance percent shown is the row's `tolerance_pct`, never a literal. `sprint-status.yaml` is never written.

**Block If:** None. The epic text, the 3.19 contract and the mock fix every decision.

**Never:** No outbox write and no offline resolve. No call to `GET /api/v1/purchase-orders` and no PO list picker (no open-PO-by-supplier route exists). No above-band branch. `Hold excess for buyer decision` is never enabled. No weighbridge breach rows. No Unlisted supplier match-to-vendor flow. No server change.

## I/O & Edge-Case Matrix

Table 1: I/O and edge-case matrix lists the screen behaviours the unit and Playwright tests must cover.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Inbox loads | One unmatched gate event (08:05), one open over-tolerance row (07:40) | Group `Exceptions from gate and unloading (2)`; over-tolerance card first; pills `Not matched` and `Over tolerance` | None |
| Empty inbox | Both lists empty | `No open exceptions from gate or unloading. New ones appear here as trucks arrive.`; scan field enabled | None |
| Resolved today | Exceptions with `resolved_at` today and yesterday | Only today's rows under `Resolved today` with resolution pill | None |
| Match to PO | Type `PO-1`, lookup returns open PO | Supplier, due date and open lines shown; primary reads `Match to PO-1`; POST match-po; Resolved view; lists refetch | None |
| PO lookup miss | Lookup 404 | Primary stays `Choose a PO to match`; `unloading.poNotFound` text `No PO <ref> found - check the number and try again` | aria-live announcement |
| Match refused | match-po 409 `PO_NOT_OPEN` or `GATE_EVENT_NOT_UNMATCHED` | Error text from `errors.<code>`; no Resolved view | Inline alert |
| Ask procurement | Ghost action with optional note | POST send-to-procurement; Resolved view; row leaves open group, appears under Resolved today | 409 `GATE_EVENT_ALREADY_RESOLVED` shown inline |
| Accept within band | Row ordered 100, already 90, pct 10, cap 20, counted 30, excess 10 | Facts in order; warn `Excess 10 - returned with vehicle`; primary `Accept 20 - return 10 with vehicle`; POST accept-within-band | 409 `RECEIPT_BAND_EXHAUSTED`, `GRN_LINE_ALREADY_RESOLVED` inline |
| Recount | Click `Recount` | Back to inbox, no request sent | None |
| Scan opens case | Scan vehicle reg, challan or PO ref (case and space insensitive) | Matching case opens; no match announces `No open exception for <code>` | None |
| Offline | `online` false | Needs-connection card; scan field armed; Match, Accept and Ask procurement disabled with `Needs a connection - exceptions are resolved against live PO and GRN data` | No request sent |
| No access | Bootstrap navigation lacks `Unloading exceptions` | Shell no-access card | None |

</intent-contract>

## Code Map

- `edge/src/components/pack-dispatch.tsx` -- template: `authorizedFetch`, `readError`, `online`/`ready` props, `floor-screen` two-pane layout, `stores-group`/`stores-card`/`state-pill` markup
- `edge/src/components/stores-inbox.tsx:242-255` -- `ScanField` in `stores-scan` with a `stores-announcement` aria-live region
- `edge/src/components/damage-cases.tsx:38-42` -- needs-connection list state
- `edge/src/components/scan-field.tsx` -- scan input
- `edge/src/components/app-shell.tsx` -- `AppShellProps`, `BaseView`, `BASE_VIEW_ENTRY`, render chain, no-access card (`:408-417`)
- `edge/src/components/edge-client.tsx:255-275`, `:559-561` -- `view` union, `siteCodeExt`
- `edge/src/components/navigation/nav-model.ts` -- `NAV_ENTRIES`
- `edge/src/i18n/locale.ts`, `edge/src/messages/en.json` -- `t`, `errorMessage`, `formatDateTime`
- `src/api/v1/unloading-exceptions.ts`, `src/read/projections/receiving_exception.ts`, `src/api/v1/gate.ts`, `src/api/v1/erp-projections.ts` -- 3.19 contract (read only)
- `edge/test/fixtures/pack-dispatch-stub.ts`, `edge/test/e2e/pack-dispatch.spec.ts`, `edge/test/accessibility/pack-dispatch-accessibility.spec.ts` -- test templates

## Tasks & Acceptance

**Execution:**

- [x] `edge/src/components/unloading-exceptions-model.ts` (new) -- pure functions: `mergeOpenCases(gateEvents, exceptions)` returning typed cases (`kind: 'unmatched' | 'over_tolerance'`, id, sortKey) oldest first; `resolvedToday(exceptions, now)` by IST date; `findCaseByScan(cases, code)` matching `vehicle_reg_ext`, `challan_number_ext`, `po_ref_ext` (trimmed, upper-cased, spaces removed) -- testable logic outside React
- [x] `edge/src/components/unloading-exceptions.tsx` (new) -- the view: loads both lists when online and ready; inbox group with count, `Resolved today` group, empty state, needs-connection card; `?case=gate:<id>` or `?case=line:<id>` selects the detail (handheld one page with Back, wider two panes); unmatched detail fetches `GET /api/v1/gate-events/:id` for facts and challan photo ref, PO number field resolved with `GET /api/v1/erp/purchase-orders/:poNumber`, primary label switch, ghost `No PO fits - hold vehicle, ask procurement` with optional note; over-tolerance detail renders facts in AC order, warn note, `Recount`, primary accept, disabled `Hold excess for buyer decision` with `Post-pilot` pill; after success shows the Resolved view (`The delivery moves to the stores inbox.`) and refetches; offline disables actions with the reason -- the screen
- [x] `edge/app/unloading/exceptions/page.tsx` (new), `edge/src/components/edge-client.tsx`, `edge/src/components/app-shell.tsx` -- route page, `view` union member `unloading-exceptions`, `BaseView` and `BASE_VIEW_ENTRY` (`'Unloading exceptions'`), props wiring (`siteCodeExt`, `online`, `ready`) and render branch -- shell registration
- [x] `edge/src/components/navigation/nav-model.ts` -- add `{ name: 'Unloading exceptions', href: '/unloading/exceptions', label: 'nav.unloadingExceptions' }` -- nav entry matching `src/api/v1/edge.ts` capability name
- [x] `edge/src/messages/en.json` -- `nav.unloadingExceptions`, `unloading.*` strings, `errors.*` for `GATE_EVENT_NOT_UNMATCHED`, `GATE_EVENT_ALREADY_RESOLVED`, `PO_NOT_OPEN`, `GRN_LINE_NOT_REJECTED`, `GRN_LINE_ALREADY_RESOLVED`, `RECEIPT_BAND_EXHAUSTED`, `GATE_EVENT_NOT_FOUND`, `GRN_LINE_NOT_FOUND`, `RECEIVING_PO_NOT_FOUND` (skip any key that already exists) -- strings
- [x] `edge/src/app/globals.css` (or the existing stylesheet holding `.floor-screen`) -- only what the new view needs that existing classes lack (pinned bottom-third primary on touch classes if not already present) -- layout
- [x] `edge/test/unit/unloading-exceptions-model.test.ts` (new), `edge/test/unit/nav-model.test.ts` -- merge order, IST today filter, scan matching; nav entry -- unit coverage
- [x] `edge/test/fixtures/unloading-exceptions-stub.ts` (new), `edge/test/e2e/unloading-exceptions.spec.ts` (new), `edge/test/accessibility/unloading-exceptions-accessibility.spec.ts` (new) -- Table 1 rows, no-access deep link, axe on inbox and both details at handheld and desktop, keyboard-only resolve -- screen coverage
- [x] `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md`, `_bmad-output/implementation-artifacts/deferred-work.md` -- record that unloading exceptions resolve online only (deviation from mock key-floor.html L467 and L788, owner question Q22), the typed-PO picker replacing the open-PO radio list, and the deferred Unlisted supplier flow -- traceability

**Acceptance Criteria:**

- Given a caller whose bootstrap navigation carries `Unloading exceptions`, when the shell renders, then the entry links to `/unloading/exceptions`; given one without it, a deep link renders the no-access card.
- Given the page online, when both lists load, then one group `Exceptions from gate and unloading` with a count lists open cases oldest first, `Resolved today` lists today's resolved and sent rows, and an empty inbox shows the mock empty text with the scan field armed.
- Given an unmatched case, when a typed or scanned PO resolves to an open PO, then supplier, open lines and due date show, the primary reads `Match to <PO ref>` and calls match-po; the ghost action calls send-to-procurement with the optional note.
- Given an over-tolerance case, when it opens, then PO line, ordered, already received, `accept up to <cap>` with the row's tolerance percent, and counted show in that order with `Excess <excess> - returned with vehicle`; `Recount` returns without a write and the primary `Accept <cap> - return <excess> with vehicle` calls accept-within-band; `Hold excess for buyer decision` is disabled with `Post-pilot`.
- Given the device offline, when the page opens, then the needs-connection card shows, the scan field stays armed, and all resolve actions are disabled with the stated reason and send nothing.
- Given handheld and desktop viewports, when axe and a keyboard-only pass run, then there are zero WCAG 2.1 AA violations, handheld shows one page at a time with the primary full width at the bottom, and wider classes show list and detail side by side.

## Spec Change Log

## Review Triage Log

### 2026-11-22 - Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6 (high 0, medium 2, low 4)
- defer: 1 (high 0, medium 1, low 0)
- reject: 40 (high 0, medium 3, low 37)
- addressed_findings:
  - `[medium]` `[patch]` The exceptions list was fetched once without a status filter, a departure from the spec; the server caps it at 500 rows oldest first, so resolved history would crowd out open rows. Now one call each for `open`, `resolved` and `sent_to_procurement`; the stub honours the status filter.
  - `[medium]` `[patch]` Prettier formatting regressions in `app-shell.tsx`, `edge-client.tsx` and `nav-model.ts` (all clean on baseline); reformatted.
  - `[low]` `[patch]` Resolved pill fell back to `matched_to_po` when `resolution` is null; now falls back to the row status, with a `unloading.pill.resolved` string.
  - `[low]` `[patch]` A 404 on a command (case gone elsewhere) left a dead detail; 404 now refreshes the lists like 409.
  - `[low]` `[patch]` PO lookup read `navigator.onLine` instead of the screen's `online` prop; now uses the prop.
  - `[low]` `[patch]` Stub fixture returned every row for every status call; now filters by `status`.

## Design Notes

Case keys are `gate:<gate_event_id>` and `line:<grn_line_id>` (the over-tolerance row's `source_id`), held in the `case` query parameter like pack-dispatch's `dispatch` parameter, so a deep link and the Back control work without extra state.

`GET /api/v1/receiving/discrepancies` is not called: the 3.19 exception row already carries every band fact (ordered, already received, tolerance pct, cap, counted, excess, PO ref, line, SKU, UOM), and the epic forbids it as a row source. Adding it would be a second request for no new field.

Quantities arrive as strings; render them as received (no float arithmetic on the client).

After any successful command the view shows the Resolved panel and refetches both lists; a 409 from a stale case refetches too, so a case resolved on another device disappears.

## Verification

**Commands:**

- `cd edge && npm run typecheck && npm run lint && npm run i18n:check` -- expected: clean
- `cd edge && npm test` -- expected: all unit tests pass
- `cd edge && npx playwright test test/e2e/unloading-exceptions.spec.ts test/accessibility/unloading-exceptions-accessibility.spec.ts` -- expected: all pass
- `cd edge && npm run test:e2e` -- expected: no new failures against the known-red baseline
- `node --env-file=.env.test --import tsx --test test/unit/edge-permanent-error-parity.test.ts` -- expected: pass

## Auto Run Result

Status: done

**Summary:** Story 3.20 adds the online-only `Unloading exceptions` edge screen at `/unloading/exceptions`. One inbox merges open unmatched gate events and open over-tolerance exceptions oldest first, with a `Resolved today` group and the mock empty state. A scan of vehicle, challan or PO opens the matching case. The unmatched detail resolves by a typed PO lookup and `match-po`, or by `send-to-procurement`; the over-tolerance detail shows the band facts and resolves by `accept-within-band`. Offline, a needs-connection card shows and every resolve action is disabled with the stated reason.

**Files changed:**

- `edge/src/components/unloading-exceptions.tsx` - the screen (inbox, details, resolved panel, offline state)
- `edge/src/components/unloading-exceptions-model.ts` - merge-sort, IST resolved-today filter, scan matching
- `edge/app/unloading/exceptions/page.tsx` - route page
- `edge/src/components/app-shell.tsx`, `edge/src/components/edge-client.tsx`, `edge/src/components/navigation/nav-model.ts` - view, `BaseView`, `BASE_VIEW_ENTRY`, nav entry
- `edge/src/messages/en.json` - `nav.unloadingExceptions`, `unloading.*`, new `errors.*` strings
- `edge/app/globals.css` - pinned footer for the primary on handheld
- `edge/test/unit/unloading-exceptions-model.test.ts`, `edge/test/unit/nav-model.test.ts` - unit coverage
- `edge/test/fixtures/unloading-exceptions-stub.ts`, `edge/test/e2e/unloading-exceptions.spec.ts`, `edge/test/accessibility/unloading-exceptions-accessibility.spec.ts` - Playwright and axe coverage
- `EXPERIENCE.md`, `deferred-work.md` - online-only deviation (Q22), typed PO picker, unlisted supplier flow, list cap deferral

**Review findings:** 6 patches applied, 1 deferred (server exceptions list cap of 500 rows oldest first with no date filter), 40 rejected.

**Verification:** edge `typecheck`, `lint` and `i18n:check` clean; edge unit 242 of 242; new Playwright specs 17 of 17 (axe zero WCAG 2.1 AA violations at handheld and desktop, keyboard-only resolve); full edge e2e 111 of 111; root `edge-permanent-error-parity` 5 of 5.

**Residual risks:** Tests run against a stubbed API, not the live 3.19 server; no staging or real-handheld walk; a scan matching several cases opens the oldest one; `match-po` does not check the PO's supplier or site (pre-existing deferral).
