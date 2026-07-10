# 6. Integration Requirements

## 6.1 Enterprise Resource Planning (ERP) System

- **INT-ERP-01:** Synchronization of item master data and costing information with the ERP, split by data domain: BOM structure, revisions, and lifecycle state publish outbound from the SCM BOM module (FR-B-17); item cost rates and financial item attributes flow inbound. Sync conflicts raise an exception record for the BOM Administrator; last-write-wins is not permitted.
- **INT-ERP-02:** Outbound posting of inventory transactions (receipts, issues, transfers, adjustments) to the ERP general ledger for financial accounting.
- **INT-ERP-03:** Outbound posting of procurement transactions (PO issuance, goods receipt, invoice matching) to ERP accounts payable.
- **INT-ERP-04:** Inbound synchronization of sales orders from the ERP for fulfillment through the SCM system.
- **INT-ERP-05:** Synchronization of customer master, supplier master, and chart of accounts between systems.
- **INT-ERP-06:** Daily push of closed maker-hub bookings, machine-time charges, and point-of-use sales per member or customer account to ERP billing; invoice and GST treatment per FR-AC-12.
- **INT-ERP-07:** Inbound sync of budget heads and period-wise available amounts from the ERP per FR-BC-01, with committed-not-yet-consumed amounts reconciled against ERP actuals each sync cycle.

## 6.2 Accounting and Finance Systems

- **INT-ACC-01:** Export of inventory valuation data for period-end closing (by location, by category, by valuation method).
- **INT-ACC-02:** Integration of freight and landed costs for accurate total cost of goods calculation.
- **INT-ACC-03:** Export of procurement accruals and goods-received-not-invoiced (GRNI) reports.

## 6.3 E-Commerce Platforms

- **INT-EC-01:** Real-time inventory availability feed from the SCM to the e-commerce platform (available-to-promise by location/region).
- **INT-EC-02:** Order import from e-commerce platforms into the SCM for fulfillment routing and processing.
- **INT-EC-03:** Shipment confirmation and tracking number export back to the e-commerce platform for customer notification.

## 6.4 Third-Party Logistics (3PL) Providers

- **INT-3PL-01:** Outbound shipment orders and ASNs to 3PL warehouses.
- **INT-3PL-02:** Inbound inventory feeds from 3PL systems (stock on hand, movements, adjustments).
- **INT-3PL-03:** Shipment status and tracking information from 3PL and carrier systems.

## 6.5 Supplier and Carrier Systems

- **INT-SUP-01:** EDI (ANSI X12 / EDIFACT) or API-based purchase order transmission to suppliers.
- **INT-SUP-02:** Inbound ASNs and shipping notifications from suppliers.
- **INT-SUP-03:** Supplier portal for tender/bid submission, order acknowledgment, and invoice submission.
- **INT-CAR-01:** Carrier rate and service-level API integration for real-time rate shopping.
- **INT-CAR-02:** Carrier tracking API integration for real-time shipment status updates.

## 6.6 Barcode, RFID, and IoT

- **INT-DC-01:** Support for barcode scanning (1D, 2D, QR) via mobile devices and fixed scanners for all warehouse transactions.
- **INT-DC-02:** RFID integration for automated receiving, inventory counting, and location tracking (where deployed).
- **INT-DC-03:** Integration with weigh scales, dimensioners, and automated sortation equipment at warehouse stations.

## 6.7 Identity and Access Management

- **INT-IAM-01:** SSO integration with the organization's Identity Provider (Azure AD, Okta, Ping, etc.) via SAML 2.0 or OpenID Connect.
- **INT-IAM-02:** User provisioning and de-provisioning integration (SCIM or equivalent) to automate role assignment based on HR system data.

## 6.8 Gate, Weighbridge, and Location Events

- **INT-GATE-01 - Gate and Weighbridge Event Model:** Define a first-class event model for the inbound edge, which the existing barcode, weigh-scale, and ERP integrations do not currently cover. It must include a vehicle-to-PO binding token created at the gate, and a weighbridge event contract carrying tare, gross, net, and variance readings tied to that token. Goods receipt posts the **accepted quantity only**; over-tolerance or under-tolerance readings raise a variance event that QC and procurement subscribe to. This event model feeds FR-W-02 (Receiving) and FR-P-06 (Goods Receipt and Quality Inspection) and posts to the ERP via INT-ERP-02 and INT-ERP-03.
- **INT-LOC-01 - Event-Sourced Location:** Physical location must be event-sourced rather than overwritten in place. A physical `LocationAsserted` fact (where the stock actually is, stamped with who, device, timestamp, and a confidence weight) is stored separately from the `LocationExpected` fact (where the ASN or plan said it should go). A divergence between them raises a `LocationDisputed` flag for review rather than silently merging. Last-writer-wins is banned for location: no location fact is ever overwritten, only superseded by a newer stamped assertion. This underpins FR-I-01 (multi-location stock tracking) and FR-W-03 (Putaway).

## 6.9 Statutory Tax Platforms

- **INT-GST-01 - E-Invoice (IRP):** The SCM system raises invoice-request events for scrap sales, branch transfers, and job-work invoices through the ERP invoicing flow to the Invoice Registration Portal, consumes the returned IRN and signed QR, and enforces the FR-AC-14 dispatch block. The ERP remains the invoice issuer per A-02.
- **INT-GST-02 - E-Way Bill (NIC Portal):** Generate, update (Part B vehicle details), and cancel e-way bills from dispatch events with consignment value above Rs 50,000, including job-work challan movements and scrap liftings; FR-SC raises the trigger with weight, transporter, and vehicle fields.
- **INT-GST-03 - GST Compliance Export:** Export the ITC register, s.17(5)(h) reversal notes, and ITC-04 challan data to the company's GST filing stack in return-ready format.

## 6.10 Waste and Disposal Channels

- **INT-EPR-01 - CPCB EPR Portal:** Document exchange for e-waste, battery, and non-ferrous scrap transactions; acknowledgments recorded against disposal lots, with manual upload acceptable in the first phase.
- **INT-AUC-01 - External E-Auction Venue:** Optional external e-auction service (e.g., MSTC) as an alternate bid venue; lot, bidder, and result data sync back into FR-SC-13 records.

## 6.11 Machine Metering and Status

- **INT-MTR-01 - Meter Ingestion:** Ingest machine-hour and cycle-count readings into maintenance usage meters (FR-M-03) from maker-hub booking closures (FR-RD-14) and from station equipment and weigh scales (INT-DC-03); operator-entered mobile readings fill gaps for MHE and DG sets.
- **INT-MTR-02 - Machine Status Feed:** Event feed of asset status changes (FR-M-16) to production planning and the maker-hub booking calendar within 2 minutes, consumed by FR-RD booking flows and plant scheduling.

## 6.12 Design Tools

- **INT-CAD-01 - R&D BOM Import:** Import structured BOM exports (CSV or neutral PLM/CAD formats) from R&D design tools into Draft R&D BOMs, creating unmatched items as placeholders per FR-B-09.

## 6.13 Customs and MSME Portals

- **INT-CUS-01 - ICEGATE:** Bill of Entry data feed, by direct enquiry or via GSTR-2B import IGST auto-population, driving FR-IM-08 reconciliation against the FR-AC-07 register.
- **INT-MSME-01 - Udyam Portal:** Supplier Udyam registration verification, manual or API where available, for FR-P-09 classification capture and annual revalidation.

## 6.14 Payments

- **INT-PAY-01 - Hub Payment Gateway:** UPI dynamic QR and card terminal integration at the maker-hub counter per FR-RD-20, storing the gateway reference per invoice and exporting end-of-day settlement data for reconciliation.
