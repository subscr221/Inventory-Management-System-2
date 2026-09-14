---
baseline_commit: 5c5a0cd28a712cfc44fb5ef10118b8ce59e43c99
---

# Story 1.12: Edge UI Sign-In Through Keycloak (PKCE)

Status: in-progress

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a warehouse worker, technician, gate guard or migration lead,
I want to sign in to the edge UI with my own Keycloak account and stay signed in across the shift,
so that every screen I use presents my identity to the API and my actions are attributed to me.

## Acceptance Criteria

1. **Given** an unauthenticated browser opens the edge UI (NFR-SEC-01) **When** any screen loads **Then** the user is redirected to Keycloak's login page for the `ims` realm using the authorization code flow with PKCE (client `ims-app`, no client secret), and returns to the screen they asked for.
2. **Given** a signed-in user (Story 1.2) **When** the UI calls any `/api/v1/...` endpoint, including PowerSync credentials and edge sync uploads **Then** the request carries `Authorization: Bearer <access token>` whose `aud` is `ims-app` and whose email claim names the user's directory record, so `src/middleware/auth.ts` resolves the same role assignments the SCIM seam provisioned.
3. **Given** an access token about to expire (15 minutes, realm setting) **When** the user keeps working, online or after reconnecting **Then** the token is refreshed silently with the refresh token; a refresh that fails sends the user back to the login page with their unsent captures preserved in the outbox.
4. **Given** a signed-in user on a shared tablet **When** they sign out **Then** the Keycloak session ends (front-channel logout), tokens are cleared from the device, and the next user must sign in as themselves.
5. **Given** a device that is offline (FR-M-17, Story 7.8) **When** the UI starts with a still-valid token cached **Then** capture continues offline and the token is used when the sync connector reconnects; no login is demanded until the token is actually rejected.

## Tasks / Subtasks

- [x] Task 1: Runtime auth configuration for the edge container (AC: 1, 5)
  - [x] 1.1 Add `edge/app/auth/config/route.ts` (App Router route handler, `export const dynamic = 'force-dynamic'`) that reads `process.env` at request time and returns `{ mode: 'oidc', authority, client_id }` or `{ mode: 'local', dev_subject }`. Env names: `EDGE_AUTH_MODE` (`oidc` | `local`, default `local`), `EDGE_OIDC_AUTHORITY`, `EDGE_OIDC_CLIENT_ID`, `EDGE_DEV_SUBJECT`. In `oidc` mode the handler returns 500 when authority or client id is missing (fail closed, same posture as `src/config/index.ts` lines 210 to 217).
  - [x] 1.2 Add `edge/src/session/auth-config.ts`: `loadAuthConfig()` fetches the route, caches the result in `localStorage['inventory-edge-auth-config']`, and falls back to the cached copy when the fetch fails (offline start, AC5). Pure function `parseAuthConfig(json)` for unit tests.
  - [x] 1.3 `deploy/compose/docker-compose.yml` edge service: add `EDGE_AUTH_MODE: oidc`, `EDGE_OIDC_AUTHORITY: https://auth.${PUBLIC_DOMAIN}/realms/ims`, `EDGE_OIDC_CLIENT_ID: ims-app` using the `${VAR:?}` fail-closed form already used by the app service (lines 29 to 38). `.env.example`: document the four `EDGE_*` variables next to the existing staging OIDC block (lines 116 to 120). Never use `NEXT_PUBLIC_*`: the edge image is built once in CI and promoted by digest (`.github/workflows/cd.yml`), so build-time values would bake the staging authority into the production image.
- [x] Task 2: Session module on top of `oidc-client-ts` (AC: 1, 3, 4, 5)
  - [x] 2.1 `npm install oidc-client-ts@3.5.0 --workspace edge` (single root `package-lock.json`; commit both files). No `react-oidc-context`: the shell has one client component and the session must also be reachable from the non-React connector.
  - [x] 2.2 `edge/src/session/session.ts`: a thin wrapper around `UserManager` exposing `ensureSignedIn(returnTo)`, `getAccessToken()`, `handleCallback()`, `signOut()`, `onAuthLost(cb)`. Settings: `authority`, `client_id`, `redirect_uri = ${origin}/auth/callback`, `post_logout_redirect_uri = ${origin}/`, `response_type: 'code'`, `scope: 'openid profile email'`, `automaticSilentRenew: true`, `monitorSession: false`, `userStore` and `stateStore` both `new WebStorageStateStore({ store: window.localStorage })`, `revokeTokensOnSignout: false`, no `silent_redirect_uri`. Do not request `offline_access`.
  - [x] 2.3 Accept an injectable manager interface (`{ getUser, signinRedirect, signinCallback, signinSilent, signoutRedirect, removeUser, events }`) so unit tests run under `node:test` without a DOM. Construct the real `UserManager` only inside a browser guard (`typeof window !== 'undefined'`), mirroring `edge/src/local-db/database.ts` lines 5 to 7.
  - [x] 2.4 Start rules (`ensureSignedIn`): `local` mode obtains a token from `POST /api/v1/auth/dev-token` with `{ sub: dev_subject }` when a subject is configured, otherwise runs with no token (keeps `edge/test/e2e/offline-shell.spec.ts` and the axe spec green with no API). `oidc` mode: cached user present, access token unexpired: proceed. Cached user present, expired, online: `signinSilent()` once, on failure `signinRedirect`. Cached user present, expired, offline: proceed with the cached user and do not redirect (AC5). No cached user, online: `signinRedirect({ state: returnTo })`. No cached user, offline: render `auth.offlineNoSession` (no redirect possible).
  - [x] 2.5 Silent renew never uses an iframe: the edge app sends `X-Frame-Options: DENY` (`edge/next.config.ts` line 13) and Keycloak 26 frames its own pages with the same header. With a refresh token present, `oidc-client-ts` 3.x renews through the token endpoint; subscribe to `events.addSilentRenewError` and `events.addUserSignedOut` and route both to `onAuthLost`. Amended by code review decision 2 (2026-09-13): only `addUserSignedOut` is routed; a background silent-renew failure is not an auth loss (AC5), and a 401 that survives one refresh is the only redirect trigger.
  - [x] 2.6 `signOut()`: refuse (return `{ blocked: 'unsettled_outbox', count }`) while any `edge_outbox` row has `local_status IN ('pending_sync', 'auth_required')`; otherwise delete `cached_user_context` rows, call `removeUser()`, then `signoutRedirect()` (the library sends `id_token_hint`, which Keycloak requires to end the session without a confirmation prompt). Leave `cached_site_context`, worklist caches and settled outbox rows in place.
- [x] Task 3: Bearer on every API call (AC: 2)
  - [x] 3.1 `edge/src/session/api-fetch.ts`: `authorizedFetch(input, init)` resolves the global `fetch` at call time (existing tests mock `globalThis.fetch` with `t.mock.method`), adds `Authorization: Bearer <token>` when `getAccessToken()` returns one, and on a 401 with a token present performs one `signinSilent()` and retries once; a second 401 fires `onAuthLost`. No token: send the request unchanged (local mode without subject, e2e).
  - [x] 3.2 Replace all five call sites with `authorizedFetch`: `edge/src/sync/connector.ts` lines 390 and 438, `edge/src/components/edge-client.tsx` lines 238 and 316, `edge/src/sync/worklist-refresh.ts` line 11. Keep every URL, method, header and body byte-identical otherwise. `credentials: 'include'` may stay (no cookie is ever read server-side; `src/middleware/auth.ts` line 49 accepts the header only).
  - [x] 3.3 After a successful sign-in or callback, reset rows parked by an earlier 401: add `resetAuthRequired(db)` in `edge/src/local-db/outbox.ts` (`UPDATE edge_outbox SET local_status = 'pending_sync' WHERE local_status = 'auth_required'`) and call it before `db.connect(...)`. Without this `uploadData` keeps returning early at `connector.ts` line 406 forever.
- [x] Task 4: Shell integration (AC: 1, 3, 4)
  - [x] 4.1 `edge/app/auth/callback/page.tsx` (client component): `handleCallback()` then `router.replace(state.returnTo ?? '/')`; on error render `auth.callbackFailed` with a retry link to `/`. Do not add this path to the precached shell list in `edge/public/sw.js` (line 1 to 3).
  - [x] 4.2 `edge/src/components/edge-client.tsx` startup (lines 212 to 295): call `ensureSignedIn(location.pathname + location.search)` after `db.init()` and `readCachedContext` and before the bootstrap fetch, so an offline start with cached context never blocks on auth. Wire `onAuthLost` to: set `authRequired` state, and when `navigator.onLine`, `signinRedirect` with the current path. Offline: only show `sync.authRequired`; the outbox keeps accepting captures.
  - [x] 4.3 `edge/src/components/app-shell.tsx` header (lines 98 to 106): add a sign-out button (44 by 44 px minimum, text label `auth.signOut`) next to `SyncStatusBadge`; when `signOut()` is blocked show `auth.signOutBlocked` interpolated with the count and, if online, trigger a drain (`db.connect` is already live; call `refreshLocalState`) before re-enabling. Prop name `onSignOut`.
  - [x] 4.4 Messages: add `auth.signOut`, `auth.signOutBlocked`, `auth.signingIn`, `auth.callbackFailed`, `auth.offlineNoSession` to `edge/src/messages/en.json`; add `/^auth\./` and any new class or id literals to `ALLOWED_LITERAL_PATTERNS` in `edge/test/unit/i18n-literals.test.ts`.
- [x] Task 5: Keycloak and deployment follow-through (AC: 1, 4)
  - [x] 5.1 Verify, do not change: `deploy/keycloak/realm-ims.json` `ims-app` already has `publicClient: true`, `standardFlowEnabled: true`, `directAccessGrantsEnabled: false`, `frontchannelLogout: true`, `redirectUris: ["https://ims-staging.ancorlabs.org/*"]`, `webOrigins: ["https://ims-staging.ancorlabs.org"]`, `pkce.code.challenge.method: S256`, `post.logout.redirect.uris`, and the `ims-app` audience mapper. `/auth/callback` is covered by the wildcard. Record the verification in Completion Notes. If any value must change, remember realm import runs with IGNORE_EXISTING so the live realm only changes through kcadm (pattern: `deploy/provision/keycloak-add-cli-client.sh`).
  - [x] 5.2 Add `deploy/provision/keycloak-remove-cli-client.sh` (kcadm delete of `ims-cli`, same login pattern as the add script) and delete `deploy/keycloak/client-ims-cli.json` plus `deploy/provision/keycloak-add-cli-client.sh` and `deploy/provision/ims-token.sh` from the repo. Do not run the removal against the live realm in this story: the rehearsal scripts still depend on `ims-cli` until the operator confirms UI sign-in on staging. Update `docs/migration/pilot-cutover-runbook.md` line 118 and the section 2 account steps: operators sign in through the UI; `ims-cli` removal becomes an explicit runbook step after UI sign-in is verified.
  - [x] 5.3 Update `_bmad-output/implementation-artifacts/sprint-status.yaml` line 909 comment once done (remove the interim ims-cli note).
- [x] Task 6: Tests and gates (AC: all)
  - [x] 6.1 New `edge/test/unit/session.test.ts` using a fake manager: each start rule in 2.4 (six cases), silent renew error routes to `onAuthLost`, `signOut` blocked with unsettled rows, `signOut` clears `cached_user_context` then redirects, callback returns `returnTo`.
  - [x] 6.2 New `edge/test/unit/api-fetch.test.ts`: header added when a token exists, no header without a token, 401 then refresh then retry succeeds, 401 twice fires `onAuthLost`, non-401 errors pass through unchanged.
  - [x] 6.3 Extend `edge/test/unit/connector.test.ts`: with a token provider set, both `fetchCredentials` and `uploadData` send `Authorization: Bearer`; all existing cases unchanged. Extend `edge/test/unit/outbox.test.ts` for `resetAuthRequired` and the unsettled-row count.
  - [x] 6.4 `edge/test/unit/auth-config.test.ts`: `parseAuthConfig` rejects `oidc` without authority or client id, accepts `local` without subject.
  - [x] 6.5 Gates: `npm run edge:typecheck`, `edge:lint`, `edge:build`, `edge:test`, `edge:test:e2e`, `edge:accessibility` (the two Playwright specs run with no env and must stay unchanged and green), then root `npm test` to prove zero server impact (no route added, so `test/integration/story-1-9.test.ts` route allowlist is untouched). `git diff --check`.
  - [ ] 6.6 Staging verification checklist (manual, record results in Completion Notes): open `https://ims-staging.ancorlabs.org/maintenance` unauthenticated, land on Keycloak, sign in as a CMF-ALIGARH account that has changed its temporary password, return to `/maintenance`; confirm `/api/v1/edge/bootstrap` returns 200 with a bearer in DevTools; leave the tab 16 minutes and confirm a silent token refresh with no redirect; toggle airplane mode, capture, reconnect, confirm upload; sign out and confirm the next load demands login.

### Review Findings

Code review 2026-09-13 (Blind Hunter, Edge Case Hunter, Acceptance Auditor). 4 decision-needed, 16 patch, 2 defer, 7 dismissed (duplicates across layers merged). Decisions resolved by the user after a round table (1:3, 2:1, 3:1, 4:2) and applied with every patch the same day.

- [x] [Review][Decision] Parked captures re-queue under whoever signs in next (high) - resolved option 3: rows upload only under their owner's session. The connector parks another person's rows `auth_required` and completes their queue entry so the signed-in user's captures flow; `resetAuthRequired(db, owner)` re-queues (delete and re-insert, a fresh PUT) only the owner's rows, after bootstrap confirms who signed in; the sign-out gate counts only the signed-in user's rows; the shell names whose captures are waiting (display names remembered per device).
- [x] [Review][Decision] Silent-renew error forces a login redirect before any API rejection (medium) - resolved option 1: a background renew failure is not an auth loss (AC5 outranks Task 2.5, which is amended below); only a 401 that survives one refresh redirects.
- [x] [Review][Decision] `ims-cli` still imported by `realm-ims.json` on first boot (medium) - resolved option 1: removed from the realm import; `keycloak-add-cli-client.sh` adds it for the provisioning window only.
- [x] [Review][Decision] Runbook 2.10 needs a migration-lead token but `ims-token.sh` is deleted (medium) - resolved option 2: 2.10 is now the browser sign-in check, 2.10a runs the reconciliation call from the signed-in tab and checks sign-out, 2.10b removes `ims-cli`.
- [x] [Review][Patch] Sign-out removes the user before `signoutRedirect`, so Keycloak gets no `id_token_hint` [edge/src/session/session.ts:177]
- [x] [Review][Patch] `signoutRedirect` rejection is unhandled after identity was already cleared [edge/src/session/session.ts:178]
- [x] [Review][Patch] Compose makes `EDGE_OIDC_AUTHORITY` and `EDGE_OIDC_CLIENT_ID` required, breaking the staging `.env` [deploy/compose/docker-compose.yml:69]
- [x] [Review][Patch] `UserManager` never disposed on unmount; no `cancelled` check after `ensureSignedIn` [edge/src/components/edge-client.tsx:277-296]
- [x] [Review][Patch] `authRequired` from `onAuthLost` overwritten by `refreshLocalState`; offline auth loss never redirects when back online [edge/src/components/edge-client.tsx:179,240,350]
- [x] [Review][Patch] Non-config sign-in errors swallowed; app runs unauthenticated with no banner [edge/src/components/edge-client.tsx:297-302]
- [x] [Review][Patch] `keycloak-remove-cli-client.sh` false "already absent", exit 0 on delete failure, password interpolated into `sh -c`, silent parse failure, kcadm config path [deploy/provision/keycloak-remove-cli-client.sh:13-27]
- [x] [Review][Patch] Local-mode sign-out leaves the user and the Sign out button on screen [edge/src/components/edge-client.tsx:389]
- [x] [Review][Patch] Sign out button has no pending state; capture possible between count and clear; `signOutAvailable` never updates [edge/src/components/app-shell.tsx:162]
- [x] [Review][Patch] `authorizedFetch` retries with no bearer when the refreshed token is null; a `Request` body cannot be replayed [edge/src/session/api-fetch.ts:26-27]
- [x] [Review][Patch] `localStorage.setItem` throwing discards a valid server config [edge/src/session/auth-config.ts:102]
- [x] [Review][Patch] `safeReturnPath` accepts `/auth/callback/` and `/auth/callback#x` [edge/src/session/session.ts:81]
- [x] [Review][Patch] Callback page redeems the code twice under dev StrictMode [edge/app/auth/callback/page.tsx:18-30]
- [x] [Review][Patch] `oidc-client-ts` pinned as `^3.5.0`; Task 2.1 requires exact `3.5.0` [edge/package.json:33]
- [x] [Review][Patch] Task 6.6 ticked but not executed; now unticked until run on the box [_bmad-output/implementation-artifacts/1-12-edge-ui-sign-in-through-keycloak-pkce.md:57]
- [x] [Review][Patch] Sprint-status comment still carries the ims-cli note; i18n allowlist `/^auth-/` too broad; blocked sign-out copy has no singular form [_bmad-output/implementation-artifacts/sprint-status.yaml:909]
- [x] [Review][Defer] Closure codes now ordered alphabetically instead of server order after the necessary `rowid` fix [edge/src/local-db/worklist.ts:229] - deferred, needs an explicit position column
- [x] [Review][Defer] Blocked sign-out drain relies on a PowerSync connection that never opens after an offline start until reload [edge/src/components/edge-client.tsx:327] - deferred, pre-existing (Story 7.8 online handler never connects)

## Dev Notes

### Why this story exists

Story 1.2 shipped the server half of SSO: `src/middleware/auth.ts` verifies a bearer JWT (jose `createRemoteJWKSet` plus `jwtVerify`, issuer and audience pinned, algorithms allow-listed, 30 s clock tolerance) and resolves roles from `users.external_id` on every request. The browser never obtained a token because development ran with `AUTH_MODE=local` and the edge UI was wired with `credentials: 'include'` and no `Authorization` header. On staging (`AUTH_MODE=oidc`) every edge call returns 401 `UNAUTHORIZED`. Operators currently take tokens with `deploy/provision/ims-token.sh` through the rehearsal-only `ims-cli` client; that client is removed once this story is verified.

### Current state of files this story modifies

Table 1 lists the edge files touched and what must be preserved in each.

| File | Today | Change | Preserve |
|------|-------|--------|----------|
| `edge/src/sync/connector.ts` | `EdgePowerSyncConnector(apiBaseUrl = '')`; `fetchCredentials` GETs `/api/v1/edge/powersync-credentials` and returns `{ endpoint, token }`; `uploadData` POSTs `/api/v1/edge/events`, classifies failures, halts on `auth_required` (lines 386 to 459) | Both fetches go through `authorizedFetch` | Constructor default arg (tests construct with none), in-sequence replay (Story 7.8), `classifyServerUploadFailure`, halt semantics, permanent error parity with `src/sync/upload.ts` |
| `edge/src/components/edge-client.tsx` | Startup: `createEdgeDatabase`, `db.init`, `readCachedContext`, worklist cache, bootstrap fetch, `cacheContext`, `db.connect(new EdgePowerSyncConnector())`, `db.watch` on `edge_outbox` (lines 212 to 295); `deviceId()` in `localStorage` (lines 104 to 111) | Insert `ensureSignedIn` before bootstrap; wire `onAuthLost`; pass `onSignOut` | Offline-first ordering: cached context renders before any network; `firstSyncRequired` only when no cache; `db.disconnect()` on cleanup |
| `edge/src/components/app-shell.tsx` | Header renders title, `userName · siteName`, `SyncStatusBadge`; `authRequired` renders `sync.authRequired` alert (lines 98 to 122) | Add sign-out button and blocked message | All existing props and the `role="alert"` pattern |
| `edge/src/sync/worklist-refresh.ts` | `refreshWorklist(apiBaseUrl = '')` GETs the worklist, never on a timer (Story 7.8 Decision 11) | Use `authorizedFetch` | Failure leaves cached snapshot in place |
| `edge/src/local-db/outbox.ts` | `insertCaptureEvent`, `readOutboxCounts`, `hasAuthRequired`, `hasUpstreamStreamConflict`, `cacheContext` (deletes and re-inserts context rows) | Add `resetAuthRequired`, `countUnsettled`, `clearCachedUserContext` | Nothing ever deletes `edge_outbox` rows |
| `edge/public/sw.js` | Precaches `/`, manifest, icon; navigation network-first with cached `/` fallback; GET same-origin only | None required | Do not precache `/auth/callback`; cross-origin Keycloak redirects are already ignored |
| `edge/test/unit/i18n-literals.test.ts` | Allow-list of literal prefixes; no user-facing literal outside `en.json` | Add `auth.` prefix and new class names | Test intent |

### Identity and attribution: why sign-out is gated

`src/api/v1/edge.ts` line 444 pins `body.metadata.actor.user_id = authContext.userId` on every upload; the device-stamped actor is never trusted. On a shared tablet, rows captured by user A and still `pending_sync` when user B signs in would upload under B's token and be attributed to B. That breaks AC1 of Story 1.2 and the runbook rule that audit must name a person (`docs/migration/pilot-cutover-runbook.md` lines 39 to 49). Therefore `signOut()` refuses while unsettled rows exist, the button shows the count, and an online device drains first. Offline sign-out with unsent captures is not possible by design; the message tells the user to reconnect. Rows in `needs_attention` or `synced` are settled and never block.

### Token storage and offline start

`oidc-client-ts` defaults to `sessionStorage`, which is cleared when an installed PWA is closed and is not reliably shared across the external login redirect on some Android launchers. Use `localStorage` for both `userStore` and `stateStore` (the PKCE verifier lives in the state store during the redirect). Trade-off accepted: tokens in `localStorage` are readable by same-origin script; the edge page serves only first-party bundles, no CSP change is in scope. The user record key is `oidc.user:<authority>:<client_id>`, which is why the auth config must also be cached locally: without the authority string the session module cannot find the cached user offline.

### Refresh behaviour against the realm

`deploy/keycloak/realm-ims.json`: `accessTokenLifespan: 900` (15 min), `ssoSessionIdleTimeout: 28800` (8 h), `ssoSessionMaxLifespan: 43200` (12 h). Keycloak issues refresh tokens to public clients by default; the refresh token stays valid while the SSO session is idle less than 8 h, so a shift survives without re-login and the hard 12 h cap forces a fresh login the next day. Do not add `offline_access`: offline tokens bypass the idle timeout and defeat the shared-tablet model. Token and refresh requests from `https://ims-staging.ancorlabs.org` to `https://auth.ancorlabs.org` are cross-origin XHR; Keycloak answers CORS from the client's `webOrigins`, already set. The API itself is same-origin (`nginx.conf.template` lines 51 to 97 route `/api/`, `/powersync/` and `/` under one vhost), so no CORS work on the app.

### Server contract the browser must satisfy

- Header only: `Authorization: Bearer <token>`, case-insensitive scheme (`src/middleware/auth.ts` line 49). No cookie path exists.
- Claims: `iss = https://auth.ancorlabs.org/realms/ims`, `aud` contains `ims-app` (audience mapper), `email` present (staging sets `AUTH_SUBJECT_CLAIM=email`, lowercased at `auth.ts` line 72, matched against `users.external_id`). The `email` client scope supplies the claim in the access token.
- Errors: `{ error_code, message, details, trace_id }` (`src/middleware/error.ts`). 401 is always `UNAUTHORIZED`; 403 codes (`MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `EDGE_NO_CONCRETE_SITE`) are authorization failures and must not trigger a login redirect; `classifyServerUploadFailure` already treats business codes before bare status.
- PowerSync: `/api/v1/edge/powersync-credentials` mints a separate HS256 PowerSync token (TTL `POWERSYNC_TOKEN_TTL`, default 15 min); the SDK calls `fetchCredentials` again when it expires, so the Keycloak token must be current at that moment, which the silent renew guarantees while online.
- Local mode: `POST /api/v1/auth/dev-token { sub }` returns `{ token }` (HS256, 1 h, registered only when `AUTH_MODE=local`, refused unless `NODE_ENV` is development or test).

### Architecture compliance

- ARCHITECTURE-SPINE: "SSO-gated (SAML 2.0/OIDC); every request authenticated" (line 334); edge is a PWA with offline-first write path (line 26). Auth is a client concern of `edge/`; no new server route, container, queue or sync rule.
- Story 1.2 design: IdP-agnostic, config-only switch; no token caching layer on the server. This story adds none.
- Story 7.8 guardrails carried forward: the connector is the only uploader; no timers; no Playwright spec changes; every user-facing string through `t()`.
- UX DESIGN.md line 406: never force login on every app open; persist the session across restarts (hence `localStorage`). Sign-out button meets the 44 px touch target rule and pairs text with state.

### Library and framework requirements

Table 2 pins the versions the implementation must use.

| Package | Version | Note |
|---------|---------|------|
| `oidc-client-ts` | 3.5.0 (npm latest 2026-09-13) | New dependency in `edge/package.json`; PKCE S256 is automatic for `response_type: 'code'`; refresh-token silent renew in 3.x needs no iframe |
| `@powersync/web` | keep `^1.39.0` | Do not upgrade to 2.x in this story |
| `next` | keep `^16.2.10` | App Router; route handler with `dynamic = 'force-dynamic'` reads env per request in `output: 'standalone'` |
| Keycloak | 26.3 (compose image) | `frontchannelLogout: true` already on `ims-app`; logout endpoint requires `id_token_hint` or `client_id` to skip the confirmation page |

### File structure requirements

- New: `edge/src/session/auth-config.ts`, `edge/src/session/session.ts`, `edge/src/session/api-fetch.ts` (the `edge/src/session/` directory already exists, empty, from Story 1.8 scaffolding), `edge/app/auth/config/route.ts`, `edge/app/auth/callback/page.tsx`, `deploy/provision/keycloak-remove-cli-client.sh`, four test files under `edge/test/unit/`.
- Modified: the six files in Table 1, `edge/src/messages/en.json`, `edge/package.json`, root `package-lock.json`, `deploy/compose/docker-compose.yml`, `.env.example`, `docs/migration/pilot-cutover-runbook.md`, `sprint-status.yaml`.
- Deleted: `deploy/keycloak/client-ims-cli.json`, `deploy/provision/keycloak-add-cli-client.sh`, `deploy/provision/ims-token.sh`.
- tsconfig is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; optional props must be omitted, not set to `undefined`.

### Testing requirements

- Edge runner is `node --import tsx --test test/unit/*.test.ts` (`node:test`, `node:assert/strict`), no DOM, no vitest. Mock `fetch` with `t.mock.method(globalThis, 'fetch', ...)` as `connector.test.ts` line 233 does. Stub `localStorage` with a `Map`-backed object on `globalThis` only inside the test that needs it, and restore it.
- Do not import `oidc-client-ts` in unit tests; test the wrapper through the injected fake manager.
- CI job `edge-quality` (typecheck, lint, build, test) and `edge-accessibility` (axe plus e2e) must both pass; job names are load-bearing for branch protection.
- Root `npm test` runs against PostgreSQL on port 5442 (`.env.test`); run it to prove the server is untouched.

### Anti-patterns to avoid

- Do not implement PKCE, state, or token parsing by hand; use the library.
- Do not use the implicit flow, a client secret, `offline_access`, iframe silent renew, or `check_session_iframe`.
- Do not read tokens on the server, add a cookie session, or add a server route for auth config; the edge container owns its runtime config.
- Do not clear `edge_outbox` or the OPFS database on sign-out or on auth loss.
- Do not redirect to Keycloak while `navigator.onLine` is false.
- Do not bake `NEXT_PUBLIC_*` values; the image is promoted between environments.
- Do not change `deploy/keycloak/realm-ims.json` expecting the live realm to follow; it will not.

### Previous story intelligence (Story 1.11, Epic 1)

- Every gate was run for both workspaces even when only one was touched; do the same and list the counts.
- A latent harness bug surfaced in an unrelated test (`TRUNCATE` without `CASCADE`); when an existing test breaks, fix the harness convention, do not weaken the assertion.
- The route allow-list test in `test/integration/story-1-9.test.ts` asserts the exact production route surface; this story adds no server route, so it must stay green unmodified.
- Optional secrets were made non-fail-closed deliberately (VAPID); here the opposite applies: `EDGE_AUTH_MODE=oidc` with missing authority fails closed.

### Git intelligence

Commit `5c5a0cd` (2026-09-13) added the staging deployment: compose Keycloak service, `realm-ims.json`, `ims-cli` client and scripts, the `AUTH_SUBJECT_CLAIM` knob with `test/unit/auth-subject-claim.test.ts`, and the runbook rewrite. Follow its conventions: LF line endings for scripts (`.gitattributes`), kcadm for live realm changes, `${VAR:?}` for required compose env, and runbook steps numbered within section 2.

### Project context reference

`_bmad-output/project-context.md` has no populated rules yet; the binding conventions are those above plus `FORMATTING_RULES.md` for any Markdown edited (runbook, this file).

### References

- Story text: `_bmad-output/planning-artifacts/epics.md` lines 351 to 380
- Server auth: `src/middleware/auth.ts`, `src/config/index.ts` lines 9 to 48 and 203 to 235, `src/middleware/error.ts`
- Edge endpoints: `src/api/v1/edge.ts` lines 259 to 365 and 444; routes in `src/server.ts` lines 1343 to 1347
- Edge code: `edge/src/sync/connector.ts`, `edge/src/components/edge-client.tsx`, `edge/src/components/app-shell.tsx`, `edge/src/local-db/outbox.ts`, `edge/src/local-db/database.ts`, `edge/public/sw.js`, `edge/next.config.ts`
- Keycloak and deploy: `deploy/keycloak/realm-ims.json`, `deploy/compose/docker-compose.yml` lines 29 to 70 and 220 to 250, `deploy/compose/nginx.conf.template`, `deploy/provision/keycloak-add-cli-client.sh`, `deploy/provision/ims-token.sh`
- Runbook: `docs/migration/pilot-cutover-runbook.md` lines 39 to 49 and 118
- Prior stories: `1-2-sso-authentication-and-role-based-access-control.md` (Authentication Design, lines 99 to 119), `7-8-offline-technician-workflow-and-closure-codes.md` (offline contract and guardrails), `1-8-offline-edge-pwa-shell-and-powersync-sync-layer.md`, `1-11-notification-and-alerting-foundation.md`
- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` lines 26, 186, 334
- UX: `ux-designs/ux-Inventory Management System_2-2026-07-12/DESIGN.md` line 406

## Dev Agent Record

### Agent Model Used

claude-fable-5-1

### Debug Log References

- `npm run edge:typecheck`, `edge:lint`: clean.
- `npm run edge:test`: 86/86 (45 pre-existing plus 41 new: `auth-config` 12, `session` 18, `api-fetch` 7, `outbox` 3, `connector` 1).
- `npm run edge:build`: clean (standalone output; the new `/auth/config` route handler and `/auth/callback` page are included).
- `npm run edge:accessibility`: 5/5.
- `npm run edge:test:e2e`: 4/6. The two failures (`keyboard navigation reaches role navigation and capture action`, `known cross-dock task capture displays context and scan-first pending result`) reproduce identically on the baseline commit `5c5a0cd` with only the `rowid` fix below applied (stash, fix, run, restore), so they predate this story: the indent capture form focuses its SKU field on mount (`indent-capture.tsx` line 54), which moves the first Tab off the skip link, and the cross-dock confirm path reports "Database or authentication state not available" before the bootstrap identity is in state. Left for their owning stories; this story touches neither component.
- Before that fix every e2e case failed with the shell's `setupError` alert: `readClosureCatalogue` (`edge/src/local-db/worklist.ts`, Story 7.8 commit `9abe8d3`, 2026-08-28) ordered by `rowid`, which PowerSync views do not expose, so `start()` threw "no such column: rowid" on every app start. Found by logging the swallowed catch under Playwright; fixed by ordering on `kind, code`. The edge e2e gate had been red since that commit.
- Root `npm test` (PostgreSQL 18 on port 5442): 2220/2221. The one failure, Story 7.3 `AC3: closing downtime then running the report yields hand-computed MTTR/MTBF`, fails deterministically in isolation as well; this story changes no server file, so it is pre-existing on `5c5a0cd`.
- `git diff --check`: clean apart from the repository's usual CRLF notices.
- `graphify update .` run after the code changes.

### Completion Notes List

- Task 1: `GET /auth/config` is a Next.js route handler in the edge container (`dynamic = 'force-dynamic'`) reading `EDGE_AUTH_MODE`, `EDGE_OIDC_AUTHORITY`, `EDGE_OIDC_CLIENT_ID`, `EDGE_DEV_SUBJECT` per request; `oidc` with a missing value answers 500 `EDGE_AUTH_CONFIG_MISSING`. The browser caches the last good answer in `localStorage['inventory-edge-auth-config']`, and a 500 never overwrites it. Compose sets the three `oidc` values with `${VAR:?}`; `.env.example` documents them. No `NEXT_PUBLIC_*` anywhere.
- Task 2: `oidc-client-ts` 3.5.0 added to the edge workspace (the lockfile gained only it and its `jwt-decode` dependency). `EdgeSession` wraps an injectable `SessionManager` (structurally satisfied by `UserManager`, confirmed by `tsc`); the real manager is created lazily in `createBrowserSession` with `localStorage` user and state stores, `automaticSilentRenew`, `monitorSession: false`, no `silent_redirect_uri`, scope `openid profile email`. Start rules implemented exactly as listed; `refresh()` is single-flight. `signOut()` refuses while `pending_sync` or `auth_required` rows exist and otherwise clears `cached_user_context`, removes the user, then calls `signoutRedirect` (the library sends `id_token_hint`).
- Task 3: `authorizedFetch` is the single bearer seam (global `fetch` resolved at call time, one refresh plus one retry on a 401 sent with a token, `notifyRejected()` on a second 401, 403 passes through). All five call sites switched; the existing connector tests run unchanged. `resetAuthRequired` re-queues parked rows after sign-in and is written as select-ids-then-update-by-id because an UPDATE filtered by `local_status` through the PowerSync view fails with the same `rowid` error.
- Task 4: `/auth/callback` completes the exchange and replaces the location with the remembered path; `safeReturnPath` accepts only same-origin paths and never the callback itself (no open redirect). `EdgeClient` signs in after the cached context renders and before the bootstrap call; `onAuthLost` marks the sync banner and, online only, issues one login redirect (guarded against 401 bursts). The header shows Sign out once a token exists; a blocked sign-out shows the unsettled count in a status line that clears itself when the outbox watch sees nothing pending. Five `auth.*` messages added; `auth.` and `auth-` allowed in the literal guard.
- Task 5, deviation from the task text, flagged for the user: the task said to delete `client-ims-cli.json`, `keycloak-add-cli-client.sh` and `ims-token.sh`. Only `ims-token.sh` was deleted. `staging-bootstrap-accounts.sh` and `staging-doa-bands.sh` (runbook 2.9, 2.9a) also take their operator token through the `ims-cli` password grant, and `realm-ims.json` imports that client on first boot, so removing the add script would leave no way to re-provision an existing realm. The client is now documented as a provisioning-window client: present between runbook 2.8 and the new 2.10a, where `keycloak-remove-cli-client.sh` (new) deletes it after browser sign-in is verified. `ims-app` in `realm-ims.json` was verified unchanged and sufficient (public, standard flow, no direct grants, S256, wildcard redirect and post-logout URIs, web origin, audience mapper, front-channel logout). Runbook 2.3 now lists the two `EDGE_OIDC_*` values the edge container refuses to start without.
- Task 6: gates recorded above. The staging verification checklist (6.6) is written into runbook step 2.10a and has NOT been executed: it needs the new edge image and the two `.env` values on the VPS, plus an account that has already changed its temporary password.
- Not executed against the live realm by design: `keycloak-remove-cli-client.sh`. Run it at runbook 2.10a.

### File List

- `edge/app/auth/config/route.ts` (new)
- `edge/app/auth/callback/page.tsx` (new)
- `edge/src/session/auth-config.ts` (new)
- `edge/src/session/session.ts` (new)
- `edge/src/session/api-fetch.ts` (new)
- `edge/test/unit/auth-config.test.ts` (new)
- `edge/test/unit/session.test.ts` (new)
- `edge/test/unit/api-fetch.test.ts` (new)
- `deploy/provision/keycloak-remove-cli-client.sh` (new)
- `deploy/provision/ims-token.sh` (deleted)
- `edge/src/components/edge-client.tsx` (modified: session start rules, auth-loss handling, sign-out, bearer on bootstrap and cross-dock fetches)
- `edge/src/components/app-shell.tsx` (modified: sign-out button, blocked notice, offline-no-session alert)
- `edge/src/sync/connector.ts` (modified: both fetches through `authorizedFetch`)
- `edge/src/sync/worklist-refresh.ts` (modified: `authorizedFetch`)
- `edge/src/local-db/outbox.ts` (modified: `resetAuthRequired`, `countUnsettled`, `clearCachedUserContext`)
- `edge/src/local-db/worklist.ts` (modified: pre-existing `rowid` ordering bug in `readClosureCatalogue`)
- `edge/src/messages/en.json` (modified: five `auth.*` keys)
- `edge/app/globals.css` (modified: header actions, blocked notice)
- `edge/test/unit/connector.test.ts` (modified: bearer case)
- `edge/test/unit/outbox.test.ts` (modified: fake DB handles the new queries; three cases)
- `edge/test/unit/i18n-literals.test.ts` (modified: `auth.` and `auth-` patterns)
- `edge/package.json`, `package-lock.json` (modified: `oidc-client-ts` 3.5.0)
- `deploy/compose/docker-compose.yml` (modified: `EDGE_AUTH_MODE`, `EDGE_OIDC_AUTHORITY`, `EDGE_OIDC_CLIENT_ID`)
- `.env.example` (modified: `EDGE_*` documentation)
- `docs/migration/pilot-cutover-runbook.md` (modified: 2.3 values, 2.8 client lifecycle, new 2.10a)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified: status and comment)

## Change Log

- 2026-09-13: Created Story 1.12 as ready-for-dev. Context engine analysis complete: edge UI map, server auth contract, Keycloak realm settings, and the attribution constraint that gates sign-out were extracted from code and prior stories.
- 2026-09-13: Implemented all six tasks: runtime auth config route, `oidc-client-ts` session with the offline-first start rules, bearer on every edge API call with one refresh-and-retry, callback page, sign-out gated on an empty unsettled outbox, Keycloak removal script and runbook lifecycle for `ims-cli`. Edge typecheck, lint, build clean; edge unit 86/86 (41 new); axe 5/5; e2e 4/6 with both failures reproduced on the baseline; root 2220/2221 with the one failure pre-existing on untouched server code. Fixed the Story 7.8 `rowid` ordering that had broken every edge app start and the e2e gate since 2026-08-28. Moved to review.
- 2026-09-13: Code review (3 layers): 4 decisions resolved and 16 patches applied (owner-scoped outbox upload and re-queue, sign-out ordering and failure handling, renew errors no longer redirect, session disposal, compose defaults, hardened ims-cli removal script, `ims-cli` out of the realm import, runbook 2.10 to 2.10b, exact dependency pin); 2 deferred. Task 6.6 unticked: status in-progress until the staging checklist runs.
