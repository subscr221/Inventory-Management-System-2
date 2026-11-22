# Epic 10 Context: R&D and Maker-Hub Operations

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

R&D project managers issue materials against live project codes under committed-plus-actual budget control, with three distinct issue semantics. Prototype builds (including failed ones) keep full material history. Maker-hub operators run offline point-of-use sales with UPI/card capture and end-of-day reconciliation. Every rupee of R&D spend feeds Form 3CL without year-end archaeology, and Ind AS 38 research-vs-development classification applies from the first transaction with no retroactive reinstatement.

## Stories

- Story 10.1: R&D and Maker-Hub Location Types and Project Master
- Story 10.2: R&D Requisition, Budget Check, and Issue Types
- Story 10.3: Project WIP Ledger and Prototype Build Records
- Story 10.4: Hub Member Records and Machine-Time Booking
- Story 10.5: R&D Physical Verification and Cost Reporting
- Story 10.6: Offline Point-of-Use Sale and Payment Capture
- Story 10.7: Member Job Cards and Statements

## Requirements & Constraints

- R&D store and maker-hub store are first-class location types with their own ledgers; movements appear only in the owning location's ledger.
- R&D-designated stock cannot be issued to non-R&D demand without approved reclassification (`CROSS_ISSUE_BLOCKED`).
- Project master carries code, owner, research/development phase tag, budget, status. Every R&D material transaction needs an active project code (`PROJECT_CODE_REQUIRED`).
- Requisition budget check is committed-plus-actual; a breach routes to project owner and R&D head (`APPROVAL_REQUIRED`).
- Issue types: consumable (expensed), project material (accumulates WIP), equipment custody (loan, with custody register: custodian, expected return, condition codes, overdue ageing).
- Ind AS 38: research phase expenses on issue. Development phase capitalizes only if a six-criteria checklist is fully met (checklist reference stored on the costing record); otherwise expense and `CAPITALIZATION_CRITERIA_NOT_MET`. Only costs from the date criteria are met are capitalized; retroactive reinstatement is rejected (`RETROACTIVE_REINSTATEMENT_BLOCKED`).
- Prototypes are non-saleable serialized class: dispatch/issue-to-dispatch blocked (`NON_SALEABLE_CLASS`); sales-order allocation check lands with Epic 15. Four dispositions (retain-as-asset, transfer-to-production, teardown, scrap) need R&D-head approval. Teardown/scrap lines go to a scrap-pending holding state (qty, condition code, source-prototype ref); routing to the scrap module is Phase 2 (Epic 16). Material returns reverse project WIP by returned cost.
- Every hub booking, sale, job card, and job-card entry references exactly one member or walk-in record (`MEMBER_REFERENCE_REQUIRED`).
- Machine-time booking closed by operator records actual time and meter reading; unclosed for 24h raises an exception.
- Verification: hub monthly, R&D quarterly, custodian confirmation of on-loan equipment (unconfirmed flagged).
- Project cost reports reconcile line-for-line to the store ledger, feed Form 3CL, and produce a project-wise, phase-tagged capitalizable-cost extract in the IAUD feed format (consumed by Epic 17 in Phase 2).
- Hub B2C invoices separate item-rate charges from machine-time service charges; material sales post to sales revenue, never misc income (`INVALID_REVENUE_CLASSIFICATION`).
- Every R&D cost ledger entry carries a funding-source tag (internal, DSIR, DST, grant); untagged is rejected (`UNTAGGED_TRANSACTION`); cost report subtotals by funding source.
- Offline sale: local stock decrement, billed at item rates to the referenced customer, blocked if over locally known stock (`INSUFFICIENT_STOCK`). Replay conflicts that would drive stock negative park as sync exceptions (`STREAM_CONFLICT`), never silently dropped. Reorder below control level via FR-I-03.
- Payments: UPI dynamic QR or card terminal with gateway reference (INT-PAY-01). Failed/timed-out payment leaves the sale unpaid (`PAYMENT_NOT_CONFIRMED`) with retry or alternate method. End-of-day reconciliation raises an exception per mismatch, which must be resolved or escalated before day close.
- Job cards collect bookings, machine hours, and purchases (date, qty, amount), reconcile to the source transaction, with on-demand and monthly statements (bookings, hours, purchases, payments, outstanding balance); the monthly run is recorded as complete.

## Technical Decisions

- Offline replay goes through the Epic 1 offline edge shell (Story 1.8); hub is Tier 1 offline-first capture.
- Error codes above are the API contract; use them exactly.
- Meter readings feed the FR-M-03 usage-meter register (Epic 7); retain-as-asset creates an Epic 7 asset-register entry; transfer-to-production records a production-reference designation.
- Budget approval routing follows the DOA registry pattern used elsewhere (R&D head as approver here).

## Cross-Story Dependencies

- Depends on Epics 1, 2, 4, 7.
- 10.1 (locations, project master, project-code gate) underpins all other stories; 10.2 issue and phase logic feeds 10.3 WIP and 10.5 costing.
- 10.4 member records are required by 10.6 sales and 10.7 job cards; 10.6 sales feed 10.5 B2C invoicing and 10.7 statements.
- Epic 11 depends on Epic 10; Epic 15 (sales-order allocation) and Epic 16 (scrap routing) and Epic 17 (IAUD ledger) consume Epic 10 outputs later without rework.
