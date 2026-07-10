# PRD Addendum: Materials & Supply Chain Management Platform

Depth preserved from the source requirements document that belongs in downstream artifacts (architecture, solution design, platform selection) rather than the PRD narrative.

## Platform Selection Considerations (feeds architecture / procurement)

- Decision 2026-07-10: **custom build selected**. The business concluded the COTS candidates (Manhattan Associates, Blue Yonder, Oracle SCM Cloud, SAP IBP, Kinaxis) cannot deliver the required customization. Source constraint C-02 (COTS preferred, custom impractical on budget) is superseded.
- Delivery decisions 2026-07-10: **spine-first** build order (compliance platform layer with its own acceptance contract before any module) over a **36-month** program, superseding C-01's 12 to 18 months; first go-live is a four-capability slice (spine, core inventory, gate edge, job-work) at one pilot site. Budget envelope and build sourcing (in-house, partner, hybrid) remain open under PRD question 10; pilot-site selection (hardest site vs receptive site) is with the sponsor.
- Architecture principle replacing C-04 (India-only decision): no region-bound assumptions hard-coded in the data layer.
- C-05 still applies to the custom stack: alignment with the organization's preferred tech ecosystem (Microsoft-centric, Java-based, or cloud-agnostic) is a build-stack selection factor.
- The compliance constructions that drove the decision (retain as architecture requirements, no longer selection tests):
  - Non-disableable statutory edit log with no hard deletes (C-07, FR-AC-13).
  - Weighbridge Legal Metrology stamping blocks on trade weighment (C-11, FR-M-14).
  - Non-disableable 90-day hazardous waste timers (C-13, FR-SC-18).
  - Calibration lockout that no role can override (FR-M-13).
  - Enterprise DOA registry as the single approval authority (FR-DOA-01).
  - Event-sourced location with a ban on last-writer-wins (INT-LOC-01).
- A-07: cloud-hosted (SaaS or private cloud), not on-premises; C-04 data residency contingency.

## Integration Mechanism Details (feeds architecture)

- INT-ERP-01 dual mastership is deliberate and easy to misread: BOM structure, revisions, and lifecycle state publish outbound (this platform is master); item cost rates and financial attributes flow inbound (ERP is master). Sync conflicts must create BOM Administrator exception records; last-write-wins is not permitted.
- INT-GATE-01 defines a first-class event model: a vehicle-to-PO binding token created at the gate and a weighbridge event contract (tare, gross, net, variance) tied to that token. Goods receipt posts accepted quantity only; tolerance breaches raise variance events QC and procurement subscribe to.
- INT-LOC-01: location is event-sourced. `LocationAsserted` facts (who, device, timestamp, confidence) are stored separately from `LocationExpected` (ASN/plan); divergence raises `LocationDisputed` for review with no silent merge.
- INT-GST-01: the ERP remains the invoice issuer; this platform raises invoice-request events through the ERP flow and consumes the returned IRN and signed QR.
- Supplier connectivity: EDI (ANSI X12 / EDIFACT) or API-based PO transmission (INT-SUP-01); SCIM or equivalent for provisioning (INT-IAM-02).
- First-phase manual fallbacks by design: CPCB EPR portal exchange may be manual upload (INT-EPR-01); Udyam verification may be manual (INT-MSME-01); maker-hub meter capture is operator-entered until INT-MTR-01 automation (A-10).

## Frontline Story Machinery (feeds UX and epics)

- Prioritization rule for promoting story stubs: each candidate moment scores 1 to 5 on Pain, Frequency, and Data-Integrity Risk; 45+ out of 125, or a 5 on Data-Integrity Risk alone, earns a fully-worked story. Data-Integrity Risk holds a veto because a fast wrong entry corrupts every downstream role.
- Story template: persona-and-moment line, two to three Given/When/Then acceptance criteria always including an offline criterion, and a success metric tied to source §8.
- Industry practices deliberately adapted: directed putaway, ABC slotting with override-driven re-slotting, voice-directed picking (PICK-VOICE-01), wave/zone/batch picking, gate and weighbridge PO binding, offline-first store-and-forward, mobile approval with inline budget. Put-to-light noted as a future candidate for high-velocity zones.
- The 29 story stubs in source §9.3 each carry a related-requirement mapping; they are the seeded backlog for epic breakdown.

## Access Matrix Notes (feeds UX and security design)

- The published matrix (source §5.2) covers 7 roles by 10 capabilities. Patterns: dashboards readable by all seven; transfers restricted to warehouse manager and inventory controller; PO and tender creation to procurement only; forecasts to demand planner only; financial data to procurement, executive, finance; configuration admin-gated (ambiguously placed under the Finance column).
- Role aliases to avoid double-counting: Procurement Officer = Procurement Executive; Quality Inspector = QC/Receiving Inspector.
- Granular frontline roles (source §5.3) are capabilities assignable in any combination, scoped by location, without code changes.

## Statutory Reference Depth (feeds compliance design)

The PRD names the regimes; the source sections carry full citations with dates and thresholds, including: e-invoice threshold Rs 5 crore with the 30-day IRP window at Rs 10 crore+ (in force 1 April 2025); e-way bill threshold Rs 50,000; dynamic QR at Rs 500 crore+ turnover; s.206C(1H) TCS omitted since 1 April 2025 with s.394(1) TCS on scrap continuing; MSME due dates (45-day cap, 15-day appointed day) and s.16 interest at three times the RBI bank rate compounded monthly; ITC-04 periodicity half-yearly above Rs 5 crore; Rule 28 branch-transfer valuation options; customs s.18 two-year provisional assessment window with s.28AA interest; Schedule II residual value cap 5%; retention 8 financial years under s.128(5); DPDP Rules 2025 phased to May 2027; plastic EPR returns due 30 June following the obligation year; non-ferrous EPR in force 1 April 2026.
