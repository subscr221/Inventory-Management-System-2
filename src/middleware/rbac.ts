import type { RouteHandler } from './error.js';
import { AppError } from './error.js';
import { getAuthContext, getParsedBody, setAuthorizedRole } from './context.js';
import type { RoleAssignment } from '../read/projections/users.js';

/**
 * Computes the locations a caller may read within a module from their role assignments.
 * `wildcard` is true if any read-satisfying assignment grants all locations (`*`); otherwise
 * `locations` holds the explicit location ids. A `write` assignment satisfies read as well.
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
    else locations.add(r.locationId);
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
      const resolvedModule = typeof options.module === 'function' ? options.module(params, body) : options.module;

      // A request that does not resolve to a concrete module must be rejected outright - a
      // wildcard ('*') assignment must not be allowed to satisfy an unknown/empty module.
      if (!resolvedModule) {
        throw new AppError(400, 'INVALID_MODULE', 'Request does not resolve to a known module');
      }

      const moduleMatches = authContext.roles.filter((r) => r.module === resolvedModule || r.module === '*');
      if (moduleMatches.length === 0) {
        throw new AppError(
          403,
          'MODULE_ACCESS_DENIED',
          `No role assignment grants access to module "${resolvedModule}"`,
        );
      }

      const functionMatches = moduleMatches.filter((r) => satisfiesFunctionScope(r, options.functionScope));
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
        authorizingAssignment = functionMatches.find(
          (r) => r.locationId === '*' || r.locationId === resolvedLocation,
        );
        if (!authorizingAssignment) {
          throw new AppError(
            403,
            'LOCATION_ACCESS_DENIED',
            `No role assignment grants access to location "${resolvedLocation}"`,
          );
        }
      }

      if (authorizingAssignment) {
        setAuthorizedRole(req, authorizingAssignment.role);
      }

      await handler(req, res, params);
    };
  };
}
