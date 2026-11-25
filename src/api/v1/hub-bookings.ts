import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson } from '../../middleware/error.js';
import { requireRole } from '../../middleware/rbac.js';
import { HUB_UUID } from '../../compliance/hub-customer.js';
import {
  getHubBookingById,
  getHubMachineById,
  listOpenHubBookings,
} from '../../read/projections/hub.js';
import {
  assertHubLocationAccess,
  HUB_MODULE,
  hubBody,
  hubReadScope,
  persistHubEvent,
} from './hub-common.js';

// Story 10.4 (FR-RD-13/14): machine-time booking open / close / open list.
const open: RouteHandler = async (req, res) => {
  const b = hubBody(req);
  // D4: the actor must cover the machine's location. An unknown machine falls through so the seam
  // answers HUB_MACHINE_NOT_FOUND.
  const machineId = b['machine_id'];
  const machine =
    typeof machineId === 'string' && HUB_UUID.test(machineId) ? await getHubMachineById(machineId) : null;
  if (machine) assertHubLocationAccess(req, machine.location_id, 'write');
  const bookingId = randomUUID();
  // Every customer-reference field is forwarded untouched so the shared guard sees what was sent.
  // D6/X2/X4: opened_at defaults to server now; a client value is bounded by the seam (5 minutes
  // either way, or up to 12 hours back with a backdate_reason).
  const saved = await persistHubEvent(req, res, {
    streamId: bookingId,
    eventType: 'hub.booking_opened',
    idField: 'booking_id',
    compare: [
      'customer_id',
      'member_id',
      'walk_in_id',
      'customer_ids',
      'machine_id',
      'scheduled_start',
      'scheduled_end',
      ...(b['opened_at'] !== undefined ? ['opened_at'] : []),
      'backdate_reason',
    ],
    payload: {
      booking_id: bookingId,
      customer_id: b['customer_id'],
      member_id: b['member_id'],
      walk_in_id: b['walk_in_id'],
      customer_ids: b['customer_ids'],
      machine_id: b['machine_id'],
      scheduled_start: b['scheduled_start'],
      scheduled_end: b['scheduled_end'],
      opened_at: b['opened_at'] ?? new Date().toISOString(),
      backdate_reason: b['backdate_reason'],
    },
  });
  if (saved)
    sendJson(res, 201, {
      booking: await getHubBookingById(saved.id),
      event_id: saved.event.event_id,
    });
};
const close: RouteHandler = async (req, res, params) => {
  const b = hubBody(req);
  const bookingId = params?.bookingId ?? '';
  const existing = HUB_UUID.test(bookingId) ? await getHubBookingById(bookingId) : null;
  const machine = existing ? await getHubMachineById(existing.machine_id) : null;
  if (machine) assertHubLocationAccess(req, machine.location_id, 'write');
  const saved = await persistHubEvent(req, res, {
    streamId: bookingId,
    eventType: 'hub.booking_closed',
    idField: 'booking_id',
    streamFromUrl: true,
    status: 200,
    compare: ['booking_id', 'actual_minutes', 'meter_reading_value', ...(b['closed_at'] !== undefined ? ['closed_at'] : [])],
    payload: {
      booking_id: bookingId,
      actual_minutes: b['actual_minutes'],
      meter_reading_value: b['meter_reading_value'],
      reading_id: randomUUID(),
      closed_at: b['closed_at'] ?? new Date().toISOString(),
    },
  });
  // The close persisted, so the booking exists (the seam refuses an unknown one with a 404).
  if (saved)
    sendJson(res, 200, { booking: await getHubBookingById(bookingId), event_id: saved.event.event_id });
};
const listOpen: RouteHandler = async (req, res) => {
  sendJson(res, 200, { rows: await listOpenHubBookings(hubReadScope(req)) });
};
export const openHubBookingHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'write',
})(open);
export const closeHubBookingHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'write',
})(close);
export const listOpenHubBookingsHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'read',
})(listOpen);
