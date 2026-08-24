import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.2 accessors for the PM plan register (FR-M-02). pg returns DATE columns as strings and
 * TIMESTAMPTZ columns as Date objects; every query here casts the DATE columns with to_char so
 * the row shape serializes to a stable YYYY-MM-DD across the API surface (TIMESTAMPTZ columns are
 * JSON-safe either way, per the platform-wide asset.ts convention).
 */
export interface MaintenancePlanRow {
  plan_id: string;
  asset_id: string;
  plan_name: string;
  plan_type: 'calendar' | 'meter';
  interval_days: number | null;
  meter_id: string | null;
  interval_meter_units: string | null;
  grace_period_days: number;
  escalation_role: string;
  anchor_date: string;
  next_due_date: string | null;
  next_due_meter: string | null;
  status: 'active' | 'inactive';
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DATE columns are rendered as text so a plan row serializes to a stable YYYY-MM-DD in API
// responses regardless of the process timezone.
const PLAN_COLUMNS = `plan_id, asset_id, plan_name, plan_type, interval_days, meter_id,
    interval_meter_units, grace_period_days, escalation_role,
    to_char(anchor_date, 'YYYY-MM-DD') AS anchor_date,
    to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
    next_due_meter, status, created_by, created_at, updated_at`;

export async function getPlanById(
  planId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenancePlanRow | null> {
  if (!UUID_REGEX.test(planId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${PLAN_COLUMNS} FROM maintenance_plan WHERE plan_id = $1${lockClause}`,
    [planId],
  );
  return (result.rows[0] as MaintenancePlanRow) ?? null;
}

export async function getPlanByName(
  assetId: string,
  planName: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenancePlanRow | null> {
  if (!UUID_REGEX.test(assetId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // Case-insensitive to match uq_maintenance_plan_name (asset_id, lower(plan_name)).
  const result = await r.query(
    `SELECT ${PLAN_COLUMNS} FROM maintenance_plan
      WHERE asset_id = $1 AND lower(plan_name) = lower($2)${lockClause}`,
    [assetId, planName],
  );
  return (result.rows[0] as MaintenancePlanRow) ?? null;
}

export interface InsertMaintenancePlanRow {
  plan_id: string;
  asset_id: string;
  plan_name: string;
  plan_type: 'calendar' | 'meter';
  interval_days: number | null;
  meter_id: string | null;
  interval_meter_units: number | null;
  grace_period_days: number;
  escalation_role: string;
  anchor_date: string;
  next_due_date: string | null;
  next_due_meter: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertPlan(row: InsertMaintenancePlanRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_plan (
      plan_id, asset_id, plan_name, plan_type, interval_days, meter_id, interval_meter_units,
      grace_period_days, escalation_role, anchor_date, next_due_date, next_due_meter,
      status, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14,$15)`,
    [
      row.plan_id,
      row.asset_id,
      row.plan_name,
      row.plan_type,
      row.interval_days,
      row.meter_id,
      row.interval_meter_units,
      row.grace_period_days,
      row.escalation_role,
      row.anchor_date,
      row.next_due_date,
      row.next_due_meter,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

/**
 * Advances a calendar plan's due cursor by its own interval after a work order was generated for
 * the cycle that just came due. The arithmetic runs in SQL so the interval is applied as a real
 * date addition rather than a JavaScript millisecond approximation.
 */
export async function advancePlanCalendarDue(
  planId: string,
  generatedDueDate: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_plan
        SET next_due_date = ($2::date + (interval_days || ' days')::interval)::date,
            updated_at = now()
      WHERE plan_id = $1 AND plan_type = 'calendar'`,
    [planId, generatedDueDate],
  );
}

/**
 * Advances a meter plan's due cursor by its own interval. NUMERIC arithmetic stays in SQL so a
 * long-lived plan never accumulates float drift in its due threshold.
 */
export async function advancePlanMeterDue(planId: string, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE maintenance_plan
        SET next_due_meter = next_due_meter + interval_meter_units,
            updated_at = now()
      WHERE plan_id = $1 AND plan_type = 'meter'`,
    [planId],
  );
}

export interface ListPlansParams {
  asset_id?: string | undefined;
  plan_type?: 'calendar' | 'meter' | undefined;
  status?: 'active' | 'inactive' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listPlans(
  params: ListPlansParams,
  client?: PoolClient,
): Promise<MaintenancePlanRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.plan_type) {
    conditions.push(`plan_type = $${idx++}`);
    values.push(params.plan_type);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${PLAN_COLUMNS} FROM maintenance_plan ${where}
      ORDER BY created_at ASC, plan_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenancePlanRow[];
}

/**
 * AC 1: the plans whose next cycle has come due as of the job's business_date. A calendar plan is
 * due when next_due_date has arrived; a meter plan is due when its meter has reached the plan's
 * next_due_meter. The meter comparison runs in SQL against the joined meter row so it uses
 * NUMERIC arithmetic rather than a JavaScript float round-trip.
 */
export async function listDuePlans(
  businessDate: string,
  client?: PoolClient,
  assetId?: string,
): Promise<MaintenancePlanRow[]> {
  const r = runner(client);
  const assetFilter = assetId ? ' AND p.asset_id = $2' : '';
  const values: string[] = assetId ? [businessDate, assetId] : [businessDate];
  const result = await r.query(
    `SELECT p.plan_id, p.asset_id, p.plan_name, p.plan_type, p.interval_days, p.meter_id,
            p.interval_meter_units, p.grace_period_days, p.escalation_role,
            to_char(p.anchor_date, 'YYYY-MM-DD') AS anchor_date,
            to_char(p.next_due_date, 'YYYY-MM-DD') AS next_due_date,
            p.next_due_meter, p.status, p.created_by, p.created_at, p.updated_at
       FROM maintenance_plan p
       LEFT JOIN asset_meter m ON m.meter_id = p.meter_id
      WHERE p.status = 'active'${assetFilter}
        AND (
          (p.plan_type = 'calendar' AND p.next_due_date <= $1::date)
          OR (p.plan_type = 'meter' AND m.current_reading >= p.next_due_meter)
        )
      ORDER BY p.created_at ASC, p.plan_id ASC`,
    values,
  );
  return result.rows as MaintenancePlanRow[];
}
