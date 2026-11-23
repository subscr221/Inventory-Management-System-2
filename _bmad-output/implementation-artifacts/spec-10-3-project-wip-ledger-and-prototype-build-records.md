---
title: 'Story 10.3: Project WIP Ledger and Prototype Build Records'
type: 'feature'
created: '2026-11-23'
status: 'review'
baseline_revision: '8648546fe2ac57d2f6206b4d7af2574a96669429'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent
**Problem:** R&D project material issues carry no per-project WIP quantity and cost balance, completed prototypes cannot be registered as a non-saleable serialized class, there is no approved disposition path, and unused project material cannot be returned against project WIP.

**Approach:** Add a project WIP ledger fed by the Story 10.2 issue seam, register completed builds as serialized `prototype`-class records, block dispatch of that class with `NON_SALEABLE_CLASS`, add the four R&D-head-approved dispositions (retain-as-asset, transfer-to-production, teardown, scrap) with scrap-pending holding, and reverse WIP by returned cost through a return event that restores stock and valuation.

## Boundaries & Constraints
**Always:** WIP posts to `rd_project_wip_ledger`, never `production_wip_ledger` (AD-5). R&D material movements reuse `assertRdIssueGuards` (AD-7). Retain-as-asset reuses the one asset register (AD-9). Disposition approval resolves the R&D head through the DOA registry via the transaction-aware `resolveHeadApproverInTransaction`, never a hard-coded role (AD-3). Writes go through `persistEvent` only; reads go through accessors (AD-14). Every command carries an idempotency key; `alreadyPersisted` is a plain SELECT, never `FOR UPDATE`. Multi-row stock drains happen before valuation relief; valuation relief runs in ascending SKU order. Migrations are idempotent, registered in `src/events/migrate.ts`, mirrored in `deploy/compose/init-db.sql`, and listed in `test/unit/schema-drift.test.ts`. New error codes are declared in `src/sync/upload.ts` `PERMANENT_ERROR_CODES`, `edge/src/sync/connector.ts`, and `edge/src/messages/en.json`. New routes mount in `src/server.ts` and the Story 1.9 spine allowlist.

**Block If:** None expected. This story is fully specified below; no human ruling is required.

**Never:** No Phase-2 scrap-module routing (Epic 16); teardown and scrap lines stop at `rd_scrap_pending`. No Phase-2 sales-order allocation module (Epic 15); only the reusable class guard is written. No rebuild of the asset register, no Form 3CL or IAUD reporting (Story 10.5), no hub member or machine-time work (Story 10.4). Do not create `stock_balance`, `inventory_valuation`, or valuation FIFO rows for a prototype: prototype cost is carried in project WIP, and a second stock row would double-count on-hand.

## I/O & Edge-Case Matrix
| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| WIP view after project-material issues | two `project_material` issue lines, one consumable line | WIP shows summed quantity and value of the two project-material lines only, in real time | none |
| Failed or abandoned build recorded | `rd_build.recorded` with `outcome` `failed` or `abandoned` and `project_code` | build record and as-built lines persist, visible in project build history | none |
| Completed build registered | `rd_build.completed` for a build whose outcome is `success` | `rd_prototype` row plus `serial_master` row, `stock_class` `prototype` | none |
| Non-success build registered | `rd_build.completed` for a build whose outcome is `failed` or `abandoned` or null | registration refused | `RD_BUILD_NOT_COMPLETED` |
| Duplicate prototype serial | serial already in `serial_master` for that SKU | registration refused | `DUPLICATE_SERIAL` |
| Dispatch of prototype | packing record lot belongs to a registered prototype at document generation or final dispatch | dispatch refused | `NON_SALEABLE_CLASS` |
| Disposition requested | prototype `registered`, valid disposition type | disposition row `approval_required`, routed to R&D head | `APPROVAL_REQUIRED` |
| Disposition approved by non-approver | actor is not the resolved R&D head or is the requester | approval refused | `APPROVAL_UNRESOLVED` |
| Execute before approval | disposition status `approval_required` or `rejected` | execute refused | `RD_DISPOSITION_NOT_APPROVED` |
| Teardown or scrap without lines | disposition type `teardown` or `scrap`, empty `lines` | request refused | `RD_DISPOSITION_LINE_REQUIRED` |
| Teardown execute | approved teardown with component lines | component lines persisted with condition codes, scrap-pending rows written | none |
| Scrap execute | approved scrap with lines | scrap-pending rows written with quantity, condition code, source prototype ref | none |
| Retain-as-asset execute | approved retain disposal with asset fields | Epic 7 asset row created, asset_id recorded on disposition | none |
| Transfer-to-production execute | approved transfer with `production_reference` | production-reference designation recorded on disposition | none |
| Return within open quantity | return quantity not greater than source posting open quantity | return posting with negative quantity and value, source open quantity decremented, stock and valuation restored | none |
| Return exceeds open quantity | return quantity greater than source posting open quantity | return refused | `RD_RETURN_EXCEEDS_OPEN` |
| Return against a return posting | source posting is not an `issue` posting | return refused | `RD_RETURN_EXCEEDS_OPEN` |

</intent-contract>

## Code Map
- `read/projections/production_wip_ledger.sql` -- the WIP posting pattern to model on (posting types, pairing CHECK, guarded grants)
- `src/compliance/production-material.ts:846-1004` -- directed-issue WIP posting precedent (`drainRowsToPostings`, `insertWipPosting`)
- `src/compliance/production-material.ts:1224-1393` -- material return precedent (source lock, open quantity, `applyValuationReturn`, stock restore)
- `src/compliance/rd-issue.ts:262-310` -- Story 10.2 issue seam where `project_material` WIP posting hooks in
- `src/compliance/rd-guards.ts` -- `assertRdIssueGuards`, `assertProjectCodeActive`, reused
- `src/compliance/inventory-valuation.ts:376,451,500` -- `applyValuationOutflow`, `splitValuationOutflow`, `applyValuationReturn`, `asValuationOutflow`
- `read/projections/rd_build_record.sql`, `rd_as_built_line.sql` -- existing build record with `outcome` and full material history
- `read/projections/rd_issue_cost.sql`, `rd_requisition_line.sql` -- WIP cost and quantity sources
- `read/projections/serial_master.sql` -- serialized class storage (unique `(sku, serial_number)`)
- `src/compliance/stock-balance.ts:73-98` -- `SEGREGATED_STOCK_CLASSES` / `NON_SALEABLE_STOCK_CLASSES` vocabulary
- `src/compliance/dispatch.ts:69-87,357-410,515-601` -- `dispatchGateBlockedLots` and both dispatch boundaries
- `src/compliance/asset.ts` + `src/read/projections/asset.ts:77-101` -- `insertAsset`, the Epic 7 register write
- `src/compliance/rd-requisition.ts:151-187` -- `resolveHeadApproverInTransaction`, the transaction-aware R&D-head resolver
- `src/events/schema.ts:2109-2164,6522-6540` -- `research` stream payload, envelope, and `SUPPORTED_EVENT_TYPES` pattern
- `src/events/store.ts:805-811,1216-1225` -- assert/apply seam wiring
- `src/api/v1/rd-requisitions.ts`, `rd-issues.ts` -- handler and `persistEvent` style
- `src/server.ts:260-273,974-991` -- imports and route mounts
- `test/integration/story-1-9.test.ts:166-246` -- `allowedSpineRoutes`
- `test/integration/story-10-2.test.ts:1-40,87-242` -- integration harness to copy

## Tasks & Acceptance
**Execution:**
- [ ] `read/projections/rd_project_wip_ledger.sql` -- create WIP postings (`posting_id`, `project_code`, `posting_type` CHECK `issue`/`return`, `issue_cost_id`, `rd_issue_id`, `requisition_id`, `requisition_line_id`, `sku`, `quantity` positive, `open_quantity`, `unit_cost`, `posting_value`, `reason_code`, `source_posting_id`, `source_event_id`, `occurred_at`, `created_at`) with the same issue-versus-return pairing CHECK as `production_wip_ledger.sql` and guarded grants -- AC 1, 7
- [ ] `read/projections/rd_prototype.sql` -- create serialized non-saleable prototype (`prototype_id`, `build_id`, `project_code`, `sku`, `serial_number`, `lot_id`, `location_id`, `stock_class` CHECK `prototype`, `built_quantity` positive, `uom`, `status` CHECK `registered`/`disposed`, `source_event_id`, timestamps; unique `(sku, lot_id, location_id, serial_number, stock_class)`); do not touch `stock_balance` -- AC 3, 4
- [ ] `read/projections/rd_disposition.sql` -- create disposition header (`disposition_id`, `prototype_id`, `project_code`, `disposition_type` CHECK the four kinds, `status` CHECK `approval_required`/`approved`/`rejected`/`executed`, `approver_actor_id`, `doa_entry_id`, `approved_at`, `approved_by`, `rejected_at`, `rejected_by`, `executed_at`, `executed_by`, `asset_id`, `production_reference`, `source_event_id`, timestamps) -- AC 5
- [ ] `read/projections/rd_disposition_line.sql` -- create component lines (`line_id`, `disposition_id`, `line_no`, `component_sku`, `quantity` positive, `condition_code`, `source_event_id`) -- AC 5, 6
- [ ] `read/projections/rd_scrap_pending.sql` -- create holding state (`scrap_pending_id`, `disposition_id`, `disposition_line_id`, `prototype_id`, `project_code`, `sku`, `quantity` positive, `condition_code`, `source_prototype_ref`, `status` CHECK `pending`, `source_event_id`, `created_at`) -- AC 6
- [ ] `read/projections/rd_build_record.sql` -- append forward-only `ALTER TABLE rd_build_record ADD COLUMN IF NOT EXISTS project_code TEXT`; mirror in `deploy/compose/init-db.sql` -- AC 2
- [ ] `src/events/schema.ts` -- add payload and envelope pairs for `rd_build.completed`, `rd_disposition.requested`, `rd_disposition.approved`, `rd_disposition.rejected`, `rd_disposition.executed`, `rd_material.returned`; add optional `project_code` to the `rd_build.recorded` payload; register all six on stream `research` with `requiresBusinessStream` false, next to the Story 10.2 entries -- wiring
- [ ] `src/compliance/rd-wip.ts` -- new seam: `postProjectWipForIssue(line, relieved, client, eventId)` writes one `issue` posting per `project_material` costing row; `applyRdReturnProjection` handles `rd_material.returned` (idempotency, source lock, open-quantity guard, return posting paired by `source_posting_id` and `reason_code`, stock restore via `applyStockReceipt`, valuation restore via `applyValuationReturn`), and `assertRdReturnShape` -- AC 1, 7
- [ ] `src/compliance/rd-issue.ts` -- persist the relieved valuation block on each persisted issue line (server-written, mirroring `production-material.ts:961`), then call `postProjectWipForIssue` for `project_material` lines after the costing insert; keep the existing ascending-SKU drain-then-relieve order -- AC 1
- [ ] `src/compliance/rd-prototype.ts` -- new seam: `assertRdBuildCompletedShape` and `applyRdBuildCompletedProjection` (require build outcome `success` else `RD_BUILD_NOT_COMPLETED`, validate active project via `assertProjectCodeActive`, validate lot belongs to the prototype SKU, insert `rd_prototype` and `serial_master`, map serial unique violation to `DUPLICATE_SERIAL`); export `nonSaleablePrototypeBlocked(lotIds, client)` and `isNonSaleableClass` for Epic 15 reuse -- AC 3, 4
- [ ] `src/compliance/rd-disposition.ts` -- new seam: request (resolve R&D head, `APPROVAL_REQUIRED`, reject a second open disposition, require lines for teardown and scrap), approve and reject (resolved approver only, requester cannot approve own request, `RD_DISPOSITION_ALREADY_DECIDED`), execute (`RD_DISPOSITION_NOT_APPROVED`; retain-as-asset via `insertAsset`; transfer-to-production stores `production_reference`; teardown writes component lines with condition codes; teardown and scrap write `rd_scrap_pending`; prototype set `disposed`) -- AC 5, 6
- [ ] `src/compliance/dispatch.ts` -- call `nonSaleablePrototypeBlocked` at both `applyDispatchShippingDocumentsGeneratedProjection` and `applyDispatchDispatchedProjection` and throw `NON_SALEABLE_CLASS` before any document or status mutation -- AC 4
- [ ] `src/read/projections/rd_project_wip_ledger.ts`, `rd_prototype.ts`, `rd_disposition.ts`, `rd_scrap_pending.ts` -- accessors in the `src/read/projections/rd_issue_cost.ts` style: WIP sums per project, prototype by id and list, disposition by id and list, scrap-pending by prototype and project -- AC 1, 3, 5, 6
- [ ] `src/api/v1/rd-wip.ts` -- `GET /api/v1/rd-projects/:projectCode/wip` and `GET /api/v1/rd-projects/:projectCode/builds` -- AC 1, 2
- [ ] `src/api/v1/rd-prototypes.ts` -- `POST /api/v1/rd-builds/:buildId/complete`, `GET /api/v1/rd-prototypes`, `GET /api/v1/rd-prototypes/:prototypeId` -- AC 3
- [ ] `src/api/v1/rd-dispositions.ts` -- `POST /api/v1/rd-prototypes/:prototypeId/dispositions`, `GET /api/v1/rd-dispositions/:dispositionId`, approve, reject, execute -- AC 5, 6
- [ ] `src/api/v1/rd-returns.ts` -- `POST /api/v1/rd-projects/:projectCode/returns` -- AC 7
- [ ] `src/api/v1/rd-boms.ts`, `src/compliance/rd-bom.ts`, `src/read/projections/rd_build.ts` -- accept optional `project_code` on build recording, validate it against an active project when supplied, and persist it on `rd_build_record` -- AC 2
- [ ] `src/events/store.ts` -- wire the three new assert/apply seams -- wiring
- [ ] `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts` -- append the five new projection files and mirror them; add five `EXPECTED` entries -- wiring
- [ ] `src/server.ts` -- import and mount the new handlers -- wiring
- [ ] `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json` -- declare `NON_SALEABLE_CLASS`, `RD_PROTOTYPE_NOT_FOUND`, `RD_PROTOTYPE_ALREADY_DISPOSED`, `RD_DISPOSITION_NOT_FOUND`, `RD_DISPOSITION_ALREADY_DECIDED`, `RD_DISPOSITION_NOT_APPROVED`, `RD_DISPOSITION_LINE_REQUIRED`, `RD_RETURN_EXCEEDS_OPEN`, `RD_BUILD_NOT_COMPLETED` -- contract parity
- [ ] `test/integration/story-1-9.test.ts` -- add every new route to `allowedSpineRoutes` -- spine gate
- [ ] `test/integration/story-10-3.test.ts` -- cover each AC and each I/O matrix row plus replay idempotency -- verification

**Acceptance Criteria:**
- Given project material issued against a project, when the project WIP ledger is read, then it shows accumulated quantity and cost for that project and only `project_material` postings contribute.
- Given a prototype build recorded with outcome success, failed, or abandoned, when the build is recorded, then a build record and its as-built lines capture the full material history.
- Given a completed build whose outcome is success, when it is registered, then it is registered as a serialized `prototype`-class non-saleable record.
- Given a registered serialized prototype, when a dispatch document is generated or the dispatch is finalized against its lot, then the transaction is blocked with `error_code: "NON_SALEABLE_CLASS"`, and the same guard is exported for the Epic 15 sales-order allocation to call.
- Given a registered prototype, when a retain-as-asset, transfer-to-production, teardown, or scrap disposition is requested, then the disposition is `approval_required` with `error_code: "APPROVAL_REQUIRED"` until the R&D head approves it; teardown recovers components with condition codes, retain-as-asset creates an Epic 7 asset entry, and transfer-to-production records a production-reference designation.
- Given an approved teardown or scrap disposition, when it is executed, then its lines are placed in `rd_scrap_pending` carrying quantity, condition code, and source-prototype reference and are visible in the project material history.
- Given unused project material, when a return is recorded against its issue posting, then the return reverses WIP by the returned cost and cannot exceed the source posting open quantity, else `error_code: "RD_RETURN_EXCEEDS_OPEN"`.

## Spec Change Log
- 2026-11-23 Initial spec. Decided that prototype registration writes `rd_prototype` plus `serial_master` only, with no `stock_balance` or valuation row, because prototype cost is carried in project WIP and a stock row would double-count on-hand. Decided that `NON_SALEABLE_CLASS` is new (the repo only has `PROTOTYPE_NOT_SALEABLE`); the AC contract name wins. Decided that "issue-to-dispatch" maps to the two existing dispatch boundaries (shipping-document generation and final dispatch) because no separate issue-to-dispatch path exists. Decided that build records gain an optional `project_code` so AC 2 is testable at project grain for failed and abandoned builds.

## Review Triage Log
## Design Notes
WIP is project and SKU grain, distinct from production WIP. `rd_project_wip_ledger` mirrors `production_wip_ledger`'s posting types and pairing CHECK: an `issue` posting has `source_posting_id` null, `reason_code` null, and a non-null `open_quantity`; a `return` posting has both set and `open_quantity` null. One `issue` posting is written per `rd_issue_cost` row for `project_material` only, carrying the costing row's quantity, unit cost, and value. Consumable issues are expensed and equipment custody is a loan, so neither posts WIP.

The return reverses exactly what the issue took out. The issue seam persists the relieved `ValuationOutflow` block on the persisted `rd_requisition.issued` line (server-written, as `production-material.ts` does), so the return can call `applyValuationReturn` with the frozen issue share and `returned_before = quantity - open_quantity`; it never uses today's average. The return restores stock through `applyStockReceipt` at the source posting's SKU and the caller-supplied location and lot, and refuses any quantity above `open_quantity` or any source that is not an `issue` posting.

Prototype registration is a completion step over the existing BOM build record. `rd_build.recorded` and `rd_build.confirmed` already capture the full material history including `outcome` `failed` and `abandoned`; Story 10.3 adds an optional `project_code` so those builds appear in project history. `rd_build.completed` registers only a build whose outcome is `success`, writing the serialized identity to `rd_prototype` and `serial_master`. No `stock_balance` or valuation row is created: the materials left saleable stock when issued, and their cost lives in project WIP, so a second stock row would double-count on-hand. The prototype's `stock_class` column carries `prototype`, validated against the existing `NON_SALEABLE_STOCK_CLASSES` vocabulary.

The non-saleable guard is a reusable exported function, `nonSaleablePrototypeBlocked`, that resolves candidate dispatch lot ids against `rd_prototype` where status is `registered`. It runs at both dispatch boundaries after `dispatchGateBlockedLots` and before any document or status mutation, and throws `NON_SALEABLE_CLASS`. Epic 15 will call the same function for sales-order allocation.

Dispositions are a four-state machine: `approval_required` on request, then `approved` or `rejected`, then `executed`. The R&D head is resolved with the transaction-aware `resolveHeadApproverInTransaction` from the DOA registry so approval is atomic with the transaction; the requester can never be the approver. Execute branches: retain-as-asset inserts into the Epic 7 asset register through `insertAsset` and stores `asset_id`; transfer-to-production stores a `production_reference`; teardown writes component lines with condition codes and scrap-pending rows; scrap writes scrap-pending rows. Teardown and scrap lines carry quantity, condition code, and a source-prototype reference so Epic 16 can consume the holding state without rework. Executing any disposition sets the prototype status to `disposed` and a disposed prototype cannot be disposed again (`RD_PROTOTYPE_ALREADY_DISPOSED`).

## Verification
**Commands:**
- `npm run test:integration -- test/integration/story-10-3.test.ts` -- expected: all pass
- `npx tsc --noEmit` -- expected: no errors
- `npm run lint` -- expected: clean
- `npm run db:migrate` -- expected: idempotent on a second run
- `npm test` -- expected: no new failures versus baseline
- `npm run spine-acceptance-contract` -- expected: pass
- `npm run edge:typecheck` -- expected: clean
- `npx tsx --test test/unit/schema-drift.test.ts test/unit/no-hardcoded-role-in-workflow.test.ts` -- expected: pass

**Manual checks (if no CLI):**
- `read/projections/rd_project_wip_ledger.sql`, `rd_prototype.sql`, `rd_disposition.sql`, `rd_disposition_line.sql`, `rd_scrap_pending.sql` contain only idempotent DDL and guarded grants.
- `src/compliance/rd-prototype.ts` exports `nonSaleablePrototypeBlocked` and `isNonSaleableClass`, and no prototype row is written to `stock_balance` or `inventory_valuation`.
