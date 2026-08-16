import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getAssetBySerial, getAssetByTag, insertAsset } from '../read/projections/asset.js';

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const ASSET_EVENT_TYPES = new Set(['asset.registered']);

const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assetEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!ASSET_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertAssetShape(envelope: EventEnvelope): void {
  const type = assetEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'asset.registered':
      assertAssetRegisteredShape(p);
      break;
  }
}

function assertAssetRegisteredShape(p: Record<string, unknown>): void {
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isNonEmptyString(p['asset_tag']))
    reject('INVALID_PARAMS', 'asset_tag is required and must be a non-empty string');
  if (!isNonEmptyString(p['asset_name']))
    reject('INVALID_PARAMS', 'asset_name is required and must be a non-empty string');
  if (
    !isNonEmptyString(p['criticality_class']) ||
    !CRITICALITY_CLASSES.has(p['criticality_class'] as string)
  ) {
    reject(
      'INVALID_PARAMS',
      'criticality_class is required and must be one of: critical, high, medium, low',
      { criticality_class: p['criticality_class'] },
    );
  }
  for (const field of ['serial_number', 'manufacturer', 'model', 'fixed_asset_ref']) {
    const value = p[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      reject('INVALID_PARAMS', `${field} must be a string when provided`, { [field]: value });
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyAssetProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = assetEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'asset.registered':
      await applyAssetRegistered(envelope, client);
      break;
  }
}

async function applyAssetRegistered(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();

  const serialNumber =
    typeof p['serial_number'] === 'string' && p['serial_number'].trim() !== ''
      ? p['serial_number'].trim()
      : null;

  // AC 3 duplicate detection BEFORE insert, under FOR UPDATE locks (the Story 4.1 TOCTOU
  // lesson). uq_asset_serial / uq_asset_tag are the constraint backstops for concurrent races.
  // Both keys are canonicalized to lower case (case-insensitive duplicates are one asset), and
  // the accessors compare lower(column) = lower($1) to match the partial unique indexes.
  if (serialNumber !== null) {
    const existingBySerial = await getAssetBySerial(serialNumber, client, true);
    if (existingBySerial) {
      reject(
        'DUPLICATE_ASSET',
        'An asset with this serial number is already registered',
        {
          serial_number: serialNumber,
          existing_asset_id: existingBySerial.asset_id,
        },
        409,
      );
    }
  }

  const assetTag = (p['asset_tag'] as string).trim();
  const existingByTag = await getAssetByTag(assetTag, client, true);
  if (existingByTag) {
    reject(
      'DUPLICATE_ASSET',
      'An asset with this asset tag is already registered',
      {
        asset_tag: assetTag,
        existing_asset_id: existingByTag.asset_id,
      },
      409,
    );
  }

  await insertAsset(
    {
      asset_id: p['asset_id'] as string,
      asset_tag: assetTag,
      asset_name: (p['asset_name'] as string).trim(),
      criticality_class: p['criticality_class'] as 'critical' | 'high' | 'medium' | 'low',
      serial_number: serialNumber,
      manufacturer:
        typeof p['manufacturer'] === 'string' && p['manufacturer'].trim() !== ''
          ? p['manufacturer'].trim()
          : null,
      model: typeof p['model'] === 'string' && p['model'].trim() !== '' ? p['model'].trim() : null,
      fixed_asset_ref:
        typeof p['fixed_asset_ref'] === 'string' && p['fixed_asset_ref'].trim() !== ''
          ? p['fixed_asset_ref']
          : null,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

/**
 * Concurrency fallback: when uq_asset_serial or uq_asset_tag rejects a concurrent second writer,
 * the caller (src/events/store.ts) has already rolled back its transaction, so this runs a fresh,
 * safe query against asset directly (never the generic domain_events lookup) and returns the SAME
 * detail shape as the seam's own pre-check (DUPLICATE_ASSET with existing_asset_id). Mirrors
 * resolveSupplierInvoiceDuplicateConflict.
 */
export async function resolveAssetDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const serialNumber =
    typeof payload['serial_number'] === 'string' && payload['serial_number'].trim() !== ''
      ? payload['serial_number'].trim()
      : null;
  const assetTag =
    typeof payload['asset_tag'] === 'string' && payload['asset_tag'].trim() !== ''
      ? payload['asset_tag'].trim()
      : null;
  const attempted: Record<string, unknown> = {
    asset_id: typeof payload['asset_id'] === 'string' ? payload['asset_id'] : null,
    asset_tag: assetTag,
    serial_number: serialNumber,
  };
  // The violated constraint implies the winner has committed, so the fresh lookup below normally
  // finds it. The attempted key is always reportable even if it cannot (the 4.7 resolver
  // convention): a 409 with an empty detail object would leave the loser unable to identify the
  // collision.
  if (serialNumber !== null) {
    const existing = await getAssetBySerial(serialNumber);
    if (existing) {
      return { serial_number: serialNumber, existing_asset_id: existing.asset_id };
    }
  }
  if (assetTag !== null) {
    const existing = await getAssetByTag(assetTag);
    if (existing) {
      return { asset_tag: assetTag, existing_asset_id: existing.asset_id };
    }
  }
  return attempted;
}
