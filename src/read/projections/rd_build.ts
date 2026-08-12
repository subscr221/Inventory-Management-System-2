import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * R&D draft-BOM build record accessors (Story 5.4, FR-B-10). Reads serve the build endpoints in
 * src/api/v1/rd-boms.ts; write helpers are called exclusively by the rd_build.* appliers in
 * src/compliance/rd-bom.ts inside the persistEvent transaction.
 */

export interface RdBuildRecordRow {
  build_id: string;
  bom_id: string;
  revision_id: string;
  build_ref: string;
  status: 'recorded' | 'confirmed';
  built_quantity: string;
  built_uom: string;
  notes: string | null;
  outcome: 'success' | 'failed' | 'abandoned' | null;
  recorded_by: string;
  recorded_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface RdAsBuiltLineRow {
  as_built_line_id: string;
  build_id: string;
  line_no: number;
  draft_bom_line_id: string | null;
  component_item_id: string | null;
  component_sku: string | null;
  is_placeholder: boolean;
  free_text: string | null;
  quantity_used: string;
  line_uom: string;
  deviation_flag: boolean;
  deviation_kind: 'quantity' | 'substitution' | 'extra' | 'missing' | 'placeholder' | null;
  deviation_detail: string | null;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getBuildById(
  buildId: string,
  client?: PoolClient,
): Promise<RdBuildRecordRow | null> {
  if (!UUID_REGEX.test(buildId)) return null;
  const r = runner(client);
  const result = await r.query(`SELECT * FROM rd_build_record WHERE build_id = $1`, [buildId]);
  return (result.rows[0] as RdBuildRecordRow) ?? null;
}

export interface ListRdBuildsParams {
  bomId?: string | undefined;
  status?: RdBuildRecordRow['status'] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listBuilds(
  params: ListRdBuildsParams,
  client?: PoolClient,
): Promise<{ rows: RdBuildRecordRow[]; total: number; limit: number; offset: number }> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.bomId) {
    conditions.push(`bom_id = $${idx++}`);
    values.push(params.bomId);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Clamped values are what callers must echo back - pagination metadata must never lie.
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const countResult = await r.query(
    `SELECT COUNT(*) as total FROM rd_build_record ${where}`,
    values,
  );
  const total = Number(countResult.rows[0]!.total);

  values.push(limit, offset);
  const result = await r.query(
    `SELECT * FROM rd_build_record ${where} ORDER BY recorded_at DESC, build_id LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );

  return { rows: result.rows as RdBuildRecordRow[], total, limit, offset };
}

export async function getAsBuiltLines(
  buildId: string,
  client?: PoolClient,
): Promise<RdAsBuiltLineRow[]> {
  if (!UUID_REGEX.test(buildId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM rd_as_built_line WHERE build_id = $1 ORDER BY line_no ASC`,
    [buildId],
  );
  return result.rows as RdAsBuiltLineRow[];
}

export async function insertBuildRecord(
  row: Omit<RdBuildRecordRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_build_record (build_id, bom_id, revision_id, build_ref, status, built_quantity, built_uom, notes, outcome, recorded_by, recorded_at, confirmed_by, confirmed_at, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      row.build_id,
      row.bom_id,
      row.revision_id,
      row.build_ref,
      row.status,
      row.built_quantity,
      row.built_uom,
      row.notes,
      row.outcome,
      row.recorded_by,
      row.recorded_at,
      row.confirmed_by,
      row.confirmed_at,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function insertAsBuiltLine(
  row: Omit<RdAsBuiltLineRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO rd_as_built_line (as_built_line_id, build_id, line_no, draft_bom_line_id, component_item_id, component_sku, is_placeholder, free_text, quantity_used, line_uom, deviation_flag, deviation_kind, deviation_detail, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.as_built_line_id,
      row.build_id,
      row.line_no,
      row.draft_bom_line_id,
      row.component_item_id,
      row.component_sku,
      row.is_placeholder,
      row.free_text,
      row.quantity_used,
      row.line_uom,
      row.deviation_flag,
      row.deviation_kind,
      row.deviation_detail,
      row.source_event_id,
    ],
  );
}

export async function updateAsBuiltDeviation(
  asBuiltLineId: string,
  deviationFlag: boolean,
  deviationKind: RdAsBuiltLineRow['deviation_kind'],
  deviationDetail: string | null,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_as_built_line SET deviation_flag = $1, deviation_kind = $2, deviation_detail = $3 WHERE as_built_line_id = $4`,
    [deviationFlag, deviationKind, deviationDetail, asBuiltLineId],
  );
}

export async function confirmBuildRecord(
  buildId: string,
  confirmedAt: string,
  confirmedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE rd_build_record SET status = 'confirmed', confirmed_at = $1, confirmed_by = $2, updated_at = now() WHERE build_id = $3`,
    [confirmedAt, confirmedBy, buildId],
  );
}
