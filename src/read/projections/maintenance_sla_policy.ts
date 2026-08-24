import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.3 accessors for the maintenance SLA policy table (FR-M-05). */
export interface MaintenanceSlaPolicyRow {
  policy_id: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
  safety_flag: boolean;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  response_minutes: number;
  resolution_hours: number;
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
const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);

const SLA_POLICY_COLUMNS = `policy_id, criticality_class, safety_flag, priority,
    response_minutes, resolution_hours, status, created_by, created_at, updated_at`;

export async function getSlaPolicyById(
  policyId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceSlaPolicyRow | null> {
  if (!UUID_REGEX.test(policyId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${SLA_POLICY_COLUMNS} FROM maintenance_sla_policy WHERE policy_id = $1${lockClause}`,
    [policyId],
  );
  return (result.rows[0] as MaintenanceSlaPolicyRow) ?? null;
}

/** The active policy for one (criticality_class, safety_flag) pair - the configurability lookup. */
export async function getActiveSlaPolicy(
  criticalityClass: string,
  safetyFlag: boolean,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceSlaPolicyRow | null> {
  if (!CRITICALITY_CLASSES.has(criticalityClass)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${SLA_POLICY_COLUMNS} FROM maintenance_sla_policy
      WHERE status = 'active' AND criticality_class = $1 AND safety_flag = $2${lockClause}`,
    [criticalityClass, safetyFlag],
  );
  return (result.rows[0] as MaintenanceSlaPolicyRow) ?? null;
}

export interface InsertSlaPolicyRow {
  policy_id: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
  safety_flag: boolean;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  response_minutes: number;
  resolution_hours: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertSlaPolicy(row: InsertSlaPolicyRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_sla_policy (
      policy_id, criticality_class, safety_flag, priority, response_minutes, resolution_hours,
      status, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`,
    [
      row.policy_id,
      row.criticality_class,
      row.safety_flag,
      row.priority,
      row.response_minutes,
      row.resolution_hours,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

export interface ListSlaPoliciesParams {
  criticality_class?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSlaPolicies(
  params: ListSlaPoliciesParams,
  client?: PoolClient,
): Promise<MaintenanceSlaPolicyRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.criticality_class) {
    if (!CRITICALITY_CLASSES.has(params.criticality_class)) return [];
    conditions.push(`criticality_class = $${idx++}`);
    values.push(params.criticality_class);
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
    `SELECT ${SLA_POLICY_COLUMNS} FROM maintenance_sla_policy ${where}
      ORDER BY criticality_class ASC, safety_flag ASC, created_at ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceSlaPolicyRow[];
}
