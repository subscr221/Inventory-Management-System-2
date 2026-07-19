# Story 1.6: Event-Sourced Location with Asserted/Expected Separation

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a warehouse manager,
I want the system to store where an operator says stock is (asserted) separately from where it should be based on plans (expected), raising a visible exception on discrepancy rather than silently overwriting,
So that location data is trustworthy, every discrepancy is auditable, and stock can never disappear through a silent location merge.

## Acceptance Criteria

1. **Given** a putaway event arrives with `asserted_location: "BIN-A43"` for a lot whose expected location `BIN-A47` was recorded by a prior expected-location event (in production sourced from ASN/putaway plans arriving with Epic 3; seeded synthetically as an opaque test event for spine testing - lot IDs are opaque identifiers until Epic 2 defines the lot master)
   **When** the event is processed
   **Then** a `location.disputed` event is raised referencing both asserted and expected facts with actor provenance
   **And** the asserted location becomes the current location projection
   **And** the expected location fact is preserved - neither is deleted nor overwritten

2. **Given** two devices submit stock movement events with the same `idempotency_key` within 10 seconds
   **When** the central event store processes the second submission
   **Then** HTTP 409 is returned with the existing `event_id`; the location is updated exactly once (AD-16)

3. **Given** no location event has been received for a lot
   **When** the lot's current location is queried
   **Then** the response returns `{ "location": null, "confidence": "none" }` - no default location is invented

## Requirements

- INT-LOC-01 - submit stock movement events with asserted locations; verify expected location is computed; verify mismatches are exceptions, not silent overwrites.
- AD-15 (asserted/expected separation) - the current location is a projection, never a mutable column; asserted facts stored separately from expected facts; a mismatch is an exception, not a silent overwrite; last-writer-wins is blocked.
- AD-16 (idempotent movement events) - every movement command carries an `idempotency_key`; the central plane deduplicates and returns HTTP 409 with the existing event id; the balance updates exactly once.
- AD-12 (Compliance Spine as Platform Layer) - event-sourced location is one of the six spine invariants, built and acceptance-tested before any module epic (Epic 2) lands.
- AD-14 (Read Models are Shared Projections) - the current location is a PostgreSQL projection under `src/read/projections/`, built from the event stream, never a cross-module direct table read.
- Spine Acceptance Contract test #3 (Event-Sourced Location) - asserted and expected stored separately; discrepancy raises `location.disputed`; last-writer-wins does not occur (consumed by Story 1.9).

## Tasks / Subtasks

- [ ] Task 1: Location projection schema (AC: 1, 3)
  - [ ] 1.1 Create `read/projections/location.sql` as the CANONICAL file, carrying its OWN guarded grant blocks (`DO $$ ... IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') ... $$`), exactly like `read/projections/audit_log.sql` and `read/projections/doa_registry.sql` do, deliberately NOT like `read/projections/users.sql` (the split-brain grant bug logged in `deferred-work.md`; see project decision `migrations.dual_file_self_sufficient_guarded_grants`). Define three structures that keep asserted and expected facts physically separate (AD-15: "asserted facts stored separately from expected facts; neither overwrites the other"):
    - `location_asserted_facts (fact_id UUID PK DEFAULT gen_random_uuid(), lot_id UUID NOT NULL, asserted_location TEXT NOT NULL, recorded_by UUID NOT NULL, device_id TEXT, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), confidence TEXT NOT NULL DEFAULT 'none', source_event_id UUID NOT NULL, CONSTRAINT uq_location_asserted_lot UNIQUE (lot_id))`. A lot has at most one current asserted fact; the unique constraint enforces the single-current-location projection (the most recent asserted wins, but never by last-writer-wins of a mutable column - by an explicit event-driven upsert, see Task 2). Keep `lot_id` opaque UUID here; do NOT add an FK to any lot master (Epic 2 owns the lot register; Story 1.6 keeps lot IDs opaque per the epic's AC1 phrasing).
    - `location_expected_facts (fact_id UUID PK DEFAULT gen_random_uuid(), lot_id UUID NOT NULL, expected_location TEXT NOT NULL, source TEXT NOT NULL, source_event_id UUID NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT uq_location_expected_lot UNIQUE (lot_id))`. Expected facts are append-preserving: the unique constraint on `lot_id` enforces one current expected fact, but AC1 requires the prior expected fact to be preserved (not deleted/overwritten) when a dispute is raised - so the dispute path records the divergence in the event, and the expected row is updated in place only after the dispute event (see Task 2.2 note). Keep `source` as a free-text provenance label (e.g. `'seed'`, `'asn_plan'`).
    - `location_current (lot_id UUID PRIMARY KEY, location TEXT, confidence TEXT NOT NULL DEFAULT 'none', asserted_fact_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`. This is the read projection the `GET` endpoint returns. Empty/`NULL` location + `confidence = 'none'` is the initial state for a lot with no events (AC3). No default location value is ever written.
    - Indexes: `idx_location_asserted_lot (lot_id)`, `idx_location_expected_lot (lot_id)`. The `CONSTRAINT UNIQUE (lot_id)` on each facts table is the backstop; upsert logic lives in the projection module (Task 2), not the DDL.
  - [ ] 1.2 Mirror the full DDL + guarded grants into `deploy/compose/init-db.sql` under a new `-- Event-sourced location (Story 1.6)` section, following the dual-file convention (Story 1.3 established, 1.4/1.5 followed): a banner comment at the top of both files stating they MUST stay identical. `deploy/compose/init-db.sql` is the first-boot copy, not the sole source of grants.
  - [ ] 1.3 Register `../../read/projections/location.sql` in `src/events/migrate.ts`'s `MIGRATIONS` array, after `business_stream_config.sql`.

- [ ] Task 2: Location invariant enforcement at the write path (AC: 1, 2)
  - [ ] 2.1 Implement `src/compliance/location.ts` exporting `assertLocationInvariant(envelope: EventEnvelope): Promise<void>` (async because it reads the projection to compare asserted vs expected). This is the single enforcement point for AD-15. It throws `AppError` on a hard violation and returns `void` on success. Logic:
    - Define `LOCATION_STREAM_TYPES = new Set(['inventory'])` at module scope (the set whose events carry stock-movement location data). If `envelope.stream_type` is NOT in this set, return immediately - non-location events (DOA, SCIM, business-stream config) are byte-for-byte unaffected, mirroring `assertInventoryTagging`'s guard in `src/compliance/business-stream.ts`.
    - Recognize the two location event types this story introduces: an expected-location event (`location.expected`, payload `{ lot_id, expected_location, source }`) and an asserted-location event (`location.asserted`, payload `{ lot_id, asserted_location, device_id?, confidence? }`). For a non-location event_type, return immediately (the inventory stream also carries non-location events like `stock.allocated`; only `location.*` types trigger location logic).
    - For `location.asserted`: read the current `location_expected_facts` row for the `lot_id`. If an expected fact exists AND `asserted_location <> expected_location`, then AFTER recording the asserted fact, a `location.disputed` event must be raised (Task 2.2). The asserted location still becomes the current location (AC1 "the asserted location becomes the current location projection"). If no expected fact exists, no dispute - just record asserted as current.
    - For `location.expected`: record/upsert the expected fact. This story seeds expected facts synthetically for spine testing (the prior expected-location event in AC1); production expected facts arrive from Epic 3 ASN/putaway plans. No dispute is raised by an expected event alone.
    - IMPORTANT: the location events in this story are `stream_type: 'inventory'`, so they pass through `assertInventoryTagging` FIRST (Story 1.5 added that call at the top of `persistEvent`). The synthetic spine-test fixtures MUST carry a valid `business_stream` (and any cost_centre/project_code the applicable rule requires) or they will be rejected with `UNTAGGED_TRANSACTION` before location logic runs. Flag this in the test design so fixtures are compliant.
    - The dispute is NOT an HTTP rejection - AD-15 says "an exception, not a silent overwrite", meaning a recorded `location.disputed` event, not an error code. Do NOT invent a `LOCATION_DISPUTE`-style error code; reuse the stable envelope `{ error_code, message, details, trace_id }` only if a HARD validation fails (e.g. missing `lot_id` or `asserted_location` in the payload). AC1's divergence is an event, not a 4xx.
  - [ ] 2.2 Wire the location logic into `persistEvent` in `src/events/store.ts`, alongside the existing `assertInventoryTagging` call, so the asserted/expected comparison, the current-location projection update, and the `location.disputed` event all commit atomically in the SAME transaction as the domain event. Pattern (mirrors Story 1.4's `client` param and Story 1.5's assetInventoryTagging placement):
    - Placement: call `await assertLocationInvariant(envelope)` AFTER `assertInventoryTagging(envelope)` (tagging is a pure pre-write gate; location needs the transaction `client`), but BEFORE `BEGIN`/insert is fine for the pure validation half. The projection-write half that records asserted/expected facts and raises `location.disputed` MUST run inside the transaction using the `externalClient ?? (await pool.connect())` client, via the existing `ownsTransaction` pattern, so the fact rows, the dispute event, and the `domain_events` insert commit together (AD-16: location updates exactly once; NFR-DI-01 atomicity).
    - To raise `location.disputed` within the same transaction, call `persistEvent` for the dispute event re-entrantly on the same `client` (pass `externalClient: client`), exactly as the DOA and business-stream admin endpoints call `persistEvent(..., client)` - OR, simpler and preferred for spine determinism, compute the dispute synchronously: write the asserted/expected upserts on `client`, then `INSERT` the `location.disputed` row into `domain_events` directly on `client` (reusing the same `nextVersion`/envelope fields) before the `COMMIT`. The re-entrant `persistEvent(client)` call is cleaner and avoids duplicating version logic; use it. The dispute payload must carry `asserted_location`, `expected_location`, `actor` (from `envelope.metadata.actor`), `reason` (e.g. `'location_mismatch'`), and `confidence` - matching the UX contract in `EXPERIENCE.md:304-307, 828` (`asserted=BIN-A43, expected=BIN-A47, actor=Vikram, reason=Accessibility, confidence=Certain`).
    - Keep `validateEnvelope` OUT of `persistEvent` (settled decision in Story 1.5; structural shape checks stay in the HTTP handler `src/api/v1/events.ts`). The location payload shape checks (required `lot_id`, `asserted_location`/`expected_location`) are domain-invariant checks done in `assertLocationInvariant`, throwing `AppError(400, 'INVALID_PARAMS', ...)` only on a genuinely malformed location payload.
  - [ ] 2.3 Add a focused unit test `test/unit/location.test.ts` (Node built-in test runner, like `test/unit/business-stream.test.ts`) covering: a non-location stream type passes through with no payload; an inventory stream event that is not a `location.*` type passes through; an inventory `location.asserted` with no prior expected fact records asserted as current and raises NO dispute; an inventory `location.asserted` whose location differs from the current expected fact raises a dispute referencing both facts; the stream-type guard returns immediately for a `doa_registry_entry` event. Mock the projection reads/writes via a `deps` injection seam (`assertLocationInvariant(envelope, deps?)` defaulting to real projection functions, mirroring `assertInventoryTagging(envelope, deps?)`), so the unit test is DB-free and fast.

- [ ] Task 3: Current-location read endpoint + synthetic expected-fact seeding (AC: 1, 3; spine-test scaffolding)
  - [ ] 3.1 Implement `src/api/v1/location.ts` with `GET /api/v1/locations/:lotId` wrapped in `requireRole({ module: 'inventory', functionScope: 'read' })`. Resolve `lotId` from params; validate it is a UUID (`INVALID_PARAMS` otherwise). Return the `location_current` row as `{ location: <TEXT|null>, confidence: <'none'|'low'|'certain'> }`. For a lot with no row (AC3), return `{ "location": null, "confidence": "none" }` - do NOT invent a default. This is the endpoint the Spine Acceptance Contract test #3 and the integration tests call.
  - [ ] 3.2 Implement a synthetic expected-fact seeding endpoint for spine testing, mirroring how Story 1.4 built a spine-test scaffold and Story 1.7 builds a synthetic QC-result command (`epics.md:781`): `POST /api/v1/locations/:lotId/expected` wrapped in `requireRole({ module: 'inventory', functionScope: 'write' })` (or `module: 'compliance'` if you prefer the admin framing; be consistent and note it). Body: `{ expected_location, source }`. It builds an `EventEnvelope` with `stream_type: 'inventory'`, `stream_id: lotId`, `event_type: 'location.expected'`, a valid `payload` carrying `business_stream` (production) plus `expected_location` and `source`, and a valid `metadata` (actor + correlation_id + occurred_at), then calls `persistEvent(envelope, auditCtx, client)` atomically (reuse the `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` helper shape from `src/api/v1/doa.ts`, duplicated with a comment if extraction risks regressing 1.4). This is the "prior expected-location event" the AC1 "Given" seeds. It must be testable with ZERO module code present (Spine Acceptance Contract runs against a spine with no modules).
  - [ ] 3.3 Do NOT add PUT/PATCH/DELETE for location facts. The current location is event-sourced; it changes only through `location.*` events. Keep lot IDs opaque (no lot master in Epic 1). Document this scope boundary in a code comment so a future agent does not add a mutable location column or a lot-master FK.

- [ ] Task 4: Route registration
  - [ ] 4.1 Register the routes in `src/server.ts`: `router.get('/api/v1/locations/:lotId', getCurrentLocationHandler)` and `router.post('/api/v1/locations/:lotId/expected', seedExpectedLocationHandler)`. No `src/api/router.ts` changes needed; `get()`/`post()` already exist. Import the handlers from `src/api/v1/location.ts`.

- [ ] Task 5: Integration tests (AC: 1, 2, 3)
  - [ ] 5.1 Create `test/integration/story-1-6.test.ts` following the exact harness pattern in `test/integration/story-1-4.test.ts` / `story-1-5.test.ts`: `before`/`after` hooks that run migrations via `getAdminPool()`, a `makeRequest` helper, a `provisionUser`/`authFor` helper pair (reuse the SCIM + dev-token plumbing). In `before()`, apply migrations in order: `domain_events.sql`, `users.sql`, `audit_log.sql`, `doa_registry.sql`, `business_stream_config.sql`, `location.sql`. Clean up with `TRUNCATE ... CASCADE` (the audit tables need the documented `ALTER TABLE ... DISABLE TRIGGER ALL` escape hatch before TRUNCATE and `ENABLE TRIGGER ALL` in a `finally`, exactly as `story-1-4.test.ts` does). Do NOT truncate `business_streams` (idempotent seed). Integration tests run serially via `--test-concurrency=1` in `package.json` (Story 1.4's fix) - do not change that. Use a dedicated test port.
  - [ ] 5.2 AC1 (asserted/expected separation + dispute): provision an admin user with `role` granting `module: 'inventory'`, `functionScope: 'write'`, `locationId: '*'`. Seed an expected fact for a random `lotId` via `POST /api/v1/locations/:lotId/expected` with `expected_location: 'BIN-A47'`. Then `POST /api/v1/events` with `stream_type: 'inventory'`, `stream_id: lotId`, `event_type: 'location.asserted'`, `payload: { business_stream: 'production', lot_id: lotId, asserted_location: 'BIN-A43' }` (MUST include `business_stream` or `assertInventoryTagging` rejects it with `UNTAGGED_TRANSACTION`), `metadata` with a valid actor + `correlation_id` + `occurred_at`. Assert 201. Then `GET /api/v1/locations/:lotId` and assert `location === 'BIN-A43'` (asserted becomes current) and `confidence` is non-null. Assert a `location.disputed` event exists in `domain_events` for that `lotId` whose payload references BOTH `asserted_location: 'BIN-A43'` and `expected_location: 'BIN-A47'` and carries `actor`. Assert `location_expected_facts` for the lot still has `expected_location = 'BIN-A47'` (preserved, not overwritten/deleted).
  - [ ] 5.3 AC2 (idempotency exactly-once): submit two `POST /api/v1/events` calls with `stream_type: 'inventory'`, `event_type: 'location.asserted'`, identical `idempotency_key` and `lot_id`, within the test's 10-second window. Assert the first returns 201 and the second returns 409 `DUPLICATE_EVENT` with `details.existing_event_id` equal to the first event's id (`test/integration/story-1-1.test.ts:247-276` precedent). Assert exactly ONE `location_asserted_facts` row for the lot (updated exactly once, AD-16).
  - [ ] 5.4 AC3 (no invented default): `GET /api/v1/locations/:brandNewLotId` for a lot with zero events. Assert 200 with `{ "location": null, "confidence": "none" }`. Assert no `location_current` row was auto-created with a fabricated location.
  - [ ] 5.5 RBAC boundary: a caller with no role assignment for module `inventory` gets 403 `MODULE_ACCESS_DENIED` on both `GET /api/v1/locations/:lotId` and `POST /api/v1/locations/:lotId/expected`.
  - [ ] 5.6 Non-location passthrough regression guard: submit `POST /api/v1/events` with `stream_type: 'doa_registry_entry'` (no `business_stream`, no `lot_id`) and assert it still succeeds - proving `assertLocationInvariant`'s stream-type guard did not break Stories 1.1 through 1.5, exactly as `story-1-5.test.ts:5.8` guards tagging. Also assert a plain `inventory` non-location event (`event_type: 'stock.allocated'`, `business_stream: 'production'`) succeeds and does NOT touch the location tables.
  - [ ] 5.7 Run `npm run lint`, `npx tsc --noEmit`, and `npm run test:integration`; all clean. Confirm the full aggregate suite (Stories 1.1 through 1.5) still passes with no regressions.

## Dev Notes

### Previous Story Intelligence (from Story 1.5, then 1.4)

- **`persistEvent(envelope, auditCtx?, externalClient?)` in `src/events/store.ts`** is the established central write path. It writes the domain event and (if `auditCtx` is supplied) the audit-log entry atomically in one transaction, and accepts an optional caller-supplied `PoolClient` so a caller's row write and the event write commit together. Story 1.5 added the `assertInventoryTagging(envelope)` call at the TOP of `persistEvent` (line 153), BEFORE any DB write. Story 1.6 must place its location logic so that (a) the pure validation/comparison runs after tagging, and (b) the projection writes + `location.disputed` event commit inside the same transaction as the triggering `location.asserted` event. Reuse the existing `ownsTransaction` / `client` plumbing (lines 168-263) - do NOT rewrite `persistEvent`'s transaction structure; extend it.
- **Stream-type gating pattern (`src/compliance/business-stream.ts`):** `INVENTORY_MOVEMENT_STREAM_TYPES = new Set(['inventory'])` at module scope; non-inventory streams return immediately. Story 1.6 mirrors this with `LOCATION_STREAM_TYPES = new Set(['inventory'])` and additionally returns for non-`location.*` event types within the inventory stream. The 1.5 dev notes explicitly say "This gating mirrors how the spine invariants in Stories 1.6 and 1.7 are scoped to their own stream types."
- **`requireRole({ module, functionScope, locationId? })` from `src/middleware/rbac.ts`** wraps a `RouteHandler`. The events POST handler resolves `module` dynamically from `body.stream_type` (`resolveModuleFromBody` in `src/api/v1/events.ts:10`), so an inventory-movement event requires `module: 'inventory'`. Handlers read actor identity from `getAuthContext(req)`/`getAuthorizedAssignment(req)`, NEVER from the request body (Story 1.2+ finding carried forward).
- **`actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` sentinel (`00000000-0000-0000-0000-000000000000`)** pattern lives in `src/api/v1/doa.ts`. The synthetic expected-fact seeding endpoint (Task 3.2) should reuse the SAME helper shape - duplicate the ~15-line helper with a comment pointing to `doa.ts` as the source (the story-1-5 precedent chose duplication over extraction to avoid regressing 1.4). The audit `location_id` records the real `'*'`; the envelope `metadata.actor.location_id` uses the zero-UUID sentinel.
- **Migration + dual-file convention:** every new table lives in a canonical `read/projections/*.sql` applied by `src/events/migrate.ts` AND the test harness `before()`, mirrored in `deploy/compose/init-db.sql` for first-boot. The canonical file carries its OWN guarded grants (`DO $$ ... IF EXISTS (SELECT FROM pg_roles ...) ... $$`), matching `audit_log.sql` and `doa_registry.sql`. `read/projections/users.sql` does NOT follow this (split-brain bug in `deferred-work.md`) - do NOT copy it. The `MIGRATIONS` array in `src/events/migrate.ts:8` currently ends with `business_stream_config.sql`; append `location.sql` after it.
- **Test harness shape:** `test/integration/story-1-4.test.ts` builds a minimal `Router` + handler wiring inside `before()`, runs migrations via `getAdminPool().query(readFileSync(...))`, provisions users via SCIM + dev-token, and tears down with `closePool()`/`closeAdminPool()`. Cleanup uses `TRUNCATE ... CASCADE` with the audit-tamper-trigger escape hatch. Follow this exactly for `story-1-6.test.ts`.
- **DATE timezone bug (project constraint `date.timezone_format_local_ymd`):** node-postgres parses a `DATE` column into a JS `Date` at local midnight; `toISOString()` shifts the calendar day back one in non-UTC timezones (Story 1.4 hit this on `doa_vacation_delegations`). This story's location tables use `TEXT`/`TIMESTAMPTZ`, not `DATE`, so the bug does not directly apply - but if any `DATE` column is ever added, format from local Y-M-D components like `toDateString()` in `src/read/projections/business_stream_config.ts:51`.
- **Git intelligence:** Stories land as a single `feat(...)` commit; review remediation lands as separate labeled follow-up commits (never silent amends). No fixup-commit spam.

### Where Enforcement Lives (design decision, documented not blocking)

The Spine Acceptance Contract test #3 (Story 1.9) submits "stock movement events with asserted locations; verify expected location is computed; verify mismatches are exceptions, not silent overwrites." Three placements were considered for the location logic:

1. In `persistEvent` (central event store write), gated by `stream_type` + event_type. (CHOSEN)
2. In the `POST /api/v1/events` HTTP handler, after `validateEnvelope`.
3. In a dedicated `assertLocationInvariant` called by both.

This story chooses placement 1, with the comparison logic in a separate `src/compliance/location.ts` module (Task 2.1) for testability (mirrors Story 1.5's `assertInventoryTagging` split). Reasons:
- The offline edge sync path (Story 1.8, not yet built) replicates edge-captured events into `persistEvent`, NOT through the HTTP handler. If enforcement lived only in the HTTP handler, an edge-captured putaway would sync through unchecked, defeating AD-15.
- The public `POST /api/v1/events` path calls `persistEvent`, so placement 1 covers it transitively.
- Internal adapters (SCIM, DOA registry, tagging config) call `persistEvent` directly with non-inventory stream types; the stream-type guard returns immediately for those, byte-for-byte unaffected.

The `location.disputed` event is raised WITHIN `persistEvent`'s transaction (re-entrant `persistEvent(client)` or direct `domain_events` insert on the same `client`) so the asserted fact, expected fact, current projection, and dispute event all commit together - last-writer-wins is structurally impossible because there is no mutable location column to overwrite.

### Domain Event Vocabulary (conventions)

- `location.expected` - records where a lot SHOULD be (ASN/plan; seeded synthetically here). Payload: `{ lot_id, expected_location, source }`.
- `location.asserted` - records where an operator SAYS it is. Payload: `{ lot_id, asserted_location, device_id?, confidence? }`.
- `location.disputed` - raised when asserted differs from expected. Payload: `{ lot_id, asserted_location, expected_location, actor, reason, confidence }`. NOT an error - an event.
- `location.override` is DEFERRED to Story 3.5 (asserted overrides expected with a reason code + operator identity). Story 1.6 keeps lot IDs opaque and does NOT presuppose the lot master (Epic 2, Story 2.1) or the location register (Story 2.1).

### Architecture Compliance

- **AD-12 (Compliance Spine as Platform Layer):** event-sourced location is one of the six spine invariants. This story delivers it and it must be acceptance-tested (Story 1.9, test #3) before Epic 2 inventory lands.
- **AD-15 (Asserted/Expected Separation):** current location is a projection, never a mutable column; asserted and expected facts are separate tables; a mismatch raises `location.disputed` (an event) and is never silently overwritten; last-writer-wins blocked.
- **AD-16 (Idempotency Keys):** reuse the EXISTING `persistEvent` dedup path (unique constraint `uq_idempotency` on `domain_events.idempotency_key`, caught at `store.ts:233-258` as `AppError(409, 'DUPLICATE_EVENT', ...)`). Story 1.6 AC2 does NOT need new idempotency code - just exercise the existing mechanism and assert the location projection updated exactly once. Tagging enforcement (Story 1.5) runs before the idempotency INSERT, so an untagged location event is rejected before consuming an idempotency key (consistent with 1.5's AD-16 note).
- **AD-14 (Read Models are Shared Projections):** the current-location projection lives in `src/read/projections/location.ts` over PostgreSQL tables; no cross-module direct table read.
- **Consistency Conventions:** events past-tense dot-separated (`location.asserted`, `location.disputed`); error envelope `{ error_code, message, details, trace_id }` from `src/middleware/error.ts` (`AppError`/`sendJson`/`sendRequestError`, do not hand-roll); singular logical modules; plural table names (`location_asserted_facts`, `location_expected_facts`, `location_current`) matching the existing `business_streams`/`transaction_tagging_rules` plural-table precedent (Stories 1.3-1.5 followed the real codebase convention, not the idealized singular doc read).
- **Stable error codes:** this story reuses `DUPLICATE_EVENT` (409, already in the architecture stable list) and `INVALID_PARAMS` (400). It introduces NO new location-dispute error code - divergence is an event, not a rejection. If a HARD payload validation fails (missing `lot_id`/`asserted_location`), throw `INVALID_PARAMS` (already stable).
- **NFR-DI-01 (ACID):** the asserted/expected/didputed writes and the domain_event insert commit atomically in one transaction; no double location update.

### Project Structure Notes

- The codebase organizes everything under `src/{layer}/` with no top-level per-domain folders. Story 1.5 introduced `src/compliance/` for its enforcement module; Story 1.6 adds `src/compliance/location.ts` there (the AD-15 invariant belongs with the other spine invariants). Projection functions live in `src/read/projections/location.ts` (the `src/read/projections/` precedent set by `business_stream_config.ts`, `doa_registry.ts`, `audit_log.ts`). The canonical SQL is `read/projections/location.sql`. Route handlers in `src/api/v1/location.ts`. RBAC uses `module: 'inventory'` (matching `resolveModuleFromBody`'s stream_type resolution) for the events path; the synthetic seeding endpoint may use `module: 'inventory'` write scope (or `compliance` - pick one and stay consistent, noting it). The `eslint-rules/` directory from Story 1.4 is unaffected; this story does NOT add a lint rule.
- Keep lot IDs opaque UUIDs in this story. Do NOT add an FK to a lot master (Epic 2 owns it). Do NOT add a location master FK (Story 2.1 owns the location register). The location TEXT values (`BIN-A43`) are opaque identifiers in the spine scope.

### Files This Story Touches

```text
{root}/
  read/
    projections/
      location.sql                         # NEW - canonical location facts + current projection schema, guarded grants
  src/
    compliance/
      location.ts                          # NEW - assertLocationInvariant(envelope, deps?)
    read/
      projections/
        location.ts                        # NEW - getCurrentLocation, recordAssertedFact, recordExpectedFact, raiseDispute
    api/
      v1/
        location.ts                        # NEW - GET /api/v1/locations/:lotId + POST /api/v1/locations/:lotId/expected
    events/
      store.ts                             # UPDATE - location invariant + projection writes + dispute event inside persistEvent
      migrate.ts                           # UPDATE - add location.sql to MIGRATIONS after business_stream_config.sql
    server.ts                              # UPDATE - register 2 location routes
  deploy/
    compose/
      init-db.sql                          # UPDATE - mirror location DDL + guarded grants
  test/
    unit/
      location.test.ts                     # NEW - assertLocationInvariant cases (DB-free, deps injection)
    integration/
      story-1-6.test.ts                    # NEW - all ACs (1, 2, 3)
```

### Testing Standards Summary

- Node's built-in test runner (`node --test`), not Jest/Mocha, matches every prior story. Integration tests need a real Postgres reachable via `.env.test` (Docker via WSL, as used for Stories 1.1 through 1.5's aggregate run).
- Unit test for `assertLocationInvariant` uses dependency injection (a `deps` parameter defaulting to real projection functions) so the logic is testable without a database, mirroring `test/unit/business-stream.test.ts` and `test/unit/no-hardcoded-role-in-workflow.test.ts`.
- No new npm dependencies required anywhere in this story, same as Stories 1.3 through 1.5.
- Integration tests run serially (`--test-concurrency=1`); use a dedicated port; reuse the story-1-4 harness shape exactly.

### NFR Constraints Binding This Story

| NFR / Requirement | Impact |
| --- | --- |
| AD-15 | Asserted and expected facts stored separately; mismatch raises `location.disputed` (event), never silent overwrite; no last-writer-wins |
| AD-16 | Reuse existing idempotency dedup; location projection updates exactly once on duplicate `idempotency_key` (409 `DUPLICATE_EVENT`) |
| AD-12 | Event-sourced location is a spine invariant; acceptance-tested by Story 1.9 before Epic 2 |
| AD-14 | Current location is a shared PostgreSQL projection, not a mutable column |
| AD-1 | Enforcement at the central write path covers edge-synced events (forward-looking to Story 1.8) |
| NFR-DI-01 | Asserted/expected/dispute writes commit atomically with the domain event |
| NFR-SEC-02 | RBAC to module/function scope on the read + seeding endpoints (`module: 'inventory'`) |
| NFR-P-05 | API p95 under 500ms; single-row indexed lookups for current location, no N+1 |

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` #Story 1.6: Event-Sourced Location with Asserted/Expected Separation]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` #AD-1, #AD-12, #AD-14, #AD-15, #AD-16, #Spine Acceptance Contract (test 3), #Consistency Conventions, #API Contract (stable error codes)]
- [Source: `_bmad-output/planning-artifacts/prds/prds/prd-Inventory Management System_2-2026-07-10/addendum.md` #INT-LOC-01 (LocationAsserted / LocationExpected / LocationDisputed fact naming)]
- [Source: `_bmad-output/planning-artifacts/ux-designs/EXPERIENCE.md` #location.disputed UX (asserted, expected, actor, reason, confidence fields)]
- [Source: `_bmad-output/implementation-artifacts/1-5-business-stream-tagging-enforcement.md` - `assertInventoryTagging` at top of persistEvent, stream-type gating, deps injection, dual-file migration convention, test harness, DATE bug, `actorContext`/`NO_LOCATION_UUID` reuse]
- [Source: `_bmad-output/implementation-artifacts/1-4-enterprise-doa-registry.md` - `persistEvent` `client` param, re-entrant `persistEvent(client)`, `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` sentinel, guarded-grant migration pattern, test harness, `--test-concurrency=1`]
- [Source: `src/events/store.ts` - `persistEvent` signature, `assertInventoryTagging` placement (line 153), idempotency/version conflict handling (lines 233-258), `validateEnvelope`-not-in-persistEvent decision]
- [Source: `src/compliance/business-stream.ts` and `src/read/projections/business_stream_config.ts` - the closest pattern analog for the enforcement module + projection module]
- [Source: `src/api/v1/events.ts` - `resolveModuleFromBody` (module resolved from stream_type), the public write path this story's enforcement covers transitively]
- [Source: `src/api/v1/doa.ts` - `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` helper shape to duplicate for the seeding endpoint]
- [Source: `deploy/compose/init-db.sql` - dual-file mirror target (Story 1.6 section appended after the Story 1.5 business-stream section)]
- [Source: `deferred-work.md` - `users.sql` grant split-brain bug, cited as the precedent this story's Task 1.1/1.2 must not repeat]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

