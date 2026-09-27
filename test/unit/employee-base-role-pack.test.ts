import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPLOYEE_MODULE, EMPLOYEE_EDGE_EVENTS } from '../../src/middleware/rbac.js';
import { SEGREGATED_ROLE_PAIRS } from '../../src/cli/verify-segregated-roles-core.js';
import { EXTRA_FORBIDDEN_PAIRS } from '../../src/cli/provision-roles-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json');
const WORLD_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/world.json');
const SERVICE_ROLE = 'svc_erp_adapter';

interface RolesFile {
  people: Record<string, { display_name?: string }>;
  roles: {
    role: string;
    module: string;
    function_scope: string;
    location_id: string;
    holder: string;
  }[];
}

/**
 * Story 1.15 (D1, D8): the base hat is a real `employee` assignment at the site for every human in
 * the pilot pack; the ERP adapter service identity holds none.
 */
describe('Story 1.15 employee base role in the pilot pack', () => {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const serviceHolders = new Set(
    fixture.roles.filter((r) => r.role === SERVICE_ROLE).map((r) => r.holder),
  );

  it('the module constant is "employee"', () => {
    assert.strictEqual(EMPLOYEE_MODULE, 'employee');
  });

  it('the edge event allow-list names only indent.raised on the procurement stream', () => {
    assert.deepStrictEqual(EMPLOYEE_EDGE_EVENTS, [
      { stream_type: 'procurement', event_type: 'indent.raised' },
    ]);
  });

  it('every human person holds exactly one employee write grant at the site', () => {
    const humans = Object.keys(fixture.people).filter((email) => !serviceHolders.has(email));
    assert.strictEqual(humans.length, 20);
    for (const email of humans) {
      const rows = fixture.roles.filter((r) => r.holder === email && r.module === EMPLOYEE_MODULE);
      assert.deepStrictEqual(
        rows,
        [
          {
            role: 'employee',
            module: 'employee',
            function_scope: 'write',
            location_id: 'site',
            holder: email,
          },
        ],
        `${email} must hold exactly one employee/employee/write/site grant`,
      );
    }
  });

  it('the ERP adapter service account holds no employee grant', () => {
    assert.strictEqual(serviceHolders.size, 1);
    for (const holder of serviceHolders) {
      assert.strictEqual(
        fixture.roles.filter((r) => r.holder === holder && r.role === 'employee').length,
        0,
      );
    }
  });

  it('no role other than employee sits on the employee module', () => {
    assert.deepStrictEqual(
      fixture.roles.filter((r) => r.module === EMPLOYEE_MODULE && r.role !== 'employee'),
      [],
    );
  });

  it('no segregation pair names the employee role', () => {
    for (const p of SEGREGATED_ROLE_PAIRS) {
      assert.notStrictEqual(p.setterRole, 'employee');
      assert.notStrictEqual(p.approverRole, 'employee');
    }
    for (const p of EXTRA_FORBIDDEN_PAIRS) {
      assert.notStrictEqual(p.a, 'employee');
      assert.notStrictEqual(p.b, 'employee');
    }
  });

  it('the operations employee actor holds no procurement and no inventory grant', () => {
    const world = JSON.parse(readFileSync(WORLD_FIXTURE, 'utf-8')) as {
      operations: { actors: Record<string, string> };
    };
    const actor = world.operations.actors['employee'];
    assert.ok(actor, 'world.json operations.actors.employee is missing');
    assert.ok(Object.prototype.hasOwnProperty.call(fixture.people, actor));
    const modules = fixture.roles.filter((r) => r.holder === actor).map((r) => r.module);
    assert.ok(modules.includes(EMPLOYEE_MODULE));
    assert.ok(!modules.includes('procurement') && !modules.includes('inventory'), modules.join());
  });
});
