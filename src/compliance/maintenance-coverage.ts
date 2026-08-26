import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import { config } from '../config/index.js';
import { lockAssetById } from '../read/projections/asset.js';
import {
  getCoverageById,
  getCoverageByReference,
  insertCoverage,
} from '../read/projections/asset_coverage.js';
import {
  getCoverageAlertForStage,
  insertCoverageAlert,
} from '../read/projections/asset_coverage_alert.js';
import { getWorkOrderById } from '../read/projections/maintenance_work_order.js';
import {
  getWarrantyOverrideByWorkOrder,
  insertWarrantyOverride,
} from '../read/projections/maintenance_warranty_override.js';

/**
 * Story 7.7 compliance seam for AMC, warranty, and insurance tracking (FR-M-10, FR-M-11).
 * Structurally mirrors src/compliance/asset-operational-status.ts: a stream gate, a PURE
 * pre-transaction shape assert, an in-transaction projection switch, an alreadyPersisted guard and
 * the same reject() AppError helper, copied verbatim rather than re-derived.
 *
 * Three appliers:
 * - coverage_recorded inserts one append-only asset_coverage row (a renewal is a NEW row, never an
 *   amendment) with fail-closed date gates against the payload business_date.
 * - coverage_expiry_flagged inserts one asset_coverage_alert row at the (coverage_id, stage_days)
 *   grain, re-deriving asset_id, coverage_type and expiry_date from the locked coverage row.
 * - warranty_override_recorded inserts the at-most-one reason-coded override per work order, with
 *   the DOA authority for maintenance.warranty_override re-resolved under the work order's lock.
 *
 * LOCKING CONTRACT (verified against every sibling seam that touches these rows):
 * - applyCoverageRecorded: asset FOR UPDATE (Locking Contract step 1), then plain reads of
 *   asset_coverage. It takes no coverage lock, so it can never hold one while waiting for an asset.
 * - applyCoverageExpiryFlagged: the coverage row FOR UPDATE only. It touches no asset row, so it
 *   introduces no ordering relationship with the asset-first appliers at all.
 * - applyWarrantyOverrideRecorded: the work-order row FOR UPDATE, then a plain read of the override
 *   grain. The unique index on work_order_id is the concurrency backstop behind that read.
 * - The DOA registry read (resolveApprover) is a plain SELECT on append-only configuration, so it
 *   carries no lock-order dependency (the Story 7.6 precedent).
 *
 * No AB-BA inversion exists against the appliers that share these rows:
 * applyBreakdownWorkOrderCreated takes fault report, asset, SLA policy, then INSERTS the work order
 * and only READS asset_coverage (added by Story 7.7, unlocked, strictly after the SLA policy lock);
 * applyWorkOrderCompleted takes asset, weighbridge examination, work order, then only READS the
 * override grain; runCoverageExpiryScan locks the coverage row alone. Every path that touches both
 * an asset and a coverage takes the asset first, and every path that touches both a work order and
 * an override takes the work order first.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const COVERAGE_RECORDED = 'maintenance.coverage_recorded';
const COVERAGE_EXPIRY_FLAGGED = 'maintenance.coverage_expiry_flagged';
const WARRANTY_OVERRIDE_RECORDED = 'maintenance.warranty_override_recorded';

const COVERAGE_EVENT_TYPES = new Set([
  COVERAGE_RECORDED,
  COVERAGE_EXPIRY_FLAGGED,
  WARRANTY_OVERRIDE_RECORDED,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// The Story 7.6 cost family: an exact decimal string, never a JS number.
const COVERAGE_NUMERIC_REGEX = /^\d{1,11}(\.\d{1,3})?$/;

/**
 * FR-M-10 pins the numbers 90, 60 and 30 itself, so they are a module constant and NOT deployment
 * configuration (Binding Decision 7). Ordered most-urgent-last to match the SQL ordering the scan
 * relies on; the scan itself orders by expiry then stage in SQL.
 */
export const COVERAGE_STAGES = [90, 60, 30] as const;
export const COVERAGE_TYPES = new Set(['amc', 'warranty', 'insurance']);
export const WARRANTY_OVERRIDE_DOA_TYPE = 'maintenance.warranty_override';
export const MAX_REASON_CODE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 512;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  // Round-trip check: reject impossible calendar dates (e.g. 2026-02-30) that Date.parse silently
  // normalizes into a 500 from PostgreSQL 22008 (the Story 7.5 round-trip pattern).
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_TIMESTAMP_REGEX.test(value);
}

/** Canonical form of a human-entered contract reference (the lower() unique index). */
export function canonicalCoverageReference(value: string): string {
  return value.trim().toLowerCase();
}

export function maintenanceCoverageEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!COVERAGE_EVENT_TYPES.has(envelope.event_type)) return null;
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

function assertCoverageRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['coverage_id'])) reject('INVALID_PAYLOAD', 'coverage_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (envelope.stream_id !== p['asset_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload asset_id', {
      stream_id: envelope.stream_id,
      payload_asset_id: p['asset_id'],
    });
  }
  const coverageType = p['coverage_type'];
  if (typeof coverageType !== 'string' || !COVERAGE_TYPES.has(coverageType)) {
    reject('INVALID_PAYLOAD', 'coverage_type must be one of: amc, warranty, insurance');
  }
  const providerName = p['provider_name'];
  if (
    typeof providerName !== 'string' ||
    providerName.trim() === '' ||
    providerName.length > MAX_TEXT_LENGTH
  ) {
    reject('INVALID_PAYLOAD', 'provider_name must be a non-empty string');
  }
  const reference = p['reference_number_ext'];
  if (
    typeof reference !== 'string' ||
    reference.trim() === '' ||
    reference.length > MAX_TEXT_LENGTH
  ) {
    reject('INVALID_PAYLOAD', 'reference_number_ext must be a non-empty string');
  }
  if (!isIsoDate(p['start_date'])) {
    reject('INVALID_PAYLOAD', 'start_date must be a valid calendar date in YYYY-MM-DD');
  }
  if (!isIsoDate(p['expiry_date'])) {
    reject('INVALID_PAYLOAD', 'expiry_date must be a valid calendar date in YYYY-MM-DD');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a valid calendar date in YYYY-MM-DD');
  }
  // Both are validated YYYY-MM-DD strings, so a lexical comparison IS the calendar comparison.
  if ((p['expiry_date'] as string) <= (p['start_date'] as string)) {
    reject('INVALID_PAYLOAD', 'expiry_date must be after start_date', {
      start_date: p['start_date'],
      expiry_date: p['expiry_date'],
    });
  }
  const contractValue = p['contract_value'];
  if (
    contractValue !== null &&
    (typeof contractValue !== 'string' || !COVERAGE_NUMERIC_REGEX.test(contractValue))
  ) {
    reject(
      'INVALID_PAYLOAD',
      'contract_value must be null or a decimal string with at most 3 decimal places',
    );
  }
  if (!isUuid(p['recorded_by'])) reject('INVALID_PAYLOAD', 'recorded_by must be a UUID');
  if (!isIsoTimestamp(p['recorded_at'])) {
    reject('INVALID_PAYLOAD', 'recorded_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertCoverageExpiryFlaggedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['alert_id'])) reject('INVALID_PAYLOAD', 'alert_id must be a UUID');
  if (!isUuid(p['coverage_id'])) reject('INVALID_PAYLOAD', 'coverage_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  const coverageType = p['coverage_type'];
  if (typeof coverageType !== 'string' || !COVERAGE_TYPES.has(coverageType)) {
    reject('INVALID_PAYLOAD', 'coverage_type must be one of: amc, warranty, insurance');
  }
  const stageDays = p['stage_days'];
  if (
    typeof stageDays !== 'number' ||
    !Number.isInteger(stageDays) ||
    !(COVERAGE_STAGES as readonly number[]).includes(stageDays)
  ) {
    reject('INVALID_PAYLOAD', 'stage_days must be one of: 90, 60, 30');
  }
  if (!isIsoDate(p['expiry_date'])) {
    reject('INVALID_PAYLOAD', 'expiry_date must be a valid calendar date in YYYY-MM-DD');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a valid calendar date in YYYY-MM-DD');
  }
  if (!isIsoTimestamp(p['flagged_at'])) {
    reject('INVALID_PAYLOAD', 'flagged_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertWarrantyOverrideRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['override_id'])) reject('INVALID_PAYLOAD', 'override_id must be a UUID');
  if (!isUuid(p['work_order_id'])) reject('INVALID_PAYLOAD', 'work_order_id must be a UUID');
  if (envelope.stream_id !== p['work_order_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload work_order_id', {
      stream_id: envelope.stream_id,
      payload_work_order_id: p['work_order_id'],
    });
  }
  if (!isUuid(p['warranty_coverage_id'])) {
    reject('INVALID_PAYLOAD', 'warranty_coverage_id must be a UUID');
  }
  const reasonCode = p['reason_code'];
  if (
    typeof reasonCode !== 'string' ||
    reasonCode.trim() === '' ||
    reasonCode.trim().length > MAX_REASON_CODE_LENGTH
  ) {
    reject(
      'INVALID_PAYLOAD',
      `reason_code must be a non-empty string of at most ${MAX_REASON_CODE_LENGTH} characters`,
    );
  }
  if (!isUuid(p['overridden_by'])) reject('INVALID_PAYLOAD', 'overridden_by must be a UUID');
  if (!isIsoTimestamp(p['overridden_at'])) {
    reject(
      'INVALID_PAYLOAD',
      'overridden_at must be an ISO 8601 timestamp with an explicit offset',
    );
  }
}

export function assertMaintenanceCoverageShape(envelope: EventEnvelope): void {
  switch (maintenanceCoverageEventType(envelope)) {
    case COVERAGE_RECORDED:
      assertCoverageRecordedShape(envelope);
      return;
    case COVERAGE_EXPIRY_FLAGGED:
      assertCoverageExpiryFlaggedShape(envelope);
      return;
    case WARRANTY_OVERRIDE_RECORDED:
      assertWarrantyOverrideRecordedShape(envelope);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function applyCoverageRecorded(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const coverageId = p['coverage_id'] as string;
  const assetId = p['asset_id'] as string;
  const coverageType = p['coverage_type'] as 'amc' | 'warranty' | 'insurance';
  const providerName = (p['provider_name'] as string).trim();
  const reference = (p['reference_number_ext'] as string).trim();
  const startDate = p['start_date'] as string;
  const expiryDate = p['expiry_date'] as string;
  const businessDate = p['business_date'] as string;
  const contractValue = p['contract_value'] as string | null;
  const declaredRecordedBy = p['recorded_by'] as string;
  const recordedAt = p['recorded_at'] as string;

  // Locking contract step 1: the asset row, FOR UPDATE.
  const assetExists = await lockAssetById(assetId, client);
  if (!assetExists) {
    reject('ASSET_NOT_FOUND', 'The asset does not resolve', { asset_id: assetId }, 404);
  }

  // Fail-closed date gates (Binding Decision 6): an already-lapsed contract serves neither lapse
  // prevention nor a warranty check, and a future start would corrupt the active-warranty
  // derivation, which tests start_date <= business_date.
  if (expiryDate < businessDate) {
    reject(
      'COVERAGE_ALREADY_EXPIRED',
      'The coverage expiry date is before the business date',
      { coverage_id: coverageId, expiry_date: expiryDate, business_date: businessDate },
      422,
    );
  }
  if (startDate > businessDate) {
    reject(
      'COVERAGE_FUTURE_START',
      'The coverage start date is after the business date',
      { coverage_id: coverageId, start_date: startDate, business_date: businessDate },
      422,
    );
  }

  // Duplicate pre-check on the uniqueness grain, run under the asset lock. The 23505 resolver on
  // uq_asset_coverage_reference returns the SAME code and the SAME existing_coverage_id when a
  // concurrent writer wins the race, so both paths are indistinguishable to the caller.
  const existing = await getCoverageByReference(
    assetId,
    coverageType,
    canonicalCoverageReference(reference),
    client,
    false,
  );
  if (existing) {
    reject(
      'DUPLICATE_COVERAGE',
      'A coverage with this reference already exists for the asset and coverage type',
      {
        asset_id: assetId,
        coverage_type: coverageType,
        reference_number_ext: reference,
        existing_coverage_id: existing.coverage_id,
      },
      409,
    );
  }

  // recorded_by is actor-derived; the payload's declared value must match the envelope actor.
  if (declaredRecordedBy !== envelope.metadata.actor.user_id) {
    reject(
      'COVERAGE_DERIVATION_MISMATCH',
      'Declared recorded_by does not match the acting user',
      {
        coverage_id: coverageId,
        declared_recorded_by: declaredRecordedBy,
        derived_recorded_by: envelope.metadata.actor.user_id,
      },
      409,
    );
  }

  // Write the re-derived and normalized fields back onto the persisted payload so the stored event
  // carries exactly what this process derived and stored.
  p['recorded_by'] = envelope.metadata.actor.user_id;
  p['provider_name'] = providerName;
  p['reference_number_ext'] = reference;

  await insertCoverage(
    {
      coverage_id: coverageId,
      asset_id: assetId,
      coverage_type: coverageType,
      provider_name: providerName,
      reference_number_ext: reference,
      start_date: startDate,
      expiry_date: expiryDate,
      contract_value: contractValue,
      recorded_by: envelope.metadata.actor.user_id,
      recorded_at: recordedAt,
    },
    client,
  );
}

async function applyCoverageExpiryFlagged(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const alertId = p['alert_id'] as string;
  const coverageId = p['coverage_id'] as string;
  const declaredAssetId = p['asset_id'] as string;
  const declaredCoverageType = p['coverage_type'] as string;
  const stageDays = p['stage_days'] as number;
  const declaredExpiryDate = p['expiry_date'] as string;
  const businessDate = p['business_date'] as string;
  const flaggedAt = p['flagged_at'] as string;

  // Locking contract: the coverage row FOR UPDATE. Two concurrent scans serialize here, so the
  // grain check below cannot be read stale by the loser.
  const coverage = await getCoverageById(coverageId, client, true);
  if (!coverage) {
    reject('COVERAGE_NOT_FOUND', 'The coverage does not resolve', { coverage_id: coverageId }, 404);
  }

  // Re-read guard: a coverage that has lapsed since the scan selected it is never alerted.
  if (coverage.expiry_date < businessDate) {
    reject(
      'COVERAGE_ALREADY_EXPIRED',
      'The coverage expiry date is before the business date',
      {
        coverage_id: coverageId,
        expiry_date: coverage.expiry_date,
        business_date: businessDate,
      },
      422,
    );
  }

  if (
    coverage.asset_id !== declaredAssetId ||
    coverage.coverage_type !== declaredCoverageType ||
    coverage.expiry_date !== declaredExpiryDate
  ) {
    reject(
      'COVERAGE_DERIVATION_MISMATCH',
      'Declared coverage facts do not match the locked coverage row',
      {
        coverage_id: coverageId,
        declared_asset_id: declaredAssetId,
        derived_asset_id: coverage.asset_id,
        declared_coverage_type: declaredCoverageType,
        derived_coverage_type: coverage.coverage_type,
        declared_expiry_date: declaredExpiryDate,
        derived_expiry_date: coverage.expiry_date,
      },
      409,
    );
  }

  const existingAlert = await getCoverageAlertForStage(coverageId, stageDays, client);
  if (existingAlert) {
    reject(
      'DUPLICATE_COVERAGE_ALERT',
      'This coverage stage has already been alerted',
      {
        coverage_id: coverageId,
        stage_days: stageDays,
        existing_alert_id: existingAlert.alert_id,
      },
      409,
    );
  }

  await insertCoverageAlert(
    {
      alert_id: alertId,
      coverage_id: coverageId,
      asset_id: coverage.asset_id,
      stage_days: stageDays,
      expiry_date: coverage.expiry_date,
      business_date: businessDate,
      flagged_at: flaggedAt,
    },
    client,
  );
}

async function applyWarrantyOverrideRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const overrideId = p['override_id'] as string;
  const workOrderId = p['work_order_id'] as string;
  const declaredCoverageId = p['warranty_coverage_id'] as string;
  const reasonCode = (p['reason_code'] as string).trim();
  const declaredOverriddenBy = p['overridden_by'] as string;
  const overriddenAt = p['overridden_at'] as string;

  // Locking contract: the work order row FOR UPDATE, then the override grain.
  const workOrder = await getWorkOrderById(workOrderId, client, true);
  if (!workOrder) {
    reject(
      'WORK_ORDER_NOT_FOUND',
      'The work order does not resolve',
      { work_order_id: workOrderId },
      404,
    );
  }

  if (workOrder.warranty_flagged !== true) {
    reject(
      'WARRANTY_OVERRIDE_NOT_REQUIRED',
      'The work order is not warranty-flagged, so no override applies',
      { work_order_id: workOrderId },
      409,
    );
  }

  if (workOrder.status === 'completed') {
    reject(
      'WORK_ORDER_ALREADY_COMPLETED',
      'The work order is already completed',
      { work_order_id: workOrderId, completed_at: workOrder.completed_at },
      409,
    );
  }

  if (declaredCoverageId !== workOrder.warranty_coverage_id) {
    reject(
      'COVERAGE_DERIVATION_MISMATCH',
      'Declared warranty_coverage_id does not match the work order',
      {
        work_order_id: workOrderId,
        declared_warranty_coverage_id: declaredCoverageId,
        derived_warranty_coverage_id: workOrder.warranty_coverage_id,
      },
      409,
    );
  }

  if (declaredOverriddenBy !== envelope.metadata.actor.user_id) {
    reject(
      'COVERAGE_DERIVATION_MISMATCH',
      'Declared overridden_by does not match the acting user',
      {
        work_order_id: workOrderId,
        declared_overridden_by: declaredOverriddenBy,
        derived_overridden_by: envelope.metadata.actor.user_id,
      },
      409,
    );
  }

  const allowedReasonCodes = config.maintenance.warrantyOverrideReasonCodes;
  if (!allowedReasonCodes.includes(reasonCode)) {
    reject(
      'WARRANTY_OVERRIDE_REASON_INVALID',
      'The reason code is not a configured warranty override reason',
      { work_order_id: workOrderId, reason_code: reasonCode, allowed: allowedReasonCodes },
      422,
    );
  }

  // AD-3: override authority resolves through the DOA registry under the work order's lock, so a
  // direct event cannot hand the override to someone the registry never authorized.
  const approval = await resolveApprover(WARRANTY_OVERRIDE_DOA_TYPE, 0);
  if (!approval.requiresApproval || approval.approverActorId === null) {
    reject(
      'APPROVAL_UNRESOLVED',
      'No DOA entry governs maintenance.warranty_override',
      { transaction_type: WARRANTY_OVERRIDE_DOA_TYPE },
      404,
    );
  }
  if (declaredOverriddenBy !== approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'The warranty override requires the resolved DOA approver',
      {
        work_order_id: workOrderId,
        resolved_approver_user_id: approval.approverActorId,
      },
      403,
    );
  }

  const existingOverride = await getWarrantyOverrideByWorkOrder(workOrderId, client);
  if (existingOverride) {
    reject(
      'WARRANTY_OVERRIDE_ALREADY_RECORDED',
      'A warranty override has already been recorded for this work order',
      { work_order_id: workOrderId, existing_override_id: existingOverride.override_id },
      409,
    );
  }

  // Write the re-derived and normalized fields back onto the persisted payload.
  p['overridden_by'] = envelope.metadata.actor.user_id;
  p['reason_code'] = reasonCode;

  await insertWarrantyOverride(
    {
      override_id: overrideId,
      work_order_id: workOrderId,
      warranty_coverage_id: workOrder.warranty_coverage_id as string,
      reason_code: reasonCode,
      overridden_by: envelope.metadata.actor.user_id,
      overridden_at: overriddenAt,
    },
    client,
  );
}

export async function applyMaintenanceCoverageProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const eventType = maintenanceCoverageEventType(envelope);
  if (eventType === null) return;
  if (await alreadyPersisted(envelope, client)) return;

  switch (eventType) {
    case COVERAGE_RECORDED:
      await applyCoverageRecorded(envelope, client);
      return;
    case COVERAGE_EXPIRY_FLAGGED:
      await applyCoverageExpiryFlagged(envelope, client);
      return;
    case WARRANTY_OVERRIDE_RECORDED:
      await applyWarrantyOverrideRecorded(envelope, client);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path must return the SAME error code with the SAME existing_*
 * detail (the Story 7.2 lesson). Each resolver re-reads the winning row so a caller that lost a
 * concurrent race is told exactly what a caller that arrived second sequentially is told.
 */
export async function resolveCoverageDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = isUuid(payload['asset_id']) ? (payload['asset_id'] as string) : null;
  const coverageType =
    typeof payload['coverage_type'] === 'string' ? (payload['coverage_type'] as string) : null;
  const reference =
    typeof payload['reference_number_ext'] === 'string' &&
    payload['reference_number_ext'].trim() !== ''
      ? (payload['reference_number_ext'] as string).trim()
      : null;
  const attempted: Record<string, unknown> = {
    asset_id: assetId,
    coverage_type: coverageType,
    reference_number_ext: reference,
  };
  if (assetId !== null && coverageType !== null && reference !== null) {
    const existing = await getCoverageByReference(
      assetId,
      coverageType,
      canonicalCoverageReference(reference),
    );
    if (existing) {
      return { ...attempted, existing_coverage_id: existing.coverage_id };
    }
  }
  return attempted;
}

export async function resolveCoverageAlertDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const coverageId = isUuid(payload['coverage_id']) ? (payload['coverage_id'] as string) : null;
  const stageDays =
    typeof payload['stage_days'] === 'number' && Number.isInteger(payload['stage_days'])
      ? (payload['stage_days'] as number)
      : null;
  const attempted: Record<string, unknown> = {
    coverage_id: coverageId,
    stage_days: stageDays,
  };
  if (coverageId !== null && stageDays !== null) {
    const existing = await getCoverageAlertForStage(coverageId, stageDays);
    if (existing) {
      return { ...attempted, existing_alert_id: existing.alert_id };
    }
  }
  return attempted;
}

export async function resolveWarrantyOverrideDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workOrderId = isUuid(payload['work_order_id'])
    ? (payload['work_order_id'] as string)
    : null;
  const attempted: Record<string, unknown> = { work_order_id: workOrderId };
  if (workOrderId !== null) {
    const existing = await getWarrantyOverrideByWorkOrder(workOrderId);
    if (existing) {
      return { ...attempted, existing_override_id: existing.override_id };
    }
  }
  return attempted;
}
