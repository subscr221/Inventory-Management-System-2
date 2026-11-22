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
import { getRdRequisitionById } from '../../read/projections/rd_requisition.js';
import { listRdIssueCostsByRequisition } from '../../read/projections/rd_issue_cost.js';
import { listRdEquipmentCustodyByRequisition } from '../../read/projections/rd_equipment_custody.js';

/**
 * Story 10.2 (FR-RD-06): the R&D issue handler. The issue runs inside persistEvent so the per-line
 * issued-quantity increment, the stock drain, the valuation relief and the Ind AS 38 costing /
 * equipment-custody rows commit atomically. issue_id doubles as the idempotency key so a retry of
 * the same issue never double-issues.
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

const issueBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);
  const requisitionId = params?.requisitionId as string;
  if (!requisitionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'requisitionId is required');
    return;
  }

  const existing = await getRdRequisitionById(requisitionId);
  if (!existing) {
    sendRequestError(req, res, 404, 'RD_REQUISITION_NOT_FOUND', 'Requisition not found');
    return;
  }

  const rawLines = body['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    sendRequestError(req, res, 400, 'RD_REQUISITION_LINE_REQUIRED', 'lines is required and non-empty');
    return;
  }
  const lines = rawLines.map((raw) => {
    const l = raw as Record<string, unknown>;
    const pick = (k: string): string | null =>
      typeof l[k] === 'string' ? (l[k] as string) : null;
    return {
      requisition_line_id: pick('requisition_line_id') ?? '',
      quantity: pick('quantity') ?? '',
      location_id: pick('location_id') ?? '',
      lot_id: pick('lot_id'),
      custodian_user_id: pick('custodian_user_id'),
      expected_return_date: pick('expected_return_date'),
      condition_codes: Array.isArray(l['condition_codes']) ? (l['condition_codes'] as string[]) : null,
      asset_id: pick('asset_id'),
    };
  });

  const correlationId = body['correlation_id'] as string | undefined;
  const issueId = typeof body['issue_id'] === 'string' ? body['issue_id'] : randomUUID();
  const idempotencyKey = typeof body['issue_id'] === 'string' ? body['issue_id'] : issueId;

  const event = {
    stream_type: 'research',
    stream_id: requisitionId,
    event_type: 'rd_requisition.issued',
    payload: {
      requisition_id: requisitionId,
      issue_id: issueId,
      lines,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const [costs, custody] = await Promise.all([
      listRdIssueCostsByRequisition(requisitionId),
      listRdEquipmentCustodyByRequisition(requisitionId),
    ]);
    sendJson(res, 201, {
      requisition_id: requisitionId,
      issue_id: issueId,
      issue_costs: costs,
      equipment_custody: custody,
    });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

export const issueRdRequisitionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(issueBase);
