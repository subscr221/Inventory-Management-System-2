import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../middleware/error.js';
import { sendError, withErrorHandler } from '../middleware/error.js';

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler);
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:([^/]+)/g, (_match, paramName: string) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler: withErrorHandler(handler),
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1] ?? '';
      });

      await route.handler(req, res, params);
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`);
  }
}
