import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertInventoryTagging } from '../../src/compliance/business-stream.js';
import type { TaggingDeps } from '../../src/compliance/business-stream.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';
import type { TransactionTaggingRule } from '../../src/read/projections/business_stream_config.js';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    stream_type: 'inventory',
    stream_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'stock.moved',
    payload: {},
    metadata: {
      correlation_id: '22222222-2222-4222-8222-222222222222',
      actor: {
        user_id: '33333333-3333-4333-8333-333333333333',
        role: 'warehouse_operator',
        location_id: '44444444-4444-4444-8444-444444444444',
      },
      occurred_at: '2026-07-19T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeRule(overrides: Partial<TransactionTaggingRule> = {}): TransactionTaggingRule {
  return {
    rule_id: '55555555-5555-4555-8555-555555555555',
    transaction_type: 'stock.moved',
    cost_centre_required: false,
    project_code_required: false,
    effective_from: '2026-01-01',
    effective_to: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Deps whose DB lookups must never be reached (they throw if called). */
const unreachableDeps: TaggingDeps = {
  isValidBusinessStream: () => {
    throw new Error('isValidBusinessStream must not be called');
  },
  findActiveTaggingRule: () => {
    throw new Error('findActiveTaggingRule must not be called');
  },
};

function depsWith(validStreams: string[], rule: TransactionTaggingRule | null): TaggingDeps {
  return {
    isValidBusinessStream: (code) => Promise.resolve(validStreams.includes(code)),
    findActiveTaggingRule: () => Promise.resolve(rule),
  };
}

async function expectAppError(
  fn: () => Promise<void>,
  errorCode: string,
  details: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.strictEqual(err.errorCode, errorCode);
    assert.strictEqual(err.statusCode, 400);
    for (const [key, value] of Object.entries(details)) {
      assert.strictEqual(err.details[key], value, `details.${key}`);
    }
    return true;
  });
}

describe('assertInventoryTagging (Story 1.5, FR-AC-01)', () => {
  it('passes non-inventory stream types through with no enforcement and no DB lookups', async () => {
    // A DOA registry write has no business_stream and must never be inspected.
    await assertInventoryTagging(
      makeEnvelope({ stream_type: 'doa_registry_entry', event_type: 'doa_registry.entry_created' }),
      unreachableDeps,
    );
    await assertInventoryTagging(makeEnvelope({ stream_type: 'user', event_type: 'user.provisioned' }), unreachableDeps);
  });

  it('rejects an inventory event with no business_stream as UNTAGGED_TRANSACTION identifying the missing tag', async () => {
    await expectAppError(
      () => assertInventoryTagging(makeEnvelope({ payload: { quantity: 10 } }), unreachableDeps),
      'UNTAGGED_TRANSACTION',
      { missing_tag: 'business_stream' },
    );
  });

  it('rejects an empty-string or non-string business_stream as UNTAGGED_TRANSACTION', async () => {
    await expectAppError(
      () => assertInventoryTagging(makeEnvelope({ payload: { business_stream: '' } }), unreachableDeps),
      'UNTAGGED_TRANSACTION',
      { missing_tag: 'business_stream' },
    );
    await expectAppError(
      () => assertInventoryTagging(makeEnvelope({ payload: { business_stream: 42 } }), unreachableDeps),
      'UNTAGGED_TRANSACTION',
      { missing_tag: 'business_stream' },
    );
  });

  it('rejects an unrecognized business_stream as INVALID_BUSINESS_STREAM identifying the invalid value', async () => {
    await expectAppError(
      () =>
        assertInventoryTagging(
          makeEnvelope({ payload: { business_stream: 'unknown_stream' } }),
          depsWith(['production'], null),
        ),
      'INVALID_BUSINESS_STREAM',
      { invalid_value: 'unknown_stream' },
    );
  });

  it('passes a valid business_stream with no applicable tagging rule', async () => {
    await assertInventoryTagging(
      makeEnvelope({ payload: { business_stream: 'production' } }),
      depsWith(['production'], null),
    );
  });

  it('rejects a missing cost_centre when the effective rule requires it', async () => {
    await expectAppError(
      () =>
        assertInventoryTagging(
          makeEnvelope({ payload: { business_stream: 'production' } }),
          depsWith(['production'], makeRule({ cost_centre_required: true })),
        ),
      'UNTAGGED_TRANSACTION',
      { missing_tag: 'cost_centre', transaction_type: 'stock.moved' },
    );
  });

  it('rejects a missing project_code when the effective rule requires it', async () => {
    await expectAppError(
      () =>
        assertInventoryTagging(
          makeEnvelope({ event_type: 'rd.consumed', payload: { business_stream: 'research' } }),
          depsWith(['research'], makeRule({ transaction_type: 'rd.consumed', project_code_required: true })),
        ),
      'UNTAGGED_TRANSACTION',
      { missing_tag: 'project_code', transaction_type: 'rd.consumed' },
    );
  });

  it('passes when all required tags are present', async () => {
    await assertInventoryTagging(
      makeEnvelope({ payload: { business_stream: 'production', cost_centre: 'CC-100', project_code: 'PROJ-42' } }),
      depsWith(['production'], makeRule({ cost_centre_required: true, project_code_required: true })),
    );
  });
});
