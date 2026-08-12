---
baseline_commit: 09694013e122cc61e0261eaa8deb23661e12b9c5
---

# Story 5.4: R&D Draft BOM Regime

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created (create-story 2026-08-12). -->

## Story

As an R&D engineer,
I want R&D draft BOMs that allow in-place edits, placeholders, and free text, that I can clone from a production BOM, and that capture an as-built snapshot per prototype build,
so that I can iterate freely during development without touching production specifications.

## Acceptance Criteria

1. **Given** an R&D engineer working on a new design, **When** they create or edit an R&D draft BOM (FR-B-09), **Then** in-place edits, placeholder components, and free-text lines are permitted without ECO controls.
2. **Given** an R&D draft BOM carrying the `rd_draft` regime flag (FR-B-09), **When** any execution-intent request references it - release-gate eligibility evaluation (FR-B-06) or explosion to execution (FR-B-07) - **Then** the request is rejected with `error_code: "RD_EXECUTION_BARRED"`; the regime flag structurally blocks release-gate eligibility, testable at BOM level without a production order, and Epic 6's production-order release gate consumes this same validation when it lands.
3. **Given** an existing production BOM, **When** the engineer clones it to an R&D draft (FR-B-10), **Then** a new editable R&D draft is created without altering the source production BOM.
4. **Given** an R&D draft BOM with a recorded draft-BOM build record (FR-B-10), **When** the build record is confirmed, **Then** an immutable as-built snapshot is captured for that specific build, with deviation flags on every line where the as-built structure differs from the draft; any attempt to edit a captured snapshot is rejected - corrections are new snapshots attributed in the edit log (FR-AC-13). The build record is exercised at BOM level in this story; prototype build execution (Epic 10, FR-RD-08) and production trials (Epic 6) integrate against this same capture when they land.
5. **Given** an R&D draft BOM is proposed for production, **When** the productization gate is run (FR-B-11), **Then** the gate requires engineering, procurement, and QC sign-offs on a checklist before a production BOM can be created, returning `error_code: "APPROVAL_REQUIRED"` until all sign-offs are recorded.

## Tasks / Subtasks

- [x] Task 1: Widen the BOM schema for the R&D regime (AC: 1, 2, 3, 5)
  - [x] `read/projections/bom.sql`: the `uq_bom_parent_item` UNIQUE INDEX on `parent_item_id` is a HARD BLOCKER for AC 3 - cloning a production BOM produces a second `bom` row for the same `parent_item_id` and collides. Replace it with a partial unique index: `DROP INDEX IF EXISTS uq_bom_parent_item;` then `CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_parent_item ON bom (parent_item_id) WHERE bom_type <> 'rnd';`. Production and job-work-kit BOMs keep one-per-item uniqueness; R&D drafts may be many per item, which is the whole point of free iteration
  - [x] `read/projections/bom.sql`: `ALTER TABLE bom ADD COLUMN IF NOT EXISTS cloned_from_bom_id UUID;` and `ADD COLUMN IF NOT EXISTS productized_from_bom_id UUID;` plus `CREATE INDEX IF NOT EXISTS idx_bom_cloned_from ON bom (cloned_from_bom_id);` and `idx_bom_productized_from ON bom (productized_from_bom_id)`. These two columns are the machine-checkable provenance the tests assert; do not re-derive lineage any other way
  - [x] `read/projections/bom_line.sql`: placeholder and free-text support. `ALTER TABLE bom_line ALTER COLUMN component_item_id DROP NOT NULL;`, same for `component_sku`; `ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false;`, `ADD COLUMN IF NOT EXISTS free_text TEXT;`. Add `chk_bom_line_placeholder_pairing CHECK ((is_placeholder = true AND component_item_id IS NULL AND component_sku IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL))` via the DROP-plus-ADD `DO $$` pair. `quantity_per`, `line_uom`, `uom_conversion_factor`, and `base_quantity_per` stay NOT NULL - a placeholder still consumes a quantity in a unit; only the item identity is unknown
  - [x] Do NOT relax any other `bom_line` constraint. The NOT NULL drop is the minimum needed and the applier guard in Task 3 is what keeps placeholders off production BOMs
  - [x] New `read/projections/rd_build_record.sql`. Columns: `build_id UUID PRIMARY KEY`, `bom_id UUID NOT NULL`, `revision_id UUID NOT NULL`, `build_ref TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'recorded'`, `built_quantity NUMERIC(18,6) NOT NULL`, `built_uom TEXT NOT NULL`, `notes TEXT`, `outcome TEXT`, `recorded_by UUID NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL`, `confirmed_by UUID`, `confirmed_at TIMESTAMPTZ`, `correlation_id UUID`, `source_event_id UUID NOT NULL`, `created_at`, `updated_at`. Constraints: `chk_rd_build_status CHECK (status IN ('recorded','confirmed'))`; `chk_rd_build_quantity_positive CHECK (built_quantity > 0)`; `chk_rd_build_outcome CHECK (outcome IS NULL OR outcome IN ('success','failed','abandoned'))`; `uq_rd_build_ref UNIQUE INDEX (bom_id, build_ref)`; indexes `idx_rd_build_bom_id (bom_id)`, `idx_rd_build_status (status)`. `outcome` exists because FR-RD-08 (Epic 10) records failed and abandoned builds against this same table; it is nullable and unenforced here
  - [x] New `read/projections/rd_as_built_line.sql`. Columns: `as_built_line_id UUID PRIMARY KEY`, `build_id UUID NOT NULL`, `line_no INTEGER NOT NULL`, `draft_bom_line_id UUID`, `component_item_id UUID`, `component_sku TEXT`, `is_placeholder BOOLEAN NOT NULL DEFAULT false`, `free_text TEXT`, `quantity_used NUMERIC(18,6) NOT NULL`, `line_uom TEXT NOT NULL`, `deviation_flag BOOLEAN NOT NULL DEFAULT false`, `deviation_kind TEXT`, `deviation_detail TEXT`, `source_event_id UUID NOT NULL`, `created_at`. Constraints: `chk_rd_as_built_quantity_positive CHECK (quantity_used > 0)`; `chk_rd_as_built_identity CHECK ((is_placeholder = true AND component_item_id IS NULL AND free_text IS NOT NULL AND btrim(free_text) <> '') OR (is_placeholder = false AND component_item_id IS NOT NULL AND component_sku IS NOT NULL))`; `chk_rd_as_built_deviation CHECK ((deviation_flag = true AND deviation_kind IS NOT NULL) OR (deviation_flag = false AND deviation_kind IS NULL AND deviation_detail IS NULL))`; `chk_rd_as_built_deviation_kind CHECK (deviation_kind IS NULL OR deviation_kind IN ('quantity','substitution','extra','missing','placeholder'))`; `uq_rd_as_built_line_no UNIQUE INDEX (build_id, line_no)`; index `idx_rd_as_built_build_id (build_id)`
  - [x] New `read/projections/rd_productization_signoff.sql`. Columns: `signoff_id UUID PRIMARY KEY`, `bom_id UUID NOT NULL`, `gate_function TEXT NOT NULL`, `signed_by UUID NOT NULL`, `signed_at TIMESTAMPTZ NOT NULL`, `approver_actor_id UUID NOT NULL`, `doa_entry_id UUID`, `notes TEXT`, `source_event_id UUID NOT NULL`, `created_at`. Constraints: `chk_rd_signoff_function CHECK (gate_function IN ('engineering','procurement','qc'))`; `uq_rd_signoff_function UNIQUE INDEX (bom_id, gate_function)`; index `idx_rd_signoff_bom_id (bom_id)`. `gate_function` is the column name, not `function` - `function` is a reserved word in enough tooling to be worth avoiding
  - [x] Every new file carries its own guarded grant block (`INSERT, SELECT, UPDATE` to `app_user`, `SELECT` to `readonly_user`, no `DELETE`), a `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` re-add guard per named constraint, and is fully idempotent. Copy the `read/projections/bom.sql` header comment and guard style verbatim
  - [x] Register the three new files at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` in dependency order `rd_build_record.sql`, `rd_as_built_line.sql`, `rd_productization_signoff.sql`. Never reorder existing entries
  - [x] Mirror every DDL statement byte-for-byte into `deploy/compose/init-db.sql` (LF endings), including the `bom` and `bom_line` alterations and the partial-index swap
  - [x] Add EXPECTED entries for the three new tables to `test/unit/schema-drift.test.ts` and update the existing `bom` and `bom_line` entries for the new columns, constraints, and the changed `uq_bom_parent_item` predicate. The BOM entries around lines 660-714 are the shape to copy
  - [x] Prove idempotency: `npm run db:migrate` twice against a database that already carries Story 5.3 schema, and confirm the `uq_bom_parent_item` swap is re-runnable

- [x] Task 2: Register R&D events (AC: 2, 3, 4, 5)
  - [x] In `src/events/schema.ts`, after the Story 5.3 ECO block, add payload plus envelope interface pairs (`Omit<EventEnvelope, 'payload'>` pattern) for five event types: `rd_draft.cloned`, `rd_build.recorded`, `rd_build.confirmed`, `rd_draft.productization_signed`, `rd_draft.productized`
  - [x] There is deliberately NO `rd_draft.created` event, contradicting the `RdDraftCreated` name in the epics dev note. `POST /api/v1/boms` with `bom_type: 'rnd'` already drafts an R&D BOM through `bom.drafted` (verified at baseline: `src/api/v1/boms.ts` reads `body.bom_type`, `assertBomDraftedShape` accepts `'rnd'`, `chk_bom_type` permits it). Adding a parallel creation event would fork the BOM header write path. Record this deviation in the Dev Agent Record
  - [x] Likewise `AsBuiltSnapshotCaptured` is split into `rd_build.recorded` plus `rd_build.confirmed` because AC 4 requires a build record that exists BEFORE confirmation and a capture that happens AT confirmation. One event cannot express both. Record this in the Dev Agent Record
  - [x] Append registry entries at the tail of `SUPPORTED_EVENT_TYPES` before `} as const`, all `streamType: 'engineering'`. `requiresBusinessStream: true` for `rd_draft.cloned`, `rd_draft.productized`, and `rd_build.recorded` (each creates a new tagged document header, following `bom.drafted` and `eco.raised`); `false` for `rd_build.confirmed` and `rd_draft.productization_signed` (transitions on an already-tagged document, following `bom_line.*` and the 5.2 and 5.3 transition events)
  - [x] Payload shapes (all carry optional `correlation_id`; `business_stream` is REQUIRED, not optional, on the three `requiresBusinessStream: true` payloads - the Story 5.2 Group 3 review corrected exactly this typing-truth gap, do not reintroduce it):
    - `RdDraftClonedPayload { source_bom_id, source_revision_id, bom_id, revision_id, revision_code, parent_item_id, parent_sku, parent_uom, business_stream: string, line_ids: string[] }`
    - `RdBuildRecordedPayload { build_id, bom_id, revision_id, build_ref, business_stream: string, built_quantity: string, built_uom, outcome?, notes?, as_built_lines: RdAsBuiltLineInput[] }` where `RdAsBuiltLineInput { line_no, draft_bom_line_id?, component_item_id?, component_sku?, is_placeholder?, free_text?, quantity_used: string, line_uom }`
    - `RdBuildConfirmedPayload { build_id }`
    - `RdProductizationSignedPayload { signoff_id, bom_id, gate_function, approver_actor_id, doa_entry_id: string | null, notes? }`
    - `RdProductizedPayload { source_bom_id, bom_id, revision_id, revision_code, parent_item_id, parent_sku, parent_uom, business_stream: string, line_ids: string[] }`
  - [x] `line_ids`, `revision_id`, `signoff_id`, `build_id`, and `approver_actor_id` are minted or resolved at CAPTURE time in the handler and stored in the payload so replay is deterministic. This is the same rule Story 5.2 applied to the migration `outcome` field and Story 5.3 applied to `new_revision_id` and `approver_actor_id`
  - [x] `stream_id` is the aggregate's own id: `bom_id` (the NEW draft) for `rd_draft.cloned`, `bom_id` (the NEW production BOM) for `rd_draft.productized`, `build_id` for both `rd_build.*`, and `bom_id` (the R&D draft) for `rd_draft.productization_signed`

- [x] Task 3: R&D compliance module (AC: 1, 2, 3, 4, 5)
  - [x] New `src/compliance/rd-bom.ts` mirroring `src/compliance/eco.ts` structure exactly (which itself clones `src/compliance/bom.ts`): `ENGINEERING_STREAM_TYPES` set, `RD_EVENT_TYPES` set, local `reject()` helper, `isUuid` / `isNonEmptyString` / `assertDecimalString` guards, exported `rdEventType(envelope)`, exported `assertRdShape(envelope)`, exported `applyRdProjection(envelope, client, eventId)`, plain-SELECT `alreadyPersisted` replay guard (NEVER `FOR UPDATE` on `domain_events`), and `assertValidOccurredAt` on EVERY applier
  - [x] Wire into `src/events/store.ts` at the two existing seams ONLY: `assertRdShape(envelope)` alongside `assertBomShape` and `assertEcoShape` in the pre-transaction assert block, and `await applyRdProjection(envelope, client, eventId)` alongside `applyBomProjection` and `applyEcoProjection` in the in-transaction block. Add no other `store.ts` call sites
  - [x] Export `assertNotRdDraft(bom: { bom_id: string; bom_type: string }): void` from `src/compliance/bom.ts` (NOT from `rd-bom.ts` - it guards the BOM module's own write paths and `rd-bom.ts` imports would invert the dependency). It rejects `RD_EXECUTION_BARRED` (409) with `details: { bom_id, bom_type: 'rnd' }` when `bom_type === 'rnd'`. This one function is the single execution bar AC 2 mandates; Story 5.5's explosion service and Epic 6's production-order release call it and must not re-derive the predicate
  - [x] AC 2 wiring, three call sites, all in existing code: (a) `applyBomReleased` in `src/compliance/bom.ts` calls `assertNotRdDraft` immediately after the BOM row is locked and BEFORE `evaluateReleaseGate` - an R&D draft must never even be gate-evaluated; (b) `evaluateReleaseGate` itself calls it first, so a direct caller cannot bypass (a); (c) `getReleaseGateChecklist` in `src/read/projections/release_gate_checklist.ts` rejects the same way so `GET /api/v1/boms/:bomId/release-gate` returns 409 `RD_EXECUTION_BARRED` rather than a checklist. The Story 5.2 binding rule is that the checklist and the gate can never disagree; that rule now covers the R&D bar too
  - [x] Placeholder admission guard: in `applyBomDrafted` and `applyBomLineAdded` and `applyBomLineAmended` (`src/compliance/bom.ts`), any line with `is_placeholder = true` is rejected with `RD_PLACEHOLDER_NOT_PERMITTED` (400) unless the owning `bom.bom_type = 'rnd'`. The DB CHECK cannot express this (it cannot see `bom`), so the applier is the only enforcement point - a missing guard here silently lets a production BOM carry an item-less line
  - [x] Placeholder lines skip the item-master lookup and the blocking-line accounting entirely: `component_item_id` is NULL, so `getItemById` must not be called, `blocking_release` stays false, and `blocking_line_count` is unaffected. Guard every existing `component_item_id` dereference in the three appliers above; an unguarded lookup is a raw 500 on a NULL parameter
  - [x] `rd_draft.cloned` applier (AC 3): verify the source `bom` exists (`BOM_NOT_FOUND`, 404); source may be in any status and any `bom_type` (cloning an R&D draft to a new R&D draft is legitimate iteration and costs nothing to allow); resolve the source revision as `bom.current_revision_id`, falling back to the sole `bom_revision` row when `current_revision_id` is NULL (a never-released draft BOM has NULL here - verified in `read/projections/bom.sql`); insert the new `bom` row with `bom_type = 'rnd'`, `status = 'draft'`, `origin = 'native'`, `cloned_from_bom_id = source_bom_id`, `parent_item_id` and `parent_sku` and `parent_uom` and `business_stream` COPIED from the source row (never re-read from the item master - the clone must mirror the source, and FR-AC-01 is already satisfied by the source's tag); insert one `bom_revision` at `revision_code = 'A'`, `revision_status = 'draft'`; copy every `bom_line` row of the source revision into the new `revision_id` with the pre-minted `payload.line_ids`, preserving `line_no` order
  - [x] The source BOM's `bom`, `bom_revision`, and `bom_line` rows are NOT touched by cloning (AC 3). Assert this in tests by re-reading every source row after the clone
  - [x] `rd_build.recorded` applier (AC 4): verify the BOM exists and `bom_type = 'rnd'` else reject `RD_BUILD_NOT_PERMITTED` (409) - build records belong to the R&D regime only; verify `revision_id` belongs to `bom_id` else `INVALID_PARAMS` (400) (Story 5.3 closed this cross-check gap for ECO; do not reintroduce it here); insert the `rd_build_record` row at `status = 'recorded'` plus one `rd_as_built_line` row per payload entry with sequential `line_no`, `deviation_flag = false` and both deviation columns NULL at this stage
  - [x] `rd_build.confirmed` applier (AC 4): lock the `rd_build_record` row `SELECT ... FOR UPDATE`; reject `BUILD_STATE_INVALID` (409) unless `status = 'recorded'` - `confirmed` is TERMINAL; recompute the deviation set INSIDE the transaction against the draft revision's CURRENT `bom_line` rows (never trusting anything computed at record time - the draft is editable between record and confirm, which is exactly the R&D regime's point); write `deviation_flag`, `deviation_kind`, and `deviation_detail` onto each `rd_as_built_line` row; set `status = 'confirmed'`, `confirmed_at`, `confirmed_by`. Table 1 defines the deviation rules
  - [x] After confirmation the snapshot is immutable: any further `rd_build.confirmed` on the same `build_id`, and any `rd_build.recorded` reusing a confirmed `(bom_id, build_ref)`, rejects `SNAPSHOT_IMMUTABLE` (409). AC 4 mandates that corrections are NEW snapshots (a new `build_ref`), attributed in the edit log. There is no update path and none may be added
  - [x] `rd_draft.productization_signed` applier (AC 5): verify the BOM exists and `bom_type = 'rnd'` else `RD_BUILD_NOT_PERMITTED` (409); upsert the `rd_productization_signoff` row keyed on `uq_rd_signoff_function` (`ON CONFLICT (bom_id, gate_function) DO UPDATE`) so a re-sign replaces rather than duplicates, mirroring the Story 5.3 disposition upsert
  - [x] `rd_draft.productized` applier (AC 5): lock the source R&D `bom` row `FOR UPDATE`; reject `RD_BUILD_NOT_PERMITTED` (409) unless `bom_type = 'rnd'`; re-derive the sign-off set INSIDE the transaction and reject `APPROVAL_REQUIRED` (409) with `details.missing_signoffs[]` when any of `engineering`, `procurement`, `qc` is absent (AC 5 mandates this code verbatim); reject `RD_PLACEHOLDER_UNRESOLVED` (409) with `details.placeholder_line_nos[]` when any line of the draft's current revision has `is_placeholder = true` - a placeholder cannot become a production component; reject `BOM_ALREADY_EXISTS` (409) when a non-`rnd` `bom` row already exists for the same `parent_item_id` (the partial `uq_bom_parent_item` would otherwise raise an unmapped 23505 as a raw 500, and the correct path for changing an existing production BOM is an ECO, Story 5.3); then insert the new `bom` row with `bom_type = 'production'`, `status = 'draft'`, `productized_from_bom_id = source_bom_id`, one `bom_revision` at `revision_code = 'A'` and `revision_status = 'draft'`, and a copy of every draft line with the pre-minted `payload.line_ids`
  - [x] The new production BOM lands in `draft`, NOT `released`. It then travels the ordinary Story 5.2 release path including the full release gate. Productization is not a release and must not shortcut the gate
  - [x] The source R&D draft is NOT modified by productization beyond nothing at all - it keeps iterating. Assert this in tests
  - [x] All quantity arithmetic (`base_quantity_per = quantity_per * uom_conversion_factor`) is computed in PostgreSQL NUMERIC inside the INSERT VALUES list (`$n::numeric * $m::numeric`), never in JavaScript. The Story 5.2 Group 1 review patched exactly this defect

- [x] Task 4: Read accessors and the productization checklist (AC: 2, 4, 5)
  - [x] New `src/read/projections/rd_build.ts` following `src/read/projections/eco.ts` style: `RdBuildRecordRow` / `RdAsBuiltLineRow` interfaces, `runner(client?)` helper, `getBuildById`, `listBuilds(params)` with `bom_id` and `status` filters and clamped `limit`/`offset`, `getAsBuiltLines(buildId)`, plus `insertBuildRecord`, `insertAsBuiltLine`, `updateAsBuiltDeviation`, `confirmBuildRecord` write helpers
  - [x] New `src/read/projections/rd_productization.ts`: `RdSignoffRow` interface, `getSignoffs(bomId)`, `upsertSignoff`, and `getProductizationChecklist(bomId, client?)` - a COMPUTED read over `bom`, `bom_line`, and `rd_productization_signoff`, no stored checklist table and no `migrate.ts` entry. Follow the `src/read/projections/release_gate_checklist.ts` precedent exactly (computed read, runner-with-optional-`PoolClient`, `UUID_REGEX` guard, NUMERIC returned as strings); a stored checklist goes stale the moment a sign-off is replaced or a placeholder is added
  - [x] `getProductizationChecklist` response shape: `{ bom_id, bom_type, eligible: boolean, signoffs: [{ gate_function, signed: boolean, signed_by, signed_at, approver_actor_id }], missing_signoffs: string[], placeholder_line_nos: number[] }` with all three `gate_function` rows ALWAYS present (unsigned ones carry `signed: false` and nulls), never omitted. `eligible` is true only when `missing_signoffs` and `placeholder_line_nos` are both empty. The checklist and the `rd_draft.productized` applier MUST use the same predicate source so the two can never disagree - export the predicate once and call it from both, the way `isApprovedEcoConditionMet` is shared between the gate and the checklist
  - [x] Update `BomLineRow` in `src/read/projections/bom.ts`: `component_item_id: string | null`, `component_sku: string | null`, plus `is_placeholder: boolean` and `free_text: string | null`. Update `insertBomLine` and `getBomLines` column lists. `BomRow` gains `cloned_from_bom_id: string | null` and `productized_from_bom_id: string | null`
  - [x] Every write helper you export must have a caller. The Story 5.2 Group 3 review found `updateBomStatus` and `releaseBomRevision` exported dead with drifting INSERT column lists; do not repeat that pattern
  - [x] `limit`/`offset` parsed with a `\d+` guard, clamped, and echoed at the CLAMPED value (Story 5.2 Group 2 patch: `Number('abc')` reaching `LIMIT NaN` is a raw 500, and echoing an unclamped limit makes pagination metadata lie)
  - [x] Audit every existing consumer of `bom_line.component_item_id` for the new NULL case: `src/read/projections/where_used_impact.ts` (the upward walk and the affected-component set), `src/read/projections/release_gate_checklist.ts` (the blocking-lines query), `src/compliance/bom.ts` (`evaluateReleaseGate`, `getBlockingLineCount`), and `src/compliance/eco.ts` (the revision-copy in `eco.implemented`). Each must filter `component_item_id IS NOT NULL` or handle NULL explicitly. This is the highest-regression-risk change in the story

- [x] Task 5: API routes, DOA resolution, RBAC, spine registration (AC: 1, 2, 3, 4, 5)
  - [x] New `src/api/v1/rd-boms.ts` copying the `src/api/v1/ecos.ts` skeleton: local `actorContext(req)`, `auditCtxFor(req, actor, httpStatus)`, envelope builders that ALWAYS stamp `metadata.occurred_at` (the Story 5.2 debugging record shows omitting it crashes `persistEvent` with a 500), `idempotency_key: (body.idempotency_key as string) ?? randomUUID()`, `persistEvent(event, auditCtxFor(...))`, responses returning the durable projection state read back with `persisted.stream_id` (AD-16), never the locally minted id
  - [x] Handlers and routes, all seven:
    - `POST /api/v1/boms/:bomId/clone-to-rd` (AC 3)
    - `POST /api/v1/boms/:bomId/builds` (AC 4, record)
    - `GET /api/v1/boms/:bomId/builds` (AC 4, list)
    - `GET /api/v1/rd-builds/:buildId` (AC 4, detail with as-built lines)
    - `POST /api/v1/rd-builds/:buildId/confirm` (AC 4)
    - `POST /api/v1/boms/:bomId/productization-signoffs` (AC 5)
    - `GET /api/v1/boms/:bomId/productization-gate` (AC 5, checklist)
    - `POST /api/v1/boms/:bomId/productize` (AC 5)
  - [x] Route-order requirement (this is the trap Story 5.2 hit with `migration-exceptions`): `src/api/router.ts` returns the FIRST registered match and `:bomId` compiles to `([^/]+)`. Every new `/api/v1/boms/:bomId/<literal>` route has a distinct second segment so no collision exists, but they MUST still be registered inside the Story 5.4 block placed AFTER the Story 5.3 block, and `GET /api/v1/boms/migration-exceptions` must remain above `GET /api/v1/boms/:bomId`. Do not reorder any existing route
  - [x] Mount in `src/server.ts` under a `// Story 5.4: R&D Draft BOM Regime` comment placed AFTER the Story 5.3 ECO block
  - [x] RBAC: mutations `requireRole({ module: 'engineering', functionScope: 'write' })`, reads `functionScope: 'read'`. NEVER role-name literals - `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces this
  - [x] DOA resolution (AC 5): define `export const RD_PRODUCTIZATION_DOA_TYPES = { engineering: 'rd_productization_engineering', procurement: 'rd_productization_procurement', qc: 'rd_productization_qc' } as const` in `src/api/v1/rd-boms.ts` and reuse `resolveApprover` exported from `src/api/v1/indents.ts` at value `0` (no monetary band; the `src/api/v1/suppliers.ts` and Story 5.3 `ECO_DOA_TYPE` zero-value precedent). Resolve at SIGN time and store `approver_actor_id` and `doa_entry_id` on the payload. Do not write a new DOA lookup and do not invent a fourth gate function
  - [x] Sign-off authority check in the sign-off handler, BEFORE building the envelope: `if (approval.approverActorId !== actor.userId) throw new AppError(403, 'APPROVAL_REQUIRED', 'Caller is not the resolved approver for this productization gate function', { gate_function, approver_actor_id, caller_user_id })`. Copy the Story 5.3 `approveEcoHandler` shape verbatim. Note the deliberate two-status use of one code, matching the existing codebase: 403 for wrong approver, 409 for gate-unmet (AC 5's mandated case)
  - [x] `POST /api/v1/boms/:bomId/builds` body: `{ build_ref, built_quantity, built_uom, outcome?, notes?, as_built_lines: [{ line_no, draft_bom_line_id?, component_item_id?, component_sku?, is_placeholder?, free_text?, quantity_used, line_uom }], idempotency_key? }`. The handler resolves `component_sku` server-side from the item master for every non-placeholder line and rejects an unknown item with `BOM_ITEM_NOT_FOUND` (404); the client never supplies a SKU for a real item
  - [x] `POST /api/v1/boms/:bomId/clone-to-rd` and `POST /api/v1/boms/:bomId/productize` bodies accept only `{ correlation_id?, idempotency_key?, notes? }`. Every identifier is server-minted. Accepting a client-supplied `bom_id` here would let a caller overwrite an unrelated BOM header
  - [x] Add all eight routes verbatim to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` under a `// Story 5.4` comment (the list is grouped by story comment, NOT alphabetically sorted)
  - [x] `src/api/v1/events.ts` already rejects `stream_type === 'engineering'` on direct posts. The new `rd_*` events inherit that guard because they use the same stream type - do not add a second guard, but DO assert the rejection in tests with a WELL-FORMED envelope

- [x] Task 6: Integration and unit tests (AC: all)
  - [x] New `test/integration/story-5-4.test.ts` following the `test/integration/story-5-3.test.ts` harness exactly: `node:test` plus `node:assert/strict`, real router via `createAppRouter` from `../../src/server.js`, real PostgreSQL via `getPool`/`getAdminPool`, canonical `.sql` files applied via `readFileSync` in dependency order, port-zero server, run-scoped identifiers from `randomUUID().slice(0, 8)`, SCIM-provisioned users with `Authorization: Bearer test-only-scim-bearer-token-not-for-production-use`, all writes through the HTTP API
  - [x] Seed three DOA registry entries (one per gate function) in `before()` following the Story 5.3 `eco_approval` seeding block, each with its own role and approver user
  - [x] `after()` hook MUST truncate the new tables plus the BOM tables: `TRUNCATE TABLE rd_as_built_line, rd_build_record, rd_productization_signoff, eco_stock_disposition, eco_change_line, eco, bom_line, bom_revision, bom_structure, bom RESTART IDENTITY CASCADE`. Story 5.2 Group 4 found BOM rows accumulating across runs in the shared test database
  - [x] Minimum cases: (1) `POST /api/v1/boms` with `bom_type: 'rnd'` creates an R&D draft; (2) placeholder line accepted on an R&D draft at draft time and via `POST /:bomId/lines`, with `component_item_id` NULL and `free_text` set; (3) the SAME placeholder line rejected `RD_PLACEHOLDER_NOT_PERMITTED` on a production BOM, both at draft time and via add-line; (4) `PATCH /:bomId/lines/:bomLineId` amends an R&D draft line in place with no ECO and no error; (5) `POST /:bomId/release` on an R&D draft returns 409 `RD_EXECUTION_BARRED`; (6) `GET /:bomId/release-gate` on an R&D draft returns 409 `RD_EXECUTION_BARRED` and NOT a checklist; (7) two R&D drafts cloned from the same production BOM both succeed (the partial-index change) while a second PRODUCTION BOM for that same `parent_item_id` still collides; (8) clone copies every line and leaves every source row byte-identical on re-read, with `cloned_from_bom_id` set; (9) build recorded then confirmed captures a snapshot; deviation flags land as `quantity` for a changed quantity, `substitution` for a different component, `extra` for an as-built line absent from the draft, `missing` for a draft line absent from the as-built, and `placeholder` for a draft placeholder that was built with a real part; (10) a draft line edited BETWEEN record and confirm changes the deviation result, proving the recompute is at confirm time; (11) second confirm on the same build rejects `SNAPSHOT_IMMUTABLE`; (12) `rd_build.recorded` reusing a confirmed `(bom_id, build_ref)` rejects `SNAPSHOT_IMMUTABLE`; (13) build record attempted on a production BOM rejects `RD_BUILD_NOT_PERMITTED`; (14) `POST /:bomId/productize` with zero, one, and two sign-offs each returns 409 `APPROVAL_REQUIRED` naming the missing functions; (15) sign-off by a non-resolved user returns 403 `APPROVAL_REQUIRED`; (16) re-signing one function replaces rather than duplicates the row; (17) all three sign-offs then productize creates a production BOM in `draft` with `productized_from_bom_id` set, copied lines, and the R&D draft unchanged; (18) productize with an unresolved placeholder rejects `RD_PLACEHOLDER_UNRESOLVED` listing the line numbers; (19) productize when a production BOM already exists for the parent item rejects `BOM_ALREADY_EXISTS` and not a raw 500; (20) the productized BOM can then be released through the ordinary Story 5.2 path (proving productization does not shortcut the gate); (21) `GET /:bomId/productization-gate` returns all three functions with `eligible` flipping false to true as sign-offs land; (22) well-formed direct `rd_*` post to `POST /api/v1/events` rejected `INVALID_EVENT_STREAM`; (23) every mutation without engineering write role returns 403 and every read without engineering read role returns 403; (24) idempotent replay of each mutation with the same `idempotency_key` does not double-apply; (25) audit entries exist for clone, build record, confirm, sign-off, and productize (FR-AC-13)
  - [x] Assert response BODIES, not just status codes: error tests assert `error_code`, and mutation tests re-fetch the projection to confirm the change actually landed. Story 5.2 Group 4 found several tests passing for the wrong reason

- [x] Task 7: QA gates (AC: all)
  - [x] Run and record results for: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test`, `npm run spine-acceptance-contract`, `npm run edge:test`, `git diff --check`
  - [x] Regression focus, because this story changes shared BOM code: `test/integration/story-5-3.test.ts`, `test/integration/story-5-2.test.ts`, and `test/integration/story-5-1.test.ts` must all stay green with zero assertion edits other than ones forced by the nullable `component_item_id` typing
  - [x] Run `graphify update .` after code changes
  - [x] Update `_bmad-output/implementation-artifacts/sprint-status.yaml` for `5-4-randd-draft-bom-regime` when done, and fill every Dev Agent Record section of this file
  - [x] The 14 known pre-existing idempotency-replay failures (409 versus 201) in the Epic 1-3 suites are the accepted baseline. Report the count and confirm zero NEW failures; do not attempt to fix them in this story

## Dev Notes

### The regime flag (binding)

- The `rd_draft` regime flag named in AC 2 IS the existing `bom.bom_type = 'rnd'` value. Do NOT add a `regime`, `rd_draft`, or `is_draft` column. `bom_type` already carries `'production' | 'rnd' | 'job_work_kit'` in `chk_bom_type`, is already accepted by `POST /api/v1/boms`, and is already validated in `assertBomDraftedShape`. A second flag would create two sources of truth for the same fact.
- An R&D draft BOM stays in `status = 'draft'` for its whole life. It is never released, so the Story 5.2 immutability guards (`IMMUTABLE_REVISION`, `BOM_NOT_DRAFT`) never fire against it, which is exactly what makes AC 1's in-place edits work with zero new code. AC 1 needs no new edit endpoint; verify the existing `POST /:bomId/lines` and `PATCH /:bomId/lines/:bomLineId` behaviour with a test rather than building a parallel path.
- ECO controls (Story 5.3) attach only to Released BOMs. An R&D draft can never be Released, so it is structurally outside the ECO path. Nothing in this story touches `src/compliance/eco.ts`.

### Deviation computation at confirm (binding)

Deviations compare the build's `rd_as_built_line` rows against the `bom_line` rows of the draft revision named on the build record, matched on `draft_bom_line_id` when supplied and otherwise on `component_item_id`. Table 1 states the rule per case; every non-matching case sets `deviation_flag = true` and a `deviation_kind`, and `deviation_detail` carries a short human-readable string such as `expected 2.000000, used 2.500000`.

Table 1: As-built deviation rules

| **Case** | **deviation_kind** | **deviation_flag** |
| --- | --- | --- |
| As-built line matches a draft line on component and quantity | none | false |
| Matched draft line, different `quantity_used` | `quantity` | true |
| Matched `draft_bom_line_id`, different `component_item_id` | `substitution` | true |
| As-built line matches no draft line | `extra` | true |
| Draft line has no as-built line | `missing` | true (recorded as a synthetic as-built row with `quantity_used` from the draft and a NULL match) |
| Draft line is a placeholder, as-built line carries a real component | `placeholder` | true |

- The `missing` case needs a row to carry the flag, so confirm inserts one synthetic `rd_as_built_line` per unmatched draft line, appended after the recorded lines with continuing `line_no`. Without this, a component the engineer forgot to use leaves no trace in the snapshot, which defeats the purpose of an as-built record.
- Quantity comparison is exact NUMERIC equality performed in PostgreSQL, never a JavaScript float comparison. `2.5` and `2.500000` are equal; compare with `=` on NUMERIC-typed values, not on strings.
- The comparison happens at CONFIRM, against the draft as it stands at that moment. This is the same "re-derive truth transactionally" rule the Story 5.2 release gate and the Story 5.3 affected-lot set follow.

### Productization gate (binding, do not over-build)

- Three fixed sign-off functions: `engineering`, `procurement`, `qc`. FR-B-11 names exactly these three. Do not build a configurable checklist, a workflow-definition table, or a fourth function.
- The gate is a precondition on `rd_draft.productized`, not a state machine. There is no `pending_productization` status on the R&D draft and none may be added; the draft keeps iterating regardless of how many sign-offs exist.
- Sign-offs are per BOM, not per revision. An R&D draft has one revision for its whole life in this story (clone creates revision `A` and nothing creates a second), so a revision dimension would be dead weight.
- Productization creates a NEW production BOM. It never converts the R&D draft in place. Converting in place would destroy the iteration history the whole regime exists to preserve, and would trip the partial `uq_bom_parent_item` against any existing production BOM for that item.

### The `uq_bom_parent_item` blocker (binding)

- At baseline `uq_bom_parent_item` is a plain UNIQUE INDEX on `bom (parent_item_id)`. One BOM per item, full stop. AC 3 (clone) and the R&D regime's whole premise (many parallel drafts per item) are impossible under it.
- The fix is a partial unique index excluding `bom_type = 'rnd'`. Production and job-work-kit BOMs keep their one-per-item guarantee; R&D drafts are unconstrained. This is a DROP plus CREATE pair, both idempotent, mirrored into `deploy/compose/init-db.sql`, and reflected in the `test/unit/schema-drift.test.ts` expectation for `bom`.
- Verify with a test that a second PRODUCTION BOM for a parent item still fails, so the relaxation is provably scoped.

### Placeholder and free-text lines (binding)

- Placeholders relax `bom_line.component_item_id` and `component_sku` to nullable at the DB level for ALL rows, because a CHECK constraint cannot reach the `bom` table to condition on `bom_type`. The applier guard is therefore the ONLY thing keeping placeholders off production BOMs. Treat `RD_PLACEHOLDER_NOT_PERMITTED` as a load-bearing check, not a nicety, and test both the draft-time and the add-line path.
- Every existing query that dereferences `component_item_id` must now tolerate NULL. The four known consumers are listed in Task 4. A missed one is a raw 500 or, worse, a silently truncated result set in the where-used walk.
- `free_text` doubles as the placeholder's descriptive text and is REQUIRED when `is_placeholder = true`, enforced by `chk_bom_line_placeholder_pairing`. There is no separate free-text line type; FR-B-09's "free text" is this column.
- Placeholder lines never block or unblock release, because an R&D draft cannot be released at all. Do not add a placeholder condition to `evaluateReleaseGate`; the `RD_EXECUTION_BARRED` bar fires first and `RD_PLACEHOLDER_UNRESOLVED` covers the productization path.

### Execution bar and the Story 5.5 handoff (binding)

- `assertNotRdDraft` in `src/compliance/bom.ts` is the single definition of the bar. Story 5.5 (BOM explosion, FR-B-07) and Epic 6 (production-order release, FR-MO-03) import and call it; neither re-derives the predicate. AC 2 names explosion explicitly, and no explosion service exists at baseline (verified: no `explode`, `explosion`, or `alternate` code anywhere in `src/`), so this story satisfies the explosion half of AC 2 by shipping the shared predicate and proving it at BOM level. Do not build an explosion service; that is Story 5.5's scope.
- `bom_structure` remains unpopulated (Story 5.1 debt, still open). Do not populate it, do not read it, and do not "fix" it here. Cloning copies `bom_line` rows only.

### Architecture compliance (mandatory)

- Event-sourced writes only: state changes append to `domain_events`; projections mutate only inside `applyRdProjection` within the persist transaction. Shape asserts run PRE-transaction so a malformed event never consumes an idempotency key.
- AD-4 (BOM system of record): the platform owns BOM structure. ERP sync is outbound-only and inbound conflicts become BOM Administrator exceptions. Nothing in this story accepts inbound structure.
- AD-5 and AD-7 (R&D separation): production WIP and R&D project WIP are separate ledgers, and R&D stock is flagged and blocked from cross-issue. This story touches neither stock nor WIP - build records capture BOM structure only, never a stock movement. Do NOT post any inventory transaction from a build record; Epic 10 (FR-RD-07, FR-RD-08) owns R&D material consumption.
- AD-3 and FR-DOA-01: approvers resolve from the one enterprise DOA registry through `resolveApprover`; no role-name literal may appear in R&D code.
- AD-16: every mutation carries an `idempotency_key`; `persistEvent` deduplicates and returns the EXISTING event on a key hit. Always use `persisted.stream_id` rather than a locally minted UUID when building the response - Story 5.2 Group 2 found a phantom-success bug from ignoring that return value.
- AD-17 applies only if a notification is emitted. This story emits NONE: there is no approval decision to notify (sign-offs are recorded by the approver themselves, not routed to them). Do not add notification emission.
- BOM and R&D drafts are enterprise-scoped: no `site_id`, no location filters. `business_stream` is copied from the source BOM on clone and productize, and derived server-side from the BOM on build records; it is never accepted from a request body.
- FR-AC-13 edit log: clone, build record, confirm, sign-off, and productize each write an audit entry via `auditCtxFor(req, actor, status)` passed to `persistEvent`.
- NUMERIC discipline: quantities and percents are exact decimal strings end-to-end; arithmetic happens in PostgreSQL NUMERIC, never JS floats. PostgreSQL 18 silently rounds excess scale, so reject before storage.
- ESM: `.js` extensions on relative imports, `node:` prefixed builtins, no new dependencies, no PostgreSQL extensions, hand-rolled router (no web framework).
- Edge and offline surface is untouchable: `src/sync/upload.ts`, `src/api/v1/edge.ts`, `edge/**`, `sync/sync-rules.yaml`. R&D BOM authoring is a central-plane desk workflow with no edge path.
- Markdown outputs follow `FORMATTING_RULES.md` (one H1, hyphens not em dashes, no arrows in prose).

### Error codes

New: `RD_EXECUTION_BARRED` (409, mandated verbatim by AC 2), `RD_PLACEHOLDER_NOT_PERMITTED` (400), `RD_PLACEHOLDER_UNRESOLVED` (409), `RD_BUILD_NOT_PERMITTED` (409), `BUILD_STATE_INVALID` (409), `BUILD_NOT_FOUND` (404), `SNAPSHOT_IMMUTABLE` (409), `BOM_ALREADY_EXISTS` (409). Reuse: `APPROVAL_REQUIRED` (mandated verbatim by AC 5 - 409 when sign-offs are missing, 403 when the caller is not the resolved approver, following the Story 5.3 `approveEcoHandler` and `transfer-requests.ts` precedent), `BOM_NOT_FOUND` (404), `BOM_ITEM_NOT_FOUND` (404), `INVALID_PARAMS` (400), `DUPLICATE_EVENT` (409), `INVALID_EVENT_STREAM` (400), `FUNCTION_ACCESS_DENIED` (403). Error envelope `{ error_code, message, details, trace_id }` via `AppError(statusCode, errorCode, message, details)` from `src/middleware/error.ts`. There is no central registry file; codes live in the throwing module. `APPROVAL_REQUIRED` is on the architecture spine's stable-code list; the seven new codes are module-local, consistent with every BOM and ECO code shipped so far.

### Previous story intelligence (5.3, plus 5.1 and 5.2 debt)

- Story 5.3 (baseline `0969401`) delivered the ECO lifecycle, the where-used impact read, and the enforced `approved_eco` release-gate condition, with a 14-test integration suite and three new projections. Its structure is the template for this story: canonical SQL in `read/projections/`, TypeScript accessors in `src/read/projections/`, a compliance module cloned from `src/compliance/bom.ts`, handlers cloned from `src/api/v1/ecos.ts`, and exactly two `store.ts` seams.
- Patterns to copy without deviation: envelope-interface pairs appended before `SUPPORTED_EVENT_TYPES`; registry entries appended at the tail before `} as const`; migrations appended at the tail of `MIGRATIONS` and never reordered; named `chk_` / `uq_` / `idx_` constraints; grants `INSERT, SELECT, UPDATE` to `app_user` and `SELECT` to `readonly_user` with no `DELETE`; plain-SELECT `alreadyPersisted` (never `FOR UPDATE` on `domain_events`); `assertValidOccurredAt` on every applier; DROP-plus-ADD constraint pairs wrapped in a transactional `DO $$` block; `FOR UPDATE` on the aggregate row before any state branch.
- Repeat-defect list from the 5.2 and 5.3 reviews, each already covered by a task above: JS-float NUMERIC arithmetic; appliers missing the `occurred_at` guard; unvalidated `limit`/`offset` reaching `LIMIT NaN`; ignoring `persistEvent`'s returned existing event on idempotency replay; exporting dead write helpers whose INSERT column lists drift; tests asserting status codes without error codes or re-reads; suites with no `TRUNCATE` leaving rows across runs; optional-typed fields the tagging gate hard-requires; appliers that never cross-check `revision_id` against `bom_id`.
- Open deferrals this story does NOT touch: global idempotency-key reuse across different transitions (`deferred-work.md` line 211, platform-wide AD-16 convention); the partial-migration failure window in `migrate.ts` (line 219); `correlation_id` passed unvalidated into a UUID column (line 206). If one of these blocks an AC, surface it rather than expanding scope.
- Story 5.1 debt explicitly NOT in scope: `bom_structure` is never populated; cycle and depth detection is unimplemented (`BOM_CYCLE_DETECTED` does not exist); `bom_line.amended` does not re-run the effectivity-overlap predicate.

### Git intelligence

- `0969401` (HEAD) is the Story 5.3 review-hardening commit; `25084ab` and `af39b5e` are the 5.2 and 5.1 BOM commits. The engineering module's entire surface is: `src/compliance/bom.ts`, `src/compliance/eco.ts`, `src/api/v1/boms.ts`, `src/api/v1/ecos.ts`, `src/read/projections/bom.ts`, `src/read/projections/eco.ts`, `src/read/projections/release_gate_checklist.ts`, `src/read/projections/where_used_impact.ts`, `src/server.ts`, and the seven `read/projections/{bom*,eco*}.sql` files. Read all of them before writing R&D code.
- Canonical SQL lives in `read/projections/` at the REPO ROOT, not under `src/`; TypeScript accessors live in `src/read/projections/`. Confusing these two directories is the most common path error in this codebase.
- The repo convention is one integration suite per story named `test/integration/story-<epic>-<story>.test.ts`.

### Technical stack (verified at baseline)

Node.js 24 with built-in `node:test` (serial, `--test-concurrency=1`), TypeScript 5.x with strict ESM, PostgreSQL 18.4, hand-rolled router in `src/api/router.ts`, no web framework, no ORM, no test framework beyond `node:test`, no database mocking. Do NOT add jest, vitest, express, prisma, knex, or any new runtime dependency. No PostgreSQL extensions.

### Testing requirements

- Framework: built-in `node:test` runner, serial, real PostgreSQL from `.env.test`. If integration tests fail on authentication, `DB_PORT` may need `5442` rather than the committed `5432` (a known environment deferral, `deferred-work.md` line 133).
- Gates that will trip this story: `test/unit/schema-drift.test.ts` (canonical `.sql` versus `deploy/compose/init-db.sql` sync - add the three new tables AND update the `bom` and `bom_line` entries), `test/unit/no-hardcoded-role-in-workflow.test.ts` (RBAC through `requireRole` only), `npm run spine-acceptance-contract` (route allowlist in `test/integration/story-1-9.test.ts`).
- Regression suites that MUST stay green because this story changes shared code: `test/integration/story-5-1.test.ts`, `story-5-2.test.ts`, and `story-5-3.test.ts`. The nullable `component_item_id` and the partial `uq_bom_parent_item` are the two changes most likely to break them.

### Project Structure Notes

The file touch map in Table 2 is the authoritative scope boundary; anything outside it needs a recorded reason in the Dev Agent Record. Table 2 lists each file this story creates or updates.

Table 2: File touch map

| **Action** | **Path** | **Change** |
| --- | --- | --- |
| NEW | `read/projections/rd_build_record.sql` | build record header |
| NEW | `read/projections/rd_as_built_line.sql` | immutable as-built snapshot lines |
| NEW | `read/projections/rd_productization_signoff.sql` | three-function sign-off records |
| NEW | `src/compliance/rd-bom.ts` | shape asserts and R&D appliers |
| NEW | `src/read/projections/rd_build.ts` | build and as-built accessors |
| NEW | `src/read/projections/rd_productization.ts` | sign-off accessors and computed gate checklist |
| NEW | `src/api/v1/rd-boms.ts` | eight handlers plus DOA resolution |
| NEW | `test/integration/story-5-4.test.ts` | integration suite |
| UPDATE | `read/projections/bom.sql` | partial `uq_bom_parent_item`, provenance columns |
| UPDATE | `read/projections/bom_line.sql` | placeholder columns, nullable component identity |
| UPDATE | `deploy/compose/init-db.sql` | byte-for-byte mirror of all five SQL changes |
| UPDATE | `src/events/schema.ts` | five payload and envelope pairs plus registry entries |
| UPDATE | `src/events/migrate.ts` | three new migration entries at the tail |
| UPDATE | `src/events/store.ts` | `assertRdShape` and `applyRdProjection` at the two existing seams |
| UPDATE | `src/compliance/bom.ts` | `assertNotRdDraft`, placeholder admission guard, NULL-safe component handling |
| UPDATE | `src/read/projections/release_gate_checklist.ts` | R&D bar and NULL-safe blocking-lines query |
| UPDATE | `src/read/projections/where_used_impact.ts` | NULL-safe component walk |
| UPDATE | `src/read/projections/bom.ts` | nullable component typing, placeholder and provenance columns |
| UPDATE | `src/compliance/eco.ts` | NULL-safe line copy in the `eco.implemented` revision copy |
| UPDATE | `src/server.ts` | Story 5.4 route block |
| UPDATE | `test/integration/story-1-9.test.ts` | `allowedSpineRoutes` additions |
| UPDATE | `test/unit/schema-drift.test.ts` | three new entries plus `bom` and `bom_line` updates |

`src/api/v1/indents.ts` is consumed for `resolveApprover`, never modified. `src/api/v1/events.ts` needs no change - the engineering-stream guard already covers `rd_*`. `src/notify/emit.ts` is not used by this story.

### References

- Epics: `_bmad-output/planning-artifacts/epics.md` - Story 5.4 at lines 1851-1884; Epic 5 at lines 1719-1952; FR-B-09 to FR-B-11 at lines 100-102; FR-RD-08 at line 77; the A-11 item-master prerequisite at line 399.
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` - AD-3 (DOA registry) at lines 82-86, AD-4 (BOM system of record) at lines 88-92, AD-5 (production versus R&D WIP) at lines 94-98, AD-7 (R&D stock segregation) at lines 106-110, AD-16 (idempotency keys) at lines 160-164, AD-17 (notification coupling) at lines 166-171, stable error codes at line 337.
- Previous stories: `_bmad-output/implementation-artifacts/5-3-eco-workflow-and-where-used-impact.md` (ECO module layout and review learnings), `5-2-bom-lifecycle-and-immutability.md` (lifecycle and gate design), `5-1-multi-level-bom-creation.md` (BOM schema origins).
- Deferred ledger: `_bmad-output/implementation-artifacts/deferred-work.md` lines 203-219 (open BOM-module deferrals) and line 133 (test database port).
- Downstream consumers: Story 5.5 (calls `assertNotRdDraft` from the explosion service), Story 5.6 (cost rollups over the productized BOM), Epic 6 (production-order release consumes the same bar), Epic 10 (FR-RD-07 and FR-RD-08 attach prototype build execution and R&D material consumption to `rd_build_record`).

## Dev Agent Record

### Agent Model Used

claude-fable-5 (Claude Code CLI, 2026-08-12)

### Implementation Plan

Executed the seven tasks in story order: schema first (partial `uq_bom_parent_item`, provenance
columns, placeholder columns, three new tables, init-db mirror, schema-drift expectations,
migrate twice), then the five event registrations, then the compliance layer (`rd-bom.ts` plus
the `assertNotRdDraft` bar and placeholder guards in `bom.ts`), then read accessors with the
shared `evaluateProductizationGate` predicate, then the eight routes with DOA resolution, then
the 19-test integration suite, then the QA gates.

### Debug Log References

- `npm run db:migrate` (test env, port 5442) run twice: both complete, `uq_bom_parent_item`
  DROP-plus-CREATE swap proven re-runnable.
- First integration run: 17/19. Two fixes: the Story 5.1 add-line endpoint returns 200 (not
  201), and the direct-events guard test needed a UUID `location_id` (a `'*'` fails
  `validateEnvelope` with `INVALID_EVENT_ENVELOPE` before the stream guard is reached). Both were
  test-side corrections; no production code changed.
- Final gate results: `npm run build` clean; `npm run lint` clean; `npm run format:check` clean;
  `npm test` 824 tests, 810 pass, 14 fail - the 14 failures are exactly the known pre-existing
  idempotency-replay baseline (409 versus 201) in the Epic 1-3 suites, ZERO new failures;
  `test/integration/story-5-4.test.ts` 19/19; `story-5-1`, `story-5-2`, and `story-5-3`
  regression suites all green with zero assertion edits; `npm run spine-acceptance-contract`
  6/6; `npm run edge:test` 30/30; `git diff --check` clean; `graphify update .` run.

### Completion Notes List

- All 5 ACs implemented and covered by `test/integration/story-5-4.test.ts` (19 tests, all
  passing; the 25 minimum cases from Task 6 are grouped into these 19 `it` blocks).
- Recorded deviation (per Task 2): NO `rd_draft.created` event exists. `POST /api/v1/boms` with
  `bom_type: 'rnd'` already drafts an R&D BOM through `bom.drafted`; a parallel creation event
  would fork the BOM header write path.
- Recorded deviation (per Task 2): the epics' `AsBuiltSnapshotCaptured` is split into
  `rd_build.recorded` plus `rd_build.confirmed` because AC 4 requires a build record that exists
  BEFORE confirmation and a capture that happens AT confirmation.
- Scope note (outside Table 2, reason recorded): `src/api/v1/boms.ts` needed a minimal change -
  the draft and add-line handlers strip unknown body fields, so `is_placeholder` and `free_text`
  had to be added to their payload mappings for AC 1's placeholder paths to be reachable. No
  other behaviour of those handlers changed.
- Scope note: `assertLegacyKitMigratedShape` in `src/compliance/bom.ts` now rejects placeholder
  lines at shape time - kit migrations always land as production BOMs and the applier relies on
  component identity being present.
- `assertNotRdDraft` is exported from `src/compliance/bom.ts` and wired at all three AC 2 call
  sites (applyBomReleased, evaluateReleaseGate first-line, getReleaseGateChecklist); Story 5.5
  and Epic 6 import this one predicate.
- The productization checklist and the `rd_draft.productized` applier share
  `evaluateProductizationGate` (exported from `src/read/projections/rd_productization.ts`) so
  the two can never disagree, mirroring the `isApprovedEcoConditionMet` pattern.
- Deviation recompute happens at CONFIRM inside the persist transaction; quantity equality is
  exact PostgreSQL NUMERIC (`$1::numeric = $2::numeric`), never JS floats. The `missing` case
  inserts synthetic as-built rows with continuing line numbers.
- QA gates: `npm run build` clean; `npm run lint` clean; `npm run format:check` clean;
  `npm run db:migrate` twice clean; `test/unit/schema-drift.test.ts` 71/71;
  `test/unit/no-hardcoded-role-in-workflow.test.ts` green; full-suite and
  spine-acceptance-contract results recorded below.

### File List

- NEW `read/projections/rd_build_record.sql`
- NEW `read/projections/rd_as_built_line.sql`
- NEW `read/projections/rd_productization_signoff.sql`
- NEW `src/compliance/rd-bom.ts`
- NEW `src/read/projections/rd_build.ts`
- NEW `src/read/projections/rd_productization.ts`
- NEW `src/api/v1/rd-boms.ts`
- NEW `test/integration/story-5-4.test.ts`
- UPDATE `read/projections/bom.sql`
- UPDATE `read/projections/bom_line.sql`
- UPDATE `deploy/compose/init-db.sql`
- UPDATE `src/events/schema.ts`
- UPDATE `src/events/migrate.ts`
- UPDATE `src/events/store.ts`
- UPDATE `src/compliance/bom.ts`
- UPDATE `src/compliance/eco.ts`
- UPDATE `src/read/projections/bom.ts`
- UPDATE `src/read/projections/release_gate_checklist.ts`
- UPDATE `src/read/projections/where_used_impact.ts`
- UPDATE `src/api/v1/boms.ts` (placeholder field pass-through; reason in Completion Notes)
- UPDATE `src/server.ts`
- UPDATE `test/integration/story-1-9.test.ts`
- UPDATE `test/unit/schema-drift.test.ts`
- UPDATE `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-08-12: Story 5.4 implemented - R&D draft BOM regime: partial `uq_bom_parent_item`,
  placeholder/free-text lines, clone-to-R&D, build records with as-built snapshots and deviation
  flags, three-function productization gate, `RD_EXECUTION_BARRED` execution bar, eight new API
  routes, 19-test integration suite. All QA gates green.
- 2026-08-12: Adversarial code review (Blind Hunter + Acceptance Auditor; Edge Case Hunter empty).
  Decision resolved: `quantity_used` is per-unit, `built_quantity` is informational. 9 patches
  applied: honor client `line_no` in `rd_build.recorded`; post-lock `alreadyPersisted` re-check
  for concurrent same-key retries (recorded/confirmed/productized); `pg_advisory_xact_lock` on
  parent item closing the `BOM_ALREADY_EXISTS` productize race with the false comment corrected;
  clone uses payload `source_revision_id` (deterministic replay); synthetic `missing` rows stamped
  with the confirming event id; productization-gate GET rejects non-rnd with
  `RD_BUILD_NOT_PERMITTED`; `base_quantity_per` computed in PostgreSQL NUMERIC in the three
  rewritten `bom_line` statements; `RdAsBuiltLineInput` is now a discriminated union matching the
  shape assert; new `built_quantity: 2` per-unit regression test (20/20). Status moved to done.

### Review Findings

Adversarial code review 2026-08-12 (Blind Hunter + Acceptance Auditor run in parallel against
baseline `0969401` working tree; Edge Case Hunter layer returned empty and is recorded as failed).
1 decision-needed (resolved to patch), 9 patch, 0 deferred, 2 dismissed as noise. All 9 patches
applied and verified 2026-08-12: story-5-4 20/20, story-5-1/5-2/5-3 62/62, schema-drift and
no-hardcoded-role gates 72/72, build/lint/format:check clean.

- [x] [Review][Decision] Deviation quantity check compares each as-built `quantity_used` against
  the draft per-unit `quantity_per` with no reference to `built_quantity`, so a build of 2 units
  whose line correctly used 2x per-unit is flagged as a `quantity` deviation. Decide whether
  `quantity_used` is per-unit or per-build before patching. [src/compliance/rd-bom.ts:703] -
  **Resolved 2026-08-12 (option 2):** `quantity_used` is per-unit; `built_quantity` is
  informational. Current comparison is correct. Added a patch to prove the semantics with a
  `built_quantity: 2` test.
- [x] [Review][Patch] Add a test with `built_quantity: 2` and per-unit `quantity_used` values
  (matching `quantity_per` exactly) that asserts no `quantity` deviation is flagged, proving the
  per-unit semantics of the confirm-time comparison. [test/integration/story-5-4.test.ts]
- [x] [Review][Patch] `rd_build.recorded` validates and accepts the client's `line_no` but the
  applier discards it and renumbers 1..N, so the stored and returned snapshot rows silently lose
  the caller's line correlation. [src/compliance/rd-bom.ts:571]
- [x] [Review][Patch] Concurrent same-`idempotency_key` retries of `rd_build.confirmed`,
  `rd_build.recorded`, and `rd_draft.productized` throw `SNAPSHOT_IMMUTABLE` /
  `DUPLICATE_EVENT` / `BOM_ALREADY_EXISTS` after blocking on a lock instead of returning the
  first request's result; re-check `alreadyPersisted` after acquiring the lock. [src/compliance/rd-bom.ts:494, 603, 776]
- [x] [Review][Patch] `rd_draft.cloned` stores `source_revision_id` in the payload but the
  applier re-resolves the source revision inside the transaction, making replay nondeterministic
  if the source's `current_revision_id` advances between capture and apply. [src/compliance/rd-bom.ts:425]
- [x] [Review][Patch] The `BOM_ALREADY_EXISTS` pre-check on productize is TOCTOU-racy across two
  R&D drafts of the same parent and its comment is false: `store.ts` already maps
  `uq_bom_parent_item` 23505 to `DUPLICATE_EVENT`, so the race returns the wrong code. Close the
  race (advisory lock per parent item, Story 3.4 precedent) and fix the comment.
  [src/compliance/rd-bom.ts:811]
- [x] [Review][Patch] Synthetic `missing` as-built rows are stamped with the `rd_build.recorded`
  event id instead of the confirming event that created them. [src/compliance/rd-bom.ts:737]
- [x] [Review][Patch] `GET /boms/:bomId/productization-gate` serves a gate for non-R&D BOMs
  while every mutation on the same regime rejects them, contradicting the checklist-gate
  agreement rule. Reject `bom_type <> 'rnd'` with `RD_BUILD_NOT_PERMITTED` like the mutations.
  [src/read/projections/rd_productization.ts:127]
- [x] [Review][Patch] JS-float `base_quantity_per` arithmetic remains in the three `bom_line`
  statements this story rewrote (`applyBomDrafted`, `applyBomLineAdded`, `applyBomLineAmended`),
  violating the binding NUMERIC rule that mandates `$n::numeric * $m::numeric` in SQL.
  [src/compliance/bom.ts:1004, 1139, 1248, 1252]
- [x] [Review][Patch] `RdAsBuiltLineInput.component_sku` is typed optional but the shape assert
  requires it on every non-placeholder line - the type-truth gap Story 5.2 Group 3 corrected, in
  reverse. Align the type with the enforced shape. [src/events/schema.ts:1700]
