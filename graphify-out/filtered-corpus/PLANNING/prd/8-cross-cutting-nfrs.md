# 8. Cross-Cutting NFRs

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
