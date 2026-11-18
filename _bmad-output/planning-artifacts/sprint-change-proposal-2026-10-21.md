# Sprint Change Proposal - Edge Screens for the Frontline Spines (2026-10-21)

Status: Approved by default in autonomous session 2026-10-21; owner may revise
Author: correct-course workflow, session 2026-10-21
Trigger artifacts: `_bmad-output/implementation-artifacts/ux-screen-coverage-audit-2026-10-21.md` (sections 4 to 7), `ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md`, `DESIGN.md`, `mockups/key-*.html`, `src/api/v1/edge.ts:364-412`, `edge/src/components/app-shell.tsx:95-162`, `docs/migration/pilot-mock-extract/roles.json`

## 1. Issue Summary

The UX screen coverage audit of 2026-10-21 checked every screen named by the finalized spines (EXPERIENCE.md, DESIGN.md, the key mockups) against the edge PWA, the server routes and the story files. Of 93 screens, 25 are fully present, 6 are present but link-only, 17 are partial, 36 are missing, 7 are deferred by plan and 2 are built without a spec. A three-lens adversarial check confirmed 23 gaps (9 high, 6 medium, 8 low) and refuted one.

All nine high gaps share one root cause. Epics 3, 4, 7 and 8 closed their stories backend-only. The story text hands the screen to "the edge team" or "the central app" (Story 3.2 Dev Notes, Story 3.3 Task 6.3, Story 3.4 Task 8.3, Story 3.5 Task 8, Story 7.8 Decision 15, Story 8.1 UX boundary, Story 8.2 and 8.3 UX boundaries). No edge story was ever created for those screens. `edge/` is the only front end in the repository, so the pilot accounts provisioned in `roles.json` (gate1@, store1@, picker1@, dispatch1@, the department head and finance controller, maintsup1@, qc1@ and qchead1@) cannot complete their key flows from the PWA. Without the gate stepper no PO receipt is possible; without the approvals inbox UJ-IND-01 cannot complete through any UI; without the QC inbox nothing leaves ZONE-QC-HOLD from a screen.

This proposal adds thirteen stories under the four affected epics. Every story was drafted from the audit, then verified by two independent lens checks against the code, the spines and the mockups; refuted acceptance criteria were dropped and the confirmed corrections applied. The per-story verification notes are in Table 2.

## 2. Impact Analysis

### Epic impact

- Epic 3 (Warehouse Operations, in-progress since the 2026-09-26 reopen) gains eight stories, 3.13 to 3.20: the gate and weighbridge capture, the stores inbox and acceptance, directed putaway with the label queue, the floor pick inbox, the short-pick seam, the pack station, and the unloading exception commands and screen. Stories 3.2, 3.3, 3.4, 3.5, 3.6 and 3.7 keep their done status but their records are annotated (Table 5).
- Epic 4 (Procurement, in-progress) gains 4.12 (approvals inbox and requisition approval detail) and 4.13 (ask for info). Story 4.11 is done but uncommitted and must be committed before 4.12 branches. Story 4.3 Dev Notes :148-157 are superseded by 4.12.
- Epic 7 (Maintenance, in-progress) gains 7.11 (maintenance supervisor desk). Audit fix-now item 5 (technician Maintenance nav row, gaps G10 and G18) edits the same navigation tables and must land first.
- Epic 8 (Quality Control, in-progress since the 2026-09-26 reopen) gains 8.10 (receipt-lot QC task, QC-governed release, QC head gate, server) and 8.11 (QC inbox, inspection detail and disposition, edge).
- No epic flips from done. No story is invalidated. The sequencing change is that the inbound chain (3.13, 3.14, 8.10, 8.11, 3.15) now precedes everything else in the backlog.

### Story-level conflicts found during verification

- Story 3.5 is done in sprint-status.yaml:941 while all nine tasks in its story file (:43-87) are unticked. Task 8 (edge offline acceptance) was never built. Table 5 reconciles the record.
- Story 3.7 story file reads Status: review (:7) while sprint-status.yaml:943 reads done.
- Story 8.9 story file reads Status: in-progress while sprint-status.yaml:1152 reads done.
- Story 3.6 AC 6 (edge scan confirmation) and AC 7 (completion) are satisfied by the API only; `pick_task.completed` is a supervisor command (`src/compliance/pick.ts:29`, `:808-821`) and operator completion is the inline finalization on the last confirm (`:612-628`).
- Story 3.11 fixed the receipt reason catalogue to SHORT, DAMAGED, REJECTED, OTHER (`src/compliance/receiving-reasons.ts:7-11`); 3.19 widens it with a resolution-only code.

### Artifact conflicts

- EXPERIENCE.md:236 still says breach tasks target `receiving_supervisor`; code routes to `unloading_supervisor` since Story 3.12 (`src/compliance/weighbridge.ts:18`). Table 5 carries the fix.
- EXPERIENCE.md:99 commits stores, picking and packing captures to offline operation. Stories 3.15, 3.18 and 8.11 ship online-only for pilot; each records the departure in Dev Notes and in deferred-work.md, and Section 6 asks the owner to confirm. 3.13 and 3.14 keep their captures offline through the existing outbox.
- EXPERIENCE.md:81, :123 and :256 (resolved question 13) say the challan QR resolves offline against synced PO and ASN rows. No PowerSync bucket replicates purchase orders today (`sync/sync-rules.yaml`). 3.13 resolves online with a typed fallback for pilot; Section 6 asks whether to add the bucket now.
- EXPERIENCE.md:103 and mock key-floor.html L465 say billing is notified automatically on a missing IRN; nothing in `src/` notifies billing. 3.18 omits the sentence and the record fix amends the spine.
- Access matrix (access-matrix-frontline-draft-2026-07-11.md) has no Record IRN capability row and gives `store_assistant` no read on gate or weighbridge events (:195-196); 3.14 adds a receiving-scoped arrivals read instead of widening those roles and the matrix gains an R.
- deferred-work.md:1157 was already closed by Story 8.9 AC 9 (`src/compliance/receiving.ts:1530`); the open path is the clean BIS or quarantine_required lot, which 8.10 gates. deferred-work.md:1160 ("no upload endpoint for reason_photo_ref") is stale since `PUT /api/v1/attachments/:attachmentId` (`src/server.ts:886`).
- Audit section 7.2 item 3 bundles ask-for-info into the approvals story; this proposal carves it out as 4.13 so 4.12 adds no new event.

### Technical findings that shape the stories

- `NAVIGATION_CAPABILITIES.modules` is a closed union `readonly string[] | '*' | 'refused-captures' | 'damage-cases'` (`src/api/v1/edge.ts:364-368`) and `navigationFor` branches on each literal (`:400-420`). Every role-scoped entry (gate, pack-dispatch, unloading-exceptions, approvals, maintenance-desk) widens that union and adds a `hasXScope` branch modelled on `hasDamageCaseScope` (`:389-398`).
- The no-access card renders only for views in `BaseView` and `BASE_VIEW_ENTRY` (`edge/src/components/app-shell.tsx:130-152`, `:349-358`); each new view joins those tables and the duplicate union in `edge-client.tsx:214-227`.
- The edge app has no dynamic route segments (`edge/app/damage/cases/page.tsx` comment); records are selected by query string.
- `gate.ts` and `weighbridge.ts` `assertRoleAllowed` require `functionScope` to match exactly (`src/api/v1/gate.ts:76`, `src/api/v1/weighbridge.ts:81`) unlike `src/middleware/rbac.ts:165-168`, so write-only pilot roles are refused on every read. 3.13 aligns both.
- The bootstrap returns `site_id` (UUID) and a config `site_name`, not `site_code_ext` or `gate_id` (`src/api/v1/edge.ts:452-460`); `gate.entered` requires both (`src/compliance/gate.ts:69-75`). 3.13 extends the bootstrap.
- `pick_task` is one SKU per task (`src/read/projections/pick_task.ts:85`); the mock's five-item pick list is illustrative.
- No ScanField or scanner component exists under `edge/src/components`; scan handling is inline in four capture components. 3.13 builds the shared one.
- Zero `errors.*` strings exist for the indent decision codes, the putaway completion codes, the maintenance triage, warranty, sync-conflict and statutory codes, or the QC disposition and hold codes; each story adds its keys to `edge/src/messages/en.json`.

## 3. Recommended Approach

Direct Adjustment (Option 1): add thirteen stories under the existing epic structure, keep every affected epic in-progress, and stage nine of the thirteen as pre-pilot blocking. Rollback is not applicable; nothing shipped is wrong, it is incomplete. An MVP cut is not viable because each blocking story is the only UI for a provisioned pilot role's key flow, and the audit's fix-now list (nine small items) does not touch any of the nine high gaps.

Effort by size, from Table 1: one XL (3.13), eight L (3.14, 3.16, 3.18, 3.19, 4.12, 7.11, 8.10, 8.11), three M (3.15, 3.17, 3.20) and one S-M (4.13). The thirteen stories are a complete frontline screen layer and together they exceed any previous sprint-change batch; the owner should expect the pre-pilot set alone to take longer than the two-story pre-pilot pair of the 2026-09-26 proposal did.

Risk: medium. The server changes are small and each sits beside an existing seam, but five stories widen role gates (3.13 ASN and gate reads, 3.14 arrivals read, 4.12 approve, reject and detail read, 8.10 disposition gate, 3.19 procurement notification grant) and two add new event types (3.17 `pick_line.short_picked`, 3.19 `gate.matched`). Each carries an integration test and the Story 1.9 spine allowlist update. The layout risk is explicit: EXPERIENCE.md:262 marks picking, packing and dispatch layouts as drawn without user input, so 3.16 and 3.18 start with a validation walk on the staging preview.

Pilot timeline impact: the pre-pilot set must land before the cutover rehearsal. The staging runbook gains rows 2.10m (3.14), 2.10n (4.12) and 2.10o (3.18); 2.10l is already Story 4.8 (`docs/migration/pilot-cutover-runbook.md:135`).

## 4. Detailed Change Proposals

### 4.1 New stories

Table 1 lists the proposed stories; the full story text with acceptance criteria is appended to epics.md under each epic.

Table 1: Proposed stories

| Id | Title | Epic | Priority | Size | Gaps | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 3.13 | Gate Entry and Weighbridge Capture Screen | 3 | PRE-PILOT BLOCKING | XL | G01, G02 | One edge screen with two tabs: a four-step gate stepper (challan scan with online ASN then PO match and typed fallback, mandatory photo, vehicle, supplier with Unlisted supplier) writing `gate.entered` to the outbox, and a Trucks on site tab with weigh-in and weigh-out writing `weighbridge.recorded`; builds the shared ScanField; Task 1 opens ASN and gate reads to the gate roles, extends the bootstrap with `site_code_ext` and `gate_id`, adds `supplier_ref_ext` to `gate.entered`, adds a stamp-status read and twins `WEIGHBRIDGE_OUT_OF_STAMP` |
| 3.14 | Stores Inbox, Scan Anything Bar and Acceptance into Inspection Bay | 3 | PRE-PILOT BLOCKING | L | G03, G04, G11, G21 (part) | Stores inbox with the four mock groups and a conditional Done today section, Scan anything bar, multi-line acceptance with the Story 3.11 reason tiles, the over-receipt cap and condition quantities, offline capture; re-homes `/stores/issue` under AppShell; Task 0 adds a receiving-scoped arrivals read and provisions the inspection bay; Task 1 adds the inspect-on-opening and material photo fields |
| 3.15 | Directed Putaway Task Screen, Label Queue and GRN Read Card | 3 | PRE-PILOT BLOCKING | M | G05, G04 (label queue) | Ready putaway tasks as a group on the stores inbox, detail with suggestion, scan-or-type rack confirmation and fixed override reasons, device-local label queue with QR deep link, GRN read card; online-only with the door refusal for `putaway.completed` made explicit |
| 3.16 | Floor Task Inbox and Pick Execution Screen | 3 | PRE-PILOT BLOCKING | L | G08 (picker) | Floor tasks inbox and three-step scan flow (bin, lot, quantity) writing `pick_line.confirmed` through the outbox; server finalizes the task inline; Task 1 enriches pick lines with codes and the list with SO number and line counts; wrong lot refused at scan, hold read from synced `held_lot` |
| 3.17 | Short Pick Exception Seam and Tiles | 3 | PILOT | M | G08 (short pick) | New `pick_line.short_picked` event, `short` line status, found-quantity stock move with remainder release, pick_shortfall projection, photo-less damage case for DAMAGED, planning notification, the four mock tiles on the 3.16 screen; lot substitution exception flow moves here |
| 3.18 | Pack Station and Dispatch Screen | 3 | PRE-PILOT BLOCKING | L | G08 (pack and dispatch) | Pack and dispatch list by stage (Task 1 list route over dispatch_order_status joined to erp_sales_order and dispatch_irn), pack station with lot scan and carton weight, document generation and print, IRN blocked card with Check IRN again and Record IRN, confirm dispatch; online-only for pilot; validation walk with dispatch1@ first |
| 3.19 | Unloading Exception Commands (server) | 3 | PILOT | L | G08 (unloading, server) | `gate.matched` event and match-po command, accept-within-band posting the capped quantity with `EXCESS_RETURNED_WITH_VEHICLE` as a resolution-only reason code, send-to-procurement with a receiving_exception projection and a procurement notification grant, `unloading-exceptions` nav scope |
| 3.20 | Unloading Exceptions Screen | 3 | PILOT | M | G08 (unloading, edge) | One inbox of unmatched vehicles and over-tolerance lines with Resolved today, detail pages that match to a PO by typed or scanned number, accept within band and return the excess, or hold the vehicle and ask procurement; online-only |
| 4.12 | Approvals Inbox and Requisition Approval Detail | 4 | PRE-PILOT BLOCKING | L | G06 | Approvals inbox (Waiting, Decided, All) with the mock cards and table, requisition detail with route chips, DOA note, evidence and history, Approve and Reject with reason; Task 1 adds `pending_for_me` and `decided_by_me` list filters, a reverse delegation lookup, and admits the resolved approver to detail, approve and reject without procurement write |
| 4.13 | Requisition Ask for Info | 4 | PILOT | S-M | G06 (ask for info) | `indent.info_requested` event and request-info route, read row, requester notification, both door refusals, Info asked status block on 4.12 and a chip on My requests |
| 7.11 | Maintenance Supervisor Desk | 7 | PRE-PILOT BLOCKING | L | G09 | DOA-holder-scoped desk with five groups (To triage, Assigned / accepted, In progress, Waiting spares, Done - sign-off), attention buttons, create work order from a fault report, warranty override by configured reason code, return-to-service sign-off, sync-conflict resolution; adds the warranty override reason-code read and eight error strings |
| 8.10 | Receipt-Lot QC Task, QC-Governed Putaway Release, Observation Note and Photo (server) | 8 | PRE-PILOT BLOCKING | L | G07 (server) | `goods_receipt` source type for qc_inspection_task opened from the receiving seam when an approved plan resolves, accept disposition releases the held putaway composed with the 8.9 damage-case gate, free-text observation note with attachment, QC head gate on disposition and split returning `APPROVAL_REQUIRED`, enriched task view |
| 8.11 | QC Inbox, Inspection Detail and Lot Disposition (edge) | 8 | PRE-PILOT BLOCKING | L | G07 (edge) | QC inbox with the mock groups and armed scan bar, inspection detail with sampling, results, observations and photo, disposition with hold scope and split, holds page with offline held_lot read; online-only writes |

### 4.2 Verification notes

Table 2 records, per story, what the two lens checks refuted and what this proposal changed in response. Every correction below was confirmed against the cited file and line before it was applied.

Table 2: Verification notes

| Story | Verification notes |
| --- | --- |
| 3.13 | ASN read was 403 for gate roles (`src/api/v1/asn.ts:18`, `:27-30`, `:242-245`): Task 1 opens it. Gate and weighbridge list reads use a strict `functionScope ===` check (`gate.ts:76`, `weighbridge.ts:81`) that refuses write-only holders: Task 1 adopts the rbac.ts rule. Bootstrap lacks `site_code_ext` and `gate_id` (`edge.ts:452-460`) which `gate.entered` requires (`compliance/gate.ts:69-75`): Task 1 adds them. `WEIGHBRIDGE_OUT_OF_STAMP` is in neither PERMANENT_ERROR_CODES twin and has no string: added. Trucks on site now derives from the synced `edge_site_events` bucket (`sync/sync-rules.yaml:2-5`) so the tab works offline. Supplier step restored per EXPERIENCE.md:82 and UJ-GATE-01 step 3 with optional `supplier_ref_ext` on the event. AUTO reading source has no indicator link: button rendered disabled with reason, deferred. Offline PO match kept as an owner question (spine says offline, no bucket exists). Mock breach-owner copy lines corrected to L375, L466, L473, L761. Epics insert point corrected to before `## Epic 4` (:1726). |
| 3.14 | `store_assistant` cannot read gate or weighbridge events (`gate.ts:33`, `weighbridge.ts:32-36`): Task 0 adds `GET /api/v1/receiving/arrivals` under receiving read. Server band is `ordered x (1 + pct / 100)` cumulative with REJECTED excluded (`receiving.ts:755-770`, `:820-825`): cap formula corrected. Server forces DAMAGED and REJECTED rows to ZONE-QC-HOLD (`receiving.ts:1109-1122`): target clause corrected. No inspection bay location is provisioned anywhere: Task 0b. GOOD lines already create a ready putaway task (`receiving.ts:1155`): Cleared by QC group carries an Awaiting QC caveat until 8.10. Story 3.11 additive pattern is a separate ALTER-only file pinned by name (`src/events/migrate.ts:328-330`): AC 7 corrected. No field carries a general material photo: `material_photo_ref` added as a fourth additive field. Four groups per mock L430 and L480 with Done today conditional (L614-621); unmatched entries pilled Match supplier (L443, L484); four fixed short tiles (L437); no Split control; GRN label QR moved to 3.15. Runbook row corrected to 2.10m. Stores issue keeps its own `['warehouse']` entry. |
| 3.15 | Suggestion route is `PUTAWAY_EXECUTE_ROLES = ['store_assistant']` (`putaway.ts:39`, `:207-208`): non-store roles get 403, detail renders read-only. `LOCATION_ACCESS_DENIED` is thrown in `api/v1/putaway.ts:142`, `:167`, not compliance; missing strings list corrected and extended with `PUTAWAY_TASK_REQUIRED`, `PUTAWAY_COMPLETION_EVENT_MISSING`. No override reason list exists anywhere (server validates presence only, `compliance/putaway.ts:205-214`) and the payload has no free-text field (`api/v1/putaway.ts:330-337`): client-defined fixed tiles, no free text. No dynamic routes: deep link becomes `/stores/grn?grn=<id>&line=<id>`. List rows carry IDs only (`putaway_task.ts:11-43`): codes resolved per row. `directed_location_code` is null until the suggestion call (`putaway.ts:233-248`): pill shown only when set. Door accepts `putaway.completed` unstamped (`edge.ts:353`, `store.ts:1037`): in-story explicit refusal. Spine puts putaway on the Stores inbox (EXPERIENCE.md:79, :134; mock L423, L430): no new nav row. Spec line numbers corrected (:37, :134, :142, :245-246). |
| 3.16 | `pick_task.completed` is SOD-gated to warehouse_manager and inventory_controller (`pick.ts:29`, `:808-821`) and the server finalizes inline (`:612-628`): AC 6 rewritten, no completion event from the picker. `status` query takes one value (`pick-tasks.ts:282`): two fetches. List rows carry no line counts or SO number (`pick_task.ts:272-274`): Task 1b. Directed-lot hold is not reported at scan: hold read from synced `held_lot` (`edge/src/local-db/schema.ts:191-203`, `held-lot.ts:22`, `:35`). Mock refuses a non-directed lot at scan (key-floor.html L919): substitution moves to 3.17. Focus stays on the scan field (EXP:74, :119). No assignment check exists in `pick.ts`: unassigned tasks are actionable. Short pick button disabled with reason instead of invented notice. |
| 3.17 | Confirm seam lines corrected (`pick.ts:393-630`, `:464-480`, `:639-757`, `:830-832`). Standard `damage.reported` needs a photo (`schema.ts:5649`, `damage.ts:684-685`): photo-less opener modelled on `openReceiptDamageCase` (`damage.ts:1865-1890`) with source widening. No `pick_shortfall` or `short` status exists (`init-db.sql:2827`): both listed as new work. No "fully picked" flag exists; `dispatch_order_status.picked_at` insert (`pick.ts:748-756`) named. No short-pick row exists in deferred-work.md: a new row is added and closed. EXPERIENCE.md:87 is the Report damage row. Tile labels from key-floor.html L521. |
| 3.18 | `hasGateScope` does not exist yet; predicate modelled on `hasDamageCaseScope` with the union widened. `dispatch_order_status` has no `documents_generated_at`; stage derived from `dispatch_document` existence and `dispatch_irn` join. `GET /dispatch/:id/irn` returns 404 `DISPATCH_IRN_NOT_RECORDED` when still blocked (`dispatch.ts:756-762`): treated as blocked, not failure. Pack payload needs `carton_count` on every line (`dispatch.ts:224-228`). Documents default to four types (`dispatch.ts:37`, `:387`), not the mock's three. Offline pack is a spine departure (EXP:99) with a server door already accepting the events: recorded as an owner ruling. Park at bay has no state: disabled, deferred. Record IRN is not in the mock: owner question, default yes. Validation walk added (EXP:262, mock L463). Runbook row 2.10o. |
| 3.19 | `grn_line.status` is constrained to posted, quarantined, rejected and the band sums non-rejected lines (`receiving.ts:759-760`): resolution is new columns, not a status change. `EXCESS_RETURNED_WITH_VEHICLE` needs a catalogue extension (`receiving-reasons.ts:7-11`). No DOA type for tolerance acceptance exists and the capped quantity is inside the band by construction: DOA clause dropped; the 5 percent band stays with the 3.12 deferred weighbridge items. `gate.matched` must be registered in three closed sets and `upsertGateEvent` needs a replay guard (`gate_event.ts:163-166`). Procurement officer holds no notification grant (`roles.json:507-519`): pilot pack change added. Send-to-procurement scoped to unmatched vehicles (mock L798). Unmatched events are creatable today (`gate.ts:211-214`): 3.13 is a soft dependency. EXPERIENCE.md:64 corrected to :63. |
| 3.20 | `GET /api/v1/purchase-orders` is the native PO list under procurement read (`purchase-orders.ts:617-620`) and 403 for the supervisor: PO picker uses `GET /api/v1/erp/purchase-orders/:poNumber`. Discrepancies list has no status filter (`receiving.ts:545-572`) and rejected rows are posted outcomes: over-tolerance rows come from the 3.19 exception list. Weighbridge breach row removed: acknowledge needs notification write which unload1 lacks, the list carries no notification id, and the spine places breaches on the gate surface (EXP:90). Density follows pointer, not class (EXP:97, :120). Unlisted supplier resolve flow recorded as deferred with its reason. |
| 4.12 | `assertIndentReadAccess` (`indents.ts:223-233`) refuses the staging finance_controller on the detail: Task 1 widened. No reverse delegation lookup exists (`doa_registry.ts:267-286` is keyed by delegator): new helper. None of the decision codes has an `errors.*` key: added. Runbook row 2.10l is Story 4.8: 2.10n. Mock detail has no per-line checkbox (key-approvals.html L625-656) and the server derives the pending set (`indents.ts:955-956`): checkboxes dropped. Tablet and Desktop touch are 56/48 px (DESIGN.md:224-229). Mock card and table columns adopted (L598-603, L613-615). Requisition-only scope recorded as a deviation from EXPERIENCE.md:169. Epics insert point corrected to before `## Epic 5`. |
| 4.13 | `INDENT_EVENT_TYPES` is :35-45 with the applier at `store.ts:1183`; the two doors refuse with different codes (`events.ts:560-569` FUNCTION_ACCESS_DENIED; `upload.ts:385-398` CENTRAL_ONLY_OPERATION). Approver is per line since 4.10 (`indent.ts:943-975`). My requests reads only the list endpoint (`my-requests.tsx:249`): list rows gain the latest question. No edge notifications surface exists: scoped to persistence. Send question is the primary in the mock (L712) with Cancel; Ask for info hidden for standing-approval items (L735-736). |
| 7.11 | Warranty override takes `reason_code` from a configured catalogue (`maintenance.ts:4307-4362`), not free text; no route exposes the catalogue: added. Only the edge worklist returns `truncated` (`edge.ts:968-976`) and it excludes completed rows (`maintenance_work_order.ts:444`): completed group fetched separately. `safety_flag` lives on the fault report (`maintenance_fault_report.ts:13`). Eight error codes have no string: added. Statutory lockout code is 423 `STATUTORY_EXAMINATION_OVERDUE` (`maintenance.ts:3712-3722`). Sync-conflict note field is `resolution_note` max 1000. Attention chips open the first matching card (mock L1030-1032), they do not filter. Mock column labels kept (L814-815). `AD-9` reference replaced by deferred-work row 512. Epics insert point corrected to before `## Epic 8` (:2730). |
| 8.10 | Plan resolver is `resolveInspectionPlanForLot` (`quality.ts:1898-1993`), throws rather than returns null and needs a `bom_revision_id`: non-throwing wrapper and nullable BOM for receipt tasks. Source type allow-list and CHECK constraint (`quality.ts:264-268`, `qc_inspection_task.sql:73`) widened. Release composes with `assertDamageCaseAllowsRelease` (`receiving.ts:1530`). Gate code is `APPROVAL_REQUIRED` per codebase convention (`api/v1/quality.ts:1428-1437`), not a new code. 3.14 inspect-on-opening dependency dropped from this server story; it reads the 3.11 reason columns. deferred-work.md:1157 already closed by 8.9. |
| 8.11 | `task_status` is single-valued (`quality.ts:853-875`). Task status never leaves `inspected`; disposition fields come from 8.10. Observations route is a per-characteristic readings batch (`quality.ts:1198-1230`): free-text note is 8.10 work. Disposition is module qc write for any holder (`quality.ts:2217-2220`): QC head gate is 8.10. Holds body is `lot_id` plus `hold_reason`. Whole-lot hold blocks Accept on the good part (EXP:101, mock L497). Release has a retention-sample gate. `held_lot` bucket has no site column. `qc.result_recorded` is admitted by the door (`upload.ts:343`); online-only is a choice and is recorded as such. Damage reported renders the open cases as cards (mock L565, L687-692). Scan bar added (EXP:107, DESIGN:262). |

### 4.3 Build order and dependencies

Table 3 gives the build order from the dependency judge, with the reason for each position.

Table 3: Build order

| Order | Story | Why here | Depends on |
| --- | --- | --- | --- |
| 1 | 3.13 | First link of the inbound chain; every receipt needs its binding token and accepted weighment (`src/compliance/receiving.ts:228-233`, `:840-865`); owns ScanField, the photo outbox pattern and the role-scoped nav token pattern | 3.2, 3.3, 3.12, 2.9, 1.14, 1.15, 8.9 (done); edge Phase 1 (563d246) |
| 2 | 3.14 | Consumes 3.13 tokens; owns ScanAnythingBar and the grouped inbox list; adds the fields 8.11 shows | 3.13; 3.4, 3.11, 3.12, 3.1, 1.14, 1.15, 4.11 (done) |
| 3 | 8.10 | Can run in parallel with 3.14; nothing leaves ZONE-QC-HOLD from a screen without it | 8.1, 8.2, 8.3, 8.5, 8.9, 3.11 (done) |
| 4 | 8.11 | Needs 8.10; closes the QC half of the inbound chain | 8.10; 3.14 (acceptance fields); 8.9, 1.14, 1.15 (done) |
| 5 | 3.15 | Needs the 3.14 completion screen (label queue host) and 8.10 release so held lots reach ready | 3.14, 8.10; 3.5, 3.4, 1.14, 1.15, 4.11 (done) |
| 6 | 4.12 | Independent of the inbound chain; unblocks UJ-IND-01 and the 4.11 issue flow on staging | 4.10, 4.3, 1.15, 1.8 (done); 4.11 committed first; 4.8 (review) for standing approval chips only |
| 7 | 3.16 | Needs the 3.13 ScanField; outbound chain start | 3.13; 3.6, 1.13, 1.14, 1.15 (done) |
| 8 | 3.18 | Needs 3.16 picked orders and the 3.13 nav token pattern | 3.13, 3.16; 3.7, 11.2, 3.6, 1.15, 4.11 (done) |
| 9 | 7.11 | Independent; audit fix-now item 5 first | fix-now item 5; 7.3, 7.6, 7.7, 7.8, 1.14, 1.15, 8.9 (done) |
| 10 | 3.17 | PILOT; after 3.16 is live | 3.16; 3.6, 8.9 (done) |
| 11 | 3.19 | PILOT; unmatched entries exist today, 3.13 is the pilot producer | 3.2, 3.3, 3.4, 3.11, 3.12 (done); 3.13 (soft) |
| 12 | 3.20 | PILOT; after 3.19 | 3.19; 3.13 (ScanField); 3.14 (handoff to the stores inbox) |
| 13 | 4.13 | PILOT; after 4.12 | 4.12 |

### 4.4 Shared prerequisites

Table 4 lists the components and patterns more than one story needs and which story owns each.

Table 4: Shared prerequisites

| Prerequisite | Owner | Reused by | State today |
| --- | --- | --- | --- |
| ScanField component (hardware trigger, keyboard wedge into the focused input, camera on coarse pointer, Scan again and Type side by side, aria-live result) | 3.13 | 3.14, 3.15, 3.16, 3.18, 3.20, 8.11 | No scanner component exists under `edge/src/components`; scan handling is inline in cross-dock-capture.tsx, indent-capture.tsx, report-damage.tsx and fault-report-capture.tsx |
| ScanAnythingBar (code resolver over ScanField) and the grouped inbox card list | 3.14 | 3.15, 3.16, 8.11 | Not built |
| Role-scoped NAVIGATION_CAPABILITIES sentinel plus `hasXScope` helper (`src/api/v1/edge.ts:364-420`) | 3.13 (`gate`) | 3.18 (`pack-dispatch`), 3.19 (`unloading-exceptions`), 4.12 (`approvals`), 7.11 (`maintenance-desk`) | Two instances exist: `refused-captures` and `damage-cases`; the modules union must be widened per sentinel |
| Offline capture with pending photo and refused-capture landing for a new event type (`outbox-event.ts:3`, `outbox.ts:42`, `pending-photos.ts:72`, `connector.ts` PERMANENT_ERROR_CODES, `test/unit/edge-permanent-error-parity.test.ts`) | 3.13 | 3.14, 3.16, 3.17 | Pattern exists from 3.3 and 8.9; each story adds its codes to both twins |
| Needs-connection card and re-fetch on online for online-only views (check-stock.tsx, damage-cases.tsx:41, Story 1.14 Task 3.7) | existing | 3.15, 3.18, 3.20, 4.12, 7.11, 8.11 | Exists; bootstrap navigation is not cached offline (deferred-work.md:1116) so the header entry is absent offline |
| AppShell view union, BaseView and BASE_VIEW_ENTRY no-access gating (`app-shell.tsx:95-162`, `edge-client.tsx:214-227`) | existing (1.15) | every screen story | Each story adds its own view and row; 3.14 also re-homes `/stores/issue` (G11) |
| Bootstrap `site_code_ext` and `gate_id` | 3.13 | 3.14 (arrivals read by site code), 3.19, 3.20 | Bootstrap returns `site_id` UUID and config `site_name` only (`edge.ts:452-460`) |
| Audit fix-now item 5 (technician Maintenance nav row, G10 and G18) | fix-now list | 7.11 | Edits the same tables as 7.11; land first |
| `errors.*` strings and `ALLOWED_LITERAL_PATTERNS` in `edge/test/unit/i18n-literals.test.ts` | each story | all | No decision, putaway, maintenance desk or QC disposition strings exist |

### 4.5 Record fixes for prior stories

Table 5 lists the edits to earlier story files and planning artifacts that this proposal requires. They are applied by the create-story or dev-story of the story named in the Owner column, not by this proposal.

Table 5: Record fixes

| Artifact | Fix | Owner |
| --- | --- | --- |
| 3-2 story Dev Notes :102 | Note that `createGateEnteredEvent` has no UI caller; 3.13 owns the screen | 3.13 |
| 3-3 story Task 6.3 (:67) and open question 2 (:134, :196-200) | Annotate as API and edge intake only; the form is 3.13; close question 2 as an extension of the Gate entry surface (EXPERIENCE.md:36) | 3.13 |
| mockups/key-gate-entry.html L375, L466, L473, L761 | Breach owner copy "receiving supervisor (Mahesh Tyagi)" to unloading_supervisor (`src/compliance/weighbridge.ts:18`); correct audit :463 which cites L476-477, L482 | 3.13 |
| EXPERIENCE.md:236 | Breaches route to unloading_supervisor since Story 3.12; the sentence about reaching nobody is resolved | 3.13 |
| EXPERIENCE.md Resolved Questions | Add rows for the accepted pilot deviations: desktop photo is upload only (webcam post-pilot), OCR plate pre-fill deferred, online challan match with typed fallback pending the sync bucket ruling | 3.13 |
| edge/test/e2e/offline-shell.spec.ts:13-19 | gate_officer navigation fixture gains `Gate entry`; bootstrap fixtures gain `site_code_ext` and `gate_id` | 3.13 |
| 3-4 story Dev Notes :100 and :175; Task 8.3 | Pointer to 3.14 (acceptance) and 3.20 (exception resolution); AC 5 wording: the durable discrepancy task is a notification today (`receiving.ts:1048-1061`), 3.19 adds the resolved state | 3.14, 3.19, 3.20 |
| 3-11 story Dev Notes :88 and Table 1 | Annotate what 3.14 picks up (reason tiles, cap); capped excess owner is 3.19; `EXCESS_RETURNED_WITH_VEHICLE` added as a resolution-only code | 3.14, 3.19 |
| deferred-work.md:1158-1159, :1160, :1306 | 3.14 builds the inspect-on-opening flag and the client-side cap; :1160 is stale since `PUT /api/v1/attachments/:attachmentId` (`src/server.ts:886`); :1306 online-only issues precedent cited | 3.14 |
| access-matrix-frontline-draft-2026-07-11.md:195-196 | Add R for store_assistant on the receiving arrivals read | 3.14 |
| 4-11 story Change Log | `/stores/issue` re-homed under AppShell as view `stores-issue` with its own entry | 3.14 |
| 3-5 story Tasks 1 to 7 and 9 (:43-87); Dev Notes :142 | Tick with a reconciliation note dated 2026-10-21; leave Task 8 unticked pointing at the deferred-work row 3.15 adds; at :142 note that touch targets are 56/48 px and desktop 34 px (EXPERIENCE.md:123), slide-to-confirm is not in DESIGN.md, and the edge putaway screen is 3.15 | 3.15 |
| deferred-work.md (new section "Deferred from: create-story of 3-15") | Offline `putaway.completed` through the edge door (actor stamping and execute-role gate absent, `edge.ts:353`, `store.ts:1037`); suggestion alternatives; stock-by-location read; server label print queue | 3.15 |
| deploy/rehearsal/mock/operations-smoke.ts:206 | Override reason `OPERATOR_CHOICE` aligned with the 3.15 client list | 3.15 |
| 3-6 story Dev Notes | AC 6 scan confirmation and AC 7 completion are satisfied by the API only; the screen is 3.16; `pick_task.completed` is a supervisor command (`pick.ts:29`) and operator completion is inline finalization (`pick.ts:612-628`); open question 5 placeholder stays | 3.16 |
| deferred-work.md (new row under 3-6) | Short-pick exception flow deferred by the review at `src/compliance/pick.ts:466-471`, closed by 3.17; rows 161 and 162 (deferred-work.md:105-106) interact with the remainder release; remove the comment at pick.ts:466-471 when 3.17 lands | 3.17 |
| 3-7 story :7 | Status review versus sprint-status done; set to done; AC 1 (epics.md:1589-1591, packing station operator) is satisfied by the API only, the screen is 3.18 | 3.18 |
| EXPERIENCE.md:103, Backend Dependencies :225-236; key-floor.html L465 | Remove or make a backend dependency of "billing is notified"; add who records the IRN; add no parked-package state, no vehicle number on dispatch.dispatched, no e-way bill document, no scale integration; footnote :99 that packing capture is online-only in pilot | 3.18 |
| access-matrix-frontline-draft-2026-07-11.md section 3.3 or 3.6 | Add a Record IRN capability row: dispatch_clerk C, warehouse_manager C, gst_officer R | 3.18 |
| deferred-work.md (new rows under 3-18) | Park at bay, e-way bill, scale read, billing notification, vehicle number, offline pack capture (edge side; server door exists) | 3.18 |
| docs/migration/pilot-cutover-runbook.md | Rows 2.10m (3.14), 2.10n (4.12), 2.10o (3.18) | 3.14, 4.12, 3.18 |
| 3-12 story :46 items (a), (b), (d) and :51, :75 | Items (a) and (b) remain deferred with no owner; (d) edge inbox owner is 3.20 for unloading exceptions only; band row is at access matrix :394, not :303 | 3.19, 3.20 |
| deferred-work.md:1169-1172 | First bullet (capped excess not built) owner 3.19; edge inbox owner 3.20; unlisted-supplier match-to-vendor flow not built because gate.entered takes supplier from the matched PO | 3.19, 3.20 |
| Audit G08 (:225-235), 7.3 | Owner story ids 3.16 to 3.20; add the offline-resolve ruling and the breach-surface placement to spec clarifications | 3.20 |
| 4-3 story :148-157 | Superseded by 4.12 | 4.12 |
| 4-10 story :208; 4-11 story D11 | Annotate that 4.12 adds the approver detail and list filters; D11 online-only precedent cited | 4.12 |
| deferred-work.md:1182 | 4.12 takes the approve, reject and detail-read half (gate widened to the employee hat); confirm, withdraw and cancel remain deferred | 4.12 |
| Audit 7.3 item 5 and G06 (:205, :209, :465) | 4.12 does not remove `/workflows`; Ask for info moves to 4.13 | 4.12, 4.13 |
| deferred-work.md (new rows under 4-13) | Requester reply channel; edge notifications bell (Shell Phase 2); line-scoped questions if the pilot asks | 4.13 |
| epics.md:2674 (Story 7.8 note); 7-8 story :58 Decision 15 | Supervisor desk is Story 7.11 | 7.11 |
| deferred-work.md:46 (row 512), :387 (row 406) | Row 512 unscoped sync-conflict read cross-referenced; row 406 (no edge surface for the warranty override) partially closed by 7.11; three new deferred rows: technician assignment, triage priority override, send back to technician | 7.11 |
| edge/src/components/app-shell.tsx:42-46 | Stale comment on the maintenance view | 7.11 |
| src/api/v1/maintenance.ts:874 | Stale INVALID_PARAMS message lists three statuses; validator accepts five | 7.11 |
| EXPERIENCE.md:138 | Ruling: Assigned / accepted column reads work orders open or overdue with no assignment at pilot | 7.11 |
| deferred-work.md:456 (row 583), :1157 | Row 583 updated to point at 8.10 AC 4 (QC head gate overrides the "reject needs no second signature" ruling); :1157 marked resolved by 8.9 and a new line added for the clean BIS or quarantine lot path | 8.10 |
| 8-3 story UX Boundary :713-720 | Pointer to 8.11 | 8.10 |
| 8-9 story file Status | in-progress versus sprint-status done; set to done once Task 13.5 staging run is recorded | 8.11 |
| 8-1 story :460-465, 8-2 :152-154, 8-3 :121-124 | Cited as the reason the G07 gap exists ("no UI or edge screen is required") | 8.11 |
| deploy/rehearsal/mock/out/MOCK-MUTT2R97/roles.json:374-393 | Rehearsal roles grant module `quality`, not `qc`; add a qc assignment or the QC inbox entry never appears on the rehearsal stack | 8.11 |

### 4.6 Evidence map

Table 6 traces each story to the audit gap and the spine evidence.

Table 6: Story evidence

| Story | Evidence |
| --- | --- |
| 3.13 | Audit :148-169 (G01, G02), :459, :463, :477, :484; EXPERIENCE.md:36, :77-82, :90, :99-107, :111-123, :133, :176-182, :209-215, :236, :252, :256; DESIGN.md:226-231, :256-288; mockups/key-gate-entry.html L373-381, L436-446, L586-613, L682; `src/compliance/gate.ts:55-91`, `src/compliance/weighbridge.ts:73-102`, `:146-216`, `:293-314`; `roles.json:297-310` |
| 3.14 | Audit :170-191 (G03, G04), :403, :461-474; EXPERIENCE.md:37, :77-86, :99-107, :119-123, :134, :142, :146-152, :184-190; DESIGN.md:254-269, :278-292; mockups/key-stores.html L420-447, L480, L517, L601-679, L849-856; `src/compliance/receiving.ts:228-233`, `:734-770`, `:820-865`, `:1109-1155`; `src/compliance/receiving-reasons.ts:7-22`; `roles.json:317-336` |
| 3.15 | Audit :192-202 (G05), :461-464, :483; EXPERIENCE.md:37, :79, :85-86, :99-108, :119-123, :134, :142, :146, :184-190, :245-246; DESIGN.md:75-77, :226-229, :256-268; mockups/key-stores.html L423, L430-434, L442-447, L480-482, L606, L611, L616-619, L682-748, L963; `src/api/v1/putaway.ts:33-39`, `:149-358`; `src/compliance/putaway.ts:25-213`; `src/warehouse/putaway-suggestion.ts:12-22`; 3-5 story :43-87 |
| 3.16 | Audit :225-235 (G08), :467; EXPERIENCE.md:38, :72-76, :99-107, :109-123, :135, :141, :262; DESIGN.md:254-290; mockups/key-floor.html L450-468, L461, L467, L515-519, L594-651, L617-619, L669-731, L732-737, L906-974; epics.md:1536-1575; `src/compliance/pick.ts:29`, `:136-153`, `:393-630`, `:808-821`; `src/read/projections/pick_task.ts:85`, `:265`, `:272-274` |
| 3.17 | Audit :225-235; EXPERIENCE.md:38, :87, :99, :135, :262; mockups/key-floor.html L462, L466-468, L521, L670-671, L688-700, L706, L717-722, L729-730, L964-974; `src/compliance/pick.ts:464-480`, `:612-629`, `:639-757`, `:830-832`; `src/compliance/damage.ts:1865-1890`; `read/projections/damage_report.sql:94-96`; `init-db.sql:2785-2789`, `:2827` |
| 3.18 | Audit :225-235, :467; EXPERIENCE.md:38, :77-80, :99-107, :103, :109-123, :135, :262; DESIGN.md:254-320; mockups/key-floor.html L437, L450-473, L463-465, L557-590, L624-646, L736-779, L857; epics.md:1576-1600; access matrix :206-214, :252-259; `src/api/v1/dispatch.ts:43-115`, `:173-765`; `src/compliance/dispatch.ts:603-645`; `src/read/projections/dispatch_order_status.ts:7-38`; `roles.json:576-589` |
| 3.19 | Audit :225-235, :467; EXPERIENCE.md:38, :63, :83, :90, :105, :187, :209-215, :255, :259-263; DESIGN.md:280; mockups/key-floor.html L15, L471-472, L524-529, L786-822, L988; access matrix :48, :178, :188-198, :364, :394; `src/compliance/gate.ts:13`, `:123-132`; `src/read/projections/gate_event.ts:163-166`, `:198`; `src/compliance/receiving.ts:738-770`, `:1003-1061`; `roles.json:346-366`, `:505-520` |
| 3.20 | Audit :225-235; EXPERIENCE.md:38, :83-85, :97-108, :115-123, :135; DESIGN.md:254-286; mockups/key-floor.html L463-464, L471-473, L510-530, L589, L632-646, L782-836; access matrix :48, :195-198, :394; 3-12 story :46, :51; deferred-work.md:1116, :1169-1170; `src/api/v1/gate.ts:32`, `:365-454`; `src/api/v1/erp-projections.ts:424-427`; `src/api/v1/purchase-orders.ts:617-620` |
| 4.12 | Audit :203-213 (G06), :424, :465; EXPERIENCE.md:19-40, :99-100, :108-123, :137, :155-172, :201-207, :225-249; DESIGN.md:187-201, :224-229, :254-304; mockups/key-approvals.html L389, L393-394, L428-451, L519-618, L625-656, L704-736, L827-851; Story 4.3 :146-157; 4.10 :208; 4.11 :73, :119; `src/api/v1/indents.ts:223-233`, `:406-416`, `:489-495`, `:931-1057`, `:1142-1150`; `src/compliance/indent.ts:278-303`, `:861-979`, `:1082-1120`; `src/read/projections/doa_registry.ts:218-357`; `deploy/provision/staging-bootstrap-accounts.sh:103-105`; `deploy/provision/staging-doa-bands.sh:58-59` |
| 4.13 | Audit :203-213, :465, :470; EXPERIENCE.md:23, :100, :137, :139, :169-173; mockups/key-approvals.html L389, L405, L529, L546, L704-716, L725, L733-736, L872-880, L899-902; `src/compliance/indent.ts:35-45`, `:62-66`, `:890-975`, `:1082-1097`; `src/api/v1/events.ts:557-569`; `src/sync/upload.ts:385-398`; `src/api/v1/edge.ts:554`; `edge/src/components/my-requests.tsx:225-249`; `test/integration/story-1-9.test.ts:372-385` |
| 7.11 | Audit :97-100, :236-256 (G09), :455, :468; EXPERIENCE.md:28, :41, :48, :100, :107, :111-123, :138, :262; DESIGN.md:187-201, :254-320; mockups/key-maintenance.html L425-446, L477-478, L568, L814-923, L1030-1032; epics.md:2650-2702; `src/api/v1/maintenance.ts:1277-1538`, `:3696-3786`, `:4307-4456`, `:4590-4756`; `src/api/v1/edge.ts:968-1092`; `src/read/projections/maintenance_work_order.ts:444`; `src/config/index.ts:517-525`; world.json:961-979; `roles.json:478-498` |
| 8.10 | Audit :214-223 (G07), :466; EXPERIENCE.md:39, :99, :136, :146-149, :190, :232-233, :247; mockups/key-qc.html:368, :459-462, :557-661; 8-3 story :121-124, :713-720; deferred-work.md:456, :1157, :1159; `src/compliance/quality.ts:264-268`, `:675-682`, `:1898-1993`, `:1995-2160`, `:2508-2530`, `:3845-3852`; `src/compliance/receiving.ts:1104-1155`, `:1436-1556`; `read/projections/qc_inspection_task.sql:73`; `init-db.sql:9785-9818`; `src/config/index.ts:652` |
| 8.11 | Audit :214-223, :466; EXPERIENCE.md:39, :61-62, :87-88, :99-107, :101, :111-123, :136, :146-149, :172, :190, :197, :254; DESIGN.md:220-227, :258-268, :286-288, :306-308; mockups/key-qc.html L409-429, L459, L497, L535-542, L565, L577-679, L687-692; `src/api/v1/quality.ts:853-875`, `:1198-1230`, `:1335`, `:1522-1640`, `:2183-2242`, `:2308-2381`; `sync/sync-rules.yaml:27-29`; `src/sync/upload.ts:335-359`; `docs/migration/pilot-mock-extract/roles.json:549-573` |

### 4.7 Sprint status updates (applied with this proposal)

- `epic-3` stays in-progress; comment appended: reopened again 2026-10-21 by the ux screen coverage audit (G01 to G05, G08). Keys `3-13` to `3-20` added after `3-12` (sprint-status.yaml:948) and before `epic-3-retrospective`, status backlog.
- `epic-4` stays in-progress; keys `4-12` and `4-13` added after `4-11` (:964); note that 4-11 is done but uncommitted and must be committed before 4-12 branches.
- `epic-7` stays in-progress; key `7-11` added after `7-10` (:1139) and before `epic-7-retrospective`.
- `epic-8` stays in-progress; keys `8-10` and `8-11` added after `8-9` (:1152) and before `epic-8-retrospective`.
- The `last_updated` header comment is updated.
- epics.md gains the thirteen story sections under their epics, each before the next `## Epic` heading.

## 5. Implementation Handoff

Scope: Moderate (backlog reorganisation; no replan). Route to the Developer agent via the normal story cycle: create-story, validate, dev-story, code-review per story, in the Table 3 order. The create-story of each story applies the Table 5 record fixes named for it and resolves the Section 6 question defaults it depends on unless the owner has ruled otherwise by then.

Sequencing rules:

1. Commit Story 4.11 before 4.12 branches.
2. Land audit fix-now item 5 before 7.11.
3. Run the 3.16 and 3.18 layout validation walks on the staging preview (EXPERIENCE.md:262) before their builds, or record the owner's waiver in the story file.
4. 3.13 builds ScanField first inside its Task 2 so the five consumers can start once 3.13 reaches review.

Success criteria: sprint-status.yaml and epics.md updated (done with this proposal); thirteen stories reachable by create-story; the nine PRE-PILOT BLOCKING stories done, deployed to staging and their runbook rows (2.10m, 2.10n, 2.10o) passed before the cutover rehearsal; each pilot account named in Section 1 completes its key flow from the PWA on staging; `edge:test`, the axe suites and the i18n literal guard green for every new page.

## 6. Open Questions for the Owner

Table 7 lists the questions the verification left open, each with the default the stories assume. The owner may revise any default; a revision changes the named story before its create-story runs.

Table 7: Open questions and defaults

| Id | Story | Question | Default assumed |
| --- | --- | --- | --- |
| Q1 | 3.13 | Offline PO and ASN match: add the GLOBAL PowerSync bucket `erp_open_purchase_orders` now (EXPERIENCE.md:81, :123, resolved question 13) or resolve online with typed fallback for pilot? | Online for pilot with the deviation recorded; bucket as a follow-up story. The owner may rule it into 3.13 (then 3.13 splits into 3.13a server contract and bucket, 3.13b screen) |
| Q2 | 3.13 | What does the pilot challan QR encode? | ASN number first, then PO number; a typed challan stays unmatched (UNKNOWN) |
| Q3 | 3.13 | Desktop photo path? | File upload for pilot; webcam post-pilot |
| Q4 | 3.13 | Where do `site_code_ext` and `gate_id` come from on the device? | Bootstrap returns `site_code_ext` from location_register for the operating site and `gate_id` from edge config (default GATE-01); one gate per site at pilot |
| Q5 | 3.13 | Indicator link protocol for the weighbridge AUTO reading? | Post-pilot; every pilot reading is MANUAL and the button is disabled with the reason |
| Q6 | 3.14 | GOOD lines already create a ready putaway task at acceptance (`receiving.ts:1155`), so Cleared by QC cannot distinguish cleared stock until 8.10 gates held lots. Ship the group with a caveat pill or hide it until 8.10? | Ship with an Awaiting QC caveat pill on tasks whose GRN line has no QC clearance; 8.10 replaces the pill with a real filter |
| Q7 | 3.14 | Cache inbox lists offline (mock L517, EXP:23) or ship online-only as 4.11 did? | Online-only for pilot with the needs-connection card; Done today merges the local outbox so an offline acceptance is visible immediately; deviation logged |
| Q8 | 3.14 | Material photo field: new additive `material_photo_ref` on goods.received and grn_line, or attachment by convention only? | Additive field, fourth in the Story 3.11 pattern |
| Q9 | 3.15 | Rack scan mandatory? | Scan or typed code mandatory; Type it is the fallback |
| Q10 | 3.15 | Override reason tile codes (EXPERIENCE 2026-07-12 section 4.4 :305 says they are configuration)? | Client-defined set under `putaway.overrideReason.*`: RACK_FULL, DAMAGED_RACK, NEARER_BAY, OPERATOR_CHOICE, OTHER; the server stores any string |
| Q11 | 3.15 | QR library? | Small pure-JS QR dependency added to edge/package.json and recorded in the story |
| Q12 | 3.16 | Inbox scope: assigned only or also unassigned at site? | Assigned first, then unassigned at site, both actionable (the server permits confirm without assignment); no self-claim UI because assign is PICK_SUPERVISE_ROLES only |
| Q13 | 3.16 | Widen PICK_COMPLETE_ROLES to warehouse_operator for own-task completion? | No; SOD rule from Story 3.6 Task 6.2; the server finalizes inline on the last confirm and the supervisor completes from the task board |
| Q14 | 3.17 | Planning notification target role? | production_planner at the task site via NotificationTarget.location_id (`src/notify/emit.ts:6-16`); warehouse_manager as fallback if planning is ruled a dispatch concern |
| Q15 | 3.17 | Does a dispatch order with short lines reach Ready to pack with the found units, or is it held for planning first? | Reaches packing with the found units; the pick_shortfall row is the re-pick signal |
| Q16 | 3.18 | Who records the IRN in the app: dispatch clerk (code allows) or gst_officer (access matrix :259 marks R)? | Dispatch clerk and warehouse manager as the code already allows; access matrix gains a Record IRN row |
| Q17 | 3.18 | Pilot ships online-only pack against the EXP:99 offline commitment? | Yes for pilot; recorded in deferred-work.md and EXPERIENCE.md |
| Q18 | 3.18 | One carton per order for pilot? | Yes; `carton_count` 1 on the first packing line and 0 on the rest, `actual_weight_kg` on the first line only |
| Q19 | 3.18 | Package reference? | SO number as heading; deviates from the mock PKG-2026-0410 heading; no package numbering minted |
| Q20 | 3.19 | Weighbridge breach acceptance, escalation to warehouse_manager and acknowledgement UI (3-12 :46 items (a), (b))? | Stay deferred; 3.19 adds no breach command |
| Q21 | 3.19 | May warehouse_manager execute match-po directly (access matrix :197 marks A)? | Yes, as the escalation approver, through a role allowlist like UNMATCHED_READ_ROLES |
| Q22 | 3.20 | Online-only resolution against the mock's offline resolve (key-floor.html L467, L788)? | Yes; resolution mutates PO binding and GRN posting; recorded in EXPERIENCE.md and deferred-work.md |
| Q23 | 3.20 | Where does a weighbridge tolerance_breach surface for the unloading supervisor? | On the Gate entry surface per EXPERIENCE.md:90 (3.13 banner) with the notification inbox as the read path; 3.20 renders no breach rows |
| Q24 | 3.20 | Match-to-PO picker source? | Typed or scanned PO number through `GET /api/v1/erp/purchase-orders/:poNumber`; an open-ERP-PO list is 3.19 scope if the owner wants the mock L810 two-option picker |
| Q25 | 4.12 | Change the route gate or provisioning for the finance_controller? | Change the gates as in AC 3 (employee hat plus per-line identity) |
| Q26 | 4.12 | Inbox scope beyond requisitions? | Requisitions only in 4.12, recorded as a deviation from EXPERIENCE.md:169; a follow-up folds damage-case concurrence and grant decisions into /approvals with the type filter |
| Q27 | 4.13 | One open question per line or many? | One; a second replaces the status block text |
| Q28 | 4.13 | Add `indent_info_requested` to KNOWN_EVENT_TYPES (`src/api/v1/notification.ts:34`) for preference matching? | Yes, one line |
| Q29 | 7.11 | Technician assignment now? | Defer to a 7.12 if the pilot asks |
| Q30 | 7.11 | Persist the three sign-off ticks? | No; device-side gate only |
| Q31 | 7.11 | Keep Reject on the triage card (not in the mock) with `rejection_reason`? | Yes; the API exists and a board with no reject keeps spurious reports forever; recorded as a mock deviation |
| Q32 | 7.11 | Scope the five desk lists by permittedLocationsForModuleScope in this story or leave to deferred-work row 512? | Leave to row 512; company-wide board as shipped |
| Q33 | 8.10 | Open a task when no plan exists? | No; keep today's held putaway and notification, mark the hold reason "no inspection plan" |
| Q34 | 8.10 | Disposition and split by QC head only, overriding the 8-3 row 583 ruling? | Yes, via qcHeadRoles; row 583 updated |
| Q35 | 8.10 | How is `bom_revision_id` resolved for a purchased receipt lot when plans are BOM-keyed? | Nullable for goods_receipt tasks; plan resolved by item only |
| Q36 | 8.10 | A receipt with no lot_id: open no task, or mint a lot? | Open no task; mark the putaway hold reason "no lot" and keep the notification |
| Q37 | 8.11 | Whole-lot hold as part of the Record disposition tap? | Yes; hold first, then disposition; the card shows both outcomes and states the lot stays held until a two-tap hold release even after accept |
| Q38 | 8.11 | On hold as its own nav row? | Header link at pilot |
| Q39 | 8.11 | Do receipt lots need a retention sample before release? | 8.10 scopes receipt-sourced tasks out of the retention rule |
