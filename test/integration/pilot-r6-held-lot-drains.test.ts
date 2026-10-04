import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, getPool } from '../../src/config/db.js';
import {
  applyStockAllocation,
  applyStockIssue,
  applyStockIssueUnderSite,
} from '../../src/read/projections/stock_balance.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Pilot review R6: a lot held BY HAND (lot_master.quality_hold_status) must be as invisible to a
 * lot-less drain as a lot under a blocking QC gate. The three shared ledger helpers are exercised
 * directly - they are what production backflush (applyStockIssueUnderSite), lot-less staging and
 * replenishment (applyStockIssue) and lot-less allocation (applyStockAllocation) all run on - and
 * every case rolls back, so nothing is left behind.
 */
describe('Pilot R6 a manually held lot is invisible to lot-less drains', () => {
  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const binId = randomUUID();
  const sku = `R6-${run}`;
  const heldLot = `R6-A-HELD-${run}`;
  const freeLot = `R6-B-FREE-${run}`;

  before(async () => {
    const pool = getPool();
    for (const [id, code, level, parent] of [
      [siteId, `R6SITE-${run}`, 'site', null],
      [binId, `R6BIN-${run}`, 'bin', siteId],
    ] as const) {
      await pool.query(
        `INSERT INTO location_register
           (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
            size_class, hazmat_allowed, quarantine, access_restricted, status)
         VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active')`,
        [id, code, level, parent, siteId],
      );
    }
    await pool.query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', true, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
    // The held lot sorts FIRST, so a drain that does not skip it would take it before the free lot.
    for (const [lot, hold] of [
      [heldLot, 'held'],
      [freeLot, 'none'],
    ] as const) {
      await pool.query(
        `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), lot, sku, hold],
      );
      await pool.query(
        `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', 10)`,
        [sku, binId, lot],
      );
    }
  });

  after(async () => {
    await closePool();
  });

  async function inRolledBackTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      return await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  async function insufficient(work: (client: PoolClient) => Promise<unknown>): Promise<void> {
    await assert.rejects(
      inRolledBackTransaction(work),
      (err: unknown) =>
        err instanceof AppError &&
        err.errorCode === 'INSUFFICIENT_STOCK' &&
        Number(err.details?.['available_quantity']) === 10,
    );
  }

  it('backflush (under-site issue) takes the free lot and never the held one', async () => {
    const drained = await inRolledBackTransaction((client) =>
      applyStockIssueUnderSite({ sku, site_location_id: siteId, quantity: 10 }, client),
    );
    assert.deepStrictEqual(
      drained.map((d) => [d.lot_id, Number(d.quantity)]),
      [[freeLot, 10]],
    );
    await insufficient((client) =>
      applyStockIssueUnderSite({ sku, site_location_id: siteId, quantity: 11 }, client),
    );
  });

  it('a lot-less bin issue (staging, replenishment) takes the free lot and never the held one', async () => {
    const drained = await inRolledBackTransaction((client) =>
      applyStockIssue({ sku, location_id: binId, quantity: 10, relocation: true }, client),
    );
    assert.deepStrictEqual(
      drained.map((d) => [d.lot_id, Number(d.quantity)]),
      [[freeLot, 10]],
    );
    await insufficient((client) =>
      applyStockIssue({ sku, location_id: binId, quantity: 11 }, client),
    );
  });

  it('a lot-less allocation cannot reserve the held lot', async () => {
    await insufficient((client) =>
      applyStockAllocation({ sku, location_id: binId, quantity: 11 }, client),
    );
  });

  it('a relocation of the held lot into quarantine (qc_gate_relocation) still drains it', async () => {
    const drained = await inRolledBackTransaction((client) =>
      applyStockIssue(
        {
          sku,
          location_id: binId,
          lot_id: heldLot,
          quantity: 10,
          relocation: true,
          qc_gate_relocation: true,
        },
        client,
      ),
    );
    assert.deepStrictEqual(
      drained.map((d) => [d.lot_id, Number(d.quantity)]),
      [[heldLot, 10]],
    );
  });
});
