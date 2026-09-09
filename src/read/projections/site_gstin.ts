import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';

/**
 * Site GSTIN registration (Story 11.5, Binding Decision 2): a DATED per-site registration, not a
 * column on location_register. `findSiteGstin` resolves the single row effective on an IST
 * business date passed in by the caller - never CURRENT_DATE or now()::date, which are UTC and
 * diverge from IST between 00:00 and 05:30 (the Story 5.3 defect class). Overlapping windows for
 * one site are refused at write time (409 GSTIN_CONFIG_OVERLAP), so two rows effective on one date
 * is a configuration corruption, not an ambiguous pick, and resolves as a 500 GSTIN_CONFIG_CONFLICT
 * (the TAGGING_CONFIG_CONFLICT shape) rather than silently choosing one.
 */

export interface SiteGstinRow {
  registration_id: string;
  site_id: string;
  gstin_ext: string;
  legal_name_ext: string | null;
  state_code_ext: string | null;
  effective_from: string;
  effective_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface InsertSiteGstinInput {
  site_id: string;
  gstin_ext: string;
  legal_name_ext?: string | null;
  state_code_ext?: string | null;
  effective_from: string;
  effective_to?: string | null;
  created_by: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

// node-postgres parses a DATE column into a JS Date at LOCAL midnight of the stored calendar day;
// toISOString() would shift the day in a non-UTC zone (the Story 1.4 doa_vacation_delegations
// bug), so read the local Y-M-D components instead.
export function dateColumnToString(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function dateOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : dateColumnToString(v);
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLUMNS = `registration_id, site_id, gstin_ext, legal_name_ext, state_code_ext,
       effective_from, effective_to, created_by, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): SiteGstinRow {
  return {
    registration_id: row['registration_id'] as string,
    site_id: row['site_id'] as string,
    gstin_ext: row['gstin_ext'] as string,
    legal_name_ext: (row['legal_name_ext'] as string | null) ?? null,
    state_code_ext: (row['state_code_ext'] as string | null) ?? null,
    effective_from: dateColumnToString(row['effective_from']),
    effective_to: dateOrNull(row['effective_to']),
    created_by: row['created_by'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

/**
 * Inserts a registration, refusing any window that overlaps an existing one for the same site
 * (409 GSTIN_CONFIG_OVERLAP). Two ranges overlap when a_from <= b_to AND b_from <= a_to, treating a
 * NULL end as +infinity (the business_stream_config findConflictingRule shape). Participates in the
 * caller's transaction when `client` is given.
 *
 * The overlap probe and the INSERT are serialized per site on pg_advisory_xact_lock keyed by the
 * site id (the transaction_tagging_rules idiom in src/api/v1/business-stream.ts). Without it two
 * concurrent inserts carrying DIFFERENT effective_from values both see a clean probe and both
 * commit - a state findSiteGstin then refuses as a 500 GSTIN_CONFIG_CONFLICT on every transfer
 * touching that site, with no DELETE grant to repair it. The lock is transaction-scoped, so pass
 * the caller's transactional `client` for it to bind; the DDL-level EXCLUDE constraint is the
 * backstop, this is what turns the race into a clean sequential 409.
 */
export async function insertSiteGstin(
  input: InsertSiteGstinInput,
  client?: PoolClient,
): Promise<SiteGstinRow> {
  const q = runner(client);
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`site_gstin:${input.site_id}`]);
  const overlap = await q.query(
    `SELECT ${COLUMNS} FROM site_gstin
      WHERE site_id = $1
        AND effective_from <= COALESCE($3::date, 'infinity'::date)
        AND ($2::date <= COALESCE(effective_to, 'infinity'::date))
      ORDER BY effective_from ASC, registration_id ASC
      LIMIT 1`,
    [input.site_id, input.effective_from, input.effective_to ?? null],
  );
  if (overlap.rows.length > 0) {
    const existing = mapRow(overlap.rows[0]!);
    throw new AppError(
      409,
      'GSTIN_CONFIG_OVERLAP',
      `Site ${input.site_id} already has a GSTIN registration effective over part of this window`,
      {
        site_id: input.site_id,
        existing_registration_id: existing.registration_id,
        existing_effective_from: existing.effective_from,
        existing_effective_to: existing.effective_to,
      },
    );
  }
  const result = await q.query(
    `INSERT INTO site_gstin
       (site_id, gstin_ext, legal_name_ext, state_code_ext, effective_from, effective_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.site_id,
      input.gstin_ext,
      input.legal_name_ext ?? null,
      input.state_code_ext ?? null,
      input.effective_from,
      input.effective_to ?? null,
      input.created_by,
    ],
  );
  return mapRow(result.rows[0]!);
}

/**
 * The single registration effective for `siteId` on `asOfDate` (YYYY-MM-DD, the IST business
 * date computed by the caller), or null when none is. More than one is a 500 GSTIN_CONFIG_CONFLICT.
 */
export async function findSiteGstin(
  siteId: string,
  asOfDate: string,
  client?: PoolClient,
): Promise<SiteGstinRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM site_gstin
      WHERE site_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [siteId, asOfDate],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length > 1) {
    throw new AppError(
      500,
      'GSTIN_CONFIG_CONFLICT',
      `More than one GSTIN registration is effective for site ${siteId} on ${asOfDate}`,
      {
        site_id: siteId,
        as_of_date: asOfDate,
        conflicting_registration_ids: result.rows.map((r) => r['registration_id'] as string),
      },
    );
  }
  return mapRow(result.rows[0]!);
}

/**
 * Story 11.5 code review Q10: site_gstin.site_id carries no FK - there is no site table, a site
 * "is" a level = 'site' location_register row by convention and the site_id column on
 * location_register is a bare UUID. The registration route still has to refuse a site id nothing
 * references, or a one-digit typo creates a permanently orphaned registration while the intended
 * site keeps failing SITE_GSTIN_MISSING at transfer create with nothing pointing at the cause. A
 * site id is "known" when at least one location_register row is IN it (site_id) or IS it
 * (location_id, the self-referencing site row).
 */
export async function siteExistsInLocationRegister(
  siteId: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(
    `SELECT 1 FROM location_register
      WHERE site_id = $1::uuid OR location_id = $1::uuid
      LIMIT 1`,
    [siteId],
  );
  return result.rows.length > 0;
}

/**
 * Closes an OPEN registration window by stamping `effective_to` (Story 11.5 code review E2-P).
 * Without this a wrong GSTIN is permanent: excl_site_gstin_window refuses any overlapping
 * correction, and app_user holds no DELETE grant.
 *
 * Only an open-ended window may be closed, and only to a date on or after its own effective_from.
 * The resulting range is therefore a strict subset of the range that was already committed, so the
 * UPDATE can neither collide with the EXCLUDE constraint nor invert the window. The
 * `effective_to IS NULL` predicate on the UPDATE makes the close atomic against a concurrent one.
 */
export async function closeSiteGstin(
  registrationId: string,
  siteId: string,
  effectiveTo: string,
  client?: PoolClient,
): Promise<SiteGstinRow> {
  const q = runner(client);
  const current = await q.query(
    `SELECT ${COLUMNS} FROM site_gstin WHERE registration_id = $1 AND site_id = $2`,
    [registrationId, siteId],
  );
  if (current.rows.length === 0) {
    throw new AppError(
      404,
      'GSTIN_REGISTRATION_NOT_FOUND',
      `No GSTIN registration ${registrationId} exists for site ${siteId}`,
      { registration_id: registrationId, site_id: siteId },
    );
  }
  const existing = mapRow(current.rows[0]!);
  if (existing.effective_to !== null) {
    throw new AppError(
      409,
      'GSTIN_REGISTRATION_ALREADY_CLOSED',
      `GSTIN registration ${registrationId} already ends on ${existing.effective_to}`,
      {
        registration_id: registrationId,
        site_id: siteId,
        existing_effective_to: existing.effective_to,
      },
    );
  }
  if (effectiveTo < existing.effective_from) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `effective_to ${effectiveTo} precedes the registration's effective_from ${existing.effective_from}`,
      {
        registration_id: registrationId,
        effective_to: effectiveTo,
        effective_from: existing.effective_from,
      },
    );
  }
  const result = await q.query(
    `UPDATE site_gstin SET effective_to = $2::date, updated_at = now()
      WHERE registration_id = $1 AND effective_to IS NULL
      RETURNING ${COLUMNS}`,
    [registrationId, effectiveTo],
  );
  if (result.rows.length === 0) {
    throw new AppError(
      409,
      'GSTIN_REGISTRATION_ALREADY_CLOSED',
      `GSTIN registration ${registrationId} was closed concurrently`,
      { registration_id: registrationId, site_id: siteId },
    );
  }
  return mapRow(result.rows[0]!);
}

/** Every registration for a site, oldest window first. */
export async function listSiteGstins(siteId: string, client?: PoolClient): Promise<SiteGstinRow[]> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM site_gstin WHERE site_id = $1
      ORDER BY effective_from ASC, registration_id ASC`,
    [siteId],
  );
  return result.rows.map(mapRow);
}
