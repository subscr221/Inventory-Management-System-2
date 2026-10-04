import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPLOYEE_EDGE_EVENTS } from '../../src/middleware/rbac.js';
import { EDGE_DAMAGE_EVENT_TYPES } from '../../src/sync/upload.js';
import { config } from '../../src/config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_FIXTURE = resolve(__dirname, '../../docs/migration/pilot-mock-extract/roles.json');
const BANDS_SCRIPT = resolve(__dirname, '../../deploy/provision/staging-doa-bands.sh');

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

/** The three damage DOA types and the role the pilot band script names for each (Table 8). */
function damageBands(): Map<string, string> {
  const script = readFileSync(BANDS_SCRIPT, 'utf-8');
  const bands = new Map<string, string>();
  for (const match of script.matchAll(/^band\s+(\S+)\s+(damage\.\S+)\s+\S+\s*$/gm)) {
    bands.set(match[2]!, match[1]!);
  }
  return bands;
}

/**
 * Story 8.9 (the Story 3.12 lesson): a notification to a role nobody holds reaches nobody. Every
 * role a damage case notifies or needs a decision from must have a real holder at the pilot site.
 */
describe('Story 8.9 damage routing reaches real pilot holders', () => {
  const fixture = JSON.parse(readFileSync(ROLES_FIXTURE, 'utf-8')) as RolesFile;
  const holdersAtSite = (role: string): Set<string> =>
    new Set(
      fixture.roles
        .filter((r) => r.role === role && (r.location_id === 'site' || r.location_id === '*'))
        .map((r) => r.holder),
    );

  it('the pilot band script registers the three damage DOA types', () => {
    const bands = damageBands();
    assert.deepStrictEqual([...bands.keys()].sort(), [
      'damage.escalation',
      'damage.finance_concurrence',
      'damage.qc_concurrence',
    ]);
    assert.strictEqual(bands.get('damage.qc_concurrence'), 'qc_head');
    assert.strictEqual(bands.get('damage.finance_concurrence'), 'finance_controller');
    assert.strictEqual(bands.get('damage.escalation'), 'ceo');
  });

  it('every Table 8 role has at least one holder at the site', () => {
    const roles = [
      config.quality.inspectionTaskNotificationRole,
      config.damage.storesNotificationRole,
      ...damageBands().values(),
    ];
    for (const role of roles) {
      const holders = holdersAtSite(role);
      assert.ok(holders.size > 0, `no holder of "${role}" at the site in ${ROLES_FIXTURE}`);
      for (const holder of holders) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(fixture.people, holder),
          `holder "${holder}" of "${role}" is not a key of "people"`,
        );
      }
    }
  });

  it('exactly one person holds ceo, and that person holds no other specialist role', () => {
    const ceoHolders = holdersAtSite('ceo');
    assert.strictEqual(ceoHolders.size, 1, 'exactly one ceo holder');
    const [ceo] = [...ceoHolders];
    const otherRoles = new Set(
      fixture.roles
        .filter((r) => r.holder === ceo && r.role !== 'ceo' && r.role !== 'employee')
        .map((r) => r.role),
    );
    assert.deepStrictEqual([...otherRoles], []);
  });

  it('the edge door accepts damage.reported and no other damage event', () => {
    const damagePairs = EMPLOYEE_EDGE_EVENTS.filter((e) => e.event_type.startsWith('damage.'));
    assert.deepStrictEqual(damagePairs, [{ stream_type: 'damage', event_type: 'damage.reported' }]);
    assert.deepStrictEqual([...EDGE_DAMAGE_EVENT_TYPES], ['damage.reported']);
  });
});
