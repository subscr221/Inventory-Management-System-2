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
