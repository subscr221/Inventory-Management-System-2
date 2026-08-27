---
baseline_commit: e93014f224de6e8b3e717fb599dba7f9d0761d15
---

# Story 7.7: AMC, Warranty, and Insurance Tracking

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a maintenance manager,
I want AMC, warranty, and insurance records against assets with staged expiry alerts and a warranty check at work-order creation that only a reason-coded override can bypass,
so that contract coverage never lapses unnoticed and warranty-covered repairs are never paid for by mistake.

## Acceptance Criteria

1. **Given** assets under AMC, warranty, or insurance (FR-M-10)
   **When** an expiry approaches
   **Then** alerts are raised at 90, 60, and 30 days before expiry

2. **Given** a breakdown work order is created for an asset under warranty (FR-M-11)
   **When** the work order is opened
   **Then** the system performs a warranty check and flags that the repair may be covered before chargeable work proceeds

3. **Given** a warranty-flagged work order (FR-M-11)
   **When** chargeable work is attempted without a recorded reason-coded override
   **Then** the work is blocked with `error_code: "APPROVAL_REQUIRED"` until an override with a reason code is recorded

4. **Given** a reason-coded override is recorded on a warranty-flagged work order (FR-M-11)
   **When** chargeable work then proceeds
   **Then** the override, its reason code, and the overriding actor are captured in the event stream

## Binding Scope Decisions

Table 1 records the decisions that fix the story's interpretation. Every one of them is binding for implementation and review.

**Table 1: Binding Scope Decisions**

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Chargeable work is defined as the completion of a warranty-flagged work order: any `maintenance.work_order_completed` event on a flagged work order requires a recorded reason-coded override, regardless of whether cost fields are present. | Completion is the single charge event in this codebase (the Story 7.6 cost arm posts labor_cost, parts_cost, total_cost only on `maintenance.work_order_completed`). "Chargeable work" is not defined anywhere in the PRD; blocking completion is the only enforceable, testable reading of AC 3, and a flagged order is closed only by a deliberate supervisor decision. |
| 2 | The warranty check applies to breakdown work orders only, exactly as AC 2 states. Preventive work orders (Story 7.2) are never checked or flagged. | AC 2 names the breakdown path. Story 7.3 reserved exactly this hook: "AMC and warranty checks at work-order creation belong to Story 7.7. Do NOT anticipate them." |
| 3 | The flag is DERIVED server-side in `applyBreakdownWorkOrderCreated` and written back onto the persisted payload; declared `warranty_flagged` or `warranty_coverage_id` values in the envelope are rejected with `WORK_ORDER_DERIVATION_MISMATCH` (the Story 7.6 derived-field rule for `total_cost` and `capitalization_flagged`). | A declared-but-unchecked field is a silent corruption channel on the direct-event path. Derived-only closes the forgery path by construction. |
| 4 | Active warranty at work-order creation means a coverage row with `coverage_type = 'warranty'` and `start_date` on or before, and `expiry_date` on or after, the payload `business_date`. When several qualify, the one with the latest `expiry_date` wins, tie-broken on the lowest `coverage_id`. The derivation is a plain SELECT (no lock), mirroring `getAssetById` usage in the same applier. | Deterministic and SQL-computable. The millisecond race where a concurrent coverage recording is missed is advisory-only risk (the flag says "may be covered") and mirrors the existing unlocked-asset-read pattern; a concurrent recording locks the asset row, never a coverage row this applier holds. |
| 5 | Coverage records are append-only with no amendment, void, or supersede path in Phase 1. A renewal is a NEW record (new row, fresh alert stages). | Projections are event-rebuildable derived state (AD-14); the Story 7.5 certificate precedent uses the same renewal shape. A void path is logged to deferred-work. |
| 6 | Fail-closed recording: a coverage whose `expiry_date` is before `business_date` rejects 422 `COVERAGE_ALREADY_EXPIRED`; a coverage whose `start_date` is after `business_date` rejects 422 `COVERAGE_FUTURE_START`. Impossible calendar dates (2026-02-30) reject 400 via the round-trip validity check. | The Story 7.5 `CERTIFICATE_EXPIRED` and Story 7.6 `EXAMINATION_ALREADY_OVERDUE` family: an already-lapsed contract serves neither lapse prevention nor a warranty check, and a future start would corrupt active-coverage derivation. |
| 7 | Alert stages are the module constant `COVERAGE_STAGES = [90, 60, 30]` (not configuration), the alert grain is one row per `(coverage_id, stage_days)`, catch-up is structural (the scan asks which stages are due AND unfired), a same-day re-run is a no-op, and a renewal earns a fresh set of stages on the new coverage_id. | FR-M-10 pins the exact numbers 90/60/30, so they are not deployment policy. This is the Story 7.5 Staged Alert Contract verbatim, with 30/14/7 replaced by 90/60/30. |
| 8 | Only the 30-day stage escalates: escalation target `maintenance_supervisor`, acknowledgment window 86400 seconds. The 90 and 60-day stages carry no escalation. Initial alert target is role `maintenance_manager` with `location_id: null`. | The Story 7.5 judgment: escalating a month-out reminder is noise, only the most-urgent stage carries an escalation clock. The asset register is company-wide (AD-9) and has no location column, so a location-scoped target would silently reach nobody outside the scan actor's site (the Story 7.6 Group B lesson: use `location_id: null` to reach every holder). The story persona is the maintenance manager; the access matrix names no alert recipient, so the persona receives and the override authority escalates. |
| 9 | Override authority resolves through the DOA registry (AD-3) with transaction_type `maintenance.warranty_override`, value 0. The acting user must BE the resolved approver (403 `APPROVAL_REQUIRED` otherwise); no governing DOA entry rejects 404 `APPROVAL_UNRESOLVED`. The access matrix grants "Warranty override (reason-coded)" to `maintenance_supervisor` as an approval hat, so that role is the seeded DOA role in tests. | Access matrix section 3.5 verbatim: the override is an "A" capability resolved via DOA, never a hard-coded role check. This mirrors the Story 7.6 return-to-service sign-off pattern exactly (`maintenance.return_to_service`). |
| 10 | The chargeable-work gate is enforced INSIDE `applyWorkOrderCompleted` under the work order's FOR UPDATE lock (plus a handler pre-check for a clean early 403), so the direct-event and edge-upload paths cannot bypass it (AD-12). | The same enforcement placement as the Story 7.6 statutory use-lock in `applyAssetOperationalStatusProjection`: a gate that reads per-row derived state lives in the seam under lock, not only in the HTTP handler. |
| 11 | One override per work order (unique `work_order_id`). A second override rejects 409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` with the existing override id. | A reason-coded override is a one-time decision; the unique index is the concurrency backstop with a 23505 resolver, mirroring every other maintenance grain. |
| 12 | No edge capture path, no PowerSync sync rules, no changes to `edge/` workspaces. Offline technician flows belong to Story 7.8. | Stories 7.5 and 7.6 were central-only for the same reason; enforcement lands in `persistEvent` so the future edge path inherits the gate. |
| 13 | Insurance claims administration is OUT of scope (PRD Non-Goal: "An insurance claim system: events, policy references, and write-offs are recorded; claims administered in ERP or manually"). AMC, warranty, and insurance rows share ONE coverage model, distinguished only by `coverage_type`. | FR-M-10/11 is a single combined requirement line in the PRD; the three coverage kinds differ only in business meaning, expiry semantics, and the fact that only WARRANTY drives the work-order check. One table, one alert job, one event family. |
| 14 | No reservation-time warranty prompt is added to the Story 7.4 spare flow. The FR-M-10/11 check is anchored to work-order creation by the epic and by the Story 7.4 deferral entry itself. | The deferred-work entry under Story 7.4 defers to "FR-M-10/11 warranty check at work-order creation", which this story delivers. Reservation-time prompting is not in any FR. |
| 15 | Notifications in this story use the decoupled `emitNotification` (AD-17 default). No `emitNotificationInTransaction` call is introduced: expiry alerts are status nudges, and the override event IS the durable record of the decision (ADR-001 classification, flagged for review). | ADR-001 reserves the transactional entry point for approval decisions and statutory communications whose loss would misrepresent the record. The override capture lives in domain_events by construction; a separate override notification would be a plain status nudge if added later. |

## Tasks / Subtasks

- [x] Task 1: Database schema (AC: 1, 2, 4)
  - [x] 1.1 Create `read/projections/asset_coverage.sql` (canonical): table `asset_coverage` with `coverage_id UUID PRIMARY KEY`, `asset_id UUID NOT NULL`, `coverage_type TEXT NOT NULL` (CHECK `chk_asset_coverage_type`: `'amc','warranty','insurance'`), `provider_name TEXT NOT NULL` (CHECK `chk_asset_coverage_provider_name`: `btrim(provider_name) <> ''`), `reference_number_ext TEXT NOT NULL` (CHECK `chk_asset_coverage_reference_ext`: `btrim(reference_number_ext) <> ''`), `start_date DATE NOT NULL`, `expiry_date DATE NOT NULL` (CHECK `chk_asset_coverage_dates`: `expiry_date > start_date`), `contract_value NUMERIC(14,3)` NULL (CHECK `chk_asset_coverage_value_non_negative`: `contract_value IS NULL OR contract_value >= 0`), `recorded_by UUID NOT NULL`, `recorded_at TIMESTAMPTZ NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Uniqueness is the case-insensitive reference grain as a UNIQUE INDEX (never a table-level UNIQUE on an expression, the Story 7.5 rule): `CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_coverage_reference ON asset_coverage (asset_id, coverage_type, lower(reference_number_ext));` plus `idx_asset_coverage_asset (asset_id)` and `idx_asset_coverage_expiry (expiry_date)`. Every constraint is inline AND re-guarded in `DO $$ ... pg_constraint ... conrelid = 'asset_coverage'::regclass` blocks; guarded `pg_roles` grants (`INSERT, SELECT, UPDATE` to `app_user`, `SELECT` to `readonly_user`); canonical-plus-mirror header comment; every statement safely re-appliable (the `read/projections/instrument_calibration_alert.sql` shape).
  - [x] 1.2 Create `read/projections/asset_coverage_alert.sql` (canonical): table `asset_coverage_alert` with `alert_id UUID PRIMARY KEY`, `coverage_id UUID NOT NULL`, `asset_id UUID NOT NULL`, `stage_days INTEGER NOT NULL` (CHECK `chk_asset_coverage_alert_stage`: `stage_days IN (90, 60, 30)`), `expiry_date DATE NOT NULL`, `business_date DATE NOT NULL`, `flagged_at TIMESTAMPTZ NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, table-level `CONSTRAINT uq_asset_coverage_alert_stage UNIQUE (coverage_id, stage_days)` (plain columns, so a constraint is correct here, mirroring `uq_instrument_calibration_alert_stage`), `idx_asset_coverage_alert_business_date (business_date)` and `idx_asset_coverage_alert_asset (asset_id)`, guarded DO blocks, guarded grants. Header explains the grain: one alert per (coverage_id, stage_days), which makes a same-day re-run a no-op and a skipped day catch up.
  - [x] 1.3 Create `read/projections/maintenance_warranty_override.sql` (canonical): table `maintenance_warranty_override` with `override_id UUID PRIMARY KEY`, `work_order_id UUID NOT NULL` (`CONSTRAINT uq_maintenance_warranty_override_work_order UNIQUE (work_order_id)`), `warranty_coverage_id UUID NOT NULL`, `reason_code TEXT NOT NULL` (CHECK `chk_maintenance_warranty_override_reason`: `btrim(reason_code) <> ''`), `overridden_by UUID NOT NULL`, `overridden_at TIMESTAMPTZ NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `idx_maintenance_warranty_override_coverage (warranty_coverage_id)`, guarded DO blocks, guarded grants. Append-only: grants are `INSERT, SELECT` to `app_user` only (the `maintenance_reliability_metric` precedent), `SELECT` to `readonly_user`. No UPDATE grant: an override is never mutated.
  - [x] 1.4 Edit `read/projections/maintenance_work_order.sql` ADDITIVELY: append a Story 7.7 comment block plus two guarded `DO $$` ADD COLUMN blocks modeled byte-for-byte on the Story 7.6 cost arm (guard on `information_schema.columns` with `table_schema = current_schema()` AND `table_name = 'maintenance_work_order'`, the Story 7.6 Group A fix): `warranty_flagged BOOLEAN NOT NULL DEFAULT false` and `warranty_coverage_id UUID`. No existing column, constraint, or index is touched. No CHECK constraint is needed (a nullable UUID and a defaulted boolean are self-validating).
  - [x] 1.5 Mirror the three new files and the maintenance_work_order block VERBATIM into `deploy/compose/init-db.sql`, appended in the same order. init-db.sql is a CRLF file: normalize the appended blocks to CRLF so no mixed line endings appear (the pre-existing `gate_dwell_metric` failure is exactly this class). Do not rely on the schema-drift gate to catch drift: it checks named objects by name only and cannot detect an extra constraint in a CREATE body.
  - [x] 1.6 Register `../../read/projections/asset_coverage.sql`, `asset_coverage_alert.sql`, `maintenance_warranty_override.sql` at the TAIL of `MIGRATIONS` in `src/events/migrate.ts`, after `production_order.sql`, with a Story 7.7 comment block in the 7.5/7.6 style. Never reorder existing entries.
  - [x] 1.7 Add EXPECTED entries in `test/unit/schema-drift.test.ts` for all three new tables (every named constraint and index, the 7.6 `statutory_examination` entries as the shape model). If the suite asserts column sets for `maintenance_work_order`, extend that entry with the two new columns; run the suite to confirm.
  - [x] 1.8 Run `npm run db:migrate` TWICE (idempotence) and verify the new tables, constraints, and indexes exist live via `pg_constraint` / `pg_indexes`.

- [x] Task 2: Event contracts in `src/events/schema.ts` (AC: 1, 2, 4)
  - [x] 2.1 Append a `Story 7.7` block after the Story 7.6 block with payload interfaces and envelope types: `AssetCoverageRecordedPayload` (`coverage_id`, `asset_id`, `coverage_type: 'amc' | 'warranty' | 'insurance'`, `provider_name`, `reference_number_ext`, `start_date`, `expiry_date`, `contract_value: string | null`, `recorded_by`, `recorded_at`, `business_date`) plus `AssetCoverageRecordedEnvelope = Omit<EventEnvelope, 'payload'> & { payload: AssetCoverageRecordedPayload }`; `CoverageExpiryFlaggedPayload` (`alert_id`, `coverage_id`, `asset_id`, `coverage_type`, `stage_days: 90 | 60 | 30`, `expiry_date`, `business_date`, `flagged_at`) plus envelope; `WarrantyOverrideRecordedPayload` (`override_id`, `work_order_id`, `warranty_coverage_id`, `reason_code`, `overridden_by`, `overridden_at`) plus envelope.
  - [x] 2.2 Extend the `BreakdownWorkOrderCreatedPayload` interface additively with the server-written fields `warranty_flagged?: boolean` and `warranty_coverage_id?: string | null`, documented as seam-derived write-back (never client-supplied). No other existing payload type changes; `maintenance.work_order_completed` is untouched (the gate reads projection rows, not the payload).
  - [x] 2.3 Register in `SUPPORTED_EVENT_TYPES` at the tail of the maintenance block: `maintenance.coverage_recorded`, `maintenance.coverage_expiry_flagged`, `maintenance.warranty_override_recorded`, each `{ streamType: 'maintenance', requiresBusinessStream: false }` with a Story 7.7 comment (maintenance operational state moves no stock, the asset.registered precedent).

- [x] Task 3: Read projections and accessors (AC: 1, 2, 3)
  - [x] 3.1 Create `src/read/projections/asset_coverage.ts`: `CoverageRow` interface (DATE and NUMERIC rendered as strings), `COVERAGE_COLUMNS` (`to_char(start_date, 'YYYY-MM-DD') AS start_date`, `to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date`, `contract_value::text AS contract_value`); `insertCoverage(input, client)`; `getCoverageById(coverageId, client?, forUpdate?)`; `getCoverageByReference(assetId, coverageType, referenceLower, client?, forUpdate?)`; `getActiveWarrantyForAsset(assetId, businessDate, client?)` returning the active warranty with the latest `expiry_date` (tie: lowest `coverage_id`) or null, computed in SQL (`coverage_type = 'warranty' AND start_date <= $2::date AND expiry_date >= $2::date ORDER BY expiry_date DESC, coverage_id ASC LIMIT 1`); `listCoverages(filters { asset_id?, coverage_type?, status? }, paging, client?)` where status `'active'` means `start_date <= CURRENT business_date parameter AND expiry_date >= it` (pass business_date in; never read the server clock inside SQL); `listCoverageStagesDue(businessDate, stages, filters { asset_id? }, client?)` cloned from `listCertificateStagesDue` (src/read/projections/instrument_calibration_certificate.ts:245): `CROSS JOIN unnest($2::int[]) AS s(stage_days)`, `LEFT JOIN asset_coverage_alert a ON a.coverage_id = c.coverage_id AND a.stage_days = s.stage_days` with `a.alert_id IS NULL`, `(c.expiry_date - $1::date) <= s.stage_days AND c.expiry_date >= $1::date`, scope narrowed in SQL never a JS after-filter, `ORDER BY expiry_date ASC, stage_days ASC, coverage_id ASC`, and `days_remaining` computed as `(c.expiry_date - $1::date)::int`. UUID and calendar-date inputs validated and returning `[]` on bad input, exactly like the certificate twin.
  - [x] 3.2 Create `src/read/projections/asset_coverage_alert.ts`: `insertCoverageAlert(input, client)`, `getCoverageAlertForStage(coverageId, stageDays, client?)`, `listCoverageAlerts(filters { coverage_id?, asset_id?, stage_days? }, paging, client?)`.
  - [x] 3.3 Create `src/read/projections/maintenance_warranty_override.ts`: `insertWarrantyOverride(input, client)`, `getWarrantyOverrideByWorkOrder(workOrderId, client?, forUpdate?)`, `getWarrantyOverrideById(overrideId, client?)`.
  - [x] 3.4 Edit `src/read/projections/maintenance_work_order.ts`: add `warranty_flagged: boolean` and `warranty_coverage_id: string | null` to `MaintenanceWorkOrderRow`; add `warranty_flagged, warranty_coverage_id` to `WORK_ORDER_COLUMNS` (the Story 7.6 Group B lesson: a column with no read surface is write-only); extend `insertWorkOrder` input and INSERT statement with both fields. No other accessor changes; `getWorkOrderById` already carries the new columns through `WORK_ORDER_COLUMNS`.

- [x] Task 4: Compliance seams (AC: 1, 2, 3, 4)
  - [x] 4.1 Create `src/compliance/maintenance-coverage.ts` structurally mirroring `src/compliance/asset-operational-status.ts`: stream gate `maintenanceCoverageEventType` (returns null for non-maintenance streams); exported module constants `COVERAGE_STAGES = [90, 60, 30] as const`, `COVERAGE_TYPES`, `WARRANTY_OVERRIDE_DOA_TYPE = 'maintenance.warranty_override'`; the same `reject()` AppError helper and `alreadyPersisted` guard copied verbatim; PURE pre-transaction `assertMaintenanceCoverageShape(envelope)` switch with no DB access.
    - Shape rules for `maintenance.coverage_recorded`: every UUID strict; `envelope.stream_id` must equal payload `asset_id` (the 7.6 asset_status_changed precedent); `coverage_type` in the enum; `provider_name` and `reference_number_ext` non-empty after trim; `start_date`, `expiry_date`, `business_date` match `DATE_REGEX` AND survive the round-trip validity check (reject impossible dates like 2026-02-30 with 400, not an unmapped 22008 500); `expiry_date > start_date` by string comparison; `contract_value` null or a NUMERIC string matching the 3-decimal regex (reuse the `COST_NUMERIC_REGEX` shape: `^\d{1,11}(\.\d{1,3})?$` family, never a JS number); `recorded_by` a UUID; `recorded_at` an ISO-8601 timestamp with an EXPLICIT UTC offset (`ISO8601_TIMESTAMP_REGEX`, the Story 7.2 offset lesson).
    - Shape rules for `maintenance.coverage_expiry_flagged`: UUIDs, `stage_days` one of 90/60/30, `coverage_type` enum, DATE/TIMESTAMPTZ formats as above.
    - Shape rules for `maintenance.warranty_override_recorded`: UUIDs (`override_id`, `work_order_id`, `warranty_coverage_id`, `overridden_by`), `reason_code` non-empty string trimmed, at most 200 characters, `overridden_at` explicit-offset timestamp.
  - [x] 4.2 Implement `applyMaintenanceCoverageProjection(envelope, client)` switch:
    - `applyCoverageRecorded`: `alreadyPersisted` guard; Locking Contract step 1 `lockAssetById(asset_id, client)` (404 `ASSET_NOT_FOUND`); date gates against payload `business_date` (422 `COVERAGE_ALREADY_EXPIRED` when `expiry_date < business_date`, 422 `COVERAGE_FUTURE_START` when `start_date > business_date`); duplicate pre-check `getCoverageByReference(assetId, type, reference.trim().toLowerCase(), client, false)` under the asset lock (409 `DUPLICATE_COVERAGE` with `existing_coverage_id`); `recorded_by` derivation check against `envelope.metadata.actor.user_id` (409 `COVERAGE_DERIVATION_MISMATCH` on divergence) and write-back of the derived `recorded_by` onto the persisted payload; `insertCoverage`.
    - `applyCoverageExpiryFlagged`: `alreadyPersisted` guard; lock the coverage row `getCoverageById(coverage_id, client, true)` (404 `COVERAGE_NOT_FOUND`); re-read guard: coverage `expiry_date` still on or after payload `business_date` (a lapsed row rejects 422 `COVERAGE_ALREADY_EXPIRED`, same family); declared `asset_id`, `coverage_type`, `expiry_date` re-derived against the locked row (409 `COVERAGE_DERIVATION_MISMATCH`); alert-grain check `getCoverageAlertForStage` (409 `DUPLICATE_COVERAGE_ALERT` with the existing alert id when present); `insertCoverageAlert`.
    - `applyWarrantyOverrideRecorded`: `alreadyPersisted` guard; Locking Contract: work order row FOR UPDATE (`getWorkOrderById(workOrderId, client, true)`), then the override grain; 404 `WORK_ORDER_NOT_FOUND`; require `workOrder.warranty_flagged === true` (409 `WARRANTY_OVERRIDE_NOT_REQUIRED` with the work order id); require `workOrder.status !== 'completed'` (409 `WORK_ORDER_ALREADY_COMPLETED` with `completed_at`, reusing the existing code); declared `warranty_coverage_id` must equal `workOrder.warranty_coverage_id` (409 `COVERAGE_DERIVATION_MISMATCH`); `overridden_by` must equal `envelope.metadata.actor.user_id` (409 `COVERAGE_DERIVATION_MISMATCH`); `reason_code` (trimmed) must be a member of `config.maintenance.warrantyOverrideReasonCodes` (422 `WARRANTY_OVERRIDE_REASON_INVALID` listing the allowed codes); DOA re-derivation under lock via `resolveApprover(WARRANTY_OVERRIDE_DOA_TYPE, 0)`: no governing entry rejects 404 `APPROVAL_UNRESOLVED`, a null declared `overridden_by` rejects 403 `APPROVAL_REQUIRED`, a declared actor who is not the resolved approver rejects 403 `APPROVAL_REQUIRED` (corrected by code review 2026-08-27: this clause originally read 409 `COVERAGE_DERIVATION_MISMATCH`, contradicting Task 5.2 and Table 4. `overridden_by` is separately re-derived against the envelope actor immediately above, so this branch can only fire for an actor who IS the declared user but is NOT the approver, which is an authority failure, not a derivation failure); grain check `getWarrantyOverrideByWorkOrder` (409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` with `existing_override_id`); write derived `overridden_by` back onto the persisted payload; `insertWarrantyOverride`.
  - [x] 4.3 Edit `src/compliance/maintenance-fault.ts` `applyBreakdownWorkOrderCreated`: after the SLA derivation block (step 4) and before `insertWorkOrder` (step 5), reject any DECLARED `warranty_flagged` or `warranty_coverage_id` in the payload with `WORK_ORDER_DERIVATION_MISMATCH` and the message "warranty_flagged is derived and cannot be declared" (the Story 7.6 derived-field rule), then derive via `getActiveWarrantyForAsset(report.asset_id, p['business_date'] as string, client)`; set `p['warranty_flagged']` to `Boolean(derived)` and `p['warranty_coverage_id']` to the derived coverage id or null; pass both into `insertWorkOrder`. The derivation is a plain SELECT placed AFTER the SLA policy lock; it introduces no new lock type, so the existing fault report to SLA policy to work order to downtime lock order is preserved and no deadlock class is added.
  - [x] 4.4 Edit `src/compliance/maintenance-plan.ts` `applyWorkOrderCompleted`: after the locked work order checks (`WORK_ORDER_NOT_FOUND`, asset correspondence, `WORK_ORDER_ALREADY_COMPLETED`) and BEFORE `setWorkOrderCompleted`, add the chargeable-work gate: when `workOrder.warranty_flagged === true`, read `getWarrantyOverrideByWorkOrder(workOrderId, client)` and reject 403 `APPROVAL_REQUIRED` with message "This work order is warranty-flagged: record a reason-coded override before completing it" and details `{ work_order_id, warranty_coverage_id: workOrder.warranty_coverage_id }` when no override exists. The override read is a plain SELECT under the already-held work order lock; the lock order (asset, weighbridge examination, work order) is unchanged. Extend the story banner comment to cite Story 7.7. ALSO add the matching handler pre-check in `completeWorkOrderBase` (src/api/v1/maintenance.ts): read the work order (already fetched) and, when `warranty_flagged` is true, read the override row and throw the SAME 403 `APPROVAL_REQUIRED` with the same details before `persistEvent`, exactly as `setAssetStatusBase` pre-checks the statutory use-lock (the seam remains the authoritative gate for the direct-event path).
  - [x] 4.5 Wire into `src/events/store.ts`: import the shape assert and applier; call `assertMaintenanceCoverageShape(envelope)` in the pre-transaction assert block immediately after `assertAssetStatusChangedShape` with a Story 7.7 comment; call `applyMaintenanceCoverageProjection(envelope, client)` in the seam switch immediately after `applyAssetOperationalStatusProjection` with a Story 7.7 comment (projection plus domain_events insert commit or roll back together).
  - [x] 4.6 Extend the 23505 mapper in `src/events/store.ts`: `uq_asset_coverage_reference` resolves via exported `resolveCoverageDuplicateConflict(envelope.payload)` to 409 `DUPLICATE_COVERAGE` with `existing_coverage_id` (same detail as the sequential pre-check); `uq_asset_coverage_alert_stage` to 409 `DUPLICATE_COVERAGE_ALERT` via `resolveCoverageAlertDuplicateConflict`; `uq_maintenance_warranty_override_work_order` to 409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` via `resolveWarrantyOverrideDuplicateConflict`; add `asset_coverage_pkey`, `asset_coverage_alert_pkey`, `maintenance_warranty_override_pkey` to the pkey chain with per-table id fields (`coverage_id`, `alert_id`, `override_id`), never falling through to a wrong field (the Story 7.4 chain lesson). Export all three resolvers from `src/compliance/maintenance-coverage.ts` in the `resolveStatutoryExaminationDuplicateConflict` shape.
  - [x] 4.7 Write the Locking Contract comment at the top of `maintenance-coverage.ts`: coverage recording locks asset then reads coverage rows; expiry flagging locks the coverage row only; override recording locks the work order row then reads the override grain. The DOA registry read stays a plain SELECT (append-only configuration, the 7.6 precedent). Verify no AB-BA inversion against `applyBreakdownWorkOrderCreated` (fault report, asset read, SLA policy, coverage read), `applyWorkOrderCompleted` (asset, weighbridge examination, work order), and `runCoverageExpiryScan` (coverage row).

- [x] Task 5: Override authority (AC: 3, 4)
  - [x] 5.1 Export `WARRANTY_OVERRIDE_DOA_TYPE` from `src/compliance/maintenance-coverage.ts` and consume it from the handler (the `RETURN_TO_SERVICE_DOA_TYPE` export pattern: handler pre-check and seam enforcement must widen together).
  - [x] 5.2 In the override handler (Task 7.5), resolve `resolveApprover(WARRANTY_OVERRIDE_DOA_TYPE, 0)` BEFORE persisting: no governing entry rejects 404 `APPROVAL_UNRESOLVED`; a resolved approver who is not the acting user rejects 403 `APPROVAL_REQUIRED` with `resolved_approver_user_id` in details. Business-rule rejections are raised AFTER the RBAC wrapper, never inside it (the Story 7.6 Architecture Compliance note).
  - [x] 5.3 Integration tests seed the DOA entry through the Story 1.4 API (`POST /api/v1/doa-entries` with `transaction_type: 'maintenance.warranty_override'`, role `maintenance_supervisor`, a value band covering 0), mirroring the Story 7.6 harness seeding of `maintenance.return_to_service`. Production deployments create the entry through the same DOA API; nothing is hard-coded.
  - [x] 5.4 No role-name literals anywhere: `requireRole({ module: 'maintenance', functionScope: ... })` for RBAC, DOA for authority; `npm run lint` runs the `no-hardcoded-role-in-workflow` rule inside the spine gate.

- [x] Task 6: Coverage expiry scan job (AC: 1)
  - [x] 6.1 Create `src/maintenance/coverage-jobs.ts` cloned structurally from `src/maintenance/calibration-jobs.ts` (header comment included): `runCoverageExpiryScan(scope)` with scope `{ business_date, asset_id?, actor, auditCtx? }` and result `{ business_date, coverages_evaluated, alerts_raised, notifications_delivered, notifications_dropped, notifications_suppressed, alert_ids }` (`notifications_suppressed` is the Group B / D5 amendment: catch-up runs withhold all but the most urgent stage message per coverage and COUNT the withheld ones, so delivered + dropped + suppressed reconciles with alerts_raised). Per coverage-stage row: own transaction via the same `inTransaction` shape; lock the coverage row FOR UPDATE and skip when it vanished or its `expiry_date` moved (renewal race); alert-grain existence check skips; persist `maintenance.coverage_expiry_flagged` with `stream_id: alertId` through `persistEvent` on the SAME client; catch `DUPLICATE_COVERAGE_ALERT` and continue (one lost race never fails the whole scan); after commit emit the notification and count delivered vs dropped SEPARATELY.
  - [x] 6.2 Notification emission per alert: `emitNotification({ target: { role: 'maintenance_manager', location_id: null }, event_type: 'coverage_expiry_due', status_verb: 'Due', object_type: 'asset_coverage', object_id: alertId, actor_label: '<asset name> (<asset tag>), <coverage_type> <reference_number_ext>, <days_remaining> days remaining', next_step: 'Renew the contract or record a new coverage', actor: scope.actor, correlation_id, occurred_at: flaggedAt })`, with `escalation: { target_role: 'maintenance_supervisor', acknowledgment_window_seconds: 86400 }` ONLY when `stage_days === 30`. Resolve the asset via `getAssetById` for the human-readable label; never a raw id. `location_id: null` targets every holder of the role (company-wide asset register, AD-9).
  - [x] 6.3 Scheduling discipline: NO `setInterval`, NO `node-cron`, NO new container. The only timer in the process remains the Story 1.11 notification dispatcher; this job runs solely via the authenticated POST trigger with an explicit `business_date`.

- [x] Task 7: REST surface (AC: 1, 2, 3, 4)
  - [x] 7.1 Add handlers in `src/api/v1/maintenance.ts` (Story 7.7 block at the tail, mirroring the Story 7.6 block), reusing `idempotencyKeyFrom`, `replayIdOrReject`, `requireBusinessDate`, `auditCtxFor`, `actorContext`, `sendAppError` from that same file (NEVER re-implement them):
    - `recordCoverageBase`: POST, param `:assetId`; 404 `ASSET_NOT_FOUND` pre-check; body fields validated exactly as the shape assert (coverage_type enum, trimmed non-empty provider_name and reference_number_ext, dates via `isValidCalendarDate`, expiry after start, contract_value optional NUMERIC string via the cost regex family, business_date via `requireBusinessDate`); `persistEvent` with `stream_id: assetId`, `event_type: 'maintenance.coverage_recorded'`, `idempotency_key: idempotencyKeyFrom(body)`; `replayIdOrReject(persisted, 'maintenance.coverage_recorded', 'coverage_id')`; read back BY ID; 201 `{ event_id, coverage }`.
    - `listAssetCoveragesBase`: GET `:assetId` scoped list with optional `coverage_type`, `status` (`active` resolves against a `business_date` from `requireBusinessDate`... default to the server's IST today via `toIstCalendarDate(new Date().toISOString())` from `src/lib/business-days.js` when absent), paging.
    - `listCoveragesBase`: GET with optional `asset_id`, `coverage_type`, `status`, `business_date` filters and paging.
    - `listCoverageAlertsBase`: GET with optional `coverage_id`, `asset_id`, `stage_days` filters and paging.
    - `scanCoveragesBase`: POST with `requireBusinessDate(body)` and optional `asset_id` UUID filter, delegating to `runCoverageExpiryScan` with the actor and `auditCtxFor(req, actor, 200)`; 200 returns the scan result (the `scanStatutoryExaminationsBase` shape at src/api/v1/maintenance.ts:3505).
    - `getCoverageBase`: GET `:coverageId`; 404 `COVERAGE_NOT_FOUND`.
    - `recordWarrantyOverrideBase`: POST `:workOrderId`; pre-checks in handler order: 404 `WORK_ORDER_NOT_FOUND`, 409 `WARRANTY_OVERRIDE_NOT_REQUIRED` when not flagged, 409 `WORK_ORDER_ALREADY_COMPLETED` when completed, 409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` when an override exists, DOA authority per Task 5.2 (404/403), 422 `WARRANTY_OVERRIDE_REASON_INVALID` for a reason outside `config.maintenance.warrantyOverrideReasonCodes`; then `persistEvent` (`stream_id: workOrderId`, `event_type: 'maintenance.warranty_override_recorded'`, payload carries the declared fields the seam re-derives: `override_id`, `work_order_id`, `warranty_coverage_id: workOrder.warranty_coverage_id`, `reason_code`, `overridden_by: actor.userId`, `overridden_at: now`); `replayIdOrReject(..., 'warranty_override_recorded', 'override_id')`; read back BY ID; 201 `{ event_id, override }`.
    - `getWarrantyOverrideBase`: GET `:workOrderId`; 200 `{ override: row | null }` (the `getAssetStatusHandler` shape).
  - [x] 7.2 Wrap every base handler: writes with `requireRole({ module: 'maintenance', functionScope: 'write' })`, reads with `functionScope: 'read'`. Register in `src/server.ts` `createAppRouter()` in a Story 7.7 comment block after the Story 7.6 routes, honoring static-before-parameter ordering: `GET /api/v1/maintenance/coverages`, `GET /api/v1/maintenance/coverages/alerts`, `POST /api/v1/maintenance/coverages/scan` all BEFORE `GET /api/v1/maintenance/coverages/:coverageId`. Full route set in Table 2.
  - [x] 7.3 Append all eight routes to `allowedSpineRoutes` in `test/integration/story-1-9.test.ts` (the gate asserts the exact production route surface; a missing entry fails Spine).
  - [x] 7.4 NO edge surface: `edge/src/sync/connector.ts`, `src/sync/upload.ts`, and `edge/src/messages/en.json` are untouched. Every new error code is module-local and not edge-reachable (the Story 7.1/7.5/7.6 precedent); enforcement reaches the future edge path through `persistEvent` (Binding Decision 12).

**Table 2: Route Contract**

| Method and Path | Handler | RBAC | Purpose |
| --- | --- | --- | --- |
| POST /api/v1/maintenance/assets/:assetId/coverages | recordCoverageHandler | maintenance write | Record an AMC, warranty, or insurance coverage (AC 1) |
| GET /api/v1/maintenance/assets/:assetId/coverages | listAssetCoveragesHandler | maintenance read | List coverages for one asset |
| GET /api/v1/maintenance/coverages | listCoveragesHandler | maintenance read | Cross-asset coverage list with filters |
| GET /api/v1/maintenance/coverages/alerts | listCoverageAlertsHandler | maintenance read | Staged expiry alert history |
| POST /api/v1/maintenance/coverages/scan | scanCoveragesHandler | maintenance write | POST-triggered 90/60/30 scan (AC 1) |
| GET /api/v1/maintenance/coverages/:coverageId | getCoverageHandler | maintenance read | One coverage by id |
| POST /api/v1/maintenance/work-orders/:workOrderId/warranty-overrides | recordWarrantyOverrideHandler | maintenance write | Reason-coded override (AC 3, 4) |
| GET /api/v1/maintenance/work-orders/:workOrderId/warranty-overrides | getWarrantyOverrideHandler | maintenance read | Override read surface |

- [x] Task 8: Integration tests, `test/integration/story-7-7.test.ts` (AC: 1, 2, 3, 4)
  - [x] 8.1 Bootstrap the harness by cloning `test/integration/story-7-6.test.ts` verbatim (makeRequest, authFor, provisionUser via the SCIM test bearer, dev-token flow, `createAppServer(createAppRouter()).listen(0)`, admin-pool re-application of the three new SQL files in `before()`, TRUNCATE teardown WITH CASCADE). Red-green: every test fails first.
  - [x] 8.2 AC 1 suite: record one AMC (90 days out), one warranty, one insurance; run scans at business_dates landing exactly at 90, 60, and 30 days remaining and assert exactly one alert row and one `notification.created` row per stage per coverage; catch-up test (skip intermediate days, next scan fires every unfired due stage most-urgent-first); same-business_date re-run is a no-op (zero new alerts, zero notifications); renewal test (a new coverage with a distinct reference earns fresh 90/60/30 stages while the first coverage's fired stages stay fired); an already-expired coverage is never alerted; the 30-day stage notification carries `escalation.target_role = 'maintenance_supervisor'` and window 86400 while 90/60 carry none; provision `maintenance_manager` and `maintenance_supervisor` role holders in the harness and assert fan-out resolves to a real user (a notification aimed at a role no user holds reports success to zero recipients: the Story 7.4 lesson); result counters expose delivered and dropped separately; direct double-flag of the same grain rejects 409 `DUPLICATE_COVERAGE_ALERT`.
  - [x] 8.3 AC 2 suite: active warranty recorded, fault reported and accepted, 201 body `work_order.warranty_flagged === true` with the winning `warranty_coverage_id`, and the persisted `domain_events` payload carries the written-back fields; no warranty yields `warranty_flagged === false` and null coverage id; expired warranty (expiry_date before business_date) is not flagged; two active warranties flag the latest-expiry one; a direct `persistEvent(... as any)` breakdown envelope DECLARING `warranty_flagged: false` while an active warranty exists rejects `WORK_ORDER_DERIVATION_MISMATCH`; a preventive work order generated through the Story 7.2 path is never flagged (regression); the acceptance notification for the flag (if emitted) never fires on replay.
  - [x] 8.4 AC 3 suite: completing a flagged work order without an override rejects 403 `APPROVAL_REQUIRED` through the HTTP route AND through a direct `persistEvent(... as any)` completion event (AD-12 proof: the seam, not the handler, is the gate); an unflagged breakdown work order and a preventive work order complete without any override (with and without the Story 7.6 cost fields, which must keep working unchanged); after an override is recorded, completion succeeds and the cost arm (total_cost derivation, capitalization_flagged) behaves exactly as Story 7.6 pinned it.
  - [x] 8.5 AC 4 suite: the resolved supervisor records an override (201, read-back by id, override row fields complete) and the persisted event payload captures `override_id`, `reason_code`, and the server-derived `overridden_by`; a non-approver rejects 403 `APPROVAL_REQUIRED`; deleting the DOA entry rejects 404 `APPROVAL_UNRESOLVED`; a reason outside the configured list rejects 422 `WARRANTY_OVERRIDE_REASON_INVALID`; an override on an unflagged work order rejects 409 `WARRANTY_OVERRIDE_NOT_REQUIRED`; a second override rejects 409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` with `existing_override_id`, identically on the sequential path and the concurrent race path (two parallel POSTs: exactly one 201, one 409 with the SAME detail shape); an override after completion rejects 409 `WORK_ORDER_ALREADY_COMPLETED`; a forged `overridden_by` via direct `persistEvent` rejects `COVERAGE_DERIVATION_MISMATCH`.
  - [x] 8.6 Coverage CRUD and platform suite: record returns 201 with the row read back BY ID (never "the newest row"); `DUPLICATE_COVERAGE` sequential and concurrent-race return the SAME code and `existing_coverage_id`; 422 `COVERAGE_ALREADY_EXPIRED` and `COVERAGE_FUTURE_START`; impossible date 2026-02-30 rejects 400; contract_value exactness (`'0.1'` + `'0.2'` style NUMERIC strings round-trip untouched, no JS float); provider_name and reference_number_ext persist trimmed with lower-cased uniqueness (record `"W-1"` then `"w-1"` for the same asset and type: 409); `ASSET_NOT_FOUND` for a foreign asset; RBAC 401 (no token) and 403 (wrong module); replay test per write route (same resource back, `domain_events` count unchanged); cross-event-type idempotency-key reuse rejects 409 `DUPLICATE_EVENT` with the existing event id and type; the scan route rejects a missing or malformed business_date 400 and an impossible business_date 400.
  - [x] 8.7 Regression requirement: `test/integration/story-7-2.test.ts` (PM generation and completion untouched), story-7-3 (fault flow and breakdown acceptance), story-7-4, story-7-5, story-7-6 (cost arm and status broadcast), story-1-7, story-1-9 (all six spine tests including Spine 4 calibration lockout), and stories 3-2/3-3/3-4 pass UNCHANGED. Do not weaken, skip, or delete any existing test to make a new one pass.

- [x] Task 9: Ledger and finishing (AC: all)
  - [x] 9.1 Append Story 7.7 entries to `_bmad-output/implementation-artifacts/deferred-work.md` under a `Story 7.7` heading: (a) no amendment/void/supersede path for coverages (renewal is a new record; a mistaken record persists until expiry); (b) no reservation-time warranty prompt (Binding Decision 14, the Story 7.4 deferral stands as written); (c) insurance claims administration out of scope (PRD Non-Goal); (d) no edge/offline capture (Story 7.8 owns it); (e) the accept-handler `business_date` is a UTC `slice(0,10)` (the pre-existing Story 7.3 behavior at src/api/v1/maintenance.ts:1368); the warranty derivation consistently consumes the payload business_date so the IST-vs-UTC near-midnight sliver is inherited unchanged, not introduced here; (f) re-affirm the inherited platform gaps exactly as logged under 7.5/7.6: maintenance.* on a mismatched stream_type skips every seam (a forged coverage or override could smuggle past on a non-maintenance stream), same-event-type idempotency reuse returns the original event, the alert-commit/notification crash window, `requireBusinessDate` validates calendar form only (a 2999-01-01 business_date on the record route is implausible-but-valid), unprovisioned notification roles fan out to zero recipients reporting success, and the notification dedup rides an unindexed `payload->>'object_id'` scan (same class as the 7.6 Group B deferral). Do NOT fix any of these in-story.
  - [x] 9.2 Run the full gate battery and record the exact counts in the Dev Agent Record: `npm run build`; `npx tsc --noEmit`; `npx eslint src/ test/`; `npm run format:check` (or prettier pass on touched files); `npm run db:migrate` twice; `test/unit/schema-drift.test.ts`; `npm run spine-acceptance-contract` (6/6); `npm test` full suite with the pre-existing baseline only (16 failures: the 15 documented Epic 1-3 idempotency-replay failures plus the 1 `gate_dwell_metric` CRLF artifact; the intermittent story-5-3 clock-window flake is the known conditional 17th; ZERO new failures is the bar); `npm run edge:test` unchanged 30/30; edge typecheck/lint/build unchanged; `git diff --check`.
  - [x] 9.3 Run `graphify update .` after the gates pass (AST-only, no API cost).

### Review Findings

Code review of Story 7.7, Group A (schema, events, projections, migrations), 2026-08-27.
Adversarial pass: Blind Hunter, Edge Case Hunter, Acceptance Auditor, over baseline
`e93014f` to HEAD `d46c348`. Groups B and C are reviewed separately.

- [x] [Review][Patch] Narrow `listCoverageStagesDue` to the current coverage per asset and coverage type - resolved D1 to option 1: reuse the single-winner rule `getActiveWarrantyForAsset` already applies (`ORDER BY expiry_date DESC, coverage_id ASC LIMIT 1`) so AC 1 and AC 2 agree on which row is current, no schema change and no Binding Decision 5 amendment. Correct the docblock in the same patch [src/read/projections/asset_coverage.ts:246-286]
- [x] [Review][Patch] Backfill `warranty_flagged` and `warranty_coverage_id` for breakdown work orders open at migration time - resolved D2 to option 1: a one-shot guarded `UPDATE ... FROM asset_coverage` block in the canonical SQL, deriving with the same single-winner rule as D1, mirrored into init-db.sql. Sequence after D1 [read/projections/maintenance_work_order.sql:236-263]
- [x] [Review][Patch] Drop the UPDATE grant from `asset_coverage` and `asset_coverage_alert` - resolved D3 to option 1: dead privilege that contradicts Binding Decision 5 and falsifies the ledger claim that a coverage can only be corrected by direct SQL. Update the drift pin and the init-db mirror with it [read/projections/asset_coverage.sql:112, read/projections/asset_coverage_alert.sql:64]
- [x] [Review][Defer] Replaying a pre-7.7 breakdown payload re-derives the warranty flag against today's register [src/events/schema.ts:2288-2297, src/read/projections/maintenance_work_order.ts:162-163] - deferred, resolved D4 to option 3: real replay non-determinism, but the correct fix makes persisted payloads carry derived values, which changes the declared-field contract Binding Decision 3 pins and Group B enforces across 39 tests
- [x] [Review][Patch] Separate the alert grain from the notification in the coverage scan - resolved D5 to option 1 modified: write every due and unfired grain row so catch-up stays structural, but emit only the most urgent stage notification per coverage per run. The alert table is a ledger, the notification is a message. Touches Group B `runCoverageExpiryScan` [src/maintenance/coverage-jobs.ts, src/read/projections/asset_coverage.ts:262-267]
- [x] [Review][Patch] Add the `warranty_flagged` / `warranty_coverage_id` pairing CHECK - resolved D6 to option 1: one guarded constraint, matching `chk_production_order_expediting_pairing` which Story 6.1 landed in the same migration batch, closing the direct-SQL `(true, null)` row that can never be completed [read/projections/maintenance_work_order.sql:236-262]
- [x] [Review][Patch] `listBreakdownWorkOrdersInPeriod` returns rows that lie about their own type [src/read/projections/maintenance_work_order.ts:336-355]
- [x] [Review][Patch] Schema drift pins `uq_asset_coverage_reference` by bare name substring, never by index body [test/unit/schema-drift.test.ts:1174,1565-1567]
- [x] [Review][Patch] `listCoverageStagesDue` accepts stages the alert CHECK rejects and does not dedupe the stage list [src/read/projections/asset_coverage.ts:259]
- [x] [Review][Patch] `listCoverageAlerts` orders by an instant that is identical across a catch-up batch [src/read/projections/asset_coverage_alert.ts:136]
- [x] [Review][Patch] `insertCoverage` and `insertCoverageAlert` cast raw strings to `::date` with no calendar validation [src/read/projections/asset_coverage.ts:84, src/read/projections/asset_coverage_alert.ts:52]
- [x] [Review][Patch] Empty-string filters are treated as absent while other invalid values return an empty list [src/read/projections/asset_coverage.ts:192,197,202, src/read/projections/asset_coverage_alert.ts:111,116]
- [x] [Review][Patch] The migration list justifies its ordering with a false invariant about foreign keys [src/events/migrate.ts:127,142]
- [x] [Review][Defer] `coverage_type` is declared on the alert payload but has no column to land in [read/projections/asset_coverage_alert.sql:21-32] - deferred, pre-existing
- [x] [Review][Defer] `asset_coverage.updated_at` is a dead column with no writer [read/projections/asset_coverage.sql:37] - deferred, pre-existing
- [x] [Review][Defer] Contract references are matched case-folded but not trim-folded [read/projections/asset_coverage.sql:45] - deferred, pre-existing
- [x] [Review][Defer] `lower()` is collation-dependent and no collation or locale is pinned [read/projections/asset_coverage.sql:30,45] - deferred, pre-existing
- [x] [Review][Defer] `reference_number_ext` is unbounded TEXT under a B-tree expression index [read/projections/asset_coverage.sql:30,45] - deferred, pre-existing
- [x] [Review][Defer] Stages still unfired when a coverage lapses are lost with no closing record [src/read/projections/asset_coverage.ts:265] - deferred, pre-existing
- [x] [Review][Defer] `asset_coverage_alert` denormalises asset and expiry with no foreign key and no consistency guard [read/projections/asset_coverage_alert.sql:26-27] - deferred, pre-existing
- [x] [Review][Defer] `maintenance_warranty_override.warranty_coverage_id` has no foreign key, so a replay can orphan it [read/projections/maintenance_warranty_override.sql:25,35] - deferred, pre-existing
- [x] [Review][Defer] `chk_asset_coverage_dates` is strictly greater, so a one-day cover note cannot be recorded [read/projections/asset_coverage.sql:41] - deferred, pre-existing
- [x] [Review][Defer] `business_date` and `flagged_at` on an alert row are unconstrained relative to each other [read/projections/asset_coverage_alert.sql:26-28] - deferred, pre-existing
- [x] [Review][Defer] The schema-drift suite is left red by the pre-existing `gate_dwell_metric` CRLF failure [test/unit/schema-drift.test.ts:1598] - deferred, pre-existing


Group A patches applied 2026-08-27. Gates after the patch pass: `tsc --noEmit` exit 0, eslint
clean at `--max-warnings=0`, prettier clean on every touched file, `db:migrate` run twice and
idempotent, schema-drift 109 (108 pass, 1 pre-existing `gate_dwell_metric` CRLF), story-7-7 41/41
(three new AC 1 cases pinning review decisions D1 and D5), story-6-1 and story-7-2 through 7-6
240/240 unchanged, full suite 1217 (1201 pass, 16 fail: the documented pre-existing 15 idempotency
plus `gate_dwell_metric`, 0 new; the baseline set was 17).

Groups B (seam, jobs, API, wiring) and C (integration tests) are NOT yet reviewed. Review decision
D5 reached into Group B `runCoverageExpiryScan` because the fix lives there, so that file is
already patched when its own review runs.

### Review Findings: Group B

Code review of Story 7.7, Group B (compliance seam, scan job, REST surface, event-store wiring,
config), 2026-08-27. Adversarial pass: Blind Hunter, Edge Case Hunter, Acceptance Auditor, over
baseline `e93014f` against the working tree already carrying the Group A patches. 41 raw findings
deduped to 30.

- [x] [Review][Decision] RESOLVED to option 1 (revert): the current-coverage narrowing was removed and `listCoverageStagesDue` scans every in-force coverage again. No data-only rule separates a renewal from a second live contract (both carry a fresh reference number), so the renewal double-alert is logged in deferred-work rather than papered over. The Group A test that asserted the dropped alerts as correct is replaced by one pinning the revert. [src/read/projections/asset_coverage.ts, test/integration/story-7-7.test.ts]
- [x] [Review][Decision] RESOLVED to option 1: the three MUTABLE handler pre-checks (`WORK_ORDER_ALREADY_COMPLETED`, `APPROVAL_UNRESOLVED`, `APPROVAL_REQUIRED`) were removed and now live only in the seam, which re-evaluates them under the work-order lock after the alreadyPersisted guard and raises identical codes, messages and details. `WARRANTY_OVERRIDE_NOT_REQUIRED` and the reason-code check were deliberately KEPT: `warranty_flagged` never mutates after work-order creation and the allowed codes are load-time config, so neither answer can change under a legitimate replay. [src/api/v1/maintenance.ts]
- [x] [Review][Patch] `applyCoverageExpiryFlagged` never re-derives stage due-ness, so a forged event burns an alert stage the genuine scan then skips forever [src/compliance/maintenance-coverage.ts:416-449]
- [x] [Review][Patch] `coverages_evaluated` counts due stage rows, not coverages, inflating by up to 3x [src/maintenance/coverage-jobs.ts:229]
- [x] [Review][Patch] D5 suppression increments no counter, so a healthy run and a run that lost two notifications report identically [src/maintenance/coverage-jobs.ts:196-197,225-232]
- [x] [Review][Patch] `getAssetById` is awaited outside the try, so a transient failure 500s a run whose alert rows already committed and are never reported in `alert_ids` [src/maintenance/coverage-jobs.ts:180-199]
- [x] [Review][Patch] The scan tolerates only `DUPLICATE_COVERAGE_ALERT`, so three other codes its own applier raises abort the whole run mid-loop [src/maintenance/coverage-jobs.ts:189]
- [x] [Review][Patch] The SQLSTATE 22003 mapping is ungated by event family, so a coverage `contract_value` overflow returns `COST_VALUE_OUT_OF_RANGE` with a null `work_order_id` [src/events/store.ts:1639-1660]
- [x] [Review][Patch] `assertCoverageExpiryFlaggedShape` pins no `stream_id` binding, unlike both siblings, so an alert can be filed onto any aggregate's stream [src/compliance/maintenance-coverage.ts:188-215]
- [x] [Review][Patch] The record-coverage handler enforces no length bound, so one route answers two failures of the same field with two different error codes, and the seam measures the untrimmed value [src/api/v1/maintenance.ts:3897-3904, src/compliance/maintenance-coverage.ts:139-155]
- [x] [Review][Patch] `GET /work-orders/:workOrderId/warranty-overrides` returns 200 with a null body for a work order that does not exist [src/api/v1/maintenance.ts:4290-4298]
- [x] [Review][Patch] The declared-warranty rejection always names `warranty_flagged` even when only `warranty_coverage_id` was declared [src/compliance/maintenance-fault.ts:585-596]
- [x] [Review][Patch] `warrantyOverrideReasonCodes` silently substitutes the permissive defaults for a whitespace-only env value, and validates no per-entry length or character class [src/config/index.ts:321-336]
- [x] [Review][Patch] The alerts-list `stage_days` param is digits-only, so a huge value 500s from PostgreSQL 22003 instead of 400ing; the Story 7.5 twin pins its stage set [src/api/v1/maintenance.ts:4102-4113]
- [x] [Review][Patch] Task 4.2 of this spec pins 409 `COVERAGE_DERIVATION_MISMATCH` for a non-approver override while Task 5.2 and Table 4 pin 403 `APPROVAL_REQUIRED`; the code follows Table 4, which is the correct reading, so the task wording is what needs correcting [spec Task 4.2]
- [x] [Review][Defer] A nested pool checkout happens while a row lock is held, so the pool can deadlock against itself [src/compliance/maintenance-coverage.ts:544, src/events/store.ts:440-446] - deferred, pre-existing
- [x] [Review][Defer] Preventive and scheduled work orders are never warranty-checked, so chargeable work on an in-warranty asset bypasses the AC 3 gate [src/compliance/maintenance-plan.ts:535,665] - deferred, pre-existing
- [x] [Review][Defer] `applyWorkOrderCompleted` takes the weighbridge examination lock before it reaches the AC 3 gate, so a doomed completion still serializes against re-stamping [src/compliance/maintenance-plan.ts:620-626,665-677] - deferred, pre-existing
- [x] [Review][Defer] D5's one-message-per-coverage property is per-run only, so two concurrent scans both notify one contract and the second carries no escalation [src/maintenance/coverage-jobs.ts:189,196-197] - deferred, pre-existing
- [x] [Review][Defer] `INVALID_PAYLOAD` is raised by all three shape asserts but appears nowhere in the story's Error Code Contract [src/compliance/maintenance-coverage.ts:135-282] - deferred, pre-existing
- [x] [Review][Defer] `business_date` on the cross-asset coverage list is silently ignored and unvalidated unless `status` is also supplied [src/api/v1/maintenance.ts:3979-4005] - deferred, pre-existing
- [x] [Review][Defer] The IST default business date is never echoed, so a near-midnight response cannot be interpreted [src/api/v1/maintenance.ts:4004,4040-4046] - deferred, pre-existing
- [x] [Review][Defer] The reason-code allow-list is case and whitespace exact while the contract reference in the same module is case-folded [src/config/index.ts:326-335, src/compliance/maintenance-coverage.ts:103] - deferred, pre-existing
- [x] [Review][Defer] The handler and the seam validate DOA authority and reason code in opposite order, so one input yields 403 through REST and 422 through the direct event path [src/api/v1/maintenance.ts:4218-4253, src/compliance/maintenance-coverage.ts:532-563] - deferred, pre-existing
- [x] [Review][Defer] The completion handler runs the warranty gate before any already-completed check, so it can shadow `WORK_ORDER_ALREADY_COMPLETED` (not reachable through the API today) [src/api/v1/maintenance.ts:920-933] - deferred, pre-existing


### Review Findings: Group C

Code review of Story 7.7, Group C (the integration suite `test/integration/story-7-7.test.ts`
itself, per the regenerated `_bmad-output/diff-7-7-group-c.patch`), 2026-08-27. Adversarial
pass: Blind Hunter, Edge Case Hunter, Acceptance Auditor, over the committed tree at `a6abe60`
(Groups A and B applied and verified: story 42/42, full suite 1202/1218 with only the 16
pre-existing failures). 44 raw findings deduped to 31. Full reports:
`code-review-7-7-c-blind-hunter.md`, `code-review-7-7-c-edge-case-hunter.md`,
`code-review-7-7-c-acceptance-auditor.md`. Line references are test-file lines at review time.

Outcome (2026-08-27): both decisions resolved by the user (option 2 re-word and defer; option 1
amend the spec), all 19 patches applied (12 new tests, suite 42 grows to 54), 9 deferred to the
ledger, 1 dismissed. Verified after patching: prettier, eslint `--max-warnings=0` and
`tsc --noEmit` all clean; story-7-7 54/54; 7-2 through 7-6 plus 6-1 regressions 240/240; full
suite 1214/1230 with exactly the 16 known pre-existing failures (15 idempotency, 1 gate_dwell
CRLF) and zero new. Review closed; story status set to done.

- [x] [Review][Decision] RESOLVED to option 2 (re-word and defer): the preventive-work-order test keeps its raw-SQL fixture and now claims only what it proves - the `warranty_flagged` column `DEFAULT false` and that an unflagged preventive order completes without an override. The unexercised Story 7.2 seam path is logged in deferred-work alongside the Group B "preventive orders are never warranty-checked" entry. [test/integration/story-7-7.test.ts]
- [x] [Review][Decision] RESOLVED to option 1 (amend the spec): the code is the Group-B-approved behavior. Table 4's `COVERAGE_DERIVATION_MISMATCH` row now lists stage due-ness among the divergence causes, and Task 6.1's scan result shape now includes `notifications_suppressed` with the D5 reconciliation rule (delivered + dropped + suppressed reconciles with alerts_raised). Tests unchanged. [spec Table 4, Task 6.1]
- [x] [Review][Patch] HIGH: the WORK_ORDER_ALREADY_COMPLETED test accepts either of two codes and its fixture contradicts its comment (no second work order exists), so deleting the completed-status seam check stays green; pin the exact code (the seam checks completed status before duplicate override) and cover WARRANTY_OVERRIDE_ALREADY_RECORDED with its own second-order case [test/integration/story-7-7.test.ts:1364-1386]
- [x] [Review][Patch] HIGH: no successful scan ever omits `asset_id`, so the unfiltered query shape the nightly job actually runs is untested; add an unfiltered-scan success test isolated by a unique far-window anchor date [test/integration/story-7-7.test.ts:616-908]
- [x] [Review][Patch] HIGH: `WORK_ORDER_NOT_FOUND` appears in zero tests despite the Table 4 every-code rule, and the Group B change of the override GET from 200-null to 404 is unpinned; add override POST and GET against an unknown work-order UUID plus non-UUID path-param 400s [src/api/v1/maintenance.ts:4206-4211,4293-4298]
- [x] [Review][Patch] No forgery test declares `warranty_coverage_id` on the breakdown path (the branch whose rejection message Group B specifically fixed); only `warranty_flagged` is declared [test/integration/story-7-7.test.ts:1073-1075]
- [x] [Review][Patch] The cross-event-type idempotency test asserts only `existing_event_id`; the response also carries `existing_event_type` (Task 8.6 pins both) [test/integration/story-7-7.test.ts:1669-1675]
- [x] [Review][Patch] Race-path losers assert the existing-id detail is truthy but never that it equals the winner's id, so a resolver returning a wrong row's id passes [test/integration/story-7-7.test.ts:1356,1566]
- [x] [Review][Patch] The APPROVAL_UNRESOLVED test works only because it is declared before any sibling seeds the DOA entry - order-coupled, misfiled under the AC2 banner, and the helper comment says "above" while the test sits below; delete the DOA rows explicitly at test start and refile [test/integration/story-7-7.test.ts:441,1084-1108]
- [x] [Review][Patch] Expiry-day boundaries unpinned: no scan at `business_date == expiry_date` (last-day alert vs already-expired), no breakdown warranty check with a warranty starting or expiring today, no 201 for a coverage recorded on its own start or expiry boundary [test/integration/story-7-7.test.ts:621-627,813-823,968-976,1575-1590]
- [x] [Review][Patch] No partial catch-up scan (for example day -45: stages 90 and 60 due, 30 not, `notifications_suppressed == 1`); only exact-stage and full three-stage runs exist [test/integration/story-7-7.test.ts:693-733]
- [x] [Review][Patch] The escalation test never counts per-stage notifications, and `notificationFor` orders by `event_id DESC` (a random UUID tiebreak), so a duplicated 90-day emission can pass or fail nondeterministically; assert exact per-stage counts [test/integration/story-7-7.test.ts:389-410,638-671]
- [x] [Review][Patch] RBAC sweep covers only coverage-record and scan; add 401/403 for GET coverage-by-id, GET alerts, GET and POST warranty-overrides, and a technician-invoked scan (the existing override 403 tests DOA resolution, not the module guard) [test/integration/story-7-7.test.ts:1740-1761]
- [x] [Review][Patch] The DUPLICATE_COVERAGE grain is never proven across assets: same reference and type on a different asset must be 201 [test/integration/story-7-7.test.ts:1549-1554]
- [x] [Review][Patch] Reason-code input edges untested: empty, whitespace-only, and over-length values 400 as INVALID_PARAMS before the 422 allow-list check, and the allow-list is case-exact; none is pinned [src/api/v1/maintenance.ts:4192-4203,4239]
- [x] [Review][Patch] Forged `coverage_expiry_flagged` branches untested: unknown coverage 404, flag against an expired coverage, declared vs derived `expiry_date` mismatch, `stream_id != alert_id`, and `stage_days` outside {90,60,30} [src/compliance/maintenance-coverage.ts:211-217,230-236,422,426,442-454]
- [x] [Review][Patch] The Task 8.4 cost matrix is half-covered: unflagged breakdown completes only with costs, preventive only without; add the two missing cells [test/integration/story-7-7.test.ts:1013-1014,1179-1188]
- [x] [Review][Patch] The equal-expiry warranty tie-break (lowest `coverage_id`, Binding Decision 4) never runs; the two-warranty test uses distinct expiries only [test/integration/story-7-7.test.ts:972-992]
- [x] [Review][Patch] Input-validation edges: zero-length coverage (`start == expiry`) rejection, `contract_value` regex boundaries (negative, four decimals, twelve integer digits, empty), and whitespace-only or over-length `provider_name` / `reference_number_ext` [src/api/v1/maintenance.ts:3903-3927]
- [x] [Review][Patch] List-filter branches: `status=future` and non-UUID `coverage_id` on the alerts list [src/api/v1/maintenance.ts:4005,4113-4114]
- [x] [Review][Patch] Test hygiene: the declared-`warranty_flagged` forgery test claims mismatch detection but the seam rejects on key presence alone (reword and trim the dead SLA reconstruction); `REASON_CODE[0]!` crashes with a bare TypeError on empty config; scan and override-read statuses unchecked at four sites; `escalation_window` hard-codes `'86400'` [test/integration/story-7-7.test.ts:134,647-649,664,718,789,1011-1082,1285]
- [x] [Review][Defer] Two parallel scans on one `business_date` (the race the row lock in `coverage-jobs.ts:158-168` serializes) are untested - the outcome split is nondeterministic and the sequential same-date re-run pins the grain; revisit if the lock changes [test/integration/story-7-7.test.ts:679-691] - deferred
- [x] [Review][Defer] `notifications_dropped > 0` (zero-recipient or emit-failure path) never fires - exercising it means tearing down role assignments the rest of the suite depends on [src/maintenance/coverage-jobs.ts:228-231] - deferred
- [x] [Review][Defer] Fan-out is asserted by role-assignment counts and scan counters, never by reading delivery rows - the dispatch surface is outside this story's scope [test/integration/story-7-7.test.ts:429-436,598-607] - deferred
- [x] [Review][Defer] Projection-only fixtures (`insertCoverageFixture`, `insertPreventiveWorkOrder`) create states no write path can reach, including a future-start warranty the API forbids - deliberate fixture strategy; revisit if replay re-derivation lands [test/integration/story-7-7.test.ts:223-246,293-303,965] - deferred
- [x] [Review][Defer] The renewal-overlap window (both rows raising stages before lapse) is dodged: the renewal test scans only where the original is already expired - already logged in deferred-work from Group B [test/integration/story-7-7.test.ts:781-806] - deferred, pre-existing
- [x] [Review][Defer] Same-key idempotent replay with a DIFFERENT body silently returns the original 201 - platform-wide semantics predating this story [test/integration/story-7-7.test.ts:1630-1655] - deferred, pre-existing
- [x] [Review][Defer] Capitalization at exactly the threshold (`>` vs `>=`) is unpinned - Story 7.6 surface [test/integration/story-7-7.test.ts:1183-1213] - deferred, pre-existing
- [x] [Review][Defer] `TODAY` is captured once at module load while handlers read the wall clock per request; a suite spanning UTC midnight shifts every fixture with no attributing assertion (acknowledged in the file comment) [test/integration/story-7-7.test.ts:25-28,132] - deferred, pre-existing
- [x] [Review][Defer] Gate persistence after warranty lapse (flagged order still 403 without override once the warranty expires) is only implied - testing it requires mutating projection rows mid-test, the same anti-pattern as the fixture defer [src/compliance/maintenance-coverage.ts:543] - deferred

### Session Handoff (2026-08-27, review paused)

Groups A and B of the code review are COMPLETE and every patch is applied to the working tree.
Nothing is committed. Group C (`test/integration/story-7-7.test.ts`, the integration suite itself)
has NOT been reviewed; its diff is already written to `_bmad-output/diff-7-7-group-c.patch`, though
it must be regenerated against the working tree because the file has since gained four tests.

Verification state at the pause:

- The last full green run was AFTER every source patch landed: `tsc --noEmit` exit 0, eslint clean
  at `--max-warnings=0`, prettier clean, story-7-7 41/41.
- Two test assertions were added AFTER that run and are UNVERIFIED: the forged not-yet-due stage
  test, and the `notifications_suppressed` / `coverages_evaluated` assertions in the catch-up test.
- The Docker Desktop Linux engine then began returning HTTP 500 on every API route, so PostgreSQL
  is unreachable and no integration test can run. This is an environment failure, not a code one:
  a bare `pg` client connect returns "timeout expired".

To resume: restart Docker Desktop, re-run `node --env-file=.env.test --import tsx --test
--test-concurrency=1 test/integration/story-7-7.test.ts`, then the 7-2 through 7-6 and 6-1
regressions and the full suite, then review Group C.

Two judgement calls made during the Group B patch pass that a later reader should know about:

1. The config reason-code length bound is 200, matching `MAX_REASON_CODE_LENGTH` in
   `src/compliance/maintenance-coverage.ts`. It is duplicated rather than imported because config
   loads before the seams; the two must be kept equal.
2. The SQLSTATE 22003 mapping in `src/events/store.ts` is now gated on a new
   `COST_BEARING_EVENT_TYPES` set holding only `maintenance.work_order_completed`. Any future event
   family that writes the NUMERIC(14,3) cost columns must be added to that set or its overflow will
   surface as an unmapped 500.

## Dev Notes

### Baseline and Working Tree State

- Baseline commit is `e93014f` ("7-5"), and the working tree currently carries the UNCOMMITTED Story 7.6 implementation (statutory examinations, cost accumulation, machine status broadcast: done) and Story 6.1 implementation (production orders: in review). Story 7.7 builds on top of the entire working tree as it stands. Do not commit, stash, revert, or modify any 7.6 or 6.1 file beyond the surgical 7.7 edits specified in the tasks (the shared files are `src/events/schema.ts`, `src/events/store.ts`, `src/events/migrate.ts`, `deploy/compose/init-db.sql`, `src/api/v1/maintenance.ts`, `src/server.ts`, `src/config/index.ts`, `read/projections/maintenance_work_order.sql`, `src/read/projections/maintenance_work_order.ts`, `test/integration/story-1-9.test.ts`, `test/unit/schema-drift.test.ts`).
- Current gate baseline at writing: schema-drift 103 pass / 1 fail (`gate_dwell_metric` CRLF), spine 6/6, edge 30/30, full suite 16 pre-existing failures. Your deltas: schema-drift grows by your three new tables (and work-order column entries if the suite tracks them); everything else stays green with ZERO new failures.

### Files Being Modified: Current State, Change, and What Must Be Preserved

Table 3 is the non-negotiable read-before-edit inventory. Every UPDATE file below was read during story creation; the current-state column is accurate at baseline `e93014f` plus the uncommitted 7.6/6.1 tree.

**Table 3: UPDATE File Inventory**

| File | Current state | What this story changes | What must be preserved |
| --- | --- | --- | --- |
| src/compliance/maintenance-fault.ts | Story 7.3 seam: sla_policy_defined, fault_reported, fault_rejected, breakdown_work_order_created (7 steps: fault-report lock, asset read, SLA policy lock, SLA derivation checks, work-order insert, downtime insert, fault accepted flip), downtime_closed; three 23505 resolvers | Warranty derivation inserted between the SLA derivation and the work-order insert (Task 4.3); `insertWorkOrder` call gains two fields | All 7 existing steps, the declared-field loop, the 2999 horizon check, every existing error code, the three resolvers, and byte-for-byte shape asserts |
| src/compliance/maintenance-plan.ts | Story 7.2 seam plus the Story 7.6 additive cost arm in `applyWorkOrderCompleted` (asset lock, weighbridge examination lock, work-order lock, cost derivation in SQL NUMERIC, `setWorkOrderCosts`, `upsertMaintenanceAssetCost`, weighbridge stamp invalidation) | One warranty gate block before `setWorkOrderCompleted` (Task 4.4) | The entire cost arm (total_cost and capitalization_flagged derivation and write-back), the weighbridge stamp flip, the sweep semantics, both resolvers |
| src/events/store.ts | `persistEvent` with the pre-transaction assert chain (tagging, calibration lockout, weighbridge stamp lockout, all shape asserts) and the in-transaction projection switch ending in `applyThreeWayMatchProjection`; 23505 mapper with Story 7.6 and 6.1 entries | One shape-assert call, one applier call, three constraint mappers, three pkey chain entries | Assert ORDER (tagging first, lockouts before shape asserts), every existing entry, the idempotency and version logic, the audit insert |
| src/events/schema.ts | Story blocks 7.1 through 7.6 plus 6.1 appended chronologically; `SUPPORTED_EVENT_TYPES` tail | Story 7.7 type block and three registrations; additive optional fields on `BreakdownWorkOrderCreatedPayload` | Every existing type; no rename or renumber |
| src/api/v1/maintenance.ts | 3829 lines; Story 7.6 block ends the file; helpers `idempotencyKeyFrom` (line 205), `replayIdOrReject` (217), `requireBusinessDate` (238) | Story 7.7 handler block appended; reuse helpers only | All existing handlers and their response shapes (the completeWorkOrder response shape is consumed by 7.6 tests) |
| src/server.ts | Story blocks in `createAppRouter`, Story 7.6 block at lines 716-727 | Story 7.7 route block after it | Static-before-parameter ordering everywhere; every existing route |
| src/config/index.ts | `maintenance` block with `spareReturnHolidayCalendar`, `spareReturnBusinessDays`, `capitalizationThreshold` (NUMERIC string, fail-closed IIFE) | Add `warrantyOverrideReasonCodes` (below) | Every existing knob and its fail-closed load behavior |
| read/projections/maintenance_work_order.sql | Canonical work-order register with 7.2 base, 7.3 breakdown arm, 7.6 cost arm (guarded DO blocks) | Two guarded ADD COLUMN blocks (Task 1.4) | Every existing column, constraint, index, and grant untouched |
| src/read/projections/maintenance_work_order.ts | Row type plus `WORK_ORDER_COLUMNS`; `insertWorkOrder`, getters, setters incl. `setWorkOrderCosts` | Two row fields, two column-list entries, `insertWorkOrder` extension | `getWorkOrderById`, `setWorkOrderCompleted`, `setWorkOrderOverdue`, all list/set accessors unchanged |
| test/integration/story-1-9.test.ts | Six spine tests plus `allowedSpineRoutes` allowlist (last maintenance entries at lines 452-458) | Append eight routes to the allowlist | All six spine tests byte-for-byte (Spine 4 calibration lockout included) |
| test/unit/schema-drift.test.ts | EXPECTED entries through Story 7.6 and 6.1 | Three new table entries | Every existing entry |
| src/events/migrate.ts | MIGRATIONS tail ends at `production_order.sql` | Three entries appended | Ordering of every existing migration |
| deploy/compose/init-db.sql | CRLF mirror of all canonical SQL | Verbatim mirror of the three new files plus the work-order blocks | CRLF line endings on every appended line |

### Config Addition

Add to the `maintenance` block in `src/config/index.ts`, modeled on `capitalizationThreshold` (fail-closed IIFE, throws at load on malformed input):

```ts
// Story 7.7 (FR-M-11): the reason codes a warranty override may cite. Commercial policy, not
// code: comma-separated, trimmed, unique, at least one entry. A malformed env value fails
// closed at load time (the capitalizationThreshold precedent).
warrantyOverrideReasonCodes: (() => {
  const raw = process.env['MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES'];
  const value =
    raw === undefined || raw.trim() === ''
      ? 'OUT_OF_WARRANTY_SCOPE,WARRANTY_NOT_APPLICABLE,PREVIOUS_UNAUTHORIZED_REPAIR,EMERGENCY_REPAIR'
      : raw;
  const codes = value.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (codes.length === 0 || new Set(codes).size !== codes.length) {
    throw new Error(
      `Invalid MAINTENANCE_WARRANTY_OVERRIDE_REASON_CODES "${raw}": must be a non-empty, duplicate-free, comma-separated list.`,
    );
  }
  return codes;
})(),
```

No other config knob is added: the 90/60/30 stages are pinned by FR-M-10 and live as `COVERAGE_STAGES` (Binding Decision 7).

### Error Code Contract

Table 4 lists every code this story introduces or reuses. Every code must appear in at least one test.

**Table 4: Error Code Contract**

| Code | HTTP | Raised by | Meaning |
| --- | --- | --- | --- |
| DUPLICATE_COVERAGE | 409 | seam pre-check and 23505 resolver | Same (asset_id, coverage_type, lower(reference_number_ext)) already recorded; details carry existing_coverage_id |
| COVERAGE_NOT_FOUND | 404 | get route, expiry-flag applier | coverage_id does not resolve |
| COVERAGE_ALREADY_EXPIRED | 422 | record applier, expiry-flag applier | expiry_date before business_date (fail-closed) |
| COVERAGE_FUTURE_START | 422 | record applier | start_date after business_date (fail-closed) |
| COVERAGE_DERIVATION_MISMATCH | 409 | all three appliers | Declared recorded_by, overridden_by, warranty_coverage_id, asset_id, coverage_type, or expiry_date diverges from the locked-row derivation; also a declared stage_days that is not yet due for the coverage on the business date (Group B amendment: stage due-ness is re-derived so a forged flag cannot burn the alert grain) |
| DUPLICATE_COVERAGE_ALERT | 409 | expiry-flag applier and 23505 resolver | Alert grain (coverage_id, stage_days) already fired; the scan skips it |
| WARRANTY_OVERRIDE_NOT_REQUIRED | 409 | override handler and applier | Work order is not warranty_flagged |
| WARRANTY_OVERRIDE_ALREADY_RECORDED | 409 | override applier and 23505 resolver | One override per work order; details carry existing_override_id |
| WARRANTY_OVERRIDE_REASON_INVALID | 422 | override handler and applier | reason_code not in config.maintenance.warrantyOverrideReasonCodes |
| APPROVAL_REQUIRED | 403 | completion gate (handler pre-check and seam), override authority | Spine stable code, already registered: flagged completion without override, or override by a non-approver |
| APPROVAL_UNRESOLVED | 404 | override handler and applier | No DOA entry governs maintenance.warranty_override |
| WORK_ORDER_NOT_FOUND | 404 | reused (Story 7.2) | work_order_id does not resolve |
| WORK_ORDER_ALREADY_COMPLETED | 409 | reused (Story 7.6) | Override or completion against a completed work order |
| ASSET_NOT_FOUND | 404 | reused (Story 7.1) | asset_id does not resolve |
| DUPLICATE_EVENT | 409 | reused (platform) | Cross-event-type idempotency-key reuse |
| INVALID_PARAMS | 400 | reused (platform) | Shape failures incl. impossible calendar dates |

All new codes are module-local: the architecture spine stable-code list is untouched, and `src/sync/upload.ts`, `edge/src/sync/connector.ts`, `edge/src/messages/en.json` are NOT modified (none is edge-reachable; the Story 7.1/7.5/7.6 precedent).

### Architecture Compliance (Must-Follow Guardrails)

- AD-12 (compliance spine): every mutation goes through `persistEvent`; the chargeable-work gate and the DOA re-derivation live in the seam so direct events and future edge uploads cannot bypass them. Shape asserts run PRE-transaction (a malformed event never consumes an idempotency key); appliers run IN the transaction behind `alreadyPersisted`.
- AD-14 (shared projections): all new tables are derived state rebuilt by replay; mutation only through appliers in the same transaction as the domain_events insert; jobs read committed projections and write ONLY through `persistEvent`.
- AD-16 (idempotency): every write route carries `idempotency_key` via `idempotencyKeyFrom`; duplicates surface 409 with the existing event id; replay tests per write route.
- AD-17 / ADR-001: only `emitNotification` (decoupled, non-throwing, after commit) is used; no applier emits a notification; Binding Decision 15 classifies this story's emissions.
- AD-3: override authority resolves through `resolveApprover`; no role-name literals (lint rule enforced inside the spine gate).
- AD-9: the asset register is company-wide; coverage rows carry NO location column; notifications target `location_id: null` for role-wide fan-out.
- NUMERIC policy: `contract_value` is `NUMERIC(14,3)`, wire format exact decimal string, all comparisons and rendering in SQL (`::text` out, `::numeric` in); never a JS float.
- Date policy: every DATE validated by `DATE_REGEX` plus the round-trip validity check; every TIMESTAMPTZ input carries an explicit UTC offset; calendar dates derive only via `toIstCalendarDate` (src/lib/business-days.js), never `slice(0, 10)` on an instant; stage-due arithmetic is SQL DATE arithmetic, never JS.
- Event conventions: `maintenance.*` event types on the `maintenance` stream with `requiresBusinessStream: false`; past-tense dot-separated names; server-set actor fields (`recorded_by`, `overridden_by`) re-derived from `metadata.actor.user_id`, never trusted from the body.
- No new dependency of any kind (no cron, no ORM, no decimal library, no HTTP framework): Node 24 native `node:http`, `node:test`, `pg`, PostgreSQL 18.4, TypeScript 5.x are pinned by the architecture spine and validated by every prior story.
- Read back every created resource BY ID for 201 bodies, never by re-querying the newest row or the grain.

### Staged Alert Contract (Story 7.5 verbatim, stages 90/60/30)

- Stage-due test in SQL: `(expiry_date - business_date) <= stage_days AND expiry_date >= business_date`.
- Grain `(coverage_id, stage_days)` enforced by `uq_asset_coverage_alert_stage` with `chk_asset_coverage_alert_stage CHECK (stage_days IN (90, 60, 30))`.
- Catch-up is structural: the scan asks which stages are DUE AND UNFIRED, so a skipped run fires every missed stage most-urgent-first on the next run; an equality test on the day count would silently drop stages.
- Same-day re-run no-ops; a renewal (new coverage_id) earns fresh stages; the coverage row is held FOR UPDATE for the grain so concurrent scans serialize; a lost unique-index race is skipped, never scan-fatal.
- Write counters and delivery counters stay SEPARATE in the scan result (the Story 7.2/7.4 lesson).

### Notification Contract

- Scan alerts: role `maintenance_manager`, `location_id: null`, content template fields `status_verb: 'Due'`, `object_type: 'asset_coverage'`, human-readable `actor_label` (asset name and tag, coverage type, reference, days remaining), `next_step: 'Renew the contract or record a new coverage'`; escalation ONLY on the 30-day stage to `maintenance_supervisor` with a 86400-second acknowledgment window.
- Provision BOTH roles in the test harness and assert real fan-out (the Story 7.4 zero-recipient lesson).
- No notification is emitted for coverage recording itself or for the warranty flag at work-order creation beyond what the tasks specify: AC 2 mandates the flag, not a notification. If review asks for a flag notification, it is a decoupled emission from the accept handler after commit with the replay-safe dedup convention (the `acceptFaultReportBase` technician-notification pattern at src/api/v1/maintenance.ts:1409).

### Reinvention Prevention: Reuse, Never Rebuild

- `idempotencyKeyFrom`, `replayIdOrReject`, `requireBusinessDate`, `auditCtxFor`, `actorContext`, `sendAppError`, `parseListPaging` from src/api/v1/maintenance.ts.
- `emitNotification` from src/notify/emit.ts; `resolveApprover` from src/api/v1/indents.ts:66; `isValidCalendarDate` and `toIstCalendarDate` from src/lib/business-days.js; `lockAssetById` and `getAssetById` from src/read/projections/asset.js; `getWorkOrderById` and `insertWorkOrder` from src/read/projections/maintenance_work_order.js; `AppError` from src/middleware/error.js.
- The `inTransaction` helper shape, the `alreadyPersisted` guard, and the `reject()` helper are copied verbatim from the sibling seams (calibration-jobs.ts, asset-operational-status.ts), not re-derived.
- Do NOT touch `src/compliance/calibration.ts` (the Story 1.7 QC gate) or anything under `src/engineering/` or `src/production/`.

### Testing Requirements Summary

- One failing-first test per acceptance criterion that would FAIL if the behavior were removed; a test that only asserts 200 is not coverage.
- Every code in Table 4 has at least one test; race path and sequential path return the SAME code and SAME existing-id detail for each new unique index.
- Replay test per write route; AD-12 bypass proof via direct `persistEvent(... as any)` for both the chargeable-work gate and the forged-override path; forgery tests for every derived field.
- Mandatory regressions unchanged: story-1-7, story-1-9 (Spine 1-6), story-7-2 through story-7-6, stories 3-2/3-3/3-4.
- Run serially (`--test-concurrency=1`), real PostgreSQL 18.4 per `.env.test`.

### Project Structure Notes

- Canonical SQL at repo root `read/projections/`; TS accessors in `src/read/projections/`; the new seam in `src/compliance/maintenance-coverage.ts` (one seam file per domain area, the 7.5/7.6 pattern); the job in `src/maintenance/coverage-jobs.ts`; all handlers in the single maintenance API module `src/api/v1/maintenance.ts` ("Do NOT create a second API module for maintenance", Story 7.3); routes registered in `src/server.ts`; integration tests in `test/integration/story-7-7.test.ts`.
- Naming follows the repo convention: singular entities (`asset_coverage`), `_ext` suffix for the external contract/policy reference (`reference_number_ext`), `uq_`/`idx_`/`chk_` constraint prefixes, past-tense dotted event types.
- This story is backend-only (API + event seam + projections + job), consistent with every prior Epic 7 story. No Next.js UI and no edge PWA screens are created here; the operations navigation currently lists "asset register, PM schedules, faults" and UX wireframes for AMC/warranty/insurance do not exist, so there is no frontend surface to wire. The warranty flag and override are surfaced through the existing work-order read endpoints for any future UI to consume.
- This story file and any deferred-work edits are bound by `FORMATTING_RULES.md` (hyphens not em dashes, no arrows in prose, tables referenced by name).

### References

- Epic 7 and Story 7.7 requirements: [Source: _bmad-output/planning-artifacts/epics.md#Epic 7: Maintenance, Calibration, and Asset Register and Story 7.7, lines 2105-2289]
- FR-M-10/11 canonical line: [Source: _bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/archive/prd.md#4.10, FR-M-10/11]; insurance Non-Goal: same file, Non-Goals section
- Warranty override authority matrix: [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md#3.5 Capability Matrix, "Warranty override (reason-coded)" row]
- Architecture invariants AD-3, AD-9, AD-12, AD-14, AD-16, AD-17: [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md#Invariants & Rules]
- Notification coupling decision: [Source: docs/adr/ADR-001-notification-emission-coupling.md]
- Staged alert and expiry-scan template: [Source: _bmad-output/implementation-artifacts/7-5-calibration-register-and-non-overridable-lockout.md#Staged Alert Contract] and src/maintenance/calibration-jobs.ts
- Cost arm, DOA sign-off, and derive-and-write-back template: [Source: _bmad-output/implementation-artifacts/7-6-statutory-examinations-cost-accumulation-and-machine-status-broadcast.md] and src/compliance/asset-operational-status.ts
- Work-order creation hook reservation and chargeable-work predecessor: [Source: _bmad-output/implementation-artifacts/7-3-fault-reporting-and-breakdown-work-orders.md#Binding Scope] and src/compliance/maintenance-fault.ts
- Reservation-time warranty deferral: [Source: _bmad-output/implementation-artifacts/deferred-work.md#Story 7.4 entry]
- Sprint rescope provenance (7.4 split, reason-coded override restored): [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11.md#E7-05 and E7-07]

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context), `claude-opus-5[1m]`

### Debug Log References

- `npm run db:migrate` run twice: both passes applied `asset_coverage.sql`, `asset_coverage_alert.sql` and `maintenance_warranty_override.sql` with no error; live verification via `pg_constraint`, `pg_indexes` and `information_schema.columns` confirmed all named constraints, all indexes, and the two additive `maintenance_work_order` columns (`warranty_flagged boolean default false`, `warranty_coverage_id uuid`).
- Three test failures during development traced to real contract questions rather than flaky infrastructure: the `AppError` status property is `statusCode` (not `status`); `maintenance_sla_policy` uses `status = 'active'` (not an `active` boolean); and the override route's grain pre-check turned a legitimate same-key replay into a 409, which is resolved below.
- The one-override-per-work-order grain is deliberately NOT pre-checked in `recordWarrantyOverrideBase`, a documented deviation from Task 7.1's handler-order list. A handler pre-check runs before `persistEvent` resolves the idempotency key, so it broke the AD-16 replay contract for that route. The `raiseCalibrationEscalationBase` route resolves the identical tension the identical way: the seam enforces the grain under the work order's lock (after its `alreadyPersisted` guard) and the `uq_maintenance_warranty_override_work_order` 23505 resolver backs it, so a genuine second override still returns 409 `WARRANTY_OVERRIDE_ALREADY_RECORDED` with the same `existing_override_id` on both the sequential and the race path. Logged to deferred-work.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created (create-story workflow, 2026-08-26).
- 2026-08-27 dev-story: all 9 tasks and 44 subtasks implemented from baseline `e93014f` plus the uncommitted Story 7.6 and Story 6.1 working tree.
- Three new tables, all canonical-plus-mirror with guarded DO blocks and guarded grants: `asset_coverage` (one model for AMC, warranty and insurance per Binding Decision 13, uniqueness as the expression UNIQUE INDEX `uq_asset_coverage_reference` on `(asset_id, coverage_type, lower(reference_number_ext))`), `asset_coverage_alert` (grain `(coverage_id, stage_days)` with `chk_asset_coverage_alert_stage` pinning 90/60/30), and the append-only `maintenance_warranty_override` (`INSERT, SELECT` to `app_user` only, never `UPDATE`). Two additive guarded `ADD COLUMN` blocks on `maintenance_work_order` (`warranty_flagged`, `warranty_coverage_id`), mirrored verbatim into `deploy/compose/init-db.sql` in CRLF with zero mixed line endings.
- Three new maintenance-stream events (`maintenance.coverage_recorded`, `maintenance.coverage_expiry_flagged`, `maintenance.warranty_override_recorded`), all `requiresBusinessStream: false`; `BreakdownWorkOrderCreatedPayload` extended additively with the two seam-derived write-back fields. No existing event type renamed or renumbered.
- New seam `src/compliance/maintenance-coverage.ts` with a pure pre-transaction shape assert and three appliers, wired into `persistEvent` immediately after the Story 7.6 status seam. Fail-closed date gates (422 `COVERAGE_ALREADY_EXPIRED`, 422 `COVERAGE_FUTURE_START`), derived-field write-back for `recorded_by` and `overridden_by`, and the DOA re-resolution for `maintenance.warranty_override` under the work order's lock. Three 23505 resolvers plus three pkey chain entries added to the store's mapper, each naming its own id field.
- AC 2 derivation lands in `applyBreakdownWorkOrderCreated` as step 4b: a DECLARED `warranty_flagged` or `warranty_coverage_id` rejects 409 `WORK_ORDER_DERIVATION_MISMATCH`, and the active warranty is resolved in SQL (`start_date <= business_date <= expiry_date`, latest expiry wins, lowest `coverage_id` breaks ties) by an unlocked SELECT placed after the SLA policy lock, so the existing lock order is unchanged.
- AC 3 chargeable-work gate lands in `applyWorkOrderCompleted` before `setWorkOrderCompleted`, under the work order's own lock, with a matching early pre-check in `completeWorkOrderBase`. The Story 7.6 cost arm and the weighbridge stamp invalidation are untouched and still derive exactly as pinned.
- New job `src/maintenance/coverage-jobs.ts` (`runCoverageExpiryScan`), POST-triggered only: no `setInterval`, no `node-cron`, no new container. One transaction per coverage stage, coverage row locked FOR UPDATE, `DUPLICATE_COVERAGE_ALERT` skipped rather than scan-fatal, notification emitted after commit with delivered and dropped counted separately, escalation only on the 30-day stage.
- Eight REST routes appended to the single maintenance API module and registered in `createAppRouter` with static-before-parameter ordering, plus the eight-entry Spine allowlist widening. No edge surface: `edge/`, `src/sync/upload.ts` and `edge/src/messages/en.json` are untouched.
- One config knob added: `config.maintenance.warrantyOverrideReasonCodes`, fail-closed at load on a malformed, empty or duplicate-carrying env value.
- Gates: `npm run build` clean; `npx tsc --noEmit` clean; `npx eslint src/ test/` clean; prettier clean on every file this story touched (four pre-existing Story 7.5/7.6 files remain unformatted at baseline and were deliberately not reformatted); `npm run db:migrate` twice, idempotent; `test/unit/schema-drift.test.ts` 108 tests, 107 pass, 1 fail (the pre-existing `gate_dwell_metric` CRLF artifact), grown from 104 by the three new tables plus the warranty-column mirror test; `npm run spine-acceptance-contract` 6/6; `npm run edge:test` 30/30 unchanged; `git diff --check` clean.
- Story suites: story-7-7 39/39. Regressions all green and unchanged: story-7-2 26/26, story-7-3 30/30, story-7-4 58/58, story-7-5 36/36, story-7-6 49/49, story-1-9 6/6.
- Full suite: 1199 tests, 1182 pass, 17 fail, ZERO attributable to this story. The 17 are the 15 documented Epic 1-3 idempotency-replay failures, the 1 `gate_dwell_metric` CRLF artifact, and 1 further pre-existing failure the Story 7.6 and 6.1 notes did not itemize: story-1-7 "regression guard: non-QC streams and QC non-result events persist without calibration lookup" posts a `maintenance` stream event to `POST /api/v1/events`, which the Story 7.1 direct-write guard has rejected 400 `INVALID_EVENT_STREAM` since commit `ce42587`. That guard lives in `src/api/v1/events.ts`, a file this story does not modify, and it rejects before `persistEvent` is ever reached.

### Change Log

- 2026-08-26: Story context created from Epic 7 / Story 7.7 with exhaustive artifact analysis (epics, PRD, architecture spine, access matrix, UX, Stories 7.5/7.6 intelligence, full read of every UPDATE file); status ready-for-dev.
- 2026-08-27: Implemented all 9 tasks from baseline `e93014f`; 3 new projections, 3 new events, 1 new seam, 1 new job module, 8 REST routes, 1 config knob, 39 integration tests; status review.

### File List

New files:

- `read/projections/asset_coverage.sql`
- `read/projections/asset_coverage_alert.sql`
- `read/projections/maintenance_warranty_override.sql`
- `src/read/projections/asset_coverage.ts`
- `src/read/projections/asset_coverage_alert.ts`
- `src/read/projections/maintenance_warranty_override.ts`
- `src/compliance/maintenance-coverage.ts`
- `src/maintenance/coverage-jobs.ts`
- `test/integration/story-7-7.test.ts`

Modified files:

- `read/projections/maintenance_work_order.sql`
- `deploy/compose/init-db.sql`
- `src/events/migrate.ts`
- `src/events/schema.ts`
- `src/events/store.ts`
- `src/compliance/maintenance-fault.ts`
- `src/compliance/maintenance-plan.ts`
- `src/read/projections/maintenance_work_order.ts`
- `src/api/v1/maintenance.ts`
- `src/server.ts`
- `src/config/index.ts`
- `test/integration/story-1-9.test.ts`
- `test/unit/schema-drift.test.ts`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/7-7-amc-warranty-and-insurance-tracking.md`
