---
baseline_commit: eca5acaa5221da915f95fcf62acdc4736f521cb1
---

# Story 7.5: Calibration Register and Non-Overridable Lockout

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Context engine completion note: ultimate context engine analysis completed 2026-08-25. Comprehensive developer guide created from epics.md (Story 7.5, FR-M-12, FR-M-13, FR-Q-04, the Epic 1 / Epic 7 ownership split at line 782 and the Spine Acceptance Contract at line 842), ARCHITECTURE-SPINE.md (AD-8, AD-9, AD-14, AD-16, AD-17), the Story 1.7 calibration spine (instrument_calibration_statuses, src/compliance/calibration.ts, src/api/v1/instruments.ts, the DOA calibration.escalation route), the Stories 7.1 to 7.4 maintenance tree and a baseline code audit at eca5aca. The lockout GATE already exists and is spine-acceptance-tested; this story adds the register that FEEDS it: instrument records linked to the asset register, in-house and ISO 17025 certificates with validity dates, a staged 30/14/7 expiry scan, an expiry flip that locks the instrument, and a DOA-routed escalation register that expedites re-calibration without ever changing calibration status. -->

## Story

As a QC manager,
I want a calibration register covering in-house and ISO 17025 certificates with staged expiry alerts and a non-overridable out-of-calibration lockout,
so that no measurement is ever taken on an instrument outside its calibration validity.

## Acceptance Criteria

1. **Given** a measuring instrument in the register (FR-M-12), **When** its calibration is recorded, **Then** in-house and ISO 17025 certificates are stored with validity dates and alerts fire at 30, 14, and 7 days before expiry.
2. **Given** an instrument whose calibration has expired (FR-M-13), **When** any user attempts to use it for measurement, **Then** the system blocks the use with `error_code: "CALIBRATION_LOCKOUT"` and no role can override the lockout.
3. **Given** an out-of-calibration lockout is escalated, **When** the escalation is processed, **Then** the escalation expedites re-calibration but never bypasses the lockout.

## Tasks / Subtasks

- [x] Task 1: Database schema for the four new projections (AC: 1, 2, 3)
  - [x] 1.1 Create `read/projections/instrument_register.sql` following the exact shape of `read/projections/maintenance_spare_catalogue.sql`: canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks, `CREATE INDEX IF NOT EXISTS`, guarded `pg_roles` grants block. Case-insensitive uniqueness uses a `CREATE UNIQUE INDEX ... (lower(col))` exactly as `read/projections/asset.sql` does, never a table-level `UNIQUE` on an expression.
  - [x] 1.2 Create `read/projections/instrument_calibration_certificate.sql` with the same shape, including the partial unique index that allows at most one `active` certificate per instrument.
  - [x] 1.3 Create `read/projections/instrument_calibration_alert.sql` with the same shape.
  - [x] 1.4 Create `read/projections/instrument_calibration_escalation.sql` with the same shape, including the partial unique index that allows at most one `open` escalation per instrument.
  - [x] 1.5 Add the case-insensitive lookup index on the EXISTING `read/projections/instrument_calibration.sql` per the Status Write-Through Contract, using a guarded `DO $$` block so a re-applied file self-heals. Do not change any existing column or constraint in that file.
  - [x] 1.6 Mirror all four new files plus the `instrument_calibration.sql` change verbatim into `deploy/compose/init-db.sql`, appended in the same order. `deploy/compose/init-db.sql` is a CRLF file; normalize the appended block to CRLF so the file does not carry mixed line endings.
  - [x] 1.7 Register the four new files in the `MIGRATIONS` tail of `src/events/migrate.ts`.
  - [x] 1.8 Add all four tables plus every named constraint and index to `EXPECTED` in `test/unit/schema-drift.test.ts`, and add the new `instrument_calibration.sql` index there too.
  - [x] 1.9 Verify `npm run db:migrate` twice is idempotent.
- [x] Task 2: Event contracts (AC: 1, 2, 3)
  - [x] 2.1 Add the six payload interfaces and envelope types to `src/events/schema.ts` in a Story 7.5 block after the Story 7.4 block.
  - [x] 2.2 Register all six in `SUPPORTED_EVENT_TYPES` with `streamType: 'maintenance'` and `requiresBusinessStream: false`.
  - [x] 2.3 Confirm every event id field is a UUID, every DATE field matches `DATE_REGEX`, every TIMESTAMPTZ field carries an explicit UTC offset, and every declared derivable field is listed for cross-checking.
- [x] Task 3: Read projections and accessors (AC: 1, 2, 3)
  - [x] 3.1 Create `src/read/projections/instrument_register.ts` with insert, `getInstrumentRecordById` with `FOR UPDATE`, `getInstrumentRecordByInstrumentId` (matching on `lower(instrument_id)`), `getInstrumentRecordByAssetId`, and a paginated list.
  - [x] 3.2 Create `src/read/projections/instrument_calibration_certificate.ts` with insert, `getActiveCertificate(instrument_record_id)` with `FOR UPDATE`, `supersedeActiveCertificate`, `markCertificateExpired`, `listCertificatesByInstrument`, and `listCertificateStagesDue(business_date, stages, filters)` which returns the certificate rows whose stages are due per the Staged Alert Contract, narrowed in SQL.
  - [x] 3.3 Create `src/read/projections/instrument_calibration_alert.ts` with insert and a paginated list filterable by `instrument_record_id`, `stage_days` and `business_date`.
  - [x] 3.4 Create `src/read/projections/instrument_calibration_escalation.ts` with insert, `getEscalationById` with `FOR UPDATE`, `getOpenEscalation(instrument_record_id)` with `FOR UPDATE`, a resolve update, and a paginated list.
  - [x] 3.5 Extend `src/read/projections/instrument_calibration.ts` with `setCalibrationStatusFromRegister(input, client)` per the Status Write-Through Contract, and change `getInstrumentCalibrationStatus` to match on `lower(instrument_id) = lower($1)`. Do not change the existing exported signatures used by `src/api/v1/instruments.ts`.
  - [x] 3.6 Every accessor reads DATE and NUMERIC columns as strings out of pg and converts explicitly; no implicit `Date` coercion on calendar fields and no `slice(0, 10)` on an ISO string anywhere.
- [x] Task 4: Compliance seam (AC: 1, 2, 3)
  - [x] 4.1 Create `src/compliance/calibration-register.ts` structurally identical to `src/compliance/maintenance-spares.ts`: stream gate, pure `assertCalibrationRegisterShape(envelope)`, `applyCalibrationRegisterProjection(envelope, client)` switch, `alreadyPersisted` guard, `reject()` helper. Do NOT modify or replace `src/compliance/calibration.ts`, which is the Story 1.7 spine gate.
  - [x] 4.2 Implement the six appliers with the FIXED lock order in the Locking Contract below.
  - [x] 4.3 Every applier that changes calibration status calls `setCalibrationStatusFromRegister` and never writes `instrument_calibration_statuses` with raw SQL.
  - [x] 4.4 Wire the seam into `src/events/store.ts` alongside the 7.4 seam, and add a duplicate resolver to the 23505 mapper for each new unique index.
  - [x] 4.5 Assert the fail-closed registration rule: a newly registered instrument with no certificate is written to `instrument_calibration_statuses` at `out_of_calibration`, NOT through `ensureInstrumentCalibrationRow`, whose default is `calibrated`.
- [x] Task 5: Manual-reinstatement lockout (AC: 2)
  - [x] 5.1 In `src/api/v1/instruments.ts`, reject a `PUT /api/v1/instruments/:id/calibration-status` that sets `calibration_status: 'calibrated'` for an instrument PRESENT in `instrument_register`, with 423 `CALIBRATION_LOCKOUT` per the Non-Overridable Contract.
  - [x] 5.2 Leave the same endpoint unchanged for an instrument absent from the register, and leave `calibration_status: 'out_of_calibration'` allowed in both cases. Locking down is never a bypass.
  - [x] 5.3 Confirm `test/integration/story-1-7.test.ts` and the Spine 4 test in `test/integration/story-1-9.test.ts` pass unchanged; their synthetic instrument ids are never registered.
- [x] Task 6: Calibration job module (AC: 1, 2)
  - [x] 6.1 Create `src/maintenance/calibration-jobs.ts` following `src/maintenance/spares-jobs.ts`: POST-triggered, explicit `business_date`, scope narrowed in SQL, separate write and delivery counters.
  - [x] 6.2 Implement `runCalibrationExpiryScan(scope)` per the Staged Alert Contract and the Expiry Flip Contract, returning `alerts_raised`, `instruments_expired`, `notifications_delivered` and `notifications_dropped` as separate counters.
  - [x] 6.3 Emit the two scan notifications defined in the Notification Contract after their events commit.
- [x] Task 7: REST surface (AC: 1, 2, 3)
  - [x] 7.1 Add the ten handlers listed in the API Contract to `src/api/v1/maintenance.ts`, each wrapped in `requireRole({ module: 'maintenance', functionScope: ... })`.
  - [x] 7.2 Register all ten in `createAppRouter` in `src/server.ts`, static segments before parameter segments, and confirm no collision with the existing `/api/v1/instruments/:id/*` block.
  - [x] 7.3 Add all ten to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts`.
  - [x] 7.4 Emit the escalation notification defined in the Notification Contract after its event commits.
- [x] Task 8: Tests (AC: 1, 2, 3)
  - [x] 8.1 Create `test/integration/story-7-5.test.ts` bootstrapped exactly as `test/integration/story-7-4.test.ts`.
  - [x] 8.2 One failing-first test per acceptance criterion, plus one test per error code in the Error Code Contract.
  - [x] 8.3 A replay test per write route asserting the same resource returns and the `domain_events` count does not grow.
  - [x] 8.4 The three lockout-integrity tests named in the Testing Requirements: manual reinstatement rejected, escalation does not change status, expired instrument blocks a QC result end to end.
  - [x] 8.5 A staged-alert catch-up test: a scan skipped for several days fires every unfired stage on the next run, and a re-run on the same `business_date` fires nothing.
  - [x] 8.6 A concurrency test per new unique index asserting the race path returns the SAME error code and the same `existing_*` detail as the sequential path.
  - [x] 8.7 Provision a `calibration_scheduler` user in the harness and assert the staged alert resolves to at least one real recipient, replicating `resolveTargetUserIds` as `test/integration/story-7-4.test.ts` does.
  - [x] 8.8 Regression: Stories 1.7, 1.9, 7.1, 7.2, 7.3 and 7.4 suites pass unchanged.
- [x] Task 9: Ledger entries (AC: 1, 2, 3)
  - [x] 9.1 Log the out-of-scope items named in Binding Scope Decisions to `_bmad-output/implementation-artifacts/deferred-work.md` under a Story 7.5 heading.

## Dev Notes

### Binding Scope Decisions

- The lockout GATE already exists and is spine-acceptance-tested. `src/compliance/calibration.ts` (`assertCalibrationLockout`) is called from `src/events/store.ts:408` for every `qc.result_recorded` event and raises 423 `CALIBRATION_LOCKOUT` unless `instrument_calibration_statuses.calibration_status = 'calibrated'`. `test/integration/story-1-7.test.ts` and Spine 4 in `test/integration/story-1-9.test.ts` assert it. This story does NOT rewrite that gate, does NOT move the status table, and does NOT introduce a second lockout check. It builds the register that FEEDS the status table. Rewriting the gate would put the Spine Acceptance Contract at risk for zero AC gain.
- The Story 1.7 admin endpoints stay. `PUT /api/v1/instruments/:id/calibration-status` and `POST /api/v1/instruments/:id/calibration-escalations` are load-bearing for two spine tests. Deleting or relocating either fails the Spine Acceptance Contract. The epics line 782 wording ("replaces the admin endpoint as the production status source") is satisfied by making the register the authoritative WRITER of status for registered instruments, not by removing the endpoint.
- Manual reinstatement of a REGISTERED instrument is the role override AD-8 forbids, and closing it is the whole point of AC 2. Once an instrument is in `instrument_register`, only a recorded certificate can return it to `calibrated`; the admin PUT to `calibrated` returns 423 `CALIBRATION_LOCKOUT`. The PUT to `out_of_calibration` stays open to every holder of `maintenance:write` for both registered and unregistered instruments, because locking an instrument down is never a bypass. Unregistered instrument ids keep the Story 1.7 behavior exactly, which is what keeps the spine tests green.
- An instrument is an ASSET (AD-9). `instrument_register` carries `asset_id` referencing the single Story 7.1 register and is unique on it: one asset is at most one instrument record. Do NOT create a second asset concept, do NOT add an `is_instrument` column to `asset` (a story that widens the asset table for a flag one module reads pushes maintenance state into a shared projection), and do NOT register an instrument without an asset.
- `instrument_id` is the QC-facing TEXT key. `qc.result_recorded` carries `instrument_id` as free text and the gate looks it up in `instrument_calibration_statuses`. The register maps that text key to `asset_id`, so the two identifier worlds meet in exactly one row. Uniqueness on `instrument_id` is case-insensitive via `lower()`, matching the Story 7.1 asset-tag and serial precedent and the Story 7.2 scanned-versus-typed lesson.
- Registration is FAIL CLOSED. A newly registered instrument with no certificate is `out_of_calibration` and cannot be used for measurement until a certificate is recorded. Do NOT call `ensureInstrumentCalibrationRow` from the seam: its `INSERT ... VALUES ($1, 'calibrated', $2)` default would silently make every new instrument usable, which is the exact defect AD-8 exists to prevent.
- Certificate validity is the ONLY source of calibrated status for a registered instrument. `calibration_status = 'calibrated'` if and only if an `active` certificate exists whose `valid_until >= business_date`. There is no independent status column on the register, because two places holding the same fact is how a lockout gets defeated.
- Exactly one `active` certificate per instrument, enforced by a partial unique index, not only by a pre-check (the Story 7.1 lesson). Recording a certificate supersedes the previous active one in the SAME transaction. Certificate history is retained: rows move to `superseded` or `expired`, they are never deleted.
- Alerts fire at 30, 14 and 7 days before expiry, ONCE PER STAGE PER CERTIFICATE, not once per day. The grain is `(certificate_id, stage_days)`. A renewal issues a new certificate and therefore a fresh set of three stages. This is deliberately different from the Story 7.4 daily breach alert: a breach persists and needs a daily nudge, an expiry countdown does not.
- The staged scan is a POST-triggered job with an explicit `business_date`, NOT cron. This is the codebase-wide convention (`runSafetyStockComputation`, `runReplenishmentCheck`, `runObsolescenceScan`, `runPmGeneration`, `runGraceWindowSweep`, `runCriticalSpareBreachScan`). The only `setInterval` in the process is the Story 1.11 notification dispatcher. Do NOT add `node-cron`, a timer or a container.
- Escalation NEVER changes calibration status. `maintenance.calibration_escalation_raised` writes an escalation row and emits a notification, and that is all it does. The applier must not touch `instrument_calibration_statuses`, must not write a certificate, and must not set any expiry field. AC 3 is a NEGATIVE property, so it needs a test that would fail if the applier started touching status: assert the status before and after and assert a QC result is still rejected while the escalation is open.
- Escalation reuses the Story 1.7 DOA route. Resolve the approver through `findFirstActiveDoaEntry('calibration.escalation')` and `findRoleHolder`, exactly as `createCalibrationEscalationBase` does. Do not invent a second routing rule and do not hardcode a role.
- No new role string. The staged alert targets `calibration_scheduler`, which the Story 1.7 harness already seeds as the `calibration.escalation` DOA role; the escalation notification targets the resolved approver by `user_id` through the Story 4.3 direct-user path. This is the Story 7.4 `maintenance_storekeeper` lesson applied in advance: a notification aimed at a role no user holds fans out to zero recipients and still reports success.
- Recording an ALREADY-EXPIRED certificate is rejected 422 `CERTIFICATE_EXPIRED`, not silently accepted. A certificate whose `valid_until` is before the request's `business_date` cannot reinstate calibration, and accepting it would leave the operator believing the instrument is usable while the gate still blocks every measurement.
- Out of scope, log each to `deferred-work.md`: amending or voiding a recorded certificate (no AC; a corrected certificate is recorded as a new one that supersedes), calibration due-date scheduling and workload planning against `calibration_interval_days` (the column is captured for the alert horizon, no planning surface is built), calibration work orders on `maintenance_work_order` (no AC ties calibration to the Story 7.2 work-order tree), per-parameter or per-range calibration points and uncertainty budgets (FR-Q measurement detail, Epic 8), extending the lockout to measurement write paths beyond `qc.result_recorded` (weighbridge trade weighment is FR-M-14 and belongs to Story 7.6; every Epic 8 QC path lands on the existing gate for free), offline certificate capture (Story 7.8), and certificate document or PDF attachment storage (no attachment service exists in Phase 1).

### Event Contract

Table 1 lists the six new events. All six are on the `maintenance` stream with `requiresBusinessStream: false`.

| **Event type** | **Key payload fields** | **Projection effect** |
| --- | --- | --- |
| `maintenance.instrument_registered` | `instrument_record_id`, `asset_id`, `instrument_id`, `location_id`, `calibration_interval_days`, `registered_at` | Inserts one `instrument_register` row and writes `instrument_calibration_statuses` at `out_of_calibration` |
| `maintenance.calibration_certificate_recorded` | `certificate_id`, `instrument_record_id`, `instrument_id`, `calibration_type`, `certificate_number`, `issuing_lab`, `calibrated_on`, `valid_until`, `business_date`, `recorded_at` | Supersedes the active certificate, inserts the new one as `active`, writes status `calibrated`, and resolves any open escalation |
| `maintenance.calibration_expiry_flagged` | `alert_id`, `certificate_id`, `instrument_record_id`, `stage_days`, `valid_until`, `business_date`, `flagged_at` | Inserts one `instrument_calibration_alert` row |
| `maintenance.calibration_expired` | `instrument_record_id`, `instrument_id`, `certificate_id`, `valid_until`, `business_date`, `expired_at` | Marks the certificate `expired` and writes status `out_of_calibration` |
| `maintenance.calibration_escalation_raised` | `escalation_id`, `instrument_record_id`, `instrument_id`, `doa_entry_id`, `routed_approver_user_id`, `reason`, `raised_at` | Inserts one `open` `instrument_calibration_escalation` row and NOTHING else |
| `maintenance.calibration_escalation_resolved` | `escalation_id`, `resolving_certificate_id`, `resolved_at` | Flips the escalation to `resolved` and stamps the resolving certificate |

Every payload field that the applier can derive from a locked row is DECLARED in the payload and CHECKED against the derivation, never trusted. Divergence rejects with `CALIBRATION_DERIVATION_MISMATCH` 409. This is the Story 7.2 Group 2 decision, the Story 7.3 `WORK_ORDER_DERIVATION_MISMATCH` pattern and the Story 7.4 review High finding on forged alerts, applied unchanged: a declared-but-unchecked field is a silent corruption channel on the direct `POST /api/v1/events` path, and here that channel writes a LOCKOUT status.

`maintenance.calibration_expiry_flagged` and `maintenance.calibration_expired` are the highest-risk appliers in this story. Both must re-derive `valid_until` and the stage arithmetic from the certificate row held under `FOR UPDATE` and reject a payload that disagrees. A forged `calibration_expiry_flagged` that occupies the `(certificate_id, stage_days)` grain would suppress the genuine alert; a forged `calibration_certificate_recorded` would unlock an instrument.

### Locking Contract

Every applier that mutates more than one row takes `SELECT ... FOR UPDATE` in this FIXED order, so two concurrent commands on the same instrument can never deadlock: asset, then instrument register row, then certificate rows (active first, then the incoming one), then escalation row, then the `instrument_calibration_statuses` row. `setCalibrationStatusFromRegister` takes the status row last and must be the FINAL database call in any applier that changes status.

### Status Write-Through Contract

`instrument_calibration_statuses` stays the single row the lockout gate reads. This story adds one writer and one lookup change.

- `setCalibrationStatusFromRegister({ instrument_id, calibration_status, status_event_id, status_event_version, status_changed_by, reason }, client)` performs an `INSERT ... ON CONFLICT (instrument_id) DO UPDATE` that sets the status, the event linkage and `updated_at`. It NEVER defaults to `calibrated`: the caller always passes an explicit status.
- `getInstrumentCalibrationStatus` matches on `lower(instrument_id) = lower($1)`, backed by a new index `idx_instrument_calibration_statuses_instrument_id_lower` on `lower(instrument_id)`. Without it, a registered instrument stored as `ins-42` and queried as `INS-42` returns null, and null is treated as locked, so the failure mode is a spurious lockout rather than a bypass. Fail-closed is correct but wrong for the operator, and the repo convention (Story 7.2, Story 7.1 asset tags) is to canonicalize.
- The register writes the status row keyed by the instrument id AS STORED in `instrument_register`. Canonicalize with `lower()` in the handler AND in the seam so the direct-event path cannot bypass it.
- Nothing else writes status for a registered instrument. The Story 1.7 `updateInstrumentCalibrationStatus` path stays for unregistered ids and for the lock-down direction only, per the Non-Overridable Contract.

### Non-Overridable Contract

Table 2 defines every path that can change a registered instrument's calibration status. Any path not in this table must be rejected.

| **Path** | **Registered instrument** | **Unregistered instrument** |
| --- | --- | --- |
| `maintenance.calibration_certificate_recorded` with a certificate valid at `business_date` | Sets `calibrated` | Not applicable, the seam rejects with `INSTRUMENT_NOT_FOUND` |
| `maintenance.calibration_expired` from the scan | Sets `out_of_calibration` | Not applicable |
| `maintenance.instrument_registered` | Sets `out_of_calibration` | Not applicable |
| `PUT /api/v1/instruments/:id/calibration-status` with `out_of_calibration` | Allowed, locking down is never a bypass | Allowed, Story 1.7 behavior unchanged |
| `PUT /api/v1/instruments/:id/calibration-status` with `calibrated` | REJECTED 423 `CALIBRATION_LOCKOUT` | Allowed, Story 1.7 behavior unchanged |
| `maintenance.calibration_escalation_raised` or `_resolved` | No status effect whatsoever | Not applicable |

The rejection in row five is checked by a register lookup inside the existing transaction in `updateCalibrationStatusBase`, before `persistEvent`, so a rejected reinstatement writes NO event and leaves NO trace of a status change. The audit entry for the 423 is written by the existing error path.

### Staged Alert Contract

Table 3 defines the scan inputs and rule. Reference it directly when implementing Task 6.2.

| **Quantity** | **Definition** |
| --- | --- |
| Stages | 30, 14 and 7 days, a module constant, not configurable in this story |
| Scan scope | `instrument_calibration_certificate` rows with `status = 'active'`, optionally narrowed by `instrument_record_id` or `location_id` from the request, narrowed in SQL |
| Stage due test | `(valid_until - business_date) <= stage_days AND valid_until >= business_date`, evaluated in SQL as DATE arithmetic, never in JS |
| Alert grain | One row per `(certificate_id, stage_days)`, enforced by `uq_instrument_calibration_alert_stage` |
| Catch-up | A scan skipped for several days fires EVERY unfired due stage on the next run, most urgent first. An equality test on the day count would silently drop a stage whenever the job is not run daily |
| Re-run behavior | A second scan on the same `business_date` fires nothing new, because every due stage already occupies its grain. It is a no-op, not an error |
| Renewal | A new certificate is a new `certificate_id` and therefore a fresh set of three stages. Superseded and expired certificates are excluded from the scan |

The scan holds the certificate row under `FOR UPDATE` for the duration of its grain so two concurrent scans serialize into one alert, and `DUPLICATE_CALIBRATION_ALERT` from the unique index is caught and skipped so one lost race cannot fail a whole scan. This is the Story 7.4 breach-scan pattern applied unchanged.

### Expiry Flip Contract

In the same job run, after the staged alerts, the scan selects `active` certificates with `valid_until < business_date`, narrowed in SQL, and emits one `maintenance.calibration_expired` per certificate. The applier marks the certificate `expired` and writes `out_of_calibration` through `setCalibrationStatusFromRegister`. A re-run on a later `business_date` finds nothing, because the certificate is no longer `active`.

An instrument whose certificate expires while an escalation is open stays locked and the escalation stays open. That combination is exactly AC 3 and needs its own test.

`business_date` is the ONLY notion of "today" inside the job, per the `src/maintenance/pm-jobs.ts` header. Wall-clock time is used solely for `flagged_at` and `expired_at`, which are TIMESTAMPTZ instants with explicit offsets. Derive any calendar date from an instant with `toIstCalendarDate`, never with a bare `slice(0, 10)` on an ISO string: the repo has a live, documented family of clock-window failures from exactly that shortcut.

### Escalation Contract

Table 4 defines the escalation state machine. Any transition not listed rejects; no applier silently no-ops on a state it should reject, per the Story 7.2 Group 2 decision.

| **From state** | **Command** | **To state** | **Calibration status effect** |
| --- | --- | --- | --- |
| (none) | raise | `open` | NONE |
| `open` | resolve with a valid certificate | `resolved` | NONE from the resolve itself; the certificate event sets `calibrated` |
| `open` | raise again | rejects `ESCALATION_ALREADY_OPEN` | NONE |
| `resolved` | any | rejects `ESCALATION_NOT_OPEN` | NONE |

Preconditions, all checked under the lock: the instrument is registered (`INSTRUMENT_NOT_FOUND` 404); its status is `out_of_calibration` (`INVALID_PARAMS` 400, matching the Story 1.7 precondition that escalation requires an out-of-calibration instrument); a DOA entry governs `calibration.escalation` (`NO_DOA_ENTRY_MATCH` 404) and a user holds that role (`NO_APPROVER_FOUND` 404). Resolution requires a certificate that is `active` for that instrument at resolve time (`CERTIFICATE_EXPIRED` 422 otherwise), so an escalation cannot be closed without the re-calibration it exists to expedite.

Recording a certificate auto-resolves an open escalation inside the certificate applier's transaction, emitting `maintenance.calibration_escalation_resolved`. A separate resolve route exists for the case where the certificate was recorded before the escalation was noticed.

### Database Schema Contract

Every new `.sql` file follows the shape of `read/projections/maintenance_spare_catalogue.sql` exactly: the canonical-plus-mirror header comment, `CREATE TABLE IF NOT EXISTS`, inline constraints in the CREATE body PLUS guarded `DO $$` `ALTER TABLE ... ADD CONSTRAINT` blocks for self-healing, `CREATE INDEX IF NOT EXISTS`, and a guarded grants block that checks `pg_roles` before granting. Every statement must be safely re-appliable to a live database. Rows are derived state only: mutation happens exclusively through `persistEvent`, which applies the projection inside the SAME transaction as the `domain_events` insert.

Table 5 lists the required tables, grains and named constraints.

| **Table** | **Grain and key constraints** |
| --- | --- |
| `instrument_register` | `instrument_record_id` UUID primary key; `uq_instrument_register_instrument_id UNIQUE INDEX (lower(instrument_id))`; `uq_instrument_register_asset UNIQUE (asset_id)`; `chk_instrument_register_interval CHECK (calibration_interval_days > 0 AND calibration_interval_days <= 3650)`; index on `location_id` |
| `instrument_calibration_certificate` | `certificate_id` UUID primary key; `chk_instrument_calibration_certificate_type CHECK (calibration_type IN ('in_house','iso_17025'))`; `chk_instrument_calibration_certificate_status CHECK (status IN ('active','superseded','expired'))`; `chk_instrument_calibration_certificate_validity CHECK (valid_until >= calibrated_on)`; `chk_instrument_calibration_certificate_iso_lab CHECK (calibration_type <> 'iso_17025' OR issuing_lab IS NOT NULL)`; `uq_instrument_calibration_certificate_active UNIQUE INDEX (instrument_record_id) WHERE status = 'active'`; `uq_instrument_calibration_certificate_number UNIQUE INDEX (instrument_record_id, lower(certificate_number))`; index on `valid_until` where `status = 'active'` |
| `instrument_calibration_alert` | `alert_id` UUID primary key; `chk_instrument_calibration_alert_stage CHECK (stage_days IN (30, 14, 7))`; `uq_instrument_calibration_alert_stage UNIQUE (certificate_id, stage_days)`; index on `business_date`; index on `instrument_record_id` |
| `instrument_calibration_escalation` | `escalation_id` UUID primary key; `chk_instrument_calibration_escalation_status CHECK (status IN ('open','resolved'))`; `chk_instrument_calibration_escalation_resolution CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolving_certificate_id IS NOT NULL))`; `uq_instrument_calibration_escalation_open UNIQUE INDEX (instrument_record_id) WHERE status = 'open'`; index on `routed_approver_user_id` |

All calendar fields (`calibrated_on`, `valid_until`, `business_date`) are `DATE`; all instants (`registered_at`, `recorded_at`, `flagged_at`, `expired_at`, `raised_at`, `resolved_at`) are `TIMESTAMPTZ`. `calibration_interval_days` is `INTEGER`. There are no NUMERIC quantities in this story.

Known gate limitation, carried from the 7.2 Group 1 review and re-confirmed by the 7.3 review: the schema-drift test compares init-db against canonical and checks that named constraints and indexes EXIST by name, but it cannot detect an extra constraint added only to a CREATE body and it ignores statement ordering. Keep the canonical file and the init-db mirror literally identical for the new blocks rather than relying on the gate.

### Compliance Seam Contract

`src/compliance/calibration-register.ts` follows `src/compliance/maintenance-spares.ts` structurally:

- A stream gate returning null for non-`maintenance` streams so the seam never sees a foreign event.
- A PURE `assertCalibrationRegisterShape(envelope)` that runs pre-transaction with no database access, so a malformed event never consumes an idempotency key. It validates every declared payload field, every UUID, every enum, every DATE against `DATE_REGEX`, every integer bound and every timestamp format. An explicit UTC offset is REQUIRED on every TIMESTAMPTZ input, per the 7.2 offset lesson.
- An `applyCalibrationRegisterProjection(envelope, client)` switch whose branches run inside `persistEvent`'s transaction and honor the Locking Contract.
- The same `alreadyPersisted` guard and the same `reject(code, message, details, status)` AppError helper, copied verbatim rather than re-derived.
- `instrument_id` and `certificate_number` are canonicalized with `lower()` on every human-entered path before lookup and before persisting, in the handler AND in the seam so the direct-event path cannot bypass it.
- No applier emits a notification, writes outside its transaction, or silently no-ops on a state it should reject.

The file name matters. `src/compliance/calibration.ts` is the Story 1.7 QC-stream gate and must not be renamed, extended with register logic, or have its `assertCalibrationLockout` export changed. Two files with adjacent names is the correct outcome here: one gates the QC stream, the other applies maintenance-stream register events.

### Notification Contract

Three emissions, all through `emitNotification` in `src/notify/emit.ts`, all AFTER their event commits, all non-throwing. None is an approval decision, so none takes the transactional entry point (AD-17).

- Staged expiry (AC 1): `event_type: 'calibration_expiry_due'`, `status_verb: 'Due'`, `object_type: 'instrument'`, `object_id: <alert_id>`, target `{ role: 'calibration_scheduler', location_id: <register location> }`, `actor_label` naming the instrument id, the asset name and the days remaining, `next_step: 'Schedule re-calibration'`. Only the 7-day stage carries `escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 86400 }`; the 30-day and 14-day stages carry none, because escalating a month-out reminder is noise.
- Expiry flip (AC 2): `event_type: 'calibration_expired'`, `status_verb: 'Expired'`, `object_type: 'instrument'`, `object_id: <instrument_record_id>`, target `{ role: 'calibration_scheduler', location_id: <register location> }`, `next_step: 'Instrument is locked out until a new certificate is recorded'`, `escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 86400 }`.
- Escalation raised (AC 3): `event_type: 'calibration_escalation_raised'`, `status_verb: 'Escalated'`, `object_type: 'instrument'`, `object_id: <escalation_id>`, target `{ role: <DOA entry role>, user_id: <routed_approver_user_id> }` using the Story 4.3 direct-user path, `next_step: 'Expedite re-calibration; the lockout stays in force'`. The `next_step` wording is part of AC 3: the person receiving the escalation must not read it as an unlock authorization.

`actor_label` names the human-readable subject, not a raw id (the 7.2 Group 4 patch). A failed emission is logged and swallowed (AD-17): it never rolls back the business write. `calibration_scheduler` is an EXISTING role string seeded by the Story 1.7 DOA registry, not a new one.

### API Contract

Table 6 lists the ten new routes. All are registered in `createAppRouter` and all ten must be added to `allowedSpineRoutes`.

| **Method and path** | **Scope** | **Behavior** |
| --- | --- | --- |
| `POST /api/v1/maintenance/instruments` | write | Registers one asset as an instrument; 404 `ASSET_NOT_FOUND`, 404 `LOCATION_NOT_FOUND`, 409 `INSTRUMENT_ALREADY_REGISTERED`, 409 `ASSET_ALREADY_INSTRUMENT`. The created instrument is `out_of_calibration` |
| `GET /api/v1/maintenance/instruments` | read | Filterable by `asset_id`, `location_id`, `calibration_status`; paginated |
| `GET /api/v1/maintenance/instruments/:instrumentRecordId` | read | Register row plus the active certificate and the current calibration status; 404 `INSTRUMENT_NOT_FOUND` |
| `POST /api/v1/maintenance/instruments/:instrumentRecordId/certificates` | write | Records a certificate and reinstates calibration; requires `business_date`; 400 `INVALID_CALIBRATION_TYPE`, 400 `INVALID_CERTIFICATE_VALIDITY`, 409 `CERTIFICATE_ALREADY_RECORDED`, 422 `CERTIFICATE_EXPIRED` |
| `GET /api/v1/maintenance/instruments/:instrumentRecordId/certificates` | read | Certificate history, newest first; paginated |
| `POST /api/v1/maintenance/instruments/:instrumentRecordId/escalations` | write | Raises a DOA-routed escalation; 400 `INVALID_PARAMS` when the instrument is not out of calibration, 409 `ESCALATION_ALREADY_OPEN`, 404 `NO_DOA_ENTRY_MATCH`, 404 `NO_APPROVER_FOUND` |
| `POST /api/v1/maintenance/calibration/scan` | write | Runs the staged alert pass and the expiry flip for an explicit `business_date`, optionally narrowed by `instrument_record_id` or `location_id`; returns the four counters |
| `GET /api/v1/maintenance/calibration/alerts` | read | Lists persisted alerts, filterable by `instrument_record_id`, `stage_days`, `business_date`; paginated |
| `GET /api/v1/maintenance/calibration/escalations` | read | Filterable by `instrument_record_id`, `status`; paginated |
| `POST /api/v1/maintenance/calibration/escalations/:escalationId/resolve` | write | Closes an open escalation against an active certificate; 404 `ESCALATION_NOT_FOUND`, 409 `ESCALATION_NOT_OPEN`, 422 `CERTIFICATE_EXPIRED` |

Route ordering matters and is the single most likely silent defect in Task 7.2. Register `/calibration/scan`, `/calibration/alerts` and `/calibration/escalations` (all static under `/calibration/`) before any `/calibration/:param` route, and register `/instruments` before `/instruments/:instrumentRecordId`. The three `/instruments/:instrumentRecordId/` sub-resources come after the detail route, matching the Story 7.3 and 7.4 blocks. Confirm no path in this block shadows the existing `/api/v1/instruments/:id/*` routes: those live under `/api/v1/instruments`, these under `/api/v1/maintenance/instruments`, and the two prefixes must stay distinct.

Every write route carries an `idempotency_key`; a blank or non-string key falls back to `randomUUID()`; a cross-event-type reuse returns 409 `DUPLICATE_EVENT`. Reuse `idempotencyKeyFrom`, `replayIdOrReject` and `requireBusinessDate` from `src/api/v1/maintenance.ts` rather than writing new helpers. Every 201 body is read back BY ID from the persisted payload's own id, never by re-querying the newest row and never by grain (the Story 7.4 review Medium finding).

### Error Code Contract

Table 7 is the complete set of error codes this story introduces or reuses. Every code must appear in at least one test.

| **Code** | **HTTP** | **Raised when** |
| --- | --- | --- |
| `ASSET_NOT_FOUND` | 404 | Reused from Story 7.2: the asset id does not resolve in `asset` |
| `LOCATION_NOT_FOUND` | 404 | Reused: the location id does not resolve in `location_register` |
| `INSTRUMENT_ALREADY_REGISTERED` | 409 | A register row already holds that `lower(instrument_id)` |
| `ASSET_ALREADY_INSTRUMENT` | 409 | That asset already has an instrument record |
| `INSTRUMENT_NOT_FOUND` | 404 | The instrument record id, or the instrument id on a direct event, does not resolve |
| `INVALID_CALIBRATION_TYPE` | 400 | `calibration_type` is not `in_house` or `iso_17025`, or `iso_17025` arrives without `issuing_lab` |
| `INVALID_CERTIFICATE_VALIDITY` | 400 | `valid_until` is before `calibrated_on`, or either date fails `DATE_REGEX` |
| `CERTIFICATE_ALREADY_RECORDED` | 409 | A certificate with that number already exists for the instrument |
| `CERTIFICATE_EXPIRED` | 422 | A certificate whose `valid_until` is before `business_date` is recorded, or an escalation resolve names a certificate that is not active |
| `CALIBRATION_LOCKOUT` | 423 | Reused: a QC result against a non-calibrated instrument, AND a manual reinstatement attempt on a registered instrument |
| `ESCALATION_ALREADY_OPEN` | 409 | An escalation is raised while one is already open for that instrument |
| `ESCALATION_NOT_FOUND` | 404 | Resolve names an unknown escalation id |
| `ESCALATION_NOT_OPEN` | 409 | Resolve targets an already-resolved escalation |
| `NO_DOA_ENTRY_MATCH` | 404 | Reused from Story 1.7: no DOA entry governs `calibration.escalation` |
| `NO_APPROVER_FOUND` | 404 | Reused from Story 1.7: no active user holds the DOA role |
| `CALIBRATION_DERIVATION_MISMATCH` | 409 | A declared payload field disagrees with the value derived from locked rows |
| `DUPLICATE_CALIBRATION_ALERT` | 409 | 23505 resolution on `uq_instrument_calibration_alert_stage` |
| `INVALID_PARAMS` | 400 | Reused: malformed body, unsupported filter combination, or escalation on an instrument that is not out of calibration |
| `DUPLICATE_EVENT` | 409 | Reused: cross-event-type idempotency-key reuse |

### Architecture Compliance

- AD-8 (calibration lockout non-overridable): the lockout stays in `src/compliance/calibration.ts` on the QC write path; this story removes the one remaining override channel (manual reinstatement of a registered instrument) and makes escalation status-neutral by construction. No role list, no override flag, no reason-coded bypass anywhere in this story.
- AD-9 (one asset register): `instrument_register.asset_id` references the single Story 7.1 register and is unique on it. No second asset concept and no new column on `asset`.
- AD-14 (read models are shared projections): every mutation goes through `persistEvent`; projections are derived state applied in the same transaction. No raw SQL mutation from a job or handler.
- AD-16 (idempotency keys): every write route carries an `idempotency_key`; a replay returns the stored result, a cross-type reuse returns 409.
- AD-17 (notification coupling): all three emissions use the decoupled `emitNotification`. None is an approval decision.
- Module directory: all new code lands under `src/maintenance/`, `src/compliance/`, `src/read/projections/` and `src/api/v1/`. No new top-level directory.
- RBAC: `requireRole({ module: 'maintenance', functionScope: 'read' })` or `'write'` on every new handler, never a hardcoded role list in a handler body. The no-hardcoded-role gate enforces this. The 423 in Task 5.1 is a business rule, not an RBAC decision, and must be raised AFTER the RBAC wrapper, not inside it.

### Previous Story Intelligence

Story 7.4 shipped after a 3-High, 8-Medium, 12-Low review. Every lesson below is live and skipping any of them will reproduce a finding:

- Alert appliers that trust payload derivable fields were the top High finding. Re-derive under the lock and reject a fabricated alert; a forged alert occupying the same-day grain suppresses the genuine escalation. Here the same class of forgery unlocks an instrument, so it is strictly worse.
- Read back a created resource BY ID from the persisted payload, never by grain and never by newest row, or a same-key replay with a different body returns the wrong row or null.
- A wire boolean must be validated, not coerced: `"true"` as a string silently becoming `false` disabled a whole FR in 7.4. This story has no booleans on the wire, but `calibration_interval_days` and `stage_days` are integers and must be rejected, not coerced, when they arrive as strings or floats.
- Guard every `decodeURIComponent` on a path segment and return 400 `INVALID_PARAMS` on a malformed encoding rather than throwing an uncaught URIError 500.
- A filter that is silently ignored in an unsupported combination must return 400 `INVALID_PARAMS` instead.
- Concurrency tests on the FOR UPDATE and 23505 race path are mandatory, not optional: the race path and the sequential path must return the SAME error code with the SAME `existing_*` detail.
- Bound every integer and count field at load and at the handler; an unbounded value becomes a 500 instead of a 400.
- Job results expose delivery counters separately from write counters, so a dropped notification is visible.
- Narrow job scope in SQL, not in a JS filter after the fact, or the counters overstate what was evaluated.
- Never let an applier silently no-op on a state it should reject.
- Every TIMESTAMPTZ input requires an explicit UTC offset; every DATE derived from a timestamp pins its zone explicitly through `toIstCalendarDate`.
- Canonicalize every human-entered key with `lower()`, in the handler AND in the seam.
- A notification aimed at a role no user holds fans out to zero recipients and reports success. Provision the target role in the harness and assert the fan-out resolves to a real user.

Story 7.2 lessons that still bind: duplicate detection under `FOR UPDATE` with a unique index as the backstop, and actor-derived fields never read from the payload. Story 7.1 lesson that still binds: the one-record rule is enforced by a database constraint, not only by a pre-check.

Two open platform gaps from the ledger apply here and are NOT this story's to fix: a `maintenance.*` event posted with a non-`maintenance` `stream_type` skips the seam gates (`src/events/store.ts`), and same-event-type idempotency-key reuse with different content returns the original event. The first one is more dangerous in this story than in any previous one, because the events it would smuggle past the seam write lockout status. Note it in `deferred-work.md` again with that framing.

### Git Intelligence

Baseline is `eca5aca` ("Stry 7-5"), the commit that landed the complete Story 7.4 tree. Recent commits (`eca5aca`, `1df3013`, `893e945` and `ce42587` asset registration) show the established rhythm: canonical SQL plus init-db mirror plus schema-drift entry land together; seams are wired into `store.ts` in the same commit as the events they validate; the integration suite is authored alongside, not after. Follow it. The working tree is clean at story-creation time, so record the actual `git rev-parse HEAD` value in the frontmatter at the start of dev-story.

### Testing Requirements

- Framework and harness: the existing integration-test harness under `test/integration/`, bootstrapped exactly as `story-7-4.test.ts` does. Unit-level schema assertions go in `test/unit/schema-drift.test.ts`.
- Red-green-refactor per task: write the failing assertion first, confirm it fails for the right reason, then implement.
- Every acceptance criterion needs at least one test that would FAIL if the behavior were removed. A test that only asserts a 200 is not coverage.
- Every error code in Table 7 needs a test.
- Idempotency: every write route gets a replay test asserting the same resource comes back and the event ledger count did not grow.
- The three lockout-integrity tests are mandatory and are the heart of AC 2 and AC 3:
  1. Manual reinstatement is rejected. Register an instrument, expire it, then `PUT /api/v1/instruments/:id/calibration-status` with `calibrated` as a `maintenance:write` holder and assert 423 `CALIBRATION_LOCKOUT`, assert the status is still `out_of_calibration`, and assert NO `instrument.calibration_status_updated` event was written.
  2. Escalation is status-neutral. Raise an escalation on an expired instrument, then assert the calibration status is byte-identical before and after, assert no certificate row appeared, and assert a `qc.result_recorded` for that instrument is STILL rejected 423 while the escalation is open.
  3. Expiry locks end to end. Record a certificate, run the scan on a `business_date` after `valid_until`, then post a QC result through `POST /api/v1/qc/results` and assert 423 with zero `qc.result_recorded` events for that instrument.
- Fail-closed registration: a freshly registered instrument with no certificate rejects a QC result. This catches an accidental `ensureInstrumentCalibrationRow` call, whose default would make it usable.
- Staged alerts: one test per stage boundary (exactly 30, exactly 14, exactly 7 days out), a catch-up test where a scan is skipped and the next run fires every unfired stage, a same-day re-run test asserting nothing new fires, and a renewal test asserting a new certificate produces a fresh set of three stages.
- Derivation mismatch: a direct `POST /api/v1/events` carrying a forged `maintenance.calibration_expiry_flagged` with a `valid_until` that disagrees with the certificate is rejected 409 `CALIBRATION_DERIVATION_MISMATCH`, and a forged `maintenance.calibration_certificate_recorded` cannot unlock an instrument.
- Concurrency: parallel registration on the same `instrument_id`, parallel certificate recording on the same instrument, and parallel escalation raises each resolve to one success and one stable 409.
- Regression: the Story 1.7 suite and the Spine 4 test in the Story 1.9 suite must pass UNCHANGED, with no edit to either file except the `allowedSpineRoutes` additions in Task 7.3. If a Story 1.7 assertion has to change, the Non-Overridable Contract has been misread: re-read Table 2 before touching that file.
- Stories 7.1, 7.2, 7.3 and 7.4 suites must pass unchanged.
- Do not weaken, skip or delete an existing test to make a new one pass.
- Known baseline: seventeen pre-existing failures at `eca5aca` (fifteen Epic 1 to 3 idempotency failures, one `story-5-3` where-used clock-window flake, one `gate_dwell_metric` line-ending artifact), all recorded in `deferred-work.md`. Zero NEW failures is the bar; do not attempt to fix the baseline in this story.

### Project Structure Notes

New files: `read/projections/instrument_register.sql`, `read/projections/instrument_calibration_certificate.sql`, `read/projections/instrument_calibration_alert.sql`, `read/projections/instrument_calibration_escalation.sql`, `src/compliance/calibration-register.ts`, `src/read/projections/instrument_register.ts`, `src/read/projections/instrument_calibration_certificate.ts`, `src/read/projections/instrument_calibration_alert.ts`, `src/read/projections/instrument_calibration_escalation.ts`, `src/maintenance/calibration-jobs.ts`, `test/integration/story-7-5.test.ts`.

Modified files: `read/projections/instrument_calibration.sql`, `deploy/compose/init-db.sql`, `src/events/migrate.ts`, `src/events/schema.ts`, `src/events/store.ts`, `src/read/projections/instrument_calibration.ts`, `src/api/v1/instruments.ts`, `src/api/v1/maintenance.ts`, `src/server.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-1-9.test.ts`, `_bmad-output/implementation-artifacts/deferred-work.md`.

Read-only, do not modify: `src/compliance/calibration.ts` (the Story 1.7 lockout gate), `test/integration/story-1-7.test.ts`, and everything under `src/engineering/`.

No new dependency is required or permitted. Everything this story needs (pg, node:crypto, the existing middleware, the notification service, the DOA resolvers) is already installed.

### References

- Epic 7 story plus FR-M-12 and FR-M-13: `_bmad-output/planning-artifacts/epics.md` (Story 7.5 at line 2211; the FR-M-12 and FR-M-13 lines at 167 and 168; the Epic 1 versus Epic 7 ownership split at line 782; the Spine Acceptance Contract list at line 842).
- FR-Q-04 dependency on this lockout: `_bmad-output/planning-artifacts/epics.md` line 145.
- AD-8, AD-9, AD-14, AD-16 and AD-17 plus the module directory: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` (AD-8 at line 112).
- Previous story, its review outcome and its binding decisions: `_bmad-output/implementation-artifacts/7-4-spare-parts-cataloguing-reservation-and-critical-spares-alerts.md`.
- The existing lockout gate and its exact rejection shape: `src/compliance/calibration.ts` (`assertCalibrationLockout`), called from `src/events/store.ts` line 408.
- The existing status table, its accessors and the `calibrated` default to avoid: `read/projections/instrument_calibration.sql` and `src/read/projections/instrument_calibration.ts` (`ensureInstrumentCalibrationRow`, `updateInstrumentCalibrationStatus`, `getCalibrationStatus`).
- The Story 1.7 admin endpoints to preserve and the DOA escalation routing to reuse: `src/api/v1/instruments.ts` (`updateCalibrationStatusBase`, `createCalibrationEscalationBase`), `src/read/projections/doa_registry.ts` (`findFirstActiveDoaEntry`, `findRoleHolder`).
- The spine tests that must pass unchanged: `test/integration/story-1-7.test.ts` and `test/integration/story-1-9.test.ts` (Spine 4, FR-M-13).
- Seam template, duplicate resolvers and the derivation-match pattern: `src/compliance/maintenance-spares.ts` and `src/compliance/maintenance-fault.ts`.
- Job template, SQL-narrowed scope, per-grain locking and separated counters: `src/maintenance/spares-jobs.ts` and `src/maintenance/pm-jobs.ts`.
- Projection SQL template: `read/projections/maintenance_spare_catalogue.sql`; `lower()` unique-index precedent and the self-healing guarded drop: `read/projections/asset.sql`.
- Asset and location lookups: `src/read/projections/asset.ts` (`getAssetById`) and `src/read/projections/location_register.ts`.
- API handlers, helpers and RBAC wrapping: `src/api/v1/maintenance.ts` (`idempotencyKeyFrom`, `replayIdOrReject`, `requireBusinessDate`); route registration in `src/server.ts` (`createAppRouter`).
- Notification service, direct-user targeting and escalation windows: `src/notify/emit.ts`; escalation dispatch and role resolution: `src/notify/escalate.ts`; coupling decision record: `docs/adr/ADR-001-notification-emission-coupling.md`.
- IST calendar date derivation: `src/lib/business-days.ts` (`toIstCalendarDate`).
- Event registry and payload template: `src/events/schema.ts` (Story 7.4 block, `SUPPORTED_EVENT_TYPES` tail at line 2487).
- Seam wiring and the 23505 mapper: `src/events/store.ts`.
- Migration registration: `src/events/migrate.ts` (MIGRATIONS tail).
- Test harness template: `test/integration/story-7-4.test.ts`; schema-drift `EXPECTED` in `test/unit/schema-drift.test.ts`; spine allowlist in `test/integration/story-1-9.test.ts`.
- Known pre-existing failures and platform gaps: `_bmad-output/implementation-artifacts/deferred-work.md`.
- Formatting rules for any Markdown authored during the story: `FORMATTING_RULES.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-5[1m] (Claude Code, bmad-dev-story workflow)

### Debug Log References

- `npm run db:migrate` run twice against the test database: both runs applied all four new files with no error, confirming every statement is re-appliable.
- `test/unit/schema-drift.test.ts`: 97 pass, 1 fail. The single failure is the pre-existing `gate_dwell_metric` view-body line-ending artifact recorded in `deferred-work.md`; it fails identically at baseline `eca5aca`.
- `test/integration/story-7-5.test.ts`: 34 pass, 0 fail.
- Full suite with this change: 1073 tests, 1057 pass, 16 fail. Full suite at baseline `eca5aca` with the working tree stashed: 1034 tests, 1018 pass, 16 fail. The two failure sets are identical after stripping timings, so all 39 new tests pass and zero new failures were introduced.
- Two failures deserve naming because they sit in this story's area and are NOT regressions: `gate_dwell_metric: view body is canonical and mirrored in init-db.sql` (line-ending artifact) and the Story 1.7 `regression guard: non-QC streams and QC non-result events persist without calibration lookup`, which fails at baseline because the direct-events HTTP guard already blocks `stream_type: maintenance`. Both were verified failing at `eca5aca` before any change in this story.
- `npx tsc --noEmit` and `npx eslint src/ test/` are both clean.

### Completion Notes List

- The lockout GATE was not touched. `src/compliance/calibration.ts` and `test/integration/story-1-7.test.ts` are unchanged; the only edit to `test/integration/story-1-9.test.ts` is the ten `allowedSpineRoutes` additions Task 7.3 requires. The Spine Acceptance Contract suite passes.
- Registration is fail closed. `applyInstrumentRegistered` writes `instrument_calibration_statuses` at `out_of_calibration` through `setCalibrationStatusFromRegister` and never calls `ensureInstrumentCalibrationRow`, whose `calibrated` default would have made every new instrument usable. A test asserts a freshly registered instrument rejects a QC result with 423.
- AC 3 is guaranteed by construction rather than by review: `instrument_calibration_escalation` carries no status column and neither escalation applier imports a status writer, so no code path exists by which an escalation can change calibration status. The test asserts the status row is byte-identical before and after a raise and that a QC result is still rejected while the escalation is open.
- Manual reinstatement is closed inside the `updateCalibrationStatusBase` transaction and before `persistEvent`, so a rejected reinstatement writes no event. The test asserts the status row is unchanged and the `instrument.calibration_status_updated` count did not grow.
- The status row for a registered instrument is now always keyed by the canonical lower-cased instrument id. `updateCalibrationStatusBase` resolves the register row first and uses its stored id, so a case variant in the URL updates the one row instead of creating a second row that would make the gate lookup ambiguous. A test asserts exactly one status row survives a mixed-case PUT.
- Staged alerts fire once per `(certificate_id, stage_days)`. Catch-up and same-day re-run behaviour are structural, not special-cased: `listCertificateStagesDue` asks which stages are due and unfired in SQL. Tests cover the exact 30, 14 and 7 day boundaries, a 31-days-out no-op, a three-stage catch-up, a same-day re-run firing nothing, and a renewal earning a fresh set of three.
- Every derivable payload field is re-derived under `FOR UPDATE` and rejected on divergence with 409 `CALIBRATION_DERIVATION_MISMATCH`. Four direct `persistEvent` forgery tests cover a wrong `valid_until`, an undue stage, a certificate naming a different instrument (asserting the victim stays locked), and an expiry against a still-valid certificate.
- Auto-resolution of an open escalation happens inside the certificate applier's transaction by emitting `maintenance.calibration_escalation_resolved` on the caller's client, following the `src/compliance/purchase-order.ts` nested `persistEvent` precedent, so the closure lands in the event ledger rather than as a silent row update.
- The standalone resolve route deliberately carries no `ESCALATION_NOT_OPEN` pre-check in the handler: such a check fires on a legitimate replay, when the escalation is already resolved, and would return 409 instead of the stored result. The seam owns that rejection, and its `alreadyPersisted` guard short-circuits a replay first. Both the replay and the genuine second resolve are tested.
- `status_event_version` is written as NULL on register-driven status changes because the applier runs before the `domain_events` insert assigns the version. `status_event_id` is always recorded. Logged in `deferred-work.md` with the two ways it could be resolved.
- No new role string was introduced. Staged and expiry notifications target `calibration_scheduler`, the role the Story 1.7 DOA registry already seeds; the escalation notification targets the resolved approver by `user_id`. The harness provisions the literal role and a test asserts the fan-out resolves to at least one real recipient.
- Nine scope deferrals and two platform gaps are logged in `_bmad-output/implementation-artifacts/deferred-work.md` under the Story 7.5 heading, including the re-framed warning that a `maintenance.*` event on a foreign `stream_type` would skip the seam that writes lockout status.

### File List

New files:

- `read/projections/instrument_register.sql`
- `read/projections/instrument_calibration_certificate.sql`
- `read/projections/instrument_calibration_alert.sql`
- `read/projections/instrument_calibration_escalation.sql`
- `src/compliance/calibration-register.ts`
- `src/read/projections/instrument_register.ts`
- `src/read/projections/instrument_calibration_certificate.ts`
- `src/read/projections/instrument_calibration_alert.ts`
- `src/read/projections/instrument_calibration_escalation.ts`
- `src/maintenance/calibration-jobs.ts`
- `test/integration/story-7-5.test.ts`

Modified files:

- `read/projections/instrument_calibration.sql`
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/read/projections/instrument_calibration.ts`
- `src/api/v1/instruments.ts`
- `src/api/v1/maintenance.ts`
- `src/server.ts`
- `test/unit/schema-drift.test.ts`
- `test/integration/story-1-9.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/7-5-calibration-register-and-non-overridable-lockout.md`

## Change Log

Table 8 records every change made while implementing this story.

| **Date** | **Change** |
| --- | --- |
| 2026-08-25 | Task 1: four new calibration projections plus a case-insensitive lookup index on the existing `instrument_calibration_statuses`, mirrored into `deploy/compose/init-db.sql`, registered in `MIGRATIONS`, and pinned by five new `EXPECTED` entries in the schema-drift gate. Migration verified idempotent across two runs. |
| 2026-08-25 | Task 2: six Story 7.5 payload and envelope types added to `src/events/schema.ts` and registered in `SUPPORTED_EVENT_TYPES` on the `maintenance` stream. |
| 2026-08-25 | Task 3: four new accessor modules, plus `setCalibrationStatusFromRegister` and a `lower()` lookup on the existing `instrument_calibration.ts`. |
| 2026-08-25 | Task 4: `src/compliance/calibration-register.ts` with six appliers, pure shape validation, the fixed lock order and six 23505 duplicate resolvers, wired into `src/events/store.ts`. |
| 2026-08-25 | Task 5: manual reinstatement of a registered instrument rejected 423 `CALIBRATION_LOCKOUT` inside the `updateCalibrationStatusBase` transaction, before `persistEvent`. |
| 2026-08-25 | Task 6: `src/maintenance/calibration-jobs.ts` with the POST-triggered staged alert pass, the expiry flip, and separated write and delivery counters. |
| 2026-08-25 | Task 7: ten REST routes added to `src/api/v1/maintenance.ts`, registered in `createAppRouter` static before parameter, and added to `allowedSpineRoutes`. |
| 2026-08-25 | Task 8: `test/integration/story-7-5.test.ts` with 34 tests covering all three acceptance criteria, every error code, replay, concurrency and direct-event forgery. Full suite shows zero new failures against baseline `eca5aca`. |
| 2026-08-25 | Task 9: nine scope deferrals and two platform gaps logged in `deferred-work.md` under the Story 7.5 heading. |

## Review Findings

### Group 1 - Schema + Seam + Events (2026-08-25)

Blind Hunter, Edge Case Hunter and Acceptance Auditor ran in parallel against the uncommitted working tree at baseline `eca5aca`; all three returned findings, none failed. The deadlock finding was reported independently by all three layers.

Patches (resolved 2026-08-25):

All eight applied and verified: `npx tsc --noEmit`, `npx eslint` and `npx prettier --check` clean; `test/integration/story-7-5.test.ts` 34/34 pass. The Story 1.9 spine suite passes 6/6. The Story 1.7 `regression guard: non-QC streams...` failure is the documented pre-existing baseline failure (direct-events HTTP guard blocks `stream_type: maintenance`), unchanged at `eca5aca`. Four forgery tests were updated so their `stream_id` matches the payload id field (the documented convention in schema.ts), which is required for the new stream_id derivation check to pass and for the specific forgery under test to reach its applier-level rejection.

- [x] [Review][Patch] `applyEscalationResolved` locks the escalation row before the certificate row, inverting the fixed lock order; concurrent with `applyCertificateRecorded` this is a real AB-BA deadlock (40P01, unmapped, 500) [src/compliance/calibration-register.ts:938]
- [x] [Review][Patch] `applyCertificateRecorded` locks the incoming certificate (by number) before the active one, not honoring the "active first, then incoming" order [src/compliance/calibration-register.ts:533]
- [x] [Review][Patch] Four new table primary keys (`instrument_register_pkey`, `instrument_calibration_certificate_pkey`, `instrument_calibration_alert_pkey`, `instrument_calibration_escalation_pkey`) missing from the store.ts 23505 pkey chain; a direct-event duplicate id is a raw 500 [src/events/store.ts:1289]
- [x] [Review][Patch] `isIsoDate`/`isIsoTimestamp` accept impossible calendar dates (e.g. 2026-02-30) because `Date.parse` normalizes; the value passes the pre-transaction shape assert then dies as an unmapped 22008 500 mid-transaction, and defeats the lexicographic `CERTIFICATE_EXPIRED` pre-check [src/compliance/calibration-register.ts:98]
- [x] [Review][Patch] `envelope.stream_id` is never cross-checked against the payload id field; a forged direct event stores an inconsistent stream_id and pollutes `readStream` replay [src/compliance/calibration-register.ts:155]
- [x] [Review][Patch] Auto-resolve stamps `resolved_at` with the certificate's declared `recorded_at`; a backdated forged certificate yields `resolved_at < raised_at` [src/compliance/calibration-register.ts:590]
- [x] [Review][Patch] Whitespace-only `idempotency_key` is treated as a real dedup key in `alreadyPersisted` [src/compliance/calibration-register.ts:343]
- [x] [Review][Patch] Four new canonical SQL files are CRLF; repo convention (asset.sql, maintenance_spare_catalogue.sql) is LF [read/projections/instrument_register.sql]

Deferred (checked; both already logged under the dev-story 7-5 heading in `deferred-work.md`, so not re-appended):

- [x] [Review][Defer] A `maintenance.*` event posted with a non-`maintenance` `stream_type` skips every maintenance seam gate, including the register seam that writes lockout status - pre-existing platform-wide stream/event-type gap, re-framed and logged under dev-story 7-5 in `deferred-work.md`
- [x] [Review][Defer] Same-event-type idempotency-key reuse with different content returns the original event - standard idempotency semantics, logged under dev-story 7-5 in `deferred-work.md`

Dismissed (2): the case-variant legacy status row shadowing concern is handled by `setCalibrationStatusFromRegister`'s UPDATE-first `lower()` match (src/read/projections/instrument_calibration.ts:135); the one-sided `chk_instrument_calibration_escalation_resolution` CHECK matches the spec's Table 5 definition exactly.

### Group 2 - Read Projections + API + Jobs (2026-08-25)

Blind Hunter, Edge Case Hunter and Acceptance Auditor ran in parallel against the working tree after the Group 1 patches; all three returned findings, none failed. The job expired-pass lock-order inversion was reported by all three layers.

Patches (resolved 2026-08-25):

- [x] [Review][Patch] The calibration-jobs expiry-flip transaction locked the certificate row before the register row, inverting the Locking Contract and AB-BA deadlocking against `applyCertificateRecorded` (40P01, unmapped, whole scan 500); it now locks the register row first [src/maintenance/calibration-jobs.ts:236]
- [x] [Review][Patch] AC 2 TOCTOU: `updateCalibrationStatusBase` read the register without `FOR UPDATE`, so a concurrent registration could commit between the read and the status write and fork a second case-variant status row that makes the lockout gate ambiguous; the register lookup is now locked [src/api/v1/instruments.ts:131]
- [x] [Review][Patch] `setCalibrationStatusFromRegister` now renames a case-variant pre-existing status row to the canonical register case (`SET instrument_id = $1`), so the Story 1.7 exact-match upsert finds it instead of inserting a duplicate [src/read/projections/instrument_calibration.ts:135]
- [x] [Review][Patch] `requireBusinessDate`/`requireCalendarDate` and the read-projection date guards accepted impossible dates (2026-02-30) that `Date.parse` normalizes, then died as an unmapped 22008 500 on `$N::date` casts; a shared `isValidCalendarDate` round-trip check now rejects them in the handlers and the projections [src/lib/business-days.ts, src/api/v1/maintenance.ts, src/read/projections/instrument_calibration_certificate.ts, src/read/projections/instrument_calibration_alert.ts]
- [x] [Review][Patch] Replaying an escalation raise re-emitted the notification (and could route it to a freshly resolved DOA approver); the notification is now emitted only when the event was newly persisted [src/api/v1/maintenance.ts:2925]
- [x] [Review][Patch] A blank `issuing_lab` returned `INVALID_PARAMS` from the handler but `INVALID_CALIBRATION_TYPE` from the seam; the handler now uses the contract code [src/api/v1/maintenance.ts:2759]

All six applied and verified: `npx tsc --noEmit`, `npx eslint` and `npx prettier --check` clean. Story 7.5 34/34, Story 1.9 spine 6/6, Stories 7.1-7.4 133/133 all pass; Story 1.7 shows only the documented pre-existing `regression guard: non-QC streams...` baseline failure (unchanged).

Dismissed (8): TIMESTAMPTZ columns returned as JS Date in the read projections (interface declares string, but JSON serialization and the seam's `as unknown as Date` workaround make it non-functional today); the job's hard-coded `calibration_scheduler`/`maintenance_manager` notification roles (per-spec Notification Contract, acknowledged zero-recipient limitation - note `calibration_scheduler` is NOT seeded in any SQL, only by the test harness); the `listInstrumentRecords` LEFT JOIN duplicate (contingent on case-variant rows, which the two patches above now prevent); the `certificates_evaluated` counter semantics (informational, not spec-defined); the `resolveCalibrationEscalationBase` default-certificate unlocked read (the seam re-validates under lock, so it is a lost-race rejection only); `valid_until == business_date` firing all three stages (per-spec catch-up); negative `limit`/`offset` silently clamped (safe, no 500).

### Group 3 - Integration Tests (2026-08-25)

Blind Hunter, Edge Case Hunter and Acceptance Auditor ran in parallel against the test suite after the Group 1-2 patches; all three returned findings, none failed. The parallel certificate race test defect was reported by both Edge Case Hunter and Acceptance Auditor (Task 8.6 violation).

Patches (resolved 2026-08-25):

- [x] [Review][Patch] The parallel certificate recording race test raced TWO DISTINCT certificate numbers, so it never exercised `uq_instrument_calibration_certificate_number` and passed vacuously on `[201, 201]` - contradicting Task 8.6's "one success and one stable 409 with the same existing_* detail"; it now races the SAME number and asserts `[201, 409]` + `CERTIFICATE_ALREADY_RECORDED` + `existing_certificate_id`, while keeping the exactly-one-active assertion [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] Added the missing asset-uniqueness concurrency test: parallel registration of the SAME asset resolves to one 201 and one `ASSET_ALREADY_INSTRUMENT` 409 with the same existing detail (Task 8.6: one concurrency test per new unique index) [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] The same-day re-run test now asserts the `domain_events` ledger did not grow for `maintenance.calibration_expiry_flagged` (the scan write route's replay/idempotency surface) [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] Added the `valid_until == business_date` boundary test: on the certificate's last valid day all three unfired stages fire (inclusive stage-due predicate) but the expiry flip does NOT run (strict `<`), the instrument stays `calibrated` and a QC result passes, with zero `maintenance.calibration_expired` events - pins the off-by-one that would otherwise hide [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] Added the two untested error-code branches: `calibration_type: 'vendor'` -> 400 `INVALID_CALIBRATION_TYPE`, and a malformed `valid_until: 'not-a-date'` -> 400 `INVALID_CERTIFICATE_VALIDITY` [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] Three direct-event forgery tests (forged expiry alert, forged expiry, reads-back) did not assert the prerequisite `recordCertificate` returned 201 before extracting `certificate_id`; they now fail loudly if recording fails instead of passing for the wrong reason [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] The RBAC test probed only ONE of five write routes with a read-only user (a dropped write wrapper on the other four would go unnoticed); it now probes all five (403) and asserts a user with NO maintenance role is denied the read surface [test/integration/story-7-5.test.ts]
- [x] [Review][Patch] The notification test now asserts the 14-day stage's `escalation_role` is null (only the 7-day stage carries the `maintenance_manager` escalation per the Notification Contract) [test/integration/story-7-5.test.ts]

All eight applied and verified: `npx tsc --noEmit`, `npx eslint` and `npx prettier --check` clean; Story 7.5 suite grown 34 -> 36 tests, all passing. Story 1.9 spine 6/6 and Stories 7.1-7.4 133/133 remain green; Story 1.7 shows only the documented pre-existing `regression guard: non-QC streams...` baseline failure.

Dismissed (5, all Low): missing `error_code` assertions on a few 400 status checks; the filtered-list test not verifying exclusion of non-matching rows; the reads-back test not cross-referencing `calibration_status` against the DB; read-surface filter/pagination assertions against known rows; input-boundary edge cases (interval lower bound/floats, empty bodies, blank idempotency key) - all minor, partially covered, or cosmetic.
