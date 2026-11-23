import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface RdDispositionRow {
  disposition_id: string;
  prototype_id: string;
  project_code: string;
  disposition_type: 'retain-as-asset' | 'transfer-to-production' | 'teardown' | 'scrap';
  status: 'approval_required' | 'approved' | 'rejected' | 'executed';
  requester_actor_id: string;
  approver_actor_id: string;
  doa_entry_id: string;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  executed_at: string | null;
  executed_by: string | null;
  asset_id: string | null;
  production_reference: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface RdDispositionLineRow {
  line_id: string;
  disposition_id: string;
  line_no: number;
  component_sku: string;
  quantity: string;
  condition_code: string;
  source_event_id: string;
  created_at: string;
}
export interface RdScrapPendingRow {
  scrap_pending_id: string;
  disposition_id: string;
  disposition_line_id: string;
  prototype_id: string;
  project_code: string;
  sku: string;
  quantity: string;
  condition_code: string;
  source_prototype_ref: string;
  status: 'pending';
  source_event_id: string;
  created_at: string;
}
type Queryable = Pick<PoolClient, 'query'>;
function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export async function getRdDispositionById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<RdDispositionRow | null> {
  const result = await runner(client).query(
    `SELECT * FROM rd_disposition WHERE disposition_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return (result.rows[0] as RdDispositionRow | undefined) ?? null;
}
export async function listRdDispositions(
  prototypeId: string,
  client?: PoolClient,
): Promise<RdDispositionRow[]> {
  const result = await runner(client).query(
    'SELECT * FROM rd_disposition WHERE prototype_id = $1 ORDER BY created_at, disposition_id',
    [prototypeId],
  );
  return result.rows as RdDispositionRow[];
}
export async function insertRdDisposition(
  row: Omit<RdDispositionRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_disposition (disposition_id, prototype_id, project_code, disposition_type, status, requester_actor_id, approver_actor_id, doa_entry_id, approved_at, approved_by, rejected_at, rejected_by, rejection_reason, executed_at, executed_by, asset_id, production_reference, source_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      row.disposition_id,
      row.prototype_id,
      row.project_code,
      row.disposition_type,
      row.status,
      row.requester_actor_id,
      row.approver_actor_id,
      row.doa_entry_id,
      row.approved_at,
      row.approved_by,
      row.rejected_at,
      row.rejected_by,
      row.rejection_reason,
      row.executed_at,
      row.executed_by,
      row.asset_id,
      row.production_reference,
      row.source_event_id,
    ],
  );
}
export async function decideRdDisposition(
  id: string,
  status: 'approved' | 'rejected',
  actorId: string,
  reason: string | null,
  at: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_disposition SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN $5::timestamptz END, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid END, rejected_at = CASE WHEN $2 = 'rejected' THEN $5::timestamptz END, rejected_by = CASE WHEN $2 = 'rejected' THEN $3::uuid END, rejection_reason = $4, updated_at = now() WHERE disposition_id = $1`,
    [id, status, actorId, reason, at],
  );
}
export async function executeRdDisposition(
  id: string,
  actorId: string,
  assetId: string | null,
  productionReference: string | null,
  at: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_disposition SET status = 'executed', executed_by = $2, executed_at = $3, asset_id = $4, production_reference = $5, updated_at = now() WHERE disposition_id = $1`,
    [id, actorId, at, assetId, productionReference],
  );
}
export async function insertRdDispositionLine(
  row: Omit<RdDispositionLineRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'INSERT INTO rd_disposition_line (line_id, disposition_id, line_no, component_sku, quantity, condition_code, source_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      row.line_id,
      row.disposition_id,
      row.line_no,
      row.component_sku,
      row.quantity,
      row.condition_code,
      row.source_event_id,
    ],
  );
}
export async function listRdDispositionLines(
  id: string,
  client?: PoolClient,
): Promise<RdDispositionLineRow[]> {
  const result = await runner(client).query(
    'SELECT * FROM rd_disposition_line WHERE disposition_id = $1 ORDER BY line_no',
    [id],
  );
  return result.rows as RdDispositionLineRow[];
}
export async function insertRdScrapPending(
  row: Omit<RdScrapPendingRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'INSERT INTO rd_scrap_pending (scrap_pending_id, disposition_id, disposition_line_id, prototype_id, project_code, sku, quantity, condition_code, source_prototype_ref, status, source_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      row.scrap_pending_id,
      row.disposition_id,
      row.disposition_line_id,
      row.prototype_id,
      row.project_code,
      row.sku,
      row.quantity,
      row.condition_code,
      row.source_prototype_ref,
      row.status,
      row.source_event_id,
    ],
  );
}
export async function listRdScrapPending(
  params: { prototype_id?: string; project_code?: string },
  client?: PoolClient,
): Promise<RdScrapPendingRow[]> {
  const result = await runner(client).query(
    'SELECT * FROM rd_scrap_pending WHERE ($1::uuid IS NULL OR prototype_id = $1) AND ($2::text IS NULL OR project_code = $2) ORDER BY created_at, scrap_pending_id',
    [params.prototype_id ?? null, params.project_code ?? null],
  );
  return result.rows as RdScrapPendingRow[];
}
