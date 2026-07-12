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
