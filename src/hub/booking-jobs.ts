import { randomUUID } from 'node:crypto';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { HUB_BOOKING_EXCEPTION_HOURS } from '../compliance/hub-booking.js';
import { listBookingsDueForException } from '../read/projections/hub.js';

/**
 * Story 10.4 (FR-RD-14, AC 4): raises ONE exception per machine-time booking left open for 24 hours
 * from opened_at. Idempotent: the selector skips bookings with exception_raised_at set, and the
 * applier re-checks under the row lock (HUB_BOOKING_NOT_OVERDUE). The booking itself is untouched;
 * the operator resolves the exception by closing it. The notification is emitted by the applier,
 * in the same transaction, to the role carried as data on the machine row.
 *
 * P2: one bad booking never aborts the sweep. Every other error is logged and counted in `failures`;
 * only HUB_BOOKING_NOT_OVERDUE (a close or an overlapping run won the race) is silent.
 */
const SYSTEM = '00000000-0000-0000-0000-000000000000';

export interface HubBookingExceptionResult {
  bookings_evaluated: number;
  exceptions_raised: number;
  failures: number;
  booking_ids: string[];
}

export async function runHubBookingExceptionJob(): Promise<HubBookingExceptionResult> {
  const due = await listBookingsDueForException(HUB_BOOKING_EXCEPTION_HOURS);
  const raised: string[] = [];
  let failures = 0;
  for (const booking of due) {
    const now = new Date().toISOString();
    try {
      await persistEvent({
        stream_type: 'research',
        stream_id: booking.booking_id,
        event_type: 'hub.booking_exception_raised',
        payload: { booking_id: booking.booking_id, raised_at: now },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: SYSTEM, role: 'system', location_id: SYSTEM },
          occurred_at: now,
        },
        idempotency_key: `hub-booking-exception:${booking.booking_id}`,
      } as never);
    } catch (err) {
      if (err instanceof AppError && err.errorCode === 'HUB_BOOKING_NOT_OVERDUE') continue;
      failures += 1;
      console.error(`Hub booking exception failed for booking ${booking.booking_id}:`, err);
      continue;
    }
    raised.push(booking.booking_id);
  }
  return {
    bookings_evaluated: due.length,
    exceptions_raised: raised.length,
    failures,
    booking_ids: raised,
  };
}
