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
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { PersistedEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getItemById } from '../../read/projections/item_master.js';
import {
  getProductionOrderById,
  listProductionOrders,
  type ProductionOrderRow,
} from '../../read/projections/production_order.js';
import { evaluateReleaseGate, type ReleaseGateResult } from '../../production/release-gate.js';
import { resolveApprover } from './indents.js';
// Story 6.4: the genealogy service and the closure-written variance report (FR-MO-11, FR-B-08).
import { getLotGenealogy } from '../../production/lot-genealogy.js';
import { getCompletionByLotId } from '../../read/projections/production_completion.js';
import { listConsumptionVarianceByOrder } from '../../read/projections/production_consumption_variance.js';

/**
 * Story 6.1 REST surface: production order creation, read, the release-gate dry run, release,
 * transition and cancel (FR-MO-01/02/03).
 *
 * All decisions live in src/compliance/production-order.ts, not here, so a direct
 * POST /api/v1/events cannot bypass them (AD-12); these handlers own only the capture-time
 * resolutions (server-minted ids, actor stamping, the pre-run of the release gate so the release
 * payload can declare the derived revision id) and the response shape. The seam re-runs every rule
 * inside its transaction - removing a handler check must never change what is possible through the
 * direct-event path.
 *
 * AC7 (a non-approver attempting a release override) is the one rule enforced HERE first with an
 * explicit audit-log row, because the rejected attempt never reaches persistEvent and the seam's
 * own audit write cannot cover it. The seam re-checks the same authority on the direct-event path.
 *
 * Location scoping (the Story 4.3 indents precedent): every route asserts the caller's permitted
 * production scope against the order's plant_location_id (read scope for reads/list, write scope
 * for create/release/transition/cancel). A wildcard '*' assignment sees all plants; a scoped
 * assignment is limited to its permitted sites and is refused 403 LOCATION_ACCESS_DENIED elsewhere.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_CHANGE_STATUSES = new Set(['in_process', 'completed', 'closed']);
// Lifecycle Contract (Table 2): the edges the transition route may request.
const STATE_CHANGE_EDGES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['released', new Set(['in_process'])],
  ['in_process', new Set(['completed'])],
  ['completed', new Set(['closed'])],
]);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Location scoping (the Story 4.3 indents precedent): a role assignment carries a location scope,
 * and a plant-scoped production role must not read, release, transition or cancel orders at another
 * plant. The wildcard '*' assignment satisfies any plant. Reads check the 'read' scope; writes
 * (create, release, transition, cancel) check the 'write' scope.
 *
 * Exported for Story 6.2: the material routes in src/api/v1/production-material.ts scope every
 * route against the order's plant_location_id with the same helper, so a plant-scoped operator
 * cannot stage, issue, confirm or return against another plant's order.
 */
export function assertPlantLocationAccess(
  req: IncomingMessage,
  plantLocationId: string,
  functionScope: 'read' | 'write',
): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'production', functionScope);
  if (!scope.wildcard && !scope.locations.has(plantLocationId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No ${functionScope} assignment grants access to plant "${plantLocationId}"`,
    );
  }
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

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

/**
 * A blank or non-string idempotency key is "not supplied": passing '' through would make two
 * genuinely different writes collide on the uq_idempotency row and collapse into one replay of the
 * first (the Story 7.1 review lesson).
 */
function idempotencyKeyFrom(body: Record<string, unknown>): string {
  return typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim() !== ''
    ? body['idempotency_key']
    : randomUUID();
}

/**
 * persistEvent returns ANY event already holding this idempotency key, regardless of stream or
 * event type. A legitimate replay is the same event type carrying the same id field on the SAME
 * stream; anything else means the client reused a key from a different write - surface a 409
 * instead of a phantom 201/200 built from a foreign event's payload (the Story 7.1 review lesson).
 *
 * expectedStreamId is the stable anchor for the order-scoped routes (the URL orderId). On create
 * there is no such anchor: the handler mints a fresh id per request, so a legitimate create replay
 * would fail the comparison. Create therefore omits it and keeps the platform-deferred convention
 * (same-type-different-content reuse returns the original event).
 */
function replayIdOrReject(
  persisted: PersistedEvent,
  expectedEventType: string,
  idField: string,
  expectedStreamId?: string,
): string {
  const value = (persisted.payload as Record<string, unknown> | undefined)?.[idField];
  if (
    persisted.event_type !== expectedEventType ||
    (expectedStreamId !== undefined && persisted.stream_id !== expectedStreamId) ||
    !isUuid(value)
  ) {
    throw new AppError(
      409,
      'DUPLICATE_EVENT',
      'This idempotency key is already in use by a different event',
      {
        existing_event_id: persisted.event_id,
        existing_event_type: persisted.event_type,
        ...(expectedStreamId !== undefined
          ? {
              existing_stream_id: persisted.stream_id,
              requested_stream_id: expectedStreamId,
            }
          : {}),
      },
    );
  }
  return value;
}

/** A path segment that must be a UUID, rejected as 400 rather than looked up as garbage. */
function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`);
  }
  return value;
}

/**
 * AD-16 replay detection: persistEvent short-circuits on a reused idempotency key, but these
 * handlers run state pre-checks (planned-only release, unreversed-transactions cancel) BEFORE
 * persistEvent - a same-key replay of a write that already advanced the order would be rejected by
 * its own pre-check instead of returning the stored result. Look the key up first, scoped to this
 * order, so a legitimate replay returns the current order row while a cross-stream or cross-type
 * reuse still falls through to persistEvent and surfaces 409 DUPLICATE_EVENT.
 */
async function findReplayForOrder(
  orderId: string,
  idempotencyKey: string,
): Promise<PersistedEvent | null> {
  if (!idempotencyKey || idempotencyKey.trim() === '') return null;
  const result = await getPool().query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
       FROM domain_events
      WHERE idempotency_key = $1 AND stream_id = $2::uuid
      LIMIT 1`,
    [idempotencyKey, orderId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;
  const createdAt =
    row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    event_id: row['event_id'] as string,
    stream_type: row['stream_type'] as string,
    stream_id: row['stream_id'] as string,
    event_type: row['event_type'] as string,
    event_version: row['event_version'] as number,
    payload: row['payload'] as Record<string, unknown>,
    metadata: row['metadata'] as PersistedEvent['metadata'],
    schema_version: row['schema_version'] as number,
    idempotency_key: row['idempotency_key'] as string | null,
    created_at: createdAt,
  };
}

async function sendReplayOrNull(
  res: Parameters<RouteHandler>[1],
  orderId: string,
  idempotencyKey: string,
  expectedEventType: string,
): Promise<boolean> {
  const replay = await findReplayForOrder(orderId, idempotencyKey);
  if (!replay) return false;
  const replayedOrderId = replayIdOrReject(
    replay,
    expectedEventType,
    'production_order_id',
    orderId,
  );
  const updated = await getProductionOrderById(replayedOrderId);
  sendJson(res, 200, updated ? orderToJson(updated) : { production_order_id: replayedOrderId });
  return true;
}

function orderToJson(order: ProductionOrderRow): Record<string, unknown> {
  return {
    production_order_id: order.production_order_id,
    order_number_ext: order.order_number_ext,
    output_item_id: order.output_item_id,
    output_sku: order.output_sku,
    order_quantity: order.order_quantity,
    order_uom: order.order_uom,
    plant_location_id: order.plant_location_id,
    bom_id: order.bom_id,
    released_revision_id: order.released_revision_id,
    business_stream: order.business_stream,
    source_reference_type: order.source_reference_type,
    source_reference_id: order.source_reference_id,
    status: order.status,
    expediting_flag: order.expediting_flag,
    override_by: order.override_by,
    override_reason: order.override_reason,
    released_at: order.released_at,
    released_by: order.released_by,
    cancelled_at: order.cancelled_at,
    cancelled_by: order.cancelled_by,
    unreversed_transaction_count: order.unreversed_transaction_count,
    created_by: order.created_by,
    correlation_id: order.correlation_id,
    source_event_id: order.source_event_id,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

function gateToJson(gate: ReleaseGateResult): Record<string, unknown> {
  return {
    revision_id: gate.revision_id,
    business_date: gate.business_date,
    depth_truncated: gate.depth_truncated,
    satisfied: gate.satisfied,
    empty_requirement_set: gate.empty_requirement_set,
    lines: gate.lines.map((line) => ({
      component_item_id: line.component_item_id,
      component_sku: line.component_sku,
      required_quantity: line.required_quantity,
      available_quantity: line.available_quantity,
      shortfall_quantity: line.shortfall_quantity,
      satisfied: line.satisfied,
    })),
  };
}

async function loadOrderOr404(orderId: string): Promise<ProductionOrderRow> {
  const order = await getProductionOrderById(orderId);
  if (!order) {
    throw new AppError(404, 'PRODUCTION_ORDER_NOT_FOUND', 'The production order does not resolve', {
      production_order_id: orderId,
    });
  }
  return order;
}

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders
// ---------------------------------------------------------------------------

const createProductionOrderBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const productionOrderId = randomUUID();
  const now = new Date().toISOString();

  try {
    const outputItemId = body['output_item_id'];
    if (!isUuid(outputItemId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'output_item_id must be a UUID');
    }
    const orderQuantity = body['order_quantity'];
    if (
      typeof orderQuantity !== 'string' ||
      !/^\d{1,12}(\.\d{1,6})?$/.test(orderQuantity) ||
      Number(orderQuantity) <= 0
    ) {
      throw new AppError(
        400,
        'INVALID_ORDER_QUANTITY',
        'order_quantity is required and must be a positive decimal string with at most 6 decimal places',
      );
    }
    const plantLocationId = body['plant_location_id'];
    if (!isUuid(plantLocationId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'plant_location_id must be a UUID');
    }
    assertPlantLocationAccess(req, plantLocationId as string, 'write');
    const bomId = body['bom_id'];
    if (!isUuid(bomId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'bom_id must be a UUID');
    }
    const businessStream =
      typeof body['business_stream'] === 'string' ? body['business_stream'] : '';
    // A blank or missing business_stream is deliberately NOT rejected here: persistEvent's
    // assertInventoryTagging is the single owner of AC1's UNTAGGED_TRANSACTION and must fire on the
    // handler path exactly as it does on the direct-event path (test 8.3 demands both).
    const sourceReferenceType = body['source_reference_type'];
    if (
      typeof sourceReferenceType !== 'string' ||
      !['erp_sales_order', 'indent', 'rd_project', 'manual'].includes(sourceReferenceType)
    ) {
      throw new AppError(
        400,
        'SOURCE_REFERENCE_REQUIRED',
        'source_reference_type is required and must be erp_sales_order, indent, rd_project or manual',
      );
    }
    const sourceReferenceId = body['source_reference_id'];
    if (typeof sourceReferenceId !== 'string' || sourceReferenceId.trim() === '') {
      throw new AppError(
        400,
        'SOURCE_REFERENCE_REQUIRED',
        'source_reference_id is required and must not be blank',
      );
    }

    // The output item supplies the derived fields the payload must declare; the seam re-derives
    // both under lock and rejects a mismatch (PRODUCTION_ORDER_DERIVATION_MISMATCH).
    const item = await getItemById(outputItemId);
    if (!item) {
      throw new AppError(404, 'ITEM_NOT_FOUND', 'The output item does not resolve', {
        output_item_id: outputItemId,
      });
    }

    // A client-supplied order_number_ext is deliberately IGNORED here (Task 5.5 / test 8.3): the
    // seam allocates the number from the sequence. The payload declares an empty string so the
    // applier's write-back is the persisted truth.
    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: productionOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: productionOrderId,
          order_number_ext: '',
          output_item_id: outputItemId,
          output_sku: item.sku,
          order_quantity: orderQuantity,
          order_uom: item.uom,
          plant_location_id: plantLocationId,
          bom_id: bomId,
          business_stream: businessStream.trim(),
          source_reference_type: sourceReferenceType,
          source_reference_id: sourceReferenceId.trim(),
          created_by: actor.userId,
          created_at: now,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKeyFrom(body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    const persistedOrderId = replayIdOrReject(
      persisted,
      'production_order.created',
      'production_order_id',
    );
    const order = await getProductionOrderById(persistedOrderId);
    sendJson(res, 201, order ? orderToJson(order) : { production_order_id: persistedOrderId });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders
// ---------------------------------------------------------------------------

const listProductionOrdersBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = url.searchParams.get('status');
    const plantLocationId = url.searchParams.get('plant_location_id');
    const outputItemId = url.searchParams.get('output_item_id');
    const businessStream = url.searchParams.get('business_stream');
    const limitRaw = url.searchParams.get('limit');
    const offsetRaw = url.searchParams.get('offset');

    if (
      status &&
      !['planned', 'released', 'in_process', 'completed', 'closed', 'cancelled'].includes(status)
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'status is not a valid production order status');
    }
    if (plantLocationId && !isUuid(plantLocationId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'plant_location_id must be a UUID');
    }
    if (outputItemId && !isUuid(outputItemId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'output_item_id must be a UUID');
    }
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    const offset = offsetRaw !== null ? Number(offsetRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit must be an integer between 1 and 200');
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw new AppError(400, 'INVALID_PARAMS', 'offset must be a non-negative integer');
    }

    const authContext = getAuthContext(req);
    if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    const permitted = permittedLocationsForModuleScope(authContext.roles, 'production', 'read');

    const orders = await listProductionOrders({
      status: (status as ProductionOrderRow['status']) ?? undefined,
      plantLocationId: plantLocationId ?? undefined,
      outputItemId: outputItemId ?? undefined,
      businessStream: businessStream ?? undefined,
      permittedPlantLocations: permitted,
      limit,
      offset,
    });
    sendJson(res, 200, { orders: orders.map(orderToJson) });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId
// ---------------------------------------------------------------------------

const getProductionOrderBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');
    sendJson(res, 200, orderToJson(order));
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId/release-gate
// ---------------------------------------------------------------------------

const getReleaseGateBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');
    // Table 3 step 1: the gate runs only on a Planned order; a dry-run on any other state is the
    // same INVALID_STATE_TRANSITION the release path raises.
    if (order.status !== 'planned') {
      throw new AppError(
        400,
        'INVALID_STATE_TRANSITION',
        'The release gate runs only on a planned production order',
        { production_order_id: orderId, status: order.status },
      );
    }
    // A shortfall is a 200 body with satisfied: false, not a 409: the dry run must not fail the
    // read. The delegated error codes (BOM_NOT_FOUND, BOM_ITEM_MISMATCH, RD_EXECUTION_BARRED,
    // BOM_NOT_RELEASED, ...) throw exactly as they do on the release path.
    const gate = await evaluateReleaseGate({
      bom_id: order.bom_id,
      output_item_id: order.output_item_id,
      plant_location_id: order.plant_location_id,
      quantity: order.order_quantity,
      occurred_at: new Date().toISOString(),
    });
    sendJson(res, 200, gateToJson(gate));
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId/consumption-variance
// ---------------------------------------------------------------------------

/**
 * Story 6.4 (FR-B-08): the variance report written by the closure gate. A read-only surface over
 * rows the seam already wrote - the report is never computed here, so two callers can never see two
 * different answers for the same closed order.
 */
const getConsumptionVarianceBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');
    const lines = await listConsumptionVarianceByOrder(orderId);
    sendJson(res, 200, {
      production_order_id: orderId,
      status: order.status,
      // An order that has not closed has no report yet; that is a 200 with an empty list and an
      // explicit flag, not a 404 - the caller asked a legitimate question about a real order.
      computed: lines.length > 0,
      breached_line_count: lines.filter((line) => line.tolerance_breached).length,
      lines,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/lots/:lotId/genealogy
// ---------------------------------------------------------------------------

/**
 * Story 6.4 (FR-MO-11, AC 1): the as-consumed genealogy of one output lot. Registered under the
 * production-orders prefix because the lot's order is what scopes access to it: the caller must
 * hold read scope on the plant that produced the lot, exactly as for the order itself.
 */
const getLotGenealogyBase: RouteHandler = async (req, res, params) => {
  try {
    const lotId = requireUuidParam(params, 'lotId');
    // Authorisation runs on the OWNING ORDER before the genealogy is computed (the code-review
    // 2026-08-31 lesson from the 6.3 rework route, which ran every lookup before authorising and
    // leaked foreign-plant linkage): resolve the lot to its order, authorise, and only then read
    // what the lot consumed. A lot that is not a production output at all is a 404 with no plant to
    // authorise against, which discloses nothing about another plant's work.
    const completion = await getCompletionByLotId(lotId);
    if (!completion) {
      throw new AppError(404, 'OUTPUT_LOT_NOT_FOUND', 'The lot is not a production output lot', {
        lot_id: lotId,
      });
    }
    const order = await loadOrderOr404(completion.production_order_id);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');
    const genealogy = await getLotGenealogy(lotId);
    sendJson(res, 200, genealogy as unknown as Record<string, unknown>);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/release
// ---------------------------------------------------------------------------

const releaseProductionOrderBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);

  try {
    const orderId = requireUuidParam(params, 'orderId');
    // AD-16: a same-key replay of a successful release must return the stored result, not be
    // rejected by the planned-only pre-check below.
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.released')) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    if (order.status !== 'planned') {
      throw new AppError(
        400,
        'INVALID_STATE_TRANSITION',
        'Only a planned production order can be released',
        { production_order_id: orderId, status: order.status },
      );
    }

    // Presence of `override` is what sets expediting_flag; its absence means a shortfall is a hard
    // 409. A blank or missing reason is 400 BEFORE any DOA resolution runs, so a non-approver
    // cannot probe the registry with an empty body (API Contract).
    const override = body['override'];
    const expediting = override !== undefined && override !== null;
    let overrideReason: string | null = null;
    if (expediting) {
      const reason = (override as Record<string, unknown>)?.['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new AppError(
          400,
          'OVERRIDE_REASON_REQUIRED',
          'An expediting release requires a non-blank override_reason',
        );
      }
      overrideReason = reason.trim();
    }

    // AC6 / AC7 (AD-3): the override authority is DOA-resolved, never a hard-coded role.
    let approverActorId: string | null = null;
    if (expediting) {
      const approval = await resolveApprover('production_order.release_override', 0);
      if (!approval.requiresApproval || approval.approverActorId === null) {
        throw new AppError(
          404,
          'APPROVAL_UNRESOLVED',
          'No DOA entry governs production_order.release_override',
          { transaction_type: 'production_order.release_override' },
        );
      }
      if (approval.approverActorId !== actor.userId) {
        // AC7: the rejected attempt never reaches persistEvent, so its audit write cannot cover it.
        // Write the explicit edit-log row on a dedicated pool client (the gate.ts precedent) before
        // throwing.
        const auditClient = await getPool().connect();
        try {
          await logAuditEntry(auditClient, {
            ...auditCtxFor(req, actor, 403),
            event_id: null,
            error_code: 'APPROVAL_REQUIRED',
            details: {
              production_order_id: orderId,
              resolved_approver_user_id: approval.approverActorId,
            },
          });
        } finally {
          auditClient.release();
        }
        throw new AppError(
          403,
          'APPROVAL_REQUIRED',
          'A release override requires the resolved DOA approver',
          { production_order_id: orderId, resolved_approver_user_id: approval.approverActorId },
        );
      }
      approverActorId = approval.approverActorId;
    }

    // The handler pre-runs the gate so the release payload can declare the derived
    // released_revision_id (the seam re-runs it inside the transaction and re-checks everything).
    const gate = await evaluateReleaseGate({
      bom_id: order.bom_id,
      output_item_id: order.output_item_id,
      plant_location_id: order.plant_location_id,
      quantity: order.order_quantity,
      occurred_at: now,
    });
    if (!gate.satisfied && !expediting) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        'Material availability does not cover every component line',
        {
          production_order_id: orderId,
          bom_id: order.bom_id,
          depth_truncated: gate.depth_truncated,
          empty_requirement_set: gate.empty_requirement_set,
          lines: gate.lines.map((line) => ({
            component_item_id: line.component_item_id,
            component_sku: line.component_sku,
            required_quantity: line.required_quantity,
            available_quantity: line.available_quantity,
            shortfall_quantity: line.shortfall_quantity,
            satisfied: line.satisfied,
          })),
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.released',
        payload: {
          production_order_id: orderId,
          released_revision_id: gate.revision_id,
          business_date: gate.business_date,
          expediting_flag: expediting,
          override_by: approverActorId,
          override_reason: overrideReason,
          released_by: actor.userId,
          released_at: now,
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

    const persistedOrderId = replayIdOrReject(
      persisted,
      'production_order.released',
      'production_order_id',
      orderId,
    );
    const updated = await getProductionOrderById(persistedOrderId);
    sendJson(res, 200, updated ? orderToJson(updated) : { production_order_id: persistedOrderId });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/transition
// ---------------------------------------------------------------------------

const transitionProductionOrderBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);

  try {
    const orderId = requireUuidParam(params, 'orderId');
    // AD-16: a same-key replay of an accepted transition returns the stored result, not a
    // INVALID_STATE_TRANSITION from the edge pre-check below.
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.state_changed')) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');

    const newStatus = body['new_status'];
    if (typeof newStatus !== 'string' || !STATE_CHANGE_STATUSES.has(newStatus)) {
      throw new AppError(
        400,
        'INVALID_STATE_TRANSITION',
        'new_status must be one of: in_process, completed, closed',
      );
    }
    // Pre-check the Table 2 edge so a rejected transition returns a clean 400 before any event is
    // written; the seam enforces the same table under lock.
    const allowed = STATE_CHANGE_EDGES.get(order.status);
    if (!allowed || !allowed.has(newStatus)) {
      throw new AppError(400, 'INVALID_STATE_TRANSITION', 'The status transition is not allowed', {
        production_order_id: orderId,
        previous_status: order.status,
        new_status: newStatus,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: orderId,
          previous_status: order.status,
          new_status: newStatus,
          changed_by: actor.userId,
          changed_at: now,
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

    const persistedOrderId = replayIdOrReject(
      persisted,
      'production_order.state_changed',
      'production_order_id',
      orderId,
    );
    const updated = await getProductionOrderById(persistedOrderId);
    sendJson(res, 200, updated ? orderToJson(updated) : { production_order_id: persistedOrderId });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/cancel
// ---------------------------------------------------------------------------

const cancelProductionOrderBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);

  try {
    const orderId = requireUuidParam(params, 'orderId');
    // AD-16: a same-key replay of a successful cancel returns the stored result, not an
    // INVALID_STATE_TRANSITION from the reachability pre-check below.
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.cancelled')) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');

    // AC3 pre-check: cancelled is reachable only from planned or released.
    if (order.status !== 'planned' && order.status !== 'released') {
      throw new AppError(
        400,
        'INVALID_STATE_TRANSITION',
        'Cancellation is only allowed from planned or released',
        { production_order_id: orderId, status: order.status },
      );
    }
    // AC4 pre-check: a released order with unreversed material transactions cannot be cancelled.
    if (order.status === 'released' && order.unreversed_transaction_count > 0) {
      throw new AppError(
        409,
        'UNREVERSED_TRANSACTIONS',
        'The order has unreversed material transactions and cannot be cancelled',
        {
          production_order_id: orderId,
          unreversed_transaction_count: order.unreversed_transaction_count,
        },
      );
    }

    const reasonCode = body['reason_code'];
    if (
      reasonCode !== undefined &&
      reasonCode !== null &&
      (typeof reasonCode !== 'string' || reasonCode.trim() === '')
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'reason_code must be a non-blank string or null');
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.cancelled',
        payload: {
          production_order_id: orderId,
          previous_status: order.status,
          unreversed_transaction_count: order.unreversed_transaction_count,
          cancelled_by: actor.userId,
          cancelled_at: now,
          reason_code: typeof reasonCode === 'string' ? reasonCode : null,
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

    const persistedOrderId = replayIdOrReject(
      persisted,
      'production_order.cancelled',
      'production_order_id',
      orderId,
    );
    const updated = await getProductionOrderById(persistedOrderId);
    sendJson(res, 200, updated ? orderToJson(updated) : { production_order_id: persistedOrderId });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createProductionOrderHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(createProductionOrderBase);

export const listProductionOrdersHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(listProductionOrdersBase);

export const getProductionOrderHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(getProductionOrderBase);

export const getProductionReleaseGateHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(getReleaseGateBase);

export const releaseProductionOrderHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(releaseProductionOrderBase);

export const transitionProductionOrderHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(transitionProductionOrderBase);

export const cancelProductionOrderHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(cancelProductionOrderBase);

export const getConsumptionVarianceHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(getConsumptionVarianceBase);

export const getLotGenealogyHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(getLotGenealogyBase);
