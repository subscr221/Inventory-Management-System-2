import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getAuthContext, getParsedBody } from '../../middleware/context.js';
import { persistEvent } from '../../events/store.js';
import type { RoleAssignment } from '../../read/projections/users.js';
import {
  getRefusedCaptureById,
  listRefusedCaptures,
  type RefusedCaptureRow,
  type RefusedCaptureScope,
} from '../../read/projections/edge_refused_capture.js';
import { MAX_REFUSED_CAPTURE_NOTE_LENGTH } from '../../compliance/edge-refused-capture.js';
import { auditCtxFor, idempotencyKeyFrom, replayIdOrReject } from './quality.js';

/**
 * Story 1.13 (AC 4, Binding Decision 6): the refused-captures API. A refusal belongs to the module
 * of the refused capture (its stream_type) and to its site, so access is decided per row rather
 * than by a static requireRole module: seeing needs read on that module at that site, resolving
 * needs write there, and the applier re-derives the DOA approver under the row lock. A row the
 * caller may not see answers 404, never 403 (no existence leak).
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rolesOf(req: IncomingMessage): RoleAssignment[] {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return authContext.roles;
}

/**
 * read is satisfied by any assignment; write only by a write assignment (requireRole's rule).
 * user_role_assignments.location_id is TEXT while a stored refusal location_id is a lower-cased
 * uuid, so the grant side is lower-cased too or a mixed-case assignment matches nothing.
 */
function scopesOf(roles: RoleAssignment[], functionScope: 'read' | 'write'): RefusedCaptureScope[] {
  return roles
    .filter((r) => functionScope === 'read' || r.functionScope === 'write')
    .map((r) => ({ stream_type: r.module, location_id: grantLocation(r) }));
}

function grantLocation(assignment: RoleAssignment): string {
  return assignment.locationId === '*' ? '*' : assignment.locationId.toLowerCase();
}

/**
 * Story 1.14 (Binding Decision 2): may this caller see any refusal at `locationId`? Decides whether
 * the edge bootstrap advertises the supervisor screen. Built on the list route's own scope rule
 * (any assignment grants read on its module, at its site or everywhere) so there is one matcher,
 * and never on a role name.
 */
export function hasRefusedCaptureReadScope(roles: RoleAssignment[], locationId: string): boolean {
  const site = locationId.toLowerCase();
  return scopesOf(roles, 'read').some((scope) => scope.location_id === '*' || scope.location_id === site);
}

function grants(scope: RefusedCaptureScope, row: RefusedCaptureRow): boolean {
  return (
    (scope.stream_type === '*' || scope.stream_type === row.stream_type) &&
    (scope.location_id === '*' || scope.location_id === row.location_id)
  );
}

async function visibleRow(req: IncomingMessage, refusalIdRaw: string | undefined): Promise<RefusedCaptureRow> {
  const roles = rolesOf(req);
  const refusalId = refusalIdRaw !== undefined && UUID_REGEX.test(refusalIdRaw) ? refusalIdRaw.toLowerCase() : null;
  if (refusalId === null) {
    throw new AppError(400, 'INVALID_PARAMS', 'refusalId must be a UUID', { refusalId: refusalIdRaw ?? null });
  }
  const row = await getRefusedCaptureById(refusalId);
  if (!row || !scopesOf(roles, 'read').some((scope) => grants(scope, row))) {
    throw new AppError(404, 'REFUSED_CAPTURE_NOT_FOUND', 'Refused capture not found', { refusal_id: refusalId });
  }
  return row;
}

// Bounded on BOTH sides: an unbounded offset reaches PostgreSQL as a bigint overflow and answers
// 500 where the caller's input was simply out of range.
const MAX_OFFSET = 1_000_000;

function integerParam(url: URL, name: string, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new AppError(400, 'INVALID_PARAMS', `${name} must be a non-negative integer`);
  const value = Number(raw);
  if (value > max) throw new AppError(400, 'INVALID_PARAMS', `${name} must be at most ${max}`, { [name]: raw });
  return value;
}

// GET /api/v1/edge/refused-captures
export const listRefusedCapturesHandler: RouteHandler = async (req, res) => {
  const scopes = scopesOf(rolesOf(req), 'read');
  if (scopes.length === 0) {
    throw new AppError(403, 'MODULE_ACCESS_DENIED', 'No role assignment grants read access to any module');
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const status = url.searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved') {
    throw new AppError(400, 'INVALID_PARAMS', 'status must be one of: open, resolved');
  }
  const locationId = url.searchParams.get('location_id');
  if (locationId !== null && !UUID_REGEX.test(locationId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'location_id must be a UUID');
  }
  const limit = integerParam(url, 'limit', 500);
  if (limit !== undefined && (limit < 1 || limit > 500)) {
    throw new AppError(400, 'INVALID_PARAMS', 'limit must be between 1 and 500');
  }
  const refusals = await listRefusedCaptures({
    status,
    scopes,
    location_id: locationId?.toLowerCase() ?? undefined,
    stream_type: url.searchParams.get('stream_type') ?? undefined,
    limit: limit ?? 50,
    offset: integerParam(url, 'offset', MAX_OFFSET),
  });
  sendJson(res, 200, { refusals });
};

// GET /api/v1/edge/refused-captures/:refusalId
export const getRefusedCaptureHandler: RouteHandler = async (req, res, params) => {
  sendJson(res, 200, { refusal: await visibleRow(req, params['refusalId']) });
};

// POST /api/v1/edge/refused-captures/:refusalId/resolve
export const resolveRefusedCaptureHandler: RouteHandler = async (req, res, params) => {
  const roles = rolesOf(req);
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const note = typeof body['note'] === 'string' ? body['note'].trim() : '';
  if (note.length < 1 || note.length > MAX_REFUSED_CAPTURE_NOTE_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `note is required and must be 1 to ${MAX_REFUSED_CAPTURE_NOTE_LENGTH} characters`,
      { field: 'note' },
    );
  }
  const row = await visibleRow(req, params['refusalId']);

  // Immutable facts only (AD-12): write on the row's module at its site. No already-resolved and
  // no DOA pre-check; both live in the applier under the row lock.
  const writable = roles.filter(
    (r) => r.functionScope === 'write' && (r.module === '*' || r.module === row.stream_type),
  );
  if (writable.length === 0) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `No role assignment grants "write" access to module "${row.stream_type}"`);
  }
  const assignment = writable.find((r) => grantLocation(r) === '*' || grantLocation(r) === row.location_id);
  if (!assignment) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No role assignment grants access to location "${row.location_id}"`);
  }

  const userId = getAuthContext(req)!.userId;
  const now = new Date().toISOString();
  const actor = {
    userId,
    role: assignment.role,
    auditLocationId: assignment.locationId,
    eventLocationId: row.location_id ?? (UUID_REGEX.test(assignment.locationId) ? assignment.locationId : NO_LOCATION_UUID),
  };
  const persisted = await persistEvent(
    {
      stream_type: 'sync',
      stream_id: row.refusal_id,
      event_type: 'sync.refused_capture_resolved',
      payload: { refusal_id: row.refusal_id, resolved_by: userId, note, resolved_at: now },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
      idempotency_key: idempotencyKeyFrom(body),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    auditCtxFor(req, actor, 200),
  );
  const refusalId = replayIdOrReject(persisted, 'sync.refused_capture_resolved', 'refusal_id');
  // A replay must be a replay OF THIS refusal. The same idempotency key reused against another
  // refusal returns that one's event, whose applier was skipped as already persisted: without this
  // check the caller is told 200 while the refusal they addressed is still open.
  if (refusalId !== row.refusal_id) {
    throw new AppError(409, 'DUPLICATE_EVENT', 'This idempotency key is already in use by a different refusal', {
      existing_event_id: persisted.event_id,
      existing_refusal_id: refusalId,
    });
  }
  sendJson(res, 200, { event_id: persisted.event_id, refusal: await getRefusedCaptureById(refusalId) });
};
