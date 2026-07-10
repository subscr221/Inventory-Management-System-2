# 5. Stakeholders and User Roles

## 5.1 Role Definitions

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

## 5.2 Role-Based Access Matrix (High-Level)

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

## 5.3 Frontline Operational Roles (Granular)

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
