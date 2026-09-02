import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';

/**
 * Story 9.2 (FR-JW-05, Binding Scope Decision 6): JOBWORK_RECEIPT_TOLERANCE_PCT is BOOT-TIME
 * configuration with no admin API, so the only fail-closed moment is startup. Proved by loading
 * src/config/index.ts in a CHILD process with the offending environment (the Story 6.3
 * production-completion-config pattern); every accepting run prints the RESOLVED value and the
 * assertions compare it with a LITERAL, never with the config object itself (the 8.4 lesson).
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

const EXPR = 'm.config.jobwork.receiptTolerancePercent';

describe('Story 9.2 receipt tolerance configuration (JOBWORK_RECEIPT_TOLERANCE_PCT)', () => {
  it('the ambient default is the documented literal 0.5 percent, kept as a string', () => {
    assert.strictEqual(config.jobwork.receiptTolerancePercent, '0.5');
    assert.strictEqual(typeof config.jobwork.receiptTolerancePercent, 'string');
  });

  it('an explicit tolerance is taken verbatim, decimals included', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '1.25' }, EXPR);
    assert.strictEqual(run.status, 0, run.output);
    assert.match(run.output, /^RESOLVED=1\.25$/m, run.output);
  });

  it('zero is legal (flag every deviation) and 10 is legal (the inclusive cap)', () => {
    const zero = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '0' }, EXPR);
    assert.strictEqual(zero.status, 0, zero.output);
    assert.match(zero.output, /^RESOLVED=0$/m, zero.output);
    const cap = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '10' }, EXPR);
    assert.strictEqual(cap.status, 0, cap.output);
    assert.match(cap.output, /^RESOLVED=10$/m, cap.output);
  });

  it('a present-but-blank value fails closed rather than silently taking the default', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '' }, EXPR);
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /JOBWORK_RECEIPT_TOLERANCE_PCT/);
  });

  it('above the cap refuses to boot', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '10.0001' }, EXPR);
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /JOBWORK_RECEIPT_TOLERANCE_PCT/);
  });

  it('a negative tolerance refuses to boot', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '-0.5' }, EXPR);
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /JOBWORK_RECEIPT_TOLERANCE_PCT/);
  });

  it('a non-numeric tolerance refuses to boot', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: 'half' }, EXPR);
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /JOBWORK_RECEIPT_TOLERANCE_PCT/);
  });

  it('more than four decimal places refuses to boot (the predicate scale is exact to 4 dp)', () => {
    const run = loadConfigWith({ JOBWORK_RECEIPT_TOLERANCE_PCT: '0.00001' }, EXPR);
    assert.notStrictEqual(run.status, 0, run.output);
    assert.match(run.output, /JOBWORK_RECEIPT_TOLERANCE_PCT/);
  });
});
