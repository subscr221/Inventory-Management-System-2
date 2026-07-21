import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Cycle count read model (Story 2.6). Derived from cycle_count.* and stock.adjusted domain events by
 * the applyCycleCountProjection compliance seam inside persistEvent. Query-side helpers used by the
 * API handlers; mutation helpers are transaction-scoped and only called from the seam.
 *
 * cycle_count is the task header; cycle_count_line is one row per counted (sku, lot_id, stock_class)
 * carrying the computed book quantity, variance, and - when the variance breaches tolerance - the
 * DOA-gated adjustment lifecycle (pending_approval -> approved/rejected -> applied).
 */

export interface CycleCountHeaderRow {
  cycle_count_id: string;
  location_id: string;
  zone_id: string | null;
  sku_scope: string[];
  stock_class: string | null;
  count_type: string;
  business_date: string;
  business_stream: string;
  tolerance_percent: number;
  status: string;
  created_by_actor_id: string | null;
  submitted_by_actor_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface CycleCountLineRow {
  line_id: string;
  cycle_count_id: string;
  sku: string;
  lot_id: string | null;
  stock_class: string;
  counted_quantity: number;
  book_quantity: number;
  allocated_quantity: number;
  in_transit_quantity: number;
  variance_quantity: number;
  variance_value: number;
  tolerance_breach: boolean;
  adjustment_id: string | null;
  adjustment_status: string | null;
  approver_actor_id: string | null;
  reason_code: string | null;
  applied_event_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const HEADER_COLUMNS = `cycle_count_id, location_id, zone_id, sku_scope, stock_class, count_type,
       business_date, business_stream, tolerance_percent, status, created_by_actor_id,
       submitted_by_actor_id, notes, created_at`;

const LINE_COLUMNS = `line_id, cycle_count_id, sku, lot_id, stock_class, counted_quantity,
       book_quantity, allocated_quantity, in_transit_quantity, variance_quantity, variance_value,
       tolerance_breach, adjustment_id, adjustment_status, approver_actor_id, reason_code,
       applied_event_id`;

function ymd(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

function mapHeader(row: Record<string, unknown>): CycleCountHeaderRow {
  return {
    cycle_count_id: row['cycle_count_id'] as string,
    location_id: row['location_id'] as string,
    zone_id: (row['zone_id'] as string | null) ?? null,
    sku_scope: (row['sku_scope'] as string[] | null) ?? [],
    stock_class: (row['stock_class'] as string | null) ?? null,
    count_type: row['count_type'] as string,
    business_date: ymd(row['business_date']),
    business_stream: row['business_stream'] as string,
    tolerance_percent: Number(row['tolerance_percent']),
    status: row['status'] as string,
    created_by_actor_id: (row['created_by_actor_id'] as string | null) ?? null,
    submitted_by_actor_id: (row['submitted_by_actor_id'] as string | null) ?? null,
    notes: (row['notes'] as string | null) ?? null,
    created_at: row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']),
  };
}

function mapLine(row: Record<string, unknown>): CycleCountLineRow {
  return {
    line_id: row['line_id'] as string,
    cycle_count_id: row['cycle_count_id'] as string,
    sku: row['sku'] as string,
    lot_id: (row['lot_id'] as string | null) ?? null,
    stock_class: row['stock_class'] as string,
    counted_quantity: Number(row['counted_quantity']),
    book_quantity: Number(row['book_quantity']),
    allocated_quantity: Number(row['allocated_quantity']),
    in_transit_quantity: Number(row['in_transit_quantity']),
    variance_quantity: Number(row['variance_quantity']),
    variance_value: Number(row['variance_value']),
    tolerance_breach: row['tolerance_breach'] === true,
    adjustment_id: (row['adjustment_id'] as string | null) ?? null,
    adjustment_status: (row['adjustment_status'] as string | null) ?? null,
    approver_actor_id: (row['approver_actor_id'] as string | null) ?? null,
    reason_code: (row['reason_code'] as string | null) ?? null,
    applied_event_id: (row['applied_event_id'] as string | null) ?? null,
  };
}

/**
 * Get a cycle-count header by id. When `forUpdate` is true a `client` MUST be supplied and the row
 * is locked FOR UPDATE so concurrent submit/approve transitions serialize (Story 2.5 review pattern).
 */
export async function getCycleCountById(
  cycleCountId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<CycleCountHeaderRow | null> {
  if (forUpdate && !client) {
    throw new Error('getCycleCountById: forUpdate requires a transaction client');
  }
  const result = await runner(client).query(
    `SELECT ${HEADER_COLUMNS} FROM cycle_count WHERE cycle_count_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [cycleCountId],
  );
  return result.rows.length > 0 ? mapHeader(result.rows[0]!) : null;
}

export async function getCycleCountLines(cycleCountId: string, client?: PoolClient): Promise<CycleCountLineRow[]> {
  const result = await runner(client).query(
    `SELECT ${LINE_COLUMNS} FROM cycle_count_line WHERE cycle_count_id = $1 ORDER BY sku, lot_id NULLS FIRST`,
    [cycleCountId],
  );
  return result.rows.map(mapLine);
}

/**
 * Get a single cycle-count line by its adjustment_id. Locks FOR UPDATE when a client is supplied so
 * concurrent approvals or adjustment applications for the same variance cannot double-adjust stock.
 */
export async function getCycleCountLineByAdjustment(
  adjustmentId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<CycleCountLineRow | null> {
  const result = await runner(client).query(
    `SELECT ${LINE_COLUMNS} FROM cycle_count_line WHERE adjustment_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [adjustmentId],
  );
  return result.rows.length > 0 ? mapLine(result.rows[0]!) : null;
}

export async function listCycleCounts(filters: {
  location_any?: string[] | null;
  location_id?: string | null;
  status?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  sku?: string | null;
}): Promise<CycleCountHeaderRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.location_id) {
    conditions.push(`location_id = $${i++}`);
    params.push(filters.location_id);
  }
  if (filters.location_any && filters.location_any.length > 0) {
    conditions.push(`location_id = ANY($${i++})`);
    params.push(filters.location_any);
  }
  if (filters.status) {
    conditions.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.from_date) {
    conditions.push(`business_date >= $${i++}`);
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`business_date <= $${i++}`);
    params.push(filters.to_date);
  }
  if (filters.sku) {
    conditions.push(`$${i++} = ANY(sku_scope)`);
    params.push(filters.sku);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await getPool().query(
    `SELECT ${HEADER_COLUMNS} FROM cycle_count ${where} ORDER BY created_at DESC`,
    params,
  );
  return result.rows.map(mapHeader);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface InsertCycleCountHeaderInput {
  cycle_count_id: string;
  location_id: string;
  zone_id: string | null;
  sku_scope: string[];
  stock_class: string | null;
  count_type: string;
  business_date: string;
  business_stream: string;
  tolerance_percent: number;
  created_by_actor_id: string | null;
  notes: string | null;
}

export async function insertCycleCountHeader(input: InsertCycleCountHeaderInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO cycle_count (
       cycle_count_id, location_id, zone_id, sku_scope, stock_class, count_type,
       business_date, business_stream, tolerance_percent, status, created_by_actor_id, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11)`,
    [
      input.cycle_count_id,
      input.location_id,
      input.zone_id,
      input.sku_scope,
      input.stock_class,
      input.count_type,
      input.business_date,
      input.business_stream,
      input.tolerance_percent,
      input.created_by_actor_id,
      input.notes,
    ],
  );
}

export interface InsertCycleCountLineInput {
  cycle_count_id: string;
  sku: string;
  lot_id: string | null;
  stock_class: string;
  counted_quantity: number;
  book_quantity: number;
  allocated_quantity: number;
  in_transit_quantity: number;
  variance_quantity: number;
  variance_value: number;
  tolerance_breach: boolean;
  adjustment_id: string | null;
  adjustment_status: string | null;
  approver_actor_id: string | null;
}

export async function insertCycleCountLine(input: InsertCycleCountLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO cycle_count_line (
       cycle_count_id, sku, lot_id, stock_class, counted_quantity, book_quantity,
       allocated_quantity, in_transit_quantity, variance_quantity, variance_value,
       tolerance_breach, adjustment_id, adjustment_status, approver_actor_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      input.cycle_count_id,
      input.sku,
      input.lot_id,
      input.stock_class,
      input.counted_quantity,
      input.book_quantity,
      input.allocated_quantity,
      input.in_transit_quantity,
      input.variance_quantity,
      input.variance_value,
      input.tolerance_breach,
      input.adjustment_id,
      input.adjustment_status,
      input.approver_actor_id,
    ],
  );
}

export async function markCycleCountSubmitted(
  cycleCountId: string,
  submittedByActorId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE cycle_count SET status = 'submitted', submitted_by_actor_id = $2, updated_at = now()
     WHERE cycle_count_id = $1`,
    [cycleCountId, submittedByActorId],
  );
}

export async function setAdjustmentStatus(
  adjustmentId: string,
  status: string,
  reasonCode: string | null,
  approverActorId: string | null,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE cycle_count_line
     SET adjustment_status = $2,
         reason_code = COALESCE($3, reason_code),
         approver_actor_id = COALESCE($4, approver_actor_id)
     WHERE adjustment_id = $1`,
    [adjustmentId, status, reasonCode, approverActorId],
  );
}

export async function markAdjustmentApplied(
  adjustmentId: string,
  appliedEventId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE cycle_count_line SET adjustment_status = 'applied', applied_event_id = $2 WHERE adjustment_id = $1`,
    [adjustmentId, appliedEventId],
  );
}
