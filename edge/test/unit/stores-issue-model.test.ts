import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildIssueBody,
  emptyForm,
  isIssuableIndentRow,
  isIssuableLineRow,
  openApprovedLines,
  type IssuableLineRow,
} from '../../src/components/stores-issue-model';

function line(overrides: Partial<IssuableLineRow> = {}): IssuableLineRow {
  return {
    indent_line_id: '00000000-0000-4000-8000-000000000001',
    line_no: 1,
    sku: 'CON-GLOVES',
    uom: 'EA',
    requested_qty: '10.000',
    issued_qty: '4.000',
    open_qty: '6.000',
    line_status: 'approved',
    issue_state: 'open',
    approval_route: 'doa',
    ...overrides,
  };
}

describe('Story 4.11 stores issue model', () => {
  it('accepts only well-formed rows from the API', () => {
    assert.equal(isIssuableLineRow(line()), true);
    assert.equal(isIssuableLineRow({ ...line(), open_qty: 6 }), false);
    assert.equal(
      isIssuableIndentRow({
        indent_id: 'x',
        indent_number_ext: 'IND-2026-0001',
        status: 'approved',
        requester_user_id: 'u',
        department_code: 'MAINT',
        created_at: '2026-10-21T00:00:00.000Z',
      }),
      true,
    );
    assert.equal(isIssuableIndentRow({ indent_id: 'x' }), false);
  });

  it('offers only approved open lines (Table 3)', () => {
    const rows = [
      line(),
      line({ indent_line_id: 'b', line_status: 'pending' }),
      line({ indent_line_id: 'c', line_status: 'rejected' }),
      line({ indent_line_id: 'd', issue_state: 'issued' }),
      line({ indent_line_id: 'e', issue_state: 'closed' }),
    ];
    assert.deepEqual(
      openApprovedLines(rows).map((l) => l.indent_line_id),
      ['00000000-0000-4000-8000-000000000001'],
    );
  });

  it('builds the request from the typed forms and leaves blank lines off the slip', () => {
    const rows = [line(), line({ indent_line_id: 'b', line_no: 2, open_qty: '3.000' })];
    const forms = rows.map(emptyForm);
    forms[0] = {
      ...forms[0]!,
      quantity: '2',
      location_code: ' BIN-A01 ',
      lot_id: 'LOT-1',
      serials: 'S1, S2',
    };
    const built = buildIssueBody(rows, forms);
    assert.deepEqual(built, {
      ok: true,
      lines: [
        {
          indent_line_id: '00000000-0000-4000-8000-000000000001',
          quantity: '2',
          location_code: 'BIN-A01',
          lot_id: 'LOT-1',
          serials: [{ serial_number: 'S1' }, { serial_number: 'S2' }],
        },
      ],
    });
  });

  it('refuses nothing typed, a bad quantity, more than open, and a missing bin', () => {
    const rows = [line()];
    const blank = rows.map(emptyForm);
    assert.deepEqual(buildIssueBody(rows, blank), { ok: false, reason: 'no_lines' });
    assert.deepEqual(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: 'abc', location_code: 'B' }]),
      {
        ok: false,
        reason: 'bad_quantity',
        line_no: 1,
      },
    );
    assert.deepEqual(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: '6.001', location_code: 'B' }]),
      {
        ok: false,
        reason: 'over_open',
        line_no: 1,
      },
    );
    assert.deepEqual(buildIssueBody(rows, [{ ...blank[0]!, quantity: '6' }]), {
      ok: false,
      reason: 'no_bin',
      line_no: 1,
    });
    // Exact decimal compare: 6.000 fits an open 6.000, a non-numeric open quantity never passes.
    assert.equal(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: '6.000', location_code: 'B' }]).ok,
      true,
    );
    assert.deepEqual(
      buildIssueBody(
        [line({ open_qty: 'x' })],
        [{ ...blank[0]!, quantity: '1', location_code: 'B' }],
      ),
      { ok: false, reason: 'over_open', line_no: 1 },
    );
    assert.deepEqual(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: '1e21', location_code: 'B' }]),
      { ok: false, reason: 'bad_quantity', line_no: 1 },
    );
    // One distinct serial per unit.
    assert.deepEqual(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: '2', location_code: 'B', serials: 'A, A' }]),
      { ok: false, reason: 'bad_serials', line_no: 1 },
    );
    assert.deepEqual(
      buildIssueBody(rows, [{ ...blank[0]!, quantity: '3', location_code: 'B', serials: 'A B' }]),
      { ok: false, reason: 'bad_serials', line_no: 1 },
    );
    const serialOk = buildIssueBody(rows, [
      { ...blank[0]!, quantity: '2', location_code: 'B', serials: 'A B' },
    ]);
    assert.equal(serialOk.ok, true);
    const override = buildIssueBody(rows, [
      { ...blank[0]!, quantity: '6', location_code: 'B', override_expired_lot: true },
    ]);
    assert.equal(override.ok && override.lines[0]!.override_expired_lot, true);
  });
});
