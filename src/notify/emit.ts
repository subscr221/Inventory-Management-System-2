import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { persistEvent } from '../events/store.js';
import type { PersistedEvent } from '../events/store.js';

export interface NotificationTarget {
  /** DOA/RBAC role to fan out to (see src/read/projections/users.ts user_role_assignments). */
  role: string;
  /** Location scope; null/undefined targets every holder of the role regardless of location. */
  location_id?: string | null;
}

export interface EscalationDefinition {
  target_role: string;
  acknowledgment_window_seconds: number;
}

export interface EmitNotificationInput {
  target: NotificationTarget;
  /** Business category used for preference matching (EXPERIENCE.md Table 2), e.g. "approval_received". */
  event_type: string;
  /** Content template fields (EXPERIENCE.md section 13.5): "[status_verb]: [object_type] [object_id]. [actor_label]. [next_step]." */
  status_verb: string;
  object_type: string;
  object_id: string;
  actor_label?: string | null;
  next_step?: string | null;
  actor: { user_id: string; role: string; location_id: string };
  correlation_id?: string;
  causation_id?: string | null;
  occurred_at?: string;
  escalation?: EscalationDefinition;
}

export type EmitNotificationResult = { ok: true; event: PersistedEvent } | { ok: false; error: unknown };

/**
 * Normalizes an escalation definition into the persisted payload shape, dropping it entirely if
 * the acknowledgment window is not a positive integer. The DB has a
 * chk_notification_escalation_defs_window CHECK (> 0); catching an invalid window here means a
 * caller's programming error (window <= 0) degrades to "notification without escalation" plus a
 * warning, rather than a poison-pill event the dispatcher can never mark dispatched.
 */
function normalizeEscalation(escalation: EscalationDefinition | undefined): { target_role: string; acknowledgment_window_seconds: number } | null {
  if (!escalation) return null;
  if (!Number.isInteger(escalation.acknowledgment_window_seconds) || escalation.acknowledgment_window_seconds <= 0) {
    console.warn(
      `emitNotification: dropping escalation with non-positive acknowledgment_window_seconds (${escalation.acknowledgment_window_seconds}) for role ${escalation.target_role}`,
    );
    return null;
  }
  return { target_role: escalation.target_role, acknowledgment_window_seconds: escalation.acknowledgment_window_seconds };
}

/**
 * Single emission entry point every module calls instead of building its own notification
 * channel (Story 1.11 AC1/AC4). Writes a `notification.created` domain event on the `notification`
 * stream; the dispatcher (src/notify/dispatch.ts) fans it out to recipients asynchronously.
 *
 * Deliberately does NOT accept the caller's transaction client: an emitting module's own write
 * must never be coupled to (or aborted by) a notification-emission failure. This function always
 * resolves - it never throws - so a broken database, an unreachable dispatcher, or any other
 * failure here can never block the emitting module's own write path (AC4).
 */
export async function emitNotification(input: EmitNotificationInput): Promise<EmitNotificationResult> {
  try {
    const event = await persistEvent({
      stream_type: 'notification',
      stream_id: randomUUID(),
      event_type: 'notification.created',
      payload: {
        target: { role: input.target.role, location_id: input.target.location_id ?? null },
        event_type: input.event_type,
        status_verb: input.status_verb,
        object_type: input.object_type,
        object_id: input.object_id,
        actor_label: input.actor_label ?? null,
        next_step: input.next_step ?? null,
        escalation: normalizeEscalation(input.escalation),
      },
      metadata: {
        correlation_id: input.correlation_id ?? randomUUID(),
        causation_id: input.causation_id ?? null,
        actor: input.actor,
        occurred_at: input.occurred_at ?? new Date().toISOString(),
      },
    });
    return { ok: true, event };
  } catch (error) {
    console.error('emitNotification failed (swallowed - never blocks the caller):', error);
    return { ok: false, error };
  }
}

/**
 * Convenience overload for callers that already hold an open transaction client and explicitly
 * want their own event and the notification to commit atomically (e.g. an approval decision and
 * its notification recorded together). Opt-in only - most callers should use emitNotification().
 * Because this joins the caller's transaction, a failure here DOES propagate like any other write
 * on that connection; callers who need the non-blocking guarantee must use emitNotification()
 * instead.
 */
export async function emitNotificationInTransaction(input: EmitNotificationInput, client: PoolClient): Promise<PersistedEvent> {
  return persistEvent(
    {
      stream_type: 'notification',
      stream_id: randomUUID(),
      event_type: 'notification.created',
      payload: {
        target: { role: input.target.role, location_id: input.target.location_id ?? null },
        event_type: input.event_type,
        status_verb: input.status_verb,
        object_type: input.object_type,
        object_id: input.object_id,
        actor_label: input.actor_label ?? null,
        next_step: input.next_step ?? null,
        escalation: normalizeEscalation(input.escalation),
      },
      metadata: {
        correlation_id: input.correlation_id ?? randomUUID(),
        causation_id: input.causation_id ?? null,
        actor: input.actor,
        occurred_at: input.occurred_at ?? new Date().toISOString(),
      },
    },
    undefined,
    client,
  );
}
