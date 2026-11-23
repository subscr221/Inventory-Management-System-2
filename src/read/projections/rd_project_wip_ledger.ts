import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface RdWipPostingRow {
  posting_id: string;
  project_code: string;
  posting_type: 'issue' | 'return';
  issue_cost_id: string;
  rd_issue_id: string;
  requisition_id: string;
  requisition_line_id: string;
  sku: string;
  quantity: string;
  open_quantity: string | null;
  unit_cost: string | null;
  posting_value: string;
  reason_code: string | null;
  source_posting_id: string | null;
  source_event_id: string;
  occurred_at: string;
  created_at: string;
}

export async function getRdProjectWip(
  projectCode: string,
  client?: PoolClient,
): Promise<{ project_code: string; quantity: string; value: string; rows: RdWipPostingRow[] }> {
  const db = client ?? getPool();
  const summary = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN posting_type = 'issue' THEN quantity ELSE -quantity END), 0)::text AS quantity, COALESCE(SUM(posting_value), 0)::text AS value FROM rd_project_wip_ledger WHERE project_code = $1`,
    [projectCode],
  );
  const rows = await db.query(
    'SELECT * FROM rd_project_wip_ledger WHERE project_code = $1 ORDER BY occurred_at, posting_id',
    [projectCode],
  );
  return {
    project_code: projectCode,
    quantity: summary.rows[0]!.quantity as string,
    value: summary.rows[0]!.value as string,
    rows: rows.rows as RdWipPostingRow[],
  };
}

export async function getRdWipPostingById(
  postingId: string,
  client: PoolClient,
  forUpdate = false,
): Promise<RdWipPostingRow | null> {
  const result = await client.query(
    `SELECT * FROM rd_project_wip_ledger WHERE posting_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [postingId],
  );
  return (result.rows[0] as RdWipPostingRow | undefined) ?? null;
}

export async function insertRdWipPosting(
  row: Omit<RdWipPostingRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'INSERT INTO rd_project_wip_ledger (posting_id, project_code, posting_type, issue_cost_id, rd_issue_id, requisition_id, requisition_line_id, sku, quantity, open_quantity, unit_cost, posting_value, reason_code, source_posting_id, source_event_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      row.posting_id,
      row.project_code,
      row.posting_type,
      row.issue_cost_id,
      row.rd_issue_id,
      row.requisition_id,
      row.requisition_line_id,
      row.sku,
      row.quantity,
      row.open_quantity,
      row.unit_cost,
      row.posting_value,
      row.reason_code,
      row.source_posting_id,
      row.source_event_id,
      row.occurred_at,
    ],
  );
}

export async function decrementRdWipOpenQuantity(
  postingId: string,
  quantity: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'UPDATE rd_project_wip_ledger SET open_quantity = open_quantity - $2::numeric WHERE posting_id = $1',
    [postingId, quantity],
  );
}

export async function getRdProjectBuilds(
  projectCode: string,
  client?: PoolClient,
): Promise<Array<Record<string, unknown>>> {
  const db = client ?? getPool();
  const result = await db.query(
    `SELECT b.*, COALESCE(lines.as_built_lines, '[]'::jsonb) AS as_built_lines
     FROM rd_build_record b
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_no) AS as_built_lines FROM rd_as_built_line l WHERE l.build_id = b.build_id
     ) lines ON true
     WHERE b.project_code = $1 ORDER BY b.recorded_at DESC, b.build_id`,
    [projectCode],
  );
  return result.rows as Array<Record<string, unknown>>;
}
