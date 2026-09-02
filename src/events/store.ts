import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import type { PoolClient } from 'pg';
import { logAuditEntry } from '../read/projections/audit_log.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { isAuditTamperError, recordTamperAttempt } from '../middleware/audit-tamper-guard.js';
import { assertInventoryTagging } from '../compliance/business-stream.js';
import { assertCalibrationLockout } from '../compliance/calibration.js';
import { assertWeighbridgeStampLockout } from '../compliance/weighbridge.js';
import { assertLocationInvariant } from '../compliance/location.js';
import { assertInventoryMasterReferences } from '../compliance/inventory-master.js';
import {
  assertStockBalanceShape,
  applyStockBalanceProjection,
} from '../compliance/stock-balance.js';
import {
  assertLotSerialShape,
  applyLotSerialValidation,
} from '../compliance/lot-serial-validation.js';
import {
  assertValuationShape,
  applyInventoryValuationProjection,
} from '../compliance/inventory-valuation.js';
import {
  assertTransferRequestShape,
  assertTransferShipShape,
  assertTransferReceiveShape,
  applyTransferRequestProjection,
  applyTransferShipProjection,
  applyTransferReceiveProjection,
} from '../compliance/transfer-request.js';
import { assertCycleCountShape, applyCycleCountProjection } from '../compliance/cycle-count.js';
import {
  assertInventoryPlanningShape,
  applyInventoryPlanningProjection,
} from '../compliance/inventory-planning.js';
import { assertOwnershipShape, applyOwnershipProjection } from '../compliance/ownership.js';
import {
  assertGateEnteredShape,
  assertGateReversedShape,
  applyGateProjection,
} from '../compliance/gate.js';
import {
  assertWeighbridgeRecordedShape,
  applyWeighbridgeProjection,
} from '../compliance/weighbridge.js';
import {
  assertGoodsReceivedShape,
  assertGoodsPutawayReleasedShape,
  applyGoodsReceivedProjection,
  applyGoodsPutawayReleasedProjection,
} from '../compliance/receiving.js';
import {
  assertPutawayCompletedShape,
  assertLocationOverrideShape,
  applyPutawayCompletedProjection,
} from '../compliance/putaway.js';
import {
  assertPickTaskCreatedShape,
  assertPickLineConfirmedShape,
  assertPickTaskCompletedShape,
  applyPickTaskCreatedProjection,
  applyPickLineConfirmedProjection,
  applyPickTaskCompletedProjection,
} from '../compliance/pick.js';
import {
  assertDispatchPackedShape,
  assertDispatchShippingDocumentsGeneratedShape,
  assertDispatchDispatchedShape,
  applyDispatchPackedProjection,
  applyDispatchShippingDocumentsGeneratedProjection,
  applyDispatchDispatchedProjection,
} from '../compliance/dispatch.js';
import {
  assertTaskSlaConfigUpdatedShape,
  applyTaskSlaConfigUpdatedProjection,
  assertPutawayTaskAssignedShape,
  applyPutawayTaskAssignedProjection,
  assertPickTaskAssignedShape,
  applyPickTaskAssignedProjection,
} from '../compliance/warehouse-task.js';
import {
  assertForwardPickConfigUpdatedShape,
  applyForwardPickConfigUpdatedProjection,
  assertReplenishmentTaskCreatedShape,
  applyReplenishmentTaskCreatedProjection,
  assertReplenishmentTaskAssignedShape,
  applyReplenishmentTaskAssignedProjection,
  assertReplenishmentTaskCompletedShape,
  applyReplenishmentTaskCompletedProjection,
} from '../compliance/replenishment.js';
import {
  assertCrossDockEventShape,
  applyCrossDockTaskAssignedProjection,
  applyCrossDockTaskCompletedProjection,
} from '../compliance/cross-dock.js';
import { assertSupplierShape, applySupplierProjection } from '../compliance/supplier.js';
import { assertIndentShape, applyIndentProjection } from '../compliance/indent.js';
import {
  assertPurchaseOrderShape,
  applyPurchaseOrderProjection,
} from '../compliance/purchase-order.js';
import { assertBomShape, applyBomProjection } from '../compliance/bom.js';
import { assertEcoShape, applyEcoProjection } from '../compliance/eco.js';
import { assertRdShape, applyRdProjection } from '../compliance/rd-bom.js';
import {
  assertBomExecutionShape,
  applyBomExecutionProjection,
} from '../compliance/bom-execution.js';
import { assertBomCostingShape, applyBomCostingProjection } from '../compliance/bom-costing.js';
import {
  assertSupplierInvoiceShape,
  applySupplierInvoiceProjection,
  resolveSupplierInvoiceDuplicateConflict,
} from '../compliance/supplier-invoice.js';
import { assertMsmeShape, applyMsmeProjection } from '../compliance/msme.js';
import {
  assertSupplierScorecardShape,
  applySupplierScorecardProjection,
} from '../compliance/supplier-scorecard.js';
import {
  assertThreeWayMatchShape,
  applyThreeWayMatchProjection,
} from '../compliance/three-way-match.js';
import {
  assertAssetShape,
  applyAssetProjection,
  resolveAssetDuplicateConflict,
} from '../compliance/asset.js';
import {
  assertAssetMeterShape,
  applyAssetMeterProjection,
  resolveMeterDuplicateConflict,
} from '../compliance/asset-meter.js';
import {
  assertMaintenancePlanShape,
  applyMaintenancePlanProjection,
  resolvePlanDuplicateConflict,
  resolveWorkOrderDuplicateConflict,
} from '../compliance/maintenance-plan.js';
import {
  assertMaintenanceFaultShape,
  applyMaintenanceFaultProjection,
  resolveSlaPolicyDuplicateConflict,
  resolveFaultTriageConflict,
  resolveDowntimeConflict,
} from '../compliance/maintenance-fault.js';
import {
  assertMaintenanceReliabilityShape,
  applyMaintenanceReliabilityProjection,
  resolveReliabilityReportConflict,
} from '../compliance/maintenance-reliability.js';
import {
  assertMaintenanceSpareShape,
  applyMaintenanceSpareProjection,
  resolveSpareCatalogueDuplicateConflict,
  resolveAssetPartDuplicateConflict,
  resolveSpareAlertDuplicateConflict,
} from '../compliance/maintenance-spares.js';
import {
  assertCalibrationRegisterShape,
  applyCalibrationRegisterProjection,
  resolveInstrumentRegisterDuplicateConflict,
  resolveInstrumentAssetDuplicateConflict,
  resolveCertificateNumberDuplicateConflict,
  resolveActiveCertificateDuplicateConflict,
  resolveCalibrationAlertDuplicateConflict,
  resolveOpenEscalationDuplicateConflict,
} from '../compliance/calibration-register.js';
import {
  assertStatutoryExaminationShape,
  applyStatutoryExaminationProjection,
  resolveStatutoryExaminationDuplicateConflict,
  resolveStatutoryDeviceKeyDuplicateConflict,
  resolveStatutoryRecordDuplicateConflict,
} from '../compliance/maintenance-statutory.js';
import {
  assertAssetStatusChangedShape,
  applyAssetOperationalStatusProjection,
} from '../compliance/asset-operational-status.js';
import {
  assertMaintenanceCoverageShape,
  applyMaintenanceCoverageProjection,
  resolveCoverageDuplicateConflict,
  resolveCoverageAlertDuplicateConflict,
  resolveWarrantyOverrideDuplicateConflict,
} from '../compliance/maintenance-coverage.js';
import {
  assertMaintenanceSyncConflictShape,
  applyMaintenanceSyncConflictProjection,
  resolveSyncConflictDuplicateConflict,
} from '../compliance/maintenance-sync-conflict.js';
import {
  assertProductionOrderShape,
  applyProductionOrderProjection,
  resolveProductionOrderNumberDuplicateConflict,
} from '../compliance/production-order.js';
import {
  assertQualityForeignStreamRejected,
  assertQualityShape,
  applyQualityProjection,
  resolveInspectionPlanGrainDuplicateConflict,
  resolveInspectionPlanEffectivityDuplicateConflict,
  resolveQcCompletionDuplicateConflict,
  resolveQcDispositionDuplicateConflict,
  resolveQcSamplingDuplicateConflict,
  resolveQcResultDuplicateConflict,
  resolveQcReleaseDuplicateConflict,
  resolveQcRetentionSampleDuplicateConflict,
  resolveQcHoldDuplicateConflict,
  resolveQcCapaDuplicateConflict,
} from '../compliance/quality.js';
import {
  assertComplianceMasterDataShape,
  applyComplianceMasterDataProjection,
  resolveBisLicenceExistsDuplicateConflict,
  resolveLabelVersionExistsDuplicateConflict,
} from '../compliance/master-data.js';
import { assertQcWitnessShape, applyQcWitnessProjection } from '../compliance/qc-witness.js';
import {
  assertServiceOrderShape,
  applyServiceOrderProjection,
} from '../compliance/service-order.js';
import {
  assertJobworkMaterialReceivedShape,
  applyJobworkMaterialReceivedProjection,
} from '../compliance/jobwork-receipt.js';
import {
  assertProductionMaterialShape,
  applyProductionMaterialProjection,
} from '../compliance/production-material.js';
// Story 6.3: production completions, process scrap and the close-short decision (FR-MO-07/08/09).
import {
  assertProductionCompletionShape,
  applyProductionCompletionProjection,
} from '../compliance/production-completion.js';
import { resolveProductionOrderStageLineDuplicateConflict } from '../read/projections/production_order_stage.js';
import type {
  PickTaskCreatedEnvelope,
  PickLineConfirmedEnvelope,
  PickTaskCompletedEnvelope,
  PutawayCompletedEnvelope,
  LocationOverrideEnvelope,
  DispatchPackedEnvelope,
  DispatchShippingDocumentsGeneratedEnvelope,
  DispatchDispatchedEnvelope,
  TaskSlaConfigUpdatedEnvelope,
  PutawayTaskAssignedEnvelope,
  PickTaskAssignedEnvelope,
  ForwardPickConfigUpdatedEnvelope,
  ReplenishmentTaskCreatedEnvelope,
  ReplenishmentTaskAssignedEnvelope,
  ReplenishmentTaskCompletedEnvelope,
  CrossDockTaskAssignedEnvelope,
  CrossDockTaskCompletedEnvelope,
} from './schema.js';
import { assertErpReadOnly } from '../compliance/erp-readonly.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface EventEnvelope {
  event_id?: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  event_version?: number;
  payload: Record<string, unknown>;
  metadata: {
    correlation_id: string;
    causation_id?: string | null;
    actor: {
      user_id: string;
      role: string;
      location_id: string;
    };
    device_id?: string | null;
    capture_method?: 'AUTO' | 'MANUAL';
    occurred_at: string;
    synced_at?: string | null;
  };
  schema_version?: number;
  idempotency_key?: string | null;
}

export interface PersistedEvent extends EventEnvelope {
  event_id: string;
  event_version: number;
  schema_version: number;
  created_at: string;
}

export function validateEnvelope(body: unknown): asserts body is EventEnvelope {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'Request body must be a JSON object');
  }

  const obj = body as Record<string, unknown>;

  if (obj['event_id'] !== undefined && !isUuid(obj['event_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_id must be a valid UUID');
  }

  if (!isNonEmptyString(obj['stream_type'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'stream_type is required and must be a non-empty string',
    );
  }

  if (!isUuid(obj['stream_id'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'stream_id is required and must be a valid UUID',
    );
  }

  if (!isNonEmptyString(obj['event_type'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'event_type is required and must be a non-empty string',
    );
  }

  if (
    obj['event_version'] !== undefined &&
    (!Number.isInteger(obj['event_version']) || (obj['event_version'] as number) <= 0)
  ) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_version must be a positive integer');
  }

  if (
    obj['schema_version'] !== undefined &&
    (!Number.isInteger(obj['schema_version']) || (obj['schema_version'] as number) <= 0)
  ) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'schema_version must be a positive integer');
  }

  if (
    obj['idempotency_key'] !== undefined &&
    obj['idempotency_key'] !== null &&
    typeof obj['idempotency_key'] !== 'string'
  ) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'idempotency_key must be a string or null');
  }

  if (
    typeof obj['payload'] !== 'object' ||
    obj['payload'] === null ||
    Array.isArray(obj['payload'])
  ) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'payload is required and must be a JSON object',
    );
  }

  if (
    typeof obj['metadata'] !== 'object' ||
    obj['metadata'] === null ||
    Array.isArray(obj['metadata'])
  ) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata is required and must be a JSON object',
    );
  }

  const meta = obj['metadata'] as Record<string, unknown>;

  if (!isUuid(meta['correlation_id'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.correlation_id is required and must be a valid UUID',
    );
  }

  if (typeof meta['actor'] !== 'object' || meta['actor'] === null || Array.isArray(meta['actor'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.actor is required and must be an object',
    );
  }

  const actor = meta['actor'] as Record<string, unknown>;
  if (!isUuid(actor['user_id'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.actor.user_id is required and must be a valid UUID',
    );
  }
  if (!isNonEmptyString(actor['role'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.actor.role is required and must be a non-empty string',
    );
  }
  if (!isUuid(actor['location_id'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.actor.location_id is required and must be a valid UUID',
    );
  }

  const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof meta['occurred_at'] !== 'string' || !ISO8601_REGEX.test(meta['occurred_at'])) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.occurred_at is required and must be a valid ISO-8601 timestamp',
    );
  }

  if (
    meta['causation_id'] !== undefined &&
    meta['causation_id'] !== null &&
    !isUuid(meta['causation_id'])
  ) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.causation_id must be a valid UUID or null',
    );
  }

  if (
    meta['capture_method'] !== undefined &&
    meta['capture_method'] !== 'AUTO' &&
    meta['capture_method'] !== 'MANUAL'
  ) {
    throw new AppError(
      400,
      'INVALID_EVENT_ENVELOPE',
      'metadata.capture_method must be AUTO or MANUAL',
    );
  }
}

function mapRowToEvent(row: Record<string, unknown>): PersistedEvent {
  const createdAt =
    row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    event_id: row['event_id'] as string,
    stream_type: row['stream_type'] as string,
    stream_id: row['stream_id'] as string,
    event_type: row['event_type'] as string,
    event_version: row['event_version'] as number,
    payload: row['payload'] as Record<string, unknown>,
    metadata: row['metadata'] as PersistedEvent['metadata'],
    schema_version: row['schema_version'] as number,
    idempotency_key: row['idempotency_key'] as string | null,
    created_at: createdAt,
  };
}

/**
 * The event families whose appliers write the NUMERIC(14,3) maintenance cost columns, and so the
 * only ones for which a SQLSTATE 22003 means a cost magnitude problem.
 */
const COST_BEARING_EVENT_TYPES = new Set(['maintenance.work_order_completed']);

export async function persistEvent(
  envelope: EventEnvelope,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
  externalClient?: PoolClient,
  opts?: { strictDuplicate?: boolean },
): Promise<PersistedEvent> {
  // FR-AC-01 (Story 1.5): business-stream tagging is enforced HERE, on the central write path,
  // not in the HTTP handler - so the public POST /api/v1/events, the Story 1.8 edge sync
  // replication, and any future internal adapter are all gated by construction. The check runs
  // BEFORE any DB write (and before the transaction below), so an untagged inventory movement is
  // rejected without consuming an idempotency key or touching domain_events. Non-inventory
  // stream types (DOA registry, SCIM users, audit, tagging config itself) return immediately
  // inside assertInventoryTagging - byte-for-byte unaffected.
  // Story 8.1 (Task 3): a Story 8.1 event NAME on any stream other than 'qc' is rejected before
  // any other assert can give it a different, misleading rejection (or, for a non-inventory
  // stream, let it through to be silently ignored by every applier).
  assertQualityForeignStreamRejected(envelope);
  await assertInventoryTagging(envelope);
  await assertCalibrationLockout(envelope);
  // Story 7.6 (FR-M-14, AC 2): the weighbridge trade-weighment lockout runs with the other
  // pre-transaction asserts, BEFORE any DB write, so a weighment on a weighbridge whose statutory
  // stamp is overdue is rejected 423 WEIGHBRIDGE_OUT_OF_STAMP without consuming an idempotency key.
  // It is a DB-backed read (getExaminationByDeviceKey), like assertCalibrationLockout; fail-open for
  // device keys not in the register, so the existing story-3-2/3-3/3-4 suites are unchanged.
  await assertWeighbridgeStampLockout(envelope);
  // Story 2.1: inventory master validation (SKU existence, target-location existence, actor
  // location registration, zone compatibility) also runs BEFORE any DB write, gated to inventory
  // events that actually reference master fields. May throw ZoneIncompatibleWarning (not an
  // AppError) - the movement HTTP handlers translate it into a 200 warning envelope.
  await assertInventoryMasterReferences(envelope);
  // Story 2.2: stock-balance shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed stock event never consumes an idempotency key. The balance itself is
  // applied inside the transaction below.
  assertStockBalanceShape(envelope);
  // Story 2.3: lot/serial shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed lot/serial event never consumes an idempotency key.
  assertLotSerialShape(envelope);
  // Story 2.4: valuation shape validation (NRV write-down/recovery/standard-cost-variance payload
  // fields) is non-DB and runs with the other pre-transaction asserts, so a malformed valuation
  // event never consumes an idempotency key. stock.received/stock.issued unit_cost shape is
  // already covered by assertStockBalanceShape above.
  assertValuationShape(envelope);
  // Story 2.5: transfer-request shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed transfer-request event never consumes an idempotency key.
  assertTransferRequestShape(envelope);
  assertTransferShipShape(envelope);
  assertTransferReceiveShape(envelope);
  // Story 2.6: cycle-count / physical-verification shape validation is non-DB and runs with the
  // other pre-transaction asserts, so a malformed count event never consumes an idempotency key.
  assertCycleCountShape(envelope);
  // Story 2.7: inventory-planning shape validation (params, safety-stock computation, replenishment
  // recommendation, obsolescence flag/clear) is non-DB and runs with the other pre-transaction
  // asserts, so a malformed planning event never consumes an idempotency key.
  assertInventoryPlanningShape(envelope);
  // Story 2.8: ownership-agreement shape validation (consignment/VMI segregation config) is non-DB
  // and runs with the other pre-transaction asserts, so a malformed agreement event never consumes
  // an idempotency key. The consignment/vmi receipt owner-party gate runs in-transaction inside
  // applyStockBalanceProjection.
  assertOwnershipShape(envelope);
  assertGateEnteredShape(envelope);
  assertGateReversedShape(envelope);
  // Story 3.3: weighbridge shape validation (tare/gross/binding-token presence, net = gross - tare
  // computed in exact integer milli-kg) is non-DB and runs with the other pre-transaction asserts,
  // so a malformed weighment never consumes an idempotency key.
  assertWeighbridgeRecordedShape(envelope);
  // Story 3.4: goods-receiving shape validation (binding-token/PO/qty presence, expiry-date shape,
  // quarantine-reason presence) is non-DB and runs with the other pre-transaction asserts, so a
  // malformed receiving event never consumes an idempotency key.
  assertGoodsReceivedShape(envelope);
  assertGoodsPutawayReleasedShape(envelope);
  // Story 3.5: putaway-completion and location-override shape validation (putaway_task_id presence,
  // actual location and override_confidence when override_reason_code is supplied) is non-DB and
  // runs with the other pre-transaction asserts, so a malformed putaway event never consumes an
  // idempotency key.
  if (envelope.event_type === 'putaway.completed') {
    assertPutawayCompletedShape(envelope as unknown as PutawayCompletedEnvelope);
  }
  if (envelope.event_type === 'location.override') {
    assertLocationOverrideShape(envelope as unknown as LocationOverrideEnvelope);
  }
  // Story 3.6: pick-task shape validation (task/line/completion payload fields) is non-DB and runs
  // with the other pre-transaction asserts, so a malformed pick event never consumes an
  // idempotency key.
  if (envelope.event_type === 'pick_task.created') {
    assertPickTaskCreatedShape(envelope as unknown as PickTaskCreatedEnvelope);
  }
  if (envelope.event_type === 'pick_line.confirmed') {
    assertPickLineConfirmedShape(envelope as unknown as PickLineConfirmedEnvelope);
  }
  if (envelope.event_type === 'pick_task.completed') {
    assertPickTaskCompletedShape(envelope as unknown as PickTaskCompletedEnvelope);
  }
  // Story 3.7: dispatch shape validation (packed, documents-generated, dispatched) is non-DB and
  // runs with the other pre-transaction asserts, so a malformed dispatch event never consumes an
  // idempotency key.
  if (envelope.event_type === 'dispatch.packed') {
    assertDispatchPackedShape(envelope as unknown as DispatchPackedEnvelope);
  }
  if (envelope.event_type === 'dispatch.shipping_documents_generated') {
    assertDispatchShippingDocumentsGeneratedShape(
      envelope as unknown as DispatchShippingDocumentsGeneratedEnvelope,
    );
  }
  if (envelope.event_type === 'dispatch.dispatched') {
    assertDispatchDispatchedShape(envelope as unknown as DispatchDispatchedEnvelope);
  }
  // Story 3.8: task SLA threshold shape validation (task_type, threshold_minutes, optional zone_id)
  // is non-DB and runs with the other pre-transaction asserts, so a malformed threshold change never
  // consumes an idempotency key.
  if (envelope.event_type === 'task_sla_config.updated') {
    assertTaskSlaConfigUpdatedShape(envelope as unknown as TaskSlaConfigUpdatedEnvelope);
  }
  // Story 3.8 code review: assignment shape validation (task id, assigned_to, optional priority) is
  // likewise non-DB and belongs with the other pre-transaction asserts.
  if (envelope.event_type === 'putaway_task.assigned') {
    assertPutawayTaskAssignedShape(envelope as unknown as PutawayTaskAssignedEnvelope);
  }
  if (envelope.event_type === 'pick_task.assigned') {
    assertPickTaskAssignedShape(envelope as unknown as PickTaskAssignedEnvelope);
  }
  // Story 3.9: forward-pick replenishment shape validation (config threshold, task creation,
  // task completion) is non-DB and runs with the other pre-transaction asserts, so a malformed
  // payload never consumes an idempotency key.
  if (envelope.event_type === 'forward_pick_config.updated') {
    assertForwardPickConfigUpdatedShape(envelope as unknown as ForwardPickConfigUpdatedEnvelope);
  }
  if (envelope.event_type === 'replenishment_task.created') {
    assertReplenishmentTaskCreatedShape(envelope as unknown as ReplenishmentTaskCreatedEnvelope);
  }
  if (envelope.event_type === 'replenishment_task.assigned') {
    assertReplenishmentTaskAssignedShape(envelope as unknown as ReplenishmentTaskAssignedEnvelope);
  }
  if (envelope.event_type === 'replenishment_task.completed') {
    assertReplenishmentTaskCompletedShape(
      envelope as unknown as ReplenishmentTaskCompletedEnvelope,
    );
  }
  assertCrossDockEventShape(envelope);
  // Story 4.1: supplier lifecycle shape validation (supplier creation, onboarding submission,
  // approval, rejection, update, deactivation) is non-DB and runs with the other pre-transaction
  // asserts, so a malformed supplier event never consumes an idempotency key.
  assertSupplierShape(envelope);
  // Story 4.3: indent (purchase requisition) shape validation is non-DB and runs with the other
  // pre-transaction asserts, so a malformed indent event never consumes an idempotency key.
  assertIndentShape(envelope);
  // Story 4.4: purchase order shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed purchase_order event never consumes an idempotency key.
  assertPurchaseOrderShape(envelope);
  // Story 5.1: BOM shape validation is non-DB and runs with the other pre-transaction asserts,
  // so a malformed BOM event never consumes an idempotency key.
  assertBomShape(envelope);
  // Story 5.3: ECO shape validation is non-DB and runs with the other pre-transaction asserts,
  // so a malformed ECO event never consumes an idempotency key.
  assertEcoShape(envelope);
  // Story 5.4: R&D draft BOM regime shape validation is non-DB and runs with the other
  // pre-transaction asserts, so a malformed rd_* event never consumes an idempotency key.
  assertRdShape(envelope);
  // Story 5.5: alternate / substitution / explosion shape validation is non-DB and runs with the
  // other pre-transaction asserts, so a malformed execution event never consumes an idempotency key.
  assertBomExecutionShape(envelope);
  // Story 5.6: cost rollup / kit tagging / inbound-sync-conflict shape validation is non-DB and
  // runs with the other pre-transaction asserts, so a malformed costing event never consumes an
  // idempotency key.
  assertBomCostingShape(envelope);
  // Story 4.7: supplier invoice / invoice-ingestion shape validation is non-DB and runs with the
  // other pre-transaction asserts, so a malformed invoice event never consumes an idempotency key.
  assertSupplierInvoiceShape(envelope);
  // Story 4.6: MSME compliance shape validation (Udyam format/certificate gate, suspension,
  // breach flag, ageing feed) is non-DB and runs with the other pre-transaction asserts, so a
  // malformed MSME event never consumes an idempotency key.
  assertMsmeShape(envelope);
  // Story 4.2: supplier scorecard shape validation (metric kind enum, strict UUIDs, NUMERIC
  // scale, calendar-date rollover) is non-DB and runs with the other pre-transaction asserts, so
  // a malformed scorecard event never consumes an idempotency key.
  assertSupplierScorecardShape(envelope);
  // Story 7.1: asset register shape validation (strict UUID, required tag/name, criticality
  // vocabulary) is non-DB and runs with the other pre-transaction asserts, so a malformed asset
  // event never consumes an idempotency key.
  assertAssetShape(envelope);
  // Story 7.2: meter register / reading ingestion and PM plan / work order shape validation is
  // non-DB and runs with the other pre-transaction asserts, so a malformed maintenance event never
  // consumes an idempotency key.
  assertAssetMeterShape(envelope);
  assertMaintenancePlanShape(envelope);
  // Story 7.3: fault reporting / SLA policy / breakdown work order / downtime shape validation is
  // non-DB and runs with the other pre-transaction asserts, so a malformed maintenance event never
  // consumes an idempotency key.
  assertMaintenanceFaultShape(envelope);
  assertMaintenanceReliabilityShape(envelope);
  // Story 7.4: spare catalogue / parts list / reservation lifecycle / alert shape validation is
  // non-DB and runs with the other pre-transaction asserts, so a malformed spare event never
  // consumes an idempotency key.
  assertMaintenanceSpareShape(envelope);
  // Story 7.5: instrument registration / certificate / staged alert / expiry / escalation shape
  // validation is non-DB and runs with the other pre-transaction asserts, so a malformed
  // calibration event never consumes an idempotency key.
  assertCalibrationRegisterShape(envelope);
  // Story 7.6: statutory examination record/overdue shape validation (strict UUIDs, enum
  // vocabulary, DATE and TIMESTAMPTZ formats, bounded interval) is non-DB and runs with the other
  // pre-transaction asserts, so a malformed statutory event never consumes an idempotency key.
  assertStatutoryExaminationShape(envelope);
  // Story 7.6: machine status transition shape validation (Table 5 vocabulary, sign-off fields)
  // is non-DB and runs with the other pre-transaction asserts.
  assertAssetStatusChangedShape(envelope);
  // Story 7.7: coverage recording / staged expiry flag / warranty override shape validation
  // (strict UUIDs, the coverage-type enum, DATE round-trip validity, explicit-offset timestamps,
  // exact-decimal contract_value) is non-DB and runs with the other pre-transaction asserts, so a
  // malformed coverage event never consumes an idempotency key.
  assertMaintenanceCoverageShape(envelope);
  // Story 7.8: sync-conflict raise / resolve shape validation (strict UUIDs, the reason and
  // resolution enums with their pairing rules, explicit-offset timestamps) is non-DB and runs with
  // the other pre-transaction asserts, so a malformed conflict event never consumes an idempotency
  // key. The Story 7.8 work_order_status_updated shape rides assertMaintenancePlanShape above.
  assertMaintenanceSyncConflictShape(envelope);
  // Story 6.1: production order lifecycle shape validation (strict UUIDs, exact decimal order
  // quantity, the source-reference enum, the state vocabulary, the expediting pairing) is non-DB
  // and runs with the other pre-transaction asserts, so a malformed production event never
  // consumes an idempotency key. AC1's UNTAGGED_TRANSACTION fires in assertInventoryTagging for
  // production_order.created (requiresBusinessStream true); this assert adds the shape rules.
  assertProductionOrderShape(envelope);
  // Story 6.2: production material shape validation (staging lines, bounded issue quantity,
  // confirmation/return contracts, mandatory reason codes) is non-DB and runs with the other
  // pre-transaction asserts, so a malformed material event never consumes an idempotency key.
  assertProductionMaterialShape(envelope);
  // Story 6.3: completion / scrap / close-short shape validation is non-DB and runs with the other
  // pre-transaction asserts, so a malformed completion never consumes an idempotency key.
  assertProductionCompletionShape(envelope);
  // Story 8.1: inspection-plan and QC-gate shape validation (strict UUIDs, decimal-string
  // quantities, characteristic kind/limit pairing, calendar dates, explicit-offset timestamps, the
  // declared-derived-field rejections) is non-DB and runs with the other pre-transaction asserts,
  // so a malformed QC event never consumes an idempotency key. It also rejects a Story 8.1 event
  // name on any stream other than 'qc' (the stream-mismatch bypass closure, Task 3). The Story 1.7
  // qc.result_recorded calibration lockout above is untouched.
  assertQualityShape(envelope);
  // Story 8.7: compliance master-data shape validation (BIS licence register CRUD, expiry-flag
  // stage vocabulary, label draft/approval, the declared-derived-field rejections) is non-DB and
  // runs with the other pre-transaction asserts, so a malformed compliance event never consumes an
  // idempotency key.
  assertComplianceMasterDataShape(envelope);
  // Story 8.8: witness hold-point shape validation (inspection_type/method vocabularies, the
  // SERVER-CAPTURED waiver quartet, the declared-derived rejections) is non-DB and runs here with
  // the other pre-transaction asserts.
  assertQcWitnessShape(envelope);
  // Story 9.1: job-work service order shape validation (strict UUIDs, the governed
  // customer_party_code short code, calendar dates, the price-basis contract, the
  // declared-derived-field rejections) is non-DB and runs with the other pre-transaction
  // asserts, so a malformed jobwork event never consumes an idempotency key. It also rejects a
  // jobwork.* event name on any other stream (the Story 8.1 stream-mismatch closure).
  assertServiceOrderShape(envelope);
  // Story 9.2: customer-material receipt shape validation (closed shape, strict UUIDs, calendar
  // challan_date, strictly positive NUMERIC-string quantities, the derived variance fields
  // refused on input) is non-DB and runs with the other pre-transaction asserts.
  assertJobworkMaterialReceivedShape(envelope);
  assertThreeWayMatchShape(envelope);
  // Story 2.9: ERP reference projections are read-only to the platform (INT-ERP-01). Reject any
  // `erp` stream_type or `erp.*` event_type here, on the central write path, so a direct event POST
  // or an edge upload cannot fabricate ERP reference rows. Narrowly gated - every existing stream
  // passes through byte-for-byte and the Story 1.9 spine gate stays green.
  assertErpReadOnly(envelope);

  const pool = getPool();
  const eventId = envelope.event_id ?? randomUUID();
  const syncedAt = new Date().toISOString();

  const metadata = {
    ...envelope.metadata,
    synced_at: syncedAt,
  };

  // When the caller supplies a transaction client, this write joins the caller's transaction so the
  // caller's own row (e.g. a DOA registry entry - Story 1.4) and this domain event + audit entry
  // commit atomically. Otherwise persistEvent owns a fresh connection with its own BEGIN/COMMIT,
  // exactly as before - fully backward compatible with every existing caller.
  const ownsTransaction = externalClient === undefined;
  const client: PoolClient = externalClient ?? (await pool.connect());
  try {
    if (ownsTransaction) await client.query('BEGIN');

    // Idempotency short-circuit BEFORE any projection runs, so a retried assignment event whose
    // task has since changed status still returns DUPLICATE_EVENT instead of a 409 task conflict.
    // The domain_events unique key catches a concurrent retry; this one catches a sequential one
    // without taking a write lock on a projection the caller never wanted to touch again. A NULL
    // idempotency_key is treated as "not supplied" rather than a wildcard that matches every
    // existing event without an idempotency key, which would 409 every request that omits the
    // field - the original unique constraint is not a wildcard either.
    // When a duplicate event_id or idempotency_key is found, return the existing event (2xx-style
    // no-op) instead of throwing 409, so an identical replay is indistinguishable from success.
    if (envelope.idempotency_key || envelope.event_id) {
      const existing = await client.query(
        `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
          FROM domain_events
          WHERE ($1::text IS NOT NULL AND idempotency_key = $1::text)
             OR event_id = $2::uuid
          LIMIT 1`,
        [envelope.idempotency_key ?? null, eventId],
      );
      if (existing.rows.length > 0) {
        if (opts?.strictDuplicate === true) {
          const row = existing.rows[0]!;
          throw new AppError(409, 'DUPLICATE_EVENT', 'Event already exists', {
            existing_event_id: row.event_id,
            existing_event_type: row.event_type,
          });
        }
        if (ownsTransaction) await client.query('COMMIT');
        return mapRowToEvent(existing.rows[0]!);
      }
    }

    await applyLotSerialValidation(envelope, client, eventId);
    await applyStockBalanceProjection(envelope, client);
    // Story 2.4: valuation runs AFTER lot/serial resolution (so an auto-selected lot/effective
    // serial set is settled) and stock-balance validation (so an insufficient-stock rejection
    // rolls back before valuation ever mutates), but still inside this same transaction and
    // BEFORE the domain_events insert below - a rejected write-down/recovery therefore writes no
    // event row and consumes no idempotency key (Dev Notes: Valuation Design Guardrails).
    await applyInventoryValuationProjection(envelope, client, eventId);
    // Story 2.5: transfer-request, ship, and receive enforcement run inside the
    // same transaction as the domain_events insert so that allocation and event commit atomically.
    await applyTransferRequestProjection(envelope, client);
    await applyTransferShipProjection(envelope, client, eventId);
    await applyTransferReceiveProjection(envelope, client);
    // Story 2.6: cycle-count variance computation, DOA-gated adjustment lifecycle, approved
    // stock adjustments, and physical-verification evidence run inside this same transaction so
    // the projection and the domain_events insert commit or roll back together. The AC2 guard
    // (stock.adjusted requires an approved adjustment) lives in applyCycleCountProjection.
    await applyCycleCountProjection(envelope, client, eventId);
    // Story 2.7: inventory-planning params, safety-stock/reorder-point computation, replenishment
    // recommendation, and obsolescence flag/clear run inside this same transaction so the
    // projection and the domain_events insert commit or roll back together. The reorder-crossing
    // and obsolescence-transition decisions (and their transactional planner alerts) live in the
    // planning jobs, which hold the params/flag row lock across read -> decide -> persist.
    await applyInventoryPlanningProjection(envelope, client, eventId);
    // Story 2.8: ownership agreement upsert (consignment/VMI segregation config) runs inside this
    // same transaction so the registry row and the domain_events insert commit or roll back
    // together. Receipt-side owner-party enforcement lives in applyStockBalanceProjection above.
    await applyOwnershipProjection(envelope, client);
    await applyGateProjection(envelope, client, eventId);
    // Story 3.3: weighbridge tolerance enforcement resolves the binding token to its gate event,
    // enforces the site match, computes the tolerance band against the Story 2.9 open-PO line in
    // SQL NUMERIC, and upserts the weighbridge_event row inside this same transaction.
    await applyWeighbridgeProjection(envelope, client, eventId);
    // Story 3.4: goods receiving consumes the accepted-weighment binding token, computes the PO
    // tolerance band in SQL NUMERIC, routes QC-hold/quarantine/over-tolerance outcomes, and posts
    // stock through a synthetic stock.received view - all inside this same transaction so the GRN
    // line, the stock movement, and the domain_events insert commit or roll back together.
    await applyGoodsReceivedProjection(envelope, client, eventId);
    await applyGoodsPutawayReleasedProjection(envelope, client, eventId);
    // Story 3.5: putaway completion records the actual location and any override against the directed
    // suggestion, updates the Story 1.6 location asserted/expected facts, and completes the putaway
    // task - all inside this same transaction so the location facts and the domain_events insert
    // commit or roll back together.
    if (envelope.event_type === 'putaway.completed') {
      const payload = envelope.payload as Record<string, unknown>;
      await applyPutawayCompletedProjection(
        {
          putawayTaskId: payload.putaway_task_id as string,
          actualLocationId: payload.actual_location_id as string | undefined,
          actualLocationCode: payload.actual_location_code as string | undefined,
          overrideReasonCode: payload.override_reason_code as string | undefined,
          overrideConfidence: payload.override_confidence as 'certain' | 'uncertain' | undefined,
          completedBy: payload.completed_by as string,
          eventId,
        },
        client,
      );
    }
    // Story 3.6: pick task creation inserts the task + pick lines and allocates stock; pick line
    // confirmation records the picked lot (with substitution release/reallocate); pick task
    // completion enforces all-lines-confirmed, notifies packing, and flags the dispatch order
    // picked - all inside this same transaction so the projections, the stock allocation, and
    // the domain_events insert commit or roll back together.
    if (envelope.event_type === 'pick_task.created') {
      await applyPickTaskCreatedProjection(
        envelope as unknown as PickTaskCreatedEnvelope,
        client,
        eventId,
      );
    }
    if (envelope.event_type === 'pick_line.confirmed') {
      await applyPickLineConfirmedProjection(
        envelope as unknown as PickLineConfirmedEnvelope,
        client,
        eventId,
      );
    }
    if (envelope.event_type === 'pick_task.completed') {
      await applyPickTaskCompletedProjection(
        envelope as unknown as PickTaskCompletedEnvelope,
        client,
        eventId,
      );
    }
    // Story 3.7: dispatch operations - packing validation, document generation with LOT_ON_HOLD
    // check, dispatch confirmation with stock decrement - all inside this same transaction so
    // projections, stock movement, and domain_events insert commit or roll back together.
    if (envelope.event_type === 'dispatch.packed') {
      await applyDispatchPackedProjection(
        envelope as unknown as DispatchPackedEnvelope,
        client,
        eventId,
      );
    }
    if (envelope.event_type === 'dispatch.shipping_documents_generated') {
      await applyDispatchShippingDocumentsGeneratedProjection(
        envelope as unknown as DispatchShippingDocumentsGeneratedEnvelope,
        client,
        eventId,
      );
    }
    if (envelope.event_type === 'dispatch.dispatched') {
      await applyDispatchDispatchedProjection(
        envelope as unknown as DispatchDispatchedEnvelope,
        client,
        eventId,
      );
    }
    // Story 3.8: the task SLA threshold registry upsert, plus the supervisor-only SOD gate that
    // governs it. The gate lives in the seam, not only in the HTTP handler, so a direct
    // POST /api/v1/events call cannot change what counts as an SLA breach.
    if (envelope.event_type === 'task_sla_config.updated') {
      await applyTaskSlaConfigUpdatedProjection(
        envelope as unknown as TaskSlaConfigUpdatedEnvelope,
        client,
        eventId,
      );
    }
    // Story 3.8 code review: assignment is a domain event rather than a direct read-model write,
    // so it replays, audits, and passes the same supervisor SOD gate as the threshold registry.
    if (envelope.event_type === 'putaway_task.assigned') {
      await applyPutawayTaskAssignedProjection(
        envelope as unknown as PutawayTaskAssignedEnvelope,
        client,
      );
    }
    if (envelope.event_type === 'pick_task.assigned') {
      await applyPickTaskAssignedProjection(
        envelope as unknown as PickTaskAssignedEnvelope,
        client,
      );
    }
    // Story 3.9: forward-pick config upsert, replenishment task creation, and task completion
    // (which moves stock via applyStockIssue/applyStockReceipt directly) - all inside this same
    // transaction so the projections, the stock movement, and the domain_events insert commit or
    // roll back together.
    if (envelope.event_type === 'forward_pick_config.updated') {
      await applyForwardPickConfigUpdatedProjection(
        envelope as unknown as ForwardPickConfigUpdatedEnvelope,
        client,
      );
    }
    if (envelope.event_type === 'replenishment_task.created') {
      await applyReplenishmentTaskCreatedProjection(
        envelope as unknown as ReplenishmentTaskCreatedEnvelope,
        client,
        eventId,
      );
    }
    if (envelope.event_type === 'replenishment_task.assigned') {
      await applyReplenishmentTaskAssignedProjection(
        envelope as unknown as ReplenishmentTaskAssignedEnvelope,
        client,
      );
    }
    if (envelope.event_type === 'replenishment_task.completed') {
      await applyReplenishmentTaskCompletedProjection(
        envelope as unknown as ReplenishmentTaskCompletedEnvelope,
        client,
      );
    }
    if (envelope.event_type === 'cross_dock_task.assigned') {
      await applyCrossDockTaskAssignedProjection(
        envelope as unknown as CrossDockTaskAssignedEnvelope,
        client,
      );
    }
    if (envelope.event_type === 'cross_dock_task.completed') {
      await applyCrossDockTaskCompletedProjection(
        envelope as unknown as CrossDockTaskCompletedEnvelope,
        client,
        eventId,
      );
    }
    // Story 4.1: supplier registry projection (creation, onboarding lifecycle, update,
    // deactivation) runs inside this same transaction so the supplier row and the domain_events
    // insert commit or roll back together.
    await applySupplierProjection(envelope, client);
    // Story 4.3: indent (purchase requisition) projection runs inside this same transaction so
    // the indent row, its lines, the duplicate-hold audit event, and the domain_events insert
    // commit or roll back together.
    await applyIndentProjection(envelope, client, eventId);
    // Story 4.4: purchase order projection runs inside this same transaction so the PO row,
    // its lines, the outbound message, and the domain_events insert commit or roll back together.
    await applyPurchaseOrderProjection(envelope, client, eventId);
    // Story 5.1: BOM projection runs inside this same transaction so the BOM header, revision,
    // lines, and structure projection commit together with the domain_events insert.
    await applyBomProjection(envelope, client, eventId);
    // Story 5.3: ECO projection runs inside this same transaction so the ECO header, change
    // lines, stock dispositions, and (on implementation) the new BOM revision commit together
    // with the domain_events insert.
    await applyEcoProjection(envelope, client, eventId);
    // Story 5.4: R&D projection runs inside this same transaction so the cloned/productized BOM
    // header, revision, lines, build records, as-built snapshot, and sign-offs commit together
    // with the domain_events insert.
    await applyRdProjection(envelope, client, eventId);
    // Story 5.5: alternates, ad-hoc substitutions and explosion runs commit inside this same
    // transaction as the domain_events insert, so a requirement set can never outlive its event.
    await applyBomExecutionProjection(envelope, client, eventId);
    // Story 5.6: cost rollup snapshots, kit supply-source tags and the inbound-sync-conflict
    // convergence step commit inside this same transaction as the domain_events insert, so a
    // snapshot can never outlive its event.
    await applyBomCostingProjection(envelope, client, eventId);
    // Story 4.7: supplier invoice capture / file-ingestion review projection runs inside this
    // same transaction so the invoice header, lines, ingestion row, and the domain_events insert
    // commit or roll back together.
    await applySupplierInvoiceProjection(envelope, client, eventId);
    // Story 4.6: MSME compliance projection (Udyam verification/suspension on the supplier row,
    // statutory breach flag plus its transactional escalation, ageing feed ledger row) runs
    // inside this same transaction so the projection and the domain_events insert commit or roll
    // back together.
    await applyMsmeProjection(envelope, client);
    // Story 4.2: supplier scorecard metric projection (supplier-active gate, append-only metric
    // row, replay idempotency on metric_id plus the (reference_event_id, metric_kind) guard) runs
    // inside this same transaction so the metric row and the domain_events insert commit or roll
    // back together.
    await applySupplierScorecardProjection(envelope, client, eventId);
    // Story 7.1: asset register projection (FOR UPDATE duplicate detection on serial_number and
    // asset_tag, then the insert) runs inside this same transaction so the asset row and the
    // domain_events insert commit or roll back together.
    await applyAssetProjection(envelope, client);
    // Story 7.2: meter register / reading ledger and PM plan / work order projections run inside
    // this same transaction, so a generated work order and the plan's advanced due cursor - and a
    // reading and the meter it advances - commit or roll back together.
    await applyAssetMeterProjection(envelope, client);
    await applyMaintenancePlanProjection(envelope, client);
    // Story 7.3: fault report / SLA policy / breakdown work order / downtime projections run
    // inside this same transaction, so the work order, its open downtime window and the fault
    // report's accepted flip commit or roll back together - and a reliability snapshot either
    // lands whole (every metric row) or not at all.
    await applyMaintenanceFaultProjection(envelope, client);
    await applyMaintenanceReliabilityProjection(envelope, client);
    // Story 7.4: the spare projections run inside this same transaction, so the reservation row
    // and the stock_balance movement it drives (allocate on reserve, deallocate-then-issue on
    // issue, receipt on return, deallocate on cancel) commit or roll back together. A ledger
    // rejection - INSUFFICIENT_STOCK from applyStockAllocation - therefore rolls back the
    // reservation row too, and no maintenance event is ever stored for a movement that failed.
    await applyMaintenanceSpareProjection(envelope, client);
    // Story 7.5: the calibration register projections run inside this same transaction, so the
    // register/certificate/escalation row and the instrument_calibration_statuses write the
    // lockout gate reads commit or roll back together. eventId is passed through because the
    // status row records which event changed it and the domain_events row does not exist yet.
    await applyCalibrationRegisterProjection(envelope, client, eventId);
    // Story 7.6: the statutory examination register, its record history, and the machine status
    // projection run inside this same transaction, so the register flip, the evidence record and
    // the domain_events insert commit or roll back together. The status flip that feeds the
    // weighbridge lockout and the AC1 use-lock is applied here, never outside persistEvent.
    await applyStatutoryExaminationProjection(envelope, client);
    await applyAssetOperationalStatusProjection(envelope, client);
    // Story 7.7: the coverage register, its staged expiry alerts and the reason-coded warranty
    // override run inside this same transaction, so the projection row and the domain_events
    // insert commit or roll back together. The DOA re-resolution behind the override lives here,
    // never only in the HTTP handler (AD-12).
    await applyMaintenanceCoverageProjection(envelope, client);
    // Story 7.8: the sync-conflict queue row (raise) and its resolution run inside this same
    // transaction, so the queue row and the domain_events insert commit or roll back together.
    // The DOA re-resolution behind the resolution lives here, never only in the HTTP handler
    // (AD-12). The Story 7.8 status transition and closure ledger ride
    // applyMaintenancePlanProjection above.
    await applyMaintenanceSyncConflictProjection(envelope, client);
    // Story 6.1: the production order projection runs inside this same transaction, so the order
    // row (create, release with its re-run release gate, state transitions, cancel with the
    // unreversed-transactions guard) and the domain_events insert commit or roll back together.
    // The gate re-run, the DOA override re-resolution and the order-number allocation all live
    // here, never only in the HTTP handler (AD-12).
    await applyProductionOrderProjection(envelope, client, eventId);
    // Story 6.2: the production material projections (staging, issue, backflush confirmation,
    // return) run inside this same transaction, so the stage rows, the WIP ledger postings, the
    // stock_balance drains/returns and the order's unreversed_transaction_count recompute commit
    // or roll back together with the domain_events insert. Every material guard lives here, never
    // only in the HTTP handler (AD-12).
    await applyProductionMaterialProjection(envelope, client, eventId);
    // Story 6.3: completions create the output lots, post their finished stock, hand every lot to
    // the Story 8.1 QC gate and relieve WIP - all on this transaction, so any refusal anywhere in
    // that chain rolls the whole completion back (AC 1, AC 2).
    await applyProductionCompletionProjection(envelope, client, eventId, auditCtx);
    // Story 8.1: the inspection-plan family (header, immutable versions, characteristics, the
    // append-only approval with its in-transaction DOA re-derivation), the completion hand-off
    // (frozen plan version, task, qc_hold gate, transactional inspection notification - on the
    // PRODUCER's transaction when the hand-off supplies its client) and the DOA-gated conditional
    // release (deviation, shared disposition, gate transition) run inside this same transaction,
    // so every QC-gate write commits or rolls back with the domain_events insert. Every guard lives
    // here, never only in the HTTP handler (AD-12).
    await applyQualityProjection(envelope, client, eventId);
    // Story 8.7: the BIS licence register (CRUD, renewal, overlap guard), the expiry-alert ledger
    // (idempotent stage flags, the expiry status flip) and the label-master version control (draft,
    // DOA-resolved approval, supersede) run inside this same transaction, so every governance write
    // commits or rolls back with the domain_events insert. Every guard lives here, never only in
    // the HTTP handler (AD-12).
    await applyComplianceMasterDataProjection(envelope, client, eventId);
    // Story 8.8: witnessed / third-party inspection hold points - the governed hold plus the
    // hold-point record, the notice ledger, and the sign-off/waiver closures - run inside this same
    // transaction, so the enforcement flag and the record commit or roll back together (AD-12).
    await applyQcWitnessProjection(envelope, client, eventId);
    // Story 9.1: job-work service order lifecycle (create/update/confirm) runs inside this same
    // transaction; the four-state machine re-derives current status under an advisory lock plus
    // FOR UPDATE inside the applier (the Epic 8 hold-bypass lesson), so the projection row and
    // the domain event commit or roll back together.
    await applyServiceOrderProjection(envelope, client, eventId);
    // Story 9.2: the customer-material custody receipt runs inside this same transaction (for the
    // GRN path, nested inside the goods.received transaction): the order status is re-derived
    // under the order advisory lock plus FOR UPDATE, the tolerance variance is computed and
    // written back onto the payload, and the FIRST receipt fires confirmed -> in_process through
    // the 9.1 transitionServiceOrder seam, so the custody row, the order flip, and the domain
    // event commit or roll back together.
    await applyJobworkMaterialReceivedProjection(envelope, client, eventId);
    // Story 4.5: three-way match projection (native PO binding on the GRN, the match record and
    // its invoice match_status mirror, credit/debit note lifts, payment-clearance feed ledger)
    // runs inside this same transaction. It also rewrites envelope.payload with the SERVER's
    // computed match result before the domain_events insert below, so the stored event carries
    // findings this process derived rather than anything the caller asserted.
    await applyThreeWayMatchProjection(envelope, client, eventId);

    let nextVersion: number;

    if (envelope.event_version !== undefined) {
      nextVersion = envelope.event_version;
    } else {
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(event_version), 0) + 1 AS next_version FROM domain_events WHERE stream_id = $1`,
        [envelope.stream_id],
      );
      nextVersion = versionResult.rows[0]!['next_version'] as number;
    }

    const result = await client.query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at`,
      [
        eventId,
        envelope.stream_type,
        envelope.stream_id,
        envelope.event_type,
        nextVersion,
        envelope.payload,
        metadata,
        envelope.schema_version ?? 1,
        envelope.idempotency_key ?? null,
      ],
    );

    const persisted = mapRowToEvent(result.rows[0]!);

    await assertLocationInvariant(envelope, persisted, client);

    if (auditCtx) {
      // http_status comes from the caller (201 for POST-created resources, 200 for PUT/PATCH
      // flows) so the statutory row records the status the client actually received.
      await logAuditEntry(client, {
        ...auditCtx,
        event_id: eventId,
        error_code: null,
      });
    }

    if (ownsTransaction) await client.query('COMMIT');
    return persisted;
  } catch (err: unknown) {
    if (ownsTransaction) await client.query('ROLLBACK');
    // Defense-in-depth: the audit write here is an INSERT, which the tamper trigger (BEFORE
    // UPDATE/DELETE/TRUNCATE) does not fire on - so this is normally unreachable. But if the trigger
    // ever rejects a write on this path, record the attempt on a fresh connection (the transaction
    // client is aborted) rather than letting it surface as a bare 500 with no tamper record.
    if (isAuditTamperError(err)) {
      await recordTamperAttempt({
        user_id: auditCtx?.user_id ?? null,
        role: auditCtx?.role ?? null,
        location_id: auditCtx?.location_id ?? null,
        endpoint: auditCtx?.endpoint ?? null,
        method: auditCtx?.method ?? null,
        error_code: 'AUDIT_LOG_TAMPER_ATTEMPT',
        details: { reason: 'Audit-log tamper trigger fired during event persistence' },
      }).catch(() => {
        // Never let the tamper-recording failure mask the original error.
      });
      throw new AppError(
        500,
        'AUDIT_LOG_TAMPER_ATTEMPT',
        'Audit log modification was rejected by the database',
      );
    }
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '23505' &&
      'constraint' in err
    ) {
      // Postgres exposes the violated constraint name via err.constraint, not err.detail
      // (err.detail only contains the conflicting key/value, e.g. "Key (idempotency_key)=(...) already exists.").
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_idempotency' || constraint === 'domain_events_pkey') {
        if (ownsTransaction) {
          const existing = await client.query(
            `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
              FROM domain_events WHERE idempotency_key = $1 OR event_id = $2 LIMIT 1`,
            [envelope.idempotency_key, eventId],
          );
          if (existing.rows.length > 0) {
            if (opts?.strictDuplicate === true) {
              const row = existing.rows[0]!;
              throw new AppError(409, 'DUPLICATE_EVENT', 'Event already exists', {
                existing_event_id: row.event_id,
                existing_event_type: row.event_type,
              });
            }
            await client.query('COMMIT');
            return mapRowToEvent(existing.rows[0]!);
          }
        }
        throw new AppError(409, 'DUPLICATE_EVENT', 'Event already exists', {
          existing_event_id: 'unknown',
        });
      } else if (constraint === 'uq_po_release_reference') {
        throw new AppError(409, 'DUPLICATE_EVENT', 'Release reference already exists for this PO', {
          release_reference:
            typeof envelope.payload['release_reference'] === 'string'
              ? envelope.payload['release_reference']
              : null,
        });
      } else if (constraint === 'uq_stream_version') {
        throw new AppError(409, 'STREAM_CONFLICT', 'Event version conflict in stream', {
          stream_id: envelope.stream_id,
          event_version: envelope.event_version,
        });
      } else if (constraint === 'uq_lot_master_lot_number') {
        throw new AppError(400, 'DUPLICATE_LOT', 'Lot already exists', {
          lot_id:
            typeof envelope.payload['lot_id'] === 'string' ? envelope.payload['lot_id'] : null,
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
        });
      } else if (
        // Story 6.3: the completion grain (FR-MO-07). Both uniques can only collide on a genuine
        // replay of the same completion event, because completion_id and the (order, event, class,
        // line) grain are both server-derived under the order lock.
        constraint === 'uq_production_completion_lot' ||
        constraint === 'uq_production_completion_grain' ||
        constraint === 'production_completion_pkey' ||
        constraint === 'production_scrap_declaration_pkey' ||
        // Code review 2026-08-31: the scrap grain is source_event_id, so a re-applied
        // production_order.scrap_declared collides here instead of writing a second declaration.
        constraint === 'uq_production_scrap_declaration_event'
      ) {
        // The noun follows the event, and the raw index name stays server-side (code review
        // 2026-08-31): a scrap declaration was being reported as a completion, sending operators
        // looking for a completion that does not exist.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          envelope.event_type === 'production_order.scrap_declared'
            ? 'This scrap declaration has already been recorded'
            : 'This completion has already been posted',
          {
            production_order_id:
              typeof envelope.payload['production_order_id'] === 'string'
                ? envelope.payload['production_order_id']
                : null,
          },
        );
      } else if (constraint === 'uq_production_order_source_rework_event') {
        // Story 6.3 (FR-MO-10, AC 7): one rework order per qc.rework_requested event. The
        // check-then-act in resolveReworkRequest and this race path return the same code.
        throw new AppError(
          409,
          'REWORK_ORDER_EXISTS',
          'A rework order already exists for this rework request',
          {
            source_rework_event_id:
              typeof envelope.payload['source_rework_event_id'] === 'string'
                ? envelope.payload['source_rework_event_id']
                : null,
          },
        );
      } else if (constraint === 'uq_serial_master_sku_serial_number') {
        throw new AppError(400, 'DUPLICATE_SERIAL', 'Serial number already exists for this SKU', {
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
        });
      } else if (constraint === 'uq_ownership_agreement_active') {
        throw new AppError(
          409,
          'OWNERSHIP_AGREEMENT_CONFLICT',
          'An active ownership agreement already exists for this sku/location/stock_class grain',
          {
            sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
            location_id:
              typeof envelope.payload['location_id'] === 'string'
                ? envelope.payload['location_id']
                : null,
            stock_class:
              typeof envelope.payload['stock_class'] === 'string'
                ? envelope.payload['stock_class']
                : null,
          },
        );
      } else if (constraint === 'supplier_invoice_pkey') {
        // Concurrent second writer racing the seam's getSupplierInvoiceById pre-check on the same
        // invoice_id. The serial case is already a mapped 409 in the seam; this maps the race.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A supplier invoice with this invoice_id already exists',
          {
            invoice_id:
              typeof envelope.payload['invoice_id'] === 'string'
                ? envelope.payload['invoice_id']
                : null,
          },
        );
      } else if (
        constraint === 'uq_supplier_invoice_ingestion_attachment_ref' ||
        constraint === 'supplier_invoice_ingestion_pkey'
      ) {
        // The ingestion unique index guards re-ingesting the SAME uploaded artifact (a staging
        // retry after a timed-out call lands here) - a stable 409, never a raw PG 500, and never
        // treated as a business duplicate of the invoice itself (Binding Scope Decisions).
        throw new AppError(
          409,
          'INVOICE_ATTACHMENT_ALREADY_STAGED',
          'This attachment reference has already been staged for review',
          {
            attachment_ref:
              typeof envelope.payload['attachment_ref'] === 'string'
                ? envelope.payload['attachment_ref']
                : null,
            ingestion_id:
              typeof envelope.payload['ingestion_id'] === 'string'
                ? envelope.payload['ingestion_id']
                : null,
          },
        );
      } else if (constraint === 'uq_supplier_invoice_duplicate_grain') {
        // Task 3.6: the partial unique index is the final concurrency guard for AC3's ordinary
        // duplicate block. The transaction is already rolled back here, so this runs a fresh,
        // safe query against supplier_invoice by the attempted grain (never the generic
        // domain_events lookup) and returns the same detail shape as the seam's own pre-check.
        const details = await resolveSupplierInvoiceDuplicateConflict(envelope.payload);
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'An invoice with this supplier GSTIN, invoice number, and financial year already exists',
          details ?? {},
        );
      } else if (constraint === 'uq_replenishment_recommendation_open_signal') {
        throw new AppError(
          409,
          'REPLENISHMENT_RECOMMENDATION_CONFLICT',
          'An open replenishment recommendation already exists for this sku/location/signal_type grain',
          {
            sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
            location_id:
              typeof envelope.payload['location_id'] === 'string'
                ? envelope.payload['location_id']
                : null,
            signal_type:
              typeof envelope.payload['signal_type'] === 'string'
                ? envelope.payload['signal_type']
                : 'internal',
          },
        );
      } else if (constraint === 'uq_bom_parent_item' || constraint === 'bom_pkey') {
        // Concurrent BOM writes racing the seam's pre-check: the serial case is already a mapped
        // 409 in the seam (DUPLICATE_EVENT on an existing bom_id or parent_item_id); this maps the
        // race so a second writer surfaces a stable 409 instead of a raw 23505 500.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A BOM already exists for this bom_id or parent item',
          {
            bom_id:
              typeof envelope.payload['bom_id'] === 'string' ? envelope.payload['bom_id'] : null,
            parent_item_id:
              typeof envelope.payload['parent_item_id'] === 'string'
                ? envelope.payload['parent_item_id']
                : null,
          },
        );
      } else if (
        constraint === 'uq_bom_alternate_entry' ||
        constraint === 'bom_alternate_pkey' ||
        constraint === 'uq_bom_explosion_source_event' ||
        constraint === 'bom_explosion_pkey' ||
        constraint === 'uq_bom_explosion_line_no' ||
        constraint === 'bom_explosion_line_pkey' ||
        // Story 5.6: same treatment for the cost-rollup snapshot grains.
        constraint === 'uq_bom_cost_rollup_source_event' ||
        constraint === 'bom_cost_rollup_pkey' ||
        constraint === 'uq_bom_cost_rollup_line_no' ||
        constraint === 'bom_cost_rollup_line_pkey'
      ) {
        // Story 5.5: the serial cases are already mapped 409s in the seam; this maps the
        // concurrent race so a second writer surfaces a stable 409 instead of a raw 23505 500.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'This alternate, explosion run or cost rollup has already been recorded',
          {
            constraint,
            bom_id:
              typeof envelope.payload['bom_id'] === 'string' ? envelope.payload['bom_id'] : null,
            explosion_id:
              typeof envelope.payload['explosion_id'] === 'string'
                ? envelope.payload['explosion_id']
                : null,
            bom_alternate_id:
              typeof envelope.payload['bom_alternate_id'] === 'string'
                ? envelope.payload['bom_alternate_id']
                : null,
          },
        );
      } else if (constraint === 'uq_asset_serial' || constraint === 'uq_asset_tag') {
        // Story 7.1: the serial cases are already mapped DUPLICATE_ASSET 409s in the seam; a
        // concurrent first-insert race reaches the unique index instead, so this resolves the
        // winning row on a fresh query and returns the SAME contract as the sequential path
        // (mirror of resolveSupplierInvoiceDuplicateConflict). asset_pkey stays DUPLICATE_EVENT.
        const details = await resolveAssetDuplicateConflict(envelope.payload);
        throw new AppError(
          409,
          'DUPLICATE_ASSET',
          'An asset with this serial number or asset tag is already registered',
          details ?? {},
        );
      } else if (constraint === 'uq_asset_meter_code') {
        // Story 7.2: same contract as the seam's sequential pre-check - a concurrent race must not
        // surface a different code or lose the existing_meter_id detail.
        throw new AppError(
          409,
          'DUPLICATE_METER',
          'A meter with this code is already registered on this asset',
          await resolveMeterDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_plan_name') {
        throw new AppError(
          409,
          'DUPLICATE_PLAN',
          'A plan with this name already exists on this asset',
          await resolvePlanDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_work_order_cycle') {
        throw new AppError(
          409,
          'DUPLICATE_WORK_ORDER',
          'A work order already exists for this plan cycle',
          await resolveWorkOrderDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_sla_policy_key') {
        // Story 7.3: same contract as the seam's sequential pre-check - a concurrent race must not
        // surface a different code or lose the existing_policy_id detail.
        throw new AppError(
          409,
          'DUPLICATE_SLA_POLICY',
          'An active SLA policy already exists for this (criticality_class, safety_flag) pair',
          await resolveSlaPolicyDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_work_order_fault') {
        // Story 7.3: a concurrent accept of the same fault report reaches the unique index behind
        // the report lock; resolve the winner with the SAME FAULT_ALREADY_TRIAGED contract.
        throw new AppError(
          409,
          'FAULT_ALREADY_TRIAGED',
          'This fault report has already been triaged',
          await resolveFaultTriageConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_downtime_work_order') {
        // Story 7.3: a concurrent second open window for one work order reaches the unique index;
        // surface the stable DOWNTIME_ALREADY_OPEN with the existing window id.
        throw new AppError(
          409,
          'DOWNTIME_ALREADY_OPEN',
          'A downtime window is already open for this work order',
          await resolveDowntimeConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_reliability_metric_scope') {
        // Story 7.3: a concurrent re-run of the same period/scope reaches the anti-double-report
        // key; surface the stable DUPLICATE_RELIABILITY_REPORT with the existing metric id.
        throw new AppError(
          409,
          'DUPLICATE_RELIABILITY_REPORT',
          'A reliability snapshot already exists for this period and scope',
          await resolveReliabilityReportConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_spare_catalogue_grain') {
        // Story 7.4: same contract as the seam's sequential pre-check - a concurrent race must not
        // surface a different code or lose the existing_catalogue_id detail.
        throw new AppError(
          409,
          'SPARE_ALREADY_CATALOGUED',
          'This spare is already catalogued at this location',
          await resolveSpareCatalogueDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_asset_parts_list_grain') {
        // Story 7.4: a concurrent second listing of the same spare on one asset reaches the unique
        // index; surface the stable ASSET_PART_ALREADY_LISTED with the existing line id.
        throw new AppError(
          409,
          'ASSET_PART_ALREADY_LISTED',
          'This spare is already on the asset parts list',
          await resolveAssetPartDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_spare_alert_day') {
        // Story 7.4: the same-day guard. Two concurrent scans for one grain on one business_date
        // resolve to a single alert with the stable DUPLICATE_SPARE_ALERT contract.
        throw new AppError(
          409,
          'DUPLICATE_SPARE_ALERT',
          'An alert of this type already exists for this grain on this business date',
          await resolveSpareAlertDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_register_instrument_id') {
        // Story 7.5: two concurrent registrations of the same instrument id resolve to one winner;
        // the loser gets the same code and the same existing_instrument_record_id the sequential
        // pre-check produces.
        throw new AppError(
          409,
          'INSTRUMENT_ALREADY_REGISTERED',
          'An instrument is already registered under this instrument id',
          await resolveInstrumentRegisterDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_register_asset') {
        // Story 7.5 (AD-9): one asset is at most one instrument record.
        throw new AppError(
          409,
          'ASSET_ALREADY_INSTRUMENT',
          'This asset already has an instrument record',
          await resolveInstrumentAssetDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_calibration_certificate_number') {
        // Story 7.5: the same certificate number recorded twice against one instrument.
        throw new AppError(
          409,
          'CERTIFICATE_ALREADY_RECORDED',
          'A certificate with this number is already recorded for this instrument',
          await resolveCertificateNumberDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_calibration_certificate_active') {
        // Story 7.5: two concurrent certificate recordings for one instrument. Exactly one active
        // certificate may exist, so the loser is told which certificate holds the slot rather than
        // surfacing a raw 23505 500 - or worse, both appearing to unlock the instrument.
        throw new AppError(
          409,
          'CERTIFICATE_ALREADY_RECORDED',
          'Another certificate is already the active certificate for this instrument',
          await resolveActiveCertificateDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_calibration_alert_stage') {
        // Story 7.5: the once-per-stage grain. Two concurrent scans for one certificate stage
        // resolve to a single alert with the stable DUPLICATE_CALIBRATION_ALERT contract.
        throw new AppError(
          409,
          'DUPLICATE_CALIBRATION_ALERT',
          'This certificate has already been flagged at this stage',
          await resolveCalibrationAlertDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_instrument_calibration_escalation_open') {
        // Story 7.5: at most one open escalation per instrument.
        throw new AppError(
          409,
          'ESCALATION_ALREADY_OPEN',
          'An escalation is already open for this instrument',
          await resolveOpenEscalationDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_statutory_examination_asset_type') {
        // Story 7.6: two concurrent records for the same (asset_id, examination_type) grain
        // resolve to one winner; the loser gets the same code and the same existing_examination_id
        // detail the sequential pre-check produces (DUPLICATE_STATUTORY_EXAMINATION).
        throw new AppError(
          409,
          'DUPLICATE_STATUTORY_EXAMINATION',
          'A statutory examination already exists for this asset and type',
          await resolveStatutoryExaminationDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_statutory_examination_device_key') {
        // Story 7.6: one weighbridge device_key maps to at most one statutory examination. There
        // is no sequential pre-check (the seam's device-key guard is the index itself), so the
        // sequential and the race path surface the SAME DUPLICATE_EVENT detail.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A statutory examination already uses this device key',
          await resolveStatutoryDeviceKeyDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_statutory_examination_record_number') {
        // Story 7.6: one certificate number per examination. Same contract as the device key: the
        // index is the guard, and the resolver reports the existing record.
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A statutory examination record with this certificate number already exists',
          await resolveStatutoryRecordDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_asset_coverage_reference') {
        // Story 7.7: the coverage uniqueness grain (asset_id, coverage_type, lower(reference)).
        // Two concurrent recordings resolve to one winner; the loser gets the same code and the
        // same existing_coverage_id detail the sequential pre-check produces.
        throw new AppError(
          409,
          'DUPLICATE_COVERAGE',
          'A coverage with this reference already exists for the asset and coverage type',
          await resolveCoverageDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_asset_coverage_alert_stage') {
        // Story 7.7: the once-per-stage grain. Two concurrent scans for one coverage stage resolve
        // to a single alert with the stable DUPLICATE_COVERAGE_ALERT contract, and the scan skips
        // that stage rather than failing the whole run.
        throw new AppError(
          409,
          'DUPLICATE_COVERAGE_ALERT',
          'This coverage has already been flagged at this stage',
          await resolveCoverageAlertDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_warranty_override_work_order') {
        // Story 7.7: one reason-coded override per work order (Binding Decision 11). The race path
        // returns the same code and the same existing_override_id as the sequential pre-check.
        throw new AppError(
          409,
          'WARRANTY_OVERRIDE_ALREADY_RECORDED',
          'A warranty override has already been recorded for this work order',
          await resolveWarrantyOverrideDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_maintenance_sync_conflict_event') {
        // Story 7.8: one queue row per conflicting edge event (Binding Decision 4). The race path
        // returns the same code and the same existing_conflict_id as the sequential pre-check.
        throw new AppError(
          409,
          'DUPLICATE_SYNC_CONFLICT',
          'A sync conflict has already been raised for this event',
          await resolveSyncConflictDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'maintenance_work_order_closure_pkey') {
        // Story 7.8: the closure id IS the work order id (Binding Decision 9), so a second closure
        // row for one work order can only come from a concurrent completion that lost the
        // work-order lock race. Surface it as the completion contract's own code, never a raw
        // 23505 500.
        throw new AppError(
          409,
          'WORK_ORDER_ALREADY_COMPLETED',
          'A closure has already been recorded for this work order',
          {
            work_order_id:
              typeof envelope.payload['work_order_id'] === 'string'
                ? envelope.payload['work_order_id']
                : null,
          },
        );
      } else if (constraint === 'uq_compliance_bis_licence_scope') {
        // Story 8.7 (Task 3.3): one licence per (case-folded number, sku, site scope). The race
        // path returns the same BIS_LICENCE_EXISTS contract as the sequential applier arm, plus
        // the conflicting row's existing_licence_id.
        throw new AppError(
          409,
          'BIS_LICENCE_EXISTS',
          'A licence with this number already exists for this sku and site scope',
          await resolveBisLicenceExistsDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_label_master_version') {
        // Story 8.7 (Task 3.3): one row per (sku, case-folded label_version). Same code and same
        // existing_label_id as the sequential pre-check.
        throw new AppError(
          409,
          'LABEL_VERSION_EXISTS',
          'A label draft with this sku and version already exists',
          await resolveLabelVersionExistsDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_inspection_plan_grain') {
        // Story 8.1: one plan header per scope grain. The race path returns the same code and the
        // same existing_plan_id as the sequential pre-check (INSPECTION_PLAN_SCOPE_MISMATCH).
        throw new AppError(
          409,
          'INSPECTION_PLAN_SCOPE_MISMATCH',
          'A plan already exists for this scope grain under a different plan_id',
          await resolveInspectionPlanGrainDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_inspection_plan_version_effective') {
        // Story 8.1 (Task 4): one version per (plan, effective_from); same detail as the pre-check.
        throw new AppError(
          409,
          'INSPECTION_PLAN_EFFECTIVITY_CONFLICT',
          'A version of this plan already carries this effective_from date',
          await resolveInspectionPlanEffectivityDuplicateConflict(envelope.payload),
        );
      } else if (
        constraint === 'uq_inspection_plan_version_no' ||
        constraint === 'inspection_plan_version_pkey' ||
        constraint === 'inspection_plan_pkey' ||
        constraint === 'inspection_plan_characteristic_pkey' ||
        constraint === 'uq_inspection_plan_characteristic_line'
      ) {
        // Story 8.1: version numbers are allocated under the plan advisory lock, so a 23505 here is
        // a concurrent create that lost the lock race or a re-used minted id - the stable
        // DUPLICATE_INSPECTION_PLAN_VERSION, never a raw 500.
        throw new AppError(
          409,
          'DUPLICATE_INSPECTION_PLAN_VERSION',
          'This plan version has already been created',
          {
            constraint,
            plan_id:
              typeof envelope.payload['plan_id'] === 'string' ? envelope.payload['plan_id'] : null,
            plan_version_id:
              typeof envelope.payload['plan_version_id'] === 'string'
                ? envelope.payload['plan_version_id']
                : null,
          },
        );
      } else if (constraint === 'inspection_plan_approval_pkey') {
        // Story 8.1 (Task 4): concurrent approval attempts resolve to ONE record; the loser gets the
        // same code as a sequential second approval.
        throw new AppError(
          409,
          'INSPECTION_PLAN_ALREADY_APPROVED',
          'This plan version is already approved',
          {
            plan_version_id:
              typeof envelope.payload['plan_version_id'] === 'string'
                ? envelope.payload['plan_version_id']
                : null,
          },
        );
      } else if (
        constraint === 'uq_qc_inspection_task_lot' ||
        constraint === 'uq_qc_inspection_task_source' ||
        constraint === 'qc_inspection_task_pkey'
      ) {
        // Story 8.1 (Task 5): unique source completion and unique lot task make replay and
        // concurrent delivery one effect; the race path returns the same existing_task_id.
        throw new AppError(
          409,
          'DUPLICATE_QC_COMPLETION',
          'A QC inspection task already exists for this lot or source completion',
          { constraint, ...(await resolveQcCompletionDuplicateConflict(envelope.payload)) },
        );
      } else if (
        constraint === 'uq_qc_lot_disposition_lot' ||
        constraint === 'qc_lot_disposition_pkey' ||
        constraint === 'uq_qc_deviation_task_type' ||
        constraint === 'qc_deviation_pkey' ||
        // Story 8.3: a raced split loses on one of its own child grains before it loses on the
        // parent's 'split' disposition row; both are the same fact for the caller.
        constraint === 'uq_qc_lot_split_child' ||
        constraint === 'uq_qc_lot_split_sequence' ||
        constraint === 'qc_lot_split_pkey' ||
        // Story 8.3 (Annex requirement 8): one NCR per rejected lot. The reject disposition raises
        // it, so a raced second reject surfaces here with the same existing_disposition_id the
        // sequential DISPOSITION_EXISTS pre-check would name - same code, same shape.
        // Story 8.5 (Binding Scope Decision 9): uq_qc_ncr_lot became the PARTIAL
        // uq_qc_ncr_lot_disposition_sourced (disposition-sourced rows only) and
        // uq_qc_ncr_disposition became a same-named partial index; both keep resolving through
        // THIS existing arm so the Story 8.3 behaviour is byte-identical (EXTEND, never duplicate
        // an arm for the same underlying fact - the 8.3 review lesson). A hold-sourced insert has
        // disposition_id NULL and can never trip either.
        constraint === 'uq_qc_ncr_lot_disposition_sourced' ||
        constraint === 'uq_qc_ncr_disposition' ||
        constraint === 'qc_ncr_pkey'
      ) {
        // Story 8.1 (Binding Scope Decision 4): one disposition per lot. A sequential or
        // concurrent second disposition is DISPOSITION_EXISTS with the existing_disposition_id.
        throw new AppError(
          409,
          'DISPOSITION_EXISTS',
          'A disposition has already been recorded for this lot',
          { constraint, ...(await resolveQcDispositionDuplicateConflict(envelope.payload)) },
        );
      } else if (
        constraint === 'uq_qc_batch_release_lot' ||
        constraint === 'uq_qc_batch_release_disposition'
      ) {
        // Story 8.4 (AC 7): one batch release per lot, and one per disposition. A sequential or
        // concurrent second release is RELEASE_EXISTS carrying the existing release_id - the same
        // shape DISPOSITION_EXISTS has, so a caller handles both identically. The *_pkey constraints
        // are deliberately NOT mapped here: release_id is a freshly minted UUID, so a pkey violation
        // is a UUID collision, not "a record already exists for this lot", and reporting it as such
        // would return a message that is simply false with no existing_release_id to act on.
        throw new AppError(
          409,
          'RELEASE_EXISTS',
          'A batch release record already exists for this lot',
          { constraint, ...(await resolveQcReleaseDuplicateConflict(envelope.payload)) },
        );
      } else if (constraint === 'uq_qc_quality_hold_open') {
        // Story 8.5 (AC 1): one OPEN hold per lot. A raced double-place surfaces the stable 409
        // with the same existing_hold_id the sequential HOLD_EXISTS pre-check names.
        throw new AppError(409, 'HOLD_EXISTS', 'An open quality hold already exists for this lot', {
          constraint,
          ...(await resolveQcHoldDuplicateConflict(envelope.payload)),
        });
      } else if (constraint === 'uq_qc_capa_number') {
        // Story 8.5: the server-minted CAPA number collided (sequential or concurrent).
        throw new AppError(409, 'CAPA_EXISTS', 'The minted CAPA number already exists', {
          constraint,
          ...(await resolveQcCapaDuplicateConflict(envelope.payload)),
        });
      } else if (constraint === 'uq_qc_retention_sample_lot') {
        // Story 8.4 (AC 4): one retention sample per lot. A raced double-log surfaces the stable
        // 409 with the existing_retention_sample_id rather than a raw 23505 500.
        throw new AppError(
          409,
          'RETENTION_SAMPLE_EXISTS',
          'A retention sample already exists for this lot',
          { constraint, ...(await resolveQcRetentionSampleDuplicateConflict(envelope.payload)) },
        );
      } else if (
        constraint === 'uq_qc_sampling_plan_task' ||
        constraint === 'qc_sampling_plan_pkey'
      ) {
        // Story 8.2 (AC 1): one frozen sampling plan per task. Two simultaneous determinations
        // produce one plan; the loser gets the same code and existing_sampling_id as the
        // sequential pre-check.
        throw new AppError(
          409,
          'QC_SAMPLING_EXISTS',
          'A sampling plan is already frozen on this task',
          { constraint, ...(await resolveQcSamplingDuplicateConflict(envelope.payload)) },
        );
      } else if (
        constraint === 'uq_qc_inspection_result_unit' ||
        constraint === 'qc_inspection_result_pkey'
      ) {
        // Story 8.2 (Annex requirement 6): exactly one authoritative result per (task,
        // characteristic, sample unit). Two simultaneous batches for the same unit produce one row.
        throw new AppError(
          409,
          'QC_RESULT_EXISTS',
          'A result already exists for this task, characteristic and sample unit',
          { constraint, ...resolveQcResultDuplicateConflict(envelope.payload) },
        );
      } else if (constraint === 'uq_production_order_number_ext') {
        // Story 6.1: the server-allocated order number is unique. The sequential pre-check (the
        // applier's allocation) makes this practically unreachable, but a concurrent race on the
        // SAME event (same production_order_id) must surface the stable DUPLICATE_PRODUCTION_ORDER_
        // NUMBER with the existing order detail, never a raw 23505 500.
        throw new AppError(
          409,
          'DUPLICATE_PRODUCTION_ORDER_NUMBER',
          'A production order with this order number already exists',
          await resolveProductionOrderNumberDuplicateConflict(envelope.payload),
        );
      } else if (constraint === 'uq_production_order_stage_line') {
        // Story 6.2: the (production_order_id, bom_line_id) staging grain is the replay/duplicate
        // guard - a second staging of the same directed-issue line is 409 DUPLICATE_EVENT whether
        // it arrives sequentially or loses a concurrent race. The race path and the sequential
        // path return the SAME existing_stage_id detail (the Story 7.2 lesson).
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'This BOM line is already staged for the production order',
          await resolveProductionOrderStageLineDuplicateConflict(envelope.payload),
        );
      } else if (
        constraint === 'maintenance_sla_policy_pkey' ||
        constraint === 'maintenance_fault_report_pkey' ||
        constraint === 'maintenance_downtime_pkey' ||
        constraint === 'maintenance_reliability_metric_pkey' ||
        constraint === 'maintenance_spare_catalogue_pkey' ||
        constraint === 'asset_parts_list_pkey' ||
        constraint === 'maintenance_spare_reservation_pkey' ||
        constraint === 'maintenance_spare_alert_pkey' ||
        constraint === 'instrument_register_pkey' ||
        constraint === 'instrument_calibration_certificate_pkey' ||
        constraint === 'instrument_calibration_alert_pkey' ||
        constraint === 'instrument_calibration_escalation_pkey' ||
        // Story 7.6: server-minted UUIDs make these practically unreachable; mapped for the same
        // completeness reason as the siblings above.
        constraint === 'statutory_examination_pkey' ||
        constraint === 'statutory_examination_record_pkey' ||
        constraint === 'asset_operational_status_pkey' ||
        constraint === 'maintenance_asset_cost_pkey' ||
        // Story 6.1: server-minted UUIDs make this practically unreachable; mapped for the same
        // completeness reason as the siblings above.
        constraint === 'production_order_pkey' ||
        // Story 6.2: server-minted UUIDs make these practically unreachable; mapped for the same
        // completeness reason as the siblings above. Each names its OWN id field below.
        constraint === 'production_order_stage_pkey' ||
        constraint === 'production_wip_ledger_pkey' ||
        // Story 7.7: server-minted UUIDs make these practically unreachable; mapped for the same
        // completeness reason as the siblings above. Each names its OWN id field below, so the
        // chain never falls through to a wrong (and always null) field.
        constraint === 'asset_coverage_pkey' ||
        constraint === 'asset_coverage_alert_pkey' ||
        constraint === 'maintenance_warranty_override_pkey' ||
        // Story 7.8: server-minted conflict_id makes this practically unreachable; mapped for the
        // same completeness reason, naming its OWN id field below.
        constraint === 'maintenance_sync_conflict_pkey'
      ) {
        // Story 7.3: server-minted UUIDs make these practically unreachable; mapped for
        // completeness per the maintenance_plan_pkey precedent, so a direct-event duplicate id
        // surfaces a stable 409 instead of a raw 23505 500, with the offending id in the details
        // (the same diagnosable shape the sibling PK mappers expose).
        const p = envelope.payload as Record<string, unknown>;
        const firstMetric = Array.isArray(p['metrics'])
          ? (p['metrics'] as Record<string, unknown>[])[0]
          : undefined;
        const offendingId =
          constraint === 'maintenance_sla_policy_pkey'
            ? { policy_id: typeof p['policy_id'] === 'string' ? p['policy_id'] : null }
            : constraint === 'maintenance_fault_report_pkey'
              ? {
                  fault_report_id:
                    typeof p['fault_report_id'] === 'string' ? p['fault_report_id'] : null,
                }
              : constraint === 'maintenance_downtime_pkey'
                ? { downtime_id: typeof p['downtime_id'] === 'string' ? p['downtime_id'] : null }
                : constraint === 'maintenance_reliability_metric_pkey'
                  ? {
                      metric_id:
                        firstMetric && typeof firstMetric['metric_id'] === 'string'
                          ? firstMetric['metric_id']
                          : null,
                    }
                  : // Story 7.4: each spare table names its own id, so the chain must not fall
                    // through to metric_id - reporting the wrong (and always null) field would
                    // make the 409 undiagnosable.
                    constraint === 'maintenance_spare_catalogue_pkey'
                    ? {
                        catalogue_id:
                          typeof p['catalogue_id'] === 'string' ? p['catalogue_id'] : null,
                      }
                    : constraint === 'asset_parts_list_pkey'
                      ? {
                          part_line_id:
                            typeof p['part_line_id'] === 'string' ? p['part_line_id'] : null,
                        }
                      : constraint === 'maintenance_spare_reservation_pkey'
                        ? {
                            reservation_id:
                              typeof p['reservation_id'] === 'string' ? p['reservation_id'] : null,
                          }
                        : constraint === 'maintenance_spare_alert_pkey'
                          ? {
                              alert_id: typeof p['alert_id'] === 'string' ? p['alert_id'] : null,
                            }
                          : constraint === 'instrument_register_pkey'
                            ? {
                                instrument_record_id:
                                  typeof p['instrument_record_id'] === 'string'
                                    ? p['instrument_record_id']
                                    : null,
                              }
                            : constraint === 'instrument_calibration_certificate_pkey'
                              ? {
                                  certificate_id:
                                    typeof p['certificate_id'] === 'string'
                                      ? p['certificate_id']
                                      : null,
                                }
                              : constraint === 'instrument_calibration_alert_pkey' ||
                                  constraint === 'asset_coverage_alert_pkey'
                                ? {
                                    alert_id:
                                      typeof p['alert_id'] === 'string' ? p['alert_id'] : null,
                                  }
                                : constraint === 'instrument_calibration_escalation_pkey'
                                  ? {
                                      escalation_id:
                                        typeof p['escalation_id'] === 'string'
                                          ? p['escalation_id']
                                          : null,
                                    }
                                  : constraint === 'statutory_examination_pkey'
                                    ? {
                                        examination_id:
                                          typeof p['examination_id'] === 'string'
                                            ? p['examination_id']
                                            : null,
                                      }
                                    : constraint === 'statutory_examination_record_pkey'
                                      ? {
                                          record_id:
                                            typeof p['record_id'] === 'string'
                                              ? p['record_id']
                                              : null,
                                        }
                                      : constraint === 'production_order_pkey'
                                        ? {
                                            production_order_id:
                                              typeof p['production_order_id'] === 'string'
                                                ? p['production_order_id']
                                                : null,
                                          }
                                        : constraint === 'production_order_stage_pkey'
                                          ? {
                                              stage_id:
                                                typeof p['stage_id'] === 'string'
                                                  ? p['stage_id']
                                                  : null,
                                            }
                                          : constraint === 'production_wip_ledger_pkey'
                                            ? {
                                                posting_id:
                                                  typeof p['posting_id'] === 'string'
                                                    ? p['posting_id']
                                                    : null,
                                              }
                                            : constraint === 'asset_coverage_pkey'
                                              ? {
                                                  coverage_id:
                                                    typeof p['coverage_id'] === 'string'
                                                      ? p['coverage_id']
                                                      : null,
                                                }
                                              : constraint === 'maintenance_warranty_override_pkey'
                                                ? {
                                                    override_id:
                                                      typeof p['override_id'] === 'string'
                                                        ? p['override_id']
                                                        : null,
                                                  }
                                                : constraint === 'maintenance_sync_conflict_pkey'
                                                  ? {
                                                      conflict_id:
                                                        typeof p['conflict_id'] === 'string'
                                                          ? p['conflict_id']
                                                          : null,
                                                    }
                                                  : {
                                                      asset_id:
                                                        typeof p['asset_id'] === 'string'
                                                          ? p['asset_id']
                                                          : null,
                                                    };
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A maintenance row with this id already exists',
          { constraint, ...offendingId },
        );
      } else if (constraint === 'asset_meter_pkey') {
        // Story 7.2: server-minted UUIDs make these practically unreachable; mapped for
        // completeness per the asset_pkey precedent, so a direct-event duplicate id surfaces a
        // stable 409 instead of a raw 23505 500.
        throw new AppError(409, 'DUPLICATE_EVENT', 'A meter with this meter_id already exists', {
          meter_id:
            typeof envelope.payload['meter_id'] === 'string' ? envelope.payload['meter_id'] : null,
        });
      } else if (constraint === 'asset_meter_reading_pkey') {
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A reading with this reading_id already exists',
          {
            reading_id:
              typeof envelope.payload['reading_id'] === 'string'
                ? envelope.payload['reading_id']
                : null,
          },
        );
      } else if (constraint === 'maintenance_plan_pkey') {
        throw new AppError(409, 'DUPLICATE_EVENT', 'A plan with this plan_id already exists', {
          plan_id:
            typeof envelope.payload['plan_id'] === 'string' ? envelope.payload['plan_id'] : null,
        });
      } else if (constraint === 'maintenance_work_order_pkey') {
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A work order with this work_order_id already exists',
          {
            work_order_id:
              typeof envelope.payload['work_order_id'] === 'string'
                ? envelope.payload['work_order_id']
                : null,
          },
        );
      } else if (constraint === 'asset_pkey') {
        // Server-minted UUIDs make this practically unreachable; mapped for completeness.
        throw new AppError(409, 'DUPLICATE_EVENT', 'An asset with this asset_id already exists', {
          asset_id:
            typeof envelope.payload['asset_id'] === 'string' ? envelope.payload['asset_id'] : null,
        });
      }
    }
    // Story 4.5: the match vocabulary CHECKs are enforced in the appliers first, so reaching one
    // here means an unmapped path produced an impossible state. Surface it as a stable 409 with
    // the violated constraint rather than a raw PG 500.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '23514' &&
      'constraint' in err
    ) {
      const constraint = (err as { constraint?: string }).constraint;
      // Story 8.1: every QC CHECK (scope pairing, characteristic kind/limit pairing, sampling
      // pairing, positive quantity, deviation expiry, gate vocabulary) is enforced in the shape
      // assert or the applier first; reaching one here is an unmapped path, surfaced as a stable
      // 400 INVALID_PAYLOAD naming the constraint rather than a raw PG 500.
      if (
        typeof constraint === 'string' &&
        (constraint.startsWith('chk_inspection_plan') || constraint.startsWith('chk_qc_'))
      ) {
        throw new AppError(400, 'INVALID_PAYLOAD', 'The QC payload violates a named constraint', {
          constraint,
        });
      }
      if (
        constraint === 'chk_three_way_match_status' ||
        constraint === 'chk_three_way_match_note_type' ||
        constraint === 'chk_three_way_match_lift_pairing' ||
        constraint === 'chk_supplier_invoice_match_status'
      ) {
        throw new AppError(409, 'MATCH_STATE_INVALID', 'Invalid three-way match state transition', {
          constraint,
          match_id:
            typeof envelope.payload['match_id'] === 'string' ? envelope.payload['match_id'] : null,
        });
      }
    }
    // Story 7.6: a numeric_value_out_of_range from the maintenance cost path is a caller-supplied
    // magnitude problem, not a server fault. The per-field COST_NUMERIC_REGEX bounds one value at
    // NUMERIC(14,3), but labor_cost + parts_cost can still overflow the column, and the per-asset
    // maintenance_asset_cost rollup ADDS to a running total with no ceiling at all - left unmapped
    // that surfaced as a 500 and, in the rollup case, permanently blocked every later completion
    // for that asset.
    // Gated on the cost-bearing event families. Left ungated, a Story 7.7
    // maintenance.coverage_recorded whose contract_value overflows NUMERIC(14,3) came back as
    // COST_VALUE_OUT_OF_RANGE with a null work_order_id, pointing at cost columns the coverage
    // register does not have - and so did every 22003 raised anywhere else in the platform.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '22003' &&
      COST_BEARING_EVENT_TYPES.has(envelope.event_type)
    ) {
      throw new AppError(
        422,
        'COST_VALUE_OUT_OF_RANGE',
        'The cost value or the resulting total exceeds the NUMERIC(14,3) range of the cost columns',
        {
          work_order_id:
            typeof envelope.payload['work_order_id'] === 'string'
              ? envelope.payload['work_order_id']
              : null,
          asset_id:
            typeof envelope.payload['asset_id'] === 'string' ? envelope.payload['asset_id'] : null,
        },
      );
    }
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * The event already persisted under an idempotency key, if any. Route-level pre-checks use this to
 * stand down on a retry: a pre-check that rejects before persistEvent runs (an overlap guard, a
 * uniqueness guard) would otherwise turn a legitimate retry of a SUCCESSFUL write into a 409,
 * because the state the client created is itself what the pre-check now trips over.
 */
export async function findEventByIdempotencyKey(
  idempotencyKey: string,
): Promise<PersistedEvent | null> {
  const result = await getPool().query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
     FROM domain_events WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows.length > 0 ? mapRowToEvent(result.rows[0]) : null;
}

export async function readStream(streamType: string, streamId: string): Promise<PersistedEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
     FROM domain_events
     WHERE stream_type = $1 AND stream_id = $2
     ORDER BY event_version ASC`,
    [streamType, streamId],
  );

  return result.rows.map(mapRowToEvent);
}
