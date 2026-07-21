import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getAuthorizedAssignment, getParsedBody, getTraceId } from '../../middleware/context.js';
import { permittedLocationsForModule, requireRole } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getItemBySku } from '../../read/projections/item_master.js';
import { getLotById, getLotsForSelection, getLotsForFifoSelection, placeQualityHold, clearQualityHold } from '../../read/projections/lot_master.js';
import { appendTraceEntry, getTraceForLot } from '../../read/projections/lot_trace.js';
import { getStockBalancesBySku } from '../../read/projections/stock_balance.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

function actorContext(req: IncomingMessage) {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const locationId = assignment?.locationId && assignment.locationId !== '*' ? assignment.locationId : NO_LOCATION_UUID;
  return { userId, role, locationId };
}

function auditCtxFor(req: IncomingMessage, actor: ReturnType<typeof actorContext>, httpStatus: number): WriteAuditCtx {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.locationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function getLotNumber(params: Record<string, string>): string | null {
  const lotNumber = params['lot_id'] || params['lotNumber'];
  // Return the TRIMMED value, not the raw param: the guard trims but the lookup must query the
  // trimmed lot number too, or a whitespace-padded lot_id passes the guard and then 404s on a
  // lookup that never matches (Story 2.3 pass-3).
  const trimmed = lotNumber?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function bodyLocationId(_params: Record<string, string>, body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const locationId = (body as Record<string, unknown>)['location_id'];
  return typeof locationId === 'string' ? locationId : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sendLotNotFound(req: IncomingMessage, res: ServerResponse, lotNumber: string): void {
  sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotNumber}"`, { lot_id: lotNumber });
}

const getLotTraceBase: RouteHandler = async (req, res, params) => {
  const lotNumber = getLotNumber(params);
  if (!lotNumber) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be provided');
    return;
  }

  const lot = await getLotById(lotNumber);
  if (!lot) {
    sendLotNotFound(req, res, lotNumber);
    return;
  }

  const traceEntries = await getTraceForLot(lot.lot_id);
  const balances = await getStockBalancesBySku(lot.sku);
  const authContext = getAuthContext(req);
  const permitted = authContext ? permittedLocationsForModule(authContext.roles, 'inventory') : { wildcard: false, locations: new Set<string>() };
  // A non-location-scoped trace entry (location_id === null) - e.g. a quality hold/clear placed by
  // a wildcard-scoped actor, stored with a null location - is not secured to any single location,
  // so it is visible to any authorized reader. Rejecting it before the wildcard check silently
  // dropped quarantine history from every recall and 404'd a hold-only lot even for a wildcard
  // admin (Story 2.3 pass-3).
  const isPermitted = (locationId: string | null): boolean => locationId === null || permitted.wildcard || permitted.locations.has(locationId);
  const scopedTraceEntries = authContext ? traceEntries.filter((entry) => isPermitted(entry.location_id)) : traceEntries;
  let lotBalances = balances.filter((balance) => balance.lot_id === lot.lot_number);

  if (authContext && !permitted.wildcard) {
    lotBalances = lotBalances.filter((balance) => permitted.locations.has(balance.location_id));
  }

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

  // Out-of-scope callers get the SAME 404 LOT_NOT_FOUND response as a genuinely nonexistent lot
  // number (not a distinguishing 403) - otherwise a caller with zero visibility into this lot's
  // locations could enumerate valid lot numbers by observing 404 vs 403 (Story 2.3 re-review).
  if (authContext && scopedTraceEntries.length === 0 && balancesByLocation.size === 0) {
    sendLotNotFound(req, res, lotNumber);
    return;
  }

  sendJson(res, 200, {
    lot_id: lot.lot_id,
    lot_number: lot.lot_number,
    sku: lot.sku,
    expiry_date: lot.expiry_date,
    quality_hold_status: lot.quality_hold_status,
    quality_hold_reason: lot.quality_hold_reason,
    trace: scopedTraceEntries.map((entry) => ({
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

const selectLotBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter is required');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const locationId = typeof body?.['location_id'] === 'string' ? body['location_id'] as string : undefined;
  const quantity = body?.['quantity'];
  const fifoMode = typeof body?.['fifo_mode'] === 'string' ? body['fifo_mode'] : 'fefo';

  if (!locationId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'location_id is required in request body');
    return;
  }
  if (!isPositiveFiniteNumber(quantity)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'quantity must be a finite positive number');
    return;
  }
  if (fifoMode !== 'fefo' && fifoMode !== 'fifo') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'fifo_mode must be "fefo" or "fifo"');
    return;
  }

  const lots = fifoMode === 'fifo' ? await getLotsForFifoSelection(sku, undefined, true) : await getLotsForSelection(sku, undefined, true);
  const balances = await getStockBalancesBySku(sku);
  const lotBalances = new Map<string, number>();
  for (const balance of balances) {
    if (balance.location_id !== locationId || !balance.lot_id) continue;
    lotBalances.set(balance.lot_id, (lotBalances.get(balance.lot_id) ?? 0) + balance.available);
  }

  const today = localToday();
  const breakdown = lots.map((lot) => {
    const available = lotBalances.get(lot.lot_number) ?? 0;
    let reason = 'insufficient_quantity';
    if (lot.quality_hold_status === 'held') reason = 'on_hold';
    else if (lot.expiry_date && lot.expiry_date < today) reason = 'expired';
    return { lot_id: lot.lot_id, lot_number: lot.lot_number, available_quantity: available, reason };
  });

  for (const lot of lots) {
    const available = lotBalances.get(lot.lot_number) ?? 0;
    if (lot.quality_hold_status !== 'none') continue;
    if (lot.expiry_date && lot.expiry_date < today) continue;
    if (available >= quantity) {
      sendJson(res, 200, {
        lot_id: lot.lot_number,
        lot_uuid: lot.lot_id,
        lot_number: lot.lot_number,
        sku: lot.sku,
        expiry_date: lot.expiry_date,
        available_quantity: available,
        fifo_mode: fifoMode,
      });
      return;
    }
  }

  sendRequestError(req, res, 409, 'NO_AVAILABLE_LOT', 'No lot has sufficient quantity available', {
    sku,
    location_id: locationId,
    requested_quantity: quantity,
    available_lots: breakdown,
  });
};

export const selectLotHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read', locationId: bodyLocationId })(selectLotBase);

async function qualityHoldEvent(
  req: IncomingMessage,
  client: PoolClient,
  lot: { lot_id: string; lot_number: string; sku: string; quality_hold_status: string },
  actor: ReturnType<typeof actorContext>,
  eventType: 'lot.quality_hold_placed' | 'lot.quality_hold_cleared',
  payload: Record<string, unknown>,
): Promise<void> {
  const item = await getItemBySku(lot.sku, client);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent({
    stream_type: 'inventory',
    stream_id: lot.lot_id,
    event_type: eventType,
    payload: {
      business_stream: item?.business_stream ?? 'production',
      lot_id: lot.lot_number,
      lot_number: lot.lot_number,
      sku: lot.sku,
      ...payload,
    },
    metadata: {
      correlation_id: getTraceId(req) ?? '00000000-0000-0000-0000-000000000000',
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.locationId,
      },
      occurred_at: occurredAt,
    },
  }, auditCtxFor(req, actor, 200), client);
  await appendTraceEntry({
    lot_id: lot.lot_id,
    event_id: persisted.event_id,
    event_type: eventType,
    sku: lot.sku,
    location_id: actor.locationId === NO_LOCATION_UUID ? null : actor.locationId,
    location_code: null,
    quantity_change: '0',
    business_stream: item?.business_stream ?? 'production',
    timestamp: occurredAt,
  }, client);
}

const placeQualityHoldBase: RouteHandler = async (req, res, params) => {
  const lotNumber = getLotNumber(params);
  if (!lotNumber) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be provided');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const holdReason = typeof body?.['hold_reason'] === 'string' ? body['hold_reason'].trim() : '';
  if (holdReason.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'hold_reason is required and must be a non-empty string');
    return;
  }

  const actor = actorContext(req);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existingLot = await getLotById(lotNumber, client);
    if (!existingLot) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotNumber}"`, { lot_id: lotNumber });
      return;
    }
    const previousStatus = existingLot.quality_hold_status;
    const lot = await placeQualityHold(existingLot.lot_number, existingLot.sku, holdReason, client);
    if (!lot) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotNumber}"`, { lot_id: lotNumber });
      return;
    }
    await qualityHoldEvent(req, client, lot, actor, 'lot.quality_hold_placed', {
      hold_reason: holdReason,
      previous_status: previousStatus,
      new_status: 'held',
    });
    await client.query('COMMIT');
    sendJson(res, 200, lot);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const placeQualityHoldHandler: RouteHandler = requireRole({ module: 'quality', functionScope: 'write' })(placeQualityHoldBase);

const clearQualityHoldBase: RouteHandler = async (req, res, params) => {
  const lotNumber = getLotNumber(params);
  if (!lotNumber) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id must be provided');
    return;
  }

  const actor = actorContext(req);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existingLot = await getLotById(lotNumber, client);
    if (!existingLot) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotNumber}"`, { lot_id: lotNumber });
      return;
    }
    const previousStatus = existingLot.quality_hold_status;
    const lot = await clearQualityHold(existingLot.lot_number, existingLot.sku, client);
    if (!lot) {
      await client.query('ROLLBACK');
      sendRequestError(req, res, 404, 'LOT_NOT_FOUND', `No lot master record exists for lot_id "${lotNumber}"`, { lot_id: lotNumber });
      return;
    }
    await qualityHoldEvent(req, client, lot, actor, 'lot.quality_hold_cleared', {
      previous_status: previousStatus,
      new_status: 'none',
    });
    await client.query('COMMIT');
    sendJson(res, 200, lot);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const clearQualityHoldHandler: RouteHandler = requireRole({ module: 'quality', functionScope: 'write' })(clearQualityHoldBase);
