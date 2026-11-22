import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gstinCheckCharacter, isValidGstin } from '../../src/compliance/supplier.js';
import { assertSiteGstinEffectiveFrom } from '../../src/api/v1/sites.js';

describe('DW-25 GSTIN check digit', () => {
  it('accepts a known-valid GSTIN and computes its check character', () => {
    assert.equal(gstinCheckCharacter('27AAPFU0939F1Z'), 'V');
    assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
  });
  it('rejects transposed and wrong-check GSTINs', () => {
    assert.equal(isValidGstin('27AAPFU0939F1VZ'), false);
    assert.equal(isValidGstin('27AAPFU0939F1ZA'), false);
  });
});

describe('DW-26 site GSTIN effective_from window', () => {
  const today = '2026-11-22';
  const upper = '2027-11-23'; // today + 366 days
  const refused = (d: string) =>
    assert.throws(
      () => assertSiteGstinEffectiveFrom(d, today),
      (e: { statusCode?: number; errorCode?: string }) =>
        e.statusCode === 400 && e.errorCode === 'INVALID_PARAMS',
    );
  it('accepts both window edges', () => {
    assert.doesNotThrow(() => assertSiteGstinEffectiveFrom('2017-07-01', today));
    assert.doesNotThrow(() => assertSiteGstinEffectiveFrom(upper, today));
  });
  it('refuses one day outside each edge', () => {
    refused('2017-06-30');
    refused('2027-11-24');
    refused('2999-01-01');
  });
});
