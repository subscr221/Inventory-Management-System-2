import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendError } from '../../middleware/error.js';
import { getPool } from '../../config/db.js';
import { requireRole } from '../../middleware/rbac.js';

const auditLogBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const startDate = url.searchParams.get('start_date');
  const endDate = url.searchParams.get('end_date');
  const userId = url.searchParams.get('user_id');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '100'), 1000);
  const cursor = url.searchParams.get('cursor');

  if (!startDate || !endDate) {
    sendError(res, 400, 'INVALID_PARAMS', 'start_date and end_date are required (ISO 8601)');
    return;
  }

  const pool = getPool();
  let query = `SELECT log_id, trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id, http_status, error_code
               FROM audit_log
               WHERE timestamp >= $1 AND timestamp <= $2`;
  const params: (string | number)[] = [startDate, endDate];

  if (userId) {
    params.push(userId);
    query += ` AND user_id = $${params.length}`;
  }

  if (cursor) {
    params.push(cursor);
    query += ` AND log_id > $${params.length}`;
  }

  query += ` ORDER BY timestamp ASC, log_id ASC LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const result = await pool.query(query, params);
  const hasMore = result.rows.length > limit;
  const entries = result.rows.slice(0, limit);

  const logIds = entries.map((r) => r['log_id'] as string);
  const { createHash } = await import('node:crypto');
  const rangeDigest = createHash('sha256').update(logIds.join('')).digest('hex');

  const isContiguous = logIds.length > 1
    ? logIds.every((id, i) => i === 0 || id > logIds[i - 1]!)
    : true;

  const archivedResult = await pool.query(
    `SELECT COUNT(*) AS count FROM audit_log_archive`,
  );

  sendJson(res, 200, {
    entries: entries.map((r) => ({
      log_id: r['log_id'],
      trace_id: r['trace_id'],
      user_id: r['user_id'],
      role: r['role'],
      location_id: r['location_id'],
      timestamp: (r['timestamp'] as Date).toISOString(),
      endpoint: r['endpoint'],
      method: r['method'],
      event_id: r['event_id'],
      http_status: r['http_status'],
      error_code: r['error_code'],
    })),
    range_digest: rangeDigest,
    sequence_check: {
      is_contiguous: isContiguous,
      first_log_id: logIds.length > 0 ? logIds[0] : null,
      last_log_id: logIds.length > 0 ? logIds[logIds.length - 1] : null,
      gap_count: 0,
    },
    archived_entries_count: Number(archivedResult.rows[0]!['count']),
    next_cursor: hasMore && entries.length > 0 ? (entries[entries.length - 1]!['log_id'] as string) : null,
  });
};

export const auditLogHandler: RouteHandler = requireRole({
  module: 'audit',
  functionScope: 'read',
})(auditLogBase);