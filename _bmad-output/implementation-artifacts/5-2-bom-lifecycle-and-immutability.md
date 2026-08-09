---
baseline_commit: af39b5e5bf8587cea14d95c45a01cca88d1cb30f
---

# Story 5.2: BOM Lifecycle and Immutability

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created (create-story 2026-08-07). Fresh-context checklist validation applied: route-order fix, A-11 predicate extraction directive, kit line-completion rules. -->

## Story

As a BOM administrator,
I want BOMs to move through Draft, Released, On Hold, and Obsolete states with a strict release gate, and released revisions to be immutable,
so that production always builds from a controlled, unchangeable specification.

## Acceptance Criteria

1. **Given** a Draft BOM from Story 5.1, **When** release is attempted (FR-B-06), **Then** release succeeds only when all component item masters are released (A-11) and all scrap percents are filled - otherwise release is blocked with `error_code: "RELEASE_GATE_UNMET"` listing the unmet conditions. The remaining FR-B-06 gate conditions are staged: the approved-ECO condition is added by Story 5.3 (first release of a new BOM is exempt) and the completed-cost-rollup condition by Story 5.6.
2. **Given** a BOM has been Released, **When** any user attempts to edit its structure directly, **Then** the edit is rejected with `error_code: "IMMUTABLE_REVISION"` because Released revisions are immutable (FR-B-03) - changes are only possible through an ECO (Story 5.3).
3. **Given** a Released BOM, **When** an administrator changes its state, **Then** it may move only to On Hold or Obsolete, and each transition is written to the edit log (FR-AC-13).
4. **Given** existing legacy kit definitions from the ERP kit master (FR-I-09, Epic 2), **When** migration runs (FR-B-02), **Then** each kit whose components all reference released item masters is migrated as a single-level BOM in Released state with its components preserved, released via a migration-exempt path recorded in the edit log (FR-AC-13).
5. **Given** a legacy kit referencing an item that is not yet a released item master, **When** migration runs (FR-B-02), **Then** that kit lands as a Draft BOM flagged for remediation rather than being force-released, and appears on the migration exception list feeding the Epic 13 sign-off gate.

## Tasks / Subtasks

- [x] Task 1: Widen lifecycle schema (AC: 1, 3, 4, 5)
  - [x] In `read/projections/bom.sql`: widen `chk_bom_status` to `('draft','released','on_hold','obsolete')`; add columns `status_changed_at TIMESTAMPTZ`, `status_changed_by UUID` (matches `created_by`), `origin TEXT NOT NULL DEFAULT 'native'` with `chk_bom_origin CHECK (origin IN ('native','legacy_kit'))`, `remediation_flag BOOLEAN NOT NULL DEFAULT false`, `kit_ref TEXT`
  - [x] In `read/projections/bom_revision.sql`: widen `chk_bom_revision_status` to `('draft','released')`; add `released_at TIMESTAMPTZ`, `released_by UUID` (matches `drafted_by`); also update the stale line-6 comment "Story 5.2 adds released, hold, obsolete states" - this design keeps hold/obsolete at HEADER level only, revision status is `draft | released`
  - [x] Each CHECK must be widened in THREE places per canonical file: the inline `CREATE TABLE` definition, the existing `DO $$` re-add guard block (e.g. `bom.sql` lines 44-57 re-adds `chk_bom_status` with the old list), and a new idempotent `ALTER TABLE ... DROP CONSTRAINT IF EXISTS ... / ADD CONSTRAINT` migration statement; new columns via `ADD COLUMN IF NOT EXISTS` (`CREATE TABLE IF NOT EXISTS` alone will NOT relax existing CHECKs on a live DB)
  - [x] Mirror every DDL change byte-for-byte into `deploy/compose/init-db.sql` (LF endings) - the schema-drift test compares both the CREATE TABLE body AND each constraint's DO block between the two
  - [x] Update EXPECTED entries in `test/unit/schema-drift.test.ts` (bom entries at lines 660-714), including adding `chk_bom_origin` to the bom `constraints` array
  - [x] Prove idempotency: `npm run db:migrate` twice
- [x] Task 2: Register lifecycle events (AC: 1, 2, 3, 4, 5)
  - [x] In `src/events/schema.ts` (BOM block starts ~line 1370): add payload plus envelope interface pairs using `Omit<EventEnvelope, 'payload'>` for `bom.released`, `bom.held`, `bom.obsoleted`, `bom.migrated_from_kit` (these are the epics dev-note events `BomReleased`, `BomHeld`, `BomObsoleted`, `LegacyKitMigrated` translated to the repo's dot-separated past-tense convention; `bom.released` is the architecture-spine canonical example)
  - [x] Append registry entries at the tail of `SUPPORTED_EVENT_TYPES` before `} as const`: all `streamType: 'engineering'`; `requiresBusinessStream: false` for the three lifecycle transitions (follows the `bom_line.*` precedent - transitions act on an already-tagged document); `requiresBusinessStream: true` for `bom.migrated_from_kit` (creates a header, follows `bom.drafted`)
  - [x] Payloads: `BomReleasedPayload { bom_id, revision_id, reason?, correlation_id? }`; `BomHeldPayload { bom_id, reason?, correlation_id? }`; `BomObsoletedPayload { bom_id, reason?, correlation_id? }`; `LegacyKitMigratedPayload { bom_id, parent_item_id, kit_ref, revision_code, outcome: 'released' | 'draft_remediation', lines: BomLineInput[], correlation_id? }`. Outcome MUST be computed at capture time and stored in the payload so replay is deterministic (item statuses drift over time)
- [x] Task 3: Release gate and lifecycle appliers in `src/compliance/bom.ts` (AC: 1, 3)
  - [x] Extend `BOM_EVENT_TYPES` / `ENGINEERING_STREAM_TYPES` sets, `bomEventType`, `assertBomShape` (pre-transaction, store.ts line 492 - do not move), `applyBomProjection` for the four new events
  - [x] `bom.released` applier: lock `bom` row `FOR UPDATE`; branch on current status - `draft` runs the full gate, `on_hold` is reinstatement (revision already gated once; no re-gate, see Dev Notes), anything else rejects `INVALID_STATE_TRANSITION` (409)
  - [x] Gate evaluation (draft path): re-evaluate the A-11 check (`item_master.status = 'active'`) for EVERY line of the current revision at release time - stored `blocking_release` flags can be stale (Story 5.1 saved clarification 1); refresh `blocking_release`, `blocking_reason`, and `bom.blocking_line_count` from the fresh result. NOTE: Story 5.1 recorded a one-predicate decision but implemented the check INLINE at compliance/bom.ts lines 368, 431, and 537 - no exported predicate exists yet. Extract it now (e.g. `isReleasedItemMaster`), refactor those three call sites to use it, then consume it in the gate and the Task 7 migration evaluation
  - [x] Gate conditions enforced in this story (D4 staging): (1) `blocking_line_count = 0` after refresh, (2) no line of the current revision has `scrap_percent IS NULL`, (3) at least one line exists (reuse `BOM_LINE_REQUIRED`)
  - [x] On unmet conditions reject `RELEASE_GATE_UNMET` (409) with `details.unmet_conditions` array naming each failed condition key (`component_item_masters_released`, `scrap_percent_missing`) plus offending `bom_line_id`/`line_no` lists, and `details.staged_conditions` listing `approved_eco` (Story 5.3) and `cost_rollup_complete` (Story 5.6) with `enforced: false`
  - [x] On success: set `bom_revision.revision_status = 'released'`, `released_at`, `released_by`; set `bom.status = 'released'`, `status_changed_at`, `status_changed_by`
  - [x] `bom.held` / `bom.obsoleted` appliers: lock row, enforce the transition matrix in Dev Notes, reject invalid moves with `INVALID_STATE_TRANSITION` (409), update `status`, `status_changed_at`, `status_changed_by`
  - [x] Keep the plain-SELECT `alreadyPersisted` idempotent-replay guard pattern (never `FOR UPDATE` on `domain_events`)
- [x] Task 4: Immutability enforcement (AC: 2)
  - [x] In the existing `bom_line.added` and `bom_line.amended` appliers replace the blanket draft-only guard: when the target revision has `revision_status = 'released'` reject `IMMUTABLE_REVISION` (409); when the revision is still draft but `bom.status != 'draft'` keep rejecting `BOM_NOT_DRAFT` (preserves Story 5.1 semantics for the remaining cases)
  - [x] No deletion path exists and none may be added; line retirement stays effectivity-window closure via ECO (Story 5.3)
- [x] Task 5: Release-gate checklist read model (AC: 1)
  - [x] New `src/read/projections/release_gate_checklist.ts`: `getReleaseGateChecklist(bomId, client?)` computing condition status live from `bom`, `bom_line`, `item_master` (runner-with-optional-PoolClient pattern, `UUID_REGEX` guard, NUMERIC as strings)
  - [x] Response shape mirrors the gate: per-condition `{ condition, met, enforced, blocking_lines[] }` including the two staged conditions with `enforced: false`
  - [x] Deliberate divergence from the epics dev-note wording "checklist projection": this is a computed read, not a stored table - a stored checklist goes stale the moment an item master deactivates, and the gate itself must re-derive truth transactionally anyway. Module-scoped per the DB-timing standard; no new table, no migrate.ts entry
- [x] Task 6: API routes, RBAC, spine registration (AC: 1, 2, 3, 4, 5)
  - [x] In `src/api/v1/boms.ts` add handlers: `releaseBomHandler` (`POST /api/v1/boms/:bomId/release`), `holdBomHandler` (`POST /api/v1/boms/:bomId/hold`), `obsoleteBomHandler` (`POST /api/v1/boms/:bomId/obsolete`), `getReleaseGateHandler` (`GET /api/v1/boms/:bomId/release-gate`), `migrateLegacyKitsHandler` (`POST /api/v1/boms/legacy-kit-migration`), `listMigrationExceptionsHandler` (`GET /api/v1/boms/migration-exceptions`)
  - [x] Mutations: `requireRole({ module: 'engineering', functionScope: 'write' })`; reads: `functionScope: 'read'`; never role-name literals (`test/unit/no-hardcoded-role-in-workflow.test.ts` enforces)
  - [x] Every mutation builds an envelope with `idempotency_key: (body.idempotency_key as string) ?? randomUUID()` and calls `persistEvent(event, auditCtxFor(req, actor, status))`; responses return the durable projection state
  - [x] Route-order requirement (verified): `src/api/router.ts` lines 125-141 iterates routes in REGISTRATION order and returns the first match, and `:bomId` compiles to `([^/]+)` which matches the literal `migration-exceptions`. `GET /api/v1/boms/migration-exceptions` MUST therefore be registered ABOVE `GET /api/v1/boms/:bomId` (currently `src/server.ts` line 451) or it can never match (requests would hit `getBomHandler` and 404 on the UUID guard). `POST .../legacy-kit-migration` and the two-segment `POST /:bomId/release|hold|obsolete` routes have no such conflict
  - [x] Mount the rest in `src/server.ts` under a `// Story 5.2: BOM Lifecycle` comment after the Story 5.1 block (lines 448-454); the six existing routes keep their paths and handlers unchanged - only the ordering insertion above is permitted
  - [x] Add every new route verbatim to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` under a `// Story 5.2` comment - the list is grouped by story comment (BOM block at lines 351-357), not alphabetically sorted
- [x] Task 7: Legacy kit migration (AC: 4, 5)
  - [x] Source-data decision (binding, see Dev Notes): no ERP kit-master projection exists in this codebase - `POST /api/v1/boms/legacy-kit-migration` accepts the kit batch in the request body: `{ kits: [{ kit_ref, parent_item_id, revision_code?, components: [{ component_item_id, quantity_per, line_uom, scrap_percent? , effective_from? }] }], idempotency_key? }`
  - [x] Per kit, in the handler: resolve parent item; if a BOM already exists for the parent (`uq_bom_parent_item`) record a `skipped: 'bom_exists'` result and continue (natural idempotency for re-runs; a second kit for the same `parent_item_id` WITHIN one batch also reports `skipped: 'bom_exists'`, never a constraint crash); evaluate every component with the extracted A-11 predicate; compute `outcome` (`released` when all components active, else `draft_remediation`); persist one `bom.migrated_from_kit` event per kit
  - [x] Line completion rules (kit input is sparse, `BomLineInput` and `bom_line` NOT NULLs are not): handler assigns `line_no` sequentially from array order; `output_class = 'component'`; `is_phantom = false`; `uom_conversion_factor` defaults to `'1.00000000'` (ERP kits carry no conversion data) so `base_quantity_per = quantity_per`; `effective_from` defaults to the request-time IST `business_date` (same derivation the existing handlers use for envelope metadata)
  - [x] Applier: create `bom` (with `origin = 'legacy_kit'`, `kit_ref`), `bom_revision`, and `bom_line` rows in a single transaction. Outcome `released`: statuses released, blocking flags false, missing `scrap_percent` defaulted to `'0.0000'` (migration-exempt path bypasses the gate per AC 4 - record `migration_exempt: true` in the audit entry payload). Outcome `draft_remediation`: statuses draft, `remediation_flag = true`, blocking flags and reasons set from the component evaluation
  - [x] `GET /api/v1/boms/migration-exceptions`: returns BOMs where `origin = 'legacy_kit' AND remediation_flag = true` plus the skipped-kit info is response-only (feeds the Epic 13 sign-off gate); extend `ListBomsParams`/`listBoms` in `src/read/projections/bom.ts` with `origin`/`remediation_flag` filters rather than writing a parallel query
  - [x] Batch endpoint responds `{ migrated: [], draft_remediation: [], skipped: [] }` with per-kit detail; partial success is expected behavior, not an error
- [x] Task 8: Read accessor and type updates (AC: 1, 2, 3)
  - [x] `src/read/projections/bom.ts`: widen `BomRow.status` union to `'draft' | 'released' | 'on_hold' | 'obsolete'`, `BomRevisionRow.revision_status` to `'draft' | 'released'`; add new columns to Row types; add `updateBomStatus` and `releaseBomRevision` helpers following existing insert/update helper style; do NOT change existing helper signatures (handlers and tests depend on them)
- [x] Task 9: Integration and unit tests (AC: all)
  - [x] `test/integration/story-5-2.test.ts` following the `story-5-1.test.ts` harness exactly: `node:test` + `node:assert/strict`, real router via `createAppRouter` from `../../src/server.js`, real PostgreSQL via `getPool`/`getAdminPool`, canonical `.sql` files applied via `readFileSync` in dependency order, port-zero server, run-scoped identifiers `randomUUID().slice(0, 8)`, all writes through the HTTP API (direct engineering-stream event posts are rejected by design)
  - [x] Minimum cases: (1) release succeeds on a clean draft and writes audit entry; (2) release blocked on missing scrap percent with `RELEASE_GATE_UNMET` naming `scrap_percent_missing`; (3) release blocked when a component item is deactivated AFTER its line was added - proves release-time re-evaluation, not stale flags; (4) `POST .../lines` and `PATCH .../lines/:id` on a released BOM return `IMMUTABLE_REVISION`; (5) transition chain released to on_hold to released to obsolete each audit-logged, then any further transition rejected `INVALID_STATE_TRANSITION`; (6) draft to on_hold rejected `INVALID_STATE_TRANSITION`; (7) qualifying kit migrates to Released with `origin = 'legacy_kit'` and a `migration_exempt` audit entry; (8) kit with an inactive component lands draft with `remediation_flag = true` and appears in `GET /api/v1/boms/migration-exceptions`; (9) kit whose parent already has a BOM is reported `skipped`; (10) direct `bom.released` post to the events API is rejected; (11) mutation without engineering write role returns 403; (12) idempotent replay with the same `idempotency_key` does not double-apply
- [x] Task 10: QA gates (AC: all)
  - [x] `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test`, `npm run spine-acceptance-contract`, `npm run edge:test`, `git diff --check`
  - [x] Update `_bmad-output/implementation-artifacts/sprint-status.yaml` story status when done; fill the Dev Agent Record sections of this file (Story 5.1 left its record empty - do not repeat that)

## Dev Notes

### Lifecycle design (binding)

- Status values: `bom.status` in `('draft','released','on_hold','obsolete')`; `bom_revision.revision_status` in `('draft','released')`. Immutability is a property of the released revision; hold/obsolete are header-level states over an already-released revision.
- Transition matrix (everything else rejects `INVALID_STATE_TRANSITION`, 409): `draft` to `released` (full gate); `released` to `on_hold` or `obsolete`; `on_hold` to `released` (reinstatement, no re-gate - the revision already passed the gate and is unchanged by definition of immutability; edit-logged like every transition) or `obsolete`. `obsolete` is terminal.
- AC 3 constrains only transitions FROM Released; the reinstatement path (`on_hold` to `released`) is a decision made here so On Hold is not a dead end. Reuses the `bom.released` event with `reason` distinguishing reinstatement in the audit trail.
- One revision per BOM in this story. Revision-code generation for subsequent revisions is Story 5.3 (ECO) scope - do not build a new-revision flow here (Story 5.1 saved clarification 5 resolved: deferred to 5.3).

### Release gate (D4 staging - do not over-build)

- This story enforces ONLY: released component item masters (A-11) and scrap percents filled. Approved-ECO arrives in Story 5.3 (with first-release exemption); completed-cost-rollup in Story 5.6. Cross-references: epics.md lines 1842 and 1935 stage those conditions explicitly. Surface both in `details.staged_conditions` with `enforced: false` so 5.3/5.6 flip switches instead of reshaping the payload.
- A-11 semantics (Story 5.1 binding decision, sprint-status.yaml lines 37-40): `item_master` has NO released state - only `active | inactive`. "Released item master" is evaluated as `status = 'active'`. Story 5.1 implemented this check inline (compliance/bom.ts lines 368, 431, 537) without the intended single predicate - Task 3 extracts it into one exported function; after that, consume and refresh `blocking_release` / `blocking_line_count` through it and never re-derive with ad-hoc SQL elsewhere.
- The gate MUST re-evaluate at release time inside the applier transaction - `blocking_release` was stamped at line-add time and item masters deactivate afterward. This resolves Story 5.1 saved clarification 1 (recompute timing): recompute on release attempt, persist the refreshed flags even when the gate fails (the checklist read and the gate then agree).
- A failed gate throws inside the persist transaction, so the event is rolled back and NOT stored - same pattern as `EFFECTIVITY_OVERLAP` in Story 5.1. The idempotency key is not consumed (shape asserts run pre-transaction; gate rejection rolls back the `domain_events` insert).

### Error codes

New (all 409): `RELEASE_GATE_UNMET`, `IMMUTABLE_REVISION` (both mandated verbatim by the ACs), `INVALID_STATE_TRANSITION`. Reuse: `BOM_NOT_FOUND` (404), `BOM_NOT_DRAFT`, `BOM_LINE_REQUIRED`, `INVALID_PARAMS`, `DUPLICATE_EVENT`. Error envelope `{ error_code, message, details, trace_id }` via `AppError(statusCode, errorCode, message, details)` from `src/middleware/error.ts`. No central registry file exists; codes live in the throwing module.

### Legacy kit migration (binding design decisions)

- VERIFIED: no ERP kit-master projection exists (`read/projections/` has `erp_purchase_order.sql` and `erp_sales_order.sql` only; zero kit tables; `grep -i kit src/` matches only BOM files' `job_work_kit` type). FR-I-09 in Epic 2 delivered kit TRANSACTIONS, not a kit-definition store. Therefore the migration source is the request body of `POST /api/v1/boms/legacy-kit-migration` - the BOM administrator posts the ERP kit-master export as a batch. This keeps the API-only write path (direct event posts stay rejected) and adds no ERP staging table.
- Migrated kits are single-level production BOMs (FR-B-02): `bom_type = 'production'`, one revision, components as lines completed per the Task 7 line-completion rules (sequential `line_no`, `output_class = 'component'`, `is_phantom = false`, conversion factor `'1.00000000'`, `effective_from` defaulting to the request-time IST `business_date`).
- The migration-exempt release does NOT run the gate (AC 4 says released "via a migration-exempt path") but it MUST be edit-logged with `migration_exempt: true` so FR-AC-13 auditors can distinguish it. Missing scrap percents default to `'0.0000'` on the released path (exact decimal string, NUMERIC discipline).
- `uq_bom_parent_item` (one BOM header per parent item) makes re-runs naturally idempotent: existing BOM means `skipped: 'bom_exists'`. Do not attempt merge or overwrite - AD-4 forbids inbound overwrites; conflicts become exceptions.

### Architecture compliance (mandatory)

- Event-sourced writes only: state changes append to `domain_events`; projections mutate only inside `applyBomProjection` within the persist transaction (`src/events/store.ts` wiring: `assertBomShape` pre-transaction at line 492, `applyBomProjection` in-transaction at line 740). Extend `src/compliance/bom.ts` internals; do not add new store.ts call sites beyond registering the new event types in the existing hook sets.
- Guard pattern: `SELECT ... FOR UPDATE` on the `bom` row, then `reject(code, message, details, httpStatus)` - copy the `BOM_NOT_DRAFT` shape at compliance/bom.ts lines 487-493.
- BOM is enterprise-scoped: no `site_id`, no location filters; `business_stream` derives server-side from the parent `item_master` and is never accepted from a request body.
- Edit log FR-AC-13: every lifecycle transition and every migration outcome writes an audit entry via the existing `auditCtxFor(req, actor, status)` + `persistEvent` path (`src/api/v1/boms.ts` lines 41, 128).
- NUMERIC discipline: quantities and percents as exact decimal strings end-to-end; arithmetic in PostgreSQL NUMERIC, never JS floats; PG18 silently rounds excess scale - reject before storage.
- ESM: `.js` extensions on relative imports, `node:` prefixed builtins, no new dependencies, no PostgreSQL extensions (no `btree_gist`), hand-rolled router (no web framework).
- Edge/offline surface untouchable: `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/**`, `sync/sync-rules.yaml`.
- Markdown outputs follow `FORMATTING_RULES.md` (one H1, no em dashes, no arrows in prose).

### Previous story intelligence (5.1)

- Story 5.1 (commit `af39b5e`, 17 files) delivered: `bom`, `bom_revision`, `bom_line`, `bom_structure` tables; events `bom.drafted`, `bom_line.added`, `bom_line.amended`; compliance seam `bomEventType` / `assertBomShape` / `applyBomProjection` in `src/compliance/bom.ts`; read accessors in `src/read/projections/bom.ts`; six routes in `src/api/v1/boms.ts` mounted at `src/server.ts` lines 448-454.
- Established patterns to copy: envelope-interface pairs appended before `SUPPORTED_EVENT_TYPES`; registry entries appended at the tail before `} as const` (~line 1861); migrations appended at the tail of `MIGRATIONS` in `src/events/migrate.ts` (BOM entries lines 64-67, never reorder); named `chk_` / `uq_` / `idx_` constraints; grants `INSERT, SELECT, UPDATE` to `app_user` (no DELETE), `SELECT` to `readonly_user`; plain-SELECT `alreadyPersisted` (the Story 4.3 lesson: never `FOR UPDATE` on `domain_events`).
- Known debt inherited from 5.1 - explicitly NOT in 5.2 scope, do not fix silently, do not depend on: (1) `bom_structure` is never populated (no applier writes it; `GET /:bomId/structure` reads an empty table) - the release gate must therefore consume `bom_line` + `blocking_line_count`, never `bom_structure`; (2) cycle/depth detection unimplemented (`config.bom.maxDepth` unused, `BOM_CYCLE_DETECTED` / `BOM_DEPTH_EXCEEDED` appear nowhere); (3) the `bom_line.amended` path does not re-run the effectivity-overlap predicate. If any of these blocks an AC, stop and surface it rather than expanding scope.
- Story 5.1's `DUPLICATE_EVENT` 409 on existing `bom_id` diverges from Story 3.10's return-existing-record replay precedent; follow 5.1's local convention for BOM streams (consistency within the module wins).

### Testing requirements

- Framework: built-in `node:test` runner, serial (`--test-concurrency=1`), real PostgreSQL from `.env.test` - no jest, no vitest, no mocks of the database.
- Gates that will trip this story: `test/unit/schema-drift.test.ts` (init-db.sql vs canonical projections sync - update EXPECTED entries), `test/unit/no-hardcoded-role-in-workflow.test.ts` (RBAC through `requireRole` only), `npm run spine-acceptance-contract` (route allowlist in `test/integration/story-1-9.test.ts`).
- Story 5.1 recorded only "build passes, lint passes" as evidence; this story must run the FULL gate list in Task 10 and record results in the Dev Agent Record.

### Project Structure Notes

The file touch map in Table 1 is the authoritative scope boundary; anything outside it needs a recorded reason in the Dev Agent Record. Table 1 lists each file this story updates or creates.

Table 1: File touch map

| Action | Path | Change |
| --- | --- | --- |
| UPDATE | `read/projections/bom.sql` | widen status CHECK, add lifecycle and migration columns, idempotent ALTERs |
| UPDATE | `read/projections/bom_revision.sql` | widen revision-status CHECK, released_at/released_by, idempotent ALTERs |
| UPDATE | `deploy/compose/init-db.sql` | byte-for-byte mirror of both files above |
| UPDATE | `src/events/schema.ts` | four payload/envelope pairs plus registry entries |
| UPDATE | `src/compliance/bom.ts` | lifecycle appliers, release gate, immutability guards, migration applier |
| UPDATE | `src/read/projections/bom.ts` | widened unions, new columns, status helpers, listBoms filters |
| UPDATE | `src/api/v1/boms.ts` | six new handlers |
| UPDATE | `src/server.ts` | Story 5.2 route block |
| UPDATE | `test/integration/story-1-9.test.ts` | allowedSpineRoutes additions |
| UPDATE | `test/unit/schema-drift.test.ts` | EXPECTED entries for bom and bom_revision |
| NEW | `src/read/projections/release_gate_checklist.ts` | computed checklist accessor |
| NEW | `test/integration/story-5-2.test.ts` | integration suite |

`src/events/migrate.ts` is unchanged unless a new `.sql` file is added (none planned). `src/events/store.ts` changes only if the event-type sets require new hook registration the way 5.1 did - prefer extending the compliance module.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` - Story 5.2 at lines 1765-1798; Epic 5 at 1719-1952; staged-gate cross-references at lines 1842 (5.3) and 1935 (5.6); FR texts at lines 92-108.
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` - event envelope, AD-4 (BOM system of record), AD-14 (shared projections), naming conventions, error envelope, stack (Node 24, PostgreSQL 18.4, TypeScript 5.x).
- Previous story: `_bmad-output/implementation-artifacts/5-1-multi-level-bom-creation.md` (binding decisions at lines 26-40) and sprint-status.yaml comments (lines 19-40).
- Downstream consumers: Story 5.3 (ECO gate condition), Story 5.6 (cost-rollup condition), Epic 6 Story 6.1 (production release requires an effective Released BOM), Epic 13 (migration exception sign-off).

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code, dev-story workflow, 2026-08-07.

### Debug Log References

- Baseline discovery: `test/integration/story-5-1.test.ts` had never run green. Three harness
  defects (server never called `listen`, SCIM call missing its bearer token, item creation missing
  auth headers and `valuation_method`) plus a design conflict (multiple BOM drafts against one
  parent item violate `uq_bom_parent_item`). Repaired the harness and gave each draft test a
  fresh parent item; suite now passes 12/12. Recorded here because the file is outside the
  Table 1 touch map - the repair restores the regression signal this story's changes depend on.
- Latent Story 5.1 handler bugs surfaced by the repaired suite and fixed in `src/api/v1/boms.ts`
  (in the touch map): (1) `bom.drafted` is registered `requiresBusinessStream: true` but the
  handler never injected `business_stream`, so every draft failed `UNTAGGED_TRANSACTION`; the
  handler now derives it server-side from the parent item master per the architecture rule.
  (2) No BOM envelope set `metadata.occurred_at`, which `persistEvent` requires and the tagging
  rule lookup dereferences (crashed to 500); all five BOM envelope builders now stamp it.
- Gate-failure flag persistence: the story asks the gate to persist refreshed `blocking_release`
  flags even when the gate fails, but a failed gate throws inside the persist transaction and
  rolls back everything including the refresh. The live-computed checklist read agrees with the
  gate regardless because it derives from `item_master` directly, which satisfies the intent
  (checklist and gate never disagree). No stored-flag persistence on the failure path.
- `npm test`: 746/760 pass. The 14 failures are the known pre-existing idempotency-replay
  failures (409 vs 201) in Epic 1-3 suites, unchanged in count and identity since Story 4.7
  diagnosed them; none touch BOM code paths.

### Completion Notes List

- Task 1: widened `chk_bom_status` to the four-state lifecycle and `chk_bom_revision_status` to
  draft/released in three places each (CREATE TABLE, DO-block guard, DROP+ADD migration pair);
  added `status_changed_at/by`, `origin` with `chk_bom_origin`, `remediation_flag`, `kit_ref`,
  `released_at/by` via `ADD COLUMN IF NOT EXISTS`; mirrored into init-db.sql; schema-drift test
  updated (added `chk_bom_origin`) and green; `db:migrate` proven idempotent (two clean runs).
- Task 2: four payload/envelope pairs and registry entries added. Lifecycle transitions are
  `requiresBusinessStream: false` (bom_line precedent); `bom.migrated_from_kit` is `true` and the
  handler injects the server-derived stream. `outcome` is stored in the payload at capture time.
- Task 3: `isReleasedItemMaster` extracted and consumed at the three former inline sites, the
  release gate, and the migration evaluation. Release applier branches draft (full gate with
  release-time re-evaluation of every line), on_hold (reinstatement, no re-gate), else
  `INVALID_STATE_TRANSITION`. `RELEASE_GATE_UNMET` carries `unmet_conditions`, offending line
  lists, and `staged_conditions` (`approved_eco`, `cost_rollup_complete`, `enforced: false`).
- Task 4: released-revision immutability (`IMMUTABLE_REVISION`) enforced in both the appliers
  and the handler pre-checks (the Story 5.1 pre-checks short-circuited with `BOM_NOT_DRAFT`
  before the applier could run); draft-revision non-draft-header cases keep `BOM_NOT_DRAFT`.
- Task 5: `release_gate_checklist.ts` computes the checklist live (no stored table); staged
  conditions surface with `met: null, enforced: false`; `ready_to_release` requires draft status
  plus all enforced conditions met.
- Task 6: six handlers added with `requireRole` module/functionScope only;
  `GET /api/v1/boms/migration-exceptions` registered above `GET /api/v1/boms/:bomId`; all six
  routes added to `allowedSpineRoutes`; spine acceptance contract green.
- Task 7: batch migration endpoint with per-kit outcomes `{ migrated, draft_remediation,
  skipped }`; skip reasons `bom_exists` (pre-existing BOM, duplicate parent within batch, or
  `DUPLICATE_EVENT` race), `parent_item_not_found`, `invalid_kit`; per-kit idempotency key
  `batchKey:kit_ref`; migration-exempt release audit-logged with
  `details.migration_exempt: true`; missing scrap defaults to `'0.0000'` on the released path.
- Task 8: Row types widened, `origin`/`remediationFlag` filters added to `listBoms`,
  `updateBomStatus` and `releaseBomRevision` helpers added; no existing signatures changed.
- Task 9: `story-5-2.test.ts` covers all 12 minimum cases plus 15 Group 4 regression tests (combined gate failure, happy-path checklist, on_hold->obsolete, on_hold->hold rejection, draft->obsolete rejection, immutability while on_hold, reinstatement audit reason, line completion fields, draft-remediation line state, parent_item_not_found skip, in-batch duplicate parent, batch re-run idempotency, limit/offset validation, direct engineering-stream guard, expanded RBAC); 27/27 pass against real PostgreSQL. `story-5-1.test.ts` repaired and strengthened (re-fetch assertions, error codes); 12/12 pass.
- Task 10 gate evidence (all run 2026-08-09): `npm run build` clean; `npm run lint` clean; `npm run format:check` clean; `npm run db:migrate` twice clean; `npm test` 761/775 (14 pre-existing idempotency-replay failures in Epic 1-3 suites, zero new); `npm run spine-acceptance-contract` 6/6; `npm run edge:test` 30/30; `git diff --check` clean (CRLF warnings only, repo-standard); `graphify update .` run after code changes.

### File List

- `read/projections/bom.sql` (modified)
- `read/projections/bom_revision.sql` (modified)
- `deploy/compose/init-db.sql` (modified)
- `src/events/schema.ts` (modified)
- `src/compliance/bom.ts` (modified)
- `src/read/projections/bom.ts` (modified)
- `src/read/projections/release_gate_checklist.ts` (new)
- `src/api/v1/boms.ts` (modified)
- `src/api/v1/events.ts` (modified - Group 4 engineering-stream guard)
- `src/server.ts` (modified)
- `test/integration/story-1-9.test.ts` (modified)
- `test/unit/schema-drift.test.ts` (modified)
- `test/integration/story-5-2.test.ts` (new, 27 tests)
- `test/integration/story-5-1.test.ts` (modified - harness repair + strengthened assertions)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
- `_bmad-output/implementation-artifacts/5-2-bom-lifecycle-and-immutability.md` (modified)

## Change Log

- 2026-08-09: Group 4 adversarial review completed. All 6 patch findings applied:
  engineering-stream write guard in events.ts, BOM TRUNCATE in test after() hooks, strengthened
  gate/checklist assertions, transition-matrix and immutability data-gap tests, migration data/
  skip-taxonomy/idempotency tests, RBAC and weak-assertion fixes. Story 5.2 integration suite
  expanded from 12 to 27 tests (all green). Story 5.1 harness also repaired and strengthened.
- 2026-08-07: Story 5.2 implemented (all 10 tasks). BOM lifecycle draft/released/on_hold/obsolete
  with strict release gate (D4 staging), released-revision immutability, lifecycle audit logging,
  legacy kit migration with exception list. Repaired the never-green Story 5.1 integration
  harness and fixed two latent Story 5.1 handler bugs (missing `business_stream` injection and
  missing `metadata.occurred_at`). Full gate list run; results in Dev Agent Record. Status set
  to review.

## Review Findings

_Chunked adversarial review, Group 1 of 4 (compliance seam only). Baseline af39b5e, 2026-08-09. Blind Hunter + Edge Case Hunter + Acceptance Auditor run in parallel. Findings pending resolution unless marked otherwise._

### Decisions (resolved 2026-08-09)

- [x] [Review][Decision] Migration does not check parent item status - resolved to **patch**: an inactive parent forces `draft_remediation` (AC 5 extended to the header level), never release; keeps the kit on the Epic 13 migration-exceptions surface. [src/compliance/bom.ts:656]
- [x] [Review][Decision] `bom.released` replay is non-deterministic - resolved to **dismiss**: live gate re-evaluation is explicit spec intent (AC 1, clarification 1, binding decision that the gate re-derives truth transactionally; the checklist is deliberately not stored); `alreadyPersisted` short-circuits idempotent replays before the gate; no projection-rebuild capability exists in the codebase. Revisit if a rebuild feature is ever designed. [src/compliance/bom.ts:541]

### Patch findings (applied 2026-08-09)

- [x] [Review][Patch] `base_quantity_per` computed with JS float multiplication, violating the mandatory NUMERIC discipline - overflow/silent rounding on high-scale values that shape validation accepts; also possible PG 22003 500. [src/compliance/bom.ts:747] - applied: computed in PostgreSQL NUMERIC via `$8::numeric * $10::numeric` in the INSERT VALUES.
- [x] [Review][Patch] Migration duplicate-check race: plain SELECT without lock, and `uq_bom_parent_item` is unmapped in the persistEvent 23505 handler, so concurrent same-parent migrations surface a raw 500, not `DUPLICATE_EVENT` 409. Spec Task 7: "never a constraint crash". [src/compliance/bom.ts:643] - applied: `uq_bom_parent_item` and `bom_pkey` mapped to `DUPLICATE_EVENT` 409 in the central 23505 handler (src/events/store.ts).
- [x] [Review][Patch] The four new appliers drop the `occurred_at` validity guard that `applyBomDrafted` performs (bom.ts:796-802); malformed-but-regex-valid ISO dates throw an uncaught RangeError (500). [src/compliance/bom.ts:559, 566, 595, 627, 666] - applied: extracted `assertValidOccurredAt` helper, now used by all five BOM appliers.
- [x] [Review][Patch] Phantom pairing validated in one direction only: `is_phantom: false` with `phantom_source_bom_id` set passes shape, then crashes on `chk_bom_line_phantom_pairing` (23514, unmapped, raw 500). [src/compliance/bom.ts:249] - applied: reverse check added to `assertBomLineInputArray`.
- [x] [Review][Patch] Migration handler must force `draft_remediation` when the parent item master is inactive (D1 resolution): include the parent's A-11 status in the outcome computation so a Released BOM can never carry an inactive parent; flagged kits stay visible on `GET /api/v1/boms/migration-exceptions`. [src/api/v1/boms.ts - migration handler] - applied: outcome computation now starts from `isReleasedItemMaster(parentItem)`; new regression test added.

### Deferred (pre-existing)

- [x] [Review][Defer] Immutability guard accepts a missing or foreign `revision_id` (no existence or bom_id cross-check) - pre-existing: the 5.1 lock also verified nothing; `bom_line` has no FK to `bom_revision`, so a phantom/foreign revision can receive lines and collide on `uq_bom_line_no` (unmapped 23505, 500). Confirm in Group 2 whether handlers constrain `revision_id` server-side. [src/compliance/bom.ts:907, 1019]
- [x] [Review][Defer] `correlation_id` passed unvalidated into a UUID column (PG 22P02 500 on non-UUID) - pre-existing pattern at bom.ts:816 (applyBomDrafted); low reachability since handlers compose it server-side. [src/compliance/bom.ts:706]

### Group 2: API + routes (2026-08-09)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor run in parallel against the same baseline. Group 1 confirmed: the immutability-guard defer (missing/foreign revision_id) is NOT reachable at the API layer - all three consumers derive `revision_id` server-side from `bom.current_revision_id`, never from the request body, and direct engineering-stream posts are rejected (events.ts:39 accepts only stream_type 'inventory')._

### Group 2 decisions (resolved 2026-08-09)

- [x] [Review][Decision] Unbounded migration batch - resolved to **patch**: `kits` capped at 500 with a clear 400 `INVALID_PARAMS`; sync semantics preserved. [src/api/v1/boms.ts:540]

### Group 2 patch findings (applied 2026-08-09)

- [x] [Review][Patch] Malformed kit data crashes the whole batch with a raw 500 instead of a per-kit skip - `components: [null]` (TypeError) or a non-UUID `parent_item_id`/`component_item_id` (PG 22P02, `getItemById` has no UUID guard at item_master.ts:216) throw non-AppError outside the per-kit try/catch, 500-ing after earlier kits already committed. Violates Task 7 "partial success is expected behavior". Also the `invalid_kit` vs `error` skip taxonomy is split for the same class of client bug. [src/api/v1/boms.ts:541, 557, 593] - applied: `invalid_kit` pre-check now validates `parent_item_id` UUID, each component's `component_item_id` UUID / `quantity_per` decimal / `line_uom` non-empty, and rejects duplicate components within a kit - all before any DB access.
- [x] [Review][Patch] Phantom-success migration entries on idempotency replay or duplicate `kit_ref` - `persistEvent` returns the EXISTING event on an idempotency-key hit (store.ts:549), but the handler ignores the returned event and builds the entry around its own fresh `randomUUID()` bom_id, so `getBomById` returns null and the response reports a migrated BOM that does not exist. Trigger: concurrent re-run of the same `batchKey` batch, or two kits sharing a `kit_ref` with different parents. [src/api/v1/boms.ts:602] - applied: the handler now uses `persisted.stream_id` as the effective bom_id and reports a `bom_exists` skip referencing the existing BOM when a replay is detected.
- [x] [Review][Patch] Unvalidated `limit`/`offset` on `GET /api/v1/boms/migration-exceptions` - `Number('abc')` produces NaN that flows into `Math.min(NaN, 200)` and `LIMIT NaN` (raw PG 500); negative/fractional values pass through; and the response echoes the requested limit while `listBoms` silently clamps at 200, so pagination metadata lies. [src/api/v1/boms.ts:691] - applied: `limit`/`offset` parsed with a `\d+` guard, clamped, and echoed at the clamped value.
- [x] [Review][Patch] `kit_ref` accepted untrimmed - only `trim().length > 0` is checked, but the raw string flows into the idempotency key `${batchKey}:${kit_ref}` and the stored `kit_ref` column, so a re-run with different whitespace or Unicode normalization produces duplicate BOMs for the same physical kit. [src/api/v1/boms.ts:267, 639] - applied: `kit_ref` trimmed once per kit and used consistently for the idempotency key, payload, audit details, and response entries.
- [x] [Review][Patch] Duplicate `component_item_id` within one kit inserts duplicate lines with no overlap guard - `applyLegacyKitMigrated` has no dedupe and no `EFFECTIVITY_OVERLAP` check (unlike `applyBomLineAdded`); with `effective_from` defaulting to the same batch business_date, two identical component entries produce two identical non-blocking lines on a Released BOM. [src/api/v1/boms.ts:603] - applied: duplicate components within a kit are rejected as `invalid_kit` in the handler pre-check.

### Group 2 deferred

- [x] [Review][Defer] Cross-revision immutability bypass - `applyBomLineAmended` updates the line by `bom_line_id` with no `revision_id` filter, and both handler and applier validate only the CURRENT revision's status; a future Story 5.3 revision whose current revision is draft could amend an older released revision's lines (violating FR-B-03). Unreachable today: this story is strictly one revision per BOM. Revisit when 5.3 adds revision generation. [src/api/v1/boms.ts:279]
- [x] [Review][Defer] Global idempotency-key reuse silently no-ops a lifecycle transition - `uq_idempotency` is global and `persistEvent` returns the existing event on a key hit, so reusing one key across release then hold (or across different BOMs) drops the transition with a 200 and no error. Pre-existing platform-wide convention (AD-16 caller-carried keys) and the exact Task 6 pattern (`idempotency_key: body.idempotency_key ?? randomUUID()`); the migration handler's per-kit key composition is a documented, necessary deviation. [src/api/v1/boms.ts:434]

### Group 3: schema/SQL/read layer (2026-08-09)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor run in parallel against the same baseline. The Acceptance Auditor confirmed: computed (not stored) release-gate checklist matches the gate's blocking predicates; `chk_bom_status`/`chk_bom_revision_status`/`chk_bom_origin` present in all three places (CREATE TABLE, DROP+ADD, DO guard) in both canonical and mirror; `uq_bom_parent_item` unique; FR-AC-01 registry (drafted/migrated require business stream, lifecycle transitions do not); migration applier INSERT column lists match the bom table; schema-drift test lists `chk_bom_origin`._

### Group 3 patch findings (applied 2026-08-09)

- [x] [Review][Patch] The DROP+ADD constraint pairs in `deploy/compose/init-db.sql` are non-atomic - the file executes statement-by-statement under autocommit (no wrapping transaction; the `BEGIN`s are plpgsql DO blocks), so a failure or interruption after the DROP leaves `chk_bom_status`/`chk_bom_revision_status` silently absent until a re-run. The canonical bom.sql/bom_revision.sql copies are safe (migrate.ts applies each file as one implicit transaction), but the init-db.sql duplicates are not, and the DROP+ADD is the ONLY mechanism that widens the constraint when init-db re-runs against a pre-5.2 database (the DO-block guard skips because the old single-value constraint already exists). Fix: wrap each DROP+ADD pair in a `DO $$ ... END $$` block (plpgsql is transactional). [deploy/compose/init-db.sql:3997, 4064] - applied: both pairs wrapped in transactional DO blocks; the same wrap applied to the canonical bom.sql/bom_revision.sql for mirror parity (schema-drift test requires identical extracted DO blocks).
- [x] [Review][Patch] `business_stream` is typed optional (`business_stream?: string`) in `BomDraftedPayload` and `LegacyKitMigratedPayload` but hard-required by the tagging gate (`requiresBusinessStream: true`), and neither shape validator checks it - so the type, the validator, and the enforcement disagree. Handlers always set it and direct posts are rejected, so this is a typing-truth gap with no runtime reach today. Fix: make it required (`business_stream: string`). [src/events/schema.ts:1391, 1491] - applied: both payload types now declare `business_stream: string`.
- [x] [Review][Patch] Dead write helpers with a trap + INSERT column drift - `updateBomStatus`/`releaseBomRevision` (bom.ts:343, 356) are exported with zero callers (the appliers use inline SQL); `insertBom`/`insertBomRevision` (bom.ts:245, 269) are also dead and their INSERT column lists omit the new 5.2 columns while their widened row types require them, so any future caller would silently drop `origin`/`remediation_flag`/`kit_ref`/`status_changed_at/by`/`released_at/by`. Fix: wire the three lifecycle appliers to `updateBomStatus`/`releaseBomRevision` (identical SQL) and add the new columns to the two INSERT helpers. [src/read/projections/bom.ts:245-286] - applied: `applyBomReleased` now calls `releaseBomRevision` + `updateBomStatus`, `applyBomHeld`/`applyBomObsoleted` call `updateBomStatus`; `insertBom`/`insertBomRevision` INSERTs include all new columns.

### Group 3 deferred

- [x] [Review][Defer] Partial-migration failure window - `bom.sql` and `bom_revision.sql` are applied as separate implicit transactions by migrate.ts, so a process death after bom.sql commits but before bom_revision.sql applies leaves the widened `chk_bom_status` with the Story 5.1 single-value `chk_bom_revision_status`; the new appliers then write `revision_status = 'released'` and hit an unmapped 23514 (raw 500) until migrate is re-run (which heals). New cross-file interdependency (pre-5.2 the two files were independent), but consistent with the repo's established per-file-transaction migration pattern and its documented re-run-heals stance (see the 4-6 deferred entries). [src/events/migrate.ts:80]

### Group 4: tests/guards (2026-08-09)

_Blind Hunter + Edge Case Hunter + Acceptance Auditor run in parallel against the same baseline. The Acceptance Auditor confirmed all 12 Dev Agent Record minimum cases are mapped 1:1 (R1-R12) plus the Group 1/2 regression tests (inactive-parent remediation R8A, 500-kit cap R9A, malformed-kit skip R9B, duplicate kit_ref R9C), the spine allowlist, and the schema-drift `chk_bom_origin` entry; no test asserts anything contradicting the spec or current implementation. The decisive finding (T1) is a production gap surfaced by the test review: the direct-engineering-post rejection tests pass for the wrong reason and no stream guard exists._

### Group 4 patch findings (applied 2026-08-09)

- [x] [Review][Patch] **No engineering-stream write guard (production gap)**: both direct-POST rejection tests (story-5-1.test.ts:640, story-5-2.test.ts:734) post MALFORMED envelopes (non-UUID actor `user_id`, `location_id: '*'`, missing `occurred_at`) that `validateEnvelope` rejects with 400 `INVALID_EVENT_ENVELOPE` before any stream logic runs - so they pass even if engineering direct posts were fully writable. Verified: `postEventBase` (events.ts:115) has no engineering guard; a WELL-FORMED direct `bom.released`/`bom.held`/`bom.obsoleted`/`bom.migrated_from_kit` reaches the applier and actually performs the transition (404 only if the bom does not exist). Spec Task 10 ("direct posts rejected by design") is not enforced in production. Fix: reject `stream_type === 'engineering'` in the events route with a clear 400 error code; rewrite both tests with well-formed envelopes asserting the stream-guard error code. [src/api/v1/events.ts:115, test/integration/story-5-2.test.ts:734, story-5-1.test.ts:640] - applied: engineering stream guard added to `postEventBase`; both direct-POST tests rewritten with valid UUIDs and `INVALID_EVENT_STREAM` assertion.
- [x] [Review][Patch] **No BOM table cleanup in any suite**: zero TRUNCATE statements touch bom/bom_line/bom_revision/bom_structure (verified across all 48 truncate sites); `bom.parent_item_id` has no FK to item_master so the CASCADE truncates elsewhere never reach BOM rows. BOM data accumulates across runs in the shared test DB - currently masked by per-run unique SKUs and newest-first pagination, but it silently poisons any future count-based assertion (migration-exceptions `total`, line counts) and the `data.some` page-1 scans. Fix: add the four BOM tables to the story-5-1/story-5-2 suites' after() truncation. [test/integration/story-5-2.test.ts:223, story-5-1.test.ts:214] - applied: `TRUNCATE TABLE bom_line, bom_revision, bom_structure, bom RESTART IDENTITY CASCADE` added to both suites' after() hooks.
- [x] [Review][Patch] **Gate/checklist response bodies under-asserted**: R2/R3 assert only condition names via `includes`; the offending `blocking_lines`/`scrap` line lists (AC 1 "plus offending bom_line_id/line_no lists") are never checked; the checklist's `bom_lines_present`, `scrap_percent_missing`, staged `approved_eco`/`cost_rollup_complete` (met:null, enforced:false), and blocking-line ids are unasserted; the combined two-condition failure and the release-gate HAPPY path (`ready_to_release: true`) are never tested. [test/integration/story-5-2.test.ts:275, 318] - applied: R2 now asserts `scrap_percent_missing.lines`; R3 now asserts `component_item_masters_released.blocking_lines`; new tests added for combined failure (R3A) and happy-path checklist (R3B).
- [x] [Review][Patch] **Transition-matrix + immutability data gaps**: valid on_hold->obsolete, release->obsolete, and the rejections on_hold->hold and draft->obsolete are untested (matrix "everything else rejects"); immutability is only asserted at the HTTP layer - a regression that mutates and then 409s passes (no re-read of bom_line); reinstatement's "no re-gate" is not proven (component stays active during hold - a deactivation-while-held reinstatement test would prove the gate is skipped); immutability while on_hold and the reinstatement audit `reason` are unasserted. [test/integration/story-5-2.test.ts:387, 334] - applied: new tests for on_hold->obsolete (R5B), on_hold->hold rejection (R5A), draft->obsolete rejection (R5C), immutability while on_hold (R4A), and reinstatement reason in domain_events payload (R5D).
- [x] [Review][Patch] **Migration data + skip-taxonomy + idempotency gaps**: migrated-line completion fields unasserted (base_quantity_per equals quantity_per, uom_conversion_factor '1.00000000', output_class 'component', is_phantom false, sequential line_no, effective_from = business date - also guards the Group 1 NUMERIC fix); draft-remediation line state unasserted (scrap null, blocking_release true, blocking_line_count 1, migration_exempt false); skip paths `parent_item_not_found` and in-batch duplicate parent (`parentsInBatch` -> bom_exists) untested; the pre-existing-BOM `bom_exists` skip never asserts the returned bom_id references the existing BOM; batch re-run idempotency (re-post same batch -> same bom_ids, no double-apply) untested; limit/offset validation on migration-exceptions (limit=abc/0/500/-1, clamp at 200, clamped echo) untested. [test/integration/story-5-2.test.ts:462, 607, 515] - applied: R7 asserts all line completion fields; R8/R8A assert line state and API-level `migration_exempt`; new tests for parent_item_not_found (R9D), in-batch duplicate parent (R9E), batch re-run idempotency (R9F), and limit/offset validation (R13).
- [x] [Review][Patch] **RBAC + weak assertions**: 403 coverage omits hold/obsolete (only release + migration tested) and the read-route `GET /api/v1/boms/migration-exceptions` is never exercised by a read-only user; `rejects BOM creation with invalid scrap percent` asserts only status 400 (no error code - every sibling asserts the code); add/amend-line tests never re-fetch structure to confirm the mutation landed; the test titled "rejects BOM creation with inactive component" actually asserts 201. [test/integration/story-5-2.test.ts:759, story-5-1.test.ts:364, 577, 269] - applied: R11 expanded to test hold/obsolete/migration 403 with error codes plus read-only access to migration-exceptions; story-5-1 scrap-percent test now asserts `BOM_INVALID_SCRAP_PERCENT`; add-line and amend-line tests re-fetch structure to confirm mutations landed.
