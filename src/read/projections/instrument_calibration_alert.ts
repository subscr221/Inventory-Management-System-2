import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { isValidCalendarDate } from '../../lib/business-days.js';

/**
 * Story 7.5 accessors for the staged calibration expiry alerts (FR-M-12, AC 1).
 *
 * The grain is (certificate_id, stage_days): one alert per stage per certificate, ever. That is
 * deliberately different from the Story 7.4 daily breach alert - a breach persists and earns a
 * daily nudge, an expiry countdown does not - and it is what makes a skipped scan catch up and a
 * same-day re-run a no-op.
 */
export interface CalibrationAlertRow {
  alert_id: string;
  certificate_id: string;
  instrument_record_id: string;
  stage_days: number;
  valid_until: string;
  business_date: string;
  flagged_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALERT_COLUMNS = `alert_id, certificate_id, instrument_record_id, stage_days,
    to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
    to_char(business_date, 'YYYY-MM-DD') AS business_date,
    flagged_at, created_at`;

export async function getCalibrationAlertById(
  alertId: string,
  client?: PoolClient,
): Promise<CalibrationAlertRow | null> {
  if (!UUID_REGEX.test(alertId)) return null;
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM instrument_calibration_alert WHERE alert_id = $1`,
    [alertId],
  );
  return (result.rows[0] as CalibrationAlertRow) ?? null;
}

/**
 * The grain guard read: the alert already occupying one (certificate_id, stage_days), if any. The
 * caller uses it to skip an already-fired stage rather than colliding with
 * uq_instrument_calibration_alert_stage; the constraint remains the concurrency backstop.
 */
export async function getCalibrationAlertForStage(
  certificateId: string,
  stageDays: number,
  client?: PoolClient,
): Promise<CalibrationAlertRow | null> {
  if (!UUID_REGEX.test(certificateId)) return null;
  if (!Number.isInteger(stageDays)) return null;
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM instrument_calibration_alert
      WHERE certificate_id = $1 AND stage_days = $2`,
    [certificateId, stageDays],
  );
  return (result.rows[0] as CalibrationAlertRow) ?? null;
}

export interface InsertCalibrationAlertRow {
  alert_id: string;
  certificate_id: string;
  instrument_record_id: string;
  stage_days: number;
  valid_until: string;
  business_date: string;
  flagged_at: string;
}

export async function insertCalibrationAlert(
  row: InsertCalibrationAlertRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO instrument_calibration_alert (
      alert_id, certificate_id, instrument_record_id, stage_days, valid_until, business_date, flagged_at
    ) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7)`,
    [
      row.alert_id,
      row.certificate_id,
      row.instrument_record_id,
      row.stage_days,
      row.valid_until,
      row.business_date,
      row.flagged_at,
    ],
  );
}

export interface ListCalibrationAlertsParams {
  instrument_record_id?: string | undefined;
  certificate_id?: string | undefined;
  stage_days?: number | undefined;
  business_date?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listCalibrationAlerts(
  params: ListCalibrationAlertsParams,
  client?: PoolClient,
): Promise<CalibrationAlertRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.instrument_record_id) {
    if (!UUID_REGEX.test(params.instrument_record_id)) return [];
    conditions.push(`instrument_record_id = $${idx++}`);
    values.push(params.instrument_record_id);
  }
  if (params.certificate_id) {
    if (!UUID_REGEX.test(params.certificate_id)) return [];
    conditions.push(`certificate_id = $${idx++}`);
    values.push(params.certificate_id);
  }
  if (params.stage_days !== undefined) {
    if (!Number.isInteger(params.stage_days)) return [];
    conditions.push(`stage_days = $${idx++}`);
    values.push(params.stage_days);
  }
  if (params.business_date) {
    if (!isValidCalendarDate(params.business_date)) return [];
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
  const result = await runner(client).query(
    `SELECT ${ALERT_COLUMNS} FROM instrument_calibration_alert ${where}
      ORDER BY business_date DESC, stage_days ASC, alert_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as CalibrationAlertRow[];
}
