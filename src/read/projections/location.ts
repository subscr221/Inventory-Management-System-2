import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Event-sourced location projection (Story 1.6, AD-15). The current location of a lot is a
 * PROJECTION built from location.* events, never a mutable domain-state column. Asserted facts
 * (where an operator says the stock is) are stored SEPARATELY from expected facts (where a plan
 * says it should be); neither overwrites the other, and a divergence is recorded as a
 * `location.disputed` event rather than a silent merge.
 *
 * Lot IDs are OPAQUE UUIDs in the Epic 1 spine scope. There is deliberately no foreign key to a
 * lot master (Epic 2 / Story 2.1 owns the lot register) and no location master FK (Story 2.1 owns
 * the location register). Do not add a mutable location column or a lot-master FK here.
 */

export interface AssertedLocationFact {
  fact_id: string;
  lot_id: string;
  asserted_location: string;
  recorded_by: string;
  device_id: string | null;
  recorded_at: string;
  confidence: string;
  source_event_id: string;
}

export interface ExpectedLocationFact {
  fact_id: string;
  lot_id: string;
  expected_location: string;
  source: string;
  source_event_id: string;
  recorded_at: string;
}

export interface CurrentLocation {
  lot_id: string;
  location: string | null;
  confidence: string;
  asserted_fact_id: string | null;
  updated_at: string;
}

export interface RecordAssertedInput {
  lot_id: string;
  asserted_location: string;
  recorded_by: string;
  device_id: string | null;
  confidence: string;
  source_event_id: string;
}

export interface RecordExpectedInput {
  lot_id: string;
  expected_location: string;
  source: string;
  source_event_id: string;
}

/**
 * A query runner is either the shared pool or a caller-owned transaction client. Location writes
 * always pass the transaction `client` from persistEvent so the fact rows, the current-location
 * projection, and the domain event commit atomically (AD-16: updated exactly once; NFR-DI-01).
 */
type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function mapAsserted(row: Record<string, unknown>): AssertedLocationFact {
  const recordedAt = row['recorded_at'] instanceof Date ? row['recorded_at'].toISOString() : String(row['recorded_at']);
  return {
    fact_id: row['fact_id'] as string,
    lot_id: row['lot_id'] as string,
    asserted_location: row['asserted_location'] as string,
    recorded_by: row['recorded_by'] as string,
    device_id: (row['device_id'] as string | null) ?? null,
    recorded_at: recordedAt,
    confidence: row['confidence'] as string,
    source_event_id: row['source_event_id'] as string,
  };
}

function mapExpected(row: Record<string, unknown>): ExpectedLocationFact {
  const recordedAt = row['recorded_at'] instanceof Date ? row['recorded_at'].toISOString() : String(row['recorded_at']);
  return {
    fact_id: row['fact_id'] as string,
    lot_id: row['lot_id'] as string,
    expected_location: row['expected_location'] as string,
    source: row['source'] as string,
    source_event_id: row['source_event_id'] as string,
    recorded_at: recordedAt,
  };
}

function mapCurrent(row: Record<string, unknown>): CurrentLocation {
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    lot_id: row['lot_id'] as string,
    location: (row['location'] as string | null) ?? null,
    confidence: row['confidence'] as string,
    asserted_fact_id: (row['asserted_fact_id'] as string | null) ?? null,
    updated_at: updatedAt,
  };
}

/** Returns the current expected-location fact for a lot, or null if none has been recorded. */
export async function getExpectedLocation(lotId: string, client?: PoolClient): Promise<ExpectedLocationFact | null> {
  const result = await runner(client).query(
    `SELECT fact_id, lot_id, expected_location, source, source_event_id, recorded_at
     FROM location_expected_facts WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapExpected(result.rows[0]!) : null;
}

/**
 * Returns the current-location projection for a lot. When no location event has ever been
 * received the row does not exist and the caller returns { location: null, confidence: 'none' }
 * (AC3) - no default location is invented here.
 */
export async function getCurrentLocation(lotId: string, client?: PoolClient): Promise<CurrentLocation | null> {
  const result = await runner(client).query(
    `SELECT lot_id, location, confidence, asserted_fact_id, updated_at
     FROM location_current WHERE lot_id = $1`,
    [lotId],
  );
  return result.rows.length > 0 ? mapCurrent(result.rows[0]!) : null;
}

/**
 * Upserts the single current asserted fact for a lot. A lot has at most one current asserted fact
 * (uq_location_asserted_lot); a new assertion updates it in place. This is NOT last-writer-wins of
 * a mutable domain column - every assertion is also an immutable `location.asserted` event in
 * domain_events, and a divergence from the expected fact raises `location.disputed`.
 */
export async function recordAssertedLocation(input: RecordAssertedInput, client?: PoolClient): Promise<AssertedLocationFact> {
  const result = await runner(client).query(
    `INSERT INTO location_asserted_facts (lot_id, asserted_location, recorded_by, device_id, confidence, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (lot_id) DO UPDATE SET
       asserted_location = EXCLUDED.asserted_location,
       recorded_by = EXCLUDED.recorded_by,
       device_id = EXCLUDED.device_id,
       confidence = EXCLUDED.confidence,
       source_event_id = EXCLUDED.source_event_id,
       recorded_at = now()
     RETURNING fact_id, lot_id, asserted_location, recorded_by, device_id, recorded_at, confidence, source_event_id`,
    [input.lot_id, input.asserted_location, input.recorded_by, input.device_id, input.confidence, input.source_event_id],
  );
  return mapAsserted(result.rows[0]!);
}

/**
 * Upserts the single current expected fact for a lot (uq_location_expected_lot). Production
 * expected facts arrive from Epic 3 ASN/putaway plans; in the Epic 1 spine they are seeded
 * synthetically via the seeding endpoint. Recording an expected fact never raises a dispute.
 */
export async function recordExpectedLocation(input: RecordExpectedInput, client?: PoolClient): Promise<ExpectedLocationFact> {
  const result = await runner(client).query(
    `INSERT INTO location_expected_facts (lot_id, expected_location, source, source_event_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lot_id) DO UPDATE SET
       expected_location = EXCLUDED.expected_location,
       source = EXCLUDED.source,
       source_event_id = EXCLUDED.source_event_id,
       recorded_at = now()
     RETURNING fact_id, lot_id, expected_location, source, source_event_id, recorded_at`,
    [input.lot_id, input.expected_location, input.source, input.source_event_id],
  );
  return mapExpected(result.rows[0]!);
}

/** Upserts the current-location projection for a lot from the latest asserted fact. */
export async function updateCurrentLocation(
  lotId: string,
  location: string,
  confidence: string,
  assertedFactId: string,
  client?: PoolClient,
): Promise<CurrentLocation> {
  const result = await runner(client).query(
    `INSERT INTO location_current (lot_id, location, confidence, asserted_fact_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (lot_id) DO UPDATE SET
       location = EXCLUDED.location,
       confidence = EXCLUDED.confidence,
       asserted_fact_id = EXCLUDED.asserted_fact_id,
       updated_at = now()
     RETURNING lot_id, location, confidence, asserted_fact_id, updated_at`,
    [lotId, location, confidence, assertedFactId],
  );
  return mapCurrent(result.rows[0]!);
}
