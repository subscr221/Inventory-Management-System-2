# Story 5.1: Multi-Level BOM Creation

Status: ready-for-dev

Baseline commit: `f9d3bd2`

Completion note: Ultimate context engine analysis completed - comprehensive developer guide created from Epic 5, the architecture spine, the PRD FR-B requirement set, current repository code, Stories 2.1, 4.4, and 4.7, recent commits, and PostgreSQL 18 documentation.

## Story

As a design engineer,
I want to create multi-level BOMs with per-line scrap percentages, unit-of-measure conversions, date effectivity, phantom pass-through assemblies, and co-products and by-products with expected yields,
so that the BOM faithfully represents how the product is actually built and every downstream Epic 5 story has a controlled structure to release, change, explode, and cost.

## Acceptance Criteria

1. **Draft BOM creation.** Given released component item masters exist, when an authorized engineer creates a BOM for a parent item with component lines carrying quantity per, scrap percent, unit-of-measure conversion factor, and date effectivity (FR-B-01, FR-B-03), then the system derives the parent item, base units of measure, and business stream from governed `item_master` records; writes `bom.drafted` on a new `engineering` stream; stores the BOM header, its revision, and all lines in `Draft` state; and commits header, revision, lines, structure projection, event, and edit-log entry in one transaction.
2. **Phantom pass-through.** Given a BOM line references an item flagged as a phantom assembly (FR-B-13), when the structure is resolved, then the phantom's own children are represented at the parent level in the structure read model with multiplied quantities and accumulated scrap, the phantom itself is never presented as a stockable requirement, and the originating line is still retained verbatim in `bom_line` so the authored structure stays auditable.
3. **Co-products and by-products.** Given a process yields co-products and by-products (FR-B-14), when they are added, then each carries `output_class` of `co_product` or `by_product`, a mandatory expected yield, and is stored as a distinct output line that is never treated as a consumed component in the structure projection or in any future explosion input.
4. **Unreleased component blocks release.** Given a component line references an item that does not satisfy the A-11 released-item-master condition, when the line is added, then the line is accepted into the Draft but persisted with `blocking_release = true` and a recorded reason, the BOM header exposes an unresolved blocker count, and the durable flag is the input that Story 5.2's `RELEASE_GATE_UNMET` check consumes. Story 5.1 never releases a BOM.
5. **Non-overlapping effectivity.** Given a revision line with a date-effectivity window, when another line for the same component on the same revision is saved with an overlapping window (FR-B-03), then the save is rejected with HTTP 409 and `error_code: "EFFECTIVITY_OVERLAP"`, and the response names the conflicting line number and its window. Open-ended windows (null effective-to) are treated as infinite for overlap purposes. Concurrent saves of two overlapping windows leave exactly one line stored.
6. **Cycle rejection at any depth.** Given a multi-level structure, when a line would make the BOM a descendant of itself at any depth through any Draft or Released BOM revision, then the line is rejected with `error_code: "BOM_CYCLE_DETECTED"` and the response names the cycle path. A depth beyond the configured maximum is rejected with `error_code: "BOM_DEPTH_EXCEEDED"` rather than allowed to recurse without bound.
7. **Value validation.** Given a line carrying a scrap percent, when the value is outside the inclusive 0 to 100 range, is non-numeric, or carries excess decimal scale, then the save is rejected listing the offending field and value. The same exact-value discipline applies to quantity per, unit-of-measure conversion factor (strictly positive), and expected yield.
8. **Central enforcement, replay, and reads.** Shape validation runs before idempotency lookup. Parent and component derivation, phantom resolution, effectivity, cycle, depth, blocker flagging, and business-stream tagging are enforced inside the `persistEvent` compliance seam, not only in HTTP handlers. Direct `POST /api/v1/events` cannot bypass any rule. Replay of the same idempotency key produces one BOM and one event. Authorized readers can list BOMs by parent item, status, and business stream, and retrieve a detail containing the authored line set, the resolved structure, blocker reasons, and audit identifiers.

## Binding Scope Decisions

These decisions resolve gaps discovered across the planning artifacts and the current repository. The developer must not silently choose alternatives.

- **The "released item master" state does not exist in this repository yet.** `read/projections/item_master.sql:40` constrains `status` to `active` or `inactive` only, and no item lifecycle or governance state machine exists. For this story the A-11 released condition is evaluated as `item_master.status = 'active'` read under lock, and the outcome is stored on the line as `blocking_release` plus `blocking_reason`. Do not invent an item-master release workflow, a new item status vocabulary, or an INT-ERP-01 governance gate here. Encapsulate the check in one exported predicate so a later item-governance story can change the rule in one place.
- **There is no unit-of-measure registry and none is created here.** `uom` is free `TEXT` on `item_master`, `indent_line`, `purchase_order_line`, and `grn_line`. Each BOM line therefore carries its own `line_uom` plus an explicit `uom_conversion_factor` to the component item's base `uom`, both validated as exact values. Do not build a global conversion table, a dimension system, or a rounding policy engine.
- **Phantom identity is BOM-level, not item-master-level.** No item-master phantom attribute exists and Story 5.1 must not add a column to `item_master`. A line declares `is_phantom` and the seam resolves the phantom's own most recent effective Draft or Released revision. If a declared phantom has no resolvable BOM, the save is rejected with `PHANTOM_BOM_NOT_FOUND` rather than silently degrading to a stocked component.
- **Effectivity overlap is enforced by row lock plus explicit query, not by a range exclusion constraint.** `btree_gist` is not installed and migrations run as `admin_user` against a shared database. Lock the `bom_revision` row with `SELECT ... FOR UPDATE` before every line write, then run the explicit overlap predicate. Do not add a PostgreSQL extension in this story.
- **BOM data is enterprise scope, not site scope.** Unlike Stories 3.x and 4.x there is no `site_id` on any BOM table and no site filtering in the read accessors. `business_stream` is derived from the governed parent `item_master` row and never accepted from the request body. Registered events require the tag, so `UNTAGGED_TRANSACTION` remains reachable for a spoofed direct event post.
- **Scope stops at Draft.** Release, immutability, hold, obsolete, and legacy kit migration belong to Story 5.2. Engineering change orders and where-used belong to Story 5.3. R&D placeholders and the productization gate belong to Story 5.4. Alternates and the explosion service belong to Story 5.5. Cost rollups, job-work supply-source tags, and ERP outbound sync belong to Story 5.6. Do not implement, stub, or partially write any of them. The structure projection built here is the substrate Stories 5.3 and 5.5 will build on, so it must be complete and correct for the Draft case.
- **No edge or offline path.** BOM authoring is a central desktop workflow. Per-plant edge replication of Released structures is explicitly Story 5.5 scope. Do not modify `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/**`, or `sync/sync-rules.yaml`.
- **No central UI application exists in this repository.** This story implements the REST contract and durable state a future engineering UI will render. Do not claim a rendered BOM tree editor exists.
- **Amendment is line-level and Draft-only.** `bom_line.amended` may change quantity, scrap, conversion factor, effectivity, and yield on a Draft revision only. It never mutates a released revision, which does not yet exist, and it never deletes a line. Retirement of a line is an amendment that closes its effectivity window.

## Tasks and Subtasks

- [ ] Task 1: Add canonical BOM projections (AC: 1-8)
  - [ ] Create `read/projections/bom.sql` using the Story 4.4 and Story 2.1 canonical header comment, the migrate-plus-compose duplication warning, guarded named constraints, and guarded grants with no DELETE grant.
  - [ ] Define `bom` header columns: `bom_id UUID PRIMARY KEY`, `parent_item_id UUID NOT NULL`, `parent_sku TEXT NOT NULL`, `parent_uom TEXT NOT NULL`, `business_stream TEXT NOT NULL`, `bom_type TEXT NOT NULL CHECK (bom_type IN ('production','rnd','job_work_kit'))` defaulting to `production`, `status TEXT NOT NULL CHECK (status IN ('draft'))`, `current_revision_id UUID`, `blocking_line_count INTEGER NOT NULL DEFAULT 0`, `created_by UUID NOT NULL`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, and timestamps. Only `draft` is valid in this story; Story 5.2 widens the CHECK.
  - [ ] Create `read/projections/bom_revision.sql` with `revision_id UUID PRIMARY KEY`, `bom_id UUID NOT NULL`, `revision_code TEXT NOT NULL`, `revision_status TEXT NOT NULL CHECK (revision_status IN ('draft'))`, `drafted_by`, `drafted_at`, `source_event_id`, and `uq_bom_revision_code UNIQUE (bom_id, revision_code)`.
  - [ ] Create `read/projections/bom_line.sql` with `bom_line_id UUID PRIMARY KEY`, `revision_id UUID NOT NULL`, `bom_id UUID NOT NULL`, `line_no INTEGER NOT NULL`, `component_item_id UUID NOT NULL`, `component_sku TEXT NOT NULL`, `output_class TEXT NOT NULL CHECK (output_class IN ('component','co_product','by_product'))`, `quantity_per NUMERIC(18,6) NOT NULL`, `line_uom TEXT NOT NULL`, `uom_conversion_factor NUMERIC(18,8) NOT NULL`, `base_quantity_per NUMERIC(18,6) NOT NULL`, `scrap_percent NUMERIC(7,4)`, `expected_yield_percent NUMERIC(7,4)`, `is_phantom BOOLEAN NOT NULL DEFAULT false`, `phantom_source_bom_id UUID NULL`, `effective_from DATE NOT NULL`, `effective_to DATE NULL`, `blocking_release BOOLEAN NOT NULL DEFAULT false`, `blocking_reason TEXT NULL`, `amended_at TIMESTAMPTZ NULL`, `source_event_id UUID NOT NULL`, and timestamps.
  - [ ] Add named checks: `chk_bom_line_scrap_percent` for the inclusive 0 to 100 range, `chk_bom_line_quantity_positive`, `chk_bom_line_conversion_positive`, `chk_bom_line_yield_required` binding a non-null `expected_yield_percent` to co-product and by-product classes and a null yield to components, `chk_bom_line_effectivity_order` requiring `effective_to IS NULL OR effective_to >= effective_from`, `chk_bom_line_phantom_pairing` requiring `phantom_source_bom_id` exactly when `is_phantom`, and `chk_bom_line_blocking_reason` requiring a reason exactly when `blocking_release`.
  - [ ] Add `uq_bom_line_no UNIQUE (revision_id, line_no)` and indexes on `component_item_id`, `bom_id`, and `blocking_release` where true.
  - [ ] Create `read/projections/bom_structure.sql` as the phantom-resolved, depth-annotated structure read model: `structure_id UUID PRIMARY KEY`, `bom_id`, `revision_id`, `root_bom_line_id`, `path TEXT NOT NULL` holding the dot-separated line-number path, `depth INTEGER NOT NULL CHECK (depth >= 0)`, `component_item_id`, `component_sku`, `output_class`, `effective_quantity_per NUMERIC(18,6) NOT NULL`, `effective_scrap_percent NUMERIC(9,6)`, `via_phantom BOOLEAN NOT NULL DEFAULT false`, `effective_from`, `effective_to`, `source_event_id`, and timestamps, with `uq_bom_structure_path UNIQUE (revision_id, path)` and an index on `(component_item_id)` for the Story 5.3 where-used consumer.
  - [ ] Append the four migrations after `po_outbound_message.sql` at the tail of `MIGRATIONS` in `src/events/migrate.ts:8-64`, mirror each canonical block byte-for-byte in `deploy/compose/init-db.sql` with LF endings, and add complete `EXPECTED` entries in `test/unit/schema-drift.test.ts`.
  - [ ] Run `npm run db:migrate` twice against the test database and prove idempotency.
- [ ] Task 2: Register event payloads and the engineering stream (AC: 1, 3, 8)
  - [ ] Add payload and envelope interface pairs in `src/events/schema.ts` using the existing `Omit<EventEnvelope, 'payload'>` pattern for `bom.drafted`, `bom_line.added`, and `bom_line.amended`. The epic's `BomDrafted`, `BomLineAdded`, and `BomLineAmended` names map to this past-tense dot-separated convention, matching the architecture spine's `bom.released` example.
  - [ ] Register all three at the tail of `SUPPORTED_EVENT_TYPES` with `streamType: 'engineering'`. Only `bom.drafted` carries `requiresBusinessStream: true` (the draft is the tagged business transaction under FR-AC-01, mirroring `indent.raised` and `purchase_order.drafted`); `bom_line.added` and `bom_line.amended` carry `requiresBusinessStream: false` as lifecycle transitions on an already-tagged document. `engineering` is a new stream type string value — `stream_type` is typed as `string` in `src/events/schema.ts:150`, so no DDL or migration table change is needed; register only in `SUPPORTED_EVENT_TYPES` without altering any existing entry or its order.
  - [ ] Keep the authored inputs in the payload: parent item, component item, line numbers, exact decimal strings for quantity, scrap, conversion factor and yield, effectivity dates, phantom declaration, output class, and revision code. The structure projection is derived, so replay must be able to rebuild it from the event stream alone.
  - [ ] The `bom.drafted` handler injects the governed `business_stream` read from the parent `item_master` before `persistEvent`, mirroring the Story 4.4 and Story 4.7 pattern, because `assertInventoryTagging` runs before the transaction seam. The seam then re-derives it under lock and rejects any payload disagreement. Line events (`bom_line.added`, `bom_line.amended`) do not require a `business_stream` tag and are not injected in the handler, matching the `indent.confirmed` and `purchase_order.approved` precedent.
- [ ] Task 3: Implement `src/compliance/bom.ts` and central wiring (AC: 1-8)
  - [ ] Export the established three-symbol seam: `bomEventType`, `assertBomShape`, and `applyBomProjection`; keep helpers private. Mirror the symbol shape at `src/compliance/purchase-order.ts:85,104,273`.
  - [ ] Copy the plain-SELECT `alreadyPersisted` pattern from `src/compliance/purchase-order.ts:264-271`. Never use `SELECT ... FOR UPDATE` on `domain_events`; Story 4.3 proved `app_user` cannot lock that table and fails with PostgreSQL 42501.
  - [ ] Shape validation must strictly check UUIDs, real calendar dates using the Story 4.4 strict date implementation, exact decimal scale and magnitude against each NUMERIC declaration, the 0 to 100 scrap range, strictly positive quantity and conversion factor, output-class vocabulary, yield presence rules, unique line numbers within the request, and non-empty revision codes, all before an idempotency key can be consumed. Reject null and empty numeric values before any coercion.
  - [ ] Lock the parent `item_master` row, require `status = 'active'`, and derive `parent_sku`, `parent_uom`, and `business_stream` from it. Lock each component `item_master` row, derive `component_sku` and the base `uom`, and set `blocking_release` plus `blocking_reason` from the single exported A-11 predicate rather than an inline status literal.
  - [ ] Compute `base_quantity_per` as `quantity_per * uom_conversion_factor` in PostgreSQL NUMERIC. Do not use JavaScript floating-point arithmetic for any stored or compared value.
  - [ ] Lock the `bom_revision` row before every line insert or amendment, then run the explicit effectivity-overlap predicate against sibling lines for the same `component_item_id` treating a null `effective_to` as infinite. Throw `EFFECTIVITY_OVERLAP` with the conflicting line number and window.
  - [ ] Detect cycles with a recursive CTE over `bom` and `bom_line` that walks the candidate component down to the parent item, bounded by `config.bom.maxDepth`. Throw `BOM_CYCLE_DETECTED` with the path, or `BOM_DEPTH_EXCEEDED` when the bound is hit. Self-reference is the depth-zero case and must be caught.
  - [ ] Resolve phantoms during projection: expand the phantom's effective revision lines one level at a time under the same depth bound, multiply quantities, accumulate scrap multiplicatively rather than additively, set `via_phantom`, and never emit the phantom item itself as a structure row. Nested phantoms expand recursively within the depth bound.
  - [ ] Write co-product and by-product lines into `bom_structure` with their output class preserved and never fold them into consumption quantities.
  - [ ] Maintain `bom.blocking_line_count` and `bom.current_revision_id` from the projection, never from a handler.
  - [ ] Wire `assertBomShape` immediately after `assertPurchaseOrderShape` at `src/events/store.ts:474` and `applyBomProjection` immediately after `applyPurchaseOrderProjection` at `src/events/store.ts:707`, with the import added after line 100. Nothing existing is reordered.
- [ ] Task 4: Add exact read-model accessors (AC: 4, 8)
  - [ ] Create `src/read/projections/bom.ts` using the `Queryable`, `runner`, UUID guard, optional transaction client, and `forUpdate` patterns from `src/read/projections/purchase_order.ts:62-145`.
  - [ ] Provide locked BOM and revision reads, line reads by revision, sibling-effectivity lookup, cycle-path query, phantom source resolution, structure inserts and deletes scoped to one revision, blocker recount, and paginated list reads.
  - [ ] Escape `%`, `_`, and backslash for every ILIKE search and cap list limits at 200, matching the Story 4.4 accessor contract. There is no site filter on BOM reads by design.
  - [ ] Return NUMERIC values as strings and DATE values as calendar strings. Never parse an engineering quantity into a JavaScript number in the accessor contract.
- [ ] Task 5: Implement REST commands and reads (AC: 1-8)
  - [ ] Create `src/api/v1/boms.ts` using the actor context, audit context, error wrapper, and `requireRole({ module: 'engineering', ... })` patterns from `src/api/v1/purchase-orders.ts:588-620`. Do not write any role-name literal; use module and function scope so RBAC assignment decides who authors BOMs.
  - [ ] Implement `POST /api/v1/boms` for draft creation with its initial line set, `GET /api/v1/boms`, `GET /api/v1/boms/:bomId`, `GET /api/v1/boms/:bomId/structure`, `POST /api/v1/boms/:bomId/lines`, and `PATCH /api/v1/boms/:bomId/lines/:bomLineId`.
  - [ ] Every mutation calls `persistEvent`. No handler inserts or updates a BOM projection directly, and every response returns the durable projection rather than an echo of the request body.
  - [ ] Register routes under a Story 5.1 block after the Story 4.4 block in `src/server.ts:394` and add the exact route set to the sorted `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
  - [ ] Add `config.bom.maxDepth` with a default of `20` in `src/config/index.ts`, mirroring the static environment-backed `config.indent` and `config.erp` pattern.
- [ ] Task 6: Define stable failures (AC: 4-8)
  - [ ] Reuse `DUPLICATE_EVENT`, `INVALID_PARAMS`, `UNTAGGED_TRANSACTION`, and the existing RBAC error codes and `{ error_code, message, details, trace_id }` envelope.
  - [ ] Add exactly the codes this story needs with precise 400, 403, 404, and 409 statuses: `EFFECTIVITY_OVERLAP` and `BOM_CYCLE_DETECTED` as named by the epic, plus `BOM_NOT_FOUND`, `BOM_LINE_NOT_FOUND`, `BOM_NOT_DRAFT`, `BOM_DEPTH_EXCEEDED`, `BOM_ITEM_NOT_FOUND`, `BOM_ITEM_NOT_ACTIVE`, `BOM_LINE_REQUIRED`, `BOM_YIELD_REQUIRED`, `BOM_INVALID_SCRAP_PERCENT`, `BOM_INVALID_CONVERSION_FACTOR`, and `PHANTOM_BOM_NOT_FOUND`.
  - [ ] The two epic-named codes are contractual strings consumed by tests and future clients. Do not rename, prefix, or wrap them.
  - [ ] There is no edge path, so no code is added to edge permanent-code or localization files.
- [ ] Task 7: Build integration and concurrency coverage (AC: 1-8)
  - [ ] Create `test/integration/story-5-1.test.ts` from the real production router and PostgreSQL harness used by `test/integration/story-4-4.test.ts`. Apply item, BOM, revision, line, and structure SQL in dependency order; use SCIM provisioning, port-zero server startup, run-scoped external identifiers, and `crypto.randomUUID()`.
  - [ ] Cover draft creation with derived parent facts, inherited business stream, exact NUMERIC persistence at declared scale, edit-log atomicity, and a durable single BOM under idempotent replay.
  - [ ] Cover a three-level structure including a nested phantom: assert multiplied quantities, multiplicatively accumulated scrap, `via_phantom` rows, absence of any phantom item row in `bom_structure`, retention of the authored phantom line in `bom_line`, and `PHANTOM_BOM_NOT_FOUND` for an unresolvable phantom.
  - [ ] Cover co-product and by-product lines: mandatory yield, rejection of a yield on a plain component, rejection of a missing yield on an output line, and proof that outputs never appear as consumption quantities.
  - [ ] Cover the blocking-release path with an inactive component: line accepted, `blocking_release` true with a reason, header count incremented, and the count decremented when the line is amended away or the item becomes active and the line is re-amended.
  - [ ] Cover effectivity: adjacent non-overlapping windows accepted, containment rejected, partial overlap rejected, open-ended against open-ended rejected, open-ended against a closed later window rejected, different components on the same dates accepted, and two concurrent overlapping saves leaving exactly one stored line.
  - [ ] Cover cycles: direct self-reference, two-level cycle, deep cycle through a phantom, a cycle formed through a separate BOM's revision, and a legitimate deep chain at exactly `maxDepth` accepted while `maxDepth + 1` returns `BOM_DEPTH_EXCEEDED`.
  - [ ] Cover value validation: scrap at 0, at 100, below 0, above 100, with excess scale, non-numeric, null, and empty; zero and negative quantity; zero and negative conversion factor; NUMERIC overflow; and invalid calendar dates such as 31 February.
  - [ ] Cover direct `POST /api/v1/events` attempts that spoof business stream, parent item, blocking flag, structure rows, and phantom resolution, and prove each is rejected by the seam.
  - [ ] Assert NUMERIC columns as strings and DATE columns with `::text`.
- [ ] Task 8: Run all quality gates and record evidence (AC: all)
  - [ ] Run `npm run build`, `npm run lint`, and `npm run format:check`.
  - [ ] Run `npm run db:migrate` twice.
  - [ ] Run `npm test` and prove zero new failures against the measured baseline.
  - [ ] Run `npm run spine-acceptance-contract`, the schema-drift test, and the no-hardcoded-role test.
  - [ ] Run `npm run edge:test` unchanged to prove the no-edge boundary remains intact.
  - [ ] Run `git diff --check` and inspect only intended files.
  - [ ] Do not mark a task complete from inspection alone. Record command, exit result, test counts, and any proven pre-existing failure in the Dev Agent Record.

## Dev Notes

### Existing Components to Reuse

- `src/events/store.ts:338-865` is the only domain write path. It validates, opens one PostgreSQL transaction, applies projections, inserts the event, and writes the audit row. Story 5.1 extends it at two points only.
- `src/compliance/purchase-order.ts:53-83,264-475` is the nearest precedent for strict calendar-date validation, decimal precision guards, safe idempotency, source derivation under row lock, SQL NUMERIC arithmetic, and nested persistence.
- `src/read/projections/purchase_order.ts:62-145,199-243` supplies the accessor, pagination, escaping, UUID guard, and SQL NUMERIC calculation patterns.
- `src/read/projections/item_master.ts:208-225` provides `getItemBySku`, `getItemById`, and the optional-client signature. Use these rather than writing new item queries, and add only a locked variant if one is missing.
- `src/compliance/business-stream.ts` enforces `requiresBusinessStream` from `SUPPORTED_EVENT_TYPES`. The four seeded streams are `production`, `research`, `maker_hub`, and `job_work` per `read/projections/business_stream_config.sql:21-26`. BOM events inherit the parent item's stream; they never fabricate one.
- `src/read/projections/audit_log.ts` and `persistEvent` provide the immutable edit log required by FR-AC-13.
- `src/middleware/rbac.ts` provides `requireRole` with module and function scope plus `permittedLocationsForModuleScope`. Use the module scope only; BOM data is not location scoped.

### Current Update Files and Preservation Rules

- `src/events/schema.ts`: append three envelope interfaces after the last existing interface (before `SUPPORTED_EVENT_TYPES` at line 1405), and append three registry entries at the tail of `SUPPORTED_EVENT_TYPES` (after `supplier_scorecard.metric_recorded` at line 1770, before `} as const` at line 1771). Preserve every existing event name and its order.
- `src/events/store.ts:97-100,468-474,700-707`: add one import and one call in each of the assert and projection sequences, positioned after the purchase-order entries. Preserve every existing seam's relative order and replay behavior.
- `src/events/migrate.ts:8-64`: append four migration paths at the tail. Never insert them earlier and never reorder prior entries, including the deliberate repeated entries already present.
- `src/server.ts:145-175,373-402`: add imports and one route block after the Story 4.4 routes. Preserve all existing paths.
- `deploy/compose/init-db.sql`: append byte-identical canonical SQL blocks with LF line endings. Do not hand-edit a divergent variant.
- `test/unit/schema-drift.test.ts`: list every new named constraint, index, and grant for all four tables.
- `test/integration/story-1-9.test.ts`: add every new route to the exact production-route allowlist.
- `src/config/index.ts`: add `config.bom.maxDepth` only.
- Do not modify `item_master` DDL, any `erp_` projection, `src/adapters/erp/sync.ts`, Story 3.x warehouse write paths, Story 4.x procurement write paths, PowerSync rules, or any edge file.

### Prior-Story Intelligence

- Story 4.3 discovered that `requiresBusinessStream` had been documentary for non-inventory streams. Register the new engineering events as genuinely tagged transactions and test the direct-event bypass.
- Story 4.3's copied `alreadyPersisted` implementation caused PostgreSQL 42501 because `app_user` cannot lock `domain_events`. Story 4.4's plain SELECT is the safe precedent.
- Story 4.4 review fixed invalid calendar dates, NUMERIC overflow, excess decimal scale, `Number(null)` coercion, handler-side float disagreement, missing status guards, and trusted payload identifiers. Apply every one of those fixes from the first commit rather than waiting for review.
- Story 2.1 established `item_master` as the SKU-keyed governed record with `item_id` as the event `stream_id`. Story 5.1 follows the same convention: `bom_id` is the `stream_id` for BOM events.
- Story 3.10's review resolved a duplicate-persistence decision by returning the existing record rather than a bare conflict. Apply the same friendliness to BOM replay: identical idempotency key returns the existing BOM.
- Recent commits are `f9d3bd2` for the Story 4.7 specification, `97cbbe1` for Story 4.4 integration tests, and `e81ca3d` for Story 4.3 integration tests. Stories 4.5, 4.6, and 4.7 are not implemented, so no procurement code is a moving target under this story.

### Architecture and Security Compliance

- Stack remains Node.js 24 LTS ESM, TypeScript 5.8, PostgreSQL 18.4, and `pg` 8.16. No new dependency, PostgreSQL extension, or runtime service is authorized by this story.
- Naming follows the architecture spine consistency conventions: singular entity names, past-tense dot-separated events, UUIDv4 internal identifiers, and `bom/` as the module name.
- AD-12 makes the compliance spine the bottom layer: no module bypasses it. AD-14 makes read models shared projections, which is why Story 5.3 where-used and Story 5.5 explosion will read `bom_structure` rather than replay BOM events.
- All domain mutations are events; every BOM row is a rebuildable projection. No handler writes a projection directly.
- Quantities, scrap, conversion factors, and yields are exact PostgreSQL NUMERIC values. PostgreSQL 18 silently rounds values exceeding declared scale and raises only on integer-part overflow, so the application must reject excess scale and magnitude before storage.
- Recursive CTE cycle detection must carry an explicit depth bound. An unbounded recursive query over a cyclic graph is a denial-of-service surface, and the cycle guard is exactly the code path an attacker or a malformed import would exercise.
- No BOM row is deleted by a user action. Structure rows are derived and may be rebuilt within the owning revision's transaction; authored lines are only ever amended.

### Testing and Completion Guardrails

- Use Node's built-in `node:test`, real PostgreSQL, real router registration, and serial execution. Do not add Jest, Vitest, or mocks that bypass the compliance seam.
- Test the concurrency case through two genuinely concurrent requests, not a sequential pre-check. The `bom_revision` row lock is the guard being proven.
- Every external identifier carries a run suffix and every UUID uses `crypto.randomUUID()`.
- Do not report this story complete while any acceptance criterion rests on a downstream story. Every criterion here is satisfiable with Story 5.1 code alone, so a blocked task is a real failure rather than a dependency.

### Latest Technical Information

- Node 24 remains an LTS line; no runtime upgrade is needed and the repository lockfile governs versions.
- PostgreSQL 18 recommends `numeric` for exact quantity arithmetic and warns that floating-point equality is unsuitable for such comparisons.
- PostgreSQL 18 recursive common table expressions require an explicit termination condition for cyclic data; the documented approach is to carry the visited path in the working row and stop when the candidate repeats.
- PostgreSQL range types and exclusion constraints would express effectivity overlap directly but require `btree_gist` for the composite case, which this story deliberately avoids.

### Project Structure Notes

Expected new files:

- `read/projections/bom.sql`
- `read/projections/bom_revision.sql`
- `read/projections/bom_line.sql`
- `read/projections/bom_structure.sql`
- `src/compliance/bom.ts`
- `src/read/projections/bom.ts`
- `src/api/v1/boms.ts`
- `test/integration/story-5-1.test.ts`

Expected modified files:

- `src/events/schema.ts`
- `src/events/store.ts`
- `src/events/migrate.ts`
- `src/server.ts`
- `src/config/index.ts`, only for `config.bom.maxDepth`
- `deploy/compose/init-db.sql`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

Files that must remain untouched:

- `read/projections/item_master.sql`
- `src/sync/upload.ts`
- `src/api/v1/edge.ts`
- `edge/**`
- `sync/sync-rules.yaml`
- `src/adapters/erp/sync.ts`
- every `erp_` projection
- all Story 3.x and Story 4.x write paths

### References

- [Source: `_bmad-output/planning-artifacts/epics.md:1719-1764`] Epic 5 objective and Story 5.1 acceptance criteria.
- [Source: `_bmad-output/planning-artifacts/epics.md:1765-1952`] Stories 5.2 through 5.6, which fix this story's downstream boundaries.
- [Source: `_bmad-output/planning-artifacts/epics.md:274,399`] A-11 hard sequencing of item-master governance before the FR-B-06 release gate.
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md:193-206`] FR-B-01, FR-B-03, FR-B-13, and FR-B-14 definitions.
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:140-180`] AD-12 compliance spine, AD-14 shared projections, and the naming conventions including `bom.released`.
- [Source: `_bmad-output/implementation-artifacts/4-7-supplier-invoice-capture.md:107-168`] the current house pattern for seam extension, preservation rules, and completion guardrails.
- [Source: `_bmad-output/implementation-artifacts/4-4-purchase-order-management.md`] nearest event, schema, API, and test precedent.
- [Source: `src/events/store.ts:97-100,468-474,700-707`] the two extension points and their required ordering.
- [Source: `src/compliance/purchase-order.ts:85,104,264-273`] seam symbol shape and safe idempotency helper.
- [Source: `read/projections/item_master.sql:14-54`] item columns, the active and inactive status vocabulary, and the absence of any released state.
- [Source: `read/projections/business_stream_config.sql:21-26`] the four seeded business streams.
- [Source: `src/events/migrate.ts:8-64`] migration order and the append point.
- [PostgreSQL 18 numeric documentation](https://www.postgresql.org/docs/18/datatype-numeric.html)
- [PostgreSQL 18 recursive query documentation](https://www.postgresql.org/docs/18/queries-with.html)

## Saved Clarifications

The binding decisions above allow implementation to begin. These product and architecture questions remain for later confirmation:

1. When will item-master governance introduce a real released state, and should `blocking_release` then be recomputed for existing Draft lines or only on amendment?
2. Should a phantom be an item-master attribute rather than a per-line declaration, so the same assembly cannot be phantom on one BOM and stocked on another?
3. Is scrap intended to compound multiplicatively through a phantom chain, as implemented here, or to be summed at the parent level?
4. Which enterprise role assignment represents the design engineer, and is BOM authoring separable from BOM administration before Story 5.2 lands?
5. Should revision codes be system-generated in a controlled sequence or author-supplied, given Story 5.2 makes released revisions immutable?
6. Is a maximum structure depth of 20 correct for the pilot product range?
7. Which central web application will render and accessibility-test the BOM tree contract defined here?

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
