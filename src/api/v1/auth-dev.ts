import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getParsedBody } from '../../middleware/context.js';
import { issueDevToken } from '../../middleware/auth.js';

/**
 * Dev-only test token issuance. Only registered in src/server.ts when AUTH_MODE=local.
 * See src/middleware/auth.ts#issueDevToken for the defensive runtime guard.
 */
export const devTokenHandler: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req);
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_REQUEST', 'Request body must be a JSON object');
  }
  const sub = (body as Record<string, unknown>)['sub'];
  if (typeof sub !== 'string' || !sub) {
    throw new AppError(400, 'INVALID_REQUEST', 'sub is required');
  }

  const token = await issueDevToken(sub);
  sendJson(res, 201, { token });
};
