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
import { logRejectionAudit, type AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  getProductionOrderById,
  type ProductionOrderRow,
} from '../../read/projections/production_order.js';
import {
  listStagesByOrder,
  getStageById,
  type ProductionOrderStageRow,
} from '../../read/projections/production_order_stage.js';
import {
  getPostingById,
  getReturnExceeds,
  getWipSummary,
  listPostingsByOrder,
  type ProductionWipPostingRow,
} from '../../read/projections/production_wip_ledger.js';
import { getInventoryValuation } from '../../read/projections/inventory_valuation.js';
import { getBackflushShortfall } from '../../read/projections/production_wip_ledger.js';
import { resolveMaterialRequirements } from '../../production/material-staging.js';
import { isLocationDescendantOf } from '../../compliance/production-material.js';
import { assertPlantLocationAccess } from './production-orders.js';
import { config } from '../../config/index.js';

/**
 * Story 6.2 REST surface: material staging, issue, production confirmation (backflush), returns,
 * the staging worklist and the real-time WIP ledger (FR-MO-04/05/06).
 *
 * All decisions live in src/compliance/production-material.ts, not here, so a direct
 * POST /api/v1/events cannot bypass them (AD-12); these handlers own only the capture-time
 * resolutions (server-minted ids, actor stamping, the pre-run of the requirement set and the
 * backflush availability check so the caller gets a clean error early) and the response shape.
 * The seam re-runs every rule inside its transaction - removing a handler check must never change
 * what is possible through the direct-event path (AD-12).
 *
 * Every accepted write persists through persistEvent WITH the audit context, so each material
 * event lands in the statutory edit log (FR-AC-13). Idempotency-key handling clones the 6.1
 * convention: a blank key normalizes to "not supplied", the key is computed ONCE per request, and
 * replay detection checks stream_id, not just event_type and UUID-ness (the 6.1 Group B lesson).
 *
 * Location scoping (the Story 4.3 indents precedent): every route asserts the caller's permitted
 * production scope against the order's plant_location_id via the exported
 * assertPlantLocationAccess (read scope for the reads, write scope for the four writes).
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_REGEX = /^\d{1,12}(\.\d{1,6})?$/;

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
 * first (the Story 7.1 review lesson). The key is computed ONCE per request and reused for the
 * replay pre-check AND the persistEvent call.
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
 * instead of a phantom 201/200 built from a foreign event's payload. The stream_id check (the 6.1
 * Group B lesson) closes cross-order idempotency-key reuse for these order-scoped routes.
 */
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
 * handlers run state pre-checks (status gate, availability) BEFORE persistEvent - a same-key
 * replay of a write that already advanced the order would be rejected by its own pre-check instead
 * of returning the stored result. Look the key up first, scoped to this order, so a legitimate
 * replay returns the stored event while a cross-stream or cross-type reuse still falls through to
 * persistEvent and surfaces 409 DUPLICATE_EVENT.
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

/** Sends the stored event for a legitimate same-order replay; returns true when it handled it. */
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

/** Binding Decision 11 pre-check: material flow runs only on released or in_process orders. */
async function assertMaterialState(
  order: { production_order_id: string; status: string },
  auditCtx: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
): Promise<void> {
  // Story 6.4 (FR-MO-12, AC 4): the handler MIRRORS the seam's ORDER_CLOSED branch. Without this
  // the handler's own generic pre-check answered INVALID_STATE_TRANSITION first and the seam's more
  // specific code was unreachable through the REST surface - the rule was enforced but invisible.
  if (order.status === 'closed') {
    // AC 4: the REFUSAL itself is the edit-log entry the acceptance criterion asks for. It never
    // reaches persistEvent, so it is written here on its own client (the Story 6.1 AC7 precedent).
    await logRejectionAudit({
      ...auditCtx,
      http_status: 409,
      event_id: null,
      error_code: 'ORDER_CLOSED',
      details: { production_order_id: order.production_order_id, status: order.status },
    });
    throw new AppError(
      409,
      'ORDER_CLOSED',
      'The production order is closed and accepts no further postings or edits',
      { production_order_id: order.production_order_id, status: order.status },
    );
  }
  if (order.status !== 'released' && order.status !== 'in_process') {
    throw new AppError(
      400,
      'INVALID_STATE_TRANSITION',
      'Material flow requires the order to be released or in_process',
      { production_order_id: order.production_order_id, status: order.status },
    );
  }
}

function stageToJson(stage: ProductionOrderStageRow): Record<string, unknown> {
  return {
    stage_id: stage.stage_id,
    bom_line_id: stage.bom_line_id,
    component_item_id: stage.component_item_id,
    component_sku: stage.component_sku,
    required_quantity: stage.required_quantity,
    issued_quantity: stage.issued_quantity,
    status: stage.status,
    source_location_id: stage.source_location_id,
    lot_number: stage.lot_number,
  };
}

function postingToJson(posting: ProductionWipPostingRow): Record<string, unknown> {
  return {
    posting_id: posting.posting_id,
    posting_type: posting.posting_type,
    bom_line_id: posting.bom_line_id,
    component_item_id: posting.component_item_id,
    component_sku: posting.component_sku,
    lot_number: posting.lot_number,
    source_location_id: posting.source_location_id,
    quantity: posting.quantity,
    open_quantity: posting.open_quantity,
    unit_cost: posting.unit_cost,
    posting_value: posting.posting_value,
    reason_code: posting.reason_code,
    source_posting_id: posting.source_posting_id,
    occurred_at: posting.occurred_at,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/material-staging
// ---------------------------------------------------------------------------

const stageMaterialBase: RouteHandler = async (req, res, params) => {
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
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.material_staged')) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    await assertMaterialState(order, auditCtxFor(req, actor, 409));

    // The handler pre-runs the requirement set so the payload can declare the derived
    // component/quantity triple and the caller gets a clean BOM_REVISION_DRIFT /
    // MATERIAL_REQUIREMENT_SET_TRUNCATED / COMPONENT_SKU_UNRESOLVED / STAGING_LINE_NOT_DIRECTED_ISSUE
    // / STAGING_LOCATION_OUTSIDE_PLANT error early (the seam re-runs everything under lock).
    const requirementSet = await resolveMaterialRequirements({
      order,
      quantity: order.order_quantity,
      supplyMethodFilter: 'directed_issue',
      occurred_at: now,
    });
    const requirementsByLine = new Map(
      requirementSet.lines.map((line) => [line.bom_line_id, line]),
    );

    const rawLines = body['lines'];
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'lines is required and must be a non-empty array');
    }
    const seen = new Set<string>();
    const lines: Record<string, unknown>[] = [];
    for (const raw of rawLines) {
      const line = raw as Record<string, unknown>;
      const bomLineId = line['bom_line_id'];
      const sourceLocationId = line['source_location_id'];
      if (!isUuid(bomLineId))
        throw new AppError(400, 'INVALID_PARAMS', 'bom_line_id must be a UUID');
      if (!isUuid(sourceLocationId)) {
        throw new AppError(400, 'INVALID_PARAMS', 'source_location_id must be a UUID');
      }
      if (seen.has(bomLineId)) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'lines must not name the same bom_line_id more than once',
        );
      }
      seen.add(bomLineId);
      const lotNumber = line['lot_number'];
      if (lotNumber !== undefined && lotNumber !== null && typeof lotNumber !== 'string') {
        throw new AppError(400, 'INVALID_PARAMS', 'lot_number must be a string or null');
      }
      const requirement = requirementsByLine.get(bomLineId);
      if (!requirement) {
        throw new AppError(
          409,
          'STAGING_LINE_NOT_DIRECTED_ISSUE',
          'The staged BOM line is not a directed-issue line of this order',
          { production_order_id: orderId, bom_line_id: bomLineId },
        );
      }
      if (!(await isLocationDescendantOf(order.plant_location_id, sourceLocationId))) {
        throw new AppError(
          409,
          'STAGING_LOCATION_OUTSIDE_PLANT',
          'The staging source bin is not inside the order plant',
          {
            production_order_id: orderId,
            bom_line_id: bomLineId,
            source_location_id: sourceLocationId,
            plant_location_id: order.plant_location_id,
          },
        );
      }
      lines.push({
        bom_line_id: bomLineId,
        component_item_id: requirement.component_item_id,
        component_sku: requirement.component_sku,
        required_quantity: requirement.required_quantity,
        source_location_id: sourceLocationId,
        lot_number: typeof lotNumber === 'string' && lotNumber.trim() !== '' ? lotNumber : null,
        staged_at:
          typeof line['staged_at'] === 'string' && line['staged_at'].trim() !== ''
            ? line['staged_at']
            : now,
      });
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.material_staged',
        payload: {
          production_order_id: orderId,
          revision_id: requirementSet.revision_id,
          business_date: requirementSet.business_date,
          lines,
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

    replayIdOrReject(persisted, 'production_order.material_staged', 'production_order_id', orderId);
    sendJson(res, 201, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId/material-staging
// ---------------------------------------------------------------------------

const listStagingBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');

    const staged = await listStagesByOrder(orderId);
    // The remaining directed-issue requirement lines resolved by a read-only explosion (the
    // release-gate dry-run precedent) so the operator sees the full pick list before posting
    // staging events. Delegated errors (BOM_REVISION_DRIFT, truncation, unresolved SKU) throw
    // exactly as they do on the write path - an unstageable order is a real signal, not a 200.
    const requirementSet = await resolveMaterialRequirements({
      order,
      quantity: order.order_quantity,
      supplyMethodFilter: 'directed_issue',
      occurred_at: new Date().toISOString(),
    });
    const stagedLineIds = new Set(staged.map((s) => s.bom_line_id));
    const pending = requirementSet.lines
      .filter((line) => !stagedLineIds.has(line.bom_line_id))
      .map((line) => ({
        bom_line_id: line.bom_line_id,
        component_item_id: line.component_item_id,
        component_sku: line.component_sku,
        required_quantity: line.required_quantity,
      }));

    sendJson(res, 200, {
      production_order_id: orderId,
      status: order.status,
      revision_id: requirementSet.revision_id,
      business_date: requirementSet.business_date,
      staged: staged.map(stageToJson),
      pending,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/material-issues
// ---------------------------------------------------------------------------

const issueMaterialBase: RouteHandler = async (req, res, params) => {
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
    if (await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.material_issued')) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    await assertMaterialState(order, auditCtxFor(req, actor, 409));

    const stageId = body['stage_id'];
    if (!isUuid(stageId)) throw new AppError(400, 'INVALID_PARAMS', 'stage_id must be a UUID');
    const quantity = body['quantity'];
    if (!isPositiveDecimal(quantity)) {
      throw new AppError(400, 'INVALID_PARAMS', 'quantity must be a positive decimal string');
    }

    const stage = await getStageById(stageId);
    if (!stage) {
      throw new AppError(404, 'STAGE_NOT_FOUND', 'The stage row does not resolve', {
        production_order_id: orderId,
        stage_id: stageId,
      });
    }
    if (stage.production_order_id !== orderId) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'The stage row does not belong to this production order',
        {
          production_order_id: orderId,
          stage_id: stage.stage_id,
          stage_order_id: stage.production_order_id,
        },
      );
    }
    if (stage.status !== 'allocated') {
      throw new AppError(409, 'STAGE_ALREADY_ISSUED', 'The stage row is already fully issued', {
        production_order_id: orderId,
        stage_id: stage.stage_id,
        status: stage.status,
      });
    }
    // ISSUE_EXCEEDS_STAGED pre-check (the seam re-settles it in SQL NUMERIC under lock).
    const remainingResult = await getPool().query(
      `SELECT (required_quantity - issued_quantity)::text AS remaining,
              ($2::numeric > (required_quantity - issued_quantity)) AS exceeds
         FROM production_order_stage WHERE stage_id = $1`,
      [stage.stage_id, quantity],
    );
    if (remainingResult.rows[0]!['exceeds'] === true) {
      throw new AppError(
        409,
        'ISSUE_EXCEEDS_STAGED',
        'The requested issue quantity exceeds the remaining staged quantity',
        {
          production_order_id: orderId,
          stage_id: stage.stage_id,
          requested_quantity: quantity,
          remaining_quantity: String(remainingResult.rows[0]!['remaining']),
        },
      );
    }
    // WIP_COST_UNRESOLVED pre-check (the seam re-checks under lock).
    const valuation = await getInventoryValuation(stage.component_sku);
    if (!valuation || valuation.running_average_cost === null) {
      throw new AppError(
        409,
        'WIP_COST_UNRESOLVED',
        'No priced valuation basis exists for the issued component',
        {
          production_order_id: orderId,
          stage_id: stage.stage_id,
          component_sku: stage.component_sku,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.material_issued',
        payload: {
          production_order_id: orderId,
          stage_id: stage.stage_id,
          quantity,
          issued_by: actor.userId,
          issued_at:
            typeof body['issued_at'] === 'string' && body['issued_at'].trim() !== ''
              ? body['issued_at']
              : now,
          postings: [],
        },
        metadata: {
          correlation_id: order.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );

    replayIdOrReject(persisted, 'production_order.material_issued', 'production_order_id', orderId);
    sendJson(res, 200, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/confirmations
// ---------------------------------------------------------------------------

const recordConfirmationBase: RouteHandler = async (req, res, params) => {
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
    if (
      await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.confirmation_recorded')
    ) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    await assertMaterialState(order, auditCtxFor(req, actor, 409));

    const confirmedQuantity = body['confirmed_quantity'];
    if (!isPositiveDecimal(confirmedQuantity)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'confirmed_quantity must be a positive decimal string',
      );
    }

    // The handler pre-runs the backflush requirement set and the AC3 availability pre-check so the
    // caller gets a clean BOM_REVISION_DRIFT / NO_BACKFLUSH_LINES / INSUFFICIENT_STOCK error
    // early; the seam re-runs everything under lock.
    const requirementSet = await resolveMaterialRequirements({
      order,
      quantity: confirmedQuantity,
      supplyMethodFilter: 'backflush',
      occurred_at: now,
    });
    if (requirementSet.lines.length === 0) {
      throw new AppError(
        409,
        'NO_BACKFLUSH_LINES',
        'The order has no backflush requirements to confirm against',
        { production_order_id: orderId },
      );
    }
    const shortfallLines: Record<string, string>[] = [];
    // AC3 pre-check, aggregated per component SKU (the code-review fix): two backflush lines
    // sharing one SKU must not each pass a per-line probe and then fail the second drain mid-way;
    // the group sum is settled in SQL NUMERIC via the pool, mirroring the seam's pre-check.
    const skuGroups = new Map<string, string[]>();
    for (const line of requirementSet.lines) {
      const list = skuGroups.get(line.component_sku) ?? [];
      list.push(line.required_quantity);
      skuGroups.set(line.component_sku, list);
    }
    for (const [sku, quantities] of skuGroups) {
      const totalResult = await getPool().query(
        `SELECT SUM(v::numeric)::text AS total FROM unnest($1::text[]) AS v`,
        [quantities],
      );
      const probe = await getBackflushShortfall(
        sku,
        order.plant_location_id,
        String(totalResult.rows[0]!['total']),
      );
      if (!probe.satisfied) {
        for (const line of requirementSet.lines) {
          if (line.component_sku !== sku) continue;
          shortfallLines.push({
            component_sku: line.component_sku,
            bom_line_id: line.bom_line_id,
            required_quantity: line.required_quantity,
            available_quantity: probe.available_quantity,
            shortfall_quantity: probe.shortfall_quantity,
          });
        }
      }
    }
    if (shortfallLines.length > 0) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        'Backflush components have insufficient stock to cover the confirmed quantity',
        { production_order_id: orderId, shortfall_lines: shortfallLines },
      );
    }
    // WIP_COST_UNRESOLVED pre-check per backflush SKU (the seam re-checks under lock, resolved
    // before the drain so a missing valuation never follows a stock movement).
    for (const sku of skuGroups.keys()) {
      const valuation = await getInventoryValuation(sku);
      if (!valuation || valuation.running_average_cost === null) {
        throw new AppError(
          409,
          'WIP_COST_UNRESOLVED',
          'No priced valuation basis exists for the backflushed component',
          { production_order_id: orderId, component_sku: sku },
        );
      }
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.confirmation_recorded',
        payload: {
          production_order_id: orderId,
          confirmed_quantity: confirmedQuantity,
          revision_id: requirementSet.revision_id,
          business_date: requirementSet.business_date,
          confirmed_by: actor.userId,
          confirmed_at:
            typeof body['confirmed_at'] === 'string' && body['confirmed_at'].trim() !== ''
              ? body['confirmed_at']
              : now,
          backflush_lines: [],
        },
        metadata: {
          correlation_id: order.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );

    replayIdOrReject(
      persisted,
      'production_order.confirmation_recorded',
      'production_order_id',
      orderId,
    );
    sendJson(res, 200, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// POST /api/v1/production-orders/:orderId/material-returns
// ---------------------------------------------------------------------------

const returnMaterialBase: RouteHandler = async (req, res, params) => {
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
    if (
      await sendReplayOrNull(res, orderId, idempotencyKey, 'production_order.material_returned')
    ) {
      return;
    }
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'write');
    await assertMaterialState(order, auditCtxFor(req, actor, 409));

    const sourcePostingId = body['source_posting_id'];
    if (!isUuid(sourcePostingId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'source_posting_id must be a UUID');
    }
    const quantity = body['quantity'];
    if (!isPositiveDecimal(quantity)) {
      throw new AppError(400, 'INVALID_PARAMS', 'quantity must be a positive decimal string');
    }
    const reasonCode = body['reason_code'];
    if (typeof reasonCode !== 'string' || reasonCode.trim() === '') {
      throw new AppError(
        400,
        'REASON_CODE_REQUIRED',
        'A material return requires a non-blank reason_code',
        { production_order_id: orderId, source_posting_id: sourcePostingId },
      );
    }
    const trimmedReason = reasonCode.trim();
    if (!config.production.materialReturnReasonCodes.includes(trimmedReason)) {
      throw new AppError(
        422,
        'RETURN_REASON_CODE_INVALID',
        'The reason code is not a configured material return reason',
        {
          production_order_id: orderId,
          source_posting_id: sourcePostingId,
          reason_code: trimmedReason,
          allowed: config.production.materialReturnReasonCodes,
        },
      );
    }

    const posting = await getPostingById(sourcePostingId);
    if (!posting) {
      throw new AppError(404, 'POSTING_NOT_FOUND', 'The source posting does not resolve', {
        production_order_id: orderId,
        source_posting_id: sourcePostingId,
      });
    }
    if (
      posting.production_order_id !== orderId ||
      (posting.posting_type !== 'directed_issue' && posting.posting_type !== 'backflush')
    ) {
      throw new AppError(
        409,
        'RETURN_SOURCE_MISMATCH',
        'The source posting is not an issue/backflush posting of this order',
        {
          production_order_id: orderId,
          source_posting_id: posting.posting_id,
          source_posting_type: posting.posting_type,
          source_posting_order_id: posting.production_order_id,
        },
      );
    }
    // AC6 pre-check (the seam re-settles it in SQL NUMERIC under the posting lock).
    if (await getReturnExceeds(posting.posting_id, quantity)) {
      throw new AppError(
        409,
        'RETURN_EXCEEDS_ISSUE',
        'The return would exceed the quantity issued to the order',
        {
          production_order_id: orderId,
          source_posting_id: posting.posting_id,
          requested_return: quantity,
          open_quantity: posting.open_quantity,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.material_returned',
        payload: {
          production_order_id: orderId,
          source_posting_id: posting.posting_id,
          quantity,
          reason_code: trimmedReason,
          returned_by: actor.userId,
          returned_at:
            typeof body['returned_at'] === 'string' && body['returned_at'].trim() !== ''
              ? body['returned_at']
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
      auditCtxFor(req, actor, 200),
    );

    replayIdOrReject(
      persisted,
      'production_order.material_returned',
      'production_order_id',
      orderId,
    );
    sendJson(res, 200, persisted.payload as Record<string, unknown>);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/production-orders/:orderId/wip
// ---------------------------------------------------------------------------

const getWipBase: RouteHandler = async (req, res, params) => {
  try {
    const orderId = requireUuidParam(params, 'orderId');
    const order = await loadOrderOr404(orderId);
    assertPlantLocationAccess(req, order.plant_location_id, 'read');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const limitRaw = url.searchParams.get('limit');
    const offsetRaw = url.searchParams.get('offset');
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    const offset = offsetRaw !== null ? Number(offsetRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit must be an integer between 1 and 200');
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw new AppError(400, 'INVALID_PARAMS', 'offset must be a non-negative integer');
    }

    // AC4: the ledger is the real-time source of truth - computed directly from
    // production_wip_ledger, never from a rollup table (no desync surface to maintain).
    const summary = await getWipSummary(orderId);
    const postings = await listPostingsByOrder({ orderId, limit, offset });
    sendJson(res, 200, {
      production_order_id: orderId,
      status: order.status,
      net_open_quantity: summary.net_open_quantity,
      net_open_value: summary.net_open_value,
      postings: postings.map(postingToJson),
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const stageMaterialHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(stageMaterialBase);

export const listStagingHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(listStagingBase);

export const issueMaterialHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(issueMaterialBase);

export const recordConfirmationHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(recordConfirmationBase);

export const returnMaterialHandler = requireRole({
  module: 'production',
  functionScope: 'write',
})(returnMaterialBase);

export const getWipHandler = requireRole({
  module: 'production',
  functionScope: 'read',
})(getWipBase);
