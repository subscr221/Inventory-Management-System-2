import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.2 accessors for the maintenance work order register (FR-M-02), extended for Story 7.3. */
export interface MaintenanceWorkOrderRow {
  work_order_id: string;
  plan_id: string | null;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  due_date: string;
  grace_until_date: string;
  status: 'open' | 'overdue' | 'completed';
  generated_for_cycle: string;
  fault_report_id: string | null;
  priority: 'p1' | 'p2' | 'p3' | 'p4' | null;
  sla_policy_id: string | null;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  overdue_at: string | null;
  escalated_at: string | null;
  // Story 7.6 (FR-M-15): the additive cost columns. NUMERIC(14,3) rendered as exact decimal
  // strings, never a JS float. capitalization_flagged is SERVER-derived at closure and this is its
  // only read surface - without it the repair-versus-capitalize decision would be write-only.
  labor_cost: string;
  parts_cost: string;
  total_cost: string;
  capitalization_flagged: boolean;
  // Story 7.7 (FR-M-11): the warranty check result. Both are SEAM-derived in
  // applyBreakdownWorkOrderCreated and never client-supplied; this is their only read surface, and
  // the chargeable-work gate in applyWorkOrderCompleted reads warranty_flagged off the locked row.
  warranty_flagged: boolean;
  warranty_coverage_id: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINS = new Set(['preventive', 'breakdown']);
const PRIORITIES = new Set(['p1', 'p2', 'p3', 'p4']);

// DATE columns are rendered as text so a work order serializes to a stable YYYY-MM-DD.
const WORK_ORDER_COLUMNS = `work_order_id, plan_id, asset_id, origin,
    to_char(due_date, 'YYYY-MM-DD') AS due_date,
    to_char(grace_until_date, 'YYYY-MM-DD') AS grace_until_date,
    status, generated_for_cycle, fault_report_id, priority, sla_policy_id,
    sla_response_due_at, sla_resolution_due_at, completed_at, completed_by, overdue_at, escalated_at,
    labor_cost::text AS labor_cost,
    parts_cost::text AS parts_cost,
    total_cost::text AS total_cost,
    capitalization_flagged,
    warranty_flagged,
    warranty_coverage_id,
    created_at, updated_at`;

export async function getWorkOrderById(
  workOrderId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceWorkOrderRow | null> {
  if (!UUID_REGEX.test(workOrderId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order WHERE work_order_id = $1${lockClause}`,
    [workOrderId],
  );
  return (result.rows[0] as MaintenanceWorkOrderRow) ?? null;
}

/** The anti-double-generation lookup: one work order per (plan, cycle). */
export async function getWorkOrderByCycle(
  planId: string,
  cycleKey: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceWorkOrderRow | null> {
  if (!UUID_REGEX.test(planId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // The explicit plan_id IS NOT NULL makes the partial unique index
  // (uq_maintenance_work_order_cycle ... WHERE plan_id IS NOT NULL) provable to the planner;
  // with only plan_id = $1 the predicate cannot be inferred from a parameter.
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order
      WHERE plan_id IS NOT NULL AND plan_id = $1 AND generated_for_cycle = $2${lockClause}`,
    [planId, cycleKey],
  );
  return (result.rows[0] as MaintenanceWorkOrderRow) ?? null;
}

/** The anti-double-acceptance lookup: the breakdown work order created for one fault report. */
export async function getWorkOrderByFaultReport(
  faultReportId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceWorkOrderRow | null> {
  if (!UUID_REGEX.test(faultReportId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  // The explicit fault_report_id IS NOT NULL makes the partial unique index
  // (uq_maintenance_work_order_fault ... WHERE fault_report_id IS NOT NULL) provable to the planner.
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order
      WHERE fault_report_id IS NOT NULL AND fault_report_id = $1${lockClause}`,
    [faultReportId],
  );
  return (result.rows[0] as MaintenanceWorkOrderRow) ?? null;
}

export interface InsertMaintenanceWorkOrderRow {
  work_order_id: string;
  plan_id: string | null;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  due_date: string;
  grace_until_date: string;
  generated_for_cycle: string;
  fault_report_id?: string | null;
  priority?: 'p1' | 'p2' | 'p3' | 'p4' | null;
  sla_policy_id?: string | null;
  sla_response_due_at?: string | null;
  sla_resolution_due_at?: string | null;
  /** Story 7.7: server-derived warranty check result; absent means an unchecked preventive order. */
  warranty_flagged?: boolean;
  warranty_coverage_id?: string | null;
  created_at: string;
  updated_at: string;
}

export async function insertWorkOrder(
  row: InsertMaintenanceWorkOrderRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_work_order (
      work_order_id, plan_id, asset_id, origin, due_date, grace_until_date,
      status, generated_for_cycle, fault_report_id, priority, sla_policy_id,
      sla_response_due_at, sla_resolution_due_at, warranty_flagged, warranty_coverage_id,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      row.work_order_id,
      row.plan_id,
      row.asset_id,
      row.origin,
      row.due_date,
      row.grace_until_date,
      row.generated_for_cycle,
      row.fault_report_id ?? null,
      row.priority ?? null,
      row.sla_policy_id ?? null,
      row.sla_response_due_at ?? null,
      row.sla_resolution_due_at ?? null,
      row.warranty_flagged ?? false,
      row.warranty_coverage_id ?? null,
      row.created_at,
      row.updated_at,
    ],
  );
}

export async function setWorkOrderCompleted(
  workOrderId: string,
  completedAt: string,
  completedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_work_order
        SET status = 'completed',
            completed_at = $2,
            completed_by = $3,
            updated_at = now()
      WHERE work_order_id = $1`,
    [workOrderId, completedAt, completedBy],
  );
}

export async function setWorkOrderOverdue(
  workOrderId: string,
  overdueAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_work_order
        SET status = 'overdue',
            overdue_at = $2,
            escalated_at = $2,
            updated_at = now()
      WHERE work_order_id = $1`,
    [workOrderId, overdueAt],
  );
}

/**
 * Story 7.6 (FR-M-15): writes the additive cost columns on a completed work order. The caller
 * (applyWorkOrderCompleted) passes the SQL-NUMERIC-derived total_cost and the server-computed
 * capitalization_flagged; costs are exact decimal strings and are never coerced to a JS float here.
 * The RETURNING clause takes the row lock so a concurrent cost write on the same work order
 * serializes with the applier's own FOR UPDATE read.
 */
export async function setWorkOrderCosts(
  workOrderId: string,
  laborCost: string,
  partsCost: string,
  totalCost: string,
  capitalizationFlagged: boolean,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE maintenance_work_order
        SET labor_cost = $2::numeric,
            parts_cost = $3::numeric,
            total_cost = $4::numeric,
            capitalization_flagged = $5,
            updated_at = now()
      WHERE work_order_id = $1
      RETURNING work_order_id`,
    [workOrderId, laborCost, partsCost, totalCost, capitalizationFlagged],
  );
  return result.rows.length > 0;
}

export interface ListWorkOrdersParams {
  asset_id?: string | undefined;
  plan_id?: string | undefined;
  origin?: 'preventive' | 'breakdown' | undefined;
  priority?: 'p1' | 'p2' | 'p3' | 'p4' | undefined;
  status?: 'open' | 'overdue' | 'completed' | undefined;
  due_before?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listWorkOrders(
  params: ListWorkOrdersParams,
  client?: PoolClient,
): Promise<MaintenanceWorkOrderRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.plan_id) {
    if (!UUID_REGEX.test(params.plan_id)) return [];
    conditions.push(`plan_id = $${idx++}`);
    values.push(params.plan_id);
  }
  if (params.origin) {
    if (!ORIGINS.has(params.origin)) return [];
    conditions.push(`origin = $${idx++}`);
    values.push(params.origin);
  }
  if (params.priority) {
    if (!PRIORITIES.has(params.priority)) return [];
    conditions.push(`priority = $${idx++}`);
    values.push(params.priority);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.due_before) {
    // Guard like the UUID filters: an unparseable date would surface as an unmapped 22007 500.
    if (Number.isNaN(Date.parse(params.due_before))) return [];
    conditions.push(`due_date < $${idx++}::date`);
    values.push(params.due_before);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order ${where}
      ORDER BY due_date ASC, work_order_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceWorkOrderRow[];
}

/**
 * AC 2: work orders still open after their grace window closed, as of the job's business_date.
 * Filtering on status = 'open' is what makes the sweep re-runnable - an already-escalated work
 * order is 'overdue' and never reappears.
 */
export async function listGraceExpiredWorkOrders(
  businessDate: string,
  client?: PoolClient,
  assetId?: string,
): Promise<MaintenanceWorkOrderRow[]> {
  const r = runner(client);
  const assetFilter = assetId ? ' AND asset_id = $2' : '';
  const values: string[] = assetId ? [businessDate, assetId] : [businessDate];
  const result = await r.query(
    `SELECT ${WORK_ORDER_COLUMNS} FROM maintenance_work_order
      WHERE status = 'open' AND grace_until_date < $1::date${assetFilter}
      ORDER BY due_date ASC, work_order_id ASC`,
    values,
  );
  return result.rows as MaintenanceWorkOrderRow[];
}

/**
 * Completed breakdown work orders whose downtime window closed inside the period - the join the
 * monthly reliability report needs. The half-open interval [period_start, period_end + 1 day)
 * matches summarizeDowntime's eligibility predicate exactly, so a work order cannot appear in one
 * query and not the other.
 */
export async function listBreakdownWorkOrdersInPeriod(
  periodStart: string,
  periodEnd: string,
  client?: PoolClient,
  assetId?: string,
): Promise<MaintenanceWorkOrderRow[]> {
  const r = runner(client);
  const assetFilter = assetId ? ' AND w.asset_id = $3' : '';
  const values: string[] = assetId ? [periodStart, periodEnd, assetId] : [periodStart, periodEnd];
  const result = await r.query(
    `SELECT w.work_order_id, w.plan_id, w.asset_id, w.origin,
            to_char(w.due_date, 'YYYY-MM-DD') AS due_date,
            to_char(w.grace_until_date, 'YYYY-MM-DD') AS grace_until_date,
            w.status, w.generated_for_cycle, w.fault_report_id, w.priority, w.sla_policy_id,
            w.sla_response_due_at, w.sla_resolution_due_at, w.completed_at, w.completed_by,
            w.overdue_at, w.escalated_at,
            w.labor_cost::text AS labor_cost,
            w.parts_cost::text AS parts_cost,
            w.total_cost::text AS total_cost,
            w.capitalization_flagged,
            w.warranty_flagged,
            w.warranty_coverage_id,
            w.created_at, w.updated_at
       FROM maintenance_work_order w
      WHERE w.origin = 'breakdown'
        AND w.plan_id IS NULL
        AND EXISTS (
          SELECT 1 FROM maintenance_downtime d
           WHERE d.work_order_id = w.work_order_id
             AND d.ended_at IS NOT NULL
             AND d.ended_at >= ($1::date AT TIME ZONE 'UTC')
             AND d.ended_at < (($2::date + 1) AT TIME ZONE 'UTC')
        )${assetFilter}
      ORDER BY w.due_date ASC, w.work_order_id ASC`,
    values,
  );
  return result.rows as MaintenanceWorkOrderRow[];
}
