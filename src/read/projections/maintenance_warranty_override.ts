import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.7 accessors for the reason-coded warranty override grain (FR-M-11, AC 3 and AC 4).
 *
 * getWarrantyOverrideByWorkOrder is the read the chargeable-work gate makes under the work order's
 * FOR UPDATE lock in applyWorkOrderCompleted: no row means completion is blocked 403
 * APPROVAL_REQUIRED. The table is append-only - there is no update or delete accessor here, and
 * app_user holds no UPDATE grant on it.
 */
export interface WarrantyOverrideRow {
  override_id: string;
  work_order_id: string;
  warranty_coverage_id: string;
  reason_code: string;
  overridden_by: string;
  overridden_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OVERRIDE_COLUMNS = `override_id, work_order_id, warranty_coverage_id, reason_code,
    overridden_by, overridden_at, created_at`;

export interface InsertWarrantyOverrideRow {
  override_id: string;
  work_order_id: string;
  warranty_coverage_id: string;
  reason_code: string;
  overridden_by: string;
  overridden_at: string;
}

export async function insertWarrantyOverride(
  row: InsertWarrantyOverrideRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_warranty_override (
      override_id, work_order_id, warranty_coverage_id, reason_code, overridden_by, overridden_at
    ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      row.override_id,
      row.work_order_id,
      row.warranty_coverage_id,
      row.reason_code,
      row.overridden_by,
      row.overridden_at,
    ],
  );
}

export async function getWarrantyOverrideByWorkOrder(
  workOrderId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<WarrantyOverrideRow | null> {
  if (!UUID_REGEX.test(workOrderId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${OVERRIDE_COLUMNS} FROM maintenance_warranty_override
      WHERE work_order_id = $1${lockClause}`,
    [workOrderId],
  );
  return (result.rows[0] as WarrantyOverrideRow) ?? null;
}

export async function getWarrantyOverrideById(
  overrideId: string,
  client?: PoolClient,
): Promise<WarrantyOverrideRow | null> {
  if (!UUID_REGEX.test(overrideId)) return null;
  const result = await runner(client).query(
    `SELECT ${OVERRIDE_COLUMNS} FROM maintenance_warranty_override WHERE override_id = $1`,
    [overrideId],
  );
  return (result.rows[0] as WarrantyOverrideRow) ?? null;
}
