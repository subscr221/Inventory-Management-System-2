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
const SITE_HEAD = 'site_head';
const PILOT_HOLDER = 'cmf_supervisor@ancorlabs.org';
const EXAMPLE_HOLDER = 'site.head@example.com';

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

/** Story 1.16 Table 1: the grants every site head receives, in pack order. */
function siteHeadGrants(holder: string): Grant[] {
  return [
    { role: SITE_HEAD, module: 'jobwork', function_scope: 'write', location_id: 'site', holder },
    { role: SITE_HEAD, module: 'jobwork', function_scope: 'read', location_id: 'site', holder },
    {
      role: SITE_HEAD,
      module: 'notification',
      function_scope: 'read',
      location_id: 'site',
      holder,
    },
  ];
}

/**
 * Story 1.16 (D2, D3, D5, D6): `site_head` is a real assignment in the pilot pack, held by the
 * person already called Site Head, scoped to the site, and kept apart from both finance hats.
 */
describe('Story 1.16 site head role in the pilot pack', () => {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const example = JSON.parse(readFileSync(EXAMPLE_FIXTURE, 'utf-8')) as RolesFile;
  const requiredSiteRoles = REQUIRED_SITE_ROLES;

  it('exactly one person holds site_head and it is the pilot Site Head', () => {
    const holders = [
      ...new Set(fixture.roles.filter((r) => r.role === SITE_HEAD).map((r) => r.holder)),
    ];
    assert.deepStrictEqual(holders, [PILOT_HOLDER]);
    assert.strictEqual(fixture.people[PILOT_HOLDER]?.display_name, 'Site Head');
  });

  it('the holder has exactly the three Table 1 grants', () => {
    assert.deepStrictEqual(
      fixture.roles.filter((r) => r.role === SITE_HEAD),
      siteHeadGrants(PILOT_HOLDER),
    );
  });

  it('every site_head grant is scoped to the site, never the wildcard', () => {
    const rows = fixture.roles.filter((r) => r.role === SITE_HEAD);
    assert.strictEqual(rows.length, 3);
    for (const row of rows) assert.strictEqual(row.location_id, 'site', JSON.stringify(row));
    assert.strictEqual(rows.filter((r) => r.location_id === '*').length, 0);
  });

  it('the holder keeps the three warehouse_manager grants and the employee base hat (D2)', () => {
    const own = fixture.roles.filter((r) => r.holder === PILOT_HOLDER);
    assert.deepStrictEqual(
      own.filter((r) => r.role === 'warehouse_manager').map((r) => [r.module, r.function_scope]),
      [
        ['warehouse', 'write'],
        ['inventory', 'write'],
        ['receiving', 'write'],
      ],
    );
    assert.deepStrictEqual(
      own.filter((r) => r.role === 'employee'),
      [
        {
          role: 'employee',
          module: 'employee',
          function_scope: 'write',
          location_id: 'site',
          holder: PILOT_HOLDER,
        },
      ],
    );
    // Three warehouse_manager, three site_head, one store_controller (Story 2.10), one employee:
    // nothing else rides along.
    assert.strictEqual(own.length, 8);
  });

  it('the pack holds 80 grants and 26 roles (Story 1.16 took it to 79 and 25; Story 2.10 added store_controller)', () => {
    assert.strictEqual(fixture.roles.length, 80);
    assert.strictEqual(new Set(fixture.roles.map((r) => r.role)).size, 26);
  });

  it('no site_head holder holds finance_controller or cfo (D6)', () => {
    const siteHeads = new Set(
      fixture.roles.filter((r) => r.role === SITE_HEAD).map((r) => r.holder),
    );
    assert.strictEqual(siteHeads.size, 1);
    for (const holder of siteHeads) {
      const finance = fixture.roles.filter(
        (r) => r.holder === holder && (r.role === 'finance_controller' || r.role === 'cfo'),
      );
      assert.deepStrictEqual(finance, [], `${holder} must hold neither finance hat`);
    }
    // Negative control: the finance hats do exist in the pack, on other people.
    assert.ok(fixture.roles.some((r) => r.role === 'finance_controller'));
    assert.ok(fixture.roles.some((r) => r.role === 'cfo'));
  });

  it('the example roles file gives the example site head the same three grants', () => {
    assert.deepStrictEqual(
      example.roles.filter((r) => r.role === SITE_HEAD),
      siteHeadGrants(EXAMPLE_HOLDER),
    );
    // The existing warehouse_manager row survives.
    assert.strictEqual(
      example.roles.filter((r) => r.holder === EXAMPLE_HOLDER && r.role === 'warehouse_manager')
        .length,
      1,
    );
  });

  it('forbiddenPairs carries both site head and finance pairs (D6)', () => {
    const pairs = forbiddenPairs().map((p) => `${p.a}|${p.b}`);
    assert.ok(pairs.includes('site_head|finance_controller'), pairs.join());
    assert.ok(pairs.includes('site_head|cfo'), pairs.join());
    // The Story 13.3 pair is still there.
    assert.ok(pairs.includes('department_head|finance_controller'), pairs.join());
  });

  it('a site head who also holds a finance hat is refused at planning time (D6)', () => {
    for (const financeRole of ['finance_controller', 'cfo']) {
      const plan = planProvisioning({
        site_id: fixture.site_id,
        people: {},
        roles: [
          ...siteHeadGrants('both.hats@example.com'),
          {
            role: financeRole,
            module: 'jobwork',
            function_scope: 'write',
            location_id: '*',
            holder: 'both.hats@example.com',
          },
        ],
      } as unknown as ProvisioningRolesFile);
      assert.deepStrictEqual(
        plan.violations.map((v) => [v.holder, v.role_a, v.role_b]),
        [['both.hats@example.com', SITE_HEAD, financeRole]],
      );
    }
  });

  it('stores location ids lower-case, whatever case the roles file uses (code review)', () => {
    const upperSite = '9E4A90A8-5E35-4CA9-B988-D563CFF74DE3';
    const upperOther = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
    const plan = planProvisioning({
      site_id: upperSite,
      people: {},
      roles: [
        ...siteHeadGrants('upper.case@example.com'),
        {
          role: 'warehouse_manager',
          module: 'inventory',
          function_scope: 'write',
          location_id: upperOther,
          holder: 'upper.case@example.com',
        },
        {
          role: 'internal_auditor',
          module: 'inventory',
          function_scope: 'read',
          location_id: '*',
          holder: 'upper.case@example.com',
        },
      ],
    } as unknown as ProvisioningRolesFile);
    assert.deepStrictEqual(plan.errors, []);
    assert.deepStrictEqual(
      plan.people[0]!.roles.map((r) => [r.role, r.module, r.functionScope, r.locationId]),
      [
        ['site_head', 'jobwork', 'write', upperSite.toLowerCase()],
        ['site_head', 'jobwork', 'read', upperSite.toLowerCase()],
        ['site_head', 'notification', 'read', upperSite.toLowerCase()],
        ['warehouse_manager', 'inventory', 'write', upperOther.toLowerCase()],
        ['internal_auditor', 'inventory', 'read', '*'],
      ],
    );
  });

  it('planning the pilot pack returns zero violations and zero errors', () => {
    const plan = planProvisioning(fixture as unknown as ProvisioningRolesFile);
    assert.deepStrictEqual(plan.violations, []);
    assert.deepStrictEqual(plan.errors, []);
  });

  it('REQUIRED_SITE_ROLES names the four roles ruled on 2026-09-30 (D5)', () => {
    assert.deepStrictEqual(requiredSiteRoles, [
      'site_head',
      'warehouse_manager',
      'department_head',
      'qc_head',
    ]);
  });

  it('every required site role has a holder in the pack at the site', () => {
    assert.strictEqual(requiredSiteRoles.length, 4);
    for (const role of requiredSiteRoles) {
      const atSite = fixture.roles.filter((r) => r.role === role && r.location_id === 'site');
      assert.ok(atSite.length >= 1, `no holder of "${role}" at "site" in the pilot pack`);
    }
  });

  it('world.json names the site head as a person with both hats and as the sitehead actor', () => {
    const world = JSON.parse(readFileSync(WORLD_FIXTURE, 'utf-8')) as {
      people: { email: string; roles: string[] }[];
      operations: { actors: Record<string, string> };
    };
    const person = world.people.find((p) => p.email === PILOT_HOLDER);
    assert.ok(person, `${PILOT_HOLDER} is missing from world.json people`);
    assert.deepStrictEqual(person.roles, ['warehouse_manager', 'site_head', 'store_controller']);
    assert.strictEqual(world.operations.actors['sitehead'], PILOT_HOLDER);
    assert.strictEqual(world.operations.actors['whmanager'], PILOT_HOLDER);
  });
});
