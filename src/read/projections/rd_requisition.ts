import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 10.2 (FR-RD-04): read model for the R&D requisition header and lines. NUMERIC columns are
 * returned as strings (node-postgres default) so money and quantity arithmetic stays float-free.
 */

export interface RdRequisitionRow {
  requisition_id: string;
  project_code: string;
  requester_user_id: string;
  business_stream: string;
  estimated_value: string;
  status: 'approved' | 'approval_required' | 'rejected';
  budget_breach: boolean;
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  owner_approver_id: string | null;
  owner_approved_at: string | null;
  head_approved_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface RdRequisitionLineRow {
  requisition_line_id: string;
  requisition_id: string;
  sku: string;
  requested_qty: string;
  issued_quantity: string;
  uom: string;
  unit_cost_estimate: string;
  line_value: string;
  issue_type: 'consumable' | 'project_material' | 'equipment_custody';
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRequisition(row: Record<string, unknown>): RdRequisitionRow {
  return {
    requisition_id: row['requisition_id'] as string,
    project_code: row['project_code'] as string,
    requester_user_id: row['requester_user_id'] as string,
    business_stream: row['business_stream'] as string,
    estimated_value: String(row['estimated_value']),
    status: row['status'] as RdRequisitionRow['status'],
    budget_breach: row['budget_breach'] === true,
    approver_actor_id: (row['approver_actor_id'] as string | null) ?? null,
    doa_entry_id: (row['doa_entry_id'] as string | null) ?? null,
    owner_approver_id: (row['owner_approver_id'] as string | null) ?? null,
    owner_approved_at: row['owner_approved_at'] ? toIso(row['owner_approved_at']) : null,
    head_approved_at: row['head_approved_at'] ? toIso(row['head_approved_at']) : null,
    decided_at: row['decided_at'] ? toIso(row['decided_at']) : null,
    decided_by: (row['decided_by'] as string | null) ?? null,
    rejection_reason: (row['rejection_reason'] as string | null) ?? null,
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

function mapLine(row: Record<string, unknown>): RdRequisitionLineRow {
  return {
    requisition_line_id: row['requisition_line_id'] as string,
    requisition_id: row['requisition_id'] as string,
    sku: row['sku'] as string,
    requested_qty: String(row['requested_qty']),
    issued_quantity: String(row['issued_quantity']),
    uom: row['uom'] as string,
    unit_cost_estimate: String(row['unit_cost_estimate']),
    line_value: String(row['line_value']),
    issue_type: row['issue_type'] as RdRequisitionLineRow['issue_type'],
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
  };
}

const REQUISITION_COLUMNS = `requisition_id, project_code, requester_user_id, business_stream,
  estimated_value, status, budget_breach, approver_actor_id, doa_entry_id, owner_approver_id,
  owner_approved_at, head_approved_at, decided_at, decided_by, rejection_reason, source_event_id,
  created_at, updated_at`;

export async function getRdRequisitionById(
  requisitionId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<RdRequisitionRow | null> {
  const r = runner(client);
  const result = await r.query(
    `SELECT ${REQUISITION_COLUMNS} FROM rd_requisition WHERE requisition_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [requisitionId],
  );
  return result.rows.length > 0 ? mapRequisition(result.rows[0]!) : null;
}

export async function getRdRequisitionLines(
  requisitionId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<RdRequisitionLineRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT requisition_line_id, requisition_id, sku, requested_qty, issued_quantity, uom,
            unit_cost_estimate, line_value, issue_type, source_event_id, created_at, updated_at
     FROM rd_requisition_line WHERE requisition_id = $1
     ORDER BY created_at ASC, requisition_line_id ASC${forUpdate ? ' FOR UPDATE' : ''}`,
    [requisitionId],
  );
  return result.rows.map(mapLine);
}

export async function getRdRequisitionLineForUpdate(
  requisitionLineId: string,
  client: PoolClient,
): Promise<RdRequisitionLineRow | null> {
  const result = await client.query(
    `SELECT requisition_line_id, requisition_id, sku, requested_qty, issued_quantity, uom,
            unit_cost_estimate, line_value, issue_type, source_event_id, created_at, updated_at
     FROM rd_requisition_line WHERE requisition_line_id = $1 FOR UPDATE`,
    [requisitionLineId],
  );
  return result.rows.length > 0 ? mapLine(result.rows[0]!) : null;
}

export interface InsertRdRequisitionInput {
  requisition_id: string;
  project_code: string;
  requester_user_id: string;
  business_stream: string;
  estimated_value: string;
  status: RdRequisitionRow['status'];
  budget_breach: boolean;
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  owner_approver_id: string | null;
  source_event_id: string;
}

export async function insertRdRequisition(
  input: InsertRdRequisitionInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_requisition
       (requisition_id, project_code, requester_user_id, business_stream, estimated_value, status,
        budget_breach, approver_actor_id, doa_entry_id, owner_approver_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.requisition_id,
      input.project_code,
      input.requester_user_id,
      input.business_stream,
      input.estimated_value,
      input.status,
      input.budget_breach,
      input.approver_actor_id,
      input.doa_entry_id,
      input.owner_approver_id,
      input.source_event_id,
    ],
  );
}

export interface InsertRdRequisitionLineInput {
  requisition_line_id: string;
  requisition_id: string;
  sku: string;
  requested_qty: string;
  uom: string;
  unit_cost_estimate: string;
  issue_type: string;
  source_event_id: string;
}

export async function insertRdRequisitionLine(
  input: InsertRdRequisitionLineInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_requisition_line
       (requisition_line_id, requisition_id, sku, requested_qty, uom, unit_cost_estimate,
        line_value, issue_type, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, round($4::numeric * $6::numeric, 4), $7, $8)`,
    [
      input.requisition_line_id,
      input.requisition_id,
      input.sku,
      input.requested_qty,
      input.uom,
      input.unit_cost_estimate,
      input.issue_type,
      input.source_event_id,
    ],
  );
}

export async function markRdRequisitionOwnerApproved(
  requisitionId: string,
  actorId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_requisition SET owner_approved_at = now(), updated_at = now()
     WHERE requisition_id = $1 AND owner_approved_at IS NULL`,
    [requisitionId],
  );
  await finalizeRdRequisitionIfFullyApproved(requisitionId, actorId, client);
}

export async function markRdRequisitionHeadApproved(
  requisitionId: string,
  actorId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_requisition SET head_approved_at = now(), updated_at = now()
     WHERE requisition_id = $1 AND head_approved_at IS NULL`,
    [requisitionId],
  );
  await finalizeRdRequisitionIfFullyApproved(requisitionId, actorId, client);
}

async function finalizeRdRequisitionIfFullyApproved(
  requisitionId: string,
  actorId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_requisition
     SET status = 'approved', decided_at = now(), decided_by = $2, updated_at = now()
     WHERE requisition_id = $1
       AND status = 'approval_required'
       AND owner_approved_at IS NOT NULL
       AND head_approved_at IS NOT NULL`,
    [requisitionId, actorId],
  );
}

export async function rejectRdRequisition(
  requisitionId: string,
  actorId: string,
  rejectionReason: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_requisition
     SET status = 'rejected', rejection_reason = $3, decided_at = now(), decided_by = $2,
         updated_at = now()
     WHERE requisition_id = $1`,
    [requisitionId, actorId, rejectionReason],
  );
}

/** Increments issued_quantity, refusing (returns false) when it would exceed requested_qty. */
export async function incrementRdRequisitionLineIssued(
  requisitionLineId: string,
  quantity: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE rd_requisition_line
     SET issued_quantity = issued_quantity + $2::numeric, updated_at = now()
     WHERE requisition_line_id = $1
       AND issued_quantity + $2::numeric <= requested_qty
     RETURNING requisition_line_id`,
    [requisitionLineId, quantity],
  );
  return result.rows.length > 0;
}

/** Committed: sum of remaining unissued value across approved requisition lines for a project. */
export async function committedRdValue(
  projectCode: string,
  client: PoolClient,
): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(round((l.requested_qty - l.issued_quantity) * l.unit_cost_estimate, 4)), 0)::text AS committed
     FROM rd_requisition_line l
     JOIN rd_requisition r ON r.requisition_id = l.requisition_id
     WHERE r.project_code = $1 AND r.status = 'approved'`,
    [projectCode],
  );
  return result.rows[0]!['committed'] as string;
}

/** Actual: sum of cost_amount already issued against a project. */
export async function actualRdCost(projectCode: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(cost_amount), 0)::text AS actual FROM rd_issue_cost WHERE project_code = $1`,
    [projectCode],
  );
  return result.rows[0]!['actual'] as string;
}

export interface ListRdRequisitionsResult {
  rows: RdRequisitionRow[];
  total: number;
}

export async function listRdRequisitions(
  filters: { projectCode?: string; status?: string; limit: number; offset: number },
  client?: PoolClient,
): Promise<ListRdRequisitionsResult> {
  const r = runner(client);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.projectCode) {
    params.push(filters.projectCode);
    where.push(`project_code = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const count = await r.query(`SELECT COUNT(*)::int AS total FROM rd_requisition ${whereSql}`, params);
  const rows = await r.query(
    `SELECT ${REQUISITION_COLUMNS} FROM rd_requisition ${whereSql}
     ORDER BY created_at DESC, requisition_id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filters.limit, filters.offset],
  );
  return { rows: rows.rows.map(mapRequisition), total: count.rows[0]!['total'] as number };
}
