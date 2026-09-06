import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getAdminPool, closeAdminPool, closePool } from '../../src/config/db.js';
import {
  verifySegregatedRoles,
  formatSegregatedRolesReport,
  SEGREGATED_ROLE_PAIRS,
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
    [[SETTER_ROLE, APPROVER_ROLE, OTHER_ROLE], ids],
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

    const result = await verifySegregatedRoles(pool, [PAIR]);

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

    const result = await verifySegregatedRoles(pool, [PAIR]);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['ROLES_SHARE_HOLDER']);
    assert.deepEqual(result.violations[0]!.details['shared_user_ids'], [userIds['controller']]);
  });

  it('fails when the approver role has no active holder', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await addBand(APPROVER_ROLE, 100000);
    await pool.query(`UPDATE users SET active = false WHERE user_id = $1`, [userIds['chief']]);

    const result = await verifySegregatedRoles(pool, [PAIR]);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['ROLE_UNHELD']);
    assert.equal(result.violations[0]!.details['role'], APPROVER_ROLE);
  });

  it('fails when no active band governs the transaction type', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);

    const result = await verifySegregatedRoles(pool, [PAIR]);

    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.violations), ['DOA_BAND_MISSING']);
  });

  it('fails when a second role is banded on the same transaction type', async () => {
    await assignRole(userIds['controller']!, SETTER_ROLE);
    await assignRole(userIds['chief']!, APPROVER_ROLE);
    await assignRole(userIds['other']!, OTHER_ROLE);
    await addBand(APPROVER_ROLE, 100000);
    await addBand(OTHER_ROLE, 50000);

    const result = await verifySegregatedRoles(pool, [PAIR]);

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

    const inWindow = await verifySegregatedRoles(pool, [PAIR], '2026-09-15');
    assert.equal(inWindow.ok, false);
    assert.deepEqual(codes(inWindow.violations), ['DELEGATION_COLLAPSES_PAIR']);

    // Outside the delegation window the same data is clean: the collapse is time-bounded.
    const outOfWindow = await verifySegregatedRoles(pool, [PAIR], '2026-10-15');
    assert.equal(outOfWindow.ok, true, JSON.stringify(outOfWindow.violations));
  });
});
