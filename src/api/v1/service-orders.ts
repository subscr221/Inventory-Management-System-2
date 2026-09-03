import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent, findEventByIdempotencyKey } from '../../events/store.js';
import { actorContext, auditCtxFor, auditRejectedAttempt, replayIdOrReject } from './quality.js';
import {
  JOBWORK_ORDER_CREATED,
  JOBWORK_ORDER_UPDATED,
  JOBWORK_ORDER_CONFIRMED,
} from '../../compliance/service-order.js';
import { getServiceOrderById, listServiceOrders } from '../../read/projections/service_order.js';
import type { ServiceOrderRow } from '../../read/projections/service_order.js';
import { listJobworkMaterialReceiptsByOrder } from '../../read/projections/jobwork_material_receipt.js';
import {
  listCustodyLedgerByOrder,
  customerCustodyBalancesByOrder,
} from '../../read/projections/custody_ledger_entry.js';
import {
  CUSTODY_CONSUMPTION_POSTED,
  CUSTODY_OWN_MATERIAL_ADDED,
} from '../../compliance/custody-ledger.js';
import {
  buildCustodyStatement,
  renderCustodyStatementText,
} from '../../compliance/custody-statement.js';

/**
 * Story 9.1 REST surface for job-work service orders (FR-JW-01, FR-JW-02, FR-B-16, FR-AC-13).
 * Module `jobwork` on every route. Handler pattern is the compliance.ts idiom: cheap shape
 * pre-checks for a fast 400, then persistEvent - the seam in src/compliance/service-order.ts
 * re-derives every state-machine guard under an advisory lock + FOR UPDATE (the Epic 8
 * hold-bypass lesson), so a direct POST /api/v1/events cannot bypass a transition guard.
 *
 * Only create, update, and confirm are exposed (BSD-2): the in_process transition is fired by
 * Story 9.2's first customer-material receipt and closed only by the Story 9.5 closure gate.
 * Every mutating route requires a client-supplied idempotency key (#AD-16, the 8.7 D8 rule) and
 * goes through the Story 1.3 statutory edit log via persistEvent's auditCtx (BSD-9).
 */

// BSD-5: every refusal code emitted by this file's routes belongs here, or a refused statutory
// decision leaves no audit row (the 8.3 NCR_EXISTS omission lesson). INVALID_STATE_TRANSITION is
// this story's NEW stable error code.
const AUDITED_REJECTIONS = new Set([
  'INVALID_STATE_TRANSITION',
  'SERVICE_ORDER_NOT_FOUND',
  'BOM_NOT_FOUND',
  'LOCATION_NOT_FOUND',
  'DUPLICATE_EVENT',
  'INVALID_PARAMS',
  'LOCATION_ACCESS_DENIED',
  // Story 9.3: every refusal the custody consumption / own-material seam can raise. KIT_LINE_MISMATCH
  // is this story's NEW stable error code; the rest are pre-registered (spine line 337).
  'KIT_LINE_MISMATCH',
  'INSUFFICIENT_STOCK',
  'CROSS_ISSUE_BLOCKED',
  'SOURCE_DOCUMENT_REQUIRED',
  'LOT_NOT_FOUND',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/** Audits a rejection, but never lets an audit failure displace the original AppError. */
async function auditFailSafe(...args: Parameters<typeof auditRejectedAttempt>): Promise<void> {
  try {
    await auditRejectedAttempt(...args);
  } catch (auditErr) {
    console.error('service-orders: audit of a rejected attempt failed:', auditErr);
  }
}

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

function requireBody(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
): Record<string, unknown> | null {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return null;
  }
  return body;
}

/** 8.7 D8: state-changing routes REQUIRE a client-supplied idempotency key (#AD-16). */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = body['idempotency_key'];
  if (typeof key !== 'string' || key.trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'idempotency_key is required', {
      field: 'idempotency_key',
    });
  }
  return key.trim();
}

/** Rejects fields the route does not accept, so a silently-ignored field never returns 200. */
function rejectUnacceptedFields(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (body[field] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', `${field} is not accepted on this route`, {
        field,
      });
    }
  }
}

function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`, { [name]: value ?? null });
  }
  return value;
}

function assertSiteReadAccess(req: IncomingMessage, siteId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'jobwork', 'read');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No read assignment grants access to site "${siteId}"`,
    );
  }
}

function assertSiteWriteAccess(req: IncomingMessage, siteId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'jobwork', 'write');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to site "${siteId}"`,
    );
  }
}

// The change-payload field set shared by create and update; the seam owns deep validation.
const ORDER_FIELDS = [
  'customer_party_code',
  'customer_name',
  'spec_reference_ext',
  'promised_start_date',
  'promised_delivery_date',
  'price_basis',
  'kit_bom_id',
] as const;

// BSD-7 / FR-AC-01: order events carry the governed job-work business stream code.
const JOB_WORK_BUSINESS_STREAM = 'job_work';

const createServiceOrderBase: RouteHandler = async (req, res, _params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    // Server-derived fields must not be asserted by callers (BSD-10: ids are minted here).
    rejectUnacceptedFields(body, [
      'service_order_id',
      'order_number_ext',
      'status',
      'offcut_election',
      'business_stream',
    ]);
    const idempotencyKey = requireIdempotencyKey(body);
    if (!isUuid(body['site_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id is required and must be a UUID');
    }
    assertSiteWriteAccess(req, body['site_id'] as string);

    const serviceOrderId = randomUUID();
    const payload: Record<string, unknown> = {
      service_order_id: serviceOrderId,
      site_id: body['site_id'],
      business_stream: JOB_WORK_BUSINESS_STREAM,
    };
    for (const field of ORDER_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_ORDER_CREATED,
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const persistedId = replayIdOrReject(persisted, JOBWORK_ORDER_CREATED, 'service_order_id');
    const order = await getServiceOrderById(persistedId);
    // A replay is not a creation: 200 with the same event_id, the house idiom.
    sendJson(res, persistedId === serviceOrderId ? 201 : 200, {
      event_id: persisted.event_id,
      service_order: order,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        site_id: typeof body['site_id'] === 'string' ? body['site_id'] : null,
      });
    }
    sendAppError(req, res, err);
  }
};

const updateServiceOrderBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, [
      'service_order_id',
      'order_number_ext',
      'status',
      'offcut_election',
      'business_stream',
      'site_id',
    ]);
    const idempotencyKey = requireIdempotencyKey(body);

    // A retry of a SUCCESSFUL update must replay, not trip the 404/state pre-check afresh.
    // persistEvent is the idempotency authority; this pre-check only makes a genuine first-time
    // rejection cheap (the 8.7 findEventByIdempotencyKey lesson). Site write access is always
    // re-checked, retry or not.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    if (!isRetry) {
      const existing = await getServiceOrderById(serviceOrderId);
      if (!existing) {
        throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
          service_order_id: serviceOrderId,
        });
      }
      assertSiteWriteAccess(req, existing.site_id);
    }

    const payload: Record<string, unknown> = { service_order_id: serviceOrderId };
    for (const field of ORDER_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_ORDER_UPDATED,
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );
    replayIdOrReject(persisted, JOBWORK_ORDER_UPDATED, 'service_order_id');
    const order = await getServiceOrderById(serviceOrderId);
    sendJson(res, 200, { event_id: persisted.event_id, service_order: order });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
      });
    }
    sendAppError(req, res, err);
  }
};

const confirmServiceOrderBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, [
      'service_order_id',
      'order_number_ext',
      'status',
      'business_stream',
      'site_id',
      ...ORDER_FIELDS,
    ]);
    const idempotencyKey = requireIdempotencyKey(body);

    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    if (!isRetry) {
      const existing = await getServiceOrderById(serviceOrderId);
      if (!existing) {
        throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
          service_order_id: serviceOrderId,
        });
      }
      assertSiteWriteAccess(req, existing.site_id);
    }

    // BSD-6: offcut_election is OPTIONAL in 9.1, persisted with no behavior; 9.4 makes it
    // mandatory and acts on it. Vocabulary is enforced in the seam's shape assert.
    const payload: Record<string, unknown> = { service_order_id: serviceOrderId };
    if (body['offcut_election'] !== undefined) payload['offcut_election'] = body['offcut_election'];

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_ORDER_CONFIRMED,
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );
    replayIdOrReject(persisted, JOBWORK_ORDER_CONFIRMED, 'service_order_id');
    const order = await getServiceOrderById(serviceOrderId);
    sendJson(res, 200, { event_id: persisted.event_id, service_order: order });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
      });
    }
    sendAppError(req, res, err);
  }
};

const getServiceOrderBase: RouteHandler = async (req, res, params) => {
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    const order = await getServiceOrderById(serviceOrderId);
    // Existence and access-denial return the identical 404 - a caller without access to the
    // order's site must not be able to distinguish "no such order" from "exists, no access."
    let accessDenied = false;
    if (order) {
      try {
        assertSiteReadAccess(req, order.site_id);
      } catch (err) {
        if (err instanceof AppError && err.errorCode === 'LOCATION_ACCESS_DENIED') {
          accessDenied = true;
        } else {
          throw err;
        }
      }
    }
    if (!order || accessDenied) {
      sendRequestError(req, res, 404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
      return;
    }
    sendJson(res, 200, { service_order: order });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

/**
 * Story 9.2 (AC2, AC3): the customer-material receipts recorded against an order, with the
 * challan and variance fields the Story 9.3 custody statement will render. Same 404-vs-403
 * ordering as GET-by-id (the 9.1 info-leak fix): an order at a site the caller cannot read is
 * indistinguishable from a missing order.
 */
const listServiceOrderReceiptsBase: RouteHandler = async (req, res, params) => {
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    const order = await getServiceOrderById(serviceOrderId);
    let accessDenied = false;
    if (order) {
      try {
        assertSiteReadAccess(req, order.site_id);
      } catch (err) {
        if (err instanceof AppError && err.errorCode === 'LOCATION_ACCESS_DENIED') {
          accessDenied = true;
        } else {
          throw err;
        }
      }
    }
    if (!order || accessDenied) {
      sendRequestError(req, res, 404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
      return;
    }
    const receipts = await listJobworkMaterialReceiptsByOrder(serviceOrderId);
    sendJson(res, 200, { service_order_id: serviceOrderId, receipts });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const listServiceOrdersBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const statusParam = url.searchParams.get('status');
    const validStatuses: ServiceOrderRow['status'][] = [
      'draft',
      'confirmed',
      'in_process',
      'closed',
    ];
    let status: ServiceOrderRow['status'] | undefined;
    if (statusParam) {
      if ((validStatuses as string[]).includes(statusParam)) {
        status = statusParam as ServiceOrderRow['status'];
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

    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
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
    const permittedSites = permittedLocationsForModuleScope(authContext.roles, 'jobwork', 'read');

    const results = await listServiceOrders({
      status,
      customerPartyCode: url.searchParams.get('customer_party_code') ?? undefined,
      siteId: url.searchParams.get('site_id') ?? undefined,
      permittedSites,
      limit,
      offset,
    });
    sendJson(res, 200, { service_orders: results });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Story 9.3: custody ledger and consumption (FR-JW-05, FR-JW-06, FR-JW-07)
// ---------------------------------------------------------------------------

/**
 * Resolves the order for a read route with the 404-versus-403 collapse of GET-by-id: an order at a
 * site the caller cannot read is indistinguishable from a missing order. Returns null after
 * sending the 404.
 */
async function readableOrderOr404(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  serviceOrderId: string,
): Promise<ServiceOrderRow | null> {
  const order = await getServiceOrderById(serviceOrderId);
  let accessDenied = false;
  if (order) {
    try {
      assertSiteReadAccess(req, order.site_id);
    } catch (err) {
      if (err instanceof AppError && err.errorCode === 'LOCATION_ACCESS_DENIED') {
        accessDenied = true;
      } else {
        throw err;
      }
    }
  }
  if (!order || accessDenied) {
    sendRequestError(req, res, 404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
      service_order_id: serviceOrderId,
    });
    return null;
  }
  return order;
}

/** The posting fields a custody write route forwards verbatim; the seam owns deep validation. */
const CUSTODY_POSTING_FIELDS = ['sku', 'lot_id', 'location_id', 'quantity', 'uom'] as const;

/**
 * Shared shape of the two custody write routes: idempotency key required (#AD-16), path id must
 * equal the body's service_order_id, server-derived fields refused, site write access asserted
 * against the ORDER's site, the posting site defaulting to the order's site, posted_by stamped
 * from the authenticated actor. The seam re-derives every gate under the order lock.
 */
async function postCustodyEvent(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  params: Record<string, string> | undefined,
  spec: {
    eventType: string;
    idField: 'consumption_id' | 'own_material_id';
    extraFields: readonly string[];
    derivedFields: readonly string[];
  },
): Promise<void> {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, ['posted_by', 'business_stream', ...spec.derivedFields]);
    if (body['service_order_id'] !== undefined && body['service_order_id'] !== serviceOrderId) {
      throw new AppError(400, 'INVALID_PARAMS', 'service_order_id must equal the path id', {
        service_order_id: body['service_order_id'],
        path_service_order_id: serviceOrderId,
      });
    }
    const idempotencyKey = requireIdempotencyKey(body);
    if (body[spec.idField] !== undefined && !isUuid(body[spec.idField])) {
      throw new AppError(400, 'INVALID_PARAMS', `${spec.idField} must be a UUID when supplied`, {
        field: spec.idField,
      });
    }
    if (body['site_id'] !== undefined && !isUuid(body['site_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID when supplied');
    }

    // A retry of a SUCCESSFUL posting must replay, not trip the 404 pre-check afresh; persistEvent
    // is the idempotency authority (the 8.7 findEventByIdempotencyKey lesson). Site write access
    // is always re-checked against the order's site when the order is readable.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const existing = await getServiceOrderById(serviceOrderId);
    if (!existing && !isRetry) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    if (existing) assertSiteWriteAccess(req, existing.site_id);

    const postingId = (body[spec.idField] as string | undefined) ?? randomUUID();
    const payload: Record<string, unknown> = {
      service_order_id: serviceOrderId,
      [spec.idField]: postingId,
      site_id: body['site_id'] ?? existing?.site_id ?? null,
      posted_by: actor.userId,
    };
    for (const field of [...CUSTODY_POSTING_FIELDS, ...spec.extraFields]) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const persisted = await persistEvent(
      {
        stream_type: 'custody',
        stream_id: serviceOrderId,
        event_type: spec.eventType,
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const persistedId = replayIdOrReject(persisted, spec.eventType, spec.idField);
    const entries = await listCustodyLedgerByOrder(serviceOrderId);
    const entry = entries.find((row) => row.entry_id === persistedId) ?? null;
    // A replay is not a posting: 200 with the same event_id, the house idiom.
    sendJson(res, persistedId === postingId ? 201 : 200, {
      event_id: persisted.event_id,
      [spec.idField]: persistedId,
      entry,
      ...(typeof persisted.payload['custody_balance_after'] === 'string'
        ? { custody_balance_after: persisted.payload['custody_balance_after'] }
        : {}),
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
        event_type: spec.eventType,
      });
    }
    sendAppError(req, res, err);
  }
}

const postServiceOrderConsumptionBase: RouteHandler = (req, res, params) =>
  postCustodyEvent(req, res, params, {
    eventType: CUSTODY_CONSUMPTION_POSTED,
    idField: 'consumption_id',
    extraFields: ['reason_note'],
    derivedFields: [
      'bom_line_id',
      'kit_bom_revision_id',
      'custody_balance_after',
      'supply_source_untagged',
    ],
  });

const postServiceOrderOwnMaterialBase: RouteHandler = (req, res, params) =>
  postCustodyEvent(req, res, params, {
    eventType: CUSTODY_OWN_MATERIAL_ADDED,
    idField: 'own_material_id',
    extraFields: ['bom_line_id'],
    derivedFields: ['kit_bom_revision_id', 'custody_balance_after'],
  });

/** Raw ledger rows in statement order (JSON only). */
const getServiceOrderCustodyLedgerBase: RouteHandler = async (req, res, params) => {
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    const order = await readableOrderOr404(req, res, serviceOrderId);
    if (!order) return;
    const entries = await listCustodyLedgerByOrder(serviceOrderId);
    const closing_balances = await customerCustodyBalancesByOrder(serviceOrderId);
    sendJson(res, 200, {
      service_order_id: serviceOrderId,
      customer_party_code: order.customer_party_code,
      entries,
      closing_balances,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

/**
 * AC 2: the custody statement on demand - JSON canonical, `?format=text` the fixed-width
 * printable rendering (decision 8: a read resource, nothing persisted, no PDF machinery).
 */
const getServiceOrderCustodyStatementBase: RouteHandler = async (req, res, params) => {
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const format = url.searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'text') {
      throw new AppError(400, 'INVALID_PARAMS', 'format must be json or text', { format });
    }
    const order = await readableOrderOr404(req, res, serviceOrderId);
    if (!order) return;
    const entries = await listCustodyLedgerByOrder(serviceOrderId);
    const statement = buildCustodyStatement(order, entries, new Date().toISOString());
    if (format === 'text') {
      const text = renderCustodyStatementText(statement);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text, 'utf-8'),
      });
      res.end(text);
      return;
    }
    sendJson(res, 200, { statement });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

export const createServiceOrderHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(createServiceOrderBase);

export const updateServiceOrderHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(updateServiceOrderBase);

export const confirmServiceOrderHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(confirmServiceOrderBase);

export const getServiceOrderHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getServiceOrderBase);

export const listServiceOrdersHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(listServiceOrdersBase);

export const listServiceOrderReceiptsHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(listServiceOrderReceiptsBase);

export const postServiceOrderConsumptionHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderConsumptionBase);

export const postServiceOrderOwnMaterialHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderOwnMaterialBase);

export const getServiceOrderCustodyLedgerHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getServiceOrderCustodyLedgerBase);

export const getServiceOrderCustodyStatementHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getServiceOrderCustodyStatementBase);
