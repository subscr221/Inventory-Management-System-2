# 4. Features

Each feature groups the source modules it absorbs, with FRs nested under it by their stable source IDs. Descriptions are behavioral; full per-FR consequence detail is in the referenced source sections.

## 4.1 Core Inventory (source §3.1)

**Description:** The transactional foundation. Real-time stock balances per SKU per location with on-hand, allocated, available, and in-transit states; lot and serial traceability end to end; valuation compliant with Ind AS 2. Every other feature posts through or reads from this ledger.

**Functional Requirements:**

- **FR-I-01** Multi-location stock tracking with real-time per-location and consolidated views.
- **FR-I-02** Inter-location transfer requests, approvals, pick/ship/receive with lot and serial traceability.
- **FR-I-03** Reorder points and automated replenishment recommendations or auto-requisitions per SKU per location.
- **FR-I-04** Lot, batch, and serial tracking for traceability, FEFO/FIFO expiry management, and recall readiness.
- **FR-I-05** Valuation by FIFO and weighted average; specific identification where required; standard cost only as an Ind AS 2 para 21 measurement technique. LIFO is not offered.
- **FR-I-06** Cycle counting and physical inventory with variance workflows and approval-gated adjustments.
- **FR-I-07** Safety stock computed from lead-time and demand variability against target service levels.
- **FR-I-08** Aging and obsolescence flagging feeding disposition and NRV testing.
- **FR-I-09** Kit assembly/disassembly transactions, executing only against Released BOMs (superseded as definition record by FR-B-02).
- **FR-I-10** Consignment and VMI stock segregated from owned inventory.

## 4.2 Warehouse Operations (source §3.5)

**Description:** Physical execution inside each site: topology modeling, receiving against ASNs and POs, directed putaway, optimized picking, packing, shipping, task management, forward-pick replenishment, and cross-docking. Realizes UJ-PUT-01 together with the frontline edge layer (§4.14).

**Functional Requirements:**

- **FR-W-01** Warehouse topology (sites, zones, aisles, racks, bins) with temperature, hazmat, and quarantine attributes.
- **FR-W-02** Receiving against ASN or PO with lot/serial, expiry, and QC capture; generates putaway tasks. Realizes UJ-GATE-01 and UJ-WEIGH-01 at the inbound edge.
- **FR-W-03** System-directed and user-selected putaway by velocity, size, zone rules. Realizes UJ-PUT-01.
- **FR-W-04** Picking with optimized paths; single-order, batch, wave, and zone strategies; paper and mobile-directed.
- **FR-W-05** Packing-station workflow with validation, weights, labels, packing slips, cartonization.
- **FR-W-06** Shipping documents (BOL, commercial invoice, customs docs), carrier rate shopping, load planning.
- **FR-W-07** Task generation, assignment, prioritization, and productivity tracking.
- **FR-W-08** Forward-pick replenishment from reserve storage on min/max or demand signals.
- **FR-W-09** Flow-through and distribution cross-docking.

## 4.3 Procurement, Tendering, and Supplier Management (source §3.2, §3.3)

**Description:** Source-to-pay: supplier registry and onboarding, performance scorecards, requisition-to-PO with configurable approval routing, goods receipt with QC triggers, three-way invoice matching, spend analytics, formal tender processes with a secure bid portal, and Indian MSME payment compliance. Realizes UJ-IND-01 upstream (indents become requisition lines with zero re-keying).

**Functional Requirements:**

- **FR-P-01** Centralized supplier registry (contacts, tax IDs, terms, certifications, compliance docs).
- **FR-P-02** Supplier onboarding workflow with document collection and approval routing.
- **FR-P-03** Supplier performance capture and scorecards (on-time delivery, quality acceptance, price, responsiveness).
- **FR-P-04** Purchase requisitions with configurable approval rules by amount, category, department. Realizes UJ-IND-01.
- **FR-P-05** PO management: blanket, contract, and standard POs tracked issuance through receipt and invoicing.
- **FR-P-06** Goods receipt against PO with QC inspection workflow and accept/reject/conditional outcomes.
- **FR-P-07** Three-way match (PO, receipt, invoice) with tolerances, discrepancy flags, credit/debit notes.
- **FR-P-08** Spend analytics by supplier, category, location, department, period.
- **FR-P-09** MSME compliance: Udyam capture with annual revalidation; statutory due-date stamping (earlier of agreed date and 45 days, or the 15-day appointed day); classification-tagged ageing fed to ERP for s.43B(h) and MSMED s.16 exposure.
- **FR-T-01 to FR-T-07** Tender lifecycle: authoring (RFQ/RFP/RFI) with templates, supplier invitation, secure bid portal, clarification Q&A, controlled bid opening with weighted scoring, award approval and notification, contract generation linked to POs.

## 4.4 Order Management, Demand Planning, and Logistics (source §3.4, §3.6, §3.7)

**Description:** The outbound and planning spine: multi-channel order capture through validation, intelligent routing to the optimal fulfillment location, split shipments, backorders, returns, and drop-ship; statistical forecasting with auto-selected models feeding replenishment; carrier management, shipment planning, rate shopping, tracking, and freight audit.

**Functional Requirements:**

- **FR-O-01 to FR-O-08** Order capture (manual, EDI, e-commerce, internal, inter-branch), validation (completeness, credit, availability), routing by configurable rules, split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, drop shipping.
- **FR-D-01 to FR-D-08** Historical data analysis at SKU-location grain, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, NPI forecasting by analogy, replenishment planning (with BOM explosion for dependent demand per FR-B-07), inventory optimization and redistribution.
- **FR-L-01 to FR-L-08** Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, returns logistics.

## 4.5 R&D Centre and Maker-Hub Operations (source §3.9)

**Description:** The workflows that make this platform unusual: project-coded material issues with budget checks, three issue semantics (consume, project WIP, custody loan), prototype build records and serialized non-saleable prototypes with four disposition paths, teardown recovery, member machine-time booking, offline point-of-use material sales with UPI/card payment capture, and member job cards. Operational only; all book treatment defers to FR-AC and FR-FA.

**Functional Requirements:**

- **FR-RD-01** R&D store and maker-hub store as first-class location types with their own stock ledgers.
- **FR-RD-02** R&D-designated stock flag blocking cross-issue between R&D and production without approved reclassification.
- **FR-RD-03** R&D project master (code, owner, research/development phase tag, budget, status); no material transaction posts without an active project code.
- **FR-RD-04** Requisition with committed-plus-actual budget check; breaches route to project owner and R&D head.
- **FR-RD-05** Three issue types with distinct semantics: consumable, project material (accumulates WIP), equipment custody (loan).
- **FR-RD-06** Equipment custody register with named custodian, expected return, condition codes, overdue aging.
- **FR-RD-07** Per-project WIP ledger in quantity and cost, real time, feeding FR-AC treatment.
- **FR-RD-08** Prototype build records including failed and abandoned builds with full material history.
- **FR-RD-09** Completed builds register serialized prototypes in a non-saleable class; sales orders and dispatch blocked.
- **FR-RD-10** Four prototype dispositions (retain as asset, transfer to production reference, teardown, scrap), each R&D-head approved.
- **FR-RD-11** Teardown component recovery with condition codes; scrap lines route to FR-SC.
- **FR-RD-12** Unused material returns reversing project WIP.
- **FR-RD-13** Hub member and walk-in customer records; every booking, sale, and job card references exactly one.
- **FR-RD-14** Machine-time booking with operator-closed actuals and meter readings; 24-hour unclosed-booking exceptions.
- **FR-RD-15** Offline-capable point-of-use material sale decrementing hub stock and billing the member (NFR-U-05).
- **FR-RD-16** Member job cards collecting bookings, hours, purchases; statements on demand and monthly.
- **FR-RD-17** Hub replenishment via FR-I-03 reorder control against serving warehouse or purchase.
- **FR-RD-18** Monthly hub and quarterly R&D physical verification, custodian confirmation of on-loan equipment.
- **FR-RD-19** Project material cost reporting reconciled line-for-line to the store ledger; feeds Form 3CL and IAUD.
- **FR-RD-20** Walk-in payment capture via UPI dynamic QR or card terminal with end-of-day reconciliation.

## 4.6 BOM and Engineering Change Management (source §3.10)

**Description:** The governed engineering-record layer. Production BOMs are immutable released revisions changed only through ECOs with where-used impact analysis and stock disposition; R&D BOMs iterate freely and cross into production only through a productization gate with named sign-offs. The system is record of truth for BOM structure; ERP supplies cost rates inbound and never overwrites structure.

**Functional Requirements:**

- **FR-B-01** Multi-level versioned BOMs with per-line scrap percent, UoM conversion, effectivity; explosion to any depth.
- **FR-B-02** Supersedes FR-I-09 kit definitions; existing kits migrate as single-level production BOMs at go-live.
- **FR-B-03** Revision control with non-overlapping date effectivity; released revisions immutable.
- **FR-B-04** ECO workflow (Draft, Under Review, Approved, Implemented, Cancelled) with stock disposition; only Implemented ECOs alter a Released BOM.
- **FR-B-05** Where-used and impact analysis across BOMs, open orders, POs, and stock, shown at ECO approval.
- **FR-B-06** Lifecycle states (Draft, Released, On Hold, Obsolete); release gated on released item masters, scrap percents, cost rollup, ECO approval.
- **FR-B-07** Explosion to execution at production-order release, driving directed issue or backflush; replicated per plant for offline continuity.
- **FR-B-08** Consumption variance reporting at order closure with tolerance flags; feeds FR-SC reconciliation and scrap-percent recalibration.
- **FR-B-09** R&D draft BOM regime: in-place edits, placeholders, free text; barred from production execution.
- **FR-B-10** Clone production BOMs into R&D drafts; immutable as-built snapshots per build with deviation flags.
- **FR-B-11** Productization gate checklist with engineering, procurement, and QC sign-offs.
- **FR-B-12** Approved alternates with priority and effectivity; ad-hoc substitutions require logged approval.
- **FR-B-13** Phantom assemblies passing through to components.
- **FR-B-14** Co-products and by-products with expected yields posting as distinct lots.
- **FR-B-15** Cost rollups as dated simulation snapshots with comparison; valuation stays in ERP.
- **FR-B-16** Job-work kit BOMs tagged by supply source (company, customer, job-worker) with reconciliation.
- **FR-B-17** BOM system of record with INT-ERP-01 sync; inbound conflicts create BOM Administrator exceptions, never overwrites.

## 4.7 Production Orders and Production WIP (source §3.16)

**Description:** The record of truth for every make event. Orders carry immutable numbers, effective BOM versions, business-stream tags, and source references; a release gate checks material availability; issues and backflushes move stock into an explicit production WIP ledger; completions post into QC Hold with full as-consumed lot genealogy; closure requires WIP at zero and QC dispositions on every output lot. Execution continues offline at the plant and replays on reconnection.

**Functional Requirements:**

- **FR-MO-01** Production order record with immutable number, output item/quantity, plant, BOM version, stream tag, source reference.
- **FR-MO-02** Lifecycle: Planned, Released, In Process, Completed, Closed; Cancelled only from Planned/Released with no unreversed transactions.
- **FR-MO-03** Release gate: effective Released BOM plus availability check; override by named authority flags to expediting.
- **FR-MO-04** Staging and issue: pick tasks for directed lines, allocated status until issue; backflush lines post on confirmation.
- **FR-MO-05** Production WIP ledger per order in quantity and value, distinct from R&D project WIP.
- **FR-MO-06** Returns to stock with reason codes, reversing WIP at issued cost, restoring lot identity.
- **FR-MO-07** Completions post good quantity into QC Hold as new FG lots; co/by-products post separately.
- **FR-MO-08** Process scrap declarations relieving WIP and feeding expected-vs-actual reconciliation.
- **FR-MO-09** Completion tolerances; over-completion blocked without supervisor approval; short completion resolution.
- **FR-MO-10** Rework orders generated from QC dispositions, output re-entering the QC gate as linked lots.
- **FR-MO-11** As-consumed lot genealogy per output lot; lot-controlled consumption without a recorded lot is blocked.
- **FR-MO-12** Closure requires zero WIP, no open picks, QC disposition per output lot; closed orders immutable.
- **FR-MO-13** Offline execution with replicated order data, sequenced replay, duplicate suppression; release/cancel/close central only.

## 4.8 Job-Work Services (source §3.17)

**Description:** Fabricating for customers on their material. Customer stock arrives under the customer's challan, lives in a non-valuated segregated stock class, is consumed only against that customer's job-work orders, and returns as product plus a billing feed. A custody ledger reconciles to the last lot and prints as a customer statement. Statutory return clocks count from the customer's challan date.

**Functional Requirements:**

- **FR-JW-01** Job-work service order: customer, spec reference, promised dates, price basis; links kit BOM (FR-B-16). Anchor for everything downstream.
- **FR-JW-02** Lifecycle statuses from draft to closed, every change attributed.
- **FR-JW-03** Customer material receipt only against confirmed orders through gate and receiving flows, challan captured.
- **FR-JW-04** Customer-owned non-valuated stock class, segregated, blocked from any other demand.
- **FR-JW-05** Custody ledger per customer and order with full movement categories; prints as custody statement.
- **FR-JW-06** Consumption posting against the order following customer-supplied kit lines.
- **FR-JW-07** Own-material additions billed distinctly from the service charge.
- **FR-JW-08** Process loss norms; over-norm loss requires supervisor approval before dispatch readiness.
- **FR-JW-09/10** Contractual offcut election (return, retain-and-buy, retain free) captured at confirmation and executed with documents.
- **FR-JW-11** Output passes the FG quality gate before dispatch; partial dispatches supported.
- **FR-JW-12** Measured billing feed (pieces, certified weight, or hours) handed to ERP for invoicing.
- **FR-JW-13** Customer stock in physical verification with reconciliation on the next custody statement.
- **FR-JW-14** Aging and statutory-window alerts computed from challan date with escalation.
- **FR-JW-15** No closure while the custody ledger balance is non-zero.

## 4.9 Quality Control for Finished Goods (source §3.12)

**Description:** No lot reaches sellable stock or a dispatch document without a recorded release decision. Versioned inspection plans, AQL sampling per IS 2500, result capture with calibration lockout, one recorded disposition per lot, NCR outcomes (rework, downgrade, scrap), CoA/CoC generation, recall-ready quality holds, CAPA linkage, BIS certification hooks, packaged-commodity label compliance, and customer-witnessed inspections for job-work.

**Functional Requirements:**

- **FR-Q-01** Versioned inspection plans per product-spec revision; QC Head approved; customer-spec overrides per job-work order.
- **FR-Q-02** Finished-goods QC gate: all completions post into QC Hold; no bypass, urgency uses conditional release.
- **FR-Q-03** AQL sampling per IS 2500 / ISO 2859-1 with switching rules; critical characteristics 100% inspected.
- **FR-Q-04** Result capture referencing instrument asset IDs; out-of-calibration instruments rejected (lockout from FR-M-13).
- **FR-Q-05** Exactly one recorded disposition per lot: Accept, Reject, or Conditional Release with deviation record; partial splits supported.
- **FR-Q-06** NCR outcomes per quantity: rework (re-enters the gate), downgrade to seconds, or scrap to FR-SC.
- **FR-Q-07** Batch release records and CoA/CoC per lot; retention default 7 years, never below BIS STI requirements.
- **FR-Q-08** Retention samples block release until logged; expiry alerts route to disposal.
- **FR-Q-09** Quality holds on released lots flip stock to Blocked everywhere; where-used and where-shipped trace within 15 minutes.
- **FR-Q-10** NCR defect codes and CAPA linkage; repeat NCRs (3+ same product and defect in 90 days) require CAPA.
- **FR-Q-11** BIS hooks: licence validity blocks release; CM/L or R-number printed on release records and CoC.
- **FR-Q-12** Prototype verification as design evidence; prototypes barred from sellable status.
- **FR-Q-13** Quality reporting: first-pass yield, rejection rates, NCR/CAPA aging, conditional-release counts, lockout events.
- **FR-Q-14** Packaged-commodity label compliance (Legal Metrology): version-controlled label masters; release blocked without a current approved version.
- **FR-Q-15** Customer-witnessed and third-party inspection: witness and hold points, recorded notice, dispatch blocked until hold points clear or a recorded waiver exists.

## 4.10 Maintenance, Calibration, and Tooling (source §3.11, §3.19)

**Description:** One asset register and one discipline for everything from a two-tonne mould to a hub screwdriver. PM plans (calendar and meter), fault reporting by anyone via asset-tag scan, breakdown work orders with SLAs, downtime and MTTR/MTBF analytics, spares with where-used, AMC/warranty/insurance tracking, a calibration register whose lockout no role can override, statutory examination tracking (including Legal Metrology weighbridge stamping), machine status broadcast to planning and hub booking, fully offline technician workflows, and a tool crib with custody, life counters, regrind limits, and gauge calibration lockout.

**Functional Requirements:**

- **FR-M-01** Maintainable asset register company-wide with criticality classes and scannable tags; fixed-asset link optional.
- **FR-M-02** Calendar and meter-based PM plans auto-generating work orders with grace-window tracking.
- **FR-M-03** Usage meter feeds from hub bookings and station equipment plus manual readings; monthly reconciliation; silent-meter alerts.
- **FR-M-04** Fault reporting by any user via tag scan; reaches the location's maintenance supervisor within 5 minutes.
- **FR-M-05** Breakdown work-order lifecycle with priority from criticality and safety flags; configurable SLAs.
- **FR-M-06** Downtime capture and monthly MTTR/MTBF per asset and class.
- **FR-M-07/08/09** Spares catalogued under FR-I with where-used from equipment BOMs; reservation, issue, 3-working-day returns; critical-spares min-max with same-day breach alerts.
- **FR-M-10/11** AMC, warranty, insurance records with 90/60/30-day expiry alerts; warranty check at work-order creation with reason-coded override.
- **FR-M-12** Calibration register (in-house or ISO/IEC 17025 external) with certificates and 30/14/7-day alerts.
- **FR-M-13** Out-of-calibration lockout: no role can override; escalation expedites, never bypasses.
- **FR-M-14** Statutory examination tracking (OSH Code periodicities, weighbridge 12-month stamping); overdue items lock the asset; repaired weighbridges block trade weighment until re-stamped.
- **FR-M-15** Maintenance cost accumulation per asset; repair-vs-capitalize flag routes to FR-FA above threshold.
- **FR-M-16** Machine status broadcast within 2 minutes to production planning and hub booking; return-to-service needs supervisor sign-off.
- **FR-M-17** Fully offline technician workflow with sync and conflict flagging.
- **FR-M-18** Closure codes (fault, cause, remedy) with last-five-closures history at work-order open.
- **FR-TL-01 to FR-TL-17** Tool crib: tool master with class and QR tag; where-used through FR-B; asset and cost cross-reference; scan-based custody issue and return with overdue escalation; hub member lending with block policy; perishable tooling as min-max stock; life counters auto-incremented from production confirmations; warning and hard-stop thresholds blocking issue; life history surviving regrinds; regrind/repair routing (with confidentiality reference for IP-sensitive tooling); regrind limits proposing condemnation; condemnation exits through FR-SC with defacement; gauge calibration lockout at issue; personal PPE issue register with renewal cycles; tool availability broadcast to planning and booking; offline crib transactions with conflict escalation.

## 4.11 Scrap, Defectives, and Disposal (source §3.13)

**Description:** Every scrap receipt originates from a source document and lands in a classified, segregated bin; weighment and photos evidence intake; NRV valuation and DOA-gated approvals precede disposal; sale runs the tender machinery in reverse (auction with reserve prices, EMD, payment before lifting, exit weighment at the gate); hazardous, e-waste, battery, and EPR channels enforce statutory routing; reconciliation flags pilferage.

**Functional Requirements:**

- **FR-SC-01** Source-linked intake only (production scrap, QC rejection, obsolescence, teardown, replaced parts, retired assets).
- **FR-SC-02** Single classification at intake determining bins, routes, statutory channel; reclassification audit-logged.
- **FR-SC-03** Segregated scrap-yard bins per class; restricted bins block cross-class putaway.
- **FR-SC-04** Weighment (weighbridge or calibrated scale) with photo evidence; declared-vs-weighed variance exceptions.
- **FR-SC-05** Expected-vs-actual scrap reconciliation against BOM scrap percents, feeding pilferage indicators.
- **FR-SC-06/07** Defective disposition workflow (repair, refurbish-downgrade, cannibalize, condemn) with committee escalation; cannibalized component recovery.
- **FR-SC-08** IP-sensitive lots require evidenced defacement before any sale.
- **FR-SC-09** NRV fields per lot with rate source and valuer.
- **FR-SC-10** Disposal approvals resolved through the DOA registry; proposer, approver, custodian must be three different users.
- **FR-SC-11/12** Buyer registration (GSTIN, PAN, SPCB/CPCB credentials for regulated categories) with blacklisting; lot creation with sealed reserve prices.
- **FR-SC-13** Auction via tender mechanics in reverse; below-reserve or single-bid outcomes escalate to committee.
- **FR-SC-14/15/16** EMD lifecycle; payment before lifting; slot-scheduled lifting with exit weighment, tolerance-blocked gates, and random re-weighment.
- **FR-SC-17** Sale documents with GST, TCS (s.394(1) Income-tax Act 2025), and e-way bill triggers.
- **FR-SC-18** Hazardous waste to authorized recyclers/TSDFs with Form 10 manifests and the non-disableable 90-day storage timer.
- **FR-SC-19** E-waste, battery, and non-ferrous EPR channels; awards blocked to unregistered buyers.
- **FR-SC-20** Write-off and destruction with witness and evidence; auto-triggers ITC reversal evaluation and FA derecognition.
- **FR-SC-21** Generated vs weighed vs disposed reconciliation per class per location; internal audit read-only access.
- **FR-SC-22** Plastic packaging EPR data by category, GSTIN, and financial year for CPCB portal returns.

## 4.12 Fixed Assets, Intangibles, and Depreciation (source §3.14)

**Description:** The operational asset subledger (ERP GL stays the book of record). CWIP accumulation and Schedule III ageing, component accounting, Schedule II useful lives, SLM/WDV depreciation runs with preview-and-approve, a separate report-only income-tax view, effective-dated transfers that trigger GST documents across GSTINs, repair-vs-capitalize queues fed by maintenance, impairment hooks, retirement through the disposal stream, offline physical verification by tag scan, and an intangibles register with IAUD ageing, amortization, and annual reviews.

**Functional Requirements:**

- **FR-FA-01 to FR-FA-06** Asset master with tags and parent-child components; capitalization from procurement through CWIP at Ind AS 16 available-for-use; CWIP ageing per Schedule III; component accounting; Schedule II lives and residual values (max 5%) with justified deviations; SLM/WDV depreciation runs posting to ERP after preview.
- **FR-FA-07** Dual views: Companies Act books view plus report-only income-tax block-of-assets WDV view.
- **FR-FA-08** Effective-dated transfers reallocating depreciation; inter-GSTIN moves trigger FR-AC-10 documents before dispatch.
- **FR-FA-09/10** Subsequent expenditure decisions; repair-vs-capitalize queue from FR-M work orders, none undecided at period lock.
- **FR-FA-11** Impairment indicator capture per Ind AS 36.
- **FR-FA-12** Retirement and disposal through FR-SC with gain/loss computation.
- **FR-FA-13** Offline physical verification by tag scan per CARO 2020 with reconciliation evidence.
- **FR-FA-14** Immutable asset audit trail.
- **FR-FA-15 to FR-FA-20** Intangibles: register separate from PPE; IAUD ledger fed project-wise from FR-RD-19 with Schedule III ageing; capitalization and amortization at available-for-use; annual reviews of period, method, and indefinite-life assessments; impairment extension including annual tests where required; derecognition and approval-gated IAUD write-offs.

## 4.13 Financial Compliance Spine (source §3.15, §3.18, §3.21, §3.22)

**Description:** The layer that makes every operational transaction postable and defensible: mandatory business-stream tagging, research-vs-development classification with the six Ind AS 38 criteria, permitted cost formulas, NRV testing, per-GSTIN ITC registers with write-off reversals, branch-transfer and job-work GST documents, IRN-before-dispatch, statutory edit log, period-end close with reconciliation, import landed-cost management from PO to Bill of Entry, ERP-synced budget checks at approval, and one enterprise DOA registry every approval resolves from.

**Functional Requirements:**

- **FR-AC-01** Every inventory movement carries business stream, cost centre, and project code where applicable; untagged transactions blocked.
- **FR-AC-02/03** Research-phase issues expense; development-phase capitalization only after the six-criteria checklist; no retroactive reinstatement.
- **FR-AC-04** Project-wise R&D cost ledgers producing DSIR and Form 3CL-ready statements.
- **FR-AC-05/06** Permitted cost formulas per Ind AS 2; period-end NRV testing with capped reversals.
- **FR-AC-07/08** ITC register per GSTIN traced to GRN, invoice, and IRN; ITC reversal computed on write-offs before disposal closes.
- **FR-AC-09** Scrap-sale tax events (GST classification, e-invoice, e-way bill, TCS) as dated configuration, not code.
- **FR-AC-10** Branch transfers between GSTINs as taxable supplies with Rule 28 valuation and documents before dispatch.
- **FR-AC-11** Job-work challans (Rule 45) with one-year and three-year return clocks, deemed-supply on breach, ITC-04 data.
- **FR-AC-12** Maker-hub B2C invoices at item rates, separated from machine-time service charges; never miscellaneous income.
- **FR-AC-13** Statutory edit log: tamper-proof, non-disableable, retained per books-retention, auditor-reportable.
- **FR-AC-14** Dispatch blocked for e-invoiceable supplies until IRN and signed QR received.
- **FR-AC-15** Period locks, GRNI ageing, subledger-to-GL reconciliation, CARO physical-verification evidence with the 10% test.
- **FR-AC-16** Funding-source tagging (internal, DSIR, DST, grants) on R&D projects flowing to every cost ledger entry.
- **FR-IM-01 to FR-IM-09** Imports: import-flagged POs with dual exchange rates; Bill of Entry capture by duty head; import IGST into the ITC register (BCD/SWS never creditable); landed cost sheets with selectable allocation bases; valuation posting keeping recoverable taxes out of item cost; provisional assessment lifecycle with two-year window; late cost true-up windows with PPV fallback; ICEGATE/GSTR-2B reconciliation; duty-exemption licence hooks (Advance Authorisation, EPCG).
- **FR-BC-01/02** ERP-synced budget heads and availability; inline budget-remaining at approval with configurable warn-or-block; commitments reduce availability until ERP actuals sync. No budget masters held locally.
- **FR-DOA-01** One enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolving approvers for every workflow; workflow config consumes, never overrides it.

## 4.14 Gate Passes, Returnable Materials, and Frontline Edge Capture (source §3.20, §9)

**Description:** Nothing crosses the gate without a document, and nothing frontline requires a network. RGPs and NRGPs (serially numbered per GSTIN and site) cover every non-sale outbound movement with driving-document linkage, return clocks that never expire silently, gate enforcement by scan, off-site asset visibility, and returnable packaging registers with deposits. The frontline edge layer (gate events, weighbridge events, putaway and locator events, the indent loop) is the capture surface feeding receiving, goods receipt, stock balances, and replenishment. Realizes UJ-GATE-01, UJ-WEIGH-01, UJ-PUT-01, UJ-IND-01.

**Functional Requirements:**

- **FR-GP-01** RGP and NRGP as distinct serially numbered documents per GSTIN and site; required for every outbound movement that is not a sales dispatch, job-work challan, or scrap dispatch.
- **FR-GP-02/03** RGP issue with full consignment detail and reason codes; blocked unless linked to a driving document (work order, calibration entry, approved demo/sample request).
- **FR-GP-04** Rule 55 delivery challans and e-way bill triggers for non-sale movements above threshold.
- **FR-GP-05/06/07** Return receipts verifying serial identity and condition; line-level partial returns; approver-gated substitution on return updating asset registers.
- **FR-GP-08** NRGP only for permitted non-returnable reasons with DOA approval.
- **FR-GP-09** Open-RGP ageing with 7/15/30-day reminder defaults and site-head escalation.
- **FR-GP-10** Statutory and insurance window clocks per RGP class; hard alerts to named owners; no silent expiry.
- **FR-GP-11** Gate enforcement: no matching open gate pass, no exit; mismatches raise incidents.
- **FR-GP-12** Off-site asset visibility report by party, location, value for insurance and audit.
- **FR-GP-13/14** Returnable packaging register with per-party bidirectional balances and serialized cylinders; deposits, refunds, forfeiture, and revaluation.

## 4.15 Reporting and Analytics (source §3.8)

**Description:** Cross-module visibility: executive KPIs with drill-down, role-specific operational dashboards, canned domain reports, configurable exception alerts, self-service ad-hoc reporting, and scheduled distribution.

**Functional Requirements:**

- **FR-R-01 to FR-R-08** Executive dashboard (turns, fill rate, spend, stockouts, forecast accuracy); operational dashboards per role; inventory, procurement, and fulfillment report suites; configurable exception alerts; drag-and-drop ad-hoc reporting with Excel/PDF/CSV export; scheduled report distribution.
