import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface PackingRecord {
  packing_record_id: string;
  dispatch_order_id: string;
  sku: string;
  packed_qty: string;
  lot_id: string | null;
  actual_weight_kg: string | null;
  label_ref: string | null;
  carton_count: number;
  status: 'packed' | 'documents_generated' | 'dispatched';
  packed_by: string;
  packed_at: string;
  updated_at: string;
}

export interface CreatePackingRecordInput {
  packing_record_id: string;
  dispatch_order_id: string;
  sku: string;
  packed_qty: number | string;
  lot_id: string;
  actual_weight_kg?: number | string | null;
  label_ref?: string | null;
  carton_count: number;
  packed_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `packing_record_id, dispatch_order_id, sku, packed_qty, lot_id,
       actual_weight_kg, label_ref, carton_count, status,
       packed_by, packed_at, updated_at`;

function mapRow(row: Record<string, unknown>): PackingRecord {
  return {
    packing_record_id: row['packing_record_id'] as string,
    dispatch_order_id: row['dispatch_order_id'] as string,
    sku: row['sku'] as string,
    packed_qty: String(row['packed_qty']),
    lot_id: (row['lot_id'] as string) ?? null,
    actual_weight_kg: row['actual_weight_kg'] !== null ? String(row['actual_weight_kg']) : null,
    label_ref: (row['label_ref'] as string) ?? null,
    carton_count: Number(row['carton_count']),
    status: row['status'] as PackingRecord['status'],
    packed_by: row['packed_by'] as string,
    packed_at: row['packed_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

export async function createPackingRecord(
  input: CreatePackingRecordInput,
  client?: PoolClient,
): Promise<PackingRecord> {
  const result = await runner(client).query(
    `INSERT INTO packing_record
       (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id,
        actual_weight_kg, label_ref, carton_count, packed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.packing_record_id,
      input.dispatch_order_id,
      input.sku,
      String(input.packed_qty),
      input.lot_id,
      input.actual_weight_kg != null ? String(input.actual_weight_kg) : null,
      input.label_ref ?? null,
      input.carton_count,
      input.packed_by,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function updatePackingRecordStatus(
  packingRecordId: string,
  status: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(
    `UPDATE packing_record SET status = $2, updated_at = now()
     WHERE packing_record_id = $1`,
    [packingRecordId, status],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function updatePackingRecordsStatusByDispatchOrder(
  dispatchOrderId: string,
  status: string,
  client?: PoolClient,
): Promise<number> {
  const result = await runner(client).query(
    `UPDATE packing_record SET status = $2, updated_at = now()
     WHERE dispatch_order_id = $1`,
    [dispatchOrderId, status],
  );
  return result.rowCount ?? 0;
}

export async function listPackingRecordsByDispatchOrder(
  dispatchOrderId: string,
  client?: PoolClient,
): Promise<PackingRecord[]> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM packing_record
     WHERE dispatch_order_id = $1
     ORDER BY packed_at ASC`,
    [dispatchOrderId],
  );
  return result.rows.map(mapRow);
}

export async function getPackingRecordById(
  packingRecordId: string,
  client?: PoolClient,
): Promise<PackingRecord | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM packing_record WHERE packing_record_id = $1`,
    [packingRecordId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}
