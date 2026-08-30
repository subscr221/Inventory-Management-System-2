---
baseline_commit: 94056d9
---

# Story 8.4: CoA/CoC, Retention Samples, and Batch Release Records

Status: done

## Story

As a QC head,
I want batch release records with CoA/CoC per lot, a 7-year retention default, and
retention-sample logging that blocks release until done,
so that every released lot is certified and evidentially retained.

## Acceptance Criteria

1. **Given** an accepted lot (FR-Q-07), **when** it is released, **then** a batch
   release record and a CoA or CoC are generated for the lot and retained for a
   default 7 years, and for BIS-covered products never below the retention period
   mandated by the applicable BIS Scheme of Testing and Inspection (STI).
2. **Given** a BIS-covered product whose STI mandates a retention period longer than
   the configured value (FR-Q-07), **when** an administrator attempts to configure
   retention below the STI floor, **then** rejected with
   `error_code: "RETENTION_FLOOR_VIOLATION"`.
3. **Given** an accepted lot of a BIS-covered product (FR-Q-11), **when** the CoC is
   generated, **then** the CM/L or R-number is printed on the CoC (sourced from a
   `resolveBisLicenceNumber` stub until Story 8.7's licence register lands — see
   Binding Scope Decision 2).
4. **Given** a lot requiring a retention sample (FR-Q-08), **when** release is
   attempted before the retention sample is logged, **then** rejected with
   `error_code: "RETENTION_SAMPLE_REQUIRED"`.
5. **Given** a retention sample approaching expiry (FR-Q-08), **when** the 30-day
   expiry alert fires, **then** a recorded disposal event routes the sample to
   `disposal_pending` (physical disposal is Phase 2 / Epic 16 — Story 8.4 only
   records the event and flips the status).
6. **Given** a lot whose disposition is not `accept` or `conditional_release` (or
   whose gate has not reached that state), **when** release is attempted, **then**
   rejected with `error_code: "QC_RELEASE_NOT_ELIGIBLE"` (409) and nothing persists.
7. **Given** a lot already released, **when** a second release attempt is made
   (sequentially or concurrently), **then** rejected with
   `error_code: "RELEASE_EXISTS"` (409) carrying the existing `release_id`, matching
   the Story 8.1/8.3 one-row-per-lot concurrency pattern.
8. **Given** a release or retention-sample-logging command (disposal has no write
   route — it is system-actor-only, see Task 8), **when** it is issued by an actor
   without `qc` write access to the task's site, or through
   `POST /api/v1/edge/events`, **then** it is rejected fail-closed with
   `LOCATION_ACCESS_DENIED` or `CENTRAL_ONLY_OPERATION` respectively, nothing
   persists, and the rejected attempt is written to the statutory audit log with
   actor, task, lot, and code (AC8 pattern, reusing the Story 8.3
   `AUDITED_REJECTIONS` mechanism).

## Binding Scope Decisions

These interpretive calls resolve ambiguity in the epics.md ACs above. Each is a
default, not a guess — implement exactly this unless the Open Questions section below
gets a different answer from the product owner before/during implementation.

1. **"Release" is a new, separate step from "disposition."** Stories 8.1/8.3 already
   own accept/reject/conditional_release/split (`qc_lot_disposition`,
   `applyLotDispositioned`/`applyConditionalReleaseRecorded`). AC1's "an accepted lot
   ... when it is released" and the epic goal's "Zero dispatch lines without a batch
   release record (SM-28)" describe a DOWNSTREAM gate on top of an already-decided
   disposition, not a rename of it. Story 8.4 adds a new `qc.batch_release_recorded`
   event and `qc_batch_release` table keyed on `disposition_id`, eligible only when
   `qc_lot_disposition.disposition IN ('accept', 'conditional_release')`. Wiring
   SM-28 (blocking actual dispatch lines without a release record) into the dispatch
   modules themselves is explicitly OUT OF SCOPE for this story (see Out of Scope) —
   this story only creates the release record and its gate; a later story wires
   consumers to check for it, the same way Story 8.3 created the disposition gate
   before Story 8.5/8.6 add more consumers on top.
2. **CM/L or R-number (AC3) is sourced from a stub, not a real registry.** Story 8.7
   (BIS Licence Register) is itself `backlog` and sequenced AFTER this story in the
   epic list, yet AC3 depends on it. Add `resolveBisLicenceNumber(sku, siteId):
   Promise<string | null>` in `src/compliance/quality.ts` returning `null`
   unconditionally with a comment marking it as the Story 8.7 hand-off point. The
   `qc_batch_release.bis_licence_number` column is nullable and simply carries
   whatever this function returns. This mirrors Story 4.2's early reservation of
   `qc.lot_dispositioned` for Story 8.3 — a documented forward reference, not a
   silent gap. Do NOT block release when the resolver returns `null`; AC3 only
   requires printing the number when one is available.
3. **"BIS-covered product" (AC2, AC3) means `item_master.bis_licence_required =
   true`.** This column already exists (Story 2.1,
   `read/projections/item_master.sql:22`) and is already wired end-to-end
   (`src/read/projections/item_master.ts:36,57,75`); it is currently consumed only by
   `src/compliance/receiving.ts:479`. Do not add a new column or config flag — join
   `qc_inspection_task.sku` (already on the task row) through
   `getItemBySku`/`getItemById` (`src/read/projections/item_master.ts:208,216`) to
   read it.
4. **CoA vs. CoC is derived from the same `bis_licence_required` flag.**
   `document_kind = 'coc'` when the released lot's item is `bis_licence_required =
   true` (a CoC is the regulatory conformance format BIS expects, and this
   deterministically satisfies AC3's "for BIS-covered products, print the CM/L/R
   number on the CoC" without inventing a second gating concept); `document_kind =
   'coa'` otherwise (the lab-style certificate of analysis, appropriate for
   non-statutory lots with actual measured results from Story 8.2's
   `qc_inspection_result`).
5. **No physical document is generated or stored.** No document-store /
   file-storage component exists anywhere in this codebase yet (verified: zero hits
   for `coa`, `coc`, `certificate_of` across `src/` and `read/projections/`). Follow
   the one existing "document as event data" precedent in this codebase —
   `src/compliance/supplier-invoice.ts` / `InvoiceIngestionStagedPayload`
   (`src/events/schema.ts:1065`) — which represents an external document as a
   reference plus hash, not inline bytes. `qc_batch_release.document_ref` is
   `TEXT NULL` (a future document-store key, left null in this story) and
   `document_kind` (`'coa'|'coc'`) is what callers actually need today: which
   certificate template/format the (future) document generator should use. Actually
   rendering/storing a PDF or equivalent is out of scope.
6. **Retention sample is required for every lot released via `accept` or
   `conditional_release`, not scoped to BIS-covered products only.** *(AMENDED 2026-08-30: this is
   now the DEFAULT rather than the only rule - `QC_RETENTION_SAMPLE_SCOPE` can narrow it to
   BIS-covered products. See Open Question 1, answered.)* AC1's 7-year
   retention default applies unconditionally to every released lot's CoA/CoC record;
   AC4 gates on "a lot requiring a retention sample" without naming a narrower
   condition. Flagged as Open Question 1 below in case the product owner wants this
   scoped to BIS-covered lots only (which would be a materially smaller
   implementation — a single `bis_licence_required` check added to the eligibility
   gate) — implement the broader (unconditional) rule as the safe default for a
   regulated-manufacturing compliance feature.
7. **Retention period source, per lot: `MAX(configured default, BIS STI floor)`.**
   `config.quality.retentionYearsDefault` (env-driven, default `7`, matching the
   Architecture Spine's Retention Policy table). AC2's "STI floor" has no existing
   per-SKU/per-scheme data source anywhere in this codebase (BIS STI schemes are not
   modeled at all yet) — model it as a single admin-configurable
   `config.quality.bisRetentionFloorYears` (env-driven, default `7`, i.e. no floor
   above the default until a real STI-scheme registry exists). AC2's
   `RETENTION_FLOOR_VIOLATION` check is therefore: reject an attempt to configure
   `retentionYearsDefault` below `bisRetentionFloorYears` at config-load time (the
   same "config validated at boot" pattern `src/config/index.ts` already uses
   elsewhere, e.g. lines 425-439) — there is no runtime admin API for this in the
   current codebase, so AC2 is satisfied by a config-validation guard, not a new
   route. Flagged as Open Question 2 (a real per-scheme BIS STI registry is
   plausibly Story 8.7/8.6 territory, not 8.4's).
8. **Retention-sample "location" reuses the existing `location_id` vocabulary**
   (the same UUID space `qc_inspection_task.site_id` and `stock_balance.location_id`
   already use), not a new physical-storage concept. A retention sample does not
   move real stock (it is evidentiary, not consumable inventory) — `qc_retention_sample`
   is its own append-only table, not a `stock_balance`/`lot_trace` entry.

## Tasks / Subtasks

- [x] **Task 1: Schema and projections** (AC: 1, 2, 3, 4, 6, 7)
  - [x] New `read/projections/qc_batch_release.sql`: `release_id UUID PK`, `lot_id`,
        `task_id`, `disposition_id`, `document_kind TEXT` (`'coa'|'coc'`),
        `document_ref TEXT NULL`, `retention_years INTEGER`, `retention_expires_on
        DATE`, `bis_licence_number TEXT NULL`, `released_by UUID`, `released_at
        TIMESTAMPTZ`, `source_event_id UUID`, `created_at`; `uq_qc_batch_release_lot
        UNIQUE (lot_id)`, `uq_qc_batch_release_disposition UNIQUE (disposition_id)`,
        `chk_qc_batch_release_document_kind CHECK (document_kind IN ('coa', 'coc'))`,
        `chk_qc_batch_release_retention_years CHECK (retention_years > 0)`. Index on
        `task_id`. `GRANT INSERT, SELECT` (append-only — matches the `qc_lot_split`/
        `qc_ncr` grant style, no UPDATE needed since there is no revision concept in
        this story).
  - [x] New `read/projections/qc_retention_sample.sql`: `retention_sample_id UUID
        PK`, `lot_id`, `task_id`, `quantity NUMERIC(18,6)`, `uom TEXT`, `location_id
        UUID`, `status TEXT` (`'retained'|'disposal_pending'|'disposed'`), `logged_by
        UUID`, `logged_at TIMESTAMPTZ`, `expires_on DATE`, `disposal_event_id UUID
        NULL`, `disposed_at TIMESTAMPTZ NULL`, `source_event_id UUID`, `created_at`,
        `updated_at`; `uq_qc_retention_sample_lot UNIQUE (lot_id)`,
        `chk_qc_retention_sample_quantity CHECK (quantity > 0)`,
        `chk_qc_retention_sample_status CHECK (status IN ('retained',
        'disposal_pending', 'disposed'))`. `GRANT INSERT, SELECT, UPDATE` (the status
        transition on disposal is the one update — same shape as `qc_ncr`'s outcome
        column). `'disposed'` plus `disposed_at`/`disposal_event_id` being non-null
        is schema'd now but has no code path reaching it in this story (only
        `'retained' -> 'disposal_pending'` is reachable per AC5's own Phase-2 scope
        note) — same kind of deliberate forward reference as Binding Scope
        Decision 2's BIS-licence stub, not an oversight.
  - [x] Mirror every new statement into `deploy/compose/init-db.sql` verbatim
        (byte-identical — Group A of the Story 8.3 review found and fixed a
        whitespace drift between these two files; diff the sections after writing to
        confirm parity), and register the two new files in `src/events/migrate.ts` in
        dependency order (after `qc_lot_disposition.sql` and `qc_ncr.sql`, since
        `qc_batch_release` and `qc_retention_sample` both reference `qc_inspection_task`/
        `qc_lot_disposition` conceptually even though there are no FK constraints —
        matches the existing "derived, rebuildable projection, no FK" style used by
        `qc_lot_split`/`qc_ncr`).
  - [x] Extend `test/unit/schema-drift.test.ts` with the two new tables.

- [x] **Task 2: Event registration and payload contracts** (AC: 1, 3, 4, 5, 6, 7)
  - [x] Register `qc.batch_release_recorded`, `qc.retention_sample_logged`, and
        `qc.retention_sample_disposed` in `QUALITY_EVENT_TYPES`
        (`src/compliance/quality.ts:152`) and verify `QC_CENTRAL_ONLY_EVENT_TYPES`
        (`:172`, derived from `QUALITY_EVENT_TYPES`) picks all three up automatically
        — all three are central-only (no edge equivalent needed; nothing about
        release/retention is captured at the edge PWA).
  - [x] Declare payload interfaces beside `QcNcrOutcomeRecordedPayload`
        (`src/events/schema.ts` — grep for the current line, it shifts every story).
        `QcBatchReleaseRecordedPayload`: `task_id`, `lot_id`, `disposition_id`
        (server-derived from the lot's existing disposition), `document_kind`
        (server-derived per Binding Scope Decision 4), `retention_years`
        (server-derived), `retention_expires_on` (server-derived), `bis_licence_number`
        (server-derived, nullable), `released_by`, `decided_at`.
        `QcRetentionSampleLoggedPayload`: `task_id`, `lot_id`, `quantity`, `uom`,
        `location_id`, `logged_by`, `logged_at`, `expires_on` (server-derived =
        `logged_at` + `retention_years` from the same resolution as the release
        record, so a sample logged before release still gets a consistent expiry —
        see Task 3 ordering note). `QcRetentionSampleDisposedPayload`:
        `retention_sample_id`, `lot_id`, `disposed_at` (system-actor, no human
        `disposed_by` — mirrors `notification.expired`'s `SYSTEM_ACTOR` pattern in
        `src/notify/expire.ts:9-13`).
  - [x] Document every server-derived field in each payload doc comment (a client
        that declares any of them is `QC_DERIVATION_MISMATCH`, 409 — the established
        pattern every Story 8.1-8.3 payload follows).

- [x] **Task 3: Shape validation in the central seam** (AC: 1, 3, 4, 6, 7, 8)
  - [x] Extend `assertQualityShape` (`src/compliance/quality.ts:1185`) with one arm
        per new type: reject unknown keys, reject declared derived fields, validate
        UUIDs with `UUID_REGEX`, timestamps with the ISO 8601 offset regex, decimal
        quantities with `isPositiveQuantity`/the existing decimal regex.
  - [x] `qc.retention_sample_logged` must be postable BEFORE the disposition reaches
        a terminal accept/conditional_release state — the AC4 ordering ("release
        attempted before the retention sample is logged") only makes sense if
        logging can happen any time after inspection completes, independent of
        whether release has been attempted yet. Do NOT gate retention-sample logging
        on disposition state; only gate `qc.batch_release_recorded` on both
        disposition state AND retention-sample presence (Binding Scope Decision 1 +
        6).

- [x] **Task 4: Appliers** (AC: 1, 2, 3, 4, 6, 7)
  - [x] `applyRetentionSampleLogged`: lock the lot row FOR UPDATE (same fixed
        lot-then-gate lock order every Story 8.1-8.3 applier uses — see
        `lockLotForDisposition`, `src/compliance/quality.ts`, grep for current line),
        re-derive `expires_on` under lock from `logged_at` + the retention-years
        resolution in Task 5, insert into `qc_retention_sample`
        (`uq_qc_retention_sample_lot` backstops one sample per lot — a second attempt
        is a 23505, extend the store.ts 23505 chain per Task 6, do not duplicate an
        arm).
  - [x] `applyBatchReleaseRecorded`: lock the lot row, then re-fetch the lot's
        `qc_lot_disposition` row; reject `QC_RELEASE_NOT_ELIGIBLE` (409) unless
        `disposition IN ('accept', 'conditional_release')`; reject
        `RETENTION_SAMPLE_REQUIRED` (409) unless a `qc_retention_sample` row exists
        for the lot (Binding Scope Decision 6); resolve `document_kind` via
        `getItemBySku(task.sku).bis_licence_required` (Binding Scope Decision 3-4);
        resolve `bis_licence_number` via the `resolveBisLicenceNumber` stub (Binding
        Scope Decision 2); insert into `qc_batch_release`
        (`uq_qc_batch_release_lot`/`uq_qc_batch_release_disposition` backstop a
        second release the same way `uq_qc_lot_disposition_lot` backstops a second
        disposition — extend the same 23505 chain, resolve to `RELEASE_EXISTS` with
        `existing_release_id`, matching the `DISPOSITION_EXISTS` shape exactly).
        `emitNotificationInTransaction` (AD-17) on success — this is a decision-
        carrying event, same as every Story 8.1-8.3 disposition applier.
  - [x] `applyRetentionSampleDisposed`: system-actor event (see Task 2), no lock
        contention concern since it only flips `qc_retention_sample.status` from
        `'retained'` to `'disposal_pending'` — guard the UPDATE with `WHERE status =
        'retained'` (idempotent-by-construction, same as `setQcNcrOutcome`'s `WHERE
        outcome IS NULL` pattern in `src/read/projections/qc_ncr.ts:207-236`) so a
        re-fired sweep tick is a no-op rather than a double transition.

- [x] **Task 5: Retention-years resolution and config** (AC: 1, 2, 7)
  - [x] Add `config.quality.retentionYearsDefault` (env `QC_RETENTION_YEARS_DEFAULT`,
        default `7`, integer, validated `> 0`) and
        `config.quality.bisRetentionFloorYears` (env `QC_BIS_RETENTION_FLOOR_YEARS`,
        default `7`, integer, validated `> 0`) to `src/config/index.ts`, following
        the exact validate-at-boot pattern already used at lines 425-439 (throw at
        startup, not at request time, if `retentionYearsDefault <
        bisRetentionFloorYears` — this IS the `RETENTION_FLOOR_VIOLATION` check per
        Binding Scope Decision 7; there is no runtime admin route in this story).
  - [x] Add a small pure helper `resolveRetentionYears(bisLicenceRequired: boolean):
        number` in `src/compliance/quality.ts` returning
        `Math.max(config.quality.retentionYearsDefault, bisLicenceRequired ?
        config.quality.bisRetentionFloorYears : 0)`. Both `applyRetentionSampleLogged`
        and `applyBatchReleaseRecorded` call this so a sample logged before release
        and the release record itself always agree on the retention window (Task 3's
        ordering note). Note: since Task 5's boot guard already enforces
        `retentionYearsDefault >= bisRetentionFloorYears`, this `Math.max` always
        currently evaluates to `retentionYearsDefault` regardless of the boolean —
        this is deliberate future-proofing for a real per-SKU BIS STI registry
        (Open Question 2 / Story 8.6-8.7), not a no-op bug to "simplify" away.

- [x] **Task 6: 23505 duplicate-conflict mapping** (AC: 4, 7)
  - [x] `src/events/store.ts`: extend the existing 23505 branch chain (grep for
        `err.code === '23505'`, currently around line 1103) with two new arms
        following the exact `DISPOSITION_EXISTS`-style pattern (constraint name
        list → `AppError(409, CODE, message, { constraint, ...resolver(payload) })`):
        `uq_qc_batch_release_lot` / `uq_qc_batch_release_disposition` /
        `qc_batch_release_pkey` → `RELEASE_EXISTS` with a new
        `resolveQcReleaseDuplicateConflict` resolver (same shape as
        `resolveQcDispositionDuplicateConflict`); `uq_qc_retention_sample_lot` /
        `qc_retention_sample_pkey` → `RETENTION_SAMPLE_EXISTS` (a new, undocumented-
        until-now 409 for a raced double-log — add it to the story's own Error Code
        Contract table below, do NOT leave it out the way Story 8.3's Group C review
        found `NCR_EXISTS` had been left out of its own contract table).
  - [x] The generic `chk_qc_*` CHECK-constraint fallback (`err.code === '23514'`,
        `constraint.startsWith('chk_qc_')` → 400 `INVALID_PAYLOAD`) already covers
        every new CHECK constraint from Task 1 with no changes needed — confirmed
        during the Story 8.3 review that this fallback is a deliberate, working
        catch-all, not a gap.

- [x] **Task 7: REST routes** (AC: 1, 3, 4, 6, 7, 8)
  - [x] `POST /api/v1/qc/tasks/:taskId/retention-sample` — body `{ quantity, uom,
        location_id }`; `assertWriteSiteAccess`; `requireBody`; mint the event id up
        front and compare against what `persistEvent` returns to detect replay (the
        idiom `recordNcrOutcomeBase` was patched to use during the Story 8.3 review
        — do NOT copy the check-then-act pre-`SELECT` pattern that route originally
        shipped with).
  - [x] `POST /api/v1/qc/tasks/:taskId/release` — no body fields (everything
        server-derived); same replay idiom.
  - [x] `GET /api/v1/qc/tasks/:taskId/release` and
        `GET /api/v1/qc/tasks/:taskId/retention-sample` — `assertReadSiteAccess`,
        404 if not yet recorded.
  - [x] Add `QC_RELEASE_NOT_ELIGIBLE`, `RETENTION_SAMPLE_REQUIRED`, `RELEASE_EXISTS`,
        `RETENTION_SAMPLE_EXISTS` to `AUDITED_REJECTIONS`
        (`src/api/v1/quality.ts:211-224`) — every new refusal code this story
        introduces represents a refused authority or a refused state change (AC8),
        matching exactly why Story 8.3 added its own five codes there (including
        both of its "already exists" duplicate codes, `DISPOSITION_EXISTS` AND
        `NCR_OUTCOME_EXISTS` — do not add only one of this story's two "already
        exists" codes and leave the other out).
  - [x] Mount the new routes in the existing `/api/v1/qc/tasks/:taskId/*` family in
        `src/server.ts`, after the existing split/disposition routes (route-order
        matters only for path-prefix ambiguity — none exists here, these are new
        leaf paths).

- [x] **Task 8: Retention-sample expiry alert cycle** (AC: 5)
  - [x] New `src/notify/retention-expiry.ts` exporting `runRetentionExpiryCycle()`,
        following the exact shape of `src/notify/expire.ts`'s `runExpiryCycle`: one
        transaction, `SELECT ... WHERE status = 'retained' AND expires_on <=
        CURRENT_DATE + config.quality.retentionExpiryAlertLeadDays` (new config key,
        env `QC_RETENTION_EXPIRY_ALERT_LEAD_DAYS`, default `30` per AC5), emit one
        `qc.retention_sample_disposed` event per row via `applyRetentionSampleDisposed`
        (Task 4), commit together (same atomic-outbox principle
        `src/notify/expire.ts:27-33` documents). Idempotent by construction: the
        `WHERE status = 'retained'` guard means an already-flipped row is never
        re-swept.
  - [x] Wire a new `retentionExpiryTimer` in `src/server.ts` `startServer()`
        (`:1044-1061`) using the exact same `guarded()` re-entrancy wrapper
        (`:1031-1042`) and a new `config.notify.retentionExpiryIntervalMs` config
        key, env `QC_RETENTION_EXPIRY_INTERVAL_MS`, default `3_600_000` (1 hour —
        pin this exact value, matching `config.notify.expiryIntervalMs`'s existing
        default precisely, not a vague "hourly or daily"), plus `clearInterval` in
        `stopTimers()` (`:1063-1067`) and the two signal handlers.
  - [x] Test-only: expose `runRetentionExpiryCycle()` for direct invocation the same
        way `runDispatchCycle`/`runEscalationCycle`/`runExpiryCycle` are — tests
        control cycle timing explicitly, never race a background timer.

- [x] **Task 9: Tests** (AC: 1 through 8)
  - [x] New `test/integration/story-8-4.test.ts` covering, at minimum: retention
        sample logged then release succeeds with a CoA (non-BIS item) and with a CoC
        + `bis_licence_number: null` (BIS item, since Story 8.7 doesn't exist yet);
        release before a retention sample exists is `RETENTION_SAMPLE_REQUIRED`;
        release on a `reject`/`split`/still-`qc_hold` task is
        `QC_RELEASE_NOT_ELIGIBLE`; `RELEASE_EXISTS` AND `RETENTION_SAMPLE_EXISTS`
        both sequentially and under two concurrent requests (the Story 8.3 pattern —
        `test/integration/story-8-3.test.ts`'s `'AC1: two concurrent dispositions...'`
        test is the template); a retained sample past its alert window flips to
        `disposal_pending` via `runRetentionExpiryCycle()` and does not re-flip on a
        second cycle call; `LOCATION_ACCESS_DENIED` on a foreign site for the two
        new write routes (retention-sample logging, release — disposal has no write
        route, it is system-actor-only per Task 8, so it gets no site-access test);
        `CENTRAL_ONLY_OPERATION` for all three new event types on
        `POST /api/v1/edge/events`; a direct-POST forgery test for
        `qc.batch_release_recorded` proving a client-declared `document_kind`/
        `retention_years` is rejected with `QC_DERIVATION_MISMATCH` (the Story 8.3
        Group D review found 3 of 4 new event types in that story had NO forgery
        test at all — do not repeat that gap here); success-path assertions include
        `audit_log` and `notification.created` on the release path (the same review
        found most Story 8.3 success paths never asserted these — do not repeat
        that gap either); AC2's `RETENTION_FLOOR_VIOLATION` boot-time config guard
        (Task 5) gets its own unit or startup test asserting `src/config/index.ts`
        throws when `QC_RETENTION_YEARS_DEFAULT` is configured below
        `QC_BIS_RETENTION_FLOOR_YEARS` — this codebase's two existing analogous
        `config.quality.*` boot validators have no test coverage; do not extend that
        gap to a third.
  - [x] Reuse fixtures from `test/integration/story-8-3.test.ts` in the same file
        (its own helpers like `heldLot`, `inspected`, `rejectedLot`, `planOk`,
        `disposition`, `authFor` are NOT exported — Story 8.3's own Group D review
        found the task text's instruction to import Story 8.1/8.2 fixtures was
        structurally impossible for the same reason; local re-implementation of an
        `accepted(plan, quantity)` helper analogous to `inspected`/`rejectedLot` is
        expected and fine, document it as Debug Log References the way Story 8.3
        did rather than leaving it a silent, undisclosed deviation).
  - [x] Run `npm run build`, `npm run lint`, the typecheck, and `npm run db:migrate`
        twice against a live database to prove idempotence, before declaring the
        story done.

## Dev Notes

### Architecture Compliance

- AD-3: no DOA transaction type is added by this story; release/retention-sample
  logging are QC-inspector-level actions, not approval-gated (no evidence in
  epics.md AC1-8 that release needs a second approver — if the product owner wants
  Story 8.5's segregation-of-duties treatment applied here too, that is a scope
  addition, not this story's default).
- AD-13 ("Nothing Crosses the Gate Without a Document") is the closest existing
  architectural analogue for this story's core gate: no batch release record, no
  (future, out-of-scope) dispatch eligibility — Binding Scope Decision 1 makes this
  explicit rather than inventing new terminology.
- AD-14: `qc_batch_release`/`qc_retention_sample` are shared read projections other
  modules (dispatch, Epic 16 FR-SC) will read later — never another module's own
  event stream.
- AD-16: N/A — these are central-seam-only routes (Task 3), not edge-originated.
- AD-17: `applyBatchReleaseRecorded` emits a notification in the same transaction
  (Task 4) — release is a decision, matching every Story 8.1-8.3 disposition-family
  applier.
- Retention Policy table (ARCHITECTURE-SPINE.md, "CoA / CoC documents: 7 years,
  Document store") is the direct source for the `retentionYearsDefault` default —
  this story's `qc_batch_release`/`qc_retention_sample` rows ARE that document-store
  entry today (no separate document-store component exists — Binding Scope
  Decision 5).

### Error Code Contract

Table (codes this story throws or reuses). Codes marked Existing must keep their
current HTTP status and body shape.

| **Code** | **HTTP** | **Status** | **Meaning** |
| --- | --- | --- | --- |
| `QC_RELEASE_NOT_ELIGIBLE` | 409 | New | Release attempted on a lot whose disposition is not `accept`/`conditional_release`. |
| `RETENTION_SAMPLE_REQUIRED` | 409 | New | Release attempted before a retention sample is logged for the lot. |
| `RELEASE_EXISTS` | 409 | New | A batch release record already exists for the lot (sequential or concurrent). |
| `RETENTION_SAMPLE_EXISTS` | 409 | New | A retention sample already exists for the lot (sequential or concurrent). |
| `ITEM_NOT_FOUND` | 409 | New | The released lot's SKU does not resolve in `item_master`, so BIS coverage cannot be determined. Fails closed rather than defaulting to a CoA. |
| `LOCATION_NOT_FOUND` | 400 | New | The retention-sample storage location does not resolve in `location_register`. |
| `LOT_ON_HOLD` | 400 | Existing | Release attempted on a lot under an independent quality hold (recall, scrap_pending). Re-derived under the lot lock. |
| `RETENTION_SAMPLE_NOT_LOGGED` | 404 | New | The retention-sample READ route found no sample for the lot (distinct from `RETENTION_SAMPLE_NOT_FOUND`, which means the id does not resolve). |
| `RETENTION_SAMPLE_NOT_RETAINED` | 409 | New | A recorded disposal was posted for a sample that has already left the `retained` state (unreachable from the sweep; a forged direct POST only). |
| `RETENTION_SAMPLE_NOT_FOUND` | 404 | New | A recorded disposal, or the retention-sample read route, named a sample that does not resolve. |
| `RELEASE_NOT_FOUND` | 404 | New | The release read route was called before the lot was released. |
| `RETENTION_FLOOR_VIOLATION` | — | New | Boot-time config validation only (Binding Scope Decision 7) — throws at startup, not a request-time HTTP code. |
| `QC_DERIVATION_MISMATCH` | 409 | Existing | A client declared a server-derived field, or asserted a task/lot binding that is not the lot's own inspection task. Audited. |
| `INVALID_PAYLOAD` | 400 | Existing | Shape validation, including a `decided_at`/`logged_at` outside the bounded retention-clock window. |
| `LOCATION_ACCESS_DENIED` | 403 | Existing | The task's site is outside the actor's `qc` scope. |
| `CENTRAL_ONLY_OPERATION` | 403 | Existing | A new `qc.*` type posted to the edge route. |
| `DUPLICATE_EVENT` | 409 | Existing | Idempotency key reused with a different payload. |

### Current UPDATE File State and Preservation Rules

Line numbers are as of baseline `94056d9` (Story 8.3, committed) — **grep for the
named symbol, do not trust a hardcoded line number**, since every prior story in this
epic has shifted these by the time it lands.

- `src/compliance/quality.ts`: `QUALITY_EVENT_TYPES` (`:152`),
  `QC_CENTRAL_ONLY_EVENT_TYPES` (`:172`), `assertQualityShape` (`:1185`),
  `assertQcGateAllows` (`:3673`), `applyConditionalReleaseRecorded` (`:1983`, copy
  structurally, do not modify — same rule Story 8.3 was given and violated by 2
  forced lines; if this story also needs to touch it, disclose the deviation in
  Debug Log References rather than leaving it silent), `applyLotDispositioned`
  (`:2255`), `compareDecimalStrings` (exported, reuse for any decimal comparison —
  never raw `===`/`!==` on a `NUMERIC` string; this exact class of bug was found and
  fixed twice in the Story 8.3 review).
- `src/events/store.ts`: the 23505 constraint-name chain starts around `:1103`
  (grep `err.code === '23505'`) — the `uq_qc_ncr_lot`/`DISPOSITION_EXISTS` arm around
  `:1600` is the template to copy for the two new arms in Task 6. Extend, never
  duplicate an arm for the same underlying fact (Story 8.3's Group C review found
  and fixed exactly this mistake once already — a duplicated arm for an NCR race
  that should have extended `DISPOSITION_EXISTS` instead).
- `src/read/projections/qc_lot_disposition.ts`: `getQcLotDispositionByLotId`
  (`:164`), `insertQcLotDisposition` (`:188`), `getConditionalReleaseForLot`
  (`:223`) — read-only reuse, this story does not modify this file.
- `src/read/projections/item_master.ts`: `getItemBySku` (`:208`), `getItemById`
  (`:216`) — read-only reuse.
- `src/api/v1/quality.ts`: `AUDITED_REJECTIONS` (`:211-224`) — extend, following the
  exact comment-annotated style Story 8.3 used for its own five additions.
- `src/server.ts`: `startServer()` (`:1044`), the three existing timers and
  `guarded()` wrapper (`:1020-1042`) — Task 8's pattern to copy exactly.

### Existing Components to Reuse

- `getQcInspectionTaskByLotId`/`getQcInspectionTaskById` (site_id, sku, gate_status,
  task_status already on the row — no new joins needed to resolve BIS coverage or
  site scope).
- `emitNotificationInTransaction` (AD-17) — already imported in `quality.ts`.
- `UUID_REGEX`, `isPositiveQuantity`, the ISO-8601 timestamp regex, `isBoundedText`
  — all already defined in `quality.ts`, reuse rather than re-declare.
- The `replayIdOrReject` idiom (`src/api/v1/quality.ts`, grep for it) for the two
  new write routes' replay detection — NOT the check-then-act `SELECT` pattern the
  original `recordNcrOutcomeBase` shipped with before the Story 8.3 review fixed it.

### Previous Story Intelligence (Story 8.3)

Recurring defect classes found across the Story 8.1-8.3 reviews, worth treating as
standing guardrails for this story too:

- Raw `!==`/`===` string comparison on a `NUMERIC(18,6)` column instead of
  `compareDecimalStrings` (found and fixed twice: `applyReworkRequested`'s
  `quantity` field, and the general pattern warning in Story 8.2's own Previous
  Story Intelligence section before that).
- A CHECK constraint written one-directional (`A OR B`) when the invariant is
  actually biconditional (`A = B`) — `chk_qc_lot_disposition_ncr_pairing` shipped
  this bug in Story 8.3 and was patched during review. Double-check every new CHECK
  constraint in Task 1 states the FULL biconditional it claims in its doc comment.
- A check-then-act `SELECT`-before-`persistEvent` race for replay detection instead
  of comparing a minted id against what `persistEvent` actually returns — found and
  fixed in `recordNcrOutcomeBase` during the Story 8.3 review; Task 7 above calls
  this out explicitly so it is not reintroduced in this story's two new write
  routes.
- A new error code added to a route's throw sites but left out of the story's own
  Error Code Contract table, or a stale/dead entry left in `AUDITED_REJECTIONS`
  after a merge — both happened in Story 8.3 (`NCR_EXISTS`) and were only caught by
  the code review, not by the original implementation. This story's own contract
  table above already includes `RETENTION_SAMPLE_EXISTS` for exactly this reason —
  do not let it drift from what Task 6 actually throws.

### Testing Standards

- Every success test asserts the audit row (Story 8.3's Group D review found most
  Story 8.3 success-path tests skipped this — do not repeat it here per Task 9).
- Every new write route gets a `LOCATION_ACCESS_DENIED` test AND a
  `CENTRAL_ONLY_OPERATION` test — Story 8.3's Group D review found these were only
  proven for `disposition()`, never repeated for its other two write routes.
- Every new event type gets a direct-POST forgery test proving `QC_DERIVATION_MISMATCH`
  on a declared server-derived field — Story 8.3 shipped with only 2 of 4 new event
  types covered this way.
- `DISPOSITION_EXISTS`-shaped codes (here: `RELEASE_EXISTS`, `RETENTION_SAMPLE_EXISTS`)
  get both a sequential AND a concurrent test, matching
  `test/integration/story-8-3.test.ts`'s `'AC1: two concurrent dispositions...'`
  template exactly.

## Project Structure Notes

### New Files

- `read/projections/qc_batch_release.sql`
- `read/projections/qc_retention_sample.sql`
- `src/read/projections/qc_batch_release.ts`
- `src/read/projections/qc_retention_sample.ts`
- `src/notify/retention-expiry.ts`
- `test/integration/story-8-4.test.ts`

### Expected Update Files

- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/compliance/quality.ts`
- `src/api/v1/quality.ts`
- `src/config/index.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `read/projections/qc_retention_sample.sql` (review: dead `DEFAULT 'retained'` dropped)
- `read/projections/qc_batch_release.sql` (review: `chk_qc_batch_release_bis_licence_pairing` added)
- `test/integration/story-8-3.test.ts` (NFR-SEC-05 approver identity and two SoD regression tests)

### Out of Scope

- Wiring SM-28 (blocking actual dispatch lines without a batch release record) into
  any dispatch/consumption module (Epic 2/6) — this story only creates the release
  record and its own gate (Binding Scope Decision 1); a later story consumes it.
- Physical disposal of expired retention samples — Phase 2 / Epic 16 per AC5's own
  dev note; this story only records the `disposal_pending` transition.
- A real BIS STI-scheme registry or per-SKU retention-floor data — Binding Scope
  Decision 7 models the floor as a single global config value; a real registry is
  plausibly Story 8.6/8.7 territory.
- Story 8.7's BIS licence register itself — Binding Scope Decision 2's stub resolver
  is the explicit hand-off point.
- Rendering or storing an actual CoA/CoC document (PDF or otherwise) — Binding Scope
  Decision 5; no document-store component exists in this codebase yet.
- Segregation-of-duties on the release action — no AC evidence it's required; flagged
  as Open Question 3 below rather than assumed.

## Open Questions for the Product Owner - ANSWERED 2026-08-30

All three were answered by the product owner on 2026-08-30 and are implemented or recorded below.
Nothing in this story is now waiting on a product decision.

1. **Retention-sample scope - ANSWERED: make it an option.** Rather than fixing the rule, the scope
   is now `config.quality.retentionSampleScope`, env `QC_RETENTION_SAMPLE_SCOPE`, one of
   `all_released_lots` (the default, preserving Binding Scope Decision 6) or `bis_covered_only`.
   The predicate is `retentionSampleRequiredFor(bisLicenceRequired, scope)` in
   `src/compliance/quality.ts`, which takes the scope as a parameter so both branches are testable
   without mutating global config. An unrecognised value refuses to boot rather than silently
   selecting a behaviour - the two settings differ in whether statutory evidence exists at all.
   Under the narrow scope `applyBatchReleaseRecorded` resolves BIS coverage BEFORE the sample gate,
   skips the gate for a non-BIS lot, and writes `retention_sample_id: null` on the event.

2. **BIS STI floor granularity - ANSWERED: a single global value is sufficient.** No per-scheme
   registry is required for this story or as a follow-on. `config.quality.bisRetentionFloorYears`
   and the AC2 boot guard stand as implemented. Binding Scope Decision 7's speculation that a real
   registry is "plausibly Story 8.6/8.7 territory" is withdrawn - it is not planned work.

3. **Segregation of duties on release - ANSWERED: put the second signature on ACCEPTANCE instead.**
   Implemented; see the Post-Review Notes above and the amendment in Story 8.3. The product owner
   also confirmed that **sites can staff multiple distinct QC people**, which clears the one
   residual operational risk on this control: the rule is satisfiable on every shift, so it will not
   be worked around.

### Known coverage limit on the narrow retention-sample scope

`retentionSampleRequiredFor` is unit-tested in both directions, and the seam wiring is type-checked,
but there is **no integration test exercising a live release under `bis_covered_only`**. The scope is
resolved at boot from the environment, and the integration harness imports the config module as part
of the server graph, so it cannot rebind the value in-process the way the child-process config tests
do. Stated here rather than left as an implied gap: if a deployment adopts `bis_covered_only`, that
path deserves an integration run under that environment before it carries production traffic.

## References

- [Source: epics.md#Epic 8, Story 8.4] — user story, ACs 1-5 verbatim.
- [Source: epics.md#Epic 8 goal] — "Zero dispatch lines without a batch release
  record (SM-28)."
- [Source: ARCHITECTURE-SPINE.md#Retention Policy] — 7-year CoA/CoC retention,
  "Document store" as physical storage class.
- [Source: ARCHITECTURE-SPINE.md#AD-13, AD-14, AD-17]
- [Source: 8-3-lot-disposition-accept-reject-conditional-release.md#Out of Scope] —
  explicit hand-off of CoA/CoC, batch release records, retention samples, and the
  retention floor to this story.
- [Source: 8-3-lot-disposition-accept-reject-conditional-release.md#Review Findings] —
  the four recurring defect classes and the two HIGH bugs (LOT_ON_HOLD re-derivation
  gap, replay race) whose patterns this story must not reintroduce.
- [Source: read/projections/item_master.sql:22] — `bis_licence_required` column.
- [Source: src/compliance/supplier-invoice.ts, src/events/schema.ts:1065] —
  `attachment_ref`/hash document-reference pattern reused for `document_ref`.

### Review Findings

Adversarial code review 2026-08-30, round 1 of 2 (Groups A and B: schema/projections and the
domain seam). Three layers per group - Blind Hunter, Edge Case Hunter, Acceptance Auditor - run as
independent subagents with no implementation context. Groups C (API/store/server/config) and D
(tests) are reviewed in round 2 and their findings are appended below when they land.

Convergence note: the four items marked HIGH below were each found independently by two or more
layers that could not see each other's output. The retention-clock divergence was found by all four
non-auditor layers.

#### Decisions needed

- [x] [Review][Decision] RESOLVED (a): the release record is the authority and re-stamps the sample's expires_on. How to reconcile the two retention clocks (HIGH) — `qc_retention_sample.expires_on` is `logged_at + N years` while `qc_batch_release.retention_expires_on` is `decided_at + N years`. AC4 forces `logged_at <= decided_at`, so the physical sample is always swept to `disposal_pending` BEFORE the certificate's own stated retention date - the evidence is discarded while the CoA/CoC it backs is still inside its window. Options: (a) re-stamp the sample's `expires_on` from the release record at release time, one row of truth, AC1's clock runs from release; (b) anchor the release record on the sample's `expires_on` instead; (c) accept the divergence and delete the two doc comments that claim they agree.
- [x] [Review][Decision] RESOLVED (c): keep consistency with the thirteen pre-existing arms; the Task 3 deviation is disclosed below. Unknown-key rejection on the three new shape arms — Task 3 explicitly requires "reject unknown keys", and none of the three new arms does. Neither does any of the thirteen pre-existing arms (`Object.keys` appears zero times in `src/compliance/quality.ts`), so implementing it only for Story 8.4 makes the seam inconsistent. Options: (a) implement for the three new arms only; (b) implement across all arms as a separate hardening pass; (c) accept the codebase convention and record the deviation from Task 3.
- [x] [Review][Decision] RESOLVED (a): keep the 409; all four contradicting doc comments corrected and the sweep isolates each row. Keep `RETENTION_SAMPLE_NOT_RETAINED` (409) or revert to the spec's no-op — the disclosed deviation 3. Task 4, `QcRetentionSampleDisposedPayload`, and both projection doc comments all say a re-fired tick is "a no-op"; the code raises 409. Options: (a) keep the 409 and correct all four doc comments; (b) revert to a benign replay that writes back the current status; (c) keep the 409 only for a direct POST and treat the sweep's own path as a no-op.

#### Patches

- [x] [Review][Patch] HIGH: `lockLotForRetention` never re-derives `quality_hold_status`, so a lot under a manual or recall hold can be released and certified [src/compliance/quality.ts:lockLotForRetention]
- [x] [Review][Patch] HIGH: `getItemBySku` returning null fails OPEN - a BIS-covered lot whose SKU no longer resolves is silently issued a CoA with the shorter retention window, violating AC1 and AC3 [src/compliance/quality.ts:applyBatchReleaseRecorded, applyRetentionSampleLogged]
- [x] [Review][Patch] HIGH: AC6's second clause ("or whose gate has not reached that state") is unimplemented - `gate_status` is put in the error detail and never evaluated, and the conditional-release deviation's expiry is never re-checked even though minting this release record is exactly what lifts the conditional-release movement restriction [src/compliance/quality.ts:applyBatchReleaseRecorded]
- [x] [Review][Patch] HIGH: the retention-sample gate checks existence but not status, so a sample already `disposal_pending` satisfies AC4 and the release asserts a retention window backed by nothing [src/compliance/quality.ts:applyBatchReleaseRecorded]
- [x] [Review][Patch] `bis_licence_number` has no pairing constraint to `document_kind` and no `btrim` check, so a CoA carrying a licence number, and an empty-string licence number, are both representable rows [read/projections/qc_batch_release.sql]
- [x] [Review][Patch] The expiry sweep runs every due row in ONE transaction with no LIMIT; a single row throwing rolls back every already-flipped row and returns `disposalPending: 0`, hourly, forever, with no operator-visible signal [src/notify/retention-expiry.ts, src/read/projections/qc_retention_sample.ts:listQcRetentionSamplesDueForDisposal]
- [x] [Review][Patch] The sweep compares `expires_on` (minted in IST) against `CURRENT_DATE` (the DB session timezone, UTC in every container here), a deterministic off-by-one at the exact 30-day AC5 boundary [src/read/projections/qc_retention_sample.ts:listQcRetentionSamplesDueForDisposal]
- [x] [Review][Patch] `location_id` is validated as a UUID and never checked to exist, though `locationExistsById` is available - the one field telling an auditor where the physical evidence is can be any random UUID [src/compliance/quality.ts:applyRetentionSampleLogged, src/api/v1/quality.ts:logRetentionSampleBase]
- [x] [Review][Patch] `applyRetentionSampleDisposed` reads the sample without `FOR UPDATE` then acts on it - a check-then-act window, and the only applier in the family that participates in no lock ordering at all [src/compliance/quality.ts:applyRetentionSampleDisposed]
- [x] [Review][Patch] `uom` is trimmed into the projection row but `p['uom']` is never written back, so the stored event and the projection disagree for any padded input [src/compliance/quality.ts:applyRetentionSampleLogged]
- [x] [Review][Patch] `getQcBatchReleaseByTaskId` and `getQcRetentionSampleByTaskId` are dead (zero callers) and read a non-unique `task_id` with no LIMIT or ORDER BY, returning an arbitrary row [src/read/projections/qc_batch_release.ts, src/read/projections/qc_retention_sample.ts]
- [x] [Review][Patch] Four doc comments assert the opposite of what the code does (re-fired disposal "is a no-op" vs the 409 actually raised) - and the story's own deviation 3 cites one of them as its supporting evidence [src/read/projections/qc_retention_sample.ts, src/events/schema.ts, src/compliance/quality.ts]
- [x] [Review][Patch] The three payload doc comments document roughly half the server-derived fields each, and `document_ref`/`status` are rejected as declared-derived while existing on no interface and in no write-back [src/events/schema.ts]
- [x] [Review][Patch] The Error Code Contract omits `LOT_NOT_FOUND`, `QC_TASK_NOT_FOUND` and `INVALID_PAYLOAD`, all thrown by the new seam paths [story Dev Notes]
- [x] [Review][Patch] Completion Notes overstate Task 4: "all behind the shared `lockLotForRetention`" is false for `applyRetentionSampleDisposed`, which takes no lock at all [story Dev Agent Record]
- [x] [Review][Patch] The retention-sample route does not bound `uom` at 32 characters, so a 33-character value dies deeper as a generic `INVALID_PAYLOAD` naming a database constraint [src/api/v1/quality.ts:logRetentionSampleBase]
- [x] [Review][Patch] `isBoundedText` applies the 32-character bound pre-trim while `chk_qc_retention_sample_uom` applies it post-trim, so a legal value can be refused [src/compliance/quality.ts:assertRetentionSampleLoggedShape]
- [x] [Review][Patch] `QC_DOCUMENT_KINDS` in `quality.ts` is dead and shadows the authoritative definition in the projection - two exported symbols, same name, different types [src/compliance/quality.ts]
- [x] [Review][Patch] `status TEXT NOT NULL DEFAULT 'retained'` is dead (the accessor always writes it explicitly) and lets a non-projection INSERT silently mint a `retained` row [read/projections/qc_retention_sample.sql]
- [x] [Review][Patch] Undisclosed additions beyond Task 1's explicit lists: `chk_qc_retention_sample_uom`, `idx_qc_retention_sample_task`, `idx_qc_retention_sample_expiry`, and the client `release_id`/`retention_sample_id` payload fields - all defensible, none disclosed [story Debug Log References]
- [x] [Review][Patch] `retention_years` is written back to the retention-sample payload but stored on no column, and the two appliers resolve it independently, so a config change between logging and release yields a sample event and a release record asserting different windows with no cross-check [src/compliance/quality.ts]

#### Deferred (pre-existing, not caused by this change)

- [x] [Review][Defer] Guarded DDL blocks match a constraint by name only, and no file reconciles columns, so an older table with a same-named different-definition constraint is silently kept and the migration reports success [read/projections/*.sql] — deferred, pre-existing repo-wide pattern across ~100 projections
- [x] [Review][Defer] `::text` on a DATE is `DateStyle`-dependent and neither `TimeZone` nor `DateStyle` is pinned on the pool [src/config/db.ts] — deferred, pre-existing repo-wide pattern
- [x] [Review][Defer] Table-wide UPDATE grant where only three columns are ever written; Postgres supports column-scoped GRANT [read/projections/qc_retention_sample.sql] — deferred, pre-existing, matches `qc_ncr` and every sibling
- [x] [Review][Defer] The schema-drift harness compares only the CREATE TABLE block and named DO blocks, and its grant assertion is a substring check, so an added `GRANT DELETE` still passes [test/unit/schema-drift.test.ts] — deferred, pre-existing harness limitation
- [x] [Review][Defer] `'qc_retention_sample'::regclass` is unqualified and resolves through `search_path` [read/projections/*.sql] — deferred, pre-existing repo-wide pattern
- [x] [Review][Defer] GRANT blocks only ever GRANT and never REVOKE, so an over-granted live database stays over-granted [read/projections/*.sql] — deferred, pre-existing repo-wide pattern
- [x] [Review][Defer] No `.gitattributes`, so SQL files land CRLF or LF by coin flip; this already breaks the `gate_dwell_metric` view-body assertion [repo root] — deferred, pre-existing repo-wide, tracked as a known suite failure
- [x] [Review][Defer] `NUMERIC(18,6)` reads back scale-padded (`'1.5'` becomes `'1.500000'`) with no documented comparison rule for consumers [src/read/projections/qc_retention_sample.ts] — deferred, pre-existing pattern, no caller compares today
- [x] [Review][Defer] Client-supplied `decided_at`/`logged_at` are unbounded in both directions, and `released_at` is the legal record date [src/compliance/quality.ts] — deferred, matches the Story 8.1 accepted decision that expiry keeps the client `occurred_at` with documented risk


#### Round 2 (Groups C and D: API/store/server/config, and tests)

Same three layers per group. One layer's HIGH was dismissed as a false positive on verification:
a calendar-impossible timestamp cannot reach `toIstCalendarDate`, because `assertQualityShape`
runs at `src/events/store.ts:688` while the applier runs at `:1024`, and `isIsoTimestamp` carries a
`Number.isFinite(new Date(v).getTime())` check that the route-level regex lacks.

##### Decisions needed

- [x] [Review][Decision] DEFERRED to the product owner as Open Question 3, single-actor kept as the documented default; the reviewer rated it HIGH and that rating is recorded here so the PO decides with it in view. Segregation of duties on the release action — `releaseLotBase` is gated only by `requireRole({module:'qc',functionScope:'write'})` plus `assertWriteSiteAccess`, so the same inspector who recorded the results and signed the `accept` disposition can issue the CoC under their own signature. `recordConditionalReleaseBase` resolves a DOA approver AND rejects a known result recorder (`SOD_VIOLATION`); release does neither, and both codes are already in `AUDITED_REJECTIONS`. This is Open Question 3 in this story, implemented as single-actor by documented default. Options: (a) leave as-is, it is the recorded default and the PO has not answered; (b) add the `knownResultRecorders` SoD check only; (c) add both the DOA authority resolution and the SoD check, mirroring conditional release.

##### Patches — application code

- [x] [Review][Patch] HIGH: AC5's "expiry alert" alerts nobody - `applyRetentionSampleDisposed` flips the status and emits an event but never calls `emitNotificationInTransaction`, unlike the release applier [src/compliance/quality.ts:applyRetentionSampleDisposed]
- [x] [Review][Patch] HIGH: `decided_at`/`logged_at` are client-controlled and unbounded, and the entire statutory retention window is derived from them - a back-dated `decided_at` mints an already-expired certificate, achieving what AC2's floor guard exists to prevent; a back-dated `logged_at` makes the next sweep tick flip a brand-new sample to `disposal_pending` irreversibly [src/api/v1/quality.ts, src/compliance/quality.ts]
- [x] [Review][Patch] HIGH: the sweep has no LIMIT, runs every due row in one all-or-nothing transaction, and its failure path returns `{disposalPending: 0}` - byte-identical to a healthy "nothing due", so a deterministic poison row silently stops all retention alerting forever [src/notify/retention-expiry.ts, src/read/projections/qc_retention_sample.ts]
- [x] [Review][Patch] The sweep writes the event type as a hardcoded string literal instead of the exported `QC_RETENTION_SAMPLE_DISPOSED`; a rename would compile, emit events whose projection silently never runs, and re-sweep the same rows forever [src/notify/retention-expiry.ts]
- [x] [Review][Patch] `QC_DERIVATION_MISMATCH` is reachable on both new write routes via `lockLotForRetention` and is not in `AUDITED_REJECTIONS`, so a refused release naming the wrong task/lot binding is never written to the statutory log, contrary to AC8 [src/api/v1/quality.ts]
- [x] [Review][Patch] The three new env vars are unbounded above: a large alert lead makes every retained sample due on the first tick and irreversibly flips them all; a large retention-years value produces an invalid date and an unmapped 500; an interval above 2^31-1 makes Node clamp `setInterval` to 1 ms [src/config/index.ts]
- [x] [Review][Patch] The release route has no cheap route-level pre-check, unlike every sibling, so each ineligible retry runs the full assert chain and takes the lot row lock before being refused [src/api/v1/quality.ts:releaseLotBase]
- [x] [Review][Patch] `releaseLotBase` bypasses `requireBody` with a bare cast, so an array/string/number body silently drops `idempotency_key` and a client retry becomes a genuinely new attempt refused with 409 instead of an idempotent 200 [src/api/v1/quality.ts:releaseLotBase]
- [x] [Review][Patch] A replayed release returns 200 and writes NO audit row, while `auditCtxFor` hardcodes 201 on both new write routes - a statutory record served successfully with no audit trace [src/api/v1/quality.ts]
- [x] [Review][Patch] `qc_batch_release_pkey` / `qc_retention_sample_pkey` are mapped into the `*_EXISTS` arms, so a UUID collision returns "a record already exists for this lot" with no `existing_release_id` - a factually wrong 409 that every retry reproduces [src/events/store.ts]
- [x] [Review][Patch] `RETENTION_SAMPLE_NOT_FOUND` is overloaded: the read route means "none logged for this lot", the applier means "this id does not resolve", with different detail keys [src/api/v1/quality.ts, src/compliance/quality.ts]
- [x] [Review][Patch] `retentionExpiryIntervalMs` sits under `config.notify` while its three siblings are under `config.quality`, splitting one feature's knobs across two namespaces [src/config/index.ts]
- [x] [Review][Patch] The release route silently ignores unknown body keys, so a caller sending `document_kind`/`retention_years` gets a 201 and believes the override applied [src/api/v1/quality.ts:releaseLotBase]
- [x] [Review][Patch] `RETENTION_FLOOR_VIOLATION` is a substring of a bare `Error` message, not a machine-identifiable code, so no test or supervisor can distinguish it from any other boot failure [src/config/index.ts]
- [x] [Review][Patch] `QUANTITY_REGEX` is re-declared in the API layer instead of reusing the seam's `isPositiveQuantity`, against the Dev Notes reuse instruction - two independently drifting definitions of the same rule [src/api/v1/quality.ts]

##### Patches — tests

- [x] [Review][Patch] HIGH: `retention_years` is asserted against `config.quality.retentionYearsDefault`, the same object production reads - `X === X` routed through HTTP, passing for 7, 1 or 900. AC1's literal 7 is never encoded [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] HIGH: the retention expiry is asserted to the YEAR only, discarding a fully-computed expected date, so a release stamping 2033-01-01 instead of 2033-07-15 passes; the test also computes its expectation in UTC while production derives it in IST, a latent spurious failure every 31 December [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] HIGH: audit assertions are scoped by `user_id` only and use `>=`/`> 0` over a table truncated once per file, so they are order-dependent counters that only go up; three of the four new `AUDITED_REJECTIONS` codes have no audit assertion at all, and AC8's required `task`/`lot` payload is never asserted [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] HIGH: no test anywhere asserts a retention sample's `expires_on` - the helper selects the column and all four call sites ignore it - so the sample-versus-release agreement, the invariant that turned out to be broken, has no coverage [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] The alert-window boundary is never probed: the positive case derives its fixture from the same config value under test and the negative case sits seven years out, so a lead-days bug anywhere in 31-2500 days passes both [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] The `resolveRetentionYears` unit test asserts both arms equal the same constant, so the whole `Math.max` could be `return config.quality.retentionYearsDefault` and it still passes [test/unit/qc-retention-config.test.ts]
- [x] [Review][Patch] The boot-guard test accepts any non-zero exit including a spawn failure, matches its regex against stdout+stderr concatenated, has no `timeout`, and its positive case never proves the injected env actually took effect [test/unit/qc-retention-config.test.ts]
- [x] [Review][Patch] `assertReadSiteAccess` on both new GET routes is untested, so a cross-site read leak of a statutory CoA/CoC would ship undetected [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] The second and third forgery loops drop the `details.field` assertion the first loop makes, so a blanket unconditional reject would satisfy all five cases; and no positive control proves a clean direct post is accepted [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] No forgery test covers `decided_at`, the client-controlled input the whole retention window is derived from [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] The two concurrency tests do not establish that the requests overlap; a naive check-then-insert with no unique constraint would also produce [201, 409] when they serialise [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] Loose assertions where exact values are knowable: `disposal_event_id` truthiness rather than equality to the emitted event id, `disposalPending >= 1`, `audit_log > 0`, and a cross-task forgery test that checks only one of the two lot ids [test/integration/story-8-4.test.ts]
- [x] [Review][Patch] Two of three success paths (CoC and conditional-release) assert neither the audit row nor `notification.created`, so the Completion Notes claim holds for only one path [test/integration/story-8-4.test.ts]

##### Deferred (round 2)

- [x] [Review][Defer] `requireTask` runs before the site assertion on all four new routes, so a caller can distinguish 404 from 403 and confirm a foreign task exists [src/api/v1/quality.ts] — deferred, pre-existing sibling pattern now propagated to four more endpoints
- [x] [Review][Defer] `getQcInspectionTaskByLotId` takes `rows[0]` with no ORDER BY or LIMIT [src/read/projections/qc_inspection_task.ts] — deferred, pre-existing since Story 8.1
- [x] [Review][Defer] A `setInterval` delay above 2^31-1 is clamped by Node to 1 ms [src/server.ts] — deferred, pre-existing for all four timers
- [x] [Review][Defer] The integration harness TRUNCATEs ~45 tables and depends on `--test-concurrency=1` with no guard or assertion [test/integration/story-8-4.test.ts] — deferred, pre-existing across every integration test in the repo
- [x] [Review][Defer] `uom` is not validated against any unit-of-measure master vocabulary [src/api/v1/quality.ts] — deferred, no UoM master exists in this codebase
- [x] [Review][Defer] Retention-sample quantity is never deducted from stock and `INSUFFICIENT_STOCK` is unreachable from these routes despite sitting in `AUDITED_REJECTIONS` [src/compliance/quality.ts] — deferred, Binding Scope Decision 8 makes the sample evidentiary rather than consumable inventory; the unreachable code entry is inherited from Story 8.3


## Dev Agent Record

### Agent Model Used

claude-opus-5[1m] (Claude Opus 5, 1M context) via the bmad-dev-story workflow.

### Debug Log References

Three deliberate deviations from the task text, disclosed rather than left silent:

1. **Story 8.3 fixtures are re-implemented locally, not imported.** Task 9 anticipated this: the
   Story 8.3 helpers (`heldLot`, `inspected`, `planOk`, `disposition`, `authFor`) are closures
   inside that file's `describe` block and are not exported, so importing them is structurally
   impossible. `test/integration/story-8-4.test.ts` carries its own equivalents plus this story's
   own `accepted(plan, quantity)` helper, which drives a lot all the way to an accept disposition -
   the state Story 8.4's release step begins from.
2. **`qc_retention_sample.disposed_at` is NOT stamped by the `disposal_pending` transition.** Task
   1 listed `disposal_event_id` and `disposed_at` together as nullable columns and Task 4 says the
   disposal applier "only flips the status". Pairing the two columns biconditionally would have
   forced `disposed_at` to be written on a sample nothing has physically disposed of. Following the
   Previous Story Intelligence warning about one-directional CHECK constraints,
   `chk_qc_retention_sample_disposal_pairing` states the FULL biconditional the invariant actually
   claims: a row is `retained` if and only if it carries no `disposal_event_id`, and it carries a
   `disposed_at` if and only if it is `disposed`. So the reachable transition stamps only the event
   id, and the Phase 2 (Epic 16) physical disposal is the sole writer of `disposed_at`.
3. **`applyRetentionSampleDisposed` reports a re-fired transition rather than swallowing it.** The
   guarded UPDATE is idempotent by construction as Task 4 requires, but when it matches zero rows
   the applier raises 409 `RETENTION_SAMPLE_NOT_RETAINED` instead of writing back a success. The
   sweep never reaches that path (its candidate query is guarded by the same predicate), so this
   only affects a forged direct POST, which must not be able to claim a transition that never
   happened. The code is documented in the projection and in the story's Error Code Contract below.

One section outside the workflow's normally-permitted edit areas was touched, deliberately and
disclosed here rather than silently: **the Error Code Contract table in Dev Notes gained three
rows** (`RETENTION_SAMPLE_NOT_RETAINED`, `RETENTION_SAMPLE_NOT_FOUND`, `RELEASE_NOT_FOUND`). Task 6
explicitly instructs this story to keep that table in step with what the code actually throws, and
Previous Story Intelligence names a stale contract table as a recurring Story 8.3 defect. Leaving
three live refusal codes undocumented to preserve section boundaries would have reproduced exactly
the defect the story warns about. No other Dev Notes content was changed.

Two smaller notes:

- `test/unit/qc-retention-config.test.ts` proves AC 2's boot guard by loading `src/config/index.ts`
  in a CHILD process with the offending environment. An in-process import would be served from the
  module cache with the ambient `.env.test` values and could never observe the throw.
- The AC 5 test reaches the 30-day alert window by moving the row's own `expires_on` - the sweep's
  only input - rather than waiting seven years or faking the clock.

### Completion Notes List

All 9 tasks implemented from baseline `94056d9`.

- **Task 1:** `read/projections/qc_batch_release.sql` (append-only, `INSERT, SELECT`) and
  `read/projections/qc_retention_sample.sql` (`INSERT, SELECT, UPDATE` for the one status
  transition), mirrored byte-identically into `deploy/compose/init-db.sql` (verified by exact
  substring comparison, not by eye), registered in `src/events/migrate.ts` after
  `qc_lot_disposition.sql`/`qc_ncr.sql`, and both added to `test/unit/schema-drift.test.ts`.
- **Task 2:** `qc.batch_release_recorded`, `qc.retention_sample_logged` and
  `qc.retention_sample_disposed` registered in `QUALITY_EVENT_TYPES` and in
  `SUPPORTED_EVENT_TYPES`; `QC_CENTRAL_ONLY_EVENT_TYPES` picks all three up automatically (proved
  by the existing `test/unit/quality-event-registry.test.ts` drift guard, which still passes).
  Three payload interfaces added beside `QcNcrOutcomeRecordedPayload`, every server-derived field
  documented in the doc comment.
- **Task 3:** one `assertQualityShape` arm per type. Retention-sample logging is deliberately NOT
  gated on disposition state; only `qc.batch_release_recorded` gates on both disposition state and
  retention-sample presence.
- **Task 4:** `applyRetentionSampleLogged` and `applyBatchReleaseRecorded` go through the shared
  `lockLotForRetention` (the fixed lot-then-task lock order). `applyRetentionSampleDisposed` takes
  no lot lock - Task 4 waives it - but after the review it does lock its own sample row `FOR UPDATE`
  before reading the values it writes back. Both the release applier and the disposal applier emit
  an AD-17 notification in-transaction. (The pre-review text claimed all three sat behind
  `lockLotForRetention`, which was false for the third.)
- **Task 5:** `config.quality.retentionYearsDefault` / `bisRetentionFloorYears` /
  `retentionExpiryAlertLeadDays` plus `config.notify.retentionExpiryIntervalMs`, with the AC 2
  `RETENTION_FLOOR_VIOLATION` guard throwing at boot beside the config object it guards.
- **Task 6:** two new arms on the existing 23505 chain in `src/events/store.ts` (extended, never
  duplicated), with `resolveQcReleaseDuplicateConflict` and
  `resolveQcRetentionSampleDuplicateConflict` matching the `DISPOSITION_EXISTS` shape. All four new
  refusal codes are in `AUDITED_REJECTIONS`, including BOTH "already exists" codes.
- **Task 7:** four routes mounted in the `/api/v1/qc/tasks/:taskId/*` family, both write routes
  using the minted-id replay idiom (never the check-then-act pre-`SELECT`).
- **Task 8:** `src/notify/retention-expiry.ts` with `runRetentionExpiryCycle()`, wired as
  `retentionExpiryTimer` in `startServer()` behind the same `guarded()` wrapper and cleared in
  `stopTimers()`; exported for direct invocation so tests never race the timer.
- **Task 9:** `test/integration/story-8-4.test.ts` (18 tests, all passing) and
  `test/unit/qc-retention-config.test.ts` (5 tests). Coverage includes CoA and CoC paths, the
  retention-sample gate in both orderings, `RELEASE_EXISTS` and `RETENTION_SAMPLE_EXISTS` both
  sequentially AND concurrently, the expiry sweep flipping exactly once and not re-flipping, the
  conditional-release path being releasable, `LOCATION_ACCESS_DENIED` on BOTH write routes with the
  audit row asserted, `CENTRAL_ONLY_OPERATION` for all three event types, forgery tests for ALL
  THREE new event types, and audit-row plus `notification.created` assertions on the success path.

Validation: story tests 18/18, unit config tests 5/5, schema-drift 128/128, event-registry drift
2/2; `npm run build`, `npx tsc --noEmit` and `npm run lint` all clean; `db:migrate` run twice
against a live database with no drift. Full suite 1377/1409 with all 26 failures verified pre-existing at baseline 94056d9 (worktree-equivalent check: the same 11 files - story-1-1, 1-6, 1-7, 1-9, 2-1, 2-2, 2-3, 2-4, 2-5, 2-8, 3-10 - fail 26/143 with this story's work stashed), 0 new.

### Post-Review Notes (2026-08-30)

An adversarial review over four file groups and ten independent layers found **seven HIGH defects**
in the delivered implementation, all now fixed and each locked in by a regression test:

1. `lockLotForRetention` never re-derived `lot_master.quality_hold_status`, so a lot placed on a
   recall or scrap hold after acceptance could still be released and certified. This is the same
   bypass class the Story 8.3 review found and fixed; it was reintroduced here.
2. `getItemBySku` returning null was coalesced to "not BIS-covered", so an unresolvable SKU silently
   produced a CoA with the shorter retention window instead of the CoC AC3 requires. Now
   `ITEM_NOT_FOUND`, fail-closed.
3. The retention sample expired on `logged_at + N` while its certificate expired on `decided_at + N`.
   Since AC4 forces the sample to exist first, the physical evidence was ALWAYS scheduled for
   disposal before the certificate left its own retention window. The release record is now the sole
   authority and re-stamps the sample.
4. AC6's second clause ("or whose gate has not reached that state") was never implemented -
   `gate_status` was placed in the error detail and never evaluated - and a lapsed conditional-release
   deviation could be laundered into a permanent release, because minting the release record is
   exactly what lifts the conditional-release movement restriction.
5. The release gate checked that a retention sample EXISTED, not that it was still `retained`, so a
   sample already routed for disposal satisfied AC4.
6. AC5's "30-day expiry alert" alerted nobody: the applier flipped a status and emitted an event but
   never called `emitNotificationInTransaction`.
7. `decided_at` and `logged_at` are client-supplied and the entire statutory retention window is
   derived from them, so a back-dated value minted an already-expired certificate - the outcome AC2's
   floor guard exists to prevent, reached by another route. Both are now bounded server-side.

The sweep was additionally unbounded and all-or-nothing, with a failure result byte-identical to
"nothing was due"; it now batches, isolates each row behind a SAVEPOINT, and reports `failed` and
`cycleFailed` distinctly.

**On the tests:** the suite was green on all seven defects. `retention_years` was asserted against
the same `config` object production reads (`X === X` through HTTP), the retention expiry was checked
to the YEAR only, and no test ever read a retention sample's `expires_on` - which is precisely why
defect 3 shipped. The `resolveRetentionYears` unit test was tautological, and three of the four new
`AUDITED_REJECTIONS` codes had no audit assertion at all. All are fixed; `resolveRetentionYears` now
takes its bounds as parameters so the `Math.max` is genuinely exercisable. Two fixes were
mutation-tested (the hold guard and the clock re-stamp) by reverting the production change and
confirming the new test fails.

**Disclosed deviation from Task 3 (decided at review):** the three new shape arms do not reject
unknown keys, matching the thirteen pre-existing arms in `assertQualityShape` - `Object.keys` appears
nowhere in that file. Implementing it for Story 8.4 alone would leave one switch statement with two
different validation contracts. Recorded here rather than left silent.

**Open Question 3 is now ANSWERED and implemented (2026-08-30).** The product owner chose to put
the second signature on **acceptance**, not on release.

Investigating the question turned up the fact that reframed it: the `accept` disposition
(`applyLotDispositioned`, shipped in Story 8.3) had no segregation check either, so the gap started
one story earlier than the review reported it. Acceptance is the binding quality decision - it is
what lets stock leave the QC gate - while release is a downstream administrative step on a
disposition that has already been decided. A second signature at release alone would have refused
the inspector a certificate for a lot they were already permitted to accept alone: control theatre,
not control.

`applyLotDispositioned` now rejects a known result recorder with `SOD_VIOLATION` (409), mirroring
`applyConditionalReleaseRecorded`, which has always enforced exactly this. The guard is deliberately
scoped to `accept`: a **reject is not a self-approval**, and forcing a second signature to contain
bad material would delay containment, which is actively harmful; a **split** decides nothing on its
own, since each child lot carries its own guarded disposition. Both rules have their own regression
test, and the guard was mutation-verified by disabling it and confirming the test fails.

Release itself is unchanged and stays single-actor - it inherits the disposition's authority. No
`qc.batch_release` DOA type was introduced, so no registry data is required to deploy.

**Residual risk the PO should still confirm:** whether every site can staff two distinct QC people
per lot. A segregation rule a night shift cannot satisfy gets worked around, and a worked-around
control is worse than a documented single-actor policy. This affects operations, not code.

### File List

New:

- `read/projections/qc_batch_release.sql`
- `read/projections/qc_retention_sample.sql`
- `src/read/projections/qc_batch_release.ts`
- `src/read/projections/qc_retention_sample.ts`
- `src/notify/retention-expiry.ts`
- `test/integration/story-8-4.test.ts`
- `test/unit/qc-retention-config.test.ts`

Modified:

- `deploy/compose/init-db.sql`
- `src/api/v1/quality.ts`
- `src/compliance/quality.ts`
- `src/config/index.ts`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/8-4-coa-coc-retention-samples-and-batch-release-records.md`

## Change Log

- 2026-08-30: All three Open Questions answered by the product owner and closed. Retention-sample
  scope became a fail-closed config option (`QC_RETENTION_SAMPLE_SCOPE`, default
  `all_released_lots`) with a parameterised, both-branch-tested predicate; the single global BIS STI
  floor was confirmed sufficient and the per-scheme-registry speculation withdrawn; segregation of
  duties was placed on acceptance rather than release, and staffing for it confirmed. 3 unit tests
  added (8 total in that file). Known limit disclosed: no integration run under `bis_covered_only`.
- 2026-08-30: Adversarial code review, 10 layers over 4 file groups. 7 HIGH defects found and
  fixed, each with a regression test (2 mutation-verified): quality-hold bypass on release,
  fail-open BIS coverage, divergent retention clocks, the unimplemented AC6 gate clause plus lapsed
  conditional-release laundering, a non-retained sample satisfying the AC4 gate, an expiry alert
  that notified nobody, and an unbounded client-supplied retention clock. Sweep rewritten to batch,
  isolate each row behind a SAVEPOINT and report failures distinguishably. Test suite hardened: the
  tautological config assertions, year-only expiry check, unscoped audit counts and missing
  retention-sample coverage that let all seven ship green are fixed; concurrency raised to 10 in
  flight; read-scope, boundary and forgery gaps closed. 28 story tests + 6 unit tests. 49 patches
  applied, 15 deferred, 9 dismissed, 3 decisions resolved, Open Question 3 (release SoD) left with
  the product owner.

- 2026-08-30: Implemented all 9 tasks from baseline `94056d9`. Two new projections
  (`qc_batch_release` append-only, `qc_retention_sample` with the one guarded status transition),
  three new central-only `qc.*` event types with their payload contracts and shape asserts, three
  appliers behind a shared lot-then-task lock, the AC 2 `RETENTION_FLOOR_VIOLATION` boot guard,
  two 23505 arms resolving `RELEASE_EXISTS` and `RETENTION_SAMPLE_EXISTS`, four REST routes, and
  the `runRetentionExpiryCycle()` sweep wired as a fourth in-process timer. 23 tests added across
  one integration and one unit file; three deviations disclosed in Debug Log References; three
  refusal codes added to the Error Code Contract. Status moved to review.

- 2026-08-30: Created via create-story workflow from baseline `94056d9` (Story 8.3
  done, committed). 8 binding scope decisions (release as a new downstream step
  distinct from disposition; BIS licence-number stub pending Story 8.7;
  `bis_licence_required` reused as the BIS-coverage gate; CoA-vs-CoC derived from the
  same flag; no physical document generated, reference-only; retention sample
  required for every released lot; retention floor as single config value; retention
  sample location reuses the existing location_id vocabulary). 9 tasks, closes
  deferred-work implied by Story 8.3's own Out of Scope hand-off.
