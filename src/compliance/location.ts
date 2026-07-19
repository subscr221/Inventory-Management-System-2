import type { PoolClient } from 'pg';
import type { EventEnvelope, PersistedEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  getExpectedLocation,
  recordExpectedLocation,
  recordAssertedLocation,
  updateCurrentLocation,
} from '../read/projections/location.js';
import type { AssertedLocationFact, ExpectedLocationFact, CurrentLocation } from '../read/projections/location.js';

/**
 * The set of stream_type values whose events carry stock-movement location data (AD-15). Events
 * on any other stream type pass through untouched - this keeps DOA, SCIM, audit, and
 * business-stream-config writes byte-for-byte unaffected. Within the inventory stream, only the
 * location.* event types trigger location logic; other inventory events (e.g. stock.allocated)
 * pass through. This mirrors the stream-type gating in src/compliance/business-stream.ts.
 *
 * NOTE for future adapter authors: enforcement lives in persistEvent (the central write path), so
 * ANY path that writes an inventory location.* event - the public POST /api/v1/events, the Story
 * 1.8 edge sync replication, or a future internal adapter - is gated by construction.
 */
const LOCATION_STREAM_TYPES = new Set(['inventory']);

const EVENT_ASSERTED = 'location.asserted';
const EVENT_EXPECTED = 'location.expected';
const EVENT_DISPUTED = 'location.disputed';

/**
 * The DB-touching operations, injectable so unit tests exercise the branching logic without a
 * database. Production callers use the default (real projection functions + the persistEvent
 * re-entry for the dispute event), bound to the caller's transaction client.
 */
export interface LocationDeps {
  getExpectedLocation: (lotId: string, client?: PoolClient) => Promise<ExpectedLocationFact | null>;
  recordExpectedLocation: (
    input: { lot_id: string; expected_location: string; source: string; source_event_id: string },
    client?: PoolClient,
  ) => Promise<ExpectedLocationFact>;
  recordAssertedLocation: (
    input: {
      lot_id: string;
      asserted_location: string;
      recorded_by: string;
      device_id: string | null;
      confidence: string;
      source_event_id: string;
    },
    client?: PoolClient,
  ) => Promise<AssertedLocationFact>;
  updateCurrentLocation: (
    lotId: string,
    location: string,
    confidence: string,
    assertedFactId: string,
    client?: PoolClient,
  ) => Promise<CurrentLocation>;
  emitDisputeEvent: (envelope: EventEnvelope, client?: PoolClient) => Promise<void>;
}

const defaultDeps: LocationDeps = {
  getExpectedLocation,
  recordExpectedLocation,
  recordAssertedLocation,
  updateCurrentLocation,
  emitDisputeEvent: async (envelope, client) => {
    // Dynamic import avoids a static circular dependency (store.ts imports this module). The
    // dispute event joins the SAME transaction as the triggering asserted event via `client`, so
    // the asserted fact, the current projection, and the dispute event commit together (AD-16:
    // exactly once; NFR-DI-01 atomicity). The dispute event carries no idempotency_key of its own.
    const { persistEvent } = await import('../events/store.js');
    await persistEvent(envelope, undefined, client);
  },
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Single enforcement point for AD-15 (event-sourced location with asserted/expected separation).
 * Called from persistEvent AFTER the triggering domain event is inserted, on the same transaction
 * client, so the projection writes and any dispute event commit atomically with it.
 *
 * A divergence between asserted and expected is NOT an HTTP rejection - AD-15 says "an exception,
 * not a silent overwrite", meaning a recorded `location.disputed` event. This function throws
 * AppError(400, 'INVALID_PARAMS') ONLY when a location.* payload is structurally malformed.
 */
export async function assertLocationInvariant(
  envelope: EventEnvelope,
  persisted: PersistedEvent,
  client?: PoolClient,
  deps: LocationDeps = defaultDeps,
): Promise<void> {
  if (!LOCATION_STREAM_TYPES.has(envelope.stream_type)) return;
  if (envelope.event_type !== EVENT_ASSERTED && envelope.event_type !== EVENT_EXPECTED) return;

  const lotId = envelope.payload['lot_id'];
  if (!isNonEmptyString(lotId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'location event payload is missing lot_id', { missing_field: 'lot_id' });
  }

  if (envelope.event_type === EVENT_EXPECTED) {
    const expectedLocation = envelope.payload['expected_location'];
    if (!isNonEmptyString(expectedLocation)) {
      throw new AppError(400, 'INVALID_PARAMS', 'location.expected payload is missing expected_location', {
        missing_field: 'expected_location',
      });
    }
    const source = isNonEmptyString(envelope.payload['source']) ? envelope.payload['source'] : 'unspecified';
    await deps.recordExpectedLocation(
      { lot_id: lotId, expected_location: expectedLocation, source, source_event_id: persisted.event_id },
      client,
    );
    return;
  }

  // EVENT_ASSERTED
  const assertedLocation = envelope.payload['asserted_location'];
  if (!isNonEmptyString(assertedLocation)) {
    throw new AppError(400, 'INVALID_PARAMS', 'location.asserted payload is missing asserted_location', {
      missing_field: 'asserted_location',
    });
  }
  const confidence = isNonEmptyString(envelope.payload['confidence']) ? envelope.payload['confidence'] : 'certain';
  const deviceId = isNonEmptyString(envelope.metadata.device_id) ? envelope.metadata.device_id : null;

  const asserted = await deps.recordAssertedLocation(
    {
      lot_id: lotId,
      asserted_location: assertedLocation,
      recorded_by: envelope.metadata.actor.user_id,
      device_id: deviceId,
      confidence,
      source_event_id: persisted.event_id,
    },
    client,
  );

  // The asserted location becomes the current location projection (AC1).
  await deps.updateCurrentLocation(lotId, assertedLocation, confidence, asserted.fact_id, client);

  // A divergence from the recorded expected fact raises a location.disputed event referencing both
  // facts with actor provenance. The expected fact is preserved - neither deleted nor overwritten.
  const expected = await deps.getExpectedLocation(lotId, client);
  if (expected && expected.expected_location !== assertedLocation) {
    const disputeEnvelope: EventEnvelope = {
      stream_type: envelope.stream_type,
      stream_id: envelope.stream_id,
      event_type: EVENT_DISPUTED,
      payload: {
        // business_stream is carried forward so the dispute event satisfies FR-AC-01 tagging on
        // the re-entrant persistEvent call (it is an inventory-stream event too).
        business_stream: envelope.payload['business_stream'],
        lot_id: lotId,
        asserted_location: assertedLocation,
        expected_location: expected.expected_location,
        actor: envelope.metadata.actor,
        reason: 'location_mismatch',
        confidence,
      },
      metadata: {
        correlation_id: envelope.metadata.correlation_id,
        causation_id: persisted.event_id,
        actor: envelope.metadata.actor,
        occurred_at: envelope.metadata.occurred_at,
      },
    };
    await deps.emitDisputeEvent(disputeEnvelope, client);
  }
}
