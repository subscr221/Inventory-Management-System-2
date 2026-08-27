import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import { isReleasedItemMaster } from './bom.js';
import { evaluateReleaseGate } from '../production/release-gate.js';
import {
  allocateProductionOrderNumber,
  getProductionOrderById,
  getProductionOrderByIdForUpdate,
  insertProductionOrder,
  updateProductionOrderState,
} from '../read/projections/production_order.js';
import { applyStockDeallocation } from '../read/projections/stock_balance.js';
import { listStagesByOrder } from '../read/projections/production_order_stage.js';

/**
 * Story 6.1 compliance seam for the production order lifecycle (FR-MO-01/02/03). Structurally
 * mirrors src/compliance/calibration-register.ts: a stream gate, a PURE pre-transaction shape
 * assert, an in-transaction projection switch, an alreadyPersisted guard and the same reject()
 * AppError helper, copied verbatim rather than re-derived.
 *
 * This seam is the enforcement point, NOT the handler. Every rule in the Lifecycle Contract
 * (Table 2) and the Release Gate Contract (Table 3) is enforced inside applyProductionOrderProjection,
 * so a direct POST /api/v1/events call cannot bypass any of them (AD-12). The handler may check the
 * same rules first to return a cleaner error earlier, but removing a handler check must never change
 * what is possible through the direct-event path.
 *
 * State is a projection column, transitions are events (AD-14): production_order.status is written
 * only by these appliers inside the event transaction. Every accepted transition produces an event
 * and therefore an edit-log row through persistEvent (FR-AC-13, AC2). No applier silently no-ops on
 * a state it should reject.
 *
 * Locking contract: every applier that mutates more than one row takes SELECT ... FOR UPDATE in
 * this FIXED order - production order row (absent on create, the row is being inserted), then item
 * master row (if applicable), then location register row (if applicable), then the BOM rows the
 * explosion service reads (plain SELECTs, never locked). No stock_balance row is ever locked by
 * this story (Binding Scope Decision 5): the release gate verifies availability, it does not
 * reserve it.
 *
 * Re-derivation contract: every payload field an applier can derive from a locked row is DECLARED
 * and CHECKED, never trusted - a declared-but-unchecked field is a silent corruption channel on the
 * direct-event path. Divergence rejects 409 PRODUCTION_ORDER_DERIVATION_MISMATCH, except the order
 * number, which has its own 409 ORDER_NUMBER_IMMUTABLE. Canonicalized values (the allocated order
 * number, a trimmed source_reference_id, a trimmed override_reason) are written back onto the
 * payload so the direct-event path and the handler path persist byte-identical payloads.
 */

const PRODUCTION_STREAM_TYPES = new Set(['production']);
const PRODUCTION_ORDER_EVENT_TYPES = new Set([
  'production_order.created',
  'production_order.released',
  'production_order.state_changed',
  'production_order.cancelled',
]);

export const PRODUCTION_ORDER_STATUSES = new Set([
  'planned',
  'released',
  'in_process',
  'completed',
  'closed',
  'cancelled',
]);
const SOURCE_REFERENCE_TYPES = new Set(['erp_sales_order', 'indent', 'rd_project', 'manual']);
// Lifecycle Contract (Table 2): the only legal non-terminal edges.
const STATE_CHANGE_EDGES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['released', new Set(['in_process'])],
  ['in_process', new Set(['completed'])],
  ['completed', new Set(['closed'])],
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches the NUMERIC(18,6) ceiling used across the BOM and production modules.
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT_LENGTH = 512;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(value)) return false;
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split('-').map((part) => Number(part));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d)
    return false;
  const timeMatch = value.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!timeMatch) return false;
  const hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  const ss = Number(timeMatch[3]);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  // PostgreSQL rejects a time zone displacement outside +/-15:59 with SQLSTATE 22009, which is not
  // mapped; bound the offset here so an out-of-range displacement is a clean 400, not a 500.
  const offsetMatch = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const oh = Number(offsetMatch[2]);
    const om = Number(offsetMatch[3]);
    if (oh > 15 || om > 59) return false;
  }
  return true;
}

export function productionOrderEventType(envelope: EventEnvelope): string | null {
  if (!PRODUCTION_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!PRODUCTION_ORDER_EVENT_TYPES.has(envelope.event_type)) return null;
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

export function assertProductionOrderShape(envelope: EventEnvelope): void {
  const type = productionOrderEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['production_order_id'])) {
    reject('INVALID_PAYLOAD', 'production_order_id must be a UUID');
  }
  if (envelope.stream_id !== p['production_order_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must match the payload production_order_id', {
      stream_id: envelope.stream_id,
      payload_production_order_id: p['production_order_id'],
    });
  }

  switch (type) {
    case 'production_order.created':
      assertCreatedShape(p);
      break;
    case 'production_order.released':
      assertReleasedShape(p);
      break;
    case 'production_order.state_changed':
      assertStateChangedShape(p);
      break;
    case 'production_order.cancelled':
      assertCancelledShape(p);
      break;
  }
}

function assertCreatedShape(p: Record<string, unknown>): void {
  // order_number_ext is server-allocated. A declared value is legal (it is rejected in the
  // applier when it disagrees with the allocation) but it must at least be a string when present.
  if (p['order_number_ext'] !== undefined && p['order_number_ext'] !== null) {
    if (typeof p['order_number_ext'] !== 'string') {
      reject('INVALID_PAYLOAD', 'order_number_ext must be a string when present');
    }
  }
  if (!isUuid(p['output_item_id'])) reject('INVALID_PAYLOAD', 'output_item_id must be a UUID');
  if (!isNonEmptyString(p['output_sku'])) {
    reject('INVALID_PAYLOAD', 'output_sku is required');
  }
  assertOrderQuantity(p['order_quantity']);
  if (!isNonEmptyString(p['order_uom'])) reject('INVALID_PAYLOAD', 'order_uom is required');
  if (!isUuid(p['plant_location_id'])) {
    reject('INVALID_PAYLOAD', 'plant_location_id must be a UUID');
  }
  if (!isUuid(p['bom_id'])) reject('INVALID_PAYLOAD', 'bom_id must be a UUID');
  if (!isNonEmptyString(p['business_stream'])) {
    reject('INVALID_PAYLOAD', 'business_stream is required');
  }
  const sourceType = p['source_reference_type'];
  if (typeof sourceType !== 'string' || !SOURCE_REFERENCE_TYPES.has(sourceType)) {
    reject(
      'SOURCE_REFERENCE_REQUIRED',
      'source_reference_type is required and must be erp_sales_order, indent, rd_project or manual',
    );
  }
  const sourceId = p['source_reference_id'];
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    reject('SOURCE_REFERENCE_REQUIRED', 'source_reference_id is required and must not be blank');
  }
  if (typeof sourceId === 'string' && sourceId.trim().length > MAX_TEXT_LENGTH) {
    reject('INVALID_PAYLOAD', 'source_reference_id must be at most 512 characters');
  }
  if (!isUuid(p['created_by'])) reject('INVALID_PAYLOAD', 'created_by must be a UUID');
  if (!isIsoTimestamp(p['created_at'])) {
    reject('INVALID_PAYLOAD', 'created_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertOrderQuantity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL_REGEX.test(value)) {
    reject(
      'INVALID_ORDER_QUANTITY',
      'order_quantity is required and must be a positive decimal string with at most 6 decimal places',
      { order_quantity: typeof value === 'string' ? value : null },
    );
  }
  if (Number(value) <= 0) {
    reject('INVALID_ORDER_QUANTITY', 'order_quantity must be strictly positive', {
      order_quantity: value,
    });
  }
}

function assertReleasedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['released_revision_id'])) {
    reject('INVALID_PAYLOAD', 'released_revision_id must be a UUID');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (typeof p['expediting_flag'] !== 'boolean') {
    reject('INVALID_PAYLOAD', 'expediting_flag must be a boolean');
  }
  const overrideBy = p['override_by'];
  const overrideReason = p['override_reason'];
  if (p['expediting_flag'] === true) {
    // OVERRIDE_REASON_REQUIRED is checked BEFORE any DOA resolution runs, so a non-approver cannot
    // probe the registry with an empty override body.
    if (typeof overrideReason !== 'string' || overrideReason.trim() === '') {
      reject(
        'OVERRIDE_REASON_REQUIRED',
        'An expediting release requires a non-blank override_reason',
      );
    }
    if (typeof overrideReason === 'string' && overrideReason.trim().length > MAX_TEXT_LENGTH) {
      reject('INVALID_PAYLOAD', 'override_reason must be at most 512 characters');
    }
    if (!isUuid(overrideBy)) {
      reject('INVALID_PAYLOAD', 'override_by must be a UUID on an expediting release');
    }
  } else {
    if (overrideBy !== null || overrideReason !== null) {
      reject(
        'INVALID_PAYLOAD',
        'override_by and override_reason must be null on a non-expediting release',
      );
    }
  }
  if (!isUuid(p['released_by'])) reject('INVALID_PAYLOAD', 'released_by must be a UUID');
  if (!isIsoTimestamp(p['released_at'])) {
    reject('INVALID_PAYLOAD', 'released_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertStateChangedShape(p: Record<string, unknown>): void {
  const previousStatus = p['previous_status'];
  if (typeof previousStatus !== 'string' || !PRODUCTION_ORDER_STATUSES.has(previousStatus)) {
    reject(
      'INVALID_PAYLOAD',
      'previous_status must be one of: planned, released, in_process, completed, closed, cancelled',
    );
  }
  const newStatus = p['new_status'];
  if (
    typeof newStatus !== 'string' ||
    !new Set(['in_process', 'completed', 'closed']).has(newStatus)
  ) {
    reject('INVALID_PAYLOAD', 'new_status must be one of: in_process, completed, closed');
  }
  if (!isUuid(p['changed_by'])) reject('INVALID_PAYLOAD', 'changed_by must be a UUID');
  if (!isIsoTimestamp(p['changed_at'])) {
    reject('INVALID_PAYLOAD', 'changed_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertCancelledShape(p: Record<string, unknown>): void {
  const previousStatus = p['previous_status'];
  if (typeof previousStatus !== 'string' || !PRODUCTION_ORDER_STATUSES.has(previousStatus)) {
    reject(
      'INVALID_PAYLOAD',
      'previous_status must be one of: planned, released, in_process, completed, closed, cancelled',
    );
  }
  if (!isUuid(p['cancelled_by'])) reject('INVALID_PAYLOAD', 'cancelled_by must be a UUID');
  if (!isIsoTimestamp(p['cancelled_at'])) {
    reject('INVALID_PAYLOAD', 'cancelled_at must be an ISO 8601 timestamp with an explicit offset');
  }
  const unreversedCount = p['unreversed_transaction_count'];
  if (
    typeof unreversedCount !== 'number' ||
    !Number.isInteger(unreversedCount) ||
    unreversedCount < 0
  ) {
    reject('INVALID_PAYLOAD', 'unreversed_transaction_count must be a non-negative integer');
  }
  const reasonCode = p['reason_code'];
  if (
    reasonCode !== null &&
    (typeof reasonCode !== 'string' ||
      reasonCode.trim() === '' ||
      reasonCode.trim().length > MAX_TEXT_LENGTH)
  ) {
    reject('INVALID_PAYLOAD', 'reason_code must be a non-blank string or null');
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

export async function applyProductionOrderProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = productionOrderEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'production_order.created':
      await applyCreated(envelope, client, eventId);
      break;
    case 'production_order.released':
      await applyReleased(envelope, client);
      break;
    case 'production_order.state_changed':
      await applyStateChanged(envelope, client);
      break;
    case 'production_order.cancelled':
      await applyCancelled(envelope, client);
      break;
  }
}

async function applyCreated(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const outputItemId = p['output_item_id'] as string;
  const plantLocationId = p['plant_location_id'] as string;

  // Locking contract: no order row exists yet (it is being inserted), so the fixed order starts
  // at the item master row, then the location register row.
  const itemResult = await client.query(`SELECT * FROM item_master WHERE item_id = $1 FOR UPDATE`, [
    outputItemId,
  ]);
  if (itemResult.rows.length === 0) {
    reject(
      'ITEM_NOT_FOUND',
      'The output item does not resolve',
      { output_item_id: outputItemId },
      404,
    );
  }
  const item = itemResult.rows[0] as Record<string, unknown>;
  // AC1: the output item must be an active (released) item master - the Story 5.1 A-11 predicate.
  if (!isReleasedItemMaster(item as { status: string })) {
    reject(
      'OUTPUT_ITEM_NOT_ACTIVE',
      'The output item resolves but is not active',
      { output_item_id: outputItemId, status: item['status'] },
      409,
    );
  }
  // output_sku and order_uom are DERIVED from the item master under lock, never trusted.
  const derivedSku = item['sku'] as string;
  const derivedUom = item['uom'] as string;
  if (p['output_sku'] !== derivedSku) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared output_sku does not match the item master',
      {
        production_order_id: productionOrderId,
        declared_output_sku: p['output_sku'],
        derived_output_sku: derivedSku,
      },
      409,
    );
  }
  if (p['order_uom'] !== derivedUom) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared order_uom does not match the item master',
      {
        production_order_id: productionOrderId,
        declared_order_uom: p['order_uom'],
        derived_order_uom: derivedUom,
      },
      409,
    );
  }

  const locationResult = await client.query(
    `SELECT * FROM location_register WHERE location_id = $1 FOR UPDATE`,
    [plantLocationId],
  );
  if (locationResult.rows.length === 0) {
    reject(
      'PLANT_NOT_FOUND',
      'The plant location does not resolve',
      { plant_location_id: plantLocationId },
      404,
    );
  }
  const location = locationResult.rows[0] as Record<string, unknown>;
  // A production order's plant must be an ACTIVE site-level row in the Story 3.1 topology.
  if (location['level'] !== 'site' || location['status'] !== 'active') {
    reject(
      'INVALID_PLANT',
      'The plant location resolves but is not an active site',
      {
        plant_location_id: plantLocationId,
        level: location['level'],
        status: location['status'],
      },
      400,
    );
  }

  // The order number is server-allocated from the sequence and immutable thereafter (Binding
  // Scope Decision 3): never MAX(...)+1, never client-supplied. The year prefix derives from the
  // event's occurred_at exactly as the indent applier does.
  const occurredAt = envelope.metadata.occurred_at;
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
  const year = new Date(occurredAt).getUTCFullYear();
  const allocatedNumber = await allocateProductionOrderNumber(year, client);
  const declaredNumber = p['order_number_ext'];
  if (
    typeof declaredNumber === 'string' &&
    declaredNumber.trim() !== '' &&
    declaredNumber.trim() !== allocatedNumber
  ) {
    reject(
      'ORDER_NUMBER_IMMUTABLE',
      'The order number is server-allocated and cannot be supplied by the caller',
      {
        production_order_id: productionOrderId,
        declared_order_number_ext: declaredNumber,
        allocated_order_number_ext: allocatedNumber,
      },
      409,
    );
  }
  p['order_number_ext'] = allocatedNumber;
  p['created_by'] = envelope.metadata.actor.user_id;
  // Canonicalized write-back (Compliance Seam Contract): the trimmed values are persisted onto the
  // payload so the direct-event path and the handler path store byte-identical domain_events rows.
  p['business_stream'] = (p['business_stream'] as string).trim();
  p['source_reference_id'] = (p['source_reference_id'] as string).trim();

  await insertProductionOrder(
    {
      production_order_id: productionOrderId,
      order_number_ext: allocatedNumber,
      output_item_id: outputItemId,
      output_sku: derivedSku,
      order_quantity: p['order_quantity'] as string,
      order_uom: derivedUom,
      plant_location_id: plantLocationId,
      bom_id: p['bom_id'] as string,
      business_stream: p['business_stream'] as string,
      source_reference_type: p['source_reference_type'] as string,
      source_reference_id: p['source_reference_id'] as string,
      status: 'planned',
      expediting_flag: false,
      override_by: null,
      override_reason: null,
      released_at: null,
      released_by: null,
      cancelled_at: null,
      cancelled_by: null,
      unreversed_transaction_count: 0,
      created_by: envelope.metadata.actor.user_id,
      correlation_id: envelope.metadata.correlation_id ?? null,
      source_event_id: eventId,
      created_at: p['created_at'] as string,
    },
    client,
  );
}

async function applyReleased(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const declaredOverrideBy = p['override_by'] as string | null;
  const expeditingFlag = p['expediting_flag'] === true;

  // Locking contract step 1: the production order row, FOR UPDATE.
  const order = await getProductionOrderByIdForUpdate(productionOrderId, client);
  if (!order) {
    reject(
      'PRODUCTION_ORDER_NOT_FOUND',
      'The production order does not resolve',
      { production_order_id: productionOrderId },
      404,
    );
  }

  // Lifecycle Contract: planned -> released is the only legal release edge.
  if (order.status !== 'planned') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Only a planned production order can be released',
      {
        production_order_id: productionOrderId,
        status: order.status,
      },
      400,
    );
  }

  // The gate re-runs INSIDE this transaction so the verdict reflects the moment of release. The
  // declared released_revision_id is re-derived from the explosion result, never trusted. The gate
  // is evaluated against SERVER time, never the envelope's client-controlled occurred_at, so a
  // backdated direct event cannot select an older effective BOM line set and weaken AC5 coverage
  // (the year prefix on creation is the one place occurred_at is used, per Binding Scope Decision 3).
  const gate = await evaluateReleaseGate(
    {
      bom_id: order.bom_id,
      output_item_id: order.output_item_id,
      plant_location_id: order.plant_location_id,
      quantity: order.order_quantity,
      occurred_at: new Date().toISOString(),
    },
    client,
  );
  if (p['released_revision_id'] !== gate.revision_id) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared released_revision_id does not match the release gate revision',
      {
        production_order_id: productionOrderId,
        declared_released_revision_id: p['released_revision_id'],
        derived_released_revision_id: gate.revision_id,
      },
      409,
    );
  }

  // Release Gate Contract: a truncated or empty explosion means the requirement set is unknown or
  // empty, so release is barred EVEN with an override - the override waives an availability
  // shortfall (AC6), not structural incompleteness.
  if (gate.depth_truncated) {
    reject(
      'INSUFFICIENT_STOCK',
      'The BOM explosion was depth-truncated; the requirement set is incomplete',
      {
        production_order_id: productionOrderId,
        bom_id: order.bom_id,
        depth_truncated: true,
      },
      409,
    );
  }
  if (gate.empty_requirement_set) {
    reject(
      'INSUFFICIENT_STOCK',
      'The BOM exploded to an empty requirement set',
      {
        production_order_id: productionOrderId,
        bom_id: order.bom_id,
        empty_requirement_set: true,
      },
      409,
    );
  }

  let overrideBy: string | null = null;
  let overrideReason: string | null = null;
  if (expeditingFlag) {
    // AC6 / AC7, re-derived under the transaction (AD-12): the override authority is the DOA
    // registry, never a hard-coded role, and a forged override_by cannot bypass it.
    const approval = await resolveApprover('production_order.release_override', 0);
    if (!approval.requiresApproval || approval.approverActorId === null) {
      reject(
        'APPROVAL_UNRESOLVED',
        'No DOA entry governs production_order.release_override',
        { transaction_type: 'production_order.release_override' },
        404,
      );
    }
    if (declaredOverrideBy !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'A release override requires the resolved DOA approver',
        {
          production_order_id: productionOrderId,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    // AC7: the ACTING user must be the resolved approver, not merely a payload field that names
    // them. A non-approver with production stream write could otherwise forge an expedited release
    // on the direct-event path by declaring override_by = the approver's UUID.
    if (envelope.metadata.actor.user_id !== approval.approverActorId) {
      reject(
        'APPROVAL_REQUIRED',
        'A release override requires the acting user to be the resolved DOA approver',
        {
          production_order_id: productionOrderId,
          acting_user_id: envelope.metadata.actor.user_id,
          resolved_approver_user_id: approval.approverActorId,
        },
        403,
      );
    }
    overrideBy = approval.approverActorId;
    overrideReason = (p['override_reason'] as string).trim();
    p['override_by'] = overrideBy;
    p['override_reason'] = overrideReason;
  } else if (!gate.satisfied) {
    // AC5: availability must cover every component line; no override means a hard 409. The gate
    // never throws INSUFFICIENT_STOCK - the release path raises it with the per-line shortfalls.
    reject(
      'INSUFFICIENT_STOCK',
      'Material availability does not cover every component line',
      {
        production_order_id: productionOrderId,
        bom_id: order.bom_id,
        depth_truncated: gate.depth_truncated,
        empty_requirement_set: gate.empty_requirement_set,
        lines: gate.lines.map((line) => ({
          component_item_id: line.component_item_id,
          component_sku: line.component_sku,
          required_quantity: line.required_quantity,
          available_quantity: line.available_quantity,
          shortfall_quantity: line.shortfall_quantity,
          satisfied: line.satisfied,
        })),
      },
      409,
    );
  }

  p['released_by'] = envelope.metadata.actor.user_id;

  await updateProductionOrderState(
    productionOrderId,
    {
      status: 'released',
      released_revision_id: gate.revision_id,
      expediting_flag: expeditingFlag,
      override_by: overrideBy,
      override_reason: overrideReason,
      released_at: p['released_at'] as string,
      released_by: envelope.metadata.actor.user_id,
    },
    client,
  );
}

async function applyStateChanged(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const declaredPreviousStatus = p['previous_status'] as string;
  const newStatus = p['new_status'] as 'in_process' | 'completed' | 'closed';

  const order = await getProductionOrderByIdForUpdate(productionOrderId, client);
  if (!order) {
    reject(
      'PRODUCTION_ORDER_NOT_FOUND',
      'The production order does not resolve',
      { production_order_id: productionOrderId },
      404,
    );
  }

  // previous_status is re-derived from the locked row, never trusted.
  if (order.status !== declaredPreviousStatus) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared previous_status does not match the order status',
      {
        production_order_id: productionOrderId,
        declared_previous_status: declaredPreviousStatus,
        derived_previous_status: order.status,
      },
      409,
    );
  }

  // Lifecycle Contract (Table 2): released -> in_process -> completed -> closed. Any other pair
  // rejects; no silent no-op.
  const allowed = STATE_CHANGE_EDGES.get(order.status);
  if (!allowed || !allowed.has(newStatus)) {
    reject(
      'INVALID_STATE_TRANSITION',
      'The status transition is not allowed',
      {
        production_order_id: productionOrderId,
        previous_status: order.status,
        new_status: newStatus,
      },
      400,
    );
  }

  p['changed_by'] = envelope.metadata.actor.user_id;

  await updateProductionOrderState(productionOrderId, { status: newStatus }, client);
}

async function applyCancelled(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const productionOrderId = p['production_order_id'] as string;
  const declaredPreviousStatus = p['previous_status'] as string;

  const order = await getProductionOrderByIdForUpdate(productionOrderId, client);
  if (!order) {
    reject(
      'PRODUCTION_ORDER_NOT_FOUND',
      'The production order does not resolve',
      { production_order_id: productionOrderId },
      404,
    );
  }

  if (order.status !== declaredPreviousStatus) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared previous_status does not match the order status',
      {
        production_order_id: productionOrderId,
        declared_previous_status: declaredPreviousStatus,
        derived_previous_status: order.status,
      },
      409,
    );
  }

  // Lifecycle Contract (AC3): cancelled is reachable only from planned or released. Terminal
  // states (cancelled, closed) and work states (in_process, completed) reject.
  if (order.status !== 'planned' && order.status !== 'released') {
    reject(
      'INVALID_STATE_TRANSITION',
      'Cancellation is only allowed from planned or released',
      {
        production_order_id: productionOrderId,
        status: order.status,
      },
      400,
    );
  }

  // Event Contract Table 1: unreversed_transaction_count is declared and re-derived from the locked
  // row, never trusted - the AC4 guard below reads the same authoritative value.
  const declaredUnreversedCount = p['unreversed_transaction_count'] as number;
  if (declaredUnreversedCount !== order.unreversed_transaction_count) {
    reject(
      'PRODUCTION_ORDER_DERIVATION_MISMATCH',
      'Declared unreversed_transaction_count does not match the order',
      {
        production_order_id: productionOrderId,
        declared_unreversed_transaction_count: declaredUnreversedCount,
        derived_unreversed_transaction_count: order.unreversed_transaction_count,
      },
      409,
    );
  }

  // AC4: a released order with unreversed material transactions cannot be cancelled until every
  // issue is returned or reversed. The counter is written only by Story 6.2.
  if (order.status === 'released' && order.unreversed_transaction_count > 0) {
    reject(
      'UNREVERSED_TRANSACTIONS',
      'The order has unreversed material transactions and cannot be cancelled',
      {
        production_order_id: productionOrderId,
        unreversed_transaction_count: order.unreversed_transaction_count,
      },
      409,
    );
  }

  // Story 6.2 cancel rollback (code-review decision 2026-08-28): staged-but-unissued stock is
  // returned to `available` and the stage rows are cleared inside this cancel transaction. The AC4
  // guard above has already blocked any cancel while WIP postings are open, so every 'allocated'
  // stage row here carries only its remaining (required - issued) allocated stock; a fully-issued
  // row never reaches this point and keeps its staging history. Lock order preserved: the order row
  // is already locked FOR UPDATE, stage rows are read without a lock, and stock_balance rows are
  // locked only inside the helper - always last (the 7.4 rule).
  const stageRows = await listStagesByOrder(productionOrderId, client);
  for (const stage of stageRows) {
    if (stage.status !== 'allocated') continue;
    const remainingResult = await client.query(
      `SELECT (required_quantity - issued_quantity)::text AS remaining
         FROM production_order_stage WHERE stage_id = $1`,
      [stage.stage_id],
    );
    const remaining = String(remainingResult.rows[0]!['remaining']);
    if (remaining !== '0') {
      await applyStockDeallocation(
        {
          sku: stage.component_sku,
          location_id: stage.source_location_id,
          lot_id: stage.lot_number,
          quantity: remaining,
        },
        client,
      );
    }
    await client.query(`DELETE FROM production_order_stage WHERE stage_id = $1`, [stage.stage_id]);
  }

  p['cancelled_by'] = envelope.metadata.actor.user_id;

  await updateProductionOrderState(
    productionOrderId,
    {
      status: 'cancelled',
      cancelled_at: p['cancelled_at'] as string,
      cancelled_by: envelope.metadata.actor.user_id,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path return the SAME error code with the SAME existing_* detail
 * (the Story 7.2 lesson). The number is server-allocated, so the only realistic race is two
 * concurrent applications of the SAME event (same production_order_id); resolve against that row so
 * a caller that lost a concurrent race is told exactly what a caller that arrived second
 * sequentially is told.
 */
export async function resolveProductionOrderNumberDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const productionOrderId = isUuid(payload['production_order_id'])
    ? (payload['production_order_id'] as string)
    : null;
  const attempted: Record<string, unknown> = { production_order_id: productionOrderId };
  if (productionOrderId !== null) {
    const existing = await getProductionOrderById(productionOrderId);
    if (existing) {
      return {
        ...attempted,
        existing_order_id: existing.production_order_id,
        existing_order_number_ext: existing.order_number_ext,
      };
    }
  }
  return attempted;
}
