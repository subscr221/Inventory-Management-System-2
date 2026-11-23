import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import {
  getRdRequisitionById,
  getRdRequisitionLines,
  listRdRequisitions,
} from '../../read/projections/rd_requisition.js';
import { listRdIssueCostsByRequisition } from '../../read/projections/rd_issue_cost.js';
import { listRdEquipmentCustodyByRequisition } from '../../read/projections/rd_equipment_custody.js';

/**
 * Story 10.2 (FR-RD-04/05): R&D requisition raise / list / get / approve / reject handlers. The
 * raise runs inside persistEvent so the budget check, owner/head routing and header+lines commit
 * atomically; the response reads the durable projection back (AD-16). issue_type is captured on
 * the line at raise time and validated against the fixed vocabulary.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  return {
    userId: authContext?.userId ?? NO_LOCATION_UUID,
    role: assignment?.role ?? '',
    auditLocationId: assignment?.locationId ?? '*',
  };
}

function auditCtxFor(
  req: IncomingMessage,
  actor: ActorContext,
  httpStatus: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function actorMetadata(actor: ActorContext, correlationId: string | undefined) {
  return {
    correlation_id: correlationId ?? randomUUID(),
    occurred_at: new Date().toISOString(),
    actor: {
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.auditLocationId,
    },
  };
}

async function requisitionView(requisitionId: string): Promise<Record<string, unknown> | null> {
  const header = await getRdRequisitionById(requisitionId);
  if (!header) return null;
  const [lines, costs, custody] = await Promise.all([
    getRdRequisitionLines(requisitionId),
    listRdIssueCostsByRequisition(requisitionId),
    listRdEquipmentCustodyByRequisition(requisitionId),
  ]);
  return { ...header, lines, issue_costs: costs, equipment_custody: custody };
}

const raiseBase: RouteHandler = async (req, res) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const bad = (m: string) => sendRequestError(req, res, 400, 'INVALID_PARAMS', m);

  const projectCode = typeof body['project_code'] === 'string' ? body['project_code'].trim().toUpperCase() : '';
  if (!projectCode) return bad('project_code is required');
  const rawLines = body['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return bad('lines is required and non-empty');
  }
  const lines = rawLines.map((raw) => {
    const l = raw as Record<string, unknown>;
    return {
      line_id: randomUUID(),
      sku: typeof l['sku'] === 'string' ? l['sku'].trim() : '',
      requested_qty: typeof l['requested_qty'] === 'string' ? l['requested_qty'] : '',
      uom: typeof l['uom'] === 'string' ? l['uom'].trim() : '',
      unit_cost_estimate: typeof l['unit_cost_estimate'] === 'string' ? l['unit_cost_estimate'] : '',
      issue_type: typeof l['issue_type'] === 'string' ? l['issue_type'] : '',
    };
  });

  const correlationId = body['correlation_id'] as string | undefined;
  const idempotencyKey = (body['idempotency_key'] as string) ?? randomUUID();
  const requisitionId = randomUUID();

  const event = {
    stream_type: 'research',
    stream_id: requisitionId,
    event_type: 'rd_requisition.raised',
    payload: {
      requisition_id: requisitionId,
      project_code: projectCode,
      requester_user_id: actor.userId,
      business_stream: 'research',
      lines,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const effectiveId = persisted.stream_id ?? requisitionId;
    const view = await requisitionView(effectiveId);
    if (!view) {
      sendRequestError(req, res, 404, 'RD_REQUISITION_NOT_FOUND', 'Requisition not found');
      return;
    }
    if (view['budget_breach'] === true || view['status'] === 'approval_required') {
      sendJson(res, 201, { ...view, error_code: 'APPROVAL_REQUIRED' });
      return;
    }
    sendJson(res, 201, view);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const listBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  // \d+ guard: Number('abc') reaching LIMIT NaN is a raw 500 (Story 5.2 Group 2 patch).
  const limit = /^\d+$/.test(limitParam ?? '')
    ? Math.max(Math.min(Number(limitParam), 200), 1)
    : 200;
  const offset = /^\d+$/.test(offsetParam ?? '') ? Math.min(Number(offsetParam), 1_000_000) : 0;
  const status = url.searchParams.get('status');
  const projectCode = url.searchParams.get('project_code');
  const filters: { projectCode?: string; status?: string; limit: number; offset: number } = {
    limit,
    offset,
  };
  if (status !== null) filters.status = status;
  if (projectCode !== null) filters.projectCode = projectCode.trim().toUpperCase();
  const result = await listRdRequisitions(filters);
  sendJson(res, 200, {
    requisitions: result.rows,
    total: result.total,
    limit,
    offset,
  });
};

const getBase: RouteHandler = async (req, res, params) => {
  const id = params?.requisitionId as string;
  if (!id) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'requisitionId is required');
    return;
  }
  const view = await requisitionView(id);
  if (!view) {
    sendRequestError(req, res, 404, 'RD_REQUISITION_NOT_FOUND', 'Requisition not found');
    return;
  }
  sendJson(res, 200, view);
};

const approveBase: RouteHandler = async (req, res, params) => {
  const actor = actorContext(req);
  const requisitionId = params?.requisitionId as string;
  if (!requisitionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'requisitionId is required');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const correlationId = body['correlation_id'] as string | undefined;
  const event = {
    stream_type: 'research',
    stream_id: requisitionId,
    event_type: 'rd_requisition.approved',
    payload: { requisition_id: requisitionId, correlation_id: correlationId },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: randomUUID(),
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const view = await requisitionView(requisitionId);
    sendJson(res, 200, view ?? { requisition_id: requisitionId });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const rejectBase: RouteHandler = async (req, res, params) => {
  const actor = actorContext(req);
  const requisitionId = params?.requisitionId as string;
  if (!requisitionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'requisitionId is required');
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const rejectionReason = typeof body['rejection_reason'] === 'string' ? body['rejection_reason'] : '';
  if (!rejectionReason.trim()) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'rejection_reason is required');
    return;
  }
  const correlationId = body['correlation_id'] as string | undefined;
  const event = {
    stream_type: 'research',
    stream_id: requisitionId,
    event_type: 'rd_requisition.rejected',
    payload: { requisition_id: requisitionId, rejection_reason: rejectionReason, correlation_id: correlationId },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: randomUUID(),
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const view = await requisitionView(requisitionId);
    sendJson(res, 200, view ?? { requisition_id: requisitionId });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

export const raiseRdRequisitionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(raiseBase);
export const listRdRequisitionsHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  listBase,
);
export const getRdRequisitionHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getBase,
);
export const approveRdRequisitionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(approveBase);
export const rejectRdRequisitionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(rejectBase);
