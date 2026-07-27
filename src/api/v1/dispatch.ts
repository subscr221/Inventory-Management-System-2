import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getDispatchOrderStatus } from '../../read/projections/dispatch_order_status.js';
import { getPackingRecordById, listPackingRecordsByDispatchOrder } from '../../read/projections/packing_record.js';
import { listDocumentsByDispatchOrder } from '../../read/projections/dispatch_document.js';
import { renderBOL, renderPackingSlip, renderCommercialInvoice, renderLabels } from '../../warehouse/document-renderer.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPATCH_SUPERVISE_ROLES = ['warehouse_manager', 'inventory_controller'];
const DISPATCH_READ_ROLES = ['store_assistant', 'warehouse_operator', 'warehouse_manager', 'inventory_controller'];

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

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
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

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[], functionScope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) => (r.module === 'warehouse' || r.module === '*') && (functionScope === 'read' || r.functionScope === 'write') && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function warehouseScope(req: IncomingMessage, scope: 'read' | 'write'): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return scope === 'read'
    ? permittedLocationsForModule(authContext.roles, 'warehouse')
    : permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = warehouseScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

async function resolveDispatchOrderSite(dispatchOrderId: string): Promise<string> {
  const status = await getDispatchOrderStatus(dispatchOrderId);
  if (!status) {
    throw new AppError(404, 'DISPATCH_ORDER_NOT_FOUND', `No dispatch order exists for "${dispatchOrderId}"`);
  }
  return status.site_id;
}

function parsePackingLines(body: Record<string, unknown>): Array<{
  sku: string;
  packed_qty: string;
  lot_id: string;
  carton_count: number;
  actual_weight_kg: number | null;
}> {
  const lines = body['packingLines'] ?? body['packing_lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'packingLines is required and must be a non-empty array');
  }
  return lines.map((line, idx) => {
    if (typeof line !== 'object' || line === null) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}] must be an object`);
    }
    const obj = line as Record<string, unknown>;
    const sku = obj['sku'];
    const packedQty = obj['packed_qty'] ?? obj['packedQty'];
    const lotId = obj['lot_id'] ?? obj['lotId'];
    const cartonCount = obj['carton_count'] ?? obj['cartonCount'];
    const actualWeightKg = obj['actual_weight_kg'] ?? obj['actualWeightKg'];

    if (typeof sku !== 'string' || !sku.trim()) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}].sku is required and must be a non-empty string`);
    }
    if (typeof packedQty !== 'string' || !packedQty.trim()) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}].packed_qty is required and must be a non-empty string`);
    }
    if (typeof lotId !== 'string' || !UUID_REGEX.test(lotId)) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}].lot_id is required and must be a valid UUID`);
    }
    if (typeof cartonCount !== 'number' || !Number.isInteger(cartonCount) || cartonCount < 0) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}].carton_count is required and must be a non-negative integer`);
    }
    if (actualWeightKg !== null && actualWeightKg !== undefined && (typeof actualWeightKg !== 'number' || actualWeightKg < 0)) {
      throw new AppError(400, 'INVALID_PARAMS', `packingLines[${idx}].actual_weight_kg must be null or a non-negative number`);
    }

    return {
      sku: sku.trim(),
      packed_qty: packedQty.trim(),
      lot_id: lotId,
      carton_count: cartonCount,
      actual_weight_kg: actualWeightKg === null || actualWeightKg === undefined ? null : Number(actualWeightKg),
    };
  });
}

export const postPacked: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_SUPERVISE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const dispatchOrderId = b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId is required and must be a valid UUID');
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const packingLines = parsePackingLines(b);
  const eventId = randomUUID();
  const auditCtx = auditCtxFor(req, actor, 200);

  try {
    await persistEvent({
      stream_type: 'warehouse',
      stream_id: dispatchOrderId,
      event_type: 'dispatch.packed',
      payload: {
        dispatch_order_id: dispatchOrderId,
        packed_by: actor.userId,
        packing_lines: packingLines,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    }, auditCtx);

    sendJson(res, 200, {
      eventId,
      dispatchOrderId,
      packedBy: actor.userId,
      packingLines,
    });
  } catch (err) {
    throw err;
  }
};

export const postShippingDocumentsGenerated: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_SUPERVISE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const dispatchOrderId = b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId is required and must be a valid UUID');
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const eventId = randomUUID();
  const auditCtx = auditCtxFor(req, actor, 200);

  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const bolContent = await renderBOL(dispatchOrderId, client);
      const packingSlipContent = await renderPackingSlip(dispatchOrderId, client);
      const commercialInvoiceContent = await renderCommercialInvoice(dispatchOrderId, client);
      const labels = await renderLabels(dispatchOrderId, client);

      await persistEvent({
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'dispatch.shipping_documents_generated',
        payload: {
          dispatch_order_id: dispatchOrderId,
          generated_by: actor.userId,
          bill_of_lading: bolContent,
          packing_slip: packingSlipContent,
          commercial_invoice: commercialInvoiceContent,
          shipping_labels: labels,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      }, auditCtx);

      sendJson(res, 200, {
        eventId,
        dispatchOrderId,
        generatedBy: actor.userId,
        billOfLading: bolContent,
        packingSlip: packingSlipContent,
        commercialInvoice: commercialInvoiceContent,
        shippingLabels: labels,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    throw err;
  }
};

export const postDispatched: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_SUPERVISE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const dispatchOrderId = b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId is required and must be a valid UUID');
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const eventId = randomUUID();
  const auditCtx = auditCtxFor(req, actor, 200);

  try {
    await persistEvent({
      stream_type: 'warehouse',
      stream_id: dispatchOrderId,
      event_type: 'dispatch.dispatched',
      payload: {
        dispatch_order_id: dispatchOrderId,
        dispatched_by: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    }, auditCtx);

    sendJson(res, 200, {
      eventId,
      dispatchOrderId,
      dispatchedBy: actor.userId,
    });
  } catch (err) {
    throw err;
  }
};

export const getPackingRecords: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const dispatchOrderId = params['dispatchOrderId'];
  if (!dispatchOrderId || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId parameter is required and must be a valid UUID');
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'read');

  const records = await listPackingRecordsByDispatchOrder(dispatchOrderId);
  sendJson(res, 200, { dispatchOrderId, packingRecords: records });
};

export const getDispatchDocuments: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const dispatchOrderId = params['dispatchOrderId'];
  if (!dispatchOrderId || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId parameter is required and must be a valid UUID');
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'read');

  const documents = await listDocumentsByDispatchOrder(dispatchOrderId);
  sendJson(res, 200, { dispatchOrderId, documents });
};

export const getPackingRecord: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const packingRecordId = params['packingRecordId'];
  if (!packingRecordId || !UUID_REGEX.test(packingRecordId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'packingRecordId parameter is required and must be a valid UUID');
  }

  const record = await getPackingRecordById(packingRecordId);
  if (!record) {
    throw new AppError(404, 'PACKING_RECORD_NOT_FOUND', `Packing record ${packingRecordId} not found`);
  }

  const siteId = await resolveDispatchOrderSite(record.dispatch_order_id);
  assertSiteAccess(req, siteId, 'read');

  sendJson(res, 200, record);
};

export const getDispatchOrderStatusHandler: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const dispatchOrderId = params['dispatchOrderId'];
  if (!dispatchOrderId || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'dispatchOrderId parameter is required and must be a valid UUID');
  }

  const status = await getDispatchOrderStatus(dispatchOrderId);
  if (!status) {
    throw new AppError(404, 'DISPATCH_ORDER_NOT_FOUND', `Dispatch order ${dispatchOrderId} not found`);
  }

  const siteId = status.site_id;
  assertSiteAccess(req, siteId, 'read');

  sendJson(res, 200, status);
};