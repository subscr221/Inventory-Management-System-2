import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isScanSubmitKey, normalizeScanValue } from '../../src/capture/scan';

describe('Story 3.13 ScanField', () => {
  it('treats Enter as the wedge terminator and Shift+Enter as a newline', () => {
    assert.equal(isScanSubmitKey('Enter'), true);
    assert.equal(isScanSubmitKey('Enter', true), false);
    assert.equal(isScanSubmitKey('a'), false);
    assert.equal(isScanSubmitKey('Tab'), false);
  });

  it('normalizes a scanned value by trimming the terminator whitespace', () => {
    assert.equal(normalizeScanValue('  ASN-2026-01 \r\n'), 'ASN-2026-01');
    assert.equal(normalizeScanValue('PO-1'), 'PO-1');
    assert.equal(normalizeScanValue('   '), '');
  });
});
