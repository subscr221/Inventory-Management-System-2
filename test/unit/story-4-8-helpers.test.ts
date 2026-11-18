import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountLte, milliToText, numberToQtyText, toMilli } from '../../src/lib/milli.js';
import { standingApprovalText } from '../../src/read/projections/standing_grant.js';
import { approvalBasisText } from '../../src/compliance/indent-issue.js';
import type { IndentLineRow } from '../../src/read/projections/indent.js';

// Story 4.8: the pure helpers behind the cap arithmetic, the self-approval comparison and the
// words printed on the issue screen and slip.

describe('Story 4.8 helpers', () => {
  it('sums and compares quantities as exact thousandths', () => {
    assert.equal(toMilli('6'), 6000n);
    assert.equal(toMilli('0.001'), 1n);
    assert.equal(toMilli('2.5'), 2500n);
    assert.equal(toMilli('4.000') + toMilli(numberToQtyText(2)), toMilli('6.000'));
    assert.equal(milliToText(6000n), '6.000');
    assert.equal(milliToText(1n), '0.001');
    assert.equal(numberToQtyText(0.1 + 0.2), '0.300');
  });

  it('compares rupee amounts exactly to four decimals', () => {
    assert.equal(amountLte('500.0000', '500'), true);
    assert.equal(amountLte('500.0001', '500'), false);
    assert.equal(amountLte('501', '500'), false);
    assert.equal(amountLte('0', '0.0001'), true);
    assert.equal(amountLte('99999999999999.9999', '99999999999999.9999'), true);
  });

  it('prints the D9 sentence exactly and never the forbidden phrases', () => {
    const text = standingApprovalText('SA-2026-014', 'Ramu', 'Cleaning gear');
    assert.equal(
      text,
      'Standing approval SA-2026-014 for Ramu (Cleaning gear). Storekeeper please issue.',
    );
    assert.ok(!/No approval required|junior/i.test(text));
  });

  it('uses the grant sentence as the slip basis for a standing_approval line', () => {
    const line = { approval_route: 'standing_approval' } as IndentLineRow;
    const text = standingApprovalText('SA-2026-014', 'Ramu', 'Cleaning gear');
    assert.equal(approvalBasisText(line, null, text), text);
    assert.match(approvalBasisText(line, null), /^Standing approval/);
  });
});
