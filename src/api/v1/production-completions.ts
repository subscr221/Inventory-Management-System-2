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
import type { PersistedEvent } from '../../events/store.js';
import { logAuditEntry, type AuditEntryPayload } from '../../read/projections/audit_log.js';
import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import {
  getProductionOrderById,
  type ProductionOrderRow,
} from '../../read/projections/production_order.js';
import {
  listCompletionsByOrder,
  getCompletedPrimaryQuantity,
} from '../../read/projections/production_completion.js';
import { listScrapDeclarationsByOrder } from '../../read/projections/production_scrap_declaration.js';
import { getWipSummary } from '../../read/projections/production_wip_ledger.js';
import { resolveCompletionTolerance } from '../../production/completion-outputs.js';
import {
  resolveReworkRequest,
  assertNoReworkOrderYet,
  deriveReworkOrder,
} from '../../production/rework-order.js';
import { assertPlantLocationAccess } from './production-orders.js';
import { config } from '../../config/index.js';

/**
 * Story 6.3 REST surface: production completions with their co-product and by-product lots, process
 * scrap declarations, the close-short decision and the linked rework order (FR-MO-07/08/09/10).
 *
 * All decisions live in src/compliance/production-completion.ts (and, for the rework linkage, in
 * src/compliance/production-order.ts), not here, so a direct POST /api/v1/events cannot bypass them
 * (AD-12); these handlers own only the capture-time resolutions and the response shape. The seam
 * re-runs every rule inside its transaction - removing a handler check must never change what is
 * possible through the direct-event path.
 *
 * Every accepted write persists through persistEvent WITH the audit context, so each completion,
 * scrap declaration, close-short decision and rework-order creation lands in the statutory edit log
 * (FR-AC-13). AC5 additionally requires the BLOCKED over-completion attempt to be visible, so the
 * permanent rejections listed in AUDITED_REJECTIONS are written to the edit log too.
 *
 * Two decisions carry a DOA approval chain, both enforced in the seam and not here: an
 * over-completion (AC5) and, since the 2026-08-31 code review, a close-short decision (AC6). Both
 * require the ACTING user to be the resolved approver, so a named-but-not-acting approver cannot be
 * forged on the direct-event path.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;

/**
 * The permanent rejections worth an edit-log row. A blocked over-completion (AC5) is the
 * load-bearing one: "the attempt is written to the edit log" is the whole point of an approval
 * gate, and the Story 6.1 release-override precedent audits the same way.
 */
const AUDITED_REJECTIONS = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'SCRAP_EXCEEDS_WIP',
  'SHORT_CLOSE_NOT_APPLICABLE',
  'SHORT_CLOSE_EXISTS',
  'REWORK_ORDER_EXISTS',
  'LOCATION_ACCESS_DENIED',
  // Story 6.4 (FR-MO-12, AC 4): "the attempt is rejected ... and written to the edit log" is the
  // acceptance criterion itself, so a posting refused against a closed order is audited exactly as
  // a blocked over-completion is.
  'ORDER_CLOSED',
]);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_REGEX.test(value) && Number(value) > 0;
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

async function auditRejectedAttempt(
  req: IncomingMessage,
  actor: ActorContext,
  err: AppError,
  details: Record<string, unknown>,
): Promise<void> {
  // The connect() MUST be inside the try (code review 2026-08-31): a pool-exhaustion rejection
  // escaping this function turns the clean 4xx the caller earned into a 500, which is the exact
  // outcome the catch below exists to prevent.
  let auditClient: PoolClient | null = null;
  try {
    auditClient = await getPool().connect();
    await logAuditEntry(auditClient, {
      ...auditCtxFor(req, actor, err.statusCode),
      event_id: null,
      error_code: err.errorCode,
      details: { ...details, ...(err.details ?? {}) },
    });
  } catch {
    // An audit failure must never turn a clean 4xx into a 500 (AD-17 posture).
  } finally {
    if (auditClient) auditClient.release();
  }
}

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

/** A blank or non-string idempotency key is "not supplied" (the 6.2 convention, verbatim). */
function idempotencyKeyFrom(body: Record<string, unknown>): string {
  return typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim() !== ''
    ? body['idempotency_key']
    : randomUUID();
}

function replayIdOrReject(
  persisted: PersistedEvent,
  expectedEventType: string,
  idField: string,
  expectedStreamId: string,
): string {
  const value = (persisted.payload as Record<string, unknown> | undefined)?.[idField];
  if (
    persisted.event_type !== expectedEventType ||
    persisted.stream_id !== expectedStreamId ||
    !isUuid(value)
  ) {
    throw new AppError(
      409,
      'DUPLICATE_EVENT',
      'This idempotency key is already in use by a different event',
      {
        existing_event_id: persisted.event_id,
        existing_event_type: persisted.event_type,
        existing_stream_id: persisted.stream_id,
        requested_stream_id: expectedStreamId,
      },
    );
  }
  return value;
}

function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`);
  }
  // Lower-cased because UUID_REGEX is case-insensitive while PostgreSQL returns uuid columns
  // lower-cased (code review 2026-08-31). Comparing the raw path segment against the persisted
  // stream_id let an upper-case path COMMIT the completion and then answer 409.
  return value.toLowerCase();
}

/** AD-16 replay detection scoped to this order (the 6.2 findReplayForOrder, verbatim). */
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
  replayIdOrReject(replay, expectedEventType, 'production_order_id', orderId);
  sendJson(res, 200, replay.payload as Record<string, unknown>);
  return true;
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

/** Binding Decision 12 pre-check: nothing is produced until the order is actually running. */
function assertInProcess(order: ProductionOrderRow): void {
  // Story 6.4 (FR-MO-12, AC 4): the handler MIRRORS the seam's ORDER_CLOSED branch, so the REST
  // surface reports the specific code rather than the generic state rejection below.
  if (order.status === 'closed') {
    throw new AppError(
      409,
      'ORDER_CLOSED',
      'The production order is closed and accepts no further postings or edits',
      { production_order_id: order.production_order_id, status: order.status },
    );
  }
  if (order.status !== 'in_process') {
    throw new AppError(
      400,
      'INVALID_STATE_TRANSITION',
      'Completions, scrap declarations and close-short decisions require the order to be in_process',
      { production_order_id: order.production_order_id, status: order.status },
    );
  }
}

function reasonCodeOrThrow(
  body: Record<string, unknown>,
  allowed: string[],
  invalidCode: string,
  orderId: string,
): string {
  const raw = body['reason_code'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError(400, 'REASON_CODE_REQUIRED', 'A non-blank reason_code is required', {
      production_order_id: orderId,
    });
  }
  const trimmed = raw.trim();
  if (!allowed.includes(trimmed)) {
    throw new AppError(422, invalidCode, 'The reason code is not a configured reason', {
      production_order_id: orderId,
      reason_code: trimmed,
      allowed,
    });
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/completions   (AC 1, AC 2, AC 3, AC 5)
// ---------------------------------------------------------------------------

const postCompletionBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);
  let orderId = '';

  try {
    orderId = requireUuidParam(params, 'orderId');
    // Authorisation BEFORE the replay short-circuit (code review 2026-08-31): the replay returns a
    // stored payload carrying lot ids, lot numbers and cost postings, so answering it before the
    // plant check let a foreign-plant caller who knew an idempotency key read another plant's
    // completion with no LOCATION_ACCESS_DENIED audit row.
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    if (
      await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.completion_posted')
    ) {
      return;
    }
    assertInProcess(order);

    const primaryQuantity = body['primary_quantity'];
    if (!isPositiveDecimal(primaryQuantity)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'primary_quantity must be a positive decimal string',
      );
    }
    const approvalClaimed = body['over_completion_approved'] === true;
    if (
      body['over_completion_approved'] !== undefined &&
      typeof body['over_completion_approved'] !== 'boolean'
    ) {
      throw new AppError(400, 'INVALID_PARAMS', 'over_completion_approved must be a boolean');
    }
    if (approvalClaimed && !isUuid(body['approved_by'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'approved_by must be a UUID on an approved over-completion',
      );
    }

    // AC5 pre-check for a clean early error; the seam re-settles it under the order lock and owns
    // the DOA chain, so removing this changes nothing about what is possible (AD-12).
    const client = await getPool().connect();
    let tolerance;
    try {
      const prior = await getCompletedPrimaryQuantity(orderId, client);
      tolerance = await resolveCompletionTolerance(
        {
          order_quantity: order.order_quantity,
          prior_completed: prior,
          additional: primaryQuantity,
        },
        client,
      );
    } finally {
      client.release();
    }
    if (tolerance.over && !approvalClaimed) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'The completion exceeds the ordered quantity plus tolerance and needs supervisor approval',
        {
          production_order_id: orderId,
          order_quantity: order.order_quantity,
          cumulative_quantity: tolerance.cumulative,
          ceiling: tolerance.ceiling,
          tolerance_percent: tolerance.tolerance_percent,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.completion_posted',
        payload: {
          production_order_id: orderId,
          primary_quantity: primaryQuantity,
          completed_at:
            typeof body['completed_at'] === 'string' && body['completed_at'].trim() !== ''
              ? body['completed_at']
              : now,
          over_completion_approved: approvalClaimed,
          approved_by: approvalClaimed ? (body['approved_by'] as string) : null,
        },
        metadata: {
          correlation_id: order.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(
      persisted,
      'production_order.completion_posted',
      'production_order_id',
      orderId,
    );
    sendJson(res, 201, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { production_order_id: orderId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId/completions   (AC 1, AC 3)
// ---------------------------------------------------------------------------

const listCompletionsBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');
    const url = new URL(req.url ?? '', 'http://localhost');
    const limitRaw = url.searchParams.get('limit');
    const offsetRaw = url.searchParams.get('offset');
    // Bounds are rejected, not silently reinterpreted (code review 2026-08-31): limit=0 used to
    // return the 50-row default and 201..999 clamped to 200, so a caller could not tell a full page
    // from a truncated one.
    if (limitRaw !== null && (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1)) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit must be an integer between 1 and 200', {
        limit: limitRaw,
      });
    }
    if (limitRaw !== null && Number(limitRaw) > 200) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit must be an integer between 1 and 200', {
        limit: limitRaw,
      });
    }
    if (offsetRaw !== null && !/^\d{1,6}$/.test(offsetRaw)) {
      throw new AppError(400, 'INVALID_PARAMS', 'offset must be a non-negative integer', {
        offset: offsetRaw,
      });
    }
    const completions = await listCompletionsByOrder({
      orderId,
      ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
      ...(offsetRaw !== null ? { offset: Number(offsetRaw) } : {}),
    });
    // Paged on the same window as the completions half (code review 2026-08-31): calling this with
    // no bounds silently truncated at the projection default of 50 while the aggregate quantities
    // in the same response reflected every row.
    const scrap = await listScrapDeclarationsByOrder({
      orderId,
      ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
      ...(offsetRaw !== null ? { offset: Number(offsetRaw) } : {}),
    });
    sendJson(res, 200, {
      production_order_id: orderId,
      order_quantity: order.order_quantity,
      completed_quantity: order.completed_quantity,
      scrapped_quantity: order.scrapped_quantity,
      short_close_reason: order.short_close_reason,
      short_closed_at: order.short_closed_at,
      completions,
      scrap_declarations: scrap,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/scrap-declarations   (AC 4)
// ---------------------------------------------------------------------------

const declareScrapBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);
  let orderId = '';

  try {
    orderId = requireUuidParam(params, 'orderId');
    // Authorisation BEFORE the replay short-circuit (code review 2026-08-31); see the completion
    // handler above.
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.scrap_declared')) {
      return;
    }
    assertInProcess(order);

    const scrapQuantity = body['scrap_quantity'];
    if (!isPositiveDecimal(scrapQuantity)) {
      throw new AppError(400, 'INVALID_PARAMS', 'scrap_quantity must be a positive decimal string');
    }
    const reasonCode = reasonCodeOrThrow(
      body,
      config.production.scrapReasonCodes,
      'SCRAP_REASON_CODE_INVALID',
      orderId,
    );

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.scrap_declared',
        payload: {
          production_order_id: orderId,
          scrap_quantity: scrapQuantity,
          reason_code: reasonCode,
          declared_at:
            typeof body['declared_at'] === 'string' && body['declared_at'].trim() !== ''
              ? body['declared_at']
              : now,
        },
        metadata: {
          correlation_id: order.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(persisted, 'production_order.scrap_declared', 'production_order_id', orderId);
    sendJson(res, 201, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { production_order_id: orderId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/short-close   (AC 6)
// ---------------------------------------------------------------------------

const shortCloseBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const actor = actorContext(req);
  const now = new Date().toISOString();
  const idempotencyKey = idempotencyKeyFrom(body);
  let orderId = '';

  try {
    orderId = requireUuidParam(params, 'orderId');
    // Authorisation BEFORE the replay short-circuit (code review 2026-08-31); see the completion
    // handler above.
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    if (
      await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.short_close_recorded')
    ) {
      return;
    }
    assertInProcess(order);

    const residual = body['residual_disposition'];
    if (residual !== 'returned' && residual !== 'scrapped') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'residual_disposition must be either returned or scrapped',
      );
    }
    const reasonCode = reasonCodeOrThrow(
      body,
      config.production.shortCloseReasonCodes,
      'SHORT_CLOSE_REASON_CODE_INVALID',
      orderId,
    );

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.short_close_recorded',
        payload: {
          production_order_id: orderId,
          reason_code: reasonCode,
          residual_disposition: residual,
          decided_at:
            typeof body['decided_at'] === 'string' && body['decided_at'].trim() !== ''
              ? body['decided_at']
              : now,
        },
        metadata: {
          correlation_id: order.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    replayIdOrReject(
      persisted,
      'production_order.short_close_recorded',
      'production_order_id',
      orderId,
    );
    // Read AFTER the commit but never allowed to fail the response (code review 2026-08-31): the
    // decision is already durable, so a projection read failing here must not answer 500 on work
    // that succeeded. The relief detail is already in the persisted payload.
    let wipSummary: { net_open_quantity: string; net_open_value: string } | null = null;
    try {
      wipSummary = await getWipSummary(orderId);
    } catch {
      wipSummary = null;
    }
    sendJson(res, 201, {
      ...(persisted.payload as Record<string, unknown>),
      net_open_wip_quantity: wipSummary?.net_open_quantity ?? null,
      net_open_wip_value: wipSummary?.net_open_value ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, { production_order_id: orderId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/rework   (AC 7)
// ---------------------------------------------------------------------------

/**
 * Raises the linked rework order for a QC disposition that required rework. The caller supplies
 * ONLY the qc.rework_requested event id: every field of the new order is derived from that event
 * and the item master, so there is nothing a caller can bend to make the rework order describe
 * something other than the rejected lot. The order is created through the ordinary Story 6.1
 * production_order.created contract (Binding Decision 9), which is why its output re-enters the QC
 * gate with no special-casing at all.
 */
const raiseReworkOrderBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const actor = actorContext(req);
  const now = new Date().toISOString();

  try {
    const reworkEventId = body['source_rework_event_id'];
    if (!isUuid(reworkEventId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'source_rework_event_id must be a UUID');
    }
    // Resolve the request and its plant, AUTHORISE, and only then run the checks whose rejections
    // carry identifiers (code review 2026-08-31). The previous order ran resolveReworkRequest,
    // assertNoReworkOrderYet and deriveReworkOrder first, so any single-plant writer could feed
    // event ids to this route and read back foreign-plant NCR linkage, SKUs, item ids and order
    // numbers out of the 404/409 detail payloads.
    const request = await resolveReworkRequest(reworkEventId);
    assertPlantLocationAccess(req, request.site_id, 'write');
    const derived = await deriveReworkOrder(request);
    assertPlantLocationAccess(req, derived.plant_location_id, 'write');
    await assertNoReworkOrderYet(reworkEventId);

    const productionOrderId = randomUUID();
    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: productionOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: productionOrderId,
          order_number_ext: '',
          output_item_id: derived.output_item_id,
          output_sku: derived.output_sku,
          order_quantity: derived.order_quantity,
          order_uom: derived.order_uom,
          plant_location_id: derived.plant_location_id,
          bom_id: derived.bom_id,
          business_stream: derived.business_stream,
          source_reference_type: 'manual',
          source_reference_id: request.ncr_id,
          created_by: actor.userId,
          created_at: now,
          source_rework_event_id: reworkEventId,
          source_lot_id: request.lot_id,
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
      productionOrderId,
    );
    const order = await getProductionOrderById(persistedOrderId);
    sendJson(res, 201, {
      production_order_id: persistedOrderId,
      order_number_ext: order?.order_number_ext ?? null,
      status: order?.status ?? null,
      source_rework_event_id: reworkEventId,
      source_lot_id: request.lot_id,
      source_lot_number: request.lot_number,
      ncr_id: request.ncr_id,
      order_quantity: derived.order_quantity,
      plant_location_id: derived.plant_location_id,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      await auditRejectedAttempt(req, actor, err, {
        source_rework_event_id: body['source_rework_event_id'] ?? null,
      });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const postCompletionHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(postCompletionBase);

export const listCompletionsHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(listCompletionsBase);

export const declareScrapHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(declareScrapBase);

export const shortCloseHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(shortCloseBase);

export const raiseReworkOrderHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(raiseReworkOrderBase);
