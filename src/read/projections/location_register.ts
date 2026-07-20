import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

/**
 * Location register read model (Story 2.1) - warehouse topology master data, separate from the
 * Story 1.6 event-sourced lot-location projection. location_id is the internal UUID (and the
 * location_register event stream_id); location_code is the unique human-readable identifier
 * (e.g. BIN-A43). site_id is the root site's location_id; a site row references itself, so the
 * caller generates location_id before insert.
 */

export const LOCATION_LEVELS = ['site', 'zone', 'aisle', 'rack', 'bin'] as const;
export type LocationLevel = (typeof LOCATION_LEVELS)[number];

export const ZONE_TYPES = ['general', 'hazmat', 'quarantine', 'staging'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const TEMPERATURE_CLASSES = ['ambient', 'cold', 'frozen'] as const;
export type TemperatureClass = (typeof TEMPERATURE_CLASSES)[number];

export const LOCATION_STATUSES = ['active', 'inactive'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export interface LocationRegisterEntry {
  location_id: string;
  location_code: string;
  level: LocationLevel;
  parent_location_id: string | null;
  site_id: string;
  zone_type: ZoneType;
  temperature_class: TemperatureClass;
  hazmat_allowed: boolean;
  quarantine: boolean;
  status: LocationStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateLocationInput {
  location_id: string;
  location_code: string;
  level: LocationLevel;
  parent_location_id?: string | null;
  site_id?: string;
  zone_type: ZoneType;
  temperature_class: TemperatureClass;
  hazmat_allowed: boolean;
  quarantine: boolean;
  status: LocationStatus;
}

export interface UpdateLocationPatch {
  zone_type?: ZoneType;
  temperature_class?: TemperatureClass;
  hazmat_allowed?: boolean;
  quarantine?: boolean;
  status?: LocationStatus;
}

type Queryable = Pick<PoolClient, 'query'>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const LOCATION_COLUMNS = `location_id, location_code, level, parent_location_id, site_id, zone_type,
       temperature_class, hazmat_allowed, quarantine, status, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): LocationRegisterEntry {
  const createdAt = row['created_at'] instanceof Date ? row['created_at'].toISOString() : String(row['created_at']);
  const updatedAt = row['updated_at'] instanceof Date ? row['updated_at'].toISOString() : String(row['updated_at']);
  return {
    location_id: row['location_id'] as string,
    location_code: row['location_code'] as string,
    level: row['level'] as LocationLevel,
    parent_location_id: (row['parent_location_id'] as string | null) ?? null,
    site_id: row['site_id'] as string,
    zone_type: row['zone_type'] as ZoneType,
    temperature_class: row['temperature_class'] as TemperatureClass,
    hazmat_allowed: row['hazmat_allowed'] as boolean,
    quarantine: row['quarantine'] as boolean,
    status: row['status'] as LocationStatus,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export async function resolveLocationHierarchy(
  input: Pick<CreateLocationInput, 'location_id' | 'level' | 'parent_location_id'>,
  client?: PoolClient,
): Promise<{ parent_location_id: string | null; site_id: string }> {
  if (input.level === 'site') {
    if (input.parent_location_id !== undefined && input.parent_location_id !== null) {
      throw new AppError(400, 'INVALID_HIERARCHY', 'A site is a hierarchy root and must not have parent_location_id');
    }
    return { parent_location_id: null, site_id: input.location_id };
  }

  if (typeof input.parent_location_id !== 'string' || !UUID_REGEX.test(input.parent_location_id)) {
    throw new AppError(400, 'INVALID_PARAMS', `parent_location_id is required for level "${input.level}" and must be a valid UUID`);
  }

  const parent = await getLocationById(input.parent_location_id, client);
  if (!parent) {
    throw new AppError(404, 'PARENT_LOCATION_NOT_FOUND', `No location register record exists for parent_location_id "${input.parent_location_id}"`, {
      parent_location_id: input.parent_location_id,
    });
  }
  if (parent.status !== 'active') {
    throw new AppError(400, 'INACTIVE_LOCATION', 'parent_location_id references an inactive location', {
      parent_location_id: input.parent_location_id,
    });
  }
  const expectedParentLevel = LOCATION_LEVELS[LOCATION_LEVELS.indexOf(input.level) - 1]!;
  if (parent.level !== expectedParentLevel) {
    throw new AppError(400, 'INVALID_HIERARCHY', `A "${input.level}" must have a "${expectedParentLevel}" parent, not "${parent.level}"`, {
      level: input.level,
      expected_parent_level: expectedParentLevel,
      actual_parent_level: parent.level,
    });
  }

  return { parent_location_id: parent.location_id, site_id: parent.site_id };
}

/** Inserts a location row and returns it. Participates in `client`'s transaction when given. */
export async function createLocation(input: CreateLocationInput, client?: PoolClient): Promise<LocationRegisterEntry> {
  const hierarchy = await resolveLocationHierarchy(input, client);
  const result = await runner(client).query(
    `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
        hazmat_allowed, quarantine, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${LOCATION_COLUMNS}`,
    [
      input.location_id,
      input.location_code,
      input.level,
      hierarchy.parent_location_id,
      hierarchy.site_id,
      input.zone_type,
      input.temperature_class,
      input.hazmat_allowed,
      input.quarantine,
      input.status,
    ],
  );
  return mapRow(result.rows[0]!);
}

/** Applies a partial update by location_id and returns the updated row, or null when unknown. */
export async function updateLocation(
  locationId: string,
  patch: UpdateLocationPatch,
  client?: PoolClient,
): Promise<LocationRegisterEntry | null> {
  const sets: string[] = [];
  const values: unknown[] = [locationId];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.zone_type !== undefined) push('zone_type', patch.zone_type);
  if (patch.temperature_class !== undefined) push('temperature_class', patch.temperature_class);
  if (patch.hazmat_allowed !== undefined) push('hazmat_allowed', patch.hazmat_allowed);
  if (patch.quarantine !== undefined) push('quarantine', patch.quarantine);
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return getLocationById(locationId, client);

  const result = await runner(client).query(
    `UPDATE location_register SET ${sets.join(', ')}, updated_at = now() WHERE location_id = $1 RETURNING ${LOCATION_COLUMNS}`,
    values,
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getLocationById(locationId: string, client?: PoolClient): Promise<LocationRegisterEntry | null> {
  const result = await runner(client).query(`SELECT ${LOCATION_COLUMNS} FROM location_register WHERE location_id = $1`, [locationId]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

export async function getLocationByCode(locationCode: string, client?: PoolClient): Promise<LocationRegisterEntry | null> {
  const result = await runner(client).query(`SELECT ${LOCATION_COLUMNS} FROM location_register WHERE location_code = $1`, [locationCode]);
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/** Existence probe used by the central inventory-master validation seam. */
export async function locationExistsById(locationId: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM location_register WHERE location_id = $1 LIMIT 1`, [locationId]);
  return result.rows.length > 0;
}

/**
 * Zone/temperature compatibility check between an item's handling attributes and a target
 * location's register attributes. Returns the list of incompatibility reasons - empty means
 * compatible. AD note: this is a WARNING vocabulary (ZONE_INCOMPATIBLE is non-blocking), so the
 * reasons are stable strings the UI can translate into actionable copy.
 */
export interface ZoneCompatibilityItem {
  hazmat: boolean;
  quarantine_required: boolean;
}

export function zoneIncompatibilityReasons(item: ZoneCompatibilityItem, location: LocationRegisterEntry): string[] {
  const reasons: string[] = [];
  if (item.hazmat && !location.hazmat_allowed) reasons.push('hazmat_item_in_non_hazmat_location');
  if (!item.hazmat && location.zone_type === 'hazmat') reasons.push('non_hazmat_item_in_hazmat_zone');
  if (item.quarantine_required && !location.quarantine) reasons.push('quarantine_item_in_non_quarantine_location');
  return reasons;
}
