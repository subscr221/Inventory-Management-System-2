# Epic 3 Context: Warehouse Operations and Frontline Capture Flows

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Gate officers, weighbridge operators and store assistants capture every inbound movement from vehicle entry to bin in seconds, gloved, one-handed, offline when needed. The system shows "Captured - pending sync" and never silently drops an event. Warehouse managers run the full physical cycle: receiving, system-directed putaway, picking, packing and shipping. Floor-level location overrides improve directed bins for the whole team. The edge PWA shell from Epic 1 is the platform; this epic builds the real capture flows and, from 3.13 on, the pilot frontline screen layer on top of existing backend capability.

## Stories

- Story 3.1: Warehouse Topology Setup
- Story 3.2: Gate Event Capture and Vehicle-to-PO Binding
- Story 3.3: Weighbridge Event Capture and Tolerance Enforcement
- Story 3.4: Goods Receiving Against ASN or PO
- Story 3.5: Directed Putaway and Location Override Recording
- Story 3.6: Pick Task Generation and Execution
- Story 3.7: Packing, Shipping, and Dispatch Documents
- Story 3.8: Warehouse Task Management and Productivity Tracking
- Story 3.9: Forward-Pick Replenishment
- Story 3.10: Cross-Docking Execution
- Story 3.11: GRN Line Condition and Reason Codes
- Story 3.12: Weighbridge Breach Task Routing for Pilot Roles
- Story 3.13: Gate Entry and Weighbridge Capture Screen
- Story 3.14: Stores Inbox, Scan Anything Bar and Acceptance into Inspection Bay
- Story 3.15: Directed Putaway Task Screen, Label Queue and GRN Read Card
- Story 3.16: Floor Task Inbox and Pick Execution Screen
- Story 3.17: Short Pick Exception Seam and Tiles
- Story 3.18: Pack Station and Dispatch Screen
- Story 3.19: Unloading Exception Commands (server)
- Story 3.20: Unloading Exceptions Screen

## Requirements & Constraints

- Captured frontline knowledge must visibly benefit the capturer: overrides update the directed-bin suggestion for everyone; confirmation below 95% is a defect.
- Offline capture must never lose an event; unsynced items show as pending, and permanently refused captures stay visible on the device as Needs attention with their error code.
- Quarantine zones (`access_restricted`) reject location writes from non-`qc_inspector` users at the location service, so putaway inherits the rule.
- Unmatched vehicles are captured as "unmatched", never turned away. PO references resolve against the read-only ERP open-PO projection (Story 2.9); no Epic 4 capability is needed.
- Pilot scope (sprint change 2026-10-21): 3.13 and 3.14 stay offline through the outbox. 3.15, 3.18 and 8.11 ship online-only, and each records that departure in Dev Notes and deferred-work. Challan resolution is online with a typed fallback, because no PowerSync bucket replicates purchase orders.
- Pre-pilot blocking: 3.13, 3.14, 3.15, 3.16, 3.18. Pilot: 3.17, 3.19, 3.20.
- Picking and packing layouts were drawn without user input. 3.16 and 3.18 begin with a validation walk on the staging preview or a recorded owner waiver.

## Technical Decisions

- Gate-token chain: the gate event creates the vehicle-to-PO binding token; weighbridge, receiving and putaway events reference it (as `correlation_id`).
- Event-sourced location: asserted versus expected location, with no last-writer-wins.
- Edge captures go through the outbox (`createOutboxEvent` and `insertCaptureEvent`), with photos in the pending-photo store. Refused syncs settle as needs_attention. Permanent error codes must be twinned on server and edge, with `en.json` strings.
- Trucks-on-site state is derived on the device from the synced `edge_site_events` bucket plus unsynced outbox rows.
- Role-scoped navigation: bootstrap NAVIGATION_CAPABILITIES rows with role-evaluated scope helpers, plus matching edge NAV_ENTRIES and labels. 3.13 owns the pattern. A write assignment satisfies a read check (the rbac rule), and gate and weighbridge `assertRoleAllowed` adopt it.
- Shared UI owned by early stories and reused later: ScanField (3.13), ScanAnythingBar and the grouped inbox list (3.14).
- New event types need registering in the closed sets: `pick_line.short_picked` (3.17) and `gate.matched` (3.19, with a replay guard). Receipt reason catalogue (3.11) gains the resolution-only `EXCESS_RETURNED_WITH_VEHICLE`.
- Every new route is added to the Story 1.9 spine allowlist, and new projections are pinned in schema-drift. Each new route carries an integration test.
- Over-tolerance acceptance posts at the band cap (ordered x (1 + tolerance) minus cumulative non-rejected received); resolution adds columns to `grn_line` rather than changing status.

## UX & Interaction Patterns

- Gloved, one-handed use: touch targets 56 px (handheld) and 48 px (tablet) on coarse pointer, 34 px on desktop. Stepper is single column on handheld, with the step list beside the form on tablet and up.
- Scan input accepts hardware trigger, keyboard wedge and camera on coarse pointer, with `Scan again` and `Type challan number` visible without scrolling at 360x640.
- Results announced via aria-live. Zero serious or critical axe violations and a keyboard-only pass are required. All strings come from `en.json`.
- Device-derived text state pills on inbox cards. Out-of-stamp weighbridge disables weighing with the reason in words while the gate entry stays submittable.

## Cross-Story Dependencies

- 3.2 and 3.3 depend on 2.9 (ERP inbound projections). 3.4 and 3.5 consume 3.1 topology and location rules.
- 3.13 depends on 3.2, 3.3, 3.12, 2.9, 1.14, 1.15 and 8.9, and is the base for 3.14, 3.15, 3.16, 3.18, 3.19, 3.20, 4.12, 7.11 and 8.11.
- 3.14 depends on 3.13 and 3.11. 3.15 depends on 3.14 and 8.10 (release of held lots). 3.16 depends on 3.13 and 3.6. 3.17 depends on 3.16. 3.18 depends on 3.13, 3.16 and 3.7.
- 3.19 depends on 3.2, 3.3, 3.4, 3.11 and 3.12; 3.13 is only a soft dependency, since tests seed unmatched events via the gate-events API. 3.20 depends on 3.19, 3.13 and 3.14.
- Epic 8 (8.9, 8.10, 8.11) and Epic 4 (4.11, 4.12) supply held-lot release, QC inbox and procurement notification pieces used here.
