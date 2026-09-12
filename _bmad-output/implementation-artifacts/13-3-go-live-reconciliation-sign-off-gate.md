---
baseline_commit: 0db6cfc
---
# Story 13.3: Go-Live Reconciliation Sign-Off Gate

Status: done

## Story

As a program director,
I want a final reconciliation of all migrated data to ERP and legacy records with department-head and finance sign-off as a mandatory go-live gate, and a go-live unblock event once SM-48 is verified,
so that go-live only happens when the data is provably correct.

## Sequencing

Story 13.3 is the third and last of the pilot-gate stories, and it closes Epic 13. It builds on the completed working tree at `0db6cfc` (Story 13.2, done; full suite 2177/2177). It mints no new domain data and no new migration mechanics - it is a read-then-gate story that composes two things Stories 13.1 and 13.2 already built and exposed for exactly this purpose:

- Story 13.1's opening-balance variance check: `computeOpeningStockVariances(siteId, client)` in `src/read/projections/migration_variance.ts`. A variance is unexplained unless its derived status is `explained` (statuses: `open | pending_approval | stale | explained`).
- Story 13.2's per-domain document verification status: `getDomainVerificationStatuses(siteId, client)` in `src/read/projections/migration_domain_verification.ts`, returning `verified | unverified` for each of `active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`.

Both functions already state in their own header comments that Story 13.3 is their consumer. Call them, do not re-derive their logic - re-deriving a check that already lives at one call site is exactly the class of defect Story 13.1's own binding decision warned against (Story 11.5 lesson, cited in 13.1's dev notes).

This story adds one net-new concept the codebase has never had: a go-live gate and unblock event. Grep confirms no existing `golive`/`cutover`/`transactional posting` mechanism exists in `src/` outside comments pointing forward to this story - there is nothing to integrate with except `migration_stage` rows. Story 13.1's Open Question 1 clarifies scope: `migration.stage.promoted` already posts to the live ledger at promotion time, so this story's "activation of transactional posting" is a distinct, new flag with no current reader elsewhere in the system - do not attempt to wire it into an existing posting path that doesn't exist.

Pilot wave scope (per epic dev note): the gate covers exactly the domains deployed in the pilot slice - Epics 1, 2, 3, 5, 7, 8, 9. Concretely that means: `opening_stock` (13.1) plus the four 13.2 document domains (`active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`). Do not add Epic 10 (`custody_registers` loan-register extension) or Epic 20 (gate passes) domains - both are explicitly out of this wave in 13.1/13.2's dev notes.

## Acceptance Criteria

1. **Given** all migrated data (FR-DM-03)
   **When** the final reconciliation is run
   **Then** a reconciliation report is produced covering every domain in the wave's go-live scope - per-domain record counts (source vs migrated), quantity and value variances, and the explanation status of each variance - and any remaining discrepancy is surfaced on it

2. **Given** completed reconciliation (FR-DM-03)
   **When** go-live is requested without department-head and finance sign-off
   **Then** go-live is blocked with `error_code: "APPROVAL_REQUIRED"` until both sign-offs are recorded

3. **Given** recorded department-head and finance sign-offs but a non-zero unexplained opening-balance variance (FR-DM-03, SM-48)
   **When** go-live is requested
   **Then** go-live is blocked with `error_code: "VARIANCE_UNRESOLVED"` and the response lists each unexplained variance blocking the gate

4. **Given** department-head and finance sign-off with zero unexplained opening-balance variance (FR-DM-03, SM-48)
   **When** the sign-off gate is satisfied
   **Then** a go-live unblock event is created in the system, releasing the go-live gate

## Prerequisites

- Baseline is `0db6cfc` (Story 13.2, done). Full suite 2177/2177 green with `--test-concurrency=1`, `npm run build` 0, `npm run lint` 0, `tsc --noEmit` 0. Any red test after this story is a regression this story introduced.
- Story 13.1 is done: `computeOpeningStockVariances`, `migration_variance_explanation`, `migration_stage` (opening_stock domain) all exist and are stable.
- Story 13.2 is done: `getDomainVerificationStatuses`, `migration_domain_verification`, `migration_stage` (document domains, `verified_run_id`/`verified_at`/`verified_by_actor_id` columns), `requireDomainSignoffActor` all exist and are stable.
- Access matrix `access-matrix-frontline-draft-2026-07-11.md` section 3.7 ("Migration gate") already defines the RACI this story implements: SOD-07 "Migration loader != sign-off authority" (`migration_lead` vs `department_head`/`finance_controller`, already registered in `SEGREGATED_ROLE_PAIRS` in `src/cli/verify-segregated-roles-core.ts:53-83` as `migration.domain_signoff` and `migration.variance_explanation`). `finance_controller` holds "Final go-live financial sign-off: A" (accountable); `department_head` holds "Sign off domain balances: A"; `migration_lead` is C/R on loads and reconciliation but explicitly barred from signing off (SOD-07). Cite this table directly rather than re-deriving the RACI.
- `finance_controller` has no dedicated RBAC module in code today - it is referenced by role name alone across existing routes, never bound to a `module:` string. This story must pick a module for the finance sign-off route; the natural choice, consistent with `requireMigrationWriteActor`'s module `migration`, is module `migration` + role `finance_controller` (not one of the domain-specific modules `engineering`/`procurement`/`jobwork` that 13.2's per-domain sign-off uses, since the go-live gate is not domain-specific).

## Tasks / Subtasks

- [x] Task 0: baseline and inventory before writing code (AC: all)
  - [x] 0.1 Confirm the tree at `0db6cfc` builds and the full suite is 2177/2177; record the figure. Do not start from a red baseline.
  - [x] 0.2 Grep `src`, `test`, `read` for every identifier this story mints before minting it. `APPROVAL_REQUIRED` and `VARIANCE_UNRESOLVED` already exist in `MIGRATION_ERROR_CODES` (`src/compliance/migration-opening-stock.ts:68-75`) - **`APPROVAL_REQUIRED` today means "wrong actor tried to approve a variance explanation" (403, `migration.ts:1078`), a different semantic from this story's "go-live requested without both sign-offs" (409-class gate block)**. Decide explicitly whether to reuse the string as a shared "an approval is outstanding" code across both call sites (acceptable if the AC's literal `error_code` value is what's contractually tested, and the two call sites never collide) or mint a distinct code - and document the decision in Dev Notes either way. `VARIANCE_UNRESOLVED` is a direct, intentional reuse of 13.1's promotion-gate code for the same underlying concept (an unexplained opening-balance variance blocking a gate) and needs no new code.
  - [x] 0.3 Read before touching: `src/read/projections/migration_variance.ts` (full `computeOpeningStockVariances`); `src/read/projections/migration_domain_verification.ts:840-874` (`getDomainVerificationStatuses` and its `DomainVerificationStatus` type); `read/projections/migration_stage.sql` (both the 13.1 and 13.2 column additions, and its header comment referencing this story); `src/compliance/migration-documents.ts:443-587` (`assertDomainSignoffAllowed`) and its applier call site `applyDomainVerified` (`:589-...`) - this route-plus-applier double-check pattern is what this story's own gate-check function must copy; `src/api/v1/migration.ts:1206-1237` (`requireDomainSignoffActor`) as the template for the new sign-off route guards; `src/events/store.ts:535-562,1262-1267` (`persistEvent`, pre-transaction assert ordering, duplicate-event handling); `src/cli/verify-segregated-roles-core.ts:53-83` (existing SOD-07 pair registrations - confirm no new pair needs registering, or add one if this story introduces a role combination not yet covered); `access-matrix-frontline-draft-2026-07-11.md:230-238,254` (RACI table, section 3.7).

- [x] Task 1: schema (AC: 1, 2, 3, 4)
  - [x] 1.1 Design and add the go-live gate/sign-off projection(s). Minimum shape needed: a per-site sign-off record (department-head sign-off flag/actor/timestamp/event-id, finance sign-off flag/actor/timestamp/event-id) and a per-site go-live unblock record (unblocked flag, event-id, timestamp, actor). Consider one `migration_signoff` table keyed `(site_id, signoff_type)` where `signoff_type IN ('department_head_final','finance_final')` (mirrors the existing enum-CHECK convention used throughout Epic 13's tables) plus one `migration_golive_status` table keyed `(site_id)` holding the unblock state - or fold both into extensions of `migration_stage`/a new dedicated table if that reads cleaner once the reconciliation-report shape is nailed down in Task 2. Follow the guarded `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / DROP-then-ADD-CONSTRAINT pattern (precedent: `read/projections/bom.sql:42-44`, and 13.2's Task 1.1/1.2) for any additive change, never a plain CHECK edit (deferred-work 220: a plain CHECK edit never propagates to an existing database). Mirror every schema change into `deploy/compose/init-db.sql`. Add matching schema-drift entries in `test/unit/schema-drift.test.ts`.
  - [x] 1.2 Grants: `app_user` INSERT/SELECT (no UPDATE/DELETE - sign-off and unblock records are append-only/immutable once written, matching the no-UPDATE convention on `migration_domain_verification` and `migration_domain_platform_exclusion`); `readonly_user` SELECT.

- [x] Task 2: reconciliation report (AC: 1)
  - [x] 2.1 Build one function, e.g. `computeGoLiveReconciliationReport(siteId, client)`, that composes - does not re-implement - `computeOpeningStockVariances` (opening_stock domain) and `getDomainVerificationStatuses` (the four document domains) into one per-domain report: record counts (source vs migrated, from each domain's own counts - `source_count`/`migrated_count`/`quarantined_count`/`mismatch_count`/`waived_count` already exist on `migration_domain_verification` rows for the document domains; opening stock's analog counts come from `migration_import`/`migration_stage`), quantity/value variances and each variance's explanation status (for opening_stock, straight from `computeOpeningStockVariances`; document domains have no per-line variance concept today - state plainly in the report that document-domain "variance" is the reconciliation mismatch count, not a quantity/value delta, unless Task 2 research turns up a reason to add one).
  - [x] 2.2 Expose via a new read route, e.g. `GET /api/v1/migration/golive-reconciliation?site_id=...`, gated the same way existing migration read routes are gated (module `migration`, appropriate read-scope role set - check `src/api/v1/migration.ts` for the existing read-route RBAC helper and reuse it, do not invent a new one).

- [x] Task 3: sign-off recording (AC: 2, 4)
  - [x] 3.1 New route(s) to record department-head and finance final sign-off, e.g. `POST /api/v1/migration/golive-signoff` with a `signoff_type` body field, or two distinct routes - pick whichever matches the two-table-vs-one-table decision from Task 1.1. Guard with role + module + site checks modeled on `requireDomainSignoffActor` (`src/api/v1/migration.ts:1206-1237`): department-head route requires role `department_head` in module `migration`; finance route requires role `finance_controller` in module `migration`. Enforce SOD-07 (an actor who is `migration_lead` for this site, or who executed the load/promotion being signed off on, must be rejected - check `assertDomainSignoffAllowed`'s actor-conflict check in `src/compliance/migration-documents.ts` for the exact conflict-detection precedent and replicate it here, do not weaken it).
  - [x] 3.2 Persist each sign-off as a `migration.signoff.recorded` event (stream `migration`, `stream_id = site_id`, `requiresBusinessStream: false`, matching the convention of every other Epic 13 event) via `persistEvent`. Register the event type and its payload envelope in `src/events/schema.ts` alongside the other `migration.*` entries, and mirror the DDL in both `src/events/migrate.ts` and `deploy/compose/init-db.sql` per the established pattern.
  - [x] 3.3 Write a pure `assertGoLiveGateSatisfied(siteId, client)`-style gate-check function (mirrors `assertDomainSignoffAllowed`'s shape: takes IDs + a `Queryable`, returns `AppError | null`) that checks, in order: (a) both department-head and finance sign-offs recorded for the site -> else `error_code` per the Task 0.2 decision for "APPROVAL_REQUIRED"; (b) `computeOpeningStockVariances` returns zero rows whose status is not `explained` -> else `VARIANCE_UNRESOLVED` with every unexplained variance listed in the error detail (AC 3's explicit requirement - do not just return a boolean). Call this function identically from the route handler AND from the `migration.golive.unblocked` applier (the same double-check discipline `assertDomainSignoffAllowed`/`applyDomainVerified` already established) - never trust the route alone.

- [x] Task 4: go-live unblock event (AC: 4)
  - [x] 4.1 New route, e.g. `POST /api/v1/migration/golive-unblock`, that calls `assertGoLiveGateSatisfied` and, if it passes, persists a `golive.unblocked` event (stream `migration` or a new dedicated stream if the event-sourcing conventions call for one when the concept crosses out of "migration" proper into "site operations" - check `src/events/schema.ts` stream-type conventions before deciding; default to stream `migration` unless there's a clear existing precedent for a distinct stream). The applier writes the go-live unblock projection row from Task 1.1 (idempotent: re-running against an already-unblocked site returns the existing event, matching `persistEvent`'s standard duplicate-event handling, not a fresh mutation).
  - [x] 4.2 Do not implement any actual "activation of transactional posting" side effect beyond writing the unblock record. Per Story 13.1's Open Question 1, no consumer of this flag exists yet anywhere else in the codebase - this story's job is to make the record durable and queryable (the epic dev note: "the unblock event is the durable record auditors check"), not to gate any other write path. Scope-creep guard: if implementation surfaces a plausible integration point (e.g. blocking `production_order` creation or dispatch on an un-unblocked site), do not wire it - flag it as an open question for a later story instead.

- [x] Task 5: tests (AC: all)
  - [x] 5.1 New self-contained `test/integration/story-13-3.test.ts`, following the established per-story convention (never import fixtures/helpers from `story-13-1.test.ts` or `story-13-2.test.ts`): local `makeRequest`/`SCIM_HEADERS`/`run = randomUUID().slice(0,8)` closure, real Postgres via `getPool()`/admin pool, `--test-concurrency=1`.
  - [x] 5.2 Cover: reconciliation report shape and content (AC1); go-live blocked with `error_code` per Task 0.2's decision when neither/one sign-off recorded (AC2); go-live blocked with `VARIANCE_UNRESOLVED` and a populated variance list when both sign-offs recorded but an unexplained variance exists (AC3); go-live unblock event created and idempotent re-request returns the existing event when both sign-offs recorded and zero unexplained variance (AC4). Mutation-verify the gate-check function the way 13.1/13.2 did: invert `assertGoLiveGateSatisfied`'s logic locally in a throwaway branch, confirm the relevant test goes red, then restore - do this during development, not as a committed test.
  - [x] 5.3 Verify SOD-07: a `migration_lead`-only actor attempting either sign-off route is rejected; add this as an explicit negative test rather than relying on 13.2's precedent alone.
  - [x] 5.4 Add this story's route(s) to the Story 1.9 spine allowlist (`test/integration/story-1-9.test.ts`) exactly as 13.1 and 13.2 did for their own new routes.

- [x] Task 6: docs and gate evidence (AC: all)
  - [x] 6.1 Update `_bmad-output/implementation-artifacts/deferred-work.md` item #800 (the 20,000-row promotion perf figure) once that measurement is available - this story is the named place that figure lands; do not silently drop the carry-over.
  - [x] 6.2 Record final test counts, build/lint/tsc status, and any triaged code-review findings in this file's own Dev Agent Record section, and update `sprint-status.yaml`'s `13-3-...` entry and `epic-13` status per the standard story-completion convention.

### Review Findings

Code review 2026-09-12 (adversarial pass: Blind Hunter + Edge Case Hunter + Acceptance Auditor, parallel over baseline `0db6cfc` working tree; all three layers returned findings; Acceptance Auditor: no AC violations). Severity is the triage rating, not the reviewers' own. Both decisions were ruled by the user on 2026-09-12 and applied in the same round.

- [x] [Review][Decision] Dual sign-off collapses to one actor (high) - RULED option 1: `assertGoLiveSignoffAllowed` gained a sixth leg refusing a sign-off whose actor already gave the site's other effective final sign-off (`SIGNOFF_ACTOR_CONFLICT`, `conflicting_role: other_final_signoff`); negative test on site B with a user holding both hats [src/compliance/migration-golive.ts, test "Decision 1 (two hats, two people)"].
- [x] [Review][Decision] Gate scope narrower than the report it sits beside (medium) - RULED option 3: the gate now runs (a) both effective sign-offs recorded `APPROVAL_REQUIRED`; (b) neither predates the site's latest `migration_import` or ERP `snapshot_at` `SIGNOFF_STALE`; (c) zero unexplained variances `VARIANCE_UNRESOLVED`; (d) opening stock promoted (stage `dry_run`) `PROMOTION_REQUIRED`; (e) every wave document domain `verified` `DOMAIN_UNVERIFIED`. A stale sign-off is re-attested, never edited: `migration_golive_signoff` is keyed `(site_id, signoff_type, source_event_id)`, the effective row is the latest per type, and `already_signed_off` refuses only a FRESH prior. Every report discrepancy carries `blocks_golive`; `opening_stock_not_promoted` is a new kind; `data_activity` is on the report and each sign-off record carries `stale` and `superseded_count`.
- [x] [Review][Patch] Applier trusts payload provenance and skips the positive privilege leg [src/compliance/migration-golive.ts] - the shape assert now refuses a payload `signed_off_by_actor_id` other than the envelope actor (`reason: payload_actor_mismatch`) and a `signed_off_role` other than the type's role; `assertGoLiveSignoffAllowed` proves the write assignment from `user_role_assignments` (403 `FUNCTION_ACCESS_DENIED` in the applier too); the applier writes the type's canonical role. Three test arms.
- [x] [Review][Patch] Unbounded audit row on a `VARIANCE_UNRESOLVED` refusal [src/compliance/migration-golive.ts] - the audit copy of `details.unexplained` is capped at `MAX_AUDIT_VARIANCE_ENTRIES` (200) with `unexplained_listed` and `unexplained_truncated`; the HTTP response keeps the full list (AC 3).
- [x] [Review][Patch] Unblock and report routes skip the site existence check the sign-off route has [src/api/v1/migration.ts] - `requireRegisteredSite` shared by all three routes; 404 test arm covers a ghost UUID and a bin id.
- [x] [Review][Patch] Dead export and literal [src/compliance/migration-golive.ts] - `MIGRATION_GOLIVE_EVENT_TYPES` and `assertGoLiveGateSatisfied` removed (the test calls `evaluateGoLiveGate`); the `'opening_stock'` literal in `GOLIVE_WAVE_SCOPE` is kept with the ESM-cycle reason documented beside it.
- [x] [Review][Patch] Mirror comment copy-pasted from the canonical file [deploy/compose/init-db.sql] - the init-db block is regenerated from the two canonical files with its own MIRROR headers (the schema-drift comparison strips comments).
- [x] [Review][Patch] Test gaps [test/integration/story-13-3.test.ts] - arms added for the applier's `signoff_event_mismatch` refusal, the lead-only actor at `finance_final`, and the `open_findings` and `quarantined_documents` discrepancy kinds; story-13-3 18/18.
- [x] [Review][Defer] `pending_approval` and `stale` variance statuses blocking the gate are not exercised [test/integration/story-13-3.test.ts] - deferred: needs a `doa_registry_entries` fixture and a resolvable approver (the 13.1 explanation route freezes one); the gate filters on `status !== 'explained'`, which the 13.1 suite pins per status.
- [x] [Review][Defer] `source_count` re-derives Story 13.1's site and latest-snapshot CTEs [src/compliance/migration-golive.ts] - deferred, pre-existing: `VARIANCE_SQL` in `migration_variance.ts` exports no fragment; sharing one means editing the 13.1 file, and the variance rule itself is not duplicated.
- [x] [Review][Defer] 20,000-row promotion perf figure still owed (deferred-work #800) - deferred, pre-existing: Story 13.1 Task 7.2 item; 10,000 rows measured locally, no staging figure.

Dismissed as noise or precedent (8): `is_migration_lead` leg ignoring module and scope (fails closed, stricter than 13.2 which has no lead leg); concurrent distinct-key unblocks returning 409 instead of a replay (safe failure, lock holds; now documented at the route); replay with a truncated projection table; `APPROVAL_REQUIRED` and `INVALID_STATE` reuse (Task 0.2 decision, `details.reason` discriminates, codebase pattern); `read()` wrapper on the sign-off POST (13.2 `postDomainSignoffHandler` precedent); replay not comparing actor (no route in the file does); CHECK guard IF-NOT-EXISTS-then-ADD (13.2 `migration_domain_verification.sql` precedent); `causation_id` naming the finance sign-off.

## Dev Notes

- **Reuse, do not re-derive.** This story's entire correctness rests on composing two already-correct functions (`computeOpeningStockVariances`, `getDomainVerificationStatuses`) rather than reimplementing variance/verification logic a third time. Both functions' own header comments already name this story as their consumer - that is a strong signal, not a coincidence, and a strong signal that duplicating their logic here would be a regression risk against the exact lesson Story 13.1 called out (Story 11.5 D1: a rule re-derived at a second call site is a defect waiting to happen).
- **`APPROVAL_REQUIRED` ambiguity is the single highest-risk decision in this story.** The code already defines `APPROVAL_REQUIRED` for a narrower, unrelated 403 case (wrong actor approving a variance explanation). Task 0.2 forces an explicit decision before any code is written - resolve it early, not as an afterthought during test-writing.
- **Dual sign-off is not a DOA/`resolveApprover` pattern.** `resolveApprover` (`src/api/v1/indents.ts:66-104`) resolves one DOA-banded approver from a transaction-type/value pair; it has no concept of two independent, unordered role-gated confirmations both being required. Model this instead on 13.2's `requireDomainSignoffActor` - a straight role+module+site assignment check, run twice (once per sign-off type), each producing its own event or its own field on a shared record.
- **No existing posting/activation mechanism exists to integrate with.** This is new ground for the codebase; keep the implementation to "durable, queryable unblock record" and resist the urge to also wire real posting-gate behavior into unrelated modules (Task 4.2).
- **SOD-07 is already named and registered** in `src/cli/verify-segregated-roles-core.ts` and the access matrix - this story implements the enforcement side of a pairing the codebase already declared, it does not invent the policy.
- Testing standard: real Postgres integration tests per established Epic 13 convention (no mocked DB), `--test-concurrency=1`, self-contained per-file fixtures via the route layer where possible, admin-pool fabrication reserved for negative/broken-reference fixtures only.

### Project Structure Notes

- New schema: `read/projections/migration_signoff.sql` and/or `read/projections/migration_golive_status.sql` (naming per Task 1.1's decision), mirrored into `deploy/compose/init-db.sql`.
- New/modified compliance logic: extend `src/compliance/migration-documents.ts` (or a new sibling file, e.g. `src/compliance/migration-golive.ts`, if the gate-check logic is substantial enough to warrant separation from the document-verification concerns already in that file - prefer the new file if it keeps `migration-documents.ts` from growing unrelated concerns).
- Event registration: `src/events/schema.ts` (payload types, `SUPPORTED_EVENT_TYPES` entries for `migration.signoff.recorded` and `golive.unblocked`), `src/events/migrate.ts` (DDL), `deploy/compose/init-db.sql` (mirrored DDL).
- Routes: additions to `src/api/v1/migration.ts`, registered in `src/server.ts` alongside existing migration routes.
- No changes expected to Story 13.1 or 13.2 code paths themselves - this story is purely additive and read-composing. If implementation reveals a need to change either, treat that as a signal the composition boundary was wrong and reconsider before editing upstream files.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 13.3: Go-Live Reconciliation Sign-Off Gate] (lines 3535-3565)
- [Source: _bmad-output/implementation-artifacts/13-2-active-document-migration-boms-pos-challans-custody-registers.md] (Story 13.2, done - `getDomainVerificationStatuses`, `requireDomainSignoffActor`, `assertDomainSignoffAllowed`, event/table conventions)
- [Source: _bmad-output/implementation-artifacts/13-1-*.md] (Story 13.1, done - `computeOpeningStockVariances`, `migration_variance_explanation`, SM-48)
- [Source: src/read/projections/migration_domain_verification.ts:840-874]
- [Source: src/read/projections/migration_variance.ts]
- [Source: src/compliance/migration-documents.ts:443-587]
- [Source: src/compliance/migration-opening-stock.ts:68-75] (`MIGRATION_ERROR_CODES`)
- [Source: src/api/v1/migration.ts:1206-1237] (`requireDomainSignoffActor`)
- [Source: src/api/v1/indents.ts:66-104] (`resolveApprover` - not the pattern to use here, cited to rule it out explicitly)
- [Source: src/cli/verify-segregated-roles-core.ts:53-83] (`SEGREGATED_ROLE_PAIRS`, SOD-07)
- [Source: access-matrix-frontline-draft-2026-07-11.md#3.7 Migration gate] (lines 230-238, 254)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md#800]

## Dev Agent Record

### Agent Model Used

Claude Fable 5.1 (claude-fable-5-1), dev-story workflow, 2026-09-11.

### Debug Log References

- Task 0.1 baseline at `0db6cfc`: full suite 2177/2177, 0 fail (225.8 s), before any edit.
- Task 0.2 decision: `APPROVAL_REQUIRED` is REUSED as the literal (AC 2 tests the string). The 13.1 call site is a 403 on one route ("caller is not the frozen approver of an explanation"); this story's is a 409 on the unblock route with `details.missing_signoffs` and `details.recorded_signoffs`. They never collide. `VARIANCE_UNRESOLVED`, `SIGNOFF_ACTOR_CONFLICT` and `INVALID_STATE` are likewise reused. The literals are spelled in `migration-golive.ts` rather than imported, because `migration-opening-stock.ts` imports that module (ESM cycle) and a load-time read of `MIGRATION_ERROR_CODES` would be a temporal-dead-zone read; the first test in `story-13-3.test.ts` pins the four literals equal to the 13.1 and 13.2 constants.
- Task 0.3: no new SOD-07 pair is needed in `SEGREGATED_ROLE_PAIRS` - `migration_lead` vs `department_head` and `migration_lead` vs `finance_controller` are both already registered (13.2 and 13.1); the same test pins that.
- Task 1.1 shape: two tables, not a `migration_stage` extension. `migration_golive_signoff` keyed `(site_id, signoff_type)` with the enum CHECK in a guarded DO block; `migration_golive_status` keyed `(site_id)`. Both `app_user` INSERT, SELECT only.
- Task 3.3 / 4.1 lock: the opening-stock `migration_stage` row (via `lockMigrationStage`) is the site's migration lock. Sign-offs, promotion and the unblock all serialise on it, so a duplicate sign-off is a clean 409 `INVALID_STATE` (`reason: already_signed_off`), never a raw 23505.
- Task 4.1 event name: `migration.golive.unblocked` on stream `migration`. `assertMigrationEventShape` requires a `migration.*` name on the `migration` stream and vice versa, so a bare `golive.unblocked` name (the AC's shorthand) would be refused `INVALID_EVENT_STREAM`; a new stream had no precedent to justify it.
- Task 4.1 idempotency: an unblocked site always carries its `migration_golive_status` row (written in the event's own transaction), so the route returns that row with `replayed: true` for the same key AND for a new key; the applier refuses a hand-built second unblock `INVALID_STATE` (`reason: already_unblocked`). The unblock payload's two sign-off event ids are re-verified by the applier against the recorded rows (`reason: signoff_event_mismatch`).
- Task 5.2 mutation-verify (throwaway, restored): inverting the `status !== 'explained'` filter reddened AC1 (after load), AC3 and AC4; disabling the missing-sign-off branch reddened AC1 (before load) and both AC2 tests. 12/12 green after restore.
- Task 6.1: the 20,000-row perf form in deferred item #800 cannot run: the import route caps a file at `MAX_IMPORT_ROWS = 10_000` and refuses it `PAYLOAD_TOO_LARGE`. Measured the 10,000-row form instead on the local test database: import 62.7 s, ERP sync 24.2 s, promote 27.6 s. Recorded in #800 with the open decision (two-file load in the 13.1 perf test, or 10,000 as the pilot ceiling); the staging-VPS figure is still owed.
- Fixture lesson: `erp_stock_balance` has `uq_erp_stock_balance_grain` (NULLS NOT DISTINCT), so a "newer snapshot" is an UPDATE of the grain row with a later `snapshot_at`, exactly as the 2.9 sync upsert does; `quantity_delta` is NUMERIC text (`-2.000000`).

### Completion Notes List

- AC 1: `GET /api/v1/migration/golive/reconciliation?site_id=` returns one report over the wave scope (`opening_stock`, `active_boms`, `open_pos`, `jobwork_challans`, `custody_registers`): opening stock carries source vs migrated counts (latest snapshot rows vs live accepted/posted rows, plus the load-header sums), every variance with its status from `computeOpeningStockVariances`, and the unexplained count/value; each document domain carries the 13.2 status row plus `open_finding_count`, and states `variance_basis: reconciliation_mismatch_count` (no per-line delta exists for documents today). `remaining_discrepancies` lists every unexplained variance, unverified domain, quarantined-document count and open-finding count. `gate.blocking` is the exact refusal the unblock route would return.
- AC 2: `POST /api/v1/migration/golive/sign-offs` (`signoff_type: department_head_final | finance_final`) records each attestation as a `migration.signoff.recorded` event and an append-only row. `POST /api/v1/migration/golive/unblock` with fewer than two sign-offs is 409 `APPROVAL_REQUIRED` naming the missing ones.
- AC 3: with both sign-offs and any variance whose status is not `explained`, the unblock is 409 `VARIANCE_UNRESOLVED` with every unexplained variance listed - in the route and in the applier (direct `persistEvent` is refused and audited).
- AC 4: with both sign-offs and zero unexplained variance, `migration.golive.unblocked` is persisted and `migration_golive_status` written; re-requests (same or new key) return the existing event; the report shows `golive.unblocked: true`. No posting path reads the flag (Task 4.2, by design).
- SOD-07: sign-off refused 403 `SIGNOFF_ACTOR_CONFLICT` when the signer holds a `migration_lead` assignment reaching the site, loaded any migration file for it, promoted its opening stock, or ran a document verification for it - four database-provable legs, repeated by the applier. RBAC: `department_head` / `finance_controller` need a WRITE assignment on module `migration` at the site (or `*`); the unblock request needs a migration write actor (the gate, not the requester's role, releases go-live).
- Tests: `test/integration/story-13-3.test.ts` 12/12; `schema-drift` 182/182 (two new tables); spine allowlist extended with the three routes. Full suite after the change: 2191/2191, 0 fail.
- Build: `tsc --noEmit` 0, `npm run lint` 0, prettier clean on every changed file, `graphify update` run.
- Code review 2026-09-12 (decision 2) closed the first two open questions: the gate now requires every wave document domain `verified` and opening stock promoted, and a sign-off older than the site's latest load or ERP snapshot is `SIGNOFF_STALE` and must be re-attested (append-only, latest row effective). Remaining open question for a later story (not wired, per Task 4.2): no consumer of `migration_golive_status` exists yet.

### File List

- `read/projections/migration_golive_signoff.sql` (new)
- `read/projections/migration_golive_status.sql` (new)
- `deploy/compose/init-db.sql` (mirrors appended)
- `src/events/migrate.ts` (two files registered)
- `src/events/schema.ts` (payload types, `SUPPORTED_EVENT_TYPES` entries)
- `src/compliance/migration-golive.ts` (new: shape assert, sign-off and gate checks, appliers, report)
- `src/compliance/migration-opening-stock.ts` (event-type set, shape and applier dispatch)
- `src/api/v1/migration.ts` (three routes, sign-off actor guard, exports)
- `src/server.ts` (route registration)
- `test/integration/story-13-3.test.ts` (new)
- `test/unit/schema-drift.test.ts` (two entries)
- `test/integration/story-1-9.test.ts` (allowlist)
- `_bmad-output/implementation-artifacts/deferred-work.md` (item #800)
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/13-3-go-live-reconciliation-sign-off-gate.md`

## Change Log

- 2026-09-11: Story 13.3 implemented (Tasks 0 to 6). Two append-only projections, two `migration.*` events, three routes, one compliance module composing the 13.1 variance and 13.2 verification derivations. Full regression suite after the change: 2191/2191, 0 fail (baseline 2177 + 12 story tests + 2 schema-drift entries); tsc 0, lint 0, prettier clean.
- 2026-09-12: Code review round applied (bmad-code-review, three layers). Decision 1: two-people rule on the two final sign-offs. Decision 2: gate widened (stale sign-off, promotion, domain verification), sign-off table re-keyed per event for re-attestation. Patches: applier provenance and positive privilege leg, audit-row cap, site 404s on all routes, dead code, init-db mirror headers, test arms. Gates: tsc/eslint/prettier clean, story-13-3 18/18, full suite recorded in sprint-status.
