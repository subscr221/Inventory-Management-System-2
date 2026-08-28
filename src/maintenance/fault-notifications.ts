import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { emitNotification } from '../notify/emit.js';
import { getAssetById } from '../read/projections/asset.js';
import { setFaultNotified } from '../read/projections/maintenance_fault_report.js';

/**
 * Story 7.8 (Binding Decision 14): the FR-M-04 supervisor notification for a fault report, factored
 * out of createFaultReportBase so BOTH the REST handler and the edge upload handler call it after a
 * successful maintenance.fault_reported persist. Behaviour is exactly what Story 7.3 shipped:
 *
 * - The 5-minute AC 1 guarantee is the Story 1.11 escalation window. The emission happens AFTER
 *   the fault event commits, through the non-throwing emitNotification (AD-17): a notification
 *   outage must not block a fault report, so on ok:false the write still succeeds and notified_at
 *   stays null. NEVER emitNotificationInTransaction here.
 * - A replay of the same idempotency key returns the ORIGINAL event, so a caller would otherwise
 *   emit a second notification; the notification row on the event ledger is the truth that this
 *   report was already notified - the re-emission is skipped when one exists (the "replay emits no
 *   second notification" acceptance assertion). That object-id dedup is what makes the helper
 *   idempotent across the two callers.
 */
export interface FaultNotificationActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface NotifyFaultReportedInput {
  faultReportId: string;
  assetId: string;
  assetTag: string;
  actor: FaultNotificationActor;
  occurredAt: string;
}

export async function notifyFaultReported(input: NotifyFaultReportedInput): Promise<void> {
  try {
    const existingNotification = await getPool().query(
      `SELECT 1 FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'fault_reported'
        LIMIT 1`,
      [input.faultReportId],
    );
    if (existingNotification.rows.length > 0) return;

    const asset = await getAssetById(input.assetId);
    const emission = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: input.actor.location_id },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault_report',
      object_id: input.faultReportId,
      actor_label: `${asset?.asset_name ?? 'asset'} (${input.assetTag})`,
      next_step: 'Triage and accept or reject',
      escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 300 },
      actor: input.actor,
      correlation_id: randomUUID(),
      occurred_at: input.occurredAt,
    });
    if (!emission.ok) return;

    const emittedAt = emission.event.metadata.occurred_at ?? emission.event.created_at;
    await setFaultNotified(input.faultReportId, emittedAt);
  } catch (err: unknown) {
    // AD-17: the fault report already committed; a failure in the dedup scan, the asset lookup, the
    // emission, or the notified_at patch must never turn the success into a 500 or block the report.
    console.warn(
      `[maintenance] fault notification failed for fault report ${input.faultReportId}`,
      err,
    );
  }
}
