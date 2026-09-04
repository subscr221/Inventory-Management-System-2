import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LETTERS,
  CODE_LETTER_TABLE,
  INSPECTION_LEVELS,
  LOT_SIZE_BANDS,
  PREFERRED_AQLS,
  REDUCED_SAMPLE_SIZES,
  RESOLUTION_LETTERS,
  SAMPLE_SIZES,
  TABLE_II_A,
  TABLE_II_B,
  TABLE_II_C,
  canonicalAql,
  codeLetterFor,
  singleSamplingPlan,
  tighterAql,
} from '../../src/quality/aql-tables.js';
import type {
  CodeLetter,
  PlanCell,
  PreferredAql,
  ResolvedCodeLetter,
} from '../../src/quality/aql-tables.js';

/**
 * Story 8.2 Task 1: the sampling standard is data. These checks pin the transcription's shape and
 * the anchor cells of the story's Dev Notes Table 3; they never reach the database.
 */

const TABLES: Array<[string, Readonly<Record<ResolvedCodeLetter, readonly PlanCell[]>>]> = [
  ['II-A', TABLE_II_A],
  ['II-B', TABLE_II_B],
  ['II-C', TABLE_II_C],
];

function cell(
  table: Readonly<Record<ResolvedCodeLetter, readonly PlanCell[]>>,
  letter: ResolvedCodeLetter,
  aql: PreferredAql,
): PlanCell {
  return table[letter][PREFERRED_AQLS.indexOf(aql)]!;
}

describe('Story 8.2 AQL tables', () => {
  it('has 26 preferred AQLs, 16 code letters (no I or O) and 15 lot-size bands per level', () => {
    assert.strictEqual(PREFERRED_AQLS.length, 26);
    assert.strictEqual(CODE_LETTERS.length, 16);
    assert.ok(!(CODE_LETTERS as readonly string[]).includes('I'));
    assert.ok(!(CODE_LETTERS as readonly string[]).includes('O'));
    assert.strictEqual(LOT_SIZE_BANDS.length, 15);
    assert.strictEqual(INSPECTION_LEVELS.length, 7);
    for (const level of INSPECTION_LEVELS) {
      assert.strictEqual(CODE_LETTER_TABLE[level].length, 15, `${level} must have 15 bands`);
    }
    // Bands are contiguous from 2 upward.
    let next = 2;
    for (const band of LOT_SIZE_BANDS) {
      assert.strictEqual(band.min, next);
      next = band.max === null ? Number.NaN : band.max + 1;
    }
    assert.strictEqual(LOT_SIZE_BANDS[14]!.max, null);
  });

  it('every table has 17 rows by 26 AQLs and arrow chains terminate in a plan', () => {
    for (const [name, table] of TABLES) {
      // 16 Table I letters plus supplementary S, which is an arrow target and never a Table I
      // assignment (see codeLetterFor and isCodeLetter, neither of which knows S).
      assert.deepStrictEqual(Object.keys(table), [...RESOLUTION_LETTERS], `${name} letters`);
      for (const letter of RESOLUTION_LETTERS) {
        assert.strictEqual(table[letter].length, 26, `${name} ${letter} must have 26 cells`);
      }
      for (const aql of PREFERRED_AQLS) {
        // Table II-B at AQL 0.010 is the ONE column with no plan at any row: the tightened Ac 0
        // diagonal runs a letter lower than normal, so it needs the row below S, which the
        // standard's tables do not have. determineSampling refuses that combination.
        const noPlanAnywhere = name === 'II-B' && aql === '0.010';
        assert.strictEqual(
          RESOLUTION_LETTERS.some((letter) => typeof cell(table, letter, aql) !== 'string'),
          !noPlanAnywhere,
          `${name} column ${aql} plan-cell expectation`,
        );
        // Arrow cells only appear above (down) or below (up) the plan band, never inside it.
        let seenPlan = false;
        let seenUp = false;
        for (const letter of RESOLUTION_LETTERS) {
          const c = cell(table, letter, aql);
          if (c === 'down') {
            assert.ok(!seenPlan, `${name} ${letter}@${aql}: down arrow below a plan`);
          } else if (c === 'up') {
            seenUp = true;
            assert.ok(seenPlan, `${name} ${letter}@${aql}: up arrow above every plan`);
          } else {
            assert.ok(!seenUp, `${name} ${letter}@${aql}: plan below an up arrow`);
            seenPlan = true;
          }
        }
      }
    }
  });

  it('normal and tightened cells satisfy re === ac + 1; reduced cells satisfy re > ac', () => {
    for (const [name, table] of TABLES) {
      for (const letter of RESOLUTION_LETTERS) {
        for (const c of table[letter]) {
          if (typeof c === 'string') continue;
          assert.ok(Number.isSafeInteger(c.ac) && c.ac >= 0, `${name} ${letter} ac`);
          if (name === 'II-C') assert.ok(c.re > c.ac, `${name} ${letter} re > ac`);
          else assert.strictEqual(c.re, c.ac + 1, `${name} ${letter} re = ac + 1`);
        }
      }
    }
  });

  it('Ac is non-decreasing down every column and along every row', () => {
    for (const [name, table] of TABLES) {
      for (const aql of PREFERRED_AQLS) {
        let previous = -1;
        for (const letter of RESOLUTION_LETTERS) {
          const c = cell(table, letter, aql);
          if (typeof c === 'string') continue;
          assert.ok(c.ac >= previous, `${name} column ${aql} at ${letter}`);
          previous = c.ac;
        }
      }
      for (const letter of RESOLUTION_LETTERS) {
        let previous = -1;
        for (const c of table[letter]) {
          if (typeof c === 'string') continue;
          assert.ok(c.ac >= previous, `${name} row ${letter}`);
          previous = c.ac;
        }
      }
    }
  });

  it('reduced sample sizes never exceed normal ones and are strictly smaller from letter B', () => {
    for (const letter of RESOLUTION_LETTERS) {
      assert.ok(REDUCED_SAMPLE_SIZES[letter] <= SAMPLE_SIZES[letter], letter);
      if (letter !== 'A') assert.ok(REDUCED_SAMPLE_SIZES[letter] < SAMPLE_SIZES[letter], letter);
    }
    assert.strictEqual(SAMPLE_SIZES.A, 2);
    assert.strictEqual(SAMPLE_SIZES.R, 2000);
    assert.strictEqual(REDUCED_SAMPLE_SIZES.R, 800);
    assert.strictEqual(SAMPLE_SIZES.S, 3150);
    assert.strictEqual(REDUCED_SAMPLE_SIZES.S, 1250);
  });

  it('pins the Table 3 sampling anchors', () => {
    const anchors: Array<[string, CodeLetter, PreferredAql, number, number]> = [
      ['normal', 'L', '1.0', 5, 6],
      ['normal', 'L', '2.5', 10, 11],
      ['normal', 'L', '4.0', 14, 15],
      ['normal', 'L', '6.5', 21, 22],
      ['normal', 'K', '1.0', 3, 4],
      ['normal', 'J', '1.0', 2, 3],
      ['normal', 'J', '2.5', 5, 6],
      ['normal', 'H', '1.0', 1, 2],
      ['normal', 'G', '1.0', 0, 1],
      ['normal', 'C', '6.5', 0, 1],
      ['tightened', 'L', '1.0', 3, 4],
      ['tightened', 'K', '1.0', 2, 3],
      ['tightened', 'J', '1.0', 1, 2],
      ['tightened', 'H', '1.0', 0, 1],
    ];
    for (const [severity, letter, aql, ac, re] of anchors) {
      const table = severity === 'normal' ? TABLE_II_A : TABLE_II_B;
      assert.deepStrictEqual(cell(table, letter, aql), { ac, re }, `${severity} ${letter}@${aql}`);
    }
    assert.strictEqual(cell(TABLE_II_A, 'F', '1.0'), 'down');
    const arrow = singleSamplingPlan('F', '1.0', 'normal');
    assert.deepStrictEqual(arrow, {
      code_letter: 'F',
      resolved_letter: 'G',
      sample_size: 32,
      ac: 0,
      re: 1,
    });
    // Up arrow: R at AQL 1000 resolves upward to the last plan in the column with that row's size.
    const up = singleSamplingPlan('R', '1000', 'normal');
    assert.ok(
      up && up.resolved_letter !== 'R' && up.sample_size === SAMPLE_SIZES[up.resolved_letter],
    );
    // Reduced uses Table II-C sizes.
    assert.deepStrictEqual(singleSamplingPlan('H', '1.0', 'reduced'), {
      code_letter: 'H',
      resolved_letter: 'H',
      sample_size: 20,
      ac: 0,
      re: 2,
    });
  });

  it('Table I anchors for General Inspection Level II and the special levels', () => {
    assert.strictEqual(codeLetterFor(500, 'II'), 'H');
    assert.strictEqual(codeLetterFor(1000, 'II'), 'J');
    assert.strictEqual(codeLetterFor(5000, 'II'), 'L');
    assert.strictEqual(codeLetterFor(100, 'II'), 'F');
    assert.strictEqual(codeLetterFor(5, 'II'), 'A');
    assert.strictEqual(codeLetterFor(2, 'II'), 'A');
    assert.strictEqual(codeLetterFor(1, 'II'), null);
    assert.strictEqual(codeLetterFor(500001, 'II'), 'Q');
    assert.strictEqual(codeLetterFor(500001, 'III'), 'R');
    assert.strictEqual(codeLetterFor(500001, 'I'), 'N');
    assert.strictEqual(codeLetterFor(500001, 'S-1'), 'D');
    assert.strictEqual(codeLetterFor(500001, 'S-4'), 'K');
    assert.strictEqual(codeLetterFor(281, 'S-3'), 'D');
  });

  it('canonicalAql normalizes NUMERIC(7,3) strings to preferred keys without Number', () => {
    assert.strictEqual(canonicalAql('1.000'), '1.0');
    assert.strictEqual(canonicalAql('1'), '1.0');
    assert.strictEqual(canonicalAql('1.0'), '1.0');
    assert.strictEqual(canonicalAql('01.00'), '1.0');
    assert.strictEqual(canonicalAql('0.010'), '0.010');
    assert.strictEqual(canonicalAql('0.01'), '0.010');
    assert.strictEqual(canonicalAql('2.500'), '2.5');
    assert.strictEqual(canonicalAql('1000.000'), '1000');
    assert.strictEqual(canonicalAql('1.200'), null);
    assert.strictEqual(canonicalAql('0.012'), null);
    assert.strictEqual(canonicalAql('abc'), null);
    assert.strictEqual(canonicalAql(''), null);
    assert.strictEqual(canonicalAql('-1.0'), null);
    assert.strictEqual(tighterAql('1.0'), '0.65');
    assert.strictEqual(tighterAql('0.010'), null);
  });

  /**
   * Deferred-work ledger ref 534. Supplementary code letter S carries the Ac 0 diagonal one column
   * further left than the 16 Table I letters reach. Before this row existed, those cells were
   * recorded at R's sample size, which is a smaller sample at the same acceptance number than the
   * standard requires: it accepted lots the standard rejects, on plans certified against
   * STANDARD_REF. The whole 0.010 and 0.015 columns are one unbroken down-arrow chain, so every
   * lot size resolved into them, not only the lots large enough to reach letter R directly.
   */
  it('resolves the tightest AQL columns into supplementary letter S at its own sample size', () => {
    // Normal: R at 0.015 is ON the diagonal at n = 2000; 0.010 is one column further, at S.
    assert.deepStrictEqual(singleSamplingPlan('R', '0.015', 'normal'), {
      code_letter: 'R',
      resolved_letter: 'R',
      sample_size: 2000,
      ac: 0,
      re: 1,
    });
    assert.deepStrictEqual(singleSamplingPlan('R', '0.010', 'normal'), {
      code_letter: 'R',
      resolved_letter: 'S',
      sample_size: 3150,
      ac: 0,
      re: 1,
    });
    // Reduced keeps its own sample-size column: S is 1250, as R is 800.
    assert.deepStrictEqual(singleSamplingPlan('R', '0.010', 'reduced'), {
      code_letter: 'R',
      resolved_letter: 'S',
      sample_size: 1250,
      ac: 0,
      re: 1,
    });
    // Tightened runs one letter lower throughout: 0.025 is R's own cell, 0.015 resolves to S, and
    // 0.010 would need the row below S, which the standard's tables do not have.
    assert.deepStrictEqual(singleSamplingPlan('R', '0.025', 'tightened'), {
      code_letter: 'R',
      resolved_letter: 'R',
      sample_size: 2000,
      ac: 0,
      re: 1,
    });
    assert.deepStrictEqual(singleSamplingPlan('R', '0.015', 'tightened'), {
      code_letter: 'R',
      resolved_letter: 'S',
      sample_size: 3150,
      ac: 0,
      re: 1,
    });
    assert.strictEqual(singleSamplingPlan('R', '0.010', 'tightened'), null);
    // The chain is unbroken from the top of the table, so a small lot reaches S too - which is why
    // the defect was never confined to half-million-unit lots.
    assert.deepStrictEqual(singleSamplingPlan('A', '0.010', 'normal'), {
      code_letter: 'A',
      resolved_letter: 'S',
      sample_size: 3150,
      ac: 0,
      re: 1,
    });
    // S is an arrow target only: Table I never assigns it at any lot size or level.
    assert.strictEqual(codeLetterFor(Number.MAX_SAFE_INTEGER, 'III'), 'R');
    for (const level of INSPECTION_LEVELS) {
      assert.ok(
        !(CODE_LETTER_TABLE[level] as readonly string[]).includes('S'),
        `${level} must not assign S`,
      );
    }
  });
});
