import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.1 accessors for the immutable qc_deviation evidence and the shared one-row-per-lot
 * qc_lot_disposition projection (FR-Q-05, AC 4, Binding Scope Decisions 3 and 4). Both are
 * append-only (app_user: INSERT, SELECT); the conditional-release applier inserts one deviation and
 * one disposition under the task row's FOR UPDATE lock, and uq_qc_lot_disposition_lot is the race
 * backstop (23505 resolves to 409 DISPOSITION_EXISTS in the store's constraint chain).
 *
 * DATE columns are read back as text so a calendar date never round-trips through a JS Date.
 */

export type QcDeviationScopeKind = 'internal_movement' | 'order_allocation' | 'dispatch';
export type QcDisposition = 'conditional_release' | 'accept' | 'reject' | 'split';
export type QcSamplingOutcomeSnapshot = 'accepted' | 'not_accepted';

export interface QcDeviationRow {
  deviation_id: string;
  task_id: string;
  lot_id: string;
  deviation_type: 'conditional_release';
  justification: string;
  conditions: string;
  scope_kind: QcDeviationScopeKind;
  scope_ref: string;
  decided_on: string;
  expires_on: string;
  requested_by: string;
  approved_by: string;
  doa_entry_id: string;
  decided_at: string;
  source_event_id: string;
  created_at: string;
}

export interface QcLotDispositionRow {
  disposition_id: string;
  lot_id: string;
  task_id: string;
  disposition: QcDisposition;
  deviation_id: string | null;
  plan_version_id: string;
  quantity: string;
  requested_by: string;
  inspector_user_id: string | null;
  approved_by: string;
  /**
   * Story 8.3 (Binding Scope Decision 5): the DOA gate belongs to the conditional-release
   * exception path only, so this is null for accept, reject and split.
   * chk_qc_lot_disposition_doa_pairing enforces the pairing in the database.
   */
  doa_entry_id: string | null;
  decided_at: string;
  source_event_id: string;
  created_at: string;
  /** Story 8.3: the task's sampling outcome at the moment of decision, or null when uninspected. */
  sampling_outcome: QcSamplingOutcomeSnapshot | null;
  /** Story 8.3: the NCR raised by a reject disposition; null for every other disposition. */
  ncr_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEVIATION_COLUMNS = `deviation_id, task_id, lot_id, deviation_type, justification, conditions, scope_kind,
    scope_ref, decided_on::text AS decided_on, expires_on::text AS expires_on, requested_by, approved_by,
    doa_entry_id, decided_at, source_event_id, created_at`;

const DISPOSITION_COLUMNS = `disposition_id, lot_id, task_id, disposition, deviation_id, plan_version_id,
    quantity::text AS quantity, requested_by, inspector_user_id, approved_by, doa_entry_id, decided_at,
    source_event_id, created_at, sampling_outcome, ncr_id`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapDeviation(row: Record<string, unknown>): QcDeviationRow {
  return {
    deviation_id: row['deviation_id'] as string,
    task_id: row['task_id'] as string,
    lot_id: row['lot_id'] as string,
    deviation_type: 'conditional_release',
    justification: row['justification'] as string,
    conditions: row['conditions'] as string,
    scope_kind: row['scope_kind'] as QcDeviationScopeKind,
    scope_ref: row['scope_ref'] as string,
    decided_on: String(row['decided_on']),
    expires_on: String(row['expires_on']),
    requested_by: row['requested_by'] as string,
    approved_by: row['approved_by'] as string,
    doa_entry_id: row['doa_entry_id'] as string,
    decided_at: toIso(row['decided_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

function mapDisposition(row: Record<string, unknown>): QcLotDispositionRow {
  return {
    disposition_id: row['disposition_id'] as string,
    lot_id: row['lot_id'] as string,
    task_id: row['task_id'] as string,
    disposition: row['disposition'] as QcDisposition,
    deviation_id: (row['deviation_id'] as string | null) ?? null,
    plan_version_id: row['plan_version_id'] as string,
    quantity: String(row['quantity']),
    requested_by: row['requested_by'] as string,
    inspector_user_id: (row['inspector_user_id'] as string | null) ?? null,
    approved_by: row['approved_by'] as string,
    doa_entry_id: (row['doa_entry_id'] as string | null) ?? null,
    decided_at: toIso(row['decided_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    sampling_outcome: (row['sampling_outcome'] as QcSamplingOutcomeSnapshot | null) ?? null,
    ncr_id: (row['ncr_id'] as string | null) ?? null,
  };
}

export async function getQcDeviationById(
  deviationId: string,
  client?: PoolClient,
): Promise<QcDeviationRow | null> {
  if (!UUID_REGEX.test(deviationId)) return null;
  const result = await runner(client).query(
    `SELECT ${DEVIATION_COLUMNS} FROM qc_deviation WHERE deviation_id = $1`,
    [deviationId],
  );
  return result.rows.length > 0 ? mapDeviation(result.rows[0]!) : null;
}

export async function insertQcDeviation(
  row: Omit<QcDeviationRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_deviation (deviation_id, task_id, lot_id, deviation_type, justification, conditions,
       scope_kind, scope_ref, decided_on, expires_on, requested_by, approved_by, doa_entry_id, decided_at,
       source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12, $13, $14, $15)`,
    [
      row.deviation_id,
      row.task_id,
      row.lot_id,
      row.deviation_type,
      row.justification,
      row.conditions,
      row.scope_kind,
      row.scope_ref,
      row.decided_on,
      row.expires_on,
      row.requested_by,
      row.approved_by,
      row.doa_entry_id,
      row.decided_at,
      row.source_event_id,
    ],
  );
}

export async function getQcLotDispositionByLotId(
  lotId: string,
  client?: PoolClient,
): Promise<QcLotDispositionRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const result = await runner(client).query(
    `SELECT ${DISPOSITION_COLUMNS} FROM qc_lot_disposition WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapDisposition(result.rows[0]!) : null;
}

export async function getQcLotDispositionById(
  dispositionId: string,
  client?: PoolClient,
): Promise<QcLotDispositionRow | null> {
  if (!UUID_REGEX.test(dispositionId)) return null;
  const result = await runner(client).query(
    `SELECT ${DISPOSITION_COLUMNS} FROM qc_lot_disposition WHERE disposition_id = $1`,
    [dispositionId],
  );
  return result.rows.length > 0 ? mapDisposition(result.rows[0]!) : null;
}

export async function insertQcLotDisposition(
  row: Omit<QcLotDispositionRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_lot_disposition (disposition_id, lot_id, task_id, disposition, deviation_id,
       plan_version_id, quantity, requested_by, inspector_user_id, approved_by, doa_entry_id, decided_at,
       source_event_id, sampling_outcome, ncr_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      row.disposition_id,
      row.lot_id,
      row.task_id,
      row.disposition,
      row.deviation_id,
      row.plan_version_id,
      row.quantity,
      row.requested_by,
      row.inspector_user_id,
      row.approved_by,
      row.doa_entry_id,
      row.decided_at,
      row.source_event_id,
      row.sampling_outcome,
      row.ncr_id,
    ],
  );
}

/**
 * The conditional-release deviation for a lot (the deviation referenced by the lot's disposition
 * row). This returns the stored release regardless of expiry; the unexpired check
 * (business_date < expires_on) is evaluated by assertQcGateAllows against deviation.expires_on,
 * and read consumers must treat expires_on as the authoritative expiry.
 */
export async function getConditionalReleaseForLot(
  lotId: string,
  client?: PoolClient,
): Promise<{ disposition: QcLotDispositionRow; deviation: QcDeviationRow } | null> {
  const disposition = await getQcLotDispositionByLotId(lotId, client);
  if (!disposition || disposition.deviation_id === null) return null;
  const deviation = await getQcDeviationById(disposition.deviation_id, client);
  if (!deviation) return null;
  return { disposition, deviation };
}
