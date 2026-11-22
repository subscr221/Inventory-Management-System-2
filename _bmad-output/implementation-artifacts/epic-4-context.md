# Epic 4 Context: Procurement and Supplier Management

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Procurement officers run the full source-to-pay cycle: supplier registry, requisition, purchase order, goods receipt, three-way invoice match. Floor supervisors raise indents from a phone in under 90 seconds and always see live status, with push notifications on every decision. Every PO carries DOA-gated approval by amount and category, and MSME payment discipline is enforced at source. Tender management is deferred to Phase 2 (Epic 14).

## Stories

- Story 4.1: Supplier Registry and Onboarding
- Story 4.2: Supplier Performance Scorecards
- Story 4.3: Purchase Requisition and Indent Loop
- Story 4.4: Purchase Order Management
- Story 4.5: Goods Receipt and Three-Way Match
- Story 4.6: MSME Compliance Tracking
- Story 4.7: Supplier Invoice Capture
- Story 4.8: Standing Approvals and Self-Approval Limits
- Story 4.9: Indent Approver Resolution Fallback
- Story 4.10: Requisition Line-Level Approval and Mixed Routing
- Story 4.11: Stores Counter Issue Against a Requisition
- Story 4.12: Approvals Inbox and Requisition Approval Detail
- Story 4.13: Requisition Ask for Info

## Requirements & Constraints

- Indent approval rules are configured by amount band, item category and requesting department. The approver is resolved from the DOA registry, never hard-coded. The indent stays `APPROVAL_REQUIRED` until that authority acts. Rule changes go to the edit log and apply only to later submissions.
- Indents need a business-stream tag (`UNTAGGED_TRANSACTION` otherwise). Duplicate open indents by the same requester are flagged `DUPLICATE_EVENT`; offline duplicates are held in `pending-confirmation` at sync, never dropped.
- Header statuses: raised, approved, rejected, ordered, cancelled, closed. Rejection needs a reason; decisions push-notify the requester.
- Fallback for an indent matching no DOA band: route to the requester's head of department band (UX ruling Q6). The requester's status view must show who it waits on and why. If no head of department exists, reject at capture with an actionable error naming the missing configuration. Never store an indent without an approver path.
- Pilot bands: head of department up to Rs 1,00,000, finance controller above (owner confirmation and seeding are in 4.10).
- SOD-01: requester cannot approve own indent (`INDENT_RAISER_CANNOT_APPROVE`), except within a per-person self-approval limit (amended by 4.8).
- Standing approval (4.8): grant `SA-YYYY-NNN` ties one user to one SKU or item group, optional monthly quantity cap and end date, inactive until one-time finance head sign-off. Lines over cap or out of scope fall back to the normal DOA path for that line only, never rejected. Instant revoke; auto-revoke on account disable.

## Technical Decisions

- Defect to fix in 4.9: no band match stores the indent without an approver, then approval refuses with `NOT_RESOLVED_APPROVER` (`src/compliance/indent.ts:599-603`).
- 4.9 must also re-resolve already-stuck `NOT_RESOLVED_APPROVER` indents through the fallback, or list them as exceptions for manual routing, and add a regression test that an unmatched indent never persists without an approver path.
- Approval decisions go through the seam `decideAsApprover` in `src/compliance/indent.ts` (identity enforced per line; approver or active delegate). Indent events are persisted on the procurement stream.
- 4.10 moves routing to per-line: each line has `approval_route` (`doa`, `standing_approval`, `self_approval`) and `line_status`; header status derives from lines; the document is never split. The no-band fallback then resolves per line. Existing whole-indent approvals migrate so each line inherits the header decision. Bands are `indent_approval` entries in the DOA registry, seeded for staging and pilot, with a band-boundary regression test.
- DOA registry lives in `src/read/projections/doa_registry.ts`.
- Stable error codes are used throughout and surfaced in the edge app through `errorMessage()`.

## Cross-Story Dependencies

- 4.9 sits inside done 4.3's flow and lands before 4.10. 4.10 must coordinate with 4.9 (per-line fallback).
- 4.8 depends on 1.16 (site head role), 2.10 (item groups), 4.10 (line routing) and 4.11 (counter issue); lines over a standing-approval cap re-enter 4.10 DOA routing.
- 4.12 (approvals inbox) depends on 4.10, 4.3, 1.15 and 1.8, and shows fallback and band notes. 4.13 depends on 4.12.
