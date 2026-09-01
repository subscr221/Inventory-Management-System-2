import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 8.7 (FR-Q-11, Binding Scope Decision 6): QC_BIS_LICENCE_EXPIRY_INTERVAL_MS and
 * QC_BIS_LICENCE_EXPIRY_BATCH_SIZE are fail-closed BOOT config, cloning the
 * qc-statutory-blocks-config.test.ts / retention-expiry-config child-process pattern - an
 * in-process import would be served from the module cache with the ambient .env.test values.
 * ABSENT takes the default; present-but-blank or unrecognised REFUSES BOOT.
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
      "import('./src/config/index.ts').then((m) => console.log('INTERVAL=' + m.config.quality.bisLicenceExpiryIntervalMs + ' BATCH=' + m.config.quality.bisLicenceExpiryBatchSize));",
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

describe('Story 8.7 BIS licence expiry sweep configuration (Binding Scope Decision 6)', () => {
  it('an ABSENT interval and batch size take the documented defaults', () => {
    const absent = loadConfigWith({});
    assert.strictEqual(absent.status, 0, absent.output);
    assert.match(absent.output, /INTERVAL=3600000 BATCH=500/);
  });

  it('a valid override for both knobs reaches the child process', () => {
    const overridden = loadConfigWith({
      QC_BIS_LICENCE_EXPIRY_INTERVAL_MS: '120000',
      QC_BIS_LICENCE_EXPIRY_BATCH_SIZE: '25',
    });
    assert.strictEqual(overridden.status, 0, overridden.output);
    assert.match(overridden.output, /INTERVAL=120000 BATCH=25/);
  });

  // Story 8.7 code review (D7): these two knobs opt into parsePositiveIntEnv's strictBlank arm, so
  // they follow BSD-6's repo-wide invariant rather than the older blank-as-absent numeric-knob
  // convention - an ABSENT variable takes the default, a present-but-BLANK one refuses boot. A
  // blank knob in a deploy config means the operator meant something that did not land, and
  // silently running an hourly statutory sweep they believe they configured is the failure mode
  // this closes. The sibling knob added in the same change (consumptionVarianceTolerancePercent)
  // already fails closed on blank; these now agree with it.
  it('a present-but-BLANK interval refuses boot (BSD-6 fail-closed)', () => {
    const blank = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_INTERVAL_MS: '' });
    assert.strictEqual(blank.status, 1, blank.output);
    assert.match(blank.output, /QC_BIS_LICENCE_EXPIRY_INTERVAL_MS/);
    assert.doesNotMatch(blank.output, /INTERVAL=/);
  });

  it('a present-but-BLANK batch size refuses boot (BSD-6 fail-closed)', () => {
    const blank = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_BATCH_SIZE: '' });
    assert.strictEqual(blank.status, 1, blank.output);
    assert.match(blank.output, /QC_BIS_LICENCE_EXPIRY_BATCH_SIZE/);
    assert.doesNotMatch(blank.output, /BATCH=/);
  });

  it('an unrecognised (non-numeric) interval refuses boot', () => {
    const typo = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_INTERVAL_MS: 'soon' });
    assert.strictEqual(typo.status, 1, typo.output);
    assert.match(typo.output, /QC_BIS_LICENCE_EXPIRY_INTERVAL_MS/);
    assert.doesNotMatch(typo.output, /INTERVAL=/);
  });

  it('an unrecognised (non-numeric) batch size refuses boot', () => {
    const typo = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_BATCH_SIZE: 'lots' });
    assert.strictEqual(typo.status, 1, typo.output);
    assert.match(typo.output, /QC_BIS_LICENCE_EXPIRY_BATCH_SIZE/);
    assert.doesNotMatch(typo.output, /BATCH=/);
  });

  it('a batch size over the 10,000 upper bound refuses boot', () => {
    const tooLarge = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_BATCH_SIZE: '10001' });
    assert.strictEqual(tooLarge.status, 1, tooLarge.output);
    assert.match(tooLarge.output, /QC_BIS_LICENCE_EXPIRY_BATCH_SIZE/);
    assert.doesNotMatch(tooLarge.output, /BATCH=/);
  });

  // The interval bound exists to stop a setInterval tick storm: Node clamps anything above
  // 2^31-1 to 1ms, so an unbounded interval turns an hourly sweep into a busy loop.
  it('an interval over the MAX_INTERVAL_MS upper bound refuses boot', () => {
    const tooLarge = loadConfigWith({ QC_BIS_LICENCE_EXPIRY_INTERVAL_MS: '2147483648' });
    assert.strictEqual(tooLarge.status, 1, tooLarge.output);
    assert.match(tooLarge.output, /QC_BIS_LICENCE_EXPIRY_INTERVAL_MS/);
    assert.doesNotMatch(tooLarge.output, /INTERVAL=/);
  });
});
