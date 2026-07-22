import type { EdgeEventRecord } from '../capture/test-capture';
import { isPendingStatus } from '../sync/sync-status';
import type { EdgeLocalStatus } from './schema';

export interface QueryExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
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

export async function hasAuthRequired(db: QueryExecutor): Promise<boolean> {
  const rows = await db.getAll<{ count: number }>(
    `SELECT COUNT(*) AS count FROM edge_outbox WHERE local_status = ?`,
    ['auth_required'],
  );
  return (rows[0]?.count ?? 0) > 0;
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
