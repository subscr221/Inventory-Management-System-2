import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAssignBody,
  canRevoke,
  describeGrant,
  emptyAssignForm,
  isGrantRow,
  parsePruneDays,
  type GrantRow,
} from '../../src/components/standing-grants-model';

const U = '00000000-0000-4000-8000-000000000001';
const S = '00000000-0000-4000-8000-000000000002';

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    grant_id: U,
    grant_ref: 'SA-2026-014',
    grant_kind: 'standing_approval',
    grantee_user_id: U,
    grantee_name: 'Ramu',
    scope_label: 'Cleaning gear',
    site_id: S,
    monthly_qty_cap: '6.000',
    limit_amount: null,
    end_date: null,
    status: 'active',
    ...over,
  };
}

describe('Story 4.8 standing grants model', () => {
  it('builds a standing approval body for an item or a group', () => {
    const form = {
      ...emptyAssignForm(S),
      grantee_user_id: U,
      scope: 'CON-GLOVES',
      monthly_qty_cap: '6',
    };
    assert.deepEqual(buildAssignBody(form), {
      ok: true,
      body: {
        grant_kind: 'standing_approval',
        grantee_user_id: U,
        site_id: S,
        scope_sku: 'CON-GLOVES',
        monthly_qty_cap: '6',
      },
    });
    const group = buildAssignBody({
      ...form,
      scope_type: 'group',
      scope: 'clean-1',
      monthly_qty_cap: '',
    });
    assert.ok(
      group.ok &&
        group.body.scope_item_group_code === 'CLEAN-1' &&
        !('monthly_qty_cap' in group.body),
    );
  });

  it('builds a limit body and refuses what the server would', () => {
    const base = {
      ...emptyAssignForm(S),
      grant_kind: 'self_approval_limit' as const,
      grantee_user_id: U,
    };
    assert.deepEqual(buildAssignBody({ ...base, limit_amount: '25000' }), {
      ok: true,
      body: {
        grant_kind: 'self_approval_limit',
        grantee_user_id: U,
        site_id: S,
        limit_amount: '25000',
      },
    });
    assert.deepEqual(buildAssignBody({ ...base, limit_amount: '0' }), {
      ok: false,
      reason: 'bad_limit',
    });
    assert.deepEqual(buildAssignBody({ ...base, grantee_user_id: 'x', limit_amount: '5' }), {
      ok: false,
      reason: 'bad_grantee',
    });
    assert.deepEqual(buildAssignBody({ ...base, site_id: '', limit_amount: '5' }), {
      ok: false,
      reason: 'bad_site',
    });
    assert.deepEqual(buildAssignBody({ ...base, limit_amount: '5', end_date: '1/2/2026' }), {
      ok: false,
      reason: 'bad_end_date',
    });
    const standing = { ...emptyAssignForm(S), grantee_user_id: U };
    assert.deepEqual(buildAssignBody(standing), { ok: false, reason: 'no_scope' });
    assert.deepEqual(buildAssignBody({ ...standing, scope: 'A', monthly_qty_cap: '1.2345' }), {
      ok: false,
      reason: 'bad_cap',
    });
  });

  it('accepts only well-formed rows and describes them without grade words', () => {
    assert.equal(isGrantRow(grant()), true);
    assert.equal(isGrantRow({ grant_id: 1 }), false);
    const text = describeGrant(grant({ end_date: '2026-12-31' }));
    assert.equal(text, 'SA-2026-014 · Ramu · Cleaning gear, up to 6.000 a month, until 2026-12-31');
    assert.ok(!/junior|No approval required/i.test(text));
    assert.match(
      describeGrant(grant({ grant_kind: 'self_approval_limit', limit_amount: '25000.0000' })),
      /limit Rs 25000/,
    );
  });

  it('revokes only live grants and parses the prune interval', () => {
    assert.equal(canRevoke({ status: 'pending-finance' }), true);
    assert.equal(canRevoke({ status: 'active' }), true);
    assert.equal(canRevoke({ status: 'revoked' }), false);
    assert.equal(parsePruneDays('30'), 30);
    assert.equal(parsePruneDays('0'), null);
    assert.equal(parsePruneDays('366'), null);
    assert.equal(parsePruneDays('1.5'), null);
  });
});
