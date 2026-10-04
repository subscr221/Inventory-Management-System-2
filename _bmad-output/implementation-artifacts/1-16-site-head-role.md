---
baseline_commit: a1d0de0
---

# Story 1.16: Site Head Role

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a site head,
I want a provisioned `site_head` role recognised by RBAC and the DOA registry,
so that site-level authorities (standing approval grants, self-approval limits) resolve to a real person instead of a stand-in role.

PILOT. Prerequisite of Story 4.8 (user ruling 2026-09-29). Epic 1 is already `in-progress`.

## Acceptance Criteria

1. **Registered in the access matrix.** Given the access matrix, when this story lands, then section 2 registers `site_head` (location scope: site) with its capability rows, and the role is in the pilot role pack.
2. **Provisioned and verified.** Given the pilot provisioning path (roles file, Keycloak accounts, `staging-provision-roles.sh`), when roles are applied, then a named `site_head` holder exists per pilot site and `verify:roles` reports it.
3. **Resolved at the transaction site.** Given the DOA registry, when a transaction type names `site_head`, then `findRoleHolder` and delegation resolve a `site_head` holder at the transaction site like any other role.
4. **Refused for everyone else.** Given a user who is not a site head, when they call a site-head-gated action, then it is refused with `FUNCTION_ACCESS_DENIED`.

Source: [epics.md Story 1.16](../planning-artifacts/epics.md), user ruling 2026-09-29 (Story 4.8 open questions).

## Tasks / Subtasks

- [x] Task 1: Red tests first (AC: 1, 2, 3, 4)
  - [x] 1.1 Unit `test/unit/site-head-role-pack.test.ts` (pattern: `test/unit/employee-base-role-pack.test.ts`, which reads the pack through `resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json')`). Assert: exactly one holder of `site_head` in the pack and it is `cmf_supervisor@ancorlabs.org`; that holder has exactly the three `site_head` rows in Table 1; every `site_head` row has `location_id: 'site'` (never `'*'`); the same holder still has its three `warehouse_manager` rows and its `employee` row; no holder of `site_head` holds `finance_controller` or `cfo`; `deploy/provision/roles.example.json` gives `site.head@example.com` the same three `site_head` rows; `forbiddenPairs()` contains both pairs in D6; `planProvisioning` on the pilot pack returns zero violations and zero errors; every role in `REQUIRED_SITE_ROLES` has at least one holder in the pack at `'site'`. Confirm red.
  - [x] 1.2 Integration, extend `test/integration/segregated-roles.test.ts`: `verifySegregatedRoles` returns one `required_roles` entry per required role per active site (see D5, four roles); with a holder at the site the entry is `ok: true` and the formatted report contains the line in D5; with no holder the result carries violation code `ROLE_UNHELD_AT_SITE` naming the role and the site, `ok` is false, and the closing line is the existing not-ready line. Negative controls: a holder at a different site does not satisfy this site; a holder at `'*'` does; an inactive user does not. The seven existing calls in this file pass `[]` as the new fourth argument so they keep testing pairs only. Confirm red.
  - [x] 1.3 Integration `test/integration/story-1-16.test.ts` (copy `makeRequest`, `provisionUser`, `authFor`, `Role` from `test/integration/story-3-12.test.ts`; boot and truncate as `story-1-15.test.ts` does). Personas: `headA` with the Table 1 rows at site A (concrete UUID); `headB` with the same rows at site B, provisioned BEFORE `headA` so it is the older assignment; `wm` with `warehouse_manager` inventory write at site A only; `emp` with only the employee base hat at site A. Cases, each with exact values and a negative control:
    - resolution (AC 3): `findRoleHolder('site_head', client, siteAId)` returns `headA`; `findRoleHolder('site_head', client, siteBId)` returns `headB`; `findRoleHolder('site_head', client)` with no location returns `headB` (the oldest, unchanged behaviour); a holder assigned at `'*'` satisfies any site; an unknown site returns null.
    - delegation (AC 3): add an active delegation from `headA` to `wm`. Resolve the way `resolveApprover` does (`indents.ts:83-88`): `findRoleHolder('site_head', client, siteAId)`, then `findActiveDelegation(holder.user_id, today)`. Assert the delegate is `wm` inside the window and that there is no delegation outside it, so the approver is `headA` (reuse the Story 1.4 AC2 shape in `test/integration/story-1-4.test.ts:237`). `headB` has no delegation and resolves to itself.
    - membership (AC 3): register a DOA entry naming `site_head` through `POST /api/v1/doa/entries` (a test-only transaction type such as `test.site_head_authority`), then `isActiveRoleHolderForEntry(entryId, headA, client, siteAId)` is true; with `siteBId` it is false; with no location it is true (unchanged behaviour).
    - gate (AC 4): on the existing site-head-gated action (D7), `emp` and `wm` get 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles` equal to `['compliance_officer', 'site_head']`; `headA` passes the gate for a site A clock; `headA` is refused on a site B clock with the code the route already uses for out-of-scope sites (read it from `test/integration/story-9-5.test.ts:1866`, do not invent one).
  - [x] 1.4 Run the three files and record the red output in Debug Log References.
- [x] Task 2: Location-aware resolution (AC: 3)
  - [x] 2.1 `src/read/projections/doa_registry.ts`: `findRoleHolder(role, client?, locationId?)`. When `locationId` is given, add `AND (a.location_id = $2 OR a.location_id = '*')`, the same clause `resolveTargetUserIds` uses in `src/notify/dispatch.ts:106-122`. Keep `ORDER BY a.created_at ASC, a.assignment_id ASC LIMIT 1`. With no `locationId` the SQL and result are byte-for-byte what they are today. Update the docstring: the "no location dimension" sentence is no longer true.
  - [x] 2.2 Same file: `isActiveRoleHolderForEntry(entryId, userId, client?, locationId?)` with the same optional clause on `a.location_id`.
  - [x] 2.3 Do NOT change any existing caller (34 importers of `findRoleHolder`). Do NOT change `resolveApprover` in `src/api/v1/indents.ts:70-106`; Stories 4.9 and 4.10 own that function.
- [x] Task 3: Pilot pack and provisioning (AC: 1, 2)
  - [x] 3.1 `deploy/rehearsal/mock/generate.mjs:415`: append the three Table 1 grants to the `cmf_supervisor` entry, after the `warehouse_manager` grants. Add actor `sitehead: emailOf('cmf_supervisor')` to the actors map (next to `whmanager`, line 461).
  - [x] 3.2 `docs/migration/pilot-mock-extract/roles.json` and `world.json`: edit by hand to match, then prove it with a scratch regeneration whose `roles` array and `actors` map are identical to the hand-edited files (the Story 1.15 method). The pack goes from 76 grants to 79. `world.json` `people[].roles` for `cmf_supervisor` becomes `['warehouse_manager', 'site_head']`.
  - [x] 3.3 `deploy/provision/roles.example.json`: add the three rows for `site.head@example.com`.
  - [x] 3.4 `deploy/provision/staging-bootstrap-accounts.sh:104-105`: add the three rows for `$SITEHEAD` to the heredoc. Mind the JSON commas: line 105 is currently the last element.
  - [x] 3.5 `src/cli/provision-roles-core.ts:55`: add the two D6 pairs to `EXTRA_FORBIDDEN_PAIRS`.
  - [x] 3.6 Do NOT run `provision:roles --apply` with the pilot pack against the local test database (see Previous story intelligence).
- [x] Task 4: `verify:roles` reports the role (AC: 2)
  - [x] 4.1 `src/cli/verify-segregated-roles-core.ts`: add `REQUIRED_SITE_ROLES` (four roles) and the `required_roles` report per D5. Signature becomes `verifySegregatedRoles(pool, pairs?, today?, requiredRoles = REQUIRED_SITE_ROLES)`. Everything stays read-only.
  - [x] 4.2 `formatSegregatedRolesReport`: print the required-role lines after the pair lines and before the violations. The closing line keeps its two existing wordings.
  - [x] 4.3 `src/cli/verify-segregated-roles.ts` needs no change if the core keeps its exported names; confirm and leave it.
- [x] Task 5: Access matrix (AC: 1)
  - [x] 5.1 `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` section 2: new subsection "Site leadership" with the `site_head` row from Table 2, placed after "Warehouse and inventory".
  - [x] 5.2 Section 3: new subsection "3.10 Site head" with the capability rows from Table 3, introduced by a sentence that names the table.
  - [x] 5.3 Section 5: one line under the SOD table recording the D6 pairs and the 2026-09-06 ruling they come from.
  - [x] 5.4 Section 9 changelog: row v1.3 dated with the implementation date, naming Story 1.16.
  - [x] 5.5 Load `FORMATTING_RULES.md` before editing any Markdown file: hyphens, no arrow characters in prose, every table named in the text.
- [ ] Task 6: Staging and close-out (AC: 2)
  - [x] 6.1 `docs/migration/pilot-cutover-runbook.md`: new row 2.10h after 2.10g and before 2.10b, same column shape. Steps: rebuild the app image; re-apply the pilot roles with `deploy/provision/staging-provision-roles.sh docs/migration/pilot-mock-extract/roles.json --apply`; run `verify:roles` in the app container; expected evidence is the four required-role lines from D5, each showing one holder at CMF-ALIGARH, and the existing pair lines unchanged.
  - [x] 6.2 `deploy/rehearsal/mock/operations-smoke.ts`: one new flow `siteHead(ctx)` called from `main` after `employeeRequisition`. It asserts through the API that the `sitehead` actor holds `site_head` at the site and that a non-holder is refused on the D7 action. Use the guarded SKIP pattern of `inboundBreach` when the world has no job-work clock to act on. Existing PASS lines and their names must not change.
  - [ ] 6.3 Operator task (Story 3.12 convention): staging deploy per runbook 2.15, then run row 2.10h and record PASS in Completion Notes.
  - [x] 6.4 Gates: `npx tsc --noEmit` (root and edge), `npm run lint`, `prettier --check --end-of-line auto`, `npm run verify:roles`, `test/unit/schema-drift.test.ts`, full `npm test`.
  - [x] 6.5 `graphify update .` after the code changes.

### Review Findings

Code review 2026-09-30 (Blind Hunter, Edge Case Hunter, Acceptance Auditor; diff against `ec7ce0a`, 14 files). All four Acceptance Criteria were judged MET. 2 decisions, 9 patches, 3 deferred, 7 dismissed.

- [x] [Review][Decision] The bootstrap path names no `qc_head` holder - `staging-bootstrap-accounts.sh` and `roles.example.json` provision five people and none is the QC head, so on a fresh box `verify:roles` reports `FAIL qc_head` and runbook row 2.9a cannot show its expected closing line until the pilot pack is applied. Options: add an optional seventh argument for the QC head, or reword the evidence of rows 2.9 and 2.9a, or defer. RESOLVED by owner ruling 2026-09-30: reword the runbook. Rows 2.9 and 2.9a and the script header now say the `qc_head` line is expected until the pilot roles file is applied; the script keeps its six arguments.
- [x] [Review][Decision] Test deviations 2 and 3 carry no owner ruling - the wildcard case uses a run-scoped role instead of `site_head`, and the `segregated-roles` cases assert on the rows the suite owns. Both are recorded in Completion Notes; only deviation 1 is ruled. RESOLVED by owner ruling 2026-09-30: both accepted, no code change.
- [x] [Review][Patch] Location UUIDs are stored as typed, so an upper-case `site_id` in a roles file is not matched by the new located lookups [src/cli/provision-roles-core.ts:108]
- [x] [Review][Patch] Docstring says a caller that lost its site resolves nobody; a holder at `'*'` still resolves, and only a site id is accepted (no zone or bin) [src/read/projections/doa_registry.ts:299]
- [x] [Review][Patch] Header comment for `ROLE_UNHELD_AT_SITE` reads as if approvals already resolve at the site; no caller passes a location yet (Task 2.3) [src/cli/verify-segregated-roles-core.ts:34]
- [x] [Review][Patch] `requiredRoles` is not de-duplicated, so a repeated role doubles its lines and violations [src/cli/verify-segregated-roles-core.ts:337]
- [x] [Review][Patch] `tail -8` cuts the longer report [deploy/provision/staging-bootstrap-accounts.sh:115, deploy/provision/staging-doa-bands.sh:57]
- [x] [Review][Patch] The smoke flow and runbook row 2.10h say nothing is changed; the refused correction leaves one audit row per run [deploy/rehearsal/mock/operations-smoke.ts:514, docs/migration/pilot-cutover-runbook.md:131]
- [x] [Review][Patch] The smoke SKIP message blames the site head actor when any of three actors is missing [deploy/rehearsal/mock/operations-smoke.ts:530]
- [x] [Review][Patch] Changelog v1.3 says four rows are delivered by Story 4.8; the table has three, plus one not permitted [_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:373]
- [x] [Review][Patch] The unit test reads `REQUIRED_SITE_ROLES` through a cast left over from the red phase [test/unit/site-head-role-pack.test.ts:58]
- [x] [Review][Defer] Forbidden pairs are enforced only by the roles-file planner, not by SCIM and not by `verify:roles` [src/cli/provision-roles-core.ts:55] - deferred, pre-existing
- [x] [Review][Defer] With a location, an older holder at `'*'` outranks the site's own holder, and no test covers the mixed case [src/read/projections/doa_registry.ts:312] - deferred, pre-existing
- [x] [Review][Defer] `world.json` `people[].roles` omits `employee`, which the generator writes; the unit test pins the committed form [docs/migration/pilot-mock-extract/world.json] - deferred, pre-existing

## Dev Notes

The role name already exists in code. This story makes it real in data, documents it, and gives DOA resolution a site dimension. It adds no route, no table, no migration and no edge screen.

### Binding decisions

- **D1 No vocabulary change.** Roles are free text in `user_role_assignments.role` and `doa_registry_entries.role` (ruled 2026-09-06, epics.md Story 9.7 dev notes). There is no enum to extend and no schema change. `schema-drift` must stay green with zero DDL edits.
- **D2 The pilot holder is the person already called Site Head (owner ruling 2026-09-30: keep both hats).** `cmf_supervisor@ancorlabs.org` has display name "Site Head" and today wears `warehouse_manager` as the stand-in. That person gains `site_head` and KEEPS `warehouse_manager`: they are the only `warehouse_manager` holder in the pack, and `inventory.count_adjustment`, `transfer_request`, `receiving.quarantine` and `receiving.putaway_release` resolve to that role (`generate.mjs:474-480`). Removing it would turn those approvals into 409 `APPROVAL_UNRESOLVED`.
- **D3 Grants are site-scoped.** Table 1 lists the three rows. `location_id` is `'site'` in the roles file, which the planner resolves to the file's `site_id` (`provision-roles-core.ts:96`). Never `'*'`: the matrix scope is "site", and a wildcard site head would satisfy every site in D4 and D5.
- **D4 Location is an optional argument, not a new function.** `findRoleHolder` and `isActiveRoleHolderForEntry` gain a trailing optional `locationId`. Existing callers pass nothing and behave exactly as before. Story 4.8 (its D3) will pass the grant site. A second resolver would split DOA resolution into two idioms, which the Story 9.7 dev notes forbid ("Do not invent a second approval idiom").
- **D5 `verify:roles` gains a required-role section (owner ruling 2026-09-30: four roles).** Today the report lists only segregated pairs, and `site_head` is in no pair, so AC 2 cannot be met without a change. Add `REQUIRED_SITE_ROLES: readonly string[] = ['site_head', 'warehouse_manager', 'department_head', 'qc_head']`. Table 5 gives the reason for each. For each role and each active site (a `location_register` row with `level = 'site'` and `status = 'active'`, the convention used in `src/compliance/service-order.ts:570`), report the active holders whose assignment is at that site or at `'*'`. Report shape: `required_roles: Array<{ role, site_id, site_code, holder_user_ids, ok }>`. Violation code `ROLE_UNHELD_AT_SITE` with an operator sentence that names the fix. Line format: `OK   site_head at <site_code>: <n> holder(s)` or `FAIL site_head at <site_code>: 0 holder(s)`. An unheld required role makes `result.ok` false. With no active site registered the section is empty and does not fail, so `npm run verify:roles` on a fresh local database behaves as it does today. The list is a default argument, so tests can pass `[]` or a single role.
- **D6 The site head holds neither finance hat (owner ruling 2026-09-30: enforce at provisioning).** Ruled 2026-09-06 (access matrix lines 103-110, epics.md Story 9.7): `finance_controller` and `cfo` are separate people and the site head holds neither. Story 4.8 depends on it, because the site head assigns a grant and the finance department head approves it. Add to `EXTRA_FORBIDDEN_PAIRS`: `{ a: 'site_head', b: 'finance_controller' }` and `{ a: 'site_head', b: 'cfo' }`, each with a reason that cites the ruling. These are assignment-time pairs only. They are NOT `SEGREGATED_ROLE_PAIRS` entries: those need a DOA transaction type, and the standing-grant types are seeded by Story 4.8.
- **D7 AC 4 is proven on the gate that exists.** The challan classification correction is already gated on `CHALLAN_RECLASSIFICATION_ROLES` (`compliance_officer`, `site_head`) and already answers 403 `FUNCTION_ACCESS_DENIED` (`src/api/v1/service-orders.ts:1323-1337`, handler `patchReturnClockClassificationHandler`). This story adds no new gated route. Story 4.8 adds its own gates and its own refusal code `GRANT_ASSIGNER_NOT_AUTHORIZED`.
- **D8 Keycloak carries accounts, not roles.** No file under `deploy/` defines realm roles; roles reach the system through the roles file and SCIM. The `cmf_supervisor@` account already exists on staging (runbook 2.9). The "Keycloak role pack" wording in AC 2 is satisfied by the roles file and the bootstrap script.
- **D9 No edge change.** Bootstrap navigation is table-driven by module (Story 1.15 Table 3). `site_head` brings `jobwork` and `notification` grants, neither of which adds a menu entry today. Do not touch `edge/`.

Table 1 lists the grants every `site_head` holder receives.

Table 1: Site head grants

| Role | Module | Function scope | Location | Why |
|---|---|---|---|---|
| `site_head` | `jobwork` | write | site | The existing reclassification gate requires `jobwork` write (`service-orders.ts:1323-1328`) |
| `site_head` | `jobwork` | read | site | Matches the fixtures in `story-9-5` to `story-9-8`; lets the holder open what they are alerted about |
| `site_head` | `notification` | read | site | The site head is the escalation target of both job-work sweeps; without this grant the in-app notice cannot be read (Story 3.12 gave `unload1` the same row) |

Table 2 is the row for section 2 of the access matrix.

Table 2: Role register row

| Role ID | Description | Location scope | Anchors |
|---|---|---|---|
| `site_head` | Site-level authority: escalation target for job-work clocks and billing, challan classification correction, and (Story 4.8) assigning standing approvals and self-approval limits. Holds neither `finance_controller` nor `cfo`. | Site | FR-JW-09/10, FR-P-04, Stories 1.16, 4.8, 9.5, 9.6 |

Table 3 lists the capability rows for the new section 3.10.

Table 3: Site head capabilities

| Capability | site_head | Status |
|---|---|---|
| Correct a challan classification (statutory clock) | U | Live (Story 9.5) |
| Receive job-work clock and billing escalations | R | Live (Stories 9.5, 9.6) |
| Assign a standing approval | C | Story 4.8 |
| Assign a per-person self-approval limit | C | Story 4.8 |
| Revoke a grant they assigned | U | Story 4.8 |
| Approve their own grant | Not permitted | Finance department head approves (SOD-01 as amended) |

Table 5 lists the roles `verify:roles` requires at every active site and what stops when one has no holder.

Table 5: Roles required at every site

| Role | Pilot holder | What stops without a holder |
|---|---|---|
| `site_head` | `cmf_supervisor@ancorlabs.org` (after this story) | Job-work escalations have no recipient; Story 4.8 grants cannot be assigned |
| `warehouse_manager` | `cmf_supervisor@ancorlabs.org` | Count adjustment, transfer, quarantine and putaway release answer 409 `APPROVAL_UNRESOLVED` |
| `department_head` | `subscr@ancorlabs.org` | Indent, purchase order and supplier onboarding approvals cannot resolve |
| `qc_head` | `qchead1@ancorlabs.org` | The QC key on damage cases and lot disposition has nobody to turn it |

### Evidence

- `site_head` in code today: `src/compliance/jobwork-return-clock.ts:317-320` (`CHALLAN_RECLASSIFICATION_ROLES`), `src/notify/jobwork-clock-sweep.ts:39` and `:207` (`JOBWORK_CLOCK_SITE_HEAD_ROLE`, resolved at `clock.site_id`), `src/notify/jobwork-billing-sweep.ts:34` and `:142`.
- `site_head` in data today: none. The pilot pack has 24 distinct roles and 76 grants, and `site_head` is not among them. `test/integration/story-9-5.test.ts:1232` records the gap: "site_head had no holder anywhere in the repository".
- Access matrix today: no `site_head` row in section 2. Section 2 lists `plant_head` as a deferred placeholder (Epic 12); that is a different role and stays as it is.
- `findRoleHolder` today (`doa_registry.ts:298-315`) has no location filter and returns the earliest assignment across all sites.

### Current state of the files this story changes

Table 4 records what each touched file does today and what must survive.

Table 4: Files being modified

| File | Today | This story changes | Must be preserved |
|---|---|---|---|
| `src/read/projections/doa_registry.ts` | `findRoleHolder(role, client?)` and `isActiveRoleHolderForEntry(entryId, userId, client?)`, no location | Optional trailing `locationId` on both | Ordering and tie-break; result shape `{ user_id, external_id }`; behaviour with no location |
| `src/cli/verify-segregated-roles-core.ts` | Pairs report, five violation codes, read-only | `REQUIRED_SITE_ROLES`, `required_roles`, code `ROLE_UNHELD_AT_SITE`, formatter lines | The three existing pairs, their messages, and both closing lines |
| `src/cli/provision-roles-core.ts` | `EXTRA_FORBIDDEN_PAIRS` has one pair | Two more pairs | `forbiddenPairs()` still merges DOA pairs first |
| `deploy/rehearsal/mock/generate.mjs` | `cmf_supervisor` has three `warehouse_manager` grants; employee hat appended at line 442 | Three `site_head` grants, actor `sitehead` | Every other person and actor; the employee append |
| `docs/migration/pilot-mock-extract/roles.json` | 76 grants | 79 grants | Every existing row, in order |
| `docs/migration/pilot-mock-extract/world.json` | `people`, `operations.actors`, `doa_entries` | `cmf_supervisor` roles list, actor `sitehead` | `doa_entries` untouched (Story 4.8 seeds the standing-grant types) |
| `deploy/provision/roles.example.json` | `site.head@example.com` holds one `warehouse_manager` row | Three `site_head` rows added | Existing rows |
| `deploy/provision/staging-bootstrap-accounts.sh` | `$SITEHEAD` gets two `warehouse_manager` rows (104-105) | Three `site_head` rows | Idempotency notes in the header; the six-argument usage |
| `deploy/rehearsal/mock/operations-smoke.ts` | Flows through `maintenance` | One flow `siteHead` | Existing PASS lines and names |
| `docs/migration/pilot-cutover-runbook.md` | Rows through 2.10g, then 2.10b | Row 2.10h | Row order and column shape |
| Access matrix | v1.2, no `site_head` | Sections 2, 3.10, 5, 9 | Every existing row and ruling |

### Architecture compliance

- AD-3 (no hard-coded role assignments in workflow code): workflow code keeps naming roles through exported constants (`CHALLAN_RECLASSIFICATION_ROLES`, `JOBWORK_CLOCK_SITE_HEAD_ROLE`). Do not scatter new role literals; `REQUIRED_SITE_ROLES` and the two `EXTRA_FORBIDDEN_PAIRS` entries are the only new ones.
- Access matrix principle 1: roles are hats and the assignment tuple is (user, role, location). The site head is one person with two hats at one site.
- Error envelope: `{ error_code, message, details, trace_id }`. No new error code reaches the API in this story; `ROLE_UNHELD_AT_SITE` is a CLI report code only.
- The verification module is read-only by design (its header comment). Do not provision from it.

### Library and framework requirements

No new dependency. Node test runner, `pg`, `tsx`, as in every root test. No web research was needed: nothing in this story touches a library API.

### Previous story intelligence

- Story 1.15 (done 2026-09-27): every human in the pack holds `employee/employee/write/site`. `requireRole` groups any-of matches so a specialist hat stamps the audit actor ahead of the employee hat (its D9). A dual-hat person such as the site head is exactly the case that fix protects; do not reorder role matching.
- Story 1.15 Debug Log: running `provision:roles --apply` with the pilot pack against the local test database left older `warehouse_manager` holders at the staging site id, and `findRoleHolder` then picked them. 73 local assignments had to be removed. Do not repeat it. The integration test provisions its own users.
- `selectOperatingAssignment` (edge bootstrap) judges site ambiguity on non-base-hat assignments. All `cmf_supervisor` grants are at one site, so adding `site_head` cannot produce `EDGE_AMBIGUOUS_SITE`.
- Story 3.12 is the precedent for adding capability to a pilot person: constant exported from compliance, pack edited by hand and proven by regeneration, one smoke flow, one runbook row.
- `deploy/rehearsal/mock/operations-smoke.ts` does not truncate between runs. Re-run it once after a fresh `npm test` if its result matters.

### Git intelligence

Recent commits on `master` are planning-only (`a1d0de0`: Story 4.8 file, `epics.md`, `sprint-status.yaml`). Branch `ui-phase1-device-class` (`aff9744`, `563d246`) holds edge UI work and edge test repairs; it is not merged and does not touch any file in Table 4.

### Testing standards

- Root: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/**/*.test.ts` (`npm test`). Ad-hoc multi-file runs need `--test-concurrency=1`.
- Integration files boot `createAppServer(createAppRouter())` on port 0, provision through SCIM with the test bearer, mint tokens through `POST /api/v1/auth/dev-token`, and re-run projection DDL and TRUNCATE in `before`.
- Assertions: exact values and a negative control for every positive case.
- Local database: container `ims-postgres-test` (postgres 18.4, port 5442).

### Regression surface

Rerun `story-1-4` (DOA registry and tie-breaks), `story-1-15`, `story-3-12`, `story-8-9`, `story-9-5` to `story-9-8` (every `site_head` fixture), `story-13-2` and `story-13-3` (forbidden pairs at sign-off), `segregated-roles` (integration), `provision-roles-core`, `employee-base-role-pack`, `weighbridge-breach-routing`, `damage-routing` and `schema-drift`.

### Out of scope

- Standing-grant transaction types, grant routes and `GRANT_ASSIGNER_NOT_AUTHORIZED` (Story 4.8).
- Passing a site into `resolveApprover` for indents (Stories 4.9 and 4.10).
- RGP ageing escalation to the site head (FR-GP-09, later epic).
- Any edge screen, menu entry or manager overview.
- The `plant_head` placeholder in the access matrix.
- Removing `warehouse_manager` from the site head, or appointing a separate warehouse manager.

### Project Structure Notes

- New files: `test/unit/site-head-role-pack.test.ts`, `test/integration/story-1-16.test.ts`. Everything else is a modification.
- No conflict with the unified structure. `src/lib` does not exist at the root and is not needed.

### Owner rulings 2026-09-30

Table 6 records the three questions this story raised and the owner's answers. All three are now binding.

Table 6: Owner rulings

| Question | Ruling | Where applied |
|---|---|---|
| Does the pilot site head keep `warehouse_manager`? | Keep both hats on the same person | D2, Task 3.1 |
| Are the site head and finance pairs enforced or only recorded? | Enforced at provisioning | D6, Task 3.5 |
| Which roles must every site have a holder for? | `site_head`, `warehouse_manager`, `department_head`, `qc_head` | D5, Table 5, Tasks 1.2 and 4.1 |

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.16, #Story 4.8, #Story 9.7 dev notes]
- [Source: _bmad-output/implementation-artifacts/4-8-standing-approvals-and-self-approval-limits.md#Dependencies, #Binding Scope Decisions D3]
- [Source: _bmad-output/implementation-artifacts/1-15-employee-base-role.md#Binding decisions, #Debug Log References]
- [Source: _bmad-output/implementation-artifacts/3-12-weighbridge-breach-task-routing-for-pilot-roles.md#File List]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md#sections 2, 3, 5, 9]
- [Source: src/read/projections/doa_registry.ts:298-335]
- [Source: src/notify/dispatch.ts:106-122]
- [Source: src/api/v1/service-orders.ts:1312-1345]
- [Source: src/compliance/jobwork-return-clock.ts:305-320]
- [Source: src/cli/verify-segregated-roles-core.ts, src/cli/provision-roles-core.ts:55-74]
- [Source: deploy/rehearsal/mock/generate.mjs:410-493]
- [Source: docs/migration/pilot-cutover-runbook.md rows 2.9 to 2.10g]

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (`claude-fable-5-1`), dev-story workflow, 2026-09-30.

### Debug Log References

1. Red phase (Task 1.4). Command: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/unit/site-head-role-pack.test.ts test/integration/segregated-roles.test.ts test/integration/story-1-16.test.ts`. Result before any implementation: 31 tests, 21 fail, 10 pass. `segregated-roles.test.ts` failed to load (`does not provide an export named 'REQUIRED_SITE_ROLES'`). The unit file failed 12 of 13 (no `site_head` in the pack, no pairs in `forbiddenPairs()`). `story-1-16.test.ts` failed the located resolution, delegation, located membership and both `verify:roles` cases. The 10 passing cases pin behaviour this story must not change: the lookup with no location, membership with no location, the pilot pack planning with zero violations, and the four gate cases, because the gate already exists (D7).
2. Green phase. The same command after Tasks 2 to 4: 46 tests, 46 pass, 0 fail.
3. Gate persona finding. The classification route is wrapped in `requireRole({ module: 'jobwork', functionScope: 'write' })` (`src/api/v1/service-orders.ts:2710`), which runs before the site-head gate in the handler. The personas Task 1.3 names for the refusal (`emp` with only the base hat, `wm` with `inventory` write) hold no `jobwork` grant, so the platform refuses them with 403 `MODULE_ACCESS_DENIED` and they never reach the gate. `test/integration/story-9-5.test.ts:751-753` records the same fact for its own fixtures. See Completion Notes, deviation 1.
4. Pack regeneration proof (Task 3.2). `node deploy/rehearsal/mock/generate.mjs --site-code CMF-ALIGARH --lines 300 --seed 42 --site-id 9e4a90a8-5e35-4ca9-b988-d563cff74de3 --out <scratch>`: the regenerated `roles` array (79 grants), `people` map, `operations.actors` map (key order included) and `operations.doa_entries` are identical to the hand-edited files.
5. Type error caught by `npx tsc --noEmit`: `OWN_SITE_IDS` in `segregated-roles.test.ts` inferred the `randomUUID()` template type, so `includes(entry.site_id)` was refused. Typed as `string[]`.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- AC 1 (registered): access matrix v1.3. Section 2 gains "Site leadership" with the `site_head` row (Table 2), section 3.10 lists the six capability rows (Table 3), section 5 records the two assignment-time pairs, section 9 has the changelog row. The pilot pack holds the role: 79 grants, 25 roles.
- AC 2 (provisioned and verified): `cmf_supervisor@ancorlabs.org` holds the three Table 1 grants at the site and keeps `warehouse_manager` and the base hat (D2). The generator, the example roles file and the bootstrap script carry the same rows. `verifySegregatedRoles` takes a fourth argument `requiredRoles = REQUIRED_SITE_ROLES` and returns `required_roles`, one entry per role per active site; an unheld role is violation `ROLE_UNHELD_AT_SITE` and makes `ok` false. The report prints the required-role lines after the pair lines and before the violations; both closing lines are unchanged. Dry run of the pilot pack: 22 people, 79 assignments, 0 segregation violations, 0 errors.
- AC 3 (resolved at the site): `findRoleHolder(role, client?, locationId?)` and `isActiveRoleHolderForEntry(entryId, userId, client?, locationId?)`. With a location the assignment must be at that location or at `'*'`. With no location the SQL text and the result are what they were. Only `undefined` means no location; any other value filters, so a caller that lost its site resolves nobody. No caller was changed.
- AC 4 (refused for everyone else): proven on the existing gate (D7). A `jobwork` writer without the hat gets 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles` equal to `['compliance_officer', 'site_head']`; the site A head is refused on a site B clock with `LOCATION_ACCESS_DENIED`; the site A head corrects a site A clock.
- D6: `EXTRA_FORBIDDEN_PAIRS` gained `site_head` with `finance_controller` and `site_head` with `cfo`. A unit case plans a roles file that gives one person both hats and asserts the refusal.
- `SegregationViolation.transaction_type` is now `string | null`. It is null only for `ROLE_UNHELD_AT_SITE`, which is about a site and has no transaction type. Nothing outside the core file and its tests reads the field.
- Deviation 1, ACCEPTED by owner ruling 2026-09-30 (Task 1.3 gate case, AC 4): the two-gate behaviour stands, no change to `requireRole` or the route. The story asks that `emp` and `wm` be refused with `FUNCTION_ACCESS_DENIED` and `details.required_roles`. They cannot be: the route sits behind the `jobwork` write module gate, so a caller with no `jobwork` grant is refused earlier with 403 `MODULE_ACCESS_DENIED` (Debug Log 3). The test keeps both personas exactly as specified and asserts the refusal they really get, and adds a fifth persona, `coord` (`jobwork_coordinator`, `jobwork` write at site A), who reaches the gate and gets the AC 4 code. No production code was changed to force the AC 4 code onto callers outside the module: D7 forbids a new gated route, and changing the module gate would change every `jobwork` route. If the owner wants the literal AC 4 wording for every non-holder, that is a change to `requireRole` or to the route and belongs in its own story.
- Deviation 2, ACCEPTED by owner ruling 2026-09-30 (Task 1.3, wildcard holder). The case "a holder assigned at `'*'` satisfies any site" uses its own run-scoped role, because a wildcard `site_head` holder would also answer the site A and site B cases and hide a wrong result there.
- Deviation 3, ACCEPTED by owner ruling 2026-09-30 (Task 1.2). Other suites leave active sites in `location_register`, so the `segregated-roles` cases read the entries of the four locations the suite creates. The whole-result `ok: true` and the ready closing line are asserted with a wildcard holder, the one case that satisfies every site in a shared database. The empty-register case lives in `story-1-16.test.ts`, which truncates the register.
- Gates (Task 6.4): `npx tsc --noEmit` clean at the root and in `edge/`; `npm run lint` clean; `prettier --check --end-of-line auto` clean on every file this story wrote, while `generate.mjs` and `world.json` were already unformatted on the baseline and were left as they are; `schema-drift` green with zero DDL edits (D1); full `npm test` 2566 of 2566 pass, 0 fail.
- `verify:roles` locally: bare `npm run verify:roles` refuses to start on this machine (`AUTH_MODE=oidc requires ...`), the same behaviour as `npm run db:migrate`; it needs `--env-file=.env.test`. With it, the pair lines are identical to the baseline and 60 required-role lines follow (15 leftover test sites, 4 roles). Exit code 1 on the baseline (5 violations) and now (20), because the local database holds test litter. The meaningful run is runbook row 2.10h on staging.
- Local operations smoke: 57 of 57 PASS, including the three new `site head:` lines. Two earlier runs read 56 of 57 with the weighbridge breach leg failing; the cause was the undispatched notification backlog left by the integration suites (154 events), not this story. After draining it the leg passes.
- Smoke flow design: the holder's gate pass is proven by sending the correction with the class the clock already has, which the platform answers 200 without writing. A staging run therefore changes no statutory clock.
- Task 6.3 (staging run, operator task) NOT done: nothing is committed or shipped; runbook row 2.10h is written and waiting for the operator. Left unchecked, as Stories 1.15 and 3.12 did.
- Found, not fixed (out of scope): (1) the generator writes `employee` into every `world.json` `people[].roles` list and the committed `world.json` has never carried it, a drift that dates from Story 1.15; with `employee` ignored the two `people` lists are identical. (2) `deploy/provision/roles.example.json` and the bootstrap script name no `qc_head` holder, so `verify:roles` reports `FAIL qc_head` after a bootstrap until the pilot pack is applied. (3) `staging-bootstrap-accounts.sh` pipes `verify:roles` through `tail -8`, which now cuts the top of a longer report.
- Code review 2026-09-30 (three layers, no HIGH finding, four Acceptance Criteria judged MET): 2 decisions ruled by the owner, 9 patches applied, 3 deferred to `deferred-work.md`, 7 dismissed. Patches: location ids are lower-cased in `planProvisioning`, with a unit case; `requiredRoles` is de-duplicated, with an integration case; the `findRoleHolder` docstring and the `ROLE_UNHELD_AT_SITE` header comment state what happens today (a wildcard holder still resolves, only a site id matches, approvals do not resolve at the site until Story 4.8); both staging scripts read `tail -40`; the smoke docstring and runbook row 2.10h say the refused correction leaves one audit row; the smoke SKIP message no longer blames one actor; changelog v1.3 counts Table 3 correctly; the unit test imports `REQUIRED_SITE_ROLES` directly. Of the "found, not fixed" items above, (2) is answered by the reworded runbook rows 2.9 and 2.9a and (3) is fixed; (1) stays deferred.

### File List

New:

- `test/unit/site-head-role-pack.test.ts`
- `test/integration/story-1-16.test.ts`

Modified:

- `src/read/projections/doa_registry.ts`
- `src/cli/verify-segregated-roles-core.ts`
- `src/cli/provision-roles-core.ts`
- `deploy/rehearsal/mock/generate.mjs`
- `deploy/rehearsal/mock/operations-smoke.ts`
- `deploy/provision/roles.example.json`
- `deploy/provision/staging-bootstrap-accounts.sh`
- `deploy/provision/staging-doa-bands.sh` (code review)
- `docs/migration/pilot-mock-extract/roles.json`
- `docs/migration/pilot-mock-extract/world.json`
- `docs/migration/pilot-cutover-runbook.md`
- `test/integration/segregated-roles.test.ts`
- `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/1-16-site-head-role.md`
- `_bmad-output/implementation-artifacts/deferred-work.md` (code review)

Unchanged, confirmed: `src/cli/verify-segregated-roles.ts` (Task 4.3), `src/api/v1/indents.ts` (Task 2.3), every file under `edge/` (D9).

## Change Log

- 2026-09-30: Story created (create-story). Status ready-for-dev.
- 2026-09-30: Owner rulings applied (Table 6): both hats kept, finance pairs enforced, four required roles. Test file path corrected to `test/integration/segregated-roles.test.ts`.
- 2026-09-30: Implemented (dev-story). `site_head` provisioned in the pilot pack and registered in the access matrix (v1.3); `findRoleHolder` and `isActiveRoleHolderForEntry` take an optional location; `verify:roles` reports four required roles per active site (`ROLE_UNHELD_AT_SITE`); two forbidden pairs enforced at provisioning; smoke flow `siteHead`; runbook row 2.10h. Tests: 2566 of 2566. Status review. Task 6.3 (staging run) open as an operator task. One deviation awaited an owner ruling (Completion Notes, deviation 1).
- 2026-09-30: Owner ruling on deviation 1: accepted as is. A caller with no `jobwork` grant is refused `MODULE_ACCESS_DENIED` at the module gate; a `jobwork` writer without the hat is refused `FUNCTION_ACCESS_DENIED` at the site-head gate. AC 4 is met by refusal at either gate.
- 2026-09-30: Code review (Blind Hunter, Edge Case Hunter, Acceptance Auditor). No HIGH finding. Owner rulings: deviations 2 and 3 accepted; the missing `qc_head` in the bootstrap path is answered by rewording runbook rows 2.9 and 2.9a. Nine patches applied, three findings deferred. Tests: 2568 of 2568. Status done. Task 6.3 (staging run) still open.
