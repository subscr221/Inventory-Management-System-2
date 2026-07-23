import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface GateEvent {
  gate_event_id: string;
  site_id: string;
  site_code_ext: string;
  po_ref_ext: string | null;
  binding_status: 'matched' | 'unmatched';
  vehicle_reg_ext: string;
  driver_name: string | null;
  challan_number_ext: string | null;
  challan_photo_ref: string;
  gate_id: string;
  gate_officer_id: string;
  correlation_id: string;
  entered_at: string;
  business_date: string;
  status: 'open' | 'reversed';
  reversal_reason: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertGateEventInput {
  gate_event_id: string;
  site_id: string;
  site_code_ext: string;
  po_ref_ext: string | null;
  binding_status: 'matched' | 'unmatched';
  vehicle_reg_ext: string;
  driver_name?: string | null;
  challan_number_ext?: string | null;
  challan_photo_ref: string;
  gate_id: string;
  gate_officer_id: string;
  correlation_id: string;
  entered_at: string;
  business_date: string;
  source_event_id: string;
}

export interface ListGateEventsFilters {
  siteId?: string | null;
  siteAny?: string[] | null;
  status?: 'open' | 'reversed' | null;
  bindingStatus?: 'matched' | 'unmatched' | null;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
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

const GATE_EVENT_COLUMNS = `gate_event_id, site_id, site_code_ext, po_ref_ext, binding_status,
       vehicle_reg_ext, driver_name, challan_number_ext, challan_photo_ref, gate_id,
       gate_officer_id, correlation_id, entered_at, to_char(business_date, 'YYYY-MM-DD') AS business_date,
       status, reversal_reason, source_event_id, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): GateEvent {
  return {
    gate_event_id: row['gate_event_id'] as string,
    site_id: row['site_id'] as string,
    site_code_ext: row['site_code_ext'] as string,
    po_ref_ext: (row['po_ref_ext'] as string | null) ?? null,
    binding_status: row['binding_status'] as GateEvent['binding_status'],
    vehicle_reg_ext: row['vehicle_reg_ext'] as string,
    driver_name: (row['driver_name'] as string | null) ?? null,
    challan_number_ext: (row['challan_number_ext'] as string | null) ?? null,
    challan_photo_ref: row['challan_photo_ref'] as string,
    gate_id: row['gate_id'] as string,
    gate_officer_id: row['gate_officer_id'] as string,
    correlation_id: row['correlation_id'] as string,
    entered_at: ts(row['entered_at']),
    business_date: row['business_date'] as string,
    status: row['status'] as GateEvent['status'],
    reversal_reason: (row['reversal_reason'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getGateEventById(gateEventId: string, client?: PoolClient): Promise<GateEvent | null> {
  const result = await runner(client).query(
    `SELECT ${GATE_EVENT_COLUMNS} FROM gate_event WHERE gate_event_id = $1`,
    [gateEventId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

// Review D1 (Story 3.2): resolve a previously accepted online create by its client-supplied
// Idempotency-Key so a retried POST replays the original gate event instead of duplicating it.
export async function getGateEventByIdempotencyKey(idempotencyKey: string, client?: PoolClient): Promise<GateEvent | null> {
  const evt = await runner(client).query(
    `SELECT payload->>'gate_event_id' AS gate_event_id FROM domain_events WHERE idempotency_key = $1 AND event_type = 'gate.entered' LIMIT 1`,
    [idempotencyKey],
  );
  if (evt.rows.length === 0) return null;
  return getGateEventById(evt.rows[0]!['gate_event_id'] as string, client);
}

export async function listGateEvents(filters: ListGateEventsFilters = {}, client?: PoolClient): Promise<GateEvent[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.siteAny !== undefined && filters.siteAny !== null) add('site_id = ANY(?::uuid[])', filters.siteAny);
  if (filters.status) add('status = ?', filters.status);
  if (filters.bindingStatus) add('binding_status = ?', filters.bindingStatus);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 200), 1), 500);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const dir = filters.order === 'asc' ? 'ASC' : 'DESC';
  const result = await runner(client).query(
    `SELECT ${GATE_EVENT_COLUMNS} FROM gate_event ${where} ORDER BY entered_at ${dir}, created_at ${dir} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  return result.rows.map(mapRow);
}

export async function upsertGateEvent(input: UpsertGateEventInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO gate_event
       (gate_event_id, site_id, site_code_ext, po_ref_ext, binding_status, vehicle_reg_ext,
        driver_name, challan_number_ext, challan_photo_ref, gate_id, gate_officer_id,
        correlation_id, entered_at, business_date, status, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'open', $15)
     ON CONFLICT (gate_event_id) DO UPDATE SET
       site_id = EXCLUDED.site_id,
       site_code_ext = EXCLUDED.site_code_ext,
       po_ref_ext = EXCLUDED.po_ref_ext,
       binding_status = EXCLUDED.binding_status,
       vehicle_reg_ext = EXCLUDED.vehicle_reg_ext,
       driver_name = EXCLUDED.driver_name,
       challan_number_ext = EXCLUDED.challan_number_ext,
       challan_photo_ref = EXCLUDED.challan_photo_ref,
       gate_id = EXCLUDED.gate_id,
       gate_officer_id = EXCLUDED.gate_officer_id,
       correlation_id = EXCLUDED.correlation_id,
       entered_at = EXCLUDED.entered_at,
       business_date = EXCLUDED.business_date,
       source_event_id = EXCLUDED.source_event_id,
       updated_at = now()`,
    [
      input.gate_event_id,
      input.site_id,
      input.site_code_ext,
      input.po_ref_ext,
      input.binding_status,
      input.vehicle_reg_ext,
      input.driver_name ?? null,
      input.challan_number_ext ?? null,
      input.challan_photo_ref,
      input.gate_id,
      input.gate_officer_id,
      input.correlation_id,
      input.entered_at,
      input.business_date,
      input.source_event_id,
    ],
  );
}

export async function markGateEventReversed(gateEventId: string, reversalReason: string, client: PoolClient): Promise<GateEvent | null> {
  const result = await client.query(
    `UPDATE gate_event
        SET status = 'reversed', reversal_reason = $2, updated_at = now()
      WHERE gate_event_id = $1
      RETURNING ${GATE_EVENT_COLUMNS}`,
    [gateEventId, reversalReason],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}
