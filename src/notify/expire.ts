import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { expireStaleNotifications } from '../read/projections/notification.js';

// Same fixed system identity the escalation clock uses - expiry is a system-driven lifecycle
// transition, not a user action, so there is no human actor to stamp.
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_notification_expiry',
  location_id: '00000000-0000-0000-0000-000000000000',
};

export interface ExpiryCycleResult {
  expired: number;
}

/**
 * Transitions notifications past the retention window (config.notify.notificationRetentionDays,
 * default 30 - EXPERIENCE.md section 13.3) to the fourth lifecycle state, `expired`, and emits one
 * `notification.expired` domain event per row so the transition is visible in the event stream
 * (delivery outcomes stay read-model-only per the review decision, but the lifecycle-terminal
 * expiry is event-sourced). Idempotent by construction: `expireStaleNotifications` only matches
 * rows still in `created`/`read`, so a row already `expired` is never re-expired or re-emitted.
 *
 * The sweep runs in ONE transaction: the row transitions and their notification.expired events
 * commit together (P3 - same atomic-outbox principle as dispatch and escalation). Without this,
 * a failed event insert after the UPDATE committed would leave a row terminally `expired` whose
 * event the idempotency guard then guarantees is NEVER emitted - an event stream that silently
 * disagrees with the read model. On failure everything rolls back and the rows are swept again
 * next cycle. Batch size is naturally bounded: an hourly sweep only picks up rows that crossed
 * the 30-day boundary since the previous sweep.
 *
 * Called on a low-frequency interval (config.notify.expiryIntervalMs) from src/server.ts, or
 * directly by tests.
 */
export async function runExpiryCycle(): Promise<ExpiryCycleResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const expiredRows = await expireStaleNotifications(config.notify.notificationRetentionDays, client);

    for (const row of expiredRows) {
      await persistEvent(
        {
          stream_type: 'notification',
          stream_id: randomUUID(),
          event_type: 'notification.expired',
          payload: {
            notification_id: row.notification_id,
            source_event_id: row.source_event_id,
            target_user_id: row.target_user_id,
            event_type: row.event_type,
            object_type: row.object_type,
            object_id: row.object_id,
          },
          metadata: {
            correlation_id: randomUUID(),
            causation_id: row.source_event_id,
            actor: SYSTEM_ACTOR,
            occurred_at: new Date().toISOString(),
          },
        },
        undefined,
        client,
      );
    }

    await client.query('COMMIT');
    return { expired: expiredRows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Notification expiry cycle failed - rolled back, rows will be swept again next cycle:', err);
    return { expired: 0 };
  } finally {
    client.release();
  }
}
