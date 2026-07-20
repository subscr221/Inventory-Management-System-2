import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import {
  insertNotification,
  recordDelivery,
  upsertEscalationDef,
  isOptedIn,
  listPushSubscriptionsForUser,
  claimEventForDispatch,
} from '../read/projections/notification.js';
import { sendPushNotification } from './push.js';

interface NotificationCreatedEventRow {
  event_id: string;
  payload: NotificationCreatedPayload;
  metadata: { occurred_at?: string; correlation_id?: string };
  created_at: Date;
}

interface PendingPush {
  notificationId: string;
  traceId: string;
  subscriptions: Awaited<ReturnType<typeof listPushSubscriptionsForUser>>;
  payload: NotificationCreatedPayload;
}

/**
 * Resolves the event's business timestamp, defending against a malformed `occurred_at`. An
 * emitter (or a future edge-originated event) could carry an unparseable `occurred_at`; feeding
 * it into `new Date(occurredAt).getTime()` yields NaN, and the escalation deadline math then hits
 * `new Date(NaN).toISOString()`, which THROWS - turning the event into a poison pill that
 * reprocesses forever. Fall back to the append time (`created_at`) instead, which pg always
 * returns as a Date but is normalized defensively here too.
 */
function resolveOccurredAt(event: NotificationCreatedEventRow): string {
  const raw = event.metadata.occurred_at;
  if (raw) {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return event.created_at instanceof Date ? event.created_at.toISOString() : new Date(event.created_at).toISOString();
}

interface NotificationCreatedPayload {
  target: { role: string; location_id: string | null };
  event_type: string;
  status_verb: string;
  object_type: string;
  object_id: string;
  actor_label: string | null;
  next_step: string | null;
  escalation: { target_role: string; acknowledgment_window_seconds: number } | null;
}

/**
 * Undispatched `notification.created` events, oldest first. The LEFT JOIN against
 * notification_dispatch_log (rather than a status column on domain_events) keeps domain_events
 * append-only, matching every other stream in this system, and makes the dispatcher resumable:
 * a crash between fan-out and markEventDispatched simply reprocesses the same event next cycle -
 * safe because insertNotification (unique on source_event_id + target_user_id) is idempotent.
 */
async function findUndispatchedEvents(limit: number): Promise<NotificationCreatedEventRow[]> {
  const result = await getPool().query(
    `SELECT e.event_id, e.payload, e.metadata, e.created_at
     FROM domain_events e
     LEFT JOIN notification_dispatch_log d ON d.source_event_id = e.event_id
     WHERE e.stream_type = 'notification' AND e.event_type = 'notification.created' AND d.source_event_id IS NULL
     ORDER BY e.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows as NotificationCreatedEventRow[];
}

async function resolveTargetUserIds(role: string, locationId: string | null, client: PoolClient): Promise<string[]> {
  const params: unknown[] = [role];
  let locationClause = '';
  if (locationId) {
    params.push(locationId);
    locationClause = `AND (location_id = $2 OR location_id = '*')`;
  }
  const result = await client.query(`SELECT DISTINCT user_id FROM user_role_assignments WHERE role = $1 ${locationClause}`, params);
  return result.rows.map((row) => row['user_id'] as string);
}

export interface DispatchCycleResult {
  eventsProcessed: number;
  notificationsCreated: number;
}

/**
 * Fans out every undispatched `notification.created` event to its target role/location's current
 * role holders (AC1), delivering in-app (always recorded) and web push (opted-in users with a
 * push subscription only), then schedules an escalation clock when the alert defines one (AC2).
 * Designed to be called repeatedly - by an in-process interval in production (see src/server.ts)
 * or directly by tests/one-off recovery.
 *
 * Each event is processed in its OWN transaction that (a) atomically claims the event via
 * `claimEventForDispatch` - so an overlapping cycle or a second instance that races on the same
 * event loses the claim and skips it rather than duplicating deliveries - and (b) commits the
 * notification rows, in-app delivery rows, and escalation def together with that claim. A crash
 * before COMMIT rolls the whole event back (claim included), so it reprocesses cleanly with no
 * duplicate `notification_deliveries`. Web push is an external side-effect and is therefore sent
 * AFTER the commit (never holding a DB transaction open across a network call); on a crash between
 * commit and push it is at-most-once (a lost push), never a duplicate. A failure on one event is
 * logged and left for the next cycle rather than aborting the batch.
 */
export async function runDispatchCycle(limit = 50): Promise<DispatchCycleResult> {
  const events = await findUndispatchedEvents(limit);
  const pool = getPool();
  let notificationsCreated = 0;

  for (const event of events) {
    const pendingPush: PendingPush[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic claim: only the cycle that wins this insert fans the event out. A loser rolls back
      // and skips - never double-processing.
      const claimed = await claimEventForDispatch(event.event_id, client);
      if (!claimed) {
        await client.query('ROLLBACK');
        continue;
      }

      const payload = event.payload;
      const occurredAt = resolveOccurredAt(event);
      // AC1 traceability: correlate a delivery back to its originating event (and thus the emitting
      // request) via the event's correlation_id, rather than an unrelated fresh UUID.
      const traceId = event.metadata.correlation_id ?? event.event_id;

      const userIds = await resolveTargetUserIds(payload.target.role, payload.target.location_id, client);

      for (const userId of userIds) {
        const notification = await insertNotification(
          {
            source_event_id: event.event_id,
            target_user_id: userId,
            target_role: payload.target.role,
            target_location_id: payload.target.location_id,
            event_type: payload.event_type,
            status_verb: payload.status_verb,
            object_type: payload.object_type,
            object_id: payload.object_id,
            actor_label: payload.actor_label,
            next_step: payload.next_step,
            occurred_at: occurredAt,
          },
          client,
        );
        notificationsCreated += 1;

        await recordDelivery(
          { notification_id: notification.notification_id, channel: 'in_app', outcome: 'delivered', trace_id: traceId, failure_reason: null },
          client,
        );

        // Push is opt-in per event type (default off - EXPERIENCE.md section 13.2); in-app above
        // is never gated by this. Collect the push targets here but SEND them after COMMIT so the
        // transaction is never held open across an external network call.
        if (await isOptedIn(userId, payload.event_type, client)) {
          const subscriptions = await listPushSubscriptionsForUser(userId, client);
          if (subscriptions.length > 0) {
            pendingPush.push({ notificationId: notification.notification_id, traceId, subscriptions, payload });
          }
        }
      }

      // A non-positive acknowledgment window would violate chk_notification_escalation_defs_window
      // and abort the whole event (leaving it forever unclaimed on rollback - a poison pill). Skip
      // the escalation def for an invalid window; the notification itself still delivers.
      if (payload.escalation && payload.escalation.acknowledgment_window_seconds > 0) {
        const deadlineAt = new Date(new Date(occurredAt).getTime() + payload.escalation.acknowledgment_window_seconds * 1000).toISOString();
        await upsertEscalationDef(
          {
            source_event_id: event.event_id,
            origin_target_role: payload.target.role,
            escalation_target_role: payload.escalation.target_role,
            acknowledgment_window_seconds: payload.escalation.acknowledgment_window_seconds,
            deadline_at: deadlineAt,
          },
          client,
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`Notification dispatch failed for event ${event.event_id} - will retry next cycle:`, err);
      client.release();
      continue;
    }
    client.release();

    // Web push, post-commit (see the doc comment). recordDelivery here uses the pool (autocommit);
    // the event is already marked dispatched, so these rows are never reprocessed/duplicated.
    for (const job of pendingPush) {
      for (const subscription of job.subscriptions) {
        const pushResult = await sendPushNotification(
          { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
          {
            status_verb: job.payload.status_verb,
            object_type: job.payload.object_type,
            object_id: job.payload.object_id,
            actor_label: job.payload.actor_label,
            next_step: job.payload.next_step,
          },
        );
        await recordDelivery({
          notification_id: job.notificationId,
          channel: 'web_push',
          outcome: pushResult.ok ? 'delivered' : 'failed',
          trace_id: job.traceId,
          failure_reason: pushResult.failureReason,
        }).catch((err) => console.error(`Recording web_push delivery failed for notification ${job.notificationId}:`, err));
      }
    }
  }

  return { eventsProcessed: events.length, notificationsCreated };
}
