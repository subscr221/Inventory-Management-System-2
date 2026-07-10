# Supply Chain Management System - High-Level Requirements Document

**Document Version:** 2.0
**Date:** 2026-07-10
**Classification:** Internal - Business & Technical Review
**Project:** Multi-Location Materials & Supply Chain Management System for a Production, R&D, and Maker-Hub Enterprise

## 1. Project Overview

### 1.1 Purpose

This document defines high-level requirements for a materials management platform serving one Indian enterprise that runs four businesses on shared infrastructure: it manufactures and sells its own products, develops new products in an R&D centre through prototype and pilot builds, operates a maker-hub where members book company machines and buy materials at point of use, and fabricates for customers as job work. The platform is the system of record for stock, assets, and material movements across all locations, and it must post to the ERP financial ledger in a form that satisfies Ind AS, GST law, and the Companies Act 2013. Every requirement in this document names the user who feels the pain today and the measurable condition that counts as done.

### 1.2 Scope

The system manages inventory, assets, and material flows across these location types:

- **Production plants** - raw material, WIP, finished goods, and line-side stores
- **Warehouses and distribution centres** - bulk storage and inter-location transfers
- **R&D centre** - project stores that issue materials against project codes and hold prototype WIP
- **Maker-hub** - member-facing stores selling materials at point of use, plus consumables for bookable machines
- **Retail outlets** - finished-goods stock and sales
- **Third-party logistics (3PL) providers** - outsourced storage and fulfilment where contracted

Functional scope covers the full material and asset lifecycle: plan, source, make, develop, maintain, deliver, return, and dispose, with reporting and analytics across all stages.

### 1.3 Business Context

The company runs manufacturing, R&D, maker-hub, and job-work operations on systems built for none of them. The pain the business feels today:

- **Fragmented stock visibility** - answering "what do we hold and where" takes phone calls across locations, not a query
- **Manual inter-location transfers** - spreadsheets and email produce shrinkage, double counting, and disputes
- **Procurement disconnected from consumption** - buyers reorder blind, so stockouts coexist with excess stock
- **Untracked R&D consumption** - materials issued to projects disappear from view, prototype WIP carries no book value, and project costs are rebuilt by hand at year-end
- **No maintenance or calibration history** - equipment fails without warning, downtime is unmeasured, and repair is reactive
- **Finished-goods QC in an offline register** - no system link between test result and stock release
- **Scrap and defectives leak** - generation goes unrecorded, disposal is undervalued, and sale proceeds cannot be traced to lots
- **Depreciation in spreadsheets** - no register links an asset's book value to its physical location and condition
- **R&D spend inseparable from production spend** - at audit the company is exposed on Ind AS 38 classification and DSIR reporting

This system addresses these pain points by providing a single source of truth for all supply chain data, with role-appropriate access and workflows.

## 2. Business Objectives

| #    | Objective                              | Description                                                                                                                                                                   |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BO-1 | **Unified Inventory Visibility** | Provide real-time, accurate stock levels across all locations with a single-pane-of-glass view, drillable to SKU and location level.                                          |
| BO-2 | **Reduced Operational Costs**    | Minimize carrying costs through optimized reorder points, reduce emergency shipments through better demand forecasting, and eliminate manual data entry and reconciliation.   |
| BO-3 | **Faster Order Fulfillment**     | Route customer and internal orders to the optimal fulfillment location based on proximity, stock availability, and cost, reducing lead times and shipping expenses.           |
| BO-4 | **Streamlined Procurement**      | Automate the procure-to-pay cycle from requisition through purchase order, receiving, and invoice matching. Support formal tender processes for competitive vendor selection. |
| BO-5 | **Improved Demand Forecasting**  | Leverage historical data, seasonality, and trends to generate location-level and aggregate demand forecasts, feeding into automated replenishment recommendations.            |
| BO-6 | **Enhanced Supplier Management** | Maintain a centralized supplier registry with performance tracking, compliance documentation, and spend analytics to support strategic sourcing decisions.                    |
| BO-7 | **Data-Driven Decision Making**  | Empower executives and operational managers with role-specific dashboards, KPIs, exception alerts, and ad-hoc reporting capabilities.                                         |
| BO-8 | **Seamless Integration**         | Ensure the SCM system integrates with existing ERP, accounting, e-commerce, and logistics platforms, eliminating data silos and duplicate entry.                              |
| BO-9 | **R&D Material Control and Project Costing** | Capture every issue to an R&D project at cost, so project cost, prototype WIP value, and research-vs-development classification come from transactions rather than year-end reconstruction. |
| BO-10 | **Asset Uptime and Maintenance Cost** | Hold one maintenance and calibration history per asset, schedule work forward, and measure downtime and repair cost by asset and location. |
| BO-11 | **Compliance by Construction** | Post every stock, asset, and disposal transaction to the ERP with audit trail, GST documents, and Ind AS measurement basis built in, so statutory audit needs no after-the-fact cleanup. |
| BO-12 | **Scrap Recovery Value** | Record scrap and defectives at generation, grade them, and sell through documented auction, so recovery value is measured against assessed value per lot. |

---

## 3. Functional Requirements

### 3.1 Inventory Management

- **FR-I-01 - Multi-Location Stock Tracking:** Maintain real-time inventory balances (on-hand, allocated, available, in-transit) per SKU per location, with a consolidated enterprise view.
- **FR-I-02 - Stock Transfers:** Support inter-location transfer requests, approvals, pick/pack/ship at the source location, and receiving at the destination location, with full lot/serial traceability.
- **FR-I-03 - Reorder Points and Automated Replenishment:** Configure minimum and maximum stock levels per SKU per location. Generate replenishment recommendations or auto-generated purchase requisitions when stock falls below reorder point.
- **FR-I-04 - Lot and Serial Number Tracking:** Track inventory by lot/batch number and serial number for traceability, expiry management (FEFO/FIFO), and recall readiness.
- **FR-I-05 - Inventory Valuation:** Support FIFO and weighted average cost formulas, with specific identification for items not ordinarily interchangeable (Ind AS 2 paras 23-25), applying one formula to all inventories of similar nature and use across the entity. Permit standard cost only as a measurement technique where periodic variance review shows it approximates actual cost (Ind AS 2 para 21). LIFO is not offered; Ind AS 2 does not permit it.
- **FR-I-06 - Cycle Counting and Physical Inventory:** Schedule and execute cycle counts by location, zone, or ABC classification. Record variances, trigger recounts, and post adjustments with approval workflows.
- **FR-I-07 - Safety Stock Management:** Calculate and maintain safety stock levels based on lead time variability, demand variability, and target service levels.
- **FR-I-08 - Inventory Aging and Obsolescence:** Track inventory age by receipt date and lot. Flag slow-moving, excess, and obsolete stock for review and disposition.
- **FR-I-09 - Kitting and Bill of Materials:** Support assembly/disassembly of kits and bundles, tracking component consumption and finished good production at the inventory level.
- **FR-I-10 - Consignment and VMI Stock:** Track consignment inventory (customer-owned at your site) and vendor-managed inventory (your stock at customer site) separately from owned inventory.

### 3.2 Procurement and Supplier Management

- **FR-P-01 - Supplier Registry:** Centralized supplier master data including contact information, tax IDs, payment terms, quality certifications, diversity classifications, and compliance documents.
- **FR-P-02 - Supplier Onboarding:** Workflow for new supplier registration, document collection, approval routing, and activation.
- **FR-P-03 - Supplier Performance Tracking:** Capture and score supplier performance metrics - on-time delivery rate, quality acceptance rate, price competitiveness, responsiveness. Generate supplier scorecards.
- **FR-P-04 - Purchase Requisition:** Allow authorized users to create purchase requisitions specifying items, quantities, required dates, preferred suppliers, and delivery locations. Route for approval based on configurable rules (amount thresholds, categories, departments).
- **FR-P-05 - Purchase Order Management:** Convert approved requisitions to purchase orders. Support blanket POs, contract POs, and standard POs. Track PO status from issuance through receipt and invoicing.
- **FR-P-06 - Goods Receipt and Quality Inspection:** Record receipt of goods against purchase orders. Trigger quality inspection workflow for designated items. Record acceptance, rejection, or conditional acceptance with reasons.
- **FR-P-07 - Invoice Matching and Reconciliation:** Three-way matching (PO, goods receipt, supplier invoice) with tolerance thresholds. Flag discrepancies for resolution. Support credit notes and debit notes.
- **FR-P-08 - Spend Analytics:** Analyze procurement spend by supplier, category, location, department, and time period. Identify consolidation opportunities and off-contract spend.
- **FR-P-09 - MSME Supplier Compliance:** Capture Udyam Registration Number and micro/small/medium classification at supplier onboarding (FR-P-01/02), revalidated at least annually against the Udyam portal. Stamp every invoice/GRN of a micro or small supplier with its statutory due date, the earlier of the agreed date and 45 days from acceptance or deemed acceptance, or the 15-day appointed day where no written agreement exists (MSMED Act 2006 ss.2(b) and 15). Feed classification-tagged ageing to the ERP for disallowance monitoring under s.43B(h) Income-tax Act 1961, carried into s.37 of the Income-tax Act 2025 from 1 April 2026, for s.16 MSMED interest exposure at three times the RBI bank rate compounded monthly, and for the Schedule III MSME trade payables and MSMED s.22 disclosures.

### 3.3 Tender Management and Vendor Selection

- **FR-T-01 - Tender Creation:** Author RFQ/RFP/RFI documents with item specifications, quantities, delivery schedules, evaluation criteria, terms and conditions, and submission deadlines. Template library for recurring tender types.
- **FR-T-02 - Supplier Invitation:** Select suppliers from the registry or invite new suppliers to participate. Track invitation status, confirmations, and declinations.
- **FR-T-03 - Bid Submission Portal:** Secure portal for suppliers to submit bids, upload supporting documents, and ask clarification questions. Automatic acknowledgment of receipt.
- **FR-T-04 - Clarification Management:** Q&A workflow during the tender period. Suppliers submit questions; procurement team publishes responses (anonymized or attributed) visible to all or selected participants.
- **FR-T-05 - Bid Opening and Evaluation:** Controlled bid opening (manual or automated at deadline). Side-by-side bid comparison against evaluation criteria. Weighted scoring with configurable criteria and sub-criteria.
- **FR-T-06 - Award Recommendation and Approval:** Generate award recommendation based on evaluation scores. Route for multi-level approval. Record award decisions and notify winners and unsuccessful bidders.
- **FR-T-07 - Contract Generation:** Generate contract from awarded tender terms. Link contract to subsequent purchase orders for spend tracking against contract value.

### 3.4 Order Management and Fulfillment

- **FR-O-01 - Order Capture:** Accept orders from multiple channels - manual entry, EDI, e-commerce platform integration, internal requisitions, and inter-branch orders.
- **FR-O-02 - Order Validation:** Validate orders for completeness (customer, items, quantities, pricing), credit limits, and inventory availability at the time of entry.
- **FR-O-03 - Order Routing and Fulfillment Location Assignment:** Intelligently route orders to the optimal fulfillment location based on configurable rules: inventory availability, proximity to customer, workload balancing, shipping cost, and item sourcing constraints.
- **FR-O-04 - Split Shipments:** Support splitting a single order across multiple fulfillment locations when one location cannot fulfill the entire order, with partial shipment tracking and customer communication.
- **FR-O-05 - Backorder Management:** Track backordered items, automatically allocate incoming stock to backorders (configurable FIFO or priority-based), and generate backorder fulfillment orders.
- **FR-O-06 - Order Status Tracking:** Real-time order status visibility (received, confirmed, allocated, picked, packed, shipped, delivered, returned) with timestamps and user attribution for each status transition.
- **FR-O-07 - Returns Management:** Process return authorizations (RMA), track returned goods receipt, inspect returned items, route for restock, repair, or disposal, and process refunds or replacements.
- **FR-O-08 - Drop Shipping:** Support drop-ship orders where the supplier ships directly to the customer. Track drop-ship POs linked to sales orders.

### 3.5 Warehouse Management

- **FR-W-01 - Warehouse Configuration:** Define warehouse structure - sites, zones, aisles, racks, bins - with configurable attributes (temperature zones, hazardous material zones, quarantine zones).
- **FR-W-02 - Receiving:** Receive inbound shipments against ASNs (Advanced Shipping Notices) or purchase orders. Capture lot/serial numbers, expiry dates, and quality inspection results at receipt. Generate putaway tasks.
- **FR-W-03 - Putaway:** System-directed putaway based on item characteristics (velocity, size, temperature requirements), zone capacity, and configurable rules. Support both directed and user-selected putaway.
- **FR-W-04 - Picking:** Generate pick tasks with optimized pick paths. Support multiple picking strategies: single-order picking, batch picking, wave picking, zone picking. Paper-based and mobile-device-directed workflows.
- **FR-W-05 - Packing:** Packing station workflow - scan items, system validates against order, capture weights and dimensions, generate shipping labels and packing slips. Support cartonization (suggesting optimal box sizes).
- **FR-W-06 - Shipping:** Generate shipping documents (BOL, commercial invoice, customs documents). Carrier rate shopping and label generation. Load planning and truck manifest creation.
- **FR-W-07 - Task Management:** Generate, assign, prioritize, and track warehouse tasks (receiving, putaway, picking, replenishment, cycle count). Monitor task completion rates and worker productivity.
- **FR-W-08 - Replenishment:** Trigger replenishment of forward-pick locations from reserve storage based on min/max levels or demand-driven signals.
- **FR-W-09 - Cross-Docking:** Support flow-through and distribution cross-docking where inbound goods are immediately staged for outbound shipment without putaway.

### 3.6 Demand Planning and Forecasting

- **FR-D-01 - Historical Data Analysis:** Ingest and analyze historical sales, consumption, or issue data at SKU and location granularity. Handle data gaps, outliers, and one-time events.
- **FR-D-02 - Statistical Forecasting:** Generate forecasts using multiple statistical models (moving average, exponential smoothing, Holt-Winters, ARIMA). Automatically select the best-fit model per SKU-location combination.
- **FR-D-03 - Seasonality and Trend Detection:** Detect and model seasonal patterns, trends, and cyclicality. Support configurable seasonality profiles (weekly, monthly, quarterly, annual, event-driven).
- **FR-D-04 - Promotional and Event Overlay:** Allow manual adjustment of forecasts to account for planned promotions, marketing campaigns, product launches, and discontinuations.
- **FR-D-05 - Collaborative Forecasting:** Enable input from sales, marketing, and key customers into the demand forecast. Track forecast vs. actual and forecast accuracy metrics.
- **FR-D-06 - New Product Introduction Forecasting:** Support demand forecasting for new products using analogies to similar existing products, market intelligence, and phased rollout plans.
- **FR-D-07 - Replenishment Planning:** Translate demand forecasts into replenishment plans considering lead times, order cycles, minimum order quantities, and safety stock targets. Generate recommended purchase orders.
- **FR-D-08 - Inventory Optimization:** Calculate optimal inventory levels balancing carrying costs against stockout costs. Recommend inventory redistribution between locations.

### 3.7 Logistics and Transportation Management

- **FR-L-01 - Carrier Management:** Centralized carrier registry with service levels, shipping rates, lane capabilities, and performance history. Contract rate management.
- **FR-L-02 - Shipment Planning:** Consolidate outbound orders into shipments. Optimize loads for cost, transit time, and carrier capacity. Support multi-stop and multi-modal shipments.
- **FR-L-03 - Freight Rate Shopping:** Compare rates across contracted carriers and spot market options at the time of shipment creation. Recommend the optimal carrier based on cost, service level, and delivery commitment.
- **FR-L-04 - Shipment Tracking:** Track shipment status from pickup through delivery. Integrate with carrier tracking APIs for real-time status updates. Generate proactive delay alerts.
- **FR-L-05 - Freight Audit and Payment:** Audit carrier invoices against contracted rates and actual services performed. Flag discrepancies. Approve and process freight payments.
- **FR-L-06 - Fleet Management (if applicable):** Manage owned or leased fleet - vehicle registry, maintenance schedules, driver assignments, fuel tracking, and route planning.
- **FR-L-07 - Import/Export Documentation:** Generate required documentation for international shipments - commercial invoices, packing lists, certificates of origin, customs declarations.
- **FR-L-08 - Returns Logistics:** Manage reverse logistics for customer returns, supplier returns, and inter-location transfers. Track return shipments and link to RMA records.

### 3.8 Reporting and Analytics

- **FR-R-01 - Executive Dashboard:** High-level KPIs - inventory turns, fill rate, order accuracy, on-time delivery, procurement spend, stockout rate, forecast accuracy - with drill-down capability.
- **FR-R-02 - Operational Dashboards:** Role-specific dashboards for warehouse managers (productivity, accuracy, throughput), procurement officers (PO cycle time, supplier performance, spend under management), and demand planners (forecast accuracy, inventory health).
- **FR-R-03 - Inventory Reports:** Stock status, aging, turnover, ABC classification, excess and obsolete, stock valuation, and transfer history.
- **FR-R-04 - Procurement Reports:** Spend by supplier/category/location, PO cycle time, contract compliance, supplier scorecards, and tender outcome summaries.
- **FR-R-05 - Order Fulfillment Reports:** Order cycle time, fill rate, backorder aging, return rate, and fulfillment location performance.
- **FR-R-06 - Exception Alerts:** Configurable alerts for critical events - stockout risk, overdue POs, quality rejection spikes, forecast deviation exceeding threshold, shipment delays.
- **FR-R-07 - Ad-Hoc Reporting:** Self-service report builder allowing users to create custom reports with drag-and-drop field selection, filtering, grouping, and charting. Export to Excel, PDF, CSV.
- **FR-R-08 - Scheduled Reports:** Configure automated report generation and distribution by email on defined schedules (daily, weekly, monthly) with recipient lists.

### 3.9 R&D Centre and Maker-Hub Materials Management

The R&D centre and the maker-hub move materials in ways production logic gets wrong: issues that build prototypes instead of filling orders, equipment that is lent rather than consumed, and retail-style sales to members at the moment of use. This section defines those workflows operationally; wherever a flow touches the books - project cost, phase-based treatment, hub billing, prototype capitalization - the treatment sits in FR-AC and FR-FA, not here.

- **FR-RD-01 - R&D and Maker-Hub Store Location Types:** The system shall support R&D store and maker-hub store as first-class location types, each with its own stock ledger participating in transfers (FR-W), valuation (FR-I-05), and reorder planning (FR-I-03). Every movement records the acting user, timestamp, and source document, and appears in a per-location stock ledger report.
- **FR-RD-02 - R&D-Designated Stock Flag:** The system shall flag items and lots as R&D-designated, block their issue to production orders, and block production stock issue to R&D projects without an approved reclassification transaction. Reclassification requires store-keeper entry plus one approval and posts an event for treatment under FR-AC; the flag is operational separation only.
- **FR-RD-03 - R&D Project Master:** The system shall maintain R&D projects with project code, owner, phase tag (research or development), material budget, dates, and status. Phase changes require an approver and effective date and are written to the immutable audit log (NFR-SEC-04), because the phase tag drives treatment under FR-AC. No material transaction shall post without an active project code.
- **FR-RD-04 - Requisition with Budget Check:** A researcher shall raise a material requisition (extending FR-P-04) against a project code; the system checks committed-plus-actual cost against the project material budget at submission. Requisitions that breach budget route to the project owner and R&D head for approval; without approval, issue is blocked.
- **FR-RD-05 - Issue Types with Distinct Semantics:** The system shall support three R&D issue types: consumable issue (stock decremented, no return expected), project material issue (accumulates to project WIP per FR-RD-07), and equipment custody issue (loan per FR-RD-06). The item master carries a default issue type; the store keeper confirms the type at issue and the transaction records it.
- **FR-RD-06 - Equipment Custody Register:** An equipment custody issue shall record the named custodian, expected return date, and condition at issue; the item stays on the store ledger with status "on loan" and is never consumed. Returns record a condition code, and the custody register lists open loans with overdue aging (overdue = past expected return date).
- **FR-RD-07 - Project WIP Accumulation:** Each project material issue shall post quantity and cost to a per-project WIP ledger; returns under FR-RD-12 reverse it. Users see WIP quantity and cost per project in real time, and the ledger feeds project cost treatment under FR-AC.
- **FR-RD-08 - Prototype Build Records:** The system shall record each build attempt against a project: materials drawn from project WIP, machine hours, builder, and outcome (completed, failed, abandoned). Failed and abandoned builds keep their full material history for cost and learning review.
- **FR-RD-09 - Prototype Registration:** A completed build shall register the prototype as a serialized item (FR-I-04) in a non-saleable inventory class linked to its project and build record. The system blocks sales orders and dispatch for this class.
- **FR-RD-10 - Prototype Disposition:** The system shall support four disposition paths for a registered prototype: retain as test rig or demo (hand-off to fixed assets under FR-FA), transfer to production as reference, teardown (FR-RD-11), or scrap to FR-SC. Each disposition requires R&D head approval and creates a disposition record that closes the prototype serial.
- **FR-RD-11 - Teardown and Component Recovery:** A teardown shall list recovered components and return each to stock with a condition code (new, used-serviceable, degraded, scrap); scrap-coded lines route to FR-SC. Recovered-value treatment is FR-AC's lane; this requirement covers the physical return only.
- **FR-RD-12 - Unused Material Returns:** A researcher shall return unused project material to the R&D store on a return document referencing the original issue and project code, with a condition code per line. Accepted returns reverse project WIP for the returned quantity and appear in a returns-by-project report.
- **FR-RD-13 - Hub Member and Customer Records:** The system shall maintain maker-hub member records (membership status, machine authorizations, billing account) and walk-in customer records. Every hub booking, sale, and job card references exactly one member or customer.
- **FR-RD-14 - Machine-Time Booking and Usage Capture:** Members shall book machine time on a per-machine calendar; the hub operator closes each booking with actual start, stop, and meter reading. Usage readings feed maintenance scheduling under FR-M; bookings unclosed after 24 hours appear on an exception report.
- **FR-RD-15 - Point-of-Use Material Sale:** The hub operator shall sell hub-store materials at the moment of use, decrementing the hub stock ledger and billing the member or customer account at the applicable price list. Invoicing and GST treatment follow FR-AC. Sale capture works offline and syncs per NFR-U-05.
- **FR-RD-16 - Member Job Cards:** The system shall open a job card per member project, collecting that member's bookings, machine hours, and material purchases, and produce a job card statement on demand and at month end.
- **FR-RD-17 - Hub Replenishment:** Hub store items shall carry reorder points and quantities under FR-I-03, with consumption from point-of-use sales and internal use driving replenishment requisitions to the serving warehouse (FR-W) or purchase (FR-P).
- **FR-RD-18 - Physical Verification of R&D and Hub Stores:** The store keeper shall run monthly cycle counts at the hub store and quarterly full counts plus high-value cycle counts at the R&D store, reusing the FR-I-06 workflow; custodians confirm on-loan equipment in the same quarterly exercise. Count variance reports go to the R&D head and hub manager; the statutory verification driver sits with FR-AC.
- **FR-RD-19 - Project Material Cost Reporting:** The system shall report material cost per project, period and cumulative: issues, less returns, plus consumables, reconciled line-for-line to the R&D store stock ledger. This report is the feed for R&D cost treatment under FR-AC.
- **FR-RD-20 - Walk-In Payment Capture at Hub:** For walk-in hub sales (extending FR-RD-15), the system records payment at point of sale via integrated UPI dynamic QR or card terminal, stores the gateway reference against the invoice, and supports end-of-day reconciliation of collections against invoices. Settlement accounting remains in the ERP (A-02).

### 3.10 Bill of Materials Management

Bill of Materials management defines the structure records that production, R&D, and job-work execution consume. It extends FR-I-09 from an inventory-level kitting view to a governed engineering record: FR-I-09 transactions continue to execute assembly and disassembly, but every structure they execute must reference a BOM version defined and controlled here. Two regimes apply: production BOMs are controlled records changed only through engineering change orders; R&D BOMs are draft records built for iteration speed and promoted to production through a gate.

- **FR-B-01 - Multi-Level BOM Record:** Maintain BOMs as versioned records with a header (parent item, plant or location applicability, BOM type: production, R&D, or kit, lifecycle state) and lines (component or subassembly, quantity-per, UoM with conversion to the component's stocking UoM, per-line scrap or yield percentage, line-level effectivity). Support explosion to any depth with single-level, indented, and summarized views.
- **FR-B-02 - Supersession of FR-I-09 Kit Definitions:** This module is the definition record for all kit and assembly structures; FR-I-09 assembly and disassembly transactions execute only against a Released BOM version defined here. Existing FR-I-09 kit definitions migrate as single-level production BOMs at go-live.
- **FR-B-03 - Version Control and Effectivity:** Each change to a Released BOM creates a new revision with non-overlapping date effectivity; a work order or kit transaction explodes the revision effective on its scheduled start date. Released revisions are immutable; corrections require a new revision through an ECO (FR-B-04). Retain full revision history with user, timestamp, and ECO reference.
- **FR-B-04 - Engineering Change Order Workflow:** Provide an ECO record carrying reason code, affected BOMs and items, proposed line changes, disposition of on-hand and in-process stock (use-as-is, rework, or scrap; scrap dispositions post to FR-SC), effectivity date, and role-based approval routing. ECO states: Draft, Under Review, Approved, Implemented, Cancelled; only Implemented ECOs alter a Released BOM.
- **FR-B-05 - Where-Used and Impact Analysis:** For any item, generate a where-used report across all BOM levels and types, including open work orders, R&D builds, job-work kits, open purchase orders (FR-P), and on-hand stock (FR-I). ECO approval screens display this report for every affected item before an approval can be recorded.
- **FR-B-06 - Production BOM Lifecycle States:** Production BOMs carry states Draft, Released, On Hold, and Obsolete, with logged transitions. Release requires every line to reference a released item master, all scrap percentages populated, a completed cost rollup (FR-B-15), and ECO approval; work orders cannot be created against Draft, On Hold, or Obsolete versions.
- **FR-B-07 - BOM Explosion to Execution:** Production-order release (FR-MO-03) explodes the effective Released BOM into the order's material requirement list, which drives picking (FR-W) and either directed issue or backflush consumption on operation or receipt confirmation, using scrap-adjusted quantity-per. FR-D-07 replenishment planning applies the same explosion logic to planned and released orders to derive dependent component demand. Released BOM versions replicate to each plant's execution store so issue and backflush continue during a central-system outage, with transactions replayed on reconnection (FR-MO-13).
- **FR-B-08 - Consumption Variance Reporting:** On production-order closure (FR-MO-12), produce a variance report per component comparing scrap-adjusted standard consumption to actual issues, in quantity and value, with tolerance flags configurable per item class. Expected-scrap quantities post to FR-SC for reconciliation against recorded scrap; value variances route to FR-AC for accounting treatment. Weighed-actual scrap history from FR-SC-05 feeds a periodic recalibration review of per-line scrap percentages, actioned through an ECO (FR-B-04).
- **FR-B-09 - R&D Draft BOM Regime:** R&D BOMs are Draft-state records editable in place without an ECO, permitting unreleased items, placeholder one-off items, and free-text lines; each save increments a minor iteration number with retained history. R&D BOMs cannot drive production work orders or FR-I-09 kit transactions.
- **FR-B-10 - Clone and As-Built Snapshot:** Any production BOM version can be cloned into an R&D draft with lineage recorded. On completion of each prototype or pilot build, capture an immutable as-built BOM snapshot of actual components, lots or serials, and quantities consumed, linked to the FR-RD build record; deviations from the draft BOM are flagged line by line.
- **FR-B-11 - Productization Gate:** Promotion of an R&D BOM to production requires a gate checklist record: every placeholder replaced with a released item master, make-or-buy flag set per line, scrap percentage assigned per line, cost rollup executed, QC specification linkage confirmed per FR-Q, and sign-offs from engineering, procurement (FR-P), and QC (FR-Q). Passing the gate creates production BOM version 1 in Draft state, released per FR-B-06, with lineage to the source R&D BOM and its as-built snapshots.
- **FR-B-12 - Alternates and Substitutes:** Support per-line approved alternates with priority ranking and their own effectivity; issuing an alternate records a substitution event on the work order and in the consumption record. Ad-hoc substitution of a non-approved item requires a logged approval before issue.
- **FR-B-13 - Phantom Assemblies:** Support phantom subassemblies whose explosion passes directly through to their components, generating no stocking requirement and no separate work order, while preserving the phantom level in indented views and where-used results.
- **FR-B-14 - Co-Products and By-Products:** BOM output lines define co-products and by-products with expected yield percentages; production receipt posts them into inventory (FR-I) as distinct items. By-products classified as scrap or sellable waste post to FR-SC; cost allocation between outputs follows FR-AC.
- **FR-B-15 - Cost Rollup and Costed-BOM Comparison:** Roll up material cost through all levels using item rates synced per INT-ERP-01, applying per-line scrap percentages, and store each run as a dated costed-BOM snapshot. Compare any two snapshots, across versions or dates, with line-level deltas. Rollups are simulations; standard cost setting and inventory valuation remain in the ERP under FR-AC.
- **FR-B-16 - Job-Work and Service Kit BOMs:** Kit-type BOMs for customer fabrication and job-work orders mark each line as company-supplied, customer-supplied, or job-worker-supplied, and generate the dispatch kit list and expected-return quantities including scrap allowance. Sent-versus-consumed-versus-returned reconciliation posts shortfalls to FR-SC; GST documentation and treatment for materials moved to or from job workers follows FR-AC.
- **FR-B-17 - BOM System of Record and ERP Sync:** This module is the record of truth for BOM structure, revisions, and lifecycle state; INT-ERP-01 publishes Released production BOM versions outbound and consumes item cost rates inbound. Inbound structural edits from the ERP do not overwrite records here; sync conflicts create an exception record for the BOM Administrator to resolve.

### 3.11 Maintenance and Calibration Management

Every asset the company runs - production machines, R&D laboratory equipment, maker-hub machines used hard by non-employees, material-handling equipment, weighbridges, and utility plant - earns only while it is up, in calibration, and legally certified. This section defines preventive and breakdown maintenance, MRO spares, service contracts, calibration and statutory compliance, maintenance cost capture (accounting treatment stays with FR-FA/FR-AC), and the machine-status signals that production planning and maker-hub booking consume.

- **FR-M-01 - Maintainable Asset Register:** Maintain a maintenance record for every maintainable asset company-wide - production machines, R&D lab equipment, maker-hub machines, material-handling equipment (forklifts, stackers, hoists, cranes), weighbridges, and utility plant (compressors, DG sets, chillers, HVAC) - with location, owning department, criticality class (A/B/C), meter type, and the fixed-asset ID from the FR-FA register where one exists. Low-value tools without a fixed-asset entry remain maintainable. Every asset carries a scannable QR/asset tag.
- **FR-M-02 - Preventive Maintenance Plans:** Support calendar-based (e.g., quarterly) and meter-based (e.g., every 250 machine-hours) PM plans per asset with task checklists and required spares. The system generates PM work orders automatically at a configurable lead time before due and tracks completion within a defined grace window.
- **FR-M-03 - Usage Meter Feeds:** Maintain a usage meter per metered asset, fed automatically from maker-hub booking and usage records (FR-RD) and from station equipment via INT-DC-03, plus manual mobile readings for MHE and DG sets. Manual and automatic readings reconcile monthly; a meter silent beyond a configurable period raises an alert to the maintenance planner.
- **FR-M-04 - Fault Reporting by Anyone:** Any user - operator, storekeeper, gate guard, or maker-hub front desk on behalf of a member - can raise a fault report by scanning the asset tag, capturing symptom, photo, and a safety flag. The report reaches the maintenance supervisor for that location within 5 minutes.
- **FR-M-05 - Breakdown Work-Order Lifecycle:** Manage work orders through Reported, Assigned, In Repair, Awaiting Parts, Awaiting Vendor, Completed, and Closed states, every transition timestamped and attributed. Priority derives from asset criticality class and the safety flag; response and restore SLAs are configurable per priority.
- **FR-M-06 - Downtime, MTTR, MTBF:** Record downtime per asset from fault report (or machine-stop signal) to return-to-service, categorized as breakdown, planned PM, awaiting parts, or awaiting vendor. Compute MTTR and MTBF per asset and per asset class monthly.
- **FR-M-07 - Spares Catalogue and Where-Used:** Catalogue MRO spares as inventory items under FR-I with a where-used mapping to assets, so a technician opening a work order sees the spares list, stock on hand, and bin location for that asset. Where-used draws on the equipment BOM structures in FR-B rather than a parallel list.
- **FR-M-08 - Spares Reservation, Issue, and Return:** Reserve spares against a work order, issue from stores against the work-order ID through FR-W issue flows, and return unused spares within 3 working days of closure. Replaced defective parts route to the disposal stream under FR-SC, tagged with source asset and work order.
- **FR-M-09 - Critical-Spares Min-Max:** Flag critical spares by asset criticality; flagged items carry min-max reorder control per FR-I-03. A breach of minimum or stockout on a critical spare alerts the maintenance planner and procurement (FR-P) the same day.
- **FR-M-10 - AMC, Warranty, and Insurance Records:** Hold AMC, warranty, and insurance records per asset, linked to the vendor in the supplier registry (FR-P-01), with coverage dates, contracted visit schedules, and claim history. Alerts fire at 90/60/30 days before expiry; AMC visit compliance (done vs contracted) is reportable per vendor.
- **FR-M-11 - Warranty Check at Work-Order Creation:** Creating a work order on an asset under warranty or AMC warns the planner before internal labour or spares are booked and captures the vendor claim or visit reference instead. Overriding the warning requires a reason code.
- **FR-M-12 - Calibration Register and Schedules:** Maintain a calibration register for measuring and test instruments on QC benches (FR-Q) and in R&D labs (FR-RD): calibration frequency, method (in-house master or external lab accredited to ISO/IEC 17025, NABL in India), stored certificates with due dates, and alerts at 30/14/7 days before due.
- **FR-M-13 - Out-of-Calibration Lockout:** An instrument past its calibration due date or failed at calibration locks automatically: FR-Q inspection results cannot be recorded against its instrument ID until a passing certificate is uploaded, and the system suggests an in-calibration alternate. No role can override the lockout; escalation expedites calibration, it does not bypass it.
- **FR-M-14 - Statutory Examination and Verification Tracking:** Track statutory examinations per asset with certificates and due dates, periodicity configurable per equipment class so schedules follow the OSH Code, 2020 and state rules as notified (Factories Act, 1948 baseline carried into the Code regime: hoists and lifts 6-monthly under s.28, lifting machines, chains and tackle 12-monthly under s.29), and Legal Metrology re-verification and stamping of weighbridges every 12 months under Rule 27, Legal Metrology (General) Rules, 2011. An overdue statutory item locks the asset out; completing a repair work order on a weighbridge sets it Awaiting Verification and blocks trade weighment (INT-DC-03, INT-GATE-01) until the new stamping certificate is recorded.
- **FR-M-15 - Maintenance Cost per Asset:** Accumulate labour hours at standard rates, spares at issue value, and vendor invoices against each work order, rolled up per asset per month and per location. Closing a work order above a configurable value threshold requires the supervisor to set a repair-vs-capitalize flag; flagged work orders route with full cost detail to FR-FA, where treatment is decided under FR-AC. Maintenance captures data; it posts no accounting entries.
- **FR-M-16 - Machine Status Broadcast:** Publish asset status (Available, Under Maintenance, Locked Out, Awaiting Parts, Awaiting Verification) to production planning and the maker-hub booking calendar within 2 minutes of change; a machine not Available is a blocked booking slot in FR-RD booking flows. Return-to-service requires technician closure plus supervisor sign-off and releases the slot automatically.
- **FR-M-17 - Offline Technician Workflow:** Per NFR-U-05, technicians accept, execute, and close work orders fully offline - time logging, spare scans, photos, checklists, meter readings - in basements, rooftops, and DG yards, with automatic sync and conflict flagging on reconnect.
- **FR-M-18 - Closure Codes and Fix History:** Closing a work order requires a fault code, cause code, and remedy code from controlled lists plus free-text notes. Opening a work order shows the technician the last five closures for the same asset and fault code, so captured fix knowledge flows back to the people who gave it.

### 3.12 Quality Control for Finished Goods

This section governs quality control of finished goods from production plants and of job-work output fabricated for customers, from production-order completion to sellable stock or dispatch. Inbound supplier-goods inspection stays in FR-P-06 and story QC-INSPECT-01; returned-goods inspection stays in FR-O-07; items made by maker-hub members on booked machines are member property and outside this section. The governing rule: no lot reaches sellable finished-goods stock or a dispatch document without a recorded release decision.

- **FR-Q-01 - Versioned Inspection Plans:** The system shall maintain inspection plans per product-specification revision (revision sourced from the product/BOM master, FR-B), each characteristic carrying a class (critical/major/minor), test method (IS/ISO clause or internal SOP reference), instrument type, acceptance limits (numeric tolerance or attribute criteria), and sample-handling instructions. Plan changes require QC Head approval, carry an effective date, and apply only to lots created on or after that date; every recorded inspection stores the plan version used. Job-work orders may attach a customer-specification plan that overrides the standard plan for that order only.
- **FR-Q-02 - Finished-Goods QC Gate:** Production-order completion (plant production and job-work output alike) posts finished stock into a QC Hold status per FR-I-01. Stock in QC Hold is unavailable to sales allocation, dispatch documents, and transfer to sellable finished goods; only a recorded disposition under FR-Q-05 moves it out. The gate has no bypass path - urgency is handled by conditional release, not omission.
- **FR-Q-03 - AQL Sampling Plans:** For lot-by-lot inspection the system shall compute sample size from lot size, inspection level, and the AQL stored on the inspection plan per IS 2500 (Part 1):2000, aligned with ISO 2859-1 (current ISO edition: ISO 2859-1:2026), and shall apply normal/tightened/reduced switching rules from per-product lot acceptance history. Characteristics classed critical require 100% inspection of the lot regardless of the sampling plan. Sampling tables are configuration data, not code, so a standard revision requires no code change.
- **FR-Q-04 - Result Capture with Calibration Lockout:** Inspectors record a measured value or attribute result per characteristic against plan limits; every instrument-based result must reference the instrument's asset ID. The system shall reject result entry when the referenced instrument's calibration is overdue or the instrument is under maintenance hold, using live calibration status from FR-M. Out-of-limit results automatically flag the lot for disposition, and results are locked against edit once the lot is dispositioned (NFR-SEC-04).
- **FR-Q-05 - Disposition and Release Decision:** Each inspected lot receives exactly one recorded disposition by a user holding QC release authority: Accept (QC Hold to Available per FR-I-01), Reject (opens an NCR, stock to Blocked), or Conditional Release (requires a deviation record with justification, scope, expiry date, and a named approver at QC Head level). The disposition record stores inspector, approver, timestamp, plan version, results snapshot, and disposition code, and writes to the immutable audit log (NFR-SEC-04). Partial-lot dispositions with quantity splits are supported (for example accept 1,800, rework 200).
- **FR-Q-06 - NCR Outcomes - Rework, Downgrade, Scrap:** Every NCR closes with a recorded outcome per quantity: Rework (creates a return-to-production order; reworked quantity re-enters the FR-Q-02 gate for full re-inspection), Downgrade (reclassifies quantity to a designated seconds item code, sellable as Available at that grade with grade marking), or Scrap (routes quantity with lot ID, defect codes, and NCR reference to disposal under FR-SC). Inventory value effects of downgrade and scrap post per FR-AC; this section defines the trigger, not the accounting treatment.
- **FR-Q-07 - Batch Release Record and CoA/CoC:** On Accept or Conditional Release the system generates a batch release record per lot: product, lot/serial numbers (FR-I-04), plan version, sample sizes, recorded results, instruments used with calibration-due dates, disposition, deviation reference if any, and signatories. The system prints a Certificate of Analysis or Certificate of Conformance per lot for attachment to dispatch documents. Release-record retention is configurable per product category, default 7 years, and never shorter than the applicable BIS Scheme of Testing and Inspection requirement for licensed products.
- **FR-Q-08 - Retention Samples:** For products flagged retention-sample-required, release is blocked until a retention sample entry exists with quantity, storage location, and retain-until date. The system tracks retention-sample inventory, alerts at retain-until expiry, and routes expired samples to disposal via FR-SC.
- **FR-Q-09 - Quality Hold on Released Lots and Recall Readiness:** Users with QC hold authority can place a recorded quality hold on already-released lots; held stock flips to Blocked (FR-I-01) across all locations and open allocations and dispatch documents against it stop. The system produces a where-used and where-shipped trace for a held lot via FR-I-04 lot genealogy within 15 minutes of hold placement. Hold and hold-release are recorded decisions with reason codes and named approvers; the system recognizes no verbal holds.
- **FR-Q-10 - NCR and CAPA Linkage:** Every NCR carries defect codes from a controlled catalogue and cannot close without an FR-Q-06 outcome. NCRs on critical-class defects, and repeat NCRs (three or more with the same product and defect code within 90 days), require a linked CAPA record with root cause, corrective action, owner, due date, and a recorded effectiveness check before CAPA closure. The CAPA register is reportable by status, owner, and age.
- **FR-Q-11 - Mandatory Certification Hooks (BIS):** The product master flags products under mandatory certification per the BIS (Conformity Assessment) Regulations, 2018: Scheme-I (ISI mark licence under a Quality Control Order) or Scheme-II (Compulsory Registration Scheme for electronics and IT goods). For flagged products the system stores the licence or registration number (CM/L or R-number) with validity dates, blocks release when that licence is expired, suspended, or missing, and maps the inspection plan to the levels of control in the product's Scheme of Testing and Inspection. The batch release record and CoC print the CM/L or R-number.
- **FR-Q-12 - Prototype and Pilot Verification (R&D):** Prototype and pilot builds registered under FR-RD complete through a spec-vs-actual verification capture per characteristic: target value, measured value, deviation note, and verifier identity - design evidence, not a sales release. Prototype stock cannot enter sellable finished-goods status; commercializing a pilot lot requires an approved FR-Q-01 plan and the full FR-Q-02 gate.
- **FR-Q-13 - Quality Reporting:** The system reports first-pass yield (lots and quantity accepted at first inspection over total inspected), rejection rate by defect code, product, line, and plant, NCR and CAPA aging, conditional-release counts by approver, and calibration-lockout events, filterable by period, plant, and product family.
- **FR-Q-14 - Packaged-Commodity Label Compliance:** Every finished good flagged for retail sale as a packaged commodity carries a version-controlled label master per product holding the mandatory declarations of the Legal Metrology (Packaged Commodities) Rules, 2011 as amended - manufacturer or packer name and full address, common or generic name, net quantity in standard units, month and year of manufacture, retail sale price as MRP in rupees inclusive of all taxes, unit sale price where it differs from the retail sale price (Rule 6(11), in force 1 October 2022), and consumer care name, address, telephone and e-mail - and packing (FR-W-05) prints labels only from the current approved version, with the same declaration set except month and year of manufacture exportable for e-commerce listings (Rule 6(10)). The system blocks release of a flagged lot when no current approved label version exists and records the label version used on the batch release record (FR-Q-07). BIS marking under FR-Q-11 is a separate control and is not satisfied by label approval.
- **FR-Q-15 - Customer-Witnessed and Third-Party Inspection:** Where the job-work or made-to-order contract (FR-JW-01) requires customer-witnessed or third-party inspection before dispatch, the inspection plan (FR-Q-01) marks the affected stages as witness points or hold points, and the system schedules each event with recorded notice to the customer or nominated inspection agency (an ISO/IEC 17020:2012 Type A body where the contract requires third party). The system records each event against the lot: attendee name and organization, date, outcome, and the signed inspection report as an attachment. Dispatch stays blocked until every hold point is cleared or a recorded customer waiver (waiving person, organization, date, reference) exists; an unattended witness point proceeds only after documented notice, which the system records.

### 3.13 Scrap, Defectives, and Disposal Management

Scrap is cash lying on the floor, and unwatched scrap walks out the gate. This section governs the full life of scrap and defective material from every generating stream - production, QC rejection, inventory obsolescence, R&D teardown, maintenance replacement, and asset retirement - through classification, weighment, disposition, statutory channels, and sale, ending in reconciliation. It reuses tender mechanics (§3.3) in the sale direction and the gate and weighbridge event model (INT-GATE-01); all valuation, tax, and accounting treatment stays with FR-AC.

- **FR-SC-01 - Source-Linked Scrap Intake:** Every scrap or defective receipt must originate from a source document: production-order process scrap (FR-B), QC rejection (FR-Q), obsolescence disposition from aging flags (FR-I-08), R&D teardown or failed prototype (FR-RD), replaced part from maintenance (FR-M), or retired asset (FR-FA). The system rejects intake without a source reference; each intake line records source document ID, generating cost centre, location, date, and declaring employee.
- **FR-SC-02 - Classification at Intake:** The intake operator assigns each line exactly one class: material-category scrap (ferrous, non-ferrous, plastic, packaging, used oil, mixed), repairable defective, seconds/downgrade, hazardous waste, e-waste, or battery waste. Class determines the permitted bin, disposition routes, and statutory channel; reclassification requires a reason code and writes to the audit log (NFR-SEC-04).
- **FR-SC-03 - Segregated Scrap-Yard Bins:** The system models scrap-yard and quarantine bins as location types under FR-W-01 zones, one bin per material class per site. Hazardous, e-waste, and battery bins are restricted locations; the system blocks put-away of any other class into them and blocks mixed-class put-away generally.
- **FR-SC-04 - Intake Weighment and Photo Evidence:** Intake above a configurable weight threshold uses the weighbridge event model (INT-GATE-01); below threshold, calibrated platform scales identified by device ID. Each intake records weight, at least one photograph, and the weigher's user ID; declared-versus-weighed variance above tolerance raises an exception.
- **FR-SC-05 - Expected-vs-Actual Scrap Reconciliation:** The system reconciles weighed production scrap per production order and per period against BOM expected-scrap percentages (FR-B). Variance beyond a configurable tolerance opens an investigation task assigned to production and the scrap yard custodian and feeds the pilferage indicators in FR-SC-21.
- **FR-SC-06 - Defective Disposition Workflow:** Each repairable defective carries one open disposition decision: repair-and-return, refurbish-and-downgrade to seconds, cannibalize for spares, or condemn to scrap. Items undecided beyond a configurable age escalate to the disposal committee; every decision records the decider and links to the source document.
- **FR-SC-07 - Cannibalization and Component Recovery:** When an item is cannibalized, recovered components return to stock as distinct lots linked to the donor item ID, with valuation fields routed to FR-AC; the residual carcass moves to a scrap bin by weight. Recovery from prototypes references the FR-RD project record.
- **FR-SC-08 - IP-Sensitive Scrap Controls:** Lots flagged IP-sensitive at intake (failed prototypes per FR-RD, branded rejects per FR-Q, tooling) require defacement or destruction before any sale, evidenced by photo or video and a destruction certificate stored against the lot. The system blocks auction listing of an IP-sensitive lot until the defacement record exists.
- **FR-SC-09 - NRV Valuation Fields:** Each lot carries estimated net realizable value, rate source (market reference or last-auction rate), valuation date, and valuer identity; asset-derived lots also reference the FR-FA asset record. Write-down and disposal gain or loss treatment follows FR-AC.
- **FR-SC-10 - Disposal Approval with DOA Limits:** A disposal proposal (sale, statutory channel, or destruction) routes for approval by estimated lot value through the enterprise delegation-of-authority registry (FR-DOA-01); proposals above the top band require the disposal committee with recorded quorum. Proposer, approver, and stock custodian must be three different users (NFR-SEC-05), and every decision writes to the immutable audit log (NFR-SEC-04).
- **FR-SC-11 - Buyer Registration and Blacklisting:** The buyer master captures legal name, GSTIN or unregistered status, PAN, EMD refund bank account, and, for regulated categories, the buyer's SPCB hazardous-waste authorization or CPCB EPR portal registration with number and validity date. Blacklisting records reason and period and blocks the buyer from invitations, bids, and awards.
- **FR-SC-12 - Lot Creation and Reserve Price:** The disposal officer builds lots from bin stock with material class, weight, photographs, location, and inspection window. Each lot carries a reserve price approved under the FR-SC-10 matrix and kept sealed until bid opening.
- **FR-SC-13 - Auction via Tender Mechanics in Reverse:** Scrap sale reuses §3.3: buyer invitation per FR-T-02, bid submission through the portal per FR-T-03, controlled bid opening per FR-T-04, and award approval per FR-T-05 and FR-T-06, with highest-price-above-reserve as the evaluation rule. Both open e-auction and sealed-bid modes are supported; a below-reserve or single-bid outcome routes to the disposal committee for re-auction or negotiated approval.
- **FR-SC-14 - EMD Collection, Refund, and Forfeiture:** The system records EMD per bidder per lot with payment reference, queues refunds to losing bidders within a configurable number of days after award, and adjusts or forfeits the winner's EMD on lifting default per lot terms. Forfeiture events route to FR-AC for treatment.
- **FR-SC-15 - Payment Before Lifting:** The system blocks gate-pass issue until receipted payment covers the awarded value plus taxes computed per FR-AC, recognizing buyer-side GST-TDS on metal scrap as part of consideration per FR-AC rules. Part lifting is allowed only where lot terms permit and only against proportional payment.
- **FR-SC-16 - Lifting, Exit Weighment, and Gate Pass:** Buyer lifting is slot-scheduled; each vehicle takes tare and gross weighment per INT-GATE-01 with loaded-vehicle photographs. Gate-pass quantity must reconcile to invoiced quantity within tolerance; excess weight blocks exit, alerts security and the disposal officer, and logs the event (NFR-SEC-04). The system selects a configurable percentage of vehicles for supervised random re-weighment.
- **FR-SC-17 - Sale Documents and Statutory Fields:** Each sale generates a GST tax invoice with HSN, weighed quantity, and vehicle reference; captures TCS where applicable under section 394(1) of the Income-tax Act, 2025 (successor to section 206C(1) of the 1961 Act); and raises an e-way bill trigger event carrying transporter and vehicle fields. Rates, thresholds, and applicability rules are owned by FR-AC.
- **FR-SC-18 - Hazardous Waste Channel:** Hazardous waste moves only to SPCB-authorized recyclers or treatment, storage and disposal facilities, accompanied by a Form 10 manifest under the Hazardous and Other Wastes (Management and Transboundary Movement) Rules, 2016. The system tracks the Rule 8 ninety-day on-site storage limit per bin with escalation before expiry, validates the receiver's authorization before dispatch, and stores signed manifest copies against the lot.
- **FR-SC-19 - E-Waste, Battery, and Non-Ferrous EPR Channels:** E-waste moves only to entities registered on the CPCB EPR portal under the E-Waste (Management) Rules, 2022; waste batteries move only to registered recyclers under the Battery Waste Management Rules, 2022 as amended in 2025; non-ferrous metal scrap disposals capture the EPR documentation introduced by the 2025 Second Amendment to the 2016 hazardous waste rules, in force from 1 April 2026. The system blocks award of a regulated lot to a buyer without valid registration on file and stores portal acknowledgments against the lot.
- **FR-SC-20 - Write-Off, Destruction, and ITC-Reversal Trigger:** Zero-recovery destruction requires FR-SC-10 approval, a named witness, photo or video evidence, and a destruction certificate. Completion auto-notifies FR-AC as an ITC-reversal evaluation trigger and, for asset-derived items, FR-FA for derecognition.
- **FR-SC-21 - Reconciliation and Pilferage Reporting:** A period report per material class per location reconciles generated (source documents) versus weighed intake versus on-hand versus sold or disposed quantity, and realized recovery value versus approved NRV. Variances beyond tolerance flag as pilferage indicators and open investigation tasks; internal audit holds read-only access.
- **FR-SC-22 - Plastic Packaging EPR Data:** The system shall record plastic packaging consumption by weight per EPR category (Category I rigid, Category II flexible, Category III multilayered, Category IV compostable and biodegradable) from BOM packing data (FR-B-14) and packing material issues (FR-W-05), by GSTIN and financial year, including recycled-content percentage per pack, sufficient to prepare annual returns on the CPCB Centralised EPR Portal for Plastic Packaging under the Plastic Waste Management Rules, 2016 as amended through the PWM (Amendment) Rules, 2026 (G.S.R. 237(E), 31-03-2026). It shall store portal registrations, filed returns (due 30 June following the obligation year), EPR certificate transactions, and acknowledgments per NFR-SEC-05.

### 3.14 Fixed Assets, Intangible Assets, and Depreciation

The SCM system maintains the operational fixed-asset subledger; the ERP general ledger remains the system of record per A-02, and every financial figure computed here posts through the INT-ERP/INT-ACC family. Machines move between production plants, the R&D centre, and the maker-hub, so asset location, cost centre, and custodian integrity drive depreciation allocation, GST document duty, and audit evidence. All quantitative records must support CARO 2020 clause 3(i) reporting and Schedule III (Division II) disclosure extracts.

- **FR-FA-01 - Asset Master Record:** Maintain one record per asset with asset class, description, location, cost centre, custodian, physical tag ID (barcode or QR), capitalization date, cost, and links to originating PO, GRN, and supplier invoice. Support parent-child structures for component assets. Quantitative details and situation of assets must be extractable for CARO 2020 clause 3(i)(a).
- **FR-FA-02 - Capitalization from Procurement:** Route capital-flagged PO receipts (FR-P-05, FR-P-06) into a capital-work-in-progress record, accumulate directly attributable costs, and capitalize on the date the asset is in the location and condition necessary to operate as management intends (Ind AS 16). Depreciation begins when the asset is available for use (Ind AS 16 para 55), not when first operated.
- **FR-FA-03 - CWIP Ageing and Project Status:** Report CWIP split between projects in progress and projects temporarily suspended, aged in Schedule III buckets (under 1 year, 1-2 years, 2-3 years, over 3 years), and flag projects overdue or over cost against their approved plan with expected completion dates.
- **FR-FA-04 - Component Accounting:** Record parts of an asset whose cost is significant relative to the whole as separate components with their own useful lives and depreciation (Ind AS 16 para 43; Schedule II carries a matching component requirement). Treat capitalized major inspections and overhauls as components.
- **FR-FA-05 - Useful Lives and Residual Values:** Default useful life and residual value (maximum 5 percent) per asset class from Companies Act 2013 Schedule II, and permit deviation only with a recorded technical justification and approver, since Schedule II requires disclosure of any difference. Store the justification with the asset record for the statutory auditor.
- **FR-FA-06 - Depreciation Run:** Support SLM and WDV per asset class, compute period depreciation pro rata from the available-for-use date by cost centre, and post approved runs to the ERP GL via INT-ERP-02. Provide a preview-and-approve step before posting; reversals require a logged correction run.
- **FR-FA-07 - Dual Depreciation Views:** Maintain a Companies Act books view and a separate income-tax view (block-of-assets WDV under s.32 of the Income-tax Act 1961, as carried into its successor provision in the Income-tax Act 2025, in force from 1 April 2026). The tax view is report-only and never posts to the ERP.
- **FR-FA-08 - Transfers and Redeployment:** Record effective-dated transfers of location, cost centre, and custodian, including production to R&D to maker-hub redeployment, and reallocate depreciation to the receiving cost centre prospectively from the transfer date. Inter-state movements between GSTINs trigger the FR-AC-10 document flow before dispatch.
- **FR-FA-09 - Subsequent Expenditure:** Capitalize additions and improvements only where Ind AS 16 recognition criteria are met; expense all other subsequent costs. Record the decision, decider, and basis on the source document.
- **FR-FA-10 - Repair-vs-Capitalize Queue:** Route every closed FR-M work order carrying the repair-vs-capitalize flag to an accounting review queue with cost and parts detail. On a capitalize decision, create the component (FR-FA-04) and derecognize the carrying amount of the replaced part (Ind AS 16 para 13); on an expense decision, post to repairs and maintenance. No flagged work order may remain undecided at period lock.
- **FR-FA-11 - Impairment Hooks:** Capture impairment indicators (physical damage, prolonged idleness, obsolescence, planned discontinuation) against assets per Ind AS 36, flag them for impairment assessment, and record any impairment loss for posting to the ERP with the assessment document attached.
- **FR-FA-12 - Retirement and Disposal:** Process retirement through approval into the FR-SC disposal workflow (auction sale, scrap, write-off), compute profit or loss on disposal as net proceeds less carrying amount on derecognition (Ind AS 16 paras 67-72), and post the result to the ERP. Link the disposal record to the tax documents generated under FR-AC-09.
- **FR-FA-13 - Physical Verification:** Support a physical verification programme at management-defined reasonable intervals per CARO 2020 clause 3(i)(b), executed by mobile tag scanning that works offline (NFR-U-05), producing a variance report, an approved reconciliation of discrepancies into the records, and retained evidence per round.
- **FR-FA-14 - Asset Audit Trail:** Log every change to asset master and financial fields (cost, life, residual value, cost centre, status) immutably with user, timestamp, and before-after values, under NFR-SEC-04 as extended by FR-AC-13.
- **FR-FA-15 - Intangible Asset Register:** Maintain intangible asset records (capitalized development, acquired software and licences) separate from tangible PPE, holding cost, useful life, amortization method, residual value (assumed zero unless an Ind AS 38 para 100 exception applies), and a link to the FR-AC-02 capitalization evidence against the Ind AS 38 para 57 criteria.
- **FR-FA-16 - IAUD Ledger and Schedule III Ageing:** Accumulate FR-AC-02-approved development spend, fed project-wise by FR-RD-19, into an Intangible Assets Under Development ledger, and produce the Schedule III (Division II) ageing in buckets of less than 1 year, 1-2 years, 2-3 years, and more than 3 years, split between projects in progress and projects temporarily suspended, plus the completion schedule for projects overdue or over budget, mirroring FR-FA-03 for CWIP.
- **FR-FA-17 - Capitalization and Amortization:** On project completion, transfer the IAUD balance to the intangible register, assign a finite useful life and an amortization method reflecting the consumption pattern with straight-line as default where that pattern is not reliably determinable, and begin amortization when the asset is available for use (Ind AS 38 para 97). Support an indefinite-useful-life flag that suppresses amortization (para 107).
- **FR-FA-18 - Annual Reviews:** Prompt a review at least at each financial year-end of the amortization period and method for finite-life intangibles (Ind AS 38 para 104) and of every indefinite-life assessment, applying changes prospectively as changes in estimate.
- **FR-FA-19 - Impairment Extension:** Extend the FR-FA-11 impairment workflow to intangibles and IAUD, enforcing the annual test irrespective of indicators for indefinite-life intangibles and for intangibles not yet available for use (Ind AS 36 para 10).
- **FR-FA-20 - Derecognition and Write-Off:** Derecognize an intangible on disposal or when no future economic benefits are expected, recognizing the gain or loss in profit or loss and never as revenue (Ind AS 38 paras 112-113), and route abandoned IAUD projects through an approval-gated write-off recorded in the FR-AC-13 edit log.

### 3.15 R&D Accounting Separation and Statutory Compliance

One legal entity runs four business streams - manufacturing, R&D, maker-hub retail, and job-work services - across multiple states and GSTINs, and this subledger is where their costs first mix or stay separable. Every inventory and asset transaction must therefore carry the tags, documents, and locks that Ind AS, the Companies Act 2013, GST law, and the Income-tax Act 2025 demand, because the ERP can only post what this system captures correctly at source.

- **FR-AC-01 - Business-Stream Tagging:** Require every inventory issue, receipt, and transfer to carry a business stream (production, R&D project, maker-hub, job-work), cost centre, and where applicable the FR-RD project code. Block posting of untagged transactions.
- **FR-AC-02 - Research vs Development Classification:** Classify material issues to R&D projects by the FR-RD project phase tag: research-phase issues post as expense (Ind AS 38 paras 54-55); development-phase issues may post as capitalizable only after a completed checklist evidencing all six recognition criteria of Ind AS 38 para 57 with a named approver and approval date stored on the project.
- **FR-AC-03 - No Retroactive Reinstatement:** Prevent reclassification of any cost expensed during the research phase into the capitalized development pool after the phase switch (Ind AS 38 para 71). The phase-switch date is locked once approved and changes require a logged reversal with reason.
- **FR-AC-04 - R&D Project Cost Ledger:** Maintain project-wise R&D cost ledgers separate from production cost centres, split capital versus revenue spend, and produce DSIR-recognition and Form 3CL-ready project statements supporting the deduction under s.35, Income-tax Act 1961 (the weighted deduction under s.35(2AB) stands reduced to 100 percent since AY 2021-22) and its successor provision in the Income-tax Act 2025.
- **FR-AC-05 - Permitted Cost Formulas:** Offer FIFO and weighted average cost only (Ind AS 2 para 25), specific identification for items not ordinarily interchangeable (paras 23-24), and standard cost solely as a measurement technique where periodic variance review shows it approximates actual cost (para 21). Enforce one formula for all inventories of similar nature and use across the entity; location alone does not justify a different formula.
- **FR-AC-06 - NRV Testing and Write-Down:** Run period-end net realizable value testing, execute write-downs to NRV with approval and reason codes (Ind AS 2 paras 28-33), tie the workflow to FR-I-08 slow-moving identification, and permit reversal only up to the original write-down when circumstances change.
- **FR-AC-07 - Input Tax Credit Register:** Track ITC on inputs and capital goods per GSTIN, linked to GRN, supplier invoice, and supplier IRN through the FR-P-07 three-way match, so every credit in the ERP traces to goods actually received.
- **FR-AC-08 - ITC Reversal on Write-Off:** On any FR-SC write-off or destruction event, compute the ITC reversal required under s.17(5)(h) CGST Act (goods lost, stolen, destroyed, or written off) from the original credit references and route the reversal note to the ERP before the disposal record closes.
- **FR-AC-09 - Scrap Sale Tax Events:** Generate for each FR-SC scrap or auction sale an outward supply record with GST classification, e-invoice request where the buyer is registered (entity turnover exceeds the Rs 5 crore e-invoice threshold), e-way bill above Rs 50,000, and TCS capture on scrap under s.394(1), Income-tax Act 2025 (successor to s.206C(1) of the 1961 Act), with rates held as dated configuration rather than code. Note that s.206C(1H) TCS on sale of goods stands omitted since 1 April 2025.
- **FR-AC-10 - Branch Transfers Between GSTINs:** Treat inter-state stock transfers between the company's own GSTINs as taxable supplies between distinct persons (Schedule I para 2, CGST Act), generating tax invoice with Rule 28 valuation (open market value, the 90 percent option, or cost plus 10 percent), e-invoice, and e-way bill before dispatch.
- **FR-AC-11 - Job-Work Movements:** Issue delivery challans (Rule 45, CGST Rules) for goods sent to and received from job workers under s.143, track return clocks of one year for inputs and three years for capital goods with escalating alerts, post deemed-supply tax events on breach, and produce ITC-04 data at the prescribed periodicity (half-yearly above Rs 5 crore turnover, annually otherwise).
- **FR-AC-12 - Maker-Hub B2C Sales:** Record point-of-use material sales to members as B2C supplies with GST tax invoices at item rates, separated from machine-time charges which are services, and print the dynamic QR code on B2C invoices if aggregate turnover exceeds Rs 500 crore. Maker-hub sales must never post as miscellaneous income.
- **FR-AC-13 - Statutory Edit Log:** Because this system's records feed the books of account, implement the audit-trail proviso to Rule 3(1), Companies (Accounts) Rules 2014 (effective FY 2023-24): an edit log of every change with the date of change, tamper-proof, incapable of being disabled, retained per the books-retention period, and reportable by the statutory auditor under Rule 11(g), Companies (Audit and Auditors) Rules 2014. This extends NFR-SEC-04.
- **FR-AC-14 - IRN-Before-Dispatch Control:** Block dispatch confirmation for any supply requiring e-invoicing until the IRN and signed QR are received, and enforce the 30-day IRP reporting window applicable at turnover of Rs 10 crore and above (in force since 1 April 2025).
- **FR-AC-15 - Period-End Close:** Provide period locks with cutoff controls (no back-dated postings into a locked period without a logged reopening approval), GRNI ageing feeding INT-ACC-03, a subledger-to-ERP-GL reconciliation report by location and stream, and a physical-verification evidence pack meeting CARO 2020 clause 3(ii)(a) including the 10-percent-by-value discrepancy test per inventory class.
- **FR-AC-16 - Funding-Source Tagging on R&D Projects:** Each R&D project can be tagged with one or more funding sources (internal, DSIR, DST, other grant) with grant reference and sanction details; all project cost ledger entries (FR-AC-04) carry the tag so the ERP can apply grant conditions and Ind AS 20 treatment. Utilization certificates and grant reporting remain in the ERP.

### 3.16 Production Order Management and Production WIP

The document already transacts against production orders in ten places - FR-B-07 explodes them, FR-Q-02 receives from them, FR-SC-01/05 reconcile their scrap - without defining the record. This section owns it: the production order as the record of truth for each make event, and production WIP as an explicit stock state between component issue and finished-goods receipt. Per §7.3, shop-floor scheduling and operator tracking stay excluded; order state, material issue, consumption posting, WIP custody, completion, and closure are in scope.

- **FR-MO-01 - Production Order Record:** A production order carries an immutable order number, output item and quantity, plant, effective Released BOM version (FR-B-06), business-stream tag (FR-AC-01), and a source reference - sales order (FR-O), rework NCR (FR-Q-06), or manual entry with reason code. Every state transition and header change writes a timestamped, user-attributed audit record.
- **FR-MO-02 - Lifecycle States:** Orders move through Planned, Released, In Process, Completed, Closed; Cancelled is reachable only from Planned or Released with zero unreversed material transactions. Each state defines permitted postings: no issue or backflush before Released, and the first material or completion posting moves the order to In Process.
- **FR-MO-03 - Release Gate:** Release requires a Released BOM version effective on the release date (FR-B-06) and a component availability check against available stock (FR-I-01) and scheduled inbound supply, persisting a shortage list on the order. Release over shortages requires a named override authority and flags the order to FR-D-07 for expediting.
- **FR-MO-04 - Staging and Issue:** Release triggers the FR-B-07 explosion into the order's material requirement list; directed-issue lines generate FR-W pick tasks, and picked stock sits in allocated status (FR-I-01) against the order until issued. Backflush lines skip staging and post consumption on operation or receipt confirmation per FR-B-07.
- **FR-MO-05 - Production WIP Ledger:** Every issue and backflush moves component quantity and cost from inventory into a production WIP ledger keyed to the order, reportable by order, item, and plant in quantity and value, and distinct from R&D project WIP (FR-RD-07). Cost basis follows FR-AC-05; Ind AS 2 inventory treatment and valuation remain with FR-AC and the ERP financial record (A-02, C-10) - this FR defines the ledger, not the accounting.
- **FR-MO-06 - Return to Stock:** Unconsumed issued or staged material returns to inventory with a reason code, reversing the WIP entry at issued cost and restoring the original lot or serial identity (FR-I-04). Returns are the only WIP deduction that produces neither output nor scrap.
- **FR-MO-07 - Completion Reporting:** A completion posts good quantity into QC Hold (FR-Q-02) as a new FG lot and relieves WIP at the FR-AC-05 cost basis; partial completions accumulate against order quantity. Expected co-products and by-products (FR-B-14) post at completion as separate lots with their own QC routing.
- **FR-MO-08 - Process Scrap Declaration:** Operators declare process scrap against the order with quantity, stage, and reason code; each declaration relieves WIP and writes to the scrap ledger, feeding per-order expected-versus-actual comparison (FR-SC-05) and reconciliation (FR-SC-01).
- **FR-MO-09 - Short and Over-Completion:** Each item-plant combination carries completion tolerance limits; over-completion beyond tolerance blocks without supervisor approval. Short completion leaves the order In Process until a supervisor completes the remainder or reduces order quantity with a reason code, routing the residue into closure variance (FR-B-08).
- **FR-MO-10 - Rework Orders:** An FR-Q-06 rework disposition generates a rework production order referencing the originating order, NCR, and defective lot; it consumes the defective lot plus additional components through the same issue and WIP mechanics, and its output re-enters the FG QC gate (FR-Q-02) as a new lot linked to the original.
- **FR-MO-11 - As-Consumed Lot Genealogy:** Every issue and backflush records which component lots and serials (FR-I-04) went into which output lot, producing an as-consumed genealogy record per FG lot at completion; this record is the traversal structure FR-Q-09 recall tracing executes, forward and backward. Backflush of lot-controlled components must resolve lots via a configured determination rule (FEFO or FIFO) with operator confirmation; consumption of a lot-controlled item without a recorded lot is blocked.
- **FR-MO-12 - Order Closure:** Closure requires order WIP at zero in quantity and value (issues equal completions plus scrap plus returns, at cost), no open pick tasks or staged allocations, and a QC disposition on every output lot; closure triggers FR-B-08 consumption variance reporting and settlement handoff to ERP (A-02). Closed orders are immutable; corrections post as audited reversal documents.
- **FR-MO-13 - Offline Execution:** Order headers, requirement lists, and WIP balances for Released and In Process orders replicate to the plant execution store (FR-B-07); issue, backflush, completion, scrap, and return postings continue during a central outage and replay in sequence on reconnection, with duplicate suppression and lot conflicts queued for supervisor resolution. Release, cancellation, and closure are control events and execute only against the central system.

### 3.17 Job-Work Services Management

The company fabricates for customers as a paid service: customer material arrives under the customer's delivery challan, remains customer property while on site, is consumed against a job-work service order, and goes back as finished output plus a service invoice. This section owns that workflow end to end. Statutory documents and accounting treatment stay in FR-AC (FR-AC-11, FR-AC-01); this section produces the operational records those requirements consume.

- **FR-JW-01 - Job-Work Service Order:** The system shall provide a job-work service order recording customer, scope and specification reference, promised receipt and dispatch dates, and price basis (per piece, per kg, or per hour). Where materials are structured, the order links a kit BOM per FR-B-16. The order is the single anchor for receipts, custody, consumption, dispatch, and billing.
- **FR-JW-02 - Order Lifecycle:** Each order shall move through defined statuses: draft, confirmed, awaiting material, in process, ready for dispatch, dispatched, handed to billing, closed. Every status change records user and timestamp per NFR-SEC-04.
- **FR-JW-03 - Customer Material Receipt:** Receiving shall accept customer material only against a confirmed job-work order, through the gate and weighbridge flow (INT-GATE-01) and standard receiving (FR-W-02), capturing the customer's challan number and date on the receipt for the FR-AC-11 paper trail. Variances between challan quantity and verified receipt shall be recorded on the receipt and reported to the customer contact named on the order.
- **FR-JW-04 - Customer-Owned Stock Class:** Received customer material shall post into a customer-owned, non-valuated stock class segregated from own stock, extending FR-I-10, keyed by customer and job-work order, with lot and serial identity preserved per FR-I-04. The system shall block issue of this stock to any demand other than a job-work order of the owning customer and exclude it from own-stock reports and valuation.
- **FR-JW-05 - Custody Ledger:** The system shall maintain a custody ledger per customer and per order with movement categories: received, consumed, returned as product, returned as scrap or offcuts, returned unprocessed, process loss, and balance on hand. Every entry traces to a source document, and the ledger prints as a customer custody statement at customer and order level.
- **FR-JW-06 - Consumption Posting:** Production shall consume customer material against the job-work order, following the customer-supplied lines of the linked kit BOM where one exists (FR-B-16). Each posting records user, timestamp, and quantity, and updates the custody ledger in the same transaction.
- **FR-JW-07 - Own-Material Additions:** Company-supplied lines shall issue from own valuated stock against the same order and flow to the billing feed as billable material distinct from the service charge. Valuation and revenue treatment follow FR-AC.
- **FR-JW-08 - Process Loss Norms:** Each order shall carry an agreed process loss norm (percentage or absolute per unit), and the system computes actual loss as consumed quantity minus product output minus recorded scrap and offcuts. Actual loss beyond the norm requires supervisor approval with reason before the order can reach ready for dispatch.
- **FR-JW-09 - Offcut and Scrap Election:** Each order shall record one contractual election for offcuts and scrap: return to customer, retain and buy, or retain free. The election is captured at order confirmation; changes require authorization and are logged per NFR-SEC-04.
- **FR-JW-10 - Election Execution:** Return-elected offcuts and scrap shall dispatch back to the customer with documents per FR-AC-11. Retained offcuts and scrap (bought or free) shall enter scrap inventory through FR-SC with the job-work order as source document, with retain-and-buy settlement per FR-AC. The custody ledger records the disposition in every case.
- **FR-JW-11 - Output Dispatch:** Finished job-work output shall pass the finished goods quality gate per FR-Q-02 before dispatch and return to the customer with documents per FR-AC-11, each dispatch line referencing the inbound receipt(s) it discharges. Partial dispatches are permitted; each updates order status and the custody ledger.
- **FR-JW-12 - Billing Feed:** On dispatch, or on the billing milestone defined in the order, the system shall assemble the measured billing basis per order - accepted pieces, certified weighbridge weight (INT-GATE-01), or booked hours - plus billable own-material lines, and hand the set to the ERP for invoicing (A-02). The feed reconciles line by line to dispatch documents; treatment per FR-AC.
- **FR-JW-13 - Physical Reconciliation:** Customer-owned stock shall be included in periodic physical verification, counted quantity reconciled to the custody ledger, and discrepancies recorded with reason and approver and shown on the next customer custody statement. A reconciliation report per customer evidences each cycle.
- **FR-JW-14 - Aging and Exception Alerts:** The system shall alert the job-work coordinator when customer material on hand exceeds contract holding terms or approaches the statutory return windows computed under FR-AC-11, with configurable warning and escalation lead times; the statutory clock counts from the customer's challan date, not the gate-in date. Exceptions are reportable per customer and per order.
- **FR-JW-15 - Closure Control:** An order shall not close while its custody ledger balance is non-zero; the balance clears only through recorded dispatch, return of unprocessed material, an executed offcut election, or an approved reconciliation adjustment. Closure records user and timestamp per NFR-SEC-04.

### 3.18 Imports and Landed Cost Management

The §5.1 Finance need for landed cost and INT-ACC-02 currently have no functional home; this section supplies it. It carries an import from purchase order to Bill of Entry, splits duty heads between input tax credit and inventory cost, and closes provisional assessments. Costing follows Ind AS 2 para 11: import duties and non-recoverable taxes enter inventory cost; recoverable IGST and compensation cess do not.

- **FR-IM-01 - Import Purchase Orders:** The system must flag a PO as an import with supplier country, transaction currency, Incoterms, and expected duty heads, reusing FR-P-05/06/07 approval and receipt flows. Import PO lines must store both the booking exchange rate and the CBIC rate notified under s.14 Customs Act 1962.
- **FR-IM-02 - Bill of Entry Capture:** Record BOE number, date, port code, customs exchange rate, assessable value (s.14 Customs Act 1962), and duty amounts by head (BCD, Social Welfare Surcharge, IGST levied under s.3(7) Customs Tariff Act 1975, GST compensation cess, anti-dumping or safeguard duty where levied), linked many-to-many to import PO lines and GRNs.
- **FR-IM-03 - Import IGST into the ITC Register:** Post IGST and compensation cess paid per BOE into the FR-AC-07 ITC register keyed by BOE number and date, the BOE being the credit document under rule 36(1)(d) CGST Rules 2017 and required to carry the importing GSTIN. BCD and SWS are not creditable and must route to landed cost, never to the register.
- **FR-IM-04 - Landed Cost Sheets:** Build a landed cost sheet per import receipt allocating BCD, SWS, other non-creditable duties, freight, insurance, and clearing, CHA, and port charges to receipt lines by value, gross weight, or quantity, with the basis selectable per cost element and stored for audit.
- **FR-IM-05 - Inventory Valuation Posting:** Post allocated landed cost to receipt-line inventory value through INT-ACC-02 so item cost equals cost of purchase under Ind AS 2 para 11. Recoverable IGST and cess must never enter item cost, and exchange differences arising after initial recognition stay out of inventory per Ind AS 21.
- **FR-IM-06 - Provisional Assessment Lifecycle:** Flag a BOE as provisionally assessed under s.18 Customs Act 1962 with bond and security details, track it against the statutory two-year finalization window, and on finalization post differential duty to on-hand inventory or to consumption cost where stock is issued, charging s.28AA interest to expense, all captured in the FR-AC-13 edit log.
- **FR-IM-07 - Late Cost True-Up:** Apply freight, insurance, or clearing invoices received after GRN to the original landed cost sheet within a configurable window; beyond the window, or where stock is consumed, post the difference to a purchase price variance account with reason code.
- **FR-IM-08 - ICEGATE Reconciliation:** Reconcile ITC register BOE entries against import IGST auto-populated from ICEGATE into GSTR-2B, and report unmatched or amount-mismatched BOEs before each GSTR-3B filing through the INT-GST family.
- **FR-IM-09 - Duty-Exemption Licence Hook:** Where an import runs under Advance Authorisation or EPCG, capture licence number, exemption notification claimed, and duty saved on the BOE record, and expose these fields to external obligation tracking. Full export obligation registers stay out of scope: obligation fulfilment is a DGFT/Foreign Trade Policy process, so this system records the linkage, not the register.

### 3.19 Tooling and Tool Crib Management

Tools decide whether the plan happens. A die at the regrinder, a jig lost between shifts, or a gauge past calibration stops a job as surely as missing material. This section puts every tool - from a two-tonne mould to a screwdriver at the maker-hub - under one master, one crib discipline, and one life record, reusing the custody, meter, calibration, and scrap patterns already defined.

- **FR-TL-01 - Tool Master Record:** Every tool carries a master record with tool class (die, mould, jig, fixture, gauge, hand tool, power tool), a unique tool ID with durable tag or QR label, home crib location, and current status. Per FR-M-01, a tool remains fully manageable whether or not a fixed-asset entry exists.
- **FR-TL-02 - Where-Used Linkage:** Tool records link to the products, BOMs, and operations they serve through the FR-B where-used structures. The system answers both "which tools does this order need" and "which orders does this tool block" without a separate parts list.
- **FR-TL-03 - Asset and Cost Cross-Reference:** Capitalized tools link one-to-one to their FR-FA asset record; all tools capture acquisition cost, vendor, and acquisition date so the capitalize-versus-expense decision (FR-FA/FR-AC) has clean data. The crib never asks the issuing operator an accounting question.
- **FR-TL-04 - Crib Issue:** Scan-based issue from a crib to a named person, a shift, or a production order (FR-MO), reusing the FR-RD-06 custody pattern: custodian, purpose, expected return, and condition code at issue. Issue to an order stamps the tool onto that order's record.
- **FR-TL-05 - Crib Return and Overdue:** Scan-based return records a condition code; a damaged return routes the tool to FR-TL-11 rework instead of the shelf. Each crib maintains an overdue list by custodian with configurable escalation, mirroring FR-RD-06.
- **FR-TL-06 - Maker-Hub Tool Lending:** Hub members borrow tools with the member record as custodian under the same FR-RD-06 semantics. Members with overdue or damage-flagged returns can be blocked from further issue per configurable policy.
- **FR-TL-07 - Perishable Tooling as Stock:** Consumable tooling (inserts, drill bits, taps, abrasives) is managed as crib stock with FR-I-03 min-max replenishment. Issue posts consumption against the order or cost centre with no return expected.
- **FR-TL-08 - Tool Life Counters:** Durable tools carry a life counter in shots, cycles, strokes, or hours. Counters increment automatically from FR-MO production confirmations or from meter readings per the FR-M-03 pattern; manual corrections require a reason code and are audit-logged.
- **FR-TL-09 - Life Thresholds:** Each tool carries a warning threshold and a hard-stop threshold on remaining life. Warning flags the tool and notifies the toolroom; hard-stop blocks further crib issue and flags any running order, in the same lockout spirit as FR-M-13.
- **FR-TL-10 - Life History:** The system keeps a full life history per tool: cumulative and per-order usage, condition codes, threshold breaches, regrind and repair events, and custodians. History survives regrind resets.
- **FR-TL-11 - Regrind and Repair Routing:** Life expiry or a damage flag routes the tool to rework: an internal maintenance work order per FR-M, or an external vendor job with despatch and receipt tracking. Despatch of IP-sensitive tooling records the confidentiality agreement reference on the despatch document. Tool status shows at-regrind or at-vendor throughout.
- **FR-TL-12 - Regrind Limits and Life Reset:** Tool models define a maximum regrind count and a post-regrind life value. Completing a regrind increments the count and resets remaining life; breaching the maximum proposes condemnation and blocks silent reissue.
- **FR-TL-13 - Condemnation and Disposal:** Condemned tools exit through FR-SC scrap intake with the condemnation record as source document. Dies and moulds are defaced per FR-SC-08 before any sale, with defacement evidence attached.
- **FR-TL-14 - Gauge Calibration Lockout:** Gauges in the crib cross-reference the FR-M-12 calibration register. A gauge past its calibration due date cannot be issued (FR-M-13 spirit), and the crib view shows next-due date at scan.
- **FR-TL-15 - Personal Issue Register:** PPE and safety gear issue to a named worker with item, size, issue date, and renewal cycle; replacement-due alerts go to the worker and supervisor. Damage or loss before renewal records a reason and reissues without waiting for the cycle.
- **FR-TL-16 - Tool Availability Broadcast:** Real-time tool status (in crib, issued, at regrind, at vendor, locked out, condemned) publishes to production planning (FR-MO) and maker-hub booking using the FR-M-16 status broadcast pattern. An order or booking that needs an unavailable tool is flagged before start, not at the machine.
- **FR-TL-17 - Offline Crib Transactions:** Crib issue, return, and personal-issue transactions work offline per NFR-U-05 and sync on reconnection. Conflicting syncs, such as the same tool issued twice, surface to the crib attendant for resolution rather than silently overwriting.

### 3.20 Gate Passes and Returnable Materials

Material leaves site for reasons that are neither sale nor job work - repairs, calibration, demos, exhibitions, samples, refilling, tool regrinding, packaging cycles. This section puts every such kilo on a document with a return clock, and reconciles what comes back against what went out.

- **FR-GP-01 - Gate Pass Types and Series:** The system shall provide Returnable Gate Pass (RGP) and Non-Returnable Gate Pass (NRGP) as distinct, serially numbered documents per GSTIN and site with financial-year series. Every outbound movement that is not a sales dispatch, job-work challan (FR-AC-11), or scrap dispatch (FR-SC-16) requires one of the two.
- **FR-GP-02 - RGP Issue:** RGP issue shall capture item, quantity, serial or asset number where applicable, book value, consignee party and address, reason code (repair, calibration, demo, exhibition, testing, refilling, tool regrind), expected return date, approver, and carrier and vehicle details.
- **FR-GP-03 - Driving Document Linkage:** The system shall block RGP issue unless linked to a driving document - maintenance work order (FR-M-05) for repair, calibration plan entry (FR-M-12) for instruments, approved demo or exhibition request, or approved sample request - and shall show open gate-pass status on that document.
- **FR-GP-04 - GST Documents for Non-Sale Movements:** For each RGP and NRGP the system shall generate a delivery challan per CGST Rule 55 (serial number not exceeding 16 characters, triplicate marking, consignor and consignee details with GSTIN, HSN, description, quantity, taxable value) and trigger an e-way bill via INT-GST-02 when consignment value crosses the configurable threshold (Rs 50,000 default), including movements for reasons other than supply. Tax treatment and postings follow FR-AC.
- **FR-GP-05 - Return Receipt:** An RGP shall close only through a return receipt verifying item identity by serial match, quantity, and condition (OK, repaired, replaced, damaged), captured at gate inward scan plus stores confirmation; the repair or calibration outcome writes back to the driving document.
- **FR-GP-06 - Partial Returns:** The system shall accept line-level partial receipts; the RGP stays open for the balance with a revised expected return date and each receipt logged as a dated event.
- **FR-GP-07 - Substitution on Return:** Where a different serial returns (replacement unit, exchanged assembly), the system shall record the substitution with approver and update the asset or instrument register (FR-M) before closure.
- **FR-GP-08 - NRGP Issue:** NRGP shall be issued only for permitted non-returnable movements with a mandatory reason code (free sample, warranty replacement, donation, third-party destruction) and approval per the delegation-of-authority registry (FR-DOA-01), consuming stock or retiring the asset against the stated accounting head.
- **FR-GP-09 - Open-RGP Ageing:** The system shall publish an open-RGP register aged against expected return date with custodian, party, and value; reminders go to custodian and approver at configurable steps (default 7, 15, 30 days overdue) with escalation to site head beyond threshold.
- **FR-GP-10 - Statutory and Insurance Window Alerts:** Each RGP class shall carry configurable clocks (job-work return limits where the movement qualifies, insurance coverage period for off-site assets, warranty windows) and raise a hard alert to a named owner before any window lapses; no clock expires silently.
- **FR-GP-11 - Gate Enforcement:** Security shall scan every outbound non-sale movement against an open gate pass on the INT-GATE-01 pattern - no matching document, no exit - recording actual exit date-time, vehicle, and verified quantity; mismatches raise an incident per NFR-SEC-04.
- **FR-GP-12 - Off-Site Asset Visibility:** The system shall report all material outside the gate as at any date - by party, location, and value - covering RGP items, material at job workers (FR-AC-11), and packaging with third parties, sufficient for insurance declaration and audit.
- **FR-GP-13 - Returnable Packaging Register:** The system shall track returnable packaging (crates, drums, cylinders, pallets, spools) as a distinct consignment class (FR-I-10) with per-party running balances in both directions - our packaging with suppliers and customers, theirs with us - with serialized tracking for cylinders.
- **FR-GP-14 - Packaging Deposits and Recovery:** The system shall record deposits taken and given against returnable packaging, refund on verified return, and recover unreturned units after a configurable cycle via deposit forfeiture or debit note through FR-AC, with periodic revaluation of deposit rates against replacement cost.

### 3.21 Budget Control (ERP-Synced)

Budget masters stay in the ERP (A-02); this section defines the check, not the book. It supplies the number DH-APPROVE-01 promised approvers.

- **FR-BC-01 - ERP-Synced Budget Data:** The system consumes budget heads and period-wise available amounts from the ERP (department opex, capex by approved proposal, maintenance by asset class) on a configurable sync schedule. It maintains no budget masters of its own (A-02).
- **FR-BC-02 - Commitment Check at Approval:** On approval of indents, capex requests, and maintenance work orders, the system displays budget remaining inline (per DH-APPROVE-01) and applies a configurable warn-or-block rule (NFR-E-02) when the request exceeds available budget. Committed-not-yet-consumed amounts reduce available budget until ERP actuals are synced.

### 3.22 Approvals and Delegation of Authority

Approval authority is one table, not a matrix per module. Every workflow that asks "who may approve this" resolves the answer here.

- **FR-DOA-01 - Enterprise Delegation-of-Authority Registry:** A single DOA registry defines approval authority by role, transaction type, and value band, with time-bound vacation delegation and a full change audit trail. All approval workflows (indents, POs, disposals, write-offs, capex, gate passes) resolve approvers from this registry. Workflow configuration (NFR-E-02) consumes, never overrides, the registry.

## 4. Non-Functional Requirements

### 4.1 Scalability

- **NFR-S-01:** The system must support a minimum of **50 locations** (warehouses, retail sites, manufacturing facilities) with the ability to scale to **200+ locations** without architectural changes.
- **NFR-S-02:** The system must handle **500,000+ active SKUs** across all locations, with per-location SKU counts of up to **100,000**.
- **NFR-S-03:** The system must support **1,000+ concurrent users** across all locations during peak operational hours, with headroom to scale to **5,000 concurrent users**.
- **NFR-S-04:** The system must process **10,000+ order lines per hour** during peak periods without degradation in response times.
- **NFR-S-05:** Database partitioning and indexing strategies must accommodate historical data retention of not less than 8 financial years for every record that feeds the books of account (Companies Act 2013 s.128(5), read with FR-AC-13), of which a minimum of 3 years online and the remainder archived yet restorable to queryable form within 48 hours for statutory audit, GST assessment, and forecasting; retention must be extensible per record class where the Central Government directs a longer period under the s.128(5) proviso following a Chapter XIV investigation.

### 4.2 Performance

- **NFR-P-01:** Page load and screen transitions for operational workflows (order entry, receiving, picking) must complete in **under 2 seconds**.
- **NFR-P-02:** Inventory queries (stock check across locations) must return results in **under 1 second** for single-SKU queries and **under 3 seconds** for multi-SKU/location queries.
- **NFR-P-03:** Report generation for standard reports must complete in **under 10 seconds**. Complex ad-hoc reports spanning multiple years of data must complete in **under 60 seconds**.
- **NFR-P-04:** The system must be available **99.5% of operational hours** (measured as uptime during business hours across all time zones where locations operate). Target: 99.9%.
- **NFR-P-05:** API response times for integration endpoints must be **under 500ms** for 95th percentile and **under 2 seconds** for 99th percentile.

### 4.3 Security

- **NFR-SEC-01:** All user access must be authenticated. Support Single Sign-On (SSO) via SAML 2.0 or OpenID Connect integration with the organization's identity provider (Azure AD, Okta, or equivalent).
- **NFR-SEC-02:** Role-Based Access Control (RBAC) at the module, function, location, and data level. A user's access to inventory, procurement, and reporting data must be scopeable to specific locations, departments, or categories.
- **NFR-SEC-03:** All data in transit must be encrypted using TLS 1.2 or higher. All data at rest must be encrypted using AES-256 or equivalent.
- **NFR-SEC-04:** The system must maintain a complete, immutable audit log of all user actions affecting inventory quantities, financial data, procurement decisions, and system configuration changes. Audit logs must be non-deletable and exportable. FR-AC-13 extends this log to the statutory edit-log obligations for records feeding the books of account.
- **NFR-SEC-05:** The system must enforce segregation of duties - for example, the user who creates a purchase order must not be the same user who approves it, and the user who records a goods receipt must not be the same user who approves the invoice.
- **NFR-SEC-06:** The system must comply with the Digital Personal Data Protection Act 2023 and the DPDP Rules 2025 (notified 14 November 2025, substantive obligations phased to May 2027) for personal data of maker-hub members, customers, supplier contacts, and users, including consent records, breach notification, and data-principal rights. Apply GDPR or other foreign regimes only where processing falls within their scope.

### 4.4 Data Integrity and Reliability

- **NFR-DI-01:** Inventory transactions must be ACID-compliant. A stock transfer, shipment, or receipt must never result in partial or inconsistent inventory states.
- **NFR-DI-02:** The system must prevent double-allocation of inventory - an item allocated to one order cannot simultaneously be allocated to another.
- **NFR-DI-03:** Data synchronization between locations must be eventually consistent with a maximum lag of **5 seconds** under normal network conditions. The system must handle network partitions gracefully, queuing transactions for replay when connectivity is restored.
- **NFR-DI-04:** The system must support automated backups at minimum **daily** with point-in-time recovery capability. Recovery Time Objective (RTO): **4 hours**. Recovery Point Objective (RPO): **1 hour**.
- **NFR-DI-05:** All financial-impacting transactions (receipts, shipments, adjustments, returns) must be idempotent - duplicate processing of the same event must not create duplicate inventory or financial postings.

### 4.5 Usability and Accessibility

- **NFR-U-01:** The user interface must be responsive and accessible on desktop browsers (Chrome, Edge, Firefox - latest two versions) and tablet devices used on warehouse floors.
- **NFR-U-02:** The system must meet WCAG 2.1 Level AA accessibility standards.
- **NFR-U-03:** The system must support internationalization (i18n) - multi-language UI, multi-currency transactions, and locale-specific date/number formatting.
- **NFR-U-04:** The system must provide contextual help, tooltips, and a searchable knowledge base accessible from within the application.
- **NFR-U-05 - Offline-First Frontline Capture:** Gate, weighbridge, and shopfloor mobile workflows must be fully operable with no network connectivity treated as a normal path, not an exception. Captured events (gate-in, weight, putaway, pick, indent) must persist locally on the device and auto-reconcile to the server on reconnection without operator re-entry, consistent with the store-and-forward behavior in NFR-DI-03.
- **NFR-U-06 - Moment-of-Use Ergonomics:** High-frequency frontline tasks must be scan-first with large touch targets, completable one-handed and with gloves, and must minimize the number of taps and fields required to complete a transaction. Screens must degrade gracefully under poor lighting and on rugged devices, so that a clumsy or slow interface does not push staff back to paper or informal workarounds.

### 4.6 Extensibility and Maintainability

- **NFR-E-01:** The system must expose a well-documented RESTful API (and/or GraphQL) for all core functions, enabling integration with external systems and custom extensions.
- **NFR-E-02:** The system must support configurable workflows (approval chains, routing rules, alert thresholds) without requiring code changes.
- **NFR-E-03:** The system must support a plugin or extension framework for custom business logic, custom reports, and integration adapters.
- **NFR-E-04:** System upgrades must be possible with minimal downtime (target: **under 30 minutes** for routine updates) and without data migration errors.

### 4.7 Frontline Adoption

- **NFR-ADOPT-01 - Locator Feedback Loop:** Where the system captures frontline tribal knowledge (for example, a store assistant's bin-location overrides, or accumulated location-confidence gains), it must surface visible value back to those same staff, such as more accurate directed bins and fewer wrong-bin walks. Sustained frontline confirmation rate must remain at or above **95%**. A drop below this threshold is treated as a system defect to be investigated, not as user error, because capturing knowledge without returning value removes the incentive to keep confirming and the data quality then degrades.

### 4.8 Documents and Retention

- **NFR-D-01:** All modules use a single attachment store for certificates, test reports, manifests, photos, videos, bills of entry, and signed documents, with per-attachment metadata (document type, linked record, uploader, timestamp), virus scanning on upload, and configurable size/format limits.
- **NFR-D-02:** Each document type carries a retention class (statutory minimums preloaded for GST, Customs, and Companies Act records) and supports legal hold; deletion before retention expiry or while on hold is blocked and audit-logged.

## 5. Stakeholders and User Roles

### 5.1 Role Definitions

| Role                                  | Primary Locations         | Core Needs                                                                                                                                                                                |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warehouse Manager**           | Warehouses, DCs           | Real-time view of inbound/outbound activity, task assignment and productivity monitoring, cycle count schedules, space utilization. Needs mobile-friendly interface for floor operations. |
| **Warehouse Operator**          | Warehouse floor           | Receiving, putaway, picking, packing, shipping tasks. Needs barcode/RFID scanning, minimal data entry, clear task instructions on a mobile device.                                        |
| **Inventory Controller**        | All locations             | Consolidated stock position across all locations, transfer management, inventory aging analysis, valuation reconciliation, cycle count variance review.                                   |
| **Procurement Officer**         | HQ / Regional offices     | Requisition-to-PO workflow, supplier management, tender creation and evaluation, contract management, spend analytics. Needs supplier portal management.                                  |
| **Demand Planner**              | HQ / Regional offices     | Forecast generation and adjustment, promotional planning input, inventory health monitoring, replenishment plan review. Needs statistical analysis tools and what-if scenario modeling.   |
| **Logistics Coordinator**       | Warehouses, DCs           | Shipment planning, carrier selection, freight rate comparison, shipment tracking, freight audit, import/export documentation.                                                             |
| **Store/Retail Manager**        | Retail sites              | Local stock visibility, replenishment requests, inter-store transfer requests, local receiving and returns processing.                                                                    |
| **Quality Inspector**           | Warehouses, Manufacturing | Quality inspection workflows, inspection criteria management, non-conformance recording, supplier quality data.                                                                           |
| **Finance/Accounting**          | HQ / Shared services      | Inventory valuation reports, PO-to-invoice matching, freight cost allocation, landed cost calculation, month-end reconciliation data.                                                     |
| **Executive / VP Supply Chain** | HQ                        | Enterprise-wide dashboards - inventory turns, fill rate, procurement spend, supplier performance, forecast accuracy. Exception alerts. Strategic decision support.                        |
| **System Administrator**        | HQ / IT                   | User and role management, system configuration, integration monitoring, audit log review, backup and recovery management.                                                                 |
| **Supplier (External)**         | External                  | Bid submission portal, order acknowledgment, ASN submission, invoice submission, performance scorecard access.                                                                            |
| **R&D Store Keeper**            | R&D centre store          | Receive and issue by type against project codes, custody register upkeep, returns acceptance, cycle counts.                                                                              |
| **Maker-Hub Operator**          | Maker-hub                 | Member check-in, booking closure with meter reading, offline point-of-use sales, job cards, replenishment requests.                                                                      |
| **R&D Project Owner**           | R&D centre                | A hat per §5.3: approve requisitions and budget breaches, view project WIP and cost, decide prototype disposition.                                                                       |
| **BOM Administrator**           | Head office, plants       | Route and approve ECOs, release BOM versions, run where-used impact analysis, resolve INT-ERP-01 sync exceptions.                                                                        |
| **Manufacturing Engineer**      | Production plants         | Maintain production BOM lines, scrap percentages, and alternates; investigate FR-B-08 consumption variances.                                                                             |
| **R&D Engineer**                | R&D centre                | Iterate draft BOMs, capture as-built snapshots, initiate the productization gate.                                                                                                        |
| **Maintenance Technician**      | All sites, utility yards  | A hat per §5.3, often worn by operators and hub staff: offline work-order execution (NFR-U-05), asset-tag scanning, spares issue and return, fix history for the asset in hand.          |
| **Maintenance Planner**         | Plant maintenance office  | PM calendar, work-order assignment, critical-spares alerts (FR-I-03), AMC and statutory due lists, repair-vs-capitalize flagging.                                                        |
| **Calibration Coordinator**     | QC labs, R&D centre       | Calibration due list, certificate upload, lockout status, alternate-instrument suggestion.                                                                                               |
| **QC Head**                     | Plants, R&D centre        | Approve inspection plans and deviations, hold and release authority, CAPA oversight, BIS licence upkeep on the product master.                                                           |
| **Scrap Yard Custodian**        | Scrap yards, quarantine   | Bin custody, intake weighment and photos, gate-pass execution; no overlap with disposal approvers (NFR-SEC-05).                                                                          |
| **Disposal and Auction Officer** | Scrap yards, head office | Lot building, buyer registration, auction conduct, EMD and payment tracking, statutory manifests.                                                                                        |
| **Disposal Committee Member**   | Cross-location            | Value-banded approval of NRV, reserve prices, awards, and destructions; destruction witness duty.                                                                                        |
| **Plant Accountant**            | Plants, central finance   | Capitalization queue, CWIP ageing, depreciation run approval, repair-vs-capitalize decisions, physical-verification reconciliation sign-off.                                             |
| **GST Compliance Officer**      | Central finance, GSTINs   | ITC register, IRN and e-way bill exceptions, job-work return clocks and ITC-04, ITC reversal review.                                                                                     |
| **Statutory Auditor (External)** | Remote, all locations    | Read-only: edit-log extracts, physical-verification evidence packs, subledger-to-GL reconciliations, fixed-asset register.                                                               |
| **Production Planner**          | Central planning, plants  | Release orders with availability checks, monitor shortages, production WIP aging, and the open-order book.                                                                              |
| **Production Supervisor**       | Shop floor, staging areas | Confirm issues, completions, and scrap; approve tolerance overrides; resolve offline replay conflicts.                                                                                   |
| **Job-Work Coordinator**        | Plants, job-work stores   | Own service orders and offcut elections; one live view of every customer's material position; no material held past its window without a dated alert and a named owner.                  |
| **Imports & Customs Coordinator** | Receiving dock, finance | Import PO to BOE linkage, landed cost sheets, provisional assessment closure, ICEGATE/GSTR-2B reconciliation support.                                                                    |
| **Tool Crib Attendant**         | Tool cribs, maker-hub     | A hat per §5.3: sub-15-second scan issue and return, overdue list, condition capture, offline operation.                                                                                 |
| **Toolroom In-charge**          | Toolroom, regrind bench   | Life and regrind queue, threshold alerts, vendor despatch, condemnation proposals.                                                                                                       |
| **Gate Pass Coordinator**       | Stores, dispatch, security | Issue RGP/NRGP with driving-document links, chase overdue returns, reconcile packaging balances.                                                                                        |
| **EPR Compliance Officer**      | EHS office, all GSTINs    | Category-wise plastic consumption data, portal registrations, filing calendar with acknowledgments.                                                                                      |

### 5.2 Role-Based Access Matrix (High-Level)

| Capability                             | Warehouse Mgr | Inventory Ctrl | Procurement | Demand Planner | Store Mgr | Executive |  Finance  |
| -------------------------------------- | :-----------: | :------------: | :---------: | :------------: | :-------: | :-------: | :--------: |
| View inventory (all locations)         |      ✓      |       ✓       |     ✓     |       ✓       |     -     |    ✓    |     ✓     |
| View inventory (own location only)     |      ✓      |       ✓       |     ✓     |       ✓       |    ✓    |     -     |     -     |
| Create/approve stock transfers         |      ✓      |       ✓       |      -      |       -       |     -     |     -     |     -     |
| Create purchase requisitions           |      ✓      |       ✓       |     ✓     |       ✓       |    ✓    |     -     |     -     |
| Create/approve purchase orders         |       -       |       -       |     ✓     |       -       |     -     |     -     |     -     |
| Create/manage tenders                  |       -       |       -       |     ✓     |       -       |     -     |     -     |     -     |
| View financial data (costs, valuation) |       -       |       -       |     ✓     |       -       |     -     |    ✓    |     ✓     |
| Manage demand forecasts                |       -       |       -       |      -      |       ✓       |     -     |     -     |     -     |
| Configure system settings              |       -       |       -       |      -      |       -       |     -     |     -     | ✓ (Admin) |
| View dashboards and reports            |      ✓      |       ✓       |     ✓     |       ✓       |    ✓    |    ✓    |     ✓     |

### 5.3 Frontline Operational Roles (Granular)

The coarse roles in Section 5.1 (for example **Warehouse Operator**) map to several distinct people on an actual floor, each with a different moment of use. The following table decomposes those coarse roles into the granular frontline roles this system must serve directly; the detailed user stories for the highest-impact roles are in Section 9.

| Granular Role                | On the floor this is                                                              | Relationship to Section 5.1                |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| **Gate / Security Officer**  | First checkpoint; logs vehicles in and out and binds them to expected paperwork   | New (previously implicit)                  |
| **Weighbridge Operator**     | First person to touch an inbound truck; captures tare, gross, and net weights     | New                                        |
| **Unloading Labor Supervisor** | Cracks the truck open and oversees the unload                                   | Decomposes Warehouse Operator              |
| **QC / Receiving Inspector** | Accepts, rejects, or partially accepts a load                                     | Same as Quality Inspector (5.1)            |
| **Store Assistant**          | Bins stock (putaway) and picks orders                                             | Decomposes Warehouse Operator              |
| **Stock Locator**            | Knows where stock physically is; today this knowledge lives in memory or a ledger | New                                        |
| **Dispatch Clerk**           | Manages outbound; distinct from the gate officer                                  | New                                        |
| **Indent Raiser**            | Floor or department person who requests materials (raises a requisition)          | Refines the requisitioner in FR-P-04       |
| **Department Head (Approver)** | Approves or rejects indents, ideally with budget visibility                     | Refines the approval role in FR-P-04       |
| **Procurement Executive**    | Turns approved indents into purchase orders                                       | Same as Procurement Officer (5.1)          |

**Role as a hat, not a badge.** The system must model these roles as assignable capabilities rather than fixed job titles bound to one person. On a small site one individual may hold several roles at once (for example, indent raiser and procurement executive); on a large site the same responsibilities split across separate departments. Access control (NFR-SEC-02) must support assigning any combination of these roles to a user, scoped by location, without code changes.

## 6. Integration Requirements

### 6.1 Enterprise Resource Planning (ERP) System

- **INT-ERP-01:** Synchronization of item master data and costing information with the ERP, split by data domain: BOM structure, revisions, and lifecycle state publish outbound from the SCM BOM module (FR-B-17); item cost rates and financial item attributes flow inbound. Sync conflicts raise an exception record for the BOM Administrator; last-write-wins is not permitted.
- **INT-ERP-02:** Outbound posting of inventory transactions (receipts, issues, transfers, adjustments) to the ERP general ledger for financial accounting.
- **INT-ERP-03:** Outbound posting of procurement transactions (PO issuance, goods receipt, invoice matching) to ERP accounts payable.
- **INT-ERP-04:** Inbound synchronization of sales orders from the ERP for fulfillment through the SCM system.
- **INT-ERP-05:** Synchronization of customer master, supplier master, and chart of accounts between systems.
- **INT-ERP-06:** Daily push of closed maker-hub bookings, machine-time charges, and point-of-use sales per member or customer account to ERP billing; invoice and GST treatment per FR-AC-12.
- **INT-ERP-07:** Inbound sync of budget heads and period-wise available amounts from the ERP per FR-BC-01, with committed-not-yet-consumed amounts reconciled against ERP actuals each sync cycle.

### 6.2 Accounting and Finance Systems

- **INT-ACC-01:** Export of inventory valuation data for period-end closing (by location, by category, by valuation method).
- **INT-ACC-02:** Integration of freight and landed costs for accurate total cost of goods calculation.
- **INT-ACC-03:** Export of procurement accruals and goods-received-not-invoiced (GRNI) reports.

### 6.3 E-Commerce Platforms

- **INT-EC-01:** Real-time inventory availability feed from the SCM to the e-commerce platform (available-to-promise by location/region).
- **INT-EC-02:** Order import from e-commerce platforms into the SCM for fulfillment routing and processing.
- **INT-EC-03:** Shipment confirmation and tracking number export back to the e-commerce platform for customer notification.

### 6.4 Third-Party Logistics (3PL) Providers

- **INT-3PL-01:** Outbound shipment orders and ASNs to 3PL warehouses.
- **INT-3PL-02:** Inbound inventory feeds from 3PL systems (stock on hand, movements, adjustments).
- **INT-3PL-03:** Shipment status and tracking information from 3PL and carrier systems.

### 6.5 Supplier and Carrier Systems

- **INT-SUP-01:** EDI (ANSI X12 / EDIFACT) or API-based purchase order transmission to suppliers.
- **INT-SUP-02:** Inbound ASNs and shipping notifications from suppliers.
- **INT-SUP-03:** Supplier portal for tender/bid submission, order acknowledgment, and invoice submission.
- **INT-CAR-01:** Carrier rate and service-level API integration for real-time rate shopping.
- **INT-CAR-02:** Carrier tracking API integration for real-time shipment status updates.

### 6.6 Barcode, RFID, and IoT

- **INT-DC-01:** Support for barcode scanning (1D, 2D, QR) via mobile devices and fixed scanners for all warehouse transactions.
- **INT-DC-02:** RFID integration for automated receiving, inventory counting, and location tracking (where deployed).
- **INT-DC-03:** Integration with weigh scales, dimensioners, and automated sortation equipment at warehouse stations.

### 6.7 Identity and Access Management

- **INT-IAM-01:** SSO integration with the organization's Identity Provider (Azure AD, Okta, Ping, etc.) via SAML 2.0 or OpenID Connect.
- **INT-IAM-02:** User provisioning and de-provisioning integration (SCIM or equivalent) to automate role assignment based on HR system data.

### 6.8 Gate, Weighbridge, and Location Events

- **INT-GATE-01 - Gate and Weighbridge Event Model:** Define a first-class event model for the inbound edge, which the existing barcode, weigh-scale, and ERP integrations do not currently cover. It must include a vehicle-to-PO binding token created at the gate, and a weighbridge event contract carrying tare, gross, net, and variance readings tied to that token. Goods receipt posts the **accepted quantity only**; over-tolerance or under-tolerance readings raise a variance event that QC and procurement subscribe to. This event model feeds FR-W-02 (Receiving) and FR-P-06 (Goods Receipt and Quality Inspection) and posts to the ERP via INT-ERP-02 and INT-ERP-03.
- **INT-LOC-01 - Event-Sourced Location:** Physical location must be event-sourced rather than overwritten in place. A physical `LocationAsserted` fact (where the stock actually is, stamped with who, device, timestamp, and a confidence weight) is stored separately from the `LocationExpected` fact (where the ASN or plan said it should go). A divergence between them raises a `LocationDisputed` flag for review rather than silently merging. Last-writer-wins is banned for location: no location fact is ever overwritten, only superseded by a newer stamped assertion. This underpins FR-I-01 (multi-location stock tracking) and FR-W-03 (Putaway).

### 6.9 Statutory Tax Platforms

- **INT-GST-01 - E-Invoice (IRP):** The SCM system raises invoice-request events for scrap sales, branch transfers, and job-work invoices through the ERP invoicing flow to the Invoice Registration Portal, consumes the returned IRN and signed QR, and enforces the FR-AC-14 dispatch block. The ERP remains the invoice issuer per A-02.
- **INT-GST-02 - E-Way Bill (NIC Portal):** Generate, update (Part B vehicle details), and cancel e-way bills from dispatch events with consignment value above Rs 50,000, including job-work challan movements and scrap liftings; FR-SC raises the trigger with weight, transporter, and vehicle fields.
- **INT-GST-03 - GST Compliance Export:** Export the ITC register, s.17(5)(h) reversal notes, and ITC-04 challan data to the company's GST filing stack in return-ready format.

### 6.10 Waste and Disposal Channels

- **INT-EPR-01 - CPCB EPR Portal:** Document exchange for e-waste, battery, and non-ferrous scrap transactions; acknowledgments recorded against disposal lots, with manual upload acceptable in the first phase.
- **INT-AUC-01 - External E-Auction Venue:** Optional external e-auction service (e.g., MSTC) as an alternate bid venue; lot, bidder, and result data sync back into FR-SC-13 records.

### 6.11 Machine Metering and Status

- **INT-MTR-01 - Meter Ingestion:** Ingest machine-hour and cycle-count readings into maintenance usage meters (FR-M-03) from maker-hub booking closures (FR-RD-14) and from station equipment and weigh scales (INT-DC-03); operator-entered mobile readings fill gaps for MHE and DG sets.
- **INT-MTR-02 - Machine Status Feed:** Event feed of asset status changes (FR-M-16) to production planning and the maker-hub booking calendar within 2 minutes, consumed by FR-RD booking flows and plant scheduling.

### 6.12 Design Tools

- **INT-CAD-01 - R&D BOM Import:** Import structured BOM exports (CSV or neutral PLM/CAD formats) from R&D design tools into Draft R&D BOMs, creating unmatched items as placeholders per FR-B-09.

### 6.13 Customs and MSME Portals

- **INT-CUS-01 - ICEGATE:** Bill of Entry data feed, by direct enquiry or via GSTR-2B import IGST auto-population, driving FR-IM-08 reconciliation against the FR-AC-07 register.
- **INT-MSME-01 - Udyam Portal:** Supplier Udyam registration verification, manual or API where available, for FR-P-09 classification capture and annual revalidation.

### 6.14 Payments

- **INT-PAY-01 - Hub Payment Gateway:** UPI dynamic QR and card terminal integration at the maker-hub counter per FR-RD-20, storing the gateway reference per invoice and exporting end-of-day settlement data for reconciliation.

## 7. Assumptions and Constraints

### 7.1 Assumptions

| #    | Assumption                                                                                                                                   | Impact                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A-01 | The organization operates between**10 and 50 locations** initially, with plans to scale to 200+.                                       | System architecture must be horizontally scalable from day one.                                                        |
| A-02 | An ERP system is already in place (e.g., SAP, Oracle, Microsoft Dynamics, NetSuite) and will remain the system of record for financial data. | The SCM is the system of record for inventory operations but must feed financial transactions to the ERP.              |
| A-03 | All locations have reliable internet connectivity (minimum 10 Mbps) for cloud-based access.                                                  | Offline-capable mobile clients may be required for warehouse floor operations in areas with intermittent connectivity. |
| A-04 | The organization has or will implement a standardized item master and SKU coding scheme across all locations.                                | Data migration and integration depend on a consistent item identification scheme.                                      |
| A-05 | Barcode scanning infrastructure (mobile devices, printers) is budgeted separately and will be in place at go-live.                           | The SCM system must support standard barcode symbologies but is not responsible for hardware procurement.              |
| A-06 | A dedicated project team (business SMEs, IT, change management) will be available during implementation.                                     | Requirements validation, UAT, and training depend on business stakeholder availability.                                |
| A-07 | The system will be cloud-hosted (SaaS or private cloud) rather than on-premises.                                                             | Influences architecture decisions, security model, and operational cost structure.                                     |
| A-08 | The company prepares Ind AS financial statements and holds GST registrations in every state where it operates. | Inventory valuation per Ind AS 2, tax invoices, and delivery challans for job work and inter-state stock transfer are baseline document flows, not enhancements. |
| A-09 | The R&D unit holds or will seek DSIR recognition. | R&D material, asset, and spend records must separate cleanly from production and support DSIR reporting formats (Form 3CL). |
| A-10 | Usage capture at maker-hub booking close is operator-entered in the first phase; automated meter ingestion (INT-MTR-01) may follow without changing FR-RD-14 semantics. | Meter-based maintenance triggers (FR-M-02) tolerate operator-entered readings at go-live. |
| A-11 | Item master creation and release governance lives in FR-I and INT-ERP-01; FR-B-06 BOM release depends on it but does not define it. | Item governance failures surface as BOM release exceptions, not silent releases. |
| A-12 | Maker-hub booked hours approximate true machine hours; monthly reconciliation against physical hour meters corrects drift. | Prevents meter-based PM triggers from misfiring (FR-M-03). |
| A-13 | The company holds current BIS licences or registrations for every product category under a Quality Control Order, and licence data reaches the product master before FR-Q-11 go-live. | Release blocking on licence validity assumes licence records exist. |
| A-14 | Scrap arising from company-owned material in the maker-hub enters FR-SC-01 with the hub work record as source document; member-owned offcuts remain member property unless abandoned per hub terms. | Keeps member property outside the disposal and auction stream. |

### 7.2 Constraints

| #    | Constraint                                                                                                                                                                                               | Impact                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | The system must be operational within**12–18 months** from project kickoff, with a phased rollout by location or module.                                                                          | Phased deployment strategy is required; MVP scope must be defined for the first go-live.                                                                                                                   |
| C-02 | Budget is capped at a level that makes a fully custom-built solution impractical. A commercial-off-the-shelf (COTS) SCM platform with configuration and limited customization is the preferred approach. | Requirements should prioritize configurability over custom development. Evaluate leading SCM platforms (e.g., Manhattan Associates, Blue Yonder, Oracle SCM Cloud, SAP IBP, Kinaxis) against requirements. |
| C-03 | The organization's IT policy mandates that all systems must be accessible via SSO and must integrate with the corporate IAM solution.                                                                    | Native SSO support is a non-negotiable requirement for any platform selected.                                                                                                                              |
| C-04 | Data residency requirements may apply if the organization operates in multiple countries.                                                                                                                | The platform must support data residency configuration or multi-region deployment.                                                                                                                         |
| C-05 | The organization uses a preferred technology stack (e.g., Microsoft-centric, Java-based, or cloud-agnostic).                                                                                             | The selected platform should align with the existing technology ecosystem to minimize operational overhead.                                                                                                |
| C-06 | Change management capacity is limited - the organization can absorb significant process change at**2–3 locations per wave**.                                                                      | Rollout planning must account for organizational change velocity, not just technical readiness.                                                                                                            |
| C-07 | The audit-trail proviso to Rule 3(1), Companies (Accounts) Rules 2014 (in force since FY 2023-24) applies to any system feeding the books of account. | The edit log cannot be disabled by any role including administrators; no hard deletes; corrections post as reversals; logs retained per the books-retention period (FR-AC-13). |
| C-08 | Auction buyers are external parties with no internal system access. | Disposal needs a limited buyer touchpoint (lot view, bid submission, payment reference) isolated from internal stock and cost data. |
| C-09 | The maker-hub sells only from hub store stock at the point of use; it does not ship or deliver. | Hub sales stay outside dispatch and logistics scope (FR-O, FR-L). |
| C-10 | BOM cost rollups (FR-B-15) are comparison simulations only. | Standard cost setting, inventory valuation, and all tax or Ind AS treatment remain with FR-AC/FR-FA and the ERP. |
| C-11 | Weighbridges used for trade must hold current Legal Metrology stamping (12-monthly re-verification under Rule 27, Legal Metrology (General) Rules, 2011, and after any repair or relocation). | The system must block trade weighment on an unstamped weighbridge (FR-M-14). |
| C-12 | FR-Q-04 calibration lockout cannot activate before FR-M instrument records (asset IDs, calibration due dates, status) are loaded. | Sequence the FR-M instrument data load ahead of finished-goods QC go-live. |
| C-13 | Rule 8 of the Hazardous and Other Wastes Rules, 2016 caps on-site hazardous waste storage at ninety days unless the SPCB extends it. | FR-SC-18 timers enforce the limit and cannot be user-disabled. |

### 7.3 Out of Scope (Initial Phase)

The following are explicitly out of scope for the initial implementation phase but may be considered for future phases:

- **Full PLM/CAD integration** - R&D and production BOMs with revisions are in scope; drawing vaults, CAD files, and design-tool engineering workflows stay in PLM (structured BOM import per INT-CAD-01 is the only touchpoint)
- **IoT condition-based and predictive maintenance** - time- and meter-based schedules are in scope; sensor ingestion and failure prediction wait until maintenance history exists to predict from
- **General ledger and statutory books** - the platform posts subledger entries to the ERP (per A-02); it does not run the GL, close periods, or file GST returns
- **External marketplace listing** - in-system auction (lots, bidder registry, bids, sale documents) is in scope; building third-party marketplace listings is not (an optional external e-auction venue may sync results per INT-AUC-01)
- **MES shop-floor execution** - machine scheduling and operator tracking stay out; work-order material issue and consumption posting are in
- **HR, payroll, and membership subscription management** - membership plans, renewals, and subscription invoicing stay in the membership system; member records, machine-time capture, job cards, and point-of-use material sales are in scope (§3.9), with charges exported for invoicing (INT-ERP-06)
- **Advanced AI/ML-driven autonomous procurement** - initial phase focuses on rules-based automation
- **Customer-facing order tracking portal** - initial phase uses the existing e-commerce platform for this
- **Full transportation management system (TMS) replacement** - initial phase focuses on carrier integration and shipment tracking
- **MRP / net-requirements planning** - automated generation of planned production orders and purchase requisitions from sales orders and forecasts is excluded from the initial phase; production orders (§3.16) include a material shortage view on release, and MRP is revisited after two quarters of stable BOM and lead-time data
- **Insurance claim lifecycle management** - claim filing, survey, and settlement tracking are excluded; damage/loss events, policy references (FR-M-10), and write-offs (FR-SC-10) are recorded in-system, and claims are administered in the ERP or manually

### 7.4 Data Migration and Cutover

Go-live quality is set by opening balances; an error here repeats its damage on every transaction after cutover.

- **FR-DM-01 - Opening Balances:** Go-live requires physically verified opening stock by location, lot, and serial where applicable; the asset register with original cost, accumulated depreciation, and remaining Schedule II useful life; and open POs, sales orders, and job-work challans migrated with source references.
- **FR-DM-02 - Master and Register Migration:** All active BOMs (extending FR-B-02 beyond kits), custody and loan registers, and open gate passes are migrated and verified by their owning departments before cutover.
- **FR-DM-03 - Cutover Reconciliation Sign-Off:** Migrated balances are reconciled to ERP and legacy records with discrepancies resolved or documented; department-head and finance sign-off on the reconciliation is a mandatory go-live gate.

## 8. Success Metrics

| #     | Metric                                 | Target                                                                                      | Measurement Method                                                                                       |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SM-01 | **Inventory Accuracy**           | ≥ 98% accuracy across all locations (measured by cycle count variance)                     | Compare system-recorded quantities against physical count results                                        |
| SM-02 | **Stockout Rate**                | Reduce stockouts by 40% within 12 months of go-live                                         | Track number of order lines unfulfillable due to zero stock vs. total order lines                        |
| SM-03 | **Order Fill Rate**              | ≥ 95% line fill rate and ≥ 97% order fill rate                                            | Percentage of order lines/orders fulfilled completely from first-pick location                           |
| SM-04 | **Order Fulfillment Cycle Time** | Reduce average order-to-ship time by 30%                                                    | Measure time from order receipt to carrier handoff, compared to pre-implementation baseline              |
| SM-05 | **Cross-Location Transfer Time** | Average transfer fulfillment time under 48 hours for intra-region transfers                 | Measure time from transfer request approval to receiving confirmation at destination                     |
| SM-06 | **Procurement Cycle Time**       | Reduce requisition-to-PO cycle time by 50%                                                  | Measure time from requisition submission to PO issuance, compared to baseline                            |
| SM-07 | **Forecast Accuracy**            | Achieve ≥ 75% forecast accuracy at SKU-location level (monthly)                            | Compare forecasted demand vs. actual consumption, measured by MAPE or WAPE                               |
| SM-08 | **Supplier On-Time Delivery**    | ≥ 90% of purchase order lines delivered on or before the promised date                     | Track confirmed delivery date vs. promised delivery date at goods receipt                                |
| SM-09 | **Inventory Carrying Cost**      | Reduce average inventory days on hand by 20%                                                | Measure total inventory value divided by daily cost of goods sold, location-level                        |
| SM-10 | **User Adoption**                | ≥ 85% of targeted users actively using the system within 90 days of their location go-live | Track login frequency and transaction volume per user role                                               |
| SM-11 | **Data Entry Error Reduction**   | Reduce manual data entry errors by 60%                                                      | Compare error rates (incorrect quantities, wrong SKUs, location mismatches) pre- and post-implementation |
| SM-12 | **Reporting Time**               | Reduce time to produce monthly inventory and procurement reports by 80%                     | Measure person-hours spent on report generation pre- and post-implementation                             |
| SM-13 | **Gate Dwell Time**              | Median at or below 4 minutes per inbound vehicle, including in offline mode                  | Measure time from vehicle arrival at gate to gate-in confirmation (see story GATE-01)                    |
| SM-14 | **Weight-Capture Accuracy**      | ≥ 99.5% weight-capture accuracy; receiving weight-discrepancy rate trended weekly           | Compare captured net weight against verified reference weight (see story WEIGH-01)                        |
| SM-15 | **Putaway Accuracy**             | ≥ 98% putaway accuracy; bin-location confidence coverage ≥ 90%                              | Compare confirmed putaway location against expected/verified location (see story PUT-01)                 |
| SM-16 | **Indent-to-Decision Cycle Time** | Reduce indent-to-decision cycle time and hold duplicate-indent rate low                     | Measure time from indent submission to approval/rejection decision (see story IND-01)                    |
| SM-17 | **Frontline Confirmation Rate**  | Sustained frontline confirmation rate ≥ 95% (adoption health)                              | Track share of frontline events actively confirmed by staff rather than bypassed (see NFR-ADOPT-01)      |
| SM-18 | **Custody Loans Overdue**        | < 5% of open loans past expected return by more than 7 days                                 | FR-RD-06 custody register aging, monthly                                                                 |
| SM-19 | **Untagged Material Transactions** | 0 material transactions without an active project code per month                          | FR-RD-03 exception report, monthly                                                                       |
| SM-20 | **BOM Accuracy**                 | ≥ 98% of audited lines match the physical build                                             | Quarterly audit of sampled Released BOMs against work-order consumption records                          |
| SM-21 | **ECO Cycle Time**               | Median ≤ 10 working days from submission to Implemented                                     | ECO record state timestamps                                                                              |
| SM-22 | **Material Consumption Variance** | Within ±2% by value per plant per month                                                    | FR-B-08 variance reports aggregated monthly                                                              |
| SM-23 | **PM Adherence**                 | ≥ 95% of PM work orders closed within the grace window                                      | Closed-on-time PM work orders / PM work orders due (FR-M-02), monthly                                    |
| SM-24 | **MTTR for A-Criticality Assets** | ≤ 4 hours                                                                                  | Downtime clock per FR-M-06, monthly per location                                                         |
| SM-25 | **Instruments in Valid Calibration at Point of Use** | 100% of instruments referenced in FR-Q/FR-RD records                     | Calibration register due dates cross-checked against inspection usage logs                               |
| SM-26 | **First-Pass Yield, Finished Goods** | ≥ 95% within 12 months of go-live                                                       | Lots accepted at first inspection / lots inspected, monthly by plant (FR-Q-13)                           |
| SM-27 | **Production Completion to Release Decision** | ≤ 24 hours median                                                              | Timestamp delta from QC Hold posting (FR-Q-02) to disposition record (FR-Q-05)                           |
| SM-28 | **Dispatch Lines Lacking a Batch Release Record** | 0                                                                          | System-blocked by design; count of audit-log override exceptions (NFR-SEC-04)                            |
| SM-29 | **Scrap Reconciliation Variance** | < 2% by weight per material class per quarter                                              | FR-SC-21 reconciliation report (generated vs weighed vs disposed)                                        |
| SM-30 | **Intake-to-Disposal Cycle Time (Non-Regulated Lots)** | < 45 days median                                                      | Intake timestamp to gate-exit timestamp                                                                  |
| SM-31 | **Auction Realization Against Approved NRV** | ≥ 95%                                                                           | Awarded value divided by approved NRV, per lot, quarterly                                                |
| SM-32 | **Unplanned Downtime on Critical Assets** | Baseline from first 90 days of logging, then reduce 20% year on year               | Unplanned downtime hours per critical asset per quarter (FR-M-06)                                        |
| SM-33 | **CWIP Older Than 12 Months**    | < 10% of total CWIP value                                                                   | Monthly Schedule III ageing report (FR-FA-03)                                                            |
| SM-34 | **Job-Work Returns Within Statutory Windows** | 100% within the s.143 one-year (inputs) and three-year (capital goods) clocks  | Challan clock register vs ITC-04 (FR-AC-11)                                                              |
| SM-35 | **Close Reconciliation Clearance** | 100% of subledger-to-ERP GL reconciliation items cleared within 5 working days of close   | Period-end close checklist (FR-AC-15)                                                                    |
| SM-36 | **Production WIP Aging**         | Zero In Process orders with no posting beyond the configured staleness window                | FR-MO-05 WIP ledger, weekly by plant                                                                     |
| SM-37 | **Order Closure Discipline**     | 100% of closures with FR-B-08 variance settled; closure latency baselined in the first quarter, then reduced | FR-MO-12 state timestamps and FR-B-08 reports                                            |
| SM-38 | **Customer Material Custody Accuracy** | 100% of reconciliations matched, with explained variances only                         | FR-JW-13 reconciliation reports per customer                                                             |
| SM-39 | **Job-Work On-Time Dispatch**    | Baseline in first two quarters of capture, then target set                                   | FR-JW-01 promised dates vs FR-JW-11 dispatch timestamps                                                  |
| SM-40 | **Landed Cost Timeliness**       | 100% of import receipts with a finalized landed cost sheet within 7 days of GRN              | FR-IM-04 sheet dates vs GRN dates                                                                        |
| SM-41 | **MSME Payment Compliance**      | 100% of micro/small supplier invoices paid within the MSMED s.15 due date; zero s.43B(h) carry-over at year-end | FR-P-09 classification-tagged ageing feed                                             |
| SM-42 | **Tooling-Caused Stoppage**      | Production orders delayed by tool unavailability per month, trending to zero                 | FR-TL-16 status history against FR-MO order delays                                                       |
| SM-43 | **Crib Overdue Rate**            | < 5% of custody issues past expected return at week close                                    | FR-TL-05 overdue lists                                                                                   |
| SM-44 | **RGP On-Time Closure**          | ≥ 95% of RGPs closed on or before expected return date, monthly                              | FR-GP-09 open-RGP register                                                                               |
| SM-45 | **Returnable Packaging Recovery** | ≥ 98% of units returned or deposit-recovered within the configured cycle                    | FR-GP-13/FR-GP-14 per-party balances                                                                     |
| SM-46 | **Label Version Compliance**     | 100% of retail-flagged lots released with a current approved label version recorded          | FR-Q-14 label versions on FR-Q-07 batch release records                                                  |
| SM-47 | **Budget-Visible Approvals**     | 100% of indent and capex approvals decided with budget-remaining displayed, from go-live     | FR-BC-02 approval records                                                                                |
| SM-48 | **Cutover Reconciliation**       | Zero unexplained opening-balance variance; 100% department and finance sign-off              | FR-DM-03 sign-off records                                                                                |

## 9. Frontline Operational Requirements and User Stories

The functional requirements in Section 3 describe what the system does. This section makes the highest-impact frontline capabilities granular by expressing them as the day-to-day moments real operational staff experience, so that each requirement traces to a specific role, trigger, and measurable outcome. Nothing here replaces Section 3; each story elaborates one or more of those requirements.

### 9.1 Approach

Three operating principles govern the frontline design:

1. **Moments, not a flat list.** Frontline requirements are organized around operational personas (Section 5.3) and the moments they are in, expressed as user stories, rather than as an undifferentiated capability list.
2. **Role as a hat, not a badge.** Stories name a role, but any user may hold several roles, so the same story applies whether one person or a whole department performs it (see Section 5.3).
3. **Offline as normal.** Every frontline story assumes connectivity can drop, and treats offline capture and later reconciliation as a first-class path (see NFR-U-05 and NFR-DI-03).

**Prioritization rule for story depth.** Each candidate moment is scored on three axes, each from 1 to 5: **Pain** (how badly the current process hurts the person), **Frequency** (how often the moment occurs), and **Data-Integrity Risk** (how badly a fast, wrong entry poisons downstream roles). A moment scoring **45 or above** (out of 125), or scoring a **5 on Data-Integrity Risk alone**, earns a fully-worked story (Section 9.2). Everything else is captured as a one-line stub (Section 9.3) until its score justifies promotion. Data-Integrity Risk holds a veto because a wrong number entered quickly corrupts every downstream role.

**Story template.** Every frontline story is written to the same mold: a persona-and-moment line ("As a [role] [in the moment], I want [action], so that [benefit]"), two to three acceptance criteria in Given / When / Then form (always including an offline criterion where the moment happens on an edge device), and a success metric tied to Section 8.

### 9.2 Fully-Worked User Stories

#### Story GATE-01: Log an Inbound Vehicle Under Pressure

Elaborates FR-W-02 (Receiving) and FR-O-06 (Order Status Tracking) at the inbound edge; depends on INT-GATE-01.

*As a Gate Security Officer receiving an inbound vehicle at 2am, I want to log the gate event against an expected ASN or PO even when the network is down, so that goods enter on a traceable record instead of a paper register and an informal messaging group.*

1. **AC1 (happy path):** Given a vehicle arrives with a challan referencing a known PO, When the officer scans or keys the PO and confirms vehicle and challan details, Then the system creates a queued gate event stamped with time, gate ID, and officer ID, and shows a "captured, pending sync" state.
2. **AC2 (offline):** Given the device has no connectivity, When the officer completes capture including a mandatory photo of the challan, Then the event persists locally, is assigned a provisional gate token, and auto-reconciles to the matching ASN or PO within 5 minutes of connectivity being restored, with any mismatch flagged for the store assistant rather than silently dropped.
3. **AC3 (exception):** Given no matching PO exists, When the officer logs the event, Then the system still captures it as "unmatched" and routes it to a named owner for resolution, so that nothing enters unrecorded.

**Success metric:** SM-13 (median gate dwell time at or below 4 minutes per vehicle, including offline); gate-origin data-entry error rate below 2%.

#### Story WEIGH-01: Capture Trusted Weights at the Weighbridge

Elaborates FR-W-02 (Receiving) and FR-P-06 (Goods Receipt and Quality Inspection); depends on INT-GATE-01.

*As a Weighbridge Operator, I want to capture tare, gross, and net against the linked PO or ASN, so that receiving weights are trusted and discrepancies are caught at the gate.*

1. **AC1 (happy path):** Given a truck tied to a PO or ASN with a defined tolerance, When I record tare then gross, Then net auto-calculates, is validated within tolerance, and posts to the goods-receipt event with an accept status.
2. **AC2 (offline):** Given no connectivity, When I capture tare and gross, Then the reading is queued locally with a timestamp and device provenance stamp and reconciles on reconnect without operator re-entry.
3. **AC3 (exception):** Given net falls over or under PO tolerance, When I confirm the weight, Then the load is flagged as a discrepancy, blocked from silent receipt, and routed to a named owner (QC or Receiving supervisor) for disposition.

**Success metric:** SM-14 (weight-capture accuracy at or above 99.5%; receiving weight-discrepancy rate trended weekly).

#### Story PUT-01: Directed Putaway with Locator Override Capture

Elaborates FR-W-03 (Putaway) and FR-I-01 (Multi-Location Stock Tracking); depends on INT-LOC-01.

*As a Store Assistant, I want scan-first directed putaway that lets me log any bin change as a correction event, so that slotting stays accurate and location confidence grows instead of living in one person's head.*

1. **AC1 (directed):** Given a directed bin, When I scan the item and the target bin, Then the system confirms the match hands-light (glove-friendly and one-handed) and records a putaway-confirmed event.
2. **AC2 (override as correction):** Given I place stock in a different bin, When I scan the actual location, Then the system records a locator-override correction event with a reason code, feeding the ABC re-slotting engine.
3. **AC3 (disputed reconcile):** Given the offline queue surfaces a physical override that conflicts with the ASN expected location, When it reconciles, Then the physical override becomes the authoritative physical-location fact with a provenance and confidence stamp, the ASN expected-location value is preserved rather than overwritten, and the conflict is surfaced for review. Last-writer-wins is banned for location.

**Success metric:** SM-15 (putaway accuracy at or above 98%; bin-location confidence coverage at or above 90%).

**Related voice-pick acceptance shape.** For the associated hands-free picking moment (stub PICK-VOICE-01): Given an active voice-directed pick, When the operator completes the line by voice confirmation, Then zero manual screen taps are recorded for that pick and pick error rate stays at or below 0.5%. Both taps and error rate are instrumented, so the criterion is fully verifiable.

#### Story IND-01: Raise an Indent and Know What Happens to It

Elaborates FR-P-04 (Purchase Requisition and approval routing).

*As a floor supervisor with ninety seconds between tasks, I want to raise an indent from my phone and actually know what happens to it, so that I never chase, guess, or raise it twice.*

1. **AC1 (raise and duplicate check):** Given I have raised the same item within the open window, When I submit, Then the system warns me of the likely duplicate and confirms my indent with an ID in under 90 seconds.
2. **AC2 (visibility):** Given my indent exists, When I open the app, Then I see its live status (raised, approved, rejected, ordered, expected delivery) without contacting anyone.
3. **AC3 (decision push-back):** Given the department head decides, When they approve or reject, Then I receive a push notification carrying the decision and the reason.

**Success metric:** SM-16 (indent-to-decision cycle time; percentage of indents with raiser-visible status at all times; duplicate-indent rate).

### 9.3 Prioritized Story Stubs

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

### 9.4 Industry Practices Adapted

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

### 9.5 How Frontline Capture Integrates with the Core System

The frontline stories are the edge-capture layer that feeds the core defined in Sections 3 through 6:

1. The gate and weighbridge events (INT-GATE-01) create the inbound record that FR-W-02 receiving and FR-P-06 goods receipt consume.
2. The QC inspector's per-line disposition determines what quantity emits a goods-receipt event to the ERP (INT-ERP-02 and INT-ERP-03), preserving the existing financial posting flow.
3. Putaway and locator events (INT-LOC-01) keep FR-I-01 multi-location stock balances honest and feed the Section 3.6 demand and slotting logic.
4. The indent loop (IND-01) closes the demand signal that FR-P-04 requisitioning and FR-D-07 replenishment planning depend on, so an approved indent flows into a requisition line without re-keying.
5. NFR-ADOPT-01 governs all of the above: if frontline confirmation rates fall, the captured data degrades, so adoption is monitored as a first-class quality metric (SM-17) alongside the other Section 8 metrics.

## Appendix A: Document Revision History

| Version | Date       | Author                                  | Changes                                  |
| ------- | ---------- | --------------------------------------- | ---------------------------------------- |
| 1.0     | 2026-07-10 | BMAD Party (Mary, John, Winston, Sally) | Initial high-level requirements document |
| 1.1     | 2026-07-10 | BMAD Party (Mary, John, Winston, Sally, and Ravi, ops veteran) | Merged frontline and shopfloor usability expansion: added granular role model (5.3), offline-first and moment-of-use usability NFRs (NFR-U-05, NFR-U-06), frontline adoption NFR (4.7, NFR-ADOPT-01), gate/weighbridge and event-sourced location integration (6.8, INT-GATE-01, INT-LOC-01), frontline user stories and stubs (Section 9), and success metrics SM-13 through SM-17 |
| 2.0     | 2026-07-10 | BMAD Party (John, Mary, Winston, Ravi; walk-ons: Dr. Kavitha Rao, QC Head; Farida Ansari, disposal & commercial; CA Meera Iyer, chartered accountant) | Re-scoped for a production-cum-R&D-cum-maker-hub enterprise under Indian regulations and Ind AS. Rewrote §1 and added BO-9 to BO-12. Added seven functional modules: R&D centre and maker-hub materials (3.9, FR-RD), BOM management for production and R&D (3.10, FR-B), maintenance and calibration (3.11, FR-M), finished-goods QC (3.12, FR-Q), scrap/defectives/disposal with auction (3.13, FR-SC), fixed assets and depreciation (3.14, FR-FA), and R&D accounting separation with statutory compliance (3.15, FR-AC). Amended FR-I-05 (LIFO removed per Ind AS 2), NFR-SEC-04 (statutory edit-log tie), NFR-SEC-06 (DPDP Act 2023 replaces GDPR/CCPA framing), and INT-ERP-01 (BOM sync split by data domain). Added INT-ERP-06 and integration families 6.9-6.12, sixteen roles in 5.1, assumptions A-08 to A-14, constraints C-07 to C-13, a rewritten 7.3, metrics SM-18 to SM-35, twelve story stubs, and glossary terms. |
| 2.1     | 2026-07-10 | BMAD Party (John, Mary, Winston, Ravi; walk-ons: Dr. Kavitha Rao, Farida Ansari, CA Meera Iyer) | Gap-closure round. Added seven sections: production order management and production WIP (3.16, FR-MO), job-work services (3.17, FR-JW), imports and landed cost (3.18, FR-IM), tooling and tool crib (3.19, FR-TL), gate passes and returnable materials (3.20, FR-GP), ERP-synced budget control (3.21, FR-BC), and the delegation-of-authority registry (3.22, FR-DOA). Added intangible assets FR-FA-15 to FR-FA-20 (3.14 retitled), MSME compliance FR-P-09, packaged-commodity labeling FR-Q-14 and witnessed inspection FR-Q-15, hub payment capture FR-RD-20, grant tagging FR-AC-16, plastic packaging EPR FR-SC-22, documents-and-retention NFRs (4.8, NFR-D-01/02), and the data migration gate (7.4, FR-DM). Amended FR-B-07 and FR-B-08 (BOM explosion binds at production-order release; terminology aligned), FR-SC-10 (resolves approvers from FR-DOA-01), and NFR-S-05 (8-financial-year retention per Companies Act s.128(5)). Scope verdicts recorded in 7.3: MRP deferred, insurance claim lifecycle excluded. Metrics SM-36 to SM-48, eleven story stubs, eight roles, and glossary terms added. |

## Appendix B: Glossary

| Term    | Definition                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| ABC Slotting | Placing stock by velocity class (A, B, C) so fast-movers sit in the most accessible locations             |
| ASN     | Advanced Shipping Notice - electronic notification of pending delivery from a supplier                         |
| BOL     | Bill of Lading - legal document between shipper and carrier detailing the shipment                             |
| Challan | Delivery document accompanying a shipment, listing goods dispatched; often reconciled against a PO at the gate |
| Directed Putaway | System-guided putaway where the system tells the operator the target bin rather than the operator choosing |
| Indent  | An internal request or requisition raised by floor or department staff for materials or supplies               |
| FEFO    | First Expiry, First Out - inventory rotation method prioritizing items closest to expiry                       |
| FIFO    | First In, First Out - inventory rotation and valuation method                                                  |
| GRNI    | Goods Received Not Invoiced - accrual for received goods where the supplier invoice has not yet been processed |
| MAPE    | Mean Absolute Percentage Error - a measure of forecast accuracy                                                |
| RFQ/RFP | Request for Quotation / Request for Proposal - formal tender documents                                         |
| RMA     | Return Merchandise Authorization - approval for a customer to return goods                                     |
| SKU     | Stock Keeping Unit - the unique identifier for a distinct product/item                                         |
| Tare / Gross / Net | Weighbridge readings: tare is the empty-vehicle weight, gross is the loaded weight, net is the difference (the goods) |
| VMI     | Vendor Managed Inventory - inventory managed by the supplier at the customer's location                        |
| WAPE    | Weighted Absolute Percentage Error - a volume-weighted measure of forecast accuracy                            |
| 3PL     | Third-Party Logistics provider - outsourced warehousing and/or transportation services                         |
| AMC | Annual Maintenance Contract - service contract with an external vendor covering defined assets and visits |
| AQL | Acceptance Quality Limit - worst tolerable process average quality level for sampling inspection, per IS 2500 (Part 1) / ISO 2859-1 |
| As-built BOM | Immutable snapshot of components, lots, and quantities actually consumed in a specific build |
| Backflush | Automatic posting of component consumption on confirmation of an operation or receipt, per the BOM |
| Batch Release Record | Per-lot record of results, instruments, disposition, and signatories that authorizes movement out of QC Hold |
| Cannibalization | Controlled recovery of usable components from a condemned item before the carcass is scrapped |
| CAPA | Corrective and Preventive Action record required for critical or repeat NCRs |
| CARO 2020 | Companies (Auditor's Report) Order 2020 - prescribed auditor reporting including PPE records and verification (cl. 3(i)) and inventory verification with the 10% discrepancy test (cl. 3(ii)) |
| CoA / CoC | Certificate of Analysis / Certificate of Conformance - lot-level document of measured results or conformance, issued at release |
| Competent person | Examiner recognized under the OSH Code, 2020 and state rules to certify hoists, lifts, lifting tackle, and pressure plant |
| Conditional Release | Release of a lot under a recorded deviation with justification, scope, expiry, and named QC Head-level approver |
| Condition code | Code recorded when material or equipment returns to store: new, used-serviceable, degraded, or scrap |
| Co-product / By-product | Planned additional outputs of a production order alongside the primary item; by-products are incidental |
| Costed BOM | Dated snapshot of a BOM with material cost rolled up at synced rates |
| Criticality class | A/B/C ranking of an asset by production, safety, and revenue impact; drives work-order priority and critical-spares policy |
| Custody issue | Issue of equipment to a named custodian with an expected return date; a loan, not consumption |
| CWIP | Capital work-in-progress - accumulated cost of assets under construction or installation, not yet capitalized; requires Schedule III ageing disclosure |
| Delegation of Authority (DOA) | Value-banded registry defining who may approve a transaction (indents, POs, disposals, write-offs, capex, gate passes); maintained enterprise-wide per FR-DOA-01 |
| Delivery challan | Transport document under Rule 45/55, CGST Rules, covering non-supply movements such as job-work dispatches |
| Distinct persons | Separate GST registrations of one legal entity (s.25 CGST Act); supplies between them are taxable even without consideration (Schedule I) |
| DPDP Act | Digital Personal Data Protection Act 2023, with DPDP Rules 2025 - India's personal-data regime |
| DSIR | Department of Scientific and Industrial Research - recognition of in-house R&D units underpins the s.35 deduction claim and carries reporting obligations on R&D spend and assets |
| ECO | Engineering Change Order - approved change record that is the only mechanism for altering a Released BOM |
| Effectivity date | Date range within which a BOM revision or line applies to execution |
| EMD | Earnest money deposit collected from bidders per lot; refunded to losers, adjusted or forfeited for the winner |
| EPR | Extended Producer Responsibility - statutory channel obligations covering e-waste, batteries, and non-ferrous metal scrap |
| First-pass yield | Share of lots or quantity accepted at first inspection without rework or deviation |
| Form 10 Manifest | Movement document under the Hazardous and Other Wastes Rules, 2016 accompanying each hazardous waste consignment |
| Form 3CL | DSIR report quantifying in-house R&D expenditure eligible for deduction under s.35 (Income-tax) |
| Ind AS | Indian Accounting Standards notified under the Companies (Indian Accounting Standards) Rules 2015 - the entity's financial reporting framework |
| IRN | Invoice Reference Number issued by the government Invoice Registration Portal; a B2B invoice above the e-invoice threshold is invalid without it |
| ITC | Input Tax Credit - GST paid on inputs and capital goods creditable against output tax, subject to blocking under s.17(5) CGST Act |
| ITC-04 | GST statement of goods sent to and received back from job workers, filed at prescribed periodicity |
| Job card (maker-hub) | Record collecting one member project's bookings, machine hours, and material purchases for billing |
| Job work | Processing or working on goods belonging to another registered person, per s.2(68) CGST Act; movements documented by delivery challan |
| Kit BOM | BOM defining materials dispatched for a job-work or service order, tagged by supply source |
| Lifting | Physical removal of an awarded lot by the buyer through weighment and gate pass |
| Lot (disposal) | A grouped quantity of scrap or disposal stock offered as one unit of sale or disposal |
| MRO spares | Maintenance, repair, and operations items held in stores to service assets; not sold and not part of product BOMs |
| MTBF | Mean Time Between Failures - average operating time between successive breakdowns of an asset |
| MTTR | Mean Time To Repair - average elapsed time from fault report to return-to-service for an asset |
| NABL | National Accreditation Board for Testing and Calibration Laboratories - accredits ISO/IEC 17025 calibration labs in India |
| NCR | Non-Conformance Report - record opened on lot rejection, carrying defect codes, closed only by rework, downgrade, or scrap |
| NRV | Net realizable value - estimated selling price less costs of completion and sale; inventories are carried at the lower of cost and NRV (Ind AS 2) |
| Out-of-calibration lockout | System block preventing an overdue or failed instrument from recording inspection results |
| Phantom assembly | Non-stocked structural level whose components are consumed directly by the parent order |
| Phase tag | Research-or-development marker on an R&D project; drives accounting treatment under FR-AC |
| PM | Preventive Maintenance - maintenance triggered by calendar date or usage meter before failure occurs |
| Point-of-use sale | Sale of hub-store material to a member or customer at the moment of use |
| Productization gate | Checklist-controlled promotion of an R&D BOM into a Draft production BOM |
| Project store | An R&D store that issues materials only against a project code, so consumption maps to a project from the first transaction |
| Project WIP (R&D) | Accumulated quantity and cost of material issued to an R&D project, less returns |
| Quality hold | Recorded post-release block on a lot, flipping its stock to Blocked pending investigation |
| Quantity-per | Component quantity required per unit of parent item, before scrap adjustment |
| Registered prototype | Serialized, non-saleable finished output of an R&D build, linked to its project and build record |
| Reserve price | Approved minimum acceptable price for a lot, sealed until bid opening |
| Retention sample | Sample from a released lot stored until a retain-until date for reference testing |
| Return-to-service | Supervisor sign-off ending downtime and releasing the asset to planning and booking |
| Scrap (yield) percentage | Expected process loss per BOM line, used to inflate planned consumption and set the scrap standard |
| Seconds / Downgrade | Quantity reclassified to a lower-grade item code and sellable only at that grade |
| STI | Scheme of Testing and Inspection - BIS-prescribed testing regime and levels of control binding a Scheme-I licensee |
| Teardown | Controlled disassembly of a prototype with recovered components returned to stock under condition codes |
| TSDF | Treatment, Storage and Disposal Facility authorized for hazardous waste |
| WDV | Written-down value - depreciation method applying a fixed rate to the reducing carrying amount; also the income-tax carrying value of an asset block |
| Where-used | Report listing every parent structure, order, and stock position referencing a given item |
| Advance Authorisation (AA) | Foreign Trade Policy scheme permitting duty-free import of inputs against an export obligation |
| As-consumed genealogy | Per output lot, the recorded set of component lots and serials actually consumed; the executable form of recall tracing |
| Assessable Value | Value determined under s.14 Customs Act 1962 on which import duties are computed |
| BOE (Bill of Entry) | Customs declaration filed on ICEGATE for imported goods; the ITC credit document under rule 36(1)(d) CGST Rules 2017 |
| CHA (Customs House Agent) | Licensed customs broker whose clearing charges enter landed cost |
| Custody ledger (job-work) | Per-customer, per-order record of customer-owned material movements and balance; source of the customer custody statement |
| EPCG | Export Promotion Capital Goods - Foreign Trade Policy scheme permitting duty-saved import of capital goods against an export obligation |
| Hold point | Inspection plan stage that blocks further processing or dispatch until the designated party records clearance or a waiver |
| IAUD | Intangible Assets Under Development - Schedule III line item for development-phase spend pending capitalization, with mandatory ageing |
| ICEGATE | Indian Customs Electronic Gateway, CBIC's e-filing portal; source of BOE data auto-populated into GSTR-2B |
| Job-work service order | Order under which the company processes customer-owned material for a service charge; the anchor for receipt, custody, consumption, dispatch, and billing |
| Legal hold | A flag suspending retention-based deletion of documents relevant to litigation, audit, or investigation |
| NRGP (Non-Returnable Gate Pass) | Authorization for permitted outbound movements with no return expected, carrying reason code and DOA approval |
| Offcut election | The recorded per-order contractual choice for offcuts and scrap: return, retain and buy, or retain free |
| Packaging deposit | Money held against returnable packaging, refundable on return and forfeitable on non-return |
| Perishable tooling | Consumable tools (inserts, drills, taps) expensed on issue with no return expected |
| Personal issue | Named issue of PPE or safety gear to one worker with a renewal cycle |
| Plastic EPR Category (I-IV) | CPCB plastic packaging classes - rigid, flexible, multilayered, compostable/biodegradable - used for portal registration and returns |
| Process loss | Quantity consumed that leaves as neither product nor scrap (burning, evaporation, machining dust); tracked against an agreed norm per order |
| Production order | The record of truth authorizing conversion of defined components into a defined output quantity, carrying state, BOM version, WIP balance, and genealogy |
| Production WIP | Stock state holding quantity and cost of components issued to a production order and not yet relieved by completion, scrap, or return |
| Regrind | Restoring a die, punch, or cutter's working geometry; consumes part of a finite regrind allowance |
| Returnable packaging | Crates, drums, cylinders, pallets, and spools circulating between parties on deposit or contract, tracked to per-party balances |
| RGP (Returnable Gate Pass) | Serially numbered authorization for material leaving site with an expected return date and a linked driving document |
| Shot | One press or moulding cycle counted against die or mould life |
| SWS (Social Welfare Surcharge) | Surcharge on customs duty; not creditable, forms part of landed cost |
| Tool crib | Controlled store that issues and receives tools under custody discipline |
| Udyam Registration Number (URN) | Identifier from the Udyam portal fixing a supplier's micro/small/medium classification |
| Unit sale price | Per-unit price declaration (per g or kg, cm or m, ml or l, or per number) mandatory on retail packages from 1 October 2022; exempt where equal to the retail sale price |
| Witness point | Inspection plan stage the customer or agency is notified to observe; processing continues after documented notice if the party does not attend |

*This document is intended for review by business stakeholders and technical teams. It represents strategic, high-level requirements and is not a detailed technical specification. Detailed functional specifications, user stories, and technical design documents will be derived from this document in subsequent phases.*
