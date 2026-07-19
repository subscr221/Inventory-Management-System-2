import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocationInvariant } from '../../src/compliance/location.js';
import type { LocationDeps } from '../../src/compliance/location.js';
import type { ExpectedLocationFact, AssertedLocationFact, CurrentLocation } from '../../src/read/projections/location.js';
import type { EventEnvelope, PersistedEvent } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';

const LOT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    stream_type: 'inventory',
    stream_id: LOT_ID,
    event_type: 'location.asserted',
    payload: { business_stream: 'production', lot_id: LOT_ID, asserted_location: 'BIN-A43' },
    metadata: {
      correlation_id: '33333333-3333-4333-8333-333333333333',
      actor: {
        user_id: '44444444-4444-4444-8444-444444444444',
        role: 'warehouse_operator',
        location_id: '55555555-5555-4555-8555-555555555555',
      },
      device_id: 'rugged-01',
      occurred_at: '2026-07-19T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makePersisted(envelope: EventEnvelope = makeEnvelope()): PersistedEvent {
  return {
    ...envelope,
    event_id: EVENT_ID,
    event_version: 1,
    schema_version: 1,
    created_at: '2026-07-19T00:00:00.000Z',
  };
}

function expectedFact(location = 'BIN-A47'): ExpectedLocationFact {
  return {
    fact_id: '66666666-6666-4666-8666-666666666666',
    lot_id: LOT_ID,
    expected_location: location,
    source: 'seed',
    source_event_id: '77777777-7777-4777-8777-777777777777',
    recorded_at: '2026-07-19T00:00:00.000Z',
  };
}

function makeDeps(expected: ExpectedLocationFact | null, calls: string[]): LocationDeps {
  return {
    getExpectedLocation: async () => expected,
    recordExpectedLocation: async () => {
      calls.push('expected');
      return expectedFact('BIN-A47');
    },
    recordAssertedLocation: async (_input) => {
      calls.push('asserted');
      return {
        fact_id: '88888888-8888-4888-8888-888888888888',
        lot_id: LOT_ID,
        asserted_location: 'BIN-A43',
        recorded_by: '44444444-4444-4444-8444-444444444444',
        device_id: 'rugged-01',
        recorded_at: '2026-07-19T00:00:00.000Z',
        confidence: 'none',
        source_event_id: EVENT_ID,
        source_event_version: 1,
      } satisfies AssertedLocationFact;
    },
    updateCurrentLocation: async () => {
      calls.push('current');
      return {
        lot_id: LOT_ID,
        location: 'BIN-A43',
        confidence: 'none',
        asserted_fact_id: '88888888-8888-4888-8888-888888888888',
        source_event_version: 1,
        updated_at: '2026-07-19T00:00:00.000Z',
      } satisfies CurrentLocation;
    },
    emitDisputeEvent: async (event) => {
      calls.push(`dispute:${event.payload['asserted_location']}:${event.payload['expected_location']}`);
    },
  };
}

describe('assertLocationInvariant (Story 1.6, AD-15)', () => {
  it('passes non-inventory stream types through with no projection writes', async () => {
    const calls: string[] = [];
    await assertLocationInvariant(
      makeEnvelope({ stream_type: 'doa_registry_entry', event_type: 'doa_registry.entry_created', payload: {} }),
      makePersisted(),
      undefined,
      makeDeps(null, calls),
    );
    assert.deepStrictEqual(calls, []);
  });

  it('passes inventory events that are not location events through with no projection writes', async () => {
    const calls: string[] = [];
    await assertLocationInvariant(
      makeEnvelope({ event_type: 'stock.allocated', payload: { business_stream: 'production' } }),
      makePersisted(),
      undefined,
      makeDeps(null, calls),
    );
    assert.deepStrictEqual(calls, []);
  });

  it('records an asserted location as current without dispute when there is no expected fact', async () => {
    const calls: string[] = [];
    await assertLocationInvariant(makeEnvelope(), makePersisted(), undefined, makeDeps(null, calls));
    assert.deepStrictEqual(calls, ['asserted', 'current']);
  });

  it('raises a location.disputed event when asserted differs from expected', async () => {
    const calls: string[] = [];
    await assertLocationInvariant(makeEnvelope(), makePersisted(), undefined, makeDeps(expectedFact('BIN-A47'), calls));
    assert.deepStrictEqual(calls, ['asserted', 'current', 'dispute:BIN-A43:BIN-A47']);
  });

  it('records expected facts without raising dispute', async () => {
    const calls: string[] = [];
    const envelope = makeEnvelope({ event_type: 'location.expected', payload: { business_stream: 'production', lot_id: LOT_ID, expected_location: 'BIN-A47', source: 'seed' } });
    await assertLocationInvariant(envelope, makePersisted(envelope), undefined, makeDeps(null, calls));
    assert.deepStrictEqual(calls, ['expected']);
  });

  it('rejects malformed location.asserted payloads with INVALID_PARAMS', async () => {
    await assert.rejects(
      () => assertLocationInvariant(makeEnvelope({ payload: { business_stream: 'production', lot_id: LOT_ID } }), makePersisted(), undefined, makeDeps(null, [])),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.strictEqual(err.errorCode, 'INVALID_PARAMS');
        return true;
      },
    );
  });
});
