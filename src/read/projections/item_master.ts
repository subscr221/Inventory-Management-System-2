import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Item master read model (Story 2.1). item_id is the internal UUID (and the item_master event
 * stream_id); sku is the unique API-facing identifier. LIFO is deliberately not an accepted
 * valuation method (Ind AS 2 prohibits it); business_stream values are validated by the caller
 * against the Story 1.5 business_streams vocabulary, never re-declared here.
 */

export const ALLOWED_VALUATION_METHODS = ['fifo', 'weighted_average', 'specific_identification'] as const;
export type ValuationMethod = (typeof ALLOWED_VALUATION_METHODS)[number];

export const ITEM_STATUSES = ['active', 'inactive'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface ItemMaster {
  item_id: string;
  sku: string;
  uom: string;
  lot_controlled: boolean;
  serial_controlled: boolean;
  hazmat: boolean;
  quarantine_required: boolean;
  bis_licence_required: boolean;
  valuation_method: ValuationMethod;
  business_stream: string;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateItemInput {
  sku: string;
  uom: string;
  lot_controlled: boolean;
  serial_controlled: boolean;
  hazmat: boolean;
  quarantine_required: boolean;
  bis_licence_required: boolean;
  valuation_method: ValuationMethod;
  business_stream: string;
  status: ItemStatus;
}

export interface UpdateItemPatch {
  uom?: string;
  lot_controlled?: boolean;
  serial_controlled?: boolean;
  hazmat?: boolean;
  quarantine_required?: boolean;
  bis_licence_required?: boolean;
  valuation_method?: ValuationMethod;
  business_stream?: string;
  status?: ItemStatus;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const ITEM_COLUMNS = `item_id, sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required,
       bis_licence_required, valuation_method, business_stream, status, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ItemMaster {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    item_id: row['item_id'] as string,
    sku: row['sku'] as string,
    uom: row['uom'] as string,
    lot_controlled: row['lot_controlled'] as boolean,
    serial_controlled: row['serial_controlled'] as boolean,
    hazmat: row['hazmat'] as boolean,
    quarantine_required: row['quarantine_required'] as boolean,
    bis_licence_required: row['bis_licence_required'] as boolean,
    valuation_method: row['valuation_method'] as ValuationMethod,
    business_stream: row['business_stream'] as string,
    status: row['status'] as ItemStatus,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Inserts an item row and returns it. Participates in `client`'s transaction when given. */
export async function createItem(input: CreateItemInput, client?: PoolClient): Promise<ItemMaster> {
  const result = await runner(client).query(
    `INSERT INTO item_master
       (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required,
        valuation_method, business_stream, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${ITEM_COLUMNS}`,
    [
      input.sku,
      input.uom,
      input.lot_controlled,
      input.serial_controlled,
      input.hazmat,
      input.quarantine_required,
      input.bis_licence_required,
      input.valuation_method,
      input.business_stream,
      input.status,
    ],
  );
  return mapRow(result.rows[0]!);
}

/** Applies a partial update by SKU and returns the updated row, or null when the SKU is unknown. */
export async function updateItem(sku: string, patch: UpdateItemPatch, client?: PoolClient): Promise<ItemMaster | null> {
  const sets: string[] = [];
  const values: unknown[] = [sku];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.uom !== undefined) push('uom', patch.uom);
  if (patch.lot_controlled !== undefined) push('lot_controlled', patch.lot_controlled);
  if (patch.serial_controlled !== undefined) push('serial_controlled', patch.serial_controlled);
  if (patch.hazmat !== undefined) push('hazmat', patch.hazmat);
  if (patch.quarantine_required !== undefined) push('quarantine_required', patch.quarantine_required);
  if (patch.bis_licence_required !== undefined) push('bis_licence_required', patch.bis_licence_required);
  if (patch.valuation_method !== undefined) push('valuation_method', patch.valuation_method);
  if (patch.business_stream !== undefined) push('business_stream', patch.business_stream);
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return getItemBySku(sku, client);

  const result = await runner(client).query(
    `UPDATE item_master SET ${sets.join(', ')}, updated_at = now() WHERE sku = $1 RETURNING ${ITEM_COLUMNS}`,
    values,
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getItemBySku(sku: string, client?: PoolClient): Promise<ItemMaster | null> {
  const result = await runner(client).query(`SELECT ${ITEM_COLUMNS} FROM item_master WHERE sku = $1`, [sku]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getItemById(itemId: string, client?: PoolClient): Promise<ItemMaster | null> {
  const result = await runner(client).query(`SELECT ${ITEM_COLUMNS} FROM item_master WHERE item_id = $1`, [itemId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Existence probe used by the central inventory-master validation seam. */
export async function itemExistsBySku(sku: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM item_master WHERE sku = $1 LIMIT 1`, [sku]);
  return result.rows.length > 0;
}
