---
baseline_commit: e030403
---

# Story 2.8: Consignment and VMI Stock Segregation

Status: done

## Story

As a finance controller,
I want consignment and VMI stock held at our locations tracked separately from owned inventory with no commingling of quantities or values,
So that consignment stock never appears in our balance sheet and VMI replenishment signals route to the correct owner.

Covers FR-I-10 ("Consignment and VMI stock segregated from owned inventory"). Epic 2 goal text: "Consignment and VMI stock is segregated from owned inventory" [Source: _bmad-output/planning-artifacts/epics.md:353].

## Acceptance Criteria

1. **Given** a consignment receipt event is posted for 100 units of `RM-0099` from supplier `SUP-007`
   **When** the stock balance is queried
   **Then** the 100 units appear under `stock_class: "consignment"` with the supplier reference; the owned on-hand balance for `RM-0099` is unchanged

2. **Given** an issue transaction is raised for `RM-0099` without specifying `stock_class`
   **When** the event handler processes it
   **Then** it draws from owned stock only; consignment stock is not allocated unless `stock_class: "consignment"` is explicit in the command

3. **Given** VMI stock for `RM-0099` falls below the agreed VMI minimum
   **When** the VMI check runs
   **Then** a replenishment event with `signal_type: "vmi_replenishment"` carrying the owner-party supplier reference is generated and visible in the replenishment exception queue - not a standard internal purchase requisition; transmission to the supplier channel arrives with the supplier registry (Epic 4, Story 4.1)

4. **Given** 100 consignment units and 40 owned units of `RM-0099` are on hand
   **When** `GET /api/v1/stock/RM-0099/valuation` is called
   **Then** the carrying value covers only the 40 owned units; the 100 consignment units contribute zero to owned inventory value and are reported in a separate consignment quantity section

5. **Given** consignment on-hand for `RM-0099` is 100 units
   **When** an issue with `stock_class: "consignment"` for 120 units is submitted
   **Then** the write is rejected with `error_code: "INSUFFICIENT_STOCK"` scoped to the consignment stock class - owned stock is never drawn to cover a consignment shortfall

**Note (owner-party references before Epic 4):** Supplier references on consignment and VMI records are owner-party codes validated against supplier references appearing on ERP inbound projections (Story 2.9) - not free text. VMI agreement minimums are SKU-location configuration owned by this story; the governed supplier registry (Epic 4, Story 4.1) supersedes these codes without renumbering them. Because Story 2.9 is not yet built, this story validates owner-party codes against its own ownership-agreement registry (see Dev Notes); Story 2.9 tightens agreement creation with referential validation later.

## Tasks / Subtasks

- [x] Task 1: Ownership agreement registry (AC: 1, 3)
  - [x] 1.1 Create `read/projections/ownership_agreement.sql`: SKU-location-class config table with `agreement_id UUID PK`, `sku`, `location_id`, `stock_class` (only `consignment` or `vmi`), `owner_party_code TEXT NOT NULL`, `vmi_min_qty NUMERIC(14,3) NULL` (required when `stock_class = 'vmi'`, must be `> 0`), `active BOOLEAN`, timestamps; partial unique index enforcing at most ONE active agreement per `(sku, location_id, stock_class)`; guarded grants in idempotent `DO $$` block matching existing projection files
  - [x] 1.2 New event `ownership.agreement_set` (`stream_type: "inventory"`) with payload shape assert (owner-party code format: trimmed, uppercase alphanumeric plus hyphen, 2-32 chars, non-empty; `vmi_min_qty` bounds matching NUMERIC(14,3) precision); projection upsert preserves omitted fields on partial edits (2.7 review lesson)
  - [x] 1.3 Admin API: `GET /api/v1/ownership-agreements` (list, location-scoped) and `PUT /api/v1/ownership-agreements/:sku/:locationId/:stockClass` (upsert via event) with role allowlist and write-location access check
  - [x] 1.4 Register DDL in `src/events/migrate.ts` MIGRATIONS array; mirror byte-for-byte into `deploy/compose/init-db.sql` WITHOUT touching the `powersync_publication` block; add table to `test/unit/schema-drift.test.ts` EXPECTED list
- [x] Task 2: Consignment/VMI receipt and issue contract enforcement (AC: 1, 2, 5)
  - [x] 2.1 Extend `assertStockBalanceShape` in `src/compliance/stock-balance.ts`: when `stock.received` carries `stock_class` of `consignment` or `vmi`, require `owner_party_code` in payload matching the single active agreement for that SKU+location+class (reject with `OWNERSHIP_AGREEMENT_NOT_FOUND` when none, `OWNER_PARTY_MISMATCH` when code differs); `job_work` class receipts remain out of scope here (Epic 9 owns that flow) and continue current behavior
  - [x] 2.2 Verify and lock in with tests (no behavior change expected): issues without `stock_class` draw owned only (existing default at src/compliance/stock-balance.ts:182); class-scoped availability check yields `INSUFFICIENT_STOCK` per class grain with zero cross-class draw
  - [x] 2.3 Enforce the same payload validation on direct `POST /api/v1/events` and edge upload paths (2.7 review lesson: both bypass HTTP handlers)
- [x] Task 3: Per-class stock API breakdown (AC: 1) - closes 2.2 deferred item [src/api/v1/stock.ts:47-63]
  - [x] 3.1 `GET /api/v1/stock/:sku` response: replace merged-across-class totals with per-class breakdown section (`owned`, `consignment`, `vmi`, `job_work`), each with on_hand/allocated/available; consignment and vmi entries include `owner_party_code` resolved from the active agreement; keep existing top-level owned figures backward compatible for 2.2 consumers
  - [x] 3.2 Extend `test/integration/story-2-2.test.ts` regression coverage to pin the preserved owned top-level shape
- [x] Task 4: Valuation consignment quantity section (AC: 4)
  - [x] 4.1 `GET /api/v1/stock/:sku/valuation` (existing route in `src/api/v1/valuation.ts`): carrying value continues to cover owned units only (existing gate at src/compliance/inventory-valuation.ts:196-198 - do NOT modify the seam); add a `non_owned_quantities` response section listing consignment and vmi quantities with owner-party references, each contributing zero value
  - [x] 4.2 Regression: valuation projections and NRV flows byte-for-byte unaffected for owned stock
- [x] Task 5: VMI replenishment check and signal (AC: 3)
  - [x] 5.1 Extend `replenishment_recommendation` table: add `signal_type TEXT NOT NULL DEFAULT 'internal'` and `owner_party_code TEXT NULL`; extend the open-recommendation partial unique guard to `(sku, location_id, signal_type)` so one open internal AND one open vmi signal can coexist without conflict; canonical SQL + init-db mirror + drift guard updated
  - [x] 5.2 Extend `replenishment.recommended` event payload with optional `signal_type` (default `internal`) and `owner_party_code` (required when `signal_type = 'vmi_replenishment'`); shape assert rejects unknown signal types
  - [x] 5.3 New `runVmiReplenishmentCheck` in `src/compliance/planning-jobs.ts` mirroring `runReplenishmentCheck`: scan `stock_balance` rows with `stock_class = 'vmi'` against active vmi agreements' `vmi_min_qty`; below-minimum grains emit `replenishment.recommended` with `signal_type: "vmi_replenishment"` and the agreement's owner-party code; FOR UPDATE serialization and single-open-signal guard per grain; SQL NUMERIC comparison, never JS floats; transactional planner alert via `emitNotificationInTransaction` (src/notify/emit.ts:103)
  - [x] 5.4 POST synthetic trigger endpoint following 2.7 planning-jobs pattern; existing replenishment queue list endpoint gains `signal_type` filter param; vmi signals visible in the same exception queue (AC3: queue visibility, no purchase requisition, no supplier transmission)
  - [x] 5.5 Guard: internal reorder check (`runReplenishmentCheck`) continues owned-only (src/compliance/planning-jobs.ts:160,297) and never emits vmi signals; vmi check never reads owned balances
- [x] Task 6: Stable errors, edge sync, i18n (AC: 1, 3, 5)
  - [x] 6.1 New codes: `OWNERSHIP_AGREEMENT_NOT_FOUND`, `OWNER_PARTY_MISMATCH`, `VMI_MIN_NOT_CONFIGURED`, `INVALID_SIGNAL_TYPE`; add permanent-business-rejection members to `PERMANENT_ERROR_CODES` in `src/sync/upload.ts:17-42` AND `edge/src/sync/connector.ts` (settle as `needs_attention`) AND `edge/src/messages/en.json`, with tests in `test/unit/sync-upload.test.ts` and `edge/test/unit/connector.test.ts` - all four surfaces in one change
  - [x] 6.2 `INSUFFICIENT_STOCK` stays the code for AC5 (already class-scoped by grain); do not mint a class-specific variant
- [x] Task 7: RBAC and location scoping (all ACs)
  - [x] 7.1 All new routes use `requireRole` + `permittedLocationsForModule` (src/middleware/rbac.ts:11,61); write ops check WRITE-location access, not read-or-write (2.7 review lesson); wildcard actors see all locations
  - [x] 7.2 Direct event path (`src/api/v1/events.ts`) and edge upload (`src/api/v1/edge.ts`) RBAC-check `payload.location_id` for `ownership.agreement_set` and vmi-signal events (2.7 review patch pattern in commit e030403)
  - [x] 7.3 Roles: agreement config write and vmi trigger follow the 2.7 planning-params allowlist; valuation and per-class value views stay restricted to the finance-column roles (access matrix line 171). Note: access matrix has no FR-I-10 row - record chosen allowlists in Dev Agent Record for later matrix sync
- [x] Task 8: Regression guards (all ACs)
  - [x] 8.1 `test/integration/story-1-9.test.ts` route-surface allowlist updated with exact new routes; spine gate 6/6 stays green
  - [x] 8.2 `test/integration/story-2-7.test.ts` owned-only planning filters unaffected (internal recommendations get `signal_type = 'internal'` via column default; existing open-guard behavior preserved for internal signals)
  - [x] 8.3 `test/unit/schema-drift.test.ts` entries for `ownership_agreement` and altered `replenishment_recommendation`
- [x] Task 9: Integration tests `test/integration/story-2-8.test.ts` (all ACs)
  - [x] 9.1 AC1: consignment receipt for `RM-0099` from `SUP-007` visible under consignment class with owner reference, owned unchanged; receipt without agreement rejected; wrong owner code rejected
  - [x] 9.2 AC2: classless issue draws owned only, leaves consignment intact
  - [x] 9.3 AC3: vmi balance below minimum produces `vmi_replenishment` signal with owner-party code in queue; at-or-above minimum produces none; single-open-signal guard under concurrent checks; internal and vmi open signals coexist
  - [x] 9.4 AC4: valuation response values 40 owned units only; 100 consignment units in non-owned section at zero value
  - [x] 9.5 AC5: consignment issue of 120 against 100 rejected `INSUFFICIENT_STOCK`; owned untouched
  - [x] 9.6 Idempotency (duplicate event_id), RBAC denial, edge-path parity, agreement partial-edit preservation
- [x] Task 10: Verification battery
  - [x] 10.1 `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test`, `npm run spine-acceptance-contract`, `git diff --check` - all clean; record counts in Dev Agent Record

### Review Findings

- [x] [Review][Patch] Top-level stock totals must become owned-only; supplier-owned quantities stay in `classes[]` and `consolidated_by_class` [src/api/v1/stock.ts:80]
- [x] [Review][Patch] VMI agreements can be active without the required `vmi_min_qty` [src/compliance/ownership.ts:88]
- [x] [Review][Patch] Transfer `in_transit` updates are not scoped to `stock_class = 'owned'` [src/compliance/transfer-request.ts:352]
- [x] [Review][Patch] Ownership agreements can target nonexistent or inactive locations [src/compliance/ownership.ts:77]
- [x] [Review][Patch] Racing ownership agreement creates surface as an unmapped 23505 or HTTP 500 [src/events/store.ts:322]
- [x] [Review][Patch] Direct event and edge upload paths bypass the ownership write-role allowlist [src/api/v1/events.ts:75]
- [x] [Review][Patch] `GET /api/v1/ownership-agreements` lacks the specified planning-config role allowlist [src/api/v1/ownership-agreements.ts:226]
- [x] [Review][Patch] VMI open-signal refresh compares SQL NUMERIC values as JavaScript floats [src/compliance/planning-jobs.ts:470]
- [x] [Review][Patch] Class-scoped availability gates compare SQL NUMERIC totals as JavaScript floats [src/read/projections/stock_balance.ts:172]
- [x] [Review][Patch] Receipt owner-party validation reads the active agreement without `FOR UPDATE` [src/compliance/ownership.ts:164]
- [x] [Review][Patch] VMI below-minimum check does not lock matching `stock_balance` rows before deciding [src/compliance/planning-jobs.ts:449]
- [x] [Review][Patch] `vmi_min_qty` precision differs from the story contract [read/projections/ownership_agreement.sql:26]
- [x] [Review][Patch] Owner-party codes are not trimmed before validation and persistence [src/compliance/ownership.ts:83]
- [x] [Review][Patch] Concurrent VMI single-open-signal behavior is claimed but not tested [test/integration/story-2-8.test.ts:469]
- [x] [Review][Patch] Stock and valuation owner-agreement lookups are not narrowed to visible locations [src/api/v1/stock.ts:62]

## Dev Notes

### Epic Context

Epic 2 ("Core Inventory and Multi-Location Stock Visibility") closes with 2.8 and 2.9. Story 2.8 is the FR-I-10 ownership-segregation story. Story 2.9 (next) delivers read-only ERP inbound projections; it owns no VMI logic - VMI minimums and the replenishment signal are 2.8's. Epic 9 later adds the customer-owned `job_work` custody flow (`CROSS_ISSUE_BLOCKED` semantics) - NOT this story. FR-GP-13 (Phase 2) later rides returnable packaging on the consignment class - no work here.

**Definitional note:** the original SCM requirements doc (PLANNING/archive/SCM-Requirements-Document.md:75) defines consignment as customer-owned at our site and VMI as our stock at customer sites. The epics file and the 2026-07-11 sprint-change proposal (authoritative, BDD-hardened) model BOTH classes as supplier-owned stock held at OUR locations: `consignment` = supplier-owned awaiting consumption, `vmi` = supplier-managed with agreed minimums. Implement the epics model. Do not build customer-site tracking.

### Architecture Compliance

- Event-sourced write path: everything mutates through `persistEvent` (src/events/store.ts:161). No direct table writes outside projections.
- Seam order: pre-transaction shape asserts (store.ts:173-203, currently ending with `assertInventoryPlanningShape`); in-transaction projection applies (store.ts:223-246, ending with `applyInventoryPlanningProjection`); then domain_events insert, `assertLocationInvariant`, audit. New ownership seam: `src/compliance/ownership.ts` exporting `assertOwnershipShape()` (wired after line 203) and `applyOwnershipProjection()` (wired among lines 223-246). Gate narrowly on `stream_type: "inventory"` plus the exact new event types so all prior streams are byte-for-byte unaffected and the Story 1.9 spine gate stays green.
- Consignment/vmi enforcement on `stock.received`/`stock.issued` extends the EXISTING `assertStockBalanceShape`/`applyStockBalanceProjection` in `src/compliance/stock-balance.ts` - do not create a parallel stock seam.
- Event naming: past-tense dot-separated (`ownership.agreement_set` follows `inventory_planning.params_set`); UUIDv4 entity ids; `business_stream` required; register literals in `SUPPORTED_EVENT_TYPES` (src/events/schema.ts) even though store.ts does not yet enforce that list (known defer).
- Stack pinned: Node 24, PostgreSQL 18.4, TypeScript 5.x, PowerSync 1.23.x, Next.js 16 (edge). No new dependencies, no scheduler/cron, no ORM. Jobs are batch functions with Phase-1 synthetic POST triggers (src/notify dispatch-cycle pattern, reused by 2.7 planning-jobs).

### Current Code State and Preservation Requirements

State of files this story touches, and what must not break:

- `read/projections/stock_balance.sql` - `stock_class TEXT NOT NULL DEFAULT 'owned'` (line 24); grain `UNIQUE NULLS NOT DISTINCT (sku, location_id, lot_id, stock_class)` (line 31); generated `available` column; non-negative CHECKs. The class dimension ALREADY segregates balances and scopes `INSUFFICIENT_STOCK` per class. Line 15 comment reserves `stock_class` for this story. Preserve: grain unchanged, owned default unchanged, `last_issue_at` stamping (2.7, `GREATEST`, only on `stock.issued`).
- `src/compliance/stock-balance.ts` - `VALID_STOCK_CLASSES = {'owned','consignment','vmi','job_work'}` (line 43); invalid class raises `INVALID_PARAMS` (lines 124-132); receipts default class to `'owned'` (line 182). AC2 and AC5 are therefore mostly LATENT today: your job is to contract them with owner-party validation and pin them with tests, not rebuild them.
- `src/compliance/inventory-valuation.ts:196-198` - valuation seam early-returns for non-owned classes. AC4's "zero value" already holds at the projection layer; only the API RESPONSE section is new. Do not touch the seam.
- `src/compliance/planning-jobs.ts:160,297,421-444` - reorder and obsolescence SQL filters `stock_class = 'owned'` (2.7 review patch, tested at test/integration/story-2-7.test.ts:555-569). Preserve exactly; the vmi check is a separate function, not a mode of these.
- `read/projections/replenishment_recommendation.sql` + `src/read/projections/replenishment_recommendation.ts` - partial unique index guards one OPEN recommendation per grain. You are ALTERing this table (signal_type, owner_party_code, wider guard); existing 2.7 rows and behavior must be unaffected (`DEFAULT 'internal'`).
- `src/api/v1/stock.ts:47-63` - response currently merges across `stock_class` (explicitly deferred to this story in deferred-work.md). Closing that defer is Task 3.
- `src/events/store.ts` - persistEvent skips `BEGIN` when given an external client: every write handler must issue its own `BEGIN` (2.5 review lesson, caused piecemeal autocommit).
- `deploy/compose/init-db.sql` - mirror DDL byte-for-byte; NEVER touch the `powersync_publication` block (2.5 broke it once).
- Cycle-count tables also carry `stock_class` (init-db.sql:1409,1423) - counting consignment stock already works per class; no cycle-count changes needed.

### File Structure Requirements

Table 1 (files to update) lists every existing file this story modifies.

Table 1: Files to update

| File | Change |
|------|--------|
| src/events/schema.ts | New event types + payload interfaces |
| src/events/store.ts | Wire ownership seam (assert + apply) |
| src/events/migrate.ts | Register ownership_agreement.sql; replenishment alter |
| src/compliance/stock-balance.ts | Owner-party validation on consignment/vmi receipts |
| src/compliance/planning-jobs.ts | runVmiReplenishmentCheck |
| src/read/projections/replenishment_recommendation.ts | signal_type + owner_party_code |
| read/projections/replenishment_recommendation.sql | Columns + widened open guard |
| src/api/v1/stock.ts | Per-class breakdown |
| src/api/v1/valuation.ts | non_owned_quantities section |
| src/api/v1/inventory-planning.ts (or new route file) | VMI trigger + queue signal_type filter |
| src/api/v1/events.ts, src/api/v1/edge.ts | Location RBAC for new event types |
| src/server.ts | Route registration |
| src/sync/upload.ts, edge/src/sync/connector.ts, edge/src/messages/en.json | New permanent codes + i18n |
| deploy/compose/init-db.sql | DDL mirrors |
| test/unit/schema-drift.test.ts, test/unit/sync-upload.test.ts, edge/test/unit/connector.test.ts | Guards |
| test/integration/story-1-9.test.ts, story-2-2.test.ts, story-2-7.test.ts | Regression pins |

New files: `read/projections/ownership_agreement.sql`, `src/read/projections/ownership_agreement.ts`, `src/compliance/ownership.ts`, `test/integration/story-2-8.test.ts`. Naming: snake_case SQL/read-model pairs, kebab-case compliance/api modules.

### API Contract

Table 2 (routes) defines the route surface delta; every route must appear in the story-1-9 allowlist.

Table 2: Routes

| Method | Path | Purpose | Access |
|--------|------|---------|--------|
| GET | /api/v1/ownership-agreements | List agreements, location-scoped | Planning-config roles |
| PUT | /api/v1/ownership-agreements/:sku/:locationId/:stockClass | Upsert agreement (emits ownership.agreement_set) | Planning-config roles, write-location |
| POST | /api/v1/inventory-planning/vmi-check (align with existing 2.7 trigger naming) | Synthetic VMI check trigger | Planning-trigger roles |
| GET | /api/v1/stock/:sku | EXISTING - gains per-class breakdown | Unchanged |
| GET | /api/v1/stock/:sku/valuation | EXISTING - gains non_owned_quantities | Finance-column roles (unchanged) |
| GET | replenishment queue list (existing 2.7 route) | Gains ?signal_type= filter | Unchanged |

Follow exact existing 2.7 route naming under `src/api/v1/`; check `src/server.ts` registrations before inventing paths.

### Event Contract Guidance

- `ownership.agreement_set`: `{ agreement_id (UUIDv4), sku, location_id, stock_class: 'consignment'|'vmi', owner_party_code, vmi_min_qty?, active }`. Partial edits preserve omitted config (2.7 lesson). `vmi_min_qty` required and positive for vmi; rejected with `VMI_MIN_NOT_CONFIGURED` if a vmi agreement omits it.
- `stock.received` with `stock_class: 'consignment'|'vmi'`: payload must carry `owner_party_code` matching the active agreement. Existing payload interfaces already have optional stock_class fields (src/events/schema.ts:88,99,143).
- `stock.issued` with explicit `stock_class`: draws from that class grain only (existing behavior - pin with tests).
- `replenishment.recommended` gains optional `signal_type` (`'internal'` default | `'vmi_replenishment'`) and `owner_party_code` (required for vmi signals). Zero-quantity recommendations rejected (2.7 review patch precedent).
- Legacy gating: all new validation must be gated so legacy spine fixtures and prior-story event shapes pass through untouched (pattern: 2.6 gated `stock.adjusted` on `adjustment_id` presence; 2.7 gated on exact new event types).

### Data Integrity Guardrails

- All quantity comparisons in SQL NUMERIC, never JS floats (recurring 2.4/2.6 defect class).
- FOR UPDATE row locks: agreement row during vmi check (hold through persistEvent - 2.7 review patch precedent); balance rows during class-scoped availability re-check (existing stock-balance behavior).
- Concurrency: single open vmi signal per grain enforced by partial unique index, not application check alone.
- Idempotency guards before mutation; duplicate event_id must not double-apply projections.
- Statutory/business dates from local date components, never `toISOString().slice(0,10)`.
- Owner-party code format: trimmed, uppercase alphanumeric plus hyphen, 2-32 chars. Registry-referential validation arrives with Story 2.9; do not block on it.
- Never mutate or reinterpret existing `job_work` class rows; Epic 9 owns them.

### Previous Story Intelligence

- 2.7 (direct predecessor, follow its file structure and patterns): projection-seam module shape (`assert*Shape` pre-transaction + `apply*Projection` in-transaction), planning-jobs batch cycle + synthetic POST trigger, four-surface error-code change discipline, write-location RBAC, direct-event/edge path RBAC parity, FOR UPDATE through persistEvent, partial-edit preservation, NUMERIC-bounded payload validation, `forUpdate`-requires-client contract on read helpers.
- 2.7 review patch DIRECTLY relevant: planning queries exclude consignment/vmi/job_work - your vmi check is the intentional counterpart operating exclusively on `stock_class = 'vmi'`.
- 2.5: every write handler issues its own BEGIN; derive persisted status from payload, never hardcode; bind arrays as params; distinct error codes per failure point; client idempotency keys on create endpoints.
- 2.2: stock_balance grain and INSUFFICIENT_STOCK semantics; regression suite `story-2-2.test.ts` pins invariants - extend it, never weaken it.
- Verification battery green before review: prior story finished at backend 308/308, edge 14/14, spine 6/6.

### Latest Technical Information

No new libraries. PostgreSQL 18.4 partial unique indexes and `UNIQUE NULLS NOT DISTINCT` already in use. No external API integrations this story (supplier transmission explicitly deferred to Epic 4).

### Testing Requirements

- One integration file per story: `test/integration/story-2-8.test.ts` (node --test, serial `--test-concurrency=1`, `.env.test`, PostgreSQL container required, audit-trigger escape hatch around TRUNCATE per 2.5/2.6 pattern).
- Regression extensions, not replacements, in story-1-9 (route surface), story-2-2 (owned defaults), story-2-7 (owned-only planning).
- Schema-drift unit coverage for every DDL change.
- Full gate battery in Task 10; report exact counts.

## Project Structure Notes

Matches unified structure: compliance seams in `src/compliance/`, read models paired `read/projections/*.sql` + `src/read/projections/*.ts`, routes in `src/api/v1/` registered in `src/server.ts`, no numbered migrations (canonical SQL + migrate.ts + init-db mirror + drift guard). No conflicts detected. One intentional variance: owner-party single-active-agreement constraint means multiple simultaneous consignment owners for the same SKU-location-class grain are NOT supported; the stock_balance grain is not being widened with owner_party_code this story. Record as a defer if a second owner is ever needed.

## References

- Story + ACs: [Source: _bmad-output/planning-artifacts/epics.md:1135-1165]
- FR-I-10: [Source: _bmad-output/planning-artifacts/epics.md:39]; original: [Source: PLANNING/archive/SCM-Requirements-Document.md:75]
- AC hardening: [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md:953-994]
- stock_class grain: [Source: read/projections/stock_balance.sql:24,31]
- Valid classes + owned default: [Source: src/compliance/stock-balance.ts:43,182]
- Valuation owned gate: [Source: src/compliance/inventory-valuation.ts:196-198]
- Owned-only planning filters: [Source: src/compliance/planning-jobs.ts:160,297,421-444]
- persistEvent seams: [Source: src/events/store.ts:161-246]
- Deferred per-class breakdown: [Source: _bmad-output/implementation-artifacts/deferred-work.md (2.2 entry, src/api/v1/stock.ts:47-63)]
- Notification emission: [Source: src/notify/emit.ts:103]
- Edge error classification: [Source: src/sync/upload.ts:17-42]
- RBAC helpers: [Source: src/middleware/rbac.ts:11,40,61]
- Epic 9 boundary (job_work custody): [Source: _bmad-output/planning-artifacts/epics.md:2587]
- Story 2.9 boundary: [Source: _bmad-output/planning-artifacts/epics.md (Story 2.9 section)]

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5)

### Debug Log References

- Verification battery 2026-07-22: `npx tsc --noEmit` clean, `npm run lint` clean, `npm run build` clean, `npm test` 329/329 (21 new; baseline was 308), `npm run edge:typecheck` clean, `npm run edge:lint` clean, `npm run edge:test` 14/14, `npm run spine-acceptance-contract` 6/6, `git diff --check` clean (CRLF conversion warnings only, standard on this repo).
- Review patch battery 2026-07-22: `npx tsc --noEmit` clean, targeted Story 2.8 integration 24/24, schema drift 21/21, `npm run lint` clean, `npm run build` clean, `git diff --check` clean (CRLF warnings only), full `npm test` 333/333 clean after rerun, edge typecheck/lint clean, edge tests 14/14, spine acceptance 6/6.

### Completion Notes List

- Implemented all 10 tasks from baseline e030403.
- CRITICAL current-state correction discovered during implementation: `applyStockAllocation`, `applyStockIssue`, and `applyStockDeallocation` did NOT filter by `stock_class` at all - a classless issue would have drained consignment rows and an explicit class was ignored. AC2/AC5 therefore required real drain-SQL changes (class filter on the lock, the availability check, the windowed drain, and the `last_issue_at` stamp), not just pinning tests. Default class is `'owned'`; transfer flows (2.5) inherit the owned default, which is the intended hardening.
- `ownership_agreement` registry: SKU-location-class grain, one ACTIVE agreement per grain (partial unique index `uq_ownership_agreement_active`), `chk_` constraints for class/vmi-min/owner-code format, partial-edit preservation via CASE-gated upsert (separate has-vmi-min and has-active flags so omitted fields are never clobbered).
- `ownership.agreement_set` event wired as a new seam (`src/compliance/ownership.ts`): pre-transaction shape assert in persistEvent after `assertInventoryPlanningShape`, in-transaction projection after `applyInventoryPlanningProjection`. Consignment/vmi receipt owner-party gate (`assertConsignmentReceiptOwnership`) runs inside `applyStockBalanceProjection` so HTTP, direct `POST /api/v1/events`, and edge upload paths are gated identically. `job_work` receipts intentionally pass through (Epic 9).
- Errors: `OWNERSHIP_AGREEMENT_NOT_FOUND` (404), `OWNER_PARTY_MISMATCH` (409), `VMI_MIN_NOT_CONFIGURED` (400/skip reason), `INVALID_SIGNAL_TYPE` (400); all four added to backend `PERMANENT_ERROR_CODES`, edge connector set, and edge i18n in the same change; AC5 reuses `INSUFFICIENT_STOCK` with `details.stock_class`.
- VMI signal reuses the 2.7 `replenishment_recommendation` projection: new `signal_type` (default `'internal'`) and `owner_party_code` columns, open guard widened to `(sku, location_id, signal_type)` (old index dropped and replaced by `uq_replenishment_recommendation_open_signal`) so one open internal and one open vmi signal coexist per grain - proven by an integration test. `runVmiReplenishmentCheck` scans active vmi agreements under FOR UPDATE, compares NUMERIC in SQL (strict `<` per AC3 "falls below"), replenishes to the minimum, and emits the transactional planner alert (`vmi_replenishment_recommended`).
- Stock API per-class breakdown closes the deferred 2.2 item: per-location `classes[]` and `consolidated_by_class`, owner codes resolved from active agreements; review decision made top-level `locations[]` and `consolidated` totals owned-only so supplier-owned quantities are never mistaken for company-owned stock. Valuation endpoint gains `non_owned_quantities` (report-only; the 2.4 owned-only seam untouched).
- Regression adaptation: story-2-7's "only owned stock feeds planning" test posted an agreement-less consignment receipt with an unasserted status; under the new contract that would silently no-op the fixture, so the test now seeds an agreement, sends the owner code, and asserts 201 - the regression it guards is preserved, not weakened. story-2-2/story-2-4 harnesses gained `ownership_agreement.sql` because GET stock/valuation now read the registry.
- Access-matrix note for later sync (no FR-I-10 row exists): agreement config write + vmi trigger = `inventory_planner`, `demand_planner`, `inventory_controller` (module inventory, write scope, write-location enforced); reads = module inventory read scope with location scoping; valuation surface roles unchanged.
- Scope boundaries honored: no PO/requisition, no supplier transmission (Epic 4), no disposition (Epic 16), no job_work custody changes (Epic 9), owner-party referential validation deferred to Story 2.9 (registry format + agreement anchoring only).
- Review patches resolved: active VMI agreements now require `vmi_min_qty` and use `NUMERIC(14,3)`; ownership agreements validate active item/location references; owner-party codes trim before persistence; direct event and edge upload paths enforce the planning-config role allowlist; ownership and replenishment unique-index races map to 409 domain conflicts; transfer `in_transit` updates are owned-class scoped; availability and VMI refresh comparisons use SQL NUMERIC; VMI checks lock matching balance rows; stock/valuation agreement lookups are visibility-scoped; concurrent VMI checks and mixed-class transfer regressions are covered.

### File List

New files:

- read/projections/ownership_agreement.sql
- src/read/projections/ownership_agreement.ts
- src/compliance/ownership.ts
- src/api/v1/ownership-agreements.ts
- test/integration/story-2-8.test.ts

Modified files:

- read/projections/replenishment_recommendation.sql
- src/read/projections/replenishment_recommendation.ts
- src/read/projections/stock_balance.ts
- src/compliance/stock-balance.ts
- src/compliance/inventory-planning.ts
- src/compliance/planning-jobs.ts
- src/events/schema.ts
- src/events/store.ts
- src/events/migrate.ts
- src/api/v1/stock.ts
- src/api/v1/valuation.ts
- src/api/v1/inventory-planning.ts
- src/api/v1/events.ts
- src/api/v1/edge.ts
- src/server.ts
- src/sync/upload.ts
- edge/src/sync/connector.ts
- edge/src/messages/en.json
- deploy/compose/init-db.sql
- test/unit/schema-drift.test.ts
- test/unit/sync-upload.test.ts
- edge/test/unit/connector.test.ts
- test/integration/story-1-9.test.ts
- test/integration/story-2-2.test.ts
- test/integration/story-2-4.test.ts
- test/integration/story-2-7.test.ts
- _bmad-output/implementation-artifacts/sprint-status.yaml

## Change Log

Table 3 (change log) tracks story-file revisions.

Table 3: Change log

| Date | Change |
|------|--------|
| 2026-07-22 | Story created via create-story workflow (ultimate context engine analysis) |
| 2026-07-22 | Implemented all 10 tasks; class-scoped drain SQL, ownership registry + seam, per-class stock API, valuation non-owned section, VMI check + signal; full battery green (329/329, edge 14/14, spine 6/6); status review |
| 2026-07-22 | Applied all 15 code-review patches; full battery green (333/333, edge 14/14, spine 6/6); status done |
