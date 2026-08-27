# Code Review 7.7 Group A: Acceptance Auditor

Story spec: `_bmad-output/implementation-artifacts/7-7-amc-warranty-and-insurance-tracking.md`
Baseline `e93014f`, HEAD `d46c348`. Scope: Group A only (canonical SQL projections, TypeScript read
projections, `src/events/schema.ts`, `src/events/migrate.ts`, `test/unit/schema-drift.test.ts`, and
the `deploy/compose/init-db.sql` mirror). The seam, jobs, API routes, and integration tests are out
of scope and are reviewed by the other groups.

## Context Document Warning

- The story file's YAML frontmatter contains **only** `baseline_commit`. There is **no `context`
  field**, so no context document set could be loaded from it. Evidence:
  `_bmad-output/implementation-artifacts/7-7-amc-warranty-and-insurance-tracking.md:1-3`.
- As a substitute, every artifact named in the story's `## References` section was resolved on disk
  and all of them exist: `_bmad-output/planning-artifacts/epics.md`,
  `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md`,
  `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`,
  `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md`,
  `docs/adr/ADR-001-notification-emission-coupling.md`, the Story 7.3, 7.5 and 7.6 implementation
  artifacts, `_bmad-output/implementation-artifacts/deferred-work.md`, and
  `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md`. Nothing referenced is
  missing.
- FR-M-10/11 was verified verbatim against the PRD line 287 and the epic line 166: "AMC, warranty,
  insurance records with 90/60/30-day expiry alerts; warranty check at work-order creation with
  reason-coded override." The four acceptance criteria in the story match the epic's Story 7.7 block
  at line 2265 with no drift.

## Findings

Table 1 summarizes the findings; each is expanded below it.

**Table 1: Group A Findings Summary**

| # | Severity | Title | AC or Binding Decision |
| --- | --- | --- | --- |
| 1 | Medium | No backfill for `warranty_flagged` on work orders open at migration time | AC 2, AC 3 |
| 2 | Low | Schema permits a `warranty_flagged` work order with a null coverage id | AC 3, Binding Decision 11 |
| 3 | Low | `asset_coverage` grants `UPDATE` and carries a permanently dead `updated_at` | Binding Decision 5 |
| 4 | Low | `getActiveWarrantyForAsset` fails open on malformed input | AC 2, Binding Decision 6 |
| 5 | Low | `listCoverageStagesDue` accepts stages the alert CHECK will reject | AC 1, Binding Decision 7 |
| 6 | Info | Unused accessor `getCoverageAlertById` beyond the Task 3.2 contract | Task 3.2 |

- **Finding 1 (Medium): the additive `warranty_flagged` column defaults to `false` with no backfill,
  so AC 2 and AC 3 silently do not apply to any breakdown work order that is already open when the
  migration runs.** Violates the intent of AC 2 (warranty check at breakdown work-order creation) and
  AC 3 (chargeable work blocked on a flagged order). The migration adds the column with
  `NOT NULL DEFAULT false` and no `UPDATE ... FROM asset_coverage` backfill pass, and nothing else in
  Group A derives the flag for a pre-existing row. Every open breakdown work order on an asset under
  an active warranty therefore completes unblocked, permanently, because the flag is derived only
  once at creation in `applyBreakdownWorkOrderCreated`. This is not a race or a transient window: the
  affected rows never become flagged. Evidence:
  `read/projections/maintenance_work_order.sql:250` (`ALTER TABLE maintenance_work_order ADD COLUMN
  warranty_flagged BOOLEAN NOT NULL DEFAULT false;`) and `read/projections/maintenance_work_order.sql:261`.
  No task in the spec covers a backfill, and the Story 7.7 section of
  `_bmad-output/implementation-artifacts/deferred-work.md:352-359` records six deferrals, none of
  which is this one, so the gap is neither implemented nor logged. Either a one-shot backfill block
  in the canonical SQL or an explicit deferred-work entry is required to close AC 2 and AC 3 for the
  in-flight population.

- **Finding 2 (Low): no CHECK pairs `warranty_flagged` with `warranty_coverage_id`, so the schema
  permits a work order that can never be completed.** Touches AC 3 and Binding Decision 11. A row with
  `warranty_flagged = true` and `warranty_coverage_id IS NULL` is structurally legal; the AC 3 gate
  would then block completion forever, because the override grain requires a coverage id
  (`maintenance_warranty_override.warranty_coverage_id UUID NOT NULL`, at
  `read/projections/maintenance_warranty_override.sql:229`) and the override applier re-derives the
  declared coverage id against the locked work-order row. Task 1.4 explicitly waives the constraint
  ("No CHECK constraint is needed (a nullable UUID and a defaulted boolean are self-validating)"), so
  the implementation follows the spec; the finding is against the spec's intent, because the sibling
  Story 6.1 projection landed in the very same migration batch pins exactly this class of pairing at
  the database level (`chk_production_order_expediting_pairing`, mirrored at
  `deploy/compose/init-db.sql` in the production order block). Evidence:
  `read/projections/maintenance_work_order.sql:235-262` adds both columns with no pairing constraint.

- **Finding 3 (Low): `asset_coverage` is granted `UPDATE` to `app_user` although Binding Decision 5
  declares the table append-only, and its `updated_at` column is never written.** Contradicts Binding
  Decision 5 ("Coverage records are append-only with no amendment, void, or supersede path in Phase
  1"). Task 1.1 mandates the `INSERT, SELECT, UPDATE` grant, so the implementation is spec-conformant
  and the contradiction lives in the spec itself; it is worth recording because the story's own
  companion table gets this right (`GRANT INSERT, SELECT ON maintenance_warranty_override TO
  app_user`, `read/projections/maintenance_warranty_override.sql:267`, with the same append-only
  rationale in its header). The `UPDATE` grant is the only thing standing between a future accessor
  and a silent amendment path that Binding Decision 5 forbids and that the deferred-work entry at
  `deferred-work.md:353` assumes is impossible without direct SQL. Evidence:
  `read/projections/asset_coverage.sql:112` (grant) and `read/projections/asset_coverage.sql:37`
  (`updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, written by no accessor in
  `src/read/projections/asset_coverage.ts`).

- **Finding 4 (Low): `getActiveWarrantyForAsset` returns `null` on a malformed `asset_id` or
  `business_date` rather than raising, so the AC 2 derivation fails OPEN.** Sits against AC 2 and the
  fail-closed posture of Binding Decision 6. A bad calendar date produces "no active warranty",
  which writes `warranty_flagged = false` and lets the repair be treated as chargeable, instead of
  surfacing an error. The function is described in its own header as "load-bearing on the AC 2
  work-order check". Evidence: `src/read/projections/asset_coverage.ts:146-153` (`if
  (!UUID_REGEX.test(assetId)) return null; if (!isValidCalendarDate(businessDate)) return null;`).
  Mitigated in practice by the pre-transaction shape assert on the breakdown envelope (Group B), so
  this is a defence-in-depth gap rather than a live bypass; the list accessors returning `[]` on bad
  input is spec-mandated by Task 3.1, but Task 3.1 pins no failure mode for this singular getter.

- **Finding 5 (Low): `listCoverageStagesDue` accepts any positive integer stage, while
  `chk_asset_coverage_alert_stage` accepts only 90, 60 and 30.** Touches AC 1 and Binding Decision 7
  (stages are the module constant `COVERAGE_STAGES = [90, 60, 30]`, not configuration). A caller
  passing a non-member stage receives due rows that then fail insertion with an unmapped SQLSTATE
  23514, surfacing as a 500 rather than a validation error. Evidence:
  `src/read/projections/asset_coverage.ts:259` (`const stageList = stages.filter((s) =>
  Number.isInteger(s) && s > 0);`) against `read/projections/asset_coverage_alert.sql:159`
  (`CHECK (stage_days IN (90, 60, 30))`). The only production caller passes `COVERAGE_STAGES`
  (`src/maintenance/coverage-jobs.ts:116`), and the shape is inherited verbatim from
  `listCertificateStagesDue` (`src/read/projections/instrument_calibration_certificate.ts:252-259`),
  which Task 3.1 instructed the author to clone, so the class is inherited rather than introduced.

- **Finding 6 (Info): `getCoverageAlertById` is exported but has no caller anywhere in `src/` or
  `test/`.** Task 3.2 specifies exactly three accessors for
  `src/read/projections/asset_coverage_alert.ts` (`insertCoverageAlert`,
  `getCoverageAlertForStage`, `listCoverageAlerts`); this is a fourth. Evidence:
  `src/read/projections/asset_coverage_alert.ts:80`, with a repository-wide search for the symbol
  returning only that definition.

## Verified Conformance

The following spec obligations were checked and hold; they are recorded so a later reviewer does not
repeat the work.

- Task 1.1: `asset_coverage` matches the mandated column list, types, nullability and all five
  `chk_` names; the uniqueness grain is the expression UNIQUE INDEX `uq_asset_coverage_reference` on
  `(asset_id, coverage_type, lower(reference_number_ext))`, never a table-level UNIQUE on an
  expression; `idx_asset_coverage_asset` and `idx_asset_coverage_expiry` present; every constraint is
  inline and re-guarded in a `pg_constraint` DO block; grants are `pg_roles`-guarded.
- Task 1.2: `asset_coverage_alert` matches the mandated columns, the grain constraint
  `uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days)` is a table-level constraint on
  plain columns as specified, `chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30))`
  pins AC 1's stages at the database level, and both indexes exist.
- Task 1.3: `maintenance_warranty_override` matches the mandated columns, carries
  `uq_maintenance_warranty_override_work_order UNIQUE (work_order_id)` for Binding Decision 11, and
  the append-only grant is `INSERT, SELECT` to `app_user` with no `UPDATE`.
- Task 1.4: both work-order columns are added by guarded `information_schema.columns` DO blocks that
  include `table_schema = current_schema()`; no existing column, constraint, index or grant is
  touched.
- Task 1.5: the three canonical files appear byte-for-byte verbatim inside
  `deploy/compose/init-db.sql` (verified programmatically after CRLF normalization), the two
  work-order ADD COLUMN blocks appear exactly once each, and the file is CRLF-pure: 8163 line
  endings, 8163 CRLF, zero bare LF, so the `gate_dwell_metric` mixed-ending failure class is not
  reproduced.
- Task 1.6: the three files are registered at the tail of `MIGRATIONS` after `production_order.sql`
  (`src/events/migrate.ts:144-146`) with a Story 7.7 comment block, and no existing entry is
  reordered; `maintenance_work_order.sql` keeps its position at line 100 so its new guarded blocks
  re-apply.
- Task 1.7: `test/unit/schema-drift.test.ts` gains one EXPECTED entry per new table naming every
  constraint and index, with `appUserGrant: 'INSERT, SELECT'` correctly withheld from the override
  table, plus a dedicated mirror test pinning both warranty ADD COLUMN guard blocks and their exact
  DDL fragments, since the EXPECTED loop cannot see additive columns.
- Task 2.1: all three payload interfaces and all three envelope types carry exactly the mandated
  field sets, with `contract_value` as an exact decimal string, `stage_days` as the literal union
  `90 | 60 | 30`, and derived fields documented as declared-and-checked.
- Task 2.2: `BreakdownWorkOrderCreatedPayload` is extended additively with optional
  `warranty_flagged` and `warranty_coverage_id` documented as seam-derived write-back, and
  `MaintenanceWorkOrderCompletedPayload` carries no Story 7.7 change (its cost fields are Story 7.6).
- Task 2.3: the three event types are registered at the tail of the maintenance block of
  `SUPPORTED_EVENT_TYPES`, each `{ streamType: 'maintenance', requiresBusinessStream: false }`, with
  the Story 7.7 comment.
- Task 3.1: every mandated accessor exists with the specified SQL, including
  `getActiveWarrantyForAsset` implementing Binding Decision 4 exactly (`coverage_type = 'warranty'`,
  `start_date <= $2::date`, `expiry_date >= $2::date`, `ORDER BY expiry_date DESC, coverage_id ASC
  LIMIT 1`) and `listCoverageStagesDue` implementing the Staged Alert Contract exactly
  (`CROSS JOIN unnest($2::int[])`, unfired LEFT JOIN on the grain, `<=` day-count test never an
  equality test, scope narrowed in SQL, `ORDER BY expiry_date ASC, stage_days ASC, coverage_id ASC`,
  `days_remaining` in SQL DATE arithmetic). DATE columns render through `to_char` and NUMERIC through
  `::text`; no server clock is read inside any statement.
- Task 3.2 and Task 3.3: all mandated accessors exist, and the override module exposes no update or
  delete path.
- Task 3.4: `MaintenanceWorkOrderRow` gains both fields, `WORK_ORDER_COLUMNS` selects both so they
  are not write-only, and `insertWorkOrder` extends the column list, the placeholder list and the
  parameter array in matching order (verified positionally against
  `src/read/projections/maintenance_work_order.ts:142-167`).
- Group A supplies every contract the downstream ACs need: AC 1 has the stage-pinned alert table and
  the due-and-unfired query, AC 2 has `warranty_flagged` / `warranty_coverage_id` on the work-order
  row plus `getActiveWarrantyForAsset`, AC 3 has the gate's read surface
  (`getWarrantyOverrideByWorkOrder`) and `warranty_flagged` in `WORK_ORDER_COLUMNS`, and AC 4 has
  `WarrantyOverrideRecordedPayload` capturing the override id, its reason code and the overriding
  actor. Every Group A export is consumed by a downstream module, so no contract is orphaned apart
  from Finding 6.
