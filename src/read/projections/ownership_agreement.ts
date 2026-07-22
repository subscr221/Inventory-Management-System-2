import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Ownership agreement read model (Story 2.8). Derived from ownership.agreement_set domain events by
 * the applyOwnershipProjection compliance seam inside persistEvent. Grain is
 * (sku, location_id, stock_class) restricted to the supplier-owned classes ('consignment', 'vmi');
 * at most ONE ACTIVE agreement per grain is enforced by the partial unique index
 * uq_ownership_agreement_active, so the owner party for a consignment/vmi balance is always
 * resolvable from its grain. vmi_min_qty is the VMI agreement minimum (SKU-location configuration
 * owned by Story 2.8); referential owner-party validation against ERP inbound projections arrives
 * with Story 2.9 and the governed supplier registry with Epic 4 Story 4.1.
 */

export interface OwnershipAgreementRow {
  agreement_id: string;
  sku: string;
  location_id: string;
  stock_class: string;
  owner_party_code: string;
  vmi_min_qty: number | null;
  active: boolean;
  business_stream: string;
  set_by_actor_id: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const COLUMNS = `agreement_id, sku, location_id, stock_class, owner_party_code, vmi_min_qty,
       active, business_stream, set_by_actor_id, created_at, updated_at`;

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>): OwnershipAgreementRow {
  return {
    agreement_id: row['agreement_id'] as string,
    sku: row['sku'] as string,
    location_id: row['location_id'] as string,
    stock_class: row['stock_class'] as string,
    owner_party_code: row['owner_party_code'] as string,
    vmi_min_qty: row['vmi_min_qty'] === null ? null : Number(row['vmi_min_qty']),
    active: row['active'] as boolean,
    business_stream: row['business_stream'] as string,
    set_by_actor_id: (row['set_by_actor_id'] as string | null) ?? null,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

/**
 * The ACTIVE agreement for a grain, if any. Locks FOR UPDATE when requested so a concurrent VMI
 * check or receipt validation for the same grain serializes; forUpdate requires a transaction
 * client (locking on the shared pool would leak the lock past the statement).
 */
export async function getActiveAgreement(
  sku: string,
  locationId: string,
  stockClass: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<OwnershipAgreementRow | null> {
  if (forUpdate && !client) {
    throw new Error('getActiveAgreement with forUpdate requires a transaction client');
  }
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM ownership_agreement
     WHERE sku = $1 AND location_id = $2 AND stock_class = $3 AND active${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId, stockClass],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** The agreement row for a grain regardless of active flag (stable identity for config edits). */
export async function getAgreementByGrain(
  sku: string,
  locationId: string,
  stockClass: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<OwnershipAgreementRow | null> {
  if (forUpdate && !client) {
    throw new Error('getAgreementByGrain with forUpdate requires a transaction client');
  }
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM ownership_agreement
     WHERE sku = $1 AND location_id = $2 AND stock_class = $3
     ORDER BY active DESC, updated_at DESC
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [sku, locationId, stockClass],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export interface AgreementFilters {
  location_id?: string | null;
  location_any?: string[] | null;
  sku?: string | null;
  stock_class?: string | null;
  active?: boolean | null;
}

export async function listAgreements(filters: AgreementFilters, client?: PoolClient): Promise<OwnershipAgreementRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.location_id) {
    conditions.push(`location_id = $${i++}`);
    params.push(filters.location_id);
  }
  if (filters.location_any && filters.location_any.length > 0) {
    conditions.push(`location_id = ANY($${i++})`);
    params.push(filters.location_any);
  }
  if (filters.sku) {
    conditions.push(`sku = $${i++}`);
    params.push(filters.sku);
  }
  if (filters.stock_class) {
    conditions.push(`stock_class = $${i++}`);
    params.push(filters.stock_class);
  }
  if (filters.active !== undefined && filters.active !== null) {
    conditions.push(`active = $${i++}`);
    params.push(filters.active);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM ownership_agreement ${where} ORDER BY sku, location_id, stock_class`,
    params,
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface UpsertAgreementInput {
  agreement_id: string;
  sku: string;
  location_id: string;
  stock_class: string;
  owner_party_code?: string;
  /** null clears the minimum explicitly; undefined preserves the stored value (partial edit). */
  vmi_min_qty?: number | null;
  active?: boolean;
  business_stream: string;
  set_by_actor_id?: string | null;
}

/**
 * Upserts the agreement identified by agreement_id. Partial edits preserve omitted fields
 * (COALESCE against the stored row - Story 2.7 review lesson); an explicit null vmi_min_qty clears
 * the minimum. The partial unique index uq_ownership_agreement_active is the concurrency backstop
 * against two racing creates for the same active grain (loser raises 23505 and rolls back).
 */
export async function upsertAgreement(input: UpsertAgreementInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO ownership_agreement (
       agreement_id, sku, location_id, stock_class, owner_party_code, vmi_min_qty, active,
       business_stream, set_by_actor_id
     ) VALUES ($1, $2, $3, $4, $5, $6::numeric, COALESCE($7, true), $8, $9)
     ON CONFLICT (agreement_id)
     DO UPDATE SET owner_party_code = COALESCE(EXCLUDED.owner_party_code, ownership_agreement.owner_party_code),
                   vmi_min_qty = CASE WHEN $10 THEN EXCLUDED.vmi_min_qty ELSE ownership_agreement.vmi_min_qty END,
                   active = CASE WHEN $11 THEN EXCLUDED.active ELSE ownership_agreement.active END,
                   business_stream = EXCLUDED.business_stream,
                   set_by_actor_id = COALESCE(EXCLUDED.set_by_actor_id, ownership_agreement.set_by_actor_id),
                   updated_at = now()`,
    [
      input.agreement_id,
      input.sku,
      input.location_id,
      input.stock_class,
      input.owner_party_code ?? null,
      input.vmi_min_qty === undefined || input.vmi_min_qty === null ? null : String(input.vmi_min_qty),
      input.active ?? null,
      input.business_stream,
      input.set_by_actor_id ?? null,
      input.vmi_min_qty !== undefined,
      input.active !== undefined,
    ],
  );
}
