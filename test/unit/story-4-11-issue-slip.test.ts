import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderIssueSlip } from '../../src/warehouse/document-renderer.js';
import { openQtyOf } from '../../src/read/projections/indent.js';
import {
  approvalBasisText,
  normaliseIssueLines,
  qtyExceeds,
} from '../../src/compliance/indent-issue.js';
import type { IndentLineRow } from '../../src/read/projections/indent.js';

// Story 4.11 (Task 8.2): the slip renderer is pure, the open quantity is NUMERIC text, and the
// body normaliser is the single rule both the route and the seam apply.

describe('Story 4.11 issue slip and helpers', () => {
  it('renders the slip in the packing-slip idiom with the Table 2 basis per line', () => {
    const slip = renderIssueSlip({
      issue_number_ext: 'ISS-2026-0233',
      site_id: 'site-1',
      indent_number_ext: 'IND-2026-0446',
      requester_user_id: 'ramu',
      department_code: 'HOUSEKEEPING',
      earlier_slips: ['ISS-2026-0012'],
      issued_by: 'storekeeper',
      issued_at: '2026-09-25T04:48:00.000Z',
      lines: [
        {
          line_no: 1,
          sku: 'CON-PHENYL',
          quantity: '2',
          uom: 'CAN',
          location_code: 'R-A1-02',
          lot_id: 'L-2609-117',
          serial_count: 0,
          requested_qty: '2.000',
          issued_to_date: '2.000',
          approval_basis: 'Approved by department_head (dh) on 2026-09-24',
        },
        {
          line_no: 2,
          sku: 'EQ-DRILL',
          quantity: '1',
          uom: 'EA',
          location_code: 'R-B2-01',
          lot_id: null,
          serial_count: 1,
          requested_qty: '3.000',
          issued_to_date: '1.000',
          approval_basis: 'Within self-approval limit',
        },
      ],
    });
    const lines = slip.split('\n');
    assert.equal(lines[0], 'ISSUE SLIP ISS-2026-0233');
    assert.equal(lines[1], '='.repeat(30));
    assert.ok(slip.includes('Requisition   : IND-2026-0446'), slip);
    assert.ok(slip.includes('Issued to     : ramu (HOUSEKEEPING)'), slip);
    assert.ok(slip.includes('Earlier slips : ISS-2026-0012'), slip);
    assert.ok(slip.includes('Issued at     : 2026-09-25 (2026-09-25T04:48:00.000Z)'), slip);
    assert.ok(
      slip.includes(
        '  1. CON-PHENYL qty 2 CAN from R-A1-02 lot L-2609-117 | requested 2.000, issued to date 2.000',
      ),
      slip,
    );
    assert.ok(slip.includes('     Basis: Approved by department_head (dh) on 2026-09-24'), slip);
    assert.ok(
      slip.includes(
        '  2. EQ-DRILL qty 1 EA from R-B2-01 serials 1 | requested 3.000, issued to date 1.000',
      ),
      slip,
    );
    assert.ok(slip.includes('     Basis: Within self-approval limit'), slip);
    assert.ok(!slip.includes('No approval required'));
    assert.ok(!slip.includes('junior'));
  });

  it('omits the earlier-slips row on a first slip', () => {
    const slip = renderIssueSlip({
      issue_number_ext: 'ISS-2026-0001',
      site_id: 's',
      indent_number_ext: 'IND-2026-0001',
      requester_user_id: 'r',
      department_code: 'D',
      earlier_slips: [],
      issued_by: 'k',
      issued_at: '2026-10-21T00:00:00.000Z',
      lines: [],
    });
    assert.ok(!slip.includes('Earlier slips'));
  });

  it('computes the open quantity as NUMERIC(18,3) text', () => {
    assert.equal(openQtyOf({ requested_qty: '10.000', issued_qty: '4.000' }), '6.000');
    assert.equal(openQtyOf({ requested_qty: '10.000', issued_qty: '0.000' }), '10.000');
    assert.equal(openQtyOf({ requested_qty: '0.300', issued_qty: '0.1' }), '0.200');
    assert.equal(openQtyOf({ requested_qty: '100', issued_qty: '100.000' }), '0.000');
  });

  it('normalises the issue body with one rule for the route and the seam', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const loc = '22222222-2222-4222-8222-222222222222';
    assert.deepEqual(
      normaliseIssueLines([
        {
          indent_line_id: id,
          quantity: '1',
          location_id: loc,
          lot_id: 'L1',
          serials: [{ serial_number: 'S1' }],
          override_expired_lot: true,
          fefo_mode: 'fefo',
        },
      ]),
      [
        {
          indent_line_id: id,
          quantity: '1',
          location_id: loc,
          lot_id: 'L1',
          serials: [{ serial_number: 'S1' }],
          override_expired_lot: true,
          fefo_mode: 'fefo',
        },
      ],
    );
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (
          (err as { errorCode?: string; code?: string }).errorCode ??
          (err as { code?: string }).code ??
          String(err)
        );
      }
      return 'none';
    };
    assert.match(
      code(() => normaliseIssueLines([])),
      /INDENT_ISSUE_LINE_REQUIRED/,
    );
    assert.match(
      code(() => normaliseIssueLines(undefined)),
      /INDENT_ISSUE_LINE_REQUIRED/,
    );
    assert.match(
      code(() => normaliseIssueLines([{ indent_line_id: id, quantity: '0', location_id: loc }])),
      /INVALID_PARAMS/,
    );
    assert.match(
      code(() =>
        normaliseIssueLines([{ indent_line_id: id, quantity: '1.0001', location_id: loc }]),
      ),
      /INVALID_PARAMS/,
    );
    assert.match(
      code(() =>
        normaliseIssueLines([
          { indent_line_id: id, quantity: '1', location_id: loc },
          { indent_line_id: id, quantity: '1', location_id: loc },
        ]),
      ),
      /INVALID_PARAMS/,
    );
    assert.match(
      code(() => normaliseIssueLines([null])),
      /INVALID_PARAMS/,
    );
  });

  it('compares quantities as exact thousandths, never as floats', () => {
    assert.equal(qtyExceeds('6.001', '6.000'), true);
    assert.equal(qtyExceeds('6', '6.000'), false);
    assert.equal(qtyExceeds('0.001', '0'), true);
    assert.equal(qtyExceeds('999999999999.999', '999999999999.998'), true);
  });

  it('requires one distinct serial per unit and at most 50 lines', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const loc = '00000000-0000-4000-8000-000000000002';
    const reasons = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (err as { message?: string }).message ?? String(err);
      }
      return 'none';
    };
    const withSerials = (quantity: string, serials: string[]) => [
      {
        indent_line_id: id,
        quantity,
        location_id: loc,
        serials: serials.map((serial_number) => ({ serial_number })),
      },
    ];
    assert.equal(
      reasons(() => normaliseIssueLines(withSerials('2', ['A', 'B']))),
      'none',
    );
    assert.match(
      reasons(() => normaliseIssueLines(withSerials('2', ['A']))),
      /1 serial\(s\) but the quantity is 2/,
    );
    assert.match(
      reasons(() => normaliseIssueLines(withSerials('2', ['A', 'A']))),
      /must not repeat/,
    );
    assert.match(
      reasons(() => normaliseIssueLines(withSerials('1.5', ['A']))),
      /quantity is 1\.5/,
    );
    const many = Array.from({ length: 51 }, (_, i) => ({
      indent_line_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      quantity: '1',
      location_id: loc,
    }));
    assert.match(
      reasons(() => normaliseIssueLines(many)),
      /at most 50 lines/,
    );
  });

  it('prints the Table 2 approval basis for every route', () => {
    const row = (over: Partial<IndentLineRow>): IndentLineRow =>
      ({
        approval_route: 'doa',
        decided_by: 'priya',
        approver_actor_id: 'ravi',
        decided_at: '2026-09-25T04:48:00.000Z',
        ...over,
      }) as IndentLineRow;
    assert.equal(
      approvalBasisText(row({}), 'department_head'),
      'Approved by department_head (priya) on 2026-09-25',
    );
    assert.equal(
      approvalBasisText(row({ decided_by: null }), null),
      'Approved by approver (ravi) on 2026-09-25',
    );
    assert.equal(
      approvalBasisText(row({ decided_by: null, approver_actor_id: null }), null),
      'Approved by approver (unknown) on 2026-09-25',
    );
    assert.equal(
      approvalBasisText(row({ decided_at: null }), 'finance_controller'),
      'Approved by finance_controller (priya) on unknown date',
    );
    assert.equal(
      approvalBasisText(row({ decided_at: 'not-a-date' }), 'finance_controller'),
      'Approved by finance_controller (priya) on unknown date',
    );
    assert.equal(
      approvalBasisText(row({ approval_route: 'self_approval' }), null),
      'Within self-approval limit',
    );
    assert.match(
      approvalBasisText(row({ approval_route: 'standing_approval' }), null),
      /^Standing approval/,
    );
  });
});
