---
baseline_commit: 78d8ffd7545df1e910aea7bf8e3b9fdf38d1a03d
---

# Story 1.14: Refused-Captures Supervisor Screen

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a site supervisor,
I want a screen listing the captures the central system refused at my site,
so that I can see who captured what, why it was refused, and close each one with a note without calling an API by hand.

**Priority:** PILOT (ships before go-live, does not block the rehearsal). Depends on Story 1.13, which is done and deployed to staging (runbook 2.10c passed 2026-09-17). Created 2026-09-15 by `sprint-change-proposal-2026-09-15` (AD-18). The Story 1.13 code review handed this story two device-side items: the dismiss action for a retained refusal and the clear path for a retained STREAM_CONFLICT head (see Binding Decision 8).

## Acceptance Criteria

1. **Given** a signed-in user holding a supervisor role for the site (Story 1.2 role assignments) **When** they open `/supervisor/refused-captures` in the edge app **Then** they see open refusals for their site only: time, person, device, capture type, and `error_code` with its operator message (`en.json` `errors.*`), newest first.
2. **Given** a user without a supervisor role **When** they open the page **Then** it is not shown in navigation and the API returns 403.
3. **Given** an open refusal **When** the supervisor marks it resolved with a mandatory note **Then** the Story 1.13 resolve API is called (DOA-gated), the row leaves the open list, and the resolution (who, when, note) stays visible under "Resolved".
4. **Given** the page **When** it is checked by the CI accessibility audit and a keyboard-only pass **Then** it meets the same WCAG 2.1 AA bar as the Story 1.8 shell (NFR-U-02), with all copy from `en.json`.
5. **Given** the device is offline **When** the page is opened **Then** it states that the list needs a connection, and no stale cache is shown as current.
6. **Given** a retained refused capture in the device's "Sync failed - needs attention" list **When** the signed-in person dismisses it (two-tap confirm) **Then** the retained copy is removed from the device, the central record is untouched, and a stream that was parked behind a dismissed STREAM_CONFLICT head uploads its tail on the next sync (carried from the Story 1.13 review; Binding Decision 8).

## Tasks / Subtasks

- [x] Task 1: Server side, navigation entry and site filter (AC: 2)
  - [x] 1.1 Export `hasRefusedCaptureReadScope(roles, locationId): boolean` from `src/api/v1/refused-captures.ts`, built on the existing `scopesOf` / `grantLocation` helpers there (do not write a second RBAC matcher; see Binding Decision 2). True when any assignment grants read or write on any module at `locationId` or `*`.
  - [x] 1.2 In `src/api/v1/edge.ts` bootstrap handler (around line 325 to 340), append `'Refused captures'` to the `navigation` array when `hasRefusedCaptureReadScope(authContext.roles, operatingAssignment.locationId)` is true. Keep `['Dashboard', 'Frontline']` first.
  - [x] 1.3 No new route. The list already narrows to the caller's grants and answers 403 `MODULE_ACCESS_DENIED` when the caller has no read grant at all (`refused-captures.ts:85-87`). AC 2 "API returns 403" is that path; a test in Task 6 proves it.
  - [x] 1.4 Add the index the review found missing, in `read/projections/edge_refused_capture.sql` and the `deploy/compose/init-db.sql` mirror, and the schema-drift EXPECTED list if it enumerates indexes: `CREATE INDEX IF NOT EXISTS idx_edge_refused_capture_status_refused_at ON edge_refused_capture (status, refused_at DESC, refusal_id)`. Migration is `node dist/src/events/migrate.js` (re-runnable; `IF NOT EXISTS`).
- [x] Task 2: Page and shell wiring (AC: 1, 2, 5)
  - [x] 2.1 New `edge/app/supervisor/refused-captures/page.tsx`, a thin server component like `edge/app/maintenance/page.tsx`: `<EdgeClient view="refused-captures" />`.
  - [x] 2.2 Extend the `view` union in `edge/src/components/edge-client.tsx:184` to `'frontline' | 'maintenance' | 'refused-captures'` and pass it through to `AppShell` (already `view={view}` at line 705).
  - [x] 2.3 In `edge/src/components/app-shell.tsx`: add `'Refused captures': '/supervisor/refused-captures'` to the `NAVIGATION` map (lines 24 to 27; entries are filtered against the server's `navigation` array at line 114, so unknown names drop and the entry only shows when the server sent it). Render `<RefusedCapturesScreen />` when `view === 'refused-captures'` beside the existing `view === 'maintenance'` branch (line 194). Header, sync badge, sign-out and bootstrap gating stay shared.
  - [x] 2.4 The maintenance view reaches its page through a plain `<a className="secondary-action" href="/maintenance">` (app-shell.tsx:277-279). The nav link for this story is a real path, not a `#hash`; check the nav renderer (lines 162 to 168) handles both.
- [x] Task 3: Screen component (AC: 1, 3, 5)
  - [x] 3.1 New `edge/src/components/refused-captures-screen.tsx` (client component). Props: `siteId`, `userId`, `online: boolean` from the shell state. Two sections, each `<section className="edge-card" aria-labelledby=...>` with an `<h2>`: "Open refusals" and "Resolved".
  - [x] 3.2 Fetch with `authorizedFetch` from `edge/src/session/api-fetch.ts` (bearer, one retry on 401, 403 passes through): `GET /api/v1/edge/refused-captures?status=open&location_id=<siteId>&limit=100` and `...?status=resolved&location_id=<siteId>&limit=50`. Fetch on mount, on the `online` event, and after a resolve. No timer. Never write the list to the local database (AC 5, Binding Decision 5).
  - [x] 3.3 Rows are cards, not a table (DESIGN.md:404): `<ul>` of `<li>` with a `<dl>` of facts, the pattern in `edge/src/components/maintenance-worklist.tsx:71-111`. Facts per open row: `formatDateTime(refused_at)`, person (`captured_by` and `captured_role`; the API returns the user id, see Binding Decision 6), `device_id`, capture type (`event_type`, with `stream_type` as the module label), and `error_code` with `errorMessage(error_code)` rendered the way `edge/src/components/sync-failure-list.tsx:24-25` does. Newest first is the API order (`refused_at DESC, refusal_id ASC`); do not re-sort.
  - [x] 3.4 Resolve flow, two-tap (EXPERIENCE.md:425-433): a "Resolve" button on the card reveals an inline form with a required `<textarea>` (label "Resolution note", `maxLength` 1000, `minLength` 1 after trim) and a "Confirm resolve" submit plus "Cancel". Submit calls `POST /api/v1/edge/refused-captures/<refusal_id>/resolve` with `{ note, idempotency_key: 'edge-refusal-resolve-<refusal_id>' }`. Disable the form while submitting. On 200, remove the card from the open list and prepend the returned `refusal` to the Resolved section. On error, keep the card, show `errorMessage(error_code)` in the card's `role="status" aria-live="polite"` line; 409 `REFUSED_CAPTURE_ALREADY_RESOLVED` also moves the card to Resolved using `details.resolved_by` and `details.resolved_at`.
  - [x] 3.5 Resolved cards show who (`resolved_by`), when (`formatDateTime(resolved_at)`), the note (`resolution_note`), plus the original capture type and error code.
  - [x] 3.6 Empty states are mandatory (EXPERIENCE.md:1180-1210): "No refused captures at this site" for an empty open list; "Nothing resolved yet" for an empty resolved list.
  - [x] 3.7 Offline or fetch failure: render one card in place of both lists with `refused.needsConnection` copy and a "Check connection" button that re-fetches, mirroring the first-sync card (app-shell.tsx:186-193). Render nothing from a previous fetch once `online` goes false. A 403 from the list renders `refused.noAccess` copy (the nav entry should not have been shown; the API is the authority).
  - [x] 3.8 Styling: existing classes in `edge/app/globals.css` only (`edge-card`, `primary-action`, `secondary-action`, 44 px targets at lines 37 to 42, focus-visible at 44 to 49). Add the few new rules the cards need to the same file; no CSS modules, no new dependencies. Semantic colour only as fill or icon, never bare text (DESIGN.md:205, 421); error text uses the error text colour token.
- [x] Task 4: Copy and i18n (AC: 1, 4)
  - [x] 4.1 Add keys to `edge/src/messages/en.json` (flat dotted keys): `nav.refusedCaptures`, `refused.title`, `refused.openHeading`, `refused.resolvedHeading`, `refused.emptyOpen`, `refused.emptyResolved`, `refused.needsConnection`, `refused.checkConnection`, `refused.noAccess`, `refused.resolve`, `refused.noteLabel`, `refused.noteHint`, `refused.confirmResolve`, `refused.cancel`, `refused.resolving`, `refused.resolvedBy`, `refused.resolvedAt`, `refused.note`, `refused.capturedBy`, `refused.device`, `refused.captureType`, `refused.refusedAt`, `refused.dismiss`, `refused.confirmDismiss`, `refused.dismissed`, `refused.liveLabel`.
  - [x] 4.2 Add the missing operator messages: `errors.REFUSED_CAPTURE_NOT_FOUND`, `errors.REFUSED_CAPTURE_ALREADY_RESOLVED`, `errors.VALIDATION_ERROR`. Already present and reused as-is: `errors.APPROVAL_REQUIRED`, `errors.APPROVAL_UNRESOLVED`, `errors.FUNCTION_ACCESS_DENIED`, `errors.LOCATION_ACCESS_DENIED`, `errors.MODULE_ACCESS_DENIED`, `errors.STREAM_CONFLICT`. Errors are actionable sentences, not "Validation failed" (EXPERIENCE.md:155).
  - [x] 4.3 Add the `refused.` prefix, and every new `className` or `id` literal, to `ALLOWED_LITERAL_PATTERNS` in `edge/test/unit/i18n-literals.test.ts:6-43`, or the literal guard fails. Run `npm run i18n:check` in `edge/`.
- [x] Task 5: Device-side dismiss (AC: 6)
  - [x] 5.1 In `edge/src/local-db/outbox.ts` add `dismissRetainedRow(db, id): Promise<void>`: inside `inWriteTransaction`, `DELETE FROM edge_outbox_retained WHERE id = ? AND retained_reason = 'refused'`. Parked-for-owner rows are never dismissable (they belong to someone else and re-queue on their sign-in).
  - [x] 5.2 In `edge/src/components/sync-failure-list.tsx` add a two-tap "Dismiss" per refused row ("Dismiss" then "Confirm dismiss", 44 px targets, both from `en.json`). After the delete, call the existing `refreshLocalState` path so counts and the STREAM_CONFLICT park recompute (`hasUpstreamStreamConflict` reads `edge_outbox_retained`, `outbox.ts` around line 300, so removing the head clears the park; the parked tail then uploads on the next `uploadData`).
  - [x] 5.3 Unit test in `edge/test/unit/outbox.test.ts` with `SqliteDb` (`edge/test/unit/sqlite-db.ts`): dismiss removes only the named refused row, leaves a `parked_for_owner` row, and `hasUpstreamStreamConflict` turns false for that stream afterwards.
- [ ] Task 6: Tests and gates (AC: all)
  - [x] 6.1 Server integration `test/integration/story-1-14.test.ts`, copying the fixture helpers from `test/integration/story-1-13.test.ts` (`makeRequest`, `provision`, `both`, `seedDoa`, `refusal`, the persona set at lines 262 to 282): bootstrap `navigation` contains `'Refused captures'` for a persona with a read grant at the site and not for `nobody`; list with `location_id` returns only that site's rows; list as `nobody` is 403 `MODULE_ACCESS_DENIED`; the new index exists (`pg_indexes`).
  - [x] 6.2 Playwright e2e `edge/test/e2e/refused-captures.spec.ts` using the fetch-stub pattern of `edge/test/e2e/offline-shell.spec.ts:3-57`: stub bootstrap with `navigation: ['Dashboard','Frontline','Refused captures']`, stub the two list calls and the resolve call. Assert: nav link present, open card facts rendered newest first, resolve moves the card to Resolved with note, a 403 stub shows the no-access copy, `context.setOffline(true)` shows the needs-connection card and no rows. A second test with `navigation` lacking the entry asserts no nav link.
  - [x] 6.3 Accessibility: add `'/supervisor/refused-captures'` to the path array in `edge/test/accessibility/shell-accessibility.spec.ts:4` (axe tags wcag2a, wcag2aa, wcag21a, wcag21aa, zero violations, 44 px targets, solid focus outline). Keyboard-only pass: tab order reaches every Resolve, Confirm, Cancel and Check connection control; document in Completion Notes.
  - [x] 6.4 Gates: root `npm test` (2238 baseline plus new), `npm run edge:test`, `npm run edge:test:e2e`, `npm run edge:accessibility`, `npm run typecheck`, `npm run lint`, schema-drift test if the index list is enumerated. Known red before this story (memory and CI history): `test/integration/story-7-3.test.ts` AC3 MTTR/MTBF, and two edge e2e tests in `offline-shell.spec.ts` (indent-capture keyboard focus, cross-dock confirm). Everything else red is yours.
  - [ ] 6.5 Staging check (operator plus developer, after deploy per runbook 2.7 and the ship recipe in the staging memory): sign in as an account with a read grant at CMF-ALIGARH, open `/supervisor/refused-captures`, see the two open refusals recorded on 2026-09-17 (MODULE_ACCESS_DENIED, ASSET_NOT_FOUND), resolve one as the DOA approver (`department_head` holds `edge.refused_capture_resolution` on staging; `subscr@` is the department head), see it under Resolved. Record in Completion Notes.
- [x] Task 7: Documentation (AC: all)
  - [x] 7.1 Runbook `docs/migration/pilot-cutover-runbook.md`: add row 2.10d, the supervisor screen check above, after 2.10c.
  - [x] 7.2 `deferred-work.md`: mark the two 1.13 items this story closes (dismiss action; STREAM_CONFLICT park) as closed by 1.14, and record what stays open (Binding Decision 9).

### Review Findings

Code review 2026-09-17, three adversarial layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor); 8 findings were dismissed as noise. No decision-needed findings.

- [x] [Review][Patch] Dismiss on an unsalvaged `needs_attention` row is a silent no-op that reports success: `dismissRetainedRow` deletes only from `edge_outbox_retained` and never checks rows affected, while the failure list also unions unsalvaged rows from `edge_outbox` (`readFailures`), so `SyncFailureList` announces "Removed from this device" for a row that is still there [edge/src/local-db/outbox.ts:259, edge/src/components/sync-failure-list.tsx:36]
- [x] [Review][Patch] A failed quiet refetch after a successful resolve wipes the whole screen to needs-connection: `load(quiet=true)` still sets `needs-connection` on a non-200 or a caught error, discarding the ready lists, the just-resolved card and the notice after one transient failure [edge/src/components/refused-captures-screen.tsx:120]
- [x] [Review][Patch] Focus drops to `<body>` when the resolve form, the resolved card or a dismissed row unmounts: `closeForm`, `moveToResolved` and `confirmDismiss` remove the focused control with no focus return, so keyboard users are dumped to the document top (WCAG 2.4.3; the e2e asserts visibility, not focus) [edge/src/components/refused-captures-screen.tsx:148, edge/src/components/sync-failure-list.tsx:39]
- [x] [Review][Patch] Open and resolved lists truncate silently at 100 and 50 rows: the API supports limit to 500 plus offset, but the screen fetches once with no overflow notice, so older refusals and resolutions become invisible with no indication [edge/src/components/refused-captures-screen.tsx:40]
- [x] [Review][Patch] A failed dismiss shows the unrelated `sync.setupError` copy ("Offline storage is unavailable on this device") for any dismiss failure; no refused-specific failure key was added although Task 4.2 demands situationally correct operator copy [edge/src/components/sync-failure-list.tsx:38]
- [x] [Review][Patch] The dismiss notice is never cleared: after one dismiss it stays above "Retry Sync" even when the outbox watch repopulates the list, so "Removed from this device" can sit above rows that were not removed [edge/src/components/sync-failure-list.tsx:29]
- [x] [Review][Patch] One shared `note` state means opening the resolve form on card B destroys card A's typed draft without warning (easy accident on a tablet with two open refusals) [edge/src/components/refused-captures-screen.tsx:90]
- [x] [Review][Patch] Dismissing row A while row B's dismiss confirm is open clears B's confirmation in the shared `finally` without acting; the Dismiss buttons on other rows are not disabled during a dismissal [edge/src/components/sync-failure-list.tsx:27]
- [x] [Review][Patch] Empty polite live regions render permanently on every card and beside the top notice, and the notice's `aria-label` can suppress content announcements in some screen reader pairs; render the status lines only when they carry a message [edge/src/components/refused-captures-screen.tsx:253, edge/src/components/refused-captures-screen.tsx:319]
- [x] [Review][Patch] `fetchList` validates only `Array.isArray(body.refusals)`; one malformed row (missing `refusal_id` key, non-date `refused_at`) flows into React keys and `formatDateTime` and, with no error boundary in the edge app, crashes the whole screen; filter rows defensively in `fetchList` [edge/src/components/refused-captures-screen.tsx:61]
- [x] [Review][Patch] Task 6.3 letter asks the keyboard-only pass to reach Check connection by tab order, but the evidence is a programmatic `focus()` plus outline assertion in the accessibility spec, not a Tab press; extend the e2e keyboard test to the offline card [edge/test/e2e/refused-captures.spec.ts]
- [x] [Review][Defer] No fetch timeout: a hung request can leave the screen stuck in loading [edge/src/session/api-fetch.ts] - deferred, pre-existing

## Dev Notes

### What this story is, in one paragraph

Story 1.13 made every server-refused capture durable in two places: a `localOnly` copy on the device (`edge_outbox_retained`, shown under "Sync failed - needs attention") and a central `edge_refused_capture` row with a list, detail and DOA-gated resolve API. Nobody can see the central list without calling the API by hand. This story adds the page that lists a site's refusals and resolves them, plus the device-side dismiss that 1.13 explicitly left to it. The API contract is frozen; this story consumes it and changes the server only to advertise the page in `navigation` and to add one index.

### Binding decisions

1. **No new API, no new table.** The three Story 1.13 routes are the contract (Table 1). The only server changes are the `navigation` entry in bootstrap and the index in Task 1.4.
2. **"Supervisor role" means read scope, not a role name.** There is no generic supervisor role; RBAC scopes are `read` and `write` and the lint rule `doa/no-hardcoded-role-in-workflow` (`eslint-rules/no-hardcoded-role-in-workflow.js`) forbids comparing role names. Seeing a refusal needs read on its module at its site; resolving needs write on that module at that site plus being the DOA-resolved approver for `edge.refused_capture_resolution` (Story 1.13 Binding Decision 6). The nav entry therefore appears for anyone with any read grant at their operating site. A technician with `maintenance` write sees maintenance refusals at their site; that is by design. The edge never branches on `state.role`.
3. **Site scoping is the operating site from bootstrap.** The page always passes `location_id=<bootstrap.site_id>`. The server narrows again by grants before paging, so a wildcard-site holder still sees only this site on this screen. Resolve authority is company-wide because `resolveApprover` has no site dimension; accepted for the pilot, same as 1.13.
4. **Nav gating is server-side.** The edge renders only names the server put in `navigation` (app-shell.tsx:114). AC 2 "not shown in navigation" is satisfied by the bootstrap change, and "API returns 403" by the existing list behaviour. If someone types the URL without a grant, the page shows the no-access copy from the 403; that is correct, not a bug.
5. **Online only, no cache.** The list is fetched from the API on every open and never stored in the PowerSync database or `localStorage`. Offline means the needs-connection card and nothing else (AC 5). Do not add a sync bucket for `edge_refused_capture`; the 1.13 deferred item about record events replicating to devices stays deferred.
6. **Person is shown as the user id the API returns.** `captured_by` and `resolved_by` are user UUIDs; the API does not join names. Render the id with `captured_role` beside it. Resolving the id to a display name needs a users lookup that does not exist on the edge; recorded as deferred (Binding Decision 9), do not build it here.
7. **Cards, not a table.** DESIGN.md:404 forbids tables as the primary tablet display. AC 1 lists five facts; render them as a `<dl>` inside each card, in that order.
8. **Dismiss lives on the device, resolve lives centrally, and they are independent.** Dismiss deletes the device's retained copy only (`retained_reason = 'refused'`); the central row is the durable record (AD-18, AD-14). Nothing syncs a central resolution down to the device and nothing pushes a dismiss up. A dismissed STREAM_CONFLICT head unparks its stream because `hasUpstreamStreamConflict` reads the retained table. Parked-for-owner rows cannot be dismissed.
9. **Stays deferred, record in `deferred-work.md`:** display names for `captured_by` and `resolved_by`; central resolution reaching the device; tails parked behind a STREAM_CONFLICT head are never recorded centrally until the head is dismissed; refusals raised before the route (413, 400) never reach the central list; the duplicated RBAC matcher in `refused-captures.ts` versus `middleware/rbac.ts` (this story reuses the former, it does not fix it); site-blind DOA resolution; unbounded `edge_outbox_retained` growth other than by dismiss.

### API contract this screen consumes

Table 1 lists the routes. All three sit behind the router's bearer auth; there is no `requireRole` wrapper because visibility is decided per row (`src/api/v1/refused-captures.ts:17-23`).

Table 1: Story 1.13 routes

| Method and path | Query or body | 200 response | Errors |
| --- | --- | --- | --- |
| `GET /api/v1/edge/refused-captures` | `status` open or resolved (default open), `location_id` UUID, `stream_type`, `limit` 1 to 500 (default 50), `offset` 0 to 1000000 | `{ refusals: [row, ...] }`, newest first | 401 `UNAUTHORIZED`, 400 `INVALID_PARAMS`, 403 `MODULE_ACCESS_DENIED` (no read grant at all) |
| `GET /api/v1/edge/refused-captures/:refusalId` | none | `{ refusal: row }` | 404 `REFUSED_CAPTURE_NOT_FOUND` (also for rows the caller may not see) |
| `POST /api/v1/edge/refused-captures/:refusalId/resolve` | `{ note: string 1..1000 after trim, idempotency_key?: string }` | `{ event_id, refusal: row with status resolved }`; replay with the same key returns the same `event_id` | 400 `VALIDATION_ERROR` `{ field: "note" }`, 403 `FUNCTION_ACCESS_DENIED`, 403 `LOCATION_ACCESS_DENIED`, 403 `APPROVAL_REQUIRED` `{ refusal_id, resolved_approver_user_id }`, 404 `REFUSED_CAPTURE_NOT_FOUND`, 409 `APPROVAL_UNRESOLVED` `{ transaction_type }`, 409 `REFUSED_CAPTURE_ALREADY_RESOLVED` `{ refusal_id, resolved_by, resolved_at }`, 409 `DUPLICATE_EVENT` (key reused on another refusal) |

There is no cursor and no `module` parameter; paging is `limit` and `offset`, the module filter is `stream_type`. Table 2 gives the row columns the screen reads; the full 25-column shape is Story 1.13 Table 2 and every column comes back verbatim.

Table 2: Row columns the screen uses

| Column | Type | Meaning |
| --- | --- | --- |
| `refusal_id` | uuid | Card key and resolve path parameter |
| `event_id` | uuid | Capture id; matches the id the technician saw in "Captured - pending sync" |
| `stream_type` | text | Module of the capture (`maintenance`, `gate`, ...) |
| `event_type` | text | Capture type, for example `maintenance.fault_reported` |
| `device_id` | text or null | Device that uploaded |
| `captured_by` | uuid | Person, as user id |
| `captured_role` | text or null | Role the server authorized, null when refused before authorization |
| `location_id` | uuid or null | Site; `location_source` says `authorized`, `declared` or `none` |
| `error_code` | text | Stable code; operator message is `errors.<code>` in `en.json` |
| `error_details` | jsonb or null | Shown only in a collapsed "Details" disclosure if at all |
| `refused_at` | timestamptz | Sort key, newest first |
| `status` | text | `open` or `resolved` |
| `resolved_by`, `resolved_at`, `resolution_note` | uuid, timestamptz, text | Resolution facts for the Resolved section |

The error envelope everywhere is `{ error_code, message, details, trace_id }`; map `error_code` with `errorMessage()` and never show the server `message` to the user.

### Current state of the files this story changes

Table 3 records what exists today at the touch points, so the change is a delta and nothing existing is broken.

Table 3: Files updated by Story 1.14

| File | Today | This story |
| --- | --- | --- |
| `src/api/v1/edge.ts` bootstrap (about lines 325 to 340) | Returns `user_id`, `user_name`, `role` from `selectOperatingAssignment`, `site_id`, `site_name`, `navigation: ['Dashboard', 'Frontline']` hardcoded | Conditionally appends `'Refused captures'`; everything else unchanged |
| `src/api/v1/refused-captures.ts` | `scopesOf`, `grantLocation`, `grants` (lines 39 to 54) decide visibility; list 403 when no read scope (85 to 87) | Exports one predicate built on those helpers; no behaviour change |
| `read/projections/edge_refused_capture.sql` and `deploy/compose/init-db.sql` | Indexes on `(location_id, status, refused_at DESC)` and `(stream_type, status)` | Adds `(status, refused_at DESC, refusal_id)` |
| `edge/src/components/edge-client.tsx` | `view` prop of `frontline` or `maintenance` (line 184); bootstrap fetch 368 to 404 stores `navigation`; `refreshLocalState` reads `navigator.onLine` (213); `online` event handler (443) refreshes worklist | Widens `view`; passes `online` state and `site_id` to the new screen |
| `edge/src/components/app-shell.tsx` | `NAVIGATION` map (24 to 27) filtered by server list (114), rendered in `<nav aria-label={t('nav.label')}>` (162 to 168); view switch at 194; first-sync card 186 to 193 | New map entry, new view branch |
| `edge/src/components/sync-failure-list.tsx` | `<ul aria-live="assertive">` of failures, code plus `errorMessage()` (24 to 25) | Dismiss button per refused row |
| `edge/src/local-db/outbox.ts` | `retainOutboxRow`, `readFailures` (about 322), `hasUpstreamStreamConflict` (about 300) reading `edge_outbox_retained`, `inWriteTransaction` (80 to 83) | `dismissRetainedRow` |
| `edge/src/messages/en.json` | 344 flat keys; `errors.*` for the codes listed in Task 4.2 | New `refused.*`, `nav.refusedCaptures`, three `errors.*` |
| `edge/test/accessibility/shell-accessibility.spec.ts` | Audits `['/', '/first-sync', '/sync-error']` | Adds the new path |
| `edge/test/unit/i18n-literals.test.ts` | Allow-list of literal prefixes (6 to 43) | Adds `refused.` and new class names |

Read each of these before editing. The shell's bootstrap ordering (salvage, then `resetAuthRequired`, then `setState`, then `db.connect`) must not move.

### Architecture compliance

- AD-18: device-only data in `localOnly` tables; the central record is the durable one. This story reads the central record and deletes device copies only through dismiss.
- AD-3: one DOA registry through `resolveApprover`; the screen never decides approval, it shows the API's answer.
- Error envelope and `error_code` to localized message mapping (spine line 192, 345); no hard-coded user-facing strings (spine 197, Story 1.8 i18n AC).
- WCAG 2.1 AA for every UI surface (NFR-U-02): labels not placeholders, `aria-live` for results, 44 by 44 targets, visible 2 px focus, semantic colour never as bare text, `prefers-reduced-motion` respected.
- RBAC to module, function and location (NFR-SEC-02); roles are location-scoped capabilities, not titles.
- Next.js 16 app router, `output: 'standalone'`, one global stylesheet, no new runtime dependencies.

### Library and framework requirements

- Next.js 16, React client components, TypeScript 5.x. Pages are thin server components; all state lives in `edge-client.tsx`.
- `authorizedFetch` (`edge/src/session/api-fetch.ts`) for every API call: bearer from `getActiveSession()`, one retry after `session.refresh()` on 401, `notifyRejected()` on a second 401, 403 untouched.
- `t()`, `errorMessage()`, `formatDateTime()` from `edge/src/i18n/locale.ts`. `formatDateTime` gives "Sep 17, 2026, 6:52 AM".
- Playwright plus `@axe-core/playwright` for e2e and accessibility (`edge/playwright.config.ts`); `node --test` with `node:sqlite` (`SqliteDb`) for unit.
- Service worker `edge/public/sw.js` needs no change: navigations are network-first with fallback to `/`. Offline, a cold load of the new path lands on `/`; that is acceptable because the page is online-only.

### Previous story intelligence (1.13, 1.12)

- The 1.13 real-sync test proved the connector's JSON text columns and the `node:sqlite` driver; do not change `edge/src/sync/connector.ts` for this story.
- The 1.13 second review deferred two device items to this story on purpose (Binding Decision 8). It also left the RBAC matcher duplicated in `refused-captures.ts`; reuse it, do not add a third.
- Staging currently holds two open refusals and one resolved-none for CMF-ALIGARH, recorded on 2026-09-17 by the 2.10c check, plus asset `PILOT-CHECK-001`. `accounts@` (finance controller) has `inventory` read and `maintenance` write at the site; `department_head` (`subscr@`) holds the DOA band `edge.refused_capture_resolution`. Passwords for the pilot accounts are with the operator.
- The 1.12 shell pattern: bootstrap gates the whole view; `firstSyncRequired` renders the first-sync card; `authRequired` redirects to Keycloak. Reuse the card pattern for the needs-connection state.
- The i18n literal guard bites every new component: add the prefix first, then write markup.
- CI: `edge-accessibility` runs `edge:accessibility` then `edge:test:e2e`; the two known-red e2e tests keep that job red regardless of this story. Judge your e2e by your own spec file passing.

### Git intelligence

Recent commits on the branch: `78d8ffd` test(bom) IST/UTC fix; `35900b5` and `ec1b3c3` Story 1.12 and 1.13 closed; `0888067`, `c9719ab` provisioning scripts; `58de9a1` 1.13 review patches (DOA band, salvage guard); `9b67221` CI port; `e49c63a` Story 1.13 implementation (35 files). Conventions seen: commit type prefixes `feat(sync)`, `fix(edge)`, `test(bom)`, `docs`; story files carry `baseline_commit` front matter; review patches are recorded as `[Review][Patch]` lines under "Review Findings"; every story ends with a change-log table.

### Testing standards

- Root: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts` against `ims-postgres-test` on port 5442 (recreate from `deploy/compose/init-db.sql` if missing). Integration tests provision users through SCIM and mint dev tokens; copy the 1.13 helpers rather than importing them.
- Edge unit: `node --import tsx --test test/unit/*.test.ts` in `edge/`; `SqliteDb` builds real tables from `EdgeSchema`.
- Edge e2e and accessibility: Playwright builds the standalone server; API calls are stubbed by patching `fetch` in `page.addInitScript`. Offline is simulated with `context.setOffline(true)`.
- Do not test the resolve DOA gate again on the edge; the 1.13 integration test owns it. Test that the screen renders each error code's copy.

### Out of scope

- Display names for user ids (needs a users lookup on the edge).
- Replicating central resolutions to devices, or pushing dismisses up.
- Bulk resolve, filters beyond the operating site, search, export.
- Detail page per refusal; the card carries everything AC 1 asks for.
- Fixing the duplicated RBAC matcher, the site-blind DOA, or the pre-route refusal gap.

### Project Structure Notes

- Page path `edge/app/supervisor/refused-captures/page.tsx` follows `edge/app/maintenance/page.tsx`; the component under `edge/src/components/` beside `maintenance-worklist.tsx` and `sync-failure-list.tsx`; local-db helper in `edge/src/local-db/outbox.ts`; tests in `edge/test/unit`, `edge/test/e2e`, `edge/test/accessibility`; server test in `test/integration/`.
- Variance: the epic calls the nav concept a "supervisor" area. There is no supervisor role, so the folder name is cosmetic and the gate is read scope (Binding Decision 2).

### References

- Story text and ACs: `_bmad-output/planning-artifacts/epics.md` lines 412 to 440.
- Sprint change proposal: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-15.md` (AD-18 lines 173 to 194, 1.14 scope lines 52, 90, 164, 250).
- Architecture spine: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (AD-3 lines 82 to 86, AD-18 lines 172 to 178, error envelope 192 and 345, frontend standard 197, stack 203 to 212).
- UX: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/DESIGN.md` (tablet 267, 327, 393 to 395, no tables 404, colour 205 and 421, focus 425) and `EXPERIENCE.md` (accessibility floor 596 to 628, tone 155 and 167, two-tap 425 to 433, empty states 1180 to 1210, offline pattern 1238 to 1248).
- Story 1.13: `_bmad-output/implementation-artifacts/1-13-refused-and-parked-captures-are-never-lost.md` (Binding Decisions 116 to 128, Table 2 columns 150 to 176, Table 3 codes 182 to 192, Review Findings 84 to 106, Task 4.3 dismiss deferral line 52).
- Deferred work: `_bmad-output/implementation-artifacts/deferred-work.md` sections "Deferred from ... 1-13 ..." (2026-09-16 dev, 2026-09-16 review, 2026-09-17 second review).
- Server: `src/api/v1/refused-captures.ts`, `src/api/v1/edge.ts` (bootstrap), `src/read/projections/edge_refused_capture.ts`, `read/projections/edge_refused_capture.sql`, `test/integration/story-1-13.test.ts`.
- Edge: `edge/src/components/edge-client.tsx`, `app-shell.tsx`, `sync-failure-list.tsx`, `maintenance-worklist.tsx`, `edge/src/session/api-fetch.ts`, `edge/src/i18n/locale.ts`, `edge/src/messages/en.json`, `edge/src/local-db/outbox.ts`, `edge/test/accessibility/shell-accessibility.spec.ts`, `edge/test/e2e/offline-shell.spec.ts`, `edge/test/unit/i18n-literals.test.ts`, `edge/test/unit/sqlite-db.ts`.
- Runbook: `docs/migration/pilot-cutover-runbook.md` rows 2.7, 2.9a, 2.10c.

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (`claude-fable-5-1`), dev-story workflow, 2026-09-17.

### Debug Log References

- First e2e run, three failures, all fixed: the browser's native `required` check swallowed the empty-note submit so no copy appeared (the form is now `noValidate` and the component validates the trimmed note itself); the 409 `REFUSED_CAPTURE_ALREADY_RESOLVED` stub did not move the row, so the quiet refetch after a resolve put it back (the stub now moves it, as the server would); the keyboard test counted a Resolve button that is hidden while its own form is open.
- Full root regression after implementation: 2243 tests, 2242 passed, 1 failed. The failure was `test/integration/story-1-8.test.ts`, which pinned `navigation` to the two Story 1.8 entries; the expectation now carries `Refused captures` (the intended AC 2 change). Story 7.3 AC3, known red before this story, passed in this run.
- Running several integration files in one ad-hoc `node --test` call without `--test-concurrency=1` runs them concurrently on the shared database and fails the Story 1.13 setup truncate. Harness artifact, not a regression: the serial rerun of 1.8, 1.13, 1.14 and 7.3 is 61 of 61.
- Test-first record: Task 5 and the e2e specs were observed red before their implementation; the Task 1 integration test and its server change were written in one pass, so its red state was not observed (the assertions are exact: the three-entry array and the index name).

### Completion Notes List

- Task 1: `hasRefusedCaptureReadScope(roles, locationId)` in `src/api/v1/refused-captures.ts` reuses `scopesOf` and `grantLocation` (no second matcher); the bootstrap in `src/api/v1/edge.ts` appends `Refused captures` after `Dashboard`, `Frontline` when it holds. Finding: an edge user's operating site is one of their concrete assignments and any assignment grants read on its module there, so in practice everyone who bootstraps gets the entry (Binding Decision 2 accepts this; recorded in deferred-work). Index `idx_edge_refused_capture_status_refused_at` added to the canonical SQL, the init-db mirror and the schema-drift EXPECTED list; `pg_indexes` proves it in the integration test.
- Task 2: `edge/app/supervisor/refused-captures/page.tsx` is `<EdgeClient view="refused-captures" />`; the `view` union is widened in `edge-client.tsx` and `app-shell.tsx`; `NAVIGATION` gains the real path entry, filtered by the server list as before; the nav renderer already handled path hrefs. The bootstrap ordering in the shell (salvage, `resetAuthRequired`, `setState`, `db.connect`) is untouched; the client only adds an `online` flag to its state (set in `refreshLocalState`, which the online and offline events already call) and a `dismissFailure` callback.
- Task 3: `edge/src/components/refused-captures-screen.tsx`. States: loading, ready, needs-connection, no-access. Fetches with `authorizedFetch` on mount, when the site id becomes known, and on every `online` change; a resolve mutates the lists locally and then refetches quietly; a sequence counter drops stale responses. Nothing is written to the local database or `localStorage`. Cards are `<li>` with a `<dl>` of the five AC 1 facts in AC 1 order; the API order is rendered as is. Two-tap resolve: Resolve opens the inline form and focuses the textarea; Confirm resolve posts `{ note, idempotency_key: 'edge-refusal-resolve-<refusal_id>' }`; the form is disabled while submitting; a 200 moves the card to Resolved and announces it; 409 already-resolved moves the card with `details.resolved_by` and `details.resolved_at`; every other code stays on the card as `errorMessage(code)` in its `role="status"` line; a non-JSON or network failure shows the needs-connection copy on the card. Resolve is disabled while no user is signed in (`userId` empty after a Story 1.12 sign-out). Offline or a failed list fetch renders only the needs-connection card with Check connection; a 403 renders the no-access card. Styling is in `globals.css` under existing tokens; error text uses `--error-strong` on white.
- Task 4: 26 `refused.*` keys from the task list plus `nav.refusedCaptures` and the three `errors.*` codes. Three keys beyond the list were needed for correct behaviour and are named here: `refused.loading` (announced while the first fetch is in flight, so the empty-state copy is never shown before data), `refused.reason` (the `<dt>` for the error fact), `refused.resolvedNotice` (the live announcement after a successful resolve). `refused.resolvedAt` reads "Resolved on" and `refused.refusedAt` "Refused on" so neither collides with the "Resolved" section heading in the accessibility tree. Literal guard: `refused.` and `refused-` prefixes allowed; `npm run i18n:check` passes.
- Task 5: `dismissRetainedRow(db, id)` deletes `edge_outbox_retained WHERE id = ? AND retained_reason = 'refused'` inside `inWriteTransaction`; the shell's `dismissFailure` calls it and then `refreshLocalState`, so counts, the failure list and the STREAM_CONFLICT park all recompute from the tables. `SyncFailureList` gets a two-tap Dismiss (Dismiss, then Confirm dismiss with Cancel, 44 px, all copy from `en.json`) and announces "Removed from this device. The central record is unchanged." Unit test proves: only the named refused row is removed, a parked-for-owner row survives a dismiss attempt, `hasUpstreamStreamConflict` turns null for the stream, counts and failures follow. AC 6 boundary found in `connector.ts`: a tail the connector already parked is itself retained `refused` with `STREAM_CONFLICT` and its queue entry is completed, so dismissing the head un-parks the stream for rows still pending in the upload queue, not for tails already settled; those are dismissed in turn and re-captured. Recorded in deferred-work.
- Task 6.1 to 6.4 gates, all run on 2026-09-17: root `npm test` 2243 tests (2238 baseline plus 5 new), 2243 green after the Story 1.8 expectation update (first run 2242 of 2243, see Debug Log); `npm run edge:test` 105 of 105 (104 plus 1); Playwright e2e plus accessibility in one run: 19 passed, 2 failed, the two being the known-red pair in `offline-shell.spec.ts` (keyboard focus, cross-dock confirm); the 7 new e2e tests and the 3 new accessibility audits (populated screen with the form open, no-access card, needs-connection card, and the path entry in the shell loop) all pass with zero axe violations; `tsc --noEmit` clean at root and in `edge/`; `eslint` clean at root and in `edge/`; schema-drift 186 of 186.
- Keyboard-only pass (AC 4, Task 6.3), proven by the `keyboard-only` e2e test: Tab order is Skip to content, Dashboard, Frontline, Refused captures, then the first card's Resolve (44 px, solid outline); Enter opens the form with focus on the Resolution note textarea (solid outline); Tab reaches Confirm resolve (44 px), then Cancel, then the next card's Resolve; Shift+Tab back to Cancel and Enter closes the form and the first Resolve returns. Check connection is focusable with a solid outline and 44 px in the offline card (accessibility spec).
- Task 6.5 NOT run in this session: it needs the code shipped to the staging box and the operator's browser session (pilot passwords are with the operator; `subscr@` still carries `UPDATE_PASSWORD`). The code on the box is a tar copy shipped from a commit (`git archive HEAD ...`), so the steps are: commit this story; ship `src events read sync edge deploy docs package*.json tsconfig.json` per the staging memory; rebuild the app and edge images (`network: host`); run the migration per runbook 2.7 (adds the index, re-runnable); restart nginx after the app container is recreated; then runbook 2.10d with the operator. Record the result here and tick 6.5.
- Task 7: runbook row 2.10d added after 2.10c (`docs/migration/pilot-cutover-runbook.md`); `deferred-work.md` marks the 1.13 dismiss item closed, the STREAM_CONFLICT park item closed for the head with the settled-tail boundary carried forward, the retained-growth item narrowed, and adds a Story 1.14 section with the Binding Decision 9 items and what implementation found.
- Story file sections touched: frontmatter untouched (baseline_commit preserved), Tasks checkboxes, Dev Agent Record, File List, Change Log, Status.

### File List

- `src/api/v1/refused-captures.ts` (modified: `hasRefusedCaptureReadScope`)
- `src/api/v1/edge.ts` (modified: bootstrap `navigation`)
- `read/projections/edge_refused_capture.sql` (modified: index)
- `deploy/compose/init-db.sql` (modified: index mirror)
- `test/unit/schema-drift.test.ts` (modified: EXPECTED index list)
- `test/integration/story-1-14.test.ts` (new)
- `test/integration/story-1-8.test.ts` (modified: bootstrap `navigation` expectation)
- `edge/app/supervisor/refused-captures/page.tsx` (new)
- `edge/src/components/refused-captures-screen.tsx` (new)
- `edge/src/components/sync-failure-list.tsx` (modified: two-tap Dismiss)
- `edge/src/components/app-shell.tsx` (modified: nav entry, view branch, dismiss prop)
- `edge/src/components/edge-client.tsx` (modified: view union, `online` state, `dismissFailure`)
- `edge/src/local-db/outbox.ts` (modified: `dismissRetainedRow`)
- `edge/src/messages/en.json` (modified: `nav.refusedCaptures`, `refused.*`, three `errors.*`)
- `edge/app/globals.css` (modified: `refused-*` rules)
- `edge/test/unit/i18n-literals.test.ts` (modified: allow-list)
- `edge/test/unit/outbox.test.ts` (modified: dismiss test)
- `edge/test/fixtures/refused-captures-stub.ts` (new: shared fetch stub)
- `edge/test/e2e/refused-captures.spec.ts` (new)
- `edge/test/accessibility/shell-accessibility.spec.ts` (modified: path entry, two stubbed audits)
- `docs/migration/pilot-cutover-runbook.md` (modified: row 2.10d)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified: 1-14 status)
- `_bmad-output/implementation-artifacts/1-14-refused-captures-supervisor-screen.md` (this file)
- `graphify-out/` (regenerated by `graphify update .`)

## Change Log

The Change Log table lists every revision of this story.

Table 4: Change log

| Date | Change |
| --- | --- |
| 2026-09-17 | Story created from epics.md, the 2026-09-15 sprint change proposal, the Story 1.13 file and its three deferred-work sections, the architecture spine, DESIGN.md and EXPERIENCE.md, and the current edge and server code. Nine binding decisions; AC 6 carries the device-side dismiss and STREAM_CONFLICT clear path the Story 1.13 review assigned here. |
| 2026-09-17 | Implemented Tasks 1 to 5 and 7 and gates 6.1 to 6.4 (dev-story): bootstrap navigation entry and read-scope predicate, status-ordered index, supervisor page and screen, two-tap resolve and device dismiss, copy, tests (5 integration, 1 unit, 7 e2e, 3 accessibility), runbook 2.10d, deferred-work. Task 6.5 (staging check) pending on deploy and the operator. Status to review. |
| 2026-09-17 | Code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor): 11 patches applied (dismiss no-op guard, quiet-refetch resilience, focus return, truncation indicators, dismiss failure copy, per-card draft, cross-row dismiss race, conditional live regions, response-shape validation, Check connection keyboard evidence), 1 deferred (fetch timeout), 8 dismissed as noise. Status to done. Task 6.5 (runbook 2.10d) remains pending on deploy and the operator. |
