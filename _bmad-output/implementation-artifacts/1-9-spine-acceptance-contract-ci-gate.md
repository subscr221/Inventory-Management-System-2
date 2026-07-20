---
baseline_commit: 34304a3b2b244e8ab3cd7184871d83227e051ca6
---

# Story 1.9: Spine Acceptance Contract CI Gate

Status: review

## Story

As a development team lead,
I want all five Spine Acceptance Contract tests to pass in CI against a deployed spine with no modules loaded,
so that the compliance spine is formally accepted as the build substrate and any future regression in the five invariants fails the pipeline before a module sprint can begin.

## Acceptance Criteria

1. **Given** a fresh deployment of the compliance spine with zero module code present
   **When** the Spine Acceptance Contract test suite runs in CI
   **Then** all five tests pass and results are published as a CI artifact:
   - **Edit Log Integrity** (FR-AC-13): every submitted event appears in the log; log is append-only; auditor-readable format verified; disable attempt is blocked
   - **DOA Registry Resolution** (FR-DOA-01): approval workflows resolve approvers from the registry; no hard-coded role path survives the check
   - **Event-Sourced Location** (INT-LOC-01): asserted and expected stored separately; discrepancy raises `location.disputed`; last-writer-wins does not occur
   - **Calibration Lockout** (FR-M-13): QC result against out-of-calibration instrument is rejected; `qc_head` role cannot override the rejection
   - **Business-Stream Tagging** (FR-AC-01): inventory movement without `business_stream` is rejected with `UNTAGGED_TRANSACTION`

2. **And** while any spine contract test is failing, every merge into a module code path is blocked by the required status check `spine-acceptance-contract` (branch protection configured in Story 1.10) - the CI assertion is the testable gate

## Tasks / Subtasks

- [x] Task 1: Create the Spine Acceptance Contract test suite (AC: 1)
  - [x] 1.1 Add `test/integration/story-1-9.test.ts` using the existing Node test runner and Router harness pattern from Stories 1.1-1.8.
  - [x] 1.2 Implement test 1 (Edit Log Integrity): submit events through the public `/api/v1/events` path, verify every transaction appears in `audit_log`, verify the log is append-only, verify auditor-readable format, verify disable attempt is blocked.
  - [x] 1.3 Implement test 2 (DOA Registry Resolution): seed a DOA registry entry, submit an approval workflow, verify approver resolution comes from the registry, verify no hard-coded role path survives.
  - [x] 1.4 Implement test 3 (Event-Sourced Location): submit `location.asserted` and `location.expected` events, verify expected location is computed, verify mismatches raise `location.disputed`, verify last-writer-wins does not occur.
  - [x] 1.5 Implement test 4 (Calibration Lockout): seed an out-of-calibration instrument record, submit a `qc.result_recorded` event referencing it, verify the write is rejected with `CALIBRATION_LOCKOUT`, verify no role can override the rejection.
  - [x] 1.6 Implement test 5 (Business-Stream Tagging): submit an inventory movement without `business_stream`, verify the write is blocked with `UNTAGGED_TRANSACTION`, verify the rejection message identifies the missing tag.

- [x] Task 2: Wire CI execution and required status check (AC: 1, 2)
  - [x] 2.1 Add a CI workflow or script entry point that runs the spine contract suite against a deployed spine with no modules loaded.
  - [x] 2.2 Publish results as a CI artifact.
  - [x] 2.3 Ensure the suite exit code and status check name `spine-acceptance-contract` are deterministic: any failing test produces a failing check that blocks merges per Story 1.10 branch protection.

- [x] Task 3: Regression and validation (AC: 1, 2)
  - [x] 3.1 Run backend validation: `npx tsc --noEmit`, `npm run lint`, `node --env-file=.env.test --import tsx --test test/unit/*.test.ts`, `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-1-9.test.ts`, `npm test`, and `git diff --check`.
  - [x] 3.2 Confirm all five acceptance criteria are covered by at least one automated test.

## Dev Notes

### Previous Story Intelligence

- Story 1.8 established the edge PWA shell, local SQLite outbox, PowerSync sync layer, WCAG 2.1 AA accessibility, and i18n foundation. Story 1.9 does not touch the edge workspace; it adds backend integration tests and CI wiring only.
- Story 1.7 added `instrument_calibration.sql`, `src/compliance/calibration.ts`, `src/api/v1/instruments.ts`, and `test/integration/story-1-7.test.ts`. The synthetic instrument-status registry and `qc.result_recorded` spine-test scaffolding are already present and must be reused for spine test 4.
- Story 1.6 established event-sourced location enforcement in the central write path. `src/compliance/location.ts` implements `assertLocationInvariant` and emits `location.disputed` events; these are the exact behaviors spine test 3 must verify.
- Story 1.5 established business-stream tagging enforcement in `persistEvent`, not the HTTP handler. `src/compliance/business-stream.ts` implements `assertInventoryTagging` and throws `UNTAGGED_TRANSACTION` with `details.missing_tag`; spine test 5 must verify this exact contract.
- Story 1.4 established the DOA registry, `resolveDoa`, and the `no-hardcoded-role-in-workflow` ESLint rule (`test/unit/no-hardcoded-role-in-workflow.test.ts`). Spine test 2 must verify registry resolution; the lint rule is part of the DOA spine contract run.
- Existing integration tests use Node's built-in test runner, the local Router harness, SCIM provisioning, local dev tokens, test-only PostgreSQL cleanup with audit-trigger escape hatches, and serial execution (`--test-concurrency=1`). Reuse this pattern.
- Project memory records that multi-file migration features must keep each migration self-sufficient with guarded grants; do not create a split-grant anti-pattern.
- Project memory records that DATE formatting must use local Y-M-D components. Story 1.9 should avoid DATE columns unless needed; use timezone-aware timestamps for event timing.

### Current Code to Preserve

- `src/events/store.ts` runs `assertInventoryTagging`, `assertCalibrationLockout`, and `assertLocationInvariant` in a specific order before insert. Story 1.9 tests must exercise the real `persistEvent` path, not bypass it.
- `src/events/store.ts` maps `uq_idempotency` violations to `AppError(409, 'DUPLICATE_EVENT', ...)`. Spine tests must not create duplicate idempotency keys that mask the behavior under test.
- `src/api/v1/events.ts` validates public envelopes, replaces `metadata.actor.user_id` and role from the authenticated request, checks RBAC by `stream_type` and location, and writes audit context. Spine tests should use the dev-token auth path (`/api/v1/auth/dev-token`) to obtain bearer tokens, matching the existing integration-test pattern.
- `src/middleware/audit-tamper-guard.ts` and `src/read/projections/audit_log.ts` implement the tamper-proof edit log. Spine test 1 must verify append-only behavior and that disable attempts are recorded as tamper attempts, not silent successes.
- `src/read/projections/doa_registry.ts` resolves approvers at runtime. Spine test 2 must verify that a workflow configured to use the registry returns the registry-resolved approver, not a hard-coded fallback.
- `src/compliance/location.ts` emits `location.disputed` events when asserted and expected locations diverge. Spine test 3 must verify the event appears in `domain_events` with the correct `stream_type`, `event_type`, and payload.
- `src/compliance/calibration.ts` rejects `qc.result_recorded` against out-of-calibration instruments with `CALIBRATION_LOCKOUT`. Spine test 4 must verify the rejection and that no role override exists in the code path.
- `src/compliance/business-stream.ts` rejects untagged inventory movements with `UNTAGGED_TRANSACTION` and includes `details.missing_tag`. Spine test 5 must verify both the error code and the structured detail.
- `events/domain_events.sql` is append-only with `uq_stream_version` and `uq_idempotency`. Spine tests must not attempt to update or delete `domain_events` rows.
- The `test/integration/story-1-*.test.ts` files are the canonical integration-test pattern. Story 1.9 must add `test/integration/story-1-9.test.ts` following the same structure.

### Architecture Compliance

- The Spine Acceptance Contract is the formal acceptance gate for the compliance spine (AD-12). No module epic story enters the sprint backlog while a spine contract test is red.
- The five spine invariants are enforced at the central write path (`persistEvent`). Story 1.9 tests must exercise the real API routes, not call internal functions directly, so the full request pipeline (validation, auth, RBAC, audit, compliance checks, event persistence) is covered.
- The central plane is the reconciliation authority. Spine tests verify central behavior only; edge sync is Story 1.8's responsibility.
- Deployment remains vendor-neutral: standard PostgreSQL, self-hosted PowerSync, Docker Compose, Node runtime, and reverse proxy. Story 1.9 does not introduce cloud-vendor-specific managed services.
- The CI pipeline and branch protection rules that enforce the `spine-acceptance-contract` status check are built in Story 1.10. Story 1.9's responsibility is the test suite, the deterministic exit code, and the status check name; it must not build CI YAML that Story 1.10 will duplicate or conflict with.

### Library and Framework Requirements

- Backend remains Node.js 24 LTS, TypeScript, ESM, PostgreSQL, `pg`, and `jose`.
- Tests use Node's built-in test runner (`node:test`) with `node:assert/strict`. Do not introduce a new test framework.
- Integration tests run serially with `--test-concurrency=1` and use `.env.test`.
- ESLint is the static-analysis layer. The `no-hardcoded-role-in-workflow` rule is part of the DOA spine contract run.
- No new runtime dependencies are required for this story. If a CI helper script is added, it must be a plain Node.js script using the existing `tsx` runner.

### File Structure Requirements

New paths:
- `test/integration/story-1-9.test.ts`

Likely update paths:
- `package.json` (if a new script is needed for spine-contract CI execution)
- `.github/workflows/ci.yml` or equivalent CI entry point (Story 1.10 owns the full pipeline; Story 1.9 must coordinate to avoid duplicate or conflicting definitions)

### Testing Requirements

- Spine tests must run against a deployed spine with zero module code loaded. The test harness must provision only the compliance spine tables: `domain_events`, `audit_log`, `audit_log_tamper_attempt_log`, `doa_registry_entries`, `doa_vacation_delegations`, `business_streams`, `transaction_tagging_rules`, `location_asserted_facts`, `location_expected_facts`, `location_current`, `instrument_calibration`, and any other tables the five invariants require.
- Each spine test must be independently runnable and produce a clear pass/fail result suitable for CI artifact publication.
- The test suite must exit with a non-zero code if any spine test fails, so the `spine-acceptance-contract` required status check blocks merges.
- Existing Stories 1.1-1.8 tests must remain green; run `npm test` after adding the new suite.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` Epic 1 goal and Story 1.9]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` Spine Acceptance Contract, AD-12, API Contract, Stack, Structural Seed]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md` FR-AC-13, FR-DOA-01, FR-M-13, FR-AC-01]
- [Source: `src/events/store.ts` central write path, compliance checks, event envelope]
- [Source: `src/compliance/business-stream.ts` FR-AC-01 enforcement, `UNTAGGED_TRANSACTION` detail shape]
- [Source: `src/compliance/calibration.ts` FR-M-13 enforcement, `CALIBRATION_LOCKOUT`]
- [Source: `src/compliance/location.ts` AD-15 enforcement, `location.disputed` emission]
- [Source: `src/read/projections/doa_registry.ts` FR-DOA-01 runtime resolution]
- [Source: `src/read/projections/audit_log.ts` FR-AC-13 append-only log and tamper guard]
- [Source: `src/api/v1/events.ts` public event route, validation, RBAC, audit context]
- [Source: `src/middleware/audit-tamper-guard.ts` tamper-proof edit log enforcement]
- [Source: `test/integration/story-1-4.test.ts` integration test pattern, SCIM provisioning, dev-token auth]
- [Source: `test/integration/story-1-7.test.ts` calibration lockout integration test pattern]
- [Source: `test/unit/no-hardcoded-role-in-workflow.test.ts` DOA static-check lint rule]
- [Source: `package.json` current backend scripts and test runner]

## Dev Agent Record

### Agent Model Used

fugu-ultra-20260615

### Debug Log References

### Completion Notes List

- Added `test/integration/story-1-9.test.ts`, the Spine Acceptance Contract suite: one test per invariant (Edit Log Integrity, DOA Registry Resolution, Event-Sourced Location, Calibration Lockout, Business-Stream Tagging), exercised through the real public API routes (`/api/v1/events`, `/api/v1/audit/log`, `/api/v1/config/audit-log-enabled`, `/api/v1/doa/entries|resolve|workflow-config`, `/api/v1/locations/:lotId[/expected]`, `/api/v1/instruments/:id/calibration-status`, `/api/v1/qc/results`) with zero module-specific routes wired, matching AC1's "zero module code present".
- Reused the Stories 1.3/1.4/1.6/1.7 pattern (Router harness, SCIM provisioning, dev-token auth, admin-pool schema load and `DISABLE TRIGGER ALL`/`TRUNCATE`/`ENABLE TRIGGER ALL` cleanup) rather than introducing a new harness.
- The DOA test's "no hard-coded role path survives" clause is proved two ways: functionally, the registry-resolved approver equals the seeded role holder (not a literal), and structurally, a `workflow-config` override attempt against the same governed transaction type is rejected with `DOA_OVERRIDE_BLOCKED` (Story 1.4's existing gate); the `no-hardcoded-role-in-workflow` ESLint rule continues to run as part of `npm run lint`.
- Added the `spine-acceptance-contract` npm script (Task 2) as the CI entry point: runs only `test/integration/story-1-9.test.ts` with a `spec` reporter to stdout and a `junit` reporter to `spine-acceptance-contract-results.xml` (gitignored, regenerated per run) as the CI artifact. Deliberately did not add `.github/workflows/*.yml` or touch branch protection - Story 1.10 owns the CI pipeline and required-status-check wiring; this story only had to make the script name, exit code, and artifact deterministic.
- Full regression: `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` 143/143 (33 unit + 110 integration, including the 6 new spine tests), `git diff --check` clean.

### File List

- `test/integration/story-1-9.test.ts`
- `package.json`
- `.gitignore`

## Change Log

- 2026-07-20: Implemented Story 1.9 (Spine Acceptance Contract CI Gate). Added the five-invariant integration suite (`test/integration/story-1-9.test.ts`) exercising the real API routes with zero module code wired, and the `spine-acceptance-contract` npm script as the deterministic CI entry point publishing a JUnit artifact. Validation passed: `npx tsc --noEmit`, `npm run lint`, `npm test` 143/143, and `git diff --check`.
