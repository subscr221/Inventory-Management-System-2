import type { RouteHandler } from '../../middleware/error.js';
import { sendJson } from '../../middleware/error.js';

export const healthHandler: RouteHandler = async (_req, res, _params) => {
  sendJson(res, 200, { status: 'ok', version: '1' });
};
