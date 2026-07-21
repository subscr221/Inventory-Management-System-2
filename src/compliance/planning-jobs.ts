import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import type { EventEnvelope } from '../events/store.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { AppError } from '../middleware/error.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { listPlanningParams, getPlanningParams } from '../read/projections/inventory_planning.js';
import type { PlanningParamsRow } from '../read/projections/inventory_planning.js';
import { getOpenRecommendation } from '../read/projections/replenishment_recommendation.js';
import { getObsolescenceFlag } from '../read/projections/obsolescence_flag.js';
import { PLANNING_ERROR_CODES } from './inventory-planning.js';

/**
 * Phase-1 planning job cycles (Story 2.7). These are pure functions callable from the synthetic HTTP
 * job triggers now and a scheduler later, mirroring the src/notify cycle pattern
 * (runDispatchCycle/runEscalationCycle/runExpiryCycle). They read committed read models, decide, and
 * write through the central persistEvent path so the projection and the domain_events insert commit
 * together. The reorder-crossing and obsolescence-transition decisions run under a FOR UPDATE lock on
 * the params row, so a concurrent run for the same grain cannot create duplicate open recommendations
 * or double flags, and re-running over unchanged state produces no duplicate events or alerts.
 *
 * NOT in scope: no scheduler, no purchase requisition / PO (Epic 4), no NRV write-down (that stays
 * DOA-gated in inventory-valuation.ts - obsolescence only flags and alerts), no disposition (Epic 16).
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface PlanningActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface PlanningJobScope {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
  business_date: string;
  actor: PlanningActor;
  auditCtx?: AuditCtx;
}

const PLANNER_ROLE = 'inventory_planner';
const DEFAULT_MIN_SAMPLE_DAYS = 2;

// Static service-level -> z lookup (Story 2.7 Task 5). Deliberately NOT a normal-inverse
// implementation: only these four service levels are supported; anything else is INVALID_SERVICE_LEVEL.
const Z_TABLE: Array<{ level: number; z: number }> = [
  { level: 0.9, z: 1.2816 },
  { level: 0.95, z: 1.645 },
  { level: 0.975, z: 1.96 },
  { level: 0.99, z: 2.326 },
];

function lookupZ(serviceLevel: number): number | null {
  const match = Z_TABLE.find((e) => Math.abs(e.level - serviceLevel) < 1e-6);
  return match ? match.z : null;
}

const COMPUTE_BUSINESS_CODES = new Set<string>([
  PLANNING_ERROR_CODES.LEAD_TIME_NOT_CONFIGURED,
  PLANNING_ERROR_CODES.INSUFFICIENT_DEMAND_HISTORY,
  PLANNING_ERROR_CODES.INVALID_SERVICE_LEVEL,
]);

function planningEventMetadata(scope: PlanningJobScope, correlationId = randomUUID()): EventEnvelope['metadata'] {
  return {
    correlation_id: correlationId,
    actor: { user_id: scope.actor.user_id, role: scope.actor.role, location_id: scope.actor.location_id },
    occurred_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Task 5: safety-stock and reorder-point computation
// ---------------------------------------------------------------------------

export interface SafetyStockComputationResult {
  computed: Array<{ sku: string; location_id: string; safety_stock: number; reorder_point: number }>;
  skipped: Array<{ sku: string; location_id: string; reason: string }>;
}

export async function runSafetyStockComputation(scope: PlanningJobScope): Promise<SafetyStockComputationResult> {
  const rows = await listPlanningParams({ location_id: scope.location_id ?? null, location_any: scope.location_any ?? null, sku: scope.sku ?? null });
  // A single-SKU targeted compute surfaces the business rejection to the caller; a broad scope
  // records it per grain and continues so one unconfigured SKU never aborts the batch.
  const targeted = Boolean(scope.sku);
  const computed: SafetyStockComputationResult['computed'] = [];
  const skipped: SafetyStockComputationResult['skipped'] = [];

  for (const row of rows) {
    try {
      const result = await computeOneGrain(row, scope);
      computed.push(result);
    } catch (err) {
      if (err instanceof AppError && COMPUTE_BUSINESS_CODES.has(err.errorCode)) {
        if (targeted) throw err;
        skipped.push({ sku: row.sku, location_id: row.location_id, reason: err.errorCode });
        continue;
      }
      throw err;
    }
  }
  return { computed, skipped };
}

async function computeOneGrain(
  row: PlanningParamsRow,
  scope: PlanningJobScope,
): Promise<{ sku: string; location_id: string; safety_stock: number; reorder_point: number }> {
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const locked = await getPlanningParams(row.sku, row.location_id, client, true);
    if (!locked) {
      throw new AppError(404, PLANNING_ERROR_CODES.PLANNING_PARAMS_NOT_FOUND, `No planning params configured for sku "${row.sku}" at this location`, {
        sku: row.sku,
        location_id: row.location_id,
      });
    }
    row = locked;
    if (row.lead_time_days === null || row.lead_time_days <= 0) {
      throw new AppError(400, PLANNING_ERROR_CODES.LEAD_TIME_NOT_CONFIGURED, `lead_time_days is not configured for sku "${row.sku}" at this location`, {
        sku: row.sku,
        location_id: row.location_id,
      });
    }
    if (row.service_level === null) {
      throw new AppError(400, PLANNING_ERROR_CODES.INVALID_SERVICE_LEVEL, `service_level is not configured for sku "${row.sku}"`, { sku: row.sku });
    }
    const z = lookupZ(row.service_level);
    if (z === null) {
      throw new AppError(400, PLANNING_ERROR_CODES.INVALID_SERVICE_LEVEL, `service_level ${row.service_level} is not one of the supported values (0.90, 0.95, 0.975, 0.99)`, {
        sku: row.sku,
        service_level: row.service_level,
      });
    }

    const windowDays = row.demand_window_days ?? 90;
    const statsRes = await client.query(
      `WITH target_location AS (
         SELECT location_code FROM location_register WHERE location_id = $2
       )
       SELECT COUNT(*)::int AS sample_day_count,
              COALESCE(AVG(daily_total), 0)::text AS avg_daily_demand,
              COALESCE(STDDEV_POP(daily_total), 0)::text AS sigma_daily
       FROM (
         SELECT (metadata->>'occurred_at')::timestamptz::date AS d,
                SUM((payload->>'quantity')::numeric) AS daily_total
         FROM domain_events, target_location
         WHERE event_type = 'stock.issued'
           AND payload->>'sku' = $1
           AND (
             payload->>'target_location_id' = $2::text
             OR (payload->>'target_location_id' IS NULL AND payload->>'target_location_code' = target_location.location_code)
           )
           AND COALESCE(payload->>'stock_class', 'owned') = 'owned'
           AND (metadata->>'occurred_at')::timestamptz >= now() - make_interval(days => $3::int)
         GROUP BY d
       ) buckets`,
      [row.sku, row.location_id, windowDays],
    );
    const sampleDayCount = Number(statsRes.rows[0]!['sample_day_count']);
    const avgDailyDemand = statsRes.rows[0]!['avg_daily_demand'] as string;
    const sigmaDaily = statsRes.rows[0]!['sigma_daily'] as string;

    if (sampleDayCount < DEFAULT_MIN_SAMPLE_DAYS) {
      throw new AppError(400, PLANNING_ERROR_CODES.INSUFFICIENT_DEMAND_HISTORY, `Demand history for sku "${row.sku}" covers ${sampleDayCount} day(s); at least ${DEFAULT_MIN_SAMPLE_DAYS} are required`, {
        sku: row.sku,
        location_id: row.location_id,
        sample_day_count: sampleDayCount,
        minimum_required: DEFAULT_MIN_SAMPLE_DAYS,
      });
    }

    const calcRes = await client.query(
      `WITH ss AS (
         SELECT ceil($1::numeric * $2::numeric * sqrt($3::numeric))::numeric AS safety_stock
       )
       SELECT ss.safety_stock::text AS safety_stock,
              ceil($4::numeric * $3::numeric + ss.safety_stock)::numeric::text AS reorder_point
       FROM ss`,
      [z, sigmaDaily, row.lead_time_days, avgDailyDemand],
    );
    const safetyStock = calcRes.rows[0]!['safety_stock'] as string;
    const reorderPoint = calcRes.rows[0]!['reorder_point'] as string;
    const computationInputs = {
      sigma_daily: Number(sigmaDaily),
      avg_daily_demand: Number(avgDailyDemand),
      z,
      service_level: row.service_level,
      lead_time_days: row.lead_time_days,
      lead_time_source: row.lead_time_source,
      demand_window_days: windowDays,
      sample_day_count: sampleDayCount,
    };
    const unchanged =
      row.last_computed_at !== null &&
      row.safety_stock !== null && Math.abs(row.safety_stock - Number(safetyStock)) < 1e-9 &&
      row.reorder_point !== null && Math.abs(row.reorder_point - Number(reorderPoint)) < 1e-9 &&
      row.avg_daily_demand !== null && Math.abs(row.avg_daily_demand - Number(avgDailyDemand)) < 1e-9 &&
      row.demand_std_dev !== null && Math.abs(row.demand_std_dev - Number(sigmaDaily)) < 1e-9 &&
      Number((row.computation_inputs?.['sample_day_count'] as number | undefined) ?? -1) === sampleDayCount;
    if (!unchanged) {
      await persistEvent(
        {
          stream_type: 'inventory',
          stream_id: row.planning_params_id,
          event_type: 'inventory_planning.safety_stock_computed',
          payload: {
            computation_id: randomUUID(),
            planning_params_id: row.planning_params_id,
            sku: row.sku,
            location_id: row.location_id,
            safety_stock: Number(safetyStock),
            reorder_point: Number(reorderPoint),
            avg_daily_demand: Number(avgDailyDemand),
            demand_std_dev: Number(sigmaDaily),
            computation_inputs: computationInputs,
            computed_at: new Date().toISOString(),
            business_date: scope.business_date,
            business_stream: row.business_stream,
          },
          metadata: planningEventMetadata(scope),
        },
        scope.auditCtx,
        client,
      );
    }
    await client.query('COMMIT');
    committed = true;
    return { sku: row.sku, location_id: row.location_id, safety_stock: Number(safetyStock), reorder_point: Number(reorderPoint) };
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Task 6: replenishment check and recommendation
// ---------------------------------------------------------------------------

export interface ReplenishmentCheckResult {
  recommended: Array<{ sku: string; location_id: string; recommendation_id: string; recommended_order_qty: number }>;
  skipped: Array<{ sku: string; location_id: string; reason: string }>;
}

export async function runReplenishmentCheck(scope: PlanningJobScope): Promise<ReplenishmentCheckResult> {
  const rows = await listPlanningParams({ location_id: scope.location_id ?? null, location_any: scope.location_any ?? null, sku: scope.sku ?? null });
  const recommended: ReplenishmentCheckResult['recommended'] = [];
  const skipped: ReplenishmentCheckResult['skipped'] = [];

  for (const row of rows) {
    const outcome = await checkOneGrain(row, scope);
    if (outcome) {
      if ('recommendation_id' in outcome) recommended.push(outcome);
      else skipped.push(outcome);
    }
  }
  return { recommended, skipped };
}

type ReplenishmentGrainOutcome =
  | { sku: string; location_id: string; recommendation_id: string; recommended_order_qty: number }
  | { sku: string; location_id: string; reason: string }
  | null;

async function checkOneGrain(row: PlanningParamsRow, scope: PlanningJobScope): Promise<ReplenishmentGrainOutcome> {
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Lock the params row so a concurrent check for this grain serializes: the loser waits, then sees
    // the open recommendation the winner committed and skips it - no duplicate open recommendation.
    const locked = await getPlanningParams(row.sku, row.location_id, client, true);
    if (!locked || locked.reorder_point === null) {
      await client.query('COMMIT');
      committed = true;
      return { sku: row.sku, location_id: row.location_id, reason: PLANNING_ERROR_CODES.PLANNING_PARAMS_NOT_FOUND };
    }
    if (locked.standard_order_qty === null || locked.standard_order_qty <= 0) {
      await client.query('COMMIT');
      committed = true;
      return { sku: row.sku, location_id: row.location_id, reason: 'STANDARD_ORDER_QTY_NOT_CONFIGURED' };
    }

    // Compare on_hand against reorder_point in SQL NUMERIC (not JS float).
    const balRes = await client.query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
              (COALESCE(SUM(on_hand), 0) <= $3::numeric) AS below
       FROM stock_balance WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [row.sku, row.location_id, String(locked.reorder_point)],
    );
    const onHand = balRes.rows[0]!['on_hand'] as string;
    const below = balRes.rows[0]!['below'] === true;
    if (!below) {
      await client.query('COMMIT');
      committed = true;
      return null;
    }

    const openRec = await getOpenRecommendation(row.sku, row.location_id, client, true);
    if (openRec) {
      // Idempotent per crossing: only refresh when the reorder point or standard order qty changed.
      const unchanged =
        Math.abs(openRec.reorder_point - locked.reorder_point) < 1e-9 &&
        Math.abs(openRec.recommended_order_qty - locked.standard_order_qty) < 1e-9;
      if (unchanged) {
        await client.query('COMMIT');
        committed = true;
        return null;
      }
      // Supersede the stale open recommendation before inserting the refreshed one (the partial
      // unique index permits only one open recommendation per grain).
      await client.query(
        `UPDATE replenishment_recommendation SET status = 'superseded', updated_at = now()
         WHERE recommendation_id = $1`,
        [openRec.recommendation_id],
      );
    }

    const recommendationId = randomUUID();
    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: recommendationId,
        event_type: 'replenishment.recommended',
        payload: {
          recommendation_id: recommendationId,
          sku: row.sku,
          location_id: row.location_id,
          on_hand_at_check: Number(onHand),
          reorder_point: locked.reorder_point,
          recommended_order_qty: locked.standard_order_qty,
          triggered_at: new Date().toISOString(),
          business_date: scope.business_date,
          business_stream: row.business_stream,
        },
        metadata: planningEventMetadata(scope),
      },
      scope.auditCtx,
      client,
    );

    // Planner exception alert, transactional so it commits with the recommendation (Story 2.6
    // approval-task pattern). Scoped to the SKU's location and the planner role.
    await emitNotificationInTransaction(
      {
        target: { role: PLANNER_ROLE, location_id: row.location_id },
        event_type: 'replenishment_recommended',
        status_verb: 'Below reorder point',
        object_type: 'sku',
        object_id: row.sku,
        actor_label: 'Inventory Planning',
        next_step: 'Review the replenishment recommendation and raise a purchase requisition',
        actor: scope.actor,
      },
      client,
    );

    await client.query('COMMIT');
    committed = true;
    return { sku: row.sku, location_id: row.location_id, recommendation_id: recommendationId, recommended_order_qty: locked.standard_order_qty };
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Task 7: obsolescence flag scan and NRV trigger
// ---------------------------------------------------------------------------

export interface ObsolescenceScanResult {
  flagged: Array<{ sku: string; location_id: string; days_since_issue: number }>;
  cleared: Array<{ sku: string; location_id: string }>;
  skipped: Array<{ sku: string; location_id: string; reason: string }>;
}

type ObsolescenceGrainOutcome = { status: 'flagged'; days_since_issue: number } | 'cleared' | string | null;

export async function runObsolescenceScan(scope: PlanningJobScope): Promise<ObsolescenceScanResult> {
  const rows = await listPlanningParams({ location_id: scope.location_id ?? null, location_any: scope.location_any ?? null, sku: scope.sku ?? null });
  const flagged: ObsolescenceScanResult['flagged'] = [];
  const cleared: ObsolescenceScanResult['cleared'] = [];
  const skipped: ObsolescenceScanResult['skipped'] = [];

  for (const row of rows) {
    const outcome = await scanOneGrain(row, scope);
    if (outcome && typeof outcome === 'object' && outcome.status === 'flagged') flagged.push({ sku: row.sku, location_id: row.location_id, days_since_issue: outcome.days_since_issue });
    else if (outcome === 'cleared') cleared.push({ sku: row.sku, location_id: row.location_id });
    else if (typeof outcome === 'string') skipped.push({ sku: row.sku, location_id: row.location_id, reason: outcome });
  }
  return { flagged, cleared, skipped };
}

async function scanOneGrain(row: PlanningParamsRow, scope: PlanningJobScope): Promise<ObsolescenceGrainOutcome> {
  if (row.obsolescence_threshold_days === null || row.obsolescence_threshold_days <= 0) {
    return PLANNING_ERROR_CODES.OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED;
  }
  const threshold = row.obsolescence_threshold_days;
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Lock the params row so a concurrent scan for this grain serializes (no double flag / double clear).
    await getPlanningParams(row.sku, row.location_id, client, true);

    const activityRes = await client.query(
      `WITH target_location AS (
         SELECT location_code FROM location_register WHERE location_id = $2
       ), owned_balance AS (
         SELECT MIN(updated_at) AS first_balance_at,
                SUM(on_hand) AS owned_on_hand,
                MAX(last_issue_at) AS last_issue_at
         FROM stock_balance
         WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'
       ), first_receipt AS (
         SELECT MIN((metadata->>'occurred_at')::timestamptz) AS first_received_at
         FROM domain_events, target_location
         WHERE event_type = 'stock.received'
           AND payload->>'sku' = $1
           AND (
             payload->>'target_location_id' = $2::text
             OR (payload->>'target_location_id' IS NULL AND payload->>'target_location_code' = target_location.location_code)
           )
           AND COALESCE(payload->>'stock_class', 'owned') = 'owned'
       ), clock AS (
         SELECT COALESCE(owned_balance.last_issue_at, first_receipt.first_received_at, owned_balance.first_balance_at, $3::timestamptz) AS clock_started_at,
                COALESCE(owned_balance.owned_on_hand, 0) AS owned_on_hand
         FROM owned_balance, first_receipt
       )
       SELECT clock_started_at,
              floor(EXTRACT(EPOCH FROM (now() - clock_started_at)) / 86400)::int AS days_since_issue,
              owned_on_hand::text AS owned_on_hand
       FROM clock`,
      [row.sku, row.location_id, row.created_at],
    );
    const clockRaw = activityRes.rows[0]!['clock_started_at'];
    const daysSinceIssue = activityRes.rows[0]!['days_since_issue'] as number | null;
    const ownedOnHand = Number(activityRes.rows[0]!['owned_on_hand'] ?? 0);
    const currentFlag = await getObsolescenceFlag(row.sku, row.location_id, client, true);

    if (ownedOnHand <= 0 || clockRaw === null || daysSinceIssue === null) {
      await client.query('COMMIT');
      committed = true;
      return null;
    }
    const lastIssueAt = clockRaw instanceof Date ? clockRaw.toISOString() : new Date(String(clockRaw)).toISOString();

    if (daysSinceIssue > threshold) {
      if (currentFlag && currentFlag.status === 'aging') {
        await client.query('COMMIT');
        committed = true;
        return null; // already flagged; idempotent
      }
      const flagId = currentFlag?.obsolescence_flag_id ?? randomUUID();
      await persistEvent(
        {
          stream_type: 'inventory',
          stream_id: flagId,
          event_type: 'obsolescence.flagged',
          payload: {
            obsolescence_flag_id: flagId,
            sku: row.sku,
            location_id: row.location_id,
            last_issue_at: lastIssueAt,
            days_since_issue: daysSinceIssue,
            threshold_days: threshold,
            disposition_status: 'pending_disposition',
            nrv_testing_triggered: true,
            flagged_at: new Date().toISOString(),
            business_date: scope.business_date,
            business_stream: row.business_stream,
          },
          metadata: planningEventMetadata(scope),
        },
        scope.auditCtx,
        client,
      );

      // "Trigger NRV testing" = flag + alert, NOT a write-down. The DOA-gated write-down stays in
      // inventory-valuation.ts (Story 2.4); planning never posts it.
      await emitNotificationInTransaction(
        {
          target: { role: PLANNER_ROLE, location_id: row.location_id },
          event_type: 'obsolescence_flagged',
          status_verb: 'Aging - NRV review required',
          object_type: 'sku',
          object_id: row.sku,
          actor_label: 'Inventory Planning',
          next_step: 'Review NRV; the item is pending disposition (Epic 16 delivers the disposition feed)',
          actor: scope.actor,
        },
        client,
      );

      await client.query('COMMIT');
      committed = true;
      return { status: 'flagged', days_since_issue: daysSinceIssue };
    }

    // Within threshold: clear a previously aging flag so resumed movement un-flags it idempotently.
    if (currentFlag && currentFlag.status === 'aging') {
      await persistEvent(
        {
          stream_type: 'inventory',
          stream_id: currentFlag.obsolescence_flag_id,
          event_type: 'obsolescence.cleared',
          payload: {
            obsolescence_flag_id: currentFlag.obsolescence_flag_id,
            sku: row.sku,
            location_id: row.location_id,
            cleared_at: new Date().toISOString(),
            reason: 'resumed_issue_activity',
            business_date: scope.business_date,
            business_stream: row.business_stream,
          },
          metadata: planningEventMetadata(scope),
        },
        scope.auditCtx,
        client,
      );
      await client.query('COMMIT');
      committed = true;
      return 'cleared';
    }

    await client.query('COMMIT');
    committed = true;
    return null;
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
