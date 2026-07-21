import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Physical verification read model (Story 2.6). CARO 2020 clause 3(i) evidence, consumed by Epic 11
 * (FR-AC-15). physical_verification is the report header; physical_verification_line is the
 * APPEND-ONLY evidence snapshot taken at completion time. Corrections after sign-off or period lock
 * are NEW events, never updates/deletes of these rows.
 */

export interface PhysicalVerificationHeaderRow {
  physical_verification_id: string;
  location_id: string;
  coverage_percentage: number;
  period_start: string | null;
  period_end: string | null;
  business_date: string | null;
  count_refs: string[];
  completed_by_actor_id: string | null;
  management_signoff_actor_id: string | null;
  signed_off_at: string | null;
  period_locked: boolean;
  source_event_id: string | null;
}

export interface PhysicalVerificationLineRow {
  pv_line_id: string;
  physical_verification_id: string;
  cycle_count_id: string;
  count_date: string | null;
  sku: string;
  lot_id: string | null;
  stock_class: string;
  book_quantity: number;
  counted_quantity: number;
  variance_quantity: number;
  variance_value: number;
  adjustment_event_ref: string | null;
  counter_actor_id: string | null;
  approver_actor_id: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ymd(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

const HEADER_COLUMNS = `physical_verification_id, location_id, coverage_percentage, period_start,
       period_end, business_date, count_refs, completed_by_actor_id, management_signoff_actor_id,
       signed_off_at, period_locked, source_event_id`;

const LINE_COLUMNS = `pv_line_id, physical_verification_id, cycle_count_id, count_date, sku, lot_id,
       stock_class, book_quantity, counted_quantity, variance_quantity, variance_value,
       adjustment_event_ref, counter_actor_id, approver_actor_id`;

function mapHeader(row: Record<string, unknown>): PhysicalVerificationHeaderRow {
  return {
    physical_verification_id: row['physical_verification_id'] as string,
    location_id: row['location_id'] as string,
    coverage_percentage: Number(row['coverage_percentage']),
    period_start: ymd(row['period_start']),
    period_end: ymd(row['period_end']),
    business_date: ymd(row['business_date']),
    count_refs: (row['count_refs'] as string[] | null) ?? [],
    completed_by_actor_id: (row['completed_by_actor_id'] as string | null) ?? null,
    management_signoff_actor_id: (row['management_signoff_actor_id'] as string | null) ?? null,
    signed_off_at:
      row['signed_off_at'] instanceof Date
        ? row['signed_off_at'].toISOString()
        : (row['signed_off_at'] as string | null) ?? null,
    period_locked: row['period_locked'] === true,
    source_event_id: (row['source_event_id'] as string | null) ?? null,
  };
}

function mapLine(row: Record<string, unknown>): PhysicalVerificationLineRow {
  return {
    pv_line_id: row['pv_line_id'] as string,
    physical_verification_id: row['physical_verification_id'] as string,
    cycle_count_id: row['cycle_count_id'] as string,
    count_date: ymd(row['count_date']),
    sku: row['sku'] as string,
    lot_id: (row['lot_id'] as string | null) ?? null,
    stock_class: row['stock_class'] as string,
    book_quantity: Number(row['book_quantity']),
    counted_quantity: Number(row['counted_quantity']),
    variance_quantity: Number(row['variance_quantity']),
    variance_value: Number(row['variance_value']),
    adjustment_event_ref: (row['adjustment_event_ref'] as string | null) ?? null,
    counter_actor_id: (row['counter_actor_id'] as string | null) ?? null,
    approver_actor_id: (row['approver_actor_id'] as string | null) ?? null,
  };
}

export async function getPhysicalVerificationById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<PhysicalVerificationHeaderRow | null> {
  const result = await runner(client).query(
    `SELECT ${HEADER_COLUMNS} FROM physical_verification WHERE physical_verification_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return result.rows.length > 0 ? mapHeader(result.rows[0]!) : null;
}

/** Report headers filtered by location and business_date window. Reads projections, not events (AD-14). */
export async function listPhysicalVerifications(filters: {
  location_any?: string[] | null;
  location_id?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  status?: string | null;
}): Promise<PhysicalVerificationHeaderRow[]> {
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
  if (filters.from_date) {
    conditions.push(`business_date >= $${i++}`);
    params.push(filters.from_date);
  }
  if (filters.to_date) {
    conditions.push(`business_date <= $${i++}`);
    params.push(filters.to_date);
  }
  if (filters.status === 'signed_off') {
    conditions.push(`signed_off_at IS NOT NULL`);
  } else if (filters.status === 'pending') {
    conditions.push(`signed_off_at IS NULL`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await getPool().query(
    `SELECT ${HEADER_COLUMNS} FROM physical_verification ${where} ORDER BY created_at DESC`,
    params,
  );
  return result.rows.map(mapHeader);
}

export async function getPhysicalVerificationLines(
  physicalVerificationId: string,
  client?: PoolClient,
): Promise<PhysicalVerificationLineRow[]> {
  const result = await runner(client).query(
    `SELECT ${LINE_COLUMNS} FROM physical_verification_line
     WHERE physical_verification_id = $1 ORDER BY sku, lot_id NULLS FIRST`,
    [physicalVerificationId],
  );
  return result.rows.map(mapLine);
}

// ---------------------------------------------------------------------------
// Mutation helpers (transaction-scoped; called only from the compliance seam)
// ---------------------------------------------------------------------------

export interface InsertPhysicalVerificationHeaderInput {
  physical_verification_id: string;
  location_id: string;
  coverage_percentage: number;
  period_start: string | null;
  period_end: string | null;
  business_date: string | null;
  count_refs: string[];
  completed_by_actor_id: string | null;
  source_event_id: string | null;
}

export async function insertPhysicalVerificationHeader(
  input: InsertPhysicalVerificationHeaderInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO physical_verification (
       physical_verification_id, location_id, coverage_percentage, period_start, period_end,
       business_date, count_refs, completed_by_actor_id, source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.physical_verification_id,
      input.location_id,
      input.coverage_percentage,
      input.period_start,
      input.period_end,
      input.business_date,
      input.count_refs,
      input.completed_by_actor_id,
      input.source_event_id,
    ],
  );
}

export interface InsertPhysicalVerificationLineInput {
  physical_verification_id: string;
  cycle_count_id: string;
  count_date: string | null;
  sku: string;
  lot_id: string | null;
  stock_class: string;
  book_quantity: number;
  counted_quantity: number;
  variance_quantity: number;
  variance_value: number;
  adjustment_event_ref: string | null;
  counter_actor_id: string | null;
  approver_actor_id: string | null;
}

export async function insertPhysicalVerificationLine(
  input: InsertPhysicalVerificationLineInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO physical_verification_line (
       physical_verification_id, cycle_count_id, count_date, sku, lot_id, stock_class,
       book_quantity, counted_quantity, variance_quantity, variance_value, adjustment_event_ref,
       counter_actor_id, approver_actor_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.physical_verification_id,
      input.cycle_count_id,
      input.count_date,
      input.sku,
      input.lot_id,
      input.stock_class,
      input.book_quantity,
      input.counted_quantity,
      input.variance_quantity,
      input.variance_value,
      input.adjustment_event_ref,
      input.counter_actor_id,
      input.approver_actor_id,
    ],
  );
}

export async function markPhysicalVerificationSignedOff(
  physicalVerificationId: string,
  signoffActorId: string,
  signedOffAt: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE physical_verification
     SET management_signoff_actor_id = $2, signed_off_at = $3, period_locked = true
     WHERE physical_verification_id = $1`,
    [physicalVerificationId, signoffActorId, signedOffAt],
  );
}
