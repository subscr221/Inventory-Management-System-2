import type { EdgeEventRecord } from '../capture/test-capture';
import { isPendingStatus } from '../sync/sync-status';
import type { EdgeLocalStatus } from './schema';

export interface QueryExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  writeTransaction?: <T>(callback: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

export interface CachedUser {
  userId: string;
  userName: string;
  role: string;
}

export interface CachedSite {
  siteId: string;
  siteName: string;
}

export interface OutboxRow {
  id: string;
  event_type: string;
  local_status: EdgeLocalStatus;
  server_error_code: string | null;
  created_at: string;
}

export interface FailureRow {
  id: string;
  event_type: string;
  server_error_code: string | null;
  created_at: string;
}

export interface OutboxCounts {
  pendingCount: number;
  failedCount: number;
}

export async function insertCaptureEvent(
  db: QueryExecutor,
  event: EdgeEventRecord,
): Promise<void> {
  await db.execute(
    `INSERT INTO edge_outbox (
      id, stream_type, stream_id, event_type, event_version, payload, metadata,
      schema_version, idempotency_key, local_status, server_error_code,
      server_error_details, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.event_id,
      event.stream_type,
      event.stream_id,
      event.event_type,
      event.event_version,
      JSON.stringify(event.payload),
      JSON.stringify(event.metadata),
      event.schema_version,
      event.idempotency_key,
      event.local_status,
      event.server_error_code,
      event.server_error_details ? JSON.stringify(event.server_error_details) : null,
      event.created_at,
      event.updated_at,
    ],
  );
}

export async function readOutboxCounts(db: QueryExecutor): Promise<OutboxCounts> {
  const rows = await db.getAll<{ local_status: EdgeLocalStatus; count: number }>(
    `SELECT local_status, COUNT(*) AS count FROM edge_outbox GROUP BY local_status`,
  );
  let pendingCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    if (isPendingStatus(row.local_status)) pendingCount += row.count;
    else if (row.local_status === 'needs_attention') failedCount += row.count;
  }
  return { pendingCount, failedCount };
}

/**
 * True when rows are parked on a 401. Given the signed-in user, only THEIR parked rows count
 * (Story 1.12: another person's parked rows wait for that person and are not a sign-in problem).
 */
export async function hasAuthRequired(db: QueryExecutor, currentUserId?: string): Promise<boolean> {
  if (currentUserId === undefined) {
    const rows = await db.getAll<{ count: number }>(
      `SELECT COUNT(*) AS count FROM edge_outbox WHERE local_status = ?`,
      ['auth_required'],
    );
    return (rows[0]?.count ?? 0) > 0;
  }
  const rows = await db.getAll<{ metadata: string }>(
    `SELECT metadata FROM edge_outbox WHERE local_status = ?`,
    ['auth_required'],
  );
  return rows.some((row) => {
    const owner = outboxRowOwner(row.metadata);
    return owner === null || owner === currentUserId;
  });
}

/**
 * Story 1.12: the user who captured an outbox row (`metadata.actor.user_id`). The server pins an
 * uploaded event's actor to the bearer identity, so a row may only upload under its owner's token.
 */
export function outboxRowOwner(metadata: unknown): string | null {
  if (typeof metadata !== 'string') return null;
  try {
    const parsed = JSON.parse(metadata) as { actor?: { user_id?: unknown } } | null;
    const owner = parsed?.actor?.user_id;
    return typeof owner === 'string' && owner !== '' ? owner : null;
  } catch {
    return null;
  }
}

interface OutboxRecordRow {
  id: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  event_version: number | null;
  payload: string;
  metadata: string;
  schema_version: number;
  idempotency_key: string;
  local_status: EdgeLocalStatus;
  server_error_code: string | null;
  server_error_details: string | null;
  created_at: string;
  updated_at: string;
}

const OUTBOX_COLUMNS = `id, stream_type, stream_id, event_type, event_version, payload, metadata,
      schema_version, idempotency_key, local_status, server_error_code,
      server_error_details, created_at, updated_at`;

/**
 * Story 1.12 (review decision 1): rows parked on a 401 become eligible again once THEIR OWNER has
 * signed in; rows captured by someone else stay parked until that person signs in on this device.
 *
 * Each row is deleted and re-inserted rather than updated: the connector only uploads PUT
 * operations, and a row parked for another owner has already left the upload queue (its
 * transaction was completed so the signed-in user's captures could flow). The re-insert queues a
 * fresh PUT; when the original PUT is still at the head of the queue it simply uploads first and
 * the fresh one is skipped as settled (the server's idempotency key covers the rest).
 */
export async function resetAuthRequired(db: QueryExecutor, ownerUserId: string): Promise<void> {
  const rows = await db.getAll<OutboxRecordRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM edge_outbox WHERE local_status = ?`,
    ['auth_required'],
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    if (outboxRowOwner(row.metadata) !== ownerUserId) continue;
    const requeue = async (tx: QueryExecutor) => {
      // PowerSync exposes edge_outbox as a view: address rows by id only.
      await tx.execute(`DELETE FROM edge_outbox WHERE id = ?`, [row.id]);
      await tx.execute(
        `INSERT INTO edge_outbox (${OUTBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.stream_type,
          row.stream_id,
          row.event_type,
          row.event_version,
          row.payload,
          row.metadata,
          row.schema_version,
          row.idempotency_key,
          'pending_sync',
          null,
          null,
          row.created_at,
          now,
        ],
      );
    };
    if (db.writeTransaction) await db.writeTransaction(requeue);
    else await requeue(db);
  }
}

async function readUnsettledOwners(db: QueryExecutor): Promise<Array<string | null>> {
  const rows = await db.getAll<{ metadata: string }>(
    `SELECT metadata FROM edge_outbox WHERE local_status IN (?, ?, ?)`,
    ['pending_sync', 'syncing', 'auth_required'],
  );
  return rows.map((row) => outboxRowOwner(row.metadata));
}

/**
 * Story 1.12 (AC4): the signed-in user's rows that would still upload - under whoever signs in
 * next. They must drain before a sign-out. Rows owned by someone else never upload under this
 * user (the connector parks them) and so never block; `needs_attention` and `synced` are settled.
 */
export async function countUnsettled(db: QueryExecutor, ownerUserId: string): Promise<number> {
  const owners = await readUnsettledOwners(db);
  return owners.filter((owner) => owner === ownerUserId).length;
}

/**
 * Story 1.12 (review decision 1): unsettled captures waiting for a DIFFERENT person to sign in on
 * this device, grouped by owner, so the shell can say whose they are.
 */
export async function readWaitingForOtherOwners(
  db: QueryExecutor,
  currentUserId: string,
): Promise<Array<{ userId: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const owner of await readUnsettledOwners(db)) {
    if (owner === null || owner === currentUserId) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()].map(([userId, count]) => ({ userId, count }));
}

/** Story 1.12 (AC4): forget the signed-out user's identity; site context and caches stay. */
export async function clearCachedUserContext(db: QueryExecutor): Promise<void> {
  await db.execute(`DELETE FROM cached_user_context`);
}

/**
 * Story 7.8 (Binding Decision 3): the parking predicate. True when ANOTHER outbox row on the same
 * stream has already settled STREAM_CONFLICT and was captured at or before this row (the device
 * clock is the ordering authority: two captures in the same millisecond must both park). Decided
 * from the outbox TABLE at upload time, never from in-memory state, so it survives app restarts
 * and PowerSync transaction boundaries. The connector parks the dependent locally without a
 * network call, so the server never sees the tail of a sequence whose head the supervisor has not
 * yet judged.
 */
export async function hasUpstreamStreamConflict(
  db: QueryExecutor,
  eventId: string,
  streamId: string,
  createdAt: string,
): Promise<{ parked_behind_event_id: string } | null> {
  const rows = await db.getAll<{ id: string }>(
    `SELECT id FROM edge_outbox
      WHERE stream_id = ? AND id <> ?
        AND local_status = 'needs_attention'
        AND server_error_code = 'STREAM_CONFLICT'
        AND created_at <= ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [streamId, eventId, createdAt],
  );
  const head = rows[0];
  return head ? { parked_behind_event_id: head.id } : null;
}

export async function readFailures(db: QueryExecutor): Promise<FailureRow[]> {
  return db.getAll<FailureRow>(
    `SELECT id, event_type, server_error_code, created_at
     FROM edge_outbox WHERE local_status = ? ORDER BY created_at DESC`,
    ['needs_attention'],
  );
}

export async function cacheContext(
  db: QueryExecutor,
  user: CachedUser,
  site: CachedSite,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(`DELETE FROM cached_user_context`);
  await db.execute(
    `INSERT INTO cached_user_context (id, user_id, user_name, role, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.userId, user.userId, user.userName, user.role, now],
  );
  await db.execute(`DELETE FROM cached_site_context`);
  await db.execute(
    `INSERT INTO cached_site_context (id, site_id, site_name, updated_at)
     VALUES (?, ?, ?, ?)`,
    [site.siteId, site.siteId, site.siteName, now],
  );
}

export async function readCachedContext(
  db: QueryExecutor,
): Promise<{ user: CachedUser; site: CachedSite } | null> {
  const users = await db.getAll<{ user_id: string; user_name: string; role: string }>(
    `SELECT user_id, user_name, role FROM cached_user_context LIMIT 1`,
  );
  const sites = await db.getAll<{ site_id: string; site_name: string }>(
    `SELECT site_id, site_name FROM cached_site_context LIMIT 1`,
  );
  const user = users[0];
  const site = sites[0];
  if (!user || !site) return null;
  return {
    user: { userId: user.user_id, userName: user.user_name, role: user.role },
    site: { siteId: site.site_id, siteName: site.site_name },
  };
}
