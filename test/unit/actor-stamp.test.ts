import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { stampActedLocation } from '../../src/api/v1/actor-stamp.js';
import { setAuthContext, setAuthorizedAssignment } from '../../src/middleware/context.js';
import { attachLocationCoverage } from '../../src/middleware/rbac.js';
import type { RoleAssignment } from '../../src/read/projections/users.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const BIN_A = '33333333-3333-4333-8333-333333333333';
const BIN_B = '44444444-4444-4444-8444-444444444444';

/**
 * Pilot G2 review R7(d): the stamped location must come from the assignment that sets actor.role.
 */
describe('stampActedLocation', () => {
  async function requestFor(authorized: RoleAssignment, others: RoleAssignment[]) {
    const roles = [authorized, ...others];
    await attachLocationCoverage(roles, async () => ({
      rows: [
        { root_id: SITE_A, location_id: SITE_A },
        { root_id: SITE_A, location_id: BIN_A },
        { root_id: SITE_B, location_id: SITE_B },
        { root_id: SITE_B, location_id: BIN_B },
      ],
    }));
    const req = {} as IncomingMessage;
    setAuthContext(req, { userId: 'u', externalId: 'u', roles } as never);
    setAuthorizedAssignment(req, authorized);
    return req;
  }

  const assignment = (role: string, locationId: string): RoleAssignment =>
    ({ role, module: 'warehouse', functionScope: 'write', locationId }) as RoleAssignment;
  const actor = { role: 'store_assistant', auditLocationId: SITE_A, eventLocationId: SITE_A };

  it('stamps the bin when the authorized assignment covers it from above', async () => {
    const req = await requestFor(assignment('store_assistant', SITE_A), []);
    const stamped = stampActedLocation(req, actor, 'warehouse', BIN_A);
    assert.deepStrictEqual(stamped, { ...actor, auditLocationId: BIN_A, eventLocationId: BIN_A });
  });

  it('never pairs the authorized role with a bin only ANOTHER assignment reaches', async () => {
    const req = await requestFor(assignment('store_assistant', SITE_A), [
      assignment('dispatch_clerk', SITE_B),
    ]);
    assert.deepStrictEqual(stampActedLocation(req, actor, 'warehouse', BIN_B), actor);
  });
});
