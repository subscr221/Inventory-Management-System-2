---
baseline_commit: 21a3235e49495a0fb874c0c6b3ad242fdf7e092c
---

# Story 5.5: Approved Alternates and BOM Explosion

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-12. Comprehensive developer guide created from epics.md (E5-13 amended text), ARCHITECTURE-SPINE.md, PRD FR-B-07/FR-B-12 long forms, stories 5.1 to 5.4 records, deferred-work ledger, and a full baseline code audit. -->

## Story

As a production planner,
I want approved alternates with priority and effectivity, controlled ad-hoc substitutions, and a BOM explosion service that generates directed-issue or backflush requirements per plant,
So that execution consumes the right materials in the right order of preference.

## Acceptance Criteria

1. **Given** a Released BOM component with approved alternates (FR-B-12), **When** alternates are defined, **Then** each alternate carries a priority and effectivity window and is available to execution in priority order.
2. **Given** an operator wants to substitute a material not on the approved alternates list (FR-B-12), **When** the substitution is attempted, **Then** it requires a logged approval resolved from the DOA registry (FR-DOA-01), returning `error_code: "APPROVAL_REQUIRED"`, and the substitution is written to the edit log.
3. **Given** a Released BOM and an order quantity submitted to the explosion service (FR-B-07), **When** the BOM is exploded to execution, **Then** directed-issue or backflush requirements are generated per line according to the supply method, verified by contract tests against the service (input: Released BOM + quantity; output: per-line requirement set); production-order release (Epic 6, FR-MO-03) invokes this same service when it lands.
4. **Given** a plant that executes offline (FR-B-07), **When** Released BOM structures are replicated to that plant's edge devices, **Then** the explosion inputs for the plant's effective Released BOMs are replicated per plant for offline continuity via PowerSync.

## Tasks / Subtasks

- [x] Task 1: Database schema for alternates, explosions, and supply method (AC: 1, 2, 3)
  - [x] 1.1 Create canonical `read/projections/bom_alternate.sql` per the Database Schema Contract: `bom_alternate_id` UUID PK, `bom_id`, `revision_id`, `bom_line_id`, `component_item_id`, `alternate_item_id`, `priority INTEGER`, `effective_from DATE`, `effective_to DATE NULL`, `origin TEXT` CHECK in ('approved','ad_hoc'), nullable `doa_entry_id` + `approver_actor_id` with the ad-hoc pairing CHECK, `source_event_id`, timestamps. Unique index `uq_bom_alternate_entry` on (bom_line_id, alternate_item_id, effective_from). CHECK `chk_bom_alternate_priority` (priority >= 1). Idempotent CREATE TABLE IF NOT EXISTS, DO-block grants (`INSERT, SELECT, UPDATE` to app_user, SELECT to readonly_user).
  - [x] 1.2 Create canonical `read/projections/bom_explosion.sql`: header table for explosion runs (`explosion_id` UUID PK, `bom_id`, `revision_id`, `order_quantity NUMERIC NOT NULL`, `business_date DATE`, `depth_truncated BOOLEAN`, `requirement_count INTEGER`, `exploded_by`, `correlation_id`, `source_event_id`, timestamps). Unique index `uq_bom_explosion_source_event` on (source_event_id). Grants as in 1.1.
  - [x] 1.3 Create canonical `read/projections/bom_explosion_line.sql`: requirement rows (`explosion_line_id` UUID PK, `explosion_id`, `depth INTEGER` CHECK >= 0, `path TEXT`, `source_bom_id`, `source_revision_id`, `bom_line_id`, `line_no INTEGER`, `component_item_id`, `component_sku`, `supply_method TEXT` CHECK in ('directed_issue','backflush'), `required_quantity NUMERIC NOT NULL` unbounded, `scrap_percent NUMERIC(9,6) NULL`, `base_quantity_per NUMERIC(18,8)`, `has_child_bom BOOLEAN`, `via_phantom BOOLEAN`, `alternates JSONB NOT NULL DEFAULT '[]'`, `source_event_id`, timestamps). Unique index `uq_bom_explosion_line_no` on (explosion_id, path, line_no). Grants as in 1.1.
  - [x] 1.4 Add `supply_method` to `bom_line` additively: `ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_method TEXT NOT NULL DEFAULT 'directed_issue'` plus CHECK `chk_bom_line_supply_method` in ('directed_issue','backflush') wrapped in a guarded `DO $$` DROP-then-ADD block (the Story 3.9/5.4 constraint-swap pattern). The column MUST also be added inside the canonical CREATE TABLE body so the schema-drift `extractCreateTable` comparison passes.
  - [x] 1.5 Register all three new SQL files at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (never reorder existing entries).
  - [x] 1.6 Mirror every change byte-for-byte into `deploy/compose/init-db.sql` (three new tables + the widened `bom_line` CREATE body and guarded constraint block).
  - [x] 1.7 Add `EXPECTED` entries for `bom_alternate`, `bom_explosion`, `bom_explosion_line` in `test/unit/schema-drift.test.ts` and extend the `bom_line` entry for the new column and constraint. Add a Story 5.5 additive-column `it()` block mirroring the Story 5.4 block (test lines 936-969 pattern).
- [x] Task 2: Event schema and registry (AC: 1, 2, 3)
  - [x] 2.1 In `src/events/schema.ts` add three payload interfaces and `Omit<EventEnvelope, 'payload'>` envelope pairs under a Story 5.5 banner: `BomAlternateDefinedPayload`/`Envelope` for `bom.alternate_defined`, `BomSubstitutionApprovedPayload`/`Envelope` for `bom.substitution_approved`, `BomExplodedPayload`/`Envelope` for `bom.exploded`. Epics PascalCase names (`AlternateDefined`, `SubstitutionApproved`, `BomExploded`) map to these dot-separated spine-convention types.
  - [x] 2.2 Payload contracts: all three carry `bom_id`, `revision_id`, `occurred_at`-derived `business_date` where relevant. `bom.alternate_defined` carries `bom_alternate_id`, `bom_line_id`, `component_item_id`, `alternate_item_id`, `priority`, `effective_from`, `effective_to`, `origin: 'approved'`, `line_no`. `bom.substitution_approved` carries the same fields plus `origin: 'ad_hoc'`, `doa_entry_id`, `approver_actor_id` (both REQUIRED, resolved at capture). `bom.exploded` carries `explosion_id`, `order_quantity`, `business_date`, `depth_truncated`, `requirements` (the full per-line requirement array, capture-time computed so replay is deterministic).
  - [x] 2.3 Register all three in `SUPPORTED_EVENT_TYPES` appended at the tail of the registry: `streamType: 'engineering'`, `requiresBusinessStream: false` for all three (they act on already-tagged BOM aggregates; business stream is derived server-side from the BOM header, never accepted from the request body).
- [x] Task 3: Compliance seam for the execution events (AC: 1, 2, 3)
  - [x] 3.1 Create `src/compliance/bom-execution.ts` structurally cloning `src/compliance/eco.ts`: `BOM_EXECUTION_EVENT_TYPES` set, `bomExecutionEventType` gate, `assertBomExecutionShape` (pre-transaction, no DB: UUID/decimal/date shape asserts, priority integer >= 1, origin vocabulary, ad-hoc pairing of `doa_entry_id`/`approver_actor_id`), `applyBomExecutionProjection` (in-transaction switch over the three event types). Use the `reject(code, message, details?, status)` AppError helper pattern from `bom.ts`.
  - [x] 3.2 `applyBomAlternateDefined` and `applyBomSubstitutionApproved` share one applier body: `alreadyPersisted` guard, `FOR UPDATE` lock the `bom` row (`BOM_NOT_FOUND` 404), `assertNotRdDraft` (imported from `src/compliance/bom.ts`), require `status = 'released'` (`BOM_NOT_RELEASED` 409), lock the `bom_revision` row and require `revision_status = 'released'` and `bom.current_revision_id = revision_id` (`INVALID_PARAMS` 409), fetch the `bom_line` row scoped `WHERE bom_line_id AND revision_id` (`BOM_LINE_NOT_FOUND` 404; the 5.3 cross-revision scoping rule), reject placeholder lines (`component_item_id IS NULL`) with `INVALID_PARAMS`, verify `alternate_item_id` exists and `isReleasedItemMaster` (imported from `src/compliance/bom.ts`) else `BOM_ITEM_NOT_ACTIVE` 409, run the effectivity-overlap predicate against existing alternates for the same (bom_line_id, alternate_item_id) reusing the `EFFECTIVITY_OVERLAP` 409 semantics, run the open-priority conflict check (`ALTERNATE_PRIORITY_CONFLICT` 409: another alternate for the same line with the same priority whose window is still open, i.e. `effective_to IS NULL`), reject ad-hoc duplication of an existing approved alternate with `ALTERNATE_ALREADY_APPROVED` 409, then `insertBomAlternate` from the payload (never from request-time state).
  - [x] 3.3 `applyBomExploded`: `alreadyPersisted` guard, re-lock the `bom` row, `assertNotRdDraft`, require `status = 'released'` and `current_revision_id = payload.revision_id` (stale-guard `INVALID_PARAMS` 409), insert the `bom_explosion` header and every `requirements[]` row into `bom_explosion_line` exactly as captured (the applier recomputes NOTHING; explosion math lives at capture time in the handler-called service so replay is byte-deterministic), validate `requirement_count` equals the array length.
  - [x] 3.4 Wire into `src/events/store.ts` at the two existing seams: `assertBomExecutionShape(envelope);` in the pre-transaction assert block immediately after `assertRdShape` (around store.ts:500), and `await applyBomExecutionProjection(envelope, client, eventId);` in the in-transaction block immediately after `applyRdProjection` (around store.ts:756). Add 23505 constraint mappings for `uq_bom_alternate_entry`, `uq_bom_explosion_source_event`, and `uq_bom_explosion_line_no` to `DUPLICATE_EVENT` 409 in the existing constraint mapper (store.ts:847-994 pattern).
- [x] Task 4: Read projection accessors (AC: 1, 3)
  - [x] 4.1 Create `src/read/projections/bom_alternate.ts`: `BomAlternateRow` interface matching Task 1.1, `insertBomAlternate`, `getAlternatesByBomLine(bomLineId, client?)`, `getAlternatesByBom(bomId, client?)` ordered by component then priority ASC, `getOpenAlternatesForLineOnDate(bomLineId, istDate, client?)` applying `effective_from <= date AND (effective_to IS NULL OR effective_to >= date)` ordered by `priority ASC` (this is the "available to execution in priority order" accessor). All with UUID regex guards and the `runner(client ?? getPool())` pattern.
  - [x] 4.2 Create `src/read/projections/bom_explosion.ts`: `BomExplosionRow` and `BomExplosionLineRow` interfaces, `insertExplosion`, `insertExplosionLine`, `getExplosionById(explosionId, client?)`, `getExplosionLines(explosionId, client?)` ordered by path then line_no, `listExplosionsByBom(bomId, {limit, offset}, client?)` with the clamped-limit pattern.
  - [x] 4.3 Extend `src/read/projections/bom.ts`: add `supply_method: string` to `BomLineRow`, add it to the `insertBomLine` column list, and thread it through `getBomLines` (SELECT list). No other accessor changes.
- [x] Task 5: Explosion service (AC: 3)
  - [x] 5.1 Create `src/engineering/bom-explosion.ts` exporting `explodeBomForExecution(input: { bom_id: string; quantity: string; occurred_at?: string }, client?): Promise<ExplosionResult>`. This exported function IS the Epic 6 (FR-MO-03) integration surface: it must stay pure (no HTTP, no event emission, no persistence), take an optional `PoolClient` so Epic 6 can call it inside its own release-gate transaction, and return the typed requirement set. Epic 6 imports it; it never re-implements it.
  - [x] 5.2 Guard sequence (fail-closed, exact order): `getBomById` (`BOM_NOT_FOUND` 404), `assertNotRdDraft(bom)` imported from `src/compliance/bom.ts` (`RD_EXECUTION_BARRED` 409; the Story 5.4 handoff contract, AC 2 of Story 5.4 names explosion explicitly), `status === 'released'` (`BOM_NOT_RELEASED` 409), `current_revision_id` present, quantity via `assertDecimalString` discipline (`EXPLOSION_QUANTITY_INVALID` 400; string-only, finite, strictly positive, scale within NUMERIC(18,6), max `999999999999.999999`).
  - [x] 5.3 Derive `business_date` as the IST calendar date of `occurred_at` (default now) using the existing `toIstCalendarDate` helper pattern from `src/compliance/eco.ts`. Line effectivity filter: `effective_from <= business_date AND (effective_to IS NULL OR effective_to >= business_date)`.
  - [x] 5.4 Implement the walk as ONE `WITH RECURSIVE` CTE over `bom_line` joined to `bom` (mirroring the `where_used_impact.ts` CTE precedent but DOWNWARD): start from the current released revision's effective lines, descend into any component whose `component_item_id` is the `parent_item_id` of another Released BOM (`bom.status = 'released'`, non-rnd, join on `getBomByParentItemId` semantics), multiplying quantities through. All arithmetic in PostgreSQL NUMERIC (`::numeric` casts in the CTE expressions, never JS floats): `required_quantity = parent_required * base_quantity_per * (1 + scrap_percent/100)` with NULL scrap treated as 0. Depth-capped at `config.bom.maxDepth` (src/config/index.ts:278, default 20, env `BOM_MAX_DEPTH`) reporting `depth_truncated: true` in the result when the cap binds. Cycle defense: use the PG `CYCLE` clause (Story 5.3 precedent) or a path-visited predicate; on a cycle throw `BOM_EXPLOSION_CYCLE_DETECTED` 409. This defends the explosion walk only; it does NOT implement Story 5.1's unimplemented authoring-time `BOM_CYCLE_DETECTED`.
  - [x] 5.5 Line semantics in the walk: only `output_class = 'component'` lines generate requirements (co_product/by_product lines are outputs, never inputs). `is_phantom = true` lines pass through: the phantom itself never appears as a requirement; its children (from `phantom_source_bom_id`'s released revision, else the phantom component's released BOM) appear with multiplied quantity and multiplicative scrap accumulation, flagged `via_phantom = true` (Story 5.1 phantom model). Every requirement row carries `depth`, `path`, `source_bom_id`, `source_revision_id`, `bom_line_id`, `line_no`, `component_item_id`, `component_sku`, `supply_method`, `required_quantity` (exact decimal string), `scrap_percent`, `base_quantity_per`, `has_child_bom`, `via_phantom`. Placeholder lines (`component_item_id IS NULL`) cannot exist on Released BOMs (5.4 guard); skip them defensively and never emit a requirement for them.
  - [x] 5.6 For each requirement row attach `alternates`: open alternates for that `bom_line_id` on `business_date` from `getOpenAlternatesForLineOnDate` (`{alternate_item_id, component_sku, priority, origin}` ordered by `priority ASC` exactly as AC 1 requires).
  - [x] 5.7 Return `{ explosion_id (minted UUIDv4), bom_id, revision_id, order_quantity, business_date, depth_truncated, requirements }`. Quantities leave the DB as strings and stay strings end-to-end.
- [x] Task 6: API handlers, routes, spine allowlist (AC: 1, 2, 3)
  - [x] 6.1 Create `src/api/v1/bom-execution.ts` with the handler skeleton from `src/api/v1/boms.ts` (`actorContext`, `auditCtxFor`, envelope literal with `stream_type: 'engineering'`, `metadata.occurred_at: new Date().toISOString()`, `idempotency_key: body.idempotency_key ?? randomUUID()`, `persistEvent` in try/catch mapping `AppError` to `sendRequestError`, response built from `persisted.stream_id` never a locally minted id, durable read-back from the projection). Five handlers: `defineAlternateBase` (POST, mints `bom_alternate_id` at capture, resolves `component_item_id` and `line_no` server-side from the line, derives `business_stream` server-side from the BOM header), `approveSubstitutionBase` (POST, DOA flow below), `explodeBomBase` (POST, calls `explodeBomForExecution` then persists `bom.exploded` with the computed requirement set embedded in the payload, returns 201 with the requirement set), `getExplosionBase` (GET by id), `listBomAlternatesBase` (GET alternates read model).
  - [x] 6.2 DOA ad-hoc substitution flow in `approveSubstitutionBase` (AC 2, AD-3): export `BOM_SUBSTITUTION_DOA_TYPE = 'bom_substitution'`; `const approval = await resolveApprover(BOM_SUBSTITUTION_DOA_TYPE, 0)` (imported from `src/api/v1/indents.ts`); if `!approval.requiresApproval` (no governing DOA entry) reject 409 `APPROVAL_UNRESOLVED` with `{ transaction_type }` details (fail-closed: ad-hoc substitution ALWAYS requires approval, so a missing entry must block, unlike optional-approval flows); if `approval.approverActorId !== actor.userId` reject 403 `APPROVAL_REQUIRED`; else persist `bom.substitution_approved` with `doa_entry_id`/`approver_actor_id` stamped from the resolution (capture-time, deterministic replay). The edit-log requirement is satisfied by `persistEvent`'s `logAuditEntry` with the passed `auditCtxFor`; assert the audit row exists in a test. No notification emission (AD-17 applies only to routed decisions; the approver records this themselves, Story 5.4 sign-off precedent).
  - [x] 6.3 RBAC: wrap every handler in `requireRole({ module: 'engineering', functionScope: 'write' })` for mutations and `'read'` for GETs (no role-name literals anywhere; `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces). No site scoping (BOM is enterprise-scoped per Story 5.4 binding decision).
  - [x] 6.4 Register five routes in `createAppRouter()` in `src/server.ts` in a Story 5.5 block after the Story 5.4 block: `POST /api/v1/boms/:bomId/alternates` (define), `GET /api/v1/boms/:bomId/alternates` (read model), `POST /api/v1/boms/:bomId/substitution-approvals` (ad-hoc DOA approval, body carries `bom_line_id` + `alternate_item_id`), `POST /api/v1/boms/:bomId/explosion`, `GET /api/v1/bom-explosions/:explosionId`. All second segments are literals distinct from `:bomId`-only routes, so no route-order trap; still register the literal-collection routes above any new param route per the Story 5.2 lesson.
  - [x] 6.5 Append all five routes to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` or the spine gate fails.
- [x] Task 7: PowerSync replication of Released BOM explosion inputs (AC: 4)
  - [x] 7.1 Extend `sync/migrations/powersync.sql` idempotently: guarded `DO $$` block executing `ALTER PUBLICATION powersync_publication ADD TABLE bom, bom_revision, bom_line, bom_alternate` (swallow the already-exists error), plus `GRANT SELECT ON bom, bom_revision, bom_line, bom_alternate TO svc_powersync`. Mirror both into `deploy/compose/init-db.sql` (extend the existing publication creation line and the grants block). `bom_explosion`/`bom_explosion_line` are NOT replicated: explosion runs are central planning records; the explosion INPUTS (structure + alternates) are what AC 4 names.
  - [x] 7.2 Add a parameterless (global) bucket to `sync/sync-rules.yaml`, e.g. `released_bom_structure`, with four data queries selecting explicit columns with an `id` alias: Released `bom` rows (`status = 'released'`), their `bom_revision` rows (`revision_status = 'released'`), their `bom_line` rows, and their `bom_alternate` rows. BINDING INTERPRETATION of "per plant": BOM is enterprise-scoped with no site or plant column (Story 5.4 binding decision; FR-B-01 plant applicability is expressed through line effectivity windows, not row ownership), so every plant's edge devices receive the full Released-BOM explosion-input set via the global bucket. Do NOT add a site_id column to any BOM table.
  - [x] 7.3 Add synced (non-localOnly) table definitions for `bom`, `bom_revision`, `bom_line`, `bom_alternate` to `edge/src/local-db/schema.ts` mirroring the Postgres columns the bucket selects. No new edge capture screens, no outbox change, no connector change: this is downstream reference data only. Verify `npm run edge:typecheck`, `edge:lint`, `edge:build`, and `edge:test` stay green (baseline 30/30).
  - [x] 7.4 Verify with `npm run db:migrate` run twice (publication ALTER guarded) and, where the environment allows, `sync/smoke-test.ps1`. Document in completion notes if the PowerSync service itself could not be exercised in the dev environment; the contractual surface is the publication + grants + rules + edge schema.
- [x] Task 8: Integration contract tests and gates (AC: 1, 2, 3, 4)
  - [x] 8.1 Create `test/integration/story-5-5.test.ts` cloning the Story 5.4 harness verbatim (`makeRequest`, `authFor`, `provisionUser` with the SCIM bearer `test-only-scim-bearer-token-not-for-production-use`, admin-pool re-application of needed canonical SQL, `createAppServer(createAppRouter()).listen(0)`, TRUNCATE teardown covering `bom_explosion_line, bom_explosion, bom_alternate, bom_line, bom_revision, bom_structure, bom, doa_vacation_delegations, doa_registry_entries, user_role_assignments, users`).
  - [x] 8.2 Seed a DOA entry `{ transaction_type: 'bom_substitution', role: <approver role>, value_min: null, value_max: null }` via `POST /api/v1/doa/entries` with a compliance-write user, and provision the approver user with module engineering write (Story 5.3/5.4 seeding block).
  - [x] 8.3 Contract tests for AC 3 (the AC's mandated contract suite): build a two-level Released BOM fixture (parent with component lines incl. one phantom line, one backflush line, one line with scrap percent, and a child Released BOM for one component), then assert: input Released BOM + quantity produces the exact per-line requirement set; quantities are exact NUMERIC strings (e.g. `String(row.required_quantity)` equality, never parseFloat); scrap-adjusted math is correct; phantom children appear `via_phantom` with multiplied quantity and the phantom itself is absent; co_product lines are absent; `supply_method` propagates per line; depth and path are correct; `has_child_bom` flags are correct.
  - [x] 8.4 AC 1 tests: define two alternates on a Released line with priorities 1 and 2 and effectivity windows; assert explosion lists them in priority order; assert `ALTERNATE_PRIORITY_CONFLICT` on duplicate open priority; assert `EFFECTIVITY_OVERLAP` on overlapping windows for the same alternate item; assert alternates outside their effectivity window on the explosion `business_date` are excluded; assert alternate definition on a Draft BOM (`BOM_NOT_RELEASED`), on a placeholder line, and on an inactive item master are all rejected.
  - [x] 8.5 AC 2 tests: ad-hoc substitution by the resolved DOA approver succeeds and lands as `origin = 'ad_hoc'` with `doa_entry_id`/`approver_actor_id` populated and an edit-log (audit) row; attempt by a non-approver returns 403 `APPROVAL_REQUIRED`; a fixture with NO governing DOA entry returns 409 `APPROVAL_UNRESOLVED`; substituting an item already on the approved alternates list returns 409 `ALTERNATE_ALREADY_APPROVED`.
  - [x] 8.6 Execution-bar and state tests: explosion of an R&D draft BOM returns 409 `RD_EXECUTION_BARRED` (proves Story 5.4 AC 2's explosion half on the real service); explosion of on_hold/obsolete and draft production BOMs returns `BOM_NOT_RELEASED`; zero/negative/malformed quantity returns `EXPLOSION_QUANTITY_INVALID`.
  - [x] 8.7 Platform-gate tests: direct `POST /api/v1/events` with a WELL-FORMED envelope (valid UUIDs, valid occurred_at, non-empty actor fields) for each of the three new event types returns 400 `INVALID_EVENT_STREAM` (the engineering-stream guard; a malformed envelope would pass for the wrong reason via `INVALID_EVENT_ENVELOPE`); RBAC `FUNCTION_ACCESS_DENIED` for a non-engineering module user; idempotent replay with the same `idempotency_key` returns the original explosion (body equality) and persists exactly one `bom_explosion` row.
  - [x] 8.8 Run full gates: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test` (baseline: 14 pre-existing idempotency failures across Epic 1 to 3 suites, ZERO new), `npm run spine-acceptance-contract` 6/6, schema-drift suite green with the three new entries, story-5-1/5-2/5-3/5-4 regression suites green with zero assertion edits, edge typecheck/lint/build/test unchanged, `git diff --check` clean, then `graphify update .`.

## Dev Notes

### Binding Scope Decisions

- This story is GREENFIELD inside the existing BOM module. Verified at baseline 21a3235: no `explode`, `explosion`, or `alternate` code exists anywhere in `src/`. Build new; do not refactor 5.1 to 5.4 behavior.
- Three events only, matching the epics Dev Notes contract: `bom.alternate_defined`, `bom.substitution_approved`, `bom.exploded`. All on `streamType: 'engineering'` with `requiresBusinessStream: false` (transitions on already business-stream-tagged BOM aggregates; `business_stream` is copied server-side from the BOM header into persisted rows where needed, never accepted from the request body).
- New canonical tables: `bom_alternate`, `bom_explosion`, `bom_explosion_line`. New additive column: `bom_line.supply_method`. No other schema changes. `bom_structure` stays unpopulated and unread (Story 5.1 debt, still open; explosion persists its output to `bom_explosion_line` instead).
- Ad-hoc substitutions materialize as `bom_alternate` rows with `origin = 'ad_hoc'` plus DOA evidence, so the alternates-by-component read model serves both approved alternates and approved ad-hoc substitutions in one priority-ordered stream. There is no separate substitution table.
- Alternates are keyed per BOM LINE (`bom_line_id`), per FR-B-12's "per-line approved alternates". Binding consequence: when an ECO creates a new revision (Story 5.3 copies lines with fresh `bom_line_id` values), alternates do not carry over automatically; the new revision's lines get fresh alternate definitions. This is correct per the FR and acceptable for Phase 1; document it in completion notes.
- Explosion is computed at CAPTURE time by the exported service, embedded in the `bom.exploded` payload, and persisted verbatim by the applier (deterministic replay per the 5.3/5.4 capture-time-resolution rule). The applier never recomputes.
- Cost rollups, the `cost_rollup_complete` release-gate condition (stays staged `enforced: false` in `STAGED_CONDITIONS`, untouched), job-work kit tagging, and ERP outbound sync are Story 5.6. Do not touch them.
- No notifications, no edge capture screens, no new dependencies, no PostgreSQL extensions, no web framework. ESM rules unchanged: `.js` extensions on relative imports, `node:` prefixed builtins.
- There is NO user-facing screen in this story: it is a central-plane desk workflow (REST API) plus downstream reference replication. No UX contract document exists for this domain (epics UX Design Requirements section), so there is no UX design to violate and none to build.

### Story 5.4 Handoff Contract (must consume, never re-derive)

- Import `assertNotRdDraft(bom: { bom_id: string; bom_type: string })` from `src/compliance/bom.ts` (bom.ts:123) and call it in: (a) the explosion service guard sequence, (b) the alternate/substitution appliers. Story 5.4's binding instruction: "Story 5.5 (BOM explosion, FR-B-07) and Epic 6 (production-order release, FR-MO-03) import and call it; neither re-derives the predicate." Its doc comment at bom.ts:119-122 says exactly this.
- Import `isReleasedItemMaster(item)` from `src/compliance/bom.ts` (bom.ts:113) for every alternate-item activity check. "Released item master" means `item_master.status = 'active'` (there is no released state; A-11 binding from Story 5.1). Never re-derive with ad-hoc SQL.
- `bom_type = 'rnd'` IS the rd_draft regime flag. There is no separate flag column. R&D drafts cannot be Released, so they can never host alternates or explosion; the tests prove `RD_EXECUTION_BARRED` on the explosion path.

### Event Contract

Table 1 defines the three new events. All are appended at the tail of `SUPPORTED_EVENT_TYPES`; payload and envelope interfaces follow the exact `Omit<EventEnvelope, 'payload'>` pair pattern at schema.ts:1403.

Table 1: New event registry entries for Story 5.5

| event_type | streamType | requiresBusinessStream | stream_id | Payload-minted capture-time IDs |
| --- | --- | --- | --- | --- |
| `bom.alternate_defined` | `engineering` | `false` | `bom_id` | `bom_alternate_id` |
| `bom.substitution_approved` | `engineering` | `false` | `bom_id` | `bom_alternate_id`, `doa_entry_id`, `approver_actor_id` |
| `bom.exploded` | `engineering` | `false` | `bom_id` | `explosion_id`, full `requirements` array |

- Every envelope MUST stamp `metadata.occurred_at` (omitting it crashes `persistEvent` with a 500) and use `idempotency_key: (body.idempotency_key as string) ?? randomUUID()` in handlers.
- Shape asserts run PRE-transaction so a malformed event never consumes an idempotency key; appliers run IN the persist transaction and begin with the `alreadyPersisted` guard plus a post-lock re-check for concurrent same-key retries (Story 5.4 review patch pattern, rd-bom.ts:494/603/776).
- Handlers use `persisted.stream_id` (never a locally minted UUID) when building responses (Story 5.2 Group 2 phantom-success lesson).

### Database Schema Contract

- Canonical SQL lives in `read/projections/` at REPO ROOT (not under `src/`); TS accessors live in `src/read/projections/`. Every file is idempotent, self-granting, and mirrored byte-for-byte into `deploy/compose/init-db.sql`; the schema-drift test enforces CREATE-body equality, guarded constraint-block equality, index presence, and grants. CHECK constraint swaps use transactional `DO $$` DROP-then-ADD blocks; additive columns go into BOTH the `ADD COLUMN IF NOT EXISTS` statement and the CREATE TABLE body.
- The full `bom_line` column contract is in `src/read/projections/bom.ts` `BomLineRow` (lines 43-71): note `component_item_id` and `component_sku` are NULLABLE (Story 5.4 placeholders) and every new query touching them must be NULL-safe. `supply_method` joins this list via Task 1.4.
- NUMERIC discipline (binding, recurring review defect if violated): quantities, percents, and balances travel as exact decimal strings end-to-end; ALL arithmetic happens in PostgreSQL NUMERIC (`$n::numeric` casts), never JS floats; PostgreSQL 18 silently rounds excess scale, so reject oversized scale before storage; equality is `$1::numeric = $2::numeric` (see `numericEqual` in rd-bom.ts); string validators must reject hex/scientific junk (`Number('0x10')` passes numeric checks then dies in NUMERIC input syntax as a raw 500); `limit`/`offset` get the `\d+` guard plus clamp plus echo-clamped-value pattern.
- `required_quantity` and `order_quantity` are unbounded `NUMERIC` columns: the explosion product `qty * base_quantity_per * (1 + scrap/100)` can exceed (18,6) scale, and unbounded storage avoids silent rounding entirely.

### Compliance Seam Contract

- `src/compliance/bom-execution.ts` clones the two-phase structure of `eco.ts` and `rd-bom.ts`: event-type set, gate function, `assertBomExecutionShape` (synchronous, no DB), `applyBomExecutionProjection` (async, takes `client` + `eventId`). Errors throw via the `reject(code, message, details?, status = 400)` AppError pattern with per-throw HTTP status (400 shape, 404 not-found, 409 state/gate/conflict, 403 authority).
- Lock order in appliers: `bom` row `FOR UPDATE` first, then `bom_revision`, then `bom_line` scoped by `(bom_line_id, revision_id)`. Never `FOR UPDATE` on `domain_events` (PostgreSQL 42501; Story 4.3 lesson); the idempotent-replay guard is a plain SELECT.
- `store.ts` wiring points are the two existing seams only (pre-transaction assert block around line 500, in-transaction applier block around line 756). Do not reorder existing entries. Add the three new unique constraints to the 23505 mapper as `DUPLICATE_EVENT` 409 branches (pattern at store.ts:976-992).

### Explosion Service Contract

- Exported surface (the Epic 6 contract): `explodeBomForExecution(input, client?)` from `src/engineering/bom-explosion.ts`, returning `{ explosion_id, bom_id, revision_id, order_quantity, business_date, depth_truncated, requirements }`. Pure read-plus-compute: no persistEvent, no HTTP, no side effects. Epic 6's FR-MO-03 release gate will call it inside its own transaction with a `PoolClient`.
- One recursive CTE, NUMERIC math in SQL, depth cap `config.bom.maxDepth` (default 20) with `depth_truncated: true` reporting, PG `CYCLE` clause or path-visited defense throwing `BOM_EXPLOSION_CYCLE_DETECTED` 409 (walk defense only; authoring-time cycle detection remains Story 5.1 debt, unimplemented, do not expand scope).
- Requirement rows: only `output_class = 'component'` lines; phantoms pass through with multiplied quantity and multiplicative scrap (Story 5.1 model); scrap-adjusted quantity per FR-B-07 long form ("using scrap-adjusted quantity-per"); effectivity evaluated against the IST `business_date` of `occurred_at`; each row carries its priority-ordered open alternates.
- The HTTP explosion route wraps the service: call service, build `bom.exploded` envelope with the result embedded, `persistEvent`, respond 201 with the requirement set read back from `bom_explosion_line` (durable read-back, not the in-memory array).

### API Contract

Table 2 lists the five new routes. All are under `/api/v1/`, SSO-gated, module `engineering` RBAC, enterprise-scoped (no site filter), and logged to the edit log via `persistEvent`'s audit entry with `trace_id`.

Table 2: New REST routes for Story 5.5

| Method and path | Handler | RBAC scope | Success |
| --- | --- | --- | --- |
| `POST /api/v1/boms/:bomId/alternates` | defineAlternate | engineering write | 201 |
| `GET /api/v1/boms/:bomId/alternates` | listBomAlternates (alternates-by-component read model) | engineering read | 200 |
| `POST /api/v1/boms/:bomId/substitution-approvals` | approveSubstitution (DOA `bom_substitution`) | engineering write | 201 |
| `POST /api/v1/boms/:bomId/explosion` | explodeBom | engineering write | 201 |
| `GET /api/v1/bom-explosions/:explosionId` | getExplosion | engineering read | 200 |

- DOA resolution uses the exported `resolveApprover(transactionType, value)` from `src/api/v1/indents.ts:66` at capture time; approval authority compares `approval.approverActorId !== actor.userId` and returns 403 `APPROVAL_REQUIRED`; a governing entry with no holder surfaces as 409 `APPROVAL_UNRESOLVED` (resolveApprover throws it); NO governing entry at all also returns 409 `APPROVAL_UNRESOLVED` from the handler because ad-hoc substitution approval is mandatory (fail-closed; this differs from optional-approval flows where `requiresApproval: false` skips approval).
- The error envelope is always `{ error_code, message, details, trace_id }` via `sendRequestError`/`AppError`.

### PowerSync Replication Contract

- Today ONLY `domain_events` is published (`sync/migrations/powersync.sql`) and the single `edge_site_events` bucket in `sync/sync-rules.yaml` filters events by `metadata.actor.location_id = bucket.site_id`. No read-model table is replicated anywhere. Story 5.5 adds the first downstream read-model replication; keep it minimal and additive.
- Publication extension (guarded, idempotent): add `bom`, `bom_revision`, `bom_line`, `bom_alternate` to `powersync_publication`; grant SELECT on those four tables to `svc_powersync` (role already created by `deploy/pipeline/ci/db-roles.sql`). Mirror into `deploy/compose/init-db.sql`.
- Sync rules: one new parameterless global bucket (`released_bom_structure`) selecting Released-BOM rows from the four tables with explicit column lists and an `id` alias per PowerSync convention. Verified against official PowerSync documentation (docs.powersync.com/sync/rules/global-buckets): any bucket definition with no `parameters` query is automatically a Global Bucket synced to all connected clients, which is exactly the "explosion inputs replicated to every plant" semantics AC 4 requires. Legacy YAML sync rules remain fully supported on the self-hosted PowerSync Service this project pins (1.23.x); migrating to Sync Streams is out of scope. Because BOM is enterprise-scoped (no site column exists and none may be added), every plant receives the same Released explosion-input set; "per plant" is satisfied by every plant's edge devices holding the full set, and plant-specific applicability is expressed via line effectivity windows. The documentation also mandates that sync-rule source table names match the client-side schema table names exactly, so the edge table definitions in Task 7.3 must keep the Postgres names (`bom`, `bom_revision`, `bom_line`, `bom_alternate`).
- Edge local schema: add the four tables as synced (non-localOnly) definitions in `edge/src/local-db/schema.ts` matching the bucket column lists. This is reference data for offline continuity (FR-MO-13 replay when Epic 6 lands); build no screens, no capture flows, no outbox changes, no connector changes, and add no codes to the edge permanent-error sets (`upload.ts`, `connector.ts`, `en.json`) because no Story 5.5 error is edge-reachable (the engineering stream is blocked from direct and edge event paths).

### Error Code Contract

Table 3 lists new and reused codes. New codes are module-local (consistent with every BOM/ECO/RD code shipped so far); none is on the architecture spine stable-code list and none is edge-reachable, so `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json` are NOT modified.

Table 3: Error codes for Story 5.5

| error_code | HTTP | Thrown when |
| --- | --- | --- |
| `EXPLOSION_QUANTITY_INVALID` (new) | 400 | quantity missing, non-decimal, zero, negative, or over scale/max |
| `ALTERNATE_PRIORITY_CONFLICT` (new) | 409 | another open-effectivity alternate on the same line already holds the priority |
| `ALTERNATE_ALREADY_APPROVED` (new) | 409 | ad-hoc substitution requested for an item already on the approved alternates list |
| `BOM_EXPLOSION_CYCLE_DETECTED` (new) | 409 | explosion walk encounters a cycle (walk defense only) |
| `BOM_NOT_FOUND` | 404 | unknown bom_id |
| `BOM_LINE_NOT_FOUND` | 404 | unknown or cross-revision bom_line_id |
| `BOM_NOT_RELEASED` | 409 | alternates/substitution/explosion against a non-released BOM or revision |
| `BOM_ITEM_NOT_ACTIVE` | 409 | alternate item master not `status = 'active'` |
| `RD_EXECUTION_BARRED` | 409 | any execution-intent request against an R&D draft BOM (via `assertNotRdDraft`) |
| `APPROVAL_REQUIRED` | 403 | substitution attempted by a user outside the resolved DOA chain |
| `APPROVAL_UNRESOLVED` | 409 | governing DOA entry with no holder, or no governing entry for a mandatory approval |
| `EFFECTIVITY_OVERLAP` | 409 | overlapping effectivity windows for the same alternate item on the same line |
| `INVALID_PARAMS` | 400 | shape failures not covered by a specific code (placeholder line, stale revision, count mismatch) |
| `DUPLICATE_EVENT` | 409 | idempotency/constraint replay per BOM-module local convention (23505 mapper) |
| `INVALID_EVENT_STREAM` | 400 | direct `POST /api/v1/events` for the engineering stream (existing guard, test it) |
| `FUNCTION_ACCESS_DENIED` | 403 | wrong module RBAC scope (existing middleware) |

### Architecture Compliance

- AD-1 (local-first): the edge never calls the central plane directly for these flows; replication is PowerSync-driven downstream reference data.
- AD-3 (DOA single resolver): substitution approvers resolve ONLY through `resolveApprover`; no hard-coded role literals (lint rule `doa/no-hardcoded-role-in-workflow` enforces).
- AD-4 (BOM system of record): explosion reads the platform's Released BOM only; no ERP data participates; nothing in this story accepts inbound structure (ERP outbound sync is Story 5.6).
- AD-16 (idempotency): every mutation carries an `idempotency_key`; `persistEvent` deduplicates and returns the existing event on a key hit; always build responses from `persisted.stream_id`.
- FR-AC-01 (business-stream tagging): engineering events carry `requiresBusinessStream: false` because the BOM aggregate is tagged at `bom.drafted`; business stream is derived server-side from the BOM header for persisted rows, never from the request body.
- FR-AC-13 (edit log): alternate definition, substitution approval, and explosion each write an audit entry through `persistEvent`'s `logAuditEntry` with `auditCtxFor(req, actor, status)`.
- Conventions: singular entity names; dot-separated past-tense event types (the epics PascalCase names are translations, the spine convention governs); UUIDv4 internal IDs; UTC timestamps with IST `business_date`; REST under `/api/v1/`; uniform error envelope.

### Testing Requirements

- One suite: `test/integration/story-5-5.test.ts` using `node:test` + `node:assert/strict`, real PostgreSQL per `.env.test` (note: the team's test container publishes on host port 5442 while `.env.test` names 5432; deferred-work.md line 133 is still open, use whatever the committed harness uses and do not "fix" it).
- Contract tests are mandated by AC 3: input (Released BOM + quantity) mapped to output (per-line requirement set) with exact NUMERIC-string assertions, re-fetching durable state (`getPool().query(...)`) rather than trusting response bodies alone.
- Assert error BODIES (error_code plus details), not just status codes. Include the well-formed-envelope direct-event rejection test for all three event types (a malformed envelope passes for the wrong reason via `INVALID_EVENT_ENVELOPE`).
- TRUNCATE every Story 5.5 table plus the BOM family and DOA/users tables in `after()` (`RESTART IDENTITY CASCADE`) to prevent cross-run pollution.
- Regression: story-5-1 (12), story-5-2 (27), story-5-3 (14+9), story-5-4 (20) suites must stay green with ZERO assertion edits; the full `npm test` baseline is 14 pre-existing idempotency-replay failures (409-vs-201) across Epic 1 to 3 suites; confirm zero NEW failures and do not fix the baseline.
- Gates: build, lint, format:check, `db:migrate` run twice (idempotent), spine acceptance contract 6/6, schema-drift green with three new EXPECTED entries, edge typecheck/lint/build/test unchanged at 30/30, `git diff --check` clean, `graphify update .` after code changes.

### Anti-Pattern Prevention (repeat-defect list from 5.1 to 5.4 reviews)

- Do NOT use JS float arithmetic anywhere near quantities; NUMERIC in SQL only (patched in 5.2, 5.3, and 5.4 reviews).
- Do NOT omit `assertValidOccurredAt`-style validity checks on occurred_at inputs; malformed-but-regex-valid ISO dates throw uncaught RangeError 500s.
- Do NOT ignore `persistEvent`'s returned existing event on idempotency replay; never respond with a locally minted UUID (5.2 Group 2 phantom-success bug).
- Do NOT add post-lock work without an `alreadyPersisted` re-check after acquiring `FOR UPDATE` locks (5.4 review patch).
- Do NOT let optional-typed payload fields hide hard requirements; if the shape assert requires a field, type it REQUIRED (5.2 Group 3 and 5.4 discriminated-union fixes).
- Do NOT write tests that assert only status codes; assert error_code, details, and durable projection state.
- Do NOT register literal collection routes after `:param` routes (`src/api/router.ts` returns the FIRST registered match; `:bomId` compiles to `([^/]+)`).
- Do NOT touch the staged `cost_rollup_complete` release-gate condition (`STAGED_CONDITIONS` in `src/compliance/bom.ts`); Story 5.6 owns it.
- Do NOT populate or read `bom_structure` (never populated; Story 5.1 debt; its file-header claim that 5.5 reads it is wrong at baseline and stays wrong).
- Do NOT implement authoring-time cycle detection (`BOM_CYCLE_DETECTED`) or the `bom_line.amended` effectivity re-check; both are documented 5.1 debt. If either blocks an AC, stop and surface it.
- Do NOT widen scope into Epic 6: no production-order record, no availability check, no pick-task generation. Explosion is a service with contract tests; Epic 6 invokes it later.
- Do NOT add any code to `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/**` capture paths, or the edge permanent-code sets beyond the four synced schema tables in `edge/src/local-db/schema.ts` (Task 7.3).
- Do NOT add notifications (AD-17 fires only for routed decisions; substitution approval is self-recorded by the approver, per the Story 5.4 sign-off precedent).
- Do NOT add a site_id or plant column to any BOM table (enterprise-scoped binding decision).

### Previous Story Intelligence

- Story 5.4 (done 2026-08-12, baseline 0969401): delivered the `assertNotRdDraft` execution bar THIS story must consume, the partial `uq_bom_parent_item` index, placeholder/free-text `bom_line` columns (NULL-safe queries mandatory), the advisory-lock TOCTOU pattern (`pg_advisory_xact_lock(hashtextextended($1::text, 0))`), and the capture-time-minted-IDs replay rule. Its review applied 9 patches plus 1 decision; the recurring themes (post-lock idempotency re-check, deterministic replay, NUMERIC-in-SQL, per-unit quantity semantics) are encoded in this story's contracts.
- Story 5.3 (done): ECO lifecycle with FOR-UPDATE transition matrices, `resolveApprover` capture-time resolution with `APPROVAL_UNRESOLVED` fail-closed, the computed-read pattern (`where_used_impact.ts`, `release_gate_checklist.ts`: runner-with-optional-PoolClient, UUID guards, NUMERIC strings, no stored table), the depth-capped recursive CTE with `depth_truncated`, and the cross-revision immutability fix (line lookups ALWAYS scoped by `revision_id`).
- Story 5.2 (done): staged release-gate conditions pattern (`details.staged_conditions` with `enforced: false`), `IMMUTABLE_REVISION` enforcement, the 23505-to-`DUPLICATE_EVENT` mapper for BOM constraints, the engineering-stream direct-event guard in `src/api/v1/events.ts:119-128`, and the route-order trap.
- Story 5.1 (done): `bom`, `bom_revision`, `bom_line`, `bom_structure` tables, effectivity-overlap via revision row lock plus explicit predicate (no btree_gist), phantom model (`is_phantom`, `phantom_source_bom_id`, multiplicative quantity/scrap), and the open debt list this story must respect (see Anti-Pattern Prevention).

### Git Intelligence

Recent commits at story creation (newest first): 21a3235 and 0969401 (Story 5.4 review patches and formatting refactors), 25084ab (Story 5.3 implementation baseline), af39b5e `feat(bom)` (BOM management CRUD plus integration tests, the 5.1/5.2 foundation), a982e4a (business-days and scorecard shape tests). Pattern to continue: small refactor-formatting commits around feature baselines, integration-test-first verification, and baseline-commit references in completion notes. Start implementation from the current HEAD after confirming a clean gate run.

### Project Structure Notes

- New files: `read/projections/bom_alternate.sql`, `read/projections/bom_explosion.sql`, `read/projections/bom_explosion_line.sql`, `src/compliance/bom-execution.ts`, `src/engineering/bom-explosion.ts` (new `engineering` module folder, singular, no abbreviation, matching the stream vocabulary), `src/read/projections/bom_alternate.ts`, `src/read/projections/bom_explosion.ts`, `src/api/v1/bom-execution.ts`, `test/integration/story-5-5.test.ts`.
- Modified files: `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `read/projections/bom_line.sql`, `deploy/compose/init-db.sql`, `src/read/projections/bom.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `sync/migrations/powersync.sql`, `sync/sync-rules.yaml`, `edge/src/local-db/schema.ts`, `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- Canonical SQL at repo root `read/projections/`, TS accessors under `src/read/projections/` (two parallel trees, same names). No conflicts with the unified structure detected.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 5.5] (lines 1886-1913, E5-13 amended text)
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md#E5-13] (lines 2474-2550, split rationale and contract-test rewrite)
- [Source: PLANNING/archive/SCM-Requirements-Document.md#FR-B-07, FR-B-12, FR-B-01] (long forms: scrap-adjusted quantity-per, per-line alternates, explosion to any depth)
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-1, AD-3, AD-4, AD-16, Consistency Conventions, Event Envelope]
- [Source: _bmad-output/implementation-artifacts/5-4-randd-draft-bom-regime.md#Dev Notes] (assertNotRdDraft handoff, enterprise-scoped BOM, NUMERIC discipline, edge-untouchable rule)
- [Source: _bmad-output/implementation-artifacts/5-3-eco-workflow-and-where-used-impact.md#Dev Notes] (DOA capture-time resolution, computed reads, depth-capped CTE)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] (open entries: line 206 correlation_id, line 211 global idempotency-key reuse, line 219 partial-migration window, line 133 DB_PORT; none are touched by this story)
- [Source: src/compliance/bom.ts#assertNotRdDraft, isReleasedItemMaster, STAGED_CONDITIONS]
- [Source: src/api/v1/events.ts#engineering-stream guard] (lines 119-128)
- [Source: sync/sync-rules.yaml#edge_site_events] (single-bucket baseline this story extends)
- [Source: PowerSync documentation, Global Buckets](https://docs.powersync.com/sync/rules/global-buckets) (parameterless bucket definitions sync to all clients; verified 2026-08-12 for the AC 4 design)

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m] (dev-story workflow), baseline commit 21a3235.

### Debug Log References

- `npm run db:migrate` run twice against the test database, idempotent both times, including the new `powersync-bom.sql` publication extension.
- `npx tsx --test test/unit/schema-drift.test.ts`: 75/75 pass (three new table entries plus the `bom_line` column and constraint extension).
- `node --env-file=.env.test --import tsx --test test/integration/story-5-5.test.ts`: 19/19 pass.
- Publication membership verified directly: `bom, bom_alternate, bom_line, bom_revision, domain_events`.
- Baseline verification of the one non-idempotency failure: `git stash`, re-migrate, rerun `story-5-3` on unmodified HEAD - the same single assertion fails there too, so it is pre-existing and not introduced by this story.

### Completion Notes List

Implemented all 8 tasks from baseline 21a3235.

**Schema.** Three new canonical tables (`bom_alternate`, `bom_explosion`, `bom_explosion_line`) plus the additive `bom_line.supply_method` column with its guarded `chk_bom_line_supply_method` DROP-then-ADD block. All mirrored into `deploy/compose/init-db.sql` and registered at the tail of `MIGRATIONS`. `required_quantity` and `order_quantity` are unbounded `NUMERIC` so the scrap-adjusted product cannot be silently rounded.

**Events.** Three engineering-stream events (`bom.alternate_defined`, `bom.substitution_approved`, `bom.exploded`), all `requiresBusinessStream: false`, with `BomExplosionRequirement` / `BomExplosionAlternate` payload types. The explosion requirement set is computed at capture time and embedded in the payload; the applier persists it verbatim and recomputes nothing, so replay is byte-deterministic.

**Seam.** `src/compliance/bom-execution.ts` clones the `eco.ts` two-phase structure. The two alternate events share one applier: BOM lock, post-lock idempotency re-check, `assertNotRdDraft`, released-BOM and current-released-revision guards, revision-scoped line lookup, placeholder rejection, server-side `component_item_id`/`line_no` correspondence re-assert under lock, `isReleasedItemMaster` on the alternate item, effectivity overlap, open-priority conflict, and the ad-hoc-over-approved rejection. Three new 23505 constraint mappings route concurrent races to `DUPLICATE_EVENT` 409.

**Explosion service.** `explodeBomForExecution` in `src/engineering/bom-explosion.ts` is the exported Epic 6 (FR-MO-03) contract surface: pure, no persistence, accepts an optional `PoolClient`. One `WITH RECURSIVE` CTE walks downward with all arithmetic in PostgreSQL NUMERIC, depth-capped at `config.bom.maxDepth` with `depth_truncated` reported only when a row sitting at the cap still had somewhere to descend. Cycle defense uses a `visited uuid[]` path predicate rather than the PG `CYCLE` clause: `CYCLE` keys on a column value, and sibling lines legitimately share `source_bom_id` at the same level, which would have produced false positives on every level-1 row.

**Binding decisions and deviations worth review attention:**

1. The story specified extending `sync/migrations/powersync.sql` in place. That file is registered near the HEAD of `MIGRATIONS`, before any BOM table exists, so a fresh-database migrate would have failed on the `GRANT`/`ALTER PUBLICATION`. The Story 5.5 block therefore lives in a new `sync/migrations/powersync-bom.sql` registered at the TAIL, after `bom_alternate.sql`; `powersync.sql` carries a pointer comment. Same contractual surface, correct ordering.
2. AC 3 requires backflush requirements to be generated per line, which is untestable unless a line can be authored as backflush. `supply_method` was therefore added as an optional field on `BomLineInput` and `BomLineAddedPayload` (vocabulary policed by a new exported `assertSupplyMethod`), threaded through the three `bom_line` INSERT statements in `bom.ts` and the `insertBomLine` accessor, and defaulted to `'directed_issue'` everywhere. The ECO revision copy and the R&D clone both carry it forward field-faithfully. No pre-5.5 caller changes behaviour.
3. `via_phantom` uses direct-parent semantics: a requirement is flagged when its immediate owning node is a phantom line. It is not propagated transitively down a real sub-assembly beneath a phantom.
4. Alternates are keyed per `bom_line_id`, so an ECO revision (which copies lines with fresh ids) does not carry them over - the new revision's lines need fresh alternate definitions. This is correct per FR-B-12 and accepted for Phase 1.
5. `NUMERIC` assertions in the test suite compare through PostgreSQL (`$1::numeric = $2::numeric`, the `numericEqual` idiom) plus a `typeof === 'string'` guard, rather than hard-coding PostgreSQL's division-scale output. No value passes through IEEE 754.
6. PowerSync uses a parameterless global bucket (`released_bom_structure`) over the four explosion-input tables. BOM is enterprise-scoped and no site column was added; "per plant" is satisfied by every plant's edge devices holding the full Released set. The PowerSync service itself was not exercised - the contractual surface verified here is the publication membership, the grants, the sync rules, and the edge schema.

**Gates.** build, lint, format:check clean; `db:migrate` idempotent twice; schema-drift 75/75; story-5-5 19/19; spine acceptance contract 6/6; edge typecheck/lint/build clean and edge test 30/30 unchanged; `git diff --check` clean; `graphify update .` run. Full `npm test`: 848 tests, 833 pass, 15 fail - the 14 documented pre-existing idempotency-replay failures across Epic 1 to 3 suites plus one pre-existing `story-5-3` where-used assertion, reproduced on unmodified HEAD (see Debug Log). Zero new failures. Story 5.1, 5.2 and 5.4 regression suites are green with zero assertion edits.

### File List

New:

- `read/projections/bom_alternate.sql`
- `read/projections/bom_explosion.sql`
- `read/projections/bom_explosion_line.sql`
- `sync/migrations/powersync-bom.sql`
- `src/compliance/bom-execution.ts`
- `src/engineering/bom-explosion.ts`
- `src/read/projections/bom_alternate.ts`
- `src/read/projections/bom_explosion.ts`
- `src/api/v1/bom-execution.ts`
- `test/integration/story-5-5.test.ts`

Modified:

- `read/projections/bom_line.sql`
- `deploy/compose/init-db.sql`
- `sync/migrations/powersync.sql`
- `sync/sync-rules.yaml`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/compliance/bom.ts`
- `src/compliance/eco.ts`
- `src/compliance/rd-bom.ts`
- `src/read/projections/bom.ts`
- `src/api/v1/boms.ts`
- `src/server.ts`
- `edge/src/local-db/schema.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

Table 4 records the implementation history of this story.

Table 4: Story 5.5 change log

| Date | Change | Baseline |
| --- | --- | --- |
| 2026-08-13 | Implemented all 8 tasks: alternates, DOA ad-hoc substitution, exported explosion service, PowerSync replication of Released-BOM explosion inputs, and the 19-case integration suite. Status moved to review. | 21a3235 |

### Review Findings

Adversarial code review 2026-08-13 (Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel, against baseline 21a3235). 22 findings: 2 decision-needed, 16 patch, 1 defer, 3 dismissed. All decisions resolved (option a / option a) and all 18 patch items applied 2026-08-14, verified by build, lint, edge typecheck, the 21-case story-5-5 suite, and the schema-drift marker test. Known residual: the full suite still shows 16 pre-existing failures on this machine (verified identical at pristine HEAD 21a3235 via a clean worktree - 15 idempotency-key-409 tests whose expected contract predates store.ts's 2xx replay short-circuit, and the gate_dwell_metric view-body mirror; story-5-2's legacy-kit failure is the same DATE timezone-shift family this review's patch 2 fixed).

- [x] [Review][Decision] ALTERNATE_ALREADY_APPROVED is effectivity-blind - any approved row for the item on the line blocks ad-hoc substitution even when its window has closed, so an item no longer on the effective approved list cannot be ad-hoc approved; spec-literal but over-broad [src/compliance/bom-execution.ts:357-367] - resolved: scope to window intersection (option a)
- [x] [Review][Decision] Alternates on phantom lines are silently dead - definition succeeds with 201 but the phantom never becomes a requirement so its alternates never surface at execution; reject at definition (placeholder-line precedent) or attach to children [src/engineering/bom-explosion.ts:291-293] - resolved: reject at definition (option a)
- [x] [Review][Patch] Scope ALTERNATE_ALREADY_APPROVED to the incoming window intersection - an approved row with a closed window must not block an ad-hoc substitution; reuse windowsOverlap so the gate matches the execution read model, with a boundary test for the disjoint-window case [src/compliance/bom-execution.ts:357-367]
- [x] [Review][Patch] Reject alternate definition on phantom lines with INVALID_PARAMS in the seam, mirroring the placeholder-line guard, with one test [src/compliance/bom-execution.ts:320-327]
- [x] [Review][Patch] explosion_line_id is minted at APPLY time with randomUUID, not capture time, so replaying bom.exploded events into a fresh projection produces different line ids - violates the capture-time-minted replay rule and the bom_explosion_line.sql rebuildability claim [src/compliance/bom-execution.ts:504]
- [x] [Review][Patch] windowsOverlap compares timezone-shifted dates - node-pg parses DATE columns as local midnight and toDateString uses toISOString, shifting stored dates one day back on east-of-UTC servers (UTC+8 dev, IST target), so EFFECTIVITY_OVERLAP boundary windows are misjudged (gate bypass on effective_to == incoming effective_from) and the alternates read model returns shifted dates [src/compliance/bom-execution.ts:426-438, src/read/projections/bom_alternate.ts:88]
- [x] [Review][Patch] released_bom_structure bucket replicates unreleased data - the bom_line and bom_alternate queries have no released filter, so draft/on_hold/obsolete/R&D lines and alternates reach every edge device; contradicts AC 4 and the bucket name [sync/sync-rules.yaml:17-18] - RESOLVED via the is_released_structure denormalized marker: legacy Sync Rules (pinned PowerSync 1.23.x) support no joins/subqueries/CTEs, and parameterizing by revision_id would blow the 1000-bucket client limit, so released-ness is projected onto the rows by updateBomStatus (released -> true, on_hold/obsolete -> false) and stamped at insert by the alternate seam and the legacy-kit path, with a backfill for upgraded deployments. Mirrored into init-db.sql, edge schema, sync-rules.yaml and schema-drift. Residual: bom_revision header rows of once-released BOMs that are now held still sync (no bom row, no lines); documented platform constraint, inert on the edge
- [x] [Review][Patch] priority has no upper bound - 2147483648 passes both gates and dies in the INTEGER column as PG 22003, an unmapped raw 500 instead of a 400 [src/api/v1/bom-execution.ts:142-152, src/compliance/bom-execution.ts:110-113]
- [x] [Review][Patch] ALTERNATE_PRIORITY_CONFLICT is date-blind - only effective_to IS NULL is checked, so same-priority closed-but-overlapping windows produce execution ties (breaks AC 1 priority order) and open-ended future alternates falsely block disjoint past windows [src/compliance/bom-execution.ts:381]
- [x] [Review][Patch] explosion walk descends into current_revision_id without verifying revision_status = 'released' in the cb/pb/tgt joins - latent gap that would explode draft lines if a lifecycle change ever makes a non-released revision current [src/engineering/bom-explosion.ts:183-201]
- [x] [Review][Patch] idempotency-key replay with a different body returns a mismatched response (read-back keyed to the current request's bom_line_id) and approveSubstitutionBase runs the DOA authority gate before persistEvent dedup, so a non-approver replaying a successful key gets 403 instead of the original 201 [src/api/v1/bom-execution.ts:209, 243-259, 297]
- [x] [Review][Patch] lexicographic ORDER BY path ASC misorders siblings at 10+ lines per level ('1/10' before '1/2') in the payload and GET read-back [src/engineering/bom-explosion.ts:226, src/read/projections/bom_explosion.ts:122]
- [x] [Review][Patch] obsolete BOM explosion state is named in the test title but never exercised - only draft and on_hold are tested [test/integration/story-5-5.test.ts:792-819]
- [x] [Review][Patch] shape assert validates requirements[].alternates only as an array, never its elements, so a malformed alternate object passes the pre-transaction backstop [src/compliance/bom-execution.ts:223-224]
- [x] [Review][Patch] DECIMAL_REGEX is unbounded in digits and scale, so oversized base_quantity_per/scrap_percent values are silently rounded or die as 22003 against the NUMERIC(18,8)/(9,6) columns - violates the reject-oversized-scale discipline [src/compliance/bom-execution.ts:36]
- [x] [Review][Patch] BOM_MAX_DEPTH=0 silently produces an empty explosion with depth_truncated=false and a 201 [src/engineering/bom-explosion.ts:263]
- [x] [Review][Patch] assertOccurredAt accepts impossible calendar dates ('2021-02-30' rolls to March 2), deriving a wrong business_date - reuse the strict assertValidOccurredAt helper [src/engineering/bom-explosion.ts:77-84]
- [x] [Review][Patch] alternates lookup is N+1 - one round trip per requirement row; a single grouped query would suffice [src/engineering/bom-explosion.ts:292-293]
- [x] [Review][Patch] getOpenAlternatesForLineOnDate validates the date format only, so '2026-99-99' dies as a raw 500 in the ::date cast - use the isDateString round-trip [src/read/projections/bom_alternate.ts:37, 114]
- [x] [Review][Patch] listExplosionsByBom clamps limit/offset without an integer guard, so NaN or fractional values reach LIMIT as a raw 500 - apply the spec's \d+ guard plus clamp pattern [src/read/projections/bom_explosion.ts:135-136]
- [x] [Review][Defer] ECO add change lines cannot express backflush - eco_change_line has no supply_method field, so every ECO-added line silently defaults to directed_issue while the story's binding decision claims backflush is authorable [src/compliance/eco.ts:514-537] - deferred, pre-existing
