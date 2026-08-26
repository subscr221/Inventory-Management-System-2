import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.6 accessors for the statutory examination register (FR-M-14, AD-9).
 *
 * The grain is (asset_id, examination_type): one asset carries at most one OSH Code examination and
 * at most one weighbridge legal-metrology stamp. The weighbridge device_id (free text on
 * weighbridge_event) is mapped via device_key, canonicalized with lower() to match
 * uq_statutory_examination_device_key - the Story 7.5 instrument-id precedent: a case variant of a
 * registered device key is the same physical weighbridge.
 *
 * DATE and NUMERIC columns are rendered as strings out of pg (to_char for dates, ::text for
 * numerics) so every accessor hands the caller exact decimal strings and YYYY-MM-DD dates, never a
 * JS Date or float that would round a cost or shift a due date.
 */
export interface StatutoryExaminationRow {
  examination_id: string;
  asset_id: string;
  examination_type: 'osh_code' | 'weighbridge_legal_metrology';
  interval_months: number;
  next_due_date: string;
  status: 'compliant' | 'overdue';
  device_key: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const EXAMINATION_TYPES = new Set(['osh_code', 'weighbridge_legal_metrology']);
const EXAMINATION_STATUSES = new Set(['compliant', 'overdue']);
// OFFSET is a bigint in PostgreSQL. A floor of 0 alone lets `?offset=99999999999999999999` through
// as a value outside that range, which raises 22003 and 500s the read endpoint; cap it here so a
// silly page request returns an empty page instead.
const MAX_OFFSET = 1_000_000_000;

const EXAMINATION_COLUMNS = `examination_id, asset_id, examination_type, interval_months,
    to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, status, device_key, created_at, updated_at`;

export interface InsertStatutoryExaminationRow {
  examination_id: string;
  asset_id: string;
  examination_type: 'osh_code' | 'weighbridge_legal_metrology';
  interval_months: number;
  next_due_date: string;
  device_key: string | null;
  status?: 'compliant' | 'overdue';
}

export async function insertStatutoryExamination(
  row: InsertStatutoryExaminationRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO statutory_examination (
      examination_id, asset_id, examination_type, interval_months, next_due_date, status, device_key
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.examination_id,
      row.asset_id,
      row.examination_type,
      row.interval_months,
      row.next_due_date,
      row.status ?? 'compliant',
      row.device_key,
    ],
  );
}

export async function updateStatutoryExamination(
  examinationId: string,
  fields: {
    examination_type: 'osh_code' | 'weighbridge_legal_metrology';
    interval_months: number;
    next_due_date: string;
    status: 'compliant' | 'overdue';
    device_key: string | null;
  },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE statutory_examination
        SET examination_type = $2,
            interval_months = $3,
            next_due_date = $4,
            status = $5,
            device_key = $6,
            updated_at = now()
      WHERE examination_id = $1`,
    [
      examinationId,
      fields.examination_type,
      fields.interval_months,
      fields.next_due_date,
      fields.status,
      fields.device_key,
    ],
  );
}

export async function setStatutoryExaminationStatus(
  examinationId: string,
  status: 'compliant' | 'overdue',
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE statutory_examination
        SET status = $2, updated_at = now()
      WHERE examination_id = $1
      RETURNING examination_id`,
    [examinationId, status],
  );
  return result.rows.length > 0;
}

export async function getExaminationById(
  examinationId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<StatutoryExaminationRow | null> {
  if (!UUID_REGEX.test(examinationId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${EXAMINATION_COLUMNS} FROM statutory_examination WHERE examination_id = $1${lockClause}`,
    [examinationId],
  );
  return (result.rows[0] as StatutoryExaminationRow) ?? null;
}

export async function getExaminationByAssetAndType(
  assetId: string,
  examinationType: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<StatutoryExaminationRow | null> {
  if (!UUID_REGEX.test(assetId) || !EXAMINATION_TYPES.has(examinationType)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${EXAMINATION_COLUMNS} FROM statutory_examination
      WHERE asset_id = $1 AND examination_type = $2${lockClause}`,
    [assetId, examinationType],
  );
  return (result.rows[0] as StatutoryExaminationRow) ?? null;
}

/**
 * Case-insensitive to match uq_statutory_examination_device_key (lower(device_key)): a case variant
 * of a registered device key is the same physical weighbridge. This is the lookup
 * assertWeighbridgeStampLockout uses to resolve payload.device_id against the register.
 */
export async function getExaminationByDeviceKey(
  deviceKey: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<StatutoryExaminationRow | null> {
  if (typeof deviceKey !== 'string' || deviceKey.trim() === '') return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${EXAMINATION_COLUMNS} FROM statutory_examination
      WHERE lower(device_key) = lower($1)${lockClause}`,
    [deviceKey],
  );
  return (result.rows[0] as StatutoryExaminationRow) ?? null;
}

export interface ListExaminationsParams {
  asset_id?: string | undefined;
  status?: 'compliant' | 'overdue' | undefined;
  examination_type?: 'osh_code' | 'weighbridge_legal_metrology' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listExaminations(
  params: ListExaminationsParams,
  client?: PoolClient,
): Promise<StatutoryExaminationRow[]> {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.asset_id) {
    if (!UUID_REGEX.test(params.asset_id)) return [];
    conditions.push(`asset_id = $${idx++}`);
    values.push(params.asset_id);
  }
  if (params.status) {
    if (!EXAMINATION_STATUSES.has(params.status)) return [];
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.examination_type) {
    if (!EXAMINATION_TYPES.has(params.examination_type)) return [];
    conditions.push(`examination_type = $${idx++}`);
    values.push(params.examination_type);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.min(Math.max(Math.trunc(params.offset ?? 0), 0), MAX_OFFSET)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${EXAMINATION_COLUMNS} FROM statutory_examination ${where}
      ORDER BY next_due_date ASC, examination_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as StatutoryExaminationRow[];
}

/** The overdue scan's scope: compliant examinations whose next_due_date has passed business_date. */
export async function listOverdueExaminationsDue(
  businessDate: string,
  client?: PoolClient,
  assetId?: string,
): Promise<StatutoryExaminationRow[]> {
  // Guarded like every sibling accessor in this file. The route validates its own input, but this
  // function is exported and its parameters bind straight into a DATE cast and a uuid column, so an
  // unguarded value from any other caller is an unmapped 22007/22P02 500 rather than an empty list.
  if (!ISO_DATE_REGEX.test(businessDate)) return [];
  if (assetId !== undefined && !UUID_REGEX.test(assetId)) return [];
  const assetFilter = assetId ? ' AND asset_id = $2' : '';
  const values: string[] = assetId ? [businessDate, assetId] : [businessDate];
  const result = await runner(client).query(
    `SELECT ${EXAMINATION_COLUMNS} FROM statutory_examination
      WHERE status = 'compliant' AND next_due_date < $1::date${assetFilter}
      ORDER BY next_due_date ASC, examination_id ASC`,
    values,
  );
  return result.rows as StatutoryExaminationRow[];
}
