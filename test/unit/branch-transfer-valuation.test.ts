import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';
import { computeRule28Value, isPositiveDecimal } from '../../src/compliance/transfer-request.js';
import { AppError } from '../../src/middleware/error.js';
import { SUPPORTED_EVENT_TYPES } from '../../src/events/schema.js';

/**
 * Story 11.5: the pure Rule 28 arithmetic (Task 3.3), the e-way bill threshold knob (Task 2.4)
 * and the event-type registry (Task 4.1 / 5.2). The arithmetic is scaled-integer, half-up, rounded
 * ONCE at the end: every expectation here is a hand-computed string, never the function's own
 * output fed back to itself (the Story 8.4 tautological-test lesson).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function loadConfigWith(env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      '--env-file=.env.test',
      '--import',
      'tsx',
      '-e',
      "import('./src/config/index.ts').then((m) => console.log('RESOLVED=' + m.config.gst.ewayBillTaxableValueThresholdInr));",
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    },
  );
  return { status: result.status, output: `${result.stderr}${result.stdout}` };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.errorCode;
    throw err;
  }
  return 'NO_THROW';
}

/** Returns the thrown AppError itself, so an arm can pin its status and message, not just its code. */
function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected a refusal, the call returned normally');
}

describe('Story 11.5 Rule 28 valuation arithmetic', () => {
  it('cost_plus is running-average cost times the percentage, at 6 dp, and taxable value at 2 dp', () => {
    assert.deepEqual(
      computeRule28Value({
        basis: 'cost_plus',
        quantity: 600,
        declaredUnitValue: null,
        runningAverageCost: '100.000000',
        costPlusPercent: '110.000',
      }),
      { unit_value: '110.000000', taxable_value: '66000.00' },
    );
  });

  it('rounds half-up once at the end: 33.333333 * 110% = 36.666666 (6 dp), * 7 = 256.67', () => {
    assert.deepEqual(
      computeRule28Value({
        basis: 'cost_plus',
        quantity: '7',
        declaredUnitValue: null,
        runningAverageCost: '33.333333',
        costPlusPercent: '110.000',
      }),
      { unit_value: '36.666666', taxable_value: '256.67' },
    );
    // A .005 boundary rounds UP (half-up), not to even: 0.125 * 3 = 0.375 -> 0.38.
    assert.equal(
      computeRule28Value({
        basis: 'open_market_value',
        quantity: 3,
        declaredUnitValue: '0.125',
        runningAverageCost: null,
        costPlusPercent: null,
      }).taxable_value,
      '0.38',
    );
  });

  it('the three declared-value bases take the declared value verbatim and refuse its absence', () => {
    for (const basis of [
      'open_market_value',
      'like_kind_quality',
      'invoice_value_full_itc',
    ] as const) {
      assert.deepEqual(
        computeRule28Value({
          basis,
          quantity: 10,
          declaredUnitValue: '12.5',
          runningAverageCost: '999',
          costPlusPercent: '150',
        }),
        { unit_value: '12.500000', taxable_value: '125.00' },
      );
      assert.equal(
        codeOf(() =>
          computeRule28Value({
            basis,
            quantity: 10,
            declaredUnitValue: null,
            runningAverageCost: '999',
            costPlusPercent: '150',
          }),
        ),
        'DECLARED_VALUE_REQUIRED',
      );
    }
  });

  it('cost_plus with no cost, a zero cost or a null valuation row is VALUATION_COST_UNAVAILABLE', () => {
    for (const cost of [null, '0', '0.000000']) {
      assert.equal(
        codeOf(() =>
          computeRule28Value({
            basis: 'cost_plus',
            quantity: 1,
            declaredUnitValue: '5',
            runningAverageCost: cost,
            costPlusPercent: '110',
          }),
        ),
        'VALUATION_COST_UNAVAILABLE',
      );
    }
  });

  // Code review P2 (chunk 3, T16). toScaled's STRING path used to TRUNCATE at the column scale
  // while the NUMBER path rounded through toFixed, so "12.3456789" and 12.3456789 scaled to
  // DIFFERENT unit values and a sub-scale string truncated silently to zero. The patch made the
  // string path round half-up on the first dropped (7th) digit. Every string input elsewhere in the
  // suite carries 6 or fewer decimals, so nothing else reaches this branch. Expectations below are
  // hand-computed: keep 6 decimals, then add one if the 7th digit is >= 5.
  it('toScaled rounds a 7-decimal STRING half-up, and agrees with the same value as a number', () => {
    const declared = (value: string | number, quantity: string | number) =>
      computeRule28Value({
        basis: 'open_market_value',
        quantity,
        declaredUnitValue: value,
        runningAverageCost: null,
        costPlusPercent: null,
      });

    // (a) 7th digit 9 -> rounds UP: 12.3456789 -> 12.345679. Taxable at qty 1: 12.35.
    assert.deepEqual(declared('12.3456789', 1), {
      unit_value: '12.345679',
      taxable_value: '12.35',
    });
    // (b) 7th digit 1 -> rounds DOWN: 12.3456781 -> 12.345678 (truncation would agree here; the
    // point is that (a) and (b) diverge, which truncation could never produce).
    assert.deepEqual(declared('12.3456781', 1), {
      unit_value: '12.345678',
      taxable_value: '12.35',
    });
    // (c) exactly on the half at the 7th digit -> half-UP, not half-even: 12.3456785 -> 12.345679.
    assert.deepEqual(declared('12.3456785', 1), {
      unit_value: '12.345679',
      taxable_value: '12.35',
    });
    // (d) THE defect the patch fixed: the same economic value as a JSON number and as a decimal
    // string must scale identically. 1.2345678 -> 1.234568 either way; * 2 = 2.469136 -> 2.47.
    const asNumber = declared(1.2345678, 2);
    const asString = declared('1.2345678', 2);
    assert.deepEqual(asNumber, { unit_value: '1.234568', taxable_value: '2.47' });
    assert.deepEqual(
      asString,
      asNumber,
      'a declared unit value must scale identically whether the JSON carried a number or a string',
    );
    // The pre-patch truncating string path would have produced this instead; it must not come back.
    assert.notStrictEqual(asString.unit_value, '1.234567');
  });

  // Code review P3/P4/P5 (chunk 3, T17). The magnitude bounds and the rounds-to-zero refusal have
  // no other coverage anywhere: no fixture reaches 1e12. Each of these was an uncaught 500 (a
  // BigInt SyntaxError on exponential notation, or a raw Postgres 22003 out-of-range) before the
  // patch, so the arms assert the TYPED refusal, not merely that something is thrown.
  it('refuses magnitudes the NUMERIC columns cannot hold, and values that round away to zero', () => {
    const declared = (value: string | number, quantity: string | number) => () =>
      computeRule28Value({
        basis: 'open_market_value',
        quantity,
        declaredUnitValue: value,
        runningAverageCost: null,
        costPlusPercent: null,
      });

    // A JSON number at or above 1e21: (1e21).toFixed(6) returns "1e+21", and BigInt("1e+21...")
    // throws a bare SyntaxError. The pre-toScaled guard turns it into a 400 refusal.
    const huge = errorOf(declared(1e21, 1));
    assert.strictEqual(huge.statusCode, 400);
    assert.strictEqual(huge.errorCode, 'INVALID_PARAMS');
    assert.match(huge.message, /declared_unit_value exceeds the maximum storable unit value/);

    // A 13-integer-digit decimal STRING: exact digit counting, no float involved.
    const thirteen = errorOf(declared('1234567890123.500000', 1));
    assert.strictEqual(thirteen.statusCode, 400);
    assert.strictEqual(thirteen.errorCode, 'INVALID_PARAMS');
    assert.match(thirteen.message, /declared_unit_value exceeds the maximum storable unit value/);

    // A storable unit value (12 digits) whose product with the quantity overflows NUMERIC(18,2):
    // 999999999999 * 100000 = 9.99999999999e16, above the 1e16 taxable ceiling.
    const overflowTaxable = errorOf(declared('999999999999', 100000));
    assert.strictEqual(overflowTaxable.statusCode, 400);
    assert.strictEqual(overflowTaxable.errorCode, 'INVALID_PARAMS');
    assert.match(
      overflowTaxable.message,
      /computed taxable value exceeds the maximum storable taxable value/,
    );

    // The cost_plus path reaches the NUMERIC(18,6) unit ceiling from the other side: a storable
    // cost times a percentage. 999999999999 * 200% = 1999999999998, 13 integer digits.
    const overflowUnit = errorOf(() =>
      computeRule28Value({
        basis: 'cost_plus',
        quantity: 1,
        declaredUnitValue: null,
        runningAverageCost: '999999999999',
        costPlusPercent: '200.000',
      }),
    );
    assert.strictEqual(overflowUnit.statusCode, 400);
    assert.strictEqual(overflowUnit.errorCode, 'INVALID_PARAMS');
    assert.match(
      overflowUnit.message,
      /computed unit value exceeds the maximum storable unit value/,
    );

    // Sub-scale: 0.0000004 is positive, so isPositiveDecimal admits it, but it rounds to zero at
    // 6 dp. It must be a typed refusal, never a silently stored zero (the DB now bars unit_value 0).
    const subScale = errorOf(declared('0.0000004', 1));
    assert.strictEqual(subScale.statusCode, 400);
    assert.strictEqual(subScale.errorCode, 'INVALID_PARAMS');
    assert.match(subScale.message, /computed unit value rounds to zero at six decimal places/);

    // The taxable half of the same refusal: a storable unit value against a sub-scale quantity.
    // 0.000001 * 0.001 = 1e-9, which rounds to 0.00 at 2 dp.
    const subScaleTaxable = errorOf(declared('0.000001', '0.001'));
    assert.strictEqual(subScaleTaxable.statusCode, 400);
    assert.strictEqual(subScaleTaxable.errorCode, 'INVALID_PARAMS');
    assert.match(
      subScaleTaxable.message,
      /computed taxable value rounds to zero at two decimal places/,
    );
  });

  it('isPositiveDecimal accepts positive numbers and plain decimal strings only', () => {
    assert.equal(isPositiveDecimal(12.5), true);
    assert.equal(isPositiveDecimal('12.5'), true);
    assert.equal(isPositiveDecimal('0'), false);
    assert.equal(isPositiveDecimal('-1'), false);
    assert.equal(isPositiveDecimal('1e3'), false);
    assert.equal(isPositiveDecimal(''), false);
    assert.equal(isPositiveDecimal(Number.NaN), false);
  });
});

describe('Story 11.5 e-way bill threshold knob', () => {
  // The statutory Rs 50,000 e-way-bill threshold is a CONSIGNMENT value (tax included), but this
  // platform only ever holds the TAXABLE value and no tax rate to gross it up with. 50,000 / 1.18
  // (worst-case 18 percent IGST) = 42,373, so any taxable value that could reach a Rs 50,000
  // consignment value trips the gate. Over-triggering at a lower tax rate is harmless;
  // under-triggering is a penalty and a detained truck. Do NOT "correct" this back to 50,000.
  it('defaults to Rs 42,373 (Rs 50,000 consignment value grossed down at 18 percent) when the variable is absent', () => {
    assert.strictEqual(config.gst.ewayBillTaxableValueThresholdInr, 42_373);
  });

  it('a present-but-blank GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR fails closed at boot; a set value is honoured', () => {
    const blank = loadConfigWith({ GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR: '' });
    assert.notStrictEqual(blank.status, 0, blank.output);
    assert.match(blank.output, /GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR/);
    const set = loadConfigWith({ GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR: '100000' });
    assert.strictEqual(set.status, 0, set.output);
    assert.match(set.output, /RESOLVED=100000/);
    const bad = loadConfigWith({ GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR: 'fifty' });
    assert.notStrictEqual(bad.status, 0, bad.output);
  });
});

describe('Story 11.5 event-type registry', () => {
  it('registers the override and the document recording on the inventory stream beside their siblings', () => {
    assert.deepStrictEqual(SUPPORTED_EVENT_TYPES['transfer_request.valuation_overridden'], {
      streamType: 'inventory',
      requiresBusinessStream: true,
    });
    // Pinned against the LITERAL registration, not against transfer_ship.created: comparing one
    // registry entry to another asserts no content and silently follows whatever the sibling
    // drifts to (chunk-3 review T6). The sibling equality is kept only as a secondary statement
    // that the two still agree.
    assert.deepStrictEqual(SUPPORTED_EVENT_TYPES['transfer_request.gst_document_recorded'], {
      streamType: 'inventory',
      requiresBusinessStream: true,
    });
    assert.deepStrictEqual(SUPPORTED_EVENT_TYPES['transfer_ship.created'], {
      streamType: 'inventory',
      requiresBusinessStream: true,
    });
  });
});
