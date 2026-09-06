import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.1 accessors for the QC inspection task, which is ALSO the authoritative QC-gate
 * projection keyed by lot (FR-Q-02, Binding Scope Decision 2). The task row is inserted by the
 * completion applier inside the producer's transaction; the gate transition is the only UPDATE and
 * runs under the row's FOR UPDATE lock (app_user holds UPDATE on this table alone in the family).
 *
 * QC_GATE_BLOCKED_STATUSES is the vocabulary every lot-consumption path treats as "not released":
 * both Story 8.1 states plus the two terminal Story 8.3 states. 'accepted' is the ONE gate status
 * that leaves this set (Story 8.3 Binding Scope Decision 3); 'rejected' blocks because the lot is
 * pending its NCR outcome, and 'split' blocks because the parent's quantity now lives on its
 * children. Never write a gate-status literal outside this module - splice these constants.
 *
 * qcGateExclusionSql is the SQL predicate the Epic 2 ledger helpers splice into their drain windows
 * (Task 6): a stock_balance row whose lot_id (the lot NUMBER) belongs to a lot with a gated task is
 * invisible to a lot-less drain, so replenishment and backflush - which never name a lot - cannot
 * silently consume held finished goods. Callers that ran assertQcGateAllows on a specific lot pass
 * qc_gate_cleared so a permitted conditionally-released internal movement is not re-excluded.
 */

export type QcGateStatus = 'qc_hold' | 'conditionally_released' | 'accepted' | 'rejected' | 'split';
/** Story 8.2 (Binding Scope Decision 5): the inspection axis, independent of the gate axis. */
export type QcTaskStatus = 'open' | 'sampling_determined' | 'inspected';
export type QcSamplingOutcome = 'accepted' | 'not_accepted';
export type QcSourceCompletionType = 'synthetic_completion' | 'production_order' | 'job_work_order';

export const QC_GATE_BLOCKED_STATUSES: readonly QcGateStatus[] = [
  'qc_hold',
  'conditionally_released',
  'rejected',
  'split',
];

/**
 * The blocked states that a per-lot assertQcGateAllows pass can NOT clear. A conditional release is
 * clearable (the deviation names the movement); a hold, a rejection and a split are not.
 */
export const QC_GATE_HARD_BLOCKED_STATUSES: readonly QcGateStatus[] =
  QC_GATE_BLOCKED_STATUSES.filter((status) => status !== 'conditionally_released');

export interface QcInspectionTaskRow {
  task_id: string;
  lot_id: string;
  lot_number: string;
  source_completion_type: QcSourceCompletionType;
  source_completion_id: string;
  item_id: string;
  sku: string;
  quantity: string;
  uom: string;
  site_id: string;
  bom_revision_id: string;
  plan_id: string;
  plan_version_id: string;
  plan_scope: 'standard' | 'customer_override';
  source_order_type: 'job_work_order' | null;
  source_order_ref: string | null;
  completed_at: string;
  business_date: string;
  task_status: QcTaskStatus;
  gate_status: QcGateStatus;
  gate_changed_at: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
  /** Story 8.2 additive columns: null until sampling is determined / inspection completes. */
  sampling_id: string | null;
  sampling_outcome: QcSamplingOutcome | null;
  nonconforming_sample_units: number | null;
  critical_nonconformities: number | null;
  inspected_by: string | null;
  inspected_at: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_COLUMNS = `task_id, lot_id, lot_number, source_completion_type, source_completion_id, item_id, sku,
    quantity::text AS quantity, uom, site_id, bom_revision_id, plan_id, plan_version_id, plan_scope,
    source_order_type, source_order_ref, completed_at, business_date::text AS business_date, task_status,
    gate_status, gate_changed_at, source_event_id, created_at, updated_at, sampling_id, sampling_outcome,
    nonconforming_sample_units, critical_nonconformities, inspected_by, inspected_at`;

function mapTask(row: Record<string, unknown>): QcInspectionTaskRow {
  const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  const toNullableIso = (v: unknown): string | null =>
    v === null || v === undefined ? null : toIso(v);
  const toNullableInt = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    task_id: row['task_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    source_completion_type: row['source_completion_type'] as QcSourceCompletionType,
    source_completion_id: row['source_completion_id'] as string,
    item_id: row['item_id'] as string,
    sku: row['sku'] as string,
    quantity: String(row['quantity']),
    uom: row['uom'] as string,
    site_id: row['site_id'] as string,
    bom_revision_id: row['bom_revision_id'] as string,
    plan_id: row['plan_id'] as string,
    plan_version_id: row['plan_version_id'] as string,
    plan_scope: row['plan_scope'] as 'standard' | 'customer_override',
    source_order_type: (row['source_order_type'] as 'job_work_order' | null) ?? null,
    source_order_ref: (row['source_order_ref'] as string | null) ?? null,
    completed_at: toIso(row['completed_at']),
    business_date: String(row['business_date']),
    task_status: row['task_status'] as QcTaskStatus,
    gate_status: row['gate_status'] as QcGateStatus,
    gate_changed_at: toIso(row['gate_changed_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
    updated_at: toIso(row['updated_at']),
    sampling_id: (row['sampling_id'] as string | null) ?? null,
    sampling_outcome: (row['sampling_outcome'] as QcSamplingOutcome | null) ?? null,
    nonconforming_sample_units: toNullableInt(row['nonconforming_sample_units']),
    critical_nonconformities: toNullableInt(row['critical_nonconformities']),
    inspected_by: (row['inspected_by'] as string | null) ?? null,
    inspected_at: toNullableIso(row['inspected_at']),
  };
}

export async function getQcInspectionTaskById(
  taskId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<QcInspectionTaskRow | null> {
  if (!UUID_REGEX.test(taskId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${TASK_COLUMNS} FROM qc_inspection_task WHERE task_id = $1${lockClause}`,
    [taskId],
  );
  return result.rows.length > 0 ? mapTask(result.rows[0]!) : null;
}

export async function getQcInspectionTaskByLotId(
  lotId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<QcInspectionTaskRow | null> {
  if (!UUID_REGEX.test(lotId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${TASK_COLUMNS} FROM qc_inspection_task WHERE lot_id = $1${lockClause}`,
    [lotId],
  );
  return result.rows.length > 0 ? mapTask(result.rows[0]!) : null;
}

export async function getQcInspectionTaskBySource(
  sourceCompletionType: string,
  sourceCompletionId: string,
  client?: PoolClient,
): Promise<QcInspectionTaskRow | null> {
  if (!UUID_REGEX.test(sourceCompletionId)) return null;
  const result = await runner(client).query(
    `SELECT ${TASK_COLUMNS} FROM qc_inspection_task
      WHERE source_completion_type = $1 AND source_completion_id = $2`,
    [sourceCompletionType, sourceCompletionId],
  );
  return result.rows.length > 0 ? mapTask(result.rows[0]!) : null;
}

export interface ListQcInspectionTasksParams {
  gate_status?: QcGateStatus | undefined;
  task_status?: QcTaskStatus | undefined;
  site_id?: string | undefined;
  /** Story 8.2 (Binding Scope Decision 10): the caller's permitted sites when not wildcard-scoped. */
  site_ids?: string[] | undefined;
  sku?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listQcInspectionTasks(
  params: ListQcInspectionTasksParams,
  client?: PoolClient,
): Promise<QcInspectionTaskRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (params.gate_status) push('gate_status = ?', params.gate_status);
  if (params.task_status) push('task_status = ?', params.task_status);
  if (params.site_id) push('site_id = ?', params.site_id);
  if (params.site_ids) push('site_id = ANY(?::uuid[])', params.site_ids);
  if (params.sku) push('sku = ?', params.sku);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${TASK_COLUMNS} FROM qc_inspection_task
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY business_date ASC, created_at ASC, task_id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map(mapTask);
}

export type InsertQcInspectionTaskRow = Omit<
  QcInspectionTaskRow,
  | 'task_status'
  | 'gate_status'
  | 'created_at'
  | 'updated_at'
  | 'sampling_id'
  | 'sampling_outcome'
  | 'nonconforming_sample_units'
  | 'critical_nonconformities'
  | 'inspected_by'
  | 'inspected_at'
>;

export async function insertQcInspectionTask(
  row: InsertQcInspectionTaskRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_inspection_task (task_id, lot_id, lot_number, source_completion_type,
       source_completion_id, item_id, sku, quantity, uom, site_id, bom_revision_id, plan_id,
       plan_version_id, plan_scope, source_order_type, source_order_ref, completed_at, business_date,
       task_status, gate_status, gate_changed_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18::date, 'open', 'qc_hold', $19, $20)`,
    [
      row.task_id,
      row.lot_id,
      row.lot_number,
      row.source_completion_type,
      row.source_completion_id,
      row.item_id,
      row.sku,
      row.quantity,
      row.uom,
      row.site_id,
      row.bom_revision_id,
      row.plan_id,
      row.plan_version_id,
      row.plan_scope,
      row.source_order_type,
      row.source_order_ref,
      row.completed_at,
      row.business_date,
      row.gate_changed_at,
      row.source_event_id,
    ],
  );
}

/**
 * The gate transition, guarded on the expected current state so a lost race is a 0-row update the
 * applier rejects (never a silent no-op). Returns the affected row count.
 */
export async function transitionQcGate(
  taskId: string,
  fromStatus: QcGateStatus,
  toStatus: QcGateStatus,
  changedAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE qc_inspection_task
        SET gate_status = $3, gate_changed_at = $4, updated_at = now()
      WHERE task_id = $1 AND gate_status = $2`,
    [taskId, fromStatus, toStatus, changedAt],
  );
  return result.rowCount ?? 0;
}

export interface QcTaskStatusPatch {
  sampling_id?: string;
  sampling_outcome?: QcSamplingOutcome;
  nonconforming_sample_units?: number;
  critical_nonconformities?: number;
  inspected_by?: string;
  inspected_at?: string;
}

/**
 * Story 8.2: the inspection-axis transition, a compare-and-set on the expected current
 * task_status (modeled on transitionQcGate) so a lost race is a 0-row update the applier rejects.
 * `patch` writes the Story 8.2 additive columns in the same statement. Returns the row count.
 */
export async function transitionQcTaskStatus(
  taskId: string,
  fromStatus: QcTaskStatus,
  toStatus: QcTaskStatus,
  patch: QcTaskStatusPatch,
  client: PoolClient,
): Promise<number> {
  const sets: string[] = ['task_status = $3', 'updated_at = now()'];
  const values: unknown[] = [taskId, fromStatus, toStatus];
  const set = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.sampling_id !== undefined) set('sampling_id', patch.sampling_id);
  if (patch.sampling_outcome !== undefined) set('sampling_outcome', patch.sampling_outcome);
  if (patch.nonconforming_sample_units !== undefined) {
    set('nonconforming_sample_units', patch.nonconforming_sample_units);
  }
  if (patch.critical_nonconformities !== undefined) {
    set('critical_nonconformities', patch.critical_nonconformities);
  }
  if (patch.inspected_by !== undefined) set('inspected_by', patch.inspected_by);
  if (patch.inspected_at !== undefined) set('inspected_at', patch.inspected_at);
  const result = await client.query(
    `UPDATE qc_inspection_task SET ${sets.join(', ')} WHERE task_id = $1 AND task_status = $2`,
    values,
  );
  return result.rowCount ?? 0;
}

/**
 * The drain-window predicate for the Epic 2 ledger helpers (Task 6). `alias` is the stock_balance
 * alias in the enclosing statement (always the literal 'stock_balance'); its `lot_id` column is the
 * lot NUMBER (stock_balance.ts lot_id), so the match is on `qt.lot_number` only. The predicate is
 * true for rows whose lot is NOT under a blocked QC gate. When `cleared` is true the caller has
 * already run assertQcGateAllows on the specific lot and only the hard qc_hold state is re-excluded
 * (defense in depth).
 */
export function qcGateExclusionSql(alias: string, cleared: boolean): string {
  const vocabulary = cleared ? QC_GATE_HARD_BLOCKED_STATUSES : QC_GATE_BLOCKED_STATUSES;
  const statuses = `(${vocabulary.map((status) => `'${status}'`).join(', ')})`;
  return `NOT EXISTS (
      SELECT 1 FROM qc_inspection_task qt
       WHERE qt.lot_number = ${alias}.lot_id
         AND qt.sku = ${alias}.sku AND qt.gate_status IN ${statuses}
    )`;
}
