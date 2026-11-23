import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import { randomUUID } from 'node:crypto';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getTraceId } from '../../middleware/context.js';
import { getRdPrototypeById } from '../../read/projections/rd_prototype.js';
import {
  getRdDispositionById,
  listRdDispositionLines,
} from '../../read/projections/rd_disposition.js';

const NONE = '00000000-0000-0000-0000-000000000000';
function meta(req: Parameters<RouteHandler>[0]) {
  const a = getAuthorizedAssignment(req);
  return {
    correlation_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor: {
      user_id: getAuthContext(req)?.userId ?? NONE,
      role: a?.role ?? '',
      location_id: a?.locationId ?? '*',
    },
  };
}
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
async function post(
  req: Parameters<RouteHandler>[0],
  res: Parameters<RouteHandler>[1],
  id: string,
  type: string,
  payload: Record<string, unknown>,
  status = 200,
) {
  try {
    const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
    const key =
      typeof body['idempotency_key'] === 'string' ? body['idempotency_key'] : randomUUID();
    const event = {
      stream_type: 'research',
      stream_id: id,
      event_type: type,
      payload,
      metadata: meta(req),
      idempotency_key: key,
    };
    const saved = await persistEvent(event as never, auditCtxFor(req, status));
    sendJson(res, status, { disposition_id: payload['disposition_id'], event_id: saved.event_id });
  } catch (err) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
}
const requestBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  for (const f of ['disposition_type'])
    if (typeof body[f] !== 'string') {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `${f} is required`);
      return;
    }
  if (typeof body['asset'] === 'object' && body['asset'] !== null) {
    const asset = body['asset'] as Record<string, unknown>;
    for (const f of ['asset_id', 'asset_tag', 'asset_name', 'criticality_class'])
      if (typeof asset[f] !== 'string' || !(asset[f] as string).trim()) {
        sendRequestError(req, res, 400, 'INVALID_PARAMS', `asset.${f} is required`);
        return;
      }
  }
  const prototypeId = params?.prototypeId ?? '';
  const prototype = await getRdPrototypeById(prototypeId);
  if (!prototype) {
    sendRequestError(req, res, 404, 'RD_PROTOTYPE_NOT_FOUND', 'Prototype not found');
    return;
  }
  const dispositionId = randomUUID();
  const lines = Array.isArray(body['lines'])
    ? body['lines'].map((raw) => ({
        ...(raw as Record<string, unknown>),
        line_id:
          typeof (raw as Record<string, unknown>)['line_id'] === 'string'
            ? (raw as Record<string, unknown>)['line_id']
            : randomUUID(),
      }))
    : body['lines'];
  await post(
    req,
    res,
    dispositionId,
    'rd_disposition.requested',
    {
      disposition_id: dispositionId,
      prototype_id: prototypeId,
      disposition_type: body['disposition_type'],
      lines,
      asset: body['asset'],
      production_reference: body['production_reference'],
    },
    201,
  );
};
const decision =
  (kind: 'approved' | 'rejected'): RouteHandler =>
  async (req, res, params) => {
    const id = params?.dispositionId ?? '';
    const d = await getRdDispositionById(id);
    if (!d) {
      sendRequestError(req, res, 404, 'RD_DISPOSITION_NOT_FOUND', 'Disposition not found');
      return;
    }
    const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
    await post(req, res, id, `rd_disposition.${kind}`, {
      disposition_id: id,
      ...(kind === 'rejected' ? { rejection_reason: body.rejection_reason } : {}),
    });
  };
const executeBase: RouteHandler = async (req, res, params) => {
  const id = params?.dispositionId ?? '';
  const d = await getRdDispositionById(id);
  if (!d) {
    sendRequestError(req, res, 404, 'RD_DISPOSITION_NOT_FOUND', 'Disposition not found');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  await post(req, res, id, 'rd_disposition.executed', {
    disposition_id: id,
    asset: body['asset'],
    production_reference: body['production_reference'],
  });
};
const getBase: RouteHandler = async (req, res, params) => {
  const id = params?.dispositionId ?? '';
  const d = await getRdDispositionById(id);
  if (!d) {
    sendRequestError(req, res, 404, 'RD_DISPOSITION_NOT_FOUND', 'Disposition not found');
    return;
  }
  sendJson(res, 200, { ...d, lines: await listRdDispositionLines(id) });
};
export const requestRdDispositionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(requestBase);
export const approveRdDispositionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(decision('approved'));
export const rejectRdDispositionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(decision('rejected'));
export const executeRdDispositionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(executeBase);
export const getRdDispositionHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getBase);
