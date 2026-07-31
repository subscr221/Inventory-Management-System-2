import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import {
  permittedLocationsForModule,
  permittedLocationsForModuleScope,
} from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getDispatchOrderStatus } from '../../read/projections/dispatch_order_status.js';
import {
  getPackingRecordById,
  listPackingRecordsByDispatchOrder,
} from '../../read/projections/packing_record.js';
import {
  listDocumentsByDispatchOrder,
  getDocumentById,
} from '../../read/projections/dispatch_document.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_TYPES = ['bol', 'packing_slip', 'commercial_invoice', 'label'];
// Task 6.2: Pack and dispatch confirmation: dispatch_clerk, warehouse_manager.
// Document generation and read: dispatch_clerk, warehouse_manager, inventory_controller.
// Read-only document access: store_assistant, warehouse_operator.
// Read access spans BOTH the read-only roles and every role that writes (a role that can pack,
// generate documents, or dispatch must also be able to read back what it just created).
const DISPATCH_WRITE_ROLES = ['dispatch_clerk', 'warehouse_manager'];
const DISPATCH_DOC_WRITE_ROLES = ['dispatch_clerk', 'warehouse_manager', 'inventory_controller'];
const DISPATCH_READ_ROLES = [
  'store_assistant',
  'warehouse_operator',
  'dispatch_clerk',
  'warehouse_manager',
  'inventory_controller',
];

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

function assertRoleAllowed(
  req: IncomingMessage,
  allowedRoles: string[],
  functionScope: 'read' | 'write',
): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) =>
      (r.module === 'warehouse' || r.module === '*') &&
      (functionScope === 'read' || r.functionScope === 'write') &&
      allowedRoles.includes(r.role),
  );
  if (!ok)
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${allowedRoles.join(', ')}`,
    );
}

function warehouseScope(
  req: IncomingMessage,
  scope: 'read' | 'write',
): { wildcard: boolean; locations: Set<string> } {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return scope === 'read'
    ? permittedLocationsForModule(authContext.roles, 'warehouse')
    : permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const s = warehouseScope(req, scope);
  if (!s.wildcard && !s.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No ${scope} assignment grants access to site "${siteId}"`,
    );
  }
}

async function resolveDispatchOrderSite(dispatchOrderId: string): Promise<string> {
  const status = await getDispatchOrderStatus(dispatchOrderId);
  if (!status) {
    throw new AppError(
      404,
      'DISPATCH_ORDER_NOT_FOUND',
      `No dispatch order exists for "${dispatchOrderId}"`,
    );
  }
  return status.site_id;
}

function parsePackingLines(body: Record<string, unknown>): Array<{
  sku: string;
  packed_qty: string;
  lot_id: string;
  carton_count: number;
  actual_weight_kg: number | null;
  label_ref: string | null;
}> {
  const lines = body['packingLines'] ?? body['packing_lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'packingLines is required and must be a non-empty array',
    );
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
    const labelRef = obj['label_ref'] ?? obj['labelRef'];

    if (typeof sku !== 'string' || !sku.trim()) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].sku is required and must be a non-empty string`,
      );
    }
    if (typeof packedQty !== 'string' || !packedQty.trim()) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].packed_qty is required and must be a non-empty string`,
      );
    }
    if (typeof lotId !== 'string' || !UUID_REGEX.test(lotId)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].lot_id is required and must be a valid UUID`,
      );
    }
    if (typeof cartonCount !== 'number' || !Number.isInteger(cartonCount) || cartonCount < 0) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].carton_count is required and must be a non-negative integer`,
      );
    }
    if (
      actualWeightKg !== null &&
      actualWeightKg !== undefined &&
      (typeof actualWeightKg !== 'number' || actualWeightKg < 0)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].actual_weight_kg must be null or a non-negative number`,
      );
    }
    if (labelRef !== undefined && labelRef !== null && typeof labelRef !== 'string') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `packingLines[${idx}].label_ref must be a string or null`,
      );
    }

    return {
      sku: sku.trim(),
      packed_qty: packedQty.trim(),
      lot_id: lotId,
      carton_count: cartonCount,
      actual_weight_kg:
        actualWeightKg === null || actualWeightKg === undefined ? null : Number(actualWeightKg),
      label_ref: labelRef === undefined || labelRef === null ? null : String(labelRef),
    };
  });
}

export const postPacked: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_WRITE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
  const dispatchOrderId =
    params['dispatchOrderId'] ?? b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId is required and must be a valid UUID',
    );
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const packingLines = parsePackingLines(b);

  // Pre-validate the aggregate of every line in this call against the order's total confirmed
  // pick quantity BEFORE persisting any event, so a doomed multi-line request fails fast instead
  // of leaving earlier lines committed while a later line is rejected.
  const pool = getPool();
  const qtyResult = await pool.query(
    `SELECT COALESCE(SUM(pl.confirmed_quantity)::numeric, 0) AS total_confirmed
     FROM pick_line pl
     WHERE pl.dispatch_order_line_id IN (
       SELECT id FROM erp_sales_order WHERE id = $1
     )
     AND pl.status IN ('confirmed', 'substituted')`,
    [dispatchOrderId],
  );
  const packedResult = await pool.query(
    `SELECT COALESCE(SUM(packed_qty)::numeric, 0) AS already_packed
     FROM packing_record WHERE dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  const totalConfirmed = Number(qtyResult.rows[0].total_confirmed);
  const alreadyPacked = Number(packedResult.rows[0].already_packed);
  const requestedTotal = packingLines.reduce((sum, line) => sum + Number(line.packed_qty), 0);
  if (alreadyPacked + requestedTotal > totalConfirmed) {
    throw new AppError(
      400,
      'PACKED_QTY_MISMATCH',
      'Cumulative packed quantity exceeds total confirmed pick quantity',
    );
  }

  const auditCtx = auditCtxFor(req, actor, 200);

  const eventIds: string[] = [];
  for (const line of packingLines) {
    const result = await persistEvent(
      {
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'dispatch.packed',
        payload: {
          packing_record_id: randomUUID(),
          dispatch_order_id: dispatchOrderId,
          sku: line.sku,
          packed_qty: line.packed_qty,
          lot_id: line.lot_id,
          actual_weight_kg:
            line.actual_weight_kg != null ? String(line.actual_weight_kg) : undefined,
          label_ref: line.label_ref ?? undefined,
          carton_count: line.carton_count,
          packed_by: actor.userId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtx,
    );
    eventIds.push(result.event_id);
  }

  sendJson(res, 200, {
    eventIds,
    dispatchOrderId,
    packedBy: actor.userId,
    packingLines,
  });
};

export const postShippingDocumentsGenerated: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_DOC_WRITE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
  const dispatchOrderId =
    params['dispatchOrderId'] ?? b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId is required and must be a valid UUID',
    );
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const docTypes = b['documentTypes'] ?? b['document_types'] ?? DOCUMENT_TYPES;
  const auditCtx = auditCtxFor(req, actor, 200);

  const result = await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: dispatchOrderId,
      event_type: 'dispatch.shipping_documents_generated',
      payload: {
        dispatch_order_id: dispatchOrderId,
        document_types: docTypes,
        generated_by: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtx,
  );

  const documents = await listDocumentsByDispatchOrder(dispatchOrderId);
  const documentIds = documents.map((d) => d.document_id);

  sendJson(res, 200, {
    eventId: result.event_id,
    dispatchOrderId,
    generatedBy: actor.userId,
    documentIds,
  });
};

export const postDispatched: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  assertRoleAllowed(req, DISPATCH_WRITE_ROLES, 'write');

  const body = await getParsedBody(req);
  const b = body as Record<string, unknown>;
  const params = (req as unknown as { params?: Record<string, string> }).params ?? {};
  const dispatchOrderId =
    params['dispatchOrderId'] ?? b['dispatchOrderId'] ?? b['dispatch_order_id'];
  if (typeof dispatchOrderId !== 'string' || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId is required and must be a valid UUID',
    );
  }

  const siteId = await resolveDispatchOrderSite(dispatchOrderId);
  assertSiteAccess(req, siteId, 'write');

  const auditCtx = auditCtxFor(req, actor, 200);

  const result = await persistEvent(
    {
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
    },
    auditCtx,
  );

  sendJson(res, 200, {
    eventId: result.event_id,
    dispatchOrderId,
    dispatchedBy: actor.userId,
  });
};

export const getPackingRecords: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const dispatchOrderId = params['dispatchOrderId'];
  if (!dispatchOrderId || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId parameter is required and must be a valid UUID',
    );
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
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId parameter is required and must be a valid UUID',
    );
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
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'packingRecordId parameter is required and must be a valid UUID',
    );
  }

  const record = await getPackingRecordById(packingRecordId);
  if (!record) {
    throw new AppError(
      404,
      'PACKING_RECORD_NOT_FOUND',
      `Packing record ${packingRecordId} not found`,
    );
  }

  const siteId = await resolveDispatchOrderSite(record.dispatch_order_id);
  assertSiteAccess(req, siteId, 'read');

  sendJson(res, 200, record);
};

export const getDispatchOrderStatusHandler: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const dispatchOrderId = params['dispatchOrderId'];
  if (!dispatchOrderId || !UUID_REGEX.test(dispatchOrderId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'dispatchOrderId parameter is required and must be a valid UUID',
    );
  }

  const status = await getDispatchOrderStatus(dispatchOrderId);
  if (!status) {
    throw new AppError(
      404,
      'DISPATCH_ORDER_NOT_FOUND',
      `Dispatch order ${dispatchOrderId} not found`,
    );
  }

  const siteId = status.site_id;
  assertSiteAccess(req, siteId, 'read');

  sendJson(res, 200, status);
};

export const getDispatchDocument: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, DISPATCH_READ_ROLES, 'read');

  const documentId = params['documentId'];
  if (!documentId || !UUID_REGEX.test(documentId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'documentId parameter is required and must be a valid UUID',
    );
  }

  const document = await getDocumentById(documentId);
  if (!document) {
    throw new AppError(
      404,
      'DISPATCH_DOCUMENT_NOT_FOUND',
      `Dispatch document ${documentId} not found`,
    );
  }

  const siteId = await resolveDispatchOrderSite(document.dispatch_order_id);
  assertSiteAccess(req, siteId, 'read');

  sendJson(res, 200, document);
};
