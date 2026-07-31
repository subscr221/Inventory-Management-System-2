import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/config/db.js';
import {
  getVelocityClass,
  upsertVelocityClass,
} from '../../src/read/projections/velocity_class.js';
import { runReslottingJob } from '../../src/warehouse/reslotting-job.js';
import { randomUUID } from 'node:crypto';

describe('Story 3.5: Directed Putaway and Location Override', () => {
  const testSiteId = randomUUID();
  const testSkuId = `TEST-SKU-${randomUUID().slice(0, 8)}`;
  const testLocationId = randomUUID();

  after(async () => {
    await closePool();
  });

  it('creates velocity_class projection', async () => {
    await upsertVelocityClass({
      sku: testSkuId,
      site_id: testSiteId,
      velocity_class: 'B',
      putaway_count_30d: 45,
      override_count_30d: 5,
      preferred_location_id: testLocationId,
      preferred_location_code: 'BIN-PREF-001',
    });

    const result = await getVelocityClass(testSkuId, testSiteId);
    assert.ok(result, 'velocity_class row should exist');
    assert.equal(result.velocity_class, 'B');
    assert.equal(result.putaway_count_30d, 45);
  });

  it('re-slotting job handles empty data gracefully', async () => {
    const results = await runReslottingJob(testSiteId);
    // Should return empty array if no putaway tasks exist
    assert.ok(Array.isArray(results));
  });
});
