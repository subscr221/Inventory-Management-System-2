import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';

import {
  getIndentById,
  getIndentLines,
  listIndents,
  findOpenDuplicate,
} from '../../read/projections/indent.js';
import type { IndentRow } from '../../read/projections/indent.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../../read/projections/doa_registry.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
export const INDENT_DOA_TYPE = 'indent_approval';

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
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

export async function resolveApprover(
  transactionType: string,
  value: number | string,
): Promise<{
  requiresApproval: boolean;
  approverActorId: string | null;
  doaEntryId: string | null;
}> {
  const doaEntry = await findMatchingDoaEntry(transactionType, value);
  if (!doaEntry) {
    return { requiresApproval: false, approverActorId: null, doaEntryId: null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today);
    return delegation?.delegate_user_id ?? holder.user_id;
  };

  let approver = await tryHolder(doaEntry.role);
  if (!approver) {
    const entries = await listActiveDoaEntries(transactionType);
    for (const e of entries) {
      if (e.role === doaEntry.role) continue;
      approver = await tryHolder(e.role);
      if (approver) break;
    }
  }

  if (!approver) {
    throw new AppError(
      409,
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: transactionType },
    );
  }
  return { requiresApproval: true, approverActorId: approver, doaEntryId: doaEntry.entry_id };
}

function assertSiteReadAccess(req: IncomingMessage, siteId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No read assignment grants access to site "${siteId}"`,
    );
  }
}

interface RaiseLineInput {
  sku: string;
  item_category: string;
  requested_qty: number;
  uom: string;
  unit_price_estimate?: number;
}

export const raiseIndentBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const lines = body.lines as RaiseLineInput[] | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INDENT_LINE_REQUIRED',
      'A requisition requires at least one line item',
    );
    return;
  }

  // AC 2: online duplicate pre-check. A potential duplicate is flagged with DUPLICATE_EVENT and
  // the raise proceeds only after explicit confirmation (confirm_duplicate: true).
  if (body.confirm_duplicate !== true) {
    for (const line of lines) {
      if (typeof line?.sku !== 'string') continue;
      const dup = await findOpenDuplicate(
        actor.userId,
        line.sku.trim(),
        config.indent.duplicateWindowDays,
      );
      if (dup) {
        sendRequestError(
          req,
          res,
          409,
          'DUPLICATE_EVENT',
          `You raised ${dup.indent_number_ext} on ${new Date(dup.created_at).toISOString().slice(0, 10)}. Are you raising a new indent or retrying?`,
          {
            duplicate_of_indent_id: dup.indent_id,
            duplicate_indent_number_ext: dup.indent_number_ext,
            duplicate_status: dup.status,
            sku: line.sku,
            confirmation_required: true,
          },
        );
        return;
      }
    }
  }

  // AC 6: DOA band resolution against the indent's real estimated value - never hard-coded.
  // Use string-based decimal arithmetic to match the DB's NUMERIC(18,4) computation and avoid
  // IEEE 754 floating-point imprecision at band boundaries.
  let estimatedValueStr = '0';
  for (const line of lines) {
    const qty = typeof line?.requested_qty === 'number' ? line.requested_qty : 0;
    const price = typeof line?.unit_price_estimate === 'number' ? line.unit_price_estimate : 0;
    const lineValue = qty * price;
    // Accumulate as string to preserve precision
    estimatedValueStr = (parseFloat(estimatedValueStr) + lineValue).toFixed(4);
  }
  const estimatedValue = parseFloat(estimatedValueStr);
  const approval = await resolveApprover(INDENT_DOA_TYPE, estimatedValue);

  const indentId = randomUUID();
  const now = new Date().toISOString();
  const eventId = randomUUID();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indentId,
      event_type: 'indent.raised',
      event_id: eventId,
      payload: {
        indent_id: indentId,
        requester_user_id: actor.userId,
        department_code: body.department_code,
        site_id: body.site_id,
        business_stream: body.business_stream,
        need_by_date: body.need_by_date,
        urgent: body.urgent === true,
        reason: body.reason ?? null,
        lines,
        approver_actor_id: approval.approverActorId ?? undefined,
        doa_entry_id: approval.doaEntryId ?? undefined,
        duplicate_confirmed: body.confirm_duplicate === true,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 201),
  );

  const indent = await getIndentById(indentId);
  const indentLines = await getIndentLines(indentId);

  if (approval.requiresApproval) {
    // AC 6: the requisition carries APPROVAL_REQUIRED until the resolved authority acts.
    sendJson(res, 201, {
      event_id: persisted.event_id,
      error_code: 'APPROVAL_REQUIRED',
      message: 'Requisition raised and routed for approval',
      indent: indent ?? null,
      lines: indentLines,
      details: {
        indent_id: indentId,
        approver_actor_id: approval.approverActorId,
        doa_entry_id: approval.doaEntryId,
      },
    });
    return;
  }

  sendJson(res, 201, {
    event_id: persisted.event_id,
    indent: indent ?? null,
    lines: indentLines,
  });
};

export const getIndentBase: RouteHandler = async (req, res, params) => {
  const indentId = params?.['indentId'];
  if (!indentId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'indentId is required');
    return;
  }

  const indent = await getIndentById(indentId);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_NOT_FOUND', 'Indent not found', {
      indent_id: indentId,
    });
    return;
  }
  assertSiteReadAccess(req, indent.site_id);

  const lines = await getIndentLines(indentId);
  sendJson(res, 200, { indent, lines });
};

export const listIndentsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusParam = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const mine = url.searchParams.get('mine');
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  const validStatuses: IndentRow['status'][] = [
    'raised',
    'pending-confirmation',
    'approved',
    'rejected',
    'ordered',
    'cancelled',
    'closed',
  ];
  let status: IndentRow['status'] | undefined;
  if (statusParam) {
    if ((validStatuses as string[]).includes(statusParam)) {
      status = statusParam as IndentRow['status'];
    } else {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `status must be one of: ${validStatuses.join(', ')}`,
        {
          status: statusParam,
        },
      );
      return;
    }
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const offset = offsetParam ? Number.parseInt(offsetParam, 10) : undefined;
  if (
    (limitParam && (!Number.isInteger(limit) || limit! <= 0)) ||
    (offsetParam && (!Number.isInteger(offset) || offset! < 0))
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit must be a positive integer and offset a non-negative integer',
    );
    return;
  }

  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const permittedSites = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');

  const actor = actorContext(req);
  const results = await listIndents({
    status,
    requesterUserId: mine === 'true' ? actor.userId : undefined,
    search: search ?? undefined,
    permittedSites,
    limit,
    offset,
  });

  sendJson(res, 200, { indents: results });
};

async function loadIndentOr404(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  indentId: string | undefined,
): Promise<IndentRow | null> {
  if (!indentId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'indentId is required');
    return null;
  }
  const indent = await getIndentById(indentId);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_NOT_FOUND', 'Indent not found', {
      indent_id: indentId,
    });
    return null;
  }
  return indent;
}

/** AC 2 / AC 3: the requester confirms a duplicate-held indent as intentional. */
export const confirmIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  if (indent.requester_user_id !== actor.userId) {
    sendRequestError(
      req,
      res,
      403,
      'FUNCTION_ACCESS_DENIED',
      'Only the requester can confirm their held indent',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.confirmed',
      event_id: randomUUID(),
      payload: { indent_id: indent.indent_id },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

/** AC 3: the requester withdraws a duplicate-held indent instead of confirming it. */
export const withdrawIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  if (indent.requester_user_id !== actor.userId) {
    sendRequestError(
      req,
      res,
      403,
      'FUNCTION_ACCESS_DENIED',
      'Only the requester can withdraw their held indent',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.withdrawn',
      event_id: randomUUID(),
      payload: { indent_id: indent.indent_id },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

/**
 * AC 5 / AC 6 approval decision. SOD-01 (requester is not approver) and the DOA-resolution match
 * are enforced in the compliance seam (src/compliance/indent.ts), so a direct POST /api/v1/events
 * or an edge upload hits the same guards as this route.
 */
export const approveIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.approved',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        approver_actor_id: actor.userId,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

export const rejectIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.rejection_reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INDENT_REJECTION_REASON_REQUIRED',
      'A rejection requires a non-empty rejection_reason',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.rejected',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        rejection_reason: reason.trim(),
        approver_actor_id: actor.userId,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

export const cancelIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.cancelled',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        cancelled_reason: typeof body?.cancelled_reason === 'string' ? body.cancelled_reason : null,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

export const raiseIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(raiseIndentBase);

export const getIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getIndentBase);

export const listIndentsHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listIndentsBase);

export const confirmIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(confirmIndentBase);

export const withdrawIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(withdrawIndentBase);

export const approveIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(approveIndentBase);

export const rejectIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(rejectIndentBase);

export const cancelIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(cancelIndentBase);
