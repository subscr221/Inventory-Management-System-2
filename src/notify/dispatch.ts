import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import {
  insertNotification,
  recordDelivery,
  upsertEscalationDef,
  isOptedIn,
  listPushSubscriptionsForUser,
  markEventDispatched,
} from '../read/projections/notification.js';
import { sendPushNotification } from './push.js';

interface NotificationCreatedEventRow {
  event_id: string;
  payload: NotificationCreatedPayload;
  metadata: { occurred_at?: string };
  created_at: Date;
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

async function resolveTargetUserIds(role: string, locationId: string | null): Promise<string[]> {
  const params: unknown[] = [role];
  let locationClause = '';
  if (locationId) {
    params.push(locationId);
    locationClause = `AND (location_id = $2 OR location_id = '*')`;
  }
  const result = await getPool().query(`SELECT DISTINCT user_id FROM user_role_assignments WHERE role = $1 ${locationClause}`, params);
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
 * or directly by tests/one-off recovery. Each event is processed independently; a failure on one
 * event is logged and left undispatched for the next cycle rather than aborting the batch.
 */
export async function runDispatchCycle(limit = 50): Promise<DispatchCycleResult> {
  const events = await findUndispatchedEvents(limit);
  let notificationsCreated = 0;

  for (const event of events) {
    try {
      const payload = event.payload;
      const occurredAt = event.metadata.occurred_at ?? event.created_at.toISOString();

      const userIds = await resolveTargetUserIds(payload.target.role, payload.target.location_id);

      for (const userId of userIds) {
        const notification = await insertNotification({
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
        });
        notificationsCreated += 1;

        await recordDelivery({
          notification_id: notification.notification_id,
          channel: 'in_app',
          outcome: 'delivered',
          trace_id: randomUUID(),
          failure_reason: null,
        });

        // Push is opt-in per event type (default off - EXPERIENCE.md section 13.2); in-app above
        // is never gated by this. A device with no subscription or an opted-out user simply gets
        // no web_push delivery row - that is not a failure, it is the configured default.
        if (await isOptedIn(userId, payload.event_type)) {
          const subscriptions = await listPushSubscriptionsForUser(userId);
          for (const subscription of subscriptions) {
            const pushResult = await sendPushNotification(
              { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
              {
                status_verb: payload.status_verb,
                object_type: payload.object_type,
                object_id: payload.object_id,
                actor_label: payload.actor_label,
                next_step: payload.next_step,
              },
            );
            await recordDelivery({
              notification_id: notification.notification_id,
              channel: 'web_push',
              outcome: pushResult.ok ? 'delivered' : 'failed',
              trace_id: randomUUID(),
              failure_reason: pushResult.failureReason,
            });
          }
        }
      }

      if (payload.escalation) {
        const deadlineAt = new Date(new Date(occurredAt).getTime() + payload.escalation.acknowledgment_window_seconds * 1000).toISOString();
        await upsertEscalationDef({
          source_event_id: event.event_id,
          origin_target_role: payload.target.role,
          escalation_target_role: payload.escalation.target_role,
          acknowledgment_window_seconds: payload.escalation.acknowledgment_window_seconds,
          deadline_at: deadlineAt,
        });
      }

      await markEventDispatched(event.event_id);
    } catch (err) {
      console.error(`Notification dispatch failed for event ${event.event_id} - will retry next cycle:`, err);
    }
  }

  return { eventsProcessed: events.length, notificationsCreated };
}
