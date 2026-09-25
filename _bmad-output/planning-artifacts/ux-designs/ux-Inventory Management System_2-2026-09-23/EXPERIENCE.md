---
name: Inventory Management System_2
status: draft
created: 2026-09-23
updated: 2026-09-25
sources:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md
  - _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/
---

# Inventory Management System_2 Experience Spine

This spine owns how the product works. `DESIGN.md` owns how it looks; tokens are referenced by name, for example `{colors.accent}` or `{spacing.touch-primary}`. Every rule here traces to `.memlog.md`. The clickable mocks in `.working/` illustrate these rules; where a mock and this spine disagree, the spine wins.

## Foundation

- Form factors: four device classes, chosen by viewport width plus pointer media queries, never by role or device name. Handheld is under 600px wide with a coarse pointer (rugged Android scanner or phone). Tablet is 600px to 1100px with a coarse pointer. Desktop is over 1100px with a fine pointer. Desktop touch is over 1100px with a coarse pointer. Breakpoints confirmed 2026-09-25 (Q1); pointer type decides compact or touch density.
- Every role can use the system on every device class. Role decides what a person sees; the device class decides how it is laid out and operated. Earlier per-role device answers mean "most common device", not "only device".
- There are no shared machine terminals. Everyone, including machine operators, works on their own signed-in device.
- UI system: the existing Next.js edge app with a plain CSS custom properties token layer and no component library. `DESIGN.md` is the visual reference (Zoho-style layout and interaction patterns, Lato type, per-site accent family with default `{colors.accent}` Ledger Blue for CMF-ALIGARH). No Zoho name, logo, icon or Puvi font is used.
- Offline-first: frontline capture runs against PowerSync-synced local rows and queues writes. Approvals, grant sends and revokes need a live connection (see State Patterns).
- Ergonomic wins over modern when the two conflict.

## Information Architecture

Modules follow the Zoho Books shape: module navigation, search, site switcher and a quick-create "+ New". Each person holds one or more role hats; the menu shows only the modules their active hat allows, and switching hat swaps home, modules and the pinned primary action. Every signed-in person also holds a base "employee" hat: raise a requisition, check stock availability, report damage, see their own requests and their own standing approvals.

Table 1 maps the nine surfaces to the roles that land on them and the mock that renders each.

Table 1: Surfaces, landing roles and mocks

| Surface | Landing roles | Mock |
|---|---|---|
| Gate entry | gate_officer, weighbridge_operator | [key-gate-entry](.working/key-gate-entry.html) |
| Stores (inbox, acceptance, putaway, issue, returns) | store_assistant (storekeeper) | [key-stores](.working/key-stores.html) |
| Warehouse floor tasks | warehouse_operator (picker), dispatch_clerk, unloading_supervisor | [key-floor](.working/key-floor.html) |
| QC workbench | qc_inspector, qc_head | [key-qc](.working/key-qc.html) |
| Approvals inbox | department_head, warehouse_manager, qc_head, maintenance_supervisor, finance_controller, cfo | [key-approvals](.working/key-approvals.html) |
| Maintenance | maintenance_technician, maintenance_supervisor | [key-maintenance](.working/key-maintenance.html) |
| Manager overview (desk) | site head / warehouse_manager, inventory_controller, finance_controller, internal_auditor (read-only), migration_lead | [key-desk](.working/key-desk.html) |
| Standing approvals module | head of department, site head, finance department head | [key-desk](.working/key-desk.html) |
| My requisitions | every employee (base hat) | [key-requisitions](.working/key-requisitions.html) |

The colour direction board is [color-themes-1](.working/color-themes-1.html). The earlier shared-terminal mock (key-shopfloor) is retired.

Module visibility and menus derive from the access matrix permissions (Q10); there is no separate menu list. On Handheld the bottom bar shows four items per role plus More. Home layouts for desk roles were drafted from role jobs and are validated with real users through the staging preview (Q9).

## Voice and Tone

Microcopy only; brand posture lives in `DESIGN.md` Brand and Style. Table 2 lists the fixed strings and the rule behind each.

Table 2: Microcopy rules and exact strings

| Situation | Say | Rule |
|---|---|---|
| Write queued offline | "Captured - pending sync" | State the fact; never imply failure. |
| Standing approval at issue | "Standing approval SA-2026-014 for Ramu (Cleaning gear). Storekeeper please issue." | Name the grant, the person and the item group on screen and on the slip. |
| Self-approval holder | "Self-approval limit Rs 25,000" | Never "No approval required" and never a grade word such as "junior". |
| Reporter after Report damage | "QC and finance will decide" | Reporters observe; they never give a verdict. |
| Visible damage at receipt | "Inspect on opening - damage suspected" or "Inspect on opening - damage observed" | A flag for the inspector, not a finding. |
| Excess on a PO line | "Excess - returned with vehicle" | Coded reason, not free text. |
| Grant review hint | "Consider revoking" | Shown on grants unused for 90 days. |

- Hyphenated plain English, short sentences, no exclamation marks, gender-neutral (they/their).
- Scan feedback is the match card itself, not a toast.

## Component Patterns

Behavioural rules only; visual specs live in `DESIGN.md` Components. Table 3 lists each pattern.

Table 3: Behavioural component patterns

| Component | Behaviour |
|---|---|
| Scan sink `{components.scan-bar}` | Always armed on scan-capable screens. Accepts hardware trigger or USB keyboard-wedge input into the focused field, camera scan, and "Type it" (focuses the field for manual entry). Manual entry is always available. |
| Scan anything bar | Pinned on top of the stores home. Scanning a rack, item, lot or challan offers the matching action. |
| Task inbox `{components.inbox-card}` | Stores home: arrived trucks awaiting acceptance, pending issues, returns, QC-cleared putaways. Gate hands over challan, supplier, PO lines and gate photo; nothing is retyped. |
| Stepper `{components.stepper}` | Next stays disabled until the current step resolves. At gate, Next waits until the challan match is accepted, rejected or typed. A submitted entry is locked. [ASSUMPTION] |
| Match card | Result of a challan QR resolved offline against synced PO/ASN rows. The officer accepts or rejects it. "Scan again" and "Type challan number" sit side by side and stay visible without scrolling on the 360x640 canvas. |
| Supplier picker | Fuzzy pick from the synced vendor master plus an "Unlisted supplier" option that flags the entry for stores to match later. The truck is never blocked. |
| Counted-qty line | UI computes remaining band = ordered x (1 + tolerance) minus already received, and caps posted qty to it. The remainder is recorded as "Excess - returned with vehicle" and is not posted. |
| Inspect-on-opening flag | Set at receipt with observation and photo; travels to the inspector. |
| Suggested rack | System-directed putaway after QC clearance. One-tap override "Choose another rack" (list or scan). Overrides teach the suggestion (Story 3.5 reslot). |
| Label print queue | Non-blocking. Acceptance completes first; the label queues with a Reprint action on the item. Every received lot gets a QR resolving to its GRN, PO line and rack. |
| Report damage | Universal action from any role and any device: scan the lot or item, reason, photo. Places the reported units on hold and opens a QC task. "Suspect whole lot" is a request only; the QC head decides. |
| Concurrence keys `{components.concurrence-keys-card}` | Two keys, QC and finance, on one damage case. Final only when both have concurred; disagreement escalates to the CEO. |
| Standing approval chips `{components.approval-class-chip}` | Mark requisition lines covered by a grant, with cap usage (for example "4 of 6 cans used this month"). |
| Device switcher | Mock-only demo control (Handheld, Tablet, Desktop, Desktop touch) that keeps state across switches. Not a product feature. |

## State Patterns

Table 4 lists the shared states and their treatment.

Table 4: State patterns

| State | Treatment |
|---|---|
| Offline or pending sync | `{components.sync-badge}` shows state; captures save locally as "Captured - pending sync". Gate, stores, QC observations, requisitions and damage reports all work offline. |
| Approval without connection | Approve and Reject are disabled with the reason shown. Approvals need a live connection on every device. Granting and revoking a standing approval also need a live connection. [ASSUMPTION] Maintenance triage changes are also disabled offline. |
| On hold | Stock under a damage report or quality hold is not issuable and never goes to the shelf. A lot-wide hold blocks Accept on the good part of the same lot until cleared. [ASSUMPTION] |
| Printer not ready | Acceptance still completes; the label waits in the print queue. |
| IRN block | [ASSUMPTION] Missing IRN blocks dispatch; billing is notified; the clerk can park the package and check again. The check needs the network. |
| Empty inbox | Plain statement of what is empty; the scan bar stays armed. |
| Over cap | Standing approval usage over the monthly cap falls back to normal approval. Received qty over tolerance is capped and the excess returned with the vehicle. |

## Interaction Primitives

- Density follows device input, not role: coarse pointer or small viewport is touch-roomy (`{spacing.touch-primary}` for the primary, `{spacing.touch-secondary}` for secondary), fine pointer is compact (`{spacing.control-compact}`). Gate on a desktop is compact like any desktop.
- Navigation by class: Handheld uses `{components.bottom-nav}`; Tablet uses `{components.icon-rail}`; Desktop and Desktop touch use the dark `{components.sidebar}` with top bar search, site switcher and "+ New".
- List-detail collapse: on Handheld a list item opens a detail page with Back; on Tablet and wider, list and detail sit side by side.
- On touch classes the primary action is full width and pinned in the bottom third.
- OCR (plate "Read from photo") is best-effort, pre-fills only, and never auto-submits; the officer always confirms. The challan QR resolves offline against synced POs.

## Accessibility Floor

- Every scan path has a typed equivalent reachable without scrolling.
- Match results and sync changes are announced through an aria-live region (the toast was removed, aria-live kept).
- Touch targets respect the density tokens above; nothing depends on colour alone (status pills carry text).
- Disabled actions state why they are disabled.
- Touch sizes are 56px primary and 48px secondary; desktop controls are 34px (Zoho density). Confirmed 2026-09-25 (Q2).

## Responsive and Platform

Table 5 gives the per-surface layout rule by class.

Table 5: Per-surface responsive rules

| Surface | Narrow (Handheld) | Medium (Tablet) | Wide (Desktop, Desktop touch) |
|---|---|---|---|
| Gate entry | Single column stepper; scanner screen is the tightest canvas | Step list beside the form | Step list left of form; photo via "Upload photo" or "Use webcam" [ASSUMPTION] |
| Stores | Inbox, then detail page; primary pinned | Inbox and detail side by side | Same, compact on Desktop |
| Floor tasks | One task page at a time | List and detail panes | List and detail; pack station with USB scanner [ASSUMPTION] |
| QC workbench | Inbox opens detail with Back | Two panes | Two panes |
| Approvals | Detail with pinned footer: Approve full width, Reject and Ask for info secondary | Two panes | Two panes |
| Maintenance | Supervisor board becomes a grouped list [ASSUMPTION] | Grouped list | Five-column kanban |
| Manager overview and Standing approvals | Modules under More; bell in user menu [ASSUMPTION] | Icon rail | Dark sidebar |
| My requisitions | Single column | Two panes | Two panes |

Known gap: on the stores Handheld mock the primary is pinned only on acceptance, not on putaway or scan-result screens; the pin rule above applies everywhere.

## Receiving and Damage Governance

- All received items land first in the inspection bay. Putaway to the suggested rack happens only after inspection clearance.
- Gate and stores report, they never judge damage. Damage is usually found when packaging is opened.
- Damage outcome is decided only by QC and finance, with concurrence of both, together or one after the other. If they disagree, the CEO decides.
- Hold scope: a report holds only the reported units. For a quality issue, a lot-wide hold (store, inspection bay and shop floor) is available; the reporter can only request it and the QC head decides.
- Report damage and Request replacement are one flow and are in pilot scope; the replacement becomes a requisition under normal rules.
- Receiving reason codes are fixed and grouped (at most four tiles per screen): SHORT, DAMAGED, REJECTED (wrong item or spec, to QC), OTHER (photo plus one line). Reason reporting is required at pilot.
- Wrong item or spec is never posted against the PO line.
- Finance damage outcomes are four: debit note to supplier, return to supplier for replacement, write-off, and accept as-is with a price reduction. The decision is recorded in IMS and executed in the ERP. A physical return is handled on paper until the Epic 20 gate passes.

## Requisitions and Standing Approvals

- Any employee can raise a requisition and check stock at any time.
- "Junior" is not defined. Approval exemption is a per-person STANDING APPROVAL (ref SA-YYYY-NNN) linking one person to an item or item group, with an optional monthly quantity cap (counts quantity issued) and end date.
- Grants and per-person self-approval limits are assigned by the site head or head of department and take effect after a one-time approval from the finance department head.
- Grants are revoked manually by the assigner at any time and automatically the same day the person's sign-in account is disabled.
- Pruning lists go to assigners and approvers in-app and by email, frequency selectable, default every 30 days, with last-period usage per grant.
- Requisitions without a grant go to the requester's head of department by value band until reporting lines exist.
- Two value bands at pilot: head of department up to Rs 1,00,000, finance controller above.
- The assigner may revoke a standing approval alone and instantly, with no finance approval. Granting and revoking need a live connection.
- [ASSUMPTION] A mixed requisition splits into one request per route; standing-approval items are counter stock, "Ready to collect" once synced; estimated value shows only to people with a self-approval limit.

## Approvals and Delegation of Authority

- One inbox for DOA approvals, damage cases, standing approval grants and self-approval limits. Approval types per role come from the DOA registry.
- Approving above one's band forwards to the next approver. [ASSUMPTION]
- In a damage case a concurrence can be withdrawn with a reason until both keys have turned. After both keys, the decision is locked; any correction is a new case linked to the old one (append-only). Decided items confirm inline and move to Decided with no undo. SLA hours shown are mock values.
- The QC inbox keeps the group "Sent on - finance or CEO".

## Key Flows

### Ramesh at the gate at 6am

Ramesh Yadav, gate officer, meets a truck at 6am with a handwritten challan and no QR. Ramesh taps "Type challan number" on the rugged scanner, then photographs the challan. The supplier is not in the vendor list, so Ramesh picks "Unlisted supplier". Climax: Next unlocks, Ramesh enters the vehicle number, submits, and sees "Captured - pending sync" while the gate has no signal. The truck rolls on; stores will match the supplier later.

### Suresh accepts a delivery

Suresh Verma, storekeeper, sees Ramesh's truck in their task inbox with challan, supplier and PO lines already filled. Suresh counts; the line is over tolerance, so the counted-qty line caps the posted qty and records "Excess - returned with vehicle". One carton is crushed: Suresh marks "Inspect on opening - damage observed" with a photo. Climax: Suresh accepts into the inspection bay while the label printer is offline; the label waits in the queue. After QC clears the lot, it appears as a putaway task, Suresh scans the suggested rack and the lot is on the shelf.

### A dead PCB on the line

Arjun Mehta (fictitious), machine operator, fits a PCB from an issued lot and finds it dead. On a personal phone, Arjun opens Report damage, scans the lot, picks "Dead on arrival - electronic" and requests a replacement in the same flow. The unit goes on hold and Arjun reads "QC and finance will decide". QC head Sunita Rawat inspects and records the QC key; the finance controller reviews the commercial outcome. Climax: both keys turn, the case is final, and the replacement requisition is already with the head of department. Had they disagreed, the case would have gone to the CEO.

### Ramu collects cleaning gear

Ramu, housekeeping, raises a requisition for phenyl. The line shows a standing approval chip, "4 of 6 cans used this month", and is ready to collect as soon as it syncs. Climax: at the counter the storekeeper's screen and slip read "Standing approval SA-2026-014 for Ramu (Cleaning gear). Storekeeper please issue." No approver was involved.

### The site head grants and prunes

The site head assigns a standing approval for a line technician's consumables and sends it while online; the finance department head gives the one-time approval in their Approvals inbox and the grant goes active. Thirty days later the pruning list arrives. Climax: one grant shows no use for 90 days with "Consider revoking"; the site head revokes it with a reason, and the list is shorter next month.

## Backend Dependencies

Found during mock review and recorded in `.memlog.md`:

- No "employee" base role exists; raising needs procurement write and stock lookup needs inventory read.
- Standing approvals, self-approval limits, caps, auto-revoke and pruning lists do not exist.
- Self-approval within a limit conflicts with SOD-01 and needs a spec change.
- Pre-pilot story: condition and reason code on GRN lines and the goods.received event, with damaged or rejected lines routed to quarantine with quality hold.
- Report damage needs ad-hoc QC task creation; a finance commercial outcome endpoint (debit note, return, write-off) is unverified.
- An indent with no band match is stored without an approver and then refused with NOT_RESOLVED_APPROVER, so it is stuck (compliance/indent.ts:599-603).
- Only amount-band indent rules are built; item category and department rules from Story 4.3 are not.

## Resolved Questions

All 14 open questions were resolved on 2026-09-25; the Resolved Questions table records each ruling.

| No. | Question | Ruling |
| --- | --- | --- |
| 1 | Device-class breakpoints | Under 600px, 600px to 1100px, over 1100px; pointer type decides compact or touch density |
| 2 | Touch sizes and desktop control height | Touch primary 56px, secondary 48px; desktop controls 34px |
| 3 | Does a rack override teach the system? | Yes, overrides teach the putaway suggestion (Story 3.5 reslot) |
| 4 | Who decides a lot-wide hold? | The reporter requests; the QC head decides |
| 5 | Finance damage outcomes | Debit note, return for replacement, write-off, or accept as-is with price reduction; recorded in IMS, executed in ERP; physical return on paper until Epic 20 |
| 6 | Requisition value bands | Head of department up to Rs 1,00,000; finance controller above |
| 7 | Standing approval revoke and offline behaviour | Assigner revokes alone and instantly, no finance approval; grant and revoke need a live connection |
| 8 | Concurrence ordering and irreversibility | Withdrawable with a reason until both keys turn; then locked, corrections are a new linked case |
| 9 | Screens not elicited | Validated with real users through the staging preview; weighbridge capture to be added to the gate screen |
| 10 | Module visibility and bottom-nav picks | Derived from the access matrix; four bottom-bar items per role plus More |
| 11 | QC inbox group "Sent on - finance or CEO" | Kept |
| 12 | "Hold for buyer decision" route for excess | Parked post-pilot |
| 13 | Plate reading and offline QR on the scanner | Plate reading best effort, always human-confirmed; challan QR resolves offline against synced POs |
| 14 | Site-configurable receiving reason labels | Parked post-pilot |

## Remaining Actions

- Confirm the scanner make and model and get one test device before pilot.
- Add weighbridge weight capture to the gate screen.
- Validate the screens drawn without user input (picking, packing and dispatch, maintenance, manager overview) with real users through the staging preview.
- Parked post-pilot: hold for buyer decision on excess, and site-configurable receiving reason labels.
