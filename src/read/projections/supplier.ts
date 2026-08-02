import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface SupplierRow {
  supplier_id: string;
  legal_name: string;
  owner_party_code: string;
  gstin_ext: string | null;
  pan_ext: string | null;
  contacts: Record<string, unknown>[];
  credit_period_days: number;
  commercial_terms: string | null;
  freight_terms: string | null;
  delivery_terms: string | null;
  certification_references: Record<string, unknown>[];
  status: 'onboarding' | 'active' | 'inactive';
  deactivation_reason_code: string | null;
  deactivated_at: string | null;
  onboarding_submitted_at: string | null;
  onboarding_approved_at: string | null;
  onboarding_approved_by: string | null;
  onboarding_rejection_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSupplierById(
  supplierId: string,
  client?: PoolClient,
): Promise<SupplierRow | null> {
  if (!UUID_REGEX.test(supplierId)) return null;
  const r = runner(client);
  const result = await r.query(`SELECT * FROM supplier WHERE supplier_id = $1`, [supplierId]);
  return (result.rows[0] as SupplierRow) ?? null;
}

export async function getSupplierByOwnerPartyCode(
  ownerPartyCode: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<SupplierRow | null> {
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM supplier WHERE owner_party_code = $1${lockClause}`, [ownerPartyCode]);
  return (result.rows[0] as SupplierRow) ?? null;
}

export async function getSupplierByGstin(
  gstinExt: string,
  client?: PoolClient,
): Promise<SupplierRow | null> {
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM supplier WHERE gstin_ext = $1 AND status IN ('onboarding', 'active')`,
    [gstinExt],
  );
  return (result.rows[0] as SupplierRow) ?? null;
}

export interface ListSuppliersParams {
  status?: 'onboarding' | 'active' | 'inactive' | undefined;
  search?: string | undefined;
}

export async function listSuppliers(
  params: ListSuppliersParams,
  client?: PoolClient,
): Promise<SupplierRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | null)[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      `(legal_name ILIKE $${idx} ESCAPE '\\' OR owner_party_code ILIKE $${idx + 1} ESCAPE '\\')`,
    );
    const pattern = `%${escaped}%`;
    values.push(pattern, pattern);
    idx += 2;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT * FROM supplier ${where} ORDER BY legal_name ASC`,
    values,
  );
  return result.rows as SupplierRow[];
}

export async function insertSupplier(
  row: SupplierRow,
  client: PoolClient,
): Promise<void> {
  let contactsJson: string;
  let certRefsJson: string;
  try {
    contactsJson = JSON.stringify(row.contacts);
    certRefsJson = JSON.stringify(row.certification_references);
  } catch (err) {
    throw new Error(`Failed to serialize supplier data: ${(err as Error).message}`);
  }
  await client.query(
    `INSERT INTO supplier (
      supplier_id, legal_name, owner_party_code, gstin_ext, pan_ext,
      contacts, credit_period_days, commercial_terms, freight_terms,
      delivery_terms, certification_references, status,
      created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.supplier_id,
      row.legal_name,
      row.owner_party_code,
      row.gstin_ext,
      row.pan_ext,
      contactsJson,
      row.credit_period_days,
      row.commercial_terms,
      row.freight_terms,
      row.delivery_terms,
      certRefsJson,
      row.status,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

export async function updateSupplierStatus(
  supplierId: string,
  status: 'onboarding' | 'active' | 'inactive',
  extra: Partial<Pick<SupplierRow, 'onboarding_submitted_at' | 'onboarding_approved_at' | 'onboarding_approved_by' | 'onboarding_rejection_reason' | 'deactivation_reason_code' | 'deactivated_at'>>,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: (string | null)[] = [supplierId, status];
  let idx = 3;

  if (extra.onboarding_submitted_at !== undefined) {
    sets.push(`onboarding_submitted_at = $${idx++}`);
    values.push(extra.onboarding_submitted_at);
  }
  if (extra.onboarding_approved_at !== undefined) {
    sets.push(`onboarding_approved_at = $${idx++}`);
    values.push(extra.onboarding_approved_at);
  }
  if (extra.onboarding_approved_by !== undefined) {
    sets.push(`onboarding_approved_by = $${idx++}::uuid`);
    values.push(extra.onboarding_approved_by);
  }
  if (extra.onboarding_rejection_reason !== undefined) {
    sets.push(`onboarding_rejection_reason = $${idx++}`);
    values.push(extra.onboarding_rejection_reason);
  }
  if (extra.deactivation_reason_code !== undefined) {
    sets.push(`deactivation_reason_code = $${idx++}`);
    values.push(extra.deactivation_reason_code);
  }
  if (extra.deactivated_at !== undefined) {
    sets.push(`deactivated_at = $${idx++}`);
    values.push(extra.deactivated_at);
  }

  await client.query(
    `UPDATE supplier SET ${sets.join(', ')} WHERE supplier_id = $1`,
    values,
  );
}

export async function updateSupplierMutableFields(
  supplierId: string,
  fields: Partial<Pick<SupplierRow, 'contacts' | 'credit_period_days' | 'commercial_terms' | 'freight_terms' | 'delivery_terms' | 'certification_references'>>,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: (string | unknown)[] = [supplierId];
  let idx = 2;

  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) {
      const dbKey = key as string;
      sets.push(`${dbKey} = $${idx++}`);
      values.push(
        key === 'contacts' || key === 'certification_references'
          ? JSON.stringify(val)
          : val,
      );
    }
  }

  if (sets.length === 1) {
    throw new Error('No fields to update');
  }
  await client.query(
    `UPDATE supplier SET ${sets.join(', ')} WHERE supplier_id = $1`,
    values,
  );
}
