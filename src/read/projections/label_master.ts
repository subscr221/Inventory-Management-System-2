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
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * A FOR UPDATE issued on a pool checkout commits immediately and releases the row lock the moment
 * the query returns - a lock that provably does nothing, with no error. Callers that ask for one
 * must supply the transaction client.
 */
function requireTransaction(client: PoolClient | undefined, fn: string): void {
  if (!client) {
    throw new Error(`${fn}: forUpdate requires a transaction client`);
  }
}

/** A literal, never an interpolated fragment - the locking clause is not built from input. */
const FOR_UPDATE = ' FOR UPDATE' as const;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export const LABEL_MASTER_COLUMNS = `label_id, sku, label_version, status, created_by,
    approved_by, approved_at, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : toIso(v);

function mapRow(row: Record<string, unknown>): LabelMasterRow {
  return {
    label_id: row['label_id'] as string,
    sku: row['sku'] as string,
    label_version: row['label_version'] as string,
    status: row['status'] as LabelMasterStatus,
    created_by: (row['created_by'] as string | null) ?? null,
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

// ---------------------------------------------------------------------------
// Story 8.7 write-path accessors (version-control CRUD + DOA approval, BSD-4)
// ---------------------------------------------------------------------------

/**
 * Story 8.7: created_by is the drafting actor, captured at draft time so the approval applier can
 * enforce drafter-is-not-approver segregation of duties without replaying the drafting event.
 */
export async function insertLabelDraft(
  labelId: string,
  sku: string,
  labelVersion: string,
  createdBy: string,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `INSERT INTO label_master (label_id, sku, label_version, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4)`,
    [labelId, sku, labelVersion, createdBy],
  );
}

export async function getLabelMasterById(
  labelId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<LabelMasterRow | null> {
  if (forUpdate) requireTransaction(client, 'getLabelMasterById');
  const result = await runner(client).query(
    `SELECT ${LABEL_MASTER_COLUMNS} FROM label_master WHERE label_id = $1${forUpdate ? FOR_UPDATE : ''}`,
    [labelId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function listLabelMasters(
  sku?: string,
  limit = 100,
  offset = 0,
  client?: PoolClient,
): Promise<LabelMasterRow[]> {
  const result = sku
    ? await runner(client).query(
        `SELECT ${LABEL_MASTER_COLUMNS} FROM label_master WHERE sku = $1
          ORDER BY created_at DESC, label_id LIMIT $2 OFFSET $3`,
        [sku, limit, offset],
      )
    : await runner(client).query(
        `SELECT ${LABEL_MASTER_COLUMNS} FROM label_master
          ORDER BY created_at DESC, label_id LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function approveLabelVersion(
  labelId: string,
  approvedBy: string,
  approvedAt: string,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `UPDATE label_master SET status = 'approved', approved_by = $2, approved_at = $3
      WHERE label_id = $1`,
    [labelId, approvedBy, approvedAt],
  );
}

/** Flips the previously-approved row for the sku (if any, excluding labelId) to 'superseded'. */
export async function supersedeApprovedLabel(
  sku: string,
  excludeLabelId: string,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `UPDATE label_master SET status = 'superseded'
      WHERE sku = $1 AND status = 'approved' AND label_id <> $2`,
    [sku, excludeLabelId],
  );
}

/**
 * The row occupying the uq_label_master_version grain (sku + case-folded, trimmed version). Used
 * by the store's 23505 race arm to report the conflicting row's identity.
 */
export async function findLabelMasterByVersion(
  sku: string,
  labelVersion: string,
  client?: PoolClient,
): Promise<LabelMasterRow | null> {
  const result = await runner(client).query(
    `SELECT ${LABEL_MASTER_COLUMNS} FROM label_master
      WHERE sku = $1 AND lower(btrim(label_version)) = lower(btrim($2))
      LIMIT 1`,
    [sku, labelVersion],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}
