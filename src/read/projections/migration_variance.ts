import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { CUSTOMER_OWNED_STOCK_CLASSES } from '../../compliance/stock-balance.js';
import { SUPPLIER_OWNED_STOCK_CLASSES } from '../../compliance/ownership.js';

/**
 * Story 13.1 (Task 5): the opening-stock variance computation - ONE SQL statement, parameterised by
 * site, used by the AC 2 report route AND by the AC 3 promotion gate (handler and applier). There
 * is deliberately no second derivation anywhere (Story 11.5 D1 lesson).
 *
 * Variances are computed, never stored (Binding Decision 7). The live import side is every
 * migration_opening_stock_row with status accepted or posted; the source side is the LATEST
 * erp_stock_balance snapshot per source_system for the site (rows at the maximum snapshot_at, so
 * a re-extract replaces the comparison wholesale).
 *
 * Comparison grain (Task 5.2):
 * - a source row carrying lot_number_ext is compared at lot grain;
 * - a source (location, sku) that carries NO lot row is compared against the imported rows summed
 *   over lots;
 * - serials are compared as set membership per (location, sku) whenever the source carries
 *   serials for that (location, sku); each serial present on one side only is its own variance
 *   (serial_missing_in_source / serial_missing_in_import). A source that carries no serials for a
 *   serial-controlled (location, sku) is compared by summed quantity like a lot-less source;
 * - a source row whose site or location did not resolve is `unmapped_source_row`.
 *
 * Value (Task 5.3): unit_cost is the imported row's cost (quantity-weighted over an aggregate),
 * else the source cost, else null; variance_value = quantity_delta * unit_cost, rounded to 2, and
 * exactly 0 when EVERY imported row in the grain is in a customer-owned or supplier-owned class -
 * the sets are imported, never restated (Binding Decision 6). Status: `explained` when an
 * approved explanation exists whose explained_quantity_delta equals the live delta;
 * `pending_approval` when a pending explanation exists; `stale` when an approved explanation
 * exists for a different delta; else `open`. Only `explained` counts as resolved.
 */

export type OpeningStockVarianceKind =
  | 'missing_in_import'
  | 'missing_in_source'
  | 'quantity_mismatch'
  | 'serial_missing_in_source'
  | 'serial_missing_in_import'
  | 'unmapped_source_row';

export type OpeningStockVarianceStatus = 'open' | 'pending_approval' | 'stale' | 'explained';

export interface OpeningStockVariance {
  variance_key: string;
  source_system: string;
  location_code: string;
  sku: string;
  lot_number: string | null;
  serial_number: string | null;
  kind: OpeningStockVarianceKind;
  /** NUMERIC strings; null when that side has no row. */
  imported_quantity: string | null;
  source_quantity: string | null;
  /** NUMERIC string: imported - source, with a missing side counted as 0. */
  quantity_delta: string;
  unit_cost: string | null;
  /** NUMERIC string (2 dp), '0' for zero-valued classes, null when no cost is known. */
  variance_value: string | null;
  /**
   * NUMERIC string (2 dp): abs(quantity_delta) * unit_cost regardless of stock class, 0 when no
   * cost is known. This is the DOA-banded amount for an explanation (Story 9.10 ruling: band on the
   * COMPUTED value and zero only the reported figure, or a customer-owned variance of any size bands
   * at the lowest authority or at none at all).
   */
  banding_value: string;
  status: OpeningStockVarianceStatus;
  explanation_id: string | null;
}

export const VARIANCE_KEY_SEPARATOR = '|';

/** Task 5.3: '{source_system}|{location_code}|{sku}|{lot_number or -}|{serial_number or -}'. */
export function buildVarianceKey(parts: {
  source_system: string;
  location_code: string;
  sku: string;
  lot_number: string | null;
  serial_number: string | null;
}): string {
  return [
    parts.source_system,
    parts.location_code,
    parts.sku,
    parts.lot_number ?? '-',
    parts.serial_number ?? '-',
  ].join(VARIANCE_KEY_SEPARATOR);
}

/**
 * Resolved at CALL time, not module load: stock-balance.ts sits on an import cycle with
 * events/store.ts (store -> migration-opening-stock -> this file -> stock-balance), so a module
 * that loads stock-balance.ts first would observe these sets in their temporal dead zone.
 */
function zeroValuedStockClasses(): string[] {
  return [...CUSTOMER_OWNED_STOCK_CLASSES, ...SUPPLIER_OWNED_STOCK_CLASSES];
}

const VARIANCE_SQL = `
WITH site AS (
  SELECT location_id, location_code FROM location_register WHERE location_id = $1
),
src_all AS (
  SELECT b.*
  FROM erp_stock_balance b, site s
  WHERE b.site_id = s.location_id OR (b.site_id IS NULL AND b.site_code_ext = s.location_code)
),
latest AS (
  SELECT source_system, max(snapshot_at) AS snapshot_at FROM src_all GROUP BY source_system
),
src AS (
  SELECT a.* FROM src_all a JOIN latest l ON l.source_system = a.source_system AND l.snapshot_at = a.snapshot_at
),
systems AS (SELECT source_system FROM latest),
imp AS (
  SELECT r.location_code, r.sku, r.lot_number, r.serial_number, r.stock_class, r.quantity, r.unit_cost
  FROM migration_opening_stock_row r
  WHERE r.site_id = $1 AND r.status IN ('accepted', 'posted')
),
unmapped AS (
  SELECT source_system, location_code, sku, lot_number_ext AS lot_number, serial_number_ext AS serial_number,
         'unmapped_source_row'::text AS kind,
         NULL::numeric AS imported_quantity, quantity AS source_quantity,
         unit_cost, false AS zero_valued
  FROM src WHERE location_id IS NULL
),
mapped AS (SELECT * FROM src WHERE location_id IS NOT NULL),
src_shape AS (
  SELECT source_system, location_code, sku,
         bool_or(lot_number_ext IS NOT NULL) AS has_lot,
         bool_or(serial_number_ext IS NOT NULL) AS has_serial
  FROM mapped GROUP BY source_system, location_code, sku
),
imp_x AS (
  SELECT sys.source_system, i.location_code, i.sku, i.lot_number, i.serial_number, i.stock_class, i.quantity, i.unit_cost,
         COALESCE(sh.has_lot, true) AS src_has_lot,
         COALESCE(sh.has_serial, true) AS src_has_serial
  FROM systems sys
  CROSS JOIN imp i
  LEFT JOIN src_shape sh
    ON sh.source_system = sys.source_system AND sh.location_code = i.location_code AND sh.sku = i.sku
),
src_serial AS (
  SELECT source_system, location_code, sku, serial_number_ext AS serial_number, quantity, unit_cost
  FROM mapped WHERE serial_number_ext IS NOT NULL
),
imp_serial AS (
  SELECT source_system, location_code, sku, serial_number, quantity, unit_cost, stock_class
  FROM imp_x WHERE serial_number IS NOT NULL AND src_has_serial
),
serial_var AS (
  SELECT COALESCE(i.source_system, s.source_system) AS source_system,
         COALESCE(i.location_code, s.location_code) AS location_code,
         COALESCE(i.sku, s.sku) AS sku,
         NULL::text AS lot_number,
         COALESCE(i.serial_number, s.serial_number) AS serial_number,
         CASE WHEN s.serial_number IS NULL THEN 'serial_missing_in_source' ELSE 'serial_missing_in_import' END AS kind,
         i.quantity AS imported_quantity, s.quantity AS source_quantity,
         COALESCE(i.unit_cost, s.unit_cost) AS unit_cost,
         COALESCE(i.stock_class = ANY($2::text[]), false) AS zero_valued
  FROM imp_serial i
  FULL OUTER JOIN src_serial s
    ON s.source_system = i.source_system AND s.location_code = i.location_code
   AND s.sku = i.sku AND s.serial_number = i.serial_number
  WHERE i.serial_number IS NULL OR s.serial_number IS NULL
),
src_qty AS (
  SELECT source_system, location_code, sku, lot_number_ext AS lot_number, quantity, unit_cost
  FROM mapped WHERE serial_number_ext IS NULL
),
imp_qty AS (
  SELECT source_system, location_code, sku,
         CASE WHEN src_has_lot THEN lot_number ELSE NULL END AS lot_number,
         sum(quantity) AS quantity,
         CASE WHEN bool_and(unit_cost IS NOT NULL) AND sum(quantity) <> 0
              THEN sum(quantity * unit_cost) / sum(quantity) END AS unit_cost,
         bool_and(stock_class = ANY($2::text[])) AS zero_valued
  FROM imp_x
  WHERE NOT (serial_number IS NOT NULL AND src_has_serial)
  GROUP BY source_system, location_code, sku, CASE WHEN src_has_lot THEN lot_number ELSE NULL END
),
qty_var AS (
  SELECT COALESCE(i.source_system, s.source_system) AS source_system,
         COALESCE(i.location_code, s.location_code) AS location_code,
         COALESCE(i.sku, s.sku) AS sku,
         COALESCE(i.lot_number, s.lot_number) AS lot_number,
         NULL::text AS serial_number,
         CASE WHEN i.sku IS NULL THEN 'missing_in_import'
              WHEN s.sku IS NULL THEN 'missing_in_source'
              ELSE 'quantity_mismatch' END AS kind,
         i.quantity AS imported_quantity, s.quantity AS source_quantity,
         COALESCE(i.unit_cost, s.unit_cost) AS unit_cost,
         COALESCE(i.zero_valued, false) AS zero_valued
  FROM imp_qty i
  FULL OUTER JOIN src_qty s
    ON s.source_system = i.source_system AND s.location_code = i.location_code
   AND s.sku = i.sku AND s.lot_number IS NOT DISTINCT FROM i.lot_number
  WHERE i.sku IS NULL OR s.sku IS NULL OR i.quantity <> s.quantity
),
all_var AS (
  SELECT * FROM unmapped
  UNION ALL SELECT * FROM serial_var
  UNION ALL SELECT * FROM qty_var
),
keyed AS (
  SELECT v.*,
         v.source_system || '|' || v.location_code || '|' || v.sku || '|' || COALESCE(v.lot_number, '-') || '|' || COALESCE(v.serial_number, '-') AS variance_key,
         (COALESCE(v.imported_quantity, 0) - COALESCE(v.source_quantity, 0)) AS quantity_delta
  FROM all_var v
)
SELECT k.variance_key, k.source_system, k.location_code, k.sku, k.lot_number, k.serial_number, k.kind,
       k.imported_quantity::text AS imported_quantity,
       k.source_quantity::text AS source_quantity,
       k.quantity_delta::text AS quantity_delta,
       k.unit_cost::text AS unit_cost,
       CASE WHEN k.zero_valued THEN 0::numeric
            WHEN k.unit_cost IS NULL THEN NULL
            ELSE round(k.quantity_delta * k.unit_cost, 2) END::text AS variance_value,
       round(abs(k.quantity_delta) * COALESCE(k.unit_cost, 0), 2)::text AS banding_value,
       CASE WHEN approved.explanation_id IS NOT NULL AND approved.explained_quantity_delta = k.quantity_delta THEN 'explained'
            WHEN pending.explanation_id IS NOT NULL THEN 'pending_approval'
            WHEN approved.explanation_id IS NOT NULL THEN 'stale'
            ELSE 'open' END AS status,
       COALESCE(pending.explanation_id, approved.explanation_id)::text AS explanation_id
FROM keyed k
LEFT JOIN LATERAL (
  SELECT e.explanation_id, e.explained_quantity_delta
  FROM migration_variance_explanation e
  WHERE e.site_id = $1 AND e.variance_key = k.variance_key AND e.status = 'approved'
  LIMIT 1
) approved ON true
LEFT JOIN LATERAL (
  SELECT e.explanation_id
  FROM migration_variance_explanation e
  WHERE e.site_id = $1 AND e.variance_key = k.variance_key AND e.status = 'pending_approval'
  ORDER BY e.created_at DESC
  LIMIT 1
) pending ON true
ORDER BY k.source_system, k.location_code, k.sku, k.lot_number NULLS FIRST, k.serial_number NULLS FIRST
`;

export async function computeOpeningStockVariances(
  siteId: string,
  client?: PoolClient,
): Promise<OpeningStockVariance[]> {
  const runner = client ?? getPool();
  const result = await runner.query(VARIANCE_SQL, [siteId, zeroValuedStockClasses()]);
  return result.rows as OpeningStockVariance[];
}

export interface OpeningStockVarianceTotals {
  open_count: number;
  /** NUMERIC string: sum of abs(variance_value) over every variance not yet `explained`. */
  open_value: string;
}

/** Totals for the AC 2 report; computed from the same rows, without floats. */
export function summariseOpeningStockVariances(
  rows: readonly OpeningStockVariance[],
): OpeningStockVarianceTotals {
  let openCount = 0;
  // Sum in integer paise (2 dp) to stay float-free.
  let openPaise = 0n;
  for (const row of rows) {
    if (row.status === 'explained') continue;
    openCount += 1;
    if (row.variance_value === null) continue;
    openPaise += absPaise(row.variance_value);
  }
  return { open_count: openCount, open_value: formatPaise(openPaise) };
}

function absPaise(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = (frac + '00').slice(0, 2);
  return BigInt(whole || '0') * 100n + BigInt(cents);
}

function formatPaise(paise: bigint): string {
  const whole = paise / 100n;
  const frac = paise % 100n;
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}
