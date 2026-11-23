import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface RdPrototypeRow {
  prototype_id: string;
  build_id: string;
  project_code: string;
  sku: string;
  serial_number: string;
  lot_id: string;
  location_id: string;
  stock_class: 'prototype';
  built_quantity: string;
  uom: string;
  status: 'registered' | 'disposed';
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;
function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export async function getRdPrototypeById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<RdPrototypeRow | null> {
  const result = await runner(client).query(
    `SELECT * FROM rd_prototype WHERE prototype_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return (result.rows[0] as RdPrototypeRow | undefined) ?? null;
}

export async function listRdPrototypes(
  projectCode?: string,
  client?: PoolClient,
): Promise<RdPrototypeRow[]> {
  const result = await runner(client).query(
    `SELECT * FROM rd_prototype WHERE ($1::text IS NULL OR project_code = $1) ORDER BY created_at DESC, prototype_id`,
    [projectCode ?? null],
  );
  return result.rows as RdPrototypeRow[];
}

export async function insertRdPrototype(
  row: Omit<RdPrototypeRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_prototype (prototype_id, build_id, project_code, sku, serial_number, lot_id, location_id, stock_class, built_quantity, uom, status, source_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.prototype_id,
      row.build_id,
      row.project_code,
      row.sku,
      row.serial_number,
      row.lot_id,
      row.location_id,
      row.stock_class,
      row.built_quantity,
      row.uom,
      row.status,
      row.source_event_id,
    ],
  );
}

export async function setRdPrototypeDisposed(id: string, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE rd_prototype SET status = 'disposed', updated_at = now() WHERE prototype_id = $1`,
    [id],
  );
}

export async function getLocationCode(
  locationId: string,
  client: PoolClient,
): Promise<string | null> {
  const result = await client.query(
    'SELECT location_code FROM location_register WHERE location_id = $1',
    [locationId],
  );
  return (result.rows[0]?.location_code as string | undefined) ?? null;
}
