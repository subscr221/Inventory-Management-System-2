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
  JOBWORK_ORDER_CLOSURE_REQUESTED,
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
  CUSTODY_LOSS_RECORDED,
  CUSTODY_RETURN_RECORDED,
  CUSTODY_OFFCUT_RECORDED,
  OFFCUT_DERIVED_FIELDS,
} from '../../compliance/custody-ledger.js';
import {
  JOBWORK_BILLING_FEED_GENERATED,
  JOBWORK_BILLING_FEED_ACKNOWLEDGED,
  GENERATED_DERIVED_FIELDS,
} from '../../compliance/jobwork-billing.js';
import {
  getBillingFeedById,
  listUnacknowledgedBillingFeeds,
} from '../../read/projections/job_work_billing_feed.js';
import { billingFeedRetryWindowElapsed } from '../../adapters/erp/job-work-billing-feed.js';
import { config } from '../../config/index.js';
import {
  listReturnClocksForItc04,
  listDeemedSuppliesForItc04,
  listReturnClocksForAging,
} from '../../read/projections/jobwork_return_clock.js';
import type { JobworkReturnClockReportRow } from '../../read/projections/jobwork_return_clock.js';
import { qtyFromScaled, qtyToScaled } from '../../compliance/custody-statement.js';
import {
  deemedSupplyQty,
  correctChallanClassification,
  isChallanClass,
  CHALLAN_RECLASSIFICATION_ROLES,
} from '../../compliance/jobwork-return-clock.js';
import { toIstCalendarDate, isValidCalendarDate } from '../../lib/business-days.js';
import {
  buildCustodyStatement,
  renderCustodyStatementText,
} from '../../compliance/custody-statement.js';
import { JOBWORK_OUTPUT_RECORDED } from '../../compliance/jobwork-output.js';
import { JOBWORK_OUTPUT_DISPATCHED } from '../../compliance/jobwork-dispatch.js';
import { listJobWorkOutputsByOrder } from '../../read/projections/job_work_output.js';

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
  // Story 9.4: every refusal the loss / output / dispatch seams can raise. LOT_ON_HOLD and
  // JOBWORK_LOSS_REASON_CODE_INVALID are this story's NEW stable error codes; the rest are
  // pre-registered elsewhere in the codebase (APPROVAL_REQUIRED/APPROVAL_UNRESOLVED: Story 6.1/6.3;
  // BOM_NOT_FOUND: Story 9.1; REASON_CODE_REQUIRED: Story 6.3; QC_TASK_MISSING: Story 6.3).
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'LOT_ON_HOLD',
  'JOBWORK_LOSS_REASON_CODE_INVALID',
  'REASON_CODE_REQUIRED',
  'QC_TASK_MISSING',
  // Story 9.5: CUSTODY_NOT_ZERO is this story's NEW stable error code (the AD-6 closure gate); the
  // return route's refusals are all pre-registered above.
  'CUSTODY_NOT_ZERO',
  // Story 9.5 code review (chunks 3/4): the challan-classification correction route's refusals. A
  // coordinator attempting to push its own breach deadline out by two years is the exact attack the
  // segregation-of-duties gate exists to stop, and it previously left no record it was attempted.
  'FUNCTION_ACCESS_DENIED',
  // Story 9.6: OFFCUT_ELECTION_MISSING and BILLING_NOT_READY are this story's NEW stable error
  // codes; SOD_VIOLATION (Story 8.2, quality.ts) is reused for the self-acknowledgment refusal, and
  // a refused self-acknowledgment MUST leave an audit row (Binding decision 17). ITEM_NOT_FOUND and
  // the QC-gate codes reach this file through the retention conversion's QC hand-off.
  'OFFCUT_ELECTION_MISSING',
  'BILLING_NOT_READY',
  'SOD_VIOLATION',
  'ITEM_NOT_FOUND',
  'NOT_FOUND',
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
  'has_contractual_offcut',
  // Story 9.6 Task 0 (Binding decision 16): the contracted offcut rate pair reaches the seam on
  // create and update (optional) and on confirm (mandatory when contractual - the seam's gate).
  'offcut_rate',
  'offcut_currency',
] as const;

/** Story 9.6 Task 0.4: the ORDER_FIELDS the confirm route ALSO accepts (the rest stay refused). */
const CONFIRM_FIELDS: readonly string[] = ['offcut_rate', 'offcut_currency'];

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
      ...ORDER_FIELDS.filter((f) => !CONFIRM_FIELDS.includes(f)),
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
    // mandatory and acts on it. Vocabulary is enforced in the seam's shape assert. Story 9.6 Task 0
    // adds the contracted offcut rate pair beside it, gated identically by the seam.
    const payload: Record<string, unknown> = { service_order_id: serviceOrderId };
    if (body['offcut_election'] !== undefined) payload['offcut_election'] = body['offcut_election'];
    for (const field of CONFIRM_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

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
    idField: 'consumption_id' | 'own_material_id' | 'loss_id' | 'return_id' | 'offcut_id';
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

// ---------------------------------------------------------------------------
// Story 9.4: process loss, job-work output, and QC-gated dispatch (FR-JW-08, FR-JW-11)
// ---------------------------------------------------------------------------

const postServiceOrderLossBase: RouteHandler = (req, res, params) =>
  postCustodyEvent(req, res, params, {
    eventType: CUSTODY_LOSS_RECORDED,
    idField: 'loss_id',
    // over_norm_approved and approved_by are CLAIMS the applier verifies against the DOA registry
    // and then overwrites with what it derived - they are caller fields, not derived ones. The
    // applier refuses a claim on an under-norm loss rather than discarding it silently.
    extraFields: ['reason_code', 'over_norm_approved', 'approved_by'],
    derivedFields: [],
  });

// lot_id is NOT accepted: the lot identity is server-minted (see jobwork-output.ts
// OUTPUT_DERIVED_FIELDS).
const OUTPUT_FIELDS = ['quantity', 'uom'] as const;

const postServiceOrderOutputBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, ['service_order_id', 'recorded_by', 'lot_number', 'lot_id']);
    if (body['service_order_id'] !== undefined && body['service_order_id'] !== serviceOrderId) {
      throw new AppError(400, 'INVALID_PARAMS', 'service_order_id must equal the path id', {
        service_order_id: body['service_order_id'],
        path_service_order_id: serviceOrderId,
      });
    }
    const idempotencyKey = requireIdempotencyKey(body);
    if (body['output_id'] !== undefined && !isUuid(body['output_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'output_id must be a UUID when supplied');
    }
    if (body['site_id'] !== undefined && !isUuid(body['site_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID when supplied');
    }

    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const existing = await getServiceOrderById(serviceOrderId);
    if (!existing && !isRetry) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    if (existing) assertSiteWriteAccess(req, existing.site_id);

    const outputId = (body['output_id'] as string | undefined) ?? randomUUID();
    const payload: Record<string, unknown> = {
      service_order_id: serviceOrderId,
      output_id: outputId,
      site_id: body['site_id'] ?? existing?.site_id ?? null,
      recorded_by: actor.userId,
    };
    for (const field of OUTPUT_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_OUTPUT_RECORDED,
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
    const persistedId = replayIdOrReject(persisted, JOBWORK_OUTPUT_RECORDED, 'output_id');
    const outputs = await listJobWorkOutputsByOrder(serviceOrderId);
    const output = outputs.find((row) => row.output_id === persistedId) ?? null;
    sendJson(res, persistedId === outputId ? 201 : 200, {
      event_id: persisted.event_id,
      output_id: persistedId,
      output,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
        event_type: JOBWORK_OUTPUT_RECORDED,
      });
    }
    sendAppError(req, res, err);
  }
};

const listServiceOrderOutputsBase: RouteHandler = async (req, res, params) => {
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    const order = await readableOrderOr404(req, res, serviceOrderId);
    if (!order) return;
    const outputs = await listJobWorkOutputsByOrder(serviceOrderId);
    sendJson(res, 200, { service_order_id: serviceOrderId, outputs });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const DISPATCH_FIELDS = ['lot_id', 'dispatched_quantity', 'uom'] as const;

const postServiceOrderDispatchBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, ['service_order_id', 'dispatched_by']);
    if (body['service_order_id'] !== undefined && body['service_order_id'] !== serviceOrderId) {
      throw new AppError(400, 'INVALID_PARAMS', 'service_order_id must equal the path id', {
        service_order_id: body['service_order_id'],
        path_service_order_id: serviceOrderId,
      });
    }
    const idempotencyKey = requireIdempotencyKey(body);
    if (body['dispatch_id'] !== undefined && !isUuid(body['dispatch_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'dispatch_id must be a UUID when supplied');
    }
    if (body['site_id'] !== undefined && !isUuid(body['site_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID when supplied');
    }

    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const existing = await getServiceOrderById(serviceOrderId);
    if (!existing && !isRetry) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    if (existing) assertSiteWriteAccess(req, existing.site_id);

    const dispatchId = (body['dispatch_id'] as string | undefined) ?? randomUUID();
    const payload: Record<string, unknown> = {
      service_order_id: serviceOrderId,
      dispatch_id: dispatchId,
      site_id: body['site_id'] ?? existing?.site_id ?? null,
      dispatched_by: actor.userId,
    };
    for (const field of DISPATCH_FIELDS) {
      if (body[field] !== undefined) payload[field] = body[field];
    }

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_OUTPUT_DISPATCHED,
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
    const persistedId = replayIdOrReject(persisted, JOBWORK_OUTPUT_DISPATCHED, 'dispatch_id');
    sendJson(res, persistedId === dispatchId ? 201 : 200, {
      event_id: persisted.event_id,
      dispatch_id: persistedId,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
        event_type: JOBWORK_OUTPUT_DISPATCHED,
      });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Story 9.5: return of customer material, the closure gate, ITC-04 and aging (FR-AC-11, FR-JW-13/14/15)
// ---------------------------------------------------------------------------

const postServiceOrderReturnBase: RouteHandler = (req, res, params) =>
  postCustodyEvent(req, res, params, {
    eventType: CUSTODY_RETURN_RECORDED,
    idField: 'return_id',
    // The delivery challan the material leaves under - mandatory, enforced in the seam's assert.
    extraFields: ['return_challan_number_ext'],
    derivedFields: ['custody_balance_after'],
  });

// ---------------------------------------------------------------------------
// Story 9.6: offcut election execution (FR-JW-09/10) through the EXISTING custody helper. The
// caller never names the branch; the seam re-reads service_order.offcut_election under the order
// lock (Binding decision 1). The challan number, the real-time rate estimate and the settlement
// declaration are caller fields the seam checks per branch; every derived field is refused here.
// ---------------------------------------------------------------------------

const postServiceOrderOffcutBase: RouteHandler = (req, res, params) =>
  postCustodyEvent(req, res, params, {
    eventType: CUSTODY_OFFCUT_RECORDED,
    idField: 'offcut_id',
    // Story 9.6 revised 2026-09-05: capture carries NO branch fields. The disposition, the return
    // challan and the rate all belong to disposal (Story 9.7).
    extraFields: [],
    derivedFields: [...OFFCUT_DERIVED_FIELDS],
  });

/**
 * AC 8: the closure request. Shape-only pre-checks here; the seam re-derives every per-sku custody
 * balance under the order advisory lock and refuses CUSTODY_NOT_ZERO (the hold-bypass lesson), then
 * fires the reserved 9.1 closure transition. requested_by is stamped from the authenticated actor.
 */
const postServiceOrderClosureBase: RouteHandler = async (req, res, params) => {
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
      'requested_by',
      'offcut_election',
      'closed_at',
      'closed_by',
      ...ORDER_FIELDS,
    ]);
    const idempotencyKey = requireIdempotencyKey(body);

    // Story 9.5 code review (chunk 2): the order's site now rides the payload so the applier can
    // re-derive the site gate under its own advisory lock. It is read from the ORDER, never from
    // the request body, which still refuses a caller-supplied site_id above.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const existing = await getServiceOrderById(serviceOrderId);
    if (!existing && !isRetry) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    // Story 9.5 code review (chunks 3/4): site write access is re-checked whenever the order is
    // readable, retry or not - the shape postCustodyEvent uses. Guarding it with `if (!isRetry)` let
    // any jobwork writer replay an idempotency key they already owned to set isRetry, skip the site
    // gate entirely, and receive the order body below. The applier's own site check cannot catch it,
    // because the route feeds the applier the site it just read off that same order row.
    if (existing) assertSiteWriteAccess(req, existing.site_id);
    if (!existing) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    const closureSiteId = existing.site_id;

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_ORDER_CLOSURE_REQUESTED,
        payload: {
          service_order_id: serviceOrderId,
          requested_by: actor.userId,
          site_id: closureSiteId,
        },
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
    // The id comes from the PERSISTED payload, never the path: on a replayed key the stored event is
    // the authority for which order this response describes (the createServiceOrderBase shape).
    // Reading the path id here returned a different order's full body on a cross-order key replay.
    const replayedOrderId = replayIdOrReject(
      persisted,
      JOBWORK_ORDER_CLOSURE_REQUESTED,
      'service_order_id',
    );
    const order = await getServiceOrderById(replayedOrderId);
    if (order) assertSiteWriteAccess(req, order.site_id);
    sendJson(res, 200, { event_id: persisted.event_id, service_order: order });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
        event_type: JOBWORK_ORDER_CLOSURE_REQUESTED,
      });
    }
    sendAppError(req, res, err);
  }
};

/**
 * Site scope for the two report routes: wildcard readers see every site; everyone else sees only
 * their permitted sites, and an explicit ?site_id outside that scope is a 403 (never a silent
 * empty report).
 */
function reportSiteScope(req: IncomingMessage, url: URL): string[] | null {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'jobwork', 'read');
  const requested = url.searchParams.get('site_id');
  if (requested !== null) {
    if (!isUuid(requested)) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID when supplied', {
        site_id: requested,
      });
    }
    if (!scope.wildcard && !scope.locations.has(requested)) {
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No read assignment grants access to site "${requested}"`,
      );
    }
    return [requested];
  }
  if (!scope.wildcard && scope.locations.size === 0) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      'No read assignment grants access to any site',
    );
  }
  return scope.wildcard ? null : [...scope.locations];
}

function requireDateParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || !isValidCalendarDate(value)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `${name} is required and must be a real YYYY-MM-DD calendar date`,
      { [name]: value },
    );
  }
  return value;
}

function outstandingOf(row: JobworkReturnClockReportRow): string {
  return deemedSupplyQty(row.challan_qty, row.reconciled_qty, row.loss_qty);
}

function reportRow(row: JobworkReturnClockReportRow): Record<string, unknown> {
  return {
    clock_id: row.clock_id,
    service_order_id: row.service_order_id,
    order_number_ext: row.order_number_ext,
    order_status: row.order_status,
    customer_party_code: row.customer_party_code,
    customer_name: row.customer_name,
    site_id: row.site_id,
    receipt_id: row.receipt_id,
    challan_number_ext: row.challan_number_ext,
    challan_date: row.challan_date,
    challan_class: row.challan_class,
    sku: row.sku,
    uom: row.uom,
    challan_qty: row.challan_qty,
    received_qty: row.received_qty,
    reconciled_qty: row.reconciled_qty,
    loss_qty: row.loss_qty,
    outstanding_qty: outstandingOf(row),
    status: row.status,
    expiry_date: row.expiry_date,
    days_to_expiry: row.days_to_expiry,
    deemed_supply_qty: row.deemed_supply_qty,
    deemed_supply_recorded_at: row.deemed_supply_recorded_at,
    alert_90_sent_at: row.alert_90_sent_at,
    alert_30_sent_at: row.alert_30_sent_at,
  };
}

function sumQty(
  rows: JobworkReturnClockReportRow[],
  pick: (r: JobworkReturnClockReportRow) => string,
): string {
  return qtyFromScaled(rows.reduce((acc, r) => acc + qtyToScaled(pick(r)), 0n));
}

/**
 * AC 6 (FR-AC-11): the ITC-04 data set for a period, in TWO period-scoped legs. `rows` and `totals`
 * cover every challan DATED in [from, to] with its return-clock accounting (returned or dispatched
 * versus Section 143(5) accounted loss). `deemed_supply_records` and `deemed_supply_totals` cover
 * every deemed supply RECORDED in [from, to], whatever period its challan belongs to (Debug Log 7).
 * The two legs overlap only by coincidence and are never summed together - see
 * listReturnClocksForItc04 for what the single-union version filed twice. Reads ONLY the projection
 * (AD-14).
 */
const getJobworkItc04ReportBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const from = requireDateParam(url, 'from');
    const to = requireDateParam(url, 'to');
    if (to < from) {
      throw new AppError(400, 'INVALID_PARAMS', 'to must be on or after from', { from, to });
    }
    const siteIds = reportSiteScope(req, url);
    const generatedAt = new Date().toISOString();
    const today = toIstCalendarDate(new Date(generatedAt));
    const rows = await listReturnClocksForItc04({ today, from, to, siteIds });
    const deemed = await listDeemedSuppliesForItc04({ today, from, to, siteIds });
    sendJson(res, 200, {
      report: 'ITC-04',
      period: { from, to },
      generated_at: generatedAt,
      business_date: today,
      rows: rows.map(reportRow),
      deemed_supply_records: deemed.map(reportRow),
      totals: {
        challans: new Set(rows.map((r) => `${r.service_order_id}|${r.challan_number_ext}`)).size,
        challan_qty: sumQty(rows, (r) => r.challan_qty),
        reconciled_qty: sumQty(rows, (r) => r.reconciled_qty),
        loss_qty: sumQty(rows, (r) => r.loss_qty),
        outstanding_qty: sumQty(rows, outstandingOf),
      },
      // Kept separate from `totals` on purpose: these rows are selected on when the deemed supply
      // AROSE, so their challan quantities belong to whatever period issued them.
      deemed_supply_totals: {
        records: deemed.length,
        deemed_supply_qty: sumQty(deemed, (r) => r.deemed_supply_qty),
      },
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

/**
 * Story 9.5 code review (chunk 1): correct the challan class of ONE return clock. `challan_class` is
 * optional on the 9.2 receipt payload and defaults to 'input' (Binding decision 7 - fail toward the
 * shorter clock, so a misclassified capital good alerts early rather than late), the receipt is
 * immutable, and no other path can move the clock. Without this route a capital good received
 * without the field would breach at day 365 instead of day 1095 and freeze a deemed supply into
 * ITC-04 two years early, permanently.
 *
 * DISCLOSED DEVIATION: this is a projection-only write with no domain event, so a projection rebuild
 * from the event log would lose the correction - the same shape as the sweep's own alert stamps and
 * breach flip (jobwork_return_clock.sql header). The event-sourced alternative (a
 * jobwork.challan_reclassified event with an applier that also unwinds a premature breach) was
 * weighed and deferred as Story 9.6 scope.
 */
const patchReturnClockClassificationBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  try {
    const clockId = requireUuidParam(params, 'clockId');
    // The list is the SERVER-OWNED field set this route refuses, not an allowlist: challan_class is
    // the one field a caller supplies, everything derived stays derived.
    rejectUnacceptedFields(body, [
      'clock_id',
      'receipt_id',
      'service_order_id',
      'challan_date',
      'expiry_date',
      'status',
      'reconciled_qty',
      'loss_qty',
      'deemed_supply_qty',
      'deemed_supply_recorded_at',
      'site_id',
      // Story 9.5 code review (chunks 3/4): the alert stamps are cleared by this route as a side
      // effect of moving the expiry; a caller supplying them was silently ignored with a 200.
      'alert_90_sent_at',
      'alert_30_sent_at',
      'challan_qty',
      'sku',
      'created_at',
      'updated_at',
    ]);
    // AD-16: a state-changing route requires a client-supplied idempotency key. This one moves a
    // statutory expiry by up to 730 days and clears both alert stamps; a retried request must be
    // identifiable as a retry rather than a second correction.
    requireIdempotencyKey(body);
    const challanClass = (body as Record<string, unknown>)['challan_class'];
    if (!isChallanClass(challanClass)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        "challan_class must be 'input' or 'capital_goods'",
        { challan_class: challanClass ?? null },
      );
    }
    const authContext = getAuthContext(req);
    if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    // The jobwork/write RBAC gate is necessary but not sufficient: reclassifying a statutory clock
    // is a compliance correction, and the coordinator the breach alerts are addressed to must not be
    // able to push its own deadline out by two years.
    // Story 9.5 code review (chunks 3/4): privilege AND scope are both derived from the SAME
    // assignments. Deriving `permitted` from any reclassifying role while taking the site scope from
    // the union of every jobwork/write assignment let a user who is site_head at site A and
    // jobwork_coordinator at site B reclassify site B's clocks - the coordinator pushing out its own
    // deadline, which is precisely what this gate exists to prevent.
    const reclassifyingRoles = authContext.roles.filter(
      (r) =>
        (r.module === 'jobwork' || r.module === '*') &&
        r.functionScope === 'write' &&
        CHALLAN_RECLASSIFICATION_ROLES.has(r.role),
    );
    if (reclassifyingRoles.length === 0) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'Correcting a challan classification requires the compliance officer or site head role',
        { required_roles: [...CHALLAN_RECLASSIFICATION_ROLES] },
      );
    }
    const wildcard = reclassifyingRoles.some((r) => r.locationId === '*');
    const permittedSiteIds = wildcard
      ? null
      : [...new Set(reclassifyingRoles.map((r) => r.locationId))];
    const clock = await correctChallanClassification({
      clockId,
      challanClass,
      permittedSiteIds,
      today: toIstCalendarDate(new Date()),
    });
    sendJson(res, 200, { return_clock: clock });
  } catch (err: unknown) {
    // BSD-5: a refused statutory correction leaves an audit row, like every other route here.
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        clock_id: params?.['clockId'] ?? null,
        challan_class: (body as Record<string, unknown>)['challan_class'] ?? null,
      });
    }
    sendAppError(req, res, err);
  }
};

const AGING_BUCKETS = ['breached', 'due_within_30', 'due_within_90', 'beyond_90'] as const;
type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Bucket by days to expiry; a breached clock is past due regardless of the day count. */
export function agingBucketFor(status: string, daysToExpiry: number): AgingBucket {
  if (status === 'breached' || daysToExpiry < 0) return 'breached';
  if (daysToExpiry <= 30) return 'due_within_30';
  if (daysToExpiry <= 90) return 'due_within_90';
  return 'beyond_90';
}

/**
 * AC 6 (FR-JW-14, SM-34): every clock still carrying exposure, bucketed by days to expiry (or past
 * due), with exact outstanding quantities per bucket. Reads ONLY the projection (AD-14).
 */
const getJobworkAgingReportBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const siteIds = reportSiteScope(req, url);
    const generatedAt = new Date().toISOString();
    const today = toIstCalendarDate(new Date(generatedAt));
    const rows = await listReturnClocksForAging({ today, siteIds });
    const buckets: Record<AgingBucket, { count: number; outstanding_qty: string }> = {
      breached: { count: 0, outstanding_qty: '0.000' },
      due_within_30: { count: 0, outstanding_qty: '0.000' },
      due_within_90: { count: 0, outstanding_qty: '0.000' },
      beyond_90: { count: 0, outstanding_qty: '0.000' },
    };
    const scaled: Record<AgingBucket, bigint> = {
      breached: 0n,
      due_within_30: 0n,
      due_within_90: 0n,
      beyond_90: 0n,
    };
    const out = rows.map((row) => {
      const bucket = agingBucketFor(row.status, row.days_to_expiry);
      buckets[bucket].count += 1;
      scaled[bucket] += qtyToScaled(outstandingOf(row));
      return { ...reportRow(row), bucket };
    });
    for (const bucket of AGING_BUCKETS) {
      buckets[bucket].outstanding_qty = qtyFromScaled(scaled[bucket]);
    }
    sendJson(res, 200, {
      report: 'job-work aging',
      generated_at: generatedAt,
      business_date: today,
      buckets,
      rows: out,
      total_outstanding_qty: sumQty(rows, outstandingOf),
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

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

// ---------------------------------------------------------------------------
// Story 9.6: the ERP billing feed (FR-JW-12). Generation and acknowledgment are closed-shape
// commands with a required idempotency key (#AD-16); the seam re-derives the two BILLING_NOT_READY
// preconditions, the one-feed-per-order collision and the segregation-of-duties check under the
// order advisory lock (the hold-bypass lesson). The reconciliation report is projection-only.
// ---------------------------------------------------------------------------

/**
 * POST /service-orders/:serviceOrderId/billing-feed - generate the ONE feed an order may carry.
 * measured_hours is the only caller field (per_hour price basis, Binding decision 12).
 */
const postServiceOrderBillingFeedBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const serviceOrderId = requireUuidParam(params, 'serviceOrderId');
    rejectUnacceptedFields(body, [
      'service_order_id',
      'site_id',
      'generated_by',
      'status',
      'payload',
      ...GENERATED_DERIVED_FIELDS,
    ]);
    if (body['service_order_id'] !== undefined && body['service_order_id'] !== serviceOrderId) {
      throw new AppError(400, 'INVALID_PARAMS', 'service_order_id must equal the path id');
    }
    const idempotencyKey = requireIdempotencyKey(body);
    if (body['feed_id'] !== undefined && !isUuid(body['feed_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'feed_id must be a UUID when supplied');
    }
    if (body['measured_hours'] !== undefined && typeof body['measured_hours'] !== 'string') {
      throw new AppError(400, 'INVALID_PARAMS', 'measured_hours must be a NUMERIC string', {
        field: 'measured_hours',
      });
    }

    // The 9.5 closure-route shape: a retry of a SUCCESSFUL generation must replay, site write
    // access is re-checked whenever the order is readable, and the order's site rides the payload
    // so the seam can re-derive the site gate under its own lock.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const existing = await getServiceOrderById(serviceOrderId);
    if (!existing && !isRetry) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }
    if (existing) assertSiteWriteAccess(req, existing.site_id);
    if (!existing) {
      throw new AppError(404, 'SERVICE_ORDER_NOT_FOUND', 'Service order not found', {
        service_order_id: serviceOrderId,
      });
    }

    const feedId = (body['feed_id'] as string | undefined) ?? randomUUID();
    const payload: Record<string, unknown> = {
      service_order_id: serviceOrderId,
      feed_id: feedId,
      site_id: existing.site_id,
      generated_by: actor.userId,
      idempotency_key: idempotencyKey,
    };
    if (body['measured_hours'] !== undefined) payload['measured_hours'] = body['measured_hours'];

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: serviceOrderId,
        event_type: JOBWORK_BILLING_FEED_GENERATED,
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
    const persistedFeedId = replayIdOrReject(persisted, JOBWORK_BILLING_FEED_GENERATED, 'feed_id');
    const feed = await getBillingFeedById(persistedFeedId);
    if (feed) assertSiteReadAccess(req, feed.site_id);
    // A replay is not a generation: 200 with the same event_id, the house idiom.
    sendJson(res, persistedFeedId === feedId ? 201 : 200, {
      event_id: persisted.event_id,
      feed_id: persistedFeedId,
      feed,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        service_order_id: params?.['serviceOrderId'] ?? null,
        event_type: JOBWORK_BILLING_FEED_GENERATED,
      });
    }
    sendAppError(req, res, err);
  }
};

/**
 * POST /jobwork/billing-feeds/:feedId/acknowledgment - the INBOUND ERP acknowledgment (Binding
 * decision 8). acknowledged_ref_ext is the ERP document number; acknowledged_by is stamped from the
 * authenticated actor and the seam refuses SOD_VIOLATION when it equals the feed's generated_by.
 */
const postBillingFeedAcknowledgmentBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    const feedId = requireUuidParam(params, 'feedId');
    rejectUnacceptedFields(body, [
      'feed_id',
      'service_order_id',
      'acknowledged_by',
      'acknowledged_at',
      'status',
      'invoiced_at',
    ]);
    const idempotencyKey = requireIdempotencyKey(body);
    if (
      typeof body['acknowledged_ref_ext'] !== 'string' ||
      body['acknowledged_ref_ext'].trim() === ''
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'acknowledged_ref_ext (the ERP document number) is required',
        { field: 'acknowledged_ref_ext' },
      );
    }

    // 404-versus-403 collapse: a feed at a site the caller cannot write is indistinguishable from a
    // missing feed. A retry of a SUCCESSFUL acknowledgment must still replay.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    const feed = await getBillingFeedById(feedId);
    let accessDenied = false;
    if (feed) {
      try {
        assertSiteWriteAccess(req, feed.site_id);
      } catch (err) {
        if (err instanceof AppError && err.errorCode === 'LOCATION_ACCESS_DENIED') {
          accessDenied = true;
        } else {
          throw err;
        }
      }
    }
    if ((!feed || accessDenied) && !isRetry) {
      throw new AppError(404, 'NOT_FOUND', 'Billing feed not found', { feed_id: feedId });
    }
    if (!feed) {
      throw new AppError(404, 'NOT_FOUND', 'Billing feed not found', { feed_id: feedId });
    }
    if (accessDenied) {
      throw new AppError(404, 'NOT_FOUND', 'Billing feed not found', { feed_id: feedId });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: feed.service_order_id,
        event_type: JOBWORK_BILLING_FEED_ACKNOWLEDGED,
        payload: {
          feed_id: feedId,
          service_order_id: feed.service_order_id,
          // The site this route already asserted write access to, carried onto the event so the
          // seam and the central events-door gate can both re-derive it.
          site_id: feed.site_id,
          acknowledged_ref_ext: (body['acknowledged_ref_ext'] as string).trim(),
          acknowledged_by: actor.userId,
        },
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
    const persistedFeedId = replayIdOrReject(
      persisted,
      JOBWORK_BILLING_FEED_ACKNOWLEDGED,
      'feed_id',
    );
    const updated = await getBillingFeedById(persistedFeedId);
    if (updated) assertSiteWriteAccess(req, updated.site_id);
    const order = updated ? await getServiceOrderById(updated.service_order_id) : null;
    sendJson(res, 200, {
      event_id: persisted.event_id,
      feed_id: persistedFeedId,
      feed: updated,
      invoiced_at: order?.invoiced_at ?? null,
      invoiced_feed_id: order?.invoiced_feed_id ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditFailSafe(req, actor, err, {
        feed_id: params?.['feedId'] ?? null,
        event_type: JOBWORK_BILLING_FEED_ACKNOWLEDGED,
      });
    }
    sendAppError(req, res, err);
  }
};

/** Task 8.3: every feed not yet acknowledged, its age against the retry window, its exception flag. */
const getJobworkBillingReconciliationReportBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const siteIds = reportSiteScope(req, url);
    const generatedAt = new Date().toISOString();
    const retryWindowMs = config.jobwork.billingRetryWindowMs;
    const rows = await listUnacknowledgedBillingFeeds({ siteIds });
    const out = rows.map((row) => {
      const ageMs = new Date(generatedAt).getTime() - new Date(row.first_sent_at).getTime();
      return {
        feed_id: row.feed_id,
        service_order_id: row.service_order_id,
        order_number_ext: row.order_number_ext,
        customer_party_code: row.customer_party_code,
        site_id: row.site_id,
        status: row.status,
        exception: row.status === 'exception',
        exception_raised_at: row.exception_raised_at,
        alert_sent_at: row.alert_sent_at,
        first_sent_at: row.first_sent_at,
        age_ms: ageMs,
        retry_window_ms: retryWindowMs,
        retry_window_elapsed: billingFeedRetryWindowElapsed({
          firstSentAt: row.first_sent_at,
          now: generatedAt,
          retryWindowMs,
        }),
        measured_basis: row.measured_basis,
        measured_quantity: row.measured_quantity,
        total_value: row.total_value,
        currency: row.currency,
        // Binding decision 18: billed while output is still open to dispatch is a REPORTING
        // exception, never a blocked write.
        open_to_dispatch_qty: row.open_to_dispatch_qty,
        open_to_dispatch: qtyToScaled(row.open_to_dispatch_qty) > 0n,
        idempotency_key: row.idempotency_key,
        generated_by: row.generated_by,
      };
    });
    sendJson(res, 200, {
      report: 'job-work billing reconciliation',
      generated_at: generatedAt,
      retry_window_ms: retryWindowMs,
      counts: {
        pending: out.filter((r) => r.status === 'pending').length,
        exception: out.filter((r) => r.status === 'exception').length,
        open_to_dispatch: out.filter((r) => r.open_to_dispatch).length,
      },
      rows: out,
    });
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

export const postServiceOrderLossHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderLossBase);

export const postServiceOrderOutputHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderOutputBase);

export const listServiceOrderOutputsHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(listServiceOrderOutputsBase);

export const postServiceOrderDispatchHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderDispatchBase);

export const postServiceOrderReturnHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderReturnBase);

export const postServiceOrderClosureHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderClosureBase);

export const patchReturnClockClassificationHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(patchReturnClockClassificationBase);

export const getJobworkItc04ReportHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getJobworkItc04ReportBase);

export const getJobworkAgingReportHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getJobworkAgingReportBase);

export const postServiceOrderOffcutHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderOffcutBase);

export const postServiceOrderBillingFeedHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postServiceOrderBillingFeedBase);

export const postBillingFeedAcknowledgmentHandler = requireRole({
  module: 'jobwork',
  functionScope: 'write',
})(postBillingFeedAcknowledgmentBase);

export const getJobworkBillingReconciliationReportHandler = requireRole({
  module: 'jobwork',
  functionScope: 'read',
})(getJobworkBillingReconciliationReportBase);
