import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { randomUUID } from 'node:crypto';

import type { TransferRequestRow } from '../../read/projections/transfer_request.js';
import {
  getTransferRequestById,
  getTransferRequests,
  getInTransitBalances,
} from '../../read/projections/transfer_request.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
} from '../../read/projections/doa_registry.js';
import { getItemBySku } from '../../read/projections/item_master.js';
import { getLocationById } from '../../read/projections/location_register.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRANSFER_REQUEST_DOA_TYPE = 'transfer_request';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

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

function auditCtxFor(
  req: IncomingMessage,
  actor: ActorContext,
  httpStatus: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
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

// ---------------------------------------------------------------------------
// Task 3: POST /api/v1/transfer-requests - Create transfer request
// ---------------------------------------------------------------------------

const createTransferRequestBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  if (!isNonEmptyString(body['sku_id'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku_id is required and must be a non-empty string');
    return;
  }
  if (!isNonEmptyString(body['from_location_id']) || !UUID_REGEX.test(body['from_location_id'] as string)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'from_location_id is required and must be a valid UUID');
    return;
  }
  if (!isNonEmptyString(body['to_location_id']) || !UUID_REGEX.test(body['to_location_id'] as string)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'to_location_id is required and must be a valid UUID');
    return;
  }
  if (!isPositiveFiniteNumber(body['quantity'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'quantity is required and must be a positive number');
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
    return;
  }

  const skuId = body['sku_id'] as string;
  const fromLocationId = body['from_location_id'] as string;
  const toLocationId = body['to_location_id'] as string;
  const quantity = body['quantity'] as number;
  const businessStream = body['business_stream'] as string;
  const lotId = body['lot_id'] !== undefined ? (body['lot_id'] as string) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  if (fromLocationId === toLocationId) {
    sendRequestError(req, res, 400, 'INVALID_LOCATION', 'from_location_id and to_location_id must be different');
    return;
  }

  const actor = actorContext(req);
  const transferRequestId = randomUUID();
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Validate within transaction for consistency
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

    const item = await getItemBySku(skuId);
    if (!item) {
      throw new AppError(404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${skuId}"`, { sku: skuId });
    }

    // Validate lot if provided
    let validatedLotId: string | null = null;
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
      validatedLotId = lotId;

      if (serialIds && serialIds.length > 0) {
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
    }

    // DOA resolution
    const doaEntry = await findMatchingDoaEntry(TRANSFER_REQUEST_DOA_TYPE, quantity);
    let approverActorId: string | null = null;
    let requiresApproval = false;

    if (doaEntry) {
      requiresApproval = true;
      const holder = await findRoleHolder(doaEntry.role);
      if (holder) {
        const delegation = await findActiveDelegation(holder.user_id, new Date().toISOString().slice(0, 10));
        approverActorId = delegation?.delegate_user_id ?? holder.user_id;
      }
    }

    const status = requiresApproval ? 'pending_approval' : 'pending_shipment';
    const correlationId = randomUUID();

    const envelope = {
      stream_type: 'inventory',
      stream_id: transferRequestId,
      event_type: 'transfer_request.created',
      payload: {
        transfer_request_id: transferRequestId,
        sku_id: skuId,
        quantity,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        ...(validatedLotId ? { lot_id: validatedLotId } : {}),
        ...(serialIds ? { serial_ids: serialIds } : {}),
        business_stream: businessStream,
        ...(notes ? { notes } : {}),
        ...(approverActorId ? { approver_actor_id: approverActorId } : {}),
        status,
      },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    } as any;

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    await client.query('COMMIT');

    sendJson(res, 201, {
      transfer_request_id: transferRequestId,
      status,
      ...(approverActorId ? { approver_actor_id: approverActorId } : {}),
      correlation_id: correlationId,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/transfer-requests/{transfer_request_id}
// ---------------------------------------------------------------------------

const getTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const authContext = getAuthContext(req) as { roles: any[] } | undefined;
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const row = await getTransferRequestById(id);
  if (!row) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    return;
  }

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(row.from_location_id) && !locations.has(row.to_location_id)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', 'No role assignment grants access to the locations in this transfer');
  }

  sendJson(res, 200, transferRequestRowToJson(row));
};

// ---------------------------------------------------------------------------
// GET /api/v1/transfer-requests - List transfer requests
// ---------------------------------------------------------------------------

const listTransferRequestsBase: RouteHandler = async (req, res, _params) => {
  const authContext = getAuthContext(req) as { roles: any[] } | undefined;
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const fromLocationId = url.searchParams.get('from_location_id');
  const toLocationId = url.searchParams.get('to_location_id');
  const status = url.searchParams.get('status');
  const skuId = url.searchParams.get('sku_id');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');

  let filteredFrom: string | null = fromLocationId ?? null;
  let filteredTo: string | null = toLocationId ?? null;

  if (!wildcard) {
    if (fromLocationId && !locations.has(fromLocationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified from_location_id');
      return;
    }
    if (toLocationId && !locations.has(toLocationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified to_location_id');
      return;
    }
    if (!fromLocationId && !toLocationId) {
      filteredFrom = locations.values().next().value ?? null;
      filteredTo = null;
    }
  }

const rows = await getTransferRequests({
     from_location_id: filteredFrom,
     to_location_id: filteredTo,
     ...(status !== null ? { status } : {}),
     ...(skuId !== null ? { sku_id: skuId } : {}),
   });

  sendJson(res, 200, rows.map(transferRequestRowToJson));
};

function transferRequestRowToJson(row: TransferRequestRow): Record<string, unknown> {
  const result: Record<string, unknown> = {
    transfer_request_id: row.transfer_request_id,
    sku_id: row.sku_id,
    quantity: Number(row.quantity),
    from_location_id: row.from_location_id,
    to_location_id: row.to_location_id,
    status: row.status,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
  };
  if (row.lot_id) result.lot_id = row.lot_id;
  if (row.serial_ids) result.serial_ids = row.serial_ids;
  if (row.approver_actor_id) result.approver_actor_id = row.approver_actor_id;
  if (row.notes) result.notes = row.notes;
  if (row.shipped_at) result.shipped_at = row.shipped_at;
  if (row.received_at) result.received_at = row.received_at;
  return result;
}

// ---------------------------------------------------------------------------
// Task 4: PATCH /api/v1/transfer-requests/{id}/approve
// ---------------------------------------------------------------------------

const approveTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const actor = actorContext(req);
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const notes = body?.['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();

  try {
    // Read within transaction for consistency
    const row = await getTransferRequestById(id, client);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'pending_approval') {
      throw new AppError(400, 'INVALID_STATE', `Transfer request is in status "${row.status}", expected "pending_approval"`);
    }

    if (row.approver_actor_id !== actor.userId) {
      throw new AppError(403, 'APPROVAL_REQUIRED', 'Caller is not the resolved approver for this transfer request', {
        approver_actor_id: row.approver_actor_id,
        caller_user_id: actor.userId,
      });
    }

    const correlationId = randomUUID();

    // Update status to approved within the event transaction
    await client.query('UPDATE transfer_request SET status = $1 WHERE transfer_request_id = $2', ['approved', id]);

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_request.approval_decided',
        payload: {
          transfer_request_id: id,
          approved: true,
          reason_code: null,
          notes,
          approver_actor_id: actor.userId,
        },
        metadata: {
          correlation_id: correlationId,
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: new Date().toISOString(),
        },
      } as any,
      auditCtxFor(req, actor, 200),
      client,
    );

    await client.query('COMMIT');

    sendJson(res, 200, {
      transfer_request_id: id,
      status: 'approved',
      approved_by: actor.userId,
      notes,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 4: PATCH /api/v1/transfer-requests/{id}/reject
// ---------------------------------------------------------------------------

const rejectTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const actor = actorContext(req);
  const body = getParsedBody(req) as Record<string, unknown> | undefined;

  if (!body || !isNonEmptyString(body['reason_code'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason_code is required');
    return;
  }
  const reason_code = body['reason_code'] as string;
  const notes = body?.['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();

  try {
    // Read within transaction for consistency
    const row = await getTransferRequestById(id, client);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'pending_approval') {
      throw new AppError(400, 'INVALID_STATE', `Transfer request is in status "${row.status}", expected "pending_approval"`);
    }

    if (row.approver_actor_id !== actor.userId) {
      throw new AppError(403, 'APPROVAL_REQUIRED', 'Caller is not the resolved approver for this transfer request', {
        approver_actor_id: row.approver_actor_id,
        caller_user_id: actor.userId,
      });
    }

    const correlationId = randomUUID();

    // Update status to rejected
    await client.query('UPDATE transfer_request SET status = $1 WHERE transfer_request_id = $2', ['rejected', id]);

    // Revert the allocation: decrease allocated to return the quantity to available
    await client.query(
      `UPDATE stock_balance
       SET allocated = GREATEST(allocated - $1::numeric, 0),
           updated_at = now()
       WHERE sku = $2 AND location_id = $3
         AND ($4::text IS NULL OR lot_id = $4)
         AND allocated >= $1::numeric`,
      [row.quantity, row.sku_id, row.from_location_id, row.lot_id],
    );

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_request.approval_decided',
        payload: {
          transfer_request_id: id,
          approved: false,
          reason_code,
          notes,
          approver_actor_id: actor.userId,
        },
        metadata: {
          correlation_id: correlationId,
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: new Date().toISOString(),
        },
      } as any,
      auditCtxFor(req, actor, 200),
      client,
    );

    await client.query('COMMIT');

    sendJson(res, 200, {
      transfer_request_id: id,
      status: 'rejected',
      reason_code,
      notes,
    });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 5: POST /api/v1/transfer-requests/{id}/ship
// ---------------------------------------------------------------------------

const shipTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);

  if (!body || !isNonEmptyString(body['lot_id'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
    return;
  }
  const lotId = body['lot_id'] as string;

  const shippedQuantity = body['shipped_quantity'] !== undefined ? (body['shipped_quantity'] as number) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();

  try {
    const row = await getTransferRequestById(id);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'approved' && row.status !== 'pending_shipment') {
      throw new AppError(403, 'APPROVAL_REQUIRED', 'Transfer request must be approved before shipping', {
        current_status: row.status,
      });
    }

    // AC5: Quantity check
    const shipQty = shippedQuantity ?? row.quantity;
    if (shipQty > row.quantity) {
      throw new AppError(400, 'QUANTITY_EXCEEDS_APPROVED', `Shipped quantity ${shipQty} exceeds approved quantity ${row.quantity}`, {
        approved_quantity: row.quantity,
        requested_quantity: shipQty,
      });
    }

    // Lot matching (ship side)
    if (row.lot_id && row.lot_id !== lotId) {
      throw new AppError(400, 'LOT_MISMATCH', `Ship lot_id "${lotId}" does not match request lot_id "${row.lot_id}"`, {
        request_lot_id: row.lot_id,
        ship_lot_id: lotId,
      });
    }

    const correlationId = randomUUID();

const envelope = {
       stream_type: 'inventory',
       stream_id: id,
       event_type: 'transfer_ship.created',
       payload: {
         transfer_request_id: id,
         shipped_quantity: shipQty,
         lot_id: lotId,
         ...(serialIds ? { serial_ids: serialIds } : {}),
         ...(notes ? { notes } : {}),
         correlation_id: correlationId,
       },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    } as any;

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    await client.query('COMMIT');

sendJson(res, 201, {
       transfer_request_id: id,
       status: 'shipped',
       lot_id: lotId,
       shipped_quantity: shipQty,
       correlation_id: correlationId,
     });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 6: POST /api/v1/transfer-requests/{id}/receive
// ---------------------------------------------------------------------------

const receiveTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id'];
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);

  if (!body || !isNonEmptyString(body['lot_id'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lot_id is required and must be a non-empty string');
    return;
  }
  const lotId = body['lot_id'] as string;

  const receivedQuantity = body['received_quantity'] !== undefined ? (body['received_quantity'] as number) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const receivedAtLocationId = body['received_at_location_id'] !== undefined ? (body['received_at_location_id'] as string) : undefined;
  const receivedDate = body['received_date'] !== undefined ? (body['received_date'] as string) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();

  try {
    const row = await getTransferRequestById(id);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'shipped') {
      throw new AppError(400, 'INVALID_STATE', `Transfer request must be in "shipped" status, current status is "${row.status}"`);
    }

    const receiveLocationId = receivedAtLocationId ?? row.to_location_id;
    if (receiveLocationId !== row.to_location_id) {
      throw new AppError(400, 'INVALID_LOCATION', `Receive location does not match the approved destination location`, {
        expected_location_id: row.to_location_id,
        received_location_id: receiveLocationId,
      });
    }

    const receiveLocation = await getLocationById(receiveLocationId, client);
    if (!receiveLocation || receiveLocation.status !== 'active') {
      throw new AppError(400, 'LOCATION_NOT_FOUND', 'Receive location does not exist or is not active', {
        location_id: receiveLocationId,
      });
    }

    const receiveQty = receivedQuantity ?? row.quantity;

    // AC6: Lot matching
    if (lotId !== row.lot_id) {
      throw new AppError(400, 'LOT_MISMATCH', `Receive lot_id "${lotId}" does not match shipped lot_id "${row.lot_id}"`, {
        ship_lot_id: row.lot_id,
        receive_lot_id: lotId,
      });
    }

    const correlationId = randomUUID();

const envelope = {
       stream_type: 'inventory',
       stream_id: id,
       event_type: 'transfer_receive.created',
       payload: {
         transfer_request_id: id,
         received_quantity: receiveQty,
         lot_id: lotId,
        ...(serialIds ? { serial_ids: serialIds } : {}),
        received_at_location_id: receiveLocationId,
        ...(receivedDate ? { received_date: receivedDate } : {}),
        ...(notes ? { notes } : {}),
        correlation_id: correlationId,
      },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    } as any;

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    await client.query('COMMIT');

sendJson(res, 201, {
       transfer_request_id: id,
       status: 'received',
       lot_id: lotId,
       received_quantity: receiveQty,
       correlation_id: correlationId,
     });
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (err instanceof AppError) {
      throw err;
    }
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/stock/{sku}/in-transit
// ---------------------------------------------------------------------------

const getInTransitBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return;
  }

  const authContext = getAuthContext(req) as { roles: any[] } | undefined;
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const rows = await getInTransitBalances(sku);

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  const filteredRows = wildcard
    ? rows
    : rows.filter((r) => locations.has(r.location_from) || locations.has(r.location_to));

  sendJson(res, 200, {
    sku,
    in_transit: filteredRows.map((r) => ({
      location_from: r.location_from,
      location_to: r.location_to,
      lot_id: r.lot_id,
      quantity: Number(r.quantity),
      transfer_request_id: r.transfer_request_id,
      correlation_id: r.correlation_id,
      ship_event_id: r.ship_event_id,
      created_at: r.created_at,
    })),
  });
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(createTransferRequestBase);

export const getTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getTransferRequestBase);

export const listTransferRequestsHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(listTransferRequestsBase);

export const approveTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(approveTransferRequestBase);

export const rejectTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(rejectTransferRequestBase);

export const shipTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(shipTransferRequestBase);

export const receiveTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(receiveTransferRequestBase);

export const getInTransitHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getInTransitBase);