---
title: 'Story 10.2: R&D Requisition, Budget Check, and Issue Types'
type: 'feature'
created: '2026-11-22'
status: 'done'
baseline_revision: '79567fd19021639bd6ba66581f822084b579ebef'
final_revision: '230853d7b0499ee262e7af25be6c658a35869138'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent
**Problem:** R&D requisitions are not checked against the project budget, and issues carry no Ind AS 38 phase-based cost classification, so R&D spend can exceed budget and research/development costs are not expensed or capitalized correctly from the first transaction.

**Approach:** Add an R&D requisition document with a committed-plus-actual budget check (breach routes to project owner and R&D head), a three-way issue type (consumable / project_material / equipment_custody), an Ind AS 38 six-criteria checklist on the project, and an immutable costing record plus an equipment custody register.

## Boundaries & Constraints
**Always:** Stock balance stays keyed by (sku, location_id, lot_id). Cost capture uses `applyValuationOutflow` and `splitValuationOutflow` from `src/compliance/inventory-valuation.ts`, exactly like `src/compliance/production-material.ts` `applyDirectedIssueProjection` (lines 939-996). The R&D head resolves from the DOA registry, never a hard-coded role. New error codes are declared in the server registry and mirrored in `edge/src/sync/connector.ts` `PERMANENT_ERROR_CODES` plus `edge/src/messages/en.json`. Migrations are idempotent and registered in `src/events/migrate.ts`. Routes mount in `src/server.ts` and the Story 1.9 spine allowlist.

**Block If:** None expected. The project owner and R&D head dual approval on a budget breach is defined below (owner_user_id plus DOA-resolved R&D head, both required).

**Never:** No ERP budget projection or `BUDGET_EXCEEDED` code (FR-BC-01/02 is Story 11.3). No per-project WIP quantity/cost balance table (FR-RD-07 is Story 10.3). No equipment-custody return or custodian-confirmation flow (FR-RD-18 is Story 10.5). No retroactive flip of an expensed cost to capitalized; the costing record is append-only.

## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Requisition within budget | R&D requisition against active project, committed+actual+new <= budget | `rd_requisition.raised`, status `approved` | none |
| Requisition breaches budget | committed+actual+new > budget | status `approval_required`, routed to owner and R&D head | `APPROVAL_REQUIRED` |
| Research-phase issue | issue on project phase `research` | cost expensed, `capitalization` = `expensed` | none |
| Development-phase issue, checklist met | phase `development`, six criteria all met | cost capitalized, checklist reference stored | none |
| Development-phase issue, checklist incomplete | phase `development`, a criterion unmet | cost expensed | `CAPITALIZATION_CRITERIA_NOT_MET` |
| Retroactive reinstatement attempted | checklist set later than an expensed issue's business date | refused | `RETROACTIVE_REINSTATEMENT_BLOCKED` |
| Equipment-custody issue | issue_type `equipment_custody` | custody register entry with custodian, return date, condition codes | none |
| Issue on non-approved requisition | requisition status `raised` or `approval_required` | refused | `RD_REQUISITION_NOT_APPROVED` |

</intent-contract>

## Code Map
- `read/projections/rd_project.sql` -- existing project master; add `capitalization_effective_date` (forward-only ALTER)
- `read/projections/rd_requisition.sql` -- new header projection
- `read/projections/rd_requisition_line.sql` -- new line projection with `issue_type`
- `read/projections/rd_project_checklist.sql` -- new six-criteria checklist
- `read/projections/rd_issue_cost.sql` -- new append-only costing record
- `read/projections/rd_equipment_custody.sql` -- new custody register
- `src/events/schema.ts` -- event payload interfaces and `SUPPORTED_EVENT_TYPES` entries on a new `research` stream
- `src/events/store.ts` -- wire assert/apply seams
- `src/compliance/rd-requisition.ts` -- new seam (budget check, DOA/owner routing, approve/reject)
- `src/compliance/rd-issue.ts` -- new seam (issue types, Ind AS 38, cost capture, custody register)
- `src/compliance/rd-guards.ts` -- existing R&D guards, reused
- `src/compliance/inventory-valuation.ts` -- existing `applyValuationOutflow`/`splitValuationOutflow`, reused
- `src/compliance/production-material.ts` -- existing cost-capture precedent to model on
- `src/api/v1/rd-requisitions.ts` -- new routes
- `src/api/v1/rd-issues.ts` -- new issue route
- `src/api/v1/rd-projects.ts` -- existing; add checklist set route
- `src/api/v1/indents.ts` -- existing `resolveApprover`, reused
- `src/read/projections/rd_requisition.ts`, `rd_project_checklist.ts`, `rd_issue_cost.ts`, `rd_equipment_custody.ts` -- new accessors
- `src/events/migrate.ts` -- append migration entries
- `src/server.ts` -- mount routes
- `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json` -- error codes
- `test/integration/story-10-2.test.ts` -- new test
- `test/unit/schema-drift.test.ts` -- add tables to `EXPECTED`
- `test/integration/story-1-9.test.ts` -- add routes to `allowedSpineRoutes`

## Tasks & Acceptance
**Execution:**
- [x] `read/projections/rd_requisition.sql` -- create header (project_code, requester_user_id, business_stream, estimated_value, status CHECK, budget_breach, approver_actor_id, doa_entry_id, owner_approved_at, decided_at, decided_by, rejection_reason, source_event_id) -- AC 1
- [x] `read/projections/rd_requisition_line.sql` -- create lines (sku, requested_qty, issued_quantity default 0, uom, unit_cost_estimate, line_value, issue_type CHECK consumable/project_material/equipment_custody) -- AC 2
- [x] `read/projections/rd_project_checklist.sql` -- create six-criteria rows per project plus `ALTER TABLE rd_project ADD COLUMN IF NOT EXISTS capitalization_effective_date TIMESTAMPTZ` -- AC 4, 5, 6
- [x] `read/projections/rd_issue_cost.sql` -- create append-only costing record (issue_type, phase, capitalization, checklist_reference, cost_amount, unit_cost, business_date, source_event_id) -- AC 3, 4, 5, 6
- [x] `read/projections/rd_equipment_custody.sql` -- create custody register (custodian_user_id, expected_return_date, condition_codes, asset_id, status on_loan/returned, source_event_id) -- AC 7
- [x] `src/events/schema.ts` -- add payload/envelope pairs for `rd_requisition.raised`, `rd_requisition.approved`, `rd_requisition.rejected`, `rd_requisition.issued`; register all in `SUPPORTED_EVENT_TYPES` on `streamType: 'research'` (raised `requiresBusinessStream: true`, rest false) -- wiring
- [x] `src/compliance/rd-requisition.ts` -- assert/apply seam: budget check, DOA + owner routing, approve/reject with SOD-01 and resolved-approver enforcement -- AC 1
- [x] `src/compliance/rd-issue.ts` -- assert/apply seam: validate issue_type, refuse over-issue via `issued_quantity` (`RD_REQUISITION_LINE_EXCEEDED`), run `assertRdIssueGuards`, drain via `applyStockIssue`, capture cost via `applyValuationOutflow` + `splitValuationOutflow`, classify Ind AS 38 with server-derived IST `business_date` and IST-safe date comparison, surface `capitalization_blocked_reason` per line, write costing or custody register -- AC 2-7
- [x] `src/api/v1/rd-requisitions.ts` -- POST raise, GET list/get, POST approve, POST reject -- AC 1
- [x] `src/api/v1/rd-issues.ts` -- POST issue against an approved requisition -- AC 2
- [x] `src/api/v1/rd-projects.ts` -- add checklist set route computing `capitalization_effective_date` server-side -- AC 4, 6
- [x] `src/events/store.ts` -- wire `assertRdRequisitionShape`/`applyRdRequisitionProjection` and `assertRdIssueShape`/`applyRdIssueProjection` -- wiring
- [x] `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts` -- register and mirror the five new projection files -- wiring
- [x] `src/server.ts` -- import and mount the rd-requisitions and rd-issues routes -- wiring
- [x] `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json` -- declare `CAPITALIZATION_CRITERIA_NOT_MET`, `RETROACTIVE_REINSTATEMENT_BLOCKED`, `RD_REQUISITION_NOT_FOUND`, `RD_REQUISITION_ALREADY_DECIDED`, `RD_REQUISITION_LINE_REQUIRED`, `RD_REQUISITION_LINE_NOT_FOUND`, `RD_REQUISITION_LINE_EXCEEDED`, `RD_REQUISITION_NOT_APPROVED`, `RD_ISSUE_TYPE_REQUIRED` -- contract parity
- [x] `test/integration/story-1-9.test.ts` -- add new routes to `allowedSpineRoutes` -- spine gate
- [x] `test/integration/story-10-2.test.ts` -- cover each AC and each I/O matrix row plus replay idempotency -- verification

**Acceptance Criteria:**
- Given an R&D requisition against a project, when submitted, then a committed-plus-actual budget check runs and a breach routes to the project owner and R&D head with `error_code: "APPROVAL_REQUIRED"`.
- Given an approved requisition, when material is issued, then the issue is recorded under one of consumable (expensed), project material (accumulates WIP), or equipment custody (loan).
- Given an issue on a research-phase project, when posted, then the cost is expensed in the period of issue.
- Given an issue on a development-phase project with a six-criteria checklist all met, when posted, then the cost is capitalized and the checklist reference is stored on the costing record.
- Given a development-phase project whose checklist is incomplete, when an issue is posted, then the cost is expensed and capitalization is blocked with `error_code: "CAPITALIZATION_CRITERIA_NOT_MET"`.
- Given costs already expensed, when the project later passes the checklist, then only costs from the date criteria are met are capitalized and retroactive reinstatement is rejected with `error_code: "RETROACTIVE_REINSTATEMENT_BLOCKED"`.
- Given an equipment-custody issue, when recorded, then a custody register entry is created with named custodian, expected return date, and condition codes, with overdue ageing tracked.

## Spec Change Log
- 2026-11-22 Review pass 1 (bad_spec): the budget "committed" leg double-counted issued spend and the issue path allowed over-issue because the spec omitted a per-line issued-quantity lifecycle. Amended Design Notes and Tasks: per-line `issued_quantity` with over-issue refusal (`RD_REQUISITION_LINE_EXCEEDED`), committed computed on remaining unissued quantity, server-derived IST `business_date`, IST-safe capitalization date comparison, `capitalization_blocked_reason` surfacing, equipment-custody stock drain. KEEP: research stream plus four event types, cost capture via `applyValuationOutflow`, the six-criteria vocabulary, DOA client-aware resolution (AD-12 atomicity), dual owner plus head approval, custody register fields, dual permanent error-code sets, idempotent migrations, spine allowlist, integration suite.

## Review Triage Log
### 2026-11-22 — Review pass 1
- intent_gap: 0
- bad_spec: 2 (high 2)
- patch: 0 (folded into re-derivation)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Budget committed leg counts fully-issued requisitions forever because no issued/closed state exists — amended spec to compute committed on remaining unissued quantity per line.
  - `[high]` `[bad_spec]` Issue path allows over-issue beyond requested quantity and re-issue of a line — amended spec to track `issued_quantity` and refuse with `RD_REQUISITION_LINE_EXCEEDED`.
  - Folded into re-derivation: `CAPITALIZATION_CRITERIA_NOT_MET` response surfacing, server-derived IST `business_date`, IST-safe capitalization date boundary, NaN limit/offset guard, numeric overflow guard, empty-owner-row guard, dual-approval single-actor separation, asset_id validation, future `expected_return_date`.

### 2026-11-22 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 6 (high 1, medium 1, low 4)
- defer: 1 (low 1)
- reject: 3
- addressed_findings:
  - `[high]` `[patch]` Unique index on `source_event_id` broke multi-line requisition/issue events (second line 23505) — made each index composite on the row primary key and added multi-line integration tests.
  - `[medium]` `[patch]` A breach requisition raised by the project owner deadlocked under SOD-01 — owner leg satisfied at raise when the requester is the owner; head resolver skips the requester.
  - `[low]` `[patch]` Delegation "today" used UTC instead of IST — switched to `toIstCalendarDate`.
  - `[low]` `[patch]` `assertRdIssueShape` did not validate `occurred_at` — added a presence/format guard.
  - `[low]` `[patch]` `expected_return_date` allowed today and impossible calendar dates — reject today and validate real calendar dates.

## Design Notes
- Stream: a new `research` stream type carries the R&D requisition and issue events. The nested `stock.issued` is not used; the issue drains via `applyStockIssue` and captures cost via `applyValuationOutflow` + `splitValuationOutflow`, the exact `production-material.ts` WIP-posting path, so the relieved `value` and `unit_cost` land on the costing record without double relief.
- Budget: committed = sum of line_value of the REMAINING unissued quantity (requested_qty minus issued_quantity) of approved requisition lines for the project; actual = sum of cost_amount in `rd_issue_cost`. Breach sets `approval_required` and `budget_breach`, resolves the R&D head via `resolveApprover('rd_budget_breach', 0)`, and requires both the project owner (`rd_project.owner_user_id`) and the R&D head to approve. A fully issued line contributes nothing to committed.
- Issue lifecycle: each `rd_requisition_line` tracks `issued_quantity`; the issue seam refuses any line whose issue quantity exceeds `requested_qty - issued_quantity` with `RD_REQUISITION_LINE_EXCEEDED` and increments `issued_quantity` in the same transaction. `business_date` is derived server-side from the event `occurred_at` in IST (`toIstCalendarDate`), never accepted from the request body.
- Ind AS 38 six criteria: technical_feasibility, intention_to_complete, ability_to_use_or_sell, future_economic_benefits, resources_available, expenditure_measurable. `capitalization_effective_date` is set once all six are met and never moves backwards, and is compared against `business_date` as IST calendar dates (`(capitalization_effective_date AT TIME ZONE 'Asia/Kolkata')::date`) so the local day boundary is respected.
- Retroactive reinstatement is prevented structurally: the costing record is append-only and the issue applier capitalizes only issues whose business date is on or after `capitalization_effective_date`. An incomplete-checklist development issue is expensed and its response line carries `capitalization_blocked_reason: CAPITALIZATION_CRITERIA_NOT_MET`.
- Equipment custody is a loan: it drains stock via `applyStockIssue` (on-hand accurate, prevents double-loan) and writes the custody register (referencing the asset register via `asset_id` per AD-9, validated when supplied) with no expense or WIP cost row and no valuation relief; `expected_return_date` must be in the future; overdue ageing is derived from `expected_return_date`.

## Verification
**Commands:**
- `npm run test:integration -- test/integration/story-10-2.test.ts` -- expected: all pass
- `npx tsc --noEmit` -- expected: no errors
- `npm run lint` -- expected: clean
- `npm run db:migrate` -- expected: idempotent on re-run
- `npm test` -- expected: no new failures versus baseline
- `npm run spine-acceptance-contract` -- expected: pass
- `npm run edge:typecheck` -- expected: clean

**Manual checks (if no CLI):**
- `read/projections/rd_requisition.sql`, `rd_requisition_line.sql`, `rd_project_checklist.sql`, `rd_issue_cost.sql`, `rd_equipment_custody.sql` contain only idempotent DDL and guarded grants

## Auto Run Result

Status: done

Summary: Implemented R&D requisitions with a committed-plus-actual budget check (remaining unissued quantity), three issue semantics (consumable expensed, project material WIP-classified, equipment custody loan), an Ind AS 38 six-criteria checklist on the project with IST-safe capitalization gating, an append-only costing record, and an equipment custody register. Four new events on a `research` stream; five new projections; two compliance seams; four read accessors; three route files.

Files created: `read/projections/rd_requisition.sql`, `rd_requisition_line.sql`, `rd_project_checklist.sql`, `rd_issue_cost.sql`, `rd_equipment_custody.sql`, `src/compliance/rd-requisition.ts`, `src/compliance/rd-issue.ts`, `src/read/projections/rd_requisition.ts`, `rd_project_checklist.ts`, `rd_issue_cost.ts`, `rd_equipment_custody.ts`, `src/api/v1/rd-requisitions.ts`, `src/api/v1/rd-issues.ts`, `test/integration/story-10-2.test.ts`.

Files modified: `src/events/schema.ts` (event types), `src/events/store.ts` (seam wiring), `src/events/migrate.ts` (migrations), `deploy/compose/init-db.sql` (mirror), `src/api/v1/rd-projects.ts` (checklist route), `src/server.ts` (routes), `src/sync/upload.ts` + `edge/src/sync/connector.ts` + `edge/src/messages/en.json` (error codes), `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts` (spine allowlist), `_bmad-output/implementation-artifacts/sprint-status.yaml`.

Review breakdown: pass 1 found 2 high bad_spec (budget double-count, over-issue) that triggered a spec amendment and re-derivation; pass 2 found 6 patches (1 high, 1 medium, 4 low) all applied, 1 defer, 3 reject.

Verification: `db:migrate` x2 idempotent; `npx tsc --noEmit` clean; `npm run lint` clean; `story-10-2.test.ts` 19/19; `spine-acceptance-contract` 6/6; `edge:typecheck` clean; `schema-drift.test.ts` 218/218; `no-hardcoded-role-in-workflow.test.ts` 1/1.

Residual risks: budget `actual` uses FIFO-relieved cost while `committed` uses estimate, so a budget probe can diverge from a cash view; approve/reject replay returns `RD_REQUISITION_ALREADY_DECIDED` rather than an idempotent 200; no offline edge capture for requisitions (backend-only, consistent with Story 10.1).
