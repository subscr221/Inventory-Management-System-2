import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Lot trace auxiliary table (Story 2.3). This table captures every transaction touching a lot
 * for fast recall traces. Columns: lot_id, event_id, event_type, sku, location_id, quantity_change,
 * business_stream, timestamp.
 */

export interface LotTrace {
  trace_id: string;
  lot_id: string;
  event_id: string;
  event_type: string;
  sku: string;
  location_id: string | null;
  location_code: string | null;
  quantity_change: string;
  business_stream: string;
  timestamp: string;
}

export interface CreateLotTraceInput {
  lot_id: string;
  event_id: string;
  event_type: string;
  sku: string;
  location_id: string | null;
  location_code: string | null;
  quantity_change: string;
  business_stream: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const TRACE_COLUMNS = `trace_id, lot_id, event_id, event_type, sku, location_id, location_code, quantity_change, business_stream, timestamp`;

function mapRow(row: Record<string, unknown>): LotTrace {
  const timestamp = row['timestamp'] instanceof Date ? row['timestamp'].toISOString() : String(row['timestamp']);
  return {
    trace_id: row['trace_id'] as string,
    lot_id: row['lot_id'] as string,
    event_id: row['event_id'] as string,
    event_type: row['event_type'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string | null,
    location_code: row['location_code'] as string | null,
    quantity_change: row['quantity_change'] as string,
    business_stream: row['business_stream'] as string,
    timestamp,
  };
}

/** Appends a trace entry for a lot. Participates in `client`'s transaction when given. */
export async function appendTraceEntry(input: CreateLotTraceInput, client?: PoolClient): Promise<LotTrace> {
  const result = await runner(client).query(
    `INSERT INTO lot_trace
       (lot_id, event_id, event_type, sku, location_id, location_code, quantity_change, business_stream)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${TRACE_COLUMNS}`,
    [
      input.lot_id,
      input.event_id,
      input.event_type,
      input.sku,
      input.location_id,
      input.location_code,
      input.quantity_change,
      input.business_stream,
    ],
  );
  return mapRow(result.rows[0]!);
}

/** Gets the trace for a lot, ordered by timestamp. */
export async function getTraceForLot(lotId: string, client?: PoolClient): Promise<LotTrace[]> {
  const result = await runner(client).query(
    `SELECT ${TRACE_COLUMNS} 
     FROM lot_trace 
     WHERE lot_id = $1 
     ORDER BY timestamp ASC`,
    [lotId],
  );
  return result.rows.map(mapRow);
}

/** Checks if a trace entry already exists for an event to prevent duplicates. */
export async function traceEntryExists(eventId: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM lot_trace WHERE event_id = $1 LIMIT 1`, [eventId]);
  return result.rows.length > 0;
}