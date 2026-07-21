import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLotByNumberAndSku, applyLotEvent, getLotsForSelection, getLotsForFifoSelection } from '../read/projections/lot_master.js';
import type { LotMaster } from '../read/projections/lot_master.js';
import { getSerialByNumberAndSku, serialExistsByNumberAndSku, applySerialReceipt, applySerialIssue } from '../read/projections/serial_master.js';
import type { SerialMaster } from '../read/projections/serial_master.js';
import { getItemBySku } from '../read/projections/item_master.js';
import type { ItemMaster } from '../read/projections/item_master.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';

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
  LOT_REQUIRED: 'LOT_REQUIRED',
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

// Exact-match allowlist, not a substring test: a role string merely containing "quality" or
// "admin" (e.g. "quality_viewer", a read-only role, or "stock_admin_2_3", a test fixture actor)
// must not gain override authority. Extend this set when a new role name is granted override
// authority; actor.role itself is still caller-declared metadata, not cross-checked against a
// server-side RBAC assignment table in this seam (see Story 2.3 re-review decision).
const EXPIRED_LOT_OVERRIDE_ROLES = new Set(['admin', 'super_admin', 'system_administrator', 'quality_officer', 'qc_head', 'qc_inspector']);

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
  // The event write path documents its selection flag as `fefo_mode` (Task 4.2) while the
  // POST /api/v1/stock/:sku/select-lot HTTP contract documents `fifo_mode` (Task 3.3). Accept
  // either key here so a caller that copies the HTTP field name into an event payload still
  // selects a lot instead of silently issuing un-lotted stock.
  const mode = envelope.payload['fefo_mode'] ?? envelope.payload['fifo_mode'];
  if (mode !== 'fefo' && mode !== 'fifo') return null;
  const sku = envelope.payload['sku'] as string;
  const quantity = envelope.payload['quantity'] as number;
  const location = await resolveLocation(envelope, client);
  if (!location.location_id) return null;
  // includeUnavailable=true so a NO_AVAILABLE_LOT rejection can report why each candidate was
  // skipped (held / expired / insufficient quantity), matching the breakdown the HTTP
  // select-lot handler already produces (Task 3.7).
  const allLots =
    mode === 'fifo' ? await getLotsForFifoSelection(sku, client, true) : await getLotsForSelection(sku, client, true);
  // Lock every stock_balance row for this sku+location before picking a lot (not just reading an
  // unlocked snapshot): applyStockBalanceProjection's own FOR UPDATE runs later in this same
  // transaction against the specific lot chosen here, so locking the full candidate set now and
  // deciding fallthrough while holding the lock is what makes a concurrent drain unable to strand
  // the pick on an emptied lot (Story 2.3 re-review).
  const lockResult = await client.query(
    `SELECT lot_id, available FROM stock_balance WHERE sku = $1 AND location_id = $2 FOR UPDATE`,
    [sku, location.location_id],
  );
  const lotBalances = new Map<string, number>();
  for (const row of lockResult.rows) {
    const rowLotId = row['lot_id'] as string | null;
    if (!rowLotId) continue;
    lotBalances.set(rowLotId, (lotBalances.get(rowLotId) ?? 0) + Number(row['available']));
  }
  const today = todayLocalYmd();
  const breakdown = allLots.map((lot) => {
    const available = lotBalances.get(lot.lot_number) ?? 0;
    let reason = 'insufficient_quantity';
    if (lot.quality_hold_status === 'held') reason = 'on_hold';
    else if (lot.expiry_date && lot.expiry_date < today) reason = 'expired';
    return { lot_id: lot.lot_number, lot_number: lot.lot_number, available_quantity: available, reason };
  });
  for (const lot of allLots) {
    if (lot.quality_hold_status !== 'none') continue;
    if (lot.expiry_date && lot.expiry_date < today) continue;
    const available = lotBalances.get(lot.lot_number) ?? 0;
    if (available >= quantity) return lot.lot_number;
  }
  throw new AppError(409, ERROR_CODES.NO_AVAILABLE_LOT, 'No lot has sufficient quantity available', {
    sku,
    location_id: location.location_id,
    requested_quantity: quantity,
    available_lots: breakdown,
  });
}

function quantityChangeFor(envelope: EventEnvelope): string {
  const quantity = envelope.payload['quantity'];
  if (!isPositiveFiniteNumber(quantity)) return '0';
  if (envelope.event_type === 'stock.received') return String(quantity);
  // An allocation reserves stock but moves no physical units (on_hand is unchanged), so it must
  // not contribute a signed depletion to a lot's recall roll-up the way an issue does; recording
  // it as 0 keeps a summed quantity_change equal to the net physical movement (Story 2.3 pass-3).
  if (envelope.event_type === 'stock.allocated') return '0';
  return String(-quantity);
}

async function appendLotTrace(envelope: EventEnvelope, lot: LotMaster, client: PoolClient, eventId: string): Promise<void> {
  const location = await resolveLocation(envelope, client);
  // appendTraceEntry itself is the dedup point (INSERT ... ON CONFLICT (event_id) DO NOTHING) so
  // concurrent inserts for the same event_id cannot both land a row; a separate existence probe
  // beforehand would only be a race-prone optimization, not a correctness requirement.
  await appendTraceEntry({
    lot_id: lot.lot_id,
    event_id: eventId,
    event_type: envelope.event_type,
    sku: lot.sku,
    location_id: location.location_id,
    location_code: location.location_code,
    quantity_change: quantityChangeFor(envelope),
    // assertInventoryTagging (Story 1.5) runs before persistEvent's transaction opens and rejects
    // any inventory-stream event whose business_stream is not a validated non-empty string, so by
    // the time this runs the value is guaranteed present - no String()-coercion fallback needed.
    business_stream: envelope.payload['business_stream'] as string,
    timestamp: envelope.metadata.occurred_at,
  }, client);
}

export function isLotSerialEvent(envelope: EventEnvelope): boolean {
  if (!LOT_SERIAL_STREAM_TYPES.has(envelope.stream_type)) return false;
  if (!LOT_SERIAL_EVENT_TYPES.has(envelope.event_type)) return false;
  if (envelope.event_type === 'stock.issued') return true;
  return envelope.payload['lot_id'] !== undefined || envelope.payload['serials'] !== undefined;
}

export async function validateLotForIssueAllocate(lotNumber: string, sku: string, overrideExpired?: boolean, client?: PoolClient): Promise<LotValidationResult> {
  // Lock the lot_master row for the duration of the issue/allocate transaction so a concurrent
  // PUT/DELETE /quality-hold cannot commit a status change between this read and the balance
  // mutation (Story 2.3 pass-3): the hold's UPDATE blocks on this lock, or, if it committed first,
  // FOR UPDATE returns the held row and the issue is rejected. Only meaningful inside the write
  // transaction, so it is skipped when no client is supplied.
  if (client) {
    await client.query('SELECT 1 FROM lot_master WHERE lot_number = $1 AND sku = $2 FOR UPDATE', [lotNumber, sku]);
  }
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
    throw new AppError(400, 'INVALID_PARAMS', 'sku must be a non-empty string for lot or serial events', { sku: envelope.payload['sku'] ?? null });
  }
  if (envelope.payload['lot_id'] !== undefined && !isNonEmptyString(envelope.payload['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied', { event_type: envelope.event_type });
  }
  if (envelope.payload['expiry_date'] !== undefined && (typeof envelope.payload['expiry_date'] !== 'string' || !DATE_REGEX.test(envelope.payload['expiry_date']))) {
    throw new AppError(400, 'INVALID_PARAMS', 'expiry_date must be YYYY-MM-DD when supplied', { event_type: envelope.event_type });
  }
  if (envelope.payload['override_expired_lot'] === true) {
    const role = envelope.metadata.actor.role;
    if (!EXPIRED_LOT_OVERRIDE_ROLES.has(role)) {
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
  // Gate on the stream/event-type pair, NOT isLotSerialEvent: a lot- or serial-controlled item
  // whose payload omits its traceability anchor (no lot_id, no serials) makes isLotSerialEvent
  // false for a receipt, yet that is exactly the case the control-flag enforcement below must
  // still catch (Story 2.3 pass-3).
  if (!LOT_SERIAL_STREAM_TYPES.has(envelope.stream_type)) return;
  if (!LOT_SERIAL_EVENT_TYPES.has(envelope.event_type)) return;

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

  // Control-flag coverage (Story 2.3 pass-3): an item configured as serial- or lot-controlled must
  // carry the matching traceability anchor on the supply/demand events that move it, regardless of
  // payload shape. Serial control takes precedence - the serial is the unit-level anchor and a
  // serial-controlled receipt legitimately carries no lot_id (AC6) - so the lot requirement applies
  // only to lot-controlled items that are not serial-tracked. stock.allocated is exempt: un-lotted
  // demand-side draws are an established, tested Story 2.2 contract and allocation writes no serial
  // state.
  // Scope enforcement to real stock movements exactly as the stock-balance projection does: an
  // event that references a target location (Story 2.2+ movements), NOT the Story 1.1/1.9 legacy
  // spine fixtures that carry a sku but no target location and never touch the balance projection.
  // Without this gate, a legacy sku-only receipt of a lot-controlled master would be wrongly
  // rejected LOT_REQUIRED (Story 2.3 pass-3).
  const referencesTargetLocation =
    envelope.payload['target_location_id'] !== undefined || envelope.payload['target_location_code'] !== undefined;
  if (referencesTargetLocation && (envelope.event_type === 'stock.received' || envelope.event_type === 'stock.issued')) {
    const controlItem = isNonEmptyString(sku) ? await getItemBySku(sku, client) : null;
    if (controlItem?.serial_controlled && (!serials || serials.length === 0)) {
      throw new AppError(400, ERROR_CODES.SERIAL_REQUIRED, 'Serial-controlled item requires serial numbers', { sku });
    }
    if (controlItem && !controlItem.serial_controlled && controlItem.lot_controlled && !lotId) {
      throw new AppError(400, ERROR_CODES.LOT_REQUIRED, 'Lot-controlled item requires a resolvable lot', { sku });
    }
  }

  if (!isLotSerialEvent(envelope)) return;

  if (envelope.event_type === 'stock.issued') {
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
      // Reconcile against the CURRENT (pre-issue) serial quantities, not the caller-supplied
      // payload.quantity for each serial (issue payloads carry no per-serial quantity) - without
      // this, N serials get zeroed while stock_balance.on_hand drops by whatever `quantity` the
      // caller happened to send, silently diverging the two (Story 2.3 re-review).
      let serialQuantityTotal = 0;
      const serialLots = new Set<string>();
      for (const serialNumber of serialNumbers) {
        const existing = await getSerialByNumberAndSku(serialNumber, sku, client);
        serialQuantityTotal += existing ? Number(existing.current_quantity) : 0;
        if (existing?.lot_id) serialLots.add(existing.lot_id);
      }
      const payloadQuantity = envelope.payload['quantity'] as number;
      if (serialQuantityTotal !== payloadQuantity) {
        throw new AppError(400, 'INVALID_PARAMS', 'Sum of serial current_quantity must equal the event quantity', {
          sku,
          serials: serialNumbers,
          serial_quantity_total: serialQuantityTotal,
          event_quantity: payloadQuantity,
        });
      }
      // When the caller supplied no top-level lot_id, the serials themselves pin the lot, so scope
      // the stock_balance drain to it (Story 2.3 pass-3) instead of letting applyStockIssue drain an
      // arbitrary NULLS-FIRST lot and diverge stock_balance from serial_master. Only when the serials
      // resolve to exactly one lot; a null-lot serial set leaves the un-lotted drain intact.
      let effectiveLotId = lotId;
      if (!effectiveLotId && serialLots.size === 1) {
        effectiveLotId = [...serialLots][0];
        envelope.payload['lot_id'] = effectiveLotId;
      }
      for (const serialNumber of serialNumbers) {
        const updated = await applySerialIssue(serialNumber, sku, location.location_id, effectiveLotId ?? null, client);
        if (!updated) throw new AppError(400, ERROR_CODES.SERIAL_NOT_AVAILABLE, 'Serial number is not available for this issue', { serialNumber, sku });
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
        // Supplying expiry_date signals lot-creation intent: the lot_number must not already
        // exist. applyLotEvent's ON CONFLICT DO NOTHING makes the existence check and the insert
        // one atomic step, so a lost race against a concurrent first-time receipt of the same
        // lot_number and a genuinely pre-existing lot both surface the identical DUPLICATE_LOT
        // here (Story 2.3 re-review), instead of one of them leaking the raw unique-constraint
        // path in store.ts with a differently-shaped error.
        lot = await applyLotEvent({ lot_number: lotId, sku, expiry_date: expiryDate }, client);
        if (!lot) {
          throw new AppError(400, ERROR_CODES.DUPLICATE_LOT, 'Lot already exists', { lotNumber: lotId, sku });
        }
      } else {
        // No expiry_date: an established contract (test/integration/story-2-2.test.ts receipts
        // twice into the same lot_number with no expiry_date and expects both to succeed) treats
        // this as get-or-create - a restock into an existing lot, or a first-time receipt of a lot
        // whose expiry isn't tracked - not a duplicate-lot rejection. Race-safe: a lost concurrent
        // first-creation race re-fetches the winner's row instead of leaking a raw constraint
        // error.
        lot = await getLotByNumberAndSku(lotId, sku, client);
        if (!lot) {
          lot = await applyLotEvent({ lot_number: lotId, sku, expiry_date: null }, client);
          if (!lot) lot = await getLotByNumberAndSku(lotId, sku, client);
        }
      }
    }
    if (serials && serials.length > 0) {
      const serialNumbers = serialNumbersFrom(envelope.payload);
      const validationResult = await validateSerialsForReceipt(sku, serialNumbers, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'SERIAL_VALIDATION_ERROR', 'Serial validation failed');
      // Reconcile the serial rows against the event quantity, mirroring the issue path: without this,
      // a receipt of quantity N carrying M serials (M != N) raises on_hand by N while only M serial
      // rows exist, permanently stranding N-M units the serial-gated issue path can never release
      // (Story 2.3 pass-3).
      const receiptSerialTotal = serials.reduce((sum, serial) => sum + (serial.initial_quantity ?? 1), 0);
      const receiptQuantity = envelope.payload['quantity'] as number;
      if (isPositiveFiniteNumber(receiptQuantity) && receiptSerialTotal !== receiptQuantity) {
        throw new AppError(400, 'INVALID_PARAMS', 'Sum of serial initial_quantity must equal the event quantity', {
          sku,
          serials: serialNumbers,
          serial_quantity_total: receiptSerialTotal,
          event_quantity: receiptQuantity,
        });
      }
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

  if (envelope.event_type === 'stock.allocated' && (lotId || (serials && serials.length > 0))) {
    let lot: LotMaster | null = null;
    if (lotId) {
      const overrideExpired = envelope.payload['override_expired_lot'] === true;
      const validationResult = await validateLotForIssueAllocate(lotId, sku, overrideExpired, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'LOT_VALIDATION_ERROR', 'Lot validation failed');
      lot = await getLotByNumberAndSku(lotId, sku, client);
    }
    if (serials && serials.length > 0) {
      // Allocation has no serial-level "reserved" state to write (serial_master carries only
      // current_location_id/current_quantity, an issue-time concept) - validate existence and
      // availability so a serials array is not silently accepted and dropped, but do not mutate
      // the projection; applySerialIssue only runs when the stock is actually issued.
      const location = await resolveLocation(envelope, client);
      if (!location.location_id) {
        throw new AppError(400, 'INVALID_PARAMS', 'A resolvable target location is required to allocate serial-tracked stock', {
          event_type: envelope.event_type,
          sku,
        });
      }
      const serialNumbers = serialNumbersFrom(envelope.payload);
      const validationResult = await validateSerialsForIssue(sku, serialNumbers, location.location_id, lotId ?? null, client);
      if (!validationResult.valid) throw toAppError(400, validationResult, 'SERIAL_VALIDATION_ERROR', 'Serial validation failed');
    }
    if (lot) await appendLotTrace(envelope, lot, client, eventId);
  }
}
