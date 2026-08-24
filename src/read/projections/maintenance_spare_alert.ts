import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.4 accessors for the maintenance spare alert table (FR-M-08, FR-M-09). */
export type SpareAlertType = 'min_breach' | 'return_overdue';

export interface MaintenanceSpareAlertRow {
  alert_id: string;
  alert_type: SpareAlertType;
  sku: string;
  location_id: string;
  reservation_id: string | null;
  on_hand_at_check: string | null;
  min_level: string | null;
  return_due_date: string | null;
  business_date: string;
  flagged_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_TYPES = new Set(['min_breach', 'return_overdue']);

const ALERT_COLUMNS = `alert_id, alert_type, sku, location_id, reservation_id,
    on_hand_at_check::text AS on_hand_at_check,
    min_level::text AS min_level,
    to_char(return_due_date, 'YYYY-MM-DD') AS return_due_date,
    to_char(business_date, 'YYYY-MM-DD') AS business_date,
    flagged_at, created_at`;

export async function getSpareAlertById(
  alertId: string,
  client?: PoolClient,
): Promise<MaintenanceSpareAlertRow | null> {
  if (!UUID_REGEX.test(alertId)) return null;
  const r = runner(client);
  const result = await r.query(
    `SELECT ${ALERT_COLUMNS} FROM maintenance_spare_alert WHERE alert_id = $1`,
    [alertId],
  );
  return (result.rows[0] as MaintenanceSpareAlertRow) ?? null;
}

/**
 * The same-day guard read: the existing alert for one grain on one business_date, if any. The
 * caller uses it to skip a still-breached grain on a re-run rather than colliding with
 * uq_maintenance_spare_alert_day; the constraint remains the concurrency backstop.
 */
export async function getSpareAlertForDay(
  alertType: SpareAlertType,
  sku: string,
  locationId: string,
  reservationId: string | null,
  businessDate: string,
  client?: PoolClient,
): Promise<MaintenanceSpareAlertRow | null> {
  if (!ALERT_TYPES.has(alertType)) return null;
  if (!UUID_REGEX.test(locationId)) return null;
  const r = runner(client);
  const result = await r.query(
    `SELECT ${ALERT_COLUMNS} FROM maintenance_spare_alert
      WHERE alert_type = $1 AND sku = $2 AND location_id = $3
        AND reservation_id IS NOT DISTINCT FROM $4::uuid
        AND business_date = $5::date`,
    [alertType, sku, locationId, reservationId, businessDate],
  );
  return (result.rows[0] as MaintenanceSpareAlertRow) ?? null;
}

export interface InsertSpareAlertRow {
  alert_id: string;
  alert_type: SpareAlertType;
  sku: string;
  location_id: string;
  reservation_id: string | null;
  on_hand_at_check: string | null;
  min_level: string | null;
  return_due_date: string | null;
  business_date: string;
  flagged_at: string;
}

export async function insertSpareAlert(
  row: InsertSpareAlertRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_spare_alert (
      alert_id, alert_type, sku, location_id, reservation_id, on_hand_at_check, min_level,
      return_due_date, business_date, flagged_at
    ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::date,$9::date,$10)`,
    [
      row.alert_id,
      row.alert_type,
      row.sku,
      row.location_id,
      row.reservation_id,
      row.on_hand_at_check,
      row.min_level,
      row.return_due_date,
      row.business_date,
      row.flagged_at,
    ],
  );
}

export interface ListSpareAlertsParams {
  alert_type?: string | undefined;
  sku?: string | undefined;
  location_id?: string | undefined;
  business_date?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSpareAlerts(
  params: ListSpareAlertsParams,
  client?: PoolClient,
): Promise<MaintenanceSpareAlertRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.alert_type) {
    if (!ALERT_TYPES.has(params.alert_type)) return [];
    conditions.push(`alert_type = $${idx++}`);
    values.push(params.alert_type);
  }
  if (params.sku) {
    conditions.push(`sku = $${idx++}`);
    values.push(params.sku);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.business_date) {
    conditions.push(`business_date = $${idx++}::date`);
    values.push(params.business_date);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${ALERT_COLUMNS} FROM maintenance_spare_alert ${where}
      ORDER BY business_date DESC, sku ASC, alert_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceSpareAlertRow[];
}
