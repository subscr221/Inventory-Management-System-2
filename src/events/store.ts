import { randomUUID } from 'node:crypto';
import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import type { PoolClient } from 'pg';
import { logAuditEntry } from '../read/projections/audit_log.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { isAuditTamperError, recordTamperAttempt } from '../middleware/audit-tamper-guard.js';
import { assertInventoryTagging } from '../compliance/business-stream.js';
import { assertCalibrationLockout } from '../compliance/calibration.js';
import { assertLocationInvariant } from '../compliance/location.js';
import { assertInventoryMasterReferences } from '../compliance/inventory-master.js';
import { assertStockBalanceShape, applyStockBalanceProjection } from '../compliance/stock-balance.js';
import { assertLotSerialShape, applyLotSerialValidation } from '../compliance/lot-serial-validation.js';
import { assertValuationShape, applyInventoryValuationProjection } from '../compliance/inventory-valuation.js';
import {
  assertTransferRequestShape,
  assertTransferShipShape,
  assertTransferReceiveShape,
  applyTransferRequestProjection,
  applyTransferShipProjection,
  applyTransferReceiveProjection,
} from '../compliance/transfer-request.js';
import { assertCycleCountShape, applyCycleCountProjection } from '../compliance/cycle-count.js';
import { assertInventoryPlanningShape, applyInventoryPlanningProjection } from '../compliance/inventory-planning.js';
import { assertOwnershipShape, applyOwnershipProjection } from '../compliance/ownership.js';
import { assertGateEnteredShape, assertGateReversedShape, applyGateProjection } from '../compliance/gate.js';
import { assertWeighbridgeRecordedShape, applyWeighbridgeProjection } from '../compliance/weighbridge.js';
import {
  assertGoodsReceivedShape,
  assertGoodsPutawayReleasedShape,
  applyGoodsReceivedProjection,
  applyGoodsPutawayReleasedProjection,
} from '../compliance/receiving.js';
import { assertErpReadOnly } from '../compliance/erp-readonly.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface EventEnvelope {
  event_id?: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  event_version?: number;
  payload: Record<string, unknown>;
  metadata: {
    correlation_id: string;
    causation_id?: string | null;
    actor: {
      user_id: string;
      role: string;
      location_id: string;
    };
    device_id?: string | null;
    capture_method?: 'AUTO' | 'MANUAL';
    occurred_at: string;
    synced_at?: string | null;
  };
  schema_version?: number;
  idempotency_key?: string | null;
}

export interface PersistedEvent extends EventEnvelope {
  event_id: string;
  event_version: number;
  schema_version: number;
  created_at: string;
}

export function validateEnvelope(body: unknown): asserts body is EventEnvelope {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'Request body must be a JSON object');
  }

  const obj = body as Record<string, unknown>;

  if (obj['event_id'] !== undefined && !isUuid(obj['event_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_id must be a valid UUID');
  }

  if (!isNonEmptyString(obj['stream_type'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'stream_type is required and must be a non-empty string');
  }

  if (!isUuid(obj['stream_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'stream_id is required and must be a valid UUID');
  }

  if (!isNonEmptyString(obj['event_type'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_type is required and must be a non-empty string');
  }

  if (obj['event_version'] !== undefined && (!Number.isInteger(obj['event_version']) || (obj['event_version'] as number) <= 0)) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'event_version must be a positive integer');
  }

  if (obj['schema_version'] !== undefined && (!Number.isInteger(obj['schema_version']) || (obj['schema_version'] as number) <= 0)) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'schema_version must be a positive integer');
  }

  if (obj['idempotency_key'] !== undefined && obj['idempotency_key'] !== null && typeof obj['idempotency_key'] !== 'string') {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'idempotency_key must be a string or null');
  }

  if (typeof obj['payload'] !== 'object' || obj['payload'] === null || Array.isArray(obj['payload'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'payload is required and must be a JSON object');
  }

  if (typeof obj['metadata'] !== 'object' || obj['metadata'] === null || Array.isArray(obj['metadata'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata is required and must be a JSON object');
  }

  const meta = obj['metadata'] as Record<string, unknown>;

  if (!isUuid(meta['correlation_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.correlation_id is required and must be a valid UUID');
  }

  if (typeof meta['actor'] !== 'object' || meta['actor'] === null || Array.isArray(meta['actor'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor is required and must be an object');
  }

  const actor = meta['actor'] as Record<string, unknown>;
  if (!isUuid(actor['user_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.user_id is required and must be a valid UUID');
  }
  if (!isNonEmptyString(actor['role'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.role is required and must be a non-empty string');
  }
  if (!isUuid(actor['location_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.actor.location_id is required and must be a valid UUID');
  }

  const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (typeof meta['occurred_at'] !== 'string' || !ISO8601_REGEX.test(meta['occurred_at'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.occurred_at is required and must be a valid ISO-8601 timestamp');
  }

  if (meta['causation_id'] !== undefined && meta['causation_id'] !== null && !isUuid(meta['causation_id'])) {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.causation_id must be a valid UUID or null');
  }

  if (meta['capture_method'] !== undefined && meta['capture_method'] !== 'AUTO' && meta['capture_method'] !== 'MANUAL') {
    throw new AppError(400, 'INVALID_EVENT_ENVELOPE', 'metadata.capture_method must be AUTO or MANUAL');
  }
}

function mapRowToEvent(row: Record<string, unknown>): PersistedEvent {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  return {
    event_id: row['event_id'] as string,
    stream_type: row['stream_type'] as string,
    stream_id: row['stream_id'] as string,
    event_type: row['event_type'] as string,
    event_version: row['event_version'] as number,
    payload: row['payload'] as Record<string, unknown>,
    metadata: row['metadata'] as PersistedEvent['metadata'],
    schema_version: row['schema_version'] as number,
    idempotency_key: row['idempotency_key'] as string | null,
    created_at: createdAt,
  };
}

export async function persistEvent(
  envelope: EventEnvelope,
  auditCtx?: Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>,
  externalClient?: PoolClient,
): Promise<PersistedEvent> {
  // FR-AC-01 (Story 1.5): business-stream tagging is enforced HERE, on the central write path,
  // not in the HTTP handler - so the public POST /api/v1/events, the Story 1.8 edge sync
  // replication, and any future internal adapter are all gated by construction. The check runs
  // BEFORE any DB write (and before the transaction below), so an untagged inventory movement is
  // rejected without consuming an idempotency key or touching domain_events. Non-inventory
  // stream types (DOA registry, SCIM users, audit, tagging config itself) return immediately
  // inside assertInventoryTagging - byte-for-byte unaffected.
  await assertInventoryTagging(envelope);
  await assertCalibrationLockout(envelope);
  // Story 2.1: inventory master validation (SKU existence, target-location existence, actor
  // location registration, zone compatibility) also runs BEFORE any DB write, gated to inventory
  // events that actually reference master fields. May throw ZoneIncompatibleWarning (not an
  // AppError) - the movement HTTP handlers translate it into a 200 warning envelope.
  await assertInventoryMasterReferences(envelope);
  // Story 2.2: stock-balance shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed stock event never consumes an idempotency key. The balance itself is
  // applied inside the transaction below.
  assertStockBalanceShape(envelope);
  // Story 2.3: lot/serial shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed lot/serial event never consumes an idempotency key.
  assertLotSerialShape(envelope);
// Story 2.4: valuation shape validation (NRV write-down/recovery/standard-cost-variance payload
  // fields) is non-DB and runs with the other pre-transaction asserts, so a malformed valuation
  // event never consumes an idempotency key. stock.received/stock.issued unit_cost shape is
  // already covered by assertStockBalanceShape above.
  assertValuationShape(envelope);
  // Story 2.5: transfer-request shape validation is non-DB and runs with the other pre-transaction
  // asserts, so a malformed transfer-request event never consumes an idempotency key.
  assertTransferRequestShape(envelope);
  assertTransferShipShape(envelope);
  assertTransferReceiveShape(envelope);
  // Story 2.6: cycle-count / physical-verification shape validation is non-DB and runs with the
  // other pre-transaction asserts, so a malformed count event never consumes an idempotency key.
  assertCycleCountShape(envelope);
  // Story 2.7: inventory-planning shape validation (params, safety-stock computation, replenishment
  // recommendation, obsolescence flag/clear) is non-DB and runs with the other pre-transaction
  // asserts, so a malformed planning event never consumes an idempotency key.
  assertInventoryPlanningShape(envelope);
  // Story 2.8: ownership-agreement shape validation (consignment/VMI segregation config) is non-DB
  // and runs with the other pre-transaction asserts, so a malformed agreement event never consumes
  // an idempotency key. The consignment/vmi receipt owner-party gate runs in-transaction inside
  // applyStockBalanceProjection.
  assertOwnershipShape(envelope);
  assertGateEnteredShape(envelope);
  assertGateReversedShape(envelope);
  // Story 3.3: weighbridge shape validation (tare/gross/binding-token presence, net = gross - tare
  // computed in exact integer milli-kg) is non-DB and runs with the other pre-transaction asserts,
  // so a malformed weighment never consumes an idempotency key.
  assertWeighbridgeRecordedShape(envelope);
  // Story 3.4: goods-receiving shape validation (binding-token/PO/qty presence, expiry-date shape,
  // quarantine-reason presence) is non-DB and runs with the other pre-transaction asserts, so a
  // malformed receiving event never consumes an idempotency key.
  assertGoodsReceivedShape(envelope);
  assertGoodsPutawayReleasedShape(envelope);
  // Story 2.9: ERP reference projections are read-only to the platform (INT-ERP-01). Reject any
  // `erp` stream_type or `erp.*` event_type here, on the central write path, so a direct event POST
  // or an edge upload cannot fabricate ERP reference rows. Narrowly gated - every existing stream
  // passes through byte-for-byte and the Story 1.9 spine gate stays green.
  assertErpReadOnly(envelope);

  const pool = getPool();
  const eventId = envelope.event_id ?? randomUUID();
  const syncedAt = new Date().toISOString();

  const metadata = {
    ...envelope.metadata,
    synced_at: syncedAt,
  };

  // When the caller supplies a transaction client, this write joins the caller's transaction so the
  // caller's own row (e.g. a DOA registry entry - Story 1.4) and this domain event + audit entry
  // commit atomically. Otherwise persistEvent owns a fresh connection with its own BEGIN/COMMIT,
  // exactly as before - fully backward compatible with every existing caller.
  const ownsTransaction = externalClient === undefined;
  const client: PoolClient = externalClient ?? (await pool.connect());
  try {
    if (ownsTransaction) await client.query('BEGIN');

    await applyLotSerialValidation(envelope, client, eventId);
    await applyStockBalanceProjection(envelope, client);
    // Story 2.4: valuation runs AFTER lot/serial resolution (so an auto-selected lot/effective
    // serial set is settled) and stock-balance validation (so an insufficient-stock rejection
    // rolls back before valuation ever mutates), but still inside this same transaction and
    // BEFORE the domain_events insert below - a rejected write-down/recovery therefore writes no
    // event row and consumes no idempotency key (Dev Notes: Valuation Design Guardrails).
    await applyInventoryValuationProjection(envelope, client, eventId);
// Story 2.5: transfer-request, ship, and receive enforcement run inside the
      // same transaction as the domain_events insert so that allocation and event commit atomically.
      await applyTransferRequestProjection(envelope, client);
      await applyTransferShipProjection(envelope, client, eventId);
      await applyTransferReceiveProjection(envelope, client);
      // Story 2.6: cycle-count variance computation, DOA-gated adjustment lifecycle, approved
      // stock adjustments, and physical-verification evidence run inside this same transaction so
      // the projection and the domain_events insert commit or roll back together. The AC2 guard
      // (stock.adjusted requires an approved adjustment) lives in applyCycleCountProjection.
      await applyCycleCountProjection(envelope, client, eventId);
      // Story 2.7: inventory-planning params, safety-stock/reorder-point computation, replenishment
      // recommendation, and obsolescence flag/clear run inside this same transaction so the
      // projection and the domain_events insert commit or roll back together. The reorder-crossing
      // and obsolescence-transition decisions (and their transactional planner alerts) live in the
      // planning jobs, which hold the params/flag row lock across read -> decide -> persist.
      await applyInventoryPlanningProjection(envelope, client, eventId);
      // Story 2.8: ownership agreement upsert (consignment/VMI segregation config) runs inside this
      // same transaction so the registry row and the domain_events insert commit or roll back
      // together. Receipt-side owner-party enforcement lives in applyStockBalanceProjection above.
      await applyOwnershipProjection(envelope, client);
      await applyGateProjection(envelope, client, eventId);
      // Story 3.3: weighbridge tolerance enforcement resolves the binding token to its gate event,
      // enforces the site match, computes the tolerance band against the Story 2.9 open-PO line in
      // SQL NUMERIC, and upserts the weighbridge_event row inside this same transaction.
      await applyWeighbridgeProjection(envelope, client, eventId);
      // Story 3.4: goods receiving consumes the accepted-weighment binding token, computes the PO
      // tolerance band in SQL NUMERIC, routes QC-hold/quarantine/over-tolerance outcomes, and posts
      // stock through a synthetic stock.received view - all inside this same transaction so the GRN
      // line, the stock movement, and the domain_events insert commit or roll back together.
      await applyGoodsReceivedProjection(envelope, client, eventId);
      await applyGoodsPutawayReleasedProjection(envelope, client, eventId);

    let nextVersion: number;
    if (envelope.event_version !== undefined) {
      nextVersion = envelope.event_version;
    } else {
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(event_version), 0) + 1 AS next_version FROM domain_events WHERE stream_id = $1`,
        [envelope.stream_id],
      );
      nextVersion = versionResult.rows[0]!['next_version'] as number;
    }

    const result = await client.query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at`,
      [
        eventId,
        envelope.stream_type,
        envelope.stream_id,
        envelope.event_type,
        nextVersion,
        envelope.payload,
        metadata,
        envelope.schema_version ?? 1,
        envelope.idempotency_key ?? null,
      ],
    );

    const persisted = mapRowToEvent(result.rows[0]!);

    await assertLocationInvariant(envelope, persisted, client);

    if (auditCtx) {
      // http_status comes from the caller (201 for POST-created resources, 200 for PUT/PATCH
      // flows) so the statutory row records the status the client actually received.
      await logAuditEntry(client, {
        ...auditCtx,
        event_id: eventId,
        error_code: null,
      });
    }

    if (ownsTransaction) await client.query('COMMIT');
    return persisted;
  } catch (err: unknown) {
    if (ownsTransaction) await client.query('ROLLBACK');
    // Defense-in-depth: the audit write here is an INSERT, which the tamper trigger (BEFORE
    // UPDATE/DELETE/TRUNCATE) does not fire on - so this is normally unreachable. But if the trigger
    // ever rejects a write on this path, record the attempt on a fresh connection (the transaction
    // client is aborted) rather than letting it surface as a bare 500 with no tamper record.
    if (isAuditTamperError(err)) {
      await recordTamperAttempt({
        user_id: auditCtx?.user_id ?? null,
        role: auditCtx?.role ?? null,
        location_id: auditCtx?.location_id ?? null,
        endpoint: auditCtx?.endpoint ?? null,
        method: auditCtx?.method ?? null,
        error_code: 'AUDIT_LOG_TAMPER_ATTEMPT',
        details: { reason: 'Audit-log tamper trigger fired during event persistence' },
      }).catch(() => {
        // Never let the tamper-recording failure mask the original error.
      });
      throw new AppError(500, 'AUDIT_LOG_TAMPER_ATTEMPT', 'Audit log modification was rejected by the database');
    }
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505' && 'constraint' in err) {
      // Postgres exposes the violated constraint name via err.constraint, not err.detail
      // (err.detail only contains the conflicting key/value, e.g. "Key (idempotency_key)=(...) already exists.").
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'uq_idempotency' || constraint === 'domain_events_pkey') {
        let existingEventId: string = 'unknown';
        if (ownsTransaction) {
          const existing = await client.query(
            `SELECT event_id FROM domain_events WHERE idempotency_key = $1 OR event_id = $2 LIMIT 1`,
            [envelope.idempotency_key, eventId],
          );
          existingEventId = existing.rows.length > 0 ? (existing.rows[0]!['event_id'] as string) : 'unknown';
        }
        throw new AppError(409, 'DUPLICATE_EVENT', 'Event already exists', {
          existing_event_id: existingEventId,
        });
      } else if (constraint === 'uq_stream_version') {
        throw new AppError(409, 'STREAM_CONFLICT', 'Event version conflict in stream', {
          stream_id: envelope.stream_id,
          event_version: envelope.event_version,
        });
      } else if (constraint === 'uq_lot_master_lot_number') {
        throw new AppError(400, 'DUPLICATE_LOT', 'Lot already exists', {
          lot_id: typeof envelope.payload['lot_id'] === 'string' ? envelope.payload['lot_id'] : null,
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
        });
      } else if (constraint === 'uq_serial_master_sku_serial_number') {
        throw new AppError(400, 'DUPLICATE_SERIAL', 'Serial number already exists for this SKU', {
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
        });
      } else if (constraint === 'uq_ownership_agreement_active') {
        throw new AppError(409, 'OWNERSHIP_AGREEMENT_CONFLICT', 'An active ownership agreement already exists for this sku/location/stock_class grain', {
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
          location_id: typeof envelope.payload['location_id'] === 'string' ? envelope.payload['location_id'] : null,
          stock_class: typeof envelope.payload['stock_class'] === 'string' ? envelope.payload['stock_class'] : null,
        });
      } else if (constraint === 'uq_replenishment_recommendation_open_signal') {
        throw new AppError(409, 'REPLENISHMENT_RECOMMENDATION_CONFLICT', 'An open replenishment recommendation already exists for this sku/location/signal_type grain', {
          sku: typeof envelope.payload['sku'] === 'string' ? envelope.payload['sku'] : null,
          location_id: typeof envelope.payload['location_id'] === 'string' ? envelope.payload['location_id'] : null,
          signal_type: typeof envelope.payload['signal_type'] === 'string' ? envelope.payload['signal_type'] : 'internal',
        });
      }
    }
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

export async function readStream(
  streamType: string,
  streamId: string,
): Promise<PersistedEvent[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key, created_at
     FROM domain_events
     WHERE stream_type = $1 AND stream_id = $2
     ORDER BY event_version ASC`,
    [streamType, streamId],
  );

  return result.rows.map(mapRowToEvent);
}
