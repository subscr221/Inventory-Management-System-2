import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  getPlanningParams,
  upsertPlanningParams,
  applySafetyStockComputation,
} from '../read/projections/inventory_planning.js';
import { insertRecommendation } from '../read/projections/replenishment_recommendation.js';
import { flagObsolescence, clearObsolescence } from '../read/projections/obsolescence_flag.js';

/**
 * Central inventory-planning compliance seam (Story 2.7). Split like every other seam:
 *
 * - assertInventoryPlanningShape runs BEFORE any DB work, next to the other pre-transaction asserts,
 *   so a malformed planning event is rejected without consuming an idempotency key.
 * - applyInventoryPlanningProjection runs INSIDE the event transaction, BEFORE the domain_events
 *   insert. It applies the planning params config, the computed safety-stock/reorder-point outputs,
 *   the replenishment recommendation, and the obsolescence flag/clear - so a direct
 *   POST /api/v1/events or edge upload cannot bypass shape validation or projection application.
 *
 * Gating is deliberately narrow (mirroring inventory-master.ts / stock-balance.ts): only `inventory`
 * stream events of the new planning event types. Every older stock, lot, valuation, transfer, and
 * cycle-count event passes through byte-for-byte unaffected, so the Story 1.9 spine gate stays green.
 *
 * The reorder crossing decision, the obsolescence transition decision, and the transactional planner
 * alert live in the batch jobs (src/compliance/planning-jobs.ts), which hold the row lock across
 * read -> decide -> persist. This seam only applies the mechanical projection mutation for an event
 * the job (or a direct caller) has already decided to write.
 */

const PLANNING_STREAM_TYPES = new Set(['inventory']);
const PLANNING_EVENT_TYPES = new Set([
  'inventory_planning.params_set',
  'inventory_planning.safety_stock_computed',
  'replenishment.recommended',
  'obsolescence.flagged',
  'obsolescence.cleared',
]);

const MAX_QUANTITY = 1e12;
const MAX_LEAD_TIME_DAYS = 999999.999;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PLANNING_ERROR_CODES = {
  LEAD_TIME_NOT_CONFIGURED: 'LEAD_TIME_NOT_CONFIGURED',
  INSUFFICIENT_DEMAND_HISTORY: 'INSUFFICIENT_DEMAND_HISTORY',
  INVALID_SERVICE_LEVEL: 'INVALID_SERVICE_LEVEL',
  PLANNING_PARAMS_NOT_FOUND: 'PLANNING_PARAMS_NOT_FOUND',
  OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED: 'OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED',
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_QUANTITY;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
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
  return typeof value === 'string' && ISO8601_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

export function planningEventType(envelope: EventEnvelope): string | null {
  if (!PLANNING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!PLANNING_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation
// ---------------------------------------------------------------------------

export function assertInventoryPlanningShape(envelope: EventEnvelope): void {
  const type = planningEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (type === 'inventory_planning.params_set') {
    if (!isUuid(p['planning_params_id'])) throw new AppError(400, 'INVALID_PARAMS', 'planning_params_id is required and must be a UUID');
    if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    // lead_time_days is OPTIONAL at config time: until Epic 4 delivers measured PO-to-receipt lead
    // times it may be seeded later or derived from open-PO projections (Story 2.9). When absent the
    // safety-stock computation fails closed with LEAD_TIME_NOT_CONFIGURED. When present it must be
    // positive and carry a lead_time_source.
    if (p['lead_time_days'] !== undefined) {
      if (!isFiniteNumber(p['lead_time_days']) || (p['lead_time_days'] as number) <= 0 || (p['lead_time_days'] as number) > MAX_LEAD_TIME_DAYS) {
        throw new AppError(400, 'INVALID_PARAMS', `lead_time_days must be a positive number no greater than ${MAX_LEAD_TIME_DAYS}`);
      }
      if (!isNonEmptyString(p['lead_time_source'])) throw new AppError(400, 'INVALID_PARAMS', 'lead_time_source is required when lead_time_days is supplied');
    }
    if (!isFiniteNumber(p['service_level']) || (p['service_level'] as number) <= 0 || (p['service_level'] as number) >= 1) {
      throw new AppError(400, PLANNING_ERROR_CODES.INVALID_SERVICE_LEVEL, 'service_level is required and must be a number between 0 and 1');
    }
    if (p['obsolescence_threshold_days'] !== undefined && !isPositiveInt(p['obsolescence_threshold_days'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'obsolescence_threshold_days must be a positive integer when supplied');
    }
    if (p['standard_order_qty'] !== undefined && !isNonNegativeFinite(p['standard_order_qty'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'standard_order_qty must be a non-negative finite number when supplied');
    }
    if (p['demand_window_days'] !== undefined && !isPositiveInt(p['demand_window_days'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'demand_window_days must be a positive integer when supplied');
    }
    if (!isUuid(p['set_by_actor_id'])) throw new AppError(400, 'INVALID_PARAMS', 'set_by_actor_id is required and must be a UUID');
    return;
  }

  if (type === 'inventory_planning.safety_stock_computed') {
    if (!isUuid(p['computation_id'])) throw new AppError(400, 'INVALID_PARAMS', 'computation_id is required and must be a UUID');
    if (!isUuid(p['planning_params_id'])) throw new AppError(400, 'INVALID_PARAMS', 'planning_params_id is required and must be a UUID');
    if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    if (!isNonNegativeFinite(p['safety_stock'])) throw new AppError(400, 'INVALID_PARAMS', 'safety_stock must be a non-negative finite number');
    if (!isNonNegativeFinite(p['reorder_point'])) throw new AppError(400, 'INVALID_PARAMS', 'reorder_point must be a non-negative finite number');
    if (!isNonNegativeFinite(p['avg_daily_demand'])) throw new AppError(400, 'INVALID_PARAMS', 'avg_daily_demand must be a non-negative finite number');
    if (!isNonNegativeFinite(p['demand_std_dev'])) throw new AppError(400, 'INVALID_PARAMS', 'demand_std_dev must be a non-negative finite number');
    if (typeof p['computation_inputs'] !== 'object' || p['computation_inputs'] === null || Array.isArray(p['computation_inputs'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'computation_inputs is required and must be an object');
    }
    if (!isIsoTimestamp(p['computed_at'])) throw new AppError(400, 'INVALID_PARAMS', 'computed_at is required and must be an ISO-8601 timestamp');
    if (!isLocalDate(p['business_date'])) throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be a real YYYY-MM-DD date');
    return;
  }

  if (type === 'replenishment.recommended') {
    if (!isUuid(p['recommendation_id'])) throw new AppError(400, 'INVALID_PARAMS', 'recommendation_id is required and must be a UUID');
    if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    if (!isNonNegativeFinite(p['on_hand_at_check'])) throw new AppError(400, 'INVALID_PARAMS', 'on_hand_at_check must be a non-negative finite number');
    if (!isNonNegativeFinite(p['reorder_point'])) throw new AppError(400, 'INVALID_PARAMS', 'reorder_point must be a non-negative finite number');
    if (!isFiniteNumber(p['recommended_order_qty']) || (p['recommended_order_qty'] as number) <= 0 || (p['recommended_order_qty'] as number) > MAX_QUANTITY) throw new AppError(400, 'INVALID_PARAMS', 'recommended_order_qty must be a positive finite number');
    if (!isIsoTimestamp(p['triggered_at'])) throw new AppError(400, 'INVALID_PARAMS', 'triggered_at is required and must be an ISO-8601 timestamp');
    if (!isLocalDate(p['business_date'])) throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be a real YYYY-MM-DD date');
    return;
  }

  if (type === 'obsolescence.flagged') {
    if (!isUuid(p['obsolescence_flag_id'])) throw new AppError(400, 'INVALID_PARAMS', 'obsolescence_flag_id is required and must be a UUID');
    if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    if (p['last_issue_at'] !== null && !isIsoTimestamp(p['last_issue_at'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'last_issue_at must be an ISO-8601 timestamp or null');
    }
    if (!isNonNegativeInt(p['days_since_issue'])) throw new AppError(400, 'INVALID_PARAMS', 'days_since_issue must be a non-negative integer');
    if (!isPositiveInt(p['threshold_days'])) throw new AppError(400, 'INVALID_PARAMS', 'threshold_days must be a positive integer');
    if (!isNonEmptyString(p['disposition_status'])) throw new AppError(400, 'INVALID_PARAMS', 'disposition_status is required');
    if (p['nrv_testing_triggered'] !== true) throw new AppError(400, 'INVALID_PARAMS', 'nrv_testing_triggered must be true for an obsolescence flag');
    if (!isIsoTimestamp(p['flagged_at'])) throw new AppError(400, 'INVALID_PARAMS', 'flagged_at is required and must be an ISO-8601 timestamp');
    if (!isLocalDate(p['business_date'])) throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be a real YYYY-MM-DD date');
    return;
  }

  if (type === 'obsolescence.cleared') {
    if (!isUuid(p['obsolescence_flag_id'])) throw new AppError(400, 'INVALID_PARAMS', 'obsolescence_flag_id is required and must be a UUID');
    if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
    if (!isIsoTimestamp(p['cleared_at'])) throw new AppError(400, 'INVALID_PARAMS', 'cleared_at is required and must be an ISO-8601 timestamp');
    if (!isNonEmptyString(p['reason'])) throw new AppError(400, 'INVALID_PARAMS', 'reason is required');
    if (!isLocalDate(p['business_date'])) throw new AppError(400, 'INVALID_PARAMS', 'business_date is required and must be a real YYYY-MM-DD date');
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

export async function applyInventoryPlanningProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = planningEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;

  if (type === 'inventory_planning.params_set') {
    await upsertPlanningParams(
      {
        planning_params_id: p['planning_params_id'] as string,
        sku: p['sku'] as string,
        location_id: p['location_id'] as string,
        ...(p['lead_time_days'] !== undefined ? { lead_time_days: p['lead_time_days'] as number } : {}),
        ...(p['lead_time_source'] !== undefined ? { lead_time_source: p['lead_time_source'] as string } : {}),
        service_level: p['service_level'] as number,
        ...(p['obsolescence_threshold_days'] !== undefined ? { obsolescence_threshold_days: p['obsolescence_threshold_days'] as number } : {}),
        ...(p['standard_order_qty'] !== undefined ? { standard_order_qty: p['standard_order_qty'] as number } : {}),
        ...(p['demand_window_days'] !== undefined ? { demand_window_days: p['demand_window_days'] as number } : {}),
        business_stream: p['business_stream'] as string,
        set_by_actor_id: (p['set_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
      },
      client,
    );
    return;
  }

  if (type === 'inventory_planning.safety_stock_computed') {
    const sku = p['sku'] as string;
    const locationId = p['location_id'] as string;
    const existing = await getPlanningParams(sku, locationId, client, true);
    if (!existing) {
      throw new AppError(404, PLANNING_ERROR_CODES.PLANNING_PARAMS_NOT_FOUND, `No planning params configured for sku "${sku}" at this location`, {
        sku,
        location_id: locationId,
      });
    }
    await applySafetyStockComputation(
      {
        sku,
        location_id: locationId,
        safety_stock: p['safety_stock'] as number,
        reorder_point: p['reorder_point'] as number,
        avg_daily_demand: p['avg_daily_demand'] as number,
        demand_std_dev: p['demand_std_dev'] as number,
        computation_inputs: p['computation_inputs'] as Record<string, unknown>,
        computed_at: p['computed_at'] as string,
      },
      client,
    );
    return;
  }

  if (type === 'replenishment.recommended') {
    await insertRecommendation(
      {
        recommendation_id: p['recommendation_id'] as string,
        sku: p['sku'] as string,
        location_id: p['location_id'] as string,
        on_hand_at_check: p['on_hand_at_check'] as number,
        reorder_point: p['reorder_point'] as number,
        recommended_order_qty: p['recommended_order_qty'] as number,
        triggered_at: p['triggered_at'] as string,
        source_event_id: eventId,
      },
      client,
    );
    return;
  }

  if (type === 'obsolescence.flagged') {
    await flagObsolescence(
      {
        obsolescence_flag_id: p['obsolescence_flag_id'] as string,
        sku: p['sku'] as string,
        location_id: p['location_id'] as string,
        last_issue_at: (p['last_issue_at'] as string | null) ?? null,
        days_since_issue: p['days_since_issue'] as number,
        threshold_days: p['threshold_days'] as number,
        disposition_status: p['disposition_status'] as string,
        flagged_at: p['flagged_at'] as string,
        source_event_id: eventId,
      },
      client,
    );
    return;
  }

  if (type === 'obsolescence.cleared') {
    await clearObsolescence(
      {
        sku: p['sku'] as string,
        location_id: p['location_id'] as string,
        cleared_at: p['cleared_at'] as string,
        source_event_id: eventId,
      },
      client,
    );
    return;
  }
}
