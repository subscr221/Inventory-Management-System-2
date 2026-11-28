import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { alreadyPersisted } from './indent.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getAssetById } from '../read/projections/asset.js';
import { getMeterById } from '../read/projections/asset_meter.js';
import { HUB_EXCEPTION_DUE_SQL, getHubBookingById, getHubMachineById } from '../read/projections/hub.js';
import { applyAssetMeterProjection } from './asset-meter.js';
import {
  assertSingleHubCustomerRef,
  hubReject,
  HUB_UUID,
  requireActiveHubCustomer,
  requireHubLocation,
} from './hub-customer.js';

/**
 * Story 10.4 (FR-RD-13/14): hub machine link, machine-time booking open/close and the 24-hour
 * unclosed-booking exception. A close feeds the Story 7.2 usage-meter register by calling that
 * seam's own applier inside the SAME transaction, so METER_READING_REGRESSION rolls the close back.
 */
export const HUB_BOOKING_EXCEPTION_HOURS = 24;
const TYPES = new Set([
  'hub.machine_registered',
  'hub.machine_meter_linked',
  'hub.booking_opened',
  'hub.booking_closed',
  'hub.booking_exception_raised',
]);
// Explicit UTC offset required: a naive timestamp would shift the 24h clock (see asset-meter.ts).
const ISO_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
// D6/X2/X4: a client-supplied closed_at must sit within this window of server time; opened_at may
// also be late-logged (up to BACKDATE_MAX_MS back) when a backdate_reason is given. The window is
// enforced in the APPLIER, which runs only for a new event: an idempotent replay returns the
// original event before any applier, so a replay is never refused for its age. Known limit: an
// offline-queued hub event is accepted only while its timestamps are inside these bounds.
const WINDOW_MS = 5 * 60 * 1000;
const BACKDATE_MAX_MS = 12 * 60 * 60 * 1000;
const BACKDATE_REASON_MAX = 500;
// X6: operator_role is the exception recipient. The repo has no role registry (roles are free text
// on user_role_assignments), so the check is a pattern only.
const OPERATOR_ROLE = /^[A-Za-z0-9_-]{1,64}$/;
const validOperatorRole = (v: unknown): v is string => typeof v === 'string' && OPERATOR_ROLE.test(v.trim());
// P-J: NUMERIC(18,4) holds 14 integer and 4 decimal digits. The shortest decimal string of the
// double must already fit that (no exponent form, at most 4 decimals), so nothing is silently rounded
// (0.30000000000000004 is refused, 0.3 and 120.5 pass) and 1e14 and above is out of range.
const METER_VALUE = /^\d{1,14}(\.\d{1,4})?$/;
// P5: sane upper bound for operator-reported machine minutes (about 69 days).
const ACTUAL_MINUTES_MAX = 100000;

export function hubBookingEventType(envelope: EventEnvelope): string | null {
  return envelope.stream_type === 'research' && TYPES.has(envelope.event_type)
    ? envelope.event_type
    : null;
}

// P-G: every calendar and clock component is checked, so an impossible date such as 2026-02-30 (which
// some parsers roll over to March) is INVALID_PARAMS here and never a 500 at the database.
function isTs(v: unknown): v is string {
  const m = typeof v === 'string' ? ISO_TS.exec(v) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // R2: Postgres timestamptz rejects year 0000 and the like; keep to a sane calendar range.
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  if (d < 1 || d > days) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return !Number.isNaN(Date.parse(v as string));
}
function uuid(p: Record<string, unknown>, f: string): void {
  if (typeof p[f] !== 'string' || !HUB_UUID.test(p[f])) hubReject('INVALID_PARAMS', `${f} must be a UUID`);
}
function nearNow(p: Record<string, unknown>, f: string): void {
  if (Math.abs(Date.parse(p[f] as string) - Date.now()) > WINDOW_MS)
    hubReject('INVALID_PARAMS', `${f} must be within 5 minutes of server time`, { [f]: p[f] });
}
/** X4: opened_at may be up to 12h in the past with a reason; the 5-minute future skew limit stays. */
function openedAtReason(p: Record<string, unknown>): string | null {
  const age = Date.now() - Date.parse(p['opened_at'] as string);
  const reason = typeof p['backdate_reason'] === 'string' && p['backdate_reason'].trim() ? p['backdate_reason'].trim() : null;
  if (-age > WINDOW_MS)
    hubReject('INVALID_PARAMS', 'opened_at must not be more than 5 minutes in the future', { opened_at: p['opened_at'] });
  if (age <= WINDOW_MS) return reason;
  if (age > BACKDATE_MAX_MS)
    hubReject('INVALID_PARAMS', 'opened_at must not be more than 12 hours in the past', { opened_at: p['opened_at'] });
  if (!reason)
    hubReject('INVALID_PARAMS', 'backdate_reason is required when opened_at is more than 5 minutes in the past', { opened_at: p['opened_at'] });
  return reason;
}
function ts(p: Record<string, unknown>, f: string): void {
  if (!isTs(p[f]))
    hubReject('INVALID_PARAMS', `${f} must be an ISO-8601 timestamp with an explicit UTC offset`, { [f]: p[f] });
}

/** The synthetic meter-register event a booking close feeds to the Story 7.2 applier. */
function meterEnvelope(
  envelope: EventEnvelope,
  assetId: string,
  meterId: string,
): EventEnvelope {
  const p = envelope.payload as Record<string, unknown>;
  return {
    stream_type: 'maintenance',
    stream_id: meterId,
    event_type: 'maintenance.meter_reading_recorded',
    payload: {
      reading_id: p['reading_id'],
      meter_id: meterId,
      asset_id: assetId,
      reading_value: p['meter_reading_value'],
      reading_at: p['closed_at'],
      source: 'hub_booking',
      capture_method: 'manual_entry',
    },
    metadata: envelope.metadata,
  };
}

export function assertHubBookingShape(envelope: EventEnvelope): void {
  const type = hubBookingEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  if (type === 'hub.machine_registered') {
    uuid(p, 'machine_id');
    uuid(p, 'location_id');
    uuid(p, 'asset_id');
    if (p['meter_id'] != null) uuid(p, 'meter_id');
    if (typeof p['machine_code'] !== 'string' || !p['machine_code'].trim()) hubReject('INVALID_PARAMS', 'machine_code is required');
    if (!validOperatorRole(p['operator_role']))
      hubReject('INVALID_PARAMS', 'operator_role must be 1 to 64 letters, digits, underscores or hyphens', { operator_role: p['operator_role'] });
    return;
  }
  if (type === 'hub.machine_meter_linked') {
    uuid(p, 'machine_id');
    uuid(p, 'meter_id');
    return;
  }
  uuid(p, 'booking_id');
  if (type === 'hub.booking_opened') {
    assertSingleHubCustomerRef(p);
    uuid(p, 'machine_id');
    ts(p, 'opened_at');
    for (const f of ['scheduled_start', 'scheduled_end']) if (p[f] != null) ts(p, f);
    if (p['backdate_reason'] != null && (typeof p['backdate_reason'] !== 'string' || p['backdate_reason'].trim().length > BACKDATE_REASON_MAX))
      hubReject('INVALID_PARAMS', `backdate_reason must be a string of at most ${BACKDATE_REASON_MAX} characters`);
    if (p['scheduled_start'] != null && p['scheduled_end'] != null && Date.parse(p['scheduled_end'] as string) < Date.parse(p['scheduled_start'] as string))
      hubReject('INVALID_PARAMS', 'scheduled_end must not precede scheduled_start');
  } else if (type === 'hub.booking_closed') {
    const m = p['actual_minutes'];
    if (!Number.isInteger(m) || (m as number) < 0 || (m as number) > ACTUAL_MINUTES_MAX)
      hubReject('INVALID_PARAMS', `actual_minutes must be an integer from 0 to ${ACTUAL_MINUTES_MAX}`, { actual_minutes: m });
    const v = p['meter_reading_value'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      hubReject('INVALID_PARAMS', 'meter_reading_value must be a finite number greater than or equal to 0', { meter_reading_value: v });
    // P-J: exact decimal check (see METER_VALUE), named for the close field.
    if (!METER_VALUE.test(String(v)))
      hubReject('INVALID_PARAMS', 'meter_reading_value must fit NUMERIC(18,4) with at most 4 decimals', { meter_reading_value: v });
    uuid(p, 'reading_id');
    ts(p, 'closed_at');
  } else {
    ts(p, 'raised_at');
  }
}

export async function applyHubBookingProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = hubBookingEventType(envelope);
  if (!type || (await alreadyPersisted(envelope, client))) return;
  const p = envelope.payload as Record<string, unknown>;
  if (type === 'hub.machine_registered') return applyMachine(p, client, eventId);
  if (type === 'hub.machine_meter_linked') return applyMeterLinked(p, client);
  if (type === 'hub.booking_opened') return applyOpened(p, client, eventId);
  if (type === 'hub.booking_closed') return applyClosed(envelope, client);
  return applyException(envelope, client);
}

function isDuplicate(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === '23505';
}

async function applyMachine(p: Record<string, unknown>, client: PoolClient, eventId: string): Promise<void> {
  await requireHubLocation(client, p['location_id']);
  // P-E: ids are compared and stored lowercase (the DB returns uuids lowercase).
  const assetId = (p['asset_id'] as string).toLowerCase();
  const meterId = p['meter_id'] != null ? (p['meter_id'] as string).toLowerCase() : null;
  if (!(await getAssetById(assetId, client)))
    hubReject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: p['asset_id'] }, 404);
  if (meterId) {
    const meter = await getMeterById(meterId, client);
    if (!meter) hubReject('METER_NOT_FOUND', 'Meter not found', { meter_id: p['meter_id'] }, 404);
    if (meter.asset_id !== assetId)
      hubReject('INVALID_PARAMS', "meter_id must belong to the machine's asset", { meter_id: p['meter_id'] });
  }
  try {
    await client.query(
      `INSERT INTO hub_machine (machine_id, machine_code, location_id, asset_id, meter_id, operator_role, source_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p['machine_id'], (p['machine_code'] as string).trim(), p['location_id'], assetId, meterId, (p['operator_role'] as string).trim(), eventId],
    );
  } catch (err) {
    if (isDuplicate(err))
      hubReject('HUB_DUPLICATE_RECORD', 'A hub machine with this id, code, asset or meter exists', { machine_code: p['machine_code'] }, 409);
    throw err;
  }
}

async function applyMeterLinked(p: Record<string, unknown>, client: PoolClient): Promise<void> {
  const machine = await getHubMachineById(p['machine_id'] as string, client, true);
  if (!machine) hubReject('HUB_MACHINE_NOT_FOUND', 'Hub machine not found', { machine_id: p['machine_id'] }, 404);
  const meterId = (p['meter_id'] as string).toLowerCase();
  const meter = await getMeterById(meterId, client);
  if (!meter) hubReject('METER_NOT_FOUND', 'Meter not found', { meter_id: p['meter_id'] }, 404);
  if (meter.asset_id !== machine.asset_id)
    hubReject('INVALID_PARAMS', "meter_id must belong to the machine's asset", { meter_id: p['meter_id'] });
  if (machine.meter_id === meterId) return;
  if (machine.meter_id)
    hubReject('HUB_DUPLICATE_RECORD', 'The machine is already linked to a different meter', { machine_id: machine.machine_id }, 409);
  try {
    await client.query('UPDATE hub_machine SET meter_id = $2, updated_at = now() WHERE machine_id = $1', [machine.machine_id, meterId]);
  } catch (err) {
    if (isDuplicate(err))
      hubReject('HUB_DUPLICATE_RECORD', 'That meter is already linked to another hub machine', { meter_id: p['meter_id'] }, 409);
    throw err;
  }
}

async function applyOpened(p: Record<string, unknown>, client: PoolClient, eventId: string): Promise<void> {
  const backdateReason = openedAtReason(p);
  const customer = await requireActiveHubCustomer(client, assertSingleHubCustomerRef(p));
  const machineId = p['machine_id'] as string;
  const machine = await getHubMachineById(machineId, client, true);
  if (!machine) hubReject('HUB_MACHINE_NOT_FOUND', 'Hub machine not found', { machine_id: machineId }, 404);
  // P-F: an unmetered machine cannot be booked, so the refusal comes at open, not at close.
  if (!machine.meter_id)
    hubReject('HUB_MACHINE_NOT_METERED', 'The machine has no linked usage meter', { machine_id: machineId }, 409);
  // D3/X3: checked under the machine row lock, so two concurrent opens cannot both pass. Only an
  // overlapping scheduled window conflicts; an open booking (or a new one) with no complete
  // window conflicts with every open booking on the machine.
  const busy = await client.query(
    `SELECT booking_id FROM hub_booking
      WHERE machine_id = $1 AND status = 'open'
        AND ($2::timestamptz IS NULL OR $3::timestamptz IS NULL
             OR scheduled_start IS NULL OR scheduled_end IS NULL
             OR (scheduled_start < $3::timestamptz AND $2::timestamptz < scheduled_end))
      LIMIT 1`,
    [machineId, p['scheduled_start'] ?? null, p['scheduled_end'] ?? null],
  );
  if (busy.rows[0])
    hubReject('HUB_MACHINE_BUSY', 'The machine already has an open booking in that window', { machine_id: machineId, booking_id: busy.rows[0]['booking_id'] }, 409);
  try {
    await client.query(
      `INSERT INTO hub_booking (booking_id, customer_id, machine_id, scheduled_start, scheduled_end, opened_at, backdate_reason, source_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p['booking_id'], customer.customer_id, machineId, p['scheduled_start'] ?? null, p['scheduled_end'] ?? null, p['opened_at'], backdateReason, eventId],
    );
  } catch (err) {
    if (isDuplicate(err))
      hubReject('HUB_DUPLICATE_RECORD', 'A hub booking with this id exists', { booking_id: p['booking_id'] }, 409);
    throw err;
  }
}

async function applyClosed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  nearNow(p, 'closed_at');
  const booking = await getHubBookingById(p['booking_id'] as string, client, true);
  if (!booking) hubReject('HUB_BOOKING_NOT_FOUND', 'Hub booking not found', { booking_id: p['booking_id'] }, 404);
  if (booking.status !== 'open')
    hubReject('HUB_BOOKING_ALREADY_CLOSED', 'Hub booking is already closed', { booking_id: booking.booking_id }, 409);
  const machine = await getHubMachineById(booking.machine_id, client, true);
  if (!machine?.meter_id)
    hubReject('HUB_MACHINE_NOT_METERED', 'The booked machine has no linked usage meter', { machine_id: booking.machine_id }, 409);
  // opened_at is a Date at runtime (pg); getTime() keeps the milliseconds that Date.parse(String(d)) drops.
  const openedMs = new Date(booking.opened_at).getTime();
  const closedMs = new Date(p['closed_at'] as string).getTime();
  if (closedMs < openedMs)
    hubReject('INVALID_PARAMS', 'closed_at must not precede opened_at', { closed_at: p['closed_at'] });
  const elapsedMinutes = Math.ceil((closedMs - openedMs) / 60000);
  if ((p['actual_minutes'] as number) > elapsedMinutes)
    hubReject('INVALID_PARAMS', 'actual_minutes must not exceed the minutes between opened_at and closed_at', {
      actual_minutes: p['actual_minutes'],
      elapsed_minutes: elapsedMinutes,
    });
  // Same transaction: a regression (or any meter-seam rejection) aborts the whole close.
  await applyAssetMeterProjection(meterEnvelope(envelope, machine.asset_id, machine.meter_id), client);
  await client.query(
    `UPDATE hub_booking SET status='closed', closed_at=$2, actual_minutes=$3, meter_reading_value=$4, reading_id=$5, updated_at=now()
      WHERE booking_id=$1`,
    [booking.booking_id, p['closed_at'], p['actual_minutes'], p['meter_reading_value'], p['reading_id']],
  );
}

async function applyException(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const booking = await getHubBookingById(p['booking_id'] as string, client, true);
  if (!booking) hubReject('HUB_BOOKING_NOT_FOUND', 'Hub booking not found', { booking_id: p['booking_id'] }, 404);
  const due = await client.query(
    `SELECT (${HUB_EXCEPTION_DUE_SQL}) AS due FROM hub_booking WHERE booking_id = $2`,
    [HUB_BOOKING_EXCEPTION_HOURS, booking.booking_id],
  );
  // Re-checked under the lock so an overlapping run or a late close never raises a second/false one.
  if (booking.status !== 'open' || booking.exception_raised_at !== null || !due.rows[0]?.['due'])
    hubReject('HUB_BOOKING_NOT_OVERDUE', 'The booking is not an open, unflagged booking past the threshold', { booking_id: booking.booking_id }, 409);
  const machine = await getHubMachineById(booking.machine_id, client);
  // X6: a row whose operator_role was not validated at registration must fail loudly (the sweep
  // counts it in `failures`), never raise an exception that notifies nobody.
  if (!machine || !validOperatorRole(machine.operator_role))
    hubReject('INVALID_PARAMS', 'The booked machine has no valid operator_role to notify', { machine_id: booking.machine_id });
  await client.query('UPDATE hub_booking SET exception_raised_at=$2, updated_at=now() WHERE booking_id=$1', [booking.booking_id, p['raised_at']]);
  // The recipient is DATA on the machine row (operator_role), never a role literal here. D1: role
  // only, no location_id (the pm-jobs precedent); dispatch then notifies every holder of the role at
  // any location (resolveTargetUserIds adds no location clause when location_id is null).
  await emitNotificationInTransaction(
    {
      target: { role: machine.operator_role },
      event_type: 'hub_booking_unclosed',
      status_verb: 'raised',
      object_type: 'hub_booking',
      object_id: booking.booking_id,
      actor_label: `Machine ${machine.machine_code} booking open over ${HUB_BOOKING_EXCEPTION_HOURS}h`,
      next_step: 'Close the booking with the actual machine time and meter reading.',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
    },
    client,
  );
}
