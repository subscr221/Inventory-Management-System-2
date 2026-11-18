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
  /** Story 8.9 (AC 5): the damage case a replacement requisition was raised for. */
  damage_report_id?: string | null;
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
  /** Story 4.10: per-line route and decision state; the header status derives from these. */
  approval_route: 'doa' | 'standing_approval' | 'self_approval';
  line_status: 'pending' | 'approved' | 'rejected';
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  decided_at: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  /** Story 4.8: the grant a standing_approval line rode on, and the limit behind a self-approval. */
  standing_grant_id: string | null;
  self_approved: boolean;
  self_approval_grant_id: string | null;
  /** Story 4.11: fulfilment state, separate from the approval fact above. */
  issued_qty: string;
  issue_state: 'open' | 'issued' | 'closed';
  closed_reason: string | null;
  closed_at: string | null;
  closed_by: string | null;
}

/** Story 4.11 (AC 8): the line row as the API returns it, with the open quantity computed. */
export interface IndentLineView extends IndentLineRow {
  open_qty: string;
}

/** Story 4.10 (AC 7) and 4.11 (AC 8): header row plus the SQL-computed line counts. */
export interface IndentRowWithCounts extends IndentRow {
  line_count: number;
  approved_line_count: number;
  issued_line_count: number;
}

const LINE_COUNT_SELECT = `i.*,
  COALESCE(c.line_count, 0)::int AS line_count,
  COALESCE(c.approved_line_count, 0)::int AS approved_line_count,
  COALESCE(c.issued_line_count, 0)::int AS issued_line_count`;
const LINE_COUNT_JOIN = `LEFT JOIN (
  SELECT indent_id, COUNT(*) AS line_count,
         COUNT(*) FILTER (WHERE line_status = 'approved') AS approved_line_count,
         COUNT(*) FILTER (WHERE issue_state IN ('issued', 'closed')) AS issued_line_count
  FROM indent_line GROUP BY indent_id
) c ON c.indent_id = i.indent_id`;

/**
 * Story 4.11: open quantity in PostgreSQL NUMERIC text, never a JS float. `requested_qty` is the
 * approved quantity (Story 4.10 approves whole lines).
 */
export function openQtyOf(line: Pick<IndentLineRow, 'requested_qty' | 'issued_qty'>): string {
  const scale = 3;
  const toInt = (s: string): bigint => {
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole! + frac.padEnd(scale, '0').slice(0, scale));
  };
  const diff = toInt(line.requested_qty) - toInt(line.issued_qty ?? '0');
  const negative = diff < 0n;
  const abs = (negative ? -diff : diff).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
}

export function withOpenQty(line: IndentLineRow): IndentLineView {
  return { ...line, open_qty: openQtyOf(line) };
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
  forUpdate: boolean = false,
): Promise<IndentLineRow[]> {
  if (!UUID_REGEX.test(indentId)) return [];
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT * FROM indent_line WHERE indent_id = $1 ORDER BY line_no ASC${lockClause}`,
    [indentId],
  );
  return result.rows as IndentLineRow[];
}

/** Story 4.10 (AC 7): one header with its line counts, computed in SQL. */
export async function getIndentWithCounts(
  indentId: string,
  client?: PoolClient,
): Promise<IndentRowWithCounts | null> {
  if (!UUID_REGEX.test(indentId)) return null;
  const result = await runner(client).query(
    `SELECT ${LINE_COUNT_SELECT} FROM indent i ${LINE_COUNT_JOIN} WHERE i.indent_id = $1`,
    [indentId],
  );
  return (result.rows[0] as IndentRowWithCounts) ?? null;
}

/** Story 4.10: writes one line's decision inside the persist transaction. */
export async function updateIndentLineDecision(
  client: PoolClient,
  lineId: string,
  patch: {
    line_status: 'approved' | 'rejected';
    decided_at: string;
    decided_by: string;
    rejection_reason?: string | null;
    /** Story 4.8 (D10): the requester approved their own line under this self-approval limit. */
    self_approval_grant_id?: string | null;
  },
): Promise<void> {
  const selfApprovalGrantId = patch.self_approval_grant_id ?? null;
  await client.query(
    `UPDATE indent_line
     SET line_status = $2, decided_at = $3, decided_by = $4, rejection_reason = $5,
         self_approved = ($6::uuid IS NOT NULL), self_approval_grant_id = $6::uuid,
         approval_route = CASE WHEN $6::uuid IS NOT NULL THEN 'self_approval' ELSE approval_route END
     WHERE indent_line_id = $1`,
    [
      lineId,
      patch.line_status,
      patch.decided_at,
      patch.decided_by,
      patch.rejection_reason ?? null,
      selfApprovalGrantId,
    ],
  );
}

/**
 * Story 4.8 (D8): a standing_approval line whose grant lapsed goes back to the normal DOA path.
 * The state predicate is in the UPDATE so a line already moved or decided elsewhere is untouched
 * (zero rows). The grant id stays on the line as history; the issued quantity is untouched, so a
 * line part-issued under the grant keeps what left the store and only its remainder is re-decided.
 */
export async function rerouteLineToDoa(
  client: PoolClient,
  lineId: string,
  route: { approver_actor_id: string; doa_entry_id: string },
): Promise<IndentLineRow | null> {
  const result = await client.query(
    `UPDATE indent_line
     SET approval_route = 'doa', line_status = 'pending', approver_actor_id = $2,
         doa_entry_id = $3::uuid, decided_at = NULL, decided_by = NULL
     WHERE indent_line_id = $1 AND approval_route = 'standing_approval'
       AND line_status = 'approved' AND issue_state = 'open'
     RETURNING *`,
    [lineId, route.approver_actor_id, route.doa_entry_id],
  );
  return (result.rows[0] as IndentLineRow) ?? null;
}

/**
 * Story 4.11: one line's issue inside the persist transaction. The state predicate is repeated in
 * the UPDATE so a concurrent issue cannot slip past the seam's pre-check; zero rows means the line
 * is no longer open and the caller refuses. The CHECK on issued_qty is the last guard.
 */
export async function applyIndentLineIssue(
  client: PoolClient,
  lineId: string,
  quantity: string,
): Promise<IndentLineRow | null> {
  const result = await client.query(
    `UPDATE indent_line
     SET issued_qty = issued_qty + $2::numeric,
         issue_state = CASE WHEN issued_qty + $2::numeric >= requested_qty THEN 'issued' ELSE 'open' END
     WHERE indent_line_id = $1 AND issue_state = 'open' AND line_status = 'approved'
     RETURNING *`,
    [lineId, quantity],
  );
  return (result.rows[0] as IndentLineRow) ?? null;
}

/** Story 4.11 (AC 3): closes the remainder of an open approved line with a reason. */
export async function closeIndentLine(
  client: PoolClient,
  lineId: string,
  patch: { closed_reason: string; closed_at: string; closed_by: string },
): Promise<IndentLineRow | null> {
  const result = await client.query(
    `UPDATE indent_line
     SET issue_state = 'closed', closed_reason = $2, closed_at = $3, closed_by = $4
     WHERE indent_line_id = $1 AND issue_state = 'open' AND line_status = 'approved'
     RETURNING *`,
    [lineId, patch.closed_reason, patch.closed_at, patch.closed_by],
  );
  return (result.rows[0] as IndentLineRow) ?? null;
}

export interface ListIndentsParams {
  status?: IndentRow['status'] | undefined;
  requesterUserId?: string | undefined;
  search?: string | undefined;
  /** Story 4.11 (AC 8): only requisitions with at least one approved line still open for issue. */
  issuable?: boolean | undefined;
  /** Location scoping resolved from the caller's role assignments (site_id filter). */
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listIndents(
  params: ListIndentsParams,
  client?: PoolClient,
): Promise<IndentRowWithCounts[]> {
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
  if (params.issuable) {
    conditions.push(
      `i.status IN ('raised', 'approved') AND EXISTS (
         SELECT 1 FROM indent_line l
         WHERE l.indent_id = i.indent_id AND l.line_status = 'approved' AND l.issue_state = 'open'
       )`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  // Story 4.10 (AC 7): line counts come from one grouped subquery, never per row.
  const result = await r.query(
    `SELECT ${LINE_COUNT_SELECT} FROM indent i ${LINE_COUNT_JOIN} ${where} ORDER BY i.created_at DESC, i.indent_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as IndentRowWithCounts[];
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
  /** Story 4.10: routing and (for a pre-routed line) the decision; defaults apply when absent. */
  approval_route?: 'doa' | 'standing_approval' | 'self_approval';
  approver_actor_id?: string | null;
  doa_entry_id?: string | null;
  line_status?: 'pending' | 'approved';
  decided_at?: string | null;
  decided_by?: string | null;
  /** Story 4.8 (D6): the grant a standing_approval line rides on; validated by the seam. */
  standing_grant_id?: string | null;
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
      unit_price_estimate, line_value,
      approval_route, approver_actor_id, doa_entry_id, line_status, decided_at, decided_by,
      standing_grant_id
    ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,
      $6::numeric * COALESCE($8::numeric, 0),
      $9, $10, $11::uuid, $12, $13::timestamptz, $14, $15::uuid)`,
    [
      row.indent_line_id,
      row.indent_id,
      row.line_no,
      row.sku,
      row.item_category,
      row.requested_qty,
      row.uom,
      row.unit_price_estimate,
      row.approval_route ?? 'doa',
      row.approver_actor_id ?? null,
      row.doa_entry_id ?? null,
      row.line_status ?? 'pending',
      row.decided_at ?? null,
      row.decided_by ?? null,
      row.standing_grant_id ?? null,
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
