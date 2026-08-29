import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.1 accessors for the append-only inspection-plan approval evidence (FR-Q-01, AC 1). One
 * row per plan version (the primary key), carrying the SERVER-derived authority: the DOA entry that
 * governed qc.inspection_plan_approval, its QC Head-level governing role, the resolved approver and
 * the acting user (who must equal the resolved approver), and the approval instant.
 *
 * insertInspectionPlanApproval is called by the seam's applier under pg_advisory_xact_lock keyed by
 * plan_id; inspection_plan_approval_pkey is the race backstop (23505 resolves to
 * 409 INSPECTION_PLAN_ALREADY_APPROVED in the store's constraint chain).
 */

export interface InspectionPlanApprovalRow {
  plan_version_id: string;
  plan_id: string;
  approved_by: string;
  resolved_approver_user_id: string;
  doa_entry_id: string;
  governing_role: string;
  approved_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_COLUMNS = `plan_version_id, plan_id, approved_by, resolved_approver_user_id, doa_entry_id,
    governing_role, approved_at, source_event_id, created_at`;

function mapApproval(row: Record<string, unknown>): InspectionPlanApprovalRow {
  const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    plan_version_id: row['plan_version_id'] as string,
    plan_id: row['plan_id'] as string,
    approved_by: row['approved_by'] as string,
    resolved_approver_user_id: row['resolved_approver_user_id'] as string,
    doa_entry_id: row['doa_entry_id'] as string,
    governing_role: row['governing_role'] as string,
    approved_at: toIso(row['approved_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function getInspectionPlanApproval(
  planVersionId: string,
  client?: PoolClient,
): Promise<InspectionPlanApprovalRow | null> {
  if (!UUID_REGEX.test(planVersionId)) return null;
  const result = await runner(client).query(
    `SELECT ${APPROVAL_COLUMNS} FROM inspection_plan_approval WHERE plan_version_id = $1`,
    [planVersionId],
  );
  return result.rows.length > 0 ? mapApproval(result.rows[0]!) : null;
}

export async function insertInspectionPlanApproval(
  row: Omit<InspectionPlanApprovalRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO inspection_plan_approval (plan_version_id, plan_id, approved_by,
       resolved_approver_user_id, doa_entry_id, governing_role, approved_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.plan_version_id,
      row.plan_id,
      row.approved_by,
      row.resolved_approver_user_id,
      row.doa_entry_id,
      row.governing_role,
      row.approved_at,
      row.source_event_id,
    ],
  );
}
