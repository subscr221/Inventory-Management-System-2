import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../src/config/index.js';
import {
  QC_CENTRAL_ONLY_EVENT_TYPES,
  QUALITY_EVENT_TYPES,
  QC_HOLD_PLACED,
  QC_HOLD_RELEASED,
  QC_NCR_RAISED,
  QC_CAPA_OPENED,
  QC_CAPA_CLOSED,
  QC_CAPA_LINKED,
} from '../../src/compliance/quality.js';

/**
 * Story 8.5 (FR-Q-10, Binding Scope Decision 10). QC_DEFECT_CODES is parsed with the exact Story
 * 7.8 fail-closed contract: only an ABSENT variable takes the ten confirmed seed defaults;
 * present-but-blank, duplicate, over-length or line-break-carrying fails AT LOAD.
 *
 * The fail-closed branch is proved by loading src/config/index.ts in a CHILD process with the
 * offending environment (the qc-retention-config precedent) - an in-process import would be served
 * from the module cache with the ambient .env.test values. Every child run also prints the
 * resolved catalogue size, so the tests fail loudly if the env injection ever stops taking effect.
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
      "import('./src/config/index.ts').then((m) => console.log('RESOLVED=' + m.config.qc.defectCodes.join(',')));",
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

const SEED_CODES = [
  'DIMENSIONAL',
  'SURFACE_FINISH',
  'MATERIAL_NONCONFORMITY',
  'CONTAMINATION',
  'ASSEMBLY',
  'FUNCTIONAL',
  'MARKING_LABELLING',
  'PACKAGING',
  'CORROSION',
  'DOCUMENTATION',
];

describe('Story 8.5 QC defect-code catalogue and repeat-defect configuration', () => {
  it('an ABSENT variable takes the ten confirmed enterprise seed codes', () => {
    // The ambient .env.test does not set QC_DEFECT_CODES, so the in-process config carries the
    // seed catalogue; a child run proves the same branch end to end.
    assert.deepStrictEqual([...config.qc.defectCodes], SEED_CODES);
    const child = loadConfigWith({});
    assert.strictEqual(child.status, 0, child.output);
    assert.match(child.output, new RegExp(`RESOLVED=${SEED_CODES.join(',')}`));
  });

  it('a present-but-blank variable is an operator statement and fails closed at load', () => {
    const blank = loadConfigWith({ QC_DEFECT_CODES: '' });
    assert.strictEqual(blank.status, 1, blank.output);
    assert.match(blank.output, /QC_DEFECT_CODES/);
    assert.doesNotMatch(blank.output, /RESOLVED=/);
  });

  it('a duplicate or line-break-carrying catalogue fails closed at load', () => {
    const duplicated = loadConfigWith({ QC_DEFECT_CODES: 'DIMENSIONAL,DIMENSIONAL' });
    assert.strictEqual(duplicated.status, 1, duplicated.output);
    assert.match(duplicated.output, /QC_DEFECT_CODES/);

    const custom = loadConfigWith({ QC_DEFECT_CODES: 'WELD_POROSITY,PAINT_DEFECT' });
    assert.strictEqual(custom.status, 0, custom.output);
    assert.match(custom.output, /RESOLVED=WELD_POROSITY,PAINT_DEFECT/);
  });

  it('the repeat-defect and propagation-budget knobs default to 3 / 90 / 15', () => {
    assert.strictEqual(config.qc.repeatDefectThreshold, 3);
    assert.strictEqual(config.qc.repeatDefectWindowDays, 90);
    assert.strictEqual(config.qc.holdPropagationBudgetMinutes, 15);
  });

  it('all six Story 8.5 event types are central-only BY CONSTRUCTION', () => {
    // QC_CENTRAL_ONLY_EVENT_TYPES is derived by filtering only qc.result_recorded out of the
    // family - asserted here rather than assumed (Task 2).
    for (const type of [
      QC_HOLD_PLACED,
      QC_HOLD_RELEASED,
      QC_NCR_RAISED,
      QC_CAPA_OPENED,
      QC_CAPA_CLOSED,
      QC_CAPA_LINKED,
    ]) {
      assert.ok(QUALITY_EVENT_TYPES.has(type), `${type} missing from QUALITY_EVENT_TYPES`);
      assert.ok(QC_CENTRAL_ONLY_EVENT_TYPES.has(type), `${type} must be central-only`);
    }
    assert.ok(!QC_CENTRAL_ONLY_EVENT_TYPES.has('qc.result_recorded'));
  });
});
