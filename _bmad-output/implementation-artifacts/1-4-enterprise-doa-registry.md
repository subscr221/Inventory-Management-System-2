---
baseline_commit: 6dce31a
---

# Story 1.4: Enterprise DOA Registry

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a system administrator,
I want to configure an enterprise delegation-of-authority registry (roles, transaction types, value bands, vacation delegations) that every approval workflow resolves from at runtime,
So that approval routing is always current without any workflow code change, and no approval path can be hard-coded.

## Acceptance Criteria

1. **Given** a DOA entry: role `procurement_head`, transaction type `po_approval`, value band `> 500000`
   **When** a synthetic resolution request `POST /api/v1/doa/resolve` with `{ "transaction_type": "po_approval", "value": 600000 }` is submitted (registry configuration data only - no PO entity or module code required; Epic 4 approval workflows consume this same endpoint for real POs)
   **Then** the registry resolves the approver as the current holder of `procurement_head` and returns the resolution referencing the matched registry entry
   **And** the "no hard-coded role name in workflow code" invariant is verified as an observable pass/fail by a CI static check (lint rule rejecting role-name literals in workflow code), executed as part of the Story 1.9 spine contract run

2. **Given** a vacation delegation from User A to User B for dates 2026-08-01 to 2026-08-10
   **When** a synthetic resolution request that resolves to the role held by User A is submitted on 2026-08-05
   **Then** the resolution returns User B; the delegation and its active dates are recorded in the event log

3. **Given** a DOA registry entry is updated by the System Administrator
   **When** the next resolution request is submitted after the update
   **Then** it uses the new entry immediately with no system restart required
   **And** every DOA registry change is logged in the edit log with the administrator's identity

4. **Given** a workflow configuration entry that attempts to specify its own approver mapping for a transaction type governed by the DOA registry
   **When** the configuration is saved or a resolution request for that transaction type is processed
   **Then** the write is rejected with `error_code: "DOA_OVERRIDE_BLOCKED"` - workflow configuration consumes the registry's resolution and can never override it (FR-DOA-01)

## Tasks / Subtasks

- [x] Task 1: DOA registry data model and projection functions (AC: 1, 2, 3)
  - [x] 1.1 Create `read/projections/doa_registry.sql`: `doa_registry_entries` table (`entry_id` UUID PK, `role` TEXT NOT NULL, `transaction_type` TEXT NOT NULL, `value_min` NUMERIC NULL - exclusive lower bound, `value_max` NUMERIC NULL - inclusive upper bound, either/both NULL meaning unbounded, `active` BOOLEAN NOT NULL DEFAULT true, `created_at`/`updated_at` TIMESTAMPTZ NOT NULL DEFAULT now()) and `doa_vacation_delegations` table (`delegation_id` UUID PK, `delegator_user_id` UUID NOT NULL REFERENCES users(user_id), `delegate_user_id` UUID NOT NULL REFERENCES users(user_id), `start_date` DATE NOT NULL, `end_date` DATE NOT NULL, `active` BOOLEAN NOT NULL DEFAULT true, `created_at` TIMESTAMPTZ NOT NULL DEFAULT now()). Add `idx_doa_registry_entries_lookup ON doa_registry_entries (transaction_type, active)` and `idx_doa_vacation_delegations_delegator ON doa_vacation_delegations (delegator_user_id, active, start_date, end_date)`. **Grants belong in THIS file**, guarded exactly like `read/projections/audit_log.sql` already does (`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN GRANT ...; END IF; ... END $$;`) - `deferred-work.md` (2026-07-18 entry) logs `read/projections/users.sql` as a known split-brain bug precisely because its grants live ONLY in `deploy/compose/init-db.sql`, leaving a migrate-only-provisioned database unable to serve writes as `app_user`. Do not repeat that bug: `doa_registry.sql` must be self-sufficient (tables + indexes + guarded grants), matching `audit_log.sql`'s actual pattern, not `users.sql`'s.
  - [x] 1.2 Implement `src/read/projections/doa_registry.ts` with exported `DoaRegistryEntry`/`VacationDelegation` interfaces and functions: `createDoaEntry(input)`, `updateDoaEntry(entryId, patch)` (returns updated row or `null` if not found), `findMatchingDoaEntry(transactionType, value)` (matches `value_min IS NULL OR value > value_min` AND `value_max IS NULL OR value <= value_max`, `active = true`, orders by `created_at ASC LIMIT 1` when more than one entry could match - document the tie-break in a comment), `createVacationDelegation(input)`, `findActiveDelegation(delegatorUserId, asOfDate)` (matches `active = true AND start_date <= asOfDate AND end_date >= asOfDate`, **and joins/filters `users.active = true` on the delegate** - a deprovisioned delegate must not be resolvable as an approver; if the only matching delegation's delegate is inactive, treat it as no active delegation and fall back to the original role holder), `findRoleHolder(role)` (queries `user_role_assignments JOIN users` for `role = $1 AND users.active = true`, deterministic tie-break by earliest `user_role_assignments.created_at` if more than one active user holds the same role - document this as a Phase-1 simplification; Epic 4 workflows may add location-scoped resolution later). `node-postgres` returns `NUMERIC` columns as strings, not JS numbers - `value_min`/`value_max` must be converted with `Number(...)` (or `null`) when mapping rows to `DoaRegistryEntry`, the same way `src/api/v1/audit.ts` already converts `seq_no`.
  - [x] 1.3 Register `../../read/projections/doa_registry.sql` in `src/events/migrate.ts`'s `MIGRATIONS` array, after `audit_log.sql`.
  - [x] 1.4 Mirror the full contents (tables, indexes, AND the guarded grant blocks from 1.1) into `deploy/compose/init-db.sql`, following the exact dual-file convention Story 1.3 established (a comment at the top of both files stating they must stay identical) - `deploy/compose/init-db.sql` is a copy for first-time cluster init, not the sole source of grants.
  - [x] 1.5 **Atomicity fix, required (not optional polish):** extend `persistEvent(envelope, auditCtx?, client?)` in `src/events/store.ts` with a third, optional `client?: PoolClient` parameter. When provided, `persistEvent` uses that client directly for its `INSERT INTO domain_events` and `logAuditEntry` calls instead of calling `pool.connect()`/`BEGIN`/`COMMIT` itself - the caller owns the transaction boundary. When omitted, behavior is byte-for-byte unchanged (fully backward compatible with every existing caller in `events.ts` and `scim.ts` - do not touch those call sites). Give `createDoaEntry`, `updateDoaEntry`, and `createVacationDelegation` in `src/read/projections/doa_registry.ts` the same optional `client?: PoolClient` parameter, using it instead of `getPool().query(...)` when supplied. This exists so Tasks 2.1, 2.2, and 3.1 can write the registry row and the domain event in ONE transaction instead of two separate round-trips - `deferred-work.md`'s SCIM entry ("SCIM directory mutations commit before the event+audit write... bring the event into the same transaction as the directory write") describes exactly the failure mode this prevents; do not let this new story introduce the same crash-window gap that is already an open, logged issue elsewhere in the codebase.

- [x] Task 2: DOA registry entry endpoints (AC: 1, 3)
  - [x] 2.1 Implement `POST /api/v1/doa/entries` in a new `src/api/v1/doa.ts`, wrapped in `requireRole({ module: 'compliance', functionScope: 'write' })`. Body: `{ role, transaction_type, value_min?, value_max? }` - `role` and `transaction_type` required non-empty strings; `value_min`/`value_max` optional numbers or `null`; if both are provided, reject with `INVALID_PARAMS` if `value_max <= value_min`. **Atomic write (see Task 1.5):** acquire a client via `getPool().connect()`, `BEGIN`, call `createDoaEntry(input, client)` and `persistEvent(envelope, auditCtx, client)` on that same client (`stream_type: 'doa_registry_entry'`, `stream_id: entry_id`, `event_type: 'doa_registry.entry_created'`, `payload: { entry }`; see Dev Notes: Event Envelope Actor for the `location_id` sentinel rule), `COMMIT`, `client.release()` in `finally`, `ROLLBACK` on any error before rethrowing. Respond `201` with the created entry.
  - [x] 2.2 Implement `PATCH /api/v1/doa/entries/:entryId`, same RBAC. Validate `entryId` is a UUID (400 `INVALID_PARAMS` otherwise). Body: any subset of `{ role, transaction_type, value_min, value_max, active }`. 404 `NOT_FOUND` if no entry matches. Apply the same `value_max > value_min` check against the merged (existing + patch) values. Same atomic-transaction shape as 2.1: `updateDoaEntry(entryId, patch, client)` and `persistEvent(envelope, auditCtx, client)` on one client, `event_type: 'doa_registry.entry_updated'`, `payload: { entry_id, before, after }`, `auditCtx` (http_status 200), single `COMMIT`. This is what makes AC3's "every DOA registry change is logged in the edit log with the administrator's identity" observable - the audit entry's `user_id`/`role` come from the authenticated caller via `getAuthContext`/`getAuthorizedAssignment`, never from the request body - AND what makes it durable: a crash between the row update and the event/audit write is now impossible, not just unlikely.
  - [x] 2.3 `findMatchingDoaEntry` and `findRoleHolder` always query fresh (no in-memory cache) - this is what makes AC3's "next resolution request... uses the new entry immediately with no system restart required" true by construction; do not add caching.

- [x] Task 3: Vacation delegation endpoint (AC: 2)
  - [x] 3.1 Implement `POST /api/v1/doa/delegations`, `requireRole({ module: 'compliance', functionScope: 'write' })`. Body: `{ delegator_external_id, delegate_external_id, start_date, end_date }` (dates as `YYYY-MM-DD`; validate with `/^\d{4}-\d{2}-\d{2}$/` plus `!Number.isNaN(Date.parse(...))`; reject `end_date < start_date` with `INVALID_PARAMS`). Resolve both external IDs to `user_id` via the existing `getUserIdByExternalId` from `src/read/projections/users.ts` (reuse, do not reinvent); 404 `NOT_FOUND` if either does not resolve. `getUserIdByExternalId` does not filter on `active` status - after resolving each `user_id`, additionally verify both users are active (e.g. via `lookupActiveUserWithRoles` or an equivalent active check) and reject with `NOT_FOUND` if either is deprovisioned; a delegation naming a deprovisioned delegator or delegate must not be creatable. **Atomic write (see Task 1.5):** same one-client `BEGIN`/`COMMIT` shape as 2.1 - `createVacationDelegation(input, client)` and `persistEvent(envelope, auditCtx, client)` on the same client, `stream_type: 'doa_vacation_delegation'`, `stream_id: delegation_id`, `event_type: 'doa_registry.vacation_delegation_created'`, `payload: { delegation_id, delegator_user_id, delegate_user_id, start_date, end_date }`, `auditCtx` (http_status 201). This event is the "recorded in the event log" half of AC2 - the delegation and its active dates must be readable back via `readStream('doa_vacation_delegation', delegation_id)`.

- [x] Task 4: Resolution endpoint (AC: 1, 2, 3)
  - [x] 4.1 Implement `POST /api/v1/doa/resolve`, `requireRole({ module: 'compliance', functionScope: 'read' })` (a `write` assignment satisfies `read` per the existing `satisfiesFunctionScope` rule in `src/middleware/rbac.ts` - no new RBAC logic needed). Body: `{ transaction_type, value, as_of_date? }` - `transaction_type` non-empty string, `value` a finite number, `as_of_date` optional `YYYY-MM-DD` (defaults to the current UTC date via `new Date().toISOString().slice(0, 10)`) - the optional param exists purely for deterministic testing of AC2's dated delegation window; without it the vacation-delegation AC is not reliably testable.
  - [x] 4.2 Call `findMatchingDoaEntry(transaction_type, value)`. If no entry matches, respond 404 `NO_DOA_ENTRY_MATCH`.
  - [x] 4.3 Call `findRoleHolder(matched_entry.role)`. If no active user holds that role, respond 404 `NO_APPROVER_FOUND`.
  - [x] 4.4 Call `findActiveDelegation(holder.user_id, as_of_date)`. If a delegation is active (and its delegate is active, per Task 1.2), the resolved `approver` is the delegate (`delegation_applied: true`, `delegated_from: holder.user_id`); otherwise `approver` is the holder (`delegation_applied: false`, `delegated_from: null`).
  - [x] 4.5 Respond 200 with `{ matched_entry: { entry_id, role, transaction_type, value_min, value_max }, approver: { user_id, external_id }, delegation_applied, delegated_from }`.

- [x] Task 5: DOA-override-blocked synthetic scaffold (AC: 4)
  - [x] 5.1 Implement `POST /api/v1/doa/workflow-config` in `src/api/v1/doa.ts`, `requireRole({ module: 'compliance', functionScope: 'write' })`. Body: `{ transaction_type, approver_mapping }`. **This is a minimal spine-test scaffold, not a real workflow-configuration module** - no workflow-config module exists yet (Epic 4 is not built). It exists solely to make the "no override" invariant observable now, the same way Story 1.6's synthetic putaway test event and Story 1.7's synthetic QC-result command made their invariants observable before their consuming modules existed. Say so in a code comment.
  - [x] 5.2 If `doa_registry_entries` has any `active = true` row for `transaction_type` (an existence check, not a value-band match, since the AC's point is that the transaction type is *governed*, independent of any specific value), reject the write: call `logTamperAttempt` (reuse the exact function Story 1.3 built in `src/read/projections/audit_log.ts` - do not add a second tamper-recording path) with `error_code: 'DOA_OVERRIDE_BLOCKED'`, then respond 409 `DOA_OVERRIDE_BLOCKED`. Persist nothing. Note in a comment that this reuses `audit_log_tamper_attempt_log` (built for audit-log-tamper detection) for a second, related-but-distinct compliance violation - both represent "someone tried to bypass the compliance spine," which is why the table is reused rather than adding a parallel one.
  - [x] 5.3 Otherwise (transaction type not governed by the DOA registry) respond 200 `{ accepted: true }`. No persistence - there is no real workflow-config store to write to yet; this branch only proves the gate doesn't fire on ungoverned types.

- [x] Task 6: CI static check - no-hardcoded-role lint rule (AC: 1)
  - [x] 6.1 Create `eslint-rules/no-hardcoded-role-in-workflow.js`: a plain ESLint 9 rule object (`{ meta, create(context) {...} }`, no plugin package needed). Flags two patterns: (a) a `BinaryExpression` with operator `===`/`!==`/`==`/`!=` where one operand is a string `Literal` and the other is role-like (an `Identifier` named `role`, or a non-computed `MemberExpression` whose `property.name === 'role'`); (b) a `SwitchStatement` whose `discriminant` is role-like and any `case` has a string `Literal` test. Report message: `"Hard-coded role-name literal in a role comparison; resolve approvers through the DOA registry (POST /api/v1/doa/resolve) instead of hard-coding role names. [FR-DOA-01]"`.
  - [x] 6.2 Register it in `eslint.config.js` as a local plugin (`plugins: { doa: { rules: { 'no-hardcoded-role-in-workflow': rule } } }`, `rules: { 'doa/no-hardcoded-role-in-workflow': 'error' }`) applied to `src/**/*.ts`, with an `ignores` entry for `src/middleware/rbac.ts`, `src/middleware/auth.ts`, and `src/read/projections/**` (infrastructure that legitimately carries role *strings* as data on `RoleAssignment` objects, not branching *logic* on a role). A repo-wide grep before this story found **zero** existing `role === '...'` or role-discriminant `switch` patterns in `src/` - confirm `npm run lint` stays clean after wiring the rule; if it does not, that is a genuine new finding to fix, not a rule bug.
  - [x] 6.3 Add `test/unit/no-hardcoded-role-in-workflow.test.ts` using ESLint's built-in `RuleTester` (`import { RuleTester } from 'eslint'`, run via `node --test` like the rest of the suite). Valid cases: a role compared through a variable that isn't literally named `role`/`.role`, and code that calls the DOA resolve endpoint instead of branching. Invalid cases: `if (role === 'procurement_head') { ... }` and `switch (user.role) { case 'system_administrator': ... }`.
  - [x] 6.4 This IS the "observable pass/fail... CI static check" AC1 requires - `npm run lint` already runs it today, so it is testable now even though no real workflow module exists yet. Story 1.9 (not yet built) is responsible for wiring `npm run lint` into the required spine-contract status check; this story delivers the check itself, not the CI gate wiring. Do not attempt to build Story 1.9's CI gate here.

- [x] Task 7: Route registration
  - [x] 7.1 Register the five new routes in `src/server.ts`: `router.post('/api/v1/doa/entries', createDoaEntryHandler)`, `router.patch('/api/v1/doa/entries/:entryId', updateDoaEntryHandler)`, `router.post('/api/v1/doa/delegations', createDelegationHandler)`, `router.post('/api/v1/doa/resolve', resolveDoaHandler)`, `router.post('/api/v1/doa/workflow-config', workflowConfigHandler)`. No changes to `src/api/router.ts` are needed - `post()`/`patch()` already exist, and Story 1.3 already added `put()`.

- [x] Task 8: Integration tests (AC: 1, 2, 3, 4)
  - [x] 8.1 Create `test/integration/story-1-4.test.ts` following the exact harness pattern in `test/integration/story-1-3.test.ts`: `before`/`after` hooks that run migrations against a real Postgres via `getAdminPool()`, a `makeRequest` helper, and a `provisionTestUser`-style helper (reuse/adapt, don't duplicate the HTTP-request plumbing).
  - [x] 8.2 AC1: provision an admin user (`role: 'system_administrator', module: 'compliance', functionScope: 'write', locationId: '*'`) and a second user holding `role: 'procurement_head'` (any module/location - resolution is role-name-based, not module-scoped). Create a DOA entry (`role: 'procurement_head', transaction_type: 'po_approval', value_min: 500000, value_max: null`). `POST /api/v1/doa/resolve { transaction_type: 'po_approval', value: 600000 }` results in 200, `approver.user_id` equals the second user's id, `matched_entry.entry_id` equals the created entry's id.
  - [x] 8.3 AC2: provision a third user (User B, the delegate). Create a vacation delegation from the `procurement_head` holder (User A) to User B for `2026-08-01`..`2026-08-10`. `POST /api/v1/doa/resolve { transaction_type: 'po_approval', value: 600000, as_of_date: '2026-08-05' }` results in `approver.user_id` equal to User B's id, `delegation_applied: true`, `delegated_from` equal to User A's id. Also assert the delegation is readable via `readStream('doa_vacation_delegation', delegation_id)` (or the equivalent `GET` if one is wired) with the correct dates - this is the "recorded in the event log" half of AC2. Additionally test the deprovisioned-delegate edge case from Task 1.2: deactivate User B, resolve again for the same window, and assert the resolution falls back to User A (the original holder) rather than returning a deprovisioned approver.
  - [x] 8.4 AC3: `PATCH` the entry's `value_min` to a new value, then resolve again with a value that only matches under the new band - resolves correctly with no server restart. Separately, query `audit_log` directly (mirroring the pattern in `test/integration/story-1-3.test.ts`) and assert a row exists attributing the PATCH to the admin's `user_id`.
  - [x] 8.5 AC4: `POST /api/v1/doa/workflow-config` for `transaction_type: 'po_approval'` (which has an active entry from 8.2) results in 409 `DOA_OVERRIDE_BLOCKED`; assert a row was written to `audit_log_tamper_attempt_log` with that `error_code` (reuse the query pattern from `test/integration/story-1-3.test.ts`'s tamper-attempt assertions). Also test the non-governed branch: a `transaction_type` with no DOA entry results in 200 `{ accepted: true }`.
  - [x] 8.6 RBAC boundary: a caller with no role assignment for module `compliance` gets 403 `MODULE_ACCESS_DENIED` on all five endpoints.
  - [x] 8.7 Not-found paths: `resolve` with an unrecognized `transaction_type` returns `NO_DOA_ENTRY_MATCH`; a `transaction_type` whose matching entry's role has zero active holders returns `NO_APPROVER_FOUND`.
- [x] 8.8 Run `npm run lint`, `tsc --noEmit`, and `npm run test:integration` - all clean. Confirm the full aggregate suite (Stories 1.1-1.4) still passes with no regressions (55 tests were green across 1.1-1.3 as of this story's baseline commit `6dce31a`).

### Review Findings

- [x] [Review][Patch] TOCTOU race in `PATCH /api/v1/doa/entries/:entryId` allows invalid value bands [`src/api/v1/doa.ts:182-192`]
- [x] [Review][Patch] ESLint rule `no-hardcoded-role-in-workflow` can be bypassed with template literals [`eslint-rules/no-hardcoded-role-in-workflow.js:21-23`]
- [x] [Review][Patch] Tie-breaker queries rely on `created_at` alone, so identical timestamps produce non-deterministic ordering [`src/read/projections/doa_registry.ts:182,232,255`]
- [x] [Review][Patch] Concurrent `PATCH` serialization lacks a regression test for the `FOR UPDATE` lock [`test/integration/story-1-4.test.ts:381-390`]
- [x] [Review][Patch] Same-timestamp resolution tie-breakers lack deterministic winner coverage [`test/integration/story-1-4.test.ts:381-390`]

## Dev Notes

### Previous Story Intelligence (from Story 1.3)

- **`persistEvent(envelope, auditCtx)` is the established write path.** It writes the domain event and (if `auditCtx` is supplied) the audit-log entry atomically in one transaction. Every mutating DOA endpoint must pass `auditCtx` - this is what makes AC3's "every DOA registry change is logged in the edit log" true without writing a second audit code path. **This story extends its signature** (Task 1.5) with an optional third `client?: PoolClient` parameter so the DOA row write and the event write can share one transaction - a fresh-eyes review of this story caught that a naive "write the row, then call `persistEvent()`" would reproduce the exact non-atomic gap already logged in `deferred-work.md` for SCIM (directory mutation commits before the event+audit write). The extension is additive and backward compatible; no existing caller changes.
- **`requireRole({ module, functionScope, locationId? })` from `src/middleware/rbac.ts`** wraps a `RouteHandler` and sets `authorizedRole`/`authorizedAssignment` on the request (via `src/middleware/context.ts`) before the handler runs. Handlers must read the actor's identity from `getAuthContext(req)`/`getAuthorizedAssignment(req)`, **never from the request body** (this was Story 1.2's biggest code-review finding, carried forward through 1.3: "Event `actor` identity is client-supplied" was flagged HIGH).
- **`logTamperAttempt` and `logAuditEntry`** (both in `src/read/projections/audit_log.ts`) are the only two audit-writing functions in the codebase. Reuse them directly for DOA_OVERRIDE_BLOCKED (via `logTamperAttempt`, mirroring how `AUDIT_LOG_DISABLED` rejections are recorded in `src/api/v1/events.ts` and `src/api/v1/config.ts`); do not add a third audit-writing path.
- **Router already supports every HTTP verb this story needs.** `post()`, `patch()` existed before Story 1.3; `put()` was added by Story 1.3. No `src/api/router.ts` changes are required for this story.
- **Migration + dual-file convention:** every new table lives in a canonical `read/projections/*.sql` file applied by both `src/events/migrate.ts` (via `MIGRATIONS`) and the test harness's `before()` hook, with a mirrored copy in `deploy/compose/init-db.sql` for first-time cluster init. **The canonical file must carry its own grants** (guarded `DO $$ ... IF EXISTS (SELECT FROM pg_roles ...) ... $$` blocks), matching `audit_log.sql`'s actual, current pattern. `read/projections/users.sql` does NOT follow this (its grants live only in `init-db.sql`), and that gap is an open, logged bug in `deferred-work.md` - do not copy `users.sql`'s pattern for the new DOA tables.
- **Test harness pattern:** `test/integration/story-1-3.test.ts` builds its own minimal `Router` + handler wiring (not the full `src/server.ts`) inside `before()`, runs the SQL migrations directly, provisions test users via the SCIM endpoint plus dev-token, and tears down with `closePool()`/`closeAdminPool()` in `after()`. Follow this exact shape for `test/integration/story-1-4.test.ts` rather than inventing a new harness style.
- **Git intelligence:** Stories land as a single `feat(...)` commit; review remediation lands as separate, clearly-labeled follow-up commits (never silent amends). No fixup-commit spam.

### Event Envelope Actor: `location_id` Sentinel Rule

`persistEvent()` does **not** call `validateEnvelope()` - that strict UUID-checking validator only runs on the public `POST /api/v1/events` path (see `src/api/v1/events.ts`). Internal adapters (like `src/adapters/iam/scim.ts`) construct envelopes directly, so this story has the same freedom. This is **new logic for this story**, not a reused existing pattern: `src/adapters/iam/scim.ts` unconditionally uses a fixed zero-UUID `SYSTEM_ACTOR_ID` for every event it emits (it never reads an `authorizedAssignment` and never branches on the caller's location), because every SCIM-emitted event has a genuine system principal as its actor, not a real user. DOA registry endpoints are different: the actor is always a real authenticated administrator, and that administrator's `authorizedAssignment.locationId` will typically be `'*'` (enterprise-wide grant), which is not a valid UUID. For this story, build a new, explicit rule: when the authorizing assignment's `locationId` is `'*'`, use the same zero-UUID sentinel value (`00000000-0000-0000-0000-000000000000`) for `metadata.actor.location_id` in the domain event, reusing only the *sentinel value* as a "no specific location" convention; when the assignment's `locationId` is a real location UUID, use it directly. The **audit log** (`audit_log.location_id`, a plain TEXT column) has no such constraint - pass `authorizedAssignment.locationId` straight through there, exactly as `src/api/v1/config.ts` already does.

### Design Decisions Baked In (documented, not blocking)

- **Value band semantics:** `value_min` is an **exclusive** lower bound, `value_max` an **inclusive** upper bound; either/both `NULL` means unbounded on that side. This directly matches the epic's own example - `value band "> 500000"` - as `value_min: 500000, value_max: null`. There is no example of an upper-bounded band in the epic; inclusive-upper was chosen as the natural pairing. Flag any disagreement during dev-story review, but this is not a blocking fork, just a documented interpretation.
- **Single-holder resolution - real limitation, not just a footnote:** the registry is enterprise-wide (no location dimension anywhere in this story's ACs or in the epic's own resolve example, which has no location field). If more than one active user holds the resolved role, `findRoleHolder` deterministically picks the earliest-assigned holder rather than erroring or silently randomizing. This is safe for the pilot as scoped: `sprint-status.yaml` frames the pilot as go-live "at a single site," so a single enterprise-wide `procurement_head` is the realistic case during pilot. It stops being safe the moment a second site goes live with its own `procurement_head` - this design would silently route that site's approvals to the pilot site's holder, which is an incident, not a rounding error. Epic 4's real approval workflows must add location-scoped resolution before any multi-site rollout; that is out of scope for this story, but flag it explicitly to whoever plans the post-pilot rollout rather than letting it stay buried in dev notes.
- **Task 6 (lint rule) stays in this story, not Story 1.9.** AC1's own text ties the CI check to "the Story 1.9 spine contract run," which could be read as 1.9 owning the build. Resolution: 1.9 owns *executing* the check as a required status check; 1.4 owns *building* it, because the "no hard-coded role name" invariant is otherwise unverifiable for however long 1.9 remains unbuilt - an untestable acceptance criterion is worse than a check built one story early. If 1.9 ends up landing very differently, revisit whether the rule should move; don't hold this story's completion hostage to that.
- **No epic currently owns a DOA registry admin UI.** The story's own persona line ("As a system administrator, I want to configure...") is delivered here as five raw API endpoints, with no UI. Scanned the epics backlog (Epic 1 through Epic 20 headers) and found no admin-console or system-configuration epic that would own this either - it is a genuine gap in the broader backlog, not something this story is deferring to a known future story. Until one exists, registry configuration happens via direct API calls; this is noted here for whoever grooms the epics backlog next, not resolved by this story.
- **Lint rule scope is structural, not a role-name allowlist.** The rule bans the *pattern* of hard-coded role-literal comparisons anywhere in `src/` (minus the RBAC/auth infra ignores), rather than maintaining a synced list of "known DOA role names" that would drift. This was chosen specifically because a literal-list approach requires the ESLint config (which runs statically, with no DB access) to stay in sync with whatever roles get seeded into `doa_registry_entries` at runtime - an unfixable staleness problem. The structural rule has no such dependency and was verified against the current `src/` tree (zero existing matches, confirmed by grep before this story was written).
- **Deactivated actors cannot be named in a DOA registry write.** `findRoleHolder` already filters `users.active = true`; Task 1.2 and Task 3.1 extend that same guard to vacation-delegation delegates and to both parties named when a delegation is created, so a deprovisioned user can never end up as a live approver or as a newly-recorded delegator/delegate.

### Architecture Compliance

- **AD-3 (DOA Registry as Single Approval Resolver):** "one enterprise DOA registry (role, transaction type, value band, vacation delegation, change audit) resolves approvers for every workflow. Workflow configuration consumes the registry, never overrides it." This story delivers exactly that shape - the four elements listed in AD-3 map 1:1 onto `doa_registry_entries` (role, transaction type, value band), `doa_vacation_delegations`, and the reused Story 1.3 audit log (change audit).
- **AD-12 (Compliance Spine as Platform Layer):** the DOA registry is part of the bottom layer every module depends on; it must be fully built and acceptance-tested (Story 1.9, consuming this story) before any module epic (starting with Epic 4 procurement) can land.
- **Consistency Conventions** (`ARCHITECTURE-SPINE.md`): entity naming singular (`doa_registry_entries` uses a plural table name, matching the existing `user_role_assignments`/`domain_events` convention rather than the "singular entity" naming rule read literally as table-naming; follow the codebase's actual table-naming precedent, not the idealized doc, exactly as Story 1.3 did), events past-tense dot-separated (`doa_registry.entry_created`), error envelope `{ error_code, message, details, trace_id }` (already provided by `src/middleware/error.ts`; use `sendJson`/`sendRequestError`, don't hand-roll).
- **Stable error codes this story introduces:** `DOA_OVERRIDE_BLOCKED`, `NO_DOA_ENTRY_MATCH`, `NO_APPROVER_FOUND`. Reuses existing `INVALID_PARAMS`, `NOT_FOUND`, `MODULE_ACCESS_DENIED` (RBAC), `UNAUTHORIZED`.

### Project Structure Notes

The architecture's idealized "Structural Seed" lists a top-level `compliance/` folder for FR-DOA-01. **The actual codebase does not follow that layout.** Stories 1.1-1.3 organized everything under `src/{layer}/` (`src/api/v1/`, `src/config/`, `src/middleware/`, `src/events/`, `src/read/projections/`) with no top-level per-domain folders at all. This story follows the *real*, established convention (like Story 1.3's audit/config code did), not the idealized doc: DOA logic lives in `src/api/v1/doa.ts` and `src/read/projections/doa_registry.ts`, not a new `compliance/` directory. RBAC still uses the module string `'compliance'` (matching the architecture's Capability-to-Architecture Map row for FR-DOA-01) - that's a logical module name for access-control purposes, not a filesystem path.

The one genuinely new top-level path this story introduces is `eslint-rules/` (tooling, not runtime code) for the custom lint rule.

### Files This Story Touches

```text
{root}/
  eslint-rules/
    no-hardcoded-role-in-workflow.js   # NEW - custom ESLint rule (AC1)
  eslint.config.js                      # UPDATE - register local plugin + rule
  read/
    projections/
      doa_registry.sql                  # NEW - doa_registry_entries + doa_vacation_delegations
  src/
    read/
      projections/
        doa_registry.ts                 # NEW - CRUD + resolution query functions
    api/
      v1/
        doa.ts                          # NEW - 5 route handlers
    events/
      migrate.ts                        # UPDATE - add doa_registry.sql to MIGRATIONS
      store.ts                          # UPDATE - persistEvent() gains optional `client` param (Task 1.5)
    server.ts                           # UPDATE - register 5 routes
  deploy/
    compose/
      init-db.sql                       # UPDATE - mirror doa_registry tables + grants
  test/
    unit/
      no-hardcoded-role-in-workflow.test.ts   # NEW - ESLint RuleTester cases
    integration/
      story-1-4.test.ts                 # NEW - all ACs
```

### Testing Standards Summary

- Node's built-in test runner (`node --test`), not Jest/Mocha, matches every prior story. Integration tests need a real Postgres reachable via `.env.test` (Docker via WSL, as used for Stories 1.1-1.3's 55-test aggregate run).
- ESLint rule tests use `RuleTester` from the `eslint` package itself (already a devDependency); no new test-framework dependency needed.
- No new npm dependencies required anywhere in this story, same as Story 1.3.

### NFR Constraints Binding This Story

| NFR / Requirement | Impact |
| --- | --- |
| FR-DOA-01 | Core requirement: registry resolves every approval workflow; no hard-coded override path |
| AD-3 | Registry is the single approval resolver; workflow config never overrides it |
| AD-12 | DOA registry is part of the compliance spine bottom layer; built before any module epic |
| NFR-SEC-02 | RBAC to module/function scope on every DOA endpoint (`module: 'compliance'`) |
| NFR-DI-01 | Every DOA registry mutation is atomically audit-logged (reuses Story 1.3's tamper-proof edit log) |
| NFR-P-05 | API p95 under 500ms; single-row indexed lookups, no N+1 queries |

Table 1 summarizes the NFR constraints binding this story.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` #Story 1.4: Enterprise DOA Registry]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` #AD-3, #AD-12, #Consistency Conventions, #Capability-to-Architecture Map, #Spine Acceptance Contract]
- [Source: `_bmad-output/implementation-artifacts/1-3-statutory-edit-log.md` - `persistEvent`/`auditCtx` pattern, RBAC pattern, dual-file migration convention, test harness pattern]
- [Source: `_bmad-output/implementation-artifacts/1-2-sso-authentication-and-role-based-access-control.md` - RBAC role-assignment model, actor-identity-from-body anti-pattern]
- [Source: `src/adapters/iam/scim.ts` - internal `persistEvent()` envelope-construction pattern, zero-UUID sentinel convention]
- [Source: `src/api/v1/config.ts`, `src/api/v1/audit.ts` - RBAC-wrapped handler shape, `logTamperAttempt`/`logAuditEntry` usage]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` - `users.sql` grant split-brain bug, cited as the precedent this story's Task 1.1/1.4 must not repeat]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.8 (1M context)

### Debug Log References

- `npx tsc --noEmit`, `npm run lint`, and `npm test` all pass clean.
- PostgreSQL 18.4 was brought up via Docker inside WSL (the `postgres` service from `deploy/compose/docker-compose.yml`, roles + `init-db.sql` applied at container init). Windows-side Node reaches it on `localhost:5432`.
- **WSL VM lifecycle gotcha (environment, not code):** the WSL2 VM (and its Docker daemon + Postgres container) idles down whenever no WSL process is running, so Windows-side test runs intermittently hit `ECONNREFUSED` and the container log shows a periodic "fast shutdown request". Holding the VM up with a long-lived background WSL process for the duration of the run makes `localhost:5432` stable. This is a local-environment note for anyone re-running the suite here, not a product issue.
- **Test-harness parallelism fix:** `node --test` runs the per-story integration files concurrently by default, and their `before()` hooks each apply migrations (`CREATE OR REPLACE TRIGGER`, `ALTER TABLE`, `TRUNCATE`) against the one shared database, which deadlocks (reproduced on the pre-change baseline, so it predates this story). Integration tests that share a single database must run serially, so `package.json`'s `test` and `test:integration` scripts now pass `--test-concurrency=1`. The post-review aggregate suite is 65 passing, 0 failing.
- **Timezone bug found and fixed during test:** node-postgres parses a `DATE` column into a JS `Date` at local midnight; formatting it with `toISOString()` shifted the calendar day back one in this UTC+8 environment (`2026-08-01` surfaced as `2026-07-31` in the delegation event payload). `mapDelegation` now formats from local Y-M-D components.

### Completion Notes List

- **Task 1:** Created `read/projections/doa_registry.sql` (canonical, self-sufficient: tables + indexes + guarded `DO $$ ... pg_roles ...` grant blocks, matching `audit_log.sql`'s pattern - deliberately NOT `users.sql`'s split-brain pattern). Created `src/read/projections/doa_registry.ts` with `DoaRegistryEntry`/`VacationDelegation` interfaces and all CRUD + resolution functions; `NUMERIC` bounds are converted to JS numbers at the mapping boundary. Registered the SQL in `src/events/migrate.ts` and mirrored the full schema (tables + indexes + grants) into `deploy/compose/init-db.sql`. Extended `persistEvent(envelope, auditCtx?, client?)` with an optional transaction client (additive, backward compatible - existing `events.ts`/`scim.ts` callers untouched) so registry writes and their domain events commit atomically.
- **Task 2:** `POST`/`PATCH /api/v1/doa/entries` in `src/api/v1/doa.ts`, RBAC `module: 'compliance', functionScope: 'write'`. Both use one `BEGIN`/`COMMIT` across the row write and `persistEvent(..., client)`. Actor identity (audit `user_id`/`role`) comes from `getAuthContext`/`getAuthorizedAssignment`, never the body. PATCH validates the merged value band and emits `doa_registry.entry_updated` with `{ before, after }`.
- **Task 3:** `POST /api/v1/doa/delegations`; resolves both parties via `lookupActiveUserWithRoles` (existing function - resolves the id AND enforces active in one query), so a deprovisioned delegator/delegate is a 404. Atomic write + `doa_registry.vacation_delegation_created` event.
- **Task 4:** `POST /api/v1/doa/resolve` (read scope; write satisfies read). Matches the entry (exclusive-min/inclusive-max band), finds the active role holder, applies an active vacation delegation if one covers `as_of_date`. `NO_DOA_ENTRY_MATCH` / `NO_APPROVER_FOUND` on the two miss paths. Fresh queries only - no cache, so updates are effective immediately (AC3).
- **Task 5:** `POST /api/v1/doa/workflow-config` synthetic scaffold - existence-checks whether the transaction type is governed and, if so, records a `DOA_OVERRIDE_BLOCKED` tamper attempt (reusing Story 1.3's `logTamperAttempt`) and returns 409; ungoverned types return 200 with no persistence.
- **Task 6:** `eslint-rules/no-hardcoded-role-in-workflow.js` (+ `.d.ts` for the typed test import) flags role-literal comparisons and role-discriminant switches; wired into `eslint.config.js` for `src/**/*.ts` with the RBAC/auth/projections infra excluded. `npm run lint` is clean, confirming zero pre-existing violations. `test/unit/no-hardcoded-role-in-workflow.test.ts` exercises valid/invalid cases via `RuleTester`.
- **Task 7:** Registered all five routes in `src/server.ts` (no `router.ts` change needed).
- **Task 8:** `test/integration/story-1-4.test.ts` covers all four ACs plus RBAC denial, both not-found paths, the invalid value band, and the deprovisioned-delegate fallback. AC2 also asserts the delegation is replayable via `readStream`; AC3 asserts the PATCH is edit-logged to the admin's identity; AC4 asserts the tamper-log row.
- **Cross-story fix:** the new `doa_vacation_delegations` foreign key into `users` broke the `TRUNCATE ... users` resets in the Story 1.1/1.2/1.3 `before()` hooks; added `CASCADE` to those three (future-proofs the shared-DB harness against later FK-bearing tables). No product behavior of those stories changed; all their tests still pass.
- **Code review remediation:** added a database value-band `CHECK` constraint and row locking for concurrent PATCH safety, recognized static template literals in the hard-coded-role lint rule, and added unique secondary keys to all DOA resolution tie-breakers. Added regression coverage for the database constraint and template-literal cases.
- **Code re-review remediation:** added a deterministic concurrent HTTP PATCH test using a short-lived PostgreSQL delay trigger to prove row-lock serialization, plus rollback-only same-timestamp fixtures covering entry, delegation, and role-holder UUID tie-breakers. The post-review aggregate suite is 67 passing, 0 failing.

### File List

- `read/projections/doa_registry.sql` (new - canonical DOA schema, indexes, guarded grants)
- `src/read/projections/doa_registry.ts` (new - CRUD + resolution projection functions)
- `src/api/v1/doa.ts` (new - five DOA route handlers)
- `src/events/store.ts` (modified - `persistEvent` gains optional `client` transaction param)
- `src/events/migrate.ts` (modified - registers `doa_registry.sql`)
- `src/server.ts` (modified - registers five DOA routes)
- `deploy/compose/init-db.sql` (modified - mirrors DOA tables, indexes, grants)
- `eslint-rules/no-hardcoded-role-in-workflow.js` (new - custom lint rule, AC1)
- `eslint-rules/no-hardcoded-role-in-workflow.d.ts` (new - typed default export for the rule)
- `eslint.config.js` (modified - registers the local rule for `src/**/*.ts`)
- `test/integration/story-1-4.test.ts` (new - all ACs)
- `test/unit/no-hardcoded-role-in-workflow.test.ts` (new - RuleTester cases)
- `package.json` (modified - `test`/`test:integration` run serially via `--test-concurrency=1`)
- `test/integration/story-1-1.test.ts` (modified - `TRUNCATE ... CASCADE` for the new users FK)
- `test/integration/story-1-2.test.ts` (modified - `TRUNCATE ... CASCADE` for the new users FK)
- `test/integration/story-1-3.test.ts` (modified - `TRUNCATE ... CASCADE` for the new users FK)

## Change Log

- 2026-07-18: Implemented Story 1.4 (Enterprise DOA Registry). Delivered the DOA entry/delegation/resolution/override-blocked endpoints, the DOA registry schema with self-sufficient guarded grants, an atomic `persistEvent` transaction-client extension, and the `no-hardcoded-role-in-workflow` ESLint rule (AC1's CI static check). Found and fixed a `DATE` timezone-formatting bug and a pre-existing shared-DB test-parallelism deadlock (serialized the test scripts). Full suite: 64 passing, 0 failing; `tsc --noEmit` and `eslint` clean.
- 2026-07-19: Adversarial code review resolved all three findings. Added database-enforced value-band integrity with concurrent PATCH serialization, closed the template-literal lint bypass, and made resolution tie-breaks strictly deterministic. Full suite: 65 passing, 0 failing; TypeScript and ESLint clean. Story moved to done.
- 2026-07-19: Adversarial re-review resolved two test-coverage findings. Added direct regression tests for concurrent PATCH serialization and all three same-timestamp tie-breakers. Full suite: 67 passing, 0 failing; TypeScript and ESLint clean. Story remains done.
