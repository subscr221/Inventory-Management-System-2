import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface IndentRow {
  indent_id: string;
  indent_number_ext: string;
  requester_user_id: string;
  department_code: string;
  site_id: string;
  business_stream: string;
  need_by_date: string;
  urgent: boolean;
  reason: string | null;
  estimated_value: string;
  status:
    | 'raised'
    | 'pending-confirmation'
    | 'approved'
    | 'rejected'
    | 'ordered'
    | 'cancelled'
    | 'closed';
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  decided_at: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  duplicate_of_indent_id: string | null;
  cancelled_reason: string | null;
  expected_delivery_date: string | null;
  purchase_order_id: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface IndentLineRow {
  indent_line_id: string;
  indent_id: string;
  line_no: number;
  sku: string;
  item_category: string;
  requested_qty: string;
  uom: string;
  unit_price_estimate: string | null;
  line_value: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getIndentById(
  indentId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<IndentRow | null> {
  if (!UUID_REGEX.test(indentId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(`SELECT * FROM indent WHERE indent_id = $1${lockClause}`, [
    indentId,
  ]);
  return (result.rows[0] as IndentRow) ?? null;
}

export async function getIndentLines(
  indentId: string,
  client?: PoolClient,
): Promise<IndentLineRow[]> {
  if (!UUID_REGEX.test(indentId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM indent_line WHERE indent_id = $1 ORDER BY line_no ASC`,
    [indentId],
  );
  return result.rows as IndentLineRow[];
}

export interface ListIndentsParams {
  status?: IndentRow['status'] | undefined;
  requesterUserId?: string | undefined;
  search?: string | undefined;
  /** Location scoping resolved from the caller's role assignments (site_id filter). */
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listIndents(
  params: ListIndentsParams,
  client?: PoolClient,
): Promise<IndentRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.requesterUserId) {
    if (!UUID_REGEX.test(params.requesterUserId)) return [];
    conditions.push(`requester_user_id = $${idx++}`);
    values.push(params.requesterUserId);
  }
  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(
      `(indent_number_ext ILIKE $${idx} ESCAPE '\\' OR department_code ILIKE $${idx + 1} ESCAPE '\\')`,
    );
    const pattern = `%${escaped}%`;
    values.push(pattern, pattern);
    idx += 2;
  }
  if (params.permittedSites && !params.permittedSites.wildcard) {
    const sites = [...params.permittedSites.locations].filter((s) => UUID_REGEX.test(s));
    if (sites.length === 0) return [];
    conditions.push(`site_id = ANY($${idx++}::uuid[])`);
    values.push(sites);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT * FROM indent ${where} ORDER BY created_at DESC, indent_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as IndentRow[];
}

/**
 * AC 2 / AC 3 duplicate detection: an open indent (raised, pending-confirmation, or approved) by
 * the same requester carrying a line for the same SKU, created within the trailing window. Served
 * by the partial index idx_indent_dup_window. Oldest match wins so a chain of duplicates all point
 * at the original.
 */
export async function findOpenDuplicate(
  requesterUserId: string,
  sku: string,
  windowDays: number,
  client?: PoolClient,
  excludeIndentId?: string,
): Promise<IndentRow | null> {
  if (!UUID_REGEX.test(requesterUserId)) return null;
  const r = runner(client);
  const values: unknown[] = [requesterUserId, sku, `${windowDays} days`];
  let excludeClause = '';
  if (excludeIndentId && UUID_REGEX.test(excludeIndentId)) {
    values.push(excludeIndentId);
    excludeClause = 'AND i.indent_id <> $4';
  }
  const result = await r.query(
    `SELECT i.* FROM indent i
     JOIN indent_line l ON l.indent_id = i.indent_id
     WHERE i.requester_user_id = $1
       AND l.sku = $2
       AND i.status IN ('raised','pending-confirmation','approved')
       AND i.created_at >= now() - $3::interval
       ${excludeClause}
     ORDER BY i.created_at ASC, i.indent_id ASC
     LIMIT 1`,
    values,
  );
  return (result.rows[0] as IndentRow) ?? null;
}

export interface InsertIndentInput {
  indent_id: string;
  indent_number_ext: string;
  requester_user_id: string;
  department_code: string;
  site_id: string;
  business_stream: string;
  need_by_date: string;
  urgent: boolean;
  reason: string | null;
  status: 'raised' | 'pending-confirmation';
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  duplicate_of_indent_id: string | null;
  correlation_id: string | null;
  source_event_id: string;
}

export async function insertIndent(row: InsertIndentInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO indent (
      indent_id, indent_number_ext, requester_user_id, department_code, site_id,
      business_stream, need_by_date, urgent, reason, status,
      approver_actor_id, doa_entry_id, duplicate_of_indent_id, correlation_id, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.indent_id,
      row.indent_number_ext,
      row.requester_user_id,
      row.department_code,
      row.site_id,
      row.business_stream,
      row.need_by_date,
      row.urgent,
      row.reason,
      row.status,
      row.approver_actor_id,
      row.doa_entry_id,
      row.duplicate_of_indent_id,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export interface InsertIndentLineInput {
  indent_line_id: string;
  indent_id: string;
  line_no: number;
  sku: string;
  item_category: string;
  requested_qty: number;
  uom: string;
  unit_price_estimate: number | null;
}

/**
 * line_value and the header estimated_value are computed in PostgreSQL NUMERIC (never JS floats):
 * line_value = requested_qty * COALESCE(unit_price_estimate, 0) at insert, and the caller rolls
 * the header total up with recomputeIndentEstimatedValue after the last line.
 */
export async function insertIndentLine(
  row: InsertIndentLineInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO indent_line (
      indent_line_id, indent_id, line_no, sku, item_category, requested_qty, uom,
      unit_price_estimate, line_value
    ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,
      $6::numeric * COALESCE($8::numeric, 0))`,
    [
      row.indent_line_id,
      row.indent_id,
      row.line_no,
      row.sku,
      row.item_category,
      row.requested_qty,
      row.uom,
      row.unit_price_estimate,
    ],
  );
}

export async function recomputeIndentEstimatedValue(
  indentId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE indent SET estimated_value = (
       SELECT COALESCE(SUM(line_value), 0) FROM indent_line WHERE indent_id = $1
     ), updated_at = now()
     WHERE indent_id = $1`,
    [indentId],
  );
}

export async function updateIndentStatus(
  indentId: string,
  status: IndentRow['status'],
  extra: Partial<
    Pick<
      IndentRow,
      | 'decided_at'
      | 'decided_by'
      | 'rejection_reason'
      | 'duplicate_of_indent_id'
      | 'cancelled_reason'
      | 'expected_delivery_date'
      | 'purchase_order_id'
    >
  >,
  client: PoolClient,
): Promise<void> {
  const sets: string[] = ['status = $2', 'updated_at = now()'];
  const values: (string | null)[] = [indentId, status];
  let idx = 3;

  if (extra.decided_at !== undefined) {
    sets.push(`decided_at = $${idx++}`);
    values.push(extra.decided_at);
  }
  if (extra.decided_by !== undefined) {
    sets.push(`decided_by = $${idx++}::uuid`);
    values.push(extra.decided_by);
  }
  if (extra.rejection_reason !== undefined) {
    sets.push(`rejection_reason = $${idx++}`);
    values.push(extra.rejection_reason);
  }
  if (extra.duplicate_of_indent_id !== undefined) {
    sets.push(`duplicate_of_indent_id = $${idx++}::uuid`);
    values.push(extra.duplicate_of_indent_id);
  }
  if (extra.cancelled_reason !== undefined) {
    sets.push(`cancelled_reason = $${idx++}`);
    values.push(extra.cancelled_reason);
  }
  if (extra.expected_delivery_date !== undefined) {
    sets.push(`expected_delivery_date = $${idx++}`);
    values.push(extra.expected_delivery_date);
  }
  if (extra.purchase_order_id !== undefined) {
    sets.push(`purchase_order_id = $${idx++}::uuid`);
    values.push(extra.purchase_order_id);
  }

  await client.query(`UPDATE indent SET ${sets.join(', ')} WHERE indent_id = $1`, values);
}

/**
 * Allocates the next human-readable indent number in the IND-YYYY-NNNN format from the
 * indent_number_seq sequence - server-side only (Task 5), never client-supplied, never
 * MAX(...)+1. NNNN is zero-padded to at least 4 digits and simply grows wider beyond 9999.
 */
export async function allocateIndentNumber(year: number, client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT nextval('indent_number_seq') AS n`);
  const n = String(result.rows[0]['n']);
  return `IND-${year}-${n.padStart(4, '0')}`;
}
