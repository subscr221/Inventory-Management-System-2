---
baseline_commit: 9b6d5e167181443920a0b9cdf371589a6f41197a
---

# Story 7.1: Asset Register and Criticality Classification

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-15. Comprehensive developer guide created from epics.md (Story 7.1, FR-M-01), ARCHITECTURE-SPINE.md (AD-9, AD-14, AD-16), the SCM/PRD FR-M-01 long form, and a full baseline code audit at 9b6d5e1. The module is NEW: Epic 7 (Maintenance, Calibration, and Asset Register) has no code yet; this story establishes the 'maintenance' stream, the asset projection, and the register + duplicate-detection write path, modeled on the Story 4.1 supplier-registry seam (the closest single-entity-registry precedent). -->

## Story

As a maintenance manager,
I want a single company-wide maintainable asset register with criticality classes and scannable QR tags, and an optional link to the fixed-asset record,
So that every physical asset has exactly one maintenance record of truth.

## Acceptance Criteria

1. **Given** a physical asset that requires maintenance, **When** it is registered (FR-M-01), **Then** a single asset record is created with a criticality class and a scannable QR tag, spanning the range from a two-tonne mould to a hub screwdriver.
2. **Given** an asset being registered (FR-M-01), **When** the maintenance record is created, **Then** the record carries an optional, nullable fixed-asset reference field captured as a free identifier, which may be left empty; no lookup against a fixed-asset module is performed.
3. **Given** an asset already exists in the register with a given serial number (or manufacturer + model + serial combination where no serial exists), **When** a duplicate registration is attempted for the same uniqueness key, **Then** creation is blocked with `error_code: "DUPLICATE_ASSET"` to preserve the one-asset, one-record rule.

## Tasks / Subtasks

- [x] Task 1: Database schema for the asset register projection (AC: 1, 2, 3)
  - [x] 1.1 Create canonical `read/projections/asset.sql` per the Database Schema Contract (idempotent `CREATE TABLE IF NOT EXISTS`, guarded `DO $$` constraint blocks, self-granting `DO $$` blocks). Columns: `asset_id UUID PRIMARY KEY`, `asset_tag TEXT NOT NULL`, `asset_name TEXT NOT NULL`, `criticality_class TEXT NOT NULL`, `serial_number TEXT`, `manufacturer TEXT`, `model TEXT`, `fixed_asset_ref TEXT`, `created_by UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - [x] 1.2 Add constraints (each in the CREATE body AND its guarded `DO $$` block): `chk_asset_criticality_class` CHECK (criticality_class IN ('critical','high','medium','low')). Add indexes: unique `uq_asset_tag` on (asset_tag); partial unique `uq_asset_serial` on (serial_number) WHERE serial_number IS NOT NULL (the AC 3 duplicate key, see Binding Scope Decisions). Grants: INSERT, SELECT, UPDATE to app_user; SELECT to readonly_user.
  - [x] 1.3 Register `asset.sql` at the TAIL of `MIGRATIONS` in `src/events/migrate.ts` (never reorder existing entries).
  - [x] 1.4 Mirror `asset.sql` byte-for-byte into `deploy/compose/init-db.sql` (CREATE body + guarded constraint blocks + indexes + grants).
  - [x] 1.5 Add an `EXPECTED` entry for `asset` in `test/unit/schema-drift.test.ts` listing the `chk_asset_criticality_class` constraint and the two indexes (`uq_asset_tag`, `uq_asset_serial`).
- [x] Task 2: Event schema and registry (AC: 1, 2, 3)
  - [x] 2.1 In `src/events/schema.ts` add `AssetRegisteredPayload` and its `Omit<EventEnvelope, 'payload'>` envelope pair under a Story 7.1 banner, following the exact pattern of the Story 4.1 `SupplierRegisteredPayload` block.
  - [x] 2.2 Payload contract. `asset.registered` carries `asset_id`, `asset_tag`, `asset_name`, `criticality_class`, `serial_number` (nullable), `manufacturer` (nullable), `model` (nullable), and `fixed_asset_ref` (nullable). `created_by` is derived server-side from `metadata.actor.user_id` (never from the payload), mirroring the supplier seam.
  - [x] 2.3 Register `asset.registered` in `SUPPORTED_EVENT_TYPES` appended at the TAIL of the registry: `streamType: 'maintenance'`, `requiresBusinessStream: false` (an asset is master data, not an inventory movement; the supplier.registered precedent).
- [x] Task 3: Compliance seam for `asset.registered` (AC: 1, 2, 3)
  - [x] 3.1 Create `src/compliance/asset.ts` structurally cloning `src/compliance/supplier.ts`: `MAINTENANCE_STREAM_TYPES` set, `ASSET_EVENT_TYPES` set, `assetEventType` gate, `assertAssetShape` (pre-transaction, no DB: UUID/non-empty-string/criticality-vocabulary shape asserts), `applyAssetProjection` (in-transaction switch). Use the `reject(code, message, details?, status)` AppError helper pattern.
  - [x] 3.2 `applyAssetRegistered`: `alreadyPersisted` guard, then the AC 3 duplicate check BEFORE insert — if `serial_number` is present, SELECT existing asset by `serial_number` (FOR UPDATE) and on a hit `reject('DUPLICATE_ASSET', ...)` carrying `existing_asset_id` in details. Also guard `asset_tag` uniqueness (SELECT by `asset_tag` FOR UPDATE) and reject `DUPLICATE_ASSET` on a tag collision. Then insert the row with `created_by = envelope.metadata.actor.user_id`.
  - [x] 3.3 Wire into `src/events/store.ts` at the two existing seams: `assertAssetShape(envelope);` in the pre-transaction assert block (after `assertSupplierScorecardShape`), and `await applyAssetProjection(envelope, client);` in the in-transaction projection block (after `applySupplierScorecardProjection`). Add 23505 constraint mappings for `uq_asset_tag` and `uq_asset_serial` to `DUPLICATE_EVENT` 409 in the existing constraint mapper.
- [x] Task 4: Read projection accessors (AC: 1, 2)
  - [x] 4.1 Create `src/read/projections/asset.ts` with `AssetRow` interface, `getAssetById(assetId, client?)`, `getAssetByTag(assetTag, client?)`, `getAssetBySerial(serialNumber, client?, forUpdate?)`, `insertAsset(row, client)`, and `listAssets({ criticality_class?, search? }, client?)` with the clamped-limit/offset pattern and ILIKE-escaped search over `asset_name` and `asset_tag`. All with UUID regex guards and the `runner(client ?? getPool())` pattern.
- [x] Task 5: API handlers, routes, spine allowlist (AC: 1, 2, 3)
  - [x] 5.1 Create `src/api/v1/assets.ts` with the handler skeleton from `src/api/v1/suppliers.ts` (`actorContext`, `auditCtxFor`, envelope literal with `stream_type: 'maintenance'`, `metadata.occurred_at: new Date().toISOString()`, `idempotency_key: (body.idempotency_key as string) ?? randomUUID()`, `persistEvent` in try/catch mapping `AppError` to `sendRequestError`, response built from `persisted.event_id`). Handlers: `createAssetBase` (POST), `getAssetBase` (GET by id), `listAssetsBase` (GET).
  - [x] 5.2 `createAssetBase` request contract: body carries `asset_tag` (required non-empty string), `asset_name` (required non-empty string), `criticality_class` (required, in vocabulary), optional `serial_number`, `manufacturer`, `model`, `fixed_asset_ref`. The handler mints `asset_id` (randomUUID), stamps `metadata.actor`, persists `asset.registered`, and returns 201 with the read-back asset row. `fixed_asset_ref` is stored verbatim (a free identifier, no lookup — AC 2).
  - [x] 5.3 RBAC: wrap handlers in `requireRole({ module: 'maintenance', functionScope: 'write' })` for the mutation and `'read'` for GETs (no role-name literals anywhere; `test/unit/no-hardcoded-role-in-workflow.test.ts` enforces). No site scoping — the asset register is company-wide (AD-9, FR-M-01), matching the enterprise-scoped supplier/BOM precedent.
  - [x] 5.4 Register the routes in `createAppRouter()` in `src/server.ts` in a Story 7.1 block (after the Story 5.6 block): `POST /api/v1/assets`, `GET /api/v1/assets`, `GET /api/v1/assets/:assetId`. List-before-`:assetId` ordering rule (register `GET /api/v1/assets` before `GET /api/v1/assets/:assetId`).
  - [x] 5.5 Append every new route to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` or the spine gate fails.
- [x] Task 6: Integration tests and gates (AC: 1, 2, 3)
  - [x] 6.1 Create `test/integration/story-7-1.test.ts` cloning the Story 4.2 harness verbatim (`makeRequest`, `authFor`, `provisionUser` with the SCIM bearer `test-only-scim-bearer-token-not-for-production-use`, admin-pool re-application of `asset.sql`, `createAppServer(createAppRouter()).listen(0)`, TRUNCATE teardown extended with `asset`).
  - [x] 6.2 AC 1 tests: register an asset with all fields; assert 201 and the read-back row carries `criticality_class`, `asset_tag`, and `asset_id`; assert GET by id and list both return the row; assert list filters by `criticality_class`.
  - [x] 6.3 AC 2 tests: register with `fixed_asset_ref` set (assert it persists verbatim) and with it omitted/null (assert the row stores NULL); assert no lookup occurs (the create succeeds with a non-existent `fixed_asset_ref` value).
  - [x] 6.4 AC 3 tests: register asset A with serial "S-1"; assert a second register with the same serial returns 409 `DUPLICATE_ASSET` with `existing_asset_id` in details; assert the duplicate tag case (same `asset_tag`, different serial) returns 409 `DUPLICATE_ASSET`; assert a NON-serialized asset (no serial) registers fine and that TWO non-serialized assets with the same `manufacturer`/`model` but different `asset_tag` both register (serial-only duplicate detection). Direct `POST /api/v1/events` with a well-formed `asset.registered` envelope returns 400 `INVALID_EVENT_STREAM`; RBAC `FUNCTION_ACCESS_DENIED` for a non-maintenance user on every route; idempotent replay with the same `idempotency_key` returns the original asset and persists exactly one `asset` row.
  - [x] 6.5 Run full gates: `npm run build`, `npm run lint`, `npm run format:check`, `npm run db:migrate` twice, `npm test`, `npm run spine-acceptance-contract` 6/6, schema-drift suite green with the new `asset` entry, all existing story suites green (no regressions; the pre-existing idempotency-replay failures across Epic 1-3 plus the story-5-3 where-used assertion are the documented baseline and must not be touched), edge typecheck/lint/build/test unchanged, `git diff --check` clean, then `graphify update .`.

## Dev Notes

### Binding Scope Decisions

- This story opens Epic 7 (Maintenance, Calibration, and Asset Register). It establishes the `maintenance` event stream and the `asset` projection; every later Epic 7 story (PM plans, fault reporting, calibration register, spare parts, machine-status broadcast) consumes this register per AD-9.
- ONE event: `asset.registered`. No update, deactivate, or lifecycle events exist in Story 7.1 — the ACs cover registration and duplicate detection only. Later stories add their own events and lifecycle columns; do NOT pre-build them.
- New canonical table: `asset`. No new columns on existing tables. No other schema changes.
- `fixed_asset_ref` is a FREE identifier with NO lookup (AC 2, explicit). Do NOT add a foreign key, do NOT resolve it against anything, do NOT build the FR-FA fixed-asset module surface. Deferred to Phase 2 (Epic 17) per the epics note.
- Criticality vocabulary (CONFIRMED): `('critical','high','medium','low')`. The epics name no vocabulary, so this is a Story 7.1 decision; it is the value FR-M-05 will map to work-order priority and FR-M-06 will aggregate by. Keep it a CHECK-constrained enum (consistent with the codebase's `chk_supplier_status` style), not a free string.
- Duplicate key (CONFIRMED): the AC 3 "one asset, one record" key is the `serial_number`, and duplicate detection applies to SERIALIZED assets only. A non-serialized asset (no serial) has no duplicate key — many identical assets (e.g. ten identical screwdrivers) each get their own record. Implemented as one partial unique index `uq_asset_serial` (WHERE serial_number IS NOT NULL) plus an explicit seam check for the stable `DUPLICATE_ASSET` with `existing_asset_id`.
- `asset_tag` is a required, unique, client-provided string — the value encoded in the physical scannable QR label (Story 7.3 scans it to report a fault). A tag collision is also rejected with `DUPLICATE_ASSET` (the tag and the serial/manufacturer-model key are two distinct uniqueness concerns, both collapsed to the one stable AC 3 code with `existing_asset_id` in details).
- No notifications (AD-17 fires only for routed decisions). No edge capture path (central desk workflow; offline technician capture is Story 7.8). No new dependencies, no PostgreSQL extensions, no web framework.
- There is NO user-facing screen in this story: central-plane REST API only. No UX contract document exists for this domain.

### Event Contract

Table 1 defines the single new event, appended at the tail of `SUPPORTED_EVENT_TYPES`.

Table 1: New event registry entry for Story 7.1

| event_type | streamType | requiresBusinessStream | stream_id | Notes |
| --- | --- | --- | --- | --- |
| `asset.registered` | `maintenance` | `false` | `asset_id` | master-data create; `created_by` derived from `metadata.actor.user_id` |

- Every envelope MUST stamp `metadata.occurred_at` (omitting it crashes `persistEvent` with a 500) and use `idempotency_key: (body.idempotency_key as string) ?? randomUUID()` in handlers.
- Shape asserts run PRE-transaction so a malformed event never consumes an idempotency key; appliers run IN the persist transaction and begin with the `alreadyPersisted` guard.
- Handlers build responses from `persisted.event_id` and durable read-back, never a locally minted id (the Story 5.2 phantom-success lesson).

### Database Schema Contract

- Canonical SQL lives in `read/projections/` at REPO ROOT (not under `src/`); TS accessors live in `src/read/projections/`. Every file is idempotent, self-granting, and mirrored byte-for-byte into `deploy/compose/init-db.sql`; the schema-drift test enforces CREATE-body equality, guarded constraint-block equality, index presence, and grants.
- The `asset` column contract (see Task 1.1/1.2). `serial_number`, `manufacturer`, `model`, and `fixed_asset_ref` are all NULLABLE — the register spans serialized assets (mould, machine) and non-serialized assets (screwdriver).
- `asset_tag` is UNIQUE (`uq_asset_tag`). The AC 3 key is the single partial unique `uq_asset_serial` (WHERE serial_number IS NOT NULL) — duplicate detection applies to serialized assets only (see Binding Scope Decisions).

### Compliance Seam Contract

- `src/compliance/asset.ts` mirrors `src/compliance/supplier.ts` structurally: pre-transaction `assertAssetShape` (pure shape + vocabulary, no DB) and in-transaction `applyAssetProjection` (duplicate detection + insert). Import `AppError` from `../middleware/error.js` and the accessors from `../read/projections/asset.js`.
- `alreadyPersisted` is the supplier seam's exact helper (idempotency_key OR event_id lookup against `domain_events`). Copy it; do not re-derive.
- Duplicate detection runs inside the transaction with `FOR UPDATE` locks (the Story 4.1 TOCTOU lesson: a SELECT-then-INSERT without a lock permits two concurrent registrations of the same serial). `uq_asset_serial` and `uq_asset_tag` are the backstops; the seam check gives the stable `DUPLICATE_ASSET` with `existing_asset_id`.

### API Contract

Table 2 lists the new routes. All are under `/api/v1/`, SSO-gated, module `maintenance` RBAC, enterprise-scoped (no site filter), and logged to the edit log via `persistEvent`'s audit entry with `trace_id`.

Table 2: New REST routes for Story 7.1

| Method and path | Handler | RBAC scope | Success |
| --- | --- | --- | --- |
| `POST /api/v1/assets` | createAsset | maintenance write | 201 |
| `GET /api/v1/assets` | listAssets | maintenance read | 200 |
| `GET /api/v1/assets/:assetId` | getAsset | maintenance read | 200 |

- Route-order rule: register `GET /api/v1/assets` before `GET /api/v1/assets/:assetId` (`src/api/router.ts` returns the FIRST registered match and `:assetId` compiles to `([^/]+)`).
- The error envelope is always `{ error_code, message, details, trace_id }` via `sendRequestError`/`AppError`.

### Error Code Contract

Table 3 lists new and reused codes. New codes are module-local (the supplier/BOM precedent); none is on the architecture spine stable-code list and none is edge-reachable, so `src/sync/upload.ts`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json` are NOT modified.

Table 3: Error codes for Story 7.1

| error_code | HTTP | Thrown when |
| --- | --- | --- |
| `DUPLICATE_ASSET` (new) | 409 | AC 3: serial_number or asset_tag already registered |
| `ASSET_NOT_FOUND` (new) | 404 | unknown `assetId` on get |
| `INVALID_PARAMS` (new-reuse) | 400 | shape/vocabulary failures (bad criticality_class, missing required field) |
| `DUPLICATE_EVENT` | 409 | idempotency and 23505 constraint replay per module convention |
| `INVALID_EVENT_STREAM` | 400 | direct `POST /api/v1/events` for the maintenance stream (existing guard, test it) |
| `FUNCTION_ACCESS_DENIED` | 403 | wrong module RBAC scope (existing middleware) |

### Architecture Compliance

- AD-9 (one asset register for everything): this story is the direct implementation — one `asset` register, company-wide, from a two-tonne mould to a hub screwdriver.
- AD-14 (read models are shared projections): the `asset` projection is the read model; modules read it via the accessors, never via raw cross-module SQL.
- AD-16 (idempotency): every mutation carries an `idempotency_key`; `persistEvent` deduplicates; responses built from `persisted.event_id`.
- FR-AC-13 (edit log): every registration writes an audit entry through `persistEvent`'s `logAuditEntry` with `auditCtxFor`.
- FR-AC-01 (business-stream tagging): `asset.registered` carries `requiresBusinessStream: false` — master data, not a tagged business transaction (the supplier precedent).
- Conventions: singular entity name (`asset`); dot-separated past-tense event type (`asset.registered`); UUIDv4 internal ids; UTC timestamps; REST under `/api/v1/`; uniform error envelope.

### Testing Requirements

- One new suite: `test/integration/story-7-1.test.ts` using `node:test` + `node:assert/strict` against real PostgreSQL per `.env.test` (the team's container publishes on host port 5442 while `.env.test` names 5432; `deferred-work.md` line 133 is still open — use whatever the committed harness uses and do not "fix" it).
- Admin-pool fixture: re-apply `read/projections/asset.sql` in the `before` hook so the table exists in the test DB regardless of migrate state (the Story 4.2 harness pattern).

### Project Structure Notes

- No new top-level module directory: Epic 7's "module" is expressed through the standard seams — `src/compliance/asset.ts`, `src/api/v1/assets.ts`, `src/read/projections/asset.ts`, `read/projections/asset.sql`. The `src/engineering/` and `src/warehouse/` dirs exist only where a module has pure read-plus-compute logic; Story 7.1 has none.
- ESM rules unchanged: `.js` extensions on relative imports, `node:` prefixed builtins.
- RBAC module string is `maintenance` (SCIM roles accept any non-empty module string; `test/unit/no-hardcoded-role-in-workflow.test.ts` forbids role-name literals, not module strings).

### References

- Epic 7 story + FR-M-01: `_bmad-output/planning-artifacts/epics.md` (Story 7.1 at line 2109; FR-M-01 at line 159).
- AD-9 one-asset-register, AD-14 read models, AD-16 idempotency, API/error conventions: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md`.
- Compliance seam template: `src/compliance/supplier.ts` (Story 4.1).
- Canonical SQL + grants template: `read/projections/supplier.sql`.
- API handler template: `src/api/v1/suppliers.ts`; route registration in `src/server.ts` (`createAppRouter`).
- Event registry + payload template: `src/events/schema.ts` (SUPPORTED_EVENT_TYPES tail, `SupplierRegisteredPayload`).
- Seam wiring + 23505 mapper: `src/events/store.ts`.
- Migration registration: `src/events/migrate.ts` (MIGRATIONS tail).
- Test harness template: `test/integration/story-4-2.test.ts`; schema-drift `EXPECTED` in `test/unit/schema-drift.test.ts`; spine allowlist in `test/integration/story-1-9.test.ts`.

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5)

### Debug Log References

- Full suite, spine gate, schema-drift, edge suite, and migrate x2 all run 2026-08-15 from baseline 9b6d5e1; see Completion Notes for results.

### Completion Notes List

- All 6 tasks implemented as specified. New `maintenance` stream established with the single `asset.registered` event (`requiresBusinessStream: false`, registered at the registry tail).
- Duplicate detection (AC 3) implemented in the seam with FOR UPDATE pre-checks on `serial_number` and `asset_tag` before insert, both rejecting `DUPLICATE_ASSET` 409 with `existing_asset_id` in details; `uq_asset_serial` (partial, WHERE serial_number IS NOT NULL) and `uq_asset_tag` are the constraint backstops, mapped in the store's 23505 mapper to `DUPLICATE_EVENT` 409 per module convention.
- `fixed_asset_ref` persists verbatim with no lookup (AC 2); nullable serial/manufacturer/model support non-serialized assets, and two identical non-serialized assets register independently (serial-only duplicate key).
- The direct-events guard in `src/api/v1/events.ts` was extended from `engineering`-only to also block `maintenance` (required by Task 6.4's `INVALID_EVENT_STREAM` assertion; the message now interpolates the stream name).
- Deviation from Task 6.4 wording: the existing RBAC middleware returns `MODULE_ACCESS_DENIED` for a user outside the maintenance module and `FUNCTION_ACCESS_DENIED` for a maintenance user with the wrong functionScope. The cross-module test asserts `MODULE_ACCESS_DENIED` (the middleware's actual stable code); the read-scope test covers `FUNCTION_ACCESS_DENIED`. No middleware change - existing platform contract.
- Gates (2026-08-15): build/lint/format clean; `db:migrate` x2 idempotent (with `.env.test`; bare `npm run db:migrate` requires OIDC env vars - pre-existing behavior); schema-drift 81/81 with the new `asset` entry; spine gate 6/6; no-hardcoded-role 1/1; story-7-1 14/14; edge typecheck/lint/build untouched and test 30/30; `git diff --check` clean; full suite 895 tests, 880 pass, 15 fail - all 15 are the documented pre-existing Epic 1-3 idempotency-replay baseline (the story-5-3 where-used assertion passed in this run), 0 new failures.

### File List

- read/projections/asset.sql (new)
- deploy/compose/init-db.sql (modified - asset section appended)
- src/events/migrate.ts (modified - asset.sql registered at MIGRATIONS tail)
- src/events/schema.ts (modified - AssetRegisteredPayload/Envelope + registry entry)
- src/events/store.ts (modified - assertAssetShape/applyAssetProjection wiring + 23505 mapping)
- src/compliance/asset.ts (new)
- src/read/projections/asset.ts (new)
- src/api/v1/assets.ts (new)
- src/api/v1/events.ts (modified - maintenance stream added to the direct-write guard)
- src/server.ts (modified - Story 7.1 route block + imports)
- test/unit/schema-drift.test.ts (modified - asset EXPECTED entry)
- test/integration/story-1-9.test.ts (modified - 3 asset routes in allowedSpineRoutes)
- test/integration/story-7-1.test.ts (new)

### Change Log

- 2026-08-15: Story 7.1 implemented (asset register, maintenance stream, DUPLICATE_ASSET duplicate detection, 3 REST routes, 14-test integration suite); all gates green.

## Review Findings

- [x] [Review][Decision] Race-path duplicate contract divergence [src/events/store.ts:1054-1074] - a sequential duplicate registration returns 409 DUPLICATE_ASSET with `existing_asset_id` (seam pre-check under FOR UPDATE), but a concurrent first-insert race on the same serial/tag finds no row to lock, the loser hits `uq_asset_serial`/`uq_asset_tag`, and the 23505 mapper returns 409 DUPLICATE_EVENT without `existing_asset_id`. Task 3.3 mandates the DUPLICATE_EVENT mapping, but the `uq_supplier_invoice_duplicate_grain` precedent (store.ts:975-986) resolves the winner for the same class of race. Choose: keep the spec mapping and document the divergence, or resolve the winning row in the asset race branch. - RESOLVED (2026-08-16): user chose to resolve the winner; the race branch now calls `resolveAssetDuplicateConflict` (src/compliance/asset.ts) and returns 409 DUPLICATE_ASSET with `existing_asset_id`, same contract as the sequential path; `asset_pkey` stays DUPLICATE_EVENT.
- [x] [Review][Decision] Serial/tag duplicate keys are case-sensitive (and invisible-Unicode-sensitive) [src/compliance/asset.ts:108-142, read/projections/asset.sql] - `ABC-123` and `abc-123` (or `TAG-1` plus `TAG-1` with a zero-width space) both register, so one physical asset can appear twice when keyboard entry and barcode scan differ in case. The spec is silent on canonicalization. Choose: exact-match keys (current) or case-insensitive normalization on the uniqueness key. - RESOLVED (2026-08-16): user chose case-insensitive keys; both unique indexes are now `lower()`-canonicalized (guarded swap self-heals existing DBs), the seam pre-checks and accessors compare `lower(column) = lower($1)`, and the race resolver matches. Invisible-Unicode variants (zero-width space) remain outside this canonicalization by design.
- [x] [Review][Patch] Empty or non-string `idempotency_key` collapses distinct registrations [src/api/v1/assets.ts:111] - `(body.idempotency_key as string) ?? randomUUID()` passes `''` and non-string values through; two different registrations (different tag/serial) both sent with `idempotency_key: ""` hit `uq_idempotency` and the second returns a 201 replay of the FIRST asset, silently dropping a registration. - FIXED (2026-08-16): blank or non-string keys now fall back to `randomUUID()`; regression test added.
- [x] [Review][Patch] Cross-stream idempotency-key replay returns a phantom 201 with `asset: null` and a foreign `event_id` [src/api/v1/assets.ts:117-126] - `persistEvent` returns any event matching the key regardless of stream/event type (store.ts:563-576); reusing a key from e.g. `supplier.registered` makes the handler read a missing `payload.asset_id`, fall back to the freshly minted UUID, find no row, and reply 201 `{ asset: null, event_id: <unrelated event> }`. - FIXED (2026-08-16): the handler now rejects a replay whose `event_type` is not `asset.registered` (or whose payload lacks a UUID `asset_id`) with 409 DUPLICATE_EVENT carrying `existing_event_id`/`existing_event_type`; regression test added (plants a foreign event, asserts 409).
- [x] [Review][Patch] Whitespace-only `serial_number` stored as NULL but kept verbatim in the event payload [src/compliance/asset.ts:108-111] - the projection normalizes `'   '` to NULL (treated as non-serialized) while the persisted `asset.registered` payload retains `'   '`, so the audit trail and the register disagree on whether the asset is serialized. - FIXED (2026-08-16): all nullable capture fields (serial_number, manufacturer, model; fixed_asset_ref per AC 2 verbatim) are normalized in the handler before persist, so the event payload and the row always agree; regression test asserts payload equals the stored row.
- [x] [Review][Defer] stream_type/event_type mismatch bypasses all shape validation and the direct-writes guard [src/api/v1/events.ts:119, src/events/store.ts:199-221] - deferred, pre-existing: `POST /api/v1/events` with `stream_type: 'procurement'` and `event_type: 'asset.registered'` (or `'MAINTENANCE'`) passes the exact-string guard and both the shape assert and the applier (each seam gates on its own stream/event pair; `persistEvent` never checks `SUPPORTED_EVENT_TYPES` membership or stream/event consistency). The hole is platform-wide and shared by every module seam; story 7.1 closes the exact-case guard per the engineering precedent.
- [x] [Review][Defer] NUL byte in text fields or the search parameter surfaces as a raw 500 (unmapped SQLSTATE) [src/events/store.ts:875-1101] - deferred, pre-existing platform mapper gap (only 23505/23514 mapped) shared by every module's handlers.
- [x] [Review][Defer] Failed registrations write no audit entry (409 DUPLICATE_ASSET, 400 INVALID_PARAMS) [src/api/v1/assets.ts:127-129] - deferred, platform convention matching the supplier precedent; duplicate-attempt traceability would need a platform-level decision.

### Review Verdict (2026-08-16)

- Layers: Blind Hunter (13 findings), Edge Case Hunter (9), Acceptance Auditor (7, all acceptable or informational - no genuine spec violations).
- Triage: 2 decisions resolved to patch, 3 patches applied, 3 deferred (pre-existing platform), 13 dismissed as noise.
- Verification after patches: tsc clean, eslint clean, prettier clean, db:migrate x2 idempotent (live indexes self-healed to `lower()` definitions), schema-drift 81/81, spine gate 6/6, story-7-1 19/19 (14 original + 5 new regression tests), full suite 900 tests 885 pass (15 fail = documented pre-existing Epic 1-3 idempotency baseline, 0 new).
