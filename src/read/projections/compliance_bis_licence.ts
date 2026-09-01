import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.6 accessor for the compliance_bis_licence projection (FR-Q-11, AC 1 and AC 2). The
 * table is the minimal enforcement contract for the BIS statutory release block (Binding Scope
 * Decision 1): Story 8.6 ships NO write routes and NO event types for it - fixtures seed rows
 * through the admin pool, app_user holds SELECT only, and Story 8.7 layers the register
 * governance (CRUD, approvals, expiry alerts) on top.
 *
 * findValidBisLicence implements Binding Scope Decisions 5 and 6: a row covers a release when
 * sku matches, the site scope admits the task's site (site_id NULL = all sites), and
 * valid_from <= asOf <= valid_to (asOf is the IST calendar date of the server-stamped release
 * time, never a client-supplied field).
 *
 * Story 8.7 code review: the site-specific-over-global ordering is a DELIBERATE PRECEDENCE RULE,
 * not an arbitrary tie-break, and it is load-bearing. BSD-3 claimed the overlap guard would leave
 * at most one row per scope and make this ordering unreachable; that is false. The overlap guard
 * compares scopes with COALESCE equality, so an all-sites licence and a site-specific licence for
 * the same sku may both exist with overlapping windows - a legitimate arrangement (a national CM/L
 * alongside a plant-specific R-number), which is why the guard was not tightened. The most
 * specific licence wins.
 *
 * The status column is NOT read here. Expiry is derived from the window, so a mis-dated sweep tick
 * cannot permanently block releases for a licence that is still valid (see the SQL header).
 */

export const BIS_LICENCE_TYPES = ['cml', 'r_number'] as const;
export type BisLicenceType = (typeof BIS_LICENCE_TYPES)[number];

export interface ComplianceBisLicenceRow {
  licence_id: string;
  licence_number: string;
  licence_type: BisLicenceType;
  sku: string;
  site_id: string | null;
  valid_from: string;
  valid_to: string;
  status: 'active' | 'expired';
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * A FOR UPDATE issued on a pool checkout commits immediately and releases the row lock the moment
 * the query returns - a lock that provably does nothing, with no error. Callers that ask for one
 * must supply the transaction client.
 */
function requireTransaction(client: PoolClient | undefined, fn: string): void {
  if (!client) {
    throw new Error(`${fn}: forUpdate requires a transaction client`);
  }
}

/** A literal, never an interpolated fragment - the locking clause is not built from input. */
const FOR_UPDATE = ' FOR UPDATE' as const;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export const COMPLIANCE_BIS_LICENCE_COLUMNS = `licence_id, licence_number, licence_type, sku,
    site_id, valid_from::text AS valid_from, valid_to::text AS valid_to, status, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): ComplianceBisLicenceRow {
  return {
    licence_id: row['licence_id'] as string,
    licence_number: row['licence_number'] as string,
    licence_type: row['licence_type'] as BisLicenceType,
    sku: row['sku'] as string,
    site_id: (row['site_id'] as string | null) ?? null,
    valid_from: String(row['valid_from']),
    valid_to: String(row['valid_to']),
    status: row['status'] as 'active' | 'expired',
    created_at: toIso(row['created_at']),
  };
}

/**
 * The best valid licence row covering (sku, siteId) as of the given IST calendar date, or null.
 * Site-specific rows win over global (site_id NULL) rows; among equals the latest valid_to wins
 * (the row that keeps the release covered longest is the most defensible register citation).
 */
export async function findValidBisLicence(
  sku: string,
  siteId: string,
  asOf: string,
  client?: PoolClient,
): Promise<ComplianceBisLicenceRow | null> {
  const result = await runner(client).query(
    `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS}
       FROM compliance_bis_licence
      WHERE sku = $1
        AND (site_id = $2 OR site_id IS NULL)
        AND valid_from <= $3::date
        AND valid_to >= $3::date
      ORDER BY (site_id IS NOT NULL) DESC, valid_to DESC, licence_id
      LIMIT 1`,
    [sku, siteId, asOf],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Story 8.7 write-path accessors (register CRUD, BSD-2/BSD-3)
// ---------------------------------------------------------------------------

export interface InsertBisLicenceInput {
  licenceId: string;
  licenceNumber: string;
  licenceType: string;
  sku: string;
  siteId: string | null;
  validFrom: string;
  validTo: string;
}

/**
 * `today` is the IST calendar date the status is derived against, symmetric with
 * updateBisLicenceWindow: recording a licence whose window has already closed must not leave an
 * 'active' row that passes the Story 8.6 release check until the next sweep tick.
 */
export async function insertBisLicence(
  input: InsertBisLicenceInput,
  today: string,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `INSERT INTO compliance_bis_licence
       (licence_id, licence_number, licence_type, sku, site_id, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $7::date >= $8::date THEN 'active' ELSE 'expired' END)`,
    [
      input.licenceId,
      input.licenceNumber.trim(),
      input.licenceType,
      input.sku,
      input.siteId,
      input.validFrom,
      input.validTo,
      today,
    ],
  );
}

/**
 * Story 8.7 BSD-3: renewal is an in-place window update, so the row's status MUST be recomputed
 * from the new window in the same statement. Without this a licence the expiry sweep already
 * flipped to 'expired' would keep status='expired' after renewal, and findValidBisLicence (which
 * filters status = 'active') would keep the Story 8.6 statutory release block engaged forever.
 * Symmetrically, shortening a window into the past marks the row expired immediately rather than
 * leaving it 'active' until the next sweep tick.
 */
export async function updateBisLicenceWindow(
  licenceId: string,
  validFrom: string,
  validTo: string,
  today: string,
  client?: PoolClient,
): Promise<void> {
  await runner(client).query(
    `UPDATE compliance_bis_licence
        SET valid_from = $2,
            valid_to = $3,
            status = CASE WHEN $3::date >= $4::date THEN 'active' ELSE 'expired' END
      WHERE licence_id = $1`,
    [licenceId, validFrom, validTo, today],
  );
}

export async function markBisLicenceExpired(licenceId: string, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `UPDATE compliance_bis_licence SET status = 'expired' WHERE licence_id = $1`,
    [licenceId],
  );
}

export async function getBisLicenceById(
  licenceId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ComplianceBisLicenceRow | null> {
  if (forUpdate) requireTransaction(client, 'getBisLicenceById');
  const result = await runner(client).query(
    `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS}
       FROM compliance_bis_licence WHERE licence_id = $1${forUpdate ? FOR_UPDATE : ''}`,
    [licenceId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function listBisLicences(
  sku?: string,
  limit = 100,
  offset = 0,
  client?: PoolClient,
): Promise<ComplianceBisLicenceRow[]> {
  const result = sku
    ? await runner(client).query(
        `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS} FROM compliance_bis_licence WHERE sku = $1
          ORDER BY created_at DESC, licence_id LIMIT $2 OFFSET $3`,
        [sku, limit, offset],
      )
    : await runner(client).query(
        `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS} FROM compliance_bis_licence
          ORDER BY created_at DESC, licence_id LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

export async function findOverlappingBisLicence(
  sku: string,
  siteId: string | null,
  validFrom: string,
  validTo: string,
  excludeLicenceId: string | null,
  client?: PoolClient,
): Promise<ComplianceBisLicenceRow | null> {
  const result = await runner(client).query(
    `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS}
       FROM compliance_bis_licence
      WHERE sku = $1
        AND status = 'active'
        AND COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND valid_from <= $4::date
        AND valid_to >= $3::date
        AND ($5::uuid IS NULL OR licence_id <> $5::uuid)
      LIMIT 1`,
    [sku, siteId, validFrom, validTo, excludeLicenceId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function insertBisLicenceAlert(
  licenceId: string,
  validTo: string,
  stageDays: number,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(
    `INSERT INTO compliance_bis_licence_alert (licence_id, valid_to, stage_days)
     VALUES ($1, $2::date, $3)
       ON CONFLICT (licence_id, valid_to, stage_days) DO NOTHING`,
    [licenceId, validTo, stageDays],
  );
  // The insert itself IS the idempotency decision: rowCount 0 means another transaction won the
  // race and already flagged this stage, so this caller must not notify a second time.
  return (result.rowCount ?? 0) > 0;
}

export async function getBisLicenceAlert(
  licenceId: string,
  validTo: string,
  stageDays: number,
  client?: PoolClient,
): Promise<{ licence_id: string; stage_days: number } | null> {
  const result = await runner(client).query(
    `SELECT licence_id, stage_days FROM compliance_bis_licence_alert
      WHERE licence_id = $1 AND valid_to = $2::date AND stage_days = $3`,
    [licenceId, validTo, stageDays],
  );
  return result.rows.length > 0
    ? { licence_id: result.rows[0]['licence_id'], stage_days: result.rows[0]['stage_days'] }
    : null;
}

export async function listActiveBisLicencesForExpirySweep(
  batchSize: number,
  today: string,
  horizonDays: number,
  stages: readonly number[],
  client?: PoolClient,
): Promise<ComplianceBisLicenceRow[]> {
  // Only licences already inside the widest alert window (today + 90 days) are candidates. Without
  // the horizon the bounded batch fills with licences years from expiry, which are re-evaluated
  // every tick and, once the active set exceeds batchSize, starve the licences that are actually
  // due.
  // The batch also excludes licences whose currently-due stage is ALREADY in the ledger. Without
  // that anti-join the licences nearest expiry - long since flagged at 90/60/30 - permanently
  // occupy the head of a valid_to-ordered batch, and once the due set exceeds batchSize no
  // newly-due licence is ever reached. The horizon alone only fixes the far-future half of this.
  const result = await runner(client).query(
    `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS}
       FROM compliance_bis_licence l
      WHERE l.status = 'active'
        AND l.valid_to <= ($2::date + ($3::int * INTERVAL '1 day'))
        AND EXISTS (
          SELECT 1 FROM unnest($4::int[]) AS stage
           WHERE (CASE
                    WHEN stage = 0 THEN (l.valid_to - $2::date) < 0
                    ELSE (l.valid_to - $2::date) <= stage
                  END)
             AND NOT EXISTS (
               SELECT 1 FROM compliance_bis_licence_alert a
                WHERE a.licence_id = l.licence_id
                  AND a.valid_to = l.valid_to
                  AND a.stage_days = stage
             )
        )
      ORDER BY l.valid_to ASC LIMIT $1`,
    [batchSize, today, horizonDays, stages],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * The row occupying the uq_compliance_bis_licence_scope grain (case-folded licence number + sku +
 * site scope). Used by the store's 23505 race arm to report the conflicting row's identity.
 */
export async function findBisLicenceByScope(
  licenceNumber: string,
  sku: string,
  siteId: string | null,
  client?: PoolClient,
): Promise<ComplianceBisLicenceRow | null> {
  const result = await runner(client).query(
    `SELECT ${COMPLIANCE_BIS_LICENCE_COLUMNS}
       FROM compliance_bis_licence
      WHERE lower(btrim(licence_number)) = lower(btrim($1))
        AND sku = $2
        AND COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      LIMIT 1`,
    [licenceNumber, sku, siteId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}
