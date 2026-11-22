---
title: 'DW-30: attribute every branch_transfer_valuation write to its human actor'
type: 'bugfix'
created: '2026-11-22'
status: 'done'
baseline_revision: 'b8b5de7'
final_revision: '500cfa2'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `branch_transfer_valuation` has no column naming the human behind the current value except on the override path. The GST officer's first valuation (E1-P) and the creator's declared value both leave `overridden_by` NULL, so a filed taxable value cannot be attributed from the row alone. The `reason_code` that `transfer_request.valuation_overridden` requires is validated and then discarded on the first-valuation path.

**Approach:** Add additive `valued_by UUID NOT NULL` (set on every write path from `envelope.metadata.actor.user_id`) and `valued_reason_code TEXT NULL` (the officer's reason code, persisted). Backfill existing rows from `source_event_id`. Leave all existing CHECKs untouched.

## Boundaries & Constraints

**Always:** Add both columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` after the `CREATE TABLE` in `read/projections/branch_transfer_valuation.sql`, and mirror the identical statements into `deploy/compose/init-db.sql`. Backfill `valued_by` from `domain_events.metadata->'actor'->>'user_id'` joined on `source_event_id`, then `SET NOT NULL`. Every statement must be idempotent. `valued_by` on create, first valuation and override is `envelope.metadata.actor.user_id`. `valued_reason_code` is the trimmed payload `reason_code` on first valuation and override, and NULL on create. Add a drift pin in `test/unit/schema-drift.test.ts` in the style of the Story 9.5 and 9.9 ADD COLUMN pins.

**Block If:** After backfill, any row still has NULL `valued_by` (its `source_event_id` resolves to no event or no `actor.user_id`). HALT with that row count and the sample `transfer_request_id` values. Do not drop rows or relax NOT NULL.

**Never:** Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` or the sprint board. Do not modify, drop or re-order any existing CHECK, index or grant. Do not change `overridden_by` semantics. Do not add a dependency. Do not change `CREATE TABLE` body text.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create, declared value | `transfer_request.created` by actor A, declared basis | row `valued_by = A`, `valued_reason_code` NULL, `basis_source = declared` | none |
| Create, config default | same, cost-plus or config basis | row `valued_by = A`, `valued_reason_code` NULL | none |
| First officer valuation | `valuation_overridden` by officer O, reason R, no prior row | INSERT with `valued_by = O`, `valued_reason_code = R`, `overridden_by` NULL | none |
| Override | `valuation_overridden` by officer O, reason R, prior row | UPDATE sets `valued_by = O`, `valued_reason_code = R`, `overridden_by = O` | none |
| Replay of same event | same `source_event_id` already on row | no write (existing short-circuit) | none |
| Legacy row migrated | pre-existing row, `source_event_id` resolves | backfilled `valued_by` from that event's actor | Block If above |

</intent-contract>

## Code Map

- `read/projections/branch_transfer_valuation.sql` -- canonical table; add columns, backfill, NOT NULL
- `deploy/compose/init-db.sql` -- first-boot mirror of the same statements (near line 14056)
- `src/read/projections/branch_transfer_gst.ts` -- `VALUATION_COLUMNS`, `mapValuation`, `BranchTransferValuationRow`, `InsertBranchTransferValuationInput`, `insertBranchTransferValuation`, `OverrideBranchTransferValuationInput`, `overrideBranchTransferValuation`
- `src/compliance/transfer-request.ts` -- create-path insert (~line 857), `applyTransferValuationOverridden` first-valuation insert (~line 1758) and override update (~line 1781)
- `test/unit/schema-drift.test.ts` -- add pin near the Story 9.9 ADD COLUMN pins (~line 2430)
- `src/events/migrate.ts` -- already applies `branch_transfer_valuation.sql` after `domain_events.sql`; no change expected

## Tasks & Acceptance

**Execution:**
- [x] `read/projections/branch_transfer_valuation.sql` -- add `ADD COLUMN IF NOT EXISTS valued_by UUID` and `valued_reason_code TEXT`, backfill `valued_by` from `domain_events` where NULL, then `ALTER COLUMN valued_by SET NOT NULL` -- DW-30 canonical definition
- [x] `deploy/compose/init-db.sql` -- insert the identical statements after the same `CREATE TABLE` -- first-boot mirror
- [x] `src/read/projections/branch_transfer_gst.ts` -- add `valued_by` and `valued_reason_code` to columns, row type, mapper, insert input, override input, INSERT and UPDATE SQL -- persist attribution
- [x] `src/compliance/transfer-request.ts` -- pass `valued_by` and `valued_reason_code` at the three write sites per the matrix -- every write path attributed
- [x] `test/unit/schema-drift.test.ts` -- pin both ADD COLUMN statements, the backfill fragment and `SET NOT NULL` in canonical and init-db -- drift guard
- [x] Run the verification commands below and fix any failure caused by this change

**Acceptance Criteria:**
- Given a fresh database, when migrate runs, then `branch_transfer_valuation.valued_by` is `NOT NULL UUID` and `valued_reason_code` is nullable `TEXT`.
- Given an existing row with `source_event_id` pointing at an event by actor A, when the migration re-runs, then `valued_by = A` and re-running changes nothing.
- Given a transfer created by actor A, when the create event applies, then the row has `valued_by = A` and NULL `valued_reason_code`.
- Given an unvalued transfer and officer O submitting `valuation_overridden` with reason R, when the first valuation applies, then the inserted row has `valued_by = O`, `valued_reason_code = R`, NULL `overridden_by`.
- Given a valued row and officer O overriding with reason R, when it applies, then `valued_by = O`, `valued_reason_code = R`, `overridden_by = O`.
- Given the existing CHECK constraints, when the diff is reviewed, then none is altered or removed.

## Design Notes

`valued_by` is deliberately additive: `overridden_by` keeps its CHECK-bound meaning (the override path only), while `valued_by` answers "whose value is this row now" for every basis_source. Backfill runs as a correlated UPDATE on each migrate pass, guarded by `WHERE valued_by IS NULL`, so it is a no-op once complete.

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: exit 0
- `node --env-file=.env.test --import tsx --test test/unit/schema-drift.test.ts` -- expected: all pass, including the new pin
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-11-5.test.ts` -- expected: all pass
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-9-2.test.ts` -- expected: all pass

**Manual checks (if no CLI):**
- `git diff` shows no change to any existing CHECK body and no change to the deferred-work ledger

## Review Triage Log

### 2026-11-22 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 0
- reject: 5
- addressed_findings:
  - `[low]` `[patch]` Legacy override rows kept NULL `valued_reason_code` although `override_reason_code` was set. Added `UPDATE ... SET valued_reason_code = override_reason_code WHERE valued_reason_code IS NULL AND override_reason_code IS NOT NULL` to both SQL files.
  - Rejected: backfill-to-NULL aborts `SET NOT NULL` (intended per Block If); non-UUID actor cast (envelope ingest already requires a UUID `metadata.actor.user_id`); overridden row's `valued_by` = last overrider (matches spec meaning of `valued_by`); `String(null)` in mapper (unreachable after NOT NULL); weak drift pin ordering (nit).

## Auto Run Result

Status: done

Summary: DW-30 implemented. `branch_transfer_valuation` gained `valued_by UUID NOT NULL` and `valued_reason_code TEXT NULL`, populated on create, first officer valuation and override from `envelope.metadata.actor.user_id`. The reason code is now persisted on first valuation and override. Existing rows are backfilled from `domain_events` via `source_event_id`, and legacy override rows get `valued_reason_code` from `override_reason_code`. Existing CHECKs are untouched.

Files changed:
- `read/projections/branch_transfer_valuation.sql`: ADD COLUMN IF NOT EXISTS for both columns, backfill, reason-code backfill, SET NOT NULL.
- `deploy/compose/init-db.sql`: identical mirror of the SQL block.
- `src/read/projections/branch_transfer_gst.ts`: columns, row type, mapper, insert and override inputs and SQL.
- `src/compliance/transfer-request.ts`: three write sites pass `valued_by` and `valued_reason_code`; ATTRIBUTION comment updated.
- `test/unit/schema-drift.test.ts`: pin for the ADD COLUMN, backfill and SET NOT NULL fragments in canonical and init-db.

Verification:
- `npx tsc --noEmit`: exit 0.
- `test/unit/schema-drift.test.ts`, `test/integration/story-11-5.test.ts`, `test/integration/story-9-2.test.ts` run together: 272 of 272 pass, 0 fail.

Residual risks (not written to the ledger, per instruction):
- Backfill can leave NULL `valued_by` if a `source_event_id` has no `domain_events` row, so `SET NOT NULL` aborts the migration. Intended per Block If, but the database must have all source events.
- First-valuation rows (`overridden_by` NULL) cannot have `valued_reason_code` backfilled, since the reason is only in the event payload. Pre-existing gap for legacy rows.
- `valued_by` is the current value's actor. The original creator of an overridden row is not preserved in this table.
- Integration suites other than the three above were not run.
