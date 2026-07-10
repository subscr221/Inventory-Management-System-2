# SCM PRD Expansion - Frontline and Shopfloor Usability

**Document Version:** 1.0
**Date:** 2026-07-10
**Classification:** Internal - Business & Technical Review
**Project:** Multi-Location Supply Chain Management System
**Companion to:** SCM-Requirements-Document.md (v1.0)
**Produced by:** BMAD Party Mode round-table (John, Mary, Winston, Sally, and Ravi, a shopfloor operations veteran)

---

## 1. Purpose of This Document

The base requirements document (SCM-Requirements-Document.md) is a strong enterprise-level specification, but it is organized as a flat catalogue of capabilities (FR-I-01, FR-P-01, and so on). It names capabilities without naming the person who feels the pain, the moment they feel it, or what "done" looks like for them. This expansion makes the PRD granular and usable for ground-level and shopfloor staff by:

1. Restructuring frontline requirements around operational personas and their day-to-day moments, not a flat requirement list.
2. Expanding the role model to match how work is really divided on the floor.
3. Providing a reusable user-story template with testable acceptance criteria.
4. Delivering fully-worked stories for the highest-value frontline moments, plus prioritized stubs for the rest.
5. Adding the integration and adoption requirements the base PRD is missing.

This document is additive. It does not replace the base PRD; it hangs granular, testable detail off the existing functional requirements and, where relevant, cites the base requirement each story satisfies.

---

## 2. Core Structural Recommendations

### 2.1 Reorganize the Frontline Spine Around Moments, Not a Flat List

The base PRD should keep its functional-requirement catalogue as an implementation reference, but the frontline sections should be re-spined around operational personas and their moments. Each moment becomes an epic, expressed as a real situation a real person is in, for example "Gate staff receives an unscheduled truck" or "Store assistant cannot find a bin location." The existing FRs then hang off those epics as implementation detail rather than serving as the primary structure.

### 2.2 Treat Role as a Hat, Not a Badge

On a small site one person wears many hats (an indent raiser may also be the procurement executive); on a large site those same responsibilities split across warring departments. The system must model role as an assignable capability, not a fixed job title hard-coded to one person. This keeps the requirements portable across site sizes without rework.

### 2.3 Treat Offline as the Normal Case, Not the Exception

Gate, weighbridge, and shopfloor devices operate on connectivity that drops behind steel racking, at far dock doors, and during bad weather. Equally important, workarounds are driven not only by lost connectivity but by slow or clumsy screens even when the network is healthy: a twelve-field form at 2am sends a worker back to the paper register regardless of signal. Every frontline flow must therefore be designed to work with a dropped connection as a normal path, and to be completable in seconds under pressure.

### 2.4 Prioritization Rule for Story Depth

Not every moment earns a fully-worked story. Each candidate moment is scored on three axes, each from 1 to 5:

1. **Pain** - how badly the current process hurts the person.
2. **Frequency** - how often the moment occurs.
3. **Data-Integrity Risk** - how badly a fast, wrong entry poisons downstream roles.

A moment scoring 45 or above (out of 125), or scoring a 5 on Data-Integrity Risk alone, gets a fully-worked story with an offline acceptance criterion and a measurable metric. Everything else is captured as a one-line stub (persona plus the single thing that must be true) until its score justifies promotion. Data-Integrity Risk holds a veto because a wrong number entered quickly corrupts every downstream role, which is the entire reason an SCM system exists.

---

## 3. Expanded Frontline Role Model

The base PRD role matrix names coarse roles such as "Warehouse Operator" and "Procurement User." Real floor work divides more finely. Table 1 lists the granular frontline roles this expansion serves, several of which the base PRD does not name at all.

Table 1: Expanded frontline and operational roles.

| Role | On the floor this is | In the base PRD? |
|------|----------------------|:----------------:|
| Gate / Security Officer | First checkpoint; logs vehicles in and out | Partial (implied) |
| Weighbridge Operator | First person to touch an inbound truck; captures weights | No |
| Unloading Labor Supervisor | Cracks the truck open, oversees unload | No (folded into "operator") |
| QC / Receiving Inspector | Accepts, rejects, or partially accepts a load | Partial |
| Store Assistant | Bins stock (putaway) and picks orders | Partial (folded into "operator") |
| Stock Locator | Knows where stock physically is; knowledge lives in memory or a ledger | No |
| Dispatch Clerk | Manages outbound; not the same person as the gate guard | No |
| Indent Raiser | Floor or department person who requests materials | Yes (as requisitioner) |
| Department Head (Approver) | Approves indents; often approves blind today | Partial |
| Procurement Executive | Turns approved indents into purchase orders | Yes |

The base PRD should reconcile its role matrix (Section 5) against Table 1, and adopt the "role as a hat" principle from Section 2.2 so a single person can hold several of these roles on a small site.

---

## 4. Reusable Story Template

Every frontline story in the expanded PRD is written to the same mold so granularity stays consistent and testable:

1. **Persona and moment** - "As a [specific frontline role] [in the specific moment], I want [action], so that [benefit]."
2. **Acceptance criteria** - two to three criteria in Given / When / Then form, always including one offline criterion where the moment happens on an edge device.
3. **Success metric** - a measurable target tied to the base PRD's existing success-metric style (Section 8 of the base document), never an invented number.

The template is the reusable asset. The room writes full stories only for moments that clear the prioritization rule in Section 2.4; the rest are stubs.

---

## 5. Fully-Worked Frontline Stories

The following stories cleared the prioritization rule. They are grouped by moment and cite the base PRD requirement each one satisfies.

### 5.1 Gate and Inbound Capture

#### Story GATE-01: Log an Inbound Vehicle Under Pressure

Satisfies and makes granular: FR-W-02 (Receiving), FR-O-06 (status tracking at the inbound edge).

*As a Gate Security Officer receiving an inbound vehicle at 2am, I want to log the gate event against an expected ASN or PO even when the network is down, so that goods enter on a traceable record instead of a paper register and an informal messaging group.*

1. **AC1 (happy path):** Given a vehicle arrives with a challan referencing a known PO, When the officer scans or keys the PO and confirms vehicle and challan details, Then the system creates a queued gate event stamped with time, gate ID, and officer ID, and shows a "captured, pending sync" state.
2. **AC2 (offline):** Given the device has no connectivity, When the officer completes capture including a mandatory photo of the challan, Then the event persists locally, is assigned a provisional gate token, and auto-reconciles to the matching ASN or PO within 5 minutes of connectivity being restored, with any mismatch flagged for the store assistant rather than silently dropped.
3. **AC3 (exception):** Given no matching PO exists, When the officer logs the event, Then the system still captures it as "unmatched" and routes it to a named owner for resolution, so nothing enters unrecorded.

**Success metric:** median gate dwell time at or below 4 minutes per vehicle even in offline mode; gate-origin data-entry error rate below 2 percent, both measured against the base PRD's dwell-time and error-rate baselines.

#### Story WEIGH-01: Capture Trusted Weights at the Weighbridge

Satisfies and makes granular: FR-W-02 (Receiving), FR-P-06 (Goods Receipt and Quality Inspection).

*As a Weighbridge Operator, I want to capture tare, gross, and net against the linked PO or ASN, so that receiving weights are trusted and discrepancies are caught at the gate.*

1. **AC1 (happy path):** Given a truck tied to a PO or ASN with a defined tolerance, When I record tare then gross, Then net auto-calculates, is validated within tolerance, and posts to the goods-receipt event with an accept status.
2. **AC2 (offline):** Given no connectivity, When I capture tare and gross, Then the reading is queued locally with a timestamp and device provenance stamp and reconciles on reconnect without operator re-entry.
3. **AC3 (exception):** Given net falls over or under PO tolerance, When I confirm the weight, Then the load is flagged as a discrepancy, blocked from silent receipt, and routed to a named owner (QC or Receiving supervisor) for disposition.

**Success metric:** weight-capture accuracy at or above 99.5 percent; receiving weight-discrepancy rate trended weekly.

### 5.2 Shopfloor Putaway and Picking

#### Story PUT-01: Directed Putaway with Locator Override Capture

Satisfies and makes granular: FR-W-03 (Putaway), FR-I-01 (multi-location stock tracking).

*As a Store Assistant, I want scan-first directed putaway that lets me log any bin change as a correction event, so that slotting stays accurate and location confidence grows instead of living in one person's head.*

1. **AC1 (directed):** Given a directed bin, When I scan the item and the target bin, Then the system confirms the match hands-light (glove-friendly and one-handed) and records a putaway-confirmed event.
2. **AC2 (override as correction):** Given I place stock in a different bin, When I scan the actual location, Then the system records a locator-override correction event with a reason code, feeding the ABC re-slotting engine.
3. **AC3 (disputed reconcile):** Given the offline queue surfaces a physical override that conflicts with the ASN expected location, When it reconciles, Then the physical override becomes the authoritative physical-location fact with a provenance and confidence stamp, the ASN expected-location value is preserved rather than overwritten, and the conflict is surfaced for review. Last-writer-wins is banned for location.

**Success metric:** putaway accuracy at or above 98 percent; bin-location confidence coverage at or above 90 percent.

**Voice-directed picking acceptance shape (for the related pick moment):** Given an active voice-directed pick, When the operator completes the line by voice confirmation, Then zero manual screen taps are recorded for that pick and pick error rate stays at or below 0.5 percent. Both taps and error rate are instrumented, so the criterion is fully verifiable.

### 5.3 Indent-to-Requisition Loop

#### Story IND-01: Raise an Indent and Know What Happens to It

Satisfies and makes granular: FR-P-04 (Purchase Requisition and approval routing).

*As a floor supervisor with ninety seconds between tasks, I want to raise an indent from my phone and actually know what happens to it, so that I never chase, guess, or raise it twice.*

1. **AC1 (raise and duplicate check):** Given I have raised the same item within the open window, When I submit, Then the system warns me of the likely duplicate and confirms my indent with an ID in under 90 seconds.
2. **AC2 (visibility):** Given my indent exists, When I open the app, Then I see its live status (raised, approved, rejected, ordered, expected delivery) without contacting anyone.
3. **AC3 (decision push-back):** Given the department head decides, When they approve or reject, Then I receive a push notification carrying the decision and the reason.

**Success metric:** indent-to-decision cycle time; percentage of indents with raiser-visible status at all times; duplicate-indent rate.

---

## 6. Prioritized Stubs

These moments are captured now and promoted to full stories when their prioritization score justifies it (see Section 2.4). Table 2 lists the current stub backlog.

Table 2: Frontline story stubs awaiting promotion.

| Stub ID | Persona and the one thing that must be true | Related base FR |
|---------|---------------------------------------------|-----------------|
| DH-APPROVE-01 | Department head clears or exception-flags indents from mobile with budget-remaining shown inline, batch-approves low-value items, and delegates when off-site. | FR-P-04 |
| PROC-REQ-01 | An approved indent becomes a requisition line automatically, with zero re-keying by the procurement executive. | FR-P-04, FR-P-05 |
| QC-INSPECT-01 | QC inspector records per-PO-line disposition (accept, reject, partial), routes held quantity to quarantine, and only accepted quantity posts to goods receipt. | FR-P-06, FR-W-02 |
| UNLOAD-01 | Unloading supervisor records pallet or carton counts against the gate event with photo evidence. | FR-W-02 |
| DISPATCH-01 | Dispatch clerk confirms outbound load against the pick and generates shipping documents hands-light. | FR-W-06, FR-O-06 |
| PICK-VOICE-01 | Store assistant completes a pick hands-free via voice, with a visual bin-map fallback. | FR-W-04 |

---

## 7. New and Strengthened Non-Frontline Requirements

The frontline expansion surfaces gaps in the base PRD's integration and non-functional coverage. Table 3 lists the additions.

Table 3: New requirements surfaced by the frontline expansion.

| ID | Requirement | Why it is needed |
|----|-------------|------------------|
| INT-GATE-01 | Define a gate and weighbridge event model: a vehicle-to-PO binding token, and a weighbridge event contract carrying tare, gross, net, and variance. Goods receipt posts accepted quantity only. | The base PRD has INT-ERP, INT-3PL, and INT-DC (barcode and RFID) but no model for a gate or weighbridge event, so the gate and weighbridge stories have nothing to integrate against. |
| INT-LOC-01 | Location is event-sourced: a physical LocationAsserted fact and an expected LocationExpected fact are stored separately; a divergence raises a LocationDisputed flag. No location fact is ever overwritten, only superseded by a newer stamped assertion. | Resolves the disputed-bin problem without silently destroying a worker's real-world knowledge. |
| NFR-ADOPT-01 | Locator Feedback Loop: any tribal knowledge the system captures (overrides, confidence gains) must surface visible value back to frontline staff (better directed bins, fewer wrong-bin walks), measured by a sustained confirmation rate at or above 95 percent. A drop is treated as a system defect, not user error. | Capturing a worker's knowledge without giving value back removes their incentive to confirm, and the system goes blind again. This makes adoption a testable requirement, not a hope. |

---

## 8. Industry Practices Referenced

The features proposed above adapt established practices from inventory, warehouse, and access-control platforms. Table 4 maps each practice to where it is applied.

Table 4: Industry practices adapted for frontline stories.

| Practice | Where applied in this expansion |
|----------|--------------------------------|
| Directed putaway | PUT-01, so the store assistant is told the bin rather than guessing |
| ABC slotting and re-slotting | PUT-01 and INT-LOC-01, so confirmed overrides bend the slotting map toward reality |
| Voice-directed picking | PICK-VOICE-01, so hands and eyes stay on the goods |
| Wave, zone, and batch picking | Base PRD FR-W-04, retained as pick-strategy options |
| Put-to-light | Candidate for high-velocity zones (future stub) |
| Gate and weighbridge PO binding | GATE-01, WEIGH-01, INT-GATE-01, common in facility access-control and yard-management systems |
| Offline-first store-and-forward capture | GATE-01, WEIGH-01, PUT-01, INT-LOC-01, standard in rugged warehouse mobility |
| Mobile approval with inline budget visibility | DH-APPROVE-01, common in procure-to-pay suites |

---

## 9. How These Additions Integrate with the Overall System

The frontline stories are not a separate application. They are the edge-capture layer that feeds the base PRD's core:

1. The gate and weighbridge events (INT-GATE-01) create the inbound record that FR-W-02 receiving and FR-P-06 goods receipt consume.
2. The QC inspector's per-line disposition determines what quantity emits a goods-receipt event to the ERP (INT-ERP-02 and INT-ERP-03), preserving the base PRD's financial posting flow.
3. Putaway and locator events (INT-LOC-01) keep FR-I-01 multi-location stock balances honest and feed the FR-D demand and slotting logic.
4. The indent loop (IND-01) closes the demand signal that FR-P-04 requisitioning and FR-D-07 replenishment planning depend on, so an approved indent flows into a requisition line without re-keying.
5. NFR-ADOPT-01 governs all of the above: if frontline confirmation rates fall, the captured data degrades, so adoption is monitored as a first-class quality metric alongside the base PRD's Section 8 success metrics.

---

## 10. Recommended Next Steps

1. Fold the expanded role model (Section 3) into the base PRD Section 5 role matrix.
2. Adopt the story template (Section 4) as the standard for all future frontline requirements.
3. Add INT-GATE-01, INT-LOC-01, and NFR-ADOPT-01 to the base PRD integration and non-functional sections.
4. Confirm the go-live MVP slice: the weighbridge operator and QC inspector moments were argued as the highest data-integrity priorities, with the indent loop close behind on demand-signal integrity. Validate this ordering with operational stakeholders before committing scope.
5. Walk one real site with a clipboard, recording every person who touches a truck or a carton from the weighbridge to the shelf, and reconcile any newly discovered role against Table 1.
