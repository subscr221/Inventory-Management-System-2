import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Weighbridge event projection accessor (Story 3.3). Weight columns are NUMERIC(12,3) and are read
 * as strings, never Number()'d or compared as JS floats (statutory sub-kg precision, e-way-bill join
 * key). business_date is read through to_char(...,'YYYY-MM-DD') so a DATE never round-trips through a
 * JS Date. correlation_id is the Story 3.2 binding token that ties this weighment to its gate event.
 */
export interface WeighbridgeEvent {
  weighbridge_event_id: string;
  correlation_id: string;
  gate_event_id: string;
  site_id: string;
  site_code_ext: string;
  po_ref_ext: string;
  line_no: number;
  tare_kg: string;
  gross_kg: string;
  net_kg: string;
  status: 'accepted' | 'tolerance_breach';
  tolerance_breach_reason: string | null;
  device_id: string;
  capture_method: 'AUTO' | 'MANUAL';
  weighed_by: string;
  business_date: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertWeighbridgeEventInput {
  weighbridge_event_id: string;
  correlation_id: string;
  gate_event_id: string;
  site_id: string;
  site_code_ext: string;
  po_ref_ext: string;
  line_no: number;
  tare_kg: string;
  gross_kg: string;
  net_kg: string;
  status: 'accepted' | 'tolerance_breach';
  tolerance_breach_reason?: string | null;
  device_id: string;
  capture_method: 'AUTO' | 'MANUAL';
  weighed_by: string;
  business_date: string;
  source_event_id: string;
}

export interface ListWeighbridgeEventsFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  status?: 'accepted' | 'tolerance_breach' | null;
  poRefExt?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function num(value: unknown): number {
  return Number(value);
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const WEIGHBRIDGE_EVENT_COLUMNS = `weighbridge_event_id, correlation_id, gate_event_id, site_id,
       site_code_ext, po_ref_ext, line_no, tare_kg, gross_kg, net_kg, status, tolerance_breach_reason,
       device_id, capture_method, weighed_by, to_char(business_date, 'YYYY-MM-DD') AS business_date,
       source_event_id, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): WeighbridgeEvent {
  return {
    weighbridge_event_id: row['weighbridge_event_id'] as string,
    correlation_id: row['correlation_id'] as string,
    gate_event_id: row['gate_event_id'] as string,
    site_id: row['site_id'] as string,
    site_code_ext: row['site_code_ext'] as string,
    po_ref_ext: row['po_ref_ext'] as string,
    line_no: num(row['line_no']),
    tare_kg: String(row['tare_kg']),
    gross_kg: String(row['gross_kg']),
    net_kg: String(row['net_kg']),
    status: row['status'] as WeighbridgeEvent['status'],
    tolerance_breach_reason: (row['tolerance_breach_reason'] as string | null) ?? null,
    device_id: row['device_id'] as string,
    capture_method: row['capture_method'] as WeighbridgeEvent['capture_method'],
    weighed_by: row['weighed_by'] as string,
    business_date: row['business_date'] as string,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getWeighbridgeEventById(id: string, client?: PoolClient): Promise<WeighbridgeEvent | null> {
  const result = await runner(client).query(
    `SELECT ${WEIGHBRIDGE_EVENT_COLUMNS} FROM weighbridge_event WHERE weighbridge_event_id = $1`,
    [id],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** All weighments recorded against a Story 3.2 binding token (joins the gate-event chain). */
export async function getWeighbridgeEventsByCorrelationId(correlationId: string, client?: PoolClient): Promise<WeighbridgeEvent[]> {
  const result = await runner(client).query(
    `SELECT ${WEIGHBRIDGE_EVENT_COLUMNS} FROM weighbridge_event
      WHERE correlation_id = $1
      ORDER BY created_at DESC`,
    [correlationId],
  );
  return result.rows.map(mapRow);
}

export async function listWeighbridgeEvents(filters: ListWeighbridgeEventsFilters = {}, client?: PoolClient): Promise<WeighbridgeEvent[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.status) add('status = ?', filters.status);
  if (filters.poRefExt) add('po_ref_ext = ?', filters.poRefExt);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${WEIGHBRIDGE_EVENT_COLUMNS} FROM weighbridge_event ${where} ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Idempotent, replay-safe upsert keyed on weighbridge_event_id. NUMERIC weights bound as strings. */
export async function upsertWeighbridgeEvent(input: UpsertWeighbridgeEventInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO weighbridge_event
       (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext,
        line_no, tare_kg, gross_kg, net_kg, status, tolerance_breach_reason, device_id,
        capture_method, weighed_by, business_date, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (weighbridge_event_id) DO UPDATE SET
       correlation_id = EXCLUDED.correlation_id,
       gate_event_id = EXCLUDED.gate_event_id,
       site_id = EXCLUDED.site_id,
       site_code_ext = EXCLUDED.site_code_ext,
       po_ref_ext = EXCLUDED.po_ref_ext,
       line_no = EXCLUDED.line_no,
       tare_kg = EXCLUDED.tare_kg,
       gross_kg = EXCLUDED.gross_kg,
       net_kg = EXCLUDED.net_kg,
       status = EXCLUDED.status,
       tolerance_breach_reason = EXCLUDED.tolerance_breach_reason,
       device_id = EXCLUDED.device_id,
       capture_method = EXCLUDED.capture_method,
       weighed_by = EXCLUDED.weighed_by,
       business_date = EXCLUDED.business_date,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.weighbridge_event_id,
      input.correlation_id,
      input.gate_event_id,
      input.site_id,
      input.site_code_ext,
      input.po_ref_ext,
      input.line_no,
      input.tare_kg,
      input.gross_kg,
      input.net_kg,
      input.status,
      input.tolerance_breach_reason ?? null,
      input.device_id,
      input.capture_method,
      input.weighed_by,
      input.business_date,
      input.source_event_id,
    ],
  );
}
