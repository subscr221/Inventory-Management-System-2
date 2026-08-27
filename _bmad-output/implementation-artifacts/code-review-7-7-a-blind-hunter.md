# Code Review 7.7 Group A - Blind Hunter

Adversarial review of Story 7.7 "AMC, Warranty, and Insurance Tracking", Group A only
(schema, events, projections, migrations). Baseline `e93014f`, HEAD `d46c348`.
Sources reviewed: `_bmad-output/diff-7-7-group-a.patch` (1704 lines) and
`_bmad-output/diff-7-7-initdb-mirror.patch` (800 lines), plus the working-tree files
they produce.

Table 1 summarises the finding counts by severity. Every finding is stated below with
`file:line` evidence.

**Table 1: Finding counts by severity**

| **Severity** | **Count** |
| --- | --- |
| High | 2 |
| Medium | 5 |
| Low | 7 |
| Informational | 1 |
| **Total** | **15** |

## Findings

- **Stale column list returns rows that lie about their own type (High).**
  `src/read/projections/maintenance_work_order.ts:336-355`. `MaintenanceWorkOrderRow`
  (`:5-36`) now declares `labor_cost`, `parts_cost`, `total_cost`,
  `capitalization_flagged`, `warranty_flagged` and `warranty_coverage_id` as REQUIRED
  fields, and `WORK_ORDER_COLUMNS` (`:52-60`) was extended to select them. But
  `listBreakdownWorkOrdersInPeriod` keeps its own hand-written select list, which still
  ends at `w.overdue_at, w.escalated_at, w.created_at, w.updated_at` (`:341`), and it
  still returns `result.rows as MaintenanceWorkOrderRow[]` (`:355`). The `as` cast
  suppresses the compiler entirely - `npx tsc --noEmit` exits 0 - so all six fields are
  `undefined` at runtime while TypeScript promises `boolean` and `string`. This is a
  defect because `warranty_flagged` then reads falsy, which is precisely the value that
  means "not under warranty, no override required". Only
  `src/maintenance/reliability-jobs.ts:178` consumes the function today, so the bug is
  latent, but the type contract is already false and the next reader of that row
  silently bypasses the AC 3 gate.

- **A renewed coverage keeps firing the superseded contract's remaining alert stages
  (High).** `src/read/projections/asset_coverage.ts:252-286`. The function is a
  declared clone of `listCertificateStagesDue`
  (`src/read/projections/instrument_calibration_certificate.ts:245`), but it drops that
  function's first predicate, `c.status = 'active'` (`:256`). `asset_coverage` has no
  status, superseded_at or superseded_by column at all
  (`read/projections/asset_coverage.sql:29-43`), and nothing else in the query excludes
  a contract that a newer row for the same asset and coverage type has already
  replaced. This is a defect because the file's own header claims a renewal "produces a
  fresh set of three stages while the superseded contract keeps its fired ones"
  (`src/read/projections/asset_coverage.ts:246-248`) - the superseded contract's
  UNFIRED stages keep firing as well, so a renewed AMC still raises "expires in 60
  days" and "expires in 30 days" alerts, the 30-day one carrying the
  `maintenance_supervisor` escalation clock from Binding Decision 8. The story's AC 1
  suite (task 8.2) asserts only that the new coverage earns fresh stages and the old
  one's ALREADY FIRED stages stay fired, so no planned test detects this.

- **The expression uniqueness grain is pinned by bare substring match (Medium).**
  `test/unit/schema-drift.test.ts:1174` places `uq_asset_coverage_reference` in the
  `indexes` list, and the loop's index assertion (`:1565-1567`) is only
  `canonicalSql.includes(index)` and `initDb.includes(index)` - a name match that a
  comment mentioning the name would satisfy. Named constraints get a full
  normalized-body comparison (`:1559-1563`); expression indexes get nothing. This is a
  defect because the entire semantic content of this index is the `lower()` call: if
  `lower(reference_number_ext)` is dropped from the init-db copy, case-variant
  duplicate contracts become insertable on container-init databases while the migrate
  path keeps rejecting them, and the drift guard stays green. The EXPECTED comment
  (`:1170-1173`) explicitly notes the index "lives in the index list, not the
  constraint list" without adding any compensating body pin.

- **`coverage_type` is declared on the alert payload but has nowhere to land (Medium).**
  `src/events/schema.ts:2936` declares `coverage_type` as "Derivable ... declared and
  checked" on `CoverageExpiryFlaggedPayload`, but `asset_coverage_alert`
  (`read/projections/asset_coverage_alert.sql:21-32`) has no `coverage_type` column.
  Contrast `asset_id` and `expiry_date`, which are both denormalized onto the alert
  row. This is a defect because the projection cannot be rebuilt to the shape the event
  declares, `listCoverageAlerts`
  (`src/read/projections/asset_coverage_alert.ts:110-142`) exposes no coverage_type
  filter, and answering "which AMCs are expiring" requires a join to `asset_coverage`
  that no Group A accessor provides.

- **Two tables declared append-only are granted UPDATE (Medium).**
  `read/projections/asset_coverage.sql:112` and
  `read/projections/asset_coverage_alert.sql:64` both grant `INSERT, SELECT, UPDATE` to
  `app_user`. `asset_coverage.sql:18-19` states "Records are APPEND-ONLY with no
  amendment, void, or supersede path in Phase 1"; the alert header states an alert
  "fires ONCE PER STAGE per coverage". Neither `src/read/projections/asset_coverage.ts`
  nor `asset_coverage_alert.ts` exposes any UPDATE accessor. The same diff gets this
  right for `maintenance_warranty_override`, which grants `INSERT, SELECT` only
  (`read/projections/maintenance_warranty_override.sql:60`) citing the
  `maintenance_reliability_metric` precedent. This is a defect because it is unused
  privilege that directly contradicts the documented invariant, and it is now pinned in
  the drift test (`test/unit/schema-drift.test.ts:1187`), which makes it durable rather
  than accidental.

- **`asset_coverage.updated_at` is a dead column with no writer (Medium).**
  `read/projections/asset_coverage.sql:37` defines `updated_at TIMESTAMPTZ NOT NULL
  DEFAULT now()`. `insertCoverage` (`src/read/projections/asset_coverage.ts:88-108`)
  never sets it, no accessor in the file updates it, and no trigger exists anywhere
  under `read/projections/`. It is nevertheless exported on `CoverageRow` (`:25`) and
  selected by `COVERAGE_COLUMNS` (`:61`). This is a defect because every API consumer
  is handed a timestamp that can only ever equal `created_at`, which reads as
  "last amended" and is not. Either the supersede path is missing (see the High finding
  above) or the column is.

- **A coverage shorter than 90 days fires all three stages simultaneously (Medium).**
  `chk_asset_coverage_dates` (`read/projections/asset_coverage.sql:41`) requires only
  `expiry_date > start_date`, so a 45-day insurance cover note is valid.
  `listCoverageStagesDue` marks a stage due when
  `(c.expiry_date - $1::date) <= s.stage_days`
  (`src/read/projections/asset_coverage.ts:264`), so on the first scan after recording,
  90, 60 and 30 are all due and all unfired. This is a defect because it produces three
  alert rows and three notifications for one contract in a single run, one of them
  carrying the supervisor escalation clock, for a contract nobody has had a chance to
  act on. There is no minimum-duration guard, no suppression, and no case for it in the
  story's AC 1 suite.

- **`listCoverageStagesDue` is the only unbounded accessor in the module (Low).**
  `src/read/projections/asset_coverage.ts:252-286` has no LIMIT and no paging, unlike
  `listCoverages` (`:214-232`) and `listCoverageAlerts`
  (`src/read/projections/asset_coverage_alert.ts:126-142`), both capped at 500. The
  POST-triggered scan opens one transaction and emits one event plus one notification
  per returned row, so the request's work is bounded only by the size of the register.
  This is a defect of degree rather than kind: the 7.5 twin is also unbounded, but 7.5
  scopes to an instrument register while 7.7's asset register is company-wide with no
  site scoping (AD-9), so the worst-case row count is strictly larger here.

- **The migration list justifies its ordering with a false invariant (Low).**
  `src/events/migrate.ts:142`, and the identical Story 7.6 comment at `:127`, state "No
  FKs exist between projections, so this order is logical rather than
  dependency-forced." `read/projections/cross_dock_task.sql:3-15` and
  `read/projections/cross_dock_constraints.sql:10` carry real FOREIGN KEY clauses to
  `grn_line`, `erp_sales_order`, `lot_master`, `location_register` and `users`. The
  three Story 7.7 tables genuinely have no FKs, so the placement itself is safe. This
  is a defect because the invariant written into the migration list is wrong and would
  license a future reorder that breaks the cross-dock chain.

- **`warranty_coverage_id` admits three states where the contract has two (Low).**
  `src/events/schema.ts:2295-2296` types the seam write-back as `warranty_flagged?:
  boolean` and `warranty_coverage_id?: string | null`. Binding Decision 3 says any
  declared value is rejected with 409 `WORK_ORDER_DERIVATION_MISMATCH`, yet the type
  admits `undefined` (not declared), `null` (declared as "no coverage") and a string
  (declared as a coverage). This is a defect because Group B must discriminate
  `undefined` from an explicitly declared `null`; a truthiness check rather than a
  `!== undefined` or `in` check would let a forged explicit `null` pass on an asset that
  IS covered, silently unflagging it. Group A ships the ambiguity and no guard against
  it.

- **Filter accessors answer malformed input with an empty list, not a signal (Low).**
  `src/read/projections/asset_coverage.ts:202-216`: a `status` filter with no
  `business_date` companion, an unrecognised `status`, a non-UUID `asset_id` and an
  unknown `coverage_type` all `return []`. The same shape appears in
  `listCoverageAlerts` (`src/read/projections/asset_coverage_alert.ts:118-134`). This
  is a defect because the caller cannot distinguish "no coverages match" from "your
  query was malformed", so a Group B handler that forgets to pass `business_date`
  renders an empty coverage register behind a 200. It is precedent-consistent with the
  7.5 twin, but it means Group A supplies no validation signal at all and the entire
  burden falls on a layer this group does not deliver.

- **Reference numbers are stored and matched untrimmed (Low).**
  `chk_asset_coverage_reference_ext` (`read/projections/asset_coverage.sql:40`) rejects
  only whitespace-only values; `uq_asset_coverage_reference` (`:45`) keys on
  `lower(reference_number_ext)` with no `btrim`; `insertCoverage`
  (`src/read/projections/asset_coverage.ts:88-108`) writes the value verbatim. This is
  a defect because `'AMC-2026-01'` and `'AMC-2026-01 '` become two distinct contracts on
  the same asset, and both then compete in `getActiveWarrantyForAsset`. The header at
  `read/projections/asset_coverage.sql:22-23` claims the grain means "a case variant of
  a contract reference is the same contract" - it handles case and silently does not
  handle padding. Repo-wide precedent (`uq_asset_tag`,
  `uq_instrument_register_instrument_id`, `uq_asset_meter_code`) shares the gap, so this
  is inherited rather than introduced.

- **`listCoverageAlerts` orders by an instant that is identical across a catch-up batch
  (Low).** `src/read/projections/asset_coverage_alert.ts:136` uses
  `ORDER BY flagged_at DESC, alert_id ASC`. When a catch-up scan fires 90, 60 and 30 for
  one coverage in a single run, the three rows share a `flagged_at`, so the tiebreak
  falls to a random UUID. This is a defect because the three stages then come back in
  arbitrary order rather than most-urgent-first. The 7.5 twin orders
  `business_date DESC, stage_days ASC, alert_id ASC`
  (`src/read/projections/instrument_calibration_alert.ts:146`), which is stable.

- **The stage accessor accepts values the table CHECK will reject (Low).**
  `src/read/projections/asset_coverage.ts:260` filters caller-supplied stages with only
  `Number.isInteger(s) && s > 0`, while `chk_asset_coverage_alert_stage`
  (`read/projections/asset_coverage_alert.sql:30`) pins `stage_days IN (90, 60, 30)`.
  This is a defect because a caller passing, for example, 45 gets due rows back and
  `insertCoverageAlert` then raises SQLSTATE 23514 - a class the story's 23505 duplicate
  mapper (task 4.6) does not handle - failing the whole scan transaction with an
  unmapped error. The header at `read/projections/asset_coverage_alert.sql:17-18`
  insists the stages "are a module constant and never deployment configuration", yet the
  accessor takes them as a parameter and never validates against that constant.

- **The schema-drift suite is left red, so it cannot act as a green gate for this diff
  (Informational).** `npx tsx --test test/unit/schema-drift.test.ts` reports 107 pass
  and 1 fail. The failure is `gate_dwell_metric: view body is canonical and mirrored in
  init-db.sql` (`test/unit/schema-drift.test.ts:1598`), a pre-existing CRLF-versus-LF
  mismatch that story task 1.5 names explicitly and does not fix. All four Story 7.7
  assertions pass. This is worth recording because a permanently red drift suite means a
  genuine future regression inside it will not stand out from the standing failure.

## Verified as Claimed

The following Group A claims were checked mechanically and hold.

- The three new SQL files are mirrored into `deploy/compose/init-db.sql` VERBATIM
  (byte-identical after CRLF normalisation), and both `warranty_flagged` and
  `warranty_coverage_id` guarded ADD COLUMN blocks are byte-identical between
  `read/projections/maintenance_work_order.sql` and the init-db copy.
- Line endings are clean: `init-db.sql` and `maintenance_work_order.sql` are 100 percent
  CRLF with zero bare LF; the three new canonical files are 100 percent LF, matching
  every other file under `read/projections/`. No mixed endings anywhere.
- All three new event types are registered in `SUPPORTED_EVENT_TYPES` with
  `streamType: 'maintenance'` and `requiresBusinessStream: false`
  (`src/events/schema.ts:3612-3624`).
- The three new files are appended at the TAIL of `MIGRATIONS` with no existing entry
  reordered (`src/events/migrate.ts:138-146`).
- `maintenance_warranty_override` correctly grants `INSERT, SELECT` only and exposes no
  update or delete accessor.
- `uq_asset_coverage_reference` is a UNIQUE INDEX, not a table-level UNIQUE, correctly
  respecting the Story 7.5 expression rule; `uq_asset_coverage_alert_stage` is correctly
  a table constraint since it covers plain columns.
- `npx tsc --noEmit` exits 0 (though see the first High finding, where an `as` cast is
  the reason it does).
