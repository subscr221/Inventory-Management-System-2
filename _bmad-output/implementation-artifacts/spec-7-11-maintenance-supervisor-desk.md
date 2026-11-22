---
title: 'Story 7.11 Maintenance Supervisor Desk'
type: 'feature'
created: '2026-11-22'
status: 'in-review'
baseline_revision: '5ecf7e0'
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/_bmad-output/planning-artifacts/epics.md']
warnings: ['oversized', 'multiple-goals']
---

<intent-contract>
## Intent
**Problem:** A maintenance supervisor has no desk. Fault triage, warranty override, return-to-service sign-off and sync-conflict resolution exist only as raw API routes, so a reported fault cannot be turned into a breakdown work order and a repaired asset cannot be returned to running from the device without hand-made calls.

**Approach:** Add a DOA-holder-scoped edge page `/maintenance/desk` (online only) with a five-group work order board, fault triage (accept/reject), warranty override, return-to-service sign-off and a sync-conflict panel. Visibility is driven by active DOA holding of `maintenance.return_to_service`, `maintenance.warranty_override` or `maintenance.sync_conflict_resolution`, not by module role. Server gains the small read gaps the board needs.

## Boundaries & Constraints
**Always:** Server enforces every authority check (DOA via `resolveApprover` / `isActiveRoleHolderForEntry`); the edge nav gate is UI-only. Desk actions are online-only and never write the outbox. Sign-off ticks are device-side only and are not persisted. Board is company-wide (no site scoping). Work-order list and asset-status additions are read-only and additive. i18n keys live in `edge/src/messages/en.json`. Each device class (handheld, tablet, desktop, desktop-touch) renders per the Config below. All UI copy comes from `maintenanceDesk.*`, `nav.maintenanceDesk` or `errors.*`.

**Block If:** none. All decisions below are fixed; any further ambiguity must be resolved by the implementer following the Always and Never rules, not by halting.

**Never:** No technician assignment (`assigned_to` absent), no triage priority override, no send-back-to-technician, no P1-P4 selector on accept, no free-text warranty reason, no new DOA types, no change to `sprint-status.yaml`, no push. Do not give the technician (`maint1@`) the desk: the desk row is never sent to a caller without an active DOA holding.

## Decisions fixed by this spec
- Desk nav: server `navigationFor` adds a `maintenance-desk` branch; the caller gets `Maintenance desk` only if `findFirstActiveDoaEntry(type)` plus `isActiveRoleHolderForEntry(entryId, userId)` is true for at least one of the three DOA types.
- Board groups: To triage = fault reports `reported`; Assigned / accepted = work orders `open` or `overdue`; In progress = `in_progress`; Waiting spares = `on_hold` (pill text = `status_note`); Done - sign-off = `completed` work orders whose asset status is `breakdown` or `maintenance`.
- Priority pill: work order `priority` P1-P4, else `Unset`. Fault cards show `Safety hazard` pill when `safety_flag`.
- Warranty pill shown when `warranty_flagged` and no override row. Override row is read per flagged card.
- Reject calls `POST .../fault-reports/:id/reject` with trimmed non-empty `rejection_reason`. The route exists server-side; the mock lacks it, so this is a recorded deviation.
- Priority: SLA policy read only (`policy.priority` returned from accept).
- Breakpoint and device layout: Desktop and desktop-touch render five columns; handheld and tablet render a grouped vertical list.
- Attention buttons: `Awaiting signature (n)` opens first Done card or announces `Nothing awaiting signature`; `Sync conflicts (n)` opens conflict panel; `Warranty-flagged (n)` opens first flagged card or announces `No warranty-flagged work orders`.
- Offline: last fetched board shown under banner `Offline - needs a live connection` with copy `Showing the board from the last sync. Signing, overrides, conflict resolution and triage are disabled until you reconnect.`; all actions disabled with reason; with no earlier fetch, the needs-connection card from `damage-cases.tsx` replaces the board.
- Reapplied centrally (`reapplied_centrally`) records only; card states so.

## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nav, DOA holder | caller holds active return_to_service DOA | nav includes `Maintenance desk` | none |
| Nav, technician | maint1@ with maintenance write only | no `Maintenance desk` row; deep link shows no-access card | none |
| Accept fault | fault reported, SLA policy exists | WO appears Assigned with SLA priority | 409 FAULT_ALREADY_TRIAGED, 422 SLA_POLICY_NOT_FOUND shown from errors.* |
| Reject fault | empty/whitespace reason | Reject disabled until trimmed reason non-empty | 400 shown if server refuses |
| Warranty override | flagged WO, reason tile chosen | card reads Warranty overridden with overridden_by/at | 409 WARRANTY_OVERRIDE_ALREADY_RECORDED, 409 WARRANTY_OVERRIDE_NOT_REQUIRED, 400 WARRANTY_OVERRIDE_REASON_INVALID, APPROVAL_REQUIRED, APPROVAL_UNRESOLVED |
| Sign return to service | completed WO, all 3 ticks | asset set running; card leaves group | 423 STATUTORY_EXAMINATION_OVERDUE, 409 APPROVAL_UNRESOLVED, 403 APPROVAL_REQUIRED, 400 INVALID_STATUS_TRANSITION; asset stays out of service |
| Resolve conflict | open conflict, tile + note <= 1000 chars | count drops | 409 SYNC_CONFLICT_ALREADY_RESOLVED, 404 SYNC_CONFLICT_NOT_FOUND, APPROVAL_REQUIRED, APPROVAL_UNRESOLVED |
| Offline | navigator offline | last board + banner; all actions disabled | no outbox write |
| List at 500 | any list returns exactly 500 rows | 500+ marker shown; worklist shows total not loaded | none |

## Code Map
- `src/api/v1/edge.ts:405-416` -- NAVIGATION_CAPABILITIES modules union; add `maintenance-desk`
- `src/api/v1/edge.ts:528-558` -- navigationFor if/else chain; add `hasMaintenanceDeskScope` (copy `hasIndentApprovalScope` async at :521)
- `src/api/v1/edge.ts:1240-1257` -- edge worklist response; add `status_note`, `fault_report_id`
- `src/api/v1/edge.ts:1327` -- GET /edge/maintenance/worklist route (limit 1-500)
- `src/api/v1/maintenance.ts:846` -- GET work-orders handler (returns raw row); add `asset_tag`
- `src/api/v1/maintenance.ts:1289` / `:1381` / `:1512` -- fault-reports list / accept / reject
- `src/api/v1/maintenance.ts:3964` -- setAssetStatusBase; DOA pattern at :4036-4047
- `src/api/v1/maintenance.ts:4195` -- asset-status list; add `asset_tag`, `asset_name`
- `src/api/v1/maintenance.ts:4590-4680` -- warranty override POST; `:4703` GET single override
- `src/api/v1/maintenance.ts:4864` -- getClosureCodesBase (mirror for reason codes)
- `src/api/v1/maintenance.ts:4878` / `:4941` -- sync-conflicts list / resolve
- `src/server.ts:1020-1023` -- fault-report routes; `:1107-1110` asset-status routes; `:1128-1132` warranty routes; `:1140` closure-codes (mirror target); `:1141-1143` sync-conflict routes; `:1500` worklist
- `src/config/index.ts:522` -- warrantyOverrideReasonCodes (defaults)
- `src/read/projections/doa_registry.ts:232` / `:426` -- findFirstActiveDoaEntry / isActiveRoleHolderForEntry
- `src/compliance/asset-operational-status.ts:46` -- RETURN_TO_SERVICE_DOA_TYPE; `src/compliance/maintenance-coverage.ts:80` WARRANTY_OVERRIDE_DOA_TYPE; `src/compliance/maintenance-sync-conflict.ts:42` SYNC_CONFLICT_RESOLUTION_DOA_TYPE
- `edge/src/components/app-shell.tsx:157-224` -- BaseView union, BASE_VIEW_ENTRY, isBaseView, VIEW_NAV_ENTRY; `:415-423` no-access card; `:519` maintenance view
- `edge/src/components/navigation/nav-model.ts:11-40` -- NAV_ENTRIES; copy the 3.20 row at :35
- `edge/app/maintenance/page.tsx` -- technician page; mirror for `edge/app/maintenance/desk/page.tsx`
- `edge/app/unloading/exceptions/page.tsx`, `edge/src/components/unloading-exceptions.tsx`, `unloading-exceptions-model.ts` -- page/model/device-class pattern
- `edge/src/components/damage-cases.tsx:41`, `:1068-1101`, `:1124` -- needs-connection card and offline pattern
- `edge/src/lib/use-device-class.ts:10-35` -- DeviceClass
- `edge/app/globals.css:213-214` -- `--touch-primary` 56px, `--touch-secondary` 48px
- `edge/src/messages/en.json` -- add keys (nav.maintenanceDesk, maintenanceDesk.*, nine errors.*); `:114`, `:119`, `:305`, `:311` existing errors whose wording is reused or varied
- `edge/test/unit/i18n-literals.test.ts:6` -- ALLOWED_LITERAL_PATTERNS; add `^maintenanceDesk\.`
- `edge/test/unit/nav-model.test.ts:50-57` -- entry assertion pattern
- `test/integration/story-3-19.test.ts:840-852` -- two-caller nav test pattern (use this, not story-1-15 deepStrictEqual)
- `test/integration/story-7-7.test.ts` -- warranty override fixtures
- Mock/reference: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-maintenance.html`; EXPERIENCE.md in same folder
- Audit fix-now item 5 (technician `Maintenance` nav row, G10/G18): not yet landed; see Tasks

## Tasks & Acceptance
**Execution:**
- [ ] `src/api/v1/edge.ts` -- add `maintenance-desk` to modules union, `hasMaintenanceDeskScope` (three DOA types, findFirstActiveDoaEntry + isActiveRoleHolderForEntry), and nav row `{ name: 'Maintenance desk', modules: 'maintenance-desk', functionScope: 'write' }` -- desk visibility is role-based, not module-based
- [ ] `src/api/v1/edge.ts` -- add `status_note` and `fault_report_id` to worklist response rows -- Waiting-spares pill text and fault linkage
- [ ] `src/api/v1/edge.ts` + audit item 5 -- add technician `Maintenance` nav row (maintenance module, read/write as audit G10/G18 specify; locate audit under `_bmad-output/` by grepping `G10`) -- sprint-change proposal requires it to land before 7.11; edits same tables
- [ ] `src/api/v1/maintenance.ts` -- add `asset_tag` to GET work-orders rows; add `asset_tag` and `asset_name` to asset-status rows (server-side join) -- board titles and Done group
- [ ] `src/api/v1/maintenance.ts` + `src/server.ts` -- add `GET /api/v1/maintenance/warranty-override-reason-codes` mirroring closure-codes, maintenance read permission, returns the configured catalogue -- reason tiles
- [ ] `edge/src/components/navigation/nav-model.ts` -- add `{ name: 'Maintenance desk', href: '/maintenance/desk', label: 'nav.maintenanceDesk' }` -- nav entry
- [ ] `edge/src/components/app-shell.tsx` -- add `maintenance-desk` to view union, BaseView, BASE_VIEW_ENTRY, VIEW_NAV_ENTRY -- deep link shows no-access card
- [ ] `edge/app/maintenance/desk/page.tsx` -- new page rendering the desk (mirror unloading exceptions page)
- [ ] `edge/src/components/maintenance-desk.tsx` + `maintenance-desk-model.ts` -- new board, group classification, attention buttons, triage, warranty, sign-off, conflict panel, offline handling, device layouts -- the story core
- [ ] `edge/src/messages/en.json` -- add `nav.maintenanceDesk`, `maintenanceDesk.*`, and nine `errors.*` keys (FAULT_ALREADY_TRIAGED, FAULT_REPORT_NOT_FOUND, SLA_POLICY_NOT_FOUND, WARRANTY_OVERRIDE_ALREADY_RECORDED, WARRANTY_OVERRIDE_NOT_REQUIRED, WARRANTY_OVERRIDE_REASON_INVALID, SYNC_CONFLICT_ALREADY_RESOLVED, SYNC_CONFLICT_NOT_FOUND, STATUTORY_EXAMINATION_OVERDUE); add maintenance-scoped variants for APPROVAL_UNRESOLVED, INVALID_STATUS_TRANSITION, ASSET_NOT_FOUND wording where the existing text does not fit -- copy
- [ ] `edge/test/unit/i18n-literals.test.ts` -- allow `^maintenanceDesk\.` -- literal guard
- [ ] `test/integration/story-7-11.test.ts` -- new: two nav callers (DOA holder sees row; maint1@ does not) via `/api/v1/edge/bootstrap`; reason-codes read; work-order and asset-status enrichment fields; worklist fields
- [ ] `edge/test/unit/nav-model.test.ts` -- assert new entry; `edge/test/unit/maintenance-desk-model.test.ts` -- group classification, attention counts, offline gating
- [ ] `edge/test/accessibility/maintenance-desk-accessibility.spec.ts` + e2e device-class pass -- axe zero WCAG 2.1 AA violations; keyboard-only; focus returns to board after panel closes
- [ ] `_bmad-output/implementation-artifacts/deferred-work.md` -- append deferred items: technician assignment, triage priority override, send-back, reapplied_centrally recording only, company-wide board (Q32)

**Acceptance Criteria:**
- Given an active DOA holder of any of the three types, when bootstrap runs, then navigation includes `Maintenance desk`; given maint1@, then it does not
- Given the board inputs loaded, when it renders, then five groups show counts, cards carry work_order_id or fault_report_id, P1-P4/Unset pill, asset_tag title, and the Warranty-flagged, Awaiting signature and Safety hazard pills as specified
- Given a reported fault, when Create work order is tapped, then accept is called with an empty body, the card appears Assigned with SLA priority read-only, and Reject requires a non-empty trimmed reason
- Given a flagged WO without override, when one reason tile and Override - repair in-house are used, then POST warranty-overrides runs and the card reads overridden text from the response
- Given a completed WO in Done with three ticks, when Sign return to service is tapped, then POST assets/:id/status with new_status running runs and the card reads Returned to service with sign_off fields
- Given an open sync conflict, when Resolve conflict is tapped with a tile, then POST resolve runs and the count drops
- Given the device offline, when the desk is open, then the last board shows under the offline banner, actions are disabled, and nothing is written to the outbox
- Given the four device classes, when axe and keyboard-only passes run, then zero WCAG 2.1 AA violations and all targets are 56/48/34 px

## Spec Change Log

## Review Triage Log

## Design Notes
Warranty pill needs one override read per flagged card; acceptable for the pilot board size (limit 500 each). Done group is derived client-side by joining completed work orders to asset-status by asset_id, so no new projection is needed.

## Verification
**Commands:**
- Root `npm test` -- expected: all server and integration suites pass, 0 new failures against baseline
- Edge unit tests and the new accessibility spec -- expected: pass
- `git status` -- expected: only intended files changed; `sprint-status.yaml` untouched
**Manual checks (if no CLI):**
- Desk page renders the five groups and the offline banner when the network is disabled
