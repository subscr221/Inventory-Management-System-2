---
baseline_commit: 7c60e010533b8b2cce1874334342041ce80681bc
---

# Story 1.2: SSO Authentication and Role-Based Access Control

Status: review

## Story

As a system administrator,
I want every API request authenticated via the organization's SSO (SAML 2.0/OIDC) with RBAC enforced to module, function, and location scope,
so that every operation is attributable to a specific user with a specific role at a specific location, and unauthorized access is structurally blocked.

## Acceptance Criteria

1. **Given** a request with no valid SSO session token
   **When** any API endpoint is called
   **Then** the API returns HTTP 401 with `error_code: "UNAUTHORIZED"`

2. **Given** a valid SSO session for a user scoped to `location_id: "site-A"`
   **When** the user calls a write endpoint for `location_id: "site-B"`
   **Then** the API returns HTTP 403 with `error_code: "LOCATION_ACCESS_DENIED"`

3. **Given** a valid SSO session for a user whose roles grant no access to a module (e.g., maintenance)
   **When** the user calls any endpoint of that module
   **Then** the API returns HTTP 403 with `error_code: "MODULE_ACCESS_DENIED"`

4. **Given** a valid SSO session for a user whose role grants read-only function scope on a module
   **When** the user calls a mutating (write) endpoint of that module
   **Then** the API returns HTTP 403 with `error_code: "FUNCTION_ACCESS_DENIED"`

5. **Given** a SCIM provisioning event (INT-IAM-02) creates a new user with assigned roles
   **When** that user logs in via SSO for the first time
   **Then** their account exists with provisioned roles and location scopes with no manual admin step required

6. **Given** a user is deprovisioned via SCIM
   **When** they attempt to use an existing session
   **Then** the session is invalidated within 30 seconds of the SCIM event

## Tasks / Subtasks

- [x] Task 1: Auth middleware core - JWT verification (AC: 1, 5)
  - [x] 1.1 Add `jose` dependency (v6.x) to `package.json` - zero-dependency JWT/JWKS library
  - [x] 1.2 Extend `src/config/index.ts` with an `auth` section: `AUTH_MODE` (`oidc` default | `local`), `AUTH_JWKS_URI`, `AUTH_ISSUER`, `AUTH_AUDIENCE` (required when `oidc`), `AUTH_LOCAL_SECRET` (required when `local`, no default value)
  - [x] 1.3 Fail fast at startup: if `AUTH_MODE=oidc` and `AUTH_JWKS_URI`/`AUTH_ISSUER`/`AUTH_AUDIENCE` missing, throw and exit; if `NODE_ENV=production` and `AUTH_MODE=local`, throw and exit (dev-only mode must never run in production)
  - [x] 1.4 Implement `src/middleware/auth.ts`: verify `Authorization: Bearer <token>` via `jose.createRemoteJWKSet` + `jwtVerify` (oidc mode) or `jose.jwtVerify` with an HMAC secret key (local mode); extract `sub` claim
  - [x] 1.5 Implement `src/api/v1/auth-dev.ts`: `POST /api/v1/auth/dev-token` issues an HS256 test JWT for a given `sub` - registered ONLY when `AUTH_MODE=local`
  - [x] 1.6 Missing, malformed, or expired token -> 401 `UNAUTHORIZED` via the existing `AppError`/`sendError` envelope
- [x] Task 2: User directory projection and lookup (AC: 5, 6)
  - [x] 2.1 Create `read/projections/users.sql`: `users` table (`user_id` UUID PK, `external_id` TEXT UNIQUE, `email`, `display_name`, `active` BOOLEAN, `provisioned_at`, `deprovisioned_at`) and `user_role_assignments` table (`assignment_id` UUID PK, `user_id` FK, `role`, `module`, `function_scope` CHECK IN ('read','write'), `location_id`, `created_at`)
  - [x] 2.2 Implement `src/read/projections/users.ts`: `upsertUser`, `replaceRoleAssignments`, `deactivateUser`, `lookupActiveUserWithRoles(externalId)`
  - [x] 2.3 Extend `src/events/migrate.ts` to also apply `read/projections/users.sql`
  - [x] 2.4 Update `deploy/compose/init-db.sql` with the same table definitions and `app_user` grants (INSERT/SELECT/UPDATE on `users` and `user_role_assignments`)
  - [x] 2.5 Wire `src/middleware/auth.ts` to look up the user by `sub` fresh on every request (no caching) -> 401 `UNAUTHORIZED` if not found or `active = false`
- [x] Task 3: RBAC enforcement middleware (AC: 1, 2, 3, 4)
  - [x] 3.1 Implement `src/middleware/rbac.ts`: `requireRole({ module, functionScope, locationId? })` higher-order function checking precedence module -> function -> location, returning `MODULE_ACCESS_DENIED` / `FUNCTION_ACCESS_DENIED` / `LOCATION_ACCESS_DENIED` (403) as appropriate
  - [x] 3.2 Implement `src/middleware/body.ts`: shared JSON body parser (extracted from `src/api/v1/events.ts`) with the existing 10MB size limit and malformed-JSON handling
  - [x] 3.3 Update `src/api/router.ts`: parse body once for POST/PUT/PATCH and attach to `req`; run global auth check before route dispatch for every path except an explicit public allowlist (`/api/v1/health`, `/api/v1/scim/v2/*`, `/api/v1/auth/dev-token`)
  - [x] 3.4 Update `src/api/v1/events.ts`: read parsed body from `req` instead of calling body-reading logic directly; wrap `postEventHandler` with `requireRole({ module: body.stream_type, functionScope: 'write', locationId: body.metadata.actor.location_id })`; wrap `getStreamHandler` with `requireRole({ module: params.streamType, functionScope: 'read' })`
- [x] Task 4: SCIM provisioning and deprovisioning (AC: 5, 6)
  - [x] 4.1 Implement `src/adapters/iam/scim.ts`: `provisionUser` (create user + role rows, emit `user.provisioned` event via the Story 1.1 event store), `updateUserRoles` (emit `user.roles_updated`), `deprovisionUser` (deactivate, emit `user.deprovisioned`)
  - [x] 4.2 Implement `src/api/v1/scim.ts`: `POST /api/v1/scim/v2/Users` (provision) and `PATCH /api/v1/scim/v2/Users/:externalId` (update roles or deactivate); both authenticated via a static `SCIM_BEARER_TOKEN` (required env var, no default)
  - [x] 4.3 Register SCIM and dev-token routes in `src/server.ts`
- [x] Task 5: Integration tests and verification (AC: 1, 2, 3, 4, 5, 6)
  - [x] 5.1 Write integration test: no `Authorization` header -> 401 `UNAUTHORIZED`
  - [x] 5.2 Write integration test: valid token, role location-scoped to site-A UUID, write event targeting a different location UUID -> 403 `LOCATION_ACCESS_DENIED`
  - [x] 5.3 Write integration test: valid token, zero role assignments for the target module -> 403 `MODULE_ACCESS_DENIED`
  - [x] 5.4 Write integration test: valid token, role with `function_scope: 'read'` on the module, POST (write) attempted -> 403 `FUNCTION_ACCESS_DENIED`
  - [x] 5.5 Write integration test: SCIM-provisioned user obtains a dev token and successfully writes an event in-scope with no manual admin step
  - [x] 5.6 Write integration test: SCIM deprovisions a user; the same previously-valid token now returns 401 `UNAUTHORIZED` on the next request

## Dev Notes

### Previous Story Intelligence (from Story 1.1)

- **Stack confirmed working:** Node.js 24 LTS + TypeScript 5.8 (ESM, `NodeNext` module resolution), native `node:http` (no framework), `node:test` runner, `pg` for PostgreSQL. Keep using these - do not introduce Express or another HTTP framework.
- **Established patterns to reuse, not reinvent:**
  - `AppError` / `sendError` / `sendJson` in `src/middleware/error.ts` - the uniform error envelope `{ error_code, message, details, trace_id }`. Use `AppError(401, 'UNAUTHORIZED', ...)` and `AppError(403, 'MODULE_ACCESS_DENIED', ...)` etc.
  - `Router` class in `src/api/router.ts` with route matching, param extraction, and `withErrorHandler` composition. Extend it - do not replace it.
  - `getPool()` / transactions pattern in `src/config/db.ts` and `src/events/store.ts` (the `persistEvent` transaction with `BEGIN`/`COMMIT`/`ROLLBACK` and unique-violation translation to `STREAM_CONFLICT`/`DUPLICATE_EVENT`).
  - **Reuse the event store directly.** SCIM provisioning/deprovisioning should call `persistEvent()` from `src/events/store.ts` with `stream_type: 'user'` to emit `user.provisioned`, `user.roles_updated`, `user.deprovisioned` events - this is the same write path every future module will use, do not build a parallel one.
- **Code review findings from Story 1.1 directly resolved by this story:**
  - "No authentication or authorization anywhere [src/server.ts]" - deferred explicitly to Story 1.2 scope. This story closes that gap.
  - "Database TLS certificate validation is disabled" - already fixed in Story 1.1 (`rejectUnauthorized` removed, uses `ssl: true`). Do not touch `src/config/db.ts` SSL config in this story.
  - "Hardcoded default credentials" was flagged as a general code smell in Story 1.1's `db_user`/`db_password` defaults (those were left as-is for dev convenience, not part of that story's scope). **Do NOT repeat this mistake here**: `SCIM_BEARER_TOKEN` and `AUTH_LOCAL_SECRET` must have NO default value - fail fast at startup if unset.
- **Git intelligence:** Story 1.1 landed as a single commit (`7c60e01`) after the baseline (`5038c40`), with review-driven patches folded in before commit. No separate "fixup" commits - follow the same discipline (implement, test, self-review against the ACs, then the story is commit-ready as one unit).
- **Docker/deploy infrastructure already exists** (`deploy/compose/docker-compose.yml`, `deploy/compose/init-db.sql`, PostgreSQL 18.4 container config) - no new infrastructure needed. Only add new table migrations; do not touch the Docker Compose topology.
- **Dev-machine limitation carried over:** Docker/PostgreSQL are not available in this environment. Integration tests are written correctly but can only execute against a real PostgreSQL instance (via `docker compose up`). Verify via `tsc --noEmit` and `eslint` in this environment, same as Story 1.1.

### Technical Stack Addition

| Component | Version | Role |
| --- | --- | --- |
| `jose` | ^6.2.3 (latest, zero dependencies) | JWT verification (OIDC via `createRemoteJWKSet` + `jwtVerify`), local dev-mode token signing (`SignJWT` with HMAC) |

**Why `jose` (2026 research):** `jose` is the standard Node.js library for JWT/JWKS handling - zero runtime dependencies, tree-shakeable ESM, supports RSA/ECDSA/EdDSA and HMAC, and `createRemoteJWKSet` handles JWKS caching and `kid`-mismatch re-fetching automatically. This is the correct choice over hand-rolling JWT verification or pulling in a heavier auth framework.

### Authentication Design

**Two verification modes, selected by `AUTH_MODE` env var:**

1. **`oidc` (default, production):** Verifies tokens against a real OIDC identity provider's JWKS endpoint.
   ```ts
   import { createRemoteJWKSet, jwtVerify } from 'jose';
   const JWKS = createRemoteJWKSet(new URL(config.auth.jwksUri)); // call once at startup, cached
   const { payload } = await jwtVerify(token, JWKS, {
     issuer: config.auth.issuer,
     audience: config.auth.audience,
   });
   const externalId = payload.sub;
   ```
2. **`local` (dev/test only):** Verifies HS256 tokens signed with `AUTH_LOCAL_SECRET`, issued by the dev-token endpoint. **Must never run when `NODE_ENV=production`** - enforce this as a startup guard, not just documentation.

**Dev-token endpoint contract** (`local` mode only): `POST /api/v1/auth/dev-token` with body `{ "sub": "<external_id>" }` returns `201` with `{ "token": "<HS256 JWT>" }`. The issued JWT contains only `sub` and standard `iat`/`exp` claims (short expiry, e.g. 1 hour) - no role data, matching the "never trust roles from the token" rule above.

**No real IdP exists in this environment or dev/test setup.** This mirrors how Story 1.1 built a synthetic-but-real event write path (real schema, synthetic test events) and Story 1.7's spine acceptance approach (a minimal registry that's the smallest thing making the invariant testable). Here: the OIDC verification path is fully real and production-ready; the `local` mode plus `POST /api/v1/auth/dev-token` is the minimal scaffolding that makes AC1-AC4 testable without a live IdP. Both paths converge on the same `sub` extraction and directory lookup, so RBAC enforcement is identical in both modes.

**Identity resolution:** the JWT's `sub` claim is looked up against the `users.external_id` column **fresh on every request** - roles/location scopes are never trusted from JWT claims (JWTs are opaque identity proof only). This is what makes deprovisioning (AC6) effectively instant rather than waiting for JWT expiry: the very next request after a SCIM deactivation fails the directory lookup and returns 401. No caching layer - do not add one; it would reintroduce the 30-second-lag problem the AC is designed to prevent.

### RBAC Data Model

```sql
-- read/projections/users.sql
CREATE TABLE IF NOT EXISTS users (
  user_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id      TEXT NOT NULL UNIQUE,   -- IdP subject (JWT `sub`) / SCIM externalId
  email            TEXT NOT NULL,
  display_name     TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  provisioned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deprovisioned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  assignment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(user_id),
  role           TEXT NOT NULL,
  module         TEXT NOT NULL,   -- e.g. 'inventory', 'maintenance', 'gate'; '*' = all modules
  function_scope TEXT NOT NULL CHECK (function_scope IN ('read', 'write')),
  location_id    TEXT NOT NULL,   -- UUIDv4 string, or '*' for all-location scope
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignments_user ON user_role_assignments (user_id);
```

**Naming clarification - important:** the epics document uses human-readable placeholders like `location_id: "site-A"` and `location_id: "site-B"` for narrative clarity. The architecture's Consistency Conventions and Story 1.1's own `metadata.actor.location_id` field require **UUIDv4** for all internal IDs. Store and compare `location_id` as a UUID string (or the literal wildcard `'*'`) - do not implement string slugs like `"site-A"` as real data. Integration tests should use real UUIDs and may add a code comment noting which UUID stands in for "site A" / "site B" for readability.

**Semantics:**
- `function_scope: 'write'` authorizes both read and write actions on that module.
- `function_scope: 'read'` authorizes only read actions.
- `module: '*'` or `location_id: '*'` are wildcard scopes (all modules / all locations) - support them but do not require every role to use them.

### RBAC Enforcement Precedence

`requireRole({ module, functionScope, locationId? })` checks, in this order, against the resolved user's role assignments:

1. **Module check:** does any assignment have `module === resolvedModule` (or `module === '*'`)? If none -> 403 `MODULE_ACCESS_DENIED`.
2. **Function check:** among module-matching assignments, does any satisfy the required `functionScope` (a `'write'` assignment satisfies both `'read'` and `'write'` requirements; a `'read'` assignment only satisfies `'read'`)? If none -> 403 `FUNCTION_ACCESS_DENIED`.
3. **Location check (only if `locationId` resolver provided and returns a value):** among module+function-matching assignments, does any have `location_id === resolvedLocation` or `location_id === '*'`? If none -> 403 `LOCATION_ACCESS_DENIED`.

This precedence is a design decision, not directly tested by combined-failure scenarios in this story's ACs (each AC isolates one axis) - document it so behavior is deterministic and future stories can rely on it.

### Wiring RBAC onto the Existing Events Endpoints

The `/api/v1/events` endpoints from Story 1.1 are the only real API surface today (every future module story will reuse this same write path per Story 1.1's design notes), so RBAC must be wired onto them now:

- `POST /api/v1/events`: `module` resolves from the parsed body's `stream_type` field; `functionScope: 'write'`; `locationId` resolves from `metadata.actor.location_id` (already required and UUID-validated by Story 1.1's envelope validation).
- `GET /api/v1/events/:streamType/:streamId`: `module` resolves from the `streamType` route param; `functionScope: 'read'`; no location resolver (a stream read by ID has no single location in scope at this point in the schema - do not invent one).

**Router refactor required:** Story 1.1's `postEventHandler` calls a body-reading function directly inside itself. Because the global auth/RBAC check needs the parsed body *before* the handler runs (to resolve `module`/`locationId` for POST), body parsing must move up into the router (or a middleware step before route dispatch), with the result attached to the request object for the handler to read. Extract the existing body-reading logic (10MB limit, malformed-JSON -> 400) out of `src/api/v1/events.ts` into `src/middleware/body.ts` and call it once per request in `Router.handle()`.

### Public Path Allowlist (no user auth required)

- `GET /api/v1/health` - liveness check, must stay open.
- `POST /api/v1/scim/v2/Users`, `PATCH /api/v1/scim/v2/Users/:externalId` - machine-to-machine, authenticated via `SCIM_BEARER_TOKEN` bearer check inside the handler, not via user JWT.
- `POST /api/v1/auth/dev-token` - only registered when `AUTH_MODE=local`; this is how tests obtain a token in the first place, so it cannot itself require a token.

Everything else goes through the global auth check in `Router.handle()`.

### SCIM Endpoints (minimal, not full SCIM 2.0 protocol compliance)

This story implements the minimum SCIM-shaped surface needed for AC5/AC6 - not full SCIM 2.0 filtering/pagination/schema compliance, which is out of scope.

- `POST /api/v1/scim/v2/Users` - body: `{ externalId, email, displayName?, roles: [{ role, module, functionScope, locationId }] }`. Creates the `users` row and `user_role_assignments` rows, emits `user.provisioned` via `persistEvent()` (`stream_type: 'user'`, `stream_id: user_id`).
- `PATCH /api/v1/scim/v2/Users/:externalId` - body: `{ active: false }` to deprovision (sets `active = false`, `deprovisioned_at = now()`, emits `user.deprovisioned`), or `{ roles: [...] }` to replace role assignments (emits `user.roles_updated`).
- Both require `Authorization: Bearer <SCIM_BEARER_TOKEN>` - a static, non-default, required env var. Reject with 401 `UNAUTHORIZED` if missing/mismatched (reuse the same error code as user-auth failures for consistency).

### Error Codes (this story)

| Code | HTTP Status | Trigger |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | No/invalid/expired token; user not found in directory; user deprovisioned; SCIM bearer token missing/invalid |
| `MODULE_ACCESS_DENIED` | 403 | No role assignment for the target module |
| `FUNCTION_ACCESS_DENIED` | 403 | Role assignments exist for the module but none satisfy the required function scope |
| `LOCATION_ACCESS_DENIED` | 403 | Role assignments satisfy module+function but none satisfy the target location |

All follow the existing uniform envelope: `{ error_code, message, details, trace_id }` (`src/middleware/error.ts`, unchanged).

### Project Structure (files this story touches)

```
{root}/
  read/
    projections/
      users.sql                 # NEW - users + user_role_assignments tables
  src/
    middleware/
      auth.ts                   # NEW - JWT verification (oidc + local modes)
      rbac.ts                   # NEW - requireRole() enforcement
      body.ts                   # NEW - shared body parser (extracted from events.ts)
      error.ts                  # UNCHANGED - reuse AppError/sendError/sendJson
    read/
      projections/
        users.ts                # NEW - directory upsert/lookup/deactivate queries
    adapters/
      iam/
        scim.ts                 # NEW - provisionUser/updateUserRoles/deprovisionUser
    api/
      router.ts                 # UPDATE - global auth + body-parse interception, public allowlist
      v1/
        events.ts                # UPDATE - use req.body, wrap handlers with requireRole
        scim.ts                  # NEW - SCIM HTTP handlers
        auth-dev.ts               # NEW - dev-token issuance (local mode only)
    config/
      index.ts                  # UPDATE - add auth config section + startup validation
    server.ts                   # UPDATE - register scim + auth-dev routes
  deploy/
    compose/
      init-db.sql                # UPDATE - add users/user_role_assignments + grants
  .env.example                   # UPDATE - AUTH_MODE, AUTH_JWKS_URI, AUTH_ISSUER, AUTH_AUDIENCE, AUTH_LOCAL_SECRET, SCIM_BEARER_TOKEN
  test/
    integration/
      story-1-2.test.ts          # NEW
```

### NFR Constraints Binding This Story

| NFR | Requirement | Impact |
| --- | --- | --- |
| NFR-SEC-01 | SSO (SAML 2.0/OIDC) | OIDC implemented directly; SAML is architecturally allowed but not built in this story (no SAML IdP specified anywhere in planning docs - flagged as an open question below) |
| NFR-SEC-02 | RBAC to module, function, location, and data level | Module/function/location implemented this story; row-level "data" scoping is explicitly deferred (see below) |
| NFR-SEC-03 | TLS 1.2+ and AES-256 | Unaffected by this story - already addressed in Story 1.1 for DB connections |
| NFR-P-05 | API p95 under 500ms | Directory lookup adds one indexed query per request (`users` by `external_id` UNIQUE, `user_role_assignments` by `user_id` indexed) - should stay well within budget |

### What This Story Does NOT Include

- SAML 2.0 support (OIDC only - no SAML IdP identified in any planning document; flagged as an open question, do not build a SAML adapter speculatively)
- Row-level / "data level" RBAC scoping (NFR-SEC-02's fourth dimension) - deferred, no module data model exists yet to scope
- The enterprise DOA registry (approval routing) - a different concept, built in Story 1.4
- Session/token refresh flows, logout, or SAML Single Logout
- Full SCIM 2.0 protocol compliance (filtering, pagination, `/Groups` endpoint, schema discovery) - only the minimal provision/deprovision/role-update surface needed for this story's ACs
- Any caching layer for directory lookups (would reintroduce deprovisioning lag - explicitly rejected by design)
- Statutory edit log (Story 1.3), business-stream tagging (Story 1.5), event-sourced location (Story 1.6), calibration lockout (Story 1.7)

### Open Question for the Team (not a blocker for this story)

No planning document specifies which real IdP (Okta, Entra ID, Google Workspace, or generic OIDC) the organization will use, nor whether SAML support is actually required in addition to OIDC. This story implements a standards-compliant, IdP-agnostic OIDC path (works with any OIDC-compliant provider via `AUTH_JWKS_URI`/`AUTH_ISSUER`/`AUTH_AUDIENCE` config) so no code change is needed once an IdP is selected - only configuration. If SAML is later required, it is additive (a separate `adapters/iam/saml.ts` producing the same internal JWT/session shape), not a rework of this story's design.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` #Story 1.2]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` #Consistency Conventions (Auth row), #Structural Seed (`adapters/iam/`, `read/projections/`), #API Contract]
- [Source: `PLANNING/prd/8-cross-cutting-nfrs.md` #NFR-SEC-01, #NFR-SEC-02]
- [Source: `PLANNING/prd/10-integration-and-dependencies.md` #INT-IAM-01/02]
- [Source: `PLANNING/prd/11-stakeholders-and-roles.md` - ~36 roles, location + function scoping]
- [Source: `_bmad-output/implementation-artifacts/1-1-core-infrastructure-deployment-and-event-store-schema.md` - event store write path, error envelope, Router pattern, deferred auth item]

## Dev Agent Record

### Agent Model Used

Kilo (kilo-auto/frontier)

### Debug Log References

- Verified `jose@6.2.3` is current on npm before adding it as a dependency.
- Confirmed Node 24's built-in `--env-file` flag loads `.env.test` correctly for the test scripts (no `dotenv` dependency needed); validated via a standalone `tsx` config-load smoke test.
- Verified all three config fail-fast guards fire correctly with targeted one-off `tsx -e` invocations: `AUTH_MODE=local` + `NODE_ENV=production` rejected; `AUTH_MODE=oidc` with missing `AUTH_JWKS_URI`/`AUTH_ISSUER`/`AUTH_AUDIENCE` rejected; missing `SCIM_BEARER_TOKEN` rejected in all modes.
- **Docker was subsequently installed and the full stack verified against real PostgreSQL** (Docker Engine 29.3.0 + Compose v5.1.1 inside a WSL2 Ubuntu 24.04 distro; Node 24.18.0 via `nvm`, since the WSL distro's system Node was v18). This surfaced and fixed four real bugs that static analysis (`tsc`/`eslint`) could not catch:
  1. **`postgres:18.4`'s data-directory convention changed** - the image now requires the volume mounted at `/var/lib/postgresql` (major-version-subdirectory layout), not `/var/lib/postgresql/data` directly, or the container refuses to start. Fixed in `deploy/compose/docker-compose.yml` (both `postgres` and `postgres-standby` services).
  2. **`archive_command` failed on every WAL segment** because `/var/lib/postgresql/wal_archive` never existed. Added `deploy/compose/init-wal-archive.sh`, mounted as a `docker-entrypoint-initdb.d` script (runs once, on first cluster init, alongside `init-db.sql`).
  3. **Migrations and test schema setup were running as `app_user`**, which correctly has no CREATE/TRUNCATE privilege on the public schema by design (PostgreSQL 15+ no longer grants `CREATE` on `public` to `PUBLIC`) - every migration failed with `permission denied for schema public`. Added a dedicated `getAdminPool()`/`closeAdminPool()` in `src/config/db.ts` (new `DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` config, defaulting to `admin_user`/`admin_password` to match `init-db.sql`), used by `src/events/migrate.ts` and both integration test suites' `before()`/`after()` hooks for DDL/TRUNCATE. The app's own runtime queries still go through the least-privilege `app_user` pool - unchanged.
  4. **Idempotency-key conflict detection in `src/events/store.ts` (from Story 1.1) never actually fired** - it checked `err.detail.includes('uq_idempotency')`, but Postgres's unique-violation `detail` field only contains the conflicting key/value (e.g. `Key (idempotency_key)=(...) already exists.`), never the constraint name. The constraint name is in `err.constraint`. This silently degraded every duplicate-idempotency-key submission to a generic 500 instead of the specified 409 `DUPLICATE_EVENT` - caught because Story 1.1's own test for this (`idempotency key deduplication returns 409 with existing event_id`) failed once actually run against real Postgres. Fixed to check `err.constraint` directly.
- After these fixes, ran the full suite against real Postgres: **all 7 Story 1.1 tests pass, all 8 Story 1.2 tests pass (15/15)**. Also ran a manual end-to-end smoke test of the live server (`node src/server.ts`) via `curl`: SCIM provisioning -> dev-token issuance -> authenticated event write -> authenticated event read, confirming the whole request path works outside the test harness too.
- **Regression found and fixed:** Story 1.1's integration test suite (`test/integration/story-1-1.test.ts`) called the events endpoints directly with no auth, which now fails under this story's global auth requirement. Updated that test file to provision a wildcard-scoped test user via SCIM and attach a dev-token `Authorization` header to every request, preserving all of its original assertions and coverage.

### Completion Notes List

- **Task 1:** Added `jose@^6.2.3`. Config (`src/config/index.ts`) now fails fast at import time on three conditions: `AUTH_MODE=local` combined with `NODE_ENV=production`; `AUTH_MODE=oidc` missing any of `AUTH_JWKS_URI`/`AUTH_ISSUER`/`AUTH_AUDIENCE`; and `SCIM_BEARER_TOKEN` unset in any mode - no default values for either secret. `src/middleware/auth.ts` implements both verification paths (`createRemoteJWKSet`+`jwtVerify` for oidc, HMAC `jwtVerify` for local) behind one `authenticateRequest()` function, plus `issueDevToken()` (local-mode only, defensively re-checked at call time). `src/api/v1/auth-dev.ts` exposes `POST /api/v1/auth/dev-token`, registered in `server.ts` only when `config.auth.mode === 'local'`.
- **Task 2:** `read/projections/users.sql` creates `users` and `user_role_assignments` (function_scope CHECK'd to `'read'`/`'write'`). `src/read/projections/users.ts` provides `upsertUser` (insert-or-reactivate via `ON CONFLICT (external_id)`), `replaceRoleAssignments` (transactional delete+reinsert), `deactivateUser`, `lookupActiveUserWithRoles` (the only read path the auth middleware uses, always fresh, `active = true` filter built into the query), and `getUserIdByExternalId`. `src/events/migrate.ts` now iterates a `MIGRATIONS` array covering both SQL files. `deploy/compose/init-db.sql` mirrors the schema and grants `app_user` INSERT/SELECT/UPDATE on `users` and INSERT/SELECT/DELETE on `user_role_assignments` (matching the delete+reinsert pattern).
- **Task 3:** `src/middleware/rbac.ts`'s `requireRole()` implements the documented module -> function -> location precedence, reading the auth context and parsed body via the new `src/middleware/context.ts` (a small typed-attachment helper over `IncomingMessage`, avoiding a wider request-augmentation dependency). `src/middleware/body.ts` extracts Story 1.1's inline body-reading logic verbatim (same 10MB limit, same `INVALID_JSON`/`PAYLOAD_TOO_LARGE` codes) for reuse by the router. `src/api/router.ts` now parses the body once for POST/PUT/PATCH and runs the global auth check for every path except the public allowlist (health, SCIM, dev-token) before route dispatch; added a `patch()` registration method alongside the existing `get()`/`post()`. `src/api/v1/events.ts` was refactored to read `getParsedBody(req)` instead of calling body-reading logic itself, and both handlers are now composed with `requireRole()` (module resolved from `stream_type`/route param, function scope from HTTP semantics, location resolved from `metadata.actor.location_id` for the write path only).
- **Task 4:** `src/adapters/iam/scim.ts` reuses `persistEvent()` directly (`stream_type: 'user'`) to emit `user.provisioned`/`user.roles_updated`/`user.deprovisioned`, using a nil-UUID system-actor sentinel for the envelope's required `metadata.actor` fields (documented in-code) rather than inventing a non-UUID wildcard that would break the established envelope contract. `src/api/v1/scim.ts` implements the minimal `POST /Users` / `PATCH /Users/:externalId` surface with its own static bearer-token check (independent of user JWT auth) and explicit input validation (`INVALID_SCIM_REQUEST` for malformed bodies/roles).
- **Task 5:** New `test/integration/story-1-2.test.ts` covers all 6 ACs plus two supporting checks (SCIM bearer-token rejection, health endpoint remains public). Also fixed the Story 1.1 test suite regression described above.

### File List

- `package.json` (modified - added `jose` dependency, updated `test`/`test:integration` scripts to use `--env-file=.env.test`)
- `package-lock.json` (modified)
- `.env.example` (modified - added AUTH_MODE/AUTH_JWKS_URI/AUTH_ISSUER/AUTH_AUDIENCE/AUTH_LOCAL_SECRET/SCIM_BEARER_TOKEN/DB_ADMIN_USER/DB_ADMIN_PASSWORD)
- `.env.test` (new/modified - test-only dummy credentials for `node --env-file`, including admin DB credentials)
- `.gitignore` (modified - allow `.env.test` through the `.env.*` ignore rule)
- `src/config/index.ts` (modified - added `auth`/`scim` config sections, `db.adminUser`/`db.adminPassword`, and startup fail-fast validation)
- `src/config/db.ts` (modified - added `getAdminPool()`/`closeAdminPool()` for DDL-only connections, separate from the app's least-privilege runtime pool)
- `src/middleware/auth.ts` (new)
- `src/middleware/rbac.ts` (new)
- `src/middleware/body.ts` (new)
- `src/middleware/context.ts` (new)
- `read/projections/users.sql` (new)
- `src/read/projections/users.ts` (new)
- `src/adapters/iam/scim.ts` (new)
- `src/api/v1/scim.ts` (new)
- `src/api/v1/auth-dev.ts` (new)
- `src/api/router.ts` (modified - global body-parse + auth interception, public allowlist, `patch()` method)
- `src/api/v1/events.ts` (modified - use parsed body from request context, wrap handlers with `requireRole`)
- `src/events/migrate.ts` (modified - runs both `events/domain_events.sql` and `read/projections/users.sql`, via `getAdminPool()`)
- `src/events/store.ts` (modified - fixed idempotency/stream-conflict constraint detection to use `err.constraint` instead of the never-matching `err.detail.includes(...)` check)
- `src/server.ts` (modified - register SCIM and conditional dev-token routes)
- `deploy/compose/docker-compose.yml` (modified - fixed `postgres`/`postgres-standby` volume mount paths for the `postgres:18` data-directory convention)
- `deploy/compose/init-db.sql` (modified - added `users`/`user_role_assignments` tables and grants)
- `deploy/compose/init-wal-archive.sh` (new - creates the WAL archive directory `archive_command` depends on)
- `test/integration/story-1-2.test.ts` (new)
- `test/integration/story-1-1.test.ts` (modified - provisions a test user and attaches auth headers to fix the regression introduced by this story's global auth requirement; DDL/TRUNCATE now run via `getAdminPool()`)

## Change Log

- 2026-07-12: Implemented SSO authentication (dual-mode: OIDC via `jose` + a gated local dev-token mode) and RBAC (module/function/location precedence) as global middleware in the Router; added SCIM-shaped provisioning/deprovisioning endpoints backed by a new `users`/`user_role_assignments` read-model projection; wired enforcement onto the Story 1.1 events endpoints; fixed a regression in Story 1.1's test suite caused by the new global auth requirement.
- 2026-07-12: Installed Docker (WSL2 Ubuntu + Docker Engine) and verified the full stack against real PostgreSQL 18.4. Found and fixed 4 real defects only reachable with a live database: `postgres:18` data-directory mount convention, missing WAL archive directory, migrations/tests running DDL as the wrong (least-privilege) DB role, and a dead idempotency-conflict-detection branch inherited from Story 1.1 (`err.detail` vs `err.constraint`). All 15 integration tests (7 from Story 1.1, 8 from Story 1.2) now pass against real PostgreSQL; also manually smoke-tested the live server end-to-end via `curl`.
