import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { isValidBusinessStream } from '../../read/projections/business_stream_config.js';
import {
  createItem,
  updateItem,
  getItemBySku,
  ALLOWED_VALUATION_METHODS,
  ITEM_STATUSES,
  STANDARD_COST_DESIGNATION,
} from '../../read/projections/item_master.js';
import type { CreateItemInput, UpdateItemPatch, ValuationMethod, ItemStatus } from '../../read/projections/item_master.js';

// Sentinel used ONLY for the domain-event envelope's actor.location_id when the acting admin's
// authorizing assignment is enterprise-wide ('*'), which is not a UUID. The audit_log.location_id
// (TEXT) has no such constraint, so it records the real '*' assignment value. Mirrors
// src/api/v1/doa.ts (Story 1.4 source of this pattern).
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

// SKU is API-facing (it appears in URL paths), so constrain it to a URL-safe shape.
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

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

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): WriteAuditCtx {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValuationMethod(value: unknown): value is ValuationMethod {
  return typeof value === 'string' && (ALLOWED_VALUATION_METHODS as readonly string[]).includes(value);
}

function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === 'string' && (ITEM_STATUSES as readonly string[]).includes(value);
}

/** Parses an optional boolean field: absent becomes `fallback`; a non-boolean is a 400. */
function parseBooleanField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a boolean`);
  }
  return value;
}

/**
 * Validates valuation_method with a dedicated stable code. LIFO and bare "standard_cost" are
 * deliberately PROHIBITED values (Ind AS 2 disallows LIFO; standard cost is only ever a
 * measurement technique on top of a real method, never a fourth valuation_method - Story 2.4
 * AC3/AC6) and get VALUATION_METHOD_NOT_PERMITTED. Any other unrecognized value is malformed
 * input and keeps the original INVALID_VALUATION_METHOD code (Task 1.3).
 */
function assertValuationMethod(value: unknown): asserts value is ValuationMethod {
  if (isValuationMethod(value)) return;
  if (value === 'lifo' || value === 'standard_cost') {
    const message =
      value === 'lifo'
        ? 'Valuation method "lifo" is not permitted (Ind AS 2 prohibits LIFO)'
        : 'Valuation method "standard_cost" is not permitted; configure standard_cost_designation on a real valuation_method instead';
    throw new AppError(400, 'VALUATION_METHOD_NOT_PERMITTED', message, {
      supplied: value,
      allowed: [...ALLOWED_VALUATION_METHODS],
    });
  }
  throw new AppError(400, 'INVALID_VALUATION_METHOD', 'valuation_method must be one of fifo, weighted_average, specific_identification', {
    supplied: typeof value === 'string' ? value : null,
    allowed: [...ALLOWED_VALUATION_METHODS],
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parses an optional nullable non-empty-string field: absent is `undefined`, `null` clears it. */
function parseOptionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a non-empty string or null`);
  }
  return value;
}

/** Parses an optional nullable non-negative-number field: absent is `undefined`, `null` clears it. */
function parseOptionalNonNegativeNumber(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < 0) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a non-negative finite number or null`);
  }
  return value;
}

/** Parses an optional nullable 0-100 percentage field: absent is `undefined`, `null` clears it. */
function parseOptionalPercent(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isFiniteNumber(value) || value < 0 || value > 100) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a finite number between 0 and 100, or null`);
  }
  return value;
}

interface StandardCostFields {
  standard_cost_designation?: string | null;
  standard_cost_amount?: number | null;
  variance_review_cadence?: string | null;
  variance_tolerance_percent?: number | null;
  count_variance_tolerance_percent?: number | null;
}

function parseStandardCostFields(body: Record<string, unknown>): StandardCostFields {
  const fields: StandardCostFields = {};
  const designation = parseOptionalNullableString(body, 'standard_cost_designation');
  if (designation !== undefined) fields.standard_cost_designation = designation;
  const amount = parseOptionalNonNegativeNumber(body, 'standard_cost_amount');
  if (amount !== undefined) fields.standard_cost_amount = amount;
  const cadence = parseOptionalNullableString(body, 'variance_review_cadence');
  if (cadence !== undefined) fields.variance_review_cadence = cadence;
  const tolerance = parseOptionalPercent(body, 'variance_tolerance_percent');
  if (tolerance !== undefined) fields.variance_tolerance_percent = tolerance;
  const countTolerance = parseOptionalPercent(body, 'count_variance_tolerance_percent');
  if (countTolerance !== undefined) fields.count_variance_tolerance_percent = countTolerance;
  return fields;
}

/**
 * AC6: standard cost is accepted ONLY as an Ind AS 2 paragraph 21 measurement technique - a
 * standard_cost_amount may never be configured without the exact designation literal alongside
 * it (whether set in the same request or already present on the item). Evaluated against the
 * MERGED (existing + patch) state, mirroring how src/api/v1/doa.ts validates a value band.
 */
function assertStandardCostConfig(designation: string | null, amount: number | null): void {
  if (designation !== null && designation !== STANDARD_COST_DESIGNATION) {
    throw new AppError(400, 'VALUATION_METHOD_NOT_PERMITTED', `standard_cost_designation must be exactly "${STANDARD_COST_DESIGNATION}"`, {
      supplied: designation,
      required: STANDARD_COST_DESIGNATION,
    });
  }
  if (amount !== null && designation !== STANDARD_COST_DESIGNATION) {
    throw new AppError(
      400,
      'VALUATION_METHOD_NOT_PERMITTED',
      'standard_cost_amount may only be configured together with standard_cost_designation set to the Ind AS 2 paragraph 21 measurement technique',
      { standard_cost_amount: amount, standard_cost_designation: designation, required_designation: STANDARD_COST_DESIGNATION },
    );
  }
}

async function assertBusinessStream(value: string): Promise<void> {
  if (!(await isValidBusinessStream(value))) {
    throw new AppError(400, 'INVALID_BUSINESS_STREAM', 'business_stream is not a recognized active stream', {
      invalid_value: value,
    });
  }
}

function isDuplicateSkuError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: string }).constraint === 'uq_item_master_sku'
  );
}

// -----------------------------------------------------------------------------------------------
// POST /api/v1/items
// -----------------------------------------------------------------------------------------------
const createItemBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['sku']) || !isNonEmptyString(body['uom'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku and uom are required non-empty strings');
    return;
  }
  const sku = body['sku'];
  if (!SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku must be 1-64 URL-safe characters (letters, digits, ".", "_", "-")');
    return;
  }
  assertValuationMethod(body['valuation_method']);
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
    return;
  }
  await assertBusinessStream(body['business_stream']);
  if (body['status'] !== undefined && !isItemStatus(body['status'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of active, inactive');
    return;
  }
  const standardCost = parseStandardCostFields(body);
  assertStandardCostConfig(standardCost.standard_cost_designation ?? null, standardCost.standard_cost_amount ?? null);

  const input: CreateItemInput = {
    sku,
    uom: body['uom'],
    lot_controlled: parseBooleanField(body, 'lot_controlled', false),
    serial_controlled: parseBooleanField(body, 'serial_controlled', false),
    hazmat: parseBooleanField(body, 'hazmat', false),
    quarantine_required: parseBooleanField(body, 'quarantine_required', false),
    bis_licence_required: parseBooleanField(body, 'bis_licence_required', false),
    valuation_method: body['valuation_method'],
    business_stream: body['business_stream'],
    status: isItemStatus(body['status']) ? body['status'] : 'active',
    ...standardCost,
  };

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await createItem(input, client);
    await persistEvent(
      {
        stream_type: 'item_master',
        stream_id: item.item_id,
        event_type: 'item.created',
        payload: { item },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 201, item);
  } catch (err) {
    await client.query('ROLLBACK');
    if (isDuplicateSkuError(err)) {
      throw new AppError(409, 'DUPLICATE_SKU', `An item with sku "${sku}" already exists`, { sku });
    }
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// PATCH /api/v1/items/:sku
// -----------------------------------------------------------------------------------------------
const updateItemBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object');
    return;
  }

  const patch: UpdateItemPatch = {};
  if (body['uom'] !== undefined) {
    if (!isNonEmptyString(body['uom'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'uom must be a non-empty string');
      return;
    }
    patch.uom = body['uom'];
  }
  for (const field of ['lot_controlled', 'serial_controlled', 'hazmat', 'quarantine_required', 'bis_licence_required'] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'boolean') {
        sendRequestError(req, res, 400, 'INVALID_PARAMS', `${field} must be a boolean`);
        return;
      }
      patch[field] = body[field];
    }
  }
  if (body['valuation_method'] !== undefined) {
    assertValuationMethod(body['valuation_method']);
    patch.valuation_method = body['valuation_method'];
  }
  if (body['business_stream'] !== undefined) {
    if (!isNonEmptyString(body['business_stream'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream must be a non-empty string');
      return;
    }
    await assertBusinessStream(body['business_stream']);
    patch.business_stream = body['business_stream'];
  }
  if (body['status'] !== undefined) {
    if (!isItemStatus(body['status'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of active, inactive');
      return;
    }
    patch.status = body['status'];
  }
  Object.assign(patch, parseStandardCostFields(body));
  if (Object.keys(patch).length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'At least one updatable field is required');
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await getItemBySku(sku, client);
    if (!before) {
      throw new AppError(404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    }
    // AC6 merged validation (mirrors src/api/v1/doa.ts's value-band check): a patch that only
    // touches standard_cost_amount must still be checked against the EXISTING designation, and
    // vice versa - neither field alone tells the whole story.
    const mergedDesignation = patch.standard_cost_designation !== undefined ? patch.standard_cost_designation : before.standard_cost_designation;
    const mergedAmount = patch.standard_cost_amount !== undefined ? patch.standard_cost_amount : before.standard_cost_amount;
    assertStandardCostConfig(mergedDesignation, mergedAmount);
    const after = await updateItem(sku, patch, client);
    await persistEvent(
      {
        stream_type: 'item_master',
        stream_id: before.item_id,
        event_type: 'item.updated',
        payload: { item_id: before.item_id, sku, before, after },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 200, after);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// GET /api/v1/items/:sku
// -----------------------------------------------------------------------------------------------
const getItemBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return;
  }
  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }
  sendJson(res, 200, item);
};

export const createItemHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(createItemBase);
export const updateItemHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(updateItemBase);
export const getItemHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getItemBase);
