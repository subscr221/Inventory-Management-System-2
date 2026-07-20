import { findRoleHolder } from '../read/projections/doa_registry.js';
import { findDueEscalationDefs, resolveEscalationDef, recordEscalation, getAnyNotificationBySourceEvent } from '../read/projections/notification.js';
import { emitNotification } from './emit.js';

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
 * in-app/push treatment as an original alert. Every hop is recorded via recordEscalation()
 * regardless of whether a holder was found, so "no alert expires silently" holds even when the
 * escalation role itself currently has no active holder.
 */
export async function runEscalationCycle(limit = 50): Promise<EscalationCycleResult> {
  const now = new Date().toISOString();
  const due = await findDueEscalationDefs(now, limit);
  let escalated = 0;

  for (const def of due) {
    try {
      const holder = await findRoleHolder(def.escalation_target_role);
      // Carry the ORIGINAL alert's content forward (any one fanned-out recipient row has it -
      // they're identical except for target_user_id) so the escalation target sees what actually
      // needs attention ("Escalated: fault FLT-0001"), not a content-free escalation record. Falls
      // back to a generic message only if the original role had zero holders at dispatch time.
      const original = await getAnyNotificationBySourceEvent(def.source_event_id);

      const emitted = await emitNotification({
        target: { role: def.escalation_target_role, location_id: null },
        event_type: 'escalation',
        status_verb: 'Escalated',
        object_type: original?.object_type ?? def.origin_target_role,
        object_id: original?.object_id ?? def.source_event_id,
        actor_label: original ? `Unacknowledged by ${def.origin_target_role}` : 'Notification Foundation',
        next_step: 'Acknowledge to stop further escalation',
        actor: SYSTEM_ACTOR,
        causation_id: def.source_event_id,
      });

      await recordEscalation({
        source_event_id: def.source_event_id,
        from_target: `role:${def.origin_target_role}`,
        to_target: `role:${def.escalation_target_role}`,
        resolved_via: holder ? 'doa_role_holder' : 'no_active_holder',
        escalated_source_event_id: emitted.ok ? emitted.event.event_id : null,
      });

      await resolveEscalationDef(def.source_event_id);
      escalated += 1;
    } catch (err) {
      console.error(`Escalation failed for notification event ${def.source_event_id} - will retry next cycle:`, err);
    }
  }

  return { defsProcessed: due.length, escalated };
}
