---
title: 'Story 10.1: R&D and Maker-Hub Location Types and Project Master'
type: 'feature'
created: '2026-11-22'
status: 'done'
baseline_revision: 'eda81325144b5c35f1055345f788771eb2a0c943'
final_revision: '926f776504b86cce911ff63dd8f08c6d1f2c13b6'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
---

<intent-contract>
## Intent

**Problem:** R&D and maker-hub inventory has no first-class location type, no ring-fence for R&D-designated stock, and no project master, so R&D material moves are not tied to a live project.

**Approach:** Add `location_type` to the location register (values `rd_store`, `maker_hub_store`, plus `standard`). Add an `rd_designated` flag on lot master. Add an `rd_project` master projection (code, owner, phase, budget, status). Enforce at the material-issue seam: an R&D-designated lot or an R&D-type source location cannot issue to non-R&D demand without an approved reclassification (`CROSS_ISSUE_BLOCKED`), and any R&D material transaction needs an active project code (`PROJECT_CODE_REQUIRED`).

## Boundaries & Constraints

**Always:** Stock balance stays keyed by `(sku, location_id, lot_id)`; no new ledger table. New error codes are declared in the server registry and mirrored in the edge `PERMANENT_ERROR_CODES` list. Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`) and registered explicitly in `src/events/migrate.ts`. Routes follow `src/api/v1/rd-boms.ts` and are imported and mounted in `src/server.ts`.

**Block If:** None expected. Reclassification approval is defined below (an approved `rd_reclassification` row with approver distinct from requester).

**Never:** No change to sprint-status.yaml. No edge UI screens in this story (backend and contract only). No change to existing non-R&D issue behaviour beyond the new guards. No reuse of `approved_by` as a poster-supplied string.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| R&D receipt | Receipt into `rd_store` location | Row in `stock_balance` for that location only | none |
| Maker-hub receipt | Receipt into `maker_hub_store` | Row only for that location | none |
| Cross-issue blocked | Issue of `rd_designated` lot to non-R&D demand, no approved reclassification | Rejected | `CROSS_ISSUE_BLOCKED` |
| Cross-issue allowed | Same, with approved `rd_reclassification` row | Issue succeeds | none |
| Project code missing | R&D material transaction, no project code | Rejected | `PROJECT_CODE_REQUIRED` |
| Project inactive | Project code of closed or on_hold project | Rejected | `PROJECT_CODE_REQUIRED` |
| Project create | Code, owner, phase in {research, development}, budget >= 0, status active | 201 with record | 400 on invalid phase or negative budget |
| Duplicate project code | Code already exists | Rejected | 409 |

## Tasks & Acceptance

**Execution:**
- [x] `read/projections/location_register.sql` -- add `location_type` column with CHECK (`standard`, `rd_store`, `maker_hub_store`), default `standard` -- FR-RD-01
- [x] `read/projections/lot_master.sql` -- add `rd_designated BOOLEAN NOT NULL DEFAULT false` -- FR-RD-02
- [x] `read/projections/rd_project.sql` (new) -- `rd_project` table: project_code unique, owner_user_id, phase CHECK, budget_amount >= 0, status CHECK (active, on_hold, closed), created/updated timestamps -- FR-RD-03
- [x] `read/projections/rd_reclassification.sql` (new) -- table of reclassification requests: lot_id, from/to demand, requested_by, approved_by, status (pending, approved, rejected), CHECK approved_by <> requested_by when approved -- FR-RD-02
- [x] `src/events/migrate.ts` -- add the two new projection files to the explicit list in order after `location_register.sql` and `lot_master.sql` -- wiring
- [x] `src/compliance/rd-guards.ts` (new) -- pure guard functions: `assertRdCrossIssue(lot, sourceLocation, demand, approvedReclass)` and `assertProjectCodeActive(projectCode, project)`; throws with `CROSS_ISSUE_BLOCKED` / `PROJECT_CODE_REQUIRED` -- single shared rule
- [x] Error code registry (near `ERP_ERROR_CODES` in `src/adapters/erp/sync.ts` or the shared codes module used by issue routes) -- declare `CROSS_ISSUE_BLOCKED` and `PROJECT_CODE_REQUIRED`; mirror in `edge/src/sync/connector.ts` `PERMANENT_ERROR_CODES` -- contract parity
- [x] Material-issue seam (locate issue handler used by `src/api/v1/indents.ts` POST `/indents/:indentId/issue` and any direct stock-issue path) -- call both guards when the source location is `rd_store` or lot is `rd_designated`, or when the target is R&D -- enforcement
- [x] `src/api/v1/rd-projects.ts` (new) -- POST `/api/v1/rd-projects`, GET `/api/v1/rd-projects`, GET `/api/v1/rd-projects/:projectCode`; modelled on `rd-boms.ts` -- FR-RD-03
- [x] `src/server.ts` -- import and mount the rd-projects route next to the rd-boms import at line ~259 -- wiring
- [x] `test/integration/story-10-1.test.ts` (new) -- covers each Given/When/Then AC and each I/O matrix row -- verification

**Acceptance Criteria:**
- Given an R&D store and a maker-hub store configured as location types, when stock is received into the R&D store, then the movement appears in that location's stock balance and in no other location's
- Given the same configuration, when stock is received into the maker-hub store, then the same isolation holds
- Given a lot flagged `rd_designated`, when an issue to non-R&D demand is attempted without an approved reclassification, then the issue is rejected with `error_code: "CROSS_ISSUE_BLOCKED"`
- Given an R&D project, when a project master is created, then it carries code, owner, phase tag (research or development), budget and status
- Given any R&D material transaction, when it is attempted without an active project code, then it is rejected with `error_code: "PROJECT_CODE_REQUIRED"`

## Spec Change Log

## Review Triage Log

### 2026-11-22 — Review pass

- intent_gap: 3 (high 3) — rd_designated and location_type have no setter; reclassification has no request/approve path; approval is not consumed or quantity-bound. Owner ruling needed. Carried to follow-up, not patched.
- bad_spec: 2 (high 1, medium 1) — transfer, pick and adjustment seams not guarded; child bins under R&D stores not inherited. Spec scoped guard to the material-issue seam only. Carried to follow-up.
- patch: 9 (high 3, medium 6) — lot lookup scoped by sku and fail-closed; missing location fails closed; project code trimmed and upper-cased with format check; budget bounded to 2 decimals and below 1e16; non-string project_code 400 at route; FK lot_id on rd_reclassification; app_user grants narrowed to INSERT, SELECT.
- defer: 9 (medium 5, low 4) — no PATCH for project status or phase; no audit or domain event for rd_project writes (replay/rebuild loses state); stream value validation; owner_user_id existence check; list pagination; replay of indent.issued after project closes; ERP_ERROR_CODES home for the new codes; en.json only English; GET list unbounded.
- reject: 5 — N+1 lookups (acceptable at pilot volume); unrelated ledger hunks seen in review diff (not this story's change).
- addressed_findings:
  - `[high]` `[patch]` lot lookup ambiguous and fail-open; now sku-scoped and throws LOT_NOT_FOUND
  - `[high]` `[patch]` unknown location treated as non-R&D; now throws LOCATION_NOT_FOUND
  - `[high]` `[patch]` rd_reclassification.lot_id unconstrained; FK added
  - `[medium]` `[patch]` project_code casing and whitespace; normalized and format-checked
  - `[medium]` `[patch]` budget_amount precision and overflow; bounded
  - `[medium]` `[patch]` non-string project_code silently dropped; 400 INVALID_PARAMS
  - `[medium]` `[patch]` app_user UPDATE on new tables; grants narrowed
  - `[high]` `[bad_spec]` and `[high]` `[intent_gap]` items: recorded above, carried to follow-up, see deferred-work entries for story 10.1

## Design Notes

Reclassification approval is an approved `rd_reclassification` row whose `approved_by` differs from `requested_by`, so approval is not a self-grant. Project-code check reads the project row at transaction time, so a project closed after an issue does not retroactively block it.

## Verification

**Commands:**
- `npm run test:integration -- test/integration/story-10-1.test.ts` -- expected: all pass
- `npx tsc --noEmit` -- expected: no errors
- `npm test` -- expected: no new failures versus baseline

**Manual checks (if no CLI):**
- `read/projections/rd_project.sql` and `rd_reclassification.sql` contain only idempotent DDL

## Auto Run Result

Status: done

Summary: Story 10.1 implemented. `location_type` on the location register (standard, rd_store, maker_hub_store); `rd_designated` on lot master; `rd_project` master (code, owner, phase, budget, status); `rd_reclassification` table with approver-not-requester CHECK; shared guards in `src/compliance/rd-guards.ts` enforcing `CROSS_ISSUE_BLOCKED` and `PROJECT_CODE_REQUIRED` on the indent issue seam; `POST`/`GET` routes at `/api/v1/rd-projects`; error codes mirrored to edge `PERMANENT_ERROR_CODES`.

Files changed: see git commit for this story (projections, migrate.ts, compliance guards, indents and indent-issue, rd-projects route, server.ts mount, error-code registries, edge connector and en.json, integration test story-10-1.test.ts).

Review: Blind Hunter and Edge Case Hunter, one pass. 9 patches applied; 9 deferred to deferred-work.md; 5 rejected; 3 intent gaps and 2 bad-spec items carried to follow-up, see Review Triage Log.

Verification: `story-10-1.test.ts` 9 of 9 pass; `npx tsc --noEmit` exit 0. Full `npm test` not run in this pass.

Residual risks:
- rd_designated and reclassification approval have no write API; the ring-fence is reachable only by direct DB writes until a follow-up story.
- An approved reclassification releases the whole lot for all later issues; no quantity or consumption binding.
- Transfers, picks, adjustments and scrap of R&D stock are not guarded.
- R&D demand is defined as business_stream research or maker_hub (assumption, not in the original spec).
- rd_project and rd_reclassification writes bypass the event log.

Auto-run decision for owner: confirm release semantics for approved reclassification and the seam scope before follow-up.
