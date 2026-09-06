import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  creditNoteDeltaValue,
  hasBillableValue,
  offcutDisposalOpen,
  raisesCreditNote,
} from '../../src/compliance/jobwork-offcut-disposal.js';

/**
 * Story 9.7 Task 9.5: the disposal predicate, the delta arithmetic and the zero-rate branch, in
 * isolation. Every arm below FAILS the predicate for a distinct reason - the 8.4 lesson that a
 * predicate only ever asserted green proves nothing about the gate it is supposed to be.
 *
 * Code review 2026-09-06: the predicate now carries the holding row's own location_id (P10) - the
 * stock physically sits in that bin and no offcut re-location path exists, so a supplied location
 * must match it, and `acquired` no longer needs a caller location at all (the event contract
 * documents location_id as `returned`-only).
 */

const HOLDING_LOCATION = '00000000-0000-0000-0000-000000000001';
const OTHER_LOCATION = '00000000-0000-0000-0000-000000000002';
const RETAINED = { status: 'retained' as const, location_id: HOLDING_LOCATION };
const DISPOSED = { status: 'disposed' as const, location_id: HOLDING_LOCATION };

describe('Story 9.7 offcutDisposalOpen', () => {
  it('opens a retained row for a fully-specified acquisition', () => {
    const gate = offcutDisposalOpen(RETAINED, {
      disposition: 'acquired',
      rate: '18.5000',
      currency: 'INR',
      location_id: '00000000-0000-0000-0000-000000000001',
    });
    assert.deepStrictEqual(gate, { open: true });
  });

  it('opens a retained row for a fully-specified return', () => {
    const gate = offcutDisposalOpen(RETAINED, {
      disposition: 'returned',
      return_challan_number_ext: 'RCH-1',
      location_id: '00000000-0000-0000-0000-000000000001',
    });
    assert.deepStrictEqual(gate, { open: true });
  });

  it('refuses a row that has already been disposed of (open question 4: no second disposal)', () => {
    const gate = offcutDisposalOpen(DISPOSED, {
      disposition: 'acquired',
      rate: '1.0000',
      currency: 'INR',
      location_id: '00000000-0000-0000-0000-000000000001',
    });
    assert.deepStrictEqual(gate, { open: false, reason: 'already_disposed' });
  });

  it('BSD-5: a rate of exactly zero is a free retention and must NOT be read as absent', () => {
    // The whole point of this arm: `!input.rate` would refuse "0" and make a contractual free
    // retention unpostable, which is the one branch with no credit note to fall back on.
    const gate = offcutDisposalOpen(RETAINED, {
      disposition: 'acquired',
      rate: '0',
      currency: 'INR',
      location_id: '00000000-0000-0000-0000-000000000001',
    });
    assert.deepStrictEqual(gate, { open: true });
  });

  it('refuses an acquisition with no rate and, separately, with no currency', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        currency: 'INR',
        location_id: '00000000-0000-0000-0000-000000000001',
      }),
      { open: false, reason: 'rate_required' },
    );
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        rate: '5.0000',
        location_id: '00000000-0000-0000-0000-000000000001',
      }),
      { open: false, reason: 'currency_required' },
    );
  });

  it('refuses a return that carries a price, and an acquisition that carries a challan', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'returned',
        rate: '5.0000',
        return_challan_number_ext: 'RCH-1',
        location_id: '00000000-0000-0000-0000-000000000001',
      }),
      { open: false, reason: 'rate_refused' },
    );
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        rate: '5.0000',
        currency: 'INR',
        return_challan_number_ext: 'RCH-1',
        location_id: '00000000-0000-0000-0000-000000000001',
      }),
      { open: false, reason: 'challan_refused' },
    );
  });

  it('refuses a return with no challan number and, separately, a return with no location', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'returned',
        location_id: HOLDING_LOCATION,
      }),
      { open: false, reason: 'challan_required' },
    );
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'returned',
        return_challan_number_ext: 'RCH-1',
      }),
      { open: false, reason: 'location_required' },
    );
  });

  it('D10 (chunk D code review 2026-09-06): a returned disposal carrying a currency (and no rate) is refused currency_refused, not silently priced', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, { disposition: 'returned', currency: 'INR' }),
      { open: false, reason: 'currency_refused' },
    );
  });

  it('P10 (code review 2026-09-06): an acquisition needs NO caller location, but a supplied one must match the holding bin', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        rate: '5.0000',
        currency: 'INR',
      }),
      { open: true },
    );
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        rate: '5.0000',
        currency: 'INR',
        location_id: HOLDING_LOCATION,
      }),
      { open: true },
    );
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'acquired',
        rate: '5.0000',
        currency: 'INR',
        location_id: OTHER_LOCATION,
      }),
      { open: false, reason: 'location_mismatch' },
    );
  });

  it('P10 (code review 2026-09-06): a returned disposal naming a bin other than the holding bin is refused early', () => {
    assert.deepStrictEqual(
      offcutDisposalOpen(RETAINED, {
        disposition: 'returned',
        return_challan_number_ext: 'RCH-1',
        location_id: OTHER_LOCATION,
      }),
      { open: false, reason: 'location_mismatch' },
    );
  });
});

describe('Story 9.7 credit-note arithmetic', () => {
  it('AC 5: a delta is the SIGNED difference against the document it supersedes', () => {
    assert.strictEqual(creditNoteDeltaValue('1000.0000', '1250.5000'), '250.5000');
    assert.strictEqual(creditNoteDeltaValue('1000.0000', '750.0000'), '-250.0000');
    assert.strictEqual(creditNoteDeltaValue('1000.0000', '1000.0000'), '0.0000');
  });

  it('AC 5: a second revaluation chains off the LATEST value, not the original', () => {
    const original = '1000.0000';
    const firstDelta = creditNoteDeltaValue(original, '1200.0000');
    const secondDelta = creditNoteDeltaValue('1200.0000', '900.0000');
    assert.strictEqual(firstDelta, '200.0000');
    assert.strictEqual(secondDelta, '-300.0000');
    // The running total of the document trail equals the current commercial value on the row.
    assert.strictEqual(creditNoteDeltaValue(original, '900.0000'), '-100.0000');
  });

  it('BSD-5: only a positive-rate acquisition raises a credit note', () => {
    assert.strictEqual(raisesCreditNote('acquired', '18.5000'), true);
    assert.strictEqual(raisesCreditNote('acquired', '0'), false);
    assert.strictEqual(raisesCreditNote('acquired', '0.0000'), false);
    assert.strictEqual(raisesCreditNote('returned', '18.5000'), false);
  });

  it('P9 (code review 2026-09-06): the credit note is raised only when the COMPUTED value is non-zero', () => {
    assert.strictEqual(hasBillableValue('0.0000'), false);
    assert.strictEqual(hasBillableValue('0'), false);
    assert.strictEqual(hasBillableValue('18.5000'), true);
    assert.strictEqual(hasBillableValue('0.0001'), true);
    assert.strictEqual(hasBillableValue(null), false);
  });
});
