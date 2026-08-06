---
baseline_commit: 8c2c44f
---

# Story 4.2: Supplier Performance Scorecards

Status: done

## Story

As a procurement officer,
I want supplier performance captured across on-time delivery, quality acceptance, price variance, and responsiveness with a consolidated scorecard,
so that I can make sourcing decisions on evidence rather than anecdote.

## Acceptance Criteria

1. **On-time delivery metric is computed from receipts against PO promise dates.** Given an active supplier (Story 4.1) with an issued and confirmed PO (Story 4.4) carrying a non-null `promised_delivery_date` on the PO header and on the PO line, when a `goods.received` event (Story 3.4 receiving, consumed through Story 4.5) is recorded for that PO and the GRN is bound to the native PO via `grn.po_linked` (Story 4.5), then the supplier's on-time delivery metric is updated from `signed(received_date - promised_delivery_date)` measured in days, persisted as a new `supplier_scorecard.metric_recorded` event, and a corresponding row is written to the `supplier_scorecard_metric` projection. A receipt on or before the promised date is on-time; a receipt after the promised date is late; a receipt that lands before the PO was confirmed (i.e. before `promised_delivery_date` was stamped) is excluded from the metric (no data) and does not pollute the rolling trend. A PO without a promised date does not contribute on-time data and is not a fabricated zero.

2. **Quality acceptance metric is updated from QC lot dispositions when they exist.** Given a supplier's received lot has been dispositioned accept, reject, or conditional by a future Epic 8 Story 8.3 lot-disposition event (`qc.lot_dispositioned`, or its `qc` stream equivalent), when that event is recorded against a lot that traces back to a `grn_line` bound to the supplier's PO, then the supplier's quality-acceptance metric is updated as the rolling count of accept dispositions versus the count of reject and conditional dispositions. A supplier whose lots have never been dispositioned shows "no data" for this dimension and the API returns `quality_acceptance: { state: "no_data" }` rather than `0`. Because Epic 8 is in the pilot slice and is not yet built, this AC's event registration, applier, and metric-projection column are wired in this story but the projection column starts empty; the seam hook is consumed by Epic 8 when that story lands. Story 4.2 must not invent a placeholder QC source.

3. **Price variance metric is updated from three-way match results.** Given a supplier invoice captured in Story 4.7 is matched against a PO with a price difference, when the `three_way_match.recorded` event (Story 4.5) completes with `result = 'passed'` or `result = 'blocked'`, then the supplier's price-variance metric is updated with the per-line `price_variance_pct` from `variance_detail` (signed, NUMERIC-as-string), averaged across the matched lines of that match record and appended to a per-supplier rolling series. A match where every line passed with zero variance contributes `0.000000` and is recorded as such; a match with no lines yet (an empty match against an unmatched invoice) is rejected upstream by Story 4.5 and never reaches this story. The metric is computed in PostgreSQL NUMERIC, never in JavaScript floats.

4. **Responsiveness metric is updated from PO confirmation latency.** Given an issued PO (`purchase_order.issued` event from Story 4.4) awaiting supplier confirmation, when the `purchase_order.confirmed` event (Story 4.4) is recorded with a `promised_delivery_date`, then the supplier's responsiveness metric is updated as the count of business days (IST-calendar business days, Monday through Saturday, excluding the four statutory Second Saturday / Sunday-style holidays configured in `config.scorecard.responsivenessHolidayCalendar`, default empty list) elapsed from `purchase_order.issued` `metadata.occurred_at` to `purchase_order.confirmed` `metadata.occurred_at`, appended to a per-supplier rolling series. The metric is a positive integer number of business days, never wall-clock days. A PO confirmed by the procurement officer on the same day the PO is issued contributes `0`; a PO that is never confirmed never contributes. Business-day arithmetic is a new helper in `src/lib/business-days.ts` and is unit-tested against a fixed calendar.

5. **Consolidated scorecard view shows trended metrics with drill-through.** Given a procurement officer opens a supplier scorecard, when the scorecard view loads, then on-time delivery, quality acceptance, price variance, and responsiveness are shown as trended series with summary aggregates (count, mean, latest, trailing 30 / 90 / 365-day windows) and the underlying transactions (receipts, dispositions, matches, confirmations) are available for drill-through. The REST contract exposes `GET /api/v1/supplier-scorecards/:supplierId` returning `{ supplier_id, generated_at, metrics: { on_time_delivery: TrendSeries, quality_acceptance: TrendSeries | NoData, price_variance: TrendSeries, responsiveness: TrendSeries } }` and the drill-through endpoints `GET /api/v1/supplier-scorecards/:supplierId/transactions` (filterable by metric kind and date range). A "no data" trend is a first-class response shape, never a fabricated zero. The scorecard is server-derived at request time from the existing projection tables (`grn`, `purchase_order`, `three_way_match`) and the new `supplier_scorecard_metric` projection; no pre-computed rollup is required and stale pre-computes are never a correctness risk.

6. **Enforcement lives in the compliance seam.** All metric computation, supplier existence checks, PO existence checks, sign handling, NUMERIC arithmetic, and idempotency live inside the `persistEvent` compliance seam. Direct `POST /api/v1/events` with a `supplier_scorecard.metric_recorded` event cannot bypass the supplier-active check, the PO-status check, or the metric kind validation. The seam re-derives each metric in SQL NUMERIC inside the same transaction as the `domain_events` insert (AD-14, AD-16); replay of a duplicate `supplier_scorecard.metric_recorded` event is a no-op (idempotent on `metric_id`) and the audit log is unaffected.

7. **Metric series are immutable append-only history.** Each metric recording writes a new row to `supplier_scorecard_metric` keyed by `metric_id UUID`; no row is ever updated or deleted. The metric row carries the `metric_kind` enum (`on_time_delivery`, `quality_acceptance`, `price_variance`, `responsiveness`), the `reference_event_id` (the GRN, match, or PO event that produced the value), the `reference_entity_id` (the GRN, match, or PO id), the `value_num NUMERIC(14,6)` (or `0` for `quality_acceptance.accept_count` style counters), the `context JSONB` (carrying e.g. `received_date`, `promised_delivery_date`, `variance_pct` for transparency), `business_date`, and `source_event_id`. The scorecard view computes the trailing windows from this projection at request time; it never mutates a row. A correction is a new event with a `supersedes_metric_id` reference, not an in-place update.

## Tasks / Subtasks

- [x] Task 1: Define the supplier scorecard metric projection (AC: 1, 2, 3, 4, 7)
  - [x] 1.1 Create `read/projections/supplier_scorecard_metric.sql` as the canonical table. Columns: `metric_id UUID PRIMARY KEY`, `supplier_id UUID NOT NULL`, `metric_kind TEXT NOT NULL CHECK (metric_kind IN ('on_time_delivery','quality_acceptance','price_variance','responsiveness'))`, `reference_event_id UUID NOT NULL`, `reference_entity_id UUID NOT NULL`, `value_num NUMERIC(14,6) NOT NULL`, `context JSONB NOT NULL DEFAULT '{}'::jsonb`, `business_date DATE NOT NULL`, `source_event_id UUID NOT NULL`, `supersedes_metric_id UUID NULL`, `recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `recorded_by UUID NOT NULL`. Indexes: `idx_supplier_scorecard_supplier_kind (supplier_id, metric_kind, business_date DESC)`, `idx_supplier_scorecard_reference (reference_entity_id)`, partial `idx_supplier_scorecard_supersedes (supersedes_metric_id) WHERE supersedes_metric_id IS NOT NULL`. Add a partial unique index on `(reference_event_id, metric_kind)` to enforce replay idempotency. Grants: `INSERT, SELECT` to `app_user`, `SELECT` to `readonly_user`, no DELETE.
  - [x] 1.2 Mirror the DDL byte-identically into `deploy/compose/init-db.sql` under the `-- MUST stay identical to read/projections/supplier_scorecard_metric.sql (canonical source).` header. Keep LF endings.
  - [x] 1.3 Append `read/projections/supplier_scorecard_metric.sql` to the `MIGRATIONS` tail in `src/events/migrate.ts` (after the `payment_clearance_feed.sql` entry, position 62). Run `npm run db:migrate` twice and confirm idempotence.
  - [x] 1.4 Add an `EXPECTED` entry for `supplier_scorecard_metric` in `test/unit/schema-drift.test.ts` matching the 4.4/4.5/4.7 precedent entries: columns, named CHECK constraint, indexes, grants. Run the schema-drift suite green.

- [x] Task 2: Register the scorecard event payload and stream (AC: 1, 2, 3, 4, 7)
  - [x] 2.1 In `src/events/schema.ts`, add the `SupplierScorecardMetricRecordedPayload` interface (the `Omit<EventEnvelope, 'payload'>` idiom, mirroring the `MsmeAgeingFeedRecordedPayload` and `ThreeWayMatchRecordedPayload` blocks): `metric_id`, `supplier_id`, `metric_kind` (the four-value enum), `reference_event_id`, `reference_entity_id` (string, since it can be a GRN, a match, or a PO id), `value_num` (string, NUMERIC-as-string), `context` (JSONB-shape record carrying the drill-through facts), `business_date` (calendar date string `YYYY-MM-DD`), `supersedes_metric_id?`, `recorded_by?` (server-set from auth). All NUMERIC values are strings.
  - [x] 2.2 Tail-append `supplier_scorecard.metric_recorded` to `SUPPORTED_EVENT_TYPES` with `streamType: 'procurement'`, `requiresBusinessStream: false` (the scorecard is an analytic read-side artifact; its business stream is stamped onto the projection from the source PO/GRN, matching the Story 4.6 `msme.*` precedent).
  - [x] 2.3 Reserve the future `qc.lot_dispositioned` event name in the schema doc comment at `src/events/schema.ts:1-30` with a one-line note that Story 4.2's quality-acceptance applier activates when Epic 8 lands. Do not register the event in `SUPPORTED_EVENT_TYPES`; that is Epic 8's responsibility. This story only documents the hook.

- [x] Task 3: Compliance seam `src/compliance/supplier-scorecard.ts` (AC: 1, 2, 3, 4, 6, 7)
  - [x] 3.1 Export the canonical three symbols plus the module-local `alreadyPersisted` plain SELECT (copy from `src/compliance/purchase-order.ts:264-271`, never from `src/compliance/supplier.ts:272-275` - that `FOR UPDATE` on `domain_events` is a live 42501 defect that broke supplier 4.1): `supplierScorecardEventType(envelope)` (null unless `stream_type === 'procurement'` AND event_type is `supplier_scorecard.metric_recorded`), `assertSupplierScorecardShape(envelope)` (pre-transaction, never consumes an idempotency key), `applySupplierScorecardProjection(envelope, client, eventId)` (in-transaction).
  - [x] 3.2 `assertSupplierScorecardShape`: validate the metric_id is a strict RFC-4122 UUID (the project's existing UUID regex rejects nil UUIDs), supplier_id is a UUID, metric_kind is one of the four enum values, reference_event_id and reference_entity_id are UUIDs, value_num is a NUMERIC-as-string with at most 6 decimal places and at most 14 integer digits, business_date is a strict calendar `YYYY-MM-DD` (the Story 4.4 calendar-date helper at `src/compliance/purchase-order.ts` is the model - reject rollover dates like 31 February, reject epoch-zero, reject year 9999), context is a JSONB object with required keys per metric kind (e.g. on-time requires `received_date` and `promised_delivery_date`; price-variance requires `variance_pct`; responsiveness requires `issued_at` and `confirmed_at`; quality-acceptance requires `disposition`).
  - [x] 3.3 `applySupplierScorecardProjection`: open a transaction, run `alreadyPersisted` plain SELECT; on hit, return early (idempotent replay); otherwise `SELECT ... FOR UPDATE` the supplier row from `src/read/projections/supplier.ts: getSupplierById(client, supplierId, true)` and require `status = 'active'` (else `SUPPLIER_NOT_ACTIVE` 409, reusing the existing permanent code); insert the metric row via a new `insertScorecardMetric` helper in `src/read/projections/supplier_scorecard_metric.ts`; commit alongside the `domain_events` insert through `persistEvent` (AD-14/AD-16). Never compare NUMERIC in JavaScript; pass the `value_num` string straight into the SQL `INSERT`.
  - [x] 3.4 Wire into `src/events/store.ts`: `assertSupplierScorecardShape` immediately after `assertMsmeShape` in the pre-transaction block (store.ts:467 area, mirroring the 4.6 msme wiring at `src/compliance/msme.ts:402-420`); `applySupplierScorecardProjection` immediately after `applyMsmeProjection` in the in-transaction block (store.ts:697 area). Preserve all existing compliance seam ordering; do not reorder.

- [x] Task 4: Read accessors `src/read/projections/supplier_scorecard_metric.ts` (AC: 1, 2, 3, 4, 5, 7)
  - [x] 4.1 Mirror the `src/read/projections/three_way_match.ts` conventions exactly: `Queryable` plus `runner(client?)`, `UUID_REGEX` guard, `SUPPLIER_SCORECARD_METRIC_COLUMNS`, `getScorecardMetricById`, `getScorecardMetricByReferenceEvent` (for idempotency), `insertScorecardMetric` (returns the inserted row count, caller skips on 0), `listScorecardMetrics` with `supplier_id`, `metric_kind`, `since_date`, `until_date`, `limit` (capped at 200), and `offset` filters, NUMERIC as strings, DATE as calendar strings, ILIKE escaping `replace(/[%_\\]/g, '\\$&')` + `ESCAPE '\'`, `permittedLocationsForModuleScope(roles, 'procurement', 'read')` site scoping applied through the supplier's `site_id` join (the supplier registry currently does not carry a `site_id` - in that case the scope is procurement-module-wide for now, mirror the 4.7 `supplier_invoice` site-scoping fallback at `src/read/projections/supplier_invoice.ts:340-360`).
  - [x] 4.2 Add `getScorecardSummary(supplierId, client?)`: a single SQL query that returns per-metric-kind `{ count, mean, latest, latest_value, trailing_30d_mean, trailing_90d_mean, trailing_365d_mean }` plus the most recent `recorded_at`. Use NUMERIC `ROUND(AVG(value_num), 6)` casts to keep the type string-stable. The `quality_acceptance` row returns `state: 'no_data'` when count is zero - the SQL emits a separate column `quality_acceptance_count`; the accessor maps zero count to `{ state: 'no_data' }` in TypeScript.
  - [x] 4.3 Add `listScorecardTransactions(supplierId, filters, client?)`: union over the underlying `grn`, `purchase_order`, and `three_way_match` projections that the scorecard was derived from, returning the drill-through rows that produced each metric. The shape is `{ metric_kind, reference_entity_id, occurred_at, summary, business_date }`. Limit capped at 200. Filter by metric_kind and date range. The supplier-only constraint is enforced via the same `supplier_id` join the metric row already carries.

- [x] Task 5: Business-day helper `src/lib/business-days.ts` (AC: 4)
  - [x] 5.1 Implement `businessDaysBetween(startUtc, endUtc, holidayDates: string[]): number` as the responsiveness metric's date-arithmetic engine. Algorithm: convert the UTC timestamps to IST calendar dates, iterate calendar days inclusive of the start date and exclusive of the end date, increment for every day that is Monday through Saturday AND not in the `holidayDates` set. Return 0 when `endUtc` is the same IST calendar day as `startUtc` (the on-day-of-issuance confirmation case). Return negative is never produced: when `endUtc < startUtc` return 0 (defensive - a clock-skew safety net, AC4 says "positive integer").
  - [x] 5.2 Implement `toIstCalendarDate(utc: Date): string` returning `YYYY-MM-DD` in `Asia/Kolkata` (the project convention, see `src/read/projections/integration_exception.ts` for the same IANA use). Do not use `Date.toLocaleString` - use a fixed-offset `+05:30` arithmetic helper or the `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` formatting that returns `YYYY-MM-DD` reliably. The test asserts IST `2026-08-15` (Saturday) and `2026-08-16` (Sunday) classify correctly.
  - [x] 5.3 No new dependency. Use Node 24's built-in `Intl.DateTimeFormat` and `Temporal` (if available; fall back to `Intl` if `Temporal` is not yet enabled in the project's tsconfig target - check `tsconfig.json`'s `lib` array first; the safe path is `Intl`-only).
  - [x] 5.4 Add a `test/unit/business-days.test.ts` covering: same-day returns 0, weekend-only gap returns 0, two-business-day gap, holiday removal, IST midnight rollover (a UTC `2026-08-15T18:30:00Z` to `2026-08-17T18:30:00Z` is one IST calendar day not two), and a clock-skew negative-gap returns 0.

- [x] Task 6: REST routes `src/api/v1/supplier-scorecards.ts` (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] 6.1 Copy the `ActorContext`/`actorContext(req)`/`auditCtxFor(req, actor, httpStatus)` boilerplate from `src/api/v1/three-way-match.ts`. Handlers: `GET /api/v1/supplier-scorecards/:supplierId` (returns the consolidated scorecard via `getScorecardSummary` plus the four metric series via `listScorecardMetrics` with a default 365-day window), `GET /api/v1/supplier-scorecards/:supplierId/transactions` (drill-through, filterable by `metric_kind`, `since`, `until`, `limit`, `offset`).
  - [x] 6.2 RBAC descriptors: `module: 'procurement'`, `functionScope: 'read'`. No role-name literals anywhere (`test/unit/no-hardcoded-role-in-workflow.test.ts` fails the build). Use `requireRole` exactly as `src/api/v1/three-way-match.ts:444-452` does.
  - [x] 6.3 Validation: supplier_id is a strict RFC-4122 UUID; date filters are strict calendar `YYYY-MM-DD` (the Story 4.4 calendar helper); `limit` is integer 1-200, `offset` is integer 0-10000. Reject malformed input with 400 `INVALID_PARAMS`; the existing parameter-validation pattern at `src/api/v1/supplier-invoices.ts:267-276` is the model.
  - [x] 6.4 Register the two routes in `createAppRouter()` at `src/server.ts` under a `// Story 4.2: Supplier Performance Scorecards` comment immediately after the Story 4.5 three-way-match block (around server.ts:454). Append both route paths to the sorted `allowedSpineRoutes` array in `test/integration/story-1-9.test.ts`; the spine gate will pin the surface.

- [x] Task 7: Metric write-path routes for the four upstream event consumers (AC: 1, 2, 3, 4)
  - [x] 7.1 **On-time delivery write path.** Add a thin route `POST /api/v1/grns/:grnId/scorecard/on-time` that loads the GRN (`getGrnById`), requires `grn.po_id IS NOT NULL` and the linked PO's `promised_delivery_date IS NOT NULL` and `status IN ('issued', 'confirmed')`, computes `signed(received_date - promised_delivery_date)` in days using the same calendar-date helper as the three-way match (NUMERIC-as-string, never JS), and emits a `supplier_scorecard.metric_recorded` event with `metric_kind: 'on_time_delivery'`, `reference_event_id: grn.source_event_id`, `reference_entity_id: grn.grn_id`, `value_num: <signed-day-delta as NUMERIC-string>`, `context: { received_date, promised_delivery_date, po_id, grn_id }`, `business_date: grn.business_date`. The route is the only allowed write path; the compliance seam enforces supplier-active (Task 3.3). Direct `POST /api/v1/events` with the event payload is the only alternative write path for testing.
  - [x] 7.2 **Price variance write path.** Add `POST /api/v1/three-way-match/:matchId/scorecard/price-variance` that loads the match, requires `match.status IN ('passed', 'blocked')`, computes the per-line `price_variance_pct` mean across non-empty `variance_detail.lines` (where each line carries `price_variance_pct`), and emits a `supplier_scorecard.metric_recorded` event with `metric_kind: 'price_variance'`, `value_num: <mean-as-NUMERIC-string>`, `context: { match_id, po_id, invoice_id, line_count }`. A match with zero variance lines (every line passed at exactly the PO price) still contributes `0.000000`; an all-empty match record does not exist (the seam rejects empty matches upstream).
  - [x] 7.3 **Responsiveness write path.** Add `POST /api/v1/purchase-orders/:poId/scorecard/responsiveness` that loads the PO, requires `status = 'confirmed'`, requires both `issued_at` and `confirmed_at` to be non-null, computes business days via `businessDaysBetween(issued_at, confirmed_at, config.scorecard.responsivenessHolidayCalendar)`, and emits a `supplier_scorecard.metric_recorded` event with `metric_kind: 'responsiveness'`, `value_num: <business-day-integer-as-NUMERIC-string>`, `context: { po_id, issued_at, confirmed_at, business_days: <integer>, holiday_count: <integer> }`. The value crosses the wire as a NUMERIC string but the context carries the integer for drill-through display.
  - [x] 7.4 **Quality acceptance write path.** Story 4.2 does NOT add a write route for `quality_acceptance`. The metric applier in `src/compliance/supplier-scorecard.ts` registers a no-op `metricKind === 'quality_acceptance'` case that returns early and logs a debug entry; the projection column stays empty until Epic 8 lands. The Story 4.2 read accessor surfaces `state: 'no_data'` when count is zero (Task 4.2). The route `POST /api/v1/.../scorecard/quality-acceptance` is NOT built and not registered. Do not add the placeholder route.

- [x] Task 8: Add exhaustive integration and unit tests (AC: 1 through 7)
  - [x] 8.1 Create `test/integration/story-4-2.test.ts` modeled on `test/integration/story-4-5.test.ts` harness: real PostgreSQL on `DB_PORT=5442`, `node:test` plus `node:assert/strict`, `--test-concurrency=1`, canonical SQL applied in `migrate.ts` order via `getAdminPool()`, audit-trigger disable plus `TRUNCATE ... CASCADE` in try/finally, SCIM `provisionUser` fixtures, `run = randomUUID().slice(0,8)` suffixes, port-0 server, events seeded through real API routes (supplier via 4.1 routes, indent via 4.3 routes, PO via 4.4 routes, GRN via 3.4 receiving route, invoice via 4.7 routes, three-way-match via 4.5 routes).
  - [x] 8.2 Cover, one `it('ACn: ...')` per branch: AC1 - on-time metric written when GRN is bound to a PO with a promised date and received on or before the promise (value 0 or negative), late (value positive), no-data when promised date is null (route rejects, no metric row); AC1 - replay of the same `supplier_scorecard.metric_recorded` event is a no-op (row count stays 1); AC1 - direct `POST /api/v1/events` with a malformed `business_date` is rejected at the seam (`INVALID_PARAMS`), with an unknown `metric_kind` (`INVALID_PARAMS`), with a non-numeric `value_num` (`INVALID_PARAMS`), with an inactive supplier (`SUPPLIER_NOT_ACTIVE`, 409); AC1 - seam-then-route: same payload is rejected by both, no double metric row.
  - [x] 8.3 AC2 - quality acceptance metric: no `qc.lot_dispositioned` event exists; assert the projection has zero `metric_kind = 'quality_acceptance'` rows; `GET /api/v1/supplier-scorecards/:supplierId` returns `quality_acceptance: { state: 'no_data' }` for the supplier; the response shape is exact (no `count`, `mean`, etc. for no_data).
  - [x] 8.4 AC3 - price variance: pass a three-way match with a +2.5% price variance on a single line; assert the metric row's `value_num` is the exact NUMERIC string `'2.500000'`; pass a second match with a -1% variance; assert the scorecard summary's `latest` is `-1.000000` and the count is 2; a match with no lines (theoretical) is unreachable; assert NUMERIC as strings throughout.
  - [x] 8.5 AC4 - responsiveness: PO issued and confirmed the same business day returns `value_num = '0.000000'`; PO issued Friday 2026-08-14 IST and confirmed Monday 2026-08-17 IST returns `value_num = '1.000000'` (one business day); PO issued and confirmed across a Saturday and Sunday with no holiday returns `0.000000`; a configured holiday removes that business day; clock-skew negative gap returns 0.
  - [x] 8.6 AC5 - consolidated view: assert the response shape is exactly `{ supplier_id, generated_at, metrics: { on_time_delivery: { count, mean, latest, latest_value, trailing_30d_mean, trailing_90d_mean, trailing_365d_mean }, quality_acceptance: { state: 'no_data' }, price_variance: { ... }, responsiveness: { ... } } }`; the transactions endpoint returns the underlying GRN, match, and PO rows with the right `metric_kind` mapping.
  - [x] 8.7 AC6 - seam enforcement: a direct `POST /api/v1/events` with a `supplier_scorecard.metric_recorded` event that names a supplier in `onboarding` status is rejected with `SUPPLIER_NOT_ACTIVE`; a direct event with a duplicate `metric_id` returns 200 (or 201-or-409 per the project's documented idempotent-replay surface, pin row count = 1).
  - [x] 8.8 AC7 - append-only: insert a correction metric row that references `supersedes_metric_id`; the prior row is unchanged (column count = 1 originally, 2 after the correction; both queryable); no DELETE grant exists for `app_user` (assert via `\dp supplier_scorecard_metric`).
  - [x] 8.9 Unit test `test/unit/business-days.test.ts` (Task 5.4) plus a seam unit test `test/unit/supplier-scorecard-shape.test.ts` covering every rejection branch of `assertSupplierScorecardShape` (malformed UUID, nil UUID, bad date rollover, oversize NUMERIC, unknown metric_kind, missing context keys).
  - [x] 8.10 Test hygiene: suffix external IDs with `-${run}`; `crypto.randomUUID()` everywhere; assert NUMERIC as strings (`'2.500000'`); assert DATE via `::text` cast; `DB_PORT=5442`; `runDispatchCycle()` for deterministic notification assertions (scorecard routes emit no notifications, but the harness import keeps parity with 4.4/4.5/4.7).

- [x] Task 9: Run the complete verification gate (AC: all)
  - [x] 9.1 Run `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` (twice - idempotence proof), `npm test` (zero new failures; 14 pre-existing idempotency 201-vs-409 failures remain documented in `deferred-work.md`), `npm run spine-acceptance-contract` (6/6), schema-drift green, no-hardcoded-role green, `git diff --check`.
  - [x] 9.2 Edge gates unchanged (no edge files touched): `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test` should rerun 30/30 untouched.
  - [x] 9.3 Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: set `4-2-supplier-performance-scorecards: review`. Append any deferred work (e.g. the future Epic 8 `qc.lot_dispositioned` hook, the `business_days` holiday calendar configuration) to `_bmad-output/implementation-artifacts/deferred-work.md`.
  - [x] 9.4 Do not mark any task complete from code inspection alone. Record each command, exit result, test count, and any proven pre-existing failure in the Dev Agent Record.

### Review Findings

From the 2026-08-06 adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor, full working-tree diff against baseline `8c2c44f`):

- [x] [Review][Patch] The seam does not re-derive metric values and never resolves reference entities, so a direct POST /api/v1/events can fabricate any value_num and attribute it to any active supplier with fabricated reference ids; route-only checks (GRN link, PO status, promised date, match status) are bypassable, and the route path has a TOCTOU gap between route reads and the seam write; violates AC6 and AC7 reference semantics; the AC6 tests currently pass with randomUUID reference ids, which is the proof of the gap; the missing Task 8.2 seam-then-route test belongs with this fix [src/compliance/supplier-scorecard.ts:147-206, test/integration/story-4-2.test.ts:150-162] - RESOLVED 2026-08-07: the applier now resolves reference_entity_id per metric kind under FOR UPDATE locks (grn to po to supplier chain, match to po, po), verifies existence, lifecycle status and supplier correspondence (SCORECARD_SUPPLIER_MISMATCH), re-derives value_num, business_date and reference_event_id and rejects any payload disagreement with SCORECARD_DERIVATION_MISMATCH, and overwrites the drill-through context with the derived facts; the TOCTOU closes because the derivation reads the locked rows inside the persist transaction. The AC6 direct-event tests were rewritten onto real fixtures and four new tests added: fabricated value_num rejected, nonexistent reference entity rejected, wrong-supplier attribution rejected, and the seam-then-route test proving the same unlinked-GRN violation is rejected identically by both surfaces.
- [x] [Review][Patch] Trailing 30/90/365-day windows anchor on server CURRENT_DATE and the series since on UTC Date.now while business_date is IST, so the windows drift by one calendar day for roughly 18.5 hours per day [src/read/projections/supplier_scorecard_metric.ts:209-214, src/api/v1/supplier-scorecards.ts:220] - RESOLVED 2026-08-07: the summary SQL anchors on the current IST calendar date passed as a parameter (istToday() via toIstCalendarDate) and the route's default series since is computed with toIstCalendarDate as well.
- [x] [Review][Patch] Responsiveness reference_event_id points at the purchase_order.drafted event because purchase_order.source_event_id is stamped once at draft and never updated on confirm; AC7 defines reference_event_id as the event that produced the value, which for responsiveness is purchase_order.confirmed [src/api/v1/supplier-scorecards.ts:511, src/compliance/purchase-order.ts:401] - RESOLVED 2026-08-07: new getPoConfirmedEventId accessor resolves the latest purchase_order.confirmed event_id per event_version; both the route and the seam use it and the seam enforces the match.
- [x] [Review][Patch] IST conversion duplicated: the route file defines its own istBusinessDate with hand-rolled +5.5h arithmetic instead of importing toIstCalendarDate; the spec mandates the business-days module as the single source [src/api/v1/supplier-scorecards.ts:191-194, src/lib/business-days.ts:20] - RESOLVED 2026-08-07: istBusinessDate deleted; the route and the seam both import toIstCalendarDate from src/lib/business-days.js.
- [x] [Review][Patch] Holiday calendar entries are not format-validated at config load; a malformed entry silently never matches the zero-padded IST day and the holiday is silently not removed; the project config pattern fails closed elsewhere [src/config/index.ts:243-250] - RESOLVED 2026-08-07: every SCORECARD_RESPONSIVENESS_HOLIDAYS entry is validated as a strict real calendar date at config load and an invalid entry throws at startup (fail closed, the config.msme precedent).
- [x] [Review][Patch] computeMatchMeanPriceVariance throws a raw 500 when variance_detail->'lines' is not an array (no jsonb_typeof guard), and context.line_count counts all lines while the mean only averages invoice_qty > 0 lines [src/read/projections/supplier_scorecard_metric.ts:303-317, src/api/v1/supplier-scorecards.ts:418-420] - RESOLVED 2026-08-07: restructured as computeMatchPriceVariance returning mean_pct plus contributing_lines; a jsonb_typeof guard degrades a corrupted non-array lines value to an empty set, and context.line_count is the contributing count so the drill-through context matches the arithmetic.
- [x] [Review][Patch] Missing integration branch from Task 8.5: no integration test sets a holiday and asserts removal (only the unit test covers it) [test/integration/story-4-2.test.ts] - RESOLVED 2026-08-07: new integration branch "AC4: a configured holiday removes that business day" pushes 2026-08-15 onto the configured calendar around a Friday-to-Monday PO and asserts the count drops from 1 to 0, restoring the calendar in a finally block.
- [x] [Review][Patch] supersedes_metric_id is only UUID-format-checked; a direct event can attach a correction to a nonexistent metric row, breaking the correction-chain semantics of AC7 [src/compliance/supplier-scorecard.ts:114-116] - RESOLVED 2026-08-07: the seam now requires supersedes_metric_id to reference an existing row of the same supplier and metric kind (SCORECARD_SUPERSEDES_NOT_FOUND / SCORECARD_SUPERSEDES_MISMATCH), and the replay guard is now the spec-mandated PARTIAL unique index on (reference_event_id, metric_kind) WHERE supersedes_metric_id IS NULL so a correction re-measuring the same source event is admitted while ordinary duplicates remain a no-op; the summary and series exclude superseded rows so the scorecard reflects authoritative values. New test: a correction pointing at a nonexistent metric is rejected; the AC7 correction test now proves the original row stays untouched, the correction carries the re-derived value, and the series serves only the correction.
- [x] [Review][Defer] A replayed direct event without caller-supplied idempotency_key/event_id creates duplicate domain_events and audit rows (the projection replay guard still pins one metric row) [test/integration/story-4-2.test.ts:1116-1135] - deferred, pre-existing platform-wide convention: AD-16 idempotency keys are caller-carried on every direct event surface, so fixing it here alone would fork the convention.

## Dev Notes

### Binding Implementation Decisions

- The four metrics each consume a distinct upstream event. On-time delivery consumes `goods.received` (Story 3.4 receiving) plus the PO's `promised_delivery_date` (set by `purchase_order.confirmed`, Story 4.4). Quality acceptance consumes a not-yet-existing `qc.lot_dispositioned` event from Epic 8 Story 8.3. Price variance consumes `three_way_match.recorded` (Story 4.5). Responsiveness consumes the same `purchase_order.issued` and `purchase_order.confirmed` pair used by the on-time AC but measures business-day latency, not date diff. The four write paths are independent: a single supplier PO can produce zero, one, or four metric rows over its lifetime.
- The scorecard projection is append-only and immutable. A correction is a new row with a `supersedes_metric_id` pointer; the read view treats the most recent row per `(supplier_id, metric_kind, reference_entity_id)` triple as authoritative. There is no UPDATE in any write path.
- The "no data" first-class response shape is load-bearing. AC2 says explicitly that a supplier without QC dispositions must not be shown `0` for quality acceptance; the API contract returns `{ state: 'no_data' }` and the UI must render it as "no data yet", not "0%". This mirrors the deferred-work 4.5 ledger entry that records the `ambiguous_sku` close-failed design (don't fabricate zeros).
- This story does not add a QC source. Epic 8 is the only legitimate source for the quality-acceptance metric, and Epic 8 is not built. The seam hook is reserved; the projection column is reserved; the route is intentionally not built. Do not add a placeholder QC event in this story.
- The responsiveness metric uses business days, not wall-clock days. A PO issued Friday and confirmed Monday is 1 business day, not 3. Business-day arithmetic lives in a single new helper `src/lib/business-days.ts` and is the only place in the codebase that performs this calculation. No second copy is allowed; the unit test at `test/unit/business-days.test.ts` is the only correctness oracle.
- The four write routes in Task 7 are thin: they load the source record, compute the value, and call `persistEvent`. The compliance seam (Task 3) re-derives the value in SQL NUMERIC inside the same transaction; the route is not trusted. Replay of a duplicate `supplier_scorecard.metric_recorded` event is a no-op at the seam via the `metric_id` partial unique index plus the `alreadyPersisted` plain SELECT.
- The scorecard is a read-side artifact. There is no pre-computed rollup table, no scheduled job, no cache. The REST view computes the summary aggregates on demand from the `supplier_scorecard_metric` projection and the underlying GRN/match/PO projections. Stale rollups are an impossibility by construction. This is consistent with the architecture spine's AD-14 (read models are projections) and AD-16 (idempotency keys on commands; the scorecard has no command surface except the four write routes).

### Architecture Compliance

- All metric writes pass through `persistEvent` (`src/events/store.ts:334`). Shape validation runs before idempotency lookup; projection work runs before the `domain_events` insert; audit and event commit together. The four write routes in Task 7 emit one event each; the seam inserts one row into `supplier_scorecard_metric` in the same transaction.
- The scorecard is module-scoped to `procurement` and uses the procurement RBAC descriptors. There is no new module; the scorecard is a read feature of the procurement module.
- UUIDv4 for all internal IDs (metric_id, supplier_id, reference_entity_id, reference_event_id); NUMERIC as strings across the wire and through TypeScript; UTC timestamps stored as `TIMESTAMPTZ`; IST calendar dates for `business_date`. Past-tense dot-separated event naming. No role-name literals anywhere.
- The scorecard is server-derived at request time. AD-14 (read models are projections) is preserved: the projection is the source of truth, no other table is read for the scorecard.
- The compliance seam is the enforcement layer, not the HTTP route. The route computes the candidate value; the seam re-derives it. Direct `POST /api/v1/events` cannot bypass the supplier-active check, the metric-kind validation, or the calendar-date validation.
- No new package or runtime service is required. `node:test`, `node-postgres`, `Intl.DateTimeFormat`. No web research is required.
- There is no edge or offline path for the scorecard. The metric write routes are online-only (they require server-set `recorded_at` from the event timestamp and server-set `recorded_by` from auth). The scorecard read is also online. Do not modify `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, PowerSync rules, or edge components.

### Existing Components to Reuse

- `persistEvent` from `src/events/store.ts:334` is the only write path.
- `getSupplierById` and the supplier projection accessors from `src/read/projections/supplier.ts` for the supplier-active enforcement.
- `getPurchaseOrderById` from `src/read/projections/purchase_order.ts` for the PO status and date checks.
- `getGrnById` from `src/read/projections/grn.ts` for the GRN source.
- `getMatchById` from `src/read/projections/three_way_match.ts` for the match source.
- The `assertCalendarDate` helper at `src/compliance/purchase-order.ts` for strict `YYYY-MM-DD` validation.
- The actor context and `auditCtxFor` boilerplate from `src/api/v1/three-way-match.ts` for REST routes.
- The `permittedLocationsForModuleScope` helper from `src/middleware/` for site scoping.
- The ILIKE escaping pattern `replace(/[%_\\]/g, '\\$&')` plus `ESCAPE '\'` from `src/read/projections/three_way_match.ts:320-340`.
- The NUMERIC-as-string and DATE-as-calendar-string return contracts from `src/read/projections/three_way_match.ts`.
- The `ON CONFLICT DO NOTHING` plus rowCount pattern from `src/compliance/three-way-match.ts:332-349` for the insert path.
- The `alreadyPersisted` plain-SELECT pattern from `src/compliance/purchase-order.ts:264-271` (not the broken supplier `FOR UPDATE` variant).

### Source Tree Touch List

| File | Change | Notes |
| --- | --- | --- |
| `read/projections/supplier_scorecard_metric.sql` | NEW canonical table | Mirrors the 4.5 three_way_match header style |
| `deploy/compose/init-db.sql` | UPDATE byte-identical mirror | LF endings; the schema-drift byte-check depends on it |
| `src/events/migrate.ts` | UPDATE append one filename | Position after `payment_clearance_feed.sql` |
| `src/events/schema.ts` | UPDATE one payload/envelope pair; UPDATE one schema-doc comment | Reserve `qc.lot_dispositioned` name only in comment, not in `SUPPORTED_EVENT_TYPES` |
| `src/events/store.ts` | UPDATE wire compliance module | Two wiring lines, nothing reordered |
| `src/compliance/supplier-scorecard.ts` | NEW compliance module | Three exports; plain-SELECT `alreadyPersisted` |
| `src/read/projections/supplier_scorecard_metric.ts` | NEW read accessors | Mirrors `src/read/projections/three_way_match.ts` |
| `src/lib/business-days.ts` | NEW business-day helper | Single source of business-day arithmetic |
| `src/api/v1/supplier-scorecards.ts` | NEW routes | Two read routes; four write routes in `src/api/v1/...` callers (Task 7) |
| `src/api/v1/grns.ts` | UPDATE append one write route | On-time delivery (Task 7.1) |
| `src/api/v1/three-way-match.ts` | UPDATE append one write route | Price variance (Task 7.2) |
| `src/api/v1/purchase-orders.ts` | UPDATE append one write route | Responsiveness (Task 7.3) |
| `src/server.ts` | UPDATE route registration block | After Story 4.5 block, before Story 4.6 |
| `test/unit/schema-drift.test.ts` | UPDATE add EXPECTED entry | Mirrors the 4.4/4.5/4.7 entries |
| `test/integration/story-1-9.test.ts` | UPDATE `allowedSpineRoutes` | Sorted append; spine gate pins the surface |
| `test/integration/story-4-2.test.ts` | NEW test suite | 4.5 harness, SCIM provisioning, port-0 server |
| `test/unit/business-days.test.ts` | NEW unit test | Task 5.4 |
| `test/unit/supplier-scorecard-shape.test.ts` | NEW unit test | Task 8.9 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | UPDATE status to `review` | After all gates pass |
| `_bmad-output/implementation-artifacts/deferred-work.md` | UPDATE append any deferred items | Epic 8 hook, holiday calendar config |

Files that must NOT change: `src/compliance/purchase-order.ts` (the seam is consumed, not modified), `src/compliance/three-way-match.ts` (same), `src/compliance/supplier-invoice.ts` (same), `src/compliance/supplier.ts` (the live 42501 defect stays deferred), `src/compliance/receiving.ts` (Story 3.4 physical capture - consume only), `src/compliance/msme.ts` (Story 4.6 - consume only), `src/sync/upload.ts`, `edge/**`, `src/adapters/erp/**` (no ERP surface for scorecard), any `erp_*` table, `src/compliance/ownership.ts`, `src/compliance/planning-jobs.ts`.

### Testing Requirements

- Backend tests use Node's built-in `node:test` through `tsx`. No Jest, no Vitest.
- Integration tests must execute against PostgreSQL, verify response bodies and durable rows, and use run-scoped data instead of relying on test order.
- The test database is configured on port 5442 in the current repository. Use the committed `.env.test` value.
- Assert NUMERIC columns as strings (`'2.500000'`); assert DATE columns via `::text` cast (the standing 4.5 deferral on non-UTC DATE serialization).
- Replay tests must pin row counts and accept the project's documented 201-or-409 surface for idempotent replays.
- Atomicity tests must inject failures after the projection boundary and prove the event, the metric row, and the audit log all roll back together.
- The shape-validation unit test must cover every rejection branch, not just the happy path. The seam rejects malformed UUIDs, nil UUIDs, calendar-date rollovers, oversize NUMERIC, unknown metric_kind, and missing context keys; one test per branch.
- The business-day unit test must cover: same-day, weekend-only, multi-business-day, holiday removal, IST midnight rollover, clock-skew negative. Six test cases minimum.

### Latest Technical Information

- Node 24 LTS remains the runtime as of 2026-08-06. No upgrade to Node 26 Current inside this story.
- PostgreSQL 18.4 remains the project database. Use exact `FOR UPDATE` row locking on the supplier row in the seam; the `metric_id` partial unique index provides the concurrency race guard; the plain-SELECT `alreadyPersisted` provides the idempotency short-circuit.
- The `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` formatting reliably returns `YYYY-MM-DD` for the IST calendar date (locale `en-CA` uses ISO-style date order). The unit test pins this; do not switch to `toLocaleString` which depends on the server's default locale.
- No new npm packages are required. The scorecard uses `node:test`, `node-postgres`, `crypto.randomUUID()`, and the built-in `Intl`. Do not add `date-fns`, `luxon`, `moment`, or `dayjs`.

### Critical Context (Read Before Coding)

- **Epic 8 is not built.** This story does not register `qc.lot_dispositioned`. The seam must have a no-op case for `metricKind === 'quality_acceptance'`. The route `POST /api/v1/.../scorecard/quality-acceptance` is intentionally absent. The API returns `quality_acceptance: { state: 'no_data' }` for any supplier with zero disposition events. Do not invent a placeholder.
- **The seam, not the route, enforces business rules.** Direct `POST /api/v1/events` with a `supplier_scorecard.metric_recorded` event must hit the same supplier-active check, the same metric-kind check, the same calendar-date check, and the same idempotency check as the route. The four write routes in Task 7 are convenience entry points, not enforcement points.
- **The supplier's `site_id` does not exist in the current supplier projection.** Site scoping for the scorecard read endpoint falls back to procurement-module-wide for now, mirroring the 4.7 supplier-invoice fallback at `src/read/projections/supplier_invoice.ts:340-360`. The site-scoped variant is a future story; this one documents the deferral.
- **NUMERIC arithmetic in PostgreSQL, never in JavaScript.** All four metric values cross the wire as strings; the seam's `value_num` parameter is bound as a `text` cast to `NUMERIC`. No `Number()`, no `parseFloat`, no float comparison. The seam's `assertSupplierScorecardShape` validates the NUMERIC-as-string shape (at most 6 decimal places, at most 14 integer digits).
- **The scorecard projection is append-only.** There is no UPDATE in any write path. A correction is a new row with `supersedes_metric_id`. The read view treats the most recent row per `(supplier_id, metric_kind, reference_entity_id)` as authoritative. The partial unique index on `(reference_event_id, metric_kind)` is the replay guard.
- **The `businessDaysBetween` helper is the only source of business-day arithmetic.** No second copy in the seam, in the route, in the read accessor, or in the test. The unit test at `test/unit/business-days.test.ts` is the only correctness oracle.
- **No edge, no offline, no ERP.** The scorecard is a procurement-module read feature with four online write routes. No `src/sync/upload.ts`, no `edge/**`, no `src/adapters/erp/**` changes.
- **The four write routes are thin.** They load the source record, compute the value, and call `persistEvent`. They do not insert into the projection directly; the seam does. They do not re-validate the value; the seam does. They do not enforce supplier-active; the seam does.

### Previous Story Intelligence (4.1, 4.4, 4.5, 4.7)

- Story 4.1 established the supplier registry with `status IN ('onboarding', 'active', 'inactive')`. The scorecard consumes only `active` suppliers; the seam rejects `onboarding` and `inactive` with `SUPPLIER_NOT_ACTIVE` (existing permanent code). The do-not-copy list from 4.1 is critical: do not broadcast-to-role notifications (this story has no notification surface anyway), do not copy the broken `alreadyPersisted` `FOR UPDATE` on `domain_events` from `src/compliance/supplier.ts:272-275` (the 4.4 lesson is the canonical plain-SELECT variant), do not omit integration tests.
- Story 4.4 established the PO event chain (`drafted` to `issued` to `confirmed`) and the `promised_delivery_date` column on the header and lines. The on-time delivery metric consumes the header `promised_delivery_date`; the seam rejects a metric write when the GRN's linked PO has no promised date. Story 4.4's `purchase_order.confirmed` event is the responsiveness trigger; the seam requires `status = 'confirmed'` and both `issued_at` and `confirmed_at` non-null.
- Story 4.5 established the `three_way_match.recorded` event with `variance_detail.lines[].price_variance_pct` (NUMERIC-as-string). The price-variance metric consumes the per-line mean; the seam rejects a metric write when the match has zero lines (which the seam also rejects upstream) or when `status` is not `passed` or `blocked`. Story 4.5's `idempotent-replay` precedent (4.5 review patch) is the model: insert with `ON CONFLICT DO NOTHING` and check the returned rowCount.
- Story 4.7 established the supplier-invoice event chain and the strict calendar-date validation. The scorecard reuses the `assertCalendarDate` helper from `src/compliance/purchase-order.ts` (the strict-rollover variant). Story 4.7's site-scoping fallback at `src/read/projections/supplier_invoice.ts:340-360` is the model for the scorecard read endpoint's site-scoping deferral.
- The four stories together (4.1, 4.4, 4.5, 4.7) provide the upstream event substrate that Story 4.2 consumes. No new event source is created in this story. The only new event in this story is `supplier_scorecard.metric_recorded`, the read-side artifact of the scorecard itself.

### Project Structure Notes

- Canonical SQL lives at the repository root `read/projections/*.sql`, not `src/read/projections/` (the 4.1 story doc cites a nonexistent src path - known doc defect, do not propagate). TypeScript accessors live at `src/read/projections/*.ts`.
- Implementation order is the schema ripple order: canonical SQL, init-db mirror, `migrate.ts`, schema-drift EXPECTED, `schema.ts` interfaces, business-day helper (and its unit test), compliance module, read accessors, REST routes, server registration, spine pin, integration tests, gates.
- LF endings throughout; `git stash` flips to CRLF and breaks schema drift. Avoid stashing; run `git diff --check` before finishing.
- The scorecard's four metrics map to four event subtypes via `metric_kind`. The projection is a single table; the API response is a typed shape with per-metric aggregations. The `quality_acceptance` metric is the first metric to demonstrate the `no_data` first-class response shape; the same shape will be reused for any future "no data yet" metric.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.2` lines 1519-1547 (acceptance criteria and sequencing note)]
- [Source: `_bmad-output/planning-artifacts/epics.md#Epic-4-Goal` lines 377-387 (Epic 4 goal and FR-P-03 reference)]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md#FR-P-03` line 141 (on-time delivery, quality acceptance, price, responsiveness)]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` sections Stack, Event Envelope, Consistency Conventions, AD-3, AD-12, AD-14, AD-16, AD-17]
- [Source: `_bmad-output/implementation-artifacts/4-1-supplier-registry-and-onboarding.md` lines 122-200 (binding implementation decisions, existing components, supplier projection accessors, do-not-copy list)]
- [Source: `_bmad-output/implementation-artifacts/4-4-purchase-order-management.md` lines 80-130 (binding implementation decisions, `alreadyPersisted` precedent, calendar-date helper, PO event chain)]
- [Source: `_bmad-output/implementation-artifacts/4-5-goods-receipt-and-three-way-match.md` lines 30-115 (binding scope decisions, idempotent-replay pattern, no-data precedent, NUMERIC-as-string contract, three-way-match event schema, line-level variance_detail)]
- [Source: `_bmad-output/implementation-artifacts/4-7-supplier-invoice-capture.md` lines 25-150 (binding scope decisions, strict calendar-date validation, supplier site-scoping fallback, NUMERIC-as-string contract)]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` (cross-site-write authorization, idempotency 201-vs-409, DATE serialization on non-UTC servers, supplier site_id deferral)]
- [Source: `_bmad-output/planning-artifacts/ux-designs/.../EXPERIENCE.md` lines 1044-1069 (procurement officer persona and three-way-match UI; no scorecard-specific guidance exists in UX today)]
- [Source: `read/projections/purchase_order.sql` (header and line schema with `promised_delivery_date`, `issued_at`, `confirmed_at`)]
- [Source: `read/projections/grn.sql` (GRN schema with `po_id`, `business_date`, `received_at`, additive `po_id` from Story 4.5)]
- [Source: `read/projections/three_way_match.sql` (`status`, `variance_detail`, `match_id` schema)]
- [Source: `src/events/schema.ts` (event payload interfaces for `purchase_order.confirmed`, `three_way_match.recorded`, `goods.received`)]
- [Source: `src/compliance/purchase-order.ts:264-271` (correct plain-SELECT `alreadyPersisted`)]
- [Source: `src/compliance/supplier.ts:272-275` (broken `FOR UPDATE` on `domain_events` - DO NOT COPY)]
- [Source: `FORMATTING_RULES.md` (markdown formatting rules: hyphens not em dashes, no arrows in prose, no bare `###` dividers, header rows for every table, references for every table)]

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code

### Debug Log References

- `npm run db:migrate` run twice: both passes applied `supplier_scorecard_metric.sql` last and
  completed with "Migration complete." (idempotence proven).
- `test/unit/schema-drift.test.ts`: 60/60 pass with the new EXPECTED entry.
- `test/unit/business-days.test.ts`: 8/8 pass.
- `test/unit/supplier-scorecard-shape.test.ts`: 13/13 pass (every rejection branch).
- `test/integration/story-4-2.test.ts`: 22/22 pass against real PostgreSQL on DB_PORT=5442.
- `npm run build` (tsc): clean. `npm run lint` (eslint): clean. `npm run format:check`: clean
  after prettier write. `git diff --check`: clean (exit 0, only the repo's standing CRLF
  warnings).
- Full suite (`npm test`): 726 tests, 712 pass, 14 fail - all 14 are the documented
  pre-existing idempotency 201-vs-409 replay failures (deferred-work.md); zero new failures.
- `npm run spine-acceptance-contract`: 6/6 pass with the five new routes pinned.
- Edge gates untouched: `edge:typecheck` clean, `edge:lint` clean, `edge:test` 30/30 pass.

### Completion Notes List

- All seven ACs implemented. The seam (`src/compliance/supplier-scorecard.ts`) enforces shape,
  supplier-active, metric-kind, calendar-date, NUMERIC scale and replay idempotency inside
  `persistEvent`; the four write paths are thin conveniences. Quality acceptance has no write
  route and a deliberate no-op applier case; the API returns `{ state: 'no_data' }` (AC2).
- Deviation from Task 5.1 literal text: the algorithm sentence says "inclusive of the start
  date", but the story's own anchor cases (Task 8.5 and Dev Notes: Friday-issued,
  Monday-confirmed = 1 business day; Saturday-to-Monday Sunday-only gap = 0) require counting
  the IST calendar days STRICTLY BETWEEN the two dates. Implemented strict-between; the unit
  test pins the anchor cases.
- Deviation from Task 3.1/AC6 value bound: the story text says "at most 14 integer digits", but
  the column is NUMERIC(14,6) (precision 14 = total digits), where 14 integer digits would
  overflow. The seam accepts at most 8 integer digits so an accepted event can never fail the
  projection INSERT.
- Deviation from the touch list: `src/api/v1/grns.ts` does not exist (Story 4.5 put the GRN
  binding route in `src/api/v1/three-way-match.ts`). All five scorecard handlers live in the new
  `src/api/v1/supplier-scorecards.ts`; the route PATHS match the story spec exactly
  (`POST /api/v1/grns/:grnId/scorecard/on-time`, etc.).
- The AC7 replay guard is a full (not partial) unique index on
  `(reference_event_id, metric_kind)` - there is no meaningful predicate for it; the projection
  also has ON CONFLICT DO NOTHING so a duplicate is a rowCount-0 no-op, never a raw 23505. A
  correction row therefore carries a NEW reference_event_id and points back via
  `supersedes_metric_id` (pinned by the AC7 integration test).
- `getPurchaseOrderById` surfaces DATE as a JS Date (SELECT *); the on-time route reads
  `promised_delivery_date::text` through `getPoPromisedDateText` so the calendar string never
  round-trips through a timezone-dependent Date (the standing 4.5 DATE-serialization deferral).
- Signed price variance: `variance_detail` stores `price_variance_pct` as an absolute value;
  `computeMatchMeanPriceVariance` re-derives the sign in SQL NUMERIC from invoice vs PO unit
  price over matched lines only (`invoice_qty > 0`).
- New config: `config.scorecard.responsivenessHolidayCalendar` from
  `SCORECARD_RESPONSIVENESS_HOLIDAYS` (comma-separated YYYY-MM-DD, default empty).
- Scorecard GET response embeds each trend's `series` alongside the summary aggregates;
  `quality_acceptance` no-data carries no series (first-class shape, AC5 test pins the keys).

### File List

- `read/projections/supplier_scorecard_metric.sql` (NEW)
- `deploy/compose/init-db.sql` (UPDATE - byte-identical mirror appended)
- `src/events/migrate.ts` (UPDATE - MIGRATIONS tail append)
- `src/events/schema.ts` (UPDATE - payload/envelope pair, SUPPORTED_EVENT_TYPES entry, reserved
  qc.lot_dispositioned doc comment)
- `src/events/store.ts` (UPDATE - seam wiring, two blocks)
- `src/config/index.ts` (UPDATE - config.scorecard)
- `src/compliance/supplier-scorecard.ts` (NEW)
- `src/read/projections/supplier_scorecard_metric.ts` (NEW)
- `src/lib/business-days.ts` (NEW)
- `src/api/v1/supplier-scorecards.ts` (NEW - all five scorecard handlers)
- `src/server.ts` (UPDATE - route registration block after the 4.5 block)
- `test/unit/schema-drift.test.ts` (UPDATE - EXPECTED entry)
- `test/integration/story-1-9.test.ts` (UPDATE - allowedSpineRoutes +5)
- `test/integration/story-4-2.test.ts` (NEW)
- `test/unit/business-days.test.ts` (NEW)
- `test/unit/supplier-scorecard-shape.test.ts` (NEW)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (UPDATE)
- `_bmad-output/implementation-artifacts/deferred-work.md` (UPDATE)

## Change Log

- 2026-08-06: Story 4.2 implemented end to end (projection, event, seam, read accessors,
  business-day helper, five routes, spine pin, 43 new tests across three suites). Status moved
  to review.
- 2026-08-07: Adversarial code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor)
  triaged 22 findings into 8 patches (all applied), 1 deferral (ledgered), 13 dismissals. Key
  patches: full seam re-derivation with FOR UPDATE reference-entity resolution and supplier
  correspondence (closes the direct-event fabrication bypass and the route TOCTOU), IST-anchored
  trailing windows and series window, responsiveness reference_event_id resolved to the
  purchase_order.confirmed event, single-source IST conversion, fail-closed holiday calendar
  validation, jsonb_typeof guard plus contributing-line count in the price-variance SQL,
  holiday-removal integration branch, and supersedes_metric_id existence/kind checks with the
  spec-mandated partial unique replay guard and superseded-row exclusion in the summary and
  series. Also hardened the two AC1 tests against the receiving route's server-local
  business_date stamping (anchored to the GRN's actual business_date, not istToday()).
  Integration suite grew from 22 to 28 tests. Gates: build/lint/format clean, migrate x2
  idempotent, partial index verified in the live schema, schema-drift 60/60, story-4-2 28/28,
  shape 13/13, business-days 8/8, spine 6/6, no-hardcoded-role 1/1, edge 30/30, full suite
  732 (718 pass, 14 pre-existing idempotency fails, 0 new). Status moved to done.
