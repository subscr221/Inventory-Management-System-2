import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/config/db.js';
import { applyStockAllocationRelief } from '../../src/read/projections/stock_balance.js';
import { AppError } from '../../src/middleware/error.js';

describe('Story 3.17 applyStockAllocationRelief unit tests', () => {
  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const binId1 = randomUUID();
  const binId2 = randomUUID();
  const sku = `SKU-317-${run}`;
  const lotNumber = `LOT-317-${run}`;

  before(async () => {
    const pool = getPool();
    // Seed site & locations
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, 'bin', $1, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [siteId, `SITE-${run}`],
    );
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [binId1, `BIN1-${run}`, siteId],
    );
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [binId2, `BIN2-${run}`, siteId],
    );

    // Seed stock balance: bin1 has lot-tracked stock (on_hand 20, allocated 10)
    await pool.query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated)
       VALUES ($1, $2, $3, 'owned', 20.000, 10.000)`,
      [sku, binId1, lotNumber],
    );

    // Seed stock balance: bin2 has lot-less stock (on_hand 15, allocated 8)
    await pool.query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated)
       VALUES ($1, $2, NULL, 'owned', 15.000, 8.000)`,
      [sku, binId2],
    );
  });

  after(async () => {
    await closePool();
  });

  it('relieves allocated reservation for lot-tracked stock', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyStockAllocationRelief(siteId, sku, lotNumber, binId1, '4.000', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const res = await pool.query(
      `SELECT allocated::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [sku, binId1, lotNumber],
    );
    assert.strictEqual(res.rows[0].allocated, '6.000000');
  });

  it('relieves allocated reservation for lot-less stock', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyStockAllocationRelief(siteId, sku, null, binId2, '3.000', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const res = await pool.query(
      `SELECT allocated::text FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id IS NULL`,
      [sku, binId2],
    );
    assert.strictEqual(res.rows[0].allocated, '5.000000');
  });

  it('fails closed when allocated is less than requested shortfall', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => applyStockAllocationRelief(siteId, sku, lotNumber, binId1, '100.000', client),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.errorCode, 'INSUFFICIENT_STOCK_FOR_PICK');
          assert.strictEqual(err.statusCode, 409);
          return true;
        },
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('fails closed when no matching stock balance row exists', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        () => applyStockAllocationRelief(siteId, sku, 'NON-EXISTENT-LOT', binId1, '1.000', client),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.strictEqual(err.errorCode, 'INSUFFICIENT_STOCK_FOR_PICK');
          assert.strictEqual(err.statusCode, 409);
          return true;
        },
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
