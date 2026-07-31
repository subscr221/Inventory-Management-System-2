import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Forward-pick replenishment configuration accessor (Story 3.9). One row per (sku, zone_id) grain.
 * site_id is denormalized from the zone at write time, never accepted from a client - see
 * src/compliance/replenishment.ts, the only writer. min_qty/max_qty are read as NUMERIC strings,
 * never coerced to a JS number, matching the codebase-wide convention for balance/threshold math.
 */
export interface ForwardPickConfig {
  config_id: string;
  sku: string;
  zone_id: string;
  site_id: string;
  min_qty: string;
  max_qty: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertForwardPickConfigInput {
  sku: string;
  zone_id: string;
  site_id: string;
  min_qty: string;
  max_qty: string;
  updated_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export const FORWARD_PICK_CONFIG_COLUMNS = `config_id, sku, zone_id, site_id, min_qty::text AS min_qty,
       max_qty::text AS max_qty, updated_by, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ForwardPickConfig {
  return {
    config_id: row['config_id'] as string,
    sku: row['sku'] as string,
    zone_id: row['zone_id'] as string,
    site_id: row['site_id'] as string,
    min_qty: String(row['min_qty']),
    max_qty: String(row['max_qty']),
    updated_by: row['updated_by'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export async function getForwardPickConfig(
  sku: string,
  zoneId: string,
  client?: PoolClient,
): Promise<ForwardPickConfig | null> {
  const result = await runner(client).query(
    `SELECT ${FORWARD_PICK_CONFIG_COLUMNS} FROM forward_pick_config WHERE sku = $1 AND zone_id = $2`,
    [sku, zoneId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Lock variant for the replenishment job's read-decide-persist cycle (Task 5.4). */
export async function getForwardPickConfigForUpdate(
  sku: string,
  zoneId: string,
  client: PoolClient,
): Promise<ForwardPickConfig | null> {
  const result = await client.query(
    `SELECT ${FORWARD_PICK_CONFIG_COLUMNS} FROM forward_pick_config WHERE sku = $1 AND zone_id = $2 FOR UPDATE`,
    [sku, zoneId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listForwardPickConfigs(
  filters: { siteId?: string | null; zoneId?: string | null; sku?: string | null } = {},
  client?: PoolClient,
): Promise<ForwardPickConfig[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.zoneId) add('zone_id = ?', filters.zoneId);
  if (filters.sku) add('sku = ?', filters.sku);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${FORWARD_PICK_CONFIG_COLUMNS} FROM forward_pick_config ${where} ORDER BY sku, zone_id`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Idempotent upsert on the (sku, zone_id) grain. min_qty/max_qty are bound as NUMERIC strings. */
export async function upsertForwardPickConfig(
  input: UpsertForwardPickConfigInput,
  client: PoolClient,
): Promise<ForwardPickConfig> {
  const result = await client.query(
    `INSERT INTO forward_pick_config (sku, zone_id, site_id, min_qty, max_qty, updated_by)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)
     ON CONFLICT (sku, zone_id) DO UPDATE SET
       min_qty = EXCLUDED.min_qty,
       max_qty = EXCLUDED.max_qty,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING ${FORWARD_PICK_CONFIG_COLUMNS}`,
    [input.sku, input.zone_id, input.site_id, input.min_qty, input.max_qty, input.updated_by],
  );
  return mapRow(result.rows[0]!);
}
