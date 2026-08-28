import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.8 accessors for the three-part closure coding ledger (FR-M-18, AC 3 and AC 4).
 *
 * insertWorkOrderClosure is called by applyWorkOrderCompleted inside the completion transaction,
 * under the work order's FOR UPDATE lock already held. The table is append-only: there is no
 * update or delete accessor here, and app_user holds no UPDATE grant on it. The closure id IS the
 * work order id (Binding Decision 9), so replay mints nothing random.
 *
 * listRecentClosuresForAsset is the "last five closures" read (AC 4): breakdown-first by default,
 * because a well-maintained asset would otherwise fill all five slots with PM closures and hide
 * the faults; `origin: null` widens it to every origin.
 */
export interface ClosureRow {
  work_order_id: string;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  fault_code: string;
  cause_code: string;
  remedy_code: string;
  closed_by: string;
  closed_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINS = new Set(['preventive', 'breakdown']);

const CLOSURE_COLUMNS = `work_order_id, asset_id, origin, fault_code, cause_code, remedy_code,
    closed_by, closed_at, created_at`;

export interface InsertClosureRow {
  work_order_id: string;
  asset_id: string;
  origin: 'preventive' | 'breakdown';
  fault_code: string;
  cause_code: string;
  remedy_code: string;
  closed_by: string;
  closed_at: string;
}

export async function insertWorkOrderClosure(
  row: InsertClosureRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_work_order_closure (
      work_order_id, asset_id, origin, fault_code, cause_code, remedy_code, closed_by, closed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.work_order_id,
      row.asset_id,
      row.origin,
      row.fault_code,
      row.cause_code,
      row.remedy_code,
      row.closed_by,
      row.closed_at,
    ],
  );
}

export async function getWorkOrderClosure(
  workOrderId: string,
  client?: PoolClient,
): Promise<ClosureRow | null> {
  if (!UUID_REGEX.test(workOrderId)) return null;
  const result = await runner(client).query(
    `SELECT ${CLOSURE_COLUMNS} FROM maintenance_work_order_closure WHERE work_order_id = $1`,
    [workOrderId],
  );
  return (result.rows[0] as ClosureRow) ?? null;
}

export interface RecentClosuresOptions {
  /** 1..50, default 5. */
  limit?: number | undefined;
  /** 'breakdown' (default), 'preventive', or null for every origin. */
  origin?: 'preventive' | 'breakdown' | null | undefined;
}

export async function listRecentClosuresForAsset(
  assetId: string,
  options: RecentClosuresOptions = {},
  client?: PoolClient,
): Promise<ClosureRow[]> {
  if (!UUID_REGEX.test(assetId)) return [];
  const origin = options.origin === undefined ? 'breakdown' : options.origin;
  if (origin !== null && !ORIGINS.has(origin)) return [];
  const limit = Number.isFinite(options.limit ?? 5)
    ? Math.min(Math.max(Math.trunc(options.limit ?? 5), 1), 50)
    : 5;
  const result = await runner(client).query(
    `SELECT ${CLOSURE_COLUMNS} FROM maintenance_work_order_closure
      WHERE asset_id = $1 AND ($3::text IS NULL OR origin = $3)
      ORDER BY closed_at DESC, work_order_id ASC
      LIMIT $2`,
    [assetId, limit, origin],
  );
  return result.rows as ClosureRow[];
}

export interface ListClosuresParams {
  asset_id?: string | undefined;
  origin?: 'preventive' | 'breakdown' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listClosures(
  params: ListClosuresParams,
  client?: PoolClient,
): Promise<ClosureRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;
  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.origin) {
    if (!ORIGINS.has(params.origin)) return [];
    conditions.push(`origin = $${idx++}`);
    values.push(params.origin);
  }
  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${CLOSURE_COLUMNS} FROM maintenance_work_order_closure ${where}
      ORDER BY closed_at DESC, work_order_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as ClosureRow[];
}
