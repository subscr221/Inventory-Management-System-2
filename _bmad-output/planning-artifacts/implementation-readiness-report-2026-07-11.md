---
stepsCompleted: ['step-01-document-discovery', 'step-02-prd-analysis', 'step-03-epic-coverage-validation', 'step-04-ux-alignment', 'step-05-epic-quality-review', 'step-06-final-assessment']
documentsIncluded:
  prd:
    - '_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md'
    - '_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md'
    - '_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/reconcile-scm-requirements.md'
    - '_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/review-rubric-walker.md'
  architecture:
    - '_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md'
  epics:
    - '_bmad-output/planning-artifacts/epics.md'
  ux: []
  annexOfRecord: 'PLANNING/archive/SCM-Requirements-Document.md'
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-11
**Project:** Inventory Management System_2

## Document Inventory

### PRD (folder: `prds/prd-Inventory Management System_2-2026-07-10/`)

| File | Size | Modified | Role |
|---|---|---|---|
| `archive/prd.md` | 64 KB | 2026-07-11 00:03 | Main PRD body (confirmed current by user) |
| `addendum.md` | 6 KB | 2026-07-11 00:03 | PRD addendum |
| `reconcile-scm-requirements.md` | 4.5 KB | 2026-07-10 | SCM requirements reconciliation companion |
| `review-rubric-walker.md` | 9.7 KB | 2026-07-10 | Review rubric companion |

### Architecture

| File | Size | Modified |
|---|---|---|
| `architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` | 22.6 KB | 2026-07-11 00:36 |

### Epics & Stories

| File | Size | Modified |
|---|---|---|
| `epics.md` | 146 KB | 2026-07-11 10:22 (uncommitted changes at assessment time) |

### UX Design

**None found.** No `*ux*` document exists in planning artifacts — UX alignment will be assessed as a gap.

### Discovery Notes

- No duplicate (whole + sharded) versions of any document inside `{planning_artifacts}` — no conflicts to resolve there.
- `docs/` (project_knowledge) does not exist; no supplementary context scanned.
- `.memlog.md` session-log files excluded from assessment.
- User confirmed `archive/prd.md` + `addendum.md` + companions as the authoritative PRD set despite the `archive/` folder name.

### Post-Discovery Findings (identified during Step 2)

- **Annex of record path is stale.** PRD §0 declares `PLANNING/SCM-Requirements-Document/` (sharded, v2.1) as the annex of record for full FR consequence detail. That folder was **deleted in commit 2375fff**. A single-file archive survives at `PLANNING/archive/SCM-Requirements-Document.md` (191 KB, 830 lines, modified 2026-07-10 21:06). Downstream story creation depends on this annex; the PRD's pointer must be corrected or the sharded annex restored.
- **Sharded PRD copy exists outside planning artifacts.** `PLANNING/prd/` (17 shards, created 2026-07-11 00:13) is a sharding of the confirmed whole PRD (content size 63.8 KB vs 64 KB — same content, sharded 10 minutes after the final whole-PRD edit). Not a divergent fork, but a dual-source drift risk going forward: two copies of the PRD now exist with no declared precedence.
- **Reconciliation Finding 1 (missing BO family) appears resolved.** `reconcile-scm-requirements.md` (2026-07-10 21:40) reported BO-1..BO-12 absent from the PRD; the current PRD (modified 2026-07-11 00:03) contains §1.1 Business Objectives with all twelve BOs. The reconciliation report predates the fix.

## PRD Analysis

Source: `archive/prd.md` (all 15 sections + §1.1), `addendum.md`, both read in full. The PRD is a chain-top document: FR statements are normative capability summaries carrying stable source IDs; full consequence detail lives in the annex of record (see stale-path finding above). Extraction below is verbatim from the PRD.

### Functional Requirements

**Total FR IDs: 269 across 23 families.** Where the PRD compresses a range to one collective statement (by design), the range is shown with its collective text.

#### Core Inventory (§4.1, source §3.1) — 10 FRs

- **FR-I-01:** Multi-location stock tracking with real-time per-location and consolidated views.
- **FR-I-02:** Inter-location transfer requests, approvals, pick/ship/receive with lot and serial traceability.
- **FR-I-03:** Reorder points and automated replenishment recommendations or auto-requisitions per SKU per location.
- **FR-I-04:** Lot, batch, and serial tracking for traceability, FEFO/FIFO expiry management, and recall readiness.
- **FR-I-05:** Valuation by FIFO and weighted average; specific identification where required; standard cost only as an Ind AS 2 para 21 measurement technique. LIFO is not offered.
- **FR-I-06:** Cycle counting and physical inventory with variance workflows and approval-gated adjustments.
- **FR-I-07:** Safety stock computed from lead-time and demand variability against target service levels.
- **FR-I-08:** Aging and obsolescence flagging feeding disposition and NRV testing.
- **FR-I-09:** Kit assembly/disassembly transactions, executing only against Released BOMs (superseded as definition record by FR-B-02).
- **FR-I-10:** Consignment and VMI stock segregated from owned inventory.

#### Warehouse Operations (§4.2, source §3.5) — 9 FRs

- **FR-W-01:** Warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine attributes.
- **FR-W-02:** Receiving against ASN or PO with lot/serial, expiry, and QC capture; generates putaway tasks. Realizes UJ-GATE-01 and UJ-WEIGH-01 at the inbound edge.
- **FR-W-03:** System-directed and user-selected putaway by velocity, size, zone rules. Realizes UJ-PUT-01.
- **FR-W-04:** Picking with optimized paths; single-order, batch, wave, and zone strategies; paper and mobile-directed.
- **FR-W-05:** Packing-station workflow with validation, weights, labels, packing slips, cartonization.
- **FR-W-06:** Shipping documents (BOL, commercial invoice, customs docs), carrier rate shopping, load planning.
- **FR-W-07:** Task generation, assignment, prioritization, and productivity tracking.
- **FR-W-08:** Forward-pick replenishment from reserve storage on min/max or demand signals.
- **FR-W-09:** Flow-through and distribution cross-docking.

#### Procurement, Tendering, and Supplier Management (§4.3, source §3.2, §3.3) — 16 FRs

- **FR-P-01:** Centralized supplier registry (contacts, tax IDs, terms, certifications, compliance docs).
- **FR-P-02:** Supplier onboarding workflow with document collection and approval routing.
- **FR-P-03:** Supplier performance capture and scorecards (on-time delivery, quality acceptance, price, responsiveness).
- **FR-P-04:** Purchase requisitions with configurable approval rules by amount, category, department. Realizes UJ-IND-01.
- **FR-P-05:** PO management: blanket, contract, and standard POs tracked issuance through receipt and invoicing.
- **FR-P-06:** Goods receipt against PO with QC inspection workflow and accept/reject/conditional outcomes.
- **FR-P-07:** Three-way match (PO, receipt, invoice) with tolerances, discrepancy flags, credit/debit notes.
- **FR-P-08:** Spend analytics by supplier, category, location, department, period.
- **FR-P-09:** MSME compliance: Udyam capture with annual revalidation; statutory due-date stamping (earlier of agreed date and 45 days, or the 15-day appointed day); classification-tagged ageing fed to ERP for s.43B(h) and MSMED s.16 exposure.
- **FR-T-01 to FR-T-07:** Tender lifecycle: authoring (RFQ/RFP/RFI) with templates, supplier invitation, secure bid portal, clarification Q&A, controlled bid opening with weighted scoring, award approval and notification, contract generation linked to POs.

#### Order Management, Demand Planning, and Logistics (§4.4, source §3.4, §3.6, §3.7) — 24 FRs

- **FR-O-01 to FR-O-08:** Order capture (manual, EDI, e-commerce, internal, inter-branch), validation (completeness, credit, availability), routing by configurable rules, split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, drop shipping.
- **FR-D-01 to FR-D-08:** Historical data analysis at SKU-location grain, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, NPI forecasting by analogy, replenishment planning (with BOM explosion for dependent demand per FR-B-07), inventory optimization and redistribution.
- **FR-L-01 to FR-L-08:** Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, returns logistics.

#### R&D Centre and Maker-Hub Operations (§4.5, source §3.9) — 20 FRs

- **FR-RD-01:** R&D store and maker-hub store as first-class location types with their own stock ledgers.
- **FR-RD-02:** R&D-designated stock flag blocking cross-issue between R&D and production without approved reclassification.
- **FR-RD-03:** R&D project master (code, owner, research/development phase tag, budget, status); no material transaction posts without an active project code.
- **FR-RD-04:** Requisition with committed-plus-actual budget check; breaches route to project owner and R&D head.
- **FR-RD-05:** Three issue types with distinct semantics: consumable, project material (accumulates WIP), equipment custody (loan).
- **FR-RD-06:** Equipment custody register with named custodian, expected return, condition codes, overdue aging.
- **FR-RD-07:** Per-project WIP ledger in quantity and cost, real time, feeding FR-AC treatment.
- **FR-RD-08:** Prototype build records including failed and abandoned builds with full material history.
- **FR-RD-09:** Completed builds register serialized prototypes in a non-saleable class; sales orders and dispatch blocked.
- **FR-RD-10:** Four prototype dispositions (retain as asset, transfer to production reference, teardown, scrap), each R&D-head approved.
- **FR-RD-11:** Teardown component recovery with condition codes; scrap lines route to FR-SC.
- **FR-RD-12:** Unused material returns reversing project WIP.
- **FR-RD-13:** Hub member and walk-in customer records; every booking, sale, and job card references exactly one.
- **FR-RD-14:** Machine-time booking with operator-closed actuals and meter readings; 24-hour unclosed-booking exceptions.
- **FR-RD-15:** Offline-capable point-of-use material sale decrementing hub stock and billing the member (NFR-U-05).
- **FR-RD-16:** Member job cards collecting bookings, hours, purchases; statements on demand and monthly.
- **FR-RD-17:** Hub replenishment via FR-I-03 reorder control against serving warehouse or purchase.
- **FR-RD-18:** Monthly hub and quarterly R&D physical verification, custodian confirmation of on-loan equipment.
- **FR-RD-19:** Project material cost reporting reconciled line-for-line to the store ledger; feeds Form 3CL and IAUD.
- **FR-RD-20:** Walk-in payment capture via UPI dynamic QR or card terminal with end-of-day reconciliation.

#### BOM and Engineering Change Management (§4.6, source §3.10) — 17 FRs

- **FR-B-01:** Multi-level versioned BOMs with per-line scrap percent, UoM conversion, effectivity; explosion to any depth.
- **FR-B-02:** Supersedes FR-I-09 kit definitions; existing kits migrate as single-level production BOMs at go-live.
- **FR-B-03:** Revision control with non-overlapping date effectivity; released revisions immutable.
- **FR-B-04:** ECO workflow (Draft, Under Review, Approved, Implemented, Cancelled) with stock disposition; only Implemented ECOs alter a Released BOM.
- **FR-B-05:** Where-used and impact analysis across BOMs, open orders, POs, and stock, shown at ECO approval.
- **FR-B-06:** Lifecycle states (Draft, Released, On Hold, Obsolete); release gated on released item masters, scrap percents, cost rollup, ECO approval.
- **FR-B-07:** Explosion to execution at production-order release, driving directed issue or backflush; replicated per plant for offline continuity.
- **FR-B-08:** Consumption variance reporting at order closure with tolerance flags; feeds FR-SC reconciliation and scrap-percent recalibration.
- **FR-B-09:** R&D draft BOM regime: in-place edits, placeholders, free text; barred from production execution.
- **FR-B-10:** Clone production BOMs into R&D drafts; immutable as-built snapshots per build with deviation flags.
- **FR-B-11:** Productization gate checklist with engineering, procurement, and QC sign-offs.
- **FR-B-12:** Approved alternates with priority and effectivity; ad-hoc substitutions require logged approval.
- **FR-B-13:** Phantom assemblies passing through to components.
- **FR-B-14:** Co-products and by-products with expected yields posting as distinct lots.
- **FR-B-15:** Cost rollups as dated simulation snapshots with comparison; valuation stays in ERP.
- **FR-B-16:** Job-work kit BOMs tagged by supply source (company, customer, job-worker) with reconciliation.
- **FR-B-17:** BOM system of record with INT-ERP-01 sync; inbound conflicts create BOM Administrator exceptions, never overwrites.

#### Production Orders and Production WIP (§4.7, source §3.16) — 13 FRs

- **FR-MO-01:** Production order record with immutable number, output item/quantity, plant, BOM version, stream tag, source reference.
- **FR-MO-02:** Lifecycle: Planned, Released, In Process, Completed, Closed; Cancelled only from Planned/Released with no unreversed transactions.
- **FR-MO-03:** Release gate: effective Released BOM plus availability check; override by named authority flags to expediting.
- **FR-MO-04:** Staging and issue: pick tasks for directed lines, allocated status until issue; backflush lines post on confirmation.
- **FR-MO-05:** Production WIP ledger per order in quantity and value, distinct from R&D project WIP.
- **FR-MO-06:** Returns to stock with reason codes, reversing WIP at issued cost, restoring lot identity.
- **FR-MO-07:** Completions post good quantity into QC Hold as new FG lots; co/by-products post separately.
- **FR-MO-08:** Process scrap declarations relieving WIP and feeding expected-vs-actual reconciliation.
- **FR-MO-09:** Completion tolerances; over-completion blocked without supervisor approval; short completion resolution.
- **FR-MO-10:** Rework orders generated from QC dispositions, output re-entering the QC gate as linked lots.
- **FR-MO-11:** As-consumed lot genealogy per output lot; lot-controlled consumption without a recorded lot is blocked.
- **FR-MO-12:** Closure requires zero WIP, no open picks, QC disposition per output lot; closed orders immutable.
- **FR-MO-13:** Offline execution with replicated order data, sequenced replay, duplicate suppression; release/cancel/close central only.

#### Job-Work Services (§4.8, source §3.17) — 15 FRs

- **FR-JW-01:** Job-work service order: customer, spec reference, promised dates, price basis; links kit BOM (FR-B-16). Anchor for everything downstream.
- **FR-JW-02:** Lifecycle statuses from draft to closed, every change attributed.
- **FR-JW-03:** Customer material receipt only against confirmed orders through gate and receiving flows, challan captured.
- **FR-JW-04:** Customer-owned non-valuated stock class, segregated, blocked from any other demand.
- **FR-JW-05:** Custody ledger per customer and order with full movement categories; prints as custody statement.
- **FR-JW-06:** Consumption posting against the order following customer-supplied kit lines.
- **FR-JW-07:** Own-material additions billed distinctly from the service charge.
- **FR-JW-08:** Process loss norms; over-norm loss requires supervisor approval before dispatch readiness.
- **FR-JW-09/10:** Contractual offcut election (return, retain-and-buy, retain free) captured at confirmation and executed with documents.
- **FR-JW-11:** Output passes the FG quality gate before dispatch; partial dispatches supported.
- **FR-JW-12:** Measured billing feed (pieces, certified weight, or hours) handed to ERP for invoicing.
- **FR-JW-13:** Customer stock in physical verification with reconciliation on the next custody statement.
- **FR-JW-14:** Aging and statutory-window alerts computed from challan date with escalation.
- **FR-JW-15:** No closure while the custody ledger balance is non-zero.

#### Quality Control for Finished Goods (§4.9, source §3.12) — 15 FRs

- **FR-Q-01:** Versioned inspection plans per product-spec revision; QC Head approved; customer-spec overrides per job-work order.
- **FR-Q-02:** Finished-goods QC gate: all completions post into QC Hold; no bypass, urgency uses conditional release.
- **FR-Q-03:** AQL sampling per IS 2500 / ISO 2859-1 with switching rules; critical characteristics 100% inspected.
- **FR-Q-04:** Result capture referencing instrument asset IDs; out-of-calibration instruments rejected (lockout from FR-M-13).
- **FR-Q-05:** Exactly one recorded disposition per lot: Accept, Reject, or Conditional Release with deviation record; partial splits supported.
- **FR-Q-06:** NCR outcomes per quantity: rework (re-enters the gate), downgrade to seconds, or scrap to FR-SC.
- **FR-Q-07:** Batch release records and CoA/CoC per lot; retention default 7 years, never below BIS STI requirements.
- **FR-Q-08:** Retention samples block release until logged; expiry alerts route to disposal.
- **FR-Q-09:** Quality holds on released lots flip stock to Blocked everywhere; where-used and where-shipped trace within 15 minutes.
- **FR-Q-10:** NCR defect codes and CAPA linkage; repeat NCRs (3+ same product and defect in 90 days) require CAPA.
- **FR-Q-11:** BIS hooks: licence validity blocks release; CM/L or R-number printed on release records and CoC.
- **FR-Q-12:** Prototype verification as design evidence; prototypes barred from sellable status.
- **FR-Q-13:** Quality reporting: first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events.
- **FR-Q-14:** Packaged-commodity label compliance (Legal Metrology): version-controlled label masters; release blocked without a current approved version.
- **FR-Q-15:** Customer-witnessed and third-party inspection: witness and hold points, recorded notice, dispatch blocked until hold points clear or a recorded waiver exists.

#### Maintenance, Calibration, and Tooling (§4.10, source §3.11, §3.19) — 35 FRs

- **FR-M-01:** Maintainable asset register company-wide with criticality classes and scannable tags; fixed-asset link optional.
- **FR-M-02:** Calendar and meter-based PM plans auto-generating work orders with grace-window tracking.
- **FR-M-03:** Usage meter feeds from hub bookings and station equipment plus manual readings; monthly reconciliation; silent-meter alerts.
- **FR-M-04:** Fault reporting by any user via tag scan; reaches the location's maintenance supervisor within 5 minutes.
- **FR-M-05:** Breakdown work-order lifecycle with priority from criticality and safety flags; configurable SLAs.
- **FR-M-06:** Downtime capture and monthly MTTR/MTBF per asset and class.
- **FR-M-07/08/09:** Spares catalogued under FR-I with where-used from equipment BOMs; reservation, issue, 3-working-day returns; critical-spares min-max with same-day breach alerts.
- **FR-M-10/11:** AMC, warranty, insurance records with 90/60/30-day expiry alerts; warranty check at work-order creation with reason-coded override.
- **FR-M-12:** Calibration register (in-house or ISO/IEC 17025 external) with certificates and 30/14/7-day alerts.
- **FR-M-13:** Out-of-calibration lockout: no role can override; escalation expedites, never bypasses.
- **FR-M-14:** Statutory examination tracking (OSH Code periodicities, weighbridge 12-month stamping); overdue items lock the asset; repaired weighbridges block trade weighment until re-stamped.
- **FR-M-15:** Maintenance cost accumulation per asset; repair-vs-capitalize flag routes to FR-FA above threshold.
- **FR-M-16:** Machine status broadcast within 2 minutes to production planning and hub booking; return-to-service needs supervisor sign-off.
- **FR-M-17:** Fully offline technician workflow with sync and conflict flagging.
- **FR-M-18:** Closure codes (fault, cause, remedy) with last-five-closures history at work-order open.
- **FR-TL-01 to FR-TL-17:** Tool crib: tool master with class and QR tag; where-used through FR-B; asset and cost cross-reference; scan-based custody issue and return with overdue escalation; hub member lending with block policy; perishable tooling as min-max stock; life counters auto-incremented from production confirmations; warning and hard-stop thresholds blocking issue; life history surviving regrinds; regrind/repair routing (with confidentiality reference for IP-sensitive tooling); regrind limits proposing condemnation; condemnation exits through FR-SC with defacement; gauge calibration lockout at issue; personal PPE issue register with renewal cycles; tool availability broadcast to planning and booking; offline crib transactions with conflict escalation.

#### Scrap, Defectives, and Disposal (§4.11, source §3.13) — 22 FRs

- **FR-SC-01:** Source-linked intake only (production scrap, QC rejection, obsolescence, teardown, replaced parts, retired assets).
- **FR-SC-02:** Single classification at intake determining bins, routes, statutory channel; reclassification audit-logged.
- **FR-SC-03:** Segregated scrap-yard bins per class; restricted bins block cross-class putaway.
- **FR-SC-04:** Weighment (weighbridge or calibrated scale) with photo evidence; declared-vs-weighed variance exceptions.
- **FR-SC-05:** Expected-vs-actual scrap reconciliation against BOM scrap percents, feeding pilferage indicators.
- **FR-SC-06/07:** Defective disposition workflow (repair, refurbish-downgrade, cannibalize, condemn) with committee escalation; cannibalized component recovery.
- **FR-SC-08:** IP-sensitive lots require evidenced defacement before any sale.
- **FR-SC-09:** NRV fields per lot with rate source and valuer.
- **FR-SC-10:** Disposal approvals resolved through the DOA registry; proposer, approver, custodian must be three different users.
- **FR-SC-11/12:** Buyer registration (GSTIN, PAN, SPCB/CPCB credentials for regulated categories) with blacklisting; lot creation with sealed reserve prices.
- **FR-SC-13:** Auction via tender mechanics in reverse; below-reserve or single-bid outcomes escalate to committee.
- **FR-SC-14/15/16:** EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment.
- **FR-SC-17:** Sale documents with GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers.
- **FR-SC-18:** Hazardous waste to authorized recyclers/TSDFs with Form 10 manifests and the non-disableable 90-day storage timer.
- **FR-SC-19:** E-waste, battery, and non-ferrous EPR channels; awards blocked to unregistered buyers.
- **FR-SC-20:** Write-off and destruction with witness and evidence; auto-triggers ITC reversal evaluation and FA derecognition.
- **FR-SC-21:** Generated vs weighed vs disposed reconciliation per class per location; internal audit read-only access.
- **FR-SC-22:** Plastic packaging EPR data by category, GSTIN, and financial year for CPCB portal returns.

#### Fixed Assets, Intangibles, and Depreciation (§4.12, source §3.14) — 20 FRs

- **FR-FA-01 to FR-FA-06:** Asset master with tags and parent-child components; capitalization from procurement through CWIP at Ind AS 16 available-for-use; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs posting to ERP after preview.
- **FR-FA-07:** Dual views: Companies Act books view plus report-only income-tax block-of-assets WDV view.
- **FR-FA-08:** Effective-dated transfers reallocating depreciation; inter-GSTIN moves trigger FR-AC-10 documents before dispatch.
- **FR-FA-09/10:** Subsequent expenditure decisions; repair-vs-capitalize queue from FR-M work orders, none undecided at period lock.
- **FR-FA-11:** Impairment indicator capture per Ind AS 36.
- **FR-FA-12:** Retirement and disposal through FR-SC with gain/loss computation.
- **FR-FA-13:** Offline physical verification by tag scan per CARO 2020 with reconciliation evidence.
- **FR-FA-14:** Immutable asset audit trail.
- **FR-FA-15 to FR-FA-20:** Intangibles: register separate from PPE; IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing; capitalization and amortization at available-for-use; annual reviews of period, method, and indefinite-life assessments; impairment extension including annual tests where required; derecognition and approval-gated IAUD write-offs.

#### Financial Compliance Spine (§4.13, source §3.15, §3.18, §3.21, §3.22) — 28 FRs

- **FR-AC-01:** Every inventory movement carries business stream, cost centre, and project code where applicable; untagged transactions blocked.
- **FR-AC-02/03:** Research-phase issues expense; development-phase capitalization only after the six-criteria checklist; no retroactive reinstatement.
- **FR-AC-04:** Project-wise R&D cost ledgers producing DSIR and Form 3CL-ready statements.
- **FR-AC-05/06:** Permitted cost formulas per Ind AS 2; period-end NRV testing with capped reversals.
- **FR-AC-07/08:** ITC register per GSTIN traced to GRN, invoice, and IRN; ITC reversal computed on write-offs before disposal closes.
- **FR-AC-09:** Scrap-sale tax events (GST classification, e-invoice, e-way bill, TCS) as dated configuration, not code.
- **FR-AC-10:** Branch transfers between GSTINs as taxable supplies with Rule 28 valuation and documents before dispatch.
- **FR-AC-11:** Job-work challans (Rule 45) with one-year and three-year return clocks, deemed-supply on breach, ITC-04 data.
- **FR-AC-12:** Maker-hub B2C invoices at item rates, separated from machine-time service charges; never miscellaneous income.
- **FR-AC-13:** Statutory edit log: tamper-proof, non-disableable, retained per books-retention, auditor-reportable.
- **FR-AC-14:** Dispatch blocked for e-invoiceable supplies until IRN and signed QR received.
- **FR-AC-15:** Period locks, GRNI ageing, subledger-to-GL reconciliation, CARO physical-verification evidence with the 10% test.
- **FR-AC-16:** Funding-source tagging (internal, DSIR, DST, grants) on R&D projects flowing to every cost ledger entry.
- **FR-IM-01 to FR-IM-09:** Imports: import-flagged POs with dual exchange rates; Bill of Entry capture by duty head; import IGST into the ITC register (BCD/SWS never creditable); landed cost sheets with selectable allocation bases; valuation posting keeping recoverable taxes out of item cost; provisional assessment lifecycle with two-year window; late cost true-up windows with PPV fallback; ICEGATE/GSTR-2B reconciliation; duty-exemption licence hooks (Advance Authorisation, EPCG).
- **FR-BC-01/02:** ERP-synced budget heads and availability; inline budget-remaining at approval with configurable warn-or-block; commitments reduce availability until ERP actuals sync. No budget masters held locally.
- **FR-DOA-01:** One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow; workflow config consumes, never overrides it.

#### Gate Passes, Returnable Materials, and Frontline Edge Capture (§4.14, source §3.20, §9) — 14 FRs

- **FR-GP-01:** RGP and NRGP as distinct serially numbered documents per GSTIN and site; required for every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch.
- **FR-GP-02/03:** RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request).
- **FR-GP-04:** Rule 55 delivery challans and e-way bill triggers for non-sale movements above threshold.
- **FR-GP-05/06/07:** Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return updating asset registers.
- **FR-GP-08:** NRGP only for permitted non-returnable reasons with DOA approval.
- **FR-GP-09:** Open-RGP ageing with 7/15/30-day reminder defaults and site-head escalation.
- **FR-GP-10:** Statutory and insurance window clocks per RGP class; hard alerts to named owners; no silent expiry.
- **FR-GP-11:** Gate enforcement: no matching open gate pass, no exit; mismatches raise incidents.
- **FR-GP-12:** Off-site asset visibility report by party, location, value for insurance and audit.
- **FR-GP-13/14:** Returnable packaging register with per-party bidirectional balances and serialized cylinders; deposits, refunds, forfeiture, and revaluation.

#### Reporting and Analytics (§4.15, source §3.8) — 8 FRs

- **FR-R-01 to FR-R-08:** Executive dashboard (turns, fill rate, spend, stockouts, forecast accuracy); operational dashboards per role; inventory, procurement, and fulfillment report suites; configurable exception alerts; drag-and-drop ad-hoc reporting with Excel/PDF/CSV export; scheduled report distribution.

#### Data Migration and Cutover (§12) — 3 FRs

- **FR-DM-01:** Physically verified opening stock by location, lot, and serial; asset register with cost, accumulated depreciation, and remaining Schedule II life; open POs, sales orders, and job-work challans with source references.
- **FR-DM-02:** Active BOMs, custody and loan registers, and open gate passes migrated and department-verified before cutover.
- **FR-DM-03:** Balances reconciled to ERP and legacy records; department-head and finance sign-off is a mandatory go-live gate. Validated by SM-48.

**Total FRs: 269 IDs (23 families: I-10, W-9, P-9, T-7, O-8, D-8, L-8, RD-20, B-17, MO-13, JW-15, Q-15, M-18, TL-17, SC-22, FA-20, AC-16, IM-9, BC-2, DOA-1, GP-14, R-8, DM-3)**

### Non-Functional Requirements

Extracted from PRD §8 (source §4 is normative; headline values carried):

- **NFR-S-01 to NFR-S-05 (Scale):** 50 locations scaling to 200+ without architectural change; 500k+ SKUs; 1,000 concurrent users with headroom to 5,000; 10k+ order lines/hour; 8-financial-year retention (3 online, archive restorable to queryable within 48 hours).
- **NFR-P-01 to NFR-P-05 (Performance):** operational screens under 2s; single-SKU stock queries under 1s; standard reports under 10s; API p95 under 500ms.
- **NFR-P-04 (Availability, restated as two-tier SLA, confirmed 2026-07-10):** Tier 1 — frontline edge capture (gate, weighbridge, putaway, crib, hub POS, technician flows) available 24x7 by offline-first architecture; device-local capture with store-and-forward; degraded state visible on device ("captured, pending sync"). Tier 2 — central control plane (order release, closure, IRN-gated dispatch, approvals) at 99.5% availability (target 99.9%) over per-site operating windows defined in the program plan.
- **NFR-SEC-01 to NFR-SEC-06 (Security):** SSO (SAML 2.0/OIDC); RBAC to module, function, location, and data level; TLS 1.2+ and AES-256; immutable audit log (extended by FR-AC-13); enforced segregation of duties; DPDP Act 2023 and DPDP Rules 2025 compliance.
- **NFR-DI-01 to NFR-DI-05 (Data integrity):** ACID inventory transactions; no double allocation; cross-location sync lag at most 5s with graceful partition handling; daily backups, RTO 4h, RPO 1h; idempotent financial postings.
- **NFR-U-01 to NFR-U-06 (Usability):** responsive on desktop and rugged tablets; WCAG 2.1 AA; i18n and multi-currency; offline-first frontline capture as a normal path; scan-first, glove-friendly, one-handed moment-of-use ergonomics.
- **NFR-E-01 to NFR-E-04 (Extensibility):** documented REST (and/or GraphQL) APIs; configurable workflows without code; plugin framework; upgrades under 30 minutes.
- **NFR-ADOPT-01 (Adoption):** captured frontline knowledge must visibly benefit the people who capture it; confirmation below 95% is a defect.
- **NFR-D-01/02 (Documents):** single attachment store with virus scanning; per-type retention classes with legal hold; deletion before expiry blocked and logged.

**Total NFRs: 34 IDs across 9 families.**

### Additional Requirements

- **Business objectives:** BO-1 through BO-12 (§1.1) — traceability anchors for success metrics.
- **User journeys (PRD-blocking):** UJ-GATE-01 (offline gate logging), UJ-WEIGH-01 (trusted weighbridge capture), UJ-PUT-01 (locator override with provenance; last-writer-wins banned), UJ-IND-01 (indent raise-to-status loop under 90 seconds). Plus 29 scored story stubs in source §9.3 as seeded backlog for epics.
- **Success metrics:** SM-01 to SM-48 (normative catalogue carried whole; 8 primary called out: SM-01, SM-03, SM-10, SM-17, SM-28, SM-34, SM-41, SM-48) plus proposed counter-metrics SM-C1 to SM-C3 (unconfirmed).
- **Integration families (§10, source §6 normative):** INT-ERP-01..07 (dual mastership: BOM structure outbound, cost rates inbound, conflicts create exceptions, last-write-wins forbidden), INT-ACC-01..03, INT-EC-01..03, INT-3PL-01..03, INT-SUP, INT-CAR, INT-DC-01..03, INT-IAM-01/02 (SSO non-negotiable, C-03), INT-GATE-01 (vehicle-to-PO binding token + weighbridge event contract), INT-LOC-01 (event-sourced location: LocationAsserted vs LocationExpected, LocationDisputed on divergence, no silent merge), INT-GST-01..03 (IRP via ERP flow), INT-CUS-01, INT-MSME-01, INT-EPR-01 (manual first phase OK), INT-AUC-01, INT-MTR-01/02, INT-CAD-01, INT-PAY-01.
- **Hard sequencing dependencies (§10):** FR-M instrument records before FR-Q-04 lockout (C-12); BIS licence data in product master before FR-Q-11 (A-13); item-master governance in FR-I and INT-ERP-01 before FR-B-06 BOM release (A-11); migrated balances signed off before any go-live (FR-DM-03).
- **Compliance regimes (§9):** Ind AS 2/16/36/38/21/20; Companies Act 2013 (Schedule II/III, s.128(5), CARO 2020, audit-trail proviso); GST law (ITC, Rule 28, Rule 45/55, s.143, e-invoicing, e-way bills, dynamic QR); Income-tax Act 2025 (s.394(1) TCS, s.43B(h), s.35/Form 3CL); MSMED Act 2006 ss.15/16/22; Customs Act 1962 s.14/s.18; Legal Metrology (Rule 27 stamping, Packaged Commodities); BIS Conformity Assessment 2018; Hazardous Waste Rules 2016, E-Waste 2022, Battery Waste 2022, Plastic EPR through 2026 amendment; OSH Code 2020; DPDP Act 2023/Rules 2025.
- **Constraints and assumptions:** C-01 to C-13 carried (C-01 superseded by 36-month re-baseline; C-02 superseded by custom-build decision; C-04 superseded by India-only); A-01 to A-14 carried plus 6 PRD-added assumptions (§15).
- **Delivery approach (§6, confirmed 2026-07-10):** spine-first custom build over 36 months; compliance spine (edit log, DOA registry, event-sourced location, calibration/statutory lockouts, stream tagging) built and acceptance-tested first; first go-live slice = spine + core inventory + gate edge + job-work at one pilot site; waves of 2-3 locations. Phase 1 includes job-work (FR-JW) and R&D/maker-hub (FR-RD) by revenue-exposure direction. Phase 2: tenders, demand planning, logistics/TMS, e-commerce/3PL, fixed assets/intangibles, scrap/disposal/auction, imports, tooling, gate passes, meter automation.
- **Non-goals (§5):** not PLM/CAD, not predictive-maintenance IoT, not a GL, not an external marketplace, not MES, not HR/payroll/membership, not autonomous AI procurement, not customer order-tracking portal, not TMS replacement, not MRP engine (deferred, revisit after two quarters of stable BOM/lead-time data), not insurance claims.
- **Open questions (§14):** 10 items; resolved: multi-country (India only), COTS (custom build), availability (two-tier SLA); open/residual: unified retention table (OQ4), numeric "real-time" per feed (OQ5), DPDP compliance date (OQ6), full access matrix ~36 roles (OQ7, owner assigned, due before Phase 1 detailed design), baseline-dependent SM targets (OQ8), Phase 1/2 boundary sign-off (OQ9), budget envelope + build sourcing + spine acceptance contract (OQ10).

### PRD Completeness Assessment

**Strengths.** The PRD is disciplined and decision-ready: stable source IDs throughout, explicit non-goals, confirmed delivery decisions (custom build, spine-first, 36 months, two-tier SLA), assumption tagging with an index, counter-metrics against gaming, and compliance requirements pinned to specific statutes. Two independent companion reviews (reconciliation + rubric walk) found no contradictions with the source; the one material reconciliation finding (missing BO family) has since been fixed in the current PRD (§1.1 present).

**Gaps and risks for implementation readiness:**

1. **Stale annex-of-record pointer (material).** PRD §0's precedence rule and per-FR consequence detail depend on `PLANNING/SCM-Requirements-Document/` (sharded), deleted in commit 2375fff. The content survives as `PLANNING/archive/SCM-Requirements-Document.md`, but no document records this move; downstream story creation following the PRD's pointer will fail. The rubric review's medium finding (annex drift/versioning note) is aggravated by this.
2. **Per-FR acceptance detail is annex-resident by design.** "Done" for most of the 269 FRs is only knowable with the annex open; epics/stories must carry that detail forward or reference the annex correctly.
3. **Access matrix covers 7 of ~36 roles** (OQ7) — hard prerequisite for UX and RBAC design; owner assigned but matrix not yet produced.
4. **No UX document exists at all** (see Document Inventory) while the PRD demands frontline-first, offline-first, glove-friendly UX validated by SM-17.
5. **Phase boundary and budget are not fully signed off** (OQ9, OQ10) — wave composition beyond the confirmed slice is PM-proposed.
6. **Duplicate PRD copies** (whole at planning-artifacts, sharded at `PLANNING/prd/`) with no declared precedence — drift risk for downstream consumers.
7. **Counter-metrics SM-C1..C3 unconfirmed**; baseline-dependent SM targets (OQ8) lack owners and windows.

## Epic Coverage Validation

**Method.** A 25-agent parallel audit: one auditor per Phase-1 FR family verified story-level coverage against actual story acceptance criteria (the epics' own "FR Coverage Map" was treated as the claim under audit, never as evidence); every FR reported missing or partial was then re-examined by an adversarial verifier instructed to refute the claim; separate agents audited Phase-2 epic scope adequacy, reverse traceability (orphan FR IDs), and fidelity of the epics' FR inventory restatement against the PRD.

### Coverage Statistics

| Measure | Value |
|---|---|
| Total PRD FRs | 269 IDs (23 families) |
| Claimed coverage (FR Coverage Map) | 269/269 — 100% at map level |
| Phase-1 FRs (13 epics, 63 stories, story-level audit) | 156 IDs, audited as 147 line items |
| — Fully covered at story level | 104 items (~110 IDs) — 71% |
| — Partially covered (named clause lacks any story AC) | 43 items (~46 IDs) — 29% |
| — Entirely missing | **0** |
| Phase-2 FRs (Epics 14-20, stories deliberately not yet created) | 113 IDs — epic-level mapping only |
| — Phase-2 epic descriptions fully encapsulating family scope | 1 of 7 (Epic 14 only) |
| Orphan/unknown FR IDs in epics | 0 (reverse check clean) |

**Bottom line:** traceability structure is excellent — every one of the 269 FRs maps to an epic, no orphan IDs exist, and no Phase-1 FR is entirely unimplemented. The risk is concentrated in **43 partial gaps** (specific clauses of Phase-1 FRs with no story AC) and in **Phase-2 epic goals that under-state their family scope**, which will propagate into Phase-2 stories if not corrected before story creation.

### Coverage Matrix (Phase 1, story-level)

Statuses: ✓ full story-level coverage; ◐ partial (the quoted clause has no story/AC coverage). Full requirement text per FR is in the PRD Analysis section above.

| FR | Stories | Status | Gap (if partial) |
|---|---|---|---|
| **FR-I family — primary Epic 2** | | | |
| FR-I-01 | 2.2 | ✓ Covered |  |
| FR-I-02 | 2.5 | ✓ Covered |  |
| FR-I-03 | 2.7 | ✓ Covered |  |
| FR-I-04 | 2.3 | ✓ Covered |  |
| FR-I-05 | 2.1, 2.4 | ◐ Partial | "Specific identification where required" and "standard cost as Ind AS 2 para 21 measurement technique" have no story/AC coverage; specific identification appears only in Epic 2 goal prose; standard cost appears nowhere |
| FR-I-06 | 2.6 | ✓ Covered |  |
| FR-I-07 | 2.7 | ✓ Covered |  |
| FR-I-08 | 2.7 | ◐ Partial | "Feeding disposition": no story routes flagged aging/obsolete stock into a disposition workflow — obsolescence-sourced scrap intake (FR-SC-01) sits in Epic 16 (Phase 2, no stories) |
| FR-I-09 | 5.2, 6.1, 6.2, 6.3 | ◐ Partial | Kit assembly/disassembly TRANSACTIONS: assembly at best implicit via production orders; "disassembly" appears in no story or AC anywhere |
| FR-I-10 | 2.8 | ✓ Covered |  |
| FR-AC-05/06 | 2.4, 2.7 | ✓ Covered |  |
| **FR-W family — primary Epic 3** | | | |
| FR-W-01 | 3.1, 2.1 | ✓ Covered |  |
| FR-W-02 | 3.4, 3.2, 3.3 | ✓ Covered |  |
| FR-W-03 | 3.5, 3.1 | ◐ Partial | "size" as a putaway rule criterion — no story or AC mentions size-based putaway; Story 3.5 uses velocity class, zone rules, occupancy only |
| FR-W-04 | 3.6 | ◐ Partial | "paper"-directed picking — no story or AC mentions paper-based pick execution; Story 3.6 is mobile-directed (edge PWA) only |
| FR-W-05 | 3.7 | ✓ Covered |  |
| FR-W-06 | 3.7 | ◐ Partial | Customs docs, carrier rate shopping, load planning — no story/AC coverage; these appear only in the Epic 15 goal (Phase 2, no stories) |
| FR-W-07 | 3.8, 3.4, 3.6, 3.9 | ✓ Covered |  |
| FR-W-08 | 3.9 | ◐ Partial | "Demand signals" trigger — Story 3.9 covers only min/max breach; no demand-signal-driven forward-pick replenishment |
| FR-W-09 | 3.9 | ✓ Covered |  |
| **FR-P family — primary Epic 4** | | | |
| FR-P-01 | 4.1 | ◐ Partial | "Terms" — no story AC captures supplier commercial/payment terms in the registry |
| FR-P-02 | 4.1 | ✓ Covered |  |
| FR-P-03 | 4.2 | ✓ Covered |  |
| FR-P-04 | 4.3, 1.4, 4.4 | ◐ Partial | "Configurable approval rules by amount, category, department" — no Story 4.3 AC routes requisition approval through configurable rules; DOA registry configures role/type/value-band only; Story 4.4's resolution applies to POs, not requisitions |
| FR-P-05 | 4.4, 4.5 | ✓ Covered |  |
| FR-P-06 | 4.5, 8.3 | ✓ Covered |  |
| FR-P-07 | 4.5 | ✓ Covered |  |
| FR-P-08 | 12.3 | ✓ Covered |  |
| FR-P-09 | 4.6, 12.3 | ◐ Partial | "Classification-tagged ageing fed to ERP" — no AC tags ageing by MSME class (micro/small/medium) and no AC feeds ageing to ERP; internal reports only |
| **FR-B family — primary Epic 5** | | | |
| FR-B-01 | 5.1, 5.5 | ✓ Covered |  |
| FR-B-02 | 5.2 | ✓ Covered |  |
| FR-B-03 | 5.1, 5.2, 5.3 | ◐ Partial | "Non-overlapping date effectivity" — no AC enforces that revision effectivity windows cannot overlap |
| FR-B-04 | 5.3 | ◐ Partial | "With stock disposition" — no AC handles disposition of existing stock affected by an ECO |
| FR-B-05 | 5.3 | ✓ Covered |  |
| FR-B-06 | 5.1, 5.2 | ✓ Covered |  |
| FR-B-07 | 5.5, 6.2, 6.4 | ✓ Covered |  |
| FR-B-08 | 6.4 | ◐ Partial | "Feeds FR-SC reconciliation" — no story/AC hands variance data to scrap reconciliation (FR-SC-05 is Epic 16, Phase 2, no stories) |
| FR-B-09 | 5.4 | ✓ Covered |  |
| FR-B-10 | 5.4, 10.3 | ◐ Partial | "Immutable as-built snapshots... with deviation flags" — no AC makes the snapshot immutable or captures deviation flags |
| FR-B-11 | 5.4 | ✓ Covered |  |
| FR-B-12 | 5.5 | ✓ Covered |  |
| FR-B-13 | 5.1 | ✓ Covered |  |
| FR-B-14 | 5.1, 6.3 | ✓ Covered |  |
| FR-B-15 | 5.5 | ◐ Partial | "With comparison; valuation stays in ERP" — no AC provides snapshot comparison or states the ERP valuation boundary |
| FR-B-16 | 5.5, 9.3 | ◐ Partial | The "job-worker" supply source — PRD names three sources (company, customer, job-worker); Story 5.5 AC tags only "customer-supplied vs own" |
| FR-B-17 | 5.5 | ✓ Covered |  |
| **FR-MO family — primary Epic 6** | | | |
| FR-MO-01 | 6.1 | ✓ Covered |  |
| FR-MO-02 | 6.1, 6.4 | ◐ Partial | "Cancelled only from Planned/Released with no unreversed transactions" — no AC constrains cancellation states or requires reversal first |
| FR-MO-03 | 6.1 | ✓ Covered |  |
| FR-MO-04 | 6.2 | ✓ Covered |  |
| FR-MO-05 | 6.2, 10.3 | ✓ Covered |  |
| FR-MO-06 | 6.2 | ◐ Partial | "With reason codes" — no AC requires a reason code on production returns to stock |
| FR-MO-07 | 6.3 | ✓ Covered |  |
| FR-MO-08 | 6.3, 6.4 | ✓ Covered |  |
| FR-MO-09 | 6.3 | ◐ Partial | "Short completion resolution" — no AC anywhere addresses resolving short completions (Epic 6 goal prose only) |
| FR-MO-10 | 6.3, 8.3 | ✓ Covered |  |
| FR-MO-11 | 6.4 | ✓ Covered |  |
| FR-MO-12 | 6.4 | ◐ Partial | "Closed orders immutable" — no AC enforces that a Closed production order cannot be modified after closure |
| FR-MO-13 | 6.4 | ✓ Covered |  |
| **FR-M family — primary Epic 7** | | | |
| FR-M-01 | 7.1 | ✓ Covered |  |
| FR-M-02 | 7.2 | ✓ Covered |  |
| FR-M-03 | 7.2 | ◐ Partial | Manual readings as a meter feed source — Story 7.2 ACs name hub bookings and equipment readings only |
| FR-M-04 | 7.3 | ✓ Covered |  |
| FR-M-05 | 7.3 | ✓ Covered |  |
| FR-M-06 | 7.3 | ◐ Partial | MTTR/MTBF "per... class" — AC computes per asset only; no criticality-class aggregation |
| FR-M-07/08/09 | 7.4 | ✓ Covered |  |
| FR-M-10/11 | 7.4 | ◐ Partial | Reason-coded override of the warranty check — no story/AC covers it |
| FR-M-12 | 7.5 | ✓ Covered |  |
| FR-M-13 | 7.5 | ✓ Covered |  |
| FR-M-14 | 7.6 | ✓ Covered |  |
| FR-M-15 | 7.6 | ◐ Partial | "Repair-vs-capitalize flag routes to FR-FA above threshold" — no story/AC covers the flag or routing (Epic 17 is Phase 2, no stories) |
| FR-M-16 | 7.6 | ◐ Partial | "Return-to-service needs supervisor sign-off" — no story/AC anywhere |
| FR-M-17 | 7.6, 1.8 | ◐ Partial | "Conflict flagging" on sync — offline replay and duplicate suppression covered, but no AC flags sync conflicts for technician workflows |
| FR-M-18 | 7.6 | ◐ Partial | Three-part closure coding (fault, cause, remedy) and last-five-closures shown "at work-order open" — AC records a generic code at close only |
| **FR-Q family — primary Epic 8** | | | |
| FR-Q-01 | 8.1 | ✓ Covered |  |
| FR-Q-02 | 8.1, 3.4 | ✓ Covered |  |
| FR-Q-03 | 8.2 | ✓ Covered |  |
| FR-Q-04 | 8.2, 7.5, 1.7 | ✓ Covered |  |
| FR-Q-05 | 8.3, 8.1 | ✓ Covered |  |
| FR-Q-06 | 8.3 | ✓ Covered |  |
| FR-Q-07 | 8.4 | ◐ Partial | "Never below BIS STI requirements" — no story/AC enforces the BIS STI retention floor over the 7-year default |
| FR-Q-08 | 8.4 | ✓ Covered |  |
| FR-Q-09 | 8.5, 3.7 | ✓ Covered |  |
| FR-Q-10 | 8.5 | ✓ Covered |  |
| FR-Q-11 | 8.6, 8.4 | ◐ Partial | "CM/L or R-number printed on... CoC" — no AC requires the BIS number on the CoC |
| FR-Q-12 | 8.6 | ✓ Covered |  |
| FR-Q-13 | 8.6 | ◐ Partial | None of the five named quality metrics (first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events) appear in any story AC |
| FR-Q-14 | 8.6 | ✓ Covered |  |
| FR-Q-15 | 8.6 | ◐ Partial | "Recorded notice" — no story/AC records the inspection notice to the customer/third party |
| **FR-JW family — primary Epic 9** | | | |
| FR-JW-01 | 9.1 | ✓ Covered |  |
| FR-JW-02 | 9.1 | ✓ Covered |  |
| FR-JW-03 | 9.2 | ✓ Covered |  |
| FR-JW-04 | 9.2 | ✓ Covered |  |
| FR-JW-05 | 9.3 | ✓ Covered |  |
| FR-JW-06 | 9.3 | ✓ Covered |  |
| FR-JW-07 | 9.3 | ✓ Covered |  |
| FR-JW-08 | 9.4 | ✓ Covered |  |
| FR-JW-09/10 | 9.3, 9.4 | ◐ Partial | "Executed with documents" — no story/AC executes the elected offcut disposition (return challan, retain-and-buy billing, free-retention record); Story 9.4 stops at capturing the election |
| FR-JW-11 | 9.4 | ✓ Covered |  |
| FR-JW-12 | 9.4 | ✓ Covered |  |
| FR-JW-13 | 9.5, 9.3, 2.6 | ◐ Partial | "Reconciliation on the next custody statement" — no story/AC feeds physical-verification results into the following custody statement |
| FR-JW-14 | 9.5 | ◐ Partial | "With escalation" — no story/AC escalates unactioned aging/statutory-window alerts (Epic 9 narrative only) |
| FR-JW-15 | 9.5 | ✓ Covered |  |
| FR-AC-11 | 9.5 | ◐ Partial | "Deemed-supply on breach" — Story 9.5 only alerts BEFORE expiry; no story/AC handles the actual breach event once a return clock expires |
| **FR-RD family — primary Epic 10** | | | |
| FR-RD-01 | 10.1 | ✓ Covered |  |
| FR-RD-02 | 10.1 | ✓ Covered |  |
| FR-RD-03 | 10.1 | ✓ Covered |  |
| FR-RD-04 | 10.2 | ✓ Covered |  |
| FR-RD-05 | 10.2 | ✓ Covered |  |
| FR-RD-06 | 10.2 | ✓ Covered |  |
| FR-RD-07 | 10.3, 10.2, 10.5 | ✓ Covered |  |
| FR-RD-08 | 10.3 | ✓ Covered |  |
| FR-RD-09 | 10.3, 8.6 | ◐ Partial | "Sales orders and dispatch blocked" — no AC exercises blocking of a sales order or dispatch document for a serialized prototype |
| FR-RD-10 | 10.3 | ✓ Covered |  |
| FR-RD-11 | 10.3 | ◐ Partial | "Scrap lines route to FR-SC" — no AC routes teardown scrap lines to the scrap module (Epic 16, Phase 2, no stories) |
| FR-RD-12 | 10.3 | ✓ Covered |  |
| FR-RD-13 | 10.4 | ◐ Partial | "Every booking, sale, and job card references exactly one" member/walk-in record — the mandatory single-reference integrity constraint has no story/AC coverage |
| FR-RD-14 | 10.4, 7.2 | ✓ Covered |  |
| FR-RD-15 | 10.4, 10.5 | ✓ Covered |  |
| FR-RD-16 | 10.4 | ◐ Partial | Job-card contents and member statements (on demand and monthly) appear in no story AC |
| FR-RD-17 | 10.4, 2.7 | ✓ Covered |  |
| FR-RD-18 | 10.5 | ✓ Covered |  |
| FR-RD-19 | 10.5 | ✓ Covered |  |
| FR-RD-20 | 10.4 | ✓ Covered |  |
| FR-AC-02/03 | 10.2 | ◐ Partial | "No retroactive reinstatement" — no story/AC anywhere prohibits retroactive capitalization of previously expensed research-phase costs |
| FR-AC-04 | 10.5, 10.3 | ✓ Covered |  |
| FR-AC-12 | 10.5 | ✓ Covered (see fidelity note: "never miscellaneous income" not enforced) |  |
| FR-AC-16 | 10.5 | ✓ Covered |  |
| **FR-AC spine — primary Epics 1, 11** | | | |
| FR-AC-01 | 1.5, 1.9, 10.1 | ◐ Partial | "Cost centre... where applicable" — no story AC requires cost-centre tagging on inventory movements (only business_stream enforced); project-code enforcement exists only for R&D |
| FR-AC-13 | 1.3, 1.9 | ◐ Partial | "Retained per books-retention" — no story AC covers edit-log retention (retention policy exists only in a non-story preamble bullet) |
| FR-DOA-01 | 1.4, 1.9, 3.1, 3.4, 5.5 | ✓ Covered (see fidelity note: "config never overrides" not asserted) |  |
| FR-AC-07/08 | 11.1 | ✓ Covered |  |
| FR-AC-10 | 11.2 | ✓ Covered |  |
| FR-AC-14 | 11.2 | ✓ Covered |  |
| FR-AC-15 | 11.4 | ✓ Covered |  |
| FR-BC-01/02 | 11.3 | ✓ Covered |  |
| **FR-R family — primary Epic 12** | | | |
| FR-R-01 | 12.2 | ✓ Covered |  |
| FR-R-02 | 12.1 | ✓ Covered |  |
| FR-R-03 | 12.3 | ✓ Covered |  |
| FR-R-04 | 12.3 | ✓ Covered |  |
| FR-R-05 | 12.3 | ✓ Covered |  |
| FR-R-06 | 12.1 | ✓ Covered |  |
| FR-R-07 | 12.4 | ✓ Covered |  |
| FR-R-08 | 12.4 | ✓ Covered |  |
| **FR-DM family — primary Epic 13** | | | |
| FR-DM-01 | 13.1, 13.2, 13.3 | ◐ Partial | No story/AC migrates the asset register (cost, accumulated depreciation, remaining Schedule II life — Epic 13 goal prose only), and open sales orders are absent from Story 13.2's document list |
| FR-DM-02 | 13.2 | ✓ Covered |  |
| FR-DM-03 | 13.3 | ✓ Covered |  |

### Phase-2 Coverage (epic level only, by design)

All 113 Phase-2 FR IDs map to Epics 14-20; stories are deliberately not yet created. The scope-adequacy audit of the epic goal statements found:

| Epic | Families | Goal adequate? | Scope omissions in goal text |
|---|---|---|---|
| 14 Tender Management | FR-T-01..07 | ✅ Yes | None — all seven tender elements visible |
| 15 Order/Demand/Logistics | FR-O, FR-D, FR-L | ❌ No | Order validation (completeness/credit/availability), status tracking with attribution, RMA returns, drop shipping; SKU-location grain, seasonality/trend, promotional overlay, collaborative forecasting w/ accuracy tracking, NPI by analogy, redistribution |
| 16 Scrap/Disposal | FR-SC-01..22, FR-AC-09 | ❌ No | Defective disposition workflow w/ committee escalation + cannibalization (FR-SC-06/07), IP defacement (SC-08), NRV fields (SC-09), three-different-users rule (SC-10), segregated class bins (SC-03) |
| 17 Fixed Assets/Intangibles | FR-FA-01..20 | ❌ No | CWIP Schedule III ageing, Ind AS 16 available-for-use trigger, dual tax views (FA-07), transfers w/ GST docs (FA-08), repair-vs-capitalize queue (FA-09/10), impairment (FA-11) |
| 18 Imports | FR-IM-01..09 | ❌ No | Dual exchange rates on import POs, late-cost true-up with PPV fallback, recoverable-taxes-out-of-item-cost valuation rule |
| 19 Tooling | FR-TL-01..17 | ❌ No | PPE issue register w/ renewal cycles, offline crib transactions w/ conflict escalation, hub member lending block policy, perishable tooling min-max, life history surviving regrinds, limit-driven condemnation proposal, availability broadcast, where-used |
| 20 Gate Passes | FR-GP-01..14 | ❌ No | "Per GSTIN and site" serial qualifier, Rule 55 challans + e-way triggers (GP-04), return receipts/partial returns/substitution updating asset registers (GP-05/06/07), NRGP reason restriction w/ DOA (GP-08), 7/15/30-day ageing (GP-09), off-site visibility report (GP-12) |

### Missing Requirements (triaged)

No FR is entirely missing. The 43 partial gaps triage as follows:

#### Critical — statutory/audit exposure; must be fixed in stories before implementation

1. **FR-AC-02/03 — "no retroactive reinstatement"** (Epic 10). The Ind AS 38 prohibition that motivates the whole R&D costing capability (BO-9, BO-11) has no enforcing AC anywhere. Recommendation: add an AC to Story 10.2 blocking retroactive capitalization of expensed research costs.
2. **FR-AC-11 — deemed-supply on breach** (Epic 9). Story 9.5 alerts before the s.143 clock expires but nothing handles the actual breach (deemed-supply treatment, ITC-04 impact). SM-34 (100% returns within windows) depends on the full loop. Recommendation: extend Story 9.5 with a breach-event AC.
3. **FR-AC-01 — cost-centre tagging** (Epic 1 spine). Story 1.5 enforces `business_stream` only; the FR requires business stream + cost centre + project code where applicable. A spine gap propagates to every module built on it. Recommendation: extend Story 1.5 ACs.
4. **FR-AC-13 — edit-log retention per books-retention** (Epic 1 spine). Retention exists as an architecture note, not an AC. Statutory (s.128(5), 8 FY). Recommendation: add retention AC to Story 1.3.
5. **FR-Q-07 — BIS STI retention floor** (Epic 8). Story 8.4 fixes "7 years" flat; BIS-covered products could be configured below the statutory floor. Recommendation: AC enforcing per-product retention ≥ BIS STI.
6. **FR-P-09 — MSME classification-tagged ageing fed to ERP** (Epic 4). No micro/small/medium classification tag and no ERP feed — the s.43B(h) disallowance computation happens in ERP and needs this feed; SM-41 depends. Recommendation: extend Story 4.6.
7. **FR-DM-01 — asset-register migration and open sales orders** (Epic 13). Neither appears in any migration story AC; SM-48 sign-off would pass without them. Recommendation: extend Stories 13.1/13.2 document lists.

#### High — enforcement invariants the PRD states as blocking behavior

8. **FR-MO-12** — closed-order immutability not enforced (Epic 6).
9. **FR-MO-02** — cancellation state/reversal constraints absent (Epic 6).
10. **FR-RD-09** — prototype sales-order/dispatch blocking never exercised (Epic 10).
11. **FR-RD-13** — mandatory single member-reference integrity constraint absent (Epic 10).
12. **FR-B-03** — non-overlapping revision effectivity not enforced (Epic 5).
13. **FR-JW-09/10** — offcut election captured but never executed with documents (Epic 9) — GST document exposure on retained offcuts.
14. **FR-DOA-01 fidelity** — "workflow config consumes, never overrides" the registry is not asserted by any AC (Story 1.4 bans hard-coded roles but not config-level override).
15. **FR-AC-12 fidelity** — "never miscellaneous income" prohibition not enforced (Story 10.5 separates charges but doesn't forbid the misc-income posting path).

#### Medium — scope elements with no story AC (fix or explicitly defer with a note)

FR-I-05 (specific identification, standard cost technique), FR-I-08 (disposition feed), FR-I-09 (kit assembly/disassembly transactions — disassembly wholly absent), FR-W-03 (size-based putaway), FR-W-04 (paper-directed picking), FR-W-08 (demand-signal replenishment), FR-P-01 (supplier terms), FR-P-04 (configurable requisition approval rules), FR-B-04 (ECO stock disposition), FR-B-10 (immutable as-built snapshots + deviation flags), FR-B-15 (rollup comparison; ERP valuation boundary), FR-B-16 (job-worker supply source), FR-MO-06 (return reason codes), FR-MO-09 (short-completion resolution), FR-M-03 (manual meter readings), FR-M-06 (class-level MTTR/MTBF), FR-M-10/11 (warranty override), FR-M-16 (return-to-service sign-off), FR-M-17 (sync conflict flagging), FR-M-18 (fault/cause/remedy codes at open), FR-Q-11 (BIS number on CoC), FR-Q-13 (quality metrics), FR-Q-15 (recorded inspection notice), FR-JW-13 (PV-to-custody-statement reconciliation), FR-JW-14 (alert escalation), FR-RD-16 (member statements).

#### Cross-cutting pattern — Phase-1 clauses stranded on Phase-2 modules

Five Phase-1 FR clauses depend on modules deferred to Phase 2 with no interim behavior defined: FR-I-08 → disposition (Epic 16), FR-B-08 → scrap reconciliation (Epic 16), FR-M-15 → repair-vs-capitalize queue (Epic 17), FR-RD-11 → teardown scrap routing (Epic 16), FR-W-06 → logistics documents (Epic 15). More broadly: **Phase-1 epics generate scrap** (process scrap in Story 6.3, QC scrap outcomes in Story 8.3, teardown lines in Story 10.3) **while the entire scrap module is Phase 2** — what happens to scrap physically and in the ledger during Phase 1 is undefined anywhere. This needs an explicit interim-handling decision (e.g., a minimal scrap-intake holding state in Phase 1) or a documented deferral.

### Reverse Traceability and Fidelity Findings

- **Orphan IDs: none.** Every genuine FR ID referenced in the epics belongs to a valid PRD family and is within range (six apparent hits were regex substrings of NFR IDs, all false positives).
- **FR inventory restatement fidelity:** the epics restate all FR texts with some compression. 26 dropped clauses were found; 6 are restored in story ACs (FR-RD-03 project-code block, FR-AC-15 10% test, FR-AC-16 funding-source flow, FR-P-09 due-date computation, FR-Q-06 rework re-entry, FR-BC-01/02 no-local-masters + warn-or-block) and 4 are editorial/citation drops with no behavioral force. The remaining behavioral drops that are restored nowhere: FR-Q-07 BIS STI floor, FR-AC-02/03 retroactive-reinstatement ban, FR-AC-12 misc-income ban, FR-DOA-01 override ban (all counted in the triage above), plus Phase-2 drops that must be restored before Phase-2 story creation — FR-SC-21 internal-audit read-only access, FR-SC-14/15/16 tolerance-blocked gates, FR-IM dual exchange rates / valuation rule / PPV fallback, FR-FA available-for-use trigger + 5% residual cap + intangibles review scope, FR-TL multiple clauses, FR-O/D validation-credit-attribution-grain clauses, FR-GP-05/06/07 substitution-updates-asset-registers.
- **Recommendation:** when creating Phase-2 stories, generate them from the PRD/annex FR text, not from the epics' compressed inventory lines or the under-scoped epic goals.

## UX Alignment Assessment

### UX Document Status

**Not found.** No UX design document exists anywhere in the project (searched `*ux*`, `*design*`, `*wireframe*`, `*mockup*`, `*figma*` patterns; all hits were skill-infrastructure files, not project artifacts). The epics document itself acknowledges this at its "UX Design Requirements" section: *"No UX design contract documents were found... The PRD provides four fully-worked user journeys... These serve as the UX input for frontline stories."*

### Is UX Implied? — Emphatically Yes

This is a heavily user-facing platform. The PRD demands:

- **Frontline moment-of-use ergonomics as a core bet:** scan-first, glove-friendly, one-handed, offline-first capture (NFR-U-04/05/06); the adoption thesis (NFR-ADOPT-01, SM-17: confirmation below 95% is *a system defect*) makes frontline UX quality a stated success condition, not a nicety.
- **Four fully-worked UI journeys with hard time targets:** UJ-GATE-01 (2am offline gate logging; SM-13 median dwell ≤4 min), UJ-WEIGH-01, UJ-PUT-01 (glove-friendly override flow), UJ-IND-01 (phone indent in <90s with push-notified decisions) — plus 29 scored story stubs held as backlog.
- **Accessibility and internationalization:** WCAG 2.1 AA, i18n, multi-currency (NFR-U-02/03).
- **Role-scoped surfaces for ~36 roles:** operational dashboards per role (FR-R-02), mobile approvals with inline budget, supplier bid portal (FR-T-03), auction buyer views (FR-SC-11..13), statutory auditor read-only access.

### Alignment Findings (PRD ↔ Epics ↔ Architecture, in lieu of a UX document)

What holds together well:

- **All four PRD journeys are realized as specific stories** with acceptance criteria: UJ-GATE-01 → Story 3.2, UJ-WEIGH-01 → Story 3.3, UJ-PUT-01 → Story 3.5, UJ-IND-01 → Story 4.3 (push-notification decision AC verified present).
- **The architecture directly supports the hardest UX requirement** — offline-first frontline capture: AD-1 partitioned local-first paradigm, edge PWA + local SQLite + PowerSync, visible degraded state ("captured, pending sync"), idempotent replay (AD-16). The offline UX need and the architecture paradigm are the same decision — strong alignment.
- **Error-to-UI contract exists:** uniform error envelope with stable `error_code` strings that the "frontend maps to localized messages" — a workable seam for i18n at the message layer.

Misalignments and gaps:

1. **WCAG 2.1 AA appears in zero stories and zero architecture decisions.** It exists only as a restated NFR line in the epics. No story AC tests accessibility; no architecture convention (component library, testing gate) carries it. For a platform whose UI spans rugged-tablet frontline flows and desktop dashboards, accessibility retrofit is expensive.
2. **i18n/multi-currency has no design-level landing point** beyond the error-envelope note. No story establishes locale infrastructure, and the framework decision (Next.js vs TanStack Start) that i18n tooling depends on is deferred.
3. **Push/notification infrastructure is a story-level requirement with no architectural home.** Story 4.3 ACs require push notifications; FR-M-04 requires fault alerts reaching a supervisor "within 5 minutes"; FR-GP-09/10 and FR-JW-14 require escalating alerts. The architecture spine's layer map and structural seed contain no notification/alerting component — each module would invent its own.
4. **The access matrix covers 7 of ~36 roles (PRD OQ7)** — the PRD itself names this a hard prerequisite for UX and RBAC design. The owner is assigned (Super Admin as security lead, due before Phase 1 detailed design) but the matrix does not exist yet. Role-scoped dashboards and frontline role UIs cannot be designed cleanly without it.
5. **No UX design contract for the 29 backlog story stubs** — the addendum's scoring rule (Pain/Frequency/Data-Integrity-Risk, 45+ or DI=5 promotes a stub) and story template (G/W/T with a mandatory offline criterion) exist, but nothing downstream owns executing that machinery.

### Warnings

- ⚠️ **WARNING — UX document missing while UX is a stated success condition.** Interim mitigation exists (four journeys + addendum machinery + NFR-U are embedded in the epics), so frontline story implementation can start, but a UX design contract (screen flows, component standards, accessibility approach, offline-state patterns) should be produced before or alongside the first frontend stories — the framework decision gate ("before first frontend story") is the natural deadline.
- ⚠️ **WARNING — Accessibility (WCAG 2.1 AA) and i18n have no implementation path.** Add either a foundation story in Epic 1 (UI shell standards) or explicit ACs to the first UI stories per module.
- ⚠️ **WARNING — Notification service is architecturally homeless** despite at least four FR families depending on alerts/notifications.
- ⚠️ **WARNING — Access matrix (OQ7) remains unproduced**; it gates RBAC design (Story 1.2) and every role-scoped dashboard story (Epic 12).

## Epic Quality Review

**Method.** A 27-agent parallel review against create-epics-and-stories standards: one quality reviewer per Phase-1 epic (all 63 stories read in full — user story, ACs, dev notes), one structural reviewer for epic-level independence/greenfield/sizing patterns, and one adversarial verifier per epic that attempted to refute every critical/major finding before it entered this report. Findings below are post-verification (refuted findings removed, over-severe ones downgraded).

### Severity Tally (post-verification)

| Severity | Count |
|---|---|
| 🔴 Critical | 11 |
| 🟠 Major | 78 |
| 🟡 Minor | 76 |

### Best-Practices Checklist by Epic

| Epic | User value | Independence | Sizing | No fwd deps | DB timing | AC quality | Traceability |
|---|---|---|---|---|---|---|---|
| 1 Platform Foundation | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| 2 Core Inventory | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| 3 Warehouse Ops | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| 4 Procurement | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| 5 BOM & ECO | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 6 Production Orders | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 7 Maintenance | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 8 Quality Control | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| 9 Job-Work | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| 10 R&D / Maker-Hub | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| 11 Financial Compliance | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| 12 Reporting | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| 13 Data Migration Gate | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |

Notable positives: every epic articulates user value in its goal (no naked technical-milestone epics — Epic 1 is platform-shaped but justified by the confirmed spine-first mandate and still names its beneficiaries); database/entity timing follows the event-sourced pattern correctly (single `domain_events` table in Story 1.1, projections introduced per module story); ACs are consistently Given/When/Then with stable error codes; stories carry FR tags.

### 🔴 Critical Violations (11)

**C1. Epic 3 ↔ Epic 4 circular dependency on PO data (Stories 3.2, 3.3, 3.4).** The entire inbound capture chain validates against PO/PO-line data first created in Epic 4 Story 4.4, while the declared direction is E4 ← E3. Evidence: "the event auto-reconciles to PO-2026-0441" (3.2), "the configured tolerance for the PO line" (3.3), "receiving flow opens for PO-2026-0441... ITEM_PO_MISMATCH" (3.4). *Fix:* add an early minimal open-PO reference projection (ERP-synced or seeded) that E3 binds against, or re-sequence PO creation ahead of E3 and correct the dependency map.

**C2. Story 3.6 — pick tasks triggered by "a dispatch order" that nothing in Phase 1 creates.** Order capture (FR-O) is Epic 15, Phase 2, no stories. Stories 3.6/3.7 cannot be exercised end-to-end in Phase 1. *Fix:* define the Phase-1 outbound-demand source (minimal ERP sales-order-inbound projection, or internal issue/transfer requests) and reword the ACs.

**C3. Story 3.9 — cross-docking ACs depend on "an open outbound order line" (Epic 15, Phase 2).** Only the replenishment half (FR-W-08) is self-contained. *Fix:* split the story; move cross-docking behind whatever outbound entity Phase 1 defines, or defer FR-W-09 to Phase 2 and correct the coverage map.

**C4. Story 4.2 sequenced before its data sources exist.** Supplier scorecards consume goods receipts, POs, and invoice matches — all delivered in 4.4/4.5, which come after 4.2. *Fix:* resequence 4.2 after 4.5, or split master-data metrics from transactional metrics.

**C5. Story 5.2 requires later stories 5.3 and 5.5.** The release-gate AC needs "an approved ECO" (built in 5.3, cited by number in the AC) and "cost rollup complete" (built in 5.5). The happy path can never pass when 5.2 completes. *Fix:* reorder ECO workflow ahead of the lifecycle gate, or stage the gate conditions across 5.3/5.5.

**C6. Story 6.4 closure gate requires QC dispositions (Epic 8) — undeclared and pilot-inconsistent.** "Closure succeeds only when... every output lot has a QC disposition," but E6's dependency list omits E8. *Fix:* declare E8 as a dependency and sequence accordingly (the pilot slice already builds E8 without E6), or define a disposition-status interface owned by E6.

**C7. Story 12.2 — two of five mandated executive KPIs (fill rate, forecast accuracy) source from Phase-2 Epic 15.** *Fix:* rescope AC1 to the three Phase-1-computable KPIs with an explicit Phase-2 extension AC, or define documented Phase-1 proxies.

**C8. Story 12.3 — fulfillment report suite (FR-R-05) requires the Epic 15 order module.** One-third of the story is unimplementable in Phase 1. *Fix:* move the fulfillment suite to Epic 15 or mark FR-R-05 Phase-2 in the header and coverage map.

**C9. Story 12.4 is epic-sized.** Drag-and-drop ad-hoc builder over all projections + three export formats + scheduling/distribution engine + sharing semantics is a self-service BI product (3-5 stories), with the build-vs-embed decision unrecorded. *Fix:* split into builder+export, scheduling+distribution, sharing/permissions; record the build-vs-embed decision.

**C10. Story 13.2 migrates "open gate passes" into a module that doesn't exist in Phase 1** (gate passes = Epic 20, Phase 2, no stories). The AC is unimplementable. *Fix:* rescope 13.2 to Phase-1 domains; move gate-pass migration to Epic 20.

**C11. (Structural) Epic 13's goal and FR-DM-01 also require migrating the asset register with depreciation (Epic 17) and open sales orders (Epic 15)** — Phase-2 targets with no Phase-1 home. A Phase-1 go-live gate cannot be completed as scoped. *Fix:* rescope Epic 13 to Phase-1 domains (stock, BOMs, POs, challans, custody registers) and attach domain-specific migration stories to Epics 15/17/20. Note this interacts with the coverage finding on FR-DM-01 — the resolution must keep SM-48's zero-variance guarantee intact for whatever IS migrated at pilot.

### 🟠 Major Issues (78) — dominant patterns with representative examples

**Pattern A — Forward/undeclared dependencies (≈20 findings).** Beyond the criticals: Story 1.7's calibration lockout presupposes an instrument-status projection and update path no Epic 1 story creates (FR-M-13 ownership is split with Epic 7 without a declared split); Story 1.4's DOA ACs test against "a PO of value 600,000" with no module-free synthetic trigger defined despite Story 1.9 requiring spine tests to pass "with zero module code"; Story 2.1 AC3 requires putaway tasks (Epic 3); Stories 2.2–2.4 presuppose a GRN/receipt posting capability no Epic 2 story delivers; Story 5.5's explosion AC requires a released production order (Epic 6, pilot-skipped); Story 7.2's meter feed depends on hub bookings (Epic 10 Story 10.4, pilot-skipped); Story 8.6's prototype AC depends on Story 10.3; Story 8.3 AC4 names "integration with Story 6.3" while E6 is not among E8's dependencies and is pilot-skipped; Story 11.1 AC2 (ITC reversal blocks disposal) requires the Phase-2 disposal workflow; Story 4.4's PO issuance requires an ERP handoff channel no Phase-1 story builds.

**Pattern B — Missing error/negative paths on enforcement-type FRs (≈18).** Story 2.5 transfers have no rejection ACs (ship-before-approval, over-ship, mismatched lot); Story 4.6 MSME has no breach behavior or invalid-Udyam path; Story 5.3 ECO has no rejection paths (non-Approved implementation, unauthorized approver); Story 6.2 is 100% happy path (insufficient backflush stock, over-return, missing reason codes); Story 7.4 warranty override path absent; Story 9.3 never blocks consumption exceeding custody balance or off-kit items; Story 10.4 offline POS has no failure ACs (insufficient stock, sync conflict, payment timeout); Story 13.1 import has no malformed-row/duplicate handling; Story 13.3's gate never tests the SM-48-violated case (non-zero variance with sign-offs recorded).

**Pattern C — Systematic FR mis-citation, mostly off-by-one (5 epics).** Stories 6.2–6.3 (seven ACs cite the FR one number high), Story 5.5 (alternates/explosion/rollup cited as wrong FR-B numbers), Stories 7.4/7.6, Stories 10.2/10.4/10.5, and Epic 11 header + Story 11.2 (FR-AC-10/FR-AC-14 transposed). Dev agents implementing from these citations will trace to the wrong requirements. *Fix:* one editing pass re-keying AC citations against the canonical FR list.

**Pattern D — Grab-bag / oversized stories (≈10).** Story 5.5 (six FRs, different personas), Story 7.4 (spares + AMC + warranty + insurance), Story 7.6 (six unrelated capabilities across five FRs), Story 8.6 (five heterogeneous FRs including a KPI dashboard), Story 9.4 (five capabilities from confirmation to invoicing), Story 10.4 (CRM + booking + offline POS + payment integration), Story 12.1 (seven dashboards + rule engine), Story 12.4 (see C9). Epic 10 overall runs 25 FRs across 5 stories.

**Pattern E — Vague/untestable ACs (≈15).** Story 2.7's safety stock names no formula or expected output; Story 12.1's "role-specific dashboard is shown" has no per-role content; Story 12.2's KPIs lack computation definitions; Story 7.6's "technician workflows function offline" names no workflows or observable outcomes; Story 9.4's ERP billing feed has no interface/acknowledgment/failure semantics; Story 9.5's deemed-supply "breach window" is undefined; Story 11.1's GSTR-2B reconciliation names no matching keys or tolerances.

**Pattern F — Missing capabilities consumed as if they exist (≈8).** Supplier invoice capture/ingestion (consumed by 4.2/4.5/4.6, delivered nowhere); ASN creation (3.4 promises receiving "against ASN or PO," no story creates ASNs); BIS licence records and Legal Metrology label masters (8.6's blocking ACs have no master-data creation stories); CI/CD pipeline construction (1.1 presupposes "the IaC deployment pipeline runs," 1.9 presupposes CI + branch protection — no story builds the pipeline); a Phase-1 customer master for 3.7's commercial invoices.

**Other notable majors:** Story 1.2 promises RBAC to module/function/location but tests only location denial; Story 2.5's AC1 and AC2 contradict each other on when stock becomes `in_transit`; Story 2.3 promises serial traceability but all ACs are lot-only; Story 11.2 uses semantically wrong error code `GATE_PASS_REQUIRED` for missing GST documents; Story 11.4 ignores the offline-event-syncing-into-closed-period case (the architecture's hardest period-lock case) and never gates close on recorded sign-off; Story 4.5's GRN creation overlaps Story 3.4 with no stated boundary.

**Structural / pilot-slice coherence (from the structural review):**
- The pilot slice (E1,2,3,5,7,8,9+13) **contradicts Epic 13's own declaration** ("Depends on: All Epics 1-12").
- **Statutory exposure at pilot:** the slice excludes Epic 11, so FR-AC-14 IRN-before-dispatch enforcement is absent while Story 3.7 produces dispatch documents and Epic 9 dispatches job-work output at a live site — any e-invoiceable supply at the pilot would dispatch without the IRN block the PRD mandates.
- Story 13.2 migrates custody/loan registers whose owning module (E10) is pilot-skipped.
- Story 7.4's spares mechanics and "where-used from equipment BOMs" reference entities no pilot-slice story creates.

### 🟡 Minor Concerns (76)

Distributed across all epics (3-8 each): citation-precision issues, peripheral AC-wording defects (e.g., Story 1.5 asserting "stock balance is unchanged" before any stock ledger exists — testable intent, imprecise observable), missing doc cross-references, offline-behavior notes absent from individual dashboards, and formatting inconsistencies. These do not block readiness individually; the AC-wording subset should be cleaned up during the same editing pass as Pattern C.

### Remediation Priority

1. Resolve the four dependency knots: E3↔E4 PO data (C1), E6→E8 dispositions (C6), E5 internal ordering (C5), E13 phase-boundary scope (C10/C11) — these change sequencing, so fix before sprint planning.
2. Decide the Phase-1 outbound-demand model (C2/C3/C7/C8 all hinge on it).
3. Rescope the pilot slice or add the IRN-enforcement story to it (statutory exposure).
4. One editing pass: fix off-by-one FR citations (Pattern C), add missing-capability stories (Pattern F: invoice capture, ASN, BIS/label masters, CI/CD pipeline), split the grab-bag stories (Pattern D).
5. AC hardening pass on enforcement FRs: add negative paths (Pattern B) — aligns with the coverage audit's partial-gap list, which overlaps heavily.

## Summary and Recommendations

**Assessor:** Implementation Readiness workflow (bmad-check-implementation-readiness), executed 2026-07-11 with multi-agent parallel validation: 52 subagents across two adversarially-verified workflows (25 for FR coverage, 27 for epic quality), plus direct document analysis. Every critical/major finding survived an independent refutation attempt before entering this report.

### Overall Readiness Status

## ⚠️ NEEDS WORK

The planning chain is structurally excellent and materially incomplete in specific, fixable ways. What is strong: complete FR traceability (269/269 FRs mapped, zero orphans, zero entirely-missing Phase-1 requirements), an architecture whose central paradigm (partitioned local-first) is precisely the PRD's hardest requirement, all four PRD journeys realized as stories, disciplined event-sourced patterns, and consistent G/W/T acceptance criteria with stable error codes. What blocks a green light: 11 critical sequencing/scope violations in the epics (circular and cross-phase dependencies that make stories unimplementable as ordered), 7 critical statutory coverage gaps (clauses of Ind AS 38, GST s.143, s.43B(h), BIS, and migration requirements with no enforcing AC), a pilot slice with a statutory hole (dispatch without IRN enforcement), and a missing UX layer for a product whose success metric is frontline adoption.

**Do not start implementation** (sprint planning / story development) until at minimum the Critical list below is resolved. The fixes are edits to `epics.md` and two decisions — roughly days of planning work, not a re-plan.

### Critical Issues Requiring Immediate Action

1. **Four dependency knots make core stories unimplementable as sequenced** — E3↔E4 (inbound capture needs PO data created later), E6→E8 (closure gate needs QC dispositions, undeclared), Story 5.2→5.3/5.5 (release gate needs ECO + rollup built later), E13→Phase-2 (migration gate requires gate-pass/depreciation/sales-order targets that don't exist in Phase 1). Fix ordering/scope before any sprint plan.
2. **Phase-1 outbound-demand model is undefined** — pick tasks, cross-docking, dispatch documents, fill-rate KPIs all reference "orders" owned by Phase-2 Epic 15. One decision (minimal ERP sales-order-inbound projection vs. internal issue requests) unblocks C2, C3, C7, C8.
3. **Pilot-slice statutory exposure** — the pilot dispatches job-work output (Epic 9) and produces dispatch documents (Story 3.7) without Epic 11's IRN-before-dispatch enforcement (FR-AC-14) in the slice. Either add Story 11.2 to the pilot or document why no pilot supply is e-invoiceable.
4. **Seven statutory clauses have no enforcing AC:** Ind AS 38 no-retroactive-reinstatement (FR-AC-02/03), s.143 deemed-supply on breach (FR-AC-11), cost-centre tagging in the spine (FR-AC-01), edit-log retention (FR-AC-13), BIS STI retention floor (FR-Q-07), MSME classification-tagged ageing to ERP (FR-P-09), asset-register + open-sales-order migration (FR-DM-01).
5. **PRD annex-of-record pointer is dead** — `PLANNING/SCM-Requirements-Document/` was deleted (commit 2375fff); the content lives at `PLANNING/archive/SCM-Requirements-Document.md`. Every downstream workflow that follows the PRD's precedence rule will fail. One-line PRD fix plus a declared-precedence note for the duplicate PRD copies (`prds/.../archive/prd.md` vs `PLANNING/prd/`).
6. **Access matrix covers 7 of ~36 roles** (PRD OQ7) — hard prerequisite for RBAC (Story 1.2) and every role-scoped surface; owner assigned, artifact not produced.

### Recommended Next Steps

1. **Resequencing pass on `epics.md` (owner: PM + architect, ~1-2 days):** resolve the four dependency knots (C1, C5, C6, C10/C11); decide the Phase-1 outbound-demand model; correct the pilot slice (IRN story or documented exclusion; reconcile Epic 13's "depends on all" with its pilot membership).
2. **Story-editing pass on `epics.md` (owner: PM, ~2-3 days):** add the 7 statutory ACs; add negative-path ACs to enforcement stories (transfers, ECO, MSME breach, custody consumption, offline POS, migration imports); fix the off-by-one FR citations in Epics 5, 6, 7, 10, 11; split the eight grab-bag stories (5.5, 7.4, 7.6, 8.6, 9.4, 10.4, 12.1, 12.4); add missing-capability stories (supplier invoice capture, ASN source, BIS licence + label master data, CI/CD pipeline construction, notification-service foundation).
3. **Document hygiene (owner: PM, ~1 hour):** fix the PRD §0 annex path; declare which PRD copy is authoritative; commit the modified `epics.md`.
4. **Produce the access matrix (owner: Super Admin as security lead, before Phase-1 detailed design)** — already assigned via PRD OQ7; treat as a gating deliverable, not background work.
5. **Create a UX design contract before the first frontend story** (screen flows for the four journeys, offline-state patterns, WCAG 2.1 AA approach, component standards) — the framework decision gate ("before first frontend story") is the natural deadline; consider running the UX workflow against the four PRD journeys plus the 29 scored stubs.
6. **Before Phase-2 story creation:** regenerate Epic 15-20 scope statements from the PRD/annex FR text (6 of 7 goals under-state scope; 20 dropped behavioral clauses are restored nowhere).
7. **Close the open business decisions** the PRD flags as gating: Phase 1/2 boundary sign-off (OQ9), budget envelope + build sourcing (OQ10), counter-metric confirmation (SM-C1..C3), unified retention table (OQ4), per-feed "real-time" definitions (OQ5), DPDP compliance date (OQ6).

### Final Note

This assessment identified **223 discrete findings across five categories**: document hygiene (3), PRD completeness risks (7), FR coverage gaps (43 partial, 0 missing, plus 26 restatement fidelity drops), UX alignment warnings (4), and epic/story quality violations (11 critical, 78 major, 76 minor — post-adversarial-verification). The categories overlap deliberately: the same statutory clauses recur as coverage gaps, dropped clauses, and missing ACs, which is itself the signal — the epics compressed the PRD faithfully at the structural level but shed enforcement detail at the AC level.

Address the Critical list before proceeding to implementation. These findings can be used to improve the artifacts, or you may choose to proceed as-is accepting the documented risks — but items 3 (statutory dispatch exposure at pilot) and 4 (statutory ACs) are compliance-by-construction promises the PRD makes to auditors, and shipping without them contradicts the product's central thesis.
