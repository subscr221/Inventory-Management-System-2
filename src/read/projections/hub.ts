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
  created_at: string;
  updated_at: string;
}
export interface HubMachineRow {
  machine_id: string;
  machine_code: string;
  location_id: string;
  asset_id: string;
  meter_id: string | null;
  operator_role: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}
export interface HubBookingRow {
  booking_id: string;
  customer_id: string;
  machine_id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  actual_minutes: number | null;
  meter_reading_value: string | null;
  reading_id: string | null;
  exception_raised_at: string | null;
  backdate_reason: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

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
        AND opened_at <= now() - make_interval(hours => $1::int)
      ORDER BY opened_at, booking_id`,
    [thresholdHours],
  );
  return r.rows as HubBookingRow[];
}
