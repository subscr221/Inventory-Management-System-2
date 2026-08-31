---
baseline_commit: ce5989c
---

# Story 8.6: Statutory Release Blocks and Quality Reporting

Status: done

## Story

As a compliance officer,
I want BIS licence validity and Legal Metrology label version control to block release against the Story 8.7 compliance master data, and a quality reporting dashboard over the FR-Q-13 metrics,
so that no lot ships without its statutory quality gates satisfied and quality performance is measurable.

## Acceptance Criteria

1. **Given** a product requiring a BIS licence (FR-Q-11), **When** release is attempted and the licence register holds no valid, unexpired licence covering the product, **Then** release is rejected with `error_code: "BIS_LICENCE_INVALID"` (409) and the rejection is written to the statutory audit log.
2. **Given** a product requiring a BIS licence with a valid licence in the register (FR-Q-11), **When** release completes, **Then** the CM/L or R-number from the register is recorded in `qc_batch_release.bis_licence_number` (the release record), replacing the Story 8.4 null stub.
3. **Given** a packaged commodity requiring a Legal Metrology label (FR-Q-14), **When** release is attempted without a current approved label version in the label masters, **Then** release is rejected with `error_code: "LABEL_VERSION_MISSING"` (409) and audited, until a version-controlled approved label is in place.
4. **Given** the statutory blocks are configured dormant (migration window, A-13), **When** a BIS-covered or label-required lot is released, **Then** release behaves exactly as Story 8.4 shipped it: the licence number is recorded when the register has one, null otherwise, and neither block rejects.
5. **Given** a QC head opens the quality reporting dashboard (FR-Q-13), **When** the dashboard endpoint is called for a period, **Then** it returns first-pass yield (lots accepted / lots dispositioned in the period), rejection rates by product and by defect code, NCR aging, CAPA aging, conditional-release counts, and calibration lockout event counts, each metric carrying bounded drill-through rows with the underlying `disposition_id` / `ncr_id` / `capa_id` / `deviation_id` / audit `log_id` identifiers.
6. **Given** a period with no QC activity, **When** the dashboard is called, **Then** each metric returns a first-class empty shape (zero denominators reported as no-data, never a fabricated 0% or 100% yield).
7. **Given** a caller without a `qc` read assignment for a site, **When** the dashboard is called, **Then** rows for that site are excluded by the same site-narrowing the existing QC list routes apply.

## Binding Scope Decisions

These decisions are made. Do not re-litigate them during implementation. If reality contradicts one, disclose the deviation in Debug Log References rather than changing it silently.

1. **This story creates the minimal enforcement-contract tables; Story 8.7 layers governance on top.** New projections `compliance_bis_licence` and `label_master` carry only the columns the release blocks read. Story 8.7 adds its CRUD routes, approval workflow, edit-logging, expiry alerts, and any additional columns. This story ships NO write routes and NO new event types for these tables; integration fixtures seed rows through the admin pool (the same idiom the suite already uses because `app_user` lacks DELETE). `app_user` gets SELECT only on both tables.
2. **The statutory blocks REVERSE Story 8.4 Binding Scope Decision 2 ("a null licence number never blocks release") - deliberately and visibly.** The stub `resolveBisLicenceNumber(sku, siteId)` in `src/compliance/quality.ts` (returns null, documented as the Story 8.7 hand-off) is replaced by a register-backed `resolveBisLicence(sku, siteId, asOf, client)` returning `{ licence_number, licence_type } | null`. Under `enforce` mode a null for a BIS-covered product rejects with `BIS_LICENCE_INVALID`. The doc comment above the old stub AND the matching comment in `read/projections/qc_batch_release.sql` must be updated in the same change - stale comments asserting "never blocks" are a defect.
3. **Enforcement mode is a fail-closed boot config: `QC_STATUTORY_RELEASE_BLOCKS` with values `enforce` | `dormant`, default `enforce`.** Absent variable takes the default; present-but-blank or unrecognised refuses boot (`parseRetentionSampleScope` pattern, `src/config/index.ts:84`). `dormant` exists solely for the A-13 migration window (BIS licence data must be loaded before the FR-Q-11 block goes live); production sets `dormant` during the load window and flips to `enforce` after Story 8.7's data load. `dormant` preserves Story 8.4 behaviour byte-for-byte (AC 4). The predicate takes the mode as a parameter so unit tests are not tautological (Story 8.4 lesson).
4. **Blocks live in the seam, under the lot lock, with route pre-checks as courtesy only.** Both checks execute inside `applyBatchReleaseRecorded` (`src/compliance/quality.ts:4084`) immediately after `resolveBisCoverage`, before the retention-sample gates. The release route adds cheap pre-checks mirroring the existing `QC_RELEASE_NOT_ELIGIBLE` courtesy idiom; the seam re-derives under the lock and is the guarantee. Both codes join `AUDITED_REJECTIONS` (`src/api/v1/quality.ts:236`).
5. **BIS licence validity is a date-window check on the server clock.** A register row covers the release when `sku` matches, the row's site scope admits the task's site (see decision 6), and `valid_from <= asOf <= valid_to` where `asOf` is the IST calendar date derived from the server-stamped release time - never from a client-supplied field (Story 8.4 client-clock lesson). `licence_type` is constrained to `('cml','r_number')`.
6. **Register rows are site-nullable: `site_id NULL` means the licence covers all sites.** `resolveBisLicence` prefers a site-specific row over a global row when both are valid. Open Question 2 asks the PO whether per-site licences are real in Phase 1; the schema supports both answers without migration.
7. **Legal Metrology coverage is a new item-master flag mirroring the BIS flag.** `item_master.legal_metrology_required BOOLEAN NOT NULL DEFAULT false`, added everywhere `bis_licence_required` is handled (projection SQL, init-db mirror, TS row type, the item write path that sets the BIS flag, schema-drift test). Default false keeps the label block inert for every existing item until the flag is set - no fixture churn.
8. **"Current approved label version" is a partial-unique row.** `label_master` statuses are `('draft','approved','superseded')` with partial unique `uq_label_master_current (sku) WHERE status = 'approved'` - the single-current-version invariant from the Story 8.7 AC, enforced structurally from day one. The block passes when an `approved` row exists for the task's sku. No label reference is written onto the release record in this story.
9. **`qc_ncr.defect_code` widens to optional on non-hold NCRs.** The real constraint is `chk_qc_ncr_origin` (`read/projections/qc_ncr.sql:202-207`, init-db mirror ~:10574) and it carries FOUR conjuncts: the origin enum, the disposition biconditional, the hold/defect biconditional, and `(hold_id IS NULL OR origin = 'hold')`. ONLY the hold/defect conjunct relaxes, from biconditional to `(origin = 'hold') <= (defect_code IS NOT NULL)` direction (hold-origin still REQUIRES a defect code; disposition-origin NCRs MAY now carry one); the other three conjuncts are preserved verbatim in the replacement. Target post-widening definition, stated so the replacement is executable: origin enum unchanged AND disposition biconditional unchanged AND `(origin <> 'hold' OR defect_code IS NOT NULL)` AND `(hold_id IS NULL OR origin = 'hold')`. The reject-disposition path accepts an optional `defect_code` validated with `assertKnownDefectCode` (Table 1). Use the guarded `pg_get_constraintdef` drop-then-add idiom (Story 8.3 widening template) in BOTH SQL copies. The superseded piece to remove is ONLY the `chk_qc_ncr_origin` `IF NOT EXISTS` arm inside the Story 8.5 `DO $$` block (`qc_ncr.sql:191-208`); that same block also drop/re-adds the widened `chk_qc_ncr_outcome` (`'closed_with_capa'`), which MUST stay (Story 8.5 migrate-twice collision lesson cuts both ways). Rejection-rate-by-defect-code buckets NULL codes as `UNSPECIFIED`. Side effect accepted and disclosed: the Story 8.5 repeat-defect predicate queries `qc_ncr` by (sku, defect_code) regardless of origin, so coded disposition NCRs now count toward the mandatory-CAPA threshold - that is the correct statutory reading of "same product and defect".
10. **The dashboard is one aggregate GET, scorecard-shaped, with no new metric projections.** `GET /api/v1/qc/reports/dashboard` follows the supplier-scorecard pattern (`src/api/v1/supplier-scorecards.ts:201`): a `metrics` object where each metric carries its aggregate plus a bounded `series` of drill-through rows (limit 200, newest first) holding ids that resolve through the existing GET routes (`/api/v1/qc/ncrs`, `/api/v1/qc/capas`, `/api/v1/qc/holds`, task/disposition/release reads). Query params `from` / `to` are `YYYY-MM-DD` IST calendar dates validated with `isDateString` (400 `INVALID_PARAMS` otherwise), defaulting to the trailing 90 days. Aggregation SQL lives in a new `src/quality/reporting.ts` (the Story 8.5 `recall-trace.ts` precedent: keep it out of the ~4,500-line `src/compliance/quality.ts`). Reads only shared projections (AD-14).
11. **Metric definitions are fixed.** First-pass yield: numerator = `qc_lot_disposition` rows with `disposition = 'accept'`, denominator = all disposition rows, bucketed on the IST calendar date of `decided_at`. The "first disposition" reading rests on the one-row-per-lot unique constraint `uq_qc_lot_disposition_lot` (`read/projections/qc_lot_disposition.sql`); VERIFY that constraint is still a full (not partial) unique at implementation time and disclose in Debug Log References if split children or rework re-entries break the grain - the epic wording is "lots accepted on first disposition". Rejection rate by product: reject dispositions over dispositions grouped by `qc_inspection_task.sku` (join on `task_id`). Rejection by defect code: `qc_ncr` rows grouped by `COALESCE(defect_code,'UNSPECIFIED')`. NCR aging: open NCRs (`outcome IS NULL`) bucketed by age from `raised_at` (buckets 0-30 / 31-60 / 61-90 / 90+ days). CAPA aging: `status = 'open'` bucketed by age from `opened_at`, with an `overdue` count where `due_on < asOf`. Conditional-release counts: `disposition = 'conditional_release'` in period, split active vs expired via `qc_deviation.expires_on`. Calibration lockouts: see decision 12.
12. **Calibration lockout counts read `audit_log` filtered on `error_code = 'CALIBRATION_LOCKOUT'` over `timestamp`, with a DECLARED coverage caveat.** No lockout event or counter projection exists (the Story 8.2 rejection writes only the statutory audit row), and this story does not create one. The archival CLI can move old rows to `audit_log_archive`, so counts over windows reaching past the archive horizon are lower bounds; the response carries `coverage: 'live_audit_log_only'` and the doc comment says why. Drill-through rows expose `log_id`, `timestamp`, `user_id`, `endpoint`, and `details`. Site narrowing for THIS metric filters on `details` (audit `location_id` is TEXT, not a site UUID).
13. **No edge, no sync-rules, no notification changes.** The dashboard is a central read; the register tables do not sync to edge (Story 8.7 decides if they ever do); blocks fire at central release, which is already central-only.
14. **Story 8.4 integration fixtures gain a seeded valid licence, and their coc-path licence assertions FLIP.** With `enforce` as the default, `story-8-4.test.ts` BIS-covered releases would reject `BIS_LICENCE_INVALID` on an empty register. Seed one valid `compliance_bis_licence` row (global site scope) for each BIS-covered fixture sku via the admin pool. Two existing assertions change meaning and MUST be updated, which is a strengthening, not a weakening: the coc-path assertion `row['bis_licence_number'] === null` (near `test/integration/story-8-4.test.ts:822`) becomes an assertion of the exact seeded licence number, and the `bis_licence_number: 'CM/L-FORGED'` forgery test (near :1250) must still prove the client-supplied value loses - the release record now carries the register number, not null and not the forged value. No other 8-4 assertion may be weakened. This is the honest end-state (register live implies enforce) and gives the enforce path integration coverage without the Story 8.4 `bis_covered_only` boot-config gap. The `dormant` branch is unit-tested via child-process config loads (both-branches pattern).

## Tasks / Subtasks

- [x] **Task 1: Contract tables** (AC: 1, 2, 3)
  - [x] `read/projections/compliance_bis_licence.sql`: `licence_id UUID PK, licence_number TEXT NOT NULL (btrim <> ''), licence_type TEXT chk ('cml','r_number'), sku TEXT NOT NULL, site_id UUID NULL, valid_from DATE NOT NULL, valid_to DATE NOT NULL chk (valid_to >= valid_from), created_at`; unique `(licence_number, sku, site_id)` handling NULL site (use `COALESCE` expression index or `NULLS NOT DISTINCT`); index `(sku, valid_to)`; `app_user` SELECT only
  - [x] `read/projections/label_master.sql`: `label_id UUID PK, sku TEXT NOT NULL, label_version TEXT NOT NULL, status TEXT chk ('draft','approved','superseded'), approved_by UUID NULL, approved_at TIMESTAMPTZ NULL, created_at`; partial unique `uq_label_master_current (sku) WHERE status = 'approved'`; closure-style biconditional `(status = 'approved' OR status = 'superseded') = (approved_at IS NOT NULL)` stated in FULL both directions (Story 8.4 one-directional-CHECK lesson); `app_user` SELECT only
  - [x] TS accessors `src/read/projections/compliance_bis_licence.ts`, `label_master.ts` (row interface, `*_COLUMNS`, runner taking optional client)
  - [x] Register both at the tail of `src/events/migrate.ts` with the ordering comment; mirror byte-consistent blocks into `deploy/compose/init-db.sql`; migrate twice must be clean
  - [x] Extend `test/unit/schema-drift.test.ts` with every new table and column
- [x] **Task 2: Item-master Legal Metrology flag** (AC: 3)
  - [x] Add `legal_metrology_required BOOLEAN NOT NULL DEFAULT false` to `read/projections/item_master.sql` (guarded `ADD COLUMN IF NOT EXISTS`) and the init-db mirror; extend the TS row type and `ITEM_MASTER_COLUMNS`
  - [x] Grep every write/read site of `bis_licence_required` and mirror the new flag there (item upsert applier, any payload contract that carries the BIS flag); assert the column in schema-drift
- [x] **Task 3: Config** (AC: 4)
  - [x] `QC_STATUTORY_RELEASE_BLOCKS` parsed fail-closed in `src/config/index.ts` (values `enforce`/`dormant`, default `enforce`, blank or unrecognised refuses boot); export the mode on `config.quality`; predicate helpers take the mode as a parameter
- [x] **Task 4: Licence resolver replacement** (AC: 1, 2, 4)
  - [x] Replace `resolveBisLicenceNumber` (`src/compliance/quality.ts:3889`) with `resolveBisLicence(sku, siteId, asOf, client)` reading `compliance_bis_licence`: valid rows only, site-specific preferred over global; return `{ licence_number, licence_type } | null`
  - [x] Update the stub doc comment and the `qc_batch_release.sql` "never blocks" comment (Binding Decision 2); grep for other restatements of the old invariant (`src/events/schema.ts` block near `qc.batch_release_recorded`) and update them
- [x] **Task 5: Statutory blocks in the seam** (AC: 1, 2, 3, 4)
  - [x] In `applyBatchReleaseRecorded` after `resolveBisCoverage`: when mode is `enforce` and `bisCovered`, a null resolver result throws `BIS_LICENCE_INVALID` (409); a hit stamps `bis_licence_number` (the existing `chk_qc_batch_release_bis_licence_pairing` already admits it on `coc`)
  - [x] When mode is `enforce` and the item's `legal_metrology_required` is true, absence of a current approved `label_master` row for the sku throws `LABEL_VERSION_MISSING` (409); check runs under the same lot lock, `asOf` from the server-stamped release time
  - [x] `dormant` mode: number-if-available, no rejections (AC 4)
  - [x] Route courtesy pre-checks in the release handler mirroring the existing pre-check idiom; add both codes to `AUDITED_REJECTIONS`
- [x] **Task 6: Defect-code widening** (AC: 5)
  - [x] Replace `chk_qc_ncr_origin` with the post-widening definition quoted in Binding Decision 9 (all four conjuncts, only the hold/defect one relaxed), via guarded `pg_get_constraintdef` drop-then-add in BOTH SQL copies; remove ONLY the superseded `chk_qc_ncr_origin` arm from the Story 8.5 `DO $$` block, preserving its `chk_qc_ncr_outcome` widening
  - [x] Accept optional `defect_code` on the reject-disposition NCR path, validated with `assertKnownDefectCode` (`src/compliance/quality.ts:4816`, non-exported but same module as the reject NCR creation) rejecting `DEFECT_CODE_UNKNOWN` (422)
  - [x] Disclose the repeat-defect interplay (Binding Decision 9) in the doc comment at the predicate
- [x] **Task 7: Dashboard queries** (AC: 5, 6)
  - [x] New `src/quality/reporting.ts`: one exported function per metric plus an orchestrator `buildQualityDashboard(period, siteFilter, client)`; SQL over `qc_lot_disposition`, `qc_inspection_task`, `qc_ncr`, `qc_capa`, `qc_deviation`, `audit_log` only (AD-14); `::text` on NUMERIC outputs; empty-period returns no-data shapes, never fabricated ratios
- [x] **Task 8: Dashboard route** (AC: 5, 6, 7)
  - [x] `GET /api/v1/qc/reports/dashboard` behind `requireRole({ module: 'qc', functionScope: 'read' })`; `from`/`to` validated with `isDateString` else 400 `INVALID_PARAMS`; default trailing 90 days IST; response `{ period, generated_at, coverage, metrics }` with per-metric bounded `series` (limit 200)
  - [x] Register in `src/server.ts` with the static segment BEFORE the parameterised `/api/v1/qc/tasks/:taskId` siblings (route order is load-bearing; add the comment)
  - [x] Site narrowing per the caller's `qc` read assignments, matching the existing QC list-route idiom (audit-log metric: per Binding Decision 12)
- [x] **Task 9: Tests** (AC: all)
  - [x] `test/integration/story-8-6.test.ts`: BIS block reject + audit row; BIS pass records register number on the release record; label block reject + audit row; label pass after approved row; validity boundary tests at `valid_to` = asOf and asOf + 1 day; site-scoped vs global licence resolution; dashboard happy path with known seeded counts asserted against INDEPENDENTLY computed expectations (no tautologies); empty-period no-data shape; site-narrowing exclusion; drill-through ids resolve against the existing GET routes; defect-coded reject NCR appears in the by-defect-code metric
  - [x] Unit: child-process config loads proving both `enforce` and `dormant` branches plus blank-value boot refusal; FPY/aging bucket boundary unit tests on the predicate helpers (parameterised, not config-bound)
  - [x] Update `story-8-4` fixtures with seeded valid licences (Binding Decision 14); rerun story-8-4 and story-8-5 suites
  - [x] Mutation-verify the TWO highest-risk guards: the BIS block (revert the enforce branch, watch the reject test fail) and the label block
  - [x] Gates: `npm run build`, tsc, eslint, migrate twice idempotent, schema-drift, story-8-6, story-8-4, story-8-5, spine; record the full-suite noise floor at baseline `ce5989c` and finish with delta 0 new failures

### Review Findings

Code review chunked into 4 groups per the diff-size gate (Group 1: schema/contract, Group 2: seam logic, Group 3: dashboard, Group 4: tests). This section covers **Group 1 only** (schema/contract layer: `compliance_bis_licence`, `label_master`, item-master flag, config, migrate registration, `qc_ncr` widening SQL, schema-drift test). Groups 2-4 pending; do not treat this as the final review outcome.

**Group 1 result: 0 decision-needed, 0 patch, 7 defer, 9 dismissed as noise.**

- [x] [Review][Defer] `compliance_bis_licence.sku` / `label_master.sku` carry no FK to `item_master` [read/projections/compliance_bis_licence.sql, read/projections/label_master.sql] — deferred, pre-existing scope boundary (Binding Scope Decision 1: minimal enforcement-contract tables, Story 8.7 owns CRUD/validation)
- [x] [Review][Defer] `compliance_bis_licence.site_id` carries no FK to a sites table [read/projections/compliance_bis_licence.sql] — deferred, same Story 8.7 governance boundary
- [x] [Review][Defer] `licence_number`/`sku` have no case-folding, so near-duplicate casing (e.g. `ABC/123` vs `abc/123`) can produce duplicate register rows [read/projections/compliance_bis_licence.sql] — deferred, data-quality concern for Story 8.7's CRUD/validation layer
- [x] [Review][Defer] `label_master` has no unique `(sku, label_version)` and no CHECK enforcing the draft→approved→superseded transition path (a row can be inserted directly as `superseded`) [read/projections/label_master.sql] — deferred, Story 8.7 owns the approval workflow this story does not implement
- [x] [Review][Defer] `label_master.approved_by` carries no FK to a users/identity table [read/projections/label_master.sql] — deferred, same Story 8.7 governance boundary
- [x] [Review][Defer] `uq_compliance_bis_licence_scope` keys on `(licence_number, sku, site)` without `valid_from`, so a legitimate renewal (same licence number/sku/site, new date window) cannot be inserted as a second row [read/projections/compliance_bis_licence.sql] — deferred, this story ships no write path; Story 8.7 decides the renewal insert/update shape
- [x] [Review][Defer] `findValidBisLicence`'s `ORDER BY (site_id IS NOT NULL) DESC, valid_to DESC, licence_id` picks an arbitrary licence when two distinct licence numbers are simultaneously valid for the same sku/site [src/read/projections/compliance_bis_licence.ts] — deferred, preventing overlapping same-scope licences is Story 8.7 register-governance territory

Dismissed as noise (established convention, by-design, or false positive): the `pg_get_constraintdef ... NOT LIKE` widening-detection marker (matches the repo-wide idiom already used for `chk_production_wip_posting_type`, `chk_maintenance_work_order_status`, `chk_qc_inspection_task_status`, etc.); the drop-then-add atomicity assumption (same single-multi-statement-query pattern used throughout `migrate.ts` already); the "sentinel UUID duplicated between index and resolver" claim (the TS resolver checks `site_id IS NULL` directly, never touches the zero-UUID sentinel — false positive); the "enforce-default with no data-completeness guard" note (the dormant/enforce split and its operational sequencing is the explicit, documented A-13 migration-window design, not an oversight); the "SELECT-only grant not verified against broader privileges" claim (grepped `init-db.sql`, no `GRANT ALL` / `ALTER DEFAULT PRIVILEGES` exists — false positive); table-naming inconsistency and `licence_type` comment-terminology drift (cosmetic, table names match the spec verbatim); `findValidBisLicence` missing UUID-shape validation on `siteId` (caller supplies a typed site UUID, not user input, at this layer); `QC_STATUTORY_RELEASE_BLOCKS` case-sensitivity (matches the existing `parseRetentionSampleScope` convention already in the codebase).

**Acceptance Auditor: zero violations.** All of Task 1 (contract tables), Task 2 (item-master flag), Task 3 (config), and the Task 6 SQL-widening slice were verified against their Binding Scope Decisions and found compliant.

**Group 2 result (seam logic: statutory blocks, defect-code widening, dashboard route wiring): 0 decision-needed, 1 patch, 2 defer, 13 dismissed as noise.**

- [x] [Review][Patch] `defect_code` is validated trimmed but stored/spread untrimmed in the disposition payload, so a value like `" CODE1 "` passes the route's non-empty check but then fails `assertKnownDefectCode`'s exact-match catalogue lookup with a spurious 422 `DEFECT_CODE_UNKNOWN` [src/api/v1/quality.ts:~1520-1524] — fixed, now spreads `body['defect_code'].trim()` mirroring `justification`
- [x] [Review][Defer] `applyBatchReleaseRecorded` calls `getItemBySku` a second time to read `legal_metrology_required`, duplicating the lookup `resolveBisCoverage` already did on the same row a few lines earlier [src/compliance/quality.ts:~4249] — deferred, pre-existing single-lock-scope pattern, minor extra round-trip only, not a correctness issue
- [x] [Review][Defer] The quality dashboard's `from`/`to` params have no upper bound on range width, so an arbitrarily large window (decades) can force an expensive unbounded aggregate scan [src/api/v1/quality.ts: getQualityDashboardBase] — deferred, matches the supplier-scorecard pattern this story explicitly mirrors, which has no such cap either; no codebase precedent for a date-range ceiling on reporting endpoints

Dismissed as noise (verified false positive or matches documented design): two independent statutory blocks surfacing one error per release attempt (BIS then label) is the explicit sequential fail-fast shape both ACs and Task 5 describe, not an omission; `resolveBisCoverage`'s fail-closed `ITEM_NOT_FOUND` pre-empting the label check is the same single-fail-fast convention as every other courtesy pre-check in this route; the route pre-check's `now` and the seam's `envelope.metadata.occurred_at` are the SAME captured value within one request (verified at `src/api/v1/quality.ts:1938`), so there is no clock-divergence window; `bisLicenceBlockApplies`/`labelVersionBlockApplies` re-checking `mode === 'enforce'` inside an already-`enforce`-gated call site is redundant but harmless, not a bug; the courtesy pre-check's `AppError` throw and the seam's `reject()` throw both unwind into the SAME route-level `catch` block that calls `auditRejectedAttempt` (verified at `src/api/v1/quality.ts:2049-2053`), so both paths are audited identically; `capa_mandatory` is a hold-origin-only concept from Story 8.5 (`applyNcrRaised`) — disposition-origin NCRs were never in scope for that flag, and Binding Scope Decision 9's disclosed interplay is only that disposition-origin NCRs now COUNT toward the hold-origin threshold, exactly as implemented, not that they carry the flag themselves; the `qc_ncr.sql` CHECK migration itself was reviewed and verified compliant in Group 1, so re-flagging its absence from this diff slice is not a new finding; `reject()` is typed `never` and always throws (`src/compliance/quality.ts:368-375`), so `assertKnownDefectCode` cannot run after a non-reject `reject()` call - verified false positive; the route pre-check reading `releasedItem?.bis_licence_required === true` directly is logically identical to the seam's `resolveBisCoverage`, which does nothing but that same read plus a fail-closed missing-item guard (`src/compliance/quality.ts:4048-4063`) - verified equivalent; a hypothetical future "warn" enforcement mode is speculative, no such mode is in scope; a future `to` date is already handled correctly by AC 6's documented no-data empty shape, not a gap; and an empty (non-wildcard, zero-site) `siteFilter` array is verified SAFE in `src/quality/reporting.ts`'s `siteCondition` helper - Postgres `column = ANY('{}'::uuid[])` evaluates false for every row, excluding all data rather than leaking it.

### Group 3 (dashboard aggregation, src/quality/reporting.ts)

**Group 3 result: 0 decision-needed, 2 patch, 3 defer, 12 dismissed as noise.**

- [x] [Review][Patch] `ncrAgingMetric` and `capaAgingMetric` series ordered `ASC` (oldest first) instead of the `newest first` Decision 10 mandates for every drill-through series [src/quality/reporting.ts: ncrAgingMetric, capaAgingMetric] — fixed, both now `ORDER BY ... DESC`
- [x] [Review][Patch] `rejectionRateByProductMetric`'s `by_product` and `rejectionRateByDefectCodeMetric`'s `by_defect_code` GROUP BY aggregate queries carried `LIMIT 200`, silently truncating the aggregate breakdown itself (not just the drill-through series) when more than 200 distinct SKUs/defect codes exist in a period — Decision 10's 200-row bound is stated for the drill-through series, not the aggregate [src/quality/reporting.ts: rejectionRateByProductMetric, rejectionRateByDefectCodeMetric] — fixed, `LIMIT` removed from both GROUP BY aggregate queries; the paired drill-through `series` queries keep their 200-row cap
- [x] [Review][Defer] `capaAgingMetric` takes no `siteFilter` and returns CAPAs enterprise-wide, which is a literal AC 7 gap ("rows for that site are excluded") even though it is disclosed and schema-grounded (`qc_capa` has no site column) [src/quality/reporting.ts: capaAgingMetric] — deferred, no fix is possible without adding a site column to `qc_capa`, which is a schema-level decision beyond this story
- [x] [Review][Defer] `ncrAgingMetric`'s and `capaAgingMetric`'s age-bucket histograms are computed by fetching every open NCR/CAPA row into Node and bucketing in JS, rather than aggregating in SQL [src/quality/reporting.ts: ncrAgingMetric, capaAgingMetric] — deferred, a scale concern only at high open-NCR/CAPA volumes, no current data volume makes it urgent
- [x] [Review][Defer] `buildQualityDashboard` awaits its seven metric queries sequentially rather than via `Promise.all`, multiplying dashboard latency [src/quality/reporting.ts: buildQualityDashboard] — deferred, `client` is an optional shared-connection parameter and parallelizing could break a caller that passes one shared `PoolClient` (pg forbids concurrent queries on one client); revisit once Group 4 test usage of this parameter is reviewed

Dismissed as noise (verified false positive or matches documented design): no-transaction consistency between a metric's series and count queries is acceptable for a read-only reporting dashboard, matching the supplier-scorecard precedent — not a correctness contract this endpoint claims; the general 200-row cap on every drill-through `series` (as opposed to the aggregate breakdown, patched above) is exactly what Decision 10 specifies, not a gap; the IST timezone-conversion columns (`decided_at`, `raised_at`, `opened_at`, `timestamp`) were all verified `TIMESTAMPTZ NOT NULL` in `deploy/compose/init-db.sql`, so the "naive timestamp" concern is unfounded; `'Asia/Kolkata'` repeated as a literal per query is cosmetic and matches the rest of the codebase's convention of inlining the zone rather than a shared SQL constant; `conditionalReleaseMetric` treating a NULL `deviation_id` as "expired" is unreachable — `chk_qc_lot_disposition_deviation_pairing` guarantees every `conditional_release` row has a non-null `deviation_id`; `calibrationLockoutMetric`'s dual `location_id`/`details->>'site_id'` site match was verified correct against `src/api/v1/quality.ts`'s `auditRejectedAttempt` (Story 8.2 Binding Scope Decision 11 explicitly stamps the task's site, not an arbitrary role assignment, into `location_id` for `CALIBRATION_LOCKOUT` audit rows), so `location_id` reliably holds the site UUID as text for this specific error code; `DASHBOARD_COVERAGE` surfacing only on the calibration metric matches Decision 12's scoping exactly, not an inconsistency; `percent()` returning a fixed-2-decimal string rather than a number is Task 7's own explicit requirement ("`::text` on NUMERIC outputs"); the reported `age_days`/`bucket` inconsistency in `ncrAgingMetric`'s series row does not exist in the code (both apply the same `Math.max(...,0)` clamp) - verified false positive by the reviewing agent itself; `toIso()`'s `String(v)` fallback matches the identical helper already used in `src/read/projections/compliance_bis_licence.ts` and `label_master.ts` (Group 1); interpolating the `DASHBOARD_SERIES_LIMIT` constant into `LIMIT` clauses is not an injection vector since it is a fixed module constant, never user input; and `uq_qc_lot_disposition_lot` was independently confirmed (`read/projections/qc_lot_disposition.sql`) to be a full, non-partial `UNIQUE (lot_id)`, so the module doc comment's claim is accurate, not a defect.

### Group 4 (tests: story-8-6, story-8-4 fixture update, story-1-9 spine, qc-dashboard-metrics, qc-statutory-blocks-config)

**Group 4 result: 0 decision-needed, 1 patch, 15 defer, 8 dismissed as noise.**

- [x] [Review][Patch] Task 9 requires "FPY/aging bucket boundary unit tests on the predicate helpers" but only the aging-bucket half existed — `percent()` (the FPY/rejection-rate rounding helper) was not exported from `src/quality/reporting.ts` and had no parameterised unit test, only integration-level exercise [test/unit/qc-dashboard-metrics.test.ts] — fixed: exported `percent` and added two unit tests (zero-denominator no-data, fixed-2-decimal rounding); both pass (`node --test test/unit/qc-dashboard-metrics.test.ts`, 5/5)
- [x] [Review][Defer] `dormant` mode is never exercised end-to-end via a real `POST .../release` — only proven via child-process config-load string checks and hand-fed pure-predicate unit tests [test/integration/story-8-6.test.ts] — deferred, a real integration scenario addition, not a mechanical fix
- [x] [Review][Defer] `conditional_releases` metric and its `deviation_id` drill-through field (named in AC 5) have zero positive-value test coverage — only the empty/no-data shape is ever asserted [test/integration/story-8-6.test.ts] — deferred, requires building a real conditional-release fixture
- [x] [Review][Defer] No test for a single item that is both `bis_licence_required` AND `legal_metrology_required` (block ordering, whether one masks the other) [test/integration/story-8-6.test.ts] — deferred, new scenario
- [x] [Review][Defer] `DASHBOARD_SERIES_LIMIT` (200) is only asserted as a bare constant, never exercised by actually producing >200 series rows and confirming truncation [test/unit/qc-dashboard-metrics.test.ts] — deferred, would need a large fixture
- [x] [Review][Defer] Fragile inter-`it` state coupling: `codedRejectHeld`/`acceptedC1`/`seededCapaId` are assigned inside one `it` and read by later, nominally independent `it` blocks instead of `before()` [test/integration/story-8-6.test.ts] — deferred, a structural refactor of working tests, not a correctness bug
- [x] [Review][Defer] `r_number` licence type is declared in the schema but every test seeds `'cml'` only [test/integration/story-8-6.test.ts: seedLicence] — deferred, new scenario
- [x] [Review][Defer] The drill-through disposition check asserts only HTTP 200, not response content, unlike the NCR/CAPA drill-throughs in the same test [test/integration/story-8-6.test.ts] — deferred, minor assertion strengthening
- [x] [Review][Defer] `istDate()` reimplements IST offset arithmetic by hand rather than reusing a production helper, risking a rare midnight-rollover flake in the boundary test [test/integration/story-8-6.test.ts] — deferred; NOT an unambiguous fix, since the file's own design principle is that expected values must be computed INDEPENDENTLY of production code (the same rule that keeps the dashboard assertions non-tautological), so reusing `toIstCalendarDate` would cut against that principle
- [x] [Review][Defer] Global-vs-site-specific licence precedence (Decision 6) is only proven at site A; no test confirms a global row covers a second, different site [test/integration/story-8-6.test.ts] — deferred, new scenario
- [x] [Review][Defer] The AC 3 label test accumulates a draft row before inserting the approved row in one linear narrative, implicitly also testing (but never calling out) that an approved row wins over a coexisting draft row [test/integration/story-8-6.test.ts] — deferred, test restructuring
- [x] [Review][Defer] `Decision 8`'s uniqueness test only proves the constraint fires on a second INSERT, never demonstrates the read-side consequence `findCurrentApprovedLabel` protects against [test/integration/story-8-6.test.ts] — deferred, new scenario
- [x] [Review][Defer] `valid_from` exactly equal to `asOf` (licence starts today) is untested — only the `valid_to` boundary is covered [test/integration/story-8-6.test.ts] — deferred, new boundary case
- [x] [Review][Defer] Site-specific licence row invalid/expired while a global row is valid (fallback to global) is untested [test/integration/story-8-6.test.ts] — deferred, new scenario
- [x] [Review][Defer] Label supersede-then-reapprove workflow (a new approved version following a superseded one for the same sku) is untested [test/integration/story-8-6.test.ts] — deferred, new scenario
- [x] [Review][Defer] CAPA overdue boundary (`due_on` exactly `asOf` vs `asOf + 1`) is untested — distinct from the well-covered 0/30/60/90-day aging buckets [test/integration/story-8-6.test.ts] — deferred, new boundary case
- [x] [Review][Defer] Dashboard `from == to` (zero-width window) and a calendar-invalid-but-well-formed date (e.g. `2026-02-30`) are both untested [test/integration/story-8-6.test.ts] — deferred, new edge cases
- [x] [Review][Defer] Site-A dashboard isolation test only checks the ABSENCE of site-C rows, never pins site-A's own expected counts, creating an ordering-dependency risk if a prior site-A test is added later [test/integration/story-8-6.test.ts] — deferred, assertion strengthening
- [x] [Review][Defer] No unauthorized/unauthenticated access test for the new `GET /api/v1/qc/reports/dashboard` route [test/integration/story-8-6.test.ts] — deferred, new test case

Dismissed as noise (verified false positive or matches documented design): reusing the constant `SEEDED_BIS_LICENCE_NUMBER` across different fixture SKUs in `story-8-4.test.ts` is safe — `uq_compliance_bis_licence_scope` keys on `(licence_number, sku, site)`, so different SKUs with the same licence number and site do not collide; the `auditCount(...) >= 1` assertions were checked against the actual test flow and found NOT to follow "two denied attempts before one check" as originally described — the BIS test performs exactly one release attempt before its audit check, and the label test's audit check runs after only its first denied attempt (the second denied attempt's audit row is simply never separately verified, a different and much smaller gap than described, not worth a separate action item given Group 2 already verified the audit-write path is a single deterministic call per rejection); the boundary tests covering `valid_to = asOf` (pass), `valid_to = asOf - 1` (expired) and `valid_from = asOf + 1` (not-yet-valid) deviate from Task 9's literal wording ("valid_to = asOf and asOf + 1 day") but were assessed by the Acceptance Auditor as exercising the meaningful edges more thoroughly, not a functional gap; `story-1-9.test.ts`'s route-allowlist addition is pure data with no branching logic and drew no findings; the story-8-4 fixture update (Binding Scope Decision 14) was verified compliant — the null-stub assertion now checks the exact seeded licence number, and the pre-existing `CM/L-FORGED` forgery test still proves the client-supplied value is rejected, unweakened; and "mutation-verify the two highest-risk guards" (Task 9) is a manual dev-process step that leaves no diff artifact, so its absence from the diff is not evidence it wasn't done.

## Dev Notes

### Architecture Compliance

- AD-14: the dashboard reads shared projections only, never the event store; no module-private table access.
- Error envelope `{ error_code, message, details, trace_id }`; both new codes are stable strings for i18n mapping.
- State mutation only through events: this story adds NO new event types; the blocks are rejections inside the existing `qc.batch_release_recorded` persist path. New `qc.*` types would become central-only by construction, but none are added.
- A-13 (migration sequencing): licence data loads before the FR-Q-11 block goes live; that is what `dormant` is for. C-12 already satisfied (Epic 7 done).

### Error Code Contract

Table 1 lists every error code this story touches. All rejection rows land in the statutory audit log via `AUDITED_REJECTIONS`.

| Code | HTTP | Status | Meaning |
| --- | --- | --- | --- |
| `BIS_LICENCE_INVALID` | 409 | NEW | Release attempted for a BIS-covered product with no valid, unexpired covering licence (enforce mode) |
| `LABEL_VERSION_MISSING` | 409 | NEW | Release attempted for a Legal Metrology item with no current approved label version (enforce mode) |
| `INVALID_PARAMS` | 400 | existing | Bad `from`/`to` dashboard params |
| `ITEM_NOT_FOUND` | 409 | existing | `resolveBisCoverage` fail-closed on a missing item (unchanged) |
| `QC_RELEASE_NOT_ELIGIBLE` | 409 | existing | Gate/deviation-expiry checks, unchanged and still ordered before the statutory blocks |
| `RETENTION_SAMPLE_REQUIRED` | 409 | existing | Ordered AFTER the statutory blocks |
| `DEFECT_CODE_UNKNOWN` | 422 | existing | Reused verbatim for the optional reject-path `defect_code` via the non-exported helper `assertKnownDefectCode` (`src/compliance/quality.ts:4816`); the reject-disposition NCR creation lives in that same module, so the private helper is directly callable - do not mint a route-layer sibling |

### Current UPDATE File State and Preservation Rules

Line numbers are as of baseline `ce5989c`; grep for the symbol, do not trust line numbers.

- `src/compliance/quality.ts` (~4,500 lines): `applyBatchReleaseRecorded` at ~4084 runs, in order, gate re-derivation, deviation-expiry re-check, `resolveBisCoverage` (~3999, fail-closed `ITEM_NOT_FOUND`, drives `document_kind` coa/coc), retention-sample gates, `resolveRetentionYears`, the `resolveBisLicenceNumber` stub call (~4214), `insertQcBatchRelease`, retention-sample expiry restamp, payload enrichment, `emitNotificationInTransaction`. PRESERVE: the existing check order for everything already there; insert the two statutory blocks between coverage resolution and the retention gates. PRESERVE the lot-then-task `FOR UPDATE` lock order and the quality-hold re-derivation - every applier acting on a lot re-derives `lot_master.quality_hold_status` under the lock (the hold-bypass class was found in 8.3, 8.4, and nearly 8.5).
- `src/api/v1/quality.ts`: release handler at ~1896 (strict JSON-object body, `requireUuidParam`, `assertWriteSiteAccess`, courtesy pre-checks, `persistEvent`, `replayIdOrReject(persisted, ..., 'release_id')` at ~1986). `AUDITED_REJECTIONS` set at ~236. `requireRole` module is `qc` NOT `quality` (the latter is the legacy Story 2.3 lots surface). PRESERVE: `replayIdOrReject` replay idiom; never check-then-act SELECT.
- `src/server.ts`: qc route family at ~841-907; static segments before parameterised siblings, order comments in place. PRESERVE existing order; add the dashboard route above the `:taskId` routes.
- `src/config/index.ts`: `qc:` block at ~572-598 (defect codes, repeat-defect knobs, hold budget); `quality:` block holds retention knobs; boot guard `RETENTION_FLOOR_VIOLATION` right after the config object. Only an ABSENT variable takes defaults; present-but-blank fails closed at boot - repo-wide invariant, keep it.
- `read/projections/qc_ncr.sql` + `deploy/compose/init-db.sql`: duplicates by design, ALWAYS change together, every statement idempotent; the origin/defect biconditional lives in a guarded `DO $$` block - swap it with the `pg_get_constraintdef` idiom and delete the superseded guard (Story 8.5 hit a live migrate-twice collision from a stale guard).
- `src/events/store.ts` 23505 chain: extend existing arms only if a new unique constraint can surface mid-transaction; the two new tables are fixture-seeded (no app writes), so no new arms are expected - disclose if reality differs.
- `test/integration/story-8-4.test.ts`: gains licence seeding plus the two assertion flips Binding Decision 14 authorizes (coc-path null becomes the seeded number; forgery test proves the register number wins); no other assertion may be weakened.

### Existing Components to Reuse

- `getItemBySku` / `resolveBisCoverage` for coverage; `istCalendarDate` and `isDateString` imported from `src/compliance/msme.ts` (the ONLY exported copies - at least seven files carry private non-exported `isDateString` duplicates; import, do not mint an eighth); `toIstCalendarDate` from `src/lib/business-days.ts`; `sendJson` / `sendAppError` / `auditRejectedAttempt` in the route layer.
- Supplier-scorecard response shape (`src/api/v1/supplier-scorecards.ts:201`) including the no-data-is-first-class rule and `limit` 1-200 validation; MSME ageing param idiom (`src/api/v1/msme.ts:64`) for `as_of`-style date echo.
- Story 8.5 defect-code validation helper and `QC_DEFECT_CODES` catalogue; `compareDecimalStrings` for NUMERIC comparisons, never `===`.
- Existing GET list routes for drill-through resolution: `/api/v1/qc/ncrs`, `/api/v1/qc/capas`, `/api/v1/qc/holds`, task/disposition/release reads.

### Previous Story Intelligence

Standing defect classes from the 8.3/8.4/8.5 reviews, all previously shipped green through weak tests:

- Hold bypass: any lot-touching applier must re-derive `quality_hold_status` under the lot lock. The statutory blocks sit inside an applier that already does this; do not reorder it away.
- Fail-open defaults: a null item lookup once silently downgraded a CoC to a CoA. Every lookup in the new blocks fails closed (`ITEM_NOT_FOUND`, `BIS_LICENCE_INVALID`, `LABEL_VERSION_MISSING`).
- Client-supplied clocks: validity `asOf` derives from server-stamped release time, never from payload fields; forgery-test it.
- Tautological tests: dashboard assertions compute expected counts independently from the seeded fixtures, never from the same query under test; config tests load real child processes.
- One-directional CHECKs: the label approval pairing is stated as a full biconditional.
- Migrate-twice guard collisions: superseded `DO $$` guards are removed, both SQL copies, and the migrate-twice gate is run before claiming the task done.

### Testing Standards

- Node built-in runner, `--test-concurrency=1`, `.env.test`, docker `ims-postgres-test` on port 5442; fixtures clean up through the admin pool (`app_user` lacks DELETE).
- Every success test asserts the audit row; every rejection code appears in at least one test; boundary tests at exact window edges (`valid_to` inclusive); 10-in-flight concurrency pattern is NOT needed here (no new `*_EXISTS` codes), disclose if one appears.
- Distinct actor identities where SoD paths are exercised (release SoD is closed as single-actor; no new SoD surface in this story).
- Mutation-verify the two statutory guards (Binding Decision, Task 9).
- Noise floor: record the pre-existing full-suite failure count at `ce5989c` before starting; the story is not done while the delta is non-zero.

## Project Structure Notes

### New Files

- `read/projections/compliance_bis_licence.sql`
- `read/projections/label_master.sql`
- `src/read/projections/compliance_bis_licence.ts`
- `src/read/projections/label_master.ts`
- `src/quality/reporting.ts`
- `test/integration/story-8-6.test.ts`
- `test/unit/qc-statutory-blocks-config.test.ts` (child-process config branches)
- `test/unit/qc-dashboard-metrics.test.ts` (parameterised bucket/predicate units)

### Expected Update Files

`src/compliance/quality.ts`, `src/api/v1/quality.ts`, `src/server.ts`, `src/config/index.ts`, `src/events/migrate.ts`, `read/projections/qc_ncr.sql`, `read/projections/item_master.sql`, `src/read/projections/item_master.ts`, `src/read/projections/qc_ncr.ts` (if the row type carries the constraint comment), `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts`, `test/integration/story-8-4.test.ts` (licence seeding only), possibly `src/events/schema.ts` (doc-comment updates near `qc.batch_release_recorded` only - no new payload interfaces).

### Out of Scope

- Story 8.7: register/label CRUD routes, approval workflow (DOA), edit-logging (FR-AC-13), 90/60/30-day expiry alerts, licence renewal maintenance, any additional register columns, edge sync of master data.
- Story 8.8: witnessed inspection hold points (FR-Q-15), prototype stock class (FR-Q-12).
- SM-28 dispatch-line wiring against batch release records (deferred by 8.4, still deferred).
- A lockout counter projection (Binding Decision 12 documents the audit-log source and its caveat instead).
- Epic 12 executive layer: consumes these metrics later without change.

## Open Questions

1. Default enforcement mode at boot: this story defaults `QC_STATUTORY_RELEASE_BLOCKS` to `enforce` (fail-closed statutory posture; `dormant` is the explicit operator choice for the A-13 load window). Confirm the PO is comfortable that a fresh production boot with an empty register blocks BIS-covered releases until data loads or the operator sets `dormant`.
2. Are per-site BIS licences real in Phase 1, or is every licence enterprise-wide? Schema supports both (`site_id` nullable = global); the answer only affects seed data and Story 8.7's UI.
3. Widening `defect_code` onto disposition-origin NCRs makes coded reject NCRs count toward the Story 8.5 repeat-defect mandatory-CAPA threshold (same sku + defect within 90 days). Confirm QC wants that statutory reading; if not, the repeat predicate gains an `origin = 'hold'` filter (one-line change, disclosed either way).

## References

- [epics.md - Story 8.6](../planning-artifacts/epics.md) (Epic 8, FR-Q-11/13/14; dev notes on 8.7/8.8 split)
- [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-Inventory%20Management%20System_2-2026-07-11/ARCHITECTURE-SPINE.md) (AD-14 read models, error envelope, calibration lockout AD)
- [PRD FR-Q-11/13/14](../planning-artifacts/prds/prd-Inventory%20Management%20System_2-2026-07-10) (BIS Conformity Assessment 2018, Packaged Commodities Rules, A-13 sequencing)
- [Story 8.4](8-4-coa-coc-retention-samples-and-batch-release-records.md) (release applier, `resolveBisLicenceNumber` stub, Binding Decision 2 being reversed, retention gates)
- [Story 8.5](8-5-quality-holds-and-recall-trace.md) (qc_ncr defect_code/origin, qc_capa, defect catalogue, migrate-twice lesson)

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code, 2026-08-31.

### Debug Log References

- Decision 12 site-narrowing deviation (disclosed): the CALIBRATION_LOCKOUT audit rows carry NO
  `site_id` inside `details` (the Story 8.2 throw site stamps `instrument_id`,
  `instrument_asset_id`, `calibration_status`; the route merges `task_id`/`lot_id`), so a
  details-only filter would blank the metric for every narrowed caller. The task's site uuid IS
  stamped into `audit_log.location_id` (TEXT) by `auditRejectedAttempt`, so the metric narrows on
  `location_id = ANY(sites)` OR `details->>'site_id' = ANY(sites)` - the honest filter, documented
  at `calibrationLockoutMetric`.
- Spine allowlist repair (disclosed, outside the Expected Update Files list): the Story 1.9 route
  allowlist was missing ALL ELEVEN Story 8.5 routes (holds/capas/ncr raise+link), so the spine
  gate was red at baseline `ce5989c` before this story touched anything. Added them together with
  the one new 8.6 dashboard route (the same repair note the file already carries for the identical
  Story 8.4 omission). Spine now 6/6.
- schema-drift 8.5 pin updated: the Story 8.5 drift test pinned the OLD hold/defect biconditional
  fragment `(origin = 'hold') = (defect_code IS NOT NULL)`; Decision 9's widening makes that pin
  assert the superseded definition, so the pinned fragment was updated to
  `(origin <> 'hold' OR defect_code IS NOT NULL)` with a comment. No other 8.5 pin changed.
- FPY grain verified per Decision 11: `uq_qc_lot_disposition_lot` is still a FULL unique
  constraint on (lot_id) (`read/projections/qc_lot_disposition.sql:49`), so every disposition row
  is the lot's first disposition and the metric needs no dedup.
- Conditional-release metric coverage (disclosed): the integration happy path asserts the
  first-class `no_data`/total-0 shape; no live deviation fixture exercises the active/expired
  split (a conditional release requires the Story 8.1 DOA deviation flow, out of proportion for a
  read-only metric). The split SQL is `expires_on >= asOf` with a fail-closed
  unresolvable-deviation-counts-as-expired LEFT JOIN, documented at `conditionalReleaseMetric`.
- Route pre-check ordering: the release route's courtesy pre-checks run
  disposition -> retention-sample -> statutory blocks (the retention pre-check predates this
  story); the SEAM order is the binding one and follows Decision 4 exactly: coverage -> BIS ->
  label -> retention gates, all under the lot lock.
- Mutation verification: (1) BIS guard - `bisLicenceBlockApplies` forced false AND the route
  pre-check disabled: the AC 1 reject test fails (release succeeds). Reverted. (2) Label guard -
  same two-point mutation: the AC 3 test fails. Reverted; full story suite green again after both
  reverts.
- ncrAgingMetric initially bound an unused `$1` in its COUNT query (Postgres refuses to infer the
  type of an unreferenced parameter, surfacing as 500 on the dashboard route); fixed by giving the
  count/bucket queries their own parameter lists.
- Noise floor: full suite 1517/1543 with 26 failures - exactly the pre-existing families recorded
  at baseline `ce5989c` (story-2-5 x15, story-2-4 x3, one each in 1-1/1-6/1-7/2-1/2-2/2-3/2-8/
  3-10; the idempotency/DUPLICATE_EVENT and transfer families). Delta 0 new failures; no failing
  test touches any file this story changed.

### Completion Notes List

- Task 1: `compliance_bis_licence` + `label_master` contract tables (canonical SQL + byte-identical
  init-db mirrors, tail-registered in migrate.ts, migrate-twice clean, app_user SELECT only, both
  in the schema-drift EXPECTED list). Site-scope uniqueness is a COALESCE expression index; the
  label approval pairing is the FULL biconditional and `uq_label_master_current` is pinned by body.
- Task 2: `item_master.legal_metrology_required` added in CREATE TABLE + guarded ADD COLUMN in
  both SQL copies, TS row/insert/patch types, items route create+patch field lists, and a
  dedicated schema-drift assertion.
- Task 3: `QC_STATUTORY_RELEASE_BLOCKS` parsed fail-closed (absent=enforce default; blank or
  unrecognised refuses boot), exported as `config.quality.statutoryReleaseBlocks`.
- Task 4: `resolveBisLicenceNumber` stub replaced by register-backed `resolveBisLicence` (valid
  window, site-specific preferred over global); stale "never blocks" comments updated in
  qc_batch_release.sql, init-db, schema.ts and the stub's own doc comment.
- Task 5: both blocks in `applyBatchReleaseRecorded` between BIS coverage and the retention gates,
  under the lot lock, `asOf` from server-stamped `occurred_at`; predicates take the mode as a
  parameter; route courtesy pre-checks added; both codes joined AUDITED_REJECTIONS.
- Task 6: `chk_qc_ncr_origin` widened via `pg_get_constraintdef` drop-then-add (marker: the old
  definition has no `<>`), the superseded 8.5 guard arm removed, `chk_qc_ncr_outcome` widening
  preserved; optional reject-path `defect_code` accepted route+shape+applier, validated by
  `assertKnownDefectCode` (422); repeat-defect interplay disclosed at `isRepeatDefect`.
- Task 7: `src/quality/reporting.ts` - seven metric functions + `buildQualityDashboard`, shared
  projections only, `::text` NUMERIC egress, first-class no-data shapes, bounded 200-row series.
- Task 8: `GET /api/v1/qc/reports/dashboard` behind qc read, `isDateString`-validated params,
  trailing-90-day IST default, registered ABOVE the `:taskId` family with the order comment; site
  narrowing via the same `readSiteScope` the list routes use.
- Task 9: story-8-6 integration 13/13 (both blocks + audit rows, validity boundaries at
  `valid_to = asOf` and `asOf`+1-day `valid_from`, site-specific-beats-global and
  foreign-site-does-not-cover, label draft-vs-approved, partial-unique double-approve proof,
  defect-code 422/400 contract, dashboard with independently computed 66.67% FPY at a dedicated
  site, empty no-data shape, site-narrowing exclusion both directions, drill-through resolution
  via GET ncr/disposition/capa routes); unit config 8/8 (child-process enforce/dormant/blank-boot
  refusal + parameterised predicates) and dashboard predicates 3/3 (aging bucket boundaries);
  story-8-4 28/28 with seeded licences and the authorized coc-path assertion flip; story-8-5
  20/20; schema-drift 137/137; spine 6/6; build+tsc+eslint clean; migrate twice idempotent; both
  statutory guards mutation-verified.

### File List

New files:

- `read/projections/compliance_bis_licence.sql`
- `read/projections/label_master.sql`
- `src/read/projections/compliance_bis_licence.ts`
- `src/read/projections/label_master.ts`
- `src/quality/reporting.ts`
- `test/integration/story-8-6.test.ts`
- `test/unit/qc-statutory-blocks-config.test.ts`
- `test/unit/qc-dashboard-metrics.test.ts`

Modified files:

- `src/compliance/quality.ts`
- `src/api/v1/quality.ts`
- `src/api/v1/items.ts`
- `src/server.ts`
- `src/config/index.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/read/projections/item_master.ts`
- `src/read/projections/qc_ncr.ts`
- `read/projections/item_master.sql`
- `read/projections/qc_ncr.sql`
- `read/projections/qc_batch_release.sql`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-8-4.test.ts`
- `test/integration/story-1-9.test.ts` (spine allowlist repair, disclosed above)
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-08-31: Story 8.6 implemented (all 9 tasks). Statutory release blocks live in the release
  seam under the lot lock (BIS_LICENCE_INVALID / LABEL_VERSION_MISSING, default-enforce
  fail-closed config), register-backed licence resolution replaces the Story 8.4 stub, qc_ncr
  defect-code conjunct widened, FR-Q-13 dashboard shipped as one scorecard-shaped GET. Story 8.4
  fixtures gained seeded licences with the two authorized assertion flips. Disclosed deviations:
  lockout-metric site narrowing via location_id, 8.5 spine-allowlist repair, 8.5 drift-pin update
  (details in Debug Log References).

- 2026-08-31: Fresh-context validation pass applied 10 findings (3 critical: 8-4 assertion-flip authorization, DEFECT_CODE_UNKNOWN 422 correction, `assertKnownDefectCode` location; 3 enhancement: full `chk_qc_ncr_origin` four-conjunct target definition, guard-arm-only removal, FPY grain constraint citation; plus helper import paths, route range, dedupe).
- 2026-08-31: Story created via create-story workflow from baseline `ce5989c` (Story 8.5 committed). Ultimate context engine analysis completed - comprehensive developer guide created. 14 binding scope decisions; 3 open questions for the PO; forward-defines the Story 8.7 contract tables and reverses Story 8.4 Binding Decision 2 explicitly.
