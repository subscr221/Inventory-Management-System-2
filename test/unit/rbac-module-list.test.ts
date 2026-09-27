import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireRole } from '../../src/middleware/rbac.js';
import type { RbacOptions } from '../../src/middleware/rbac.js';
import { AppError } from '../../src/middleware/error.js';
import { setAuthContext, getAuthorizedAssignment } from '../../src/middleware/context.js';
import type { RoleAssignment } from '../../src/read/projections/users.js';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

function grant(
  role: string,
  module: string,
  functionScope: 'read' | 'write',
  locationId: string,
): RoleAssignment {
  return { role, module, functionScope, locationId } as RoleAssignment;
}

/**
 * Runs `requireRole(options)` against a fake request holding `roles`. Returns the assignment the
 * gate authorized, or the AppError it raised.
 */
async function run(
  options: RbacOptions,
  roles: RoleAssignment[],
): Promise<{ assignment?: RoleAssignment | undefined; error?: AppError }> {
  const req = { url: '/x', method: 'GET', headers: {} } as unknown as IncomingMessage;
  setAuthContext(req, { userId: 'u1', externalId: 'u1', displayName: null, roles });
  let assignment: RoleAssignment | undefined;
  const handler = requireRole(options)(async (r) => {
    assignment = getAuthorizedAssignment(r);
  });
  try {
    await handler(req, {} as ServerResponse, {});
    return { assignment };
  } catch (err) {
    if (err instanceof AppError) return { error: err };
    throw err;
  }
}

/** Story 1.15 D2: requireRole accepts a list of modules, meaning any-of in list order. */
describe('Story 1.15 requireRole module list', () => {
  const employeeA = grant('employee', 'employee', 'write', SITE_A);
  const procurementA = grant('procurement_officer', 'procurement', 'write', SITE_A);
  const procurementB = grant('procurement_officer', 'procurement', 'write', SITE_B);

  it('matches a caller holding only the second listed module', async () => {
    const { assignment, error } = await run(
      { module: ['employee', 'procurement'], functionScope: 'write' },
      [procurementA],
    );
    assert.strictEqual(error, undefined);
    assert.strictEqual(assignment, procurementA);
  });

  // Code review 2026-09-27: this used to assert the opposite (employeeA wins because it is
  // listed first) - that was the actual bug. The base hat is a fallback, never an override, so a
  // caller holding both the base hat and a specialist assignment is always authorized and
  // audited under the specialist assignment, regardless of gate list order or role order.
  it('the base hat never outranks a specialist assignment, even when it is listed first', async () => {
    const { assignment } = await run(
      { module: ['employee', 'procurement'], functionScope: 'write' },
      [procurementA, employeeA],
    );
    assert.strictEqual(assignment, procurementA);
  });

  it('the base hat never outranks a specialist assignment through a location resolver either', async () => {
    const { assignment } = await run(
      {
        module: ['employee', 'procurement'],
        functionScope: 'write',
        locationId: () => SITE_A,
      },
      [employeeA, procurementA],
    );
    assert.strictEqual(assignment, procurementA);
  });

  it('list order decides at the resolved location; location coverage filters first', async () => {
    const { assignment } = await run(
      {
        module: ['employee', 'procurement'],
        functionScope: 'write',
        locationId: () => SITE_B,
      },
      [employeeA, procurementB],
    );
    assert.strictEqual(assignment, procurementB);
  });

  it('a dynamic resolver may return a list', async () => {
    const { assignment } = await run(
      { module: () => ['employee', 'procurement'], functionScope: 'read' },
      [employeeA],
    );
    assert.strictEqual(assignment, employeeA);
  });

  it('MODULE_ACCESS_DENIED names the first listed module when no listed module is held', async () => {
    const { error } = await run({ module: ['employee', 'procurement'], functionScope: 'read' }, [
      grant('gate_officer', 'inventory', 'write', SITE_A),
    ]);
    assert.strictEqual(error?.statusCode, 403);
    assert.strictEqual(error?.errorCode, 'MODULE_ACCESS_DENIED');
    assert.strictEqual(error?.message, 'No role assignment grants access to module "employee"');
  });

  it('FUNCTION_ACCESS_DENIED when every listed-module assignment is read-only', async () => {
    const { error } = await run({ module: ['employee', 'procurement'], functionScope: 'write' }, [
      grant('auditor', 'procurement', 'read', SITE_A),
    ]);
    assert.strictEqual(error?.errorCode, 'FUNCTION_ACCESS_DENIED');
  });

  it('LOCATION_ACCESS_DENIED when no listed-module assignment covers the location', async () => {
    const { error } = await run(
      {
        module: ['employee', 'procurement'],
        functionScope: 'write',
        locationId: () => SITE_B,
      },
      [employeeA, procurementA],
    );
    assert.strictEqual(error?.errorCode, 'LOCATION_ACCESS_DENIED');
  });

  it('a wildcard-module assignment satisfies any listed module', async () => {
    const admin = grant('super_admin', '*', 'write', '*');
    const { assignment } = await run(
      { module: ['employee', 'procurement'], functionScope: 'write' },
      [admin],
    );
    assert.strictEqual(assignment, admin);
  });

  it('INVALID_MODULE when the list is empty or holds only empty names', async () => {
    const admin = grant('super_admin', '*', 'write', '*');
    for (const module of [[], [''], () => [] as string[]] as RbacOptions['module'][]) {
      const { error } = await run({ module, functionScope: 'read' }, [admin]);
      assert.strictEqual(error?.statusCode, 400);
      assert.strictEqual(error?.errorCode, 'INVALID_MODULE');
    }
  });

  it('a single string module behaves exactly as before', async () => {
    const { assignment } = await run({ module: 'procurement', functionScope: 'write' }, [
      employeeA,
      procurementA,
    ]);
    assert.strictEqual(assignment, procurementA);
    const { error } = await run({ module: 'procurement', functionScope: 'write' }, [employeeA]);
    assert.strictEqual(error?.errorCode, 'MODULE_ACCESS_DENIED');
    assert.strictEqual(error?.message, 'No role assignment grants access to module "procurement"');
  });
});
