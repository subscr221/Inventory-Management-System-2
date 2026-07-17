import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import type { PoolClient } from 'pg';
import { logAuditEntry } from '../read/projections/audit_log.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface EventEnvelope {
  event_id?: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  event_version?: number;
  payload: Record<string, unknown>;
  metadata: {
    correlation_id: string;
    causation_id?: string | null;
    actor: {
      user_id: string;
      role: string;
      location_id: string;
    };
    device_id?: string | null;
    capture_method?: 'AUTO' | 'MANUAL';
    occurred_at: string;
    synced_at?: string | null;
  };
  schema_version?: number;
  idempotency_key?: string | null;
}

export interface PersistedEvent extends EventEnvelope {
  event_id: string;
  event_version: number;
  schema_version: number;
  created_at: string;
}

export function validateEnvelope(body: unknown): asserts body is EventEnvelope {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'Request body must be a JSON object');
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj['stream_type'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'stream_type is required and must be a non-empty string');
  }

  if (!isUuid(obj['stream_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'stream_id is required and must be a valid UUID');
  }

  if (!isNonEmptyString(obj['event_type'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_type is required and must be a non-empty string');
  }

  if (obj['event_version'] !== undefined && (!Number.isInteger(obj['event_version']) || (obj['event_version'] as number) <= 0)) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_version must be a positive integer');
  }

  if (obj['schema_version'] !== undefined && (!Number.isInteger(obj['schema_version']) || (obj['schema_version'] as number) <= 0)) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'schema_version must be a positive integer');
  }

  if (obj['idempotency_key'] !== undefined && obj['idempotency_key'] !== null && typeof obj['idempotency_key'] !== 'string') {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'idempotency_key must be a string or null');
  }

  if (typeof obj['payload'] !== 'object' || obj['payload'] === null || Array.isArray(obj['payload'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'payload is required and must be a JSON object');
  }

  if (typeof obj['metadata'] !== 'object' || obj['metadata'] === null || Array.isArray(obj['metadata'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata is required and must be a JSON object');
  }

  const meta = obj['metadata'] as Record<string, unknown>;

  if (!isUuid(meta['correlation_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.correlation_id is required and must be a valid UUID');
  }

  if (typeof meta['actor'] !== 'object' || meta['actor'] === null || Array.isArray(meta['actor'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor is required and must be an object');
  }

  const actor = meta['actor'] as Record<string, unknown>;
  if (!isUuid(actor['user_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.user_id is required and must be a valid UUID');
  }
  if (!isNonEmptyString(actor['role'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.role is required and must be a non-empty string');
  }
  if (!isUuid(actor['location_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.location_id is required and must be a valid UUID');
  }

  const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof meta['occurred_at'] !== 'string' || !ISO8601_REGEX.test(meta['occurred_at'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.occurred_at is required and must be a valid ISO-8601 timestamp');
  }

  if (meta['causation_id'] !== undefined && meta['causation_id'] !== null && !isUuid(meta['causation_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.causation_id must be a valid UUID or null');
  }

  if (meta['capture_method'] !== undefined && meta['capture_method'] !== 'AUTO' && meta['capture_method'] !== 'MANUAL') {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.capture_method must be AUTO or MANUAL');
  }
}

function mapRowToEvent(row: Record<string, unknown>): PersistedEvent {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    event_id: row['event_id'] as string,
    stream_type: row['stream_type'] as string,
    stream_id: row['stream_id'] as string,
    event_type: row['event_type'] as string,
    event_version: row['event_version'] as number,
    payload: row['payload'] as Record<string, unknown>,
    metadata: row['metadata'] as PersistedEvent['metadata'],
    schema_version: row['schema_version'] as number,
    idempotency_key: row['idempotency_key'] as string | null,
    created_at: createdAt,
  };
}

export async function persistEvent(envelope: EventEnvelope, auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'http_status' | 'error_code' | 'details'>): Promise<PersistedEvent> {
  const pool = getPool();
  const eventId = randomUUID();
  const syncedAt = new Date().toISOString();

  const metadata = {
    ...envelope.metadata,
    synced_at: syncedAt,
  };

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    let nextVersion: number;
    if (envelope.event_version !== undefined) {
      nextVersion = envelope.event_version;
    } else {
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(event_version), 0) + 1 AS next_version FROM domain_events WHERE stream_id = $1`,
        [envelope.stream_id],
      );
      nextVersion = versionResult.rows[0]!['next_version'] as number;
    }

    const result = await client.query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at`,
      [
        eventId,
        envelope.stream_type,
        envelope.stream_id,
        envelope.event_type,
        nextVersion,
        envelope.payload,
        metadata,
        envelope.schema_version ?? 1,
        envelope.idempotency_key ?? null,
      ],
    );

    if (auditCtx) {
      await logAuditEntry(client, {
        ...auditCtx,
        event_id: eventId,
        http_status: 201,
        error_code: null,
      });
    }

    await client.query('COMMIT');
    return mapRowToEvent(result.rows[0]!);
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505' && 'constraint' in err) {
      // Postgres exposes the violated constraint name via err.constraint, not err.detail
      // (err.detail only contains the conflicting key/value, e.g. "Key (idempotency_key)=(...) already exists.").
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_idempotency') {
        const existing = await client.query(
          `SELECT event_id FROM domain_events WHERE idempotency_key = $1`,
          [envelope.idempotency_key],
        );
        const existingEventId = existing.rows.length > 0 ? existing.rows[0]!['event_id'] : 'unknown';
        throw new AppError(409, 'DUPLICATE_EVENT', 'Event with this idempotency_key already exists', {
          existing_event_id: existingEventId,
        });
      } else if (constraint === 'uq_stream_version') {
        throw new AppError(409, 'STREAM_CONFLICT', 'Event version conflict in stream', {
          stream_id: envelope.stream_id,
          event_version: envelope.event_version,
        });
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function readStream(
  streamType: string,
  streamId: string,
): Promise<PersistedEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
     FROM domain_events
     WHERE stream_type = $1 AND stream_id = $2
     ORDER BY event_version ASC`,
    [streamType, streamId],
  );

  return result.rows.map(mapRowToEvent);
}
