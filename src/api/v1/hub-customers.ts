import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson } from '../../middleware/error.js';
import { requireRole } from '../../middleware/rbac.js';
import { getAuthContext } from '../../middleware/context.js';
import { getHubCustomerById, listHubCustomers } from '../../read/projections/hub.js';
import {
  assertHubCustomerLocationGiven,
  assertHubLocationAccess,
  HUB_MODULE,
  hubBody,
  hubReadScope,
  persistHubEvent,
} from './hub-common.js';

// Story 10.4 (FR-RD-13): hub member and walk-in customer records.
const create: RouteHandler = async (req, res) => {
  const b = hubBody(req);
  // P-D: a location-scoped writer must name a location; a global writer may leave it out.
  assertHubCustomerLocationGiven(getAuthContext(req)?.roles ?? [], b['location_id']);
  if (typeof b['location_id'] === 'string') assertHubLocationAccess(req, b['location_id'], 'write');
  const customerId = randomUUID();
  const saved = await persistHubEvent(req, res, {
    streamId: customerId,
    actedLocation: typeof b['location_id'] === 'string' ? b['location_id'] : undefined,
    eventType: 'hub.customer_registered',
    idField: 'customer_id',
    // X5: no phone or other contact field is captured, stored or returned in Phase 1.
    compare: ['customer_kind', 'display_name', 'membership_no', 'location_id'],
    payload: {
      customer_id: customerId,
      customer_kind: b['customer_kind'],
      display_name: b['display_name'],
      membership_no: b['membership_no'],
      location_id: b['location_id'],
    },
  });
  if (saved)
    sendJson(res, 201, { customer: await getHubCustomerById(saved.id), event_id: saved.event.event_id });
};
const list: RouteHandler = async (req, res) => {
  sendJson(res, 200, { rows: await listHubCustomers(hubReadScope(req)) });
};
export const createHubCustomerHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'write',
})(create);
export const listHubCustomersHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'read',
})(list);
