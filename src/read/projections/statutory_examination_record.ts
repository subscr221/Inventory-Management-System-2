import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 7.6 accessors for the statutory examination record history (FR-M-14). Each row is one
 * examination event against a statutory_examination register row; the register carries the CURRENT
 * compliance state while this table keeps the immutable evidence history.
 *
 * DATE columns are rendered as strings out of pg (to_char) so every accessor hands the caller
 * exact YYYY-MM-DD dates, never a JS Date.
 */
export interface StatutoryExaminationRecordRow {
  record_id: string;
  examination_id: string;
  examined_on: string;
  next_due_date: string;
  certificate_number_ext: string | null;
  examined_by: string | null;
  examined_at: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECORD_COLUMNS = `record_id, examination_id,
    to_char(examined_on, 'YYYY-MM-DD') AS examined_on,
    to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
    certificate_number_ext, examined_by, examined_at, created_at`;

export interface InsertStatutoryExaminationRecordRow {
  record_id: string;
  examination_id: string;
  examined_on: string;
  next_due_date: string;
  certificate_number_ext: string | null;
  examined_by: string;
  examined_at: string;
}

export async function insertStatutoryExaminationRecord(
  row: InsertStatutoryExaminationRecordRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO statutory_examination_record (
      record_id, examination_id, examined_on, next_due_date, certificate_number_ext, examined_by, examined_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.record_id,
      row.examination_id,
      row.examined_on,
      row.next_due_date,
      row.certificate_number_ext,
      row.examined_by,
      row.examined_at,
    ],
  );
}

export async function getRecordById(
  recordId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<StatutoryExaminationRecordRow | null> {
  if (!UUID_REGEX.test(recordId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${RECORD_COLUMNS} FROM statutory_examination_record WHERE record_id = $1${lockClause}`,
    [recordId],
  );
  return (result.rows[0] as StatutoryExaminationRecordRow) ?? null;
}

/** The record history for one examination, newest first (the detail route's second half). */
export async function listRecordsByExamination(
  examinationId: string,
  client?: PoolClient,
): Promise<StatutoryExaminationRecordRow[]> {
  if (!UUID_REGEX.test(examinationId)) return [];
  const result = await runner(client).query(
    `SELECT ${RECORD_COLUMNS} FROM statutory_examination_record
      WHERE examination_id = $1
      ORDER BY examined_at DESC, record_id ASC`,
    [examinationId],
  );
  return result.rows as StatutoryExaminationRecordRow[];
}

/**
 * Case-insensitive to match uq_statutory_examination_record_number (examination_id,
 * lower(certificate_number_ext)): the 23505 race resolver re-reads the winner so the race path
 * returns the SAME existing_record_id detail as a sequential duplicate.
 */
export async function getRecordByCertificateNumber(
  examinationId: string,
  certificateNumberExt: string,
  client?: PoolClient,
): Promise<StatutoryExaminationRecordRow | null> {
  if (!UUID_REGEX.test(examinationId) || certificateNumberExt.trim() === '') return null;
  const result = await runner(client).query(
    `SELECT ${RECORD_COLUMNS} FROM statutory_examination_record
      WHERE examination_id = $1 AND lower(certificate_number_ext) = lower($2)
      LIMIT 1`,
    [examinationId, certificateNumberExt],
  );
  return (result.rows[0] as StatutoryExaminationRecordRow) ?? null;
}
