import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getTraceId } from '../../middleware/context.js';
import { randomUUID } from 'node:crypto';

const NONE = '00000000-0000-0000-0000-000000000000';
function auditCtxFor(
  req: Parameters<RouteHandler>[0],
  status: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  const a = getAuthorizedAssignment(req);
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: getAuthContext(req)?.userId ?? NONE,
    role: a?.role ?? '',
    location_id: a?.locationId ?? '*',
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: status,
  };
}
const base: RouteHandler = async (req, res, params) => {
  const projectCode = (params?.projectCode ?? '').trim().toUpperCase();
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  for (const f of ['posting_id', 'quantity', 'location_id', 'lot_id', 'reason_code'])
    if (typeof body[f] !== 'string' || !(body[f] as string).trim()) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `${f} is required`);
      return;
    }
  const a = getAuthorizedAssignment(req);
  const payload = {
    posting_id: body.posting_id,
    project_code: projectCode,
    quantity: body.quantity,
    location_id: body.location_id,
    lot_id: body.lot_id,
    reason_code: body.reason_code,
    correlation_id: body.correlation_id,
  };
  try {
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : randomUUID();
    const saved = await persistEvent(
      {
stream_type: 'research',
stream_id: body.posting_id as string,
        event_type: 'rd_material.returned',
        payload,
        metadata: {
          correlation_id:
            typeof body.correlation_id === 'string' ? body.correlation_id : randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: {
            user_id: getAuthContext(req)?.userId ?? NONE,
            role: a?.role ?? '',
            location_id: a?.locationId ?? '*',
          },
        },
        idempotency_key: key,
      } as never,
      auditCtxFor(req, 201),
    );
    sendJson(res, 201, { project_code: projectCode, event_id: saved.event_id });
  } catch (err) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};
export const returnRdMaterialHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(base);
