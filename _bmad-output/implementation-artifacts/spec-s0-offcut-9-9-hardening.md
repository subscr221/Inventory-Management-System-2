---
title: 'Story 9.9 offcut revaluation hardening (DW-6, DW-7, DW-8)'
type: 'bugfix'
created: '2026-11-22'
status: 'done'
baseline_revision: '7d30ac2d818fa5149fceb2417495a58a38b92869'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The approve applier for offcut revaluation proposals executes the frozen `proposed_value` without re-deriving it from the live holding (DW-6). The `superseded` leg of `chk_job_work_offcut_acq_proposal_lifecycle` allows rows with no `decided_by` and no `decided_at >= created_at` bound (DW-7). The approve path checks currency before the superseded-document id, so a superseded document with a different currency never produces the `CREDIT_NOTE_SUPERSEDED` audit row (DW-8).

**Approach:** Add a re-derivation guard at approve time, tighten the superseded lifecycle leg, and split the latest-credit-note lookup so the supersede id check runs before the currency check. Each change gets a regression test.

## Boundaries & Constraints

**Always:** The approve applier re-derives the expected value as `billableValueOf(holding.quantity, proposal.rate)` and refuses on mismatch before any write. Refusals on the approve path are audited through `auditedRefusal`. The `superseded` projection leg requires `decided_by IS NOT NULL` and `decided_at >= created_at`. The currency check still runs for every caller of the latest-credit-note lookup, and before any delta is posted. `init-db.sql` and the projection SQL stay in sync (schema-drift test).

**Block If:** None expected. If the schema-drift test or a migration path requires a decision about existing `superseded` rows, HALT.

**Never:** Do not edit the deferred-work ledger (`deferred-work.md`). Do not change the Story 9.10 quantity-immutability bar. Do not add a withdrawal path that writes `superseded`. Do not push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Approve, value consistent | Holding quantity q, proposal rate r, proposed_value = billableValueOf(q, r) | Approve succeeds as today | None |
| Approve after live quantity change | proposed_value frozen at old quantity, holding quantity now differs | Refused before any write, audited | 409 audited refusal, no delta row, no decision row |
| Superseded doc, different currency | Later below-band revaluation used another currency; proposal points at the older doc | `CREDIT_NOTE_SUPERSEDED` 409 audit row, not `INVALID_PARAMS` | Audited refusal |
| Superseded doc, same currency | Later revaluation, same currency | `CREDIT_NOTE_SUPERSEDED` 409 (unchanged) | Audited refusal |
| Current doc, currency mismatch | Proposal currency differs from latest (still current) doc | `INVALID_PARAMS` 400 (unchanged) | Reject |
| Superseded row without decider | status superseded, decided_by NULL | Insert rejected by CHECK | SQLSTATE 23514 |
| Superseded row decided before creation | decided_at < created_at | Insert rejected by CHECK | SQLSTATE 23514 |
| Superseded row valid | decided_by set, decided_at >= created_at, no event ids | Insert accepted | None |

## Code Map

- `src/compliance/jobwork-offcut-disposal.ts` -- approve applier, roughly lines 2200-2339; `occurred_at` and holding status checks precede the latest-credit-note call at about L2268; supersede id check at about L2287; `executeOffcutRevaluationDelta` at about L841.
- `src/compliance/jobwork-offcut-disposal.ts` -- `latestSupersedableCreditNote`, lines 794-825. Currently does missing check then currency check. Other callers at about L1910 and L2024.
- `src/adapters/erp/job-work-billing-feed.ts` -- `billableValueOf(quantity, rate)` at L74.
- `read/projections/job_work_offcut_acquisition_proposal.sql` -- lifecycle CHECK at about L80-95.
- `deploy/compose/init-db.sql` -- mirrored copy of the projection, about L13648-13705.
- `test/unit/schema-drift.test.ts` -- constraint registry, offcut entries about L1959-1970.
- `test/integration/story-9-9.test.ts` -- AC 5 supersede test about L1280; currency test about L1612.

## Tasks & Acceptance

**Execution:**
- [ ] `src/compliance/jobwork-offcut-disposal.ts` -- split `latestSupersedableCreditNote` into a lookup (missing check) and a currency assertion; approve path calls lookup, then supersede id check, then currency assertion; other callers call both in the original order -- DW-8.
- [ ] `src/compliance/jobwork-offcut-disposal.ts` -- in the approve applier, after the supersede id check and before `executeOffcutRevaluationDelta`, refuse via `auditedRefusal` (409) when `proposal.proposed_value !== billableValueOf(holding.quantity, proposal.rate)`; pick one new refusal code and reuse it in the test -- DW-6.
- [ ] `read/projections/job_work_offcut_acquisition_proposal.sql` -- superseded leg adds `decided_by IS NOT NULL AND decided_at >= created_at` -- DW-7.
- [ ] `deploy/compose/init-db.sql` -- mirror the same CHECK change in the embedded projection block -- DW-7.
- [ ] `test/unit/schema-drift.test.ts` -- update the registry only if the constraint's expected text or name changes; keep the drift check green -- DW-7.
- [ ] `test/integration/story-9-9.test.ts` -- add three tests: value drift refused and audited (DW-6); superseded plus different currency yields `CREDIT_NOTE_SUPERSEDED` audit row (DW-8); superseded CHECK rejects missing `decided_by` and backdated `decided_at` while accepting a valid row (DW-7).
- [ ] Run `graphify update .` after code changes (AST only).

**Acceptance Criteria:**
- Given an approved-pending revaluation whose frozen `proposed_value` no longer equals `billableValueOf(quantity, rate)`, when approve is called, then it is refused with an audited 409, no delta credit note is posted, and the proposal stays pending.
- Given a proposal whose supersedes document was replaced by a later revaluation in a different currency, when approve is called, then the response is 409 `CREDIT_NOTE_SUPERSEDED` and the audit row is written, not 400 `INVALID_PARAMS`.
- Given a current document with a currency mismatch, when approve is called, then the response remains 400 `INVALID_PARAMS`.
- Given an insert with `status = 'superseded'` and `decided_by` NULL, or `decided_at` earlier than `created_at`, then the database rejects it with SQLSTATE 23514; a valid superseded row is accepted.
- Given the existing Story 9.9 and 9.10 suites, when they run, then they stay green.

## Spec Change Log

## Review Triage Log

## Design Notes

The approve path has two reasons to refuse on the document, and the ordering matters. The supersede id check reports a stale document to a finance controller, and the currency check is a shape error on the current document. Checking currency first hides the stale-document signal behind the wrong code, so the lookup and the assertion are split.

## Verification

**Commands:**
- Targeted integration and unit suites for offcut disposal and schema drift -- expected: all pass; DB-backed tests need the Postgres on 127.0.0.1:5442 (see `.env.test`).
- `npx tsc --noEmit` -- expected: no new errors.
- `graphify update .` -- expected: completes.

**Manual checks (if no CLI):**
- `deploy/compose/init-db.sql` and `read/projections/job_work_offcut_acquisition_proposal.sql` show the identical lifecycle CHECK.

## Auto Run Result

Summary: DW-8 split the latest-credit-note lookup so the approve path runs the supersede id check before the currency assertion. DW-6 adds an audited 409 `REVALUATION_VALUE_MISMATCH` guard that re-derives `billableValueOf(holding.quantity, proposal.rate)` before any write. DW-7 requires `decided_by` and `decided_at >= created_at` on the `superseded` leg, mirrored in the projection and `init-db.sql`. Three regression tests added to `test/integration/story-9-9.test.ts`.

Files changed:
- `src/compliance/jobwork-offcut-disposal.ts`: helper split, new guard, reverted an unrelated prettier reflow.
- `src/api/v1/service-orders.ts`, `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`: register the new refusal code.
- `read/projections/job_work_offcut_acquisition_proposal.sql`, `deploy/compose/init-db.sql`: superseded leg tightened.
- `test/integration/story-9-9.test.ts`: three tests.

Review: one adversarial pass, no important findings. Nits: prettier reflow (fixed); DW-6 test does not assert holding row unchanged (not fixed, residual).

Verification: `npx tsc --noEmit` exit 0. `node --env-file=.env.test --import tsx --test --test-concurrency=1` over story-9-9, story-9-10, schema-drift and edge-permanent-error-parity: exit 0, DB reachable on 127.0.0.1:5442. Full unit suite not run.

Residual risk: DW-8 test forces currency mismatch by direct UPDATE, since the API cannot create that state. Stray uncommitted changes in `spec-7-11-maintenance-supervisor-desk.md` and `test/integration/story-1-9.test.ts` belong to other work and were not committed.

Ledger: `deferred-work.md` not edited, per instructions. DW-6, DW-7, DW-8 resolution left to the orchestrator.
