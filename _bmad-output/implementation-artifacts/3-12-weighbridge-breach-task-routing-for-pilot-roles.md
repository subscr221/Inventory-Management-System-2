---
baseline_commit: e4bc81c00bd3a83dbba1e3cb68b1065a309c650e
---
# Story 3.12: Weighbridge Breach Task Routing for Pilot Roles

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a warehouse manager at the pilot site,
I want weighbridge tolerance-breach tasks routed to a role that a real pilot account actually holds,
so that every breach reaches a person who can act on it instead of dying in a queue no one sees.

## Acceptance Criteria

1. **Given** a weighbridge event flagged `status: "tolerance_breach"` (Story 3.3), **when** the breach task is routed, **then** it targets a role present at pilot. Decision (recorded here, per the AC): the routing changes to `unloading_supervisor`; `receiving_supervisor` is NOT provisioned. See Binding Scope Decisions.
2. **Given** the corrected routing, **when** the routing role is resolved, **then** both code sites resolve the same role from one place: `src/compliance/weighbridge.ts:11` and `src/api/v1/weighbridge.ts:34` read one exported constant, and the string `receiving_supervisor` appears nowhere under `src/`.
3. **Given** the pilot role provisioning, **when** a tolerance breach fires in a staging rehearsal, **then** the task lands with an account that actually holds the target role (`unload1@ancorlabs.org` in the pilot pack), and that holder sees the breach reason (`next_step` of the in-app notification equals the weighbridge event's `tolerance_breach_reason`).
4. **Given** the regression suite, **when** it runs, **then** a test asserts that a tolerance breach reaches at least one real holder of the target role through the real dispatcher, and a test fails if the role has no holder in the pilot roles fixture (`docs/migration/pilot-mock-extract/roles.json`).

## Tasks / Subtasks

- [x] Task 1: Red tests first (AC: 2, 4)
  - [x] 1.1 New unit test `test/unit/weighbridge-breach-routing.test.ts`. Case A: import the exported role constant (Task 2.1) and assert it is `'unloading_supervisor'`. Case B: read `docs/migration/pilot-mock-extract/roles.json`, assert at least one entry in `roles` has `role` equal to the constant with `location_id` of `'site'` or `'*'`, and that each such `holder` is a key of `people`. The failure message must name the role and the fixture path. Case C: walk every `.ts` file under `src/` and assert none contains the literal `receiving_supervisor`.
  - [x] 1.2 New integration test `test/integration/story-3-12.test.ts` (fixture shape in Testing Standards). It must go red on the baseline: at 442a2f1 the breach targets `receiving_supervisor`, so the holder's notification list is empty.
  - [x] 1.3 Run both files and confirm they fail for the right reason (role mismatch, empty inbox, source literal found), not a fixture error.
- [x] Task 2: One routing role, both sites (AC: 1, 2)
  - [x] 2.1 In `src/compliance/weighbridge.ts`, replace line 11 with an exported constant `export const TOLERANCE_BREACH_OWNER_ROLE = 'unloading_supervisor';` and use it at the `emitNotificationInTransaction` call (line 350). Update the docstring on line 10 and the comment at lines 343-346 to name the unloading supervisor and cite the access matrix row (Dev Notes, Evidence).
  - [x] 2.2 In `src/api/v1/weighbridge.ts`, import the constant and build `WEIGHBRIDGE_READ_ROLES` as `['weighbridge_operator', TOLERANCE_BREACH_OWNER_ROLE, 'warehouse_manager']`. Delete the `'receiving_supervisor'` literal (no one holds it; removing it takes access from no account).
  - [x] 2.3 Confirm with `git grep receiving_supervisor -- src` that no hit remains. Leave the prose "receiving supervisor" comments in `src/compliance/receiving.ts` alone; they describe `unloading_supervisor` already (`receiving.ts:89`, `:96`).
- [x] Task 3: Green and regression (AC: 2, 4)
  - [x] 3.1 Run `test/unit/weighbridge-breach-routing.test.ts`, `test/integration/story-3-12.test.ts`, `story-3-3`, `story-3-4`, `story-3-8` (gate dwell reads weighbridge rows), `story-7-6` (weighbridge stamp lockout), and `story-1-11` (dispatcher) with `--test-concurrency=1`.
  - [x] 3.2 Run the full suite (`npm test`), `tsc --noEmit` at root, `npm run lint`, and prettier on changed files with `--end-of-line auto` (autocrlf makes prettier look red otherwise).
- [x] Task 4: Rehearsal smoke leg (AC: 3)
  - [x] 4.1 Add logical actor `unloading: emailOf('unload1')` to the `actors` map in `deploy/rehearsal/mock/generate.mjs` (around line 450), and the same key `"unloading": "unload1@ancorlabs.org"` by hand to `operations.actors` in `docs/migration/pilot-mock-extract/world.json` (line 811 onward). Do NOT regenerate the pack: regeneration rewrites ids and data the staging site already holds.
  - [x] 4.2 In `deploy/rehearsal/mock/operations-smoke.ts`, add a separate `flow` after `inbound` named "inbound: weighbridge breach reaches the unloading supervisor". Steps: (a) a new gate event (fresh `gate_event_id`, vehicle `UP81BR0001`, challan `CH-BR-` plus a fresh uuid fragment, because `ctx.run` is stable per site on remote re-runs) for the same operations PO, keeping its `correlation_id`; (b) a weighment on line 2 with `gross_kg: 7000 + ordered * 2` so net is double the ordered quantity, expecting 201 and `status === 'tolerance_breach'`; (c) as `unloading`, `GET /api/v1/notifications?type=weighbridge_tolerance_breach` until one has `object_id` equal to the weighbridge event id, then assert its `next_step` equals the weighment response's `tolerance_breach_reason`. Keep it a separate flow so a failure does not SKIP the rest of the day.
  - [x] 4.3 Dispatch in step (c): local mode has no dispatcher interval (`ops-lib.ts` builds the server with `createAppServer` only), so when `!ctx.remote` import `runDispatchCycle` from `src/notify/dispatch.js` and call it before reading. Remote mode relies on the app's interval (`NOTIFY_DISPATCH_INTERVAL_MS`, default 5000); poll every 2 s for up to 30 s, then fail with the last list length.
  - [x] 4.4 Update the header comment of `operations-smoke.ts` (lines 11-17) to list the breach leg and note that each remote run leaves one open gate event with a breach weighment (records are permanent).
  - [x] 4.5 Run the smoke locally (`node --env-file=.env.test --import tsx deploy/rehearsal/mock/operations-smoke.ts`); every line PASS.
- [x] Task 5: Runbook and staging verification (AC: 3)
  - [x] 5.1 Add runbook row 2.10e to `docs/migration/pilot-cutover-runbook.md` section 2 (after 2.10d, line 127): after the app image is rebuilt, confirm `unload1@ancorlabs.org` holds `unloading_supervisor` at the site (`verify:roles` or `SELECT` on `user_role_assignments`), run the operations smoke against staging (`--remote deploy/pilot/sim/staging-sim.json --pack docs/migration/pilot-mock-extract`), expect the breach leg PASS. The leg reads the notification with `unload1`'s own Keycloak token, which is the evidence that the holder sees the reason; the edge app has no notification screen today (`git grep api/v1/notifications -- edge/src` is empty), so there is no browser step. Follow FORMATTING_RULES.md (hyphens, no arrows).
  - [ ] 5.2 Staging run (operator task, like Story 1.14 Task 6.5): deploy by hand per runbook 2.15, execute 2.10e, record PASS and date in this story's Completion Notes. If the operator is not available, leave 5.2 unchecked and say so; do not mark it done on local evidence.
- [x] Task 6: Records (AC: 1)
  - [x] 6.1 Log in `_bmad-output/implementation-artifacts/deferred-work.md`: (a) escalation of an unacknowledged breach to `warehouse_manager` (access matrix row "Tolerance-breach acceptance band") is not built; the notification carries no `escalation`; (b) no breach acceptance or disposition action exists after Story 3.3 (the breach is a notification, not a durable task row); (c) breach notifications emitted before this fix on staging reached nobody and are not re-emitted; (d) the edge app has no notification inbox screen, so a supervisor sees a breach only through `GET /api/v1/notifications` or web push until one is built.
  - [x] 6.2 Run `graphify update .` after the code change.

### Review Findings

- [x] [Review][Defer] DOA-band magnitude/availability escalation to `warehouse_manager` not implemented — access-matrix row "Tolerance-breach acceptance band" (`access-matrix-frontline-draft-2026-07-11.md:303`, cited as this story's own routing evidence) conditions the target role on breach size and holder availability: `unloading_supervisor` accepts breaches up to 5 percent over tolerance; above 5 percent, or if `unloading_supervisor` is unavailable, `warehouse_manager` is the escalation approver. `applyWeighbridgeProjection` (`src/compliance/weighbridge.ts:355-362`) routes every `tolerance_breach` unconditionally to `TOLERANCE_BREACH_OWNER_ROLE` with no magnitude check and no availability/vacation-delegation check. The story's own smoke leg manufactures a +100%-over-ordered breach and still asserts it lands with `unloading_supervisor` — exactly the case the matrix routes to `warehouse_manager` instead. `deferred-work.md`'s prior entry ("escalation of an *unacknowledged* breach ... is not built") mischaracterized the gap as timeout-based; corrected there to name the real magnitude/availability condition. Deferred, pre-existing scope, not fixed in this story — reason: pilot is single-site/single-holder with no greater-than-5-percent breach traffic yet; full magnitude+availability escalation (DOA delegation lookup, notification payload shape, dispatch routing) is real scope for a follow-up story before scaling past pilot, not a quick patch here.
- [x] [Review][Patch] Harden `inboundBreach` smoke-leg assertions against unhelpful raw crashes [deploy/rehearsal/mock/operations-smoke.ts]: the weighment step's `orders.find(...)!.lines.find((l) => l.line_no === 2)!.ordered_qty` threw a bare `TypeError` (not the file's own contextual `Error` convention) if a future pack regeneration drops or renumbers PO line 2; the gate-entry step assigned `token = res['correlation_id'] as string` with no check that it was non-empty before the next request used it. Applied: both sites now throw a clear, contextual `Error` naming the PO/leg. tsc standalone check on the file (project compiler options) 0 errors.
- [x] [Review][Defer] Pilot pack hand-edited, not regenerated, with no drift test [docs/migration/pilot-mock-extract/roles.json, deploy/rehearsal/mock/generate.mjs] — deferred, pre-existing. `roles.json` and `world.json` were hand-edited to match `generate.mjs`'s new grant tuple for `unload1` rather than regenerated (deliberate, per Task 4.1: regeneration rewrites ids the staging site already holds). No test asserts the generator's tuple and the hand-added fixture entry stay in shape/value sync, so a future regeneration could silently diverge. This is the established pattern for this pack (predates this story), not introduced by this diff.
- [x] [Review][Defer] Integration negative control is synthetic and accepts `'*'` as a location match [test/integration/story-3-12.test.ts:116-135] — deferred, pre-existing test-coverage gap. `pilotHolderGrants()` treats `location_id === 'site'` and `location_id === '*'` as equally valid matches, and the site-B negative-control holder is created ad hoc rather than drawn from the fixture. A future fixture edit that widened `unload1`'s grant to `'*'` (receiving every site's breaches) would keep the suite green. Same class of gap as other existing role-fixture tests in this codebase; not unique to this diff.



### Binding Scope Decisions

- **Route to `unloading_supervisor`; do not provision `receiving_supervisor`.** The access matrix defines `unloading_supervisor` as the role that "owns unmatched-vehicle and tolerance-breach exceptions at receiving" and does not define `receiving_supervisor` at all (Evidence, Table 1). Receiving already routes its discrepancy tasks to the same role (`src/compliance/receiving.ts:89` `DISCREPANCY_TARGET_ROLE = 'unloading_supervisor'`). Provisioning a second role name for the same person would add a role the matrix does not have and split one owner across two names.
- **One constant, owned by the compliance seam.** `src/compliance/weighbridge.ts` emits the notification, so it owns the constant; the API module imports it. Do not create a shared roles module for one value, and do not reuse `DISCREPANCY_TARGET_ROLE` from `receiving.ts` (different flow; the two may diverge later).
- **Notification only, no escalation.** AC scope is "reaches a real holder". The matrix's escalation to `warehouse_manager` and a breach acceptance action are separate work; log them (Task 6.1), do not build them.
- **No backfill.** Breach notifications already emitted with target `receiving_supervisor` were dispatched to zero recipients (`resolveTargetUserIds` returned an empty list, so the event is claimed and done). They are staging rehearsal data; production starts clean. Do not write a re-emit script.
- **No data migration, no schema change, no new route, no new error code.** The target role lives in the `notification.created` payload only.

### Evidence

Table 1 traces the routing decision to its sources.

Table 1: Routing decision evidence

| **Source** | **What it says** |
| --- | --- |
| `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` line 40 | `unloading_supervisor`: owns unmatched-vehicle and tolerance-breach exceptions at receiving, assigned sites |
| same file, line 303 | Tolerance-breach acceptance band: `unloading_supervisor` primary, `warehouse_manager` escalation |
| `docs/migration/pilot-mock-extract/roles.json` lines 258-271 | `unload1@ancorlabs.org` holds `unloading_supervisor` (receiving write, inventory read) at `site` |
| `src/compliance/receiving.ts:89` | receiving discrepancy tasks already target `unloading_supervisor` |
| EXPERIENCE.md line 236 (UX run 2026-09-23) | the defect as found: pilot roles file has only `unloading_supervisor` |

### How a Breach Reaches a Person

1. `POST /api/v1/weighbridge-events` persists `weighbridge.recorded`; `applyWeighbridgeProjection` computes the band in SQL and, on breach, calls `emitNotificationInTransaction` with `target: { role, location_id: siteId }` in the same transaction (`src/compliance/weighbridge.ts:347-362`).
2. The dispatcher (`src/notify/dispatch.ts` `runDispatchCycle`, in-process interval in `src/server.ts:1448`) resolves recipients with `SELECT DISTINCT user_id FROM user_role_assignments WHERE role = $1 AND (location_id = $2 OR location_id = '*')` (`dispatch.ts:106-122`). Module and function scope are ignored; only role and location matter.
3. One `notifications` row per user, `next_step` set to the breach reason. The holder reads it with `GET /api/v1/notifications?type=weighbridge_tolerance_breach` (`src/api/v1/notification.ts:155`, filter `event_type`).

A role with no holder yields zero rows and no error anywhere. That silence is the defect; the regression test must observe delivery to a user, not only the emitted event.

### Current State of Files Being Modified

- `src/compliance/weighbridge.ts` (363 lines): stamp lockout (Story 7.6), shape assert, projection with SQL NUMERIC band, breach notification. Only line 10-11 and the comment at 343-346 change, plus the constant use at 350. Preserve everything else, including the transactional emit (a breach is never persisted without its alert).
- `src/api/v1/weighbridge.ts` (348 lines): `WEIGHBRIDGE_READ_ROLES` at 30-35 gates GET one and GET list through `assertRoleAllowed` (modules `inventory`, `*`, `gate`, `weighbridge`, read scope). `unload1` holds inventory read at the site, so it can already read breach rows. Only the array changes.
- `deploy/rehearsal/mock/operations-smoke.ts`: modified and uncommitted by Story 3.11 (the `grn()` helper gained `reason_code`/`reason_detail`). Build on the working-tree version.
- `deploy/rehearsal/mock/generate.mjs` and `docs/migration/pilot-mock-extract/world.json`: one added actor key each. `deploy/rehearsal/mock/out/` is gitignored; ignore it.
- `docs/migration/pilot-cutover-runbook.md`: one added row.

### Testing Standards

`node:test` against the real test Postgres (`ims-postgres-test`, port 5442, recreated from `init-db.sql`); ad-hoc multi-file runs need `--test-concurrency=1`. Copy the `story-3-3.test.ts` harness (SCIM provisioning, dev-token, site and PO seeding, `PO-WB-1` band [3430, 3570]) and add `../../read/projections/notification.sql` to the DDL list plus `notification_escalations, notification_escalation_defs, notification_deliveries, notifications, notification_dispatch_log, notification_dispatch_attempts` to the TRUNCATE (all defined in `read/projections/notification.sql`; `push_subscriptions` and `notification_preferences` can stay). `story-1-11.test.ts` is the reference for calling `runDispatchCycle()` directly.

Integration cases for `test/integration/story-3-12.test.ts`:

1. Holder from the fixture: read `docs/migration/pilot-mock-extract/roles.json`, take the grants of the first holder of `TOLERANCE_BREACH_OWNER_ROLE`, map `location_id: 'site'` to site-A, provision that person through SCIM. Fail with a clear message if the fixture has no holder.
2. A second holder of the same role at site-B (negative control).
3. A breach at site-A (`gross_kg: 16000`, net 4000). Run `runDispatchCycle()`. As the site-A holder, the list holds exactly one notification whose `object_id` is the weighbridge event id, `event_type` is `weighbridge_tolerance_breach`, and `next_step` equals the 201 response's `tolerance_breach_reason`. The site-B holder's list is empty.
4. The emitted `notification.created` event's `payload.target.role` equals the constant (query `domain_events`, compare typed values).
5. An accepted weighment (`gross_kg: 15500`) emits no `notification.created` event.

Assert both HTTP status and body; Story 3.11 code review flagged assertions that could never fail, so compare exact values rather than truthiness.

### Regression Surface

No existing test asserts `receiving_supervisor`: `git grep receiving_supervisor -- test` returns nothing at 442a2f1. Suites that exercise weighbridge: `story-3-3`, `story-3-4` (weighbridge token before GRN), `story-3-8` (gate dwell), `story-7-6` (stamp lockout), `story-9-7` (graph links `weighbridge_event.ts`), and the rehearsal smoke. The dispatcher suites (`story-1-11`, `story-4-3`, `story-4-4`, `story-9-5`) share the notification tables; run them after the new suite to confirm truncation does not leak.

### Previous Story Intelligence

- Story 3.11 (done 2026-09-27, uncommitted): pure seam changes plus a story-local test file; code review wanted exact-value assertions and negative controls; prettier needs `--end-of-line auto` under autocrlf; the full suite was 2428/2428 after review.
- Story 3.3: the breach notification was added in code review ("decision: wire via `emitNotificationInTransaction` targeting `receiving_supervisor`"), which is how an unmatrixed role entered the code. The Story 3.3 AC3 test checks the `tolerance_breach` status and list only, never delivery.
- Story 1.14: staging checks the dev cannot run are a runbook row plus an operator task left open until executed (Task 6.5 pattern).

### Git Intelligence

HEAD 442a2f1 (Story 7.9). The working tree holds Story 3.11 uncommitted (21 modified files plus 5 untracked, including `operations-smoke.ts`). Commit Story 3.11 before starting, or record this story's baseline as the working tree on top of 442a2f1; otherwise the File List and a later review diff mix the two stories. Weighbridge code has not changed since Story 7.6.

### Latest Technical Information

No new library or version is involved. The change uses existing modules only (`node:test`, `pg`, the in-repo notification dispatcher).

### Project Structure Notes

- Unit tests live in `test/unit/`, integration in `test/integration/`, both picked up by `npm test` (`test/**/*.test.ts`).
- Reading `docs/migration/pilot-mock-extract/roles.json` from a test is new; resolve the path from the test file (`resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json')`), as `story-3-3.test.ts` does for SQL files.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.12]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-09-26.md, Table 1 row 3.12, Table 2]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md, line 40, line 177, line 303]
- [Source: ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md, line 90 and line 236]
- [Source: _bmad-output/implementation-artifacts/3-3-weighbridge-event-capture-and-tolerance-enforcement-uj-weigh-01-fr-w-02.md, Review Findings]
- [Source: src/notify/emit.ts, src/notify/dispatch.ts]
- [Source: deploy/rehearsal/mock/README.md, deploy/rehearsal/mock/ops-lib.ts]
- [Source: docs/migration/pilot-cutover-runbook.md, section 2, rows 2.10d and 2.15]

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1)

### Debug Log References

### Implementation Plan

- Red first: `test/unit/weighbridge-breach-routing.test.ts` (Cases A, B, B2, C) and `test/integration/story-3-12.test.ts` (fixture-driven holder at site-A, negative-control holder at site-B, real `runDispatchCycle`, `notification.created` payload check, accepted weighment emits nothing). To get a meaningful red, the constant was first exported under its new name with the OLD value: unit 0/4 (role mismatch, no fixture holder, literal found in src), integration 0/3 (no holder of `receiving_supervisor` in roles.json).
- Green: one exported constant `TOLERANCE_BREACH_OWNER_ROLE = 'unloading_supervisor'` in `src/compliance/weighbridge.ts`, imported by `src/api/v1/weighbridge.ts` for `WEIGHBRIDGE_READ_ROLES`; `receiving_supervisor` literal deleted. Docstring and the emit comment cite the access matrix rows.
- Smoke leg as its own `flow` (`inboundBreach`) after `inbound`; local mode runs `runDispatchCycle` by hand, remote mode polls 2 s for up to 30 s.

### Debug Log References

- Gap found while tracing AC3: `unload1@ancorlabs.org` held `receiving` write and `inventory` read only. `GET /api/v1/notifications` is gated by `requireRole({ module: 'notification', functionScope: 'read' })` (`src/api/v1/notification.ts:394`), so the routed holder would have answered 403 and AC3 ("that holder sees the breach reason") could not hold. Resolution, inside AC3 scope: added `['unloading_supervisor', 'notification', R, 'site']` to `unload1` in `deploy/rehearsal/mock/generate.mjs` and by hand to `roles.json` (pack not regenerated), unit Case B2 asserts every holder of the owner role has a `notification` grant, and runbook 2.10e re-applies roles before the smoke. Logged as a role-review question in deferred-work.
- Full suite first run: 2434/2435, the one failure `story-7-9.test.ts` AC1 (spare amend). Rerun alone: 17/17. Not touched by this story (no weighbridge or notification code in it); order-dependent. Final full run recorded below.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created (create-story 2026-09-27). Routing decision taken from the access matrix, not asked: `unloading_supervisor`.
- Task 1: red confirmed for the right reasons (see Implementation Plan). Task 2: both sites read `TOLERANCE_BREACH_OWNER_ROLE`; `git grep receiving_supervisor -- src` empty. Task 3: focused set (new unit + story-3-12, 3-3, 3-4, 3-8, 7-6, 1-11) 128/128 with `--test-concurrency=1`; `tsc --noEmit` clean; `npm run lint` clean; prettier `--end-of-line auto` clean on the four changed TS files and the smoke.
- Task 4: `inboundBreach` flow added (3 steps), actor `unloading` in `generate.mjs` and `world.json`, header comment updated. Local smoke (`node --env-file=.env.test --import tsx deploy/rehearsal/mock/operations-smoke.ts`): every line PASS; breach leg reported `net 10000.000 kg flagged` and `ops-unload1-...@example.com sees the breach: Net weight 10000.000 kg is outside the accepted tolerance band [...]`. The smoke's standalone `tsc` check on `operations-smoke.ts` reports 0 errors (deploy/ is outside `tsconfig.json` include).
- Task 5.1: runbook row 2.10e added after 2.10d (re-apply roles, verify `unload1` grants, run remote smoke, expect three breach-leg PASS lines). Task 5.2 NOT done: staging run is an operator task; no operator available in this session, box not deployed by the dev. Left unchecked on purpose.
- Task 6: deferred-work section written (escalation to `warehouse_manager`, no acceptance action, no backfill, no edge inbox, plus the notification-grant question). `graphify update .` run after the code change.
- Final full suite: see Change Log entry of 2026-09-27.

### File List

- src/compliance/weighbridge.ts (modified: exported `TOLERANCE_BREACH_OWNER_ROLE`, docstring, emit comment)
- src/api/v1/weighbridge.ts (modified: import constant, `WEIGHBRIDGE_READ_ROLES`, literal removed)
- test/unit/weighbridge-breach-routing.test.ts (new)
- test/integration/story-3-12.test.ts (new)
- deploy/rehearsal/mock/operations-smoke.ts (modified: header, `inboundBreach` flow, call in `main`)
- deploy/rehearsal/mock/generate.mjs (modified: `unload1` notification read grant, actor `unloading`)
- docs/migration/pilot-mock-extract/roles.json (modified by hand: `unload1` notification read grant)
- docs/migration/pilot-mock-extract/world.json (modified by hand: `operations.actors.unloading`)
- docs/migration/pilot-cutover-runbook.md (modified: row 2.10e)
- _bmad-output/implementation-artifacts/deferred-work.md (modified: Story 3.12 section)
- _bmad-output/implementation-artifacts/sprint-status.yaml (modified: story status)
- _bmad-output/implementation-artifacts/3-12-weighbridge-breach-task-routing-for-pilot-roles.md (this file)

## Change Log

- 2026-09-27: Story created (create-story). Status ready-for-dev.
- 2026-09-27: Implemented (dev-story). Breach routing moved to `unloading_supervisor` through one exported constant used by compliance and API; `unload1` gained a `notification` read grant in the pilot pack; smoke breach leg, runbook 2.10e, deferred-work entries. Unit 4/4, story-3-12 3/3, focused set 128/128, full suite 2435/2435, tsc/lint/prettier clean, local smoke all PASS. Task 5.2 (staging run) open for the operator. Status review.
- 2026-09-27: Code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel). 1 decision resolved (DOA-band magnitude/availability escalation to `warehouse_manager` not implemented, cited access-matrix row conditions the target role on breach size and holder availability, not just acknowledgment timeout; deferred to a follow-up story before scaling past pilot, `deferred-work.md` entry corrected to state the real condition), 1 patch applied (`operations-smoke.ts` `inboundBreach` guards against unhelpful raw crashes on a missing PO line or empty correlation_id; standalone tsc clean), 2 deferred (pilot-pack hand-edit drift has no sync test; integration negative control is synthetic and accepts `'*'` as a location match), 11 dismissed. Status done.
