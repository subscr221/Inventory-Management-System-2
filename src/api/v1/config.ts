import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { getPool } from '../../config/db.js';
import { logAuditEntry, logTamperAttempt } from '../../read/projections/audit_log.js';
import { requireRole } from '../../middleware/rbac.js';

const configAuditLogBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body.audit_log_enabled !== 'boolean') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'audit_log_enabled must be a boolean');
    return;
  }

  const authContext = getAuthContext(req);
  // The exact assignment RBAC matched for this request (set by requireRole) - never re-derived
  // from the roles array, which could pick a different assignment with the same role name.
  const authorizingAssignment = getAuthorizedAssignment(req);

  if (body.audit_log_enabled === false) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await logTamperAttempt(client, {
        user_id: authContext?.userId ?? null,
        role: authorizingAssignment?.role ?? null,
        location_id: authorizingAssignment?.locationId ?? null,
        endpoint: req.url ?? null,
        method: req.method ?? null,
        error_code: 'AUDIT_LOG_TAMPER_ATTEMPT',
        details: { reason: 'Attempted to disable audit log via config endpoint' },
      });
    } finally {
      client.release();
    }
    sendRequestError(req, res, 423, 'AUDIT_LOG_DISABLED', 'The audit log cannot be disabled');
    return;
  }

  // Enable (no-op) branch: still a mutating API request, so it gets an edit-log record (AC1)
  // even though no state changes - event_id null marks it as a non-event mutation.
  if (authContext) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await logAuditEntry(client, {
        trace_id: getTraceId(req) ?? '',
        user_id: authContext.userId,
        role: authorizingAssignment?.role ?? '',
        location_id: authorizingAssignment?.locationId ?? '',
        endpoint: req.url ?? '',
        method: req.method ?? 'PUT',
        event_id: null,
        http_status: 200,
        error_code: null,
        details: { no_op: true, reason: 'audit_log_enabled set to true (already enabled)' },
      });
    } finally {
      client.release();
    }
  }

  sendJson(res, 200, { audit_log_enabled: true });
};

export const configAuditLogHandler: RouteHandler = requireRole({
  module: 'config',
  functionScope: 'write',
})(configAuditLogBase);
