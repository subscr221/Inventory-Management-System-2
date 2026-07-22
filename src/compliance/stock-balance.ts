import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { applyStockReceipt, applyStockAllocation, applyStockIssue } from '../read/projections/stock_balance.js';
import { assertConsignmentReceiptOwnership, SUPPLIER_OWNED_STOCK_CLASSES, OWNER_PARTY_CODE_REGEX } from './ownership.js';

/**
 * Central stock-balance seam (Story 2.2), split in two because the two halves run at different
 * points of persistEvent:
 *
 * - assertStockBalanceShape runs BEFORE any DB work, next to the other compliance asserts, so a
 *   malformed stock event is rejected without consuming an idempotency key or touching the
 *   database at all.
 * - applyStockBalanceProjection runs INSIDE the event transaction, BEFORE the domain_events
 *   insert. It takes the row locks, re-checks availability under the lock (409
 *   INSUFFICIENT_STOCK on shortfall - Task 2.4), and applies the balance change so the event and
 *   its projection update commit or roll back together (Task 2.6). A rejected allocation rolls
 *   the transaction back before the insert, so it writes no event row and consumes no
 *   idempotency key (Task 2.7); a DUPLICATE_EVENT retry rolls back the re-applied balance change,
 *   so the projection changes exactly once (Task 2.8).
 *
 * Gating is deliberately narrow, mirroring src/compliance/inventory-master.ts: only `inventory`
 * stream events of the stock-balance event types whose payload references BOTH a sku and a
 * target location. Legacy inventory shapes - the Story 1.9 spine stock.* events and the Story
 * 1.1 fixtures that carry a sku but no target location - pass through byte-for-byte unaffected,
 * as do all non-inventory streams. stock.allocation_released (releasing an allocation back to
 * available) is reserved for the story that introduces cancellation flows and is intentionally
 * not accepted yet.
 */

const STOCK_BALANCE_STREAM_TYPES = new Set(['inventory']);

type StockBalanceEventKind = 'receipt' | 'allocation' | 'issue';

const STOCK_BALANCE_EVENT_KINDS: Record<string, StockBalanceEventKind> = {
  'stock.received': 'receipt',
  'stock.allocated': 'allocation',
  'stock.issued': 'issue',
};

/** ponytail: known set, extend when new stock classes are introduced (Story 2.8, etc.) */
const VALID_STOCK_CLASSES = new Set(['owned', 'consignment', 'vmi', 'job_work']);

/** ponytail: NUMERIC(18,6) ceiling, prevents Postgres overflow on insert/update */
const MAX_QUANTITY = 1e12;

/** The DB-touching lookups, injectable so unit tests can exercise branching without a database. */
export interface StockBalanceDeps {
  getLocationById: (locationId: string, client?: PoolClient) => Promise<LocationRegisterEntry | null>;
  getLocationByCode: (locationCode: string, client?: PoolClient) => Promise<LocationRegisterEntry | null>;
}

const defaultDeps: StockBalanceDeps = {
  getLocationById,
  getLocationByCode,
};

export function stockBalanceEventKind(envelope: EventEnvelope): StockBalanceEventKind | null {
  if (!STOCK_BALANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  const kind = STOCK_BALANCE_EVENT_KINDS[envelope.event_type];
  if (!kind) return null;
  const referencesMasters =
    envelope.payload['sku'] !== undefined &&
    (envelope.payload['target_location_id'] !== undefined || envelope.payload['target_location_code'] !== undefined);
  return referencesMasters ? kind : null;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Non-DB shape validation for gated stock-balance events. SKU/location existence, active status,
 * actor location, and zone compatibility are already inherited from
 * assertInventoryMasterReferences because stock payloads reuse the same field names (Task 2.3).
 */
export function assertStockBalanceShape(envelope: EventEnvelope): void {
  const kind = stockBalanceEventKind(envelope);
  if (!kind) return;

  if (!isPositiveFiniteNumber(envelope.payload['quantity'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'quantity is required and must be a positive number for stock balance events', {
      event_type: envelope.event_type,
      quantity: envelope.payload['quantity'] ?? null,
    });
  }
  if (envelope.payload['quantity'] > MAX_QUANTITY) {
    throw new AppError(400, 'INVALID_PARAMS', `quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`, {
      event_type: envelope.event_type,
      quantity: envelope.payload['quantity'],
    });
  }
  const targetLocationId = envelope.payload['target_location_id'];
  const targetLocationCode = envelope.payload['target_location_code'];
  if (targetLocationId !== undefined && typeof targetLocationId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'target_location_id must be a string when supplied', {
      event_type: envelope.event_type,
    });
  }
  if (targetLocationCode !== undefined && typeof targetLocationCode !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'target_location_code must be a string when supplied', {
      event_type: envelope.event_type,
    });
  }
  if (envelope.payload['available'] !== undefined) {
    throw new AppError(400, 'INVALID_PARAMS', 'available is derived from the projection (on_hand - allocated) and must not be supplied', {
      event_type: envelope.event_type,
    });
  }
  if (envelope.payload['lot_id'] !== undefined && (typeof envelope.payload['lot_id'] !== 'string' || envelope.payload['lot_id'].trim().length === 0)) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied', {
      event_type: envelope.event_type,
    });
  }
  if (kind === 'receipt' && envelope.payload['unit_cost'] !== undefined) {
    const unitCost = envelope.payload['unit_cost'];
    if (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'unit_cost must be a non-negative number when supplied', {
        event_type: envelope.event_type,
      });
    }
  }
  if (envelope.payload['stock_class'] !== undefined) {
    const stockClass = envelope.payload['stock_class'];
    if (typeof stockClass !== 'string' || !VALID_STOCK_CLASSES.has(stockClass)) {
      throw new AppError(400, 'INVALID_PARAMS', `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`, {
        event_type: envelope.event_type,
        stock_class: stockClass,
      });
    }
    // Story 2.8: a supplier-owned receipt (consignment/vmi) must carry a well-formed
    // owner_party_code; the in-transaction gate then matches it against the active ownership
    // agreement. This is the non-DB half, so a malformed receipt never consumes an idempotency key.
    if (kind === 'receipt' && SUPPLIER_OWNED_STOCK_CLASSES.has(stockClass)) {
      const ownerPartyCode = envelope.payload['owner_party_code'];
      const trimmedOwnerPartyCode = typeof ownerPartyCode === 'string' ? ownerPartyCode.trim() : ownerPartyCode;
      if (typeof trimmedOwnerPartyCode !== 'string' || !OWNER_PARTY_CODE_REGEX.test(trimmedOwnerPartyCode)) {
        throw new AppError(400, 'INVALID_PARAMS', `owner_party_code is required for a ${stockClass} receipt and must be 2-32 uppercase alphanumeric/hyphen characters`, {
          event_type: envelope.event_type,
          stock_class: stockClass,
          owner_party_code: typeof ownerPartyCode === 'string' ? ownerPartyCode : null,
        });
      }
      envelope.payload['owner_party_code'] = trimmedOwnerPartyCode;
    }
  }
}

/**
 * Applies the stock-balance change for a gated event on the transaction client that will insert
 * the domain event. Resolves the target location inside the transaction (the pre-transaction
 * master check already validated existence/active/zone); throws 409 INSUFFICIENT_STOCK for an
 * allocation the locked balance cannot cover.
 */
export async function applyStockBalanceProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  deps: StockBalanceDeps = defaultDeps,
): Promise<void> {
  const kind = stockBalanceEventKind(envelope);
  if (!kind) return;

  // ponytail: idempotency guard — the projection runs before the domain_events INSERT that
  // would trigger the uq_idempotency constraint, so an allocation retry after stock depletion
  // would see available=0 and throw INSUFFICIENT_STOCK before reaching DUPLICATE_EVENT.
  // Check the idempotency key and event_id here so the projection is a no-op on retry,
  // letting the subsequent INSERT produce the correct DUPLICATE_EVENT.
  if (envelope.idempotency_key || envelope.event_id) {
    const existing = await client.query(
      `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
      [envelope.idempotency_key ?? null, envelope.event_id ?? null],
    );
    if (existing.rows.length > 0) return;
  }

  const targetLocationId = envelope.payload['target_location_id'];
  const targetLocationCode = envelope.payload['target_location_code'];
  const location =
    typeof targetLocationId === 'string'
      ? await deps.getLocationById(targetLocationId, client)
      : await deps.getLocationByCode(targetLocationCode as string, client);
  if (!location) {
    // Normally unreachable - assertInventoryMasterReferences rejected unknown locations before
    // the transaction opened - but a concurrent hard delete must fail closed, not corrupt state.
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'The stock event target location is no longer registered', {
      target_location_id: typeof targetLocationId === 'string' ? targetLocationId : null,
      target_location_code: typeof targetLocationCode === 'string' ? targetLocationCode : null,
    });
  }

  const sku = envelope.payload['sku'] as string;
  const quantity = envelope.payload['quantity'] as number;
  const lotId = typeof envelope.payload['lot_id'] === 'string' ? envelope.payload['lot_id'] : null;

  const stockClass = typeof envelope.payload['stock_class'] === 'string' ? envelope.payload['stock_class'] : 'owned';

  if (kind === 'receipt') {
    // Story 2.8: consignment/vmi receipts must match the single active ownership agreement for
    // their grain (owner-party validation) BEFORE any balance mutates. Runs here so every write
    // path - HTTP handler, direct POST /api/v1/events, edge upload - is gated identically.
    await assertConsignmentReceiptOwnership(envelope, stockClass, sku, location.location_id, client);
    await applyStockReceipt(
      {
        sku,
        location_id: location.location_id,
        location_code: location.location_code,
        lot_id: lotId,
        stock_class: stockClass,
        quantity,
      },
      client,
    );
    return;
  }

  if (kind === 'allocation') {
    await applyStockAllocation({ sku, location_id: location.location_id, lot_id: lotId, stock_class: stockClass, quantity }, client);
    return;
  }

  await applyStockIssue(
    { sku, location_id: location.location_id, lot_id: lotId, stock_class: stockClass, quantity, occurred_at: envelope.metadata.occurred_at },
    client,
  );
}
