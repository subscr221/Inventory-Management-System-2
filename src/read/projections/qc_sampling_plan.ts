import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.2 accessors for the sampling plan frozen on a QC inspection task (FR-Q-03, AC 1). One
 * append-only row per task (uq_qc_sampling_plan_task); the seam inserts it under the lot and task
 * row locks and every later determination for the same task replays it. app_user holds INSERT and
 * SELECT only, so `forUpdate` is only meaningful on the task row the caller already holds; it is
 * accepted here for call-site symmetry and issues a plain SELECT when the grant is absent.
 *
 * NUMERIC columns are read back as text so an AQL never round-trips through a JS float.
 */

export type SamplingSeverity = 'normal' | 'tightened' | 'reduced';
export type SamplingBasis = 'aql_table' | 'full_inspection';

export interface QcSamplingPlanRow {
  sampling_id: string;
  task_id: string;
  lot_id: string;
  lot_number: string;
  plan_version_id: string;
  plan_id: string;
  site_id: string;
  lot_size: number;
  aql: string | null;
  inspection_level: string | null;
  severity: SamplingSeverity;
  code_letter: string | null;
  resolved_code_letter: string | null;
  sample_size: number;
  acceptance_number: number | null;
  rejection_number: number | null;
  sampling_basis: SamplingBasis;
  standard_ref: string;
  critical_characteristic_count: number;
  determined_by: string;
  determined_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `sampling_id, task_id, lot_id, lot_number, plan_version_id, plan_id, site_id, lot_size,
    aql::text AS aql, inspection_level, severity, code_letter, resolved_code_letter, sample_size,
    acceptance_number, rejection_number, sampling_basis, standard_ref, critical_characteristic_count,
    determined_by, determined_at, source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toNullableInt = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function mapRow(row: Record<string, unknown>): QcSamplingPlanRow {
  return {
    sampling_id: row['sampling_id'] as string,
    task_id: row['task_id'] as string,
    lot_id: row['lot_id'] as string,
    lot_number: row['lot_number'] as string,
    plan_version_id: row['plan_version_id'] as string,
    plan_id: row['plan_id'] as string,
    site_id: row['site_id'] as string,
    lot_size: Number(row['lot_size']),
    aql: (row['aql'] as string | null) ?? null,
    inspection_level: (row['inspection_level'] as string | null) ?? null,
    severity: row['severity'] as SamplingSeverity,
    code_letter: (row['code_letter'] as string | null) ?? null,
    resolved_code_letter: (row['resolved_code_letter'] as string | null) ?? null,
    sample_size: Number(row['sample_size']),
    acceptance_number: toNullableInt(row['acceptance_number']),
    rejection_number: toNullableInt(row['rejection_number']),
    sampling_basis: row['sampling_basis'] as SamplingBasis,
    standard_ref: row['standard_ref'] as string,
    critical_characteristic_count: Number(row['critical_characteristic_count']),
    determined_by: row['determined_by'] as string,
    determined_at: toIso(row['determined_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function getQcSamplingPlanByTaskId(
  taskId: string,
  client?: PoolClient,
  _forUpdate: boolean = false,
): Promise<QcSamplingPlanRow | null> {
  if (!UUID_REGEX.test(taskId)) return null;
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM qc_sampling_plan WHERE task_id = $1`,
    [taskId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getQcSamplingPlanById(
  samplingId: string,
  client?: PoolClient,
): Promise<QcSamplingPlanRow | null> {
  if (!UUID_REGEX.test(samplingId)) return null;
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM qc_sampling_plan WHERE sampling_id = $1`,
    [samplingId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export type InsertQcSamplingPlanRow = Omit<QcSamplingPlanRow, 'created_at'>;

export async function insertQcSamplingPlan(
  row: InsertQcSamplingPlanRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_sampling_plan (sampling_id, task_id, lot_id, lot_number, plan_version_id, plan_id,
       site_id, lot_size, aql, inspection_level, severity, code_letter, resolved_code_letter, sample_size,
       acceptance_number, rejection_number, sampling_basis, standard_ref, critical_characteristic_count,
       determined_by, determined_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22)`,
    [
      row.sampling_id,
      row.task_id,
      row.lot_id,
      row.lot_number,
      row.plan_version_id,
      row.plan_id,
      row.site_id,
      row.lot_size,
      row.aql,
      row.inspection_level,
      row.severity,
      row.code_letter,
      row.resolved_code_letter,
      row.sample_size,
      row.acceptance_number,
      row.rejection_number,
      row.sampling_basis,
      row.standard_ref,
      row.critical_characteristic_count,
      row.determined_by,
      row.determined_at,
      row.source_event_id,
    ],
  );
}
