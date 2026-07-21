import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.3: lot, batch, and serial traceability. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, SCIM provisioning, and PostgreSQL. Tests in this suite
// build on each other's committed data and run serially (npm test uses --test-concurrency=1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const SKU = 'EQ-0500';
const SKU_LOT = 'RM-0042';
const SKU_FIFO = 'RM-FIFO-DIFF';

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
        role: 'stock_admin_2_3',
        location_id: extra.actor_location_id ?? '00000000-0000-0000-0000-000000000000',
      },
      occurred_at: new Date().toISOString(),
      ...(extra.device_id ? { device_id: extra.device_id } : {}),
    },
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  };
}

describe('Story 2.3 Lot, Batch, and Serial Traceability Integration Tests', () => {
  let server: Server;
  let port: number;
  let operatorHeaders: Record<string, string>;
  let qualityHeaders: Record<string, string>;
  let locAId: string;

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

    // Provision test users
    await provisionUser(port, 'lot-operator@example.com', [
      { role: 'lot_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    operatorHeaders = await authFor(port, 'lot-operator@example.com');

    // quality_officer is on the expired-lot override allowlist (exact-match, Story 2.3
    // re-review) AND needs inventory:write to reach POST /api/v1/events at all, so this actor
    // carries both assignments - matching how a real quality officer with override authority
    // would be provisioned.
    await provisionUser(port, 'quality-officer@example.com', [
      { role: 'quality_officer', module: 'quality', functionScope: 'write', locationId: '*' },
      { role: 'quality_officer', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    qualityHeaders = await authFor(port, 'quality-officer@example.com');

    // Seed item masters
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', true, true, 'fifo', 'production', 'active') RETURNING item_id`,
      [SKU],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'KG', true, false, 'fifo', 'production', 'active') RETURNING item_id`,
      [SKU_LOT],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'KG', true, false, 'fifo', 'production', 'active') RETURNING item_id`,
      [SKU_FIFO],
    );

    // Seed locations
    const locAResult = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, 'LOC-A', 'zone', $2, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), randomUUID()],
    );
    locAId = locAResult.rows[0]!['location_id'] as string;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closePool();
    await closeAdminPool();
  });

  it('AC1: FEFO selection picks the lot with the earliest expiry date', async () => {
    const lot1Number = 'LOT-2026-001';
    const lot2Number = 'LOT-2026-002';

    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 100,
      lot_id: lot1Number,
      expiry_date: '2026-09-30',
    }, { actor_location_id: locAId }));

    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 100,
      lot_id: lot2Number,
      expiry_date: '2026-12-31',
    }, { actor_location_id: locAId }));

    const selectRes = await makeRequest(port, 'POST', '/api/v1/stock/RM-0042/select-lot', {
      location_id: locAId,
      quantity: 10,
      fifo_mode: 'fefo',
    }, operatorHeaders);

    assert.strictEqual(selectRes.status, 200);
    assert.strictEqual(selectRes.body['lot_number'], lot1Number);

    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      fefo_mode: 'fefo',
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(issueRes.status, 201);
    assert.strictEqual((issueRes.body['payload'] as Record<string, unknown>)['lot_id'], lot1Number);
  });

  // AC2: Expired lot rejection
  it('AC2: Reject issue of expired lot without override', async () => {
    // Create an expired lot
    const expiredLotNumber = 'LOT-EXPIRED-001';
    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 50,
      lot_id: expiredLotNumber,
      expiry_date: '2020-01-01',
    }, { actor_location_id: locAId }));

    // Attempt issue without override - should fail
    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: expiredLotNumber,
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(issueRes.status, 400);
    assert.strictEqual(issueRes.body['error_code'], 'LOT_EXPIRED');
    assert.ok(issueRes.body['details'] && (issueRes.body['details'] as Record<string, unknown>)['expiryDate']);

    // A role without override authority (lot_operator is not on the exact-match allowlist) must
    // be rejected even with override_expired_lot: true - proves the allowlist check actually
    // gates, not just that the flag exists (Story 2.3 re-review: exact-match, not substring).
    const deniedOverrideRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: expiredLotNumber,
      override_expired_lot: true,
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(deniedOverrideRes.status, 403);
    assert.strictEqual(deniedOverrideRes.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // Retry through the HTTP layer (not a direct persistEvent bypass) with an actor whose
    // authenticated, RBAC-resolved role IS on the allowlist - proves the override actually
    // succeeds end-to-end, not just that a bypassed call doesn't throw.
    const overrideRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: expiredLotNumber,
      override_expired_lot: true,
    }, { actor_location_id: locAId }), qualityHeaders);
    assert.strictEqual(overrideRes.status, 201);
    assert.strictEqual((overrideRes.body['payload'] as Record<string, unknown>)['lot_id'], expiredLotNumber);
  });

  // AC3: Quality hold rejection
  it('AC3: Reject issue of lot on quality hold', async () => {
    // Create a lot and place it on quality hold
    const heldLotNumber = 'LOT-HELD-001';
    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 50,
      lot_id: heldLotNumber,
      expiry_date: '2026-12-31',
    }, { actor_location_id: locAId }));

    // Place quality hold
    const holdRes = await makeRequest(port, 'PUT', `/api/v1/lots/${heldLotNumber}/quality-hold`, {
      hold_reason: 'Quality inspection failed',
    }, qualityHeaders);

    assert.strictEqual(holdRes.status, 200);
    assert.strictEqual(holdRes.body['quality_hold_status'], 'held');

    // Attempt issue - should fail
    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: heldLotNumber,
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(issueRes.status, 400);
    assert.strictEqual(issueRes.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual((issueRes.body['details'] as Record<string, unknown>)['reason'], 'Quality inspection failed');

    // AC3 also covers allocation, not just issue - a held lot must reject stock.allocated too.
    const allocateRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.allocated', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: heldLotNumber,
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(allocateRes.status, 400);
    assert.strictEqual(allocateRes.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual((allocateRes.body['details'] as Record<string, unknown>)['reason'], 'Quality inspection failed');

    // Clear hold
    const clearRes = await makeRequest(port, 'DELETE', `/api/v1/lots/${heldLotNumber}/quality-hold`, {}, qualityHeaders);
    assert.strictEqual(clearRes.status, 200);
    assert.strictEqual(clearRes.body['quality_hold_status'] as string, 'none');

    const retryRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: heldLotNumber,
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(retryRes.status, 201);
  });

  it('AC4: Lot trace returns all transactions and current balances within 500ms', async () => {
    await persistEvent(stockEnvelope('stock.allocated', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 5,
      lot_id: 'LOT-2026-001',
    }, { actor_location_id: locAId }));

    // AC4's threshold is a p95, not "the one time I measured it" - take enough samples that a
    // single slow outlier (GC pause, connection setup) can't flip the assertion either way.
    const SAMPLE_COUNT = 20;
    const durationsMs: number[] = [];
    let traceRes!: HttpResult;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const startedAt = performance.now();
      traceRes = await makeRequest(port, 'GET', '/api/v1/lots/LOT-2026-001/trace', {}, operatorHeaders);
      durationsMs.push(performance.now() - startedAt);
      assert.strictEqual(traceRes.status, 200);
    }
    durationsMs.sort((a, b) => a - b);
    const p95DurationMs = durationsMs[Math.floor(SAMPLE_COUNT * 0.95) - 1]!;
    assert.ok(p95DurationMs < 500, `p95 lot-trace latency ${p95DurationMs}ms exceeds the 500ms AC4 threshold`);

    const trace = traceRes.body['trace'] as Array<Record<string, unknown>>;
    const balances = traceRes.body['balances_by_location'] as Array<Record<string, unknown>>;

    assert.strictEqual(traceRes.body['lot_number'], 'LOT-2026-001');
    assert.ok(trace.some((entry) => entry['event_type'] === 'stock.received' && entry['location_id'] === locAId));
    assert.ok(trace.some((entry) => entry['event_type'] === 'stock.issued' && entry['location_id'] === locAId));
    assert.ok(trace.some((entry) => entry['event_type'] === 'stock.allocated' && entry['location_id'] === locAId));
    assert.ok(balances.some((balance) => balance['location_id'] === locAId && balance['on_hand'] === 90 && balance['allocated'] === 5));
  });

  // AC5: Serial required for serial-controlled item
  it('AC5: Reject issue of serial-controlled item without serial numbers', async () => {
    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 1,
    }), operatorHeaders);

    assert.strictEqual(issueRes.status, 400);
    assert.strictEqual(issueRes.body['error_code'], 'SERIAL_REQUIRED');
  });

  // AC6: Duplicate serial rejection
  it('AC6: Reject duplicate serial number receipt', async () => {
    const serialNumber = 'SN-1001';
    
    // First receipt should succeed
    const firstReceipt = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 1,
      serials: [{ serial_number: serialNumber, initial_quantity: 1 }],
    }), operatorHeaders);

    assert.strictEqual(firstReceipt.status, 201);

    // Second receipt with same serial should fail
    const dupReceipt = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 1,
      serials: [{ serial_number: serialNumber, initial_quantity: 1 }],
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(dupReceipt.status, 400);
    assert.strictEqual(dupReceipt.body['error_code'], 'DUPLICATE_SERIAL');
    // AC6 requires the location currently holding the serial to be returned, not just the
    // rejection code.
    assert.strictEqual((dupReceipt.body['details'] as Record<string, unknown>)['currentLocationId'], locAId);
  });

  it('FIFO selection picks oldest received lot', async () => {
    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_FIFO,
      target_location_id: locAId,
      quantity: 20,
      lot_id: 'LOT-FIFO-OLD-LATE-EXPIRY',
      expiry_date: '2026-12-31',
    }, { actor_location_id: locAId }));
    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_FIFO,
      target_location_id: locAId,
      quantity: 20,
      lot_id: 'LOT-FIFO-NEW-EARLY-EXPIRY',
      expiry_date: '2026-08-31',
    }, { actor_location_id: locAId }));

    const fefoRes = await makeRequest(port, 'POST', `/api/v1/stock/${SKU_FIFO}/select-lot`, {
      location_id: locAId,
      quantity: 10,
      fifo_mode: 'fefo',
    }, operatorHeaders);
    const fifoRes = await makeRequest(port, 'POST', `/api/v1/stock/${SKU_FIFO}/select-lot`, {
      location_id: locAId,
      quantity: 10,
      fifo_mode: 'fifo',
    }, operatorHeaders);

    assert.strictEqual(fefoRes.status, 200);
    assert.strictEqual(fifoRes.status, 200);
    assert.strictEqual(fefoRes.body['lot_number'], 'LOT-FIFO-NEW-EARLY-EXPIRY');
    assert.strictEqual(fifoRes.body['lot_number'], 'LOT-FIFO-OLD-LATE-EXPIRY');
  });

  // Batch serial receipt
  it('Batch serial receipt applies all serials to projection', async () => {
    const serials = [
      { serial_number: `SN-BATCH-${Date.now()}-1`, initial_quantity: 1 },
      { serial_number: `SN-BATCH-${Date.now()}-2`, initial_quantity: 1 },
      { serial_number: `SN-BATCH-${Date.now()}-3`, initial_quantity: 1 },
    ];

    const receiptRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 3,
      serials,
    }, { actor_location_id: locAId }), operatorHeaders);

    assert.strictEqual(receiptRes.status, 201);

    const projection = await getPool().query(
      'SELECT serial_number, current_location_id, current_quantity FROM serial_master WHERE serial_number = ANY($1::text[]) ORDER BY serial_number',
      [serials.map((serial) => serial.serial_number)],
    );
    assert.strictEqual(projection.rows.length, 3);
    assert.ok(projection.rows.every((row) => row['current_location_id'] === locAId && row['current_quantity'] === '1.000000'));
  });

  it('Edge upload with lots and serials is validated centrally', async () => {
    const invalidRes = await makeRequest(port, 'POST', '/api/v1/edge/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 1,
      serials: [{ serial_number: 'SN-1001', initial_quantity: 1 }],
    }, {
      event_id: randomUUID(),
      idempotency_key: `edge-${Date.now()}`,
      device_id: 'edge-device-2-3',
      actor_location_id: locAId,
    }), operatorHeaders);

    assert.strictEqual(invalidRes.status, 400);
    assert.strictEqual(invalidRes.body['error_code'], 'DUPLICATE_SERIAL');
  });

  // Idempotent retry
  it('Idempotent retry of lot receipt returns DUPLICATE_EVENT', async () => {
    const idempotencyKey = `test-${Date.now()}`;
    const event = stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 25,
      lot_id: 'LOT-IDEMPOTENT-001',
      expiry_date: '2026-12-31',
    }, { idempotency_key: idempotencyKey, actor_location_id: locAId });

    const firstRes = await makeRequest(port, 'POST', '/api/v1/events', event, operatorHeaders);
    assert.strictEqual(firstRes.status, 201);

    const retryRes = await makeRequest(port, 'POST', '/api/v1/events', event, operatorHeaders);
    assert.strictEqual(retryRes.status, 409);
    assert.strictEqual(retryRes.body['error_code'], 'DUPLICATE_EVENT');

    // Prove the rejected retry did not re-apply the lot/stock-balance projections - exactly one
    // lot row and exactly one receipt's worth of on_hand, not two (Story 2.3 re-review).
    const lotRows = await getPool().query('SELECT lot_id FROM lot_master WHERE lot_number = $1', ['LOT-IDEMPOTENT-001']);
    assert.strictEqual(lotRows.rows.length, 1);
    const balanceRows = await getPool().query(
      'SELECT on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3',
      [SKU_LOT, locAId, 'LOT-IDEMPOTENT-001'],
    );
    assert.strictEqual(balanceRows.rows.length, 1);
    assert.strictEqual(Number(balanceRows.rows[0]!['on_hand']), 25);
  });

  it('Successful serial-controlled issue validates and applies serial state', async () => {
    const serialNumbers = [`SN-ISSUE-${Date.now()}-1`, `SN-ISSUE-${Date.now()}-2`];
    const receiptRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 2,
      serials: serialNumbers.map((serial_number) => ({ serial_number, initial_quantity: 1 })),
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(receiptRes.status, 201);

    // Sum of serial current_quantity (2 x 1) must equal the issue's payload.quantity.
    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 2,
      serials: serialNumbers.map((serial_number) => ({ serial_number })),
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(issueRes.status, 201);

    const projection = await getPool().query(
      'SELECT current_location_id, current_quantity FROM serial_master WHERE serial_number = ANY($1::text[])',
      [serialNumbers],
    );
    assert.strictEqual(projection.rows.length, 2);
    assert.ok(projection.rows.every((row) => row['current_location_id'] === null && Number(row['current_quantity']) === 0));

    // A mismatched quantity (1 serial worth issued but 2 claimed) must be rejected, not silently
    // applied with stock_balance and serial_master diverging (Story 2.3 re-review).
    const mismatchSerials = [`SN-ISSUE-${Date.now()}-3`];
    await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 1,
      serials: mismatchSerials.map((serial_number) => ({ serial_number, initial_quantity: 1 })),
    }, { actor_location_id: locAId }), operatorHeaders);
    const mismatchRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU,
      target_location_id: locAId,
      quantity: 2,
      serials: mismatchSerials.map((serial_number) => ({ serial_number })),
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(mismatchRes.status, 400);
    assert.strictEqual(mismatchRes.body['error_code'], 'INVALID_PARAMS');
  });

  it('pass-3: lot-controlled item moved without a resolvable lot is rejected LOT_REQUIRED', async () => {
    // SKU_LOT (RM-0042) is lot_controlled and NOT serial_controlled. A real stock movement (one that
    // carries a target location) supplying no lot_id, no serials, and no FEFO/FIFO mode has no
    // traceability anchor, so lot-controlled stock could otherwise enter or leave inventory with no
    // lot_master row and no lot_trace entry - invisible to an AC4 recall. Both the receive and issue
    // paths must reject it (Story 2.3 pass-3 decision).
    const receiveRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 5,
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(receiveRes.status, 400);
    assert.strictEqual(receiveRes.body['error_code'], 'LOT_REQUIRED');

    const issueRes = await makeRequest(port, 'POST', '/api/v1/events', stockEnvelope('stock.issued', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 1,
    }, { actor_location_id: locAId }), operatorHeaders);
    assert.strictEqual(issueRes.status, 400);
    assert.strictEqual(issueRes.body['error_code'], 'LOT_REQUIRED');
  });

  it('pass-3: a quality-hold event is visible in the recall trace to a wildcard reader', async () => {
    const tracedLot = 'LOT-HOLD-TRACE-001';
    await persistEvent(stockEnvelope('stock.received', {
      sku: SKU_LOT,
      target_location_id: locAId,
      quantity: 10,
      lot_id: tracedLot,
      expiry_date: '2026-12-31',
    }, { actor_location_id: locAId }));

    const holdRes = await makeRequest(port, 'PUT', `/api/v1/lots/${tracedLot}/quality-hold`, {
      hold_reason: 'Recall trace visibility check',
    }, qualityHeaders);
    assert.strictEqual(holdRes.status, 200);

    const traceRes = await makeRequest(port, 'GET', `/api/v1/lots/${tracedLot}/trace`, {}, operatorHeaders);
    assert.strictEqual(traceRes.status, 200);
    const trace = traceRes.body['trace'] as Array<Record<string, unknown>>;
    // The hold was placed by a wildcard-scoped quality officer, so its trace row carries a null
    // location. It must still appear in the recall trace for a wildcard-scoped reader; filtering
    // null-location rows before the wildcard check silently dropped quarantine history (pass-3 P1).
    assert.ok(
      trace.some((entry) => entry['event_type'] === 'lot.quality_hold_placed'),
      'quality-hold event must appear in the recall trace',
    );
  });
});