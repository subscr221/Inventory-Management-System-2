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

/**
 * Story 2.4: the ONLY value standard_cost_designation may carry. Standard cost is accepted
 * purely as an Ind AS 2 paragraph 21 measurement technique layered on top of the item's real
 * valuation_method (fifo/weighted_average/specific_identification) - never as a fourth method.
 */
export const STANDARD_COST_DESIGNATION = 'ind_as_2_para_21_measurement_technique' as const;

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
  standard_cost_designation: string | null;
  standard_cost_amount: number | null;
  variance_review_cadence: string | null;
  variance_tolerance_percent: number | null;
  count_variance_tolerance_percent: number | null;
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
  standard_cost_designation?: string | null;
  standard_cost_amount?: number | null;
  variance_review_cadence?: string | null;
  variance_tolerance_percent?: number | null;
  count_variance_tolerance_percent?: number | null;
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
  standard_cost_designation?: string | null;
  standard_cost_amount?: number | null;
  variance_review_cadence?: string | null;
  variance_tolerance_percent?: number | null;
  count_variance_tolerance_percent?: number | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const ITEM_COLUMNS = `item_id, sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required,
       bis_licence_required, valuation_method, business_stream, status,
       standard_cost_designation, standard_cost_amount, variance_review_cadence, variance_tolerance_percent,
       count_variance_tolerance_percent, created_at, updated_at`;

// node-postgres returns NUMERIC as a string to avoid precision loss; convert to a JS number (or
// null) at the projection boundary so callers get the numeric contract the API layer expects.
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

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
    standard_cost_designation: (row['standard_cost_designation'] as string | null) ?? null,
    standard_cost_amount: toNumberOrNull(row['standard_cost_amount']),
    variance_review_cadence: (row['variance_review_cadence'] as string | null) ?? null,
    variance_tolerance_percent: toNumberOrNull(row['variance_tolerance_percent']),
    count_variance_tolerance_percent: toNumberOrNull(row['count_variance_tolerance_percent']),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/** Inserts an item row and returns it. Participates in `client`'s transaction when given. */
export async function createItem(input: CreateItemInput, client?: PoolClient): Promise<ItemMaster> {
  const result = await runner(client).query(
      `INSERT INTO item_master
       (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required,
        valuation_method, business_stream, status,
        standard_cost_designation, standard_cost_amount, variance_review_cadence, variance_tolerance_percent,
        count_variance_tolerance_percent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      input.standard_cost_designation ?? null,
      input.standard_cost_amount ?? null,
      input.variance_review_cadence ?? null,
      input.variance_tolerance_percent ?? null,
      input.count_variance_tolerance_percent ?? null,
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
  if (patch.standard_cost_designation !== undefined) push('standard_cost_designation', patch.standard_cost_designation);
  if (patch.standard_cost_amount !== undefined) push('standard_cost_amount', patch.standard_cost_amount);
  if (patch.variance_review_cadence !== undefined) push('variance_review_cadence', patch.variance_review_cadence);
  if (patch.variance_tolerance_percent !== undefined) push('variance_tolerance_percent', patch.variance_tolerance_percent);
  if (patch.count_variance_tolerance_percent !== undefined) push('count_variance_tolerance_percent', patch.count_variance_tolerance_percent);
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
