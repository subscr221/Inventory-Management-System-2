import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';
import {
  bisLicenceBlockApplies,
  labelVersionBlockApplies,
} from '../../src/compliance/quality.js';

/**
 * Story 8.6 (AC 1, AC 3, AC 4, Binding Scope Decision 3): QC_STATUTORY_RELEASE_BLOCKS is a
 * fail-closed BOOT config. Only an ABSENT variable takes the `enforce` default; a
 * present-but-blank or unrecognised value refuses boot (the repo-wide invariant), because the two
 * settings differ in whether a statutory release gate exists at all.
 *
 * The boot behaviour is proved by loading src/config/index.ts in a CHILD process (the
 * qc-retention-config precedent - an in-process import would be served from the module cache with
 * the ambient .env.test values). The block predicates take the mode as a PARAMETER, so both
 * branches are exercised here without reloading config (the Story 8.4 tautological-config
 * lesson).
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
      "import('./src/config/index.ts').then((m) => console.log('RESOLVED=' + m.config.quality.statutoryReleaseBlocks));",
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

describe('Story 8.6 statutory release blocks configuration (AC 4, Binding Scope Decision 3)', () => {
  it('the ambient test configuration resolves to the enforce default', () => {
    assert.strictEqual(config.quality.statutoryReleaseBlocks, 'enforce');
  });

  it('an ABSENT variable takes the enforce default in a fresh process', () => {
    // .env.test does not set QC_STATUTORY_RELEASE_BLOCKS, so this child proves the absent-variable
    // default rather than an injected value.
    const absent = loadConfigWith({});
    assert.strictEqual(absent.status, 0, absent.output);
    assert.match(absent.output, /RESOLVED=enforce/);
  });

  it('dormant is accepted and resolves (the A-13 licence-data load window)', () => {
    const dormant = loadConfigWith({ QC_STATUTORY_RELEASE_BLOCKS: 'dormant' });
    assert.strictEqual(dormant.status, 0, dormant.output);
    assert.match(dormant.output, /RESOLVED=dormant/);
  });

  it('enforce is accepted explicitly, proving the injection reaches the child', () => {
    const enforce = loadConfigWith({ QC_STATUTORY_RELEASE_BLOCKS: 'enforce' });
    assert.strictEqual(enforce.status, 0, enforce.output);
    assert.match(enforce.output, /RESOLVED=enforce/);
  });

  it('a present-but-BLANK value refuses boot (fail-closed, never a silent default)', () => {
    const blank = loadConfigWith({ QC_STATUTORY_RELEASE_BLOCKS: '' });
    assert.strictEqual(blank.status, 1, blank.output);
    assert.match(blank.output, /QC_STATUTORY_RELEASE_BLOCKS/);
    assert.doesNotMatch(blank.output, /RESOLVED=/);
  });

  it('an unrecognised value refuses boot', () => {
    const typo = loadConfigWith({ QC_STATUTORY_RELEASE_BLOCKS: 'enforced' });
    assert.strictEqual(typo.status, 1, typo.output);
    assert.match(typo.output, /QC_STATUTORY_RELEASE_BLOCKS/);
    assert.doesNotMatch(typo.output, /RESOLVED=/);
  });

  it('AC 1/AC 4: the BIS block predicate fires only under enforce, for a covered product with no licence', () => {
    // Mode is a parameter: both branches are real, not the ambient config re-asserted.
    assert.strictEqual(bisLicenceBlockApplies('enforce', true, false), true);
    assert.strictEqual(bisLicenceBlockApplies('enforce', true, true), false);
    assert.strictEqual(bisLicenceBlockApplies('enforce', false, false), false);
    assert.strictEqual(bisLicenceBlockApplies('dormant', true, false), false);
    assert.strictEqual(bisLicenceBlockApplies('dormant', true, true), false);
    assert.strictEqual(bisLicenceBlockApplies('dormant', false, false), false);
  });

  it('AC 3/AC 4: the label block predicate fires only under enforce, for a Legal Metrology item with no approved label', () => {
    assert.strictEqual(labelVersionBlockApplies('enforce', true, false), true);
    assert.strictEqual(labelVersionBlockApplies('enforce', true, true), false);
    assert.strictEqual(labelVersionBlockApplies('enforce', false, false), false);
    assert.strictEqual(labelVersionBlockApplies('dormant', true, false), false);
    assert.strictEqual(labelVersionBlockApplies('dormant', true, true), false);
    assert.strictEqual(labelVersionBlockApplies('dormant', false, false), false);
  });
});
