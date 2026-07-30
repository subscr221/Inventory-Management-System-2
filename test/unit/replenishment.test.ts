import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/config/db.js';
import { getForwardPickBalance } from '../../src/read/projections/stock_balance.js';

/**
 * Story 3.9 (Task 7.2): boundary cases for getForwardPickBalance's descendant-walk, the mirror
 * image of putaway_task.ts's ZONE_ANCESTOR_CTE. Exercises the projection function directly against
 * the database rather than the full HTTP surface (test/integration/story-3-9.test.ts covers the
 * end-to-end ACs); these three cases are what a recursive CTE actually gets wrong when it does.
 */

describe('Story 3.9 getForwardPickBalance boundary cases', () => {
  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const sku = `SKU-39-UNIT-${run}`;

  async function seedLocation(locationId: string, code: string, level: string, parentId: string | null, zoneType = 'general'): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ambient', 'standard', false, false, false, 'active')`,
      [locationId, code, level, parentId, siteId, zoneType],
    );
  }

  before(async () => {
    await seedLocation(siteId, `SITE39U-${run}`, 'site', null);
  });

  after(async () => {
    await closePool();
  });

  it('a zone with no bins reads as balance 0, not an error', async () => {
    const zoneId = randomUUID();
    await seedLocation(zoneId, `EMPTYZONE-${run}`, 'zone', siteId, 'forward_pick');
    const balance = await getForwardPickBalance(sku, zoneId);
    assert.strictEqual(balance, '0');
  });

  it('sums owned on-hand across a full zone > aisle > rack > bin chain without the depth cap truncating it', async () => {
    const zoneId = randomUUID();
    const aisleId = randomUUID();
    const rackId = randomUUID();
    const binId = randomUUID();
    await seedLocation(zoneId, `CHAINZONE-${run}`, 'zone', siteId, 'forward_pick');
    await seedLocation(aisleId, `CHAINAISLE-${run}`, 'aisle', zoneId);
    await seedLocation(rackId, `CHAINRACK-${run}`, 'rack', aisleId);
    await seedLocation(binId, `CHAINBIN-${run}`, 'bin', rackId);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 42)`,
      [sku, binId],
    );

    const balance = await getForwardPickBalance(sku, zoneId);
    assert.strictEqual(balance, '42.000000');
  });

  it('stock at a bin belonging to a different zone under the same site is not summed', async () => {
    const zoneAId = randomUUID();
    const zoneBId = randomUUID();
    const binAId = randomUUID();
    const binBId = randomUUID();
    await seedLocation(zoneAId, `SIBZONEA-${run}`, 'zone', siteId, 'forward_pick');
    await seedLocation(zoneBId, `SIBZONEB-${run}`, 'zone', siteId, 'forward_pick');
    await seedLocation(binAId, `SIBBINA-${run}`, 'bin', zoneAId);
    await seedLocation(binBId, `SIBBINB-${run}`, 'bin', zoneBId);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 15)`, [sku, binAId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 99)`, [sku, binBId]);

    const balanceA = await getForwardPickBalance(sku, zoneAId);
    assert.strictEqual(balanceA, '15.000000', "zone B's stock must not be summed into zone A's balance");
  });

  it('consignment/vmi stock is excluded - only stock_class owned is eligible for internal replenishment', async () => {
    const zoneId = randomUUID();
    const binId = randomUUID();
    await seedLocation(zoneId, `NONOWNEDZONE-${run}`, 'zone', siteId, 'forward_pick');
    await seedLocation(binId, `NONOWNEDBIN-${run}`, 'bin', zoneId);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'consignment', 500)`, [sku, binId]);

    const balance = await getForwardPickBalance(sku, zoneId);
    assert.strictEqual(balance, '0', 'non-owned stock must not count toward the forward-pick balance');
  });
});
