import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLotByNumberAndSku, lotExistsByNumber, applyLotEvent, getLotsForSelection, getLotsForFifoSelection } from '../read/projections/lot_master.js';
import type { LotMaster } from '../read/projections/lot_master.js';
import { getSerialByNumberAndSku, serialExistsByNumberAndSku, applySerialReceipt, applySerialIssue } from '../read/projections/serial_master.js';
import type { SerialMaster } from '../read/projections/serial_master.js';
import { getItemBySku } from '../read/projections/item_master.js';
import type { ItemMaster } from '../read/projections/item_master.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import { getStockBalancesBySku } from '../read/projections/stock_balance.js';
import { appendTraceEntry, traceEntryExists } from '../read/projections/lot_trace.js';

export const ERROR_CODES = {
  LOT_EXPIRED: 'LOT_EXPIRED',
  LOT_ON_HOLD: 'LOT_ON_HOLD',
  DUPLICATE_LOT: 'DUPLICATE_LOT',
  DUPLICATE_SERIAL: 'DUPLICATE_SERIAL',
  SERIAL_REQUIRED: 'SERIAL_REQUIRED',
  SERIAL_NOT_ALLOWED: 'SERIAL_NOT_ALLOWED',
  SERIAL_NOT_AVAILABLE: 'SERIAL_NOT_AVAILABLE',
  NO_AVAILABLE_LOT: 'NO_AVAILABLE_LOT',
  LOT_NOT_FOUND: 'LOT_NOT_FOUND',
  SERIAL_NOT_FOUND: 'SERIAL_NOT_FOUND',
} as const;

export interface LotValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SerialValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface LotSerialDeps {
  getLotByNumberAndSku: (lotNumber: string, sku: string, client?: PoolClient) => Promise<LotMaster | null>;
  lotExistsByNumberAndSku: (lotNumber: string, sku: string, client?: PoolClient) => Promise<boolean>;
  getSerialByNumberAndSku: (serialNumber: string, sku: string, client?: PoolClient) => Promise<SerialMaster | null>;
  serialExistsByNumberAndSku: (serialNumber: string, sku: string, client?: PoolClient) => Promise<boolean>;
  getItemBySku: (sku: string, client?: PoolClient) => Promise<ItemMaster | null>;
}

const LOT_SERIAL_STREAM_TYPES = new Set(['inventory']);
const LOT_SERIAL_EVENT_TYPES = new Set(['stock.received', 'stock.allocated', 'stock.issued']);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function todayLocalYmd(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toAppError(statusCode: number, result: LotValidationResult | SerialValidationResult, fallbackCode: string, fallbackMessage: string): AppError {
  return new AppError(statusCode, result.errorCode ?? fallbackCode, result.message ?? fallbackMessage, result.details);
}

function serialNumbersFrom(payload: Record<string, unknown>): string[] {
  const serials = payload['serials'] as Array<{ serial_number: string }> | undefined;
  return serials?.map((serial) => serial.serial_number) ?? [];
}

async function resolveLocation(envelope: EventEnvelope, client: PoolClient): Promise<{ location_id: string | null; location_code: string | null }> {
  const targetLocationId = envelope.payload['target_location_id'];
  const targetLocationCode = envelope.payload['target_location_code'];
  if (typeof targetLocationId === 'string') {
    const location = await getLocationById(targetLocationId, client);
    return { location_id: location?.location_id ?? targetLocationId, location_code: location?.location_code ?? null };
  }
  if (typeof targetLocationCode === 'string') {
    const location = await getLocationByCode(targetLocationCode, client);
    return { location_id: location?.location_id ?? null, location_code: location?.location_code ?? targetLocationCode };
  }
  return { location_id: null, location_code: null };
}

async function selectLotForIssue(envelope: EventEnvelope, client: PoolClient): Promise<string | null> {
  const mode = envelope.payload['fefo_mode'];
  if (mode !== 'fefo' && mode !== 'fifo') return null;
  const sku = envelope.payload['sku'] as string;
  const quantity = envelope.payload['quantity'] as number;
  const location = await resolveLocation(envelope, client);
  if (!location.location_id) return null;
  const lots = mode === 'fifo' ? await getLotsForFifoSelection(sku, client) : await getLotsForSelection(sku, client);
  const balances = await getStockBalancesBySku(sku, client);
  const lotBalances = new Map<string, number>();
  for (const balance of balances) {
    if (balance.location_id !== location.location_id || !balance.lot_id) continue;
    lotBalances.set(balance.lot_id, (lotBalances.get(balance.lot_id) ?? 0) + balance.available);
  }
  for (const lot of lots) {
    const available = lotBalances.get(lot.lot_number) ?? 0;
    if (available >= quantity) return lot.lot_number;
  }
  throw new AppError(409, ERROR_CODES.NO_AVAILABLE_LOT, 'No lot has sufficient quantity available', {
    sku,
    location_id: location.location_id,
    requested_quantity: quantity,
  });
}

function quantityChangeFor(envelope: EventEnvelope): string {
  const quantity = envelope.payload['quantity'];
  if (!isPositiveFiniteNumber(quantity)) return '0';
  if (envelope.event_type === 'stock.received') return String(quantity);
  return String(-quantity);
}

async function appendLotTrace(envelope: EventEnvelope, lot: LotMaster, client: PoolClient, eventId: string): Promise<void> {
  if (await traceEntryExists(eventId, client)) return;
  const location = await resolveLocation(envelope, client);
  await appendTraceEntry({
    lot_id: lot.lot_id,
    event_id: eventId,
    event_type: envelope.event_type,
    sku: lot.sku,
    location_id: location.location_id,
    location_code: location.location_code,
    quantity_change: quantityChangeFor(envelope),
    business_stream: String(envelope.payload['business_stream']),
    timestamp: envelope.metadata.occurred_at,
  }, client);
}

export function isLotSerialEvent(envelope: EventEnvelope): boolean {
  if (!LOT_SERIAL_STREAM_TYPES.has(envelope.stream_type)) return false;
  if (!LOT_SERIAL_EVENT_TYPES.has(envelope.event_type)) return false;
  if (envelope.event_type === 'stock.issued') return true;
  return envelope.payload['lot_id'] !== undefined || envelope.payload['serials'] !== undefined;
}

export async function validateLotForReceipt(lotNumber: string, sku: string, _expiryDate: string | null, client?: PoolClient): Promise<LotValidationResult> {
  const exists = await lotExistsByNumber(lotNumber, client);
  if (exists) {
    return {
      valid: false,
      errorCode: ERROR_CODES.DUPLICATE_LOT,
      message: 'Lot already exists',
      details: { lotNumber, sku },
    };
  }
  return { valid: true };
}

export async function validateLotForIssueAllocate(lotNumber: string, sku: string, overrideExpired?: boolean, client?: PoolClient): Promise<LotValidationResult> {
  const lot = await getLotByNumberAndSku(lotNumber, sku, client);
  if (!lot) {
    return {
      valid: false,
      errorCode: ERROR_CODES.LOT_NOT_FOUND,
      message: 'Lot not found',
      details: { lotNumber, sku },
    };
  }
  if (lot.quality_hold_status === 'held') {
    return {
      valid: false,
      errorCode: ERROR_CODES.LOT_ON_HOLD,
      message: 'Lot is on quality hold',
      details: { lotNumber, sku, reason: lot.quality_hold_reason },
    };
  }
  if (!overrideExpired && lot.expiry_date && lot.expiry_date < todayLocalYmd()) {
    return {
      valid: false,
      errorCode: ERROR_CODES.LOT_EXPIRED,
      message: 'Lot has expired',
      details: { lotNumber, sku, expiryDate: lot.expiry_date },
    };
  }
  return { valid: true };
}

export async function validateSerialsForReceipt(sku: string, serialNumbers: string[], client?: PoolClient): Promise<SerialValidationResult> {
  const item = await getItemBySku(sku, client);
  if (!item) {
    return { valid: false, errorCode: 'ITEM_NOT_FOUND', message: `No item master record exists for sku "${sku}"`, details: { sku } };
  }
  if (!item.serial_controlled) {
    return { valid: false, errorCode: ERROR_CODES.SERIAL_NOT_ALLOWED, message: 'Item is not marked as serial-controlled', details: { sku } };
  }
  if (new Set(serialNumbers).size !== serialNumbers.length) {
    return { valid: false, errorCode: ERROR_CODES.DUPLICATE_SERIAL, message: 'Duplicate serial number in receipt payload', details: { sku } };
  }
  for (const serialNumber of serialNumbers) {
    const exists = await serialExistsByNumberAndSku(serialNumber, sku, client);
    if (exists) {
      const serial = await getSerialByNumberAndSku(serialNumber, sku, client);
      return {
        valid: false,
        errorCode: ERROR_CODES.DUPLICATE_SERIAL,
        message: 'Serial number already exists for this SKU',
        details: { serialNumber, sku, currentLocationId: serial?.current_location_id ?? null },
      };
    }
  }
  return { valid: true };
}

export async function validateSerialsForIssue(sku: string, serialNumbers: string[], locationId?: string | null, lotNumber?: string | null, client?: PoolClient): Promise<SerialValidationResult> {
  const item = await getItemBySku(sku, client);
  if (!item) {
    return { valid: false, errorCode: 'ITEM_NOT_FOUND', message: `No item master record exists for sku "${sku}"`, details: { sku } };
  }
  if (!item.serial_controlled) {
    return { valid: false, errorCode: ERROR_CODES.SERIAL_NOT_ALLOWED, message: 'Item is not marked as serial-controlled', details: { sku } };
  }
  for (const serialNumber of serialNumbers) {
    const serial = await getSerialByNumberAndSku(serialNumber, sku, client);
    if (!serial) {
      return { valid: false, errorCode: ERROR_CODES.SERIAL_NOT_FOUND, message: 'Serial number not found', details: { serialNumber, sku } };
    }
    if (serial.current_location_id === null || (locationId && serial.current_location_id !== locationId) || (lotNumber && serial.lot_id !== lotNumber)) {
      return {
        valid: false,
        errorCode: ERROR_CODES.SERIAL_NOT_AVAILABLE,
        message: 'Serial number is not available for this issue',
        details: { serialNumber, sku, currentLocationId: serial.current_location_id, lot_id: serial.lot_id },
      };
    }
  }
  return { valid: true };
}

export function assertLotSerialShape(envelope: EventEnvelope): void {
  if (!isLotSerialEvent(envelope)) return;
  if (!isNonEmptyString(envelope.payload['sku'])) {
    throw new AppError(400, 'ITEM_NOT_FOUND', 'sku must be a non-empty string for lot or serial events', { sku: envelope.payload['sku'] ?? null });
  }
  if (envelope.payload['lot_id'] !== undefined && !isNonEmptyString(envelope.payload['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied', { event_type: envelope.event_type });
  }
  if (envelope.payload['expiry_date'] !== undefined && (typeof envelope.payload['expiry_date'] !== 'string' || !DATE_REGEX.test(envelope.payload['expiry_date']))) {
    throw new AppError(400, 'INVALID_PARAMS', 'expiry_date must be YYYY-MM-DD when supplied', { event_type: envelope.event_type });
  }
  if (envelope.payload['override_expired_lot'] === true) {
    const role = envelope.metadata.actor.role;
    if (!role.includes('quality') && !role.includes('admin')) {
      throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'Expired-lot override requires a quality or admin role', { event_type: envelope.event_type });
    }
  }
  if (envelope.payload['serials'] !== undefined) {
    if (!Array.isArray(envelope.payload['serials'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'serials must be an array when supplied', { event_type: envelope.event_type });
    }
    const seen = new Set<string>();
    for (const serial of envelope.payload['serials']) {
      if (typeof serial !== 'object' || serial === null) {
        throw new AppError(400, 'INVALID_PARAMS', 'Each serial must be an object', { event_type: envelope.event_type });
      }
      const serialNumber = serial['serial_number'];
      if (!isNonEmptyString(serialNumber)) {
        throw new AppError(400, 'INVALID_PARAMS', 'Each serial must have a non-empty serial_number', { event_type: envelope.event_type });
      }
      if (seen.has(serialNumber)) {
        throw new AppError(400, ERROR_CODES.DUPLICATE_SERIAL, 'Duplicate serial number in payload', { serial_number: serialNumber });
      }
      seen.add(serialNumber);
      if (serial['initial_quantity'] !== undefined && !isPositiveFiniteNumber(serial['initial_quantity'])) {
        throw new AppError(400, 'INVALID_PARAMS', 'initial_quantity must be a finite positive number when supplied', { event_type: envelope.event_type });
      }
    }
  }
}

export async function applyLotSerialValidation(envelope: EventEnvelope, client: PoolClient, eventId: string): Promise<void> {
  if (!isLotSerialEvent(envelope)) return;
  if (envelope.idempotency_key || envelope.event_id) {
    const existing = await client.query(
      `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
      [envelope.idempotency_key ?? null, envelope.event_id ?? null],
    );
    if (existing.rows.length > 0) return;
  }

  const sku = envelope.payload['sku'] as string;
  if (!envelope.payload['lot_id']) {
    const selectedLot = await selectLotForIssue(envelope, client);
    if (selectedLot) envelope.payload['lot_id'] = selectedLot;
  }
  const lotId = envelope.payload['lot_id'] as string | undefined;
  const serials = envelope.payload['serials'] as Array<{ serial_number: string; initial_quantity?: number }> | undefined;

  if (envelope.event_type === 'stock.issued') {
    const item = await getItemBySku(sku, client);
    if (item?.serial_controlled && (!serials || serials.length === 0)) {
      throw new AppError(400, ERROR_CODES.SERIAL_REQUIRED, 'Serial-controlled item requires serial numbers', { sku });
    }
    const gatedIssue = (serials !== undefined && serials.length > 0) || lotId !== undefined || envelope.payload['fefo_mode'] !== undefined;
    if (gatedIssue) {
      const resolved = await resolveLocation(envelope, client);
      if (!resolved.location_id) {
        throw new AppError(400, 'INVALID_PARAMS', 'A resolvable target location is required to issue lot- or serial-tracked stock', {
          event_type: envelope.event_type,
          sku,
        });
      }
    }
    let lot: LotMaster | null = null;
    if (lotId) {
      const overrideExpired = envelope.payload['override_expired_lot'] === true;
      const validationResult = await validateLotForIssueAllocate(lotId, sku, overrideExpired, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'LOT_VALIDATION_ERROR', 'Lot validation failed');
      lot = await getLotByNumberAndSku(lotId, sku, client);
    }
    if (serials && serials.length > 0) {
      const location = await resolveLocation(envelope, client);
      const serialNumbers = serialNumbersFrom(envelope.payload);
      const validationResult = await validateSerialsForIssue(sku, serialNumbers, location.location_id, lotId ?? null, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'SERIAL_VALIDATION_ERROR', 'Serial validation failed');
      for (const serialNumber of serialNumbers) {
        const updated = await applySerialIssue(serialNumber, sku, location.location_id, lotId ?? null, client);
        if (!updated) throw new AppError(409, ERROR_CODES.SERIAL_NOT_AVAILABLE, 'Serial number is not available for this issue', { serialNumber, sku });
      }
    }
    if (lot) await appendLotTrace(envelope, lot, client, eventId);
    return;
  }

  if (envelope.event_type === 'stock.received') {
    let lot: LotMaster | null = null;
    if (lotId) {
      const expiryDate = typeof envelope.payload['expiry_date'] === 'string' ? envelope.payload['expiry_date'] : null;
      if (expiryDate) {
        const validationResult = await validateLotForReceipt(lotId, sku, expiryDate, client);
        if (!validationResult.valid) throw toAppError(400, validationResult, 'LOT_VALIDATION_ERROR', 'Lot validation failed');
        lot = await applyLotEvent({ lot_number: lotId, sku, expiry_date: expiryDate }, client);
      } else {
        lot = await getLotByNumberAndSku(lotId, sku, client);
        if (!lot) lot = await applyLotEvent({ lot_number: lotId, sku, expiry_date: null }, client);
      }
    }
    if (serials && serials.length > 0) {
      const serialNumbers = serialNumbersFrom(envelope.payload);
      const validationResult = await validateSerialsForReceipt(sku, serialNumbers, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'SERIAL_VALIDATION_ERROR', 'Serial validation failed');
      const location = await resolveLocation(envelope, client);
      for (const serial of serials) {
        await applySerialReceipt({
          serial_number: serial.serial_number,
          sku,
          lot_id: lotId ?? null,
          current_location_id: location.location_id,
          current_location_code: location.location_code,
          current_quantity: String(serial.initial_quantity ?? 1),
        }, client);
      }
    }
    if (lot) await appendLotTrace(envelope, lot, client, eventId);
    return;
  }

  if (envelope.event_type === 'stock.allocated' && lotId) {
    const overrideExpired = envelope.payload['override_expired_lot'] === true;
    const validationResult = await validateLotForIssueAllocate(lotId, sku, overrideExpired, client);
    if (!validationResult.valid) throw toAppError(400, validationResult, 'LOT_VALIDATION_ERROR', 'Lot validation failed');
    const lot = await getLotByNumberAndSku(lotId, sku, client);
    if (lot) await appendLotTrace(envelope, lot, client, eventId);
  }
}
