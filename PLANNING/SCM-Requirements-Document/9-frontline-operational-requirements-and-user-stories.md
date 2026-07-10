# 9. Frontline Operational Requirements and User Stories

The functional requirements in Section 3 describe what the system does. This section makes the highest-impact frontline capabilities granular by expressing them as the day-to-day moments real operational staff experience, so that each requirement traces to a specific role, trigger, and measurable outcome. Nothing here replaces Section 3; each story elaborates one or more of those requirements.

## 9.1 Approach

Three operating principles govern the frontline design:

1. **Moments, not a flat list.** Frontline requirements are organized around operational personas (Section 5.3) and the moments they are in, expressed as user stories, rather than as an undifferentiated capability list.
2. **Role as a hat, not a badge.** Stories name a role, but any user may hold several roles, so the same story applies whether one person or a whole department performs it (see Section 5.3).
3. **Offline as normal.** Every frontline story assumes connectivity can drop, and treats offline capture and later reconciliation as a first-class path (see NFR-U-05 and NFR-DI-03).

**Prioritization rule for story depth.** Each candidate moment is scored on three axes, each from 1 to 5: **Pain** (how badly the current process hurts the person), **Frequency** (how often the moment occurs), and **Data-Integrity Risk** (how badly a fast, wrong entry poisons downstream roles). A moment scoring **45 or above** (out of 125), or scoring a **5 on Data-Integrity Risk alone**, earns a fully-worked story (Section 9.2). Everything else is captured as a one-line stub (Section 9.3) until its score justifies promotion. Data-Integrity Risk holds a veto because a wrong number entered quickly corrupts every downstream role.

**Story template.** Every frontline story is written to the same mold: a persona-and-moment line ("As a [role] [in the moment], I want [action], so that [benefit]"), two to three acceptance criteria in Given / When / Then form (always including an offline criterion where the moment happens on an edge device), and a success metric tied to Section 8.

## 9.2 Fully-Worked User Stories

### Story GATE-01: Log an Inbound Vehicle Under Pressure

Elaborates FR-W-02 (Receiving) and FR-O-06 (Order Status Tracking) at the inbound edge; depends on INT-GATE-01.

*As a Gate Security Officer receiving an inbound vehicle at 2am, I want to log the gate event against an expected ASN or PO even when the network is down, so that goods enter on a traceable record instead of a paper register and an informal messaging group.*

1. **AC1 (happy path):** Given a vehicle arrives with a challan referencing a known PO, When the officer scans or keys the PO and confirms vehicle and challan details, Then the system creates a queued gate event stamped with time, gate ID, and officer ID, and shows a "captured, pending sync" state.
2. **AC2 (offline):** Given the device has no connectivity, When the officer completes capture including a mandatory photo of the challan, Then the event persists locally, is assigned a provisional gate token, and auto-reconciles to the matching ASN or PO within 5 minutes of connectivity being restored, with any mismatch flagged for the store assistant rather than silently dropped.
3. **AC3 (exception):** Given no matching PO exists, When the officer logs the event, Then the system still captures it as "unmatched" and routes it to a named owner for resolution, so that nothing enters unrecorded.

**Success metric:** SM-13 (median gate dwell time at or below 4 minutes per vehicle, including offline); gate-origin data-entry error rate below 2%.

### Story WEIGH-01: Capture Trusted Weights at the Weighbridge

Elaborates FR-W-02 (Receiving) and FR-P-06 (Goods Receipt and Quality Inspection); depends on INT-GATE-01.

*As a Weighbridge Operator, I want to capture tare, gross, and net against the linked PO or ASN, so that receiving weights are trusted and discrepancies are caught at the gate.*

1. **AC1 (happy path):** Given a truck tied to a PO or ASN with a defined tolerance, When I record tare then gross, Then net auto-calculates, is validated within tolerance, and posts to the goods-receipt event with an accept status.
2. **AC2 (offline):** Given no connectivity, When I capture tare and gross, Then the reading is queued locally with a timestamp and device provenance stamp and reconciles on reconnect without operator re-entry.
3. **AC3 (exception):** Given net falls over or under PO tolerance, When I confirm the weight, Then the load is flagged as a discrepancy, blocked from silent receipt, and routed to a named owner (QC or Receiving supervisor) for disposition.

**Success metric:** SM-14 (weight-capture accuracy at or above 99.5%; receiving weight-discrepancy rate trended weekly).

### Story PUT-01: Directed Putaway with Locator Override Capture

Elaborates FR-W-03 (Putaway) and FR-I-01 (Multi-Location Stock Tracking); depends on INT-LOC-01.

*As a Store Assistant, I want scan-first directed putaway that lets me log any bin change as a correction event, so that slotting stays accurate and location confidence grows instead of living in one person's head.*

1. **AC1 (directed):** Given a directed bin, When I scan the item and the target bin, Then the system confirms the match hands-light (glove-friendly and one-handed) and records a putaway-confirmed event.
2. **AC2 (override as correction):** Given I place stock in a different bin, When I scan the actual location, Then the system records a locator-override correction event with a reason code, feeding the ABC re-slotting engine.
3. **AC3 (disputed reconcile):** Given the offline queue surfaces a physical override that conflicts with the ASN expected location, When it reconciles, Then the physical override becomes the authoritative physical-location fact with a provenance and confidence stamp, the ASN expected-location value is preserved rather than overwritten, and the conflict is surfaced for review. Last-writer-wins is banned for location.

**Success metric:** SM-15 (putaway accuracy at or above 98%; bin-location confidence coverage at or above 90%).

**Related voice-pick acceptance shape.** For the associated hands-free picking moment (stub PICK-VOICE-01): Given an active voice-directed pick, When the operator completes the line by voice confirmation, Then zero manual screen taps are recorded for that pick and pick error rate stays at or below 0.5%. Both taps and error rate are instrumented, so the criterion is fully verifiable.

### Story IND-01: Raise an Indent and Know What Happens to It

Elaborates FR-P-04 (Purchase Requisition and approval routing).

*As a floor supervisor with ninety seconds between tasks, I want to raise an indent from my phone and actually know what happens to it, so that I never chase, guess, or raise it twice.*

1. **AC1 (raise and duplicate check):** Given I have raised the same item within the open window, When I submit, Then the system warns me of the likely duplicate and confirms my indent with an ID in under 90 seconds.
2. **AC2 (visibility):** Given my indent exists, When I open the app, Then I see its live status (raised, approved, rejected, ordered, expected delivery) without contacting anyone.
3. **AC3 (decision push-back):** Given the department head decides, When they approve or reject, Then I receive a push notification carrying the decision and the reason.

**Success metric:** SM-16 (indent-to-decision cycle time; percentage of indents with raiser-visible status at all times; duplicate-indent rate).

## 9.3 Prioritized Story Stubs

These moments are captured now and promoted to fully-worked stories (Section 9.2) when their prioritization score justifies it. The following table lists the current stub backlog.

| Stub ID        | Persona and the one thing that must be true                                                                                                       | Related requirement |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| DH-APPROVE-01  | Department head clears or exception-flags indents from mobile with budget-remaining shown inline, batch-approves low-value items, and delegates when off-site. | FR-P-04             |
| PROC-REQ-01    | An approved indent becomes a requisition line automatically, with zero re-keying by the procurement executive.                                    | FR-P-04, FR-P-05    |
| QC-INSPECT-01  | QC inspector records per-PO-line disposition (accept, reject, partial), routes held quantity to quarantine, and only accepted quantity posts to goods receipt. | FR-P-06, FR-W-02    |
| UNLOAD-01      | Unloading supervisor records pallet or carton counts against the gate event with photo evidence.                                                  | FR-W-02             |
| DISPATCH-01    | Dispatch clerk confirms outbound load against the pick and generates shipping documents hands-light.                                              | FR-W-06, FR-O-06    |
| PICK-VOICE-01  | Store assistant completes a pick hands-free via voice, with a visual bin-map fallback.                                                             | FR-W-04             |
| RD-CUSTODY-01  | R&D store keeper issuing a Rs 8 lakh oscilloscope sees it recorded against a named custodian with a return date, not consumed - the custody register always answers "who has it". | FR-RD-05, FR-RD-06  |
| HUB-OFFLINE-01 | Maker-hub operator in a Saturday rush with the network down still closes a member's material sale and machine booking offline and trusts the sync.                                | FR-RD-14, FR-RD-15  |
| BOM-EFFECT-01  | Production planner: a work order released today explodes the BOM revision effective on its start date, even if a newer revision was approved yesterday.                           | FR-B-03, FR-B-07    |
| BOM-ASBUILT-01 | R&D engineer: after a pilot build, the as-built snapshot shows the substituted component and its lot number without retyping anything.                                            | FR-B-10             |
| MAINT-OFFLN-01 | Maintenance technician in a windowless DG yard closes the work order offline with parts, photos, and meter reading; it syncs untouched on return to coverage.                     | FR-M-17, NFR-U-05   |
| HUB-STATUS-01  | Maker-hub front-desk assistant: the laser cutter goes down at 10:00 and the 11:00 booking is already blocked, so the member is told before leaving home.                          | FR-M-04, FR-M-16    |
| QC-RELEASE-01  | QC Head: no lot leaves QC Hold for sellable stock or a dispatch document until a disposition recorded under QC release authority exists against it - rush orders included.        | FR-Q-02, FR-Q-05    |
| QC-CALIB-01    | Quality inspector: scanning an instrument past its calibration-due date, the system refuses the measurement entry and names an in-calibration alternative.                        | FR-Q-04, FR-M-13    |
| SCRAP-GATE-01  | Scrap yard custodian: a buyer's truck cannot clear the gate carrying one kilo more than the paid, invoiced quantity.                                                              | FR-SC-15, FR-SC-16  |
| SCRAP-LOT-01   | Disposal committee member: one screen shows a lot's source documents, weights, photos, and NRV before any approval is recorded.                                                   | FR-SC-01, FR-SC-10  |
| FA-CAPQ-01     | Plant accountant: when an overhaul work order closes, it appears in the capitalize-or-expense queue with cost and parts detail before period lock, so nothing capitalizable dies in repairs expense. | FR-FA-10, FR-M-15   |
| GST-ITCREV-01  | GST compliance officer: when written-off stock is destroyed, the ITC reversal computes from the original credit references without reconstructing invoices.                       | FR-AC-08, FR-SC-20  |
| PROD-TRACE-01  | Quality manager: given one FG lot, list every component lot and serial inside it, and every other FG lot sharing them, in one query.                                              | FR-MO-11, FR-Q-09   |
| PROD-OFFLN-01  | Production supervisor: the WAN drops mid-shift and issuing, completing, and scrap declaration continue; on reconnection nothing posts twice.                                      | FR-MO-13            |
| JW-CUSTODY-01  | Job-work coordinator hands any customer, on request, a custody statement whose balance matches physical stock to the last lot.                                                    | FR-JW-05, FR-JW-13  |
| JW-BILL-01     | Billing clerk receives every dispatched order with its measured basis already assembled; nothing invoices without a QC-passed dispatch behind it.                                 | FR-JW-11, FR-JW-12  |
| IM-DUTY-01     | Finance controller: when a BOE posts, IGST lands only in the ITC register while BCD, SWS, and freight land only in item cost.                                                     | FR-IM-03, FR-IM-05  |
| MSME-DUE-01    | AP clerk: every micro or small supplier invoice shows its MSMED s.15 due date and surfaces on the s.43B(h) risk ageing before year-end close.                                     | FR-P-09             |
| TOOL-CRIB-01   | Night-shift setter wearing the crib-attendant hat issues a die to a production order by scan in under 15 seconds with the network down, and the count lands right after sync.     | FR-TL-04, FR-TL-17  |
| TOOL-BOOK-01   | Maker-hub member sees at booking time that the router bit set is at regrind and books around it, instead of finding out at the counter.                                           | FR-TL-06, FR-TL-16  |
| GP-GATE-01     | Gate security officer: nothing non-sale crosses the gate without scanning a live gate pass, and the overdue register writes itself.                                               | FR-GP-09, FR-GP-11  |
| GP-CALIB-01    | Maintenance planner: the flow meter sent to external calibration gets chased home before the calibration-due and insurance windows lapse.                                         | FR-GP-03, FR-GP-10  |
| QC-WITNESS-01  | Dispatch supervisor: a job-work lot with an uncleared hold point and no recorded waiver cannot appear on any dispatch document.                                                   | FR-Q-15             |

## 9.4 Industry Practices Adapted

The features above adapt established practices from inventory, warehouse, and facility access-control platforms. The following table maps each practice to where it is applied.

| Practice                                | Where applied                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Directed putaway                        | PUT-01, so the store assistant is told the bin rather than guessing           |
| ABC slotting and re-slotting            | PUT-01 and INT-LOC-01, so confirmed overrides bend the slotting map to reality |
| Voice-directed picking                  | PICK-VOICE-01, so hands and eyes stay on the goods                            |
| Wave, zone, and batch picking           | FR-W-04, retained as pick-strategy options                                    |
| Put-to-light                            | Candidate for high-velocity zones (future stub)                               |
| Gate and weighbridge PO binding         | GATE-01, WEIGH-01, INT-GATE-01, common in yard-management and access control  |
| Offline-first store-and-forward capture | GATE-01, WEIGH-01, PUT-01, INT-LOC-01, standard in rugged warehouse mobility   |
| Mobile approval with inline budget      | DH-APPROVE-01, common in procure-to-pay suites                                |

## 9.5 How Frontline Capture Integrates with the Core System

The frontline stories are the edge-capture layer that feeds the core defined in Sections 3 through 6:

1. The gate and weighbridge events (INT-GATE-01) create the inbound record that FR-W-02 receiving and FR-P-06 goods receipt consume.
2. The QC inspector's per-line disposition determines what quantity emits a goods-receipt event to the ERP (INT-ERP-02 and INT-ERP-03), preserving the existing financial posting flow.
3. Putaway and locator events (INT-LOC-01) keep FR-I-01 multi-location stock balances honest and feed the Section 3.6 demand and slotting logic.
4. The indent loop (IND-01) closes the demand signal that FR-P-04 requisitioning and FR-D-07 replenishment planning depend on, so an approved indent flows into a requisition line without re-keying.
5. NFR-ADOPT-01 governs all of the above: if frontline confirmation rates fall, the captured data degrades, so adoption is monitored as a first-class quality metric (SM-17) alongside the other Section 8 metrics.
