import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getPool } from '../../config/db.js';
import { requireRole } from '../../middleware/rbac.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// NFR-S-05: entries purged from hot storage to the permanent S3 Glacier archive are restorable
// to queryable within 48 hours. Surfaced so an auditor querying an archived range knows the SLA.
const GLACIER_RESTORE_ETA_HOURS = 48;

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const auditLogBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const startDate = url.searchParams.get('start_date');
  const endDate = url.searchParams.get('end_date');
  const userId = url.searchParams.get('user_id');
  const limitRaw = url.searchParams.get('limit');
  const cursorRaw = url.searchParams.get('cursor');

  // --- Parameter validation (fail with 400 INVALID_PARAMS rather than letting malformed input
  // reach Postgres and surface as a 500). ---
  if (!startDate || !endDate) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'start_date and end_date are required (ISO 8601)');
    return;
  }
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'start_date and end_date must be valid ISO 8601 timestamps');
    return;
  }
  // Normalize to canonical UTC ISO before binding: JS Date.parse accepts formats Postgres's
  // timestamptz parser rejects (which would 500), and date-only/local-format strings would
  // otherwise take Postgres's session timezone instead of UTC, silently shifting the range.
  const startIso = new Date(startDate).toISOString();
  const endIso = new Date(endDate).toISOString();
  // Expanded-year dates (e.g. "+010000-...", "-000500-...") survive normalization in a form
  // Postgres's timestamptz parser rejects - catch them here as 400 instead of a downstream 500.
  if (!/^\d{4}-/.test(startIso) || !/^\d{4}-/.test(endIso)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'start_date and end_date must fall within the 4-digit year range');
    return;
  }
  if (userId !== null && !UUID_REGEX.test(userId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'user_id must be a valid UUID');
    return;
  }
  let limit = 100;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be a positive integer');
      return;
    }
    limit = Math.min(parsed, 1000);
  }
  // The cursor is now a seq_no (monotonic BIGINT), so it must be a non-empty, non-negative
  // integer (Number('') coerces to 0, which would silently become a valid-looking cursor).
  let cursor: number | null = null;
  if (cursorRaw !== null) {
    const parsed = Number(cursorRaw);
    if (cursorRaw.trim() === '' || !Number.isInteger(parsed) || parsed < 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cursor must be a non-negative integer seq_no');
      return;
    }
    cursor = parsed;
  }

  const pool = getPool();
  let query = `SELECT seq_no, log_id, trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id, http_status, error_code
               FROM audit_log
               WHERE timestamp >= $1 AND timestamp <= $2`;
  const params: (string | number)[] = [startIso, endIso];

  if (userId) {
    params.push(userId);
    query += ` AND user_id = $${params.length}`;
  }

  // Keyset pagination on the monotonic seq_no. The previous implementation filtered on a random
  // UUID log_id, which silently dropped any row whose UUID sorted below the cursor; seq_no is
  // strictly increasing in insert order, so `seq_no > cursor` is a correct, gap-free page boundary.
  if (cursor !== null) {
    params.push(cursor);
    query += ` AND seq_no > $${params.length}`;
  }

  params.push(limit + 1);
  query += ` ORDER BY seq_no ASC LIMIT $${params.length}`;

  const result = await pool.query(query, params);
  const hasMore = result.rows.length > limit;
  const entries = result.rows.slice(0, limit);

  const logIds = entries.map((r) => r['log_id'] as string);
  const { createHash } = await import('node:crypto');
  const rangeDigest = createHash('sha256').update(logIds.join('')).digest('hex');

  // --- Sequence observation over the returned page (see read/projections/audit_log.sql). ---
  // node-postgres returns BIGINT as a string; Number() is safe for seq_no well below 2^53.
  // IMPORTANT SEMANTICS: identity sequences legitimately skip values on transaction rollback and
  // crash recovery, so a seq_no gap is an OBSERVATION, not tamper evidence by itself. Tamper
  // evidence rests on range_digest plus the DB-level immutability triggers. Gap data is surfaced
  // so an auditor can correlate skips against operational records if they choose.
  const seqNos = entries.map((r) => Number(r['seq_no']));
  const firstSeqNo = seqNos.length > 0 ? seqNos[0]! : null;
  const lastSeqNo = seqNos.length > 0 ? seqNos[seqNos.length - 1]! : null;
  const appendOrderVerified = seqNos.every((s, i) => i === 0 || s > seqNos[i - 1]!);

  // A user_id filter deliberately excludes other users' interleaved rows, so seq_no gaps are
  // EXPECTED and the observation is meaningless. Only report it for the un-user-filtered view.
  const gapCheckApplicable = !userId;
  let isContiguous: boolean | null = null;
  let gapCount: number | null = null;
  if (gapCheckApplicable) {
    if (seqNos.length > 0) {
      // When a cursor is present, measure from the cursor boundary - a gap falling exactly
      // between two pages must not vanish (the previous page ended at seq_no === cursor).
      const spanStart = cursor !== null ? cursor + 1 : firstSeqNo!;
      const span = lastSeqNo! - spanStart + 1;
      gapCount = span - seqNos.length;
      isContiguous = gapCount === 0;
    } else {
      gapCount = 0;
      isContiguous = true;
    }
  }

  // Range-scoped archived count: how many entries WITHIN the queried window have been exported to
  // the permanent archive (NOT a global count of every archived row ever).
  const archivedResult = await pool.query(
    `SELECT COUNT(*) AS count
       FROM audit_log_archive a
       JOIN audit_log l ON l.log_id = a.original_log_id
      WHERE l.timestamp >= $1 AND l.timestamp <= $2`,
    [startIso, endIso],
  );

  sendJson(res, 200, {
    entries: entries.map((r) => ({
      seq_no: Number(r['seq_no']),
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
      first_seq_no: firstSeqNo,
      last_seq_no: lastSeqNo,
      entry_count: seqNos.length,
      append_order_verified: appendOrderVerified,
      // false when a user_id filter is applied (seq_no gaps are then expected, not meaningful).
      gap_check_applicable: gapCheckApplicable,
      // Sequence-skip OBSERVATION for this page (cursor-boundary-aware, so gaps between pages are
      // visible). A nonzero gap_count can be a benign rollback/crash skip - it is NOT tamper
      // evidence by itself. null when a user_id filter makes the observation inapplicable.
      is_contiguous: isContiguous,
      gap_count: gapCount,
      gap_semantics:
        'gaps may include benign sequence skips (transaction rollback, crash recovery); tamper evidence rests on range_digest and DB-level immutability',
    },
    archived_entries_count: Number(archivedResult.rows[0]!['count']),
    archive_restore_eta_hours: GLACIER_RESTORE_ETA_HOURS,
    next_cursor: hasMore && lastSeqNo !== null ? String(lastSeqNo) : null,
  });
};

export const auditLogHandler: RouteHandler = requireRole({
  module: 'audit',
  functionScope: 'read',
})(auditLogBase);
