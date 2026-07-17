import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext } from '../../middleware/context.js';
import { getPool } from '../../config/db.js';
import { logTamperAttempt } from '../../read/projections/audit_log.js';
import { requireRole } from '../../middleware/rbac.js';

const configAuditLogBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body.audit_log_enabled !== 'boolean') {
    sendError(res, 400, 'INVALID_PARAMS', 'audit_log_enabled must be a boolean');
    return;
  }

  if (body.audit_log_enabled === false) {
    const authContext = getAuthContext(req);
    const pool = getPool();
    const client = await pool.connect();
    try {
      await logTamperAttempt(client, {
        user_id: authContext?.userId ?? null,
        role: authContext?.roles[0]?.role ?? null,
        location_id: authContext?.roles[0]?.locationId ?? null,
        endpoint: req.url ?? null,
        method: req.method ?? null,
        error_code: 'AUDIT_LOG_TAMPER_ATTEMPT',
        details: { reason: 'Attempted to disable audit log via config endpoint' },
      });
    } finally {
      client.release();
    }
    sendError(res, 423, 'AUDIT_LOG_DISABLED', 'The audit log cannot be disabled');
    return;
  }

  sendJson(res, 200, { audit_log_enabled: true });
};

export const configAuditLogHandler: RouteHandler = requireRole({
  module: 'config',
  functionScope: 'write',
})(configAuditLogBase);