import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
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
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/**
 * Pilot G3 (owner ruling 2026-09-20): a storekeeper moves stock from one bin to another inside ONE
 * site. One stock.bin_moved event on the warehouse stream relocates the balance with the putaway
 * mechanism (no valuation movement, no issue-clock reset); the rules live in the applier so a
 * direct event post is refused exactly as the REST route is.
 */
describe('Pilot G3 same-site bin-to-bin move', () => {
  let server: Server;
  let port: number;
  let storeHeaders: Record<string, string>;
  let binScopedHeaders: Record<string, string>;
  let qualityHeaders: Record<string, string>;
  let wildcardHeaders: Record<string, string>;
  let dispatchHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let splitHeaders: Record<string, string>;

  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binA = randomUUID();
  const binB = randomUUID();
  const quarantineBinId = randomUUID();
  const inactiveBinId = randomUUID();
  const otherSiteId = randomUUID();
  const otherSiteBinId = randomUUID();
  const binACode = `G3A-${run}`;
  const binBCode = `G3B-${run}`;

  async function seedLocation(
    locationId: string,
    code: string,
    level: string,
    parentId: string | null,
    options: { site?: string; quarantine?: boolean; status?: string } = {},
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, $6, false, $7)`,
      [
        locationId,
        code,
        level,
        parentId,
        options.site ?? siteId,
        options.quarantine ?? false,
        options.status ?? 'active',
      ],
    );
  }

  async function seedItem(
    sku: string,
    lotControlled = false,
    serialControlled = false,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', $2, $3, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku, lotControlled, serialControlled],
    );
  }

  async function seedSerial(
    sku: string,
    serial: string,
    locationId: string,
    quantity = 1,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO serial_master (serial_number, sku, current_location_id, current_location_code, current_quantity)
       VALUES ($1, $2, $3, 'G3', $4)`,
      [serial, sku, locationId, quantity],
    );
  }

  async function serialLocation(sku: string, serial: string): Promise<string | null> {
    const r = await getPool().query(
      `SELECT current_location_id FROM serial_master WHERE sku = $1 AND serial_number = $2`,
      [sku, serial],
    );
    return (r.rows[0]?.['current_location_id'] as string | null) ?? null;
  }

  async function seedLot(lotNumber: string, sku: string): Promise<void> {
    await getPool().query(`INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3)`, [
      randomUUID(),
      lotNumber,
      sku,
    ]);
  }

  async function seedStock(
    sku: string,
    locationId: string,
    lotNumber: string | null,
    onHand: number,
    allocated = 0,
    stockClass = 'owned',
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated)
       VALUES ($1, $2, $3, $6, $4, $5)`,
      [sku, locationId, lotNumber, onHand, allocated, stockClass],
    );
  }

  /** Posts a raw stock.bin_moved envelope at the events door, or (with an event id) the edge door. */
  function directEvent(
    path: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    options: { eventId?: string; actorLocationId?: string } = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      path,
      {
        ...(options.eventId ? { event_id: options.eventId } : {}),
        stream_type: 'warehouse',
        stream_id: randomUUID(),
        event_type: 'stock.bin_moved',
        payload: { site_id: siteId, quantity: '1', stock_class: 'owned', ...payload },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: randomUUID(),
            role: 'store_assistant',
            location_id: options.actorLocationId ?? siteId,
          },
          occurred_at: new Date().toISOString(),
          ...(options.eventId ? { device_id: `g3-${run}` } : {}),
        },
        idempotency_key: randomUUID(),
      },
      headers,
    );
  }

  async function onHandAt(sku: string, locationId: string): Promise<number> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, locationId],
    );
    return r.rows[0]!['on_hand'] as number;
  }

  async function skuTotals(sku: string): Promise<{ onHand: number; available: number }> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float AS on_hand, COALESCE(SUM(available), 0)::float AS available
         FROM stock_balance WHERE sku = $1`,
      [sku],
    );
    return {
      onHand: r.rows[0]!['on_hand'] as number,
      available: r.rows[0]!['available'] as number,
    };
  }

  async function movedEventCount(sku: string): Promise<number> {
    const r = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events WHERE event_type = 'stock.bin_moved' AND payload->>'sku' = $1`,
      [sku],
    );
    return r.rows[0]!['n'] as number;
  }

  function move(
    body: Record<string, unknown>,
    headers: Record<string, string> = storeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/stock/bin-moves',
      { site_id: siteId, idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  /** Asserts a refusal that wrote no event and moved nothing out of bin A. */
  async function assertRefused(
    res: HttpResult,
    status: number,
    code: string,
    sku: string,
    onHandA: number,
  ): Promise<void> {
    assert.strictEqual(res.status, status, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], code);
    assert.strictEqual(await movedEventCount(sku), 0);
    assert.strictEqual(await onHandAt(sku, binA), onHandA);
  }

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await seedLocation(siteId, `G3SITE-${run}`, 'site', null);
    await seedLocation(zoneId, `G3ZONE-${run}`, 'zone', siteId);
    await seedLocation(binA, binACode, 'bin', zoneId);
    await seedLocation(binB, binBCode, 'bin', zoneId);
    await seedLocation(quarantineBinId, `G3Q-${run}`, 'bin', zoneId, { quarantine: true });
    await seedLocation(inactiveBinId, `G3OFF-${run}`, 'bin', zoneId, { status: 'inactive' });
    await seedLocation(otherSiteId, `G3SITE2-${run}`, 'site', null, { site: otherSiteId });
    await seedLocation(otherSiteBinId, `G3OTHER-${run}`, 'bin', otherSiteId, {
      site: otherSiteId,
    });

    await provisionUser(port, `g3-store-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    storeHeaders = await authFor(port, `g3-store-${run}@example.com`);
    await provisionUser(port, `g3-binonly-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: binA },
    ]);
    binScopedHeaders = await authFor(port, `g3-binonly-${run}@example.com`);
    await provisionUser(port, `g3-quality-${run}@example.com`, [
      { role: 'quality_officer', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);
    qualityHeaders = await authFor(port, `g3-quality-${run}@example.com`);
    // Covers every location, so the applier's own site rule is what refuses another site's bin.
    await provisionUser(port, `g3-wildcard-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write', locationId: '*' },
    ]);
    wildcardHeaders = await authFor(port, `g3-wildcard-${run}@example.com`);
    await provisionUser(port, `g3-dispatch-${run}@example.com`, [
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'write', locationId: siteId },
    ]);
    dispatchHeaders = await authFor(port, `g3-dispatch-${run}@example.com`);
    await provisionUser(port, `g3-manager-${run}@example.com`, [
      {
        role: 'warehouse_manager',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
      {
        role: 'inventory_controller',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    managerHeaders = await authFor(port, `g3-manager-${run}@example.com`);
    // Review R2: the bin-move role is held at ANOTHER site; only a non-bin-move role reaches this one.
    await provisionUser(port, `g3-split-${run}@example.com`, [
      {
        role: 'store_assistant',
        module: 'warehouse',
        functionScope: 'write',
        locationId: otherSiteId,
      },
      {
        role: 'warehouse_operator',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    splitHeaders = await authFor(port, `g3-split-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  it('plain item: moves between bins, SKU totals and valuation unchanged, FROM bin stamped', async () => {
    const sku = `G3-PLAIN-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    await getPool().query(
      `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value) VALUES ($1, 10, 7, 70)`,
      [sku],
    );
    const valuation = async (): Promise<Record<string, unknown>[]> =>
      (await getPool().query(`SELECT * FROM inventory_valuation WHERE sku = $1`, [sku])).rows;
    const valuationBefore = await valuation();
    const totalsBefore = await skuTotals(sku);

    const res = await move({
      sku,
      from_location_id: binA,
      to_location_code: binBCode,
      quantity: 4,
      reason: 'consolidate',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['replayed'], false);
    assert.strictEqual(await onHandAt(sku, binA), 6);
    assert.strictEqual(await onHandAt(sku, binB), 4);
    assert.deepStrictEqual(await skuTotals(sku), totalsBefore);
    assert.deepStrictEqual(await valuation(), valuationBefore);

    const clock = await getPool().query(
      `SELECT 1 FROM stock_balance WHERE sku = $1 AND last_issue_at IS NOT NULL`,
      [sku],
    );
    assert.strictEqual(clock.rows.length, 0, 'a bin move must not start the issue clock');

    const stored = await getPool().query(
      `SELECT stream_type, metadata->'actor'->>'location_id' AS location_id FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    assert.strictEqual(stored.rows[0]!['stream_type'], 'warehouse');
    assert.strictEqual(stored.rows[0]!['location_id'], binA);
    const audit = await getPool().query(`SELECT location_id FROM audit_log WHERE event_id = $1`, [
      res.body['event_id'],
    ]);
    assert.strictEqual(audit.rows[0]!['location_id'], binA);
  });

  it('lot item: the lot key moves as that lot', async () => {
    const sku = `G3-LOT-${run}`;
    const lotNumber = `G3LOT-${run}`;
    await seedItem(sku, true);
    await seedLot(lotNumber, sku);
    await seedStock(sku, binA, lotNumber, 8);

    const res = await move({
      sku,
      from_location_code: binACode,
      to_location_id: binB,
      quantity: 8,
      lot_number: lotNumber,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const rows = await getPool().query(
      `SELECT location_id, lot_id, on_hand::float AS on_hand FROM stock_balance WHERE sku = $1 AND on_hand <> 0`,
      [sku],
    );
    assert.deepStrictEqual(rows.rows, [{ location_id: binB, lot_id: lotNumber, on_hand: 8 }]);
  });

  it('a lot-controlled item requires a lot and a plain item forbids one', async () => {
    const lotSku = `G3-NEEDLOT-${run}`;
    await seedItem(lotSku, true);
    await seedLot(`G3NL-${run}`, lotSku);
    await seedStock(lotSku, binA, `G3NL-${run}`, 5);
    await assertRefused(
      await move({ sku: lotSku, from_location_id: binA, to_location_id: binB, quantity: 1 }),
      400,
      'BIN_MOVE_LOT_REQUIRED',
      lotSku,
      5,
    );

    const plainSku = `G3-NOLOT-${run}`;
    await seedItem(plainSku);
    await seedStock(plainSku, binA, null, 5);
    await assertRefused(
      await move({
        sku: plainSku,
        from_location_id: binA,
        to_location_id: binB,
        quantity: 1,
        lot_number: 'ANY',
      }),
      400,
      'BIN_MOVE_LOT_NOT_ALLOWED',
      plainSku,
      5,
    );
  });

  it('a bin of another site, a zone row, an inactive bin and the same bin are refused', async () => {
    const sku = `G3-DEST-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    for (const to of [otherSiteBinId, zoneId, inactiveBinId]) {
      await assertRefused(
        await move(
          { sku, from_location_id: binA, to_location_id: to, quantity: 1 },
          wildcardHeaders,
        ),
        409,
        'BIN_MOVE_LOCATION_INVALID',
        sku,
        5,
      );
    }
    await assertRefused(
      await move({ sku, from_location_id: binA, to_location_id: binA, quantity: 1 }),
      400,
      'BIN_MOVE_SAME_LOCATION',
      sku,
      5,
    );
  });

  it('more than the available quantity is refused, and allocated stock is not movable', async () => {
    const sku = `G3-AVAIL-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10, 7);
    await assertRefused(
      await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 4 }),
      409,
      'BIN_MOVE_INSUFFICIENT_AVAILABLE',
      sku,
      10,
    );
    await assertRefused(
      await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 0 }),
      400,
      'BIN_MOVE_QUANTITY_INVALID',
      sku,
      10,
    );
    const ok = await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 3 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const left = await getPool().query(
      `SELECT on_hand::float AS on_hand, allocated::float AS allocated FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, binA],
    );
    assert.deepStrictEqual(left.rows, [{ on_hand: 7, allocated: 7 }]);
  });

  it('a held lot is refused into a normal bin and moves into a quarantine bin', async () => {
    const sku = `G3-HOLD-${run}`;
    const lotNumber = `G3HOLD-${run}`;
    await seedItem(sku, true);
    await seedLot(lotNumber, sku);
    await seedStock(sku, binA, lotNumber, 5);
    const hold = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${lotNumber}/quality-hold`,
      { hold_reason: 'pilot G3 manual hold' },
      qualityHeaders,
    );
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    const body = { sku, from_location_id: binA, quantity: 5, lot_number: lotNumber };
    await assertRefused(
      await move({ ...body, to_location_id: binB }),
      409,
      'BIN_MOVE_QC_HOLD_QUARANTINE_REQUIRED',
      sku,
      5,
    );
    const ok = await move({ ...body, to_location_id: quarantineBinId });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await onHandAt(sku, quarantineBinId), 5);
  });

  it('a user without a warehouse role is refused 403', async () => {
    const sku = `G3-ROLE-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    const res = await move(
      { sku, from_location_id: binA, to_location_id: binB, quantity: 1 },
      qualityHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(await movedEventCount(sku), 0);
  });

  it('a bin-scoped user who does not cover the destination is refused', async () => {
    const sku = `G3-COVER-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    await assertRefused(
      await move(
        { sku, from_location_id: binA, to_location_id: binB, quantity: 1 },
        binScopedHeaders,
      ),
      403,
      'LOCATION_ACCESS_DENIED',
      sku,
      5,
    );
  });

  it('a direct stock.bin_moved event is held to the same rules', async () => {
    const sku = `G3-DIRECT-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: randomUUID(),
        event_type: 'stock.bin_moved',
        payload: {
          site_id: siteId,
          sku,
          from_location_id: binA,
          to_location_id: otherSiteBinId,
          quantity: '1',
          stock_class: 'owned',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'store_assistant', location_id: siteId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      // Covers every location, so the door admits the post and the applier's site rule refuses it.
      wildcardHeaders,
    );
    await assertRefused(res, 409, 'BIN_MOVE_LOCATION_INVALID', sku, 5);
  });

  it('a replay with the same key returns the original event and moves nothing twice', async () => {
    const sku = `G3-REPLAY-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    const body = {
      sku,
      from_location_id: binA,
      to_location_id: binB,
      quantity: 4,
      idempotency_key: randomUUID(),
    };
    const first = await move(body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await move(body);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body['replayed'], true);
    assert.strictEqual(second.body['event_id'], first.body['event_id']);
    assert.strictEqual(await movedEventCount(sku), 1);
    assert.strictEqual(await onHandAt(sku, binB), 4);
  });

  it('a concurrent double-submit with the same key yields one event and one move', async () => {
    const sku = `G3-RACE-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    const body = {
      sku,
      from_location_id: binA,
      to_location_id: binB,
      quantity: 6,
      idempotency_key: randomUUID(),
    };
    const results = await Promise.all([move(body), move(body), move(body)]);
    for (const r of results)
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    assert.strictEqual(new Set(results.map((r) => r.body['event_id'])).size, 1);
    assert.strictEqual(await movedEventCount(sku), 1);
    assert.strictEqual(await onHandAt(sku, binA), 4);
    assert.strictEqual(await onHandAt(sku, binB), 6);
  });

  it('review R1: a dispatch clerk cannot post stock.bin_moved through the events door', async () => {
    const sku = `G3-R1A-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    await assertRefused(
      await directEvent(
        '/api/v1/events',
        { sku, from_location_id: binA, to_location_id: binB },
        dispatchHeaders,
      ),
      403,
      'FUNCTION_ACCESS_DENIED',
      sku,
      5,
    );
  });

  it('review R1: a store assistant through the events door meets every applier rule', async () => {
    const sku = `G3-R1B-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5, 4);
    await assertRefused(
      await directEvent(
        '/api/v1/events',
        { sku, from_location_id: binA, to_location_id: binB, quantity: '2' },
        storeHeaders,
      ),
      409,
      'BIN_MOVE_INSUFFICIENT_AVAILABLE',
      sku,
      5,
    );
    // The bin-scoped storekeeper is held to the same two-bin coverage as on the REST route.
    await assertRefused(
      await directEvent(
        '/api/v1/events',
        { sku, from_location_id: binA, to_location_id: binB },
        binScopedHeaders,
        { actorLocationId: binA },
      ),
      403,
      'LOCATION_ACCESS_DENIED',
      sku,
      5,
    );
    const ok = await directEvent(
      '/api/v1/events',
      { sku, from_location_id: binA, to_location_id: binB },
      storeHeaders,
    );
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await onHandAt(sku, binB), 1);
  });

  it('review R1: the edge door refuses stock.bin_moved outright', async () => {
    const sku = `G3-R1C-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    await assertRefused(
      await directEvent(
        '/api/v1/edge/events',
        { sku, from_location_id: binA, to_location_id: binB },
        storeHeaders,
        { eventId: randomUUID() },
      ),
      403,
      'CENTRAL_ONLY_OPERATION',
      sku,
      5,
    );
  });

  it('review R2: a bin-move role at another site lends no privilege to this site', async () => {
    const sku = `G3-R2-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    await assertRefused(
      await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 1 }, splitHeaders),
      403,
      'LOCATION_ACCESS_DENIED',
      sku,
      5,
    );
    await assertRefused(
      await directEvent(
        '/api/v1/events',
        { sku, from_location_id: binA, to_location_id: binB },
        splitHeaders,
      ),
      403,
      'LOCATION_ACCESS_DENIED',
      sku,
      5,
    );
  });

  it('review R3: the same key with a different body is a 409 that names no event', async () => {
    const sku = `G3-R3-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    const body = {
      sku,
      from_location_id: binA,
      to_location_id: binB,
      quantity: 4,
      idempotency_key: randomUUID(),
    };
    const first = await move(body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    for (const changed of [
      { quantity: 5 },
      { to_location_id: quarantineBinId },
      { stock_class: 'consignment' },
    ]) {
      const res = await move({ ...body, ...changed });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'IDEMPOTENCY_KEY_CONFLICT');
      assert.ok(!res.raw.includes(first.body['event_id'] as string), res.raw);
    }
    // Another user colliding on the key learns nothing about the original event.
    const foreign = await move(body, wildcardHeaders);
    assert.strictEqual(foreign.status, 409, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'IDEMPOTENCY_KEY_CONFLICT');
    assert.ok(!foreign.raw.includes(first.body['event_id'] as string), foreign.raw);
    assert.strictEqual(await movedEventCount(sku), 1);
    assert.strictEqual(await onHandAt(sku, binB), 4);
  });

  it('review R4: warehouse manager and inventory controller may not move stock', async () => {
    const sku = `G3-R4-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 5);
    await assertRefused(
      await move(
        { sku, from_location_id: binA, to_location_id: binB, quantity: 1 },
        managerHeaders,
      ),
      403,
      'FUNCTION_ACCESS_DENIED',
      sku,
      5,
    );
  });

  it('review R5: stock an open putaway task still needs stays put; the surplus moves', async () => {
    const sku = `G3-R5-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    const taskId = randomUUID();
    await getPool().query(
      `INSERT INTO putaway_task (putaway_task_id, grn_line_id, sku, lot_id, quantity, from_location_id, site_id, status, source_event_id)
       VALUES ($1, $2, $3, NULL, 6, $4, $5, 'ready', $6)`,
      [taskId, randomUUID(), sku, binA, siteId, randomUUID()],
    );
    const refused = await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 5 });
    await assertRefused(refused, 409, 'BIN_MOVE_STOCK_RESERVED_BY_TASK', sku, 10);
    assert.ok(refused.raw.includes(taskId), refused.raw);
    const ok = await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 4 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await onHandAt(sku, binA), 6);
  });

  it('review R5: an open replenishment task sourcing from the bin reserves its quantity', async () => {
    const sku = `G3-R5B-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 10);
    const taskId = randomUUID();
    await getPool().query(
      `INSERT INTO replenishment_task (replenishment_task_id, sku, zone_id, site_id, from_location_id, quantity, signal_type, status, correlation_id, source_event_id)
       VALUES ($1, $2, $3, $4, $5, 8, 'min_max', 'ready', $6, $7)`,
      [taskId, sku, zoneId, siteId, binA, randomUUID(), randomUUID()],
    );
    const refused = await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 3 });
    await assertRefused(refused, 409, 'BIN_MOVE_STOCK_RESERVED_BY_TASK', sku, 10);
    assert.ok(refused.raw.includes(taskId), refused.raw);
    const ok = await move({ sku, from_location_id: binA, to_location_id: binB, quantity: 2 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  });

  it('review R7a: concurrent opposite moves never deadlock into a 500', async () => {
    const sku = `G3-R7A-${run}`;
    await seedItem(sku);
    await seedStock(sku, binA, null, 50);
    await seedStock(sku, binB, null, 50);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? move({ sku, from_location_id: binA, to_location_id: binB, quantity: 1 })
          : move({ sku, from_location_id: binB, to_location_id: binA, quantity: 1 }),
      ),
    );
    for (const r of results)
      assert.ok(r.status === 201 || r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await skuTotals(sku)).onHand, 100);
  });

  it('review R7b: a consignment and a job_work balance move and keep their class', async () => {
    for (const stockClass of ['consignment', 'job_work']) {
      const sku = `G3-R7B-${stockClass}-${run}`;
      await seedItem(sku);
      await seedStock(sku, binA, null, 5, 0, stockClass);
      const res = await move({
        sku,
        from_location_id: binA,
        to_location_id: binB,
        quantity: 2,
        stock_class: stockClass,
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const rows = await getPool().query(
        `SELECT stock_class, on_hand::float AS on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2`,
        [sku, binB],
      );
      assert.deepStrictEqual(rows.rows, [{ stock_class: stockClass, on_hand: 2 }]);
    }
  });

  it('review R7c: serials move with their units; a wrong-bin, spent or promised serial does not', async () => {
    const sku = `G3-R7C-${run}`;
    await seedItem(sku, false, true);
    await seedStock(sku, binA, null, 3);
    await seedStock(sku, binB, null, 1);
    await seedSerial(sku, 'S1', binA);
    await seedSerial(sku, 'S2', binA);
    await seedSerial(sku, 'S3', binA, 0);
    await seedSerial(sku, 'S4', binB);
    const body = { sku, from_location_id: binA, to_location_id: binB };

    const ok = await move({ ...body, quantity: 1, serials: ['S1'] });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await serialLocation(sku, 'S1'), binB);
    assert.strictEqual(await onHandAt(sku, binB), 2);

    for (const serial of ['S4', 'S3']) {
      const res = await move({ ...body, quantity: 1, serials: [serial] });
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'BIN_MOVE_SERIALS_INVALID');
    }
    const noSerials = await move({ ...body, quantity: 1 });
    assert.strictEqual(noSerials.status, 400, JSON.stringify(noSerials.body));

    // The platform promises stock by quantity: once the bin's units are allocated to a pick, the
    // serials in it are not relocatable either.
    await getPool().query(
      `UPDATE stock_balance SET allocated = on_hand WHERE sku = $1 AND location_id = $2`,
      [sku, binA],
    );
    const picked = await move({ ...body, quantity: 1, serials: ['S2'] });
    assert.strictEqual(picked.status, 409, JSON.stringify(picked.body));
    assert.strictEqual(picked.body['error_code'], 'BIN_MOVE_INSUFFICIENT_AVAILABLE');
    assert.strictEqual(await serialLocation(sku, 'S2'), binA);
    assert.strictEqual(await onHandAt(sku, binA), 2);
  });
});
