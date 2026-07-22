import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * GRN header projection accessor (Story 3.4). The header row grains a receiving record against a
 * single binding token (correlation_id, the Story 3.2/3.3 accepted-weighment chain) and its open PO.
 * business_date is read through to_char(...,'YYYY-MM-DD') so a DATE never round-trips through a JS
 * Date. Rows are append-only with soft status transitions (open -> posted); no hard delete.
 */
export interface Grn {
  grn_id: string;
  correlation_id: string;
  po_ref_ext: string;
  source_document: 'PO' | 'ASN';
  source_ref_ext: string | null;
  site_id: string;
  site_code_ext: string;
  status: 'open' | 'posted';
  received_by: string;
  business_date: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertGrnHeaderInput {
  grn_id: string;
  correlation_id: string;
  po_ref_ext: string;
  source_document: 'PO' | 'ASN';
  source_ref_ext?: string | null;
  site_id: string;
  site_code_ext: string;
  status?: 'open' | 'posted';
  received_by: string;
  business_date: string;
  source_event_id: string;
}

export interface ListGrnsFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  poRefExt?: string | null;
  status?: 'open' | 'posted' | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const GRN_COLUMNS = `grn_id, correlation_id, po_ref_ext, source_document, source_ref_ext, site_id,
       site_code_ext, status, received_by, to_char(business_date, 'YYYY-MM-DD') AS business_date,
       source_event_id, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): Grn {
  return {
    grn_id: row['grn_id'] as string,
    correlation_id: row['correlation_id'] as string,
    po_ref_ext: row['po_ref_ext'] as string,
    source_document: row['source_document'] as Grn['source_document'],
    source_ref_ext: (row['source_ref_ext'] as string | null) ?? null,
    site_id: row['site_id'] as string,
    site_code_ext: row['site_code_ext'] as string,
    status: row['status'] as Grn['status'],
    received_by: row['received_by'] as string,
    business_date: row['business_date'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getGrnById(grnId: string, client?: PoolClient): Promise<Grn | null> {
  const result = await runner(client).query(`SELECT ${GRN_COLUMNS} FROM grn WHERE grn_id = $1`, [grnId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listGrns(filters: ListGrnsFilters = {}, client?: PoolClient): Promise<Grn[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.poRefExt) add('po_ref_ext = ?', filters.poRefExt);
  if (filters.status) add('status = ?', filters.status);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(`SELECT ${GRN_COLUMNS} FROM grn ${where} ORDER BY created_at DESC`, values);
  return result.rows.map(mapRow);
}

/** Idempotent, replay-safe upsert keyed on grn_id (client-supplied UUID keeps replay idempotent). */
export async function insertGrnHeader(input: InsertGrnHeaderInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO grn
       (grn_id, correlation_id, po_ref_ext, source_document, source_ref_ext, site_id, site_code_ext,
        status, received_by, business_date, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (grn_id) DO UPDATE SET
       correlation_id = EXCLUDED.correlation_id,
       po_ref_ext = EXCLUDED.po_ref_ext,
       source_document = EXCLUDED.source_document,
       source_ref_ext = EXCLUDED.source_ref_ext,
       site_id = EXCLUDED.site_id,
       site_code_ext = EXCLUDED.site_code_ext,
       status = EXCLUDED.status,
       received_by = EXCLUDED.received_by,
       business_date = EXCLUDED.business_date,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.grn_id,
      input.correlation_id,
      input.po_ref_ext,
      input.source_document,
      input.source_ref_ext ?? null,
      input.site_id,
      input.site_code_ext,
      input.status ?? 'open',
      input.received_by,
      input.business_date,
      input.source_event_id,
    ],
  );
}
