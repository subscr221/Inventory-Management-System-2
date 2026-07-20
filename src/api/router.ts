import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../middleware/error.js';
import { AppError, sendRequestError, withErrorHandler } from '../middleware/error.js';
import { readJsonBody } from '../middleware/body.js';
import { authenticateRequest } from '../middleware/auth.js';
import { setParsedBody, setAuthContext, setTraceId } from '../middleware/context.js';

export interface RouteSummary {
  method: string;
  path: string;
}

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Paths that do not require a user SSO session. SCIM authenticates via its own static
// bearer token inside the handler; the dev-token endpoint is how a token is obtained in
// the first place, so it cannot itself require one.
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/auth\/dev-token$/,
  /^\/api\/v1\/scim\/v2\/Users(\/.*)?$/,
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.addRoute('PATCH', path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.addRoute('PUT', path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.addRoute('DELETE', path, handler);
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:([^/]+)/g, (_match, paramName: string) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      path,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler: withErrorHandler(handler),
    });
  }

  listRoutes(): RouteSummary[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setTraceId(req, randomUUID());

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendRequestError(req, res, 400, 'BAD_REQUEST', 'Invalid URL');
      return;
    }
    const method = req.method ?? 'GET';

    // Normalize a trailing slash (except root) so `/api/v1/health/` matches routes and the
    // public allowlist the same as `/api/v1/health`.
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    // Authenticate BEFORE reading the body: an unauthenticated caller must receive 401 for any
    // protected endpoint and must not be able to make the server buffer a request body first.
    if (!isPublicPath(pathname)) {
      try {
        const authContext = await authenticateRequest(req);
        setAuthContext(req, authContext);
      } catch (err) {
        if (err instanceof AppError) {
          sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
          return;
        }
        sendRequestError(req, res, 401, 'UNAUTHORIZED', 'Authentication required');
        return;
      }
    }

    if (BODY_BEARING_METHODS.has(method)) {
      try {
        const body = await readJsonBody(req);
        setParsedBody(req, body);
      } catch (err) {
        if (err instanceof AppError) {
          sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
          return;
        }
        sendRequestError(req, res, 500, 'INTERNAL_ERROR', 'Internal server error');
        return;
      }
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        try {
          params[name] = decodeURIComponent(match[i + 1] ?? '');
        } catch {
          params[name] = match[i + 1] ?? '';
        }
      });

      await route.handler(req, res, params);
      return;
    }

    sendRequestError(req, res, 404, 'NOT_FOUND', `No route for ${method} ${pathname}`);
  }
}
