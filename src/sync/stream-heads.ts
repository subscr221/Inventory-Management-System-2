import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import type { EventEnvelope } from '../events/store.js';

/**
 * Story 7.8 (FR-M-17): the per-stream version reads the edge upload handler and the technician
 * worklist share.
 *
 * - getStreamHeadVersions is the `stream_version` the worklist reports per work order and
 *   reservation, and the `head` the upload handler compares a declared event_version against
 *   (Binding Decision 2: a declared version is accepted only when it equals head + 1).
 * - listStreamEventTypesAfter is the gap read behind the benign rebase (Binding Decision 16).
 * - findExistingEdgeEvent is the sequential DUPLICATE_EVENT pre-check on the edge route (Binding
 *   Decision 1); the uq_idempotency / domain_events_pkey 23505 mapper is the race path.
 *
 * All three are plain SELECTs outside any persist transaction; nothing here takes a lock.
 */

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MAX(event_version) per stream; a stream with no events reports 0. */
export async function getStreamHeadVersions(
  streamIds: string[],
  client?: PoolClient,
): Promise<Map<string, number>> {
  const heads = new Map<string, number>();
  const valid = [...new Set(streamIds.filter((id) => UUID_REGEX.test(id)))];
  for (const id of valid) heads.set(id.toLowerCase(), 0);
  if (valid.length === 0) return heads;
  const result = await runner(client).query(
    `SELECT stream_id, MAX(event_version)::int AS head_version
       FROM domain_events
      WHERE stream_id = ANY($1::uuid[])
      GROUP BY stream_id`,
    [valid],
  );
  for (const row of result.rows as Array<{ stream_id: string; head_version: number }>) {
    heads.set(String(row.stream_id).toLowerCase(), row.head_version);
  }
  return heads;
}

/** Event types on a stream with event_version > afterVersion, ascending by version. */
export async function listStreamEventTypesAfter(
  streamId: string,
  afterVersion: number,
  client?: PoolClient,
): Promise<string[]> {
  if (!UUID_REGEX.test(streamId) || !Number.isInteger(afterVersion)) return [];
  const result = await runner(client).query(
    `SELECT event_type FROM domain_events
      WHERE stream_id = $1 AND event_version > $2
      ORDER BY event_version ASC`,
    [streamId, afterVersion],
  );
  return (result.rows as Array<{ event_type: string }>).map((row) => row.event_type);
}

/**
 * The event already holding this envelope's idempotency_key or event_id, if any. Mirrors the
 * persistEvent short-circuit predicate exactly (a NULL key is "not supplied", never a wildcard).
 */
export async function findExistingEdgeEvent(
  envelope: Pick<EventEnvelope, 'event_id' | 'idempotency_key'>,
  client?: PoolClient,
): Promise<{ event_id: string; event_type: string } | null> {
  const key = envelope.idempotency_key?.trim() ? envelope.idempotency_key : null;
  const eventId =
    envelope.event_id && UUID_REGEX.test(envelope.event_id) ? envelope.event_id : null;
  if (key === null && eventId === null) return null;
  const result = await runner(client).query(
    `SELECT event_id, event_type FROM domain_events
      WHERE ($1::text IS NOT NULL AND idempotency_key = $1::text)
         OR ($2::uuid IS NOT NULL AND event_id = $2::uuid)
      LIMIT 1`,
    [key, eventId],
  );
  return (result.rows[0] as { event_id: string; event_type: string } | undefined) ?? null;
}
