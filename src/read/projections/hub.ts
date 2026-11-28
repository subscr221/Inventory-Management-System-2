import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/** Story 10.4 accessors for hub_customer, hub_machine and hub_booking (FR-RD-13/14). */
export interface HubCustomerRow {
  customer_id: string;
  customer_kind: 'member' | 'walk_in';
  display_name: string;
  membership_no: string | null;
  status: 'active' | 'inactive';
  location_id: string | null;
  source_event_id: string;
  created_at: Date;
  updated_at: Date;
}
export interface HubMachineRow {
  machine_id: string;
  machine_code: string;
  location_id: string;
  asset_id: string;
  meter_id: string | null;
  operator_role: string;
  source_event_id: string;
  created_at: Date;
  updated_at: Date;
}
export interface HubBookingRow {
  booking_id: string;
  customer_id: string;
  machine_id: string;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  actual_minutes: number | null;
  meter_reading_value: string | null;
  reading_id: string | null;
  exception_raised_at: Date | null;
  backdate_reason: string | null;
  source_event_id: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * DN4: the 24h exception clock runs from the later of opened_at and scheduled_start (GREATEST skips a
 * NULL scheduled_start), so a booking made for next week is not overdue a day after creation.
 * $1 = threshold hours. Shared by the selector and the applier's re-check under the lock.
 */
export const HUB_EXCEPTION_DUE_SQL = 'GREATEST(opened_at, scheduled_start) <= now() - make_interval(hours => $1::int)';

type Queryable = Pick<PoolClient, 'query'>;
function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}
const lock = (forUpdate: boolean): string => (forUpdate ? ' FOR UPDATE' : '');

export async function getHubCustomerById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<HubCustomerRow | null> {
  const r = await runner(client).query(
    `SELECT * FROM hub_customer WHERE customer_id = $1${lock(forUpdate)}`,
    [id],
  );
  return (r.rows[0] as HubCustomerRow | undefined) ?? null;
}
/**
 * D4: `scope` is the actor's readable hub locations (null = all, '*'). A customer with no location
 * is unscoped by construction and stays visible to every reader.
 */
export async function listHubCustomers(
  scope: string[] | null = null,
  client?: PoolClient,
): Promise<HubCustomerRow[]> {
  const r = await runner(client).query(
    `SELECT * FROM hub_customer
      WHERE ($1::uuid[] IS NULL OR location_id IS NULL OR location_id = ANY($1::uuid[]))
      ORDER BY created_at, customer_id`,
    [scope],
  );
  return r.rows as HubCustomerRow[];
}

export async function getHubMachineById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<HubMachineRow | null> {
  const r = await runner(client).query(
    `SELECT * FROM hub_machine WHERE machine_id = $1${lock(forUpdate)}`,
    [id],
  );
  return (r.rows[0] as HubMachineRow | undefined) ?? null;
}
export async function listHubMachines(
  scope: string[] | null = null,
  client?: PoolClient,
): Promise<HubMachineRow[]> {
  const r = await runner(client).query(
    'SELECT * FROM hub_machine WHERE ($1::uuid[] IS NULL OR location_id = ANY($1::uuid[])) ORDER BY machine_code',
    [scope],
  );
  return r.rows as HubMachineRow[];
}

export async function getHubBookingById(
  id: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<HubBookingRow | null> {
  const r = await runner(client).query(
    `SELECT * FROM hub_booking WHERE booking_id = $1${lock(forUpdate)}`,
    [id],
  );
  return (r.rows[0] as HubBookingRow | undefined) ?? null;
}
export async function listOpenHubBookings(
  scope: string[] | null = null,
  client?: PoolClient,
): Promise<HubBookingRow[]> {
  const r = await runner(client).query(
    `SELECT b.* FROM hub_booking b JOIN hub_machine m ON m.machine_id = b.machine_id
      WHERE b.status = 'open' AND ($1::uuid[] IS NULL OR m.location_id = ANY($1::uuid[]))
      ORDER BY b.opened_at, b.booking_id`,
    [scope],
  );
  return r.rows as HubBookingRow[];
}
/** Open bookings past the threshold whose exception has not fired yet (idempotent selector). */
export async function listBookingsDueForException(
  thresholdHours: number,
  client?: PoolClient,
): Promise<HubBookingRow[]> {
  const r = await runner(client).query(
    `SELECT * FROM hub_booking
      WHERE status = 'open' AND exception_raised_at IS NULL
        AND ${HUB_EXCEPTION_DUE_SQL}
      ORDER BY opened_at, booking_id`,
    [thresholdHours],
  );
  return r.rows as HubBookingRow[];
}
