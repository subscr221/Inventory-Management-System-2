import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { findRoleHolder } from '../read/projections/doa_registry.js';
import { findDueEscalationDefs, resolveEscalationDef, recordEscalation, getAnyNotificationBySourceEvent } from '../read/projections/notification.js';
import { emitNotificationInTransaction } from './emit.js';

// The escalation clock is a system process, not a user action - there is no human actor to
// stamp on the resulting notification.created event's metadata.actor, so it uses a fixed
// system identity, the same pattern src/api/v1/instruments.ts uses for its NO_LOCATION_UUID.
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_notification_escalation',
  location_id: '00000000-0000-0000-0000-000000000000',
};

export interface EscalationCycleResult {
  defsProcessed: number;
  escalated: number;
}

/**
 * Escalates every alert whose acknowledgment window has elapsed with no acknowledgment from any
 * of its recipients (AC2). The escalation target is a role, resolved through the DOA registry's
 * findRoleHolder() (AD-3 - see src/read/projections/doa_registry.ts, the same resolver Story 1.7's
 * calibration escalation uses) rather than any hard-coded mapping. Escalation is delivered through
 * emitNotification() again - an escalated alert is not a special case, it is simply a second
 * notification targeting the escalation role - so escalation recipients get the identical
 * in-app/push treatment as an original alert.
 *
 * ATOMIC CLAIM+HOP (AC2 correctness): each def is processed in its OWN transaction that claims
 * the def via resolveEscalationDef - an atomic `UPDATE ... WHERE resolved = false` that returns
 * true only for the caller that flipped it - and commits the escalation notification, the hop
 * record, and the notification.escalated event together with that claim. A concurrent
 * /acknowledge (or an overlapping cycle / second instance) that races on the same def loses the
 * claim and skips, so an alert acknowledged a moment before the deadline never escalates and the
 * same def never double-fires. And because claim and hop commit (or roll back) as one unit, a
 * crash or DB failure anywhere mid-hop releases the claim - the def is retried next cycle instead
 * of being silently resolved with no escalation ever emitted. The escalation path is at-least-once
 * by construction, mirroring the dispatcher (src/notify/dispatch.ts).
 *
 * NO SILENT EXPIRY (AC2 / Task 4.5): the escalation notification is itself emitted WITH a follow-on
 * escalation targeting the configured fallback role (config.notify.fallbackEscalationRole), so an
 * escalated alert that is never acknowledged keeps climbing until it reaches the fallback tier -
 * which is terminal (emitted without further escalation). The chain is bounded to at most one hop
 * beyond the fallback and always ends at a guaranteed-staffed role, so no alert closes with nobody
 * ever reachable, even when the immediate escalation target currently has no active holder.
 */
export async function runEscalationCycle(limit = 50): Promise<EscalationCycleResult> {
  const now = new Date().toISOString();
  const fallbackRole = config.notify.fallbackEscalationRole;
  const due = await findDueEscalationDefs(now, limit);
  const pool = getPool();
  let escalated = 0;

  for (const def of due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic claim, inside THIS transaction: only proceed if this cycle flipped resolved
      // false -> true. A rollback below releases the claim, so a failed hop is retried next
      // cycle instead of being lost.
      const claimed = await resolveEscalationDef(def.source_event_id, client);
      if (!claimed) {
        await client.query('ROLLBACK');
        continue;
      }

      const holder = await findRoleHolder(def.escalation_target_role, client);
      // Carry the ORIGINAL alert's content forward (any one fanned-out recipient row has it -
      // they're identical except for target_user_id) so the escalation target sees what actually
      // needs attention ("Escalated: fault FLT-0001"), not a content-free escalation record.
      const original = await getAnyNotificationBySourceEvent(def.source_event_id, client);

      // Terminal tier: an alert already at the fallback role escalates no further (bounding the
      // chain). Any other target attaches a follow-on escalation to the fallback role so a
      // never-acknowledged escalation eventually reaches a guaranteed-staffed tier.
      const isFinalTier = def.escalation_target_role === fallbackRole;

      // In-transaction emission: unlike emitNotification, a failure here THROWS and rolls the
      // claim back with it - exactly the coupling this path wants, since a claimed-but-never-
      // emitted escalation would otherwise vanish silently.
      const emittedEvent = await emitNotificationInTransaction(
        {
          target: { role: def.escalation_target_role, location_id: null },
          event_type: 'escalation',
          status_verb: 'Escalated',
          object_type: original?.object_type ?? def.origin_target_role,
          object_id: original?.object_id ?? def.source_event_id,
          actor_label: original ? `Unacknowledged by ${def.origin_target_role}` : 'Notification Foundation',
          next_step: 'Acknowledge to stop further escalation',
          actor: SYSTEM_ACTOR,
          causation_id: def.source_event_id,
          ...(isFinalTier
            ? {}
            : { escalation: { target_role: fallbackRole, acknowledgment_window_seconds: def.acknowledgment_window_seconds } }),
        },
        client,
      );

      await recordEscalation(
        {
          source_event_id: def.source_event_id,
          from_target: `role:${def.origin_target_role}`,
          to_target: `role:${def.escalation_target_role}`,
          resolved_via: holder ? 'doa_role_holder' : 'no_active_holder',
          escalated_source_event_id: emittedEvent.event_id,
        },
        client,
      );

      // Task 4.4: record the hop as a domain event, not only a read-model row. In-transaction:
      // the hop's event-stream record commits with the hop itself.
      await persistEvent(
        {
          stream_type: 'notification',
          stream_id: randomUUID(),
          event_type: 'notification.escalated',
          payload: {
            source_event_id: def.source_event_id,
            from_target: `role:${def.origin_target_role}`,
            to_target: `role:${def.escalation_target_role}`,
            resolved_via: holder ? 'doa_role_holder' : 'no_active_holder',
            escalated_source_event_id: emittedEvent.event_id,
            final_tier: isFinalTier,
          },
          metadata: {
            correlation_id: randomUUID(),
            causation_id: def.source_event_id,
            actor: SYSTEM_ACTOR,
            occurred_at: new Date().toISOString(),
          },
        },
        undefined,
        client,
      );

      await client.query('COMMIT');
      escalated += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`Escalation failed for notification event ${def.source_event_id} - claim released, will retry next cycle:`, err);
    } finally {
      client.release();
    }
  }

  return { defsProcessed: due.length, escalated };
}
