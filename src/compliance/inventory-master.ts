import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getItemBySku } from '../read/projections/item_master.js';
import type { ItemMaster } from '../read/projections/item_master.js';
import { getLocationById, getLocationByCode, locationExistsById, zoneIncompatibilityReasons } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';

/**
 * Single validation seam for inventory master references (Story 2.1): SKU existence, target
 * location existence, actor-location registration, and zone compatibility. Called from
 * persistEvent (the central write path) BEFORE any DB write, so the public POST /api/v1/events,
 * the Story 1.8 edge upload, and any future internal adapter are all gated by construction and a
 * rejected movement never consumes an idempotency key or touches domain_events.
 *
 * Gating is deliberately narrow (Task 3.3): only `inventory` stream events whose payload actually
 * references a master - `sku`, `target_location_id`, or `target_location_code`. DOA, SCIM, audit,
 * notification, business-stream config, item-master, location-register, and legacy inventory
 * shapes (Story 1.6 location.asserted/expected with opaque TEXT locations, spine stock.* events
 * without master refs) pass through untouched.
 */
const INVENTORY_MOVEMENT_STREAM_TYPES = new Set(['inventory']);

/**
 * Sentinel stamped into envelope actor.location_id when the acting user's authorizing assignment
 * is enterprise-wide ('*'). Mirrors src/api/v1/doa.ts.
 */
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * NOT an error (Task 3.6): thrown by the validator when a placement is zone-incompatible and the
 * caller has not yet confirmed it. HTTP handlers on the inventory movement paths catch this class
 * and translate it into a 200 success envelope carrying `warning_code: "ZONE_INCOMPATIBLE"` and
 * `confirmation_required: true` - the two-step confirmation command of Task 3.7. The event is NOT
 * persisted until the caller re-submits with `payload.placement_confirmed: true`.
 */
export class ZoneIncompatibleWarning extends Error {
  constructor(
    public readonly details: {
      sku: string;
      target_location_id: string;
      target_location_code: string;
      reasons: string[];
    },
  ) {
    super('Placement target is not zone-compatible with the item; confirmation is required before the movement is persisted');
    this.name = 'ZoneIncompatibleWarning';
  }
}

/** Warning envelope body sent by handlers that catch ZoneIncompatibleWarning. */
export function zoneWarningEnvelope(warning: ZoneIncompatibleWarning, traceId: string): Record<string, unknown> {
  return {
    warning_code: 'ZONE_INCOMPATIBLE',
    message:
      `Item "${warning.details.sku}" is not compatible with location ` +
      `"${warning.details.target_location_code}" (${warning.details.reasons.join(', ')}). ` +
      'The movement has NOT been recorded. To confirm this placement anyway, resubmit the same ' +
      'event with "placement_confirmed": true in the payload; otherwise choose a compatible location.',
    details: warning.details,
    confirmation_required: true,
    persisted: false,
    trace_id: traceId,
  };
}

/**
 * The DB-touching lookups, injectable so unit tests can exercise the branching logic without a
 * database. Production callers use the defaults (real projection functions).
 */
export interface InventoryMasterDeps {
  getItemBySku: (sku: string, client?: PoolClient) => Promise<ItemMaster | null>;
  getLocationById: (locationId: string, client?: PoolClient) => Promise<LocationRegisterEntry | null>;
  getLocationByCode: (locationCode: string, client?: PoolClient) => Promise<LocationRegisterEntry | null>;
  locationExistsById: (locationId: string, client?: PoolClient) => Promise<boolean>;
}

const defaultDeps: InventoryMasterDeps = {
  getItemBySku: (sku) => getItemBySku(sku),
  getLocationById: (locationId) => getLocationById(locationId),
  getLocationByCode: (locationCode) => getLocationByCode(locationCode),
  locationExistsById: (locationId) => locationExistsById(locationId),
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Enforcement order inside the gated branch:
 * 1. Unknown SKU rejects with 400 ITEM_NOT_FOUND (Task 3.4 / AC2).
 * 2. Unknown target location rejects with 400 LOCATION_NOT_FOUND, echoing the supplied
 *    identifier in details (Task 3.5).
 * 3. A site-scoped actor's location_id must exist in the register (Task 3.8 - closes the
 *    deferred Story 1.6 gap where wildcard users could stamp arbitrary locations). The
 *    zero-UUID sentinel (enterprise-wide actor) is exempt.
 * 4. Zone incompatibility raises ZoneIncompatibleWarning unless payload.placement_confirmed
 *    is true (Task 3.6 / AC3).
 */
export async function assertInventoryMasterReferences(
  envelope: EventEnvelope,
  deps: InventoryMasterDeps = defaultDeps,
): Promise<void> {
  if (!INVENTORY_MOVEMENT_STREAM_TYPES.has(envelope.stream_type)) return;

  const skuRaw = envelope.payload['sku'];
  const targetLocationIdRaw = envelope.payload['target_location_id'];
  const targetLocationCodeRaw = envelope.payload['target_location_code'];
  const referencesMasters = skuRaw !== undefined || targetLocationIdRaw !== undefined || targetLocationCodeRaw !== undefined;
  if (!referencesMasters) return;

  let item: ItemMaster | null = null;
  if (skuRaw !== undefined) {
    if (!isNonEmptyString(skuRaw)) {
      throw new AppError(400, 'ITEM_NOT_FOUND', 'sku must be a non-empty string when supplied', { sku: skuRaw ?? null });
    }
    item = await deps.getItemBySku(skuRaw);
    if (!item) {
      throw new AppError(400, 'ITEM_NOT_FOUND', `No item master record exists for sku "${skuRaw}"`, { sku: skuRaw });
    }
  }

  let location: LocationRegisterEntry | null = null;
  if (targetLocationIdRaw !== undefined) {
    if (!isNonEmptyString(targetLocationIdRaw) || !UUID_REGEX.test(targetLocationIdRaw)) {
      throw new AppError(400, 'LOCATION_NOT_FOUND', 'target_location_id must be a valid UUID when supplied', {
        target_location_id: targetLocationIdRaw ?? null,
      });
    }
    location = await deps.getLocationById(targetLocationIdRaw);
    if (!location) {
      throw new AppError(400, 'LOCATION_NOT_FOUND', `No location register record exists for target_location_id "${targetLocationIdRaw}"`, {
        target_location_id: targetLocationIdRaw,
      });
    }
  }
  if (targetLocationCodeRaw !== undefined) {
    if (!isNonEmptyString(targetLocationCodeRaw)) {
      throw new AppError(400, 'LOCATION_NOT_FOUND', 'target_location_code must be a non-empty string when supplied', {
        target_location_code: targetLocationCodeRaw ?? null,
      });
    }
    const byCode = await deps.getLocationByCode(targetLocationCodeRaw);
    if (!byCode) {
      throw new AppError(400, 'LOCATION_NOT_FOUND', `No location register record exists for target_location_code "${targetLocationCodeRaw}"`, {
        target_location_code: targetLocationCodeRaw,
      });
    }
    if (location && location.location_id !== byCode.location_id) {
      throw new AppError(400, 'INVALID_PARAMS', 'target_location_id and target_location_code reference different locations', {
        target_location_id: location.location_id,
        target_location_code: targetLocationCodeRaw,
      });
    }
    location = byCode;
  }

  const actorLocationId = envelope.metadata.actor.location_id;
  if (actorLocationId !== NO_LOCATION_UUID && !(await deps.locationExistsById(actorLocationId))) {
    throw new AppError(400, 'ACTOR_LOCATION_NOT_REGISTERED', 'The actor location is not a registered location', {
      actor_location_id: actorLocationId,
    });
  }

  if (item && location) {
    const reasons = zoneIncompatibilityReasons(item, location);
    if (reasons.length > 0 && envelope.payload['placement_confirmed'] !== true) {
      throw new ZoneIncompatibleWarning({
        sku: item.sku,
        target_location_id: location.location_id,
        target_location_code: location.location_code,
        reasons,
      });
    }
  }
}
