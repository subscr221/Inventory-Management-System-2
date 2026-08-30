import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.4 accessor for the qc_batch_release projection (FR-Q-07, AC 1, AC 3, AC 6 and AC 7).
 * One release record per lot, created by qc.batch_release_recorded on top of an already-decided
 * accept/conditional_release disposition (Binding Scope Decision 1).
 *
 * Append-only: there is no revision, amendment or retraction concept in this story, so this module
 * exposes an insert and reads and NO update path. uq_qc_batch_release_lot /
 * uq_qc_batch_release_disposition are the concurrency backstops (23505 resolves to 409
 * RELEASE_EXISTS in the store's constraint chain).
 *
 * DATE columns are read back as text so a calendar date never round-trips through a JS Date.
 */

export const QC_DOCUMENT_KINDS = ['coa', 'coc'] as const;
export type QcDocumentKind = (typeof QC_DOCUMENT_KINDS)[number];

export interface QcBatchReleaseRow {
  release_id: string;
  lot_id: string;
  task_id: string;
  disposition_id: string;
  document_kind: QcDocumentKind;
  /** Binding Scope Decision 5: the future document-store key; this story always writes null. */
  document_ref: string | null;
  retention_years: number;
  retention_expires_on: string;
  /** Binding Scope Decision 2: null until Story 8.7's BIS licence register lands. */
  bis_licence_number: string | null;
  released_by: string;
  released_at: string;
  source_event_id: string;
  created_at: string;
}

export type InsertQcBatchReleaseRow = Pick<
  QcBatchReleaseRow,
  | 'release_id'
  | 'lot_id'
  | 'task_id'
  | 'disposition_id'
  | 'document_kind'
  | 'retention_years'
  | 'retention_expires_on'
  | 'bis_licence_number'
  | 'released_by'
  | 'released_at'
  | 'source_event_id'
>;

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELEASE_COLUMNS = `release_id, lot_id, task_id, disposition_id, document_kind, document_ref,
    retention_years, retention_expires_on::text AS retention_expires_on, bis_licence_number,
    released_by, released_at, source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): QcBatchReleaseRow {
  return {
    release_id: row['release_id'] as string,
    lot_id: row['lot_id'] as string,
    task_id: row['task_id'] as string,
    disposition_id: row['disposition_id'] as string,
    document_kind: row['document_kind'] as QcDocumentKind,
    document_ref: (row['document_ref'] as string | null) ?? null,
    retention_years: Number(row['retention_years']),
    retention_expires_on: String(row['retention_expires_on']),
    bis_licence_number: (row['bis_licence_number'] as string | null) ?? null,
    released_by: row['released_by'] as string,
    released_at: toIso(row['released_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function insertQcBatchRelease(
  row: InsertQcBatchReleaseRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_batch_release (release_id, lot_id, task_id, disposition_id, document_kind,
       document_ref, retention_years, retention_expires_on, bis_licence_number, released_by,
       released_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::date, $8, $9, $10, $11)`,
    [
      row.release_id,
      row.lot_id,
      row.task_id,
      row.disposition_id,
      row.document_kind,
      row.retention_years,
      row.retention_expires_on,
      row.bis_licence_number,
      row.released_by,
      row.released_at,
      row.source_event_id,
    ],
  );
}

export async function getQcBatchReleaseByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<QcBatchReleaseRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${RELEASE_COLUMNS} FROM qc_batch_release WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}
