import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface EcoRow {
  eco_id: string;
  eco_number: string;
  bom_id: string;
  target_revision_id: string;
  business_stream: string;
  status: 'draft' | 'under_review' | 'approved' | 'implemented' | 'cancelled';
  reason: string;
  raised_by: string;
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  review_started_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  implemented_at: string | null;
  implemented_by: string | null;
  new_revision_id: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface EcoChangeLineRow {
  eco_change_id: string;
  eco_id: string;
  change_no: number;
  change_type: 'add' | 'amend' | 'retire';
  target_bom_line_id: string | null;
  component_item_id: string | null;
  component_sku: string | null;
  output_class: 'component' | 'co_product' | 'by_product';
  quantity_per: string | null;
  line_uom: string | null;
  uom_conversion_factor: string | null;
  base_quantity_per: string | null;
  scrap_percent: string | null;
  expected_yield_percent: string | null;
  is_phantom: boolean;
  phantom_source_bom_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  source_event_id: string;
  created_at: string;
}

export interface EcoDispositionRow {
  disposition_id: string;
  eco_id: string;
  lot_id: string;
  sku: string;
  location_id: string;
  on_hand_qty: string;
  disposition: 'use_up' | 'scrap' | 'rework';
  rework_reference: string | null;
  notes: string | null;
  decided_at: string;
  decided_by: string;
  source_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getEcoById(
  ecoId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<EcoRow | null> {
  if (!UUID_REGEX.test(ecoId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM eco WHERE eco_id = $1${lockClause}`, [ecoId]);
  return (result.rows[0] as EcoRow) ?? null;
}

export interface ListEcosParams {
  bomId?: string | undefined;
  status?: EcoRow['status'] | undefined;
  approverActorId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Approval queue and list view (Task 6, AC 1/2/7). limit/offset are guarded and clamped. */
export async function listEcos(
  params: ListEcosParams,
  client?: PoolClient,
): Promise<{ rows: EcoRow[]; total: number }> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.bomId) {
    conditions.push(`bom_id = $${idx++}`);
    values.push(params.bomId);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.approverActorId) {
    conditions.push(`approver_actor_id = $${idx++}`);
    values.push(params.approverActorId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const countResult = await r.query(`SELECT COUNT(*) as total FROM eco ${where}`, values);
  const total = Number(countResult.rows[0]!.total);

  values.push(limit, offset);
  const result = await r.query(
    `SELECT * FROM eco ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );

  return { rows: result.rows as EcoRow[], total };
}

export async function getEcoChangeLines(
  ecoId: string,
  client?: PoolClient,
): Promise<EcoChangeLineRow[]> {
  if (!UUID_REGEX.test(ecoId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM eco_change_line WHERE eco_id = $1 ORDER BY change_no ASC`,
    [ecoId],
  );
  return result.rows as EcoChangeLineRow[];
}

export async function getEcoDispositions(
  ecoId: string,
  client?: PoolClient,
): Promise<EcoDispositionRow[]> {
  if (!UUID_REGEX.test(ecoId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM eco_stock_disposition WHERE eco_id = $1 ORDER BY decided_at ASC`,
    [ecoId],
  );
  return result.rows as EcoDispositionRow[];
}

export async function insertEco(
  row: Omit<EcoRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO eco (eco_id, eco_number, bom_id, target_revision_id, business_stream, status, reason, raised_by, approver_actor_id, doa_entry_id, review_started_at, approved_at, approved_by, implemented_at, implemented_by, new_revision_id, cancelled_at, cancelled_by, cancel_reason, status_changed_at, status_changed_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      row.eco_id,
      row.eco_number,
      row.bom_id,
      row.target_revision_id,
      row.business_stream,
      row.status,
      row.reason,
      row.raised_by,
      row.approver_actor_id,
      row.doa_entry_id,
      row.review_started_at,
      row.approved_at,
      row.approved_by,
      row.implemented_at,
      row.implemented_by,
      row.new_revision_id,
      row.cancelled_at,
      row.cancelled_by,
      row.cancel_reason,
      row.status_changed_at,
      row.status_changed_by,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function insertEcoChangeLine(
  row: Omit<EcoChangeLineRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO eco_change_line (eco_change_id, eco_id, change_no, change_type, target_bom_line_id, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $9::numeric * $11::numeric, $12, $13, $14, $15, $16, $17, $18)`,
    [
      row.eco_change_id,
      row.eco_id,
      row.change_no,
      row.change_type,
      row.target_bom_line_id,
      row.component_item_id,
      row.component_sku,
      row.output_class,
      row.quantity_per,
      row.line_uom,
      row.uom_conversion_factor,
      row.scrap_percent,
      row.expected_yield_percent,
      row.is_phantom,
      row.phantom_source_bom_id,
      row.effective_from,
      row.effective_to,
      row.source_event_id,
    ],
  );
}

export async function updateEcoReviewStarted(
  ecoId: string,
  changedAt: string,
  changedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE eco SET status = 'under_review', review_started_at = $1, status_changed_at = $1, status_changed_by = $2, updated_at = now() WHERE eco_id = $3`,
    [changedAt, changedBy, ecoId],
  );
}

export async function updateEcoApproved(
  ecoId: string,
  approvedAt: string,
  approvedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE eco SET status = 'approved', approved_at = $1, approved_by = $2, status_changed_at = $1, status_changed_by = $2, updated_at = now() WHERE eco_id = $3`,
    [approvedAt, approvedBy, ecoId],
  );
}

export async function updateEcoCancelled(
  ecoId: string,
  cancelledAt: string,
  cancelledBy: string,
  cancelReason: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE eco SET status = 'cancelled', cancelled_at = $1, cancelled_by = $2, cancel_reason = $3, status_changed_at = $1, status_changed_by = $2, updated_at = now() WHERE eco_id = $4`,
    [cancelledAt, cancelledBy, cancelReason, ecoId],
  );
}

export async function updateEcoImplemented(
  ecoId: string,
  implementedAt: string,
  implementedBy: string,
  newRevisionId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE eco SET status = 'implemented', implemented_at = $1, implemented_by = $2, new_revision_id = $3, status_changed_at = $1, status_changed_by = $2, updated_at = now() WHERE eco_id = $4`,
    [implementedAt, implementedBy, newRevisionId, ecoId],
  );
}

export interface UpsertEcoDispositionInput {
  disposition_id: string;
  eco_id: string;
  lot_id: string;
  sku: string;
  location_id: string;
  on_hand_qty: string;
  disposition: 'use_up' | 'scrap' | 'rework';
  rework_reference: string | null;
  notes: string | null;
  decided_at: string;
  decided_by: string;
  source_event_id: string;
}

/** Upsert keyed on uq_eco_disposition_lot: a corrected decision REPLACES rather than duplicates. */
export async function upsertEcoDisposition(
  row: UpsertEcoDispositionInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO eco_stock_disposition (disposition_id, eco_id, lot_id, sku, location_id, on_hand_qty, disposition, rework_reference, notes, decided_at, decided_by, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (eco_id, lot_id, location_id) DO UPDATE SET
       sku = EXCLUDED.sku,
       on_hand_qty = EXCLUDED.on_hand_qty,
       disposition = EXCLUDED.disposition,
       rework_reference = EXCLUDED.rework_reference,
       notes = EXCLUDED.notes,
       decided_at = EXCLUDED.decided_at,
       decided_by = EXCLUDED.decided_by,
       source_event_id = EXCLUDED.source_event_id`,
    [
      row.disposition_id,
      row.eco_id,
      row.lot_id,
      row.sku,
      row.location_id,
      row.on_hand_qty,
      row.disposition,
      row.rework_reference,
      row.notes,
      row.decided_at,
      row.decided_by,
      row.source_event_id,
    ],
  );
}
