---
stepsCompleted: ["step-01", "step-02", "step-03"]
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
- FR-O-01 to FR-O-08: Order capture (manual, EDI, e-commerce, internal, inter-branch), validation (completeness, credit, availability), routing by configurable rules, split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, drop shipping.
- FR-D-01 to FR-D-08: Historical data analysis at SKU-location grain, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, NPI forecasting by analogy, replenishment planning (with BOM explosion for dependent demand per FR-B-07), inventory optimization and redistribution.
- FR-L-01 to FR-L-08: Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, returns logistics.

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
- FR-JW-09/10: Contractual offcut is captured to a separate holding ledger at quantity grain, unvalued, under its own contract reference, and retained until disposal. Disposal is elected at disposal time and is one of two branches: the material is RETURNED to the customer as their own property, or it is ACQUIRED by the processor at the rate the finance controller sets, which transfers title and raises a credit note. Any onward resale, whether back to the customer, to a scrap buyer or at auction, happens afterwards to stock the processor already owns and is an ordinary sale, not a job-work event.
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
- FR-Q-07: Batch release records and CoA/CoC per lot; retention default 7 years, never below BIS STI requirements.
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
- FR-TL-01 to FR-TL-17: Tool crib: tool master with class and QR tag; where-used through FR-B; asset and cost cross-reference; scan-based custody issue and return with overdue escalation; hub member lending with block policy; perishable tooling as min-max stock; life counters auto-incremented from production confirmations; warning and hard-stop thresholds blocking issue; life history surviving regrinds; regrind/repair routing (with confidentiality reference for IP-sensitive tooling); regrind limits proposing condemnation; condemnation exits through FR-SC with defacement; gauge calibration lockout at issue; personal PPE issue register with renewal cycles; tool availability broadcast to planning and booking; offline crib transactions with conflict escalation.

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
- FR-SC-14/15/16: EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment.
- FR-SC-17: Sale documents with GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers.
- FR-SC-18: Hazardous waste to authorized recyclers/TSDFs with Form 10 manifests and non-disableable 90-day storage timer.
- FR-SC-19: E-waste, battery, and non-ferrous EPR channels; awards blocked to unregistered buyers.
- FR-SC-20: Write-off and destruction with witness and evidence; auto-triggers ITC reversal evaluation and FA derecognition.
- FR-SC-21: Generated vs weighed vs disposed reconciliation per class per location; internal audit read-only access.
- FR-SC-22: Plastic packaging EPR data by category, GSTIN, and financial year for CPCB portal returns.

**Fixed Assets, Intangibles, and Depreciation (FR-FA)**
- FR-FA-01 to FR-FA-06: Asset master with tags and parent-child components; capitalization from procurement through CWIP at Ind AS 16 available-for-use; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs posting to ERP after preview.
- FR-FA-07: Dual views: Companies Act books view plus report-only income-tax block-of-assets WDV view.
- FR-FA-08: Effective-dated transfers reallocating depreciation; inter-GSTIN moves trigger FR-AC-10 documents before dispatch.
- FR-FA-09/10: Subsequent expenditure decisions; repair-vs-capitalize queue from FR-M work orders, none undecided at period lock.
- FR-FA-11: Impairment indicator capture per Ind AS 36.
- FR-FA-12: Retirement and disposal through FR-SC with gain/loss computation.
- FR-FA-13: Offline physical verification by tag scan per CARO 2020 with reconciliation evidence.
- FR-FA-14: Immutable asset audit trail.
- FR-FA-15 to FR-FA-20: Intangibles: register separate from PPE; IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing; capitalization and amortization at available-for-use; annual reviews of period, method, and indefinite-life assessments; impairment extension including annual tests where required; derecognition and approval-gated IAUD write-offs.

**Financial Compliance Spine (FR-AC, FR-IM, FR-BC, FR-DOA)**
- FR-AC-01: Every inventory movement carries business stream, cost centre, and project code where applicable; untagged transactions blocked.
- FR-AC-02/03: Research-phase issues expense; development-phase capitalization only after the six-criteria checklist; no retroactive reinstatement.
- FR-AC-04: Project-wise R&D cost ledgers producing DSIR and Form 3CL-ready statements.
- FR-AC-05/06: Permitted cost formulas per Ind AS 2; period-end NRV testing with capped reversals.
- FR-AC-07/08: ITC register per GSTIN traced to GRN, invoice, and IRN; ITC reversal computed on write-offs before disposal closes.
- FR-AC-09: Scrap-sale tax events (GST classification, e-invoice, e-way bill, TCS) as dated configuration, not code.
- FR-AC-10: Branch transfers between GSTINs as taxable supplies with Rule 28 valuation and documents before dispatch.
- FR-AC-11: Job-work challans (Rule 45) with one-year and three-year return clocks, deemed-supply on breach, ITC-04 data.
- FR-AC-12: Maker-hub B2C invoices at item rates, separated from machine-time service charges; never miscellaneous income.
- FR-AC-13: Statutory edit log: tamper-proof, non-disableable, retained per books-retention, auditor-reportable.
- FR-AC-14: Dispatch blocked for e-invoiceable supplies until IRN and signed QR received.
- FR-AC-15: Period locks, GRNI ageing, subledger-to-GL reconciliation, CARO physical-verification evidence.
- FR-AC-16: Funding-source tagging (internal, DSIR, DST, grants) on R&D projects.
- FR-IM-01 to FR-IM-09: Imports: import-flagged POs with dual exchange rates; Bill of Entry capture by duty head; import IGST into the ITC register (BCD/SWS never creditable); landed cost sheets with selectable allocation bases; valuation posting keeping recoverable taxes out of item cost; provisional assessment lifecycle with two-year window; late cost true-up windows with PPV fallback; ICEGATE/GSTR-2B reconciliation; duty-exemption licence hooks (Advance Authorisation, EPCG).
- FR-BC-01/02: ERP-synced budget heads and availability; inline budget-remaining at approval; commitments reduce availability until ERP actuals sync.
- FR-DOA-01: One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow; workflow config consumes, never overrides it.

**Gate Passes, Returnable Materials, and Frontline Edge Capture (FR-GP)**
- FR-GP-01: RGP and NRGP as distinct serially numbered documents per GSTIN and site; required for every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch.
- FR-GP-02/03: RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request).
- FR-GP-04: Rule 55 delivery challans and e-way bill triggers for non-sale movements above threshold.
- FR-GP-05/06/07: Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return updating asset registers.
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
- **Tech stack:** Node.js 24 LTS, PostgreSQL 18.4 (self-managed), PowerSync Service 1.23.x (self-hosted), **Next.js 16** (pinned 2026-07-12; self-hosted standalone), TypeScript 5.x, Docker + Docker Compose, nginx/Caddy reverse proxy, pgBackRest for WAL archiving/backups.
- **Deployment:** vendor-neutral, targeting a **native server or cloud VPS** (single node, or clustered for HA). Production = primary + streaming-replication standby; DR = warm standby on a second host/site. RTO 4h, RPO 1h. No dependency on any cloud-vendor-proprietary managed service; a managed-cloud profile remains an optional alternative (see architecture Deployment Topology).
- **Event envelope:** Every event carries `event_id` (UUIDv4), `stream_type`, `stream_id`, `event_version` (monotonic sequence), `payload` (JSONB validated), and metadata (correlation, causation, actor, device, capture method, timestamps). No mutable domain state columns.
- **Offline sync via PowerSync:** Edge devices write to local SQLite; PowerSync replicates to PostgreSQL central event store. Every edge command must carry an `idempotency_key` to prevent duplicate events (AD-16).
- **Gate-token event chain (AD-2):** every inbound event chain starts with a gate token. All subsequent events (weighbridge, receiving, putaway) reference it.
- **DOA registry as single approval resolver (AD-3):** no hard-coded role assignments in workflow code.
- **Compliance spine as platform layer (AD-12):** the edit log, DOA registry, business-stream tagging, event-sourced location, calibration lockout, and statutory document triggers are the bottom of the dependency graph and must be delivered first.
- **Spine Acceptance Contract tests:** five tests against a deployed spine with no modules: Edit Log Integrity (FR-AC-13), DOA Registry Resolution (FR-DOA-01), Event-Sourced Location (INT-LOC-01), Calibration Lockout (FR-M-13), Business-Stream Tagging (FR-AC-01).
- **Consistency conventions:** singular entity names; past-tense dot-separated event names; imperative PascalCase command names; UUIDv4 internal IDs; UTC timestamps with IST `business_date` field; uniform error envelope `{ error_code, message, details, trace_id }`; stable error codes list.
- **Retention policy:** event store 8 financial years online (PostgreSQL) + permanent archive to an object-storage cold/archive tier (S3-compatible or equivalent; restorable to queryable within 48h); CoA/CoC 7 years; gate passes 8 years; GST documents 8 years; calibration certificates life + 3 years; DPDP PII crypto-shred on erasure.
- **API contract:** REST over HTTPS, URL-prefixed `/api/v1/`, SSO-gated, mutating operations logged with `trace_id`.
- **ERP dual mastership (INT-ERP-01):** BOM structure outbound only; cost rates inbound only. Inbound conflicts create BOM Administrator exceptions, never overwrites.
- **Data migration hard sequencing:** FR-M instrument records before FR-Q-04 calibration lockout goes live (C-12); BIS licence data in product master before FR-Q-11 (A-13); item-master governance and INT-ERP-01 before FR-B-06 BOM release (A-11); migrated balances signed off before any go-live (FR-DM-03).
- **Phase 1 first go-live slice (pilot site):** Compliance spine + core inventory + frontline gate edge + job-work services. Remaining Phase 1 items follow in waves of 2 to 3 locations each.
- **Deferred decisions (not in stories yet):** build sourcing; pilot site selection; budget envelope; detailed per-module schema; GraphQL vs REST for reporting; meter ingestion automation (INT-MTR-01, Phase 2); EPR portal automation (INT-EPR-01, Phase 2). _(Frontend framework resolved 2026-07-12: Next.js 16, self-hosted on native server / VPS — no longer deferred.)_

### UX Design Requirements

No UX design contract documents were found in `_bmad-output/planning-artifacts/ux-designs/` or any matching pattern. The PRD provides four fully-worked user journeys (UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01, UJ-IND-01) and the addendum provides frontline story machinery guidance. These serve as the UX input for frontline stories. No separate `UX-DR` items are generated at this stage.

### FR Coverage Map

| FR | Epic | Phase |
| --- | --- | --- |
| FR-I-01 to FR-I-10 | Epic 2: Core Inventory and Multi-Location Stock Visibility | Phase 1 |
| FR-AC-05, FR-AC-06 | Epic 2: Core Inventory (Ind AS 2 valuation) | Phase 1 |
| FR-W-01 to FR-W-09 (FR-W-06 partial: customs docs, carrier rate shopping, load planning deferred to Epic 15, Phase 2) | Epic 3: Warehouse Operations and Frontline Capture Flows | Phase 1 |
| FR-P-01 to FR-P-09 | Epic 4: Procurement and Supplier Management | Phase 1 |
| FR-B-01 to FR-B-07, FR-B-09 to FR-B-17 | Epic 5: BOM and Engineering Change Management | Phase 1 |
| FR-B-08 | Epic 6: Production Orders and Manufacturing WIP (consumption variance at order closure, Story 6.4) | Phase 1 |
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
| FR-R-01 to FR-R-04, FR-R-06 to FR-R-08 | Epic 12: Cross-Module Reporting and Executive Analytics | Phase 1 |
| FR-R-05 | Epic 15: Order Management, Demand Planning, and Logistics (fulfillment report suite) | Phase 2 |
| FR-DM-01 to FR-DM-03 | Epic 13: Data Migration Sign-Off Gate (Phase-1 domains; see FR-DM deferral note below) | Phase 1 |
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
**FR-DM deferral note:** Epic 13's sign-off gate covers the Phase-1 migration domains only: opening stock, active BOMs, open POs, job-work challans, and custody and loan registers. Three FR-DM clauses defer to the Phase-2 epics that own their data: open sales orders (FR-DM-01) migrate and verify in Epic 15, the asset register with cost, accumulated depreciation, and remaining Schedule II life (FR-DM-01) in Epic 17, and open gate passes (FR-DM-02) in Epic 20 — each carried as a migration scope note on that epic.

## Epic List

> **Pilot go-live slice (first go-live at a single site):** Epics 1, 2, 3, 5, 7, 8, 9 + Story 11.2 (IRN-before-dispatch enforcement) + Epic 13 sign-off gate (pilot-scoped — see Epic 13). These seven epics plus Story 11.2 constitute the minimum viable set for the pilot: compliance spine, core inventory, frontline warehouse capture, BOM (for job-work kit BOMs), maintenance instruments (hard prerequisite for QC lockout), QC gate, and job-work services. Story 11.2 is pulled forward because the pilot site dispatches e-invoiceable supplies from day one and GST law blocks such dispatches without an IRN and signed QR (FR-AC-14) — going live without it would contradict Epic 1's compliant-by-construction guarantee. During the pilot, the ERP remains the system of record for purchase orders and sales orders: the pilot consumes them as read-only reference projections via Story 2.9 (ERP Inbound Reference Projections); native PO management arrives with Epic 4 in the first rollout wave.

> **Migration prep note:** Migration activities (data extraction, staging verification, reconciliation) run concurrent with Epics 2 through 12. Each module epic notes its migration prep dependency. Epic 13 is the sign-off gate, not the start of migration work.

> **Reporting scope note:** Operational status and domain dashboards (e.g., requisition status, stock-by-location, open work orders) are stories within their respective module epics. Epic 12 adds the cross-module executive layer and self-service ad-hoc reporting.

---

### Epic 1: Platform Foundation, Compliance Spine, and Offline Edge Shell

**Goal:** Every transaction in the system is compliant by construction from day one. The statutory edit log is tamper-proof and auditor-readable. DOA registry resolves every approval chain. Business-stream tagging blocks untagged transactions at the write path. SSO gates every user. The event store, sync layer, and offline edge PWA shell are deployed and operational — a gate officer can hold the edge device, open the app, and see their site with the "captured, pending sync" indicator with no active network. The Spine Acceptance Contract's five tests pass before any module epic begins.

**FRs covered:** FR-AC-01 (business-stream + cost-centre/project-code tagging), FR-AC-13, FR-DOA-01, FR-M-13 (lockout enforcement invariant only — instrument records and the calibration register are Epic 7), INT-LOC-01, INT-IAM-01/02

**NFR foundations delivered:** NFR-U-02 (WCAG 2.1 AA UI standards, Story 1.8), NFR-U-03 (i18n foundation, Story 1.8), NFR-P-04 Tier 1 (offline-first edge availability), NFR-SEC-01/02 (SSO; RBAC to module, function, and location scope); notification and alerting foundation (Story 1.11) consumed by FR-P-04 (UJ-IND-01), FR-M-04, FR-GP-09/10, FR-JW-14

**Architecture delivered:** Node.js 24 LTS / PostgreSQL 18.4 (self-managed, primary + replica) / PowerSync 1.23.x (self-hosted) / Next.js 16 / Docker on a native server or cloud VPS, INT-IAM-01/02 (SSO/SCIM), central event store schema (domain_events), offline edge PWA shell (SQLite schema + PowerSync client + "captured, pending sync" status shell), idempotency key infrastructure (AD-16), event envelope schema (AD-1, AD-12), CI/CD pipeline + branch protection (Story 1.10), notification/alerting service (Story 1.11)

**Depends on:** None (foundation)

**Spine Acceptance Contract:** Five tests pass before any module story starts: Edit Log Integrity (FR-AC-13), DOA Registry Resolution (FR-DOA-01), Event-Sourced Location (INT-LOC-01), Calibration Lockout (FR-M-13 - write rejection), Business-Stream Tagging (FR-AC-01 - untagged transaction blocked)

---

#### Story 1.12: Edge UI Sign-In Through Keycloak (PKCE)

As a warehouse worker, technician, gate guard or migration lead,
I want to sign in to the edge UI with my own Keycloak account and stay signed in across the shift,
So that every screen I use presents my identity to the API and my actions are attributed to me.

**Acceptance Criteria:**

**Given** an unauthenticated browser opens the edge UI (NFR-SEC-01)
**When** any screen loads
**Then** the user is redirected to Keycloak's login page for the `ims` realm using the authorization code flow with PKCE (client `ims-app`, no client secret), and returns to the screen they asked for

**Given** a signed-in user (Story 1.2)
**When** the UI calls any `/api/v1/...` endpoint, including PowerSync credentials and edge sync uploads
**Then** the request carries `Authorization: Bearer <access token>` whose `aud` is `ims-app` and whose email claim names the user's directory record, so `src/middleware/auth.ts` resolves the same role assignments the SCIM seam provisioned

**Given** an access token about to expire (15 minutes, realm setting)
**When** the user keeps working, online or after reconnecting
**Then** the token is refreshed silently with the refresh token; a refresh that fails sends the user back to the login page with their unsent captures preserved in the outbox

**Given** a signed-in user on a shared tablet
**When** they sign out
**Then** the Keycloak session ends (front-channel logout), tokens are cleared from the device, and the next user must sign in as themselves

**Given** a device that is offline (FR-M-17, Story 7.8)
**When** the UI starts with a still-valid token cached
**Then** capture continues offline and the token is used when the sync connector reconnects; no login is demanded until the token is actually rejected

**Note:** Created 2026-09-13 from the staging deployment (round table). Story 1.2 delivered the server side of SSO; the browser never obtained a token because development ran with `AUTH_MODE=local`. Pre-pilot blocking: without it the pilot week is API-only. The rehearsal uses the temporary `ims-cli` direct-access client for operator scripts; that client is deleted when this story ships.


#### Story 1.13: Refused and Parked Captures Are Never Lost

As a site supervisor,
I want every capture the central system refuses to stay visible on the device and to land in a central refused-captures queue,
So that no stock movement silently disappears when a tablet syncs, is reset, or changes hands.

**Acceptance Criteria:**

**Given** a capture the central system permanently refuses
**When** PowerSync applies its next checkpoint
**Then** the capture is still listed as "Needs attention" on the device (local-only retention, AD-18), with its `error_code`

**Given** the same refusal
**When** the server rejects the upload
**Then** a refused-capture record (event_id, envelope, actor, site, error_code, trace_id, time) is written centrally for every module, event-sourced like the Story 7.8 sync-conflict queue

**Given** captures parked for another person on a shared device (Story 1.12)
**When** checkpoints apply
**Then** they survive and re-queue when that person signs in

**Given** a supervisor for the site
**When** they call the refused-captures API
**Then** they can list open refusals and mark one resolved with a note (DOA-gated)

**Given** the edge test suite
**When** it runs
**Then** at least one test drives a real PowerSync service through a refuse-then-checkpoint cycle, and runbook section 2 gains the same manual check (row 2.10c)

**Note:** PRE-PILOT BLOCKING. Created 2026-09-15 by `sprint-change-proposal-2026-09-15.md`: on staging (2026-09-14) a refused capture showed "Needs attention" and was deleted about 240 ms later when PowerSync applied a checkpoint, because `edge_outbox` is a synced table. This remedies the Story 1.8 "visible needs attention" criterion without reopening Story 1.8.

#### Story 1.14: Refused-Captures Supervisor Screen

As a site supervisor,
I want a screen listing the captures the central system refused at my site,
So that I can see who captured what, why it was refused, and close each one with a note without calling an API by hand.

**Acceptance Criteria:**

**Given** a signed-in user holding a supervisor role for the site (Story 1.2 role assignments)
**When** they open `/supervisor/refused-captures` in the edge app
**Then** they see open refusals for their site only: time, person, device, capture type, and `error_code` with its operator message (`en.json` `errors.*`), newest first

**Given** a user without a supervisor role
**When** they open the page
**Then** it is not shown in navigation and the API returns 403

**Given** an open refusal
**When** the supervisor marks it resolved with a mandatory note
**Then** the Story 1.13 resolve API is called (DOA-gated), the row leaves the open list, and the resolution (who, when, note) stays visible under "Resolved"

**Given** the page
**When** it is checked by the CI accessibility audit and a keyboard-only pass
**Then** it meets the same WCAG 2.1 AA bar as the Story 1.8 shell (NFR-U-02), with all copy from `en.json`

**Given** the device is offline
**When** the page is opened
**Then** it states that the list needs a connection, and no stale cache is shown as current

**Note:** PILOT (ships before go-live, does not block the rehearsal). Depends on Story 1.13. Until it ships, supervisors use the Story 1.13 API or a runbook report query. Created 2026-09-15 by `sprint-change-proposal-2026-09-15.md`.

---

#### Story 1.15: Employee Base Role

As a signed-in employee holding no specialist role,
I want to raise a requisition, check stock availability, report damage, and see my own requests from the base employee capability,
So that everyday needs do not require a procurement or inventory role grant that hands me write access I should not have.

**Acceptance Criteria:**

**Given** a signed-in user whose only capability is the employee base role (extends Story 1.2 RBAC)
**When** they raise a purchase requisition
**Then** the requisition is accepted without any procurement write role - the current code path requires procurement write (`src/api/v1/indents.ts:557`), and this story removes that requirement for the raise action only

**Given** the same base-role user
**When** they look up stock availability for an item
**Then** they see availability (in stock or not, and where it can be requested from) without holding inventory read (`src/api/v1/stock.ts:195` currently requires it); quantities, valuations, and other inventory detail remain gated by inventory read

**Given** the same base-role user
**When** they report damage (Story 8.9 capture flow)
**Then** the report is accepted from the base role on any device

**Given** the same base-role user
**When** they open "My requests"
**Then** they see the live status of their own requisitions and damage reports only - no other user's requests and no procurement or inventory work queues

**Given** any signed-in user
**When** their menu renders
**Then** the visible entries derive from the access matrix capabilities they hold, with the employee base entries present for everyone

**Note:** PILOT. Ratified in the UX run 2026-09-23 to 2026-09-26 (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, EXPERIENCE.md IA base "employee" hat and run memlog). Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.

#### Story 1.16: Site Head Role

As a site head,
I want a provisioned `site_head` role recognised by RBAC and the DOA registry,
So that site-level authorities (standing approval grants, self-approval limits) resolve to a real person instead of a stand-in role.

**Acceptance Criteria:**

**Given** the access matrix
**When** this story lands
**Then** section 2 registers `site_head` (location scope: site) with its capability rows, and the role is in the pilot role pack

**Given** the pilot provisioning path (roles file, Keycloak role pack, `staging-provision-roles.sh`)
**When** roles are applied
**Then** a named `site_head` holder exists per pilot site and `verify:roles` reports it

**Given** the DOA registry
**When** a transaction type names `site_head`
**Then** `findRoleHolder` and delegation resolve a `site_head` holder at the transaction site like any other role

**Given** a user who is not a site head
**When** they call a site-head-gated action
**Then** it is refused with `FUNCTION_ACCESS_DENIED`

**Note:** PILOT. Prerequisite of Story 4.8. Source: user ruling 2026-09-29 (Story 4.8 open questions).

---

## Epic 2: Core Inventory and Multi-Location Stock Visibility

**Goal:** Stock controllers and managers can answer "what do we hold, where is it, and what is it worth" in real time across all locations. Lot and serial traceability enables FEFO/FIFO picking, expiry management, and recall readiness. Consignment and VMI stock is segregated from owned inventory. Valuation is Ind AS 2 compliant (FIFO, weighted average, specific identification; LIFO blocked).

**FRs covered:** FR-I-01, FR-I-02, FR-I-03, FR-I-04, FR-I-05, FR-I-06, FR-I-07, FR-I-08, FR-I-09, FR-I-10, FR-AC-05, FR-AC-06

**Depends on:** Epic 1

**Migration prep:** Opening stock physically verified by location, lot, and serial (FR-DM-01) must be staged in parallel with Epic 2 development and validated against the live ledger before pilot go-live.

---

### Epic 3: Warehouse Operations and Frontline Capture Flows

**Goal:** Gate officers, weighbridge operators, and store assistants capture every inbound movement from vehicle entry to bin in seconds, gloved, one-handed, offline when needed — with the system never silently dropping an event and showing "captured, pending sync" on the device. Warehouse managers execute receiving, system-directed putaway, picking, packing, and shipping with full traceability. Overrides made by store assistants improve directed bins for the whole team (NFR-ADOPT-01). Realizes UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01.

**FRs covered:** FR-W-01, FR-W-02, FR-W-03, FR-W-04, FR-W-05, FR-W-06 (partial — customs documentation, carrier rate shopping, and load planning are deferred to Phase 2 / Epic 15), FR-W-07, FR-W-08, FR-W-09

**Architecture:** Gate-token event chain (AD-2) — gate event creates the vehicle-to-PO binding token; all subsequent events (weighbridge, receiving, putaway) reference it. Event-sourced location (AD-15) — asserted vs. expected location; last-writer-wins blocked. INT-GATE-01, INT-DC-01..03 (barcode + weighbridge capture).

**Depends on:** Epics 1, 2 — including Story 2.9 (ERP Inbound Reference Projections), which supplies the read-only open-PO projections (with line tolerances) that Stories 3.2-3.4 bind against and the sales-order projections that provide Phase-1 outbound demand for Stories 3.6, 3.7, and 3.10. No Epic 4 PO-creation capability is required by any Epic 3 story.

**Note:** Edge PWA shell is operational from Epic 1. Epic 3 stories build the gate, weighbridge, putaway, and task flows on that platform — no ground-up PWA work here.

---

### Epic 4: Procurement and Supplier Management

**Goal:** Procurement officers manage the full source-to-pay cycle: supplier registry through requisition, PO issuance, goods receipt with QC trigger, and three-way invoice matching. Floor supervisors raise indents from a phone in under 90 seconds and always see live status with push-notification decisions — never chase, never raise it twice (UJ-IND-01). MSME payment discipline is enforced at every PO; zero s.43B(h) carry-over at year-end.

**FRs covered:** FR-P-01, FR-P-02, FR-P-03, FR-P-04, FR-P-05, FR-P-06, FR-P-07, FR-P-09. FR-P-08 (spend analytics): Epic 4 emits the underlying PO, receipt, and invoice events; the reporting surface is delivered by Story 12.3.

**Depends on:** Epics 1, 2, 3. Story 4.2's quality-acceptance metric additionally consumes Epic 8 QC disposition events — Epic 8 is in the pilot slice and builds before Epic 4; the metric shows "no data" until disposition events exist.

**Note:** Tender management (FR-T-01..07) is Phase 2 / Epic 14. Open purchase orders inbound from ERP are available as read-only reference projections from Story 2.9; Story 3.4 (Epic 3) receives against those projections until Story 4.4's native POs go live — this resolves the Epic 3 ↔ Epic 4 PO sequencing.

---

### Epic 5: BOM and Engineering Change Management

**Goal:** Engineering teams manage the full lifecycle of production and R&D BOMs with enforced immutability for released revisions and an ECO-only change path. R&D draft BOMs iterate freely but cannot execute in production without a signed productization gate. The platform becomes the system of record for BOM structure; ERP receives outbound-only sync and conflicts create BOM Administrator exceptions, never overwrites (AD-4).

**FRs covered:** FR-B-01, FR-B-02, FR-B-03, FR-B-04, FR-B-05, FR-B-06, FR-B-07, FR-B-09, FR-B-10, FR-B-11, FR-B-12, FR-B-13, FR-B-14, FR-B-15, FR-B-16, FR-B-17

**Note:** FR-B-08 (consumption variance at order closure) is delivered by Epic 6 (Story 6.4), which generates the variance report and the scrap-percent recalibration signal consumed by this epic's BOM read models. Deferred to Phase 2 (Epic 16): the FR-B-08 handoff of variance data to the FR-SC expected-vs-actual scrap reconciliation (FR-SC-05).

**Depends on:** Epics 1, 2

**Hard prerequisite:** Item master governance (FR-I + INT-ERP-01) must be stable before BOM release gate (FR-B-06) goes live (A-11).

**Migration prep:** Active BOMs must be migrated and department-verified before pilot go-live (FR-DM-02).

---

### Epic 6: Production Orders and Manufacturing WIP

**Goal:** Production supervisors and operators release, execute, and close production orders against verified material availability and Released BOMs. Every finished lot carries a full as-consumed lot genealogy. Production WIP is a real-time auditable ledger, distinct from R&D project WIP (AD-5). Over-completion, short completion, rework, and process scrap are enforced approval workflows, not workarounds. Plant execution continues offline and replays cleanly on reconnection.

**FRs covered:** FR-MO-01, FR-MO-02, FR-MO-03, FR-MO-04, FR-MO-05, FR-MO-06, FR-MO-07, FR-MO-08, FR-MO-09, FR-MO-10, FR-MO-11, FR-MO-12, FR-MO-13, FR-B-08

**Depends on:** Epics 1, 2, 3, 5, 8

**Hard prerequisite:** Epic 8's QC disposition recording (FR-Q-05) must be live before the Epic 6 closure gate (FR-MO-12) activates — Epic 8 builds before Epic 6, consistent with the pilot go-live slice. Completions post into QC Hold as a stock state Epic 6 owns; dispositions against those lots are recorded by Epic 8, and Epic 6's closure gate reads Epic 8's disposition-status projection.

---

### Epic 7: Maintenance, Calibration, and Asset Register

**Goal:** Maintenance technicians and supervisors have one asset register company-wide for everything from a two-tonne mould to a hub screwdriver. PM plans auto-generate work orders on calendar and meter-based schedules. Anyone can report a fault by scanning an asset tag; the message reaches the location's maintenance supervisor within 5 minutes. The calibration register and its non-overridable lockout (FR-M-13) mean QC can trust every instrument result — no role can bypass the lockout; escalation expedites calibration, never bypasses it (AD-8). Technician workflows are fully offline.

**FRs covered:** FR-M-01, FR-M-02, FR-M-03, FR-M-04, FR-M-05, FR-M-06, FR-M-07, FR-M-08, FR-M-09, FR-M-10, FR-M-11, FR-M-12, FR-M-13, FR-M-14, FR-M-15, FR-M-16, FR-M-17, FR-M-18

**Depends on:** Epics 1, 2, 3 (backward: the Story 7.6 re-stamping block executes inside the Epic 3 FR-W trade-weighment flow; build order unaffected)

**Hard prerequisite for Epic 8:** FR-M instrument records must be loaded before the FR-Q-04 calibration lockout goes live (C-12).

---

### Epic 8: Quality Control and Batch Release

**Goal:** QC inspectors and heads can disposition every finished goods lot before it reaches sellable stock — no bypass, urgency uses conditional release. AQL sampling, calibration-locked result capture, CoA/CoC generation, NCR outcomes (rework, downgrade, scrap), CAPA linkage, BIS and Legal Metrology hooks, and customer-witnessed inspections are all enforced workflows. Quality holds propagate everywhere within 15 minutes; where-used and where-shipped trace is immediate. Zero dispatch lines without a batch release record (SM-28).

**FRs covered:** FR-Q-01, FR-Q-02, FR-Q-03, FR-Q-04, FR-Q-05, FR-Q-06, FR-Q-07, FR-Q-08, FR-Q-09, FR-Q-10, FR-Q-11, FR-Q-12, FR-Q-13, FR-Q-14, FR-Q-15

**Depends on:** Epics 1, 2, 3, 7 — Epic 3 supplies the dispatch documents and `LOT_ON_HOLD` dispatch gate (Story 3.7) behind the where-shipped trace (FR-Q-09)

**Hard prerequisite:** Epic 7 instrument records loaded before Epic 8 calibration lockout activates (C-12). BIS licence data loaded into the Story 8.7 licence register before the Story 8.6 FR-Q-11 release block goes live (A-13).

**Sequencing note:** Epic 6 depends on this epic: production completions and rework orders (Story 6.3) subscribe to this epic's completion-event and rework-requested contracts when Epic 6 lands. At pilot, completions enter the QC gate from finished job-work output (Story 9.4).

---

### Epic 9: Job-Work Services

**Goal:** Operations teams receive customer-owned material through the gate and receiving flows, execute job-work orders against customer-supplied kit BOMs, maintain a per-customer per-order custody ledger, dispatch output only after QC release, and collect a measured billing feed to ERP. Statutory return clocks (one-year and three-year) run visibly from the challan date with escalation — no challan expires silently. Customer custody statements print on demand. No job-work order closes with a non-zero custody ledger (AD-6). 100% of job-work returns within statutory windows (SM-34).

**FRs covered:** FR-JW-01, FR-JW-02, FR-JW-03, FR-JW-04, FR-JW-05, FR-JW-06, FR-JW-07, FR-JW-08, FR-JW-09, FR-JW-10, FR-JW-11, FR-JW-12, FR-JW-13, FR-JW-14, FR-JW-15, FR-AC-11

**Depends on:** Epics 1, 2, 3, 5, 8

---

### Epic 10: R&D and Maker-Hub Operations

**Goal:** R&D project managers issue materials against project codes under committed-plus-actual budget control, with three semantically distinct issue types (consumable, project WIP, custody loan). Prototype builds carry full material history including failed and abandoned builds. Hub operators run offline point-of-use sales with UPI/card capture. Every rupee of R&D spend has an audit trail that feeds Form 3CL without year-end archaeology. Research vs. development classification follows the six Ind AS 38 criteria from the first transaction; no retroactive reinstatement.

**FRs covered:** FR-RD-01, FR-RD-02, FR-RD-03, FR-RD-04, FR-RD-05, FR-RD-06, FR-RD-07, FR-RD-08, FR-RD-09, FR-RD-10, FR-RD-11, FR-RD-12, FR-RD-13, FR-RD-14, FR-RD-15, FR-RD-16, FR-RD-17, FR-RD-18, FR-RD-19, FR-RD-20, FR-AC-02, FR-AC-03, FR-AC-04, FR-AC-12, FR-AC-16

**Depends on:** Epics 1, 2, 4, 7 (retain-as-asset prototype dispositions create Epic 7 asset-register entries; machine meter readings feed the FR-M-03 usage-meter register)

---

### Epic 11: Financial Compliance and Period Close

**Goal:** Finance teams close periods with a signed-off subledger-to-GL reconciliation. The ITC register is current per GSTIN with auto-computed ITC reversals on write-offs. Every e-invoiceable dispatch is blocked until an IRN and signed QR are received from the IRP flow. Branch transfers between GSTINs trigger Rule 28 valuation and the correct GST documents before dispatch. ERP-synced budget heads show remaining availability inline at every approval; commitments reduce availability until ERP actuals sync. Phase 2 modules (scrap, imports, fixed assets) extend this module's ITC register and reconciliation via new event subscribers — no Epic 11 stories require change for Phase 2 additions.

**FRs covered:** FR-AC-07, FR-AC-08, FR-AC-10, FR-AC-14, FR-AC-15, FR-BC-01, FR-BC-02

**Depends on:** Epics 1, 2, 3, 9, 10

---

### Epic 12: Cross-Module Reporting and Executive Analytics

**Goal:** Executives drill from the Phase-1 KPI set (inventory turns, procurement spend, stockout count, and an approximated fill rate) to the underlying transactions in a single pane; forecast accuracy joins the KPI strip when Epic 15 demand planning delivers in Phase 2. All roles have role-specific operational dashboards and exception alerts that surface what needs attention without navigation. Self-service ad-hoc reporting with Excel/PDF/CSV export and scheduled distribution eliminates the report-request queue.

**FRs covered:** FR-R-01, FR-R-02, FR-R-03, FR-R-04, FR-R-06, FR-R-07, FR-R-08. FR-R-05 (fulfillment report suite: order status, backorders, fill rate by location) moves to Epic 15 (Phase 2) alongside the order-management data it reports on.

**Depends on:** Epics 1-11. The fill-rate approximation (Story 12.2) and the demand-planner dashboard (Story 12.1) additionally consume Story 2.9 (ERP Inbound Reference Projections) for sales-order demand and open-PO reference data.

**Scope boundary:** Operational domain status views (requisition status, current stock by location, open work orders, open indents, job-work challan aging) are stories within their respective module epics (Epics 2-11). Epic 12 delivers the cross-module executive layer: multi-domain KPI dashboards, unified drill-through, and self-service ad-hoc reporting across all modules.

---

### Epic 13: Data Migration Sign-Off Gate

**Goal:** The system goes live with zero unexplained opening-balance variances (SM-48). Department heads and finance sign off that physically verified stock balances, open POs, active BOMs, job-work challans, and custody registers in the new system match ERP and legacy records line for line. This sign-off is the mandatory go-live gate. Open gate-pass migration defers to Epic 20 and asset-register migration to Epic 17 — each migrates in the wave in which its owning epic deploys; open sales orders are not migrated, they enter as Story 2.9 read-only ERP projections.

**FRs covered:** FR-DM-01, FR-DM-02, FR-DM-03

**Depends on:** Phased sign-off. Pilot go-live requires sign-off from the pilot-slice epics only (Epics 1, 2, 3, 5, 7, 8, 9 + Story 11.2), scoped to the pilot site's domains: opening stock, active BOMs, open POs (as ERP reference projections via Story 2.9), job-work challans, and custody and loan registers. Full Phase-1 go-live requires all Epics 1-12 (production-ready system). Migration and verification of sales orders, the asset register with depreciation, and open gate passes are Phase 2 scope (Epics 15, 17, 20 — see their migration scope notes).

**Critical note:** Migration *execution* (data extraction, staging loads, dry-run cycles, reconciliation) runs concurrent with Epics 2-12, not sequentially after them. Module epics each note the migration prep they need. Epic 13 is the *sign-off event*, not the start of migration work. Teams who treat Epic 13 as "migrate then sign off" will produce a six-week fire drill at go-live.

---

## Phase 2 Epics (planned, stories not yet created)

### Epic 14: Tender Management

**Goal:** Procurement officers run formal competitive tender processes end-to-end: authoring RFQ/RFP/RFI with templates, supplier invitation, secure sealed bid portal, clarification Q&A, controlled weighted-score opening, award approval with notification, and contract generation linked to POs.

**FRs covered:** FR-T-01, FR-T-02, FR-T-03, FR-T-04, FR-T-05, FR-T-06, FR-T-07

**Depends on:** Epic 4

---

### Epic 15: Order Management, Demand Planning, and Logistics

**Goal:** Operations managers capture orders from every channel (manual, EDI, e-commerce, internal, inter-branch), validate them for completeness, credit, and availability, route them by configurable rules, and manage split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, and drop shipping. Demand planners analyze history at SKU-location grain, run statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, and NPI forecasting by analogy, plan replenishment (with BOM explosion for dependent demand per FR-B-07), and optimize and redistribute inventory across locations. Logistics teams manage the carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, shipment tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, and returns logistics. The fulfillment report suite (FR-R-05) lands here with the order data it reports on.

**FRs covered:** FR-O-01..08, FR-D-01..08, FR-L-01..08, FR-R-05 (fulfillment report suite, moved from Epic 12)

**Depends on:** Epics 2, 5

**Migration scope note (deferred from Epic 13 per FR-DM-01):** Open sales orders with source references are migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes them; sign-off on migrated sales orders is a go-live gate for this epic.

---

### Epic 16: Scrap, Defectives, and Disposal

**Goal:** Every scrap receipt is source-linked, classified once at intake (classification determines bins, routes, and statutory channel; reclassification is audit-logged), stored in segregated class bins that block cross-class putaway, weighed with photo evidence, and reconciled against BOM scrap percents. Defectives run a disposition workflow (repair, refurbish-downgrade, cannibalize, condemn) with committee escalation and cannibalized component recovery; IP-sensitive lots require evidenced defacement before any sale; every lot carries NRV fields with rate source and valuer. Disposal approvals resolve through the DOA registry with proposer, approver, and custodian as three different users. Buyers are registered (GSTIN, PAN, SPCB/CPCB credentials for regulated categories) with blacklisting; lots carry sealed reserve prices; auctions run tender mechanics in reverse with below-reserve and single-bid outcomes escalating to committee. The EMD lifecycle, payment-before-lifting, and slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment govern physical removal. Sale documents carry GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers, with scrap-sale tax events maintained as dated configuration, not code (FR-AC-09). Hazardous waste goes to authorized recyclers/TSDFs with Form 10 manifests and the non-disableable 90-day storage timer; e-waste, battery, and non-ferrous EPR channels block awards to unregistered buyers; plastic packaging EPR data is compiled by category, GSTIN, and financial year for CPCB portal returns. Write-off and destruction require witness and evidence and auto-trigger ITC reversal evaluation and FA derecognition. A generated-vs-weighed-vs-disposed reconciliation runs per class per location with internal-audit read-only access.

**FRs covered:** FR-SC-01..22, FR-AC-09

**Depends on:** Epics 1, 2, 11

---

### Epic 17: Fixed Assets, Intangibles, and Depreciation

**Goal:** Finance teams manage the operational asset subledger: capitalization from procurement through CWIP at Ind AS 16 available-for-use, with CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs with preview-and-approve posted to ERP; and dual views — Companies Act books plus a report-only income-tax block-of-assets WDV view. Effective-dated transfers reallocate depreciation, and inter-GSTIN moves trigger FR-AC-10 GST documents before dispatch. Subsequent-expenditure decisions and the repair-vs-capitalize queue from FR-M work orders leave none undecided at period lock. Impairment indicators are captured per Ind AS 36; retirement and disposal route through FR-SC with gain/loss computation; offline physical verification runs by tag scan per CARO 2020; every asset carries an immutable audit trail. The intangibles register sits separate from PPE, with the IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing, capitalization and amortization at available-for-use, annual reviews of period, method, and indefinite-life assessments, impairment extension including annual tests where required, and derecognition with approval-gated IAUD write-offs. The ERP GL stays the book of record.

**FRs covered:** FR-FA-01..20

**Depends on:** Epics 1, 2, 7

**Migration scope note (deferred from Epic 13 per FR-DM-01):** The asset register — cost, accumulated depreciation, and remaining Schedule II life — is migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes it; sign-off on the migrated asset register is a go-live gate for this epic.

---

### Epic 18: Imports and Landed Cost

**Goal:** Import officers raise import-flagged POs carrying dual exchange rates, capture Bill of Entry by duty head, and compute landed cost sheets with selectable allocation bases. Valuation posting keeps recoverable taxes out of item cost: recoverable import IGST goes to the ITC register while BCD/SWS are never creditable. They manage the two-year provisional assessment lifecycle, apply late cost true-ups within configured windows with PPV fallback when a window closes, reconcile with ICEGATE/GSTR-2B, and handle duty-exemption licence hooks (Advance Authorisation, EPCG).

**FRs covered:** FR-IM-01..09

**Depends on:** Epics 1, 2, 4, 11

---

### Epic 19: Tooling and Tool Crib

**Goal:** Tool crib operators issue and return tools by QR scan against a tool master carrying class, where-used through FR-B, and asset and cost cross-references. Custody issues and returns are scan-based with overdue escalation; hub member lending is governed by a block policy; perishable tooling runs as min-max stock. Life counters auto-increment from production confirmations, warning and hard-stop thresholds block issue when a tool exceeds its life, and life history survives regrinds; regrind/repair routing covers IP-sensitive tooling with confidentiality references, regrind limits propose condemnation, and condemned tools exit through the scrap module with evidenced defacement. Gauge calibration lockout applies at issue. A personal PPE issue register tracks renewal cycles, tool availability broadcasts to production planning and hub booking, and crib transactions run fully offline with conflict escalation.

**FRs covered:** FR-TL-01..17

**Depends on:** Epics 1, 2, 5, 7, 16

---

### Epic 20: Gate Passes and Returnable Materials

**Goal:** Every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch requires an RGP or NRGP — distinct documents serially numbered per GSTIN and site — issued with full consignment detail and reason codes and blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request). Rule 55 delivery challans and e-way bill triggers cover non-sale movements above threshold. Return receipts verify serial identity and condition, support line-level partial returns, and route substitutions through approver gating that updates the asset registers. NRGPs issue only for permitted non-returnable reasons with DOA approval. Open-RGP ageing runs 7/15/30-day reminder defaults with site-head escalation; statutory and insurance window clocks per RGP class raise hard alerts to named owners — no clock expires silently. Gate enforcement blocks exit without a matching open pass and raises incidents on mismatch. An off-site asset visibility report by party, location, and value serves insurance and audit. Returnable packaging registers track per-party bidirectional balances and serialized cylinders with deposits, refunds, forfeiture, and revaluation.

**FRs covered:** FR-GP-01..14

**Depends on:** Epics 1, 2, 3

**Migration scope note (deferred from Epic 13 per FR-DM-02):** Open gate passes are migrated, reconciled, and department-verified within this epic. The Phase-1 Epic 13 gate excludes them; sign-off on migrated open gate passes is a go-live gate for this epic.

---

## Epic 1: Platform Foundation, Compliance Spine, and Offline Edge Shell

Every transaction in the system is compliant by construction from day one. The statutory edit log is tamper-proof and auditor-readable. The DOA registry resolves every approval chain at runtime. Business-stream tagging blocks untagged transactions at the write path. SSO gates every user. The event store, sync layer, and offline edge PWA shell are deployed and operational — a gate officer can hold the edge device, open the app with no network, and see "Working offline — syncing when connected." The Spine Acceptance Contract's five tests pass before any module epic begins.

### Story 1.1: Core Infrastructure Deployment and Event Store Schema

As a platform engineer,
I want the core infrastructure (PostgreSQL event store, Node.js API skeleton, Docker containers, self-hosted deployment on a native server or cloud VPS with primary + streaming-replication standby) running with a health endpoint and the versioned event envelope schema in place,
So that every subsequent story has a stable, repeatable deployment target and every event persisted from day one carries the correct envelope fields.

**Acceptance Criteria:**

**Given** the IaC deployment pipeline runs against a clean target host (native server or cloud VPS)
**When** the deployment completes
**Then** `GET /api/v1/health` returns HTTP 200 with `{ "status": "ok", "version": "1" }`
**And** the `domain_events` table exists in PostgreSQL with the full event envelope schema: `event_id` UUID PK, `stream_type`, `stream_id`, `event_type`, `event_version` int (per-stream monotonic), `payload` JSONB, `metadata` JSONB (containing `correlation_id`, `causation_id`, `actor`, `device_id`, `capture_method`, `occurred_at`, `synced_at`), `schema_version` int
**And** all infrastructure (app containers, self-managed PostgreSQL, reverse proxy, WAL archiving/backups) is in version-controlled IaC under `deploy/` — vendor-neutral, targeting a native server or cloud VPS

**Given** a developer submits a test event with all required envelope fields
**When** the event is persisted
**Then** a subsequent stream read returns the event with all fields intact, `metadata.synced_at` populated, and `event_version` monotonically incremented per `stream_id`

**Given** an event submission missing a required envelope field (e.g., no `actor` or no `correlation_id` in `metadata`)
**When** the event store processes the write
**Then** the write is rejected with `error_code: "INVALID_EVENT_ENVELOPE"` and nothing is written to `domain_events`

**Requirements:** AD-1/AD-12 (event envelope, compliance spine substrate), AD-16 (idempotency key infrastructure), NFR-DI-01. The IaC deployment pipeline this story's first AC presupposes is built in Story 1.10, sequenced alongside this story.

---

### Story 1.2: SSO Authentication and Role-Based Access Control

As a system administrator,
I want every API request authenticated via the organization's SSO (SAML 2.0/OIDC) with RBAC enforced to module, function, and location scope,
So that every operation is attributable to a specific user with a specific role at a specific location, and unauthorized access is structurally blocked.

**Acceptance Criteria:**

**Given** a request with no valid SSO session token
**When** any API endpoint is called
**Then** the API returns HTTP 401 with `error_code: "UNAUTHORIZED"`

**Given** a valid SSO session for a user scoped to `location_id: "site-A"`
**When** the user calls a write endpoint for `location_id: "site-B"`
**Then** the API returns HTTP 403 with `error_code: "LOCATION_ACCESS_DENIED"`

**Given** a valid SSO session for a user whose roles grant no access to a module (e.g., maintenance)
**When** the user calls any endpoint of that module
**Then** the API returns HTTP 403 with `error_code: "MODULE_ACCESS_DENIED"`

**Given** a valid SSO session for a user whose role grants read-only function scope on a module
**When** the user calls a mutating (write) endpoint of that module
**Then** the API returns HTTP 403 with `error_code: "FUNCTION_ACCESS_DENIED"`

**Given** a SCIM provisioning event (INT-IAM-02) creates a new user with assigned roles
**When** that user logs in via SSO for the first time
**Then** their account exists with provisioned roles and location scopes with no manual admin step required

**Given** a user is deprovisioned via SCIM
**When** they attempt to use an existing session
**Then** the session is invalidated within 30 seconds of the SCIM event

**Requirements:** NFR-SEC-01 (SSO SAML 2.0/OIDC), NFR-SEC-02 (RBAC to module, function, and location scope), INT-IAM-01/02 (SSO/SCIM)

---

### Story 1.3: Statutory Edit Log

As a statutory auditor,
I want every mutating API operation recorded in a tamper-proof, non-disableable edit log with user, role, location, timestamp, and trace_id,
So that I can produce a complete audit trail for any transaction without requesting extracts, satisfying the Companies (Accounts) Rules 2014 audit-trail proviso.

**Acceptance Criteria:**

**Given** an authenticated user submits any mutating API request (POST, PUT, PATCH, DELETE)
**When** the request is processed
**Then** an entry appears in the edit log containing `trace_id`, `user_id`, `role`, `location_id`, `timestamp` UTC, `endpoint`, `method`, and the resulting `event_id`; the entry is written atomically with the event

**Given** any role (including system administrator) attempts to delete or modify an existing edit log entry via any API route or direct DB connection
**When** the operation is attempted
**Then** the operation is rejected and the rejection attempt is itself logged with `error_code: "AUDIT_LOG_TAMPER_ATTEMPT"`

**Given** an auditor calls `GET /api/v1/audit/log` with a date range and optional user filter
**When** the response is returned
**Then** entries appear in append order with no sequence gaps and include a range digest for integrity verification

**Given** a configuration flag attempts to disable the edit log
**When** any subsequent mutating request is made
**Then** the request is blocked with `error_code: "AUDIT_LOG_DISABLED"` — no mutating operation proceeds without the log active

**Given** edit-log entries from prior financial years
**When** retention is evaluated or an early purge is attempted
**Then** every entry remains retrievable for at least 8 financial years per books-retention (FR-AC-13) — online, or restored from the permanent S3 Glacier archive to queryable within 48 hours (NFR-S-05) — and no deletion path exists inside the retention window; any early-deletion attempt is rejected and logged with `error_code: "AUDIT_LOG_TAMPER_ATTEMPT"`

**Dev notes:**
- **Tamper enforcement mechanism (AC2):** the edit log is append-only by construction — `UPDATE`/`DELETE` grants revoked from every database role including the application role, with DB triggers that reject modifications and write the `AUDIT_LOG_TAMPER_ATTEMPT` entry through an autonomous path. Test procedure for the direct-connection case: execute `UPDATE`/`DELETE` against the edit log as the highest-privilege operational role and assert rejection plus the logged attempt; production superuser access is itself restricted via IAM.
- **Retention (FR-AC-13):** books-retention = 8 financial years (platform retention policy: event store online in PostgreSQL + permanent S3 Glacier archive; archived ranges restorable to queryable within 48 hours).

---

### Story 1.4: Enterprise DOA Registry

As a system administrator,
I want to configure an enterprise delegation-of-authority registry (roles, transaction types, value bands, vacation delegations) that every approval workflow resolves from at runtime,
So that approval routing is always current without any workflow code change, and no approval path can be hard-coded.

**Acceptance Criteria:**

**Given** a DOA entry: role `procurement_head`, transaction type `po_approval`, value band `> 500000`
**When** a synthetic resolution request `POST /api/v1/doa/resolve` with `{ "transaction_type": "po_approval", "value": 600000 }` is submitted (registry configuration data only — no PO entity or module code required; Epic 4 approval workflows consume this same endpoint for real POs)
**Then** the registry resolves the approver as the current holder of `procurement_head` and returns the resolution referencing the matched registry entry
**And** the "no hard-coded role name in workflow code" invariant is verified as an observable pass/fail by a CI static check (lint rule rejecting role-name literals in workflow code), executed as part of the Story 1.9 spine contract run

**Given** a vacation delegation from User A to User B for dates 2026-08-01 to 2026-08-10
**When** a synthetic resolution request that resolves to the role held by User A is submitted on 2026-08-05
**Then** the resolution returns User B; the delegation and its active dates are recorded in the event log

**Given** a DOA registry entry is updated by the System Administrator
**When** the next resolution request is submitted after the update
**Then** it uses the new entry immediately with no system restart required
**And** every DOA registry change is logged in the edit log with the administrator's identity

**Given** a workflow configuration entry that attempts to specify its own approver mapping for a transaction type governed by the DOA registry
**When** the configuration is saved or a resolution request for that transaction type is processed
**Then** the write is rejected with `error_code: "DOA_OVERRIDE_BLOCKED"` — workflow configuration consumes the registry's resolution and can never override it (FR-DOA-01)

---

### Story 1.5: Business-Stream Tagging Enforcement

As a financial controller,
I want every inventory movement event to carry a mandatory `business_stream` tag — plus `cost_centre` and `project_code` where applicable (FR-AC-01) — enforced at the write path,
So that no untagged transaction can enter the ledger and reporting by stream (production, R&D, maker-hub, job-work) is accurate by construction from the first transaction.

**Acceptance Criteria:**

**Given** a write request for an inventory movement event with no `business_stream` field
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`

**Given** a write request with `business_stream: "production"` (a valid value)
**When** the event is persisted
**Then** the event payload carries the `business_stream` value and an event-store stream read (the Story 1.1 read path) returns it with the tag intact — module read-model projections consume the tag from Epic 2 onward

**Given** a write request with `business_stream: "unknown_stream"` (unrecognized value)
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "INVALID_BUSINESS_STREAM"` and no event is appended to `domain_events`

**Given** a transaction type configured as cost-centre-applicable (applicability is dated configuration, not code)
**When** an inventory movement event of that type is submitted with no `cost_centre` field
**Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`
**And** the same rule enforces `project_code` for project-applicable transaction types (R&D project-code enforcement is exercised end-to-end in Story 10.1)

---

### Story 1.6: Event-Sourced Location with Asserted/Expected Separation

As a warehouse manager,
I want the system to store where an operator says stock is (asserted) separately from where it should be based on plans (expected), raising a visible exception on discrepancy rather than silently overwriting,
So that location data is trustworthy, every discrepancy is auditable, and stock can never disappear through a silent location merge.

**Acceptance Criteria:**

**Given** a putaway event arrives with `asserted_location: "BIN-A43"` for a lot whose expected location `BIN-A47` was recorded by a prior expected-location event (in production sourced from ASN/putaway plans arriving with Epic 3; seeded synthetically as an opaque test event for spine testing — lot IDs are opaque identifiers until Epic 2 defines the lot master)
**When** the event is processed
**Then** a `location.disputed` event is raised referencing both asserted and expected facts with actor provenance
**And** the asserted location becomes the current location projection
**And** the expected location fact is preserved — neither is deleted nor overwritten

**Given** two devices submit stock movement events with the same `idempotency_key` within 10 seconds
**When** the central event store processes the second submission
**Then** HTTP 409 is returned with the existing `event_id`; the location is updated exactly once (AD-16)

**Given** no location event has been received for a lot
**When** the lot's current location is queried
**Then** the response returns `{ "location": null, "confidence": "none" }` — no default location is invented

**Requirements:** INT-LOC-01, AD-15 (asserted/expected separation), AD-16 (idempotent movement events)

---

### Story 1.7: Calibration Lockout Enforcement

As a QC inspector,
I want the system to automatically reject any QC result submitted against an out-of-calibration instrument with no role able to override this enforcement,
So that every persisted QC result was captured on a verified instrument and the integrity of the quality record is structurally guaranteed.

**Acceptance Criteria:**

**Given** the minimal instrument-status registry delivered by this story holds instrument `INS-0042` with calibration status `out_of_calibration` (status set via the admin endpoint `PUT /api/v1/instruments/{id}/calibration-status`)
**When** a QC result event referencing `instrument_id: "INS-0042"` is submitted by any user (via the synthetic spine-test QC-result command — production QC result capture arrives in Epic 8 and passes through this same enforcement point)
**Then** the write is rejected with `error_code: "CALIBRATION_LOCKOUT"` and no result is persisted

**Given** the submitting user holds role `qc_head` (the highest QC authority)
**When** the same write is attempted
**Then** it is still rejected with `CALIBRATION_LOCKOUT` — no role attribute can override the lockout

**Given** instrument `INS-0042` is updated to `calibrated` status via the admin status endpoint
**When** a QC result referencing that instrument is submitted
**Then** the write succeeds and the result is persisted normally

**Given** a calibration escalation request is submitted for an out-of-calibration instrument
**When** the escalation is processed
**Then** it routes to the calibration scheduler via the DOA registry — expediting calibration, not bypassing the lockout

**Dev notes:**
- **In-scope scaffolding:** a minimal instrument-status registry (instrument ID, calibration status, status-change events, admin status-update endpoint) and a synthetic QC-result spine-test command — the smallest capability that makes the lockout invariant testable with zero module code present (Story 1.9, spine test 4).
- **FR-M-13 ownership split:** Epic 1 owns the non-overridable lockout enforcement invariant; Epic 7 owns the full asset register and calibration register (FR-M-12) with certificates and alerts, which replaces the admin endpoint as the production status source. The C-12 migration sequencing (FR-M instrument records loaded before the FR-Q-04 lockout goes live at a site) governs site go-live activation, not spine acceptance — spine acceptance runs against this story's synthetic registry entries.

**Requirements:** FR-M-13 (enforcement invariant), FR-Q-04 (enforced at this write path; QC result capture is Epic 8), AD-8

---

### Story 1.8: Offline Edge PWA Shell and PowerSync Sync Layer

As a gate officer,
I want to open the edge application on a rugged device with no network and immediately confirm the app is ready to capture transactions,
So that I begin my shift knowing every capture is stored locally and synced automatically when the network returns, with no data loss regardless of connectivity.

**Acceptance Criteria:**

**Given** a rugged device with the edge PWA installed and no network connectivity
**When** the gate officer opens the application
**Then** the app loads in under 5 seconds, shows the officer's cached site name and user name, and displays "Working offline — syncing when connected"

**Given** the device is offline and the officer submits a test capture event
**When** the event is written to the local write path
**Then** the event is stored in local SQLite with status `pending_sync` immediately and the screen shows "Captured — pending sync"

**Given** the device reconnects to the network
**When** PowerSync processes the upload queue
**Then** all `pending_sync` events reach the central `domain_events` table within 30 seconds and the pending indicator clears

**Given** a `pending_sync` event is resubmitted on the next sync cycle (idempotency test)
**When** the central event store receives the duplicate submission
**Then** HTTP 409 is returned; no duplicate event is created; the balance is updated exactly once (AD-16)

**Given** a queued `pending_sync` event that the central store permanently rejects on sync (envelope or tagging validation failure, e.g. `INVALID_EVENT_ENVELOPE` or `UNTAGGED_TRANSACTION`)
**When** PowerSync processes the upload queue
**Then** the event moves to a visible "sync failed — needs attention" state on the device showing the server `error_code`, it leaves the pending count, and the remaining queue items continue syncing — no silently stuck queue

**Given** any screen of the PWA shell
**When** it is checked by the automated accessibility audit in CI plus manual keyboard-only and screen-reader passes
**Then** the shell meets WCAG 2.1 AA (NFR-U-02): full keyboard operability, visible focus indicators, minimum 4.5:1 text contrast, glove-friendly touch-target sizing, and connectivity/status indicators (e.g., "Working offline — syncing when connected") exposed to assistive technology as live regions; the automated accessibility check is a required status check for shell changes

**Given** the shell's i18n foundation (NFR-U-03)
**When** any user-facing string or server `error_code` is rendered
**Then** it resolves through the locale message catalog — no hard-coded user-facing literals in components, `error_code` values map to localized messages, and adding a locale requires only a new message catalog with no component change

**Requirements:** NFR-P-04 Tier 1 (24x7 offline-first edge capture with visible degraded state), NFR-U-01/02/03/04/05, AD-16. The accessibility and i18n standards established here bind every later module UI story.

---

### Story 1.9: Spine Acceptance Contract CI Gate

As a development team lead,
I want all five Spine Acceptance Contract tests to pass in CI against a deployed spine with no modules loaded,
So that the compliance spine is formally accepted as the build substrate and any future regression in the five invariants fails the pipeline before a module sprint can begin.

**Acceptance Criteria:**

**Given** a fresh deployment of the compliance spine with zero module code present
**When** the Spine Acceptance Contract test suite runs in CI
**Then** all five tests pass and results are published as a CI artifact:
1. **Edit Log Integrity** (FR-AC-13): every submitted event appears in the log; log is append-only; auditor-readable format verified; disable attempt is blocked
2. **DOA Registry Resolution** (FR-DOA-01): approval workflows resolve approvers from the registry; no hard-coded role path survives the check
3. **Event-Sourced Location** (INT-LOC-01): asserted and expected stored separately; discrepancy raises `location.disputed`; last-writer-wins does not occur
4. **Calibration Lockout** (FR-M-13): QC result against out-of-calibration instrument is rejected; `qc_head` role cannot override the rejection
5. **Business-Stream Tagging** (FR-AC-01): inventory movement without `business_stream` is rejected with `UNTAGGED_TRANSACTION`

**And** while any spine contract test is failing, every merge into a module code path is blocked by the required status check `spine-acceptance-contract` (branch protection configured in Story 1.10) — the CI assertion is the testable gate

**Dev note:** "no module epic story enters the sprint backlog while a spine contract test is red" is the team working agreement this gate operationalizes; sprint planning enforces the backlog half, the required status check enforces the merge half. The CI pipeline and branch protection rule themselves are built in Story 1.10.

---

### Story 1.10: CI/CD Pipeline Construction

As a platform engineer,
I want an automated CI/CD pipeline (build, test, deploy) with branch protection and a version-controlled IaC bootstrap for the pipeline itself,
So that the deployment path Stories 1.1 and 1.9 presuppose exists as repeatable automation and no change reaches any environment except through the pipeline.

**Sequencing:** first work executed in Epic 1, alongside Story 1.1 — Story 1.1's "the IaC deployment pipeline runs" and Story 1.9's CI gate and branch protection presuppose this story's output.

**Acceptance Criteria:**

**Given** a commit pushed to any branch
**When** the CI pipeline runs
**Then** it builds the application, runs the automated test suites (unit, integration, and — once Story 1.9 lands — the Spine Acceptance Contract suite), and publishes the results as required status checks

**Given** a pull request into the main branch with any required status check failing
**When** a merge is attempted
**Then** the merge is blocked by branch protection with no administrator bypass, until the check passes

**Given** a merge into the main branch
**When** the CD stage runs
**Then** the build deploys to the staging environment through the IaC under `deploy/` with zero manual steps, and promotion to production requires an explicit approval recorded with the approver's identity

**Given** a clean target host (native server or cloud VPS) and the pipeline bootstrap IaC
**When** the bootstrap is executed
**Then** the pipeline itself (CI runners, artifact store, deployment credentials) is provisioned entirely from version-controlled IaC — reproducible, never hand-built

**Requirements:** Additional Requirements (greenfield IaC, vendor-neutral native-server/VPS deployment, `deploy/`), NFR-E-04 (upgrades under 30 minutes); consumed by Stories 1.1 and 1.9

---

### Story 1.11: Notification and Alerting Foundation

As a platform engineer,
I want a shared notification and alerting service — in-app, web push, and escalating alerts with acknowledgment tracking — that every module consumes instead of inventing its own,
So that requisition decisions, fault reports, statutory window clocks, and gate-pass ageing all alert through one auditable channel and nothing expires or fails silently.

**Acceptance Criteria:**

**Given** a module emits a notification event targeting a role at a location
**When** the notification service processes it
**Then** it is delivered in-app and via web push to every user holding that role at that location, and each delivery (or delivery failure) is recorded with `trace_id`

**Given** an escalating alert definition (initial target, acknowledgment window, escalation target)
**When** the acknowledgment window elapses unacknowledged
**Then** the alert escalates to the escalation target — resolved via the DOA registry where the target is a role (AD-3) — and every hop is recorded; no alert expires silently

**Given** a target user's device is offline
**When** a notification is dispatched
**Then** it is queued and delivered on reconnection, and the in-app notification centre shows it with its original timestamp

**Given** the notification service is unavailable
**When** a module emits a notification event
**Then** the event is durably queued (never dropped) and delivered on recovery, and emission never blocks the emitting module's own write path

**Consumers:** FR-P-04 requisition push-notification decisions (UJ-IND-01, Story 4.3); FR-M-04 fault reports reaching the location's maintenance supervisor within 5 minutes (Epic 7); FR-JW-14 job-work statutory-window alerts with escalation (Epic 9); FR-GP-09/10 open-RGP ageing reminders and statutory/insurance window hard alerts (Phase 2, Epic 20); Epic 12 configurable exception alerts (FR-R). These epics consume this service — none builds its own notification channel.

---

## Epic 2: Core Inventory and Multi-Location Stock Visibility

Stock controllers and managers can answer "what do we hold, where is it, and what is it worth" in real time across all locations. Lot and serial traceability enables FEFO/FIFO picking, expiry management, and recall readiness. Consignment and VMI stock is segregated from owned inventory. Valuation is Ind AS 2 compliant (FIFO, weighted average, specific identification; LIFO structurally blocked).

**Scope note (FR-I-09):** Kit definitions are superseded by FR-B-02 — existing kits migrate as single-level production BOMs at go-live (Epic 5). Kit assembly transactions execute as production orders against Released BOMs (Epic 6, Stories 6.1-6.3), which must name kit-assembly orders explicitly. Kit disassembly transactions are delivered by no Phase-1 story — Deferred to Phase 2 (Epic 16): a disassembly posting that consumes one assembled kit unit and returns component lots to stock at Ind AS 2 cost with recovered-component condition codes. No Epic 2 story implements kit transactions; this note is the FR-I-09 coverage record.

### Story 2.1: Item Master and Location Register

As an inventory controller,
I want to create and manage item master records (SKU, UoM, lot/serial control flag, hazmat and quarantine attributes, BIS licence flag) and location records (sites, zones, aisles, racks, bins with their attributes),
So that every subsequent transaction references validated items and locations and no stock movement posts against an undefined master.

**FRs:** FR-I-01 (item and location masters); location attributes feed FR-W-01 warehouse topology (Epic 3)

**Acceptance Criteria:**

**Given** an inventory controller creates an item with `sku: "RM-0042"`, `lot_controlled: true`, `valuation_method: "weighted_average"`, `business_stream: "production"`
**When** the item is saved
**Then** `GET /api/v1/items/RM-0042` returns the item with all fields and a `created_at` timestamp

**Given** a write request attempts to create a stock movement referencing `sku: "NONEXISTENT"`
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "ITEM_NOT_FOUND"`

**Given** a location is created with `zone_type: "hazmat"` and `temperature_class: "cold"`
**When** any stock movement event attempts to place a non-hazmat item into that location
**Then** the movement response carries `warning_code: "ZONE_INCOMPATIBLE"` before the placement is confirmed, and the location's zone and temperature attributes are returned by `GET /api/v1/locations/{location_id}` — the attribute source consumed by directed putaway when Epic 3 (Story 3.5) delivers putaway tasks

---

### Story 2.2: Real-Time Multi-Location Stock Balances

As a stock controller,
I want to query on-hand, allocated, available, and in-transit stock balances per SKU per location — and a consolidated view across all locations — with results in under 1 second,
So that I can answer "what do we hold and where" without a phone call, at any moment.

**FRs:** FR-I-01

**Acceptance Criteria:**

**Given** stock movement events have been posted for `sku: "RM-0042"` across three locations
**When** `GET /api/v1/stock/RM-0042` is called
**Then** the response returns per-location balances (`on_hand`, `allocated`, `available`, `in_transit`) and a consolidated total, in under 1 second (NFR-P-01)

**Given** a stock allocation event reduces available balance
**When** the balance is queried immediately after
**Then** the available balance reflects the allocation and on-hand remains unchanged — double allocation is blocked (NFR-DI-01)

**Given** two concurrent writes attempt to allocate the last unit of a lot to two different orders
**When** both events are processed
**Then** exactly one allocation succeeds; the second returns `error_code: "INSUFFICIENT_STOCK"`

**Given** goods-receipt workflows do not yet exist (GRNs arrive with Epic 3 Story 3.4 and Epic 4 Story 4.5)
**When** an owned-stock receipt event referencing an open-PO line from the ERP inbound projection (Story 2.9) is posted directly via the stock-event API with `quantity`, `unit_cost`, `lot_id`, and location
**Then** on-hand at the target location increases by the received quantity, the PO line reference is recorded on the event, and the balances above are reproducible from directly posted receipt events — Epic 2 stories are testable without Epics 3-4

---

### Story 2.3: Lot, Batch, and Serial Traceability

As a quality manager,
I want every lot, batch, and serialized item tracked end-to-end through all stock movements with FEFO/FIFO enforced on issue and expiry dates visible,
So that a recall can be traced to all affected locations within 15 minutes and expired stock is never issued without an explicit override.

**FRs:** FR-I-04

**Acceptance Criteria:**

**Given** lot `LOT-2026-001` with `expiry_date: 2026-09-30` and lot `LOT-2026-002` with `expiry_date: 2026-12-31` are both in stock
**When** an issue transaction for `RM-0042` using FEFO is raised
**Then** the system selects `LOT-2026-001` before `LOT-2026-002`, and the `lot_id` is carried in the issue event

**Given** a lot with `expiry_date` in the past is in stock
**When** an issue transaction for that lot is submitted without an override flag
**Then** the write is rejected with `error_code: "LOT_EXPIRED"` and the expiry date is returned to the caller

**Given** a quality hold is placed on `LOT-2026-001`
**When** an issue or allocation referencing that lot is attempted
**Then** the write is rejected with `error_code: "LOT_ON_HOLD"` and the hold reason is returned

**Given** a recall event is triggered for `LOT-2026-001`
**When** `GET /api/v1/lots/LOT-2026-001/trace` is called
**Then** the response lists every location the lot has been in, every transaction it appeared in, and its current balance per location — returned within the API p95 threshold of 500ms (NFR-P-05)

**Given** item `EQ-0500` is serial-controlled per its item master flag
**When** an issue transaction for `EQ-0500` is submitted without serial numbers
**Then** the write is rejected with `error_code: "SERIAL_REQUIRED"`

**Given** serial `SN-1001` of `EQ-0500` is already in stock
**When** a receipt event carrying the same serial `SN-1001` is posted
**Then** the write is rejected with `error_code: "DUPLICATE_SERIAL"` and the location currently holding that serial is returned

**Given** serial `SN-1001` has moved through receipt, inter-location transfer, and issue
**When** `GET /api/v1/serials/SN-1001/trace` is called
**Then** the response lists every transaction and location in that serial's history in sequence — returned within the API p95 threshold of 500ms (NFR-P-05)

---

### Story 2.4: Ind AS 2 Compliant Inventory Valuation

As a financial controller,
I want inventory valued using FIFO, weighted average, or specific identification (selectable per item), with standard cost permitted only as an Ind AS 2 para 21 measurement technique, LIFO structurally blocked, and NRV testing run at period end,
So that the stock ledger is Ind AS 2 compliant from the first transaction and no non-permitted valuation method can be applied.

**FRs:** FR-I-05, FR-AC-05, FR-AC-06

**Acceptance Criteria:**

**Given** item `RM-0042` is configured with `valuation_method: "weighted_average"`
**When** receipt events are posted at varying unit costs (e.g., 10, 12, then 14) — directly via the stock-event API against open-PO line projections (Story 2.9) within Epic 2, or from GRNs once Epics 3-4 deliver receiving
**Then** the running weighted average cost updates after each receipt and is queryable via `GET /api/v1/stock/RM-0042/valuation`

**Given** item `FG-0010` is configured with `valuation_method: "fifo"`
**When** an issue transaction is posted
**Then** the cost of the issued quantity is calculated from the earliest available lot at its received cost

**Given** an administrator attempts to set `valuation_method: "lifo"` on any item
**When** the update request is submitted
**Then** the write is rejected with `error_code: "VALUATION_METHOD_NOT_PERMITTED"`

**Given** NRV testing is run and an item's net realisable value has fallen below cost
**When** the NRV write-down event is posted
**Then** the item's carrying value is reduced to NRV, the write-down is recorded with date and authoriser, and any subsequent recovery is capped at original cost (FR-AC-06)

**Given** item `EQ-0500` is serial-controlled with `valuation_method: "specific_identification"`, serial `SN-1001` received at unit cost 12,000 and serial `SN-1002` received at unit cost 13,500 (FR-I-05, FR-AC-05)
**When** an issue transaction for serial `SN-1002` is posted
**Then** the issue cost is exactly 13,500 — the received cost of the specific serial issued — and the remaining carrying value for `EQ-0500` is 12,000

**Given** an administrator configures standard cost for an item (FR-I-05)
**When** the configuration is submitted
**Then** standard cost is accepted only as an Ind AS 2 para 21 measurement technique: the configuration must carry a variance-review cadence, the period-end valuation report shows standard-vs-actual variance per item with breaches of the configured tolerance flagged for review, and an attempt to set `valuation_method: "standard_cost"` without the measurement-technique designation is rejected with `error_code: "VALUATION_METHOD_NOT_PERMITTED"`

---

### Story 2.5: Inter-Location Transfer Requests

As a warehouse manager,
I want to raise inter-location transfer requests with DOA-approval routing, then execute pick, ship, and receive transactions that maintain lot and serial traceability throughout,
So that stock moves between sites on an auditable chain of events with no quantity or lot leakage.

**FRs:** FR-I-02

**Acceptance Criteria:**

**Given** a transfer request from `site-A` to `site-B` for 50 units of `RM-0042`, lot `LOT-2026-001`
**When** the request is submitted
**Then** the 50 units show as `allocated` at `site-A`; the available balance at `site-A` decreases immediately while on-hand and in-transit are unchanged; the request is routed for approval via the DOA registry — stock enters `in_transit` only when the ship event posts

**Given** the transfer is approved and the pick and ship events are confirmed at `site-A`
**When** the ship event is posted
**Then** `site-A` on-hand decreases by 50; an in-transit record of 50 units appears carrying `lot_id: "LOT-2026-001"`

**Given** the receive event is posted at `site-B`
**When** the transaction is processed
**Then** `site-B` on-hand increases by 50 with `lot_id: "LOT-2026-001"` preserved; the in-transit balance clears; both ship and receive events carry the same `correlation_id`

**Given** a transfer request that has not been approved via the DOA registry
**When** a ship event for that transfer is posted
**Then** the write is rejected with `error_code: "APPROVAL_REQUIRED"` and no stock moves to `in_transit`

**Given** a transfer approved for 50 units
**When** a ship event for 60 units is posted
**Then** the write is rejected with `error_code: "QUANTITY_EXCEEDS_APPROVED"` and the approved quantity is returned to the caller

**Given** the ship event carried `lot_id: "LOT-2026-001"`
**When** a receive event at `site-B` references `lot_id: "LOT-2026-002"`
**Then** the write is rejected with `error_code: "LOT_MISMATCH"` and the in-transit record stays open until a matching receive or an approved discrepancy resolution posts

---

### Story 2.6: Cycle Counting and Physical Inventory

As an inventory controller,
I want to run cycle counts and full physical inventory checks with variance workflows, approval-gated adjustments, and CARO 2020 evidence output,
So that inventory accuracy stays at or above 98% (SM-01) and physical verification evidence is a byproduct of operations, not a year-end project.

**FRs:** FR-I-06

**Acceptance Criteria:**

**Given** a cycle count task is created for a zone covering 20 SKUs
**When** a counter submits counted quantities for each SKU
**Then** the system computes variance (counted minus system balance) per SKU and lot, and flags any variance above the configured tolerance for approval

**Given** a variance requires an adjustment and the adjustment is submitted without approval
**When** the event handler processes the command
**Then** the write is rejected with `error_code: "APPROVAL_REQUIRED"`; an approval task is created and routed via the DOA registry

**Given** the adjustment is approved and applied
**When** the stock balance updates
**Then** the adjustment event is logged in the edit log with approver identity, reason code, and delta quantity

**Given** a period-end physical inventory verification is complete
**When** `GET /api/v1/physical-verification/report` is called with location and date filters
**Then** the response includes, per count: count date, counter and approver identities, location coverage percentage, book versus counted quantity per SKU and lot, variance quantity and value, adjustment event reference, and management sign-off status — the evidence fields consumed by the CARO 2020 clause 3(i) sign-off artifact (Epic 11, FR-AC-15) — and report records are immutable once the period is locked

---

### Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging

As an inventory planner,
I want safety stock levels and reorder points computed per SKU per location from lead-time and demand variability, with automated replenishment recommendations and aging/obsolescence flags,
So that stockouts are reduced by 40% within 12 months (SM-02) and no slow-moving stock ages silently into write-off exposure.

**FRs:** FR-I-03, FR-I-07, FR-I-08 (flagging and NRV trigger; disposition feed deferred — see note below)

**Acceptance Criteria:**

**Given** an item with 90 days of demand history showing a daily-demand standard deviation of 4 units, `lead_time_days: 9` on the SKU-location record, and a configured service level of 95%
**When** the safety stock computation runs
**Then** the stored safety stock equals `z(0.95) × σ_daily × √lead_time_days` = 1.645 × 4 × 3 = 19.74, rounded up to 20 units, stored against the SKU-location combination with the computation date and the input parameters used (FR-I-07)

**Given** on-hand stock for `RM-0042` at `site-A` falls to or below its reorder point
**When** the replenishment check runs
**Then** an automated purchase requisition or replenishment recommendation is created with the standard order quantity, and the planner receives an exception alert

**Given** an item has had zero issues for longer than the configured obsolescence threshold (e.g., 180 days)
**When** the obsolescence flag job runs
**Then** the item is marked `aging` in the read model, appears in the obsolescence exception report, and NRV testing is triggered (FR-AC-06)

**Note (lead-time source):** Until Epic 4 delivers measured PO-to-receipt lead times, `lead_time_days` is maintained per SKU-location — seeded manually or derived from expected dates on open-PO projections (Story 2.9) — and each computation records which source was used.

**Note (FR-I-08 disposition feed):** Deferred to Phase 2 (Epic 16): routing of flagged aging/obsolete stock into the scrap/disposition workflow (FR-SC-01). Phase-1 interim behavior: flagged items carry `disposition_status: "pending_disposition"`, remain visible in the obsolescence exception report, and NRV testing (FR-AC-06) still applies — no stock leaves the ledger until Epic 16 delivers disposition.

---

### Story 2.8: Consignment and VMI Stock Segregation

As a finance controller,
I want consignment and VMI stock held at our locations tracked separately from owned inventory with no commingling of quantities or values,
So that consignment stock never appears in our balance sheet and VMI replenishment signals route to the correct owner.

**FRs:** FR-I-10

**Acceptance Criteria:**

**Given** a consignment receipt event is posted for 100 units of `RM-0099` from supplier `SUP-007`
**When** the stock balance is queried
**Then** the 100 units appear under `stock_class: "consignment"` with the supplier reference; the owned on-hand balance for `RM-0099` is unchanged

**Given** an issue transaction is raised for `RM-0099` without specifying `stock_class`
**When** the event handler processes it
**Then** it draws from owned stock only; consignment stock is not allocated unless `stock_class: "consignment"` is explicit in the command

**Given** VMI stock for `RM-0099` falls below the agreed VMI minimum
**When** the VMI check runs
**Then** a replenishment event with `signal_type: "vmi_replenishment"` carrying the owner-party supplier reference is generated and visible in the replenishment exception queue — not a standard internal purchase requisition; transmission to the supplier channel arrives with the supplier registry (Epic 4, Story 4.1)

**Given** 100 consignment units and 40 owned units of `RM-0099` are on hand
**When** `GET /api/v1/stock/RM-0099/valuation` is called
**Then** the carrying value covers only the 40 owned units; the 100 consignment units contribute zero to owned inventory value and are reported in a separate consignment quantity section

**Given** consignment on-hand for `RM-0099` is 100 units
**When** an issue with `stock_class: "consignment"` for 120 units is submitted
**Then** the write is rejected with `error_code: "INSUFFICIENT_STOCK"` scoped to the consignment stock class — owned stock is never drawn to cover a consignment shortfall

**Note (owner-party references before Epic 4):** Supplier references on consignment and VMI records are owner-party codes validated against supplier references appearing on ERP inbound projections (Story 2.9) — not free text. VMI agreement minimums are SKU-location configuration owned by this story; the governed supplier registry (Epic 4, Story 4.1) supersedes these codes without renumbering them.

---

### Story 2.9: ERP Inbound Reference Projections

As a stock controller or planner,
I want read-only projections of ERP open purchase orders (headers and lines with quantity, price, and receipt-tolerance fields) and open sales orders (dispatch demand) synced into the platform on a defined freshness cadence,
So that receiving, replenishment, job-work, and dispatch flows have a defined Phase-1 source for PO reference data and outbound demand while ERP remains the master (INT-ERP-01) and order management (Epic 15) does not yet exist.

**FRs:** INT-ERP-01 (reference projections; ERP remains master). Consumed by FR-W-02 receiving against PO (Epic 3), FR-I-03 replenishment context (Story 2.7), the Phase-1 outbound-demand source (Epics 3, 9, 11), and three-way match inputs (Epic 4).

**Acceptance Criteria:**

**Given** ERP holds open purchase order `PO-2026-0042` with two lines, each carrying ordered quantity, unit price, and over/under-receipt tolerance percentages
**When** the inbound sync runs
**Then** `GET /api/v1/erp/purchase-orders/PO-2026-0042` returns a read-only projection with header fields (supplier reference, currency, expected delivery date) and per-line `sku`, `ordered_qty`, `open_qty`, `unit_price`, `over_receipt_tolerance_pct`, `under_receipt_tolerance_pct`, each stamped `source_system: "ERP"` with a `last_synced_at` timestamp

**Given** ERP holds open sales orders with required-by dates and ship-from sites
**When** `GET /api/v1/erp/sales-orders?site=site-A&status=open` is called
**Then** the response lists dispatch-demand lines (`sku`, `quantity`, `required_by`, `ship_to`) — the Phase-1 outbound-demand source referenced by pick, dispatch, and IRN flows (Epics 3, 9, 11)

**Given** the inbound sync has not completed within the configured freshness threshold (default 15 minutes)
**When** any projection is queried
**Then** the response carries `stale: true` with the age of `last_synced_at`, and a sync-failure alert is raised to the integration exception queue

**Given** a client attempts to create, update, or delete a purchase-order or sales-order projection through the platform API
**When** the write is processed
**Then** it is rejected with `error_code: "SOURCE_SYSTEM_READ_ONLY"` — corrections are made in ERP and arrive on the next sync

**Given** a sync batch contains a malformed record (e.g., a PO line referencing an unknown SKU)
**When** the batch is processed
**Then** the malformed record is routed to the integration exception queue with the standard error envelope (stable `error_code`, source record reference, reason), and the remaining records in the batch sync successfully — no batch-level abort

**Note (reference data, not a procurement module):** These projections are reference data only — ERP remains the master for PO and sales-order lifecycle (INT-ERP-01). Nothing in this platform mutates PO or sales-order state; receipts recorded against a projected PO line (Story 2.2, Epics 3-4) never write back to the projection. Epic 4 builds procurement workflows on top of these projections; Epics 3, 9, and 11 reference Story 2.9 for PO data and dispatch-order demand.

### Story 2.10: Item Groups Master

As a stock controller,
I want a governed item group master with each item assigned to a group,
So that grants, reports and rules can target a named group of items instead of free-text categories.

**Acceptance Criteria:**

**Given** an inventory controller
**When** they create an item group
**Then** it gets a unique code and name, is event-sourced and edit-logged, and can be deactivated but never deleted while items reference it

**Given** an item in the item master
**When** it is assigned to a group
**Then** the item carries exactly one `item_group` (nullable until assigned), the change is an audited event, and lookups by group return its active items

**Given** existing items
**When** the story deploys
**Then** items stay valid with no group, and a report lists ungrouped items for assignment

**Given** a reference to an unknown or inactive group
**When** an item assignment or a downstream grant is saved
**Then** it is refused with a stable error code

**Note:** PILOT. Prerequisite of Story 4.8 (grant scope by item group). Source: user ruling 2026-09-29 (Story 4.8 open questions). Reopens Epic 2.

---

## Epic 3: Warehouse Operations and Frontline Capture Flows

Gate officers, weighbridge operators, and store assistants capture every inbound movement from vehicle entry to bin in seconds, gloved, one-handed, offline when needed — the system shows "Captured — pending sync" and never silently drops an event. Warehouse managers execute the complete physical cycle: receiving, system-directed putaway, picking, packing, and shipping. Location overrides made at the floor level improve directed bins for the whole team (NFR-ADOPT-01). Realizes UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01. The edge PWA shell from Epic 1 is the platform; Epic 3 stories build the actual capture flows on it.

### Story 3.1: Warehouse Topology Setup (FR-W-01)

As a warehouse manager,
I want to define and manage the warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine zone attributes,
So that every putaway task, pick path, and location override references a real, validated physical location in the system.

**Acceptance Criteria:**

**Given** a warehouse manager creates a zone `ZONE-COLD` with `temperature_class: "cold"` at `site-A`
**When** `GET /api/v1/locations?site=site-A` is called
**Then** `ZONE-COLD` appears in the response with its zone type and temperature class (FR-W-01)

**Given** a bin `BIN-A43` is created under aisle `AISLE-A`, rack `RACK-4`, zone `ZONE-AMBIENT`
**When** `GET /api/v1/locations/BIN-A43` is called
**Then** the response returns the bin with its full hierarchy path (`site-A > ZONE-AMBIENT > AISLE-A > RACK-4 > BIN-A43`) and its attributes (size class, temperature class, hazmat flag) — verifiable at this story's completion; putaway-task consumption of the path is exercised in Stories 3.4/3.5 (FR-W-01)

**Given** a quarantine zone `ZONE-QC-HOLD` is marked `access_restricted: true`
**When** any location-assignment write targeting `ZONE-QC-HOLD` is attempted by a user without the `qc_inspector` role
**Then** the system rejects the write with `error_code: "ZONE_ACCESS_RESTRICTED"` — the rule is enforced at the location service, so putaway tasks built in Stories 3.4/3.5 inherit it without re-implementation

---

### Story 3.2: Gate Event Capture and Vehicle-to-PO Binding (UJ-GATE-01, FR-W-02)

As a gate officer,
I want to log an inbound vehicle by scanning or keying a PO reference and photographing the challan — even with no network — and have the system create a traceable gate event that auto-reconciles on reconnection,
So that every goods entry is on a traceable record from the first second, a vehicle with no matching PO is captured as "unmatched" rather than turned away, and nothing is lost to a network outage.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** PO references scanned at the gate resolve against the read-only open-PO projection synced from the ERP — no Epic 4 PO-creation capability is required.

**Acceptance Criteria:**

**Given** a gate officer opens the edge PWA offline and scans PO `PO-2026-0441`, which exists in the locally synced open-PO projection (Story 2.9)
**When** the gate event is submitted
**Then** a gate event is stored locally with status `pending_sync`, the officer sees "Captured — pending sync", and a vehicle-to-PO binding token is created locally with the gate_id, officer_id, and timestamp (AD-2)

**Given** the device reconnects
**When** PowerSync syncs the gate event to the central event store
**Then** the event auto-reconciles to `PO-2026-0441` in the Story 2.9 open-PO projection; the binding token is visible to downstream weighbridge and receiving flows within 30 seconds

**Given** a vehicle arrives with a challan referencing an unknown PO
**When** the gate officer submits the gate event with `po_ref: "UNKNOWN"`
**Then** the event is captured as `status: "unmatched"` and routed to a named owner (store assistant); the vehicle is not turned away and no event is silently dropped

**Given** the gate officer is offline and photographs the challan
**When** the photo is attached to the gate event
**Then** the photo is stored in the local SQLite store with `pending_sync` status and transmitted when the network returns; challan photo is mandatory for offline events (marked required in the capture form)

---

### Story 3.3: Weighbridge Event Capture and Tolerance Enforcement (UJ-WEIGH-01, FR-W-02)

As a weighbridge operator,
I want to record tare and gross weights against the vehicle-to-PO binding token and have net weight auto-calculated and validated against tolerance, with out-of-tolerance loads blocked from silent receipt,
So that every goods receipt carries a trusted, auditable weight and no variance slips through unreviewed.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** the tolerance applied to net weight is the line tolerance carried on the read-only open-PO projection — no Epic 4 PO configuration is required.

**Acceptance Criteria:**

**Given** the vehicle-to-PO binding token from Story 3.2 is active
**When** the operator records `tare: 12000 kg` and `gross: 15500 kg`
**Then** net weight auto-calculates as 3500 kg; the event carries the token reference, device_id, timestamp, and `capture_method: "MANUAL"`

**Given** the net weight falls within the line tolerance carried on the Story 2.9 open-PO projection for that PO line (e.g., +/- 2%)
**When** the weighbridge event is confirmed
**Then** the weighbridge event is recorded with `status: "accepted"` and the accepted weight is queryable against the binding token — available for the Story 3.4 receiving flow to consume when it lands, without asserting Story 3.4 behavior here

**Given** the net weight exceeds the configured tolerance
**When** the weighbridge event is submitted
**Then** the load is flagged `status: "tolerance_breach"`, blocked from silent receipt, and a task is routed to the named owner (QC or receiving supervisor) — the operator sees the breach reason on-screen

**Given** the device is offline during weighment
**When** weight readings are captured
**Then** they are queued locally with timestamp and device provenance; on reconnect they replay in sequence with no re-entry by the operator

---

### Story 3.4: Goods Receiving Against ASN or PO (FR-W-02)

As a receiving store assistant,
I want to receive goods against an ASN or PO — capturing lot/serial numbers, expiry dates, and QC capture flags — and have the system generate putaway tasks automatically,
So that every item enters stock on a complete, traceable receiving record and the putaway queue is ready before the truck is unloaded.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** receiving validates items, quantities, and tolerances against the read-only open-PO projection — no Epic 4 PO-creation capability is required.

**Scope note:** this story includes a minimal supplier ASN intake (INT-SUP-02): an inbound API/EDI endpoint that stores ASN header and lines referencing an open PO on the Story 2.9 projection. Supplier portal and full EDI onboarding remain Phase 2.

**Acceptance Criteria:**

**Given** the weighbridge token is accepted and the receiving flow opens for `PO-2026-0441` from the Story 2.9 open-PO projection
**When** the store assistant scans each carton's barcode and enters lot and expiry details
**Then** a GRN line is created per item with `lot_id`, `expiry_date`, `received_qty`, and the weighbridge token reference; putaway tasks are generated for each line (FR-W-02)

**Given** a supplier ASN captured via the minimal ASN intake (INT-SUP-02) references open PO `PO-2026-0441` on the Story 2.9 projection
**When** the store assistant opens the receiving flow against the ASN
**Then** expected lines (item, quantity, lot/serial where advised) pre-populate from the ASN, and each confirmed GRN line records `source_document: "ASN"` alongside the PO reference (FR-W-02 ASN path)

**Given** a received item has a BIS licence flag on its item master
**When** the GRN line is confirmed
**Then** a QC inspection task is created for that line before the putaway task is released (FR-Q-02 integration point; QC stories are in Epic 8, built alongside Epic 3 in the pilot slice); until the Epic 8 disposition flow lands, an authorized supervisor may manually release the held putaway task, and the manual release is audited with operator identity and reason code

**Given** the operator scans a barcode that does not match any line item of `PO-2026-0441` on the Story 2.9 projection
**When** the GRN line is attempted
**Then** the system rejects it with `error_code: "ITEM_PO_MISMATCH"` and prompts for confirmation or escalation

**Given** the received quantity on a GRN line exceeds the PO line quantity beyond the line tolerance carried on the Story 2.9 projection
**When** the GRN line is submitted
**Then** the system rejects it with `error_code: "RECEIPT_TOLERANCE_EXCEEDED"` and routes a discrepancy task to the named receiving owner — no stock enters the ledger for the rejected line

**Given** the received quantity is short of the PO line quantity but within the line tolerance
**When** the GRN line is confirmed
**Then** the line posts with the received quantity, the shortage variance is flagged on the GRN and visible in the receiving discrepancy view, and the PO line shows an open remaining balance against the Story 2.9 projected quantity (the ERP remains the PO system of record)

**Given** the store assistant enters an `expiry_date` earlier than the receiving date
**When** the GRN line is submitted
**Then** the system rejects it with `error_code: "LOT_EXPIRED"`; the line may only be captured as a quarantined receipt into `ZONE-QC-HOLD` with supervisor approval — an attempt without that approval is rejected with `error_code: "APPROVAL_REQUIRED"`

---

### Story 3.5: Directed Putaway and Location Override Recording (UJ-PUT-01, FR-W-03)

As a store assistant,
I want the system to direct me to the best bin for each received lot and let me scan the actual bin I used — recording any override as an authoritative correction event with a reason code,
So that every physical location is reflected in the system, my real-world knowledge improves the directed suggestions for the whole team, and last-writer-wins is never applied to location.

**Scope note:** this story builds the velocity-classification capability (ABC classes derived from pick/putaway frequency) and the override-driven re-slotting job — they are deliverables of 3.5, not pre-existing infrastructure.

**Acceptance Criteria:**

**Given** a putaway task exists for 50 kg of `RM-0042` in `ZONE-AMBIENT`
**When** the store assistant opens the task on the edge PWA
**Then** the system displays a directed bin suggestion (e.g., `BIN-A43`) based on velocity class, item size class against bin size class, zone rules, and current occupancy (FR-W-03)

**Given** a received lot carries size class `LARGE` and `BIN-A43` carries size class `SMALL` (size attributes from Story 3.1 topology)
**When** the directed putaway suggestion is computed
**Then** `BIN-A43` is excluded and the suggestion returns the nearest eligible bin whose size class fits the lot (FR-W-03 size criterion)

**Given** the store assistant scans `BIN-A47` instead of the suggested `BIN-A43`
**When** the scan is confirmed with reason code `"better_space_available"`
**Then** a `location.override` event is recorded with the asserted location `BIN-A47`, the expected location `BIN-A43`, the reason code, and the operator identity; `BIN-A47` becomes the authoritative current location

**Given** multiple override events for the same bin cluster within 30 days
**When** the re-slotting job built in this story runs (velocity classification plus override-cluster analysis)
**Then** the directed putaway suggestion for that item is updated to reflect the operator's preferred bin — the override improves the suggestion for the whole team (NFR-ADOPT-01)

**Given** the store assistant is offline when completing the putaway
**When** the override event is synced
**Then** it replays in the correct sequence relative to other events for the same lot, and the location projection is updated exactly once

---

### Story 3.6: Pick Task Generation and Execution (FR-W-04)

As a warehouse operator,
I want to receive system-generated pick tasks with optimized paths and execute them via the edge PWA or a printed pick list (single-order, batch, wave, or zone), with task confirmation updating stock allocation in real time,
So that picks are accurate and efficient, and stock allocation is always current without manual reconciliation.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** Phase-1 outbound demand is the sales-order projection synced inbound from the ERP — dispatch orders below are lines of that projection, not the Phase-2 Epic 15 order module.

**Acceptance Criteria:**

**Given** a dispatch order from the Story 2.9 sales-order projection requires 100 units of `FG-0010` from `site-A`
**When** pick tasks are generated
**Then** the system creates tasks whose pick lines are sequenced in ascending bin pick-sequence within each zone (the observable definition of "optimized path"), selects lots by FEFO, and sets the 100 units as `allocated` in the stock balance (FR-W-04)

**Given** three open dispatch orders from the Story 2.9 projection require `FG-0010` from the same zone
**When** the supervisor releases them as a batch pick
**Then** a single consolidated pick task is generated for the combined quantity, with per-order sortation quantities shown at the pick line (FR-W-04 batch strategy)

**Given** open dispatch orders are grouped by dispatch cutoff time into a wave
**When** the wave is released
**Then** pick tasks for all orders in the wave are generated together and carry the `wave_id`; orders outside the wave remain unreleased (FR-W-04 wave strategy)

**Given** a dispatch order's pick lines span `ZONE-AMBIENT` and `ZONE-COLD`
**When** zone picking is selected
**Then** separate pick tasks are generated per zone, each assignable to a zone operator, and the order moves to `picked` only when every zone task is confirmed (FR-W-04 zone strategy)

**Given** a pick task list is generated for an operator working without an edge device
**When** the supervisor prints the pick list
**Then** a paper pick list renders with task IDs, bin pick-sequence, and directed lots; keyed-in confirmations against those task IDs are recorded with `capture_method: "PAPER"` (FR-W-04 paper-directed)

**Given** an operator scans the lot barcode at the pick location
**When** the scan is confirmed on the edge PWA
**Then** the pick line is marked confirmed; if the scanned lot does not match the directed lot, the system prompts for an override reason before allowing the substitution

**Given** the operator confirms all pick lines for an order
**When** the last confirmation is submitted
**Then** stock status moves from `allocated` to `picked` and the packing station is notified

---

### Story 3.7: Packing, Shipping, and Dispatch Documents (FR-W-05, FR-W-06)

As a dispatch clerk,
I want to complete packing validation, generate shipping documents (bill of lading, commercial invoice, packing slips, labels), and confirm dispatch — with the system blocking dispatch if any compliance hold exists,
So that every outbound shipment is documented, weighed, and cleared before the truck leaves the gate.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** the orders packed and dispatched here are dispatch orders from the Story 2.9 sales-order projection; consignee details are sourced from that projection (the ERP customer master remains the consignee system of record in Phase 1).

**Deferred to Phase 2 (Epic 15):** customs documentation, carrier rate shopping, and load planning (FR-W-06 clauses) — Phase 1 delivers BOL, packing slip, commercial invoice, and labels only.

**Acceptance Criteria:**

**Given** all pick lines for a dispatch order (Story 2.9 sales-order projection) are confirmed
**When** the packing station operator confirms weights, labels, and cartonization
**Then** a packing record is created with actual weights and label references; the order moves to `ready_to_ship` status (FR-W-05)

**Given** the order is `ready_to_ship`
**When** the dispatcher generates shipping documents
**Then** a BOL, packing slip, and commercial invoice are produced with the correct lot references, weights, and consignee details taken from the Story 2.9 sales-order projection (FR-W-06)

**Given** the order contains a lot under a quality hold (FR-Q-09 integration point; hold state and `LOT_ON_HOLD` semantics are established in Story 2.3)
**When** dispatch is attempted
**Then** the system blocks dispatch with `error_code: "LOT_ON_HOLD"` — no shipping document is generated until the hold is released

---

### Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07)

As a warehouse supervisor,
I want to assign, prioritize, and monitor all open warehouse tasks (receiving, putaway, picking, packing) with productivity metrics per operator and zone,
So that I can balance workload, identify bottlenecks, and track against the gate dwell target of under 4 minutes median (SM-13) and frontline confirmation rate above 95% (SM-17).

**Acceptance Criteria:**

**Given** multiple open putaway and pick tasks exist across operators
**When** the supervisor opens the task management dashboard
**Then** open tasks are grouped by type and operator, showing age, priority, and zone; tasks that breach a configurable SLA threshold are visually highlighted with the breached threshold shown (FR-W-07)

**Given** an operator completes a task
**When** the confirmation is posted
**Then** the task is marked complete with operator identity and duration; the confirmation rate metric updates in the read model

**Given** gate dwell (SM-13) is computed per vehicle as the interval from the gate-entry event timestamp (Story 3.2) to weighbridge acceptance for the same binding token (Story 3.3) — falling back to GRN confirmation (Story 3.4) where no weighment applies — and the shift median exceeds 4 minutes
**When** the supervisor views the exception dashboard
**Then** the metric appears as an exception with drill-through to the individual gate events that breached the threshold

---

### Story 3.9: Forward-Pick Replenishment (FR-W-08)

As a warehouse manager,
I want forward-pick zones replenished automatically from reserve storage when min/max levels are breached or when open pick demand signals a shortfall,
So that high-velocity picking zones stay stocked without manual intervention.

**Acceptance Criteria:**

**Given** the forward-pick quantity for `SKU-RM0042` in zone `FP-ZONE-A` drops below its configured minimum (FR-W-08)
**When** the replenishment trigger runs
**Then** a replenishment task is created to move the quantity that tops the zone up to its configured maximum from reserve storage to `FP-ZONE-A`, and the task appears in the task board for assignment

**Given** open pick demand for `SKU-RM0042` from the Story 2.9 sales-order projection exceeds the current forward-pick balance in `FP-ZONE-A`, even though the configured minimum has not yet been breached
**When** the replenishment trigger runs
**Then** a demand-signal replenishment task is created for the shortfall quantity ahead of the min/max cycle (FR-W-08 demand signals)

**Given** a replenishment task completes
**When** the operator confirms the transfer
**Then** the forward-pick balance updates immediately; the reserve balance decreases by the same quantity; both movements carry the same `correlation_id`

---

### Story 3.10: Cross-Docking Execution (FR-W-09)

As a warehouse manager,
I want qualifying inbound receipts cross-docked directly to outbound staging without touching racking,
So that cross-dockable receipts clear the dock faster and dock-to-dispatch time shrinks.

**Depends on Story 2.9 (ERP Inbound Reference Projections):** cross-dock matching binds inbound receipt lines to open outbound demand on the Story 2.9 sales-order projection — no Phase-2 Epic 15 order module is required.

**Acceptance Criteria:**

**Given** inbound stock on a receipt line matches an open sales-order line on the Story 2.9 projection and is flagged `cross_dock: true` (FR-W-09)
**When** the receiving event is confirmed
**Then** a cross-dock task routes the stock directly to the outbound staging area; no putaway task to reserve storage is generated for that receipt line

**Given** a cross-dock task is confirmed at outbound staging
**When** the stock is moved
**Then** the pick allocation for the matching dispatch order (Story 2.9 sales-order projection) updates to reflect the cross-docked lot, and the dock-to-dispatch cycle time is recorded in the task duration metric

---

### Story 3.11: GRN Line Condition and Reason Codes

As a receiving store assistant,
I want every GRN line to carry a condition and a fixed, grouped reason code when the receipt is not clean,
So that shortages, damage, and wrong deliveries are captured at the dock with evidence and routed correctly instead of posting silently as good stock.

**PRE-PILOT BLOCKING:** reason reporting is required at pilot; the pilot site cannot go live on receiving without it. Ratified in the UX run 2026-09-23 to 2026-09-26 (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, EXPERIENCE.md Receiving and Damage Governance plus the run memlog reason-code ruling). Extends Story 3.4, which creates QC inspection tasks but records no line condition or reason code. Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.

**Acceptance Criteria:**

**Given** a GRN line being confirmed (Story 3.4 flow)
**When** the store assistant records the line
**Then** the line carries a condition, and any non-clean condition carries exactly one reason code from the fixed grouped set: `SHORT`, `DAMAGED`, `REJECTED` (wrong item or wrong spec), or `OTHER`; the condition and reason code are stamped on both the GRN line and the `goods.received` event

**Given** a line captured with reason code `OTHER`
**When** the line is submitted
**Then** it is accepted only with a photo plus a one-line description; without both it is rejected at capture

**Given** a line captured as `DAMAGED` or `REJECTED`
**When** the GRN line is confirmed
**Then** the affected quantity routes to quarantine under a quality hold (Story 8.5 hold machinery) instead of ordinary putaway

**Given** a line captured as `REJECTED` for wrong item or wrong spec
**When** the GRN posts
**Then** the rejected quantity never posts against the PO line - the PO line's open balance is unchanged and the rejection is visible in the receiving discrepancy view

**Given** the pilot configuration
**When** a non-clean line is submitted without a reason code
**Then** it is rejected at capture - reason reporting is required at pilot, not optional

---

### Story 3.12: Weighbridge Breach Task Routing for Pilot Roles

As a warehouse manager at the pilot site,
I want weighbridge tolerance-breach tasks routed to a role that a real pilot account actually holds,
So that every breach reaches a person who can act on it instead of dying in a queue no one sees.

**PRE-PILOT BLOCKING (defect):** Story 3.3 emits breach notifications targeting `receiving_supervisor` (`src/compliance/weighbridge.ts:11`, `src/api/v1/weighbridge.ts:34`), but the pilot roles file provisions no holder of that role - the access matrix defines `unloading_supervisor` instead - so breaches currently reach nobody. Found checking the UX mocks against code (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, EXPERIENCE.md Backend Dependencies plus the run memlog). Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.

**Acceptance Criteria:**

**Given** a weighbridge event flagged `status: "tolerance_breach"` (Story 3.3)
**When** the breach task is routed
**Then** it targets a role present at pilot - either the routing changes to `unloading_supervisor` or `receiving_supervisor` is provisioned in the pilot roles file - and the decision is recorded in the story file

**Given** the corrected routing
**When** the routing role is resolved
**Then** both code sites resolve the same role from one place (`src/compliance/weighbridge.ts:11` and `src/api/v1/weighbridge.ts:34` do not disagree)

**Given** the pilot role provisioning
**When** a tolerance breach fires in a staging rehearsal
**Then** the task lands with an account that actually holds the target role, and the holder sees the breach reason

**Given** the regression suite
**When** it runs
**Then** a test asserts that a tolerance breach reaches at least one real holder of the target role, and fails if the role has no holder in the pilot roles fixture

---

### Story 3.13: Gate Entry and Weighbridge Capture Screen

As a gate officer or weighbridge operator (gate1@ancorlabs.org holds both, `docs/migration/pilot-mock-extract/roles.json:297-310`),
I want one edge screen that captures the gate entry (challan, photo, vehicle, supplier, PO binding) and the weigh-in gross and weigh-out tare, online or offline,
So that a PO-backed truck gets a binding token and an accepted weighment from the PWA and receiving can raise a GRN.

**Acceptance Criteria:**

**Given** a caller whose assignment role is `gate_officer` or `weighbridge_operator` with `functionScope` write covering the operating site
**When** the bootstrap runs
**Then** navigation carries `Gate entry` from a new row `{ name: 'Gate entry', modules: 'gate', functionScope: 'write' }` resolved by a role-evaluated `hasGateScope` beside `hasDamageCaseScope` (`src/api/v1/edge.ts:389-420`, modules union at `:364-368` widened with `gate`); NAV_ENTRIES gains `/gate` with label `nav.gateEntry` (`edge/src/components/navigation/nav-model.ts:11-31`); `gate` joins BaseView and BASE_VIEW_ENTRY (`edge/src/components/app-shell.tsx:130-152`); a `store_assistant` holding module inventory is not sent the entry; a deep link without the entry renders the existing no-access card (`app-shell.tsx:349-358`); `edge/test/e2e/offline-shell.spec.ts:13-19` fixtures are updated; an integration test proves both callers

**Given** Task 1 server work
**When** it lands
**Then** `gate_officer` and `weighbridge_operator` are added to `ASN_READ_ROLES` with module inventory or gate admitted on the GET path only (`src/api/v1/asn.ts:18`, `:27-30`, `:41-44`, `:242-245`); `assertRoleAllowed` in `src/api/v1/gate.ts:68-87` and `src/api/v1/weighbridge.ts:71-92` adopt the `src/middleware/rbac.ts:165-168` rule that a write assignment satisfies a read check, with a test per router that a write-only holder lists with 200 and a read-only `stock_viewer` still gets 403; `weighbridge_operator` joins `GENERAL_READ_ROLES` (`gate.ts:33`) and `gate_officer` joins `WEIGHBRIDGE_READ_ROLES` (`weighbridge.ts:32-36`); the bootstrap response (`src/api/v1/edge.ts:452-460`) gains `site_code_ext` (from location_register for the operating site) and `gate_id` (edge config, default GATE-01) which `gate.entered` requires (`src/compliance/gate.ts:69-75`); `assertGateEnteredShape` accepts optional `supplier_ref_ext` (vendor code or UNLISTED) and `supplier_name_unlisted`, projected onto `gate_event`; a new read `GET /api/v1/weighbridge-events/stamp-status?site=` (WEIGHBRIDGE_READ_ROLES, registered before `/api/v1/weighbridge-events/:weighbridgeEventId` at `src/server.ts:792`) returns the site device keys with stamp state from the statutory examination register (`src/compliance/weighbridge.ts:73-102`); `WEIGHBRIDGE_OUT_OF_STAMP` is added to both PERMANENT_ERROR_CODES twins (`edge/src/sync/connector.ts:111-118`, `src/sync/upload.ts:102-108`, parity test kept green) and `errors.WEIGHBRIDGE_OUT_OF_STAMP` to `edge/src/messages/en.json` beside `:143-149`

**Given** the Challan step
**When** the officer scans a challan code with the new shared ScanField (hardware trigger, keyboard wedge into the focused input, camera on coarse pointer; `Scan again` and `Type challan number` side by side and visible without scrolling at 360x640, EXPERIENCE.md:80, DESIGN.md:270)
**Then** the code is resolved online as ASN first (`GET /api/v1/asn/:asnNumberExt`, `src/server.ts:797`) then PO (`GET /api/v1/erp/purchase-orders/:poNumber`, `:769`), a match card shows Accept and Not this, a typed challan number records `challan_number_ext` with `po_ref_ext` UNKNOWN, Next is disabled until accepted, rejected or typed, and the result is announced in aria-live; this is a recorded deviation from EXPERIENCE.md:81, :123 and :256 (offline resolution against synced PO and ASN rows) pending owner question Q1 of the proposal

**Given** the challan step is resolved
**When** the officer takes the mandatory photo (camera capture on coarse pointer as `report-damage.tsx:413-414`; file input accepting ACCEPTED_PHOTO_TYPES on desktop), types the vehicle number and optional driver name, then on the Supplier step accepts the matched PO vendor (pre-filled) or taps `Unlisted supplier` and types the name (chip `Stores will match this later. The truck can go in now.`, EXPERIENCE.md:82, UJ-GATE-01 step 3 at :178, mock L647-676), and taps Submit entry
**Then** one `gate.entered` envelope is written through `createOutboxEvent` and `insertCaptureEvent` (`edge/src/capture/outbox-event.ts:3`, `edge/src/local-db/outbox.ts:42`) with the photo in `pendingPhotoStore` (`edge/src/local-db/pending-photos.ts:72`), `vehicle_reg_ext` upper-cased, `gate_id` and `site_code_ext` from the bootstrap, the supplier fields, and the payload shape of `src/compliance/gate.ts:55-91`; the device-generated `metadata.correlation_id` is the binding token (persisted by `gate.ts:139`); the officer reads `sync.captured` online or offline and the entry locks; OCR plate pre-fill is not built (recorded as deferred, EXPERIENCE.md:122)

**Given** the Trucks on site tab
**When** it opens
**Then** it lists open gate entries derived on the device from the synced `edge_site_events` bucket (`gate.entered` minus `gate.reversed` by stream, joined to `weighbridge.recorded` by `correlation_id`, `sync/sync-rules.yaml:2-5`) merged with this device's unsynced outbox rows, as inbox cards with a derived text state pill (Entered - weigh in pending; Weighed in - gross held on device; Weighed out - net recorded; Exception when status is tolerance_breach), refreshed from `GET /api/v1/gate-events?site=<site_code_ext>&status=open` (`src/server.ts:788`) and `GET /api/v1/weighbridge-events?site=<site_code_ext>` (`:793`) when online; offline the list still renders from local rows and the sync badge shows the state (EXPERIENCE.md:99)

**Given** a truck and a PO line picked from the PO lookup
**When** the operator records gross then tare in kg with up to 3 decimals and a reading source pill AUTO or MANUAL
**Then** the gross is held on the device until the tare exists, then one `weighbridge.recorded` envelope is queued with `correlation_id` equal to the gate binding token, `device_id`, `po_ref_ext`, `line_no`, `gross_kg`, `tare_kg`, `site_code_ext` and `capture_method` MANUAL when either reading was typed (`src/compliance/weighbridge.ts:146-216`); tare greater than gross is refused on the device with `errors.WEIGHBRIDGE_NET_NEGATIVE`; a net outside the PO line band shows a provisional breach banner naming the unloading supervisor (`TOLERANCE_BREACH_OWNER_ROLE`, `src/compliance/weighbridge.ts:18`), still submits, and the server verdict replaces it on sync; AUTO is set only when a reading arrives from the indicator read, and at pilot the `Read from weighbridge indicator` button renders disabled with the reason `No indicator link on this device` (EXPERIENCE.md:117) so every reading is MANUAL

**Given** the site weighbridge device is out of stamp
**When** the operator opens weigh-in
**Then** the stamp-status read returns the device keys with stamp state, the weigh action is disabled with the reason in words, the gate entry stays submittable, and a 423 `WEIGHBRIDGE_OUT_OF_STAMP` refusal on sync settles needs_attention and lands in Refused captures with its `errors.*` text

**Given** the four device classes
**When** unit, e2e and axe suites run
**Then** every string resolves from `en.json`, the stepper is single column on handheld and step list beside the form on tablet and wider, targets are 56/48 px on coarse pointer and 34 px on desktop, `aria-current="step"` is exposed, axe reports zero serious or critical violations on both tabs, and a keyboard-only pass completes one gate entry and one weighment

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes audit gaps G01 and G02. Depends on 3.2, 3.3, 3.12, 2.9, 1.14, 1.15, 8.9 (done) and edge Phase 1 (563d246). Owns the shared ScanField and the role-scoped nav token pattern reused by 3.14, 3.15, 3.16, 3.18, 3.19, 3.20, 4.12, 7.11 and 8.11. Size XL; if split, cut along the server contract seam (3.13a) and the screen (3.13b), not gate versus weighbridge.

---

### Story 3.14: Stores Inbox, Scan Anything Bar and Acceptance into Inspection Bay

As a storekeeper (`store_assistant`, store1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:317-336`),
I want a task inbox with a Scan anything bar and an acceptance screen that counts every PO line, reports short, damaged or rejected with evidence, and completes the GRN into the inspection bay,
So that UJ-PUT-01 steps 1 to 3 and the acceptance half of step 4 run on the PWA with the Story 3.11 reason codes (the label queue of step 4 and the putaway of step 5 are Story 3.15).

**Acceptance Criteria:**

**Given** a caller with a receiving write assignment at the operating site
**When** the bootstrap runs
**Then** navigation carries `Stores` from a new row `{ name: 'Stores', modules: ['receiving'], functionScope: 'write' }` inserted before `Stores issue` in NAVIGATION_CAPABILITIES (`src/api/v1/edge.ts:368-383`); NAV_ENTRIES gains `{ name: 'Stores', href: '/stores', label: 'nav.stores' }`; `app-shell.tsx` adds `stores`, `stores-accept` and `stores-issue` to the view union, BaseView, BASE_VIEW_ENTRY and VIEW_NAV_ENTRY (`:95-103`, `:130-164`); new `edge/app/stores/page.tsx` and `edge/app/stores/accept/page.tsx` render `<EdgeClient view=... />`; the existing bare page `edge/app/stores/issue/page.tsx` renders `<EdgeClient view="stores-issue" />` inside AppShell gated by its own existing entry `{ name: 'Stores issue', modules: ['warehouse'] }` (`edge.ts:380`, `nav-model.ts:24`) so a warehouse-write holder without receiving write keeps the page; a deep link without the entry renders the no-access card with no list fetch

**Given** Task 0 server work
**When** it lands
**Then** `GET /api/v1/receiving/arrivals?site=<site_code_ext>` exists under module receiving read with `RECEIVING_READ_ROLES` (`src/api/v1/receiving.ts:39-44`) and the receiving site scope, returning the site's open gate events (`gate_event_id`, `challan_number_ext`, `vehicle_reg_ext`, `driver_name`, `challan_photo_ref`, `entered_at`, `binding_status`, `po_summary`, `supplier_ref_ext`, `binding_token`) joined with `has_accepted_weighment` (a `weighbridge_event` with status accepted on the `correlation_id`) and `grn_id` (grn `correlation_id` match), oldest first, because `store_assistant` cannot read gate or weighbridge events (`src/api/v1/gate.ts:33`, `src/api/v1/weighbridge.ts:32-36`, access matrix :195-196); the access matrix gains an R for `store_assistant` on this read; one active non-quarantine inspection bay location (level zone, zone_type staging, code IB-01 or site-prefixed) is registered per pilot site through the location-register path, added to `deploy/rehearsal/mock/setup-operations.ts` and exposed to the edge by the bootstrap or a site-config read (`LOCATION_NOT_FOUND` at `src/compliance/receiving.ts:1124-1134` otherwise)

**Given** the device is online
**When** the inbox loads
**Then** it shows the four groups of mock key-stores.html L480 in order: Arrived - awaiting acceptance (arrivals rows with `grn_id` null, oldest first; matched cards carry Start acceptance; unmatched cards are pilled Match supplier with Start acceptance disabled and the reason shown, mock L443 and L484, EXPERIENCE.md:82; a matched card with `has_accepted_weighment` false is pilled Waiting for weighbridge with Start acceptance disabled and the reason shown, recorded in Dev Notes as the server-forced deviation from mock L441 because receipt needs an accepted weighment at `src/compliance/receiving.ts:840-865`), Cleared by QC - put away (`GET /api/v1/putaway-tasks?site=<site location_id>&status=ready`, `src/server.ts:805`; cards open the 3.15 putaway detail and until 3.15 ships are disabled stating `Putaway arrives with Story 3.15`; tasks whose GRN line has no QC clearance carry the caveat pill Awaiting QC until 8.10 gates them, because every GOOD line is ready at receipt, `receiving.ts:1155`), Issues pending (`GET /api/v1/indents?issuable=true`, cards open the stores-issue view; shown only when both entries are present) and Returns to shelve (empty statement only); each card is a DESIGN.md:266 inbox card with a text status pill and one primary action; every empty group reads `Nothing waiting` (mock L611); below the groups a Done today section appears only when something was completed today (mock L614-621): GRNs captured on this device from the outbox (pilled Captured - pending sync or Synced) merged with `GET /api/v1/grns?site=&status=posted` filtered to today, plus issue slips completed in the stores-issue view

**Given** the Scan anything bar (new shared ScanAnythingBar over the 3.13 ScanField, pinned on top, always armed, Type it always available, EXPERIENCE.md:77-78, DESIGN.md:262)
**When** a code is scanned or typed
**Then** a challan number matching an open matched gate event opens its acceptance (mock L952); a challan already accepted today opens its Done today card (mock L951); a lot QR opens a one-action sheet offering Report damage into `/damage/new` with the lot prefilled (Issue, Return and Move from mock L764-768 are deferred and the sheet says so); any other code gets the aria-live statement `Not recognised: <code>. Scan or type a challan or lot code.`; rack and item result sheets are out of scope and are not promised by the copy

**Given** an Arrived card with an accepted weighment
**When** the acceptance renders
**Then** the header carries challan, supplier, PO, vehicle, arrival time and gate photo with nothing retyped; a banner names the site inspection bay destination; PO lines and band fields come from `GET /api/v1/erp/purchase-orders/:poNumber` (`src/server.ts:769`, `src/api/v1/erp-projections.ts:424-427`; `over_receipt_tolerance_pct` at `src/read/projections/erp_purchase_order.ts:87`); every open PO line shows ordered, a counted stepper with `= ordered` as a quick count (mock L634) and a chip Not counted, Matches PO, Short n or Excess n; the client caps the posted GOOD quantity to ordered x (1 + `over_receipt_tolerance_pct` / 100) minus cumulative received on the PO line (GOOD and DAMAGED count, REJECTED does not, `src/compliance/receiving.ts:755-770`, `:820-825`), rounded down to the line unit precision, and shows the excess as `Excess - returned with vehicle` (not posted); a short line requires one of the four fixed tiles Supplier short-shipped, Part delivery - balance to follow, Count mismatch with challan, Other (mock L437, `RECEIPT_REASON_DETAILS['SHORT']` plus OTHER, `src/compliance/receiving-reasons.ts:14-22`), Other requiring a photo and a one-line note; each PO line carries condition quantities Good / Damaged / Rejected whose sum is the counted quantity (EXPERIENCE.md:151), Damaged and Rejected opening their detail tiles from `RECEIPT_REASON_DETAILS`; one material photo is required and travels as the new additive `material_photo_ref` (Task 1); the Inspect on opening toggle offers Damage suspected or Damage observed with an optional photo and the helper `A note for the inspector, not a verdict. QC and finance decide.` (mock L654-659); Complete acceptance stays disabled stating what is left

**Given** a complete acceptance online
**When** Complete acceptance is tapped
**Then** each PO line posts one `goods.received` per non-zero condition quantity to `POST /api/v1/grn-lines` (`src/server.ts:798`) on a shared client `grn_id`, `grn_line_id` per row, `correlation_id` equal to the binding token, `target_location_code` equal to the site inspection bay for GOOD rows (DAMAGED and REJECTED rows carry the same field but the server routes them to the site ZONE-QC-HOLD with a held putaway task, `src/compliance/receiving.ts:1109-1122`, and the completion screen pills them In QC hold), DAMAGED and REJECTED rows before the GOOD row of the same PO line, and the Story 3.11 fields; there is no Split line control; a unit test asserts the posted quantity never exceeds the band; permanent codes render `errors.*` copy (`edge/src/sync/connector.ts:84-97`) and the line stays editable; the completion screen shows the GRN number and summary pills and Done today gains the GRN

**Given** an acceptance opened online while the device then goes offline
**When** it is completed
**Then** every line envelope and its photos go to the outbox and `pendingPhotoStore`, the screen reads `Captured - pending sync`, upload goes through `POST /api/v1/edge/events` with `received_by` server-set (`src/api/v1/edge.ts:669-671`), a refusal lands in Refused captures, and the inbox lists show the needs-connection card rather than a stale list (owner question Q7; mock L517 renders the inbox offline and the deviation is logged)

**Given** Task 1 server work
**When** `goods.received` carries the optional fields `inspect_on_opening` (suspected or observed), `inspect_note`, `inspect_photo_ref` and `material_photo_ref`
**Then** they persist on `grn_line` following the Story 3.11 additive pattern: a new ALTER-only file `read/projections/grn_line_inspect.sql` appended in `src/events/migrate.ts` after `grn_line_condition.sql` (`:328-330`; `grn_line.sql` is not edited), typed in `src/events/schema.ts:455-466`, asserted in `assertReceiptReasonShape` (`inspect_note` and `inspect_photo_ref` allowed only with `inspect_on_opening`), mirrored verbatim at the tail of `deploy/compose/init-db.sql` (after `:15058`) and pinned by name in `test/unit/schema-drift.test.ts` beside `:2705-2715`; `GET /api/v1/grns/:grnId` returns them per line (`src/read/projections/grn_line.ts:157`) for the 8.11 QC detail; `listDiscrepancyLines` (`grn_line.ts:172`) is unchanged because a flag is a note for the inspector, not a discrepancy (EXPERIENCE.md:84)

**Given** the inbox, acceptance and completion screens
**When** axe, the i18n literal guard and a keyboard-only pass run
**Then** zero WCAG 2.1 AA violations, all strings under `stores.*`, 56/48/34 px targets, primary pinned in the bottom third on Handheld, aria-live for scan and sync results, and the staging runbook row 2.10m accepts one short, one damaged and one capped line as store1@ and `GET /api/v1/receiving/discrepancies` lists them

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes audit gaps G03, G04 (acceptance half), G11 (re-homes `/stores/issue`) and part of G21 (challan and lot codes only; the GRN label QR moves to 3.15). Depends on 3.13 (binding token, ScanField) and on 3.4, 3.11, 3.12, 3.1, 1.14, 1.15, 4.11 (done). Owns ScanAnythingBar and the grouped inbox list reused by 3.15, 3.16 and 8.11. Size L.

---

### Story 3.15: Directed Putaway Task Screen, Label Queue and GRN Read Card

As a storekeeper (`store_assistant`) on the edge PWA,
I want a putaway list with the suggested rack per ready lot, rack-scan confirmation with an override reason, plus a device-local label queue and GRN read card,
So that UJ-PUT-01 step 5 completes on a device and every lot's real location and label are recorded.

**Acceptance Criteria:**

**Given** a caller whose bootstrap carries the `Stores` entry created by Story 3.14
**When** the stores inbox loads
**Then** ready putaway tasks render as the inbox group Cleared by QC - put away (heading `putaway.group`) and each card opens the detail view `putaway-task` at `/stores/putaway?task=<taskId>` (the edge app has no dynamic route segments, cf. `edge/app/damage/cases/page.tsx`), an AppShell view gated by the same `Stores` entry (`edge/src/components/app-shell.tsx:130-152` BaseView and BASE_VIEW_ENTRY, view unions at `app-shell.tsx:95-104` and `edge-client.tsx:214-227`); no new NAVIGATION_CAPABILITIES row is added (EXPERIENCE.md:79, :134; mock key-stores.html L423, L430, L432); a deep link without the entry shows the existing no-access card; `edge/test/unit/i18n-literals.test.ts` ALLOWED_LITERAL_PATTERNS gains `putaway.` and `labels.`

**Given** ready tasks at the site
**When** the group loads online
**Then** `GET /api/v1/putaway-tasks?site=<site location_id>&status=ready` (`src/server.ts:805`; `src/api/v1/putaway.ts:149-176` returns `{ tasks }` with `sku`, `lot_id`, `quantity`, `from_location_id`, `directed_location_code`, `velocity_class_at_suggestion`, `src/read/projections/putaway_task.ts:11-43`) renders one inbox card per task showing sku and item name (`GET /api/v1/items/:sku`, `src/server.ts:601`, cached per sku), `lot_id`, `quantity`, the source bay code (`GET /api/v1/locations/:locationId`, `:627`, cached per id) and a `Suggested <code>` pill only when `directed_location_code` is non-null (the list makes no per-task suggestion calls; the column is set by the suggestion route, `putaway.ts:233-248`); the empty group states `Nothing waiting` (mock L611); copy never says a lot is QC-cleared until 8.10 gates held lots, and Dev Notes record that GOOD lines are ready at receipt (`src/compliance/receiving.ts:1155`)

**Given** a task is opened
**When** the detail loads
**Then** `GET /api/v1/putaway-tasks/:id` (`src/server.ts:806`, PUTAWAY_READ_ROLES `putaway.ts:33-38`) renders the task header, and for a `store_assistant` `GET /api/v1/putaway-tasks/:id/suggestion` (`:807`, PUTAWAY_EXECUTE_ROLES `putaway.ts:39`, `:207-208`) drives the card `Suggested: <locationCode>` with a plain-words caption from `putaway.classHint.<A|B|C>`, a pinned primary `Use suggested <code>` and a secondary `Choose another rack` opening scan-or-type of a rack code (alternatives list deferred); a `{ locationId: null, reason }` response (`src/warehouse/putaway-suggestion.ts:18-21`) shows the reason as the caption and only `Choose another rack`; a 403 `FUNCTION_ACCESS_DENIED` on the suggestion route (`putaway.ts:105-124`) renders the detail read-only with `errors.FUNCTION_ACCESS_DENIED` (`en.json:107`) in place of both actions; the detail always calls the suggestion route before offering completion so the server override rule applies (`src/compliance/putaway.ts:208` keys on `directed_location_id`)

**Given** the target rack is set
**When** a rack code is scanned or typed into the ScanField and equals the target
**Then** `POST /api/v1/putaway-tasks/:id/complete` (`src/server.ts:808`) is sent with `actual_location_code` and a client-minted `idempotency_key`; when the code differs from the directed suggestion the client shows a reason step of fixed tiles whose codes are client-defined under `putaway.overrideReason.*` (RACK_FULL, DAMAGED_RACK, NEARER_BAY, OPERATOR_CHOICE, OTHER; the server validates presence only, `src/compliance/putaway.ts:205-214`; `deploy/rehearsal/mock/operations-smoke.ts:206` aligned) plus a `Certain | Uncertain` choice sent as `override_confidence`; no free text is collected because the payload has no field for it (`src/api/v1/putaway.ts:330-337`); `replayed: true` renders the same done state; every code the completion and suggestion paths can return has an `en.json` string: `PUTAWAY_TASK_REQUIRED`, `PUTAWAY_LOCATION_REQUIRED`, `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED`, `PUTAWAY_TASK_NOT_READY`, `PUTAWAY_TASK_ALREADY_COMPLETED`, `PUTAWAY_LOCATION_NOT_FOUND`, `PUTAWAY_OVERRIDE_REASON_REQUIRED` (`src/compliance/putaway.ts:25-213`), `PUTAWAY_COMPLETION_EVENT_MISSING` (`src/api/v1/putaway.ts:291-293`), with `PUTAWAY_TASK_NOT_FOUND`, `PUTAWAY_TASK_NOT_HELD`, `PUTAWAY_DESTINATION_INVALID`, `PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED` (`en.json:162-165`), `LOCATION_ACCESS_DENIED` (`en.json:109`, thrown at `src/api/v1/putaway.ts:142`, `:167`) and `FUNCTION_ACCESS_DENIED` already present; `PUTAWAY_OVERRIDE_REASON_REQUIRED` and `PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED` reopen the reason step

**Given** a GRN completed by 3.14 (synced or pending)
**When** the label queue renders on the completion screen and the Done today card
**Then** one label per GRN line is queued in a device-local IndexedDB store (plain IndexedDB like `edge/src/local-db/pending-photos.ts:1-25`) keyed by `grn_line_id` with status `queued` or `printed`, text for GRN number, lot, PO line, sku and item name, bay code and `received_qty` (`GrnLine`, `src/read/projections/grn_line.ts:21-51`; `GET /api/v1/grns/:grnId` returns `{ ...grn, lines }`, `src/api/v1/receiving.ts:488-502`), a QR encoding `/stores/grn?grn=<grnId>&line=<grnLineId>` (small pure-JS QR dependency recorded in the story), a pill reading `Queued` until `window.print` has run for that label and `Printed` after `afterprint`, or `Queued - printer not ready` when `window.print` is unavailable (mock L698), and a Reprint action; printing uses the Story 4.11 print-only stylesheet precedent (`edge/src/components/stores-issue.tsx:41`, `:175`) and never blocks completion; the queue survives reload and reopens from the Done today card (mock L616-619); `edge/app/stores/grn/page.tsx` renders a read card over `GET /api/v1/grns/:grnId` (`src/server.ts:799`; module receiving read, `src/api/v1/receiving.ts:649-652`) showing GRN number, supplier, site, received date and per line sku, qty, condition and lot, highlighting the line named by `?line=`; a 403 renders the no-access card with the reason

**Given** the device is offline
**When** the putaway group or a detail opens or a completion is attempted
**Then** the group shows the needs-connection card with `Check connection` (pattern `en.json:599-600`) and the primary is disabled with the reason `Putaway needs a connection on this device for now` (EXPERIENCE.md:122); nothing is written to the outbox; this is a recorded deviation from EXPERIENCE.md:99, mock L444 and L717 and Story 3.5 AC 5; in-story task: add an explicit 403 `CENTRAL_ONLY_OPERATION` refusal for stream warehouse with event `putaway.completed` or `location.override` on the edge door in the shape of `assertEdgeIndentIssueEventRefused` (`src/api/v1/edge.ts:555`), with a test, because the door today accepts `putaway.completed` with `completed_by` taken unstamped from the device payload and no execute-role gate (`edge.ts:353`, `src/events/store.ts:701`, `:1029-1040`); deferred-work.md gets the section named in the proposal

**Given** the pages
**When** axe, the i18n guard and a keyboard-only pass run
**Then** zero WCAG 2.1 AA violations at `/stores/putaway?task=<id>` and `/stores/grn?grn=<id>`, strings under `putaway.*` and `labels.*`, 56/48 px targets on coarse pointer and 34 px on desktop, aria-live for suggestion, scan match and completion, an accessibility spec at `edge/test/accessibility/stores-putaway-accessibility.spec.ts` and an e2e spec at `edge/test/e2e/stores-putaway.spec.ts`

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes audit gap G05 and the label queue residual of G04. Depends on 3.14 (stores inbox, completion screen) and 8.10 (release of held lots to ready), and on 3.5, 3.4, 1.14, 1.15, 4.11 (done). Story 3.5 record is reconciled by this story's create-story (Tasks 1 to 7 and 9 ticked with a note; Task 8 stays unticked). Size M.

---

### Story 3.16: Floor Task Inbox and Pick Execution Screen

As a picker (`warehouse_operator`, picker1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:401-413`),
I want a task inbox that opens each pick list one line at a time (scan bin, scan lot, confirm quantity), offline if needed,
So that Story 3.6 pick tasks are executed from the device instead of a paper list.

**Acceptance Criteria:**

**Given** a caller with warehouse write at the site
**When** the bootstrap runs
**Then** navigation carries `Floor tasks` from a new row `{ name: 'Floor tasks', modules: ['warehouse'], functionScope: 'write' }` (`src/api/v1/edge.ts:364-383`, precedent `Stores issue` at `:380`) with NAV_ENTRIES `{ name: 'Floor tasks', href: '/floor/tasks', label: 'nav.floorTasks' }` and `nav.floorTasks` in `en.json` beside `nav.storesIssue`; `floor-tasks` joins BaseView and BASE_VIEW_ENTRY so a deep link without the entry renders the no-access card with no fetch; `store_assistant` also holds warehouse write (`roles.json:332-335`) and is in PICK_READ_ROLES (`src/api/v1/pick-tasks.ts:39-44`), so it sees and can use the screen (accepted; access matrix :54 scopes it to putaway and counts)

**Given** `/floor/tasks` online
**When** the inbox loads `GET /api/v1/pick-tasks?site=<site>&status=pending` and `GET /api/v1/pick-tasks?site=<site>&status=in_progress` (one status per request, `src/api/v1/pick-tasks.ts:282`; `src/read/projections/pick_task.ts:265`) merged client-side
**Then** one group headed `Pick lists - sales orders` (mock key-floor.html L617) lists tasks whose `assigned_to` equals the bootstrap `user_id` (`src/api/v1/edge.ts:453`) first, then tasks with `assigned_to` null at the site, both actionable (no assignment check exists in `src/compliance/pick.ts`; assign is PICK_SUPERVISE_ROLES only, `pick-tasks.ts:359`), tasks assigned to someone else hidden; each inbox card shows the task id, the sales order number, `n of m picked` and a text pill (`In progress` or `Pending`) from the Task 1 list fields; the empty state reads `All caught up`; offline the last fetched list shows with `Showing the list from <time>`

**Given** Task 1 server work
**When** `GET /api/v1/pick-tasks/:pickTaskId` (`src/server.ts:1416`) and `GET /api/v1/pick-tasks` (`:1415`) are called
**Then** each line also carries `location_code`, `directed_lot_number` and `uom` joined from `location_register`, `lot_master` and `item_master` (today `src/read/projections/pick_line.ts:62-66` returns IDs only; `item_master` has no description column so none is promised), and each list row carries `so_number_ext` (joined from `erp_sales_order` via `dispatch_order_id`, `read/projections/erp_sales_order.sql:21`), `confirmed_line_count` and `line_count` (`src/read/projections/pick_task.ts:272-274`, same FILTER predicates as `pick.ts:828-832`), with integration tests for both

**Given** the current line
**When** the picker scans or types bin then lot in the ScanField
**Then** a wrong bin shows `Wrong bin - <code>` and stays on step 1, a matching bin advances, the directed lot advances with the quantity prefilled, a lot whose `lot_number` is present in the synced `held_lot` table with `quality_hold_status` held (`edge/src/local-db/schema.ts:191-203`; `getHeldLot` and `assertLotNotHeld`, `edge/src/capture/held-lot.ts:22`, `:35`) shows `On hold - awaiting QC` and does not advance, online or offline (mock L918, L461), a different unheld lot shows `Wrong lot - not picked` naming the directed lot and stays on step 2 (mock L919, L467; lot substitution with override reason, Story 3.6 AC 8, is an exception flow in Story 3.17); the three-step indicator exposes `aria-current="step"`

**Given** step 3 with the quantity equal to directed
**When** Confirm is tapped
**Then** one `pick_line.confirmed` event (stream warehouse, payload `{ pick_task_id, pick_line_id, confirmed_lot_id, confirmed_quantity, capture_method: 'PWA' }` per `src/compliance/pick.ts:136-153`; `confirmed_by` stamped server-side at `src/api/v1/edge.ts:674-676`) is written with `insertCaptureEvent` (`edge/src/local-db/outbox.ts:42`), the screen advances, the line reads Synced or `Captured - pending sync`, and a `PICK_*`, `LOT_ON_HOLD` or `INSUFFICIENT_STOCK_FOR_PICK` refusal (`edge/src/sync/connector.ts:119-129`, `:141`; strings at `en.json:86`, `:179-189`) lands in Refused captures with its `errors.*` text; the quantity field is read-only at the directed quantity and the mock's `Short pick` secondary (L713, L719) renders disabled with the reason `Short pick comes in a later release - leave the line open and tell your supervisor` (EXPERIENCE.md:122)

**Given** the last outstanding line
**When** its `pick_line.confirmed` event is accepted
**Then** the server finalizes the task inline (`src/compliance/pick.ts:612-628`; no `pick_task.completed` is sent by the picker because that command is SOD-gated to `warehouse_manager` and `inventory_controller`, `pick.ts:29`, `:808-821`), the screen shows a completion panel with task id, order, line count, the line `All lines picked` and Back to tasks once the last line reads Synced (or `Captured - pending sync` while offline), and a `LOT_ON_HOLD`, `INSUFFICIENT_STOCK_FOR_PICK` or `PICK_LINE_ALREADY_CONFIRMED` refusal of that last confirm renders from `errors.*` in Refused captures and reloads the task; the task leaves the inbox once the list returns it as completed

**Given** the four device classes (EXPERIENCE.md:135 plus mock L450-454)
**When** the screen renders and axe plus a keyboard-only pass run
**Then** Handheld shows one page at a time with the primary pinned at 56 px, Tablet and Desktop show inbox and task side by side, no horizontal scroll at 360 px, zero WCAG 2.1 AA violations, strings under `floor.*`, and after each confirm the result and the next instruction are announced through the aria-live region (EXPERIENCE.md:119) while the scan field stays focused and armed (EXPERIENCE.md:74)

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes the picker leg of audit gap G08. Depends on 3.13 (ScanField, outbox-with-refusal pattern) and on 3.6, 1.13, 1.14, 1.15 (done) and edge Phase 1 (563d246). Before build: one validation walk with picker1@ on the staging preview (EXPERIENCE.md:262) or the owner's recorded waiver. Dev Notes record that `pick_task` is one SKU per task (`src/read/projections/pick_task.ts:85`) so the mock's five-item list is illustrative, and that the mock groups `Pick lists - production issue` and `Moves` have no backend. Size L.

---

### Story 3.17: Short Pick Exception Seam and Tiles

As a picker,
I want to record a short pick with a reason (Bin empty, Less in bin than shown, Damaged - report, Other) instead of leaving the line open,
So that the shortfall is durable, planning sees the re-pick and damaged units go on hold.

**Acceptance Criteria:**

**Given** a pick line in progress
**When** `pick_line.short_picked` is uploaded with `found_quantity` where 0 <= found < directed (at most 3 decimals), reason BIN_EMPTY, LESS_IN_BIN, DAMAGED or OTHER and a one-line note (required for OTHER, refused otherwise)
**Then** the event is registered in SUPPORTED_EVENT_TYPES beside `pick_line.confirmed` (`src/events/schema.ts:5867-5874`, stream warehouse), the line moves to a new status `short` added to `chk_pick_line_status` (`deploy/compose/init-db.sql:2827`, `read/projections/pick_line.sql`) and counted as resolved by the inline finalization counter (`src/compliance/pick.ts:619`) and the explicit gate (`:830-838`), its unpicked remainder allocation is released, the seam writes a `pick_shortfall` row (task, line, directed, found, reason, note, actor, occurred_at), DAMAGED opens a damage case in `in_qc_hold` for the short units through a photo-less in-transaction opener modelled on `openReceiptDamageCase` (`src/compliance/damage.ts:1865-1890`; source `pick` added to the source CHECK and pairing constraints at `read/projections/damage_report.sql:94-96` and the union at `src/read/projections/damage_report.ts:26`, `:187`) so no photo or damage-reason UI is added, the edge door server-sets `short_picked_by` (`src/api/v1/edge.ts:674-679` pattern), and `PICK_SHORT_REASON_REQUIRED`, `PICK_SHORT_QUANTITY_INVALID` and `PICK_SHORT_NOTE_REQUIRED` are twinned in `src/sync/upload.ts` and `edge/src/sync/connector.ts` PERMANENT_ERROR_CODES (`test/unit/edge-permanent-error-parity.test.ts`) with `errors.*` strings in `edge/src/messages/en.json:179-189`

**Given** a task whose remaining lines are confirmed or short
**When** the last line resolves (`src/compliance/pick.ts:612-629`) or `pick_task.completed` is applied (`:776-846`)
**Then** `finalizePickTaskCompletion` runs, the allocated-to-picked move (`:655-709`) uses `found_quantity` for short lines, the `dispatch_order_status` row (`init-db.sql:2785-2789`, insert at `pick.ts:748-756`) is still written so Story 3.7 packing proceeds for the picked units (owner question Q15), one notification per task targets the planning role at the task site (`src/notify/emit.ts:6-16` role plus `location_id`; default `production_planner`, owner question Q14) listing each short line, found of directed and reason, and the existing `warehouse_manager` packing notification (`:711-724`) still fires; this replaces the data-loss path described at `pick.ts:466-471`

**Given** the 3.16 pick line screen
**When** Short pick is tapped on step 2 (lot) or step 3 (quantity)
**Then** the Picked stepper (min 0, max directed) and four tiles labelled `Bin empty`, `Less in bin than shown`, `Damaged - report`, `Other` appear under `Short <directed minus found> - choose a reason` (mock key-floor.html L521, L688-700); Bin empty sets found to 0 (L969); raising found back to directed clears the short state (L967); the Short pick button leaves the footer while short (L721); the footer reads `Left: short reason` until a tile is pressed and `Left: one line` while Other has an empty note (L720), then `Ready`; the primary reads `Confirm short pick - <found> of <directed>` and stays disabled until a reason is chosen and, for Other, the note is non-empty (L670-671); `Damaged - report` shows the note `The damaged units go on hold and a QC task is raised. You only report; QC and finance decide.` (L697); confirm queues `pick_line.short_picked` to the outbox with the 3.16 `Captured - pending sync` treatment and the All lines list shows a warn pill `Short <n>` (L706); the completion panel adds a warn pill `<k> short` and the sentence `Short lines go back to planning for a re-pick.` (L729-730); no photo capture is added on this screen

**Given** a different unheld lot at step 2 (Story 3.6 AC 8 substitution)
**When** the picker chooses `Use this lot instead` from the `Wrong lot - not picked` state
**Then** a reason tile step renders and the confirm carries `override_reason` on `pick_line.confirmed` (`src/compliance/pick.ts:502-512`, `PICK_OVERRIDE_REASON_REQUIRED` otherwise), `INSUFFICIENT_STOCK_FOR_PICK` (`:562-572`) renders from `errors.*`, and Dev Notes record that the mock has no substitution flow (key-floor.html L467) so the control is the spine's exception path

**Given** the suite
**When** `test/integration/story-3-17.test.ts`, the 3.16 edge unit file and the 3.16 e2e spec run
**Then** they pass and the 3.16 disabled Short pick control is replaced by the live control

**Note:** PILOT. Source: `sprint-change-proposal-2026-10-21.md`. Closes the short-pick residual of audit gap G08. Depends on 3.16 and on 3.6, 8.9 (done). Role gate: `warehouse_operator` and `store_assistant` (`src/api/v1/edge.ts:75-78`); no new nav row. Picking layouts and the four reasons are mockup assumptions (key-floor.html L467-468) due for validation on the staging preview (EXPERIENCE.md:262); the story builds the drafted layout and records user changes as follow-ups. Size M-L.

---

### Story 3.18: Pack Station and Dispatch Screen

As a dispatch clerk (dispatch1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:576-589`),
I want a pack station screen that lists picked orders, scans lots into the package, records weight, generates documents, clears the IRN block, prints and confirms dispatch,
So that a dispatch leaves the site through the Story 3.7 and 11.2 gates from the app.

**Acceptance Criteria:**

**Given** EXPERIENCE.md:262 and key-floor.html L463 mark the pack and dispatch layout as not elicited
**When** the story starts
**Then** the layout is walked with dispatch1@ on the staging preview and the outcome recorded in the story file before build, or the owner's waiver is recorded as a ruling (audit :467)

**Given** a caller holding an assignment with role in `DISPATCH_WRITE_ROLES` (`src/api/v1/dispatch.ts:43`: `dispatch_clerk`, `warehouse_manager`), module warehouse or `*`, `functionScope` write, covering the site
**When** the bootstrap runs
**Then** navigation carries `Pack and dispatch` from a new row `{ name: 'Pack and dispatch', modules: 'pack-dispatch', functionScope: 'write' }` with `pack-dispatch` added to the modules union (`src/api/v1/edge.ts:364-368`) and a `hasPackDispatchScope` branch in `navigationFor` (`:400-420`) modelled on `hasDamageCaseScope` (`:389-398`); dispatch1@ (`roles.json:576-582`) receives it, store1@ and a `dispatch_clerk` holding only inventory read (`roles.json:583-589`) do not; NAV_ENTRIES gains `{ name: 'Pack and dispatch', href: '/floor/pack', label: 'nav.packDispatch' }`; `pack-dispatch` joins BaseView and BASE_VIEW_ENTRY so a deep link without the entry renders the no-access card; an integration test asserts both outcomes; the mock's desktop sidebar label `Dispatch` (key-floor.html L567) and bottom nav Tasks / Scan / Stock / More (L557-562) are recorded as an accepted deviation

**Given** Task 1 server work
**When** `GET /api/v1/dispatch?site=<uuid>&stage=picked|packed|documents_generated|dispatched` is called
**Then** it returns rows from `dispatch_order_status` joined to `erp_sales_order` (`src/read/projections/dispatch_order_status.ts:19-25`) filtered by `ship_from_site_id`, left joined to `dispatch_irn` (`src/read/projections/dispatch_irn.ts:13-25`) exposing `irn_recorded`, with stage derived as dispatched when `dispatched_at` is set, documents_generated when a `dispatch_document` row exists (`src/read/projections/dispatch_document.ts:27`) and `dispatched_at` is null, packed when `packed_at` is set and no documents, else picked; each row carries `dispatch_order_id`, `so_number_ext`, `line_no`, `ship_to_ext`, `sku`, `quantity`, `picked_at`, `packed_at`, `dispatched_at`, `stage`, `irn_recorded`; the route is gated by `assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read')` (`src/api/v1/dispatch.ts:45-51`, `:86-104`) and `permittedLocationsForModuleScope(roles, 'warehouse', 'read')` (`:110-115`), registered before the `/:dispatchOrderId` routes in `src/server.ts:1423-1437`, added to the spine allowlist (`test/integration/story-1-9.test.ts:335-346`) and covered by an integration test; today only per-id reads exist

**Given** the list
**When** it loads online
**Then** three groups render: Ready to pack (stage picked), Waiting for documents (stages packed and documents_generated, pilled Cannot dispatch when `irn_recorded` is false and Ready when true) and Dispatched today; the empty state reads `Nothing to pack or dispatch. Picked orders appear here when the picker finishes.` (key-floor.html L646); each row heading is the SO number with `ship_to_ext` as metadata (deviates from the mock PKG heading at L629 and L738 because no package id is minted, owner question Q19); a row opens the pack station

**Given** an order from Ready to pack
**When** each picked lot is scanned or typed into the focused ScanField and the carton weight is entered
**Then** lines flip to In package with aria-live, an unknown lot is refused in place, Generate shipping documents stays disabled stating what is left, and pressing it posts `POST /api/v1/dispatch/:id/pack` with one `packingLines` entry per picked line `{ sku, packed_qty (string), lot_id (UUID or null), carton_count: 1 on the first line and 0 on the others, actual_weight_kg: the carton weight on the first line and null on the others, label_ref: null }` (`src/api/v1/dispatch.ts:173-257`) then `POST /api/v1/dispatch/:id/generate-documents` with no body so the server default document types apply (`dispatch.ts:37`, `:387`); `LOT_ON_HOLD`, `PACKED_QTY_MISMATCH`, `PACKED_LINE_NOT_PICKED`, `DISPATCH_ORDER_NOT_PICKED` and `INVALID_PARAMS` render from `errors.*` (`en.json:190-200`)

**Given** documents exist and `POST /dispatch` answers 409 `IRN_MISSING` (`src/compliance/dispatch.ts:613-645`)
**When** the order renders
**Then** a blocked card in the err pair reads `E-invoice IRN missing - cannot dispatch` with the package summary and Check IRN again calling `GET /api/v1/dispatch/:id/irn`, treating 404 `DISPATCH_IRN_NOT_RECORDED` (`dispatch.ts:756-762`) as still blocked and 200 `{ dispatchOrderId, coverage }` (`:764`) as cleared (key-floor.html L757-767, EXPERIENCE.md:103); Park at dispatch bay renders disabled stating no bay record exists for pilot (recorded in deferred-work.md); a Record IRN form posts `{ invoice_number_ext, irn_ext (64 hex), idempotency_key minted once per opened form }` to `POST /api/v1/dispatch/:id/irn` (`dispatch.ts:598`, `:627-656`; owner question Q16, default yes); when `details.reason` is `no_erp_sales_order_line` the form is hidden and the card says the order is not an ERP line; the sentence about automatic billing notification is not shown (nothing in `src/` notifies billing; record fix amends EXPERIENCE.md:103); `DISPATCH_IRN_CONFLICT`, `DISPATCH_IRN_INVALID_PAYLOAD`, `DISPATCH_ORDER_SITE_MISMATCH` and `DISPATCH_ORDER_CLOSED` render from `errors.*` (`en.json:216-220`)

**Given** IRN coverage exists
**When** the order opens
**Then** every document in `GET /api/v1/dispatch/:id/documents` (`{ dispatchOrderId, documents }`, `dispatch.ts:502`; types bol, packing_slip, commercial_invoice, label, labelled under `packStation.doc.*`) has a Print action rendering `document_content` under a print-only stylesheet twin of `stores-issue.tsx:41` scoped to the document container, a document whose `document_content` is null shows Print disabled stating no content, the mock's E-way bill row (L770) is not rendered and is recorded in deferred-work.md, Confirm dispatch posts `POST /api/v1/dispatch/:id/dispatch`, and on 200 the order moves to Dispatched today; `DISPATCH_ORDER_NOT_PACKED`, `DISPATCH_DOCUMENTS_NOT_GENERATED`, `DISPATCH_ORDER_ALREADY_DISPATCHED` and `LOT_ON_HOLD` render from `errors.*`

**Given** the device is offline
**When** the screen opens
**Then** the list renders read-only from the last successful fetch with its sync badge, and Generate shipping documents, Check IRN again, Record IRN and Confirm dispatch are disabled stating `needs a connection` (EXPERIENCE.md:119); nothing is written to the outbox; this is a deliberate pilot departure from EXPERIENCE.md:99 and key-floor.html L464 and from the server door that already accepts `dispatch.packed`, `dispatch.shipping_documents_generated` and `dispatch.dispatched` (`src/api/v1/edge.ts:686-701`, Story 3.7 Tasks 7.1 to 7.3; codes at `edge/src/sync/connector.ts:131-149`), recorded in deferred-work.md and EXPERIENCE.md (owner question Q17)

**Given** the four device classes
**When** axe and a keyboard-only pass run
**Then** Handheld is one task page with Back and a pinned 56 px full-width primary (key-floor.html L452), Tablet is icon rail plus list and detail panes (L453), Desktop is sidebar plus two panes with 34 px controls and the scan hint `USB scanner or type` (L454, L456; EXPERIENCE.md:123), Desktop touch is the Desktop layout with 56/48 px controls (L455); the ScanField keeps focus after each accepted scan; zero WCAG 2.1 AA violations; strings under `packStation.*`; runbook row 2.10o is walked as dispatch1@ on staging

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes the pack and dispatch leg of audit gap G08 and Story 3.7 AC 1 (epics.md:1589-1591, packing station operator). Depends on 3.13 (ScanField, nav token pattern), 3.16 (picked orders, floor surface) and on 3.7, 11.2, 3.6, 1.15, 4.11 (done; the 3-7 story file still reads Status: review and is set to done by this story's create-story). Deferred: vehicle number on `dispatch.dispatched`, e-way bill document, scale integration, billing notification, park at bay, offline pack capture. Size L.

---

### Story 3.19: Unloading Exception Commands (server)

As an unloading supervisor (unload1@ancorlabs.org, `docs/migration/pilot-mock-extract/roles.json:346-366`),
I want server commands to match an unmatched gate event to a PO, accept an over-tolerance receipt at the band cap and send an unmatched vehicle to procurement, with a durable resolved state,
So that the 3.20 screen can resolve exceptions and the record shows who resolved what.

**Acceptance Criteria:**

**Given** an unmatched gate event (`binding_status` unmatched is written today when `po_ref_ext` is UNKNOWN or the PO is not open, `src/api/v1/gate.ts:211-214`, `src/compliance/gate.ts:123-132`)
**When** `POST /api/v1/gate-events/:id/match-po { po_ref_ext, note }` is called by `unloading_supervisor` at the site (access matrix :197 C) or `warehouse_manager` as the escalation approver (:197 A, owner question Q21), authorised by a role allowlist like `UNMATCHED_READ_ROLES` (`gate.ts:32`) because `store_assistant` also holds receiving write
**Then** a `gate.matched` event registered in `GATE_EVENT_TYPES` (`src/compliance/gate.ts:13`), the `src/events/schema.ts` union near `:377` and the registry near `:5830` is applied, refusing `GATE_EVENT_NOT_UNMATCHED` when `binding_status` is not unmatched or status is not open and `PO_NOT_OPEN` when `getPurchaseOrderByRef` (`src/read/projections/erp_purchase_order.ts`) returns no row or status is not open; `gate_event` gains nullable `resolved_by`, `resolved_at` and `match_note` by a guarded column upgrade of `read/projections/gate_event.sql`; `upsertGateEvent` (`src/read/projections/gate_event.ts:163-166`) no longer overwrites `binding_status` or `po_ref_ext` on a row already matched (replay guard, tested); today the only transition is reversal (`gate_event.ts:198`)

**Given** a GOOD `grn_line` rejected as over tolerance (`src/compliance/receiving.ts:1003-1061`)
**When** `POST /api/v1/grn-lines/:id/accept-within-band { note }` is called by the same roles at the site
**Then** one `goods.received` line posts on the same `grn_id` copying the rejected line's sku, lot, expiry, uom, stock class and `weighbridge_correlation_id` with `received_qty` equal to ordered x (1 + `over_receipt_tolerance_pct` / 100) minus cumulative non-rejected received (`readPoReceiptBand`, `receiving.ts:738-770`; EXPERIENCE.md:83) against the same PO line and binding token, posting stock and a putaway task through the existing seam; the rejected line keeps status `rejected` (the band at `:759-760` excludes it; `grn_line.status` is constrained to posted, quarantined, rejected at `read/projections/grn_line.sql:22`, `:42`) and gains nullable `resolved_by`, `resolved_at` and `resolution` (`accepted_within_band` or `sent_to_procurement`) by a guarded column upgrade; the returned excess (counted minus cap) is written on the `receiving_exception` row with reason code `EXCESS_RETURNED_WITH_VEHICLE`, added to `RECEIPT_REASON_CODES` (`src/compliance/receiving-reasons.ts:7`) as a resolution-only code that `createGrnLine` still refuses and to the 3-11 Reason Catalogue; no quantity above the cap is ever posted and no DOA band applies (the access matrix :394 band governs weighbridge load acceptance, which stays with the 3-12 deferred items); `GRN_LINE_NOT_REJECTED` and `GRN_LINE_ALREADY_RESOLVED` are refused; `Hold excess for buyer decision` is not built (EXPERIENCE.md:255, :263)

**Given** an unmatched gate event with no fitting open PO
**When** `POST /api/v1/gate-events/:id/send-to-procurement { note }` is called by the same roles at the site
**Then** a `receiving_exception` row (kind `unmatched_vehicle`, source `gate_event_id`, status `sent_to_procurement`, `resolved_by`, `resolved_at`, note) is written, the gate event stays unmatched and is excluded from the open inbox, and a notification targets `{ role: 'procurement_officer', location_id: siteId }` (precedent `src/compliance/supplier.ts:486`); the pilot pack (`deploy/rehearsal/mock/generate.mjs`, `roles.json`) gains a notification read grant for `procurement_officer` (indent1@, `roles.json:505-520` holds none today; `GET /api/v1/notifications` is gated on module notification read, `src/api/v1/notification.ts:394-396`) and the integration test proves the holder can read it; over-tolerance lines have no procurement route in this story (mock key-floor.html L803-812)

**Given** the bootstrap
**When** NAVIGATION_CAPABILITIES gains `{ name: 'Unloading exceptions', modules: 'unloading-exceptions', functionScope: 'read' }` with the modules union (`src/api/v1/edge.ts:364-368`) widened and a `navigationFor` branch calling `hasUnloadingExceptionScope` (role allowlist `unloading_supervisor`, `warehouse_manager` with `assignmentCoversLocation`)
**Then** `store_assistant` (receiving write, `roles.json:318-320`) does not receive it and an integration test (pattern `test/integration/story-8-9.test.ts:1571-1575`) proves both cases; the edge NAV_ENTRIES row and label are 3.20's

**Given** the routes
**When** `test/integration/story-3-19.test.ts` runs
**Then** every command is covered, the Story 1.9 `allowedSpineRoutes` list (`test/integration/story-1-9.test.ts:171`) gains every new route, a `receiving_exception` projection (kind, source id, status open, sent_to_procurement or resolved, resolved_by, resolved_at, note, excess fields) is pinned in schema-drift, and `GET /api/v1/receiving/exceptions?site=&status=open|sent_to_procurement|resolved` (default all; same roles; registered static-before-parameter next to `/api/v1/receiving/discrepancies`, `src/server.ts:801`) lists the rows with the band facts (ordered, already received, tolerance pct, cap, counted, excess) for over-tolerance kinds computed from the band SQL

**Note:** PILOT. Source: `sprint-change-proposal-2026-10-21.md`. Closes the server half of the unloading leg of audit gap G08. Depends on 3.2, 3.3, 3.4, 3.11, 3.12 (done); 3.13 is the pilot producer of unmatched entries but a soft dependency because integration tests seed them through `POST /api/v1/gate-events`. Weighbridge breach acceptance, escalation and acknowledgement UI (3-12 story :46 items (a), (b)) stay deferred. Size L.

---

### Story 3.20: Unloading Exceptions Screen

As an unloading supervisor,
I want one inbox of exceptions from gate and unloading with a detail page that resolves each in a single action,
So that a stuck truck or over-tolerance line is cleared from a screen with a visible Resolved record and the delivery moves to the stores inbox.

**Acceptance Criteria:**

**Given** a caller with the 3.19 `unloading-exceptions` scope
**When** the bootstrap runs
**Then** navigation carries `Unloading exceptions` at `/unloading/exceptions` with NAV_ENTRIES `{ name: 'Unloading exceptions', href: '/unloading/exceptions', label: 'nav.unloadingExceptions' }` (`edge/src/components/navigation/nav-model.ts:11-30`), `unloading-exceptions` joins BaseView and BASE_VIEW_ENTRY (`edge/src/components/app-shell.tsx:135-148`), and a deep link without it renders the no-access card

**Given** the page online
**When** the lists load
**Then** one group `Exceptions from gate and unloading` with a count, oldest first after a client merge-sort (only the gate unmatched list is server-ordered ascending, `src/api/v1/gate.ts:424-426`), is built from `GET /api/v1/gate-events?site=&binding=unmatched&status=open` (`gate.ts:365-454`; UNMATCHED_READ_ROLES includes `unloading_supervisor`, `:32`) and the 3.19 exceptions list filtered to status open; each row is a DESIGN.md inbox card with a text pill; `Resolved today` lists the 3.19 exceptions list with status resolved or sent_to_procurement for the current business date; the empty state reads `No open exceptions from gate or unloading. New ones appear here as trucks arrive.` (mock key-floor.html L646) with the scan bar still armed (EXPERIENCE.md:106); `GET /api/v1/receiving/discrepancies` is read-only context on the over-tolerance detail, never a source of inbox rows (it has no status filter, `src/api/v1/receiving.ts:545-572`)

**Given** a Vehicle not matched to any PO case
**When** it opens
**Then** the gate facts (`vehicle_reg_ext`, `driver_name`, `challan_number_ext`, `challan_photo_ref`, `entered_at` from `GET /api/v1/gate-events/:gateEventId`, `src/server.ts:787`) render; the PO picker is a typed or scanned PO number resolved through `GET /api/v1/erp/purchase-orders/:poNumber` (`src/server.ts:769`, module inventory read, `src/api/v1/erp-projections.ts:424-427`) showing supplier, open lines and due date (owner question Q24; `GET /api/v1/purchase-orders` is the native PO list under procurement read, `src/api/v1/purchase-orders.ts:617-620`, and is never called); the primary reads `Choose a PO to match` until one is selected, then `Match to <PO ref>`, and calls the 3.19 match-po command; the ghost action `No PO fits - hold vehicle, ask procurement` (mock L803) calls the 3.19 send-to-procurement command with an optional note

**Given** a Receipt over tolerance case
**When** it opens
**Then** PO line, ordered, already received, tolerance (`accept up to <cap>`) and counted at unloading are shown in that order from the 3.19 exception row, with the warn note `Excess <excess> - returned with vehicle`; the footer holds `Recount` (returns to the inbox without a write) and the primary `Accept <cap> - return <excess> with vehicle` calling the 3.19 accept-within-band command (mock L803-812); `Hold excess for buyer decision` is disabled with the pill `Post-pilot` (EXPERIENCE.md:255); the tolerance percent comes from the PO line, never a literal (mock L463); no above-band branch exists

**Given** the device is offline
**When** the page opens
**Then** the inbox shows the needs-connection card (pattern `edge/src/components/damage-cases.tsx:41`) with the scan bar still armed, and Match to PO, Accept within band and Ask procurement are disabled with the reason `Needs a connection - exceptions are resolved against live PO and GRN data`; no outbox write; because bootstrap navigation is not cached offline (deferred-work.md:1116) the header entry is absent offline and the card covers the deep-link and already-open cases; the deviation from mock key-floor.html L467 and L788 (offline resolve) is recorded in EXPERIENCE.md and deferred-work.md (owner question Q22)

**Given** the device classes
**When** axe and a keyboard-only pass run
**Then** handheld shows one page at a time (inbox, then detail with Back) with the primary full width and pinned in the bottom third; tablet, desktop and desktop-touch show list and detail side by side; density follows pointer, not class: coarse pointer uses 56 px primary and 48 px secondary, fine pointer uses 34 px controls (EXPERIENCE.md:97, :120; `edge/src/lib/use-device-class.ts:10-32`); a wedge or typed scan of vehicle, challan or PO into the ScanField (placeholder `USB scanner or type vehicle, challan or PO` on desktop, mock L589) opens the matching case; zero WCAG 2.1 AA violations; strings under `unloading.*`

**Note:** PILOT. Source: `sprint-change-proposal-2026-10-21.md`. Closes the edge half of the unloading leg of audit gap G08. Depends on 3.19, 3.13 (ScanField) and 3.14 (the matched delivery appears in the stores inbox automatically because 3.14 lists open matched gate events). Weighbridge breach rows are not rendered here (owner question Q23; EXPERIENCE.md:90 places the breach on the gate surface). The Unlisted supplier match-to-vendor flow (EXPERIENCE.md:85, mock L818-823) is deferred until 3.13's supplier fields are consumed by a vendor-match command. Size M.

---

## Epic 4: Procurement and Supplier Management

Procurement officers manage the full source-to-pay cycle from supplier registry through requisition, purchase order, goods receipt, and three-way invoice matching. Floor supervisors raise indents from a phone in under 90 seconds and always see live status (UJ-IND-01), with push notifications on every decision. Every purchase order carries DOA-gated approval by amount and category (FR-P-05) and MSME payment discipline is enforced at source (FR-P-09). Tender management (FR-T) is deferred to Phase 2 / Epic 14; this epic delivers the requisition-to-confirmation loop and the compliance controls that protect statutory payment deadlines.

### Story 4.1: Supplier Registry and Onboarding

As a procurement officer,
I want to create and onboard supplier records with contacts, tax identifiers, certifications, and GSTIN through a document-collection workflow,
So that every purchase is placed against a verified, approved supplier of record.

**Acceptance Criteria:**

**Given** no supplier record exists for a new vendor
**When** the procurement officer creates a supplier with legal name, contacts, PAN, GSTIN, commercial and payment terms (credit period in days, freight and delivery terms), and certification references (FR-P-01)
**Then** a `SupplierRegistered` event is written to the event store, the terms are stored on the supplier record and default onto that supplier's POs (Story 4.4), and the supplier is placed in `onboarding` status, not yet orderable

**Given** a supplier is in `onboarding` status
**When** the required documents (GSTIN certificate, PAN, bank proof, certifications) are collected and the onboarding is submitted for approval (FR-P-02)
**Then** approval is routed to the authority resolved from the DOA registry (FR-DOA-01) — never hard-coded — and the request returns `error_code: "APPROVAL_REQUIRED"` until that authority acts

**Given** the DOA-resolved authority approves the onboarding
**When** the approval event is recorded
**Then** the supplier moves to `active` status, becomes selectable on requisitions and POs, and the approval is written to the non-disableable edit log (FR-AC-13)

**Given** a GSTIN already exists on another active supplier record
**When** the officer attempts to register a duplicate
**Then** the system blocks creation with `error_code: "DUPLICATE_SUPPLIER_GSTIN"` and surfaces the existing supplier to prevent duplicate vendor masters

---

### Story 4.2: Supplier Performance Scorecards

As a procurement officer,
I want supplier performance captured across on-time delivery, quality acceptance, price variance, and responsiveness with a consolidated scorecard,
So that I can make sourcing decisions on evidence rather than anecdote.

**Sequencing:** implement after Stories 4.4, 4.5, and 4.7 — every transactional metric below consumes events those stories produce (`PurchaseOrderIssued` / `PurchaseOrderConfirmed` from 4.4, `GoodsReceived` and match results from 4.5, `SupplierInvoiceCaptured` from 4.7). The story keeps its number but is built last in this epic.

**Acceptance Criteria:**

**Given** an active supplier from Story 4.1 with an issued and confirmed PO (Story 4.4)
**When** a `GoodsReceived` event (Story 4.5) is posted against that supplier's PO
**Then** the on-time delivery metric is updated from the receipt date measured against the PO promised delivery date (FR-P-03) and stored as a scorecard projection event

**Given** QC disposition events exist for the supplier's received lots (Epic 8, Story 8.3 — Epic 8 is in the pilot slice and builds before Epic 4)
**When** a lot is dispositioned accept, reject, or conditional
**Then** the quality-acceptance metric is updated from the disposition (FR-P-03); a supplier with no disposition events shows "no data" for this dimension — never a fabricated zero

**Given** a supplier invoice captured in Story 4.7 is matched against a PO with a price difference
**When** the three-way match (Story 4.5) completes
**Then** the price-variance metric for the supplier is updated with the signed variance percentage

**Given** an issued PO awaiting supplier confirmation
**When** the `PurchaseOrderConfirmed` event (Story 4.4) is recorded
**Then** the responsiveness metric is updated as elapsed business days from `PurchaseOrderIssued` to `PurchaseOrderConfirmed` (FR-P-03), trended per supplier

**Given** a procurement officer opens a supplier scorecard
**When** the scorecard view loads
**Then** on-time delivery, quality acceptance, price variance, and responsiveness are shown as trended metrics with the underlying transactions (receipts, dispositions, matches, confirmations) available for drill-through

---

### Story 4.3: Purchase Requisition and Indent Loop

As a floor supervisor,
I want to raise a purchase requisition from my phone in under 90 seconds and see its live status with a notification on every decision,
So that I know exactly when material I need will arrive without chasing anyone (realizes UJ-IND-01).

**Acceptance Criteria:**

**Given** a floor supervisor on the offline-capable PWA, with or without network
**When** they raise a requisition with item, quantity, need-by date, and a mandatory business-stream tag (FR-AC-01, FR-P-04)
**Then** the requisition is committed locally and shows "captured, pending sync" (Story 1.8 pattern) even with no network, and capture completes in under 90 seconds measured from opening the new-requisition form to the local commit (see measurement note below); an untagged requisition is rejected at capture with `error_code: "UNTAGGED_TRANSACTION"`

**Given** a similar open requisition for the same item by the same requester exists within the configured open window
**When** a new requisition is submitted while the device is online
**Then** the system flags the potential duplicate with `error_code: "DUPLICATE_EVENT"` and requires explicit confirmation before proceeding

**Given** the same duplicate condition and the requisition was captured offline
**When** the queued requisition syncs
**Then** the duplicate check runs server-side at sync time; the requisition is held in `pending-confirmation` — not routed to approval — and the requester is notified to confirm or withdraw, with the confirmed path applying the same `DUPLICATE_EVENT` flow; the capture is never silently dropped

**Given** a requisition has been submitted
**When** the requester views its status
**Then** live status is shown as one of `raised`, `approved`, `rejected`, `ordered`, `cancelled`, or `closed`, with the expected delivery date shown as an attribute of the `ordered` status once a PO is placed

**Given** an approver approves or rejects the requisition
**When** the decision is recorded
**Then** a push notification is sent to the requester through the notification foundation (Story 1.11) with the decision and, for rejections, the mandatory reason

**Given** requisition approval rules are configured by amount band, item category, and requesting department (FR-P-04)
**When** a requisition is submitted
**Then** the approving authority is resolved from the DOA registry (FR-DOA-01) against those rules — never hard-coded — the requisition returns `error_code: "APPROVAL_REQUIRED"` until that authority acts, and rule changes are written to the edit log (FR-AC-13) and apply only to requisitions submitted after the change

**Measurement note:** the 90-second target (UJ-IND-01) is measured by client instrumentation from the `form_opened` timestamp to the `local_commit` timestamp on a mid-range Android device, network present or absent; a tap-count budget for the capture flow serves as the CI regression proxy for the timing target.

---

### Story 4.4: Purchase Order Management

As a procurement officer,
I want to create standard, blanket, and contract purchase orders with DOA-gated approval by amount and category and issue them to the supplier through the ERP handoff,
So that spend is authorized by the right level of authority and orders flow to accounting cleanly.

**Acceptance Criteria:**

**Given** an approved requisition from Story 4.3
**When** the officer creates a PO of type standard, blanket, or contract against an active supplier (FR-P-05)
**Then** a `PurchaseOrderDrafted` event is written with line items, prices, and the inherited business-stream tag

**Given** a drafted PO with a total amount and category
**When** it is submitted for approval
**Then** the approving authority is resolved from the DOA registry (FR-DOA-01) by amount band and category, and the PO returns `error_code: "APPROVAL_REQUIRED"` until that authority approves

**Given** a PO has been approved by the DOA-resolved authority
**When** the officer issues it
**Then** a `PurchaseOrderIssued` event is written and its payload (line items, prices, taxes, business-stream tag) is published to the PO-outbound channel of the ERP integration adapter (`adapters/erp` — see interface note below), the PO moves to `issued` status, and the linked requisition status flips to `ordered`; the AC is verified against the adapter's recorded outbound payload, not a live ERP

**Given** an issued PO
**When** the officer records the supplier's order confirmation with the promised delivery date
**Then** a `PurchaseOrderConfirmed` event is written, the promised date is stamped on the PO lines, and the linked requisition shows the expected delivery date (feeds the Story 4.2 responsiveness metric)

**Given** a blanket or contract PO with a defined ceiling
**When** cumulative releases would exceed the ceiling
**Then** the release is blocked until the ceiling is revised through a fresh DOA-gated approval

**Interface note:** the ERP adapter (`adapters/erp`) is the only component that communicates with the external ERP (architecture spine). This story defines the PO-outbound message contract on that adapter — distinct from INT-ERP-01, which is scoped to BOM structure outbound and cost rates inbound. Tests assert the recorded payload at the adapter boundary; live transmission is per-deployment configuration. Open POs inbound from ERP are the read-only reference projections of Story 2.9, which Story 3.4 receives against until this story's native POs go live.

---

### Story 4.5: Goods Receipt and Three-Way Match

As a procurement officer,
I want to record goods receipts against POs with a QC trigger and run a three-way match across PO, receipt, and invoice with tolerance checks,
So that we only pay for what was ordered and received, and discrepancies are caught before payment.

**Boundary note:** Story 3.4 (Epic 3) owns physical receiving capture — the gate-token chain (AD-2), lot/serial/expiry entry, and putaway tasks. Story 4.5 owns the procurement and financial side: PO-matching GRN posting, QC Hold stock status, and the three-way match. This story never re-implements physical capture; it consumes Story 3.4's receiving events. Until Story 4.4's native POs go live, Story 3.4 receives against the read-only open-PO reference projections from Story 2.9 (ERP inbound).

**Acceptance Criteria:**

**Given** an issued PO from Story 4.4 and physical receiving captured through Story 3.4
**When** the procurement GRN is posted against the PO (FR-P-06)
**Then** the GRN consumes Story 3.4's receiving events (gate-token chain, lot and expiry capture) without re-entry, received quantities post into QC Hold status where the item requires inspection and a QC inspection task is raised (FR-Q-02 integration point; the QC gate itself is Epic 8 — Story 8.1), and a `GoodsReceived` event is written with lot and quantity detail

**Given** a GRN, its source PO, and a supplier invoice captured through Story 4.7
**When** the three-way match is run (FR-P-07)
**Then** quantity and price are compared across all three documents and a match passes only when differences fall within configured tolerance

**Given** a three-way match falls outside tolerance
**When** the match completes
**Then** the match record is set to `blocked` with `error_code: "MATCH_OUT_OF_TOLERANCE"`, the invoice is excluded from the payment-clearance feed to ERP (payment executes in ERP; the block is effected by withholding clearance through the `adapters/erp` channel), and the block is lifted only by a credit note or debit note, each recorded to the edit log (FR-AC-13)

**Given** a GRN is created without a valid source PO reference
**When** the receipt is attempted
**Then** it is blocked with `error_code: "SOURCE_DOCUMENT_REQUIRED"`

---

### Story 4.6: MSME Compliance Tracking

As a finance compliance officer,
I want Udyam registration captured on suppliers with statutory due dates stamped on every PO and an ageing report flagging s.43B(h) and MSMED s.16 exposure,
So that we never miss an MSME payment deadline or lose a tax deduction.

**Acceptance Criteria:**

**Given** a supplier claiming MSME status
**When** their Udyam registration number is captured, passes format validation (pattern `UDYAM-XX-00-0000000`), and is verified by the officer against the uploaded Udyam certificate (FR-P-09)
**Then** the supplier is flagged as an MSME vendor with a classification tag of `micro`, `small`, or `medium` taken from the certificate, and the Udyam number, classification, and certificate reference are stored on the supplier record

**Given** a PO is issued to an MSME-flagged supplier
**When** the PO is confirmed
**Then** a statutory payment due date is stamped as the earlier of the agreed date and 45 days, or 15 days where no agreement exists (the appointed-day rule)

**Given** MSME supplier invoices captured through Story 4.7 are outstanding
**When** the ageing report is generated
**Then** invoices approaching or past their statutory due date are flagged with their s.43B(h) income-tax and MSMED s.16 interest exposure, each line tagged with the supplier's MSME classification (`micro`, `small`, or `medium`)

**Given** the classification-tagged ageing exists
**When** the scheduled ERP feed runs
**Then** the ageing, tagged by MSME classification, is fed to ERP through the ERP integration adapter (`adapters/erp`) so the s.43B(h) disallowance computation in ERP consumes it (FR-P-09), and each feed run is recorded with timestamp and row count

**Given** an MSME supplier's Udyam registration is approaching its annual revalidation date
**When** the revalidation window opens
**Then** an alert is raised through the notification foundation (Story 1.11) to re-verify the registration before it lapses

**Given** a Udyam number that fails format validation or does not match the recorded certificate
**When** the officer attempts to save the MSME flag
**Then** the save is rejected with `error_code: "UDYAM_INVALID"` and the supplier remains untagged as MSME until a valid registration is captured

**Given** an MSME supplier's Udyam revalidation date has passed without re-verification
**When** the daily compliance check runs
**Then** the supplier's MSME flag moves to `suspended-pending-reverification` with the change written to the edit log (FR-AC-13); statutory due dates already stamped on open POs and invoices remain in force (conservative treatment) and new POs to the supplier raise a warning to procurement

**Given** an MSME invoice passes its statutory due date unpaid
**When** the breach is detected
**Then** the invoice is flagged `statutory_breach`, MSMED s.16 interest exposure accrues in the ageing from the day after the due date, and an escalation is sent to the finance compliance officer through the notification foundation (Story 1.11)

---

### Story 4.7: Supplier Invoice Capture

As an accounts payable officer,
I want supplier invoices captured by manual entry or file ingestion with matching-ready fields and duplicate detection,
So that the three-way match (Story 4.5), supplier scorecards (Story 4.2), and MSME ageing (Story 4.6) run against a complete, de-duplicated invoice register.

**Acceptance Criteria:**

**Given** an issued PO from Story 4.4
**When** an invoice is manually entered with supplier, invoice number, invoice date, PO reference, line items (item, quantity, unit price), GST breakup, and total
**Then** a `SupplierInvoiceCaptured` event is written with the business-stream tag inherited from the PO, the invoice enters `captured` status, and every field the Story 4.5 three-way match requires is present and validated at entry

**Given** a supplier invoice arrives as a file (PDF, CSV, or XML)
**When** the file is ingested
**Then** header and line fields are extracted into a review screen where the officer confirms or corrects before posting — no invoice posts unreviewed — and the file, uploader, and timestamp are stored as provenance on the invoice record

**Given** an invoice with the same supplier GSTIN and invoice number already exists within the same financial year
**When** capture is attempted (manual or file)
**Then** the capture is blocked with `error_code: "DUPLICATE_EVENT"`, the existing invoice is surfaced, and an officer override to proceed requires a reason recorded to the edit log (FR-AC-13)

**Given** an invoice that references no valid PO
**When** it is captured
**Then** it lands in an `unmatched` exception queue; any attempt to run the three-way match on it returns `error_code: "SOURCE_DOCUMENT_REQUIRED"` until a procurement officer links a PO

**Given** the supplier is MSME-flagged (Story 4.6)
**When** the invoice is captured
**Then** the statutory payment due date is stamped on the invoice at capture — the earlier of the agreed date and 45 days, or 15 days where no agreement exists — feeding the Story 4.6 ageing

---

### Story 4.8: Standing Approvals and Self-Approval Limits

As a site head or head of department,
I want to grant a named person a standing approval for an item or item group, and a per-person self-approval limit, each effective after a one-time finance sign-off,
So that routine repeat issues stop queuing behind approvers while every grant stays visible, capped, revocable, and audited.

**Extends Story 4.3's approval rules (FR-P-04). SOD-01 is amended as recorded in the access matrix and the PRD addendum (sprint-change-proposal-2026-09-26 Section 4.4). Ratified in the UX run 2026-09-23 to 2026-09-26 (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, EXPERIENCE.md Requisitions and Standing Approvals, memlog standing-approval rulings 2026-09-25, Q6 and Q7 rulings). Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.**

**Depends on (user ruling 2026-09-29):** Stories 1.16 (site head role), 2.10 (item groups), 4.10 (line-level approval and mixed routing), 4.11 (stores counter issue). Story 4.9 lands before 4.10.

**Acceptance Criteria:**

**Given** a site head (Story 1.16) or head of department
**When** they assign a standing approval
**Then** a grant with id `SA-YYYY-NNN` links one user to one SKU or one item group (Story 2.10), with an optional monthly quantity cap (counted against quantity issued) and an optional end date; the grant is inactive until the finance department head approves it once

**Given** an active standing approval
**When** a requisition line falls under it and within its cap
**Then** that line proceeds to stores counter issue (Story 4.11) without a per-transaction approver, and the issue screen and the printed slip both state the grant id it rode on

**Given** a requisition line whose issue would take the month's issued quantity over the grant's cap, or a line outside the grant's scope
**When** it is submitted
**Then** that line alone falls back to the normal DOA approval path (Story 4.10 per-line routing; covered lines in the same requisition still issue) - never rejected for exceeding the grant, never silently self-approved

**Given** a per-person self-approval limit assigned by the site head or head of department and approved once by the finance department head
**When** the person approves their own requisition line within that limit
**Then** the self-approval is permitted (SOD-01 as amended) and the requisition is flagged as self-approved in the audit trail

**Given** an active grant
**When** the assigner revokes it
**Then** revocation is effective instantly and needs no second approver; and when the grantee's account is disabled, every grant they hold auto-revokes the same day

**Given** the pruning cycle (default every 30 days)
**When** it runs
**Then** each assigner receives an in-app plus web push list of their live grants, with any grant unused for 90 days flagged for review (email deferred per user ruling 2026-09-29, logged in `deferred-work.md`)

---

### Story 4.9: Indent Approver Resolution Fallback

As a floor supervisor whose indent matches no DOA band,
I want the system to route it to a defined fallback approver and show me that state,
So that no indent is ever stored unapprovable and stuck with no path forward.

**Defect:** an indent with no DOA band match is stored without an approver, and the approval step then refuses with `NOT_RESOLVED_APPROVER`, leaving it permanently stuck (`src/compliance/indent.ts:599-603`). Found in the UX run backend check (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, run memlog indent backend check). Fallback per UX ruling Q6: route to the head of department band. Sits inside done Story 4.3's flow. Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.

**Acceptance Criteria:**

**Given** an indent whose amount and category match no DOA band (`src/compliance/indent.ts:599-603`)
**When** the approver is resolved
**Then** the indent routes to the requester's head of department band (UX ruling Q6) instead of being stored without an approver

**Given** an indent routed by the fallback
**When** the requester views its status
**Then** the status surfaces the fallback state (who it is waiting on and why) instead of a dead end; approval by the fallback authority proceeds normally

**Given** the fallback itself cannot resolve (no head of department on record)
**When** the indent is submitted
**Then** the submission is rejected at capture with an actionable error naming the missing configuration - it is never stored unapprovable

**Given** indents stored stuck before this fix
**When** the fix deploys
**Then** existing `NOT_RESOLVED_APPROVER` indents are re-resolved through the fallback or surfaced in an exception list for manual routing, and a regression test locks in that an unmatched indent never again persists without an approver path

### Story 4.10: Requisition Line-Level Approval and Mixed Routing

As a requester and as an approver,
I want each requisition line to carry its own approval route and state,
So that lines covered by a standing approval go straight to stores while the rest follow DOA approval, without splitting the document.

**Acceptance Criteria:**

**Given** a requisition with several lines
**When** it is raised
**Then** each line gets its own route (`doa`, `standing_approval`, `self_approval`) and state (pending, approved, rejected), and the header status is derived from its lines

**Given** a mixed requisition
**When** some lines are covered by a live grant and others are not
**Then** covered lines are approved for issue at once and uncovered lines go to the DOA approver resolved on their own value; the document is never split

**Given** a DOA approver
**When** they decide a requisition
**Then** they approve or reject individual lines, SOD-01 and the Story 4.3 seam guards apply per line, and each decision is audited

**Given** the pilot value bands (UX ruling Q6: head of department up to Rs 1,00,000, finance controller above)
**When** this story deploys
**Then** the bands are confirmed with the owner and seeded as `indent_approval` entries in the DOA registry on staging and in the pilot seed, with a regression test on the band boundaries

**Given** existing whole-indent approvals
**When** the story deploys
**Then** they are migrated so every line inherits the header decision, and Story 4.3 behaviour for single-route requisitions is unchanged

**Note:** PILOT. Prerequisite of Story 4.8. Coordinate with Story 4.9 (no-band fallback now resolves per line). Source: user ruling 2026-09-29 (Story 4.8 open questions).

### Story 4.11: Stores Counter Issue Against a Requisition

As a storekeeper,
I want to issue stock at the counter against approved requisition lines, fully or in part,
So that approved needs are met from stock with a printed slip and an exact ledger record.

**Acceptance Criteria:**

**Given** an approved requisition line
**When** the storekeeper issues from a bin
**Then** the issue decrements stock through the stock-balance ledger, records the issued quantity against the line, and prints a slip naming the requisition, line, requester and approval basis

**Given** a line with quantity still open
**When** a partial issue is made
**Then** the line stays open for the remainder until fully issued or closed with a reason; issued never exceeds approved

**Given** a line not yet approved or already fully issued
**When** an issue is attempted
**Then** it is refused with a stable error code

**Given** lot or serial controlled items
**When** they are issued
**Then** lot and serial capture follows the Story 2.3 rules

**Note:** PILOT. Prerequisite of Story 4.8 (issue-time cap check and slip text). Source: user ruling 2026-09-29 (Story 4.8 open questions).

---

### Story 4.12: Approvals Inbox and Requisition Approval Detail

As a department head or finance controller holding an `indent_approval` DOA band (or their active delegate),
I want an Approvals inbox that lists the requisitions waiting for me and lets me approve or reject the lines routed to me,
So that UJ-IND-01 completes inside the edge app and stores can issue the approved lines.

**Acceptance Criteria:**

**Given** a caller who actively holds the role of any `listActiveDoaEntries('indent_approval')` entry at the site (`src/read/projections/doa_registry.ts:218-230` with `isActiveRoleHolderForEntry` `:338-357`) or is the active delegate of such a holder through a new delegate-side lookup in `doa_registry.ts` (`findActiveDelegation` `:267-286` is keyed by delegator only)
**When** the bootstrap runs
**Then** navigation carries `Approvals` from a new row `{ name: 'Approvals', modules: 'approvals', functionScope: 'read' }` resolved by `hasIndentApprovalScope(authContext, siteId)` in `src/api/v1/edge.ts` (pattern `hasDamageCaseScope` `:389-398`; modules union `:366` widened), NAV_ENTRIES gains `/approvals` with label `nav.approvals` (`edge/src/components/navigation/nav-model.ts:11-30`), `approvals` joins BaseView and BASE_VIEW_ENTRY (`edge/src/components/app-shell.tsx:130-156`), and a deep link without it renders the no-access card (`:349-358`)

**Given** Task 1 server work
**When** `GET /api/v1/indents?pending_for_me=true` or `?decided_by_me=true` is called
**Then** `listIndents` (`src/read/projections/indent.ts:266-310`) returns raised headers with pending lines whose `approver_actor_id` is the caller or a delegator the caller actively represents (with `pending_for_me_line_ids` and `approver_bands`), or lines decided by the caller, branching before the base-role refusal at `src/api/v1/indents.ts:489-495` as the issuable branch does at `:470-486`, bypassing the raiser-site scope and returning an empty list rather than `FUNCTION_ACCESS_DENIED` for a holder with nothing pending; today only status, search, mine and issuable are parsed (`:406-416`)

**Given** Task 1 server work
**When** `GET /api/v1/indents/:indentId`, `POST .../approve` or `POST .../reject` is called by a caller who is the resolved approver or active delegate of at least one line but holds no procurement role
**Then** the routes admit them: `approveIndentHandler` and `rejectIndentHandler` (`src/api/v1/indents.ts:1142-1150`) gate on module `[EMPLOYEE_MODULE, 'procurement']` write (the shape `raiseIndentHandler` uses at `:1111-1113`) and `assertIndentReadAccess` (`:223-233`, today 403 for the staging `finance_controller`, `deploy/provision/staging-bootstrap-accounts.sh:103-105`) gains a third admit branch for an approver or delegate of any line, while the seam keeps enforcing identity per line (`src/compliance/indent.ts:893-979`); confirm, withdraw and cancel stay procurement write (the remaining half of deferred-work.md:1182); `test/integration/story-4-12.test.ts` proves list, detail, approve and reject with a finance holder provisioned exactly as the staging script does

**Given** `/approvals` online
**When** the inbox loads
**Then** tabs Waiting and Decided carry counts and All carries none (mock key-approvals.html L579-581); Handheld and Tablet render cards (type, reference, amount, subline, requester, age, status pill; L613-615), Desktop and Desktop touch render a table with columns Type / reference, Requested by, Amount, Age, Status (L598-603; the SLA column is omitted because SLA hours are mock values, EXPERIENCE.md:171); the status pill reads Waiting, Approved or Rejected in text (DESIGN.md:201, :260); a client-side search over reference, item and requester (L575); the band line `Your DOA band as <role>: up to Rs <max>` from `approver_bands`, hidden when empty (L584-586); the empty Waiting state `Nothing waiting for you` with `New approvals for <role> appear here. Last checked <time>.` and a `See decided items` link (L590), and `No items match` with `Clear filters` when a search empties a tab (L591); no approval-type filter ships because this story carries one type (owner question Q26)

**Given** a requisition detail from `GET /api/v1/indents/:indentId`
**When** it renders
**Then** a DOA note states why it reached the caller (`Routed to you as the requester's head of department by value band (up to Rs <band>)`, L625, from `approver_bands`); every line shows its route chip per DESIGN.md:302-304 from `approval_route` (`src/read/projections/indent.ts:51`): `Standing approval SA-YYYY-NNN` in the ok pair with cap copy such as `4 of 6 cans used this month` where a cap is set (EXPERIENCE.md:89; Story 4.8 fields), `Self-approval limit Rs <amount>` in the info pair, `<band role> approval` in the warn pair for DOA lines; a `line_status` pill with text; lines pending for the caller are marked `Waiting for you` and the others read-only with their decider and time; an Evidence table lists line, qty, value with a total (L631-633); a History block lists raise (`created_at`) and each decision (`decided_at`, `decided_by`, `rejection_reason`) (L652-656); no per-line selection control

**Given** the detail with at least one line pending for the caller
**When** Approve is tapped, or Reject is confirmed with a non-empty reason (`Reason for rejection (required, sent to the requester)`, Confirm reject disabled until text, Cancel beside it, L709-715)
**Then** `POST /api/v1/indents/:indentId/approve` or `/reject` is sent with `line_ids` equal to `pending_for_me_line_ids` (`src/server.ts:857-858`; the server derives the same set when the body omits them, `src/api/v1/indents.ts:955-956`), the detail confirms inline (`Approved by you, <time>. <requester> has been notified.` or `Rejected by you ... Reason sent to <requester>`, L719, L722), the item moves to Decided with no undo (EXPERIENCE.md:171); `INDENT_LINE_ALREADY_DECIDED`, `INDENT_LINE_NOT_FOUND`, `INDENT_RAISER_CANNOT_APPROVE`, `NOT_RESOLVED_APPROVER`, `INDENT_NOT_IN_RAISED`, `INDENT_PENDING_CONFIRMATION`, `INDENT_ALREADY_DECIDED`, `INDENT_REJECTION_REASON_REQUIRED` and `FUNCTION_ACCESS_DENIED` render through `errorMessage()` (`edge/src/i18n/locale.ts:37-41`) from new `errors.*` keys in `edge/src/messages/en.json` (none of the indent decision codes exists today, `:80-119`); nothing is written to the outbox; recorded spine deviation: EXPERIENCE.md:137 places Ask for info in the footer and this story ships without it (Story 4.13 adds the control and its endpoint)

**Given** `navigator.onLine` is false or a fetch fails
**When** the page is open
**Then** Approve and Reject are disabled with the block `Offline - approvals need a connection. Decisions are checked live against the latest stock and your DOA band, so they are not queued. Reconnect to decide. Evidence shown is from the last sync at <time>.` (mock L706-708) in a `role="status"` notice, the last fetched data stays readable marked last synced, and the page re-fetches on online (EXPERIENCE.md:100: both actions disabled)

**Given** the four device classes (`edge/src/lib/use-device-class.ts:10`)
**When** axe and a keyboard-only pass run
**Then** Handheld opens the detail as a page with Back and a pinned footer replacing the bottom nav (L846): Approve full width 56 px, Reject 48 px secondary; Tablet shows list and detail panes, touch-roomy 56/48 px, behind the icon rail; Desktop shows two panes with 34 px compact controls under the sidebar; Desktop touch shows the Desktop layout with 56/48 px targets (DESIGN.md:224-229, EXPERIENCE.md:111, :123, :137); zero WCAG 2.1 AA violations; strings under `approvals.*`; runbook row 2.10n (two-line requisition approved from phone and desktop windows, then issued as store1@) passes on staging

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes audit gap G06 (Ask for info carved out to 4.13). Depends on 4.10, 4.3, 1.15, 1.8 (done); 4.11 (done, uncommitted) must be committed before this story branches; 4.8 (review) only for the standing approval chips. Online-only base view like standing-grants (`edge/src/components/standing-grants.tsx:54-104`, `:227-231`); no outbox. Requisition-only scope is a recorded deviation from EXPERIENCE.md:169 (one inbox); a follow-up folds damage-case concurrence and grant decisions into `/approvals`. Size L.

---

### Story 4.13: Requisition Ask for Info

As an approver,
I want to send a question to the requester about a raised requisition without deciding it,
So that I can decide with the missing information.

**Acceptance Criteria:**

**Given** an indent whose header status is `raised` (not `pending-confirmation`) with lines in `line_status` pending held by the actor
**When** `POST /api/v1/indents/:indentId/request-info { question, line_ids? }` is called behind the 4.12 approve gate (`src/api/v1/indents.ts:1142-1150` as widened), `line_ids` defaulting to every pending line the actor holds (`resolveDecisionLineIds`, `:929-948`)
**Then** for every line the actor must be that line's `approver_actor_id` or an active delegate of it (`decideAsApprover`, `src/compliance/indent.ts:943-975`; the requester is refused `INDENT_RAISER_CANNOT_APPROVE` as at `:911-935`; a non-pending line is refused `INDENT_LINE_ALREADY_DECIDED` 409); one `indent.info_requested` event is persisted on the procurement stream through the decision seam (`INDENT_EVENT_TYPES`, `src/compliance/indent.ts:35-45`, dispatcher `:62-66`, applier wired at `src/events/store.ts:1183`; not the 4.11 issue seam `src/compliance/indent-issue.ts:53`); one `indent_info_request` read row (new table in `read/projections/indent.sql` mirrored in `deploy/compose/init-db.sql`: indent_id, line_ids, question, asked_by_user_id, asked_at) and one `logAuditEntry` (`:1039` pattern) are written in the same transaction; a transactional notification (`emitNotificationInTransaction`, `:1082-1097`) with `event_type` `indent_info_requested` targets `{ role, user_id: indent.requester_user_id }` and the type joins `KNOWN_EVENT_TYPES` (`src/api/v1/notification.ts:34`, owner question Q28); `line_status` stays pending; a blank question is refused 400 `INDENT_INFO_QUESTION_REQUIRED`; the events door refuses an uploaded `indent.info_requested` with 403 `FUNCTION_ACCESS_DENIED` (extend `src/api/v1/events.ts:557-569`) and the edge door with 403 `CENTRAL_ONLY_OPERATION` (add to `EDGE_REFUSED_INDENT_EVENT_TYPES`, `src/sync/upload.ts:385-398`, called at `src/api/v1/edge.ts:554`), both tested as in `test/integration/story-4-11.test.ts:636` and `:939`; the route joins `allowedSpineRoutes` (`test/integration/story-1-9.test.ts:372-385`)

**Given** `GET /api/v1/indents/:indentId` (`src/api/v1/indents.ts:386-403`, today `{ indent, lines }`)
**When** info requests exist
**Then** the response adds a top-level `info_requests[]` (newest first: `info_request_id`, `line_ids`, `question`, `asked_by`, `asked_at`), `GET /api/v1/indents` list rows gain `info_requested: { asked_at, question } | null` (latest only, one grouped subquery in `listIndents`, `src/read/projections/indent.ts:266`, no N+1), and the 4.12 detail renders the status block `Info asked, <when>` plus `"<question>" - you can still decide.` (mock key-approvals.html L733) with an `Info asked` chip (info pair, L546) on the inbox row; the row stays under Waiting (L529)

**Given** the 4.12 requisition approval detail on Handheld while online
**When** `Ask for info` (48 px secondary beside Reject under the full-width Approve, EXPERIENCE.md:137, mock L389, L735) is tapped
**Then** the footer actions are replaced by a textarea labelled `What do you need from the requester?` with the hint `Required before you can send.` while empty, a primary `Send question` disabled until text is typed, and a `Cancel` link restoring the three actions (L707-716, L899-902); on send the detail shows the status block and the inbox row keeps Waiting; offline the footer shows the 4.12 offline block and Ask for info is not offered (L704-706, L725; EXPERIENCE.md:100); `Ask for info` is not offered on standing-approval or self-approval-limit items (L405, L735-736)

**Given** the requester's My requests (`edge/src/components/my-requests.tsx`, fed by `GET /api/v1/indents?mine=true` at `:249`, list only)
**When** `info_requested` is set on the row
**Then** the card shows an `Info asked` chip and the question text with its date (keys under `myRequests.infoRequest.*`), and `GET /api/v1/notifications` (`src/server.ts:1458`) returns the `indent_info_requested` row for the requester; no edge notifications surface exists (no bell; EXPERIENCE.md:139; audit 7.2 item 8 Shell Phase 2), so in-app notification display and a typed requester reply are out of scope and recorded in deferred-work.md

**Note:** PILOT. Source: `sprint-change-proposal-2026-10-21.md`. Closes the Ask for info residual of audit gap G06 (EXPERIENCE.md:137). Depends on 4.12. Same surface and nav as 4.12; no new nav row; online-only. Size S-M.

---

## Epic 5: BOM and Engineering Change Management

Engineering teams manage the full lifecycle of production and R&D bills of material with enforced immutability for released revisions and an ECO-only change path. R&D draft BOMs iterate freely with placeholders and free text but cannot execute in production without a signed productization gate (FR-B-11). The platform is the system of record for BOM structure; ERP receives outbound-only sync and any inbound conflict becomes a BOM Administrator exception (FR-B-17). The item master must be stable (A-11) before the BOM release gate (FR-B-06) can be exercised.

### Story 5.1: Multi-Level BOM Creation

As a design engineer,
I want to create multi-level BOMs with per-line scrap percentages, unit-of-measure conversions, date effectivity, phantom pass-through assemblies, and co-/by-products with expected yields,
So that the BOM faithfully represents how the product is actually built.

**Acceptance Criteria:**

**Given** released component item masters exist
**When** an engineer creates a multi-level BOM with component lines carrying scrap %, UoM conversion factors, and date effectivity (FR-B-01, FR-B-03)
**Then** a `BomDrafted` event is written with the full structure and the BOM is placed in `Draft` state

**Given** a BOM line references a phantom assembly (FR-B-13)
**When** the BOM is structured
**Then** the phantom is modeled as a pass-through — its children are represented at the parent level without stocking the phantom itself

**Given** a process yields co-products and by-products (FR-B-14)
**When** they are added to the BOM
**Then** each co-product and by-product carries an expected yield and is distinguished from primary output

**Given** a component line references an item that is not yet a released item master
**When** the line is added
**Then** the line is flagged as blocking release until the item master is released (A-11 prerequisite)

**Given** a BOM revision line with a date-effectivity window
**When** another line for the same component on the same revision is saved with an overlapping effectivity window (FR-B-03)
**Then** the save is rejected with `error_code: "EFFECTIVITY_OVERLAP"` — revision date effectivity must be non-overlapping

**Given** a multi-level BOM structure
**When** a component line is added that would make the BOM a descendant of itself at any depth
**Then** the line is rejected with `error_code: "BOM_CYCLE_DETECTED"`

**Given** a component line carrying a scrap %
**When** the value is outside the 0–100 range
**Then** the save is rejected listing the invalid value

**Dev Notes:**

- Domain events: `BomDrafted`, `BomLineAdded`, `BomLineAmended`. Projections: multi-level BOM structure read model (the Story 5.3 where-used graph builds on it), module-scoped per the DB-timing standard.

---

### Story 5.2: BOM Lifecycle and Immutability

As a BOM administrator,
I want BOMs to move through Draft, Released, On Hold, and Obsolete states with a strict release gate, and released revisions to be immutable,
So that production always builds from a controlled, unchangeable specification.

**Acceptance Criteria:**

**Given** a Draft BOM from Story 5.1
**When** release is attempted (FR-B-06)
**Then** release succeeds only when all component item masters are released (A-11) and all scrap % are filled — otherwise release is blocked with `error_code: "RELEASE_GATE_UNMET"` listing the unmet conditions. The remaining FR-B-06 gate conditions are staged: the approved-ECO condition is added by Story 5.3 (first release of a new BOM is exempt) and the completed-cost-rollup condition by Story 5.6

**Given** a BOM has been Released
**When** any user attempts to edit its structure directly
**Then** the edit is rejected with `error_code: "IMMUTABLE_REVISION"` because Released revisions are immutable (FR-B-03) — changes are only possible through an ECO (Story 5.3)

**Given** a Released BOM
**When** an administrator changes its state
**Then** it may move only to On Hold or Obsolete, and each transition is written to the edit log (FR-AC-13)

**Given** existing legacy kit definitions from the ERP kit master (FR-I-09, Epic 2)
**When** migration runs (FR-B-02)
**Then** each kit whose components all reference released item masters is migrated as a single-level BOM in Released state with its components preserved, released via a migration-exempt path recorded in the edit log (FR-AC-13)

**Given** a legacy kit referencing an item that is not yet a released item master
**When** migration runs (FR-B-02)
**Then** that kit lands as a Draft BOM flagged for remediation rather than being force-released, and appears on the migration exception list feeding the Epic 13 sign-off gate

**Dev Notes:**

- Domain events: `BomReleased`, `BomHeld`, `BomObsoleted`, `LegacyKitMigrated`. Projections: BOM lifecycle-state read model and release-gate checklist projection (module-scoped per the DB-timing standard).
- The FR-B-06 release gate is staged deliberately (D4): this story enforces the released-item-master and scrap-percent conditions; Story 5.3 adds the approved-ECO condition (with a first-release exemption) and Story 5.6 adds the completed-cost-rollup condition.

---

### Story 5.3: ECO Workflow and Where-Used Impact

As a change control engineer,
I want an Engineering Change Order workflow with where-used and impact analysis shown at approval, and only Implemented ECOs able to alter a Released BOM,
So that every change is assessed for downstream impact and applied in a controlled way.

**Acceptance Criteria:**

**Given** a proposed change to a Released BOM
**When** an ECO is raised (FR-B-04)
**Then** it enters the ECO lifecycle at `Draft`, progressing through `Under Review`, `Approved`, `Implemented`, or `Cancelled`

**Given** an ECO reaches the approval step
**When** the approver reviews it
**Then** a where-used and impact analysis (FR-B-05) is displayed across affected BOMs and current stock (Epic 2), with open-PO impact read from the ERP inbound reference projections (Story 2.9); the open-production-order dimension displays as empty and registers as an impact source when Epic 6 lands

**Given** an ECO has been Approved but not yet Implemented
**When** the target Released BOM is inspected
**Then** the BOM is unchanged — only an `Implemented` ECO alters a Released BOM

**Given** an ECO is Implemented
**When** the implementation event is recorded
**Then** a new Released BOM revision is created, the prior revision is retained immutably, and the change is attributed in the edit log (FR-AC-13)

**Given** an Approved ECO with on-hand stock of the superseded revision (FR-B-04)
**When** implementation is recorded
**Then** a stock-disposition decision — use-up, scrap, or rework — is required per affected lot before the ECO can reach `Implemented`: use-up permits consuming the superseded revision until exhausted, scrap routes affected lots to the scrap disposition flow, rework routes them to a rework reference, and each decision is written to the edit log (FR-AC-13)

**Given** an ECO that is not in `Approved` state (FR-B-04)
**When** implementation is attempted
**Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` — only Approved ECOs may be Implemented

**Given** an ECO reaches the approval step
**When** the approver is resolved
**Then** the approver is resolved from the DOA registry (FR-DOA-01), and an approval attempt by a user outside the resolved chain is rejected with `error_code: "APPROVAL_REQUIRED"`

**Given** a Cancelled ECO
**When** any user attempts to reopen or implement it
**Then** the attempt is rejected with `error_code: "ECO_STATE_INVALID"` — Cancelled is terminal and a new ECO must be raised

**Given** a BOM with at least one prior Released revision
**When** release of a subsequent revision is attempted without an approved ECO covering the change (FR-B-06)
**Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` — the approved-ECO gate condition (staged from Story 5.2) applies to every revision after the first; the first release of a brand-new BOM is exempt so that initial release is achievable

**Dev Notes:**

- Domain events: `EcoRaised`, `EcoApproved`, `EcoImplemented`, `EcoCancelled`, `EcoStockDispositionRecorded`. Projections: ECO approval queue and where-used impact graph (module-scoped per the DB-timing standard).
- Open-PO impact reads from the Story 2.9 ERP inbound reference projections; the open-production-order impact source registers when Epic 6 lands.

---

### Story 5.4: R&D Draft BOM Regime

As an R&D engineer,
I want R&D draft BOMs that allow in-place edits, placeholders, and free text, that I can clone from a production BOM, and that capture an as-built snapshot per prototype build,
So that I can iterate freely during development without touching production specifications.

**Acceptance Criteria:**

**Given** an R&D engineer working on a new design
**When** they create or edit an R&D draft BOM (FR-B-09)
**Then** in-place edits, placeholder components, and free-text lines are permitted without ECO controls

**Given** an R&D draft BOM carrying the `rd_draft` regime flag (FR-B-09)
**When** any execution-intent request references it — release-gate eligibility evaluation (FR-B-06) or explosion to execution (FR-B-07)
**Then** the request is rejected with `error_code: "RD_EXECUTION_BARRED"` — the regime flag structurally blocks release-gate eligibility, testable at BOM level without a production order; Epic 6's production-order release gate consumes this same validation when it lands

**Given** an existing production BOM
**When** the engineer clones it to an R&D draft (FR-B-10)
**Then** a new editable R&D draft is created without altering the source production BOM

**Given** an R&D draft BOM with a recorded draft-BOM build record (FR-B-10)
**When** the build record is confirmed
**Then** an immutable as-built snapshot is captured for that specific build, with deviation flags on every line where the as-built structure differs from the draft; any attempt to edit a captured snapshot is rejected — corrections are new snapshots attributed in the edit log (FR-AC-13). The build record is exercised at BOM level in this story; prototype build execution (Epic 10, FR-RD-08) and production trials (Epic 6) integrate against this same capture when they land

**Given** an R&D draft BOM is proposed for production
**When** the productization gate is run (FR-B-11)
**Then** the gate requires engineering, procurement, and QC sign-offs on a checklist before a production BOM can be created, returning `error_code: "APPROVAL_REQUIRED"` until all sign-offs are recorded

**Dev Notes:**

- Domain events: `RdDraftCreated`, `RdDraftCloned`, `AsBuiltSnapshotCaptured`, `ProductizationGateSigned`. Projections: R&D draft workspace read model and as-built snapshot store (module-scoped per the DB-timing standard).
- The `rd_draft` regime flag and the as-built capture are validated at BOM level in this story; Epic 6 (production-order release) and Epic 10 (prototype build records, FR-RD-08) integrate against the same flag and capture when they land.

---

### Story 5.5: Approved Alternates and BOM Explosion

As a production planner,
I want approved alternates with priority and effectivity, controlled ad-hoc substitutions, and a BOM explosion service that generates directed-issue or backflush requirements per plant,
So that execution consumes the right materials in the right order of preference.

**Acceptance Criteria:**

**Given** a Released BOM component with approved alternates (FR-B-12)
**When** alternates are defined
**Then** each alternate carries a priority and effectivity window and is available to execution in priority order

**Given** an operator wants to substitute a material not on the approved alternates list (FR-B-12)
**When** the substitution is attempted
**Then** it requires a logged approval resolved from the DOA registry (FR-DOA-01), returning `error_code: "APPROVAL_REQUIRED"`, and the substitution is written to the edit log

**Given** a Released BOM and an order quantity submitted to the explosion service (FR-B-07)
**When** the BOM is exploded to execution
**Then** directed-issue or backflush requirements are generated per line according to the supply method, verified by contract tests against the service (input: Released BOM + quantity; output: per-line requirement set); production-order release (Epic 6, FR-MO-03) invokes this same service when it lands

**Given** a plant that executes offline (FR-B-07)
**When** Released BOM structures are replicated to that plant's edge devices
**Then** the explosion inputs for the plant's effective Released BOMs are replicated per plant for offline continuity via PowerSync

**Dev Notes:**

- Domain events: `AlternateDefined`, `SubstitutionApproved`, `BomExploded`. Projections: alternates-by-component read model and per-plant replicated BOM structure projection (module-scoped per the DB-timing standard).
- Cost rollups, job-work kit tagging, and ERP outbound sync are split out to Story 5.6.

---

### Story 5.6: Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync

As a BOM administrator,
I want dated cost-rollup simulation snapshots with comparison, job-work kit BOMs tagged by supply source, and BOM sync to ERP that is strictly outbound,
So that finance sees accurate, controlled costs and the platform remains the system of record for BOM structure.

**Acceptance Criteria:**

**Given** a cost rollup is requested for a BOM (FR-B-15)
**When** it runs
**Then** the result is stored as a dated simulation snapshot, leaving prior snapshots intact

**Given** two or more dated rollup snapshots for the same BOM (FR-B-15)
**When** a comparison is requested
**Then** the snapshots are compared with per-line and total deltas highlighted

**Given** a Draft BOM without a completed cost rollup
**When** release is attempted (FR-B-06)
**Then** release is blocked with `error_code: "RELEASE_GATE_UNMET"` — the completed-cost-rollup gate condition (staged from Story 5.2) is enforced from this story onward

**Given** a job-work kit BOM (FR-B-16)
**When** it is created
**Then** each line is tagged by supply source — company, customer, or job-worker

**Given** an inbound ERP sync attempts to modify a BOM (FR-B-17)
**When** the inbound change conflicts with the platform record
**Then** ERP sync is treated as outbound-only and the inbound conflict creates a BOM Administrator exception rather than mutating the BOM

**Dev Notes:**

- Domain events: `CostRollupSnapshotted`, `JobWorkKitTagged`, `BomSyncConflictRaised`. Projections: dated rollup snapshot store with comparison view and ERP sync exception queue (module-scoped per the DB-timing standard).
- Boundary (FR-B-15): rollup snapshots are engineering/planning simulations only — inventory valuation stays in ERP, and no valuation postings originate here; cost rates arrive inbound-only per INT-ERP-01 dual mastership.
- FR-B-16 supply-source reconciliation is delivered by Epic 9 (Story 9.3), which consumes these line tags.

---

## Epic 6: Production Orders and Manufacturing WIP

Production supervisors and operators release, execute, and close production orders against verified material availability and Released BOMs. Every finished lot carries a full as-consumed lot genealogy (FR-MO-11), and production WIP is a real-time auditable ledger in quantity and value, distinct from R&D project WIP. Offline plant execution replays cleanly on reconnection with duplicate suppression, while the release, cancel, and close operations remain central-only (FR-MO-13). Completions post into QC Hold as a stock state this epic owns — the no-bypass rule to sellable stock is enforced here — while QC dispositions against those lots are recorded by Epic 8 (FR-Q-05), whose disposition-status projection the closure gate reads; Epic 8 builds before Epic 6.

### Story 6.1: Production Order Creation and Release Gate

As a production planner,
I want to create production orders with immutable numbers and a release gate that verifies an effective Released BOM and material availability,
So that orders only start when they can actually be built.

**Acceptance Criteria:**

**Given** a demand for a finished good
**When** a production order is created with output item, quantity, plant, BOM version, business-stream tag, and source reference (FR-MO-01)
**Then** an immutable order number is assigned and the order enters `Planned` state; an untagged order is rejected with `error_code: "UNTAGGED_TRANSACTION"`

**Given** a production order in any lifecycle state
**When** a state transition is requested (FR-MO-02)
**Then** only valid transitions are accepted — `Planned → Released`, `Released → In Process`, `In Process → Completed`, `Completed → Closed`, and `Planned/Released → Cancelled`; any other transition is rejected with `error_code: "INVALID_STATE_TRANSITION"`, and each accepted transition is attributed in the edit log (FR-AC-13)

**Given** an order in `In Process`, `Completed`, or `Closed` state
**When** cancellation is attempted (FR-MO-02)
**Then** it is rejected with `error_code: "INVALID_STATE_TRANSITION"` — `Cancelled` is reachable only from `Planned` or `Released`

**Given** a `Released` order with unreversed material transactions
**When** cancellation is attempted (FR-MO-02)
**Then** it is rejected with `error_code: "UNREVERSED_TRANSACTIONS"` until every issue against the order is returned or reversed

**Given** a Planned order is submitted for release
**When** the release gate runs (FR-MO-03)
**Then** release succeeds only when an effective Released BOM exists and material availability — unallocated on-hand stock at the order's plant — covers every component line; insufficient availability returns `error_code: "INSUFFICIENT_STOCK"`

**Given** a named authority overrides the release gate despite an availability shortfall
**When** the override is applied
**Then** the order is released and flagged as expediting, with the override recorded to the edit log

**Given** a user who is not a named authority in the DOA registry (FR-DOA-01)
**When** they attempt a release-gate override
**Then** the override is rejected with `error_code: "APPROVAL_REQUIRED"` and the attempt is written to the edit log

---

### Story 6.2: Material Staging, Issue, and WIP Ledger

As a production operator,
I want pick tasks for directed lines, backflush on confirmation, a real-time WIP ledger per order, and returns that reverse WIP at issued cost,
So that material consumption is accurate and traceable through the order.

**Acceptance Criteria:**

**Given** a Released order with directed-issue lines (FR-MO-04)
**When** staging begins
**Then** pick tasks are generated and staged material is held in `allocated` status until issued to the order

**Given** an order with backflush lines
**When** a production confirmation is posted (FR-MO-04)
**Then** backflush components are relieved from stock automatically in proportion to the confirmed quantity

**Given** an order with backflush lines and insufficient component stock to cover the confirmed quantity
**When** a production confirmation is posted (FR-MO-04)
**Then** the confirmation is rejected with `error_code: "INSUFFICIENT_STOCK"` — backflush never drives stock negative — and the shortfall lines are reported to the operator

**Given** material has been issued to an order (FR-MO-05)
**When** the WIP ledger is viewed
**Then** the production WIP ledger for that order shows accumulated quantity and value in real time, distinct from R&D project WIP

**Given** issued material is returned from the order to stock (FR-MO-06)
**When** the return is posted with a mandatory reason code
**Then** WIP is reversed at the issued cost and the original lot identity is restored; a return without a reason code is rejected with `error_code: "REASON_CODE_REQUIRED"`

**Given** a return that would exceed the quantity issued to the order (FR-MO-06)
**When** the return is posted
**Then** it is rejected with `error_code: "RETURN_EXCEEDS_ISSUE"` and the WIP ledger is left unchanged

---

### Story 6.3: Production Completions and QC Hand-off

As a production supervisor,
I want completions to post finished quantity into QC Hold as new lots, co-/by-products handled separately, scrap declarations to relieve WIP, and completion tolerances enforced,
So that only inspected output reaches sellable stock and over-completion is controlled.

**Acceptance Criteria:**

**Given** an In Process order
**When** a completion is confirmed (FR-MO-07)
**Then** the completed quantity posts into QC Hold as a new finished-goods lot — never directly to sellable stock

**Given** a completion attempts to post output directly to sellable stock (FR-MO-07)
**When** the posting is validated
**Then** it is rejected with `error_code: "QC_HOLD_REQUIRED"` — sellable status is reachable only through a QC disposition recorded in Epic 8 (FR-Q-02, FR-Q-05)

**Given** an order that yields co-products and by-products (FR-MO-07)
**When** completion is posted
**Then** each co-product and by-product is posted as its own lot separately from the primary output

**Given** process scrap occurs during the run (FR-MO-08)
**When** a scrap declaration is recorded
**Then** WIP is relieved by the declared scrap and the declaration is logged, feeding the expected-vs-actual reconciliation in Story 6.4

**Given** a completion would exceed the ordered quantity plus tolerance (FR-MO-09)
**When** the over-completion is attempted
**Then** it is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves the over-completion

**Given** an order confirmed complete below the ordered quantity minus tolerance (FR-MO-09)
**When** the supervisor resolves the short completion
**Then** an explicit close-short decision with a reason code is recorded, residual WIP is dispositioned (returned to stock or declared as process scrap), and the order becomes eligible for the FR-MO-12 closure gate at the reduced quantity — an order with an unresolved short completion cannot pass closure

**Given** a QC disposition recorded in Epic 8 requires rework (FR-MO-10)
**When** a rework order is raised
**Then** a linked rework order is created referencing the source lot, and the rework order's output posts back into QC Hold as linked lots — re-entering the QC gate, never bypassing it

---

### Story 6.4: Lot Genealogy, Closure, and Offline Execution

As a production supervisor,
I want a full as-consumed lot genealogy per output lot, a closure gate that requires zero WIP and QC disposition, and offline execution that replays cleanly,
So that every finished lot is fully traceable and orders close only when truly complete.

**Acceptance Criteria:**

**Given** an output lot produced from consumed materials
**When** its genealogy is queried (FR-MO-11)
**Then** the full as-consumed lot genealogy is returned, listing every consumed input lot and quantity

**Given** a lot-controlled component (FR-MO-11)
**When** consumption is attempted without a recorded lot
**Then** the consumption is blocked until a valid lot is recorded

**Given** an order is submitted for closure (FR-MO-12)
**When** the closure gate runs
**Then** closure succeeds only when WIP is zero, no picks are open, and the disposition-status projection maintained by Epic 8 (FR-Q-05, a declared dependency of this epic) shows a recorded QC disposition for every output lot; a non-zero WIP or an undispositioned lot blocks closure

**Given** a Closed production order (FR-MO-12)
**When** any issue, completion, return, scrap declaration, or field edit is attempted against it
**Then** the attempt is rejected with `error_code: "ORDER_CLOSED"` and written to the edit log — closed orders are immutable

**Given** plant execution occurs offline (FR-MO-13)
**When** the device reconnects
**Then** replicated order data is replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`, and release, cancel, and close remain central-only operations

**Given** an offline device attempts a release, cancel, or close operation (FR-MO-13)
**When** the operation is invoked offline or arrives in a replayed queue
**Then** it is blocked client-side while offline and, if replayed, rejected server-side with `error_code: "CENTRAL_ONLY_OPERATION"` and an edit-log entry

**Given** a production order closes (FR-B-08)
**When** the closure event is processed
**Then** a consumption variance report is generated comparing actual component consumption to the BOM scrap-percent expectation; lines exceeding the tolerance threshold are flagged; the variance data is written to the read model and feeds the scrap-percent recalibration signal for the BOM module

---

## Epic 7: Maintenance, Calibration, and Asset Register

Maintenance technicians and supervisors work from one company-wide asset register spanning everything from a two-tonne mould to a hub screwdriver. Preventive maintenance plans auto-generate work orders, anyone can report a fault by scanning an asset tag, and the calibration register enforces a non-overridable lockout (FR-M-13) that no role can bypass. Technician workflows are fully offline. Instrument records loaded here (C-12) are the hard prerequisite for the calibration lockout in Epic 8.

### Story 7.1: Asset Register and Criticality Classification

As a maintenance manager,
I want a single company-wide maintainable asset register with criticality classes and scannable QR tags, and an optional link to the fixed-asset record,
So that every physical asset has exactly one maintenance record of truth.

**Acceptance Criteria:**

**Given** a physical asset that requires maintenance
**When** it is registered (FR-M-01)
**Then** a single asset record is created with a criticality class and a scannable QR tag, spanning the range from a two-tonne mould to a hub screwdriver

**Given** an asset being registered (FR-M-01)
**When** the maintenance record is created
**Then** the record carries an optional, nullable fixed-asset reference field captured as a free identifier, which may be left empty; no lookup against a fixed-asset module is performed

**Given** an asset already exists in the register with a given serial number (or manufacturer + model + serial combination where no serial exists)
**When** a duplicate registration is attempted for the same uniqueness key
**Then** creation is blocked with `error_code: "DUPLICATE_ASSET"` to preserve the one-asset, one-record rule

**Note:** Deferred to Phase 2 (Epic 17): validation of the fixed-asset reference against FR-FA fixed-asset records; until then the link is a nullable external reference only.

---

### Story 7.2: Preventive Maintenance Plans and Work Order Generation

As a maintenance planner,
I want calendar-based and meter-based PM plans that auto-generate work orders with grace-window tracking, fed by a generic meter-reading ingestion API whose Phase-1 primary source is manually entered readings,
So that preventive maintenance happens on schedule without manual creation.

**Acceptance Criteria:**

**Given** an asset from Story 7.1
**When** a calendar-based or meter-based PM plan is defined (FR-M-02)
**Then** the plan auto-generates work orders as due, tracking each against its grace window

**Given** a generated PM work order that passes its grace window uncompleted (FR-M-02)
**When** the grace window expires
**Then** the work order transitions to an overdue state and an escalation alert is raised to the maintenance planner

**Given** a meter-based PM plan (FR-M-03)
**When** a technician or operator submits a manual meter reading against the asset
**Then** the reading is accepted through the meter-reading ingestion API, the asset's usage meter advances, and PM due calculations update accordingly

**Given** the meter-reading ingestion API (FR-M-03)
**When** a reading arrives from any registered source (manual entry in Phase 1; hub bookings and station equipment when their feeds come online)
**Then** the reading is applied identically regardless of source, and each reading records its source and capture method

**Given** a meter that has reported no readings for a configured interval
**When** the monthly reconciliation runs
**Then** a silent-meter alert is raised and the meter is reconciled

**Note:** Manual readings are the primary Phase-1 meter feed. Hub-booking usage publication into the meter-reading ingestion API is delivered by Epic 10 (Story 10.4, maker-hub machine-time booking), which is outside the pilot go-live slice; automated station-equipment ingestion is deferred to Phase 2 (INT-MTR-01). This story must not block on either feed.

---

### Story 7.3: Fault Reporting and Breakdown Work Orders

As a machine operator,
I want to report a fault by scanning an asset tag and have it reach the maintenance supervisor within 5 minutes, with breakdown work orders prioritized by criticality,
So that breakdowns are attended quickly and downtime is measured.

**Acceptance Criteria:**

**Given** any user encountering a fault
**When** they scan the asset tag and submit a fault report (FR-M-04)
**Then** a fault report is created and reaches the maintenance supervisor within 5 minutes

**Given** a fault report is accepted (FR-M-05)
**When** a breakdown work order is created
**Then** its priority is derived from the asset criticality and any safety flags, and it follows the breakdown work-order lifecycle under configurable SLAs

**Given** breakdown work orders with recorded downtime (FR-M-06)
**When** the monthly reliability report runs
**Then** MTTR and MTBF are computed from captured downtime both per asset and aggregated per criticality class

---

### Story 7.4: Spare Parts Cataloguing, Reservation, and Critical-Spares Alerts

As a maintenance storekeeper,
I want spares catalogued in inventory with where-used links from a maintenance-owned asset parts list, reservation and issue with timed returns, and critical-spares min-max alerts,
So that the right spares are on hand when a work order needs them.

**Acceptance Criteria:**

**Given** an asset from Story 7.1 (FR-M-07)
**When** its spare parts are defined
**Then** a maintenance-owned asset parts list (equipment BOM) is recorded against the asset register — a distinct entity from the Epic 5 manufacturing BOM, created in this story — and each spare shows where-used across the assets whose parts lists reference it

**Given** spare parts used in maintenance (FR-M-07, FR-M-08)
**When** they are catalogued in inventory
**Then** each spare is catalogued under the Epic 2 stock ledger (per FR-I) and can be reserved and issued against a work order, with returns due within 3 working days

**Given** a critical spare with defined min-max levels (FR-M-09)
**When** stock breaches the minimum
**Then** a same-day breach alert is raised

**Note:** Spares cataloguing, reservation, and issue ride on the Epic 2 stock ledger (declared dependency); no new inventory mechanics are built here. AMC, warranty, and insurance tracking moved to Story 7.7.

---

### Story 7.5: Calibration Register and Non-Overridable Lockout

As a QC manager,
I want a calibration register covering in-house and ISO 17025 certificates with staged expiry alerts and a non-overridable out-of-calibration lockout,
So that no measurement is ever taken on an instrument outside its calibration validity.

**Acceptance Criteria:**

**Given** a measuring instrument in the register (FR-M-12)
**When** its calibration is recorded
**Then** in-house and ISO 17025 certificates are stored with validity dates and alerts fire at 30, 14, and 7 days before expiry

**Given** an instrument whose calibration has expired (FR-M-13)
**When** any user attempts to use it for measurement
**Then** the system blocks the use with `error_code: "CALIBRATION_LOCKOUT"` and no role can override the lockout

**Given** an out-of-calibration lockout is escalated
**When** the escalation is processed
**Then** the escalation expedites re-calibration but never bypasses the lockout

---

### Story 7.6: Statutory Examinations, Cost Accumulation, and Machine Status Broadcast

As a maintenance supervisor,
I want statutory examination tracking that locks overdue assets, weighbridge re-stamping enforcement, cost accumulation per asset with a repair-vs-capitalize flag, and a fast machine-status broadcast gated by supervisor sign-off on return to service,
So that legal examinations, trade weighment integrity, lifecycle costing, and reliable status are all guaranteed.

**Acceptance Criteria:**

**Given** an asset subject to statutory examination (FR-M-14)
**When** its examination becomes overdue (e.g. OSH Code or 12-month weighbridge stamping)
**Then** the asset is locked from use until re-examined

**Given** a weighbridge that has undergone repair (FR-M-14)
**When** trade weighment is attempted before re-stamping
**Then** the weighment is blocked until the weighbridge is re-stamped

**Given** maintenance activities incurring cost (FR-M-15)
**When** work orders are closed
**Then** maintenance cost accumulates per asset for lifecycle costing, and any work order whose cost exceeds the configured capitalization threshold is flagged repair-vs-capitalize at closure

**Given** a machine changes operational status (FR-M-16)
**When** the change is recorded
**Then** the status broadcast reaches production planning and hub booking subscribers within 2 minutes

**Given** a machine in breakdown or maintenance status (FR-M-16)
**When** return-to-service is attempted without a recorded supervisor sign-off
**Then** the status change is rejected with `error_code: "APPROVAL_REQUIRED"` and the asset remains out of service until a supervisor signs off

**Note:** The trade-weighment block executes inside the Epic 3 FR-W weighbridge flow (declared dependency). Deferred to Phase 2 (Epic 17): routing of above-threshold repair-vs-capitalize flagged work orders into the FR-FA capitalization queue — Phase 1 captures the flag and threshold check at closure only. Offline technician workflows and closure codes moved to Story 7.8.

---

### Story 7.7: AMC, Warranty, and Insurance Tracking

As a maintenance manager,
I want AMC, warranty, and insurance records against assets with staged expiry alerts and a warranty check at work-order creation that only a reason-coded override can bypass,
So that contract coverage never lapses unnoticed and warranty-covered repairs are never paid for by mistake.

**Acceptance Criteria:**

**Given** assets under AMC, warranty, or insurance (FR-M-10)
**When** an expiry approaches
**Then** alerts are raised at 90, 60, and 30 days before expiry

**Given** a breakdown work order is created for an asset under warranty (FR-M-11)
**When** the work order is opened
**Then** the system performs a warranty check and flags that the repair may be covered before chargeable work proceeds

**Given** a warranty-flagged work order (FR-M-11)
**When** chargeable work is attempted without a recorded reason-coded override
**Then** the work is blocked with `error_code: "APPROVAL_REQUIRED"` until an override with a reason code is recorded

**Given** a reason-coded override is recorded on a warranty-flagged work order (FR-M-11)
**When** chargeable work then proceeds
**Then** the override, its reason code, and the overriding actor are captured in the event stream

---

### Story 7.8: Offline Technician Workflow and Closure Codes

As a maintenance technician,
I want my day-to-day workflows — fault reporting, work-order status updates, meter readings, spares issue confirmation, and work-order closure — to function fully offline with clean sync, conflict flagging, and three-part closure coding,
So that maintenance work continues uninterrupted in the plant and every closure builds the asset's failure history.

**Acceptance Criteria:**

**Given** a technician device operating offline (FR-M-17)
**When** fault reports, work-order status updates, meter readings, spares issue confirmations, or work-order closures are captured
**Then** each is stored locally with an `idempotency_key` and, on reconnection, replayed in sequence with duplicate suppression via `error_code: "DUPLICATE_EVENT"`

**Given** an offline-captured event that conflicts with a change accepted centrally while the device was offline (FR-M-17)
**When** the replay is processed
**Then** the conflicting event is rejected with `error_code: "STREAM_CONFLICT"`, flagged in a sync-conflict queue, and surfaced to the maintenance supervisor for resolution

**Given** a work order is submitted for closure (FR-M-18)
**When** closure codes are applied
**Then** three-part closure coding — fault, cause, and remedy — is recorded, and closure is rejected until all three codes are present

**Given** a work order is opened for an asset (FR-M-18)
**When** the technician views the work order
**Then** the last five closures for that asset (fault, cause, remedy) are presented at work-order open

**Note:** Offline behavior covers the technician flows delivered in Stories 7.2-7.6 and follows the Epic 1 edge sync foundation (PowerSync, idempotency keys). Return-to-service sign-off (Story 7.6) remains a central-only operation.

---

### Story 7.9: Spare Min-Max Level Amendment

As a maintenance storekeeper,
I want to amend the min-max levels of a catalogued critical spare without re-cataloguing it,
So that stocking levels that change monthly stay current and the same-day breach alert (Story 7.4) keeps firing against the right thresholds.

**Acceptance Criteria:**

**Given** a spare already catalogued under Story 7.4 (FR-M-09)
**When** the storekeeper submits new min and max levels for it
**Then** an amendment event is recorded against the existing catalogue row, the alert evaluation uses the new levels from the next sweep, and the previous levels remain readable in the row's history

**Given** an amendment whose min is not below its max, or whose spare is not catalogued
**When** it is submitted
**Then** it is refused with an explicit `error_code` and no row changes

**Given** a second POST of the original catalogue shape on an occupied (sku, location) key
**When** it is submitted
**Then** it is still refused `SPARE_ALREADY_CATALOGUED`; amendment is the only edit path

**Note:** Created 2026-09-12 from the pilot-blocking triage (deferred-work ledger row 326, ruled 2026-09-04 "required before go-live"). Same role and module gate as the Story 7.4 catalogue route; no edge scope.

---

### Story 7.10: Calibration Certificate Void and Supersede

As a QC manager,
I want to void a wrongly recorded calibration certificate or supersede it with a corrected one,
So that a wrong validity date neither locks a good instrument nor unlocks an expired one, without weakening the non-overridable lockout (Story 7.5).

**Acceptance Criteria:**

**Given** a certificate recorded under Story 7.5 (FR-M-12, FR-M-13)
**When** the QC manager voids it with a reason
**Then** a void event is recorded, the certificate no longer counts toward the instrument's calibration status, the lockout is re-evaluated from the remaining certificates, and the voided row stays readable with its reason and actor

**Given** a certificate with a wrong validity date
**When** the QC manager supersedes it with a corrected certificate
**Then** the corrected certificate is recorded, the original is marked superseded in the same transaction, and the 30/14/7-day alert schedule is recomputed from the corrected dates

**Given** an instrument whose only valid certificate is voided
**When** the void is recorded
**Then** the `CALIBRATION_LOCKOUT` bar applies immediately and no role can override it

**Given** a void or supersede on a certificate the actor did not record
**When** it is submitted
**Then** it is accepted only from the QC manager role; the recording inspector cannot void their own certificate (segregation, same shape as SOD-07)

**Note:** Created 2026-09-12 from the pilot-blocking triage (deferred-work ledger row 343, ruled 2026-09-04 "required before go-live"). Certificates remain append-only; void and supersede are new events, never edits.

---

### Story 7.11: Maintenance Supervisor Desk

As a maintenance supervisor (maintsup1@ancorlabs.org, role `maintenance_supervisor` on module maintenance with location `*`, `docs/migration/pilot-mock-extract/roles.json:492-498`),
I want a desk with my work order board, fault triage, warranty override, return-to-service sign-off and the sync-conflict queue,
So that a reported fault becomes a breakdown work order and a repaired asset returns to running without API calls by hand.

**Acceptance Criteria:**

**Given** a caller who is the active DOA holder of `maintenance.return_to_service`, `maintenance.warranty_override` or `maintenance.sync_conflict_resolution` (world.json:961-979)
**When** the bootstrap runs
**Then** navigation carries `Maintenance desk` from a new row `{ name: 'Maintenance desk', modules: 'maintenance-desk', functionScope: 'write' }` with the modules union (`src/api/v1/edge.ts:364-368`) widened and a `hasMaintenanceDeskScope` branch in `navigationFor` (`:400-420`) pairing `findFirstActiveDoaEntry(transactionType)` (`src/read/projections/doa_registry.ts:232`) with `isActiveRoleHolderForEntry(entryId, userId)` (`:338`) over the three types, as `setAssetStatusBase` does via `resolveApprover` (`src/api/v1/maintenance.ts:3747-3760`); the technician maint1@ (maintenance write at site, `roles.json:478-484`) is not sent it (a module-based row would advertise the desk to the technician); NAV_ENTRIES gains `{ name: 'Maintenance desk', href: '/maintenance/desk', label: 'nav.maintenanceDesk' }`; `maintenance-desk` joins BaseView, BASE_VIEW_ENTRY and VIEW_NAV_ENTRY (`edge/src/components/app-shell.tsx:130-160`) so a deep link renders the no-access card (`:349-355`); an integration test beside `test/integration/story-1-15.test.ts:514-560` proves both callers; `edge/test/unit/nav-model.test.ts` asserts the entry

**Given** `GET /api/v1/maintenance/fault-reports?status=reported&limit=500` and `?status=accepted&limit=500` (`src/api/v1/maintenance.ts:1277-1300`; `safety_flag` lives on the fault report, `src/read/projections/maintenance_fault_report.ts:13`, joined on `work_order.fault_report_id`), `GET /api/v1/edge/maintenance/worklist?limit=500` (open, overdue, in_progress, on_hold only, `src/read/projections/maintenance_work_order.ts:444`), `GET /api/v1/maintenance/work-orders?status=completed&limit=500` (`src/server.ts:982`), `GET /api/v1/maintenance/asset-status?limit=500` (`:1067`) and `GET /api/v1/maintenance/sync-conflicts?status=open&limit=500` (`:1101`) have loaded
**When** the board renders
**Then** five groups with counts show To triage (fault reports reported), Assigned / accepted (work orders open or overdue; mock label key-maintenance.html L814 kept, no-assignment reading recorded under EXPERIENCE.md:138), In progress, Waiting spares (on_hold with `status_note` as the pill text, L829) and Done - sign-off (completed work orders whose `asset_operational_status` is breakdown or maintenance); each card carries `work_order_id` or `fault_report_id`, a text priority pill P1 to P4 or Unset (L477), `asset_tag` and asset name as the title line (backend work orders have no title; deviation from L833 recorded), and the pills Warranty-flagged (`warranty_flagged` and no override), Awaiting signature (Done group) and, for fault-report cards, Safety hazard; Desktop and Desktop touch render columns, Handheld and Tablet a grouped list (EXPERIENCE.md:138, L436); the three attention buttons Awaiting signature (n), Sync conflicts (n), Warranty-flagged (n) open the first matching card's detail or the conflict panel and announce `Nothing awaiting signature` or `No warranty-flagged work orders` when empty (L820-822, L1030-1032); the worklist `total` and `truncated` (`src/api/v1/edge.ts:968-976`) state how many were not loaded and any other list returning exactly 500 rows shows the 500+ marker

**Given** a fault report in To triage
**When** Create work order is tapped
**Then** `POST /api/v1/maintenance/fault-reports/:id/accept` is called with an empty body (the handler reads none, `maintenance.ts:1375`), the work order appears in Assigned / accepted with status open and its SLA-derived priority read-only (`policy.priority` from `getActiveSlaPolicy(criticality_class, safety_flag)`, `maintenance.ts:1396-1428`), a `Safety hazard flagged by reporter - Isolate the asset before work starts` banner renders first when `safety_flag` is true (L872), Reject requires `rejection_reason` (trimmed, non-empty, `maintenance.ts:1522-1528`) and calls `POST .../reject` (not in the mock; owner question Q31), and `FAULT_ALREADY_TRIAGED`, `SLA_POLICY_NOT_FOUND`, `FAULT_REPORT_NOT_FOUND` and `ASSET_NOT_FOUND` render from `errors.*`; the mock's P1 to P4 segment and Assign technician select (L876-882) are deferred

**Given** a work order with `warranty_flagged` true (`maintenance_work_order.ts:33`) and no row from `GET /api/v1/maintenance/work-orders/:id/warranty-overrides` (`src/server.ts:1091-1094`)
**When** one configured reason code is chosen from tiles and Override - repair in-house is tapped
**Then** `POST /api/v1/maintenance/work-orders/:id/warranty-overrides { reason_code }` is called (`maintenance.ts:4307-4362`; catalogue `config.maintenance.warrantyOverrideReasonCodes`, defaults OUT_OF_WARRANTY_SCOPE, WARRANTY_NOT_APPLICABLE, PREVIOUS_UNAUTHORIZED_REPAIR, EMERGENCY_REPAIR at `src/config/index.ts:517-525`, each trimmed, max 200), the card reads `Warranty overridden - repair in-house` with `overridden_by` and `overridden_at` from the `{ override }` response (L898), Call OEM under warranty stays a secondary no-op (L886), and `WARRANTY_OVERRIDE_ALREADY_RECORDED`, `WARRANTY_OVERRIDE_NOT_REQUIRED`, `WARRANTY_OVERRIDE_REASON_INVALID`, `APPROVAL_REQUIRED` and `APPROVAL_UNRESOLVED` render from `errors.*`; no free-text reason (mock L899-900 is superseded by the 7.7 reason-code contract); Task 1 adds `GET /api/v1/maintenance/warranty-override-reason-codes` (mirror of `GET /api/v1/maintenance/closure-codes`, `src/server.ts:1100`, maintenance read) because today the catalogue is reachable only through `details.allowed` on the 400

**Given** a completed work order in Done - sign-off
**When** the three checklist items are ticked and Sign return to service tapped
**Then** `POST /api/v1/maintenance/assets/:assetId/status { new_status: 'running' }` is called (`maintenance.ts:3696-3786`), the card reads Returned to service with `sign_off_by` and `sign_off_at` from `GET /api/v1/maintenance/assets/:assetId/status` (`src/server.ts:1069`; `src/read/projections/asset_operational_status.ts:14-15`) and leaves the group, Sign stays disabled until all three are ticked with the reason shown (ticks are device-side only, owner question Q30), and 423 `STATUTORY_EXAMINATION_OVERDUE` (`maintenance.ts:3712-3722`, raised before the DOA check), 404 `APPROVAL_UNRESOLVED` (`:3751`), 403 `APPROVAL_REQUIRED` (`:3762`) and 400 `INVALID_STATUS_TRANSITION` (`:3734`) render from `errors.*` with the asset left out of service

**Given** an open sync conflict
**When** it opens
**Then** `conflicting_event_type`, `device_id`, `captured_by`, `occurred_at`, `raised_at`, `expected_version` against `head_version`, `reason` (version_conflict or safety_fault_rejected), `rejection_code` and key `conflicting_payload` fields render (`src/read/projections/maintenance_sync_conflict.ts:12-37`), two tiles Keep server reading (resolution_code `discarded`) and Keep both, re-entered centrally (`reapplied_centrally`) with an optional `resolution_note` of at most 1000 characters (`src/compliance/maintenance-sync-conflict.ts:51`), Resolve conflict calls `POST /api/v1/maintenance/sync-conflicts/:id/resolve { resolution_code, resolution_note }` (`maintenance.ts:4660-4681`), the button count drops, and `SYNC_CONFLICT_ALREADY_RESOLVED`, `SYNC_CONFLICT_NOT_FOUND`, `APPROVAL_REQUIRED` and `APPROVAL_UNRESOLVED` render from `errors.*`; `reapplied_centrally` records only (deferred-work.md:419, row 491) and the card says so; Send back to technician (mock L914-923) is deferred

**Given** the device is offline
**When** the desk is open
**Then** the last fetched board shows under the banner `Offline - needs a live connection` with the copy `Showing the board from the last sync. Signing, overrides, conflict resolution and triage are disabled until you reconnect.` (mock L863), every action is disabled with the reason, nothing is written to the outbox, and lists re-fetch on online; with no earlier fetch the needs-connection card (`edge/src/components/damage-cases.tsx:41`) replaces the board

**Given** the four device classes
**When** axe and a keyboard-only pass run
**Then** zero WCAG 2.1 AA violations, every pill carries text, focus returns to the board after a panel closes, 56/48/34 px targets, strings under `maintenanceDesk.*` and `nav.maintenanceDesk`, new keys `errors.FAULT_ALREADY_TRIAGED`, `errors.SLA_POLICY_NOT_FOUND`, `errors.WARRANTY_OVERRIDE_ALREADY_RECORDED`, `errors.WARRANTY_OVERRIDE_NOT_REQUIRED`, `errors.WARRANTY_OVERRIDE_REASON_INVALID`, `errors.SYNC_CONFLICT_ALREADY_RESOLVED`, `errors.SYNC_CONFLICT_NOT_FOUND` and `errors.STATUTORY_EXAMINATION_OVERDUE` in `edge/src/messages/en.json` (none exists today), and `edge/test/unit/i18n-literals.test.ts` ALLOWED_LITERAL_PATTERNS extended

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes audit gap G09; touches G10 and G18 only through the shared nav tables, so audit fix-now item 5 (technician Maintenance nav row) lands first. Depends on 7.3, 7.6, 7.7, 7.8, 1.14, 1.15, 8.9 (done). Online-only; company-wide board as shipped (deferred-work.md row 512, owner question Q32). Deferred: technician assignment (no `assigned_to` in `src/read/projections/maintenance_work_order.ts`), triage priority override, send back to technician. Size L.

---

## Epic 8: Quality Control and Batch Release

QC inspectors and heads disposition every finished goods lot before it reaches sellable stock — there is no bypass, and urgency is served by conditional release, not by skipping the gate (FR-Q-02). AQL sampling, calibration-locked result capture, CoA/CoC, NCR/CAPA, BIS and Legal Metrology hooks, and customer-witnessed inspections are all enforced workflows. Quality holds propagate everywhere within 15 minutes (FR-Q-09). Instrument records from Epic 7 (C-12) must exist before the calibration lockout activates here.

### Story 8.1: Inspection Plans and QC Gate

As a QC head,
I want versioned inspection plans per product-spec revision with customer-spec overrides, and all completions to post into QC Hold with no bypass,
So that every lot is inspected against the correct, approved specification before release.

**Acceptance Criteria:**

**Given** a product with a specification revision
**When** a QC head creates and approves an inspection plan (FR-Q-01)
**Then** the plan is versioned to that spec revision and only QC Head-approved plans are usable for disposition

**Given** a job-work order with a customer specification
**When** the inspection plan is resolved (FR-Q-01)
**Then** the customer-spec override applies for that order in place of the standard plan

**Given** a completion event conforming to the QC completion-event contract published by this story (FR-Q-02)
**When** it posts — finished job-work output (Story 9.4) at pilot, production completions (Story 6.3) when Epic 6 lands (Epic 6 depends on this epic), or a synthetic contract-conformance test event
**Then** the resulting lot enters QC Hold with no bypass path to sellable stock

**Given** an urgent need to move a lot before full inspection completes (FR-Q-02, FR-Q-05)
**When** a user whose authority the DOA registry resolves (Story 1.4) requests conditional release
**Then** a deviation record with the recorded conditions and an expiry is created and the lot moves to the distinct `Conditionally Released` state rather than bypassing the gate

**Given** a lot in QC Hold
**When** conditional release is requested by a user the DOA registry does not resolve as authorized
**Then** the request is rejected with `error_code: "APPROVAL_REQUIRED"`

---

### Story 8.2: AQL Sampling and Result Capture

As a QC inspector,
I want AQL sampling per IS 2500 / ISO 2859-1 with switching rules, 100% inspection of critical characteristics, and result capture bound to calibrated instruments,
So that sampling is statistically valid and results are trustworthy.

**Acceptance Criteria:**

**Given** a lot in QC Hold with an approved inspection plan carrying the plan's AQL value and inspection level (General Inspection Level II unless the plan overrides it)
**When** sampling is determined (FR-Q-03)
**Then** the sample size and acceptance number follow the IS 2500 / ISO 2859-1 tables for that AQL value and inspection level, with normal/tightened/reduced switching rules applied per the standard's switching criteria

**Given** a plan defining critical characteristics
**When** inspection is performed
**Then** critical characteristics are inspected 100% while other characteristics follow the AQL sample

**Given** an inspector records a measured result (FR-Q-04)
**When** the result is captured
**Then** it is bound to the measuring instrument's asset ID

**Given** the chosen instrument is out of calibration (integration with Story 7.5 / Story 1.7)
**When** the inspector attempts to record a result with it
**Then** the capture is rejected with `error_code: "CALIBRATION_LOCKOUT"`

---

### Story 8.3: Lot Disposition — Accept, Reject, Conditional Release

As a QC inspector,
I want exactly one recorded disposition per lot with partial-split support and NCR outcomes that route to rework, downgrade, or scrap,
So that every lot has a single authoritative quality outcome.

**Acceptance Criteria:**

**Given** a lot that has been inspected (FR-Q-05)
**When** a disposition is recorded
**Then** exactly one disposition (accept, reject, or conditional release) is stored per lot and a second disposition attempt is rejected with `error_code: "DISPOSITION_EXISTS"`

**Given** a lot where only part of the quantity conforms (FR-Q-05)
**When** the inspector splits the lot
**Then** partial splits are supported with independent dispositions per split, the sum of split quantities equals the original lot quantity, and a split allocating more than the lot contains is rejected with `error_code: "INSUFFICIENT_STOCK"`

**Given** a rejected lot raising an NCR (FR-Q-06)
**When** the NCR outcome is set
**Then** the outcome routes to rework (re-enters the gate), downgrade to seconds, or scrap — a scrap outcome records the scrap disposition and moves the quantity to `Blocked` (scrap-pending), retaining the event for Phase 2 FR-SC processing

**Given** an NCR outcome of rework (FR-Q-06)
**When** the rework outcome is recorded
**Then** the lot is flagged for rework and a rework-requested event is emitted; when Story 6.3 lands (Epic 6 depends on this epic), the linked rework order it creates produces a new lot that re-enters the QC gate

**Dev Notes:**

- Deferred to Phase 2 (Epic 16): the physical scrap disposal workflow ("scrap to FR-SC" in FR-Q-06). In Phase 1 an NCR scrap outcome parks quantity in `Blocked` (scrap-pending); Epic 16 subscribers consume the retained events without changes to this story.
- Rework-order creation is delivered by Story 6.3 (Epic 6, which depends on this epic); this story's rework-requested event is the integration contract and is testable with a synthetic subscriber before Epic 6 lands.

---

### Story 8.4: CoA/CoC, Retention Samples, and Batch Release Records

As a QC head,
I want batch release records with CoA/CoC per lot, a 7-year retention default, and retention-sample logging that blocks release until done,
So that every released lot is certified and evidentially retained.

**Acceptance Criteria:**

**Given** an accepted lot (FR-Q-07)
**When** it is released
**Then** a batch release record and a CoA or CoC are generated for the lot and retained for a default 7 years, and for BIS-covered products never below the retention period mandated by the applicable BIS Scheme of Testing and Inspection (STI)

**Given** a BIS-covered product whose STI mandates a retention period longer than the configured value (FR-Q-07)
**When** an administrator attempts to configure retention below the STI floor
**Then** the configuration is rejected with `error_code: "RETENTION_FLOOR_VIOLATION"`

**Given** an accepted lot of a BIS-covered product (FR-Q-11)
**When** the CoC is generated
**Then** the CM/L or R-number from the Story 8.7 licence register is printed on the CoC

**Given** a lot requiring a retention sample (FR-Q-08)
**When** release is attempted before the retention sample is logged
**Then** release is rejected with `error_code: "RETENTION_SAMPLE_REQUIRED"` until the retention sample is recorded

**Given** a retention sample approaching its expiry (FR-Q-08)
**When** the expiry alert fires 30 days before expiry
**Then** a recorded disposal event routes the sample to `Blocked` (disposal-pending)

**Dev Notes:**

- Deferred to Phase 2 (Epic 16): physical disposal of expired retention samples. Phase 1 records the disposal event and parks the sample in `Blocked` (disposal-pending) for FR-SC processing.

---

### Story 8.5: Quality Holds and Recall Trace

As a QC head,
I want quality holds that flip stock to Blocked everywhere within 15 minutes with full where-used and where-shipped trace, and NCR/CAPA linkage with repeat-defect enforcement,
So that a quality problem can be contained and traced across the whole supply chain quickly.

**Acceptance Criteria:**

**Given** a quality issue on a lot (FR-Q-09)
**When** a quality hold is placed
**Then** all instances of that stock flip to `Blocked` on every connected node and a where-used and where-shipped trace is available within 15 minutes — where-shipped over Epic 3 dispatch documents (Story 3.7) and the Story 2.3 lot trace, where-used over whatever consumption event types exist (job-work consumption from Story 9.3; production genealogy from Story 6.4 deepens the trace when Epic 6 lands)

**Given** an edge device that was offline when the hold was placed (FR-Q-09)
**When** the device reconnects
**Then** the hold is applied on the device immediately on reconnect and any queued transaction against the held lot is rejected on replay with `error_code: "LOT_ON_HOLD"` and flagged for supervisor review — the central write path (Story 2.3) and dispatch gate (Story 3.7) reject held-lot transactions throughout, regardless of device state

**Given** a held or defective lot (FR-Q-10)
**When** an NCR is raised
**Then** it carries a defect code and is linked to a CAPA record

**Given** three or more NCRs for the same product and defect within 90 days (FR-Q-10)
**When** the next matching NCR is raised
**Then** a CAPA is mandatory before the NCR can be closed, returning `error_code: "APPROVAL_REQUIRED"` until the CAPA is linked

---

### Story 8.6: Statutory Release Blocks and Quality Reporting

As a compliance officer,
I want BIS licence validity and Legal Metrology label version control to block release against the Story 8.7 compliance master data, and a quality reporting dashboard over the FR-Q-13 metrics,
So that no lot ships without its statutory quality gates satisfied and quality performance is measurable.

**Acceptance Criteria:**

**Given** a product requiring a BIS licence (FR-Q-11)
**When** release is attempted and the Story 8.7 licence register holds no valid, unexpired licence for the product
**Then** release is rejected with `error_code: "BIS_LICENCE_INVALID"`

**Given** a product requiring a BIS licence with a valid licence in the Story 8.7 register (FR-Q-11)
**When** release completes
**Then** the CM/L or R-number from the register is printed on the release record

**Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14)
**When** release is attempted without a current approved label version in the Story 8.7 label masters
**Then** release is rejected with `error_code: "LABEL_VERSION_MISSING"` until the version-controlled, approved label is in place

**Given** a QC head opens the quality reporting dashboard (FR-Q-13)
**When** the dashboard loads
**Then** it shows first-pass yield (lots accepted on first disposition / lots dispositioned in the period), rejection rates by product and defect code, NCR and CAPA aging, conditional-release counts, and calibration lockout event counts, each with drill-through to the underlying disposition, NCR, CAPA, or lockout records

**Dev Notes:**

- Witnessed inspections (FR-Q-15) and prototype stock rules (FR-Q-12) moved to Story 8.8; the compliance master data these blocks check (licence register, label masters) is created in Story 8.7.
- The FR-Q-13 metrics stay in this epic per the reporting scope note (module dashboards live in module epics); the Epic 12 executive layer consumes them without change.

---

### Story 8.7: Compliance Master Data — BIS Licence Register and Label Masters

As a compliance officer,
I want a governed BIS licence register with CM/L and R-numbers and validity dates, and version-controlled Legal Metrology label masters with an approval workflow,
So that the statutory release blocks in Story 8.6 check against maintained, authoritative master data instead of a bare flag.

**Acceptance Criteria:**

**Given** a product covered by BIS certification (FR-Q-11)
**When** a compliance officer creates or updates its licence record
**Then** the register stores the licence number and type (CM/L or R-number), the covered products, and the validity dates, and every change is edit-logged (FR-AC-13)

**Given** a BIS licence approaching its validity end date (FR-Q-11)
**When** the 90/60/30-day alert windows are reached
**Then** expiry alerts fire to the compliance officer, and on expiry the licence is marked invalid so Story 8.6 rejects dependent releases with `error_code: "BIS_LICENCE_INVALID"`

**Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14)
**When** a new label version is drafted
**Then** the label master is version-controlled, and only after approval resolved through the DOA registry (Story 1.4) does the version become the single current approved version, superseding its predecessor

**Given** a draft label version pending approval (FR-Q-14)
**When** a user the DOA registry does not resolve as authorized attempts to approve it
**Then** the approval is rejected with `error_code: "APPROVAL_REQUIRED"`

**Dev Notes:**

- Migration sequencing (A-13): BIS licence data is loaded into this register before the Story 8.6 FR-Q-11 release block goes live. Story 2.1's item-master BIS licence flag marks which products the register must cover; this story owns the licence schema and its ongoing renewal maintenance.

---

### Story 8.8: Witnessed Inspections and Prototype Stock Rules

As a QC head,
I want customer-witnessed and third-party inspection hold points with recorded notices and waivers, and prototype stock structurally barred from sellable status at the stock-class level,
So that contractual inspection obligations are met with evidence and no prototype can ever reach saleable stock.

**Acceptance Criteria:**

**Given** an order requiring customer-witnessed or third-party inspection (FR-Q-15)
**When** a hold point is reached
**Then** the lot is held at the hold point — dispatch is rejected by the Story 3.7 gate with `error_code: "LOT_ON_HOLD"` — until the witness signs off or a recorded waiver approved through the DOA registry (Story 1.4) is applied

**Given** a scheduled witnessed or third-party inspection (FR-Q-15)
**When** notice is given to the customer or third party
**Then** the notice is recorded (recipient, date, and method) against the hold point before the inspection is held

**Given** stock in the prototype (non-saleable) stock class (FR-Q-12)
**When** any transaction attempts to move it to sellable status or allocate it to a dispatch
**Then** the transaction is rejected with `error_code: "PROTOTYPE_NOT_SALEABLE"` — enforced at the stock-class level and testable with Epic 2 lot data alone

**Dev Notes:**

- Sequencing (FR-Q-12): prototype build records and design-evidence capture originate in Story 10.3 (Epic 10, sequenced after this epic and outside the pilot slice). This story delivers the stock-class bar so the control is active before any prototype exists; verification-as-design-evidence is captured against Story 10.3's build records when Epic 10 lands.

---

### Story 8.9: Report Damage - Universal Capture, QC Task, and Commercial Outcome

As any employee who finds damaged material,
I want to report it from any device by scanning the lot or item, and have the units held, QC decide, and finance settle a commercial outcome,
So that damage found anywhere becomes governed evidence with a concurred resolution instead of an informal write-off (realizes the "A dead PCB on the line" key flow).

**PILOT. Ratified in the UX run 2026-09-23 to 2026-09-26 (`ux-designs/ux-Inventory Management System_2-2026-09-23/`, EXPERIENCE.md damage governance and concurrence rules, Q5 ruling on the four outcomes, Key Flow "A dead PCB on the line"). Hooks FR-P-07 (debit notes). Reuses the Story 8.5 hold machinery and feeds Story 1.15's base-role capture. Created 2026-09-26 by `sprint-change-proposal-2026-09-26.md`.**

**Acceptance Criteria:**

**Given** any signed-in role on any device, including the Story 1.15 employee base role
**When** they report damage by scanning the lot or item and capturing a reason and a photo
**Then** the report is accepted (offline-capable, Story 1.8 pattern), the reported units go on quality hold, and an ad-hoc QC inspection task opens for them

**Given** a reporter who suspects the damage extends beyond the scanned units
**When** they mark "Suspect whole lot"
**Then** that is recorded as a request, not a hold - the QC head decides whether the hold widens to the lot

**Given** a completed ad-hoc QC inspection confirming damage
**When** the resolution is decided
**Then** it requires QC and finance concurrence keys, with disagreement escalating to the CEO band via the DOA registry

**Given** finance concurrence
**When** the commercial outcome is recorded
**Then** it is exactly one of: debit note (FR-P-07), return for replacement, write-off, or accept as-is with price reduction - recorded in IMS and executed in ERP, with the IMS record carrying the ERP reference

**Given** a reporter who also needs the material replaced
**When** they choose report-and-request-replacement
**Then** it is one flow - the replacement becomes a requisition under normal approval rules (Story 4.3, standing approvals per Story 4.8 where they apply), linked to the damage report

---

### Story 8.10: Receipt-Lot QC Task, QC-Governed Putaway Release, Observation Note and Photo (server)

As the QC head,
I want receipt lots held in ZONE-QC-HOLD to open a real QC inspection task, an accept disposition to release the held putaway, observations to carry text and a photo, and disposition to be QC-head gated,
So that the 8.11 screen can inspect, disposition and release a BIS or quarantine lot.

**Acceptance Criteria:**

**Given** `goods.received` with `needsQcHold` true (`item.bis_licence_required` or `item.quarantine_required`, `src/compliance/receiving.ts:1110-1116`) and a resolved `lot_id`
**When** a new non-throwing lookup wrapping `resolveInspectionPlanForLot` (`src/compliance/quality.ts:1898-1993`; today it throws `INSPECTION_PLAN_NOT_FOUND`, `INSPECTION_PLAN_AMBIGUOUS` or `INSPECTION_PLAN_NOT_APPROVED` and takes a non-null `bom_revision_id`) finds an approved plan for the item at the receipt business date
**Then** the receiving seam inserts a `qc_inspection_task` in the same transaction with `source_completion_type` `goods_receipt` and `source_completion_id` equal to `grn_line_id`, after widening `SOURCE_COMPLETION_TYPES` (`quality.ts:264-268`, `:675-682`), dropping and re-adding `chk_qc_inspection_task_source_type` (`read/projections/qc_inspection_task.sql:73`; `deploy/compose/init-db.sql:9818`, `:9873`), making `bom_revision_id` nullable for this source only (`init-db.sql:9795`, owner question Q35) and relaxing the finished-stock quantity and allocation check of `applyCompletionReceived` (`quality.ts:2097-2147`) for the receipt arm; replay is idempotent through `getQcInspectionTaskBySource` (`src/read/projections/qc_inspection_task.ts:159`) under `uq_qc_inspection_task_source` (`init-db.sql:9816`); `GET /api/v1/qc/tasks` (`src/server.ts:1137`) lists it; when the resolver reports no plan the seam opens no task, keeps the held putaway plus the `qc_hold_placed` notification (`receiving.ts:1455-1470`) and records `no inspection plan` in a new `putaway_task.hold_reason` column and the notification next step (owner question Q33); a receipt with no `lot_id` (`receiving.ts:1441`) opens no task and is recorded the same way with `no lot` (owner question Q36)

**Given** a `goods_receipt` task
**When** `qc.lot_dispositioned` accept (or the accepted child of a `qc.lot_split_recorded`) is applied in `applyLotDispositioned` (`src/compliance/quality.ts:2508`; the recorder-may-not-accept SoD at `:2524-2530` is kept)
**Then** the task's held putaway (`putaway_task.grn_line_id` equal to `source_completion_id`, status held, owner role `qc_inspector`, `receiving.ts:1443-1448`) is released in the same transaction via `markPutawayReleased` with `released_by` the disposition actor and reason `qc_accept`, and a `goods.putaway_released` event is emitted whose admissibility accepts a `disposition_id` in place of the `receiving.putaway_release` DOA check (`receiving.ts:189-200`; `RECEIVING_APPROVER_ROLES` at `:98` stay for the manual path); `assertDamageCaseAllowsRelease` (`receiving.ts:1530-1531`, `src/compliance/damage.ts:1952-1974`) still runs so a line that also has an open damage case stays held; reject leaves the putaway held; `GET /api/v1/putaway-tasks?status=ready` (`src/server.ts:805`) then lists it; today the only release paths are the receiving-supervisor DOA release (`receiving.ts:1534`) and the Story 8.9 damage-case clearance, and a clean BIS or quarantine_required lot has neither

**Given** `POST /api/v1/qc/tasks/:taskId/observations`, today a per-characteristic readings batch requiring `characteristic_id` and `readings` (`src/api/v1/quality.ts:1198-1230`, `:1293`)
**When** the payload is a free-text observation `{ note (max 1000), attachment_id }` with the attachment owned by the caller (owner check per `src/compliance/damage.ts:1120` precedent)
**Then** both persist on a new observation note row returned by the task results read, the route accepts either body shape (or a sibling `POST .../notes` route is added and named in the story), and `qc.observation_recorded` stays central-only on the edge door (`src/sync/upload.ts:335-343`)

**Given** `POST /api/v1/qc/tasks/:taskId/disposition` and `/split` (`src/api/v1/quality.ts:2217`, `:2220`; today `requireRole` module qc write only)
**When** the actor role is not in `config.quality.qcHeadRoles` (`src/config/index.ts:652`, default `qc_head`; qchead1@ at `docs/migration/pilot-mock-extract/roles.json:569-573`)
**Then** the handler pre-check and the seam both return 403 `APPROVAL_REQUIRED` with `{ task_id, qc_head_roles }` in the Binding Scope Decision 9 pattern (`src/api/v1/quality.ts:1428-1437`, `src/compliance/quality.ts:3845-3852`), with no role literal in the seam; this overrides deferred-work.md:456 (row 583, reject needs no second signature) and that row is updated (owner question Q34)

**Given** `GET /api/v1/qc/tasks/:taskId` (`src/server.ts:1138`)
**When** the task is a `goods_receipt` task
**Then** the view joins `grn_line` by `source_completion_id` and carries `grn_number`, supplier name, received quantity, `line_condition`, `reason_code`, `reason_note`, `reason_photo_ref` (`src/read/projections/grn_line.ts:44-48`; the Story 3.11 columns composed by `describeReceiptReason`, `receiving.ts:1466`) and, once 3.14 lands, `inspect_on_opening`, `inspect_note`, `inspect_photo_ref` and `material_photo_ref`, plus the `putaway_task` row (status, `from_location_id`, quantity) and hold locations with quantities for the hold-scope card; task rows on `GET /api/v1/qc/tasks` gain `disposition`, `disposition_at` and `released_at` (`src/read/projections/qc_inspection_task.ts:85-89` carries none) and the list `gate_status` filter accepts accepted, rejected and split (`quality.ts:862-866`)

**Given** `test/integration/story-8-10.test.ts` (new) and `deploy/rehearsal/mock/operations-smoke.ts` (today seeds no inspection plan and calls no `/api/v1/qc` route)
**When** they run
**Then** one approved inspection plan per BIS pilot item is seeded via `POST /api/v1/qc/inspection-plans` and approve (`src/server.ts:1112`, `:1121`), the chain from `goods.received` with `needsQcHold` to `qc_inspection_task` to disposition accept to putaway status ready passes, the no-plan fallback, the reject arm leaving the putaway held, the damage-case-still-blocks case and the non-qc_head 403 arm are asserted, and the central-only property for the widened source type is proven like 8-3 story :121-124

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes the server half of audit gap G07. Depends on 8.1, 8.2, 8.3, 8.5, 8.9, 3.11 (done); 3.14 is a soft dependency for the inspect-on-opening fields only. Server only; no nav change. Record fixes: deferred-work.md:456 (row 583) points here; deferred-work.md:1157 is marked resolved by 8.9 (`receiving.ts:1530`) and a new line records the clean BIS or quarantine lot path; 8-3 UX Boundary :713-720 points to 8.11. Size L.

---

### Story 8.11: QC Inbox, Inspection Detail and Lot Disposition (edge)

As a QC inspector or QC head (qc1@ and qchead1@, `docs/migration/pilot-mock-extract/roles.json:549-553` and `:569-573`, module qc write),
I want an inbox of lots held for inspection, an inspection detail with results, observations and photo, and a disposition with hold scope,
So that a BIS or quarantine receipt lot is inspected and released to putaway from the PWA.

**Acceptance Criteria:**

**Given** a caller with a qc module assignment at the site
**When** the bootstrap runs
**Then** navigation carries `QC inbox` from a new row `{ name: 'QC inbox', modules: ['qc'], functionScope: 'read' }` after Standing grants (`src/api/v1/edge.ts:382`), NAV_ENTRIES gains `/qc/tasks` with label `nav.qcInbox`, `qc-tasks` and `qc-holds` join BaseView and BASE_VIEW_ENTRY, a deep link without the entry renders the no-access card, and `edge/test/unit/nav-model.test.ts` asserts the entry; the rehearsal roles file (`deploy/rehearsal/mock/out/MOCK-MUTT2R97/roles.json:374-393`) grants module `quality` only and gains a qc assignment or the entry never appears on the rehearsal stack

**Given** tasks at the site
**When** `/qc/tasks` loads online
**Then** groups render in order: In inspection bay - to inspect (two calls `GET /api/v1/qc/tasks?site_id=&gate_status=qc_hold&task_status=open` and `...&task_status=sampling_determined`, because `task_status` takes one value, `src/api/v1/quality.ts:853-875`; the bay name comes from the 8.10 task view), Damage reported (the open damage-report cards for the site from the damage case groups `to_inspect` and `whole_lot`, `edge/src/components/damage-case-view.ts:201-210`, each with lot, hold pill and a `Suspect whole lot - requested` pill where asked, opening `/damage/cases?case=<id>`; the case itself is never duplicated here, mock key-qc.html L411, L565, L687-692), Awaiting disposition (`task_status=inspected` with no disposition from the 8.10 fields), Sent on - finance or CEO (count card from the damage-case groups `sent_on` and `with_ceo`; no QC task status exists for it) and Done today (tasks whose 8.10 disposition or release falls on the device's local date); the 3.14 inspect-on-opening report shows as a chip, not a verdict; a task opened with no plan is not listed and the putaway hold reason `no inspection plan` shows in the stores inbox instead; each empty group states what is empty; an always-visible scan bar (DESIGN.md:262; 48 px in touch density) sits above the groups, a lot number or lot barcode resolves to its task on the fetched list and opens the detail, and it stays armed when every group is empty (EXPERIENCE.md:107)

**Given** a task detail (`GET /api/v1/qc/tasks/:taskId` via `?task=` query)
**When** it opens
**Then** sampling is determined on first open (`POST .../sampling`) and the sample size shown, each characteristic renders Measured plus Pass and Fail with an out-of-tolerance pill and posts `POST .../results` online, a Split card (Good stepper, Not usable derived as received minus Good, mock L612-617) is client state on the detail, Complete inspection stays disabled stating why until every sampled characteristic has a result and every not-usable count has an observation, then posts `POST .../inspection-completion` with no body counts (`quality.ts:1335`) and the task moves to Awaiting disposition; the Story 8.2 refusal codes (`en.json:308-318`, re-worded for an online page) render from `errors.*`; new keys `errors.QC_INSPECTION_REQUIRED`, `errors.DISPOSITION_EXISTS`, `errors.HOLD_EXISTS`, `errors.HOLD_ALREADY_RELEASED`, `errors.HOLD_NOT_FOUND`, `errors.LOT_NOT_FOUND`, `errors.DEFECT_CODE_UNKNOWN`, `errors.QC_RELEASE_NOT_ELIGIBLE`, `errors.RELEASE_EXISTS`, `errors.RETENTION_SAMPLE_REQUIRED`, `errors.RETENTION_SAMPLE_EXISTS`, `errors.APPROVAL_AUTHORITY_MISMATCH`, `errors.INSPECTION_PLAN_NOT_FOUND` and `errors.INSPECTION_PLAN_NOT_APPROVED` are added (`quality.ts:255-335`; none exists today)

**Given** an open or inspected task
**When** the inspector adds a free-text observation with an optional photo
**Then** the photo uploads through `PUT /api/v1/attachments/:attachmentId` via `edge/src/sync/attachment-uploader.ts:60` and the note posts to the 8.10 note endpoint with `{ note, attachment_id }`, the list shows who, when, text and a thumbnail fetched through `authorizedFetch` (pattern `edge/src/components/damage-cases.tsx:1009`), announced once via aria-live

**Given** an inspected task with Good and Not usable counts summing to the received quantity
**When** the QC head taps Record disposition with hold scope `Hold this lot in the bay only` (default; disposition and split act on the task) or `Hold the whole lot everywhere` with a required `hold_reason` (`Hold only reported units` appears for damage-sourced tasks only)
**Then** the whole-lot choice posts `POST /api/v1/qc/holds { lot_id, hold_reason }` first (`quality.ts:2308-2335`; `HOLD_EXISTS` refetches quietly), a two-part lot posts `POST .../split { justification, splits: [{ sequence: 1, quantity: good }, { sequence: 2, quantity: not_usable }] }` (`quality.ts:1591-1640`) then per-child dispositions, a single part posts `POST .../disposition { disposition: accept | reject, justification, defect_code? }` (`quality.ts:1522-1541`), an accept posts `POST .../release` (`src/server.ts:1161`) and shows `Released for putaway` in Done today only when no open hold remains on the lot (a whole-lot hold keeps `lot_master.quality_hold_status` held until `POST /api/v1/qc/holds/:holdId/release` with `release_reason`, `:1177`; otherwise the card shows On hold with the hold id and states the lot stays held until a two-tap release, owner question Q37); while the scope is whole lot the Accept tile on the Good part is disabled with the reason `A lot-wide hold blocks accepting the good units until QC clears the lot` (EXPERIENCE.md:101, mock L497, L622-626); `RETENTION_SAMPLE_REQUIRED` or `QC_RELEASE_NOT_ELIGIBLE` on release shows `Log retention sample first` with a `POST .../retention-sample` action for the QC head unless 8.10 scopes receipt lots out of the retention rule (owner question Q39); `DISPOSITION_EXISTS` refetches quietly; Conditional release is disabled with the reason `Needs the Approvals inbox (DOA sign-off), not yet built` (mock L412, L653); a non QC head sees the Decision and Hold scope cards read-only (client check against the bootstrap role; the server gate is 8.10 AC 4)

**Given** `/qc/holds`
**When** it opens
**Then** online it lists `GET /api/v1/qc/holds?site_id=&status=open` (`quality.ts:2444`) with `hold_id`, `placed_by`, `placed_at` and a two-tap release requiring `release_reason`, and offline it renders the synced `held_lot` rows (`sync/sync-rules.yaml:27-29`: `lot_id`, `lot_number`, `sku`, `quality_hold_status`, `quality_hold_reason`, `updated_at`; no site, hold id or placer) as a `Lots on hold (all sites, as synced)` list with release disabled and an as-of line from the last PowerSync sync time (`edge/src/components/sync-status-badge.tsx` has none today; add it or render the as-of next to the list)

**Given** the device is offline
**When** `/qc/tasks` or a detail opens
**Then** the needs-connection card replaces the groups, every write is disabled with the reason, and Dev Notes record the departure from EXPERIENCE.md:99 (QC observations offline) and mock key-qc.html L427 (disposition captured offline): `src/sync/upload.ts` `EDGE_QC_EVENT_TYPES` admits only `qc.result_recorded` on `POST /api/v1/edge/events` (`:343-359`, called at `src/api/v1/edge.ts:557`); sampling, observations, inspection completion, split, disposition, holds and conditional release are 403 `CENTRAL_ONLY_OPERATION`, and this story keeps results on the same online REST path for one consistent page state rather than mixing an outbox for results with online-only writes for everything else

**Given** the two pages
**When** axe, e2e (`edge/test/e2e/qc.spec.ts`), unit and `i18n:check` run
**Then** `/qc/tasks` and `/qc/holds` have zero WCAG 2.1 AA violations, a keyboard-only test reaches the first card, Pass and Fail, Complete inspection and Record disposition, 56/48/34 px targets, strings under `qc.*` and `nav.qcInbox`, and the Handheld bottom nav keeps `MAX_SLOTS` 4 with the fourth slot becoming More (`edge/src/components/bottom-nav.tsx:8-27`)

**Note:** PRE-PILOT BLOCKING. Source: `sprint-change-proposal-2026-10-21.md`. Closes the edge half of audit gap G07. Depends on 8.10 (receipt task, release, note endpoint, QC head gate, task view fields), 3.14 (inspect-on-opening chip source and acceptance fields) and 8.9, 1.14, 1.15 (done); 3.15 consumes the released putaway. QC workbench surface (EXPERIENCE.md:39, :136): Handheld inbox then detail with Back and pinned primary; Tablet and Desktop two panes. Online-only except the `held_lot` offline read; `/qc/holds` reached from the inbox header (owner question Q38). Record fixes: 8-9 story file Status set to done once Task 13.5 is recorded; 8-1 :460-465, 8-2 :152-154 and 8-3 :121-124 cited as the reason the gap exists. Size L.

---

## Epic 9: Job-Work Services

Operations teams receive customer-owned material, execute job-work orders against customer-supplied kit BOMs, and maintain a per-customer, per-order custody ledger (FR-JW-05) that never leaves the platform's control. Dispatch happens only after the FG QC gate, billing is a measured feed to ERP, and statutory Rule 45 return clocks run visibly from the challan date with deemed-supply escalation. No order closes while the custody ledger balance is non-zero (CUSTODY_NOT_ZERO).

### Story 9.1: Job-Work Service Order Creation

As a job-work coordinator,
I want to create service orders with customer, spec reference, promised dates, and price basis, linked to a customer-supplied kit BOM, with every change attributed,
So that each job-work engagement is defined and auditable from the start.

**Acceptance Criteria:**

**Given** a customer job-work engagement
**When** a service order is created with customer, spec reference, promised dates, and price basis (FR-JW-01)
**Then** the order is created in `Draft` state and links to a kit BOM (FR-B-16)

**Given** a Draft service order with a linked kit BOM and a price basis (FR-JW-02)
**When** the coordinator confirms the order
**Then** the order transitions to `Confirmed`, transitions to `In Process` on the first customer-material receipt (Story 9.2), and reaches `Closed` only through the Story 9.5 closure gate, with each transition recorded and attributed

**Given** a service order (FR-JW-02)
**When** a transition is attempted out of sequence (e.g., `Draft` directly to `Closed`) or confirmation is attempted without a linked kit BOM and price basis
**Then** the transition is blocked with `error_code: "INVALID_STATE_TRANSITION"`

**Given** any change to a service order
**When** the change is saved
**Then** it is attributed to the user in the non-disableable edit log (FR-AC-13)

---

### Story 9.2: Customer Material Receipt and Segregated Stock

As a receiving clerk,
I want customer material received only against confirmed orders through the gate and receiving flows, with the challan captured and stock held in a segregated, non-valuated class,
So that customer-owned material is never mixed with or consumed by other demand.

**Acceptance Criteria:**

**Given** customer material arriving (FR-JW-03)
**When** receipt is attempted without a confirmed service order
**Then** receipt is blocked with `error_code: "SOURCE_DOCUMENT_REQUIRED"` until a confirmed order and challan are present

**Given** a confirmed service order and an inbound challan
**When** the material is received through the gate and receiving flows (FR-JW-03)
**Then** the challan is captured and a receipt event is recorded against the order

**Given** a receipt where the received quantity deviates from the inbound challan quantity (FR-JW-03, FR-JW-05)
**When** the deviation exceeds the configured receipt tolerance
**Then** the variance is flagged as an exception, attributed to the receiving user, and reflected on the order's first custody statement

**Given** received customer material (FR-JW-04)
**When** it is stocked
**Then** it is placed in a non-valuated stock class, segregated and blocked from any other demand or allocation

**Given** customer-owned stock in the non-valuated class (FR-JW-04)
**When** any non-job-work demand (production, sales, transfer, or R&D) attempts to allocate, reserve, or pick it
**Then** the attempt is rejected with `error_code: "CROSS_ISSUE_BLOCKED"` and logged with the attempting user and demand source

---

### Story 9.3: Custody Ledger and Consumption

As a job-work coordinator,
I want a per-customer, per-order custody ledger covering all movement categories that prints as a custody statement, with consumption posted against kit lines and own-material additions billed distinctly,
So that customer ownership is fully accounted for at all times.

**Acceptance Criteria:**

**Given** customer material received against an order (FR-JW-05)
**When** movements occur
**Then** a per-customer, per-order custody ledger records receipts, consumption, returns, loss, and offcuts across all movement categories

**Given** a custody ledger with activity (FR-JW-05)
**When** a custody statement is requested
**Then** the ledger prints on demand as a custody statement showing the running balance

**Given** an order in process (FR-JW-06)
**When** consumption is posted against the order kit lines
**Then** the custody ledger is decremented by the consumed quantity

**Given** a consumption posting that exceeds the remaining custody balance for the item (FR-JW-05, FR-JW-06)
**When** the posting is attempted
**Then** it is blocked with `error_code: "INSUFFICIENT_STOCK"` and the custody ledger is unchanged

**Given** a consumption posting for an item that is not on the order's kit lines (FR-JW-06)
**When** the posting is attempted against the order
**Then** it is blocked with `error_code: "KIT_LINE_MISMATCH"` until the kit BOM is amended through an attributed change (FR-AC-13)

**Given** the job requires the processor's own material (FR-JW-07)
**When** own material is added
**Then** it is tracked distinctly from customer material and flagged as separately billable

---

### Story 9.4: Process Loss, Offcut Election Capture, and QC-Gated Dispatch

As a job-work supervisor,
I want process-loss norms with over-norm approval, the contractual offcut arrangement recorded at confirmation, output through the FG QC gate before dispatch, and partial dispatch support,
So that loss is controlled, offcut obligations are visible from the contract onward, and only quality-released output ships.

**Acceptance Criteria:**

**Given** a job with defined process-loss norms (FR-JW-08)
**When** recorded loss exceeds the norm
**Then** the over-norm loss is blocked with `error_code: "APPROVAL_REQUIRED"` until a supervisor approves it

**Given** an order with a contractual offcut arrangement (FR-JW-09/10)
**When** the order is confirmed
**Then** the order records that it carries a contractual offcut arrangement and, where one exists, the offcut contract reference; no disposition and no rate are elected at confirmation, because both are decided at disposal (Story 9.7)

**Given** finished job-work output (FR-JW-11)
**When** dispatch is attempted before the output passes the FG QC gate
**Then** dispatch is blocked until QC releases the output (integration with Epic 8)

**Given** a QC-released order (FR-JW-11)
**When** the customer accepts partial shipments
**Then** each partial dispatch reduces the order's open-to-dispatch quantity, decrements the custody ledger (FR-JW-05), and generates dispatch documents through the Story 3.7 flows, with only QC-released quantities dispatchable

**Dev notes:**
- Sequencing: the offcut-arrangement AC extends the Story 9.1 `Confirm` transition - implement it inside the Story 9.1 confirmation flow, not as a separate later step.
- Split: offcut capture (FR-JW-09/10) and the measured ERP billing feed (FR-JW-12) are Story 9.6; offcut disposal and valuation are Story 9.7.
- Revised 2026-09-05 by sprint change proposal: the disposition is NOT elected at confirmation. Neither is the rate, which cannot exist at confirmation where the offcut is later sold at auction.

---

### Story 9.5: Statutory Return Clocks and Closure Gate

As a compliance officer,
I want Rule 45 challans with one-year and three-year return clocks from the challan date, deemed-supply alerts, ITC-04 data, an aging report, and a closure gate that blocks on non-zero custody,
So that job-work statutory obligations are met and no order closes with unaccounted customer material.

**Acceptance Criteria:**

**Given** customer material received on a Rule 45 challan (FR-AC-11)
**When** the challan is recorded
**Then** one-year (inputs) and three-year (capital goods) return clocks start running from the challan date and are visible on the order

**Given** an open return clock (FR-AC-11)
**When** processed output or unconsumed material is returned or dispatched and reconciled against the challan quantity
**Then** the clock exposure for the reconciled quantity is closed and the job-work aging report reflects the reduced exposure

**Given** a return clock entering its breach window — configurable lead times per challan class, defaulting to 90 and 30 days before expiry (FR-JW-14)
**When** a lead-time threshold is crossed
**Then** a deemed-supply warning alert naming the order, challan, and expiry date is delivered through the Story 1.11 notification foundation to the job-work coordinator and the compliance officer

**Given** a breach-window alert that is not actioned (FR-JW-14)
**When** the configured escalation interval elapses without the exposure being cleared
**Then** the alert escalates through Story 1.11 to the next tier resolved from the DOA registry (FR-DOA-01) — no alert expires silently

**Given** a return clock that expires with unreconciled quantity (FR-AC-11)
**When** the one-year or three-year limit passes
**Then** the breached quantity is flagged as a deemed supply on the order, a deemed-supply record is raised into the ITC-04 data set, and an escalation is sent through Story 1.11 to the compliance officer and site head

**Given** job-work movements in a period (FR-AC-11, FR-JW-14)
**When** ITC-04 reporting is run
**Then** ITC-04 data — including any deemed-supply records — and a job-work aging report are produced

**Given** customer stock included in a physical verification count (FR-JW-13)
**When** the count records a variance against the custody ledger (via the Story 2.6 count workflow)
**Then** the variance is reconciled on the next custody statement for that customer and order, attributed to the verifying user

**Given** a service order submitted for closure (FR-JW-15, FR-AC-11)
**When** the custody ledger balance is non-zero
**Then** closure is blocked with `error_code: "CUSTODY_NOT_ZERO"` until the ledger is reconciled to zero

---

### Story 9.6: Offcut Election Execution and ERP Billing Feed

As a job-work coordinator,
I want contractual offcut captured out of custody into its own holding ledger, and a measured billing feed delivered to ERP with acknowledgment and failure handling,
So that offcut stops blocking order closure while its fate is undecided, and every completed job is invoiced from measured quantities without waiting on it.

**Acceptance Criteria:**

**Given** processing that produces contractual offcut (FR-JW-09/10)
**When** the offcut quantity is captured
**Then** the quantity leaves the custody ledger and is recorded in the offcut holding ledger, unvalued, against the order and its offcut contract reference, with the Section 143 return clock still running against it, and the order's custody balance is reduced so the closure gate is reachable

**Given** a completed, dispatched job-work order (FR-JW-12)
**When** billing is generated
**Then** a measured billing feed (pieces, certified weight, or hours), carrying the order and challan references, measured basis and quantity, price basis, and any own-material (FR-JW-07) lines, is sent to ERP with an `idempotency_key`, and the order is marked invoiced only on ERP acknowledgment. Offcut buyback is billed separately as a credit note when the offcut is valued at disposal (Story 9.7), and billing is never held waiting for it

**Given** a billing feed transmission that fails or is not acknowledged (FR-JW-12)
**When** the configured retry window elapses
**Then** the feed enters an exception queue with an alert through Story 1.11 to the job-work coordinator, retries never create duplicate billable events (replays rejected with `error_code: "DUPLICATE_EVENT"`), and unacknowledged feeds appear on a billing-reconciliation report

**Dev notes:**
- Split from Story 9.4: the offcut ARRANGEMENT is recorded at confirmation in Story 9.4; this story captures the offcut quantity out of custody into the holding ledger and owns the billing feed. Disposal and valuation are Story 9.7.
- The job-work billing feed is an outbound interface owned by this story — it does not depend on the Epic 4 ERP handoff (Epic 4 is outside the pilot go-live slice).
- Capture moves offcut OUT of the custody ledger into the holding ledger, so the Story 9.5 closure gate is reachable while the offcut is still retained. The offcut's own lifecycle continues after the order closes, under its contract reference.
- The Section 143 clock follows the material, not the order: it keeps running while offcut is retained and is stopped only at disposal. Widening the Story 9.5 breach sweep to read the holding ledger is STORY 9.7's, not this story's - ruled 2026-09-06 to remove a contradiction between this note and the 9.6 story file. The exposure is not lost in the meantime: because capture deliberately does not reconcile the clock, the quantity stays outstanding on `jobwork_return_clock` and still ages there. Story 9.7 rewrites that reader anyway, so building it here would build it twice.
- Revised 2026-09-05 by sprint change proposal. The shipped implementation (commit 6439870) elected the disposition and the rate at confirmation and settled, valued, converted and billed in one posting; that half is reversed.

---

### Story 9.7: Offcut Holding, Disposal and Valuation

As a finance controller,
I want retained offcut disposed of and valued when its fate is actually known, with the resulting buyback billed as a credit note against the service invoice,
So that customer offcut is never valued at a guessed rate and never sits unaccounted.

**Acceptance Criteria:**

**Given** offcut retained in the holding ledger (FR-JW-09/10)
**When** the finance controller records a disposal
**Then** the disposition (`returned` or `acquired`) and, on `acquired`, the final rate are captured together, the final rate being the offcut contract's INDICATIVE rate adjusted for the offcut's physical condition as verified by the processor, the holding ledger row is closed, and the Section 143 clock for that quantity is stopped

**Given** a disposal of `returned` (FR-JW-09/10)
**When** it is executed
**Then** a return challan and dispatch documents are generated through the Story 3.7 flows

**Given** a disposal of `acquired` (FR-JW-09/10)
**When** it is executed
**Then** title transfers to the processor, a new owned lot is minted under a QC hold, and a credit note for the acquisition value is raised against the order's service invoice citing that invoice's ERP document reference; a contractual free retention is the same branch at a rate of zero, which mints the lot and raises no credit note

**Given** a disposal of `acquired` whose negotiated rate differs from the offcut contract's indicative rate (FR-JW-09/10)
**When** the disposal is posted
**Then** it is accepted and the negotiated rate is recorded as the commercial value, with the indicative rate stored beside it so the variance is visible on the credit note and the reports; no tolerance is applied and nothing is refused on rate

**Given** a valued disposal (FR-JW-12)
**When** the finance controller later revises the rate
**Then** a delta document is raised and the original is never mutated

**Given** any offcut disposal (FR-JW-12)
**When** the acknowledging actor is the finance controller who set the rate
**Then** the acknowledgment is refused with `error_code: "SOD_VIOLATION"`

**Given** a disposal of `acquired` whose acquisition value falls in or above the governed DOA band (FR-JW-09/10)
**When** it is posted without a resolved second signature from the `cfo` role
**Then** it is refused with `error_code: "APPROVAL_REQUIRED"` and audited, and with one it proceeds and records the approver on the disposal

**Given** offcut still retained in the holding ledger (FR-AC-11, FR-JW-14)
**When** the Story 9.5 breach sweep runs
**Then** retained offcut is read alongside the return clocks and ages against the same deemed-supply thresholds, whether or not its order has closed

**Given** offcut held under the job contract with the customer (FR-JW-13, FR-JW-14)
**When** the job-work ageing report is produced
**Then** offcut still governed by that contract appears on the report; once it is `acquired` and title has transferred it leaves the report and is carried in the scrap holding ledger instead, because it is no longer customer material and no longer a job-work exposure

**Dev notes:**
- Created 2026-09-05 by sprint change proposal, which reversed the Story 9.6 offcut model.
- CFO SECOND SIGNATURE, ruled 2026-09-06. The signature sits on the ACQUISITION at disposal, NOT on
  capture. Capture is a physical fact - offcut comes off a machine whether or not anyone signs - so
  gating it would leave produced material on the floor with nothing in the ledger, the exact
  untracked-material gap the fail-closed ownership ruling exists to prevent. Disposal is where title
  transfers and money moves, so that is where dual control belongs.
- `cfo` and `finance_controller` are TWO DISTINCT ROLES HELD BY TWO SEPARATE REAL PEOPLE (ruled
  2026-09-06, superseding the 2026-09-05 note that the site head would wear the finance-controller
  hat - the site head holds neither). The separation IS the control: the finance controller sets the
  acquisition rate at disposal, the CFO co-signs it above the band, so nobody both prices a
  customer's offcut and approves paying for it. Roles are free text in role assignments and in
  `doa_registry.role`, so this is registry data plus access-matrix rows, not a code vocabulary
  change.
- The 2026-09-05 pilot constraint DISSOLVES with that separation. It said that because the site head
  held `finance_controller` and was also the Story 1.11 job-work escalation target, someone else had
  to be found to acknowledge the credit note. With the roles on separate people, it does not arise.
- The band uses the EXISTING DOA machinery that already governs over-norm loss and warranty
  overrides: `doa_registry` bands by `transaction_type` with `value_min`/`value_max`, and
  `resolveApprover` resolves the holder, honouring active delegations. Do not invent a second
  approval idiom.
- OPERATIONAL PREREQUISITE, and it fails closed if missed: `resolveApprover` raises
  `NO_APPROVER_FOUND` when no active user holds the role. A `cfo` DOA band with nobody provisioned
  refuses every acquisition above it, and an unheld `finance_controller` blocks disposal outright.
  BOTH roles must be granted to real, DIFFERENT users before this story goes live.
- Ownership while retained is fail-closed: the material stays the customer's and the Section 143 clock keeps running. Disposal is the ownership-transfer event for the retain branches.
- Valuation is revisable after the fact, so corrections are delta documents. Nothing acknowledged is ever mutated, and there is no void path.
- The credit note is the first consumer of the billing feed's `acknowledged_ref_ext`; that column is a citation, not an identity, and must stay non-unique so one consolidated ERP invoice can be cited by several documents.
- Depends on the Story 9.6 reversal landing first: the confirm-time rate mandate, the settle-value-convert-bill posting, the `offcut_not_settled` billing precondition and the `OFFCUT_RATE_OUT_OF_BAND` guard all have to go before this story can be built coherently.
- Ruled 2026-09-05: the processor ALWAYS buys before it sells, never sells on the customer's behalf. Onward resale (back to the originating customer, to a scrap buyer, or at auction) is therefore a sale of stock the processor already owns and is OUT OF SCOPE here - it leaves this story as ordinary owned stock. Two prices exist and must not be conflated: the finance controller's rate is what the processor PAYS the customer for title; any auction or scrap price is what the processor later RECEIVES, and only the first belongs to this story.
- Confirmed 2026-09-05: a contractual free retention IS `acquired` at a rate of zero, not a third branch. Same title transfer, same owned lot under QC hold, no credit note because there is nothing to credit. The disposition vocabulary is closed at two values.
- Ruled 2026-09-05: the offcut contract DOES carry a pre-indicative buy-in rate, and the final rate moves with the offcut's physical condition. The processor verifies that condition ALONE; the eventual buyer's view of condition bears only on the later resale price, never on what the customer is paid, so acquisition and resale stay fully decoupled.
- Ruled 2026-09-05 (final, superseding an earlier choice of a hard band): the commercial value is the rate NEGOTIATED in reality, not a bounded figure. The indicative rate is a reference stored beside it so the variance is visible; no tolerance is applied and no disposal is refused on rate. The `OFFCUT_RATE_OUT_OF_BAND` guard and its `JOBWORK_OFFCUT_RATE_TOLERANCE_PCT` knob are therefore REMOVED, not re-anchored.
- Consequence to hold onto: with no band, the ONLY control over the rate is separation of duties. The finance controller who sets it must not be able to acknowledge the credit note that bills it, so that guard carries the whole weight and must not be weakened.
- `service_order.offcut_rate` and `offcut_currency` survive as the indicative pair; only the confirm-time mandate is withdrawn.
- Ruled 2026-09-05: offcut still governed by the job contract appears on the job-work ageing report. Once acquired, it leaves that report and is carried in the SCRAP HOLDING LEDGER, because title has transferred and it is no longer a job-work exposure. Recommended implementation is a segregated scrap stock class or designated scrap location on the existing stock machinery rather than a new projection, unless scrap needs its own valuation and ageing views.
- NOTE: condition verification here is COMMERCIAL grading that sets a price. It is not the QC hold placed on the minted owned lot, which is about fitness for use. Do not merge the two.

---

## Epic 10: R&D and Maker-Hub Operations

R&D project managers issue materials against project codes under committed-plus-actual budget control (FR-RD-04) with three semantically distinct issue types. Prototype builds carry full material history including failed builds, and hub operators run offline point-of-use sales with UPI/card capture. Every rupee of R&D spend feeds Form 3CL without year-end archaeology, and Ind AS 38 research-vs-development classification is applied from the first transaction with no retroactive reinstatement (FR-AC-02, FR-AC-03). R&D-designated stock cannot cross-issue without approved reclassification (CROSS_ISSUE_BLOCKED).

### Story 10.1: R&D and Maker-Hub Location Types and Project Master

As an R&D project manager,
I want R&D store and maker-hub store as first-class location types with their own ledgers, R&D-designated stock protected from cross-issue, and a project master that gates all material transactions,
So that R&D and hub inventory is ring-fenced and every movement is tied to a live project.

**Acceptance Criteria:**

**Given** an R&D store and a maker-hub store configured as first-class location types (FR-RD-01)
**When** stock is received into the R&D store
**Then** the movement appears in the R&D store's own stock ledger and in no other location's ledger, and the same holds for the maker-hub store

**Given** stock flagged R&D-designated (FR-RD-02)
**When** an issue to a non-R&D demand is attempted without approved reclassification
**Then** the issue is blocked with `error_code: "CROSS_ISSUE_BLOCKED"`

**Given** an R&D project (FR-RD-03)
**When** a project master is created
**Then** it carries a code, owner, research/development phase tag, budget, and status

**Given** any R&D material transaction (FR-RD-03)
**When** it is attempted without an active project code
**Then** the transaction is rejected with `error_code: "PROJECT_CODE_REQUIRED"` until a valid active project code is supplied

---

### Story 10.2: R&D Requisition, Budget Check, and Issue Types

As an R&D project owner,
I want requisitions checked against committed-plus-actual budget with breach routing, three distinct issue semantics, and Ind AS 38 phase-based capitalization,
So that spend stays within budget and is classified correctly for tax and accounting from the outset.

**Acceptance Criteria:**

**Given** an R&D requisition against a project (FR-RD-04)
**When** it is submitted
**Then** a committed-plus-actual budget check runs and a breach routes to the project owner and R&D head with `error_code: "APPROVAL_REQUIRED"`

**Given** an approved requisition (FR-RD-05)
**When** material is issued
**Then** the issue is recorded under one of three semantics: consumable (expensed), project material (accumulates WIP), or equipment custody (loan)

**Given** an issue on a project whose phase tag is research (FR-AC-02)
**When** the issue is posted
**Then** the cost is expensed in the period of issue

**Given** an issue on a project whose phase tag is development (FR-AC-03)
**When** the issue is posted
**Then** the cost is capitalized only when the project carries a six-criteria Ind AS 38 checklist with all six criteria recorded as met, and the checklist reference is stored on the costing record

**Given** a development-phase project whose Ind AS 38 checklist is incomplete or has a failing criterion (FR-AC-03)
**When** an issue is posted
**Then** the cost is expensed and capitalization is blocked with `error_code: "CAPITALIZATION_CRITERIA_NOT_MET"`

**Given** costs already expensed under the research phase or a failed checklist (FR-AC-02, FR-AC-03)
**When** the project later passes the six-criteria checklist
**Then** only costs incurred from the date the criteria are met are capitalized; any attempt to retroactively reinstate a previously expensed cost as capitalized is rejected with `error_code: "RETROACTIVE_REINSTATEMENT_BLOCKED"`

**Given** an equipment-custody issue (FR-RD-06)
**When** it is recorded
**Then** an equipment custody register entry is created with named custodian, expected return date, and condition codes, with overdue ageing tracked

---

### Story 10.3: Project WIP Ledger and Prototype Build Records

As an R&D project manager,
I want a per-project WIP ledger in quantity and cost, prototype build records including failed builds, non-saleable serialized completed builds, four approved dispositions, and material returns,
So that every prototype's material history and cost is fully captured.

**Acceptance Criteria:**

**Given** project material issued (FR-RD-07)
**When** the project WIP ledger is viewed
**Then** it shows accumulated quantity and cost per project in real time

**Given** a prototype build (FR-RD-08)
**When** the build is recorded, including failed or abandoned builds
**Then** a build record captures the full material history

**Given** a completed prototype build (FR-RD-09)
**When** it is registered
**Then** it is registered as a non-saleable serialized class

**Given** a serialized prototype in the non-saleable class (FR-RD-09)
**When** a dispatch document or issue-to-dispatch is attempted against it
**Then** the transaction is blocked with `error_code: "NON_SALEABLE_CLASS"`; the same class check blocks sales-order allocation when the Phase-2 orders module (Epic 15) lands

**Given** a completed prototype (FR-RD-10, FR-RD-11)
**When** a disposition is chosen among retain-as-asset, transfer-to-production, teardown, or scrap
**Then** the disposition requires R&D-head approval (`error_code: "APPROVAL_REQUIRED"`), teardown recovers components with condition codes, retain-as-asset creates an Epic 7 asset-register entry, and transfer-to-production records a production-reference designation

**Given** teardown or scrap lines from an approved disposition (FR-RD-11)
**When** the disposition is executed in Phase 1
**Then** the lines are placed in a scrap-pending holding state carrying quantity, condition code, and source-prototype reference, visible in the project's material history

**Given** unused project material (FR-RD-12)
**When** it is returned
**Then** the return reverses project WIP by the returned cost

**Note:** Deferred to Phase 2 (Epic 16): routing of teardown and scrap lines into the FR-SC scrap module. Phase 1 holds them in the scrap-pending state above with full source references; Epic 16 consumes that state without rework of this story.

---

### Story 10.4: Hub Member Records and Machine-Time Booking

As a maker-hub operator,
I want member and walk-in customer records that every hub transaction references, and machine-time booking with operator-closed actuals, meter readings, and unclosed-booking exceptions,
So that every booking and sale is attributable to exactly one customer and machine usage is captured accurately.

**Acceptance Criteria:**

**Given** hub customers (FR-RD-13)
**When** records are created
**Then** hub member and walk-in customer records are maintained

**Given** a booking, sale, or job card (FR-RD-13)
**When** it is created without a reference to exactly one member or walk-in customer record
**Then** it is rejected with `error_code: "MEMBER_REFERENCE_REQUIRED"`; a reference to more than one customer record is rejected the same way

**Given** a machine-time booking (FR-RD-14)
**When** the operator closes the booking
**Then** actual machine time and the machine meter reading are recorded, and the meter reading feeds the FR-M-03 usage-meter register (Epic 7)

**Given** an open machine-time booking (FR-RD-14)
**When** it remains unclosed for 24 hours
**Then** an exception is raised to the hub operator for resolution

**Note:** Offline point-of-use sale, payment capture, and end-of-day reconciliation are Story 10.6. Member job cards and statements are Story 10.7.

---

### Story 10.5: R&D Physical Verification and Cost Reporting

As a finance controller,
I want monthly hub and quarterly R&D physical verification, custodian confirmation of on-loan equipment, project cost reconciled to the store ledger feeding Form 3CL and IAUD, separated B2C invoices, and funding-source tagging,
So that R&D spend is audit-ready and correctly attributed to funding sources.

**Acceptance Criteria:**

**Given** hub and R&D inventory (FR-RD-18)
**When** physical verification is run
**Then** hub verification runs monthly and R&D verification quarterly, with variances recorded

**Given** equipment on loan (FR-RD-18)
**When** verification is performed
**Then** custodians confirm on-loan equipment and unconfirmed items are flagged

**Given** project material cost (FR-RD-19, FR-AC-04)
**When** cost reporting is produced
**Then** it reconciles line-for-line to the store ledger, feeds Form 3CL, and produces a project-wise, phase-tagged capitalizable-cost extract in the defined IAUD feed format (consumed by the Epic 17 intangibles/IAUD ledger in Phase 2)

**Given** maker-hub B2C sales (FR-AC-12)
**When** invoices are generated at Story 10.6's point of sale
**Then** item-rate charges are separated from machine-time service charges on the invoice, and hub material sales post to sales revenue at item rates — never to miscellaneous income

**Given** a hub material sale (FR-AC-12)
**When** a posting attempts to classify it as miscellaneous income
**Then** the posting is rejected with `error_code: "INVALID_REVENUE_CLASSIFICATION"`

**Given** any R&D cost ledger entry (FR-AC-16)
**When** it is posted
**Then** it carries a funding-source tag (internal, DSIR, DST, or grant), and the FR-AC-04 project cost report subtotals spend by funding source

**Given** an R&D cost ledger entry without a funding-source tag (FR-AC-16)
**When** posting is attempted
**Then** it is rejected with `error_code: "UNTAGGED_TRANSACTION"`

---

### Story 10.6: Offline Point-of-Use Sale and Payment Capture

As a maker-hub operator,
I want offline point-of-use material sales that decrement hub stock and bill the member, UPI/card payment capture with failure handling, and end-of-day payment reconciliation,
So that the hub sells and collects accurately with no network, and every rupee taken at the counter reconciles at day end.

**Acceptance Criteria:**

**Given** a point-of-use material sale offline (FR-RD-15)
**When** the sale is confirmed
**Then** hub stock is decremented locally, the sale is billed to the referenced member or walk-in customer at item rates, and the transaction is replayed on reconnection via the Epic 1 offline edge shell (Story 1.8)

**Given** an offline sale for more than the locally known hub stock (FR-RD-15)
**When** the sale is attempted
**Then** it is blocked with `error_code: "INSUFFICIENT_STOCK"` against the device's local ledger

**Given** offline sales replayed on reconnection (FR-RD-15)
**When** replay would drive hub stock negative because another device decremented the same stock while offline
**Then** the conflicting transaction is parked as a sync exception with `error_code: "STREAM_CONFLICT"` for hub-operator resolution and is never silently dropped

**Given** hub stock consumed by point-of-use sales (FR-RD-17)
**When** stock falls below its reorder control level
**Then** replenishment is driven via FR-I-03 reorder against the serving warehouse or a purchase

**Given** a walk-in payment (FR-RD-20, INT-PAY-01)
**When** payment is taken by UPI dynamic QR or card terminal
**Then** the payment is captured with its gateway reference and included in end-of-day reconciliation

**Given** a UPI or card payment that fails or times out at the terminal (FR-RD-20, INT-PAY-01)
**When** no confirmed gateway reference is received
**Then** the sale remains unpaid with `error_code: "PAYMENT_NOT_CONFIRMED"`, the operator can retry or take another payment method, and the unresolved attempt is listed in end-of-day reconciliation

**Given** end-of-day reconciliation (FR-RD-20)
**When** captured payments do not match gateway settlement records
**Then** each mismatch raises an unreconciled-payment exception that must be resolved or escalated before the day close completes

---

### Story 10.7: Member Job Cards and Statements

As a maker-hub operator,
I want member job cards that collect bookings, machine hours, and purchases, with statements on demand and monthly,
So that members are billed transparently and every charge is traceable to a recorded transaction.

**Acceptance Criteria:**

**Given** a hub member's activity (FR-RD-16)
**When** bookings are closed and point-of-use sales are confirmed
**Then** the member's job card collects each booking, its machine hours, and each purchase with date, quantity, and amount

**Given** a job-card entry (FR-RD-13, FR-RD-16)
**When** it is created
**Then** it references exactly one member record and reconciles to the underlying booking or sale transaction

**Given** a member job card (FR-RD-16)
**When** the member or a hub operator requests a statement
**Then** an on-demand statement is produced for the requested period covering bookings, hours, purchases, payments, and outstanding balance

**Given** month end (FR-RD-16)
**When** the monthly statement run executes
**Then** a statement is generated for every member with activity or an outstanding balance in the month, and the run's completion is recorded

---

## Epic 11: Financial Compliance and Period Close

Finance teams close periods with a signed-off subledger-to-GL reconciliation and period locks that prevent back-dated transactions after close (FR-AC-15). The ITC register is current per GSTIN with auto-computed reversals on write-offs (FR-AC-08), every e-invoiceable dispatch is blocked until IRN and signed QR are received (FR-AC-14), and branch transfers between GSTINs trigger Rule 28 valuation and GST documents (FR-AC-10). ERP-synced budget heads show availability inline at every approval, with no budget masters held locally (FR-BC-02).

### Story 11.1: ITC Register Per GSTIN

As a GST accountant,
I want an ITC register per GSTIN traced to GRN, invoice, and IRN, with reversals computed on write-offs before disposal closes, and GSTR-2B reconciliation,
So that input tax credit is accurate, defensible, and reconciled to the portal.

**Acceptance Criteria:**

**Given** a goods receipt with a tax invoice (FR-AC-07)
**When** ITC is recorded
**Then** an ITC register entry per GSTIN is created, traced to the GRN, invoice, and IRN

**Given** an approved write-off stock adjustment event on the event stream (FR-AC-08)
**When** the ITC register subscriber consumes the event
**Then** an ITC reversal is computed and posted to the register for the affected GSTIN, linked to the originating write-off event — exercised in Phase 1 by the approval-gated write-off adjustments from cycle counting (Story 2.6)

**Given** a disposal-close command for stock whose ITC reversal is not yet computed and posted (FR-AC-08)
**When** the spine-level precondition is evaluated
**Then** the command is rejected with `error_code: "ITC_REVERSAL_PENDING"` — contract-tested in Phase 1 at the command API; the disposal workflow that issues this command arrives with Epic 16 (Phase 2) and consumes this precondition unchanged, per the event-subscriber extension note in the Epic 11 goal

**Given** a GSTR-2B statement for a GSTIN, ingested by manual upload of the GSTN portal JSON file (FR-AC-07)
**When** reconciliation is run
**Then** ITC register entries are matched to GSTR-2B lines on supplier GSTIN + invoice number + invoice date + taxable value + tax amount per head, with a configurable rounding tolerance (default ±1 rupee per tax head)

**Given** a completed GSTR-2B reconciliation run with differences (FR-AC-07)
**When** mismatches are surfaced
**Then** each mismatch lands in an exception report per GSTIN, categorized as missing-in-2B, missing-in-register, or amount-variance, with drill-through to the underlying GRN and invoice

**Dev notes:**
- Supplier tax invoices enter through Story 4.7 (Supplier Invoice Capture); GRN linkage comes from Story 4.5 receiving events, and open-PO references from Story 2.9 (ERP Inbound Reference Projections).
- GSTR-2B ingestion is manual portal-JSON upload in Phase 1; a GSTN API or ERP-mediated feed is a later integration decision and must not change the matching keys or tolerance contract above.
- The IRN on inbound invoices is captured invoice data (Story 4.7); the outbound IRP flow is Story 11.2 (INT-GST-01).

---

### Story 11.2: IRN-Before-Dispatch Enforcement

As a dispatch controller,
I want e-invoiceable dispatches blocked until IRN and signed QR are received,
So that no non-compliant shipment leaves the site.

**Acceptance Criteria:**

**Given** an e-invoiceable supply ready to dispatch (FR-AC-14, INT-GST-01)
**When** dispatch is attempted before the IRN and signed QR are received from the IRP flow through ERP
**Then** dispatch is blocked with `error_code: "IRN_MISSING"` until IRN and signed QR are present

**Given** an IRN and signed QR returned by the IRP through ERP (FR-AC-14, INT-GST-01)
**When** they are recorded against the supply
**Then** they are stored against it, the dispatch block lifts, and a replay of the same recording is idempotent

**Dev notes:**
- RULED 2026-09-05: the SIGNED QR is not required by this platform and ALL supplies are e-invoiceable
  with no exemption. The gate is the IRN alone; ERP owns producing and printing the QR. This
  deliberately diverges from the "IRN and signed QR" wording of FR-AC-14 and of the criteria above,
  and the divergence is recorded rather than hidden.
- SPLIT 2026-09-05 from the original Story 11.2, which bundled IRN enforcement with GSTIN branch
  transfers. The two share only the word "dispatch". IRN enforcement is the statutory blocker on
  shipping e-invoiceable goods and is PULLED INTO THE PILOT SLICE; the branch-transfer half is now
  Story 11.5.
- Greenfield outbound: every IRN reference in the codebase today is INBOUND supplier-invoice side
  (three-way match, `supplier_invoice`). Nothing models an outbound IRN.
- The block belongs beside the existing dispatch gates in `src/compliance/dispatch.ts`
  (`dispatchGateBlockedLots`, `qcGatedLotIds`), which is where the QC and hold gates already live -
  the repeated hold-bypass lesson is that one shared gate helper is the only safe shape.
- No IRP integration is built here: the IRN and signed QR arrive through ERP, exactly as the
  acceptance criterion says. This platform enforces, it does not call the IRP.

---

### Story 11.5: Branch Transfer Valuation and GST Documents

As a GST accountant,
I want branch transfers between GSTINs treated as taxable supplies with Rule 28 valuation and their GST documents generated before dispatch,
So that inter-branch movements are correctly taxed and documented.

**Acceptance Criteria:**

**Given** a stock transfer between two GSTINs (FR-AC-10)
**When** the branch transfer is created
**Then** it is treated as a taxable supply valued on a Rule 28 basis - open market value; value of like kind and quality; cost-plus under Rules 30/31; or the second-proviso invoice value where the recipient GSTIN is eligible for full ITC - with the basis defaulted per GSTIN pair from dated configuration, overridable by the GST accountant, and the selected basis recorded on the transfer

**Given** a valued branch transfer (FR-AC-10)
**When** GST documents are generated before dispatch
**Then** a tax invoice exists (carrying IRN and signed QR where the supply is e-invoiceable, per the Story 11.2 block) and an e-way bill exists where the consignment value exceeds the threshold

**Given** a branch transfer without its generated GST documents (FR-AC-10)
**When** dispatch is attempted
**Then** it is blocked with `error_code: "GST_DOCUMENTS_REQUIRED"` until the documents exist - GST documents are the blocking artifacts here; gate-pass enforcement (FR-GP-11) is Epic 20 (Phase 2)

**Dev notes:**
- SPLIT 2026-09-05 from the original Story 11.2. Confirmed the same day that the pilot operates MORE
  THAN ONE GSTIN, so this is a GO-LIVE requirement, not post-pilot work: the first movement across
  that boundary is a taxable supply.
- PREREQUISITE, and it does not exist yet: `gstin_ext` is currently modelled only on `supplier`.
  Sites and locations carry no GSTIN at all, so "a transfer between two GSTINs" has no data model to
  stand on. That modelling is task one of this story.
- This extends Story 2.5's `transfer_request`. Before starting, the story-2-5 integration suite must
  be green: its fifteen tests currently fail as a seeding cascade, so the transfer feature this story
  builds on has no working regression net.
- Depends on Story 11.2 for the IRN half of the tax-invoice criterion.

---

### Story 11.3: ERP-Synced Budget Control

As a budget approver,
I want ERP-synced budget heads with inline availability at every approval, configurable warn-or-block behavior, and commitments that reduce availability until actuals sync,
So that approvers see real budget impact without the system holding stale local budget masters.

**Acceptance Criteria:**

**Given** budget heads synced from ERP (FR-BC-01, FR-BC-02)
**When** an approval screen is opened
**Then** the remaining budget for the relevant head is shown inline, with no budget master stored locally

**Given** an approval that would exceed the remaining budget, on a budget head configured to warn (FR-BC-01)
**When** the approver acts
**Then** the approval proceeds and a budget-exceeded warning is recorded on the approval record

**Given** an approval that would exceed the remaining budget, on a budget head configured to block (FR-BC-01)
**When** the approver acts
**Then** the action is rejected with `error_code: "BUDGET_EXCEEDED"` and the request is escalated to the next-higher authority for that budget head resolved from the DOA registry (FR-DOA-01) — a block escalates, it never terminally strands the request

**Given** an approved commitment (FR-BC-01)
**When** it is recorded
**Then** availability is reduced by the commitment until ERP actuals sync back and reconcile it

**Given** budget heads whose last successful ERP sync is older than the configured staleness threshold (FR-BC-02)
**When** an approval screen is opened
**Then** the displayed availability carries its last-synced timestamp and a stale-data indicator; warn-configured heads remain approvable with the staleness logged on the approval record, and block-configured heads require the approver to explicitly acknowledge the staleness before acting

**Dev notes:**
- ERP remains the budget master. The IMS holds synced projections of budget heads and availability plus local commitments — never an editable local budget master (FR-BC-01, FR-BC-02).
- Sync cadence, the staleness threshold, and warn-vs-block behavior are dated configuration per budget head, owned by finance administration (suggested defaults: 15-minute sync, 4-hour staleness threshold).
- Budget-checked approvals are Tier 2 central control-plane workflows (NFR-P-04); the offline-first mandate applies to Tier 1 frontline capture, so no offline approval path is required here.

---

### Story 11.4: Period Locks, Reconciliation, and Audit Evidence

As a finance controller,
I want period locks after close, GRNI ageing, a subledger-to-GL reconciliation extract, CARO 2020 physical-verification evidence with a 10% test, and an open-items report,
So that period close is clean, auditable, and signed off.

**Acceptance Criteria:**

**Given** a closed accounting period (FR-AC-15)
**When** a back-dated transaction into that period is attempted directly
**Then** it is rejected with `error_code: "PERIOD_LOCKED"` and the attempt is written to the statutory edit log (FR-AC-13)

**Given** an event legitimately captured offline before close whose IST `business_date` falls in a period that closed before PowerSync replayed it (FR-AC-15)
**When** the event syncs to the central event store
**Then** the event is accepted — captured facts are never discarded — its financial posting is redirected to the earliest open period carrying a `late_arrival` marker that references the original `business_date`, and the item is listed on a period-exception report for finance review

**Given** a correction that must post into a closed period (FR-AC-15)
**When** a period reopen is requested
**Then** the reopen is blocked with `error_code: "APPROVAL_REQUIRED"` until the authority resolved from the DOA registry (FR-DOA-01) approves it with a logged justification, and the reopen, the corrections, and the re-close are all recorded in the statutory edit log (FR-AC-13) with actor and timestamps

**Given** received-but-not-invoiced goods — GRNs from Story 4.5 with no supplier invoice captured against them via Story 4.7 (FR-AC-15)
**When** the GRNI ageing report is run
**Then** GRNI items are listed in 0-30 / 31-60 / 61-90 / 90+ day buckets by GRN date, with value per bucket per location and drill-through to the GRN and its PO reference (Story 2.9)

**Given** subledger balances at close (FR-AC-15)
**When** the reconciliation extract is generated
**Then** a subledger-to-GL reconciliation is produced per GL account, and every difference appears as an open item with a reason code — no unexplained residual

**Given** physical-verification and cycle-count events recorded through Story 2.6 (FR-AC-15)
**When** the CARO 2020 evidence pack is generated for a period
**Then** it compiles count sheets, variances, and approved adjustments per location, and applies the 10% test of CARO 2020 clause 3(ii)(a): for each class of inventory (raw materials, WIP, finished goods, stores and spares, scrap), aggregate discrepancies between counted and book value are computed as a percentage of that class's book value, any class at or above 10% is flagged with its adjustment disposition, and nil results are recorded as evidence too

**Given** open items exist from the reconciliation (FR-AC-15)
**When** the open-items report is run
**Then** each open item carries its reason code, age, owner, and value, filterable by GL account and location

**Given** the reconciliation extract, CARO evidence pack, and open-items report for a period (FR-AC-15)
**When** period close is attempted
**Then** close is blocked with `error_code: "APPROVAL_REQUIRED"` until a finance-controller sign-off resolved from the DOA registry (FR-DOA-01) is recorded as a domain event in the statutory edit log (FR-AC-13) — the period lock takes effect only after this recorded sign-off

**Dev notes:**
- GRNI is computed from Story 4.5 receiving events minus supplier invoices captured in Story 4.7; open-PO references come from Story 2.9 (ERP Inbound Reference Projections).
- The late-arrival disposition preserves the event-sourced rule that captured facts are immutable: the period lock governs financial postings, not event acceptance.
- The class-of-inventory grouping for the 10% test comes from the item-master classification (Schedule III inventory classes); the test runs per class in the aggregate across locations, per financial year, over Story 2.6 verification events.

---

## Epic 12: Cross-Module Reporting and Executive Analytics

Executives drill from the Phase-1 KPI set — inventory turns, procurement spend, stockout count, and a fill rate approximated from the ERP sales-order reference projections (Story 2.9) — down to the underlying transactions in a single pane (FR-R-03); forecast accuracy is a Phase-2 extension that lands with Epic 15 demand planning. All seven coarse roles of the published access matrix (executive, finance, warehouse manager, inventory controller, procurement officer, demand planner, quality inspector) have role-specific dashboards, with configurable exception rules delivered by Story 12.5. Self-service ad-hoc reporting supports Excel/PDF/CSV export (Story 12.4) with scheduled distribution and shared definitions (Story 12.6). Operational domain views live in their module epics; Epic 12 is the cross-module executive layer built on the read model projections.

### Story 12.1: Role-Specific Operational Dashboards

As a role-holder,
I want a dashboard tailored to my role with real-time projections and the exception alerts that target my role,
So that I see exactly the items needing my attention without hunting through screens.

**Acceptance Criteria:**

**Given** each of the seven coarse roles of the published access matrix (FR-R-01) — executive, finance, warehouse manager, inventory controller, procurement officer, demand planner, quality inspector
**When** a user opens their dashboard
**Then** a role-specific dashboard is shown, driven by real-time read model projections, rendering at minimum that role's widget set:
- **Executive:** the cross-module KPI strip (Story 12.2), top open exceptions across modules, and the multi-location consolidated view
- **Finance:** period-close status, ITC register summary, budget-head availability, and pending sign-offs (Epic 11)
- **Warehouse manager:** open tasks by type, age, and zone with SLA breaches highlighted (Story 3.8), gate dwell median vs. the 4-minute target (SM-13), and pending-sync edge captures
- **Inventory controller:** stock by location with below-reorder-point exceptions (Stories 2.2, 2.7), cycle-count variances (Story 2.6), aging/obsolescence flags (Story 2.7), and open transfer requests (Story 2.5)
- **Procurement officer:** open PO status with overdue lines (Epic 4, Story 2.9), requisitions and POs awaiting approval, MSME ageing alerts, and a spend snapshot (FR-P-08)
- **Demand planner:** below-safety-stock and reorder exceptions with replenishment recommendations (Story 2.7), and inbound supply vs. sales-order demand from the Story 2.9 reference projections — forecast widgets are a Phase-2 extension (Epic 15)
- **Quality inspector:** open inspections, lots on hold, NCR/CAPA aging, and calibration-lockout events (Epic 8, FR-Q-13)

**Given** an exception alert raised by the rule engine (Story 12.5, FR-R-02)
**When** the user whose role the rule targets opens their dashboard
**Then** the alert appears in that dashboard's exceptions panel with drill-through to the breaching item

**Given** a dashboard request (NFR-P-01, NFR-P-05)
**When** the dashboard loads
**Then** the screen renders within 2 seconds (NFR-P-01) and each backing API call meets the p95 target of 500ms (NFR-P-05)

**Given** the client is offline or a projection backing a widget is older than the configured staleness threshold (NFR-P-04 two-tier model)
**When** the dashboard renders
**Then** each affected widget shows its last-updated timestamp and a visible stale indicator — old numbers are never presented silently as current

**Dev note:** Exception rule definition, evaluation, and alert lifecycle (FR-R-02) are Story 12.5; this story consumes its alerts.

---

### Story 12.2: Cross-Module Executive KPI Dashboard

As an executive,
I want a consolidated KPI dashboard with drill-from-KPI-to-transaction in one pane and a multi-location consolidated view,
So that I can move from a headline number to its root cause without switching tools.

**Acceptance Criteria:**

**Given** the executive dashboard (FR-R-01, FR-R-03)
**When** it loads
**Then** the Phase-1 KPI set is shown, each computed per its stated definition:
- **Inventory turns** = annualized cost of goods issued ÷ average on-hand inventory value at the Ind AS 2 valuation (Story 2.4), over the trailing 12 months (or since go-live if shorter), per location and consolidated
- **Procurement spend** = sum of received PO line values (GRN-based) in the selected period, decomposable by the five FR-P-08 dimensions
- **Stockout count** = number of SKU-location-days in the period where available quantity was zero for an active item with a configured reorder point (Stories 2.2, 2.7)

**Given** the ERP sales-order reference projections (Story 2.9) and dispatch confirmations (Story 3.7)
**When** the fill-rate KPI is computed
**Then** fill rate = sales-order lines fully dispatched on or before their requested date in the period ÷ sales-order lines due in the period, and the tile is labelled "approximated (ERP reference)"; when Story 2.9 projections are unavailable the tile shows "unavailable" rather than a fabricated value

**Given** Epic 15 demand planning is delivered (Phase 2, FR-D-01 to FR-D-08)
**When** forecast runs have produced forecast-vs-actual history
**Then** forecast accuracy (MAPE) joins the KPI strip without rework of the drill-through frame — this criterion is a Phase-2 extension and is not part of the Phase-1 definition of done

**Given** a displayed KPI (FR-R-03)
**When** the executive drills into it
**Then** the drill path is KPI → dimension breakdown (location, period, category) → contributing transaction list, all within a single pane, with each level filterable

**Given** an executive whose role scope excludes a location or cost-level data (NFR-SEC-06)
**When** they drill from a KPI toward the underlying transactions
**Then** rows outside their location scope are excluded and cost-restricted columns are masked; a drill into a projection the role has no read permission on is rejected with `error_code: "REPORT_PERMISSION_DENIED"`

**Given** multiple locations (FR-R-01)
**When** the consolidated view is selected
**Then** KPIs are aggregated across all locations with per-location breakdown available

---

### Story 12.3: Domain Report Suites

As an inventory controller or procurement officer (any role granted reporting permission),
I want inventory, procurement, and quality report suites with defined parameters that render quickly,
So that I can produce standard operational reports on demand.

**Acceptance Criteria:**

**Given** inventory data (FR-R-04) and report parameters (date range, location set, item category)
**When** the inventory report suite is run
**Then** three reports are produced: aging (stock bucketed by configurable age ranges, default 0-30/31-60/61-90/90+ days, by location and category), movement (opening balance + receipts - issues - adjustments = closing balance per SKU-location, reconciling to the event stream for the period), and valuation (valued at the Ind AS 2 costing method configured in Story 2.4, stated in the report header, with the report total tying to the Epic 11 inventory subledger balance for the same period)

**Given** procurement data (FR-R-04, FR-P-08)
**When** the procurement report suite is run
**Then** PO status, spend analytics (by supplier, category, location, department, and period), and MSME ageing reports are produced — covering all five FR-P-08 dimensions

**Given** quality data (FR-Q-13, delivered under Epic 8)
**When** the cross-module reporting surface is opened
**Then** the Epic 8 quality report suite (first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events) is reachable from the same surface without re-implementation

**Given** any report in this story (NFR-P-03)
**When** it is run at production data volumes
**Then** it completes under 10 seconds — the bound applies to every report suite in this story, not to any single suite

**Dev note:** Deferred to Phase 2 (Epic 15): the FR-R-05 fulfillment report suite (order status, backorders, fill rate by location) requires the Epic 15 order-management module and ships as a companion story when Epic 15 is broken down. This story is completable with the inventory, procurement, and quality suites alone.

---

### Story 12.4: Self-Service Ad-Hoc Report Builder and Export

As a role-holder with report-builder permission (e.g., finance or inventory controller),
I want a drag-and-drop ad-hoc report builder over the projections my role can read, with Excel/PDF/CSV export,
So that teams can build their own reports without engineering help.

**Acceptance Criteria:**

**Given** the read model projections (FR-R-06)
**When** a user builds an ad-hoc report by drag-and-drop
**Then** they can select fields, apply filters, and group/aggregate across the projections their role has read permission on, and export the result to Excel, PDF, or CSV

**Given** a builder user whose role scope excludes a location or cost-level fields (NFR-SEC-06)
**When** the report executes
**Then** rows outside their location scope are excluded and restricted columns are masked before rendering or export — never emitted and hidden client-side; composing over a projection the role has no read permission on is rejected with `error_code: "REPORT_PERMISSION_DENIED"`

**Given** a report whose result exceeds the configured export row limit (default 100,000 rows)
**When** export is attempted
**Then** it is rejected with `error_code: "EXPORT_LIMIT_EXCEEDED"` and the user is prompted to narrow filters or schedule the report for asynchronous delivery (Story 12.6)

**Given** a report definition (FR-R-06)
**When** the owner saves it
**Then** the owner can rerun it later; sharing with other users and scheduled distribution are Story 12.6

**Dev note:** Record the build-vs-embed decision (custom composable query layer vs. an embedded OSS BI engine) as an ADR before implementation. Constraints either way: the event-sourced read model projections are the only data source, data-level RBAC (NFR-SEC-06) is enforced in the query path (not the UI), the builder is a Tier-2 online control-plane surface per NFR-P-04 (not an offline-first flow), and the export limits above apply. Scheduled distribution (FR-R-07) and shared definitions (FR-R-08) are split to Story 12.6.

---

### Story 12.5: Configurable Exception Rule Engine

As an operations lead,
I want to create, edit, and deactivate exception rules over the read model projections, with a defined alert lifecycle,
So that each role's dashboard surfaces breaches automatically and no alert is duplicated, orphaned, or silently lost.

**Acceptance Criteria:**

**Given** a user with rule-administration permission (FR-R-02)
**When** they create a rule naming a projection field, a comparison operator, a threshold, and a target role dashboard
**Then** the rule is saved, versioned, and active from the next evaluation cycle; edits and deactivations are logged with actor and timestamp

**Given** a rule definition with an invalid threshold (e.g., non-numeric for a numeric field) or referencing a projection field that does not exist
**When** it is submitted
**Then** it is rejected with `error_code: "INVALID_RULE_DEFINITION"` and the offending attribute is identified in the error details

**Given** an active rule (FR-R-02)
**When** an item breaches the rule threshold
**Then** an exception alert is raised on the target role dashboard (Story 12.1) referencing the rule and the breaching item

**Given** an alert already open for a rule-item combination
**When** subsequent evaluation cycles find the breach persisting
**Then** the existing alert is updated (last-evaluated timestamp) and no duplicate alert is created while the breach persists

**Given** an open alert
**When** the underlying value returns within the threshold, or a user acknowledges the alert
**Then** the alert auto-clears on recovery, or is marked acknowledged with actor and timestamp — both transitions are recorded in the alert history

---

### Story 12.6: Scheduled Report Distribution and Shared Definitions

As a role-holder with report-builder permission,
I want saved reports distributed on a schedule and shareable with other users under their own permissions,
So that recurring reports arrive without manual runs and sharing never leaks data beyond a recipient's scope.

**Acceptance Criteria:**

**Given** a saved report definition (FR-R-07)
**When** a schedule is configured
**Then** the report is rendered and distributed by email to named recipients on the schedule, and every delivery is logged with definition, recipients, and timestamp

**Given** a scheduled delivery fails — render error or mail rejection (FR-R-07)
**When** the failure occurs
**Then** delivery is retried (default 3 attempts with backoff); on final failure the run is logged with `error_code: "REPORT_DELIVERY_FAILED"` and surfaced as an exception alert to the report owner — never silently dropped

**Given** a report definition shared with another user (FR-R-08)
**When** the recipient runs it
**Then** it executes under the recipient's own permission scope — rows outside their location scope are excluded and restricted columns are masked at render time, never inherited from the owner's scope

**Given** a recipient (shared or scheduled) who has no read permission on any projection the report uses (FR-R-08, NFR-SEC-06)
**When** the report is run or the scheduled render for that recipient executes
**Then** the run is rejected for that recipient with `error_code: "REPORT_PERMISSION_DENIED"` and the owner is notified; scheduled renders always execute under each recipient's own permissions

---

## Epic 13: Data Migration Sign-Off Gate

The system goes live with zero unexplained opening-balance variances (SM-48). Every Phase-1 migration domain — opening stock, active BOMs, open POs, job-work challans, and custody registers — is verified in the new system, and department heads plus finance sign off — that sign-off is the go-live gate (FR-DM-03). Migration execution runs concurrent with Epics 2-12; these stories are the verification and sign-off events that unblock go-live, staged per go-live wave to the modules each wave deploys. Gate-pass migration (Epic 20) and asset-register migration (Epic 17) defer to their owning epics; open sales orders enter as Story 2.9 read-only ERP projections, not migration.

### Story 13.1: Opening Stock Migration and Verification

As a migration lead,
I want physically-verified opening stock imported by location, lot, and serial into staging with a variance report against ERP and legacy records,
So that we start with a proven, reconciled opening balance.

**Acceptance Criteria:**

**Given** physically-verified opening stock (FR-DM-01)
**When** it is imported into the staging environment
**Then** it is loaded by location, lot, and serial with each row attributed to its physical-verification source

**Given** migrated opening balances (FR-DM-01)
**When** the variance report is run
**Then** migrated balances are compared to ERP and legacy records and every variance is listed

**Given** an unexplained variance (FR-DM-01, SM-48)
**When** promotion from the staging load to the dry-run stage is attempted
**Then** promotion is blocked with `error_code: "VARIANCE_UNRESOLVED"` until the variance is explained (a recorded variance-explanation entry naming cause and approver) or resolved (a corrected import row)

**Given** an import file containing malformed rows or rows referencing unknown item or location codes (FR-DM-01)
**When** the import is run
**Then** each failing row is rejected with a row-level `error_code: "MALFORMED_ROW"` or `error_code: "UNKNOWN_REFERENCE"`, valid rows still load, and a rejected-row report lists every rejection with its source file and line

**Given** an import row whose lot or serial number duplicates one already loaded (FR-DM-01)
**When** the import is run
**Then** the row is rejected with `error_code: "DUPLICATE_LOT_SERIAL"` and appears on the rejected-row report

**Given** an import run that failed partway (FR-DM-01)
**When** the corrected file is re-submitted
**Then** the import resumes without duplicating previously accepted rows — already-loaded rows are suppressed idempotently as `DUPLICATE_EVENT`, and only new or corrected rows are applied

**Dev Notes:**

- Stage model per the epic critical note: extraction → staging load → dry-run → reconciliation. This story's blocking AC guards the staging-load → dry-run promotion.
- Import format: versioned CSV templates per location carrying item, location, lot, serial, quantity, and the physical-verification source reference per row. ERP and legacy balances for the variance report come from the same read-only ERP staging views that feed Story 2.9's projections — no alternative extract path.
- Loads, rejections, variance explanations, and stage promotions are recorded as domain events (e.g., `migration.opening_stock.loaded`, `migration.variance.explained`, `migration.stage.promoted`) in the `domain_events` table per the event-sourced architecture.
- Deferred to Phase 2 (Epic 17): asset-register migration (cost, accumulated depreciation, remaining Schedule II life — FR-DM-01 clause). The asset register migrates in the wave in which Epic 17 Fixed Assets deploys; it is not part of this gate.

---

### Story 13.2: Active Document Migration — BOMs, POs, Challans, Custody Registers

As a migration lead,
I want active BOMs, open POs, job-work challans with source references, and custody and loan registers migrated with department-head verification per domain,
So that in-flight operations continue seamlessly in the new system.

**Acceptance Criteria:**

**Given** a domain's migration output (FR-DM-02)
**When** the domain verification run executes
**Then** active BOMs, open POs, job-work challans with source references, and custody and loan registers pass referential-integrity checks — every migrated document's item, location, supplier, and source-document references resolve — and per-domain reconciliation counts (source records vs migrated records) are produced on the domain verification report

**Given** a migrated document with an unresolvable reference — e.g., an open-PO line whose item is absent from the item master, or a challan source reference that cannot be matched (FR-DM-02)
**When** the domain verification run executes
**Then** the document is quarantined with `error_code: "UNKNOWN_REFERENCE"` and listed on the domain verification report the department head reviews — it does not count as migrated

**Given** migrated open-PO balances (FR-DM-01)
**When** the open-PO domain is verified
**Then** each migrated open-PO line (ordered, received, and open quantities with line tolerances) reconciles against the Story 2.9 ERP inbound reference projection, and every mismatch is listed on the domain verification report

**Given** migrated documents in a domain (FR-DM-02)
**When** the department head reviews them
**Then** a verification sign-off is recorded per domain before that domain is considered migrated

**Given** a domain without a department-head sign-off (FR-DM-02)
**When** the domain's verification status is queried
**Then** the domain reports status `unverified` — this per-domain status is queryable at any time and is the input Story 13.3's go-live gate consumes

**Dev Notes:**

- Boundary: migration *execution* is owned by the module epics (see the epic critical note and each epic's migration-prep note); this story owns the verification checks, reconciliation counts, quarantine handling, and the per-domain sign-off event (`migration.domain.verified` in `domain_events`). The sign-off workflow is one parameterized flow reused across domains.
- Custody-register staging: job-work custody ledgers (Epic 9) verify in the pilot wave; Epic 10 custody/loan registers are Phase 1 but outside the pilot slice — their migration and sign-off are staged to the wave in which Epic 10 deploys.
- Open sales orders are not migrated: they remain in ERP and enter the system exclusively as Story 2.9 read-only projections (this satisfies the FR-DM-01 sales-order clause by projection, not migration); that feed is verified within Story 2.9.
- Deferred to Phase 2 (Epic 20): open gate-pass migration (FR-DM-02 clause). No Phase-1 gate-pass entity exists; legacy open gate passes remain in the legacy register until Epic 20 ships and migrates them.

---

### Story 13.3: Go-Live Reconciliation Sign-Off Gate

As a program director,
I want a final reconciliation of all migrated data to ERP and legacy records with department-head and finance sign-off as a mandatory go-live gate, and a go-live unblock event once SM-48 is verified,
So that go-live only happens when the data is provably correct.

**Acceptance Criteria:**

**Given** all migrated data (FR-DM-03)
**When** the final reconciliation is run
**Then** a reconciliation report is produced covering every domain in the wave's go-live scope — per-domain record counts (source vs migrated), quantity and value variances, and the explanation status of each variance — and any remaining discrepancy is surfaced on it

**Given** completed reconciliation (FR-DM-03)
**When** go-live is requested without department-head and finance sign-off
**Then** go-live is blocked with `error_code: "APPROVAL_REQUIRED"` until both sign-offs are recorded

**Given** recorded department-head and finance sign-offs but a non-zero unexplained opening-balance variance (FR-DM-03, SM-48)
**When** go-live is requested
**Then** go-live is blocked with `error_code: "VARIANCE_UNRESOLVED"` and the response lists each unexplained variance blocking the gate

**Given** department-head and finance sign-off with zero unexplained opening-balance variance (FR-DM-03, SM-48)
**When** the sign-off gate is satisfied
**Then** a go-live unblock event is created in the system, releasing the go-live gate

**Dev Notes:**

- "Go-live" is the guarded cutover operation: activation of transactional posting for the wave's site(s). The gate blocks that activation event, nothing else.
- The gate evaluates the per-domain verification statuses recorded by Story 13.2 — every domain in the wave's go-live scope must be `verified` — plus zero unexplained opening-balance variance from Story 13.1's reconciliation (SM-48).
- Sign-offs and the unblock are domain events (`migration.signoff.recorded`, `golive.unblocked`) in the `domain_events` table per the event-sourced architecture; the unblock event is the durable record auditors check.
- Scope per wave: the gate covers exactly the modules deployed in the wave (pilot slice: Epics 1, 2, 3, 5, 7, 8, 9); domains owned by modules outside the wave gate their own later wave.
