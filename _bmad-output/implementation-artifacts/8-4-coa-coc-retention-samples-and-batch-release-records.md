---
baseline_commit: 94056d9
---

# Story 8.4: CoA/CoC, Retention Samples, and Batch Release Records

Status: ready-for-dev

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
   `conditional_release`, not scoped to BIS-covered products only.** AC1's 7-year
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

- [ ] **Task 1: Schema and projections** (AC: 1, 2, 3, 4, 6, 7)
  - [ ] New `read/projections/qc_batch_release.sql`: `release_id UUID PK`, `lot_id`,
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
  - [ ] New `read/projections/qc_retention_sample.sql`: `retention_sample_id UUID
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
  - [ ] Mirror every new statement into `deploy/compose/init-db.sql` verbatim
        (byte-identical — Group A of the Story 8.3 review found and fixed a
        whitespace drift between these two files; diff the sections after writing to
        confirm parity), and register the two new files in `src/events/migrate.ts` in
        dependency order (after `qc_lot_disposition.sql` and `qc_ncr.sql`, since
        `qc_batch_release` and `qc_retention_sample` both reference `qc_inspection_task`/
        `qc_lot_disposition` conceptually even though there are no FK constraints —
        matches the existing "derived, rebuildable projection, no FK" style used by
        `qc_lot_split`/`qc_ncr`).
  - [ ] Extend `test/unit/schema-drift.test.ts` with the two new tables.

- [ ] **Task 2: Event registration and payload contracts** (AC: 1, 3, 4, 5, 6, 7)
  - [ ] Register `qc.batch_release_recorded`, `qc.retention_sample_logged`, and
        `qc.retention_sample_disposed` in `QUALITY_EVENT_TYPES`
        (`src/compliance/quality.ts:152`) and verify `QC_CENTRAL_ONLY_EVENT_TYPES`
        (`:172`, derived from `QUALITY_EVENT_TYPES`) picks all three up automatically
        — all three are central-only (no edge equivalent needed; nothing about
        release/retention is captured at the edge PWA).
  - [ ] Declare payload interfaces beside `QcNcrOutcomeRecordedPayload`
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
  - [ ] Document every server-derived field in each payload doc comment (a client
        that declares any of them is `QC_DERIVATION_MISMATCH`, 409 — the established
        pattern every Story 8.1-8.3 payload follows).

- [ ] **Task 3: Shape validation in the central seam** (AC: 1, 3, 4, 6, 7, 8)
  - [ ] Extend `assertQualityShape` (`src/compliance/quality.ts:1185`) with one arm
        per new type: reject unknown keys, reject declared derived fields, validate
        UUIDs with `UUID_REGEX`, timestamps with the ISO 8601 offset regex, decimal
        quantities with `isPositiveQuantity`/the existing decimal regex.
  - [ ] `qc.retention_sample_logged` must be postable BEFORE the disposition reaches
        a terminal accept/conditional_release state — the AC4 ordering ("release
        attempted before the retention sample is logged") only makes sense if
        logging can happen any time after inspection completes, independent of
        whether release has been attempted yet. Do NOT gate retention-sample logging
        on disposition state; only gate `qc.batch_release_recorded` on both
        disposition state AND retention-sample presence (Binding Scope Decision 1 +
        6).

- [ ] **Task 4: Appliers** (AC: 1, 2, 3, 4, 6, 7)
  - [ ] `applyRetentionSampleLogged`: lock the lot row FOR UPDATE (same fixed
        lot-then-gate lock order every Story 8.1-8.3 applier uses — see
        `lockLotForDisposition`, `src/compliance/quality.ts`, grep for current line),
        re-derive `expires_on` under lock from `logged_at` + the retention-years
        resolution in Task 5, insert into `qc_retention_sample`
        (`uq_qc_retention_sample_lot` backstops one sample per lot — a second attempt
        is a 23505, extend the store.ts 23505 chain per Task 6, do not duplicate an
        arm).
  - [ ] `applyBatchReleaseRecorded`: lock the lot row, then re-fetch the lot's
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
  - [ ] `applyRetentionSampleDisposed`: system-actor event (see Task 2), no lock
        contention concern since it only flips `qc_retention_sample.status` from
        `'retained'` to `'disposal_pending'` — guard the UPDATE with `WHERE status =
        'retained'` (idempotent-by-construction, same as `setQcNcrOutcome`'s `WHERE
        outcome IS NULL` pattern in `src/read/projections/qc_ncr.ts:207-236`) so a
        re-fired sweep tick is a no-op rather than a double transition.

- [ ] **Task 5: Retention-years resolution and config** (AC: 1, 2, 7)
  - [ ] Add `config.quality.retentionYearsDefault` (env `QC_RETENTION_YEARS_DEFAULT`,
        default `7`, integer, validated `> 0`) and
        `config.quality.bisRetentionFloorYears` (env `QC_BIS_RETENTION_FLOOR_YEARS`,
        default `7`, integer, validated `> 0`) to `src/config/index.ts`, following
        the exact validate-at-boot pattern already used at lines 425-439 (throw at
        startup, not at request time, if `retentionYearsDefault <
        bisRetentionFloorYears` — this IS the `RETENTION_FLOOR_VIOLATION` check per
        Binding Scope Decision 7; there is no runtime admin route in this story).
  - [ ] Add a small pure helper `resolveRetentionYears(bisLicenceRequired: boolean):
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

- [ ] **Task 6: 23505 duplicate-conflict mapping** (AC: 4, 7)
  - [ ] `src/events/store.ts`: extend the existing 23505 branch chain (grep for
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
  - [ ] The generic `chk_qc_*` CHECK-constraint fallback (`err.code === '23514'`,
        `constraint.startsWith('chk_qc_')` → 400 `INVALID_PAYLOAD`) already covers
        every new CHECK constraint from Task 1 with no changes needed — confirmed
        during the Story 8.3 review that this fallback is a deliberate, working
        catch-all, not a gap.

- [ ] **Task 7: REST routes** (AC: 1, 3, 4, 6, 7, 8)
  - [ ] `POST /api/v1/qc/tasks/:taskId/retention-sample` — body `{ quantity, uom,
        location_id }`; `assertWriteSiteAccess`; `requireBody`; mint the event id up
        front and compare against what `persistEvent` returns to detect replay (the
        idiom `recordNcrOutcomeBase` was patched to use during the Story 8.3 review
        — do NOT copy the check-then-act pre-`SELECT` pattern that route originally
        shipped with).
  - [ ] `POST /api/v1/qc/tasks/:taskId/release` — no body fields (everything
        server-derived); same replay idiom.
  - [ ] `GET /api/v1/qc/tasks/:taskId/release` and
        `GET /api/v1/qc/tasks/:taskId/retention-sample` — `assertReadSiteAccess`,
        404 if not yet recorded.
  - [ ] Add `QC_RELEASE_NOT_ELIGIBLE`, `RETENTION_SAMPLE_REQUIRED`, `RELEASE_EXISTS`,
        `RETENTION_SAMPLE_EXISTS` to `AUDITED_REJECTIONS`
        (`src/api/v1/quality.ts:211-224`) — every new refusal code this story
        introduces represents a refused authority or a refused state change (AC8),
        matching exactly why Story 8.3 added its own five codes there (including
        both of its "already exists" duplicate codes, `DISPOSITION_EXISTS` AND
        `NCR_OUTCOME_EXISTS` — do not add only one of this story's two "already
        exists" codes and leave the other out).
  - [ ] Mount the new routes in the existing `/api/v1/qc/tasks/:taskId/*` family in
        `src/server.ts`, after the existing split/disposition routes (route-order
        matters only for path-prefix ambiguity — none exists here, these are new
        leaf paths).

- [ ] **Task 8: Retention-sample expiry alert cycle** (AC: 5)
  - [ ] New `src/notify/retention-expiry.ts` exporting `runRetentionExpiryCycle()`,
        following the exact shape of `src/notify/expire.ts`'s `runExpiryCycle`: one
        transaction, `SELECT ... WHERE status = 'retained' AND expires_on <=
        CURRENT_DATE + config.quality.retentionExpiryAlertLeadDays` (new config key,
        env `QC_RETENTION_EXPIRY_ALERT_LEAD_DAYS`, default `30` per AC5), emit one
        `qc.retention_sample_disposed` event per row via `applyRetentionSampleDisposed`
        (Task 4), commit together (same atomic-outbox principle
        `src/notify/expire.ts:27-33` documents). Idempotent by construction: the
        `WHERE status = 'retained'` guard means an already-flipped row is never
        re-swept.
  - [ ] Wire a new `retentionExpiryTimer` in `src/server.ts` `startServer()`
        (`:1044-1061`) using the exact same `guarded()` re-entrancy wrapper
        (`:1031-1042`) and a new `config.notify.retentionExpiryIntervalMs` config
        key, env `QC_RETENTION_EXPIRY_INTERVAL_MS`, default `3_600_000` (1 hour —
        pin this exact value, matching `config.notify.expiryIntervalMs`'s existing
        default precisely, not a vague "hourly or daily"), plus `clearInterval` in
        `stopTimers()` (`:1063-1067`) and the two signal handlers.
  - [ ] Test-only: expose `runRetentionExpiryCycle()` for direct invocation the same
        way `runDispatchCycle`/`runEscalationCycle`/`runExpiryCycle` are — tests
        control cycle timing explicitly, never race a background timer.

- [ ] **Task 9: Tests** (AC: 1 through 8)
  - [ ] New `test/integration/story-8-4.test.ts` covering, at minimum: retention
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
  - [ ] Reuse fixtures from `test/integration/story-8-3.test.ts` in the same file
        (its own helpers like `heldLot`, `inspected`, `rejectedLot`, `planOk`,
        `disposition`, `authFor` are NOT exported — Story 8.3's own Group D review
        found the task text's instruction to import Story 8.1/8.2 fixtures was
        structurally impossible for the same reason; local re-implementation of an
        `accepted(plan, quantity)` helper analogous to `inspected`/`rejectedLot` is
        expected and fine, document it as Debug Log References the way Story 8.3
        did rather than leaving it a silent, undisclosed deviation).
  - [ ] Run `npm run build`, `npm run lint`, the typecheck, and `npm run db:migrate`
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
| `RETENTION_FLOOR_VIOLATION` | — | New | Boot-time config validation only (Binding Scope Decision 7) — throws at startup, not a request-time HTTP code. |
| `QC_DERIVATION_MISMATCH` | 409 | Existing | A client declared a server-derived field. |
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

## Open Questions for the Product Owner

1. Does a retention sample need to be physically logged for EVERY released lot, or
   only for BIS-covered products? Binding Scope Decision 6 implements the broader
   (every lot) rule as the safe default for a regulated-manufacturing compliance
   feature — narrowing it to BIS-covered-only later is a small, isolated change (one
   extra condition in the eligibility gate in `applyBatchReleaseRecorded`).
2. Is a single global `bisRetentionFloorYears` config value acceptable for AC2's "STI
   floor," or does the product need a real per-BIS-scheme retention table before this
   story can be considered complete? Binding Scope Decision 7 implements the
   single-value version; a real registry would be a larger, separate piece of work
   (plausibly folded into Story 8.7).
3. Does releasing a lot need a second approver (segregation of duties), the way
   Story 8.5 is expected to add for quality holds? No AC evidence requires it — Task
   4's `applyBatchReleaseRecorded` is implemented as a single-actor QC-inspector-level
   action by default.

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

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

- 2026-08-30: Created via create-story workflow from baseline `94056d9` (Story 8.3
  done, committed). 8 binding scope decisions (release as a new downstream step
  distinct from disposition; BIS licence-number stub pending Story 8.7;
  `bis_licence_required` reused as the BIS-coverage gate; CoA-vs-CoC derived from the
  same flag; no physical document generated, reference-only; retention sample
  required for every released lot; retention floor as single config value; retention
  sample location reuses the existing location_id vocabulary). 9 tasks, closes
  deferred-work implied by Story 8.3's own Out of Scope hand-off.
