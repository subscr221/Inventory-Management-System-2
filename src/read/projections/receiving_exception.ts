import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

// Story 3.19: unloading exception read model (over-tolerance GOOD lines, unmatched vehicles).

export type ReceivingExceptionKind = 'over_tolerance' | 'unmatched_vehicle';
export type ReceivingExceptionStatus = 'open' | 'sent_to_procurement' | 'resolved';
export type ReceivingExceptionResolution =
  'matched_to_po' | 'accepted_within_band' | 'sent_to_procurement';

export interface ReceivingException {
  exception_id: string;
  kind: ReceivingExceptionKind;
  source_id: string;
  site_id: string;
  status: ReceivingExceptionStatus;
  resolution: ReceivingExceptionResolution | null;
  reason_code: string | null;
  note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  accepted_grn_line_id: string | null;
  po_ref_ext: string | null;
  line_no: number | null;
  sku: string | null;
  uom: string | null;
  vehicle_reg_ext: string | null;
  ordered_qty: string | null;
  already_received_qty: string | null;
  tolerance_pct: string | null;
  cap_qty: string | null;
  counted_qty: string | null;
  excess_qty: string | null;
  created_at: string;
}

export interface OverToleranceFacts {
  ordered_qty: string;
  already_received_qty: string;
  tolerance_pct: string;
  cap_qty: string;
  counted_qty: string;
  accept_qty: string;
  excess_qty: string;
}

export interface UpsertResolvedExceptionInput {
  kind: ReceivingExceptionKind;
  source_id: string;
  site_id: string;
  status: Exclude<ReceivingExceptionStatus, 'open'>;
  resolution: ReceivingExceptionResolution;
  reason_code?: string | null;
  note?: string | null;
  resolved_by: string;
  accepted_grn_line_id?: string | null;
  ordered_qty?: string | null;
  already_received_qty?: string | null;
  tolerance_pct?: string | null;
  cap_qty?: string | null;
  counted_qty?: string | null;
  excess_qty?: string | null;
  source_event_id?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export async function insertOpenOverToleranceException(
  input: { source_id: string; site_id: string; source_event_id: string },
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO receiving_exception (exception_id, kind, source_id, site_id, status, source_event_id)
     VALUES (gen_random_uuid(), 'over_tolerance', $1, $2, 'open', $3)
     ON CONFLICT (kind, source_id) DO NOTHING`,
    [input.source_id, input.site_id, input.source_event_id],
  );
}

export async function upsertResolvedException(
  input: UpsertResolvedExceptionInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO receiving_exception
       (exception_id, kind, source_id, site_id, status, resolution, reason_code, note, resolved_by,
        resolved_at, accepted_grn_line_id, ordered_qty, already_received_qty, tolerance_pct,
        cap_qty, counted_qty, excess_qty, source_event_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (kind, source_id) DO UPDATE SET
       status = EXCLUDED.status,
       resolution = EXCLUDED.resolution,
       reason_code = EXCLUDED.reason_code,
       note = EXCLUDED.note,
       resolved_by = EXCLUDED.resolved_by,
       resolved_at = EXCLUDED.resolved_at,
       accepted_grn_line_id = EXCLUDED.accepted_grn_line_id,
       ordered_qty = EXCLUDED.ordered_qty,
       already_received_qty = EXCLUDED.already_received_qty,
       tolerance_pct = EXCLUDED.tolerance_pct,
       cap_qty = EXCLUDED.cap_qty,
       counted_qty = EXCLUDED.counted_qty,
       excess_qty = EXCLUDED.excess_qty,
       source_event_id = COALESCE(EXCLUDED.source_event_id, receiving_exception.source_event_id),
       updated_at = now()`,
    [
      input.kind,
      input.source_id,
      input.site_id,
      input.status,
      input.resolution,
      input.reason_code ?? null,
      input.note ?? null,
      input.resolved_by,
      input.accepted_grn_line_id ?? null,
      input.ordered_qty ?? null,
      input.already_received_qty ?? null,
      input.tolerance_pct ?? null,
      input.cap_qty ?? null,
      input.counted_qty ?? null,
      input.excess_qty ?? null,
      input.source_event_id ?? null,
    ],
  );
}

// Live band for a rejected line. Same arithmetic as readPoReceiptBand (non-rejected platform lines
// plus legacy_received_qty); the rejected line itself is excluded by its status.
const LIVE_BAND_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT pol.ordered_qty AS ordered,
           pol.over_receipt_tolerance_pct AS pct,
           (SELECT COALESCE(SUM(o.received_qty), 0) FROM grn_line o
             WHERE o.po_ref_ext = gl.po_ref_ext AND o.line_no = gl.line_no
               AND o.status <> 'rejected' AND o.line_condition <> 'REJECTED')
             + pol.legacy_received_qty AS already
      FROM erp_purchase_order_line pol
     WHERE pol.po_number_ext = gl.po_ref_ext AND pol.line_no = gl.line_no
  ) band ON true`;

// TRUNC to 3 places: quantities carry three decimals and the cap must never round up past the band.
const CAP_SQL = `GREATEST(TRUNC(band.ordered * (1 + COALESCE(band.pct, 0) / 100), 3) - band.already, 0)`;

/** Takes the readPoReceiptBand advisory lock for the line's PO line, then reads the live band. */
export async function readOverToleranceFacts(
  grnLineId: string,
  client: PoolClient,
): Promise<OverToleranceFacts | null> {
  const key = await client.query(
    `SELECT po_ref_ext, line_no FROM grn_line WHERE grn_line_id = $1`,
    [grnLineId],
  );
  if (key.rows.length === 0) return null;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `${key.rows[0]!['po_ref_ext'] as string}:${key.rows[0]!['line_no'] as number}`,
  ]);
  const r = await client.query(
    `SELECT band.ordered::text AS ordered_qty,
            band.already::text AS already_received_qty,
            COALESCE(band.pct, 0)::text AS tolerance_pct,
            ${CAP_SQL}::text AS cap_qty,
            gl.received_qty::text AS counted_qty,
            LEAST(${CAP_SQL}, gl.received_qty)::text AS accept_qty,
            (gl.received_qty - LEAST(${CAP_SQL}, gl.received_qty))::text AS excess_qty
       FROM grn_line gl ${LIVE_BAND_LATERAL}
      WHERE gl.grn_line_id = $1 AND band.ordered IS NOT NULL`,
    [grnLineId],
  );
  return r.rows.length > 0 ? (r.rows[0]! as unknown as OverToleranceFacts) : null;
}

const LIVE = `e.kind = 'over_tolerance' AND e.status = 'open'`;
const EXCEPTION_SELECT = `
  SELECT e.exception_id, e.kind, e.source_id, e.site_id, e.status, e.resolution, e.reason_code,
         e.note, e.resolved_by, e.resolved_at, e.accepted_grn_line_id, e.created_at,
         COALESCE(gl.po_ref_ext, ge.po_ref_ext) AS po_ref_ext,
         gl.line_no, gl.sku, gl.uom, ge.vehicle_reg_ext,
         (CASE WHEN ${LIVE} THEN band.ordered ELSE e.ordered_qty END)::text AS ordered_qty,
         (CASE WHEN ${LIVE} THEN band.already ELSE e.already_received_qty END)::text AS already_received_qty,
         (CASE WHEN ${LIVE} THEN COALESCE(band.pct, 0) ELSE e.tolerance_pct END)::text AS tolerance_pct,
         (CASE WHEN ${LIVE} THEN ${CAP_SQL} ELSE e.cap_qty END)::text AS cap_qty,
         (CASE WHEN ${LIVE} THEN gl.received_qty ELSE e.counted_qty END)::text AS counted_qty,
         (CASE WHEN ${LIVE} THEN gl.received_qty - LEAST(${CAP_SQL}, gl.received_qty) ELSE e.excess_qty END)::text AS excess_qty
    FROM receiving_exception e
    LEFT JOIN grn_line gl ON e.kind = 'over_tolerance' AND gl.grn_line_id = e.source_id
    LEFT JOIN gate_event ge ON e.kind = 'unmatched_vehicle' AND ge.gate_event_id = e.source_id
    ${LIVE_BAND_LATERAL}`;

function mapException(row: Record<string, unknown>): ReceivingException {
  return {
    exception_id: row['exception_id'] as string,
    kind: row['kind'] as ReceivingExceptionKind,
    source_id: row['source_id'] as string,
    site_id: row['site_id'] as string,
    status: row['status'] as ReceivingExceptionStatus,
    resolution: (row['resolution'] as ReceivingExceptionResolution | null) ?? null,
    reason_code: (row['reason_code'] as string | null) ?? null,
    note: (row['note'] as string | null) ?? null,
    resolved_by: (row['resolved_by'] as string | null) ?? null,
    resolved_at: ts(row['resolved_at']),
    accepted_grn_line_id: (row['accepted_grn_line_id'] as string | null) ?? null,
    po_ref_ext: str(row['po_ref_ext']),
    line_no:
      row['line_no'] === null || row['line_no'] === undefined ? null : Number(row['line_no']),
    sku: str(row['sku']),
    uom: str(row['uom']),
    vehicle_reg_ext: str(row['vehicle_reg_ext']),
    ordered_qty: str(row['ordered_qty']),
    already_received_qty: str(row['already_received_qty']),
    tolerance_pct: str(row['tolerance_pct']),
    cap_qty: str(row['cap_qty']),
    counted_qty: str(row['counted_qty']),
    excess_qty: str(row['excess_qty']),
    created_at: ts(row['created_at']) as string,
  };
}

export async function listReceivingExceptions(
  filters: {
    siteId?: string | null;
    siteAny?: string[] | null;
    status?: ReceivingExceptionStatus | null;
  } = {},
  client?: PoolClient,
): Promise<ReceivingException[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.siteId) {
    values.push(filters.siteId);
    clauses.push(`e.site_id = $${values.length}`);
  }
  if (filters.siteAny !== undefined && filters.siteAny !== null) {
    values.push(filters.siteAny);
    clauses.push(`e.site_id = ANY($${values.length}::uuid[])`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`e.status = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await runner(client).query(
    `${EXCEPTION_SELECT} ${where} ORDER BY e.created_at ASC, e.exception_id ASC LIMIT 500`,
    values,
  );
  return r.rows.map(mapException);
}

export async function getReceivingExceptionBySource(
  kind: ReceivingExceptionKind,
  sourceId: string,
  client?: PoolClient,
): Promise<ReceivingException | null> {
  const r = await runner(client).query(
    `${EXCEPTION_SELECT} WHERE e.kind = $1 AND e.source_id = $2`,
    [kind, sourceId],
  );
  return r.rows.length > 0 ? mapException(r.rows[0]!) : null;
}
