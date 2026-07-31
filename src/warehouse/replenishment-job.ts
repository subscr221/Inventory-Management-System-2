import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import type { EventEnvelope } from '../events/store.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import {
  listForwardPickConfigs,
  getForwardPickConfigForUpdate,
} from '../read/projections/forward_pick_config.js';
import { getForwardPickBalance } from '../read/projections/stock_balance.js';
import { getOpenPickDemand } from '../read/projections/erp_sales_order.js';

/**
 * Story 3.9 (AC1, AC2): the Phase-1 synthetic forward-pick replenishment trigger, modeled directly
 * on src/compliance/planning-jobs.ts's runVmiReplenishmentCheck - a job triggered by an HTTP call
 * (POST /api/v1/replenishment/check), not a real scheduler. For each matching forward_pick_config
 * row: lock it, compute the current forward-pick balance, and either raise a min/max top-up task
 * or a demand-signal shortfall task through persistEvent, so the projection and the domain event
 * commit atomically.
 */

export interface ReplenishmentCheckActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface ReplenishmentCheckScope {
  siteId?: string | null;
  zoneId?: string | null;
  sku?: string | null;
  /** The authenticated caller who triggered this check - never a placeholder identity. */
  actor: ReplenishmentCheckActor;
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;
}

export interface ReplenishmentCheckResult {
  created: Array<{
    sku: string;
    zone_id: string;
    replenishment_task_id: string;
    signal_type: 'min_max' | 'demand_signal';
    quantity: string;
  }>;
  skipped: Array<{ sku: string; zone_id: string; reason: string }>;
}

function eventMetadata(
  actor: ReplenishmentCheckActor,
  correlationId: string,
): EventEnvelope['metadata'] {
  return {
    correlation_id: correlationId,
    actor,
    occurred_at: new Date().toISOString(),
  };
}

export async function runForwardPickReplenishmentCheck(
  scope: ReplenishmentCheckScope,
): Promise<ReplenishmentCheckResult> {
  const configs = await listForwardPickConfigs({
    siteId: scope.siteId ?? null,
    zoneId: scope.zoneId ?? null,
    sku: scope.sku ?? null,
  });
  const created: ReplenishmentCheckResult['created'] = [];
  const skipped: ReplenishmentCheckResult['skipped'] = [];

  for (const config of configs) {
    const outcome = await checkOneZone(config.sku, config.zone_id, scope.actor, scope.auditCtx);
    if (outcome && 'replenishment_task_id' in outcome) created.push(outcome);
    else if (outcome) skipped.push(outcome);
  }
  return { created, skipped };
}

type ZoneCheckOutcome =
  | {
      sku: string;
      zone_id: string;
      replenishment_task_id: string;
      signal_type: 'min_max' | 'demand_signal';
      quantity: string;
    }
  | { sku: string; zone_id: string; reason: string }
  | null;

async function checkOneZone(
  sku: string,
  zoneId: string,
  actor: ReplenishmentCheckActor,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<ZoneCheckOutcome> {
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Lock the config row so a concurrent check for this (sku, zone) serializes: the loser waits,
    // then sees the open task the winner committed and skips it.
    const config = await getForwardPickConfigForUpdate(sku, zoneId, client);
    if (!config) {
      await client.query('COMMIT');
      committed = true;
      return { sku, zone_id: zoneId, reason: 'FORWARD_PICK_CONFIG_NOT_FOUND' };
    }

    const balance = await getForwardPickBalance(sku, zoneId, client);
    let signalType: 'min_max' | 'demand_signal';
    let quantity: string;

    const balRes = await client.query(`SELECT $1::numeric < $2::numeric AS below_min`, [
      balance,
      config.min_qty,
    ]);
    if (balRes.rows[0]!['below_min'] === true) {
      signalType = 'min_max';
      const qtyRes = await client.query(`SELECT ($1::numeric - $2::numeric)::text AS qty`, [
        config.max_qty,
        balance,
      ]);
      quantity = qtyRes.rows[0]!['qty'] as string;
    } else {
      const demand = await getOpenPickDemand(sku, config.site_id, client);
      const demandRes = await client.query(`SELECT $1::numeric > $2::numeric AS demand_exceeds`, [
        demand,
        balance,
      ]);
      if (demandRes.rows[0]!['demand_exceeds'] !== true) {
        await client.query('COMMIT');
        committed = true;
        return null;
      }
      signalType = 'demand_signal';
      const qtyRes = await client.query(`SELECT ($1::numeric - $2::numeric)::text AS qty`, [
        demand,
        balance,
      ]);
      quantity = qtyRes.rows[0]!['qty'] as string;
    }

    // Idempotent per (sku, zone, signal_type): re-running the trigger with no balance change must
    // not stack a second open task. The partial unique index (uq_replenishment_task_open_signal)
    // is the concurrency backstop for two runs racing each other; this read is what makes a single
    // sequential re-run a no-op instead of an avoidable constraint error.
    // ponytail: a shortfall whose quantity changed since the open task was raised still reads as
    // "already covered" rather than refreshing the open task's quantity - upgrade to a supersede-
    // and-reissue pattern (mirroring replenishment_recommendation's) if operators need the posted
    // task to track a moving shortfall before it is ever actioned.
    const existing = await client.query(
      `SELECT replenishment_task_id FROM replenishment_task
        WHERE sku = $1 AND zone_id = $2 AND signal_type = $3 AND status = 'ready'`,
      [sku, zoneId, signalType],
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      committed = true;
      return null;
    }

    // Phase-1 source-bin selection (Dev Notes): the first active bin, by location_code, under any
    // active reserve zone at this config's site whose owned available stock covers the top-up
    // quantity. No FEFO/velocity ranking - none of the three ACs require it for the source side.
    const sourceRes = await client.query(
      `WITH RECURSIVE reserve_zones AS (
         SELECT location_id FROM location_register
          WHERE site_id = $1 AND level = 'zone' AND zone_type = 'reserve' AND status = 'active'
       ), descendants AS (
         SELECT location_id, 0 AS depth FROM reserve_zones
         UNION ALL
         SELECT lr.location_id, d.depth + 1
           FROM location_register lr
           JOIN descendants d ON lr.parent_location_id = d.location_id
          WHERE d.depth < 10
       )
       SELECT lr.location_id
         FROM location_register lr
         JOIN descendants d ON d.location_id = lr.location_id
         JOIN stock_balance sb ON sb.location_id = lr.location_id AND sb.sku = $2 AND sb.stock_class = 'owned'
        WHERE lr.level = 'bin' AND lr.status = 'active'
        GROUP BY lr.location_id, lr.location_code
       HAVING SUM(sb.available) >= $3::numeric
        ORDER BY lr.location_code
        LIMIT 1`,
      [config.site_id, sku, quantity],
    );
    const fromLocationId =
      sourceRes.rows.length > 0 ? (sourceRes.rows[0]!['location_id'] as string) : null;

    const replenishmentTaskId = randomUUID();
    const correlationId = randomUUID();
    await persistEvent(
      {
        stream_type: 'warehouse',
        stream_id: replenishmentTaskId,
        event_type: 'replenishment_task.created',
        payload: {
          replenishment_task_id: replenishmentTaskId,
          sku,
          zone_id: zoneId,
          site_id: config.site_id,
          from_location_id: fromLocationId,
          quantity,
          signal_type: signalType,
        },
        metadata: eventMetadata(actor, correlationId),
      },
      auditCtx,
      client,
    );

    await client.query('COMMIT');
    committed = true;
    return {
      sku,
      zone_id: zoneId,
      replenishment_task_id: replenishmentTaskId,
      signal_type: signalType,
      quantity,
    };
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
