# 3. Glossary

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
