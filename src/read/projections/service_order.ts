import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface ServiceOrderPriceBasis {
  basis_type: 'per_piece' | 'per_kg' | 'per_hour' | 'lumpsum';
  rate: number;
  currency: string;
}

export interface ServiceOrderRow {
  service_order_id: string;
  order_number_ext: string;
  customer_party_code: string;
  customer_name: string;
  spec_reference_ext: string | null;
  promised_start_date: string | null;
  promised_delivery_date: string | null;
  price_basis: ServiceOrderPriceBasis | null;
  kit_bom_id: string | null;
  status: 'draft' | 'confirmed' | 'in_process' | 'closed';
  offcut_election: 'return' | 'retain_and_buy' | 'retain_free' | null;
  has_contractual_offcut: boolean;
  site_id: string;
  business_stream: string;
  created_by: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  in_process_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getServiceOrderById(
  serviceOrderId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<ServiceOrderRow | null> {
  if (!UUID_REGEX.test(serviceOrderId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT * FROM service_order WHERE service_order_id = $1${lockClause}`,
    [serviceOrderId],
  );
  return (result.rows[0] as ServiceOrderRow) ?? null;
}

export interface ListServiceOrdersParams {
  status?: ServiceOrderRow['status'] | undefined;
  customerPartyCode?: string | undefined;
  siteId?: string | undefined;
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listServiceOrders(
  params: ListServiceOrdersParams,
  client?: PoolClient,
): Promise<ServiceOrderRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.customerPartyCode) {
    conditions.push(`customer_party_code = $${idx++}`);
    values.push(params.customerPartyCode);
  }
  if (params.siteId) {
    if (!UUID_REGEX.test(params.siteId)) return [];
    conditions.push(`site_id = $${idx++}`);
    values.push(params.siteId);
  }
  if (params.permittedSites && !params.permittedSites.wildcard) {
    const sites = [...params.permittedSites.locations].filter((s) => UUID_REGEX.test(s));
    if (sites.length === 0) return [];
    conditions.push(`site_id = ANY($${idx++}::uuid[])`);
    values.push(sites);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT * FROM service_order ${where} ORDER BY created_at DESC, service_order_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as ServiceOrderRow[];
}

export interface InsertServiceOrderInput {
  service_order_id: string;
  order_number_ext: string;
  customer_party_code: string;
  customer_name: string;
  spec_reference_ext: string | null;
  promised_start_date: string | null;
  promised_delivery_date: string | null;
  price_basis: ServiceOrderPriceBasis | null;
  kit_bom_id: string | null;
  has_contractual_offcut: boolean;
  site_id: string;
  business_stream: string;
  created_by: string;
  correlation_id: string | null;
  source_event_id: string;
}

export async function insertServiceOrder(
  row: InsertServiceOrderInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO service_order (
      service_order_id, order_number_ext, customer_party_code, customer_name,
      spec_reference_ext, promised_start_date, promised_delivery_date, price_basis,
      kit_bom_id, has_contractual_offcut, status, site_id, business_stream, created_by,
      correlation_id, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'draft',$11,$12,$13,$14,$15)`,
    [
      row.service_order_id,
      row.order_number_ext,
      row.customer_party_code,
      row.customer_name,
      row.spec_reference_ext,
      row.promised_start_date,
      row.promised_delivery_date,
      row.price_basis === null ? null : JSON.stringify(row.price_basis),
      row.kit_bom_id,
      row.has_contractual_offcut,
      row.site_id,
      row.business_stream,
      row.created_by,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

/** Draft-only field edits (jobwork.order_updated). Status is never changed here. */
export interface UpdateServiceOrderFieldsInput {
  customer_party_code?: string;
  customer_name?: string;
  spec_reference_ext?: string | null;
  promised_start_date?: string | null;
  promised_delivery_date?: string | null;
  price_basis?: ServiceOrderPriceBasis | null;
  kit_bom_id?: string | null;
  has_contractual_offcut?: boolean;
}

export async function updateServiceOrderFields(
  serviceOrderId: string,
  fields: UpdateServiceOrderFieldsInput,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [serviceOrderId];
  let idx = 2;

  if (fields.customer_party_code !== undefined) {
    sets.push(`customer_party_code = $${idx++}`);
    values.push(fields.customer_party_code);
  }
  if (fields.customer_name !== undefined) {
    sets.push(`customer_name = $${idx++}`);
    values.push(fields.customer_name);
  }
  if (fields.spec_reference_ext !== undefined) {
    sets.push(`spec_reference_ext = $${idx++}`);
    values.push(fields.spec_reference_ext);
  }
  if (fields.promised_start_date !== undefined) {
    sets.push(`promised_start_date = $${idx++}`);
    values.push(fields.promised_start_date);
  }
  if (fields.promised_delivery_date !== undefined) {
    sets.push(`promised_delivery_date = $${idx++}`);
    values.push(fields.promised_delivery_date);
  }
  if (fields.price_basis !== undefined) {
    sets.push(`price_basis = $${idx++}::jsonb`);
    values.push(fields.price_basis === null ? null : JSON.stringify(fields.price_basis));
  }
  if (fields.kit_bom_id !== undefined) {
    sets.push(`kit_bom_id = $${idx++}::uuid`);
    values.push(fields.kit_bom_id);
  }
  if (fields.has_contractual_offcut !== undefined) {
    sets.push(`has_contractual_offcut = $${idx++}`);
    values.push(fields.has_contractual_offcut);
  }

  await client.query(
    `UPDATE service_order SET ${sets.join(', ')} WHERE service_order_id = $1`,
    values,
  );
}

export interface ServiceOrderStatusExtra {
  confirmed_at?: string;
  confirmed_by?: string;
  offcut_election?: 'return' | 'retain_and_buy' | 'retain_free' | null;
  in_process_at?: string;
  closed_at?: string;
  closed_by?: string;
}

export async function updateServiceOrderStatus(
  serviceOrderId: string,
  status: ServiceOrderRow['status'],
  extra: ServiceOrderStatusExtra,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: (string | null)[] = [serviceOrderId, status];
  let idx = 3;

  if (extra.confirmed_at !== undefined) {
    sets.push(`confirmed_at = $${idx++}`);
    values.push(extra.confirmed_at);
  }
  if (extra.confirmed_by !== undefined) {
    sets.push(`confirmed_by = $${idx++}::uuid`);
    values.push(extra.confirmed_by);
  }
  if (extra.offcut_election !== undefined) {
    sets.push(`offcut_election = $${idx++}`);
    values.push(extra.offcut_election);
  }
  if (extra.in_process_at !== undefined) {
    sets.push(`in_process_at = $${idx++}`);
    values.push(extra.in_process_at);
  }
  if (extra.closed_at !== undefined) {
    sets.push(`closed_at = $${idx++}`);
    values.push(extra.closed_at);
  }
  if (extra.closed_by !== undefined) {
    sets.push(`closed_by = $${idx++}::uuid`);
    values.push(extra.closed_by);
  }

  await client.query(
    `UPDATE service_order SET ${sets.join(', ')} WHERE service_order_id = $1`,
    values,
  );
}

export async function allocateServiceOrderNumber(
  year: number,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(`SELECT nextval('service_order_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `SO-${year}-${n.padStart(4, '0')}`;
}
