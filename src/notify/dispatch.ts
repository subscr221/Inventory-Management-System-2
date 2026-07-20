import type { PoolClient } from 'pg';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import {
  insertNotification,
  recordDelivery,
  upsertEscalationDef,
  isOptedIn,
  listPushSubscriptionsForUser,
  claimEventForDispatch,
  recordDispatchFailure,
  clearDispatchAttempts,
} from '../read/projections/notification.js';
import { emitNotification } from './emit.js';
import { sendPushNotification } from './push.js';

// Retry policy for events whose dispatch transaction failed (P2): exponential backoff starting
// at BACKOFF_BASE_SECONDS, doubling per attempt up to BACKOFF_CAP_SECONDS, dead-lettered after
// config.notify.dispatchMaxAttempts attempts.
const BACKOFF_BASE_SECONDS = 2;
const BACKOFF_CAP_SECONDS = 60;

// event_type of the operator alert raised when an event is dead-lettered. Also the recursion
// guard: a dead-letter alert that itself dies never raises another one.
const DEAD_LETTER_EVENT_TYPE = 'dispatch_dead_letter';

// Dead-lettering is a system observation, not a user action - same fixed system-identity pattern
// as the escalation and expiry clocks (src/notify/escalate.ts, src/notify/expire.ts).
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_notification_dispatch',
  location_id: '00000000-0000-0000-0000-000000000000',
};

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
 *
 * The second LEFT JOIN (notification_dispatch_attempts) is the P2 poison-pill guard: an event
 * whose dispatch has failed is skipped until its backoff elapses (next_attempt_at) and excluded
 * permanently once dead-lettered - so a permanently-failing event cannot sit at the front of
 * this oldest-first queue forever, occupying a batch slot and starving every event behind it.
 */
async function findUndispatchedEvents(limit: number): Promise<NotificationCreatedEventRow[]> {
  const result = await getPool().query(
    `SELECT e.event_id, e.payload, e.metadata, e.created_at
     FROM domain_events e
     LEFT JOIN notification_dispatch_log d ON d.source_event_id = e.event_id
     LEFT JOIN notification_dispatch_attempts a ON a.source_event_id = e.event_id
     WHERE e.stream_type = 'notification' AND e.event_type = 'notification.created' AND d.source_event_id IS NULL
       AND (a.source_event_id IS NULL OR (a.dead = false AND a.next_attempt_at <= now()))
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
 * commit and push it is at-most-once (a lost push), never a duplicate.
 *
 * A failure on one event never aborts the batch: the event's transaction rolls back, the failure
 * is recorded with exponential backoff (recordFailedAttempt), and the event retries once its
 * backoff elapses. After config.notify.dispatchMaxAttempts failures it is dead-lettered -
 * excluded from dispatch and surfaced to the fallback-escalation role as an operator alert -
 * so one poison event can never starve the oldest-first queue behind it.
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

      // Successful dispatch retires any retry bookkeeping from earlier failed attempts, keeping
      // notification_dispatch_attempts a list of only currently-failing events. In-transaction so
      // the clear commits (or rolls back) with the claim.
      await clearDispatchAttempts(event.event_id, client);

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
        // Deadline anchoring (AC2): the acknowledgment window is a human-response SLA, so its
        // clock must not start before the alert could reach a human. Anchored at
        // max(occurred_at, now) - an event fanned out late (dispatcher outage, backlog) still
        // gives its recipients the full window, instead of arriving already past its deadline
        // and storming the escalation tier the moment the dispatcher recovers.
        const deadlineBaseMs = Math.max(new Date(occurredAt).getTime(), Date.now());
        const deadlineAt = new Date(deadlineBaseMs + payload.escalation.acknowledgment_window_seconds * 1000).toISOString();
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
      console.error(`Notification dispatch failed for event ${event.event_id} - will retry with backoff:`, err);
      client.release();
      await recordFailedAttempt(event, err);
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

/**
 * Failure bookkeeping for one event, on the pool (autocommit) AFTER the dispatch transaction
 * rolled back - it must survive that rollback to count. Records the attempt with exponential
 * backoff; on the attempt that crosses the cap (dead flips true exactly once - a dead event is
 * never fetched, so it never fails again) it raises a dead-letter alert to the fallback
 * escalation role, because a dead event means notifications someone was meant to receive are NOT
 * being delivered and a human must intervene (fix the cause, then clear the
 * notification_dispatch_attempts row to re-drive). Never throws: bookkeeping failure must not
 * abort the batch loop, and the event stays due for retry regardless.
 */
async function recordFailedAttempt(event: NotificationCreatedEventRow, err: unknown): Promise<void> {
  try {
    const failure = await recordDispatchFailure(event.event_id, err instanceof Error ? err.message : String(err), {
      maxAttempts: config.notify.dispatchMaxAttempts,
      baseBackoffSeconds: BACKOFF_BASE_SECONDS,
      maxBackoffSeconds: BACKOFF_CAP_SECONDS,
    });
    if (!failure.dead) return;

    console.error(`Notification event ${event.event_id} dead-lettered after ${failure.attempts} failed dispatch attempts`);
    // Recursion guard: a dead-letter alert that itself dead-letters (systemic failure - e.g. the
    // DB rejecting all fan-out) never raises another alert, bounding the chain at one hop.
    const failedEventType = (event.payload as Partial<NotificationCreatedPayload> | null)?.event_type;
    if (failedEventType === DEAD_LETTER_EVENT_TYPE) return;

    await emitNotification({
      target: { role: config.notify.fallbackEscalationRole, location_id: null },
      event_type: DEAD_LETTER_EVENT_TYPE,
      status_verb: 'Undeliverable',
      object_type: 'notification_event',
      object_id: event.event_id,
      actor_label: 'Notification Foundation',
      next_step: 'Investigate the dispatch failure, fix the cause, then clear its notification_dispatch_attempts row to re-drive',
      actor: SYSTEM_ACTOR,
      causation_id: event.event_id,
      ...(event.metadata.correlation_id ? { correlation_id: event.metadata.correlation_id } : {}),
    });
  } catch (bookkeepingErr) {
    console.error(`Recording dispatch failure for event ${event.event_id} failed:`, bookkeepingErr);
  }
}
