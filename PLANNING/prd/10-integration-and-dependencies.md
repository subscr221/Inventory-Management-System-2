# 10. Integration and Dependencies

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
