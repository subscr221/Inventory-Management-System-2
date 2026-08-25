import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.5 accessors for the calibration escalation register (FR-M-13, AC 3, AD-8).
 *
 * Nothing in this module reads or writes instrument_calibration_statuses. An escalation expedites
 * re-calibration and never bypasses the lockout, and the cheapest way to guarantee that is to give
 * the escalation path no status write surface at all.
 */
export type EscalationStatus = 'open' | 'resolved';

export interface CalibrationEscalationRow {
  escalation_id: string;
  instrument_record_id: string;
  instrument_id: string;
  doa_entry_id: string;
  routed_approver_user_id: string;
  reason: string | null;
  status: EscalationStatus;
  raised_by: string;
  raised_at: string;
  resolved_at: string | null;
  resolving_certificate_id: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESCALATION_STATUSES = new Set(['open', 'resolved']);

const ESCALATION_COLUMNS = `escalation_id, instrument_record_id, instrument_id, doa_entry_id,
    routed_approver_user_id, reason, status, raised_by, raised_at, resolved_at,
    resolving_certificate_id, created_at, updated_at`;

export async function getEscalationById(
  escalationId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CalibrationEscalationRow | null> {
  if (!UUID_REGEX.test(escalationId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${ESCALATION_COLUMNS} FROM instrument_calibration_escalation WHERE escalation_id = $1${lockClause}`,
    [escalationId],
  );
  return (result.rows[0] as CalibrationEscalationRow) ?? null;
}

/**
 * The at-most-one open escalation per instrument, held under FOR UPDATE when the caller is about
 * to raise or auto-resolve. uq_instrument_calibration_escalation_open is the backstop behind this
 * read (the Story 7.1 one-record lesson), not a substitute for it.
 */
export async function getOpenEscalation(
  instrumentRecordId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<CalibrationEscalationRow | null> {
  if (!UUID_REGEX.test(instrumentRecordId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${ESCALATION_COLUMNS} FROM instrument_calibration_escalation
      WHERE instrument_record_id = $1 AND status = 'open'${lockClause}`,
    [instrumentRecordId],
  );
  return (result.rows[0] as CalibrationEscalationRow) ?? null;
}

export interface InsertCalibrationEscalationRow {
  escalation_id: string;
  instrument_record_id: string;
  instrument_id: string;
  doa_entry_id: string;
  routed_approver_user_id: string;
  reason: string | null;
  raised_by: string;
  raised_at: string;
}

export async function insertEscalation(
  row: InsertCalibrationEscalationRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO instrument_calibration_escalation (
      escalation_id, instrument_record_id, instrument_id, doa_entry_id, routed_approver_user_id,
      reason, status, raised_by, raised_at
    ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8)`,
    [
      row.escalation_id,
      row.instrument_record_id,
      row.instrument_id,
      row.doa_entry_id,
      row.routed_approver_user_id,
      row.reason,
      row.raised_by,
      row.raised_at,
    ],
  );
}

/**
 * Closes one open escalation against the certificate that re-calibrated the instrument. Returns
 * false when the escalation was no longer open, so the caller rejects the transition rather than
 * silently no-opping on a state it should reject (the Story 7.2 Group 2 decision).
 */
export async function resolveEscalation(
  escalationId: string,
  resolvingCertificateId: string,
  resolvedAt: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE instrument_calibration_escalation
        SET status = 'resolved', resolving_certificate_id = $2, resolved_at = $3, updated_at = now()
      WHERE escalation_id = $1 AND status = 'open'`,
    [escalationId, resolvingCertificateId, resolvedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ListCalibrationEscalationsParams {
  instrument_record_id?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listEscalations(
  params: ListCalibrationEscalationsParams,
  client?: PoolClient,
): Promise<CalibrationEscalationRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.instrument_record_id) {
    if (!UUID_REGEX.test(params.instrument_record_id)) return [];
    conditions.push(`instrument_record_id = $${idx++}`);
    values.push(params.instrument_record_id);
  }
  if (params.status) {
    if (!ESCALATION_STATUSES.has(params.status)) return [];
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
  const result = await runner(client).query(
    `SELECT ${ESCALATION_COLUMNS} FROM instrument_calibration_escalation ${where}
      ORDER BY raised_at DESC, escalation_id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as CalibrationEscalationRow[];
}
