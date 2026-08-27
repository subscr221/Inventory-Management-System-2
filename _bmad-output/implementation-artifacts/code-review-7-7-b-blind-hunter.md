# Code Review 7.7 Group B: Blind Hunter

Adversarial review of Story 7.7 "AMC, Warranty, and Insurance Tracking", Group B
(compliance seam, POST-triggered scan, REST surface, event-store wiring, config,
AC 2 derivation in the fault seam). Baseline commit `e93014f`, diff taken against
the working tree carrying the Group A patches.

Items already recorded under the Story 7.7 headings in
`_bmad-output/implementation-artifacts/deferred-work.md` are excluded. In
particular the deliberate omission of the one-override-per-work-order handler
pre-check was verified rather than re-reported: the seam path
(`src/compliance/maintenance-coverage.ts:565-573`) and the 23505 resolver path
(`src/events/store.ts:1403-1411` plus
`src/compliance/maintenance-coverage.ts:674-688`) return the identical 409
`WARRANTY_OVERRIDE_ALREADY_RECORDED`, the identical message and the identical
`{ work_order_id, existing_override_id }` detail. The claimed equivalence holds.

The other verified claims that produced no finding: the AC 2 warranty SELECT is
genuinely unlocked and placed after the SLA policy lock
(`src/compliance/maintenance-fault.ts:517-523` then `:602-610`), so the fault
report to asset to SLA policy to work order lock order is unchanged; the AC 3
gate sits under the work-order lock and before `setWorkOrderCompleted`, leaving
the Story 7.6 cost arm and the weighbridge stamp flip untouched
(`src/compliance/maintenance-plan.ts:665-677`); the D5 "most urgent stage first"
assumption is sound because `ORDER BY c.expiry_date ASC, s.stage_days ASC`
(`src/read/projections/asset_coverage.ts:326`) holds `expiry_date` constant
within a coverage, so `stage_days ASC` governs; three 23505 resolvers and three
pkey chain entries are present and each names its own id field.

## Findings

- **D1's current-coverage narrowing silently disables expiry alerting for every
  concurrent same-type coverage but the latest-expiring one.** Severity: High.
  `src/read/projections/asset_coverage.ts:312-318` reduces the scan population
  with `SELECT DISTINCT ON (asset_id, coverage_type) ... ORDER BY asset_id,
  coverage_type, expiry_date DESC, coverage_id ASC`. The uniqueness grain is
  `(asset_id, coverage_type, lower(reference_number_ext))`
  (`read/projections/asset_coverage.sql:45`), so two policies of the same type
  simultaneously in force on one asset are a legal and expected shape: a
  machinery-breakdown policy and a fire policy are both `coverage_type =
  'insurance'` with distinct reference numbers, and two overlapping AMCs from
  different vendors are equally legal. `getActiveWarrantyForAsset`
  (`:164-168`) even documents "when several qualify" as a real case. After D1 the
  earlier-expiring policy earns no 90-day, no 60-day and no 30-day warning ever,
  and nothing anywhere records that it was dropped. This is a lapse-prevention
  hole in the exact FR (FR-M-10) the story exists to satisfy, introduced by a
  review decision aimed at renewals. The test at
  `test/integration/story-7-7.test.ts:742-771` exercises only the renewal shape
  ("an overlapping renewal stops the superseded coverage earning new stages") and
  asserts the dropped alerts as correct behaviour, so the concurrent-policy
  regression is not merely untested, it is locked in.

- **`stage_days` is the one derivable field on the expiry-flag payload that the
  seam never re-derives, so a forged escalation is accepted.** Severity: High.
  `src/compliance/maintenance-coverage.ts:416-449` re-derives `asset_id`,
  `coverage_type` and `expiry_date` against the locked coverage row and rejects
  divergence, but never checks the due-ness relation
  `(coverage.expiry_date - business_date) <= stage_days` that
  `listCoverageStagesDue` uses to decide a stage is due
  (`src/read/projections/asset_coverage.ts:302`). The event-contract banner at
  `src/events/schema.ts:2882-2886` states the invariant this breaks verbatim:
  "Every payload field an applier can derive from a locked row is DECLARED here
  and CHECKED against the derivation ... a forged `coverage_expiry_flagged` would
  burn an alert stage that the genuine scan then skips." A direct
  `POST /api/v1/events` carrying `stage_days: 30` against a coverage expiring in
  900 days passes every check, occupies the `(coverage_id, 30)` grain so the
  genuine scan skips it forever
  (`src/maintenance/coverage-jobs.ts:154`), and 30 is the only stage carrying the
  `maintenance_supervisor` escalation clock
  (`src/maintenance/coverage-jobs.ts:214-221`). The re-read guard at
  `:403` rejects only `coverage.expiry_date < business_date`, which is orthogonal.

- **`coverages_evaluated` counts stages, not coverages.** Severity: Medium.
  `src/maintenance/coverage-jobs.ts:230` returns
  `coverages_evaluated: dueStages.length`, and `dueStages` is the cross join of
  coverages against the 90/60/30 stage array
  (`src/read/projections/asset_coverage.ts:322-323`), one row per due and unfired
  stage. The story's own test at `test/integration/story-7-7.test.ts:725-740`
  scans a single 25-day cover note and produces three rows, so the response
  reports `coverages_evaluated: 3` for one contract. The sibling counters this
  was cloned from do not have the defect: `certificates_evaluated`
  (`src/maintenance/calibration-jobs.ts:310`) and `examinations_evaluated`
  (`src/maintenance/statutory-jobs.ts:215`) count lists whose row IS the subject.
  An operator watching the scan for "how many contracts did we look at" is given a
  number that inflates by up to 3x with no way to recover the true figure from the
  response.

- **D5 created a third notification outcome that no counter reports, defeating
  the separation the job header calls load-bearing.** Severity: Medium.
  `src/maintenance/coverage-jobs.ts:30-32` states the rule: "Write counters and
  delivery counters are kept SEPARATE in the result, so a dropped notification
  stays visible instead of hiding behind the write count (the Story 7.2 and 7.4
  lesson)." The D5 suppression at `:196-197` `continue`s before
  `emitNotification`, incrementing neither `notifications_delivered` nor
  `notifications_dropped`, and no `notifications_suppressed` counter was added to
  `CoverageScanResult` (`:50-57`). The result
  `{ alerts_raised: 3, notifications_delivered: 1, notifications_dropped: 0 }` is
  now the CORRECT output for a healthy run and also the exact output of a run in
  which two notifications were silently lost. That state is asserted as expected
  at `test/integration/story-7-7.test.ts:743-744`. The invariant the counters
  existed to protect (delivered plus dropped reconciles against writes) no longer
  holds and nothing replaced it.

- **The AD-16 replay contract used to justify omitting the grain pre-check is
  broken anyway by two other pre-checks on the same route.** Severity: Medium.
  `src/api/v1/maintenance.ts:4206-4212` argues the grain pre-check must be omitted
  because "a pre-check runs before persistEvent's idempotency lookup, so it would
  turn a legitimate same-key REPLAY into a 409 and break the AD-16 contract". The
  identical reasoning applies unchanged to the `WARRANTY_OVERRIDE_NOT_REQUIRED`
  check at `:4190-4197` and, reachably, to `WORK_ORDER_ALREADY_COMPLETED` at
  `:4198-4205`. The normal AC 3 flow is: record the override, then complete the
  work order. A client that retries the original override POST with the same
  idempotency key after that completion (a timed-out call, a queued retry) gets
  409 `WORK_ORDER_ALREADY_COMPLETED` instead of the replayed 201, which is
  precisely the failure the deviation was recorded to avoid. Either the replay
  argument governs the whole handler or it governs none of it; as written the
  route is inconsistent with its own justification, and the deferred-work entry
  overstates the protection the deviation buys.

- **Preventive and scheduled work orders are never warranty-checked, so
  chargeable work on an in-warranty asset bypasses the AC 3 gate entirely.**
  Severity: Medium. The AC 2 derivation is installed only in
  `applyBreakdownWorkOrderCreated` (`src/compliance/maintenance-fault.ts:582-611`).
  The Story 7.2 preventive path calls `insertWorkOrder` at
  `src/compliance/maintenance-plan.ts:535` without `warranty_flagged`, which
  defaults to `false` (`src/read/projections/maintenance_work_order.ts:162`), and
  the AC 3 gate at `src/compliance/maintenance-plan.ts:665` keys on
  `warranty_flagged === true`. A preventive service on a machine still under
  manufacturer warranty therefore completes and posts its Story 7.6 cost rollup
  with no override, no reason code and no record that the asset was covered.
  FR-M-11 is written about chargeable work, not about breakdown work orders
  specifically. The story pins this as intended at spec line 138 ("a preventive
  work order generated through the Story 7.2 path is never flagged (regression)"),
  but it is not recorded anywhere in `deferred-work.md` as a scope limit, so the
  gap is invisible to anyone reading the ledger.

- **`business_date` on the expiry-flag payload is unbounded in the past.**
  Severity: Low. `src/compliance/maintenance-coverage.ts:403-414` rejects only
  `coverage.expiry_date < business_date`. A forged `business_date` of `1999-01-01`
  passes every gate, is persisted onto the alert row
  (`src/compliance/maintenance-coverage.ts:458`), and the alert feed then reports
  a contract as having been flagged decades before it was recorded. Combined with
  the unchecked `stage_days` above, a single crafted event writes an alert row
  whose every temporal field is fiction while still occupying a real grain.

- **The expiry-flag shape assert alone does not pin `stream_id`.** Severity: Low.
  `assertCoverageRecordedShape` rejects a `stream_id` that is not the payload
  `asset_id` (`src/compliance/maintenance-coverage.ts:130-135`) and
  `assertWarrantyOverrideRecordedShape` rejects one that is not the payload
  `work_order_id` (`:222-227`), but `assertCoverageExpiryFlaggedShape`
  (`:188-215`) validates no stream binding at all. The scan sets
  `stream_id: alertId` (`src/maintenance/coverage-jobs.ts:160`) and the schema
  documents "stream_id is alert_id" (`src/events/schema.ts:2924`), yet a direct
  poster may file the alert onto any asset's or work order's maintenance stream,
  fragmenting per-stream replay for a rule the sibling asserts enforce.

- **Coverage text-length limits exist only in the seam and answer with a
  different error code than the handler.** Severity: Low.
  `src/api/v1/maintenance.ts:3897-3904` validates `provider_name` and
  `reference_number_ext` for non-emptiness only, returning 400 `INVALID_PARAMS`;
  the 512-character cap lives at `src/compliance/maintenance-coverage.ts:141-155`
  and returns 400 `INVALID_PAYLOAD`. A caller therefore gets two different error
  codes for two failures of the same field on the same route. The seam also
  measures the UNTRIMMED string (`providerName.length`, `reference.length`) while
  persisting the trimmed one (`:285-286`), so a 510-character value with five
  trailing spaces is rejected for a stored length of 510.

- **`GET /work-orders/:workOrderId/warranty-overrides` returns 200 with a null
  body for a work order that does not exist.** Severity: Low.
  `src/api/v1/maintenance.ts:4290-4298` validates the UUID form and then calls
  `getWarrantyOverrideByWorkOrder` without resolving the parent, so "this work
  order has no override" and "there is no such work order" are the same response.
  Every neighbouring read in the file resolves its subject: `getCoverageBase`
  404s at `:4144-4148`, the override POST 404s `WORK_ORDER_NOT_FOUND` at
  `:4185-4189`, and the completion route 404s at `:910-914`.

- **`APPROVAL_REQUIRED` 403 carries two unrelated meanings across the story's own
  routes, and the seam diverges from the task spec on which code applies.**
  Severity: Low. On completion it means "this work order is warranty-flagged and
  no override exists" (`src/compliance/maintenance-plan.ts:666-677` and the
  handler mirror at `src/api/v1/maintenance.ts:919-933`); on the override route
  it means "you are not the resolved DOA approver"
  (`src/api/v1/maintenance.ts:4227-4237`,
  `src/compliance/maintenance-coverage.ts:553-563`). A client cannot branch on the
  code; only free-text message inspection separates them. Separately, Task 4.2 of
  the story (spec line 90) pins the non-approver case as 409
  `COVERAGE_DERIVATION_MISMATCH` while the error-code table (spec line 264) pins
  403 `APPROVAL_REQUIRED`. The implementation follows the table, which is
  defensible, but the spec now contradicts itself on a stable error code and
  nothing records which reading won.

- **The declared-warranty rejection hard-codes the wrong field name in its
  message.** Severity: Low. `src/compliance/maintenance-fault.ts:585-596` fires
  when either `warranty_flagged` OR `warranty_coverage_id` is declared, but always
  reports "warranty_flagged is derived and cannot be declared". Every sibling
  rejection in the same function interpolates the offending field (`Declared
  ${field} does not match the derived value`, `:558`). A caller who declared only
  `warranty_coverage_id` is told to remove a field they never sent.

- **`warrantyOverrideReasonCodes` does not fail closed on a blank env value.**
  Severity: Low. `src/config/index.ts:321-336` claims in its comment that "a
  malformed env value fails closed at load time", and it does for a
  duplicate-bearing or all-empty list. But `MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES="   "`
  takes the `raw.trim() === ''` branch at `:324` and silently substitutes the four
  hard-coded defaults. An operator who deliberately blanks the variable to
  restrict overrides gets the full permissive default list instead of a refusal to
  boot. The list is also unvalidated per entry (no length bound, no character
  class), so a stray newline in a `.env` file yields a reason code containing a
  newline that then appears in the 422 `allowed` detail.

- **A lost 30-day race downgrades the losing scan's notification to a
  non-escalating stage while still delivering a second message for the same
  coverage.** Severity: Low. `src/maintenance/coverage-jobs.ts:189` `continue`s on
  `DUPLICATE_COVERAGE_ALERT` WITHOUT adding the coverage to `notifiedCoverages`
  (`:196-197`). Two concurrent scans on the same business date where scan A wins
  the `(coverage, 30)` grain and scan B wins `(coverage, 60)` therefore both
  deliver a notification for one contract, and scan B's carries no escalation
  block because `due.stage_days !== 30` (`:214`). D5's stated contract, one
  notification per coverage per run, is per-run only, so the "one contract, one
  message" property the decision was made to guarantee degrades silently under the
  concurrency the job is explicitly designed to tolerate.
