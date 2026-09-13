import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planProvisioning,
  formatPlan,
  forbiddenPairs,
  type RolesFile,
} from '../../src/cli/provision-roles-core.js';

const SITE = '11111111-1111-4111-8111-111111111111';

function file(roles: RolesFile['roles'], people?: RolesFile['people']): RolesFile {
  return { site_id: SITE, roles, ...(people ? { people } : {}) };
}

describe('provision-roles planner (pilot cutover accounts, 2026-09-13)', () => {
  it('groups assignments per holder, resolves site and * locations, defaults external_id to the email', () => {
    const plan = planProvisioning(
      file(
        [
          {
            role: 'migration_lead',
            module: 'migration',
            function_scope: 'write',
            location_id: 'site',
            holder: 'Lead@Example.com',
          },
          {
            role: 'migration_lead',
            module: 'migration',
            function_scope: 'read',
            location_id: 'site',
            holder: 'lead@example.com',
          },
          {
            role: 'finance_controller',
            module: 'migration',
            function_scope: 'write',
            location_id: '*',
            holder: 'fin@example.com',
          },
        ],
        { 'fin@example.com': { display_name: 'Deepa', external_id: 'idp-subject-42' } },
      ),
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.violations, []);
    assert.deepEqual(
      plan.people.map((p) => [p.email, p.external_id, p.display_name, p.roles.length]),
      [
        ['fin@example.com', 'idp-subject-42', 'Deepa', 1],
        ['lead@example.com', 'lead@example.com', null, 2],
      ],
    );
    assert.equal(plan.people[1]!.roles[0]!.locationId, SITE);
    assert.equal(plan.people[0]!.roles[0]!.locationId, '*');
  });

  it('refuses every forbidden pairing held by one person, including the 13.3 two-people rule', () => {
    const one = 'one@example.com';
    const plan = planProvisioning(
      file([
        {
          role: 'migration_lead',
          module: 'migration',
          function_scope: 'write',
          location_id: 'site',
          holder: one,
        },
        {
          role: 'department_head',
          module: 'migration',
          function_scope: 'write',
          location_id: 'site',
          holder: one,
        },
        {
          role: 'finance_controller',
          module: 'migration',
          function_scope: 'write',
          location_id: '*',
          holder: one,
        },
        { role: 'cfo', module: 'jobwork', function_scope: 'write', location_id: '*', holder: one },
      ]),
    );
    const pairs = plan.violations.map((v) => `${v.role_a}/${v.role_b}`).sort();
    assert.ok(pairs.includes('migration_lead/department_head'));
    assert.ok(pairs.includes('migration_lead/finance_controller'));
    assert.ok(pairs.includes('finance_controller/cfo'));
    assert.ok(pairs.includes('department_head/finance_controller'));
    assert.match(formatPlan(plan, false), /REFUSE one@example.com holds both/);
    assert.ok(forbiddenPairs().length >= 4);
  });

  it('reports validation errors instead of guessing', () => {
    const plan = planProvisioning({
      site_id: 'not-a-uuid',
      roles: [
        {
          role: '',
          module: 'migration',
          function_scope: 'admin',
          location_id: 'nowhere',
          holder: 'nobody',
        },
      ],
    } as unknown as RolesFile);
    assert.ok(plan.errors.some((e) => e.includes('site_id')));
    assert.ok(plan.errors.some((e) => e.includes('role is required')));
    assert.ok(plan.errors.some((e) => e.includes('function_scope')));
    assert.ok(plan.errors.some((e) => e.includes('location_id')));
    assert.ok(plan.errors.some((e) => e.includes('holder')));
    assert.match(formatPlan(plan, false), /dry run/);
  });
});
