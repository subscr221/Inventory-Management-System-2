import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '../..');

/**
 * The edge workspace (edge/) is a separate package that builds against @powersync/web and the
 * browser DOM lib, so its modules cannot be imported from a root-workspace node:test run. This
 * file therefore reads the two PERMANENT_ERROR_CODES declarations as text, the same technique
 * test/integration/story-8-5.test.ts uses to assert against edge/src/local-db/schema.ts.
 */
function readPermanentErrorCodes(relativePath: string): string[] {
  const source = readFileSync(resolve(repoRoot, relativePath), 'utf-8');
  const marker = 'const PERMANENT_ERROR_CODES = new Set([';
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, `${relativePath} no longer declares PERMANENT_ERROR_CODES`);
  const end = source.indexOf('\n]);', start);
  assert.notStrictEqual(end, -1, `${relativePath} PERMANENT_ERROR_CODES is not terminated`);
  const block = source.slice(start + marker.length, end);
  // The trailing comma is OPTIONAL: a code added as the LAST entry of either set carries none, and
  // requiring it made that code invisible to every arm in this file (chunk-3 review T7).
  const codes = [...block.matchAll(/^\s*'([A-Z0-9_]+)',?\s*$/gm)].map(
    (match) => match[1] as string,
  );
  assert.ok(codes.length > 100, `${relativePath} parsed only ${codes.length} permanent codes`);
  return codes;
}

function readEdgeMessageKeys(): Set<string> {
  const raw = readFileSync(resolve(repoRoot, 'edge/src/messages/en.json'), 'utf-8');
  return new Set(Object.keys(JSON.parse(raw) as Record<string, string>));
}

/**
 * Ledger item 11.5R-8, CLOSED 2026-09-12 (pre-pilot sweep): the nine Epic 8/9 codes the server's
 * PERMANENT_ERROR_CODES (src/sync/upload.ts) carried and the edge twin did not are now in both.
 * This block pins them the way STORY_11_5_PERMANENT_CODES pins Story 11.5's, so dropping them from
 * BOTH sets together (which the equality arm alone would not see) still fails.
 */
const EPIC_9_PERMANENT_CODES_11_5R_8 = [
  'PROTOTYPE_NOT_SALEABLE',
  'KIT_LINE_MISMATCH',
  'OFFCUT_ELECTION_MISSING',
  'BILLING_NOT_READY',
  'SOD_VIOLATION',
  'OFFCUT_NOT_RETAINED',
  'CREDIT_NOTE_MISSING',
  'CREDIT_NOTE_UNCITABLE',
  'CREDIT_NOTE_SUPERSEDED',
];

describe('edge permanent-error-code parity', () => {
  it('every connector permanent code has an operator message in edge/src/messages/en.json', () => {
    const codes = readPermanentErrorCodes('edge/src/sync/connector.ts');
    const keys = readEdgeMessageKeys();
    const missing = codes.filter((code) => !keys.has(`errors.${code}`));
    assert.deepStrictEqual(
      missing,
      [],
      `these permanent codes fall through errorMessage() to the raw code string in the ` +
        `needs-attention list; add "errors.<CODE>" entries: ${missing.join(', ')}`,
    );
  });

  it('the two PERMANENT_ERROR_CODES sets are identical (11.5R-8 closed 2026-09-12)', () => {
    const uploadCodes = new Set(readPermanentErrorCodes('src/sync/upload.ts'));
    const connectorCodes = new Set(readPermanentErrorCodes('edge/src/sync/connector.ts'));

    const uploadOnly = [...uploadCodes].filter((code) => !connectorCodes.has(code)).sort();
    const connectorOnly = [...connectorCodes].filter((code) => !uploadCodes.has(code)).sort();

    assert.deepStrictEqual(
      uploadOnly,
      [],
      'the server classifies codes the edge connector does not: an offline edge client retries ' +
        'them forever instead of settling needs_attention. Add them to edge/src/sync/connector.ts ' +
        'and an "errors.<CODE>" message to edge/src/messages/en.json ("change both together").',
    );
    assert.deepStrictEqual(
      connectorOnly,
      [],
      'the edge connector classifies codes the server does not ("change both together").',
    );
  });

  it('every Epic 9 permanent code (11.5R-8) is in BOTH sets, not just absent from the diff', () => {
    for (const path of ['src/sync/upload.ts', 'edge/src/sync/connector.ts']) {
      const codes = new Set(readPermanentErrorCodes(path));
      const missing = EPIC_9_PERMANENT_CODES_11_5R_8.filter((code) => !codes.has(code));
      assert.deepStrictEqual(
        missing,
        [],
        `${path} lost Epic 9 permanent codes: ${missing.join(', ')}`,
      );
    }
  });

  /**
   * Chunk-3 review T8. The arm below pinned only GST_DOCUMENT_STATE_INVALID, so the other fourteen
   * Story 11.5 codes could be dropped from either set with no failure - the drift arm above would
   * stay green as long as BOTH sets lost them together, which is exactly what a careless
   * "change both together" edit does. This is the full block as declared in src/sync/upload.ts
   * ("the twin block in edge/src/sync/connector.ts carries the IDENTICAL list").
   */
  const STORY_11_5_PERMANENT_CODES = [
    'GST_DOCUMENTS_REQUIRED',
    'SITE_GSTIN_MISSING',
    'VALUATION_CONFIG_MISSING',
    'DECLARED_VALUE_REQUIRED',
    'VALUATION_COST_UNAVAILABLE',
    'BASIS_NOT_ELIGIBLE',
    'VALUATION_LOCKED',
    'NOT_A_BRANCH_TRANSFER',
    'GST_DOCUMENT_CONFLICT',
    'SHIP_QUANTITY_MISMATCH',
    'VALUATION_BASIS_NOT_PERMITTED',
    'TRANSFER_SITE_MISMATCH',
    'GST_DOCUMENT_STATE_INVALID',
    'GSTIN_CONFIG_OVERLAP',
    'VALUATION_CONFIG_OVERLAP',
  ];

  it("every Story 11.5 permanent code is in BOTH sets, not just the twins' shared subset", () => {
    for (const path of ['src/sync/upload.ts', 'edge/src/sync/connector.ts']) {
      const codes = new Set(readPermanentErrorCodes(path));
      const missing = STORY_11_5_PERMANENT_CODES.filter((code) => !codes.has(code));
      assert.deepStrictEqual(
        missing,
        [],
        `${path} no longer classifies these Story 11.5 refusals permanent, so an offline edge ` +
          `client will retry them forever instead of settling them needs_attention: ` +
          `${missing.join(', ')}`,
      );
    }
  });

  it('classifies GST_DOCUMENT_STATE_INVALID permanent and leaves INVALID_STATE retryable', () => {
    for (const path of ['src/sync/upload.ts', 'edge/src/sync/connector.ts']) {
      const codes = readPermanentErrorCodes(path);
      assert.ok(
        codes.includes('GST_DOCUMENT_STATE_INVALID'),
        `${path} must classify the Story 11.5 late-document refusal permanent`,
      );
      assert.ok(
        !codes.includes('INVALID_STATE'),
        `${path} must NOT classify INVALID_STATE permanent - it is a shared generic thrown by the ` +
          `transfer-receive and cycle-count appliers, where a retry self-heals`,
      );
    }
  });
});
