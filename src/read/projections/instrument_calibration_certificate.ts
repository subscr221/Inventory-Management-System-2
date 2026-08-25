import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { isValidCalendarDate } from '../../lib/business-days.js';

/**
 * Story 7.5 accessors for the calibration certificate register (FR-M-12, AD-8).
 *
 * Certificate validity is the ONLY source of calibrated status for a registered instrument, so
 * every read here is load-bearing on a lockout decision. DATE columns are rendered to text in SQL
 * (to_char) and never handed back as JS Date objects: a pg Date carries a wall-clock instant, and
 * deriving a calendar date from it with slice(0, 10) is the documented clock-window defect family
 * in this repo.
 */
export type CalibrationType = 'in_house' | 'iso_17025';
export type CertificateStatus = 'active' | 'superseded' | 'expired';

export interface CalibrationCertificateRow {
  certificate_id: string;
  instrument_record_id: string;
  instrument_id: string;
  calibration_type: CalibrationType;
  certificate_number: string;
  issuing_lab: string | null;
  calibrated_on: string;
  valid_until: string;
  status: CertificateStatus;
  recorded_by: string;
  recorded_at: string;
  superseded_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A certificate row plus the stage that is due for it and the register facts the alert needs. */
export interface CertificateStageDueRow extends CalibrationCertificateRow {
  stage_days: number;
  location_id: string;
  asset_id: string;
  /**
   * Whole days from business_date to valid_until, computed in SQL DATE arithmetic. The scan puts
   * it in the notification text; deriving it in JS from a pg Date is the clock-window shortcut this
   * repo has a documented family of defects from.
   */
  days_remaining: number;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CERT_COLUMNS = `certificate_id, instrument_record_id, instrument_id, calibration_type,
    certificate_number, issuing_lab,
    to_char(calibrated_on, 'YYYY-MM-DD') AS calibrated_on,
    to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
    status, recorded_by, recorded_at, superseded_at, expired_at, created_at, updated_at`;

const CERT_COLUMNS_PREFIXED = `c.certificate_id, c.instrument_record_id, c.instrument_id, c.calibration_type,
    c.certificate_number, c.issuing_lab,
    to_char(c.calibrated_on, 'YYYY-MM-DD') AS calibrated_on,
    to_char(c.valid_until, 'YYYY-MM-DD') AS valid_until,
    c.status, c.recorded_by, c.recorded_at, c.superseded_at, c.expired_at, c.created_at, c.updated_at`;

export async function getCertificateById(
  certificateId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CalibrationCertificateRow | null> {
  if (!UUID_REGEX.test(certificateId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS} FROM instrument_calibration_certificate WHERE certificate_id = $1${lockClause}`,
    [certificateId],
  );
  return (result.rows[0] as CalibrationCertificateRow) ?? null;
}

/**
 * The at-most-one active certificate per instrument, held under FOR UPDATE when the caller is
 * about to supersede or expire it. uq_instrument_calibration_certificate_active is the backstop
 * behind this read, not a substitute for it.
 */
export async function getActiveCertificate(
  instrumentRecordId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CalibrationCertificateRow | null> {
  if (!UUID_REGEX.test(instrumentRecordId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS} FROM instrument_calibration_certificate
      WHERE instrument_record_id = $1 AND status = 'active'${lockClause}`,
    [instrumentRecordId],
  );
  return (result.rows[0] as CalibrationCertificateRow) ?? null;
}

export async function getCertificateByNumber(
  instrumentRecordId: string,
  certificateNumber: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CalibrationCertificateRow | null> {
  if (!UUID_REGEX.test(instrumentRecordId)) return null;
  if (typeof certificateNumber !== 'string' || certificateNumber.trim() === '') return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS} FROM instrument_calibration_certificate
      WHERE instrument_record_id = $1 AND lower(certificate_number) = lower($2)${lockClause}`,
    [instrumentRecordId, certificateNumber],
  );
  return (result.rows[0] as CalibrationCertificateRow) ?? null;
}

export interface InsertCalibrationCertificateRow {
  certificate_id: string;
  instrument_record_id: string;
  instrument_id: string;
  calibration_type: CalibrationType;
  certificate_number: string;
  issuing_lab: string | null;
  calibrated_on: string;
  valid_until: string;
  recorded_by: string;
  recorded_at: string;
}

export async function insertCertificate(
  row: InsertCalibrationCertificateRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO instrument_calibration_certificate (
      certificate_id, instrument_record_id, instrument_id, calibration_type, certificate_number,
      issuing_lab, calibrated_on, valid_until, status, recorded_by, recorded_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,'active',$9,$10)`,
    [
      row.certificate_id,
      row.instrument_record_id,
      row.instrument_id,
      row.calibration_type,
      row.certificate_number,
      row.issuing_lab,
      row.calibrated_on,
      row.valid_until,
      row.recorded_by,
      row.recorded_at,
    ],
  );
}

/**
 * Moves the instrument's current active certificate to 'superseded'. History is retained: the row
 * keeps every field and changes status, so the register can still answer what the instrument was
 * calibrated under on any past date. Returns the superseded certificate_id, or null when there was
 * no active certificate.
 */
export async function supersedeActiveCertificate(
  instrumentRecordId: string,
  supersededAt: string,
  client: PoolClient,
): Promise<string | null> {
  const result = await client.query(
    `UPDATE instrument_calibration_certificate
        SET status = 'superseded', superseded_at = $2, updated_at = now()
      WHERE instrument_record_id = $1 AND status = 'active'
      RETURNING certificate_id`,
    [instrumentRecordId, supersededAt],
  );
  return (result.rows[0]?.['certificate_id'] as string | undefined) ?? null;
}

/** Moves one active certificate to 'expired'. Returns false when it was no longer active. */
export async function markCertificateExpired(
  certificateId: string,
  expiredAt: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE instrument_calibration_certificate
        SET status = 'expired', expired_at = $2, updated_at = now()
      WHERE certificate_id = $1 AND status = 'active'`,
    [certificateId, expiredAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ListCertificatesParams {
  instrument_record_id: string;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listCertificatesByInstrument(
  params: ListCertificatesParams,
  client?: PoolClient,
): Promise<CalibrationCertificateRow[]> {
  if (!UUID_REGEX.test(params.instrument_record_id)) return [];
  const conditions = ['instrument_record_id = $1'];
  const values: (string | number)[] = [params.instrument_record_id];
  let idx = 2;
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
  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS} FROM instrument_calibration_certificate
      WHERE ${conditions.join(' AND ')}
      ORDER BY recorded_at DESC, certificate_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as CalibrationCertificateRow[];
}

export interface CertificateStageDueFilters {
  instrument_record_id?: string | null | undefined;
  location_id?: string | null | undefined;
}

/**
 * The Staged Alert Contract, evaluated entirely in SQL.
 *
 * A stage is DUE when (valid_until - business_date) <= stage_days and valid_until >= business_date,
 * and it is UNFIRED when no instrument_calibration_alert row occupies its (certificate_id,
 * stage_days) grain. An equality test on the day count would silently drop a stage whenever the
 * job is not run daily; the <= comparison plus the unfired join is what makes a skipped scan catch
 * up on the next run instead of losing the warning.
 *
 * Scope is narrowed HERE, not in a JS filter afterwards, or the job's counters would overstate what
 * was evaluated (the Story 7.4 lesson). Superseded and expired certificates are excluded, so a
 * renewal produces a fresh set of three stages on a new certificate_id.
 */
export async function listCertificateStagesDue(
  businessDate: string,
  stages: readonly number[],
  filters: CertificateStageDueFilters = {},
  client?: PoolClient,
): Promise<CertificateStageDueRow[]> {
  if (!isValidCalendarDate(businessDate)) return [];
  const stageList = stages.filter((s) => Number.isInteger(s) && s > 0);
  if (stageList.length === 0) return [];

  const conditions = [
    `c.status = 'active'`,
    `a.alert_id IS NULL`,
    `(c.valid_until - $1::date) <= s.stage_days`,
    `c.valid_until >= $1::date`,
  ];
  const values: (string | number | number[])[] = [businessDate, stageList];
  let idx = 3;
  if (filters.instrument_record_id) {
    if (!UUID_REGEX.test(filters.instrument_record_id)) return [];
    conditions.push(`c.instrument_record_id = $${idx++}`);
    values.push(filters.instrument_record_id);
  }
  if (filters.location_id) {
    if (!UUID_REGEX.test(filters.location_id)) return [];
    conditions.push(`r.location_id = $${idx++}`);
    values.push(filters.location_id);
  }

  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS_PREFIXED}, s.stage_days::int AS stage_days, r.location_id, r.asset_id,
            (c.valid_until - $1::date)::int AS days_remaining
       FROM instrument_calibration_certificate c
       JOIN instrument_register r ON r.instrument_record_id = c.instrument_record_id
       CROSS JOIN unnest($2::int[]) AS s(stage_days)
       LEFT JOIN instrument_calibration_alert a
         ON a.certificate_id = c.certificate_id AND a.stage_days = s.stage_days
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.valid_until ASC, s.stage_days ASC, c.certificate_id ASC`,
    values,
  );
  return result.rows as CertificateStageDueRow[];
}

export interface ExpiredCertificateRow extends CalibrationCertificateRow {
  location_id: string;
  asset_id: string;
  instrument_record_id: string;
}

/**
 * The Expiry Flip Contract's scan input: active certificates whose validity has run out at
 * business_date. A re-run on a later business_date finds nothing, because the applier has already
 * moved each one out of 'active'.
 */
export async function listCertificatesExpiredAt(
  businessDate: string,
  filters: CertificateStageDueFilters = {},
  client?: PoolClient,
): Promise<ExpiredCertificateRow[]> {
  if (!isValidCalendarDate(businessDate)) return [];
  const conditions = [`c.status = 'active'`, `c.valid_until < $1::date`];
  const values: (string | number)[] = [businessDate];
  let idx = 2;
  if (filters.instrument_record_id) {
    if (!UUID_REGEX.test(filters.instrument_record_id)) return [];
    conditions.push(`c.instrument_record_id = $${idx++}`);
    values.push(filters.instrument_record_id);
  }
  if (filters.location_id) {
    if (!UUID_REGEX.test(filters.location_id)) return [];
    conditions.push(`r.location_id = $${idx++}`);
    values.push(filters.location_id);
  }
  const result = await runner(client).query(
    `SELECT ${CERT_COLUMNS_PREFIXED}, r.location_id, r.asset_id
       FROM instrument_calibration_certificate c
       JOIN instrument_register r ON r.instrument_record_id = c.instrument_record_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.valid_until ASC, c.certificate_id ASC`,
    values,
  );
  return result.rows as ExpiredCertificateRow[];
}
