import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getLotById, getLotsForSelection, getLotsForFifoSelection, placeQualityHold, clearQualityHold } from '../../read/projections/lot_master.js';
import { getTraceForLot } from '../../read/projections/lot_trace.js';
import { getStockBalancesBySku } from '../../read/projections/stock_balance.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

function actorContext(req: IncomingMessage) {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? '00000000-0000-0000-0000-000000000000';
  const role = assignment?.role ?? '';
  return { userId, role };
}

function auditCtxFor(req: IncomingMessage, actor: ReturnType<typeof actorContext>, httpStatus: number): WriteAuditCtx {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: '*',
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function getLotNumber(params: Record<string, string>): string | null {
  const lotNumber = params['lotNumber'] || params['lot_id'];
  return lotNumber && lotNumber.trim().length > 0 ? lotNumber : null;
}

/**
 * GET /api/v1/lots/:lot_id/trace (Story 2.3, AC4): returns a complete trace of all transactions
 * touching a lot, including all locations it has been in and current balance per location.
 * Must complete within 500ms API p95.
 */
const getLotTraceBase: RouteHandler = async (req, res, params) => {
  const lotId = getLotNumber(params);
  if (!lotId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be a valid UUID');
    return;
  }

  const lot = await getLotById(lotId);
  if (!lot) {
    sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotId}"`, { lot_id: lotId });
    return;
  }

  const traceEntries = await getTraceForLot(lotId);
  const balances = await getStockBalancesBySku(lot.sku);
  
  // Filter balances for this lot and apply location scoping
  const authContext = getAuthContext(req);
  let lotBalances = balances.filter(b => b.lot_id === lotId);
  
  if (authContext) {
    const { permittedLocationsForModule } = await import('../../middleware/rbac.js');
    const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
    if (!wildcard) {
      lotBalances = lotBalances.filter(b => locations.has(b.location_id));
    }
  }

  // Group balances by location
  const balancesByLocation = new Map<string, { location_id: string; location_code: string | null; on_hand: number; allocated: number; available: number }>();
  for (const balance of lotBalances) {
    const existing = balancesByLocation.get(balance.location_id) ?? {
      location_id: balance.location_id,
      location_code: balance.location_code,
      on_hand: 0,
      allocated: 0,
      available: 0,
    };
    existing.location_code = existing.location_code ?? balance.location_code;
    existing.on_hand += balance.on_hand;
    existing.allocated += balance.allocated;
    existing.available += balance.available;
    balancesByLocation.set(balance.location_id, existing);
  }

  sendJson(res, 200, {
    lot_id: lotId,
    lot_number: lot.lot_number,
    sku: lot.sku,
    expiry_date: lot.expiry_date,
    quality_hold_status: lot.quality_hold_status,
    quality_hold_reason: lot.quality_hold_reason,
    trace: traceEntries.map(entry => ({
      event_id: entry.event_id,
      event_type: entry.event_type,
      location_id: entry.location_id,
      location_code: entry.location_code,
      quantity_change: Number(entry.quantity_change),
      business_stream: entry.business_stream,
      timestamp: entry.timestamp,
    })),
    balances_by_location: [...balancesByLocation.values()],
  });
};

export const getLotTraceHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getLotTraceBase);

/**
 * POST /api/v1/stock/:sku/select-lot (Story 2.3, AC1, AC4): returns the next lot to issue when
 * FEFO/FIFO is requested. Accepts parameters: sku, location_id, quantity, fifo_mode (fefo | fifo).
 * Returns the lot ID and confirm availability. Idempotent - multiple calls with same parameters
 * return the same lot ID.
 */
const selectLotBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter is required');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const locationId = typeof body?.['location_id'] === 'string' ? body['location_id'] as string : undefined;
  const quantity = typeof body?.['quantity'] === 'number' ? (body['quantity'] as number) : undefined;
  const fifoMode = typeof body?.['fifo_mode'] === 'string' ? (body['fifo_mode'] as 'fefo' | 'fifo') : undefined;

  if (!locationId || typeof locationId !== 'string') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id is required in request body');
    return;
  }

  if (typeof quantity !== 'number' || quantity <= 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'quantity must be a positive number');
    return;
  }

  if (fifoMode && fifoMode !== 'fefo' && fifoMode !== 'fifo') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'fifo_mode must be "fefo" or "fifo"');
    return;
  }

  // Get lots based on selection mode
  const lots = fifoMode === 'fifo' ? await getLotsForFifoSelection(sku) : await getLotsForSelection(sku);
  console.log('selectLotHandler lots:', { sku, fifoMode, count: lots.length, lots });
  
  // Get current stock balances to check availability
  const balances = await getStockBalancesBySku(sku);
  console.log('selectLotHandler balances:', balances);
  
  const lotBalances = new Map<string, number>();
  for (const balance of balances) {
    if (balance.lot_id) {
      const current = lotBalances.get(balance.lot_id) ?? 0;
      lotBalances.set(balance.lot_id, current + balance.available);
    }
  }
  console.log('selectLotHandler lotBalances:', Object.fromEntries(lotBalances));
  
  if (lots.length === 0) {
    sendRequestError(req, res, 404, 'NO_AVAILABLE_LOT', 'No available lots found for this SKU', {
      sku,
      reason: 'No lots exist for this SKU',
    });
    return;
  }

  // Get current stock balances to check availability
  const balances = await getStockBalancesBySku(sku);
  const lotBalances = new Map<string, number>();
  for (const balance of balances) {
    if (balance.lot_id) {
      const current = lotBalances.get(balance.lot_id) ?? 0;
      lotBalances.set(balance.lot_id, current + balance.available);
    }
  }

  // Find first lot with sufficient quantity
  for (const lot of lots) {
    const available = lotBalances.get(lot.lot_id) ?? 0;
    if (available >= quantity) {
      sendJson(res, 200, {
        lot_id: lot.lot_id,
        lot_number: lot.lot_number,
        sku: lot.sku,
        expiry_date: lot.expiry_date,
        available_quantity: available,
        fifo_mode: fifoMode ?? 'fefo',
      });
      return;
    }
  }

  // No lot has sufficient quantity
  const breakdown = lots.map(lot => ({
    lot_id: lot.lot_id,
    lot_number: lot.lot_number,
    available_quantity: lotBalances.get(lot.lot_id) ?? 0,
    reason: (lotBalances.get(lot.lot_id) ?? 0) < quantity ? 'insufficient_quantity' : 'on_hold',
  }));

  sendRequestError(req, res, 404, 'NO_AVAILABLE_LOT', 'No lot has sufficient quantity available', {
    sku,
    requested_quantity: quantity,
    available_lots: breakdown,
  });
};

export const selectLotHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(selectLotBase);

/**
 * PUT /api/v1/lots/:lot_id/quality-hold (Story 2.3, AC3): places a quality hold on a lot.
 * Payload: hold_reason (string). Response: updated lot status.
 */
const placeQualityHoldBase: RouteHandler = async (req, res, params) => {
  const lotId = getLotNumber(params);
  if (!lotId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be a valid UUID');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const holdReason = typeof body?.['hold_reason'] === 'string' ? (body['hold_reason'] as string) : undefined;

  if (!holdReason || typeof holdReason !== 'string' || holdReason.trim().length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'hold_reason is required and must be a non-empty string');
    return;
  }

  const actor = actorContext(req);
  
  // Look up the lot by ID to get lot_number and sku
  const existingLot = await getLotById(lotId);
  if (!existingLot) {
    sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotId}"`, { lot_id: lotId });
    return;
  }
  
  const lot = await placeQualityHold(existingLot.lot_number, existingLot.sku, holdReason.trim());
  
  if (!lot) {
    sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotId}"`, { lot_id: lotId });
    return;
  }

  // Audit the quality hold operation
  await persistEvent({
    stream_type: 'inventory',
    stream_id: lotId,
    event_type: 'lot.quality_hold_placed',
    event_version: 1,
    payload: {
      lot_id: lotId,
      lot_number: lot.lot_number,
      sku: lot.sku,
      hold_reason: holdReason.trim(),
      previous_status: 'none',
      new_status: 'held',
    },
    metadata: {
      correlation_id: getTraceId(req) ?? '',
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: '*',
      },
      occurred_at: new Date().toISOString(),
    },
  }, auditCtxFor(req, actor, 200));

  sendJson(res, 200, lot);
};

export const placeQualityHoldHandler: RouteHandler = requireRole({ module: 'quality', functionScope: 'write' })(placeQualityHoldBase);

/**
 * DELETE /api/v1/lots/:lot_id/quality-hold (Story 2.3, AC3): clears a quality hold on a lot.
 * Audit-log both operations.
 */
const clearQualityHoldBase: RouteHandler = async (req, res, params) => {
  const lotId = getLotNumber(params);
  if (!lotId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be a valid UUID');
    return;
  }

  const actor = actorContext(req);
  
  // Look up the lot by ID to get lot_number and sku
  const existingLot = await getLotById(lotId);
  if (!existingLot) {
    sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotId}"`, { lot_id: lotId });
    return;
  }
  
  const lot = await clearQualityHold(existingLot.lot_number, existingLot.sku);
  
  if (!lot) {
    sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotId}"`, { lot_id: lotId });
    return;
  }

  // Audit the quality hold clear operation
  await persistEvent({
    stream_type: 'inventory',
    stream_id: lotId,
    event_type: 'lot.quality_hold_cleared',
    event_version: 1,
    payload: {
      lot_id: lotId,
      lot_number: lot.lot_number,
      sku: lot.sku,
      previous_status: 'held',
      new_status: 'none',
    },
    metadata: {
      correlation_id: getTraceId(req) ?? '',
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: '*',
      },
      occurred_at: new Date().toISOString(),
    },
  }, auditCtxFor(req, actor, 200));

  sendJson(res, 200, lot);
};

export const clearQualityHoldHandler: RouteHandler = requireRole({ module: 'quality', functionScope: 'write' })(clearQualityHoldBase);