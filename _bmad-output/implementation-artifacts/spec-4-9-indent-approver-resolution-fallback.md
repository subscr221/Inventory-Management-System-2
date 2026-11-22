---
status: awaiting-operator
baseline_revision: 7b656c19bc6153245792730f8616eab39241105a
followup_review_recommended: true
final_revision: 70054fa
warnings:
  - oversized
operator_actions:
  - "Deploy the 4.9 build to staging, then run the stuck-indent re-resolution CLI in report mode and review the exception list."
  - "On staging and the pilot database, run the stuck-indent re-resolution CLI with --apply once the exception list is reviewed, then confirm zero NOT_RESOLVED_APPROVER-stuck lines remain."
  - "Confirm a department_head role holder is assigned in the pilot DOA registry, so the fallback resolves on the pilot sites."
---

# Story 4.9: Indent Approver Resolution Fallback

<intent-contract>

## Intent
**Problem:** An indent whose value matches no DOA band is stored with no approver and then stuck (`NOT_RESOLVED_APPROVER`). Requester sees no path forward.

**Approach:** Unmatched line routes to the `department_head` role holder (UX ruling Q6, head of department band). Status shows the fallback and who it waits on. If no `department_head` holder exists, capture refuses with an error naming the missing configuration. Stuck indents are re-resolved through a CLI (report mode plus apply mode).

## Boundaries & Constraints
**Always:** Unmatched line never persists without an approver path. Fallback approver approves through the existing `decideAsApprover` seam (SOD-01, raiser cannot approve). Edge and HTTP doors behave identically. Audit every fallback routing and every re-resolution.

**Block If:** None. Owner ruling Q6 and the party-mode split (2026-10-20) decide the shape; the only open points are recorded in Design Notes.

**Never:** Do not add a department entity (out of scope; no department data exists). Do not touch `sprint-status.yaml`. Do not change standing-approval (4.8) or per-line routing (4.10) behaviour for matched bands. Do not auto-apply the re-resolution against any live database from the agent.

## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| HAPPY_PATH band match | line value matches a DOA band | unchanged route, approver from band | none |
| NO_BAND_FALLBACK | value matches no band; a `department_head` holder exists | line `approval_route: doa`, `approver_actor_id` = holder (or active delegate), `doa_entry_id` null, `fallback_reason: no_band_match`; header approver = that holder | none |
| NO_BAND_NO_HOD | no band match; no `department_head` holder | refused at capture, nothing persisted | 409 `INDENT_APPROVAL_BAND_MISSING`, message names missing `department_head` role holder |
| FALLBACK_STATUS | requester views indent with fallback line | response carries `fallback_reason` per line and `waiting_on_label` on header | none |
| FALLBACK_APPROVES | fallback approver decides | decision accepted via `decideAsApprover`; raiser refused `INDENT_RAISER_CANNOT_APPROVE` | existing errors |
| STUCK_LEGACY | indent line pending, `approver_actor_id` null | CLI report lists it; `--apply` routes via fallback, writes audit row | if no HOD, listed as exception, not changed |

## Code Map
- `src/compliance/indent-routing.ts:103` -- `resolveLineApprover`; replace no-band throw with fallback branch
- `src/compliance/indent-routing.ts:145` -- `routeIndentLines`; carries `fallback_reason` on route
- `src/compliance/indent-routing.ts:198` -- `headerApproverOf`; must include fallback routes (today filters `doa_entry_id`)
- `src/api/v1/indents.ts:103-143` -- legacy `resolveApprover`; no-band returns no approver (stuck source); route through fallback or delete if unused
- `src/api/v1/indents.ts:328`, `src/api/v1/edge.ts:943,959` -- raise and edge callers of routing
- `src/compliance/indent.ts:956-978` -- `decideAsApprover`; NOT_RESOLVED_APPROVER sites, unchanged
- `src/read/projections/doa_registry.ts:376-426` -- `findRoleHolder`, `findActiveDelegation` reused for HOD lookup
- `src/read/projections/indent.ts:52-53,151,275` -- line fields and status projection; add `fallback_reason`, `waiting_on_label`
- `deploy/compose/init-db.sql:3925,3964` and `read/projections/indent_line.sql` -- add `fallback_reason TEXT` (keep the two identical)
- `src/sync/upload.ts:198,204` -- permanent error parity for `INDENT_APPROVAL_BAND_MISSING`, unchanged code
- `src/cli/` -- new `reresolve-stuck-indents.ts` (report and apply)
- `edge/src/messages/en.json` -- `errors.*` and status copy for fallback state
- `test/integration/story-4-10.test.ts:288-341` -- AC6 test: update to the new refusal-only-when-no-HOD rule
- `test/integration/story-4-9.test.ts` -- new
- `test/unit/indent-fallback-routing.test.ts` -- new

## Tasks & Acceptance
**Execution:**
- [ ] `src/compliance/indent-routing.ts` -- on no band, look up `department_head` holder via `findRoleHolder` + `findActiveDelegation`; return fallback result with `fallback_reason: 'no_band_match'`; if no holder throw `INDENT_APPROVAL_BAND_MISSING` naming the missing `department_head` configuration -- the only refusal left for no band
- [ ] `src/compliance/indent-routing.ts` -- `headerApproverOf` includes fallback routes; `LineRoute` gains `fallback_reason`
- [ ] `src/api/v1/indents.ts` -- legacy `resolveApprover` no-band branch routed through the same fallback (single source of truth), or removed if unreferenced
- [ ] `deploy/compose/init-db.sql`, `read/projections/indent_line.sql` -- add `fallback_reason TEXT NULL`; persist it in the raise insert path (`src/compliance/indent.ts` raise)
- [ ] `src/read/projections/indent.ts` -- select `fallback_reason`; compute `waiting_on_label` on header ("Head of department, fallback: no DOA band matches value") when any line has fallback
- [ ] `src/sync/upload.ts` -- keep parity for `INDENT_APPROVAL_BAND_MISSING`; no new code
- [ ] `src/cli/reresolve-stuck-indents.ts` -- report mode lists pending lines with null approver; `--apply` routes via fallback inside a transaction, writes `logAuditEntry` per line; lines with no HOD stay listed as exceptions
- [ ] `edge/src/messages/en.json` and edge status row component -- render fallback label and waiting-on text
- [ ] `test/integration/story-4-10.test.ts` -- AC6 updated: with HOD seeded, no-band raise succeeds with fallback; without HOD, refused with `INDENT_APPROVAL_BAND_MISSING`
- [ ] `test/integration/story-4-9.test.ts` -- new: fallback routing, status shows fallback, fallback approves, no-HOD refusal, edge-door parity, regression: no persisted indent line without approver path, CLI report and apply
- [ ] `test/unit/indent-fallback-routing.test.ts` -- unit: `resolveLineApprover` fallback, delegation through fallback, `headerApproverOf` with fallback routes

**Acceptance Criteria:**
- Given an indent whose value matches no DOA band, when the approver is resolved, then the line routes to the `department_head` holder (or their active delegate) with `fallback_reason: no_band_match`, not stored without an approver
- Given a fallback-routed indent, when the requester views its status, then the response shows the line `fallback_reason` and header `waiting_on_label`, and the fallback approver can approve through the normal decision path
- Given no `department_head` holder is on record, when the indent is submitted, then capture is refused with 409 `INDENT_APPROVAL_BAND_MISSING` whose message names the missing `department_head` configuration, and nothing is persisted
- Given indents stored stuck before this fix, when the re-resolution CLI runs with `--apply`, then each pending line with a null approver is routed through the fallback and audited, and lines that cannot be resolved are listed as exceptions
- Given any unmatched indent, when it is raised through HTTP or the edge door, then it never persists without an approver path (regression test covers both doors)

## Spec Change Log
- 2026-11-22: Resolved party-mode split. 4.10 AC6 refusal kept only for the no-HOD case; no-band with HOD now falls back. Recorded in Design Notes.

## Review Triage Log
### 2026-11-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4 (high 1, medium 2, low 1)
- defer: 5 (medium 2, low 3), recorded in Design Notes "Review residuals accepted"
- reject: 9 (value above top band or in gap goes to HOD is per epic AC; no-holder-when-band-matches is out of spec scope; other items were noise or out of scope)
- addressed_findings:
  - `[high]` `[patch]` requester could be assigned their own unmatched indent as HOD fallback (SOD-01 then blocks the approval); fallback now skips the requester, tries the delegate, else refuses `INDENT_APPROVAL_BAND_MISSING`; test `FALLBACK_REFUSES_SELF` added
  - `[medium]` `[patch]` CLI apply lock query did not recheck indent status or route; now joins `indent`, rechecks `raised`, `doa`, pending, null approver, and reports skipped lines
  - `[medium]` `[patch]` CLI apply aborted the whole run on a non-AppError; now every per-line error is recorded as an exception and the run continues
  - `[low]` `[patch]` CLI header approver set from first-fixed line; now highest-value DOA line, as `headerApproverOf`

## Design Notes
**Fallback definition.** "Head of department band" is taken as the `department_head` role holder on the `indent_approval` registry, with no value bound applied. There is no department entity, so the fallback is company-wide (same as the existing `resolveApprover`, which has no site dimension). Revisit when a department model exists.

**Why refuse only when no HOD.** Party-mode 2026-10-20 gave 4.10 the no-band refusal and 4.9 the HOD fallback. Reading both: the refusal is the terminal case of the fallback chain. Keeping the code `INDENT_APPROVAL_BAND_MISSING` preserves the 4.10 edge and sync parity.

**Schema.** `fallback_reason` is a nullable text column, added with `ADD COLUMN IF NOT EXISTS` in init-db.sql (fresh DB) and the canonical projection SQL. Existing rows stay NULL, so they are not reported as fallback; the stuck-row CLI is the path for legacy rows.

**Re-resolution.** CLI, not a migration: it needs the live DOA registry and must run per environment. Report mode is read-only. Apply mode runs per line in a transaction with audit rows. The agent does not run it against any live database.

**Shortcut:** fallback is company-wide, not per site. Upgrade when a site-level HOD model exists.

**Review residuals accepted**

- Fallback applies to any no-band value, including values above the top band and in band gaps, per the epic AC. A value-cap refusal is a deliberate follow-up, not in this story.
- CLI apply writes projections directly and emits no domain event, so a projection rebuild from the event log reverts the repair. Re-run the CLI after any rebuild. Shortcut: one-off repair; upgrade to an event-based correction.
- Fallback is company-wide and `findRoleHolder` picks one holder (oldest), with no site or department scope.
- `waiting_on_label` is English SQL text; the edge app uses its own i18n key.
- UTC date for delegation lookup is pre-existing and deferred.

## Verification
**Commands:**
- `npm test -- test/unit/indent-fallback-routing.test.ts` -- expected: all pass
- `npm test -- test/integration/story-4-9.test.ts test/integration/story-4-10.test.ts test/integration/story-4-3.test.ts test/integration/story-4-8.test.ts` -- expected: all pass
- `npx tsc --noEmit` -- expected: no errors
- `npm run edge:test -- indent` -- expected: fallback copy test passes

**Manual checks (if no CLI):**
- Staging only, operator: `reresolve-stuck-indents` in report mode lists zero or only exception rows after apply.

## Auto Run Result
Status: awaiting-operator
Blocking condition: none (operator-only steps listed in operator_actions)
Summary: Unmatched indent routes to department_head holder (never requester); refuses at capture only when no eligible holder; fallback_reason persisted and surfaced; stuck-indent CLI built (report and apply), not run against any DB.
Files: see commit 70054fa.
Review: 4 patches applied (1 high, 2 medium, 1 low); 5 deferred residuals in Design Notes; 9 rejected.
Verification: tsc clean; unit indent-fallback-routing 9/9; integration story-4-9 7/7, story-4-10 13/13, story-4-3 16/16, story-4-8 42/42 (test DB 5442).
Follow-up review recommended: true.
Revisions: code 70054fa; spec record 2154892.
