---
title: 'Harden dispatch_irn blank checks (DW-15)'
type: 'bugfix'
created: '2026-11-22'
status: 'done'
baseline_revision: '4d6b5d38c1e3de64054cc4200ce51b4bdc901732'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `chk_dispatch_irn_present` uses `btrim(invoice_number_ext) <> ''`, which strips spaces only. A tab-only `invoice_number_ext` passes the DB constraint. `so_number_ext` has no CHECK, so a blank value is accepted. Both app doors `trim()` before insert, so this is reachable only by direct SQL.

**Approach:** Make the invoice blank check whitespace-class aware (`[[:space:]]`, covering tab, CR, LF, space). Add a non-blank CHECK on `so_number_ext` with the same class. Mirror both in `deploy/compose/init-db.sql`. Add schema tests for tab-only and blank values.

## Boundaries & Constraints

**Always:** `read/projections/dispatch_irn.sql` and `deploy/compose/init-db.sql` change together, with identical constraint bodies. Each CHECK stays in the guarded DROP-then-ADD DO block. The `irn_ext` 64-hex check is unchanged. The file stays idempotent.

**Block If:** none.

**Never:** Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` or the sprint board. Do not change app-layer `trim()` behavior. Do not add a UNIQUE constraint. Do not touch the `irn_ext` check.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid row | invoice `INV-1`, so `SO-1`, valid 64-hex irn | Insert succeeds | None |
| Tab-only invoice | invoice `"\t"` | Refused, SQLSTATE 23514, constraint `chk_dispatch_irn_present` | DB error |
| Blank invoice | invoice `"   "` | Refused, 23514, `chk_dispatch_irn_present` | DB error |
| Blank so | so `""` | Refused, 23514, `chk_dispatch_so_number_present` | DB error |
| Tab-only so | so `"\t"` | Refused, 23514, `chk_dispatch_so_number_present` | DB error |

</intent-contract>

## Code Map

- `read/projections/dispatch_irn.sql` -- canonical DDL; holds `chk_dispatch_irn_present` DO block (around line 17 to 22)
- `deploy/compose/init-db.sql` -- first-boot duplicate of the same block (around line 13814 to 13822)
- `test/unit/schema-drift.test.ts` -- pins `dispatch_irn` constraints list (around line 2076); add the new constraint name there
- `test/integration/story-11-2.test.ts` -- existing 23514 arm at about line 1062 to 1090; add new arms beside it, reuse `seedErpSalesOrder`, `siteId`, `warehouseManager`, `run`

## Tasks & Acceptance

**Execution:**
- [x] `read/projections/dispatch_irn.sql` -- replace invoice check with `invoice_number_ext ~ '[^[:space:]]'`, add `chk_dispatch_so_number_present` CHECK `so_number_ext ~ '[^[:space:]]'`, both in the same guarded DO block -- closes tab-only gap and blank so gap
- [x] `deploy/compose/init-db.sql` -- apply the identical DO block body -- keeps first-boot DB in sync
- [x] `test/unit/schema-drift.test.ts` -- add `chk_dispatch_so_number_present` to the dispatch_irn `constraints` array -- drift guard
- [x] `test/integration/story-11-2.test.ts` -- add an `it` that inserts tab-only and blank invoice and blank/tab so, asserting 23514 with the right constraint name -- DB proof

**Acceptance Criteria:**
- Given a dispatch_irn insert with `invoice_number_ext` = tab only, when executed, then it fails with 23514 on `chk_dispatch_irn_present`.
- Given a dispatch_irn insert with `so_number_ext` = empty or tab only, when executed, then it fails with 23514 on `chk_dispatch_so_number_present`.
- Given a valid insert, when executed, then it still succeeds.
- Given the two SQL files, when compared, then the dispatch_irn DO-block bodies are identical.

## Spec Change Log

## Review Triage Log

### 2026-11-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 0
- reject: 4
- addressed_findings:
  - `[medium]` `[patch]` schema-drift had no body assertion for the new CHECKs; added `Story 11.2 DW-15` it() pinning both copies' bodies and forbidding the old btrim body
  - `[low]` `[patch]` literal tab chars in 7.3b arm were fragile; replaced with `'\t'`, `'\n'`, `'\r\n'`, `'\v'`, `'\f'` escapes
  - `[low]` `[patch]` 7.3b arm lacked empty-invoice and so `'   '` cases; added
  - `[low]` `[patch]` spec status and task boxes stale; updated
  - `[high]` `[reject]` blank ERP `so_number_ext` now refused at INSERT (23514) rather than recorded. Intent explicitly asks for the CHECK; the failure is fail-closed (the IRN is not recorded, so the wall stays shut). Flagged as residual risk for owner awareness, not app-layer change
  - `[high]` `[reject]` ADD CONSTRAINT fails on a live DB holding existing blank rows. Pre-existing residual risk already in Design Notes; pre-flight check before migrating live
  - `[medium]` `[reject]` `[[:space:]]` is locale-dependent. Intent allows a whitespace class
  - `[low]` `[reject]` DROP/ADD re-apply lock is pre-existing (bom_line precedent)

## Design Notes

Postgres POSIX class `[[:space:]]` inside a regex bracket matches tab, newline, CR, vertical tab, and form feed. This is strictly wider than `btrim`, which strips spaces only.

Residual risk: `ADD CONSTRAINT` on `so_number_ext` fails on a live database that already has a blank `so_number_ext` row. Such rows are not expected, since both app doors trim. Check before migrating a live database.

## Verification

**Commands:**
- `npm run test:integration -- test/integration/story-11-2.test.ts` -- expected: all pass including the new arm (needs Postgres on 127.0.0.1:5442 and `.env.test`)
- `node --env-file=.env.test --import tsx --test test/unit/schema-drift.test.ts` -- expected: pass

**Manual checks:**
- `grep -n "chk_dispatch" read/projections/dispatch_irn.sql deploy/compose/init-db.sql` -- both files show the same two constraint names and bodies

## Auto Run Result

Status: done

Summary: DW-15 closed. `chk_dispatch_irn_present` invoice check now uses the `[[:space:]]` class, so tab-only values are refused. New `chk_dispatch_so_number_present` refuses blank and whitespace-only `so_number_ext`. Both mirrored in `deploy/compose/init-db.sql`.

Files changed:
- `read/projections/dispatch_irn.sql` -- invoice CHECK body, new so_number CHECK
- `deploy/compose/init-db.sql` -- identical DO block body
- `test/unit/schema-drift.test.ts` -- constraint name added; new body-pin arm
- `test/integration/story-11-2.test.ts` -- new arm 7.3b (whitespace and blank refusals, valid insert)

Commit: `089166b` on master, not pushed. Ledger untouched; nothing deferred.

Verification: `story-11-2.test.ts` 12/12 pass; `schema-drift.test.ts` 210/210 pass.

Review: Blind Hunter and Edge Case Hunter run. 5 patched, 4 rejected (see Review Triage Log). No intent_gap, bad_spec, or defer.

Residual risks:
- Blank ERP `so_number_ext` now fails the IRN insert with 23514 (fail-closed; IRN not recorded). Intent-driven; app-layer handling not changed.
- Live DB with existing blank `so_number_ext` or tab/LF-only invoice rows makes the `ADD CONSTRAINT` abort. Pre-flight check required before migrating live.
- Local test DB: 3 leftover whitespace-only `dispatch_irn` rows were deleted before migrate.
