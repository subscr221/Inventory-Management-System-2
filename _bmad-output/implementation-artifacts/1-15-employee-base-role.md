---
baseline_commit: 4f5164c
---

# Story 1.15: Employee Base Role

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a signed-in employee holding no specialist role,
I want to raise a requisition, check stock availability, report damage, and see my own requests from the base employee capability,
so that everyday needs do not require a procurement or inventory role grant that hands me write access I should not have.

## Acceptance Criteria

1. **Raise without procurement write.** Given a signed-in user whose only capability is the employee base role (extends Story 1.2 RBAC), when they raise a purchase requisition, then the requisition is accepted without any procurement write role. The current code path requires procurement write (`src/api/v1/indents.ts:557`); this story removes that requirement for the raise action only.
2. **Availability without inventory read.** Given the same base-role user, when they look up stock availability for an item, then they see availability (in stock or not, and where it can be requested from) without holding inventory read (`src/api/v1/stock.ts:195` currently requires it). Quantities, valuations, and other inventory detail remain gated by inventory read.
3. **Damage report from the base role.** Given the same base-role user, when they report damage (Story 8.9 capture flow), then the report is accepted from the base role on any device.
4. **My requests.** Given the same base-role user, when they open "My requests", then they see the live status of their own requisitions and damage reports only: no other user's requests and no procurement or inventory work queues.
5. **Menu derives from capabilities.** Given any signed-in user, when their menu renders, then the visible entries derive from the access matrix capabilities they hold, with the employee base entries present for everyone.

Source: [epics.md Story 1.15](../planning-artifacts/epics.md), created 2026-09-26 by [sprint-change-proposal-2026-09-26.md](../planning-artifacts/sprint-change-proposal-2026-09-26.md) section 4.1. PILOT.

## Tasks / Subtasks

- [ ] Task 1: Red tests first (AC: 1, 2, 4, 5)
  - [ ] 1.1 Unit `test/unit/rbac-module-list.test.ts`: `requireRole` accepts `module: string[]`; matches any listed module in list order; the authorizing assignment set for the handler is the first listed module the caller holds at the resolved location; 403 codes unchanged (`MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `LOCATION_ACCESS_DENIED`); `INVALID_MODULE` when the list is empty. Confirm red.
  - [ ] 1.2 Unit `test/unit/employee-base-role-pack.test.ts` (pattern: `test/unit/weighbridge-breach-routing.test.ts`): every human person in `docs/migration/pilot-mock-extract/roles.json` holds exactly one `{ role: 'employee', module: 'employee', function_scope: 'write', location_id: 'site' }` row; the `svc_erp_adapter` holder does not; the constant `EMPLOYEE_MODULE` in `src/middleware/rbac.ts` equals `'employee'`; `SEGREGATED_ROLE_PAIRS` and `EXTRA_FORBIDDEN_PAIRS` name no pair containing `employee`. Confirm red.
  - [ ] 1.3 Integration `test/integration/story-1-15.test.ts` (copy the helpers from `test/integration/story-3-12.test.ts`: `makeRequest`, `provisionUser`, `authFor`, `Role`). Personas: `emp1` with only `employee/employee/write/<site>`; `po1` with `procurement_officer` procurement write and read at the site (regression twin); `emp2` a second employee-only user; `nosite` with `employee` at a different site. Cases, each asserting exact values and a negative control:
    - raise: `emp1` `POST /api/v1/indents` 201, `indent.requester_user_id` equals `emp1`'s user id, `approval` present when value crosses a DOA band, event `metadata.actor.role` equals `employee` and `metadata.actor.location_id` equals the site; `nosite` raising at this site 403 `LOCATION_ACCESS_DENIED`; `emp1` calling confirm, withdraw, approve, reject, cancel on their own indent 403 `MODULE_ACCESS_DENIED` (raise-only, AC 1); `po1` raise still 201 with `actor.role` equal to `procurement_officer`.
    - my requests: `emp1` `GET /api/v1/indents?mine=true` 200 lists only `emp1`'s indents (seed one for `emp2` and assert it is absent); `emp1` `GET /api/v1/indents` without `mine=true` 403 `FUNCTION_ACCESS_DENIED`; `emp1` `GET /api/v1/indents/:id` of own indent 200, of `emp2`'s indent denied with the same code the withdraw ownership check uses; `po1` list without `mine` still 200.
    - availability: `emp1` `GET /api/v1/stock/:sku/availability` 200 with exactly the keys in Table 2 and no numeric quantity key anywhere in the body (walk the JSON); one location with free stock reports `in_stock: true`, one with only `job_work` class stock reports `in_stock: false`; `emp1` `GET /api/v1/stock/:sku` 403 `MODULE_ACCESS_DENIED`; unknown SKU 404 `ITEM_NOT_FOUND`; `po1` (inventory read) gets the same availability shape.
    - bootstrap: `emp1` `GET /api/v1/edge/bootstrap` 200, `navigation` deep-equals `['Dashboard', 'Frontline', 'New requisition', 'Check stock', 'My requests']`; a persona with `inventory` read at the site additionally gets `'Refused captures'` in the position Table 3 fixes.
    - edge sweep: `emp1` `POST /api/v1/edge/events` with `stream_type: 'procurement'`, `event_type: 'indent.raised'`, `payload.site_id` the site: 202/201 as today for a procurement writer; the same body with `event_type: 'indent.approved'` 403 `LOCATION_ACCESS_DENIED` (employee write does not unlock the rest of the module).
  - [ ] 1.4 Edge unit: `edge/test/unit/nav-model.test.ts` (or the existing nav test) covers the three new `NAV_ENTRIES`; add the new i18n key prefixes to the allow-list in `edge/test/unit/i18n-literals.test.ts` before writing any markup.
  - [ ] 1.5 Run each new file alone and confirm it fails for the reason the assertion names, not for a setup error.
- [ ] Task 2: RBAC and API (AC: 1, 2, 4)
  - [ ] 2.1 `src/middleware/rbac.ts`: export `EMPLOYEE_MODULE = 'employee'`; widen `RbacOptions.module` to `string | string[] | ((params, body) => string | string[])`; resolve to a non-empty list; module match is "assignment module in list or `*`"; the authorizing assignment is chosen by list order, then location coverage. Keep the three 403 codes and messages; the `MODULE_ACCESS_DENIED` message names the first listed module.
  - [ ] 2.2 `src/api/v1/indents.ts`: `raiseIndentHandler` gate becomes `[EMPLOYEE_MODULE, 'procurement']` write; `assertSiteReadAccess` in the raise path accepts an `employee` assignment covering `site_id` as well as procurement read (leave the other callers of `assertSiteReadAccess` on procurement read). `getIndentHandler` and `listIndentsHandler` gate on `[EMPLOYEE_MODULE, 'procurement']` read. In `listIndentsBase`: if the caller holds no procurement read at any site (`permittedLocationsForModuleScope(roles, 'procurement', 'read')` empty and no wildcard) then `mine=true` is required, else 403 `FUNCTION_ACCESS_DENIED` with message "Base role lists own requisitions only; pass mine=true". With `mine=true` skip the site filter (own requests at every site). In `getIndentBase`: without procurement read at the indent's site, deny unless `indent.requester_user_id === actor.userId`, reusing the ownership denial the withdraw handler raises (`indents.ts:412`). Confirm, withdraw, approve, reject, cancel stay procurement write (see Binding decisions, D3).
  - [ ] 2.3 `src/api/v1/stock.ts`: add `getStockAvailabilityBase` and `getStockAvailabilityHandler = requireRole({ module: [EMPLOYEE_MODULE, 'inventory'], functionScope: 'read' })`; wire `GET /api/v1/stock/:sku/availability` in `src/server.ts` next to the existing stock route (register it BEFORE `/:sku` if the router matches by prefix; check `src/api/router.ts`). Response per Table 2. Location scope: union of the caller's `employee` and `inventory` assignment locations (site coverage through `attachLocationCoverage`, as `permittedLocationsForModule` already does). Leave `getStockHandler` on inventory read.
  - [ ] 2.4 `src/api/v1/edge.ts`: `assertEdgePayloadSiteWriteAccess` accepts an `employee` write assignment covering `payload.site_id` only when `stream_type === 'procurement'` and `event_type === 'indent.raised'`; every other event keeps today's rule. Put the (stream, event) pair in one exported constant `EMPLOYEE_EDGE_EVENTS` next to `EMPLOYEE_MODULE` so 8.9 extends it rather than adding a second branch.
  - [ ] 2.5 Lint: `eslint src/ test/` clean; confirm `doa/no-hardcoded-role-in-workflow` does not fire (the new strings are module names, not role names in workflow code; if it fires, the constant moves to `src/compliance/employee-base.ts` with the rule's documented exemption comment).
- [ ] Task 3: Menu derivation and edge screens (AC: 2, 4, 5)
  - [ ] 3.1 `src/api/v1/edge.ts` bootstrap: replace the hand-built `navigation` array with a table `NAVIGATION_CAPABILITIES: { name, module, functionScope }[]` (Table 3) evaluated against `authContext.roles` at the operating site; `Dashboard` and `Frontline` keep their current unconditional rule (row with `module: '*'` meaning "any assignment at the operating site"); `Refused captures` keeps `hasRefusedCaptureReadScope`. Output order is table order. Update the pinned expectation in `test/integration/story-1-8.test.ts:212`.
  - [ ] 3.2 `edge/src/components/navigation/nav-model.ts`: add `NAV_ENTRIES` rows `New requisition` (href to the existing indent capture; find its mount at `edge/src/components/app-shell.tsx:338` and give it a route if it has none), `Check stock` (`/stock`), `My requests` (`/requests`). Keys `nav.newRequisition`, `nav.checkStock`, `nav.myRequests` in `edge/src/messages/en.json`.
  - [ ] 3.3 New views in `edge/src/components/edge-client.tsx` `view` union and `app-shell.tsx` switch: `'check-stock'` and `'my-requests'`; pages `edge/app/stock/page.tsx` and `edge/app/requests/page.tsx` as thin `<EdgeClient view=... />` wrappers (pattern: `edge/app/supervisor/refused-captures/page.tsx`).
  - [ ] 3.4 `edge/src/components/check-stock.tsx`: SKU input (same regex as the API, `stock.ts:11`), calls `authorizedFetch('/api/v1/stock/<sku>/availability')`, renders one card per location with "In stock" or "Out of stock" and the location code; never renders a number. Online-only: needs-connection card when offline (pattern: refused-captures screen). Error envelope: map `error_code` only (`ITEM_NOT_FOUND`, `MODULE_ACCESS_DENIED`).
  - [ ] 3.5 `edge/src/components/my-requests.tsx`: calls `authorizedFetch('/api/v1/indents?mine=true&limit=50')`, one card per indent (number, status, raised at, line count, approver if present), newest first, truncation indicator at the limit, quiet refetch does not wipe the ready state (Story 1.14 review lessons). Section model: a `sections` array with one entry `requisitions` now; Story 8.9 adds `damage_reports` to the same array rather than a second screen (AC 4, D5). Online-only.
  - [ ] 3.6 Permission-denied state: a deep link into `/stock` or `/requests` by a user whose bootstrap `navigation` lacks the entry renders the existing no-access copy (EXPERIENCE.md "Permission denied") and links to home.
  - [ ] 3.7 Edge gates: `npm run edge:typecheck`, `npm run edge:lint`, `npm run edge:test`, `npm run edge:test:e2e`, `npm run edge:accessibility` (judge by this story's spec files; the two known-red tests in `edge/test/e2e/offline-shell.spec.ts` are pre-existing). Keyboard evidence in e2e is real Tab presses.
- [ ] Task 4: Pilot pack and access matrix (AC: 5)
  - [ ] 4.1 `deploy/rehearsal/mock/generate.mjs` people table (line 410 onward): append `['employee', 'employee', W, 'site']` to every person except `erp1` (`svc_erp_adapter`). Do NOT regenerate the pack.
  - [ ] 4.2 Hand-edit `docs/migration/pilot-mock-extract/roles.json`: one new `roles` row per human person, `{ "role": "employee", "module": "employee", "function_scope": "write", "location_id": "site", "holder": "<email>" }`, 20 rows, placed after that person's existing rows. `world.json`: add `operations.actors.employee` pointing at a person who holds no procurement and no inventory grant (choose from the pack; record the choice in Completion Notes).
  - [ ] 4.3 `npm run verify:roles` against the local test DB after `npm run provision:roles` with the pack: PASS, no new pair violations. `test/unit/provision-roles-core.test.ts` still green (the planner validates role and module names; if it keeps an allow-list, add `employee`).
  - [ ] 4.4 Access matrix `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`: section 2 role register gains `employee` ("Base hat every signed-in person holds. Raise requisition, check availability, own requests. Location scope: site. Anchors UJ-IND-01, Story 1.15"); section 3 gains three capability rows: "Raise requisition" C (employee, all roles), "Stock availability (in stock or not, where)" R (employee, all roles), "My requests (own only)" R (employee, all roles); the existing "Valuation and NRV views" and stock quantity rows stay unchanged; section 9 changelog row v1.1 dated 2026-09-27 naming this story. Apply `FORMATTING_RULES.md` (hyphens, no arrows, tables referenced in prose).
- [ ] Task 5: Green and regression (AC: all)
  - [ ] 5.1 Focused set: the three new test files plus `story-4-3`, `story-4-7`, `story-1-8`, `story-1-14`, `story-11-2-edge-sweep`, `segregated-roles`, `provision-roles-core`, `no-hardcoded-role-in-workflow`, `schema-drift`; run with `node --env-file=.env.test --import tsx --test --test-concurrency=1 <files>`.
  - [ ] 5.2 Full `npm test` (2435 on the baseline plus the new files), `npx tsc --noEmit` root and `edge/`, `npm run lint`, `prettier --check --end-of-line auto` on changed files.
  - [ ] 5.3 Local smoke: `node --env-file=.env.test --import tsx deploy/rehearsal/mock/operations-smoke.ts` all PASS after Task 6.1.
- [ ] Task 6: Rehearsal smoke, runbook, staging (AC: 1, 2, 4, 5)
  - [ ] 6.1 `deploy/rehearsal/mock/operations-smoke.ts`: new flow `employeeRequisition` run as `operations.actors.employee`: availability lookup for a SKU with stock at the site (assert `in_stock` true and no numeric key), raise a one-line requisition (assert 201 and `requester_user_id`), read it back with `mine=true` (assert present), bootstrap navigation contains the three base names. Guard missing SKU or actor with a named SKIP line, not a raw crash (Story 3.12 review lesson).
  - [ ] 6.2 `docs/migration/pilot-cutover-runbook.md`: row 2.10f after 2.10e, same shape: (1) re-apply roles with `deploy/provision/staging-provision-roles.sh docs/migration/pilot-mock-extract/roles.json --apply`, verify with `verify:roles` or `SELECT role, module, function_scope FROM user_role_assignments WHERE user_id = (SELECT user_id FROM users WHERE email = '<employee actor>')` expecting `employee` write; (2) smoke `--remote deploy/pilot/sim/staging-sim.json --pack docs/migration/pilot-mock-extract`, the `employee:` lines PASS; (3) browser: signed in as the employee actor, header shows the three base entries, Check stock shows a state pill without a number, My requests lists the smoke requisition, and `GET /api/v1/stock/<sku>` from the console answers 403 `MODULE_ACCESS_DENIED`.
  - [ ] 6.3 Staging run (operator task, like Story 1.14 Task 6.5): deploy by hand per runbook 2.15, execute 2.10f, record PASS and date in this story's Completion Notes. If the operator is not available, leave 6.3 unchecked and say so; do not mark it done on local evidence.
- [ ] Task 7: Records (AC: all)
  - [ ] 7.1 `_bmad-output/implementation-artifacts/deferred-work.md`: section "Deferred from: dev of 1-15-employee-base-role (2026-09-27)" with the items listed under Out of scope that the dev confirms are still open (own-indent withdraw from the base role; availability "expected date" and "collect at" chips; Report damage nav entry; users lookup for display names; navigation not cached offline; `assertSiteReadAccess` duplicated scope logic).
  - [ ] 7.2 Story file: Dev Agent Record, File List, Change Log. `graphify update .`.

## Dev Notes

Story 1.15 gives every signed-in person one more assignment row, `employee` module at their site, and lets three read-or-raise paths accept that row where today only a specialist hat unlocks them. Nothing in DOA resolution, SOD-01, valuation, or approval changes. Damage reporting (AC 3) is delivered by Story 8.9, which gates on the constant and edge event list this story creates; this story must leave those two extension points named and tested so 8.9 adds rows, not branches.

### Binding decisions

- **D1 The base role is a real assignment, not an implicit flag.** `requireRole` has no "any authenticated user" mode, `actorContext` stamps `role` and `location_id` from the authorizing assignment, and the edge bootstrap refuses a user without one concrete site (`selectOperatingAssignment`, `src/api/v1/edge.ts:277-300`, 403 `EDGE_NO_CONCRETE_SITE`). An implicit capability would stamp `role: ''` and `location_id: '*'` on every base-role event and would not give the edge a site. So the base role is `{ role: 'employee', module: 'employee', function_scope: 'write', location_id: <site> }`, provisioned by the same pack, SCIM route, and `provision:roles` planner as every other hat. Access-matrix principle 1 ("roles are hats, assignment tuple is (user, role, location[])") is honoured, and AD-3 ("no hard-coded role assignments in workflow code") is honoured because workflow code names a module, not a role.
- **D2 Gates accept a list of modules; existing hats keep working.** Dozens of tests and the pilot day raise indents as `procurement_officer` or `department_head` with no `employee` row. Switching the raise gate to `employee`-only would break them and would make the pack a hidden dependency of every route. `requireRole` therefore takes `module: string[]` meaning any-of, list order decides which assignment stamps the actor, and the raise gate is `[EMPLOYEE_MODULE, 'procurement']`. This is the one middleware change; no new helper.
- **D3 Raise only.** AC 1 says the requirement is removed "for the raise action only". Confirm, withdraw, cancel stay procurement write even for the requester. Withdrawing one's own requisition from the base role is a reasonable next step and is logged as deferred, not built.
- **D4 Availability is a separate endpoint with no numbers.** `GET /api/v1/stock/:sku` returns on_hand, allocated, picked, available, in_transit, per-class rows and owner party codes; stripping fields per caller inside one handler invites a leak on the next field added. A second route, `GET /api/v1/stock/:sku/availability`, returns only Table 2. "In stock" at a location means the sum of `available` (generated as `on_hand - allocated`, `read/projections/stock_balance.sql:28`) over rows whose `stock_class` is not in `SEGREGATED_STOCK_CLASSES` (`prototype`, `job_work`, `offcut`, `src/compliance/stock-balance.ts:98`) is greater than zero. Customer-owned and prototype stock is not requestable. If a quality-hold projection marks rows blocked (FR-Q-09), those rows are excluded too; the dev verifies how holds are represented in the balance read and records the rule in Completion Notes.
- **D5 UX mock versus AC on quantities: the AC wins.** `mockups/key-requisitions.html` shows "In stock - 12 available" and "Low - N available"; EXPERIENCE.md never promises a number and AC 2 gates quantities behind inventory read. The screen shows "In stock" or "Out of stock" per location. The "Low" state, "expected <date>", "Collect at <counter>", approval-route chip, and "Unit value" (self-approval limit, Story 4.8) are out of scope; the mock is to be amended by the UX owner (deferred entry).
- **D6 My requests reuses the indent list.** `listIndentsBase` already supports `mine=true` (`indents.ts:336`, projection filter `src/read/projections/indent.ts:108-111`). A new aggregate endpoint would duplicate it and would need a stub for damage reports that do not exist yet. The base role gets `mine=true` on the existing route, own requests across all sites, and the edge screen carries a `sections` array so 8.9 appends `damage_reports`. Listing without `mine=true` from a caller with no procurement read is refused explicitly (403 `FUNCTION_ACCESS_DENIED`), never silently narrowed.
- **D7 Menu derivation is table-driven on the server.** The edge never decides authorization (Story 1.14 pattern); `navigation` in the bootstrap is the menu. Today it is hand-built (`edge.ts:339-350`). It becomes a table of (name, module, scope) evaluated against the caller's assignments at the operating site. `Dashboard` and `Frontline` stay unconditional for anyone with an operating site; `Refused captures` keeps its existing scope helper. `Report damage` is NOT added here: no screen exists until 8.9, and a menu entry to nothing is worse than a missing one. AC 5 is satisfied for the entries that exist.
- **D8 Service accounts hold no base hat.** `svc_erp_adapter` (`erp1`) is a machine identity; "every signed-in employee" excludes it. The pack unit test pins this.

### Evidence

Table 1 traces each decision to its source.

Table 1: Decision evidence

| Decision | Evidence |
|---|---|
| D1 | `src/middleware/rbac.ts:132-138, 167-230`; `src/api/v1/indents.ts:40-48` (`actorContext`); `src/api/v1/edge.ts:277-300`; access matrix section 1 principle 1; ARCHITECTURE-SPINE.md AD-3 |
| D2 | `src/server.ts:784`; `indents.ts:557-596`; `test/integration/story-4-3.test.ts` and `story-4-7` provision procurement hats; `docs/migration/pilot-mock-extract/roles.json` procurement write holders `subscr@`, `indent1@` |
| D3 | epics.md Story 1.15 AC 1 wording "raise action only" |
| D4 | `src/api/v1/stock.ts:44-198`; `read/projections/stock_balance.sql:13-28`; `src/compliance/stock-balance.ts:73-108`; ARCHITECTURE-SPINE.md AD-14 (read from projections) |
| D5 | EXPERIENCE.md lines 157, 229; `mockups/key-requisitions.html` lines 406, 683-692; epics.md Story 1.15 AC 2 |
| D6 | `indents.ts:290-345`; `src/read/projections/indent.ts:95-125`; EXPERIENCE.md Table 1 row "My requisitions, every employee (base hat)" |
| D7 | `src/api/v1/edge.ts:331-352`; `edge/src/components/navigation/nav-model.ts`; EXPERIENCE.md line 48 and Q10 (line 253); `test/integration/story-1-8.test.ts:212` |
| D8 | `deploy/rehearsal/mock/generate.mjs:417` |

### API contract

Table 2 fixes the availability response. No other key may appear; the integration test walks the body and fails on any numeric value.

Table 2: GET /api/v1/stock/:sku/availability response

| Key | Type | Meaning |
|---|---|---|
| `sku` | string | Echo of the path SKU after the existing regex check |
| `item_name` | string | From item master (same lookup as `getStockBase` 404 path) |
| `uom` | string | Stock UOM from item master |
| `in_stock` | boolean | True if any location row below is `in_stock` |
| `locations` | array | One entry per location the caller may see (employee or inventory scope), sorted by `location_code` |
| `locations[].location_id` | string | Location UUID |
| `locations[].location_code` | string | Human code shown on the card |
| `locations[].in_stock` | boolean | Rule in D4 |

Errors: 404 `ITEM_NOT_FOUND`; 403 `MODULE_ACCESS_DENIED` when the caller holds neither `employee` nor `inventory`; 400 on a SKU failing the regex (reuse the existing code). Envelope `{ error_code, message, details, trace_id }`.

Table 3 fixes the bootstrap navigation table and its order. The integration test pins the full array for each persona.

Table 3: Bootstrap navigation capabilities

| Order | Name | Module | Scope | Rule |
|---|---|---|---|---|
| 1 | Dashboard | `*` | read | Any assignment at the operating site (unchanged) |
| 2 | Frontline | `*` | read | Any assignment at the operating site (unchanged) |
| 3 | Refused captures | inventory (existing helper) | read | `hasRefusedCaptureReadScope` (unchanged) |
| 4 | New requisition | employee or procurement | write | Any-of, at the operating site |
| 5 | Check stock | employee or inventory | read | Any-of, at the operating site |
| 6 | My requests | employee or procurement | read | Any-of, at the operating site |

`Workflows`, `Access control`, `Reports` exist in `NAV_ENTRIES` but are never emitted by the bootstrap today; leave them as they are.

### Current state of the files this story changes

Table 4 records what each touched file does today and what must survive.

Table 4: Files being modified

| File | Today | This story changes | Must be preserved |
|---|---|---|---|
| `src/middleware/rbac.ts` | `requireRole` resolves one module (string or function), filters assignments by module or `*`, checks scope then location, sets the authorizing assignment (132-230) | `module` may be a list; `EMPLOYEE_MODULE` exported | Three 403 codes and their order (module, function, location); `INVALID_MODULE` on empty; `setAuthorizedAssignment` semantics; `permittedLocationsForModule*` untouched |
| `src/api/v1/indents.ts` | Raise 135-260 (duplicate check, DOA `resolveApprover`, `indent.raised` on stream `procurement`, `auditCtxFor`); `assertSiteReadAccess` 108-119; list 290-345 with `mine`; ownership checks 371, 412; handlers 557-596 | Gates on raise, get, list; site read helper accepts employee; `mine` required for base callers; own-only get | Duplicate detection; DOA resolution and `approver_actor_id`; `requester_user_id` from `actor.userId` never from the body; 201 shape `{ event_id, indent, lines, approval? }`; confirm, withdraw, approve, reject, cancel gates and ownership rules |
| `src/api/v1/stock.ts` | `getStockBase` 44-192 gated inventory read (195-198); location filter via `permittedLocationsForModule` (71-75) | New availability handler and base | Existing detail response and gate byte-for-byte |
| `src/server.ts` | Stock route 561; indent routes 784-786; edge routes | One new GET route | Route order for `/api/v1/stock/:sku` |
| `src/api/v1/edge.ts` | Bootstrap 331-352 hand-builds `navigation`; `assertEdgePayloadSiteWriteAccess` 90-110 requires write on `stream_type` module at `payload.site_id`; events route 640-660 sets `requester_user_id` server-side for `indent.raised` | Table-driven navigation; employee write accepted for `indent.raised` only | Operating-site selection and its two error codes; every other event's write rule; server-side requester and DOA resolution on the sweep |
| `edge/src/components/navigation/nav-model.ts`, `app-shell.tsx`, `edge-client.tsx`, `edge/src/messages/en.json` | `NAV_ENTRIES` names gated by bootstrap; `view` union with `'refused-captures'`; bootstrap fields `navigation`, `role`, `siteId`, `userId` | Three entries, two views, keys | `entriesFor(navigation)` contract; no client-side authorization; `authorizedFetch` for every call; `t()` for every string |
| `deploy/rehearsal/mock/generate.mjs`, `roles.json`, `world.json` | 21 people, 54 grants, `operations.actors` map | One grant per human person, one actor | Every existing id and grant (never regenerate the pack) |
| `deploy/rehearsal/mock/operations-smoke.ts` | Flows incl. `inboundBreach` with guarded SKIPs | One new flow | Existing PASS lines and their names |
| `docs/migration/pilot-cutover-runbook.md` | Rows through 2.10e (line 128) | Row 2.10f | Row order and column shape |
| `test/integration/story-1-8.test.ts` | Pins `navigation` to three names (212) | New pinned array | Everything else |

### Architecture compliance

- AD-3: approver still resolved by `resolveApprover('indent_approval', value)`; no role name in workflow code; `EMPLOYEE_MODULE` is a module label used by the gate only.
- AD-12: every write still passes `persistEvent` with `auditCtxFor`; the base role introduces no bypass.
- AD-14: availability reads the `stock_balance` projection and item master only; no new table, no new index, so `test/unit/schema-drift.test.ts` is unchanged.
- AD-16 and AD-18: offline requisition capture keeps the idempotency key and the edge outbox; the only change is which assignment satisfies the sweep for `indent.raised`.
- Compliance spine acceptance "no hard-coded roles bypass the registry": unchanged; add the new files to the lint scope automatically through `eslint src/ test/`.
- Story 1.2 contract: 401 `UNAUTHORIZED` and the three 403 codes remain the only denial codes; denials are still not audited (existing behaviour, not changed here).

### Library and framework requirements

No new dependency. Node test runner (`node --test`), `tsx`, Postgres 18.4 test container on port 5442, Next.js edge app under `edge/` with its own `tsc`, `eslint`, Playwright (`edge:test:e2e`) and axe (`edge:accessibility`). No web research was needed: nothing here touches a library surface that changed.

### Previous story intelligence

- Story 1.14 (done, `78d8ffd` baseline): edge screens are thin `page.tsx` wrappers around `<EdgeClient view=... />`; all state in `edge-client.tsx`; server-gated navigation; online-only screens show a needs-connection card; i18n allow-list before markup; review patches on dismiss row counts, quiet refetch, focus return, truncation indicators, per-card draft state, sibling-button disabling, live regions only with a message, response shape validation before React keys, real Tab presses in e2e. Operator task pattern (Task 6.5) copied here as 6.3. Deferred there and still relevant: duplicated RBAC matcher (`refused-captures.ts` vs `middleware/rbac.ts`), navigation not cached offline, no users lookup for display names.
- Story 3.12 (done 2026-09-27): one exported constant consumed by every site; pilot pack hand-edited to mirror `generate.mjs`; runbook row per staging check; smoke flows guard missing prerequisites with named SKIP lines; exact-value assertions and negative controls (Story 3.11 review rejected truthy assertions).
- Story 3.11: prettier needs `--end-of-line auto` under autocrlf; full suite 2435 after 3.12.

### Git intelligence

Baseline `4f5164c`, clean tree. The last eight commits all carry the subject `c`; read the diffs, not the messages. Recent files of note: `src/compliance/weighbridge.ts` (constant pattern), `test/integration/story-3-12.test.ts` (helper copies, pilot fixture reader `pilotHolderGrants`), `deploy/rehearsal/mock/operations-smoke.ts` (`inboundBreach` guards), `docs/migration/pilot-cutover-runbook.md` (row 2.10e).

### Testing standards

- Root: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts` (`npm test`); integration files boot `createAppServer(createAppRouter())` on port 0, provision users through SCIM with the test bearer, mint tokens through `POST /api/v1/auth/dev-token`, re-run projection DDL and TRUNCATE in `before`. Ad-hoc multi-file runs need `--test-concurrency=1`.
- Unit tests that pin the pilot pack read `roles.json` through `resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json')`.
- Edge: `npm run edge:test`, `edge:test:e2e`, `edge:accessibility`; i18n literal guard; `edge/test/e2e/offline-shell.spec.ts` has two known-red tests.
- Gates: `npx tsc --noEmit` (root, edge), `npm run lint`, `prettier --check --end-of-line auto`, `npm run verify:roles`, `test/unit/schema-drift.test.ts`.
- Assertions: exact values, negative controls, and for the availability body a recursive walk asserting no `number` typed value.

### Regression surface

`story-4-3` (indents), `story-4-7`, `story-1-8` (bootstrap pin), `story-1-14` (navigation and refused captures), `story-11-2-edge-sweep` (edge events write rule), `segregated-roles`, `provision-roles-core`, `no-hardcoded-role-in-workflow`, `story-3-12` (pack fixture reader), pilot sim day (`deploy/pilot/sim/pilot-day.ts` `indent` step runs as `indent1`, must stay green).

### Out of scope

- Story 8.9: damage report event, projection, route, screen, and the `Report damage` nav entry; 8.9 adds its (stream, event) pair to `EMPLOYEE_EDGE_EVENTS` and a `damage_reports` section to My requests.
- Story 4.8: standing approvals, self-approval limits, "Unit value" and approval-route chips, "Ready to collect".
- Story 4.9: `NOT_RESOLVED_APPROVER` fallback.
- Own-indent withdraw or confirm from the base role (D3).
- Availability "Low" state (needs min-max), "expected <date>" (needs open PO data), "Collect at <counter>".
- Display names for user ids on the edge, offline caching of `navigation`, consolidation of the duplicated RBAC matcher, auditing of RBAC denials.

### Project Structure Notes

- Server RBAC lives in `src/middleware/rbac.ts`; route handlers in `src/api/v1/*.ts`; wiring in `src/server.ts`; projections in `src/read/projections/*.ts` with SQL in `read/projections/*.sql`.
- Edge: `edge/app/<route>/page.tsx` wrappers, components in `edge/src/components/`, nav model in `edge/src/components/navigation/`, strings in `edge/src/messages/en.json`, session fetch in `edge/src/session/api-fetch.ts`. Do not touch `edge/src/sync/connector.ts`.
- Pilot pack: `docs/migration/pilot-mock-extract/{roles,world}.json` mirrored from `deploy/rehearsal/mock/generate.mjs`; provisioning CLI `src/cli/provision-roles*.ts`; segregation `src/cli/verify-segregated-roles-core.ts`.
- Variance: the access matrix is a planning artifact, not code; this story edits it (Task 4.4) because the SCP records that it defines no base role.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.15: Employee Base Role]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2] (401 and 403 codes, SCIM)
- [Source: _bmad-output/planning-artifacts/epics.md#Story 8.9] and [#Story 4.8] (dependencies)
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-09-26.md#4.1 New stories, #4.2 Evidence map, #4.4 SOD-01 amendment, #5 Implementation Handoff]
- [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md#2026-09-26 - UX run ratifications]
- [Source: _bmad-output/planning-artifacts/prds/.../archive/prd.md#FR-P-04, #UJ-IND-01, #NFR-SEC-02]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md#1 Principles, #2 Role Register, #3 Capability Matrix, #5 SOD]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#AD-3, #AD-12, #AD-14, #AD-16, #AD-18]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md#Information Architecture (lines 26-48), #State Patterns (107), #Requisitions and Standing Approvals (157-165), #Backend Dependencies (229), Q10 (253)]
- [Source: _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-requisitions.html lines 406, 450, 595-620, 683-692]
- [Source: _bmad-output/implementation-artifacts/1-14-refused-captures-supervisor-screen.md#Dev Notes, #Review Findings]
- [Source: _bmad-output/implementation-artifacts/3-12-weighbridge-breach-task-routing-for-pilot-roles.md#Dev Notes, #Change Log]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md lines 345-353, 1107-1116, 1173]
- [Source: src/middleware/rbac.ts:117-230; src/middleware/auth.ts:110-126; src/middleware/context.ts:4-9]
- [Source: src/api/v1/indents.ts:40-48, 108-119, 135-260, 290-345, 371, 412, 557-596]
- [Source: src/api/v1/stock.ts:11, 44-198; read/projections/stock_balance.sql:13-28; src/compliance/stock-balance.ts:73-108]
- [Source: src/api/v1/edge.ts:90-110, 277-300, 331-352, 640-660]
- [Source: edge/src/components/navigation/nav-model.ts; edge/src/components/app-shell.tsx:76-83, 227, 338; edge/src/components/edge-client.tsx:58-65, 196-202, 394]
- [Source: deploy/rehearsal/mock/generate.mjs:409-438, 558; docs/migration/pilot-mock-extract/roles.json; src/cli/verify-segregated-roles-core.ts:53]
- [Source: test/integration/story-3-12.test.ts:9-113; test/unit/weighbridge-breach-routing.test.ts:1-60; test/integration/story-1-8.test.ts:199-212]
- [Source: docs/migration/pilot-cutover-runbook.md rows 2.10d, 2.10e (lines 127-128)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

- 2026-09-27: Story created (create-story). Baseline 4f5164c. Eight binding decisions recorded (base role as a real `employee` assignment; any-of module gates; raise only; separate no-number availability endpoint; AC over mock on quantities; My requests through `mine=true`; table-driven bootstrap navigation; no base hat for service accounts). Status ready-for-dev.
