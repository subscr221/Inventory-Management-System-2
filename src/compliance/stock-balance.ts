import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import {
  applyStockReceipt,
  applyStockAllocation,
  applyStockIssue,
} from '../read/projections/stock_balance.js';
import {
  assertConsignmentReceiptOwnership,
  SUPPLIER_OWNED_STOCK_CLASSES,
  OWNER_PARTY_CODE_REGEX,
} from './ownership.js';

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

/**
 * ponytail: known set, extend when new stock classes are introduced (Story 2.8, etc.)
 *
 * DUPLICATED in src/compliance/cycle-count.ts - the two sets must be extended together, and the
 * duplication is the trap: a class added here alone is refused INVALID_PARAMS by every count path.
 *
 * Story 8.8 BSD-9: 'prototype' is an ORIGIN class, not a quality state. A prior binding decision
 * ruled that this platform has NO separate blocked-stock class - blocked stock is
 * gate_status = 'rejected' plus lot_master.quality_hold_status = 'held', which is a QUALITY STATE
 * and correctly belongs on the lot and the gate. 'prototype' is a different kind of thing: it
 * describes where the stock came from and what it may ever become, exactly like 'consignment',
 * 'vmi' and 'job_work'. Prototype stock is never "released" into 'owned'; non-saleability is a
 * permanent property of that balance row, which is why the bar below is structural rather than a
 * clearable flag.
 */
const VALID_STOCK_CLASSES = new Set(['owned', 'consignment', 'vmi', 'job_work', 'prototype']);

/** FR-Q-12: prototype stock can never be allocated, nor laundered into an owned balance row. */
const NON_SALEABLE_STOCK_CLASSES = new Set(['prototype']);

/** ponytail: NUMERIC(18,6) ceiling, prevents Postgres overflow on insert/update */
const MAX_QUANTITY = 1e12;

/** The DB-touching lookups, injectable so unit tests can exercise branching without a database. */
export interface StockBalanceDeps {
  getLocationById: (
    locationId: string,
    client?: PoolClient,
  ) => Promise<LocationRegisterEntry | null>;
  getLocationByCode: (
    locationCode: string,
    client?: PoolClient,
  ) => Promise<LocationRegisterEntry | null>;
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
    (envelope.payload['target_location_id'] !== undefined ||
      envelope.payload['target_location_code'] !== undefined);
  return referencesMasters ? kind : null;
}

function isPositiveFiniteNumber(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && !/^0+(\.0+)?$/.test(value);
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
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'quantity is required and must be a positive number for stock balance events',
      {
        event_type: envelope.event_type,
        quantity: envelope.payload['quantity'] ?? null,
      },
    );
  }
  if (
    typeof envelope.payload['quantity'] === 'number' &&
    envelope.payload['quantity'] > MAX_QUANTITY
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`,
      {
        event_type: envelope.event_type,
        quantity: envelope.payload['quantity'],
      },
    );
  }
  const targetLocationId = envelope.payload['target_location_id'];
  const targetLocationCode = envelope.payload['target_location_code'];
  if (targetLocationId !== undefined && typeof targetLocationId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'target_location_id must be a string when supplied', {
      event_type: envelope.event_type,
    });
  }
  if (targetLocationCode !== undefined && typeof targetLocationCode !== 'string') {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'target_location_code must be a string when supplied',
      {
        event_type: envelope.event_type,
      },
    );
  }
  if (envelope.payload['available'] !== undefined) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'available is derived from the projection (on_hand - allocated) and must not be supplied',
      {
        event_type: envelope.event_type,
      },
    );
  }
  if (
    envelope.payload['lot_id'] !== undefined &&
    (typeof envelope.payload['lot_id'] !== 'string' ||
      envelope.payload['lot_id'].trim().length === 0)
  ) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied', {
      event_type: envelope.event_type,
    });
  }
  if (kind === 'receipt' && envelope.payload['unit_cost'] !== undefined) {
    const unitCost = envelope.payload['unit_cost'];
    if (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'unit_cost must be a non-negative number when supplied',
        {
          event_type: envelope.event_type,
        },
      );
    }
  }
  if (envelope.payload['stock_class'] !== undefined) {
    const stockClass = envelope.payload['stock_class'];
    if (typeof stockClass !== 'string' || !VALID_STOCK_CLASSES.has(stockClass)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`,
        {
          event_type: envelope.event_type,
          stock_class: stockClass,
        },
      );
    }
    // Story 2.8: a supplier-owned receipt (consignment/vmi) must carry a well-formed
    // owner_party_code; the in-transaction gate then matches it against the active ownership
    // agreement. This is the non-DB half, so a malformed receipt never consumes an idempotency key.
    if (kind === 'receipt' && SUPPLIER_OWNED_STOCK_CLASSES.has(stockClass)) {
      const ownerPartyCode = envelope.payload['owner_party_code'];
      const trimmedOwnerPartyCode =
        typeof ownerPartyCode === 'string' ? ownerPartyCode.trim() : ownerPartyCode;
      if (
        typeof trimmedOwnerPartyCode !== 'string' ||
        !OWNER_PARTY_CODE_REGEX.test(trimmedOwnerPartyCode)
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          `owner_party_code is required for a ${stockClass} receipt and must be 2-32 uppercase alphanumeric/hyphen characters`,
          {
            event_type: envelope.event_type,
            stock_class: stockClass,
            owner_party_code: typeof ownerPartyCode === 'string' ? ownerPartyCode : null,
          },
        );
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
    throw new AppError(
      400,
      'LOCATION_NOT_FOUND',
      'The stock event target location is no longer registered',
      {
        target_location_id: typeof targetLocationId === 'string' ? targetLocationId : null,
        target_location_code: typeof targetLocationCode === 'string' ? targetLocationCode : null,
      },
    );
  }

  const sku = envelope.payload['sku'] as string;
  const quantity = envelope.payload['quantity'] as string | number;
  const lotId = typeof envelope.payload['lot_id'] === 'string' ? envelope.payload['lot_id'] : null;

  const stockClass =
    typeof envelope.payload['stock_class'] === 'string' ? envelope.payload['stock_class'] : 'owned';

  // ---------------------------------------------------------------------------
  // Story 8.8 AC 3 (FR-Q-12): prototype stock is structurally barred from sellable status.
  //
  // This is the SINGLE choke point every stock write path funnels through - the HTTP handler,
  // POST /api/v1/events, and the edge upload - which is the same rationale documented for the
  // Story 2.8 ownership gate above. A guard placed in a route instead would be bypassable by two
  // of those three paths (AD-12).
  //
  // BSD-11: there is no reclassification event in the system today and this story does not mint
  // one, so both halves of "move to sellable status or allocate to a dispatch" are expressed
  // against the transactions that DO exist:
  //   1. an allocation of prototype-class stock is refused outright, and
  //   2. an 'owned'-class write for a (sku, location_id, lot_id) that already holds a prototype
  //      balance is refused - without this arm a plain receipt into 'owned' for the same lot
  //      silently launders prototype stock into saleable stock.
  // A future reclassification event must route through this same guard.
  //
  // BSD-12: PROTOTYPE_NOT_SALEABLE is deliberately NOT in AUDITED_REJECTIONS. That set is the
  // Epic 8 convention for refused quality DECISIONS raised by routes in src/api/v1/quality.ts;
  // this code is raised from the Story 2.2/2.8 stock surface, which carries no audit machinery -
  // the same carve-out already documented there for QUALITY_HOLD_GOVERNED. The omission is a
  // decision, not the Story 8.3 NCR_EXISTS lesson repeating.
  if (NON_SALEABLE_STOCK_CLASSES.has(stockClass) && kind === 'allocation') {
    throw new AppError(
      400,
      'PROTOTYPE_NOT_SALEABLE',
      `Stock in the ${stockClass} class can never be allocated to a dispatch`,
      { sku, stock_class: stockClass, lot_id: lotId, location_id: location.location_id },
    );
  }
  // Code review 2026-09-02: the check below is check-then-act, so both sides of a laundering pair
  // (a prototype receipt and an owned receipt) must serialize on the same transaction-scoped
  // advisory lock - a plain SELECT under READ COMMITTED lets two concurrent transactions each see
  // no conflicting row and both commit. Key on (sku, lot_id) - the lot-level grain the guard now
  // enforces - falling back to (sku, location_id) for lot-less balances.
  if (
    kind === 'receipt' &&
    (stockClass === 'owned' || NON_SALEABLE_STOCK_CLASSES.has(stockClass))
  ) {
    const guardKey =
      lotId !== null
        ? `stock_class_guard:${sku}:lot:${lotId}`
        : `stock_class_guard:${sku}:loc:${location.location_id}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 8808))`, [guardKey]);
  }
  // Code review 2026-09-02 (widening BSD-11 per review decision): the laundering bar is LOT-level,
  // not one (sku, location, lot) row - transferring the prototype stock away and receiving 'owned'
  // for the same lot anywhere must still refuse. Lot-less prototype balances stay grain-scoped by
  // (sku, location). The arm applies to receipts only (inflows): issues and allocations of a
  // legitimately coexisting owned balance must not be frozen by a neighbouring prototype row.
  if (stockClass === 'owned' && kind === 'receipt') {
    const prototypeBalance = await client.query(
      lotId !== null
        ? `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND lot_id = $2 AND stock_class = ANY($3::text[])
            LIMIT 1`
        : `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND location_id = $2 AND lot_id IS NULL
              AND stock_class = ANY($3::text[])
            LIMIT 1`,
      lotId !== null
        ? [sku, lotId, [...NON_SALEABLE_STOCK_CLASSES]]
        : [sku, location.location_id, [...NON_SALEABLE_STOCK_CLASSES]],
    );
    if (prototypeBalance.rows.length > 0) {
      throw new AppError(
        400,
        'PROTOTYPE_NOT_SALEABLE',
        'This lot already holds a non-saleable prototype balance and cannot be moved to owned stock',
        {
          sku,
          lot_id: lotId,
          location_id: location.location_id,
          existing_stock_class: (prototypeBalance.rows[0] as { stock_class: string }).stock_class,
        },
      );
    }
  }
  // Code review 2026-09-02 round 2: the symmetric arm. Without it the bar is order-dependent -
  // owned-then-prototype receipt ordering commits the same coexisting owned+prototype state that
  // prototype-then-owned refuses. A lot is prototype from birth or it is not; a prototype receipt
  // into a lot already carrying a saleable-class balance is refused with the same code.
  if (NON_SALEABLE_STOCK_CLASSES.has(stockClass) && kind === 'receipt') {
    const saleableBalance = await client.query(
      lotId !== null
        ? `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND lot_id = $2 AND NOT (stock_class = ANY($3::text[]))
            LIMIT 1`
        : `SELECT stock_class FROM stock_balance
            WHERE sku = $1 AND location_id = $2 AND lot_id IS NULL
              AND NOT (stock_class = ANY($3::text[]))
            LIMIT 1`,
      lotId !== null
        ? [sku, lotId, [...NON_SALEABLE_STOCK_CLASSES]]
        : [sku, location.location_id, [...NON_SALEABLE_STOCK_CLASSES]],
    );
    if (saleableBalance.rows.length > 0) {
      throw new AppError(
        400,
        'PROTOTYPE_NOT_SALEABLE',
        'This lot already holds a saleable-class balance and cannot receive prototype stock',
        {
          sku,
          lot_id: lotId,
          location_id: location.location_id,
          existing_stock_class: (saleableBalance.rows[0] as { stock_class: string }).stock_class,
        },
      );
    }
  }

  if (kind === 'receipt') {
    // Story 2.8: consignment/vmi receipts must match the single active ownership agreement for
    // their grain (owner-party validation) BEFORE any balance mutates. Runs here so every write
    // path - HTTP handler, direct POST /api/v1/events, edge upload - is gated identically.
    await assertConsignmentReceiptOwnership(
      envelope,
      stockClass,
      sku,
      location.location_id,
      client,
    );
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
    await applyStockAllocation(
      { sku, location_id: location.location_id, lot_id: lotId, stock_class: stockClass, quantity },
      client,
    );
    return;
  }

  await applyStockIssue(
    {
      sku,
      location_id: location.location_id,
      lot_id: lotId,
      stock_class: stockClass,
      quantity,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}
