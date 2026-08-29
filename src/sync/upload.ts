import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalSyncStatus =
  'pending_sync' | 'syncing' | 'synced' | 'needs_attention' | 'auth_required';

export interface UploadFailureClassification {
  action: 'complete' | 'retry' | 'halt';
  localStatus: LocalSyncStatus;
  retryable: boolean;
  serverErrorCode?: string;
  existingEventId?: string;
}

const PERMANENT_ERROR_CODES = new Set([
  'INVALID_EVENT_ENVELOPE',
  'UNTAGGED_TRANSACTION',
  'STREAM_CONFLICT',
  'CALIBRATION_LOCKOUT',
  'INSUFFICIENT_STOCK',
  'LOT_EXPIRED',
  'LOT_ON_HOLD',
  'DUPLICATE_LOT',
  'DUPLICATE_SERIAL',
  'SERIAL_REQUIRED',
  'SERIAL_NOT_ALLOWED',
  'SERIAL_NOT_AVAILABLE',
  'NO_AVAILABLE_LOT',
  'LOT_NOT_FOUND',
  'LOT_REQUIRED',
  'SERIAL_NOT_FOUND',
  'ITEM_NOT_FOUND',
  'FUNCTION_ACCESS_DENIED',
  'LOCATION_ACCESS_DENIED',
  'VALUATION_METHOD_NOT_PERMITTED',
  'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST',
  'APPROVAL_REQUIRED',
  'QUANTITY_EXCEEDS_APPROVED',
  'LOT_MISMATCH',
  'LOT_SKU_MISMATCH',
  'SERIAL_MISMATCH',
  'APPROVAL_UNRESOLVED',
  // Story 2.6: cycle-count / physical-verification permanent business rejections
  'COUNT_TASK_LOCKED',
  'COUNT_ENTERER_CANNOT_APPROVE',
  'PERIOD_LOCKED',
  'COUNT_VARIANCE_REQUIRES_APPROVAL',
  'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
  // Story 2.7: inventory-planning permanent business rejections
  'LEAD_TIME_NOT_CONFIGURED',
  'INSUFFICIENT_DEMAND_HISTORY',
  'INVALID_SERVICE_LEVEL',
  'PLANNING_PARAMS_NOT_FOUND',
  'OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED',
  // Story 2.8: consignment/VMI ownership permanent business rejections
  'OWNERSHIP_AGREEMENT_NOT_FOUND',
  'OWNER_PARTY_MISMATCH',
  'VMI_MIN_NOT_CONFIGURED',
  // Story 3.4: goods-receiving permanent business rejections (RECEIPT_TOLERANCE_EXCEEDED is NOT here -
  // it is a committed 2xx business outcome, not a sync error)
  'ITEM_PO_MISMATCH',
  'RECEIVING_BINDING_TOKEN_REQUIRED',
  'RECEIVING_BINDING_TOKEN_NOT_FOUND',
  'RECEIVING_WEIGHT_NOT_ACCEPTED',
  'RECEIVING_PO_NOT_FOUND',
  'RECEIVING_QTY_REQUIRED',
  'RECEIVING_QC_HOLD_ZONE_NOT_FOUND',
  'LOCATION_NOT_FOUND',
  'PUTAWAY_TASK_NOT_FOUND',
  'PUTAWAY_TASK_NOT_HELD',
  'ASN_PO_NOT_FOUND',
  'INVALID_SIGNAL_TYPE',
  // Story 2.9: ERP reference projections are read-only to the platform (INT-ERP-01). A write from an
  // edge upload can never mutate ERP-mastered state; settle it needs_attention, never halt the outbox.
  'SOURCE_SYSTEM_READ_ONLY',
  // Story 3.2: gate-event permanent business rejections
  'GATE_VEHICLE_REG_REQUIRED',
  'GATE_CHALLAN_PHOTO_REQUIRED',
  'GATE_PO_REF_REQUIRED',
  'GATE_SITE_NOT_FOUND',
  'GATE_REVERSAL_REASON_REQUIRED',
  'GATE_EVENT_NOT_FOUND',
  'GATE_ALREADY_REVERSED',
  // Story 3.3: weighbridge permanent business rejections
  'WEIGHBRIDGE_TARE_REQUIRED',
  'WEIGHBRIDGE_GROSS_REQUIRED',
  'WEIGHBRIDGE_BINDING_TOKEN_REQUIRED',
  'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND',
  'WEIGHBRIDGE_SITE_MISMATCH',
  'WEIGHBRIDGE_NET_NEGATIVE',
  'WEIGHBRIDGE_PO_LINE_NOT_FOUND',
  // Story 3.6: pick-task permanent business rejections (INSUFFICIENT_STOCK is already present
  // above; INSUFFICIENT_STOCK_FOR_PICK is the pick-specific variant)
  'PICK_TASK_NOT_FOUND',
  'PICK_LINE_NOT_FOUND',
  'PICK_TASK_INVALID_PAYLOAD',
  'PICK_LINE_ALREADY_CONFIRMED',
  'PICK_OVERRIDE_REASON_REQUIRED',
  'PICK_TASK_NOT_ALL_LINES_CONFIRMED',
  'PICK_TASK_ALREADY_COMPLETED',
  'INSUFFICIENT_STOCK_FOR_PICK',
  'DISPATCH_ORDER_LINE_NOT_FOUND',
  'PICK_QUANTITY_MISMATCH',
  'PICK_TASK_ALREADY_GENERATED',
  // Story 3.7: dispatch permanent business rejections
  'DISPATCH_PACKED_INVALID_PAYLOAD',
  'DISPATCH_DOCUMENTS_INVALID_PAYLOAD',
  'DISPATCH_DISPATCHED_INVALID_PAYLOAD',
  'DISPATCH_ORDER_NOT_PICKED',
  'DISPATCH_ORDER_ALREADY_DISPATCHED',
  'PACKED_QTY_MISMATCH',
  'DISPATCH_ORDER_NOT_PACKED',
  'LOT_ON_HOLD',
  'DISPATCH_DOCUMENTS_NOT_GENERATED',
  'INVALID_PARAMS',
  'CROSS_DOCK_TASK_NOT_FOUND',
  'CROSS_DOCK_TASK_NOT_READY',
  'CROSS_DOCK_TASK_ALREADY_COMPLETED',
  'CROSS_DOCK_STAGING_INVALID',
  'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
  'CROSS_DOCK_SITE_MISMATCH',
  'CROSS_DOCK_ORDER_NOT_OPEN',
  'CROSS_DOCK_DEMAND_ALREADY_ALLOCATED',
  'CROSS_DOCK_QUANTITY_MISMATCH',
  // Story 4.1: supplier permanent business rejections
  'DUPLICATE_SUPPLIER_GSTIN',
  'SUPPLIER_NOT_FOUND',
  'SUPPLIER_NOT_ACTIVE',
  'SUPPLIER_ALREADY_ACTIVE',
  'SUPPLIER_ALREADY_APPROVED',
  'SUPPLIER_ONBOARDING_NOT_SUBMITTED',
  'SUPPLIER_NOT_IN_ONBOARDING',
  'SUPPLIER_NOT_ACTIVE_OR_ONBOARDING',
  'IMMUTABLE_FIELD',
  // Story 4.3: indent permanent business rejections
  'INDENT_NOT_FOUND',
  'INDENT_ALREADY_DECIDED',
  'INDENT_NOT_IN_RAISED',
  'INDENT_RAISER_CANNOT_APPROVE',
  'NOT_RESOLVED_APPROVER',
  'INDENT_REJECTION_REASON_REQUIRED',
  'INDENT_PENDING_CONFIRMATION',
  'INDENT_LINE_REQUIRED',
  'APPROVAL_UNRESOLVED',
  // Story 7.8: maintenance technician-flow permanent business rejections (FR-M-17). Every code a
  // seam behind the five edge flows can raise settles the single event as needs_attention; the
  // twin set in edge/src/sync/connector.ts carries the identical block (the Story 4.3 rule).
  'CENTRAL_ONLY_OPERATION',
  'INVALID_STATUS_TRANSITION',
  'WORK_ORDER_NOT_FOUND',
  'WORK_ORDER_ALREADY_COMPLETED',
  'WORK_ORDER_DERIVATION_MISMATCH',
  'CLOSURE_CODES_REQUIRED',
  'CLOSURE_CODE_INVALID',
  'ASSET_NOT_FOUND',
  'ASSET_TAG_MISMATCH',
  'METER_NOT_FOUND',
  'METER_READING_REGRESSION',
  'RESERVATION_NOT_FOUND',
  'RESERVATION_NOT_RESERVED',
  'SPARE_DERIVATION_MISMATCH',
  'COST_DERIVATION_MISMATCH',
  'INVALID_PAYLOAD',
]);

/** Story 7.8: the server-side twin of the edge connector's permanent set, exported for the edge upload handler's safety-fault queueing decision. */
export function isPermanentUploadErrorCode(code: string): boolean {
  return PERMANENT_ERROR_CODES.has(code);
}

/**
 * Story 7.8 (Binding Decision 10): every event type the edge may upload on the `maintenance`
 * stream. Any other `maintenance.*` type on POST /api/v1/edge/events is CENTRAL_ONLY_OPERATION, so
 * return-to-service (maintenance.asset_status_changed) is central-only by construction and the
 * seam DOA re-derivation is not the only thing standing between a device and a sign-off.
 */
export const EDGE_MAINTENANCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'maintenance.fault_reported',
  'maintenance.work_order_status_updated',
  'maintenance.meter_reading_recorded',
  'maintenance.spare_issued',
  'maintenance.work_order_completed',
]);

/**
 * Story 8.1 (Binding Scope Decision 9): plan creation, plan approval, the completion hand-off and
 * conditional release are central-control operations. EVERY `qc.*` event type other than the
 * Story 1.7 synthetic qc.result_recorded rejects 403 CENTRAL_ONLY_OPERATION on
 * POST /api/v1/edge/events, so the seam DOA re-derivation is not the only thing between a device
 * and an approval. This story adds no QC edge UI or PowerSync bucket.
 */
export const EDGE_QC_EVENT_TYPES: ReadonlySet<string> = new Set(['qc.result_recorded']);

export function assertEdgeQcEventAllowed(envelope: EventEnvelope): void {
  if (!envelope.event_type.startsWith('qc.')) return;
  if (EDGE_QC_EVENT_TYPES.has(envelope.event_type)) return;
  throw new AppError(
    403,
    'CENTRAL_ONLY_OPERATION',
    'This quality operation must be performed centrally, not from an edge device',
    { event_type: envelope.event_type },
  );
}

export function assertEdgeMaintenanceEventAllowed(envelope: EventEnvelope): void {
  if (!envelope.event_type.startsWith('maintenance.')) return;
  if (EDGE_MAINTENANCE_EVENT_TYPES.has(envelope.event_type)) return;
  throw new AppError(
    403,
    'CENTRAL_ONLY_OPERATION',
    'This maintenance operation must be performed centrally, not from an edge device',
    { event_type: envelope.event_type },
  );
}

/**
 * Story 7.8 (Binding Decision 16): the event types a benign rebase may skip over. When a declared
 * edge event_version fails the head + 1 rule and EVERY event in the gap is one of these, the upload
 * handler retries ONCE with a declared head + 1; anything else in the gap is a real STREAM_CONFLICT.
 *
 * Enumerated 2026-08-28 from every `stream_id:` write in src/maintenance/*-jobs.ts:
 * - pm-jobs.ts:116 maintenance.work_order_generated on the work-order stream (always version 1 of
 *   a stream the device cannot yet hold, so never in a gap)
 * - pm-jobs.ts:221 maintenance.work_order_overdue on the work-order stream (the nightly grace
 *   sweep: the ONLY job write that can land between a device's worklist fetch and its replay)
 * - pm-jobs.ts:305 maintenance.meter_silent_flagged on the METER stream (meter readings omit the
 *   version, so it never enters a head + 1 check)
 * - spares-jobs.ts:154/270, coverage-jobs.ts:173, calibration-jobs.ts:167/261,
 *   statutory-jobs.ts:141, reliability-jobs.ts:210: each on its own alert / examination /
 *   instrument / report stream, never on a work-order or reservation stream
 * No job writes on the reservation stream at all.
 *
 * "If the rebase-safe set ever grows past events no human authored, that is a bug, not a policy."
 */
export const REBASE_SAFE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'maintenance.work_order_overdue',
]);

function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function existingEventIdFrom(error: AppError): string | undefined {
  const value = error.details['existing_event_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function classifyUploadFailure(error: unknown): UploadFailureClassification {
  if (!isAppError(error)) {
    return { action: 'retry', localStatus: 'pending_sync', retryable: true };
  }

  if (error.errorCode === 'DUPLICATE_EVENT') {
    const classification: UploadFailureClassification = {
      action: 'complete',
      localStatus: 'synced',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
    const existingEventId = existingEventIdFrom(error);
    if (existingEventId) classification.existingEventId = existingEventId;
    return classification;
  }

  // A business-rule rejection carrying a known permanent error_code settles the event as
  // needs_attention even at 403 (FUNCTION_ACCESS_DENIED / LOCATION_ACCESS_DENIED / LOT_REQUIRED from
  // the central write path); it must not halt the whole outbox as an auth failure. Checked before
  // the 401/403 halt so those codes are reachable at 403 (Story 2.3 pass-3). A genuine authn failure
  // (401 UNAUTHORIZED, or a 403 with no permanent business code) is not in the set and still halts.
  if (PERMANENT_ERROR_CODES.has(error.errorCode)) {
    return {
      action: 'complete',
      localStatus: 'needs_attention',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  if (error.statusCode === 401 || error.statusCode === 403) {
    return {
      action: 'halt',
      localStatus: 'auth_required',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  if (error.statusCode >= 400 && error.statusCode < 500) {
    return {
      action: 'complete',
      localStatus: 'needs_attention',
      retryable: false,
      serverErrorCode: error.errorCode,
    };
  }

  return {
    action: 'retry',
    localStatus: 'pending_sync',
    retryable: true,
    serverErrorCode: error.errorCode,
  };
}

function assertUuid(value: unknown, field: string): void {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      `${field} is required and must be a valid UUID`,
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      `${field} is required and must be a non-empty string`,
    );
  }
}

export function validateEdgeEnvelope(envelope: EventEnvelope): void {
  assertUuid(envelope.event_id, 'event_id');
  assertNonEmptyString(envelope.idempotency_key, 'idempotency_key');
  assertNonEmptyString(envelope.metadata.device_id, 'metadata.device_id');
}
