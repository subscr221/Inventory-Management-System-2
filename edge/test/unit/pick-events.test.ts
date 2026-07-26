import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { classifyServerUploadFailure } from '../../src/sync/connector';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Story 3.6: every pick-task business rejection is a PERMANENT edge error - the outbox settles the
// single event needs_attention instead of halting or retrying forever.
const PICK_PERMANENT_CODES = [
  'PICK_TASK_NOT_FOUND',
  'PICK_LINE_NOT_FOUND',
  'PICK_TASK_INVALID_PAYLOAD',
  'PICK_LINE_ALREADY_CONFIRMED',
  'PICK_OVERRIDE_REASON_REQUIRED',
  'PICK_TASK_NOT_ALL_LINES_CONFIRMED',
  'PICK_TASK_ALREADY_COMPLETED',
  'INSUFFICIENT_STOCK_FOR_PICK',
  'DISPATCH_ORDER_LINE_NOT_FOUND',
];

describe('Story 3.6: pick event edge handling', () => {
  it('classifies every pick business rejection as permanent needs_attention, never halt', () => {
    for (const code of PICK_PERMANENT_CODES) {
      const classification = classifyServerUploadFailure(409, { error_code: code, details: {} });
      assert.strictEqual(classification.action, 'complete', code);
      assert.strictEqual(classification.localStatus, 'needs_attention', code);
      assert.strictEqual(classification.retryable, false, code);
      assert.strictEqual(classification.serverErrorCode, code);
    }
  });

  it('a permanent pick code at 403 settles the event instead of halting the outbox as an auth failure', () => {
    const classification = classifyServerUploadFailure(403, { error_code: 'PICK_OVERRIDE_REASON_REQUIRED', details: {} });
    assert.strictEqual(classification.action, 'complete');
    assert.strictEqual(classification.localStatus, 'needs_attention');
  });

  it('a DUPLICATE_EVENT replay of a pick confirmation settles synced with the existing event id', () => {
    const classification = classifyServerUploadFailure(409, { error_code: 'DUPLICATE_EVENT', details: { existing_event_id: 'evt-1' } });
    assert.strictEqual(classification.action, 'complete');
    assert.strictEqual(classification.localStatus, 'synced');
    assert.strictEqual(classification.existingEventId, 'evt-1');
  });

  it('every pick error code carries an operator-facing i18n string', () => {
    const messages = JSON.parse(readFileSync(resolve(__dirname, '../../src/messages/en.json'), 'utf-8')) as Record<string, string>;
    for (const code of PICK_PERMANENT_CODES) {
      const key = `errors.${code}`;
      assert.ok(typeof messages[key] === 'string' && messages[key]!.length > 0, `missing ${key}`);
    }
  });
});
