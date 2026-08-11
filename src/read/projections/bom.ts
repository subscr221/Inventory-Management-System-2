import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface BomRow {
  bom_id: string;
  parent_item_id: string;
  parent_sku: string;
  parent_uom: string;
  business_stream: string;
  bom_type: 'production' | 'rnd' | 'job_work_kit';
  status: 'draft' | 'released' | 'on_hold' | 'obsolete';
  current_revision_id: string | null;
  blocking_line_count: number;
  status_changed_at: string | null;
  status_changed_by: string | null;
  origin: 'native' | 'legacy_kit';
  remediation_flag: boolean;
  kit_ref: string | null;
  created_by: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface BomRevisionRow {
  revision_id: string;
  bom_id: string;
  revision_code: string;
  revision_status: 'draft' | 'released';
  drafted_by: string;
  drafted_at: string;
  released_at: string | null;
  released_by: string | null;
  source_eco_id: string | null;
  source_event_id: string;
}

export interface BomLineRow {
  bom_line_id: string;
  revision_id: string;
  bom_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string;
  output_class: 'component' | 'co_product' | 'by_product';
  quantity_per: string;
  line_uom: string;
  uom_conversion_factor: string;
  base_quantity_per: string;
  scrap_percent: string | null;
  expected_yield_percent: string | null;
  is_phantom: boolean;
  phantom_source_bom_id: string | null;
  effective_from: string;
  effective_to: string | null;
  blocking_release: boolean;
  blocking_reason: string | null;
  amended_at: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface BomStructureRow {
  structure_id: string;
  bom_id: string;
  revision_id: string;
  root_bom_line_id: string | null;
  path: string;
  depth: number;
  component_item_id: string;
  component_sku: string;
  output_class: 'component' | 'co_product' | 'by_product';
  effective_quantity_per: string;
  effective_scrap_percent: string | null;
  via_phantom: boolean;
  effective_from: string;
  effective_to: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getBomById(
  bomId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<BomRow | null> {
  if (!UUID_REGEX.test(bomId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM bom WHERE bom_id = $1${lockClause}`, [bomId]);
  return (result.rows[0] as BomRow) ?? null;
}

export async function getBomByParentItemId(
  parentItemId: string,
  client?: PoolClient,
): Promise<BomRow | null> {
  if (!UUID_REGEX.test(parentItemId)) return null;
  const r = runner(client);
  const result = await r.query(`SELECT * FROM bom WHERE parent_item_id = $1`, [parentItemId]);
  return (result.rows[0] as BomRow) ?? null;
}

export async function getBomRevisionById(
  revisionId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<BomRevisionRow | null> {
  if (!UUID_REGEX.test(revisionId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM bom_revision WHERE revision_id = $1${lockClause}`, [
    revisionId,
  ]);
  return (result.rows[0] as BomRevisionRow) ?? null;
}

export async function getBomRevisionByBomId(
  bomId: string,
  client?: PoolClient,
): Promise<BomRevisionRow[]> {
  if (!UUID_REGEX.test(bomId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM bom_revision WHERE bom_id = $1 ORDER BY drafted_at ASC`,
    [bomId],
  );
  return result.rows as BomRevisionRow[];
}

export async function getBomLines(revisionId: string, client?: PoolClient): Promise<BomLineRow[]> {
  if (!UUID_REGEX.test(revisionId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM bom_line WHERE revision_id = $1 ORDER BY line_no ASC`,
    [revisionId],
  );
  return result.rows as BomLineRow[];
}

export async function getBomLineById(
  bomLineId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<BomLineRow | null> {
  if (!UUID_REGEX.test(bomLineId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM bom_line WHERE bom_line_id = $1${lockClause}`, [
    bomLineId,
  ]);
  return (result.rows[0] as BomLineRow) ?? null;
}

export async function getBomStructure(
  revisionId: string,
  client?: PoolClient,
): Promise<BomStructureRow[]> {
  if (!UUID_REGEX.test(revisionId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM bom_structure WHERE revision_id = $1 ORDER BY path ASC`,
    [revisionId],
  );
  return result.rows as BomStructureRow[];
}

export async function getBlockingLineCount(bomId: string, client?: PoolClient): Promise<number> {
  if (!UUID_REGEX.test(bomId)) return 0;
  const r = runner(client);
  const result = await r.query(
    `SELECT COUNT(*) as cnt FROM bom_line WHERE bom_id = $1 AND blocking_release = true`,
    [bomId],
  );
  return Number(result.rows[0]!.cnt);
}

export interface ListBomsParams {
  status?: BomRow['status'] | undefined;
  businessStream?: string | undefined;
  origin?: BomRow['origin'] | undefined;
  remediationFlag?: boolean | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listBoms(
  params: ListBomsParams,
  client?: PoolClient,
): Promise<{ rows: BomRow[]; total: number }> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.businessStream) {
    conditions.push(`business_stream = $${idx++}`);
    values.push(params.businessStream);
  }
  if (params.origin) {
    conditions.push(`origin = $${idx++}`);
    values.push(params.origin);
  }
  if (params.remediationFlag !== undefined) {
    conditions.push(`remediation_flag = $${idx++}`);
    values.push(params.remediationFlag);
  }
  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(`(parent_sku ILIKE $${idx++} OR parent_item_id::text ILIKE $${idx++})`);
    values.push(`%${escaped}%`, `%${escaped}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 200, 200);
  const offset = params.offset ?? 0;

  const countResult = await r.query(`SELECT COUNT(*) as total FROM bom ${where}`, values);
  const total = Number(countResult.rows[0]!.total);

  values.push(limit, offset);
  const result = await r.query(
    `SELECT * FROM bom ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );

  return { rows: result.rows as BomRow[], total };
}

export async function insertBom(
  row: Omit<BomRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, blocking_line_count, status_changed_at, status_changed_by, origin, remediation_flag, kit_ref, created_by, correlation_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      row.bom_id,
      row.parent_item_id,
      row.parent_sku,
      row.parent_uom,
      row.business_stream,
      row.bom_type,
      row.status,
      row.current_revision_id,
      row.blocking_line_count,
      row.status_changed_at,
      row.status_changed_by,
      row.origin,
      row.remediation_flag,
      row.kit_ref,
      row.created_by,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function insertBomRevision(
  row: Omit<BomRevisionRow, never>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, released_at, released_by, source_eco_id, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.revision_id,
      row.bom_id,
      row.revision_code,
      row.revision_status,
      row.drafted_by,
      row.drafted_at,
      row.released_at,
      row.released_by,
      row.source_eco_id,
      row.source_event_id,
    ],
  );
}

export async function insertBomLine(
  row: Omit<BomLineRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, expected_yield_percent, is_phantom, phantom_source_bom_id, effective_from, effective_to, blocking_release, blocking_reason, amended_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      row.bom_line_id,
      row.revision_id,
      row.bom_id,
      row.line_no,
      row.component_item_id,
      row.component_sku,
      row.output_class,
      row.quantity_per,
      row.line_uom,
      row.uom_conversion_factor,
      row.base_quantity_per,
      row.scrap_percent,
      row.expected_yield_percent,
      row.is_phantom,
      row.phantom_source_bom_id,
      row.effective_from,
      row.effective_to,
      row.blocking_release,
      row.blocking_reason,
      row.amended_at,
      row.source_event_id,
    ],
  );
}

export async function updateBomBlockingCount(
  bomId: string,
  count: number,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'UPDATE bom SET blocking_line_count = $1, updated_at = now() WHERE bom_id = $2',
    [count, bomId],
  );
}

export async function updateBomCurrentRevision(
  bomId: string,
  revisionId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'UPDATE bom SET current_revision_id = $1, updated_at = now() WHERE bom_id = $2',
    [revisionId, bomId],
  );
}

export async function updateBomStatus(
  bomId: string,
  status: BomRow['status'],
  changedAt: string,
  changedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    'UPDATE bom SET status = $1, status_changed_at = $2, status_changed_by = $3, updated_at = now() WHERE bom_id = $4',
    [status, changedAt, changedBy, bomId],
  );
}

export async function releaseBomRevision(
  revisionId: string,
  releasedAt: string,
  releasedBy: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE bom_revision SET revision_status = 'released', released_at = $1, released_by = $2 WHERE revision_id = $3`,
    [releasedAt, releasedBy, revisionId],
  );
}
