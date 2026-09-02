---
baseline_commit: 3e5ba4941a444bb94c52a38c39497c5873db56f5
---

# Story 9.1: Job-Work Service Order Creation

Status: done

## Story

As a job-work coordinator,
I want to create service orders with customer, spec reference, promised dates, and price basis, linked to a customer-supplied kit BOM, with every change attributed,
so that each job-work engagement is defined and auditable from the start.

## Acceptance Criteria

1. **Given** a customer job-work engagement, **When** a service order is created with customer, spec reference, promised dates, and price basis (FR-JW-01), **Then** the order is created in `Draft` state and links to a kit BOM (FR-B-16).
2. **Given** a Draft service order with a linked kit BOM and a price basis (FR-JW-02), **When** the coordinator confirms the order, **Then** the order transitions to `Confirmed`, transitions to `In Process` on the first customer-material receipt (Story 9.2), and reaches `Closed` only through the Story 9.5 closure gate, with each transition recorded and attributed.
3. **Given** a service order (FR-JW-02), **When** a transition is attempted out of sequence (for example `Draft` directly to `Closed`) or confirmation is attempted without a linked kit BOM and price basis, **Then** the transition is blocked with `error_code: "INVALID_STATE_TRANSITION"`.
4. **Given** any change to a service order, **When** the change is saved, **Then** it is attributed to the user in the non-disableable edit log (FR-AC-13).

Sources: `_bmad-output/planning-artifacts/epics.md#Story-9.1` (lines 2561-2585, quoted verbatim in BDD form), PRD `prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md#4.8`.

## Binding Scope Decisions

The BSD table below fixes decisions the dev agent must not relitigate. Deviations must be disclosed in the Dev Agent Record, never applied silently.

| BSD | Decision |
|-----|----------|
| BSD-1 | New event family `jobwork.*` on a NEW `jobwork` stream type (per ARCHITECTURE-SPINE #AD-6: custody ledger later gets its own stream type; the order document anchors the `jobwork` stream). Events: `jobwork.order_created`, `jobwork.order_updated`, `jobwork.order_confirmed`. Naming per spine #Consistency-Conventions: singular entity, past-tense dot-separated. |
| BSD-2 | This story implements the FULL four-state machine (`draft`, `confirmed`, `in_process`, `closed`) with guards, but exposes ROUTES only for create, update, confirm. The `in_process` transition is applier-level machinery invoked by Story 9.2 (first customer-material receipt); `closed` is reachable only through the Story 9.5 closure gate. Do NOT add routes for those transitions now; DO make the applier transitions exist and be guard-tested (out-of-sequence attempts refuse with `INVALID_STATE_TRANSITION`). |
| BSD-3 | Confirm gate requires: linked kit BOM present AND price basis present, else 409 `INVALID_STATE_TRANSITION` (per AC 3, which folds the missing-precondition case into the same code). Kit BOM link must reference an existing BOM with `bom_type = 'job_work_kit'` (Story 5.6 machinery, `read/projections/bom.sql`); reuse the referential-guard-at-create pattern of `src/compliance/purchase-order.ts:335-352`. |
| BSD-4 | Customer reference: there is no customer master table in this system. The order carries `customer_party_code` (governed short-code, regex-validated like `supplier.owner_party_code`, see `read/projections/supplier.sql:48`) plus `customer_name`. Do not invent a customer master table; Story 9.2/9.3 key custody by (customer, order). Disclose this in Dev Notes as the AC's "customer" field resolution. |
| BSD-5 | `INVALID_STATE_TRANSITION` is a NEW stable error code (not yet in spine #API-Contract list, line 337). Register it in the per-file `AUDITED_REJECTIONS` set of the new route file (8.3 `NCR_EXISTS` omission lesson) and in `src/sync/upload.ts` `PERMANENT_ERROR_CODES` if applicable. |
| BSD-6 | Confirm payload must be forward-extensible for Story 9.4's offcut election: epics.md 9.4 dev note says "the offcut-election capture AC extends the Story 9.1 `Confirm` transition - implement it inside the Story 9.1 confirmation flow, not as a separate later step." In 9.1, accept and persist an OPTIONAL `offcut_election` field (`return`, `retain_and_buy`, `retain_free`, or absent) on confirm, stored on the projection, no behavior attached. 9.4 will make it mandatory and act on it. |
| BSD-7 | Business stream tagging: order events carry business stream `job-work` (FR-AC-01, Story 1.5 machinery). Site scoping: `site_id` required UUID on the order payload, same as purchase order (`src/compliance/purchase-order.ts:175`). |
| BSD-8 | Projection `service_order` (singular, snake_case): canonical DDL in `read/projections/service_order.sql`, byte-identical mirror in `deploy/compose/init-db.sql` (use LF in canonical file; known CRLF drift issue), registered tail-append in `src/events/migrate.ts` MIGRATIONS, added to `test/unit/schema-drift.test.ts` EXPECTED list. |
| BSD-9 | Edit-log attribution (AC 4) uses the existing Story 1.3 statutory edit-log middleware; every mutating route goes through it with `trace_id`. No bespoke audit table. Updates emit `jobwork.order_updated` with changed-field payload so attribution is event-sourced as well. |
| BSD-10 | IDs minted before persistence (replay-safety house rule, `src/events/schema.ts:3475`). `service_order_id` is UUIDv4 minted client-side of the transaction; external references use `_ext` suffix fields (spec reference as `spec_reference_ext`). |

## Tasks / Subtasks

- [x] Task 1: Event schema (AC: 1, 2, 4)
  - [x] 1.1 Add typed payload interfaces for `jobwork.order_created`, `jobwork.order_updated`, `jobwork.order_confirmed` in `src/events/schema.ts`; tail-append to `SUPPORTED_EVENT_TYPES` (schema.ts:4408) in a new Epic 9 block.
  - [x] 1.2 Register the `jobwork` stream type wherever stream types are enumerated (mirror how `procurement` is recognized in `src/compliance/purchase-order.ts:87`).
- [x] Task 2: Compliance seam `src/compliance/service-order.ts` (AC: 1, 2, 3)
  - [x] 2.1 Pre-transaction shape asserts (malformed events never consume an idempotency key; pattern at `src/events/store.ts:482-620`).
  - [x] 2.2 State machine in the applier: create only into `draft`; confirm requires `draft` + kit BOM + price basis; `in_process` only from `confirmed`; `closed` transition exists but refuses unless invoked by the (future) 9.5 closure gate marker - for now every direct attempt refuses `INVALID_STATE_TRANSITION`.
  - [x] 2.3 Referential guards at create: kit BOM exists with `bom_type = 'job_work_kit'`; `site_id` valid; `pg_advisory_xact_lock` keyed by `service_order_id` for transition serialization (lock-order comment discipline per `src/compliance/quality.ts:161-163`).
  - [x] 2.4 Wire applier dispatch in `src/events/store.ts` (mirror `applyPurchaseOrderProjection` import and invocation, store.ts:102 and :955).
- [x] Task 3: Projection (AC: 1, 2)
  - [x] 3.1 `read/projections/service_order.sql`: PK `service_order_id`, `order_number_ext` (unique per site), `customer_party_code`, `customer_name`, `spec_reference_ext`, `promised_start_date`/`promised_delivery_date` (DATE, IST business dates), `price_basis` (JSONB or typed columns per epics FR-JW-01), `kit_bom_id` FK-shaped reference, `status` CHECK (`draft`,`confirmed`,`in_process`,`closed`), `offcut_election` nullable CHECK (`return`,`retain_and_buy`,`retain_free`), `site_id`, `business_stream`, confirm/close attribution columns, timestamps. Fully idempotent DDL (IF NOT EXISTS plus guarded DO blocks).
  - [x] 3.2 TS accessor `src/read/projections/service_order.ts` (get by id, list with site scope, insert, update-status functions).
  - [x] 3.3 Mirror into `deploy/compose/init-db.sql`; add to schema-drift EXPECTED; register in `src/events/migrate.ts`.
- [x] Task 4: Routes `src/api/v1/service-orders.ts` (AC: 1, 2, 3, 4)
  - [x] 4.1 `POST /api/v1/service-orders` (create draft), `PATCH /api/v1/service-orders/:id` (update draft fields, emits `order_updated`), `POST /api/v1/service-orders/:id/confirm`, `GET /api/v1/service-orders/:id`, `GET /api/v1/service-orders` (list, site-scoped). RBAC via `requireRole` and `permittedLocationsForModuleScope` (pattern `src/api/v1/purchase-orders.ts:10`).
  - [x] 4.2 `rejectUnacceptedFields` symmetric on all mutating routes (8.8 lesson). Idempotency key accepted on mutating routes (#AD-16). Error envelope `{ error_code, message, details, trace_id }`.
  - [x] 4.3 Mount in `src/server.ts` `createAppRouter`; add ALL new routes to spine allowlist in `test/integration/story-1-9.test.ts` (8.6 found 11 missing routes as red).
  - [x] 4.4 Register `INVALID_STATE_TRANSITION` per BSD-5.
- [x] Task 5: Integration tests `test/integration/story-9-1.test.ts` (AC: all)
  - [x] 5.1 Copy structure of `story-8-7.test.ts` / `story-2-8.test.ts` (node:test, local envelope builder, run-scoped identifiers, admin pool for fixtures since app_user lacks DELETE).
  - [x] 5.2 Cover: draft create with kit BOM link; confirm happy path with attribution asserted; confirm refusal without kit BOM; confirm refusal without price basis; draft-to-closed refusal; double-confirm refusal; update attribution in edit log; idempotent replay of confirm (same idempotency key returns stored result, no second transition); optional `offcut_election` persisted on confirm.
- [x] Task 6: Unit tests plus mutation verification (AC: 3)
  - [x] 6.1 State-machine predicate takes current status and target as PARAMETERS (8.4 tautological-config lesson) so unit tests can fail.
  - [x] 6.2 Mutation-verify the confirm guard and the out-of-sequence guard at TWO points (seam and route; route pre-checks can mask seam-only mutants, 8.6 lesson): invert or delete each, confirm tests fail, restore.
- [x] Task 7: Gates (AC: all)
  - [x] 7.1 `npm run db:migrate` twice against docker `ims-postgres-test` port 5442 (migrate-twice idempotency; narrow-guard lesson from 8.5).
  - [x] 7.2 Typecheck clean; full suite with zero NEW failures against the pre-existing noise floor (approximately 26-30, including 3 CRLF schema-drift artifacts and the story-7-8 parallel-edge flake).
  - [x] 7.3 Update `sprint-status.yaml` and this file's Dev Agent Record.

### Review Findings

- [x] [Review][Patch] AC1 vs implementation: kit BOM/price basis optional at create — AC1 literal text says a service order "links to a kit BOM" on create; implementation allowed both `kit_bom_id` and `price_basis` to be unset. Resolved: require both at create (`assertOrderCreatedShape`); AC3's "confirm without kit BOM/price basis" refusal path stays reachable via the existing update route clearing them on a draft before confirm. [src/compliance/service-order.ts:237-249]
- [x] [Review][Patch] No site-scoped write authorization on create/update/confirm routes — routes use plain `requireRole({module:'jobwork', functionScope:'write'})` with no `locationId` resolver, unlike the codebase's own generic `/api/v1/events` route (`resolveLocationFromBody`). An actor with jobwork-write for one site can create/update/confirm orders at any other site. [src/api/v1/service-orders.ts:401-414]
- [x] [Review][Patch] `business_stream` never validated in the seam — `assertOrderCreatedShape` checks other fields but not `business_stream`, which is persisted verbatim; reachable via the generic `/api/v1/events` route since REST-layer field-stripping doesn't apply there. [src/compliance/service-order.ts:237-249,396]
- [x] [Review][Patch] `site_id` referential check accepts any `location_register` row — no `level = 'site'` / `active` filter, so a zone/bin/dock location_id is silently accepted as a site. [src/compliance/service-order.ts:358-360]
- [x] [Review][Patch] GET-by-id leaks order existence via 404-vs-403 — fetches the row before `assertSiteReadAccess`, letting a caller distinguish "no such order" from "exists, no access." [src/api/v1/service-orders.ts:321-336]
- [x] [Review][Patch] Order-number year derived from client-supplied `occurred_at`, unbounded — no plausibility check against server wall-clock time, so a caller can mint a `SO-{year}-…` number under a misleading year. [src/compliance/service-order.ts:372-381]
- [x] [Review][Patch] `23505` catch in `applyOrderCreated` swallows any unique violation as "already applied" without checking which constraint fired (PK vs `uq_service_order_number_site`). [src/compliance/service-order.ts:383-408]
- [x] [Review][Patch] Cross-field date check (`delivery >= start`) is skipped when an update payload changes only one of the two date fields, since the check only fires when both are present in the same payload. [src/compliance/service-order.ts:212-223]
- [x] [Review][Patch] `price_basis.currency` accepts any non-empty string — no ISO-4217 or fixed-vocabulary check. [src/compliance/service-order.ts:80-89]
- [x] [Review][Patch] No closed-shape check on the outer event payload — unknown extra keys pass through silently, inconsistent with `isValidPriceBasis`'s strict `Object.keys(p).length === 3` check. [src/compliance/service-order.ts:237-278]

## Dev Notes

### Architecture patterns and constraints

- Event-sourced: state changes only via events; projections are derived state written in the SAME transaction as the `domain_events` insert (canonical comment `read/projections/supplier.sql:1-15`). Envelope shape at `src/events/store.ts:262`; `uq_stream_version` and `uq_idempotency` on `events/domain_events.sql:13-14`.
- Closest analog is the purchase order stack: events `purchase_order.drafted/approved/issued` (`src/events/schema.ts:977` onward), seam `src/compliance/purchase-order.ts` (state machine in applier :392-797, referential guards :335-352), routes `src/api/v1/purchase-orders.ts`. Mirror this structure for the service order; the lifecycle here is simpler (no DOA approval chain in 9.1 - confirmation is a coordinator action, not a DOA-resolved approval).
- Spine bindings: #AD-6 (custody non-valuated, segregated; order cannot close with non-zero custody - enforced in 9.5, but the `closed` guard here must stay closed until 9.5 provides the gate), #AD-14 (modules read only via shared projections), #AD-16 (idempotency keys on edge commands), #Consistency-Conventions (UTC timestamps plus IST `business_date`; IST calendar arithmetic, never JS Date diffs).
- Downstream contract awareness: Story 9.2 receives customer material ONLY against a `confirmed` order and fires the `in_process` transition; 9.4 extends confirm with mandatory offcut election (BSD-6 keeps the field optional now); 9.5 owns closure; QC customer-override inspection plans already accept `source_order_type: 'job_work_order'` plus `source_order_ref` (`src/events/schema.ts:3488`) - the order's `order_number_ext` should be a string that can satisfy `source_order_ref`.
- `stock_class` already includes `job_work` (`src/events/schema.ts:381`) and kit BOM machinery exists from Story 5.6 (`bom_type 'job_work_kit'`, `bom.job_work_kit_tagged` at schema.ts:2011, `supply_source` per line at :1995). Do not rebuild any of it; 9.1 only references the BOM.

### Previous story intelligence (Epic 8 closeout)

- Hold-bypass defect class recurred in 8.3, 8.4, 8.5, 8.8: any applier acting on shared state must re-derive that state under a FOR UPDATE lock inside the transaction, fail-closed. Here that means the transition applier re-reads current `status` under the advisory lock, never trusts route pre-checks.
- Idempotency pre-checks tripping on their own writes: stand down via `findEventByIdempotencyKey` (8.7 lesson).
- Every refusal code emitted by a route file must be in that file's `AUDITED_REJECTIONS` set.
- Tests must be able to fail: no asserting config against itself; predicates parameterized; mutation-check as an explicit task.
- Story commit shape: one commit with src, canonical SQL, init-db mirror, story test, drift and spine pins, story md, sprint-status, deferred-work updates (see 3e5ba49).

### Project structure notes

- New files: `src/compliance/service-order.ts`, `src/api/v1/service-orders.ts`, `read/projections/service_order.sql`, `src/read/projections/service_order.ts`, `test/integration/story-9-1.test.ts`, unit test file.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `src/server.ts`, `deploy/compose/init-db.sql`, `test/integration/story-1-9.test.ts` (spine allowlist), `test/unit/schema-drift.test.ts`, possibly `src/sync/upload.ts`.
- The architecture spine names a `jobwork/` module directory; this repo's established convention is domain modules under `src/compliance/` - follow the repo convention (spine #Structural-Seed is satisfied by the seam module; disclose as a deliberate variance).

### Testing standards summary

- node:test via `npm test`, `--test-concurrency=1`, real Postgres (docker `ims-postgres-test`, port 5442), real `createAppRouter`, SCIM provisioning plus dev-token auth, no shared fixture module, admin pool for fixture writes and TRUNCATEs (app_user lacks DELETE).
- Migrate twice before the suite. Zero new full-suite failures versus baseline 3e5ba49 noise floor.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic-9] (epic goal line 2557, Story 9.1 lines 2561-2585, 9.4 dev note constraining Confirm)
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-6, #Capability-Map line 262, #Consistency-Conventions line 172, #API-Contract line 328, #Event-Envelope line 278]
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md#4.8-Job-Work-Services, FR-JW-01, FR-JW-02, FR-B-16, FR-AC-13]
- [Source: src/compliance/purchase-order.ts, src/events/store.ts, src/events/migrate.ts, read/projections/supplier.sql, test/integration/story-8-8.test.ts]
- [Source: _bmad-output/implementation-artifacts/8-8-witnessed-inspections-and-prototype-stock-rules.md#Dev-Agent-Record]

## Open Questions (defaults chosen, dev may proceed)

1. Price basis shape: FR-JW-01 does not enumerate fields. Default: JSONB `price_basis` with required non-empty `basis_type` (`per_piece`, `per_kg`, `per_hour`, `lumpsum`) plus `rate` and `currency`; 9.6 billing feed consumes it. A CHECK on `basis_type` follows the 8.8 pattern (a 4th value is a migration).
2. Whether `PATCH` on a `confirmed` order is allowed. Default: draft-only field edits; post-confirm changes are out of 9.1 scope (amendment flow is not in any Epic 9 AC), refuse with `INVALID_STATE_TRANSITION`.
3. Order number: default mint `order_number_ext` server-side as a site-scoped sequential string (mirrors existing document-number conventions); if a different convention exists in `src/compliance/purchase-order.ts`, follow it.

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code, 2026-09-02.

### Debug Log References

- Typecheck: `npx tsc --noEmit` clean. Lint: `npx eslint` on all new files, exit 0. Prettier applied.
- `npm run db:migrate` run twice against docker `ims-postgres-test` (port 5442): both passes clean, `service_order.sql` applied idempotently (Task 7.1).
- Story tests: 27/27 (test/unit/service-order-predicates.test.ts + test/integration/story-9-1.test.ts).
- Full suite (Task 7.2): 1667/1698, 31 failures - identical count and families as baseline 3e5ba49 noise floor (3 CRLF schema-drift artifacts incl. gate_dwell_metric/label_master/compliance_bis_licence, the idempotency/DUPLICATE_EVENT family, stories 1-1/1-6/1-7/2-1..2-8/3-6/3-10). ZERO new failures; story-9-1 and service-order-predicates both green in-suite.
- Mutation verification (Task 6.2), all four mutants KILLED and restored:
  1. Seam confirm guard disabled (`if (false)`) - 4 failures.
  2. Predicate `confirmed` arm drops kit-BOM/price-basis inputs - 4 failures (unit + integration).
  3. Predicate `closed` arm returns true unconditionally - 4 failures.
  4. `transitionServiceOrder` out-of-sequence guard disabled - 1 failure; PATCH draft-only guard disabled - 1 failure.

### Completion Notes List

- All 4 ACs implemented. Event family `jobwork.order_created/updated/confirmed` on new `jobwork` stream; full four-state machine in `serviceOrderTransitionAllowed(current, target, ctx)` (parameterized predicate, 8.4 lesson); `in_process`/`closed` transitions exist as applier-level `transitionServiceOrder()` for Stories 9.2/9.5, no routes (BSD-2). Confirm applier re-derives status + gate inputs under `pg_advisory_xact_lock` + `FOR UPDATE` (Epic 8 hold-bypass lesson); direct POST /api/v1/events cannot bypass (tested).
- **Deviation 1 (BSD-5)**: `INVALID_STATE_TRANSITION` is NOT a new code - it already exists (Epic 6 production orders, `src/api/v1/production-orders.ts` et al.) and is ALREADY in `src/sync/upload.ts` `PERMANENT_ERROR_CODES` (line 193). No upload.ts change; it IS registered in this route file's `AUDITED_REJECTIONS`.
- **Deviation 2 (BSD-7)**: story says business stream `job-work`; the governed vocabulary in `read/projections/business_stream_config.sql` is `job_work` (code) / `Job-Work` (label). Used `job_work`. `jobwork.order_created` is `requiresBusinessStream: true` (indent.raised precedent); update/confirm false (row holds tag).
- **Deviation 3 (AC1 vs AC3 tension)**: create accepts kit_bom_id and price_basis OPTIONALLY (partial draft), because AC3 requires "confirmation attempted without a linked kit BOM / price basis" to be reachable. When supplied at create, the kit BOM referential guard (bom_type `job_work_kit`, BSD-3) runs at create; the confirm gate re-verifies both (including bom_type re-check at confirm).
- BSD-4 as disclosed: no customer master; `customer_party_code` regex `^[A-Z0-9][A-Z0-9-]{1,31}$` (supplier.owner_party_code pattern) + `customer_name`.
- Open question defaults applied: (1) JSONB `price_basis` {basis_type per_piece|per_kg|per_hour|lumpsum, rate, currency}, seam-enforced (exact-3-keys shape), no SQL CHECK on basis_type since FR-JW-01 leaves vocabulary open; (2) PATCH is draft-only, refuses `INVALID_STATE_TRANSITION` on confirmed; (3) `order_number_ext` server-minted `SO-<year>-<seq>` per `service_order_number_seq` (PO convention), unique per (order_number_ext, site_id) so it can serve QC `source_order_ref`.
- Spine variance (per Dev Notes): seam lives in `src/compliance/service-order.ts`, not a `jobwork/` module directory - repo convention.
- Routes require client-supplied `idempotency_key` (8.7 D8 rule); `rejectUnacceptedFields` symmetric on all mutating routes; replay returns 200 with the stored event_id (house idiom).
- Edit-log (AC 4): every mutating route passes `auditCtxFor` to persistEvent (Story 1.3 middleware); refusals in `AUDITED_REJECTIONS` audited fail-safe; tested (audit row keyed by event_id with user + trace_id, and INVALID_STATE_TRANSITION refusal audited).

### File List

- src/compliance/service-order.ts (new - seam: shape asserts, state machine, appliers, transitionServiceOrder)
- src/api/v1/service-orders.ts (new - 5 routes)
- src/read/projections/service_order.ts (new - accessor)
- read/projections/service_order.sql (new - canonical DDL, LF)
- test/integration/story-9-1.test.ts (new)
- test/unit/service-order-predicates.test.ts (new)
- src/events/schema.ts (modified - payload interfaces + 3 SUPPORTED_EVENT_TYPES entries)
- src/events/store.ts (modified - assertServiceOrderShape + applyServiceOrderProjection wiring)
- src/events/migrate.ts (modified - service_order.sql tail-append)
- src/server.ts (modified - 5 route mounts)
- deploy/compose/init-db.sql (modified - mirrored service_order DDL)
- test/unit/schema-drift.test.ts (modified - service_order EXPECTED entry)
- test/integration/story-1-9.test.ts (modified - 5 spine-allowlist routes)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified)

## Change Log

- 2026-09-02: Story 9.1 implemented (events, seam, projection, routes, tests); 27/27 story tests, 4 mutants killed, migrate-twice clean, typecheck/lint clean. 3 disclosed deviations (INVALID_STATE_TRANSITION pre-existing; business stream code job_work; optional kit BOM/price basis at create so the AC3 confirm gate is reachable).
