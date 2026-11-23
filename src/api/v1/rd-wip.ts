import type { RouteHandler } from '../../middleware/error.js';
import { sendRequestError } from '../../middleware/error.js';
import { requireRole } from '../../middleware/rbac.js';
import {
  getRdProjectBuilds,
  getRdProjectWip,
} from '../../read/projections/rd_project_wip_ledger.js';
import { listRdScrapPending } from '../../read/projections/rd_disposition.js';

const projectBase: RouteHandler = async (req, res, params) => {
  const projectCode = (params?.projectCode ?? '').trim().toUpperCase();
  if (!projectCode) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'projectCode is required');
    return;
  }
  const builds = await getRdProjectBuilds(projectCode);
  const wip = await getRdProjectWip(projectCode);
  const scrapPending = await listRdScrapPending({ project_code: projectCode });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ project_code: projectCode, builds, wip, scrap_pending: scrapPending }));
};
export const getRdProjectWipHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  projectBase,
);
export const getRdProjectBuildsHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(projectBase);
