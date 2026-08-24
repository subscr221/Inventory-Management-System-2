import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.3 accessors for the maintenance fault report table (FR-M-04). */
export interface MaintenanceFaultReportRow {
  fault_report_id: string;
  asset_id: string;
  asset_tag: string;
  reported_by: string;
  reported_at: string;
  location_id: string;
  description: string;
  safety_flag: boolean;
  status: 'reported' | 'accepted' | 'rejected';
  work_order_id: string | null;
  triaged_at: string | null;
  triaged_by: string | null;
  rejection_reason: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAULT_STATUSES = new Set(['reported', 'accepted', 'rejected']);

const FAULT_REPORT_COLUMNS = `fault_report_id, asset_id, asset_tag, reported_by, reported_at,
    location_id, description, safety_flag, status, work_order_id, triaged_at, triaged_by,
    rejection_reason, notified_at, created_at, updated_at`;

export async function getFaultReportById(
  faultReportId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceFaultReportRow | null> {
  if (!UUID_REGEX.test(faultReportId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${FAULT_REPORT_COLUMNS} FROM maintenance_fault_report WHERE fault_report_id = $1${lockClause}`,
    [faultReportId],
  );
  return (result.rows[0] as MaintenanceFaultReportRow) ?? null;
}

export interface InsertFaultReportRow {
  fault_report_id: string;
  asset_id: string;
  asset_tag: string;
  reported_by: string;
  reported_at: string;
  location_id: string;
  description: string;
  safety_flag: boolean;
  created_at: string;
  updated_at: string;
}

export async function insertFaultReport(
  row: InsertFaultReportRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_fault_report (
      fault_report_id, asset_id, asset_tag, reported_by, reported_at, location_id,
      description, safety_flag, status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reported',$9,$10)`,
    [
      row.fault_report_id,
      row.asset_id,
      row.asset_tag,
      row.reported_by,
      row.reported_at,
      row.location_id,
      row.description,
      row.safety_flag,
      row.created_at,
      row.updated_at,
    ],
  );
}

export async function setFaultAccepted(
  faultReportId: string,
  workOrderId: string,
  triagedAt: string,
  triagedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_fault_report
        SET status = 'accepted',
            work_order_id = $2,
            triaged_at = $3,
            triaged_by = $4,
            updated_at = now()
      WHERE fault_report_id = $1`,
    [faultReportId, workOrderId, triagedAt, triagedBy],
  );
}

export async function setFaultRejected(
  faultReportId: string,
  reason: string,
  triagedAt: string,
  triagedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE maintenance_fault_report
        SET status = 'rejected',
            rejection_reason = $2,
            triaged_at = $3,
            triaged_by = $4,
            updated_at = now()
      WHERE fault_report_id = $1`,
    [faultReportId, reason, triagedAt, triagedBy],
  );
}

/**
 * Story 7.3 notification side-effect stamp (Task 6.3): records when the supervisor notification
 * for a fault report actually committed. This is a DELIVERY-side patch, deliberately not
 * event-sourced - the fault_reported event carries no notified_at and a notification outage must
 * never block the report, so the column simply stays null until an emission succeeds.
 */
export async function setFaultNotified(
  faultReportId: string,
  notifiedAt: string,
  client?: PoolClient,
): Promise<void> {
  const r = runner(client);
  await r.query(
    `UPDATE maintenance_fault_report
        SET notified_at = $2,
            updated_at = now()
      WHERE fault_report_id = $1`,
    [faultReportId, notifiedAt],
  );
}

export interface ListFaultReportsParams {
  asset_id?: string | undefined;
  status?: 'reported' | 'accepted' | 'rejected' | undefined;
  location_id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listFaultReports(
  params: ListFaultReportsParams,
  client?: PoolClient,
): Promise<MaintenanceFaultReportRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.status) {
    if (!FAULT_STATUSES.has(params.status)) return [];
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.from) {
    if (Number.isNaN(Date.parse(params.from))) return [];
    conditions.push(`reported_at >= $${idx++}::timestamptz`);
    values.push(params.from);
  }
  if (params.to) {
    if (Number.isNaN(Date.parse(params.to))) return [];
    conditions.push(`reported_at <= $${idx++}::timestamptz`);
    values.push(params.to);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${FAULT_REPORT_COLUMNS} FROM maintenance_fault_report ${where}
      ORDER BY reported_at DESC, fault_report_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceFaultReportRow[];
}
