import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';
import {
  applyValuationOutflow,
  applyValuationReturn,
  type ValuationOutflow,
} from '../../src/compliance/inventory-valuation.js';

const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            parsed = { error_code: 'NON_JSON_BODY' };
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Owner ruling 2026-09-20: "valuation must follow outgoing stock" (supersedes Story 6.2 Binding
 * Decision 9, closes deferred-work row 474). This file pins the shared rule every owned-outflow
 * seam goes through (applyValuationOutflow / applyValuationReturn) and the movements that must stay
 * valuation-neutral. The seams themselves are pinned where their fixtures live: production issue
 * and return in story-6-2, spares in story-7-4, job-work own material in story-9-3, customer
 * dispatch in story-3-10-dispatch.
 */
describe('Pilot A: inventory valuation follows outflows', () => {
  let server: Server;
  let port: number;
  let plannerHeaders: Record<string, string>;
  let plannerUserId: string;
  let storeHeaders: Record<string, string>;

  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binA = randomUUID();
  const binB = randomUUID();

  async function seedItem(sku: string, valuationMethod = 'weighted_average'): Promise<string> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, $2, 'production', 'active')`,
      [sku, valuationMethod],
    );
    return sku;
  }

  function stockEvent(
    eventType: 'stock.received' | 'stock.issued',
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: eventType,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        payload: { business_stream: 'production', target_location_id: binA, ...payload },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
  }

  async function receive(sku: string, quantity: number, unitCost?: number): Promise<void> {
    const res = await stockEvent('stock.received', {
      sku,
      quantity,
      ...(unitCost !== undefined ? { unit_cost: unitCost } : {}),
    });
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
  }

  async function valuationRow(sku: string): Promise<{ quantity: number; value: number } | null> {
    const r = await getPool().query(
      `SELECT quantity_on_hand::float AS quantity, carrying_value::float AS value
         FROM inventory_valuation WHERE sku = $1`,
      [sku],
    );
    return r.rows.length > 0 ? (r.rows[0] as { quantity: number; value: number }) : null;
  }

  async function valuationText(sku: string): Promise<{ quantity: string; value: string } | null> {
    const r = await getPool().query(
      `SELECT quantity_on_hand::text AS quantity, carrying_value::text AS value
         FROM inventory_valuation WHERE sku = $1`,
      [sku],
    );
    return r.rows.length > 0 ? (r.rows[0] as { quantity: string; value: string }) : null;
  }

  /** Runs a seam helper the way an applier does: on one client, inside one transaction. */
  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  before(async () => {
    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $5, 'site', NULL, $1, 'general', 'ambient', false, 'active'),
              ($2, $6, 'zone', $1, $1, 'general', 'ambient', false, 'active'),
              ($3, $7, 'bin', $2, $1, 'general', 'ambient', false, 'active'),
              ($4, $8, 'bin', $2, $1, 'general', 'ambient', false, 'active')`,
      [
        siteId,
        zoneId,
        binA,
        binB,
        `PA-SITE-${run}`,
        `PA-ZONE-${run}`,
        `PA-A-${run}`,
        `PA-B-${run}`,
      ],
    );

    const provision = async (externalId: string, roles: unknown[]): Promise<string> => {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/scim/v2/Users',
        { externalId, email: externalId, displayName: externalId, roles },
        SCIM_HEADERS,
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body['userId'] as string;
    };
    const authFor = async (sub: string): Promise<Record<string, string>> => {
      const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
      assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
      return { Authorization: `Bearer ${res.body['token'] as string}` };
    };
    plannerUserId = await provision(`pa-planner-${run}@example.com`, [
      {
        role: 'inventory_planner',
        module: 'inventory',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    plannerHeaders = await authFor(`pa-planner-${run}@example.com`);
    await provision(`pa-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(`pa-store-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('a weighted-average outflow relieves quantity and value at the running average, as strings', async () => {
    const sku = await seedItem(`SKU-PA-AVG-${run}`);
    await receive(sku, 10, 4);
    await receive(sku, 10, 6);
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '4' }, c));
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 16, value: 80 });
    for (const key of ['unit_cost', 'valued_quantity', 'unvalued_quantity', 'value'] as const) {
      assert.strictEqual(typeof block[key], 'string', `${key} is a NUMERIC string`);
    }
    assert.strictEqual(Number(block.unit_cost), 5);
    assert.strictEqual(Number(block.value), 20);
    assert.strictEqual(Number(block.unvalued_quantity), 0);
  });

  it('an outflow larger than the valued quantity succeeds and records the unvalued remainder', async () => {
    const sku = await seedItem(`SKU-PA-OVER-${run}`);
    await receive(sku, 6, 10);
    await receive(sku, 50); // unpriced: physical stock with no cost basis
    const before = await valuationRow(sku);
    assert.deepStrictEqual(before, { quantity: 6, value: 60 });
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '20' }, c));
    assert.strictEqual(Number(block.valued_quantity), 6);
    assert.strictEqual(Number(block.unvalued_quantity), 14);
    assert.strictEqual(Number(block.value), 60);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 0, value: 0 });
  });

  it('stock that was never valued flows out untouched: everything is recorded unvalued', async () => {
    const sku = await seedItem(`SKU-PA-NONE-${run}`);
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '3' }, c));
    assert.strictEqual(block.unit_cost, null);
    assert.strictEqual(Number(block.valued_quantity), 0);
    assert.strictEqual(Number(block.unvalued_quantity), 3);
    const row = await valuationRow(sku);
    assert.ok(row === null || (row.quantity === 0 && row.value === 0), JSON.stringify(row));
  });

  it('a fifo outflow consumes the oldest layers and stops where they end', async () => {
    const sku = await seedItem(`SKU-PA-FIFO-${run}`, 'fifo');
    await receive(sku, 5, 2);
    await receive(sku, 5, 4);
    const first = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '7' }, c));
    assert.strictEqual(Number(first.value), 5 * 2 + 2 * 4);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 3, value: 12 });
    const second = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '9' }, c));
    assert.strictEqual(Number(second.valued_quantity), 3);
    assert.strictEqual(Number(second.unvalued_quantity), 6);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 0, value: 0 });
  });

  it('a specific_identification outflow without serials relieves nothing, like its receipt side', async () => {
    const sku = await seedItem(`SKU-PA-SI-${run}`, 'specific_identification');
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '2' }, c));
    assert.strictEqual(Number(block.valued_quantity), 0);
    assert.strictEqual(Number(block.unvalued_quantity), 2);
  });

  it('a specific_identification outflow lowers quantity on hand at cost 0, as stock.issued does', async () => {
    const sku = await seedItem(`SKU-PA-SIQ-${run}`, 'specific_identification');
    // The summary row of a serial-costed item, as priced serial receipts leave it.
    await getPool().query(
      `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value)
       VALUES ($1, 5, 10, 50)`,
      [sku],
    );
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '2' }, c));
    assert.strictEqual(Number(block.valued_quantity), 0);
    assert.strictEqual(Number(block.unvalued_quantity), 2);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 3, value: 50 });
  });

  /** An NRV write-down as the 2.4 seam leaves the row (the DOA-gated route is pinned in story-2-4). */
  async function writeDown(sku: string, carrying: string, originalCost: string): Promise<void> {
    await getPool().query(
      `UPDATE inventory_valuation
          SET carrying_value = $2::numeric, pre_writedown_cost = $3::numeric,
              cumulative_write_down = $3::numeric - $2::numeric
        WHERE sku = $1`,
      [sku, carrying, originalCost],
    );
  }

  it('after an NRV write-down a full outflow relieves exactly the carrying value, and says so', async () => {
    const sku = await seedItem(`SKU-PA-NRV-ALL-${run}`);
    await receive(sku, 100, 10);
    await writeDown(sku, '700', '1000');
    const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '100' }, c));
    assert.strictEqual(block.value, '700.000000');
    assert.strictEqual(block.unit_cost, '7.000000');
    assert.deepStrictEqual(await valuationText(sku), {
      quantity: '0.000000',
      value: '0.000000',
    });
  });

  it('after an NRV write-down a partial outflow and its return move at the carrying cost per unit', async () => {
    const sku = await seedItem(`SKU-PA-NRV-HALF-${run}`);
    await receive(sku, 100, 10);
    await writeDown(sku, '700', '1000');
    const issue = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '50' }, c));
    assert.strictEqual(issue.value, '350.000000');
    assert.deepStrictEqual(await valuationText(sku), {
      quantity: '50.000000',
      value: '350.000000',
    });
    const back = await inTransaction((c) =>
      applyValuationReturn({ sku, quantity: '50', issue, returned_before: '0' }, c, randomUUID()),
    );
    assert.strictEqual(back.value, '350.000000', 'never the 500 of the historical average');
    assert.deepStrictEqual(await valuationText(sku), {
      quantity: '100.000000',
      value: '700.000000',
    });
  });

  it('many small fifo layers with 6-dp costs relieve to exactly the carrying value, no dust layer', async () => {
    const sku = await seedItem(`SKU-PA-FIFO-DP-${run}`, 'fifo');
    for (let i = 0; i < 7; i += 1) {
      await receive(sku, 1000000.000001 + i, 999999.999999 - i);
    }
    const start = await valuationText(sku);
    const micros = (v: string): bigint => {
      const [int, frac = ''] = v.split('.');
      return BigInt(int! + frac.padEnd(6, '0').slice(0, 6));
    };
    let relieved = 0n;
    for (const quantity of ['2500000.5', '1500000.25', '9000000']) {
      const block = await inTransaction((c) => applyValuationOutflow({ sku, quantity }, c));
      relieved += micros(block.value);
    }
    assert.strictEqual(relieved, micros(start!.value), 'blocks sum to the carrying value');
    assert.deepStrictEqual(await valuationText(sku), {
      quantity: '0.000000',
      value: '0.000000',
    });
    const open = await getPool().query(
      `SELECT count(*)::int AS n FROM inventory_valuation_fifo_layer
        WHERE sku = $1 AND remaining_quantity > 0`,
      [sku],
    );
    assert.strictEqual(open.rows[0]!['n'], 0);
  });

  it('the last of N partial returns restores exactly what is left of the issue value', async () => {
    const sku = await seedItem(`SKU-PA-RET-N-${run}`);
    await receive(sku, 1, 1);
    await receive(sku, 2, 2); // 3 on hand carrying 5: the average 1.666667 does not divide evenly
    const issue = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '3' }, c));
    assert.strictEqual(issue.value, '5.000000');
    for (const returnedBefore of ['0', '1', '2']) {
      await inTransaction((c) =>
        applyValuationReturn(
          { sku, quantity: '1', issue, returned_before: returnedBefore },
          c,
          randomUUID(),
        ),
      );
    }
    assert.deepStrictEqual(await valuationText(sku), {
      quantity: '3.000000',
      value: '5.000000',
    });
  });

  it('a return adds back the valued share at the issue cost, never the current average', async () => {
    const sku = await seedItem(`SKU-PA-RET-${run}`);
    await receive(sku, 10, 5);
    const issue = await inTransaction((c) => applyValuationOutflow({ sku, quantity: '10' }, c));
    await receive(sku, 10, 50);
    const back = await inTransaction((c) =>
      applyValuationReturn({ sku, quantity: '4', issue, returned_before: '0' }, c, randomUUID()),
    );
    assert.strictEqual(Number(back.value), 20);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 14, value: 520 });

    // Half of this issue was unvalued, so half of a return comes back; a pre-ruling issue (no
    // block) restores nothing.
    const half: ValuationOutflow = {
      ...issue,
      valued_quantity: '5',
      unvalued_quantity: '5',
      value: '25',
    };
    const partial = await inTransaction((c) =>
      applyValuationReturn(
        { sku, quantity: '4', issue: half, returned_before: '0' },
        c,
        randomUUID(),
      ),
    );
    assert.strictEqual(Number(partial.valued_quantity), 2);
    assert.strictEqual(Number(partial.unvalued_quantity), 2);
    const legacy = await inTransaction((c) =>
      applyValuationReturn(
        { sku, quantity: '4', issue: null, returned_before: '0' },
        c,
        randomUUID(),
      ),
    );
    assert.strictEqual(Number(legacy.valued_quantity), 0);
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 16, value: 530 });
  });

  it('an idempotent re-post of an inventory issue relieves valuation once', async () => {
    const sku = await seedItem(`SKU-PA-IDEM-${run}`);
    await receive(sku, 10, 3);
    const key = randomUUID();
    const first = await stockEvent('stock.issued', { sku, quantity: 2 }, key);
    assert.ok(first.status >= 200 && first.status < 300, JSON.stringify(first.body));
    const again = await stockEvent('stock.issued', { sku, quantity: 2 }, key);
    assert.ok(again.status >= 200 && again.status < 300, JSON.stringify(again.body));
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 8, value: 24 });
  });

  it('a consignment issue never touches valuation', async () => {
    const sku = await seedItem(`SKU-PA-CON-${run}`);
    await getPool().query(
      `INSERT INTO ownership_agreement (agreement_id, sku, location_id, stock_class, owner_party_code, business_stream)
       VALUES ($1, $2, $3, 'consignment', 'SUP-PA', 'production')`,
      [randomUUID(), sku, binA],
    );
    await receive(sku, 10, 7); // owned, valued
    const con = { sku, stock_class: 'consignment', owner_party_code: 'SUP-PA' };
    const inbound = await stockEvent('stock.received', { ...con, quantity: 10 });
    assert.ok(inbound.status >= 200 && inbound.status < 300, JSON.stringify(inbound.body));
    const outbound = await stockEvent('stock.issued', { ...con, quantity: 4 });
    assert.ok(outbound.status >= 200 && outbound.status < 300, JSON.stringify(outbound.body));
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 10, value: 70 });
  });

  it('a bin move is a relocation and leaves valuation exactly as it was', async () => {
    const sku = await seedItem(`SKU-PA-MOVE-${run}`);
    await receive(sku, 10, 7);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/stock/bin-moves',
      {
        site_id: siteId,
        idempotency_key: randomUUID(),
        sku,
        from_location_id: binA,
        to_location_id: binB,
        quantity: 4,
      },
      storeHeaders,
    );
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));
    assert.deepStrictEqual(await valuationRow(sku), { quantity: 10, value: 70 });
  });
});
