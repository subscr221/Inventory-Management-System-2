import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import type { EventEnvelope } from '../events/store.js';
import { emitNotification } from '../notify/emit.js';
import { getAssetById } from '../read/projections/asset.js';
import { getWorkOrderById } from '../read/projections/maintenance_work_order.js';
import { getSpareReservationById } from '../read/projections/maintenance_spare_reservation.js';

/**
 * Story 7.8 (FR-M-17, AC 2, Binding Decisions 4 and 5): raising a maintenance sync conflict.
 *
 * The raise runs OUTSIDE and AFTER the failed upload transaction: the conflicting persist has
 * already rolled back when this is called, so the queue row is a fresh event on its own stream
 * (stream_id = conflict_id) that can never be entangled with the rejected write. The raise
 * envelope's actor is the DEVICE actor (the technician, their role, their site), so captured_by
 * and the notification's location scope derive from the same source as every other maintenance
 * seam. Idempotent on the conflicting event id: idempotency_key sync-conflict-<event_id> makes a
 * re-POST of the same conflicting envelope replay the raise and return the ORIGINAL conflict_id,
 * and uq_maintenance_sync_conflict_event is the race backstop.
 *
 * The supervisor notification is the AD-17 default: a decoupled emitNotification after the raise
 * commits, deduplicated by object_id through the existing notification.created query shape. The
 * crash window between the raise commit and the notification is the documented AD-17 tradeoff;
 * the queue row (the durable record) survives it, and GET /api/v1/maintenance/sync-conflicts is
 * the read surface that does not depend on the notification.
 */
export type SyncConflictCause =
  | { reason: 'version_conflict'; expected_version: number; head_version: number }
  | { reason: 'safety_fault_rejected'; rejection_code: string };

export interface RaiseSyncConflictContext {
  trace_id: string;
  endpoint: string;
  method: string;
}

const CONFLICT_NEXT_STEP = 'Review the conflicting capture and record a resolution';
const SAFETY_NEXT_STEP =
  'Safety fault could not be filed from the device: verify the asset and re-file centrally';

async function describeStream(envelope: EventEnvelope): Promise<string> {
  const p = envelope.payload as Record<string, unknown>;
  if (typeof p['asset_tag'] === 'string' && p['asset_tag'].trim() !== '')
    return p['asset_tag'].trim();
  try {
    if (typeof p['work_order_id'] === 'string') {
      const workOrder = await getWorkOrderById(p['work_order_id']);
      if (workOrder) {
        const asset = await getAssetById(workOrder.asset_id);
        if (asset) return asset.asset_tag;
      }
    } else if (typeof p['reservation_id'] === 'string') {
      const reservation = await getSpareReservationById(p['reservation_id']);
      if (reservation) {
        const asset = await getAssetById(reservation.asset_id);
        if (asset) return asset.asset_tag;
      }
    } else if (typeof p['asset_id'] === 'string') {
      const asset = await getAssetById(p['asset_id']);
      if (asset) return asset.asset_tag;
    }
  } catch {
    // A label lookup failure must never mask the raise; fall back to the stream id.
  }
  return envelope.stream_id;
}

export async function raiseMaintenanceSyncConflict(
  conflicting: EventEnvelope,
  cause: SyncConflictCause,
  ctx: RaiseSyncConflictContext,
): Promise<{ conflict_id: string }> {
  const conflictId = randomUUID();
  const raisedAt = new Date().toISOString();
  const actor = conflicting.metadata.actor;
  const conflictingEventId = conflicting.event_id as string;
  const deviceId = conflicting.metadata.device_id ?? 'unknown-device';

  const persisted = await persistEvent(
    {
      stream_type: 'maintenance',
      stream_id: conflictId,
      event_type: 'maintenance.sync_conflict_raised',
      payload: {
        conflict_id: conflictId,
        stream_id: conflicting.stream_id,
        stream_type: 'maintenance',
        conflicting_event_id: conflictingEventId,
        conflicting_event_type: conflicting.event_type,
        idempotency_key: conflicting.idempotency_key ?? `event-${conflictingEventId}`,
        device_id: deviceId,
        captured_by: actor.user_id,
        location_id: actor.location_id ?? null,
        reason: cause.reason,
        expected_version: cause.reason === 'version_conflict' ? cause.expected_version : null,
        head_version: cause.reason === 'version_conflict' ? cause.head_version : null,
        rejection_code: cause.reason === 'safety_fault_rejected' ? cause.rejection_code : null,
        conflicting_payload: conflicting.payload,
        occurred_at: conflicting.metadata.occurred_at ?? raisedAt,
        raised_at: raisedAt,
      },
      metadata: {
        correlation_id: conflicting.metadata.correlation_id ?? randomUUID(),
        actor: { user_id: actor.user_id, role: actor.role, location_id: actor.location_id },
        device_id: deviceId,
        capture_method: 'AUTO',
        occurred_at: raisedAt,
      },
      idempotency_key: `sync-conflict-${conflictingEventId}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      trace_id: ctx.trace_id,
      user_id: actor.user_id,
      role: actor.role,
      location_id: actor.location_id,
      endpoint: ctx.endpoint,
      method: ctx.method,
      http_status: 409,
    },
  );

  // replayIdOrReject-style resolution: on a replay the persisted payload carries the ORIGINAL
  // conflict_id, which is the one the device and the supervisor must see again.
  const persistedPayload = persisted.payload as Record<string, unknown>;
  const resolvedConflictId =
    persisted.event_type === 'maintenance.sync_conflict_raised' &&
    typeof persistedPayload['conflict_id'] === 'string'
      ? persistedPayload['conflict_id']
      : conflictId;

  const existingNotification = await getPool().query(
    `SELECT 1 FROM domain_events
      WHERE event_type = 'notification.created'
        AND payload->>'object_id' = $1
        AND payload->>'event_type' = 'sync_conflict_raised'
      LIMIT 1`,
    [resolvedConflictId],
  );
  if (existingNotification.rows.length === 0) {
    const label = await describeStream(conflicting);
    await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: actor.location_id },
      event_type: 'sync_conflict_raised',
      status_verb: 'Flagged',
      object_type: 'maintenance_sync_conflict',
      object_id: resolvedConflictId,
      actor_label: `${label}, ${conflicting.event_type}, ${cause.reason}, device ${deviceId}`,
      next_step: cause.reason === 'safety_fault_rejected' ? SAFETY_NEXT_STEP : CONFLICT_NEXT_STEP,
      escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 86400 },
      actor: { user_id: actor.user_id, role: actor.role, location_id: actor.location_id },
      correlation_id: randomUUID(),
      occurred_at: raisedAt,
    });
  }

  return { conflict_id: resolvedConflictId };
}
