---
baseline_commit: 1e1a81df8e20916dc5584a728e3d2ce71b295163
---

# Story 1.13: Refused and Parked Captures Are Never Lost

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a site supervisor,
I want every capture the central system refuses to stay visible on the device and to land in a central refused-captures queue,
so that no stock movement silently disappears when a tablet syncs, is reset, or changes hands.

## Acceptance Criteria

1. **Given** a capture the central system permanently refuses **When** PowerSync applies its next checkpoint **Then** the capture is still listed as "Needs attention" on the device (local-only retention, AD-18), with its `error_code`.
2. **Given** the same refusal **When** the server rejects the upload **Then** a refused-capture record (event_id, envelope, actor, site, error_code, trace_id, time) is written centrally for every module, event-sourced like the Story 7.8 sync-conflict queue.
3. **Given** captures parked for another person on a shared device (Story 1.12) **When** checkpoints apply **Then** they survive and re-queue when that person signs in.
4. **Given** a supervisor for the site **When** they call the refused-captures API **Then** they can list open refusals and mark one resolved with a note (DOA-gated).
5. **Given** the edge test suite **When** it runs **Then** at least one test drives a real PowerSync service through a refuse-then-checkpoint cycle, and runbook section 2 gains the same manual check (row 2.10c).

**Priority:** PRE-PILOT BLOCKING. Blocks runbook row 2.10c, row 2.10b and the pilot rehearsal (runbook sections 3 to 7). Story 1.14 (supervisor screen) depends on the API shape defined here.

**Origin:** `sprint-change-proposal-2026-09-15.md`. On staging (2026-09-14) a capture refused with 403 `MODULE_ACCESS_DENIED` showed "Needs attention 1" at 11:21:59.758 and was gone at 11:21:59.995, right after `GET /powersync/write-checkpoint2.json`. This story remedies the Story 1.8 "visible needs attention" criterion without reopening Story 1.8.

## Tasks / Subtasks

- [x] Task 1: Local-only retention table on the edge (AC: 1, 3)
  - [x] 1.1 In `edge/src/local-db/schema.ts` add `edge_outbox_retained` with `{ localOnly: true }`: every `edge_outbox` column (`stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, local_status, server_error_code, server_error_details, created_at, updated_at`) plus `retained_reason` (text: `refused` or `parked_for_owner`) and `retained_at` (text, ISO UTC). The row `id` equals the `edge_outbox` id. Indexes: `reason: ['retained_reason']`, `stream: ['stream_id']`. Register it in `EdgeSchema`. No migration code is needed (PowerSync schemas are views; adding a table is automatic).
  - [x] 1.2 Leave the unused `sync_failures` local-only table alone (it has no payload or metadata, so it cannot re-queue). Do not delete it in this story; note it in `deferred-work.md` as removable.
  - [x] 1.3 In `edge/src/local-db/outbox.ts` add `retainOutboxRow(tx, id, reason)`: inside the caller's write transaction, `SELECT` the full `edge_outbox` row by `id`, `DELETE FROM edge_outbox_retained WHERE id = ?`, then `INSERT` the copy with `retained_reason` and `retained_at`. Delete-then-insert, not `INSERT OR REPLACE` or `ON CONFLICT` (PowerSync tables are views with INSTEAD OF triggers; upsert syntax is not supported on views). Idempotent: running it twice leaves one row.
  - [x] 1.4 Add `salvageUnheldOutboxRows(db, signedInUserId)`: one `writeTransaction` that retains every `edge_outbox` row with `local_status = 'needs_attention'` as `refused`, and every `auth_required` row whose owner (`outboxRowOwner`) is not `signedInUserId` as `parked_for_owner`, skipping ids already retained. This rescues rows still sitting in `edge_outbox` on devices that ran the old build. Rows already deleted by earlier checkpoints are gone; say so in Completion Notes.

- [x] Task 2: Connector retains before completing the queue entry (AC: 1, 3)
  - [x] 2.1 In `edge/src/sync/connector.ts` replace every settle path that leads to `transaction.complete()` without the server holding the row with a single helper `settleUnheld(db, id, status, error, reason)` that runs one `db.writeTransaction`: the existing `UPDATE edge_outbox SET local_status, server_error_code, server_error_details, updated_at WHERE id = ?`, then `retainOutboxRow(tx, id, reason)`. The paths are: (a) server permanent refusal (`classifyServerUploadFailure` returns `complete` with `needs_attention`, which includes "any other 4xx"); (b) local `STREAM_CONFLICT` parking from `hasUpstreamStreamConflict`; (c) the owner gate parking another person's row as `auth_required` with `OWNER_NOT_SIGNED_IN`. Reason is `refused` for (a) and (b), `parked_for_owner` for (c).
  - [x] 2.2 Keep unchanged: `DUPLICATE_EVENT` settles `synced` (the server holds it, nothing to retain); 401 and bare 403 still halt as `auth_required` without completing (the queue entry stays, so the row is not lost); 408, 425, 429, 5xx and network errors still throw for retry. `transaction.complete()` still runs only after the loop. The retain write must finish before `complete()` is called.
  - [x] 2.3 If the retain write throws, throw from `uploadData` (do not complete). A failed local write must become a retry, never a silent loss.
  - [x] 2.4 `hasUpstreamStreamConflict(db, eventId, streamId, createdAt)` must read `edge_outbox_retained` (`retained_reason = 'refused'`, `server_error_code = 'STREAM_CONFLICT'`), not `edge_outbox`, or the Story 7.8 parking protection disappears after the first checkpoint.

- [x] Task 3: Every reader uses the retention table, with no double counting (AC: 1, 3)
  - [x] 3.1 Source-of-truth rule, applied in `outbox.ts`: `edge_outbox` answers only for `pending_sync`, `syncing` and the signed-in user's own `auth_required` halts; `edge_outbox_retained` answers for refused and parked rows. Whenever a query reads both, exclude from the `edge_outbox` side any id present in `edge_outbox_retained` (`WHERE id NOT IN (SELECT id FROM edge_outbox_retained)`), because a row lives in both tables between the settle and the next checkpoint.
  - [x] 3.2 Update `readOutboxCounts` (failed count from retained `refused`), `readFailures` (from retained `refused`, `ORDER BY created_at DESC`, same returned shape), `readUnsettledOwners` (feeds `countUnsettled` and `readWaitingForOtherOwners`: `edge_outbox` pending, syncing and auth_required plus retained `parked_for_owner`, deduplicated by id), and `hasAuthRequired` (unchanged meaning: the signed-in user's own halted rows in `edge_outbox`).
  - [x] 3.3 Search the whole `edge/` tree for `FROM edge_outbox` and `edge_outbox` readers (`graphify query "edge_outbox readers"` first) and apply the rule to any other reader found. Nothing may rely on `synced` rows staying in `edge_outbox`: synced rows are also removed at checkpoints because no sync rule sends `edge_outbox` down.
  - [x] 3.4 In `edge/src/components/edge-client.tsx` extend the watch at about L406 so `refreshLocalState` also runs when `edge_outbox_retained` changes (second `db.watch` on `SELECT id, retained_reason, updated_at FROM edge_outbox_retained`, or one watch over both tables via `tables` option). Both watches must be torn down on stop and unmount.

- [x] Task 4: Re-queue parked rows for their owner (AC: 3)
  - [x] 4.1 Rewrite `resetAuthRequired(db, ownerUserId)` to re-queue from both sources in one `writeTransaction` per row: retained `parked_for_owner` rows owned by `ownerUserId`, and `edge_outbox` `auth_required` rows owned by `ownerUserId`. For each: `DELETE FROM edge_outbox WHERE id = ?`, `INSERT INTO edge_outbox` with `local_status = 'pending_sync'`, null error fields, new `updated_at` (payload, metadata, created_at and idempotency_key copied unchanged), then `DELETE FROM edge_outbox_retained WHERE id = ?`. Keep the Story 1.12 delete-and-insert so a fresh PUT is queued. Address rows by `id` only (PowerSync views expose no `rowid`, and an `UPDATE ... WHERE local_status = ...` through the view fails).
  - [x] 4.2 Start order in `edge-client.tsx` `start()`: bind `signedInUserId.current`, then `salvageUnheldOutboxRows(db, user_id)`, then `resetAuthRequired(db, user_id)`, then `db.connect(...)`. The sign-out blocked path that calls `resetAuthRequired` when online keeps working.
  - [x] 4.3 Retained `refused` rows are never re-queued automatically and never deleted by this story. There is no dismiss action in 1.13 (deferred to Story 1.14 or later; record in `deferred-work.md`).
  - [x] 4.4 Sign-out and session clearing must never empty `edge_outbox_retained`. The app does not call `disconnectAndClear()` today; add a comment at the PowerSync database creation site (`edge/src/local-db/database.ts`) that any future call must pass `{ clearLocal: false }`, because the default also wipes local-only tables.

- [x] Task 5: Central refused-capture record (AC: 2)
  - [x] 5.1 Projection `read/projections/edge_refused_capture.sql` (mirror into `deploy/compose/init-db.sql`, append a `MIGRATIONS` entry at the tail of `src/events/migrate.ts`, add an `EXPECTED` entry in `test/unit/schema-drift.test.ts`). Columns, see Table 2. Follow the `maintenance_sync_conflict.sql` style exactly: `CREATE TABLE IF NOT EXISTS`, one guarded `DO $$` block per constraint, `CREATE INDEX IF NOT EXISTS`, guarded grants (`app_user` INSERT, SELECT, UPDATE; `readonly_user` SELECT). Unique index `uq_edge_refused_capture_event` on `event_id`; check `chk_edge_refused_capture_status` (`open`, `resolved`); indexes on `(location_id, status, refused_at DESC)` and `(stream_type, status)`.
  - [x] 5.2 Accessors `src/read/projections/edge_refused_capture.ts`: `insertRefusedCapture`, `getRefusedCaptureById(id, client?, forUpdate?)`, `getRefusedCaptureByEventId`, `setRefusedCaptureResolved` (guarded by `status = 'open'`, returns rowCount), `listRefusedCaptures({ status, location_ids, stream_types, limit <= 500, offset })`.
  - [x] 5.3 Event types in `src/events/schema.ts` (payload interfaces plus `SUPPORTED_EVENT_TYPES` entries, `requiresBusinessStream: false`): `sync.refused_capture_recorded` and `sync.refused_capture_resolved` on stream type `sync`, `stream_id = refusal_id`. Add them to the Story 9.8 registry test. Both are central-only: the events door (`src/api/v1/events.ts` about L408, same bar as `maintenance`) and the edge door must reject the `sync` stream (`INVALID_EVENT_STREAM` or `CENTRAL_ONLY_OPERATION`, matching what those doors already return for maintenance).
  - [x] 5.4 Seam `src/compliance/edge-refused-capture.ts`, modelled on `src/compliance/maintenance-sync-conflict.ts`: `assertRefusedCaptureShape` (pure, pre-transaction: strict UUIDs, `stream_id === refusal_id`, `captured_by === metadata.actor.user_id` else 409 `REFUSED_CAPTURE_DERIVATION_MISMATCH`, envelope cap) and `applyRefusedCaptureProjection` (with `alreadyPersisted` guard; record: pre-check `event_id` giving 409 `DUPLICATE_REFUSED_CAPTURE` with `existing_refusal_id`; resolve: `FOR UPDATE` lock, 404 `REFUSED_CAPTURE_NOT_FOUND`, 409 `REFUSED_CAPTURE_ALREADY_RESOLVED`, then DOA). Wire both into `src/events/store.ts` beside the 7.8 wiring (shape assert near L824, applier near L1220, 23505 mapping for `uq_edge_refused_capture_event` near L1833, pkey mapping near L2095 and L2220).
  - [x] 5.5 Raiser `src/sync/refused-captures.ts`: `recordRefusedCapture(snapshot, error, ctx): Promise<{ refusal_id } | null>`. Persists `sync.refused_capture_recorded` via `persistEvent` with `idempotency_key: refused-capture-<event_id>`, `capture_method: 'AUTO'`, device actor from the bearer (see Binding Decision 5). On replay returns the existing `refusal_id`. Never throws: on failure `console.warn` with trace_id and return null. No notification in this story (Story 1.14 is the surface; AD-17 not triggered).
  - [x] 5.6 Hook in `src/api/v1/edge.ts`: wrap the whole composed handler, outside `requireRole`, so middleware refusals (`MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `LOCATION_ACCESS_DENIED`, `INVALID_MODULE`) are recorded too: `export const edgeEventUploadHandler = withRefusedCaptureRecord(requireRole({...})(edgeEventUploadBase))`. The wrapper takes a `structuredClone` snapshot of the body before calling the inner handler (the handler rewrites `metadata.actor` and stamps payload fields), catches the error, decides with Binding Decision 3, calls `recordRefusedCapture` after the inner transaction has rolled back, and rethrows the original error unchanged. It works with the existing Story 7.8 `withMaintenanceSyncConflict` path (that runs inside the handler and adds `details.conflict_id`); the wrapper must rethrow the error object it caught, so `details.conflict_id` still reaches the device.
  - [x] 5.7 The device-facing response is byte-for-byte unchanged: do not add `refusal_id` to the error body. Existing exact-details tests in `story-1-8`, `story-7-8` and every module's edge tests must stay green without edits.

- [x] Task 6: Refused-captures API (AC: 4)
  - [x] 6.1 Handlers in a new `src/api/v1/refused-captures.ts`, routes in `src/server.ts` (static before param): `GET /api/v1/edge/refused-captures` (query `status` = `open` default or `resolved`, `location_id`, `stream_type`, `limit` default 50 max 500, `offset`), `GET /api/v1/edge/refused-captures/:refusalId`, `POST /api/v1/edge/refused-captures/:refusalId/resolve` (body `{ note, idempotency_key }`, note required, trimmed, 1 to 1000 characters, else 400 `VALIDATION_ERROR` with the field).
  - [x] 6.2 Access per Binding Decision 6: a caller sees a row only when they hold `read` on the row's module (its `stream_type`) at the row's `location_id` (`permittedLocationsForModuleScope`; `*` wildcard location sees all, including rows with null location). List results are narrowed in SQL, not after paging. Detail on a row the caller cannot see returns 404 `REFUSED_CAPTURE_NOT_FOUND` (no existence leak; this fixes for the new surface the gap recorded for 7.8 in deferred-work #512). A caller with no read scope in any module returns 403 `MODULE_ACCESS_DENIED` on list.
  - [x] 6.3 Resolve: handler checks the row exists and is visible, and that the caller holds `write` on the row's module at its location (else 403 `FUNCTION_ACCESS_DENIED` or `LOCATION_ACCESS_DENIED`, same codes `requireRole` uses). No DOA and no already-resolved pre-check in the handler. It builds `sync.refused_capture_resolved` (`resolved_by` = caller, `note`, `resolved_at`) with `idempotencyKeyFrom(body)`, `auditCtxFor`, `replayIdOrReject(persisted, type, 'refusal_id')` and returns `{ event_id, refusal }`. The applier re-derives the DOA gate under the row lock: `resolveApprover('edge.refused_capture_resolution', 0)`; no DOA entry is 409 `APPROVAL_UNRESOLVED`; `resolved_by` not the resolved approver (or their delegate, as 7.8 does) is 403 `APPROVAL_REQUIRED`.
  - [x] 6.4 Update the route allowlist in `test/integration/story-1-9.test.ts` and the spine acceptance contract, exactly as Story 7.8 did for its three routes.

- [x] Task 7: Real PowerSync refuse-then-checkpoint test (AC: 5)
  - [x] 7.1 Add `edge/test/sync-real/refuse-then-checkpoint.test.ts`, run by a new script `edge:test:sync-real` (`node --import tsx --test test/sync-real/*.test.ts` in the edge workspace). It uses `@powersync/node` as an edge devDependency, pinned to the exact release whose `@powersync/common` dependency matches the one `@powersync/web` 1.39.0 resolves (1.57.x), so the real `EdgeSchema` and `EdgePowerSyncConnector` are used unchanged. Do not upgrade `@powersync/web` to 2.x.
  - [x] 7.2 The stack: PostgreSQL 18.4 from `deploy/compose/init-db.sql`, `journeyapps/powersync-service:1.23.0` with `sync/powersync.yaml` and `sync/sync-rules.yaml` (same entrypoint that derives `PS_TOKEN_JWK_K`), and the central API with auth mode that allows `POST /api/v1/auth/dev-token`. Add a compose profile `sync-test` (or a separate `deploy/compose/docker-compose.sync-test.yml`) rather than editing the production services.
  - [x] 7.3 The test: provision via SCIM one user whose role lacks the module of a capture, and one user who holds it; for the refused case open a Node PowerSync database on a temp file, insert one capture with `insertCaptureEvent`, connect with the real connector (inject `fetch` and the bearer if the connector reaches browser-only modules; do not fork its logic), wait until the upload returns 403 `MODULE_ACCESS_DENIED`, then wait for the checkpoint (upload queue empty and `currentStatus.lastSyncedAt` later than the refusal). Assert: (a) the `edge_outbox` row is gone (proves a checkpoint really ran), (b) the `edge_outbox_retained` row exists with `refused` and the code, (c) after closing and reopening the database file the retained row is still there, (d) `GET /api/v1/edge/refused-captures` as a site supervisor lists it. Add the accepted case: a capture by the holder reaches `domain_events` and is not retained. Add the parked case: a row owned by user B uploaded under user A is retained as `parked_for_owner`, survives the checkpoint, and after `resetAuthRequired(db, B)` under B's session reaches `domain_events`.
  - [x] 7.4 CI: new job `edge-sync-real` in `.github/workflows/ci.yml` that starts the stack, runs the script, prints `docker compose logs powersync` on failure, and tears down. Tell the user it must be added to branch protection as a required check (the agent cannot change branch protection).
  - [x] 7.5 Runbook row 2.10c already exists in `docs/migration/pilot-cutover-runbook.md`; verify its wording still matches the final API path and table name, and change only if they differ.

- [x] Task 8: Regression and quality gates (AC: all)
  - [x] 8.1 Edge unit tests: extend the fakes in `edge/test/unit/connector.test.ts` (its `execute` fake assumes `params[0]` is the status and `params[4]` the id; add a `writeTransaction` fake and route the retain SQL explicitly) and `edge/test/unit/outbox.test.ts` (`FakeDb` routes on SQL prefixes; teach it every new query). New cases: each settle path retains with the right reason; retain failure throws and does not complete; duplicate settle leaves one retained row; readers never double count a row present in both tables; `hasUpstreamStreamConflict` finds a retained conflict after the `edge_outbox` row is gone; `resetAuthRequired` re-queues from retained and removes the retained copy; salvage copies the right rows once.
  - [x] 8.2 Server integration `test/integration/story-1-13.test.ts` (real router, SCIM users, dev tokens, `seedDoa('edge.refused_capture_resolution')` with exactly one holder): a middleware refusal (`MODULE_ACCESS_DENIED`), a handler refusal (for example `LOCATION_ACCESS_DENIED` from `assertEdgePayloadSiteWriteAccess`), an applier refusal from another module, and a maintenance `STREAM_CONFLICT` each create exactly one open record and return the unchanged original response; replaying the same upload creates no second record; `DUPLICATE_EVENT`, 401, bare 403 without a permanent code, 5xx, and a body with a non-UUID `event_id` create no record; list narrowing by module and site; detail 404 for an invisible row; resolve happy path; resolve by a non-approver 403 `APPROVAL_REQUIRED`; resolve with no DOA entry 409 `APPROVAL_UNRESOLVED`; second resolve 409 `REFUSED_CAPTURE_ALREADY_RESOLVED`; sequential and race duplicates return the same code and `existing_*` details; forgery tests via `persistEvent(... as any)` for derivation mismatch and the envelope cap; the 401/403 RBAC sweep on all three routes; the events door and the edge door refuse the `sync` stream.
  - [x] 8.3 Every new error code is asserted with its exact `details` (see Table 3). None of them is device-facing, so none enters the permanent code twin sets or `edge/src/messages/en.json`; the parity test must stay 5/5 unchanged.
  - [x] 8.4 Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run test:integration` (compare with the baseline: one known failure, Story 7.3 MTTR), `npm run db:migrate` twice, schema drift, `npm run edge:typecheck`, `edge:lint`, `edge:build`, `edge:test`, `edge:test:e2e` (baseline 4/6, the two known failures unchanged), `edge:accessibility` (5/5), `edge:test:sync-real`, `git diff --check`, then `graphify update .`.
  - [x] 8.5 Runbook 2.10c PASSED 2026-09-17 in Chrome as accounts@ (finance controller, given `inventory` read and `maintenance` write at the pilot site through `provision-roles` for the check; asset `PILOT-CHECK-001` registered because the site had none): refused capture 1aeace2f (MODULE_ACCESS_DENIED) and 369c6c09 (ASSET_NOT_FOUND) both stayed under "Sync failed - needs attention" after the checkpoint and a reload, both listed by `GET /api/v1/edge/refused-captures` (refusals 8f45764d and the ASSET_NOT_FOUND row), accepted capture 84808786 landed in `domain_events` with no refusal row, PowerSync "Sync stream started" with no PSYNC_S2101, slot `powersync_1_43f7` active. Deploy half done 2026-09-17: HEAD shipped to `/opt/ims` (backup `/root/ims-backup-pre-1-13-202609170358.tgz` plus `ims-db-pre-1-13-202609170358.dump`), app and edge images rebuilt, migration run twice clean (`node dist/src/events/migrate.js` with `DB_ADMIN_PASSWORD`, see runbook 2.7), nginx restarted, `edge_refused_capture` present, `GET /api/v1/edge/refused-captures` answers 401 through nginx, edge bundle carries `edge_outbox_retained`, DOA band live (2.9a). Remaining: runbook 2.10c itself with a technician account. Originally: NOT RUN BY THE AGENT (needs the deployed box and an operator-provided technician account). Staging (operator plus developer, after deploy): runbook row 2.10c with a technician-role account the operator provides. Rebuild the edge and app images, run `db:migrate`, and restart nginx after recreating the app container (cached upstream IP).

### Review Findings

Code review 2026-09-16 (three adversarial layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor). The one decision item was deferred to Story 1.14 by the user.

- [x] [Review][Defer] A retained STREAM_CONFLICT head parks its stream on the device forever - `hasUpstreamStreamConflict` now reads `edge_outbox_retained` (correct for AD-18), but a `refused` retained row is never deleted and a central resolution is a decision record only (Binding Decision 7). Before 1.13 the head was deleted by the next checkpoint, so the park self-cleared; now every later capture on that `stream_id` parks locally without a network call, permanently. [edge/src/local-db/outbox.ts:300] - deferred 2026-09-16 by user decision: Story 1.14 already owns the dismiss action, so the clear path belongs there rather than being half-built here; record it as a reason 1.14 is pilot-blocking.
- [x] [Review][Patch] Resolve accepts a replayed idempotency key from a different refusal and answers 200 without resolving [src/api/v1/refused-captures.ts:155]
- [x] [Review][Patch] The 64 KB envelope cap counts UTF-16 units, not bytes, so a non-ASCII envelope of ~120 KB is stored whole [src/sync/refused-captures.ts:53, src/compliance/edge-refused-capture.ts:99]
- [x] [Review][Patch] Legacy `needs_attention` rows are invisible in counts and the failures list until a bootstrap succeeds (salvage runs inside the bootstrap try) [edge/src/local-db/outbox.ts:236, edge/src/components/edge-client.tsx:387]
- [x] [Review][Patch] A device upload on the server's own `sync` stream mints a refusal row only a wildcard-module caller can ever see or resolve [src/api/v1/edge.ts:955]
- [x] [Review][Patch] `offset` has no upper bound: a huge value reaches Postgres and returns 500 instead of 400 [src/api/v1/refused-captures.ts:66]
- [x] [Review][Patch] Role assignment `locationId` is TEXT and is compared without lowercasing, while stored `location_id` is lowercased [src/api/v1/refused-captures.ts:37]
- [x] [Review][Patch] `JSON.stringify(undefined).length` throws a 500 when a record payload omits `envelope` instead of setting it null [src/compliance/edge-refused-capture.ts:99]
- [x] [Review][Patch] The connector's JSON re-parse accepts a parsed non-object (`"null"`, `"123"`) and uploads it [edge/src/sync/connector.ts:503]
- [x] [Review][Patch] `REFUSED_CAPTURE_ALREADY_RESOLVED` on the lost-update path emits null `resolved_by`/`resolved_at`, violating Table 3 [src/compliance/edge-refused-capture.ts:216]
- [x] [Review][Patch] The sync-real test imports `pg`, which is declared only in the root package.json (works by hoisting alone) [edge/package.json]
- [x] [Review][Patch] Add the missing test for `LOCATION_ACCESS_DENIED` on resolve [test/integration/story-1-13.test.ts]
- [x] [Review][Patch] Add a regression test that the UNION watch fires on `edge_outbox_retained` (verified working by probe; Task 3.4 deviates from the spec's two-watch shape) [edge/test/sync-real/refuse-then-checkpoint.test.ts]
- [x] [Review][Defer] `edge_outbox_retained` is unbounded with no dismiss path - deferred, already recorded for Story 1.14
- [x] [Review][Defer] A crud entry whose `edge_outbox` row vanished mid-flight retains nothing and still completes - deferred, unreachable today (a checkpoint cannot run while the queue is non-empty; the only local delete is `resetAuthRequired`'s delete-and-insert inside one transaction)
- [x] [Review][Defer] `recordRefusedCapture` swallows every failure with no metric or dead-letter - deferred, never-throw is Binding Decision 3; the missing signal is the gap
- [x] [Review][Defer] No per-device rate limit on refusal records (a loop of distinct event_ids with 64 KB envelopes writes unbounded rows) - deferred, same exposure shape as the Story 7.8 raise
- [x] [Review][Defer] A refusal with no site stamps `metadata.actor.location_id` as the nil UUID while the payload keeps null (Binding Decision 5 and 10) - deferred, undisclosed deviation, document it
- [x] [Review][Defer] The `disconnectAndClear({ clearLocal: false })` rule is a comment with no lint rule, wrapper or test - deferred, pre-existing shape

Dismissed as noise or by-spec (8): a non-UUID `event_id` is not recorded centrally (Binding Decision 3 requires it); `CENTRAL_ONLY_OPERATION` halts the outbox (false - it is in both permanent-code sets, `src/sync/upload.ts:198`); an over-cap envelope is nulled rather than truncated (Binding Decision 4); the audit row carries the refusal's HTTP status (deliberate); `alreadyPersisted` matches a blank idempotency key (Story 7.8 pattern, unreachable here); Table 2 extended with `created_at`/`updated_at` (Story 7.8 template, mirrored and drift-tested); `listRefusedCaptures` parameter names differ from Task 5.2 (deliberate, disclosed); the UNION watch is untested (disproven by probe - both tables fire).

## Dev Notes

### What is broken, in one paragraph

`edge_outbox` is a synced PowerSync table so that inserts create PUT ops in the upload queue (`ps_crud`). PowerSync does not apply a new checkpoint while the queue has entries. Once the queue drains, the checkpoint rebuilds every synced table from what the server's buckets hold. No bucket in `sync/sync-rules.yaml` outputs `edge_outbox`, so every `edge_outbox` row whose queue entry is complete is deleted locally at the next checkpoint. For accepted captures that is harmless (the event is in `domain_events`). For refused captures (`needs_attention`, entry completed) and captures parked for another owner (`auth_required` with `OWNER_NOT_SIGNED_IN`, entry completed) it is data loss. Rows still in the queue (pending, syncing, and the signed-in user's own 401 halts) are safe. PowerSync's own docs confirm the model: "If the local change was discarded by the server, the server state will not change, and the client will revert to the last known state" ([Handling Write / Validation Errors](https://docs.powersync.com/handling-writes/handling-write-validation-errors)), and their demo connector says "save the failing records elsewhere instead of discarding" ([SupabaseConnector.ts](https://github.com/powersync-ja/powersync-js/blob/main/demos/react-supabase-todolist/src/library/powersync/SupabaseConnector.ts)).

### Binding decisions

1. **Keep the queue, add retention (AD-18).** `edge_outbox` stays synced and stays the only upload path. Do not make it local-only, do not build a custom scheduler, do not change retry, backoff or Story 7.8 stream ordering. Local-only writes never enter `ps_crud` and are never touched by checkpoints, and one `writeTransaction` can write both kinds of table.
2. **Retention is written before `complete()`, in the same write transaction as the status update.** A checkpoint can apply immediately after `complete()`. If the retain write fails, throw (retry) instead of completing.
3. **What the server records.** Record a refusal centrally iff all hold: the request is authenticated (an `authContext` exists); the snapshot's `event_id` is a UUID; and the server classifier `classifyUploadFailure(error)` in `src/sync/upload.ts` returns `action: 'complete'` with `localStatus: 'needs_attention'`. That mirrors the device exactly: permanent-set codes (at any status, including 403 `MODULE_ACCESS_DENIED`) and any other 4xx. It excludes `DUPLICATE_EVENT` (synced), 401 and 403 without a permanent code (halt), and 5xx or non-`AppError` (retry). Refusals that fail these conditions are not recorded centrally; the device still retains them locally.
4. **Snapshot the envelope before the handler mutates it.** `structuredClone(body)` at wrapper entry. If the serialized snapshot exceeds 64 KB, store `envelope = null` and `envelope_truncated = true`, keeping the top-level identifying fields in their own columns (same cap as Story 7.8).
5. **Identity and site come from the server, not the body.** `captured_by` is `authContext.userId`. `captured_role` is the authorized assignment role when `requireRole` got that far (`getAuthorizedAssignment(req)`), else null. `location_id` is the authorized assignment location when set, else the client-declared `metadata.actor.location_id` if it is a UUID, else null; store which one in `location_source` (`authorized`, `declared`, `none`). The record event's `metadata.actor` is `{ user_id: captured_by, role: captured_role ?? 'unassigned', location_id }` so the seam derivation check (`captured_by === actor.user_id`) holds.
6. **Who counts as "a supervisor for the site".** There is no generic supervisor role, RBAC scopes are only `read` and `write`, and the lint rule `doa/no-hardcoded-role-in-workflow` forbids comparing role names. So: seeing a refusal needs `read` on its module at its site; resolving needs `write` on its module at its site plus being the DOA-resolved approver for `edge.refused_capture_resolution` (value 0), checked in the applier under the row lock (AD-3, Story 7.8 Binding Decision 6). Known limitation, same as 7.8: `resolveApprover` has no site dimension, so one company-wide approver (or delegate) resolves. Fine for the single-site pilot; record it in `deferred-work.md`.
7. **Resolution is a decision record only.** Resolving never replays, re-queues or deletes the device copy. The device keeps its retained `refused` row.
8. **The device contract does not change.** Same status codes, same bodies, same `details` (including 7.8's `conflict_id`). No new device-facing error codes, so the permanent twin sets and `en.json` are untouched.
9. **Maintenance refusals get both records.** The Story 7.8 `maintenance_sync_conflict` raise stays as it is (it drives the maintenance workflow and notification). The generic record is also written, so the refused-captures list is complete for every module.
10. **No sync rule change.** Record events carry the refusal site in `metadata.actor.location_id`, so the `edge_site_events` bucket will replicate them to devices at that site (into `ps_untyped`, since the client schema declares no `domain_events` table). Story 7.8 raises already do this. Accept it for the pilot and record it in `deferred-work.md` (exposure and device storage growth) instead of editing `sync/sync-rules.yaml` in this story.

### Current state of the files this story changes

Table 1 lists each file this story updates, what it does today, and what must be preserved.

Table 1: Files updated by Story 1.13

| File | Today | Change | Preserve |
| --- | --- | --- | --- |
| `edge/src/local-db/schema.ts` | `edge_outbox` synced (L3-20); local-only caches; `sync_failures` unused (L41); `EdgeSchema` L192-205; `EdgeLocalStatus` L207 | add `edge_outbox_retained` | all existing tables and names (sync rules match names) |
| `edge/src/local-db/outbox.ts` | `insertCaptureEvent` L42, `readOutboxCounts` L71, `hasAuthRequired` L88, `outboxRowOwner` L110, `resetAuthRequired` L152, `readUnsettledOwners` L188, `countUnsettled` L201, `readWaitingForOtherOwners` L210, `hasUpstreamStreamConflict` L236, `readFailures` L256 | retain, salvage, readers per rule 3.1 | returned shapes; id-only addressing; delete-and-insert re-queue |
| `edge/src/sync/connector.ts` | `uploadData` L413-495: `getNextCrudTransaction`, PUT-only, owner gate L425-440, own `auth_required` halt L442, local `STREAM_CONFLICT` L449-467, POST L474, `classifyServerUploadFailure` ~L283, `recordUploadOutcome` L342, `complete()` L494 | `settleUnheld` on the three unheld paths | classification table, halts, retries, `PERMANENT_ERROR_CODES` set (parity) |
| `edge/src/components/edge-client.tsx` | `start()` binds user, `resetAuthRequired` L385, `connect` L399, one watch L406, `refreshLocalState` L201-234 | salvage before re-queue; watch retained | sign-out gate, `waitingForOthers`, `insertOwnCapture` |
| `src/api/v1/edge.ts` | `edgeEventUploadHandler` L918 = `requireRole(...)(edgeEventUploadBase)`; base L367; actor rewrite L444; catch L716-760; `withMaintenanceSyncConflict` L769-793 | outer `withRefusedCaptureRecord` wrapper | every response, 7.8 raise, zone-warning 200 |
| `src/events/store.ts`, `src/events/schema.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `test/unit/schema-drift.test.ts` | Story 7.8 wiring is the template | new stream `sync`, two event types, one projection | migrate tail order tests (append after the current tail) |
| `src/api/v1/events.ts` | bars central-only streams at about L408 | add `sync` | existing bars |
| `src/server.ts` | 7.8 routes at about L995-997; edge upload L1345 | three routes | order: static before param |

### Central record columns

Table 2 defines the `edge_refused_capture` projection. Story 1.14 builds its screen on these columns, so keep the names.

Table 2: `edge_refused_capture` columns

| Column | Type | Notes |
| --- | --- | --- |
| `refusal_id` | uuid PK | `stream_id` of the record events |
| `event_id` | uuid not null, unique | the refused capture's `event_id` |
| `stream_type` | text not null | the capture's module |
| `stream_id` | text null | as sent |
| `event_type` | text null | capture type |
| `idempotency_key` | text null | as sent |
| `device_id` | text null | `metadata.device_id` as sent |
| `captured_by` | uuid not null | bearer user |
| `captured_role` | text null | authorized assignment role |
| `location_id` | uuid null | site, per Binding Decision 5 |
| `location_source` | text not null | `authorized`, `declared`, `none` |
| `http_status` | integer not null | status returned to the device |
| `error_code` | text not null | as returned |
| `error_details` | jsonb null | as returned |
| `envelope` | jsonb null | snapshot, null when over 64 KB |
| `envelope_truncated` | boolean not null default false | |
| `trace_id` | text not null | request trace id |
| `occurred_at` | timestamptz null | `metadata.occurred_at` if valid |
| `refused_at` | timestamptz not null | server time |
| `status` | text not null | `open`, `resolved` |
| `resolved_by` | uuid null | |
| `resolved_at` | timestamptz null | |
| `resolution_note` | text null | 1 to 1000 characters |

### Error code contract

Table 3 lists the new codes. All are central-only.

Table 3: New error codes

| Code | HTTP | `details` |
| --- | --- | --- |
| `REFUSED_CAPTURE_NOT_FOUND` | 404 | `{ refusal_id }` |
| `REFUSED_CAPTURE_ALREADY_RESOLVED` | 409 | `{ refusal_id, resolved_by, resolved_at }` |
| `DUPLICATE_REFUSED_CAPTURE` | 409 | `{ event_id, existing_refusal_id }` |
| `REFUSED_CAPTURE_DERIVATION_MISMATCH` | 409 | `{ field, expected, actual }` |

Reused codes: `APPROVAL_REQUIRED` 403, `APPROVAL_UNRESOLVED` 409, `VALIDATION_ERROR` 400, `MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `LOCATION_ACCESS_DENIED` 403. Match the exact `details` shapes Story 7.8 uses for the reused DOA codes.

### Architecture compliance

- AD-18 is the governing rule; read it in `ARCHITECTURE-SPINE.md` before starting.
- AD-1 and NFR-P-04: the degraded state must stay visible on the device.
- AD-3 and FR-DOA-01: one DOA registry through `resolveApprover` (`src/api/v1/indents.ts:66`).
- AD-12: gates live in the applier under the lock; handlers pre-check only immutable facts.
- AD-14: the list reads the projection, never `domain_events`.
- AD-16: the record is keyed on the capture `event_id`; replays mint nothing.
- AD-17: no notification in this story.
- Error envelope `{ error_code, message, details, trace_id }`; REST under `/api/v1/`; UUIDs compared lowercased; timestamps UTC.

### Library and framework requirements

- `@powersync/web` stays at 1.39.0 (installed `@powersync/common` 1.57.2). Web 2.x has breaking changes (constructor options, default HTTP transport, `CrudEntry` interface); not in scope.
- `@powersync/node` is the only new dependency (edge devDependency, exact pin matching common 1.57.x). It needs native `better-sqlite3` prebuilds; the CI runner is Linux, which has them.
- PowerSync service stays at 1.23.0. `requestCheckpoint()` needs 1.24.0, so the test waits on status instead.
- Node 24 ESM TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (omit optional properties rather than setting `undefined`).
- Edge unit tests use `node --import tsx --test`, no Vitest, no DOM.

### Previous story intelligence (1.12, 1.8, 7.8)

- Story 1.12 decision 1: rows upload only under their owner's session; `resetAuthRequired` re-queues by delete-and-insert after bootstrap confirms the user. AC3 here is the check that moved out of Story 1.12 Task 6.6.
- Story 1.12: the server pins `actor.user_id` from the bearer (`edge.ts` about L444); 403 `MODULE_ACCESS_DENIED`, `FUNCTION_ACCESS_DENIED`, `EDGE_NO_CONCRETE_SITE` are authorization refusals, not login problems (`8d5ad96` made `MODULE_ACCESS_DENIED` permanent).
- Story 1.12: PowerSync views expose no `rowid`; the `worklist.ts` `ORDER BY rowid` bug broke every edge start from 2026-08-28. Select ids, then act by id.
- Story 1.8 review already flagged "`edge_outbox` is not local-only" in July; the root cause was known but hidden because sync never worked end to end until `f2d43df`, `9d1b346` and `8d5ad96`.
- Story 1.8 note: mocked connector tests do not prove sync. That is why AC5 needs a real service.
- Story 7.8: sequential and race duplicates must return the same code and `existing_*` details; key projection rows on a deterministic grain; the raise must never mask the original error; payload cap 64 KB.
- Staging facts: PowerSync 1.23 reads keys only from `client_auth.jwks` (HS256 `oct` with `kid`), replication from `replication.connections`, and the publication must be named `powersync`. Unknown blocks are silently ignored.

### Git intelligence

Recent commits on `story/1-12-edge-sign-in`: `52df020` (Story 1.12 sign-in, owner gate, `resetAuthRequired`, `countUnsettled`), `f2d43df` (PowerSync `client_auth`), `9d1b346` (publication `powersync`, `replication.connections`), `8d5ad96` (`MODULE_ACCESS_DENIED` permanent, twin sets and `en.json`), `1e1a81d` (change proposal, AD-18, runbook 2.10c). Build this story on that branch or on a branch cut from it; it depends on all five.

### Testing standards

- Write a failing test first for each AC.
- Every error code asserted with its exact `details`.
- Every new route gets the 401/403 RBAC sweep.
- Forgery tests call `persistEvent(... as any)` directly.
- Seed exactly one DOA holder (`findRoleHolder` picks the oldest holder).
- Fixed anchor dates.
- Test DB: `ims-postgres-test` (postgres 18.4, port 5442), `.env.test`, `--test-concurrency=1`.
- Line endings: `autocrlf` can make drift and Prettier look red; check `init-db.sql` is LF before chasing a drift failure.

### Out of scope

- The supervisor screen (Story 1.14).
- Dismissing or clearing retained `refused` rows on the device.
- Site-dimensioned DOA.
- Notifications for refusals.
- Excluding record events from the site bucket.
- Upgrading PowerSync web or service.
- The offline-start `db.connect` gap deferred from Story 1.12.

### Project Structure Notes

- New edge files: none outside `edge/src/local-db`, `edge/src/sync`, `edge/test/unit`, `edge/test/sync-real`.
- New central files follow the Story 7.8 layout: `read/projections/*.sql`, `src/read/projections/*.ts`, `src/compliance/*.ts`, `src/sync/*.ts`, `src/api/v1/*.ts`, `test/integration/story-1-13.test.ts`.
- `_bmad-output/project-context.md` is an empty template; the rules above come from Stories 1.8, 1.12 and 7.8.

### References

- `_bmad-output/planning-artifacts/epics.md` Story 1.13, Story 1.14, Story 1.8, Story 7.8
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-09-15.md`
- `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-1, AD-3, AD-12, AD-14, AD-16, AD-17, AD-18
- `_bmad-output/implementation-artifacts/1-12-edge-ui-sign-in-through-keycloak-pkce.md` (review decision 1, Task 6.6 scope note)
- `_bmad-output/implementation-artifacts/1-8-offline-edge-pwa-shell-and-powersync-sync-layer.md`
- `_bmad-output/implementation-artifacts/7-8-offline-technician-workflow-and-closure-codes.md` (Binding Decisions 3 to 6)
- `_bmad-output/implementation-artifacts/deferred-work.md` #490, #494, #501, #507, #512
- `docs/migration/pilot-cutover-runbook.md` row 2.10c
- [PowerSync local-only usage](https://docs.powersync.com/client-sdks/advanced/local-only-usage), [PowerSync consistency](https://docs.powersync.com/architecture/consistency), [PowerSync Node.js SDK](https://docs.powersync.com/client-sdks/reference/node)

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), dev-story workflow, 2026-09-16.

### Debug Log References

- `RangeError: Value is too large to be represented as a JavaScript number: 9223372036854775807` in `SqliteBucketStorage.updateLocalTarget`: the `@powersync/node` `node:sqlite` driver cannot read the INT64 sentinel the sync bookkeeping writes, so no write checkpoint ever completed. The real-sync test uses the SDK's default `better-sqlite3` driver instead.
- `INVALID_EVENT_ENVELOPE` on every accepted capture in the first real-sync run: see Completion Notes, connector JSON columns.

### Completion Notes List

- Tasks 1 to 4 (edge): `edge_outbox_retained` is a local-only mirror of every `edge_outbox` column plus `retained_reason` and `retained_at`. `retainOutboxRow` copies the row with one `INSERT ... SELECT` after a guarded delete (the guard requires the source row to still exist, so a repeat can never drop the only copy left after a checkpoint). The connector's three unheld settle paths (permanent server refusal, local `STREAM_CONFLICT` parking, the owner gate) go through `settleUnheld`, which writes the status update and the retention copy in ONE `writeTransaction` before `transaction.complete()`; a failed retain throws, so the upload retries instead of completing. `DUPLICATE_EVENT`, 401/403 halts and every retryable outcome are unchanged and retain nothing. Every reader follows the source-of-truth rule (`edge_outbox` excludes ids present in the retention table), `hasUpstreamStreamConflict` reads the retention table, `resetAuthRequired` re-queues from both sources and removes the retained copy, and `salvageUnheldOutboxRows` runs at start for rows an older build left behind (rows earlier checkpoints already deleted are gone and cannot be recovered).
- Task 5 and 6 (central): the `edge_refused_capture` projection, its accessors, the compliance seam (shape assert with actor-derivation checks, record and resolve appliers, 23505 resolver) and the `sync` stream's two event types are wired into `persistEvent` beside the Story 7.8 wiring. `withRefusedCaptureRecord` wraps the whole upload route OUTSIDE `requireRole`, so middleware refusals are recorded too; it snapshots the body with `structuredClone` before the handler rewrites it, decides with the server classifier (`classifyUploadFailure`, the twin of the device's), records after the inner transaction has rolled back, and rethrows the ORIGINAL error object, so Story 7.8's `details.conflict_id` still reaches the device and no response changed. Both event doors refuse the `sync` stream.
- Task 6 access model: the three routes are NOT wrapped in `requireRole` with a static module, because a refusal belongs to the module of the refused capture. Visibility is decided per row from the caller's assignments, narrowed in SQL before paging; an invisible row answers 404, and resolution needs write on that module at that site plus the DOA approver re-derived in the applier under the row lock.
- Task 7 (real PowerSync) found two defects no mocked test could: (1) the connector POSTed `payload` and `metadata` as JSON STRINGS, because they are TEXT columns and `op.opData` carries them verbatim, so the server answered `INVALID_EVENT_ENVELOPE` for EVERY capture and no edge capture had ever been accepted through real sync; the connector now parses both (a string that does not parse is sent as-is, so it is refused permanently and retained rather than retried forever). (2) The `node:sqlite` driver of `@powersync/node` breaks the sync bookkeeping (see Debug Log), so the test uses `better-sqlite3`. The three real-sync cases (refused, accepted, parked) pass against PostgreSQL 18.4 and `journeyapps/powersync-service:1.23.0`.
- Wait criterion in the real-sync test: `currentStatus.lastSyncedAt` has one-second resolution and does not advance on a checkpoint carrying no data, so the test waits for the checkpoint's EFFECT (upload queue empty and the synced `edge_outbox` row deleted), which is exactly the loss this story remedies.
- Deferred (recorded in `deferred-work.md`): the unused `sync_failures` table, no dismiss action for retained refusals, site-blind DOA resolution, record events replicating to devices at the site, and adding `edge-sync-real` to branch protection.
- Not run by the agent: Task 8.5, the staging check (runbook row 2.10c), which needs the deployed box and an operator-provided technician account.

### File List

- `.github/workflows/ci.yml`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `deploy/compose/docker-compose.sync-test.yml` (new)
- `deploy/compose/init-db.sql`
- `edge/package.json`
- `edge/src/components/edge-client.tsx`
- `edge/src/local-db/database.ts`
- `edge/src/local-db/outbox.ts`
- `edge/src/local-db/schema.ts`
- `edge/src/sync/connector.ts`
- `edge/test/sync-real/refuse-then-checkpoint.test.ts` (new)
- `edge/test/unit/connector.test.ts`
- `edge/test/unit/outbox.test.ts`
- `edge/test/unit/sqlite-db.ts` (new)
- `package-lock.json`
- `package.json`
- `read/projections/edge_refused_capture.sql` (new)
- `src/api/v1/edge.ts`
- `src/api/v1/events.ts`
- `src/api/v1/refused-captures.ts` (new)
- `src/compliance/edge-refused-capture.ts` (new)
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/read/projections/edge_refused_capture.ts` (new)
- `src/server.ts`
- `src/sync/refused-captures.ts` (new)
- `test/integration/story-1-13.test.ts` (new)
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`

Second code review 2026-09-17 (`/code-review`, eight finders). Two pilot-blocking patches applied; the rest recorded in `deferred-work.md`.

- [x] [Review][Patch] No DOA band was provisioned for `edge.refused_capture_resolution`, so every resolve on staging answered 409 `APPROVAL_UNRESOLVED` [deploy/provision/staging-doa-bands.sh, runbook 2.9a]
- [x] [Review][Patch] `salvageUnheldOutboxRows` ran unguarded before `db.connect`; one salvage failure skipped connect for the whole session with nothing shown [edge/src/components/edge-client.tsx:387]
- [x] [Review][Defer] Refusals raised before the route (413, 400 from the body stage) and tails parked locally behind a STREAM_CONFLICT head are retained on the device but never recorded centrally
- [x] [Review][Defer] `refused-captures.ts` re-implements the RBAC grant match from `middleware/rbac.ts` and lower-cases location ids where the original does not

## Change Log

The Change Log table lists every revision of this story.

Table 4: Change log

| Date | Change |
| --- | --- |
| 2026-09-17 | Second code review (eight finders): DOA band for `edge.refused_capture_resolution` added to the staging script and runbook 2.9a; salvage failure no longer skips `db.connect`; 2 findings and 30-odd cleanups deferred. CI postgres port fix (9b67221). |
| 2026-09-16 | Code review (3 adversarial layers): 12 patches applied - resolve replay guard, byte-accurate 64 KB cap, unretained `needs_attention` still counted and listed, no refusal row for a device write on the `sync` stream, bounded `offset`, lower-cased location grants, null-envelope guard, non-object JSON guard, lost-update details, `pg` declared in the edge workspace, and tests for `LOCATION_ACCESS_DENIED`, the replay guard, the offset bound and the UNION watch. 7 items deferred (see Review Findings). |
| 2026-09-16 | Story 1.13 implemented: local-only retention of refused and parked captures on the edge, the central `edge_refused_capture` queue with its API and DOA-gated resolution, a real PowerSync refuse-then-checkpoint test, and two defects that test exposed (connector JSON text columns, `node:sqlite` driver). |
