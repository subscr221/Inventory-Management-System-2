import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageOf,
  bandLine,
  doaNote,
  formatRupees,
  matchesSearch,
  mergeAll,
  routeChip,
  rowStatus,
  totalValue,
  type ApprovalLine,
  type ApprovalRow,
} from '../../src/components/approvals-model.js';

/** Story 4.12 (Task 6.1): inbox merge, status, search, band and DOA note text, route chips. */

const row = (over: Partial<ApprovalRow>): ApprovalRow => ({
  indent_id: 'i-1',
  indent_number_ext: 'IND-2026-0001',
  status: 'raised',
  estimated_value: '1000.00',
  created_at: '2026-11-19T10:00:00Z',
  requester_display_name: 'Maint One',
  pending_for_me_line_ids: ['l-1'],
  line_skus: ['CON-GLOVES'],
  approved_line_count: 0,
  ...over,
});

const line = (over: Partial<ApprovalLine>): ApprovalLine => ({
  indent_line_id: 'l-1',
  line_no: 1,
  sku: 'CON-GLOVES',
  requested_qty: '2.000',
  uom: 'EA',
  line_value: '200.00',
  approval_route: 'doa',
  line_status: 'pending',
  decided_at: null,
  decided_by_display_name: null,
  rejection_reason: null,
  standing_grant_ref: null,
  cap: null,
  month_to_date_issued: null,
  approver_band: { role: 'department_head', value_min: null, value_max: 100000 },
  ...over,
});

const chips = {
  standing: 'Standing approval {ref}',
  standingCap: '{used} of {cap} used this month',
  selfLimit: 'Self-approval limit',
  doa: '{role} approval',
  doaUnknown: 'DOA approval',
};

describe('approvals model', () => {
  it('merges waiting before decided and drops duplicates', () => {
    const merged = mergeAll(
      [row({ indent_id: 'a' })],
      [row({ indent_id: 'a', pending_for_me_line_ids: [] }), row({ indent_id: 'b' })],
    );
    assert.deepStrictEqual(
      merged.map((r) => r.indent_id),
      ['a', 'b'],
    );
    assert.deepStrictEqual(merged[0]!.pending_for_me_line_ids, ['l-1']);
  });

  it('maps status: waiting, approved, rejected', () => {
    assert.strictEqual(rowStatus(row({})), 'waiting');
    assert.strictEqual(
      rowStatus(row({ pending_for_me_line_ids: [], status: 'approved', approved_line_count: 1 })),
      'approved',
    );
    assert.strictEqual(
      rowStatus(row({ pending_for_me_line_ids: [], status: 'raised', approved_line_count: 1 })),
      'approved',
    );
    assert.strictEqual(
      rowStatus(row({ pending_for_me_line_ids: [], status: 'rejected' })),
      'rejected',
    );
    assert.strictEqual(
      rowStatus(row({ pending_for_me_line_ids: [], status: 'raised' })),
      'rejected',
    );
  });

  it('searches reference, item sku and requester, case-insensitively', () => {
    const r = row({});
    assert.ok(matchesSearch(r, ''));
    assert.ok(matchesSearch(r, 'ind-2026'));
    assert.ok(matchesSearch(r, 'gloves'));
    assert.ok(matchesSearch(r, 'maint'));
    assert.ok(!matchesSearch(r, 'helmet'));
    assert.ok(!matchesSearch(row({ requester_display_name: null }), 'maint'));
  });

  it('formats rupees with Indian grouping and ages in one unit', () => {
    assert.strictEqual(formatRupees(100000), '1,00,000');
    assert.strictEqual(formatRupees('150000.5'), '1,50,000.50');
    assert.strictEqual(formatRupees(null), '');
    const now = Date.parse('2026-11-19T12:00:00Z');
    assert.deepStrictEqual(ageOf('2026-11-19T11:30:00Z', now), { unit: 'm', n: 30 });
    assert.deepStrictEqual(ageOf('2026-11-19T07:00:00Z', now), { unit: 'h', n: 5 });
    assert.deepStrictEqual(ageOf('2026-11-16T12:00:00Z', now), { unit: 'd', n: 3 });
  });

  it('band line: up to the max, above the min when unbounded, hidden when empty', () => {
    const tpl = { upTo: 'as {role}: up to Rs {max}', above: 'as {role}: above Rs {min}' };
    assert.strictEqual(
      bandLine([{ role: 'department_head', value_min: null, value_max: 100000 }], tpl),
      'as head of department: up to Rs 1,00,000',
    );
    assert.strictEqual(
      bandLine([{ role: 'finance_controller', value_min: 100000, value_max: null }], tpl),
      'as finance controller: above Rs 1,00,000',
    );
    assert.strictEqual(bandLine([], tpl), null);
  });

  it('DOA note follows the first line pending for the caller', () => {
    const tpl = {
      upTo: 'Routed to you as {role} by value band (up to Rs {max})',
      above: 'Routed to you as {role} by value band (above Rs {min})',
      headRole: "the requester's head of department",
    };
    const fin = line({
      indent_line_id: 'l-2',
      approver_band: { role: 'finance_controller', value_min: 100000, value_max: null },
    });
    assert.strictEqual(
      doaNote([line({}), fin], ['l-1'], tpl),
      "Routed to you as the requester's head of department by value band (up to Rs 1,00,000)",
    );
    assert.strictEqual(
      doaNote([line({}), fin], ['l-2'], tpl),
      'Routed to you as finance controller by value band (above Rs 1,00,000)',
    );
    assert.strictEqual(doaNote([line({})], [], tpl), null);
  });

  it('route chips: standing approval ok (with cap), self-approval info, DOA warn', () => {
    assert.deepStrictEqual(
      routeChip(
        line({
          approval_route: 'standing_approval',
          standing_grant_ref: 'SA-2026-004',
          cap: '6.000',
          month_to_date_issued: '4.000',
          approver_band: null,
        }),
        chips,
      ),
      { kind: 'ok', text: 'Standing approval SA-2026-004 - 4 of 6 used this month' },
    );
    assert.deepStrictEqual(
      routeChip(
        line({ approval_route: 'standing_approval', standing_grant_ref: 'SA-2026-005' }),
        chips,
      ),
      { kind: 'ok', text: 'Standing approval SA-2026-005' },
    );
    assert.deepStrictEqual(routeChip(line({ approval_route: 'self_approval' }), chips), {
      kind: 'info',
      text: 'Self-approval limit',
    });
    assert.deepStrictEqual(routeChip(line({}), chips), {
      kind: 'warn',
      text: 'Head of department approval',
    });
    assert.deepStrictEqual(routeChip(line({ approver_band: null }), chips), {
      kind: 'warn',
      text: 'DOA approval',
    });
  });

  it('totals line values without float drift', () => {
    assert.strictEqual(
      totalValue([line({ line_value: '0.10' }), line({ line_value: '0.20' })]),
      '0.30',
    );
  });
});
