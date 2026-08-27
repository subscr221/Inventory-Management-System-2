# Code Review 7.7 Group B: Acceptance Auditor

Story: `_bmad-output/implementation-artifacts/7-7-amc-warranty-and-insurance-tracking.md`
Diff: `_bmad-output/diff-7-7-group-b.patch` (2621 lines), baseline `e93014f`, against the current
working tree (Group A code-review patches already applied).

Scope reviewed: `src/compliance/maintenance-coverage.ts`, `src/maintenance/coverage-jobs.ts`,
`src/api/v1/maintenance.ts`, `src/events/store.ts`, `src/config/index.ts`, `src/server.ts`,
`src/compliance/maintenance-fault.ts` (story Tasks 4, 5, 6 and 7). SQL projections, the event
schema, the migration list and the integration tests are out of scope and are not reported on.

## Context Documents

The story frontmatter carries only `baseline_commit`; there is no `context` field, so no context
documents were requested and none are missing. The `### References` section resolves against files
that exist in the repository (`epics.md`, the archived PRD, the access matrix, ARCHITECTURE-SPINE.md,
`docs/adr/ADR-001-notification-emission-coupling.md`, the Story 7.3, 7.5 and 7.6 story files, and
`deferred-work.md`). No unresolvable reference was found.

## Verdict on the Two Group A Review Decisions

Both decisions reach into this group, and the task asked for an explicit judgement on each.

**Review decision D5 (one notification per coverage per run) still satisfies AC 1.** AC 1 requires
that "alerts are raised at 90, 60, and 30 days before expiry". Every due and unfired stage still
gets its own `asset_coverage_alert` grain row and its own `maintenance.coverage_expiry_flagged`
event on every run [src/maintenance/coverage-jobs.ts:139-194], so no stage is ever lost from the
ledger and catch-up remains structural exactly as Binding Decision 7 and the Staged Alert Contract
pin it. Only the outbound message is deduplicated, and only within a single run. On the cadence
AC 1 actually describes, a scan run on the day each stage becomes due, exactly one stage is due per
run, so the manager still receives three separate notifications at 90, 60 and 30 days, with the
escalation clock attached to the 30-day one. The suppression bites only when several stages first
become due in the same run (a coverage recorded inside the 90-day window, or a scan skipped for
weeks), and the message that survives is the most urgent one, because `listCoverageStagesDue`
orders `stage_days ASC` within a coverage and `notifiedCoverages` is populated by the first stage
that commits. AC 1 is met.

**Review decision D1 (narrow to the current coverage per `(asset_id, coverage_type)`) does NOT
fully satisfy AC 1.** It closes the renewal case it was aimed at, but it also silently removes a
whole class of live contracts from the scan. See finding 1.

## Findings

- **AC 1 is violated for any asset carrying two concurrently live coverages of the same
  `coverage_type`: only the later-expiring one is ever alerted.** Violates AC 1 ("Given assets under
  AMC, warranty, or insurance ... alerts are raised at 90, 60, and 30 days before expiry") and sits
  against Binding Decision 13, which folds AMC, warranty and insurance into one table distinguished
  only by `coverage_type`, and Binding Decision 5, which makes every record an independent
  append-only row with no supersede relationship. The Group A D1 patch wraps the scan in
  `WITH current_coverage AS (SELECT DISTINCT ON (asset_id, coverage_type) * ... ORDER BY asset_id,
  coverage_type, expiry_date DESC, coverage_id ASC)`
  [src/read/projections/asset_coverage.ts:311-318, consumed at src/maintenance/coverage-jobs.ts:121].
  `uq_asset_coverage_reference` keys on `(asset_id, coverage_type, lower(reference_number_ext))`, so
  many concurrent rows per `(asset_id, coverage_type)` are legal by construction, and the realistic
  cases are ordinary: two insurance policies on one machine covering different perils, or a short
  bridging cover note recorded alongside a longer master policy. In every such case the row that
  lapses FIRST is the one `DISTINCT ON ... expiry_date DESC` discards, so the contract most in need
  of a warning is precisely the one that receives none, at any stage, ever. Nothing in the code or
  the ledger records that it was skipped. Note also that D1 was justified in its docblock by "there
  is no supersede path", but the narrowing it applies IS an implicit supersede rule, applied by the
  scan only and never agreed by Binding Decision 5.

- **The staged-alert grain can be permanently poisoned through the direct-event path, because the
  expiry-flag applier never re-derives stage due-ness.** Violates AC 1 read together with the Staged
  Alert Contract ("Stage-due test in SQL: `(expiry_date - business_date) <= stage_days AND
  expiry_date >= business_date`") and the AD-12 guardrail that the seam, not the handler, is the
  gate. `applyCoverageExpiryFlagged` re-derives `asset_id`, `coverage_type` and `expiry_date`
  against the locked row and checks that the coverage has not lapsed, but it never checks that the
  declared `stage_days` is actually due [src/compliance/maintenance-coverage.ts:400-446, patch lines
  1565-1646]. A direct `persistEvent` of `maintenance.coverage_expiry_flagged` with
  `stage_days: 30` against a coverage 300 days from expiry is accepted, occupies the
  `(coverage_id, 30)` grain, and because `listCoverageStagesDue` joins on `a.alert_id IS NULL` the
  real 30-day warning, the only stage that carries the `maintenance_supervisor` escalation, can then
  never fire for that contract. Task 4.2 lists the re-derivations for this applier and omits the
  due-ness test, so the implementation follows the spec text, but the resulting hole is an AC 1 hole.

- **`APPROVAL_UNRESOLVED` is returned with two different HTTP statuses on the warranty override
  route.** Deviates from the Error Code Contract (Table 4: `APPROVAL_UNRESOLVED | 404 | override
  handler and applier`). When no DOA entry governs `maintenance.warranty_override`, the handler and
  the seam raise 404 as pinned [src/api/v1/maintenance.ts:4219-4226,
  src/compliance/maintenance-coverage.ts:544-552, patch lines 1060-1066 and 1729-1736]. When a DOA
  entry exists but no active holder or delegate resolves for its role, the shared `resolveApprover`
  throws 409 `APPROVAL_UNRESOLVED` before either of those branches is reached
  [src/api/v1/indents.ts:97-104]. Removing the `maintenance_supervisor` holder while leaving the DOA
  entry in place is a reachable configuration. This exact defect is logged in `deferred-work.md`,
  but under the Story 6.1 Group B heading, not under either Story 7.7 heading, so it is reported
  here for the 7.7 route surface.

- **The seam rejects malformed coverage payloads with `INVALID_PAYLOAD`, a code the Error Code
  Contract does not list.** Deviates from Table 4, whose only 400-class entry is `INVALID_PARAMS`
  ("reused (platform) | Shape failures incl. impossible calendar dates"), and from the story's
  statement that Table 4 "lists every code this story introduces or reuses". All three shape asserts
  raise `INVALID_PAYLOAD` [src/compliance/maintenance-coverage.ts:135-282, patch lines 1309-1433],
  so the same failure class returns `INVALID_PARAMS` through the REST handlers and `INVALID_PAYLOAD`
  through a direct event. This matches the sibling seams (`asset-operational-status.ts`,
  `maintenance-statutory.ts` and `calibration-register.ts` all use `INVALID_PAYLOAD`), so the code
  follows repository precedent; the contract table is what is incomplete.

- **`business_date` is documented as a filter on the cross-asset coverage list but is silently
  ignored, and unvalidated, unless `status` is also supplied.** Deviates from Task 7.1
  (`listCoveragesBase`: "GET with optional `asset_id`, `coverage_type`, `status`, `business_date`
  filters and paging"). `coverageStatusFilter` returns `{ ok: true, status: undefined, businessDate:
  undefined }` and never reads the `business_date` parameter when `status` is absent
  [src/api/v1/maintenance.ts:3979-4005, patch lines 819-846]. A request such as
  `GET /api/v1/maintenance/coverages?business_date=2026-13-45` therefore returns 200 with an
  unfiltered list rather than the 400 every other date input in this story produces.

- **`coverages_evaluated` in the scan result counts coverage-stage rows, not coverages.** Deviates
  from Task 6.1, which names the result field `coverages_evaluated`, and blunts the Staged Alert
  Contract requirement that "Write counters and delivery counters stay SEPARATE in the scan result".
  `coverages_evaluated: dueStages.length` [src/maintenance/coverage-jobs.ts:229, patch line 2514]
  counts the `(coverage, stage)` cross-join rows, so one coverage with three due stages reports
  three coverages evaluated. Post-D5 this is actively misleading: a catch-up run reports
  `coverages_evaluated: 3`, `alerts_raised: 3` and `notifications_delivered: 1` for a single
  contract, and no counter in the result names how many coverages were actually looked at.

- **The record-coverage handler enforces no length bound on `provider_name` or
  `reference_number_ext`, so the handler and the seam disagree on the same input.** Deviates from
  Task 7.1, which requires the body to be "validated exactly as the shape assert". The seam caps
  both at `MAX_TEXT_LENGTH = 512` [src/compliance/maintenance-coverage.ts:82,144,152]; the handler
  checks only `trim() !== ''` [src/api/v1/maintenance.ts, patch lines 737-744]. A 600-character
  provider name passes the handler, then fails inside `persistEvent` as 400 `INVALID_PAYLOAD`
  instead of the handler's 400 `INVALID_PARAMS`, so one request yields a different error code
  depending on which layer catches it. The seam also measures the untrimmed string while the handler
  trims before persisting.

- **The seam resolves a non-approver override to 403 `APPROVAL_REQUIRED` where Task 4.2 specifies
  409 `COVERAGE_DERIVATION_MISMATCH`.** This is a spec-internal contradiction, recorded so the
  choice is on the record rather than as a defect. Task 4.2 says "a declared actor who is not the
  resolved approver rejects 409 `COVERAGE_DERIVATION_MISMATCH`"; Task 5.2 and Table 4 both say the
  non-approver case is 403 `APPROVAL_REQUIRED` ("override by a non-approver"). The implementation
  follows Table 4 and Task 5.2 [src/compliance/maintenance-coverage.ts:553-566, patch lines
  1737-1747], which is the correct reading: `overridden_by` is separately re-derived against the
  envelope actor immediately above (409 `COVERAGE_DERIVATION_MISMATCH`), so Task 4.2's clause could
  only ever fire for an actor who IS the declared user but is NOT the approver, which is an
  authority failure, not a derivation failure. No code change needed; Task 4.2's wording should be
  corrected instead.

- **The completion handler pre-check runs the warranty gate before any already-completed check, so
  it can shadow `WORK_ORDER_ALREADY_COMPLETED`.** Minor deviation from the check order Task 4.4 pins
  for the seam ("after the locked work order checks (`WORK_ORDER_NOT_FOUND`, asset correspondence,
  `WORK_ORDER_ALREADY_COMPLETED`) and BEFORE `setWorkOrderCompleted`"). In `completeWorkOrderBase`
  the warranty pre-check sits immediately after the not-found check
  [src/api/v1/maintenance.ts:920-933, patch lines 87-100], so a flagged and already-completed work
  order whose override row has since been removed reports 403 `APPROVAL_REQUIRED` rather than the
  409 `WORK_ORDER_ALREADY_COMPLETED` the seam would report for the same request. The seam itself
  orders the checks correctly [src/compliance/maintenance-plan.ts:645-677], and because a flagged
  work order cannot reach `completed` without an override the divergence is not reachable through
  the API today.

## Confirmed Correct

Recorded so a later reviewer does not re-derive them.

- Every route in Table 2 is registered with the specified verb, path, handler and RBAC scope, in
  static-before-parameter order, with `/coverages`, `/coverages/alerts` and `/coverages/scan` all
  ahead of `/coverages/:coverageId` [src/server.ts, patch lines 2582-2603]. All eight also appear in
  the `allowedSpineRoutes` allowlist [test/integration/story-1-9.test.ts:462-469], so the Spine gate
  is not left short.
- The Notification Contract is met field for field: role `maintenance_manager` with
  `location_id: null`, `event_type: 'coverage_expiry_due'`, `status_verb: 'Due'`,
  `object_type: 'asset_coverage'`, `object_id` the alert id, the specified `actor_label` template
  resolved through `getAssetById`, the exact `next_step` string, and escalation to
  `maintenance_supervisor` with an 86400-second window attached only when `stage_days === 30`
  [src/maintenance/coverage-jobs.ts:198-217]. No notification is emitted for coverage recording or
  for the warranty flag, as the contract requires.
- AC 2 derives the flag server-side after the SLA policy lock, rejects any declared
  `warranty_flagged` or `warranty_coverage_id` with `WORK_ORDER_DERIVATION_MISMATCH` and the spec's
  exact message, and passes both derived values into `insertWorkOrder` (Binding Decision 3)
  [src/compliance/maintenance-fault.ts, patch lines 1890-1929]. `business_date` is asserted present
  and calendar-valid by the same file's shape assert before the applier consumes it.
- AC 3 is enforced in the seam under the work order's own lock, with the handler pre-check as a
  courtesy only (Binding Decision 10), both raising 403 `APPROVAL_REQUIRED` with identical message
  and `{ work_order_id, warranty_coverage_id }` details.
- AC 4 captures the override id, the trimmed reason code and the server-derived `overridden_by` on
  the persisted payload by write-back before the insert
  [src/compliance/maintenance-coverage.ts:569-582, patch lines 1759-1773].
- The store wiring matches Task 4.5 exactly: `assertMaintenanceCoverageShape` immediately after
  `assertAssetStatusChangedShape`, `applyMaintenanceCoverageProjection` immediately after
  `applyAssetOperationalStatusProjection`, all three 23505 constraint mappers, and all three pkey
  chain entries each naming its own id field [src/events/store.ts, patch lines 2046-2050, 2070-2074,
  2117-2145, 2178-2242].
- `config.maintenance.warrantyOverrideReasonCodes` matches the spec's Config Addition block
  verbatim, including the fail-closed load behaviour [src/config/index.ts, patch lines 1957-1976].
- Task 6.3 holds: no `setInterval`, no `node-cron` and no new container anywhere in
  `src/maintenance/coverage-jobs.ts`; the scan runs only from the authenticated POST trigger with an
  explicit `business_date`.
- The spec's Task 7.1 text for the default business date, `toIstCalendarDate(new
  Date().toISOString())`, does not match the real signature `toIstCalendarDate(utc: Date)`
  [src/lib/business-days.ts:22]. The code passes a `Date` and is correct; the spec text is not.

## Excluded

Not reported, already logged under the Story 7.7 headings in `deferred-work.md`: the omitted
one-override-per-work-order handler pre-check, the pre-7.7 breakdown replay non-determinism (D4),
the `business_date` UTC sliver inherited from the Story 7.3 accept handler, the mismatched
`stream_type` seam bypass, the crash window between alert commit and notification emission,
`requireBusinessDate` accepting implausible-but-valid dates, zero-recipient role fan-out, and the
unindexed notification dedup scan. The unbounded scan loop in `coverage-jobs.ts` is also excluded;
it is logged, under the Story 6.1 Group C heading.
