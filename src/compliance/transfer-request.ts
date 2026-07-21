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
      throw new AppError(400, 'LOT_MISMATCH', `Lot "${lotId}" does not belong to SKU "${skuId}"`, {
        lot_id: lotId,
        sku_id: skuId,
      });
    }
  }

  // Validate serials
  if (serialIds && serialIds.length > 0 && lotId) {
    const serialResult = await client.query(
      `SELECT serial_number, lot_id FROM serial_master WHERE serial_number = ANY($1)`,
      [serialIds],
    );
    if (serialResult.rows.length !== serialIds.length) {
      const foundSet = new Set(serialResult.rows.map((s: any) => s.serial_number));
      const missing = serialIds.filter((s: string) => !foundSet.has(s));
      throw new AppError(400, 'SERIAL_NOT_FOUND', `Serial numbers not found: ${missing.join(', ')}`, {
        serial_ids: missing,
      });
    }
    for (const s of serialResult.rows) {
      if (s.lot_id !== lotId) {
        throw new AppError(400, 'SERIAL_NOT_AVAILABLE', `Serial "${s.serial_number}" does not belong to lot "${lotId}"`, {
          serial_number: s.serial_number,
          lot_id: lotId,
        });
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
status: 'pending_approval',
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
): Promise<void> {
  if (envelope.event_type !== 'transfer_ship.created') return;

  const p = envelope.payload as Record<string, unknown>;
  const transferRequestId = p['transfer_request_id'] as string;
  const lotId = p['lot_id'] as string;
  const shippedQuantity = p['shipped_quantity'] as number;
  const correlationId = p['correlation_id'] as string;

  // Idempotency guard: check if in_transit record already exists
  const existingInTransit = await client.query(
    `SELECT transfer_request_id FROM in_transit WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  if (existingInTransit.rows.length > 0) return;

  // Fetch transfer request to validate state and quantities
  const reqRow = await getTransferRequestById(transferRequestId, client);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

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

  // Issue stock from source (decreases on_hand)
  const issueInput: StockIssueInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: lotId,
    quantity: shippedQuantity,
  };
  await applyStockIssue(issueInput, client);

  // Release the allocation (allocated decreases, available = on_hand - allocated stays consistent)
  const deallocInput: StockDeallocationInput = {
    sku: reqRow.sku_id,
    location_id: reqRow.from_location_id,
    lot_id: lotId,
    quantity: shippedQuantity,
  };
  await applyStockDeallocation(deallocInput, client);

  // Increment in_transit at the source location
  // Direct SQL update since this is a column-level operation
  await client.query(
    `UPDATE stock_balance
     SET in_transit = in_transit + $1, updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND ($4::text IS NULL OR lot_id = $4)`,
    [shippedQuantity, reqRow.sku_id, reqRow.from_location_id, lotId],
  );

  // Record the in-transit row for tracking and querying
  const eventId = envelope.event_id ?? 'unknown';
  await insertInTransitRecord(
    {
      sku_id: reqRow.sku_id,
      location_from: reqRow.from_location_id,
      location_to: reqRow.to_location_id,
      lot_id: lotId,
      quantity: shippedQuantity,
transfer_request_id: transferRequestId,
       correlation_id: correlationId,
       ship_event_id: eventId,
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

  // Fetch transfer request to validate state
  const reqRow = await getTransferRequestById(transferRequestId, client);
  if (!reqRow) {
    throw new AppError(404, 'NOT_FOUND', `Transfer request "${transferRequestId}" not found`);
  }

  // Must be shipped first
  if (reqRow.status !== 'shipped') {
    throw new AppError(
      400,
      'INVALID_STATE',
      `Transfer request must be in "shipped" status, current: "${reqRow.status}"`,
    );
  }

  // Validate receive location
  const receiveLocation = await getLocationById(receiveLocationId, client);
  if (!receiveLocation || receiveLocation.status !== 'active') {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'Receive location does not exist or is not active', {
      location_id: receiveLocationId,
    });
  }

  // AC6: Lot matching (receive side)
  if (lotId !== reqRow.lot_id) {
    throw new AppError(
      400,
      'LOT_MISMATCH',
      `Receive lot_id "${lotId}" does not match shipped lot_id "${reqRow.lot_id}"`,
      { ship_lot_id: reqRow.lot_id, receive_lot_id: lotId },
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

  // Reverse in-transit (decrement at source, zero when fully received)
  await decrementInTransit(transferRequestId, receivedQuantity, client);

  // Decrement in_transit column at source
  await client.query(
    `UPDATE stock_balance
     SET in_transit = GREATEST(in_transit - $1, 0), updated_at = now()
     WHERE sku = $2 AND location_id = $3 AND ($4::text IS NULL OR lot_id = $4)`,
    [receivedQuantity, reqRow.sku_id, reqRow.from_location_id, lotId],
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

  // Update status to received
  await updateTransferRequestStatus(transferRequestId, 'received', client);
}

// ---------------------------------------------------------------------------
// Composite compliance entry point called from persistEvent
// ---------------------------------------------------------------------------

export async function assertAndApplyTransferRequestCompliance(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  // Pre-transaction shape validation (throws AppError if invalid)
  assertTransferRequestShape(envelope);
  assertTransferShipShape(envelope);
  assertTransferReceiveShape(envelope);

  // Inside-transaction projection + DB validation
  await applyTransferRequestProjection(envelope, client);
  await applyTransferShipProjection(envelope, client);
  await applyTransferReceiveProjection(envelope, client);
}