# Story 7.7 Group C Review - Blind Hunter (Adversarial)

Reviewed: `_bmad-output/diff-7-7-group-c.patch` (regenerated, full-file diff of
`test/integration/story-7-7.test.ts`). Assertions cross-checked against
`src/compliance/maintenance-fault.ts`, `src/compliance/maintenance-coverage.ts`,
`src/maintenance/coverage-jobs.ts`, `src/api/v1/maintenance.ts`,
`src/read/projections/asset_coverage.ts`. Date: 2026-08-27. Line refs are test-file lines.

## Findings

### CB1. WORK_ORDER_ALREADY_COMPLETED test cannot detect loss of the guard it is named after - HIGH

Lines 1364-1386. The assertion accepts either `WORK_ORDER_ALREADY_COMPLETED` or
`WARRANTY_OVERRIDE_ALREADY_RECORDED` (1381-1385). Because an override was recorded on the same
work order at 1375, the duplicate-override guard (`maintenance-coverage.ts:611-614`) would 409
anyway; if the completed-status check (`maintenance-coverage.ts:543`) were deleted or
reordered, this test stays green. The comment at 1378 ("A second work order on the same asset,
so the grain is free") describes code that does not exist - no second work order is created.
The named behavior is effectively unpinned.

### CB2. Production scan shape - no `asset_id` filter - never exercised successfully - HIGH

Every 200-path scan passes `asset_id` (616, 647-649, 678-680, 693, 739, 767, 789, 798, 813,
855, 868, 1718). The only unfiltered scans asserted are the 400 (896-908) and 403 (1753-1760)
paths. A broken unfiltered query in `listCoverageStagesDue` - the shape the nightly job
actually runs - would ship green.

### CB3. "DECLARED warranty_flagged" forgery test proves presence-rejection, not mismatch detection - MEDIUM

Lines 1011-1082. `maintenance-fault.ts:587` rejects whenever the key is present, regardless of
value. The test forges `warranty_flagged: false` against an active warranty and frames it as
catching a lie (comment at 1067), but a truthful declaration is rejected identically; the
elaborate SLA/policy/due-date reconstruction (1031-1048) adds nothing the seam inspects for
this rejection. Fail-closed behavior is fine; the test's claim is overstated and its setup is
dead weight.

### CB4. No concurrency test for the scan itself - MEDIUM

Override and duplicate-coverage races are pinned (1348-1361, 1552-1566), but two parallel
scans on one `business_date` - the exact double-notification race the row lock at
`coverage-jobs.ts:158-168` exists to serialize - are untested. A regression there double-pages
the supervisor and no test notices.

### CB5. Stage-boundary off-by-ones unpinned - MEDIUM

No scan at exactly `expiry_date` (0 days remaining), none at `expiry-91` vs `expiry-89`; the
already-expired test scans only at `expiry+1` (813). The inclusive/exclusive choices in the
stage predicate and in `expiry_date >= business_date` (`asset_coverage.ts:182`) could flip by
one day without any test failing. The far-policy "not due yet" check (774-778) covers only
"way outside the window".

### CB6. Order-coupled APPROVAL_UNRESOLVED test breaks under shuffle, partial runs, or sibling seeding - MEDIUM

Lines 1084-1108. It requires zero `maintenance.warranty_override` DOA rows and every later
AC3/AC4 test seeds one permanently (`seedWarrantyOverrideDoa`, 447-466). The precondition
assert (1091-1095) makes the coupling loud, but under `--test-name-pattern`, `--test-shuffle`,
or any future concurrency the test hard-fails instead of testing anything. It also sits under
the AC2 banner (misfiled), and the helper comment at 441 says "the APPROVAL_UNRESOLVED test
above" when the test is declared below the helper.

### CB7. `notificationFor` LIMIT 1 with nondeterministic tiebreak can hide duplicate emissions - MEDIUM

Lines 389-410: `ORDER BY created_at DESC, event_id DESC` tiebreaks on a random UUID. In the
escalation test (638-671) per-stage notification counts are never asserted, so a duplicated
90-day notification (one with escalation, one without) could pass or fail by which row
surfaces. Exactly-once counting exists only in the three-type test (629-635) and only for
`maintenance_manager`.

### CB8. RBAC coverage for new surfaces partial - MEDIUM

Lines 1740-1761 cover only coverage-record (401/403) and scan (read-scope 403). Untested:
401/403 on GET coverage-by-id, GET alerts, GET/POST warranty-overrides with the procurement
user; technician invoking the scan. The 403 at 1273-1276 tests DOA approver resolution, not
module RBAC - a missing module guard on the override route would go unseen.

### CB9. `notifications_dropped > 0` reconciliation counter has no test - MEDIUM

The suite asserts `dropped: 0` (620, 711) and guards that recipients exist (592-601), but
never exercises the zero-recipient/emit-failure path that `coverage-jobs.ts:258-262` counts.
The very failure mode the "Story 7.4 lesson" comment (568-569) warns about is unpinned.

### CB10. Projection-only fixtures create states unreachable through any write path - LOW

`insertCoverageFixture` (223-246) and `insertPreventiveWorkOrder` (293-303) insert projection
rows with no backing domain event; the preventive fixture invents a `plan_id` with no plan
row, then the completion seam is exercised against it (1007-1008). The future-start warranty
(965) tests a state the API's own fail-closed gates forbid creating. If any seam later
re-derives from events, these tests pass against impossible state or fail confusingly.

### CB11. Documented renewal-overlap behavior dodged despite the test's name - LOW

`coverage-jobs.ts:120-124` documents that a renewal recorded before lapse leaves BOTH rows
raising stages (deferred-work). The "renewal earns a fresh set of stages" test (781-806) scans
only at `renewalExpiry-90`, where the original is already expired (comment at 800), so the
overlap window - the only interesting case - is never observed and could change silently in
either direction.

### CB12. Last-expiring-warranty tiebreak untested - LOW

Test at 972-992 pins `ORDER BY expiry_date DESC`, but the deterministic `coverage_id ASC`
tiebreak the source explicitly promises for equal expiries (`asset_coverage.ts:166-167, 183`)
has no test.

### CB13. Assorted false-precision and robustness nits - LOW

(a) `TODAY` captured once at module load (132) while the accept handler reads the wall clock
per request (`maintenance.ts:1403`); margins hold only because the clock moves forward and the
expired fixture (964, `expiry = TODAY-1`) sits exactly one day from the boundary -
undocumented. (b) `REASON_CODE = ...warrantyOverrideReasonCodes[0]!` (134) crashes the whole
file with a bare TypeError if config is empty, instead of a meaningful assert. (c) Scan
statuses unchecked at 647-649, 718, 789 and the override-read status at 1285, producing
misleading failure messages on a 500. (d) `escalation_window` hard-coded `'86400'` (664)
rather than referenced from the constant it duplicates (`coverage-jobs.ts:68`).

## What checked out

Load-bearing assertions match reality: D5 suppression counters, `alert_ids` ordering
(stage ASC = most-urgent-first), `coverages_evaluated` semantics, and the ledger/message split
all match `coverage-jobs.ts:126-274`; the last-expiring-warranty pick matches
`asset_coverage.ts:170-188`; the seam rejection codes and their order match
`maintenance-coverage.ts`. The per-asset scan filter is implicitly proven correct by
cross-test contamination that would otherwise inflate `alerts_raised`.
