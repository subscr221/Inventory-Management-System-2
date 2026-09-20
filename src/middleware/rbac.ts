import type { RouteHandler } from './error.js';
import { AppError } from './error.js';
import {
  getAuthContext,
  getParsedBody,
  setAuthorizedRole,
  setAuthorizedAssignment,
  setAuthorizedLocation,
} from './context.js';
import type { RoleAssignment } from '../read/projections/users.js';
import { getPool } from '../config/db.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Location coverage per role assignment: the assignment's own location plus every location
 * beneath it in the register hierarchy (site > zone > aisle > rack > bin). Keyed by the
 * assignment object so it never leaks into serialized roles or audit stamps; an assignment
 * without an entry (copied object, unknown location) falls back to its exact locationId, so a
 * miss can only narrow access, never widen it.
 */
const locationCoverage = new WeakMap<RoleAssignment, ReadonlySet<string>>();

type CoverageQuery = (
  text: string,
  values: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Resolves, in one query, the locations beneath each concrete (non-wildcard) assignment and
 * records them for the permitted-location helpers and requireRole below. Called once per request
 * right after authentication, so every route that authorizes or filters by location sees the
 * same hierarchy roll-down. Descent follows parent_location_id; the site_id shortcut applies only
 * from the root row itself and only when that root is a site, so a register row whose site_id
 * names a zone (or any non-site) is never picked up. It never walks upward or sideways.
 *
 * The roll-down widens the exact-match rule, it is not a precondition of it: a failed lookup is
 * logged and the request carries on with exact-match semantics rather than turning every
 * authenticated request into a 401. `query` is injectable for that test only.
 */
export async function attachLocationCoverage(
  roles: RoleAssignment[],
  query: CoverageQuery = (text, values) => getPool().query(text, values),
): Promise<void> {
  const roots = [
    ...new Set(roles.map((r) => r.locationId.toLowerCase()).filter((id) => UUID_REGEX.test(id))),
  ];
  if (roots.length === 0) return;
  let rows: Record<string, unknown>[];
  try {
    const result = await query(
      `WITH RECURSIVE tree AS (
         SELECT location_id AS root_id, location_id, level = 'site' AS site_root
         FROM location_register WHERE location_id = ANY($1::uuid[])
         UNION
         SELECT t.root_id, c.location_id, false
         FROM tree t
         JOIN location_register c
           ON c.parent_location_id = t.location_id
           OR (t.site_root AND c.site_id = t.location_id)
       )
       SELECT root_id, location_id FROM tree`,
      [roots],
    );
    rows = result.rows;
  } catch (err) {
    console.error('Location coverage lookup failed; falling back to exact-match scope:', err);
    return;
  }
  const byRoot = new Map<string, Set<string>>();
  for (const row of rows) {
    const root = row['root_id'] as string;
    const covered = byRoot.get(root) ?? new Set<string>();
    covered.add(row['location_id'] as string);
    byRoot.set(root, covered);
  }
  for (const r of roles) {
    const covered = byRoot.get(r.locationId.toLowerCase());
    if (covered) locationCoverage.set(r, covered);
  }
}

/** True when the assignment grants `locationId`: wildcard, exact match, or a covered descendant. */
export function assignmentCoversLocation(assignment: RoleAssignment, locationId: string): boolean {
  if (assignment.locationId === '*' || assignment.locationId === locationId) return true;
  return locationCoverage.get(assignment)?.has(locationId.toLowerCase()) ?? false;
}

/**
 * The location to stamp on the audit actor. An exact-match assignment stamps its own id, as it
 * always did, and the wildcard id is returned untouched for the caller's own wildcard handling.
 * An assignment that covers `actedLocationId` from above (a site grant acting at a bin) stamps the
 * location actually acted on, so the audit trail does not collapse every bin into its site.
 */
export function auditLocationFor(
  assignment: RoleAssignment,
  actedLocationId: string | undefined,
): string {
  if (actedLocationId === undefined || assignment.locationId === '*') return assignment.locationId;
  if (assignment.locationId === actedLocationId) return assignment.locationId;
  return locationCoverage.get(assignment)?.has(actedLocationId.toLowerCase())
    ? actedLocationId.toLowerCase()
    : assignment.locationId;
}

function addCoveredLocations(target: Set<string>, assignment: RoleAssignment): void {
  target.add(assignment.locationId);
  for (const id of locationCoverage.get(assignment) ?? []) target.add(id);
}

/**
 * Computes the locations a caller may read within a module from their role assignments.
 * `wildcard` is true if any read-satisfying assignment grants all locations (`*`); otherwise
 * `locations` holds the assigned location ids and everything beneath them (see
 * attachLocationCoverage). A `write` assignment satisfies read as well.
 */
export function permittedLocationsForModule(
  roles: RoleAssignment[],
  module: string,
): { wildcard: boolean; locations: Set<string> } {
  const locations = new Set<string>();
  let wildcard = false;
  for (const r of roles) {
    if (r.module !== module && r.module !== '*') continue;
    // read is satisfied by both 'read' and 'write' assignments
    if (r.locationId === '*') wildcard = true;
    else addCoveredLocations(locations, r);
  }
  return { wildcard, locations };
}

export interface RbacOptions {
  /** Static module name, or resolved dynamically from route params / parsed body. */
  module: string | ((params: Record<string, string>, body: unknown) => string);
  functionScope: 'read' | 'write';
  /** Optional: resolves the target location for this request. Skipped if it returns undefined. */
  locationId?: (params: Record<string, string>, body: unknown) => string | undefined;
}

function satisfiesFunctionScope(assignment: RoleAssignment, required: 'read' | 'write'): boolean {
  // A 'write' assignment satisfies both read and write requirements; 'read' satisfies read only.
  if (required === 'read') return true;
  return assignment.functionScope === 'write';
}

export function permittedLocationsForModuleScope(
  roles: RoleAssignment[],
  module: string,
  functionScope: 'read' | 'write',
): { wildcard: boolean; locations: Set<string> } {
  const locations = new Set<string>();
  let wildcard = false;
  for (const r of roles) {
    if (r.module !== module && r.module !== '*') continue;
    if (!satisfiesFunctionScope(r, functionScope)) continue;
    if (r.locationId === '*') wildcard = true;
    else addCoveredLocations(locations, r);
  }
  return { wildcard, locations };
}

/**
 * Enforces module -> function -> location precedence against the caller's role assignments
 * (attached to the request by the router's global auth check). Must be composed onto a route
 * handler AFTER authentication has already run - throws if no auth context is present.
 */
export function requireRole(options: RbacOptions): (handler: RouteHandler) => RouteHandler {
  return (handler) => {
    return async (req, res, params) => {
      const authContext = getAuthContext(req);
      if (!authContext) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      }

      const body = getParsedBody(req);
      const resolvedModule =
        typeof options.module === 'function' ? options.module(params, body) : options.module;

      // A request that does not resolve to a concrete module must be rejected outright - a
      // wildcard ('*') assignment must not be allowed to satisfy an unknown/empty module.
      if (!resolvedModule) {
        throw new AppError(400, 'INVALID_MODULE', 'Request does not resolve to a known module');
      }

      const moduleMatches = authContext.roles.filter(
        (r) => r.module === resolvedModule || r.module === '*',
      );
      if (moduleMatches.length === 0) {
        throw new AppError(
          403,
          'MODULE_ACCESS_DENIED',
          `No role assignment grants access to module "${resolvedModule}"`,
        );
      }

      const functionMatches = moduleMatches.filter((r) =>
        satisfiesFunctionScope(r, options.functionScope),
      );
      if (functionMatches.length === 0) {
        throw new AppError(
          403,
          'FUNCTION_ACCESS_DENIED',
          `No role assignment grants "${options.functionScope}" access to module "${resolvedModule}"`,
        );
      }

      // The assignment that authorized this request. For a location-scoped request it is the
      // one matching the location; otherwise the first function-satisfying match. Handlers use
      // its role to stamp the audit actor, so identity/role are never trusted from the client.
      let authorizingAssignment: RoleAssignment | undefined = functionMatches[0];

      const resolvedLocation = options.locationId?.(params, body);
      if (resolvedLocation !== undefined) {
        authorizingAssignment = functionMatches.find((r) =>
          assignmentCoversLocation(r, resolvedLocation),
        );
        if (!authorizingAssignment) {
          throw new AppError(
            403,
            'LOCATION_ACCESS_DENIED',
            `No role assignment grants access to location "${resolvedLocation}"`,
          );
        }
        setAuthorizedLocation(req, resolvedLocation);
      }

      if (authorizingAssignment) {
        setAuthorizedRole(req, authorizingAssignment.role);
        setAuthorizedAssignment(req, authorizingAssignment);
      }

      await handler(req, res, params);
    };
  };
}
