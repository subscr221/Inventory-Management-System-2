# 6. MVP Scope

Delivery approach (confirmed 2026-07-10): **spine-first custom build over a 36-month program**. The compliance spine (statutory edit log, DOA registry, event-sourced location, calibration and statutory lockouts, business-stream tagging) is built and acceptance-tested first as the platform layer every module sits on; modules then land in waves. Phasing follows revenue exposure, pulling job-work services and R&D/maker-hub tracking into Phase 1. The remaining wave boundary is proposed for confirmation. `[ASSUMPTION: apart from the confirmed job-work and R&D placement, wave boundaries are PM-proposed from source dependencies (C-12, A-13, A-11), not stakeholder-agreed.]`

## 6.1 Phase 1 (first go-live)

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

## 6.2 Phase 2 and later

- Tender management, demand planning, logistics/TMS features, e-commerce and 3PL integrations.
- Fixed assets and intangibles, scrap/disposal/auction, imports, tooling, gate passes.
- Automated meter ingestion (INT-MTR-01) replacing operator-entered readings (A-10); CPCB EPR portal automation replacing manual upload (INT-EPR-01).

## 6.3 Out of Scope for MVP

Everything in §5, plus: multi-country data residency (resolved out of scope: India only, see §14 question 1), RFID and IoT beyond barcode scanning where not already deployed, put-to-light picking.
