import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface PurchaseOrderRow {
  po_id: string;
  po_number_ext: string;
  po_type: 'standard' | 'blanket' | 'contract';
  supplier_id: string;
  indent_id: string;
  site_id: string;
  business_stream: string;
  status: 'draft' | 'pending-approval' | 'approved' | 'rejected' | 'issued' | 'confirmed';
  total_value: string;
  ceiling_value: string | null;
  released_value: string;
  currency: string;
  payment_terms: string | null;
  created_by: string;
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  decided_at: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  issued_at: string | null;
  confirmed_at: string | null;
  promised_delivery_date: string | null;
  // Story 4.6: statutory MSME payment due date stamped at confirmation; null for non-MSME.
  statutory_due_date: string | null;
  statutory_due_rule_version: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderLineRow {
  po_line_id: string;
  po_id: string;
  line_no: number;
  sku: string;
  item_category: string;
  ordered_qty: string;
  uom: string;
  unit_price: string;
  tax_rate_pct: string | null;
  line_value: string;
  promised_delivery_date: string | null;
}

export interface PoOutboundMessageRow {
  message_id: string;
  po_id: string;
  payload: unknown;
  recorded_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPurchaseOrderById(
  poId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<PurchaseOrderRow | null> {
  if (!UUID_REGEX.test(poId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM purchase_order WHERE po_id = $1${lockClause}`, [
    poId,
  ]);
  return (result.rows[0] as PurchaseOrderRow) ?? null;
}

export async function getPurchaseOrderLines(
  poId: string,
  client?: PoolClient,
): Promise<PurchaseOrderLineRow[]> {
  if (!UUID_REGEX.test(poId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM purchase_order_line WHERE po_id = $1 ORDER BY line_no ASC`,
    [poId],
  );
  return result.rows as PurchaseOrderLineRow[];
}

export interface ListPurchaseOrdersParams {
  status?: PurchaseOrderRow['status'] | undefined;
  supplierId?: string | undefined;
  siteId?: string | undefined;
  search?: string | undefined;
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listPurchaseOrders(
  params: ListPurchaseOrdersParams,
  client?: PoolClient,
): Promise<PurchaseOrderRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.supplierId) {
    if (!UUID_REGEX.test(params.supplierId)) return [];
    conditions.push(`supplier_id = $${idx++}`);
    values.push(params.supplierId);
  }
  if (params.siteId) {
    if (!UUID_REGEX.test(params.siteId)) return [];
    conditions.push(`site_id = $${idx++}`);
    values.push(params.siteId);
  }
  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(`(po_number_ext ILIKE $${idx} ESCAPE '\\')`);
    const pattern = `%${escaped}%`;
    values.push(pattern);
    idx += 1;
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
    `SELECT * FROM purchase_order ${where} ORDER BY created_at DESC, po_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as PurchaseOrderRow[];
}

export interface InsertPurchaseOrderInput {
  po_id: string;
  po_number_ext: string;
  po_type: 'standard' | 'blanket' | 'contract';
  supplier_id: string;
  indent_id: string;
  site_id: string;
  business_stream: string;
  status: 'draft' | 'pending-approval' | 'approved';
  total_value: string;
  ceiling_value: string | null;
  currency: string;
  payment_terms: string | null;
  created_by: string;
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  correlation_id: string | null;
  source_event_id: string;
}

export async function insertPurchaseOrder(
  row: InsertPurchaseOrderInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO purchase_order (
      po_id, po_number_ext, po_type, supplier_id, indent_id, site_id,
      business_stream, status, total_value, ceiling_value, currency, payment_terms,
      created_by, approver_actor_id, doa_entry_id, correlation_id, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11,$12,$13,$14,$15,$16,$17)`,
    [
      row.po_id,
      row.po_number_ext,
      row.po_type,
      row.supplier_id,
      row.indent_id,
      row.site_id,
      row.business_stream,
      row.status,
      row.total_value,
      row.ceiling_value,
      row.currency,
      row.payment_terms,
      row.created_by,
      row.approver_actor_id,
      row.doa_entry_id,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export interface InsertPurchaseOrderLineInput {
  po_line_id: string;
  po_id: string;
  line_no: number;
  sku: string;
  item_category: string;
  ordered_qty: number;
  uom: string;
  unit_price: number;
  tax_rate_pct: number | null;
}

export async function insertPurchaseOrderLine(
  row: InsertPurchaseOrderLineInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO purchase_order_line (
      po_line_id, po_id, line_no, sku, item_category, ordered_qty, uom,
      unit_price, tax_rate_pct, line_value
    ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,$9::numeric,
      $6::numeric * $8::numeric)`,
    [
      row.po_line_id,
      row.po_id,
      row.line_no,
      row.sku,
      row.item_category,
      row.ordered_qty,
      row.uom,
      row.unit_price,
      row.tax_rate_pct,
    ],
  );
}

export async function recomputePoTotalValue(poId: string, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE purchase_order SET total_value = (
       SELECT COALESCE(SUM(line_value), 0) FROM purchase_order_line WHERE po_id = $1
     ), updated_at = now()
     WHERE po_id = $1`,
    [poId],
  );
}

export async function updatePurchaseOrderStatus(
  poId: string,
  status: PurchaseOrderRow['status'],
  extra: Partial<
    Pick<
      PurchaseOrderRow,
      | 'decided_at'
      | 'decided_by'
      | 'rejection_reason'
      | 'issued_at'
      | 'confirmed_at'
      | 'promised_delivery_date'
      | 'approver_actor_id'
      | 'doa_entry_id'
      | 'ceiling_value'
      | 'released_value'
      | 'statutory_due_date'
      | 'statutory_due_rule_version'
    >
  >,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: (string | null)[] = [poId, status];
  let idx = 3;

  if (extra.decided_at !== undefined) {
    sets.push(`decided_at = $${idx++}`);
    values.push(extra.decided_at);
  }
  if (extra.decided_by !== undefined) {
    sets.push(`decided_by = $${idx++}::uuid`);
    values.push(extra.decided_by);
  }
  if (extra.rejection_reason !== undefined) {
    sets.push(`rejection_reason = $${idx++}`);
    values.push(extra.rejection_reason);
  }
  if (extra.issued_at !== undefined) {
    sets.push(`issued_at = $${idx++}`);
    values.push(extra.issued_at);
  }
  if (extra.confirmed_at !== undefined) {
    sets.push(`confirmed_at = $${idx++}`);
    values.push(extra.confirmed_at);
  }
  if (extra.promised_delivery_date !== undefined) {
    sets.push(`promised_delivery_date = $${idx++}`);
    values.push(extra.promised_delivery_date);
  }
  if (extra.approver_actor_id !== undefined) {
    sets.push(`approver_actor_id = $${idx++}::uuid`);
    values.push(extra.approver_actor_id);
  }
  if (extra.doa_entry_id !== undefined) {
    sets.push(`doa_entry_id = $${idx++}::uuid`);
    values.push(extra.doa_entry_id);
  }
  if (extra.ceiling_value !== undefined) {
    sets.push(`ceiling_value = $${idx++}::numeric`);
    values.push(extra.ceiling_value);
  }
  if (extra.released_value !== undefined) {
    sets.push(`released_value = $${idx++}::numeric`);
    values.push(extra.released_value);
  }
  // AC7: statutory due dates are stamped once on the confirmation transition and then preserved
  // (conservative treatment, 'stamped dates remain in force'). Guard the write so any future
  // re-confirmation of the same PO does not overwrite the originally-stamped date or rule version.
  if (extra.statutory_due_date !== undefined) {
    sets.push(`statutory_due_date = COALESCE(statutory_due_date, $${idx++}::date)`);
    values.push(extra.statutory_due_date);
  }
  if (extra.statutory_due_rule_version !== undefined) {
    sets.push(`statutory_due_rule_version = COALESCE(statutory_due_rule_version, $${idx++})`);
    values.push(extra.statutory_due_rule_version);
  }

  await client.query(`UPDATE purchase_order SET ${sets.join(', ')} WHERE po_id = $1`, values);
}

/**
 * AC5 ceiling math runs entirely in PostgreSQL NUMERIC (never JS floats): the release is applied
 * only when released_value + release <= ceiling_value, both compared server-side. Returns the
 * duplicate-or-ceiling reason when the write is rejected.
 */
export async function addPoReleaseValue(
  poId: string,
  releaseValue: string,
  releaseReference: string,
  client: PoolClient,
): Promise<'applied' | 'duplicate' | 'ceiling'> {
  const duplicate = await client.query(
    `SELECT 1 FROM domain_events
     WHERE stream_id = $1
       AND event_type = 'purchase_order.release_recorded'
       AND payload->>'release_reference' = $2
     LIMIT 1`,
    [poId, releaseReference],
  );
  if (duplicate.rows.length > 0) return 'duplicate';

  const result = await client.query(
    `UPDATE purchase_order
     SET released_value = released_value + $2::numeric, updated_at = now()
     WHERE po_id = $1
       AND ceiling_value IS NOT NULL
       AND released_value + $2::numeric <= ceiling_value`,
    [poId, releaseValue],
  );
  return (result.rowCount ?? 0) > 0 ? 'applied' : 'ceiling';
}

export async function updatePurchaseOrderLinePromisedDate(
  poLineId: string,
  promisedDeliveryDate: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE purchase_order_line SET promised_delivery_date = $2 WHERE po_line_id = $1`,
    [poLineId, promisedDeliveryDate],
  );
}

export async function allocatePoNumber(year: number, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT nextval('po_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `PO-${year}-${n.padStart(4, '0')}`;
}

export async function insertPoOutboundMessage(
  messageId: string,
  poId: string,
  payload: unknown,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO po_outbound_message (message_id, po_id, payload) VALUES ($1, $2, $3)`,
    [messageId, poId, JSON.stringify(payload)],
  );
}

export async function getPoOutboundMessage(
  poId: string,
  client?: PoolClient,
): Promise<PoOutboundMessageRow | null> {
  if (!UUID_REGEX.test(poId)) return null;
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM po_outbound_message WHERE po_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [poId],
  );
  return (result.rows[0] as PoOutboundMessageRow) ?? null;
}
