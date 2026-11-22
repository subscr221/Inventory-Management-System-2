import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  headerApproverOf,
  resolveLineApprover,
  type LineRoute,
} from '../../src/compliance/indent-routing.js';
import { AppError } from '../../src/middleware/error.js';

// Story 4.9: no DB. A fake client answers the three registry reads resolveLineApprover makes.
interface World {
  band?: { entry_id: string; role: string };
  holders?: Record<string, string>;
  delegations?: Record<string, string>;
}

function fakeClient(w: World): PoolClient {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM doa_registry_entries') && sql.includes('LIMIT 1')) {
        return {
          rows: w.band
            ? [
                {
                  ...w.band,
                  transaction_type: 'indent_approval',
                  value_min: null,
                  value_max: null,
                  active: true,
                  created_at: '2026-01-01',
                  updated_at: '2026-01-01',
                },
              ]
            : [],
        };
      }
      if (sql.includes('FROM doa_registry_entries')) return { rows: [] };
      if (sql.includes('FROM user_role_assignments')) {
        const uid = w.holders?.[params[0] as string];
        return { rows: uid ? [{ user_id: uid, external_id: `ext-${uid}` }] : [] };
      }
      if (sql.includes('doa_vacation_delegations')) {
        const d = w.delegations?.[params[0] as string];
        return {
          rows: d
            ? [
                {
                  delegation_id: 'd1',
                  delegator_user_id: params[0],
                  delegate_user_id: d,
                  start_date: '2026-01-01',
                  end_date: '2099-01-01',
                  active: true,
                  created_at: '2026-01-01',
                },
              ]
            : [],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
}

const route = (over: Partial<LineRoute>): LineRoute => ({
  approval_route: 'doa',
  approver_actor_id: null,
  doa_entry_id: null,
  requires_approval: true,
  line_value: 0,
  standing_grant_id: null,
  fallback_reason: null,
  ...over,
});

describe('Story 4.9 resolveLineApprover fallback', () => {
  it('band match keeps the band approver and no fallback reason', async () => {
    const r = await resolveLineApprover(
      'indent_approval',
      50,
      1,
      fakeClient({ band: { entry_id: 'e1', role: 'finance' }, holders: { finance: 'u-fin' } }),
    );
    assert.deepStrictEqual(r, { approverActorId: 'u-fin', doaEntryId: 'e1', fallbackReason: null });
  });

  it('no band routes to the department_head holder with no_band_match', async () => {
    const r = await resolveLineApprover(
      'indent_approval',
      50,
      1,
      fakeClient({ holders: { department_head: 'u-hod' } }),
    );
    assert.deepStrictEqual(r, {
      approverActorId: 'u-hod',
      doaEntryId: null,
      fallbackReason: 'no_band_match',
    });
  });

  it('no band goes to the active delegate of the department_head', async () => {
    const r = await resolveLineApprover(
      'indent_approval',
      50,
      1,
      fakeClient({ holders: { department_head: 'u-hod' }, delegations: { 'u-hod': 'u-deputy' } }),
    );
    assert.strictEqual(r.approverActorId, 'u-deputy');
    assert.strictEqual(r.fallbackReason, 'no_band_match');
  });

  it('no band and no department_head holder refuses INDENT_APPROVAL_BAND_MISSING naming the role', async () => {
    await assert.rejects(
      resolveLineApprover('indent_approval', 50, 3, fakeClient({})),
      (e: unknown) =>
        e instanceof AppError &&
        e.statusCode === 409 &&
        e.errorCode === 'INDENT_APPROVAL_BAND_MISSING' &&
        e.message.includes('department_head') &&
        e.details['missing_role'] === 'department_head' &&
        e.details['line_no'] === 3,
    );
  });
});

describe('Story 4.9 fallback never self-approves', () => {
  it('requester is the department_head holder: refused', async () => {
    await assert.rejects(
      resolveLineApprover(
        'indent_approval',
        50,
        2,
        fakeClient({ holders: { department_head: 'u-req' } }),
        'u-req',
      ),
      (e: unknown) =>
        e instanceof AppError &&
        e.errorCode === 'INDENT_APPROVAL_BAND_MISSING' &&
        e.message.includes('department_head'),
    );
  });

  it('requester is the holder but delegate differs: delegate chosen', async () => {
    const r = await resolveLineApprover(
      'indent_approval',
      50,
      1,
      fakeClient({ holders: { department_head: 'u-req' }, delegations: { 'u-req': 'u-deputy' } }),
      'u-req',
    );
    assert.strictEqual(r.approverActorId, 'u-deputy');
  });

  it('delegate is the requester but holder differs: holder chosen', async () => {
    const r = await resolveLineApprover(
      'indent_approval',
      50,
      1,
      fakeClient({ holders: { department_head: 'u-hod' }, delegations: { 'u-hod': 'u-req' } }),
      'u-req',
    );
    assert.strictEqual(r.approverActorId, 'u-hod');
  });
});

describe('Story 4.9 headerApproverOf with fallback routes', () => {
  it('a fallback line is a header candidate by value, with a null doa_entry_id', () => {
    const h = headerApproverOf([
      route({ approver_actor_id: 'u-band', doa_entry_id: 'e1', line_value: 10 }),
      route({ approver_actor_id: 'u-hod', fallback_reason: 'no_band_match', line_value: 500 }),
    ]);
    assert.deepStrictEqual(h, { approver_actor_id: 'u-hod', doa_entry_id: null });
  });

  it('a lone fallback line makes its approver the header approver', () => {
    const h = headerApproverOf([
      route({ approver_actor_id: 'u-hod', fallback_reason: 'no_band_match', line_value: 1 }),
    ]);
    assert.strictEqual(h.approver_actor_id, 'u-hod');
  });
});
