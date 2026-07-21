import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface SerialMaster {
  serial_id: string;
  serial_number: string;
  sku: string;
  lot_id: string | null;
  current_location_id: string | null;
  current_location_code: string | null;
  current_quantity: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSerialInput {
  serial_number: string;
  sku: string;
  lot_id?: string | null;
  current_location_id: string | null;
  current_location_code: string | null;
  current_quantity: string;
}

export interface UpdateSerialPatch {
  lot_id?: string | null;
  current_location_id?: string | null;
  current_location_code?: string | null;
  current_quantity?: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const SERIAL_COLUMNS = `serial_id, serial_number, sku, lot_id, current_location_id, current_location_code, current_quantity, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): SerialMaster {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    serial_id: row['serial_id'] as string,
    serial_number: row['serial_number'] as string,
    sku: row['sku'] as string,
    lot_id: (row['lot_id'] as string | null) ?? null,
    current_location_id: row['current_location_id'] as string | null,
    current_location_code: row['current_location_code'] as string | null,
    current_quantity: row['current_quantity'] as string,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export async function createSerial(input: CreateSerialInput, client?: PoolClient): Promise<SerialMaster> {
  const result = await runner(client).query(
    `INSERT INTO serial_master
       (serial_number, sku, lot_id, current_location_id, current_location_code, current_quantity)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SERIAL_COLUMNS}`,
    [
      input.serial_number,
      input.sku,
      input.lot_id ?? null,
      input.current_location_id,
      input.current_location_code,
      input.current_quantity,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function applySerialReceipt(input: { serial_number: string; sku: string; lot_id?: string | null; current_location_id: string | null; current_location_code: string | null; current_quantity: string }, client: PoolClient): Promise<SerialMaster> {
  const result = await client.query(
    `INSERT INTO serial_master (serial_number, sku, lot_id, current_location_id, current_location_code, current_quantity)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SERIAL_COLUMNS}`,
    [input.serial_number, input.sku, input.lot_id ?? null, input.current_location_id, input.current_location_code, input.current_quantity],
  );
  return mapRow(result.rows[0]!);
}

export async function applySerialIssue(serialNumber: string, sku: string, locationId: string | null, lotId: string | null, client: PoolClient): Promise<SerialMaster | null> {
  const result = await client.query(
    `UPDATE serial_master
     SET current_location_id = NULL, current_location_code = NULL, current_quantity = 0, updated_at = now()
     WHERE serial_number = $1
       AND sku = $2
       AND current_location_id IS NOT NULL
       AND ($3::uuid IS NULL OR current_location_id = $3)
       AND ($4::text IS NULL OR lot_id = $4)
     RETURNING ${SERIAL_COLUMNS}`,
    [serialNumber, sku, locationId, lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function updateSerial(serialNumber: string, sku: string, patch: UpdateSerialPatch, client?: PoolClient): Promise<SerialMaster | null> {
  const sets: string[] = [];
  const values: unknown[] = [serialNumber, sku];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.lot_id !== undefined) push('lot_id', patch.lot_id);
  if (patch.current_location_id !== undefined) push('current_location_id', patch.current_location_id);
  if (patch.current_location_code !== undefined) push('current_location_code', patch.current_location_code);
  if (patch.current_quantity !== undefined) push('current_quantity', patch.current_quantity);
  if (sets.length === 0) return getSerialByNumberAndSku(serialNumber, sku, client);

  const result = await runner(client).query(
    `UPDATE serial_master SET ${sets.join(', ')}, updated_at = now() WHERE serial_number = $1 AND sku = $2 RETURNING ${SERIAL_COLUMNS}`,
    values,
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getSerialByNumberAndSku(serialNumber: string, sku: string, client?: PoolClient): Promise<SerialMaster | null> {
  const result = await runner(client).query(`SELECT ${SERIAL_COLUMNS} FROM serial_master WHERE serial_number = $1 AND sku = $2`, [serialNumber, sku]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getSerialById(serialId: string, client?: PoolClient): Promise<SerialMaster | null> {
  const result = await runner(client).query(`SELECT ${SERIAL_COLUMNS} FROM serial_master WHERE serial_id = $1`, [serialId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function serialExistsByNumberAndSku(serialNumber: string, sku: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM serial_master WHERE serial_number = $1 AND sku = $2 LIMIT 1`, [serialNumber, sku]);
  return result.rows.length > 0;
}

export async function getSerialsBySku(sku: string, client?: PoolClient): Promise<SerialMaster[]> {
  const result = await runner(client).query(`SELECT ${SERIAL_COLUMNS} FROM serial_master WHERE sku = $1`, [sku]);
  return result.rows.map(mapRow);
}
