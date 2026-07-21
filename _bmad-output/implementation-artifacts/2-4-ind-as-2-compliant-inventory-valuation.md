# Story 2.4: Ind AS 2 Compliant Inventory Valuation

Status: ready-for-dev

## Story

As a financial controller,
I want inventory valued using FIFO, weighted average, or specific identification, selectable per item, with standard cost permitted only as an Ind AS 2 paragraph 21 measurement technique, LIFO structurally blocked, and NRV testing run at period end,
so that the stock ledger is Ind AS 2 compliant from the first transaction and no non-permitted valuation method can be applied.

## Acceptance Criteria

1. Given item `RM-0042` is configured with `valuation_method: "weighted_average"`, when receipt events are posted at varying unit costs such as 10, 12, then 14, directly via the stock-event API against open-PO line projections within Epic 2 or from GRNs once Epics 3 and 4 deliver receiving, then the running weighted average cost updates after each receipt and is queryable via `GET /api/v1/stock/RM-0042/valuation`.
2. Given item `FG-0010` is configured with `valuation_method: "fifo"`, when an issue transaction is posted, then the cost of the issued quantity is calculated from the earliest available lot at its received cost.
3. Given an administrator attempts to set `valuation_method: "lifo"` on any item, when the update request is submitted, then the write is rejected with `error_code: "VALUATION_METHOD_NOT_PERMITTED"`.
4. Given NRV testing is run and an item's net realisable value has fallen below cost, when the NRV write-down event is posted, then the item's carrying value is reduced to NRV, the write-down is recorded with date and authoriser, and any subsequent recovery is capped at original cost.
5. Given item `EQ-0500` is serial-controlled with `valuation_method: "specific_identification"`, serial `SN-1001` was received at unit cost 12,000, and serial `SN-1002` was received at unit cost 13,500, when an issue transaction for serial `SN-1002` is posted, then the issue cost is exactly 13,500 and the remaining carrying value for `EQ-0500` is 12,000.
6. Given an administrator configures standard cost for an item, when the configuration is submitted, then standard cost is accepted only as an Ind AS 2 paragraph 21 measurement technique, the configuration carries a variance-review cadence, the period-end valuation report shows standard-versus-actual variance per item with breaches of the configured tolerance flagged for review, and setting `valuation_method: "standard_cost"` without the measurement-technique designation is rejected with `error_code: "VALUATION_METHOD_NOT_PERMITTED"`.

## Tasks / Subtasks

- [ ] Task 1: Add valuation configuration and stable error semantics on item master. (AC: 3, 6)
  - [ ] Preserve the current structural LIFO block in `read/projections/item_master.sql` and `src/read/projections/item_master.ts`; do not weaken the allowed-method constraint to make standard cost a normal method.
  - [ ] Add the Story 2.4 standard-cost measurement-technique fields needed by AC6: `standard_cost_designation`, `standard_cost_amount`, `variance_review_cadence`, and `variance_tolerance_percent`. `standard_cost_designation` must equal `ind_as_2_para_21_measurement_technique` before standard-cost reporting is enabled.
  - [ ] Update `src/api/v1/items.ts` create and patch paths so LIFO and bare `standard_cost` both return `VALUATION_METHOD_NOT_PERMITTED`, not the existing `INVALID_VALUATION_METHOD` code.
  - [ ] Mirror item-master DDL changes in `deploy/compose/init-db.sql` and extend `test/unit/schema-drift.test.ts`.
- [ ] Task 2: Create an event-sourced valuation projection seam. (AC: 1, 2, 4, 5, 6)
  - [ ] Add `src/compliance/inventory-valuation.ts` with a pre-transaction shape guard and an in-transaction projection apply function, following the `stock-balance.ts` seam split.
  - [ ] Wire the valuation seam through `src/events/store.ts` after lot/serial resolution and stock-balance validation, inside the same transaction as the `domain_events` insert.
  - [ ] Gate the seam only to `stream_type: "inventory"` and valuation-relevant `stock.received`, `stock.issued`, `stock.nrv_write_down_recorded`, `stock.nrv_recovery_recorded`, and `stock.standard_cost_variance_reviewed` events so DOA, SCIM, audit, item-master, and unrelated inventory fixtures remain unaffected.
  - [ ] Add the idempotency no-op check before projection mutation so duplicate event retries do not double-apply costs.
- [ ] Task 3: Add canonical valuation read models. (AC: 1, 2, 4, 5, 6)
  - [ ] Add self-sufficient canonical SQL for valuation summary, FIFO cost layers, NRV history or adjustments, and standard-cost variance state under `read/projections/`.
  - [ ] Use PostgreSQL `NUMERIC` for unit cost, running average, layer balances, carrying value, variance, NRV amount, and recovery caps; do not use JavaScript floating point for monetary comparisons or accumulation.
  - [ ] Include guarded grants in every new canonical SQL file and mirror every definition in `deploy/compose/init-db.sql`.
  - [ ] Register all new canonical projection files in `src/events/migrate.ts` and extend schema drift coverage.
- [ ] Task 4: Implement receipt and issue costing rules. (AC: 1, 2, 5)
  - [ ] Weighted average: every owned-stock receipt with `unit_cost` updates the running weighted average exactly once and exposes the updated value through the valuation projection.
  - [ ] FIFO: issue costing consumes cost layers in deterministic earliest-received order, with row locks under the event transaction; do not use the current arbitrary `lot_id NULLS FIRST, balance_id` quantity-drain order as the cost rule.
  - [ ] Un-lotted demand-side issues may intentionally draw across lots per shipped Story 2.2 behavior, but valuation must still deplete FIFO layers deterministically and may need multi-layer costing even when the physical issue omitted `lot_id`.
  - [ ] Specific identification: capture or derive per-serial received cost so issuing `SN-1002` costs the serial's own 13,500 and leaves `SN-1001` carrying 12,000.
  - [ ] Exclude customer-owned or non-owned stock classes from owned inventory valuation unless a later story explicitly requires a separate custody valuation view.
- [ ] Task 5: Implement NRV write-down and recovery cap flow. (AC: 4)
  - [ ] Add `POST /api/v1/stock/:sku/valuation/nrv-write-down` to post `stock.nrv_write_down_recorded` with `effective_date`, `authoriser_actor_id`, `original_cost`, `current_carrying_value`, `nrv_amount`, `write_down_amount`, `cumulative_write_down`, `reason`, and `evidence_ref`.
  - [ ] Add `POST /api/v1/stock/:sku/valuation/nrv-recovery` to post `stock.nrv_recovery_recorded` with `effective_date`, `authoriser_actor_id`, `original_cost`, `current_carrying_value`, `recovery_amount`, `post_recovery_carrying_value`, `reason`, and `evidence_ref`.
  - [ ] Use the existing caller-owned transaction pattern with `persistEvent(..., client)` so the NRV event, projection update, and audit row commit atomically.
  - [ ] Use DOA resolution for value-banded write-down and recovery authorisation; do not hard-code approver roles.
  - [ ] Reject any recovery above original cost with stable error code `NRV_RECOVERY_EXCEEDS_ORIGINAL_COST` and edge classification.
- [ ] Task 6: Add stock valuation and reporting query surfaces. (AC: 1, 4, 6)
  - [ ] Add `GET /api/v1/stock/:sku/valuation` returning projection-backed valuation summary, method, carrying value, visible locations, and method-specific details needed by AC1.
  - [ ] Enforce inventory read RBAC and location scoping on the valuation route; valuation is cost-level data and must not rely on UI-only hiding.
  - [ ] Grant valuation and NRV read access to `warehouse_manager`, `inventory_controller`, and `finance_controller`; exclude store assistant, stock locator, and dispatch clerk unless a later access-matrix update says otherwise.
  - [ ] Add period-end standard-versus-actual variance report data for standard-cost measurement-technique items, including tolerance-breach flags.
  - [ ] Register new routes in `src/server.ts` and update the Story 1.9 route-surface guard.
- [ ] Task 7: Add edge, stable error, and i18n updates. (AC: 3, 6)
  - [ ] Add `VALUATION_METHOD_NOT_PERMITTED` to the architecture stable error-code list.
  - [ ] Add `VALUATION_METHOD_NOT_PERMITTED` and `NRV_RECOVERY_EXCEEDS_ORIGINAL_COST` to `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json`, `test/unit/sync-upload.test.ts`, and `edge/test/unit/connector.test.ts`.
  - [ ] Ensure permanent business rejections settle the affected edge event as `needs_attention` and do not halt the entire outbox.
- [ ] Task 8: Add integration, unit, drift, and regression coverage. (AC: 1, 2, 3, 4, 5, 6)
  - [ ] Create `test/integration/story-2-4.test.ts` covering all six acceptance criteria against the production router and real PostgreSQL projections.
  - [ ] Include idempotent retry coverage proving running average, FIFO layers, NRV adjustments, and serial costs update exactly once.
  - [ ] Include rejected-write coverage proving invalid valuation methods and invalid recoveries do not insert `domain_events`, do not write audit success rows, and do not consume idempotency keys.
  - [ ] Include concurrency coverage for last-layer FIFO depletion and weighted-average receipts using coordinated database clients or promises, not parallel test runners.
  - [ ] Update `test/integration/story-2-1.test.ts` so `lifo` and `standard_cost` expect `VALUATION_METHOD_NOT_PERMITTED`; malformed empty valuation method may retain `INVALID_VALUATION_METHOD` if the implementation keeps that distinction.
  - [ ] Extend `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `test/unit/sync-upload.test.ts`, and `edge/test/unit/connector.test.ts` for every new table, route, and stable error.

## Dev Notes

### Epic Context

Epic 2 makes the inventory ledger answer what stock exists, where it sits, and what it is worth in real time across locations. Story 2.4 is the valuation layer over the existing Epic 2 foundations: item and location masters from Story 2.1, stock-balance projection and central insufficient-stock enforcement from Story 2.2, and lot/serial traceability from Story 2.3. The story implements FR-I-05, FR-AC-05, and FR-AC-06 for Ind AS 2 compliant valuation by FIFO, weighted average, specific identification, period-end NRV testing, and structurally blocked LIFO. [Source: `_bmad-output/planning-artifacts/epics.md:1007`]

Story 2.4 must work before Epics 3 and 4 provide GRN receiving and before Story 2.9 creates ERP open-PO projections. During this story, AC1 is testable with direct priced `stock.received` events; do not implement or stub Story 2.9. Once Story 2.9 and later GRN flows exist, they must feed the same valuation seam, not a second costing engine. [Source: `_bmad-output/planning-artifacts/epics.md:1017`; Source: `_bmad-output/implementation-artifacts/sprint-status.yaml:178`]

Epic 2 migration prep requires opening stock to be physically verified by location, lot, and serial and validated against the live ledger before pilot go-live. Valuation layers must support opening-stock cost layers rather than assuming all cost history starts after go-live. [Source: `_bmad-output/planning-artifacts/epics.md:359`]

### Architecture Compliance

- Read models are PostgreSQL projections built from the event stream; reporting reads projections and must not replay event streams at request time. The valuation endpoint must answer from projections. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:148`]
- State mutation happens only through events; current valuation, cost layers, and NRV carrying values are derived projection state. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:172`]
- Event envelopes use `event_id`, `stream_type`, `stream_id`, `event_type`, monotonic `event_version`, JSONB payload, actor metadata, UTC `occurred_at`, and `schema_version`. New valuation events must fit the existing envelope. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:278`]
- APIs are REST under `/api/v1/`, SSO-gated, and use the uniform `{ error_code, message, details, trace_id }` envelope. Mutating valuation operations must be audit logged. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:328`]
- The pinned stack is Node.js 24 LTS, PostgreSQL 18.4, TypeScript 5.x, Next.js 16, PowerSync 1.23.x, Docker Compose, and self-hosted PostgreSQL read models. Do not add a decimal or ORM dependency for this story. [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:190`]

### Current Code State

- `persistEvent()` is the central write path. It runs tagging, calibration, inventory-master, stock-balance shape, and lot/serial shape checks before opening the transaction, then applies lot/serial and stock-balance projections inside the transaction before inserting `domain_events`. Add valuation here, not in a route-only path. [Source: `src/events/store.ts:150`]
- `src/compliance/stock-balance.ts` already defines the seam pattern: non-DB shape validation before any write and projection mutation inside the event transaction. Copy that split for valuation. [Source: `src/compliance/stock-balance.ts:78`; Source: `src/compliance/stock-balance.ts:141`]
- `stock.received` currently accepts optional non-negative `unit_cost`, but stock-balance does not project any cost. Story 2.4 must consume that payload field without making it mandatory for legacy or non-valuated events unless the item configuration demands it. [Source: `src/compliance/stock-balance.ts:116`]
- `stock_balance` stores quantity only at `sku`, `location_id`, `lot_id`, and `stock_class` grain. It has no unit-cost, layer-cost, carrying-value, or NRV columns. [Source: `read/projections/stock_balance.sql:18`]
- `stock_balance.lot_id` is a lot-number text value, while `lot_trace.lot_id` is the lot UUID. Valuation joins must not mix these identifiers. [Source: `src/read/projections/stock_balance.ts:20`]
- Item master currently allows only `fifo`, `weighted_average`, and `specific_identification` in TypeScript and SQL. LIFO is structurally blocked, but the API currently reports invalid methods as `INVALID_VALUATION_METHOD`; AC3 and AC6 require `VALUATION_METHOD_NOT_PERMITTED`. [Source: `src/read/projections/item_master.ts:11`; Source: `read/projections/item_master.sql:29`; Source: `src/api/v1/items.ts:80`]
- `serial_master` tracks serial existence, location, lot number, quantity, and status, but not received unit cost. Specific identification requires a per-serial received cost source. [Source: `read/projections/serial_master.sql:13`]
- `GET /api/v1/stock/:sku` is projection-backed and location-scoped. Add `/valuation` without changing the existing stock response shape. [Source: `src/api/v1/stock.ts:21`; Source: `src/api/v1/stock.ts:80`]
- The production route surface is guarded in `test/integration/story-1-9.test.ts`; every new valuation route must be added there. [Source: `test/integration/story-1-9.test.ts:151`]
- Canonical migrations live in the single-line `MIGRATIONS` array in `src/events/migrate.ts`; add new valuation files without reformatting unrelated entries unless necessary. [Source: `src/events/migrate.ts:8`]

### File Structure Requirements

Likely update files:

- `src/events/store.ts`
- `src/compliance/stock-balance.ts`
- `src/read/projections/item_master.ts`
- `read/projections/item_master.sql`
- `src/api/v1/items.ts`
- `src/api/v1/stock.ts`
- `src/compliance/lot-serial-validation.ts`
- `src/read/projections/serial_master.ts`
- `read/projections/serial_master.sql`
- `src/server.ts`
- `src/events/migrate.ts`
- `deploy/compose/init-db.sql`
- `src/sync/upload.ts`
- `edge/src/sync/connector.ts`
- `edge/src/messages/en.json`
- `test/integration/story-1-9.test.ts`
- `test/integration/story-2-1.test.ts`
- `test/unit/schema-drift.test.ts`
- `test/unit/sync-upload.test.ts`
- `edge/test/unit/connector.test.ts`

Likely new files:

- `src/compliance/inventory-valuation.ts`
- `src/read/projections/inventory_valuation.ts`
- `read/projections/inventory_valuation.sql`
- `read/projections/inventory_valuation_layer.sql` if FIFO layers are separate from the summary projection
- `src/read/projections/inventory_valuation_layer.ts` if FIFO layers are separate from the summary projection
- `test/integration/story-2-4.test.ts`
- Edge classifier tests if no existing test can be extended cleanly

### Valuation Design Guardrails

- Prefer a dedicated valuation projection over extending `stock_balance`. Valuation needs cost layers, per-serial cost identity, NRV history, original-cost caps, and variance state that do not fit the quantity projection grain.
- Weighted average formula must be SQL-side and lock the relevant valuation row before update. Accept monetary payloads as decimal strings where new APIs are introduced; if existing stock-event JSON numbers are accepted for compatibility, convert them to SQL `NUMERIC` immediately and return exact decimal strings. Do not accumulate money in JavaScript numbers.
- FIFO costing must deplete cost layers under `FOR UPDATE` row locks and may need to split one issue across multiple layers. Story 2.3 deferred that FEFO/FIFO lot selection cannot split a request across lots; Story 2.4 cannot inherit that limitation for costing if an un-lotted issue drains multiple layers.
- Specific identification must cost the exact issued serial, not any serial for the SKU. Store the serial's received cost at receipt time or in a valuation layer keyed by serial number.
- NRV write-down and recovery must preserve original cost separately from current carrying value so recovery can never exceed original cost.
- Standard cost is not a fourth valuation method. Treat it as a measurement technique configuration on top of actual-cost tracking, with variance cadence, tolerance, and period-end report output.
- Stock classes `consignment`, `vmi`, and `job_work` are not owned inventory for Ind AS 2 carrying value unless a later story defines a separate reporting treatment. Do not blend them into owned valuation totals.
- Rejected valuation writes must fail before `domain_events` insert and must not consume idempotency keys. Duplicate submissions must surface `DUPLICATE_EVENT` and leave projections unchanged.
- Do not add kit assembly, kit disassembly, ERP writeback, or GRN receiving flows in this story. Epic 2 explicitly excludes kit transactions, and receiving arrives in later epics.

### Previous Story Intelligence

Story 2.3 finished after multiple adversarial review passes. The key lesson is that a green suite is not enough if invariants are not explicitly tested. Story 2.4 must include direct tests for torn writes, duplicate retries, multi-layer depletion, and projection consistency, not only happy-path AC assertions. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:114`]

Story 2.3 established these patterns Story 2.4 must reuse:

- Add compliance logic through the central `persistEvent()` path so HTTP and edge sync are covered by construction. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:231`]
- Keep projection DDL self-sufficient with guarded grants and mirror it in compose init. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:233`]
- Add stable errors to the architecture list, server sync classifier, edge classifier, and edge i18n together. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:358`]
- Preserve shipped Story 2.2 behavior: un-lotted demand-side allocation and issue may draw against any lot at a location. Story 2.4 must define costing for this case rather than changing the physical stock behavior. [Source: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:143`]
- `LOT_REQUIRED` now applies to lot-controlled, non-serial, target-location receives and issues; serial control takes precedence and `stock.allocated` remains exempt. Valuation must not regress that contract. [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml:51`]

Deferred items relevant to Story 2.4:

- `in_transit` is not written until Story 2.5, so valuation must not assume it represents active inventory state. [Source: `_bmad-output/implementation-artifacts/deferred-work.md:58`]
- Expiry and period-end date logic has a server-local versus SQL `CURRENT_DATE` split. For NRV period-end logic, choose one clock source deliberately and document it in code and tests. [Source: `_bmad-output/implementation-artifacts/deferred-work.md:64`]
- Serial quantity reconciliation has a JavaScript float hazard. Cost math must avoid repeating that pattern. [Source: `_bmad-output/implementation-artifacts/deferred-work.md:67`]
- FEFO/FIFO selection cannot currently split a request across lots. FIFO valuation likely must split cost depletion across multiple layers. [Source: `_bmad-output/implementation-artifacts/deferred-work.md:68`]

### API and Error Contract

- Add `GET /api/v1/stock/:sku/valuation` and keep it projection-backed. The route should validate SKU the same way as `GET /api/v1/stock/:sku`, enforce inventory read RBAC, and filter or aggregate only locations visible to the caller.
- The access matrix grants valuation and NRV views to `warehouse_manager` and `inventory_controller`; `finance_controller` has multi-site valuation views. Store assistant, stock locator, and dispatch clerk have no valuation/NRV read access by default. [Source: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:90`; Source: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md:171`]
- Use `POST /api/v1/stock/:sku/valuation/nrv-write-down` and `POST /api/v1/stock/:sku/valuation/nrv-recovery` for AC4 mutations, protected by DOA-resolved value-banded authorisation.
- `VALUATION_METHOD_NOT_PERMITTED` is AC-required and missing from the current architecture stable error list. Add it everywhere stable errors are registered.
- Existing `INVALID_VALUATION_METHOD` can remain for malformed unknown values only if implementation intentionally differentiates malformed input from prohibited methods. LIFO and undesignated standard cost must use `VALUATION_METHOD_NOT_PERMITTED`.
- All new user-facing errors need edge i18n entries; do not rely on raw backend messages.

### Testing Requirements

Run or add tests so these commands are expected to pass before the dev agent marks done:

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run edge:typecheck`
- `npm run edge:lint`
- `npm run edge:test`
- `npm run spine-acceptance-contract`
- `git diff --check`

Integration tests require a running PostgreSQL container and run serially via `--test-concurrency=1`. Use the production `createAppRouter()` and real auth/RBAC/SCIM setup, as prior stories do.

Test cases must include:

- Weighted average updates after each of three receipts and survives idempotent duplicate submission.
- Monetary precision covers fractional costs and quantities such as `0.1`, `0.2`, and `12.345678`, asserting exact decimal-string outputs and no JavaScript floating-point drift.
- FIFO issues consume earliest received cost layers and split across layers when needed, using deterministic lock ordering to avoid deadlocks under concurrent writes.
- LIFO create and patch attempts return `VALUATION_METHOD_NOT_PERMITTED`.
- NRV write-down records date, authoriser, carrying value reduction, original cost, and capped recovery.
- Specific identification serial issue costs the exact serial and leaves the other serial's carrying value unchanged.
- Standard cost without measurement-technique designation is rejected; valid designation produces variance data and tolerance-breach flags.
- Edge upload classification settles valuation business-rule rejections as `needs_attention`.
- Schema drift and route-surface guards cover every new table, constraint, index, grant, and route.

### References

- Story definition and ACs: `_bmad-output/planning-artifacts/epics.md:1007`
- Architecture read-model rule: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:148`
- API and stable error conventions: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md:328`
- Central event write path: `src/events/store.ts:150`
- Stock-balance seam: `src/compliance/stock-balance.ts:78`
- Item valuation method gate: `src/api/v1/items.ts:80`
- Item SQL valuation constraint: `read/projections/item_master.sql:29`
- Stock quantity projection: `read/projections/stock_balance.sql:18`
- Stock API query pattern: `src/api/v1/stock.ts:21`
- Story 2.3 review learnings: `_bmad-output/implementation-artifacts/2-3-lot-batch-and-serial-traceability.md:114`
- Deferred FIFO and precision hazards: `_bmad-output/implementation-artifacts/deferred-work.md:64`

## Project Structure Notes

The implementation must keep canonical SQL under `read/projections/`, TypeScript projection helpers under `src/read/projections/`, write-path business rules under `src/compliance/`, REST handlers under `src/api/v1/`, and route registration in `src/server.ts`. New migration files must be registered in `src/events/migrate.ts` and mirrored in `deploy/compose/init-db.sql`.

No project-context files were found during activation. Active durable project decisions still apply: tagging enforcement belongs in `persistEvent`, tagging enforcement must stay scoped to inventory movement streams, and multi-file migrations must be self-sufficient with guarded grants.

## Open Clarifications Saved for Dev Judgment

- Whether `VALUATION_METHOD_NOT_PERMITTED` fully replaces `INVALID_VALUATION_METHOD` for all disallowed values or only for LIFO and undesignated standard cost. The story requires LIFO and undesignated standard cost to use `VALUATION_METHOD_NOT_PERMITTED`; malformed empty values may retain `INVALID_VALUATION_METHOD`.
- Whether the team wants one combined `inventory_valuation` table or separate summary, layer, serial-cost, and NRV-adjustment tables. Separate tables are recommended for clarity and safer locking.
- Which exact RBAC function scope gates NRV mutation routes before DOA lookup. Value-banded approval must use the existing DOA registry rather than hard-coded finance roles.
- Which clock source is authoritative for period-end NRV tests. SQL `CURRENT_DATE` is recommended for consistency with projection queries, but existing lot expiry code has mixed clock usage.

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Activation workflow resolved with no prepend or append steps.
- Persistent project-context file glob returned no files.
- Story auto-discovered from first backlog sprint-status entry: `2-4-ind-as-2-compliant-inventory-valuation`.
- Recent git history reviewed: latest relevant Story 2.3 commits end at `775a6cf`; current worktree was clean before this story creation.

### File List

- `_bmad-output/implementation-artifacts/2-4-ind-as-2-compliant-inventory-valuation.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Ultimate Context Engine Completion

This story document includes the Epic 2 context, Story 2.4 acceptance criteria, architecture guardrails, current code state, previous-story intelligence, file-level implementation map, testing requirements, and saved clarifications needed for a dev agent to implement the story without reinventing existing seams or breaking shipped behavior.
