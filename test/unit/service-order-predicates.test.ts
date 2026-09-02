import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceOrderTransitionAllowed,
  isValidPriceBasis,
  type ServiceOrderStatus,
} from '../../src/compliance/service-order.js';

/**
 * Story 9.1 (Task 6.1): the four-state machine predicate takes current status and target as
 * PARAMETERS (the 8.4 tautological-config lesson), so these tests can actually fail when the
 * transition table is wrong. The seam and the routes both consult this predicate; the confirm
 * guard and the out-of-sequence guard are additionally mutation-verified at two points (seam and
 * route) per Task 6.2.
 */

const gateOpen = { hasKitBom: true, hasPriceBasis: true };

describe('Story 9.1 service order transition predicate', () => {
  it('allows draft -> confirmed only with both kit BOM and price basis', () => {
    assert.strictEqual(serviceOrderTransitionAllowed('draft', 'confirmed', gateOpen), true);
    assert.strictEqual(
      serviceOrderTransitionAllowed('draft', 'confirmed', {
        hasKitBom: false,
        hasPriceBasis: true,
      }),
      false,
    );
    assert.strictEqual(
      serviceOrderTransitionAllowed('draft', 'confirmed', {
        hasKitBom: true,
        hasPriceBasis: false,
      }),
      false,
    );
    assert.strictEqual(
      serviceOrderTransitionAllowed('draft', 'confirmed', {
        hasKitBom: false,
        hasPriceBasis: false,
      }),
      false,
    );
  });

  it('allows confirmed -> in_process (Story 9.2 first customer-material receipt)', () => {
    assert.strictEqual(serviceOrderTransitionAllowed('confirmed', 'in_process', gateOpen), true);
  });

  it('refuses in_process from any state but confirmed', () => {
    for (const current of ['draft', 'in_process', 'closed'] as ServiceOrderStatus[]) {
      assert.strictEqual(serviceOrderTransitionAllowed(current, 'in_process', gateOpen), false);
    }
  });

  it('refuses closed without the Story 9.5 closure-gate marker, even from in_process', () => {
    assert.strictEqual(serviceOrderTransitionAllowed('in_process', 'closed', gateOpen), false);
    assert.strictEqual(
      serviceOrderTransitionAllowed('in_process', 'closed', {
        ...gateOpen,
        closureGatePassed: false,
      }),
      false,
    );
    assert.strictEqual(
      serviceOrderTransitionAllowed('in_process', 'closed', {
        ...gateOpen,
        closureGatePassed: true,
      }),
      true,
    );
  });

  it('refuses draft -> closed (the AC 3 out-of-sequence example) with or without the gate', () => {
    assert.strictEqual(serviceOrderTransitionAllowed('draft', 'closed', gateOpen), false);
    assert.strictEqual(
      serviceOrderTransitionAllowed('draft', 'closed', { ...gateOpen, closureGatePassed: true }),
      false,
    );
  });

  it('refuses every transition back into draft and every double transition', () => {
    for (const current of ['draft', 'confirmed', 'in_process', 'closed'] as ServiceOrderStatus[]) {
      assert.strictEqual(serviceOrderTransitionAllowed(current, 'draft', gateOpen), false);
    }
    // Double-confirm and re-close refuse.
    assert.strictEqual(serviceOrderTransitionAllowed('confirmed', 'confirmed', gateOpen), false);
    assert.strictEqual(
      serviceOrderTransitionAllowed('closed', 'closed', { ...gateOpen, closureGatePassed: true }),
      false,
    );
    // Skip-ahead refuses.
    assert.strictEqual(serviceOrderTransitionAllowed('draft', 'in_process', gateOpen), false);
    assert.strictEqual(
      serviceOrderTransitionAllowed('confirmed', 'closed', {
        ...gateOpen,
        closureGatePassed: true,
      }),
      false,
    );
  });
});

describe('Story 9.1 price basis shape', () => {
  it('accepts each of the four basis types with a non-negative rate and a currency', () => {
    for (const basis_type of ['per_piece', 'per_kg', 'per_hour', 'lumpsum']) {
      assert.strictEqual(isValidPriceBasis({ basis_type, rate: 12.5, currency: 'INR' }), true);
    }
  });

  it('rejects unknown basis types, negative rates, missing fields, and extra fields', () => {
    assert.strictEqual(
      isValidPriceBasis({ basis_type: 'per_tonne', rate: 1, currency: 'INR' }),
      false,
    );
    assert.strictEqual(
      isValidPriceBasis({ basis_type: 'per_kg', rate: -1, currency: 'INR' }),
      false,
    );
    assert.strictEqual(isValidPriceBasis({ basis_type: 'per_kg', rate: 1 }), false);
    assert.strictEqual(isValidPriceBasis({ basis_type: 'per_kg', currency: 'INR' }), false);
    assert.strictEqual(isValidPriceBasis({ basis_type: 'per_kg', rate: 1, currency: '' }), false);
    assert.strictEqual(
      isValidPriceBasis({ basis_type: 'per_kg', rate: 1, currency: 'INR', extra: true }),
      false,
    );
    assert.strictEqual(isValidPriceBasis(null), false);
    assert.strictEqual(isValidPriceBasis('per_kg'), false);
    assert.strictEqual(isValidPriceBasis([]), false);
    assert.strictEqual(
      isValidPriceBasis({ basis_type: 'per_kg', rate: Number.NaN, currency: 'INR' }),
      false,
    );
  });
});
