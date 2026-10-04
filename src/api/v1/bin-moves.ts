import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole, assignmentCoversLocation, auditLocationFor } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getLocationByCode, getLocationById } from '../../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../../read/projections/location_register.js';
import { getLotById } from '../../read/projections/lot_master.js';
import type { RoleAssignment } from '../../read/projections/users.js';
import { BIN_MOVE_ROLES } from '../../compliance/bin-move.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

/**
 * Review R1/R7(d): role and location are stamped from the ONE bin-move assignment that authorized
 * the move (not whichever warehouse assignment requireRole happened to match), so the applier's
 * role re-check sees the storekeeping role. The stamp is the FROM bin - where the storekeeper acts
 * on the stock - when the assignment covers it from above; a wildcard keeps the sentinel.
 */
function actorContext(
  req: IncomingMessage,
  assignment: RoleAssignment,
  fromLocationId: string,
): ActorContext {
  const userId = getAuthContext(req)?.userId ?? NO_LOCATION_UUID;
  const auditLocationId = auditLocationFor(assignment, fromLocationId);
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role: assignment.role, auditLocationId, eventLocationId };
}

/** Review R3: the fields that make two submissions under one key the SAME move. */
function sameMove(stored: Record<string, unknown>, sent: Record<string, unknown>): boolean {
  const text = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');
  const serials = (v: unknown): string => (Array.isArray(v) ? [...v].sort().join('\0') : '');
  return (
    ['site_id', 'from_location_id', 'to_location_id'].every(
      (f) => text(stored[f]) === text(sent[f]),
    ) &&
    stored['sku'] === sent['sku'] &&
    Number(stored['quantity']) === Number(sent['quantity']) &&
    (stored['lot_id'] ?? null) === (sent['lot_id'] ?? null) &&
    (stored['stock_class'] ?? 'owned') === (sent['stock_class'] ?? 'owned') &&
    serials(stored['serials']) === serials(sent['serials'])
  );
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

/** Resolves one end of the move from `<end>_location_id` or `<end>_location_code`. */
async function resolveEnd(
  body: Record<string, unknown>,
  end: 'from' | 'to',
): Promise<LocationRegisterEntry> {
  const id = body[`${end}_location_id`];
  const code = body[`${end}_location_code`];
  let location: LocationRegisterEntry | null = null;
  if (typeof id === 'string' && UUID_REGEX.test(id)) location = await getLocationById(id);
  else if (typeof code === 'string' && code !== '') location = await getLocationByCode(code);
  else {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `${end}_location_id (UUID) or ${end}_location_code is required`,
    );
  }
  if (!location) {
    throw new AppError(
      404,
      'BIN_MOVE_LOCATION_NOT_FOUND',
      `Location ${String(id ?? code)} not found`,
      { end },
    );
  }
  return location;
}

const createBinMoveBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  // Review R2: privilege AND location scope come from the SAME assignments (the rule the events
  // door states for its function gates). Only bin-move assignments are consulted below, so a
  // store_assistant grant at site A lends nothing to a warehouse_operator grant at site B.
  const moverRoles = roles.filter(
    (r) =>
      (r.module === 'warehouse' || r.module === '*') &&
      r.functionScope === 'write' &&
      BIN_MOVE_ROLES.includes(r.role),
  );
  if (moverRoles.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${BIN_MOVE_ROLES.join(', ')}`,
    );
  }

  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const siteId = body['site_id'];
  if (typeof siteId !== 'string' || !UUID_REGEX.test(siteId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'site_id is required and must be a UUID');
    return;
  }
  const idempotencyKey = body['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'idempotency_key is required');
    return;
  }

  const from = await resolveEnd(body, 'from');
  const to = await resolveEnd(body, 'to');
  // Location coverage applies to BOTH bins: a bin-scoped storekeeper may not push stock into, or
  // pull it out of, a bin their bin-move assignment does not reach.
  const assignment = moverRoles.find((r) =>
    [from, to].every((location) => assignmentCoversLocation(r, location.location_id)),
  );
  if (!assignment) {
    const uncovered =
      [from, to].find(
        (location) => !moverRoles.some((r) => assignmentCoversLocation(r, location.location_id)),
      ) ?? to;
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No bin-move assignment grants access to location "${uncovered.location_code}"`,
    );
  }

  // The lot travels as its NUMBER (the stock_balance key); a lot_master UUID is accepted and resolved.
  let lotNumber: string | null = null;
  const lotRaw = body['lot_number'] ?? body['lot_id'];
  if (typeof lotRaw === 'string' && lotRaw !== '') {
    lotNumber = UUID_REGEX.test(lotRaw)
      ? ((await getLotById(lotRaw))?.lot_number ?? lotRaw)
      : lotRaw;
  }

  const actor = actorContext(req, assignment, from.location_id);
  const payload = {
    site_id: siteId.toLowerCase(),
    sku: body['sku'],
    from_location_id: from.location_id,
    to_location_id: to.location_id,
    quantity: typeof body['quantity'] === 'number' ? String(body['quantity']) : body['quantity'],
    ...(lotNumber !== null ? { lot_id: lotNumber } : {}),
    ...(body['serials'] !== undefined ? { serials: body['serials'] } : {}),
    stock_class: body['stock_class'] ?? 'owned',
    reason: typeof body['reason'] === 'string' ? body['reason'] : null,
  };

  // Replay contract: the same key with the SAME move answers 200 with the ORIGINAL event and moves
  // nothing twice. Review R3: uq_idempotency is unscoped, so a key match alone proves nothing - a
  // different move, a different event type or a different user under the same key is a 409
  // IDEMPOTENCY_KEY_CONFLICT (the gate-event precedent) that names no event, so a collision never
  // discloses someone else's event id and a corrected retry is never silently swallowed.
  const answerReplay = async (): Promise<boolean> => {
    const original = await getPool().query(
      `SELECT event_id, stream_id, event_type, payload, metadata->'actor'->>'user_id' AS user_id
         FROM domain_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (original.rows.length === 0) return false;
    const row = original.rows[0]!;
    if (
      row['event_type'] !== 'stock.bin_moved' ||
      row['user_id'] !== actor.userId ||
      !sameMove(row['payload'] as Record<string, unknown>, payload)
    ) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        'idempotency_key was already used for a different submission',
      );
    }
    sendJson(res, 200, {
      event_id: original.rows[0]!['event_id'],
      move_id: original.rows[0]!['stream_id'],
      replayed: true,
    });
    return true;
  };
  if (await answerReplay()) return;

  const eventId = randomUUID();
  const moveId = randomUUID();
  let persisted: Awaited<ReturnType<typeof persistEvent>>;
  try {
    persisted = await persistEvent(
      {
        event_id: eventId,
        stream_type: 'warehouse',
        stream_id: moveId,
        event_type: 'stock.bin_moved',
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: idempotencyKey,
      },
      auditCtxFor(req, actor, 201),
    );
  } catch (err) {
    // A concurrent double-submit that lost the race sees the winner's drained source (409) or its
    // key; once the winner has committed, the loser is answered with the same replay shape.
    if (err instanceof AppError && err.statusCode === 409 && (await answerReplay())) return;
    throw err;
  }
  // persistEvent answered with an existing row for this key: held to the same comparison.
  if (persisted.event_id !== eventId && (await answerReplay())) return;
  sendJson(res, 201, { event_id: persisted.event_id, move_id: moveId, replayed: false });
};

export const createBinMoveHandler: RouteHandler = requireRole({
  module: 'warehouse',
  functionScope: 'write',
})(createBinMoveBase);
