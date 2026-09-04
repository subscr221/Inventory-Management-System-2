import { AppError } from '../middleware/error.js';
import type { EventEnvelope } from '../events/store.js';
import { QC_CENTRAL_ONLY_EVENT_TYPES } from '../compliance/quality.js';

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
  // Story 8.8 (FR-Q-12): a structural bar, so an offline edge retry can never clear it.
  'PROTOTYPE_NOT_SALEABLE',
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
  // Story 8.2: every permanent code a qc.result_recorded upload can surface from the sampling and
  // result-capture seam (FR-Q-03, FR-Q-04). The twin set in edge/src/sync/connector.ts carries the
  // identical block (the Story 4.3 rule); CALIBRATION_LOCKOUT is already present above.
  'QC_TASK_NOT_FOUND',
  'QC_SAMPLING_REQUIRED',
  'QC_TASK_NOT_OPEN_FOR_RESULTS',
  'QC_CHARACTERISTIC_NOT_IN_PLAN',
  'QC_SAMPLE_UNIT_OUT_OF_RANGE',
  'QC_RESULT_KIND_MISMATCH',
  'QC_RESULT_UOM_MISMATCH',
  'QC_RESULT_EXISTS',
  'INSTRUMENT_NOT_FOUND',
  'INSTRUMENT_NOT_PERMITTED',
  'QC_DERIVATION_MISMATCH',
  // Story 6.4: every permanent code a replayed production upload can surface from the 6.2/6.3/6.4
  // seams (FR-MO-13). The twin set in edge/src/sync/connector.ts carries the identical block (the
  // Story 4.3 rule); CENTRAL_ONLY_OPERATION, INSUFFICIENT_STOCK, LOT_REQUIRED, APPROVAL_REQUIRED
  // and INVALID_PAYLOAD are already present above.
  'ORDER_CLOSED',
  'CLOSURE_GATE_BLOCKED',
  'PRODUCTION_ORDER_NOT_FOUND',
  'PRODUCTION_ORDER_DERIVATION_MISMATCH',
  'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
  'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
  'INVALID_STATE_TRANSITION',
  // Story 9.3: an off-kit custody consumption is permanent - a retry can never match a kit line
  // that the order's current revision does not carry (the INVALID_STATE_TRANSITION precedent).
  'KIT_LINE_MISMATCH',
  // Story 9.4: the reason code is checked against a fixed configured list, so an offline edge
  // retry of the same declaration can never clear it (the KIT_LINE_MISMATCH precedent).
  'JOBWORK_LOSS_REASON_CODE_INVALID',
  // Story 9.5 (FR-JW-15, AD-6): closure refused on a non-zero custody balance - a retry of the same
  // closure request can never clear it; the ledger has to be reconciled first (the 9.4 precedent).
  'CUSTODY_NOT_ZERO',
  'UNREVERSED_TRANSACTIONS',
  'BOM_REVISION_DRIFT',
  'MATERIAL_REQUIREMENT_SET_TRUNCATED',
  'STAGE_NOT_FOUND',
  'STAGE_ALREADY_ISSUED',
  'RETURN_EXCEEDS_ISSUE',
  'REASON_CODE_REQUIRED',
  'WIP_COST_UNRESOLVED',
  'QC_HOLD_REQUIRED',
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
 * Story 8.1 (Binding Scope Decision 9) / Story 8.2 (Binding Scope Decision 8): plan creation, plan
 * approval, the completion hand-off, conditional release, sampling determination, observations,
 * inspection completion and the switching-state commands are central-control operations. EVERY
 * `qc.*` event type other than qc.result_recorded (the Story 1.7 synthetic shape and the Story 8.2
 * instrument-bound result batch) rejects 403 CENTRAL_ONLY_OPERATION on POST /api/v1/edge/events,
 * so the seam DOA re-derivation is not the only thing between a device and an approval. The
 * explicit QC_CENTRAL_ONLY_EVENT_TYPES set is checked first so a registered central-only type can
 * never be admitted by a widening of this allowlist alone. No QC edge UI or PowerSync bucket.
 */
export const EDGE_QC_EVENT_TYPES: ReadonlySet<string> = new Set(['qc.result_recorded']);

export function assertEdgeQcEventAllowed(envelope: EventEnvelope): void {
  if (!envelope.event_type.startsWith('qc.')) return;
  if (
    !QC_CENTRAL_ONLY_EVENT_TYPES.has(envelope.event_type) &&
    EDGE_QC_EVENT_TYPES.has(envelope.event_type)
  ) {
    return;
  }
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
 * Story 6.4 (FR-MO-13, AC 6): the event types the edge may upload on the `production` stream.
 * Plant-floor execution - staging, issuing, confirming, returning, completing and declaring scrap -
 * replays from a device; order creation, release, cancellation and the close-short decision are
 * planning and supervisory acts that stay central.
 */
export const EDGE_PRODUCTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'production_order.material_staged',
  'production_order.material_issued',
  'production_order.confirmation_recorded',
  'production_order.material_returned',
  'production_order.completion_posted',
  'production_order.scrap_declared',
  'production_order.state_changed',
]);

/**
 * The one production state transition that is central-only. AC 6 names release, cancel and CLOSE,
 * but unlike the other two, closing is NOT its own event type: it is
 * production_order.state_changed carrying new_status 'closed', and that same event type also
 * carries released -> in_process and in_process -> completed, which a plant device legitimately
 * records while offline.
 *
 * DISCLOSED DEVIATION from the Story 7.8 / 8.1 precedent: assertEdgeQcEventAllowed and
 * assertEdgeMaintenanceEventAllowed gate purely on event-type set membership, and copying that
 * shape here would have forced a choice between admitting offline closure and barring the whole
 * transition family from the floor. This guard therefore inspects ONE payload field. It is the
 * narrowest possible extension of the pattern, and it is checked BEFORE the allowlist so widening
 * EDGE_PRODUCTION_EVENT_TYPES alone can never admit a closure (the QC_CENTRAL_ONLY_EVENT_TYPES
 * ordering rule, applied to a payload predicate instead of a type).
 */
function isEdgeCentralOnlyProductionEvent(envelope: EventEnvelope): boolean {
  if (envelope.event_type !== 'production_order.state_changed') return false;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  // Code review 2026-09-01: a missing/malformed payload used to read as `undefined !== 'closed'`
  // and fall through to the allowlist (which admits state_changed), skipping this predicate
  // entirely. A state_changed event with no resolvable new_status cannot be proven NOT a close, so
  // it fails closed here rather than falling through.
  return typeof payload?.['new_status'] !== 'string' || payload['new_status'] === 'closed';
}

export function assertEdgeProductionEventAllowed(envelope: EventEnvelope): void {
  if (!envelope.event_type.startsWith('production_order.')) return;
  if (isEdgeCentralOnlyProductionEvent(envelope)) {
    throw new AppError(
      403,
      'CENTRAL_ONLY_OPERATION',
      'Closing a production order must be performed centrally, not from an edge device',
      { event_type: envelope.event_type, new_status: 'closed' },
    );
  }
  if (EDGE_PRODUCTION_EVENT_TYPES.has(envelope.event_type)) return;
  throw new AppError(
    403,
    'CENTRAL_ONLY_OPERATION',
    'This production operation must be performed centrally, not from an edge device',
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
