import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.6 accessor for the label_master projection (FR-Q-14, AC 3). The table is the minimal
 * enforcement contract for the Legal Metrology statutory release block (Binding Scope Decision
 * 1): Story 8.6 ships NO write routes and NO event types for it - fixtures seed rows through the
 * admin pool, app_user holds SELECT only, and Story 8.7 layers the version-control governance
 * (CRUD, DOA approval workflow, edit-logging) on top.
 *
 * "Current approved label version" is the partial-unique row uq_label_master_current
 * (sku WHERE status = 'approved') - Binding Scope Decision 8. The release block passes when an
 * approved row exists for the task's sku; no label reference is written onto the release record
 * in Story 8.6.
 */

export const LABEL_MASTER_STATUSES = ['draft', 'approved', 'superseded'] as const;
export type LabelMasterStatus = (typeof LABEL_MASTER_STATUSES)[number];

export interface LabelMasterRow {
  label_id: string;
  sku: string;
  label_version: string;
  status: LabelMasterStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export const LABEL_MASTER_COLUMNS = `label_id, sku, label_version, status, approved_by,
    approved_at, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): LabelMasterRow {
  return {
    label_id: row['label_id'] as string,
    sku: row['sku'] as string,
    label_version: row['label_version'] as string,
    status: row['status'] as LabelMasterStatus,
    approved_by: (row['approved_by'] as string | null) ?? null,
    approved_at: toIsoOrNull(row['approved_at']),
    created_at: toIso(row['created_at']),
  };
}

/** The single current approved label row for a sku (uq_label_master_current grain), or null. */
export async function findCurrentApprovedLabel(
  sku: string,
  client?: PoolClient,
): Promise<LabelMasterRow | null> {
  const result = await runner(client).query(
    `SELECT ${LABEL_MASTER_COLUMNS}
       FROM label_master
      WHERE sku = $1 AND status = 'approved'
      LIMIT 1`,
    [sku],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}
