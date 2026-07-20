---
baseline_commit: bd9c3a14fa5798e9bddbf8ba52f5b678cbdff600
---

# Story 1.7: Calibration Lockout Enforcement

Status: done

## Story

As a QC inspector,
I want the system to automatically reject any QC result submitted against an out-of-calibration instrument with no role able to override this enforcement,
So that every persisted QC result was captured on a verified instrument and the integrity of the quality record is structurally guaranteed.

## Acceptance Criteria

1. **Given** the minimal instrument-status registry delivered by this story holds instrument `INS-0042` with calibration status `out_of_calibration` (status set via the admin endpoint `PUT /api/v1/instruments/{id}/calibration-status`)
   **When** a QC result event referencing `instrument_id: "INS-0042"` is submitted by any user (via the synthetic spine-test QC-result command - production QC result capture arrives in Epic 8 and passes through this same enforcement point)
   **Then** the write is rejected with `error_code: "CALIBRATION_LOCKOUT"` and no result is persisted

2. **Given** the submitting user holds role `qc_head` (the highest QC authority)
   **When** the same write is attempted
   **Then** it is still rejected with `CALIBRATION_LOCKOUT` - no role attribute can override the lockout

3. **Given** instrument `INS-0042` is updated to `calibrated` status via the admin status endpoint
   **When** a QC result referencing that instrument is submitted
   **Then** the write succeeds and the result is persisted normally

4. **Given** a calibration escalation request is submitted for an out-of-calibration instrument
   **When** the escalation is processed
   **Then** it routes to the calibration scheduler via the DOA registry - expediting calibration, not bypassing the lockout

## Requirements

- FR-M-13 - out-of-calibration lockout: no role can override; escalation expedites, never bypasses.
- FR-Q-04 - QC result capture references instrument asset IDs; out-of-calibration instruments are rejected by the FR-M-13 lockout.
- AD-8 - Calibration Lockout Non-Overridable.
- AD-12 - calibration lockout is part of the compliance spine and must be built before module epics depend on it.
- AD-14 - read models are shared PostgreSQL projections, not direct reads from module-owned tables.
- Spine Acceptance Contract test 4 - a QC result against an out-of-calibration instrument is rejected and `qc_head` cannot override it.

## Tasks / Subtasks

- [x] Task 1: Minimal instrument-status registry schema (AC: 1, 3)
  - [x] 1.1 Create `read/projections/instrument_calibration.sql` as the canonical migration file. It must carry its own guarded grant blocks, following `read/projections/audit_log.sql`, `read/projections/doa_registry.sql`, `read/projections/business_stream_config.sql`, and `read/projections/location.sql`, not the older split-grant pattern in `read/projections/users.sql`.
  - [x] 1.2 Define `instrument_calibration_statuses` with at least: `instrument_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `instrument_id TEXT NOT NULL UNIQUE`, `calibration_status TEXT NOT NULL`, `status_event_id UUID`, `status_event_version INTEGER`, `status_changed_by UUID NOT NULL`, `status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `reason TEXT`, and `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
  - [x] 1.3 Add a `CHECK` constraint so `calibration_status` is only `calibrated` or `out_of_calibration`. Do not add certificate, due-date, asset-master, or ISO 17025 document fields in this story. Epic 7 owns the full calibration register.
  - [x] 1.4 Add an index for lookup by `instrument_id`. Keep `instrument_id` as a text business identifier because the AC uses values like `INS-0042`; use `instrument_uuid` only for event-store `stream_id`, because `domain_events.stream_id` is UUID.
  - [x] 1.5 Mirror the complete DDL and guarded grants into `deploy/compose/init-db.sql` under a new Story 1.7 section. The canonical file and compose mirror must stay self-sufficient.
  - [x] 1.6 Register `../../read/projections/instrument_calibration.sql` in `src/events/migrate.ts` after `location.sql`.

- [x] Task 2: Projection module for calibration status (AC: 1, 3)
  - [x] 2.1 Create `src/read/projections/instrument_calibration.ts` with functions to ensure or look up an instrument row by text `instrument_id`, read current calibration status, and update status inside an optional `PoolClient` transaction.
  - [x] 2.2 The update path must accept the persisted `event_id` and `event_version` from `persistEvent`, so the projection row can point back to the status-change event that produced it.
  - [x] 2.3 Unknown instrument IDs must not be treated as calibrated. For enforcement, an unknown `instrument_id` is not verified and must block QC result persistence with `CALIBRATION_LOCKOUT`.
  - [x] 2.4 Do not introduce a full asset register or a full calibration-certificate register. Those belong to Story 7.1 and Story 7.5.

- [x] Task 3: Central write-path calibration lockout (AC: 1, 2, 3)
  - [x] 3.1 Create `src/compliance/calibration.ts` exporting `assertCalibrationLockout(envelope: EventEnvelope, deps?)`. It must be DB-free unit-testable through dependency injection, matching the test seam style in `src/compliance/business-stream.ts` and `src/compliance/location.ts`.
  - [x] 3.2 Gate the invariant to `stream_type: 'qc'` and the synthetic plus future QC result event type `qc.result_recorded`. Non-QC streams and QC events that are not result capture must return without side effects.
  - [x] 3.3 Validate that QC result payloads carry a non-empty `instrument_id`. Missing or empty `instrument_id` is a hard malformed command and should throw `AppError(400, 'INVALID_PARAMS', ...)`.
  - [x] 3.4 If the projection says the instrument is `out_of_calibration`, throw `AppError(423, 'CALIBRATION_LOCKOUT', ...)` before the domain event insert. If no projection row exists for the instrument, also throw `CALIBRATION_LOCKOUT` because the instrument is not verified.
  - [x] 3.5 If the projection says the instrument is `calibrated`, return normally and allow the event to persist.
  - [x] 3.6 Wire `assertCalibrationLockout(envelope)` into `persistEvent` in `src/events/store.ts` after `assertInventoryTagging(envelope)` and before any event-store insert. This placement is mandatory so rejected QC results do not consume an idempotency key, do not write `domain_events`, and cannot be bypassed by future internal adapters or edge sync.
  - [x] 3.7 Do not inspect or special-case `metadata.actor.role` to allow a bypass. A `qc_head`, `system_administrator`, maintenance role, or wildcard assignment must not override the lockout.

- [x] Task 4: Admin calibration-status endpoint (AC: 1, 3)
  - [x] 4.1 Create `src/api/v1/instruments.ts` or `src/api/v1/calibration.ts` with `PUT /api/v1/instruments/:id/calibration-status`.
  - [x] 4.2 Wrap the endpoint with `requireRole({ module: 'maintenance', functionScope: 'write' })`. This is synthetic Epic 1 scaffolding for the future maintenance register, not an Epic 8 QC endpoint.
  - [x] 4.3 Validate `:id` as a non-empty text business identifier. Reject empty or overly long values with `INVALID_PARAMS`. Do not require UUID format for this route.
  - [x] 4.4 Validate body `{ calibration_status, reason? }`, where `calibration_status` is only `calibrated` or `out_of_calibration`.
  - [x] 4.5 Implement the status update atomically: begin a transaction, ensure or load the instrument row to get `instrument_uuid`, persist a `maintenance` stream event such as `instrument.calibration_status_updated`, update the projection row with the persisted event ID and version, write the audit row via `persistEvent`, then commit.
  - [x] 4.6 Reuse the `actorContext`, `auditCtxFor`, and `NO_LOCATION_UUID` helper shape from `src/api/v1/doa.ts`, `src/api/v1/business-stream.ts`, and `src/api/v1/location.ts`. Duplicate the small helper if extraction would risk touching reviewed stories.

- [x] Task 5: Synthetic QC-result command (AC: 1, 2, 3)
  - [x] 5.1 Add `POST /api/v1/qc/results` as a synthetic spine-test command. It is not the full Epic 8 QC module.
  - [x] 5.2 Wrap it with `requireRole({ module: 'qc', functionScope: 'write' })`.
  - [x] 5.3 Validate body with at least `instrument_id` and a minimal result payload, for example `lot_id`, `parameter`, and `value`. Keep this endpoint intentionally thin; inspection plans, AQL sampling, dispositions, CoA, and QC holds belong to Epic 8.
  - [x] 5.4 Build an `EventEnvelope` with `stream_type: 'qc'`, `event_type: 'qc.result_recorded'`, a UUID `stream_id` for the synthetic result, and payload carrying `instrument_id` plus the minimal result fields.
  - [x] 5.5 Call `persistEvent(envelope, auditCtx)` and return the persisted event on success. If calibration lockout fires, return the standard error envelope with `error_code: 'CALIBRATION_LOCKOUT'` and do not write a result event.
  - [x] 5.6 Verify the same lockout also applies when `POST /api/v1/events` receives a direct `stream_type: 'qc'`, `event_type: 'qc.result_recorded'` envelope. The endpoint is scaffold; the invariant lives in `persistEvent`.

- [x] Task 6: Calibration escalation request (AC: 4)
  - [x] 6.1 Add `POST /api/v1/instruments/:id/calibration-escalations` as the synthetic escalation path for out-of-calibration instruments.
  - [x] 6.2 Wrap it with `requireRole({ module: 'qc', functionScope: 'write' })`, because the QC user blocked by lockout must be able to request escalation.
  - [x] 6.3 The endpoint must read the current instrument status and reject unknown or calibrated instruments with `INVALID_PARAMS` or `NOT_FOUND`, because escalation only makes sense for out-of-calibration instruments.
  - [x] 6.4 Route through the existing DOA registry by resolving transaction type `calibration.escalation` with value `0`. Reuse the projection functions from `src/read/projections/doa_registry.ts`; do not hard-code `calibration_scheduler` or any approver role in code.
  - [x] 6.5 Persist a `maintenance` stream event such as `calibration.escalation_requested` carrying `instrument_id`, requesting actor, DOA entry ID, routed approver user ID, and reason. This event expedites calibration only; it must not change `calibration_status` and must not make a blocked QC result writable.
  - [x] 6.6 Return the routed approver information in the response so the integration test can prove DOA routing occurred.

- [x] Task 7: Route registration (AC: 1, 3, 4)
  - [x] 7.1 Register `PUT /api/v1/instruments/:id/calibration-status` in `src/server.ts`.
  - [x] 7.2 Register `POST /api/v1/qc/results` in `src/server.ts`.
  - [x] 7.3 Register `POST /api/v1/instruments/:id/calibration-escalations` in `src/server.ts`.
  - [x] 7.4 Do not add full maintenance, asset, inspection-plan, certificate, or QC disposition routes in this story.

- [x] Task 8: Unit tests (AC: 1, 2, 3)
  - [x] 8.1 Create `test/unit/calibration.test.ts` using Node's built-in test runner.
  - [x] 8.2 Cover non-QC stream pass-through, QC non-result pass-through, missing `instrument_id` as `INVALID_PARAMS`, unknown instrument as `CALIBRATION_LOCKOUT`, `out_of_calibration` as `CALIBRATION_LOCKOUT`, `qc_head` role still blocked, and `calibrated` status passing.
  - [x] 8.3 Use dependency injection to avoid a database in unit tests, matching `test/unit/business-stream.test.ts` and `test/unit/location.test.ts`.

- [x] Task 9: Integration tests (AC: 1, 2, 3, 4)
  - [x] 9.1 Create `test/integration/story-1-7.test.ts` following the harness pattern in `test/integration/story-1-4.test.ts`, `story-1-5.test.ts`, and `story-1-6.test.ts`.
  - [x] 9.2 Apply migrations in test setup in this order: `domain_events.sql`, `users.sql`, `audit_log.sql`, `doa_registry.sql`, `business_stream_config.sql`, `location.sql`, and `instrument_calibration.sql`.
  - [x] 9.3 Clean up with `TRUNCATE ... CASCADE`, using the audit-trigger disable and enable escape hatch around audit tables exactly as Stories 1.4 through 1.6 do. Do not truncate seeded vocabularies unnecessarily.
  - [x] 9.4 AC1: set `INS-0042` to `out_of_calibration`, submit a synthetic QC result, assert `CALIBRATION_LOCKOUT`, and assert no `qc.result_recorded` domain event exists.
  - [x] 9.5 AC2: repeat the blocked write as a `qc_head` user and assert the same `CALIBRATION_LOCKOUT`. The assertion must prove the actor role does not affect the lockout.
  - [x] 9.6 AC3: update `INS-0042` to `calibrated`, submit a QC result, assert 201, and assert the `qc.result_recorded` event persisted normally.
  - [x] 9.7 Direct central-write regression: submit the same QC result envelope through `POST /api/v1/events` while the instrument is locked, and assert it is rejected. This proves enforcement is in `persistEvent`, not only in the synthetic QC endpoint.
  - [x] 9.8 AC4: create a DOA entry for `calibration.escalation`, provision a user holding the resolved scheduler role, submit an escalation, assert the response routes to that user, assert `calibration.escalation_requested` persisted, and assert the instrument remains locked until the status endpoint changes it.
  - [x] 9.9 RBAC: a caller without `maintenance` write cannot update calibration status; a caller without `qc` write cannot submit QC results or escalation requests.
  - [x] 9.10 Regression guard: non-QC streams and QC events other than `qc.result_recorded` continue to persist without consulting calibration status.
  - [x] 9.11 Run `npx tsc --noEmit`, `npm run lint`, `node --env-file=.env.test --import tsx --test test/unit/*.test.ts`, `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-1-7.test.ts`, and full `npm test`.

## Dev Notes

### Previous Story Intelligence

- Story 1.6 established that spine invariants belong in `src/compliance/` and are invoked from `persistEvent`, not only from HTTP handlers. Story 1.7 must follow that pattern so future Epic 8 QC capture and Story 1.8 edge sync cannot bypass calibration lockout.
- Story 1.6 review fixed a generated-event tagging issue by using a narrow internal write path for system-generated `location.disputed`. Story 1.7 escalation events are not generated by the compliance assertion itself, so they should use normal `persistEvent` with audit context from the endpoint.
- Story 1.6 added a central `event_version` ordering guard for current projections. Story 1.7 status updates are admin writes, so a simple current-status projection is enough, but the projection row should still store the status event ID and version for traceability.
- Story 1.5 and Story 1.6 both use dependency injection seams for DB-free invariant tests. `assertCalibrationLockout(envelope, deps?)` should do the same.
- Story 1.4, Story 1.5, and Story 1.6 all require canonical migration files with guarded grants plus a mirrored `deploy/compose/init-db.sql` section. Do not repeat the older `users.sql` split-grant anti-pattern.
- Story 1.4 settled the `persistEvent(envelope, auditCtx?, externalClient?)` pattern for atomic row plus event writes. Use the same transaction shape in the calibration status endpoint.
- Story 1.4 through Story 1.6 integration tests use the same local Router harness, SCIM provisioning, dev-token auth, admin migrations, audit-trigger escape hatch, and serial test command. Reuse that harness instead of inventing a new one.
- Project memory records a DATE handling constraint: if a `DATE` column is ever introduced, format local Y-M-D components, not `toISOString()`. This story can avoid DATE entirely by using `TIMESTAMPTZ` for status changes.

### Current Code to Preserve

- `src/events/store.ts` currently validates business-stream tagging before any insert, then opens a transaction and inserts into `domain_events`. Calibration lockout must run before the insert, because a blocked QC result must not be persisted.
- `src/events/store.ts` already maps unique idempotency conflicts to `DUPLICATE_EVENT` and stream version conflicts to `STREAM_CONFLICT`. Do not rewrite that transaction structure.
- `src/api/v1/events.ts` validates public event envelopes and resolves RBAC module from `stream_type`. Direct `POST /api/v1/events` with `stream_type: 'qc'` should require a QC role and still hit calibration enforcement through `persistEvent`.
- `src/middleware/rbac.ts` has module and function-scope checks only. No role name should be interpreted as a lockout bypass.
- `src/api/v1/doa.ts` exposes the DOA registry functions and shows the established actor and audit helper shape for compliance endpoints.
- `src/server.ts` is a simple route registry. Add only the three Story 1.7 routes.

### Architecture Compliance

- AD-8 is the main invariant: every QC result write must check instrument status and reject out-of-calibration or unknown instruments with `CALIBRATION_LOCKOUT`.
- AD-12 makes this a spine feature. The enforcement belongs below module code and must be acceptance-testable before Epic 8 exists.
- AD-14 means the current calibration status is a PostgreSQL projection, not a direct read from a future maintenance module table.
- The stable error code is already defined as `CALIBRATION_LOCKOUT`; do not invent `INSTRUMENT_LOCKED`, `CALIBRATION_EXPIRED`, or role-specific variants.
- The UX scenario for QC disposition says Meera cannot record measurements until all instruments are calibration-valid. This story implements the backend invariant behind that future UI.
- The access matrix explicitly marks calibration lockout override as blocked for maintenance technicians, maintenance supervisors, calibration officers, QC inspectors, and QC heads. Treat it as a design invariant, not a normal authorization decision.

### Domain Event Vocabulary

- `instrument.calibration_status_updated` - maintenance stream event emitted by the synthetic admin status endpoint. Payload should include `instrument_id`, `calibration_status`, previous status if known, reason, and actor provenance through metadata.
- `qc.result_recorded` - QC stream event emitted by the synthetic QC-result command and future Epic 8 result capture. Payload must include `instrument_id` and minimal result data.
- `calibration.escalation_requested` - maintenance stream event emitted when a blocked user requests expedited calibration. Payload should include `instrument_id`, reason, routed DOA entry, and routed approver.
- `calibration.escalation` - DOA transaction type used only for resolution. It is not an event type unless the developer chooses to use the same string deliberately; keep the distinction clear in code and tests.

### File Structure Requirements

- New canonical SQL: `read/projections/instrument_calibration.sql`.
- Mirror SQL section: `deploy/compose/init-db.sql`.
- New projection module: `src/read/projections/instrument_calibration.ts`.
- New compliance module: `src/compliance/calibration.ts`.
- New API module: `src/api/v1/instruments.ts` or `src/api/v1/calibration.ts`.
- Update migration list: `src/events/migrate.ts`.
- Update central write path: `src/events/store.ts`.
- Update route registry: `src/server.ts`.
- New unit tests: `test/unit/calibration.test.ts`.
- New integration tests: `test/integration/story-1-7.test.ts`.

### Testing Standards Summary

- Use Node's built-in test runner. Do not introduce Jest, Mocha, Supertest, or new npm dependencies.
- Integration tests require the Postgres test database and must run serially with `--test-concurrency=1`.
- Use `.env.test` for integration and migration commands.
- Required validation commands are:
  - `npx tsc --noEmit`
  - `npm run lint`
  - `node --env-file=.env.test --import tsx --test test/unit/*.test.ts`
  - `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-1-7.test.ts`
  - `npm test`
  - `git diff --check`

### Scope Boundaries

- Do not build the full asset register.
- Do not build calibration certificates, validity-date alerting, ISO 17025 document storage, or staged 30, 14, and 7 day alerts. Those belong to Story 7.5.
- Do not build inspection plans, AQL sampling, disposition decisions, CoA/CoC, NCR, CAPA, or quality holds. Those belong to Epic 8.
- Do not allow any override path, even for `qc_head`, `system_administrator`, or `maintenance_supervisor`.
- Do not use a hard-coded scheduler role. Escalation routing must use the DOA registry.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` Story 1.7]
- [Source: `_bmad-output/planning-artifacts/epics.md` Epic 7 and Epic 8 goals and hard prerequisites]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` AD-8, AD-12, AD-14, API Contract, Spine Acceptance Contract]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-07-12/EXPERIENCE.md` UJ-QC-01 calibration check]
- [Source: `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` Maintenance, calibration, and QC access matrix]
- [Source: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md` E1-10 rationale]
- [Source: `_bmad-output/implementation-artifacts/1-6-event-sourced-location-with-asserted-expected-separation.md` previous-story intelligence]
- [Source: `src/events/store.ts` central write path and transaction structure]
- [Source: `src/compliance/business-stream.ts` pre-insert invariant pattern]
- [Source: `src/compliance/location.ts` dependency-injection and stream-gating pattern]
- [Source: `src/api/v1/doa.ts` actor/audit helper shape and DOA registry use]
- [Source: `src/api/v1/location.ts` synthetic spine-test endpoint pattern]
- [Source: `test/integration/story-1-6.test.ts` current integration harness pattern]

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

- Red phase: `node --env-file=.env.test --import tsx --test test/unit/calibration.test.ts` failed before implementation with missing `src/compliance/calibration.js`, confirming the new calibration unit test was active.
- Green phase: `node --env-file=.env.test --import tsx --test test/unit/calibration.test.ts` passed 7/7 after implementing `assertCalibrationLockout`.
- Story 1.7 integration: `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-1-7.test.ts` passed 8/8 after adding the escalation edge case.
- Typecheck: `npx tsc --noEmit` passed.
- Lint: `npm run lint` passed.
- Unit suite: `node --env-file=.env.test --import tsx --test test/unit/*.test.ts` passed 28/28.
- Migration: `node --env-file=.env.test --import tsx src/events/migrate.ts` passed.
- Full regression: `npm test` passed 119/119.
- Diff check: `git diff --check` passed with Windows line-ending warnings only.

### Completion Notes List

- Added the Story 1.7 minimal instrument calibration status projection with guarded grants, a canonical migration, compose mirror, and migration registration.
- Added `src/read/projections/instrument_calibration.ts` for status lookup, row creation, and event-linked status updates inside optional transactions.
- Added `src/compliance/calibration.ts` and wired `assertCalibrationLockout` into `persistEvent` after business-stream tagging and before any domain event insert.
- Added `PUT /api/v1/instruments/:id/calibration-status`, `POST /api/v1/qc/results`, and `POST /api/v1/instruments/:id/calibration-escalations` using existing actor, audit, RBAC, DOA, and transaction patterns.
- Added unit and integration coverage for unknown, locked, calibrated, `qc_head`, direct central-write, DOA-routed escalation, RBAC, malformed payload, and non-QC or QC non-result passthrough paths.

### File List

- `deploy/compose/init-db.sql`
- `read/projections/instrument_calibration.sql`
- `src/api/v1/instruments.ts`
- `src/compliance/calibration.ts`
- `src/events/migrate.ts`
- `src/events/store.ts`
- `src/read/projections/instrument_calibration.ts`
- `src/server.ts`
- `test/integration/story-1-7.test.ts`
- `test/unit/calibration.test.ts`

## Review Findings

### decision-needed

- [x] [Review][Decision] Admin status endpoint implicitly creates an unknown instrument as `calibrated` - resolved by recording `previous_status: 'unknown'` for first-time status writes.

### patch

- [x] [Review][Patch] Escalation DOA resolution fails for `value_min: 0` bands - fixed with `findFirstActiveDoaEntry('calibration.escalation')` and an integration regression covering the exclusive-bound boundary.
- [x] [Review][Patch] Escalation read-then-persist is not transactional/locked - fixed by wrapping status read, DOA lookup, approver lookup, and event persistence in one transaction using the same client.
- [x] [Review][Patch] Location confidence constraint guards omit `conrelid` - fixed in both `deploy/compose/init-db.sql` and `read/projections/location.sql` by qualifying the constraint existence checks with `conrelid`.

### defer

- [x] [Review][Defer] `location.disputed` generated event bypasses the central `persistEvent` write path - closed as by-design because this narrow internal write was the explicit Story 1.6 review decision to prevent operator tagging rules from rejecting generated dispute events; reverting to `persistEvent` re-broke the existing Story 1.6 regression test.
- [x] [Review][Defer] Calibration lockout is a non-transactional TOCTOU read - `src/compliance/calibration.ts:32` reads status on a separate connection before the domain-event insert in `src/events/store.ts`; a status flip after the check but before insert could let a result persist. Pre-existing architectural pattern shared with tagging/location assertions; tiny admin-write window.
- [x] [Review][Defer] Duplicated DDL and redundant inline-plus-guard constraint blocks - `read/projections/instrument_calibration.sql` and `deploy/compose/init-db.sql` duplicate the same table/index/grants and define `chk_instrument_calibration_status` both inline and in a `DO $$` guard. Mirror duplication is required by the story; drift risk noted for future maintenance.

## Change Log

- 2026-07-19: Implemented Story 1.7 (Calibration Lockout Enforcement). Delivered minimal instrument calibration registry, central non-overridable QC result lockout, maintenance status endpoint, synthetic QC result endpoint, DOA-routed escalation endpoint, route registration, and full unit plus integration coverage. Validation passed: migration, `npm test` 119/119, `npx tsc --noEmit`, `npm run lint`, and `git diff --check`.
- 2026-07-19: Resolved code-review findings. Added honest first-time `previous_status: 'unknown'` provenance, DOA escalation routing that handles `value_min: 0` bands, transactional escalation persistence, scoped location confidence constraint guards, and new regression coverage. Validation passed: migration, `npm test` 121/121, `npx tsc --noEmit`, `npm run lint`, and `git diff --check`.
