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

import {
  getPurchaseOrderById,
  getPurchaseOrderLines,
  listPurchaseOrders,
} from '../../read/projections/purchase_order.js';
import type { PurchaseOrderRow } from '../../read/projections/purchase_order.js';
import { getIndentById, getIndentLines } from '../../read/projections/indent.js';
import { getSupplierById } from '../../read/projections/supplier.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const MONEY_SCALE = /^\d+(\.\d{1,2})?$/;

function isMoneyInput(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    MONEY_SCALE.test(String(value))
  );
}

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

interface DraftLineInput {
  sku: string;
  item_category: string;
  ordered_qty: number;
  uom: string;
  unit_price: number;
  tax_rate_pct?: number;
}

export const draftPurchaseOrderBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const indentId = body.indent_id as string | undefined;
  if (!indentId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'indent_id is required');
    return;
  }

  const indent = await getIndentById(indentId);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_NOT_FOUND', 'Source indent not found', {
      indent_id: indentId,
    });
    return;
  }

  const supplierId = body.supplier_id as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplier_id is required');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', {
      supplier_id: supplierId,
    });
    return;
  }

  const indentLines = await getIndentLines(indentId);
  let lines = body.lines as DraftLineInput[] | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    lines = indentLines.map((il) => ({
      sku: il.sku,
      item_category: il.item_category,
      ordered_qty: parseFloat(il.requested_qty),
      uom: il.uom,
      unit_price: il.unit_price_estimate ? parseFloat(il.unit_price_estimate) : 0,
    }));
  }

  if (lines.length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'PO_LINE_REQUIRED',
      'A purchase order requires at least one line item',
    );
    return;
  }

  const poType = (body.po_type as string) ?? 'standard';
  if (poType !== 'standard' && poType !== 'blanket' && poType !== 'contract') {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'po_type must be standard, blanket, or contract',
    );
    return;
  }

  const ceilingValue =
    poType === 'blanket' || poType === 'contract' ? body.ceiling_value : undefined;
  if ((poType === 'blanket' || poType === 'contract') && !isMoneyInput(ceilingValue)) {
    sendRequestError(
      req,
      res,
      400,
      ceilingValue === undefined || ceilingValue === null
        ? 'PO_CEILING_REQUIRED'
        : 'INVALID_PARAMS',
      'Blanket and contract POs require a valid ceiling_value with at most 2 decimals',
    );
    return;
  }

  const poId = randomUUID();
  const now = new Date().toISOString();
  const eventId = randomUUID();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: poId,
      event_type: 'purchase_order.drafted',
      event_id: eventId,
      payload: {
        po_id: poId,
        po_type: poType,
        supplier_id: supplierId,
        indent_id: indentId,
        site_id: indent.site_id,
        // AC1: the PO inherits the source indent's business-stream tag; purchase_order.drafted
        // is registered requiresBusinessStream: true, so omitting this fails UNTAGGED_TRANSACTION.
        business_stream: indent.business_stream,
        lines,
        ceiling_value: ceilingValue !== undefined ? Number(ceilingValue) : undefined,
        currency: body.currency ?? 'INR',
        payment_terms: supplier.commercial_terms ?? undefined,
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

  const po = await getPurchaseOrderById(poId);
  const poLines = await getPurchaseOrderLines(poId);

  // Story 4.6 AC7: a supplier whose Udyam revalidation lapsed does NOT block drafting - the
  // warning rides the success envelope (ZoneIncompatibleWarning warning-not-error precedent,
  // except nothing here is withheld from persistence).
  const msmeWarning =
    supplier.msme_status === 'suspended-pending-reverification'
      ? {
          warning: {
            warning_code: 'MSME_SUPPLIER_SUSPENDED',
            message:
              `Supplier "${supplier.legal_name}" has an MSME flag suspended pending Udyam ` +
              're-verification. Statutory due dates already stamped remain in force; re-verify ' +
              'the registration via POST /api/v1/suppliers/:supplierId/msme.',
            details: { supplier_id: supplierId, msme_status: supplier.msme_status },
          },
        }
      : {};

  if (po?.status === 'pending-approval') {
    sendJson(res, 201, {
      event_id: persisted.event_id,
      error_code: 'APPROVAL_REQUIRED',
      message: 'Purchase order drafted and routed for approval',
      purchase_order: po,
      lines: poLines,
      details: {
        po_id: poId,
        approver_actor_id: po.approver_actor_id,
        doa_entry_id: po.doa_entry_id,
      },
      ...msmeWarning,
    });
    return;
  }

  sendJson(res, 201, {
    event_id: persisted.event_id,
    purchase_order: po ?? null,
    lines: poLines,
    ...msmeWarning,
  });
};

export const getPurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const poId = params?.['poId'];
  if (!poId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'poId is required');
    return;
  }

  const po = await getPurchaseOrderById(poId);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Purchase order not found', {
      po_id: poId,
    });
    return;
  }
  assertSiteReadAccess(req, po.site_id);

  const lines = await getPurchaseOrderLines(poId);
  sendJson(res, 200, { purchase_order: po, lines });
};

export const listPurchaseOrdersBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusParam = url.searchParams.get('status');
  const supplierIdParam = url.searchParams.get('supplier_id');
  const siteIdParam = url.searchParams.get('site_id');
  const search = url.searchParams.get('search');
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  const validStatuses: PurchaseOrderRow['status'][] = [
    'draft',
    'pending-approval',
    'approved',
    'rejected',
    'issued',
    'confirmed',
  ];
  let status: PurchaseOrderRow['status'] | undefined;
  if (statusParam) {
    if ((validStatuses as string[]).includes(statusParam)) {
      status = statusParam as PurchaseOrderRow['status'];
    } else {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `status must be one of: ${validStatuses.join(', ')}`,
        { status: statusParam },
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

  const results = await listPurchaseOrders({
    status,
    supplierId: supplierIdParam ?? undefined,
    siteId: siteIdParam ?? undefined,
    search: search ?? undefined,
    permittedSites,
    limit,
    offset,
  });

  sendJson(res, 200, { purchase_orders: results });
};

async function loadPoOr404(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  poId: string | undefined,
): Promise<PurchaseOrderRow | null> {
  if (!poId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'poId is required');
    return null;
  }
  const po = await getPurchaseOrderById(poId);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Purchase order not found', {
      po_id: poId,
    });
    return null;
  }
  return po;
}

export const approvePurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.approved',
      event_id: randomUUID(),
      payload: {
        po_id: po.po_id,
        approver_actor_id: actor.userId,
      },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const rejectPurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.rejection_reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'PO_REJECTION_REASON_REQUIRED',
      'A rejection requires a non-empty rejection_reason',
      { po_id: po.po_id },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.rejected',
      event_id: randomUUID(),
      payload: {
        po_id: po.po_id,
        rejection_reason: reason.trim(),
        approver_actor_id: actor.userId,
      },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const issuePurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.issued',
      event_id: randomUUID(),
      payload: { po_id: po.po_id },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const confirmPurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const promisedDate = body?.promised_delivery_date;
  if (!promisedDate || typeof promisedDate !== 'string') {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'promised_delivery_date is required and must be a YYYY-MM-DD date string',
      { po_id: po.po_id },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.confirmed',
      event_id: randomUUID(),
      payload: {
        po_id: po.po_id,
        promised_delivery_date: promisedDate,
        line_promised_dates: body.line_promised_dates ?? undefined,
      },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const recordReleaseBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const releaseValue = body?.release_value;
  if (!isMoneyInput(releaseValue) || releaseValue <= 0) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'release_value is required and must be a positive amount with at most 2 decimals',
      { po_id: po.po_id },
    );
    return;
  }
  const releaseReference = body?.release_reference;
  if (typeof releaseReference !== 'string' || releaseReference.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'release_reference is required and must be a non-empty string',
      { po_id: po.po_id },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.release_recorded',
      event_id: randomUUID(),
      payload: {
        po_id: po.po_id,
        release_value: releaseValue,
        release_reference: releaseReference.trim(),
      },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const reviseCeilingBase: RouteHandler = async (req, res, params) => {
  const po = await loadPoOr404(req, res, params?.['poId']);
  if (!po) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const newCeiling = body?.new_ceiling_value;
  if (!isMoneyInput(newCeiling)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'new_ceiling_value is required and must be a non-negative amount with at most 2 decimals',
      { po_id: po.po_id },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'purchase_order.ceiling_revised',
      event_id: randomUUID(),
      payload: {
        po_id: po.po_id,
        new_ceiling_value: newCeiling,
      },
      metadata: {
        correlation_id: po.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getPurchaseOrderById(po.po_id);
  sendJson(res, 200, { event_id: persisted.event_id, purchase_order: updated });
};

export const draftPurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(draftPurchaseOrderBase);

export const getNativePurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getPurchaseOrderBase);

export const listPurchaseOrdersHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listPurchaseOrdersBase);

export const approvePurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(approvePurchaseOrderBase);

export const rejectPurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(rejectPurchaseOrderBase);

export const issuePurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(issuePurchaseOrderBase);

export const confirmPurchaseOrderHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(confirmPurchaseOrderBase);

export const recordReleaseHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordReleaseBase);

export const reviseCeilingHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(reviseCeilingBase);
