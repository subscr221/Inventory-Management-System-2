import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { resolveApprover } from '../api/v1/indents.js';
import {
  getRefusedCaptureByEventId,
  getRefusedCaptureById,
  insertRefusedCapture,
  setRefusedCaptureResolved,
  type LocationSource,
} from '../read/projections/edge_refused_capture.js';

/**
 * Story 1.13 compliance seam for the edge refused-captures queue (AD-18, AC 2 and 4), modelled on
 * src/compliance/maintenance-sync-conflict.ts: a pure pre-transaction shape assert, an
 * in-transaction projection switch with an alreadyPersisted guard, and a 23505 resolver.
 *
 * LOCKING CONTRACT: the record applier locks nothing (uq_edge_refused_capture_event is the race
 * backstop); the resolve applier locks the refusal row FOR UPDATE only. resolveApprover is a plain
 * SELECT on append-only configuration.
 */

export const REFUSED_CAPTURE_STREAM_TYPE = 'sync';
const RECORDED = 'sync.refused_capture_recorded';
const RESOLVED = 'sync.refused_capture_resolved';
export const REFUSED_CAPTURE_RESOLUTION_DOA_TYPE = 'edge.refused_capture_resolution';
export const MAX_REFUSED_CAPTURE_NOTE_LENGTH = 1000;
export const MAX_REFUSED_ENVELOPE_BYTES = 64 * 1024;

const LOCATION_SOURCES: ReadonlySet<string> = new Set(['authorized', 'declared', 'none']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_TIMESTAMP_REGEX.test(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function reject(code: string, message: string, details?: Record<string, unknown>, status = 400): never {
  throw new AppError(status, code, message, details);
}

function refusedCaptureEventType(envelope: EventEnvelope): string | null {
  if (envelope.event_type !== RECORDED && envelope.event_type !== RESOLVED) return null;
  return envelope.event_type;
}

function assertActorDerivation(field: string, declared: unknown, envelope: EventEnvelope): void {
  if (declared !== envelope.metadata.actor.user_id) {
    reject(
      'REFUSED_CAPTURE_DERIVATION_MISMATCH',
      `Declared ${field} does not match the acting user`,
      { field, expected: envelope.metadata.actor.user_id, actual: declared },
      409,
    );
  }
}

function assertRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['refusal_id'])) reject('INVALID_PAYLOAD', 'refusal_id must be a UUID');
  if (envelope.stream_id !== p['refusal_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the refusal_id', {
      stream_id: envelope.stream_id,
      payload_refusal_id: p['refusal_id'],
    });
  }
  if (!isUuid(p['event_id'])) reject('INVALID_PAYLOAD', 'event_id must be a UUID');
  if (typeof p['stream_type'] !== 'string' || p['stream_type'].trim() === '') {
    reject('INVALID_PAYLOAD', 'stream_type must be a non-empty string');
  }
  for (const field of ['stream_id', 'event_type', 'idempotency_key', 'device_id', 'captured_role']) {
    if (!isNullableString(p[field])) reject('INVALID_PAYLOAD', `${field} must be null or a string`);
  }
  if (!isUuid(p['captured_by'])) reject('INVALID_PAYLOAD', 'captured_by must be a UUID');
  if (p['location_id'] !== null && !isUuid(p['location_id'])) {
    reject('INVALID_PAYLOAD', 'location_id must be null or a UUID');
  }
  if (typeof p['location_source'] !== 'string' || !LOCATION_SOURCES.has(p['location_source'])) {
    reject('INVALID_PAYLOAD', 'location_source must be one of: authorized, declared, none');
  }
  const status = p['http_status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
    reject('INVALID_PAYLOAD', 'http_status must be a 4xx integer');
  }
  if (typeof p['error_code'] !== 'string' || p['error_code'].trim() === '') {
    reject('INVALID_PAYLOAD', 'error_code must be a non-empty string');
  }
  if (typeof p['envelope_truncated'] !== 'boolean') {
    reject('INVALID_PAYLOAD', 'envelope_truncated must be a boolean');
  }
  // Bytes, not UTF-16 code units: a non-ASCII envelope is up to 3x larger than its .length.
  if (p['envelope'] != null && Buffer.byteLength(JSON.stringify(p['envelope'])) > MAX_REFUSED_ENVELOPE_BYTES) {
    reject(
      'INVALID_PAYLOAD',
      `envelope must be at most ${MAX_REFUSED_ENVELOPE_BYTES} bytes when serialized`,
    );
  }
  if (typeof p['trace_id'] !== 'string') reject('INVALID_PAYLOAD', 'trace_id must be a string');
  if (p['occurred_at'] !== null && !isIsoTimestamp(p['occurred_at'])) {
    reject('INVALID_PAYLOAD', 'occurred_at must be null or an ISO 8601 timestamp with an offset');
  }
  if (!isIsoTimestamp(p['refused_at'])) {
    reject('INVALID_PAYLOAD', 'refused_at must be an ISO 8601 timestamp with an offset');
  }
  assertActorDerivation('captured_by', p['captured_by'], envelope);
}

function assertResolvedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['refusal_id'])) reject('INVALID_PAYLOAD', 'refusal_id must be a UUID');
  if (envelope.stream_id !== p['refusal_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the refusal_id', {
      stream_id: envelope.stream_id,
      payload_refusal_id: p['refusal_id'],
    });
  }
  const note = p['note'];
  if (typeof note !== 'string' || note.trim() === '' || note.length > MAX_REFUSED_CAPTURE_NOTE_LENGTH) {
    reject('INVALID_PAYLOAD', `note must be 1 to ${MAX_REFUSED_CAPTURE_NOTE_LENGTH} characters`);
  }
  if (!isUuid(p['resolved_by'])) reject('INVALID_PAYLOAD', 'resolved_by must be a UUID');
  if (!isIsoTimestamp(p['resolved_at'])) {
    reject('INVALID_PAYLOAD', 'resolved_at must be an ISO 8601 timestamp with an offset');
  }
  assertActorDerivation('resolved_by', p['resolved_by'], envelope);
}

export function assertRefusedCaptureShape(envelope: EventEnvelope): void {
  const type = refusedCaptureEventType(envelope);
  if (type === null) return;
  if (envelope.stream_type !== REFUSED_CAPTURE_STREAM_TYPE) return; // assertRegisteredStream refuses it
  if (type === RECORDED) assertRecordedShape(envelope);
  else assertResolvedShape(envelope);
}

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function applyRecorded(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const eventId = p['event_id'] as string;
  const existing = await getRefusedCaptureByEventId(eventId, client);
  if (existing) {
    reject(
      'DUPLICATE_REFUSED_CAPTURE',
      'A refusal has already been recorded for this capture',
      { event_id: eventId, existing_refusal_id: existing.refusal_id },
      409,
    );
  }
  await insertRefusedCapture(
    {
      refusal_id: p['refusal_id'] as string,
      event_id: eventId,
      stream_type: p['stream_type'] as string,
      stream_id: (p['stream_id'] as string | null) ?? null,
      event_type: (p['event_type'] as string | null) ?? null,
      idempotency_key: (p['idempotency_key'] as string | null) ?? null,
      device_id: (p['device_id'] as string | null) ?? null,
      captured_by: envelope.metadata.actor.user_id,
      captured_role: (p['captured_role'] as string | null) ?? null,
      location_id: (p['location_id'] as string | null) ?? null,
      location_source: p['location_source'] as LocationSource,
      http_status: p['http_status'] as number,
      error_code: p['error_code'] as string,
      error_details: (p['error_details'] as Record<string, unknown> | null) ?? null,
      envelope: (p['envelope'] as Record<string, unknown> | null) ?? null,
      envelope_truncated: p['envelope_truncated'] as boolean,
      trace_id: p['trace_id'] as string,
      occurred_at: (p['occurred_at'] as string | null) ?? null,
      refused_at: p['refused_at'] as string,
    },
    client,
  );
}

async function applyResolved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const refusalId = p['refusal_id'] as string;
  const resolvedBy = envelope.metadata.actor.user_id;

  const row = await getRefusedCaptureById(refusalId, client, true);
  if (!row) {
    reject('REFUSED_CAPTURE_NOT_FOUND', 'Refused capture not found', { refusal_id: refusalId }, 404);
  }
  const alreadyResolved = (resolved: { resolved_by: string | null; resolved_at: string | null }): never =>
    reject(
      'REFUSED_CAPTURE_ALREADY_RESOLVED',
      'This refused capture is already resolved',
      { refusal_id: refusalId, resolved_by: resolved.resolved_by, resolved_at: resolved.resolved_at },
      409,
    );
  if (row.status === 'resolved') alreadyResolved(row);

  // AD-3 / AD-12: resolution authority is re-derived under the row lock, never only in the handler.
  const approval = await resolveApprover(REFUSED_CAPTURE_RESOLUTION_DOA_TYPE, 0);
  if (!approval.requiresApproval || approval.approverActorId === null) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No DOA entry governs ${REFUSED_CAPTURE_RESOLUTION_DOA_TYPE}`,
      { transaction_type: REFUSED_CAPTURE_RESOLUTION_DOA_TYPE },
      409,
    );
  }
  if (resolvedBy !== approval.approverActorId) {
    reject(
      'APPROVAL_REQUIRED',
      'Resolving a refused capture requires the resolved DOA approver',
      { refusal_id: refusalId, resolved_approver_user_id: approval.approverActorId },
      403,
    );
  }

  const updated = await setRefusedCaptureResolved(
    refusalId,
    p['note'] as string,
    resolvedBy,
    p['resolved_at'] as string,
    client,
  );
  if (updated !== 1) {
    // The row left 'open' under the lock: report the winner's identity, never Table 3's fields as null.
    alreadyResolved((await getRefusedCaptureById(refusalId, client)) ?? row);
  }
}

export async function applyRefusedCaptureProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = refusedCaptureEventType(envelope);
  if (type === null || envelope.stream_type !== REFUSED_CAPTURE_STREAM_TYPE) return;
  if (await alreadyPersisted(envelope, client)) return;
  if (type === RECORDED) await applyRecorded(envelope, client);
  else await applyResolved(envelope, client);
}

/** The race path returns the same code and existing_refusal_id as the sequential pre-check. */
export async function resolveRefusedCaptureDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const eventId = isUuid(payload['event_id']) ? payload['event_id'] : null;
  const existing = eventId === null ? null : await getRefusedCaptureByEventId(eventId);
  return existing
    ? { event_id: eventId, existing_refusal_id: existing.refusal_id }
    : { event_id: eventId };
}
