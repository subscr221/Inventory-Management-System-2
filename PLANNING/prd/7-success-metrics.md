# 7. Success Metrics

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
