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

/**
 * Story 1.15 (D1): the base hat every signed-in person holds, provisioned as a real assignment
 * `{ role: 'employee', module: 'employee', function_scope: 'write', location_id: <site> }`. Gates
 * name this module next to the specialist one (`[EMPLOYEE_MODULE, 'procurement']`), never a role.
 */
export const EMPLOYEE_MODULE = 'employee';
/** Story 1.15 (D1): the base hat's own role name, the one every signed-in person holds. */
export const EMPLOYEE_ROLE = 'employee';

/**
 * Story 1.15: the (stream, event) pairs the edge door accepts from an `employee` write assignment.
 * Every other event keeps its stream-module write rule. Story 8.9 appends damage capture: any
 * signed-in person reports damage from any device (D3).
 */
export const EMPLOYEE_EDGE_EVENTS: ReadonlyArray<{ stream_type: string; event_type: string }> = [
  { stream_type: 'procurement', event_type: 'indent.raised' },
  { stream_type: 'damage', event_type: 'damage.reported' },
];

export interface RbacOptions {
  /**
   * Static module name, or resolved dynamically from route params / parsed body. A list means
   * any-of: list order decides which assignment authorizes (and so stamps the audit actor).
   */
  module:
    | string
    | string[]
    | ((params: Record<string, string>, body: unknown) => string | string[]);
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
      const resolved =
        typeof options.module === 'function' ? options.module(params, body) : options.module;
      const modules = (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);

      // A request that does not resolve to a concrete module must be rejected outright - a
      // wildcard ('*') assignment must not be allowed to satisfy an unknown/empty module.
      if (modules.length === 0) {
        throw new AppError(400, 'INVALID_MODULE', 'Request does not resolve to a known module');
      }
      const resolvedModule = modules[0]!;

      // Grouped by list position, caller's role order kept within a group, so the first listed
      // module the caller holds authorizes. A single module keeps the original ordering exactly.
      let moduleMatches: RoleAssignment[] = [];
      for (const m of modules) {
        for (const r of authContext.roles) {
          if ((r.module === m || r.module === '*') && !moduleMatches.includes(r)) {
            moduleMatches.push(r);
          }
        }
      }
      // Code review 2026-09-27 (Story 1.15): the base hat is a fallback, never an override. A
      // stable partition sinks every EMPLOYEE_MODULE-only match below every other match, so a
      // caller who holds both a specialist assignment and the base hat at the same location is
      // always authorized and audited under the specialist role. List-order semantics between two
      // ordinary (non-employee) modules are unaffected. Without this, listing EMPLOYEE_MODULE
      // first in a gate (as raise/list/get and the edge door all do) let the universal base-hat
      // assignment outrank a specialist's own assignment, stamping every specialist's own actions
      // as 'employee' in the audit trail - selectOperatingAssignment already applies the identical
      // preference for the bootstrap header role; this closes the same gap here.
      if (moduleMatches.some((r) => r.module === EMPLOYEE_MODULE)) {
        const specialist = moduleMatches.filter((r) => r.module !== EMPLOYEE_MODULE);
        // Story 8.9 (D9, amending 1.15 D9): a specialist role provisioned ON the employee module
        // (the CEO acts only through DOA, so its grant lives there) outranks the base-hat row on
        // the same module, so the audit reads 'ceo', never 'employee'.
        const employeeOnly = [
          ...moduleMatches.filter((r) => r.module === EMPLOYEE_MODULE && r.role !== EMPLOYEE_ROLE),
          ...moduleMatches.filter((r) => r.module === EMPLOYEE_MODULE && r.role === EMPLOYEE_ROLE),
        ];
        moduleMatches = [...specialist, ...employeeOnly];
      }
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
