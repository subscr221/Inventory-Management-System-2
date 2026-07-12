import type { RouteHandler } from './error.js';
import { AppError } from './error.js';
import { getAuthContext, getParsedBody } from './context.js';
import type { RoleAssignment } from '../read/projections/users.js';

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

      const resolvedLocation = options.locationId?.(params, body);
      if (resolvedLocation !== undefined) {
        const locationMatches = functionMatches.some(
          (r) => r.locationId === '*' || r.locationId === resolvedLocation,
        );
        if (!locationMatches) {
          throw new AppError(
            403,
            'LOCATION_ACCESS_DENIED',
            `No role assignment grants access to location "${resolvedLocation}"`,
          );
        }
      }

      await handler(req, res, params);
    };
  };
}
