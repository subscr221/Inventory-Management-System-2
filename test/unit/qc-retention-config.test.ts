import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';
import {
  addYearsToCalendarDate,
  resolveRetentionYears,
  retentionSampleRequiredFor,
} from '../../src/compliance/quality.js';

/**
 * Story 8.4 (FR-Q-07, AC 1 and AC 2, Binding Scope Decision 7). AC 2's RETENTION_FLOOR_VIOLATION is
 * a BOOT-TIME config guard, not a runtime route: there is no admin API for retention configuration
 * anywhere in this codebase, so the only place a below-floor retention period can be "configured"
 * is the environment, and the only fail-closed moment is startup.
 *
 * The guard is proved by loading src/config/index.ts in a CHILD process with the offending
 * environment - an in-process import would be served from the module cache with the ambient
 * .env.test values. Every child run also prints the resolved value, so these tests fail loudly if
 * the env injection ever stops taking effect rather than silently degrading to "config loads fine".
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

interface ChildResult {
  status: number | null;
  output: string;
}

function loadConfigWith(env: Record<string, string>): ChildResult {
  const result = spawnSync(
    process.execPath,
    [
      '--env-file=.env.test',
      '--import',
      'tsx',
      '-e',
      "import('./src/config/index.ts').then((m) => console.log('RESOLVED=' + m.config.quality.retentionYearsDefault));",
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

describe('Story 8.4 retention configuration (AC 1, AC 2)', () => {
  it('AC 1: the retention default is 7 years and the BIS STI floor defaults to the same value', () => {
    assert.strictEqual(config.quality.retentionYearsDefault, 7);
    assert.strictEqual(config.quality.bisRetentionFloorYears, 7);
    assert.strictEqual(config.quality.retentionExpiryAlertLeadDays, 30);
    // Story 8.4 review: all four knobs for this one feature live in one namespace.
    assert.strictEqual(config.quality.retentionExpiryIntervalMs, 3_600_000);
    assert.strictEqual(config.quality.retentionExpiryBatchSize, 500);
    // Open Question 1: an unconfigured deployment keeps the broader, safer rule.
    assert.strictEqual(config.quality.retentionSampleScope, 'all_released_lots');
  });

  it('Open Question 1: the retention-sample scope selects which lots need a sample', () => {
    // The scope is passed explicitly so BOTH branches are exercised. Asserting against the ambient
    // config would only ever test the deployed setting and would pass for a hard-coded `true`.
    assert.strictEqual(retentionSampleRequiredFor(false, 'all_released_lots'), true);
    assert.strictEqual(retentionSampleRequiredFor(true, 'all_released_lots'), true);
    // Narrowed: a non-BIS lot may be released with no retention sample.
    assert.strictEqual(retentionSampleRequiredFor(false, 'bis_covered_only'), false);
    // ...but a BIS-covered lot still needs one under either scope.
    assert.strictEqual(retentionSampleRequiredFor(true, 'bis_covered_only'), true);
    // And the ambient default resolves to the broad rule for both.
    assert.strictEqual(retentionSampleRequiredFor(false), true);
    assert.strictEqual(retentionSampleRequiredFor(true), true);
  });

  it('Open Question 1: an unrecognised retention-sample scope refuses to boot', () => {
    // The two settings differ in whether statutory evidence exists at all, so a typo must stop the
    // boot rather than quietly selecting one of them.
    const bad = loadConfigWith({ QC_RETENTION_SAMPLE_SCOPE: 'bis_only' });
    assert.strictEqual(bad.status, 1, bad.output);
    assert.match(bad.output, /QC_RETENTION_SAMPLE_SCOPE/);
    assert.doesNotMatch(bad.output, /RESOLVED=/);

    const narrowed = loadConfigWith({ QC_RETENTION_SAMPLE_SCOPE: 'bis_covered_only' });
    assert.strictEqual(narrowed.status, 0, narrowed.output);
  });

  it('AC 2: a retention default below the BIS STI floor refuses to boot with RETENTION_FLOOR_VIOLATION', () => {
    const failed = loadConfigWith({
      QC_RETENTION_YEARS_DEFAULT: '5',
      QC_BIS_RETENTION_FLOOR_YEARS: '7',
    });
    // An EXACT exit code: notStrictEqual(status, 0) would also pass on a spawn failure, a missing
    // .env.test, or a TypeScript error - i.e. it would pass for entirely the wrong reason.
    assert.strictEqual(failed.status, 1, failed.output);
    assert.match(
      failed.output,
      /RETENTION_FLOOR_VIOLATION: QC_RETENTION_YEARS_DEFAULT \(5\) must not be below QC_BIS_RETENTION_FLOOR_YEARS \(7\)/,
    );
    assert.doesNotMatch(failed.output, /RESOLVED=/);
  });

  it('AC 2: a retention default at or above the floor boots, and the injected value takes effect', () => {
    const ok = loadConfigWith({
      QC_RETENTION_YEARS_DEFAULT: '10',
      QC_BIS_RETENTION_FLOOR_YEARS: '7',
    });
    assert.strictEqual(ok.status, 0, ok.output);
    // Proves the injection actually reached the child. Without it, this pair of tests would stay
    // green even if --env-file precedence changed and nothing was injected at all.
    assert.match(ok.output, /RESOLVED=10/);
  });

  it('the retention knobs are bounded above, so a mistyped value cannot sweep the whole table', () => {
    const leadTooBig = loadConfigWith({ QC_RETENTION_EXPIRY_ALERT_LEAD_DAYS: '1000000' });
    assert.strictEqual(leadTooBig.status, 1, leadTooBig.output);
    assert.match(leadTooBig.output, /QC_RETENTION_EXPIRY_ALERT_LEAD_DAYS/);

    const yearsTooBig = loadConfigWith({ QC_RETENTION_YEARS_DEFAULT: '300000' });
    assert.strictEqual(yearsTooBig.status, 1, yearsTooBig.output);
    assert.match(yearsTooBig.output, /QC_RETENTION_YEARS_DEFAULT/);

    // Above 2^31-1 Node silently clamps setInterval to 1 ms - a tick storm, not an hourly sweep.
    const intervalTooBig = loadConfigWith({ QC_RETENTION_EXPIRY_INTERVAL_MS: '999999999999' });
    assert.strictEqual(intervalTooBig.status, 1, intervalTooBig.output);
    assert.match(intervalTooBig.output, /QC_RETENTION_EXPIRY_INTERVAL_MS/);
  });

  it('Binding Scope Decision 7: resolveRetentionYears takes the HIGHER of the default and the BIS floor', () => {
    // The bounds are passed explicitly so the Math.max is genuinely exercised. Asserting both arms
    // against the ambient config is a tautology: the boot guard makes floor <= default, so the
    // function is provably equal to the default in every reachable configuration and such a test
    // would pass for `return config.quality.retentionYearsDefault`.
    assert.strictEqual(resolveRetentionYears(true, 5, 9), 9, 'a BIS lot is lifted to the floor');
    assert.strictEqual(resolveRetentionYears(false, 5, 9), 5, 'a non-BIS lot keeps the default');
    assert.strictEqual(
      resolveRetentionYears(true, 12, 9),
      12,
      'the default wins when it is higher',
    );
    // The reachable configuration still resolves to the default for both.
    assert.strictEqual(resolveRetentionYears(true), config.quality.retentionYearsDefault);
    assert.strictEqual(resolveRetentionYears(false), config.quality.retentionYearsDefault);
  });

  it('a retention expiry is calendar arithmetic, and 29 February clamps to 28 February', () => {
    assert.strictEqual(addYearsToCalendarDate('2026-07-15', 7), '2033-07-15');
    assert.strictEqual(addYearsToCalendarDate('2024-02-29', 7), '2031-02-28');
    assert.strictEqual(addYearsToCalendarDate('2024-02-29', 4), '2028-02-29');
    assert.strictEqual(addYearsToCalendarDate('2026-12-31', 7), '2033-12-31');
    assert.strictEqual(addYearsToCalendarDate('2026-01-01', 7), '2033-01-01');
  });
});
