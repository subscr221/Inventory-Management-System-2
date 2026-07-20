import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Serial master read model (Story 2.3). serial_id is the internal UUID (and the serial_master event
 * stream_id); serial_number is the unique identifier for the serial. current_location_id
 * tracks where the serial is currently located. current_quantity tracks the quantity for this serial.
 * sku is used to link to the item_master.
 */

export interface SerialMaster {
  serial_id: string;
  serial_number: string;
  sku: string;
  current_location_id: string | null;
  current_location_code: string | null;
  current_quantity: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSerialInput {
  serial_number: string;
  sku: string;
  current_location_id: string | null;
  current_location_code: string | null;
  current_quantity: string;
}

export interface UpdateSerialPatch {
  current_location_id?: string | null;
  current_location_code?: string | null;
  current_quantity?: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const SERIAL_COLUMNS = `serial_id, serial_number, sku, current_location_id, current_location_code, current_quantity, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): SerialMaster {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    serial_id: row['serial_id'] as string,
    serial_number: row['serial_number'] as string,
    sku: row['sku'] as string,
    current_location_id: row['current_location_id'] as string | null,
    current_location_code: row['current_location_code'] as string | null,
    current_quantity: row['current_quantity'] as string,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Inserts a serial row and returns it. Participates in `client`'s transaction when given. */
export async function createSerial(input: CreateSerialInput, client?: PoolClient): Promise<SerialMaster> {
  const result = await runner(client).query(
    `INSERT INTO serial_master
       (serial_number, sku, current_location_id, current_location_code, current_quantity)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SERIAL_COLUMNS}`,
    [
      input.serial_number,
      input.sku,
      input.current_location_id,
      input.current_location_code,
      input.current_quantity,
    ],
  );
  return mapRow(result.rows[0]!);
}

/** Applies a serial receipt event: creates the serial. Must run on the SAME client/transaction as the domain event insert. */
export async function applySerialReceipt(input: { serial_number: string; sku: string; current_location_id: string | null; current_location_code: string | null; current_quantity: string }, client: PoolClient): Promise<SerialMaster> {
  const result = await client.query(
    `INSERT INTO serial_master (serial_number, sku, current_location_id, current_location_code, current_quantity)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SERIAL_COLUMNS}`,
    [input.serial_number, input.sku, input.current_location_id, input.current_location_code, input.current_quantity],
  );
  return mapRow(result.rows[0]!);
}

/** Applies a serial issue event: marks the serial as issued by setting location to NULL. Must run on the SAME client/transaction as the domain event insert. */
export async function applySerialIssue(serialNumber: string, sku: string, client: PoolClient): Promise<SerialMaster | null> {
  const result = await client.query(
    `UPDATE serial_master 
     SET current_location_id = NULL, current_location_code = NULL, updated_at = now() 
     WHERE serial_number = $1 AND sku = $2 
     RETURNING ${SERIAL_COLUMNS}`,
    [serialNumber, sku],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Applies a partial update by serial_number and sku and returns the updated row, or null when not found. */
export async function updateSerial(serialNumber: string, sku: string, patch: UpdateSerialPatch, client?: PoolClient): Promise<SerialMaster | null> {
  const sets: string[] = [];
  const values: unknown[] = [serialNumber, sku];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
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

/** Existence probe used by the central serial validation seam. */
export async function serialExistsByNumberAndSku(serialNumber: string, sku: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM serial_master WHERE serial_number = $1 AND sku = $2 LIMIT 1`, [serialNumber, sku]);
  return result.rows.length > 0;
}

/** Gets all serials for a given SKU. */
export async function getSerialsBySku(sku: string, client?: PoolClient): Promise<SerialMaster[]> {
  const result = await runner(client).query(`SELECT ${SERIAL_COLUMNS} FROM serial_master WHERE sku = $1`, [sku]);
  return result.rows.map(mapRow);
}