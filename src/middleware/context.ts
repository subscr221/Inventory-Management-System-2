import type { IncomingMessage } from 'node:http';
import type { RoleAssignment } from '../read/projections/users.js';

export interface AuthContext {
  userId: string;
  externalId: string;
  roles: RoleAssignment[];
}

interface RequestContext extends IncomingMessage {
  parsedBody?: unknown;
  authContext?: AuthContext;
  authorizedRole?: string;
  authorizedAssignment?: RoleAssignment;
  traceId?: string;
}

/** Attaches the once-parsed JSON body to the request for downstream handlers/middleware to read. */
export function setParsedBody(req: IncomingMessage, body: unknown): void {
  (req as RequestContext).parsedBody = body;
}

/** Reads the body parsed by the router. Returns `undefined` if no body was parsed (e.g. GET requests). */
export function getParsedBody(req: IncomingMessage): unknown {
  return (req as RequestContext).parsedBody;
}

/** Attaches the resolved auth context (identity + roles) after successful authentication. */
export function setAuthContext(req: IncomingMessage, ctx: AuthContext): void {
  (req as RequestContext).authContext = ctx;
}

/** Reads the auth context attached by the router's global auth check. Undefined on public paths. */
export function getAuthContext(req: IncomingMessage): AuthContext | undefined {
  return (req as RequestContext).authContext;
}

/**
 * Records the role assignment that authorized the request (the one RBAC matched on
 * module + function + location). Handlers use it to stamp the audit actor's role from
 * the server's own authorization decision rather than trusting a client-supplied value.
 */
export function setAuthorizedRole(req: IncomingMessage, role: string): void {
  (req as RequestContext).authorizedRole = role;
}

/** Reads the role RBAC authorized this request under, if any. */
export function getAuthorizedRole(req: IncomingMessage): string | undefined {
  return (req as RequestContext).authorizedRole;
}

/**
 * Records the FULL role assignment that authorized the request (role, module, functionScope,
 * locationId), so handlers never have to re-derive it from the roles array - a by-name lookup
 * can pick a different assignment than the one RBAC actually matched.
 */
export function setAuthorizedAssignment(req: IncomingMessage, assignment: RoleAssignment): void {
  (req as RequestContext).authorizedAssignment = assignment;
}

/** Reads the exact role assignment RBAC authorized this request under, if any. */
export function getAuthorizedAssignment(req: IncomingMessage): RoleAssignment | undefined {
  return (req as RequestContext).authorizedAssignment;
}

/** Attaches a per-request trace_id for audit log and error envelope correlation. */
export function setTraceId(req: IncomingMessage, traceId: string): void {
  (req as RequestContext).traceId = traceId;
}

/** Reads the per-request trace_id, if set. */
export function getTraceId(req: IncomingMessage): string | undefined {
  return (req as RequestContext).traceId;
}
