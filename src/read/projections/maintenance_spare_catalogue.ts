import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.4 accessors for the maintenance spare catalogue table (FR-M-07, FR-M-09). */
export interface MaintenanceSpareCatalogueRow {
  catalogue_id: string;
  sku: string;
  location_id: string;
  is_critical: boolean;
  /** NUMERIC(18,6) rendered as a string so a six-decimal level never loses precision in JS. */
  min_level: string | null;
  max_level: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATALOGUE_COLUMNS = `catalogue_id, sku, location_id, is_critical,
    min_level::text AS min_level,
    max_level::text AS max_level,
    created_by, created_at, updated_at`;

export async function getSpareCatalogueById(
  catalogueId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceSpareCatalogueRow | null> {
  if (!UUID_REGEX.test(catalogueId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${CATALOGUE_COLUMNS} FROM maintenance_spare_catalogue WHERE catalogue_id = $1${lockClause}`,
    [catalogueId],
  );
  return (result.rows[0] as MaintenanceSpareCatalogueRow) ?? null;
}

/**
 * The catalogue row for one (sku, location_id) grain - the reservation precondition lookup. `sku`
 * is compared as given; every caller canonicalizes with lower() before reaching here, in the
 * handler AND in the seam, so the direct-event path cannot bypass the canonicalization.
 */
export async function getSpareCatalogueByGrain(
  sku: string,
  locationId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceSpareCatalogueRow | null> {
  if (!UUID_REGEX.test(locationId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${CATALOGUE_COLUMNS} FROM maintenance_spare_catalogue
      WHERE sku = $1 AND location_id = $2${lockClause}`,
    [sku, locationId],
  );
  return (result.rows[0] as MaintenanceSpareCatalogueRow) ?? null;
}

export interface InsertSpareCatalogueRow {
  catalogue_id: string;
  sku: string;
  location_id: string;
  is_critical: boolean;
  min_level: string | null;
  max_level: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertSpareCatalogue(
  row: InsertSpareCatalogueRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_spare_catalogue (
      catalogue_id, sku, location_id, is_critical, min_level, max_level,
      created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9)`,
    [
      row.catalogue_id,
      row.sku,
      row.location_id,
      row.is_critical,
      row.min_level,
      row.max_level,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

export interface ListSpareCatalogueParams {
  sku?: string | undefined;
  location_id?: string | undefined;
  is_critical?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSpareCatalogue(
  params: ListSpareCatalogueParams,
  client?: PoolClient,
): Promise<MaintenanceSpareCatalogueRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number | boolean)[] = [];
  let idx = 1;

  if (params.sku) {
    conditions.push(`sku = $${idx++}`);
    values.push(params.sku);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.is_critical !== undefined) {
    conditions.push(`is_critical = $${idx++}`);
    values.push(params.is_critical);
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${CATALOGUE_COLUMNS} FROM maintenance_spare_catalogue ${where}
      ORDER BY sku ASC, location_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceSpareCatalogueRow[];
}

/**
 * The FR-M-09 breach-scan scope, narrowed in SQL rather than by a JS filter after the fact so the
 * job's counters describe exactly what was evaluated (the Story 7.2 lesson). Only critical rows
 * with a configured minimum are watchable; chk_maintenance_spare_catalogue_critical_needs_min
 * makes the second predicate redundant at the database level, and it is kept here so a future
 * relaxation of that CHECK cannot silently widen the scan.
 */
export interface SpareBreachScanScope {
  location_id?: string | null | undefined;
  sku?: string | null | undefined;
}

export async function listCriticalSpareGrains(
  scope: SpareBreachScanScope,
  client?: PoolClient,
): Promise<MaintenanceSpareCatalogueRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT ${CATALOGUE_COLUMNS} FROM maintenance_spare_catalogue
      WHERE is_critical = true AND min_level IS NOT NULL
        AND ($1::uuid IS NULL OR location_id = $1::uuid)
        AND ($2::text IS NULL OR sku = $2::text)
      ORDER BY sku ASC, location_id ASC`,
    [scope.location_id ?? null, scope.sku ?? null],
  );
  return result.rows as MaintenanceSpareCatalogueRow[];
}
