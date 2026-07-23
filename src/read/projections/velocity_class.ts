import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Velocity class projection (Story 3.5) tracking putaway frequency-based ABC classification. */
export interface VelocityClass {
  sku: string;
  site_id: string;
  velocity_class: 'A' | 'B' | 'C';
  putaway_count_30d: number;
  override_count_30d: number;
  preferred_location_id: string | null;
  preferred_location_code: string | null;
  computed_at: string;
  source_event_id: string | null;
}

export interface UpsertVelocityClassInput {
  sku: string;
  site_id: string;
  velocity_class: 'A' | 'B' | 'C';
  putaway_count_30d: number;
  override_count_30d: number;
  preferred_location_id?: string | null;
  preferred_location_code?: string | null;
  source_event_id?: string | null;
}

export interface ListVelocityClassesFilters {
  siteId?: string | null;
  velocityClass?: 'A' | 'B' | 'C' | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const VELOCITY_CLASS_COLUMNS = `sku, site_id, velocity_class, putaway_count_30d, override_count_30d,
       preferred_location_id, preferred_location_code, computed_at, source_event_id`;

function mapRow(row: Record<string, unknown>): VelocityClass {
  return {
    sku: row['sku'] as string,
    site_id: row['site_id'] as string,
    velocity_class: row['velocity_class'] as 'A' | 'B' | 'C',
    putaway_count_30d: Number(row['putaway_count_30d']),
    override_count_30d: Number(row['override_count_30d']),
    preferred_location_id: (row['preferred_location_id'] as string | null) ?? null,
    preferred_location_code: (row['preferred_location_code'] as string | null) ?? null,
    computed_at: ts(row['computed_at']),
    source_event_id: (row['source_event_id'] as string | null) ?? null,
  };
}

export async function getVelocityClass(sku: string, siteId: string, client?: PoolClient): Promise<VelocityClass | null> {
  const result = await runner(client).query(
    `SELECT ${VELOCITY_CLASS_COLUMNS} FROM velocity_class WHERE sku = $1 AND site_id = $2`,
    [sku, siteId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function listVelocityClasses(
  filters: ListVelocityClassesFilters = {},
  client?: PoolClient,
): Promise<VelocityClass[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.siteId) add('site_id = ?', filters.siteId);
  if (filters.velocityClass) add('velocity_class = ?', filters.velocityClass);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await runner(client).query(`SELECT ${VELOCITY_CLASS_COLUMNS} FROM velocity_class ${where} ORDER BY sku`, values);
  return result.rows.map(mapRow);
}

/** Idempotent upsert keyed on (sku, site_id). */
export async function upsertVelocityClass(input: UpsertVelocityClassInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO velocity_class
       (sku, site_id, velocity_class, putaway_count_30d, override_count_30d,
        preferred_location_id, preferred_location_code, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (sku, site_id) DO UPDATE SET
       velocity_class = EXCLUDED.velocity_class,
       putaway_count_30d = EXCLUDED.putaway_count_30d,
       override_count_30d = EXCLUDED.override_count_30d,
       preferred_location_id = EXCLUDED.preferred_location_id,
       preferred_location_code = EXCLUDED.preferred_location_code,
       source_event_id = EXCLUDED.source_event_id,
       computed_at = now()`,
    [
      input.sku,
      input.site_id,
      input.velocity_class,
      input.putaway_count_30d,
      input.override_count_30d,
      input.preferred_location_id ?? null,
      input.preferred_location_code ?? null,
      input.source_event_id ?? null,
    ],
  );
}
