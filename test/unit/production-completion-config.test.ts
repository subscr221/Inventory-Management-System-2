import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';

/**
 * Story 6.3 (FR-MO-08, FR-MO-09; Binding Decisions 6 and 10). The completion tolerance and the two
 * reason-code catalogues are BOOT-TIME configuration: there is no admin API for them, so the only
 * fail-closed moment is startup.
 *
 * The guards are proved by loading src/config/index.ts in a CHILD process with the offending
 * environment - an in-process import would be served from the module cache with the ambient
 * .env.test values. Every accepting child run prints the RESOLVED value and the assertions compare
 * it with a LITERAL expectation, never with the config object itself: an assertion of the form
 * `config.x === config.x` proves nothing, which is exactly how seven HIGH defects shipped green in
 * Story 8.4.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

interface ChildResult {
  status: number | null;
  output: string;
}

function loadConfigWith(env: Record<string, string>, expression: string): ChildResult {
  const result = spawnSync(
    process.execPath,
    [
      '--env-file=.env.test',
      '--import',
      'tsx',
      '-e',
      `import('./src/config/index.ts').then((m) => console.log('RESOLVED=' + ${expression}));`,
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

describe('Story 6.3 completion configuration (FR-MO-08, FR-MO-09)', () => {
  it('the ambient defaults are the documented literals', () => {
    assert.strictEqual(config.production.completionTolerancePercent, '5');
    assert.deepStrictEqual(config.production.scrapReasonCodes, [
      'PROCESS_LOSS',
      'SETUP_REJECT',
      'MACHINE_FAULT',
      'OPERATOR_ERROR',
      'MATERIAL_DEFECT',
    ]);
    assert.deepStrictEqual(config.production.shortCloseReasonCodes, [
      'YIELD_SHORTFALL',
      'MATERIAL_EXHAUSTED',
      'ORDER_CURTAILED',
      'QUALITY_LOSS',
    ]);
    // The tolerance is a STRING so the bounds settle in SQL NUMERIC, never through a JS float.
    assert.strictEqual(typeof config.production.completionTolerancePercent, 'string');
  });

  it('an explicit tolerance is taken verbatim, decimals included', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '2.5' },
      'm.config.production.completionTolerancePercent',
    );
    assert.strictEqual(run.status, 0, run.output);
    assert.match(run.output, /^RESOLVED=2\.5$/m, run.output);
  });

  it('a zero tolerance is legal: it means no over-completion and no short window at all', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '0' },
      'm.config.production.completionTolerancePercent',
    );
    assert.strictEqual(run.status, 0, run.output);
    assert.match(run.output, /^RESOLVED=0$/m, run.output);
  });

  it('a present-but-blank tolerance fails closed rather than silently taking the default', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '' },
      'm.config.production.completionTolerancePercent',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_COMPLETION_TOLERANCE_PERCENT/);
  });

  it('a tolerance of exactly 100 refuses to boot: the short floor would be zero and AC6 unreachable', () => {
    // Code review 2026-08-31: the bound used to be "above 100", but at exactly 100 the floor is 0
    // and no non-negative cumulative quantity is ever below it, so every close-short returned
    // SHORT_CLOSE_NOT_APPLICABLE forever - AC6 disabled just as thoroughly as by a negative floor.
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '100' },
      'm.config.production.completionTolerancePercent',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_COMPLETION_TOLERANCE_PERCENT/);
  });

  it('a duplicate close-short reason code fails closed', () => {
    const run = loadConfigWith(
      { PRODUCTION_SHORT_CLOSE_REASON_CODES: 'YIELD_SHORTFALL,YIELD_SHORTFALL' },
      'm.config.production.shortCloseReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SHORT_CLOSE_REASON_CODES/);
  });

  it('an over-long close-short reason code fails closed', () => {
    const run = loadConfigWith(
      { PRODUCTION_SHORT_CLOSE_REASON_CODES: `OK,${'X'.repeat(201)}` },
      'm.config.production.shortCloseReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SHORT_CLOSE_REASON_CODES/);
  });

  it('a tolerance above 100 refuses to boot: it would make the short floor negative', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '150' },
      'm.config.production.completionTolerancePercent',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_COMPLETION_TOLERANCE_PERCENT/);
  });

  it('a negative tolerance refuses to boot: it would invert both bounds', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: '-5' },
      'm.config.production.completionTolerancePercent',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_COMPLETION_TOLERANCE_PERCENT/);
  });

  it('a non-numeric tolerance refuses to boot', () => {
    const run = loadConfigWith(
      { PRODUCTION_COMPLETION_TOLERANCE_PERCENT: 'five' },
      'm.config.production.completionTolerancePercent',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_COMPLETION_TOLERANCE_PERCENT/);
  });

  it('an explicit scrap reason list replaces the defaults entirely', () => {
    const run = loadConfigWith(
      { PRODUCTION_SCRAP_REASON_CODES: 'BURN_OFF, TRIM_LOSS' },
      "m.config.production.scrapReasonCodes.join('|')",
    );
    assert.strictEqual(run.status, 0, run.output);
    assert.match(run.output, /^RESOLVED=BURN_OFF\|TRIM_LOSS$/m, run.output);
  });

  it('a present-but-blank scrap reason list fails closed', () => {
    const run = loadConfigWith(
      { PRODUCTION_SCRAP_REASON_CODES: '' },
      'm.config.production.scrapReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SCRAP_REASON_CODES/);
  });

  it('a duplicate scrap reason code fails closed', () => {
    const run = loadConfigWith(
      { PRODUCTION_SCRAP_REASON_CODES: 'PROCESS_LOSS,PROCESS_LOSS' },
      'm.config.production.scrapReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SCRAP_REASON_CODES/);
  });

  it('an over-long scrap reason code fails closed rather than loading an unreachable entry', () => {
    const run = loadConfigWith(
      { PRODUCTION_SCRAP_REASON_CODES: `OK,${'X'.repeat(201)}` },
      'm.config.production.scrapReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SCRAP_REASON_CODES/);
  });

  it('a present-but-blank close-short reason list fails closed', () => {
    const run = loadConfigWith(
      { PRODUCTION_SHORT_CLOSE_REASON_CODES: '   ' },
      'm.config.production.shortCloseReasonCodes.length',
    );
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /PRODUCTION_SHORT_CLOSE_REASON_CODES/);
  });

  it('the Story 6.2 material-return catalogue is untouched by the Story 6.3 loader', () => {
    assert.deepStrictEqual(config.production.materialReturnReasonCodes, [
      'SURPLUS_TO_ORDER',
      'DAMAGED_IN_PROCESS',
      'INCORRECT_MATERIAL',
      'QUALITY_REJECTED',
    ]);
  });
});
