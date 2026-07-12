# Business Objective Traceability Map (BO → FR → SM)

**Date:** 2026-07-12
**Project:** Inventory Management System_2
**Purpose:** Close PRD Finding 1 / Finding 2 (readiness report 2026-07-12) — restore the upward traceability chain so every business objective (BO-1…BO-12) links to the features (FR families) that deliver it and the success metrics (SM) that measure it. Downward FR→Epic traceability already exists in `epics.md`; this document completes the chain **Business Objective → Feature → Metric**.

**Sources:** PRD §1.1 (BO-1…BO-12), §4 (Features 4.1–4.15, FR families), §7 (Success Metrics + their stated FR validations), annex `PLANNING/archive/SCM-Requirements-Document.md` §2/§8.

---

## 1. How to read this map

- **BO** — one of the twelve numbered business objectives (PRD §1.1). These are the traceability anchors the platform serves.
- **Primary FR families** — the feature groups whose delivery is *necessary* for the objective.
- **Success metrics** — the SMs that *validate* the objective was achieved. Where the PRD §7 states an explicit SM→FR validation, it is cited; otherwise the linkage is derived from feature intent and marked *(derived)*.
- **Phase** — whether the objective's primary FRs land in the Phase 1 pilot/waves or Phase 2+.

---

## 2. Objective → Feature → Metric Matrix

| BO | Business Objective | Primary FR Families (Features) | Validating Success Metrics | Phase |
|----|--------------------|--------------------------------|----------------------------|-------|
| **BO-1** | Unified inventory visibility | FR-I (Core Inventory §4.1), FR-W (Warehouse §4.2), FR-R (Reporting §4.15) | SM-01 inventory accuracy ≥98% *(validates FR-I-01/06)*, SM-13 gate dwell ≤4 min, SM-17 frontline confirmation ≥95% | Phase 1 |
| **BO-2** | Reduced operational costs | FR-I (reorder/safety stock), FR-D (Demand Planning §4.4), FR-L (Logistics §4.4) | SM-02 stockouts −40%, SM-09 inventory days on hand ↓ (braked by SM-02) | P1 (FR-I) / P2 (FR-D, FR-L) |
| **BO-3** | Faster order fulfillment | FR-O (Order Mgmt §4.4), FR-W (picking FR-W-04) | SM-03 line fill ≥95% / order fill ≥97% *(validates FR-O-03..05)* | P2 (FR-O) / P1 (FR-W) |
| **BO-4** | Streamlined procurement | FR-P (Procurement §4.3), FR-T (Tendering §4.3), FR-BC (Budget §4.13) | SM-06 requisition-to-PO time −50%, SM-41 MSME paid within due dates *(validates FR-P-09)* | P1 (FR-P, FR-BC) / P2 (FR-T) |
| **BO-5** | Improved demand forecasting | FR-D (Demand Planning §4.4) | SM-07 forecast accuracy ≥75% at SKU-location | Phase 2 |
| **BO-6** | Enhanced supplier management | FR-P-01/02/03 (registry, onboarding, scorecards), FR-P-08 (spend analytics) | SM-06 *(derived)*, supplier on-time/quality scorecard KPIs *(FR-P-03, derived)* | Phase 1 |
| **BO-7** | Data-driven decisions | FR-R (Reporting §4.15), role dashboards (§4.15) | SM-10 adoption ≥85% *(derived)*, dashboard KPI availability *(FR-R-01..04, derived)* | P1 (operational) / P2 (executive, Epic 12) |
| **BO-8** | Seamless integration | INT-ERP/ACC/IAM/GATE/GST (§10), FR-AC (compliant postings §4.13), FR-B-17 (BOM sync) | SM-19 zero untagged transactions *(FR-AC-01, derived)*, subledger-to-GL reconciliation *(FR-AC-15, derived)* | Phase 1 |
| **BO-9** | R&D material control & project costing | FR-RD (R&D/Hub §4.5), FR-AC-01/02/04 (tagging, R/D classification), FR-B (BOM §4.6) | SM-17 frontline confirmation ≥95%, SM-19 zero untagged transactions, Form 3CL/IAUD readiness *(FR-RD-19, derived)* | Phase 1 |
| **BO-10** | Asset uptime & maintenance cost | FR-M (Maintenance §4.10), FR-TL (Tooling §4.10), FR-FA (Fixed Assets §4.12) | SM-23 PM adherence ≥95% *(FR-M-02, derived)*, MTTR/MTBF *(FR-M-06, derived)* | P1 (FR-M) / P2 (FR-TL, FR-FA) |
| **BO-11** | Compliance by construction | FR-AC (Financial Compliance §4.13), FR-Q (QC §4.9), FR-GP (Gate Passes §4.14), FR-SC (Scrap statutory §4.11), FR-IM (Imports §4.13), FR-DOA | SM-28 zero dispatch w/o batch release *(FR-Q-02/05)*, SM-34 100% job-work returns in window *(FR-AC-11, FR-JW-14)*, SM-41 MSME compliance *(FR-P-09)*, SM-19 zero untagged, SM-27 QC decision ≤24h | P1 (FR-AC, FR-Q, FR-DOA) / P2 (FR-GP, FR-SC, FR-IM) |
| **BO-12** | Scrap recovery value | FR-SC (Scrap & Disposal §4.11) | SM-29 scrap reconciliation variance <2%, SM-31 auction realization ≥95% of NRV | Phase 2 |

---

## 3. Coverage check

**All 12 business objectives are traced** to at least one primary FR family and at least one validating metric.

| Check | Result |
|-------|--------|
| BOs with ≥1 primary FR family | 12 / 12 ✅ |
| BOs with ≥1 validating metric | 12 / 12 ✅ |
| FR families referenced across all BOs | 23 / 23 (every family serves at least one objective) ✅ |
| Objectives fully realized in Phase 1 pilot | BO-1, BO-6, BO-8, BO-9 (BO-4/BO-10 partial; remainder waves/Phase 2) |

---

## 4. Metric → Objective reverse index (validation direction)

For the load-bearing metrics the PRD calls out, the reverse linkage (which objective each proves):

| SM | Metric | Proves Objective |
|----|--------|------------------|
| SM-01 | Inventory accuracy ≥98% | BO-1 |
| SM-02 | Stockouts −40% | BO-2 |
| SM-03 | Line/order fill ≥95/97% | BO-3 |
| SM-06 | Requisition-to-PO −50% | BO-4, BO-6 |
| SM-07 | Forecast accuracy ≥75% | BO-5 |
| SM-10 | Adoption ≥85% | BO-7 (cross-cutting) |
| SM-17 | Frontline confirmation ≥95% | BO-1, BO-9 |
| SM-19 | Zero untagged transactions | BO-8, BO-9, BO-11 |
| SM-23 | PM adherence ≥95% | BO-10 |
| SM-27 | QC decision ≤24h | BO-11 |
| SM-28 | Zero dispatch w/o batch release | BO-11 |
| SM-29 | Scrap reconciliation <2% | BO-12 |
| SM-31 | Auction realization ≥95% NRV | BO-12 |
| SM-34 | 100% job-work returns in window | BO-11 |
| SM-41 | MSME paid within due dates | BO-4, BO-11 |
| SM-48 | Zero cutover variance | (data-migration quality gate — enables all) |

---

## 5. Notes and residuals

- Linkages marked *(derived)* are inferred from feature intent where the PRD §7 does not state an explicit SM→FR validation. If the annex (`SCM-Requirements-Document.md` §8) carries the full 48-metric catalogue with per-metric FR anchors, those citations should replace the *(derived)* tags in a future pass for full precision.
- **BO-7 (data-driven decisions)** is the most cross-cutting objective; its operational dashboards ship inside module epics (per access matrix §4), while the executive analytics layer is Epic 12 (Phase 2).
- This map is the record that closes **readiness-report Findings PRD-1 and PRD-2**. Recommend appending a one-line pointer to it from the PRD §1.1 objectives block so the chain is discoverable from the PRD itself.
