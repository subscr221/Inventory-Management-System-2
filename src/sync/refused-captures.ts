import { randomUUID } from 'node:crypto';
import { persistEvent } from '../events/store.js';
import type { AppError } from '../middleware/error.js';
import { MAX_REFUSED_ENVELOPE_BYTES } from '../compliance/edge-refused-capture.js';

/**
 * Story 1.13 (AD-18, AC 2, Binding Decisions 3 to 5): record a permanently refused edge upload in
 * the central refused-captures queue. Runs AFTER the refused upload's transaction has rolled back,
 * as a fresh event on its own 'sync' stream (stream_id = refusal_id). Idempotent on the capture
 * event_id: a replayed upload returns the ORIGINAL refusal_id. Never throws - a failure is logged
 * and the device still receives its original response.
 */
export interface RefusedCaptureContext {
  trace_id: string;
  endpoint: string;
  method: string;
  user_id: string;
  /** The assignment requireRole authorized, when it got that far. */
  assignment: { role: string; locationId: string } | undefined;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

function field(record: unknown, key: string): unknown {
  return typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[key] : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function recordRefusedCapture(
  snapshot: Record<string, unknown>,
  error: AppError,
  ctx: RefusedCaptureContext,
): Promise<{ refusal_id: string } | null> {
  try {
    const eventId = (snapshot['event_id'] as string).toLowerCase();
    const refusalId = randomUUID();
    const refusedAt = new Date().toISOString();
    const metadata = snapshot['metadata'];
    const declaredLocation = field(field(metadata, 'actor'), 'location_id');
    const authorizedLocation = ctx.assignment?.locationId;
    const [locationId, locationSource] =
      typeof authorizedLocation === 'string' && UUID_REGEX.test(authorizedLocation)
        ? [authorizedLocation.toLowerCase(), 'authorized' as const]
        : typeof declaredLocation === 'string' && UUID_REGEX.test(declaredLocation)
          ? [declaredLocation.toLowerCase(), 'declared' as const]
          : [null, 'none' as const];
    const capturedRole = ctx.assignment?.role ?? null;
    // Bytes, not UTF-16 code units (a Devanagari or CJK envelope is up to 3x its .length).
    const truncated = Buffer.byteLength(JSON.stringify(snapshot)) > MAX_REFUSED_ENVELOPE_BYTES;
    const occurredAt = field(metadata, 'occurred_at');
    const deviceId = stringOrNull(field(metadata, 'device_id'));
    const actor = {
      user_id: ctx.user_id,
      role: capturedRole ?? 'unassigned',
      location_id: locationId ?? NO_LOCATION_UUID,
    };

    const persisted = await persistEvent(
      {
        stream_type: 'sync',
        stream_id: refusalId,
        event_type: 'sync.refused_capture_recorded',
        payload: {
          refusal_id: refusalId,
          event_id: eventId,
          stream_type: typeof snapshot['stream_type'] === 'string' ? snapshot['stream_type'] : 'unknown',
          stream_id: stringOrNull(snapshot['stream_id']),
          event_type: stringOrNull(snapshot['event_type']),
          idempotency_key: stringOrNull(snapshot['idempotency_key']),
          device_id: deviceId,
          captured_by: ctx.user_id,
          captured_role: capturedRole,
          location_id: locationId,
          location_source: locationSource,
          http_status: error.statusCode,
          error_code: error.errorCode,
          error_details: error.details ?? null,
          envelope: truncated ? null : snapshot,
          envelope_truncated: truncated,
          trace_id: ctx.trace_id,
          occurred_at:
            typeof occurredAt === 'string' && ISO8601_TIMESTAMP_REGEX.test(occurredAt) ? occurredAt : null,
          refused_at: refusedAt,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor,
          ...(deviceId === null ? {} : { device_id: deviceId }),
          capture_method: 'AUTO',
          occurred_at: refusedAt,
        },
        idempotency_key: `refused-capture-${eventId}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        trace_id: ctx.trace_id,
        user_id: actor.user_id,
        role: actor.role,
        location_id: actor.location_id,
        endpoint: ctx.endpoint,
        method: ctx.method,
        http_status: error.statusCode,
      },
    );
    const persistedId = (persisted.payload as Record<string, unknown>)['refusal_id'];
    return {
      refusal_id:
        persisted.event_type === 'sync.refused_capture_recorded' && typeof persistedId === 'string'
          ? persistedId
          : refusalId,
    };
  } catch (recordErr: unknown) {
    console.warn(
      `[edge] refused-capture record failed for event ${String(snapshot['event_id'])} (trace ${ctx.trace_id})`,
      recordErr,
    );
    return null;
  }
}
