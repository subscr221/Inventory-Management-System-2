import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getAdminPool, closeAdminPool, closePool } from '../../src/config/db.js';
import {
  verifySegregatedRoles,
  formatSegregatedRolesReport,
  SEGREGATED_ROLE_PAIRS,
  REQUIRED_SITE_ROLES,
  type SegregatedRolePair,
  type SegregationViolationCode,
} from '../../src/cli/verify-segregated-roles-core.js';

/**
 * Story 9.7 Task 0: the go-live check that the segregated role pair is actually held by two
 * different real people, and that the DOA band it depends on cannot resolve the second signature
 * somewhere else.
 *
 * Real PostgreSQL, admin pool for fixtures (app_user has no DELETE). Every role name and
 * transaction type is run-scoped, so the suite neither sees nor disturbs roles seeded by other
 * suites or by a real environment.
 */

const run = randomUUID().slice(0, 8).toUpperCase();
const SETTER_ROLE = `finance_controller_${run}`;
const APPROVER_ROLE = `cfo_${run}`;
const OTHER_ROLE = `treasurer_${run}`;
const TRANSACTION_TYPE = `jobwork.offcut_acquisition_${run}`;
// Story 1.16 (D5): run-scoped required roles and sites, so the section is asserted on rows this
// suite owns while other suites' sites stay in the register untouched.
const REQUIRED_ROLE = `site_head_${run}`;
const REQUIRED_ROLE_2 = `qc_head_${run}`;
const SITE_A = { id: randomUUID(), code: `SEG-SITE-A-${run}` };
const SITE_B = { id: randomUUID(), code: `SEG-SITE-B-${run}` };
const SITE_INACTIVE = { id: randomUUID(), code: `SEG-SITE-OFF-${run}` };
const ZONE_A = { id: randomUUID(), code: `SEG-ZONE-A-${run}` };

const PAIR: SegregatedRolePair = {
  transactionType: TRANSACTION_TYPE,
  setterRole: SETTER_ROLE,
  approverRole: APPROVER_ROLE,
  reason: 'test pair',
};

const pool = getAdminPool();
const userIds: Record<string, string> = {};

async function createUser(label: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (external_id, email, display_name, active)
     VALUES ($1, $2, $3, true) RETURNING user_id`,
    [`${label}-${run}`, `${label}-${run}@example.test`, `${label} ${run}`],
  );
  return (result.rows[0] as { user_id: string }).user_id;
}

async function assignRole(userId: string, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
     VALUES ($1, $2, 'jobwork', 'write', '*')`,
    [userId, role],
  );
}

async function assignRoleAt(userId: string, role: string, locationId: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
     VALUES ($1, $2, 'jobwork', 'write', $3)`,
    [userId, role, locationId],
  );
}

async function createLocation(
  location: { id: string; code: string },
  level: 'site' | 'zone',
  siteId: string,
  status: 'active' | 'inactive',
): Promise<void> {
  await pool.query(
    `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
     VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', false, $6)`,
    [location.id, location.code, level, siteId, siteId, status],
  );
}

async function addBand(role: string, valueMin: number | null): Promise<void> {
  await pool.query(
    `INSERT INTO doa_registry_entries (role, transaction_type, value_min, value_max, active)
     VALUES ($1, $2, $3, NULL, true)`,
    [role, TRANSACTION_TYPE, valueMin],
  );
}

/** Removes only this run's fixture rows; nothing global is touched. */
async function resetFixtures(): Promise<void> {
  const ids = Object.values(userIds);
  await pool.query(
    `DELETE FROM doa_vacation_delegations
      WHERE delegator_user_id = ANY($1::uuid[]) OR delegate_user_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(`DELETE FROM doa_registry_entries WHERE transaction_type = $1`, [
    TRANSACTION_TYPE,
  ]);
  await pool.query(
    `DELETE FROM user_role_assignments WHERE role = ANY($1::text[]) AND user_id = ANY($2::uuid[])`,
    [[SETTER_ROLE, APPROVER_ROLE, OTHER_ROLE, REQUIRED_ROLE, REQUIRED_ROLE_2], ids],
  );
  await pool.query(`UPDATE users SET active = true WHERE user_id = ANY($1::uuid[])`, [ids]);
}

function codes(violations: { code: SegregationViolationCode }[]): SegregationViolationCode[] {
  return violations.map((violation) => violation.code).sort();
}

describe('Segregated role pairs (Story 9.7 Task 0)', () => {
  before(async () => {
    userIds['controller'] = await createUser('seg-controller');
    userIds['chief'] = await createUser('seg-chief');
    userIds['other'] = await createUser('seg-other');
    await createLocation(SITE_A, 'site', SITE_A.id, 'active');
    await createLocation(SITE_B, 'site', SITE_B.id, 'active');
    await createLocation(SITE_INACTIVE, 'site', SITE_INACTIVE.id, 'inactive');
    await createLocation(ZONE_A, 'zone', SITE_A.id, 'active');
  });

  beforeEach(async () => {
    await resetFixtures();
  });

  after(async () => {
    await resetFixtures();
    await pool.query(`DELETE FROM user_role_assignments WHERE user_id = ANY($1::uuid[])`, [
      Object.values(userIds),
    ]);
    await pool.query(`DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [Object.values(userIds)]);
    await pool.query(`DELETE FROM location_register WHERE location_id = ANY($1::uuid[])`, [
      [ZONE_A.id, SITE_A.id, SITE_B.id, SITE_INACTIVE.id],
    ]);
    await closeAdminPool();
    await closePool();
  });

  it('declares the offcut acquisition pair the story requires', () => {
    const declared = SEGREGATED_ROLE_PAIRS.find(
      (pair) => pair.transactionType === 'jobwork.offcut_acquisition',
    );
    assert.ok(declared, 'jobwork.offcut_acquisition must be a declared segregated pair');
    assert.equal(declared.setterRole, 'finance_controller');
    assert.equal(declared.approverRole, 'cfo');
  });

  it('passes when two different active users hold the pair over a single-role band', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, []);

    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.deepEqual(result.violations, []);
    assert.equal(result.pairs[0]!.active_band_count, 1);
    assert.equal(result.pairs[0]!.setter_holder_user_ids.length, 1);
    assert.equal(result.pairs[0]!.approver_holder_user_ids.length, 1);
    // 'OK  ' is padded to the width of 'FAIL', then the separating space.
    assert.match(formatSegregatedRolesReport(result), /^OK {3}jobwork\.offcut_acquisition_/);
  });

  it('fails when one user holds both halves of the pair', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['controller']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, []);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['ROLES_SHARE_HOLDER']);
    assert.deepEqual(result.violations[0]!.details['shared_user_ids'], [userIds['controller']]);
  });

  it('fails when the approver role has no active holder', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);
    await pool.query(`UPDATE users SET active = false WHERE user_id = $1`, [userIds['chief']]);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, []);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['ROLE_UNHELD']);
    assert.equal(result.violations[0]!.details['role'], APPROVER_ROLE);
  });

  it('fails when no active band governs the transaction type', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, []);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['DOA_BAND_MISSING']);
  });

  it('fails when a second role is banded on the same transaction type', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await assignRole(userIds['other']!, OTHER_ROLE);
    await addBand(APPROVER_ROLE, 100000);
    await addBand(OTHER_ROLE, 50000);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, []);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['DOA_TYPE_MULTI_ROLE']);
    assert.deepEqual(result.violations[0]!.details['foreign_roles'], [OTHER_ROLE]);
  });

  it('fails when an active delegation puts both halves back on one person', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);
    await pool.query(
      `INSERT INTO doa_vacation_delegations
         (delegator_user_id, delegate_user_id, start_date, end_date, active)
       VALUES ($1, $2, DATE '2026-09-01', DATE '2026-09-30', true)`,
      [userIds['chief'], userIds['controller']],
    );

    const inWindow = await verifySegregatedRoles(pool, [PAIR], '2026-09-15', []);
    assert.equal(inWindow.ok, false);
    assert.deepEqual(codes(inWindow.violations), ['DELEGATION_COLLAPSES_PAIR']);

    // Outside the delegation window the same data is clean: the collapse is time-bounded.
    const outOfWindow = await verifySegregatedRoles(pool, [PAIR], '2026-10-15', []);
    assert.equal(outOfWindow.ok, true, JSON.stringify(outOfWindow.violations));
  });

  // Story 1.16 (D5): a role the site cannot run without must have a holder at every active site.
  // Other suites leave their own sites in the register, so every assertion below reads the rows
  // this suite owns; only a holder at '*' can make the whole result ready.
  type Result = Awaited<ReturnType<typeof verifySegregatedRoles>>;
  const OWN_SITE_IDS: string[] = [SITE_A.id, SITE_B.id, SITE_INACTIVE.id, ZONE_A.id];
  const ownEntries = (result: Result): Result['required_roles'] =>
    result.required_roles
      .filter((entry) => OWN_SITE_IDS.includes(entry.site_id))
      .sort((a, b) => `${a.role}|${a.site_code}`.localeCompare(`${b.role}|${b.site_code}`));
  const ownViolations = (result: Result): Result['violations'] =>
    result.violations.filter(
      (violation) =>
        violation.code === 'ROLE_UNHELD_AT_SITE' &&
        OWN_SITE_IDS.includes(violation.details['site_id'] as string),
    );

  it('requires the four roles ruled on 2026-09-30 by default', () => {
    assert.deepEqual(REQUIRED_SITE_ROLES, [
      'site_head',
      'warehouse_manager',
      'department_head',
      'qc_head',
    ]);
  });

  it('reports one required-role entry per role per active site, and none for other rows', async () => {
    const result = await verifySegregatedRoles(pool, [], undefined, [
      REQUIRED_ROLE,
      REQUIRED_ROLE_2,
    ]);

    // Two roles at two active sites. The inactive site and the zone are not sites to staff.
    assert.deepEqual(
      ownEntries(result).map((entry) => [entry.role, entry.site_id, entry.site_code]),
      [
        [REQUIRED_ROLE_2, SITE_A.id, SITE_A.code],
        [REQUIRED_ROLE_2, SITE_B.id, SITE_B.code],
        [REQUIRED_ROLE, SITE_A.id, SITE_A.code],
        [REQUIRED_ROLE, SITE_B.id, SITE_B.code],
      ],
    );
    assert.deepEqual(result.pairs, []);
  });

  it('passes a required role held at the site and prints its line', async () => {
    await assignRoleAt(userIds['controller']!, REQUIRED_ROLE, SITE_A.id);

    const result = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);

    const entry = ownEntries(result).find((e) => e.site_id === SITE_A.id);
    assert.deepEqual(entry, {
      role: REQUIRED_ROLE,
      site_id: SITE_A.id,
      site_code: SITE_A.code,
      holder_user_ids: [userIds['controller']],
      ok: true,
    });
    assert.deepEqual(
      ownViolations(result).filter((v) => v.details['site_id'] === SITE_A.id),
      [],
    );
    // 'OK  ' is padded to the width of 'FAIL', then the separating space.
    const report = formatSegregatedRolesReport(result);
    assert.ok(
      report.split('\n').includes(`OK   ${REQUIRED_ROLE} at ${SITE_A.code}: 1 holder(s)`),
      report,
    );
  });

  it('fails a required role nobody holds at the site, naming the role and the site', async () => {
    const result = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);

    assert.equal(result.ok, false);
    const entry = ownEntries(result).find((e) => e.site_id === SITE_A.id);
    assert.deepEqual(entry, {
      role: REQUIRED_ROLE,
      site_id: SITE_A.id,
      site_code: SITE_A.code,
      holder_user_ids: [],
      ok: false,
    });
    const violation = ownViolations(result).find((v) => v.details['site_id'] === SITE_A.id);
    assert.ok(violation, JSON.stringify(result.violations));
    assert.equal(violation.code, 'ROLE_UNHELD_AT_SITE');
    assert.deepEqual(violation.details, {
      role: REQUIRED_ROLE,
      site_id: SITE_A.id,
      site_code: SITE_A.code,
    });
    assert.ok(violation.message.includes(`"${REQUIRED_ROLE}"`), violation.message);
    assert.ok(violation.message.includes(SITE_A.code), violation.message);

    const lines = formatSegregatedRolesReport(result).split('\n');
    assert.ok(lines.includes(`FAIL ${REQUIRED_ROLE} at ${SITE_A.code}: 0 holder(s)`));
    assert.equal(
      lines.at(-1),
      `${result.violations.length} violation(s). This deployment is NOT ready for go-live.`,
    );
  });

  it('a holder at another site does not satisfy this site', async () => {
    await assignRoleAt(userIds['controller']!, REQUIRED_ROLE, SITE_B.id);

    const result = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);

    assert.deepEqual(
      ownEntries(result).map((e) => [e.site_code, e.holder_user_ids, e.ok]),
      [
        [SITE_A.code, [], false],
        [SITE_B.code, [userIds['controller']], true],
      ],
    );
    assert.deepEqual(
      ownViolations(result).map((v) => v.details['site_id']),
      [SITE_A.id],
    );
  });

  it('a holder at every site satisfies each site, and the report closes ready', async () => {
    await assignRoleAt(userIds['chief']!, REQUIRED_ROLE, '*');

    const result = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);

    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.deepEqual(result.violations, []);
    assert.deepEqual(
      ownEntries(result).map((e) => [e.site_code, e.holder_user_ids, e.ok]),
      [
        [SITE_A.code, [userIds['chief']], true],
        [SITE_B.code, [userIds['chief']], true],
      ],
    );
    assert.equal(
      formatSegregatedRolesReport(result).split('\n').at(-1),
      'All segregated role pairs are provisioned on separate users.',
    );
  });

  it('an inactive user does not hold a required role', async () => {
    await assignRoleAt(userIds['controller']!, REQUIRED_ROLE, SITE_A.id);
    await pool.query(`UPDATE users SET active = false WHERE user_id = $1`, [userIds['controller']]);

    const result = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);

    const entry = ownEntries(result).find((e) => e.site_id === SITE_A.id);
    assert.deepEqual(entry?.holder_user_ids, []);
    assert.equal(entry?.ok, false);
    assert.equal(result.ok, false);
  });

  it('prints the required-role lines after the pair lines and before the violations', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);

    const result = await verifySegregatedRoles(pool, [PAIR], undefined, [REQUIRED_ROLE]);
    const lines = formatSegregatedRolesReport(result).split('\n');

    const pairLine = lines.findIndex((line) => line.startsWith(`OK   ${TRANSACTION_TYPE}:`));
    const roleLine = lines.indexOf(`FAIL ${REQUIRED_ROLE} at ${SITE_A.code}: 0 holder(s)`);
    const firstViolation = lines.findIndex((line) => line.startsWith('  ROLE_UNHELD_AT_SITE:'));
    const lastRoleLine = lines.findLastIndex((line) => / at .*: \d+ holder\(s\)$/.test(line));
    assert.equal(pairLine, 0, lines.join('\n'));
    assert.ok(roleLine > pairLine, lines.join('\n'));
    assert.ok(firstViolation > lastRoleLine, lines.join('\n'));
  });

  it('an empty required-role list reports nothing and fails nothing', async () => {
    const result = await verifySegregatedRoles(pool, [], undefined, []);

    assert.deepEqual(result.required_roles, []);
    assert.deepEqual(result.violations, []);
    assert.equal(result.ok, true);
  });

  it('a role named twice is reported once per site (code review)', async () => {
    const once = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE]);
    const twice = await verifySegregatedRoles(pool, [], undefined, [REQUIRED_ROLE, REQUIRED_ROLE]);

    assert.deepEqual(
      ownEntries(twice).map((e) => [e.role, e.site_code]),
      [
        [REQUIRED_ROLE, SITE_A.code],
        [REQUIRED_ROLE, SITE_B.code],
      ],
    );
    assert.equal(ownViolations(twice).length, 2);
    assert.equal(twice.violations.length, once.violations.length);
  });
});
