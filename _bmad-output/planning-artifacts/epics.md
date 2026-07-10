---
stepsCompleted: ["step-01", "step-02"]
inputDocuments:
  - "PLANNING/prd/index.md"
  - "PLANNING/prd/4-features.md"
  - "PLANNING/prd/6-mvp-scope.md"
  - "PLANNING/prd/7-success-metrics.md"
  - "PLANNING/prd/8-cross-cutting-nfrs.md"
  - "PLANNING/prd/2-target-user.md"
  - "PLANNING/prd/9-compliance-and-regulatory.md"
  - "PLANNING/prd/10-integration-and-dependencies.md"
  - "PLANNING/prd/11-stakeholders-and-roles.md"
  - "PLANNING/prd/12-data-migration-and-cutover.md"
  - "_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md"
  - "_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md"
  - "PLANNING/archive/SCM-Requirements-Document.md"
---

# Materials & Supply Chain Management Platform - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the Materials & Supply Chain Management Platform, decomposing the requirements from the PRD, Addendum, and Architecture Spine into implementable stories.

## Requirements Inventory

### Functional Requirements

**Core Inventory (FR-I)**
- FR-I-01: Multi-location stock tracking with real-time per-location and consolidated views.
- FR-I-02: Inter-location transfer requests, approvals, pick/ship/receive with lot and serial traceability.
- FR-I-03: Reorder points and automated replenishment recommendations or auto-requisitions per SKU per location.
- FR-I-04: Lot, batch, and serial tracking for traceability, FEFO/FIFO expiry management, and recall readiness.
- FR-I-05: Valuation by FIFO and weighted average; specific identification where required; standard cost only as an Ind AS 2 para 21 measurement technique. LIFO is not offered.
- FR-I-06: Cycle counting and physical inventory with variance workflows and approval-gated adjustments.
- FR-I-07: Safety stock computed from lead-time and demand variability against target service levels.
- FR-I-08: Aging and obsolescence flagging feeding disposition and NRV testing.
- FR-I-09: Kit assembly/disassembly transactions, executing only against Released BOMs (superseded as definition record by FR-B-02).
- FR-I-10: Consignment and VMI stock segregated from owned inventory.

**Warehouse Operations (FR-W)**
- FR-W-01: Warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine attributes.
- FR-W-02: Receiving against ASN or PO with lot/serial, expiry, and QC capture; generates putaway tasks. Realizes UJ-GATE-01 and UJ-WEIGH-01 at the inbound edge.
- FR-W-03: System-directed and user-selected putaway by velocity, size, zone rules. Realizes UJ-PUT-01.
- FR-W-04: Picking with optimized paths; single-order, batch, wave, and zone strategies; paper and mobile-directed.
- FR-W-05: Packing-station workflow with validation, weights, labels, packing slips, cartonization.
- FR-W-06: Shipping documents (BOL, commercial invoice, customs docs), carrier rate shopping, load planning.
- FR-W-07: Task generation, assignment, prioritization, and productivity tracking.
- FR-W-08: Forward-pick replenishment from reserve storage on min/max or demand signals.
- FR-W-09: Flow-through and distribution cross-docking.

**Procurement, Tendering, and Supplier Management (FR-P, FR-T)**
- FR-P-01: Centralized supplier registry (contacts, tax IDs, terms, certifications, compliance docs).
- FR-P-02: Supplier onboarding workflow with document collection and approval routing.
- FR-P-03: Supplier performance capture and scorecards (on-time delivery, quality acceptance, price, responsiveness).
- FR-P-04: Purchase requisitions with configurable approval rules by amount, category, department. Realizes UJ-IND-01.
- FR-P-05: PO management: blanket, contract, and standard POs tracked issuance through receipt and invoicing.
- FR-P-06: Goods receipt against PO with QC inspection workflow and accept/reject/conditional outcomes.
- FR-P-07: Three-way match (PO, receipt, invoice) with tolerances, discrepancy flags, credit/debit notes.
- FR-P-08: Spend analytics by supplier, category, location, department, period.
- FR-P-09: MSME compliance: Udyam capture with annual revalidation; statutory due-date stamping; classification-tagged ageing fed to ERP for s.43B(h) and MSMED s.16 exposure.
- FR-T-01 to FR-T-07: Tender lifecycle: authoring (RFQ/RFP/RFI) with templates, supplier invitation, secure bid portal, clarification Q&A, controlled bid opening with weighted scoring, award approval and notification, contract generation linked to POs.

**Order Management, Demand Planning, and Logistics (FR-O, FR-D, FR-L)**
- FR-O-01 to FR-O-08: Order capture (manual, EDI, e-commerce, internal, inter-branch), validation, routing, split shipments, backorder allocation, status tracking, RMA returns, drop shipping.
- FR-D-01 to FR-D-08: Historical data analysis, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting, NPI forecasting, replenishment planning, inventory optimization.
- FR-L-01 to FR-L-08: Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management, import/export documentation, returns logistics.

**R&D Centre and Maker-Hub Operations (FR-RD)**
- FR-RD-01: R&D store and maker-hub store as first-class location types with their own stock ledgers.
- FR-RD-02: R&D-designated stock flag blocking cross-issue between R&D and production without approved reclassification.
- FR-RD-03: R&D project master (code, owner, research/development phase tag, budget, status).
- FR-RD-04: Requisition with committed-plus-actual budget check; breaches route to project owner and R&D head.
- FR-RD-05: Three issue types with distinct semantics: consumable, project material (accumulates WIP), equipment custody (loan).
- FR-RD-06: Equipment custody register with named custodian, expected return, condition codes, overdue aging.
- FR-RD-07: Per-project WIP ledger in quantity and cost, real time, feeding FR-AC treatment.
- FR-RD-08: Prototype build records including failed and abandoned builds with full material history.
- FR-RD-09: Completed builds register serialized prototypes in a non-saleable class; sales orders and dispatch blocked.
- FR-RD-10: Four prototype dispositions (retain as asset, transfer to production reference, teardown, scrap), each R&D-head approved.
- FR-RD-11: Teardown component recovery with condition codes; scrap lines route to FR-SC.
- FR-RD-12: Unused material returns reversing project WIP.
- FR-RD-13: Hub member and walk-in customer records; every booking, sale, and job card references exactly one.
- FR-RD-14: Machine-time booking with operator-closed actuals and meter readings; 24-hour unclosed-booking exceptions.
- FR-RD-15: Offline-capable point-of-use material sale decrementing hub stock and billing the member.
- FR-RD-16: Member job cards collecting bookings, hours, purchases; statements on demand and monthly.
- FR-RD-17: Hub replenishment via FR-I-03 reorder control against serving warehouse or purchase.
- FR-RD-18: Monthly hub and quarterly R&D physical verification, custodian confirmation of on-loan equipment.
- FR-RD-19: Project material cost reporting reconciled line-for-line to the store ledger; feeds Form 3CL and IAUD.
- FR-RD-20: Walk-in payment capture via UPI dynamic QR or card terminal with end-of-day reconciliation.

**BOM and Engineering Change Management (FR-B)**
- FR-B-01: Multi-level versioned BOMs with per-line scrap percent, UoM conversion, effectivity; explosion to any depth.
- FR-B-02: Supersedes FR-I-09 kit definitions; existing kits migrate as single-level production BOMs at go-live.
- FR-B-03: Revision control with non-overlapping date effectivity; released revisions immutable.
- FR-B-04: ECO workflow (Draft, Under Review, Approved, Implemented, Cancelled) with stock disposition; only Implemented ECOs alter a Released BOM.
- FR-B-05: Where-used and impact analysis across BOMs, open orders, POs, and stock, shown at ECO approval.
- FR-B-06: Lifecycle states (Draft, Released, On Hold, Obsolete); release gated on released item masters, scrap percents, cost rollup, ECO approval.
- FR-B-07: Explosion to execution at production-order release, driving directed issue or backflush; replicated per plant for offline continuity.
- FR-B-08: Consumption variance reporting at order closure with tolerance flags; feeds FR-SC reconciliation and scrap-percent recalibration.
- FR-B-09: R&D draft BOM regime: in-place edits, placeholders, free text; barred from production execution.
- FR-B-10: Clone production BOMs into R&D drafts; immutable as-built snapshots per build with deviation flags.
- FR-B-11: Productization gate checklist with engineering, procurement, and QC sign-offs.
- FR-B-12: Approved alternates with priority and effectivity; ad-hoc substitutions require logged approval.
- FR-B-13: Phantom assemblies passing through to components.
- FR-B-14: Co-products and by-products with expected yields posting as distinct lots.
- FR-B-15: Cost rollups as dated simulation snapshots with comparison; valuation stays in ERP.
- FR-B-16: Job-work kit BOMs tagged by supply source (company, customer, job-worker) with reconciliation.
- FR-B-17: BOM system of record with INT-ERP-01 sync; inbound conflicts create BOM Administrator exceptions, never overwrites.

**Production Orders and Production WIP (FR-MO)**
- FR-MO-01: Production order record with immutable number, output item/quantity, plant, BOM version, stream tag, source reference.
- FR-MO-02: Lifecycle: Planned, Released, In Process, Completed, Closed; Cancelled only from Planned/Released with no unreversed transactions.
- FR-MO-03: Release gate: effective Released BOM plus availability check; override by named authority flags to expediting.
- FR-MO-04: Staging and issue: pick tasks for directed lines, allocated status until issue; backflush lines post on confirmation.
- FR-MO-05: Production WIP ledger per order in quantity and value, distinct from R&D project WIP.
- FR-MO-06: Returns to stock with reason codes, reversing WIP at issued cost, restoring lot identity.
- FR-MO-07: Completions post good quantity into QC Hold as new FG lots; co/by-products post separately.
- FR-MO-08: Process scrap declarations relieving WIP and feeding expected-vs-actual reconciliation.
- FR-MO-09: Completion tolerances; over-completion blocked without supervisor approval; short completion resolution.
- FR-MO-10: Rework orders generated from QC dispositions, output re-entering the QC gate as linked lots.
- FR-MO-11: As-consumed lot genealogy per output lot; lot-controlled consumption without a recorded lot is blocked.
- FR-MO-12: Closure requires zero WIP, no open picks, QC disposition per output lot; closed orders immutable.
- FR-MO-13: Offline execution with replicated order data, sequenced replay, duplicate suppression; release/cancel/close central only.

**Job-Work Services (FR-JW)**
- FR-JW-01: Job-work service order: customer, spec reference, promised dates, price basis; links kit BOM (FR-B-16).
- FR-JW-02: Lifecycle statuses from draft to closed, every change attributed.
- FR-JW-03: Customer material receipt only against confirmed orders through gate and receiving flows, challan captured.
- FR-JW-04: Customer-owned non-valuated stock class, segregated, blocked from any other demand.
- FR-JW-05: Custody ledger per customer and order with full movement categories; prints as custody statement.
- FR-JW-06: Consumption posting against the order following customer-supplied kit lines.
- FR-JW-07: Own-material additions billed distinctly from the service charge.
- FR-JW-08: Process loss norms; over-norm loss requires supervisor approval before dispatch readiness.
- FR-JW-09/10: Contractual offcut election (return, retain-and-buy, retain free) captured at confirmation and executed with documents.
- FR-JW-11: Output passes the FG quality gate before dispatch; partial dispatches supported.
- FR-JW-12: Measured billing feed (pieces, certified weight, or hours) handed to ERP for invoicing.
- FR-JW-13: Customer stock in physical verification with reconciliation on the next custody statement.
- FR-JW-14: Aging and statutory-window alerts computed from challan date with escalation.
- FR-JW-15: No closure while the custody ledger balance is non-zero.

**Quality Control (FR-Q)**
- FR-Q-01: Versioned inspection plans per product-spec revision; QC Head approved; customer-spec overrides per job-work order.
- FR-Q-02: Finished-goods QC gate: all completions post into QC Hold; no bypass, urgency uses conditional release.
- FR-Q-03: AQL sampling per IS 2500 / ISO 2859-1 with switching rules; critical characteristics 100% inspected.
- FR-Q-04: Result capture referencing instrument asset IDs; out-of-calibration instruments rejected (lockout from FR-M-13).
- FR-Q-05: Exactly one recorded disposition per lot: Accept, Reject, or Conditional Release with deviation record; partial splits supported.
- FR-Q-06: NCR outcomes per quantity: rework, downgrade to seconds, or scrap to FR-SC.
- FR-Q-07: Batch release records and CoA/CoC per lot; retention default 7 years.
- FR-Q-08: Retention samples block release until logged; expiry alerts route to disposal.
- FR-Q-09: Quality holds on released lots flip stock to Blocked everywhere; where-used and where-shipped trace within 15 minutes.
- FR-Q-10: NCR defect codes and CAPA linkage; repeat NCRs (3+ same product and defect in 90 days) require CAPA.
- FR-Q-11: BIS hooks: licence validity blocks release; CM/L or R-number printed on release records and CoC.
- FR-Q-12: Prototype verification as design evidence; prototypes barred from sellable status.
- FR-Q-13: Quality reporting: first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events.
- FR-Q-14: Packaged-commodity label compliance (Legal Metrology): version-controlled label masters; release blocked without a current approved version.
- FR-Q-15: Customer-witnessed and third-party inspection: witness and hold points, recorded notice, dispatch blocked until hold points clear or a recorded waiver exists.

**Maintenance, Calibration, and Tooling (FR-M, FR-TL)**
- FR-M-01: Maintainable asset register company-wide with criticality classes and scannable tags; fixed-asset link optional.
- FR-M-02: Calendar and meter-based PM plans auto-generating work orders with grace-window tracking.
- FR-M-03: Usage meter feeds from hub bookings and station equipment plus manual readings; monthly reconciliation; silent-meter alerts.
- FR-M-04: Fault reporting by any user via tag scan; reaches the location's maintenance supervisor within 5 minutes.
- FR-M-05: Breakdown work-order lifecycle with priority from criticality and safety flags; configurable SLAs.
- FR-M-06: Downtime capture and monthly MTTR/MTBF per asset and class.
- FR-M-07/08/09: Spares catalogued under FR-I with where-used from equipment BOMs; reservation, issue, 3-working-day returns; critical-spares min-max with same-day breach alerts.
- FR-M-10/11: AMC, warranty, insurance records with 90/60/30-day expiry alerts; warranty check at work-order creation with reason-coded override.
- FR-M-12: Calibration register (in-house or ISO/IEC 17025 external) with certificates and 30/14/7-day alerts.
- FR-M-13: Out-of-calibration lockout: no role can override; escalation expedites, never bypasses.
- FR-M-14: Statutory examination tracking (OSH Code periodicities, weighbridge 12-month stamping); overdue items lock the asset; repaired weighbridges block trade weighment until re-stamped.
- FR-M-15: Maintenance cost accumulation per asset; repair-vs-capitalize flag routes to FR-FA above threshold.
- FR-M-16: Machine status broadcast within 2 minutes to production planning and hub booking; return-to-service needs supervisor sign-off.
- FR-M-17: Fully offline technician workflow with sync and conflict flagging.
- FR-M-18: Closure codes (fault, cause, remedy) with last-five-closures history at work-order open.
- FR-TL-01 to FR-TL-17: Tool crib: tool master, QR tag, custody issue/return, hub member lending, perishable tooling stock, life counters, warning/hard-stop thresholds, regrind/repair routing, regrind limits, condemnation to FR-SC, gauge calibration lockout, PPE register, offline crib transactions.

**Scrap, Defectives, and Disposal (FR-SC)**
- FR-SC-01: Source-linked intake only (production scrap, QC rejection, obsolescence, teardown, replaced parts, retired assets).
- FR-SC-02: Single classification at intake determining bins, routes, statutory channel; reclassification audit-logged.
- FR-SC-03: Segregated scrap-yard bins per class; restricted bins block cross-class putaway.
- FR-SC-04: Weighment (weighbridge or calibrated scale) with photo evidence; declared-vs-weighed variance exceptions.
- FR-SC-05: Expected-vs-actual scrap reconciliation against BOM scrap percents, feeding pilferage indicators.
- FR-SC-06/07: Defective disposition workflow (repair, refurbish-downgrade, cannibalize, condemn) with committee escalation; cannibalized component recovery.
- FR-SC-08: IP-sensitive lots require evidenced defacement before any sale.
- FR-SC-09: NRV fields per lot with rate source and valuer.
- FR-SC-10: Disposal approvals resolved through the DOA registry; proposer, approver, custodian must be three different users.
- FR-SC-11/12: Buyer registration (GSTIN, PAN, SPCB/CPCB credentials for regulated categories) with blacklisting; lot creation with sealed reserve prices.
- FR-SC-13: Auction via tender mechanics in reverse; below-reserve or single-bid outcomes escalate to committee.
- FR-SC-14/15/16: EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment and random re-weighment.
- FR-SC-17: Sale documents with GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers.
- FR-SC-18: Hazardous waste to authorized recyclers/TSDFs with Form 10 manifests and non-disableable 90-day storage timer.
- FR-SC-19: E-waste, battery, and non-ferrous EPR channels; awards blocked to unregistered buyers.
- FR-SC-20: Write-off and destruction with witness and evidence; auto-triggers ITC reversal evaluation and FA derecognition.
- FR-SC-21: Generated vs weighed vs disposed reconciliation per class per location.
- FR-SC-22: Plastic packaging EPR data by category, GSTIN, and financial year for CPCB portal returns.

**Fixed Assets, Intangibles, and Depreciation (FR-FA)**
- FR-FA-01 to FR-FA-06: Asset master with tags and parent-child components; capitalization from procurement through CWIP; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values; SLM/WDV depreciation runs posting to ERP after preview.
- FR-FA-07: Dual views: Companies Act books view plus report-only income-tax block-of-assets WDV view.
- FR-FA-08: Effective-dated transfers reallocating depreciation; inter-GSTIN moves trigger FR-AC-10 documents before dispatch.
- FR-FA-09/10: Subsequent expenditure decisions; repair-vs-capitalize queue from FR-M work orders, none undecided at period lock.
- FR-FA-11: Impairment indicator capture per Ind AS 36.
- FR-FA-12: Retirement and disposal through FR-SC with gain/loss computation.
- FR-FA-13: Offline physical verification by tag scan per CARO 2020 with reconciliation evidence.
- FR-FA-14: Immutable asset audit trail.
- FR-FA-15 to FR-FA-20: Intangibles register; IAUD ledger fed project-wise from FR-RD-19; capitalization and amortization; annual reviews; impairment extension; derecognition and approval-gated IAUD write-offs.

**Financial Compliance Spine (FR-AC, FR-IM, FR-BC, FR-DOA)**
- FR-AC-01: Every inventory movement carries business stream, cost centre, and project code where applicable; untagged transactions blocked.
- FR-AC-02/03: Research-phase issues expense; development-phase capitalization only after the six-criteria checklist.
- FR-AC-04: Project-wise R&D cost ledgers producing DSIR and Form 3CL-ready statements.
- FR-AC-05/06: Permitted cost formulas per Ind AS 2; period-end NRV testing with capped reversals.
- FR-AC-07/08: ITC register per GSTIN traced to GRN, invoice, and IRN; ITC reversal computed on write-offs before disposal closes.
- FR-AC-09: Scrap-sale tax events (GST classification, e-invoice, e-way bill, TCS) as dated configuration, not code.
- FR-AC-10: Branch transfers between GSTINs as taxable supplies with Rule 28 valuation and documents before dispatch.
- FR-AC-11: Job-work challans (Rule 45) with one-year and three-year return clocks, deemed-supply on breach, ITC-04 data.
- FR-AC-12: Maker-hub B2C invoices at item rates, separated from machine-time service charges.
- FR-AC-13: Statutory edit log: tamper-proof, non-disableable, retained per books-retention, auditor-reportable.
- FR-AC-14: Dispatch blocked for e-invoiceable supplies until IRN and signed QR received.
- FR-AC-15: Period locks, GRNI ageing, subledger-to-GL reconciliation, CARO physical-verification evidence.
- FR-AC-16: Funding-source tagging (internal, DSIR, DST, grants) on R&D projects.
- FR-IM-01 to FR-IM-09: Imports: import-flagged POs, Bill of Entry capture, import IGST into ITC register, landed cost sheets, provisional assessment lifecycle, late cost true-up, ICEGATE/GSTR-2B reconciliation, duty-exemption licence hooks.
- FR-BC-01/02: ERP-synced budget heads and availability; inline budget-remaining at approval; commitments reduce availability until ERP actuals sync.
- FR-DOA-01: One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow.

**Gate Passes, Returnable Materials, and Frontline Edge Capture (FR-GP)**
- FR-GP-01: RGP and NRGP as distinct serially numbered documents per GSTIN and site.
- FR-GP-02/03: RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document.
- FR-GP-04: Rule 55 delivery challans and e-way bill triggers for non-sale movements above threshold.
- FR-GP-05/06/07: Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return.
- FR-GP-08: NRGP only for permitted non-returnable reasons with DOA approval.
- FR-GP-09: Open-RGP ageing with 7/15/30-day reminder defaults and site-head escalation.
- FR-GP-10: Statutory and insurance window clocks per RGP class; hard alerts to named owners; no silent expiry.
- FR-GP-11: Gate enforcement: no matching open gate pass, no exit; mismatches raise incidents.
- FR-GP-12: Off-site asset visibility report by party, location, value for insurance and audit.
- FR-GP-13/14: Returnable packaging register with per-party bidirectional balances and serialized cylinders; deposits, refunds, forfeiture, and revaluation.

**Reporting and Analytics (FR-R)**
- FR-R-01 to FR-R-08: Executive dashboard (turns, fill rate, spend, stockouts, forecast accuracy); operational dashboards per role; inventory, procurement, and fulfillment report suites; configurable exception alerts; drag-and-drop ad-hoc reporting with Excel/PDF/CSV export; scheduled report distribution.

**Data Migration (FR-DM)**
- FR-DM-01: Physically verified opening stock by location, lot, and serial; asset register with cost, accumulated depreciation, and remaining Schedule II life; open POs, sales orders, and job-work challans with source references.
- FR-DM-02: Active BOMs, custody and loan registers, and open gate passes migrated and department-verified before cutover.
- FR-DM-03: Balances reconciled to ERP and legacy records; department-head and finance sign-off is a mandatory go-live gate.

### NonFunctional Requirements

- NFR-S-01 to S-05 (Scale): 50 locations scaling to 200+ without architectural change; 500k+ SKUs; 1,000 concurrent users with headroom to 5,000; 10k+ order lines/hour; 8-financial-year retention (3 online, archive restorable to queryable within 48 hours).
- NFR-P-01 to P-05 (Performance): operational screens under 2s; single-SKU stock queries under 1s; standard reports under 10s; API p95 under 500ms.
- NFR-P-04 (Availability - two-tier SLA): Tier 1 frontline edge capture available 24x7 by offline-first architecture with visible degraded state ("captured, pending sync"). Tier 2 central control plane at 99.5% availability (target 99.9%) over per-site operating windows.
- NFR-SEC-01 to SEC-06 (Security): SSO (SAML 2.0/OIDC); RBAC to module, function, location, and data level; TLS 1.2+ and AES-256; immutable audit log; enforced segregation of duties; DPDP Act 2023 and DPDP Rules 2025 compliance.
- NFR-DI-01 to DI-05 (Data Integrity): ACID inventory transactions; no double allocation; cross-location sync lag at most 5s with graceful partition handling; daily backups, RTO 4h, RPO 1h; idempotent financial postings.
- NFR-U-01 to U-06 (Usability): responsive on desktop and rugged tablets; WCAG 2.1 AA; i18n and multi-currency; offline-first frontline capture as a normal path (not conditional); scan-first, glove-friendly, one-handed moment-of-use ergonomics.
- NFR-E-01 to E-04 (Extensibility): documented REST (and/or GraphQL) APIs; configurable workflows without code; plugin framework; upgrades under 30 minutes.
- NFR-ADOPT-01 (Adoption): captured frontline knowledge must visibly benefit the people who capture it; confirmation below 95% is a defect.
- NFR-D-01/02 (Documents): single attachment store with virus scanning; per-type retention classes with legal hold; deletion before expiry blocked and logged.

### Additional Requirements

Architecture-derived technical requirements that affect implementation:

- **Starter template / greenfield:** No starter template specified. Custom greenfield build on the architecture spine. The compliance spine must be built and acceptance-tested (via the Spine Acceptance Contract) before any module.
- **Tech stack:** Node.js 24 LTS, PostgreSQL 18.4, PowerSync Service 1.23.x, Next.js 16 or TanStack Start 1.x, TypeScript 5.x, AWS RDS Aurora PostgreSQL (Multi-AZ), AWS ECS Fargate, AWS CloudFront, Docker.
- **Deployment:** AWS `ap-south-1` Mumbai (production) and `ap-south-2` Hyderabad (DR). RTO 4h, RPO 1h.
- **Event envelope:** Every event carries `event_id` (UUIDv4), `stream_type`, `stream_id`, `event_version` (monotonic sequence), `payload` (JSONB validated), and metadata (correlation, causation, actor, device, capture method, timestamps). No mutable domain state columns.
- **Offline sync via PowerSync:** Edge devices write to local SQLite; PowerSync replicates to PostgreSQL central event store. Every edge command must carry an `idempotency_key` to prevent duplicate events (AD-16).
- **Gate-token event chain (AD-2):** every inbound event chain starts with a gate token. All subsequent events (weighbridge, receiving, putaway) reference it.
- **DOA registry as single approval resolver (AD-3):** no hard-coded role assignments in workflow code.
- **Compliance spine as platform layer (AD-12):** the edit log, DOA registry, business-stream tagging, event-sourced location, calibration lockout, and statutory document triggers are the bottom of the dependency graph and must be delivered first.
- **Spine Acceptance Contract tests:** five tests against a deployed spine with no modules: Edit Log Integrity (FR-AC-13), DOA Registry Resolution (FR-DOA-01), Event-Sourced Location (INT-LOC-01), Calibration Lockout (FR-M-13), Business-Stream Tagging (FR-AC-01).
- **Consistency conventions:** singular entity names; past-tense dot-separated event names; imperative PascalCase command names; UUIDv4 internal IDs; UTC timestamps with IST `business_date` field; uniform error envelope `{ error_code, message, details, trace_id }`; stable error codes list.
- **Retention policy:** event store 8 financial years online (PostgreSQL) + permanent S3 Glacier archive; CoA/CoC 7 years; gate passes 8 years; GST documents 8 years; calibration certificates life + 3 years; DPDP PII crypto-shred on erasure.
- **API contract:** REST over HTTPS, URL-prefixed `/api/v1/`, SSO-gated, mutating operations logged with `trace_id`.
- **ERP dual mastership (INT-ERP-01):** BOM structure outbound only; cost rates inbound only. Inbound conflicts create BOM Administrator exceptions, never overwrites.
- **Data migration hard sequencing:** FR-M instrument records before FR-Q-04 calibration lockout goes live (C-12); BIS licence data in product master before FR-Q-11 (A-13); item-master governance and INT-ERP-01 before FR-B-06 BOM release (A-11); migrated balances signed off before any go-live (FR-DM-03).
- **Phase 1 first go-live slice (pilot site):** Compliance spine + core inventory + frontline gate edge + job-work services. Remaining Phase 1 items follow in waves of 2 to 3 locations each.
- **Deferred decisions (not in stories yet):** framework choice (Next.js 16 vs TanStack Start 1.x); build sourcing; pilot site selection; budget envelope; detailed per-module schema; GraphQL vs REST for reporting; meter ingestion automation (INT-MTR-01, Phase 2); EPR portal automation (INT-EPR-01, Phase 2).

### UX Design Requirements

No UX design contract documents were found in `_bmad-output/planning-artifacts/ux-designs/` or any matching pattern. The PRD provides four fully-worked user journeys (UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01, UJ-IND-01) and the addendum provides frontline story machinery guidance. These serve as the UX input for frontline stories. No separate `UX-DR` items are generated at this stage.

### FR Coverage Map

| FR | Epic | Phase |
| --- | --- | --- |
| FR-I-01 to FR-I-10 | Epic 2: Core Inventory and Multi-Location Stock Visibility | Phase 1 |
| FR-AC-05, FR-AC-06 | Epic 2: Core Inventory (Ind AS 2 valuation) | Phase 1 |
| FR-W-01 to FR-W-09 | Epic 3: Warehouse Operations and Frontline Capture Flows | Phase 1 |
| FR-P-01 to FR-P-09 | Epic 4: Procurement and Supplier Management | Phase 1 |
| FR-B-01 to FR-B-17 | Epic 5: BOM and Engineering Change Management | Phase 1 |
| FR-MO-01 to FR-MO-13 | Epic 6: Production Orders and Manufacturing WIP | Phase 1 |
| FR-M-01 to FR-M-18 | Epic 7: Maintenance, Calibration, and Asset Register | Phase 1 |
| FR-Q-01 to FR-Q-15 | Epic 8: Quality Control and Batch Release | Phase 1 |
| FR-JW-01 to FR-JW-15 | Epic 9: Job-Work Services | Phase 1 |
| FR-AC-11 | Epic 9: Job-Work Services (Rule 45 challans, ITC-04) | Phase 1 |
| FR-RD-01 to FR-RD-20 | Epic 10: R&D and Maker-Hub Operations | Phase 1 |
| FR-AC-02, FR-AC-03 | Epic 10: R&D (Ind AS 38 research/development classification) | Phase 1 |
| FR-AC-04 | Epic 10: R&D (project-wise cost ledgers, Form 3CL) | Phase 1 |
| FR-AC-12 | Epic 10: R&D (maker-hub B2C invoices) | Phase 1 |
| FR-AC-16 | Epic 10: R&D (funding-source tagging) | Phase 1 |
| FR-AC-01 | Epic 1: Compliance Spine (business-stream tagging) | Phase 1 |
| FR-AC-13 | Epic 1: Compliance Spine (statutory edit log) | Phase 1 |
| FR-DOA-01 | Epic 1: Compliance Spine (DOA registry) | Phase 1 |
| FR-AC-07, FR-AC-08 | Epic 11: Financial Compliance and Period Close (ITC register) | Phase 1 |
| FR-AC-10 | Epic 11: Financial Compliance (branch-transfer GST documents) | Phase 1 |
| FR-AC-14 | Epic 11: Financial Compliance (IRN before dispatch) | Phase 1 |
| FR-AC-15 | Epic 11: Financial Compliance (period locks, reconciliation) | Phase 1 |
| FR-BC-01, FR-BC-02 | Epic 11: Financial Compliance (budget control) | Phase 1 |
| FR-R-01 to FR-R-08 | Epic 12: Cross-Module Reporting and Executive Analytics | Phase 1 |
| FR-DM-01 to FR-DM-03 | Epic 13: Data Migration Sign-Off Gate | Phase 1 |
| FR-T-01 to FR-T-07 | Epic 14: Tender Management | Phase 2 |
| FR-O-01 to FR-O-08 | Epic 15: Order Management, Demand Planning, and Logistics | Phase 2 |
| FR-D-01 to FR-D-08 | Epic 15: Order Management, Demand Planning, and Logistics | Phase 2 |
| FR-L-01 to FR-L-08 | Epic 15: Order Management, Demand Planning, and Logistics | Phase 2 |
| FR-SC-01 to FR-SC-22 | Epic 16: Scrap, Defectives, and Disposal | Phase 2 |
| FR-AC-09 | Epic 16: Scrap (scrap-sale tax events as dated configuration) | Phase 2 |
| FR-FA-01 to FR-FA-20 | Epic 17: Fixed Assets, Intangibles, and Depreciation | Phase 2 |
| FR-IM-01 to FR-IM-09 | Epic 18: Imports and Landed Cost | Phase 2 |
| FR-TL-01 to FR-TL-17 | Epic 19: Tooling and Tool Crib | Phase 2 |
| FR-GP-01 to FR-GP-14 | Epic 20: Gate Passes and Returnable Materials | Phase 2 |

## Epic List

> **Pilot go-live slice (first go-live at a single site):** Epics 1, 2, 3, 5, 7, 8, 9 + Epic 13 sign-off gate. These seven epics constitute the minimum viable set for the pilot: compliance spine, core inventory, frontline warehouse capture, BOM (for job-work kit BOMs), maintenance instruments (hard prerequisite for QC lockout), QC gate, and job-work services.

> **Migration prep note:** Migration activities (data extraction, staging verification, reconciliation) run concurrent with Epics 2 through 12. Each module epic notes its migration prep dependency. Epic 13 is the sign-off gate, not the start of migration work.

> **Reporting scope note:** Operational status and domain dashboards (e.g., requisition status, stock-by-location, open work orders) are stories within their respective module epics. Epic 12 adds the cross-module executive layer and self-service ad-hoc reporting.

---

### Epic 1: Platform Foundation, Compliance Spine, and Offline Edge Shell

**Goal:** Every transaction in the system is compliant by construction from day one. The statutory edit log is tamper-proof and auditor-readable. DOA registry resolves every approval chain. Business-stream tagging blocks untagged transactions at the write path. SSO gates every user. The event store, sync layer, and offline edge PWA shell are deployed and operational — a gate officer can hold the edge device, open the app, and see their site with the "captured, pending sync" indicator with no active network. The Spine Acceptance Contract's five tests pass before any module epic begins.

**FRs covered:** FR-AC-01, FR-AC-13, FR-DOA-01

**Architecture delivered:** Node.js 24 LTS / PostgreSQL 18.4 / PowerSync 1.23.x / AWS ECS Fargate + Aurora Multi-AZ, INT-IAM-01/02 (SSO/SCIM), central event store schema (domain_events), offline edge PWA shell (SQLite schema + PowerSync client + "captured, pending sync" status shell), idempotency key infrastructure (AD-16), event envelope schema (AD-1, AD-12)

**Depends on:** None (foundation)

**Spine Acceptance Contract:** Five tests pass before any module story starts: Edit Log Integrity (FR-AC-13), DOA Registry Resolution (FR-DOA-01), Event-Sourced Location (INT-LOC-01), Calibration Lockout (FR-M-13 - write rejection), Business-Stream Tagging (FR-AC-01 - untagged transaction blocked)

---

### Epic 2: Core Inventory and Multi-Location Stock Visibility

**Goal:** Stock controllers and managers can answer "what do we hold, where is it, and what is it worth" in real time across all locations. Lot and serial traceability enables FEFO/FIFO picking, expiry management, and recall readiness. Consignment and VMI stock is segregated from owned inventory. Valuation is Ind AS 2 compliant (FIFO, weighted average, specific identification; LIFO blocked).

**FRs covered:** FR-I-01, FR-I-02, FR-I-03, FR-I-04, FR-I-05, FR-I-06, FR-I-07, FR-I-08, FR-I-09, FR-I-10, FR-AC-05, FR-AC-06

**Depends on:** Epic 1

**Migration prep:** Opening stock physically verified by location, lot, and serial (FR-DM-01) must be staged in parallel with Epic 2 development and validated against the live ledger before pilot go-live.

---

### Epic 3: Warehouse Operations and Frontline Capture Flows

**Goal:** Gate officers, weighbridge operators, and store assistants capture every inbound movement from vehicle entry to bin in seconds, gloved, one-handed, offline when needed — with the system never silently dropping an event and showing "captured, pending sync" on the device. Warehouse managers execute receiving, system-directed putaway, picking, packing, and shipping with full traceability. Overrides made by store assistants improve directed bins for the whole team (NFR-ADOPT-01). Realizes UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01.

**FRs covered:** FR-W-01, FR-W-02, FR-W-03, FR-W-04, FR-W-05, FR-W-06, FR-W-07, FR-W-08, FR-W-09

**Architecture:** Gate-token event chain (AD-2) — gate event creates the vehicle-to-PO binding token; all subsequent events (weighbridge, receiving, putaway) reference it. Event-sourced location (AD-15) — asserted vs. expected location; last-writer-wins blocked. INT-GATE-01, INT-DC-01..03 (barcode + weighbridge capture).

**Depends on:** Epics 1, 2

**Note:** Edge PWA shell is operational from Epic 1. Epic 3 stories build the gate, weighbridge, putaway, and task flows on that platform — no ground-up PWA work here.

---

### Epic 4: Procurement and Supplier Management

**Goal:** Procurement officers manage the full source-to-pay cycle: supplier registry through requisition, PO issuance, goods receipt with QC trigger, and three-way invoice matching. Floor supervisors raise indents from a phone in under 90 seconds and always see live status with push-notification decisions — never chase, never raise it twice (UJ-IND-01). MSME payment discipline is enforced at every PO; zero s.43B(h) carry-over at year-end.

**FRs covered:** FR-P-01, FR-P-02, FR-P-03, FR-P-04, FR-P-05, FR-P-06, FR-P-07, FR-P-08, FR-P-09

**Depends on:** Epics 1, 2, 3

**Note:** Tender management (FR-T-01..07) is Phase 2 / Epic 14.

---

### Epic 5: BOM and Engineering Change Management

**Goal:** Engineering teams manage the full lifecycle of production and R&D BOMs with enforced immutability for released revisions and an ECO-only change path. R&D draft BOMs iterate freely but cannot execute in production without a signed productization gate. The platform becomes the system of record for BOM structure; ERP receives outbound-only sync and conflicts create BOM Administrator exceptions, never overwrites (AD-4).

**FRs covered:** FR-B-01, FR-B-02, FR-B-03, FR-B-04, FR-B-05, FR-B-06, FR-B-07, FR-B-08, FR-B-09, FR-B-10, FR-B-11, FR-B-12, FR-B-13, FR-B-14, FR-B-15, FR-B-16, FR-B-17

**Depends on:** Epics 1, 2

**Hard prerequisite:** Item master governance (FR-I + INT-ERP-01) must be stable before BOM release gate (FR-B-06) goes live (A-11).

**Migration prep:** Active BOMs must be migrated and department-verified before pilot go-live (FR-DM-02).

---

### Epic 6: Production Orders and Manufacturing WIP

**Goal:** Production supervisors and operators release, execute, and close production orders against verified material availability and Released BOMs. Every finished lot carries a full as-consumed lot genealogy. Production WIP is a real-time auditable ledger, distinct from R&D project WIP (AD-5). Over-completion, short completion, rework, and process scrap are enforced approval workflows, not workarounds. Plant execution continues offline and replays cleanly on reconnection.

**FRs covered:** FR-MO-01, FR-MO-02, FR-MO-03, FR-MO-04, FR-MO-05, FR-MO-06, FR-MO-07, FR-MO-08, FR-MO-09, FR-MO-10, FR-MO-11, FR-MO-12, FR-MO-13

**Depends on:** Epics 1, 2, 3, 5

---

### Epic 7: Maintenance, Calibration, and Asset Register

**Goal:** Maintenance technicians and supervisors have one asset register company-wide for everything from a two-tonne mould to a hub screwdriver. PM plans auto-generate work orders on calendar and meter-based schedules. Anyone can report a fault by scanning an asset tag; the message reaches the location's maintenance supervisor within 5 minutes. The calibration register and its non-overridable lockout (FR-M-13) mean QC can trust every instrument result — no role can bypass the lockout; escalation expedites calibration, never bypasses it (AD-8). Technician workflows are fully offline.

**FRs covered:** FR-M-01, FR-M-02, FR-M-03, FR-M-04, FR-M-05, FR-M-06, FR-M-07, FR-M-08, FR-M-09, FR-M-10, FR-M-11, FR-M-12, FR-M-13, FR-M-14, FR-M-15, FR-M-16, FR-M-17, FR-M-18

**Depends on:** Epics 1, 2

**Hard prerequisite for Epic 8:** FR-M instrument records must be loaded before the FR-Q-04 calibration lockout goes live (C-12).

---

### Epic 8: Quality Control and Batch Release

**Goal:** QC inspectors and heads can disposition every finished goods lot before it reaches sellable stock — no bypass, urgency uses conditional release. AQL sampling, calibration-locked result capture, CoA/CoC generation, NCR outcomes (rework, downgrade, scrap), CAPA linkage, BIS and Legal Metrology hooks, and customer-witnessed inspections are all enforced workflows. Quality holds propagate everywhere within 15 minutes; where-used and where-shipped trace is immediate. Zero dispatch lines without a batch release record (SM-28).

**FRs covered:** FR-Q-01, FR-Q-02, FR-Q-03, FR-Q-04, FR-Q-05, FR-Q-06, FR-Q-07, FR-Q-08, FR-Q-09, FR-Q-10, FR-Q-11, FR-Q-12, FR-Q-13, FR-Q-14, FR-Q-15

**Depends on:** Epics 1, 2, 7

**Hard prerequisite:** Epic 7 instrument records loaded before Epic 8 calibration lockout activates (C-12). BIS licence data in product master before FR-Q-11 goes live (A-13).

---

### Epic 9: Job-Work Services

**Goal:** Operations teams receive customer-owned material through the gate and receiving flows, execute job-work orders against customer-supplied kit BOMs, maintain a per-customer per-order custody ledger, dispatch output only after QC release, and collect a measured billing feed to ERP. Statutory return clocks (one-year and three-year) run visibly from the challan date with escalation — no challan expires silently. Customer custody statements print on demand. No job-work order closes with a non-zero custody ledger (AD-6). 100% of job-work returns within statutory windows (SM-34).

**FRs covered:** FR-JW-01, FR-JW-02, FR-JW-03, FR-JW-04, FR-JW-05, FR-JW-06, FR-JW-07, FR-JW-08, FR-JW-09, FR-JW-10, FR-JW-11, FR-JW-12, FR-JW-13, FR-JW-14, FR-JW-15, FR-AC-11

**Depends on:** Epics 1, 2, 3, 5, 8

---

### Epic 10: R&D and Maker-Hub Operations

**Goal:** R&D project managers issue materials against project codes under committed-plus-actual budget control, with three semantically distinct issue types (consumable, project WIP, custody loan). Prototype builds carry full material history including failed and abandoned builds. Hub operators run offline point-of-use sales with UPI/card capture. Every rupee of R&D spend has an audit trail that feeds Form 3CL without year-end archaeology. Research vs. development classification follows the six Ind AS 38 criteria from the first transaction; no retroactive reinstatement.

**FRs covered:** FR-RD-01, FR-RD-02, FR-RD-03, FR-RD-04, FR-RD-05, FR-RD-06, FR-RD-07, FR-RD-08, FR-RD-09, FR-RD-10, FR-RD-11, FR-RD-12, FR-RD-13, FR-RD-14, FR-RD-15, FR-RD-16, FR-RD-17, FR-RD-18, FR-RD-19, FR-RD-20, FR-AC-02, FR-AC-03, FR-AC-04, FR-AC-12, FR-AC-16

**Depends on:** Epics 1, 2, 4

---

### Epic 11: Financial Compliance and Period Close

**Goal:** Finance teams close periods with a signed-off subledger-to-GL reconciliation. The ITC register is current per GSTIN with auto-computed ITC reversals on write-offs. Every e-invoiceable dispatch is blocked until an IRN and signed QR are received from the IRP flow. Branch transfers between GSTINs trigger Rule 28 valuation and the correct GST documents before dispatch. ERP-synced budget heads show remaining availability inline at every approval; commitments reduce availability until ERP actuals sync. Phase 2 modules (scrap, imports, fixed assets) extend this module's ITC register and reconciliation via new event subscribers — no Epic 11 stories require change for Phase 2 additions.

**FRs covered:** FR-AC-07, FR-AC-08, FR-AC-10, FR-AC-14, FR-AC-15, FR-BC-01, FR-BC-02

**Depends on:** Epics 1, 2, 3, 9, 10

---

### Epic 12: Cross-Module Reporting and Executive Analytics

**Goal:** Executives drill from KPIs (inventory turns, fill rate, procurement spend, stockout count, forecast accuracy) to the underlying transactions in a single pane. All roles have role-specific operational dashboards and exception alerts that surface what needs attention without navigation. Self-service ad-hoc reporting with Excel/PDF/CSV export and scheduled distribution eliminates the report-request queue.

**FRs covered:** FR-R-01, FR-R-02, FR-R-03, FR-R-04, FR-R-05, FR-R-06, FR-R-07, FR-R-08

**Depends on:** Epics 1-11

**Scope boundary:** Operational domain status views (requisition status, current stock by location, open work orders, open indents, job-work challan aging) are stories within their respective module epics (Epics 2-11). Epic 12 delivers the cross-module executive layer: multi-domain KPI dashboards, unified drill-through, and self-service ad-hoc reporting across all modules.

---

### Epic 13: Data Migration Sign-Off Gate

**Goal:** The system goes live with zero unexplained opening-balance variances (SM-48). Department heads and finance sign off that physically verified stock balances, the asset register with depreciation, open POs, active BOMs, job-work challans, custody registers, and open gate passes in the new system match ERP and legacy records line for line. This sign-off is the mandatory go-live gate.

**FRs covered:** FR-DM-01, FR-DM-02, FR-DM-03

**Depends on:** All Epics 1-12 (sign-off gate requires production-ready system)

**Critical note:** Migration *execution* (data extraction, staging loads, dry-run cycles, reconciliation) runs concurrent with Epics 2-12, not sequentially after them. Module epics each note the migration prep they need. Epic 13 is the *sign-off event*, not the start of migration work. Teams who treat Epic 13 as "migrate then sign off" will produce a six-week fire drill at go-live.

---

## Phase 2 Epics (planned, stories not yet created)

### Epic 14: Tender Management

**Goal:** Procurement officers run formal competitive tender processes end-to-end: authoring RFQ/RFP/RFI with templates, supplier invitation, secure sealed bid portal, clarification Q&A, controlled weighted-score opening, award approval with notification, and contract generation linked to POs.

**FRs covered:** FR-T-01, FR-T-02, FR-T-03, FR-T-04, FR-T-05, FR-T-06, FR-T-07

**Depends on:** Epic 4

---

### Epic 15: Order Management, Demand Planning, and Logistics

**Goal:** Operations managers capture multi-channel orders, route them to optimal fulfillment locations, manage split shipments and backorders, run statistical demand forecasting with auto-selected models, replenish based on forecasts (with BOM explosion for dependent demand), and manage carrier rates, shipment planning, freight audit, and returns logistics.

**FRs covered:** FR-O-01..08, FR-D-01..08, FR-L-01..08

**Depends on:** Epics 2, 5

---

### Epic 16: Scrap, Defectives, and Disposal

**Goal:** Every scrap receipt is source-linked, classified, weighed with photo evidence, and reconciled against BOM scrap percents. Disposal runs a DOA-approved, buyer-registered auction with EMD lifecycle and payment-before-lifting. Hazardous waste runs Form 10 manifests with a non-disableable 90-day storage timer. EPR channels enforce statutory routing for e-waste, battery, and plastic packaging.

**FRs covered:** FR-SC-01..22, FR-AC-09

**Depends on:** Epics 1, 2, 11

---

### Epic 17: Fixed Assets, Intangibles, and Depreciation

**Goal:** Finance teams manage the operational asset subledger — CWIP accumulation, component accounting, Schedule II SLM/WDV depreciation runs with preview-and-approve posted to ERP, offline physical verification by tag scan, and an intangibles register with IAUD ageing and amortization. The ERP GL stays the book of record.

**FRs covered:** FR-FA-01..20

**Depends on:** Epics 1, 2, 7

---

### Epic 18: Imports and Landed Cost

**Goal:** Import officers capture Bill of Entry by duty head, compute landed cost sheets with selectable allocation bases, keep recoverable import IGST in the ITC register (BCD/SWS never creditable), manage the two-year provisional assessment lifecycle, reconcile with ICEGATE/GSTR-2B, and handle duty-exemption licence hooks (Advance Authorisation, EPCG).

**FRs covered:** FR-IM-01..09

**Depends on:** Epics 1, 2, 4, 11

---

### Epic 19: Tooling and Tool Crib

**Goal:** Tool crib operators issue and return tools by QR scan, life counters auto-increment from production confirmations, hard-stop thresholds block issue when a tool exceeds its life, regrind/repair routing covers IP-sensitive tooling, and condemned tools exit through the scrap module with evidenced defacement. Gauge calibration lockout applies at issue.

**FRs covered:** FR-TL-01..17

**Depends on:** Epics 1, 2, 5, 7, 16

---

### Epic 20: Gate Passes and Returnable Materials

**Goal:** Every non-sale, non-job-work, non-scrap outbound movement requires a serially numbered RGP or NRGP linked to a driving document. Return clocks never expire silently. Gate enforcement blocks exit without a matching open pass. Returnable packaging registers track per-party deposits, refunds, and serialized cylinders.

**FRs covered:** FR-GP-01..14

**Depends on:** Epics 1, 2, 3
