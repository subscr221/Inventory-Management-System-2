# Deferred Work

## Deferred from: code review of 1-1-core-infrastructure-deployment-and-event-store-schema.md (2026-07-12)

- No authentication or authorization anywhere [src/server.ts:515] — deferred, pre-existing (Story 1.2 scope)
- `readStream` has no pagination or limit [src/events/store.ts:396-421] — deferred, pre-existing (Not required in Story 1.1)
- Global idempotency uniqueness is likely too broad [events/domain_events.sql:20] — deferred, pre-existing (Matches spec requirements)
- `trace_id` is generated fresh per error and never logged [src/middleware/error.ts:455] — deferred, pre-existing
- Migration has no versioning and a brittle path [src/events/migrate.ts:210] — deferred, pre-existing (Full migration system out of scope)
- Extra/unknown properties are silently accepted [src/events/store.ts] — deferred, pre-existing

## Deferred from: code review of 1-3-statutory-edit-log.md (2026-07-14)

- Archival retention math uses calendar-year subtraction, not financial-year boundaries [src/cli/archive-audit-log.ts] — deferred, pre-existing open question in spec (story's own "Open Questions for the Team" already flags the FY start date as unconfirmed)
- `range_digest` is computed at read-time over the returned page, not via write-time hash chaining [src/api/v1/audit.ts:42-44] — deferred, matches existing spec design (Dev Notes define `range_digest` this way); strengthening to cryptographic chaining is an architecture-level change beyond this story's scope

## Deferred from: code review of 1-3-statutory-edit-log.md (2026-07-18)

- SCIM directory mutations commit before the event+audit write, so a crash between the two transactions leaves an access-rights change with no audit entry [src/adapters/iam/scim.ts:62] - deferred, pre-existing two-phase design from Story 1.2 with an in-code follow-up note ("bring the event into the same transaction as the directory write")
- Audit `location_id` is client-supplied for wildcard-grant callers; a `*` grant matches any UUID, so a wildcard admin can stamp an arbitrary location into the audit row [src/api/v1/events.ts:75] - deferred, blocked on the location register (Stories 1.6/2.1) for server-side validation
- Archive CLI loads the entire eligible row set into memory with no batching [src/cli/archive-audit-log.ts:19] - deferred, no eligible rows can exist until 8 financial years after go-live; add batching before the retention horizon
- `read/projections/users.sql` carries no grants (they live only in `deploy/compose/init-db.sql`), so a migrate-only-provisioned database cannot execute SCIM writes as `app_user` - same split-brain class the audit tables just had fixed [read/projections/users.sql] - deferred, pre-existing Story 1.2 scope; apply the same canonical-file grant pattern there
- SCIM real-change paths commit the directory mutation before persistEvent, so a persistEvent failure yields a committed change with a 500 and no edit-log record (failure-path AC1 hole) [src/adapters/iam/scim.ts] - deferred, same pre-existing two-phase design already tracked above; the fix (single transaction) covers both entries

## Deferred from: code review of 1-7-calibration-lockout-enforcement (2026-07-19)

- `location.disputed` generated event uses a narrow raw insert instead of the central `persistEvent` path [src/compliance/location.ts:68-81] - closed as by-design, not deferred work. This is the explicit Story 1.6 review decision so operator tagging rules cannot reject a valid generated dispute; reverting to `persistEvent` re-broke the Story 1.6 tagging-immunity regression test. Reopen only if generated events later need audit/idempotency parity without tagging.
- Calibration lockout is a non-transactional TOCTOU read [src/compliance/calibration.ts:32] - deferred, pre-existing architectural pattern shared with the tagging and location assertions; the status-flip window is limited to admin maintenance writes.
- Duplicated DDL and redundant inline-plus-guard constraint blocks between the canonical migration and the compose mirror [read/projections/instrument_calibration.sql, deploy/compose/init-db.sql] - deferred, the mirror duplication is required by the story; drift risk noted for future maintenance.

## Deferred from: code review of 1-8-offline-edge-pwa-shell-and-powersync-sync-layer (2026-07-20)

- `svc_powersync` (WITH REPLICATION) is created only in `deploy/compose/init-db.sql`; the guarded grant in `sync/migrations/powersync.sql` silently skips on a migrate-only, non-compose database - deferred, consistent with this repo's established role-provisioning pattern (all roles are created in init-db.sql; migrations only guard grants).
- AC4 "related balance or state updated exactly once" is not exercised because the duplicate test uses an inert `maintenance` stream with no projection [test/integration/story-1-8.test.ts] - deferred, acceptable under the test-capture scope.

## Deferred from: code review of 1-10-ci-cd-pipeline-construction (2026-07-20)

- `deploy/pipeline/verify.sh` (Task 3.6's dry-run mode) is never invoked automatically by any CI/CD job or schedule, so there is no automated drift detection if branch protection or environment settings are later changed through the GitHub UI [deploy/pipeline/verify.sh] - deferred, not required by Task 3.6's literal ask
- `bootstrap-runner.sh` is not idempotent against a partially-provisioned host: a corrupt cached runner package is not re-verified, and re-running against a host with the runner service already installed aborts under `set -e` [deploy/pipeline/runner/bootstrap-runner.sh:52-58,71-77] - deferred, script's own docstring scopes reproducibility to a clean host only
- `backend-tests` and `spine-acceptance-contract` CI jobs duplicate the entire postgres provisioning block verbatim [.github/workflows/ci.yml:44-57,72-90] - deferred, correct per Task 2.5's per-job database isolation requirement, but a third copy of provisioning knowledge to keep in sync

## Deferred from: code review of 1-10-ci-cd-pipeline-construction (2026-07-20, third pass)

- Runtime database role passwords (`app_user`, `readonly_user`, `replication_user`, `svc_powersync`) are created with committed default passwords rather than deployment secrets [deploy/compose/init-db.sql, deploy/compose/docker-compose.yml] - deferred, pre-existing (predates Story 1.10) and lives in Story 1.11's active working files, so out of Story 1.10's diff scope. A fail-closed attempt during the second review pass was reverted because it broke `deploy/compose/.env`-driven flows (`sync:smoke`, `provision.sh`), which define no `READONLY_PASSWORD`. Needs a dedicated secrets-hardening story that also updates `.env.example`, `deploy/compose/.env`, and the smoke harness together.

## Deferred from: code review of 1-10-ci-cd-pipeline-construction (2026-07-20, fourth pass)

- GitHub Actions and Docker actions are referenced by mutable version tags rather than commit SHAs [.github/workflows/ci.yml, .github/workflows/cd.yml] - deferred, supply-chain hardening beyond Story 1.10's acceptance criteria
- Runner binary download is not integrity-verified before installation [deploy/pipeline/runner/bootstrap-runner.sh:52-58] - deferred, hardening should be handled with the broader runner-provisioning story

## Deferred from: code review of 1-11-notification-and-alerting-foundation (2026-07-20)

- Unbounded sequential per-event fan-out: `resolveTargetUserIds` is uncapped and each recipient triggers serial insert/delivery/opt-in/subscription/push round-trips, so a role held by hundreds of users can overrun the dispatch interval [src/notify/dispatch.ts:85-139] - deferred, acceptable at pilot single-site scale and mitigated by the dispatch re-entrancy guard patch.
- Notification schema is duplicated across `deploy/compose/init-db.sql` and `read/projections/notification.sql` with only a "change both together" comment and no drift-guard test, unlike Story 1.9's route-surface guard [deploy/compose/init-db.sql, read/projections/notification.sql] - deferred, add a mirror-assertion test later (this file was already silently reverted once during a concurrent Story 1.10 edit).
- Task 6.1's non-blocking guarantee is tested at the function level (`emitNotification()` called directly) rather than through a real emitting HTTP handler returning 200/201 with a broken dispatcher [test/integration/story-1-11.test.ts] - deferred, tighten when a real emitting consumer (e.g. an approval-card decision) exists to wrap it.
- Value-band and vacation-delegation escalation resolution (Task 4.3) is not wired; only `findRoleHolder` is used, `findFirstActiveDoaEntry`/`findActiveDelegation` are unused [src/notify/escalate.ts] - deferred, documented scope decision in Completion Notes; no current or near-term consumer defines a value-banded or delegated escalation target.

## Deferred from: code review of 2-2-real-time-multi-location-stock-balances (2026-07-21)

- `in_transit` column never written by any code path [src/read/projections/stock_balance.ts] -- deferred, Story 2.5 will add inter-location transfers that populate this field.
- Consolidated API response merges across `stock_class` [src/api/v1/stock.ts:47-63] -- deferred, class breakdown is a future feature (Story 2.8 consignment segregation).
- Zero permitted locations returns 200 empty instead of 403 [src/api/v1/stock.ts:42-45] -- deferred, consistent with existing RBAC handler patterns in the codebase.

## Deferred from: code review of 2-3-lot-batch-and-serial-traceability (2026-07-21, adversarial pass 3)

- Expiry is compared in server-local time (`todayLocalYmd`/`localToday`) while `lot_master` availability filters on SQL `CURRENT_DATE` [src/compliance/lot-serial-validation.ts:67; src/read/projections/lot_master.ts] - deferred, pre-existing clock-source split; standardize on DB `CURRENT_DATE` in a dedicated pass.
- Serial quantity reconciliation compares a summed JS float against the event quantity (`0.1 x 3 !== 0.3`) [src/compliance/lot-serial-validation.ts:362] - deferred, serials are discrete (default quantity 1); no realistic fractional-serial case exists today. Revisit if fractional serial quantities become real.
- FEFO/FIFO selection cannot split a request across lots and rejects `NO_AVAILABLE_LOT` even when combined stock across lots would satisfy it, while an un-lotted issue drains across lots [src/compliance/lot-serial-validation.ts:137; src/api/v1/lots.ts:180] - deferred, single-lot pick matches AC1's single-lot framing; split-pick is new scope for a dedicated story.
- `override_expired_lot: true` from a non-override role is rejected `403 FUNCTION_ACCESS_DENIED` even when the lot is not expired, because the role gate fires on the flag alone in shape validation before any lot lookup [src/compliance/lot-serial-validation.ts:277] - deferred, defensible fail-closed on the override assertion; revisit (move the check into lot validation, gated on actual expiry) if a client is found sending the flag by default.

## Deferred from: code review of 2-5-inter-location-transfer-requests (2026-07-21)

- `SUPPORTED_EVENT_TYPES` registry added to `schema.ts` but never imported or enforced by `store.ts` — the four transfer event types are unvalidated dead metadata [src/events/schema.ts] - deferred, wiring event-type validation into the write path is cross-cutting enforcement work beyond this story.
- Stable error codes `APPROVAL_REQUIRED`, `QUANTITY_EXCEEDS_APPROVED`, `LOT_MISMATCH` not registered in the architecture stable-error list [planning-artifacts/architecture] - deferred, planning-artifact update.
- Approve/reject mutate `transfer_request.status` via direct `UPDATE`, and the persisted `approval_decided` event has no projection handler, so the read-model status change is a side-write not derived from the event [src/api/v1/transfer-requests.ts] - deferred, architecture-pattern decision (event-vs-amendment was already flagged as an open decision in the spec, Task 4).
- `in_transit`/`transfer_request` DDL duplicated across `read/projections/*.sql` and `deploy/compose/init-db.sql`, kept in sync only by comment, with no drift-guard test [read/projections/in_transit.sql, read/projections/transfer_request.sql, deploy/compose/init-db.sql] - deferred, mirror-assertion test is test-infra work shared with the same class already tracked for Stories 1.9/1.11.

## Deferred from: code review of 2-7-safety-stock-reorder-points-and-obsolescence-flagging (2026-07-22)

- `reorder_point` = ceil(avg_daily_demand * lead_time_days + safety_stock) is computed and stored into NUMERIC(18,6) with no upper bound, so extreme demand/lead combinations overflow as an uncaught 500 [src/compliance/planning-jobs.ts:169] - deferred, roll into the shared quantity-bound hardening pass tracked across Stories 2.4/2.6.
- Minimum sample-day guard is hardcoded (DEFAULT_MIN_SAMPLE_DAYS = 2) but Task 5 specifies a *configured* minimum [src/compliance/planning-jobs.ts:45] - deferred, needs a DDL/params-field decision before it is worth wiring.
- Demand-window anchor and obsolescence aging both use SQL now() rather than the supplied scope.business_date, so a backdated or replayed job decides against wall-clock time [src/compliance/planning-jobs.ts:146, :407] - deferred, revisit when a real scheduler replaces the Phase-1 synthetic HTTP trigger.

## Deferred from: code review of 2-9-erp-inbound-reference-projections (2026-07-22)

- No batch-size bound on the ERP sync array: runErpSync processes the whole posted array in one transaction, one savepoint per record. Low risk (trigger RBAC-restricted to svc_erp_adapter/system_administrator). src/api/v1/erp-projections.ts:162-178
- Per-record exceptions lost on late infra rollback: exceptions queued inside the batch transaction are discarded if a later COMMIT/statement fails and rolls back; self-healing on the next retry. src/adapters/erp/sync.ts:280-337
- Dropped PO lines persist as phantoms: soft-close is header-only; erp_purchase_order_line has no status column and the app role has no DELETE grant on it (deliberate - reference tables withhold DELETE). Clean fix needs a schema decision (add a line status column + migration + drift guard + read filter, or grant DELETE). A hard-DELETE patch was attempted and reverted (permission denied). src/read/projections/erp_purchase_order.ts, src/adapters/erp/sync.ts

## Deferred from: code review of story-3.2 (2026-07-23)

- `entered_at` is client-supplied with no upper bound and is the gate-event list sort key; a future-dated or bad-clock row pins to the top of every list. Pre-existing (validation not in the 9fbdcf1 diff). [src/compliance/gate.ts:69]
- Idempotent migration `ADD CONSTRAINT UNIQUE (correlation_id)` guards on constraint name only, not data; DB init aborts if any pre-existing duplicate `correlation_id` data exists. Conditional and unlikely given per-event random IDs. [deploy/compose/init-db.sql:2141-2150]
- Story 3-3 (surfaced by this review's full-suite run, pre-existing): `src/compliance/weighbridge.ts:30` has its own `localYmd` using pure local getters with no IST offset (same defect family gate just fixed), and `test/integration/story-3-3.test.ts:255` hardcodes `business_date === '2026-07-22'` (its authoring date) against an `occurred_at = now` value - the test is date-dependent and fails on any commit from 2026-07-23 onward. Fix both together in a story 3-3 follow-up: IST-correct localYmd + derive the expected date in the test.

## Deferred from: code review of story-3.4 (2026-07-23)

- RBAC helper divergence — `receiving.ts`'s role-check additionally allows `module === 'inventory'` where `asn.ts` doesn't; both independently redefine the same helper instead of sharing code. [src/api/v1/asn.ts:24, src/api/v1/receiving.ts:54] - deferred, pre-existing pattern from earlier stories, not a regression introduced here.
- Unrelated `gate_event` unique-index hotfix bundled into this story's migration file — no relation to goods receiving. [deploy/compose/init-db.sql] - deferred, pre-existing fix folded in opportunistically, functionally correct.
- `resolveSiteByToken`'s RBAC pre-check uses the latest `weighbridge_event` row regardless of status, while the compliance layer (correctly) uses the first `accepted` row — pre-check only; downstream enforcement is unaffected. [src/api/v1/receiving.ts:83-89] - deferred, low likelihood, RBAC gate is defense-in-depth not the source of truth.
- Under-receipt below the lower tolerance bound is unenforced (`under_receipt_tolerance_pct` fetched but unused). A symmetric-reject patch was attempted and reverted: with the tolerance typically unset (0%), the lower bound equals full `ordered_qty`, so per-event enforcement rejected every normal partial/multi-shipment receipt (broke 5 happy-path tests). Needs a PO-closure signal this event doesn't have. [src/compliance/receiving.ts:219-238] - deferred, needs a PO-closure-triggered discrepancy check as its own follow-up story.

## Deferred from: code review of 3-5-directed-putaway-and-location-override-recording (2026-07-25)

- DDL duplicated across `init-db.sql` and `read/projections/*.sql` (putaway_task columns, velocity_class table) -- deferred, pre-existing mirror pattern shared with prior stories; add a mirror-assertion test later. [deploy/compose/init-db.sql, read/projections/putaway_task.sql, read/projections/velocity_class.sql]
- Reslotting job upserts each SKU independently without transaction wrapping; partial state on crash auto-heals on next run since the job recomputes from scratch every invocation. [src/warehouse/reslotting-job.ts:116-127] - deferred, low severity on-demand job.
- Location facts silently skipped when putaway task has no `lot_id`; completion succeeds but lot-location projection becomes stale. Lot-less putaway is an edge case not exercised by current receiving flow (Story 3.4 always sets lot_id). [src/compliance/putaway.ts:93] - deferred, revisit if a future story introduces lot-less putaway tasks.

## Deferred from: code review of 3-6-pick-task-generation-and-execution-fr-w-04 (2026-07-27)

- Cancelling a pick line must also release its allocation, and a task whose lines are all cancelled can never complete because completion throws on `activeCount === 0`, which would permanently pin the task, its allocations and its dispatch order. The unreachable `releasePickLineAllocation` accessor was deleted as dead code during the review sweep, so whoever introduces cancellation must add both the `releaseStock` call and an all-cancelled completion path. [src/read/projections/pick_line.ts, src/compliance/pick.ts] - deferred, latent: no code path currently cancels a pick line or task.
- Pick line confirmation never gates on the parent task's status, so lines belonging to a cancelled task would still confirm and take a fresh allocation that nothing later converts to `picked` or releases. [src/compliance/pick.ts:204-232] - deferred, latent for the same reason: `pick_task.status` models `cancelled` but nothing sets it today.
- Story 3.3's weighbridge `business_date` is derived from wall-clock `now()` instead of the event's `occurred_at`, so the AC1/AC2 assertion pinned to '2026-07-22' only ever passed on the day it was written; it is the single failing test in the suite. [test/integration/story-3-3.test.ts:255, src/compliance/weighbridge.ts] - deferred, pre-existing and outside Story 3.6's diff (neither file was touched); belongs to Story 3.3 as its own fix.

## Deferred from: code review of story-3-7-packing-shipping-and-dispatch-documents (2026-07-27)

- Missing `lot_on_hold_blocked` BOOLEAN field in `DispatchDispatchedPayload` — informational field that would indicate whether dispatch was gated by a hold, not critical for Phase 1. [src/events/schema.ts:558-563]
- Missing FK constraints on `packing_record.dispatch_order_id` -> `erp_sales_order.id` and `dispatch_document.generated_by` -> `users.id` — orphan records possible, but follows pre-existing project pattern of omitting FKs on projections. [read/projections/packing_record.sql, dispatch_document.sql]

## Deferred from: code review of story-3-7-packing-shipping-and-dispatch-documents (2026-07-28)

- No site-isolation in `applyDispatchPackedProjection`/`applyDispatchShippingDocumentsGeneratedProjection`/`applyDispatchDispatchedProjection` — the edge/direct event path still bypasses site scoping (only the HTTP-layer `assertSiteAccess` checks it), so a caller at site A can pack/dispatch orders belonging to site B via edge sync. Pre-existing gap from the prior review round, not touched by this fix pass. High-impact; recommend prioritizing next round. [src/compliance/dispatch.ts]
- `renderLabels` returns an empty array when `carton_count` is 0 even though label generation was requested — pre-existing, not touched by this fix pass. [src/warehouse/document-renderer.ts:189]
- Schema-drift `EXPECTED` array in `test/unit/schema-drift.test.ts` has no entry covering `dispatch_order_status`'s new columns (`packed_at`, `packed_by`, `dispatched_at`, `dispatched_by`) added via Story 3.6's `pick_task.sql` ALTER — future drift on these columns goes undetected. Pre-existing, not touched by this fix pass. [test/unit/schema-drift.test.ts]

## Deferred from: code review of story-3-7-packing-shipping-and-dispatch-documents (2026-07-29)

- Lot-lock ordering can deadlock two concurrent orders sharing lots - both LOT_ON_HOLD queries lock candidate lots via `FOR UPDATE OF lm` with no deterministic `ORDER BY lm.lot_id`, so two transactions on different dispatch orders sharing two or more lots can lock in opposite order and deadlock. The round-2 `FOR UPDATE` race fix is otherwise correct and verified. [src/compliance/dispatch.ts:190-201, 295-305] - deferred, pre-existing lock-ordering class shared with prior warehouse stories; add deterministic lot-id ordering when lock contention is addressed project-wide.

## Deferred from: dev-story 3-8-warehouse-task-management-and-productivity-tracking (2026-07-29)

- `test/integration/story-3-7.test.ts` never runs: its `before` hook calls `POST /api/v1/scim/Users` and `POST /api/v1/scim/Users/:id/access-tokens`, neither of which is a registered route (the real surface is `POST /api/v1/scim/v2/Users` plus `POST /api/v1/auth/dev-token`, as every other story suite uses). The hook fails with 401 UNAUTHORIZED, the suite aborts, and all 13 Story 3.7 acceptance tests report as cancelled - so Story 3.7 currently has no executing acceptance coverage at all. Story 3.8 mirrored the Story 3.6 harness instead. [test/integration/story-3-7.test.ts:59-82] - deferred, belongs to Story 3.7 (still in-progress); pre-existing at baseline cd7e3d9 and outside this story's diff.
- `.env.test` sets `DB_PORT=5432`, but the project's own test PostgreSQL container (`ims2-test-postgres`) publishes on host port 5442; 5432 is held by an unrelated container. Every integration suite therefore fails with "password authentication failed" unless `DB_PORT=5442` is exported, which is almost certainly the "4 DB auth pre-existing" failures recorded in Story 3.7's completion notes. [.env.test] - deferred, environment/config decision rather than a code defect; needs the team to confirm which port the committed default should name.

## Deferred from: code review of 3-8-warehouse-task-management-and-productivity-tracking-fr-w-07 (2026-07-29)

- Putaway tasks directed before this migration never receive a `zone_id`. The additive `zone_id` column ships with no backfill statement, and `setDirectedSuggestion` is the only writer and is predicated on `status = 'ready'`, so it runs only at direction time. Pre-existing directed tasks keep `zone_id` NULL indefinitely and fall into the null-zone bucket in both the AC1 board filter and the AC2 per-zone productivity rollup, indistinguishable from a legitimately undirected task. [read/projections/putaway_task.sql:79; src/read/projections/putaway_task.ts:263-270] - deferred, inherent to an additive migration rather than a defect in the new code; needs a backfill pass planned alongside the deployment.
- GRN headers created before this migration can never backfill `received_at`. The `ON CONFLICT (grn_id)` clause updates only `status` and `updated_at`, so a header created pre-migration keeps a NULL `received_at` even when a later line supplies the instant, permanently excluding that GRN from the gate-dwell fallback leg. [src/read/projections/grn.ts:118-124] - deferred, the immutability is explicitly mandated by Task 1.4's header-identity contract, and the paired pre-migration weighments carry an equally NULL `occurred_at`, so those vehicles sit outside dwell reporting as a whole rather than being half-reported.

## Deferred from: code review of 3-9-forward-pick-replenishment-fr-w-08 (2026-07-30)

- Concurrent checks select same reserve bin - no lock on source bin selection in `runForwardPickReplenishmentCheck`. Two concurrent checks for different (sku, zone) pairs at the same site could select the same reserve bin. If the bin's available covers each individually but not both, the second completion drives `stock_balance.available` negative or fails with `INSUFFICIENT_STOCK`, leaving an orphaned task. [src/warehouse/replenishment-job.ts:129-151] - deferred, Phase-1 limitation; FEFO/velocity ranking and bin locking are future enhancements.

## Deferred from: code review of 4-3-purchase-requisition-and-indent-loop (2026-08-02)

- Online duplicate pre-check TOCTOU - `findOpenDuplicate` runs before `persistEvent` with no locking. Concurrent request can create duplicate between pre-check and insert. [src/api/v1/indents.ts:1016-1042] - deferred, seam handles it inside transaction; pre-check is UX convenience returning 409 to user.
- No FK from indent_line to indent - `indent_line.indent_id` has no FK constraint. Orphaned lines possible if indent insert fails after lines inserted. [read/projections/indent_line.sql:117] - deferred, schema design decision; code always inserts together in same transaction.
- Missing index on indent.status for non-open statuses - Queries for `status = 'closed'`, `'rejected'`, `'cancelled'`, `'ordered'` do sequential scan. [src/read/projections/indent.ts:1595-1598] - deferred, performance issue not correctness; partial index covers open statuses only.
- Missing index on indent.requester_user_id for cross-status queries - `mine=true` query with non-open status does full scan. [src/read/projections/indent.ts:1196] - deferred, performance issue; partial index covers open statuses only.
- indent_number_seq doesn't reset per year - Single sequence, globally monotonic but year-ambiguous. `IND-2026-9999` followed by `IND-2027-10000`. [read/projections/indent.sql:88] - deferred, cosmetic; documented behavior; globally unique is sufficient.
- cancelIndentBase doesn't validate state before persisting - Persists `indent.cancelled` event without checking status. Seam validates inside transaction. [src/api/v1/indents.ts:1387-1414] - deferred, seam validation is sufficient; handler commits to event before seam rejects.
- applyIndentClosed doesn't verify purchase_order_id - Allows closing any ordered indent without checking PO is set. [src/compliance/indent.ts:850-857] - deferred, ordered status implies PO was set; no current path creates ordered without PO.
- Search pattern escaping non-standard PG setting - Escapes `%`, `_`, `\` for ILIKE but assumes `standard_conforming_strings` is on. [src/read/projections/indent.ts:1576] - deferred, non-default PostgreSQL setting; project uses defaults.
- Edge capture minimal client-side validation - Only validates SKU and quantity. Required fields rely on HTML `required` attributes. [edge/src/components/indent-capture.tsx:1942-1951] - deferred, HTML required handles it; server validates all fields.

## Deferred from: code review of 4-4-purchase-order-management (2026-08-03)

- PO write routes (approve/reject/issue/confirm/releases/ceiling) perform no site-write authorization [src/api/v1/purchase-orders.ts:349-592] - deferred, pre-existing module-wide pattern: the sibling indents.ts write routes are identically read-scoped but write-unscoped (verified), and the compliance seam still enforces SOD + DOA-resolved-approver identity. A procurement writer scoped to site A can act on a PO at site B. Resolve as a procurement-module RBAC decision (add a site-write scope check to both indents and purchase-orders), not a 4.4-only fix.
- Supplier onboarding auto-approval emits supplier.onboarding_submitted and supplier.onboarding_approved in two separate persistEvent transactions with unrelated correlation ids [src/api/v1/suppliers.ts:237-284] - deferred, belongs to the Story 4.1 supplier scope (inherited into this working tree, disclosed in Dev Agent Record). A failure after the first commit strands the supplier submitted-but-not-approved.
- Concurrent same-po_id purchase_order.drafted persists a phantom domain event [src/compliance/purchase-order.ts:360-365] - deferred, matches the accepted indent precedent: on a 23505 insert race the loser catches and returns while the outer domain_events insert still writes a drafted event with no projection applied. Reachable only via crafted direct /api/v1/events with an identical po_id.
- Multiple POs draftable from a single approved indent; only the first is ever issuable [src/compliance/purchase-order.ts:262] - deferred, low impact: applyPoDrafted has no guard that the source indent has no existing non-rejected PO, so a second draft succeeds but its later issue emits indent.ordered against an already-ordered indent (requires status approved) and is rejected, leaving a permanently un-issuable approved PO.

## Deferred from: code review of 4-7-supplier-invoice-capture (2026-08-06)

- DATE columns serialize as shifted timestamps on non-UTC servers [src/read/projections/supplier_invoice.ts:10] - deferred, pre-existing repo-wide: no pg.types.setTypeParser override exists anywhere, so node-postgres parses DATE (oid 1082) into a local-midnight JS Date and sendJson emits a shifted UTC ISO string (2026-04-01 renders as 2026-03-31T18:30:00.000Z under IST). Affects every existing DATE projection column (purchase_order.promised_delivery_date, cycle_count.business_date, etc.), not just invoice_date/statutory_due_date. Fix once globally with a type parser returning the raw string.
- Supplier-invoice write routes (capture/duplicate-override/link-po/stage/confirm) perform no site-write authorization [src/api/v1/supplier-invoices.ts:495-537] - deferred, same pre-existing module-wide pattern as the purchase-orders and indents entries above; a site-A procurement writer can capture against a site-B PO. Resolve as one procurement-module RBAC decision covering indents, purchase-orders, and supplier-invoices together.

## Deferred from: code review of 4-6-msme-compliance-tracking (2026-08-06, Group 1)

- CHECK vocabulary widening never propagates to existing databases [read/projections/supplier.sql:117] - deferred, pre-existing guarded-migration pattern repo-wide: the IF NOT EXISTS constraint guard skips re-adding a CHECK whose body needs to widen (e.g. a future MSME re-classification value), so existing DBs keep the old vocabulary until a manual or differently-named migration lands. Same shape as every guarded additive migration since Story 3.10.
- Concurrent db:migrate runs can abort on TOCTOU inside guarded DO blocks [src/events/migrate.ts:73] - deferred, pre-existing repo-wide pattern: two runners can both observe a constraint missing and both attempt ADD CONSTRAINT; the second raises 42710 and the unguarded DO block aborts mid-migration. No advisory lock around the migration runner anywhere in the repo.
- init-db.sql runs outside any transaction [deploy/compose/init-db.sql] - deferred, pre-existing file-wide pattern: an interrupted container first boot (OOM, eviction) leaves a partially-applied schema; the db:migrate upgrade path heals it via IF NOT EXISTS guards, but init-db itself is not re-runnable in an automated way on partial failure.

## Deferred from: code review of 4-6-msme-compliance-tracking (2026-08-06, Group 3)

- MSME ageing report has no pagination or row limit [src/read/projections/msme_ageing.ts:39] - deferred, pre-existing repo-wide pattern: every Phase 1 list endpoint (listSuppliers, listPurchaseOrders, listIndents) is similarly unbounded; response size and query time grow with MSME invoice volume. Resolve as one repo-wide pagination decision, not a 4.6-only fix.

## Deferred from: dev-story 4-5-goods-receipt-and-three-way-match (2026-08-06)

- Three-way-match write routes (link-po, match run, credit/debit note, clearance-feed run) perform no site-write authorization [src/api/v1/three-way-match.ts:98] - deferred, same pre-existing module-wide pattern as the indents, purchase-orders, and supplier-invoices entries above; a site-A procurement writer can bind or match a site-B document. Read routes ARE site-scoped. Resolve as the one procurement-module RBAC decision already tracked for the sibling routes.
- Receipts are aggregated at SKU grain, so a PO repeating one SKU across lines cannot attribute them [src/read/projections/three_way_match.ts:171] - deferred by design, fails closed: those lines are marked `ambiguous_sku` and the match blocks rather than double-counting. A real fix needs a per-line receipt attribution key, which Story 3.4's grn_line does not carry (its line_no is the receiving document's, not the PO's).
- The match compares against the PO's CURRENT line set, not a snapshot taken at match time [src/compliance/three-way-match.ts:236] - deferred, no PO line amendment path exists in Phase 1 (Story 4.4 excluded revision), so the line set is immutable in practice. Revisit if a purchase_order.line_amended event is ever added: an old match's variance_detail would then describe lines that no longer exist.
- Payment clearance has no partial or per-invoice release [src/read/projections/three_way_match.ts:361] - deferred, matches the msme_ageing_feed precedent: every run regenerates the FULL eligible set as one payload, so an ERP consumer must dedupe against its own payment records. A per-invoice clearance event is a larger design question tied to real payment state, which does not exist anywhere in this system.

## Deferred from: code review of 4-5-goods-receipt-and-three-way-match (2026-08-06)

- Client-controlled `occurred_at` reaches statutory timestamps [src/compliance/three-way-match.ts:344 and 400] - deferred, pre-existing platform-wide event-sourcing convention: the direct POST /api/v1/events route re-stamps the actor from auth but never `occurred_at`, so a direct event can backdate or postdate the match run (`recorded_at`) and the lift (`lifted_at`). True for every event type in the system; fixing it for 4.5 alone would fork the convention. Resolve as one platform decision on server-stamping `occurred_at`.
- Three-way-match write routes perform no site-write authorization [src/api/v1/three-way-match.ts:459-497] - already logged above in the dev-story 4-5 entry; re-confirmed by this review (no new entry needed, tracked as the one procurement-module RBAC decision).
- Receipts aggregate at SKU grain (`ambiguous_sku` fail-closed) [src/read/projections/three_way_match.ts:171] - already logged above in the dev-story 4-5 entry; re-confirmed by this review.
- GRN-to-PO link has no `po_ref_ext` supplier correspondence check [src/compliance/three-way-match.ts:193-228] - deferred, structurally not implementable from the current schema: `erp_purchase_order` carries only `supplier_ref_ext` (the ERP's own code) and the governed supplier carries `gstin_ext` + `owner_party_code` - three namespaces with no direct mapping (same lesson as the Story 2.9 owner-party referential at `src/compliance/ownership.ts:221-226`). A defensible correspondence check needs a dedicated `erp_supplier_ref_ext <-> governed supplier` mapping table, which is a separate work item; until then the applier relies on the spec-mandated PO existence + status check only.

## Deferred from: dev-story 4-2-supplier-performance-scorecards (2026-08-06)

- Quality-acceptance metric source does not exist until Epic 8 Story 8.3 [src/compliance/supplier-scorecard.ts:178] - deferred by design (AC2): the `qc.lot_dispositioned` event name is reserved in the schema doc comment only, the applier has a deliberate no-op case for `metric_kind = 'quality_acceptance'`, no write route exists, and the API returns `{ state: 'no_data' }`. Epic 8 activates the applier and registers the event; until then the projection column stays empty by construction.
- Responsiveness holiday calendar is deployment configuration with an empty default [src/config/index.ts config.scorecard] - deferred: `SCORECARD_RESPONSIVENESS_HOLIDAYS` (comma-separated YYYY-MM-DD) must be populated per deployment with the statutory holiday list before the business-day counts reflect real calendars; no holiday data ships in code by design.
- Scorecard reads are procurement-module-wide, not site-scoped [src/read/projections/supplier_scorecard_metric.ts:14] - deferred, same pre-existing pattern as the 4.7 supplier-invoice fallback: the supplier registry carries no site_id, so `permittedLocationsForModuleScope` cannot narrow the scorecard read. Resolve when a supplier site_id lands (already tracked as the supplier site_id deferral).
- Scorecard metric write routes perform no site-write authorization [src/api/v1/supplier-scorecards.ts] - deferred, same module-wide procurement RBAC pattern already tracked for indents, purchase-orders, supplier-invoices, and three-way-match; resolve as that one decision.

## Deferred from: code review of 4-2-supplier-performance-scorecards (2026-08-06)

- A replayed direct event without caller-supplied idempotency_key/event_id creates duplicate domain_events and audit rows while the projection replay guard still pins one metric row [test/integration/story-4-2.test.ts:1116-1135] - deferred, pre-existing platform-wide convention: AD-16 idempotency keys are caller-carried on every direct event surface (same class as the 4.5 client-controlled occurred_at deferral). Resolve as one platform decision on caller-less direct-event dedupe, not a 4.2-only fix.
