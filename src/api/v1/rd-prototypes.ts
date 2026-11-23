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
import { getRdPrototypeById, listRdPrototypes } from '../../read/projections/rd_prototype.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getTraceId } from '../../middleware/context.js';

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

function actor(req: Parameters<RouteHandler>[0]) {
  const a = getAuthorizedAssignment(req);
  return {
    user_id: getAuthContext(req)?.userId ?? NONE,
    role: a?.role ?? '',
    location_id: a?.locationId ?? '*',
  };
}
const registerBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const buildId = params?.buildId ?? '';
  for (const f of ['sku', 'serial_number', 'lot_id', 'location_id'])
    if (typeof body[f] !== 'string' || !(body[f] as string).trim()) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `${f} is required`);
      return;
    }
  const prototypeId = randomUUID(),
    meta = {
      correlation_id: typeof body.correlation_id === 'string' ? body.correlation_id : randomUUID(),
      occurred_at: new Date().toISOString(),
      actor: actor(req),
    };
  try {
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : randomUUID();
    const saved = await persistEvent(
      {
        stream_type: 'research',
        stream_id: buildId,
        event_type: 'rd_build.completed',
        payload: {
          prototype_id: prototypeId,
          build_id: buildId,
          sku: body.sku,
          serial_number: body.serial_number,
          lot_id: body.lot_id,
          location_id: body.location_id,
          correlation_id: meta.correlation_id,
        },
        metadata: meta,
        idempotency_key: key,
      } as never,
      auditCtxFor(req, 201),
    );
    sendJson(res, 200, {
      prototype: await getRdPrototypeById(saved.payload['prototype_id'] as string),
      event_id: saved.event_id,
    });
  } catch (err) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};
const listBase: RouteHandler = async (req, res) => {
  const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  sendJson(res, 200, {
    rows: await listRdPrototypes(
      u.searchParams.get('project_code')?.trim().toUpperCase() || undefined,
    ),
  });
};
const getBase: RouteHandler = async (req, res, params) => {
  const row = await getRdPrototypeById(params?.prototypeId ?? '');
  if (!row) {
    sendRequestError(req, res, 404, 'RD_PROTOTYPE_NOT_FOUND', 'Prototype not found');
    return;
  }
  sendJson(res, 200, row);
};
export const completeRdBuildHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(registerBase);
export const listRdPrototypesHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(listBase);
export const getRdPrototypeHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getBase,
);
