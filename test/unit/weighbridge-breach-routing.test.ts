import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOLERANCE_BREACH_OWNER_ROLE } from '../../src/compliance/weighbridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json');
const SRC_ROOT = resolve(__dirname, '../../src');
const RETIRED_ROLE = 'receiving_supervisor';

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

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Story 3.12: a weighbridge tolerance breach must be routed to a role that a real pilot account
 * holds. Story 3.3 routed it to `receiving_supervisor`, a role the access matrix does not define
 * and the pilot pack never provisions, so every breach reached nobody.
 */
describe('Story 3.12 weighbridge breach routing', () => {
  it('Case A: the breach owner role is the unloading supervisor (access matrix row)', () => {
    assert.strictEqual(TOLERANCE_BREACH_OWNER_ROLE, 'unloading_supervisor');
  });

  it('Case B: the pilot roles fixture has at least one holder of the breach owner role at the site', () => {
    const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
    const grants = fixture.roles.filter(
      (r) =>
        r.role === TOLERANCE_BREACH_OWNER_ROLE &&
        (r.location_id === 'site' || r.location_id === '*'),
    );
    assert.ok(
      grants.length > 0,
      `no holder of role "${TOLERANCE_BREACH_OWNER_ROLE}" at location "site" or "*" in ${ROLES_FIXTURE}; a tolerance breach would reach nobody at pilot`,
    );
    for (const grant of grants) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(fixture.people, grant.holder),
        `holder "${grant.holder}" of role "${TOLERANCE_BREACH_OWNER_ROLE}" is not a key of "people" in ${ROLES_FIXTURE}`,
      );
    }
  });

  it('Case B2: every holder of the breach owner role can read in-app notifications (AC3)', () => {
    // GET /api/v1/notifications is gated by requireRole({ module: 'notification', functionScope: 'read' });
    // a holder without that grant is targeted by the dispatcher but cannot see the breach reason.
    const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
    const holders = new Set(
      fixture.roles
        .filter(
          (r) =>
            r.role === TOLERANCE_BREACH_OWNER_ROLE &&
            (r.location_id === 'site' || r.location_id === '*'),
        )
        .map((r) => r.holder),
    );
    assert.ok(
      holders.size > 0,
      `no holder of "${TOLERANCE_BREACH_OWNER_ROLE}" in ${ROLES_FIXTURE}`,
    );
    for (const holder of holders) {
      const canRead = fixture.roles.some(
        (r) =>
          r.holder === holder &&
          (r.module === 'notification' || r.module === '*') &&
          (r.function_scope === 'read' || r.function_scope === 'write'),
      );
      assert.ok(
        canRead,
        `holder "${holder}" of "${TOLERANCE_BREACH_OWNER_ROLE}" has no "notification" module grant in ${ROLES_FIXTURE}; GET /api/v1/notifications would return 403`,
      );
    }
  });

  it(`Case C: the literal "${RETIRED_ROLE}" appears nowhere under src/`, () => {
    const hits = walkTs(SRC_ROOT).filter((file) =>
      readFileSync(file, 'utf-8').includes(RETIRED_ROLE),
    );
    assert.deepStrictEqual(
      hits.map((f) => f.slice(SRC_ROOT.length + 1).replace(/\\/g, '/')),
      [],
      `"${RETIRED_ROLE}" is not a pilot role and must not be referenced in src/`,
    );
  });
});
