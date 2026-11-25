import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { assignmentCoversLocation, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { PersistedEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { HUB_UUID } from '../../compliance/hub-customer.js';
import { getHubBookingById, getHubMachineById } from '../../read/projections/hub.js';

const NONE = '00000000-0000-0000-0000-000000000000';
export const HUB_MODULE = 'engineering';
type Req = Parameters<RouteHandler>[0];
type Res = Parameters<RouteHandler>[1];
type Roles = NonNullable<ReturnType<typeof getAuthContext>>['roles'];

export function hubBody(req: Req): Record<string, unknown> {
  return (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
}

/**
 * D4: the acting user's role assignment must cover the record's location (exact, '*', or a covered
 * descendant). requireRole only knows the location when it is in the body or path, so the booking
 * routes resolve it from the machine row and call this. Throws like requireRole does.
 */
export function assertHubLocationAccess(
  req: Req,
  locationId: string,
  scope: 'read' | 'write' = 'write',
): void {
  assertHubRolesLocationAccess(getAuthContext(req)?.roles ?? [], locationId, scope);
}

export function assertHubRolesLocationAccess(
  roles: Roles,
  locationId: string,
  scope: 'read' | 'write' = 'write',
): void {
  const ok = roles.some(
    (r) =>
      (r.module === HUB_MODULE || r.module === '*') &&
      (scope === 'read' || r.functionScope === 'write') &&
      assignmentCoversLocation(r, locationId.toLowerCase()),
  );
  if (!ok)
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No role assignment grants access to location "${locationId}"`);
}

/**
 * P-D: a writer whose engineering grant is location-scoped may not create an unscoped customer
 * (a customer with no location is visible to every reader); only a global writer may.
 */
export function assertHubCustomerLocationGiven(roles: Roles, locationId: unknown): void {
  if (typeof locationId === 'string' ? locationId.trim() !== '' : locationId != null) return;
  if (!permittedLocationsForModuleScope(roles, HUB_MODULE, 'write').wildcard)
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', 'A location-scoped writer must give the customer a location_id');
}

async function machineLocation(machineId: unknown): Promise<string | null> {
  return typeof machineId === 'string' && HUB_UUID.test(machineId)
    ? ((await getHubMachineById(machineId))?.location_id ?? null)
    : null;
}

/**
 * X1: the generic doors (POST /api/v1/events and the edge upload POST /api/v1/edge/events) carry the
 * research stream, so a hub.* event posted there would otherwise need only a research grant and
 * skip every route check. Both doors now resolve the module to engineering for hub.* events and
 * call this for the same location rule the hub routes apply (machine or booking location from the
 * row, customer and machine registration from the payload). An unknown machine or booking falls
 * through to the seam, which answers 404, exactly like the routes.
 */
export async function assertHubEventWriteAccess(
  roles: Roles,
  body: { event_type: string; payload: Record<string, unknown> },
): Promise<void> {
  if (!body.event_type.startsWith('hub.')) return;
  const p = body.payload;
  if (body.event_type === 'hub.customer_registered') assertHubCustomerLocationGiven(roles, p['location_id']);
  if (permittedLocationsForModuleScope(roles, HUB_MODULE, 'write').wildcard) return;
  let location: unknown = null;
  if (body.event_type === 'hub.customer_registered' || body.event_type === 'hub.machine_registered')
    location = p['location_id'];
  else if (body.event_type === 'hub.machine_meter_linked' || body.event_type === 'hub.booking_opened')
    location = await machineLocation(p['machine_id']);
  else if (typeof p['booking_id'] === 'string' && HUB_UUID.test(p['booking_id'])) {
    const booking = await getHubBookingById(p['booking_id']);
    if (booking) location = await machineLocation(booking.machine_id);
  }
  if (typeof location === 'string') assertHubRolesLocationAccess(roles, location, 'write');
}

/** D4: locations the actor may read (null = every location, i.e. a '*' grant) for list filtering. */
export function hubReadScope(req: Req): string[] | null {
  const p = permittedLocationsForModuleScope(getAuthContext(req)?.roles ?? [], HUB_MODULE, 'read');
  return p.wildcard ? null : [...p.locations].map((l) => l.toLowerCase()).filter((l) => HUB_UUID.test(l));
}

/**
 * P1: persistEvent returns ANY event already holding the idempotency key. A genuine replay is the
 * same event type (and, when the stream is fixed by the URL, the same stream) carrying the id field;
 * anything else is a key reused for a different write: 409 DUPLICATE_EVENT, never a phantom record.
 */
function replayId(persisted: PersistedEvent, w: HubWrite): string {
  const stored = (persisted.payload as unknown as Record<string, unknown> | undefined) ?? {};
  const value = stored[w.idField];
  // P-B: the stream id is compared lowercase (an uppercase UUID in the URL is the same stream).
  const wrongStream = w.streamFromUrl && persisted.stream_id.toLowerCase() !== w.streamId.toLowerCase();
  // P-C: the same key with a different material body is a different request, not a replay.
  const norm = (v: unknown): string =>
    JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'string' && HUB_UUID.test(x) ? x.toLowerCase() : x));
  const changed = (w.compare ?? []).filter((k) => norm(stored[k]) !== norm(w.payload[k]));
  if (
    persisted.event_type !== w.eventType ||
    wrongStream ||
    typeof value !== 'string' ||
    !HUB_UUID.test(value) ||
    changed.length > 0
  )
    throw new AppError(409, 'DUPLICATE_EVENT', 'This idempotency key is already in use by a different event or request body', {
      existing_event_id: persisted.event_id,
      existing_event_type: persisted.event_type,
      ...(changed.length > 0 ? { changed_fields: changed } : {}),
    });
  return value;
}

export interface HubWrite {
  streamId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Payload field holding the record id; on replay the ORIGINAL event's value is returned. */
  idField: string;
  /** True when the URL fixes the stream (close, meter link): a replay on another stream is a 409. */
  streamFromUrl?: boolean;
  /** Payload fields the client supplied; a replay whose stored value differs is a 409 (P-C). */
  compare?: string[];
  status?: number;
}

/**
 * Story 10.4 route plumbing: persists one hub event on the research stream with the caller as actor
 * and an idempotency key (client-supplied or generated). All rule enforcement lives in the
 * compliance seams, so a direct POST /api/v1/events cannot bypass it. Returns null after having
 * sent the error response; otherwise the persisted event and the (replay-safe) record id.
 */
export async function persistHubEvent(
  req: Req,
  res: Res,
  w: HubWrite,
): Promise<{ event: PersistedEvent; id: string } | null> {
  const body = hubBody(req);
  const status = w.status ?? 201;
  const a = getAuthorizedAssignment(req);
  const actor = {
    user_id: getAuthContext(req)?.userId ?? NONE,
    role: a?.role ?? '',
    location_id: a?.locationId ?? '*',
  };
  const auditCtx: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> = {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.user_id,
    role: actor.role,
    location_id: actor.location_id,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: status,
  };
  try {
    const event = await persistEvent(
      {
        stream_type: 'research',
        stream_id: w.streamId,
        event_type: w.eventType,
        payload: w.payload,
        metadata: {
          correlation_id:
            typeof body['correlation_id'] === 'string' ? body['correlation_id'] : randomUUID(),
          occurred_at: new Date().toISOString(),
          actor,
        },
        // A blank key would collide every write onto one replay (Story 7.1 lesson).
        idempotency_key:
          typeof body['idempotency_key'] === 'string' && body['idempotency_key'].trim() !== ''
            ? body['idempotency_key']
            : randomUUID(),
      } as never,
      auditCtx,
    );
    return {
      event,
      id: replayId(event, w),
    };
  } catch (err) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return null;
    }
    throw err;
  }
}
