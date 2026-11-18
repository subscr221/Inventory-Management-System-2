import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SITE_ROLES } from '../../src/cli/verify-segregated-roles-core.js';
import {
  forbiddenPairs,
  planProvisioning,
  type RolesFile as ProvisioningRolesFile,
} from '../../src/cli/provision-roles-core.js';

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

/** Story 2.10 (D11): the single grant a store controller receives - warehouse read, at the site. */
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
 * Story 2.10 (AC 8, D11): `store_controller` exists, is provisionable, is held at the pilot site by
 * the existing warehouse_manager holder, and grants no write power in this story.
 */
describe('Story 2.10 store controller role in the pilot pack', () => {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const example = JSON.parse(readFileSync(EXAMPLE_FIXTURE, 'utf-8')) as RolesFile;
  const world = JSON.parse(readFileSync(WORLD_FIXTURE, 'utf-8')) as {
    people: { email: string; roles: string[] }[];
    operations: { actors: Record<string, string> };
  };

  it('exactly one store_controller grant, on the warehouse_manager holder, read at the site', () => {
    assert.deepStrictEqual(
      fixture.roles.filter((r) => r.role === STORE_CONTROLLER),
      [storeControllerGrant(PILOT_HOLDER)],
    );
    // Negative control: the holder is the pilot warehouse_manager holder.
    const wmHolders = new Set(
      fixture.roles.filter((r) => r.role === 'warehouse_manager').map((r) => r.holder),
    );
    assert.deepStrictEqual([...wmHolders], [PILOT_HOLDER]);
  });

  it('the pack grows from 79 grants to 80 and from 25 roles to 26', () => {
    assert.strictEqual(fixture.roles.length, 80);
    assert.strictEqual(new Set(fixture.roles.map((r) => r.role)).size, 26);
  });

  it('the world fixture names the store controller as a hat and as an actor', () => {
    assert.strictEqual(world.operations.actors['storecontroller'], PILOT_HOLDER);
    const person = world.people.find((p) => p.email === PILOT_HOLDER);
    assert.ok(person?.roles.includes(STORE_CONTROLLER), JSON.stringify(person));
    // Negative control: nobody else wears the hat.
    assert.deepStrictEqual(
      world.people.filter((p) => p.roles.includes(STORE_CONTROLLER)).map((p) => p.email),
      [PILOT_HOLDER],
    );
  });

  it('the example roles file carries one store_controller row', () => {
    assert.deepStrictEqual(
      example.roles.filter((r) => r.role === STORE_CONTROLLER),
      [storeControllerGrant(EXAMPLE_HOLDER)],
    );
  });

  it('is neither a required site role nor in a forbidden pair yet (Task 8.4)', () => {
    assert.ok(!(REQUIRED_SITE_ROLES as readonly string[]).includes(STORE_CONTROLLER));
    for (const pair of forbiddenPairs()) {
      assert.ok(pair.a !== STORE_CONTROLLER && pair.b !== STORE_CONTROLLER, JSON.stringify(pair));
    }
  });

  it('the pilot pack and the example plan with zero violations and zero errors', () => {
    for (const file of [fixture, example]) {
      const plan = planProvisioning(file as unknown as ProvisioningRolesFile);
      assert.deepStrictEqual(plan.violations, []);
      assert.deepStrictEqual(plan.errors, []);
      const holder = plan.people.find((p) => p.roles.some((r) => r.role === STORE_CONTROLLER));
      assert.ok(holder, 'a planned person holds store_controller');
      assert.deepStrictEqual(
        holder.roles
          .filter((r) => r.role === STORE_CONTROLLER)
          .map((r) => [r.module, r.functionScope, r.locationId]),
        [['warehouse', 'read', file.site_id.toLowerCase()]],
      );
    }
  });
});
