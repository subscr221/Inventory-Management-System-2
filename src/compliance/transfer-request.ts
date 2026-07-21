import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLocationById } from '../read/projections/location_register.js';
import {
  applyStockAllocation,
  applyStockIssue,
  applyStockReceipt,
  applyStockDeallocation,
} from '../read/projections/stock_balance.js';
import type {
  StockAllocationInput,
  StockIssueInput,
  StockReceiptInput,
  StockDeallocationInput,
} from '../read/projections/stock_balance.js';
import {
  insertInTransitRecord,
  decrementInTransit,
  clearInTransitRecord,
  getInTransitByTransferRequest,
} from '../read/projections/in_transit.js';
import {
  insertTransferRequest,
  updateTransferRequestStatus,
  getTransferRequestById,
} from '../read/projections/transfer_request.js';

// ---------------------------------------------------------------------------
// Shape validation helpers
// ---------------------------------------------------------------------------

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const MAX_QUANTITY = 1e12;

// ---------------------------------------------------------------------------
// Task 1: TransferRequestCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferRequestShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_request.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'transfer_request_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['sku_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'sku_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['from_location_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'from_location_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['to_location_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'to_location_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['business_stream'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
  }

  if (p['from_location_id'] === p['to_location_id']) {
    throw new AppError(400, 'INVALID_LOCATION', 'from_location_id and to_location_id must be different');
  }

  if (!isPositiveFiniteNumber(p['quantity'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'quantity is required and must be a positive number');
  }
  if (p['quantity'] > MAX_QUANTITY) {
    throw new AppError(400, 'INVALID_PARAMS', `quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`);
  }

  if (p['lot_id'] !== undefined && !isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied');
  }

  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must be a non-empty array when supplied');
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }

  if (p['notes'] !== undefined && typeof p['notes'] !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'notes must be a string when supplied');
  }
}

// ---------------------------------------------------------------------------
// Task 1: TransferRequestCreated projection (inside transaction)
// ---------------------------------------------------------------------------

export async function applyTransferRequestProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (envelope.event_type !== 'transfer_request.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const skuId = p['sku_id'] as string;
  const quantity = p['quantity'] as number;
  const fromLocationId = p['from_location_id'] as string;
  const toLocationId = p['to_location_id'] as string;
  const lotId = p['lot_id'] as string | undefined ?? null;
  const serialIds = p['serial_ids'] as string[] | undefined ?? null;
  const businessStream = p['business_stream'] as string;
  const notes = p['notes'] as string | undefined ?? null;
  const approverActorId = p['approver_actor_id'] as string | undefined ?? null;

  // Idempotency guard: skip if this transfer_request_id already exists
  const existing = await client.query(
    `SELECT transfer_request_id FROM transfer_request WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  if (existing.rows.length > 0) return;

  // Validate locations
  const fromLocation = await getLocationById(fromLocationId, client);
  if (!fromLocation || fromLocation.status !== 'active') {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'from_location_id does not exist or is not active', {
      from_location_id: fromLocationId,
    });
  }

  const toLocation = await getLocationById(toLocationId, client);
  if (!toLocation || toLocation.status !== 'active') {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'to_location_id does not exist or is not active', {
      to_location_id: toLocationId,
    });
  }

  // Validate lot
  if (lotId) {
    const lotResult = await client.query(
      `SELECT lot_id, sku FROM lot_master WHERE lot_id = $1`,
      [lotId],
    );
    if (lotResult.rows.length === 0) {
      throw new AppError(400, 'LOT_NOT_FOUND', `Lot "${lotId}" not found`, { lot_id: lotId });
    }
    if (lotResult.rows[0].sku !== skuId) {
      throw new AppError(400, 'LOT_SKU_MISMATCH', `Lot "${lotId}" does not belong to SKU "${skuId}"`, {
        lot_id: lotId,
        sku_id: skuId,
      });
    }
  }

  // Validate serials. Existence is checked regardless of whether a lot was supplied (a lot-less
  // serial request must still reference real serials - Story 2.5 review); lot ownership is only
  // enforced when a lot is present.
  if (serialIds && serialIds.length > 0) {
    const serialResult = await client.query(
      `SELECT serial_number, lot_id FROM serial_master WHERE serial_number = ANY($1)`,
      [serialIds],
    );
    if (serialResult.rows.length !== serialIds.length) {
      const foundSet = new Set(serialResult.rows.map((s: { serial_number: string }) => s.serial_number));
      const missing = serialIds.filter((s: string) => !foundSet.has(s));
      throw new AppError(400, 'SERIAL_NOT_FOUND', `Serial numbers not found: ${missing.join(', ')}`, {
        serial_ids: missing,
      });
    }
    if (lotId) {
      for (const s of serialResult.rows) {
        if (s.lot_id !== lotId) {
          throw new AppError(400, 'SERIAL_NOT_AVAILABLE', `Serial "${s.serial_number}" does not belong to lot "${lotId}"`, {
            serial_number: s.serial_number,
            lot_id: lotId,
          });
        }
      }
    }
  }

  // Allocate at the from-location (decrements available = on_hand - allocated)
  // This reserves the quantity for the transfer without decreasing on_hand yet
  const allocationInput: StockAllocationInput = {
    sku: skuId,
    location_id: fromLocationId,
    lot_id: lotId,
    quantity,
  };
  await applyStockAllocation(allocationInput, client);

  // Insert the transfer request row
  await insertTransferRequest(
    {
      transfer_request_id: transferRequestId,
      sku_id: skuId,
      quantity,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      lot_id: lotId,
      serial_ids: serialIds,
      business_stream: businessStream,
      notes,
      // Persist the status the API computed (pending_approval when approval is required,
      // pending_shipment otherwise). Hardcoding it stranded no-approval transfers (Story 2.5 review).
      status: (p['status'] as string) ?? 'pending_approval',
      approver_actor_id: approverActorId,
      correlation_id: envelope.metadata.correlation_id as string,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Task 5: TransferShipCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferShipShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_ship.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'transfer_request_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  if (!isPositiveFiniteNumber(p['shipped_quantity'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'shipped_quantity is required and must be a positive number');
  }
  if (p['shipped_quantity'] > MAX_QUANTITY) {
    throw new AppError(400, 'INVALID_PARAMS', `shipped_quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`);
  }
  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must be a non-empty array when supplied');
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }
  if (!isNonEmptyString(p['correlation_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'correlation_id is required and must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// Task 5: TransferShipCreated projection (inside transaction)
// ---------------------------------------------------------------------------

export async function applyTransferShipProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
): Promise<void> {
  if (envelope.event_type !== 'transfer_ship.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const lotId = p['lot_id'] as string;
  const shippedQuantity = p['shipped_quantity'] as number;
  const correlationId = p['correlation_id'] as string;
  const shipSerialIds = p['serial_ids'] as string[] | undefined ?? null;

  // Lock the transfer request row FIRST so concurrent ships serialize (Story 2.5 review). The
  // in_transit unique constraint on transfer_request_id is the ultimate backstop, but taking the
  // row lock up front turns a double-ship into a clean status check rather than a constraint error.
  const reqRow = await getTransferRequestById(transferRequestId, client, true);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

  // Idempotency guard: a ship already recorded for this transfer is a no-op.
  const existingInTransit = await client.query(
    `SELECT transfer_request_id FROM in_transit WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  if (existingInTransit.rows.length > 0) return;

  // AC4: Must be approved or pending_shipment
  if (reqRow.status !== 'approved' && reqRow.status !== 'pending_shipment') {
    throw new AppError(403, 'APPROVAL_REQUIRED', 'Transfer request must be approved before shipping', {
      current_status: reqRow.status,
    });
  }

  // AC5: Quantity check
  if (shippedQuantity > reqRow.quantity) {
    throw new AppError(
      400,
      'QUANTITY_EXCEEDS_APPROVED',
      `Shipped quantity ${shippedQuantity} exceeds approved quantity ${reqRow.quantity}`,
      { approved_quantity: reqRow.quantity, requested_quantity: shippedQuantity },
    );
  }

  // Lot matching (ship side)
  if (reqRow.lot_id && reqRow.lot_id !== lotId) {
    throw new AppError(400, 'LOT_MISMATCH', `Ship lot_id "${lotId}" does not match request lot_id "${reqRow.lot_id}"`, {
      request_lot_id: reqRow.lot_id,
      ship_lot_id: lotId,
    });
  }

  // Serial traceability: shipped serials must be a subset of the request's serials (Story 2.5 review).
  if (shipSerialIds && reqRow.serial_ids) {
    const requestSet = new Set(reqRow.serial_ids);
    const stray = shipSerialIds.filter((s) => !requestSet.has(s));
    if (stray.length > 0) {
      throw new AppError(400, 'SERIAL_MISMATCH', `Shipped serials are not part of the request: ${stray.join(', ')}`, {
        stray_serials: stray,
      });
    }
  }

  // Source-side stock operations run at the grain the stock was ALLOCATED at - the request's
  // original lot (null for a lot-less request), NOT the shipped lot (Story 2.5 review). The shipped
  // lot is recorded on the in-transit tracking row below and used for receive lot-matching; it is
  // traceability metadata, not the source stock grain. Issuing at the ship lot when the request was
  // lot-less left the allocation stranded and the stock unfindable (INSUFFICIENT_STOCK).
  const sourceLot = reqRow.lot_id;

  // Issue stock from source (decreases on_hand)
  const issueInput: StockIssueInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: sourceLot,
    quantity: shippedQuantity,
  };
  await applyStockIssue(issueInput, client);

  // Release the allocation (allocated decreases, available = on_hand - allocated stays consistent)
  const deallocInput: StockDeallocationInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: sourceLot,
    quantity: shippedQuantity,
  };
  await applyStockDeallocation(deallocInput, client);

  // Increment in_transit at the source location. Direct SQL update since this is a column-level
  // operation. applyStockIssue above guarantees the lot-grain balance row exists; assert the row
  // was matched so a silent balance/tracking divergence cannot occur (Story 2.5 review).
  const inTransitUpdate = await client.query(
    `UPDATE stock_balance
     SET in_transit = in_transit + $1, updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND ($4::text IS NULL OR lot_id = $4)`,
    [shippedQuantity, reqRow.sku_id, reqRow.from_location_id, sourceLot],
  );
  if (inTransitUpdate.rowCount === 0) {
    throw new AppError(500, 'STOCK_BALANCE_MISSING', 'No stock_balance row to record in-transit quantity against', {
      sku: reqRow.sku_id,
      location_id: reqRow.from_location_id,
      lot_id: sourceLot,
    });
  }

  // Record the in-transit row for tracking and querying. ship_event_id is a UUID column, so the
  // real event id must be threaded in (store.ts computes it); the previous 'unknown' fallback threw
  // a UUID syntax error and 500'd every real ship (Story 2.5 review).
  const resolvedEventId = eventId ?? envelope.event_id;
  if (!resolvedEventId) {
    throw new AppError(500, 'EVENT_ID_MISSING', 'ship_event_id could not be resolved for in-transit record');
  }
  await insertInTransitRecord(
    {
      sku_id: reqRow.sku_id,
      location_from: reqRow.from_location_id,
      location_to: reqRow.to_location_id,
      lot_id: lotId,
      quantity: shippedQuantity,
      transfer_request_id: transferRequestId,
      correlation_id: correlationId,
      ship_event_id: resolvedEventId,
    },
    client,
  );

  // Update status to shipped
  await updateTransferRequestStatus(transferRequestId, 'shipped', client);
}

// ---------------------------------------------------------------------------
// Task 6: TransferReceiveCreated shape validation (pre-transaction)
// ---------------------------------------------------------------------------

export function assertTransferReceiveShape(envelope: EventEnvelope): void {
  if (envelope.event_type !== 'transfer_receive.created') return;

  const p = envelope.payload as Record<string, unknown>;

  if (!isNonEmptyString(p['transfer_request_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'transfer_request_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['lot_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
  }
  if (!isPositiveFiniteNumber(p['received_quantity'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'received_quantity is required and must be a positive number');
  }
  if (p['received_quantity'] > MAX_QUANTITY) {
    throw new AppError(400, 'INVALID_PARAMS', `received_quantity exceeds the maximum allowed value of ${MAX_QUANTITY}`);
  }
  if (p['serial_ids'] !== undefined) {
    if (!Array.isArray(p['serial_ids']) || p['serial_ids'].length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must be a non-empty array when supplied');
    }
    for (const s of p['serial_ids']) {
      if (!isNonEmptyString(s)) {
        throw new AppError(400, 'INVALID_PARAMS', 'serial_ids must contain only non-empty strings');
      }
    }
  }
  if (!isNonEmptyString(p['received_at_location_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'received_at_location_id is required and must be a non-empty string');
  }
  if (!isNonEmptyString(p['correlation_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'correlation_id is required and must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// Task 6: TransferReceiveCreated projection (inside transaction)
// ---------------------------------------------------------------------------

export async function applyTransferReceiveProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (envelope.event_type !== 'transfer_receive.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const lotId = p['lot_id'] as string;
  const receivedQuantity = p['received_quantity'] as number;
  const receiveLocationId = p['received_at_location_id'] as string;
  const receiveSerialIds = p['serial_ids'] as string[] | undefined ?? null;

  // Lock the transfer request row so concurrent receives serialize (Story 2.5 review).
  const reqRow = await getTransferRequestById(transferRequestId, client, true);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

  // Must be shipped (or already partially received) to accept a receipt.
  if (reqRow.status !== 'shipped' && reqRow.status !== 'partially_received') {
    throw new AppError(
      400,
      'INVALID_STATE',
      `Transfer request must be in "shipped" or "partially_received" status, current: "${reqRow.status}"`,
    );
  }

  // Validate receive location
  const receiveLocation = await getLocationById(receiveLocationId, client);
  if (!receiveLocation || receiveLocation.status !== 'active') {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'Receive location does not exist or is not active', {
      location_id: receiveLocationId,
    });
  }

  // The in-transit tracking row carries the lot actually shipped, which is the authority for
  // receive lot-matching (a lot-less request is shipped under a concrete lot - Story 2.5 review).
  const inTransitRow = await getInTransitByTransferRequest(transferRequestId, client);
  const shippedLot = inTransitRow?.lot_id ?? reqRow.lot_id;

  // AC6: Lot matching (receive side) - against the shipped lot, not the (possibly null) request lot.
  if (lotId !== shippedLot) {
    throw new AppError(
      400,
      'LOT_MISMATCH',
      `Receive lot_id "${lotId}" does not match shipped lot_id "${shippedLot}"`,
      { ship_lot_id: shippedLot, receive_lot_id: lotId },
    );
  }

  // Receive location must match the approved destination
  if (receiveLocationId !== reqRow.to_location_id) {
    throw new AppError(
      400,
      'INVALID_LOCATION',
      `Receive location does not match the approved destination location`,
      { expected_location_id: reqRow.to_location_id, received_location_id: receiveLocationId },
    );
  }

  // Serial traceability: received serials must be a subset of the request's serials (Story 2.5 review).
  if (receiveSerialIds && reqRow.serial_ids) {
    const requestSet = new Set(reqRow.serial_ids);
    const stray = receiveSerialIds.filter((s) => !requestSet.has(s));
    if (stray.length > 0) {
      throw new AppError(400, 'SERIAL_MISMATCH', `Received serials are not part of the request: ${stray.join(', ')}`, {
        stray_serials: stray,
      });
    }
  }

  // Over-receipt guard: cannot receive more than what remains in transit (Story 2.5 review).
  const remainingInTransit = inTransitRow ? inTransitRow.quantity : 0;
  if (receivedQuantity > remainingInTransit) {
    throw new AppError(
      400,
      'QUANTITY_EXCEEDS_APPROVED',
      `Received quantity ${receivedQuantity} exceeds remaining in-transit quantity ${remainingInTransit}`,
      { remaining_in_transit: remainingInTransit, requested_quantity: receivedQuantity },
    );
  }
  const fullyReceived = receivedQuantity >= remainingInTransit;

  // Reverse in-transit (decrement at source, floored at zero)
  await decrementInTransit(transferRequestId, receivedQuantity, client);

  // Decrement in_transit column at source, at the grain it was incremented (the request's original
  // lot, which equals the shipped lot for a lot-controlled request; null for a lot-less one).
  await client.query(
    `UPDATE stock_balance
     SET in_transit = GREATEST(in_transit - $1, 0), updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND ($4::text IS NULL OR lot_id = $4)`,
    [receivedQuantity, reqRow.sku_id, reqRow.from_location_id, reqRow.lot_id],
  );

  // Receipt at destination: increment on_hand
  const receiptInput: StockReceiptInput = {
    sku: reqRow.sku_id,
    location_id: receiveLocationId,
    location_code: receiveLocation.location_code,
    lot_id: lotId,
    quantity: receivedQuantity,
  };
  await applyStockReceipt(receiptInput, client);

  // Mark received only when the full in-transit quantity has arrived; otherwise keep the transfer
  // receivable in a partially_received state (Story 2.5 review decision). On full receipt the
  // zero-quantity tracking row is removed so it no longer surfaces as in-transit.
  if (fullyReceived) {
    await clearInTransitRecord(transferRequestId, client);
    await updateTransferRequestStatus(transferRequestId, 'received', client);
  } else {
    await updateTransferRequestStatus(transferRequestId, 'partially_received', client);
  }
}

// ---------------------------------------------------------------------------
// Composite compliance entry point called from persistEvent
// ---------------------------------------------------------------------------

export async function assertAndApplyTransferRequestCompliance(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId?: string,
): Promise<void> {
  // Pre-transaction shape validation (throws AppError if invalid)
  assertTransferRequestShape(envelope);
  assertTransferShipShape(envelope);
  assertTransferReceiveShape(envelope);

  // Inside-transaction projection + DB validation
  await applyTransferRequestProjection(envelope, client);
  await applyTransferShipProjection(envelope, client, eventId);
  await applyTransferReceiveProjection(envelope, client);
}