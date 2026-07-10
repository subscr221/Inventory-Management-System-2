---
title: Materials & Supply Chain Management Platform PRD
status: final
created: 2026-07-10
updated: 2026-07-10
---

# PRD: Materials & Supply Chain Management Platform

## 0. Document Purpose

This PRD is the product definition for a materials and supply chain management platform serving one Indian enterprise that runs four business streams (own manufacturing, R&D, a maker-hub, and job-work fabrication) on shared infrastructure. It is written for the PM, business stakeholders, and the downstream UX, architecture, and epic-breakdown workflows. It distills and builds on the sharded High-Level Requirements Document v2.1 at `PLANNING/SCM-Requirements-Document/`, which remains the annex of record: FR statements here are normative capability summaries carrying the source document's stable IDs (FR-I-01, FR-P-09, FR-DOA-01, and so on); the full consequence detail, statutory citations, and edge cases for each FR live in the corresponding source section. Precedence rule: where the two documents diverge, the source section governs for FR consequence detail and statutory citations, and this PRD governs for scope, phasing, journeys, non-goals, and metrics selection; the two are versioned together, and a change to either must be reconciled into the other in the same change cycle. Assumptions inferred without confirmation are tagged inline as `[ASSUMPTION]` and indexed in §15.

## 1. Vision

Today the enterprise answers "what do we hold, where is it, and what did it cost" with phone calls, spreadsheets, and offline registers. Stock visibility is fragmented across plants, warehouses, an R&D centre, a maker-hub, and retail outlets. R&D consumption disappears into untracked issues, finished-goods QC lives in a paper register, scrap leaks value, depreciation is computed in spreadsheets, and R&D spend cannot be separated from production spend without year-end archaeology that creates real audit exposure under Ind AS 38 and DSIR reporting.

The platform becomes the single system of record for stock, assets, and material movements across every location type the enterprise operates. Every movement is captured at the moment it happens, by the person it happens to, on a device that works when the network does not, and every transaction carries the tags, documents, and approvals that Ind AS, GST law, the Companies Act 2013, and the Income-tax Act 2025 demand, so the ERP financial ledger receives postings that are compliant by construction rather than repaired after the fact.

The result: one query answers what a phone tree used to; procurement buys against real consumption; R&D projects, prototypes, and maker-hub sales carry auditable cost trails from the first transaction; maintenance, calibration, QC release, scrap disposal, and gate movement all run on enforced workflows instead of tribal knowledge; and the frontline staff who feed the system see the value of their own data coming back to them.

### 1.1 Business Objectives

The source's twelve objectives (source §2) are the traceability anchors this PRD serves; success metrics in §7 validate them.

- **BO-1** Unified inventory visibility: real-time, drillable stock across all locations in a single pane.
- **BO-2** Reduced operational costs: optimized reorder points, fewer emergency shipments, no manual reconciliation.
- **BO-3** Faster order fulfillment: route orders to the optimal location by proximity, availability, and cost.
- **BO-4** Streamlined procurement: automated procure-to-pay plus formal tender processes.
- **BO-5** Improved demand forecasting: location-level and aggregate forecasts feeding automated replenishment.
- **BO-6** Enhanced supplier management: centralized registry with performance, compliance, and spend analytics.
- **BO-7** Data-driven decisions: role-specific dashboards, KPIs, exception alerts, ad-hoc reporting.
- **BO-8** Seamless integration: ERP, accounting, e-commerce, and logistics without silos or duplicate entry.
- **BO-9** R&D material control and project costing: every issue captured at cost so project cost, prototype WIP, and research-vs-development classification come from transactions, not year-end reconstruction.
- **BO-10** Asset uptime and maintenance cost: one maintenance and calibration history per asset, forward scheduling, measured downtime.
- **BO-11** Compliance by construction: every transaction posts to ERP with audit trail, GST documents, and Ind AS measurement built in.
- **BO-12** Scrap recovery value: scrap recorded at generation, graded, sold through documented auction, recovery measured against assessed value.

## 2. Target User

### 2.1 Jobs To Be Done

- **Operational (frontline):** Log a vehicle, weigh a truck, put stock in a bin, raise an indent, issue a tool, close a work order, sell material at the hub counter, all in seconds, gloved, one-handed, offline if needed, without corrupting downstream data.
- **Operational (supervisory):** Release production orders against real availability, approve indents with budget visibility, disposition QC lots, decide scrap, chase overdue returns, without leaving the floor or waiting for month-end.
- **Managerial:** See accurate stock, spend, forecast, and asset health across all locations in one place; run procurement, tenders, fulfillment, and logistics on measured cycle times.
- **Financial and statutory:** Close periods with subledger-to-GL reconciliation, produce audit evidence (edit logs, physical verification packs, custody statements, Form 3CL feeds, CARO extracts) as by-products of operations rather than projects.
- **External:** Suppliers bid and acknowledge through a portal; auction buyers view lots and bid without touching internal data; statutory auditors read what they need without asking for extracts.

### 2.2 Non-Users (v1)

- Maker-hub members do not get self-service system access beyond machine booking touchpoints operated at the counter; membership plans and subscription billing stay in the membership system.
- End customers do not get an order-tracking portal in v1 (existing e-commerce platform covers this).
- The system does not serve shop-floor machine operators for scheduling or operator tracking (MES scope, excluded).

### 2.3 Key User Journeys

The four fully-worked frontline stories from the source document (§9.2) are carried here as the PRD's user journeys, keeping their source IDs. Personas are role-holders; roles are hats, not badges (one person may hold several).

- **UJ-GATE-01. A gate officer logs an inbound vehicle at 2am with the network down.**
  A truck arrives with a challan referencing a known PO. The gate security officer scans or keys the PO, confirms vehicle and challan details, and photographs the challan (mandatory when offline). The system creates a queued gate event stamped with time, gate ID, and officer ID and shows "captured, pending sync." Within 5 minutes of connectivity restoring, the event auto-reconciles to the matching ASN or PO; mismatches are flagged to the store assistant, never silently dropped. A vehicle with no matching PO is still captured as "unmatched" and routed to a named owner. Value moment: goods enter on a traceable record from the first second, even offline. Validates SM-13.

- **UJ-WEIGH-01. A weighbridge operator captures trusted weights.**
  With the truck bound to its PO or ASN, the operator records tare, then gross; net auto-calculates and is validated against tolerance. In-tolerance weights post to the goods-receipt event with accept status. Out-of-tolerance loads are flagged, blocked from silent receipt, and routed to a named owner (QC or receiving supervisor). Offline, readings queue locally with timestamp and device provenance and reconcile on reconnect with no re-entry. Validates SM-14.

- **UJ-PUT-01. A store assistant bends the slotting map to reality.**
  Directed putaway tells the assistant the bin; a scan of item and bin confirms hands-light (glove-friendly, one-handed). When stock physically goes to a different bin, the assistant scans the actual location and the system records a locator-override correction event with a reason code. The physical override becomes the authoritative location fact with provenance and confidence stamp; the expected value from the ASN is preserved, the conflict surfaced. Last-writer-wins is banned for location. Overrides feed the ABC re-slotting engine, so the assistant's knowledge improves everyone's directed bins. Validates SM-15 and the adoption loop NFR-ADOPT-01.

- **UJ-IND-01. A floor supervisor raises an indent and actually knows what happens to it.**
  With ninety seconds between tasks, the supervisor raises an indent from a phone. A duplicate within the open window triggers a warning before submission. The indent confirms with an ID in under 90 seconds; live status (raised, approved, rejected, ordered, expected delivery) is always visible in-app; the department head's decision arrives as a push notification with the reason. No chasing, no guessing, no raising it twice. Validates SM-16.

Twenty-nine further story stubs (DH-APPROVE-01 through QC-WITNESS-01) are catalogued in source §9.3 with a scored promotion rule; they are backlog inputs to UX and epics, not PRD journeys. `[ASSUMPTION: these four journeys are the complete PRD-blocking set; no stub is journey-critical.]`

## 3. Glossary

The normative glossary is source Appendix B (roughly 120 terms); downstream workflows must use its terms exactly. The load-bearing subset used throughout this PRD:

- **Location** - any stock-holding node: plant, warehouse, R&D store, maker-hub store, retail outlet, 3PL site. Stock balances and access scoping are per location.
- **Indent** - internal material requisition raised by floor or department staff; approved indents become purchase requisition lines.
- **Business stream** - one of production, R&D project, maker-hub, or job-work; every inventory transaction must carry exactly one.
- **BOM** - versioned bill of materials; production BOMs are ECO-controlled released records, R&D BOMs are fast-iterating drafts promoted through a productization gate.
- **ECO** - engineering change order; the only mechanism that alters a Released BOM.
- **Production order** - the record of truth for a make event, carrying state, effective BOM version, WIP balance, and lot genealogy.
- **Production WIP** - stock state holding quantity and cost of components issued to a production order, distinct from R&D project WIP.
- **QC Hold** - the stock state all finished output enters at completion; only a recorded disposition (Accept, Reject, Conditional Release) moves it.
- **Custody issue** - loan of equipment or a tool to a named custodian with expected return date; never consumption.
- **Job-work service order** - the anchor record for fabricating on customer-owned material; customer stock is non-valuated and segregated.
- **Custody ledger** - per-customer, per-order record of customer-owned material movements; prints as the customer custody statement.
- **Gate pass (RGP/NRGP)** - serially numbered authorization for any non-sale, non-job-work, non-scrap outbound movement; RGP carries a return clock.
- **Lot (disposal)** - grouped scrap or disposal stock offered as one unit of sale, carrying reserve price and NRV.
- **DOA registry** - the single enterprise delegation-of-authority table every approval workflow resolves approvers from.
- **ITC** - GST input tax credit; tracked per GSTIN and reversed on write-offs under s.17(5)(h) CGST Act.
- **IRN** - invoice reference number from the Invoice Registration Portal; dispatch of e-invoiceable supplies is blocked without it.
- **Landed cost** - import item cost including BCD, SWS, and other non-creditable charges; recoverable IGST never enters it.
- **Edit log** - the tamper-proof, non-disableable statutory audit trail required by the Companies (Accounts) Rules audit-trail proviso.

## 4. Features

Each feature groups the source modules it absorbs, with FRs nested under it by their stable source IDs. Descriptions are behavioral; full per-FR consequence detail is in the referenced source sections.

### 4.1 Core Inventory (source §3.1)

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

### 4.2 Warehouse Operations (source §3.5)

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

### 4.3 Procurement, Tendering, and Supplier Management (source §3.2, §3.3)

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

### 4.4 Order Management, Demand Planning, and Logistics (source §3.4, §3.6, §3.7)

**Description:** The outbound and planning spine: multi-channel order capture through validation, intelligent routing to the optimal fulfillment location, split shipments, backorders, returns, and drop-ship; statistical forecasting with auto-selected models feeding replenishment; carrier management, shipment planning, rate shopping, tracking, and freight audit.

**Functional Requirements:**

- **FR-O-01 to FR-O-08** Order capture (manual, EDI, e-commerce, internal, inter-branch), validation (completeness, credit, availability), routing by configurable rules, split shipments, backorder allocation (FIFO or priority), status tracking with attribution, RMA returns processing, drop shipping.
- **FR-D-01 to FR-D-08** Historical data analysis at SKU-location grain, statistical forecasting with best-fit model auto-selection, seasonality and trend detection, promotional overlay, collaborative forecasting with accuracy tracking, NPI forecasting by analogy, replenishment planning (with BOM explosion for dependent demand per FR-B-07), inventory optimization and redistribution.
- **FR-L-01 to FR-L-08** Carrier registry and contract rates, shipment planning and consolidation, freight rate shopping, tracking with delay alerts, freight audit and payment, fleet management where an owned fleet exists, import/export documentation, returns logistics.

### 4.5 R&D Centre and Maker-Hub Operations (source §3.9)

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

### 4.6 BOM and Engineering Change Management (source §3.10)

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

### 4.7 Production Orders and Production WIP (source §3.16)

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

### 4.8 Job-Work Services (source §3.17)

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

### 4.9 Quality Control for Finished Goods (source §3.12)

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

### 4.10 Maintenance, Calibration, and Tooling (source §3.11, §3.19)

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

### 4.11 Scrap, Defectives, and Disposal (source §3.13)

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

### 4.12 Fixed Assets, Intangibles, and Depreciation (source §3.14)

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

### 4.13 Financial Compliance Spine (source §3.15, §3.18, §3.21, §3.22)

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

### 4.14 Gate Passes, Returnable Materials, and Frontline Edge Capture (source §3.20, §9)

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

### 4.15 Reporting and Analytics (source §3.8)

**Description:** Cross-module visibility: executive KPIs with drill-down, role-specific operational dashboards, canned domain reports, configurable exception alerts, self-service ad-hoc reporting, and scheduled distribution.

**Functional Requirements:**

- **FR-R-01 to FR-R-08** Executive dashboard (turns, fill rate, spend, stockouts, forecast accuracy); operational dashboards per role; inventory, procurement, and fulfillment report suites; configurable exception alerts; drag-and-drop ad-hoc reporting with Excel/PDF/CSV export; scheduled report distribution.

## 5. Non-Goals (Explicit)

The platform is not, and will not become in v1:

- A PLM or CAD system: no drawing vaults or design workflows; structured BOM import (INT-CAD-01) is the only touchpoint.
- A predictive-maintenance IoT platform: time and meter-based schedules only.
- A general ledger or statutory books system: it posts subledgers to the ERP; the ERP closes periods and files returns.
- An external marketplace: in-system auction only, with optional result sync from an external e-auction venue.
- An MES: no machine scheduling or operator tracking; work-order material issue and consumption only.
- An HR, payroll, or membership subscription system: member records and charges only; plans and renewals stay in the membership system.
- An autonomous AI procurement engine: rules-based automation only in the initial phase.
- A customer-facing order tracking portal: the existing e-commerce platform covers this.
- A TMS replacement: carrier integration and tracking only.
- An MRP engine: net-requirements planning deferred, revisited after two quarters of stable BOM and lead-time data.
- An insurance claim system: events, policy references, and write-offs are recorded; claims administered in ERP or manually.

## 6. MVP Scope

Delivery approach (confirmed 2026-07-10): **spine-first custom build over a 36-month program**. The compliance spine (statutory edit log, DOA registry, event-sourced location, calibration and statutory lockouts, business-stream tagging) is built and acceptance-tested first as the platform layer every module sits on; modules then land in waves. Phasing follows revenue exposure, pulling job-work services and R&D/maker-hub tracking into Phase 1. The remaining wave boundary is proposed for confirmation. `[ASSUMPTION: apart from the confirmed job-work and R&D placement, wave boundaries are PM-proposed from source dependencies (C-12, A-13, A-11), not stakeholder-agreed.]`

### 6.1 Phase 1 (first go-live)

First go-live slice, at a single pilot site: the compliance spine, core inventory, the frontline gate edge, and job-work services. `[ASSUMPTION: the slice composition follows the party-session recommendation; first go-live is assumed to land well inside the 36-month program envelope, sequencing to be set by the program plan.]` The remaining Phase 1 items below follow in waves at 2 to 3 locations each:

- Core inventory, warehouse operations, and the frontline edge layer (gate, weighbridge, putaway, indent loop) with offline-first capture.
- Procurement and supplier management including MSME compliance; approvals resolved through the DOA registry with ERP-synced budget checks.
- BOM management with kit migration; production orders and WIP; finished-goods QC gate (after FR-M instrument records load, per C-12).
- **Job-work services (FR-JW, with FR-B-16 kit BOMs and FR-AC-11 challan clocks)** - confirmed into Phase 1 by revenue exposure: job-work is a billed revenue stream and its statutory return clocks run from day one.
- **R&D and maker-hub operations (FR-RD, with FR-AC-01/02/04 tagging and classification)** - confirmed into Phase 1: untagged R&D consumption is the standing audit exposure (BO-9, BO-11) and cannot wait for a later wave.
- Maintenance and calibration register (instrument data load is a hard predecessor of the QC gate).
- Financial compliance spine: stream tagging, edit log, ITC register, GST documents, period-end close.
- ERP, IAM/SSO, barcode, gate/weighbridge, and hub payment (INT-PAY-01) integrations.
- Data migration and cutover gate (FR-DM-01 to FR-DM-03) with department-head and finance sign-off.

### 6.2 Phase 2 and later

- Tender management, demand planning, logistics/TMS features, e-commerce and 3PL integrations.
- Fixed assets and intangibles, scrap/disposal/auction, imports, tooling, gate passes.
- Automated meter ingestion (INT-MTR-01) replacing operator-entered readings (A-10); CPCB EPR portal automation replacing manual upload (INT-EPR-01).

### 6.3 Out of Scope for MVP

Everything in §5, plus: multi-country data residency (resolved out of scope: India only, see §14 question 1), RFID and IoT beyond barcode scanning where not already deployed, put-to-light picking.

## 7. Success Metrics

The source defines 48 metrics (SM-01 to SM-48) with targets and measurement methods; that catalogue is normative and carried whole. The load-bearing subset, grouped:

**Primary**

- **SM-01** Inventory accuracy at or above 98% (cycle count variance). Validates FR-I-01, FR-I-06.
- **SM-03** Line fill at or above 95%, order fill at or above 97%. Validates FR-O-03 to FR-O-05.
- **SM-10** User adoption at or above 85% of targeted users active within 90 days of each location go-live.
- **SM-17** Frontline confirmation rate sustained at or above 95%; a drop is a system defect to investigate, not user error (NFR-ADOPT-01). Validates UJ-GATE-01 through UJ-IND-01.
- **SM-28** Zero dispatch lines lacking a batch release record (system-blocked by design). Validates FR-Q-02, FR-Q-05.
- **SM-34** 100% of job-work returns within statutory windows. Validates FR-AC-11, FR-JW-14.
- **SM-41** 100% MSME invoices paid within MSMED s.15 due dates; zero s.43B(h) carry-over at year-end. Validates FR-P-09.
- **SM-48** Zero unexplained opening-balance variance at cutover with full sign-off. Validates FR-DM-01 to FR-DM-03.

**Secondary (representative)**

- **SM-02** Stockouts reduced 40% within 12 months. **SM-06** Requisition-to-PO time reduced 50%. **SM-07** Forecast accuracy at or above 75% at SKU-location. **SM-13** Median gate dwell at or below 4 minutes including offline. **SM-19** Zero untagged material transactions per month. **SM-23** PM adherence at or above 95%. **SM-27** Completion-to-release decision at or below 24 hours median. **SM-29** Scrap reconciliation variance below 2% by weight. **SM-31** Auction realization at or above 95% of approved NRV. **SM-40** Landed cost finalized within 7 days of GRN for 100% of import receipts. The remaining metrics (SM-04, SM-05, SM-08, SM-09, SM-11, SM-12, SM-14 to SM-16, SM-18, SM-20 to SM-22, SM-24 to SM-26, SM-30, SM-32, SM-33, SM-35 to SM-39, SM-42 to SM-47) are enumerated with targets in source §8.

**Counter-metrics (do not optimize)** `[ASSUMPTION: the source defines no counter-metrics; these are proposed and need confirmation.]`

- **SM-C1** Override and exception volume (release-gate overrides, conditional releases, warn-rule bypasses) must not fall to zero by making overrides harder to record; suppressed exceptions corrupt data. Counterbalances SM-27, SM-28.
- **SM-C2** Gate dwell (SM-13) must not improve by skipping mandatory capture (challan photos, weighments); measure capture completeness alongside dwell.
- **SM-C3** Inventory days on hand reduction (SM-09) must not be achieved by starving safety stock below computed levels; track stockout rate (SM-02) as the paired brake.

## 8. Cross-Cutting NFRs

Source §4 is normative; headline values:

- **Scale (NFR-S-01 to S-05):** 50 locations scaling to 200+ without architectural change; 500k+ SKUs; 1,000 concurrent users with headroom to 5,000; 10k+ order lines/hour; 8-financial-year retention (3 online, archive restorable to queryable within 48 hours).
- **Performance (NFR-P-01 to P-05):** operational screens under 2s; single-SKU stock queries under 1s; standard reports under 10s; API p95 under 500ms.
- **Availability (NFR-P-04, restated as a two-tier SLA, confirmed 2026-07-10):** tier 1, frontline edge capture (gate, weighbridge, putaway, crib, hub POS, technician flows) is available 24x7 by offline-first architecture - device-local capture with store-and-forward is the availability mechanism, and the degraded state must be visible on the device ("captured, pending sync"). Tier 2, the central control plane (order release, closure, IRN-gated dispatch, approvals) carries 99.5% availability (target 99.9%) over per-site operating windows defined in the program plan. This supersedes the source's "business hours" phrasing.
- **Security (NFR-SEC-01 to SEC-06):** SSO (SAML 2.0/OIDC); RBAC to module, function, location, and data level; TLS 1.2+ and AES-256; immutable audit log (extended by FR-AC-13); enforced segregation of duties; DPDP Act 2023 and DPDP Rules 2025 compliance.
- **Data integrity (NFR-DI-01 to DI-05):** ACID inventory transactions; no double allocation; cross-location sync lag at most 5s with graceful partition handling; daily backups, RTO 4h, RPO 1h; idempotent financial postings.
- **Usability (NFR-U-01 to U-06):** responsive on desktop and rugged tablets; WCAG 2.1 AA; i18n and multi-currency; offline-first frontline capture as a normal path `[ASSUMPTION: offline is a firm requirement for all frontline flows, not the conditional phrasing of A-03]`; scan-first, glove-friendly, one-handed moment-of-use ergonomics.
- **Extensibility (NFR-E-01 to E-04):** documented REST (and/or GraphQL) APIs; configurable workflows without code; plugin framework; upgrades under 30 minutes.
- **Adoption (NFR-ADOPT-01):** captured frontline knowledge must visibly benefit the people who capture it; confirmation below 95% is a defect.
- **Documents (NFR-D-01/02):** single attachment store with virus scanning; per-type retention classes with legal hold; deletion before expiry blocked and logged.

## 9. Compliance and Regulatory

Compliance is a product feature here, not an overlay. The binding regimes, each already embedded in specific FRs:

- **Ind AS** 2 (valuation, NRV), 16 (PPE, components), 36 (impairment), 38 (research vs development, intangibles), 21 (exchange differences), 20 (grants, via tagging).
- **Companies Act 2013:** Schedule II lives, Schedule III disclosures and ageing, s.128(5) retention, CARO 2020 clauses 3(i) and 3(ii), and the audit-trail proviso to Rule 3(1) Companies (Accounts) Rules 2014 (edit log that no role, including admins, can disable; no hard deletes; corrections as reversals).
- **GST law:** ITC per GSTIN with s.17(5)(h) reversals; Schedule I branch transfers with Rule 28 valuation; Rule 45/55 challans; s.143 job-work clocks with ITC-04; e-invoicing with the 30-day IRP window; e-way bills above Rs 50,000; dynamic QR where turnover thresholds apply.
- **Income-tax Act 2025** (and 1961 predecessors): s.394(1) TCS on scrap; s.43B(h) MSME disallowance exposure; s.35 R&D deduction with DSIR Form 3CL.
- **MSMED Act 2006:** ss.15/16/22 payment discipline and disclosures (FR-P-09).
- **Customs Act 1962:** s.14 valuation, s.18 provisional assessment with the two-year window; ICEGATE reconciliation.
- **Legal Metrology:** weighbridge stamping (Rule 27) blocking trade weighment; Packaged Commodities Rules label declarations (FR-Q-14).
- **BIS (Conformity Assessment) Regulations 2018:** Scheme-I and CRS release blocking (FR-Q-11).
- **Environmental:** Hazardous Waste Rules 2016 (Form 10, 90-day cap), E-Waste Rules 2022, Battery Waste Rules 2022, Plastic Waste (EPR) Rules through the 2026 amendment (FR-SC-18/19/22).
- **OSH Code 2020:** statutory examinations of lifting equipment (FR-M-14).
- **DPDP Act 2023 / Rules 2025:** personal data of members, customers, contacts, users (NFR-SEC-06).

## 10. Integration and Dependencies

The ERP already in place remains the system of record for financial data (A-02); this platform is the system of record for inventory operations and BOM structure. Source §6 is normative; the integration families:

- **ERP (INT-ERP-01 to 07):** dual-mastership item/BOM sync (BOM structure outbound, cost rates inbound, conflicts create exceptions, last-write-wins forbidden); GL, AP, and billing postings; sales order inbound; master data sync; daily hub charge push; budget head sync.
- **Accounting (INT-ACC-01 to 03):** valuation exports, landed cost, GRNI accruals.
- **E-commerce (INT-EC-01 to 03)** and **3PL (INT-3PL-01 to 03):** availability feeds, order import, shipment confirmations; 3PL stock and status.
- **Suppliers and carriers (INT-SUP, INT-CAR):** EDI/API POs, ASNs, supplier portal, carrier rate and tracking APIs.
- **Data capture (INT-DC-01 to 03):** barcode (1D/2D/QR), RFID where deployed, weigh scales and dimensioners.
- **Identity (INT-IAM-01/02):** SSO and SCIM provisioning; SSO is non-negotiable (C-03).
- **Gate and location (INT-GATE-01, INT-LOC-01):** the vehicle-to-PO binding token and weighbridge event contract; event-sourced location with asserted/expected separation and no last-writer-wins.
- **Statutory (INT-GST-01 to 03, INT-CUS-01, INT-MSME-01):** IRP e-invoicing through the ERP flow, e-way bills, GST filing exports, ICEGATE BOE feeds, Udyam verification.
- **Disposal, metering, design, payments (INT-EPR-01, INT-AUC-01, INT-MTR-01/02, INT-CAD-01, INT-PAY-01):** EPR portal exchange (manual acceptable first phase), optional external e-auction sync, meter ingestion and status feeds, R&D BOM import, hub UPI/card gateway.

Hard sequencing dependencies: FR-M instrument records before the FR-Q-04 lockout goes live (C-12); BIS licence data in the product master before FR-Q-11 (A-13); item-master governance in FR-I and INT-ERP-01 before FR-B-06 BOM release (A-11); migrated balances signed off before any go-live (FR-DM-03).

## 11. Stakeholders and Roles

Roles are assignable capabilities ("hats"), not job titles; one user may hold several, scoped by location, without code changes (NFR-SEC-02). Source §5 defines roughly 36 roles across warehouse, procurement, planning, logistics, retail, quality, finance, R&D, maker-hub, engineering, maintenance, calibration, scrap/disposal, accounting, GST/customs, production, job-work, tooling, gate, and EPR functions, plus external suppliers and read-only statutory auditors. Section 5.3 decomposes frontline moments into granular roles (gate officer, weighbridge operator, unloading supervisor, store assistant, stock locator, dispatch clerk, indent raiser, approver). The published access matrix covers only 7 coarse roles; access rules for the remainder are a downstream design obligation (see §14).

## 12. Data Migration and Cutover

Go-live quality is set by opening balances; an error here repeats its damage on every transaction after cutover.

- **FR-DM-01** Physically verified opening stock by location, lot, and serial; asset register with cost, accumulated depreciation, and remaining Schedule II life; open POs, sales orders, and job-work challans with source references.
- **FR-DM-02** Active BOMs, custody and loan registers, and open gate passes migrated and department-verified before cutover.
- **FR-DM-03** Balances reconciled to ERP and legacy records; department-head and finance sign-off is a mandatory go-live gate. Validated by SM-48.

## 13. Rollout and Change Management

- Program timeline re-baselined (confirmed 2026-07-10): **36 months**, superseding C-01's 12 to 18 months; delivery is spine-first (see §6), with first go-live at a single pilot site inside the envelope.
- Change capacity caps rollout at 2 to 3 locations per wave (C-06).
- Pilot-site selection is open: operations argued for the hardest site (worst connectivity, busiest gate) to prove the system where it is weakest; change-management convention favors a receptive site. Program sponsor to decide.
- Platform decision (2026-07-10): **custom build**. The business has concluded that no candidate COTS platform can deliver the India-specific statutory constructions (non-disableable edit log, weighbridge stamping blocks, 90-day hazardous timers, DOA registry, event-sourced location) within acceptable customization limits. This supersedes source constraint C-02's COTS preference; C-02's budget rationale ("full custom build impractical") now conflicts with the decision and must be re-baselined (see §14, question 10). Evaluation background is in the addendum.
- Barcode hardware is budgeted separately and assumed in place at go-live (A-05); a dedicated project team is assumed available (A-06).

## 14. Open Questions

1. **Multi-country footprint.** Resolved 2026-07-10: **India only**. Source constraint C-04 (multi-country data residency) is superseded and replaced by an architecture principle: no region-bound assumptions hard-coded in the data layer, so residency support stays cheap if the footprint ever changes.
2. **COTS vs compliance depth.** Resolved 2026-07-10: no candidate COTS platform (Manhattan, Blue Yonder, Oracle SCM Cloud, SAP IBP, Kinaxis) can deliver the required customization. Custom build selected; see §13 and question 10.
3. **Availability window.** Resolved 2026-07-10: two-tier SLA adopted (see §8) - edge capture 24x7 by offline-first architecture, central control plane at 99.5% (target 99.9%) over per-site operating windows. Residual: the per-site operating windows themselves are defined in the program plan.
4. **Retention reconciliation.** NFR-S-05 (8 financial years) and NFR-D-02 (per-type statutory minimums) need a single unified retention table per record and document class.
5. **"Real-time" quantification.** INT-EC-01 promises a real-time availability feed while NFR-DI-03 permits 5s sync lag and NFR-P-05 allows 2s API tails. Define "real-time" numerically per feed.
6. **DPDP compliance date.** Obligations phase in to May 2027. Must the platform be compliant at launch or by the phased deadlines?
7. **Access matrix completion.** Owner assigned 2026-07-10: the **Super Admin (system owner) acts as security lead** for the full role-capability matrix, due before Phase 1 detailed design. Requirements confirmed: roles modeled as hats (assignable capabilities, location-scoped), segregation-of-duties constraints as first-class matrix rows, and "Configure system settings" reassigned from the Finance column to System Administrator. Residual: the matrix itself still has to be produced and audited for traceability.
8. **Baseline-dependent targets.** SM-16, SM-32, SM-37, SM-39, SM-42 defer hard targets until baselines exist; owners and baseline windows need naming.
9. **MVP boundary confirmation.** Partially resolved 2026-07-10: the business directed reordering by revenue exposure, moving job-work services and R&D/maker-hub tracking into Phase 1 (see §6.1). The remaining Phase 1/Phase 2 boundary stands as proposed and still needs sign-off.
10. **Custom-build feasibility.** Substantially resolved 2026-07-10: delivery approach is **spine-first** (compliance platform layer built and acceptance-tested before modules) and the timeline is re-baselined to **36 months**, superseding C-01 and dissolving the schedule conflict with C-02. Residuals: the budget envelope for the custom build (C-02's original objection) still needs a figure from the sponsor and finance; build sourcing (in-house, partner, or hybrid) is undecided; the spine acceptance contract is to be enumerated from the existing testable FRs (C-07, FR-AC-13, FR-M-13/14, FR-DOA-01, INT-LOC-01) as an architecture-phase deliverable.

## 15. Assumptions Index

Source assumptions A-01 to A-14 (locations count, ERP in place, connectivity, item-master governance, barcode budget, project team, cloud hosting, Ind AS and GST registrations, DSIR recognition, operator-entered meters first, BOM release governance, booked-hours approximation, BIS licences, maker-hub scrap ownership) are carried as stated in source §7.1. PRD-added assumptions:

- §6 - Phase 1/Phase 2 module split is PM-proposed from dependency constraints, except the job-work and R&D/maker-hub placement in Phase 1, which the business confirmed on 2026-07-10.
- §6.1 - The first go-live slice (spine, core inventory, gate edge, job-work at one pilot site) follows the party-session recommendation; first go-live is assumed to land well inside the 36-month envelope, with exact sequencing owned by the program plan.
- §6.1 - Pulling both job-work and R&D into Phase 1 interprets the business direction "reorder by revenue exposure"; if only job-work was intended, R&D reverts to Phase 2.
- §7 - Counter-metrics SM-C1 to SM-C3 are proposed; the source defines none.
- §2.3 - Treating the four fully-worked source stories as the PRD's complete journey set (remaining moments live as scored stubs) assumes no additional journey is PRD-blocking.
- Offline capability is treated as a firm requirement for all frontline flows (SM-13 wording and NFR-U-05), not the conditional phrasing of A-03.
