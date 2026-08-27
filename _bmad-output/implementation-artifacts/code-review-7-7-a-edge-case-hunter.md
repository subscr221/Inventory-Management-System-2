# Code Review 7.7 Group A - Edge Case Hunter

Story 7.7 "AMC, Warranty, and Insurance Tracking", Group A only (schema, events,
projections, migrations). Baseline commit `e93014f`, HEAD `d46c348`. Sources:
`_bmad-output/diff-7-7-group-a.patch` and `_bmad-output/diff-7-7-initdb-mirror.patch`.

Method: exhaustive path and boundary enumeration over the changed lines. Only
unhandled paths are listed. Handled paths were discarded silently. No severity
ranking is assigned. Findings that are guarded at the Group B compliance layer but
unguarded at the Group A layer are marked as such, because the Group A artifacts
are the stated backstop and are reachable by replay, direct SQL, and any future
writer.

Table 1 summarises the finding count per area.

| **Area** | **Findings** |
| --- | --- |
| Uniqueness grain and `uq_asset_coverage_reference` | 5 |
| Staged alerts `(coverage_id, stage_days)` | 6 |
| Append-only `maintenance_warranty_override` | 3 |
| Guarded `ADD COLUMN` on `maintenance_work_order` | 3 |
| Date and timestamp handling | 4 |
| Migration idempotency and mirror drift | 3 |
| Event contract additivity | 1 |
| Accessor filter boundaries | 2 |
| Total | 27 |

## Uniqueness Grain and `uq_asset_coverage_reference`

- **The uniqueness expression folds case but not surrounding whitespace**
  - Boundary: `lower(reference_number_ext)` with no `btrim`, so two references that
    differ only by leading or trailing whitespace occupy different index slots.
  - Evidence: `read/projections/asset_coverage.sql:45`; pre-check twin at
    `src/read/projections/asset_coverage.ts:133`.
  - Failing input: insert `('AMC-2026-001')` then `('AMC-2026-001 ')` for the same
    `(asset_id, 'amc')`. Both rows are accepted; the register holds the same contract
    twice, and `getActiveWarrantyForAsset` tie-breaks arbitrarily between them.

- **`btrim` in the non-empty CHECK strips spaces only, not other whitespace**
  - Boundary: `btrim(x)` with no character set removes U+0020 only. Tab, newline,
    non-breaking space and other Unicode blanks survive.
  - Evidence: `read/projections/asset_coverage.sql:40` and `:81` (also
    `chk_asset_coverage_provider_name` at `:39`).
  - Failing input: `reference_number_ext = E'\t'`. `btrim` yields `E'\t'`, which is
    `<> ''`, so the CHECK passes and a whitespace-only contract reference is stored.
    The Group B guard uses JS `.trim()`, which would have rejected it, so the two
    layers disagree on what "non-empty" means.

- **`lower()` semantics are collation-dependent and no collation is pinned**
  - Boundary: under `LC_CTYPE=C` `lower()` folds ASCII only; under a UTF-8 locale it
    folds the full Unicode range. Nothing in `deploy/` sets `LC_COLLATE`,
    `LC_CTYPE`, or `POSTGRES_INITDB_ARGS`, and the column carries no `COLLATE`
    clause.
  - Evidence: `read/projections/asset_coverage.sql:30` and `:45`; no locale setting
    anywhere under `deploy/`.
  - Failing input: record `Ä-100`, then record `ä-100` on the same asset and coverage
    type. On a C-locale database both rows are accepted as distinct contracts; on a
    UTF-8-locale database the second is rejected 409. The same event stream replays
    to two different register states depending on the host database locale.

- **Group B canonicalisation and the SQL index use different case-folding engines**
  - Boundary: `canonicalCoverageReference` uses JS `String.prototype.toLowerCase`,
    which applies full Unicode special casing; the index uses SQL `lower()`. The
    pre-check compares `lower(reference_number_ext) = lower($3)` where `$3` is
    already JS-folded, so the two foldings are composed rather than reconciled.
  - Evidence: `src/read/projections/asset_coverage.ts:129` and `:133`;
    `src/compliance/maintenance-coverage.ts:103`.
  - Failing input: reference `İ-1` (U+0130). JS folds it to `i̇-1` (two code points);
    SQL `lower()` under most locales leaves the stored `İ-1` unchanged. The pre-check
    finds no row, the unique index sees no collision, and the duplicate lands.

- **`reference_number_ext` is unbounded `TEXT` under a B-tree expression index**
  - Boundary: the DB imposes no length limit; only Group B caps at 512 characters. A
    B-tree index tuple is capped near 2704 bytes.
  - Evidence: `read/projections/asset_coverage.sql:30` (no length CHECK) and `:45`
    (B-tree unique index over the expression).
  - Failing input: a direct insert or a replay carrying a 4000-character
    `reference_number_ext`. Postgres raises SQLSTATE 54000 "index row size exceeds
    maximum" and the enclosing `persistEvent` transaction aborts as an unmapped 500.

## Staged Alerts at the `(coverage_id, stage_days)` Grain

- **A coverage recorded inside a stage window fires every enclosing stage at once**
  - Boundary: the due predicate is `(expiry_date - business_date) <= stage_days` with
    no "highest unfired stage only" collapse, so on the first scan after creation all
    stages whose window already encloses the coverage are simultaneously due.
  - Evidence: `src/read/projections/asset_coverage.ts:262-267`.
  - Failing input: record a warranty on `2026-08-27` with `expiry_date`
    `2026-09-10` (14 days out). The next scan returns three rows (90, 60 and 30) for
    the one coverage and emits three `coverage_expiry_flagged` events on the same
    business date, producing three notifications for a contract that has one
    remaining warning to give.

- **Stages unfired at the moment a coverage lapses are lost with no closing alert**
  - Boundary: the predicate also requires `expiry_date >= business_date`. Once
    `expiry_date < business_date` the coverage drops out of the scan permanently, and
    the `(coverage_id, stage_days)` grain has no row recording that the stage was
    never reached.
  - Evidence: `src/read/projections/asset_coverage.ts:265`.
  - Failing input: a coverage expiring `2026-09-01` where the scan is not run between
    `2026-08-02` and `2026-09-02`. The 30-day stage never fires, and after
    `2026-09-01` it can never fire; the register shows an expired contract that was
    never warned about, indistinguishable from one that was.

- **`expiry_date` equal to `business_date` is simultaneously fully covered and fully due**
  - Boundary: `getActiveWarrantyForAsset` uses `expiry_date >= $2::date` while the
    scan uses `(expiry_date - business_date) <= stage_days`, giving
    `days_remaining = 0`.
  - Evidence: `src/read/projections/asset_coverage.ts:158` against `:264` and `:277`.
  - Failing input: `business_date = expiry_date = 2026-09-01`. A breakdown work order
    raised that day is `warranty_flagged = true` and blocked pending an override,
    while the same coverage's alert text reports "0 days remaining" across three
    stages. The last-day boundary is never explicitly decided in either direction.

- **The stage list is not deduplicated before `unnest`**
  - Boundary: `stages.filter((s) => Number.isInteger(s) && s > 0)` removes
    non-integers and non-positives but leaves repeats intact.
  - Evidence: `src/read/projections/asset_coverage.ts:259`.
  - Failing input: `listCoverageStagesDue(businessDate, [90, 90, 30])`. `unnest`
    yields the 90 stage twice, the caller emits two events for the same grain, and
    the second insert fails 23505 mid-scan against a grain the first insert in the
    same run created.

- **The stage set is duplicated in TypeScript and SQL with no cross-check**
  - Boundary: `COVERAGE_STAGES` and `chk_asset_coverage_alert_stage` encode 90/60/30
    independently. `listCoverageStagesDue` accepts any positive integer, so a stage
    added on one side is selected but not insertable.
  - Evidence: `src/compliance/maintenance-coverage.ts:78` against
    `read/projections/asset_coverage_alert.sql:30` and `:45`; the drift harness pins
    the constraint name only, at `test/unit/schema-drift.test.ts:1558-1563`.
  - Failing input: add `14` to `COVERAGE_STAGES` without editing the SQL. The scan
    selects 14-day rows and the first insert raises SQLSTATE 23514, aborting the
    remainder of that scan run. No test fails at build time.

- **`asset_coverage_alert` denormalises `asset_id` and `expiry_date` with no FK and no consistency guard**
  - Boundary: the alert row copies the coverage's asset and expiry at flag time.
    Nothing ties the copy to `asset_coverage`, and `app_user` holds `UPDATE` on
    `asset_coverage`.
  - Evidence: `read/projections/asset_coverage_alert.sql:26-27` (no
    `REFERENCES asset_coverage`); `read/projections/asset_coverage.sql:112`.
  - Failing input: fire the 90-day alert, then `UPDATE asset_coverage SET expiry_date
    = '2027-01-01'`. The 90 stage stays fired against the stale expiry, the 60 and 30
    stages re-derive against the new one, and the alert history reports two different
    expiry dates for one contract with no record of which is current.

## Append-Only `maintenance_warranty_override`

- **No conflict handling on the insert and no correction path once a row lands**
  - Boundary: `insertWarrantyOverride` has no `ON CONFLICT`, and `app_user` holds
    `INSERT, SELECT` only, so nothing can amend, void, or supersede a row.
  - Evidence: `src/read/projections/maintenance_warranty_override.ts:44-58`;
    `read/projections/maintenance_warranty_override.sql:63`.
  - Failing input: an override recorded against work order W with the wrong
    `reason_code`, or against a `warranty_coverage_id` later found to be a duplicate
    register entry. The row cannot be corrected, and because
    `uq_maintenance_warranty_override_work_order` is a single-row grain, a corrected
    override cannot be appended either. The mistaken row permanently unblocks
    chargeable completion on W.

- **`reason_code` is free text; "reason-coded" is not enforced anywhere in Group A**
  - Boundary: the only DB rule is `btrim(reason_code) <> ''`. There is no allowed-code
    set, no length bound, and the `btrim` gap from the coverage table applies here too.
  - Evidence: `read/projections/maintenance_warranty_override.sql:26`, `:31`, `:56`.
  - Failing input: `reason_code = E'\n'` or a 100 KB string. Both pass the CHECK and
    are stored as the durable record of a supervisor decision that Binding Decision 15
    says the event itself IS.

- **`warranty_coverage_id` on the override has no FK and no supersession behaviour**
  - Boundary: the column is `UUID NOT NULL` with no `REFERENCES asset_coverage`. The
    index at `:35` exists purely for lookup.
  - Evidence: `read/projections/maintenance_warranty_override.sql:25` and `:35`.
  - Failing input: replay `warranty_override_recorded` into a database rebuilt only
    to the Story 7.6 tail, or against a coverage register restored from an earlier
    snapshot. The override row points at a `coverage_id` that does not exist, and
    every read joining through `idx_maintenance_warranty_override_coverage` silently
    returns nothing rather than surfacing the orphan.

## Guarded `ADD COLUMN` Blocks on `maintenance_work_order`

- **No backfill: every pre-existing work order is silently declared warranty-free**
  - Boundary: `ADD COLUMN warranty_flagged BOOLEAN NOT NULL DEFAULT false` stamps
    `false` on all existing rows, and no `UPDATE` follows to re-derive the flag for
    breakdown orders that are still open.
  - Evidence: `read/projections/maintenance_work_order.sql:250` and `:261`; no
    backfill statement anywhere in the appended block (`:236-263`).
  - Failing input: a breakdown work order raised under Story 7.2 against an asset
    with an active warranty, still `open` at migration time. After migration it reads
    `warranty_flagged = false`, so `applyWorkOrderCompleted` never demands an
    override and the AC 4 gate is bypassed for the whole pre-migration backlog.

- **The guard tests for column presence only, never for its type or default**
  - Boundary: `IF NOT EXISTS (SELECT 1 FROM information_schema.columns ... column_name
    = 'warranty_flagged')` is satisfied by a column of any type with any default.
  - Evidence: `read/projections/maintenance_work_order.sql:245-251`.
  - Failing input: a database where a prior hotfix added `warranty_flagged` as
    `BOOLEAN NULL` with no default. The guard skips the `ALTER`, the migration reports
    success, and `insertWorkOrder` writes `NULL` for callers that omit the field.
    Every downstream `warranty_flagged` read is then three-valued rather than boolean.

- **`warranty_coverage_id` is nullable with no FK and no pairing constraint against `warranty_flagged`**
  - Boundary: the appended comment states "No CHECK constraint is needed", so nothing
    prevents `warranty_flagged = true` with `warranty_coverage_id IS NULL`, or the
    inverse, or a coverage id that names no row.
  - Evidence: `read/projections/maintenance_work_order.sql:236-241` (stated rationale)
    and `:261`.
  - Failing input: `insertWorkOrder({ warranty_flagged: true })` with
    `warranty_coverage_id` omitted. Line `src/read/projections/maintenance_work_order.ts:162-163 (`?? false` and `?? null`)`
    coerces the pair to `(true, null)`; the override applier then re-derives
    `warranty_coverage_id` from the locked row, reads `null`, and the
    `NOT NULL` column on `maintenance_warranty_override` raises 23502 as a 500.

## Date and Timestamp Handling

- **`insertCoverage` and `insertCoverageAlert` cast raw strings to `::date` with no calendar validation**
  - Boundary: the read accessors call `isValidCalendarDate`; the write accessors do
    not. Postgres accepts the special literals `infinity`, `-infinity`, `today`,
    `yesterday`, `tomorrow`, `now` and `epoch` as `date` input.
  - Evidence: `src/read/projections/asset_coverage.ts:84`;
    `src/read/projections/asset_coverage_alert.ts:52`. Compare the guarded read paths
    at `asset_coverage.ts:152` and `:258`.
  - Failing input: `insertCoverage({ start_date: '2026-01-01', expiry_date:
    'infinity' })`. `chk_asset_coverage_dates` passes, `getActiveWarrantyForAsset`
    matches forever, and the next scan's `(c.expiry_date - $1::date)` raises "cannot
    subtract infinite dates", failing every subsequent coverage scan for the whole
    tenant. The row cannot be removed because there is no delete or supersede path.

- **`'today'` and `'now'` resolve against the server clock, not the business date**
  - Boundary: the same unvalidated `::date` cast makes clock-relative literals legal
    on a path whose entire design premise is that the server clock is never read
    inside a statement.
  - Evidence: `src/read/projections/asset_coverage.ts:84` against the module docblock
    at `:9-13`.
  - Failing input: `expiry_date: 'today'` submitted at 19:00 IST on 2026-08-27. The
    row stores 2026-08-28 because the server session is UTC, and the stored coverage
    disagrees with the payload by one day.

- **`business_date` and `flagged_at` on an alert row are unconstrained relative to each other**
  - Boundary: `business_date DATE` and `flagged_at TIMESTAMPTZ` are independent
    columns with no CHECK relating them, and `flagged_at` is client-supplied.
  - Evidence: `read/projections/asset_coverage_alert.sql:26-28`.
  - Failing input: `business_date = '2026-08-27'`, `flagged_at =
    '2027-01-01T00:00:00Z'`. Both are stored. `listCoverageAlerts` orders by
    `flagged_at DESC` (`src/read/projections/asset_coverage_alert.ts:136`), so the
    row sorts to the top of the alert feed a year before its business date.

- **`chk_asset_coverage_dates` is strictly greater, so a single-day coverage is rejected**
  - Boundary: `expiry_date > start_date` excludes `expiry_date = start_date`.
  - Evidence: `read/projections/asset_coverage.sql:41` and `:93`; mirrored in Group B
    at `src/compliance/maintenance-coverage.ts:166`.
  - Failing input: a one-day insurance cover note with `start_date = expiry_date =
    2026-08-27`. It is rejected with no alternative encoding, while the equally
    degenerate zero-remaining-days case (expiry equal to business date) is accepted
    everywhere else in the story.

## Migration Idempotency and Mirror Drift

- **`CREATE UNIQUE INDEX IF NOT EXISTS` matches on name only, so an index with a wrong expression is never repaired**
  - Boundary: `IF NOT EXISTS` compares the relation name, never the indexed
    expression, column list, or uniqueness. A re-run silently accepts whatever index
    already bears the name.
  - Evidence: `read/projections/asset_coverage.sql:45`; mirrored verbatim at
    `deploy/compose/init-db.sql:7922`.
  - Failing input: a database where an earlier iteration created
    `uq_asset_coverage_reference` as `(asset_id, coverage_type,
    reference_number_ext)` without `lower()`. Re-running the migration reports
    success, the case-folding grain is absent, and `AMC-1` plus `amc-1` both persist.

- **The drift harness pins index names but never index bodies**
  - Boundary: `CREATE TABLE` bodies and named constraint `DO` blocks are compared
    string-for-string between canonical and `init-db.sql`; indexes are checked with a
    bare substring `includes` of the name on each side.
  - Evidence: `test/unit/schema-drift.test.ts:1564-1567`; the 7.7 entry listing
    `uq_asset_coverage_reference` under `indexes` at `:1174`.
  - Failing input: edit `deploy/compose/init-db.sql` to drop `lower(...)` from the
    `uq_asset_coverage_reference` definition while keeping the name. The whole suite
    passes, and container-initialised databases silently lose the case-insensitivity
    that migrate-provisioned databases keep. The verbatim mirror is currently correct
    (verified byte-for-byte modulo CRLF), so this is a gap in the guard, not in the
    present content.

- **The guarded `ADD CONSTRAINT` blocks validate existing rows with no skip or repair path**
  - Boundary: every `DO` block's `ELSE` branch is empty, and `ALTER TABLE ... ADD
    CONSTRAINT CHECK` validates the whole table. A single pre-existing violating row
    aborts the migration, and because the block is inside `DO $$`, the failure is not
    isolated to that constraint.
  - Evidence: `read/projections/asset_coverage.sql:60-99` (five identical blocks);
    same shape at `asset_coverage_alert.sql:36-59` and
    `maintenance_warranty_override.sql:38-58`.
  - Failing input: a database carrying an `asset_coverage` row with
    `contract_value = -1` from a partially applied earlier run. `npm run db:migrate`
    fails at `chk_asset_coverage_value_non_negative` and never reaches the
    `asset_coverage_alert` or `maintenance_warranty_override` files that follow it in
    the migration list, leaving the schema half-applied with no resume marker.

## Event Contract Additivity

- **Replaying a pre-7.7 `breakdown_work_order_created` payload re-derives the warranty flag against today's register**
  - Boundary: `warranty_flagged` and `warranty_coverage_id` are optional on the way
    in and derived when absent. An old payload has neither, so a replay derives them
    from whatever `asset_coverage` rows exist at replay time rather than reproducing
    the historical state.
  - Evidence: `src/events/schema.ts:2288-2297` (both fields optional, described as
    "always present on the persisted payload");
    `src/read/projections/maintenance_work_order.ts:162-163 (`?? false` and `?? null`)` (`?? false`).
  - Failing input: a `breakdown_work_order_created` event persisted on 2026-06-01,
    replayed on 2026-09-01 after a warranty covering 2026-05-01 to 2026-12-31 was
    recorded for that asset. The rebuilt row is `warranty_flagged = true` while the
    original was `false`; a rebuild of the same event log produces a different
    projection, and the completion gate now blocks a work order that historically
    completed without an override.

## Accessor Filter Boundaries

- **Empty-string filters are treated as absent rather than as an empty match**
  - Boundary: `if (filters.asset_id)`, `if (filters.coverage_type)` and
    `if (filters.status)` are truthiness tests, so `''` skips the condition entirely
    instead of returning `[]` the way an invalid value does.
  - Evidence: `src/read/projections/asset_coverage.ts:192`, `:197`, `:202`;
    identical shape at `src/read/projections/asset_coverage_alert.ts:111`, `:116`.
  - Failing input: `listCoverages({ asset_id: '' })`. A caller that meant "this
    asset, whose id resolved to empty" receives the first 100 coverage rows of every
    asset in the company, while `listCoverages({ asset_id: 'not-a-uuid' })` correctly
    returns `[]`. The two invalid inputs take opposite paths.

- **`business_date` supplied without `status` is silently discarded**
  - Boundary: `business_date` is read only inside the `if (filters.status)` branch.
    Outside it, the parameter has no effect and no error.
  - Evidence: `src/read/projections/asset_coverage.ts:202-217`.
  - Failing input: `listCoverages({ asset_id: A, business_date: '2026-08-27' })`. The
    caller receives expired and future coverages mixed with active ones, with nothing
    in the result indicating the as-of date was ignored.

## Deletion Check

The diff replaces the `insertWorkOrder` `INSERT` statement at
`src/read/projections/maintenance_work_order.ts:143-168`, widening the column list
and shifting `created_at` and `updated_at` from `$13, $14` to `$15, $16`. The
parameter array was re-ordered to match and no prior column, constraint, index, or
grant was removed. No behaviour present at baseline `e93014f` was dropped without a
replacement, so no deletion findings are raised.
