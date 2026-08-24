import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { addBusinessDays, toIstCalendarDate } from '../lib/business-days.js';
import { getAssetById } from '../read/projections/asset.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationById } from '../read/projections/location_register.js';
import { getWorkOrderById } from '../read/projections/maintenance_work_order.js';
import {
  getSpareCatalogueByGrain,
  insertSpareCatalogue,
} from '../read/projections/maintenance_spare_catalogue.js';
import { getAssetPartByGrain, insertAssetPart } from '../read/projections/asset_parts_list.js';
import {
  applySpareReservationReturn,
  getSpareReservationById,
  getSpareReservationQuantityMatches,
  getSpareReservationReturnExceeds,
  insertSpareReservation,
  markSpareReservationCancelled,
  markSpareReservationIssued,
} from '../read/projections/maintenance_spare_reservation.js';
import {
  getSpareAlertForDay,
  insertSpareAlert,
  type SpareAlertType,
} from '../read/projections/maintenance_spare_alert.js';
import {
  applyStockAllocation,
  applyStockDeallocation,
  applyStockIssue,
  applyStockReceipt,
  getOwnedOnHandAndBelowMin,
} from '../read/projections/stock_balance.js';

/**
 * Story 7.4 compliance seam for spare cataloguing, the maintenance-owned asset parts list, the
 * reserve/issue/return lifecycle and the min-max / overdue-return alerts (FR-M-07, FR-M-08,
 * FR-M-09). Structurally mirrors src/compliance/maintenance-fault.ts.
 *
 * Locking contract: every applier that mutates more than one row takes FOR UPDATE in a FIXED
 * order - asset, catalogue, work order, reservation, then the stock balance rows - so two
 * concurrent commands on the same reservation can never deadlock. The Epic 2 ledger helpers take
 * their own FOR UPDATE internally, so they are always the LAST database calls in an applier.
 *
 * Ledger contract: NO raw stock SQL lives here. Reservation IS stock_balance.allocated; the
 * reservation row records the maintenance-side facts only. Issue releases the allocation BEFORE
 * drawing stock, because applyStockIssue gates on `available` and `available` is already net of
 * this reservation's own allocation - issuing first would compare the requested quantity against
 * stock the reservation itself removed from `available` and fail with a spurious
 * INSUFFICIENT_STOCK whenever the reserved quantity is the only free stock at the location.
 * src/compliance/transfer-request.ts issues before deallocating; that ordering is a known
 * divergence in a flow with slack stock and is deliberately NOT copied here.
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const MAINTENANCE_SPARE_EVENT_TYPES = new Set([
  'maintenance.spare_catalogued',
  'maintenance.asset_part_listed',
  'maintenance.spare_reserved',
  'maintenance.spare_issued',
  'maintenance.spare_returned',
  'maintenance.spare_reservation_cancelled',
  'maintenance.critical_spare_breach_flagged',
  'maintenance.spare_return_overdue_flagged',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// An explicit UTC offset is REQUIRED: a naive timestamp is parsed by JS Date.parse in
// process-local time but cast by pg ::timestamptz in session time, so the stored instant would
// shift when the two differ (the 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A NUMERIC(18,6) literal with at most six decimals. Quantities travel as STRINGS, never JS
// numbers: 0.1 + 0.2 is not 0.3 in binary floating point, and a spare quantity that fails to
// reconcile with stock_balance by 1e-17 is a defect nobody can debug from the ledger.
const NUMERIC_REGEX = /^\d{1,12}(\.\d{1,6})?$/;
// NUMERIC(18,6) ceiling, matching src/compliance/stock-balance.ts. An unbounded quantity would be
// an unmapped 22003 numeric-overflow 500 instead of a stable 400.
const MAX_QUANTITY = 1e12;
const ALERT_TYPES = new Set(['min_breach', 'return_overdue']);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO8601_TIMESTAMP_REGEX.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** A positive NUMERIC quantity string within the column ceiling. */
function isPositiveNumericString(value: unknown): value is string {
  if (typeof value !== 'string' || !NUMERIC_REGEX.test(value)) return false;
  const parsed = Number(value);
  return parsed > 0 && parsed <= MAX_QUANTITY;
}

/** A non-negative NUMERIC level string within the column ceiling (zero is a valid minimum). */
function isNonNegativeNumericString(value: unknown): value is string {
  if (typeof value !== 'string' || !NUMERIC_REGEX.test(value)) return false;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= MAX_QUANTITY;
}

/**
 * Canonical form of a human-entered SKU. Applied in the seam AND in the handler so the direct
 * POST /api/v1/events path cannot bypass it (the Story 7.2 scanned-versus-typed-key lesson).
 * The maintenance module treats SKUs case-insensitively (a scan and a typed entry are the same
 * spare); the Epic 2 item_master/stock_balance are case-sensitive, and that cross-module tension
 * is logged in deferred-work.md as a platform-level decision.
 */
export function canonicalSku(sku: string): string {
  return sku.trim().toLowerCase();
}

export function maintenanceSpareEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!MAINTENANCE_SPARE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertMaintenanceSpareShape(envelope: EventEnvelope): void {
  const type = maintenanceSpareEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'maintenance.spare_catalogued':
      assertSpareCataloguedShape(p);
      break;
    case 'maintenance.asset_part_listed':
      assertAssetPartListedShape(p);
      break;
    case 'maintenance.spare_reserved':
      assertSpareReservedShape(p);
      break;
    case 'maintenance.spare_issued':
      assertSpareIssuedShape(p);
      break;
    case 'maintenance.spare_returned':
      assertSpareReturnedShape(p);
      break;
    case 'maintenance.spare_reservation_cancelled':
      assertSpareReservationCancelledShape(p);
      break;
    case 'maintenance.critical_spare_breach_flagged':
      assertCriticalSpareBreachFlaggedShape(p);
      break;
    case 'maintenance.spare_return_overdue_flagged':
      assertSpareReturnOverdueFlaggedShape(p);
      break;
  }
}

function assertSpareCataloguedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['catalogue_id'])) reject('INVALID_PAYLOAD', 'catalogue_id must be a UUID');
  if (!isNonEmptyString(p['sku'])) reject('INVALID_PAYLOAD', 'sku is required');
  if (!isUuid(p['location_id'])) reject('INVALID_PAYLOAD', 'location_id must be a UUID');
  if (typeof p['is_critical'] !== 'boolean') {
    reject('INVALID_PAYLOAD', 'is_critical must be a boolean');
  }

  const minLevel = p['min_level'];
  const maxLevel = p['max_level'];
  if (minLevel !== null && !isNonNegativeNumericString(minLevel)) {
    reject('INVALID_MIN_MAX', 'min_level must be a non-negative NUMERIC string or null');
  }
  if (maxLevel !== null && !isNonNegativeNumericString(maxLevel)) {
    reject('INVALID_MIN_MAX', 'max_level must be a non-negative NUMERIC string or null');
  }
  if (
    typeof minLevel === 'string' &&
    typeof maxLevel === 'string' &&
    Number(maxLevel) < Number(minLevel)
  ) {
    reject('INVALID_MIN_MAX', 'max_level must be greater than or equal to min_level', {
      min_level: minLevel,
      max_level: maxLevel,
    });
  }
  // Mirrors chk_maintenance_spare_catalogue_critical_needs_min: a critical spare with no minimum
  // would be silently invisible to the FR-M-09 breach scan, which is exactly the failure the
  // acceptance criterion exists to prevent.
  if (p['is_critical'] === true && typeof minLevel !== 'string') {
    reject('INVALID_MIN_MAX', 'a critical spare requires a min_level', { is_critical: true });
  }
}

function assertAssetPartListedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['part_line_id'])) reject('INVALID_PAYLOAD', 'part_line_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (!isNonEmptyString(p['sku'])) reject('INVALID_PAYLOAD', 'sku is required');
  if (!isPositiveNumericString(p['quantity_per'])) {
    reject('INVALID_PAYLOAD', 'quantity_per must be a positive NUMERIC string within 1e12');
  }
  const positionRef = p['position_ref'];
  if (positionRef !== null && !isNonEmptyString(positionRef)) {
    reject('INVALID_PAYLOAD', 'position_ref must be a non-blank string or null');
  }
}

function assertSpareReservedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['reservation_id'])) reject('INVALID_PAYLOAD', 'reservation_id must be a UUID');
  if (!isUuid(p['work_order_id'])) reject('INVALID_PAYLOAD', 'work_order_id must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PAYLOAD', 'asset_id must be a UUID');
  if (!isNonEmptyString(p['sku'])) reject('INVALID_PAYLOAD', 'sku is required');
  if (!isUuid(p['location_id'])) reject('INVALID_PAYLOAD', 'location_id must be a UUID');
  const lotId = p['lot_id'];
  if (lotId !== null && !isNonEmptyString(lotId)) {
    reject('INVALID_PAYLOAD', 'lot_id must be a non-blank string or null');
  }
  if (!isPositiveNumericString(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive NUMERIC string within 1e12');
  }
  if (!isIsoTimestamp(p['reserved_at'])) {
    reject('INVALID_PAYLOAD', 'reserved_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertSpareIssuedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['reservation_id'])) reject('INVALID_PAYLOAD', 'reservation_id must be a UUID');
  if (!isPositiveNumericString(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive NUMERIC string within 1e12');
  }
  if (!isIsoTimestamp(p['issued_at'])) {
    reject('INVALID_PAYLOAD', 'issued_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (!isIsoDate(p['return_due_date'])) {
    reject('INVALID_PAYLOAD', 'return_due_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
}

function assertSpareReturnedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['reservation_id'])) reject('INVALID_PAYLOAD', 'reservation_id must be a UUID');
  if (!isPositiveNumericString(p['quantity_returned'])) {
    reject('INVALID_PAYLOAD', 'quantity_returned must be a positive NUMERIC string within 1e12');
  }
  if (!isIsoTimestamp(p['returned_at'])) {
    reject('INVALID_PAYLOAD', 'returned_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertSpareReservationCancelledShape(p: Record<string, unknown>): void {
  if (!isUuid(p['reservation_id'])) reject('INVALID_PAYLOAD', 'reservation_id must be a UUID');
  if (!isNonEmptyString(p['cancellation_reason'])) {
    reject('INVALID_PAYLOAD', 'cancellation_reason is required and must be non-blank');
  }
  if (!isIsoTimestamp(p['cancelled_at'])) {
    reject('INVALID_PAYLOAD', 'cancelled_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertCriticalSpareBreachFlaggedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['alert_id'])) reject('INVALID_PAYLOAD', 'alert_id must be a UUID');
  if (!isNonEmptyString(p['sku'])) reject('INVALID_PAYLOAD', 'sku is required');
  if (!isUuid(p['location_id'])) reject('INVALID_PAYLOAD', 'location_id must be a UUID');
  if (!isNonNegativeNumericString(p['on_hand_at_check'])) {
    reject('INVALID_PAYLOAD', 'on_hand_at_check must be a non-negative NUMERIC string');
  }
  if (!isNonNegativeNumericString(p['min_level'])) {
    reject('INVALID_PAYLOAD', 'min_level must be a non-negative NUMERIC string');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['flagged_at'])) {
    reject('INVALID_PAYLOAD', 'flagged_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

function assertSpareReturnOverdueFlaggedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['alert_id'])) reject('INVALID_PAYLOAD', 'alert_id must be a UUID');
  if (!isUuid(p['reservation_id'])) reject('INVALID_PAYLOAD', 'reservation_id must be a UUID');
  if (!isNonEmptyString(p['sku'])) reject('INVALID_PAYLOAD', 'sku is required');
  if (!isUuid(p['location_id'])) reject('INVALID_PAYLOAD', 'location_id must be a UUID');
  if (!isIsoDate(p['return_due_date'])) {
    reject('INVALID_PAYLOAD', 'return_due_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoDate(p['business_date'])) {
    reject('INVALID_PAYLOAD', 'business_date must be a YYYY-MM-DD calendar date');
  }
  if (!isIsoTimestamp(p['flagged_at'])) {
    reject('INVALID_PAYLOAD', 'flagged_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

// ---------------------------------------------------------------------------
// In-transaction appliers
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Absolute epoch millis for a timestamp that may arrive as a pg Date object. */
function toEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** ISO string for a timestamp that may arrive as a pg Date object. */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The frozen FR-M-08 return clock. Derived from the ISSUE INSTANT converted to its IST calendar
 * date, never from a bare slice(0, 10) on the ISO string: the two differ for every instant in the
 * 18:30-24:00 UTC window, which is the documented clock-window defect family in this repo.
 */
export function deriveReturnDueDate(issuedAt: string | Date): string {
  const issuedIst = toIstCalendarDate(new Date(toEpochMs(issuedAt)));
  return addBusinessDays(
    issuedIst,
    config.maintenance.spareReturnBusinessDays,
    config.maintenance.spareReturnHolidayCalendar,
  );
}

export async function applyMaintenanceSpareProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = maintenanceSpareEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.spare_catalogued':
      await applySpareCatalogued(envelope, client);
      break;
    case 'maintenance.asset_part_listed':
      await applyAssetPartListed(envelope, client);
      break;
    case 'maintenance.spare_reserved':
      await applySpareReserved(envelope, client);
      break;
    case 'maintenance.spare_issued':
      await applySpareIssued(envelope, client);
      break;
    case 'maintenance.spare_returned':
      await applySpareReturned(envelope, client);
      break;
    case 'maintenance.spare_reservation_cancelled':
      await applySpareReservationCancelled(envelope, client);
      break;
    case 'maintenance.critical_spare_breach_flagged':
      await applySpareAlert(envelope, client, 'min_breach');
      break;
    case 'maintenance.spare_return_overdue_flagged':
      await applySpareAlert(envelope, client, 'return_overdue');
      break;
  }
}

async function applySpareCatalogued(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const sku = canonicalSku(p['sku'] as string);
  const locationId = p['location_id'] as string;

  // FR-I: a maintenance spare must already exist as an ACTIVE item in the Epic 2 item master.
  // Checked here and not only in the handler, so a direct POST /api/v1/events cannot catalogue a
  // spare the stock ledger has never heard of.
  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active') {
    reject('ITEM_NOT_FOUND', 'The SKU does not resolve to an active item_master row', { sku }, 404);
  }

  const location = await getLocationById(locationId, client);
  if (!location) {
    reject('LOCATION_NOT_FOUND', 'The location does not resolve', { location_id: locationId }, 404);
  }

  // FOR UPDATE: two concurrent catalogue writes for the same grain must resolve to one winner;
  // the loser sees the committed row here and rejects with the stable code, matching the 23505
  // resolution so the race path and the sequential path are indistinguishable to the caller.
  const existing = await getSpareCatalogueByGrain(sku, locationId, client, true);
  if (existing) {
    reject(
      'SPARE_ALREADY_CATALOGUED',
      'This spare is already catalogued at this location',
      { sku, location_id: locationId, existing_catalogue_id: existing.catalogue_id },
      409,
    );
  }

  await insertSpareCatalogue(
    {
      catalogue_id: p['catalogue_id'] as string,
      sku,
      location_id: locationId,
      is_critical: p['is_critical'] as boolean,
      min_level: (p['min_level'] as string | null) ?? null,
      max_level: (p['max_level'] as string | null) ?? null,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applyAssetPartListed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const assetId = p['asset_id'] as string;
  const sku = canonicalSku(p['sku'] as string);

  // Lock order step 1: asset.
  const asset = await getAssetById(assetId, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'The asset does not resolve', { asset_id: assetId }, 404);
  }

  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active') {
    reject('ITEM_NOT_FOUND', 'The SKU does not resolve to an active item_master row', { sku }, 404);
  }

  const existing = await getAssetPartByGrain(assetId, sku, client, true);
  if (existing) {
    reject(
      'ASSET_PART_ALREADY_LISTED',
      'This spare is already on the asset parts list',
      { asset_id: assetId, sku, existing_part_line_id: existing.part_line_id },
      409,
    );
  }

  await insertAssetPart(
    {
      part_line_id: p['part_line_id'] as string,
      asset_id: assetId,
      sku,
      quantity_per: p['quantity_per'] as string,
      position_ref: (p['position_ref'] as string | null) ?? null,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applySpareReserved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const workOrderId = p['work_order_id'] as string;
  const declaredAssetId = p['asset_id'] as string;
  const sku = canonicalSku(p['sku'] as string);
  const locationId = p['location_id'] as string;
  const quantity = p['quantity'] as string;
  const lotId = (p['lot_id'] as string | null) ?? null;

  // Lock order step 2: catalogue. The spare must be catalogued at THIS location before it can be
  // reserved - a silent auto-catalogue would let a reservation invent min-max-less inventory
  // policy as a side effect (422, not 404: the SKU may well exist, it is the maintenance-side
  // designation at this location that is missing and that the operator can fix in one POST).
  const catalogue = await getSpareCatalogueByGrain(sku, locationId, client, true);
  if (!catalogue) {
    reject(
      'SPARE_NOT_CATALOGUED',
      'This spare is not catalogued at this location',
      { sku, location_id: locationId },
      422,
    );
  }

  // Lock order step 3: work order.
  const workOrder = await getWorkOrderById(workOrderId, client, true);
  if (!workOrder) {
    reject(
      'WORK_ORDER_NOT_FOUND',
      'The work order does not resolve',
      { work_order_id: workOrderId },
      404,
    );
  }
  if (workOrder.status !== 'open' && workOrder.status !== 'overdue') {
    reject(
      'WORK_ORDER_NOT_OPEN',
      'Spares cannot be reserved against a work order that is no longer open',
      { work_order_id: workOrderId, status: workOrder.status },
      409,
    );
  }
  // asset_id is DECLARED in the payload and CHECKED against the locked work order, never trusted:
  // a declared-but-unchecked field is a silent corruption channel on the direct-event path (the
  // 7.2 Group 2 decision, applied here as it was for the 7.3 work-order derivation).
  if (workOrder.asset_id !== declaredAssetId) {
    reject(
      'SPARE_DERIVATION_MISMATCH',
      'Declared asset_id does not match the work order',
      {
        work_order_id: workOrderId,
        declared_asset_id: declaredAssetId,
        derived_asset_id: workOrder.asset_id,
      },
      409,
    );
  }

  await insertSpareReservation(
    {
      reservation_id: p['reservation_id'] as string,
      work_order_id: workOrderId,
      asset_id: workOrder.asset_id,
      sku,
      location_id: locationId,
      lot_id: lotId,
      quantity,
      reserved_at: p['reserved_at'] as string,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );

  // Lock order step 5, LAST: the Epic 2 ledger. Reservation IS stock_balance.allocated; an
  // INSUFFICIENT_STOCK 409 raised here propagates unchanged because the Epic 2 detail payload
  // (requested versus available, per stock class) is the useful one.
  await applyStockAllocation({ sku, location_id: locationId, lot_id: lotId, quantity }, client);
}

async function applySpareIssued(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const reservationId = p['reservation_id'] as string;
  const declaredQuantity = p['quantity'] as string;
  const issuedAt = p['issued_at'] as string;
  const declaredDueDate = p['return_due_date'] as string;

  const reservation = await getSpareReservationById(reservationId, client, true);
  if (!reservation) {
    reject(
      'RESERVATION_NOT_FOUND',
      'The reservation does not resolve',
      { reservation_id: reservationId },
      404,
    );
  }
  if (reservation.status !== 'reserved') {
    reject(
      'RESERVATION_NOT_RESERVED',
      'Only a reservation in the reserved state can be issued',
      { reservation_id: reservationId, status: reservation.status },
      409,
    );
  }

  // Issue is all-or-nothing on the reserved quantity in Phase 1 (partial issue is out of scope and
  // logged in deferred-work.md), so the declared quantity is CHECKED against the locked row rather
  // than trusted - a divergent value would draw stock the allocation never covered. The equality
  // rides SQL NUMERIC ('5' and '5.00' are equal; a JS float compare is too loose near the ceiling).
  const quantityMatches = await getSpareReservationQuantityMatches(
    reservationId,
    declaredQuantity,
    client,
  );
  if (!quantityMatches) {
    reject(
      'SPARE_DERIVATION_MISMATCH',
      'Declared quantity does not match the reserved quantity',
      {
        reservation_id: reservationId,
        declared_quantity: declaredQuantity,
        derived_quantity: reservation.quantity,
      },
      409,
    );
  }

  const derivedDueDate = deriveReturnDueDate(issuedAt);
  if (declaredDueDate !== derivedDueDate) {
    reject(
      'SPARE_DERIVATION_MISMATCH',
      'Declared return_due_date does not match the derived three-working-day clock',
      {
        reservation_id: reservationId,
        declared_return_due_date: declaredDueDate,
        derived_return_due_date: derivedDueDate,
      },
      409,
    );
  }

  const updated = await markSpareReservationIssued(reservationId, issuedAt, derivedDueDate, client);
  if (updated !== 1) {
    // Never silently no-op on a state the applier should reject: a phantom event with unchanged
    // rows produces dishonest counters and a spurious notification (the 7.2 Group 2 decision).
    reject(
      'RESERVATION_NOT_RESERVED',
      'The reservation left the reserved state before the issue could be applied',
      { reservation_id: reservationId },
      409,
    );
  }

  // DEALLOCATE BEFORE ISSUE. applyStockIssue gates on SUM(available), and `available` is already
  // net of this reservation's own allocation, so issuing first would fail with a spurious
  // INSUFFICIENT_STOCK whenever the reserved quantity is the only free stock at the location.
  const ledgerInput = {
    sku: reservation.sku,
    location_id: reservation.location_id,
    lot_id: reservation.lot_id,
    quantity: reservation.quantity,
  };
  await applyStockDeallocation(ledgerInput, client);
  await applyStockIssue({ ...ledgerInput, occurred_at: toIsoString(issuedAt) }, client);
}

async function applySpareReturned(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const reservationId = p['reservation_id'] as string;
  const quantityReturned = p['quantity_returned'] as string;
  const returnedAt = p['returned_at'] as string;

  const reservation = await getSpareReservationById(reservationId, client, true);
  if (!reservation) {
    reject(
      'RESERVATION_NOT_FOUND',
      'The reservation does not resolve',
      { reservation_id: reservationId },
      404,
    );
  }
  if (reservation.status !== 'issued' && reservation.status !== 'partially_returned') {
    reject(
      'RESERVATION_NOT_ISSUED',
      'Only an issued or partially returned reservation can take a return',
      { reservation_id: reservationId, status: reservation.status },
      409,
    );
  }

  // Rejected, never clamped: a silently truncated return would put stock back that was never
  // issued and leave the ledger permanently over-stated. The over-return probe settles in SQL
  // NUMERIC - 0.1 + 0.2 exceeds 0.3 in binary float but not in NUMERIC, so a valid fractional
  // closing return is accepted here and the DB CHECK settles the same way.
  const exceeds = await getSpareReservationReturnExceeds(reservationId, quantityReturned, client);
  if (exceeds) {
    reject(
      'RETURN_QUANTITY_EXCEEDS_ISSUED',
      'Cumulative returns would exceed the issued quantity',
      {
        reservation_id: reservationId,
        issued_quantity: reservation.quantity,
        already_returned: reservation.quantity_returned,
        requested_return: quantityReturned,
      },
      400,
    );
  }

  const updated = await applySpareReservationReturn(
    reservationId,
    quantityReturned,
    returnedAt,
    client,
  );
  if (updated !== 1) {
    reject(
      'RESERVATION_NOT_ISSUED',
      'The reservation left the issued state before the return could be applied',
      { reservation_id: reservationId },
      409,
    );
  }

  await applyStockReceipt(
    {
      sku: reservation.sku,
      location_id: reservation.location_id,
      lot_id: reservation.lot_id,
      quantity: quantityReturned,
    },
    client,
  );
}

async function applySpareReservationCancelled(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const reservationId = p['reservation_id'] as string;

  const reservation = await getSpareReservationById(reservationId, client, true);
  if (!reservation) {
    reject(
      'RESERVATION_NOT_FOUND',
      'The reservation does not resolve',
      { reservation_id: reservationId },
      404,
    );
  }
  if (reservation.status !== 'reserved') {
    reject(
      'RESERVATION_NOT_RESERVED',
      'Only a reservation in the reserved state can be cancelled',
      { reservation_id: reservationId, status: reservation.status },
      409,
    );
  }

  const updated = await markSpareReservationCancelled(
    reservationId,
    (p['cancellation_reason'] as string).trim(),
    p['cancelled_at'] as string,
    client,
  );
  if (updated !== 1) {
    reject(
      'RESERVATION_NOT_RESERVED',
      'The reservation left the reserved state before the cancellation could be applied',
      { reservation_id: reservationId },
      409,
    );
  }

  // Releases the hold. Without this path an abandoned work order would keep stock_balance.allocated
  // raised forever and the location's `available` would decay permanently.
  await applyStockDeallocation(
    {
      sku: reservation.sku,
      location_id: reservation.location_id,
      lot_id: reservation.lot_id,
      quantity: reservation.quantity,
    },
    client,
  );
}

/**
 * Both alert events share one applier: the row shape, the same-day guard and the duplicate
 * resolution are identical, and only the populated columns differ by type.
 */
async function applySpareAlert(
  envelope: EventEnvelope,
  client: PoolClient,
  alertType: SpareAlertType,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  if (!ALERT_TYPES.has(alertType)) return;

  const p = envelope.payload as Record<string, unknown>;
  const sku = canonicalSku(p['sku'] as string);
  const locationId = p['location_id'] as string;
  const businessDate = p['business_date'] as string;
  const reservationId = alertType === 'return_overdue' ? (p['reservation_id'] as string) : null;

  const existing = await getSpareAlertForDay(
    alertType,
    sku,
    locationId,
    reservationId,
    businessDate,
    client,
  );
  if (existing) {
    reject(
      'DUPLICATE_SPARE_ALERT',
      'An alert of this type already exists for this grain on this business date',
      {
        alert_type: alertType,
        sku,
        location_id: locationId,
        business_date: businessDate,
        existing_alert_id: existing.alert_id,
      },
      409,
    );
  }

  // Re-derive the derivable fields under lock, never trust them from the payload (the Event
  // Contract rule the schema.ts docblocks state): the jobs derive these facts correctly, and the
  // seam is the enforcement point, so a fabricated alert - a non-critical spare, a wrong minimum,
  // a wrong on-hand, a reservation that is not actually overdue - cannot persist and cannot
  // suppress the genuine same-day escalation by occupying the grain.
  if (alertType === 'min_breach') {
    const catalogue = await getSpareCatalogueByGrain(sku, locationId, client, true);
    if (!catalogue || !catalogue.is_critical || catalogue.min_level === null) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'No critical spare with a configured minimum exists for this grain',
        { sku, location_id: locationId },
        409,
      );
    }
    if (p['min_level'] !== catalogue.min_level) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Declared min_level does not match the catalogue minimum',
        {
          sku,
          location_id: locationId,
          declared_min_level: p['min_level'],
          derived_min_level: catalogue.min_level,
        },
        409,
      );
    }
    const balance = await getOwnedOnHandAndBelowMin(sku, locationId, catalogue.min_level, client);
    if (!balance.below) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Owned on-hand is not at or below the minimum for this grain',
        {
          sku,
          location_id: locationId,
          on_hand_at_check: balance.on_hand,
          min_level: catalogue.min_level,
        },
        409,
      );
    }
    if (p['on_hand_at_check'] !== balance.on_hand) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Declared on_hand_at_check does not match the derived owned on-hand',
        {
          sku,
          location_id: locationId,
          declared_on_hand_at_check: p['on_hand_at_check'],
          derived_on_hand_at_check: balance.on_hand,
        },
        409,
      );
    }
  } else {
    const reservation = await getSpareReservationById(reservationId as string, client, true);
    if (!reservation) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'The reservation does not resolve',
        { reservation_id: reservationId },
        409,
      );
    }
    if (reservation.status !== 'issued' && reservation.status !== 'partially_returned') {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Reservation is not open for an overdue-return flag',
        { reservation_id: reservationId, status: reservation.status },
        409,
      );
    }
    if (reservation.return_due_date === null || reservation.return_due_date >= businessDate) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Reservation is not yet overdue for this business date',
        {
          reservation_id: reservationId,
          return_due_date: reservation.return_due_date,
          business_date: businessDate,
        },
        409,
      );
    }
    if (p['return_due_date'] !== reservation.return_due_date) {
      reject(
        'SPARE_DERIVATION_MISMATCH',
        'Declared return_due_date does not match the reservation return clock',
        {
          reservation_id: reservationId,
          declared_return_due_date: p['return_due_date'],
          derived_return_due_date: reservation.return_due_date,
        },
        409,
      );
    }
  }

  await insertSpareAlert(
    {
      alert_id: p['alert_id'] as string,
      alert_type: alertType,
      sku,
      location_id: locationId,
      reservation_id: reservationId,
      on_hand_at_check: alertType === 'min_breach' ? (p['on_hand_at_check'] as string) : null,
      min_level: alertType === 'min_breach' ? (p['min_level'] as string) : null,
      return_due_date: alertType === 'return_overdue' ? (p['return_due_date'] as string) : null,
      business_date: businessDate,
      flagged_at: p['flagged_at'] as string,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers
// ---------------------------------------------------------------------------

/**
 * The race path and the sequential path must return the SAME error code with the SAME existing_*
 * detail (the Story 7.2 lesson). Each resolver below re-reads the winning row so a caller that
 * lost a concurrent race is told exactly what a caller that arrived second sequentially is told.
 */
export async function resolveSpareCatalogueDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sku = typeof payload['sku'] === 'string' ? canonicalSku(payload['sku']) : null;
  const locationId = isUuid(payload['location_id']) ? (payload['location_id'] as string) : null;
  const attempted: Record<string, unknown> = { sku, location_id: locationId };
  if (sku !== null && locationId !== null) {
    const existing = await getSpareCatalogueByGrain(sku, locationId);
    if (existing) {
      return { sku, location_id: locationId, existing_catalogue_id: existing.catalogue_id };
    }
  }
  return attempted;
}

export async function resolveAssetPartDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = isUuid(payload['asset_id']) ? (payload['asset_id'] as string) : null;
  const sku = typeof payload['sku'] === 'string' ? canonicalSku(payload['sku']) : null;
  const attempted: Record<string, unknown> = { asset_id: assetId, sku };
  if (assetId !== null && sku !== null) {
    const existing = await getAssetPartByGrain(assetId, sku);
    if (existing) {
      return { asset_id: assetId, sku, existing_part_line_id: existing.part_line_id };
    }
  }
  return attempted;
}

export async function resolveSpareAlertDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sku = typeof payload['sku'] === 'string' ? canonicalSku(payload['sku']) : null;
  const locationId = isUuid(payload['location_id']) ? (payload['location_id'] as string) : null;
  const businessDate = isIsoDate(payload['business_date'])
    ? (payload['business_date'] as string)
    : null;
  // The alert type is not carried in the payload; it is implied by the reservation link, exactly
  // as the applier derives it from the event type.
  const reservationId = isUuid(payload['reservation_id'])
    ? (payload['reservation_id'] as string)
    : null;
  const alertType: SpareAlertType = reservationId === null ? 'min_breach' : 'return_overdue';
  const attempted: Record<string, unknown> = {
    alert_type: alertType,
    sku,
    location_id: locationId,
    business_date: businessDate,
  };
  if (sku !== null && locationId !== null && businessDate !== null) {
    const existing = await getSpareAlertForDay(
      alertType,
      sku,
      locationId,
      reservationId,
      businessDate,
    );
    if (existing) {
      return { ...attempted, existing_alert_id: existing.alert_id };
    }
  }
  return attempted;
}
