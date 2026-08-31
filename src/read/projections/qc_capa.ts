import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.5 accessor for the qc_capa projection (FR-Q-10, AC 3 and AC 4). A CAPA is a first-class
 * record with its own open -> closed lifecycle (Binding Scope Decision 11); AC 3's "linked to a
 * CAPA record" is a validated reference to a row here.
 *
 * closeQcCapa is the ONLY update path and is guarded by `WHERE status = 'open'`: a concurrent
 * second close updates zero rows, which the caller turns into 409 CAPA_NOT_OPEN. There is no
 * reopen.
 */

export const QC_CAPA_STATUSES = ['open', 'closed'] as const;
export type QcCapaStatus = (typeof QC_CAPA_STATUSES)[number];

export interface QcCapaRow {
  capa_id: string;
  capa_number: string;
  sku: string;
  defect_code: string;
  title: string;
  root_cause: string | null;
  corrective_action: string | null;
  preventive_action: string | null;
  owner_user_id: string;
  due_on: string;
  status: QcCapaStatus;
  opened_by: string;
  opened_at: string;
  closed_by: string | null;
  closed_at: string | null;
  closure_evidence: string | null;
  source_event_id: string;
  close_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InsertQcCapaRow = Pick<
  QcCapaRow,
  | 'capa_id'
  | 'capa_number'
  | 'sku'
  | 'defect_code'
  | 'title'
  | 'root_cause'
  | 'corrective_action'
  | 'preventive_action'
  | 'owner_user_id'
  | 'due_on'
  | 'opened_by'
  | 'opened_at'
  | 'source_event_id'
>;

export interface QcCapaClosePatch {
  capa_id: string;
  closed_by: string;
  closed_at: string;
  closure_evidence: string;
  close_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAPA_COLUMNS = `capa_id, capa_number, sku, defect_code, title, root_cause,
    corrective_action, preventive_action, owner_user_id, due_on::text AS due_on, status,
    opened_by, opened_at, closed_by, closed_at, closure_evidence, source_event_id,
    close_event_id, created_at, updated_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): QcCapaRow {
  return {
    capa_id: row['capa_id'] as string,
    capa_number: row['capa_number'] as string,
    sku: row['sku'] as string,
    defect_code: row['defect_code'] as string,
    title: row['title'] as string,
    root_cause: (row['root_cause'] as string | null) ?? null,
    corrective_action: (row['corrective_action'] as string | null) ?? null,
    preventive_action: (row['preventive_action'] as string | null) ?? null,
    owner_user_id: row['owner_user_id'] as string,
    due_on: String(row['due_on']),
    status: row['status'] as QcCapaStatus,
    opened_by: row['opened_by'] as string,
    opened_at: toIso(row['opened_at']),
    closed_by: (row['closed_by'] as string | null) ?? null,
    closed_at: toIsoOrNull(row['closed_at']),
    closure_evidence: (row['closure_evidence'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    close_event_id: (row['close_event_id'] as string | null) ?? null,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

/** Server-minted CAPA number (the allocateProductionOrderNumber pattern). */
export async function allocateQcCapaNumber(year: number, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT nextval('qc_capa_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `CAPA-${year}-${n.padStart(4, '0')}`;
}

export async function insertQcCapa(row: InsertQcCapaRow, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO qc_capa (capa_id, capa_number, sku, defect_code, title, root_cause,
       corrective_action, preventive_action, owner_user_id, due_on, status, opened_by, opened_at,
       source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12, $13)`,
    [
      row.capa_id,
      row.capa_number,
      row.sku,
      row.defect_code,
      row.title,
      row.root_cause,
      row.corrective_action,
      row.preventive_action,
      row.owner_user_id,
      row.due_on,
      row.opened_by,
      row.opened_at,
      row.source_event_id,
    ],
  );
}

export async function getQcCapaById(
  capaId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<QcCapaRow | null> {
  if (!UUID_REGEX.test(capaId)) return null;
  const result = await runner(client).query(
    `SELECT ${CAPA_COLUMNS} FROM qc_capa WHERE capa_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [capaId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export interface ListQcCapasParams {
  status?: QcCapaStatus | undefined;
  sku?: string | undefined;
  defect_code?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listQcCapas(
  params: ListQcCapasParams,
  client?: PoolClient,
): Promise<QcCapaRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.status !== undefined) {
    values.push(params.status);
    conditions.push(`status = $${values.length}`);
  }
  if (params.sku !== undefined) {
    values.push(params.sku);
    conditions.push(`sku = $${values.length}`);
  }
  if (params.defect_code !== undefined) {
    values.push(params.defect_code);
    conditions.push(`defect_code = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(
    Math.max(Number.isInteger(params.limit) ? (params.limit as number) : 50, 1),
    200,
  );
  const offset = Math.max(Number.isInteger(params.offset) ? (params.offset as number) : 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${CAPA_COLUMNS} FROM qc_capa ${where}
      ORDER BY opened_at DESC, capa_id
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The once-only open -> closed transition. Returns false when the CAPA was not open (zero rows
 * updated), which the caller reports as 409 CAPA_NOT_OPEN - the concurrency backstop, not a
 * convenience.
 */
export async function closeQcCapa(patch: QcCapaClosePatch, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `UPDATE qc_capa
        SET status = 'closed',
            closed_by = $2,
            closed_at = $3,
            closure_evidence = $4,
            close_event_id = $5,
            updated_at = now()
      WHERE capa_id = $1 AND status = 'open'`,
    [patch.capa_id, patch.closed_by, patch.closed_at, patch.closure_evidence, patch.close_event_id],
  );
  return (result.rowCount ?? 0) > 0;
}
