# Story 7.7 Group C Review - Acceptance Auditor

Reviewed: `_bmad-output/diff-7-7-group-c.patch` (regenerated, 1762-line full-file diff of
`test/integration/story-7-7.test.ts`) against the story spec. Date: 2026-08-27.

## Findings (ordered by severity)

### CA1. WORK_ORDER_NOT_FOUND has zero tests

Violates Table 4 (spec line 314: "Every code must appear in at least one test"; code listed at
line 331). `grep -c WORK_ORDER_NOT_FOUND test/integration/story-7-7.test.ts` returns 0. No test
hits the override POST, override GET, or completion route with an unknown work_order_id -
notable since the Group B patch (spec line 209) changed the override GET from 200-null to 404
for a missing work order, and that new behavior is unpinned.

### CA2. WORK_ORDER_ALREADY_COMPLETED test accepts two codes and its fixture contradicts its comment

Violates Task 8.5 ("an override after completion rejects 409 `WORK_ORDER_ALREADY_COMPLETED`").
Patch lines 1384-1391: the comment says "A second work order on the same asset, so the grain is
free," but line 1385 re-posts to the SAME `workOrderId` that already holds the override from
line 1381, then asserts
`error_code === 'WORK_ORDER_ALREADY_COMPLETED' || error_code === 'WARRANTY_OVERRIDE_ALREADY_RECORDED'`.
The test passes even if the completed-order gate is deleted entirely, so the spec's code is
effectively untested (fails the "a test that only asserts 200 is not coverage" bar, line 376).

### CA3. Preventive-work-order regression test bypasses the Story 7.2 path it claims to test

Deviates from Task 8.3 ("a preventive work order generated through the Story 7.2 path is never
flagged") and Binding Decision 2. Patch lines 298-309 insert the preventive WO by raw SQL
(`insertPreventiveWorkOrder`), so lines 1000-1011 only prove the column `DEFAULT false`, not
that the PM-generation seam skips the warranty check.

### CA4. No forgery test for a declared `warranty_coverage_id` on the breakdown path

Violates Testing Requirements line 378 ("forgery tests for every derived field") and Task 4.3
(both declared fields reject). Patch lines 1073-1075 declare only `warranty_flagged: false`.
The coverage-id-only branch was even specifically patched in Group B (spec line 210: the
rejection message wrongly named `warranty_flagged`) and remains untested.

### CA5. Two tests pin contracts the spec never amended

Contradiction between spec text and asserted behavior:

- Patch lines 825-857 assert 409 `COVERAGE_DERIVATION_MISMATCH` for a forged not-yet-due
  `stage_days`; Table 4 (line 324) enumerates that code only for
  recorded_by/overridden_by/warranty_coverage_id/asset_id/coverage_type/expiry_date divergence -
  `stage_days` due-ness is not in the contract (the Group B fix at spec line 201 never updated
  Table 4).
- Patch lines 716-721 assert `notifications_suppressed`; Task 6.1 (spec line 104) pins the scan
  result shape without that field (D5 added it in code only).

Both assertions were flagged UNVERIFIED in the Session Handoff; they now pass against a live
database (42/42 run of 2026-08-27), but the spec text still disagrees.

### CA6. Cross-event-type idempotency-reuse test omits the event type detail

Task 8.6 (line 141): "rejects 409 `DUPLICATE_EVENT` with the existing event id and type." Patch
line 1675 asserts only `existing_event_id`.

### CA7. Race-path losers assert presence, not identity, of the existing id

Task 8.5/8.6 require the race path to return "the SAME code and SAME existing-id detail"
(line 377). Patch line 1362 (`assert.ok(...existing_override_id, ...)`) and line 1572
(`existing_coverage_id` truthy) never compare against the winner's id, unlike the sequential
paths (lines 1342, 1547). A resolver returning a wrong row's id would pass.

### CA8. APPROVAL_UNRESOLVED tested by order-coupled placement, not the specified DOA-entry deletion

Task 8.5 says "deleting the DOA entry rejects 404 APPROVAL_UNRESOLVED." Patch lines 1090-1114
instead run before seeding, guarded by a precondition assert (lines 1093-1101), and the test
sits inside the AC2 section despite its AC4 title. Functionally equivalent coverage, but the
suite becomes declaration-order-dependent and the deletion/deactivation path is never exercised.
(The test's DOA route `/api/v1/doa/entries` is correct against src/server.ts:380; spec Task
5.3's `POST /api/v1/doa-entries` is the erratum.)

### CA9. "With and without cost fields" matrix half-covered

Task 8.4: unflagged breakdown and preventive orders complete "with and without the Story 7.6
cost fields." Patch: unflagged breakdown completes only WITH costs (lines 1179-1188);
preventive only WITHOUT costs (lines 1013-1014). Breakdown-no-costs and preventive-with-costs
are untested.

### CA10. Binding Decision 4 tie-break untested

"Tie-broken on the lowest coverage_id" (spec line 46). The two-warranty test (patch lines
978-998) uses distinct expiries only; the equal-expiry tie path never runs.

### CA11. Fan-out asserted by proxy, not by delivery

Task 8.2: "assert fan-out resolves to a real user." Patch lines 429-436 and 598-607 count
`user_role_assignments` rows and trust the scan's `notifications_delivered` counter; no test
reads delivery/dispatch rows to confirm a recipient user actually resolved - weaker than the
Story 7.4 zero-recipient lesson the spec cites.

### CA12. Minor

The renewal test (lines 787-811) verifies only the 90-day stage of the "fresh 90/60/30 set";
the scan route has no idempotency-key replay test (Table 2 classes it a write route; the
same-day no-op test at lines 679-691 covers semantic idempotence only - consistent with the
7.5 scan precedent, so likely intentional).

## What the suite does well

All four ACs have failing-first-capable tests: 90/60/30 staged alerts with exact-stage runs,
30-only escalation with the 86400 window, catch-up most-urgent-first, D5 suppression, warranty
flag plus payload write-back at breakdown creation, AD-12 seam-bypass proofs for both the
completion gate and forged overrides, DOA authority 403/404. 14 of 16 Table 4 codes appear
(all except WORK_ORDER_NOT_FOUND outright, and WORK_ORDER_ALREADY_COMPLETED only
disjunctively).
