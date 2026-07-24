import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { getPutawayTaskById } from '../read/projections/putaway_task.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getVelocityClass } from '../read/projections/velocity_class.js';
import { listLocationsBySite, zoneIncompatibilityReasons } from '../read/projections/location_register.js';
import { AppError } from '../middleware/error.js';

export interface DirectedSuggestionResult {
  locationId: string;
  locationCode: string;
  velocityClass: 'A' | 'B' | 'C';
}

export interface NoSuggestionResult {
  locationId: null;
  reason: string;
}

export type ComputeDirectedSuggestionResult = DirectedSuggestionResult | NoSuggestionResult;

/** Story 3.5 Task 4: Compute the directed putaway suggestion for a given task. */
export async function computeDirectedSuggestion(
  putawayTaskId: string,
  client?: PoolClient,
): Promise<ComputeDirectedSuggestionResult> {
  const pool = client ?? getPool();

  // Step 1: Load the putaway task
  const task = await getPutawayTaskById(putawayTaskId, client);
  if (!task) {
    throw new AppError(404, 'PUTAWAY_TASK_NOT_FOUND', `Putaway task ${putawayTaskId} not found`);
  }

  // Step 4.4: Reject if task is held (QC-hold)
  if (task.status === 'held') {
    throw new AppError(409, 'PUTAWAY_TASK_NOT_READY', 'Putaway task is on QC hold and cannot be suggested');
  }

  // Step 4.2(a): Load item master to get hazmat/quarantine flags
  const item = await getItemBySku(task.sku, client);
  if (!item) {
    throw new AppError(404, 'ITEM_NOT_FOUND', `Item ${task.sku} not found`);
  }

  // Step 4.2(b): Load velocity class (default to C if no row exists)
  const velocityClassRow = await getVelocityClass(task.sku, task.site_id, client);
  const velocityClass = velocityClassRow?.velocity_class ?? 'C';

  // Step 4.2(c): Query candidate bins at this site
  const locations = await listLocationsBySite(task.site_id, client);

  // Filter candidates: must be active bins
  let candidates = locations.filter(
    (loc) =>
      loc.status === 'active' &&
      loc.level === 'bin' && // Only bin-level locations
      !loc.access_restricted, // Exclude access-restricted bins (QC-inspectors are handled separately)
  );

  // Step 4.2(d): Exclude bins that cannot accommodate the item's size class
  // Size class ordering: small < standard < large < oversized
  // A bin's size_class must be >= the item's size_class
  // item_master carries no size_class column yet; every item ranks as 'standard' until a future
  // story adds per-item size data.
  const itemSizeClass = 'standard';
  const sizeClassOrder: Record<string, number> = {
    small: 1,
    standard: 2,
    large: 3,
    oversized: 4,
  };
  const itemSizeIndex = sizeClassOrder[itemSizeClass] ?? 2;

  candidates = candidates.filter((bin) => {
    const binSizeIndex = sizeClassOrder[bin.size_class || 'standard'] ?? 2;
    return binSizeIndex >= itemSizeIndex;
  });

  // Step 4.2(e): Exclude bins failing zone compatibility
  candidates = candidates.filter((bin) => {
    const incompatibilities = zoneIncompatibilityReasons(item, bin);
    return incompatibilities.length === 0;
  });

  if (candidates.length === 0) {
    return {
      locationId: null,
      reason: 'No eligible bins found that accommodate item size class and zone constraints',
    };
  }

  // Step 4.2(f): Rank candidates
  // Priority 1: preferred_location_id from velocity class (re-slotting override)
  // Priority 2: same zone_type as item's typical zone
  // Priority 3: lowest occupancy (completed putaway count in last 90 days, as a proxy)
  // Priority 4: alphabetical location_code for determinism

  // If velocity_class row exists and has a preferred location, prefer it if eligible
  if (velocityClassRow?.preferred_location_id) {
    const preferred = candidates.find((c) => c.location_id === velocityClassRow.preferred_location_id);
    if (preferred) {
      return {
        locationId: preferred.location_id,
        locationCode: preferred.location_code,
        velocityClass,
      };
    }
  }

  // Query occupancy counts for all candidates
  const occupancyQuery = await pool.query(
    `SELECT actual_location_id, COUNT(*) as putaway_count_90d
     FROM putaway_task
     WHERE status = 'completed'
       AND actual_location_id = ANY($1::uuid[])
       AND completed_at > now() - INTERVAL '90 days'
     GROUP BY actual_location_id`,
    [candidates.map((c) => c.location_id)],
  );

  const occupancyMap = new Map<string, number>();
  occupancyQuery.rows.forEach((row: Record<string, unknown>) => {
    occupancyMap.set(row['actual_location_id'] as string, Number(row['putaway_count_90d']));
  });

  // item_master carries no zone preference column, so the zone-match tiebreaker is inert until a
  // future story adds one.

  // Sort candidates
  const ranked = candidates.sort((a, b) => {
    // Lowest occupancy
    const aOccupancy = occupancyMap.get(a.location_id) || 0;
    const bOccupancy = occupancyMap.get(b.location_id) || 0;
    if (aOccupancy !== bOccupancy) return aOccupancy - bOccupancy;

    // Alphabetical
    return a.location_code.localeCompare(b.location_code);
  });

  const topCandidate = ranked[0]!;

  return {
    locationId: topCandidate.location_id,
    locationCode: topCandidate.location_code,
    velocityClass,
  };
}
