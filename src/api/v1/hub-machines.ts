import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson } from '../../middleware/error.js';
import { requireRole } from '../../middleware/rbac.js';
import { HUB_UUID } from '../../compliance/hub-customer.js';
import { getHubMachineById, listHubMachines } from '../../read/projections/hub.js';
import {
  assertHubLocationAccess,
  HUB_MODULE,
  hubBody,
  hubReadScope,
  persistHubEvent,
} from './hub-common.js';

// Story 10.4 (FR-RD-14): link a hub machine to its Epic 7 asset and usage meter.
const create: RouteHandler = async (req, res) => {
  const b = hubBody(req);
  if (typeof b['location_id'] === 'string') assertHubLocationAccess(req, b['location_id'], 'write');
  const machineId = randomUUID();
  const saved = await persistHubEvent(req, res, {
    streamId: machineId,
    actedLocation: typeof b['location_id'] === 'string' ? b['location_id'] : undefined,
    eventType: 'hub.machine_registered',
    idField: 'machine_id',
    compare: ['machine_code', 'location_id', 'asset_id', 'meter_id', 'operator_role'],
    payload: {
      machine_id: machineId,
      machine_code: b['machine_code'],
      location_id: b['location_id'],
      asset_id: b['asset_id'],
      meter_id: b['meter_id'] ?? null,
      operator_role: b['operator_role'],
    },
  });
  if (saved)
    sendJson(res, 201, { machine: await getHubMachineById(saved.id), event_id: saved.event.event_id });
};
// D2: link (or confirm) the usage meter of a machine registered without one.
const linkMeter: RouteHandler = async (req, res, params) => {
  const b = hubBody(req);
  const machineId = params?.machineId ?? '';
  const existing = HUB_UUID.test(machineId) ? await getHubMachineById(machineId) : null;
  if (existing) assertHubLocationAccess(req, existing.location_id, 'write');
  const saved = await persistHubEvent(req, res, {
    streamId: machineId,
    actedLocation: existing?.location_id,
    eventType: 'hub.machine_meter_linked',
    idField: 'machine_id',
    streamFromUrl: true,
    status: 200,
    compare: ['machine_id', 'meter_id'],
    payload: { machine_id: machineId, meter_id: b['meter_id'] },
  });
  if (saved)
    sendJson(res, 200, { machine: await getHubMachineById(saved.id), event_id: saved.event.event_id });
};
const list: RouteHandler = async (req, res) => {
  sendJson(res, 200, { rows: await listHubMachines(hubReadScope(req)) });
};
export const createHubMachineHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'write',
})(create);
export const linkHubMachineMeterHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'write',
})(linkMeter);
export const listHubMachinesHandler = requireRole({
  module: HUB_MODULE,
  functionScope: 'read',
})(list);
