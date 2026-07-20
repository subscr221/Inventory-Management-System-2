import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import type { EventEnvelope } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.2: real-time multi-location stock balances. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, SCIM provisioning, and PostgreSQL. Tests in this suite
// build on each other's committed balances and run serially (npm test uses --test-concurrency=1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const SKU = 'RM-0042';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
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

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/** Stock event envelope (Story 2.2 canonical shape: sku + target_location + quantity). */
function stockEnvelope(
  eventType: string,
  payload: Record<string, unknown>,
  extra: { stream_id?: string; idempotency_key?: string; event_id?: string; device_id?: string; actor_location_id?: string } = {},
) {
  return {
    ...(extra.event_id ? { event_id: extra.event_id } : {}),
    stream_type: 'inventory',
    stream_id: extra.stream_id ?? randomUUID(),
    event_type: eventType,
    payload: { business_stream: 'production', ...payload },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: randomUUID(),
        role: 'stock_admin_2_2',
        location_id: extra.actor_location_id ?? randomUUID(),
      },
      occurred_at: new Date().toISOString(),
      ...(extra.device_id ? { device_id: extra.device_id } : {}),
    },
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  };
}

interface LocationBalance {
  location_id: string;
  location_code: string | null;
  on_hand: number;
  allocated: number;
  available: number;
  in_transit: number;
}

interface StockResponse {
  sku: string;
  locations: LocationBalance[];
  consolidated: { on_hand: number; allocated: number; available: number; in_transit: number };
}

async function domainEventCount(streamId: string): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM domain_events WHERE stream_id = $1`, [streamId]);
  return result.rows[0]!['count'] as number;
}

describe('Story 2.2 Real-Time Multi-Location Stock Balances Integration Tests', () => {
  let server: Server;
  let port: number;
  let operatorHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let scopedReaderHeaders: Record<string, string>;
  let edgeHeaders: Record<string, string>;
  let locAId: string;
  let locBId: string;
  let locCId: string;

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
      '../../read/projections/instrument_calibration.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    // Distinct fixture role strings - business roles and module-access roles share the role
    // assignment projection (Story 2.1 learning).
    await provisionUser(port, 'sb-operator@example.com', [
      { role: 'stock_admin_2_2', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    operatorHeaders = await authFor(port, 'sb-operator@example.com');

    await provisionUser(port, 'sb-reader@example.com', [
      { role: 'stock_reader_2_2', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, 'sb-reader@example.com');

    // Three sites the balances spread across.
    const codes = ['SITE-SB-A', 'SITE-SB-B', 'SITE-SB-C'];
    const ids: string[] = [];
    for (const code of codes) {
      const res = await makeRequest(port, 'POST', '/api/v1/locations', { location_code: code, level: 'site' }, operatorHeaders);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      ids.push(res.body['location_id'] as string);
    }
    [locAId, locBId, locCId] = ids as [string, string, string];

    await provisionUser(port, 'sb-scoped-reader@example.com', [
      { role: 'stock_scoped_reader_2_2', module: 'inventory', functionScope: 'read', locationId: locAId },
    ]);
    scopedReaderHeaders = await authFor(port, 'sb-scoped-reader@example.com');

    await provisionUser(port, 'sb-edge@example.com', [
      { role: 'stock_edge_2_2', module: 'inventory', functionScope: 'write', locationId: locAId },
    ]);
    edgeHeaders = await authFor(port, 'sb-edge@example.com');

    const item = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      { sku: SKU, uom: 'ea', valuation_method: 'fifo', business_stream: 'production', lot_controlled: true },
      operatorHeaders,
    );
    assert.strictEqual(item.status, 201, JSON.stringify(item.body));
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  async function getStock(headers: Record<string, string>, sku = SKU): Promise<{ res: HttpResult; elapsedMs: number }> {
    const started = performance.now();
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${sku}`, undefined, headers);
    return { res, elapsedMs: performance.now() - started };
  }

  function locationEntry(body: StockResponse, locationId: string): LocationBalance {
    const entry = body.locations.find((l) => l.location_id === locationId);
    assert.ok(entry, `response missing location ${locationId}: ${JSON.stringify(body)}`);
    return entry;
  }

  it('AC1 + AC4: receipts across three locations produce per-location and consolidated balances in under 1 second', async () => {
    const receipts = [
      { location_id: locAId, quantity: 100, lot_id: 'LOT-A1', po_line_ref: 'PO-1001/1' },
      { location_id: locBId, quantity: 40, lot_id: 'LOT-B1', po_line_ref: 'PO-1001/2' },
      { location_id: locCId, quantity: 10, lot_id: 'LOT-C1', po_line_ref: 'PO-1002/1' },
    ];
    for (const receipt of receipts) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        stockEnvelope('stock.received', {
          sku: SKU,
          target_location_id: receipt.location_id,
          quantity: receipt.quantity,
          unit_cost: 12.5,
          lot_id: receipt.lot_id,
          po_line_ref: receipt.po_line_ref,
          stock_class: 'owned',
        }),
        operatorHeaders,
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      // AC4: the PO line reference and receipt details are recorded on the persisted event.
      const payload = res.body['payload'] as Record<string, unknown>;
      assert.strictEqual(payload['po_line_ref'], receipt.po_line_ref);
      assert.strictEqual(payload['unit_cost'], 12.5);
      assert.strictEqual(payload['lot_id'], receipt.lot_id);
      assert.strictEqual(payload['stock_class'], 'owned');
    }

    const { res, elapsedMs } = await getStock(readerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(elapsedMs < 1000, `stock query must complete in under 1 second, took ${elapsedMs.toFixed(1)}ms`);

    const body = res.body as unknown as StockResponse;
    assert.strictEqual(body.sku, SKU);
    assert.strictEqual(body.locations.length, 3);
    assert.deepStrictEqual(
      body.locations.map((l) => l.location_code),
      ['SITE-SB-A', 'SITE-SB-B', 'SITE-SB-C'],
      'locations must be sorted deterministically by location_code',
    );
    for (const [locationId, onHand] of [
      [locAId, 100],
      [locBId, 40],
      [locCId, 10],
    ] as const) {
      const entry = locationEntry(body, locationId);
      assert.strictEqual(entry.on_hand, onHand);
      assert.strictEqual(entry.allocated, 0);
      assert.strictEqual(entry.available, onHand);
      assert.strictEqual(entry.in_transit, 0);
    }
    assert.deepStrictEqual(body.consolidated, { on_hand: 150, allocated: 0, available: 150, in_transit: 0 });
  });

  it('AC4: balances are reproducible from the directly posted receipt events', async () => {
    const eventSums = await getPool().query(
      `SELECT payload->>'target_location_id' AS location_id, SUM((payload->>'quantity')::numeric) AS total
       FROM domain_events
       WHERE event_type = 'stock.received' AND payload->>'sku' = $1 AND payload ? 'target_location_id'
       GROUP BY payload->>'target_location_id'`,
      [SKU],
    );
    const projection = await getPool().query(`SELECT location_id, SUM(on_hand) AS on_hand FROM stock_balance WHERE sku = $1 GROUP BY location_id`, [SKU]);
    const fromEvents = new Map(eventSums.rows.map((row) => [row['location_id'] as string, Number(row['total'])]));
    const fromProjection = new Map(projection.rows.map((row) => [row['location_id'] as string, Number(row['on_hand'])]));
    assert.deepStrictEqual(fromProjection, fromEvents, 'projection on_hand must equal the replayed sum of posted receipt events');
  });

  it('AC2: allocation reduces available, leaves on_hand unchanged, and over-allocation is blocked before any event insert', async () => {
    const allocation = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.allocated', { sku: SKU, target_location_id: locAId, quantity: 10, allocation_ref: 'SO-2001' }),
      operatorHeaders,
    );
    assert.strictEqual(allocation.status, 201, JSON.stringify(allocation.body));

    const { res } = await getStock(readerHeaders);
    const body = res.body as unknown as StockResponse;
    const locA = locationEntry(body, locAId);
    assert.strictEqual(locA.on_hand, 100, 'allocation must not change on_hand');
    assert.strictEqual(locA.allocated, 10);
    assert.strictEqual(locA.available, 90);
    assert.deepStrictEqual(body.consolidated, { on_hand: 150, allocated: 10, available: 140, in_transit: 0 });

    // Double allocation beyond the remaining available is blocked with the documented envelope.
    const rejectedStreamId = randomUUID();
    const rejected = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.allocated', { sku: SKU, target_location_id: locAId, quantity: 95 }, { stream_id: rejectedStreamId }),
      operatorHeaders,
    );
    assert.strictEqual(rejected.status, 409, JSON.stringify(rejected.body));
    assert.strictEqual(rejected.body['error_code'], 'INSUFFICIENT_STOCK');
    const details = rejected.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['sku'], SKU);
    assert.strictEqual(details['location_id'], locAId);
    assert.strictEqual(details['requested_quantity'], 95);
    assert.strictEqual(details['available_quantity'], 90);
    assert.strictEqual(await domainEventCount(rejectedStreamId), 0, 'a rejected allocation must not write a domain event');

    const after = await getStock(readerHeaders);
    const afterA = locationEntry(after.res.body as unknown as StockResponse, locAId);
    assert.strictEqual(afterA.allocated, 10, 'a rejected allocation must not change the balance');
  });

  it('AC3: two concurrent transactions racing for the last unit of a lot have exactly one winner', async () => {
    // Seed exactly one unit of a dedicated lot at SITE-SB-C.
    const seed = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.received', {
        sku: SKU,
        target_location_id: locCId,
        quantity: 1,
        unit_cost: 99,
        lot_id: 'LOT-LAST',
        po_line_ref: 'PO-1003/1',
      }),
      operatorHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const envelopeFor = (orderRef: string): EventEnvelope =>
      stockEnvelope(
        'stock.allocated',
        { sku: SKU, target_location_id: locCId, quantity: 1, lot_id: 'LOT-LAST', allocation_ref: orderRef },
        { actor_location_id: locCId },
      ) as unknown as EventEnvelope;

    // Deterministic overlap (Task 5.5): two explicit transactions on two clients. The first holds
    // the FOR UPDATE row lock past its allocation; the second blocks on that lock and must lose
    // after the first commits.
    const pool = getPool();
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    try {
      await client1.query('BEGIN');
      await persistEvent(envelopeFor('SO-3001'), undefined, client1);

      await client2.query('BEGIN');
      const second = persistEvent(envelopeFor('SO-3002'), undefined, client2);
      const raced = await Promise.race([
        second.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolvePromise) => setTimeout(() => resolvePromise('pending'), 300)),
      ]);
      assert.strictEqual(raced, 'pending', 'the second allocation must block on the row lock until the first commits');

      await client1.query('COMMIT');
      await assert.rejects(
        second,
        (err: unknown) =>
          err instanceof AppError &&
          err.statusCode === 409 &&
          err.errorCode === 'INSUFFICIENT_STOCK' &&
          err.details['available_quantity'] === 0,
        'exactly one allocation may win the last unit',
      );
      await client2.query('ROLLBACK');
    } finally {
      client1.release();
      client2.release();
    }

    const winners = await getPool().query(
      `SELECT count(*)::int AS count FROM domain_events WHERE event_type = 'stock.allocated' AND payload->>'lot_id' = 'LOT-LAST'`,
    );
    assert.strictEqual(winners.rows[0]!['count'], 1, 'exactly one stock.allocated event may persist for the contested lot');

    const { res } = await getStock(readerHeaders);
    const locC = locationEntry(res.body as unknown as StockResponse, locCId);
    assert.strictEqual(locC.on_hand, 11);
    assert.strictEqual(locC.allocated, 1);
    assert.strictEqual(locC.available, 10);
  });

  it('idempotent retry of a successful receipt and allocation returns DUPLICATE_EVENT and applies the balance exactly once', async () => {
    const receiptKey = `sb-receipt-${randomUUID()}`;
    const receipt = stockEnvelope(
      'stock.received',
      { sku: SKU, target_location_id: locBId, quantity: 5, unit_cost: 3, lot_id: 'LOT-B1', po_line_ref: 'PO-1004/1' },
      { idempotency_key: receiptKey },
    );
    const first = await makeRequest(port, 'POST', '/api/v1/events', receipt, operatorHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const retry = await makeRequest(port, 'POST', '/api/v1/events', receipt, operatorHeaders);
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((retry.body['details'] as Record<string, unknown>)['existing_event_id'], first.body['event_id']);

    let { res } = await getStock(readerHeaders);
    let locB = locationEntry(res.body as unknown as StockResponse, locBId);
    assert.strictEqual(locB.on_hand, 45, 'the duplicate receipt must not double-apply on_hand');

    const allocationKey = `sb-allocation-${randomUUID()}`;
    const allocation = stockEnvelope(
      'stock.allocated',
      { sku: SKU, target_location_id: locBId, quantity: 5, allocation_ref: 'SO-2002' },
      { idempotency_key: allocationKey },
    );
    const firstAllocation = await makeRequest(port, 'POST', '/api/v1/events', allocation, operatorHeaders);
    assert.strictEqual(firstAllocation.status, 201, JSON.stringify(firstAllocation.body));

    const allocationRetry = await makeRequest(port, 'POST', '/api/v1/events', allocation, operatorHeaders);
    assert.strictEqual(allocationRetry.status, 409, JSON.stringify(allocationRetry.body));
    assert.strictEqual(allocationRetry.body['error_code'], 'DUPLICATE_EVENT');

    ({ res } = await getStock(readerHeaders));
    locB = locationEntry(res.body as unknown as StockResponse, locBId);
    assert.strictEqual(locB.allocated, 5, 'the duplicate allocation must not double-apply allocated');
    assert.strictEqual(locB.available, 40);
  });

  it('a rejected allocation consumes neither an idempotency key nor a domain event row', async () => {
    const reusedKey = `sb-rejected-${randomUUID()}`;
    const rejected = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.allocated', { sku: SKU, target_location_id: locBId, quantity: 10000 }, { idempotency_key: reusedKey }),
      operatorHeaders,
    );
    assert.strictEqual(rejected.status, 409, JSON.stringify(rejected.body));
    assert.strictEqual(rejected.body['error_code'], 'INSUFFICIENT_STOCK');

    // The same idempotency key must still be usable - the rejection consumed nothing.
    const reuse = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope(
        'stock.received',
        { sku: SKU, target_location_id: locBId, quantity: 2, unit_cost: 3, lot_id: 'LOT-B1', po_line_ref: 'PO-1004/2' },
        { idempotency_key: reusedKey },
      ),
      operatorHeaders,
    );
    assert.strictEqual(reuse.status, 201, `the idempotency key of a rejected allocation must remain unconsumed: ${JSON.stringify(reuse.body)}`);

    const { res } = await getStock(readerHeaders);
    const locB = locationEntry(res.body as unknown as StockResponse, locBId);
    assert.strictEqual(locB.on_hand, 47);
  });

  it('location-scoped read access sees only authorized locations; wildcard sees all (Task 5.7)', async () => {
    const scoped = await getStock(scopedReaderHeaders);
    assert.strictEqual(scoped.res.status, 200, JSON.stringify(scoped.res.body));
    const scopedBody = scoped.res.body as unknown as StockResponse;
    assert.strictEqual(scopedBody.locations.length, 1, 'a site-scoped reader must see only their location');
    assert.strictEqual(scopedBody.locations[0]!.location_id, locAId);
    assert.deepStrictEqual(
      scopedBody.consolidated,
      { on_hand: 100, allocated: 10, available: 90, in_transit: 0 },
      'the consolidated total must sum only authorized locations',
    );

    const wildcard = await getStock(readerHeaders);
    assert.strictEqual((wildcard.res.body as unknown as StockResponse).locations.length, 3);
  });

  it('edge uploads cannot bypass central enforcement: an insufficient allocation via /api/v1/edge/events returns INSUFFICIENT_STOCK', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      stockEnvelope(
        'stock.allocated',
        { sku: SKU, target_location_id: locAId, quantity: 100000 },
        {
          stream_id: streamId,
          event_id: randomUUID(),
          idempotency_key: `sb-edge-${randomUUID()}`,
          device_id: 'rugged-2-2',
          actor_location_id: locAId,
        },
      ),
      edgeHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(await domainEventCount(streamId), 0);
  });

  it('regression: a legacy spine-shape stock event without master references still persists and touches no balance row', async () => {
    const beforeCount = await getPool().query(`SELECT count(*)::int AS count FROM stock_balance`);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.received', { quantity: 1 }),
      operatorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const afterCount = await getPool().query(`SELECT count(*)::int AS count FROM stock_balance`);
    assert.strictEqual(afterCount.rows[0]!['count'], beforeCount.rows[0]!['count'], 'legacy stock shapes must not create balance rows');
  });

  it('rejects a gated stock event with a non-positive quantity or a client-supplied available value', async () => {
    const zeroQuantity = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.allocated', { sku: SKU, target_location_id: locAId, quantity: 0 }),
      operatorHeaders,
    );
    assert.strictEqual(zeroQuantity.status, 400, JSON.stringify(zeroQuantity.body));
    assert.strictEqual(zeroQuantity.body['error_code'], 'INVALID_PARAMS');

    const clientAvailable = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope('stock.received', { sku: SKU, target_location_id: locAId, quantity: 1, available: 500 }),
      operatorHeaders,
    );
    assert.strictEqual(clientAvailable.status, 400, JSON.stringify(clientAvailable.body));
    assert.strictEqual(clientAvailable.body['error_code'], 'INVALID_PARAMS');
  });

  it('returns 404 ITEM_NOT_FOUND for an unknown sku and 400 for a malformed sku', async () => {
    const unknown = await makeRequest(port, 'GET', '/api/v1/stock/NO-SUCH-SKU', undefined, readerHeaders);
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'ITEM_NOT_FOUND');

    const malformed = await makeRequest(port, 'GET', '/api/v1/stock/.bad', undefined, readerHeaders);
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed.body));
    assert.strictEqual(malformed.body['error_code'], 'INVALID_PARAMS');
  });
});
