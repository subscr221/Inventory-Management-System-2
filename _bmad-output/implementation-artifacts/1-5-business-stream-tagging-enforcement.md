---
baseline_commit: 2d9e024
---

# Story 1.5: Business-Stream Tagging Enforcement

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a financial controller,
I want every inventory movement event to carry a mandatory `business_stream` tag plus `cost_centre` and `project_code` where applicable (FR-AC-01), enforced at the write path,
So that no untagged transaction can enter the ledger and reporting by stream (production, R&D, maker-hub, job-work) is accurate by construction from the first transaction.

## Acceptance Criteria

1. **Given** a write request for an inventory movement event with no `business_stream` field
   **When** the event handler processes the command
   **Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`

2. **Given** a write request with `business_stream: "production"` (a valid value)
   **When** the event is persisted
   **Then** the event payload carries the `business_stream` value and an event-store stream read (the Story 1.1 read path) returns it with the tag intact; module read-model projections consume the tag from Epic 2 onward

3. **Given** a write request with `business_stream: "unknown_stream"` (unrecognized value)
   **When** the event handler processes the command
   **Then** the write is rejected with `error_code: "INVALID_BUSINESS_STREAM"` and no event is appended to `domain_events`

4. **Given** a transaction type configured as cost-centre-applicable (applicability is dated configuration, not code)
   **When** an inventory movement event of that type is submitted with no `cost_centre` field
   **Then** the write is rejected with `error_code: "UNTAGGED_TRANSACTION"` and no event is appended to `domain_events`
   **And** the same rule enforces `project_code` for project-applicable transaction types (R&D project-code enforcement is exercised end-to-end in Story 10.1)

## Tasks / Subtasks

- [x] Task 1: Tagging configuration schema and projection functions (AC: 4)
  - [x] 1.1 Create `read/projections/business_stream_config.sql` as the CANONICAL file, carrying its OWN grants (guarded `DO $$ ... IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') ... $$` blocks) exactly like `read/projections/audit_log.sql` and `read/projections/doa_registry.sql` do, deliberately NOT like `read/projections/users.sql` (whose grants live only in `deploy/compose/init-db.sql`, the split-brain bug logged in `deferred-work.md`). Define two tables:
    - `business_streams (stream_code TEXT PRIMARY KEY, display_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`. Seed the four pilot streams via `INSERT ... ON CONFLICT (stream_code) DO NOTHING`: `production` ("Production"), `research` ("R&D"), `maker_hub` ("Maker-Hub"), `job_work` ("Job-Work"). These four are the closed pilot vocabulary from Epic 1's goal statement ("reporting by stream (production, R&D, maker-hub, job-work)"). Adding a stream is a config insert plus a seed row, not a code change, satisfying NFR-E-03.
    - `transaction_tagging_rules (rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), transaction_type TEXT NOT NULL, cost_centre_required BOOLEAN NOT NULL DEFAULT false, project_code_required BOOLEAN NOT NULL DEFAULT false, effective_from DATE NOT NULL, effective_to DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`. Add `idx_transaction_tagging_rules_lookup ON transaction_tagging_rules (transaction_type, effective_from)` and a `UNIQUE (transaction_type, effective_from)` constraint so two rules for the same transaction type cannot share an effective_from date (overlapping ranges are rejected at write time by the projection function, not by a DB constraint, because PostgreSQL range-exclusion constraints add complexity out of proportion to a Phase-1 single-site pilot).
  - [x] 1.2 Mirror the full contents (both tables, seed inserts, indexes, guarded grants) into `deploy/compose/init-db.sql` under a new `-- Story 1.5: Business-Stream Tagging` section, following the exact dual-file convention Story 1.3 established and Story 1.4 followed: a comment at the top of both files stating they must stay identical. `deploy/compose/init-db.sql` is a copy for first-time cluster init, not the sole source of grants.
  - [x] 1.3 Implement `src/read/projections/business_stream_config.ts` with exported interfaces `BusinessStream` and `TransactionTaggingRule`, and functions: `isValidBusinessStream(streamCode)` (existence + `active = true` check against `business_streams`), `findActiveTaggingRule(transactionType, asOfDate?)` (resolves the rule whose `effective_from <= asOfDate AND (effective_to IS NULL OR effective_to >= asOfDate)`; if more than one rule is effective on the same date, that is a configuration error and the function throws `AppError(500, 'TAGGING_CONFIG_CONFLICT', ...)` rather than silently picking one; if `asOfDate` is omitted it defaults to the current UTC date via `new Date().toISOString().slice(0, 10)`; if no rule exists for the transaction type, returns `null` meaning "no cost_centre or project_code required for this type"). `node-postgres` returns `DATE` columns as JS `Date` at local midnight; format via local Y-M-D components exactly as `mapDelegation` in `src/read/projections/doa_registry.ts` does, NOT via `toISOString()` which shifts the calendar day back one in non-UTC timezones (the bug Story 1.4 found and fixed).
  - [x] 1.4 Register `../../read/projections/business_stream_config.sql` in `src/events/migrate.ts`'s `MIGRATIONS` array, after `doa_registry.sql`.

- [x] Task 2: Tagging enforcement at the write path (AC: 1, 2, 3, 4)
  - [x] 2.1 Implement `src/compliance/business-stream.ts` exporting `assertInventoryTagging(envelope: EventEnvelope): void`. This function is the single enforcement point for FR-AC-01. It throws `AppError` (400) on violation and returns `void` on success. Logic:
    - Define `INVENTORY_MOVEMENT_STREAM_TYPES = new Set(['inventory'])` at module scope with a comment that this is the set of `stream_type` values whose events carry inventory movements and therefore require business-stream tagging. If `envelope.stream_type` is NOT in this set, return immediately (no enforcement on non-inventory events; this is what keeps the DOA registry's `doa_registry_entry`/`doa_vacation_delegation` writes and SCIM's user writes unaffected, since they call `persistEvent` directly with non-inventory stream types). This gating mirrors how the spine invariants in Stories 1.6 and 1.7 are scoped to their own stream types.
    - If `envelope.stream_type` IS an inventory-movement type: require `envelope.payload.business_stream` to be a non-empty string; if missing or not a string, throw `AppError(400, 'UNTAGGED_TRANSACTION', 'Inventory movement event is missing the business_stream tag', { missing_tag: 'business_stream' })`. Then call `isValidBusinessStream(streamCode)`; if it returns false, throw `AppError(400, 'INVALID_BUSINESS_STREAM', 'business_stream is not a recognized active stream', { invalid_value: streamCode })`.
    - Resolve the transaction type from `envelope.event_type` (the past-tense dot-separated event name, e.g. `stock.moved`, `stock.allocated`). Call `findActiveTaggingRule(envelope.event_type)`. If a rule exists: if `cost_centre_required` is true and `envelope.payload.cost_centre` is not a non-empty string, throw `AppError(400, 'UNTAGGED_TRANSACTION', 'Transaction type requires a cost_centre tag', { missing_tag: 'cost_centre', transaction_type: envelope.event_type })`. Same shape for `project_code_required` and `envelope.payload.project_code`. If no rule exists, no cost_centre/project_code is required (the default).
    - The `details` object on every thrown `AppError` MUST include `missing_tag` (or `invalid_value`) so the Spine Acceptance Contract test #5 ("verify the rejection message identifies the missing tag") is observable. This is the AC1 half that makes the invariant testable.
  - [x] 2.2 Call `assertInventoryTagging(envelope)` at the TOP of `persistEvent` in `src/events/store.ts`, BEFORE the `BEGIN`/version-lookup/`INSERT` block and before any audit write. Rationale for the placement (documented in a code comment): tagging is a domain invariant that must hold on EVERY write path that reaches the central event store, not just the public HTTP `POST /api/v1/events` path. The offline edge sync path (Story 1.8, not yet built) replicates edge-captured events into `persistEvent`; if enforcement lived only in the HTTP handler, an untagged event captured at the edge would sync through unchecked. Placing enforcement in `persistEvent` gates by `stream_type` (Task 2.1's guard) so internal adapters writing non-inventory streams (DOA registry, SCIM, audit) are unaffected, byte-for-byte backward compatible with every existing caller. This is the same "enforce at the write path" placement AD-12 mandates for the compliance spine.
  - [x] 2.3 Add a focused unit test `test/unit/business-stream.test.ts` (Node's built-in test runner, like `test/unit/no-hardcoded-role-in-workflow.test.ts`) covering: a non-inventory stream type passes through with no payload (no enforcement); an inventory stream with no `business_stream` throws `UNTAGGED_TRANSACTION` with `details.missing_tag === 'business_stream'`; an inventory stream with an unrecognized stream throws `INVALID_BUSINESS_STREAM` with `details.invalid_value`; an inventory stream with a valid stream and no applicable tagging rule passes; an inventory stream with a cost-centre-required rule and missing `cost_centre` throws `UNTAGGED_TRANSACTION` with `details.missing_tag === 'cost_centre'`. The unit test must mock/stub `isValidBusinessStream` and `findActiveTaggingRule` (these hit the DB) by injecting them or by splitting the pure validation logic from the DB-touching resolution. Recommended shape: `assertInventoryTagging(envelope, deps)` where `deps` defaults to the real projection functions but tests pass fakes. This keeps the unit test DB-free and fast.

- [x] Task 3: Admin endpoints for tagging configuration (AC: 4 support)
  - [x] 3.1 Implement `POST /api/v1/business-streams/rules` in a new `src/api/v1/business-stream.ts`, wrapped in `requireRole({ module: 'compliance', functionScope: 'write' })`. Body: `{ transaction_type, cost_centre_required?, project_code_required?, effective_from, effective_to? }`. Validate `transaction_type` is a non-empty string; `cost_centre_required` and `project_code_required` default to `false` if absent and must be booleans if present; `effective_from` must match `/^\d{4}-\d{2}-\d{2}$/` and parse as a real date; `effective_to` is optional but if present must be a valid `YYYY-MM-DD` and must not be before `effective_from` (400 `INVALID_PARAMS` otherwise). Before inserting, call a projection function `findConflictingRule(transactionType, effectiveFrom, effectiveTo)` that returns any existing rule whose date range overlaps the new one; if a conflict exists, reject with 409 `TAGGING_RULE_CONFLICT` (this is the application-level overlap guard; the DB unique constraint on `(transaction_type, effective_from)` is a backstop but does not catch all overlaps). Atomic write: acquire a client via `getPool().connect()`, `BEGIN`, call `createTaggingRule(input, client)` and `persistEvent(envelope, auditCtx, client)` on that same client (`stream_type: 'business_stream_config'`, `stream_id: rule.rule_id`, `event_type: 'business_stream_config.rule_created'`, `payload: { rule }`), `COMMIT`, `client.release()` in `finally`, `ROLLBACK` on error before rethrowing. Use the SAME `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` sentinel pattern Story 1.4 built in `src/api/v1/doa.ts` for the `'*'`-location admin case: the audit log `location_id` records the real `'*'` assignment value, the event envelope `metadata.actor.location_id` uses the zero-UUID sentinel. Respond `201` with the created rule.
  - [x] 3.2 Implement `GET /api/v1/business-streams/rules?transaction_type=&as_of_date=` (read scope; a `write` assignment satisfies `read` per the existing `satisfiesFunctionScope` rule in `src/middleware/rbac.ts`, no new RBAC logic). Returns the active rule for the given transaction type as of the given date (defaults to today), or `404 NOT_FOUND` if none. This endpoint exists so a frontend or integration can show the current applicable rule; it is not itself an AC but supports AC4's "dated configuration, not code" observability.
  - [x] 3.3 Implement `GET /api/v1/business-streams` (read scope) returning the list of active business streams from `business_streams`. Same observability rationale.
  - [x] 3.4 Do NOT implement a PATCH/DELETE for tagging rules in this story. Rules are dated configuration; correcting a rule is done by adding a new rule with a new `effective_from` (date-stamped config, not mutation), matching the architecture's "statutory thresholds as dated configuration files, not hard-coded" principle. If a rule must be end-dated, that is a future story's concern (Epic 4 workflow config or a compliance admin console, neither of which exists yet). Document this scope decision in a code comment so the next agent does not add a silent mutation path.

- [x] Task 4: Route registration
  - [x] 4.1 Register the three new routes in `src/server.ts`: `router.post('/api/v1/business-streams/rules', createTaggingRuleHandler)`, `router.get('/api/v1/business-streams/rules', getTaggingRuleHandler)`, `router.get('/api/v1/business-streams', listBusinessStreamsHandler)`. No changes to `src/api/router.ts` are needed; `post()` and `get()` already exist.

- [x] Task 5: Integration tests (AC: 1, 2, 3, 4)
  - [x] 5.1 Create `test/integration/story-1-5.test.ts` following the exact harness pattern in `test/integration/story-1-4.test.ts`: `before`/`after` hooks that run migrations against a real Postgres via `getAdminPool()`, a `makeRequest` helper, a `provisionUser`/`authFor` helper pair (reuse the SCIM + dev-token plumbing). In `before()`, apply the four migration files in order: `domain_events.sql`, `users.sql`, `audit_log.sql`, `doa_registry.sql`, `business_stream_config.sql`. Clean up with `TRUNCATE ... CASCADE` (the audit tables need the documented `ALTER TABLE ... DISABLE TRIGGER ALL` escape hatch before TRUNCATE and `ENABLE TRIGGER ALL` in a `finally`, exactly as `test/integration/story-1-4.test.ts` does). The `business_streams` table's seed rows survive TRUNCATE only if not truncated; do NOT truncate `business_streams` (the seed is idempotent via `ON CONFLICT DO NOTHING` and re-applied by the migration file in `before()`, so truncating it is harmless but unnecessary; leave it out of the TRUNCATE list).
  - [x] 5.2 AC1: provision an admin user with `role: 'system_administrator', module: 'inventory', functionScope: 'write', locationId: '*'` (note: the events POST handler resolves module from `body.stream_type`, so the caller needs the `inventory` module, not `compliance`). Submit `POST /api/v1/events` with `{ stream_type: 'inventory', stream_id: <random UUID>, event_type: 'stock.moved', payload: { quantity: 10 } (NO business_stream), metadata: { correlation_id: <UUID>, actor: { user_id, role, location_id }, occurred_at: <ISO> } }`. Assert 400 with `error_code: 'UNTAGGED_TRANSACTION'` and `details.missing_tag === 'business_stream'`. Then assert NO row was appended to `domain_events` for that `stream_id` (query `SELECT count(*) FROM domain_events WHERE stream_id = $1`).
  - [x] 5.3 AC2: submit `POST /api/v1/events` with the same envelope but `payload.business_stream: 'production'`. Assert 201. Then `GET /api/v1/events/inventory/:streamId` and assert the returned event's `payload.business_stream === 'production'` (the tag survives the round trip; this is the Story 1.1 read path).
  - [x] 5.4 AC3: submit `POST /api/v1/events` with `payload.business_stream: 'unknown_stream'`. Assert 400 `INVALID_BUSINESS_STREAM` with `details.invalid_value === 'unknown_stream'`. Assert no `domain_events` row.
  - [x] 5.5 AC4 (cost_centre): first `POST /api/v1/business-streams/rules` as an admin with `module: 'compliance'` creating a rule `{ transaction_type: 'stock.moved', cost_centre_required: true, effective_from: '2026-01-01' }`. Then submit `POST /api/v1/events` (as the `inventory`-module user) with `payload.business_stream: 'production'` but NO `cost_centre`. Assert 400 `UNTAGGED_TRANSACTION` with `details.missing_tag === 'cost_centre'` and `details.transaction_type === 'stock.moved'`. Assert no `domain_events` row. Then resubmit with `payload.cost_centre: 'CC-100'` added; assert 201.
  - [x] 5.6 AC4 (project_code): create a rule `{ transaction_type: 'rd.consumed', project_code_required: true, effective_from: '2026-01-01' }`. Submit an inventory event with `event_type: 'rd.consumed'`, `business_stream: 'research'`, no `project_code`; assert 400 `UNTAGGED_TRANSACTION` with `details.missing_tag === 'project_code'`. Resubmit with `project_code: 'PROJ-42'`; assert 201. This is the project-code half of AC4; the full R&D end-to-end is Story 10.1, but the enforcement point is this story's.
  - [x] 5.7 RBAC boundary: a caller with no role assignment for module `inventory` gets 403 `MODULE_ACCESS_DENIED` on `POST /api/v1/events` with `stream_type: 'inventory'`; a caller with no role assignment for module `compliance` gets 403 `MODULE_ACCESS_DENIED` on `POST /api/v1/business-streams/rules`.
  - [x] 5.8 Non-inventory stream passthrough: submit `POST /api/v1/events` with `stream_type: 'doa_registry_entry'` (or use the existing DOA `POST /api/v1/doa/entries` endpoint) and assert it still succeeds with no `business_stream` in the payload (the stream-type guard in `assertInventoryTagging` does not fire). This is the regression guard proving enforcement did not break Stories 1.1 through 1.4.
  - [x] 5.9 Run `npm run lint`, `npx tsc --noEmit`, and `npm run test:integration`; all clean. Confirm the full aggregate suite (Stories 1.1 through 1.5) still passes with no regressions (67 tests were green across 1.1 through 1.4 as of this story's baseline commit `2d9e024`).

## Dev Notes

### Previous Story Intelligence (from Story 1.4)

- **`persistEvent(envelope, auditCtx?, externalClient?)` in `src/events/store.ts`** is the established central write path. It writes the domain event and (if `auditCtx` is supplied) the audit-log entry atomically in one transaction, and accepts an optional caller-supplied `PoolClient` so a caller's row write and the event write commit together. Story 1.4 added the `externalClient` param. **This story adds a tagging-enforcement call at the top of `persistEvent`** (Task 2.2) BEFORE any DB write; it is a pure validation that throws `AppError` on violation and returns `void` on success, so it does not participate in the transaction (it runs before `BEGIN`). The call is additive and backward compatible with every existing caller (DOA, SCIM, audit, events POST) because the stream-type guard (Task 2.1) returns immediately for non-inventory stream types.
- **`requireRole({ module, functionScope, locationId? })` from `src/middleware/rbac.ts`** wraps a `RouteHandler`. The events POST handler resolves `module` dynamically from `body.stream_type` (see `resolveModuleFromBody` in `src/api/v1/events.ts`), so an inventory-movement event requires the caller to hold a role with `module: 'inventory'`. The admin endpoints in this story use a static `module: 'compliance'`. Handlers read the actor's identity from `getAuthContext(req)`/`getAuthorizedAssignment(req)`, NEVER from the request body (Story 1.2's biggest code-review finding, carried forward through 1.3 and 1.4).
- **`logAuditEntry` and `logTamperAttempt`** (both in `src/read/projections/audit_log.ts`) are the only two audit-writing functions in the codebase. This story does NOT add a third; the admin rule-creation endpoint uses `persistEvent` with an `auditCtx` (which calls `logAuditEntry` internally), exactly as the DOA entry-creation endpoint does. There is no tamper-attempt path in this story (a tagging-rule creation is a legitimate admin action, not a spine-bypass attempt), so `logTamperAttempt` is not used here.
- **Migration + dual-file convention:** every new table lives in a canonical `read/projections/*.sql` file applied by both `src/events/migrate.ts` (via `MIGRATIONS`) and the test harness's `before()` hook, with a mirrored copy in `deploy/compose/init-db.sql` for first-time cluster init. The canonical file must carry its own grants (guarded `DO $$ ... IF EXISTS (SELECT FROM pg_roles ...) ... $$` blocks), matching `audit_log.sql` and `doa_registry.sql`'s actual pattern. `read/projections/users.sql` does NOT follow this (its grants live only in `init-db.sql`), and that gap is an open, logged bug in `deferred-work.md`; do not copy `users.sql`'s pattern for the new tagging tables.
- **`actor.location_id` sentinel rule:** when the authorizing admin's assignment is enterprise-wide (`locationId: '*'`), the event envelope's `metadata.actor.location_id` uses the zero-UUID sentinel `00000000-0000-0000-0000-000000000000` (not a valid UUID otherwise); the audit log's `location_id` (a plain TEXT column) records the real `'*'`. Story 1.4 built `actorContext`/`auditCtxFor` helpers in `src/api/v1/doa.ts` for exactly this; this story's admin endpoint should reuse the SAME helper shape (either import from a shared module or duplicate the small helper; prefer extracting to `src/middleware/actor-context.ts` if it keeps the code DRY, but if extraction risks touching `doa.ts` in a way that could regress 1.4, duplicate the ~15-line helper with a comment pointing to `doa.ts` as the source).
- **Test harness pattern:** `test/integration/story-1-4.test.ts` builds its own minimal `Router` + handler wiring (not the full `src/server.ts`) inside `before()`, runs the SQL migrations directly via `getAdminPool().query(readFileSync(...))`, provisions test users via the SCIM endpoint plus dev-token, and tears down with `closePool()`/`closeAdminPool()` in `after()`. Cleanup uses `TRUNCATE ... CASCADE` (the `CASCADE` was added by Story 1.4 to handle the `doa_vacation_delegations` FK into `users`) and disables the audit tamper triggers around the TRUNCATE. Follow this exact shape for `test/integration/story-1-5.test.ts` rather than inventing a new harness style. Integration tests run serially via `--test-concurrency=1` in `package.json` (Story 1.4's fix for the shared-DB deadlock); do not change that.
- **DATE timezone bug:** node-postgres parses a `DATE` column into a JS `Date` at local midnight; formatting with `toISOString()` shifts the calendar day back one in non-UTC timezones (Story 1.4 hit this on `doa_vacation_delegations.start_date`). The `transaction_tagging_rules.effective_from`/`effective_to` columns are `DATE` type; the projection function must format them from local Y-M-D components exactly as `mapDelegation` in `src/read/projections/doa_registry.ts` does.
- **Git intelligence:** Stories land as a single `feat(...)` commit; review remediation lands as separate, clearly-labeled follow-up commits (never silent amends). No fixup-commit spam.

### Where Enforcement Lives (design decision, documented not blocking)

The Spine Acceptance Contract test #5 (Story 1.9) submits "an untagged inventory transaction" and verifies the write is blocked. Three plausible placements for the enforcement call:

1. In `persistEvent` (central event store write), gated by `stream_type`.
2. In the `POST /api/v1/events` HTTP handler, after `validateEnvelope`.
3. In a dedicated `assertInventoryTagging` function called by both.

This story chooses placement 1 (in `persistEvent`), with the validation logic in a separate `src/compliance/business-stream.ts` module (Task 2.1) for testability. Reasons:

- The offline edge sync path (Story 1.8, not yet built) replicates edge-captured events into `persistEvent`, NOT through the HTTP handler. If enforcement lived only in the HTTP handler, an untagged event captured at the edge would sync through unchecked. Story 1.8's AC5 already references `UNTAGGED_TRANSACTION` as a sync-rejection error code, which only works if enforcement is on the central write path.
- The public HTTP `POST /api/v1/events` path calls `persistEvent`, so placement 1 covers it transitively.
- Internal adapters (SCIM, DOA registry) call `persistEvent` directly with non-inventory stream types (`user`, `doa_registry_entry`, `doa_vacation_delegation`); the stream-type guard returns immediately for those, so they are byte-for-byte unaffected.

Trade-off: any FUTURE internal adapter that writes an inventory-stream event directly (bypassing the HTTP handler) would also have to satisfy tagging. Today no such adapter exists. Flag this in a code comment so a future adapter author knows the constraint.

`validateEnvelope` (structural envelope validation) stays where it is, in the HTTP handler; it is NOT moved into `persistEvent`. The story's tagging check is a domain invariant, not a structural shape check, and AD-12 mandates it at the write path.

### Business-Stream Vocabulary (design decision, documented not blocking)

The four pilot streams (`production`, `research`, `maker_hub`, `job_work`) are stored in a `business_streams` reference table seeded at migration time, NOT a hard-coded CHECK constraint on the `domain_events.payload` JSONB. Reasons:

- The architecture's NFR-E-03 ("configurable workflows without code") and the epic's "applicability is dated configuration, not code" language both push configuration out of code. A reference table satisfies this for the vocabulary; a CHECK constraint would require a migration to add a stream.
- AC3 ("unrecognized value is rejected") is satisfied either way; the reference table just makes "unrecognized" mean "not present and active in `business_streams`".
- The cost of a table + existence check is one indexed single-row lookup per inventory event write, well within NFR-P-05's 500ms p95 budget (the lookup can be cached in a process-local `Map` invalidated on `business_stream_config.rule_created` events if profiling ever shows it matters; do not pre-optimize).

The stream codes are snake_case (`maker_hub`, `job_work`) for code ergonomics; the `display_name` column carries the human-readable form ("Maker-Hub", "Job-Work") for any future UI. The epic spells them "maker-hub" and "job-work" in prose; the code uses the snake_case form and the `display_name` preserves the prose form.

### Tagging Rule Resolution (design decision, documented not blocking)

`findActiveTaggingRule(transactionType, asOfDate)` resolves the rule whose date range covers `asOfDate`. If two rules for the same transaction type have overlapping date ranges, that is a configuration error, not an ambiguous pick: the function throws `TAGGING_CONFIG_CONFLICT` (500) rather than silently choosing. The admin endpoint (Task 3.1) rejects a new rule whose range overlaps an existing one with 409 `TAGGING_RULE_CONFLICT` at write time, so the runtime conflict should be unreachable in practice; the runtime check is defense-in-depth.

If NO rule exists for a transaction type, the function returns `null`, meaning "no cost_centre or project_code required for this type". This is the default for every transaction type until an admin configures otherwise, which matches the pilot's "compliant by construction from day one" framing without requiring every event_type to be pre-registered.

### Scope Exclusions (documented, not deferred to a named story)

- **No PATCH/DELETE for tagging rules.** Rules are dated configuration; correcting a rule is done by adding a new rule with a new `effective_from`. This matches the architecture's "statutory thresholds as dated configuration files, not hard-coded" principle. A future compliance-admin-console story (not yet in the backlog; no epic currently owns this, same gap Story 1.4 noted for the DOA admin UI) may add end-dating or soft-delete if operations needs it.
- **No business-stream CRUD endpoints.** The four pilot streams are seeded by migration. Adding a stream is a migration + seed insert. If a future epic needs runtime stream management, it can add endpoints then; the table shape supports it (the `active` flag is already there).
- **No event-type registry.** The tagging rule keys on `transaction_type` (which is `event_type` from the envelope, a free-form string). There is no master list of valid event types in Epic 1; event types are defined by the modules that emit them (Epic 2 onward). This story does NOT validate that `event_type` is a known type; it only validates that IF a tagging rule exists for it, the cost_centre/project_code tags are present. Validating event_type against a registry is a future cross-module concern.

### Architecture Compliance

- **AD-12 (Compliance Spine as Platform Layer):** business-stream tagging is explicitly named as one of the six spine invariants ("edit log, DOA registry, business-stream tagging, event-sourced location, calibration lockout, statutory document triggers"). This story delivers the business-stream-tagging half. It must be fully built and acceptance-tested (Story 1.9, consuming this story) before any module epic (starting with Epic 2 inventory) can land.
- **Spine Acceptance Contract test #5 (Business-Stream Tagging, FR-AC-01):** "Submit an untagged inventory transaction; verify the write is blocked; verify the rejection message identifies the missing tag." This story's Task 2.1 (`assertInventoryTagging` throwing `UNTAGGED_TRANSACTION` with `details.missing_tag`) and Task 5.2 (integration test asserting both the error code and the `missing_tag` detail) make this testable. Story 1.9 wires it into the CI gate; this story delivers the enforcement itself.
- **AD-1 (Partitioned Local-First):** enforcement in `persistEvent` means edge-captured events that sync through PowerSync are also gated (forward-looking to Story 1.8). This is consistent with the "captured, pending sync" model: an untagged event captured at the edge moves to a visible "sync failed - needs attention" state on the device showing `UNTAGGED_TRANSACTION` (Story 1.8 AC5), rather than silently entering the ledger.
- **AD-16 (Idempotency Keys):** unaffected. Tagging enforcement runs before the idempotency-key uniqueness check in `persistEvent` (which happens on `INSERT`); an untagged event is rejected before any DB write, so no idempotency-key row is consumed.
- **Consistency Conventions** (`ARCHITECTURE-SPINE.md`): events past-tense dot-separated (`stock.moved`, `business_stream_config.rule_created`); error envelope `{ error_code, message, details, trace_id }` (already provided by `src/middleware/error.ts`; use `sendJson`/`sendRequestError`/`throw new AppError`, do not hand-roll); singular entity naming for modules (`compliance/` logical module, not a filesystem path); the new tables use plural names (`business_streams`, `transaction_tagging_rules`) matching the existing `domain_events`/`audit_log`/`doa_registry_entries` table-naming precedent (Stories 1.3 and 1.4 both followed the codebase's actual plural-table precedent, not the idealized "singular entity" doc read literally).
- **Stable error codes this story introduces:** `UNTAGGED_TRANSACTION` (already in the architecture's stable error codes list), `INVALID_BUSINESS_STREAM` (already in the stable list as a naming variant), `TAGGING_RULE_CONFLICT`, `TAGGING_CONFIG_CONFLICT`. Reuses existing `INVALID_PARAMS`, `NOT_FOUND`, `MODULE_ACCESS_DENIED` (RBAC), `UNAUTHORIZED`.

### Project Structure Notes

The architecture's idealized "Structural Seed" lists a top-level `compliance/` folder for FR-AC-01. The actual codebase does NOT follow that layout (Stories 1.1 through 1.4 organized everything under `src/{layer}/` with no top-level per-domain folders). This story follows the real, established convention, exactly as Stories 1.3 and 1.4 did: tagging logic lives in `src/compliance/business-stream.ts` (a new `src/compliance/` directory for the validation module), projection functions in `src/read/projections/business_stream_config.ts`, admin route handlers in `src/api/v1/business-stream.ts`, and the canonical SQL in `read/projections/business_stream_config.sql`. RBAC uses the module string `'compliance'` for the admin endpoints (matching the architecture's Capability-to-Architecture Map row for FR-AC-01) and `'inventory'` for the events POST path (resolved dynamically from `stream_type` by the existing `resolveModuleFromBody` helper).

The one genuinely new top-level path this story introduces is `src/compliance/` (the enforcement module). The `eslint-rules/` directory Story 1.4 introduced is unaffected; this story does NOT add a lint rule (the "no hard-coded role name" rule is FR-DOA-01-specific; FR-AC-01 does not require an analogous stream-name lint rule because business streams are data in a reference table, not branching logic).

### Files This Story Touches

```text
{root}/
  read/
    projections/
      business_stream_config.sql        # NEW - business_streams + transaction_tagging_rules
  src/
    compliance/
      business-stream.ts                # NEW - assertInventoryTagging(envelope, deps)
    read/
      projections/
        business_stream_config.ts       # NEW - isValidBusinessStream, findActiveTaggingRule, CRUD
    api/
      v1/
        business-stream.ts              # NEW - 3 admin route handlers
    events/
      store.ts                          # UPDATE - call assertInventoryTagging at top of persistEvent
      migrate.ts                        # UPDATE - add business_stream_config.sql to MIGRATIONS
    server.ts                           # UPDATE - register 3 routes
  deploy/
    compose/
      init-db.sql                       # UPDATE - mirror business_streams + transaction_tagging_rules
  test/
    unit/
      business-stream.test.ts           # NEW - assertInventoryTagging pure-logic cases
    integration/
      story-1-5.test.ts                 # NEW - all ACs
```

### Testing Standards Summary

- Node's built-in test runner (`node --test`), not Jest/Mocha, matches every prior story. Integration tests need a real Postgres reachable via `.env.test` (Docker via WSL, as used for Stories 1.1 through 1.4's 67-test aggregate run).
- Unit tests for `assertInventoryTagging` use dependency injection (a `deps` parameter defaulting to the real projection functions) so the validation logic is testable without a database, mirroring how `test/unit/no-hardcoded-role-in-workflow.test.ts` uses ESLint's `RuleTester` to test the lint rule without a DB.
- No new npm dependencies required anywhere in this story, same as Stories 1.3 and 1.4.

### NFR Constraints Binding This Story

Table 1 summarizes the NFR constraints binding this story.

| NFR / Requirement | Impact |
| --- | --- |
| FR-AC-01 | Core requirement: every inventory movement carries business_stream plus cost_centre/project_code where applicable; untagged transactions blocked at write path |
| AD-12 | Business-stream tagging is part of the compliance spine bottom layer; built and acceptance-tested before any module epic |
| AD-1 | Enforcement at the central write path covers edge-synced events (forward-looking to Story 1.8) |
| AD-16 | Tagging check runs before idempotency-key INSERT; an untagged event consumes no idempotency row |
| NFR-SEC-02 | RBAC to module/function scope on admin endpoints (`module: 'compliance'`); events POST uses `module: 'inventory'` resolved from stream_type |
| NFR-DI-01 | Admin rule-creation writes the rule row and the domain event atomically in one transaction (reuses persistEvent's client param) |
| NFR-E-03 | Business-stream vocabulary and tagging applicability are dated configuration (tables), not hard-coded |
| NFR-P-05 | API p95 under 500ms; single-row indexed lookups for stream validation and rule resolution, no N+1 queries |

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` #Story 1.5: Business-Stream Tagging Enforcement]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` #AD-1, #AD-12, #AD-16, #Consistency Conventions, #Spine Acceptance Contract, #API Contract (stable error codes)]
- [Source: `_bmad-output/implementation-artifacts/1-4-enterprise-doa-registry.md` - `persistEvent` client param, `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` sentinel, dual-file migration convention, test harness pattern, DATE timezone bug, `--test-concurrency=1` fix]
- [Source: `_bmad-output/implementation-artifacts/1-3-statutory-edit-log.md` - audit-log tamper-protection trigger escape hatch, `logAuditEntry`/`logTamperAttempt` reuse]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` - `users.sql` grant split-brain bug, cited as the precedent this story's Task 1.1/1.2 must not repeat]
- [Source: `src/events/store.ts` - `persistEvent` signature and the existing `validateEnvelope`-not-in-persistEvent decision this story extends]
- [Source: `src/api/v1/events.ts` - `resolveModuleFromBody` (module resolved from stream_type), the public write path this story's enforcement covers transitively]
- [Source: `src/api/v1/doa.ts` - `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` helper pattern to reuse for the admin endpoint]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.5 (Kilo)

### Debug Log References

- `npx tsc --noEmit`, `npm run lint`, and `npm test` all pass clean: 86 passing, 0 failing (67 baseline from Stories 1.1-1.4, +8 new unit, +11 new integration).
- PostgreSQL 18.4 via Docker inside WSL (the `postgres` service from `deploy/compose/docker-compose.yml`). The WSL VM idles down without a live WSL process (known environment gotcha from Story 1.4); a long-lived background WSL keepalive held `localhost:5432` stable for the duration of the runs.
- `npm run db:migrate` re-applies all five migration files (including the new `business_stream_config.sql`) idempotently against the live test database.
- The Story 1.5 integration file passed 11/11 on its first run; the only failures in the aggregate run were the anticipated cross-story ones (see Completion Notes).

### Completion Notes List

- **Task 1:** Created `read/projections/business_stream_config.sql` (canonical, self-sufficient: `business_streams` vocabulary table seeded with the four pilot streams via `ON CONFLICT DO NOTHING`, `transaction_tagging_rules` dated-config table, index, UNIQUE `(transaction_type, effective_from)` backstop, guarded grant blocks - deliberately NOT `users.sql`'s split-brain pattern). Mirrored in full into `deploy/compose/init-db.sql` under a change-both-together banner. Implemented `src/read/projections/business_stream_config.ts` with `isValidBusinessStream`, `listBusinessStreams`, `findActiveTaggingRule` (throws `TAGGING_CONFIG_CONFLICT` on same-date rule overlap as defense-in-depth), `findConflictingRule` (range-overlap check using `COALESCE(..., 'infinity'::date)`), and `createTaggingRule` (accepts the transaction `client` for atomic writes). DATE columns formatted from local Y-M-D components per the Story 1.4 timezone lesson. Registered in `src/events/migrate.ts` after `doa_registry.sql`.
- **Task 2:** `src/compliance/business-stream.ts` exports `assertInventoryTagging(envelope, deps?)` - the single FR-AC-01 enforcement point, with a `TaggingDeps` injection seam so unit tests run DB-free. Gated by `INVENTORY_MOVEMENT_STREAM_TYPES = new Set(['inventory'])`; non-inventory streams return before any lookup. Violations throw `AppError(400)` with `details.missing_tag` / `details.invalid_value` so Spine Acceptance Contract test #5's "rejection identifies the missing tag" is observable. Wired at the TOP of `persistEvent` in `src/events/store.ts`, before any DB write - covers the public HTTP path transitively and the future Story 1.8 edge sync path by construction. The `EventEnvelope` import in the compliance module is type-only, so no runtime circular dependency. 8 unit tests via `node --test` with fake deps, including an unreachable-deps guard proving non-inventory streams trigger zero DB lookups.
- **Task 3:** `src/api/v1/business-stream.ts` with three handlers. `POST /api/v1/business-streams/rules` (compliance/write): full input validation, 409 `TAGGING_RULE_CONFLICT` on range overlap, atomic rule-row + `business_stream_config.rule_created` event + audit entry in ONE transaction via `persistEvent(..., client)`. `GET /api/v1/business-streams/rules` and `GET /api/v1/business-streams` (compliance/read). The `actorContext`/`auditCtxFor`/`NO_LOCATION_UUID` helpers are duplicated from `doa.ts` (per the story's explicit guidance) with a comment naming the source and the extract-on-third-consumer rule. No PATCH/DELETE for rules - documented in a code comment as dated-configuration policy, not an omission.
- **Task 4:** Registered the three routes in `src/server.ts`. No `src/api/router.ts` changes needed.
- **Task 5:** `test/integration/story-1-5.test.ts` (11 tests) follows the story-1-4 harness exactly: migrations in `before()`, audit-trigger escape hatch around TRUNCATE, SCIM + dev-token provisioning, port 3996. Covers all 4 ACs (each rejection asserts the error code, the identifying detail, AND zero `domain_events` rows), dated-rule applicability (a 2099 rule does not gate today's events), rule-overlap 409, both GET endpoints (including the DATE round-trip assertion), RBAC denial on both modules, the non-inventory passthrough regression guard, and admin input validation.
- **Cross-story fix (anticipated by the story's "leave the system working end-to-end" rule):** Stories 1.1/1.2/1.3's integration tests post `stream_type: 'inventory'` events that predate FR-AC-01 and carried no `business_stream` - the new invariant correctly rejected 9 of them. Fixed by (a) adding `business_stream: 'production'` to those test payloads (they are now compliant clients of the spine) and (b) applying `business_stream_config.sql` in those files' `before()` hooks so a fresh CI database has the vocabulary table before any inventory event is posted. No product behavior of Stories 1.1-1.4 changed; all their tests pass. This mirrors the Story 1.4 precedent of updating prior harnesses (`TRUNCATE ... CASCADE`) when a later spine story adds a constraint.

### File List

- `read/projections/business_stream_config.sql` (new - canonical vocabulary + tagging-rules schema, seeds, index, guarded grants)
- `src/read/projections/business_stream_config.ts` (new - stream/rule projection functions)
- `src/compliance/business-stream.ts` (new - assertInventoryTagging enforcement point, FR-AC-01)
- `src/api/v1/business-stream.ts` (new - three admin route handlers)
- `src/events/store.ts` (modified - assertInventoryTagging called at top of persistEvent)
- `src/events/migrate.ts` (modified - registers business_stream_config.sql)
- `src/server.ts` (modified - registers three business-stream routes)
- `deploy/compose/init-db.sql` (modified - mirrors business_streams + transaction_tagging_rules)
- `test/unit/business-stream.test.ts` (new - 8 DB-free enforcement-logic cases)
- `test/integration/story-1-5.test.ts` (new - all ACs, 11 tests)
- `test/integration/story-1-1.test.ts` (modified - business_stream on inventory payloads + vocabulary migration in before())
- `test/integration/story-1-2.test.ts` (modified - business_stream on inventory payloads + vocabulary migration in before())
- `test/integration/story-1-3.test.ts` (modified - business_stream on inventory payloads + vocabulary migration in before())

## Change Log

- 2026-07-19: Implemented Story 1.5 (Business-Stream Tagging Enforcement). Delivered the business-stream vocabulary and dated tagging-rule schema with self-sufficient guarded grants, the `assertInventoryTagging` enforcement point at the top of `persistEvent` (stream-type gated, `details.missing_tag` observability), three compliance admin endpoints with atomic rule+event+audit writes, and full unit + integration coverage. Updated Stories 1.1-1.3 test payloads to comply with the new spine invariant (9 anticipated cross-story failures, all resolved by tagging the test events). Full suite: 86 passing, 0 failing; `tsc --noEmit` and `eslint` clean; `db:migrate` idempotent.
