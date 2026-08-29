import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.2 accessors for the append-only qc_inspection_result projection (FR-Q-03, FR-Q-04). One
 * immutable row per (task, characteristic, sample unit); uq_qc_inspection_result_unit is the
 * concurrency backstop (23505 resolves to 409 QC_RESULT_EXISTS in the store's constraint chain).
 * app_user holds INSERT and SELECT only. Measured values are read back as text so a NUMERIC never
 * round-trips through a JS float.
 */

export type QcResultKind = 'numeric' | 'attribute';
export type QcCharacteristicClass = 'critical' | 'major' | 'minor';

export interface QcInspectionResultRow {
  result_id: string;
  task_id: string;
  lot_id: string;
  characteristic_id: string;
  characteristic_class: QcCharacteristicClass;
  sample_unit_no: number;
  result_kind: QcResultKind;
  measured_value: string | null;
  measured_uom: string | null;
  attribute_conforms: boolean | null;
  conforms: boolean;
  instrument_asset_id: string | null;
  instrument_id: string | null;
  recorded_by: string;
  recorded_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `result_id, task_id, lot_id, characteristic_id, characteristic_class, sample_unit_no, result_kind,
    measured_value::text AS measured_value, measured_uom, attribute_conforms, conforms, instrument_asset_id,
    instrument_id, recorded_by, recorded_at, source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): QcInspectionResultRow {
  return {
    result_id: row['result_id'] as string,
    task_id: row['task_id'] as string,
    lot_id: row['lot_id'] as string,
    characteristic_id: row['characteristic_id'] as string,
    characteristic_class: row['characteristic_class'] as QcCharacteristicClass,
    sample_unit_no: Number(row['sample_unit_no']),
    result_kind: row['result_kind'] as QcResultKind,
    measured_value: (row['measured_value'] as string | null) ?? null,
    measured_uom: (row['measured_uom'] as string | null) ?? null,
    attribute_conforms: (row['attribute_conforms'] as boolean | null) ?? null,
    conforms: row['conforms'] === true,
    instrument_asset_id: (row['instrument_asset_id'] as string | null) ?? null,
    instrument_id: (row['instrument_id'] as string | null) ?? null,
    recorded_by: row['recorded_by'] as string,
    recorded_at: toIso(row['recorded_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export type InsertQcInspectionResultRow = Omit<QcInspectionResultRow, 'created_at'>;

/** Inserts the rows of ONE result event in reading order; the unique constraint backstops races. */
export async function insertQcInspectionResults(
  rows: InsertQcInspectionResultRow[],
  client: PoolClient,
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO qc_inspection_result (result_id, task_id, lot_id, characteristic_id, characteristic_class,
         sample_unit_no, result_kind, measured_value, measured_uom, attribute_conforms, conforms,
         instrument_asset_id, instrument_id, recorded_by, recorded_at, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        row.result_id,
        row.task_id,
        row.lot_id,
        row.characteristic_id,
        row.characteristic_class,
        row.sample_unit_no,
        row.result_kind,
        row.measured_value,
        row.measured_uom,
        row.attribute_conforms,
        row.conforms,
        row.instrument_asset_id,
        row.instrument_id,
        row.recorded_by,
        row.recorded_at,
        row.source_event_id,
      ],
    );
  }
}

export interface ListQcInspectionResultsFilters {
  characteristic_id?: string | undefined;
  sample_unit_no?: number | undefined;
  conforms?: boolean | undefined;
  source_event_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listQcInspectionResults(
  taskId: string,
  filters: ListQcInspectionResultsFilters,
  client?: PoolClient,
): Promise<QcInspectionResultRow[]> {
  if (!UUID_REGEX.test(taskId)) return [];
  const where: string[] = ['task_id = $1'];
  const values: unknown[] = [taskId];
  const push = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };
  if (filters.characteristic_id) push('characteristic_id = ?', filters.characteristic_id);
  if (filters.sample_unit_no !== undefined) push('sample_unit_no = ?', filters.sample_unit_no);
  if (filters.conforms !== undefined) push('conforms = ?', filters.conforms);
  if (filters.source_event_id) push('source_event_id = ?', filters.source_event_id);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);
  values.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM qc_inspection_result
      WHERE ${where.join(' AND ')}
      ORDER BY characteristic_id ASC, sample_unit_no ASC, result_id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map(mapRow);
}

/** Per-characteristic count of recorded units and the set of unit numbers recorded. */
export async function countResultsByCharacteristic(
  taskId: string,
  client: PoolClient,
): Promise<Map<string, { recorded: number; units: number[] }>> {
  const result = await client.query(
    `SELECT characteristic_id, count(*)::int AS recorded,
            array_agg(sample_unit_no ORDER BY sample_unit_no) AS units
       FROM qc_inspection_result WHERE task_id = $1 GROUP BY characteristic_id`,
    [taskId],
  );
  const out = new Map<string, { recorded: number; units: number[] }>();
  for (const row of result.rows) {
    out.set(row['characteristic_id'] as string, {
      recorded: row['recorded'] as number,
      units: (row['units'] as number[]).map((u) => Number(u)),
    });
  }
  return out;
}

export interface NonconformingUnit {
  sample_unit_no: number;
  critical: boolean;
}

/** Every sample unit with at least one nonconforming result, flagged when a critical result is among them. */
export async function listNonconformingUnits(
  taskId: string,
  client: PoolClient,
): Promise<NonconformingUnit[]> {
  const result = await client.query(
    `SELECT sample_unit_no,
            bool_or(characteristic_class = 'critical') AS critical
       FROM qc_inspection_result
      WHERE task_id = $1 AND conforms = false
      GROUP BY sample_unit_no ORDER BY sample_unit_no ASC`,
    [taskId],
  );
  return result.rows.map((row) => ({
    sample_unit_no: Number(row['sample_unit_no']),
    critical: row['critical'] === true,
  }));
}

/**
 * The recorders of a task's results, earliest first (by first recorded_at, then result_id), so
 * `ids[0]` is the deterministic inspector_user_id attribution (Binding Scope Decision 12).
 */
export async function listResultRecorderUserIds(
  taskId: string,
  client: PoolClient,
): Promise<string[]> {
  const result = await client.query(
    `SELECT recorded_by, MIN(recorded_at) AS first_at, MIN(result_id::text) AS first_result
       FROM qc_inspection_result WHERE task_id = $1
      GROUP BY recorded_by ORDER BY first_at ASC, first_result ASC`,
    [taskId],
  );
  return result.rows.map((row) => row['recorded_by'] as string);
}
