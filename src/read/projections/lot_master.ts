import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export const QUALITY_HOLD_STATUSES = ['none', 'held'] as const;
export type QualityHoldStatus = (typeof QUALITY_HOLD_STATUSES)[number];

export interface LotMaster {
  lot_id: string;
  lot_number: string;
  sku: string;
  expiry_date: string | null;
  quality_hold_status: QualityHoldStatus;
  quality_hold_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateLotInput {
  lot_number: string;
  sku: string;
  expiry_date: string | null;
  quality_hold_status: QualityHoldStatus;
  quality_hold_reason: string | null;
}

export interface UpdateLotPatch {
  expiry_date?: string | null;
  quality_hold_status?: QualityHoldStatus;
  quality_hold_reason?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function localDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const LOT_COLUMNS = `lot_id, lot_number, sku, expiry_date, quality_hold_status, quality_hold_reason, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): LotMaster {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  let expiryDate: string | null = null;
  if (row['expiry_date'] instanceof Date) {
    expiryDate = localDateString(row['expiry_date']);
  } else if (typeof row['expiry_date'] === 'string') {
    expiryDate = row['expiry_date'];
  }
  return {
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    sku: row['sku'] as string,
    expiry_date: expiryDate,
    quality_hold_status: row['quality_hold_status'] as QualityHoldStatus,
    quality_hold_reason: row['quality_hold_reason'] as string | null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export async function createLot(input: CreateLotInput, client?: PoolClient): Promise<LotMaster> {
  const result = await runner(client).query(
    `INSERT INTO lot_master
       (lot_number, sku, expiry_date, quality_hold_status, quality_hold_reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${LOT_COLUMNS}`,
    [
      input.lot_number,
      input.sku,
      input.expiry_date,
      input.quality_hold_status,
      input.quality_hold_reason,
    ],
  );
  return mapRow(result.rows[0]!);
}

/**
 * INSERT ... ON CONFLICT (lot_number) DO NOTHING RETURNING makes lot creation atomic: two
 * concurrent stock.received events for the same brand-new lot_number can no longer both pass a
 * check-then-insert race and surface inconsistent error shapes depending on who wins (Story 2.3
 * re-review) - the loser simply gets null here and the caller throws the same controlled
 * DUPLICATE_LOT error it would for a lot that already existed before this call started.
 */
export async function applyLotEvent(input: { lot_number: string; sku: string; expiry_date: string | null }, client: PoolClient): Promise<LotMaster | null> {
  const result = await client.query(
    `INSERT INTO lot_master (lot_number, sku, expiry_date, quality_hold_status, quality_hold_reason)
     VALUES ($1, $2, $3, 'none', NULL)
     ON CONFLICT (lot_number) DO NOTHING
     RETURNING ${LOT_COLUMNS}`,
    [input.lot_number, input.sku, input.expiry_date],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function updateLot(lotNumber: string, sku: string, patch: UpdateLotPatch, client?: PoolClient): Promise<LotMaster | null> {
  const sets: string[] = [];
  const values: unknown[] = [lotNumber, sku];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.expiry_date !== undefined) push('expiry_date', patch.expiry_date);
  if (patch.quality_hold_status !== undefined) push('quality_hold_status', patch.quality_hold_status);
  if (patch.quality_hold_reason !== undefined) push('quality_hold_reason', patch.quality_hold_reason);
  if (sets.length === 0) return getLotByNumberAndSku(lotNumber, sku, client);

  const result = await runner(client).query(
    `UPDATE lot_master SET ${sets.join(', ')}, updated_at = now() WHERE lot_number = $1 AND sku = $2 RETURNING ${LOT_COLUMNS}`,
    values,
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function placeQualityHold(lotNumber: string, sku: string, reason: string, client?: PoolClient): Promise<LotMaster | null> {
  const result = await runner(client).query(
    `UPDATE lot_master
     SET quality_hold_status = 'held', quality_hold_reason = $3, updated_at = now()
     WHERE lot_number = $1 AND sku = $2
     RETURNING ${LOT_COLUMNS}`,
    [lotNumber, sku, reason],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function clearQualityHold(lotNumber: string, sku: string, client?: PoolClient): Promise<LotMaster | null> {
  const result = await runner(client).query(
    `UPDATE lot_master
     SET quality_hold_status = 'none', quality_hold_reason = NULL, updated_at = now()
     WHERE lot_number = $1 AND sku = $2
     RETURNING ${LOT_COLUMNS}`,
    [lotNumber, sku],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getLotByNumberAndSku(lotNumber: string, sku: string, client?: PoolClient): Promise<LotMaster | null> {
  const result = await runner(client).query(`SELECT ${LOT_COLUMNS} FROM lot_master WHERE lot_number = $1 AND sku = $2`, [lotNumber, sku]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getLotById(lotId: string, client?: PoolClient): Promise<LotMaster | null> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(lotId)) {
    const result = await runner(client).query(`SELECT ${LOT_COLUMNS} FROM lot_master WHERE lot_id = $1`, [lotId]);
    return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
  }

  const result = await runner(client).query(`SELECT ${LOT_COLUMNS} FROM lot_master WHERE lot_number = $1`, [lotId]);
  return result.rows.length === 1 ? mapRow(result.rows[0]!) : null;
}

export async function lotExistsByNumberAndSku(lotNumber: string, sku: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM lot_master WHERE lot_number = $1 AND sku = $2 LIMIT 1`, [lotNumber, sku]);
  return result.rows.length > 0;
}

export async function getLotsForSelection(sku: string, client?: PoolClient, includeUnavailable = false): Promise<LotMaster[]> {
  const result = await runner(client).query(
    `SELECT ${LOT_COLUMNS}
     FROM lot_master
     WHERE sku = $1${includeUnavailable ? '' : " AND quality_hold_status = 'none' AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)"}
     ORDER BY expiry_date ASC NULLS LAST, created_at ASC, lot_id ASC`,
    [sku],
  );
  return result.rows.map(mapRow);
}

export async function getLotsForFifoSelection(sku: string, client?: PoolClient, includeUnavailable = false): Promise<LotMaster[]> {
  const result = await runner(client).query(
    `SELECT ${LOT_COLUMNS}
     FROM lot_master
     WHERE sku = $1${includeUnavailable ? '' : " AND quality_hold_status = 'none' AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)"}
     ORDER BY created_at ASC, lot_id ASC`,
    [sku],
  );
  return result.rows.map(mapRow);
}
