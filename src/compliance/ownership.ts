import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getActiveAgreement, upsertAgreement } from '../read/projections/ownership_agreement.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationById } from '../read/projections/location_register.js';

/**
 * Central ownership compliance seam (Story 2.8). Split like every other seam:
 *
 * - assertOwnershipShape runs BEFORE any DB work, next to the other pre-transaction asserts, so a
 *   malformed ownership.agreement_set event is rejected without consuming an idempotency key.
 * - applyOwnershipProjection runs INSIDE the event transaction, BEFORE the domain_events insert,
 *   so a direct POST /api/v1/events or edge upload cannot bypass shape validation or projection
 *   application.
 * - assertConsignmentReceiptOwnership is the in-transaction owner-party gate for stock.received
 *   events carrying stock_class 'consignment' or 'vmi'; it is invoked from
 *   applyStockBalanceProjection (src/compliance/stock-balance.ts) so EVERY write path - HTTP
 *   handler, direct event POST, edge upload - validates the receipt against the active ownership
 *   agreement before any balance mutates.
 *
 * Gating is deliberately narrow (mirroring inventory-planning.ts): only `inventory` stream events
 * of the new ownership.agreement_set type reach this seam's projection, and only
 * consignment/vmi-classed receipts reach the receipt gate. Every older event shape passes through
 * byte-for-byte unaffected, so the Story 1.9 spine gate stays green. The customer-owned 'job_work'
 * class is Epic 9's flow and is intentionally NOT gated here.
 *
 * Owner-party codes are shape-validated here (trimmed, uppercase alphanumeric plus hyphen, 2-32
 * chars) and referentially anchored to the ownership_agreement registry; referential validation
 * against ERP inbound projections arrives with Story 2.9, and the governed supplier registry (Epic
 * 4, Story 4.1) supersedes these codes without renumbering them.
 */

const OWNERSHIP_STREAM_TYPES = new Set(['inventory']);
const OWNERSHIP_EVENT_TYPES = new Set(['ownership.agreement_set']);

/** Stock classes owned by an external supplier party and therefore agreement-gated (Story 2.8). */
export const SUPPLIER_OWNED_STOCK_CLASSES = new Set(['consignment', 'vmi']);

/** Matches chk_ownership_agreement_owner_party_code in read/projections/ownership_agreement.sql. */
export const OWNER_PARTY_CODE_REGEX = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

/** NUMERIC(14,3) ceiling required by the Story 2.8 agreement contract. */
const MAX_VMI_MIN_QTY = 99_999_999_999.999;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OWNERSHIP_CONFIG_ROLES = ['inventory_planner', 'demand_planner', 'inventory_controller'];

export const OWNERSHIP_ERROR_CODES = {
  OWNERSHIP_AGREEMENT_NOT_FOUND: 'OWNERSHIP_AGREEMENT_NOT_FOUND',
  OWNER_PARTY_MISMATCH: 'OWNER_PARTY_MISMATCH',
  VMI_MIN_NOT_CONFIGURED: 'VMI_MIN_NOT_CONFIGURED',
  INVALID_SIGNAL_TYPE: 'INVALID_SIGNAL_TYPE',
} as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return isNonEmptyString(value) && UUID_REGEX.test(value);
}

export function ownershipEventType(envelope: EventEnvelope): string | null {
  if (!OWNERSHIP_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!OWNERSHIP_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation
// ---------------------------------------------------------------------------

export function assertOwnershipShape(envelope: EventEnvelope): void {
  const type = ownershipEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['agreement_id'])) throw new AppError(400, 'INVALID_PARAMS', 'agreement_id is required and must be a UUID');
  if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
  if (!isUuid(p['location_id'])) throw new AppError(400, 'INVALID_PARAMS', 'location_id is required and must be a UUID');
  if (p['stock_class'] !== 'consignment' && p['stock_class'] !== 'vmi') {
    throw new AppError(400, 'INVALID_PARAMS', "stock_class must be 'consignment' or 'vmi' for an ownership agreement", {
      stock_class: p['stock_class'] ?? null,
    });
  }
  const ownerPartyCode = typeof p['owner_party_code'] === 'string' ? p['owner_party_code'].trim() : null;
  if (ownerPartyCode === null || !OWNER_PARTY_CODE_REGEX.test(ownerPartyCode)) {
    throw new AppError(400, 'INVALID_PARAMS', 'owner_party_code is required and must be 2-32 uppercase alphanumeric/hyphen characters', {
      owner_party_code: p['owner_party_code'] ?? null,
    });
  }
  p['owner_party_code'] = ownerPartyCode;
  if (p['vmi_min_qty'] !== undefined && p['vmi_min_qty'] !== null) {
    const min = p['vmi_min_qty'];
    if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0 || min > MAX_VMI_MIN_QTY || !Number.isInteger(min * 1000)) {
      throw new AppError(400, OWNERSHIP_ERROR_CODES.VMI_MIN_NOT_CONFIGURED, `vmi_min_qty must be a positive NUMERIC(14,3) value no greater than ${MAX_VMI_MIN_QTY}`, {
        vmi_min_qty: min,
      });
    }
    if (p['stock_class'] !== 'vmi') {
      throw new AppError(400, 'INVALID_PARAMS', 'vmi_min_qty applies only to vmi agreements');
    }
  }
  if (p['active'] !== undefined && typeof p['active'] !== 'boolean') {
    throw new AppError(400, 'INVALID_PARAMS', 'active must be a boolean when supplied');
  }
  if (p['set_by_actor_id'] !== undefined && !isUuid(p['set_by_actor_id'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'set_by_actor_id must be a UUID when supplied');
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyOwnershipProjection(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  const type = ownershipEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const item = await getItemBySku(p['sku'] as string, client);
  if (!item || item.status !== 'active') {
    throw new AppError(400, 'ITEM_NOT_FOUND', `No active item master record exists for sku "${p['sku'] as string}"`, { sku: p['sku'] as string });
  }
  const location = await getLocationById(p['location_id'] as string, client);
  if (!location || location.status !== 'active') {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'ownership agreement location does not exist or is inactive', { location_id: p['location_id'] as string });
  }
  const existing = await client.query(
    `SELECT vmi_min_qty, active FROM ownership_agreement WHERE agreement_id = $1`,
    [p['agreement_id'] as string],
  );
  const existingRow = existing.rows[0] as { vmi_min_qty: string | null; active: boolean } | undefined;
  const effectiveActive = p['active'] === undefined ? (existingRow?.active ?? true) : p['active'];
  const effectiveVmiMinQty = p['vmi_min_qty'] === undefined ? existingRow?.vmi_min_qty : p['vmi_min_qty'];
  if (p['stock_class'] === 'vmi' && effectiveActive !== false && (effectiveVmiMinQty === undefined || effectiveVmiMinQty === null)) {
    throw new AppError(400, OWNERSHIP_ERROR_CODES.VMI_MIN_NOT_CONFIGURED, 'vmi_min_qty is required for an active vmi ownership agreement', {
      sku: p['sku'] as string,
      location_id: p['location_id'] as string,
    });
  }
  await upsertAgreement(
    {
      agreement_id: p['agreement_id'] as string,
      sku: p['sku'] as string,
      location_id: p['location_id'] as string,
      stock_class: p['stock_class'] as string,
      owner_party_code: p['owner_party_code'] as string,
      ...(p['vmi_min_qty'] !== undefined ? { vmi_min_qty: p['vmi_min_qty'] as number | null } : {}),
      ...(p['active'] !== undefined ? { active: p['active'] as boolean } : {}),
      business_stream: p['business_stream'] as string,
      set_by_actor_id: (p['set_by_actor_id'] as string | undefined) ?? envelope.metadata.actor.user_id,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// In-transaction receipt gate (invoked from applyStockBalanceProjection)
// ---------------------------------------------------------------------------

/**
 * A stock.received carrying stock_class 'consignment' or 'vmi' must reference the single active
 * ownership agreement for its (sku, location, stock_class) grain: the payload's owner_party_code
 * must match the agreement's. Rejects with OWNERSHIP_AGREEMENT_NOT_FOUND (no active agreement) or
 * OWNER_PARTY_MISMATCH (code differs) BEFORE any balance mutation, so the event transaction rolls
 * back without consuming an idempotency key. The 'owned' and 'job_work' classes pass through
 * untouched (job_work custody is Epic 9's flow).
 */
export async function assertConsignmentReceiptOwnership(
  envelope: EventEnvelope,
  stockClass: string,
  sku: string,
  locationId: string,
  client: PoolClient,
): Promise<void> {
  if (!SUPPLIER_OWNED_STOCK_CLASSES.has(stockClass)) return;

  const ownerPartyCode = typeof envelope.payload['owner_party_code'] === 'string' ? envelope.payload['owner_party_code'].trim() : envelope.payload['owner_party_code'];
  if (typeof ownerPartyCode === 'string') envelope.payload['owner_party_code'] = ownerPartyCode;
  const agreement = await getActiveAgreement(sku, locationId, stockClass, client, true);
  if (!agreement) {
    throw new AppError(404, OWNERSHIP_ERROR_CODES.OWNERSHIP_AGREEMENT_NOT_FOUND, `No active ${stockClass} ownership agreement exists for sku "${sku}" at this location`, {
      sku,
      location_id: locationId,
      stock_class: stockClass,
    });
  }
  if (ownerPartyCode !== agreement.owner_party_code) {
    throw new AppError(409, OWNERSHIP_ERROR_CODES.OWNER_PARTY_MISMATCH, `owner_party_code does not match the active ${stockClass} agreement for sku "${sku}" at this location`, {
      sku,
      location_id: locationId,
      stock_class: stockClass,
      supplied_owner_party_code: typeof ownerPartyCode === 'string' ? ownerPartyCode : null,
    });
  }
}
