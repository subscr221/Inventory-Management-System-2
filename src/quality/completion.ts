import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { persistEvent } from '../events/store.js';
import type { PersistedEvent } from '../events/store.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { AppError } from '../middleware/error.js';
import { QC_COMPLETION_RECEIVED } from '../compliance/quality.js';
import { getQcInspectionTaskById } from '../read/projections/qc_inspection_task.js';
import type { QcInspectionTaskRow } from '../read/projections/qc_inspection_task.js';

/**
 * Story 8.1 producer-neutral completion-to-QC-gate contract (FR-Q-02, AC 3, Task 5, Binding Scope
 * Decision 7). A producer-owned completion transaction (Story 6.3 production completion, Story 9.4
 * job-work completion, or the Story 8.1 synthetic completion route) that has ALREADY created the
 * finished-goods lot and posted its finished stock effect on `client` invokes this with that same
 * transaction client. Story 8.1 then resolves and freezes the approved plan version, creates the
 * durable inspection task, records the QC gate as qc_hold, and writes the event, the audit entry
 * and the transactional inspection notification - all on the producer's transaction, so a failure
 * in any QC-gate write rolls the producer's own lot and stock writes back with it.
 *
 * Story 8.1 never creates lots, relieves WIP, values output or posts finished-goods stock here.
 * The hand-off is an ordinary qc.completion_received event through persistEvent, so every seam
 * guard (shape, replay, stream gate, applier, constraint mapping) applies exactly as for a direct
 * event; this module only builds the envelope and returns the task the applier created.
 */
export interface QcCompletionHandoff {
  source_completion_type: 'synthetic_completion' | 'production_order' | 'job_work_order';
  source_completion_id: string;
  lot_id: string;
  lot_number: string;
  item_id: string;
  quantity: string;
  uom: string;
  site_id: string;
  bom_revision_id: string;
  completed_at: string;
  business_stream: string;
  source_order_type?: 'job_work_order' | null;
  source_order_ref?: string | null;
  actor: { user_id: string; role: string; location_id: string };
  correlation_id?: string;
  causation_id?: string | null;
  /** Minted by the producer so a replay of its transaction re-uses the same task identity. */
  task_id?: string;
  event_id?: string;
  idempotency_key?: string | null;
}

export interface QcCompletionResult {
  event: PersistedEvent;
  task: QcInspectionTaskRow;
  /** True when the hand-off replayed an already-persisted completion (same key or event id). */
  replayed: boolean;
}

const ACTOR_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function receiveQcCompletion(
  handoff: QcCompletionHandoff,
  client: PoolClient,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<QcCompletionResult> {
  if (
    !handoff.actor ||
    typeof handoff.actor.user_id !== 'string' ||
    !ACTOR_UUID_REGEX.test(handoff.actor.user_id) ||
    typeof handoff.actor.role !== 'string' ||
    handoff.actor.role.trim().length === 0 ||
    typeof handoff.actor.location_id !== 'string' ||
    handoff.actor.location_id.trim().length === 0
  ) {
    throw new AppError(
      400,
      'INVALID_PAYLOAD',
      'The producer hand-off must carry a complete actor identity (user_id, role, location_id)',
      {},
    );
  }
  const taskId = handoff.task_id ?? randomUUID();
  const envelope = {
    ...(handoff.event_id ? { event_id: handoff.event_id } : {}),
    stream_type: 'qc',
    stream_id: taskId,
    event_type: QC_COMPLETION_RECEIVED,
    payload: {
      task_id: taskId,
      source_completion_type: handoff.source_completion_type,
      source_completion_id: handoff.source_completion_id,
      lot_id: handoff.lot_id,
      lot_number: handoff.lot_number,
      item_id: handoff.item_id,
      quantity: handoff.quantity,
      uom: handoff.uom,
      site_id: handoff.site_id,
      bom_revision_id: handoff.bom_revision_id,
      source_order_type: handoff.source_order_type ?? null,
      source_order_ref: handoff.source_order_ref ?? null,
      completed_at: handoff.completed_at,
      business_stream: handoff.business_stream,
    },
    metadata: {
      correlation_id: handoff.correlation_id ?? randomUUID(),
      causation_id: handoff.causation_id ?? null,
      actor: handoff.actor,
      occurred_at: handoff.completed_at,
    },
    idempotency_key: handoff.idempotency_key ?? null,
  };
  // Replay detection BEFORE the write: the global idempotency short-circuit in persistEvent returns
  // the existing row for a same-key or same-id replay, and the caller needs to know the task was
  // not created by this call (no second notification, no second audit row).
  let replayed = false;
  if (handoff.idempotency_key || handoff.event_id) {
    const existing = await client.query(
      `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
      [handoff.idempotency_key ?? null, handoff.event_id ?? null],
    );
    replayed = existing.rows.length > 0;
  }
  const event = await persistEvent(envelope, auditCtx, client);
  const persistedTaskId =
    typeof event.payload['task_id'] === 'string' ? (event.payload['task_id'] as string) : taskId;
  if (event.event_type !== QC_COMPLETION_RECEIVED) {
    throw new AppError(
      409,
      'DUPLICATE_EVENT',
      'The completion idempotency key was already used by a different event',
      { existing_event_id: event.event_id, existing_event_type: event.event_type },
    );
  }
  const task = await getQcInspectionTaskById(persistedTaskId, client);
  if (!task) {
    throw new AppError(500, 'QC_TASK_MISSING', 'The QC inspection task was not created', {
      task_id: persistedTaskId,
    });
  }
  return { event, task, replayed };
}
