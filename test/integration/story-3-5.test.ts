import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closeAdminPool } from '../../src/config/db.js';
import { migrate } from '../../src/events/migrate.js';
import { getPutawayTaskById } from '../../src/read/projections/putaway_task.js';
import { getVelocityClass, upsertVelocityClass } from '../../src/read/projections/velocity_class.js';
import { computeDirectedSuggestion } from '../../src/warehouse/putaway-suggestion.js';
import { runReslottingJob } from '../../src/warehouse/reslotting-job.js';
import { randomUUID } from 'node:crypto';

describe('Story 3.5: Directed Putaway and Location Override', () => {
  const pool = getPool();
  const testSiteId = randomUUID();
  const testSkuId = 'TEST-SKU-001';
  const testLocationId = randomUUID();

  before(async () => {
    await migrate();
    console.log('✓ Migration complete');
  });

  after(async () => {
    await closeAdminPool();
  });

  it('creates velocity_class projection', async () => {
    await upsertVelocityClass(
      {
        sku: testSkuId,
        site_id: testSiteId,
        velocity_class: 'B',
        putaway_count_30d: 45,
        override_count_30d: 5,
        preferred_location_id: testLocationId,
        preferred_location_code: 'BIN-PREF-001',
      },
      pool,
    );

    const result = await getVelocityClass(testSkuId, testSiteId, pool);
    assert.ok(result, 'velocity_class row should exist');
    assert.equal(result.velocity_class, 'B');
    assert.equal(result.putaway_count_30d, 45);
  });

  it('re-slotting job handles empty data gracefully', async () => {
    const results = await runReslottingJob(testSiteId, pool);
    // Should return empty array if no putaway tasks exist
    assert.ok(Array.isArray(results));
  });
});
