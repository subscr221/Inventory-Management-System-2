import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import {
  getSyncConflictByEventId,
  getSyncConflictById,
  insertSyncConflict,
  setSyncConflictResolved,
} from '../read/projections/maintenance_sync_conflict.js';

/**
 * Story 7.8 compliance seam for the maintenance sync-conflict queue (FR-M-17, AC 2). Structurally
 * mirrors src/compliance/maintenance-coverage.ts: a stream gate, a PURE pre-transaction shape
 * assert, an in-transaction projection switch, an alreadyPersisted guard and the same reject()
 * AppError helper, copied verbatim rather than re-derived.
 *
 * Two appliers:
 * - sync_conflict_raised inserts one queue row per conflicting edge event (Binding Decision 4). The
 *   raiser is the SERVER acting for the device actor, so captured_by is checked against the raise
 *   envelope's metadata.actor.user_id (which the edge handler sets to the technician), never
 *   re-derived from some other identity.
 * - sync_conflict_resolved records the supervisor's decision (Binding Decision 6): a decision record
 *   only, DOA-gated through maintenance.sync_conflict_resolution at value 0 and re-derived under
 *   the conflict row's lock. The platform never re-applies the conflicting payload.
 *
 * LOCKING CONTRACT (verified against every sibling seam):
 * - applySyncConflictRaised locks NOTHING. It reads the (conflicting_event_id) grain and inserts;
 *   uq_maintenance_sync_conflict_event is the race backstop (23505 -> DUPLICATE_SYNC_CONFLICT with
 *   the same existing_conflict_id the pre-check returns).
 * - applySyncConflictResolved locks the conflict row FOR UPDATE only. It touches no asset, work
 *   order or reservation row, so it introduces no ordering relationship with any other applier.
 * - The DOA registry read (resolveApprover) is a plain SELECT on append-only configuration and
 *   carries no lock-order dependency (the Story 7.6 / 7.7 precedent).
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const SYNC_CONFLICT_RAISED = 'maintenance.sync_conflict_raised';
const SYNC_CONFLICT_RESOLVED = 'maintenance.sync_conflict_resolved';
const SYNC_CONFLICT_EVENT_TYPES = new Set([SYNC_CONFLICT_RAISED, SYNC_CONFLICT_RESOLVED]);

export const SYNC_CONFLICT_RESOLUTION_DOA_TYPE = 'maintenance.sync_conflict_resolution';
export const SYNC_CONFLICT_RESOLUTION_CODES: ReadonlySet<string> = new Set([
  'discarded',
  'reapplied_centrally',
]);
export const SYNC_CONFLICT_REASONS: ReadonlySet<string> = new Set([
  'version_conflict',
  'safety_fault_rejected',
]);
export const MAX_RESOLUTION_NOTE_LENGTH = 1000;
// The conflicting payload is stored verbatim for supervisor review; bound its serialized size so a
// hostile or runaway device (the fault report `description` is otherwise unbounded) cannot park a
// multi-megabyte blob in the queue.
const MAX_CONFLICTING_PAYLOAD_BYTES = 64 * 1024;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_TIMESTAMP_REGEX.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function maintenanceSyncConflictEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!SYNC_CONFLICT_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function assertSyncConflictRaisedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['conflict_id'])) reject('INVALID_PAYLOAD', 'conflict_id must be a UUID');
  if (envelope.stream_id !== p['conflict_id']) {
    reject(
      'INVALID_PAYLOAD',
      'stream_id must be the conflict_id for maintenance.sync_conflict_raised',
      {
        stream_id: envelope.stream_id,
        payload_conflict_id: p['conflict_id'],
      },
    );
  }
  // The payload's stream_id is the CONFLICTING stream (the work order, reservation or fault
  // report), distinct from the envelope's stream_id (the conflict's own fresh stream).
  if (!isUuid(p['stream_id'])) reject('INVALID_PAYLOAD', 'stream_id must be a UUID');
  if (p['stream_type'] !== 'maintenance') {
    reject('INVALID_PAYLOAD', 'stream_type must be maintenance', { stream_type: p['stream_type'] });
  }
  if (!isUuid(p['conflicting_event_id'])) {
    reject('INVALID_PAYLOAD', 'conflicting_event_id must be a UUID');
  }
  if (
    typeof p['conflicting_event_type'] !== 'string' ||
    p['conflicting_event_type'].trim() === ''
  ) {
    reject('INVALID_PAYLOAD', 'conflicting_event_type must be a non-empty string');
  }
  if (typeof p['idempotency_key'] !== 'string' || p['idempotency_key'].trim() === '') {
    reject('INVALID_PAYLOAD', 'idempotency_key must be a non-empty string');
  }
  if (typeof p['device_id'] !== 'string' || p['device_id'].trim() === '') {
    reject('INVALID_PAYLOAD', 'device_id must be a non-empty string');
  }
  if (!isUuid(p['captured_by'])) reject('INVALID_PAYLOAD', 'captured_by must be a UUID');
  if (p['location_id'] !== null && !isUuid(p['location_id'])) {
    reject('INVALID_PAYLOAD', 'location_id must be null or a UUID');
  }
  const reason = p['reason'];
  if (typeof reason !== 'string' || !SYNC_CONFLICT_REASONS.has(reason)) {
    reject('INVALID_PAYLOAD', 'reason must be one of: version_conflict, safety_fault_rejected');
  }
  if (reason === 'version_conflict') {
    if (!isNonNegativeInteger(p['expected_version'])) {
      reject('INVALID_PAYLOAD', 'expected_version must be a non-negative integer');
    }
    if (!isNonNegativeInteger(p['head_version'])) {
      reject('INVALID_PAYLOAD', 'head_version must be a non-negative integer');
    }
    if (p['rejection_code'] !== null && p['rejection_code'] !== undefined) {
      reject('INVALID_PAYLOAD', 'rejection_code must be null for a version_conflict');
    }
  } else {
    if (typeof p['rejection_code'] !== 'string' || p['rejection_code'].trim() === '') {
      reject(
        'INVALID_PAYLOAD',
        'rejection_code must be a non-empty string for a safety_fault_rejected',
      );
    }
    if (p['expected_version'] !== null && p['expected_version'] !== undefined) {
      reject('INVALID_PAYLOAD', 'expected_version must be null for a safety_fault_rejected');
    }
    if (p['head_version'] !== null && p['head_version'] !== undefined) {
      reject('INVALID_PAYLOAD', 'head_version must be null for a safety_fault_rejected');
    }
  }
  if (!isPlainObject(p['conflicting_payload'])) {
    reject('INVALID_PAYLOAD', 'conflicting_payload must be a plain object');
  }
  const conflictingPayloadJson = JSON.stringify(p['conflicting_payload']);
  if (conflictingPayloadJson.length > MAX_CONFLICTING_PAYLOAD_BYTES) {
    reject(
      'INVALID_PAYLOAD',
      `conflicting_payload must be at most ${MAX_CONFLICTING_PAYLOAD_BYTES} bytes when serialized`,
    );
  }
  if (!isIsoTimestamp(p['occurred_at'])) {
    reject('INVALID_PAYLOAD', 'occurred_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (!isIsoTimestamp(p['raised_at'])) {
    reject('INVALID_PAYLOAD', 'raised_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertSyncConflictResolvedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['conflict_id'])) reject('INVALID_PAYLOAD', 'conflict_id must be a UUID');
  if (envelope.stream_id !== p['conflict_id']) {
    reject(
      'INVALID_PAYLOAD',
      'stream_id must be the conflict_id for maintenance.sync_conflict_resolved',
      { stream_id: envelope.stream_id, payload_conflict_id: p['conflict_id'] },
    );
  }
  const code = p['resolution_code'];
  if (typeof code !== 'string' || !SYNC_CONFLICT_RESOLUTION_CODES.has(code)) {
    reject('INVALID_PAYLOAD', 'resolution_code must be one of: discarded, reapplied_centrally');
  }
  const note = p['resolution_note'];
  if (note !== null && (typeof note !== 'string' || note.length > MAX_RESOLUTION_NOTE_LENGTH)) {
    reject(
      'INVALID_PAYLOAD',
      `resolution_note must be null or a string of at most ${MAX_RESOLUTION_NOTE_LENGTH} characters`,
    );
  }
  if (!isUuid(p['resolved_by'])) reject('INVALID_PAYLOAD', 'resolved_by must be a UUID');
  if (!isIsoTimestamp(p['resolved_at'])) {
    reject('INVALID_PAYLOAD', 'resolved_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

export function assertMaintenanceSyncConflictShape(envelope: EventEnvelope): void {
  switch (maintenanceSyncConflictEventType(envelope)) {
    case SYNC_CONFLICT_RAISED:
      assertSyncConflictRaisedShape(envelope);
      return;
    case SYNC_CONFLICT_RESOLVED:
      assertSyncConflictResolvedShape(envelope);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function applySyncConflictRaised(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const conflictingEventId = p['conflicting_event_id'] as string;
  const declaredCapturedBy = p['captured_by'] as string;

  // Grain pre-check on (conflicting_event_id). The 23505 resolver on
  // uq_maintenance_sync_conflict_event returns the SAME code and existing_conflict_id when a
  // concurrent raise wins the race, so both paths are indistinguishable to the caller.
  const existing = await getSyncConflictByEventId(conflictingEventId, client);
  if (existing) {
    reject(
      'DUPLICATE_SYNC_CONFLICT',
      'A sync conflict has already been raised for this event',
      { conflicting_event_id: conflictingEventId, existing_conflict_id: existing.conflict_id },
      409,
    );
  }

  // captured_by is NOT re-derived from some other identity: the raiser is the server acting for
  // the device actor, and the edge handler sets the raise envelope's actor to the technician. A
  // declared captured_by that differs from that actor is a forgery.
  if (declaredCapturedBy !== envelope.metadata.actor.user_id) {
    reject(
      'SYNC_CONFLICT_DERIVATION_MISMATCH',
      'Declared captured_by does not match the acting user',
      {
        conflict_id: p['conflict_id'],
        declared_captured_by: declaredCapturedBy,
        derived_captured_by: envelope.metadata.actor.user_id,
      },
      409,
    );
  }

  await insertSyncConflict(
    {
      conflict_id: p['conflict_id'] as string,
      stream_id: p['stream_id'] as string,
      conflicting_event_id: conflictingEventId,
      conflicting_event_type: p['conflicting_event_type'] as string,
      idempotency_key: p['idempotency_key'] as string,
      device_id: p['device_id'] as string,
      captured_by: envelope.metadata.actor.user_id,
      location_id: (p['location_id'] as string | null) ?? null,
      reason: p['reason'] as 'version_conflict' | 'safety_fault_rejected',
      expected_version: (p['expected_version'] as number | null | undefined) ?? null,
      head_version: (p['head_version'] as number | null | undefined) ?? null,
      rejection_code: (p['rejection_code'] as string | null | undefined) ?? null,
      conflicting_payload: p['conflicting_payload'] as Record<string, unknown>,
      occurred_at: p['occurred_at'] as string,
      raised_at: p['raised_at'] as string,
    },
    client,
  );
}

async function applySyncConflictResolved(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const conflictId = p['conflict_id'] as string;
  const resolutionCode = p['resolution_code'] as 'discarded' | 'reapplied_centrally';
  const resolutionNote = (p['resolution_note'] as string | null) ?? null;
  const declaredResolvedBy = p['resolved_by'] as string;
  const resolvedAt = p['resolved_at'] as string;

  // Locking contract: the conflict row FOR UPDATE, and nothing else.
  const conflict = await getSyncConflictById(conflictId, client, true);
  if (!conflict) {
    reject('SYNC_CONFLICT_NOT_FOUND', 'Sync conflict not found', { conflict_id: conflictId }, 404);
  }
  if (conflict.status === 'resolved') {
    reject(
      'SYNC_CONFLICT_ALREADY_RESOLVED',
      'This sync conflict is already resolved',
      { conflict_id: conflictId, resolved_at: conflict.resolved_at },
      409,
    );
  }

  if (declaredResolvedBy !== envelope.metadata.actor.user_id) {
    reject(
      'SYNC_CONFLICT_DERIVATION_MISMATCH',
      'Declared resolved_by does not match the acting user',
      {
        conflict_id: conflictId,
        declared_resolved_by: declaredResolvedBy,
        derived_resolved_by: envelope.metadata.actor.user_id,
      },
      409,
    );
  }

  // AD-3: resolution authority resolves through the DOA registry under the conflict row's lock,
  // so a direct event cannot hand the decision to someone the registry never authorized. The
  // handler carries NO pre-check on this (Binding Decision 6): a delegation rotating between a
  // write and its same-key replay must not turn the replay into a 403.
  const approval = await resolveApprover(SYNC_CONFLICT_RESOLUTION_DOA_TYPE, 0);
  if (!approval.requiresApproval || approval.approverActorId === null) {
    reject(
      'APPROVAL_UNRESOLVED',
      'No DOA entry governs maintenance.sync_conflict_resolution',
      { transaction_type: SYNC_CONFLICT_RESOLUTION_DOA_TYPE },
      404,
    );
  }
  if (declaredResolvedBy !== approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'Resolving a sync conflict requires the resolved DOA approver',
      { conflict_id: conflictId, resolved_approver_user_id: approval.approverActorId },
      403,
    );
  }

  p['resolved_by'] = envelope.metadata.actor.user_id;
  p['resolution_note'] = resolutionNote;

  const updated = await setSyncConflictResolved(
    conflictId,
    resolutionCode,
    resolutionNote,
    envelope.metadata.actor.user_id,
    resolvedAt,
    client,
  );
  if (updated !== 1) {
    // Never silently no-op on a state the applier should reject (the 7.2 Group 2 decision).
    reject(
      'SYNC_CONFLICT_ALREADY_RESOLVED',
      'The sync conflict left the open state before the resolution could be applied',
      { conflict_id: conflictId, resolved_at: conflict.resolved_at },
      409,
    );
  }
}

export async function applyMaintenanceSyncConflictProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const eventType = maintenanceSyncConflictEventType(envelope);
  if (eventType === null) return;
  if (await alreadyPersisted(envelope, client)) return;

  switch (eventType) {
    case SYNC_CONFLICT_RAISED:
      await applySyncConflictRaised(envelope, client);
      return;
    case SYNC_CONFLICT_RESOLVED:
      await applySyncConflictResolved(envelope, client);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path must return the SAME error code with the SAME existing_*
 * detail (the Story 7.2 lesson): re-reads the winning row for uq_maintenance_sync_conflict_event.
 */
export async function resolveSyncConflictDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const conflictingEventId = isUuid(payload['conflicting_event_id'])
    ? (payload['conflicting_event_id'] as string)
    : null;
  const attempted: Record<string, unknown> = { conflicting_event_id: conflictingEventId };
  if (conflictingEventId !== null) {
    const existing = await getSyncConflictByEventId(conflictingEventId);
    if (existing) {
      return { ...attempted, existing_conflict_id: existing.conflict_id };
    }
  }
  return attempted;
}
