import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forbiddenPairs,
  planProvisioning,
  type RolesFile as ProvisioningRolesFile,
} from '../../src/cli/provision-roles-core.js';
import { REQUIRED_SITE_ROLES } from '../../src/cli/verify-segregated-roles-core.js';
import { ITEM_GROUP_NOTIFY_ROLES } from '../../src/compliance/item-group-authority.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json');
const WORLD_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/world.json');
const EXAMPLE_FIXTURE = resolve(__dirname, '../../deploy/provision/roles.example.json');
const STORE_CONTROLLER = 'store_controller';
const PILOT_HOLDER = 'cmf_supervisor@ancorlabs.org';
const EXAMPLE_HOLDER = 'store.controller@example.com';

interface Grant {
  role: string;
  module: string;
  function_scope: string;
  location_id: string;
  holder: string;
}

interface RolesFile {
  site_id: string;
  people: Record<string, { display_name?: string }>;
  roles: Grant[];
}

/** Story 2.10 D11: the one grant a store controller receives, read-only on warehouse at the site. */
function storeControllerGrant(holder: string): Grant {
  return {
    role: STORE_CONTROLLER,
    module: 'warehouse',
    function_scope: 'read',
    location_id: 'site',
    holder,
  };
}

/**
 * Story 2.10 (D11, Task 8): `store_controller` is a real, provisionable role in the pilot pack. It
 * grants no write power and no capability beyond receiving item group notifications.
 */
describe('Story 2.10 store controller role in the pilot pack', () => {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const example = JSON.parse(readFileSync(EXAMPLE_FIXTURE, 'utf-8')) as RolesFile;

  it('exactly one person holds store_controller and it is the existing warehouse_manager holder', () => {
    const holders = [
      ...new Set(fixture.roles.filter((r) => r.role === STORE_CONTROLLER).map((r) => r.holder)),
    ];
    assert.deepStrictEqual(holders, [PILOT_HOLDER]);
    assert.ok(
      fixture.roles.some((r) => r.role === 'warehouse_manager' && r.holder === PILOT_HOLDER),
      'the holder is the pilot warehouse_manager holder',
    );
  });

  it('the holder has exactly one grant: warehouse, read, site (no write power)', () => {
    assert.deepStrictEqual(
      fixture.roles.filter((r) => r.role === STORE_CONTROLLER),
      [storeControllerGrant(PILOT_HOLDER)],
    );
    // Negative control: no store_controller grant is a write grant or the wildcard.
    assert.strictEqual(
      fixture.roles.filter((r) => r.role === STORE_CONTROLLER && r.function_scope === 'write')
        .length,
      0,
    );
    assert.strictEqual(
      fixture.roles.filter((r) => r.role === STORE_CONTROLLER && r.location_id === '*').length,
      0,
    );
  });

  it('the example roles file has the same row for the example store controller', () => {
    assert.deepStrictEqual(
      example.roles.filter((r) => r.role === STORE_CONTROLLER),
      [storeControllerGrant(EXAMPLE_HOLDER)],
    );
    assert.ok(example.people[EXAMPLE_HOLDER], 'the example holder is a named person');
  });

  it('planning the pilot pack and the example file returns zero violations and zero errors', () => {
    for (const file of [fixture, example]) {
      const plan = planProvisioning(file as unknown as ProvisioningRolesFile);
      assert.deepStrictEqual(plan.violations, []);
      assert.deepStrictEqual(plan.errors, []);
    }
    const plan = planProvisioning(fixture as unknown as ProvisioningRolesFile);
    const holder = plan.people.find((p) => p.email === PILOT_HOLDER);
    assert.ok(
      holder?.roles.some(
        (r) =>
          r.role === STORE_CONTROLLER &&
          r.module === 'warehouse' &&
          r.functionScope === 'read' &&
          r.locationId === fixture.site_id.toLowerCase(),
      ),
      'store_controller is provisionable and resolves to the site id',
    );
  });

  it('is deliberately not in REQUIRED_SITE_ROLES or the forbidden pairs (D11, Task 8.4)', () => {
    assert.ok(!(REQUIRED_SITE_ROLES as readonly string[]).includes(STORE_CONTROLLER));
    const pairs = forbiddenPairs();
    assert.ok(!pairs.some((p) => p.a === STORE_CONTROLLER || p.b === STORE_CONTROLLER));
  });

  it('is one of the roles notified of item group changes', () => {
    assert.ok((ITEM_GROUP_NOTIFY_ROLES as readonly string[]).includes(STORE_CONTROLLER));
  });

  it('world.json lists the role for the holder and the storecontroller actor', () => {
    const world = JSON.parse(readFileSync(WORLD_FIXTURE, 'utf-8')) as {
      people: { email: string; roles: string[] }[];
      operations: { actors: Record<string, string> };
    };
    const person = world.people.find((p) => p.email === PILOT_HOLDER);
    assert.ok(person?.roles.includes(STORE_CONTROLLER));
    assert.strictEqual(world.operations.actors['storecontroller'], PILOT_HOLDER);
  });
});
