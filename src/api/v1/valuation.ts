import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { permittedLocationsForModule, requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getItemBySku, STANDARD_COST_DESIGNATION } from '../../read/projections/item_master.js';
import { getStockBalancesBySku } from '../../read/projections/stock_balance.js';
import {
  getInventoryValuation,
  listOpenFifoLayers,
  listSerialCosts,
  listNrvAdjustments,
  getLatestStandardCostVariance,
  listLatestStandardCostVariancePerSku,
} from '../../read/projections/inventory_valuation.js';
import { listAgreements } from '../../read/projections/ownership_agreement.js';
import { SUPPLIER_OWNED_STOCK_CLASSES } from '../../compliance/ownership.js';

// Mirrors src/api/v1/items.ts and src/api/v1/stock.ts: SKU is API-facing (URL path segment).
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validSku(params: Record<string, string>, req: IncomingMessage, res: Parameters<RouteHandler>[1]): string | null {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return null;
  }
  return sku;
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/stock/:sku/valuation (AC1, AC2, AC5, AC6)
// -----------------------------------------------------------------------------------------------
const getValuationBase: RouteHandler = async (req, res, params) => {
  const sku = validSku(params, req, res);
  if (!sku) return;

  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }

  const summary = (await getInventoryValuation(sku)) ?? {
    sku,
    quantity_on_hand: '0',
    running_average_cost: null,
    carrying_value: '0',
    pre_writedown_cost: null,
    cumulative_write_down: '0',
    updated_at: null,
  };

  const methodDetail: Record<string, unknown> = {};
  if (item.valuation_method === 'fifo') {
    methodDetail['fifo_layers'] = (await listOpenFifoLayers(sku)).map((layer) => ({
      layer_id: layer.layer_id,
      unit_cost: Number(layer.unit_cost),
      original_quantity: Number(layer.original_quantity),
      remaining_quantity: Number(layer.remaining_quantity),
      created_at: layer.created_at,
    }));
  } else if (item.valuation_method === 'specific_identification') {
    methodDetail['serial_costs'] = (await listSerialCosts(sku)).map((sc) => ({
      serial_number: sc.serial_number,
      unit_cost: Number(sc.unit_cost),
    }));
  } else if (item.valuation_method === 'weighted_average') {
    methodDetail['running_average_cost'] = summary.running_average_cost !== null ? Number(summary.running_average_cost) : null;
  }

  let standardCost: Record<string, unknown> | null = null;
  if (item.standard_cost_designation === STANDARD_COST_DESIGNATION && item.standard_cost_amount !== null) {
    const latestReview = await getLatestStandardCostVariance(sku);
    standardCost = {
      standard_cost_amount: item.standard_cost_amount,
      variance_review_cadence: item.variance_review_cadence,
      variance_tolerance_percent: item.variance_tolerance_percent,
      latest_review: latestReview,
    };
  }

  // Location visibility (Task 6.2): valuation is cost-level data - scoped server-side, never by
  // hiding fields in the UI. carrying_value itself is a SKU-level (not per-location) figure, so
  // scoping surfaces as which locations the caller may see this SKU's physical stock at, matching
  // GET /api/v1/stock/:sku's own location-scoping approach.
  let visibleLocations: Array<{ location_id: string; location_code: string | null }> = [];
  const balances = await getStockBalancesBySku(sku);
  const authContext = getAuthContext(req);
  const seen = new Set<string>();
  const scopedBalances = authContext
    ? (() => {
        const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
        return wildcard ? balances : balances.filter((row) => locations.has(row.location_id));
      })()
    : balances;
  for (const row of scopedBalances) {
    if (seen.has(row.location_id)) continue;
    seen.add(row.location_id);
    visibleLocations.push({ location_id: row.location_id, location_code: row.location_code });
  }
  visibleLocations = visibleLocations.sort((a, b) => (a.location_code ?? a.location_id).localeCompare(b.location_code ?? b.location_id, 'en', { sensitivity: 'base' }));

  // Story 2.8 (AC4): non-owned quantities are REPORTED but contribute zero to the owned carrying
  // value - the valuation projection itself never ingested them (inventory-valuation.ts gates to
  // 'owned'), so this is purely a response section. Owner-party codes come from the active
  // ownership agreements; scoping follows the same visible-locations rule as the rest of this
  // endpoint. The customer-owned 'job_work' class (Epic 9) is likewise non-valuated and included
  // for completeness when present, without an owner agreement.
  const { wildcard: agreementWildcard, locations: agreementLocations } = authContext ? permittedLocationsForModule(authContext.roles, 'inventory') : { wildcard: true, locations: new Set<string>() };
  const agreements = await listAgreements({ sku, active: true, location_any: agreementWildcard ? null : [...agreementLocations] });
  const ownerByGrain = new Map<string, string>();
  for (const agreement of agreements) {
    ownerByGrain.set(`${agreement.location_id}|${agreement.stock_class}`, agreement.owner_party_code);
  }
  const nonOwnedTotals = new Map<string, { stock_class: string; quantity_on_hand: number; owner_parties: Set<string> }>();
  for (const row of scopedBalances) {
    if (row.stock_class === 'owned') continue;
    const entry = nonOwnedTotals.get(row.stock_class) ?? { stock_class: row.stock_class, quantity_on_hand: 0, owner_parties: new Set<string>() };
    entry.quantity_on_hand += row.on_hand;
    const owner = ownerByGrain.get(`${row.location_id}|${row.stock_class}`);
    if (owner) entry.owner_parties.add(owner);
    nonOwnedTotals.set(row.stock_class, entry);
  }
  const nonOwnedQuantities = [...nonOwnedTotals.values()]
    .sort((a, b) => a.stock_class.localeCompare(b.stock_class, 'en', { sensitivity: 'base' }))
    .map((entry) => ({
      stock_class: entry.stock_class,
      quantity_on_hand: entry.quantity_on_hand,
      carrying_value_contribution: 0,
      owner_party_codes: SUPPLIER_OWNED_STOCK_CLASSES.has(entry.stock_class) ? [...entry.owner_parties].sort() : [],
    }));

  sendJson(res, 200, {
    sku,
    valuation_method: item.valuation_method,
    quantity_on_hand: Number(summary.quantity_on_hand),
    carrying_value: Number(summary.carrying_value),
    pre_writedown_cost: summary.pre_writedown_cost !== null ? Number(summary.pre_writedown_cost) : null,
    cumulative_write_down: Number(summary.cumulative_write_down),
    updated_at: summary.updated_at,
    ...methodDetail,
    nrv_adjustments: await listNrvAdjustments(sku),
    standard_cost: standardCost,
    visible_locations: visibleLocations,
    non_owned_quantities: nonOwnedQuantities,
  });
};

export const getValuationHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getValuationBase);

// -----------------------------------------------------------------------------------------------
// POST /api/v1/stock/:sku/valuation/nrv-write-down and /nrv-recovery (AC4)
//
// Real enforcement (recovery cap, DOA-approver matching, the computed original_cost/carrying-value
// fields) lives in src/compliance/inventory-valuation.ts, which runs for ANY caller that reaches
// persistEvent with these event types - including a raw POST /api/v1/events or an edge upload, not
// only these handlers. These handlers only shape a minimal caller-supplied request into the
// envelope and translate the persisted (seam-computed) event back into the HTTP response.
// -----------------------------------------------------------------------------------------------

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateNrvCommonBody(body: Record<string, unknown> | undefined, req: IncomingMessage, res: Parameters<RouteHandler>[1]): boolean {
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object');
    return false;
  }
  if (typeof body['effective_date'] !== 'string' || !DATE_REGEX.test(body['effective_date'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'effective_date is required and must be YYYY-MM-DD');
    return false;
  }
  if (typeof body['authoriser_actor_id'] !== 'string' || !UUID_REGEX.test(body['authoriser_actor_id'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'authoriser_actor_id is required and must be a valid UUID');
    return false;
  }
  if (!isNonEmptyString(body['reason'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason is required and must be a non-empty string');
    return false;
  }
  if (body['evidence_ref'] !== undefined && body['evidence_ref'] !== null && typeof body['evidence_ref'] !== 'string') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'evidence_ref must be a string when supplied');
    return false;
  }
  return true;
}

const nrvWriteDownBase: RouteHandler = async (req, res, params) => {
  const sku = validSku(params, req, res);
  if (!sku) return;
  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!validateNrvCommonBody(body, req, res)) return;
  if (!isFiniteNumber(body!['nrv_amount']) || (body!['nrv_amount'] as number) < 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'nrv_amount is required and must be a non-negative finite number');
    return;
  }

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.nrv_write_down_recorded',
      payload: {
        business_stream: item.business_stream,
        sku,
        effective_date: body!['effective_date'],
        authoriser_actor_id: body!['authoriser_actor_id'],
        nrv_amount: body!['nrv_amount'],
        reason: body!['reason'],
        evidence_ref: body!['evidence_ref'] ?? null,
      },
      metadata: {
        correlation_id: getTraceId(req) ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 201),
  );
  sendJson(res, 201, persisted);
};

export const nrvWriteDownHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(nrvWriteDownBase);

const nrvRecoveryBase: RouteHandler = async (req, res, params) => {
  const sku = validSku(params, req, res);
  if (!sku) return;
  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!validateNrvCommonBody(body, req, res)) return;
  if (!isFiniteNumber(body!['recovery_amount']) || (body!['recovery_amount'] as number) <= 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'recovery_amount is required and must be a positive finite number');
    return;
  }

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.nrv_recovery_recorded',
      payload: {
        business_stream: item.business_stream,
        sku,
        effective_date: body!['effective_date'],
        authoriser_actor_id: body!['authoriser_actor_id'],
        recovery_amount: body!['recovery_amount'],
        reason: body!['reason'],
        evidence_ref: body!['evidence_ref'] ?? null,
      },
      metadata: {
        correlation_id: getTraceId(req) ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 201),
  );
  sendJson(res, 201, persisted);
};

export const nrvRecoveryHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(nrvRecoveryBase);

// -----------------------------------------------------------------------------------------------
// POST /api/v1/stock/:sku/valuation/standard-cost-variance-review (AC6)
// -----------------------------------------------------------------------------------------------
const standardCostVarianceReviewBase: RouteHandler = async (req, res, params) => {
  const sku = validSku(params, req, res);
  if (!sku) return;
  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['period'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'period is required and must be a non-empty string');
    return;
  }

  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.standard_cost_variance_reviewed',
      payload: { business_stream: item.business_stream, sku, period: body['period'] },
      metadata: {
        correlation_id: getTraceId(req) ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 201),
  );
  sendJson(res, 201, persisted);
};

export const standardCostVarianceReviewHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(standardCostVarianceReviewBase);

// -----------------------------------------------------------------------------------------------
// GET /api/v1/valuation/standard-cost-variance-report (Task 6.4): period-end standard-versus-
// actual variance across every standard-cost-designated item, with tolerance breaches flagged.
// -----------------------------------------------------------------------------------------------
const standardCostVarianceReportBase: RouteHandler = async (_req, res, _params) => {
  const rows = await listLatestStandardCostVariancePerSku();
  sendJson(res, 200, { items: rows });
};

export const standardCostVarianceReportHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(standardCostVarianceReportBase);
