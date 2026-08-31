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
 * time, never a client-supplied field). A site-specific row is preferred over a global row when
 * both are valid.
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
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

export const COMPLIANCE_BIS_LICENCE_COLUMNS = `licence_id, licence_number, licence_type, sku,
    site_id, valid_from::text AS valid_from, valid_to::text AS valid_to, created_at`;

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
