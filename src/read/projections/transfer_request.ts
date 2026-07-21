import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Transfer request read model (Story 2.5). Derived from domain_events by the
 * applyTransferRequestProjection compliance seam inside persistEvent.
 *
 * This file provides the query-side functions used by the API handlers and by
 * the compliance module itself (inside transactions). Grain is one row per
 * transfer_request_id; status tracks the lifecycle:
 *   pending_approval -> approved/rejected
 *   pending_shipment -> shipped -> received
 */

export interface TransferRequestRow {
  transfer_request_id: string;
  sku_id: string;
  quantity: number;
  from_location_id: string;
  to_location_id: string;
  lot_id: string | null;
  serial_ids: string[] | null;
  business_stream: string;
  notes: string | null;
  status: string;
  approver_actor_id: string | null;
  correlation_id: string;
  created_at: string;
  shipped_at: string | null;
  received_at: string | null;
}

export interface InsertTransferRequestInput {
  transfer_request_id: string;
  sku_id: string;
  quantity: number;
  from_location_id: string;
  to_location_id: string;
  lot_id: string | null;
  serial_ids: string[] | null;
  business_stream: string;
  notes: string | null;
  status: string;
  approver_actor_id: string | null;
  correlation_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

/** Get a single transfer request by ID. */
export async function getTransferRequestById(
  transferRequestId: string,
  client?: PoolClient,
): Promise<TransferRequestRow | null> {
  const result = await runner(client).query(
    `SELECT transfer_request_id, sku_id, quantity, from_location_id, to_location_id,
            lot_id, serial_ids, business_stream, notes, status, approver_actor_id,
            correlation_id, created_at, shipped_at, received_at
     FROM transfer_request
     WHERE transfer_request_id = $1`,
    [transferRequestId],
  );

  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/** List transfer requests with optional filters. */
export async function getTransferRequests(filters: {
  from_location_id?: string | null;
  to_location_id?: string | null;
  status?: string;
  sku_id?: string;
}): Promise<TransferRequestRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.from_location_id) {
    conditions.push(`from_location_id = $${paramIndex}`);
    params.push(filters.from_location_id);
    paramIndex++;
  }
  if (filters.to_location_id) {
    conditions.push(`to_location_id = $${paramIndex}`);
    params.push(filters.to_location_id);
    paramIndex++;
  }
  if (filters.status) {
    conditions.push(`status = $${paramIndex}`);
    params.push(filters.status);
    paramIndex++;
  }
  if (filters.sku_id) {
    conditions.push(`sku_id = $${paramIndex}`);
    params.push(filters.sku_id);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query(
    `SELECT transfer_request_id, sku_id, quantity, from_location_id, to_location_id,
            lot_id, serial_ids, business_stream, notes, status, approver_actor_id,
            correlation_id, created_at, shipped_at, received_at
     FROM transfer_request
     ${whereClause}
     ORDER BY created_at DESC`,
    params,
  );

  return result.rows.map(mapRow);
}

/** Insert a new transfer request row. Must be called inside a transaction with persistEvent. */
export async function insertTransferRequest(
  input: InsertTransferRequestInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO transfer_request (
      transfer_request_id, sku_id, quantity, from_location_id, to_location_id,
      lot_id, serial_ids, business_stream, notes, status, approver_actor_id, correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.transfer_request_id,
      input.sku_id,
      input.quantity,
      input.from_location_id,
      input.to_location_id,
      input.lot_id,
      input.serial_ids ? `{${input.serial_ids.map((s) => `"${s}"`).join(',')}}` : null,
      input.business_stream,
      input.notes,
      input.status,
      input.approver_actor_id,
      input.correlation_id,
    ],
  );
}

/** Update the status of a transfer request. Must be called inside a transaction. */
export async function updateTransferRequestStatus(
  transferRequestId: string,
  status: string,
  client: PoolClient,
): Promise<void> {
  const validStatuses = ['pending_approval', 'approved', 'rejected', 'pending_shipment', 'shipped', 'received'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid transfer request status: ${status}`);
  }

  const now = new Date().toISOString();
  let updateQuery: string;
  let params: unknown[];

  if (status === 'shipped') {
    updateQuery = `UPDATE transfer_request SET status = $1, shipped_at = $2 WHERE transfer_request_id = $3`;
    params = [status, now, transferRequestId];
  } else if (status === 'received') {
    updateQuery = `UPDATE transfer_request SET status = $1, received_at = $2 WHERE transfer_request_id = $3`;
    params = [status, now, transferRequestId];
  } else {
    updateQuery = `UPDATE transfer_request SET status = $1 WHERE transfer_request_id = $2`;
    params = [status, transferRequestId];
  }

  const result = await client.query(updateQuery, params);
  if (result.rowCount === 0) {
    throw new Error(`Transfer request "${transferRequestId}" not found`);
  }
}

/** Get all in-transit balances for a given SKU. */
export async function getInTransitBalances(sku: string): Promise<InTransitRow[]> {
  const result = await getPool().query(
    `SELECT sku_id, location_from, location_to, lot_id, quantity,
            transfer_request_id, correlation_id, ship_event_id, created_at
     FROM in_transit
     WHERE sku_id = $1
     ORDER BY created_at ASC`,
    [sku],
  );
  return result.rows.map(mapInTransitRow);
}

export interface InTransitRow {
  sku_id: string;
  location_from: string;
  location_to: string;
  lot_id: string | null;
  quantity: number;
  transfer_request_id: string;
  correlation_id: string | null;
  ship_event_id: string | null;
  created_at: string;
}

function mapInTransitRow(row: Record<string, unknown>): InTransitRow {
  return {
    sku_id: row['sku_id'] as string,
    location_from: row['location_from'] as string,
    location_to: row['location_to'] as string,
    lot_id: (row['lot_id'] as string) ?? null,
    quantity: Number(row['quantity']),
    transfer_request_id: row['transfer_request_id'] as string,
    correlation_id: (row['correlation_id'] as string) ?? null,
    ship_event_id: (row['ship_event_id'] as string) ?? null,
    created_at:
      row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
  };
}

function mapRow(row: Record<string, unknown>): TransferRequestRow {
  const updatedAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    transfer_request_id: row['transfer_request_id'] as string,
    sku_id: row['sku_id'] as string,
    quantity: Number(row['quantity']),
    from_location_id: row['from_location_id'] as string,
    to_location_id: row['to_location_id'] as string,
    lot_id: (row['lot_id'] as string) ?? null,
    serial_ids: row['serial_ids'] as string[] | null,
    business_stream: row['business_stream'] as string,
    notes: (row['notes'] as string) ?? null,
    status: row['status'] as string,
    approver_actor_id: (row['approver_actor_id'] as string) ?? null,
    correlation_id: row['correlation_id'] as string,
    created_at: updatedAt,
    shipped_at: row['shipped_at'] ? (row['shipped_at'] instanceof Date ? row['shipped_at'].toISOString() : String(row['shipped_at'])) : null,
    received_at: row['received_at'] ? (row['received_at'] instanceof Date ? row['received_at'].toISOString() : String(row['received_at'])) : null,
  };
}