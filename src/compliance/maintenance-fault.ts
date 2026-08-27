import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getAssetById } from '../read/projections/asset.js';
// Story 7.7 (FR-M-11): the AC 2 warranty check at work-order creation.
import { getActiveWarrantyForAsset } from '../read/projections/asset_coverage.js';
import { getActiveSlaPolicy, insertSlaPolicy } from '../read/projections/maintenance_sla_policy.js';
import {
  getFaultReportById,
  insertFaultReport,
  setFaultAccepted,
  setFaultRejected,
} from '../read/projections/maintenance_fault_report.js';
import {
  getDowntimeByWorkOrder,
  insertDowntime,
  closeDowntime,
} from '../read/projections/maintenance_downtime.js';
import {
  getWorkOrderByFaultReport,
  insertWorkOrder,
} from '../read/projections/maintenance_work_order.js';

/**
 * Story 7.3 compliance seam for fault reporting and breakdown work orders (FR-M-04, FR-M-05,
 * FR-M-06). Structurally mirrors src/compliance/maintenance-plan.ts. Every read-then-write takes
 * FOR UPDATE on the row it is about to change, in a FIXED order (fault report, then SLA policy,
 * then work order, then downtime) so two concurrent acceptances of the same report can never
 * deadlock. The pure shape asserts run pre-transaction so a malformed event never consumes an
 * idempotency key; the appliers run inside persistEvent's transaction.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const MAINTENANCE_FAULT_EVENT_TYPES = new Set([
  'maintenance.sla_policy_defined',
  'maintenance.fault_reported',
  'maintenance.fault_rejected',
  'maintenance.breakdown_work_order_created',
  'maintenance.downtime_closed',
]);

const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);
const PRIORITIES = new Set(['p1', 'p2', 'p3', 'p4']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED: a naive timestamp is parsed by JS Date.parse in
// process-local time but cast by pg ::timestamptz in session time, so the stored instant would
// shift when the two differ (the 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Bounds mirror the SLA policy table's CHECK constraints so a malformed direct-event envelope is a
// stable 400 instead of an unmapped 23514 500.
const MAX_RESPONSE_MINUTES = 100000;
const MAX_RESOLUTION_HOURS = 100000;
// 4-digit safety horizon for the SLA arithmetic (the Story 7.2 MAX_PLAN_HORIZON precedent): a
// policy whose response/resolution targets push sla_resolution_due_at or due_date past this
// rejects at acceptance with a 400 instead of bricking the work-order row with a 5-digit year.
const MAX_SAFETY_HORIZON_MS = Date.parse('2999-12-31T23:59:59.999Z');

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO8601_TIMESTAMP_REGEX.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function maintenanceFaultEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!MAINTENANCE_FAULT_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertMaintenanceFaultShape(envelope: EventEnvelope): void {
  const type = maintenanceFaultEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'maintenance.sla_policy_defined':
      assertSlaPolicyDefinedShape(p);
      break;
    case 'maintenance.fault_reported':
      assertFaultReportedShape(p);
      break;
    case 'maintenance.fault_rejected':
      assertFaultRejectedShape(p);
      break;
    case 'maintenance.breakdown_work_order_created':
      assertBreakdownWorkOrderCreatedShape(p);
      break;
    case 'maintenance.downtime_closed':
      assertDowntimeClosedShape(p);
      break;
  }
}

function assertSlaPolicyDefinedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['policy_id'])) reject('INVALID_PARAMS', 'policy_id is required and must be a UUID');
  if (
    !isNonEmptyString(p['criticality_class']) ||
    !CRITICALITY_CLASSES.has(p['criticality_class'] as string)
  ) {
    reject(
      'INVALID_PARAMS',
      'criticality_class is required and must be one of: critical, high, medium, low',
      { criticality_class: p['criticality_class'] },
    );
  }
  if (typeof p['safety_flag'] !== 'boolean') {
    reject('INVALID_PARAMS', 'safety_flag is required and must be a boolean', {
      safety_flag: p['safety_flag'],
    });
  }
  if (!isNonEmptyString(p['priority']) || !PRIORITIES.has(p['priority'] as string)) {
    reject('INVALID_PARAMS', 'priority is required and must be one of: p1, p2, p3, p4', {
      priority: p['priority'],
    });
  }
  if (!isIntegerWithin(p['response_minutes'], 1, MAX_RESPONSE_MINUTES)) {
    reject(
      'INVALID_PARAMS',
      `response_minutes must be a positive integer of at most ${MAX_RESPONSE_MINUTES}`,
      { response_minutes: p['response_minutes'] },
    );
  }
  if (!isIntegerWithin(p['resolution_hours'], 1, MAX_RESOLUTION_HOURS)) {
    reject(
      'INVALID_PARAMS',
      `resolution_hours must be a positive integer of at most ${MAX_RESOLUTION_HOURS}`,
      { resolution_hours: p['resolution_hours'] },
    );
  }
}

function assertFaultReportedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['fault_report_id']))
    reject('INVALID_PARAMS', 'fault_report_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isNonEmptyString(p['asset_tag']))
    reject('INVALID_PARAMS', 'asset_tag is required and must be a non-empty string');
  if (!isNonEmptyString(p['description']))
    reject('INVALID_PARAMS', 'description is required and must be a non-empty string');
  if (typeof p['safety_flag'] !== 'boolean') {
    reject('INVALID_PARAMS', 'safety_flag is required and must be a boolean', {
      safety_flag: p['safety_flag'],
    });
  }
  if (!isIsoTimestamp(p['reported_at'])) {
    reject(
      'INVALID_PARAMS',
      'reported_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      { reported_at: p['reported_at'] },
    );
  }
  // A future-dated report anchors the SLA derivation and the downtime window in a time that does
  // not exist yet; 24h clock-skew tolerance mirrors the meter seam's reading_at guard.
  if (Date.parse(p['reported_at'] as string) > Date.now() + 24 * 60 * 60 * 1000) {
    reject('INVALID_PARAMS', 'reported_at must not be in the future (24h clock-skew tolerance)', {
      reported_at: p['reported_at'],
    });
  }
}

function assertFaultRejectedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['fault_report_id']))
    reject('INVALID_PARAMS', 'fault_report_id is required and must be a UUID');
  // The rejection reason must survive the projection's btrim() non-blank CHECK; asserting it here
  // makes a blank reason a stable 400 instead of an unmapped 23514 500.
  if (!isNonEmptyString(p['rejection_reason'])) {
    reject('INVALID_PARAMS', 'rejection_reason is required and must be a non-empty string', {
      rejection_reason: p['rejection_reason'],
    });
  }
  if (!isIsoTimestamp(p['triaged_at'])) {
    reject(
      'INVALID_PARAMS',
      'triaged_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      { triaged_at: p['triaged_at'] },
    );
  }
}

function assertBreakdownWorkOrderCreatedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['work_order_id']))
    reject('INVALID_PARAMS', 'work_order_id is required and must be a UUID');
  if (!isUuid(p['fault_report_id']))
    reject('INVALID_PARAMS', 'fault_report_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isUuid(p['downtime_id']))
    reject('INVALID_PARAMS', 'downtime_id is required and must be a UUID');
  if (!isNonEmptyString(p['priority']) || !PRIORITIES.has(p['priority'] as string)) {
    reject('INVALID_PARAMS', 'priority is required and must be one of: p1, p2, p3, p4', {
      priority: p['priority'],
    });
  }
  if (!isUuid(p['sla_policy_id']))
    reject('INVALID_PARAMS', 'sla_policy_id is required and must be a UUID');
  if (!isIsoDate(p['due_date']))
    reject('INVALID_PARAMS', 'due_date is required and must be an ISO date', {
      due_date: p['due_date'],
    });
  if (!isIsoDate(p['grace_until_date']))
    reject('INVALID_PARAMS', 'grace_until_date is required and must be an ISO date', {
      grace_until_date: p['grace_until_date'],
    });
  // The work-order table enforces grace_until_date >= due_date
  // (chk_maintenance_work_order_grace); validating here keeps a malformed direct-event envelope a
  // stable 400 instead of an unmapped 23514 500.
  if ((p['grace_until_date'] as string) < (p['due_date'] as string)) {
    reject('INVALID_PARAMS', 'grace_until_date must not be before due_date', {
      due_date: p['due_date'],
      grace_until_date: p['grace_until_date'],
    });
  }
  if (!isIsoTimestamp(p['sla_response_due_at'])) {
    reject(
      'INVALID_PARAMS',
      'sla_response_due_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      { sla_response_due_at: p['sla_response_due_at'] },
    );
  }
  if (!isIsoTimestamp(p['sla_resolution_due_at'])) {
    reject(
      'INVALID_PARAMS',
      'sla_resolution_due_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      { sla_resolution_due_at: p['sla_resolution_due_at'] },
    );
  }
  if (!isIsoDate(p['business_date']))
    reject('INVALID_PARAMS', 'business_date is required and must be an ISO date', {
      business_date: p['business_date'],
    });
}

function assertDowntimeClosedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['downtime_id']))
    reject('INVALID_PARAMS', 'downtime_id is required and must be a UUID');
  if (!isUuid(p['work_order_id']))
    reject('INVALID_PARAMS', 'work_order_id is required and must be a UUID');
  if (!isIsoTimestamp(p['ended_at'])) {
    reject(
      'INVALID_PARAMS',
      'ended_at is required and must be an ISO-8601 timestamp with an explicit UTC offset',
      { ended_at: p['ended_at'] },
    );
  }
  // A future-dated close would bake a not-yet-real time into duration_minutes and the monthly
  // reliability snapshot; 24h clock-skew tolerance mirrors the meter seam's reading_at guard.
  if (Date.parse(p['ended_at'] as string) > Date.now() + 24 * 60 * 60 * 1000) {
    reject('INVALID_PARAMS', 'ended_at must not be in the future (24h clock-skew tolerance)', {
      ended_at: p['ended_at'],
    });
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Adds whole minutes to an ISO timestamp in UTC; the SLA derivation is pinned to UTC. */
function addMinutesToIso(iso: string | Date, minutes: number): string {
  // pg returns timestamptz columns as Date objects; Date.parse(Date) truncates milliseconds via
  // Date.prototype.toString, so normalize to an ISO string first (a 333ms reported_at must not
  // become a 000ms SLA due).
  const baseMs = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  return new Date(baseMs + minutes * 60000).toISOString();
}

/** Absolute epoch millis for a timestamp that may arrive as a pg Date object. */
function toEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export async function applyMaintenanceFaultProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = maintenanceFaultEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.sla_policy_defined':
      await applySlaPolicyDefined(envelope, client);
      break;
    case 'maintenance.fault_reported':
      await applyFaultReported(envelope, client);
      break;
    case 'maintenance.fault_rejected':
      await applyFaultRejected(envelope, client);
      break;
    case 'maintenance.breakdown_work_order_created':
      await applyBreakdownWorkOrderCreated(envelope, client);
      break;
    case 'maintenance.downtime_closed':
      await applyDowntimeClosed(envelope, client);
      break;
  }
}

async function applySlaPolicyDefined(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const criticalityClass = p['criticality_class'] as string;
  const safetyFlag = p['safety_flag'] as boolean;

  // FOR UPDATE: two concurrent definitions of the same (class, safety) pair must resolve to one
  // winner; the loser sees the committed row here and rejects with the stable code.
  const existing = await getActiveSlaPolicy(criticalityClass, safetyFlag, client, true);
  if (existing) {
    reject(
      'DUPLICATE_SLA_POLICY',
      'An active SLA policy already exists for this (criticality_class, safety_flag) pair',
      {
        criticality_class: criticalityClass,
        safety_flag: safetyFlag,
        existing_policy_id: existing.policy_id,
      },
      409,
    );
  }

  await insertSlaPolicy(
    {
      policy_id: p['policy_id'] as string,
      criticality_class: criticalityClass as 'critical' | 'high' | 'medium' | 'low',
      safety_flag: safetyFlag,
      priority: p['priority'] as 'p1' | 'p2' | 'p3' | 'p4',
      response_minutes: p['response_minutes'] as number,
      resolution_hours: p['resolution_hours'] as number,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applyFaultReported(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const assetId = p['asset_id'] as string;

  const asset = await getAssetById(assetId, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId }, 404);
  }

  // The tag is the scan path's human-entered key; a case-variant scan is the SAME asset (the
  // Story 7.1 canonicalization lesson), but a tag that belongs to a different asset is a
  // data-entry error and must not be silently accepted.
  const submittedTag = (p['asset_tag'] as string).trim();
  if (submittedTag.toLowerCase() !== asset.asset_tag.toLowerCase()) {
    reject('ASSET_TAG_MISMATCH', 'The submitted asset tag does not match the asset row', {
      asset_id: assetId,
      asset_tag: submittedTag,
      canonical_asset_tag: asset.asset_tag,
    });
  }

  await insertFaultReport(
    {
      fault_report_id: p['fault_report_id'] as string,
      asset_id: assetId,
      // Persist the CANONICAL tag from the asset row, never the case-variant the operator typed.
      asset_tag: asset.asset_tag,
      reported_by: envelope.metadata.actor.user_id,
      reported_at: p['reported_at'] as string,
      // The reporter is physically at the asset when they scan its tag, so their location IS the
      // asset's location for the FR-M-04 supervisor notification (Task 2.3, never the body).
      location_id: envelope.metadata.actor.location_id,
      description: (p['description'] as string).trim(),
      safety_flag: p['safety_flag'] as boolean,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applyFaultRejected(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const faultReportId = p['fault_report_id'] as string;

  const report = await getFaultReportById(faultReportId, client, true);
  if (!report) {
    reject(
      'FAULT_REPORT_NOT_FOUND',
      'Fault report not found',
      { fault_report_id: faultReportId },
      404,
    );
  }
  if (report.status !== 'reported') {
    reject(
      'FAULT_ALREADY_TRIAGED',
      'This fault report has already been triaged',
      {
        fault_report_id: faultReportId,
        existing_status: report.status,
        existing_work_order_id: report.work_order_id,
      },
      409,
    );
  }

  await setFaultRejected(
    faultReportId,
    (p['rejection_reason'] as string).trim(),
    envelope.metadata.occurred_at ?? new Date().toISOString(),
    envelope.metadata.actor.user_id,
    client,
  );
}

async function applyBreakdownWorkOrderCreated(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const faultReportId = p['fault_report_id'] as string;

  // Step 1: lock the fault report FIRST so two concurrent acceptances of the same report resolve
  // to exactly one winner (the second sees status != 'reported' after the first commits).
  const report = await getFaultReportById(faultReportId, client, true);
  if (!report) {
    reject(
      'FAULT_REPORT_NOT_FOUND',
      'Fault report not found',
      { fault_report_id: faultReportId },
      404,
    );
  }
  if (report.status !== 'reported') {
    reject(
      'FAULT_ALREADY_TRIAGED',
      'This fault report has already been triaged',
      {
        fault_report_id: faultReportId,
        existing_status: report.status,
        existing_work_order_id: report.work_order_id,
      },
      409,
    );
  }

  // Step 2: re-read the asset for its criticality_class (master data validated at report time;
  // a breakdown of an asset that no longer exists is a hard stop, never a phantom work order).
  const asset = await getAssetById(report.asset_id, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: report.asset_id }, 404);
  }
  // The payload declares asset_id; the fault report is the authoritative binding.
  if (p['asset_id'] !== report.asset_id) {
    reject(
      'WORK_ORDER_DERIVATION_MISMATCH',
      "asset_id must be the fault report's asset",
      {
        fault_report_id: faultReportId,
        asset_id: p['asset_id'],
        expected_asset_id: report.asset_id,
      },
      409,
    );
  }

  // Step 3: lock the active SLA policy for (asset criticality, report safety flag). A missing
  // policy is a hard 422 - a guessed SLA is worse than a blocked acceptance the operator can fix
  // in one POST (the Binding Scope Decisions).
  const policy = await getActiveSlaPolicy(
    asset.criticality_class,
    report.safety_flag,
    client,
    true,
  );
  if (!policy) {
    reject(
      'SLA_POLICY_NOT_FOUND',
      'No active SLA policy exists for this (criticality_class, safety_flag) pair',
      { criticality_class: asset.criticality_class, safety_flag: report.safety_flag },
      422,
    );
  }

  // Step 4: derive every SLA value from the LOCKED rows (SLA Derivation Contract). The payload
  // declares them too; any divergence is a corruption channel on the direct-event path and must
  // reject rather than silently store the payload's version.
  const reportedAt = report.reported_at;
  const slaResponseDueAt = addMinutesToIso(reportedAt, policy.response_minutes);
  // resolution_hours is in HOURS; addMinutesToIso takes minutes.
  const slaResolutionDueAt = addMinutesToIso(reportedAt, policy.resolution_hours * 60);
  // due_date is the UTC calendar date of the resolution target, pinned so no session timezone can
  // shift it (the 7.2 Group 3 lesson). Breakdown work orders have no grace window: grace_until
  // equals due (chk_maintenance_work_order_grace requires grace >= due).
  const dueDate = new Date(Date.parse(slaResolutionDueAt)).toISOString().slice(0, 10);
  const graceUntilDate = dueDate;

  const declared: Array<[string, unknown, unknown]> = [
    ['priority', p['priority'], policy.priority],
    ['sla_policy_id', p['sla_policy_id'], policy.policy_id],
    ['sla_response_due_at', p['sla_response_due_at'], slaResponseDueAt],
    ['sla_resolution_due_at', p['sla_resolution_due_at'], slaResolutionDueAt],
    ['due_date', p['due_date'], dueDate],
    ['grace_until_date', p['grace_until_date'], graceUntilDate],
  ];
  for (const [field, declaredValue, expectedValue] of declared) {
    if (declaredValue !== expectedValue) {
      reject(
        'WORK_ORDER_DERIVATION_MISMATCH',
        `Declared ${field} does not match the derived value`,
        {
          fault_report_id: faultReportId,
          [field]: declaredValue,
          expected: expectedValue,
        },
        409,
      );
    }
  }

  // Both SLA timestamps and due_date must stay inside the 2999-12-31 safety horizon; a policy
  // whose arithmetic overflows it rejects at acceptance (a 5-digit year would brick the row).
  if (
    Date.parse(slaResponseDueAt) > MAX_SAFETY_HORIZON_MS ||
    Date.parse(slaResolutionDueAt) > MAX_SAFETY_HORIZON_MS ||
    dueDate > '2999-12-31'
  ) {
    reject('INVALID_PARAMS', 'The SLA arithmetic exceeds the 2999-12-31 safety horizon', {
      sla_response_due_at: slaResponseDueAt,
      sla_resolution_due_at: slaResolutionDueAt,
      due_date: dueDate,
    });
  }

  // Step 4b (Story 7.7, FR-M-11, AC 2): the warranty check. warranty_flagged and
  // warranty_coverage_id are DERIVED here and written back onto the persisted payload; a DECLARED
  // value in the inbound envelope is a corruption channel on the direct-event path and rejects
  // (Binding Decision 3, the Story 7.6 derived-field rule for total_cost).
  if (p['warranty_flagged'] !== undefined || p['warranty_coverage_id'] !== undefined) {
    const declaredField =
      p['warranty_flagged'] !== undefined ? 'warranty_flagged' : 'warranty_coverage_id';
    reject(
      'WORK_ORDER_DERIVATION_MISMATCH',
      `${declaredField} is derived and cannot be declared`,
      {
        fault_report_id: faultReportId,
        warranty_flagged: p['warranty_flagged'],
        warranty_coverage_id: p['warranty_coverage_id'],
      },
      409,
    );
  }
  // A plain SELECT placed AFTER the SLA policy lock: it takes no lock of its own, so the existing
  // fault report -> asset -> SLA policy -> work order -> downtime order is preserved and no new
  // deadlock class is introduced. The flag is advisory ("may be covered"), so the millisecond race
  // with a concurrent coverage recording is acceptable - and that recording locks the ASSET row,
  // never a coverage row, so it cannot invert against anything held here.
  const activeWarranty = await getActiveWarrantyForAsset(
    report.asset_id,
    p['business_date'] as string,
    client,
  );
  const warrantyFlagged = Boolean(activeWarranty);
  const warrantyCoverageId = activeWarranty?.coverage_id ?? null;
  p['warranty_flagged'] = warrantyFlagged;
  p['warranty_coverage_id'] = warrantyCoverageId;

  // Step 5: insert the breakdown work order. plan_id is NULL (chk_maintenance_work_order_plan_link
  // permits it for a non-preventive row) and generated_for_cycle carries the fault_report_id - the
  // column is NOT NULL and uq_maintenance_work_order_cycle is partial on plan_id IS NOT NULL, so a
  // breakdown row never collides there (Binding Scope Decisions).
  const workOrderId = p['work_order_id'] as string;
  await insertWorkOrder(
    {
      work_order_id: workOrderId,
      plan_id: null,
      asset_id: report.asset_id,
      origin: 'breakdown',
      due_date: dueDate,
      grace_until_date: graceUntilDate,
      generated_for_cycle: faultReportId,
      fault_report_id: faultReportId,
      priority: policy.priority,
      sla_policy_id: policy.policy_id,
      sla_response_due_at: slaResponseDueAt,
      sla_resolution_due_at: slaResolutionDueAt,
      warranty_flagged: warrantyFlagged,
      warranty_coverage_id: warrantyCoverageId,
      created_at: now,
      updated_at: now,
    },
    client,
  );

  // Step 6: open the downtime window, started at the fault's reported_at - the honest start of
  // the outage (Binding Scope Decisions).
  await insertDowntime(
    {
      downtime_id: p['downtime_id'] as string,
      work_order_id: workOrderId,
      asset_id: report.asset_id,
      started_at: reportedAt,
      created_at: now,
      updated_at: now,
    },
    client,
  );

  // Step 7: flip the report to accepted in the same transaction (status, work_order_id, triage
  // stamps). uq_maintenance_work_order_fault is the concurrency backstop behind the report lock.
  await setFaultAccepted(
    faultReportId,
    workOrderId,
    envelope.metadata.occurred_at ?? now,
    envelope.metadata.actor.user_id,
    client,
  );
}

async function applyDowntimeClosed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const workOrderId = p['work_order_id'] as string;

  const downtime = await getDowntimeByWorkOrder(workOrderId, client, true);
  if (!downtime) {
    reject(
      'DOWNTIME_NOT_FOUND',
      'No downtime window exists for this work order',
      {
        work_order_id: workOrderId,
      },
      404,
    );
  }
  if (downtime.ended_at !== null) {
    reject(
      'DOWNTIME_NOT_OPEN',
      'This downtime window is already closed',
      { downtime_id: downtime.downtime_id, existing_ended_at: downtime.ended_at },
      409,
    );
  }
  // The declared downtime_id must name the locked row (Event Contract): a crafted envelope that
  // closes the REAL window while declaring a phantom id would desynchronize the ledger.
  if (p['downtime_id'] !== downtime.downtime_id) {
    reject(
      'WORK_ORDER_DERIVATION_MISMATCH',
      'Declared downtime_id does not match the locked downtime row',
      {
        downtime_id: downtime.downtime_id,
        declared_downtime_id: p['downtime_id'],
      },
      409,
    );
  }
  const startedAtMs = toEpochMs(downtime.started_at);
  const endedAtMs = toEpochMs(p['ended_at'] as string);
  if (endedAtMs < startedAtMs) {
    reject('DOWNTIME_WINDOW_INVALID', 'ended_at must not be earlier than started_at', {
      downtime_id: downtime.downtime_id,
      started_at: downtime.started_at,
      ended_at: p['ended_at'],
    });
  }

  await closeDowntime(
    downtime.downtime_id,
    p['ended_at'] as string,
    envelope.metadata.actor.user_id,
    client,
  );
}

/**
 * Concurrency fallback for uq_maintenance_sla_policy_key: returns the SAME detail shape as the
 * seam's pre-check (DUPLICATE_SLA_POLICY with existing_policy_id).
 */
export async function resolveSlaPolicyDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const criticalityClass =
    typeof payload['criticality_class'] === 'string' ? payload['criticality_class'] : null;
  const safetyFlag = typeof payload['safety_flag'] === 'boolean' ? payload['safety_flag'] : null;
  const attempted: Record<string, unknown> = {
    criticality_class: criticalityClass,
    safety_flag: safetyFlag,
  };
  if (criticalityClass !== null && safetyFlag !== null) {
    const existing = await getActiveSlaPolicy(criticalityClass, safetyFlag);
    if (existing) {
      return {
        criticality_class: criticalityClass,
        safety_flag: safetyFlag,
        existing_policy_id: existing.policy_id,
      };
    }
  }
  return attempted;
}

/**
 * Concurrency fallback for uq_maintenance_work_order_fault: returns the SAME detail shape as the
 * seam's pre-check (FAULT_ALREADY_TRIAGED with existing_work_order_id).
 */
export async function resolveFaultTriageConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const faultReportId =
    typeof payload['fault_report_id'] === 'string' ? payload['fault_report_id'] : null;
  const attempted: Record<string, unknown> = { fault_report_id: faultReportId };
  if (faultReportId !== null) {
    const existing = await getWorkOrderByFaultReport(faultReportId);
    if (existing) {
      return {
        fault_report_id: faultReportId,
        existing_status: 'accepted',
        existing_work_order_id: existing.work_order_id,
      };
    }
  }
  return attempted;
}

/**
 * Concurrency fallback for uq_maintenance_downtime_work_order: returns the SAME detail shape the
 * caller needs (DOWNTIME_ALREADY_OPEN with existing_downtime_id).
 */
export async function resolveDowntimeConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workOrderId =
    typeof payload['work_order_id'] === 'string' ? payload['work_order_id'] : null;
  const attempted: Record<string, unknown> = { work_order_id: workOrderId };
  if (workOrderId !== null) {
    const existing = await getDowntimeByWorkOrder(workOrderId);
    if (existing) {
      return { work_order_id: workOrderId, existing_downtime_id: existing.downtime_id };
    }
  }
  return attempted;
}
