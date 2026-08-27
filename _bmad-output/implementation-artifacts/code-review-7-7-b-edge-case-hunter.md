# Code Review 7.7 Group B: Edge Case Hunter

Scope: Story 7.7 "AMC, Warranty, and Insurance Tracking", Group B only, against
baseline `e93014f` and the current working tree. Files walked:
`src/compliance/maintenance-coverage.ts`, `src/maintenance/coverage-jobs.ts`,
`src/api/v1/maintenance.ts` (Story 7.7 routes and the AC 3 completion pre-check),
`src/events/store.ts`, `src/config/index.ts`, `src/server.ts`,
`src/compliance/maintenance-fault.ts`.

Only unhandled branches and boundaries are listed. Anything already logged under a
Story 7.7 heading in `_bmad-output/implementation-artifacts/deferred-work.md` is
excluded, including the alert-commit-to-notification crash gap, the unbounded scan
loop, the D4 replay divergence, the missing override foreign key, the absent
override grain pre-check, the inherited IST-versus-UTC accept-handler date, and
`requireBusinessDate` accepting implausible-but-valid dates.

## Concurrency and Lock Ordering

- **A nested pool checkout happens while a row lock is held, so the connection pool
  can deadlock against itself.**
  Boundary: `applyWarrantyOverrideRecorded` holds `maintenance_work_order` FOR UPDATE
  on the transaction connection and then calls `resolveApprover`, which takes no
  client and issues two to four fresh pool checkouts (`findMatchingDoaEntry`,
  `findRoleHolder`, `findActiveDelegation`, `listActiveDoaEntries`). The same shape
  repeats in the scan: `inTransaction` holds the `asset_coverage` row lock and then
  calls `persistEvent`, whose pre-transaction asserts (`assertWeighbridgeStampLockout`,
  `assertCalibrationLockout`, `assertInventoryTagging`) also run on the pool. The
  module header's "plain SELECT, so it carries no lock-order dependency" reasoning
  covers lock ordering but not connection-pool ordering.
  Evidence: `src/compliance/maintenance-coverage.ts:544`,
  `src/api/v1/indents.ts:66-95`, `src/maintenance/coverage-jobs.ts:82-101,140-186`,
  `src/events/store.ts:440-446`.
  Failing input: with `PGPOOL_MAX` connections, issue that many simultaneous
  `POST /api/v1/maintenance/work-orders/:id/warranty-overrides` calls (or the same
  number of `POST /api/v1/maintenance/coverages/scan` calls over a register with
  due stages). Every connection is held inside a transaction awaiting a connection
  that no one can release; the requests hang until the pool acquire timeout.

- **The scan's staleness guard cannot see a renewal, because a renewal changes no
  field the guard compares.**
  Boundary: the re-read guard is `locked.expiry_date !== due.expiry_date`, but
  Binding Decision 5 makes a renewal a NEW row with a new `coverage_id`; the
  superseded row's `expiry_date` is never touched. The D1 single-winner narrowing
  runs only inside `listCoverageStagesDue`, at list-read time, so a renewal landing
  after the list read leaves the loop flagging and notifying on a contract that has
  already been renewed.
  Evidence: `src/maintenance/coverage-jobs.ts:152`,
  `src/read/projections/asset_coverage.ts:312-318`.
  Failing input: AMC `C1` on asset A, expiry `2026-09-15`, no alerts yet. Call
  `POST /api/v1/maintenance/coverages/scan` with `business_date` `2026-07-01`; while
  the loop is between the list read and the first iteration, `POST
  /api/v1/maintenance/assets/A/coverages` records the renewal `C2` with expiry
  `2027-09-15`. The scan still raises the 90, 60, and 30 day alerts on `C1` and pages
  `maintenance_manager` with "Renew the contract", the 30 day one carrying the
  supervisor escalation clock.

- **`applyWorkOrderCompleted` acquires the weighbridge examination lock before it
  reaches the AC 3 warranty gate, so a rejected completion still serializes against
  re-stamping.**
  Boundary: the applier locks asset, then `statutory_examination` FOR UPDATE
  (Story 7.6 stamp invalidation), then the work order, and only then rejects 403
  `APPROVAL_REQUIRED` for a missing override. The lock is held for the whole
  round trip until the rollback.
  Evidence: `src/compliance/maintenance-plan.ts:620-626,665-677`,
  `src/api/v1/maintenance.ts:920-933`.
  Failing input: a warranty-flagged breakdown work order on a weighbridge asset.
  Retrying `POST /api/v1/maintenance/work-orders/:id/complete` in a loop while a
  `POST /api/v1/maintenance/statutory-examinations` re-stamp for that same asset is
  in flight makes the re-stamp block behind a chain of transactions that are all
  guaranteed to fail.

## The Scan Loop and Its Counters

- **`coverages_evaluated` counts due stage rows, not coverages.**
  Boundary: `dueStages.length` is the CROSS JOIN cardinality (up to three rows per
  coverage), while the field name and the D5 rationale both speak in coverages.
  Evidence: `src/maintenance/coverage-jobs.ts:229`,
  `src/read/projections/asset_coverage.ts:319-326`.
  Failing input: one insurance cover note recorded 45 days before expiry, no other
  coverage in the register. `POST /api/v1/maintenance/coverages/scan` returns
  `coverages_evaluated: 3` for a single coverage.

- **Notifications suppressed by the D5 set are indistinguishable from notifications
  that were never attempted.**
  Boundary: the three result counters are `alerts_raised`,
  `notifications_delivered`, and `notifications_dropped`. A D5 skip increments none
  of them, so the arithmetic `alerts_raised - (delivered + dropped)` silently
  conflates deliberate suppression with a stage that lost a race and wrote nothing.
  There is no `notifications_suppressed`.
  Evidence: `src/maintenance/coverage-jobs.ts:196-197,225-232`.
  Failing input: the same 45 day cover note. The result is
  `alerts_raised: 3, notifications_delivered: 1, notifications_dropped: 0`, which
  reads identically to a run where two emissions vanished.

- **When the most urgent stage loses the grain race, the coverage's only
  notification for the run is demoted to a non-escalating stage.**
  Boundary: D5's "the first stage that commits for a coverage IS its most urgent
  one" holds only when the 30 day stage actually commits. Both skip paths (the
  in-transaction `existing` check and the `DUPLICATE_COVERAGE_ALERT` catch) `continue`
  without adding the coverage to `notifiedCoverages`, so the 60 day stage then
  becomes the notified one and the `ESCALATING_STAGE_DAYS` block is never attached.
  Evidence: `src/maintenance/coverage-jobs.ts:154-155,189,196-197,209-217`.
  Failing input: run two `POST /api/v1/maintenance/coverages/scan` calls
  concurrently, one filtered to `asset_id` A and one unfiltered, over a coverage on
  A that is 25 days from expiry with no alerts yet. The filtered scan commits and
  notifies stage 30 with escalation; the unfiltered scan skips stage 30, commits 60
  and 90, and pages `maintenance_manager` a second time for the same coverage with
  no acknowledgment window at all.

- **`getAssetById` is awaited outside the try block and outside any transaction, so a
  transient failure discards the whole run result after alerts have already
  committed.**
  Boundary: the `try` covers only `inTransaction`; the asset read for the
  notification label sits after it. A rejection propagates out of
  `runCoverageExpiryScan` into `sendAppError`, and the already-committed alert rows
  are never reported in `alert_ids`.
  Evidence: `src/maintenance/coverage-jobs.ts:180-199`.
  Failing input: a scan over 200 due stages where the pool drops a connection at
  stage 50. Fifty alert grains are committed, the response is a 500, and the caller
  has no list of what was written; a re-run will skip those fifty as already fired
  and will therefore never notify on them.

- **The scan's error filter recognizes exactly one of the four codes its own applier
  can raise.**
  Boundary: `isAppErrorWithCode(err, 'DUPLICATE_COVERAGE_ALERT')` is the only
  tolerated rejection. `applyCoverageExpiryFlagged` can also reject
  `COVERAGE_NOT_FOUND` (404), `COVERAGE_ALREADY_EXPIRED` (422), and
  `COVERAGE_DERIVATION_MISMATCH` (409); any of those aborts the entire run mid-loop
  with the same loss of `alert_ids` as above.
  Evidence: `src/maintenance/coverage-jobs.ts:189`,
  `src/compliance/maintenance-coverage.ts:377-424`.
  Failing input: a direct `POST /api/v1/events` (or any future write path) that
  changes an `asset_coverage.expiry_date` to a past date between the list read and
  the row lock; the applier raises `COVERAGE_ALREADY_EXPIRED` and the scan dies
  rather than skipping that one coverage.

## The Warranty Override Path

- **The handler's DOA and completed-status pre-checks run before `persistEvent`, so
  they break the same AD-16 replay contract the grain pre-check was removed to
  protect.**
  Boundary: `idempotencyKeyFrom` reads `body['idempotency_key']`, and the idempotency
  lookup happens inside `persistEvent`. Both the `WORK_ORDER_ALREADY_COMPLETED`
  branch and the `APPROVAL_REQUIRED` branch reject before that lookup, so a
  legitimate same-key retry cannot reach its original 201.
  Evidence: `src/api/v1/maintenance.ts:4196-4202,4218-4240`,
  `src/api/v1/maintenance.ts:220-224`.
  Failing input: `POST /api/v1/maintenance/work-orders/W/warranty-overrides` with
  `idempotency_key: "K"` succeeds (201). Complete `W`, then retry the identical
  request with `idempotency_key: "K"` after a network timeout. The reply is 409
  `WORK_ORDER_ALREADY_COMPLETED`, not the original 201. The same happens with a 403
  if a DOA delegation rotates between the write and the retry.

- **The handler and the seam validate the same two conditions in opposite order, so
  one input yields two different statuses depending on which path serves it.**
  Boundary: the handler checks DOA authority (403) and then the reason code (422);
  the seam checks the reason code (422) and then DOA authority (403 or 404).
  Evidence: `src/api/v1/maintenance.ts:4218-4253`,
  `src/compliance/maintenance-coverage.ts:532-563`.
  Failing input: a caller who is not the resolved DOA approver posting
  `reason_code: "NOT_A_CODE"`. The REST route returns 403 `APPROVAL_REQUIRED`; the
  identical envelope on `POST /api/v1/events` returns 422
  `WARRANTY_OVERRIDE_REASON_INVALID`.

- **`GET .../warranty-overrides` answers 200 with `override: null` for a work order
  that does not exist.**
  Boundary: the handler validates the UUID form and then reads the override grain
  directly; there is no `getWorkOrderById` existence check, unlike `getCoverageBase`
  which returns 404 `COVERAGE_NOT_FOUND`.
  Evidence: `src/api/v1/maintenance.ts:4290-4298` against
  `src/api/v1/maintenance.ts:4140-4154`.
  Failing input: `GET /api/v1/maintenance/work-orders/
  00000000-0000-4000-8000-000000000000/warranty-overrides` returns
  `200 {"override": null}`, indistinguishable from a real work order that has no
  override.

## Shape and Event Contract

- **`assertCoverageExpiryFlaggedShape` does not bind `stream_id` to any payload
  field, unlike both of its siblings.**
  Boundary: `assertCoverageRecordedShape` rejects when `stream_id` differs from
  `asset_id`, and `assertWarrantyOverrideRecordedShape` rejects when it differs from
  `work_order_id`. The expiry-flag assert checks neither, so a direct event may carry
  any `stream_id` while writing a real alert row.
  Evidence: `src/compliance/maintenance-coverage.ts:188-214` against
  `:129-136` and `:221-228`.
  Failing input: `POST /api/v1/events` with
  `stream_type: "maintenance"`, `stream_id: "<some unrelated asset uuid>"`,
  `event_type: "maintenance.coverage_expiry_flagged"`, and a payload whose
  `alert_id` is a fresh UUID. The alert is written and the event stream now
  attributes it to a foreign aggregate.

- **The new SQLSTATE 22003 mapping is unconditional across every event family but
  reports a cost-specific code, message, and detail set.**
  Boundary: the branch tests only `err.code === '22003'`; it is not gated on the
  event type or on the presence of cost fields, and its details only ever name
  `work_order_id` and `asset_id`.
  Evidence: `src/events/store.ts:1639-1660`.
  Failing input: a direct `maintenance.coverage_recorded` event with
  `contract_value: "999999999999.999"` overflows `NUMERIC(14,3)` and returns
  422 `COST_VALUE_OUT_OF_RANGE` "the resulting total exceeds the NUMERIC(14,3) range
  of the cost columns" with `work_order_id: null` and the details pointing at a
  coverage record that has no cost column. Any 22003 raised by an inventory or
  procurement event now returns the same misattributed cost error.

## Route Input Boundaries

- **`stage_days` on the alerts list is validated for digits only, not for
  magnitude or membership.**
  Boundary: the guard is `/^\d+$/`, then `Number(...)` is passed straight into an
  `INTEGER` comparison. `Number.isInteger` in the projection accepts any
  integer-valued float, so the bound never closes. The Story 7.5 twin at
  `src/api/v1/maintenance.ts:3176` pins the value to `CALIBRATION_STAGE_SET`; the
  7.7 route dropped that.
  Evidence: `src/api/v1/maintenance.ts:4102-4113`,
  `src/read/projections/asset_coverage_alert.ts:145-149`.
  Failing input:
  `GET /api/v1/maintenance/coverages/alerts?stage_days=99999999999` returns 500
  `INTERNAL_ERROR` from the caught PostgreSQL 22003, not a 400.

- **`business_date` is silently ignored, unvalidated, whenever `status` is absent.**
  Boundary: `coverageStatusFilter` returns early on `status === null` and never looks
  at `business_date`, so a caller who mistypes the status parameter name gets an
  unfiltered register behind a 200 with no signal that the date was discarded.
  Evidence: `src/api/v1/maintenance.ts:3985-3986`.
  Failing input:
  `GET /api/v1/maintenance/coverages?statuss=active&business_date=not-a-date`
  returns the entire company register, 200, no error.

- **The IST default for `business_date` is never echoed back, so a near-midnight
  response cannot be interpreted.**
  Boundary: when `status` is supplied without `business_date` the server substitutes
  `toIstCalendarDate(new Date())`, but the response body carries only `coverages`.
  Two identical requests either side of IST midnight return different sets with no
  field distinguishing them.
  Evidence: `src/api/v1/maintenance.ts:4004,4040-4046,4078-4084`.
  Failing input: `GET /api/v1/maintenance/coverages?status=active` issued at
  `23:59:59+05:30` and again at `00:00:01+05:30` on a day when a contract expires.
  The second call omits it, and neither response says which business date was used.

- **`recordCoverageBase` bounds no text field, so the two text-length rejections come
  back with a different error code from every other rejection on the same route.**
  Boundary: the handler checks `provider_name` and `reference_number_ext` for
  non-empty only; `MAX_TEXT_LENGTH` is enforced only in the seam, which rejects
  `INVALID_PAYLOAD` while every handler-side check on that route rejects
  `INVALID_PARAMS`. The seam also measures the already-trimmed value the handler
  put on the payload, so the effective ceiling shifts with leading whitespace.
  Evidence: `src/api/v1/maintenance.ts:3897-3904`,
  `src/compliance/maintenance-coverage.ts:139-155`.
  Failing input: `POST /api/v1/maintenance/assets/A/coverages` with a 600 character
  `provider_name` returns 400 `INVALID_PAYLOAD`; the same call with a bad
  `coverage_type` returns 400 `INVALID_PARAMS`. A 520 character `provider_name`
  prefixed with ten spaces is accepted and stored at 510 characters.

- **A non-UUID tail on the coverages collection falls through to the by-id route.**
  Boundary: `/coverages/scan` is registered for POST only and `/coverages/alerts`
  for GET only; any other verb or tail matches `/coverages/:coverageId` and is
  answered by `requireUuidParam`.
  Evidence: `src/server.ts:747-750`, `src/api/v1/maintenance.ts:4142`.
  Failing input: `GET /api/v1/maintenance/coverages/scan` returns 400
  `INVALID_PARAMS` "coverageId must be a UUID" rather than 405, which is a
  misleading answer for a route that does exist under POST.

## Configuration

- **A reason code longer than `MAX_REASON_CODE_LENGTH` is accepted at load time but
  can never be cited.**
  Boundary: the config loader validates only non-empty, trimmed, duplicate-free; it
  applies no length or character bound. The request-side length check runs before the
  allow-list check, so such a code is permanently unreachable and the deployment gets
  no load-time signal.
  Evidence: `src/config/index.ts:321-336`,
  `src/api/v1/maintenance.ts:4165-4176`,
  `src/compliance/maintenance-coverage.ts:78,532-540`.
  Failing input: start the process with
  `MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES` set to a single 250 character code.
  The process boots; every override citing that exact code returns 400
  `INVALID_PARAMS`, and the 422 `allowed` list advertises a code the route rejects.

- **Case and internal-whitespace variants of a configured code are rejected, while
  the story's other human-entered key is case-folded.**
  Boundary: the allow-list test is `Array.includes`, an exact, case-sensitive,
  whitespace-sensitive comparison in both the handler and the seam.
  `canonicalCoverageReference` in the same module folds case for the contract
  reference, so the two human-entered fields on this story disagree about
  canonicalization. The loader's duplicate check is also case-sensitive, so
  `"A,a"` loads as two distinct valid codes.
  Evidence: `src/config/index.ts:326-335`,
  `src/compliance/maintenance-coverage.ts:103,532-540`,
  `src/api/v1/maintenance.ts:4242-4253`.
  Failing input: `POST /api/v1/maintenance/work-orders/W/warranty-overrides` with
  `reason_code: "emergency_repair"` against the default list returns 422
  `WARRANTY_OVERRIDE_REASON_INVALID`, and
  `reason_code: "EMERGENCY  REPAIR"` (double inner space) likewise, with no
  normalization attempted on either side.

## Deletion Check

The diff replaces the terminal `else` of the primary-key detail chain in
`persistEvent`. The previous fallback returned `{ escalation_id }`; the replacement
promotes `instrument_calibration_escalation_pkey` to its own explicit branch and
makes `{ asset_id }` the new catch-all. Table 1 records the constraints that reach
the new fallback.

| **Constraint** | **Detail field returned** | **Correct** |
| --- | --- | --- |
| `asset_operational_status_pkey` | `asset_id` | yes |
| `maintenance_asset_cost_pkey` | `asset_id` | yes |

Table 1 shows that no constraint previously served by the `escalation_id` fallback
loses its detail field, and both constraints that fall through to the new catch-all
do carry `asset_id` on their payloads. No unhandled deletion path was found in this
hunk.
