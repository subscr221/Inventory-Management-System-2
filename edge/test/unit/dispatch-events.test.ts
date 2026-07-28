import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { classifyServerUploadFailure } from '../../src/sync/connector';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DISPATCH_PERMANENT_CODES = [
  'DISPATCH_ORDER_NOT_PICKED',
  'DISPATCH_ORDER_NOT_PACKED',
  'DISPATCH_ORDER_ALREADY_DISPATCHED',
  'DISPATCH_PACKED_INVALID_PAYLOAD',
  'DISPATCH_DOCUMENTS_INVALID_PAYLOAD',
  'DISPATCH_DISPATCHED_INVALID_PAYLOAD',
  'PACKED_QTY_MISMATCH',
  'LOT_ON_HOLD',
  'DISPATCH_DOCUMENTS_NOT_GENERATED',
];

describe('Story 3.7: dispatch event edge handling', () => {
  it('classifies every dispatch business rejection as permanent needs_attention, never halt', () => {
    for (const code of DISPATCH_PERMANENT_CODES) {
      const classification = classifyServerUploadFailure(409, { error_code: code, details: {} });
      assert.strictEqual(classification.action, 'complete', code);
      assert.strictEqual(classification.localStatus, 'needs_attention', code);
      assert.strictEqual(classification.retryable, false, code);
      assert.strictEqual(classification.serverErrorCode, code);
    }
  });

  it('a permanent dispatch code at 403 settles the event instead of halting the outbox as an auth failure', () => {
    const classification = classifyServerUploadFailure(403, { error_code: 'DISPATCH_ORDER_ALREADY_DISPATCHED', details: {} });
    assert.strictEqual(classification.action, 'complete');
    assert.strictEqual(classification.localStatus, 'needs_attention');
  });

  it('a DUPLICATE_EVENT replay of a dispatch event settles synced with the existing event id', () => {
    const classification = classifyServerUploadFailure(409, { error_code: 'DUPLICATE_EVENT', details: { existing_event_id: 'evt-dispatch-1' } });
    assert.strictEqual(classification.action, 'complete');
    assert.strictEqual(classification.localStatus, 'synced');
    assert.strictEqual(classification.existingEventId, 'evt-dispatch-1');
  });

  it('every dispatch error code carries an operator-facing i18n string', () => {
    const messages = JSON.parse(readFileSync(resolve(__dirname, '../../src/messages/en.json'), 'utf-8')) as Record<string, string>;
    for (const code of DISPATCH_PERMANENT_CODES) {
      const key = `errors.${code}`;
      assert.ok(typeof messages[key] === 'string' && messages[key]!.length > 0, `missing ${key}`);
    }
  });
});
