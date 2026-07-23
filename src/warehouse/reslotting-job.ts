import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { listVelocityClasses, upsertVelocityClass } from '../read/projections/velocity_class.js';

const MIN_OVERRIDE_CLUSTER_SIZE = 3;
const ABC_PERCENTILES = { A: 0.2, B: 0.5 };

export interface ReslottingResult {
  sku: string;
  siteId: string;
  oldVelocityClass: 'A' | 'B' | 'C';
  newVelocityClass: 'A' | 'B' | 'C';
  oldPreferredLocationId: string | null;
  newPreferredLocationId: string | null;
}

/** Story 3.5 Task 6: Run the velocity classification and re-slotting analysis job. */
export async function runReslottingJob(siteId?: string, client?: PoolClient): Promise<ReslottingResult[]> {
  const pool = client ?? getPool();
  const results: ReslottingResult[] = [];

  // Get all sites if not specified
  const sites = siteId
    ? [siteId]
    : (
        await pool.query(`SELECT DISTINCT site_id FROM putaway_task WHERE status = 'completed' AND completed_at > now() - INTERVAL '30 days'`)
      ).rows.map((r: Record<string, unknown>) => r['site_id'] as string);

  for (const site of sites) {
    // Task 6.2: Velocity classification by putaway frequency
    const frequencyData = await pool.query(
      `SELECT sku, COUNT(*) as putaway_count_30d
       FROM putaway_task
       WHERE site_id = $1 AND status = 'completed' AND completed_at > now() - INTERVAL '30 days'
       GROUP BY sku
       ORDER BY putaway_count_30d DESC`,
      [site],
    );

    const skuCounts = frequencyData.rows.map((r: Record<string, unknown>) => ({
      sku: r['sku'] as string,
      putawayCount: Number(r['putaway_count_30d']),
    }));

    if (skuCounts.length === 0) continue;

    // Assign ABC classes by percentile
    const totalSkus = skuCounts.length;
    const classA = Math.ceil(totalSkus * ABC_PERCENTILES.A);
    const classB = Math.ceil(totalSkus * (ABC_PERCENTILES.A + ABC_PERCENTILES.B));

    for (let i = 0; i < skuCounts.length; i++) {
      const sku = skuCounts[i]!.sku;
      let newVelocityClass: 'A' | 'B' | 'C' = 'C';
      if (i < classA) newVelocityClass = 'A';
      else if (i < classB) newVelocityClass = 'B';

      // Count overrides for this SKU at this site
      const overrideCount = await pool.query(
        `SELECT COUNT(*) as override_count_30d
         FROM domain_events de
         WHERE de.event_type = 'location.override'
           AND de.stream_id IN (
             SELECT putaway_task_id FROM putaway_task
             WHERE sku = $1 AND site_id = $2
               AND status = 'completed'
               AND completed_at > now() - INTERVAL '30 days'
           )
           AND de.occurred_at > now() - INTERVAL '30 days'`,
        [sku, site],
      );

      const overrideCountValue = Number(overrideCount.rows[0]!['override_count_30d']) || 0;

      // Task 6.3: Override-cluster analysis (find preferred location if clusters exist)
      let preferredLocationId: string | null = null;
      let preferredLocationCode: string | null = null;

      if (overrideCountValue >= MIN_OVERRIDE_CLUSTER_SIZE) {
        // Find the most common override location for this SKU
        const clusterQuery = await pool.query(
          `SELECT actual_location_id, actual_location_code, COUNT(*) as cluster_count
           FROM putaway_task
           WHERE sku = $1 AND site_id = $2
             AND status = 'completed'
             AND override_reason_code IS NOT NULL
             AND completed_at > now() - INTERVAL '30 days'
           GROUP BY actual_location_id, actual_location_code
           ORDER BY cluster_count DESC
           LIMIT 1`,
          [sku, site],
        );

        if (clusterQuery.rows.length > 0) {
          const clusterRow = clusterQuery.rows[0]!;
          const clusterCount = Number(clusterRow['cluster_count']);
          const percentClustered = (clusterCount / overrideCountValue) * 100;

          if (percentClustered >= 60) {
            preferredLocationId = clusterRow['actual_location_id'] as string;
            preferredLocationCode = clusterRow['actual_location_code'] as string;
          }
        }
      }

      // Get old values for comparison
      const existing = await pool.query(
        `SELECT velocity_class, preferred_location_id FROM velocity_class WHERE sku = $1 AND site_id = $2`,
        [sku, site],
      );

      const oldVelocityClass = (existing.rows[0]?.['velocity_class'] as 'A' | 'B' | 'C') || 'C';
      const oldPreferredLocationId = (existing.rows[0]?.['preferred_location_id'] as string | null) || null;

      // Upsert the velocity class row
      await upsertVelocityClass(
        {
          sku,
          site_id: site,
          velocity_class: newVelocityClass,
          putaway_count_30d: skuCounts[i]!.putawayCount,
          override_count_30d: overrideCountValue,
          preferred_location_id: preferredLocationId,
          preferred_location_code: preferredLocationCode,
        },
        pool,
      );

      // Track result
      results.push({
        sku,
        siteId: site,
        oldVelocityClass,
        newVelocityClass,
        oldPreferredLocationId,
        newPreferredLocationId: preferredLocationId,
      });
    }
  }

  return results;
}
