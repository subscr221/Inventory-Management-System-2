import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemBySku } from '../read/projections/item_master.js';
import {
  findActiveDelegation,
  findMatchingDoaEntry,
  findRoleHolder,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import { getSerialByNumberAndSku } from '../read/projections/serial_master.js';
import {
  getCycleCountById,
  getCycleCountLineByAdjustment,
  insertCycleCountHeader,
  insertCycleCountLine,
  markCycleCountSubmitted,
  setAdjustmentStatus,
  markAdjustmentApplied,
} from '../read/projections/cycle_count.js';
import {
  getPhysicalVerificationById,
  insertPhysicalVerificationHeader,
  insertPhysicalVerificationLine,
  markPhysicalVerificationSignedOff,
} from '../read/projections/physical_verification.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { insertCustodyLedgerEntry } from '../read/projections/custody_ledger_entry.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
// Story 9.5 code review (chunk 2): the scaled-integer helpers, so the NUMERIC(18,6) verification
// variance is rounded to the ledger's NUMERIC(18,3) scale here rather than by an unclassified
// Postgres CHECK violation at insert time. Imported from custody-statement (a leaf module) rather
// than custody-ledger, to keep this file free of a compliance-to-compliance import cycle.
import { qtyFromScaled, qtyToScaled } from './custody-statement.js';
import { getCycleCountLines } from '../read/projections/cycle_count.js';

/**
 * Central cycle-count compliance seam (Story 2.6). Split like every other seam:
 *
 * - assertCycleCountShape runs BEFORE any DB work, next to the other pre-transaction asserts, so a
 *   malformed count event is rejected without consuming an idempotency key.
 * - applyCycleCountProjection runs INSIDE the event transaction, BEFORE the domain_events insert. It
 *   computes variance from the ledger under FOR UPDATE locks, drives the DOA-gated adjustment
 *   lifecycle, and applies approved stock adjustments. The AC2/Task 5 invariant lives here: a
 *   stock.adjusted event whose adjustment is not APPROVED is rejected with APPROVAL_REQUIRED, so a
 *   direct POST /api/v1/events or edge upload cannot bypass the approval gate.
 *
 * Gating is deliberately narrow: only `inventory` stream events of the new count / adjustment /
 * physical-verification types. Every older stock, lot, valuation, transfer, DOA, SCIM, and audit
 * event passes through byte-for-byte unaffected.
 */

const CYCLE_COUNT_STREAM_TYPES = new Set(['inventory']);
const CYCLE_COUNT_EVENT_TYPES = new Set([
  'cycle_count.task_created',
  'cycle_count.submitted',
  'cycle_count.adjustment_approved',
  'cycle_count.adjustment_rejected',
  'stock.adjusted',
  'physical_verification.completed',
  'physical_verification.signed_off',
]);

// DUPLICATED from src/compliance/stock-balance.ts - the two sets must be extended together, and
// the duplication is the trap: a class present there but missing here is refused INVALID_PARAMS by
// every count path before it can be counted. 'prototype' is a Story 8.8 ORIGIN class (BSD-9);
// counting it is legitimate, only allocating or laundering it into 'owned' is barred, and that bar
// lives at the stock-balance applier choke point.
const VALID_STOCK_CLASSES = new Set([
  'owned',
  'consignment',
  'vmi',
  'job_work',
  'prototype',
  // Story 9.6 (revised 2026-09-05): contractual offcut retained pending disposal. Still the
  // CUSTOMER's material - the Section 143 clock keeps running against it - so it is segregated on
  // exactly the same terms as job_work and must never launder into owned stock. It is a distinct
  // class rather than job_work so that material awaiting an offcut disposal is separable from
  // material still in process on the shop floor.
  'offcut',
]);
/**
 * Story 9.2 (FR-JW-04): mirrors stock-balance.ts SEGREGATED_STOCK_CLASSES verbatim - the classes
 * the lot-level laundering bar segregates ('prototype' with its FR-Q-12 PROTOTYPE_NOT_SALEABLE
 * code from Story 8.8, 'job_work' customer-owned material with CROSS_ISSUE_BLOCKED). The two
 * files move together.
 */
const SEGREGATED_STOCK_CLASSES = new Set(['prototype', 'job_work', 'offcut']);
const JOB_WORK_STOCK_CLASS = 'job_work';
const COUNT_ADJUSTMENT_DOA_TYPE = 'inventory.count_adjustment';
const SIGNOFF_ROLES = new Set([
  'inventory_controller',
  'warehouse_manager',
  'finance_controller',
  'audit_signoff',
]);
const MAX_QUANTITY = 1e12;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CYCLE_COUNT_ERROR_CODES = {
  COUNT_TASK_LOCKED: 'COUNT_TASK_LOCKED',
  COUNT_ENTERER_CANNOT_APPROVE: 'COUNT_ENTERER_CANNOT_APPROVE',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  COUNT_VARIANCE_REQUIRES_APPROVAL: 'COUNT_VARIANCE_REQUIRES_APPROVAL',
  STOCK_ADJUSTMENT_NEGATIVE_BALANCE: 'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return isNonEmptyString(value) && UUID_REGEX.test(value);
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO8601_REGEX.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(parsed);
  if (match[7] === 'Z') {
    return (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() + 1 === Number(month) &&
      date.getUTCDate() === Number(day) &&
      date.getUTCHours() === Number(hour) &&
      date.getUTCMinutes() === Number(minute) &&
      date.getUTCSeconds() === Number(second)
    );
  }
  return (
    isLocalDate(`${year}-${month}-${day}`) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
}

function localYmd(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertOptionalPercent(value: unknown, field: string): void {
  if (value !== undefined && (!isNonNegativeFinite(value) || value > 100)) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a finite number between 0 and 100`);
  }
}

export function cycleCountEventType(envelope: EventEnvelope): string | null {
  if (!CYCLE_COUNT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!CYCLE_COUNT_EVENT_TYPES.has(envelope.event_type)) return null;
  // `stock.adjusted` is claimed by this seam ONLY when it carries a cycle-count adjustment_id.
  // The Story 1.9 spine fixtures emit a legacy sku-less `stock.adjusted` with no adjustment_id;
  // those pass through untouched (they touch no balance projection either), exactly as the
  // stock-balance and lot-serial seams let legacy shapes through. A stock mutation via
  // stock.adjusted is therefore only ever possible with an adjustment_id, which forces the
  // approval gate below.
  if (envelope.event_type === 'stock.adjusted' && envelope.payload['adjustment_id'] === undefined) {
    return null;
  }
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation
// ---------------------------------------------------------------------------

export function assertCycleCountShape(envelope: EventEnvelope): void {
  const type = cycleCountEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (type === 'cycle_count.task_created') {
    if (!isUuid(p['cycle_count_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!isUuid(p['location_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    }
    if (
      !Array.isArray(p['sku_scope']) ||
      p['sku_scope'].length === 0 ||
      !p['sku_scope'].every(isNonEmptyString)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'sku_scope is required and must be a non-empty array of SKUs',
      );
    }
    if (!isNonEmptyString(p['count_type'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'count_type is required');
    }
    if (!isLocalDate(p['business_date'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'business_date is required and must be a real YYYY-MM-DD date',
      );
    }
    assertOptionalPercent(p['tolerance_percent'], 'tolerance_percent');
    if (
      p['stock_class'] !== undefined &&
      (typeof p['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(p['stock_class']))
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`,
      );
    }
    return;
  }

  if (type === 'cycle_count.submitted') {
    if (!isUuid(p['cycle_count_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!Array.isArray(p['lines']) || p['lines'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'lines is required and must be a non-empty array');
    }
    for (const line of p['lines'] as unknown[]) {
      if (typeof line !== 'object' || line === null) {
        throw new AppError(400, 'INVALID_PARAMS', 'each count line must be an object');
      }
      const l = line as Record<string, unknown>;
      if (!isNonEmptyString(l['sku'])) {
        throw new AppError(400, 'INVALID_PARAMS', 'each count line requires a non-empty sku');
      }
      if (
        !isNonNegativeFinite(l['counted_quantity']) ||
        (l['counted_quantity'] as number) > MAX_QUANTITY
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'counted_quantity must be a non-negative finite number within bounds',
        );
      }
      if (l['lot_id'] !== undefined && !isNonEmptyString(l['lot_id'])) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'lot_id must be a non-empty string when supplied',
        );
      }
      if (
        l['stock_class'] !== undefined &&
        (typeof l['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(l['stock_class']))
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`,
        );
      }
      if (
        l['serials'] !== undefined &&
        (!Array.isArray(l['serials']) || !l['serials'].every(isNonEmptyString))
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'serials must be an array of non-empty strings when supplied',
        );
      }
      if (
        l['unit_cost'] !== undefined &&
        (!isNonNegativeFinite(l['unit_cost']) || (l['unit_cost'] as number) > MAX_QUANTITY)
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'unit_cost must be a non-negative finite number within bounds when supplied',
        );
      }
    }
    return;
  }

  if (type === 'cycle_count.adjustment_approved' || type === 'cycle_count.adjustment_rejected') {
    if (!isUuid(p['adjustment_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'adjustment_id is required and must be a UUID');
    }
    if (!isUuid(p['cycle_count_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!isUuid(p['approver_actor_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['reason_code'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required');
    }
    return;
  }

  if (type === 'stock.adjusted') {
    if (!isUuid(p['adjustment_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'adjustment_id is required and must be a UUID');
    }
    if (!isUuid(p['cycle_count_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'cycle_count_id is required and must be a UUID');
    }
    if (!isNonEmptyString(p['sku'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'sku is required for stock.adjusted');
    }
    if (!isUuid(p['target_location_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'target_location_id is required and must be a UUID',
      );
    }
    if (
      !isFiniteNumber(p['delta_quantity']) ||
      p['delta_quantity'] === 0 ||
      Math.abs(p['delta_quantity']) > MAX_QUANTITY
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'delta_quantity must be a non-zero finite number within bounds',
      );
    }
    if (p['available'] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'available is derived and must not be supplied');
    }
    if (p['lot_id'] !== undefined && !isNonEmptyString(p['lot_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
    }
    if (
      p['stock_class'] !== undefined &&
      (typeof p['stock_class'] !== 'string' || !VALID_STOCK_CLASSES.has(p['stock_class']))
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`,
      );
    }
    if (!isUuid(p['approver_actor_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'approver_actor_id is required and must be a UUID for stock.adjusted',
      );
    }
    if (!isNonEmptyString(p['reason_code'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required for stock.adjusted');
    }
    return;
  }

  if (type === 'physical_verification.completed') {
    if (!isUuid(p['physical_verification_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'physical_verification_id is required and must be a UUID',
      );
    }
    if (!isUuid(p['location_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    }
    if (
      !Array.isArray(p['count_refs']) ||
      p['count_refs'].length === 0 ||
      !p['count_refs'].every(isUuid)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'count_refs is required and must be a non-empty array of cycle_count_ids',
      );
    }
    if (new Set(p['count_refs'] as string[]).size !== (p['count_refs'] as string[]).length) {
      throw new AppError(400, 'INVALID_PARAMS', 'count_refs must not contain duplicates');
    }
    assertOptionalPercent(p['coverage_percentage'], 'coverage_percentage');
    if (p['business_date'] !== undefined && !isLocalDate(p['business_date'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'business_date must be a real YYYY-MM-DD date when supplied',
      );
    }
    if (p['period_start'] !== undefined && !isLocalDate(p['period_start'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'period_start must be a real YYYY-MM-DD date when supplied',
      );
    }
    if (p['period_end'] !== undefined && !isLocalDate(p['period_end'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'period_end must be a real YYYY-MM-DD date when supplied',
      );
    }
    if (
      typeof p['period_start'] === 'string' &&
      typeof p['period_end'] === 'string' &&
      p['period_start'] > p['period_end']
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'period_start must be on or before period_end');
    }
    return;
  }

  if (type === 'physical_verification.signed_off') {
    if (!isUuid(p['physical_verification_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'physical_verification_id is required and must be a UUID',
      );
    }
    if (!isUuid(p['management_signoff_actor_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'management_signoff_actor_id is required and must be a UUID',
      );
    }
    if (p['signed_off_at'] !== undefined && !isIsoTimestamp(p['signed_off_at'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'signed_off_at must be a valid ISO-8601 timestamp when supplied',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function resolveUnitCost(
  sku: string,
  stockClass: string,
  fallback: number | null,
  client: PoolClient,
): Promise<string> {
  if (
    fallback !== null &&
    (!Number.isFinite(fallback) || fallback < 0 || fallback > MAX_QUANTITY)
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'unit_cost must be a non-negative finite number within bounds when supplied',
    );
  }
  if (stockClass !== 'owned') {
    if (fallback === null) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'unit_cost is required for non-owned stock count variance banding',
      );
    }
    return String(fallback);
  }
  const r = await client.query(
    `SELECT running_average_cost::text AS running_average_cost FROM inventory_valuation WHERE sku = $1`,
    [sku],
  );
  const avg = r.rows[0]?.['running_average_cost'];
  if (avg !== undefined && avg !== null) return String(avg);
  return String(fallback ?? 0);
}

async function multiplyNumeric(
  absQuantity: number,
  unitCost: string,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(`SELECT ($1::numeric * $2::numeric)::text AS value`, [
    absQuantity,
    unitCost,
  ]);
  return result.rows[0]!['value'] as string;
}

async function resolveCountApprover(varianceValue: number, client: PoolClient): Promise<string> {
  const value = Math.abs(varianceValue);
  const doaEntry = await findMatchingDoaEntry(COUNT_ADJUSTMENT_DOA_TYPE, value, client);
  if (!doaEntry) {
    throw new AppError(
      409,
      'APPROVAL_UNRESOLVED',
      'Count adjustment requires approval but no DOA band governs the variance value',
      {
        transaction_type: COUNT_ADJUSTMENT_DOA_TYPE,
        variance_value: value,
      },
    );
  }
  const today = localYmd();
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation?.delegate_user_id ?? holder.user_id;
  };

  let approver: string | null = await tryHolder(doaEntry.role);
  if (!approver) {
    const entries = await listActiveDoaEntries(COUNT_ADJUSTMENT_DOA_TYPE, client);
    for (const e of entries) {
      if (e.role === doaEntry.role) continue;
      approver = await tryHolder(e.role);
      if (approver) break;
    }
  }
  if (!approver) {
    throw new AppError(
      409,
      'APPROVAL_UNRESOLVED',
      'Count adjustment requires approval but no active approver could be resolved',
      {
        transaction_type: COUNT_ADJUSTMENT_DOA_TYPE,
      },
    );
  }
  return approver;
}

export async function applyCycleCountProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = cycleCountEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;

  if (type === 'cycle_count.task_created') {
    const cycleCountId = p['cycle_count_id'] as string;
    const existing = await getCycleCountById(cycleCountId, client);
    if (existing) {
      throw new AppError(409, 'INVALID_STATE', `Cycle count "${cycleCountId}" already exists`);
    }
    for (const sku of p['sku_scope'] as string[]) {
      const item = await getItemBySku(sku, client);
      if (!item || item.status !== 'active') {
        throw new AppError(
          404,
          'ITEM_NOT_FOUND',
          `No active item master record exists for sku "${sku}"`,
          { sku },
        );
      }
    }
    await insertCycleCountHeader(
      {
        cycle_count_id: cycleCountId,
        location_id: p['location_id'] as string,
        zone_id: (p['zone_id'] as string | undefined) ?? null,
        sku_scope: p['sku_scope'] as string[],
        stock_class: (p['stock_class'] as string | undefined) ?? null,
        count_type: p['count_type'] as string,
        business_date: p['business_date'] as string,
        business_stream: p['business_stream'] as string,
        tolerance_percent: (p['tolerance_percent'] as number | undefined) ?? 0,
        created_by_actor_id:
          (p['created_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
        notes: (p['notes'] as string | undefined) ?? null,
      },
      client,
    );
    return;
  }

  if (type === 'cycle_count.submitted') {
    await applySubmitted(envelope, client);
    return;
  }

  if (type === 'cycle_count.adjustment_approved') {
    await applyAdjustmentDecision(envelope, client, 'approved');
    return;
  }

  if (type === 'cycle_count.adjustment_rejected') {
    await applyAdjustmentDecision(envelope, client, 'rejected');
    return;
  }

  if (type === 'stock.adjusted') {
    await applyStockAdjusted(envelope, client, eventId);
    return;
  }

  if (type === 'physical_verification.completed') {
    await applyPhysicalVerificationCompleted(envelope, client, eventId);
    return;
  }

  if (type === 'physical_verification.signed_off') {
    await applyPhysicalVerificationSignedOff(envelope, client, eventId);
    return;
  }
}

// --- cycle_count.submitted -------------------------------------------------

async function applySubmitted(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const cycleCountId = p['cycle_count_id'] as string;
  const lines = p['lines'] as Array<Record<string, unknown>>;
  const submittedBy =
    (p['submitted_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id;
  const approverActorId = (p['approver_actor_id'] as string | undefined) ?? null;

  const header = await getCycleCountById(cycleCountId, client, true);
  if (!header) {
    throw new AppError(404, 'NOT_FOUND', `Cycle count "${cycleCountId}" not found`);
  }
  if (header.status !== 'open') {
    throw new AppError(
      409,
      CYCLE_COUNT_ERROR_CODES.COUNT_TASK_LOCKED,
      `Cycle count is in status "${header.status}"`,
    );
  }

  const seenGrains = new Set<string>();
  for (const line of lines) {
    const sku = line['sku'] as string;
    const lotId = (line['lot_id'] as string | undefined) ?? null;
    const stockClass = (line['stock_class'] as string | undefined) ?? header.stock_class ?? 'owned';
    if (!header.sku_scope.includes(sku)) {
      throw new AppError(400, 'INVALID_PARAMS', `SKU "${sku}" is outside the cycle-count scope`);
    }
    const grain = `${sku}\u0000${lotId ?? ''}\u0000${stockClass}`;
    if (seenGrains.has(grain)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'Duplicate count line for the same SKU, lot, and stock_class',
      );
    }
    seenGrains.add(grain);
  }

  const { randomUUID } = await import('node:crypto');

  for (const line of lines) {
    const sku = line['sku'] as string;
    const lotId = (line['lot_id'] as string | undefined) ?? null;
    const stockClass = (line['stock_class'] as string | undefined) ?? header.stock_class ?? 'owned';
    const counted = line['counted_quantity'] as number;
    const serials = line['serials'] as string[] | undefined;

    // Lot / serial control (Story 2.3 preservation): a lot-controlled item must supply a lot line;
    // a serial-controlled item must supply counted serials matching the counted quantity.
    const item = await getItemBySku(sku, client);
    if (!item || item.status !== 'active') {
      throw new AppError(
        404,
        'ITEM_NOT_FOUND',
        `No active item master record exists for sku "${sku}"`,
        { sku },
      );
    }
    if (item.serial_controlled) {
      if (!Number.isInteger(counted)) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'counted_quantity must be an integer for a serial-controlled item',
          { sku },
        );
      }
      if (!serials || serials.length === 0) {
        throw new AppError(
          400,
          'SERIAL_REQUIRED',
          `Serial-controlled item "${sku}" requires counted serials`,
          { sku },
        );
      }
      if (new Set(serials).size !== serials.length) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'Counted serials must be unique for a serial-controlled item',
          { sku },
        );
      }
      if (serials.length !== counted) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'Counted serials must match counted_quantity for a serial-controlled item',
          {
            sku,
            serials: serials.length,
            counted_quantity: counted,
          },
        );
      }
      for (const serial of serials) {
        const serialRow = await getSerialByNumberAndSku(serial, sku, client);
        if (!serialRow) {
          throw new AppError(
            400,
            'SERIAL_NOT_FOUND',
            `Serial "${serial}" does not exist for SKU "${sku}"`,
            { sku, serial },
          );
        }
        if (
          serialRow.current_location_id !== header.location_id ||
          Number(serialRow.current_quantity) <= 0
        ) {
          throw new AppError(
            400,
            'SERIAL_NOT_AVAILABLE',
            `Serial "${serial}" is not available at the counted location`,
            { sku, serial },
          );
        }
        if (lotId !== null && serialRow.lot_id !== lotId) {
          throw new AppError(
            400,
            'SERIAL_LOT_MISMATCH',
            `Serial "${serial}" is not assigned to lot "${lotId}"`,
            { sku, serial, lot_id: lotId },
          );
        }
      }
    } else if (item.lot_controlled && !lotId) {
      throw new AppError(
        400,
        'LOT_REQUIRED',
        `Lot-controlled item "${sku}" requires a lot on the count line`,
        { sku },
      );
    }
    if (lotId !== null && !(await getLotByNumberAndSku(lotId, sku, client))) {
      throw new AppError(
        400,
        'LOT_SKU_MISMATCH',
        `Lot "${lotId}" does not belong to SKU "${sku}"`,
        { sku, lot_id: lotId },
      );
    }

    // Lock the balance rows at this grain and read the book (on_hand) baseline, plus allocated /
    // in_transit reported separately so counters never make hidden adjustments for reserved or
    // shipped stock (Task 4).
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${sku}|${header.location_id}|${lotId ?? ''}|${stockClass}`,
    ]);
    await client.query(
      `SELECT balance_id FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = $4
        FOR UPDATE`,
      [sku, header.location_id, lotId, stockClass],
    );
    const bookRow = await client.query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
               COALESCE(SUM(allocated), 0)::text AS allocated,
               COALESCE(SUM(in_transit), 0)::text AS in_transit
        FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = $4`,
      [sku, header.location_id, lotId, stockClass],
    );
    const book = Number(bookRow.rows[0]!['on_hand']);
    const allocated = Number(bookRow.rows[0]!['allocated']);
    const inTransit = Number(bookRow.rows[0]!['in_transit']);
    const variance = counted - book;

    // Tolerance: percent of book when configured; zero tolerance means any non-zero variance
    // breaches and routes to approval (Task 4 default).
    let breach: boolean;
    const tolerancePercent = item.count_variance_tolerance_percent ?? header.tolerance_percent ?? 0;
    if (tolerancePercent > 0 && book > 0) {
      breach = (Math.abs(variance) / book) * 100 > tolerancePercent;
    } else {
      breach = variance !== 0;
    }

    const unitCost = await resolveUnitCost(
      sku,
      stockClass,
      (line['unit_cost'] as number | undefined) ?? null,
      client,
    );
    const varianceValue = await multiplyNumeric(Math.abs(variance), unitCost, client);

    let adjustmentId: string | null = null;
    let adjustmentStatus: string | null = null;
    let lineApprover: string | null = null;
    if (breach && variance !== 0) {
      adjustmentId = randomUUID();
      adjustmentStatus = 'pending_approval';
      lineApprover = approverActorId;
    }

    await insertCycleCountLine(
      {
        cycle_count_id: cycleCountId,
        sku,
        lot_id: lotId,
        stock_class: stockClass,
        counted_quantity: counted,
        book_quantity: book,
        allocated_quantity: allocated,
        in_transit_quantity: inTransit,
        variance_quantity: variance,
        variance_value: varianceValue,
        tolerance_breach: breach,
        adjustment_id: adjustmentId,
        adjustment_status: adjustmentStatus,
        approver_actor_id: lineApprover,
      },
      client,
    );
  }

  await markCycleCountSubmitted(cycleCountId, submittedBy, client);
}

// --- cycle_count.adjustment_approved / _rejected ---------------------------

async function applyAdjustmentDecision(
  envelope: EventEnvelope,
  client: PoolClient,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const adjustmentId = p['adjustment_id'] as string;
  const cycleCountId = p['cycle_count_id'] as string;
  const approver = envelope.metadata.actor.user_id;
  const suppliedApprover = p['approver_actor_id'] as string;
  const reasonCode = p['reason_code'] as string;
  if (suppliedApprover !== approver) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Adjustment decision approver must match the authenticated actor',
      {
        supplied_approver_actor_id: suppliedApprover,
        actor_user_id: approver,
      },
    );
  }

  const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
  if (!line || line.cycle_count_id !== cycleCountId) {
    throw new AppError(
      404,
      'NOT_FOUND',
      `No adjustment "${adjustmentId}" found for cycle count "${cycleCountId}"`,
    );
  }
  if (line.adjustment_status !== 'pending_approval') {
    throw new AppError(409, 'INVALID_STATE', `Adjustment is in status "${line.adjustment_status}"`);
  }

  const header = await getCycleCountById(line.cycle_count_id, client);
  if (header?.submitted_by_actor_id && header.submitted_by_actor_id === approver) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.COUNT_ENTERER_CANNOT_APPROVE,
      'The count submitter cannot approve its own adjustment',
    );
  }
  const resolvedApprover = await resolveCountApprover(line.variance_value, client);
  if (resolvedApprover !== approver) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Approver is not the DOA-resolved approver for this adjustment',
      {
        approver_actor_id: resolvedApprover,
        supplied_approver_actor_id: approver,
      },
    );
  }

  await setAdjustmentStatus(adjustmentId, decision, reasonCode, approver, client);
}

// --- stock.adjusted (the AC2 / Task 5 enforcement point) -------------------

async function applyStockAdjusted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const adjustmentId = p['adjustment_id'] as string;
  const cycleCountId = p['cycle_count_id'] as string;
  const sku = p['sku'] as string;
  const locationId = p['target_location_id'] as string;
  const lotId = (p['lot_id'] as string | undefined) ?? null;
  const stockClass = (p['stock_class'] as string | undefined) ?? 'owned';
  const delta = p['delta_quantity'] as number;
  const approver = p['approver_actor_id'] as string;
  if (approver !== envelope.metadata.actor.user_id) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Stock adjustment approver must match the authenticated actor',
      {
        supplied_approver_actor_id: approver,
        actor_user_id: envelope.metadata.actor.user_id,
      },
    );
  }

  const line = await getCycleCountLineByAdjustment(adjustmentId, client, true);
  // AC2: no approved adjustment backing this stock mutation -> reject centrally, so a direct
  // POST /api/v1/events or edge upload cannot bypass the approval gate.
  if (!line) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Stock adjustment requires an approved cycle-count adjustment',
      {
        adjustment_id: adjustmentId,
      },
    );
  }
  if (line.adjustment_status === 'applied') {
    throw new AppError(409, 'INVALID_STATE', 'Adjustment is already applied');
  }
  if (line.adjustment_status !== 'approved') {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Stock adjustment requires an approved cycle-count adjustment',
      {
        adjustment_id: adjustmentId,
        adjustment_status: line.adjustment_status,
      },
    );
  }
  const header = await getCycleCountById(line.cycle_count_id, client, true);
  if (!header) {
    throw new AppError(404, 'NOT_FOUND', `Cycle count "${line.cycle_count_id}" not found`);
  }
  if (
    line.cycle_count_id !== cycleCountId ||
    line.sku !== sku ||
    line.lot_id !== lotId ||
    line.stock_class !== stockClass ||
    header.location_id !== locationId ||
    Math.abs(line.variance_quantity - delta) > 0.000001 ||
    line.approver_actor_id !== approver
  ) {
    throw new AppError(
      403,
      CYCLE_COUNT_ERROR_CODES.APPROVAL_REQUIRED,
      'Stock adjustment payload must match the approved count variance exactly',
      {
        adjustment_id: adjustmentId,
      },
    );
  }
  const locked = await client.query(
    `SELECT 1 FROM physical_verification pv
     JOIN physical_verification_line pvl ON pvl.physical_verification_id = pv.physical_verification_id
     WHERE pvl.cycle_count_id = $1 AND pv.period_locked = true
     LIMIT 1`,
    [cycleCountId],
  );
  if (locked.rows.length > 0) {
    throw new AppError(
      409,
      CYCLE_COUNT_ERROR_CODES.PERIOD_LOCKED,
      'Cycle count is included in a signed-off physical verification',
      { cycle_count_id: cycleCountId },
    );
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `${sku}|${locationId}|${lotId ?? ''}|${stockClass}`,
  ]);

  // Code review 2026-09-02 round 2 (Story 8.8, FR-Q-12): a positive count adjustment is an
  // inflow, and this INSERT..ON CONFLICT was the one write path that bypassed the stock-class
  // laundering bar in stock-balance.ts. Mirror it here: an 'owned' inflow is refused when the lot
  // (or the lot-less grain) holds a non-saleable balance, and a non-saleable inflow is refused
  // when a saleable-class balance exists. Serialize on the SAME advisory-lock key the receipt
  // guard uses (seed 8808) so the two paths cannot race each other past the check.
  // Story 9.2 (FR-JW-04, AC6): the conflict set is SEGREGATED_STOCK_CLASSES, so an owned inflow
  // is refused when the lot holds prototype OR job_work material, and a segregated-class inflow
  // is refused when the lot holds a balance in ANY other class (job_work covered both directions).
  if (delta > 0 && (stockClass === 'owned' || SEGREGATED_STOCK_CLASSES.has(stockClass))) {
    const guardKey =
      lotId !== null
        ? `stock_class_guard:${sku}:lot:${lotId}`
        : `stock_class_guard:${sku}:loc:${locationId}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 8808))`, [guardKey]);
    const inflowIsOwned = stockClass === 'owned';
    const conflicting = await client.query(
      lotId !== null
        ? `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND lot_id = $2
              AND ${inflowIsOwned ? 'stock_class = ANY($3::text[])' : 'stock_class <> $3'}
            LIMIT 1`
        : `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND location_id = $2 AND lot_id IS NULL
              AND ${inflowIsOwned ? 'stock_class = ANY($3::text[])' : 'stock_class <> $3'}
            LIMIT 1`,
      lotId !== null
        ? [sku, lotId, inflowIsOwned ? [...SEGREGATED_STOCK_CLASSES] : stockClass]
        : [sku, locationId, inflowIsOwned ? [...SEGREGATED_STOCK_CLASSES] : stockClass],
    );
    if (conflicting.rows.length > 0) {
      const existingClass = (conflicting.rows[0] as { stock_class: string }).stock_class;
      const jobWorkConflict =
        stockClass === JOB_WORK_STOCK_CLASS || existingClass === JOB_WORK_STOCK_CLASS;
      throw new AppError(
        400,
        jobWorkConflict ? 'CROSS_ISSUE_BLOCKED' : 'PROTOTYPE_NOT_SALEABLE',
        jobWorkConflict
          ? `This lot already holds a ${existingClass} balance; a ${stockClass} count adjustment would cross customer-owned material with another class`
          : inflowIsOwned
            ? 'This lot already holds a non-saleable prototype balance; an owned count adjustment cannot create saleable stock for it'
            : 'This lot already holds a saleable-class balance and cannot gain prototype stock by count adjustment',
        {
          sku,
          stock_class: stockClass,
          lot_id: lotId,
          location_id: locationId,
          existing_stock_class: existingClass,
          ...(jobWorkConflict ? { demand_kind: 'count_adjustment' } : {}),
        },
      );
    }
  }

  // Lock the target balance grain and apply the signed delta.
  await client.query(
    `SELECT balance_id FROM stock_balance
     WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = $4
     FOR UPDATE`,
    [sku, locationId, lotId, stockClass],
  );

  if (delta > 0) {
    await client.query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sku, location_id, lot_id, stock_class)
       DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand, updated_at = now()`,
      [sku, locationId, lotId, stockClass, delta],
    );
  } else {
    const cur = await client.query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand, COALESCE(SUM(allocated), 0)::text AS allocated
       FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = $4`,
      [sku, locationId, lotId, stockClass],
    );
    const onHand = Number(cur.rows[0]!['on_hand']);
    const allocated = Number(cur.rows[0]!['allocated']);
    const newOnHand = onHand + delta; // delta is negative
    if (newOnHand < 0 || allocated > newOnHand) {
      throw new AppError(
        409,
        CYCLE_COUNT_ERROR_CODES.STOCK_ADJUSTMENT_NEGATIVE_BALANCE,
        'Negative adjustment would drive on_hand below zero or below allocated',
        {
          sku,
          location_id: locationId,
          ...(lotId !== null ? { lot_id: lotId } : {}),
          on_hand: onHand,
          allocated,
          delta_quantity: delta,
        },
      );
    }
    const upd = await client.query(
      `UPDATE stock_balance SET on_hand = on_hand + $5, updated_at = now()
       WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text AND stock_class = $4`,
      [sku, locationId, lotId, stockClass, delta],
    );
    if (upd.rowCount === 0) {
      throw new AppError(
        409,
        CYCLE_COUNT_ERROR_CODES.STOCK_ADJUSTMENT_NEGATIVE_BALANCE,
        'No stock_balance row to apply the negative adjustment against',
        {
          sku,
          location_id: locationId,
        },
      );
    }
  }

  // Traceability (Task 6): an adjustment against a known lot appends a recall-trace entry, so
  // adjustment events are not invisible to lot trace.
  if (lotId) {
    const lot = await getLotByNumberAndSku(lotId, sku, client);
    if (lot) {
      await appendTraceEntry(
        {
          lot_id: lot.lot_id,
          event_id: eventId,
          event_type: envelope.event_type,
          sku,
          location_id: locationId,
          location_code: null,
          quantity_change: String(delta),
          business_stream: envelope.payload['business_stream'] as string,
          timestamp: envelope.metadata.occurred_at,
        },
        client,
      );
    }
  }

  // Owned-stock valuation (Task 6): quantity and carrying value move consistently with on_hand.
  // Non-owned stock classes never change owned carrying value.
  if (stockClass === 'owned') {
    const val = await client.query(
      `UPDATE inventory_valuation
       SET quantity_on_hand = quantity_on_hand + $2::numeric,
           carrying_value = carrying_value + ($2::numeric * COALESCE(running_average_cost, 0)),
           updated_at = now()
       WHERE sku = $1
         AND quantity_on_hand + $2::numeric >= 0
         AND carrying_value + ($2::numeric * COALESCE(running_average_cost, 0)) >= 0`,
      [sku, delta],
    );
    if (val.rowCount === 0) {
      const current = await client.query(
        `SELECT quantity_on_hand::text AS quantity_on_hand, carrying_value::text AS carrying_value
         FROM inventory_valuation WHERE sku = $1`,
        [sku],
      );
      if (current.rows.length > 0) {
        throw new AppError(
          409,
          CYCLE_COUNT_ERROR_CODES.STOCK_ADJUSTMENT_NEGATIVE_BALANCE,
          'Adjustment would drive owned valuation below zero',
          {
            sku,
            quantity_on_hand: current.rows[0]!['quantity_on_hand'],
            carrying_value: current.rows[0]!['carrying_value'],
            delta_quantity: delta,
          },
        );
      }
    }
  }

  await markAdjustmentApplied(adjustmentId, eventId, client);
}

// --- physical_verification.completed ---------------------------------------

async function applyPhysicalVerificationCompleted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const pvId = p['physical_verification_id'] as string;

  const existing = await getPhysicalVerificationById(pvId, client, true);
  if (existing) {
    if (existing.period_locked) {
      throw new AppError(
        409,
        CYCLE_COUNT_ERROR_CODES.PERIOD_LOCKED,
        'Physical verification is signed off and locked',
        { physical_verification_id: pvId },
      );
    }
    throw new AppError(409, 'INVALID_STATE', `Physical verification "${pvId}" already exists`);
  }

  const countRefs = p['count_refs'] as string[];
  const businessDate = (p['business_date'] as string | undefined) ?? null;
  for (const countId of countRefs) {
    const header = await getCycleCountById(countId, client, true);
    if (!header) {
      throw new AppError(400, 'INVALID_PARAMS', `Cycle count "${countId}" does not exist`);
    }
    if (header.location_id !== p['location_id']) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `Cycle count "${countId}" belongs to a different location`,
      );
    }
    if (header.status !== 'submitted' && header.status !== 'completed') {
      throw new AppError(
        409,
        CYCLE_COUNT_ERROR_CODES.COUNT_TASK_LOCKED,
        `Cycle count "${countId}" is not submitted`,
      );
    }
    if (typeof p['period_start'] === 'string' && header.business_date < p['period_start']) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `Cycle count "${countId}" is before the physical-verification period`,
      );
    }
    if (typeof p['period_end'] === 'string' && header.business_date > p['period_end']) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `Cycle count "${countId}" is after the physical-verification period`,
      );
    }
    const lines = await getCycleCountLines(countId, client);
    if (lines.length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', `Cycle count "${countId}" has no evidence lines`);
    }
    const unresolved = lines.find(
      (line) =>
        line.adjustment_status === 'pending_approval' || line.adjustment_status === 'approved',
    );
    if (unresolved) {
      throw new AppError(
        409,
        CYCLE_COUNT_ERROR_CODES.COUNT_TASK_LOCKED,
        `Cycle count "${countId}" has unresolved adjustments`,
      );
    }
  }

  await insertPhysicalVerificationHeader(
    {
      physical_verification_id: pvId,
      location_id: p['location_id'] as string,
      coverage_percentage: (p['coverage_percentage'] as number | undefined) ?? 0,
      period_start: (p['period_start'] as string | undefined) ?? null,
      period_end: (p['period_end'] as string | undefined) ?? null,
      business_date: businessDate,
      count_refs: countRefs,
      completed_by_actor_id:
        (p['completed_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
      source_event_id: eventId,
    },
    client,
  );

  // Snapshot the count lines into append-only evidence rows (Task 2 / Task 8).
  for (const countId of countRefs) {
    const header = await getCycleCountById(countId, client);
    const lines = await getCycleCountLines(countId, client);
    for (const l of lines) {
      await insertPhysicalVerificationLine(
        {
          physical_verification_id: pvId,
          cycle_count_id: countId,
          count_date: header?.business_date ?? businessDate,
          sku: l.sku,
          lot_id: l.lot_id,
          stock_class: l.stock_class,
          book_quantity: l.book_quantity,
          counted_quantity: l.counted_quantity,
          variance_quantity: l.variance_quantity,
          variance_value: l.variance_value,
          adjustment_event_ref: l.applied_event_id,
          counter_actor_id: header?.submitted_by_actor_id ?? null,
          approver_actor_id: l.approver_actor_id,
        },
        client,
      );
    }
  }
}

// --- physical_verification.signed_off --------------------------------------

async function applyPhysicalVerificationSignedOff(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const pvId = p['physical_verification_id'] as string;
  const signoffActor = envelope.metadata.actor.user_id;
  const suppliedSignoffActor = p['management_signoff_actor_id'] as string;
  const signedOffAt = (p['signed_off_at'] as string | undefined) ?? envelope.metadata.occurred_at;
  if (suppliedSignoffActor !== signoffActor) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Physical-verification sign-off actor must match the authenticated actor',
      {
        supplied_signoff_actor_id: suppliedSignoffActor,
        actor_user_id: signoffActor,
      },
    );
  }
  if (!SIGNOFF_ROLES.has(envelope.metadata.actor.role)) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Physical-verification sign-off requires an authorized sign-off role',
      {
        role: envelope.metadata.actor.role,
      },
    );
  }

  const header = await getPhysicalVerificationById(pvId, client, true);
  if (!header) {
    throw new AppError(404, 'NOT_FOUND', `Physical verification "${pvId}" not found`);
  }
  if (header.period_locked || header.signed_off_at) {
    throw new AppError(
      409,
      CYCLE_COUNT_ERROR_CODES.PERIOD_LOCKED,
      'Physical verification is already signed off and locked',
      { physical_verification_id: pvId },
    );
  }

  await markPhysicalVerificationSignedOff(pvId, signoffActor, signedOffAt, client);

  // Story 9.5 (FR-JW-13, AC 7): customer-material variances reconciled onto the custody ledger in
  // the SAME transaction as the sign-off (AD-12), so the two commit or roll back together.
  await reconcileJobWorkVerificationVariances(
    pvId,
    header.location_id,
    signoffActor,
    signedOffAt,
    envelope,
    eventId,
    client,
  );
}

/**
 * Story 9.5 Task 5.2: for every signed-off verification line in the job_work class with a non-zero
 * variance, one `count_adjustment` custody-ledger row (the category Story 9.3 forward-declared and
 * no prior story produced), quantity_delta = variance (counted minus book, non-zero by the CHECK),
 * posted_by = the verifying user (the counter, falling back to the line approver, then the sign-off
 * actor), source_event_id = THIS sign-off event. Several lines share that event id - exactly why
 * Story 9.5 Task 0 widened uq_custody_ledger_source_event to (source_event_id, sku, lot_id).
 *
 * The owning order is resolved from the most recent customer-owned receipt row for (sku, lot):
 * job-work lots are order-scoped by construction (the 9.3 lot-under-order gate refuses a lot not
 * received under the order), so a single lookup is sound; a lot-less line has no custody grain to
 * resolve and is skipped with a log line (disclosed). A count_adjustment never reconciles a return
 * clock - a verification discrepancy is not a movement out of the job worker's premises.
 *
 * Lock order: the PV row is already locked by the caller; the order advisory lock is taken here
 * before the ledger insert (order appliers never touch PV rows, so no cycle), matching every other
 * custody write.
 */
async function reconcileJobWorkVerificationVariances(
  pvId: string,
  verificationLocationId: string,
  signoffActor: string,
  signedOffAt: string,
  envelope: EventEnvelope,
  eventId: string,
  client: PoolClient,
): Promise<void> {
  // Story 9.5 code review (chunk 2), P1: SUM per (sku, lot). physical_verification_line has no
  // uniqueness constraint and its grain includes cycle_count_id (physical_verification.sql:35-51),
  // so a verification rolling up two cycle counts that both counted the same sku and lot produces
  // two rows. One ledger row per line then collided on the Task 0 widened key
  // (source_event_id, sku, lot_id) and turned a legitimate sign-off into a permanent 409 that no
  // retry could clear. Aggregating first is also the honest custody answer: the customer's position
  // in one lot moved by the NET of what every count found, not by two competing deltas.
  const lines = await client.query(
    `SELECT sku, lot_id,
            SUM(variance_quantity)::text AS variance_quantity,
            MIN(counter_actor_id::text) AS counter_actor_id,
            MIN(approver_actor_id::text) AS approver_actor_id
       FROM physical_verification_line
      WHERE physical_verification_id = $1 AND stock_class = $2 AND variance_quantity <> 0
      GROUP BY sku, lot_id
      ORDER BY sku ASC, lot_id ASC NULLS FIRST`,
    [pvId, JOB_WORK_STOCK_CLASS],
  );

  // P3/P4: resolve every owning order BEFORE taking any lock, then take the advisory locks in
  // service_order_id order. Locking inside the loop in sku order let two concurrent sign-offs that
  // touch the same pair of orders acquire them in opposite sequence and deadlock.
  interface PendingAdjustment {
    sku: string;
    lot_id: string;
    variance: string;
    posted_by: string;
    owner: {
      service_order_id: string;
      customer_party_code: string;
      uom: string;
      site_id: string;
    };
  }
  const pending: PendingAdjustment[] = [];

  for (const line of lines.rows as {
    sku: string;
    lot_id: string | null;
    variance_quantity: string;
    counter_actor_id: string | null;
    approver_actor_id: string | null;
  }[]) {
    if (line.lot_id === null) {
      console.warn(
        `physical verification ${pvId}: job_work line for ${line.sku} has no lot; custody reconciliation skipped (no custody grain)`,
      );
      continue;
    }
    // P2: variance_quantity is NUMERIC(18,6) and quantity_delta is NUMERIC(18,3). A variance of
    // 0.0004 passes the `<> 0` row filter, rounds to 0.000 on insert and violates
    // chk_custody_ledger_sign with a 23514 the catch below does not classify - an unclassified 500
    // that made the whole sign-off unapplicable. Round to the ledger's own scale here and skip a
    // line that is zero at that scale: a sub-milligram discrepancy is not a custody movement.
    const variance = qtyFromScaled(qtyToScaled(line.variance_quantity));
    if (qtyToScaled(variance) === 0n) {
      console.warn(
        `physical verification ${pvId}: job_work line ${line.sku} / ${line.lot_id} has a variance of ${line.variance_quantity}, which is zero at the custody ledger's three-decimal scale; reconciliation skipped`,
      );
      continue;
    }
    const receipt = await client.query(
      `SELECT service_order_id, customer_party_code, uom, site_id
         FROM custody_ledger_entry
        WHERE sku = $1 AND lot_id = $2 AND movement_category = 'receipt'
        ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
      [line.sku, line.lot_id],
    );
    const owner = receipt.rows[0] as
      | { service_order_id: string; customer_party_code: string; uom: string; site_id: string }
      | undefined;
    if (!owner) {
      console.warn(
        `physical verification ${pvId}: job_work lot ${line.lot_id} (${line.sku}) has no custody receipt; reconciliation skipped`,
      );
      continue;
    }
    pending.push({
      sku: line.sku,
      lot_id: line.lot_id,
      variance,
      posted_by: line.counter_actor_id ?? line.approver_actor_id ?? signoffActor,
      owner,
    });
  }

  pending.sort(
    (a, b) =>
      a.owner.service_order_id.localeCompare(b.owner.service_order_id) ||
      a.sku.localeCompare(b.sku) ||
      a.lot_id.localeCompare(b.lot_id),
  );

  const lockedOrders = new Set<string>();
  for (const line of pending) {
    const owner = line.owner;
    const variance = line.variance;
    if (!lockedOrders.has(owner.service_order_id)) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        owner.service_order_id,
      ]);
      lockedOrders.add(owner.service_order_id);
      // P3: re-derive the order under the lock, exactly as every other custody write does through
      // requireInProcessOrder. Without it a sign-off could move the custody balance of an order
      // that had already passed the AC8 zero-balance gate and closed, leaving it non-zero with no
      // route to re-close; and an owner resolved by (sku, lot) alone could belong to another site.
      const order = await getServiceOrderById(owner.service_order_id, client, true);
      // The same predicate custody-ledger's orderAcceptsCustodyPosting applies, inlined to keep
      // this file's imports one-directional (projections only, never another compliance module).
      if (!order || order.status !== 'in_process') {
        throw new AppError(
          409,
          'SOURCE_DOCUMENT_REQUIRED',
          `A custody count adjustment requires an in_process service order; this order is ${order?.status ?? 'missing'}`,
          {
            physical_verification_id: pvId,
            service_order_id: owner.service_order_id,
            status: order?.status ?? null,
            sku: line.sku,
            lot_id: line.lot_id,
          },
        );
      }
      if (order.site_id !== owner.site_id) {
        throw new AppError(
          409,
          'SOURCE_DOCUMENT_REQUIRED',
          'The resolved custody owner belongs to a different site than its service order',
          {
            physical_verification_id: pvId,
            service_order_id: owner.service_order_id,
            order_site_id: order.site_id,
            receipt_site_id: owner.site_id,
          },
        );
      }
    }
    try {
      await insertCustodyLedgerEntry(
        {
          entry_id: randomUUID(),
          service_order_id: owner.service_order_id,
          customer_party_code: owner.customer_party_code,
          movement_category: 'count_adjustment',
          ownership: 'customer',
          sku: line.sku,
          lot_id: line.lot_id,
          location_id: verificationLocationId,
          quantity_delta: variance,
          uom: owner.uom,
          billable: false,
          bom_line_id: null,
          kit_bom_revision_id: null,
          receipt_id: null,
          variance_qty: variance,
          variance_flagged: true,
          site_id: owner.site_id,
          posted_by: line.posted_by,
          occurred_at: signedOffAt,
          business_date: toIstCalendarDate(new Date(signedOffAt)),
          source_event_id: eventId,
          source_event_type: 'physical_verification.signed_off',
          correlation_id: envelope.metadata.correlation_id ?? null,
        },
        client,
      );
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        throw new AppError(
          409,
          'DUPLICATE_EVENT',
          'A custody ledger count_adjustment already exists for this verification line',
          {
            physical_verification_id: pvId,
            sku: line.sku,
            lot_id: line.lot_id,
            constraint: (err as { constraint?: string }).constraint,
          },
        );
      }
      throw err;
    }
  }
}
