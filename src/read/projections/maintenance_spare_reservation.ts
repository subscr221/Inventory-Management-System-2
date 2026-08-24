import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 7.4 accessors for the maintenance spare reservation table (FR-M-07, FR-M-08). */
export type SpareReservationStatus =
  'reserved' | 'issued' | 'partially_returned' | 'returned' | 'cancelled';

export interface MaintenanceSpareReservationRow {
  reservation_id: string;
  work_order_id: string;
  asset_id: string;
  sku: string;
  location_id: string;
  lot_id: string | null;
  /** NUMERIC(18,6) as a string: the authoritative reserved amount is stock_balance.allocated. */
  quantity: string;
  quantity_returned: string;
  /** NUMERIC(18,6) exact remainder: quantity - quantity_returned, computed in SQL (never JS float). */
  outstanding: string;
  status: SpareReservationStatus;
  reserved_at: string;
  issued_at: string | null;
  /** YYYY-MM-DD, frozen at issue by addBusinessDays and never recomputed on read. */
  return_due_date: string | null;
  returned_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVATION_STATUSES = new Set([
  'reserved',
  'issued',
  'partially_returned',
  'returned',
  'cancelled',
]);

const RESERVATION_COLUMNS = `reservation_id, work_order_id, asset_id, sku, location_id, lot_id,
    quantity::text AS quantity,
    quantity_returned::text AS quantity_returned,
    (quantity - quantity_returned)::numeric::text AS outstanding,
    status, reserved_at, issued_at,
    to_char(return_due_date, 'YYYY-MM-DD') AS return_due_date,
    returned_at, cancelled_at, cancellation_reason, created_by, created_at, updated_at`;

export async function getSpareReservationById(
  reservationId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<MaintenanceSpareReservationRow | null> {
  if (!UUID_REGEX.test(reservationId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT ${RESERVATION_COLUMNS} FROM maintenance_spare_reservation
      WHERE reservation_id = $1${lockClause}`,
    [reservationId],
  );
  return (result.rows[0] as MaintenanceSpareReservationRow) ?? null;
}

export interface InsertSpareReservationRow {
  reservation_id: string;
  work_order_id: string;
  asset_id: string;
  sku: string;
  location_id: string;
  lot_id: string | null;
  quantity: string;
  reserved_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function insertSpareReservation(
  row: InsertSpareReservationRow,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO maintenance_spare_reservation (
      reservation_id, work_order_id, asset_id, sku, location_id, lot_id, quantity,
      quantity_returned, status, reserved_at, created_by, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,0,'reserved',$8,$9,$10,$11)`,
    [
      row.reservation_id,
      row.work_order_id,
      row.asset_id,
      row.sku,
      row.location_id,
      row.lot_id,
      row.quantity,
      row.reserved_at,
      row.created_by,
      row.created_at,
      row.updated_at,
    ],
  );
}

/**
 * Flips a locked 'reserved' row to 'issued', stamping the frozen three-working-day return clock.
 * The status predicate is repeated in the UPDATE so a concurrent transition cannot slip past the
 * caller's read; the caller asserts rowCount and rejects rather than silently no-opping.
 */
export async function markSpareReservationIssued(
  reservationId: string,
  issuedAt: string,
  returnDueDate: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE maintenance_spare_reservation
        SET status = 'issued', issued_at = $2, return_due_date = $3::date, updated_at = now()
      WHERE reservation_id = $1 AND status = 'reserved'`,
    [reservationId, issuedAt, returnDueDate],
  );
  return result.rowCount ?? 0;
}

/**
 * Adds to the cumulative returned quantity and settles the terminal state in SQL NUMERIC, so the
 * 'returned' versus 'partially_returned' decision never rides on a JS float comparison.
 */
export async function applySpareReservationReturn(
  reservationId: string,
  quantityReturned: string,
  returnedAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE maintenance_spare_reservation
        SET quantity_returned = quantity_returned + $2::numeric,
            status = CASE
              WHEN quantity_returned + $2::numeric >= quantity THEN 'returned'
              ELSE 'partially_returned'
            END,
            returned_at = $3,
            updated_at = now()
      WHERE reservation_id = $1 AND status IN ('issued', 'partially_returned')`,
    [reservationId, quantityReturned, returnedAt],
  );
  return result.rowCount ?? 0;
}

export async function markSpareReservationCancelled(
  reservationId: string,
  cancellationReason: string,
  cancelledAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE maintenance_spare_reservation
        SET status = 'cancelled', cancellation_reason = $2, cancelled_at = $3, updated_at = now()
      WHERE reservation_id = $1 AND status = 'reserved'`,
    [reservationId, cancellationReason, cancelledAt],
  );
  return result.rowCount ?? 0;
}

/**
 * Exact NUMERIC over-return probe used by the seam's RETURN_QUANTITY_EXCEEDS_ISSUED guard: the
 * comparison rides the database (0.1 + 0.2 > 0.3 is false in NUMERIC, true in binary float), so a
 * valid fractional closing return is never spuriously rejected. Runs against the caller's locked
 * reservation row inside the persist transaction.
 */
export async function getSpareReservationReturnExceeds(
  reservationId: string,
  quantityReturned: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `SELECT (quantity_returned + $2::numeric > quantity) AS exceeds
       FROM maintenance_spare_reservation WHERE reservation_id = $1`,
    [reservationId, quantityReturned],
  );
  return result.rows.length > 0 ? (result.rows[0] as { exceeds: boolean }).exceeds : false;
}

/**
 * Exact NUMERIC equality probe for the issue applier's SPARE_DERIVATION_MISMATCH guard: '5' and
 * '5.00' are the same NUMERIC value, so a string comparison would be too strict and a JS float
 * comparison too loose near the column ceiling. Settles in the database.
 */
export async function getSpareReservationQuantityMatches(
  reservationId: string,
  declaredQuantity: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `SELECT (quantity = $2::numeric) AS matches
       FROM maintenance_spare_reservation WHERE reservation_id = $1`,
    [reservationId, declaredQuantity],
  );
  return result.rows.length > 0 ? (result.rows[0] as { matches: boolean }).matches : false;
}

export interface ListSpareReservationsParams {
  work_order_id?: string | undefined;
  sku?: string | undefined;
  location_id?: string | undefined;
  status?: string | undefined;
  /** When true, restrict to open reservations already past their return clock. */
  return_overdue?: boolean | undefined;
  business_date?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSpareReservations(
  params: ListSpareReservationsParams,
  client?: PoolClient,
): Promise<MaintenanceSpareReservationRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.work_order_id) {
    if (!UUID_REGEX.test(params.work_order_id)) return [];
    conditions.push(`work_order_id = $${idx++}`);
    values.push(params.work_order_id);
  }
  if (params.sku) {
    conditions.push(`sku = $${idx++}`);
    values.push(params.sku);
  }
  if (params.location_id) {
    if (!UUID_REGEX.test(params.location_id)) return [];
    conditions.push(`location_id = $${idx++}`);
    values.push(params.location_id);
  }
  if (params.status) {
    if (!RESERVATION_STATUSES.has(params.status)) return [];
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.return_overdue === true) {
    // Anchored on the caller's business_date when supplied, so a report for a past day reproduces
    // exactly; CURRENT_DATE is the read-only convenience fallback for the ad-hoc list route.
    conditions.push(`status IN ('issued', 'partially_returned')`);
    if (params.business_date) {
      conditions.push(`return_due_date < $${idx++}::date`);
      values.push(params.business_date);
    } else {
      conditions.push(`return_due_date < CURRENT_DATE`);
    }
  }

  const limit = Number.isFinite(params.limit ?? 100)
    ? Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 500)
    : 100;
  const offset = Number.isFinite(params.offset ?? 0)
    ? Math.max(Math.trunc(params.offset ?? 0), 0)
    : 0;
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await r.query(
    `SELECT ${RESERVATION_COLUMNS} FROM maintenance_spare_reservation ${where}
      ORDER BY reserved_at ASC, reservation_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as MaintenanceSpareReservationRow[];
}

/**
 * The overdue-return sweep scope, narrowed in SQL against the job's explicit business_date rather
 * than by a JS filter after the fact, so reservations_swept describes exactly what was evaluated
 * (the Story 7.2 counter-honesty lesson). Uses idx_maintenance_spare_reservation_due.
 */
export async function listOverdueReturns(
  businessDate: string,
  scope: { location_id?: string | null | undefined; sku?: string | null | undefined },
  client?: PoolClient,
): Promise<MaintenanceSpareReservationRow[]> {
  const r = runner(client);
  const result = await r.query(
    `SELECT ${RESERVATION_COLUMNS} FROM maintenance_spare_reservation
      WHERE status IN ('issued', 'partially_returned')
        AND return_due_date < $1::date
        AND ($2::uuid IS NULL OR location_id = $2::uuid)
        AND ($3::text IS NULL OR sku = $3::text)
      ORDER BY return_due_date ASC, reservation_id ASC`,
    [businessDate, scope.location_id ?? null, scope.sku ?? null],
  );
  return result.rows as MaintenanceSpareReservationRow[];
}
