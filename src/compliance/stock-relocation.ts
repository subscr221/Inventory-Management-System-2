import type { PoolClient } from 'pg';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { QC_GATE_BLOCKED_STATUSES } from '../read/projections/qc_inspection_task.js';

/**
 * The rules every in-site relocation shares (putaway completion, bin-to-bin move): where stock may
 * land, and what a held lot may do. They live here so the two appliers cannot drift apart.
 */

export type BinOfSiteFault = 'site_mismatch' | 'not_a_bin' | 'inactive';

/**
 * A relocation endpoint must be an active bin of the given site. Without this a scanned code from
 * another site, a zone/site row or a retired bin silently took the stock (Pilot B2 review).
 */
export function binOfSiteFault(
  location: LocationRegisterEntry,
  siteId: string,
): BinOfSiteFault | null {
  return location.site_id !== siteId
    ? 'site_mismatch'
    : location.level !== 'bin'
      ? 'not_a_bin'
      : location.status !== 'active'
        ? 'inactive'
        : null;
}

/**
 * Pilot F3(c): quarantine is a property of the place. A bin is a quarantine location when it, or
 * any location above it in the register (rack, aisle, zone), carries quarantine = true, so a bin
 * beneath a quarantine zone needs no flag of its own. Depth-capped like the other register walks.
 */
export async function isQuarantineLocation(
  locationId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT location_id, parent_location_id, quarantine, 0 AS depth
         FROM location_register WHERE location_id = $1
       UNION ALL
       SELECT lr.location_id, lr.parent_location_id, lr.quarantine, a.depth + 1
         FROM location_register lr
         JOIN ancestors a ON lr.location_id = a.parent_location_id
        WHERE a.depth < 10
     )
     SELECT 1 FROM ancestors WHERE quarantine LIMIT 1`,
    [locationId],
  );
  return result.rows.length > 0;
}

export interface LotRelocationHold {
  /** A qc_inspection_task row holds the lot under a blocking gate (the drain window hides it). */
  qcGated: boolean;
  /** lot_master.quality_hold_status is anything other than 'none' (a hold placed by hand, Pilot G1). */
  manuallyHeld: boolean;
}

/**
 * Whether a lot may only be relocated into a quarantine bin. The gate vocabulary and the
 * lot-number + sku match are the ones qcGateExclusionSql splices into the drain window, so "gated"
 * means the same thing here as it does for every consumption path. The lot-level hold is a separate
 * flag, checked here explicitly. `lotNumber` is the lot NUMBER, the value stock_balance.lot_id and
 * the putaway task carry. The lot row is read FOR UPDATE (review R7e), the lock assertQcGateAllows
 * and the quality-hold placement take, so a hold placed concurrently either lands before this read
 * or waits for the relocation to commit - never in between.
 */
export async function lotRelocationHold(
  sku: string,
  lotNumber: string,
  client: PoolClient,
): Promise<LotRelocationHold> {
  const gate = await client.query(
    `SELECT 1 FROM qc_inspection_task
      WHERE lot_number = $1 AND sku = $2 AND gate_status = ANY($3::text[]) LIMIT 1`,
    [lotNumber, sku, [...QC_GATE_BLOCKED_STATUSES]],
  );
  const hold = await client.query(
    `SELECT quality_hold_status FROM lot_master WHERE lot_number = $1 AND sku = $2 FOR UPDATE`,
    [lotNumber, sku],
  );
  return {
    qcGated: gate.rows.length > 0,
    manuallyHeld: hold.rows.some(
      (r: Record<string, unknown>) => r['quality_hold_status'] !== 'none',
    ),
  };
}
